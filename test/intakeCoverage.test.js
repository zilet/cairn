// Intake coverage — the law that keeps a quiet food log from reading as a low one.
//
//   Logged intake is evidence only when the day is plausibly complete; a partial
//   or unlogged day is ABSENT, never "low".
//
// The same shape as the sensor-freshness law it mirrors ("a stale wearable reading
// behaves as absent, never as current"), and it exists for the same reason: the
// athlete logs whole days today and will soon log almost none, so every read built
// on a day's totals has to be able to tell "ate little" from "logged little".
//
// Pinned here: the day classifier across the shapes a real log actually takes, and
// the trailing logging-mode read that says whether the plate is on the record at all.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { classifyIntakeDay } from "../dist/repo/intake-window.js";
import { approxTimeForMealLabel } from "../dist/repo/shared.js";

beforeEach(() => {
  resetTables("food_notes");
});

const entry = (meal, kcal, eaten_at = null) => ({ meal, kcal, eaten_at });

// ---- the classifier, on the shapes a log actually takes ----------------------

test("breakfast, lunch and dinner is the complete day the athlete describes", () => {
  const shape = classifyIntakeDay([entry("breakfast", 600), entry("lunch", 700), entry("dinner", 900)]);
  assert.equal(shape.coverage, "complete");
  assert.equal(shape.entries, 3);
  assert.equal(shape.kcal, 2_200);
  assert.ok(shape.morning && shape.evening, "the day reaches from the morning into the evening");
});

test("a stated time places a meal even when the label cannot", () => {
  const shape = classifyIntakeDay([entry("meal", 500, "07:45"), entry("meal", 900, "19:15")]);
  assert.equal(shape.coverage, "complete");
  assert.equal(shape.placed, 2);
  assert.equal(shape.unplaceable, 0);
});

test("a day whose dinner never arrived is PARTIAL, not a low day", () => {
  const shape = classifyIntakeDay([entry("breakfast", 600), entry("lunch", 700)]);
  assert.equal(shape.coverage, "partial");
  assert.equal(shape.evening, false);
  assert.match(shape.reason, /absent evidence rather than a low intake/);
});

test("one mid-day entry and one evening-only entry are both partial", () => {
  assert.equal(classifyIntakeDay([entry("lunch", 800)]).coverage, "partial");
  assert.equal(classifyIntakeDay([entry("dinner", 900)]).coverage, "partial");
  assert.equal(classifyIntakeDay([entry("meal", 800, "13:00")]).coverage, "partial");
});

test("a single morning entry is partial however early it is", () => {
  assert.equal(classifyIntakeDay([entry("breakfast", 700)]).coverage, "partial");
});

test("nothing logged is NONE — unknown, never zero", () => {
  const shape = classifyIntakeDay([]);
  assert.equal(shape.coverage, "none");
  assert.equal(shape.kcal, 0);
  assert.match(shape.reason, /unknown rather than low/);
});

test("entries carrying no calories cannot make a day complete", () => {
  // An unenriched note has no kcal yet, so it backs no intake number.
  const shape = classifyIntakeDay([entry("breakfast", null), entry("dinner", null)]);
  assert.equal(shape.coverage, "none");
  assert.equal(shape.entries, 0);
});

test("snacks and drinks alone never read as a day's eating, whatever hours they span", () => {
  const shape = classifyIntakeDay([entry("snack", 250, "08:00"), entry("drink", 200, "20:00")]);
  assert.equal(shape.coverage, "partial");
  assert.equal(shape.snack_only, true);
});

test("a whole day declared in one untimed entry still counts", () => {
  // "About 2200 today" — placement is genuinely unknown, and the total is a day's
  // food rather than a meal's, so it is admitted.
  assert.equal(classifyIntakeDay([entry("meal", 2_200)]).coverage, "complete");
  assert.equal(classifyIntakeDay([entry("meal", 1_500)]).coverage, "complete", "the bar is inclusive");
  assert.equal(classifyIntakeDay([entry("meal", 1_400)]).coverage, "partial", "a meal's worth is not a day's");
});

test("the volume fallback never rescues a day we can SEE stopped before the evening", () => {
  // Two big placed meals reaching 1800 kcal by lunchtime plus one untimed sip. The
  // missing evening is information, not ambiguity — and the single unplaceable entry
  // must not hand the day the fallback, which exists only for a day whose placement
  // is genuinely unknown. (The bar it would have cleared is measured against the
  // untimed calories alone; here that is 20.)
  const shape = classifyIntakeDay([entry("breakfast", 900), entry("lunch", 900), entry("drink", 20)]);
  assert.equal(shape.coverage, "partial");
  assert.equal(shape.placed, 2, "the two named meals place themselves");
  assert.equal(shape.unplaceable, 1);
  assert.match(shape.reason, /absent evidence rather than a low intake/);
});

test("one untimed entry beside a placed one never unlocks the whole-day fallback", () => {
  // A big logged breakfast and a snack nobody timed. The day's total clears 1500,
  // but 1600 of it is PLACED before noon — that is a day we can see stopped early,
  // not a day declared in one go.
  const shape = classifyIntakeDay([entry("breakfast", 1_600), entry("snack", 50)]);
  assert.equal(shape.coverage, "partial");
  assert.equal(shape.evening, false);
});

// ---- the spanning arm owes a day's calories too ------------------------------

test("a day that spans morning to evening on 800 kcal is partial, not a low day", () => {
  // Breakfast and a late snack reach across the whole day between them and come to
  // less than one meal. Read as complete, that is a fabricated 800 kcal day and the
  // fabricated deficit that follows it.
  const shape = classifyIntakeDay([entry("breakfast", 600, "08:00"), entry("snack", 200, "23:00")]);
  assert.equal(shape.coverage, "partial");
  assert.ok(shape.morning && shape.evening, "it genuinely spans the day — that is not enough on its own");
  assert.match(shape.reason, /reach across the day but come to 800 kcal/);
});

test("an ordinary breakfast/lunch/dinner day clears the spanning floor", () => {
  assert.equal(
    classifyIntakeDay([entry("breakfast", 500), entry("lunch", 600), entry("dinner", 600)]).coverage,
    "complete"
  );
});

// ---- the labels a person actually uses ---------------------------------------

test("brunch and supper place a day just as breakfast and dinner do", () => {
  // Both were in the vocabulary this classifier replaced. Falling to unplaceable sent
  // a perfectly well-described day to the pile of days nobody logged.
  const shape = classifyIntakeDay([entry("brunch", 700), entry("supper", 700)]);
  assert.equal(shape.coverage, "complete");
  assert.equal(shape.placed, 2);
  assert.ok(shape.morning && shape.evening);
});

test("a label nobody uses stays unplaceable — no hour is invented for it", () => {
  const shape = classifyIntakeDay([entry("elevenses", 800), entry("nightcap", 800)]);
  assert.equal(shape.placed, 0);
  assert.equal(shape.unplaceable, 2);
  assert.equal(shape.coverage, "complete", "1600 untimed kcal is still a day declared in one go");
});

// ---- the same rule, through the date-keyed read ------------------------------

function logDay(daysAgo, entries) {
  for (const e of entries) {
    repo.addFoodNote(e.meal, "", { kcal: e.kcal, protein_g: e.protein_g ?? 40 }, undefined, {
      date: localDaysAgo(daysAgo),
      ...(e.eaten_at ? { eaten_at: e.eaten_at } : {}),
    });
  }
}

test("dayIntakeCoverage reads a real logged day the same way", () => {
  logDay(1, [entry("breakfast", 600), entry("dinner", 900)]);
  const read = repo.dayIntakeCoverage(localDaysAgo(1));
  assert.equal(read.date, localDaysAgo(1));
  assert.equal(read.coverage, "complete");
  assert.equal(read.kcal, 1_500);

  logDay(2, [entry("breakfast", 600)]);
  assert.equal(repo.dayIntakeCoverage(localDaysAgo(2)).coverage, "partial");
  assert.equal(repo.dayIntakeCoverage(localDaysAgo(3)).coverage, "none");
});

test("dayIntakeCoverage answers for TODAY, which the closed-day window cannot", () => {
  logDay(0, [entry("breakfast", 600, "07:30"), entry("dinner", 900, "19:30")]);
  assert.equal(repo.dayIntakeCoverage().coverage, "complete");
});

// ---- the logging habit -------------------------------------------------------

test("a fortnight of complete days reads as FULL logging", () => {
  for (let i = 1; i <= 14; i++) logDay(i, [entry("breakfast", 600), entry("dinner", 900)]);
  assert.equal(repo.intakeLoggingMode(14), "full");
});

test("logged breakfasts alone are never a logged fortnight", () => {
  for (let i = 1; i <= 14; i++) logDay(i, [entry("breakfast", 600)]);
  assert.equal(repo.intakeLoggingMode(14), "quiet", "no day in the window is complete");
});

test("a couple of complete days in a fortnight reads as OCCASIONAL", () => {
  for (const i of [2, 9]) logDay(i, [entry("breakfast", 600), entry("dinner", 900)]);
  assert.equal(repo.intakeLoggingMode(14), "occasional");
});

test("an empty fortnight is QUIET, and quiet is a fact about the log, not the athlete", () => {
  assert.equal(repo.intakeLoggingMode(14), "quiet");
});

test("the density bar sits between occasional and full", () => {
  // Nine complete days of fourteen clears 60%; four does not.
  for (let i = 1; i <= 9; i++) logDay(i, [entry("breakfast", 600), entry("dinner", 900)]);
  assert.equal(repo.intakeLoggingMode(14), "full");
  resetTables("food_notes");
  for (let i = 1; i <= 4; i++) logDay(i, [entry("breakfast", 600), entry("dinner", 900)]);
  assert.equal(repo.intakeLoggingMode(14), "occasional");
});

test("today is never counted toward the logging habit — the day is still being lived", () => {
  logDay(0, [entry("breakfast", 600), entry("dinner", 900)]);
  assert.equal(repo.intakeLoggingMode(14), "quiet", "a closed-day read cannot borrow today");
});

test("an inherited object key is not a meal label", () => {
  // The label is athlete-supplied text, so the recognized-label lookup must answer
  // "constructor" with nothing rather than with an inherited member.
  assert.equal(approxTimeForMealLabel("constructor"), null);
  assert.equal(approxTimeForMealLabel("toString"), null);
  assert.equal(approxTimeForMealLabel("brunch"), "11:00");
});
