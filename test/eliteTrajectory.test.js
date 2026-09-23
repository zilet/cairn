// The whole-person trajectory judges the athlete's REAL progress:
//   • the strength domain reads "worse" only when declining lifts are a meaningful
//     share of the lifts trained recently — one squat dip against fourteen lifts
//     advancing is not a regressing athlete;
//   • a dip the card asked for (a lower prescription the athlete completed) is not
//     evidence of regression;
//   • a lift untrained for longer than the current window has no present trend;
//   • the underfueling performance channel applies the SAME bar, never a stricter one;
//   • the endurance domain counts a hand log shadowing a synced effort once.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import {
  STRENGTH_DECLINE_MIN_LIFTS,
  strengthDeclineIsMeaningful,
  wholePersonTrajectory,
} from "../dist/repo/whole-person-trajectory.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";
import { LIFT_CURRENT_WINDOW_DAYS } from "../dist/repo/program-state.js";

const END = "2026-06-25";
const day = (delta) => addDaysISO(END, delta);

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "daily_session_outcomes",
    "daily_session_compositions",
    "logged_sets",
    "sessions",
    "exercises",
    "profile"
  );
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'maintain', 180)`).run();
});

const strengthOf = (read) => read.domains.find((domain) => domain.domain === "strength");
const enduranceOf = (read) => read.domains.find((domain) => domain.domain === "endurance");

/** Log one top set per date: `series` is [[daysBeforeEnd, weight, reps], ...]. */
function logLift(name, series, muscle_group = "quads") {
  const exercise = repo.upsertExercise({ name, muscle_group });
  const sessions = [];
  for (const [delta, weight, reps = 5] of series) {
    const session = repo.getOrCreateSession(day(delta), null);
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, ?, ?)`).run(
      session.id,
      exercise.id,
      weight,
      reps
    );
    sessions.push({ session, delta, weight });
  }
  return { exercise, sessions };
}

const advancing = (name, offset = 0) =>
  logLift(name, [
    [-40 + offset, 100],
    [-30 + offset, 104],
    [-20 + offset, 110],
    [-10 + offset, 115],
  ]);
const declining = (name, offset = 0) =>
  logLift(name, [
    [-40 + offset, 200],
    [-30 + offset, 198],
    [-20 + offset, 180],
    [-10 + offset, 176],
  ]);

/** The card for that session asked for `card`; the athlete's prior load was `prior`. */
function storeDose(session, exercise, { card, prior, top, verdict, fullLoad = false }) {
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Card fixture', '[]', ?)`
    )
    .run(session.id, session.date, `card-${session.id}`);
  const facts = {
    schema_version: 4,
    skipped: [],
    dose_context: { comparable: true, non_comparable_reasons: [] },
    dose_evidence: [
      {
        movement_key: `exercise:${exercise.id}`,
        exercise: exercise.name,
        mode: "reps",
        prescribed: { sets: 1, rep_low: 5, rep_high: 5, target_weight: card, target_seconds: null },
        achieved: { sets: 1, top_weight: top, top_reps: 5, top_seconds: null },
        full_load_reference: {
          sets: null,
          target_weight: null,
          target_seconds: null,
          rep_low: null,
          recent_working_weight: prior,
          recent_working_seconds: null,
        },
        performed_at_full_load: fullLoad,
        challenge_verdict: verdict,
        comparable: true,
        non_comparable_reasons: [],
      },
    ],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, session.date, JSON.stringify(facts));
}

// ── the bar itself ────────────────────────────────────────────────────────────
test("a strength decline is meaningful only as a share of what was trained", () => {
  assert.equal(STRENGTH_DECLINE_MIN_LIFTS, 2);
  // The shape: Back Squat alone against fourteen advancing lifts.
  assert.equal(strengthDeclineIsMeaningful({ improving: 14, declining: 1, steady: 4 }), false);
  assert.equal(strengthDeclineIsMeaningful({ improving: 11, declining: 2, steady: 4 }), false);
  assert.equal(strengthDeclineIsMeaningful({ improving: 1, declining: 1, steady: 0 }), false, "a tie is not a decline");
  assert.equal(strengthDeclineIsMeaningful({ improving: 0, declining: 1, steady: 1 }), false, "one of two is not most");
  assert.equal(strengthDeclineIsMeaningful({ improving: 0, declining: 0, steady: 5 }), false);
  assert.equal(strengthDeclineIsMeaningful({ improving: 1, declining: 2, steady: 6 }), true);
  assert.equal(strengthDeclineIsMeaningful({ improving: 0, declining: 1, steady: 0 }), true, "a one-lift athlete's one lift");
});

// ── the strength domain ───────────────────────────────────────────────────────
test("one lift sliding against several advancing does not mark the domain worse", () => {
  declining("Back Squat");
  advancing("Bench Press", 1);
  advancing("Overhead Press", 2);
  advancing("Barbell Row", 3);
  const read = wholePersonTrajectory({ end: END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "better");
  assert.deepEqual(strength.lift_counts, { improving: 3, declining: 1, steady: 0, prescribed_lower: 0, not_recent: 0 });
  // Never hidden — the slipping lift is still named for the specialists.
  assert.match(strength.why, /Back Squat/);
  assert.match(strength.why, /slipping/);
  assert.ok(!read.unexplained_worse.includes("strength"));
  assert.doesNotMatch(JSON.stringify(read), /score|\b\d{1,3}\/100\b/);
});

test("more lifts sliding than advancing still reads worse, and still names both", () => {
  declining("Back Squat");
  declining("Deadlift", 1);
  advancing("Bench Press", 2);
  const read = wholePersonTrajectory({ end: END, days: 56 });
  const strength = strengthOf(read);
  assert.equal(strength.verdict, "worse");
  assert.equal(strength.lift_counts.declining, 2);
  assert.match(strength.why, /Back Squat/);
  assert.match(strength.why, /other lift is still advancing/);
  assert.ok(read.unexplained_worse.includes("strength"));
});

test("lifts untrained inside the current window are not part of the present read", () => {
  // Two slides that ended weeks ago, one lift advancing now.
  const stale = -(LIFT_CURRENT_WINDOW_DAYS + 2);
  logLift("Face Pull", [[stale - 21, 60], [stale - 14, 60], [stale - 7, 50], [stale, 48]]);
  logLift("Lateral Raise", [[stale - 21, 30], [stale - 14, 30], [stale - 7, 25], [stale, 24]]);
  advancing("Bench Press");
  const strength = strengthOf(wholePersonTrajectory({ end: END, days: 56 }));
  assert.notEqual(strength.verdict, "worse");
  assert.equal(strength.lift_counts.not_recent, 2);
  assert.equal(strength.lift_counts.declining, 0);
});

test("a dip the card asked for, completed, is not evidence of regression", () => {
  const { exercise, sessions } = declining("Back Squat");
  // The two late exposures were prescribed below the prior 200 working load and
  // done as written.
  for (const { session, weight } of sessions.slice(2)) {
    storeDose(session, exercise, { card: weight, prior: 200, top: weight, verdict: "met" });
  }
  const read = wholePersonTrajectory({ end: END, days: 56 });
  const strength = strengthOf(read);
  assert.notEqual(strength.verdict, "worse");
  assert.equal(strength.lift_counts.prescribed_lower, 1);
  assert.equal(strength.lift_counts.declining, 0);
  assert.match(strength.why, /card prescribed a lighter load/);
  assert.ok(!read.unexplained_worse.includes("strength"));
});

test("a lower card the athlete fell short of, or full-load work, still counts", () => {
  const { exercise, sessions } = declining("Back Squat");
  const [third, fourth] = sessions.slice(2);
  // Short of even the lighter card: the slide is the athlete's, not the card's.
  storeDose(third.session, exercise, { card: 185, prior: 200, top: third.weight, verdict: "under_prescribed" });
  // Work performed at full load is evidence whatever the card said.
  storeDose(fourth.session, exercise, { card: 170, prior: 200, top: fourth.weight, verdict: "met", fullLoad: true });
  const strength = strengthOf(wholePersonTrajectory({ end: END, days: 56 }));
  assert.equal(strength.verdict, "worse");
  assert.equal(strength.lift_counts.prescribed_lower, 0);
});

// ── the performance channel applies the same bar ─────────────────────────────
const onPathExp = { trend_lb_wk: -0.55, confidence: "high", window_days: 21, coverage: { weigh_in_days: 12 } };
const goal = { leanness_rate: { lean_ideal_rate_lb: 0.6, safe_max_rate_lb: 0.85 } };
const perfOf = (r) => r.channels.find((c) => c.key === "performance");
const lift = (exercise, status, daysAgo = 3) => ({ exercise, status, last_trained: day(-daysAgo) });

test("the performance channel defers to the trajectory's proportionate read", () => {
  // Program state sees two recent slides; the trajectory weighed them against
  // eleven lifts advancing and called the domain better.
  const program = {
    lifts: [lift("Pendlay Row", "regressing"), lift("Machine Chest Press", "regressing")],
    mesocycle: { acute_chronic_ratio: 1.0 },
    hybrid: null,
  };
  const whole = {
    domains: [
      {
        domain: "strength",
        verdict: "better",
        lift_counts: { improving: 11, declining: 2, steady: 4, prescribed_lower: 0, not_recent: 0 },
        evidence_keys: [],
      },
    ],
  };
  const read = underfuelingRead(END, { expenditure: onPathExp, goal, programState: program, wholePerson: whole });
  assert.notEqual(perfOf(read).direction, "strain");
  // …and a trajectory that did call it worse still votes strain.
  const worse = { domains: [{ ...whole.domains[0], verdict: "worse" }] };
  const strained = underfuelingRead(END, { expenditure: onPathExp, goal, programState: program, wholePerson: worse });
  assert.equal(perfOf(strained).direction, "strain");
});

test("without a trajectory tally, program state answers through the same bar", () => {
  const whole = { domains: [{ domain: "recovery_wellbeing", verdict: "holding", evidence_keys: [] }] };
  const run = (lifts) =>
    perfOf(
      underfuelingRead(END, {
        expenditure: onPathExp,
        goal,
        programState: { lifts, mesocycle: { acute_chronic_ratio: 1.0 }, hybrid: null },
        wholePerson: whole,
      })
    ).direction;
  const slides = [lift("Squat", "regressing"), lift("Bench", "regressing")];
  const advances = ["Row", "Press", "Curl"].map((name) => lift(name, "progressing"));
  assert.notEqual(run([...slides, ...advances]), "strain", "two slides against three advances is not strain");
  assert.equal(run(slides), "strain", "two slides with nothing advancing still is");
});

// ── endurance reads through shadows ──────────────────────────────────────────
test("a hand log shadowing a synced run never manufactures an endurance direction", () => {
  const synced = (delta, km) =>
    db
      .prepare(
        `INSERT INTO activities (date, type, source, external_id, distance_km, duration_min) VALUES (?, 'run', 'garmin', ?, ?, ?)`
      )
      .run(day(delta), `g${delta}`, km, km * 6);
  synced(-30, 10);
  synced(-20, 6);
  synced(-10, 6);
  // The athlete typed the last run into chat after the watch synced it.
  db.prepare(`INSERT INTO activities (date, type, raw_text, distance_km) VALUES (?, 'run', 'easy 6k', 6)`).run(day(-10));
  const endurance = enduranceOf(wholePersonTrajectory({ end: END, days: 56 }));
  // Three real runs are too few to call a direction; the shadow made it four.
  assert.equal(endurance.verdict, "unknown");
  assert.deepEqual(endurance.evidence_keys, [`activities:${day(-55)}..${END}:n=3`]);
});
