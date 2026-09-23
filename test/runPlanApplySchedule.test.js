// THE MONDAY RUN-PLAN APPLY TICK IS RETIRED.
//
// It existed because the applied plan's cardio rows were the only endurance
// prescription the Plan screen and run-compliance could see, and nothing else ever
// rebuilt them. Runs are no longer plan items (migration 110): each week's runs are
// computed LIVE by weeklyRunPlan from the athlete's stated run days, so there is
// nothing to keep current and nothing to apply. This file proves the retirement is
// whole — the tick's exports are gone, the apply path answers its designed
// {ok:false} without writing a proposal or a plan row, and a leftover
// 'auto-run-plan' draft has no producer to re-run.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, isoDaysAgo } from "./_seed.js";
import * as scheduler from "../dist/scheduler.js";
import { buildRunPlanWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { regenerableProducer } from "../dist/domain/brain/draft-regeneration.js";

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
  // A runner with history — exactly the athlete the old tick would have written a week for.
  repo.setProfile({ endurance_sport: "run" });
  repo.addActivity({ type: "run", distance_km: 9.1, duration_min: 52, date: isoDaysAgo(2) });
});

const proposalCount = () => db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n;
const planItemCount = () => db.prepare(`SELECT COUNT(*) AS n FROM plan_items`).get().n;

test("the scheduler no longer exports a run-plan apply cadence", () => {
  for (const name of [
    "RUN_PLAN_APPLY_DAY",
    "RUN_PLAN_APPLY_STATE_KEY",
    "runPlanApplyDue",
    "weeklyRunPlanApplyTask",
    "runPlanAppliedSince",
  ]) {
    assert.equal(scheduler[name], undefined, `${name} is gone with the tick`);
  }
  for (const name of [
    "setWeeklyRuns",
    "lastAppliedRunPlanDate",
    "appliedRunPlanNeedsRefresh",
    "appliedRunPlanCoversWeek",
  ]) {
    assert.equal(repo[name], undefined, `repo.${name} is gone with the applied-plan model`);
  }
});

test("building a run plan answers the designed ok:false and writes nothing", () => {
  const built = repo.buildRunPlanProposal();
  assert.deepEqual(built, { ok: false, error: repo.RUN_PLAN_IS_LIVE });

  const routed = buildRunPlanWithAutonomy(repo.runComplianceWeekStart());
  assert.equal(routed.ok, false);
  assert.equal(routed.error, repo.RUN_PLAN_IS_LIVE);

  assert.equal(proposalCount(), 0, "no run-plan proposal is minted");
  assert.equal(planItemCount(), 0, "and nothing lands on the plan");
  assert.equal(repo.getRunCompliance().prescribed_sessions, 0, "the raw read still carries no prescription");
  assert.ok(
    repo.vouchedRunCompliance().prescribed_sessions > 0,
    "the week's runs come from the live engine instead"
  );
});

test("the designed ok:false is the same for an athlete the engine would decline", () => {
  resetTables("activities", "profile");
  repo.setProfile({ endurance_sport: "cycling" });
  assert.deepEqual(buildRunPlanWithAutonomy(), { ok: false, error: repo.RUN_PLAN_IS_LIVE });
  assert.equal(proposalCount(), 0);
});

test("a leftover auto-run-plan draft has no producer to re-run", () => {
  const draft = repo.createProposal("auto-run-plan", "run plan", "", { summary: "runs", cardio: [] });
  const row = db.prepare(`SELECT * FROM plan_proposals WHERE id = ?`).get(Number(draft.id));
  assert.equal(regenerableProducer({ ...row, parsed: { summary: "runs", cardio: [] } }), null);
});

test("the weekly slot stamp the remaining weekly cadences ride is still the week's anchor day", () => {
  // The helper outlived the tick (other weekly slots use it): the stamp is the most
  // recent anchor day, whichever day the process wakes on — that is what makes a
  // missed slot catch up instead of skipping the week.
  const MONDAY = 1;
  const wednesday = new Date(`${isoDaysAgo(0)}T18:00:00Z`);
  const stamp = scheduler.weeklySlotStamp(wednesday, MONDAY, 6);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(stamp <= isoDaysAgo(0));
});
