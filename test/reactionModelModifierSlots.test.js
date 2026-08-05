// Modifier SLOT allocation in whatWorksForYou() (src/repo/reaction-model.ts).
//
// The personal-response model declares five modifier targets, and each one is read by a
// different consumer. The modifier map used to be built by taking the four most recent
// learnings for the PROSE list and keeping whichever of those carried a modifier —
// four slots for five targets, off an already-truncated list. Whichever lever the
// athlete had learned about least recently lost its modifier silently: the consumer
// reading that target just saw no personal default, with nothing anywhere saying a
// learning had been dropped.
//
// These lock the fix: one slot per declared target, claimed before any second reading
// of the same target, with the prose list still capped at four.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { personalResponseModifierFor, whatWorksForYou } from "../dist/repo/reaction-model.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

// One learned family per declared modifier target, ordered NEWEST FIRST here and then
// staggered oldest-last below — so plan_complexity, the final entry, is exactly the
// learning the old four-slot cut used to drop.
const FAMILIES = [
  {
    target: "nutrition_step",
    kind: "nutrition_target",
    metric_key: "weight_trend_lb_wk",
    direction: "within_band",
    baseline: { value: -1.2, recomposition_stage: "mid_cut" },
    target_json: { min: -1, max: -0.2 },
    evaluator: "weight_trend",
    actual: { value: -0.5, weigh_ins: 8 },
  },
  {
    target: "training_progression_step",
    kind: "training_target",
    metric_key: "exercise_target_completion",
    subject_key: "Back Squat",
    direction: "complete",
    baseline: null,
    target_json: { exposures: 2 },
    evaluator: "exercise_completion",
    actual: { value: 1, completion_rate: 1, exposures: 4 },
  },
  {
    target: "run_volume_step",
    kind: "training_target",
    metric_key: "run_volume_adherence",
    direction: "complete",
    baseline: { weekly_prescribed_km: 30 },
    target_json: { rate: 0.8, expected_km: 120 },
    evaluator: "run_volume_adherence",
    actual: { value: 0.95, completion_rate: 0.95, outings: 9 },
  },
  {
    target: "recovery_adjustment",
    kind: "recovery_adjustment",
    metric_key: "recovery_hrv_delta",
    direction: "at_least",
    baseline: { hrv_avg_ms: 60, nights: 10 },
    target_json: { value: -6 },
    evaluator: "recovery_delta",
    actual: { value: -1, nights: 10 },
  },
  {
    target: "plan_complexity",
    kind: "training_structure",
    metric_key: "plan_day_adherence",
    direction: "complete",
    baseline: null,
    target_json: { rate: 0.75, planned_sessions: 16 },
    evaluator: "plan_adherence",
    actual: { value: 0.9, completion_rate: 0.9, sessions: 12 },
  },
];

// Two comparable aligned outcomes for one family — the minimum that earns a learning —
// with both evaluations dated `daysAgo` so the families can be ordered against each
// other by recency.
function seedFamily(family, daysAgo) {
  for (const key of ["a", "b"]) {
    const recorded = recordDecision(
      {
        effective_date: "2026-01-01",
        kind: family.kind,
        domain: "training",
        summary: `${family.metric_key} ${key}.`,
        rationale: "A bounded change, measured before the default moves again.",
        source: "test",
        source_ref_type: null,
        source_ref_key: null,
        status: "applied",
        autonomy_tier: "quiet_apply",
        risk_class: "low",
        reversible: true,
        input_fingerprint: null,
        context: {},
        // Part of the decision fingerprint, so it has to be unique per seeded decision —
        // two identical fingerprints are folded into one row by design.
        action: { slot: `${family.slot_prefix ?? family.metric_key}-${key}` },
        specialist: null,
        applied_at: "2026-01-01T12:00:00.000Z",
        reverted_at: null,
        superseded_by: null,
        evaluator_version: "slot-test-v1",
      },
      [
        {
          metric_key: family.metric_key,
          subject_key: family.subject_key ?? null,
          direction: family.direction,
          baseline: family.baseline,
          target: family.target_json,
          window_start: "2026-01-01",
          window_end: "2026-01-29",
          minimum_data: null,
          confounder_policy: "standard",
          confidence: "tentative",
          evaluator: family.evaluator,
          evaluator_version: "slot-test-v1",
        },
      ]
    );
    const evaluation = insertBrainEvaluation({
      expectation_id: recorded.expectations[0].id,
      verdict: "aligned",
      actual: family.actual,
      evidence_keys: [`${family.metric_key}:2026-01-01..2026-01-29:n=8`],
      confounders: [],
      explanation: "The observed result landed within the expectation.",
      evaluator_version: "slot-test-v1",
    });
    // evaluated_at is a DB default, so recency has to be stamped directly.
    db.prepare(`UPDATE brain_evaluations SET evaluated_at = ? WHERE id = ?`).run(
      `${addDaysISO(localDateISO(), -daysAgo)} 12:00:00`,
      evaluation.id
    );
  }
}

function seedAllFamilies() {
  FAMILIES.forEach((family, index) => seedFamily(family, index * 10));
}

test("every declared modifier target keeps its slot, however long ago it was learned", () => {
  seedAllFamilies();
  const learned = whatWorksForYou();
  assert.ok(learned);

  const targets = learned.modifiers.map((modifier) => modifier.target);
  for (const family of FAMILIES) {
    assert.ok(
      targets.includes(family.target),
      `${family.target} kept its modifier (got: ${targets.join(", ") || "none"})`
    );
  }
  assert.equal(new Set(targets).size, FAMILIES.length, "one slot each, no target claimed twice");
});

test("the least recently learned target is the one the old four-slot cut dropped", () => {
  seedAllFamilies();
  // plan_complexity is the oldest learning of the five, so it is the exact case the
  // previous `slice(0, 4)` lost — and the one its consumer would have silently read as
  // "no personal default".
  const modifier = personalResponseModifierFor("plan_complexity");
  assert.ok(modifier, "the consumer-facing lookup resolves");
  assert.equal(modifier.target, "plan_complexity");
});

test("the prose list stays capped at four even though every target keeps a modifier", () => {
  seedAllFamilies();
  const learned = whatWorksForYou();
  const applied = learned.learnings.filter((item) => item.metric_key !== "day_read_adherence");
  assert.equal(applied.length, 4, "the athlete-facing list is still calm");
  assert.equal(learned.modifiers.length, 5, "…while the machine-facing map is complete");
});

test("a second reading of the same target never costs another target its slot", () => {
  seedAllFamilies();
  // A staged nutrition variant: the same target, a different recomposition phase, so
  // personalResponseModifierFor treats it as a separate answer rather than a duplicate.
  seedFamily(
    { ...FAMILIES[0], baseline: { value: -0.6, recomposition_stage: "lean_gain" }, slot_prefix: "weight_lean_gain" },
    1
  );

  const learned = whatWorksForYou();
  const targets = learned.modifiers.map((modifier) => modifier.target);
  for (const family of FAMILIES) {
    assert.ok(targets.includes(family.target), `${family.target} survives a same-target variant`);
  }
  const stages = learned.modifiers
    .filter((modifier) => modifier.target === "nutrition_step")
    .map((modifier) => modifier.stage);
  assert.deepEqual(new Set(stages), new Set(["mid_cut", "lean_gain"]), "both phases are answerable");
  assert.equal(
    personalResponseModifierFor("nutrition_step", { stage: "lean_gain" })?.stage,
    "lean_gain",
    "the stage-specific lookup finds its own variant"
  );
});

// ---------------------------------------------------------------------------
// SUBJECT slots: one per main lift, not four for the whole program.
//
// The subject headroom was 4. A normal week runs four training days built on two
// main lifts each, plus the one whole-athlete reading with no subject at all that
// every lift without a learning of its own falls back to — so a lifter with five
// or more main lifts silently lost the rest. The progression ladder asked for that
// lift's personal response, found nothing, and used the universal default while
// the ledger held a perfectly good verdict about it. Nothing said so; that silence
// is the other half of this fix.
const MAIN_LIFTS = [
  "Back Squat",
  "Barbell Bench Press",
  "Deadlift",
  "Overhead Press",
  "Barbell Row",
  "Front Squat",
  "Incline Bench Press",
  "Romanian Deadlift",
];

function seedLiftFamily(exercise, daysAgo) {
  seedFamily(
    {
      target: "training_progression_step",
      kind: "training_target",
      metric_key: "exercise_target_completion",
      subject_key: exercise,
      direction: "complete",
      baseline: null,
      target_json: { exposures: 2 },
      evaluator: "exercise_completion",
      actual: { value: 1, completion_rate: 1, exposures: 4 },
      slot_prefix: `lift-${exercise.replace(/\s+/g, "-")}`,
    },
    daysAgo
  );
}

test("every main lift in a normal program keeps its own learned response", () => {
  MAIN_LIFTS.forEach((exercise, index) => seedLiftFamily(exercise, index * 3));
  const learned = whatWorksForYou();
  assert.ok(learned);

  const subjects = learned.modifiers
    .filter((modifier) => modifier.target === "training_progression_step")
    .map((modifier) => modifier.subject_key);
  for (const exercise of MAIN_LIFTS) {
    assert.ok(subjects.includes(exercise), `${exercise} kept its learning (got: ${subjects.join(", ") || "none"})`);
  }
});

test("the whole-athlete reading survives alongside a full slate of per-lift ones", () => {
  MAIN_LIFTS.forEach((exercise, index) => seedLiftFamily(exercise, index * 3));
  // A subject-less training learning — the fallback every lift without one of its
  // own depends on. Deliberately the OLDEST, so recency alone would drop it.
  seedFamily(
    {
      target: "training_progression_step",
      kind: "training_target",
      metric_key: "exercise_est_1rm_trend",
      subject_key: null,
      direction: "at_least",
      baseline: { est_1rm: 200 },
      target_json: { value: 194 },
      evaluator: "exercise_est_1rm",
      actual: { value: 205, exposures: 5 },
      slot_prefix: "whole-athlete",
    },
    60
  );

  const learned = whatWorksForYou();
  const training = learned.modifiers.filter((modifier) => modifier.target === "training_progression_step");
  assert.ok(
    training.some((modifier) => modifier.subject_key == null),
    "the fallback reading is not crowded out by the lifts that have their own"
  );
});

test("a subject that does not fit is logged, never dropped in silence", () => {
  // Well past the headroom, so the cap is genuinely the binding constraint.
  const many = Array.from({ length: 14 }, (_, index) => `Accessory Lift ${index + 1}`);
  many.forEach((exercise, index) => seedLiftFamily(exercise, index * 2));

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    whatWorksForYou();
  } finally {
    console.warn = original;
  }
  const notice = warnings.find((line) => line.includes("personal-response slots full"));
  assert.ok(notice, `the drop is announced (got ${JSON.stringify(warnings)})`);
  assert.match(notice, /training_progression_step/, "the slot that lost out is named");
  assert.match(notice, /universal default stands/, "and what the athlete gets instead is said plainly");
});
