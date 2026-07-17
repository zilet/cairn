// Run-plan APPLY earns falsifiable ledger expectations (src/repo/profile.ts
// recordAppliedProposalDecision + applyProposalUnit). Before this round a run-plan
// apply routed cardio through setWeeklyRuns → result.runs, which the decision
// recorder never read, so run-plan decisions got only a generic plan-adherence
// proxy. Now they emit (a) run_volume_adherence over the plan window and (b) a
// recovery guard (recovery_rhr_delta) ONLY when the plan raises weekly km vs the
// prior prescription. Both the explicit /apply and the autonomy path flow through
// the same recorder, so this drives the shared spine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

// Metric keys (+ the run_volume_adherence target) on the applied proposal's decision.
function expectationsFor(proposalId) {
  const decision = db
    .prepare(
      `SELECT id FROM brain_decisions
       WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'applied'
       ORDER BY id DESC LIMIT 1`
    )
    .get(String(proposalId));
  if (!decision) return { decisionId: null, keys: [], rows: [] };
  const rows = db
    .prepare(`SELECT metric_key, target_json, baseline_json FROM brain_expectations WHERE decision_id = ? ORDER BY id`)
    .all(decision.id);
  return { decisionId: decision.id, keys: rows.map((r) => r.metric_key), rows };
}

function cardioProposal(km2, km6) {
  return repo.createProposal("auto-run-plan", "run plan", "", {
    summary: "This week's runs",
    cardio: [
      {
        day_number: 2,
        label: "Easy run",
        target_distance_km: km2,
        target_zone: "Z2 (135-145 bpm)",
        day_name: "Easy run",
        focus: "Endurance",
      },
      {
        day_number: 6,
        label: "Long run",
        target_distance_km: km6,
        target_zone: "Z2 (135-145 bpm)",
        day_name: "Long run",
        focus: "Endurance · long",
      },
    ],
  });
}

function asRunner() {
  repo.setProfile({ age: 40, sex: "male", primary_discipline: "hybrid", endurance_sport: "running" });
}

test("applying a run-plan proposal emits a run_volume_adherence expectation over the plan window", () => {
  asRunner();
  const first = cardioProposal(8, 12); // ~20 km/week — the plan's first run week
  const result = repo.applyProposal(first.id);
  assert.equal(result.ok, true);
  const { keys, rows } = expectationsFor(first.id);
  assert.ok(keys.includes("run_volume_adherence"), `run_volume_adherence emitted (got: ${keys.join(", ")})`);
  // A first-ever run plan has no prior prescription to raise from → no recovery guard.
  assert.ok(!keys.includes("recovery_rhr_delta"), "no recovery guard without a prior prescription");
  // The window's expected km is the applied weekly km carried across the 4-week window.
  const rva = rows.find((r) => r.metric_key === "run_volume_adherence");
  const target = JSON.parse(rva.target_json);
  assert.ok(Math.abs(target.expected_km - 80) < 1, `expected ~80 km over the window (got ${target.expected_km})`);
  assert.equal(target.rate, 0.8);
});

test("a run plan that RAISES weekly km vs the prior prescription adds a recovery guard", () => {
  asRunner();
  assert.equal(repo.applyProposal(cardioProposal(8, 12).id).ok, true); // prior ~20 km
  const second = cardioProposal(13, 19); // ~32 km — a clear (>5%) raise
  assert.equal(repo.applyProposal(second.id).ok, true);
  const { keys, rows } = expectationsFor(second.id);
  assert.ok(keys.includes("run_volume_adherence"), "volume-adherence still emitted");
  assert.ok(keys.includes("recovery_rhr_delta"), `recovery guard emitted on the raise (got: ${keys.join(", ")})`);
  // The guard is falsifiable: resting-HR delta expected to stay at or below +3 bpm.
  const guard = rows.find((r) => r.metric_key === "recovery_rhr_delta");
  assert.equal(JSON.parse(guard.target_json).max, 3);
  const baseline = JSON.parse(guard.baseline_json);
  assert.ok(baseline.new_weekly_km > baseline.prior_weekly_km, "the guard records the raise it is checking");
});

test("a run plan that holds or reduces weekly km emits no recovery guard", () => {
  asRunner();
  assert.equal(repo.applyProposal(cardioProposal(13, 19).id).ok, true); // prior ~32 km
  const second = cardioProposal(12, 16); // ~28 km — a reduction
  assert.equal(repo.applyProposal(second.id).ok, true);
  const { keys } = expectationsFor(second.id);
  assert.ok(keys.includes("run_volume_adherence"));
  assert.ok(!keys.includes("recovery_rhr_delta"), "no recovery guard when volume is held or reduced");
});

test("a MIXED strength+run proposal earns BOTH the exercise and the run_volume_adherence expectations", () => {
  asRunner();
  // A plan day with a strength lift the proposal will retune, plus a run it prescribes.
  repo.savePlanDay(1, "Full body", "Strength", [
    { exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const mixed = repo.createProposal("auto", "mixed strength + run", "", {
    summary: "one proposal, two domains",
    changes: [{ day_number: 1, exercise: "Goblet Squat", sets: 4, rep_low: 8, rep_high: 10, target_weight: 45 }],
    cardio: [
      {
        day_number: 3,
        label: "Easy run",
        target_distance_km: 8,
        target_zone: "Z2 (135-145 bpm)",
        day_name: "Easy run",
        focus: "Endurance",
      },
    ],
  });
  const result = repo.applyProposal(mixed.id);
  assert.equal(result.ok, true);
  const { keys } = expectationsFor(mixed.id);
  assert.ok(keys.includes("exercise_target_completion"), `exercise expectation emitted (got: ${keys.join(", ")})`);
  assert.ok(keys.includes("run_volume_adherence"), `run expectation emitted alongside it (got: ${keys.join(", ")})`);
});

test("a duration-only run plan (no prescribed km) falls back to plan_day_adherence, not run_volume_adherence", () => {
  asRunner();
  const plan = repo.createProposal("auto-run-plan", "run plan", "", {
    summary: "duration-only runs",
    cardio: [
      { day_number: 2, label: "Easy run", target_duration_min: 40, day_name: "Easy run", focus: "Endurance" },
      { day_number: 6, label: "Long run", target_duration_min: 70, day_name: "Long run", focus: "Endurance · long" },
    ],
  });
  assert.equal(repo.applyProposal(plan.id).ok, true);
  const { keys } = expectationsFor(plan.id);
  assert.ok(!keys.includes("run_volume_adherence"), "no volume-adherence without a prescribed distance");
  assert.ok(keys.includes("plan_day_adherence"), `falls back to the generic adherence proxy (got: ${keys.join(", ")})`);
});
