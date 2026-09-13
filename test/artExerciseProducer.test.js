// Exercise-art producer: pose-aware keys, strict reuse, versioned serve, SW eviction.
// Offline — global fetch is stubbed. Env is set BEFORE importing dist/art.js.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { artCacheIdentity, shouldEvictCachedArt } from "../dist/artCachePolicy.js";
import { repo } from "./_seed.js";

process.env.GEMINI_API_KEY = "test-key-not-a-real-credential";
process.env.GEMINI_EXERCISE_IMAGE_MODEL = "gemini-3-pro-image";

let art;
let circuit;
const realFetch = globalThis.fetch;
let calls = [];
let responder = () => okImage();

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

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

function textMatch() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '{"match":0,"canonical":"standing cloaked figure"}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
    }),
    text: async () => "",
  };
}

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("generativelanguage.googleapis.com")) return realFetch(url, init);
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return responder();
  };
  art = await import("../dist/art.js");
  circuit = await import("../dist/artCircuit.js");
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
});

beforeEach(() => {
  calls = [];
  responder = () => okImage();
  circuit.resetArtCircuit();
  for (const model of ["gemini-3-pro-image", art.GEMINI_IMAGE_MODEL]) {
    for (let i = 0; i < circuit.OPEN_AFTER_CONSECUTIVE_FAILURES; i++) circuit.noteArtFailure(model, "reset");
    circuit.noteArtSuccess(model);
  }
  circuit.resetArtCircuit();
  art.resetArtRegenGate();
  const artDir = path.join(process.env.DATA_DIR, "art");
  if (fs.existsSync(artDir)) fs.rmSync(artDir, { recursive: true, force: true });
});

async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

function imagePrompt() {
  const image = calls.find((c) => c.body?.generationConfig?.responseModalities);
  return image?.body?.contents?.[0]?.parts?.[0]?.text ?? "";
}

test("requestArt('exercise') on a miss never sends a name-only prompt", async () => {
  calls = [];
  assert.equal(art.requestArt("exercise", "Farmer's Carry"), true);
  await settle();
  const prompt = imagePrompt();
  assert.ok(prompt, "the image endpoint was called");
  assert.doesNotMatch(prompt, /performing Farmer's Carry, terracotta/, "not the bare-name prompt");
  assert.match(prompt, /forearms exercise/, "classifier context is in the prompt");
});

test("the producer prompt carries pose and equipment", async () => {
  calls = [];
  assert.equal(
    await art.produceExerciseArt("Farmer's Carry", {
      muscle_group: "forearms",
      equipment: "a trap bar",
      pose: "Walk tall holding heavy implements at the sides",
    }),
    true
  );
  const prompt = imagePrompt();
  assert.match(prompt, /The pose: Walk tall holding heavy implements at the sides/);
  assert.match(prompt, /using a trap bar/);
  assert.match(prompt, /forearms exercise/);
});

test("same name, different pose → different asset; name lookup follows the current key", async () => {
  await art.warmExerciseArt("Farmer's Carry", { pose: "Walk tall", equipment: "a trap bar" });
  const first = art.cachedArtPath("exercise", "Farmer's Carry");
  const firstKey = art.assetKeyFromPath(first);
  assert.equal(art.artVersion("exercise", "Farmer's Carry"), 1);

  // A later generate with a richer pose would no-op (file exists). Force via regenerate.
  calls = [];
  await art.regenerateArt("exercise", "Farmer's Carry", { pose: "A shorter choppy walk", equipment: "a trap bar" });
  const second = art.cachedArtPath("exercise", "Farmer's Carry");
  assert.ok(second);
  assert.notEqual(art.assetKeyFromPath(second), firstKey);
  assert.equal(art.artVersion("exercise", "Farmer's Carry"), 2);
});

test("resolveConcept for exercise never reuses across different normalizedExerciseKeys, even when Gemini says match", async () => {
  await art.warmExerciseArt("Farmer's Carry", { pose: "Walk tall" });
  responder = () => textMatch();
  calls = [];
  const r = await art.resolveConcept({ kind: "exercise", text: "Hammer Curl" });
  assert.equal(r.reused, false);
  assert.equal(r.text, "Hammer Curl", "never canonicalize away from the athlete's name");
  assert.equal(calls.length, 0, "no Gemini text call for exercise reuse");
});

test("resolveConcept for exercise reuses when normalizedExerciseKey matches", async () => {
  await art.warmExerciseArt("Dead hang");
  const r = await art.resolveConcept({ kind: "exercise", text: "Dead hang timed" });
  assert.equal(r.reused, true);
  assert.equal(r.text, "Dead hang timed");
  assert.ok(art.cachedArtPath("exercise", "Dead hang timed"));
});

test("resolveConcept for exercise reuses when an exercise_aliases row already links the names", async () => {
  repo.setExerciseAlias("db bench", "Dumbbell Bench Press");
  await art.warmExerciseArt("Dumbbell Bench Press");
  const r = await art.resolveConcept({ kind: "exercise", text: "db bench" });
  assert.equal(r.reused, true);
});

let server = null;
async function artBase() {
  if (!server) {
    const express = (await import("express")).default;
    const { artRouter } = await import("../dist/routes/art.js");
    const app = express();
    app.use(express.json());
    app.use("/api", artRouter);
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
  }
  return `http://127.0.0.1:${server.address().port}/api`;
}

test("serve route sets ETag to the asset key and honors v= for the current bytes", async () => {
  await art.warmExerciseArt("Goblet Squat", { equipment: "a kettlebell" });
  const file = art.cachedArtPath("exercise", "Goblet Squat");
  const key = art.assetKeyFromPath(file);
  const base = await artBase();
  const res = await realFetch(`${base}/art?kind=exercise&q=${encodeURIComponent("Goblet Squat")}&v=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("etag"), `"${key}"`);
  assert.match(res.headers.get("cache-control") || "", /immutable/);
});

test("art cache eviction helper drops older v for the same kind+q", () => {
  const incoming = "http://x/api/art?kind=exercise&q=Farmer%27s%20Carry&v=3";
  assert.equal(shouldEvictCachedArt("http://x/api/art?kind=exercise&q=Farmer%27s%20Carry&v=1", incoming), true);
  assert.equal(shouldEvictCachedArt("http://x/api/art?kind=exercise&q=Farmer%27s%20Carry", incoming), true);
  assert.equal(shouldEvictCachedArt("http://x/api/art?kind=exercise&q=Farmer%27s%20Carry&v=3", incoming), false);
  assert.equal(shouldEvictCachedArt("http://x/api/art?kind=exercise&q=Hammer%20Curl&v=1", incoming), false);
  assert.equal(shouldEvictCachedArt("http://x/api/art?kind=food&q=oats&v=1", incoming), false);
  assert.deepEqual(artCacheIdentity(incoming), { kind: "exercise", q: "Farmer's Carry", v: 3 });
});
