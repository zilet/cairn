// The week's stress budget for the legs (src/repo/stress-budget.ts): one budget across
// running and lifting for a hybrid athlete building to a dated half. Three rules, all
// speaking through the envelope's muscle lists:
//   1. taper week  -> the day's leg groups REDUCED (composition's 2-set cap, 0.9 load)
//   2. race week   -> quads/hamstrings/glutes EXCLUDED, calves/core reduced
//   3. key-run eve -> every lower item EXCEPT the day's anchor lift trimmed in sets (load
//      held); the anchor stays as written even beside an accessory in its own group;
//      never while the weekly lower guarantee holds, never under a lower safety floor
// Upper-body work holds throughout. Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { buildDailyCompositionPrompt } from "../dist/prompt.js";
import {
  buildDailySessionDecision,
  gatherDailyDecisionSnapshot,
  WEEKLY_LOWER_EXPOSURE_RATIONALE,
  WEEKLY_LOWER_HELD_RATIONALE,
} from "../dist/repo/daily-decision.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { substituteSaturatedPlanItems } from "../dist/repo/saturated-substitution.js";
import {
  KEY_RUN_EVE_RATIONALE,
  RACE_TAPER_LEGS_RATIONALE,
  RACE_WEEK_EXCLUDED_NOTES,
  RACE_WEEK_LEGS_RATIONALE,
  stressBudgetDecision,
  stressBudgetSnapshot,
  stressBudgetSuspendsWeeklyLower,
} from "../dist/repo/stress-budget.js";
import { repo, resetTables } from "./_seed.js";

const NOW = "2026-10-01T12:00:00.000Z";
const RACE = "2026-11-01"; // a Sunday: taper week 10-19, race week 10-26

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "daily_metrics",
    "checkins",
    "context_events",
    "plan_items",
    "plan_days",
    "program_blocks",
    "plan_proposals",
    "app_state",
    "exercises",
    "profile"
  );
});

// ---------------------------------------------------------------------------
// the week as the live athlete has it
// ---------------------------------------------------------------------------

const EXERCISES = [
  ["Barbell Bench Press", "chest"],
  ["Pendlay Row", "back"],
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Extension", "quads"],
  ["Leg Curl", "hamstrings"],
  ["Standing Calf Raise", "calves"],
  ["Dumbbell Bench Press", "chest"],
  ["Barbell Curl", "biceps"],
  ["Deadlift", "hamstrings"],
  ["Bulgarian Split Squat", "quads"],
  ["Seated Calf Raise", "calves"],
  ["Pallof Press", "core"],
];

const it = (exercise, sets, target_weight, rep_low = 6, rep_high = 8) => ({
  exercise,
  sets,
  rep_low,
  rep_high,
  target_weight,
});
const PLAN = [
  { day_number: 1, name: "Push", items: [it("Barbell Bench Press", 3, 135, 5, 7)] },
  { day_number: 2, name: "Pull", items: [it("Pendlay Row", 3, 150)] },
  {
    day_number: 3,
    name: "Lower A",
    items: [
      it("Back Squat", 3, 185, 5, 7),
      it("Romanian Deadlift", 3, 205),
      it("Leg Extension", 3, 135, 10, 12),
      it("Leg Curl", 3, 120, 10, 12),
      it("Standing Calf Raise", 3, 90, 10, 12),
    ],
  },
  {
    day_number: 4,
    name: "Upper & Arms",
    items: [it("Dumbbell Bench Press", 3, 55, 8, 10), it("Barbell Curl", 3, 75, 8, 10)],
  },
  {
    day_number: 5,
    name: "Lower B",
    items: [
      it("Deadlift", 3, 225, 3, 5),
      it("Bulgarian Split Squat", 3, 60, 8, 10),
      it("Seated Calf Raise", 3, 125, 10, 12),
      it("Pallof Press", 3, 45, 10, 12),
    ],
  },
];

const daysBefore = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

function seedAthlete({ race = true, role = "supporting" } = {}) {
  for (const [name, group] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  repo.replacePlan(PLAN);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: role },
    strength_schedule: { days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }], source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 6, kind: "long" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: race
      ? { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" }
      : null,
  });
}

// Six weeks of Tue / Thu / Sun running before `asOf`'s week, so the engine has a week to plan.
function seedRuns(asOf) {
  const monday = daysBefore(asOf, (new Date(`${asOf}T00:00:00Z`).getUTCDay() + 6) % 7);
  for (let wk = 1; wk <= 6; wk++) {
    const mon = daysBefore(monday, wk * 7);
    repo.addActivity({ type: "run", duration_min: 45, distance_km: 7, date: daysBefore(mon, -1) });
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: daysBefore(mon, -3) });
    repo.addActivity({ type: "run", duration_min: 95, distance_km: 15, date: daysBefore(mon, -6) });
  }
}

// ---------------------------------------------------------------------------
// decision-level snapshots (the pure half)
// ---------------------------------------------------------------------------

function snapshot({ date, planItems, stress, ...overrides }) {
  return {
    date,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 5,
      focus: "Lower",
      plan_day_id: 50,
      day_type: "training",
      source: "adaptive",
      reason: null,
      due: [],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Lower",
      est_minutes: 55,
      consecutive_training_days: 1,
      recovery_week: false,
      trained_today: false,
    },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    recovery_cycle: null,
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: { mesocycle_phase: "accumulation", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    progression: [],
    plan_items: planItems,
    training_intent: {
      endurance_role: "supporting",
      priorities: ["strength", "muscle", "endurance"],
      source: "explicit",
    },
    ...(stress ? { stress_budget: stress } : {}),
    ...overrides,
  };
}

const planItem = (exercise, muscle_group) => ({
  exercise,
  muscle_group,
  equipment: "barbell",
  mode: "reps",
  kind: "strength",
});
const LOWER_A_ITEMS = [
  planItem("Back Squat", "quads"),
  planItem("Romanian Deadlift", "hamstrings"),
  planItem("Leg Extension", "quads"),
  planItem("Leg Curl", "hamstrings"),
  planItem("Standing Calf Raise", "calves"),
  planItem("Barbell Bench Press", "chest"),
];
const LOWER_A_RAW = {
  name: "Lower A",
  focus: "Lower A",
  why: "x",
  est_minutes: 55,
  items: [
    it("Back Squat", 3, 185, 5, 7),
    it("Romanian Deadlift", 3, 205),
    it("Leg Extension", 3, 135, 10, 12),
    it("Standing Calf Raise", 3, 90, 10, 12),
    it("Barbell Bench Press", 3, 135, 5, 7),
  ],
};
const LOWER_B_ITEMS = [
  planItem("Deadlift", "hamstrings"),
  planItem("Bulgarian Split Squat", "quads"),
  planItem("Seated Calf Raise", "calves"),
  planItem("Pallof Press", "core"),
];
const LOWER_B_RAW = {
  name: "Lower B",
  focus: "Lower B",
  why: "x",
  est_minutes: 55,
  items: [
    it("Deadlift", 3, 225, 3, 5),
    it("Bulgarian Split Squat", 3, 60, 8, 10),
    it("Seated Calf Raise", 3, 125, 10, 12),
    it("Pallof Press", 3, 45, 10, 12),
  ],
};

// Working history at the plan's own loads, so composition grounds every target.
const WORKING = [
  ["Back Squat", 185, 6],
  ["Romanian Deadlift", 205, 7],
  ["Leg Extension", 135, 11],
  ["Standing Calf Raise", 90, 11],
  ["Barbell Bench Press", 135, 6],
  ["Deadlift", 225, 4],
  ["Bulgarian Split Squat", 60, 9],
  ["Seated Calf Raise", 125, 11],
  ["Pallof Press", 45, 11],
];
function seedExercises() {
  for (const [name, group] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  for (const date of ["2026-09-08", "2026-09-15"]) {
    for (const [exercise, weight, reps] of WORKING)
      repo.logSetByName({ date, exercise, weight, reps, day_number: null });
  }
}
const byName = (items, name) => items.find((i) => i.exercise === name);

// ---------- 1. taper week ----------

test("taper week (2026-10-21): the leg lifts cap at two sets and a lighter load; the bench is untouched", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-21",
      planItems: LOWER_A_ITEMS,
      stress: { race_week_kind: "taper", race_phase: "taper", days_to_race: 11 },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "race_taper_legs");
  assert.equal(env.stress.load_held, undefined, "the taper eases the load too");
  assert.deepEqual([...env.stress.groups].sort(), ["calves", "hamstrings", "quads"]);
  assert.ok(env.precedence.includes("race_taper_legs"));
  assert.ok(env.rationale.some((r) => r.code === "race_taper_legs" && RACE_TAPER_LEGS_RATIONALE.includes(r.text)));
  assert.equal(env.candidates.find((c) => c.exercise === "Back Squat").reason_code, "race_taper_legs");
  assert.ok(!env.muscles.reduced.includes("chest"));

  const items = normalizeComposedSession(LOWER_A_RAW, env).session.items;
  for (const [name, weight] of [
    ["Back Squat", 185],
    ["Romanian Deadlift", 205],
    ["Leg Extension", 135],
    ["Standing Calf Raise", 90],
  ]) {
    const item = byName(items, name);
    assert.equal(item.sets, 2, `${name}: the reduced-area cap`);
    assert.equal(item.target_weight, Math.round(weight * 0.9 * 100) / 100, `${name}: the reduced-area load factor`);
  }
  const bench = byName(items, "Barbell Bench Press");
  assert.equal(bench.sets, 3);
  assert.equal(bench.target_weight, 135);
});

test("taper week stands the weekly lower guarantee down, so the read says one thing", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-21",
      planItems: LOWER_A_ITEMS,
      weekly_lower: { last_chance: true },
      stress: { race_week_kind: "taper", race_phase: "taper", days_to_race: 11 },
    }),
    { now: NOW }
  );
  assert.ok(!env.precedence.includes("weekly_lower_exposure"));
  assert.equal(env.muscles.week_held, undefined);
  for (const r of env.rationale) {
    assert.ok(!WEEKLY_LOWER_EXPOSURE_RATIONALE.includes(r.text), r.text);
    assert.ok(!WEEKLY_LOWER_HELD_RATIONALE.includes(r.text), r.text);
    assert.ok(!/keeps? (its|every|their) sets/i.test(r.text), r.text);
  }
  assert.ok(env.muscles.reduced.includes("quads"));
  assert.equal(stressBudgetSuspendsWeeklyLower({ race_week_kind: "taper" }), true);
  assert.equal(stressBudgetSuspendsWeeklyLower({ race_week_kind: "race" }), true);
  assert.equal(
    stressBudgetSuspendsWeeklyLower({ race_week_kind: "build", key_run: { kind: "long", in_days: 1 } }),
    false
  );
  assert.equal(stressBudgetSuspendsWeeklyLower(undefined), false);
});

// ---------- 2. race week ----------

test("race week (2026-10-28): the squat sits out, calves stay light, the upper body holds", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-28",
      planItems: LOWER_A_ITEMS,
      weekly_lower: { last_chance: true },
      stress: { race_week_kind: "race", race_phase: "taper", days_to_race: 4 },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "race_week_legs");
  assert.equal(env.stress.load_held, undefined);
  assert.deepEqual([...env.muscles.excluded].sort(), ["hamstrings", "quads"]);
  assert.ok(env.muscles.reduced.includes("calves"));
  assert.ok(!env.muscles.reduced.includes("chest") && !env.muscles.excluded.includes("chest"));
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "exclude");
  assert.equal(squat.reason_code, "race_week_legs");
  assert.ok(RACE_WEEK_EXCLUDED_NOTES.includes(squat.note), squat.note);
  assert.ok(!env.hard_constraints.some((h) => h.code === "injury_exclusion"));
  assert.ok(env.rationale.some((r) => r.code === "race_week_legs" && RACE_WEEK_LEGS_RATIONALE.includes(r.text)));
  assert.ok(!env.precedence.includes("weekly_lower_exposure"));

  const items = normalizeComposedSession(LOWER_A_RAW, env).session.items;
  assert.equal(byName(items, "Back Squat"), undefined, "the squat is off the card");
  assert.equal(byName(items, "Romanian Deadlift"), undefined);
  assert.equal(byName(items, "Standing Calf Raise").sets, 2);
  const bench = byName(items, "Barbell Bench Press");
  assert.equal(bench.sets, 3);
  assert.equal(bench.target_weight, 135);
});

test("race week on a core-only upper card lightens the core and nothing else", () => {
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-29",
      planItems: [planItem("Barbell Bench Press", "chest"), planItem("Pallof Press", "core")],
      stress: { race_week_kind: "race", race_phase: "taper", days_to_race: 3 },
    }),
    { now: NOW }
  );
  assert.deepEqual(env.muscles.reduced, ["core"]);
  assert.deepEqual(env.muscles.excluded, []);
});

// ---------- 3. the eve of a key run ----------

test("the Wednesday before Thursday's quality run with the week's legs still owed: no trim", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      weekly_lower: { last_chance: false },
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 32,
        key_run: { kind: "quality", in_days: 1 },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress, undefined);
  assert.ok(!env.precedence.includes("key_run_eve"));
  assert.ok(env.precedence.includes("weekly_lower_exposure"));
  for (const g of ["quads", "hamstrings", "calves"]) assert.ok(!env.muscles.reduced.includes(g), g);
  const items = normalizeComposedSession(LOWER_A_RAW, env).session.items;
  assert.equal(byName(items, "Romanian Deadlift").sets, 3);
});

test("Friday before Sunday's long run, the week's legs already landed: accessories lighter, the deadlift untouched", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-02",
      planItems: LOWER_B_ITEMS,
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 30,
        key_run: { kind: "long", in_days: 2 },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "key_run_eve");
  assert.deepEqual([...env.stress.groups].sort(), ["calves", "quads"]);
  assert.ok(!env.muscles.reduced.includes("hamstrings"), "the anchor's group is never reduced");
  assert.ok(!env.muscles.reduced.includes("core"));
  const eve = env.rationale.find((r) => r.code === "key_run_eve");
  assert.ok(eve && /long run/.test(eve.text) && /in two days/.test(eve.text), eve?.text);
  assert.equal(env.candidates.find((c) => c.exercise === "Bulgarian Split Squat").reason_code, "key_run_eve");
  assert.notEqual(env.candidates.find((c) => c.exercise === "Deadlift").reason_code, "key_run_eve");

  const items = normalizeComposedSession(LOWER_B_RAW, env).session.items;
  // Sets only: the split squat is trained at its prescribed load, one set short.
  assert.equal(env.stress.load_held, true);
  assert.deepEqual([...env.stress.sole_reduced].sort(), ["calves", "quads"]);
  const bss = byName(items, "Bulgarian Split Squat");
  assert.equal(bss.sets, 2);
  assert.equal(bss.target_weight, 60, "the load holds on the eve of a key run");
  assert.ok(!bss.reach && !bss.top_set, "a trimmed slot never hosts the reach");
  const calf = byName(items, "Seated Calf Raise");
  assert.equal(calf.sets, 2);
  assert.equal(calf.target_weight, 125);
  const deadlift = byName(items, "Deadlift");
  assert.equal(deadlift.sets, 3);
  assert.equal(deadlift.target_weight, 225);
  assert.equal(byName(items, "Pallof Press").sets, 3);
});

test("Lower A the day before Thursday's quality run: the squat as written; RDL, leg extension, leg curl and calf trimmed at their loads", () => {
  seedExercises();
  for (const date of ["2026-09-08", "2026-09-15"]) repo.logSetByName({ date, exercise: "Leg Curl", weight: 120, reps: 11 });
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 32,
        key_run: { kind: "quality", in_days: 1 },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "key_run_eve");
  assert.equal(env.stress.load_held, true);
  assert.equal(env.stress.hold_exercise, "Back Squat", "the anchor is named, not its group");
  assert.deepEqual([...env.stress.sole_reduced].sort(), ["calves", "hamstrings", "quads"]);
  assert.ok(!env.muscles.reduced.includes("chest"), "upper work is untouched");
  assert.notEqual(env.candidates.find((c) => c.exercise === "Back Squat").action, "hold");
  for (const name of ["Romanian Deadlift", "Leg Extension", "Leg Curl", "Standing Calf Raise"]) {
    assert.equal(env.candidates.find((c) => c.exercise === name).reason_code, "key_run_eve", name);
  }

  const raw = {
    ...LOWER_A_RAW,
    items: [
      it("Back Squat", 3, 185, 5, 7),
      it("Romanian Deadlift", 3, 205),
      it("Leg Extension", 3, 135, 10, 12),
      it("Leg Curl", 3, 120, 10, 12),
      it("Standing Calf Raise", 3, 90, 10, 12),
      it("Barbell Bench Press", 3, 135, 5, 7),
    ],
  };
  const items = normalizeComposedSession(raw, env).session.items;
  const squat = byName(items.filter((i) => !i.top_set_of), "Back Squat");
  assert.equal(squat.sets, 3, "the anchor keeps every set");
  assert.equal(squat.target_weight, 185, "and its load");
  for (const [name, weight] of [
    ["Romanian Deadlift", 205],
    ["Leg Extension", 135],
    ["Leg Curl", 120],
    ["Standing Calf Raise", 90],
  ]) {
    const item = byName(items, name);
    assert.equal(item.sets, 2, `${name}: two sets`);
    assert.equal(item.target_weight, weight, `${name}: the load holds`);
  }
  assert.equal(byName(items, "Barbell Bench Press").sets, 3);
});

test("an agent composing the eve is told fewer sets at the same weight, and which lift stays as written", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      program: {
        mesocycle_phase: "accumulation",
        adaptations_due: [],
        volume_low_groups: [],
        volume_high_groups: ["chest"],
      },
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 32,
        key_run: { kind: "quality", in_days: 1 },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.hold_exercise, "Back Squat");
  const prompt = buildDailyCompositionPrompt(env);
  const reduceLine = prompt.split("\n").find((line) => line.startsWith("- REDUCE"));
  assert.ok(reduceLine, prompt);
  // The volume read's chest is still an ordinary reduce; the eve's leg areas are not.
  assert.match(reduceLine, /chest/);
  assert.doesNotMatch(reduceLine, /quads|hamstrings|calves/, reduceLine);
  const eveLine = prompt.split("\n").find((line) => /same weight/i.test(line));
  assert.ok(eveLine, "the eve's areas get their own instruction");
  for (const g of ["quads", "hamstrings", "calves"]) assert.match(eveLine, new RegExp(g));
  assert.doesNotMatch(eveLine, /easier target/);
  assert.match(eveLine, /Back Squat[^.]*as written/);

  // An ordinary reduce reads as it always has.
  const plain = buildDailyCompositionPrompt({ ...env, stress: undefined });
  assert.match(plain, /- REDUCE[^\n]*quads[^\n]*an easier target/);
  assert.doesNotMatch(plain, /same weight/i);
});

test("a key-run eve anchor whose group another rule reduces takes that rule's clamp", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      program: {
        mesocycle_phase: "accumulation",
        adaptations_due: [],
        volume_low_groups: [],
        volume_high_groups: ["quads"],
      },
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 32,
        key_run: { kind: "quality", in_days: 1 },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "key_run_eve");
  assert.equal(env.stress.hold_exercise, undefined, "quads are not the eve's alone");
  const items = normalizeComposedSession(LOWER_A_RAW, env).session.items;
  const squat = byName(items, "Back Squat");
  assert.equal(squat.sets, 2, "the volume read clamps the squat as it always has");
  assert.equal(squat.target_weight, 166.5);
});

test("an eve-only group is trimmed in place, never swapped, on a morning a run also loaded another group", () => {
  seedExercises();
  repo.replacePlan(PLAN);
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-02",
      planItems: LOWER_B_ITEMS,
      muscle_load: [{ group: "calves", days_ago: 1, saturated: true, source: "endurance", deep: true }],
      endurance: [{ type: "run", days_ago: 1, intensity: "hard", load: "heavy", regions: ["calves"] }],
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 30,
        key_run: { kind: "long", in_days: 2 },
      },
    }),
    { now: NOW }
  );
  assert.ok(env.precedence.includes("endurance_lower_conflict"), "the run reduced the calves");
  assert.equal(env.stress.code, "key_run_eve");
  assert.deepEqual(env.stress.sole_reduced, ["quads"], "the calves are the run's, the quads the eve's alone");
  const moved = substituteSaturatedPlanItems(LOWER_B_RAW, env);
  assert.ok(
    !moved.substitutions.some((sub) => sub.replaced === "Bulgarian Split Squat"),
    JSON.stringify(moved.substitutions)
  );
  const items = normalizeComposedSession(LOWER_B_RAW, env, { substituteSaturated: true }).session.items;
  const bss = byName(items, "Bulgarian Split Squat");
  assert.ok(bss, "the split squat stays on the card");
  assert.equal(bss.sets, 2);
  assert.equal(bss.target_weight, 60);
});

test("a group another rule also reduces takes the full clamp on a key-run eve", () => {
  seedExercises();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-02",
      planItems: LOWER_B_ITEMS,
      program: {
        mesocycle_phase: "accumulation",
        adaptations_due: [],
        volume_low_groups: [],
        volume_high_groups: ["quads"],
      },
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 30,
        key_run: { kind: "long", in_days: 2 },
      },
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "key_run_eve");
  assert.deepEqual(env.stress.sole_reduced, ["calves"], "quads are reduced by the volume read too");
  const items = normalizeComposedSession(LOWER_B_RAW, env).session.items;
  const bss = byName(items, "Bulgarian Split Squat");
  assert.equal(bss.sets, 2);
  assert.equal(bss.target_weight, 54);
  assert.equal(byName(items, "Seated Calf Raise").target_weight, 125);
});

test("a lower safety floor stands the key-run eve down", () => {
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-10-02",
      planItems: LOWER_B_ITEMS,
      recovery: { has_data: true, readiness: "low", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 30,
        key_run: { kind: "long", in_days: 2 },
      },
    }),
    { now: NOW }
  );
  assert.ok(!env.precedence.includes("key_run_eve"));
  assert.equal(env.stress, undefined);
});

test("an endurance-led athlete's own key-run protect speaks for the run; the eve adds no second line", () => {
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      training_intent: { endurance_role: "primary", priorities: ["endurance", "strength"], source: "explicit" },
      open_key_run: { intent_id: "q", kind: "quality", suggested_date: "2026-10-01" },
      stress: {
        race_week_kind: "build",
        race_phase: "sharpen",
        days_to_race: 32,
        key_run: { kind: "quality", in_days: 1 },
      },
    }),
    { now: NOW }
  );
  assert.ok(env.precedence.includes("endurance_lower_conflict"));
  assert.ok(!env.precedence.includes("key_run_eve"));
});

test("the eve never reduces a group the weekly guarantee holds, and the decision half is pure", () => {
  const snap = snapshot({ date: "2026-10-02", planItems: LOWER_B_ITEMS });
  const ctx = {
    date: "2026-10-02",
    kind: "train",
    baseKind: "train",
    trainAnyway: false,
    lowerWeekHolds: false,
    weekHeldGroups: new Set(["quads"]),
    lowerSafetyFloor: false,
    anchor: { exercise: "Deadlift", muscle_group: "hamstrings" },
    planItems: LOWER_B_ITEMS,
    injuryExcluded: [],
    enduranceRole: "supporting",
    snapshot: snap,
  };
  const sb = { race_week_kind: "build", race_phase: "build", days_to_race: 30, key_run: { kind: "long", in_days: 1 } };
  const out = stressBudgetDecision(sb, ctx);
  assert.deepEqual(out.reduced, ["calves"]);
  assert.equal(out.hold_exercise, undefined, "the deadlift's group has no other item to trim");
  assert.deepEqual(stressBudgetDecision(sb, ctx), out, "same inputs, same answer");
  assert.equal(stressBudgetDecision(sb, { ...ctx, lowerWeekHolds: true }).code, null);
  assert.equal(stressBudgetDecision(sb, { ...ctx, kind: "rest" }).code, null);
  assert.equal(stressBudgetDecision(sb, { ...ctx, enduranceRole: "none" }).code, null);
  assert.equal(stressBudgetDecision(undefined, ctx).code, null);
});

// ---------- the gather half, against a real week ----------

test("gather: taper and race week are read from the race build; an upper day says nothing", () => {
  seedAthlete();
  seedRuns("2026-10-21");
  assert.deepEqual(
    stressBudgetSnapshot("2026-10-21", { dayType: "training", planItems: PLAN[2].items, enduranceRole: "supporting" }),
    { race_week_kind: "taper", race_phase: "taper", days_to_race: 11 }
  );
  const raceWeek = stressBudgetSnapshot("2026-10-28", {
    dayType: "training",
    planItems: PLAN[2].items,
    enduranceRole: "supporting",
  });
  assert.equal(raceWeek.race_week_kind, "race");
  assert.equal(
    stressBudgetSnapshot("2026-10-29", { dayType: "training", planItems: PLAN[3].items, enduranceRole: "supporting" }),
    undefined,
    "Upper & Arms carries no leg or core work"
  );
});

test("gather: the Wednesday before a placed quality run and the Friday before a placed Sunday long run", () => {
  seedAthlete();
  seedRuns("2026-09-30");
  const wed = stressBudgetSnapshot("2026-09-30", {
    dayType: "training",
    planItems: PLAN[2].items,
    enduranceRole: "supporting",
  });
  assert.ok(wed, "a race build week");
  assert.ok(["build", "down", "peak"].includes(wed.race_week_kind), wed.race_week_kind);
  assert.deepEqual(wed.key_run, { kind: "quality", in_days: 1 });
  const fri = stressBudgetSnapshot("2026-10-02", {
    dayType: "training",
    planItems: PLAN[4].items,
    enduranceRole: "supporting",
  });
  assert.deepEqual(fri?.key_run, { kind: "long", in_days: 2 }, "Saturday lifts nothing; the placed long run is Sunday");
  assert.equal(
    stressBudgetSnapshot("2026-09-29", { dayType: "training", planItems: PLAN[2].items, enduranceRole: "supporting" }),
    undefined,
    "Tuesday: Wednesday lifts before Thursday's quality run"
  );
});

test("gather: the race read is memoized, and a change to the stored race is read at once", () => {
  seedAthlete();
  seedRuns("2026-09-30");
  const ctx = { dayType: "training", planItems: PLAN[2].items, enduranceRole: "supporting" };
  const first = stressBudgetSnapshot("2026-09-30", ctx);
  assert.deepEqual(first.key_run, { kind: "quality", in_days: 1 });
  const again = stressBudgetSnapshot("2026-09-30", ctx);
  assert.deepEqual(again, first, "the same inputs read the same");
  again.key_run.kind = "long";
  assert.equal(stressBudgetSnapshot("2026-09-30", ctx).key_run.kind, "quality", "a caller's copy is its own");
  // The race moves into this week's taper window: the next read says so, no stale hit.
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date: "2026-10-11", distance_km: 21.1, target: "sub-2:00" },
  });
  const moved = stressBudgetSnapshot("2026-09-30", ctx);
  assert.notDeepEqual(moved, first, JSON.stringify(moved));
  // And no race at all is nothing to say.
  repo.setProfile({ endurance_goal: null });
  assert.equal(stressBudgetSnapshot("2026-09-30", ctx), undefined);
});

test("gather end to end: Wednesday owes the week's legs, so Thursday's quality run trims nothing", () => {
  seedAthlete();
  seedRuns("2026-09-30");
  const snap = gatherDailyDecisionSnapshot("2026-09-30");
  assert.equal(snap.plan.day_number, 3, "Lower A");
  assert.deepEqual(snap.weekly_lower, { last_chance: false });
  assert.deepEqual(snap.stress_budget.key_run, { kind: "quality", in_days: 1 });
  // The seeded log carries a soft brake of its own (a lower safety floor); open the
  // morning so the guarantee itself is what is under test.
  const open = {
    ...snap,
    signal_support: { ...snap.signal_support, fresh_brake: false, training_directive: "proceed" },
    day_read: { ...snap.day_read, kind: "train" },
  };
  const env = buildDailySessionDecision(open, { now: NOW });
  assert.ok(env.precedence.includes("weekly_lower_exposure"));
  assert.ok(!env.precedence.includes("key_run_eve"));
  assert.equal("stress" in env, false);
  // Control: the same morning with the week's legs already landed does trim.
  const { weekly_lower: _owed, ...landed } = open;
  const trimmed = buildDailySessionDecision(landed, { now: NOW });
  assert.equal(trimmed.stress?.code, "key_run_eve");
  // Item-scoped: the leg extension shares the squat's group and is trimmed; the squat
  // itself is the anchor the trim passes over.
  assert.ok(trimmed.muscles.reduced.includes("quads"), "the leg extension's group");
  assert.ok(trimmed.muscles.reduced.includes("hamstrings"));
  assert.equal(trimmed.stress.hold_exercise, "Back Squat");
  assert.notEqual(trimmed.candidates.find((c) => c.exercise === "Back Squat").reason_code, "key_run_eve");
});

test("gather end to end: Friday after a full Wednesday leg session trims the accessories before Sunday's long run", () => {
  seedAthlete();
  seedRuns("2026-10-02");
  const lowerA = [
    ["Back Squat", 185, 6],
    ["Romanian Deadlift", 205, 7],
  ];
  for (const date of ["2026-09-16", "2026-09-23", "2026-09-30"]) {
    for (const [exercise, weight, reps] of lowerA) {
      for (let i = 0; i < 3; i++) repo.logSetByName({ date, exercise, weight, reps });
    }
  }
  const snap = gatherDailyDecisionSnapshot("2026-10-02");
  assert.equal(snap.plan.day_number, 5, "Lower B");
  assert.equal(snap.weekly_lower, undefined, "Wednesday already landed the week's legs");
  assert.deepEqual(snap.stress_budget.key_run, { kind: "long", in_days: 2 });
  const env = buildDailySessionDecision(snap, { now: NOW });
  assert.equal(env.stress?.code, "key_run_eve");
  assert.ok(env.muscles.reduced.includes("quads"), "the split squat's group");
  assert.ok(env.muscles.reduced.includes("calves"));
  assert.ok(!env.muscles.reduced.includes("hamstrings"), "the deadlift's group");
});

test("a supporting runner with no race on file gets nothing", () => {
  seedAthlete({ race: false });
  seedRuns("2026-10-02");
  assert.equal(
    stressBudgetSnapshot("2026-10-02", { dayType: "training", planItems: PLAN[4].items, enduranceRole: "supporting" }),
    undefined
  );
  const snap = gatherDailyDecisionSnapshot("2026-10-02");
  assert.equal("stress_budget" in snap, false);
  const env = buildDailySessionDecision(snap, { now: NOW });
  assert.equal("stress" in env, false);
  for (const code of ["key_run_eve", "race_taper_legs", "race_week_legs"])
    assert.ok(!env.precedence.includes(code), code);
});

test("an athlete whose endurance plays no role gets nothing, race or not", () => {
  seedAthlete({ role: "none" });
  seedRuns("2026-10-21");
  assert.equal(
    stressBudgetSnapshot("2026-10-21", { dayType: "training", planItems: PLAN[2].items, enduranceRole: "none" }),
    undefined
  );
});

// ---------- the athlete-facing lines ----------

test("every line is a variant set of at least four that holds the reading grammar", () => {
  const eve = KEY_RUN_EVE_RATIONALE.flatMap((fn) => [
    fn("quality run", "tomorrow"),
    fn("long run", "tomorrow"),
    fn("long run", "in two days"),
  ]);
  for (const set of [
    RACE_TAPER_LEGS_RATIONALE,
    RACE_WEEK_LEGS_RATIONALE,
    RACE_WEEK_EXCLUDED_NOTES,
    KEY_RUN_EVE_RATIONALE,
  ]) {
    assert.ok(set.length >= 4);
    assert.equal(new Set(set).size, set.length);
  }
  for (const line of [...RACE_TAPER_LEGS_RATIONALE, ...RACE_WEEK_LEGS_RATIONALE, ...RACE_WEEK_EXCLUDED_NOTES, ...eve]) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.ok(!/\d/.test(line), `no numbers: ${line}`);
  }
});

test("the same morning reads the same line", () => {
  const base = { planItems: LOWER_B_ITEMS, stress: { race_week_kind: "taper", race_phase: "taper", days_to_race: 11 } };
  const a = buildDailySessionDecision(snapshot({ date: "2026-10-22", ...base }), { now: NOW });
  const b = buildDailySessionDecision(snapshot({ date: "2026-10-22", ...base }), { now: NOW });
  const line = (env) => env.rationale.find((r) => r.code === "race_taper_legs")?.text;
  assert.ok(line(a));
  assert.equal(line(a), line(b));
});
