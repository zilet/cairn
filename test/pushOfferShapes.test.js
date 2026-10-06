// pushOfferShapes.test.js — the push-offer evaluator (src/repo/push-offer.ts) run against
// realistic multi-week logs of four athlete shapes, end to end through the real program
// read, harm read and symptom lifecycle (no hand-built facts):
//   • strong & progressing  — four weeks, three sessions a week, every main lift climbing,
//                             rated strong, reps in reserve → the question is earned;
//   • stalled               — the same four weeks at the same loads and reps → never;
//   • injured               — the strong log plus an open knee symptom → never (symptom);
//   • recovering            — the strong log, but a session rated poor inside the harm
//                             window → never (harm): a day that cost something is not room to spare;
//   • thin                  — strong but only a handful of sessions → never (thin_log).
// The thresholds are documented in docs/ARCHITECTURE.md ("The push offer"); these cases are
// the evidence they produce sane answers, not absurd ones.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { pushOfferRead, OFFER_MIN_SESSIONS } from "../dist/repo/push-offer.js";
import { reportTrainingSymptom } from "../dist/repo/training-symptoms.js";

const today = () => localDateISO();

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "exercises",
    "plan_items",
    "plan_days",
    "activities",
    "training_symptom_events",
    "symptom_reports",
    "training_stances",
    "brain_decisions",
    "brain_expectations",
    "app_state",
    "checkins",
    "context_events",
    "daily_metrics",
    "garmin_daily_metrics",
    "program_blocks"
  );
});

const LIFTS = [
  { name: "Bench Press", group: "chest", start: 155, step: 5 },
  { name: "Back Squat", group: "quads", start: 205, step: 10 },
  { name: "Barbell Row", group: "back", start: 135, step: 5 },
];

/**
 * Four weeks of three sessions a week (every main lift each session). `progress`: loads
 * step up week on week; `rating`: the session rating; `rir`: reps in reserve on the top
 * sets; `sessions`: how many of the most recent session days to keep.
 */
function seedLog({ progress = true, rating = 4, rir = 2, sessions = 12 } = {}) {
  for (const lift of LIFTS) repo.upsertExercise({ name: lift.name, muscle_group: lift.group });
  const days = [];
  for (let week = 3; week >= 0; week--) for (const off of [6, 4, 2]) days.push(week * 7 + off);
  const kept = days.slice(-sessions);
  kept.forEach((back, i) => {
    const date = addDaysISO(today(), -back);
    const week = Math.floor(i / 3);
    for (const lift of LIFTS) {
      const weight = lift.start + (progress ? week * lift.step : 0);
      for (let s = 0; s < 3; s++) repo.logSetByName({ date, exercise: lift.name, weight, reps: 8, rir });
    }
    if (rating != null) db.prepare(`UPDATE sessions SET performance = ? WHERE date = ?`).run(rating, date);
  });
}

test("strong and progressing: the question is earned, in plain words", () => {
  seedLog();
  const read = pushOfferRead(today());
  assert.equal(read.eligible, true, JSON.stringify({ blockers: read.blockers, facts: read.facts }));
  assert.ok(read.facts.lifts_carried.length >= 2, JSON.stringify(read.facts.lifts_carried));
  assert.deepEqual(read.facts.lifts_struggling, []);
  assert.ok(read.evidence.length >= 2 && read.evidence.length <= 4);
  assert.ok(read.evidence.every((e) => !/\d+\s*%|score/i.test(e)), "plain words, never a score");
});

test("stalled: the same loads for four weeks never earn a push", () => {
  seedLog({ progress: false, rating: 3, rir: 0 });
  const read = pushOfferRead(today());
  assert.equal(read.eligible, false);
  assert.ok(read.blockers.includes("not_carried"), read.blockers.join(","));
  assert.deepEqual(read.facts.lifts_carried, [], "nothing reads as carried");
});

test("injured: the strong log with an open symptom is closed by the symptom floor", () => {
  seedLog();
  reportTrainingSymptom({ area_text: "left knee", onset_on: today(), report_text: "my left knee aches on stairs" });
  const read = pushOfferRead(today());
  assert.equal(read.eligible, false);
  assert.equal(read.blockers[0] === "symptom" || read.blockers.includes("symptom"), true, read.blockers.join(","));
  assert.deepEqual(read.evidence, [], "a closed question says nothing");
});

test("recovering: a session that cost something inside the fortnight closes the question", () => {
  seedLog();
  const recent = addDaysISO(today(), -2);
  db.prepare(`UPDATE sessions SET performance = 2 WHERE date = ?`).run(recent);
  const read = pushOfferRead(today());
  assert.equal(read.eligible, false);
  assert.ok(read.blockers.includes("harm"), read.blockers.join(","));
  assert.ok(read.facts.harm_dates.includes(recent));
});

test("thin: a strong week or so is not yet a log", () => {
  seedLog({ sessions: OFFER_MIN_SESSIONS - 1 });
  const read = pushOfferRead(today());
  assert.equal(read.eligible, false);
  assert.ok(read.blockers.includes("thin_log"), read.blockers.join(","));
});
