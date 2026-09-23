import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import {
  buildDailySessionDecision,
  gatherDailyDecisionSnapshot,
  WEEKLY_LOWER_EXPOSURE_RATIONALE,
  WEEKLY_LOWER_HELD_RATIONALE,
} from "../dist/repo/daily-decision.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { fullLoadLowerSessionThisWeek } from "../dist/repo/plan-selection.js";
import { substituteSaturatedPlanItems } from "../dist/repo/saturated-substitution.js";
import { repo, resetTables } from "./_seed.js";

// One genuinely loaded lower-body exposure every week (owner ruling, 2026-09-23). The
// race build's own strength law is "heavy lower once a week"; a hybrid week that lands
// every lower day the morning after a run could pass with no full leg session at all.
//   1. While none has landed this week, the week's next lower day keeps its leg items
//      whole: no reduced-area cap and no key-run trim — a deep residual, work done this
//      morning, and every safety floor still apply.
//   2. On the week's LAST lower day a deep residual from an earlier day HOLDS (logged load,
//      full sets) instead of reducing or moving, unless a safety floor fires.
//   3. The selector does not hand the week's last lower day to an upper day.

const DATE = "2031-07-15";
const NOW = "2031-07-15T12:00:00.000Z";
const YESTERDAY = "2031-07-14";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
    "garmin_daily_metrics",
    "daily_metrics",
    "checkins",
    "context_events",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
});

const target = (w) => ({ mode: "reps", sets: 3, rep_low: 5, rep_high: 7, target_weight: w, target_seconds: null });

function snapshot(overrides = {}) {
  return {
    date: DATE,
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
    progression: [
      {
        exercise: "Back Squat",
        muscle_group: null,
        action: "overload",
        why: "",
        current_target: target(225),
        suggested_target: target(235),
      },
      { exercise: "Bench Press", muscle_group: null, action: "hold", why: "", current_target: target(155), suggested_target: target(155) },
    ],
    plan_items: [
      { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
      { exercise: "Bench Press", muscle_group: "chest", equipment: "barbell", mode: "reps", kind: "strength" },
    ],
    training_intent: { endurance_role: "supporting", priorities: ["strength", "muscle", "longevity"], source: "explicit" },
    ...overrides,
  };
}

const deepQuads = (daysAgo = 1) => [{ group: "quads", days_ago: daysAgo, saturated: true, source: "endurance", deep: true }];
const heavyRun = (daysAgo = 1) => [{ type: "run", days_ago: daysAgo, intensity: "hard", load: "heavy", regions: ["quads"] }];
const RAW = {
  name: "Lower A",
  focus: "Lower A",
  why: "x",
  est_minutes: 55,
  items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 235 }],
};

// ---------- 1. the week's next lower day ----------

test("the next lower day keeps its legs whole against a key run that has not happened yet", () => {
  const keyRun = {
    training_intent: { endurance_role: "primary", priorities: ["endurance", "strength"], source: "explicit" },
    open_key_run: { intent_id: "q", kind: "quality", suggested_date: "2031-07-16" },
  };
  const plain = buildDailySessionDecision(snapshot(keyRun), { now: NOW });
  assert.ok(plain.muscles.reduced.includes("quads"), "without the guarantee the key run trims the legs");

  const env = buildDailySessionDecision(snapshot({ ...keyRun, weekly_lower: { last_chance: false } }), { now: NOW });
  assert.ok(!env.muscles.reduced.includes("quads"));
  assert.ok(!env.precedence.includes("endurance_lower_conflict"));
  assert.ok(env.precedence.includes("weekly_lower_exposure"));
  assert.ok(env.rationale.some((r) => WEEKLY_LOWER_EXPOSURE_RATIONALE.includes(r.text)));
  assert.equal(env.muscles.week_held, undefined, "nothing deep was held");
  assert.equal(env.rationale[0].code, "template_rotation", "the day's own read keeps the headline");
});

test("the next lower day still reduces a deep residual — only the last chance holds one", () => {
  const env = buildDailySessionDecision(
    snapshot({ weekly_lower: { last_chance: false }, muscle_load: deepQuads(1), endurance: heavyRun(1) }),
    { now: NOW }
  );
  assert.ok(env.muscles.reduced.includes("quads"));
  assert.equal(env.muscles.week_held, undefined);
});

// ---------- 2. the week's last lower day ----------

test("the last lower day holds a deep earlier residual at logged load with full sets", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.logSetByName({ date: "2031-07-10", exercise: "Back Squat", weight: 225, reps: 5 });
  const base = snapshot({ muscle_load: deepQuads(1), endurance: heavyRun(1) });
  base.progression[0].earned = { working_weight: 225 };

  const before = buildDailySessionDecision(base, { now: NOW });
  assert.ok(before.muscles.reduced.includes("quads"), "without the guarantee the deep residual reduces");
  const reducedSquat = normalizeComposedSession(RAW, before).session.items[0];
  assert.equal(reducedSquat.sets, 2, "reduced-area cap");
  assert.ok(reducedSquat.target_weight < 225, "eased below the logged load");

  const env = buildDailySessionDecision({ ...base, weekly_lower: { last_chance: true } }, { now: NOW });
  assert.ok(!env.muscles.reduced.includes("quads"));
  assert.deepEqual(env.muscles.week_held, ["quads"]);
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "hold", "a hold, never an earned step past a deep residual");
  assert.equal(squat.reason_code, "weekly_lower_exposure");
  assert.equal(squat.earned_floor, undefined);
  assert.ok(env.rationale.some((r) => WEEKLY_LOWER_HELD_RATIONALE.includes(r.text)));
  const held = normalizeComposedSession(RAW, env).session.items[0];
  assert.equal(held.sets, 3, "full sets");
  assert.equal(held.target_weight, 225, "held at the logged working weight");
  assert.ok(!held.reach, "a held lift never hosts the reach");
});

test("the last chance never covers work done this morning", () => {
  const env = buildDailySessionDecision(
    snapshot({ weekly_lower: { last_chance: true }, muscle_load: deepQuads(0), endurance: heavyRun(0) }),
    { now: NOW }
  );
  assert.ok(env.muscles.reduced.includes("quads"), "the run-morning law stands");
  assert.equal(env.muscles.week_held, undefined);
});

test("a safety floor stands the guarantee down", () => {
  const floors = {
    "deciding brake": {
      signal_support: { training_drive: "push", backed: false, backed_by: [], training_directive: "proceed", fresh_brake: true },
    },
    "low readiness": { recovery: { ...snapshot().recovery, readiness: "low" } },
    "high soreness": { checkin: { soreness: 4, energy: null, sleep_feel: null } },
    illness: { constraints: { injuries: [], illness: true, travel: false } },
    "knee pain": { feedback: { soreness: null, performance: null, joint_pain: "knee pain" } },
    "a lower injury": {
      constraints: {
        injuries: [{ title: "Knee", constraint_level: "soft_recheck", areas: ["knee"], exercises: ["back squat"] }],
        illness: false,
        travel: false,
      },
    },
    deload: { program: { ...snapshot().program, mesocycle_phase: "deload" } },
    "recovery week": { day_read: { ...snapshot().day_read, recovery_week: true } },
  };
  for (const [label, over] of Object.entries(floors)) {
    const env = buildDailySessionDecision(
      snapshot({ weekly_lower: { last_chance: true }, muscle_load: deepQuads(1), endurance: heavyRun(1), ...over }),
      { now: NOW }
    );
    assert.ok(!env.precedence.includes("weekly_lower_exposure"), label);
    assert.equal(env.muscles.week_held, undefined, label);
  }
  // An advisory-only board (a finding about runs) is not a floor.
  const advisory = buildDailySessionDecision(
    snapshot({
      weekly_lower: { last_chance: true },
      muscle_load: deepQuads(1),
      signal_support: {
        training_drive: "push",
        backed: false,
        backed_by: [],
        training_directive: "proceed",
        fresh_brake: true,
        advisory_brake_only: true,
      },
    }),
    { now: NOW }
  );
  assert.deepEqual(advisory.muscles.week_held, ["quads"]);
});

test("the guarantee is silent on a day that carries no squat or hinge work", () => {
  const env = buildDailySessionDecision(
    snapshot({
      weekly_lower: { last_chance: true },
      plan_items: [{ exercise: "Bench Press", muscle_group: "chest", equipment: "barbell", mode: "reps", kind: "strength" }],
    }),
    { now: NOW }
  );
  assert.ok(!env.precedence.includes("weekly_lower_exposure"));
});

test("the athlete-facing lines are variant sets that hold the reading grammar", () => {
  for (const set of [WEEKLY_LOWER_EXPOSURE_RATIONALE, WEEKLY_LOWER_HELD_RATIONALE]) {
    assert.ok(set.length >= 3);
    assert.equal(new Set(set).size, set.length);
    for (const line of set) assert.equal(violatesReadingGrammar(line), null, line);
  }
});

// ---------- composition: a held slot stays on the card ----------

test("substitution leaves a week-held slot in place over a deep earlier-day residual", () => {
  repo.replacePlan([
    { day_number: 1, name: "Lower A", items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 }] },
    { day_number: 2, name: "Push", items: [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 7, target_weight: 155 }] },
  ]);
  repo.addActivity({ type: "run", duration_min: 100, distance_km: 16, date: YESTERDAY, text: "Long run" });
  const legs = [{ group: "quads", days_ago: 1, saturated: true, source: "endurance", deep: true }];
  const moved = substituteSaturatedPlanItems(RAW, buildDailySessionDecision(snapshot({ muscle_load: legs }), { now: NOW }));
  assert.equal(moved.substitutions.length, 1, "a deep residual moves the slot on an ordinary day");
  const held = substituteSaturatedPlanItems(
    RAW,
    buildDailySessionDecision(snapshot({ muscle_load: legs, weekly_lower: { last_chance: true } }), { now: NOW })
  );
  assert.equal(held.substitutions.length, 0, "the week's last leg day keeps its squat");
  assert.equal(held.raw, RAW);
});

// ---------- the week read off the log ----------

const WORKDAYS = { days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }], source: "athlete" };
const day = (day_number, name, exercise, sets = 3) => ({
  day_number,
  name,
  items: [{ exercise, sets, rep_low: 6, rep_high: 8, target_weight: 100 }],
});
const rest = (day_number) => ({ day_number, name: "Rest", focus: null, day_type: "rest", items: [] });
// 2026-04-20 is a Monday.
const MON = "2026-04-20";
const TUE = "2026-04-21";
const WED = "2026-04-22";

function sets(date, exercise, weight, reps, n) {
  for (let i = 0; i < n; i++) repo.logSetByName({ date, exercise, weight, reps });
}

test("a full-load lower session is working sets at the lift's own working weight, un-reduced", () => {
  repo.replacePlan([day(1, "Lower", "Back Squat", 3), day(2, "Hinge", "Romanian Deadlift", 2)]);
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings", mode: "reps" });
  repo.upsertExercise({ name: "Leg Extension", muscle_group: "quads", mode: "reps" });
  sets("2026-04-13", "Back Squat", 205, 6, 3);
  sets("2026-04-13", "Romanian Deadlift", 185, 8, 2);
  sets("2026-04-13", "Leg Extension", 120, 12, 3);

  sets(MON, "Back Squat", 205, 6, 2); // the reduced-area cap: two sets
  sets(MON, "Leg Extension", 130, 12, 3); // an isolation machine is not a leg session
  assert.equal(fullLoadLowerSessionThisWeek(WED), null);
  sets(TUE, "Back Squat", 185, 8, 3); // three sets, eased below the working weight
  assert.equal(fullLoadLowerSessionThisWeek(WED), null);
  sets(TUE, "Romanian Deadlift", 185, 8, 2); // the plan writes this lift at two sets
  assert.equal(fullLoadLowerSessionThisWeek(WED), TUE);
  assert.equal(fullLoadLowerSessionThisWeek(TUE), null, "only days before the one asked about");
  assert.equal(fullLoadLowerSessionThisWeek("2026-04-27"), null, "a new week starts empty");
});

const PPLU = [day(1, "Push", "Barbell Bench Press"), day(2, "Pull", "Pendlay Row"), day(3, "Lower A", "Back Squat"), day(4, "Upper", "Overhead Press"), rest(5)];

function liveWeek() {
  // Mon–Fri lifting over a four-day pool: Mon Push, Tue Pull, Wed Lower A, Thu Upper, Fri
  // Push again — Wednesday is the week's only lower day.
  repo.replacePlan(PPLU);
  repo.setProfile({ strength_schedule: WORKDAYS });
  repo.logSetByName({ date: MON, exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  repo.logSetByName({ date: TUE, exercise: "Pendlay Row", weight: 135, reps: 8 });
}

test("selection: the week's last lower day is kept over a deep leg dose while no full lower session has landed", () => {
  liveWeek();
  repo.addActivity({ type: "run", duration_min: 100, distance_km: 16, date: TUE, text: "Long run" });
  const wednesday = repo.selectAdaptivePlanDay(WED);
  assert.equal(wednesday.selection.rotation.day_number, 3);
  assert.equal(wednesday.day_number, 3, "swapping Lower A away would leave the week with no legs");
  assert.equal(wednesday.selection.adapted, false);
  assert.deepEqual(wednesday.selection.lower_week, { kept: true });
});

test("selection: work done THIS morning still moves the last lower day", () => {
  liveWeek();
  repo.addActivity({ type: "run", duration_min: 100, distance_km: 16, date: WED, text: "Long run" });
  const wednesday = repo.selectAdaptivePlanDay(WED);
  assert.notEqual(wednesday.day_number, 3);
  assert.equal(wednesday.selection.lower_week, undefined);
});

test("gather: the week's lower question is stamped only on an unfulfilled lower day", () => {
  liveWeek();
  const wed = gatherDailyDecisionSnapshot(WED);
  assert.equal(wed.plan.day_number, 3);
  assert.deepEqual(wed.weekly_lower, { last_chance: true });
  assert.equal(gatherDailyDecisionSnapshot(MON).weekly_lower, undefined, "Push carries no leg work");

  // A second lower day later in the week makes Wednesday the NEXT lower day, not the last.
  repo.replacePlan([...PPLU.slice(0, 4), day(5, "Lower B", "Romanian Deadlift"), rest(6)]);
  assert.deepEqual(gatherDailyDecisionSnapshot(WED).weekly_lower, { last_chance: false });

  // A genuinely loaded lower session earlier this week fulfils it.
  repo.upsertExercise({ name: "Leg Press", muscle_group: "quads", mode: "reps" });
  sets("2026-04-13", "Leg Press", 300, 10, 3);
  sets(TUE, "Leg Press", 300, 10, 3);
  assert.equal(gatherDailyDecisionSnapshot(WED).weekly_lower, undefined);
});
