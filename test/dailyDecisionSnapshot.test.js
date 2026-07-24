import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  buildDailySessionDecision,
  dailyDecisionFingerprint,
  decideDailySession,
  gatherDailyDecisionSnapshot,
  getLatestDailySessionDecision,
  recordDailySessionDecision,
} from "../dist/repo/daily-decision.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-06-10";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "activities",
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
