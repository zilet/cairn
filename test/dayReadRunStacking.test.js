// THE 2026-08-28 SCENARIO, replayed.
//
// The athlete ran the longest run of his life (9.85 km, 59 min, 51 of them at
// threshold). The watch read 1/100 the next morning. The Brief said "Easy run
// today", 60 minutes, kind=train — because (a) a reading under 35 resolves to a
// protective EASY posture and there was no deeper band, (b) the easy→train
// softening counted three run-only days as "overrode it and was fine" (a run has
// no session row, so it arrived unrated, and unrated reads as fine), and (c) the
// acute leg residual gates STRENGTH items and had never gated a cardio one, so
// composition happily renamed the template's "Run" to "Easy run".
//
// These cases pin all three doors shut, plus the two "don't break the feature"
// directions: an ordinary subdued reading still reads as it always did, and a
// genuinely fine lifting streak still opens a training day.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  easyOverrideSoftening,
  harmEvidenceOnDay,
  restOverrideSoftening,
  trainedWithoutHarm,
} from "../dist/repo/brain/read-adherence.js";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { decideDailySession } from "../dist/repo/daily-decision.js";
import { DAY_READ_WHY_VARIANTS, dayRead, dayReadHeadline } from "../dist/repo/day-read.js";
import { REST_GRADE_READINESS } from "../dist/repo/readiness-bands.js";
import { longestRunNovelty, planDayIsCardioOnly } from "../dist/repo/training-read.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

const REF = "2031-05-20";
const YESTERDAY = addDaysISO(REF, -1);

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "daily_metrics",
    "logged_sets",
    "sessions",
    "checkins",
    "plan_items",
    "plan_days",
    "exercises",
    "day_reads",
    "brain_decisions"
  );
});

function seedRun(date, km, minutes = Math.round(km * 6)) {
  const sql = `INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', ?, ?)`;
  db.prepare(sql).run(date, minutes, km);
}

// A history of ordinary runs, ending the day before `date`, so there is a real
// "longest" for a new one to beat.
function seedRunHistory(date, kms = [5, 5.5, 6, 6.2]) {
  kms.forEach((km, i) => seedRun(addDaysISO(date, -(7 + i * 7)), km));
}

// ---------- R4: the longest run in ninety days is its own signal ----------

test("a run further than anything in the window is novel; an ordinary one is not", () => {
  seedRunHistory(REF);
  seedRun(YESTERDAY, 9.85);
  const novel = longestRunNovelty(YESTERDAY);
  assert.ok(novel, "the longest run in the window should read as novel");
  assert.equal(novel.distance_km, 9.85);
  assert.equal(novel.previous_longest_km, 6.2);

  resetTables("activities");
  seedRunHistory(REF);
  seedRun(YESTERDAY, 5.8);
  assert.equal(longestRunNovelty(YESTERDAY), null, "an ordinary run is not a first");
});

test("matching the previous longest counts, and a thin history calls nothing a first", () => {
  seedRunHistory(REF, [6.2, 6.2, 6.2, 6.2]);
  seedRun(YESTERDAY, 6.1); // inside LONGEST_RUN_TOLERANCE_KM
  assert.ok(longestRunNovelty(YESTERDAY), "matching the longest is the same stimulus");

  resetTables("activities");
  seedRun(addDaysISO(REF, -8), 5);
  seedRun(YESTERDAY, 12);
  assert.equal(
    longestRunNovelty(YESTERDAY),
    null,
    "one prior run is not a baseline — the first runs back are all personal bests"
  );
});

// ---------- R1: harm includes the body's response ----------

test("an unrated lifting day is still not harm", () => {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date: YESTERDAY, exercise: "Test Row", weight: 100, reps: 8 });
  assert.equal(harmEvidenceOnDay(YESTERDAY), null);
  assert.equal(trainedWithoutHarm(YESTERDAY), true);
});

test("a hard run is harm even though nothing rated it", () => {
  seedRun(YESTERDAY, 9.85, 59);
  const harm = harmEvidenceOnDay(YESTERDAY);
  assert.ok(harm, "a threshold-length run cost them something");
  assert.ok(["hard_cardio", "longest_run"].includes(harm.kind), `unexpected kind ${harm?.kind}`);
  assert.equal(trainedWithoutHarm(YESTERDAY), false);
});

test("a rest-grade reading the next morning is harm, whatever the day was rated", () => {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date: YESTERDAY, exercise: "Test Row", weight: 100, reps: 8 });
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 1 });
  const harm = harmEvidenceOnDay(YESTERDAY);
  assert.equal(harm?.kind, "readiness_rest_grade");
});

test("a healthy reading the next morning is not harm", () => {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date: YESTERDAY, exercise: "Test Row", weight: 100, reps: 8 });
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 78 });
  assert.equal(harmEvidenceOnDay(YESTERDAY), null);
});

test("a stale reading cannot manufacture harm", () => {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date: YESTERDAY, exercise: "Test Row", weight: 100, reps: 8 });
  // Dated well before the morning after — too old to speak for it.
  repo.upsertGarminDailyMetric({ date: addDaysISO(REF, -6), training_readiness: 1 });
  assert.equal(harmEvidenceOnDay(YESTERDAY), null);
});

test("an elevated resting HR the next morning reads as a brake", () => {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date: YESTERDAY, exercise: "Test Row", weight: 100, reps: 8 });
  repo.upsertGarminDailyMetric({ date: REF, resting_hr: 60, hr_7d_avg: 52 });
  assert.equal(harmEvidenceOnDay(YESTERDAY)?.kind, "physiology_brake");
});

// ---------- R1 in the ladders: three "fine" run days are not three fine days ----------

function quietMorning(date, extra = {}) {
  return { date, read: "rest", softened: false, trained: true, load: "hard", ...extra };
}

test("three overridden rest mornings that were hard runs do not soften anything", () => {
  const days = [3, 2, 1].map((n) => addDaysISO(REF, -n));
  for (const date of days) seedRun(date, 8, 55);
  const model = { recent: days.map((date) => quietMorning(date)) };
  assert.equal(restOverrideSoftening(model, REF).active, false);
  assert.deepEqual(restOverrideSoftening(model, REF).overridden_and_fine, []);
});

test("three overridden rest mornings of genuinely fine lifting still soften", () => {
  const days = [3, 2, 1].map((n) => addDaysISO(REF, -n));
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  for (const date of days) {
    repo.logSetByName({ date, exercise: "Test Row", weight: 100, reps: 8 });
    repo.setSessionFeedback(date, { performance: 4 });
  }
  const model = { recent: days.map((date) => quietMorning(date)) };
  const soft = restOverrideSoftening(model, REF);
  assert.equal(soft.active, true, "the feature still works for the case it was built for");
  assert.equal(soft.overridden_and_fine.length, 3);
});

test("the easy ladder holds too when the divergences were runs", () => {
  const days = [3, 2, 1].map((n) => addDaysISO(REF, -n));
  for (const date of days) seedRun(date, 8, 55);
  const model = {
    recent: days.map((date) => ({ date, read: "easy", softened: false, trained: true, load: "hard" })),
  };
  assert.equal(easyOverrideSoftening(model, REF).active, false);
});

// ---------- R2: a rest-grade reading IS rest ----------

test("a rest-grade readiness reading reads as REST, and never suggests a run", () => {
  seedRunHistory(REF);
  seedRun(YESTERDAY, 9.85, 59);
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 1 });
  const read = dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.ok(
    (DAY_READ_WHY_VARIANTS.rest_grade_readiness ?? []).includes(read.why),
    `unexpected wording ${JSON.stringify(read.why)}`
  );
  assert.ok(!/\brun\b/i.test(read.why), "the rest morning must not put a run in front of them");
  assert.ok(!/\brun\b/i.test(dayReadHeadline(read, REF)), "nor in the headline");
  assert.equal(read.signals.endurance_yesterday?.hard_cardio, true);
  assert.ok(read.signals.endurance_yesterday?.longest_run, "yesterday's first rides in signals");
});

test("the reading has to be FRESH to earn the rest read", () => {
  repo.upsertGarminDailyMetric({ date: addDaysISO(REF, -5), training_readiness: 1 });
  const read = dayRead(REF);
  assert.notEqual(read.decision?.rule_code, "rest_grade_readiness");
});

test("a subdued-but-not-rest-grade reading keeps the behavior it always had", () => {
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 40 });
  const read = dayRead(REF);
  assert.notEqual(read.decision?.rule_code, "rest_grade_readiness");
  assert.notEqual(read.kind, "rest");
  assert.ok(REST_GRADE_READINESS < 40, "40 must sit clear of the deep band");
});

// ---------- R3: never stack runs by default ----------

test("planDayIsCardioOnly separates a Run day from a lifting day", () => {
  repo.savePlanDay(1, "Run", "Run", [{ kind: "cardio", exercise: "Easy run", target_duration_min: 40 }]);
  assert.equal(planDayIsCardioOnly(1), true);
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.savePlanDay(2, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  assert.equal(planDayIsCardioOnly(2), false);
  assert.equal(planDayIsCardioOnly(null), false);
});

function cardioEnvelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v7",
    input_fingerprint: "test-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: REF,
    kind: "easy",
    baseline_kind: "easy",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: 1, plan_day_id: null, focus: "Run", intent: "template" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [] },
    caps: { volume: "reduced", intensity: "easy", duration_min: 30 },
    recovery_cycle: null,
    candidates: [],
    hard_constraints: [],
    soft_preferences: [],
    rationale: [{ code: "low_recovery_easy", text: "Easy day." }],
    precedence: [],
    reach: { level: null, backed_by: [], why: "" },
    ...overrides,
  };
}

const runSession = {
  name: "Easy day",
  focus: "Run",
  why: "Keep it light.",
  est_minutes: 30,
  items: [{ kind: "cardio", exercise: "Run", target_duration_min: 45, target_distance_km: 8, target_zone: "z2" }],
};

test("an easy day under an endurance hold offers a walk, not a run", () => {
  const { session } = normalizeComposedSession(runSession, {
    ...cardioEnvelope(),
    endurance_hold: { no_run: true, reasons: ["hard_endurance_yesterday"] },
  });
  assert.ok(session, "the day still produces something to do");
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].exercise, "Easy walk");
  assert.equal(session.items[0].target_distance_km, null);
  assert.equal(session.items[0].target_zone, "easy");
});

test("without the hold, an easy day is still an easy run", () => {
  const { session } = normalizeComposedSession(runSession, cardioEnvelope());
  assert.equal(session.items[0].exercise, "Easy run");
});

test("the hold leaves the strength half of a day alone", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  const { session } = normalizeComposedSession(
    {
      ...runSession,
      items: [
        ...runSession.items,
        { kind: "strength", exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
      ],
    },
    { ...cardioEnvelope(), endurance_hold: { no_run: true, reasons: ["legs_saturated"] } }
  );
  const names = session.items.map((i) => i.exercise);
  assert.deepEqual(names, ["Easy walk", "Bench Press"]);
});

test("the band edge itself reads as rest", () => {
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: REST_GRADE_READINESS });
  const read = dayRead(REF);
  assert.equal(read.kind, "rest");
  assert.equal(read.decision?.rule_code, "rest_grade_readiness");
});

// ---------- R3: the softening ladder may not open a SECOND run ----------

// Three easy mornings the athlete took above easy, each a genuinely fine lifting
// session — the evidence the easy ladder exists to act on.
function seedFineEasyDivergences(fromDaysAgo = 4) {
  repo.upsertExercise({ name: "Test Squat", muscle_group: "quads" });
  for (let n = fromDaysAgo; n >= fromDaysAgo - 2; n--) {
    const date = addDaysISO(REF, -n);
    repo.saveDayRead(date, {
      kind: "easy",
      headline: "Easy today.",
      why: "A calm sentence about the day.",
      focus: null,
      est_minutes: 25,
      signals: {},
      source: "deterministic",
      override: null,
    });
    for (let s = 0; s < 4; s++) {
      repo.logSetByName({ date, exercise: "Test Squat", weight: 185, reps: 5, rir: 2 });
    }
    repo.setSessionFeedback(date, { performance: 4 });
  }
}

test("the ladder does not open a cardio-only day the morning after a hard run", () => {
  seedFineEasyDivergences();
  repo.savePlanDay(1, "Run", "Run", [{ kind: "cardio", exercise: "Easy run", target_duration_min: 40 }]);
  seedRunHistory(REF);
  seedRun(YESTERDAY, 9.85, 59);
  // Subdued but NOT rest-grade: the day's own read is the protective easy one, which
  // is exactly the read the ladder is allowed to open.
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 30 });
  const read = dayRead(REF);
  assert.equal(read.kind, "easy", "the ladder must not turn this into another run day");
  assert.equal(read.signals.easy_outcome_feedback?.active, true, "the pattern is still live evidence");
  assert.equal(read.signals.easy_outcome_feedback?.applied, false);
  assert.equal(read.signals.run_stacking_hold?.hard_cardio_yesterday, true);
  assert.equal(read.signals.run_stacking_hold?.longest_run_yesterday, true);
});

test("...but it still opens a lifting day on the same evidence", () => {
  seedFineEasyDivergences();
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedRunHistory(REF);
  seedRun(YESTERDAY, 9.85, 59);
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 30 });
  const read = dayRead(REF);
  assert.equal(read.kind, "train", "the hold is on the modality, not on the ladder");
  assert.equal(read.signals.easy_outcome_feedback?.applied, true);
  assert.equal(read.signals.run_stacking_hold, undefined);
});

// ---------- end to end: the envelope carries the hold, the session honors it ----------

test("training anyway on a rest-grade morning gets movement, not the template's run", () => {
  repo.savePlanDay(1, "Run", "Run", [{ kind: "cardio", exercise: "Easy run", target_duration_min: 45 }]);
  seedRunHistory(REF);
  seedRun(YESTERDAY, 9.85, 59);
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 1 });
  const { envelope } = decideDailySession(REF, { train_anyway: true });
  assert.equal(envelope.baseline_kind, "rest", "the morning itself read as rest");
  assert.equal(envelope.endurance_hold?.no_run, true);
  assert.ok(
    envelope.endurance_hold.reasons.includes("longest_run_yesterday") ||
      envelope.endurance_hold.reasons.includes("hard_endurance_yesterday"),
    `unexpected reasons ${JSON.stringify(envelope.endurance_hold.reasons)}`
  );
  const session = deterministicComposedSession(envelope);
  const names = session.items.map((i) => String(i.exercise));
  assert.ok(!names.some((n) => /\brun\b/i.test(n)), `a run survived: ${names.join(", ")}`);
});

test("an ordinary training day keeps its run and carries no hold", () => {
  repo.savePlanDay(1, "Run", "Run", [{ kind: "cardio", exercise: "Easy run", target_duration_min: 45 }]);
  repo.upsertGarminDailyMetric({ date: REF, training_readiness: 80, hrv: 60 });
  const { envelope } = decideDailySession(REF);
  assert.equal(envelope.endurance_hold, undefined);
});
