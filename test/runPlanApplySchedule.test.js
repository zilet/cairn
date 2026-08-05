// THE MISSING CADENCE. The applied plan's cardio rows are the only endurance
// prescription the Plan screen and run-compliance can see, and the only things
// that ever wrote them were the manual Apply button and the apply_run_plan MCP
// tool. So a run plan applied once kept prescribing that week's mileage forever.
//
// This file proves the Monday op: it lands the week once, a second pass in the
// same week is a calm no-op, bg-ops off means no cadence at all, an athlete the
// deterministic engine won't prescribe runs for is never invented a week, and —
// the gate that makes the cadence safe to run at all under the default "lead"
// posture — it does not start leading run weeks until the athlete has applied one
// auto-built plan themselves, so a hand-authored cardio week is never written over.
// Offline and agent-free by construction — buildRunPlanWithAutonomy is the
// deterministic run engine plus the existing autonomy policy, no CLI involved.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, isoDaysAgo } from "./_seed.js";
import {
  RUN_PLAN_APPLY_DAY,
  RUN_PLAN_APPLY_STATE_KEY,
  runPlanAppliedSince,
  runPlanApplyDue,
  weeklyRunPlanApplyTask,
  weeklySlotStamp,
} from "../dist/scheduler.js";

beforeEach(() => {
  resetTables(
    "plan_days",
    "plan_items",
    "activities",
    "plan_proposals",
    "profile",
    "sessions",
    "scheduler_operations",
    "app_state",
    "brain_decisions",
    "brain_expectations"
  );
  repo.setProfile({ endurance_sport: "run" });
  repo.addActivity({ type: "run", distance_km: 9.1, duration_min: 52, date: isoDaysAgo(2) });
});

const monday = () => repo.runComplianceWeekStart();

const appliedRunPlans = () =>
  db
    .prepare(`SELECT COUNT(*) AS n FROM plan_proposals WHERE agent = 'auto-run-plan' AND status = 'applied'`)
    .get().n;

// The athlete handing the run week over: one auto-built plan they applied
// themselves, in an earlier week. Until this exists the cadence does not run at
// all, so every test of what the cadence DOES starts from here.
function handOverRunWeek(dateISO = isoDaysAgo(21)) {
  const proposal = repo.createProposal("auto-run-plan", "run plan", "", { summary: "runs", cardio: [] });
  repo.setProposalStatus(Number(proposal.id), "applied");
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(`${dateISO} 06:00:00`, Number(proposal.id));
  return proposal;
}

test("the Monday op applies this week's run plan once and no-ops on a second pass", async () => {
  handOverRunWeek();
  const slot = monday();
  const first = await repo.runSchedulerOperation(RUN_PLAN_APPLY_STATE_KEY, slot, () => weeklyRunPlanApplyTask(slot));
  assert.equal(first.status, "succeeded");
  assert.equal(first.value.ok, true);
  assert.ok(appliedRunPlans() >= 1, "the run plan actually landed on the plan rows");
  assert.ok(
    repo.getRunCompliance(slot).prescribed_sessions > 0,
    "the applied plan now prescribes this week's runs"
  );

  // The durable slot is acknowledged, so the cadence will not fire again this week.
  assert.equal(repo.schedulerOperationDue(RUN_PLAN_APPLY_STATE_KEY, slot), false);

  // And even if it were re-invoked, the ledger check makes it a calm no-op rather
  // than a second volume step in the same week.
  assert.equal(runPlanAppliedSince(slot), true);
  const applied = appliedRunPlans();
  const second = weeklyRunPlanApplyTask(slot);
  assert.equal(second.outcome, "no_op");
  assert.equal(appliedRunPlans(), applied, "no second plan is applied in the same week");
});

test("a run plan the athlete already applied this week is left alone", () => {
  const slot = monday();
  const proposal = repo.createProposal("auto-run-plan", "run plan", "", { summary: "runs", cardio: [] });
  repo.setProposalStatus(Number(proposal.id), "applied");
  assert.equal(runPlanAppliedSince(slot), true);
  assert.equal(weeklyRunPlanApplyTask(slot).outcome, "no_op");
});

test("an applied plan from a previous week does not count as this week's", () => {
  const proposal = repo.createProposal("auto-run-plan", "run plan", "", { summary: "runs", cardio: [] });
  repo.setProposalStatus(Number(proposal.id), "applied");
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(`${isoDaysAgo(21)} 06:00:00`, Number(proposal.id));
  assert.equal(runPlanAppliedSince(monday()), false);
});

test("an athlete the run engine declines to prescribe for is never invented a week", () => {
  resetTables("activities", "plan_proposals", "profile");
  repo.setProfile({ endurance_sport: "cycling" });
  handOverRunWeek(); // the cadence is live; it is the ENGINE that declines here
  const before = appliedRunPlans();
  const result = weeklyRunPlanApplyTask(monday());
  assert.equal(result.outcome, "no_op");
  assert.equal(appliedRunPlans(), before);
});

// A hand-authored cardio week is exactly what the athlete asked for, and the
// default lead_mode is "lead" — so without this gate the very first Monday tick on
// a fresh install would quiet-apply a machine-built run week straight over it. The
// machine starts leading run weeks only after the athlete has applied one auto plan
// through the explicit propose/apply flow.
test("a hand-authored cardio week survives the Monday tick when no auto plan was ever applied", () => {
  resetTables("plan_days", "plan_items", "plan_proposals");
  repo.savePlanDay(3, "Cardio", "Endurance", [
    { exercise: "Easy run", kind: "cardio", target_distance_km: 6, target_duration_min: 35 },
  ]);
  const cardioRows = () => repo.getPlan().flatMap((day) => day.items || []).filter((it) => it.kind === "cardio");
  assert.equal(cardioRows().length, 1, "the athlete's own cardio row is on the plan");
  assert.equal(repo.lastAppliedRunPlanDate(), null, "and no auto run plan has ever landed");

  assert.equal(weeklyRunPlanApplyTask(monday()).outcome, "no_op");
  assert.equal(appliedRunPlans(), 0, "nothing was applied over the athlete's week");

  const after = cardioRows();
  assert.equal(after.length, 1, "the hand-authored cardio row is still the only one");
  assert.equal(after[0].target_distance_km, 6, "and it still says what the athlete wrote");
});

test("the cadence rides the bg-ops gate and the Monday slot", () => {
  // A Monday well past the configured hour: due, if bg ops are on.
  const mondayNoon = new Date(`${monday()}T18:00:00Z`);
  assert.equal(runPlanApplyDue(mondayNoon, { bg_ops_enabled: false, coach_hour: 6 }), false, "bg ops off ⇒ no cadence");
  assert.equal(runPlanApplyDue(mondayNoon, { bg_ops_enabled: true, coach_hour: 6 }), true);

  // The slot stamp is the Monday of the week, whichever day the process wakes on —
  // that is what makes a missed Monday catch up instead of skipping the week.
  const wednesday = new Date(`${isoDaysAgo(0)}T18:00:00Z`);
  const stamp = weeklySlotStamp(wednesday, RUN_PLAN_APPLY_DAY, 6);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(stamp <= isoDaysAgo(0));

  // Once the slot completes, the gate closes for the rest of the week.
  repo.setAppState(RUN_PLAN_APPLY_STATE_KEY, weeklySlotStamp(mondayNoon, RUN_PLAN_APPLY_DAY, 6));
  assert.equal(runPlanApplyDue(mondayNoon, { bg_ops_enabled: true, coach_hour: 6 }), false);
});
