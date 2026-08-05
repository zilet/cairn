// movementRiskFor (src/repo/movement-risk.ts) — the durable per-exercise
// tolerance memory the vary-ranking reads, so a movement that keeps hurting is
// deprioritized as a future swap-in instead of merely braked for one session.
//
// The load-bearing property is the ASYMMETRY: `flagged` takes a movement away
// from the athlete's swap pool, so nothing may reach it on the strength of
// silence — sparse data, an unknown exercise and an unreadable table all read
// "clear".
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { movementRiskFor } from "../dist/repo/movement-risk.js";

const TODAY = "2026-08-05";

function daysBefore(n) {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
}

function openSymptom(areaText, { onset, lastReported, scope = "area" }) {
  const info = db
    .prepare(
      `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
       VALUES ('test', ?, 'active', ?, ?, ?)`
    )
    .run(areaText, scope, onset, lastReported);
  return Number(info.lastInsertRowid);
}

function painOn(eventId, exercise, observedOn) {
  db.prepare(
    `INSERT INTO movement_tolerance_observations
       (symptom_event_id, session_id, exercise_id, movement_key, movement_name, observed_on, outcome, relevant)
     VALUES (?, NULL, ?, ?, ?, ?, 'pain_present', 1)`
  ).run(eventId, exercise.id, `exercise:${exercise.id}`, exercise.name, observedOn);
}

function squat() {
  return repo.upsertExercise({ name: "Barbell Back Squat", muscle_group: "legs" });
}

test("a movement nothing has ever been said about reads clear", () => {
  const exercise = squat();
  assert.deepEqual(movementRiskFor(exercise.id, TODAY), { risk: "clear", reason: null });
});

test("an unknown exercise reads clear rather than guessing", () => {
  assert.equal(movementRiskFor(999999, TODAY).risk, "clear");
  assert.equal(movementRiskFor(0, TODAY).risk, "clear");
  assert.equal(movementRiskFor(-3, TODAY).risk, "clear");
});

test("repeated pain on a movement inside the window flags it, with the evidence named", () => {
  const exercise = squat();
  const event = openSymptom("left knee", { onset: daysBefore(70), lastReported: daysBefore(10) });
  painOn(event, exercise, daysBefore(60));
  painOn(event, exercise, daysBefore(10));

  const risk = movementRiskFor(exercise.id, TODAY);
  assert.equal(risk.risk, "flagged");
  assert.match(risk.reason, /Barbell Back Squat/);
  assert.match(risk.reason, /2 separate days/);
  // Machine register, but never leaking a score or a raw day count as a grade.
  assert.doesNotMatch(risk.reason, /score|\b\d{1,3}\/100\b/);
});

test("two reports on ONE day are one complaint written twice, not a repeat", () => {
  const exercise = squat();
  const event = openSymptom("left knee", { onset: daysBefore(20), lastReported: daysBefore(5) });
  // Same day, two rows — the athlete's own words and the extraction's row.
  painOn(event, exercise, daysBefore(5));
  db.prepare(
    `INSERT INTO movement_tolerance_observations
       (symptom_event_id, session_id, exercise_id, movement_key, movement_name, observed_on, outcome, relevant, evidence_epoch)
     VALUES (?, NULL, ?, ?, ?, ?, 'pain_present', 1, 2)`
  ).run(event, exercise.id, `exercise:${exercise.id}`, exercise.name, daysBefore(5));

  assert.equal(movementRiskFor(exercise.id, TODAY).risk, "watch", "one day is one report, however many rows");
});

test("a single recent report is a watch; the same report gone cold is not", () => {
  const exercise = squat();
  // One report, two months old, on a watch the athlete has since closed. Inside the
  // 90-day window it is still HISTORY — one complaint nothing repeated — and a
  // single stale report is not a live signal.
  const event = openSymptom("left knee", { onset: daysBefore(60), lastReported: daysBefore(60) });
  painOn(event, exercise, daysBefore(60));
  db.prepare(`UPDATE training_symptom_events SET status = 'resolved', resolved_on = ? WHERE id = ?`).run(
    daysBefore(50),
    event
  );
  assert.equal(movementRiskFor(exercise.id, TODAY).risk, "clear");

  const fresh = repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "legs" });
  const recent = openSymptom("left hamstring", { onset: daysBefore(6), lastReported: daysBefore(6) });
  painOn(recent, fresh, daysBefore(6));
  const risk = movementRiskFor(fresh.id, TODAY);
  assert.equal(risk.risk, "watch");
  assert.match(risk.reason, /nothing has repeated/);
});

test("an unresolved symptom covering the movement is a watch even with no pain row on it", () => {
  const exercise = squat();
  openSymptom("left knee", { onset: daysBefore(9), lastReported: daysBefore(4) });
  const risk = movementRiskFor(exercise.id, TODAY);
  assert.equal(risk.risk, "watch");
  assert.match(risk.reason, /unresolved/);
  assert.match(risk.reason, /Barbell Back Squat/);
});

test("an unresolved symptom somewhere else entirely leaves the movement clear", () => {
  const exercise = squat();
  openSymptom("right elbow", { onset: daysBefore(9), lastReported: daysBefore(4) });
  assert.equal(movementRiskFor(exercise.id, TODAY).risk, "clear");
});

test("a systemic watch never establishes per-movement relevance", () => {
  const exercise = squat();
  openSymptom("everything feels off", { onset: daysBefore(9), lastReported: daysBefore(4), scope: "systemic" });
  assert.equal(movementRiskFor(exercise.id, TODAY).risk, "clear", "a watch that names no place loads no movement");
});

test("an open row nobody has spoken about in months stops standing as a live watch", () => {
  const exercise = squat();
  // Never resolved — closing a symptom is the athlete's call — but silent well past
  // the window, which is exactly the born-dead-forever shape this bound prevents.
  openSymptom("left knee", { onset: daysBefore(300), lastReported: daysBefore(200) });
  assert.equal(movementRiskFor(exercise.id, TODAY).risk, "clear");
});

test("a resolved symptom's old pain rows age out with the window", () => {
  const exercise = squat();
  const event = openSymptom("left knee", { onset: daysBefore(200), lastReported: daysBefore(190) });
  painOn(event, exercise, daysBefore(200));
  painOn(event, exercise, daysBefore(190));
  assert.equal(movementRiskFor(exercise.id, TODAY).risk, "clear", "last season's flare does not steer this season");
});
