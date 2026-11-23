// Strength by MOVEMENT (src/repo/movement-standing.ts): where each big pattern stands and
// which way it moved over four weeks, read across the pattern's lifts, never one lift.
// These lock the reads an elite coach would insist on: rotating a row is not a reset, a
// newly added lift is not a drop, pull-ups read by reps (and assist shrinking is
// progress), a lighter load the card asked for is not a slide, and the thresholds are
// the lift row's own size and asymmetry.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import {
  MOVEMENT_BETTER_CHANGE,
  MOVEMENT_WINDOW_DAYS,
  MOVEMENT_WORSE_CHANGE,
  liftLeadTier,
  movementStanding,
} from "../dist/repo/movement-standing.js";

const TODAY = "2026-06-25";
const day = (delta) => addDaysISO(TODAY, delta);
const THEN = [-52, -45, -38, -31]; // the earlier window (envelope as of TODAY - 28)
const NOW = [-21, -14, -7, -2]; // the current window

function reset() {
  resetTables(
    "daily_session_outcomes",
    "daily_session_compositions",
    "logged_sets",
    "sessions",
    "exercises",
    "plan_items",
    "plan_days",
    "profile"
  );
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'maintain', 180)`).run();
}
beforeEach(reset);

/** Log `sets` working sets per date: series is [[delta, weight, reps], ...]. */
function logLift(name, muscle_group, series, sets = 3) {
  const exercise = repo.upsertExercise({ name, muscle_group });
  const sessions = [];
  for (const [delta, weight, reps] of series) {
    const session = repo.getOrCreateSession(day(delta), null);
    for (let n = 1; n <= sets; n++) {
      db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, ?, ?)`).run(
        session.id,
        exercise.id,
        n,
        weight,
        reps
      );
    }
    sessions.push({ session, delta, weight });
  }
  return { exercise, sessions };
}
const flat = (deltas, weight, reps = 5) => deltas.map((d) => [d, weight, reps]);
const lineOf = (key) => movementStanding(TODAY).lines.find((line) => line.key === key);

/** The card for that session asked for `card`; the athlete's prior load was `prior`. */
function storeDose(session, exercise, { card, prior, top, verdict = "met" }) {
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
        performed_at_full_load: false,
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

test("nothing logged: not available, no lines", () => {
  const read = movementStanding(TODAY);
  assert.equal(read.available, false);
  assert.deepEqual(read.lines, []);
});

test("lines come in movement order, one per trained pattern, with the contract's fields", () => {
  logLift("Barbell Bent Over Row", "back", flat([...THEN, ...NOW], 185));
  logLift("Back Squat", "quads", flat([...THEN, ...NOW], 275));
  logLift("Bench Press", "chest", flat([...THEN, ...NOW], 205));
  const read = movementStanding(TODAY);
  assert.equal(read.available, true);
  assert.deepEqual(
    read.lines.map((line) => line.key),
    ["squat", "push", "row"]
  );
  const squat = read.lines[0];
  assert.deepEqual(Object.keys(squat).sort(), [
    "change",
    "direction",
    "key",
    "label",
    "lead_lift",
    "lifts_compared",
    "now_added_lb",
    "now_added_reps",
    "now_lb",
    "now_reps",
    "since",
  ]);
  assert.equal(squat.label, "Squat");
  assert.equal(squat.lead_lift, "Back Squat");
  assert.equal(squat.now_lb, Math.round(275 * (1 + 5 / 30)), "the capacity envelope, rounded");
  assert.equal(squat.now_reps, null);
  assert.equal(squat.now_added_lb, null);
  assert.equal(squat.direction, "holding");
  assert.equal(squat.since, day(-MOVEMENT_WINDOW_DAYS));
  assert.equal(squat.lifts_compared, 1);
});

test("rotating a lift inside the pattern is not a reset: the swap compares nothing, never a drop", () => {
  // Pendlay rows a month ago, bent-over rows now, at a LOWER est-1RM than the Pendlay.
  logLift("Pendlay Row", "back", flat(THEN, 205));
  logLift("Barbell Bent Over Row", "back", flat(NOW, 185));
  const row = lineOf("row");
  assert.equal(row.lead_lift, "Barbell Bent Over Row", "the lift trained now leads");
  assert.equal(row.lifts_compared, 0, "neither lift has a reading in both windows");
  assert.equal(row.change, null);
  assert.equal(row.direction, null, "a rotation is not comparable, never worse");
  assert.equal(row.since, null);
  assert.equal(row.now_lb, Math.round(185 * (1 + 5 / 30)));
});

test("a rotation beside a continuing lift reads the pattern's direction off the continuing lift", () => {
  logLift("Pendlay Row", "back", flat(THEN, 205));
  logLift("Barbell Bent Over Row", "back", flat(NOW, 185));
  // DB rows carried through both windows and climbed.
  logLift("DB Row", "back", [...flat(THEN, 80, 8), ...flat(NOW, 90, 8)]);
  const row = lineOf("row");
  assert.equal(row.lifts_compared, 1);
  assert.equal(row.direction, "better");
  assert.ok(Math.abs(row.change - (90 / 80 - 1)) < 0.002, `change ${row.change}`);
});

test("a newly added lift is not a drop: it contributes nothing until it has an earlier reading", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 285)]);
  // Front squats start this month, far lighter than the back squat.
  logLift("Front Squat", "quads", flat(NOW, 155));
  const squat = lineOf("squat");
  assert.equal(squat.lead_lift, "Back Squat");
  assert.equal(squat.lifts_compared, 1, "only the back squat is comparable");
  assert.equal(squat.direction, "better");
  assert.ok(squat.change > 0.03);
});

test("a lift dropped from the rotation stops counting once it is no longer trained", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 285)]);
  // Leg press was trained heavy a month ago and then dropped: no "now", no drag.
  logLift("Leg Press", "quads", flat(THEN, 500));
  const squat = lineOf("squat");
  assert.equal(squat.lifts_compared, 1);
  assert.equal(squat.direction, "better");
});

test("isolation lifts are never members: a leg curl is not a hinge, a leg extension not a squat", () => {
  logLift("Leg Curl", "hamstrings", [...flat(THEN, 120, 10), ...flat(NOW, 90, 10)]);
  logLift("Leg Extension", "quads", [...flat(THEN, 150, 10), ...flat(NOW, 100, 10)]);
  const read = movementStanding(TODAY);
  assert.equal(read.lines.find((l) => l.key === "hinge"), undefined);
  assert.equal(read.lines.find((l) => l.key === "squat"), undefined);
  assert.equal(read.available, false);
});

test("compounds lead and outweigh machines inside a pattern", () => {
  assert.equal(liftLeadTier("Bench Press", "chest"), 0, "the benchmark standard");
  assert.equal(liftLeadTier("Machine Chest Press", "chest"), 2, "a machine");
  assert.equal(liftLeadTier("Leg Curl", "hamstrings"), 3, "an accessory");
  // Bench up ~10%, machine press down ~10%, the same sets each: the pattern climbs.
  logLift("Bench Press", "chest", [...flat(THEN, 200), ...flat(NOW, 220)]);
  logLift("Machine Chest Press", "chest", [...flat(THEN, 200), ...flat(NOW, 180)]);
  const push = lineOf("push");
  assert.equal(push.lead_lift, "Bench Press");
  assert.equal(push.lifts_compared, 2);
  assert.equal(push.direction, "better");
  assert.ok(push.change > 0.02 && push.change < 0.05, `weighted toward the compound: ${push.change}`);
});

test("bodyweight pull-ups read by reps: no est-1RM, the best recent reps, more reps is better", () => {
  logLift("Pull-Up", "back", [...flat(THEN, null, 6), ...flat(NOW, null, 9)]);
  const pull = lineOf("pull");
  assert.equal(pull.lead_lift, "Pull-Up");
  assert.equal(pull.now_lb, null, "a bodyweight lead carries no load");
  assert.equal(pull.now_reps, 9);
  assert.equal(pull.now_added_lb, null, "the best set was at bodyweight");
  assert.equal(pull.direction, "better");
  assert.equal(pull.lifts_compared, 1);
});

test("assisted pull-ups: less assist at the same reps is better, and assisted reps are not bodyweight reps", () => {
  logLift("Assisted Pull-Up", "back", [...flat(THEN, -40, 8), ...flat(NOW, -20, 8)]);
  const pull = lineOf("pull");
  assert.equal(pull.lead_lift, "Assisted Pull-Up");
  assert.equal(pull.now_lb, null);
  assert.equal(pull.now_reps, null, "only unassisted reps count as reps at bodyweight");
  assert.equal(pull.direction, "better", "assist shrinking is progress");
});

test("weighted pull-ups read by effective load, never an est-1RM of the plates alone", () => {
  // +10 lb x6 a month ago, +25 lb x6 now, at 180 lb bodyweight. Epley on the plates alone
  // read this as 30 lb, up 73 percent; the pull moved 190 -> 205 lb of effective load.
  for (const name of ["Weighted Pull-Up", "Pull-Up"]) {
    reset();
    logLift(name, "back", [...flat(THEN, 10, 6), ...flat(NOW, 25, 6)]);
    const pull = lineOf("pull");
    assert.equal(pull.lead_lift, name);
    assert.equal(pull.now_lb, null, `${name}: no added-load est-1RM as the capacity`);
    assert.equal(pull.now_added_lb, 25, `${name}: the best recent set's added load`);
    assert.equal(pull.now_added_reps, 6);
    assert.equal(pull.now_reps, null, "no set at plain bodyweight");
    assert.equal(pull.direction, "better");
    assert.ok(Math.abs(pull.change - (205 / 190 - 1)) < 0.002, `${name}: effective-load change ${pull.change}`);
  }
});

test("a weighted day beside plain bodyweight sets quotes whichever set was harder", () => {
  // 12 at bodyweight beats +5 lb for 2 at 180 lb: the reps lead the line.
  logLift("Pull-Up", "back", [...flat(THEN, null, 10), ...flat([-21, -14, -7], null, 12), [-2, 5, 2]]);
  const pull = lineOf("pull");
  assert.equal(pull.now_reps, 12);
  assert.equal(pull.now_added_lb, null);
  assert.equal(pull.now_lb, null);
});

test("an all-assisted lead still reads: the least assist, never a missing line", () => {
  logLift("Assisted Pull-Up", "back", [...flat(THEN, -40, 8), ...flat(NOW, -25, 8)]);
  const pull = lineOf("pull");
  assert.equal(pull.lead_lift, "Assisted Pull-Up");
  assert.equal(pull.now_lb, null);
  assert.equal(pull.now_reps, null);
  assert.equal(pull.now_added_lb, -25, "the assist taken on the best recent set");
  assert.equal(pull.now_added_reps, 8);
  assert.equal(pull.direction, "better");
});

test("more assist at the same reps reads worse", () => {
  logLift("Assisted Pull-Up", "back", [...flat(THEN, -20, 8), ...flat(NOW, -45, 8)]);
  assert.equal(lineOf("pull").direction, "worse");
});

test("a lighter load the card asked for, and that was met, is not a slide", () => {
  const squat = logLift("Back Squat", "quads", [...flat(THEN, 300), [-25, 300, 5], ...flat([-14, -7, -2], 250)]);
  for (const { session, delta } of squat.sessions) {
    if (delta >= -14) storeDose(session, squat.exercise, { card: 250, prior: 300, top: 250 });
  }
  const line = lineOf("squat");
  assert.notEqual(line.direction, "worse");
  assert.equal(line.direction, "holding");
  // The envelope's own "now" still reports what the log shows.
  assert.equal(line.now_lb, Math.round(250 * (1 + 5 / 30)));
});

test("the same lighter loads with no card behind them do read worse", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 300), [-25, 300, 5], ...flat([-14, -7, -2], 250)]);
  assert.equal(lineOf("squat").direction, "worse");
});

test("thresholds: the lift row's size, asymmetric toward calling a climb before a slide", () => {
  assert.equal(MOVEMENT_BETTER_CHANGE, 0.01);
  assert.equal(MOVEMENT_WORSE_CHANGE, -0.015);
  const cases = [
    [202.5, "better"], // +1.25%
    [201, "holding"], // +0.5%
    [197.5, "holding"], // -1.25%: a climb this size would count, a slide does not
    [195, "worse"], // -2.5%
  ];
  for (const [now, expected] of cases) {
    reset();
    logLift("Bench Press", "chest", [...flat(THEN, 200), ...flat(NOW, now)]);
    assert.equal(lineOf("push").direction, expected, `200 -> ${now}`);
  }
});

test("facts only: no score, no level word, no sentence", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 285)]);
  const json = JSON.stringify(movementStanding(TODAY));
  assert.ok(!/score|percentile|beginner|novice|intermediate|advanced|elite/i.test(json));
});

test("between two lifts of one tier, the lift the athlete holds a goal on leads the line", () => {
  resetTables("strength_objectives");
  // The dumbbell bench collects more sets; the barbell bench carries the goal.
  logLift("Dumbbell Bench Press", "chest", [...THEN, ...NOW].map((d) => [d, 70, 8]), 4);
  logLift("Barbell Bench Press", "chest", [...THEN, ...NOW].map((d) => [d, 145, 6]), 2);
  const before = movementStanding(TODAY).lines.find((l) => l.key === "push");
  assert.equal(before.lead_lift, "Dumbbell Bench Press", "with no goal, the sets decide");
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 200 });
  const after = movementStanding(TODAY).lines.find((l) => l.key === "push");
  assert.equal(after.lead_lift, "Barbell Bench Press");
});
