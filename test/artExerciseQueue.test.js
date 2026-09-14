// Exercise art rides the SAME serial queue food and activity art use.
//
// It used to bypass it: requestArt("exercise") fired the producer directly, and
// warmArt() (which server.ts runs 5s after every boot) walks every uncached PWA
// query. On a box with a Gemini key and forty uncached movements that opened
// forty concurrent image requests, collected 429s, parked every key in the
// failure map and tripped the breaker on a pipeline that was healthy a minute
// earlier. These cases pin the bound, the truthfulness of the return value, the
// per-view backoff the enrich job now honors, and the ledger's retention.
//
// Offline — global fetch is stubbed. Env is set BEFORE importing dist/art.js,
// because the model constants resolve at module load, exactly as the server does.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, repo } from "./_seed.js";

process.env.GEMINI_API_KEY = "test-key-not-a-real-credential";
process.env.GEMINI_EXERCISE_IMAGE_MODEL = "gemini-3-pro-image";

const EXERCISE_MODEL = "gemini-3-pro-image";

let art;
let circuit;
let enrich;
let ledger;
const realFetch = globalThis.fetch;

let calls = [];
let live = 0;
let peak = 0;
let responder = async () => okImage();

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

const GEMINI_400 = JSON.stringify({
  error: { code: 400, status: "INVALID_ARGUMENT", message: "Unsupported responseModalities for this model." },
});

function okImage() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_BYTES.toString("base64") } }] } },
      ],
    }),
    text: async () => "",
  };
}

function errorResponse(status, body) {
  return { ok: false, status, json: async () => JSON.parse(body), text: async () => body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
    calls.push(String(url));
    // Measured around the whole stubbed round-trip, so overlapping requests are
    // visible as overlap rather than being flattened by a synchronous return.
    live++;
    peak = Math.max(peak, live);
    try {
      return await responder();
    } finally {
      live--;
    }
  };
  art = await import("../dist/art.js");
  circuit = await import("../dist/artCircuit.js");
  enrich = await import("../dist/enrich.js");
  ledger = await import("../dist/repo/art-ledger.js");
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  live = 0;
  peak = 0;
  responder = async () => okImage();
  // Only an open→closed transition clears art.ts's per-key failure map, and it is
  // per MODEL — drive a real open then a success on both models the pipeline can
  // use, so every case starts with clean breakers and no parked keys.
  circuit.resetArtCircuit();
  for (const model of [EXERCISE_MODEL, art.GEMINI_IMAGE_MODEL]) {
    for (let i = 0; i < circuit.OPEN_AFTER_CONSECUTIVE_FAILURES; i++) circuit.noteArtFailure(model, "reset");
    circuit.noteArtSuccess(model);
  }
  circuit.resetArtCircuit();
  art.resetArtRegenGate();
  const artDir = path.join(process.env.DATA_DIR, "art");
  if (fs.existsSync(artDir)) fs.rmSync(artDir, { recursive: true, force: true });
});

/** Wait until `done()` holds, or give up — never a bare fixed sleep. */
async function settleUntil(done, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (done()) return true;
    await sleep(5);
  }
  return done();
}

test("a burst of exercise misses never runs more than one image request at a time", async () => {
  // Deliberately unrelated names: normalizedExerciseKey must not link any two of
  // them, or the reuse path would answer without an image call.
  const names = [
    "queue alpha press",
    "queue bravo row",
    "queue charlie curl",
    "queue delta squat",
    "queue echo raise",
    "queue foxtrot fly",
    "queue golf pulldown",
    "queue hotel dip",
  ];
  // A real await inside the stub: if the jobs ran concurrently they would overlap
  // here, and `peak` would climb above one.
  responder = async () => {
    await sleep(6);
    return okImage();
  };

  for (const name of names) assert.equal(art.requestArt("exercise", name), true, `${name} queued`);

  const drained = await settleUntil(() => names.every((n) => art.cachedArtPath("exercise", n)));
  assert.equal(drained, true, "every queued figurine was produced");
  assert.equal(calls.length, names.length, "one image call per movement, none skipped");
  assert.equal(peak, 1, `the serial queue held: peak concurrent image requests was ${peak}`);
});

test("the return value reports whether a job is really pending", async () => {
  responder = async () => {
    await sleep(6);
    return okImage();
  };
  assert.equal(art.requestArt("exercise", "queue repeat press"), true, "a miss queues");
  assert.equal(art.requestArt("exercise", "queue repeat press"), true, "a repeat is still pending, not a new job");

  await settleUntil(() => art.cachedArtPath("exercise", "queue repeat press"));
  assert.equal(calls.length, 1, "the duplicate request never became a second generation");
  assert.equal(art.requestArt("exercise", "queue repeat press"), false, "a cached figurine queues nothing");
});

test("an open circuit refuses to queue at all, so warmArt's count stays honest", async () => {
  responder = async () => errorResponse(400, GEMINI_400);
  for (const name of ["circuit a", "circuit b", "circuit c", "circuit d", "circuit e"]) {
    await art.warmExerciseArt(name);
  }
  assert.equal(circuit.artCircuitOpen(EXERCISE_MODEL), true);

  calls = [];
  assert.equal(art.requestArt("exercise", "circuit f"), false, "nothing was queued, and it says so");
  await sleep(20);
  assert.equal(calls.length, 0, "an open circuit spends nothing");
});

test("exercise_art does not un-park a failed figurine on every view", async () => {
  // The /api/art miss path enqueues this job on EVERY view of a movement with no
  // image. Clearing the parked failure first meant a permanently failing figurine
  // paid for a fresh image request each time anyone looked at it.
  // The row exists first, so both attempts build the SAME pose-aware context and
  // therefore the same asset key. (A genuinely richer prompt — a guide pose that
  // landed since — moves the key and legitimately earns a fresh attempt; that is
  // the full `exercise` enrichment job's path, not this one's.)
  repo.upsertExercise({ name: "parked press", muscle_group: "chest" });
  const id = Number(repo.findExercise("parked press")?.id);
  assert.ok(Number.isFinite(id), "the exercise row exists");

  responder = async () => errorResponse(400, GEMINI_400);
  assert.equal(await art.warmExerciseArt("parked press"), false, "the first attempt really failed");
  circuit.resetArtCircuit(); // isolate the backoff under test from the breaker

  responder = async () => okImage();
  calls = [];
  await enrich.processExerciseArtJob(id);
  assert.equal(calls.length, 0, "the parked key stayed parked — no spend per view");
  assert.equal(art.cachedArtPath("exercise", "parked press"), null);
});

test("the /api/art miss path's enrich job rides the same serial queue", async () => {
  // This is the path a PERSON triggers: opening a screen of movements with no
  // figurines enqueues one `exercise_art` job each. Calling the producer directly
  // put every one of them outside the single lane — a burst of concurrent image
  // requests arriving one enrich job at a time, which is the wall the queue exists
  // to prevent.
  const names = ["enrich alpha press", "enrich bravo row", "enrich charlie curl", "enrich delta squat"];
  const ids = names.map((name) => {
    repo.upsertExercise({ name, muscle_group: "chest" });
    return Number(repo.findExercise(name)?.id);
  });
  assert.ok(
    ids.every((id) => Number.isFinite(id)),
    "every exercise row exists"
  );
  responder = async () => {
    await sleep(6);
    return okImage();
  };

  await Promise.all(ids.map((id) => enrich.processExerciseArtJob(id)));

  assert.equal(peak, 1, `the enrich jobs serialized: peak concurrent image requests was ${peak}`);
  assert.equal(calls.length, names.length, "one image call per movement, none skipped");
  // The job AWAITS its own queued work, so there is nothing left in flight once the
  // worker returns — an enrich job that reported done before its image landed would
  // fail here without any polling.
  for (const name of names) {
    assert.ok(art.cachedArtPath("exercise", name), `${name} was produced before its job returned`);
  }
});

test("an exercise_art job for a figurine already being generated adds no second request", async () => {
  repo.upsertExercise({ name: "shared press", muscle_group: "chest" });
  const id = Number(repo.findExercise("shared press")?.id);
  responder = async () => {
    await sleep(20);
    return okImage();
  };

  assert.equal(art.requestArt("exercise", "shared press"), true, "the view's miss queued the job");
  await enrich.processExerciseArtJob(id); // the enrich job for the same movement

  assert.ok(calls.length <= 1, `the duplicate never became a second generation (${calls.length} call(s))`);
  await settleUntil(() => art.cachedArtPath("exercise", "shared press"));
  assert.equal(calls.length, 1, "exactly one image was paid for");
});

test("the art spend ledger drops rows past its retention window", () => {
  db.prepare(`DELETE FROM art_usage`).run();
  db.prepare(
    `INSERT INTO art_usage (created_at, kind, query, action, est_cost_usd)
     VALUES (datetime('now', '-400 days'), 'exercise', 'ancient squat', 'generate', 0.1)`
  ).run();
  ledger.recordArtUsage({ kind: "exercise", query: "recent squat", action: "generate", est_cost_usd: 0.1 });

  ledger.pruneArtUsage(Date.now(), true);
  const rows = db.prepare(`SELECT query FROM art_usage ORDER BY id`).all();
  assert.deepEqual(
    rows.map((r) => r.query),
    ["recent squat"],
    "the row outside the window is gone and the fresh one stands"
  );
  assert.ok(ledger.ART_USAGE_RETENTION.row_cap > 0, "a hard row cap is declared alongside the window");
});
