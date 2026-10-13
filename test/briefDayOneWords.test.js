// The Brief's floor words on a fresh install's first planned day (a real-provider walk
// of the welcome found both):
//   - the headline printed the composer's raw one-word focus, "upper.", as the whole
//     headline — every focus form now opens with a sentence-cased phrase and closes as a
//     sentence, never the bare focus;
//   - with NOTHING on record it said "Recovery looks fine…" and then "a thin week for
//     signals" — absent data is never "fine", so the clear day with nothing to read says
//     the session is due and that there is nothing to read yet, once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import {
  DAY_READ_REQUIRED_CONCEPT,
  DAY_READ_WHY_VARIANTS,
  THIN_SIGNAL_COVERAGE_WHY,
  TRAIN_CLEAR_WHY,
  TRAIN_UNREAD_WHY,
  dayReadHeadline,
  focusHeadlinePhrase,
} from "../dist/repo/day-read.js";
import { DAY_READ_FOCUS_HEADLINE_VARIANTS } from "../dist/repo/day-read-prose.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

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

test("the unread clear-day set is registered, holds the grammar, and never asserts recovery", () => {
  assert.equal(DAY_READ_WHY_VARIANTS.planned_training_unread, TRAIN_UNREAD_WHY);
  const concept = DAY_READ_REQUIRED_CONCEPT.planned_training_unread;
  assert.ok(concept, "declares its required idea");
  assert.ok(TRAIN_UNREAD_WHY.length >= 3);
  for (const text of TRAIN_UNREAD_WHY) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.match(text, concept, text);
    assert.doesNotMatch(text, /\b(?:looks fine|you're recovered|reads clear|recovered)\b/i, text);
  }
});

test("a first planned day with nothing on record says there is nothing to read yet — once", () => {
  const today = localDateISO();
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  const read = repo.dayRead(today);
  assert.equal(read.kind, "train", `got ${read.kind} (${read.decision?.rule_code})`);
  assert.ok(
    TRAIN_UNREAD_WHY.some((text) => read.why.startsWith(text)),
    `the unread set, got ${JSON.stringify(read.why)}`
  );
  for (const clear of TRAIN_CLEAR_WHY) assert.ok(!read.why.includes(clear), "no recovery claim");
  for (const thin of THIN_SIGNAL_COVERAGE_WHY) assert.ok(!read.why.includes(thin), "no 'thin week' on top of it");
  const headline = dayReadHeadline(read, today);
  assert.match(headline, /^Upper body\b/, headline);
});

test("once something is on record the clear day speaks as before", () => {
  const today = localDateISO();
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  repo.recordDailyMetrics("apple", today, { sleep_min: 450, hrv: 62, resting_hr: 52 });
  const read = repo.dayRead(today);
  assert.ok(!TRAIN_UNREAD_WHY.some((text) => read.why.startsWith(text)), JSON.stringify(read.why));
});
