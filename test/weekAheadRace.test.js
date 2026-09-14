// The week-ahead card's quiet race line (Today, "The week ahead"): context, never
// a countdown. weekAheadRaceLine is pure over getEnduranceGoal's own return shape
// plus an asOf date, so most of this is covered with no DB; the last two tests
// wire a real profile through weekAheadServe to prove the field actually rides
// the route-level response.
//
// weeks_to_race here is a CALENDAR week count (mondayOf(race) vs mondayOf(asOf)),
// matching the Plan ladder (src/repo/race-build.ts's projectRaceBuildWeeks) rather
// than getEnduranceGoal's own ceil(days/7) — the two surfaces must never disagree
// about whether it's race week. Fixture dates below are chosen so a plain
// ceil(days/7) and the calendar-week count land on the same number wherever a
// test isn't specifically about calendar-week correctness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekAheadRaceLine } from "../dist/repo/day-read-prose.js";
import { setProfile } from "../dist/repo/profile.js";
import { weekAheadServe } from "../dist/coachOps/training.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { mondayOf } from "../dist/lib/dates.js";

function raceGoal(overrides = {}) {
  return {
    mode: "race",
    is_race: true,
    event: "Half marathon",
    date: "2026-10-26",
    distance_km: 21.1,
    target: null,
    weekly_km: null,
    weekly_sessions: null,
    days_to_race: 42,
    phase: "build",
    ...overrides,
  };
}

// 2026-09-14 is a Monday; 2026-10-26 (asOf + 42 days) is also a Monday, so the
// calendar-week count and ceil(days/7) agree at exactly 6.
const MONDAY_ASOF = "2026-09-14";

test("weekAheadRaceLine: a race 6 weeks out reads weeks-out + phase, no exclamation or score", () => {
  const line = weekAheadRaceLine(raceGoal(), MONDAY_ASOF);
  assert.ok(line, "a race line is produced");
  assert.equal(line.label, "Half marathon");
  assert.equal(line.weeks_to_race, 6);
  assert.equal(line.days_to_race, 42);
  assert.equal(line.phase, "build", "the machine field stays the raw phase key");
  assert.equal(line.date, "2026-10-26");
  assert.equal(line.text, "Half marathon · 6 weeks out · building", "spoken phase word, not the raw key");
  assert.ok(!line.text.includes("!"), "no exclamation — context, not pressure");
  assert.ok(!/\bmust\b/i.test(line.text), "no gate language");
  assert.ok(!/\d{1,3}\s*\/\s*100/.test(line.text), "no score");
});

test("weekAheadRaceLine: every phase key maps to its spoken word, never the raw key", () => {
  const expected = { base: "base", build: "building", sharpen: "sharpening", taper: "tapering" };
  // MONDAY_ASOF + 56 days (2026-11-09) is also a Monday: 8 calendar weeks out.
  for (const [phase, word] of Object.entries(expected)) {
    const line = weekAheadRaceLine(raceGoal({ phase, date: "2026-11-09", days_to_race: 56 }), MONDAY_ASOF);
    assert.equal(line.text, `Half marathon · 8 weeks out · ${word}`, `phase ${phase} reads "${word}"`);
  }
});

test("weekAheadRaceLine: a race on Saturday, read on the Tuesday of the SAME calendar week, is race week", () => {
  // asOf Tue 2026-09-15, race Sat 2026-09-19 — both fall in the week of Monday
  // 2026-09-14, so this is race week even though 2026-09-19 is only 4 days out
  // (ceil(4/7) would also say "1 week", the wrong label for a ladder).
  const line = weekAheadRaceLine(raceGoal({ date: "2026-09-19", days_to_race: 4, phase: "taper" }), "2026-09-15");
  assert.ok(line);
  assert.equal(line.weeks_to_race, 0);
  assert.equal(line.text, "Half marathon · race week");
});

test("weekAheadRaceLine: a race next Monday, read on a Tuesday, is '1 week out' — not race week", () => {
  // asOf Tue 2026-09-15 (week of Mon 2026-09-14); race Mon 2026-09-21 (the
  // FOLLOWING calendar week) — one calendar week away, and the singular branch
  // is genuinely reachable here (not just a defensive guard).
  const line = weekAheadRaceLine(raceGoal({ date: "2026-09-21", days_to_race: 6, phase: "taper" }), "2026-09-15");
  assert.ok(line);
  assert.equal(line.weeks_to_race, 1);
  assert.equal(line.text, "Half marathon · 1 week out · tapering");
  assert.ok(!/1 weeks/.test(line.text), "singular, not '1 weeks'");
});

test("weekAheadRaceLine: null for a standing (non-race) goal", () => {
  const line = weekAheadRaceLine(
    {
      mode: "standing",
      is_race: false,
      label: "10k-ready",
      distance_km: 10,
      target: null,
      weekly_km: null,
      weekly_sessions: null,
    },
    MONDAY_ASOF
  );
  assert.equal(line, null);
});

test("weekAheadRaceLine: null for a race whose date has already passed", () => {
  const line = weekAheadRaceLine(raceGoal({ date: "2026-01-01", days_to_race: -30, phase: "past" }), MONDAY_ASOF);
  assert.equal(line, null);
});

test("weekAheadRaceLine: null with no goal at all", () => {
  assert.equal(weekAheadRaceLine(null, MONDAY_ASOF), null);
});

test("weekAheadServe: the deterministic floor response carries the race line for a dated race goal", () => {
  const today = localDateISO();
  const raceDate = addDaysISO(today, 42);
  setProfile({
    endurance_goal: { mode: "race", event: "Half marathon", date: raceDate },
  });
  const { response } = weekAheadServe(today);
  assert.equal(response.ok, true);
  assert.equal(response.source, "deterministic");
  assert.ok(response.race, "race line present even with an empty plan (no plan_days seeded)");
  assert.equal(response.race.label, "Half marathon");
  const expectedWeeks = Math.round(
    (Date.parse(`${mondayOf(raceDate)}T00:00:00Z`) - Date.parse(`${mondayOf(today)}T00:00:00Z`)) / (7 * 864e5)
  );
  assert.equal(response.race.weeks_to_race, expectedWeeks, "matches the calendar-week count off the real clock");
});

test("weekAheadServe: no endurance goal on file yields race: null", () => {
  const { response } = weekAheadServe(localDateISO());
  assert.equal(response.ok, true);
  assert.equal(response.race, null);
});
