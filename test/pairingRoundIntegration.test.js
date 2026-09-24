// The pairing round's packages composed together: the weekly dose (weekly-dose-ledger.ts /
// composition-dose.ts), antagonist pairing and region dedupe (composition-pairing.ts), and
// the leg stress budget (stress-budget.ts). Each package has its own test file; this one
// pins how they meet on one card and one morning:
//   - a dose fill lands on the accessory, which is then paired with its antagonist and
//     leads the pair; no load moves;
//   - a group the stress budget trimmed never takes a dose fill;
//   - a taper week fills nothing, and the upper day still pairs;
//   - the athlete's own snapshotted day takes no dose, no pairing, and keeps every
//     non-press region duplicate they wrote (the press-angle rule still holds);
//   - a plan-saved pairing reaches the card, and a lone member of one is un-paired;
//   - pairing reseats but never reports a cap;
//   - the dose read for a date stands still when today's sets are logged;
//   - the key-run eve and the supporting-runner "the run stays optional" line never
//     co-appear on one read.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mondayOf } from "../dist/lib/dates.js";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { doseFillNote } from "../dist/repo/composition-dose.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { readVolumeFloorContext } from "../dist/repo/volume-floor-context.js";
import { weeklyDoseLedger } from "../dist/repo/weekly-dose-ledger.js";
import { thisWeekPlanDayMap } from "../dist/repo/plan-selection.js";
import { repo, resetTables, settlePlanPrescriptions } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "daily_session_outcomes",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "recovery_cycles",
    "program_blocks",
    "plan_proposals",
    "brain_decisions",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
});

const clone = (v) => JSON.parse(JSON.stringify(v));
const byName = (session, name) => session.items.find((i) => i.exercise === name);
const names = (session) => session.items.map((i) => i.exercise);
const item = (exercise, sets, rep_low, rep_high, target_weight) => ({
  exercise,
  sets,
  rep_low,
  rep_high,
  target_weight,
});

// ---------------------------------------------------------------------------
// the dose week (last week's Monday–Wednesday, so every date is in the past)
// ---------------------------------------------------------------------------

const MON = addDaysISO(mondayOf(localDateISO()), -7);
const TUE = addDaysISO(MON, 1);
const WED = addDaysISO(MON, 2);
const NOW = `${WED}T09:00:00.000Z`;

const DOSE_EXERCISES = [
  ["Barbell Bench Press", "chest"],
  ["Incline Dumbbell Press", "chest"],
  ["Overhead Press", "shoulders"],
  ["Pendlay Row", "back"],
  ["Lat Pulldown", "back"],
  ["Ankle Rocker", "mobility"],
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Extension", "quads"],
  ["Lying Leg Curl", "hamstrings"],
  ["Chest-Supported Row", "back"],
  ["Dumbbell Shoulder Press", "shoulders"],
  ["Bulgarian Split Squat", "quads"],
  ["Hip Thrust", "glutes"],
];

// The weekly-dose fixture's week (quads one set short of the floor), with Lower A
// written curl-first: the dose has to reseat the extension to lead its pair.
function doseWeekPlan() {
  return [
    {
      day_number: 1,
      name: "Push",
      items: [
        item("Barbell Bench Press", 5, 5, 7, 135),
        item("Incline Dumbbell Press", 5, 8, 10, 50),
        item("Overhead Press", 4, 6, 8, 95),
      ],
    },
    { day_number: 2, name: "Pull", items: [item("Pendlay Row", 5, 6, 8, 150), item("Lat Pulldown", 5, 8, 10, 140)] },
    {
      day_number: 3,
      name: "Lower A",
      items: [
        { exercise: "Ankle Rocker", sets: 2, rep_low: 10, rep_high: 10 },
        item("Back Squat", 3, 5, 7, 185),
        item("Romanian Deadlift", 4, 8, 10, 205),
        item("Lying Leg Curl", 3, 10, 12, 120),
        item("Leg Extension", 2, 10, 12, 135),
      ],
    },
    {
      day_number: 4,
      name: "Upper",
      items: [item("Chest-Supported Row", 3, 8, 10, 85), item("Dumbbell Shoulder Press", 3, 8, 10, 50)],
    },
    {
      day_number: 5,
      name: "Lower B",
      items: [item("Bulgarian Split Squat", 2, 8, 10, 60), item("Hip Thrust", 3, 8, 10, 225)],
    },
  ];
}

function log(date, exercise, weight, reps, n, day_number) {
  for (let i = 0; i < n; i++) repo.logSetByName({ date, exercise, weight, reps, day_number });
}

// Two earlier weeks trained as written (every slot TESTED), then this week's Monday Push
// and Tuesday Pull.
function seedDoseWeek() {
  for (const [name, muscle_group] of DOSE_EXERCISES) repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.replacePlan(doseWeekPlan());
  settlePlanPrescriptions();
  repo.setProfile({
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" },
  });
  const plan = repo.getPlan();
  for (const back of [14, 7]) {
    for (const day of plan) {
      const date = addDaysISO(MON, day.day_number - 1 - back);
      for (const it of day.items)
        log(date, it.exercise, it.target_weight ?? null, it.rep_low + 1, it.sets, day.day_number);
    }
  }
  for (const it of plan[0].items) log(MON, it.exercise, it.target_weight, it.rep_low + 1, it.sets, 1);
  for (const it of plan[1].items) log(TUE, it.exercise, it.target_weight, it.rep_low + 1, it.sets, 2);
}

function decideWednesday() {
  const snapshot = gatherDailyDecisionSnapshot(WED);
  return { snapshot, envelope: buildDailySessionDecision(snapshot, { now: NOW }) };
}

test("dose + pairing: the quads-short card fills Leg Extension, pairs it with the curl and leads the pair; no load moves", () => {
  seedDoseWeek();
  const { snapshot, envelope } = decideWednesday();
  assert.equal(snapshot.plan.day_number, 3, "Lower A");
  assert.deepEqual(envelope.dose.fills, [{ exercise: "Leg Extension", group: "quads", add_sets: 1, sets: 2 }]);

  const session = deterministicComposedSession(clone(envelope));
  const ext = byName(session, "Leg Extension");
  const curl = byName(session, "Lying Leg Curl");
  assert.equal(ext.sets, 3, "one extra set on the accessory");
  assert.ok(Number.isInteger(ext.superset_group), "the filled lift is paired");
  assert.equal(curl.superset_group, ext.superset_group, "with its antagonist");
  const order = names(session);
  assert.equal(order.indexOf("Leg Extension") + 1, order.indexOf("Lying Leg Curl"), "the behind group leads its pair");
  assert.ok(ext.note.startsWith(doseFillNote("quads", WED, "Leg Extension")), ext.note);
  assert.ok(ext.note.includes("Lying Leg Curl"), "the leader carries the pairing hint");
  assert.equal(order[1], "Back Squat", "the anchor keeps its seat");
  assert.equal(byName(session, "Back Squat").superset_group, null);
  assert.equal(byName(session, "Back Squat").sets, 3, "the heavy anchor never takes the week's set");

  // Loads byte-identical to the same card without the dose.
  const withoutDose = clone(envelope);
  delete withoutDose.dose;
  const plain = deterministicComposedSession(withoutDose);
  assert.deepEqual([...names(plain)].sort(), [...order].sort(), "nothing added or dropped");
  for (const before of plain.items) {
    const after = byName(session, before.exercise);
    for (const key of ["target_weight", "target_seconds", "rep_low", "rep_high", "warmup_sets", "mode"]) {
      assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), `${before.exercise} ${key}`);
    }
    assert.equal(after.sets, before.sets + (before.exercise === "Leg Extension" ? 1 : 0), before.exercise);
  }
});

test("the dose read for a date stands still when today's own sets are logged", () => {
  seedDoseWeek();
  const ledgerBefore = weeklyDoseLedger(WED);
  const weekBefore = thisWeekPlanDayMap(WED);
  const sliceBefore = gatherDailyDecisionSnapshot(WED).weekly_dose;
  assert.deepEqual(sliceBefore.gaps, [{ group: "quads", short: 1 }], "the morning carries the quads gap");
  const later = (week) => [...week.map.entries()].map(([dow, day]) => [dow, day.day_number]);

  // A first set mid-morning, then the rest of Wednesday's Lower A exactly as written.
  log(WED, "Back Squat", 185, 6, 1, 3);
  assert.deepEqual(weeklyDoseLedger(WED), ledgerBefore, "a partial log moves nothing");
  const lowerA = repo.getPlan().find((d) => d.day_number === 3);
  for (const it of lowerA.items) log(WED, it.exercise, it.target_weight ?? null, it.rep_low + 1, it.sets, 3);

  // done counts Monday..yesterday, today's planned sets are the plan's, and the later
  // lift days come from the morning's map: the ring's phase never reads today's log.
  assert.deepEqual(weeklyDoseLedger(WED), ledgerBefore, "the ledger for the date is unchanged");
  const weekAfter = thisWeekPlanDayMap(WED);
  assert.equal(weekAfter.strength_start, weekBefore.strength_start);
  assert.deepEqual(later(weekAfter), later(weekBefore));
  // The read itself has moved on (the day is trained), and a fill is only ever asked of
  // a train read — so the slice stands down rather than changing its numbers.
  const after = gatherDailyDecisionSnapshot(WED);
  assert.notEqual(after.day_read.kind, "train");
  assert.equal("weekly_dose" in after, false);
});

// ---------------------------------------------------------------------------
// the stress budget meets the dose (pure decision half)
// ---------------------------------------------------------------------------

const LOWER_B_ITEMS = [
  {
    exercise: "Deadlift",
    muscle_group: "hamstrings",
    equipment: "barbell",
    mode: "reps",
    kind: "strength",
    rep_low: 3,
  },
  { exercise: "Bulgarian Split Squat", muscle_group: "quads", equipment: "dumbbell", mode: "reps", kind: "strength" },
  { exercise: "Seated Calf Raise", muscle_group: "calves", equipment: "machine", mode: "reps", kind: "strength" },
  { exercise: "Pallof Press", muscle_group: "core", equipment: "cable", mode: "reps", kind: "strength" },
];

function pureSnapshot({ date, planItems, stress, ...overrides }) {
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

const EVE = { race_week_kind: "build", race_phase: "sharpen", days_to_race: 30, key_run: { kind: "long", in_days: 2 } };
const QUADS_SHORT = {
  gaps: [{ group: "quads", short: 2 }],
  eligible: [{ exercise: "Bulgarian Split Squat", group: "quads", sets: 3 }],
};

function seedLowerBHistory() {
  for (const [name, muscle_group, weight, reps] of [
    ["Deadlift", "hamstrings", 225, 4],
    ["Bulgarian Split Squat", "quads", 60, 9],
    ["Seated Calf Raise", "calves", 125, 11],
    ["Pallof Press", "core", 45, 11],
  ]) {
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
    for (const date of ["2026-09-08", "2026-09-15"])
      repo.logSetByName({ date, exercise: name, weight, reps, day_number: null });
  }
}

test("stress eve + dose: a group the key-run eve trimmed never takes a dose fill", () => {
  seedLowerBHistory();
  const eve = buildDailySessionDecision(
    pureSnapshot({ date: "2026-10-02", planItems: LOWER_B_ITEMS, stress: EVE, weekly_dose: QUADS_SHORT }),
    { now: "2026-10-02T09:00:00.000Z" }
  );
  assert.equal(eve.stress?.code, "key_run_eve");
  assert.ok(eve.muscles.reduced.includes("quads"), "the eve trims the split squat's group");
  assert.ok(!(eve.dose?.fills ?? []).some((f) => f.group === "quads"), JSON.stringify(eve.dose));
  const card = normalizeComposedSession(
    {
      name: "Lower B",
      focus: "Lower B",
      why: "x",
      est_minutes: 55,
      items: [
        item("Deadlift", 3, 3, 5, 225),
        item("Bulgarian Split Squat", 3, 8, 10, 60),
        item("Seated Calf Raise", 3, 10, 12, 125),
      ],
    },
    eve
  ).session;
  const bss = byName(card, "Bulgarian Split Squat");
  assert.equal(bss.sets, 2, "trimmed, never refilled");
  assert.equal(bss.target_weight, 60);
  assert.ok(!/extra set|one more set|added set/i.test(String(bss.note ?? "")), bss.note);

  // Control: the same morning with no eve fills the split squat.
  const plain = buildDailySessionDecision(
    pureSnapshot({ date: "2026-10-02", planItems: LOWER_B_ITEMS, weekly_dose: QUADS_SHORT }),
    { now: "2026-10-02T09:00:00.000Z" }
  );
  assert.deepEqual(
    plain.dose?.fills?.map((f) => f.exercise),
    ["Bulgarian Split Squat"]
  );
});

test("taper week: the stress budget blocks a dose fill on the legs, and the ledger stands the week down", () => {
  const taper = buildDailySessionDecision(
    pureSnapshot({
      date: "2026-10-21",
      planItems: LOWER_B_ITEMS,
      stress: { race_week_kind: "taper", race_phase: "taper", days_to_race: 11 },
      weekly_dose: QUADS_SHORT,
    }),
    { now: "2026-10-21T09:00:00.000Z" }
  );
  assert.equal(taper.stress?.code, "race_taper_legs");
  assert.equal("dose" in taper, false, "no fill in a taper week");
});

// ---------------------------------------------------------------------------
// taper week, live: nothing fills, the upper day still pairs
// ---------------------------------------------------------------------------

const RACE = "2026-11-01"; // a Sunday: taper week 10-19, race week 10-26

function seedRaceAthlete() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Pendlay Row", "back"],
    ["Back Squat", "quads"],
    ["Leg Extension", "quads"],
    ["Leg Curl", "hamstrings"],
    ["Dumbbell Bench Press", "chest"],
    ["Chest-Supported Row", "back"],
    ["Barbell Curl", "biceps"],
    ["Rope Pushdown", "triceps"],
    ["Deadlift", "hamstrings"],
    ["Bulgarian Split Squat", "quads"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.replacePlan([
    { day_number: 1, name: "Push", items: [item("Barbell Bench Press", 3, 5, 7, 135)] },
    { day_number: 2, name: "Pull", items: [item("Pendlay Row", 3, 6, 8, 150)] },
    {
      day_number: 3,
      name: "Lower A",
      items: [
        item("Back Squat", 3, 5, 7, 185),
        item("Leg Extension", 3, 10, 12, 135),
        item("Leg Curl", 3, 10, 12, 120),
      ],
    },
    {
      day_number: 4,
      name: "Upper & Arms",
      items: [
        item("Dumbbell Bench Press", 3, 8, 10, 55),
        item("Chest-Supported Row", 3, 8, 10, 85),
        item("Barbell Curl", 3, 8, 10, 75),
        item("Rope Pushdown", 3, 10, 12, 57.5),
      ],
    },
    {
      day_number: 5,
      name: "Lower B",
      items: [item("Deadlift", 3, 3, 5, 225), item("Bulgarian Split Squat", 3, 8, 10, 60)],
    },
  ]);
  settlePlanPrescriptions();
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" },
  });
}

test("taper week, live: no dose at all; the upper day still pairs", () => {
  seedRaceAthlete();
  const THU = "2026-10-22";
  assert.equal(readVolumeFloorContext(THU).exempt, "race_taper");
  const ledger = weeklyDoseLedger(THU);
  assert.equal(ledger.applies, false);
  assert.deepEqual(ledger.groups, []);

  const snapshot = gatherDailyDecisionSnapshot(THU);
  assert.equal(snapshot.plan.day_number, 4, "Upper & Arms");
  assert.equal("weekly_dose" in snapshot, false);
  const envelope = buildDailySessionDecision(snapshot, { now: `${THU}T09:00:00.000Z` });
  assert.equal("dose" in envelope, false);
  const card = deterministicComposedSession(envelope);
  const bench = byName(card, "Dumbbell Bench Press");
  const row = byName(card, "Chest-Supported Row");
  const curl = byName(card, "Barbell Curl");
  const pushdown = byName(card, "Rope Pushdown");
  assert.ok(Number.isInteger(bench.superset_group));
  assert.equal(row.superset_group, bench.superset_group, "press + row");
  assert.ok(Number.isInteger(curl.superset_group));
  assert.equal(pushdown.superset_group, curl.superset_group, "curl + pushdown");
  assert.notEqual(bench.superset_group, curl.superset_group);
  for (const it of card.items) assert.equal(it.sets, 3, `${it.exercise} keeps its sets`);
});

// ---------------------------------------------------------------------------
// the athlete's own day, and plan-saved pairs
// ---------------------------------------------------------------------------

function cardEnvelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v7",
    input_fingerprint: "integration-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: "2031-07-01",
    kind: "train",
    baseline_kind: "train",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Arms", intent: "custom" },
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

function seedArms() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Dumbbell Bench Press", "chest"],
    ["Chest-Supported Row", "back"],
    ["Barbell Curl", "biceps"],
    ["Rope Pushdown", "triceps"],
    ["V-Bar Pushdown", "triceps"],
    ["Standing Calf Raise", "calves"],
    ["Leg Press Calf Raise", "calves"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
}

const WRITTEN_DAY = {
  name: "My day",
  focus: "My day",
  why: "x",
  est_minutes: 60,
  items: [
    item("Barbell Bench Press", 3, 8, 10, 135),
    item("Dumbbell Bench Press", 3, 8, 10, 55),
    item("Chest-Supported Row", 3, 8, 10, 85),
    item("Barbell Curl", 3, 8, 10, 75),
    item("Rope Pushdown", 3, 10, 12, 57.5),
    item("V-Bar Pushdown", 2, 10, 12, 60),
    item("Standing Calf Raise", 3, 10, 12, 90),
    item("Leg Press Calf Raise", 3, 10, 12, 120),
  ],
};

test("the athlete's own snapshotted day: no dose, no pairing, non-press duplicates kept, the press rule holds", () => {
  seedArms();
  const env = cardEnvelope({
    dose: {
      gaps: [{ group: "triceps", short: 2 }],
      fills: [{ exercise: "Rope Pushdown", group: "triceps", add_sets: 1, sets: 3 }],
    },
  });
  const own = normalizeComposedSession(clone(WRITTEN_DAY), clone(env), { planSnapshot: true });
  const kept = names(own.session);
  for (const name of ["Rope Pushdown", "V-Bar Pushdown", "Standing Calf Raise", "Leg Press Calf Raise"]) {
    assert.ok(kept.includes(name), `${name} stays on the day they wrote`);
  }
  assert.equal(kept.filter((n) => /Bench Press/.test(n)).length, 1, "two flat presses still fold to one");
  assert.ok(
    own.validation.rejected.every((r) => r.reason === "duplicate_press_angle"),
    JSON.stringify(own.validation.rejected)
  );
  for (const it of own.session.items) assert.equal(it.superset_group, null, `${it.exercise} is not paired`);
  assert.equal(byName(own.session, "Rope Pushdown").sets, 3, "no dose on the athlete's own day");

  // Control: the same card composed by the brain folds the duplicates, pairs and fills.
  const composed = normalizeComposedSession(clone(WRITTEN_DAY), clone(env));
  const composedNames = names(composed.session);
  assert.equal(composedNames.includes("V-Bar Pushdown"), false);
  assert.equal(composedNames.filter((n) => /Calf Raise/.test(n)).length, 1);
  assert.ok(composed.session.items.some((it) => it.superset_group != null));
  assert.equal(byName(composed.session, "Rope Pushdown").sets, 4);
});

test("a plan-saved pairing reaches the card; a member left alone by an exclusion is un-paired", () => {
  seedArms();
  repo.savePlanDay(1, "Arms", "Arms", [
    { ...item("Barbell Curl", 3, 8, 10, 75), superset_group: 7 },
    { ...item("Rope Pushdown", 3, 10, 12, 57.5), superset_group: 7 },
    item("Standing Calf Raise", 3, 10, 12, 90),
  ]);
  settlePlanPrescriptions();
  const template = { day_number: 1, plan_day_id: 1, focus: "Arms", intent: "template" };
  const card = deterministicComposedSession(cardEnvelope({ template }));
  assert.equal(byName(card, "Barbell Curl").superset_group, 7, "the saved group rides onto the card");
  assert.equal(byName(card, "Rope Pushdown").superset_group, 7);
  assert.equal(byName(card, "Barbell Curl").note ?? null, null, "an existing pair is not given a hint");

  const snapshot = deterministicComposedSession(cardEnvelope({ template }), { planSnapshot: true });
  assert.equal(byName(snapshot, "Barbell Curl").superset_group, 7, "the athlete's own pairing shows on their day");

  const alone = deterministicComposedSession(
    cardEnvelope({
      template,
      muscles: { required: [], allowed: [], reduced: [], excluded: ["biceps"], saturated: [], deep: [] },
    })
  );
  assert.equal(byName(alone, "Barbell Curl"), undefined);
  assert.equal(byName(alone, "Rope Pushdown").superset_group, null, "no partner left, no pair");
});

test("pairing reseats the card but never reports a cap", () => {
  seedArms();
  const { session, validation } = normalizeComposedSession(
    {
      name: "Upper",
      focus: "Upper",
      why: "x",
      est_minutes: 40,
      items: [item("Dumbbell Bench Press", 3, 8, 10, 55), item("Chest-Supported Row", 3, 8, 10, 85)],
    },
    cardEnvelope()
  );
  assert.equal(byName(session, "Dumbbell Bench Press").superset_group, 1);
  assert.equal(byName(session, "Chest-Supported Row").superset_group, 1);
  assert.equal(validation.capped, false, "nothing was capped");
});

// ---------------------------------------------------------------------------
// one voice on the eve of a key run
// ---------------------------------------------------------------------------

test("a supporting runner's key-run eve says one thing: the eve line, never 'the run stays optional'", () => {
  const date = "2026-10-02";
  const tomorrow = "2026-10-03";
  const openKeyRun = { intent_id: "run:long:1", kind: "long", suggested_date: tomorrow };
  const withEve = buildDailySessionDecision(
    pureSnapshot({
      date,
      planItems: LOWER_B_ITEMS,
      stress: { ...EVE, key_run: { kind: "long", in_days: 1 } },
      open_key_run: openKeyRun,
    }),
    { now: `${date}T09:00:00.000Z` }
  );
  assert.equal(withEve.stress?.code, "key_run_eve");
  const texts = withEve.rationale.map((r) => r.text);
  assert.ok(
    withEve.rationale.some((r) => r.code === "key_run_eve"),
    JSON.stringify(texts)
  );
  assert.ok(!texts.some((t) => /stays optional/.test(t)), JSON.stringify(texts));

  // Control: the same morning without the eve keeps the supporting-runner line.
  const noEve = buildDailySessionDecision(pureSnapshot({ date, planItems: LOWER_B_ITEMS, open_key_run: openKeyRun }), {
    now: `${date}T09:00:00.000Z`,
  });
  assert.ok(
    noEve.rationale.some((r) => r.code === "training_intent" && /long run stays optional/.test(r.text)),
    JSON.stringify(noEve.rationale)
  );
});
