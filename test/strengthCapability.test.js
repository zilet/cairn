// The capability read (src/repo/strength-capability.ts): progress per movement unit and
// per muscle group, the single lift as evidence. These lock what an elite coach would
// insist on for an athlete who substitutes freely: a swap is not a reset, four pushdown
// variants are one pushdown, a lighter week or a lighter card is never a slide, holding
// through a cut is the win, legs carrying a run build are not a plateau, less assist is
// progress, and no line ever reads as a score or a gate.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import {
  CAPABILITY_CLIMBING_CHANGE,
  CAPABILITY_SLIPPING_CHANGE,
  CAPABILITY_TIER_WEIGHT,
  CAPABILITY_WINDOW_DAYS,
  capabilityRead,
  capabilityUnitOf,
} from "../dist/repo/strength-capability.js";
import {
  MOVEMENT_BETTER_CHANGE,
  MOVEMENT_TIER_WEIGHT,
  MOVEMENT_WINDOW_DAYS,
  MOVEMENT_WORSE_CHANGE,
} from "../dist/repo/movement-standing.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";

const TODAY = "2026-06-25";
const day = (delta) => addDaysISO(TODAY, delta);
const THEN = [-52, -45, -38, -31]; // the earlier window (the envelope as of TODAY - 28)
const NOW = [-24, -17, -10, -3]; // the current window

function reset() {
  resetTables(
    "daily_session_outcomes",
    "daily_session_compositions",
    "logged_sets",
    "sessions",
    "exercises",
    "plan_items",
    "plan_days",
    "activities",
    "recovery_cycles",
    "profile"
  );
  db.prepare(`INSERT INTO profile (id, goal_mode, weight_lb) VALUES (1, 'maintain', 180)`).run();
}
beforeEach(reset);

/** Log `sets` working sets per date through the set writer: series is [[delta, weight, reps], ...]. */
function logLift(name, muscle_group, series, { sets = 3, rir = null } = {}) {
  const exercise = repo.upsertExercise({ name, muscle_group });
  const sessions = [];
  for (const [delta, weight, reps] of series) {
    for (let n = 1; n <= sets; n++) {
      repo.logSetByName({ exercise: name, weight, reps, rir, date: day(delta), set_number: n });
    }
    sessions.push({ session: repo.getOrCreateSession(day(delta), null), delta, weight });
  }
  return { exercise, sessions };
}
const flat = (deltas, weight, reps = 5) => deltas.map((d) => [d, weight, reps]);
const read = () => capabilityRead(TODAY);
const unitOf = (key, r = read()) => r.units.find((u) => u.key === key);
const muscleOf = (group, r = read()) => r.muscles.find((m) => m.group === group);

/** The card for that session asked for `card`; the athlete's prior load was `prior` (movementStanding's fixture). */
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

function allLines(r) {
  return [r.overall?.line, ...r.units.map((u) => u.line), ...r.muscles.map((m) => m.line)].filter((l) => l != null);
}

test("the thresholds and weights are movement-standing's own", () => {
  assert.equal(CAPABILITY_CLIMBING_CHANGE, MOVEMENT_BETTER_CHANGE);
  assert.equal(CAPABILITY_SLIPPING_CHANGE, MOVEMENT_WORSE_CHANGE);
  assert.equal(CAPABILITY_WINDOW_DAYS, MOVEMENT_WINDOW_DAYS);
  assert.deepEqual({ ...CAPABILITY_TIER_WEIGHT }, { ...MOVEMENT_TIER_WEIGHT });
});

test("units: a compound by its pattern (horizontal push by press slot), an isolation lift by its region", () => {
  assert.deepEqual(capabilityUnitOf("Back Squat", "quads"), { key: "squat", kind: "pattern", compound: true });
  assert.equal(capabilityUnitOf("Bench Press", "chest").key, "horizontal-push:flat");
  assert.equal(capabilityUnitOf("Incline Dumbbell Press", "chest").key, "horizontal-push:incline");
  assert.equal(
    capabilityUnitOf("Machine Chest Press", "chest").key,
    "horizontal-push:flat",
    "a slotless press presses flat"
  );
  for (const name of ["Rope Pushdown", "Bar Pushdown", "V-Bar Pressdown", "Single Arm Cable Pushdown"])
    assert.deepEqual(capabilityUnitOf(name, "triceps"), { key: "triceps:pushdown", kind: "region", compound: false });
  assert.equal(capabilityUnitOf("Leg Curl", "hamstrings").key, "knee-flexion", "a leg curl is never a hinge");
  assert.equal(capabilityUnitOf("Frobnicator", null), null, "no pattern and no region: absent, never guessed");
});

test("nothing logged: the read stands, with nothing to say yet", () => {
  const r = read();
  assert.equal(r.available, true);
  assert.equal(r.date, TODAY);
  assert.deepEqual(r.units, []);
  assert.deepEqual(r.muscles, []);
  assert.equal(r.overall.verdict, "not_enough");
});

test("a swap from one pulldown to its sibling, with bridge sessions, reads as one continuous climbing unit", () => {
  // Lat pulldown through the earlier window, last trained a month ago (no "now" of its own).
  logLift("Lat Pulldown", "back", flat([-54, -47, -40, -33, -30], 120, 8));
  // The wide-grip version starts beside it (two bridge sessions within ten days at the same
  // reps), then climbs: three exposures, too few for an own-history read.
  logLift("Wide Grip Lat Pulldown", "back", [
    [-27, 100, 8],
    [-24, 100, 8],
    [-3, 110, 8],
  ]);
  const unit = unitOf("vertical-pull");
  assert.equal(unit.verdict, "climbing");
  const wide = unit.contributors.find((c) => c.exercise === "Wide Grip Lat Pulldown");
  const lat = unit.contributors.find((c) => c.exercise === "Lat Pulldown");
  assert.equal(wide.transfer, "learned");
  assert.equal(wide.direction, "climbing");
  assert.equal(lat.transfer, "none", "the lift no longer trained contributes nothing itself");
  assert.equal(lat.direction, "not_enough");
  assert.ok(!/\d/.test(unit.line) && !/ratio/i.test(unit.line), "a transfer ratio is never printed");
});

test("a swap with no bridge and no table ratio says not enough yet, never slipping", () => {
  logLift("Seated Cable Row", "back", flat([-54, -47, -40, -33, -30], 160, 10));
  // A different row, far lighter on its own numbers, three exposures, never beside the old one.
  logLift("Chest Supported Row", "back", flat([-10, -6, -2], 90, 10));
  const unit = unitOf("horizontal-pull");
  assert.equal(unit.verdict, "not_enough");
  assert.equal(unit.contributors.find((c) => c.exercise === "Chest Supported Row").transfer, "none");
  assert.match(unit.line, /not enough|few more comparable sessions/i);
});

test("four pushdown variants with two exposures each read as one pushdown unit with a direction", () => {
  const names = ["Rope Pushdown", "Bar Pushdown", "V-Bar Pressdown", "Single Arm Cable Pushdown"];
  names.forEach((name, i) => {
    logLift(name, "triceps", [
      [THEN[i], 40, 12],
      [NOW[i], 45, 12],
    ]);
  });
  const r = read();
  const pushdowns = r.units.filter((u) => u.key.startsWith("triceps:"));
  assert.equal(pushdowns.length, 1, "one unit, not four");
  const unit = pushdowns[0];
  assert.equal(unit.key, "triceps:pushdown");
  assert.equal(unit.kind, "region");
  assert.equal(unit.compound, false);
  assert.equal(unit.contributors.length, 4);
  assert.equal(unit.verdict, "climbing");
  assert.ok(unit.contributors.every((c) => c.transfer === "own" && c.exposures === 2));
});

test("a lift not trained for months contributes nothing", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 290)]);
  // Leg press trained heavy three months ago, then dropped.
  logLift("Leg Press", "quads", flat([-100, -95, -90], 600));
  // A hip thrust last done three months ago forms no unit in today's read at all.
  logLift("Hip Thrust", "glutes", flat([-100, -95], 300, 8));
  const r = read();
  const squat = unitOf("squat", r);
  assert.equal(squat.verdict, "climbing");
  const press = squat.contributors.find((c) => c.exercise === "Leg Press");
  assert.equal(press.direction, "not_enough");
  assert.equal(press.transfer, "none");
  assert.equal(
    r.units.some((u) => u.contributors.some((c) => c.exercise === "Hip Thrust")),
    false
  );
});

test("lighter-on-purpose sessions never produce slipping; the same loads with no card do", () => {
  const squat = logLift("Back Squat", "quads", [...flat(THEN, 300), [-25, 300, 5], ...flat([-14, -7, -2], 250)]);
  for (const { session, delta } of squat.sessions) {
    if (delta >= -14) storeDose(session, squat.exercise, { card: 250, prior: 300, top: 250 });
  }
  assert.equal(unitOf("squat").verdict, "holding");
  reset();
  logLift("Back Squat", "quads", [...flat(THEN, 300), [-25, 300, 5], ...flat([-14, -7, -2], 250)]);
  assert.equal(unitOf("squat").verdict, "slipping", "the control: the same log with no card is a slide");
});

test("a recovery week never produces slipping, and a flat unit inside it says so", () => {
  repo.scheduleRecoveryCycle({ effective_on: day(-6), exit_on: day(2), reason: "Recovery fixture" });
  logLift("Back Squat", "quads", [...flat(THEN, 300), [-25, 300, 5], [-12, 300, 5], ...flat([-6, -4, -2], 230)]);
  const unit = unitOf("squat");
  assert.notEqual(unit.verdict, "slipping");
  assert.equal(unit.verdict, "holding");
  assert.ok(unit.qualifiers.includes("recovery"));
  assert.match(unit.line, /lighter week/i);
});

test("a single low session in the current window is not yet a slide", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 300), [-2, 250, 5]]);
  assert.equal(unitOf("squat").verdict, "holding", "the decline needs two comparable exposures");
});

test("a flat unit in a cut carries the cut qualifier and says holding is the win", () => {
  repo.setProfile({ goal_mode: "lose", weight_lb: 190, goal_weight_lb: 175 });
  logLift("Bench Press", "chest", flat([...THEN, ...NOW], 205));
  logLift("Barbell Bent Over Row", "back", [...flat(THEN, 185), ...flat(NOW, 200)]);
  const r = read();
  const bench = unitOf("horizontal-push:flat", r);
  assert.equal(bench.verdict, "holding");
  assert.deepEqual(bench.qualifiers, ["cut"]);
  assert.match(bench.line, /through the cut/i);
  const row = unitOf("horizontal-pull", r);
  assert.equal(row.verdict, "climbing");
  assert.deepEqual(row.qualifiers, [], "a climbing unit needs no explanation");
});

test("a flat squat while weekly km ramps carries run_build; an upper-body unit does not", () => {
  // A lifter who also runs; four weeks of 20 km, then a 32 km week: the endurance
  // acute:chronic read is ramping.
  repo.setProfile({ primary_discipline: "hybrid" });
  let n = 0;
  const run = (delta, km) =>
    repo.addActivity({
      date: day(delta),
      type: "run",
      distance_km: km,
      duration_min: km * 6,
      source: "garmin",
      external_id: `run-${n++}`,
    });
  for (const w of [1, 2, 3, 4]) {
    run(-(7 * w + 1), 10);
    run(-(7 * w + 3), 10);
  }
  for (const delta of [-1, -2, -4, -5]) run(delta, 8);
  logLift("Back Squat", "quads", flat([...THEN, ...NOW], 275));
  logLift("Bench Press", "chest", flat([...THEN, ...NOW], 205));
  const r = read();
  const squat = unitOf("squat", r);
  assert.equal(squat.verdict, "holding");
  assert.ok(squat.qualifiers.includes("run_build"), `squat qualifiers ${squat.qualifiers}`);
  assert.match(squat.line, /run build/i);
  const bench = unitOf("horizontal-push:flat", r);
  assert.equal(bench.verdict, "holding");
  assert.ok(!bench.qualifiers.includes("run_build"));
  assert.match(muscleOf("quads", r).line, /run build/i);
  assert.doesNotMatch(muscleOf("chest", r).line, /run build/i);
});

test("the table ratio carries a swap downward only, and never manufactures a climb", () => {
  // Back squat a month ago; front squat now (three exposures, no bridge). The table reads
  // the front squat at three quarters of the back squat: at 0.85 of it the front squat is
  // past that estimate, which says nothing about a climb, so it holds.
  logLift("Back Squat", "quads", flat([-54, -47, -40, -33], 300));
  logLift("Front Squat", "quads", flat([-10, -6, -2], 255));
  let unit = unitOf("squat");
  const front = unit.contributors.find((c) => c.exercise === "Front Squat");
  assert.equal(front.transfer, "table");
  assert.equal(front.direction, "holding");
  assert.equal(unit.verdict, "holding");
  // Upward: a back squat started now never reads off an older front squat.
  reset();
  logLift("Front Squat", "quads", flat([-54, -47, -40, -33], 225));
  logLift("Back Squat", "quads", flat([-10, -6, -2], 300));
  unit = unitOf("squat");
  assert.equal(unit.contributors.find((c) => c.exercise === "Back Squat").transfer, "none");
  assert.equal(unit.verdict, "not_enough");
});

test("a swap whose bridge sessions disagree carries nothing across", () => {
  // The old row's last session a month ago; the new one starts inside the current window.
  logLift("Seated Cable Row", "back", flat([-55, -48, -41, -34, -31], 150, 10));
  // Two bridges at very different ratios (about fifteen percent apart).
  logLift("Chest Supported Row", "back", [
    [-27, 100, 10],
    [-24, 115, 10],
    [-3, 120, 10],
  ]);
  const unit = unitOf("horizontal-pull");
  assert.equal(unit.contributors.find((c) => c.exercise === "Chest Supported Row").transfer, "none");
  assert.equal(unit.verdict, "not_enough");
});

test("assisted pull-ups: less assist is climbing, more assist is slipping", () => {
  logLift("Assisted Pull-Up", "back", [...flat(THEN, -40, 8), ...flat(NOW, -20, 8)]);
  assert.equal(unitOf("vertical-pull").verdict, "climbing");
  reset();
  logLift("Assisted Pull-Up", "back", [...flat(THEN, -20, 8), ...flat(NOW, -45, 8)]);
  assert.equal(unitOf("vertical-pull").verdict, "slipping");
});

test("muscle read: units vote by share times hard sets, a touched share never votes", () => {
  // Chest: the flat press climbs on four hard sets a session; dips (triceps first, chest
  // a counted half) slip on three. Weighted, chest progresses; triceps (bench a half,
  // dips in full) do not.
  logLift("Bench Press", "chest", [...flat(THEN, 200), ...flat(NOW, 220)], { sets: 4 });
  logLift("Dips", "triceps", [...flat(THEN, 40, 8), ...flat(NOW, 20, 8)]);
  // The squat touches the back at a quarter share: it never votes for the back.
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 300)]);
  logLift("Seated Cable Row", "back", flat([...THEN, ...NOW], 160, 10));
  const r = read();
  assert.equal(unitOf("dip", r).verdict, "slipping");
  const chest = muscleOf("chest", r);
  assert.equal(chest.verdict, "progressing");
  assert.deepEqual([...chest.units].sort(), ["dip", "horizontal-push:flat"]);
  // Hard sets in the last three weeks: bench 3 sessions x 4, dips 3 x 3 at a half share.
  assert.equal(chest.weekly_hard_sets, Math.round(((12 + 4.5) / 3) * 10) / 10);
  assert.equal(chest.band, "low");
  assert.equal(muscleOf("triceps", r).verdict, "holding");
  const back = muscleOf("back", r);
  assert.equal(back.verdict, "holding", "the climbing squat's quarter share does not vote");
  assert.ok(!back.units.includes("squat"));
  assert.equal(muscleOf("quads", r).verdict, "progressing");
});

test("hard sets: far-from-failure sets are not hard, and the unit reports their trend", () => {
  logLift("Back Squat", "quads", flat(THEN, 275), { sets: 2 });
  logLift("Back Squat", "quads", flat(NOW, 275), { sets: 5 });
  logLift("Leg Extension", "quads", [...flat(THEN, 100, 12), ...flat(NOW, 100, 12)], { rir: 6 });
  const r = read();
  assert.equal(unitOf("squat", r).hard_sets_trend, "rising");
  assert.equal(unitOf("knee-extension", r).hard_sets_trend, null, "RIR six is never a hard set");
});

test("overall: one sentence over the compound units on the plan now", () => {
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
  ]);
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 295)]);
  logLift("Bench Press", "chest", [...flat(THEN, 200), ...flat(NOW, 215)]);
  // Off the plan and sliding: not part of the overall read.
  logLift("Barbell Bent Over Row", "back", [...flat(THEN, 200), ...flat(NOW, 170)], { sets: 6 });
  const r = read();
  assert.equal(unitOf("horizontal-pull", r).verdict, "slipping");
  assert.equal(unitOf("squat", r).in_plan, true);
  assert.equal(unitOf("horizontal-pull", r).in_plan, false);
  assert.equal(r.overall.verdict, "climbing");
  assert.equal(r.overall.line.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, r.overall.line);
  assert.match(r.overall.line, /stronger|climbing/i);
});

test("overall in a cut: holding is said as the goal state", () => {
  repo.setProfile({ goal_mode: "lose", weight_lb: 190, goal_weight_lb: 175 });
  logLift("Back Squat", "quads", flat([...THEN, ...NOW], 275));
  logLift("Bench Press", "chest", flat([...THEN, ...NOW], 205));
  const r = read();
  assert.equal(r.overall.verdict, "holding");
  assert.match(r.overall.line, /through the cut/i);
});

test("grammar over many dates: every line passes the reading grammar, with no digits and no gate", () => {
  repo.setProfile({ goal_mode: "lose", weight_lb: 190, goal_weight_lb: 175 });
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 270)]);
  logLift("Bench Press", "chest", [...flat(THEN, 200), ...flat(NOW, 215)]);
  logLift("Assisted Pull-Up", "back", [...flat(THEN, -40, 8), ...flat(NOW, -45, 8)]);
  logLift("Rope Pushdown", "triceps", [...flat(THEN, 40, 12), ...flat(NOW, 45, 12)]);
  logLift("Barbell Curl", "biceps", flat([-3], 60, 10));
  logLift("Lateral Raise", "shoulders", flat([...THEN, ...NOW], 20, 15));
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const date = addDaysISO(TODAY, -i);
    const r = capabilityRead(date);
    assert.equal(r.available, true);
    for (const line of allLines(r)) {
      seen.add(line);
      assert.equal(violatesReadingGrammar(line), null, line);
      assert.doesNotMatch(line, /\d/, `no digits: ${line}`);
      assert.doesNotMatch(line, /\b(?:must|should|stalled|new)\b/i, line);
      assert.doesNotMatch(line, /score|percent|ratio|baseline/i, line);
    }
  }
  assert.ok(seen.size > 6, "the wording rotates over the days");
});

test("a failed read is available:false, never a fabricated direction", () => {
  logLift("Back Squat", "quads", [...flat(THEN, 275), ...flat(NOW, 295)]);
  db.exec("ALTER TABLE plan_items RENAME TO plan_items_capability_fixture");
  let r;
  try {
    r = read();
  } finally {
    db.exec("ALTER TABLE plan_items_capability_fixture RENAME TO plan_items");
  }
  assert.equal(r.available, false);
  assert.equal(r.overall, null);
  assert.deepEqual(r.units, []);
  assert.deepEqual(r.muscles, []);
  assert.equal(read().available, true, "the read comes back once the table does");
});

// ---- fix round: false verdicts ------------------------------------------------------------

test("an earlier window that was all lighter on purpose is no baseline: no climb is measured against a deload", () => {
  // The whole earlier window was a card asking for less (met); the current window is honest.
  const squat = logLift("Back Squat", "quads", [...flat(THEN, 250), ...flat([-17, -10, -3], 280)]);
  for (const { session, delta } of squat.sessions) {
    if (delta <= -31) storeDose(session, squat.exercise, { card: 250, prior: 300, top: 250 });
  }
  const unit = unitOf("squat");
  assert.notEqual(unit.verdict, "climbing", "280 against a 250 deload is not a climb");
  assert.equal(unit.verdict, "not_enough");
  assert.equal(unit.contributors[0].transfer, "none");
});

test("a current window that was all lighter on purpose still reads, upward only, against the honest earlier window", () => {
  const squat = logLift("Back Squat", "quads", [...flat(THEN, 300), ...flat([-17, -10, -3], 250)]);
  for (const { session, delta } of squat.sessions) {
    if (delta >= -17) storeDose(session, squat.exercise, { card: 250, prior: 300, top: 250 });
  }
  const unit = unitOf("squat");
  assert.equal(unit.verdict, "holding", "a deload now is neither a slide nor nothing");
  assert.equal(unit.contributors[0].transfer, "own");
});

test("a lift back after a break starts fresh: below its old numbers it is not slipping", () => {
  // Trained three months ago, rested, back for the last three weeks a little lighter.
  logLift("Back Squat", "quads", [...flat([-110, -104, -98], 300), ...flat([-17, -10, -3], 260)]);
  const unit = unitOf("squat");
  assert.notEqual(unit.verdict, "slipping");
  assert.equal(unit.verdict, "not_enough");
  assert.doesNotMatch(unit.line, /eased|slipped|costing/i);
});

test("a continuous series with no earlier window still reads off its own first and last sessions", () => {
  logLift("Leg Press", "quads", [
    [-24, 400, 8],
    [-17, 410, 8],
    [-10, 420, 8],
    [-3, 430, 8],
  ]);
  const unit = unitOf("squat");
  assert.equal(unit.verdict, "climbing");
  assert.equal(unit.contributors[0].transfer, "own");
});

test("a unit is on the plan when any plan item falls in it: the pulldown he substitutes stays on the plan", () => {
  repo.savePlanDay(1, "Pull", "Pull", [{ exercise: "Wide Grip Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 }]);
  // He logs the plain lat pulldown only, and climbs; an off-plan row slides on more sets.
  logLift("Lat Pulldown", "back", [...flat(THEN, 120, 10), ...flat(NOW, 130, 10)]);
  logLift("Barbell Bent Over Row", "back", [...flat(THEN, 200), ...flat(NOW, 170)], { sets: 6 });
  const r = read();
  const pull = unitOf("vertical-pull", r);
  assert.equal(pull.in_plan, true, "the plan's pulldown unit, whichever pulldown was done");
  assert.equal(pull.verdict, "climbing");
  assert.equal(unitOf("horizontal-pull", r).in_plan, false);
  assert.equal(r.overall.verdict, "climbing", "the substituted unit counts in the overall read");
});

test("a contributor's own in_plan stays literal: a lift not written on the plan says so", () => {
  repo.savePlanDay(1, "Pull", "Pull", [{ exercise: "Pull-Up", sets: 3, rep_low: 5, rep_high: 8 }]);
  logLift("Lat Pulldown", "back", [...flat(THEN, 120, 10), ...flat(NOW, 130, 10)]);
  const pull = unitOf("vertical-pull");
  assert.equal(pull.in_plan, true);
  assert.equal(pull.contributors.find((c) => c.exercise === "Lat Pulldown").in_plan, false);
});
