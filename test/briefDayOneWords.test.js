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
  TRAIN_QUIET_WHY,
  TRAIN_UNREAD_WHY,
  dayReadHeadline,
  focusHeadlinePhrase,
} from "../dist/repo/day-read.js";
import { DAY_READ_FOCUS_HEADLINE_VARIANTS } from "../dist/repo/day-read-prose.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { dayReadProseConsistencyIssue } from "../dist/dayread.js";
import { buildDayReadPrompt } from "../dist/prompt/day.js";
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

// An athlete back after weeks off has a long record and nothing CURRENT on it. Thin
// coverage alone used to gate the unread set, so 31 logged sessions were met with
// "there's nothing on the record yet to read". History exists; it just is not recent —
// and absent current evidence is still never "fine".
test("a returning athlete with no current signals hears there is nothing RECENT to read, never 'nothing yet'", () => {
  const today = localDateISO();
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  for (let i = 0; i < 31; i++) {
    const date = addDaysISO(today, -(40 + i * 3));
    for (let s = 0; s < 3; s++) repo.logSetByName({ date, exercise: "Bench Press", weight: 135, reps: 8, rir: 2 });
  }
  const read = repo.dayRead(today);
  assert.equal(read.kind, "train", `got ${read.kind} (${read.decision?.rule_code})`);
  for (const unread of TRAIN_UNREAD_WHY) assert.ok(!read.why.includes(unread), `not 'nothing yet': ${read.why}`);
  for (const clear of TRAIN_CLEAR_WHY) assert.ok(!read.why.includes(clear), `no recovery claim: ${read.why}`);
  assert.doesNotMatch(read.why, /\b(?:looks fine|you're recovered|reads clear)\b/i, read.why);
  assert.ok(
    TRAIN_QUIET_WHY.some((text) => read.why.startsWith(text)),
    `the nothing-recent set, got ${JSON.stringify(read.why)}`
  );
  for (const thin of THIN_SIGNAL_COVERAGE_WHY) assert.ok(!read.why.includes(thin), "said once, not twice");
  assert.equal(read.signals.recovery_unread, "nothing_recent");
});

test("a first planned day flags that there is nothing on record for the agent too", () => {
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  assert.equal(repo.dayRead(localDateISO()).signals.recovery_unread, "nothing_on_record");
});

test("an old wearable sync is a record too: nothing recent, not nothing yet", () => {
  const today = localDateISO();
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  repo.recordDailyMetrics("apple", addDaysISO(today, -30), { sleep_min: 450, hrv: 62, resting_hr: 52 });
  const read = repo.dayRead(today);
  assert.equal(read.signals.recovery_unread, "nothing_recent");
  assert.ok(TRAIN_QUIET_WHY.some((text) => read.why.startsWith(text)), JSON.stringify(read.why));
});

test("the Brief prompt tells the agent there is nothing to read recovery from", () => {
  repo.savePlanDay(1, "Upper", "upper", [{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 10 }]);
  const date = localDateISO();
  const baseline = repo.dayRead(date);
  assert.match(buildDayReadPrompt(undefined, { date, baseline }), /NOTHING ON RECORD:/);
  const recent = { ...baseline, signals: { ...baseline.signals, recovery_unread: "nothing_recent" } };
  assert.match(buildDayReadPrompt(undefined, { date, baseline: recent }), /NOTHING RECENT:/);
  const read = { ...baseline, signals: { ...baseline.signals, recovery_unread: undefined } };
  assert.doesNotMatch(buildDayReadPrompt(undefined, { date, baseline: read }), /NOTHING (?:ON RECORD|RECENT):/);
});

test("the nothing-recent set is registered, holds the grammar, and never asserts recovery", () => {
  assert.equal(DAY_READ_WHY_VARIANTS.planned_training_quiet, TRAIN_QUIET_WHY);
  const concept = DAY_READ_REQUIRED_CONCEPT.planned_training_quiet;
  assert.ok(concept, "declares its required idea");
  assert.ok(TRAIN_QUIET_WHY.length >= 3);
  for (const text of TRAIN_QUIET_WHY) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.match(text, concept, text);
    assert.doesNotMatch(text, /\b(?:looks fine|you're recovered|reads clear|recovered|yet)\b/i, text);
  }
});

test("an agent sentence claiming recovery on a day with nothing to read it from is refused", () => {
  for (const flag of ["nothing_on_record", "nothing_recent"]) {
    const signals = { recovery_unread: flag };
    for (const why of [
      "Recovery looks fine and the session is due.",
      "You're recovered and due — good to go.",
      "Everything reads clear, so go get it.",
      "You're well recovered, so today's a good day for it.",
    ]) {
      assert.equal(
        dayReadProseConsistencyIssue({ kind: "train", headline: "Upper body today.", why }, signals)?.code,
        "recovery_claimed_unread",
        why
      );
    }
    const honest = "The session's due, and there's nothing recent to read — go by how you feel.";
    assert.equal(
      dayReadProseConsistencyIssue({ kind: "train", headline: "Upper body today.", why: honest }, signals),
      null
    );
  }
  // A day with evidence behind it may say so.
  assert.equal(
    dayReadProseConsistencyIssue({ kind: "train", headline: "Upper body today.", why: "Recovery looks fine." }, {}),
    null
  );
});
