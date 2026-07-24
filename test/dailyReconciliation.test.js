import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getDailySessionOutcome, reconcileDailySession } from "../dist/repo/daily-reconciliation.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-08-05";

beforeEach(() => {
  resetTables(
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "context_events",
    "plan_items",
    "plan_days",
    "exercises",
    "plan_proposals"
  );
});

function seedPlan() {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
}

function acceptComposition(items) {
  const session = {
    name: "Lower body",
    focus: "Quads and hinge",
    why: "Fits the plan today.",
    est_minutes: 50,
    items,
  };
  const job = repo.createAgentJob({ kind: "session_compose", input: { date: DATE } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
  return repo.prepareDailySession({ date: DATE, source: "agent_suggest", agent_job_id: job.id });
}

test("a session with no daily-session composition reconciles to null", () => {
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  const session = repo.getSessionByDate(DATE);
  const outcome = reconcileDailySession(session.id);
  assert.equal(outcome, null);
});

test("completing the suggested work records a completed, adherence-neutral outcome", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 230, reps: 5, day_number: null });
  repo.logSetByName({ date: DATE, exercise: "Romanian Deadlift", weight: 185, reps: 8, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.facts.completed.sort(), ["Back Squat", "Romanian Deadlift"]);
  assert.equal(outcome.facts.substituted.length, 0);
  assert.equal(outcome.facts.skipped.length, 0);
  assert.ok(outcome.facts.reason_codes.includes("completed_as_suggested"));
  const squat = outcome.facts.progression_evidence.find((p) => p.exercise === "Back Squat");
  assert.equal(squat.verdict, "met_or_exceeded");
  assert.equal(outcome.facts.confidence, "high");
});

test("a substitution explained by travel is not judged as poor adherence", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  repo.addContextEvent({ kind: "trip", title: "Work trip", start_date: DATE, end_date: DATE });
  // Trained something else entirely (a hotel-gym machine).
  repo.logSetByName({ date: DATE, exercise: "Leg Press", weight: 300, reps: 10, day_number: null });
  repo.finishSession(prepared.session_id, null);

  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  assert.ok(outcome.facts.substituted.includes("Leg Press"));
  assert.ok(outcome.facts.skipped.includes("Back Squat"));
  assert.ok(outcome.facts.confounders.includes("travel_window"));
  assert.ok(outcome.facts.reason_codes.includes("substituted_movements"));
  assert.ok(outcome.facts.reason_codes.includes("explained_by_context"));
  // Adherence-neutral: no numeric adherence/score field is ever produced.
  assert.ok(!("adherence" in outcome.facts));
  assert.ok(!("score" in outcome.facts));
});

test("reconciliation is idempotent — re-running upserts a single row", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  const first = reconcileDailySession(prepared.session_id);
  const second = reconcileDailySession(prepared.session_id);
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM daily_session_outcomes WHERE session_id = ?`)
    .get(prepared.session_id);
  assert.equal(rows.n, 1);
  assert.deepEqual(first.facts.completed, second.facts.completed);
});

test("reconciliation never mutates the weekly plan or creates a proposal", () => {
  seedPlan();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n;
  const planBefore = db.prepare(`SELECT COUNT(*) AS n FROM plan_items`).get().n;
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Front Squat", weight: 185, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);
  reconcileDailySession(prepared.session_id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, before);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_items`).get().n, planBefore);
});

test("an unstarted accepted session records a not_started, low-confidence outcome", () => {
  seedPlan();
  const prepared = acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const outcome = reconcileDailySession(prepared.session_id);
  assert.ok(outcome);
  assert.equal(outcome.status, "not_started");
  assert.ok(outcome.facts.reason_codes.includes("not_started"));
  assert.equal(outcome.facts.confidence, "low");
});

test("session feedback flows into the reconciliation as a confounder", () => {
  seedPlan();
  acceptComposition([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.logSetByName({ date: DATE, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.setSessionFeedback(DATE, { joint_pain: "left knee", soreness: 4 });
  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  assert.equal(outcome.facts.feedback.joint_pain, "left knee");
  assert.ok(outcome.facts.confounders.includes("joint_pain"));
  assert.ok(outcome.facts.confounders.includes("high_soreness"));
});
