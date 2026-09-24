// Today's card complements itself: antagonist pairs are seated as supersets inside one
// effect tier, one loaded movement per movement region survives, and a group the week
// is behind on goes first in its tier — today's card only, the plan's order untouched.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { collapseRegionDuplicates, PAIRING_NOTES, pairForSession } from "../dist/repo/composition-pairing.js";
import { antagonistSide, movementRegionKey } from "../dist/repo/movement-region.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { isPrepPlanItem } from "../dist/domain/training/plan-item-order.js";
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
    input_fingerprint: "pair-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: DATE,
    kind: "train",
    baseline_kind: "train",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Upper & Arms", intent: "custom" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
    caps: { volume: "normal", intensity: "normal", duration_min: 75 },
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

function agentSession(items) {
  return { name: "Composed", focus: "Composed", why: "Fits the envelope today.", est_minutes: 60, items };
}

function seed(exercises) {
  for (const [name, muscle_group, mode = "reps"] of exercises) repo.upsertExercise({ name, muscle_group, mode });
}

function seedUpperAndArms() {
  seed([
    ["Dumbbell Bench Press", "chest"],
    ["Chest-Supported Row", "back"],
    ["Chest Dips", "chest"],
    ["Barbell Curl", "biceps"],
    ["Rope Pushdown", "triceps"],
    ["Farmer's Carry", "forearms", "timed"],
  ]);
}

function upperAndArms() {
  return agentSession([
    { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
    { exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 85 },
    { exercise: "Chest Dips", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Barbell Curl", sets: 3, rep_low: 8, rep_high: 10, target_weight: 75 },
    { exercise: "Rope Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 57.5 },
    { exercise: "Farmer's Carry", sets: 2, mode: "timed", target_seconds: 40, target_weight: 60 },
  ]);
}

function seedLowerA() {
  seed([
    ["Ankle Rocker", "mobility"],
    ["Back Squat", "quads"],
    ["Romanian Deadlift", "hamstrings"],
    ["Leg Extension", "quads"],
    ["Lying Leg Curl", "hamstrings"],
    ["Standing Calf Raise", "calves"],
  ]);
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
    ...overrides,
  });
}

const byName = (session, name) => session.items.find((item) => item.exercise === name);
const names = (session) => session.items.map((item) => item.exercise);

test("Upper & Arms: the dumbbell bench pairs with the row, the curl with the pushdown", () => {
  seedUpperAndArms();
  const { session } = normalizeComposedSession(upperAndArms(), envelope());
  assert.ok(session);
  const bench = byName(session, "Dumbbell Bench Press");
  const row = byName(session, "Chest-Supported Row");
  const curl = byName(session, "Barbell Curl");
  const pushdown = byName(session, "Rope Pushdown");
  assert.ok(Number.isInteger(bench.superset_group) && bench.superset_group >= 1);
  assert.equal(row.superset_group, bench.superset_group, "push beside pull");
  assert.ok(Number.isInteger(curl.superset_group));
  assert.equal(pushdown.superset_group, curl.superset_group, "curl beside triceps");
  assert.notEqual(curl.superset_group, bench.superset_group, "two pairs, two groups");
  assert.equal(byName(session, "Chest Dips").superset_group, null, "a dip is a press, never a triceps partner");
  assert.equal(byName(session, "Farmer's Carry").superset_group, null, "timed work never pairs");
  // Partners sit next to each other, and the dip is not folded into the pushdown.
  const order = names(session);
  assert.equal(order.indexOf("Chest-Supported Row"), order.indexOf("Dumbbell Bench Press") + 1);
  assert.equal(Math.abs(order.indexOf("Barbell Curl") - order.indexOf("Rope Pushdown")), 1);
  assert.ok(order.includes("Chest Dips"));
  assert.deepEqual(
    session.items.map((item) => item.position),
    session.items.map((_, index) => index),
    "positions read in the order the card is done"
  );
  // Sets and reps are the composition's, untouched by the pairing.
  assert.equal(bench.sets, 3);
  assert.equal(row.sets, 3);
  assert.equal(pushdown.rep_low, 10);
});

test("each pair carries exactly one calm hint, on its first item, with the partner named", () => {
  seedUpperAndArms();
  const { session } = normalizeComposedSession(upperAndArms(), envelope());
  const groups = new Map();
  for (const item of session.items) {
    if (item.superset_group == null) continue;
    if (!groups.has(item.superset_group)) groups.set(item.superset_group, []);
    groups.get(item.superset_group).push(item);
  }
  assert.equal(groups.size, 2);
  for (const [lead, follow] of groups.values()) {
    assert.ok(String(lead.note ?? "").includes(follow.exercise), `${lead.exercise} names ${follow.exercise}`);
    assert.equal(
      PAIRING_NOTES.some((v) => String(follow.note ?? "").includes(v.split("{partner}")[0].trim())),
      false,
      "the partner carries no second hint"
    );
    assert.equal(violatesReadingGrammar(lead.note), null);
    assert.doesNotMatch(lead.note, /\d/, "no numbers in the hint");
  }
});

test("Lower A: the leg extension pairs with the leg curl; the squat and the hinge stand alone", () => {
  seedLowerA();
  const session = deterministicComposedSession(lowerEnvelope());
  const ext = byName(session, "Leg Extension");
  const curl = byName(session, "Lying Leg Curl");
  assert.ok(Number.isInteger(ext.superset_group));
  assert.equal(curl.superset_group, ext.superset_group);
  assert.equal(byName(session, "Back Squat").superset_group, null, "the warmed-up anchor gets its full rest");
  assert.equal(byName(session, "Romanian Deadlift").superset_group, null, "a hinge has no antagonist here");
  assert.equal(byName(session, "Ankle Rocker").superset_group, null, "prep never pairs");
  assert.equal(byName(session, "Standing Calf Raise").superset_group, null);
  const order = names(session);
  assert.equal(order[0], "Ankle Rocker");
  assert.equal(order[1], "Back Squat");
  assert.equal(order[2], "Romanian Deadlift", "the compounds lead");
  assert.equal(Math.abs(order.indexOf("Leg Extension") - order.indexOf("Lying Leg Curl")), 1);
});

test("a group the week is behind on goes first in its tier and leads its pair — on today's card only", () => {
  seedLowerA();
  const before = repo.getPlanDay(1).items.map((item) => item.exercise);
  const plain = deterministicComposedSession(lowerEnvelope());
  assert.ok(names(plain).indexOf("Lying Leg Curl") < names(plain).indexOf("Leg Extension"), "effect order by default");

  const session = deterministicComposedSession(
    lowerEnvelope({ dose: { gaps: [{ group: "quads", short: 2 }], fills: [] } })
  );
  const order = names(session);
  assert.ok(order.indexOf("Leg Extension") < order.indexOf("Lying Leg Curl"), "quads short: the extension goes first");
  assert.equal(byName(session, "Leg Extension").superset_group, byName(session, "Lying Leg Curl").superset_group);
  assert.ok(
    String(byName(session, "Leg Extension").note ?? "").includes("Lying Leg Curl"),
    "the leader carries the hint"
  );
  assert.equal(order[1], "Back Squat", "the anchor keeps its seat");
  assert.deepEqual(
    repo.getPlanDay(1).items.map((item) => item.exercise),
    before,
    "the persisted plan order is untouched"
  );
});

test("a gap of zero, or no dose at all, reorders nothing", () => {
  seedLowerA();
  const plain = names(deterministicComposedSession(lowerEnvelope()));
  const zero = names(
    deterministicComposedSession(lowerEnvelope({ dose: { gaps: [{ group: "quads", short: 0 }], fills: [] } }))
  );
  assert.deepEqual(zero, plain);
});

test("two pushdowns on one card: one is dropped; different triceps regions both stay", () => {
  seed([
    ["Rope Pushdown", "triceps"],
    ["V-Bar Pushdown", "triceps"],
    ["Cable Overhead Triceps Extension", "triceps"],
  ]);
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Rope Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 57.5 },
      { exercise: "V-Bar Pushdown", sets: 2, rep_low: 10, rep_high: 12, target_weight: 60 },
      { exercise: "Cable Overhead Triceps Extension", sets: 3, rep_low: 10, rep_high: 12, target_weight: 40 },
    ]),
    envelope({ candidates: [{ exercise: "Rope Pushdown", action: "hold" }] })
  );
  assert.deepEqual(names(session).sort(), ["Cable Overhead Triceps Extension", "Rope Pushdown"]);
  assert.ok(validation.rejected.some((r) => r.exercise === "V-Bar Pushdown" && r.reason === "duplicate_region"));
});

test("two lateral raises and two straight-knee calf raises fold; a seated calf raise stays", () => {
  seed([
    ["Cable Lateral Raise", "shoulders"],
    ["Dumbbell Lateral Raise", "shoulders"],
    ["Standing Calf Raise", "calves"],
    ["Leg Press Calf Raise", "calves"],
    ["Seated Calf Raise", "calves"],
  ]);
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Cable Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 15 },
      { exercise: "Dumbbell Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 20 },
      { exercise: "Standing Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 90 },
      { exercise: "Leg Press Calf Raise", sets: 2, rep_low: 10, rep_high: 15, target_weight: 180 },
      { exercise: "Seated Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 125 },
    ]),
    envelope()
  );
  const kept = names(session);
  assert.equal(kept.filter((n) => /lateral raise/i.test(n)).length, 1);
  assert.ok(kept.includes("Standing Calf Raise"), "more sets keep the standing raise");
  assert.ok(!kept.includes("Leg Press Calf Raise"));
  assert.ok(kept.includes("Seated Calf Raise"), "bent-knee is its own region");
  assert.equal(validation.rejected.filter((r) => r.reason === "duplicate_region").length, 2);
});

test("flat plus incline press, and squat plus leg press, all stay", () => {
  seed([
    ["Barbell Bench Press", "chest"],
    ["Incline Dumbbell Press", "chest"],
    ["Back Squat", "quads"],
    ["Leg Press", "quads"],
  ]);
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 },
      { exercise: "Leg Press", sets: 3, rep_low: 10, rep_high: 12, target_weight: 270 },
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
      { exercise: "Incline Dumbbell Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 45 },
    ]),
    envelope()
  );
  assert.deepEqual(names(session).sort(), ["Back Squat", "Barbell Bench Press", "Incline Dumbbell Press", "Leg Press"]);
  assert.equal(validation.rejected.length, 0);
});

test("a band pull-apart is prep, never the rear-delt twin of a reverse pec deck", () => {
  seed([
    ["Band Pull-Apart", "mobility"],
    ["Reverse Pec Deck", "rear delts"],
  ]);
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Band Pull-Apart", sets: 2, rep_low: 15, rep_high: 15 },
      { exercise: "Reverse Pec Deck", sets: 3, rep_low: 12, rep_high: 15, target_weight: 70 },
    ]),
    envelope()
  );
  assert.deepEqual(names(session).sort(), ["Band Pull-Apart", "Reverse Pec Deck"]);
});

test("a reach top set and the block it leads never pair", () => {
  seed([
    ["Dumbbell Bench Press", "chest"],
    ["Chest-Supported Row", "back"],
  ]);
  const candidate = {
    exercise: "Dumbbell Bench Press",
    muscle_group: "chest",
    action: "overload",
    reason_code: null,
    substitution_for: null,
    note: null,
    current_target: { mode: "reps", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55, target_seconds: null },
    authorized_target: { mode: "reps", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55, target_seconds: null },
    top_set: { weight: 70, reps: 3 },
  };
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
      { exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 85 },
    ]),
    envelope({ candidates: [candidate] })
  );
  assert.ok(session);
  const top = session.items.find((item) => item.reach);
  assert.ok(top, "the top set landed");
  for (const item of session.items) assert.equal(item.superset_group, null, `${item.exercise} is not paired`);
  assert.equal(session.items[0], top, "the top set still leads its block");
  assert.equal(session.items[1].exercise, "Dumbbell Bench Press");
});

test("heavy strength-range work, warm-up sets and timed work never pair", () => {
  seed([
    ["Barbell Bench Press", "chest"],
    ["Pendlay Row", "back"],
    ["Overhead Press", "shoulders"],
    ["Lat Pulldown", "lats"],
  ]);
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 7, target_weight: 135 },
      { exercise: "Pendlay Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 150 },
      { exercise: "Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95, warmup_sets: 1 },
      { exercise: "Lat Pulldown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
    ]),
    envelope()
  );
  for (const item of session.items) assert.equal(item.superset_group, null, `${item.exercise} is not paired`);
  assert.deepEqual(names(session), ["Barbell Bench Press", "Pendlay Row", "Overhead Press", "Lat Pulldown"]);
});

test("an author's own grouping stands, and a new pair takes an unused group", () => {
  const items = [
    {
      position: 0,
      kind: "strength",
      exercise: "Chest Press",
      sets: 3,
      rep_low: 8,
      rep_high: 10,
      superset_group: 1,
      note: null,
    },
    {
      position: 1,
      kind: "strength",
      exercise: "Pendlay Row",
      sets: 3,
      rep_low: 8,
      rep_high: 10,
      superset_group: 1,
      note: null,
    },
    {
      position: 2,
      kind: "strength",
      exercise: "Hammer Curl",
      sets: 3,
      rep_low: 10,
      rep_high: 12,
      superset_group: null,
      note: null,
    },
    {
      position: 3,
      kind: "strength",
      exercise: "Rope Pushdown",
      sets: 3,
      rep_low: 10,
      rep_high: 12,
      superset_group: null,
      note: null,
    },
  ];
  const { items: out, changed } = pairForSession(items, { envelope: envelope(), date: DATE, planSnapshot: false });
  assert.equal(changed, true);
  assert.equal(out[0].superset_group, 1);
  assert.equal(out[1].superset_group, 1);
  assert.equal(out[0].note, null, "an existing pair is not given a hint it did not ask for");
  assert.equal(out[2].superset_group, 2);
  assert.equal(out[3].superset_group, 2);
});

test("the athlete's own snapshotted day is never paired or reseated", () => {
  seedLowerA();
  const session = deterministicComposedSession(
    lowerEnvelope({ dose: { gaps: [{ group: "quads", short: 2 }], fills: [] } }),
    { planSnapshot: true }
  );
  for (const item of session.items) assert.equal(item.superset_group, null);
  const order = names(session);
  assert.ok(order.indexOf("Lying Leg Curl") < order.indexOf("Leg Extension"));
});

test("nothing to pair is identity: the same array back, unchanged", () => {
  const items = [
    { position: 0, kind: "strength", exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7 },
    { position: 1, kind: "strength", exercise: "Lying Leg Curl", sets: 3, rep_low: 10, rep_high: 12 },
    { position: 2, kind: "strength", exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10 },
  ];
  const result = pairForSession(items, { envelope: envelope(), date: DATE, planSnapshot: false });
  assert.equal(result.changed, false);
  assert.equal(result.items, items);
});

test("the same day gives the same wording; the set has more than one phrasing", () => {
  seedUpperAndArms();
  const a = normalizeComposedSession(upperAndArms(), envelope()).session;
  const b = normalizeComposedSession(upperAndArms(), envelope()).session;
  assert.deepEqual(
    a.items.map((item) => item.note),
    b.items.map((item) => item.note)
  );
  assert.ok(new Set(PAIRING_NOTES).size >= 4);
});

test("every pairing phrasing reads clean: no grammar breach, no number, never mistaken for prep", () => {
  for (const variant of PAIRING_NOTES) {
    const text = variant.replace("{partner}", "Chest-Supported Row");
    assert.ok(variant.includes("{partner}"), "each names the partner");
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.doesNotMatch(text, /\d/, text);
    assert.equal(isPrepPlanItem({ exercise: "Leg Extension", note: text }), false, text);
  }
});

test("movement regions: the table a coach would draw", () => {
  const cases = {
    "Dumbbell Bench Press": "horizontal-press:flat",
    "Barbell Bench Press": "horizontal-press:flat",
    "Incline Dumbbell Press": "horizontal-press:incline",
    "Overhead Press": "vertical-press",
    "Seated Dumbbell Shoulder Press": "vertical-press",
    "Chest Dips": "dip",
    "Bench Dip": "dip",
    "Leg Extension": "knee-extension",
    "Lying Leg Curl": "knee-flexion",
    "Seated Leg Curl": "knee-flexion",
    "Standing Calf Raise": "calf:straight",
    "Seated Calf Raise": "calf:bent",
    "Barbell Curl": "curl:supinated",
    "Preacher Curl": "curl:supinated",
    "Hammer Curl": "curl:neutral",
    "Reverse Curl": "curl:pronated",
    "Cable OH Triceps": "triceps:overhead",
    "Cable Overhead Triceps Extension": "triceps:overhead",
    "Rope Pushdown": "triceps:pushdown",
    "Skull Crusher": "triceps:lying",
    "Cable Lateral Raise": "lateral-raise",
    "Reverse Pec Deck": "rear-delt",
    "Face Pull": "rear-delt",
  };
  for (const [name, region] of Object.entries(cases)) assert.equal(movementRegionKey(name), region, name);
  for (const name of [
    "Back Squat",
    "Leg Press",
    "Romanian Deadlift",
    "Deadlift",
    "Pendlay Row",
    "Neutral Pull-Up",
    "Nordic Hamstring Curl",
    "Close-Grip Bench Press",
    "Band Pull-Apart",
    "Farmer's Carry",
    "Wrist Curl",
    "Lateral Lunge",
  ]) {
    assert.equal(movementRegionKey(name), null, `${name} has no region`);
  }
});

test("antagonist sides: pulls read off the pattern, isolation off the region", () => {
  assert.equal(antagonistSide("Chest-Supported Row"), "horizontal-pull");
  assert.equal(antagonistSide("Dumbbell Bench Press"), "horizontal-push");
  assert.equal(antagonistSide("Overhead Press"), "vertical-push");
  assert.equal(antagonistSide("Wide Pulldown"), "vertical-pull");
  assert.equal(antagonistSide("Lying Leg Curl"), "knee-flexion", "a leg curl is knee flexion, not a hinge");
  assert.equal(antagonistSide("Leg Extension"), "knee-extension");
  assert.equal(antagonistSide("Chest Dips"), null, "a dip is a press, not a triceps isolation");
  assert.equal(antagonistSide("Cable Fly"), null);
  assert.equal(antagonistSide("Romanian Deadlift"), null);
});

test("collapse is identity when every region is distinct", () => {
  const items = [
    { exercise: "Barbell Bench Press", sets: 3 },
    { exercise: "Incline Dumbbell Press", sets: 3 },
    { exercise: "Rope Pushdown", sets: 3 },
  ];
  const out = collapseRegionDuplicates(items, new Set());
  assert.equal(out.items, items);
  assert.deepEqual(out.rejected, []);
});

test("a hint never pushes a note past what the card prints: it moves to the partner, or stays off", () => {
  const long =
    "Keep the elbows tucked and pause at the chest on every rep; the shoulder has been grumbling, so stop the set the moment it pinches and log what you actually did today.";
  const items = [
    { position: 0, kind: "strength", exercise: "Hammer Curl", sets: 3, rep_low: 10, rep_high: 12, note: long },
    { position: 1, kind: "strength", exercise: "Rope Pushdown", sets: 3, rep_low: 10, rep_high: 12, note: null },
  ];
  const { items: out } = pairForSession(items, { envelope: envelope(), date: DATE, planSnapshot: false });
  assert.equal(out[0].note, long, "the existing note is untouched");
  assert.ok(String(out[1].note).includes("Hammer Curl"), "the partner carries the hint instead");

  const both = [
    { position: 0, kind: "strength", exercise: "Hammer Curl", sets: 3, rep_low: 10, rep_high: 12, note: long },
    { position: 1, kind: "strength", exercise: "Rope Pushdown", sets: 3, rep_low: 10, rep_high: 12, note: long },
  ];
  const { items: full } = pairForSession(both, { envelope: envelope(), date: DATE, planSnapshot: false });
  assert.equal(full[0].note, long);
  assert.equal(full[1].note, long);
  assert.equal(full[0].superset_group, full[1].superset_group, "still paired; the group says it");
});

test("a behind group never displaces the day's anchor, even when the anchor is paired", () => {
  seed([
    ["Dumbbell Bench Press", "chest"],
    ["Chest-Supported Row", "back"],
    ["Seated Dumbbell Shoulder Press", "shoulders"],
    ["Lat Pulldown", "lats"],
  ]);
  const items = [
    { position: 0, kind: "strength", exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10 },
    { position: 1, kind: "strength", exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 10 },
    { position: 2, kind: "strength", exercise: "Seated Dumbbell Shoulder Press", sets: 3, rep_low: 8, rep_high: 10 },
    { position: 3, kind: "strength", exercise: "Lat Pulldown", sets: 3, rep_low: 10, rep_high: 12 },
  ];
  const env = envelope({
    dose: {
      gaps: [
        { group: "back", short: 2 },
        { group: "lats", short: 2 },
      ],
      fills: [],
    },
  });
  const { items: out } = pairForSession(items, { envelope: env, date: DATE, planSnapshot: false });
  assert.deepEqual(
    out.map((item) => item.exercise),
    ["Dumbbell Bench Press", "Chest-Supported Row", "Lat Pulldown", "Seated Dumbbell Shoulder Press"],
    "the anchor pair keeps the head; the behind group leads only its own pair"
  );
  assert.equal(out[0].superset_group, out[1].superset_group);
  assert.equal(out[2].superset_group, out[3].superset_group);
});
