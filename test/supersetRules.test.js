// A superset has to be doable in a shared gym (owner ruling, 2026-11-12): two lifts a
// group, at most one fixed station a pair (two movements on one cable stack are one
// station), and at most three pairs a session — enforced in ONE place every source passes
// through (composition-pairing.ts enforceSupersetRules), with the footprint of each lift
// read from one table (station-footprint.ts). A rule never deletes work: the lifts it
// takes apart run as straight sets, and an authored session is told which and why.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import {
  enforceSupersetRules,
  pairForSession,
  pairIsDoable,
  SESSION_MAX_PAIRS,
  SUPERSET_MAX_MEMBERS,
} from "../dist/repo/composition-pairing.js";
import { IMPLEMENT_FOOTPRINT, pairFitsOneStation, stationFootprint } from "../dist/repo/station-footprint.js";
import { CHAT_ACTION_PROMPT_SPECS } from "../dist/chatActions.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-07-01";

beforeEach(() => {
  resetTables("daily_session_decisions", "daily_session_compositions", "logged_sets", "sessions", "exercises");
});

function envelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v8",
    input_fingerprint: "superset-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: DATE,
    kind: "train",
    baseline_kind: "train",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Upper", intent: "custom" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
    caps: { volume: "normal", intensity: "normal", duration_min: 90 },
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

const item = (exercise, extra = {}) => ({
  position: 0,
  kind: "strength",
  exercise,
  sets: 3,
  rep_low: 8,
  rep_high: 10,
  superset_group: null,
  note: null,
  ...extra,
});

const groupOf = (items, name) => items.find((it) => it.exercise === name)?.superset_group ?? null;

// ---------- the footprint table ----------

test("footprints: free weights travel, machines and stations do not, and unknown is fixed", () => {
  assert.equal(stationFootprint("Dumbbell Bench Press").footprint, "portable");
  assert.equal(stationFootprint("Kettlebell Swing").footprint, "portable");
  assert.equal(stationFootprint("Band Pull-Apart").footprint, "portable");
  assert.equal(stationFootprint("Push-Up").footprint, "portable");
  assert.equal(stationFootprint("Plate Front Raise").footprint, "portable");
  assert.equal(stationFootprint("Goblet Squat").footprint, "portable", "a goblet squat is a free weight by name");
  assert.equal(stationFootprint("Lat Pulldown").footprint, "fixed");
  assert.equal(stationFootprint("Barbell Bench Press").footprint, "fixed", "bench-bound barbell work");
  assert.equal(stationFootprint("Landmine Press").footprint, "fixed");
  assert.equal(stationFootprint("Pull-Up").station, "pullup_bar", "the bar is a station even for bodyweight");
  assert.equal(stationFootprint("Assisted Pull-Up").implement, "machine");
  assert.equal(stationFootprint("Barbell Curl").footprint, "portable", "a standing curl needs no rack");
  assert.equal(stationFootprint("Barbell Preacher Curl").footprint, "fixed", "a preacher bench is a station");
  const unknown = stationFootprint("Chest-Supported Row");
  assert.equal(unknown.implement, "unknown");
  assert.equal(unknown.footprint, "fixed", "a footprint nobody named is treated as fixed");
  for (const [implement, footprint] of Object.entries(IMPLEMENT_FOOTPRINT))
    assert.ok(footprint === "portable" || footprint === "fixed", implement);
});

test("footprints read the data first: the exercise's equipment, then its linked guide, then the name", () => {
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  db.prepare(`UPDATE exercises SET equipment = 'a pair of dumbbells and an incline bench' WHERE name = ?`).run(
    "Chest-Supported Row"
  );
  assert.equal(stationFootprint("Chest-Supported Row").footprint, "portable", "the stored implement decides");

  repo.upsertExercise({ name: "Seal Row", muscle_group: "back", mode: "reps" });
  const id = repo.findExercise("Seal Row").id;
  db.prepare(
    `INSERT INTO exercise_guides (guide_id, name, name_key, equipment, exercise_id, match_confidence, source, license)
     VALUES ('seal-row', 'Seal Row', 'seal row', 'machine', ?, 'exact', 'test', 'test')`
  ).run(id);
  assert.equal(stationFootprint("Seal Row").implement, "machine", "the linked guide's dataset implement");
  // An unlinked candidate guide is not data about this exercise.
  db.prepare(`UPDATE exercise_guides SET match_confidence = 'movement' WHERE guide_id = 'seal-row'`).run();
  assert.equal(stationFootprint("Seal Row").implement, "unknown");
});

test("a pair holds one fixed station at most: machine+machine no, dumbbell+machine yes, one cable stack yes", () => {
  const machine = { footprint: "fixed", implement: "machine", station: "machine:chest press" };
  const otherMachine = { footprint: "fixed", implement: "machine", station: "machine:seated row" };
  const dumbbell = { footprint: "portable", implement: "dumbbell", station: null };
  assert.equal(pairFitsOneStation(machine, otherMachine), false);
  assert.equal(pairFitsOneStation(dumbbell, machine), true);
  assert.equal(pairIsDoable(item("Machine Chest Press"), item("Machine Row")), false, "two machines");
  assert.equal(pairIsDoable(item("Dumbbell Bench Press"), item("Lat Pulldown")), true, "dumbbells beside a machine");
  assert.equal(pairIsDoable(item("Cable Fly"), item("Cable Face Pull")), true, "two movements on one cable stack");
  assert.equal(pairIsDoable(item("Rope Pushdown"), item("Cable Curl")), true);
  assert.equal(pairIsDoable(item("Cable Fly"), item("Seated Cable Row")), false, "a seated row has its own station");
  assert.equal(pairIsDoable(item("Pull-Up"), item("Hanging Leg Raise")), true, "one pull-up bar");
  assert.equal(pairIsDoable(item("Chest-Supported Row"), item("Lat Pulldown")), false, "unknown counts as fixed");
  assert.equal(pairIsDoable(item("Chest-Supported Row"), item("Dumbbell Bench Press")), true);
});

// ---------- the three rules, in one place ----------

test("a group of three becomes one pair plus a straight set, in card order", () => {
  assert.equal(SUPERSET_MAX_MEMBERS, 2);
  const items = [
    item("Dumbbell Curl", { superset_group: 4 }),
    item("Rope Pushdown", { superset_group: 4 }),
    item("Dumbbell Lateral Raise", { superset_group: 4 }),
  ];
  const unpaired = enforceSupersetRules(items);
  assert.equal(groupOf(items, "Dumbbell Curl"), 4);
  assert.equal(groupOf(items, "Rope Pushdown"), 4);
  assert.equal(groupOf(items, "Dumbbell Lateral Raise"), null);
  assert.deepEqual(unpaired, [{ exercises: ["Dumbbell Lateral Raise"], reason: "group_over_two" }]);
  assert.equal(items.length, 3, "nothing is dropped");
  assert.ok(
    items.every((it) => it.sets === 3),
    "no prescription moves"
  );
});

test("an authored pair on two fixed stations runs straight; a fourth pair runs straight", () => {
  assert.equal(SESSION_MAX_PAIRS, 3);
  const items = [
    item("Machine Chest Press", { superset_group: 1 }),
    item("Machine Row", { superset_group: 1 }),
    item("Dumbbell Bench Press", { superset_group: 2 }),
    item("Dumbbell Row", { superset_group: 2 }),
    item("Dumbbell Shoulder Press", { superset_group: 3 }),
    item("Pull-Up", { superset_group: 3 }),
    item("Goblet Squat", { superset_group: 5 }),
    item("Dumbbell Romanian Deadlift", { superset_group: 5 }),
    item("Dumbbell Curl", { superset_group: 6 }),
    item("Rope Pushdown", { superset_group: 6 }),
  ];
  const unpaired = enforceSupersetRules(items);
  assert.equal(groupOf(items, "Machine Chest Press"), null);
  assert.equal(groupOf(items, "Machine Row"), null);
  // Four doable pairs remain: the compounds rank first by effect tier, the arm pair runs straight.
  assert.equal(groupOf(items, "Dumbbell Bench Press"), 2);
  assert.equal(groupOf(items, "Pull-Up"), 3);
  assert.equal(groupOf(items, "Goblet Squat"), 5);
  assert.equal(groupOf(items, "Dumbbell Curl"), null);
  assert.equal(groupOf(items, "Rope Pushdown"), null);
  assert.deepEqual(unpaired, [
    { exercises: ["Machine Chest Press", "Machine Row"], reason: "two_stations" },
    { exercises: ["Dumbbell Curl", "Rope Pushdown"], reason: "pair_limit" },
  ]);
});

test("the server never seats more than three pairs, and never one on two stations", () => {
  for (const [name, group] of [
    ["Dumbbell Bench Press", "chest"],
    ["Dumbbell Row", "back"],
    ["Dumbbell Shoulder Press", "shoulders"],
    ["Pull-Up", "lats"],
    ["Dumbbell Curl", "biceps"],
    ["Rope Pushdown", "triceps"],
    ["Hammer Curl", "biceps"],
    ["Cable Overhead Triceps Extension", "triceps"],
    ["Leg Extension", "quads"],
    ["Lying Leg Curl", "hamstrings"],
  ])
    repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  const items = [
    item("Dumbbell Bench Press"),
    item("Dumbbell Row"),
    item("Dumbbell Shoulder Press"),
    item("Pull-Up"),
    item("Leg Extension"),
    item("Lying Leg Curl"),
    item("Dumbbell Curl"),
    item("Rope Pushdown"),
    item("Hammer Curl"),
    item("Cable Overhead Triceps Extension"),
  ].map((it, position) => ({ ...it, position }));
  const { items: out, unpaired } = pairForSession(items, { envelope: envelope(), date: DATE, planSnapshot: false });
  const groups = new Set(out.map((it) => it.superset_group).filter((g) => g != null));
  assert.equal(groups.size, 3, "three pairs at most");
  assert.equal(groupOf(out, "Dumbbell Row"), groupOf(out, "Dumbbell Bench Press"));
  assert.equal(groupOf(out, "Pull-Up"), groupOf(out, "Dumbbell Shoulder Press"));
  assert.equal(groupOf(out, "Rope Pushdown"), groupOf(out, "Dumbbell Curl"));
  assert.equal(groupOf(out, "Hammer Curl"), null, "the fourth qualifying pair runs straight");
  assert.equal(groupOf(out, "Cable Overhead Triceps Extension"), null);
  assert.equal(groupOf(out, "Leg Extension"), null, "two machines never pair");
  assert.equal(groupOf(out, "Lying Leg Curl"), null);
  assert.ok(!String(out.find((it) => it.exercise === "Hammer Curl").note ?? "").includes("Paired"));
  assert.equal(unpaired, undefined, "nobody authored those pairs, so nothing is reported as taken apart");
  assert.equal(out.length, items.length);
});

test("an agent's composed session reports what the rules took apart in its validation", () => {
  for (const [name, group] of [
    ["Dumbbell Curl", "biceps"],
    ["Rope Pushdown", "triceps"],
    ["Dumbbell Lateral Raise", "shoulders"],
    ["Machine Chest Press", "chest"],
    ["Machine Row", "back"],
  ])
    repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    {
      name: "Upper",
      focus: "Upper",
      why: "Fits the envelope today.",
      est_minutes: 60,
      items: [
        item("Machine Chest Press", { superset_group: 1 }),
        item("Machine Row", { superset_group: 1 }),
        item("Dumbbell Curl", { superset_group: 2 }),
        item("Rope Pushdown", { superset_group: 2 }),
        item("Dumbbell Lateral Raise", { superset_group: 2 }),
      ],
    },
    envelope()
  );
  assert.ok(session);
  assert.equal(groupOf(session.items, "Dumbbell Curl"), groupOf(session.items, "Rope Pushdown"));
  assert.notEqual(groupOf(session.items, "Dumbbell Curl"), null);
  assert.equal(groupOf(session.items, "Dumbbell Lateral Raise"), null);
  assert.equal(groupOf(session.items, "Machine Chest Press"), null);
  assert.deepEqual(validation.unpaired, [
    { exercises: ["Machine Chest Press", "Machine Row"], reason: "two_stations" },
    { exercises: ["Dumbbell Lateral Raise"], reason: "group_over_two" },
  ]);
});

test("the coach is told the same three rules where it authors today's session", () => {
  const spec = CHAT_ACTION_PROMPT_SPECS.today_session;
  const text = spec.guidance.join(" ");
  assert.match(text, /exactly two lifts/);
  assert.match(text, /three pairs/);
  assert.match(text, /fixed stations?/);
  // The spec's own example is a pair a shared gym can run.
  const example = JSON.parse(spec.shape);
  const paired = example.items.filter((it) => it.superset_group === 1);
  assert.equal(paired.length, 2);
  assert.equal(pairIsDoable(paired[0], paired[1]), true, JSON.stringify(paired));
});
