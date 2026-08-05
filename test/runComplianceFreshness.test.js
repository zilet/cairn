// RUN COMPLIANCE, told against a prescription that is actually about this week.
//
// The Endurance screen printed "9.1 of 7.3 km this week" — a real 9.1 km against a
// target from a run plan applied weeks earlier. getRunCompliance sums the APPLIED
// plan's cardio rows, and nothing ever rebuilt those rows, so they fossilized.
//
// runComplianceRead keeps the applied plan as the default source of truth (it is
// what the athlete sees on Plan, and a hand-authored endurance week must never be
// silently overruled) and falls back to the LIVE weekly mix only when the applied
// rows cannot honestly speak for this week. `basis` reports which happened.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, isoDaysAgo } from "./_seed.js";
// The composer lives one layer up from the repo barrel: run-progression.ts already
// imports getRunCompliance, so composing the fallback in the domain layer keeps that
// dependency one-way instead of building a cycle inside src/repo.
import { runComplianceRead } from "../dist/domain/training/index.js";

beforeEach(() => {
  resetTables("plan_days", "plan_items", "activities", "plan_proposals", "profile", "sessions");
  repo.setProfile({ endurance_sport: "run" }); // a runner, so the live engine will shape a week
});

function weekStart() {
  return repo.runComplianceWeekStart();
}

function seedAppliedCardio(km) {
  repo.setWeeklyRuns([{ day_number: 1, label: "Easy run", target_distance_km: km, target_zone: "Z2", day_name: "Run" }]);
}

function seedLoggedRun(km) {
  repo.addActivity({ type: "run", distance_km: km, duration_min: 52, date: isoDaysAgo(0) });
}

// An auto-run-plan proposal that actually landed on the plan, dated `dateISO`.
function seedAppliedRunPlanProposal(dateISO) {
  const proposal = repo.createProposal("auto-run-plan", "run plan", "", { summary: "runs", cardio: [] });
  repo.setProposalStatus(Number(proposal.id), "applied");
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(`${dateISO} 06:00:00`, Number(proposal.id));
  return proposal;
}

test("an applied plan that speaks for this week is left exactly as it is", () => {
  seedAppliedCardio(7.3);
  seedLoggedRun(9.1);
  seedAppliedRunPlanProposal(weekStart()); // this week's plan landed on Monday

  const read = runComplianceRead();
  assert.equal(read.basis, "applied");
  assert.equal(read.prescribed_km, 7.3);
  assert.equal(read.prescribed_sessions, 1);
  assert.equal(read.actual_km, 9.1);
  assert.equal(read.in_words, "9.1 of 7.3 km this week");

  // The underlying read is untouched and always reports its own basis.
  const raw = repo.getRunCompliance();
  assert.equal(raw.basis, "applied");
  assert.equal(raw.prescribed_km, 7.3);
  assert.equal(raw.in_words, read.in_words);
});

test("a hand-authored endurance week is never overruled by the live engine", () => {
  seedAppliedCardio(7.3);
  seedLoggedRun(9.1);
  // No auto-run-plan has ever been applied: these rows are the athlete's own.
  assert.equal(repo.lastAppliedRunPlanDate(), null);
  assert.equal(repo.appliedRunPlanNeedsRefresh(weekStart()), false);
  assert.equal(runComplianceRead().basis, "applied");
});

test("an applied plan from a previous week hands the prescription to the live mix", () => {
  seedAppliedCardio(7.3);
  seedLoggedRun(9.1);
  seedAppliedRunPlanProposal(isoDaysAgo(21)); // the fossil: applied three weeks ago

  assert.equal(repo.appliedRunPlanNeedsRefresh(weekStart()), true);
  const read = runComplianceRead();
  assert.equal(read.basis, "live_plan");
  assert.ok(read.prescribed_km > 0, "the live plan supplies a real weekly target");
  assert.notEqual(read.prescribed_km, 7.3, "the fossilized target is not what gets quoted");
  assert.equal(read.actual_km, 9.1, "the actuals are the same logged efforts either way");
  // Same sentence shape, different basis — the format never changes.
  assert.match(read.in_words, /^9\.1 of \d+(\.\d)? km this week$/);
  assert.equal(read.pct_km, Math.round((9.1 / read.prescribed_km) * 100) / 100);
});

test("a week with no applied run rows at all falls back to the live mix", () => {
  seedLoggedRun(9.1); // logged running, but the plan prescribes no cardio

  const applied = repo.getRunCompliance();
  assert.equal(applied.prescribed_sessions, 0);
  assert.equal(applied.in_words, "1 run this week, none prescribed");

  const read = runComplianceRead();
  assert.equal(read.basis, "live_plan");
  assert.ok(read.prescribed_sessions > 0, "the live mix prescribes a real week");
  assert.ok(read.prescribed_km > 0);
  assert.match(read.in_words, /of \d+(\.\d)? km this week$/);
});

test("a non-runner with nothing prescribed stays on the applied read rather than inventing a week", () => {
  repo.setProfile({ endurance_sport: "cycling" });
  const read = runComplianceRead();
  // The live engine declines to prescribe runs for a cycling-only athlete, so the
  // fallback finds nothing and the calm applied answer stands.
  assert.equal(read.basis, "applied");
  assert.equal(read.prescribed_sessions, 0);
  assert.equal(read.in_words, "no runs prescribed this week");
});

// The applied cardio row is often mute about its own sport: savePlanDay folds a
// cardio item's label into `note` only when there is no prose note, and the run
// engine always writes prose — so "Long run" was dropped and compliance counted
// ZERO prescribed runs for a week the run engine itself had just applied.
test("a machine-applied run week is visible to compliance even after the row loses its label", () => {
  repo.setWeeklyRuns([
    {
      day_number: 1,
      label: "Long run",
      day_name: "Long run",
      note: "Long, steady at Z2 — build aerobic durability, keep it easy throughout.",
      target_distance_km: 12,
      target_zone: "Z2",
    },
  ]);
  const item = repo.getPlan().flatMap((day) => day.items || []).find((it) => it.kind === "cardio");
  assert.equal(item.exercise, null, "a cardio row carries no exercise by design");
  assert.doesNotMatch(String(item.note), /\brun\b/i, "and the prose note never says 'run'");

  const read = repo.getRunCompliance();
  assert.equal(read.prescribed_sessions, 1);
  assert.equal(read.prescribed_km, 12);
});

// target_zone is free text ('Z2' | 'tempo' | 'easy'), and "tempo" and "interval"
// are running tokens to the sport classifier — so folding it into one blob with the
// item's own label let an effort word outvote an explicit sport. An effort word is
// the weakest sport signal there is: it only speaks when nothing else does.
test("an effort word in target_zone never overrides the sport the item names", () => {
  repo.setWeeklyRuns([
    {
      day_number: 2,
      label: "Intervals",
      day_name: "Bike intervals",
      note: "Trainer session — hard efforts on the bike.",
      target_distance_km: 30,
      target_zone: "tempo",
    },
  ]);
  assert.equal(repo.getRunCompliance().prescribed_sessions, 0, "a cycling session prescribed at 'tempo' is still cycling");
});

test("a planned ride is not counted as a prescribed run, whatever day it sits on", () => {
  repo.setWeeklyRuns([
    {
      day_number: 1,
      label: "Long run",
      day_name: "Long run",
      note: "Easy spin on the trainer — zone 2 ride",
      target_distance_km: 40,
      target_zone: "Z2",
    },
  ]);
  assert.equal(repo.getRunCompliance().prescribed_sessions, 0, "the item names its own sport and it is not running");
});

// The live-plan target used to CHASE the runs it was judging: weeklyRunPlan anchors
// its volume on max(compliance.actual_km, trailing-7-day km) read at the date it is
// given, and both of those included this week's runs so far — so every logged
// kilometre raised the target it was being measured against, pct_km plateaued near
// 1/factor, and the number visibly moved day to day. Under review_everything nothing
// ever applies, so that was the steady state, not a transient.
test("the live-plan prescription is anchored at the week start and does not move as the week is run", () => {
  seedAppliedCardio(7.3);
  seedAppliedRunPlanProposal(isoDaysAgo(28)); // a fossil → the live mix supplies the target

  const monday = weekStart();
  const before = (n) => new Date(Date.parse(`${monday}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  const during = (n) => new Date(Date.parse(`${monday}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  // What was already in the bank when the week opened: three runs in the seven days
  // before this Monday. That is the whole basis the week should be shaped from.
  for (const back of [1, 3, 5]) {
    repo.addActivity({ type: "run", distance_km: 6, duration_min: 34, date: before(back) });
  }

  const opening = runComplianceRead();
  assert.equal(opening.basis, "live_plan");
  assert.ok(opening.prescribed_km > 0, "the live mix prescribes a real week");
  assert.equal(opening.actual_km, 0, "nothing has been run inside this week yet");

  // Now the week gets run, one outing at a time (dated after the Monday the plan is
  // anchored to, so only the ACTUALS can possibly move).
  repo.addActivity({ type: "run", distance_km: 5, duration_min: 28, date: during(1) });
  const midweek = runComplianceRead();
  repo.addActivity({ type: "run", distance_km: 7, duration_min: 40, date: during(2) });
  const later = runComplianceRead();

  assert.equal(midweek.prescribed_km, opening.prescribed_km, "the target is the same after one run");
  assert.equal(later.prescribed_km, opening.prescribed_km, "and after two — a plan state, not a moving average");
  assert.equal(later.prescribed_sessions, opening.prescribed_sessions);
  assert.equal(later.actual_km, 12, "the actuals are what move");
  assert.ok(later.pct_km > midweek.pct_km, "so the ratio climbs with the running rather than standing still");
});

test("the fallback never recurses through weeklyRunPlan's own compliance read", () => {
  seedLoggedRun(9.1);
  // weeklyRunPlan calls getRunCompliance for last week's actuals; runComplianceRead
  // hands it the applied read instead. If that wiring ever inverted, this would
  // blow the stack rather than return.
  const read = runComplianceRead();
  assert.ok(Number.isFinite(read.prescribed_km));
  assert.equal(runComplianceRead(isoDaysAgo(0)).basis, read.basis);
});
