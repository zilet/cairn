// Unit tests for the shared attention-label helpers (src/repo/attention-labels.ts) —
// pure, DB-free. The marker-slug extraction is what drives MARKER-LEVEL dedupe across
// the forward timeline and the next-checkup read; the sentinel guard is what keeps two
// unrelated non-marker follow-ups from silently collapsing into one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { followupLabel, markerSlugFromSignalKey } from "../dist/repo/attention-labels.js";

test("markerSlugFromSignalKey extracts a real marker slug for cadence + marker follow-ups", () => {
  assert.equal(markerSlugFromSignalKey("marker:hs-crp"), "hs-crp");
  // A follow-up that named a real marker dedupes against that marker's cadence row.
  assert.equal(markerSlugFromSignalKey("review-followup:hs-crp:recheck-hs-crp"), "hs-crp");
  assert.equal(markerSlugFromSignalKey("review-followup:apob:recheck-apob"), "apob");
});

test("markerSlugFromSignalKey returns null for the non-marker sentinel and non-marker signals", () => {
  // The "lab-follow-up" sentinel is shared by every non-marker follow-up, so it must NOT
  // be a dedupe key — null makes callers key on the full signal_key and both survive.
  assert.equal(markerSlugFromSignalKey("review-followup:lab-follow-up:repeat-sleep-study"), null);
  assert.equal(markerSlugFromSignalKey("review-followup:lab-follow-up:repeat-colonoscopy"), null);
  assert.equal(markerSlugFromSignalKey("dexa:body-composition"), null);
  assert.equal(markerSlugFromSignalKey("add:apob"), null);
  assert.equal(markerSlugFromSignalKey(""), null);
  assert.equal(markerSlugFromSignalKey(null), null);
});

test("followupLabel strips the prefix and any trailing timing parenthetical", () => {
  assert.equal(followupLabel("Health review follow-up: Recheck hs-CRP (when rested)."), "Recheck hs-CRP");
  assert.equal(followupLabel("Health review follow-up: Repeat colonoscopy."), "Repeat colonoscopy.");
  assert.equal(followupLabel(""), null);
  assert.equal(followupLabel(null), null);
});
