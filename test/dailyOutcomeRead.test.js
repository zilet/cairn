import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, repo, resetTables } from "./_seed.js";

const FIRST = "2024-08-01";
const SECOND = "2024-08-05";

beforeEach(() => {
  resetTables(
    "daily_session_outcomes", "daily_session_decisions", "daily_session_compositions",
    "logged_sets", "session_skips", "sessions", "plan_items", "plan_days", "exercises",
    "agent_jobs", "context_events", "recovery_cycles", "garmin_activities", "garmin_sources",
    "activities", "app_state"
  );
});

function seedPlan() {
  repo.savePlanDay(1, "Lower", "Squat", [
    { exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
}

function completed(date, weight = null) {
  const job = repo.createAgentJob({ kind: "session_compose", input: { date } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "stub",
    result: { ok: true, session: { name: "Lower", focus: "Squat", why: "Planned work.", est_minutes: 30,
      items: [{ exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 }] } },
  });
  const prepared = repo.prepareDailySession({ date, day_number: 1, source: "agent_suggest", agent_job_id: job.id });
  const acceptedWeight = prepared.daily_session.items[0]?.target_weight ?? 225;
  const workingWeight = weight ?? acceptedWeight;
  repo.logSetByName({ date, exercise: "Back Squat", weight: workingWeight, reps: 5, rir: 2, day_number: null });
  repo.logSetByName({ date, exercise: "Back Squat", weight: workingWeight, reps: 5, rir: 2, day_number: null });
  repo.finishSession(prepared.session_id, null);
  db.prepare("UPDATE logged_sets SET rir = 2 WHERE session_id = ?").run(prepared.session_id);
  return prepared.session_id;
}

function acceptedCardio(date, {
  source = "agent_suggest",
  duration = 40,
  targetDuration = 40,
  targetZone = null,
} = {}) {
  const session = {
    name: "Easy run",
    focus: "Aerobic work",
    why: "A calm endurance exposure.",
    est_minutes: targetDuration,
    items: [{ kind: "cardio", exercise: "Easy run", target_duration_min: targetDuration, target_zone: targetZone }],
  };
  let prepared;
  if (source === "athlete_override") {
    prepared = repo.prepareDailySession({ date, source, session });
  } else {
    repo.savePlanDay(1, session.name, session.focus, session.items);
    prepared = repo.prepareDailySession({ date, source: "manual_plan", day_number: 1 });
  }
  repo.addActivity({ date, type: "run", duration_min: duration, distance_km: 6 });
  return prepared.session_id;
}

test("daily outcome read is null when no reconciled daily session exists", () => {
  seedPlan();
  assert.equal(repo.dailyOutcomeRead({ date: SECOND }), null);
});

test("an in-progress reconciliation remains readable without an athlete verdict", () => {
  seedPlan();
  const prepared = repo.prepareDailySession({ date: SECOND, source: "adaptive_plan" });
  repo.logSetByName({ date: SECOND, exercise: "Back Squat", weight: 225, reps: 5, rir: 2, day_number: null });
  const read = repo.dailyOutcomeRead({ session_id: prepared.session_id });
  assert.equal(read.status, "in_progress");
  assert.equal(read.session_id, prepared.session_id);
  assert.ok(read.facts);
  assert.equal(read.athlete_read, null);
});

test("daily outcome read makes a clean completed exposure legible without machine fields", () => {
  seedPlan();
  const sessionId = completed(FIRST);
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(read.athlete_read.learning, "You met the planned work cleanly. That gives the next exposure useful evidence.");
  assert.equal(read.athlete_read.next_exposure, null, "one exposure has not earned a future promise");
  assert.deepEqual(Object.keys(read.athlete_read).sort(), ["learning", "next_exposure"]);
  assert.doesNotMatch(JSON.stringify(read.athlete_read), /confidence|score|reason_code|eligible|earned_absorbed/);
  assert.equal(read.session_id, sessionId, "the additive read preserves the existing outcome contract");
});

test("an older completed comparable outcome cannot promise the current next exposure", () => {
  seedPlan();
  const oldSessionId = completed(FIRST);
  const newestSessionId = completed(SECOND);
  const oldRead = repo.dailyOutcomeRead({ session_id: oldSessionId });
  const newestRead = repo.dailyOutcomeRead({ session_id: newestSessionId });
  assert.equal(oldRead.athlete_read.next_exposure, null, "an old outcome cannot promise the current next move");
  assert.equal(
    newestRead.athlete_read.next_exposure,
    "Next exposure: Back Squat +5 lb.",
    "the sentence comes from the current progression engine after two clean same-intent exposures"
  );
});

test("confounded and stopped outcomes stay calm and never promise progression", () => {
  seedPlan();
  const job = repo.createAgentJob({ kind: "session_compose", input: { date: FIRST } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "stub",
    result: { ok: true, session: { name: "Lower", focus: "Squat", why: "Planned work.", est_minutes: 30,
      items: [{ exercise: "Back Squat", sets: 2, rep_low: 5, rep_high: 5, target_weight: 225 }] } },
  });
  const prepared = repo.prepareDailySession({ date: FIRST, day_number: 1, source: "agent_suggest", agent_job_id: job.id });
  repo.addContextEvent({ kind: "trip", title: "Travel", start_date: FIRST, end_date: FIRST });
  repo.logSetByName({ date: FIRST, exercise: "Back Squat", weight: 225, reps: 5, day_number: null });
  repo.finishSession(prepared.session_id, null);
  const confounded = repo.dailyOutcomeRead({ session_id: prepared.session_id });
  assert.equal(confounded.athlete_read.learning, "Recovery or context shaped today’s work, so we won’t push progression from it.");
  assert.equal(confounded.athlete_read.next_exposure, null);

  db.prepare("DELETE FROM context_events").run();
  const stopped = repo.prepareDailySession({ date: SECOND, source: "manual_plan" });
  repo.finishSession(stopped.session_id, null);
  const stoppedRead = repo.dailyOutcomeRead({ session_id: stopped.session_id });
  assert.equal(stoppedRead.athlete_read.learning, "There was no usable exposure to learn from today. We’ll meet the next session fresh.");
  assert.equal(stoppedRead.athlete_read.next_exposure, null);
});

test("a clean cardio-only outcome gets calm learning without an endurance progression promise", () => {
  const sessionId = acceptedCardio(SECOND);
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(
    read.athlete_read.learning,
    "You completed the planned endurance work. That gives us a useful, factual exposure to learn from."
  );
  assert.equal(read.athlete_read.next_exposure, null);
  assert.equal(read.facts.dose_context.comparable, true);
});

test("a partial cardio-only outcome stays useful and does not moralize or progress", () => {
  const sessionId = acceptedCardio(SECOND, { duration: 24, targetDuration: 40 });
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(
    read.athlete_read.learning,
    "You got useful endurance work in, though it was shorter than planned. We’ll treat it as a partial exposure and keep learning."
  );
  assert.equal(read.athlete_read.next_exposure, null);
  assert.doesNotMatch(read.athlete_read.learning, /adherence|failed|missed|should have/i);
});

test("contradicted prescribed quality gets factual calm learning, not completed-as-planned language", () => {
  repo.savePlanDay(1, "Intervals", "Quality", [
    {
      kind: "cardio",
      exercise: "Run intervals",
      target_duration_min: 40,
      target_zone: "Z4",
      interval: [{ reps: 5, on: "3 min", off: "2 min", zone: "Z4" }],
    },
  ]);
  const prepared = repo.prepareDailySession({ date: SECOND, source: "manual_plan", day_number: 1 });
  repo.upsertGarminActivity({
    external_id: "outcome-easy-run",
    date: SECOND,
    type: "run",
    name: "Easy run",
    duration_min: 40,
    distance_km: 6,
    hr_zones: [{ zone: 2, secs: 2_400 }],
  });

  const read = repo.dailyOutcomeRead({ session_id: prepared.session_id });
  assert.equal(
    read.athlete_read.learning,
    "You completed the endurance dose, but the observed intensity did not match the planned quality. We’ll keep it as context rather than push progression from it."
  );
  assert.equal(read.athlete_read.next_exposure, null);
  assert.doesNotMatch(read.athlete_read.learning, /completed the planned endurance work/i);
});

test("prescribed quality with no zone data is explicitly unverified in the athlete read", () => {
  const sessionId = acceptedCardio(SECOND, { targetZone: "Z4" });
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(
    read.athlete_read.learning,
    "You completed the endurance dose, but the planned quality could not be verified from the available activity data. We’ll keep learning without pushing progression from it."
  );
  assert.equal(read.athlete_read.next_exposure, null);
  assert.doesNotMatch(read.athlete_read.learning, /completed the planned endurance work/i);
});

test("recovery context suppresses progression language for completed cardio", () => {
  repo.scheduleRecoveryCycle({
    effective_on: SECOND,
    recheck_on: "2024-08-06",
    exit_on: "2024-08-08",
    reason: "Recovery fixture",
  });
  const sessionId = acceptedCardio(SECOND);
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(
    read.athlete_read.learning,
    "Recovery or context shaped today’s endurance work, so we’ll treat it as context rather than push progression from it."
  );
  assert.equal(read.athlete_read.next_exposure, null);
});

test("athlete override context suppresses progression language for completed cardio", () => {
  const sessionId = acceptedCardio(SECOND, { source: "athlete_override" });
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(
    read.athlete_read.learning,
    "Recovery or context shaped today’s endurance work, so we’ll treat it as context rather than push progression from it."
  );
  assert.equal(read.athlete_read.next_exposure, null);
});

test("illness context suppresses progression language for completed cardio", () => {
  repo.addContextEvent({ kind: "illness", title: "Illness", start_date: SECOND, end_date: SECOND });
  const sessionId = acceptedCardio(SECOND);
  const read = repo.dailyOutcomeRead({ session_id: sessionId });
  assert.equal(
    read.athlete_read.learning,
    "Recovery or context shaped today’s endurance work, so we’ll treat it as context rather than push progression from it."
  );
  assert.equal(read.athlete_read.next_exposure, null);
});
