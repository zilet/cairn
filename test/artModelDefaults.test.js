// Regression guard for src/art.ts's Gemini model defaults. GEMINI_TEXT_MODEL
// once defaulted to "gemini-3.1-flash" — an id that does not exist — which
// silently killed the semantic-cache canonicalize call (resolveConcept)
// for anyone who hadn't set the env var: every canonicalize call failed,
// the failure was swallowed, and each reworded phrase paid for a fresh
// image generation forever. This pins both defaults to known-valid,
// non-empty model id strings so a typo or a stale id can't ship silently
// again. Offline — asserts on the resolved constants, no network call.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageCostForModel, imageCostFor, IMAGE_COST_USD_BY_MODEL, GEMINI_IMAGE_MODEL, GEMINI_TEXT_MODEL, GEMINI_EXERCISE_IMAGE_MODEL, STYLE_REFERENCE_MODELS, exerciseStyleRefsEnabled } from "../dist/art.js";

// Google's current stable Flash-tier ids (verified against the live model
// list at the time this test was written). Only extend this list after
// verifying a new id is real — it exists to catch typos/stale ids, not to
// be a speculative wishlist.
const KNOWN_VALID_TEXT_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];
// gemini-3-pro-image ("Nano Banana Pro") verified 2026-08-23 against Google's own
// https://ai.google.dev/gemini-api/docs/models (generative-media section) and
// https://ai.google.dev/gemini-api/docs/pricing ($0.134 per 1K/2K image). It is
// the recommended GEMINI_EXERCISE_IMAGE_MODEL, so it belongs in the allowlist.
// gemini-nano-banana-2.1 ("Nano Banana 2.1") checked 2026-10-07 against
// https://ai.google.dev/gemini-api/docs/pricing ($0.0336 per 1K standard-tier image;
// up to 14 reference images). It is the default since then.
const KNOWN_VALID_IMAGE_MODELS = [
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
];

test("GEMINI_TEXT_MODEL default is a non-empty, currently-valid Flash-tier id", () => {
  assert.equal(typeof GEMINI_TEXT_MODEL, "string");
  assert.ok(GEMINI_TEXT_MODEL.length > 0, "must not be empty");
  assert.ok(
    KNOWN_VALID_TEXT_MODELS.includes(GEMINI_TEXT_MODEL),
    `GEMINI_TEXT_MODEL default "${GEMINI_TEXT_MODEL}" is not a known-valid Gemini Flash-tier id`,
  );
});

test("GEMINI_TEXT_MODEL default agrees with enrich.ts's food-photo fallback", () => {
  // enrich.ts's GEMINI_FOOD_PHOTO_MODEL now falls back to THIS constant by
  // import, so the two Gemini text call sites cannot drift apart. This still
  // pins the resolved id so a stale/typo'd default can't ship silently.
  assert.equal(GEMINI_TEXT_MODEL, "gemini-3.6-flash");
});

test("GEMINI_IMAGE_MODEL default is a non-empty, currently-valid image-generation id", () => {
  assert.equal(typeof GEMINI_IMAGE_MODEL, "string");
  assert.ok(GEMINI_IMAGE_MODEL.length > 0, "must not be empty");
  assert.ok(
    KNOWN_VALID_IMAGE_MODELS.includes(GEMINI_IMAGE_MODEL),
    `GEMINI_IMAGE_MODEL default "${GEMINI_IMAGE_MODEL}" is not a known-valid Gemini image id`,
  );
});

test("the image model default is Nano Banana 2.1, priced from the table", () => {
  assert.equal(GEMINI_IMAGE_MODEL, "gemini-nano-banana-2.1");
  assert.equal(IMAGE_COST_USD_BY_MODEL["gemini-nano-banana-2.1"], 0.0336);
  assert.equal(imageCostFor("exercise"), 0.0336, "exercise art bills at the default's price with no override");
});

test("only the pro model takes style references; the default copies their pose", () => {
  // Nano Banana 2.1 accepts reference images but drew a front squat back-racked
  // beside a back-squat anchor (live, 2026-10-07), so the default runs without them.
  assert.equal(STYLE_REFERENCE_MODELS.has("gemini-nano-banana-2.1"), false);
  assert.ok(STYLE_REFERENCE_MODELS.has("gemini-3-pro-image"));
  assert.equal(STYLE_REFERENCE_MODELS.has("gemini-3.1-flash-image"), false);
  assert.equal(exerciseStyleRefsEnabled(), false);
});

test("the exercise-model override is unset by default", () => {
  // Opting in is a deployment decision: unset means exercise art bills, renders
  // and fails exactly like every other kind.
  assert.equal(GEMINI_EXERCISE_IMAGE_MODEL, "");
});

test(".env.example never recommends a model id that isn't on the verified list", () => {
  // The F1 bug class, one level up: the code default was pinned by the tests
  // above, but .env.example was free to recommend an id nobody had checked
  // against Google's model list. A recommendation in the file a user copies IS
  // a default, so it answers to the same allowlist.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const recommended = [...env.matchAll(/^#\s*GEMINI\w*_IMAGE_MODEL=(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(recommended.length, "the art model overrides are still documented");
  for (const id of recommended) {
    assert.ok(
      KNOWN_VALID_IMAGE_MODELS.includes(id),
      `.env.example recommends "${id}", which is not a verified Gemini image model id`,
    );
  }
});

test("per-image cost follows the model, unknown ids fall back to the flash rate", () => {
  assert.equal(imageCostForModel("gemini-3.1-flash-lite-image"), 0.0336);
  assert.equal(imageCostForModel("gemini-3-pro-image"), 0.134);
  assert.equal(imageCostForModel("gemini-3.1-flash-image"), 0.067);
  assert.equal(imageCostForModel("some-future-model"), 0.067);
  assert.equal(imageCostFor("food"), IMAGE_COST_USD_BY_MODEL[GEMINI_IMAGE_MODEL] ?? 0.067);
});

test("the base model's cost override never prices the exercise override model", async () => {
  // The constants resolve at import, so read them in a fresh process with its own
  // throwaway data dir (never the worker's DB).
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-art-cost-"));
  try {
    const dist = new URL("../dist/art.js", import.meta.url).href;
    const run = (env) =>
      spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `const a = await import(${JSON.stringify(dist)}); console.log(JSON.stringify([a.imageCostFor("exercise"), a.imageCostFor("food")]));`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATA_DIR: dir,
            DB_PATH: path.join(dir, "cairn.db"),
            ART_IMAGE_COST_USD: "",
            ART_EXERCISE_IMAGE_COST_USD: "",
            GEMINI_IMAGE_MODEL: "gemini-3.1-flash-lite-image",
            GEMINI_EXERCISE_IMAGE_MODEL: "gemini-3-pro-image",
            ...env,
          },
        }
      );
    const parse = (out) => {
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout.trim().split("\n").at(-1));
    };
    assert.deepEqual(parse(run({})), [0.134, 0.0336], "each model at its own table price");
    assert.deepEqual(parse(run({ ART_IMAGE_COST_USD: "0.05" })), [0.134, 0.05], "the base override stays on the base model");
    assert.deepEqual(parse(run({ ART_EXERCISE_IMAGE_COST_USD: "0.2" })), [0.2, 0.0336]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
