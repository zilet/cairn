// The art pipeline's hardening seams: the per-kind image-model override, the
// pro-model style references, upstream error diagnosis, and the circuit breaker
// gating real calls. Offline — global fetch is stubbed, so no network runs.
//
// Env is set BEFORE importing dist/art.js because the model constants resolve at
// module load, which is also what the server does.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.GEMINI_API_KEY = "test-key-not-a-real-credential";
process.env.GEMINI_EXERCISE_IMAGE_MODEL = "gemini-3-pro-image";
process.env.ART_IMAGE_COST_USD = "0.067";
process.env.ART_EXERCISE_IMAGE_COST_USD = "0.134";

const EXERCISE_MODEL = "gemini-3-pro-image";

let art;
let circuit;
let ledger;
const realFetch = globalThis.fetch;

/** Every stubbed call, as { url, body } — the assertion surface for request shape. */
let calls = [];
let responder = () => okImage();

// A minimal but real PNG header, so the mime sniffer accepts a cached file as a
// style reference exactly as it would a Gemini-produced one.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

function okImage() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_BYTES.toString("base64") } }] } }],
    }),
    text: async () => "",
  };
}

function errorResponse(status, body) {
  return { ok: false, status, json: async () => JSON.parse(body), text: async () => body };
}

const GEMINI_400 = JSON.stringify({
  error: { code: 400, status: "INVALID_ARGUMENT", message: "Unsupported responseModalities for this model." },
});

before(async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return responder();
  };
  art = await import("../dist/art.js");
  circuit = await import("../dist/artCircuit.js");
  ledger = await import("../dist/repo/art-ledger.js");
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  responder = () => okImage();
  // The breaker's close listener is what clears art.ts's per-key `failed` map,
  // and ONLY an open→closed transition fires it — per MODEL, so both models the
  // pipeline can use have to be cycled. Drive a real open, then succeed, so each
  // test starts with both breakers and the failed map clean — no module reload.
  circuit.resetArtCircuit();
  for (const model of [EXERCISE_MODEL, art.GEMINI_IMAGE_MODEL]) {
    for (let i = 0; i < circuit.OPEN_AFTER_CONSECUTIVE_FAILURES; i++) circuit.noteArtFailure(model, "reset");
    circuit.noteArtSuccess(model);
  }
  circuit.resetArtCircuit();
  const artDir = path.join(process.env.DATA_DIR, "art");
  if (fs.existsSync(artDir)) fs.rmSync(artDir, { recursive: true, force: true });
});

/** Let the fire-and-forget drain() loop run to completion. */
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

test("exercise art uses the per-kind model override; other kinds keep the default", async () => {
  assert.equal(art.imageModelFor("exercise"), "gemini-3-pro-image");
  assert.equal(art.imageModelFor("food"), art.GEMINI_IMAGE_MODEL);
  assert.equal(art.imageModelFor("activity"), art.GEMINI_IMAGE_MODEL);

  assert.equal(await art.warmExerciseArt("barbell bench press"), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("gemini-3-pro-image"), `called ${calls[0].url}`);
});

test("the pro model carries up to 3 cached exercise images as inline style references", async () => {
  // First generation: nothing cached yet, so it goes out as text only.
  await art.warmExerciseArt("barbell bench press");
  const first = calls[0].body.contents[0].parts;
  assert.equal(first.length, 1, "no references exist yet");
  assert.ok(first[0].text.includes("bench press"));

  for (const name of ["goblet squat", "seated row", "overhead press"]) await art.warmExerciseArt(name);

  calls = [];
  await art.warmExerciseArt("romanian deadlift");
  const parts = calls[0].body.contents[0].parts;
  const inline = parts.filter((p) => p.inlineData);
  assert.equal(inline.length, 3, "capped at three references");
  for (const p of inline) {
    // Confirmed request shape for models.generateContent: inlineData.mimeType +
    // base64 data (https://ai.google.dev/api/generate-content).
    assert.equal(p.inlineData.mimeType, "image/png");
    assert.equal(Buffer.from(p.inlineData.data, "base64").subarray(0, 4).toString("hex"), "89504e47");
  }
  assert.ok(parts[0].text.includes("romanian deadlift"), "the subject prompt still leads");
  assert.ok(
    parts.some((p) => typeof p.text === "string" && /same series/i.test(p.text)),
    "the references are introduced as style guidance"
  );
});

test("a non-OK response yields a groupable error code carrying the API status", () => {
  assert.equal(art.geminiErrorCode(400, GEMINI_400), "400:INVALID_ARGUMENT");
  assert.equal(art.geminiErrorCode(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } })), "429:RESOURCE_EXHAUSTED");
  // A non-JSON body (proxy/HTML error) still groups stably rather than collapsing
  // every distinct fault into one bucket.
  const html = art.geminiErrorCode(502, "<html>Bad Gateway</html>");
  assert.match(html, /^502:[0-9a-f]{8}$/);
  assert.equal(html, art.geminiErrorCode(502, "<html>Bad Gateway</html>"), "same body, same code");
  assert.notEqual(html, art.geminiErrorCode(502, "<html>Service Unavailable</html>"));
  assert.equal(art.geminiErrorCode(500, ""), "500:no_body");
});

test("consecutive upstream failures open the circuit and stop the calls", async () => {
  responder = () => errorResponse(400, GEMINI_400);
  const names = ["fail a", "fail b", "fail c", "fail d", "fail e"];
  for (const name of names) assert.equal(await art.warmExerciseArt(name), false);
  assert.equal(calls.length, 5, "each attempt was really made");
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), true, "five consecutive failures opened the circuit");

  calls = [];
  assert.equal(await art.warmExerciseArt("fail f"), false);
  assert.equal(calls.length, 0, "an open circuit spends nothing");
  assert.equal(art.requestArt("exercise", "fail g"), false, "the serve path refuses to queue too");

  // The health line reads from the ledger + the breaker, no schema of its own.
  const health = ledger.getArtHealth();
  assert.equal(health.circuit.open, true);
  assert.equal(health.last_error_code, "400:INVALID_ARGUMENT");
  assert.ok(health.failures_7d >= 5);
  assert.equal(health.last_success_at, null, "nothing has rendered in this window");
});

test("a RESTART during an outage does not re-attempt the backlog", async () => {
  // The real-world shape: art is failing, someone deploys, warmArt() fires 5s
  // after boot and re-queues every cache miss. Before the breaker was durable
  // this cost 500-650 calls in a day. The process cache is dropped but the
  // app_state row is not — exactly what a redeploy does.
  responder = () => errorResponse(400, GEMINI_400);
  const backlog = ["boot a", "boot b", "boot c", "boot d", "boot e"];
  for (const name of backlog) await art.warmExerciseArt(name);
  assert.equal(calls.length, 5);
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), true);

  circuit.forgetArtCircuitCache(); // ← the restart

  calls = [];
  // warmArt() enqueues the whole PWA backlog; every one of them must be refused.
  for (const name of [...backlog, "boot f", "boot g"]) {
    assert.equal(art.requestArt("exercise", name), false);
    assert.equal(await art.warmExerciseArt(name), false);
  }
  assert.equal(calls.length, 0, "a restart mid-outage spends nothing");
  assert.equal(
    circuit.artCircuitState(EXERCISE_MODEL).consecutive_failures,
    5,
    "the failure count survived the restart"
  );
});

test("closing the circuit lets a previously-failed item retry without a restart", async () => {
  responder = () => errorResponse(400, GEMINI_400);
  for (const name of ["retry a", "retry b", "retry c", "retry d", "retry e"]) await art.warmExerciseArt(name);
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), true);

  calls = [];
  assert.equal(await art.warmExerciseArt("retry a"), false, "still refused while open");
  assert.equal(calls.length, 0);

  // Upstream recovers: closing clears that model's failed keys, so the ones
  // burned during the outage get another chance in this same process.
  responder = () => okImage();
  circuit.noteArtSuccess(EXERCISE_MODEL);
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), false);

  calls = [];
  assert.equal(await art.warmExerciseArt("retry a"), true, "the previously-failed key retried");
  assert.equal(calls.length, 1);
  assert.ok(ledger.getArtHealth().last_success_at, "the ledger now shows a successful render");
});

// ---- the per-model breaker: one bad model must not take the pipeline with it ----

test("interleaved failures on the exercise model still open ITS circuit, not the flash one", async () => {
  // With one global counter, the flash successes between the pro failures reset
  // the count every other call and the pro circuit never opened at all.
  for (let i = 0; i < circuit.OPEN_AFTER_CONSECUTIVE_FAILURES; i++) {
    responder = () => errorResponse(400, GEMINI_400);
    await art.warmExerciseArt(`interleaved ${i}`);
    responder = () => okImage();
    circuit.noteArtSuccess(art.GEMINI_IMAGE_MODEL); // a food/activity image landed
  }
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), true, "every exercise call failed — it must be paused");
  assert.equal(circuit.artCircuitOpen(art.GEMINI_IMAGE_MODEL), false, "the working model is untouched");
});

test("an open exercise circuit does not abandon the food and activity backlog", async () => {
  responder = () => errorResponse(400, GEMINI_400);
  for (const name of ["down a", "down b", "down c", "down d", "down e"]) await art.warmExerciseArt(name);
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), true);

  responder = () => okImage();
  calls = [];
  assert.equal(art.requestArt("exercise", "still parked"), false, "exercise art is refused while its model is down");
  assert.equal(art.requestArt("food", "oatmeal with blueberries"), true, "food art queues on the healthy model");
  await settle();

  assert.ok(calls.length >= 1, "the food job really drained");
  assert.ok(
    calls.some((c) => c.url.includes(art.GEMINI_IMAGE_MODEL)),
    `the flash image model was called: ${calls.map((c) => c.url).join(", ")}`
  );
  assert.ok(
    !calls.some((c) => c.url.includes(EXERCISE_MODEL)),
    "and nothing went to the paused model"
  );
});

// ---- per-model spend estimate ----

test("a mixed-model setup prices exercise images at the override model's rate", () => {
  assert.equal(art.imageCostFor("exercise"), 0.134);
  assert.equal(art.imageCostFor("food"), 0.067);
  assert.equal(art.imageCostFor("activity"), 0.067);
});

// ---- the seed pack stays reproducible ----

test("pregenerate() forces the base model and never attaches style references", async () => {
  // Cache a few exercise figurines first: the serve path WOULD send these as
  // references, which is exactly what the seed builder must not inherit.
  for (const name of ["goblet squat", "seated row", "overhead press"]) await art.warmExerciseArt(name);

  calls = [];
  await art.pregenerate("exercise", "romanian deadlift");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes(art.GEMINI_IMAGE_MODEL), `called ${calls[0].url}`);
  assert.ok(!calls[0].url.includes(EXERCISE_MODEL), "the local per-kind override must not leak into the pack");
  const parts = calls[0].body.contents[0].parts;
  assert.equal(parts.length, 1, "text only — a seeded figurine must not depend on what happened to be cached");
});

test("pregenerate() respects an open circuit instead of hammering a dead upstream", async () => {
  for (let i = 0; i < circuit.OPEN_AFTER_CONSECUTIVE_FAILURES; i++) {
    circuit.noteArtFailure(art.GEMINI_IMAGE_MODEL, "400:INVALID_ARGUMENT");
  }
  calls = [];
  await assert.rejects(() => art.pregenerate("food", "seeded oatmeal"), /paused/);
  assert.equal(calls.length, 0, "a builder loop spends nothing while the circuit is open");
});
