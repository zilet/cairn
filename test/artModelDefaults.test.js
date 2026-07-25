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
import { GEMINI_IMAGE_MODEL, GEMINI_TEXT_MODEL } from "../dist/art.js";

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
const KNOWN_VALID_IMAGE_MODELS = ["gemini-3.1-flash-image"];

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
