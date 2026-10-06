// morningRunHold.test.js — a lift reopened after this morning's run holds its load when
// that run was hard or a new longest, whatever licenses the stack (the rhythm license, a
// push stance). Today's run cannot be harm evidence until tomorrow morning; the leg
// reduction lists stand on their own and are unchanged.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-07-15";
const NOW = "2031-07-15T12:00:00.000Z";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
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
    "exercises",
    "profile",
    "training_stances",
    "app_state"
  );
});

function snapshot(overrides = {}) {
  return {
    date: DATE,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 1,
      focus: "Upper body",
      plan_day_id: 10,
      day_type: "training",
      source: "adaptive",
      reason: "Push is due",
      due: [],
      over: [],
    },
    // The quiet read that followed the run: the lifting is still due.
    day_read: {
      kind: "easy",
      focus: null,
      est_minutes: 25,
      consecutive_training_days: 6,
      recovery_week: false,
      trained_today: true,
    },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    recovery_cycle: null,
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: { mesocycle_phase: "accumulation", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    progression: [{ exercise: "Bench Press", muscle_group: null, action: "overload", why: "Reps consolidated" }],
    plan_items: [{ exercise: "Bench Press", muscle_group: "chest", equipment: "barbell", mode: "reps", kind: "strength" }],
    training_intent: { endurance_role: "supporting", priorities: ["muscle", "strength"], source: "explicit" },
    lift_day_open: { after: "run" },
    ...overrides,
  };
}

const CLEAN_RHYTHM = {
  source: "stated",
  lift_day: true,
  run_day: true,
  cross_training_day: false,
  streak_on_rhythm: true,
  recent_harm_free: true,
  basis: "stated",
  stated_week: true,
  observed_days: [],
  cross_training_beyond: null,
  hard_ride_before_long_run: false,
};
const STANCE_SUPPORT = {
  training_drive: "push",
  backed: false,
  backed_by: [],
  training_directive: "proceed",
  fresh_brake: false,
  push_stance: { until: "2031-07-25", harm_free: true },
};

test("a license lifts the reopened lift's hold after an ordinary morning run", () => {
  for (const over of [{ stated_rhythm: CLEAN_RHYTHM }, { signal_support: STANCE_SUPPORT }]) {
    const env = buildDailySessionDecision(snapshot(over), { now: NOW });
    assert.equal(env.kind, "train");
    assert.ok(env.precedence.includes("lift_still_due_after_endurance"));
    assert.equal(env.caps.intensity, "normal", JSON.stringify(Object.keys(over)));
    assert.ok(!env.precedence.includes("morning_run_holds_load"));
  }
});

test("a hard or longest morning run keeps the load held under the rhythm license AND a push stance", () => {
  for (const runHeavy of ["hard", "longest"]) {
    for (const over of [
      { stated_rhythm: CLEAN_RHYTHM },
      { signal_support: STANCE_SUPPORT },
      { stated_rhythm: CLEAN_RHYTHM, signal_support: STANCE_SUPPORT },
    ]) {
      const env = buildDailySessionDecision(
        snapshot({ ...over, lift_day_open: { after: "run", run_heavy: runHeavy } }),
        { now: NOW }
      );
      const label = `${runHeavy} ${Object.keys(over).join("+")}`;
      assert.equal(env.kind, "train", label);
      assert.equal(env.caps.intensity, "hold", label);
      assert.ok(env.precedence.includes("morning_run_holds_load"), label);
      const said = env.soft_preferences.find((p) => p.code === "morning_run_holds_load");
      assert.match(said.detail, runHeavy === "longest" ? /longest/ : /hard one/, label);
      assert.equal(env.reach.level, null, `${label}: no challenge set over a held load`);
    }
  }
});

test("the hold is only for the reopened lift: a rest-grade morning is never reopened at all", () => {
  const restGrade = buildDailySessionDecision(
    snapshot({ lift_day_open: { after: "run", rest_grade: true, run_heavy: "hard" } }),
    { now: NOW }
  );
  assert.equal(restGrade.kind, "easy", "the quiet read stands");
  assert.ok(!restGrade.precedence.includes("lift_still_due_after_endurance"));
  assert.ok(!restGrade.precedence.includes("morning_run_holds_load"));
});

test("gather stamps run_heavy off the one source each question has", () => {
  const dow = new Date(`${DATE}T00:00:00Z`).getUTCDay();
  repo.savePlanDay(1, "Push", "Chest & shoulders", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.setProfile({ strength_schedule: { days: [{ dow }] } });
  // An ordinary morning run: nothing to stamp.
  const runId = Number(
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 30, 5)`).run(DATE)
      .lastInsertRowid
  );
  assert.equal(gatherDailyDecisionSnapshot(DATE).lift_day_open?.run_heavy, undefined);

  // The same run, graded hard on intensity by the watch (no personal model yet).
  const src = Number(db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'mrh')`).run().lastInsertRowid);
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, duration_min, distance_km, te_label, aerobic_te, training_effect)
     VALUES (?, 'mrh-1', ?, ?, 'running', 'Tempo', 30, 5, 'TEMPO', 4.6, 4.6)`
  ).run(src, runId, DATE);
  assert.equal(gatherDailyDecisionSnapshot(DATE).lift_day_open?.run_heavy, "hard");

  // A new longest (three shorter runs in the window before it) outranks the grade.
  resetTables("garmin_activities", "activities");
  for (const back of [3, 6, 9]) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 40, 6)`).run(
      addDaysISO(DATE, -back)
    );
  }
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 70, 12)`).run(DATE);
  assert.equal(gatherDailyDecisionSnapshot(DATE).lift_day_open?.run_heavy, "longest");
});
