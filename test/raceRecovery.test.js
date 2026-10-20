// The days after a race (src/repo/race-recovery.ts): ONE read of the post-race recovery
// window — 2 days after a race up to 10 km, 4 after a half, 7 after a marathon, counted
// from race day + 1 — and every consumer of it:
//   - the stress budget's `post_race_recovery` code: every group on the card REDUCED
//     (composition's ordinary clamp: two working sets, the eased load, a hold rather than
//     a step), legs on the card and never excluded, no reach, a push stance never widens;
//   - the run engine: easy and short only inside the window, no quality or long run; the
//     next week restarts from the training volume, never the race's own kilometres, and
//     the race neither sets the long-run ladder nor reads as harm;
//   - the day read: a training day said lighter, never a rest by itself;
//   - the surfaces: the week frame and the race lane say it once; quiet once it ends.
// Synthetic fixtures only; deterministic and offline.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { harmEvidenceOnDay } from "../dist/repo/brain/read-adherence.js";
import { flexibleTrainingAgenda } from "../dist/repo/flexible-training-agenda.js";
import { normalizeComposedSession, REDUCED_AREA_NOTES } from "../dist/repo/daily-composition.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { dayRead } from "../dist/repo/day-read.js";
import { legTrimFocus, legTrimNote } from "../dist/repo/plan-day-focus.js";
import { calendarLegTrim } from "../dist/repo/plan-day-trim.js";
import { raceBuild } from "../dist/repo/race-build.js";
import {
  backOnWords,
  RACE_RECOVERY_LINES,
  raceRecoveryLine,
  isRaceDay,
  raceRecoveryShape,
  raceRecoveryWindow,
  raceRunDates,
} from "../dist/repo/race-recovery.js";
import { preRaceRunCapacity } from "../dist/repo/run-capacity.js";
import { demonstratedRunCapacity } from "../dist/repo/run-capacity.js";
import {
  POST_RACE_EASY_RUN_NOTES,
  POST_RACE_RESTART_VARIANTS,
  POST_RACE_WINDOW_VARIANTS,
  weeklyRunPlan,
} from "../dist/repo/run-progression.js";
import {
  POST_RACE_RECOVERY_ITEM_NOTES,
  POST_RACE_RECOVERY_RATIONALE,
  stressBudgetDecision,
  stressBudgetSnapshot,
  stressBudgetSuspendsWeeklyLower,
} from "../dist/repo/stress-budget.js";
import { weekFrameLine } from "../dist/repo/week-stage.js";
import { db } from "../dist/db.js";
import { repo, resetTables } from "./_seed.js";

const RACE = "2026-11-01"; // a Sunday half: the window is Mon 11-02 .. Thu 11-05
const NOW = "2026-11-02T12:00:00.000Z";

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

const EXERCISES = [
  ["Barbell Bench Press", "chest"],
  ["Pendlay Row", "back"],
  ["Back Squat", "quads"],
  ["Romanian Deadlift", "hamstrings"],
  ["Leg Extension", "quads"],
  ["Standing Calf Raise", "calves"],
  ["Dumbbell Bench Press", "chest"],
  ["Barbell Curl", "biceps"],
  ["Deadlift", "hamstrings"],
  ["Bulgarian Split Squat", "quads"],
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
      it("Back Squat", 4, 185, 5, 7),
      it("Romanian Deadlift", 3, 205),
      it("Leg Extension", 3, 135, 10, 12),
      it("Standing Calf Raise", 3, 90, 10, 12),
    ],
  },
  {
    day_number: 4,
    name: "Upper & Arms",
    items: [it("Dumbbell Bench Press", 3, 55, 8, 10), it("Barbell Curl", 3, 75, 8, 10)],
  },
  { day_number: 5, name: "Lower B", items: [it("Deadlift", 3, 225, 3, 5), it("Bulgarian Split Squat", 3, 60, 8, 10)] },
];

function seedAthlete({ goal } = {}) {
  for (const [name, group] of EXERCISES) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  repo.replacePlan(PLAN);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }], source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 6, kind: "long" },
      ],
    },
    endurance_goal:
      goal === null
        ? null
        : { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00", ...(goal ?? {}) },
  });
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Three training weeks before the race week (Tue 7 / Thu 7 / Sat 15), a taper race week
// (Tue 6 / Thu 5) and the race itself on Sunday. (Three, not six: six loaded weeks in a
// row would read deload-due on their own, and the read under test is the race's.)
function seedRunning({ raceOn = RACE, raceKm = 21.1 } = {}) {
  const raceMonday = "2026-10-26";
  for (let wk = 1; wk <= 3; wk++) {
    const mon = addDays(raceMonday, -7 * wk);
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: addDays(mon, 1) });
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: addDays(mon, 3) });
    repo.addActivity({ type: "run", duration_min: 95, distance_km: 15, date: addDays(mon, 5) });
  }
  repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: "2026-10-27" });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-10-29" });
  if (raceOn) repo.addActivity({ type: "run", duration_min: 118, distance_km: raceKm, date: raceOn });
}
const logRace = (distance_km, date = RACE) =>
  repo.addActivity({ type: "run", duration_min: Math.round(distance_km * 5.6), distance_km, date });

const WORKING = [
  ["Barbell Bench Press", 135, 6],
  ["Back Squat", 185, 6],
  ["Romanian Deadlift", 205, 7],
  ["Leg Extension", 135, 11],
  ["Standing Calf Raise", 90, 11],
];
function seedLifting() {
  for (const date of ["2026-10-13", "2026-10-20"]) {
    for (const [exercise, weight, reps] of WORKING)
      repo.logSetByName({ date, exercise, weight, reps, day_number: null });
  }
}

// ---------------------------------------------------------------------------
// the one read
// ---------------------------------------------------------------------------

test("a half marathon: four days from race day + 1, then nothing", () => {
  seedAthlete();
  logRace(21.1);
  assert.equal(raceRecoveryWindow("2026-10-31"), null, "a race not yet run");
  assert.equal(raceRecoveryWindow(RACE), null, "race day itself is the race, not recovery");
  const first = raceRecoveryWindow("2026-11-02");
  assert.deepEqual(first, {
    race: { event: "Riverside Half", date: RACE, distance_km: 21.1, goal_date: RACE, provisional: false },
    day_index: 1,
    days: 4,
    ends_on: "2026-11-05",
    back_on: "2026-11-06",
    kind: "half",
  });
  assert.equal(raceRecoveryWindow("2026-11-05").day_index, 4);
  assert.equal(raceRecoveryWindow("2026-11-06"), null, "back to normal");
});

test("the window scales with distance: a 10k two days", () => {
  assert.deepEqual(raceRecoveryShape(10), { days: 2, kind: "short" });
  assert.deepEqual(raceRecoveryShape(5), { days: 2, kind: "short" });
  assert.deepEqual(raceRecoveryShape(21.0975), { days: 4, kind: "half" });
  assert.deepEqual(raceRecoveryShape(42.2), { days: 7, kind: "marathon" });
  assert.equal(raceRecoveryShape(0), null);

  seedAthlete({ goal: { event: "Parkside 10K", distance_km: 10 } });
  logRace(10.1);
  assert.equal(raceRecoveryWindow("2026-11-03").day_index, 2);
  assert.equal(raceRecoveryWindow("2026-11-04"), null);
});

test("the window scales with distance: a marathon seven days", () => {
  seedAthlete({ goal: { event: "City Marathon", distance_km: 42.2 } });
  logRace(42.4);
  assert.equal(raceRecoveryWindow("2026-11-08").day_index, 7);
  assert.equal(raceRecoveryWindow("2026-11-09"), null);
});

test("no goal, a standing goal: no window", () => {
  seedAthlete({ goal: null });
  logRace(21.1);
  assert.equal(raceRecoveryWindow("2026-11-02"), null);
  seedAthlete({ goal: { mode: "standing", label: "10k-ready", date: null } });
  assert.equal(raceRecoveryWindow("2026-11-02"), null);
});

// ---------------------------------------------------------------------------
// which race: the logged effort, kept past the goal slot (race-results.ts)
// ---------------------------------------------------------------------------

const keptRaces = () =>
  db.prepare("SELECT goal_date, distance_km, event, run_date, activity_id, run_km FROM completed_races").all();

test("a new goal set on race + 1 keeps the window and the race's exclusions", () => {
  seedAthlete();
  seedRunning();
  // The morning after: the next race goes in.
  repo.setProfile({ endurance_goal: { mode: "race", event: "Winter 5K", date: "2026-12-06", distance_km: 5 } });
  const kept = keptRaces();
  assert.equal(kept.length, 1);
  const raceRun = db.prepare("SELECT id FROM activities WHERE date = ? AND distance_km = 21.1").get(RACE);
  assert.deepEqual(
    { ...kept[0] },
    {
      goal_date: RACE,
      distance_km: 21.1,
      event: "Riverside Half",
      run_date: RACE,
      activity_id: raceRun.id,
      run_km: 21.1,
    }
  );

  const win = raceRecoveryWindow("2026-11-02");
  assert.equal(win?.race.event, "Riverside Half");
  assert.equal(win?.day_index, 1);
  assert.equal(raceRecoveryWindow("2026-11-05")?.day_index, 4);
  assert.equal(raceRecoveryWindow("2026-11-06"), null);
  assert.equal(
    stressBudgetSnapshot("2026-11-03", { dayType: "training", planItems: PLAN[2].items, enduranceRole: "supporting" })
      ?.race_recovery?.event,
    "Riverside Half"
  );

  // The race day stays the race: not harm, not capacity, not yesterday's novelty.
  assert.equal(harmEvidenceOnDay(RACE, { domain: "running" }), null);
  const shown = demonstratedRunCapacity(RACE);
  assert.equal(shown.long_km, 15);
  assert.equal(shown.floor_km, 29);
  assert.equal(dayRead("2026-11-02").signals?.endurance_yesterday?.longest_run, undefined);

  // And the run engine still caps the window's runs easy and short.
  const plan = weeklyRunPlan("2026-11-02", { adjustToday: false });
  for (const r of plan.runs.filter((run) => runDate(plan, run) <= "2026-11-05")) {
    assert.equal(r.kind_label, "easy", `${runDate(plan, r)}: ${r.label}`);
    assert.ok(r.target_distance_km <= 6, `${runDate(plan, r)}: ${r.target_distance_km}`);
  }

  // Setting the goal again (or a third one) keeps the one record.
  repo.setProfile({ endurance_goal: { mode: "race", event: "Spring 10K", date: "2027-03-01", distance_km: 10 } });
  assert.equal(keptRaces().length, 1, "the 5k was not run: a goal that changed, nothing kept");
});

test("a goal changed long before its race date, with nothing run, keeps nothing", () => {
  seedAthlete({ goal: { date: "2099-05-03" } });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Other Half", date: "2099-06-07", distance_km: 21.1 } });
  assert.deepEqual(keptRaces(), []);
});

test("the race logged the day before the goal date opens the window from the run's day", () => {
  seedAthlete();
  seedRunning({ raceOn: "2026-10-31" });
  // The goal date itself carries only a short shake-out: an ordinary run day.
  repo.addActivity({ type: "run", duration_min: 25, distance_km: 4, date: RACE });
  assert.equal(raceRecoveryWindow("2026-10-31"), null, "the race day itself");
  const first = raceRecoveryWindow(RACE);
  assert.equal(first?.day_index, 1, "the goal date is the first day after the race");
  assert.equal(first?.race.date, "2026-10-31");
  assert.equal(first?.race.goal_date, RACE);
  assert.equal(first?.ends_on, "2026-11-04");
  assert.equal(first?.back_on, "2026-11-05");
  assert.equal(raceRecoveryWindow("2026-11-04")?.day_index, 4);
  assert.equal(raceRecoveryWindow("2026-11-05"), null);

  assert.equal(isRaceDay("2026-10-31"), true);
  assert.equal(isRaceDay(RACE), false, "the empty goal date is an ordinary day");
  assert.equal(isRaceDay(RACE, "2026-11-02"), false);
  assert.deepEqual([...raceRunDates("2026-10-26", "2026-11-08")], ["2026-10-31"]);
  assert.equal(harmEvidenceOnDay("2026-10-31", { domain: "running" }), null, "the race is the build's dose");
  const shown = demonstratedRunCapacity(RACE);
  assert.equal(shown.long_km, 15, "the race never sets the ladder");
  assert.equal(shown.floor_km, 29);
  // The morning after the race (the goal date): not a "longest in months".
  assert.equal(dayRead(RACE).signals?.endurance_yesterday?.longest_run, undefined);
  // Before the goal date comes, a run ahead of it is not yet the race.
  assert.equal(isRaceDay("2026-10-31", "2026-10-31"), false);
});

test("no race logged: a two-day slow-sync grace, then no window and nothing blanked", () => {
  seedAthlete();
  seedRunning({ raceOn: null });
  // A 15 km run on the goal date is not a half's effort.
  repo.addActivity({ type: "run", duration_min: 95, distance_km: 15, date: RACE });
  const grace = raceRecoveryWindow("2026-11-02");
  assert.equal(grace?.race.provisional, true, "the goal date stands in while the race may still sync");
  assert.equal(raceRecoveryWindow("2026-11-03")?.day_index, 2);
  assert.equal(raceRecoveryWindow("2026-11-04"), null, "past the grace: no race, no window");
  assert.equal(raceRecoveryWindow("2026-11-05"), null);
  assert.equal(isRaceDay(RACE), false, "nothing race-like: the goal date is not blanked");
  assert.deepEqual([...raceRunDates(null, "2026-11-30")], []);
  assert.match(raceBuild("2026-11-04").reason, /behind you/);

  // The race synced late: the window is the race's again.
  logRace(21.2);
  assert.equal(raceRecoveryWindow("2026-11-04")?.day_index, 3);
  assert.equal(raceRecoveryWindow("2026-11-04")?.race.provisional, false);
});

test("a short race off its goal date must be race-paced; a training run of its length is not it", () => {
  seedAthlete({ goal: { event: "Parkside 5K", distance_km: 5 } });
  for (const date of ["2026-10-06", "2026-10-09", "2026-10-13", "2026-10-16", "2026-10-20", "2026-10-23"])
    repo.addActivity({ type: "run", duration_min: 33, distance_km: 5.5, date });
  // Friday's easy 5 km, two days before the goal date: training pace.
  repo.addActivity({ type: "run", duration_min: 31, distance_km: 5, date: "2026-10-30" });
  assert.equal(isRaceDay("2026-10-30"), false);
  // Saturday's 5 km at race pace: the race, a day early.
  repo.addActivity({ type: "run", duration_min: 23, distance_km: 5.05, date: "2026-10-31" });
  assert.equal(isRaceDay("2026-10-31"), true);
  assert.equal(raceRecoveryWindow(RACE)?.race.date, "2026-10-31");
});

// ---------------------------------------------------------------------------
// lifting: the stress budget's post-race code through the ordinary reduced lists
// ---------------------------------------------------------------------------

function snapshot({ date, planItems, stress, ...overrides }) {
  return {
    date,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 3,
      focus: "Lower A",
      plan_day_id: 30,
      day_type: "training",
      source: "adaptive",
      reason: null,
      due: [],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Lower A",
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
  planItem("Standing Calf Raise", "calves"),
  planItem("Barbell Bench Press", "chest"),
];
const LOWER_A_RAW = {
  name: "Lower A",
  focus: "Lower A",
  why: "x",
  est_minutes: 55,
  items: [
    it("Back Squat", 4, 185, 5, 7),
    it("Romanian Deadlift", 3, 205),
    it("Leg Extension", 3, 135, 10, 12),
    it("Standing Calf Raise", 3, 90, 10, 12),
    it("Barbell Bench Press", 3, 135, 5, 7),
  ],
};
const RECOVERY = { race_recovery: { day_index: 3, days: 4, back_on: "2026-11-06", event: "Riverside Half" } };
const byName = (items, name) => items.find((i) => i.exercise === name);

// The stored prescription is the plan's own (a race-scoped plan adaptation restored on
// race + 1 puts exactly this back): the window never fights it, it doses it lighter.
test("day 3 of the window: every lift fewer sets at an eased load, legs on the card, no step and no reach", () => {
  seedAthlete();
  seedLifting();
  const env = buildDailySessionDecision(
    snapshot({
      date: "2026-11-04",
      planItems: LOWER_A_ITEMS,
      stress: RECOVERY,
      weekly_lower: { last_chance: true },
      progression: [
        {
          exercise: "Back Squat",
          action: "overload",
          why: "Top of the range last time",
          current_target: { mode: "reps", sets: 4, rep_low: 5, rep_high: 7, target_weight: 185, target_seconds: null },
          suggested_target: {
            mode: "reps",
            sets: 4,
            rep_low: 5,
            rep_high: 7,
            target_weight: 190,
            target_seconds: null,
          },
        },
      ],
    }),
    { now: NOW }
  );
  assert.equal(env.stress.code, "post_race_recovery");
  assert.deepEqual([...env.stress.groups].sort(), ["calves", "chest", "hamstrings", "quads"]);
  assert.deepEqual(env.muscles.excluded, [], "legs stay ON the card");
  assert.ok(env.precedence.includes("post_race_recovery"));
  assert.ok(!env.precedence.includes("weekly_lower_exposure"), "the window stands the weekly lower guarantee down");
  const line = env.rationale.find((r) => r.code === "post_race_recovery");
  assert.ok(line && /Riverside Half/.test(line.text) && /Fri/.test(line.text), line?.text);
  assert.equal(env.caps.intensity, "hold", "never a load step, never a challenge set");
  assert.equal(env.caps.volume, "reduced");
  assert.equal(env.reach.level, null);
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "hold", "an earned step waits until the window ends");

  const items = normalizeComposedSession(LOWER_A_RAW, env).session.items;
  for (const [name, sets, eased] of [
    ["Back Squat", 2, 165],
    ["Romanian Deadlift", 2, 180],
    ["Leg Extension", 2, 120],
    ["Standing Calf Raise", 2, 80],
    ["Barbell Bench Press", 2, 120],
  ]) {
    const item = byName(
      items.filter((i) => !i.top_set_of),
      name
    );
    assert.ok(item, `${name} stays on the card`);
    assert.equal(item.sets, sets, `${name}: fewer sets`);
    assert.equal(item.target_weight, eased, `${name}: the eased load on its grid`);
    assert.ok(!item.reach && !item.top_set, `${name}: no challenge set`);
    assert.ok(
      POST_RACE_RECOVERY_ITEM_NOTES.some((n) => item.note.startsWith(n.replace(/[.]+$/, ""))),
      `${name}: ${item.note}`
    );
    assert.ok(!REDUCED_AREA_NOTES.some((n) => item.note.includes(n)), `${name}: ${item.note}`);
  }
  assert.ok(!items.some((i) => i.top_set_of), "no top set rides on any lift");
});

const STANCE_SUPPORT = {
  training_drive: "push",
  backed: false,
  backed_by: [],
  training_directive: "proceed",
  fresh_brake: false,
  push_stance: { until: "2026-11-20", harm_free: true },
};

test("a push stance cannot widen anything inside the window; it does again once it ends", () => {
  const upper = [planItem("Barbell Bench Press", "chest"), planItem("Pendlay Row", "back")];
  const inside = buildDailySessionDecision(
    snapshot({ date: "2026-11-03", planItems: upper, stress: RECOVERY, signal_support: STANCE_SUPPORT }),
    { now: NOW }
  );
  assert.equal(inside.reach.level, null);
  assert.ok(!inside.precedence.includes("push_stance"));
  assert.equal(inside.caps.intensity, "hold");
  const after = buildDailySessionDecision(
    snapshot({ date: "2026-11-06", planItems: upper, signal_support: STANCE_SUPPORT }),
    { now: NOW }
  );
  assert.equal(after.reach.level, "push", "the stance is the athlete's again after the window");
  assert.equal("stress" in after, false);
});

test("a rest read stays the read's; the window never adds a rest of its own", () => {
  const rest = stressBudgetDecision(RECOVERY, {
    date: "2026-11-02",
    kind: "rest",
    baseKind: "rest",
    trainAnyway: false,
    lowerWeekHolds: false,
    weekHeldGroups: new Set(),
    lowerSafetyFloor: false,
    anchor: null,
    planItems: LOWER_A_ITEMS,
    injuryExcluded: [],
    enduranceRole: "supporting",
    snapshot: {},
  });
  assert.equal(rest.code, null);
  const none = stressBudgetDecision(RECOVERY, {
    date: "2026-11-02",
    kind: "train",
    baseKind: "train",
    trainAnyway: false,
    lowerWeekHolds: false,
    weekHeldGroups: new Set(),
    lowerSafetyFloor: false,
    anchor: null,
    planItems: LOWER_A_ITEMS,
    injuryExcluded: [],
    enduranceRole: "none",
    snapshot: {},
  });
  assert.equal(none.code, "post_race_recovery", "the race was run whatever the role");
  assert.equal(stressBudgetSuspendsWeeklyLower(RECOVERY), true);
});

test("gather end to end: inside the window the snapshot carries it; the day after, nothing", () => {
  seedAthlete();
  seedRunning();
  seedLifting();
  const items = PLAN[2].items;
  assert.deepEqual(
    stressBudgetSnapshot("2026-11-04", { dayType: "training", planItems: items, enduranceRole: "supporting" }),
    {
      race_recovery: { day_index: 3, days: 4, back_on: "2026-11-06", event: "Riverside Half" },
    }
  );
  assert.equal(
    stressBudgetSnapshot("2026-11-06", { dayType: "training", planItems: items, enduranceRole: "supporting" }),
    undefined
  );
  assert.equal(calendarLegTrim("2026-11-04", items), "post_race_recovery", "a day ahead reads the same trim");
  assert.equal(calendarLegTrim("2026-11-06", items), null);

  const snap = gatherDailyDecisionSnapshot("2026-11-04");
  assert.ok(snap.stress_budget?.race_recovery, JSON.stringify(snap.stress_budget));
  const env = buildDailySessionDecision(snap, { now: NOW });
  assert.equal(env.stress?.code, "post_race_recovery");
  assert.deepEqual(
    env.muscles.excluded.filter((g) => ["quads", "hamstrings", "calves"].includes(g)),
    []
  );
  const after = gatherDailyDecisionSnapshot("2026-11-06");
  assert.equal(after.stress_budget?.race_recovery, undefined);
});

// ---------------------------------------------------------------------------
// running: easy and short inside the window; the race is never training
// ---------------------------------------------------------------------------

const runDate = (plan, run) => addDays(plan.week_start, run.day_number - 1);

test("the week after the half: easy and short through Thursday, no quality; Saturday's long run is training-sized", () => {
  seedAthlete();
  seedRunning();
  const plan = weeklyRunPlan("2026-11-02", { adjustToday: false });
  assert.equal(plan.available, true);
  const inWindow = plan.runs.filter((r) => runDate(plan, r) <= "2026-11-05");
  assert.ok(inWindow.length >= 1, JSON.stringify(plan.runs));
  for (const r of inWindow) {
    assert.equal(r.kind_label, "easy", `${runDate(plan, r)}: ${r.label}`);
    assert.ok(r.target_distance_km <= 6, `${runDate(plan, r)}: short (${r.target_distance_km})`);
  }
  const thursday = plan.runs.find((r) => runDate(plan, r) === "2026-11-05");
  assert.ok(thursday, "the stated quality day keeps its run, as an easy one");
  assert.ok(
    POST_RACE_EASY_RUN_NOTES.some((fn) => fn(thursday.target_zone) === thursday.note),
    thursday.note
  );
  assert.equal(plan.quality_focus, null);
  assert.ok(
    plan.rationale.some((l) => POST_RACE_WINDOW_VARIANTS.includes(l)),
    plan.rationale.join(" | ")
  );
  // The restart reads the training weeks, never the race's kilometres.
  assert.ok(
    plan.rationale.some((l) => POST_RACE_RESTART_VARIANTS.some((fn) => fn("Riverside Half") === l)),
    plan.rationale.join(" | ")
  );
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.ok(long, "the long run after the window is the week's own");
  assert.ok(runDate(plan, long) > "2026-11-05");
  assert.ok(long.target_distance_km < 21.1, `the race never sets the ladder (${long.target_distance_km})`);
  assert.ok(
    long.target_distance_km <= 15 * 1.15 + 0.05,
    `stepped off the training long run (${long.target_distance_km})`
  );
});

test("the rolling agenda agrees: nothing but easy running is suggested inside the window", () => {
  seedAthlete();
  seedRunning();
  const agenda = flexibleTrainingAgenda("2026-11-02");
  assert.equal(agenda.available, true);
  for (const intent of agenda.intents) {
    if (intent.suggested_date && intent.suggested_date <= "2026-11-05")
      assert.equal(intent.kind, "easy", `${intent.suggested_date}: ${intent.kind}`);
  }
  assert.ok(
    !agenda.intents.some((i) => i.kind === "quality"),
    JSON.stringify(agenda.intents.map((i) => [i.kind, i.suggested_date]))
  );
});

test("the week after that is ordinary again: the quality run is back", () => {
  seedAthlete();
  seedRunning();
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-11-03" });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-11-05" });
  repo.addActivity({ type: "run", duration_min: 80, distance_km: 13, date: "2026-11-07" });
  const plan = weeklyRunPlan("2026-11-09", { adjustToday: false });
  assert.ok(
    plan.runs.some((r) => r.kind_label === "quality"),
    JSON.stringify(plan.runs)
  );
  assert.ok(!plan.rationale.some((l) => POST_RACE_WINDOW_VARIANTS.includes(l)));
});

const weekKm = (plan) => plan.runs.reduce((sum, r) => sum + (Number(r.target_distance_km) || 0), 0);
const RESTARTED = (plan, event) => plan.rationale.some((l) => POST_RACE_RESTART_VARIANTS.some((fn) => fn(event) === l));

test("half: the week after the window's capped days resumes toward the pre-race floor; the long run is training-sized", () => {
  seedAthlete();
  seedRunning();
  const pre = preRaceRunCapacity(RACE);
  assert.equal(pre.floor_km, 29, "the best training week going in, the race never in it");
  assert.equal(pre.long_km, 15);
  // He ran the restart week as planned: two capped shake-outs, a modest Saturday.
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-11-03" });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-11-05" });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 9, date: "2026-11-07" });
  const plan = weeklyRunPlan("2026-11-09", { adjustToday: false });
  assert.ok(RESTARTED(plan, "Riverside Half"), plan.rationale.join(" | "));
  const km = weekKm(plan);
  assert.ok(km > 19 + 2, `resumed past the capped week's 19 km (${km})`);
  assert.ok(km <= 29 + 0.5, `toward the pre-race floor, never past it (${km})`);
  const long = plan.runs.find((r) => r.kind_label === "long");
  assert.ok(long, JSON.stringify(plan.runs));
  assert.ok(long.target_distance_km >= 9, `the long run steps off the pre-race long run (${long.target_distance_km})`);
  assert.ok(!plan.rationale.some((l) => POST_RACE_WINDOW_VARIANTS.includes(l)), "no run is in the window");
  // The week after that is ordinary: its closed week sat wholly outside the window.
  repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: "2026-11-10" });
  repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: "2026-11-12" });
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 14, date: "2026-11-14" });
  assert.ok(!RESTARTED(weeklyRunPlan("2026-11-16", { adjustToday: false }), "Riverside Half"));
});

// A marathon block: three weeks of 10 / 10 / 30, the last 30 km long run four weeks out
// (it has aged out of the 28-day lookback by the week after the window), a two-week taper,
// then the race on Sunday 11-01. The window is the whole next week (Mon 11-02 .. Sun 11-08).
function seedMarathon() {
  for (const mon of ["2026-09-21", "2026-09-28", "2026-10-05"]) {
    repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: addDays(mon, 1) });
    repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: addDays(mon, 3) });
    repo.addActivity({ type: "run", duration_min: 190, distance_km: 30, date: addDays(mon, 5) });
  }
  repo.addActivity({ type: "run", duration_min: 50, distance_km: 8, date: "2026-10-13" });
  repo.addActivity({ type: "run", duration_min: 50, distance_km: 8, date: "2026-10-15" });
  repo.addActivity({ type: "run", duration_min: 130, distance_km: 20, date: "2026-10-17" });
  repo.addActivity({ type: "run", duration_min: 40, distance_km: 6, date: "2026-10-20" });
  repo.addActivity({ type: "run", duration_min: 40, distance_km: 6, date: "2026-10-22" });
  repo.addActivity({ type: "run", duration_min: 90, distance_km: 14, date: "2026-10-24" });
  repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: "2026-10-27" });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-10-29" });
  repo.addActivity({ type: "run", duration_min: 250, distance_km: 42.3, date: RACE });
}

test("marathon: the capped recovery week is never the next base, and the long run is not stuck at 6 km", () => {
  seedAthlete({ goal: { event: "City Marathon", distance_km: 42.2, target: "sub-4:00" } });
  seedMarathon();
  // The day after, a spring 10k goes in.
  repo.setProfile({ endurance_goal: { mode: "race", event: "Spring 10K", date: "2027-04-11", distance_km: 10 } });
  const pre = preRaceRunCapacity(RACE);
  assert.ok(pre.floor_km >= 50, JSON.stringify(pre));
  assert.equal(pre.long_km, 30, "the eight-week long run, taken before the taper");

  // The recovery week: every run easy and short.
  const restart = weeklyRunPlan("2026-11-02", { adjustToday: false });
  assert.ok(RESTARTED(restart, "City Marathon"), restart.rationale.join(" | "));
  for (const r of restart.runs) {
    assert.equal(r.kind_label, "easy", `${runDate(restart, r)}: ${r.label}`);
    assert.ok(r.target_distance_km <= 6, `${runDate(restart, r)}: ${r.target_distance_km}`);
  }
  // He ran it as written.
  repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: "2026-11-03" });
  repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: "2026-11-05" });
  repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: "2026-11-07" });

  const next = weeklyRunPlan("2026-11-09", { adjustToday: false });
  assert.ok(RESTARTED(next, "City Marathon"), next.rationale.join(" | "));
  const km = weekKm(next);
  assert.ok(km > 18 * 1.1 + 2, `resumed toward the pre-race floor, not stepped off the capped 18 km (${km})`);
  assert.ok(km <= pre.floor_km + 0.5, `never past the pre-race floor (${km})`);
  const long = next.runs.find((r) => r.kind_label === "long");
  assert.ok(long, JSON.stringify(next.runs));
  assert.ok(
    long.target_distance_km > 6 * 1.15 + 1,
    `the long run steps off the built long run (${long.target_distance_km})`
  );
  assert.ok(next.runs.every((r) => runDate(next, r) > "2026-11-08"));
  assert.ok(!next.rationale.some((l) => POST_RACE_WINDOW_VARIANTS.includes(l)));
});

test("the race is neither harm nor demonstrated training capacity", () => {
  seedAthlete();
  seedRunning();
  assert.equal(harmEvidenceOnDay(RACE, { domain: "running" }), null, "the race is the build's dose");
  const shown = demonstratedRunCapacity(RACE);
  assert.equal(shown.long_km, 15, "the long-run ladder reads the training long run");
  assert.deepEqual(shown.set_aside, [], "no week set aside for the race");
  assert.equal(shown.floor_km, 29);
  // Clearing the goal after the race keeps the race (race-results.ts)…
  seedAthlete({ goal: null });
  assert.equal(harmEvidenceOnDay(RACE, { domain: "running" }), null, "the race outlives the goal");
  // …control: the same 21 km on a day that never was a race IS a new longest.
  db.exec("DELETE FROM completed_races");
  assert.equal(harmEvidenceOnDay(RACE, { domain: "running" })?.kind, "longest_run");
});

// ---------------------------------------------------------------------------
// the read and the surfaces
// ---------------------------------------------------------------------------

test("day + 1 reads as a lighter training day, never a rest by itself", () => {
  seedAthlete();
  seedRunning();
  seedLifting();
  const read = dayRead("2026-11-02");
  assert.equal(read.kind, "train", `${read.decision?.rule_code}: ${read.why}`);
  assert.match(read.why, /race/i, read.why);
  assert.match(read.why, /lighter/i, read.why);
  // The race's own load on the board is a soft brake: on his stated lifting day it is the
  // dose (stated_lift_dosed), never the kind — the window's lighter caveat rides either way.
  assert.ok(
    ["planned_post_race_training", "stated_lift_dosed"].includes(read.decision?.rule_code),
    read.decision?.rule_code
  );
  assert.equal(read.signals?.endurance_yesterday?.longest_run, undefined, "the race is not a 'longest in months'");
});

test("the frame and the race lane say it once, then go quiet", () => {
  seedAthlete();
  seedRunning();
  const frame = weekFrameLine("2026-11-02");
  assert.ok(
    RACE_RECOVERY_LINES.some((fn) => fn("Riverside Half", "Fri") === frame.headline),
    frame.headline
  );
  assert.equal(frame.glance, frame.headline);
  assert.equal(frame.countdown, null);
  const build = raceBuild("2026-11-03");
  assert.equal(build.available, false);
  assert.ok(/^(Recovering from|Easing back after) Riverside Half/.test(build.reason), build.reason);
  assert.equal(raceRecoveryLine("2026-11-03"), build.reason.replace(/\.$/, ""));

  const after = weekFrameLine("2026-11-06");
  assert.ok(!/Recovering|Easing back/.test(String(after.headline)), String(after.headline));
  assert.equal(raceBuild("2026-11-06").reason, "The race is behind you. A new date starts a new build.");
});

test("the day page focus says it in the trim's own words", () => {
  const focus = legTrimFocus("Squat-led lower body", "post_race_recovery", "2026-11-04");
  assert.match(focus, /^Squat-led lower body\. .*recover.*race/i);
  assert.match(focus, /lighter/i);
  assert.match(
    legTrimNote("Lower A", "post_race_recovery", "2026-11-04"),
    /^Lower A.*after the race|^Lower A.*recovering from the race/
  );
});

test("back-on words: a weekday inside the week, the date past it", () => {
  assert.equal(backOnWords("2026-11-06", "2026-11-02"), "Fri");
  assert.equal(backOnWords("2026-11-09", "2026-11-02"), "Mon Nov 9");
});

test("every athlete-facing line is a variant set that holds the reading grammar", () => {
  const sets = [
    POST_RACE_RECOVERY_RATIONALE.map((fn) => fn("Riverside Half", "Fri")),
    POST_RACE_RECOVERY_ITEM_NOTES,
    RACE_RECOVERY_LINES.map((fn) => fn("Riverside Half", "Fri")),
    POST_RACE_WINDOW_VARIANTS,
    POST_RACE_RESTART_VARIANTS.map((fn) => fn("Riverside Half")),
  ];
  for (const set of sets) {
    assert.ok(set.length >= 3);
    assert.equal(new Set(set).size, set.length);
    for (const line of set) assert.equal(violatesReadingGrammar(line), null, line);
  }
});
