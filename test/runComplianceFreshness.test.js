// RUN COMPLIANCE, told against a prescription that is actually about this week.
//
// The Endurance screen once printed "9.1 of 7.3 km this week" — a real 9.1 km
// against a target from a run plan applied weeks earlier, because compliance summed
// the APPLIED plan's cardio rows and nothing ever rebuilt them.
//
// Runs are no longer plan items (migration 110), so that fossil cannot exist:
// getRunCompliance owns the ACTUALS only (logged runs are fact), and
// runComplianceRead composes the prescription from the LIVE run engine
// (weeklyRunPlan) for that week — `basis: "live_plan"` — so every surface quoting
// "X of Y km" reads one number.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, isoDaysAgo } from "./_seed.js";
import { runComplianceRead } from "../dist/domain/training/index.js";

beforeEach(() => {
  resetTables("plan_days", "plan_items", "activities", "plan_proposals", "profile", "sessions");
  repo.setProfile({ endurance_sport: "run" }); // a runner, so the live engine will shape a week
});

function weekStart() {
  return repo.runComplianceWeekStart();
}

function seedLoggedRun(km) {
  repo.addActivity({ type: "run", distance_km: km, duration_min: 52, date: isoDaysAgo(0) });
}

test("the raw read is actuals only; the live engine supplies this week's prescription", () => {
  seedLoggedRun(9.1);

  // getRunCompliance carries NO prescription — runs are not plan items.
  const raw = repo.getRunCompliance();
  assert.equal(raw.basis, "applied");
  assert.equal(raw.prescribed_sessions, 0);
  assert.equal(raw.prescribed_km, 0);
  assert.equal(raw.pct_km, null);
  assert.equal(raw.actual_km, 9.1);
  assert.equal(raw.in_words, "1 run this week, none prescribed");

  const read = runComplianceRead();
  assert.equal(read.basis, "live_plan");
  assert.ok(read.prescribed_sessions > 0, "the live mix prescribes a real week");
  assert.ok(read.prescribed_km > 0, "the live plan supplies a real weekly target");
  assert.equal(read.actual_km, 9.1, "the actuals are the same logged efforts either way");
  assert.match(read.in_words, /^9\.1 of \d+(\.\d)? km this week$/);
  assert.equal(read.pct_km, Math.round((9.1 / read.prescribed_km) * 100) / 100);
});

test("the vouched read every surface quotes IS the live read", () => {
  seedLoggedRun(9.1);
  assert.deepEqual(repo.vouchedRunCompliance(), runComplianceRead());
  assert.deepEqual(repo.vouchedRunCompliance(weekStart()), runComplianceRead(weekStart()));
});

test("a cardio item handed to the plan writer never becomes a prescription", () => {
  // The fossil's source is gone: savePlanDay strips kind:'cardio' items silently.
  repo.savePlanDay(1, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, reps: "5", target_weight: 185 },
    { exercise: null, kind: "cardio", label: "Long run", target_distance_km: 12, target_zone: "Z2" },
  ]);
  const items = repo.getPlan().flatMap((day) => day.items || []);
  assert.equal(items.filter((it) => it.kind === "cardio").length, 0, "no cardio row lands on the plan");
  assert.ok(items.some((it) => it.exercise === "Back Squat"), "the strength half is written");
  assert.equal(repo.getRunCompliance().prescribed_sessions, 0);
  assert.notEqual(runComplianceRead().prescribed_km, 12, "the stripped row is never what gets quoted");
});

// The sport classifier still guards the ACTUALS side: a ride is not a run, whatever
// else happened that week.
test("a logged ride is not counted as a run actual", () => {
  repo.addActivity({ type: "cycling", distance_km: 40, duration_min: 80, date: isoDaysAgo(0) });
  const raw = repo.getRunCompliance();
  assert.equal(raw.actual_sessions, 0, "the ride is not a run");
  assert.equal(raw.actual_km, 0);
});

test("a non-runner is never invented a week", () => {
  repo.setProfile({ endurance_sport: "cycling" });
  const read = runComplianceRead();
  // The live engine declines to prescribe runs for a cycling-only athlete, so the
  // calm actuals-only answer stands.
  assert.equal(read.basis, "applied");
  assert.equal(read.prescribed_sessions, 0);
  assert.equal(read.in_words, "no runs prescribed this week");
});

// The live-plan target used to CHASE the runs it was judging: weeklyRunPlan anchors
// its volume on max(compliance.actual_km, trailing-7-day km) read at the date it is
// given, and both of those included this week's runs so far — so every logged
// kilometre raised the target it was being measured against, pct_km plateaued near
// 1/factor, and the number visibly moved day to day.
test("the live-plan prescription is anchored at the week start and does not move as the week is run", () => {
  const monday = weekStart();
  const before = (n) => new Date(Date.parse(`${monday}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  const during = (n) => new Date(Date.parse(`${monday}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  // What was already in the bank when the week opened: three runs in the seven days
  // before this Monday. That is the whole basis the week should be shaped from.
  for (const back of [1, 3, 5]) {
    repo.addActivity({ type: "run", distance_km: 6, duration_min: 34, date: before(back) });
  }

  const opening = runComplianceRead(monday);
  assert.equal(opening.basis, "live_plan");
  assert.ok(opening.prescribed_km > 0, "the live mix prescribes a real week");
  assert.equal(opening.actual_km, 0, "nothing has been run inside this week yet");

  // Now the week gets run, one outing at a time (dated after the Monday the plan is
  // anchored to, so only the ACTUALS can possibly move).
  repo.addActivity({ type: "run", distance_km: 5, duration_min: 28, date: during(1) });
  const midweek = runComplianceRead(monday);
  repo.addActivity({ type: "run", distance_km: 7, duration_min: 40, date: during(2) });
  const later = runComplianceRead(monday);

  assert.equal(midweek.prescribed_km, opening.prescribed_km, "the target is the same after one run");
  assert.equal(later.prescribed_km, opening.prescribed_km, "and after two — a plan state, not a moving average");
  assert.equal(later.prescribed_sessions, opening.prescribed_sessions);
  assert.equal(later.actual_km, 12, "the actuals are what move");
  assert.ok(later.pct_km > midweek.pct_km, "so the ratio climbs with the running rather than standing still");
});

test("the composer never recurses through weeklyRunPlan's own compliance read", () => {
  seedLoggedRun(9.1);
  // weeklyRunPlan calls getRunCompliance for last week's actuals; runComplianceRead
  // hands it that raw read instead. If that wiring ever inverted, this would blow
  // the stack rather than return.
  const read = runComplianceRead();
  assert.ok(Number.isFinite(read.prescribed_km));
  assert.equal(runComplianceRead(isoDaysAgo(0)).basis, read.basis);
});
