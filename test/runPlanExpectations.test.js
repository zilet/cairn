// Applying a proposal that carries RUNS. Runs are no longer plan items (migration
// 110): the week's runs follow the stated run days and the live run engine, so a
// legacy `cardio[]` week or a kind:'cardio' change has nothing to write. applyProposal
// SETS THEM ASIDE — never written, never an error that rolls back the strength half
// beside them — and a proposal that carries ONLY runs answers the designed
// {ok:false, error: RUNS_ARE_NOT_PLAN_ITEMS} and stays a draft. The run-plan
// expectation branch (run_volume_adherence / the volume-raise recovery guards) went
// with the apply path: no run week is ever applied, so there is no raise to guard.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("plan_days", "plan_items", "plan_proposals", "profile", "brain_decisions", "brain_expectations");
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
});

// Metric keys on the applied proposal's decision.
function expectationsFor(proposalId) {
  const decision = db
    .prepare(
      `SELECT id FROM brain_decisions
       WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'applied'
       ORDER BY id DESC LIMIT 1`
    )
    .get(String(proposalId));
  if (!decision) return { decisionId: null, keys: [] };
  const rows = db
    .prepare(`SELECT metric_key FROM brain_expectations WHERE decision_id = ? ORDER BY id`)
    .all(decision.id);
  return { decisionId: decision.id, keys: rows.map((r) => r.metric_key) };
}

const statusOf = (id) => db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(Number(id)).status;
const cardioItemCount = () => db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE kind = 'cardio'`).get().n;

const EASY = {
  day_number: 2,
  label: "Easy run",
  target_distance_km: 8,
  target_zone: "Z2 (135-145 bpm)",
  day_name: "Easy run",
  focus: "Endurance",
};
const LONG = {
  day_number: 6,
  label: "Long run",
  target_distance_km: 12,
  target_zone: "Z2 (135-145 bpm)",
  day_name: "Long run",
  focus: "Endurance · long",
};

test("a run-only proposal lands nothing: designed ok:false, still a draft, no plan row, no decision", () => {
  const runs = repo.createProposal("auto-run-plan", "run plan", "", { summary: "This week's runs", cardio: [EASY, LONG] });
  const result = repo.applyProposal(runs.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, repo.RUNS_ARE_NOT_PLAN_ITEMS);
  assert.equal(statusOf(runs.id), "draft", "the proposal is not flipped to applied");
  assert.equal(cardioItemCount(), 0, "no cardio row is written");
  assert.equal(repo.getPlan().length, 0, "and no plan day appears for the runs");
  const { decisionId, keys } = expectationsFor(runs.id);
  assert.equal(decisionId, null, "nothing applied, so nothing is recorded as applied");
  assert.equal(keys.length, 0);
});

test("a proposal whose only changes are kind:'cardio' is the same refusal", () => {
  repo.savePlanDay(1, "Full body", "Strength", [
    { exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const runs = repo.createProposal("auto", "run tweak", "", {
    summary: "a longer long run",
    changes: [{ day_number: 1, kind: "cardio", label: "Long run", target_distance_km: 14 }],
  });
  const result = repo.applyProposal(runs.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, repo.RUNS_ARE_NOT_PLAN_ITEMS);
  assert.equal(statusOf(runs.id), "draft");
  assert.equal(cardioItemCount(), 0);
});

test("a MIXED strength+run proposal applies the strength half and reports the runs set aside", () => {
  repo.savePlanDay(1, "Full body", "Strength", [
    { exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const mixed = repo.createProposal("auto", "mixed strength + run", "", {
    summary: "one proposal, two domains",
    changes: [{ day_number: 1, exercise: "Goblet Squat", sets: 4, rep_low: 8, rep_high: 10, target_weight: 45 }],
    cardio: [{ ...EASY, day_number: 3 }],
  });
  const result = repo.applyProposal(mixed.id);
  assert.equal(result.ok, true, "the runs never roll back the strength half");
  assert.equal(result.runs_set_aside, 1);
  assert.equal(statusOf(mixed.id), "applied");
  const squat = repo.getPlan().flatMap((d) => d.items || []).find((it) => it.exercise === "Goblet Squat");
  assert.equal(squat.target_weight, 45, "the strength change landed");
  assert.equal(cardioItemCount(), 0, "the run did not");

  const { keys } = expectationsFor(mixed.id);
  assert.ok(keys.includes("exercise_target_completion"), `exercise expectation emitted (got: ${keys.join(", ")})`);
  assert.ok(!keys.includes("run_volume_adherence"), "no run expectation — no run week was applied");
  assert.ok(!keys.includes("recovery_rhr_delta"), "and no volume-raise guard");
});

test("a kind:'cardio' change beside a strength change is set aside the same way", () => {
  repo.savePlanDay(1, "Full body", "Strength", [
    { exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const mixed = repo.createProposal("auto", "mixed changes", "", {
    summary: "a heavier squat and a longer run",
    changes: [
      { day_number: 1, exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 45 },
      { day_number: 1, kind: "cardio", label: "Long run", target_distance_km: 14 },
    ],
  });
  const result = repo.applyProposal(mixed.id);
  assert.equal(result.ok, true);
  assert.equal(result.runs_set_aside, 1);
  assert.equal(result.skipped.length, 0, "a run is set aside, never a skipped (rolled-back) change");
  assert.equal(cardioItemCount(), 0);
});
