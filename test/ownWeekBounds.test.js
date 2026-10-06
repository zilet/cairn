// ownWeekBounds.test.js — the review gaps on the 2026-10-06 "one story" change, pinned.
//
//   1. The lift-open easy line ("the run is in, the lift is what's left — keep it light")
//      and the recovery menu stepping aside for it fire ONLY on an ADVISORY easy read
//      (the stacked ceiling, an unseconded tap). An easy read that is protective — an
//      injury, a deciding brake, anything clinical — keeps its own words and its menu.
//   2. The observed widening of "the athlete's own week" is bounded: a rhythm read
//      entirely off the log never carries a stack past the hard ceiling; a cross-training
//      outing past his own habit breaks the rhythm; a hard ride the day before the long run
//      keeps corroborating; and the read says which shape carried the stack.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay } from "./_seed.js";
import { DAY_READ_WHY_VARIANTS } from "../dist/repo/day-read.js";
import { statedRhythmRead, OBSERVED_DAYS_MAX_IN_STREAK } from "../dist/repo/stated-rhythm.js";
import { crossTrainingDoseOn, crossTrainingDays } from "../dist/repo/cross-training-day.js";
import { attachDayReadContext } from "../dist/domain/brain/day-read-use-case.js";
import { WORLD, REF, ROLE, ago, addActivity, layOwnWeek, seedPlan } from "./_ownWeekFixture.js";

beforeEach(() => resetTables(...WORLD));

const liftOpenSentence = (why) => (DAY_READ_WHY_VARIANTS.lift_open_after_activity ?? []).find((v) => why.includes(v));
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// A fresh athlete — no streak — with today a stated lifting weekday, this morning's run
// in and the lift (Push) still open. Each case adds the one input that makes the day easy.
function freshRunMorning() {
  seedPlan();
  repo.setProfile({
    primary_discipline: "hybrid",
    strength_schedule: { days: [{ dow: dowOf(REF) }], source: "athlete", updated_at: REF },
  });
  addActivity(REF, "run", 38, 6.1);
}

const SUBDUED = {
  has_data: true,
  recovery: { training_readiness: 25, avg_training_readiness: 55 },
  quality: { training_readiness: { latest_date: REF, source: "garmin", freshness: "fresh", sample_count: 1 } },
};

// ---------- 1. the lift-open easy line is for ADVISORY easy reads only ----------

test("an advisory easy read (the stacked ceiling off the athlete's week) offers the lift, held light", () => {
  layOwnWeek({ rideWeeks: 1 });
  const r = repo.dayRead(REF);
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.deepEqual(r.signals.lift_open_easy, { offered: true });
  assert.ok(liftOpenSentence(r.why), r.why);
  const brief = attachDayReadContext(REF, { ...r });
  assert.equal(brief.recovery, undefined, "the menu steps aside for the lift the read offered");
});

test("an unseconded check-in tap is advisory too: the lift is offered light", () => {
  freshRunMorning();
  repo.addCheckin(REF, { energy: 2, sleep_feel: 3 });
  const r = repo.dayRead(REF);
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
  assert.deepEqual(r.signals.lift_open_easy, { offered: true }, JSON.stringify(r.signals.lift_open_easy));
  assert.ok(liftOpenSentence(r.why), r.why);
  assert.equal(attachDayReadContext(REF, { ...r }).recovery, undefined);
});

test("a deciding brake's easy day (a subdued morning reading) never nudges the lift and keeps its menu", () => {
  freshRunMorning();
  const r = repo.dayRead(REF, SUBDUED);
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.lift_open_easy?.offered, false);
  assert.equal(r.signals.lift_open_easy?.withheld, "deciding_brake");
  assert.equal(liftOpenSentence(r.why), undefined, r.why);
  const brief = attachDayReadContext(REF, { ...r });
  assert.ok(brief.recovery, "the protective easy day keeps its recovery menu");
  assert.equal(brief.strength_line?.run_in != null, true, "the line still names the run in");
});

test("an injury's easy day is clinical: no lift nudge, the menu stays", () => {
  freshRunMorning();
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", detail: "Pressing aggravates it", start_date: REF });
  const r = repo.dayRead(REF, SUBDUED);
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.lift_open_easy?.withheld, "clinical");
  assert.equal(liftOpenSentence(r.why), undefined, r.why);
  assert.ok(attachDayReadContext(REF, { ...r }).recovery);
});

test("an illness keeps the quiet day's own offer whatever kind it reads", () => {
  freshRunMorning();
  repo.addContextEvent({ kind: "illness", title: "Head cold", start_date: REF });
  const r = repo.dayRead(REF);
  assert.notEqual(r.kind, "train", r.why);
  assert.notEqual(r.signals.lift_open_easy?.offered, true);
  assert.equal(liftOpenSentence(r.why), undefined, r.why);
  assert.ok(attachDayReadContext(REF, { ...r }).recovery, "the menu stays");
});

test("a cached read from before the gate carries no flag and keeps its menu (the safe side)", () => {
  layOwnWeek({ rideWeeks: 1 });
  const r = repo.dayRead(REF);
  const legacy = { ...r, signals: { ...r.signals } };
  delete legacy.signals.lift_open_easy;
  assert.ok(attachDayReadContext(REF, legacy).recovery);
});

// ---------- 2. the observed widening is bounded ----------

test("a stated week that leans on one observed ride day says so: source observed, past the ceiling", () => {
  layOwnWeek();
  const r = repo.dayRead(REF);
  assert.equal(r.kind, "train", r.why);
  assert.deepEqual(r.signals.stacked_on_rhythm, {
    source: "observed",
    stated_week: true,
    observed_days: [ago(3)],
    own_dose_exempt: true,
    past_ceiling: true,
  });
  assert.equal(OBSERVED_DAYS_MAX_IN_STREAK, 1);
});

test("a rhythm read entirely off the log names the stack but never carries it past the hard ceiling", () => {
  // No stated week at all: four steady weeks of lifting six days a week (the same six
  // weekdays, today's among them) make those weekdays OBSERVED lifting days, and the five
  // days before today are a clean stack — at the ceiling, at an even weekly load.
  seedPlan();
  repo.setProfile({ primary_discipline: "strength" });
  for (let week = 0; week < 4; week++) {
    for (const n of [1, 2, 3, 4, 5]) seedTrainingDay(ago(n + week * 7));
    if (week > 0) seedTrainingDay(ago(week * 7));
  }
  const consec = repo.dayRead(REF).signals.consecutive_training_days;
  assert.equal(consec, 5, "a stack at the ceiling");
  const rhythm = statedRhythmRead(REF, consec);
  assert.equal(rhythm?.source, "observed");
  assert.equal(rhythm?.stated_week, false);
  assert.equal(rhythm?.streak_on_rhythm, true, "the log's own week is still a week");
  const r = repo.dayRead(REF);
  assert.equal(r.signals.stacked_on_rhythm?.past_ceiling, false, JSON.stringify(r.signals.stacked_on_rhythm));
  assert.equal(r.kind, "easy", "a guessed week does not move the safety bound");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");

  // The same stack on a STATED week of the same days carries past it.
  repo.setProfile({
    strength_schedule: { days: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow })), source: "athlete", updated_at: REF },
  });
  const stated = repo.dayRead(REF);
  assert.equal(stated.signals.stacked_on_rhythm?.past_ceiling, true);
  assert.equal(stated.kind, "train", stated.why);
});

test("a ride past his own habit (half again as long as usual) breaks the rhythm", () => {
  layOwnWeek({ rideMin: 300 });
  const ride = crossTrainingDays(REF)[0];
  assert.equal(ride?.source, "observed", "the precondition: Saturday is still his observed ride day");
  const dose = crossTrainingDoseOn(ago(3), ride);
  assert.equal(dose?.within_habit, false);
  assert.equal(dose?.beyond, "longer");
  assert.equal(dose?.typical_min, 142);
  const r = repo.dayRead(REF);
  assert.equal(r.signals.stacked_on_rhythm, undefined, "never carried");
  assert.equal(r.signals.stacked_off_rhythm?.cross_training_beyond?.date, ago(3));
  assert.equal(r.signals.stacked_off_rhythm?.cross_training_beyond?.beyond, "longer");
  assert.equal(r.kind, "easy", "off the week, the ceiling eases exactly as before");

  // At the habit's own length the same week carries.
  resetTables(...WORLD);
  layOwnWeek({ rideMin: 150 });
  assert.equal(crossTrainingDoseOn(ago(3), crossTrainingDays(REF)[0])?.within_habit, true);
  assert.equal(repo.dayRead(REF).kind, "train");
});

test("a ride heavier than his usual band breaks the rhythm too", () => {
  // His habit is an hour's moderate spin; this Saturday's ran into the heavy band (not
  // half again as long — heavier, not longer).
  layOwnWeek({ rideMin: 80 });
  db.prepare(`UPDATE activities SET duration_min = 60, distance_km = 15 WHERE type = 'ride' AND date = ?`).run(ago(10));
  const ride = crossTrainingDays(REF)[0];
  const dose = crossTrainingDoseOn(ago(3), ride);
  assert.ok(dose, "the outing is read");
  assert.notEqual(dose.load, dose.typical_load, JSON.stringify(dose));
  assert.equal(dose.beyond, "heavier", JSON.stringify(dose));
  assert.equal(statedRhythmRead(REF, 7)?.streak_on_rhythm, false);
});

test("a hard-graded ride the day before the long run still corroborates the stack", () => {
  // Today is the long-run Sunday; yesterday's Saturday ride graded hard (TE 4.5), as his
  // Saturday rides do. At maintenance the weekend dose is on the board as a caution.
  layOwnWeek({ role: ROLE.sun, goal: "maintain", rideTe: 4.5, runToday: false });
  const consec = repo.dayRead(REF).signals.consecutive_training_days;
  assert.ok(consec >= 3, `a stack (got ${consec})`);
  const rhythm = statedRhythmRead(REF, consec);
  assert.equal(rhythm?.streak_on_rhythm, true, "the habitual hard ride is still his week");
  assert.equal(rhythm?.hard_ride_before_long_run, true);
  const r = repo.dayRead(REF);
  const hybrid = r.signals.signal_state.dimensions.training_load_tolerance.evidence.find(
    (e) => e.field === "hybrid_interference"
  );
  assert.ok(hybrid, "the precondition: the ride's dose is on the board as a caution");
  assert.equal(r.signals.stacked_on_rhythm?.own_dose_exempt, false);
  assert.equal(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "accumulated_load_rest");

  // The same Saturday ridden easy (no hard grade): the week's own dose, exempt as before.
  resetTables(...WORLD);
  layOwnWeek({ role: ROLE.sun, goal: "maintain", rideTe: null, runToday: false });
  const easy = repo.dayRead(REF);
  assert.equal(statedRhythmRead(REF, easy.signals.consecutive_training_days)?.hard_ride_before_long_run, false);
  assert.notEqual(easy.signals.stacked_on_rhythm?.own_dose_exempt, false);
  assert.notEqual(easy.decision.rule_code, "accumulated_load_rest", `${easy.kind}: ${easy.why}`);
});
