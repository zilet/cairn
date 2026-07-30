// Felt-signal freshness (src/repo/coach.ts trainingSignals + src/repo/signal-state.ts).
//
// The live failure this pins: `recent4 = sessions.slice(0, 4)` indexed the
// autoregulation window by SESSION, not by date. Two perf-2 sessions on 2026-07-21
// and 2026-07-23 therefore kept `low_performance_flag` true through 2026-07-30 —
// and because the flag becomes a safety-override `felt_fatigue` constraint dated
// TODAY (age 0, so `max_age_days: 7` never expired it) that forces posture "rest",
// the rest read suppressed the very sessions that would have retired its own
// trigger. Two later sessions rated 5 and 4 said nothing.
//
// The rules under test: felt signals decay by DATE, a newer good session clears an
// older bad one, sessions with no logged work are not feedback, and the resulting
// observation carries the offending session's date so freshness is honest.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("sessions", "logged_sets", "exercises", "plan_items", "plan_days", "training_symptoms", "checkins");
  repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
});

// One session on `date` carrying `sets` logged sets and an optional rating.
function seedSession(date, { sets = 0, performance = null, soreness = null, jointPain = null } = {}) {
  for (let n = 0; n < sets; n++) {
    repo.logSetByName({ date, exercise: "Test Squat", weight: 185, reps: 5, rir: 2 });
  }
  const session = repo.getOrCreateSession(date, null);
  if (performance != null || soreness != null || jointPain != null) {
    repo.setSessionFeedback(date, {
      ...(performance == null ? {} : { performance }),
      ...(soreness == null ? {} : { soreness }),
      ...(jointPain == null ? {} : { joint_pain: jointPain }),
    });
  }
  return session;
}

function autoregOn(date) {
  return repo.trainingSignals(undefined, date).autoregulation;
}

// ---- the live scenario, with its literal dates ------------------------------

test("later good sessions clear an older low-performance rating (the live 2026-07 case)", () => {
  seedSession("2026-07-21", { sets: 7, performance: 2 });
  seedSession("2026-07-22", { sets: 8, performance: 5 });
  seedSession("2026-07-23", { sets: 9, performance: 2 });
  seedSession("2026-07-27", { sets: 12, performance: 5 });
  seedSession("2026-07-28", { sets: 11, performance: 4 });
  seedSession("2026-07-29"); // opened, no work logged, no rating

  const autoreg = autoregOn("2026-07-30");
  assert.ok(!autoreg?.low_performance_flag, "the two later strong sessions must retire the flag");

  const state = repo.planningSignalState({
    date: "2026-07-30",
    trainingSignals: { autoregulation: autoreg },
  });
  const fatigue = state.dimensions.training_load_tolerance.evidence.filter((item) => item.field === "felt_fatigue");
  assert.equal(fatigue.length, 0, "no felt_fatigue constraint should reach the read");
});

test("the negative case: a recent low rating with nothing better after it still speaks", () => {
  seedSession("2026-07-21", { sets: 7, performance: 5 });
  seedSession("2026-07-27", { sets: 12, performance: 5 });
  seedSession("2026-07-28", { sets: 11, performance: 2 });

  const autoreg = autoregOn("2026-07-30");
  assert.ok(autoreg?.low_performance_flag, "the most recent rated session felt poor — that is live information");
  assert.equal(autoreg.low_performance_date, "2026-07-28", "the flag must carry the session's own date");

  const state = repo.planningSignalState({
    date: "2026-07-30",
    trainingSignals: { autoregulation: autoreg },
  });
  const fatigue = state.dimensions.training_load_tolerance.evidence.find((item) => item.field === "felt_fatigue");
  assert.ok(fatigue, "the constraint should be present");
  assert.equal(fatigue.date, "2026-07-28");
  assert.equal(fatigue.age_days, 2, "age is measured from the session, not from the read");
});

// ---- the individual rules ---------------------------------------------------

test("a rating older than the window stops counting even with nothing after it", () => {
  seedSession(localDaysAgo(12), { sets: 8, performance: 2 });
  const autoreg = autoregOn(localDaysAgo(0));
  assert.ok(!autoreg?.low_performance_flag, "a rating from 12 days ago is history, not a signal");
});

test("a session with no logged sets is not feedback", () => {
  seedSession(localDaysAgo(3), { sets: 0, performance: 2 });
  assert.ok(!autoregOn(localDaysAgo(0))?.low_performance_flag);

  // ...and an empty session cannot CLEAR a real one either.
  seedSession(localDaysAgo(2), { sets: 9, performance: 2 });
  seedSession(localDaysAgo(1), { sets: 0, performance: 5 });
  const autoreg = autoregOn(localDaysAgo(0));
  assert.ok(autoreg?.low_performance_flag, "an unworked session is not evidence of recovery");
  assert.equal(autoreg.low_performance_date, localDaysAgo(2));
});

test("soreness clears the same way, and carries its own date", () => {
  seedSession(localDaysAgo(4), { sets: 9, soreness: 5 });
  let autoreg = autoregOn(localDaysAgo(0));
  assert.ok(autoreg?.soreness_flag);
  assert.equal(autoreg.soreness_date, localDaysAgo(4));

  seedSession(localDaysAgo(1), { sets: 9, soreness: 2 });
  autoreg = autoregOn(localDaysAgo(0));
  assert.ok(!autoreg?.soreness_flag, "a later session that felt fine retires the soreness flag");
});

test("the rolled-up note only speaks while the flags hold", () => {
  seedSession(localDaysAgo(3), { sets: 9, performance: 2 });
  assert.match(autoregOn(localDaysAgo(0)).note, /lower-than-usual performance/);

  seedSession(localDaysAgo(1), { sets: 10, performance: 5 });
  assert.equal(autoregOn(localDaysAgo(0)), null, "with nothing left to say the rollup goes quiet");
});

test("a joint report is dated to its session and expires with it", () => {
  seedSession(localDaysAgo(2), { sets: 8, jointPain: "left knee" });
  const autoreg = autoregOn(localDaysAgo(0));
  assert.deepEqual(autoreg.joint_areas, ["left knee"]);
  assert.equal(autoreg.joint_date, localDaysAgo(2));

  const state = repo.planningSignalState({
    date: localDaysAgo(0),
    trainingSignals: { autoregulation: autoreg },
  });
  const joint = state.dimensions.health_constraints.evidence.find((item) => item.field === "joint_pain");
  assert.equal(joint.date, localDaysAgo(2));
  assert.equal(joint.age_days, 2);
});

test("a joint report ages out of the window like every other felt signal", () => {
  seedSession("2026-07-10", { sets: 8, jointPain: "left knee" });
  assert.ok(autoregOn("2026-07-12")?.joint_areas?.length, "still current two days later");
  assert.ok(!autoregOn("2026-07-30")?.joint_areas?.length, "three weeks on it is history");
});
