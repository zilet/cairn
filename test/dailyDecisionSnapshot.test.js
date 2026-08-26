import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  buildDailySessionDecision,
  dailyDecisionFingerprint,
  decideDailySession,
  gatherDailyDecisionSnapshot,
  getLatestDailySessionDecision,
  isTrainIntentOverride,
  recordDailySessionDecision,
} from "../dist/repo/daily-decision.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-06-10";

beforeEach(() => {
  resetTables(
    "brain_decisions",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "movement_tolerance_observations",
    "training_symptom_events",
    "activities",
    "daily_metrics",
    "garmin_daily_metrics",
    "checkins",
    "context_events",
    "plan_items",
    "plan_days"
  );
});

function seedPlan() {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225, warmup_sets: 2 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  repo.savePlanDay(2, "Upper body", "Push and pull", [
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 7, target_weight: 155 },
  ]);
}

function seedRestBaseline() {
  seedPlan();
  for (const date of ["2031-06-07", "2031-06-08", "2031-06-09"]) {
    repo.logSetByName({ date, exercise: "Back Squat", weight: 185, reps: 5, day_number: null });
  }
  // A first-person low-recovery check-in is an unambiguous deterministic rest
  // input even when the test database has no wearable history.
  repo.addCheckin(DATE, { sleep_feel: 1, energy: 3, mood: 3 });
}

test("gathering the same date twice yields an identical fingerprint", () => {
  seedPlan();
  const a = gatherDailyDecisionSnapshot(DATE);
  const b = gatherDailyDecisionSnapshot(DATE);
  assert.deepEqual(a, b);
  assert.equal(dailyDecisionFingerprint(a), dailyDecisionFingerprint(b));
});

test("decideDailySession is reproducible content-wise across calls", () => {
  seedPlan();
  const a = decideDailySession(DATE, {}, { now: "2031-06-10T09:00:00.000Z" }).envelope;
  const b = decideDailySession(DATE, {}, { now: "2031-06-10T09:00:00.000Z" }).envelope;
  assert.deepEqual(a, b);
  assert.ok(a.template.day_number != null);
  assert.equal(a.template.intent, "template");
});

test("absent optional signals degrade to the adaptive plan selection", () => {
  // Only a plan exists — no sessions, checkins, recovery, context, activities.
  seedPlan();
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.recovery.has_data, false);
  assert.equal(snap.recovery.readiness, null);
  assert.equal(snap.checkin, null);
  assert.equal(snap.feedback, null);
  assert.equal(snap.constraints.injuries.length, 0);
  const env = buildDailySessionDecision(snap, { now: "2031-06-10T09:00:00.000Z" });
  assert.equal(env.kind, "train");
  assert.equal(env.template.intent, "template");
  assert.ok(env.template.day_number != null);
});

test("with no plan days at all the snapshot still builds and reads custom", () => {
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.plan.day_number, null);
  assert.equal(snap.plan_items.length, 0);
  const env = buildDailySessionDecision(snap, { now: "2031-06-10T09:00:00.000Z" });
  assert.equal(env.template.intent, "custom");
});

test("explicit active symptom evidence constrains only movement-relevant candidates", () => {
  repo.savePlanDay(1, "Mixed", "Lower and upper", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 7, target_weight: 155 },
  ]);
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: DATE });

  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.feedback, null, "explicit symptom evidence is not duplicated as legacy session feedback");
  assert.ok(snap.constraints.injuries.some((injury) => injury.exercises.includes("back squat")));
  const env = buildDailySessionDecision(snap, { now: "2031-06-10T09:00:00.000Z" });
  assert.equal(env.candidates.find((candidate) => candidate.exercise === "Back Squat").action, "exclude");
  assert.notEqual(env.candidates.find((candidate) => candidate.exercise === "Bench Press").action, "exclude");
  assert.ok(env.hard_constraints.some((constraint) => constraint.code === "injury_exclusion"));
});

test("an explicitly re-reported legacy symptom participates in movement protection", () => {
  repo.savePlanDay(1, "Mixed", "Lower and upper", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    { exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 7, target_weight: 155 },
  ]);
  const session = repo.getOrCreateSession(DATE, null);
  db.prepare(`UPDATE sessions SET joint_pain = 'left knee' WHERE id = ?`).run(session.id);
  repo.seedLegacyTrainingSymptoms();
  const legacy = repo.listTrainingSymptoms({ on: DATE, seed_legacy: false })[0];
  assert.equal(legacy.legacy_unconfirmed, true);
  db.prepare(`UPDATE sessions SET joint_pain = NULL WHERE id = ?`).run(session.id);
  const rereported = repo.recurTrainingSymptom(legacy.id, { on: DATE, movement: "Back Squat" });
  assert.equal(rereported.source_kind, "legacy_session_feedback");
  assert.equal(rereported.legacy_unconfirmed, false);

  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.ok(snap.constraints.injuries.some((injury) => injury.exercises.includes("back squat")));
  const env = buildDailySessionDecision(snap, { now: "2031-06-10T09:00:00.000Z" });
  assert.equal(env.candidates.find((candidate) => candidate.exercise === "Back Squat").action, "exclude");
  assert.notEqual(env.candidates.find((candidate) => candidate.exercise === "Bench Press").action, "exclude");
});

test("daily context and injury reads are deterministic as of the requested date", () => {
  seedPlan();
  const upper = repo.getPlanDay(2);
  db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(upper.id);
  db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(upper.id);
  repo.addContextEvent({
    kind: "injury",
    title: "Future knee issue",
    start_date: "2031-06-12",
    meta: { area: "knee" },
  });
  repo.addContextEvent({ kind: "trip", title: "Future trip", start_date: "2031-06-12", end_date: "2031-06-15" });
  let snap = gatherDailyDecisionSnapshot(DATE);
  assert.deepEqual(snap.constraints.injuries, []);
  assert.equal(snap.constraints.travel, false);

  const past = repo.addContextEvent({
    kind: "injury",
    title: "Then-active knee issue",
    start_date: "2031-06-01",
    meta: { area: "knee" },
  });
  repo.resolveContextEvent(past.id, "2031-06-11");
  snap = gatherDailyDecisionSnapshot(DATE);
  assert.ok(snap.constraints.injuries.some((injury) => injury.title === "Then-active knee issue"));
  assert.notEqual(
    buildDailySessionDecision(snap).candidates.find((candidate) => candidate.exercise === "Back Squat").action,
    "overload"
  );
});

test("a historical snapshot excludes later feedback and recovery facts", () => {
  seedPlan();
  const historicalDate = addDaysISO(localDateISO(), -1);
  const priorDate = addDaysISO(historicalDate, -1);
  const futureDate = localDateISO();
  db.prepare(
    `INSERT INTO sessions (date, soreness, performance, joint_pain)
     VALUES (?, 2, 4, 'left shoulder'), (?, 5, 1, 'future knee')`
  ).run(priorDate, futureDate);
  repo.upsertGarminDailyMetric({ date: priorDate, training_readiness: 80, hrv: 62 });
  repo.upsertGarminDailyMetric({ date: futureDate, training_readiness: 10, hrv: 20 });

  const snap = gatherDailyDecisionSnapshot(historicalDate);
  assert.deepEqual(snap.feedback, {
    soreness: 2,
    performance: 4,
    joint_pain: "left shoulder",
    low_performance_count: 0,
  });
  assert.equal(snap.recovery.has_data, true);
  assert.equal(snap.recovery.readiness, "high");
});

test("train-anyway recognition requires explicit positive, non-negated intent", () => {
  for (const positive of ["train anyway", "train", "I want to train", "full workout", "I can lift today"]) {
    assert.equal(isTrainIntentOverride(positive), true, positive);
  }
  for (const negative of ["don't train", "cannot lift", "skip the full workout", "I am not going to train"]) {
    assert.equal(isTrainIntentOverride(negative), false, negative);
  }
  assert.equal(isTrainIntentOverride("Maybe a workout would be nice"), false);
});

test("recording a decision is idempotent by fingerprint and reads back", () => {
  seedPlan();
  const { envelope } = decideDailySession(DATE, {}, { now: "2031-06-10T09:00:00.000Z" });
  recordDailySessionDecision(envelope);
  recordDailySessionDecision(envelope);
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM daily_session_decisions WHERE date = ?`).get(DATE);
  assert.equal(rows.n, 1);
  const read = getLatestDailySessionDecision(DATE);
  assert.equal(read.input_fingerprint, envelope.input_fingerprint);
  assert.equal(read.kind, envelope.kind);
});

test("preparing a plan-source daily session records its decision metadata", () => {
  seedPlan();
  const prepared = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  assert.equal(prepared.reused, false);
  const decision = getLatestDailySessionDecision(DATE);
  assert.ok(decision, "a decision envelope should be persisted on plan-source acceptance");
  const row = db
    .prepare(`SELECT composition_id FROM daily_session_decisions WHERE date = ? ORDER BY id DESC LIMIT 1`)
    .get(DATE);
  assert.equal(row.composition_id, prepared.daily_session.id);
});

test("trusted plan-ledger rationale survives into a newly accepted daily snapshot", () => {
  seedPlan();
  const upper = repo.getPlanDay(2);
  db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(upper.id);
  db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(upper.id);
  const decision = db.prepare(
    `INSERT INTO brain_decisions
      (effective_date, kind, domain, summary, rationale, status, autonomy_tier, risk_class,
       reversible, action_json)
     VALUES (?, 'training_target', 'training', ?, ?, 'applied', 'quiet_apply', 'low', 1, ?)`
  ).run(
    DATE,
    "A measured squat step.",
    "Three crisp full-dose sessions earned this target.",
    JSON.stringify({
      changes: [{
        day_number: 1,
        exercise: "Back Squat",
        reason: "Three crisp full-dose sessions earned this target.",
        reason_provenance: {
          reason_code: "training_evidence",
          evidence_date: "2031-06-09",
          as_of_date: DATE,
          source_ref_type: "training_evidence_snapshot",
          source_ref_key: "squat",
        },
      }],
    })
  );

  const snap = gatherDailyDecisionSnapshot(DATE);
  const sourceItem = snap.plan_items.find((item) => item.exercise === "Back Squat");
  assert.equal(sourceItem.brain_decision_id, Number(decision.lastInsertRowid));
  assert.match(sourceItem.brain_change_reason, /Three crisp full-dose sessions/);

  const accepted = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" }).daily_session;
  const acceptedItem = accepted.items.find((item) => item.exercise === "Back Squat");
  assert.equal(acceptedItem.brain_decision_id, Number(decision.lastInsertRowid));
  assert.match(acceptedItem.brain_change_summary, /measured squat step/i);
  assert.match(acceptedItem.brain_change_reason, /Three crisp full-dose sessions/);
  assert.equal(acceptedItem.brain_change_reason_provenance.reason_code, "training_evidence");
  assert.equal(acceptedItem.brain_change_reversible, true);

  db.prepare(`UPDATE brain_decisions SET status = 'reverted', reverted_at = datetime('now') WHERE id = ?`).run(
    Number(decision.lastInsertRowid)
  );
  const afterUndo = repo.getActiveDailySession(DATE).items.find((item) => item.exercise === "Back Squat");
  assert.equal(afterUndo.brain_decision_id, null, "a reverted decision no longer renders an active Undo control");
  assert.equal(afterUndo.brain_change_summary, null);
  assert.equal(afterUndo.brain_change_reversible, null);
});

test("legacy accepted snapshot presentation removes relative yesterday language without mutating storage", () => {
  const session = repo.getOrCreateSession("2026-07-20", null);
  const rawNote =
    "Yesterday's clean sets earned this. NEW — start light, log your actual working value. Start light and log your actual working value.";
  db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, title, why, items_json, request_fingerprint)
     VALUES (1, ?, '2026-07-20', 'athlete_override', 'active', 'Legacy snapshot',
             'Yesterday earned a measured step.', ?, 'legacy-july-snapshot')`
  ).run(
    session.id,
    JSON.stringify([{ exercise: "Legacy Press", sets: 3, rep_low: 6, rep_high: 8, note: rawNote }])
  );

  const presented = repo.getActiveDailySession("2026-07-20");
  assert.doesNotMatch(`${presented.why} ${presented.items[0].note}`, /yesterday/i);
  assert.match(presented.why, /prior session/i);
  assert.equal((presented.items[0].note.match(/start light/gi) ?? []).length, 1);
  const stored = db
    .prepare(`SELECT why, items_json FROM daily_session_compositions WHERE date = '2026-07-20'`)
    .get();
  assert.match(stored.why, /Yesterday/);
  assert.match(stored.items_json, /Yesterday/);
});

test("a rest decision accepts the deterministic recovery composition, never the lifting template", () => {
  seedRestBaseline();
  const prepared = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  const accepted = prepared.daily_session;

  assert.equal(accepted.decision.kind, "rest");
  assert.equal(accepted.decision.baseline_kind, "rest");
  assert.equal(accepted.plan_day_id, null);
  assert.equal(accepted.focus, "Recovery");
  assert.deepEqual(accepted.items, []);
  assert.equal(accepted.provenance.label, "Adapted for today");
  assert.equal(accepted.constraints.daily_decision.input_fingerprint, accepted.decision.input_fingerprint);

  const persisted = getLatestDailySessionDecision(DATE);
  assert.equal(persisted.input_fingerprint, accepted.decision.input_fingerprint);
  assert.equal(persisted.template.day_number, null);
  assert.equal(persisted.template.intent, "custom");
});

test("rest plus explicit Train anyway becomes one capped plan-backed train composition", () => {
  seedRestBaseline();
  const first = repo.prepareDailySession({
    date: DATE,
    source: "adaptive_plan",
    train_anyway: true,
    provenance: { entry: "train_anyway" },
  });
  const accepted = first.daily_session;

  assert.equal(accepted.decision.kind, "train");
  assert.equal(accepted.decision.baseline_kind, "rest");
  assert.equal(accepted.decision.train_anyway, true);
  assert.ok(accepted.plan_day_id > 0, "the accepted composition retains its plan link");
  assert.ok(accepted.items.some((item) => item.kind !== "cardio"));
  assert.ok(accepted.items.filter((item) => item.kind !== "cardio").every((item) => item.sets <= 3));
  const acceptedWeighted = accepted.items.find((item) => item.target_weight != null);
  const selectedPlan = repo.getPlan().find((day) => Number(day.id) === Number(accepted.plan_day_id));
  const sourceWeighted = selectedPlan.items.find((item) => item.exercise === acceptedWeighted.exercise);
  assert.equal(
    acceptedWeighted.target_weight,
    sourceWeighted.target_weight,
    "hold intensity keeps the working load — it does not deload it"
  );
  assert.ok(accepted.est_minutes <= 40);
  assert.equal(accepted.provenance.label, "Training by choice");
  assert.equal(accepted.constraints.train_anyway, true);
  assert.match(accepted.why, /Training by choice/);

  const retried = repo.prepareDailySession({
    date: DATE,
    source: "adaptive_plan",
    train_anyway: true,
    provenance: { entry: "train_anyway" },
  });
  assert.equal(retried.reused, true);
  assert.equal(retried.daily_session.id, accepted.id);
  assert.equal(retried.daily_session.decision.input_fingerprint, accepted.decision.input_fingerprint);
  const primer = repo.sessionPrimer(DATE);
  assert.equal(primer.decision_fingerprint, accepted.decision.input_fingerprint);
  assert.equal(primer.decision_kind, "train");
  assert.equal(primer.provenance_label, "Training by choice");
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions WHERE date = ?`).get(DATE).n,
    1
  );
});

test("an idle gather omits signal_support and the envelope reach stays null", () => {
  seedPlan();
  repo.setSettings({ training_drive: "steady" });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.signal_support, undefined);
  const env = buildDailySessionDecision(snap, { now: "2031-06-10T09:00:00.000Z" });
  assert.equal(env.policy_version, "daily_decision_v7");
  assert.equal(env.reach.level, null);
  assert.deepEqual(env.reach.backed_by, []);
});

test("gather stamps signal_support when training_drive is push", () => {
  seedPlan();
  repo.setSettings({ training_drive: "push" });
  const snap = gatherDailyDecisionSnapshot(DATE);
  assert.equal(snap.signal_support.training_drive, "push");
  assert.equal(typeof snap.signal_support.backed, "boolean");
  assert.equal(typeof snap.signal_support.fresh_brake, "boolean");
  repo.setSettings({ training_drive: "steady" });
});
