import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import {
  buildDailySessionDecision,
  gatherDailyDecisionSnapshot,
  LIFT_STILL_DUE_RATIONALE,
  REACH_LOG_BACKED_WHY,
} from "../dist/repo/daily-decision.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

// The daily envelope stops capping every day (owner ruling, 2026-09-23):
//   1. a stack of days that IS the athlete's stated week, clean for three days with no
//      deciding brake, no longer holds intensity by its count;
//   2. reach opens under push drive when nothing genuine brakes and the main lift is not
//      DEEPLY saturated, and composition seats the one challenge set;
//   3. a SHALLOW leg residual holds load in place — only deep (or this morning's run)
//      reduces, and the athlete's own AM-run + PM-lift stack holds rather than reduces;
//   4. a morning run on a lifting weekday leaves the lifting due, never "rest";
//   5. a lift whose log has earned past a shallow hold keeps its step and its logged load.

const DATE = "2031-07-15";
const NOW = "2031-07-15T12:00:00.000Z";

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

function snapshot(overrides = {}) {
  return {
    date: DATE,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 1,
      focus: "Lower body",
      plan_day_id: 10,
      day_type: "training",
      source: "adaptive",
      reason: "Legs are due",
      due: [],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Lower body",
      est_minutes: 55,
      consecutive_training_days: 4,
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
      { exercise: "Back Squat", muscle_group: null, action: "overload", why: "Two clean sessions" },
      { exercise: "Bench Press", muscle_group: null, action: "overload", why: "Reps consolidated" },
    ],
    plan_items: [
      { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
      { exercise: "Bench Press", muscle_group: "chest", equipment: "barbell", mode: "reps", kind: "strength" },
    ],
    // Longevity leads: the priority order that turned every stacked day into "hold, reduced".
    training_intent: { endurance_role: "supporting", priorities: ["longevity", "muscle", "strength"], source: "explicit" },
    ...overrides,
  };
}

const CLEAN_RHYTHM = { source: "stated", lift_day: true, run_day: false, streak_on_rhythm: true, recent_harm_free: true };

// ---------- 1. longevity ease is not a daily cap ----------

test("a clean stated stack does not hold intensity by its count", () => {
  const env = buildDailySessionDecision(snapshot({ stated_rhythm: CLEAN_RHYTHM }), { now: NOW });
  assert.equal(env.caps.intensity, "normal");
  assert.equal(env.caps.volume, "normal");
  assert.ok(env.precedence.includes("stated_rhythm_clean"));
  assert.ok(!env.soft_preferences.some((p) => /Longevity-leading/.test(p.detail)));

  // The same count, with no rhythm, or with a recent cost, or a deciding brake, still eases.
  for (const over of [
    {},
    { stated_rhythm: { ...CLEAN_RHYTHM, recent_harm_free: false } },
    { stated_rhythm: { ...CLEAN_RHYTHM, streak_on_rhythm: false } },
    {
      stated_rhythm: CLEAN_RHYTHM,
      signal_support: { training_drive: "steady", backed: false, backed_by: [], training_directive: "proceed", fresh_brake: true },
    },
  ]) {
    const held = buildDailySessionDecision(snapshot(over), { now: NOW });
    assert.equal(held.caps.intensity, "hold", JSON.stringify(over));
    assert.equal(held.caps.volume, "reduced", JSON.stringify(over));
  }
});

test("under the license, hard endurance against a hard lower day eases volume, never intensity", () => {
  const env = buildDailySessionDecision(
    snapshot({
      stated_rhythm: CLEAN_RHYTHM,
      endurance: [{ type: "run", days_ago: 1, intensity: "hard", load: "heavy", regions: ["quads", "calves"] }],
    }),
    { now: NOW }
  );
  assert.equal(env.caps.volume, "reduced");
  assert.equal(env.caps.intensity, "normal");
});

// ---------- 2. reach actually opens ----------

const ADVISORY_PUSH = {
  training_drive: "push",
  backed: false,
  backed_by: [],
  training_directive: "proceed",
  fresh_brake: true,
  advisory_brake_only: true,
};

test("push drive + a clean rhythm + only an advisory brake opens the reach past a shallow main lift", () => {
  const env = buildDailySessionDecision(
    snapshot({
      stated_rhythm: CLEAN_RHYTHM,
      signal_support: ADVISORY_PUSH,
      muscle_load: [{ group: "quads", days_ago: 1, saturated: true, source: "endurance" }],
    }),
    { now: NOW }
  );
  assert.equal(env.reach.level, "push");
  assert.deepEqual(env.reach.backed_by, ["training_log"]);
  assert.ok(REACH_LOG_BACKED_WHY.includes(env.reach.why));
  assert.equal(env.caps.intensity, "normal");

  // A DEEP main-lift group, or a deciding brake, still parks it.
  const deep = buildDailySessionDecision(
    snapshot({
      stated_rhythm: CLEAN_RHYTHM,
      signal_support: ADVISORY_PUSH,
      muscle_load: [{ group: "quads", days_ago: 1, saturated: true, source: "endurance", deep: true }],
    }),
    { now: NOW }
  );
  assert.equal(deep.reach.level, null);
  const braked = buildDailySessionDecision(
    snapshot({ stated_rhythm: CLEAN_RHYTHM, signal_support: { ...ADVISORY_PUSH, advisory_brake_only: undefined } }),
    { now: NOW }
  );
  assert.equal(braked.reach.level, null);
});

test("composition seats ONE challenge set on the fresh compound and holds the shallow lift at its logged load", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.logSetByName({ date: "2031-07-10", exercise: "Back Squat", weight: 225, reps: 5 });
  repo.logSetByName({ date: "2031-07-10", exercise: "Bench Press", weight: 155, reps: 5 });
  const target = (w) => ({ mode: "reps", sets: 3, rep_low: 5, rep_high: 7, target_weight: w, target_seconds: null });
  const env = buildDailySessionDecision(
    snapshot({
      stated_rhythm: CLEAN_RHYTHM,
      signal_support: ADVISORY_PUSH,
      muscle_load: [{ group: "quads", days_ago: 1, saturated: true, source: "endurance" }],
      progression: [
        { exercise: "Back Squat", muscle_group: null, action: "overload", why: "", current_target: target(225), suggested_target: target(235) },
        // A rep step: the engine is moving the lift at its load, so it may host.
        { exercise: "Bench Press", muscle_group: null, action: "overload", why: "", current_target: target(155), suggested_target: target(155) },
      ],
    }),
    { now: NOW }
  );
  const squatCandidate = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squatCandidate.action, "hold", "a shallow residual holds the lift in place");
  assert.equal(squatCandidate.reason_code, "muscle_saturated");
  assert.ok(!env.muscles.reduced.includes("quads"), "shallow is not reduced");
  const { session, validation } = normalizeComposedSession(
    {
      name: "Lower",
      focus: "Lower",
      why: "x",
      est_minutes: 55,
      items: [
        { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 235 },
        { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 7, target_weight: 155 },
      ],
    },
    env
  );
  const squats = session.items.filter((i) => i.exercise === "Back Squat");
  assert.equal(squats.length, 1, "the held lift is not a reach host");
  assert.equal(squats[0].sets, 3, "no reduced-area set cap");
  assert.equal(squats[0].target_weight, 225, "held at the logged working weight, not eased below it");
  const benches = session.items.filter((i) => i.exercise === "Bench Press");
  assert.equal(benches.length, 2);
  assert.ok(benches[0].reach, "one challenge set on the fresh compound");
  assert.equal(session.items.filter((i) => i.reach).length, 1);
  assert.equal(validation.reach_landed, true);
  assert.ok(!env.soft_preferences.some((p) => p.code === "reach_no_room"));
});

// ---------- 3. legs are not reduced every day ----------

test("only a deep residual or this morning's heavy run reduces the legs; the stated stack holds", () => {
  const run = (daysAgo) => [{ type: "run", days_ago: daysAgo, intensity: "hard", load: "heavy", regions: ["quads", "hamstrings"] }];
  const shallow = (daysAgo) => [
    { group: "hamstrings", days_ago: daysAgo, saturated: true, source: "endurance" },
    { group: "quads", days_ago: daysAgo, saturated: true, source: "endurance" },
  ];
  const yesterday = buildDailySessionDecision(snapshot({ endurance: run(1), muscle_load: shallow(1) }), { now: NOW });
  assert.ok(!yesterday.muscles.reduced.includes("quads"));
  assert.ok(!yesterday.precedence.includes("endurance_lower_conflict"));
  assert.equal(yesterday.candidates.find((c) => c.exercise === "Back Squat").action, "hold");

  const deep = buildDailySessionDecision(
    snapshot({ endurance: run(1), muscle_load: shallow(1).map((m) => ({ ...m, deep: true })) }),
    { now: NOW }
  );
  assert.ok(deep.muscles.reduced.includes("quads"));
  assert.ok(deep.precedence.includes("endurance_lower_conflict"));

  const thisMorning = buildDailySessionDecision(snapshot({ endurance: run(0), muscle_load: shallow(0) }), { now: NOW });
  assert.ok(thisMorning.muscles.reduced.includes("quads"), "the run-morning law stands");

  const statedStack = buildDailySessionDecision(
    snapshot({ endurance: run(0), muscle_load: shallow(0), stated_rhythm: { ...CLEAN_RHYTHM, run_day: true } }),
    { now: NOW }
  );
  assert.ok(!statedStack.muscles.reduced.includes("quads"), "their own AM run + PM legs holds, not reduces");
  assert.equal(statedStack.candidates.find((c) => c.exercise === "Back Squat").action, "hold");
});

// ---------- 4. a morning run does not turn a lifting weekday into rest ----------

test("a lifting weekday whose run is in stays a training day unless a rest-grade brake stands", () => {
  const open = snapshot({
    day_read: { ...snapshot().day_read, kind: "rest", est_minutes: null },
    lift_day_open: { after: "run" },
  });
  const env = buildDailySessionDecision(open, { now: NOW });
  assert.equal(env.kind, "train");
  assert.equal(env.baseline_kind, "train");
  assert.equal(env.template.day_number, 1);
  assert.ok(env.precedence.includes("lift_still_due_after_endurance"));
  assert.ok(!env.precedence.includes("low_recovery_rest"));
  assert.equal(env.caps.intensity, "hold", "reopened without the rhythm license, the load holds");
  assert.equal(env.caps.duration_min, 60, "the plan's clock, not the quiet read's");
  assert.ok(env.endurance_hold?.reasons.includes("endurance_done_today"));
  assert.ok(env.rationale.some((r) => LIFT_STILL_DUE_RATIONALE.includes(r.text)));

  const restGrade = buildDailySessionDecision({ ...open, lift_day_open: { after: "run", rest_grade: true } }, { now: NOW });
  assert.equal(restGrade.kind, "rest");
});

test("gather: a run on a stated lifting weekday stamps lift_day_open and a post-run readiness is not the morning", () => {
  const dow = new Date(`${DATE}T00:00:00Z`).getUTCDay();
  repo.savePlanDay(1, "Pull", "Back and biceps", [{ exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10 }]);
  repo.setProfile({ strength_schedule: { days: [{ dow }] } });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 30, 5)`).run(DATE);
  // The watch's LAST sync after the run: a rest-grade number that says what the run cost.
  repo.upsertGarminDailyMetric({ date: DATE, training_readiness: 1, hrv: 52 });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.lift_day_open?.after, "run");
  assert.notEqual(snap.lift_day_open?.rest_grade, true);
  assert.notEqual(snap.recovery.readiness, "low", "a post-run sync is not this morning's readiness");
  assert.equal(buildDailySessionDecision(snap, { now: NOW }).kind, "train");
});

// ---------- 5. an earned lift is not held below its own log ----------

test("gather: two of the last three exposures at the top of the range with reps in reserve earn the floor", () => {
  repo.upsertExercise({ name: "Barbell Deadlift", muscle_group: "hamstrings", mode: "reps" });
  repo.savePlanDay(1, "Lower B", "Hinge", [
    { exercise: "Barbell Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 195 },
  ]);
  for (const [daysBack, rir] of [
    [14, 3],
    [9, 2],
    [2, 3],
  ]) {
    const date = addDaysISO(DATE, -daysBack);
    repo.logSetByName({ date, exercise: "Barbell Deadlift", weight: 195, reps: 10, rir });
    repo.logSetByName({ date, exercise: "Barbell Deadlift", weight: 195, reps: 10, rir });
  }
  const snap = gatherDailyDecisionSnapshot(DATE);
  const deadlift = snap.progression.find((p) => p.exercise === "Barbell Deadlift");
  assert.deepEqual(deadlift?.earned, { working_weight: 195 });
});

test("gather: the earned floor is the load the range was capped at, never a lone heavier set", () => {
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.savePlanDay(1, "Arms", "Arms", [{ exercise: "Barbell Curl", sets: 2, rep_low: 10, rep_high: 12, target_weight: 75 }]);
  const log = (daysBack, sets) => {
    const date = addDaysISO(DATE, -daysBack);
    for (const [weight, reps, rir] of sets) repo.logSetByName({ date, exercise: "Barbell Curl", weight, reps, rir });
  };
  log(14, [[70, 12, null], [70, 12, null]]);
  log(9, [[60, 12, null], [60, 12, null]]);
  // The newest exposure: one heavier set that fell short of the 12-rep ceiling.
  log(2, [[70, 10, 4], [80, 10, 2], [70, 10, 3]]);
  const snap = gatherDailyDecisionSnapshot(DATE);
  const curl = snap.progression.find((p) => p.exercise === "Barbell Curl");
  assert.deepEqual(curl?.earned, { working_weight: 70 }, "70 capped the range; the lone 80 × 10 did not");
});

test("an earned lift keeps its step past a shallow hold and composes at or above its logged load", () => {
  repo.upsertExercise({ name: "Barbell Deadlift", muscle_group: "hamstrings", mode: "reps" });
  repo.logSetByName({ date: "2031-07-10", exercise: "Barbell Deadlift", weight: 195, reps: 10 });
  const target = (w) => ({ mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: w, target_seconds: null });
  const base = {
    muscle_load: [{ group: "hamstrings", days_ago: 1, saturated: true, source: "endurance" }],
    plan_items: [{ exercise: "Barbell Deadlift", muscle_group: "hamstrings", equipment: "barbell", mode: "reps", kind: "strength" }],
    stated_rhythm: CLEAN_RHYTHM,
  };
  const prog = (extra = {}) => [
    { exercise: "Barbell Deadlift", muscle_group: null, action: "hold", why: "", current_target: target(165), suggested_target: target(165), ...extra },
  ];
  const plain = buildDailySessionDecision(snapshot({ ...base, progression: prog() }), { now: NOW });
  assert.equal(plain.candidates[0].earned_floor, undefined);
  const earned = buildDailySessionDecision(snapshot({ ...base, progression: prog({ earned: { working_weight: 195 } }) }), {
    now: NOW,
  });
  assert.equal(earned.candidates[0].earned_floor, 195);
  const raw = {
    name: "Lower B",
    focus: "Hinge",
    why: "x",
    est_minutes: 50,
    items: [{ exercise: "Barbell Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 165 }],
  };
  assert.equal(normalizeComposedSession(raw, earned).session.items[0].target_weight, 195);

  // An overload step on an earned lift is not converted to a hold by the shallow residual.
  const stepping = buildDailySessionDecision(
    snapshot({
      ...base,
      progression: prog({ action: "overload", suggested_target: target(205), earned: { working_weight: 195 } }),
    }),
    { now: NOW }
  );
  assert.equal(stepping.candidates[0].action, "overload");
  assert.equal(stepping.candidates[0].authorized_target.target_weight, 205);

  // A genuinely eased day keeps its easing: no floor on an easy cap.
  const easyDay = buildDailySessionDecision(
    snapshot({ ...base, day_read: { ...snapshot().day_read, kind: "easy" }, progression: prog({ earned: { working_weight: 195 } }) }),
    { now: NOW }
  );
  assert.ok(normalizeComposedSession(raw, easyDay).session.items[0].target_weight < 195);
});

// ---------- review fixes (2026-09-23) ----------
// The earned floor rides only on the progression's own verdict: a protective hold (an
// injury recheck, recent underperformance) steps the lift back on purpose and the
// floor must not lift it back to the logged working weight.
test("the earned floor never overrides an injury recheck or an underperformance hold", () => {
  const target = (w) => ({ mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: w, target_seconds: null });
  const base = {
    plan_items: [{ exercise: "Bench Press", muscle_group: "chest", equipment: "barbell", mode: "reps", kind: "strength" }],
    progression: [
      {
        exercise: "Bench Press",
        muscle_group: null,
        action: "overload",
        why: "",
        current_target: target(165),
        suggested_target: target(170),
        earned: { working_weight: 185 },
      },
    ],
    stated_rhythm: CLEAN_RHYTHM,
  };
  const recheck = buildDailySessionDecision(
    snapshot({
      ...base,
      constraints: {
        injuries: [{ constraint_level: "soft_recheck", exercises: ["Bench Press"] }],
        illness: false,
        travel: false,
      },
    }),
    { now: NOW }
  );
  assert.equal(recheck.candidates[0].reason_code, "injury_recheck");
  assert.equal(recheck.candidates[0].earned_floor, undefined, "a recheck holds at its own target");

  const under = buildDailySessionDecision(
    snapshot({ ...base, feedback: { performance: 2, soreness: null, joint_pain: null, low_performance_count: 1 } }),
    { now: NOW }
  );
  assert.equal(under.candidates[0].reason_code, "recent_underperformance");
  assert.equal(under.candidates[0].earned_floor, undefined);
});

test("a group loaded THIS morning holds whatever the lift has earned, and carries no floor", () => {
  const target = (w) => ({ mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: w, target_seconds: null });
  const env = buildDailySessionDecision(
    snapshot({
      muscle_load: [{ group: "hamstrings", days_ago: 0, saturated: true, source: "endurance" }],
      plan_items: [{ exercise: "Barbell Deadlift", muscle_group: "hamstrings", equipment: "barbell", mode: "reps", kind: "strength" }],
      progression: [
        {
          exercise: "Barbell Deadlift",
          muscle_group: null,
          action: "overload",
          why: "",
          current_target: target(195),
          suggested_target: target(200),
          earned: { working_weight: 195 },
        },
      ],
      stated_rhythm: CLEAN_RHYTHM,
    }),
    { now: NOW }
  );
  assert.equal(env.candidates[0].action, "hold");
  assert.equal(env.candidates[0].earned_floor, undefined);
});

test("a reopened morning-run lifting day stays bounded while a deciding brake stands", () => {
  const open = snapshot({
    day_read: { ...snapshot().day_read, kind: "rest", est_minutes: null },
    lift_day_open: { after: "run" },
    signal_support: { training_drive: "push", fresh_brake: true, soft_brake_only: false },
  });
  const env = buildDailySessionDecision(open, { now: NOW });
  assert.equal(env.kind, "train");
  assert.equal(env.caps.volume, "reduced");
  assert.ok(env.caps.duration_min <= 40, `bounded clock (got ${env.caps.duration_min})`);
});
