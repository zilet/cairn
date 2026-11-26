// Lifts and runs composed as one week (src/repo/stress-budget.ts):
//   - the STANDING key-run eve: outside a race build, the last lift day before tomorrow's
//     placed quality or long run trims lower ACCESSORY items by sets only — never a load,
//     never the anchor, never a squat/hinge/lunge compound, never upper body — and stands
//     down for a deload / recovery week, a key run already run, a same-day request;
//   - the WEEKLY HEAVY LOWER ANCHOR guard: on the week's last heavy lower exposure the eve
//     passes over every squat/hinge main lift and its group, and the guard never speaks in
//     a taper, race week, post-race window or recovery week (those weeks are the race's);
//   - a strength-led athlete outside a build gets no other lifting change from the runs.
// Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision } from "../dist/repo/daily-decision.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { raceStrengthPrinciple } from "../dist/repo/race-strength.js";
import {
  KEY_RUN_EVE_ANCHOR_KEPT_RATIONALE,
  KEY_RUN_EVE_RATIONALE,
  KEY_RUN_EVE_STANDING_RATIONALE,
  STANDING_EVE_MAX_DAYS,
  WEEKLY_HEAVY_ANCHOR_KEPT,
  WEEKLY_HEAVY_LOWER_ANCHOR_MIN,
  stressBudgetDecision,
  stressBudgetSnapshot,
} from "../dist/repo/stress-budget.js";
import { db, repo, resetTables } from "./_seed.js";

const NOW = "2026-10-01T12:00:00.000Z";

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
    "garmin_sources",
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

const EXERCISES = [
  ["Barbell Bench Press", "chest"],
  ["Pendlay Row", "back"],
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Extension", "quads"],
  ["Leg Curl", "hamstrings"],
  ["Standing Calf Raise", "calves"],
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
    it("Leg Curl", 3, 120, 10, 12),
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
  for (const date of ["2026-09-08", "2026-09-15"]) {
    for (const [exercise, weight, reps] of WORKING) repo.logSetByName({ date, exercise, weight, reps, day_number: null });
  }
}
const byName = (items, name) => items.find((i) => i.exercise === name && !i.top_set_of);

function snapshot({ date, planItems, stress, ...overrides }) {
  return {
    date,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 3,
      focus: "Lower",
      plan_day_id: 30,
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

const STANDING = { key_run: { kind: "quality", in_days: 1 } };

// ---------- the standing eve: accessories only, sets only ----------

test("standing eve, Lower A: leg extension, leg curl and calf raise lose a set at their load; squat, RDL and bench untouched", () => {
  seedExercises();
  const env = buildDailySessionDecision(snapshot({ date: "2026-09-30", planItems: LOWER_A_ITEMS, stress: STANDING }), {
    now: NOW,
  });
  assert.equal(env.stress?.code, "key_run_eve");
  assert.equal(env.stress.load_held, true, "sets only");
  assert.equal(env.stress.hold_exercise, "Back Squat", "the anchor is passed over by name");
  // Item-scoped (round 7): the leg curl's group reads reduced for the leg curl alone; the
  // RDL beside it is passed over by name.
  assert.deepEqual([...env.muscles.reduced].sort(), ["calves", "hamstrings", "quads"]);
  assert.deepEqual([...env.stress.trim_exercises].sort(), ["Leg Curl", "Leg Extension", "Standing Calf Raise"]);
  assert.ok(!env.muscles.reduced.includes("chest"), "upper body untouched");
  const line = env.rationale.find((r) => r.code === "key_run_eve")?.text;
  assert.ok(
    KEY_RUN_EVE_STANDING_RATIONALE.some((fn) => fn("quality run", "tomorrow") === line),
    `standing wording, not the build's: ${line}`
  );

  const items = normalizeComposedSession(LOWER_A_RAW, env).session.items;
  assert.equal(byName(items, "Back Squat").sets, 3);
  assert.equal(byName(items, "Back Squat").target_weight, 185);
  assert.equal(byName(items, "Romanian Deadlift").sets, 3);
  assert.equal(byName(items, "Romanian Deadlift").target_weight, 205);
  assert.equal(byName(items, "Barbell Bench Press").sets, 3);
  for (const [name, weight] of [
    ["Leg Extension", 135],
    ["Leg Curl", 120],
    ["Standing Calf Raise", 90],
  ]) {
    const item = byName(items, name);
    assert.equal(item.sets, 2, `${name}: one set off`);
    assert.equal(item.target_weight, weight, `${name}: load held`);
  }
});

test("standing eve, Lower B: the split squat is a compound and keeps its group; only the calf raise trims; core untouched", () => {
  const env = buildDailySessionDecision(snapshot({ date: "2026-10-01", planItems: LOWER_B_ITEMS, stress: STANDING }), {
    now: NOW,
  });
  assert.equal(env.stress?.code, "key_run_eve");
  assert.deepEqual(env.muscles.reduced, ["calves"]);
  assert.equal(env.stress.hold_exercise, undefined, "the deadlift's group has nothing to trim");
});

test("standing eve is the next day only: a key run two days out says nothing outside a build", () => {
  assert.equal(STANDING_EVE_MAX_DAYS, 1);
  const env = buildDailySessionDecision(
    snapshot({ date: "2026-09-30", planItems: LOWER_A_ITEMS, stress: { key_run: { kind: "long", in_days: 2 } } }),
    { now: NOW }
  );
  assert.equal("stress" in env, false);
  assert.ok(!env.precedence.includes("key_run_eve"));
});

test("standing eve stands down for a deload phase, a recovery week and a recovery cycle", () => {
  for (const overrides of [
    { program: { mesocycle_phase: "deload", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] } },
    {
      day_read: {
        kind: "train",
        focus: "Lower",
        est_minutes: 55,
        consecutive_training_days: 1,
        recovery_week: true,
        trained_today: false,
      },
    },
  ]) {
    const env = buildDailySessionDecision(
      snapshot({ date: "2026-09-30", planItems: LOWER_A_ITEMS, stress: STANDING, ...overrides }),
      { now: NOW }
    );
    assert.ok(!env.precedence.includes("key_run_eve"), JSON.stringify(overrides));
    assert.notEqual(env.stress?.code, "key_run_eve");
  }
});

test("standing eve stands down when the athlete asked for today's session as it is", () => {
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      stress: STANDING,
      request: {
        override: null,
        train_anyway: false,
        equipment: null,
        minutes: null,
        goal: null,
        same_day_request: { day_number: 3, exercises: ["back squat", "leg extension"], decision_ids: [7] },
      },
    }),
    { now: NOW }
  );
  assert.ok(!env.precedence.includes("key_run_eve"));
  assert.equal(env.stress, undefined);
  for (const g of ["quads", "calves"]) assert.ok(!env.muscles.reduced.includes(g), g);
});

test("standing eve stands down on the week's protected lower day (the weekly lower guarantee)", () => {
  const env = buildDailySessionDecision(
    snapshot({ date: "2026-09-30", planItems: LOWER_A_ITEMS, stress: STANDING, weekly_lower: { last_chance: false } }),
    { now: NOW }
  );
  assert.ok(!env.precedence.includes("key_run_eve"));
  assert.ok(env.precedence.includes("weekly_lower_exposure"));
});

// ---------- the weekly heavy lower anchor guard ----------

const decisionCtx = (planItems, anchor, overrides = {}) => ({
  date: "2026-09-30",
  kind: "train",
  baseKind: "train",
  trainAnyway: false,
  lowerWeekHolds: false,
  weekHeldGroups: new Set(),
  lowerSafetyFloor: false,
  anchor,
  planItems,
  injuryExcluded: [],
  enduranceRole: "supporting",
  snapshot: snapshot({ date: "2026-09-30", planItems }),
  ...overrides,
});

test("guard: in a build week, the last heavy lower exposure keeps the RDL's group whole; accessories still trim", () => {
  assert.equal(WEEKLY_HEAVY_LOWER_ANCHOR_MIN, 1);
  const sb = {
    race_week_kind: "build",
    race_phase: "build",
    days_to_race: 40,
    key_run: { kind: "quality", in_days: 1 },
    heavy_lower_last: true,
  };
  const ctx = decisionCtx(LOWER_A_ITEMS, { exercise: "Back Squat", muscle_group: "quads" });
  const out = stressBudgetDecision(sb, ctx);
  assert.equal(out.code, "key_run_eve");
  assert.deepEqual([...out.reduced].sort(), ["calves", "quads"]);
  assert.equal(out.hold_exercise, "Back Squat");
  assert.equal(out.guard, WEEKLY_HEAVY_ANCHOR_KEPT);
  assert.deepEqual(out.guard_groups, ["hamstrings"]);
  assert.ok(KEY_RUN_EVE_ANCHOR_KEPT_RATIONALE.some((fn) => fn("quality run", "tomorrow") === out.rationale), out.rationale);
  assert.match(out.soft, /weekly_heavy_anchor_kept/);
  // Without the guard the build's eve trims the RDL's group too, as it always has.
  const { heavy_lower_last: _g, ...unguarded } = sb;
  const plain = stressBudgetDecision(unguarded, ctx);
  assert.deepEqual([...plain.reduced].sort(), ["calves", "hamstrings", "quads"]);
  assert.equal(plain.guard, undefined);
  assert.ok(KEY_RUN_EVE_RATIONALE.some((fn) => fn("quality run", "tomorrow") === plain.rationale));
});

test("guard: a full-body day whose first lift is upper keeps every squat/hinge group on the last heavy exposure", () => {
  const items = [
    planItem("Barbell Bench Press", "chest"),
    planItem("Back Squat", "quads"),
    planItem("Leg Extension", "quads"),
    planItem("Standing Calf Raise", "calves"),
  ];
  const sb = {
    race_week_kind: "peak",
    race_phase: "sharpen",
    days_to_race: 20,
    key_run: { kind: "long", in_days: 1 },
    heavy_lower_last: true,
  };
  const out = stressBudgetDecision(sb, decisionCtx(items, { exercise: "Barbell Bench Press", muscle_group: "chest" }));
  assert.deepEqual(out.reduced, ["calves"], "the squat is not the anchor here, so its group is kept whole");
  assert.deepEqual(out.guard_groups, ["quads"]);
});

test("guard: when every trimmable group holds the week's heavy work, the eve says nothing at all", () => {
  const items = [planItem("Back Squat", "quads"), planItem("Romanian Deadlift", "hamstrings"), planItem("Leg Curl", "hamstrings")];
  const sb = { race_week_kind: "build", race_phase: "build", days_to_race: 40, key_run: { kind: "quality", in_days: 1 }, heavy_lower_last: true };
  const out = stressBudgetDecision(sb, decisionCtx(items, { exercise: "Back Squat", muscle_group: "quads" }));
  assert.equal(out.code, null);
  assert.deepEqual(out.reduced, []);
});

test("guard never speaks in the race's own weeks: taper, race week and the post-race window still trim the squat", () => {
  seedExercises();
  const cases = [
    [{ race_week_kind: "taper", race_phase: "taper", days_to_race: 11, heavy_lower_last: true }, "race_taper_legs"],
    [{ race_week_kind: "race", race_phase: "taper", days_to_race: 4, heavy_lower_last: true }, "race_week_legs"],
    [
      { race_recovery: { day_index: 1, days: 4, back_on: "2026-11-06", event: "Riverside Half" }, heavy_lower_last: true },
      "post_race_recovery",
    ],
  ];
  for (const [stress, code] of cases) {
    const env = buildDailySessionDecision(
      snapshot({ date: "2026-10-21", planItems: LOWER_A_ITEMS, stress, weekly_lower: { last_chance: true } }),
      { now: NOW }
    );
    assert.equal(env.stress?.code, code, code);
    assert.ok(!env.precedence.includes("weekly_lower_exposure"), `${code}: the guarantee is suspended`);
    const squat = env.candidates.find((c) => c.exercise === "Back Squat");
    assert.equal(squat.reason_code, code, `${code}: the squat is the race week's to trim`);
  }
});

test("guard never forces a heavy session in a recovery week: the eve stands down and nothing holds the legs", () => {
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-09-30",
      planItems: LOWER_A_ITEMS,
      stress: { key_run: { kind: "quality", in_days: 1 }, heavy_lower_last: true },
      weekly_lower: { last_chance: true },
      program: { mesocycle_phase: "recovery", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    }),
    { now: NOW }
  );
  assert.ok(!env.precedence.includes("key_run_eve"));
  assert.ok(!env.precedence.includes("weekly_lower_exposure"), "the safety floor stands the guarantee down");
});

// ---------- the gather half against a real week ----------

const daysBefore = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

// Six weeks of Tue / Thu / Sun running before `asOf`'s week.
function seedRuns(asOf) {
  const monday = daysBefore(asOf, (new Date(`${asOf}T00:00:00Z`).getUTCDay() + 6) % 7);
  for (let wk = 1; wk <= 6; wk++) {
    const mon = daysBefore(monday, wk * 7);
    repo.addActivity({ type: "run", duration_min: 45, distance_km: 7, date: daysBefore(mon, -1) });
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: daysBefore(mon, -3) });
    repo.addActivity({ type: "run", duration_min: 95, distance_km: 15, date: daysBefore(mon, -6) });
  }
}

// Two lifting days (Mon upper, Wed Lower A), quality Thursday, long Sunday, no race.
function seedTwoDayLifter() {
  for (const [name, group] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  repo.replacePlan([
    { day_number: 1, name: "Upper", items: [it("Barbell Bench Press", 3, 135, 5, 7), it("Pendlay Row", 3, 150)] },
    { day_number: 2, name: "Lower A", items: LOWER_A_RAW.items.slice(0, 5) },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [{ dow: 1 }, { dow: 3 }], source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: null,
  });
}

test("gather: no race on file, Wednesday before Thursday's quality run is a standing eve and the week's last heavy lower day", () => {
  seedTwoDayLifter();
  seedRuns("2026-09-30");
  const ctx = { dayType: "training", planItems: LOWER_A_RAW.items.slice(0, 5), enduranceRole: "supporting" };
  const wed = stressBudgetSnapshot("2026-09-30", ctx);
  assert.deepEqual(wed, { key_run: { kind: "quality", in_days: 1 }, heavy_lower_last: true }, JSON.stringify(wed));
  // The key run already run on Tuesday: no eve left to protect.
  const run = repo.addActivity({ type: "run", date: "2026-09-29", duration_min: 50, distance_km: 9.7 });
  const source = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'standing')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, te_label, aerobic_te)
     VALUES (?, 'standing-run', ?, ?, 'running', 'THRESHOLD', 3.6)`
  ).run(source.lastInsertRowid, run.id, "2026-09-29");
  assert.equal(stressBudgetSnapshot("2026-09-30", ctx), undefined);
});

test("gather: a full-load lower session already logged this week lifts the guard", () => {
  seedTwoDayLifter();
  seedRuns("2026-09-30");
  for (const date of ["2026-09-14", "2026-09-21"]) {
    for (let i = 0; i < 3; i++) repo.logSetByName({ date, exercise: "Back Squat", weight: 185, reps: 6 });
  }
  // An extra Tuesday leg session at full load and full sets.
  for (let i = 0; i < 3; i++) repo.logSetByName({ date: "2026-09-29", exercise: "Back Squat", weight: 185, reps: 6 });
  const wed = stressBudgetSnapshot("2026-09-30", {
    dayType: "training",
    planItems: LOWER_A_RAW.items.slice(0, 5),
    enduranceRole: "supporting",
  });
  assert.deepEqual(wed?.key_run, { kind: "quality", in_days: 1 }, JSON.stringify(wed));
  assert.equal(wed.heavy_lower_last, undefined);
});

test("gather: an upper card on the eve says nothing, and endurance role none says nothing", () => {
  seedTwoDayLifter();
  seedRuns("2026-09-30");
  assert.equal(
    stressBudgetSnapshot("2026-09-30", {
      dayType: "training",
      planItems: [it("Barbell Bench Press", 3, 135)],
      enduranceRole: "supporting",
    }),
    undefined
  );
  assert.equal(
    stressBudgetSnapshot("2026-09-30", {
      dayType: "training",
      planItems: LOWER_A_RAW.items.slice(0, 5),
      enduranceRole: "none",
    }),
    undefined
  );
});

// ---------- a strength-led athlete outside a build ----------

test("strength-led outside a build: the lifting keeps progressing and the standing eve is the only change", () => {
  const principle = raceStrengthPrinciple({ phase: "base", kind: "build", lead: "strength_led" });
  assert.equal(principle.mode, "progression");
  assert.equal(principle.upper_progresses, true);
  // A lower day that is no key run's eve: nothing from the run calendar at all.
  const plain = buildDailySessionDecision(snapshot({ date: "2026-09-28", planItems: LOWER_A_ITEMS }), { now: NOW });
  assert.equal("stress" in plain, false);
  // The eve: only isolation-tier lower work — never a compound, never upper body.
  const out = stressBudgetDecision(STANDING, decisionCtx(LOWER_A_ITEMS, { exercise: "Back Squat", muscle_group: "quads" }));
  assert.equal(out.scope, "standing");
  assert.equal(out.load_held, true);
  assert.deepEqual(out.excluded, []);
  assert.deepEqual([...out.reduced].sort(), ["calves", "hamstrings", "quads"]);
  assert.deepEqual([...out.trim_exercises].sort(), ["Leg Curl", "Leg Extension", "Standing Calf Raise"]);
});

// ---------- the athlete-facing lines ----------

test("the standing and guard lines are variant sets that hold the reading grammar", () => {
  for (const set of [KEY_RUN_EVE_STANDING_RATIONALE, KEY_RUN_EVE_ANCHOR_KEPT_RATIONALE]) {
    assert.ok(set.length >= 4);
    const lines = set.flatMap((fn) => [fn("quality run", "tomorrow"), fn("long run", "tomorrow"), fn("long run", "in two days")]);
    assert.equal(new Set(lines).size, lines.length);
    for (const line of lines) {
      assert.equal(violatesReadingGrammar(line), null, line);
      assert.ok(!/\d/.test(line), `no numbers: ${line}`);
    }
  }
});
