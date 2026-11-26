// The plateau ladder's `set_quality` lever on today's card (composition-set-quality.ts,
// taken by normalizeComposedSession as a PRE-COMPUTED `setQuality` input):
//   - one short plain-words note on the plan lift's item, never a load or set change;
//   - at most one such note a session;
//   - never on an easy/rest read or an eased day, on a lift the stress budget trimmed,
//     on a lift held for pain, or on a day joint pain was reported;
//   - the ladder → input mapping keeps only the `set_quality` units' plan lifts.
// Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  SET_QUALITY_NOTES,
  SET_QUALITY_NOTES_PER_SESSION,
  setQualityLiftsFromLadder,
  setQualityNoteFor,
} from "../dist/repo/composition-set-quality.js";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision } from "../dist/repo/daily-decision.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { normalizedExerciseKey } from "../dist/repo/exercise-canon.js";
import { repo, resetTables } from "./_seed.js";

const NOW = "2026-10-01T12:00:00.000Z";
const DATE = "2026-09-30";

beforeEach(() => {
  resetTables("daily_session_decisions", "daily_session_compositions", "logged_sets", "sessions", "plan_items", "plan_days", "exercises", "profile");
});

const EXERCISES = [
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Curl", "hamstrings"],
  ["Barbell Bench Press", "chest"],
];
const seed = () => {
  for (const [name, group] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
};
const planItem = (exercise, muscle_group) => ({ exercise, muscle_group, equipment: "barbell", mode: "reps", kind: "strength" });
const RAW = () => ({
  name: "Lower",
  focus: "Lower",
  why: "x",
  est_minutes: 50,
  items: [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 205 },
    { exercise: "Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 7, target_weight: 135 },
  ],
});
function envelope({ kind = "train", stress, ...overrides } = {}) {
  return buildDailySessionDecision(
    {
      date: DATE,
      request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
      plan: { day_number: 2, focus: "Lower", plan_day_id: 20, day_type: "training", source: "adaptive", reason: null, due: [], over: [] },
      day_read: { kind, focus: "Lower", est_minutes: 50, consecutive_training_days: 1, recovery_week: false, trained_today: false },
      recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
      recovery_cycle: null,
      muscle_load: [],
      endurance: [],
      checkin: null,
      feedback: null,
      constraints: { injuries: [], illness: false, travel: false },
      program: { mesocycle_phase: "accumulation", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
      progression: [],
      plan_items: EXERCISES.map(([name, group]) => planItem(name, group)),
      training_intent: { endurance_role: "supporting", priorities: ["strength", "muscle", "endurance"], source: "explicit" },
      ...(stress ? { stress_budget: stress } : {}),
      ...overrides,
    },
    { now: NOW }
  );
}
const keys = (...names) => new Set(names.map((n) => normalizedExerciseKey(n)));
const noted = (items) => items.filter((it) => SET_QUALITY_NOTES.some((line) => String(it.note ?? "").includes(line)));
const shape = (items) => items.map((it) => [it.exercise, it.sets, it.target_weight, it.rep_low, it.rep_high]);

test("a plain training day: one note on the plan lift's item, nothing else moves", () => {
  seed();
  const env = envelope();
  const plain = normalizeComposedSession(RAW(), env);
  const out = normalizeComposedSession(RAW(), envelope(), { setQuality: keys("Romanian Deadlift") });
  assert.deepEqual(shape(out.session.items), shape(plain.session.items), "never a load, set or rep change");
  assert.equal(out.validation.capped, plain.validation.capped, "a note is not a cap");
  assert.deepEqual(noted(out.session.items).map((it) => it.exercise), ["Romanian Deadlift"]);
  assert.equal(noted(plain.session.items).length, 0, "no input, no note");
});

test("at most one note a session, on the first eligible item in card order", () => {
  seed();
  assert.equal(SET_QUALITY_NOTES_PER_SESSION, 1);
  const lifts = keys("Barbell Bench Press", "Romanian Deadlift", "Leg Curl");
  const out = normalizeComposedSession(RAW(), envelope(), { setQuality: lifts });
  const hits = noted(out.session.items);
  assert.equal(hits.length, 1);
  const first = out.session.items.find((it) => lifts.has(normalizedExerciseKey(it.exercise)));
  assert.equal(hits[0], first, "the first named lift in card order");
  assert.notEqual(hits[0].exercise, "Leg Curl", "a compound leads the card");
});

test("never on an easy read", () => {
  seed();
  const out = normalizeComposedSession(RAW(), envelope({ kind: "easy" }), { setQuality: keys("Romanian Deadlift") });
  assert.equal(noted(out.session?.items ?? []).length, 0);
});

test("never on a lift the stress budget trimmed; a passed-over lift may still carry it", () => {
  seed();
  const env = envelope({ stress: { key_run: { kind: "quality", in_days: 1 } } });
  assert.deepEqual(env.stress.trim_exercises, ["Leg Curl"]);
  const trimmedOnly = normalizeComposedSession(RAW(), env, { setQuality: keys("Leg Curl") });
  assert.equal(noted(trimmedOnly.session.items).length, 0);
  const both = normalizeComposedSession(RAW(), envelope({ stress: { key_run: { kind: "quality", in_days: 1 } } }), {
    setQuality: keys("Leg Curl", "Romanian Deadlift"),
  });
  assert.deepEqual(noted(both.session.items).map((it) => it.exercise), ["Romanian Deadlift"]);
});

test("never for a lift held for pain, nor on a day joint pain was reported", () => {
  const items = [{ exercise: "Romanian Deadlift", sets: 3, target_weight: 205, note: null }];
  const base = {
    kind: "train",
    caps: { volume: "normal", intensity: "normal", duration_min: null },
    date: DATE,
    candidates: [{ exercise: "Romanian Deadlift", action: "hold", reason_code: "injury_recheck" }],
  };
  const lifts = keys("Romanian Deadlift");
  assert.equal(setQualityNoteFor(items, { envelope: base, lifts, reducedExercises: new Set() }), null);
  const clean = { ...base, candidates: [{ exercise: "Romanian Deadlift", action: "carry", reason_code: null }] };
  assert.ok(setQualityNoteFor(items, { envelope: clean, lifts, reducedExercises: new Set() }));
  assert.equal(
    setQualityNoteFor(items, { envelope: { ...clean, reported_joint_pain: "left knee" }, lifts, reducedExercises: new Set() }),
    null
  );
  assert.equal(
    setQualityNoteFor(items, {
      envelope: { ...clean, caps: { ...clean.caps, intensity: "hold" } },
      lifts,
      reducedExercises: new Set(),
    }),
    null,
    "an eased or held day is no day to push sets"
  );
});

test("the deterministic card takes the same input", () => {
  seed();
  repo.replacePlan([{ day_number: 2, name: "Lower", items: RAW().items }]);
  const env = envelope();
  const session = deterministicComposedSession(env, { setQuality: keys("Romanian Deadlift") });
  assert.deepEqual(noted(session.items).map((it) => it.exercise), ["Romanian Deadlift"]);
});

test("the ladder maps to its set_quality plan lifts only; an unavailable ladder maps to nothing", () => {
  const ladder = {
    available: true,
    date: DATE,
    block: null,
    units: [
      { unit_key: "hinge", lever: "set_quality", plan_lift: { exercise: "Romanian Deadlift" } },
      { unit_key: "squat", lever: "rep_scheme", plan_lift: { exercise: "Back Squat" } },
      { unit_key: "press", lever: "wait", plan_lift: { exercise: "Barbell Bench Press" } },
      { unit_key: "curl", lever: "set_quality", plan_lift: null },
    ],
  };
  assert.deepEqual([...setQualityLiftsFromLadder(ladder)], [normalizedExerciseKey("Romanian Deadlift")]);
  assert.equal(setQualityLiftsFromLadder({ ...ladder, available: false }).size, 0);
  assert.equal(setQualityLiftsFromLadder(null).size, 0);
});

test("the notes are plain words, numberless, grammar-clean", () => {
  assert.ok(SET_QUALITY_NOTES.length >= 4);
  for (const line of SET_QUALITY_NOTES) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.ok(!/\d/.test(line), line);
    assert.ok(!/\b(rir|failure|reps in reserve)\b/i.test(line), `plain words: ${line}`);
  }
});
