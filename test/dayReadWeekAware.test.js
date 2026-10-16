// THE BRIEF READS THE STATED WEEK, AND ITS MEASUREMENT JUDGES ONLY WHAT IT SAID
// (2026-10-16, "fix the measurements, do the right thing, ground yourself in how I
// train and progress").
//
// Measurement (Part A):
//   • the judge-the-read era carries its own evaluator version and legacy verdicts are
//     labelled `legacy_behavioural`, never "unrecorded";
//   • only the TRUE morning read is judged — a read written after a run, or one that
//     itself records work already logged, is commentary;
//   • harm can be UNKNOWN (an unmeasured morning for an athlete who wears the sensor) and
//     looks 48 hours out — unknown never clears a brake and never counts as a cost;
//   • the stated week's own dose (the long run taken conversationally) is not a
//     divergence from an easy read.
// The read (Part B):
//   • on a stated key-run or lifting day a SOFT brake becomes the dose, not the kind;
//   • every floor — rest-grade readiness, a short night, an injury or symptom, a
//     doctor-governed hold, a fueling hold — keeps the quiet read exactly as before;
//   • the stated-week tolerance widens or tightens from outcomes, bounded;
//   • the race taper's leg trim is untouched.
// Synthetic fixtures only; no real data.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { listBrainExpectations } from "../dist/repo/brain-decisions.js";
import { latestBrainEvaluation } from "../dist/repo/brain-evaluations.js";
import { getBrainDiagnostics } from "../dist/domain/operator/brain-diagnostics-use-case.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { localDateISO } from "../dist/repo/shared.js";
import { weeklyRunPlan } from "../dist/repo/run-progression.js";
import { raceStrengthPrinciple } from "../dist/repo/race-strength.js";
import {
  DAY_READ_ADHERENCE_EVALUATOR_VERSION,
  calendarDoseTolerance,
  dayTrainingTruth,
  easyOverrideSoftening,
  harmEvidenceOnDay,
  harmVerdictOnDay,
  readAdherenceModel,
  readAdherenceOutcome,
  trainedWithoutHarm,
} from "../dist/repo/brain/read-adherence.js";
import { dayReadCall } from "../dist/repo/brain/day-read-call.js";
import { personalBand } from "../dist/repo/overnight-band.js";
import { SUN, resetLiveWeekTables, run, seedHistory, seedLiveWeek, seedProfile } from "./_liveWeekFixture.js";

beforeEach(() => {
  resetLiveWeekTables();
  resetTables(
    "brain_evaluations",
    "brain_expectations",
    "day_reads",
    "suggestions",
    "checkins",
    "training_symptom_events",
    "symptom_reports",
    "health_directives",
    "daily_session_decisions",
    "daily_session_compositions",
    "settings"
  );
});

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// ── the ledger helpers (the same shape test/dayReadCall.test.js writes) ──────────────

function read(kind, extra = {}) {
  return {
    kind,
    headline: `${kind} today.`,
    why: "A calm sentence about the day.",
    focus: kind === "train" ? "Lower" : null,
    est_minutes: kind === "rest" ? null : 45,
    signals: {},
    source: "deterministic",
    override: null,
    ...extra,
  };
}

function readAt(date, kind, time, extra = {}) {
  repo.saveDayRead(date, read(kind, extra));
  const row = db
    .prepare(
      `SELECT id FROM brain_decisions WHERE kind='day_read' AND source_ref_type='day_read'
        AND source_ref_key=? ORDER BY id DESC LIMIT 1`
    )
    .get(date);
  db.prepare(`UPDATE brain_decisions SET created_at=? WHERE id=?`).run(`${date} ${time}`, row.id);
  return Number(row.id);
}

function liftedAt(date, time, performance = 4) {
  repo.upsertExercise({ name: "Test Squat", muscle_group: "legs" });
  for (let n = 1; n <= 5; n++) repo.logSetByName({ date, exercise: "Test Squat", weight: 225, reps: 5, rir: 1 });
  repo.getOrCreateSession(date, null);
  if (performance != null) repo.setSessionFeedback(date, { performance });
  db.prepare(`UPDATE sessions SET created_at=? WHERE date=?`).run(`${date} ${time}`, date);
  db.prepare(`UPDATE logged_sets SET created_at=? WHERE session_id IN (SELECT id FROM sessions WHERE date=?)`).run(
    `${date} ${time}`,
    date
  );
}

let sourceId = null;
function garminSource() {
  const still = sourceId != null && db.prepare(`SELECT id FROM garmin_sources WHERE id = ?`).get(sourceId);
  if (still) return sourceId;
  sourceId = Number(
    db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', 'week-aware')`).run().lastInsertRowid
  );
  return sourceId;
}

// A synced run whose start the watch placed in time (beginTimestamp, epoch ms).
function syncedRunAt(date, timeUtc, km = 8) {
  const row = repo.addActivity({ type: "run", date, distance_km: km, duration_min: km * 6 });
  const begin = Date.parse(`${date}T${timeUtc}Z`);
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, duration_min, distance_km, raw_json)
     VALUES (?, ?, ?, ?, 'running', 'Morning Run', ?, ?, ?)`
  ).run(garminSource(), `wa-${row.id}`, row.id, date, km * 6, km, JSON.stringify({ beginTimestamp: begin }));
  return row;
}

const expectationOf = (decisionId) => listBrainExpectations({ decisionId, limit: 5 })[0];
const verdictOf = (decisionId) => latestBrainEvaluation(expectationOf(decisionId).id);

// The athlete's own nights: HRV 38–48 ms, resting HR 50–54 — a wearing HABIT.
const OWN_HRV = [38, 41, 43, 45, 48];
function ownNights(before, n = 20, skip = []) {
  for (let back = 1; back <= n; back++) {
    const date = addDays(before, -back);
    if (skip.includes(date)) continue;
    repo.upsertGarminDailyMetric({ date, hrv_ms: OWN_HRV[back % OWN_HRV.length], resting_hr: 50 + (back % 5) });
  }
}
function bandFor(morning) {
  const values = db
    .prepare(`SELECT hrv_ms FROM garmin_daily_metrics WHERE date < ? AND date >= ? AND hrv_ms IS NOT NULL`)
    .all(morning, addDays(morning, -30))
    .map((r) => Number(r.hrv_ms));
  return personalBand(values, "hrv_ms");
}

// ══ A1 — two eras, told apart ═══════════════════════════════════════════════════════

test("a judged verdict carries the v2 evaluator and its era; a legacy verdict is labelled legacy_behavioural", () => {
  assert.equal(DAY_READ_ADHERENCE_EVALUATOR_VERSION, "day-read-adherence-v2");
  const date = "2026-09-10";
  const id = readAt(date, "train", "07:00:00");
  liftedAt(date, "11:00:00");
  evaluateMatureExpectations("2026-09-12");
  const verdict = verdictOf(id);
  assert.equal(verdict.verdict, "aligned");
  assert.equal(verdict.actual.read_call, "held");
  assert.equal(verdict.actual.evaluator_era, "judged_read");
  assert.equal(verdict.actual.day_read_evaluator, "day-read-adherence-v2");
  assert.match(verdict.evaluator_version, /day-read-adherence-v2/);
  assert.equal(expectationOf(id).evaluator_version, "day-read-adherence-v2");

  // A legacy behavioural verdict: an easy read the athlete "did more than", stored
  // not_aligned with no read_call — exactly the pre-2026-09-25 shape.
  const legacyDate = "2026-09-01";
  const legacyId = readAt(legacyDate, "easy", "07:00:00");
  liftedAt(legacyDate, "11:00:00");
  db.prepare(
    `INSERT INTO brain_evaluations (expectation_id, verdict, actual_json, evidence_json, confounders_json, explanation, evaluator_version)
     VALUES (?, 'not_aligned', ?, '[]', '[]', 'legacy', 'brain-maturity-v1/day_read_adherence')`
  ).run(
    expectationOf(legacyId).id,
    JSON.stringify({ read_kind: "easy", read_date: legacyDate, followed: false, load: "hard" })
  );
  db.prepare(`UPDATE brain_expectations SET status='evaluated' WHERE id=?`).run(expectationOf(legacyId).id);

  const health = getBrainDiagnostics(5).metrics.expectation_health;
  const dayRead = health.by_metric.find((row) => row.metric_key === "day_read_adherence");
  assert.equal(dayRead.read_calls.legacy_behavioural, 1, JSON.stringify(dayRead.read_calls));
  assert.equal(dayRead.read_calls.unrecorded, undefined, "never 'unrecorded'");
  assert.equal(dayRead.read_eras.judged_read.aligned, 1);
  assert.equal(dayRead.read_eras.judged_read.by_v2_evaluator, 1);
  assert.equal(dayRead.read_eras.legacy_behavioural.not_aligned, 1);
  // No wearing habit, so the harm law's old answer stands and the legacy row derives
  // honestly: trained through, nothing said it cost them.
  assert.deepEqual(dayRead.read_eras.legacy_behavioural.derived_calls, { too_cautious: 1 });
});

test("a legacy quiet-read verdict whose harm is UNKNOWN derives no call (never invented)", () => {
  const legacyDate = "2026-09-20";
  ownNights(legacyDate, 20);
  const legacyId = readAt(legacyDate, "easy", "07:00:00");
  liftedAt(legacyDate, "11:00:00");
  db.prepare(
    `INSERT INTO brain_evaluations (expectation_id, verdict, actual_json, evidence_json, confounders_json, explanation, evaluator_version)
     VALUES (?, 'not_aligned', ?, '[]', '[]', 'legacy', 'brain-maturity-v1/day_read_adherence')`
  ).run(
    expectationOf(legacyId).id,
    JSON.stringify({ read_kind: "easy", read_date: legacyDate, followed: false, load: "hard" })
  );
  const dayRead = getBrainDiagnostics(5).metrics.expectation_health.by_metric.find(
    (row) => row.metric_key === "day_read_adherence"
  );
  assert.equal(dayRead.read_eras.legacy_behavioural.underivable, 1);
  assert.deepEqual(dayRead.read_eras.legacy_behavioural.derived_calls, {});
});

// ══ A2 — only the true morning read is judged ═══════════════════════════════════════

test("a run then a lift: the read written after the run is commentary, the morning read is judged", () => {
  const date = "2026-09-15";
  const morning = readAt(date, "train", "06:30:00");
  syncedRunAt(date, "08:00:00");
  // The post-run recompute: "you've moved today — let the rest stay easy". Written
  // BEFORE the first set, so the old set-only cutoff judged it.
  const commentary = readAt(date, "easy", "09:30:00", { signals: { trained_today: true } });
  liftedAt(date, "11:00:00");
  evaluateMatureExpectations("2026-09-18");
  assert.equal(verdictOf(morning).verdict, "aligned");
  assert.equal(verdictOf(morning).actual.read_call, "held");
  assert.equal(verdictOf(commentary).verdict, "canceled", "the commentary read is never the day's verdict");
});

test("a recompute that itself records work already logged is commentary, whatever its timestamp", () => {
  const date = "2026-09-16";
  const morning = readAt(date, "train", "06:30:00");
  // A hand-logged run carries no instant — only the read's own record says it saw it.
  repo.addActivity({ type: "run", date, distance_km: 6, duration_min: 36 });
  const commentary = readAt(date, "easy", "08:00:00", { signals: { trained_today: true } });
  liftedAt(date, "12:00:00");
  evaluateMatureExpectations("2026-09-19");
  assert.equal(verdictOf(morning).actual.read_call, "held");
  assert.equal(verdictOf(commentary).verdict, "canceled");
  const model = readAdherenceModel("2026-09-19", 10);
  assert.equal(model.recent.find((day) => day.date === date)?.read, "train", "the model counts the morning read");
});

test("a day whose every read came after training has no morning read: nothing is judged or counted", () => {
  const date = "2026-09-17";
  liftedAt(date, "06:00:00");
  const only = readAt(date, "easy", "12:41:00", { signals: { trained_today: true } });
  evaluateMatureExpectations("2026-09-20");
  const verdict = verdictOf(only);
  assert.equal(verdict.verdict, "canceled");
  assert.match(verdict.explanation, /no morning read/i);
  const model = readAdherenceModel("2026-09-20", 10);
  assert.equal(
    model.recent.find((day) => day.date === date),
    undefined
  );
});

// ══ A3 — harm can be unknown, and looks 48 hours out ════════════════════════════════

test("missing next-morning data is UNKNOWN, not 'no harm' — and it does not clear a brake", () => {
  const days = ["2026-09-21", "2026-09-22", "2026-09-23"];
  // A wearing habit up to the first day, then nothing synced at all (watch on the charger).
  ownNights(days[0], 20);
  for (const date of days) {
    readAt(date, "easy", "07:00:00");
    liftedAt(date, "11:00:00", 4);
  }
  for (const date of days) {
    assert.equal(harmEvidenceOnDay(date), null, "the license read keeps its old law");
    const verdict = harmVerdictOnDay(date);
    assert.equal(verdict.status, "unknown", `${date}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.unknown_reason, "no_overnight_reading");
    assert.equal(trainedWithoutHarm(date), false, "an unmeasured day is never a clean day");
  }
  // Three easy reads trained through, none measured: the easy ladder does NOT open.
  const asOf = "2026-09-26";
  const ladder = easyOverrideSoftening(readAdherenceModel(asOf, 12), asOf);
  assert.deepEqual(ladder.overridden_and_fine, []);
  assert.equal(ladder.active, false);
  // …and the verdict is inconclusive (`unclear`), never "too cautious".
  evaluateMatureExpectations(asOf);
  const id = db
    .prepare(`SELECT id FROM brain_decisions WHERE kind='day_read' AND source_ref_key=? ORDER BY id LIMIT 1`)
    .get(days[0]).id;
  const verdict = verdictOf(id);
  assert.equal(verdict.verdict, "inconclusive", JSON.stringify(verdict));
  assert.equal(verdict.actual.read_call, "unclear");
  assert.equal(verdict.actual.harm_status, "unknown");
  // Unknown is not a cost either: the read is never "vindicated" off silence.
  assert.equal(dayReadCall("easy", "diverged", null, true), "unclear");
});

test("the judge waits one more night while harm is unknown, then calls it once it speaks", () => {
  const date = "2026-09-24";
  ownNights(date, 20);
  const id = readAt(date, "easy", "07:00:00");
  liftedAt(date, "11:00:00", 4);
  // The morning after closed with nothing synced: still waiting.
  evaluateMatureExpectations(addDays(date, 2));
  assert.equal(latestBrainEvaluation(expectationOf(id).id), null, "waits for the second morning");
  // The second morning speaks clean (a night inside the band).
  repo.upsertGarminDailyMetric({ date: addDays(date, 2), hrv_ms: 45, resting_hr: 51 });
  assert.equal(harmVerdictOnDay(date).status, "clean");
  assert.equal(harmVerdictOnDay(date).window, "48h");
  evaluateMatureExpectations(addDays(date, 3));
  assert.equal(verdictOf(id).actual.read_call, "too_cautious");
});

test("the 48-hour arm catches an HRV drop two mornings later", () => {
  const day = "2026-10-10";
  const between = addDays(day, 1);
  const second = addDays(day, 2);
  ownNights(day, 20);
  liftedAt(day, "10:00:00", 4);
  // No night synced on the morning between (2026-10-11), and a meaningful drop on the
  // second morning (2026-10-12) — the live shape.
  const band = bandFor(second);
  repo.upsertGarminDailyMetric({ date: second, hrv_ms: Math.round((band.line - band.width) * 10) / 10 });
  assert.equal(harmEvidenceOnDay(day), null, "the 24-hour test cannot see it");
  const verdict = harmVerdictOnDay(day);
  assert.equal(verdict.status, "harm", JSON.stringify(verdict));
  assert.equal(verdict.window, "48h");
  assert.equal(verdict.evidence.kind, "physiology_brake");
  assert.match(verdict.evidence.detail, /second morning after/);
  assert.equal(between < second, true);
});

test("a measured, trained day between owns a second-morning drop — one episode, never two measured days", () => {
  const day = "2026-10-03";
  const between = addDays(day, 1);
  const second = addDays(day, 2);
  ownNights(day, 20);
  liftedAt(day, "10:00:00", 4);
  repo.upsertGarminDailyMetric({ date: between, hrv_ms: 44, resting_hr: 51 });
  liftedAt(between, "10:00:00", 4);
  const band = bandFor(second);
  repo.upsertGarminDailyMetric({ date: second, hrv_ms: Math.round((band.line - band.width) * 10) / 10 });
  assert.equal(harmVerdictOnDay(day).status, "clean", "the measured morning after spoke clean");
  assert.equal(harmVerdictOnDay(between).status, "harm", "the drop belongs to the day before it");
});

test("an athlete with no wearing habit keeps the old law: absence is clean", () => {
  const date = "2026-09-27";
  liftedAt(date, "10:00:00", 4);
  assert.equal(harmVerdictOnDay(date).status, "clean");
  assert.equal(trainedWithoutHarm(date), true);
});

// ══ A4 — the stated week's own dose is not a divergence ═════════════════════════════

test("Sunday's stated long run, taken conversationally on an easy read, is not a divergence", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-05T20:00:00Z") });
  seedProfile();
  seedHistory();
  seedLiveWeek();
  const id = readAt(SUN, "easy", "07:00:00");
  const truth = dayTrainingTruth(SUN);
  assert.equal(truth.above_easy, true, "a long run is a heavy dose by length");
  assert.ok(truth.own_dose?.kinds.includes("stated_long_run"), JSON.stringify(truth.own_dose));
  assert.equal(truth.above_easy_beyond_own_dose, false);
  assert.equal(readAdherenceOutcome("easy", truth), "followed");
  evaluateMatureExpectations("2026-10-07");
  const verdict = verdictOf(id);
  assert.equal(verdict.verdict, "aligned");
  assert.equal(verdict.actual.read_call, "held");
  assert.deepEqual(verdict.actual.own_dose, ["stated_long_run"]);
  // …and it is evidence for no ladder in either direction.
  const day = readAdherenceModel("2026-10-07", 10).recent.find((row) => row.date === SUN);
  assert.equal(day.own_dose, true);
});

test("a long run with no word on its effort is NOT exempt — silence never vouches", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-05T20:00:00Z") });
  seedProfile();
  seedHistory();
  seedLiveWeek({ withSunday: false });
  run(SUN, 13.5); // no RPE, no heart rate, no personal model reading
  readAt(SUN, "easy", "07:00:00");
  const truth = dayTrainingTruth(SUN);
  assert.equal(truth.above_easy, true);
  assert.equal(truth.own_dose, null);
  assert.equal(readAdherenceOutcome("easy", truth), "diverged");
});

test("a heavy lift on top of the stated long run still takes the day past an easy read", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-05T20:00:00Z") });
  seedProfile();
  seedHistory();
  seedLiveWeek();
  liftedAt(SUN, "15:00:00", 4);
  const truth = dayTrainingTruth(SUN);
  assert.ok(truth.own_dose);
  assert.equal(truth.above_easy_beyond_own_dose, true, "the lift is not the week's run");
  assert.equal(readAdherenceOutcome("easy", truth), "diverged");
});

test("a long run on a morning a FLOOR made quiet is not the week's own dose — it is a real divergence", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-05T20:00:00Z") });
  seedProfile();
  seedHistory();
  seedLiveWeek();
  // The morning read was easy because of a sore knee being worked around.
  readAt(SUN, "easy", "07:00:00", {
    signals: { health_workaround: { field: "active_injury", reason: "knee" } },
  });
  const truth = dayTrainingTruth(SUN);
  assert.equal(truth.own_dose, null, "a floor-quiet morning exempts nothing");
  assert.equal(readAdherenceOutcome("easy", truth), "diverged");
});

test("a short watch walk before the first read is not the training the read lost to", () => {
  const date = "2026-09-18";
  const row = repo.addActivity({ type: "walk", date, distance_km: 1.2, duration_min: 12 });
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, duration_min, distance_km, raw_json)
     VALUES (?, ?, ?, ?, 'walking', 'Walk', 12, 1.2, ?)`
  ).run(garminSource(), `wa-${row.id}`, row.id, date, JSON.stringify({ beginTimestamp: Date.parse(`${date}T06:00:00Z`) }));
  const morning = readAt(date, "train", "07:00:00");
  liftedAt(date, "11:00:00");
  evaluateMatureExpectations("2026-09-21");
  assert.equal(verdictOf(morning).actual.read_call, "held");
});

// ══ B — the read owns the stated week ═══════════════════════════════════════════════

// A supporting runner who lifts Mon–Fri (stated) and runs Thu quality / Sun long (stated),
// with four steady weeks behind him and a band of his own nights.
function weekAthlete(today, { weeks = 4 } = {}) {
  const lift = (exercise, group) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, group });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Barbell Squat", muscle_group: "legs" });
  repo.savePlanDay(1, "Push", "Chest & shoulders", [lift("Barbell Bench Press")]);
  repo.savePlanDay(2, "Pull", "Back", [lift("Barbell Row")]);
  repo.savePlanDay(3, "Lower", "Legs", [lift("Barbell Squat")]);
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 0, kind: "long" },
        { dow: 4, kind: "quality" },
        { dow: 5, kind: "easy" },
      ],
      source: "athlete",
    },
  });
  repo.setSettings({ training_drive: "push" });
  const monday = addDays(today, -((dowOf(today) + 6) % 7));
  // Four steady weeks: enough of a running record, short of the six-week loaded streak
  // that earns a deload (a deload-due is structure the calendar never doses through).
  for (let w = 1; w <= weeks; w++) {
    const wk = addDays(monday, -7 * w);
    for (const [offset, km] of [
      [3, 8],
      [4, 6],
      [6, 12],
    ])
      repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, rpe: 3, date: addDays(wk, offset) });
  }
  for (let back = 1; back <= 20; back++) {
    repo.upsertGarminDailyMetric({
      date: addDays(today, -back),
      hrv_ms: [48, 50, 52, 54, 56][back % 5],
      resting_hr: [50, 51, 52, 53, 54][back % 5],
      sleep_min: 460,
    });
  }
}

const GOOD_NIGHT = { hrv_ms: 54, resting_hr: 50, sleep_min: 470, training_readiness: 72 };
const LOW_HRV_NIGHT = { ...GOOD_NIGHT, hrv_ms: 36 };

// Sunday 2026-10-18 (the long-run day), local noon.
function onSunday(t) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 18, 12, 0, 0) });
  const today = localDateISO();
  assert.equal(dowOf(today), 0);
  return today;
}
// Tuesday 2026-10-20 (a stated lifting day), local noon.
function onTuesday(t) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 20, 12, 0, 0) });
  const today = localDateISO();
  assert.equal(dowOf(today), 2);
  return today;
}

test("a push-stance athlete's stated long run under a low-HRV night reads TRAIN with a dose, not easy", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...LOW_HRV_NIGHT });
  const adj = weeklyRunPlan(today).today_adjustment;
  assert.ok(adj, "the run engine decided the long run this morning");
  assert.equal(adj.planned_kind, "long");
  assert.equal(adj.dose, "shortened", JSON.stringify(adj));
  const r = repo.dayRead(today);
  assert.equal(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "stated_key_run_dosed");
  assert.equal(r.why, adj.why, "the run engine's own sentence names the cause and the dose");
  assert.match(r.why, /HRV/);
  assert.equal(violatesReadingGrammar(r.why), null);
  assert.equal(r.signals.calendar_dose?.applied, true);
  assert.equal(r.signals.stated_run_day?.calendar_dosed, true);
});

test("a green Sunday keeps the plain stated run day (nothing to dose)", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...GOOD_NIGHT });
  const r = repo.dayRead(today);
  const detail = JSON.stringify({ dose: r.signals.calendar_dose, run: r.signals.stated_run_day, why: r.why });
  assert.equal(r.kind, "train", detail);
  assert.equal(r.decision.rule_code, "stated_run_day", detail);
  assert.equal(r.signals.calendar_dose, undefined, detail);
});

// ── floors: each one keeps the quiet read exactly as strict as before ──

test("floor: a deload the loaded weeks have earned is structure, never dosed through", (t) => {
  const today = onSunday(t);
  weekAthlete(today, { weeks: 6 });
  repo.upsertGarminDailyMetric({ date: today, ...GOOD_NIGHT });
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_key_run_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.calendar_dose, undefined);
});

test("floor: a rest-grade reading on the long-run morning still rests", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...LOW_HRV_NIGHT, training_readiness: 12 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.decision.rule_code, "stated_key_run_dosed");
});

test("floor: a short night keeps the long run's quiet read", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...LOW_HRV_NIGHT, sleep_min: 300 });
  const r = repo.dayRead(today);
  assert.notEqual(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.decision.rule_code, "stated_key_run_dosed");
});

test("floor: an injury keeps the long run's quiet read", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...LOW_HRV_NIGHT });
  repo.addContextEvent({ kind: "injury", title: "Sore left knee", start_date: addDays(today, -2) });
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_key_run_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.kind, "train");
});

test("floor: a doctor-governed endurance hold is never dosed through", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...LOW_HRV_NIGHT });
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive, status) VALUES ('health_review', 'training', 'Ferritin', ?, 'active')`
  ).run("Hold endurance volume while ferritin recovers.");
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_key_run_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.calendar_dose, undefined);
});

test("floor: at the hard ceiling of loading days the calendar does not walk past it", (t) => {
  const today = onSunday(t);
  weekAthlete(today);
  // Five loading days in a row, the last of them (Saturday) off the stated week.
  for (let back = 1; back <= 5; back++) liftedAt(addDays(today, -back), "10:00:00", 4);
  repo.upsertGarminDailyMetric({ date: today, ...LOW_HRV_NIGHT });
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_key_run_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
});

// The stated LIFTING day: a subdued (not rest-grade) readiness reading is a soft brake.
const SUBDUED_MORNING = { hrv_ms: 52, resting_hr: 51, sleep_min: 470, training_readiness: 30 };

test("a stated lifting day under a subdued reading keeps the session at a held dose", (t) => {
  const today = onTuesday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...SUBDUED_MORNING });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "stated_lift_dosed");
  assert.ok(r.focus, "the session that is due is named");
  assert.equal(violatesReadingGrammar(r.why), null);
  assert.equal(r.signals.push_bias, undefined, "no reach rides on a dosed day");
  assert.equal(r.signals.calendar_dose?.stepped_aside, "acute_signal_protection");
});

test("floor: a symptom report keeps the lifting day's quiet read", (t) => {
  const today = onTuesday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...SUBDUED_MORNING });
  repo.addContextEvent({ kind: "illness", title: "Head cold", start_date: today });
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_lift_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.kind, "train");
});

test("floor: a fueling hold keeps the lifting day's quiet read", (t) => {
  const today = onTuesday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...SUBDUED_MORNING });
  const r = repo.dayRead(today, undefined, undefined, {
    state: "persistent_strain",
    action: { line: "Fuel is being protected.", training: "hold_aggression" },
    agreeing_channels: ["intake", "performance", "recovery"],
  });
  assert.notEqual(r.decision.rule_code, "stated_lift_dosed", `${r.decision.rule_code}: ${r.why}`);
});

test("floor: rest-grade readiness on a lifting day still rests", (t) => {
  const today = onTuesday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...SUBDUED_MORNING, training_readiness: 10 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "rest_grade_readiness");
});

test("floor: a short night keeps the lifting day's quiet read", (t) => {
  const today = onTuesday(t);
  weekAthlete(today);
  repo.upsertGarminDailyMetric({ date: today, ...SUBDUED_MORNING, sleep_min: 290 });
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_lift_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.notEqual(r.kind, "train");
});

// ── B2 — the stated week's own tolerance, from outcomes ──

function dosedDay(date, harm) {
  readAt(date, "train", "07:00:00", { signals: { calendar_dose: { applied: true, day: "lift" } } });
  liftedAt(date, "11:00:00", harm ? 2 : 4); // a session rated under par is the harm arm
}

test("the tolerance tightens after costly dosed days and widens after clean ones — bounded", () => {
  const asOf = "2026-10-20";
  for (const n of [3, 5, 8]) dosedDay(addDays(asOf, -n), true);
  const tight = calendarDoseTolerance(readAdherenceModel(asOf, 44, 44), asOf);
  assert.equal(tight.level, "tight", JSON.stringify(tight));
  assert.ok(tight.weight >= -1 && tight.weight <= 1);

  resetTables("brain_decisions", "brain_expectations", "sessions", "logged_sets");
  for (const n of [2, 4, 6, 9, 11]) dosedDay(addDays(asOf, -n), false);
  const wide = calendarDoseTolerance(readAdherenceModel(asOf, 44, 44), asOf);
  assert.equal(wide.level, "wide", JSON.stringify(wide));
  assert.ok(wide.weight <= 1);

  // A thin record sits at neutral.
  resetTables("brain_decisions", "brain_expectations", "sessions", "logged_sets");
  dosedDay(addDays(asOf, -2), false);
  assert.equal(calendarDoseTolerance(readAdherenceModel(asOf, 44, 44), asOf).level, "neutral");
});

test("a tight tolerance hands the quiet read back on a stated lifting day", (t) => {
  const today = onTuesday(t);
  weekAthlete(today);
  for (const n of [7, 8, 9]) dosedDay(addDays(today, -n), true);
  repo.upsertGarminDailyMetric({ date: today, ...SUBDUED_MORNING });
  const r = repo.dayRead(today);
  assert.notEqual(r.decision.rule_code, "stated_lift_dosed", `${r.decision.rule_code}: ${r.why}`);
});

// ── B3 — the taper's leg trim is untouched ──

test("taper week still trims the legs and keeps the upper body progressing for a strength-led athlete", () => {
  const taper = raceStrengthPrinciple({ phase: "taper", kind: "taper", lead: "strength_led" });
  assert.equal(taper.mode, "taper_legs");
  assert.equal(taper.upper_progresses, true);
  const race = raceStrengthPrinciple({ phase: "taper", kind: "race", lead: "strength_led" });
  assert.equal(race.mode, "race_week");
});
