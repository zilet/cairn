import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { dayReadContinuity } from "../dist/repo/day-read.js";

const TODAY = "2026-09-08";
const day = (delta) => addDaysISO(TODAY, delta);

beforeEach(() => {
  resetTables("context_events", "day_reads");
});

function quiet(delta, kind = "easy") {
  return { date: day(delta), kind, rule_code: "fuel_hold", headline: "Easy day", why: "Fuel is settling.", source: "deterministic" };
}

test("quiet days inside a trip window do not count toward the quiet-day escalation", () => {
  // Three days away with nothing trained, each read easy/rest by the morning job; the
  // first morning home used to open with "this makes the fourth quiet day — if the
  // rest still feels right, take it" to an athlete who is rested. Those were the trip's
  // quiet days, not Cairn's: a trip day breaks the streak the way an unknown day does.
  const prior = [quiet(-1, "rest"), quiet(-2), quiet(-3), quiet(-4)];
  assert.equal(dayReadContinuity(TODAY, prior).quiet_streak, 4, "without a trip the streak is the calendar");

  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date) VALUES ('trip', 'Camping', '', ?, ?)`
  ).run(day(-4), day(-1));
  const back = dayReadContinuity(TODAY, prior);
  assert.equal(back.quiet_streak, 0);
  assert.equal(back.yesterday?.kind, "rest", "yesterday's read is still reported as what it was");

  // A quiet day AFTER the trip ended counts again; the trip only breaks the run.
  const later = dayReadContinuity(day(2), [quiet(1), quiet(0), ...prior].map((r) => r));
  assert.equal(later.quiet_streak, 2, "the streak is the two quiet days since coming home");
});

test("an archived trip no longer confounds the streak", () => {
  const prior = [quiet(-1), quiet(-2), quiet(-3)];
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date, archived) VALUES ('trip', 'Old', '', ?, ?, 1)`
  ).run(day(-3), day(-1));
  assert.equal(dayReadContinuity(TODAY, prior).quiet_streak, 3);
});
