import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { recentAppliedRotations, upcomingBrainDecisions } from "../dist/repo/brain-decisions.js";

function decision(overrides = {}) {
  return {
    effective_date: "2026-07-13",
    kind: "training_structure",
    domain: "training",
    summary: "Recovery week — volume halves, same movements.",
    rationale: null,
    source: "autonomy",
    source_ref_type: "plan_proposal",
    source_ref_key: "7",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { proposal_id: 7 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
    ...overrides,
  };
}

test("upcomingBrainDecisions returns announced + quiet-pending inside the forward window, sorted by date", () => {
  recordDecision(decision({ effective_date: "2026-07-15", summary: "later announce" }));
  recordDecision(decision({ effective_date: "2026-07-11", summary: "sooner announce" }));
  recordDecision(
    decision({
      effective_date: "2026-07-12",
      status: "pending",
      autonomy_tier: "quiet_apply",
      kind: "training_target",
      risk_class: "low",
      summary: "quiet pending change",
    })
  );
  // Excluded: pending but ask-tier, past effective_date, beyond the window.
  recordDecision(
    decision({ effective_date: "2026-07-12", status: "pending", autonomy_tier: "ask", summary: "ask pending" })
  );
  recordDecision(decision({ effective_date: "2026-07-09", summary: "already landed" }));
  recordDecision(decision({ effective_date: "2026-08-30", summary: "far future" }));

  const upcoming = upcomingBrainDecisions(10, "2026-07-10");
  assert.deepEqual(
    upcoming.map((d) => d.summary),
    ["sooner announce", "quiet pending change", "later announce"]
  );
  assert.equal(upcoming[0].effective_date, "2026-07-11");
  assert.ok(upcoming.every((d) => d.domain === "training"));
});

test("recentAppliedRotations reads structured action.swaps and legacy instruction text", () => {
  recordDecision(
    decision({
      status: "applied",
      kind: "exercise_rotation",
      autonomy_tier: "ask",
      effective_date: "2026-07-10",
      applied_at: "2026-07-10T12:00:00.000Z",
      summary: "Rotate DB Bench Press → Incline Bench Press on day 2",
      action: { proposal_id: 9, swaps: [{ day_number: 2, from: "DB Bench Press", to: "Incline Bench Press" }] },
    })
  );
  recordDecision(
    decision({
      status: "applied",
      kind: "training_target",
      autonomy_tier: "ask",
      risk_class: "low",
      effective_date: "2026-07-08",
      applied_at: "2026-07-08T09:00:00.000Z",
      summary: "legacy swap decision",
      context: { instruction: "swap Barbell Bench Press -> DB Bench Press" },
      action: { proposal_id: 4 },
    })
  );
  // Excluded: outside the window, and a non-swap applied decision.
  recordDecision(
    decision({
      status: "applied",
      kind: "training_target",
      autonomy_tier: "ask",
      effective_date: "2026-05-01",
      applied_at: "2026-05-01T09:00:00.000Z",
      summary: "old swap",
      context: { instruction: "swap Old Lift -> New Lift" },
      action: { proposal_id: 2 },
    })
  );
  recordDecision(
    decision({
      status: "applied",
      kind: "training_target",
      autonomy_tier: "ask",
      effective_date: "2026-07-09",
      applied_at: "2026-07-09T09:00:00.000Z",
      summary: "plain target bump",
      context: { instruction: "weekly auto-evolution" },
      action: { proposal_id: 5 },
    })
  );

  const rotations = recentAppliedRotations(21, "2026-07-10");
  assert.deepEqual(
    rotations.map((r) => `${r.from} -> ${r.to}`).sort(),
    ["Barbell Bench Press -> DB Bench Press", "DB Bench Press -> Incline Bench Press"]
  );
  const structured = rotations.find((r) => r.to === "Incline Bench Press");
  assert.equal(structured.date, "2026-07-10");
});
