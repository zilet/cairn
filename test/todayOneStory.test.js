// todayOneStory.test.js — the Today Brief and the Train/Horizon surfaces tell ONE story
// (the live morning of 2026-10-06).
//
// The athlete lifts five weekdays, runs three days (easy / quality / long) and rides the
// trails on the remaining weekend day. Seven days in a row trained, nothing sore, nothing
// low — and this morning's easy run is already in, the lift not started. Live, the Brief
// said "Take it easy · 25 min" with a walk/mobility menu and "you've stacked several
// loading days in a row", while the Train card said "Run in · Push still open" and the
// plan strip named a third day. These cases pin the three fixes:
//   1. the stack on the athlete's own week (the ride day included) is the plan, so the
//      stacked-days count is an advisory line, never a downgrade to easy;
//   2. the Brief names the run already in and the lift still open — and on an easy read
//      the generic recovery menu steps aside for the lift, held light;
//   3. the plan-week strip names the same plan day as the one strength line.
//
// The reference date is TODAY (local), and the athlete's week is laid RELATIVE to today's
// weekday, so freshness gates that read the wall clock behave exactly as in production.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay, localDaysAgo } from "./_seed.js";
import { DAY_READ_CAVEAT_VARIANTS, DAY_READ_WHY_VARIANTS, violatesReadingGrammar } from "../dist/repo/day-read.js";
import { statedRhythmRead } from "../dist/repo/stated-rhythm.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { attachDayReadContext } from "../dist/domain/brain/day-read-use-case.js";
import { planWeek } from "../dist/domain/training/plan-week.js";

const WORLD = [
  "checkins",
  "daily_metrics",
  "garmin_daily_metrics",
  "garmin_sources",
  "context_events",
  "sessions",
  "logged_sets",
  "activities",
  "plan_items",
  "plan_days",
  "profile",
  "day_reads",
  "training_symptom_events",
  "program_blocks",
  "app_state",
  "daily_session_compositions",
];
beforeEach(() => resetTables(...WORLD));

const REF = localDaysAgo(0);
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const T = dowOf(REF);
const dow = (offset) => (((T + offset) % 7) + 7) % 7;
const ago = (n) => localDaysAgo(n);

// The week, relative to today (T = "Tuesday"): lifts T-1..T+3 ("Mon–Fri"), runs on T
// (easy), T+2 (quality) and T-2 (long), and the ride on T-3 ("Saturday").
const LIFT_DOWS = [-1, 0, 1, 2, 3].map(dow);
const RUN_DAYS = [
  { dow: dow(0), kind: "easy" },
  { dow: dow(2), kind: "quality" },
  { dow: dow(-2), kind: "long" },
];

function addActivity(date, type, minutes, km) {
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, ?, ?, ?)`).run(
    date,
    type,
    minutes,
    km
  );
}

function seedPlan() {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Overhead Press", muscle_group: "shoulders" });
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Lat Pulldown", muscle_group: "back" });
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads" });
  repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings" });
  repo.savePlanDay(1, "Push", "Chest, shoulders & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
  repo.savePlanDay(2, "Pull", "Back & biceps", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(3, "Lower A", "Squat & quads", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6 }]);
  repo.savePlanDay(4, "Upper", "Chest, back & arms", [
    { exercise: "Bench Press", sets: 3, rep_low: 8, rep_high: 10 },
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10 },
  ]);
  repo.savePlanDay(5, "Lower B", "Hinge & single-leg", [
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
}

// `rideWeeks`: how many weekly rides on the ride weekday (2 makes it the observed
// cross-training day — 2 of the last 6 ISO weeks; 1 does not). `goal`: live, the athlete
// is in a cut, so the weekend's heavy endurance reads as fueling ADVICE (advisory); at
// maintenance the same weekend reads as a hybrid-interference caution instead.
function seedLiveWeek({ rideWeeks = 2, goal = "lose" } = {}) {
  repo.setProfile({
    goal_mode: goal,
    primary_discipline: "hybrid",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    strength_schedule: { days: LIFT_DOWS.map((d) => ({ dow: d })), source: "athlete", updated_at: REF },
    endurance_schedule: { days: RUN_DAYS, source: "athlete", updated_at: REF },
  });
  seedPlan();
  // Four steady weeks of the same running, so nothing reads as a mileage spike and the
  // last long run is no "longest in months".
  for (let week = 0; week < 4; week++) {
    const back = week * 7;
    addActivity(ago(7 + back), "run", 40, 6.5); // the easy run ("last Tuesday")
    addActivity(ago(5 + back), "run", 40, 6); // the quality run ("Thursday")
    addActivity(ago(2 + back), "run", 84, week === 0 ? 13.5 : 14); // the long run ("Sunday")
  }
  for (let week = 0; week < rideWeeks; week++) addActivity(ago(3 + week * 7), "ride", 142, 31.2);
  // The lifting days of the streak: yesterday and the four weekdays before the weekend.
  for (const n of [1, 4, 5, 6, 7, 8]) seedTrainingDay(ago(n));
  // This morning's easy run is in; the lift is not.
  addActivity(REF, "run", 38, 6.1);
}

const caveatLanded = (text, key) => (DAY_READ_CAVEAT_VARIANTS[key] ?? []).find((variant) => text.includes(variant));
const runInLanded = (text) => !!caveatLanded(text, "planned_training:run_in");

test("the recurring ride day is part of the athlete's week: a streak across it stays on rhythm", () => {
  seedLiveWeek();
  const consec = repo.dayRead(REF).signals.consecutive_training_days;
  assert.ok(consec >= 5, `expected a long streak, got ${consec}`);
  const rhythm = statedRhythmRead(REF, consec);
  assert.ok(rhythm, "today is on the athlete's own week");
  assert.equal(rhythm.streak_on_rhythm, true, "the ride day no longer breaks the streak");
  assert.equal(rhythm.recent_harm_free, true);
  assert.equal(rhythm.lift_day, true);
  assert.equal(rhythm.run_day, true);
  // The ride day itself reads as on the week.
  const rideDay = ago(3);
  assert.equal(statedRhythmRead(rideDay, 0)?.cross_training_day, true);
});

test("a clean stack on the athlete's own week is a training day: the count is advisory, never a downgrade to easy", () => {
  seedLiveWeek();
  const r = repo.dayRead(REF);
  assert.ok(r.signals.consecutive_training_days >= 5, "past the five-day ceiling, as live");
  assert.equal(r.signals.stacked_on_rhythm, true);
  assert.equal(r.kind, "train", `expected a training day, got ${r.kind}: ${r.why}`);
  assert.notEqual(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.decision.rule_code, "planned_training");
  assert.ok(r.focus, "the day names its lift");
  // The run of days rides as the week-naming advisory caveat, and the run already in
  // leads the caveat run — the same story the strength line tells.
  assert.ok(caveatLanded(r.why, "planned_training:stacked_on_rhythm"), r.why);
  assert.ok(!caveatLanded(r.why, "planned_training:stacked_days"), "not the plain pile-up caveat");
  assert.ok(runInLanded(r.why), `the run in and the lift left are named: ${r.why}`);
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
  assert.ok(r.signals.lift_day_open_after, "the run left the lift open");

  // …and the strength line agrees: run in, the same plan day still open, no quiet caveat.
  const line = todayStrengthLine(REF);
  assert.equal(line.state, "not_started");
  assert.ok(line.run_in, "the run is named beside the lift");
  assert.match(line.text, /^Run in · .+ still open/);
  assert.equal(line.suggestion, null, "a training read leaves no easy/rest caveat on the line");
  assert.equal(r.signals.plan_selection?.selected?.day_number, line.day_number, "the Brief and the line name one day");
});

test("on the athlete's own week the endurance dose it already counts never corroborates a rest", () => {
  // At maintenance the weekend's long run reads as a hybrid-interference caution — the
  // same run the streak already counted. It holds the overlapping strength, never the day.
  seedLiveWeek({ goal: "maintain" });
  const r = repo.dayRead(REF);
  const hybrid = r.signals.signal_state.dimensions.training_load_tolerance.evidence.find(
    (e) => e.field === "hybrid_interference"
  );
  assert.ok(hybrid, "the precondition: the weekend's dose is on the board as a caution");
  assert.equal(r.signals.stacked_on_rhythm, true);
  assert.equal(r.kind, "train", `got ${r.kind}: ${r.why}`);
  assert.equal(r.decision.rule_code, "planned_training");
  // Off the week, the same caution still corroborates the stack exactly as before.
  resetTables(...WORLD);
  seedLiveWeek({ goal: "maintain", rideWeeks: 1 });
  const off = repo.dayRead(REF);
  assert.equal(off.kind, "rest");
  assert.equal(off.decision.rule_code, "accumulated_load_rest");
});

test("the signal state never calls a run-only lifting weekday complete", () => {
  seedLiveWeek();
  const r = repo.dayRead(REF);
  assert.notEqual(r.signals.signal_state.action.posture, "done");
  assert.ok(
    !r.signals.signal_state.dimensions.training_load_tolerance.evidence.some((e) => e.field === "completed_today"),
    "the lift is still open — today's planned work is not complete"
  );
});

test("a genuine signal still rests the same stacked week", () => {
  seedLiveWeek();
  repo.addCheckin(REF, { energy: 2, sleep_feel: 3 });
  repo.recordDailyMetrics("apple", REF, { sleep_min: 280 });
  const r = repo.dayRead(REF);
  assert.notEqual(r.kind, "train", "a run-down tap beside a genuinely short night still decides");
});

test("off the athlete's week the ceiling still eases — and the easy Brief names the run in and the lift left", () => {
  // One ride only: no observed cross-training day, so the stack crosses an off-week day.
  seedLiveWeek({ rideWeeks: 1 });
  const r = repo.dayRead(REF);
  assert.equal(r.signals.stacked_on_rhythm, undefined);
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  const sentence = (DAY_READ_WHY_VARIANTS.lift_open_after_activity ?? []).find((v) => r.why.includes(v));
  assert.ok(sentence, `the easy read names the run in and the lift left: ${JSON.stringify(r.why)}`);
  assert.equal(violatesReadingGrammar(r.why), null, r.why);

  // The Brief response: the strength line carries the lift held light, and the generic
  // walk/mobility menu steps aside for it.
  const brief = attachDayReadContext(REF, { ...r });
  assert.equal(brief.recovery, undefined, "no generic recovery menu beside an open lift after the run");
  assert.equal(brief.strength_line?.state, "not_started");
  assert.ok(brief.strength_line?.run_in);
});

test("an easy read with nothing logged today keeps its recovery menu", () => {
  seedLiveWeek({ rideWeeks: 1 });
  db.prepare(`DELETE FROM activities WHERE date = ?`).run(REF);
  const r = repo.dayRead(REF);
  assert.equal(r.kind, "easy");
  assert.ok(!(DAY_READ_WHY_VARIANTS.lift_open_after_activity ?? []).some((v) => r.why.includes(v)));
  const brief = attachDayReadContext(REF, { ...r });
  assert.ok(brief.recovery, "no run in → the menu is still the quiet day's offer");
});

// ---------- plan week: one day for today, on every surface ----------
const WEEK_REF = "2026-04-21"; // a Tuesday; the week starts Monday 2026-04-20

function seedWeekdayPlan() {
  seedPlan();
  repo.setProfile({
    strength_schedule: { days: [1, 2, 3, 4, 5].map((d) => ({ dow: d })), source: "athlete", updated_at: WEEK_REF },
  });
}

test("today's plan-week cell names the strength line's day, with the map's day kept as swapped_from", () => {
  seedWeekdayPlan();
  // Before anything adapts, the cell and the line already agree.
  const plain = planWeek(WEEK_REF);
  const plainToday = plain.days.find((d) => d.date === WEEK_REF);
  assert.equal(plainToday.plan_day.day_number, plain.strength_line.day_number);
  assert.equal(plainToday.plan_day.swapped_from, undefined);
  const mapped = plainToday.plan_day;

  // The Brief's persisted selection adapted today to another strength day (live: the map
  // laid "Lower B" on Tuesday, the selection handed the morning to "Push").
  const adaptedTo = mapped.day_number === 1 ? 4 : 1;
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, signals, source) VALUES (?, 'train', 'x', 'y', NULL, ?, 'deterministic')`
  ).run(WEEK_REF, JSON.stringify({ plan_selection: { selected: { day_number: adaptedTo } } }));

  const week = planWeek(WEEK_REF);
  const today = week.days.find((d) => d.date === WEEK_REF);
  assert.equal(week.strength_line.day_number, adaptedTo);
  assert.equal(today.plan_day.day_number, week.strength_line.day_number, "the strip and the line name one day");
  assert.equal(today.plan_day.name, week.strength_line.title);
  assert.deepEqual(today.plan_day.swapped_from, { day_number: mapped.day_number, name: mapped.name });
  assert.equal(today.status, "today");
  // The rest of the week keeps the map's forecast; only today moved.
  for (const cell of week.days.filter((d) => d.date !== WEEK_REF)) {
    const before = plain.days.find((d) => d.date === cell.date);
    assert.equal(cell.plan_day?.day_number ?? null, before.plan_day?.day_number ?? null, cell.date);
    assert.equal(cell.plan_day?.swapped_from, undefined);
  }
  // A logged session owns the cell again, whatever the selection said.
  repo.logSetByName({ date: WEEK_REF, exercise: "Barbell Row", weight: 135, reps: 8, day_number: 2 });
  const logged = planWeek(WEEK_REF).days.find((d) => d.date === WEEK_REF);
  assert.equal(logged.plan_day.day_number, 2);
  assert.equal(logged.plan_day.swapped_from, undefined);
});
