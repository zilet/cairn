// The composition seams (weekly dose, pairing, movement region, stress budget) are
// wired into normalizeComposedSession and buildDailySessionDecision as identity stubs
// first. This file pins that wiring to the pre-seam output: an ordinary day composes
// BYTE-FOR-BYTE as it did before the seams existed (golden captured on 948636f8), and
// an ordinary morning's snapshot and envelope carry none of the new optional keys, so
// every stored input_fingerprint stays valid. When a seam starts doing real work, the
// days it touches get their own tests; this golden stays an ordinary day.
//
// One deliberate exception: antagonist pairing (composition-pairing.ts) is ordinary-day
// behavior, and these fixtures ARE the Upper & Arms / Lower A cards it exists for. So the
// golden carries exactly its output and nothing else — `superset_group` on the bench +
// row, curl + pushdown and leg curl + leg extension, and one pairing hint appended to each
// pair's first `note`. Order, positions, loads, sets and reps are the pre-seam bytes; the
// plan snapshot is untouched (test/compositionPairing.test.js owns the pairing rules).
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { gatherDailyDecisionSnapshot, buildDailySessionDecision } from "../dist/repo/daily-decision.js";
import { repo, resetTables, settlePlanPrescriptions } from "./_seed.js";

const DATE = "2031-07-01";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises"
  );
});

function envelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v7",
    input_fingerprint: "seam-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: DATE,
    kind: "train",
    baseline_kind: "train",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Upper & Arms", intent: "custom" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    recovery_cycle: null,
    candidates: [],
    hard_constraints: [],
    soft_preferences: [],
    rationale: [{ code: "template_rotation", text: "Training day." }],
    precedence: [],
    reach: { level: null, backed_by: [], why: "" },
    ...overrides,
  };
}

function seedUpperExercises() {
  repo.upsertExercise({ name: "Band Pull-Apart", muscle_group: "mobility", mode: "reps" });
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Incline Dumbbell Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.upsertExercise({ name: "Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  repo.upsertExercise({ name: "Farmer's Carry", muscle_group: "forearms", mode: "timed" });
  // Working history, so the agent's loads are grounded rather than cleared.
  for (const date of ["2031-06-17", "2031-06-24"]) {
    repo.logSetByName({ date, exercise: "Dumbbell Bench Press", weight: 55, reps: 10, day_number: null });
    repo.logSetByName({ date, exercise: "Incline Dumbbell Press", weight: 45, reps: 10, day_number: null });
    repo.logSetByName({ date, exercise: "Chest-Supported Row", weight: 85, reps: 10, day_number: null });
    repo.logSetByName({ date, exercise: "Barbell Curl", weight: 75, reps: 9, day_number: null });
    repo.logSetByName({ date, exercise: "Rope Pushdown", weight: 57.5, reps: 12, day_number: null });
    repo.logSetByName({ date, exercise: "Farmer's Carry", weight: 60, duration_sec: 40, day_number: null });
  }
}

function upperAgentSession() {
  return {
    name: "Upper & Arms",
    focus: "Upper & Arms",
    why: "Fits the envelope today.",
    est_minutes: 55,
    items: [
      { exercise: "Rope Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 57.5 },
      { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
      { exercise: "Barbell Curl", sets: 3, rep_low: 8, rep_high: 10, target_weight: 75 },
      { exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 85 },
      { exercise: "Incline Dumbbell Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 45 },
      { exercise: "Band Pull-Apart", sets: 2, rep_low: 15, rep_high: 15 },
      { exercise: "Farmer's Carry", sets: 2, mode: "timed", target_seconds: 40, target_weight: 60 },
    ],
  };
}

function upperCandidates() {
  return [
    {
      exercise: "Dumbbell Bench Press",
      muscle_group: "chest",
      action: "overload",
      reason_code: "progression_overload",
      substitution_for: null,
      note: null,
      authorized_target: {
        mode: "reps",
        sets: 3,
        rep_low: 8,
        rep_high: 10,
        target_weight: 60,
        target_seconds: null,
      },
    },
    {
      exercise: "Chest-Supported Row",
      muscle_group: "back",
      action: "hold",
      reason_code: "progression_hold",
      substitution_for: null,
      note: null,
      earned_floor: 90,
      progression_evidence: {
        delta_text: "hold 85",
        why: "Holding here while the reps settle.",
        reground: false,
        autoregulated: false,
        movement_response: null,
        rep_step: false,
        dose_eligibility: null,
      },
    },
    {
      exercise: "Rope Pushdown",
      muscle_group: "triceps",
      action: "hold",
      reason_code: "progression_hold",
      substitution_for: null,
      note: null,
    },
  ];
}

function seedLowerPlan() {
  repo.savePlanDay(1, "Lower A", "Squat and hinge", [
    { exercise: "Ankle Rocker", sets: 2, rep_low: 10, rep_high: 10 },
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185, warmup_sets: 2 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 205 },
    { exercise: "Leg Extension", sets: 2, rep_low: 10, rep_high: 12, target_weight: 135 },
    { exercise: "Lying Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
    { exercise: "Standing Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 90 },
  ]);
  settlePlanPrescriptions();
}

function lowerEnvelope(overrides = {}) {
  return envelope({
    template: { day_number: 1, plan_day_id: 1, focus: "Squat and hinge", intent: "template" },
    candidates: [
      {
        exercise: "Back Squat",
        muscle_group: "quads",
        action: "overload",
        reason_code: "progression_overload",
        substitution_for: null,
        note: null,
        authorized_target: {
          mode: "reps",
          sets: 3,
          rep_low: 5,
          rep_high: 7,
          target_weight: 190,
          target_seconds: null,
        },
      },
      {
        exercise: "Lying Leg Curl",
        muscle_group: "hamstrings",
        action: "hold",
        reason_code: "progression_hold",
        substitution_for: null,
        note: null,
      },
    ],
    ...overrides,
  });
}

// Captured by running these exact fixtures against dist built from 948636f8 (before
// the seams), then frozen; the pairing fields above were added when pairing landed. Compared as serialized JSON text so key order and
// undefined-vs-absent count exactly as they would in a stored composition.
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/composition-seams-golden.json", import.meta.url), "utf8"));
const GOLDEN_UPPER_AGENT = GOLDEN.upper_agent;
const GOLDEN_LOWER_DETERMINISTIC = GOLDEN.lower_deterministic;
const GOLDEN_LOWER_REDUCED = GOLDEN.lower_reduced;
const GOLDEN_LOWER_SNAPSHOT = GOLDEN.lower_snapshot;

function assertGolden(actual, golden, label) {
  assert.equal(JSON.stringify(actual), JSON.stringify(golden), `${label} composes byte-for-byte as before the seams`);
}

test("an ordinary agent-authored upper day composes exactly as before the seams", () => {
  seedUpperExercises();
  const result = normalizeComposedSession(upperAgentSession(), envelope({ candidates: upperCandidates() }));
  assertGolden(result, GOLDEN_UPPER_AGENT, "upper_agent");
});

test("an ordinary plan-sourced lower day composes exactly as before the seams", () => {
  seedLowerPlan();
  assertGolden(deterministicComposedSession(lowerEnvelope()), GOLDEN_LOWER_DETERMINISTIC, "lower_deterministic");
});

test("a lower day with a reduced area composes exactly as before the seams", () => {
  seedLowerPlan();
  const env = lowerEnvelope({
    muscles: { required: [], allowed: [], reduced: ["hamstrings"], excluded: [], saturated: [], deep: [] },
  });
  assertGolden(deterministicComposedSession(env), GOLDEN_LOWER_REDUCED, "lower_reduced");
});

test("a plan snapshot of the lower day composes exactly as before the seams", () => {
  seedLowerPlan();
  assertGolden(
    deterministicComposedSession(lowerEnvelope(), { planSnapshot: true }),
    GOLDEN_LOWER_SNAPSHOT,
    "lower_snapshot"
  );
});

test("an ordinary morning's snapshot and envelope carry none of the seam keys", () => {
  seedLowerPlan();
  const snapshot = gatherDailyDecisionSnapshot(DATE);
  assert.equal("weekly_dose" in snapshot, false, "no weekly_dose key on an idle snapshot");
  assert.equal("stress_budget" in snapshot, false, "no stress_budget key on an idle snapshot");
  const env = buildDailySessionDecision(snapshot, { now: "2031-07-01T09:00:00.000Z" });
  assert.equal(env.input_fingerprint, GOLDEN.lower_fingerprint, "the stored fingerprint is unchanged");
  assert.equal("dose" in env, false, "no dose key on an idle envelope");
  assert.equal("stress" in env, false, "no stress key on an idle envelope");
  assert.equal(env.policy_version, "daily_decision_v7");
});
