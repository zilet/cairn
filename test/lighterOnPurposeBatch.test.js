// The batched "was this exposure lighter on purpose?" read (whole-person-trajectory.ts
// `lighterOnPurposeReader`): one outcome query for many sessions, identity keys resolved
// once, the recovery-dose read skipped when the caller already knows. It must give the
// single read's answer (`exposureLighterOnPurpose`) for every (session, lift) pair.
// Synthetic fixtures; deterministic and offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exposureLighterOnPurpose, lighterOnPurposeReader } from "../dist/repo/whole-person-trajectory.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db, repo } from "./_seed.js";

const day = (delta) => addDaysISO(localDateISO(), delta);

function logged(name, group, delta, weight) {
  const exercise = repo.upsertExercise({ name, muscle_group: group });
  const session = repo.getOrCreateSession(day(delta), null);
  for (let n = 1; n <= 3; n++)
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, ?, ?)`).run(
      session.id,
      exercise.id,
      n,
      weight,
      5
    );
  return { exercise, session };
}

function storeDose(session, doses) {
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Card fixture', '[]', ?)`
    )
    .run(session.id, session.date, `card-${session.id}-${Math.random()}`);
  const facts = {
    schema_version: 4,
    skipped: [],
    dose_context: { comparable: true, non_comparable_reasons: [] },
    dose_evidence: doses.map(({ exercise, card, prior, top, verdict = "met", full = false }) => ({
      movement_key: `exercise:${exercise.id}`,
      exercise: exercise.name,
      mode: "reps",
      prescribed: { sets: 3, rep_low: 5, rep_high: 5, target_weight: card, target_seconds: null },
      achieved: { sets: 3, top_weight: top, top_reps: 5, top_seconds: null },
      full_load_reference: {
        sets: null,
        target_weight: null,
        target_seconds: null,
        rep_low: null,
        recent_working_weight: prior,
        recent_working_seconds: null,
      },
      performed_at_full_load: full,
      challenge_verdict: verdict,
      comparable: true,
      non_comparable_reasons: [],
    })),
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, session.date, JSON.stringify(facts));
}

test("the batched reader answers exactly as the single read, pair by pair", () => {
  const a = logged("Back Squat", "quads", -10, 225);
  const b = logged("Bench Press", "chest", -10, 185);
  const c = logged("Back Squat", "quads", -3, 245);
  const d = logged("Deadlift", "hamstrings", -6, 315);
  // Session a: the squat card asked for less and the athlete met it; the bench card did not.
  storeDose(a.session, [
    { exercise: a.exercise, card: 205, prior: 245, top: 205 },
    { exercise: b.exercise, card: 185, prior: 185, top: 185 },
  ]);
  // Session c: a dip the athlete fell short of still counts.
  storeDose(c.session, [{ exercise: c.exercise, card: 205, prior: 245, top: 195, verdict: "under_prescribed" }]);
  // Session d: no outcome row at all.
  const sessions = [a.session.id, c.session.id, d.session.id];
  const names = ["Back Squat", "Bench Press", "Deadlift", "back squat"];
  for (const opts of [{}, { recoveryChecked: true }]) {
    const read = lighterOnPurposeReader(sessions, opts);
    for (const id of [...sessions, 999999])
      for (const name of names) assert.equal(read(id, name), exposureLighterOnPurpose(id, name, opts), `${id} ${name} ${JSON.stringify(opts)}`);
  }
  const read = lighterOnPurposeReader(sessions, { recoveryChecked: true });
  assert.equal(read(a.session.id, "Back Squat"), true, "the card's dip is set aside");
  assert.equal(read(a.session.id, "Bench Press"), false);
  assert.equal(read(c.session.id, "Back Squat"), false, "a card the athlete fell short of still counts");
  assert.equal(read(d.session.id, "Deadlift"), false, "absence is never a set-aside");
});

test("an empty batch is no read at all", () => {
  const read = lighterOnPurposeReader([]);
  assert.equal(read(1, "Back Squat"), exposureLighterOnPurpose(1, "Back Squat"));
});
