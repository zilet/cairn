// The Brief's floor words on a fresh install's first planned day (a real-provider walk
// of the welcome): the headline printed the composer's raw one-word focus, "upper.", as
// the whole headline — every focus form now opens with a sentence-cased phrase and
// closes as a sentence, never the bare focus.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import {
  dayReadHeadline,
  focusHeadlinePhrase,
} from "../dist/repo/day-read.js";
import { DAY_READ_FOCUS_HEADLINE_VARIANTS } from "../dist/repo/day-read-prose.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO } from "../dist/repo/shared.js";

const REF = "2026-10-13";
const week = Array.from({ length: 7 }, (_, i) => addDaysISO(REF, -i));

test("a one-word focus reads as a sentence in every headline form, on every day", () => {
  const flavours = [{}, { push_bias: { backed_by: [] } }, { training_drive_push: true }];
  for (const signals of flavours) {
    for (const date of week) {
      for (const focus of ["upper", "lower.", "  push ", "Lower — Strength"]) {
        const headline = dayReadHeadline({ kind: "train", focus, signals }, date);
        assert.match(headline, /^[A-Z]/, `opens as a sentence: ${JSON.stringify(headline)}`);
        assert.match(headline, /[.!?]$/, `closes as a sentence: ${JSON.stringify(headline)}`);
        assert.doesNotMatch(headline, /\.\./, `no doubled stop: ${JSON.stringify(headline)}`);
        assert.ok(headline.split(/\s+/).length >= 2, `never the bare focus: ${JSON.stringify(headline)}`);
        assert.equal(violatesReadingGrammar(headline), null);
      }
    }
  }
});

test("the region shorthands read as the body region; any other label is kept as said", () => {
  assert.equal(focusHeadlinePhrase("upper"), "Upper body");
  assert.equal(focusHeadlinePhrase("LOWER"), "LOWER body");
  assert.equal(focusHeadlinePhrase("full."), "Full body");
  assert.equal(focusHeadlinePhrase("lower body"), "Lower body");
  assert.equal(focusHeadlinePhrase("push"), "Push");
  assert.equal(focusHeadlinePhrase("Lower — Strength"), "Lower — Strength");
  assert.equal(focusHeadlinePhrase("  "), "");
  assert.match(dayReadHeadline({ kind: "train", focus: "upper" }, REF), /^Upper body\b/);
});

test("the focus form has no bare-fragment phrasing left", () => {
  assert.ok(DAY_READ_FOCUS_HEADLINE_VARIANTS.length >= 3);
  for (const text of DAY_READ_FOCUS_HEADLINE_VARIANTS) {
    assert.notEqual(text, "Lower body.", "the bare focus is not a headline");
    assert.match(text, /^Lower body \S/);
  }
});
