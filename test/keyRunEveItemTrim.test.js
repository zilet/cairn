// The STANDING key-run eve on today's card (stress-budget.ts rule 3b → daily-decision.ts →
// daily-composition.ts via composition-eve.ts):
//   - ONE set off each lower accessory it names (`max(floor, sets − 1)`), never the
//     reduced-area cap's two-set clamp, load held;
//   - item-scoped: a leg curl loses its set while the RDL in the same group stays whole
//     (sets, load and progression);
//   - every trim recorded (`key_run_eve`, sets_from → sets_to) and said on the card;
//   - the in-build eve keeps its group-level two-set clamp exactly;
//   - a today-scoped request keeps its sets; the weekly heavy anchor guard is a reason.
// Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { STANDING_EVE_MIN_SETS, standingEveSetCap, standingEveTrimKeys } from "../dist/repo/composition-eve.js";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision, DAILY_DECISION_REASONS } from "../dist/repo/daily-decision.js";
import {
  KEY_RUN_EVE_ITEM_NOTES,
  KEY_RUN_EVE_STANDING_ITEM_NOTES,
  WEEKLY_HEAVY_ANCHOR_KEPT,
} from "../dist/repo/stress-budget.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { repo, resetTables } from "./_seed.js";

const NOW = "2026-10-01T12:00:00.000Z";
const DATE = "2026-09-30";

beforeEach(() => {
  resetTables("daily_session_decisions", "daily_session_compositions", "logged_sets", "sessions", "plan_items", "plan_days", "exercises", "profile");
});

const EXERCISES = [
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Extension", "quads"],
  ["Leg Curl", "hamstrings"],
  ["Standing Calf Raise", "calves"],
  ["Barbell Bench Press", "chest"],
];
// Logged working weights, so a held lift has its own anchor (a hold with none clears the load).
const WORKING = [
  ["Back Squat", 185, 6],
  ["Romanian Deadlift", 205, 7],
  ["Leg Extension", 135, 11],
  ["Leg Curl", 120, 11],
  ["Standing Calf Raise", 90, 11],
  ["Barbell Bench Press", 135, 6],
];
function seedExercises() {
  for (const [name, group] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  for (const date of ["2026-09-08", "2026-09-15"])
    for (const [exercise, weight, reps] of WORKING) repo.logSetByName({ date, exercise, weight, reps, day_number: null });
}
const planItem = (exercise, muscle_group) => ({ exercise, muscle_group, equipment: "barbell", mode: "reps", kind: "strength" });
const PLAN_ITEMS = EXERCISES.map(([name, group]) => planItem(name, group));
const raw = (sets = {}) => ({
  name: "Lower A",
  focus: "Lower A",
  why: "x",
  est_minutes: 60,
  items: [
    { exercise: "Back Squat", sets: sets["Back Squat"] ?? 4, rep_low: 5, rep_high: 7, target_weight: 185 },
    { exercise: "Romanian Deadlift", sets: sets["Romanian Deadlift"] ?? 4, rep_low: 6, rep_high: 8, target_weight: 205 },
    { exercise: "Leg Extension", sets: sets["Leg Extension"] ?? 4, rep_low: 10, rep_high: 12, target_weight: 135 },
    { exercise: "Leg Curl", sets: sets["Leg Curl"] ?? 4, rep_low: 10, rep_high: 12, target_weight: 120 },
    { exercise: "Standing Calf Raise", sets: sets["Standing Calf Raise"] ?? 1, rep_low: 10, rep_high: 12, target_weight: 90 },
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 7, target_weight: 135 },
  ],
});
const byName = (items, name) => items.find((i) => i.exercise === name && !i.top_set_of);

function snapshot({ stress, ...overrides } = {}) {
  return {
    date: DATE,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: { day_number: 3, focus: "Lower", plan_day_id: 30, day_type: "training", source: "adaptive", reason: null, due: [], over: [] },
    day_read: { kind: "train", focus: "Lower", est_minutes: 60, consecutive_training_days: 1, recovery_week: false, trained_today: false },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    recovery_cycle: null,
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: { mesocycle_phase: "accumulation", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    progression: [],
    plan_items: PLAN_ITEMS,
    training_intent: { endurance_role: "supporting", priorities: ["strength", "muscle", "endurance"], source: "explicit" },
    ...(stress ? { stress_budget: stress } : {}),
    ...overrides,
  };
}
const STANDING = { key_run: { kind: "quality", in_days: 1 } };
const IN_BUILD = { race_week_kind: "build", race_phase: "build", days_to_race: 40, key_run: { kind: "quality", in_days: 1 } };

test("the set rule: one set off, never under the floor", () => {
  assert.equal(STANDING_EVE_MIN_SETS, 1);
  assert.equal(standingEveSetCap(4), 3);
  assert.equal(standingEveSetCap(3), 2);
  assert.equal(standingEveSetCap(2), 1);
  assert.equal(standingEveSetCap(1), 1);
  assert.equal(standingEveTrimKeys(null), null);
  assert.equal(standingEveTrimKeys({ load_held: true }), null, "the in-build eve is group-level");
  assert.deepEqual([...standingEveTrimKeys({ load_held: true, scope: "standing", trim_exercises: ["Leg Curl"] })], ["leg curl"]);
});

test("standing eve: a four-set accessory loses ONE set at its load; the RDL beside the leg curl stays whole", () => {
  seedExercises();
  const env = buildDailySessionDecision(snapshot({ stress: STANDING }), { now: NOW });
  assert.equal(env.stress.scope, "standing");
  assert.deepEqual([...env.stress.trim_exercises].sort(), ["Leg Curl", "Leg Extension", "Standing Calf Raise"]);
  // The RDL is passed over in the decision too: no eve hold on its progression.
  assert.notEqual(env.candidates.find((c) => c.exercise === "Romanian Deadlift").reason_code, "key_run_eve");
  assert.equal(env.candidates.find((c) => c.exercise === "Leg Curl").reason_code, "key_run_eve");

  const { session, validation } = normalizeComposedSession(raw(), env);
  const items = session.items;
  for (const [name, weight] of [
    ["Leg Extension", 135],
    ["Leg Curl", 120],
  ]) {
    assert.equal(byName(items, name).sets, 3, `${name}: four sets, one off`);
    assert.equal(byName(items, name).target_weight, weight, `${name}: load held`);
    assert.ok(
      KEY_RUN_EVE_STANDING_ITEM_NOTES.some((line) => String(byName(items, name).note).includes(line)),
      `${name} says why: ${byName(items, name).note}`
    );
  }
  assert.equal(byName(items, "Standing Calf Raise").sets, 1, "a one-set accessory keeps its one set");
  for (const [name, sets, weight] of [
    ["Romanian Deadlift", 4, 205],
    ["Back Squat", 4, 185],
    ["Barbell Bench Press", 3, 135],
  ]) {
    assert.equal(byName(items, name).sets, sets, `${name} untouched`);
    assert.equal(byName(items, name).target_weight, weight, `${name} load untouched`);
  }
  // Every trim recorded, nothing else attributed to the eve.
  const trims = validation.rejected.filter((r) => r.reason === "key_run_eve");
  assert.deepEqual(
    trims.map((r) => [r.exercise, r.sets_from, r.sets_to]).sort(),
    [
      ["Leg Curl", 4, 3],
      ["Leg Extension", 4, 3],
    ]
  );
});

test("the in-build eve keeps its group-level two-set clamp, unrecorded, exactly as before", () => {
  seedExercises();
  const env = buildDailySessionDecision(snapshot({ stress: IN_BUILD }), { now: NOW });
  assert.equal(env.stress.code, "key_run_eve");
  assert.equal(env.stress.scope, undefined);
  assert.equal(env.stress.trim_exercises, undefined);
  const { session, validation } = normalizeComposedSession(raw(), env);
  for (const name of ["Leg Extension", "Leg Curl", "Romanian Deadlift"]) {
    assert.equal(byName(session.items, name).sets, 2, `${name}: the reduced-area cap`);
  }
  assert.equal(byName(session.items, "Back Squat").sets, 4, "the anchor keeps its session");
  assert.ok(KEY_RUN_EVE_ITEM_NOTES.some((line) => String(byName(session.items, "Leg Curl").note).includes(line)));
  assert.equal(validation.rejected.filter((r) => r.reason === "key_run_eve").length, 0);
});

test("a today-scoped request keeps its sets: the eve says nothing", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      stress: STANDING,
      request: {
        override: null,
        train_anyway: false,
        equipment: null,
        minutes: null,
        goal: null,
        same_day_request: { day_number: 3, exercises: ["leg curl"], decision_ids: [3] },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress, undefined);
  const { session } = normalizeComposedSession(raw(), env);
  assert.equal(byName(session.items, "Leg Curl").sets, 4);
  assert.equal(byName(session.items, "Leg Extension").sets, 4);
});

test("the weekly heavy anchor guard is a reason of its own on the decision", () => {
  assert.ok(DAILY_DECISION_REASONS.includes("weekly_heavy_anchor_kept"));
  assert.equal(WEEKLY_HEAVY_ANCHOR_KEPT, "weekly_heavy_anchor_kept");
  seedExercises();
  const env = buildDailySessionDecision(snapshot({ stress: { ...IN_BUILD, heavy_lower_last: true } }), { now: NOW });
  assert.equal(env.stress.code, "key_run_eve");
  assert.ok(env.precedence.includes("weekly_heavy_anchor_kept"));
  assert.ok(env.soft_preferences.some((p) => p.code === "weekly_heavy_anchor_kept" && /hamstrings/.test(p.detail)));
  assert.equal(env.stress.guard, "weekly_heavy_anchor_kept");
  assert.deepEqual(env.stress.guard_groups, ["hamstrings"]);
  assert.ok(!env.muscles.reduced.includes("hamstrings"));
  // Without the guard there is no such reason.
  const plain = buildDailySessionDecision(snapshot({ stress: IN_BUILD }), { now: NOW });
  assert.ok(!plain.precedence.includes("weekly_heavy_anchor_kept"));
  assert.equal(plain.stress.guard, undefined);
});

test("the standing item notes are plain words, numberless, grammar-clean", () => {
  assert.ok(KEY_RUN_EVE_STANDING_ITEM_NOTES.length >= 4);
  for (const line of KEY_RUN_EVE_STANDING_ITEM_NOTES) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.ok(!/\d/.test(line), line);
  }
});
