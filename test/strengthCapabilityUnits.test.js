// The capability read's units, labels and muscle verdicts (src/repo/strength-capability.ts,
// src/repo/capability-region.ts). What the owner's real log showed and these lock:
//   - every pushdown is one pushdown, every lateral raise one lateral raise, and the common
//     accessory families each get a named unit instead of "<Pattern> accessory";
//   - the progress-only families never reach today's card (movementRegionKey stays silent);
//   - a tibialis raise is not a calf exercise, and a muscle follows its MAIN unit;
//   - thin evidence never reads slipping;
//   - at most one catch-all per pattern, said in plain words.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/repo/shared.js";
import {
  CATCH_ALL_MIN_LIFTS,
  MUSCLE_SLIPPING_MIN_WORK_SHARE,
  SLIPPING_MIN_WINDOW_SESSIONS,
  UNIT_MIN_SESSIONS,
  UNIT_NEVER_CREDITS,
  capabilityRead,
  capabilityUnitOf,
  recoveryWeekReader,
} from "../dist/repo/strength-capability.js";
import { activeRecoveryWeek } from "../dist/repo/recovery-week.js";
import { RECOVERY_WEEK_INSTRUCTION_PREFIX, stampRecoveryWeekApplied } from "../dist/repo/recovery-week-ledger.js";
import { PROGRESS_REGIONS, progressRegionKey } from "../dist/repo/capability-region.js";
import { MOVEMENT_REGIONS, movementRegionKey } from "../dist/repo/movement-region.js";

const TODAY = "2026-06-25";
const day = (delta) => addDaysISO(TODAY, delta);
const THEN = [-52, -45, -38, -31];
const NOW = [-24, -17, -10, -3];

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

function logLift(name, muscle_group, series, { sets = 3 } = {}) {
  repo.upsertExercise({ name, muscle_group });
  for (const [delta, weight, reps] of series) {
    for (let n = 1; n <= sets; n++)
      repo.logSetByName({ exercise: name, weight, reps, date: day(delta), set_number: n });
  }
}
const flat = (deltas, weight, reps = 10) => deltas.map((d) => [d, weight, reps]);
const read = () => capabilityRead(TODAY);
const unitOf = (key, r = read()) => r.units.find((u) => u.key === key);
const muscleOf = (group, r = read()) => r.muscles.find((m) => m.group === group);
const keyOf = (name, group = null) => capabilityUnitOf(name, group)?.key ?? null;

test("every pushdown attachment is one pushdown unit; a straight-arm pulldown is the lats'", () => {
  for (const name of [
    "Rope Pushdown",
    "Cable Rope Pushdown",
    "Straight Bar Pushdown",
    "V-Bar Pressdown",
    "Single Arm Cable Pushdown",
    "Reverse Grip Pushdown",
    "Tricep Press Down",
    "Triceps Rope Pull-Down",
    "Cable Tricep Push-Down",
  ])
    assert.equal(keyOf(name, "triceps"), "triceps:pushdown", name);
  assert.equal(keyOf("Straight Arm Pulldown", "back"), "straight-arm-pull");
  assert.equal(keyOf("Cable Pullover", "back"), "straight-arm-pull");
  assert.equal(keyOf("Lat Pulldown", "back"), "vertical-pull", "a lat pulldown stays the compound pull");
});

test("every lateral raise is one lateral raise unit; a front raise and an upright row are their own", () => {
  for (const name of [
    "Lateral Raise",
    "Dumbbell Lateral Raise",
    "Cable Lateral Raise",
    "Machine Lateral Raise",
    "Lean-Away Lateral Raise",
    "Lean Away Cable Laterals",
    "Single Arm Cable Lateral Raise",
    "Lateral Shoulder Raise",
    "Side Delt Raise",
  ])
    assert.equal(keyOf(name, "shoulders"), "lateral-raise", name);
  assert.equal(keyOf("Dumbbell Front Raise", "shoulders"), "front-raise");
  assert.equal(keyOf("Cable Upright Row", "shoulders"), "upright-row");
});

test("the common accessory families each have a named unit, never merged across muscles", () => {
  const expected = {
    "Overhead Cable Extension": "triceps:overhead",
    "Overhead Triceps Extension": "triceps:overhead",
    "Skull Crusher": "triceps:lying",
    "Lying Triceps Extension": "triceps:lying",
    "DB Kickback": "triceps:kickback",
    "Barbell Curl": "curl:supinated",
    "Hammer Curl": "curl:neutral",
    "Reverse Curl": "curl:pronated",
    "Standing Calf Raise": "calf:straight",
    "Seated Calf Raise": "calf:bent",
    "Tibialis Raise": "tibialis",
    "Leg Extension": "knee-extension",
    "Seated Leg Curl": "knee-flexion",
    "Lying Leg Curl": "knee-flexion",
    "Hip Abduction Machine": "hip-abduction",
    "Hip Adduction Machine": "hip-adduction",
    "Reverse Pec Deck": "rear-delt",
    "Face Pull": "rear-delt",
    "Reverse Cable Crossover": "rear-delt",
    "Pec Deck": "chest-fly",
    "Cable Crossover": "chest-fly",
    "Hip Thrust": "hip-thrust",
    "Cable Kickback": "glute-kickback",
    "Back Extension": "back-extension",
    "Barbell Shrug": "shrug",
    "Farmer's Walk": "carry",
    "Ab Wheel Rollout": "core:anti-extension",
    Plank: "core:anti-extension",
    "Cable Crunch": "core:flexion",
    "Hanging Leg Raise": "core:flexion",
    "Pallof Press": "core:rotation",
    "Side Plank": "core:lateral",
  };
  for (const [name, key] of Object.entries(expected)) assert.equal(keyOf(name), key, name);
  assert.notEqual(keyOf("Standing Calf Raise"), keyOf("Seated Calf Raise"), "straight and bent knee stay apart");
  assert.notEqual(keyOf("Hip Thrust"), keyOf("Cable Kickback"));
  for (const name of Object.keys(expected)) {
    const unit = capabilityUnitOf(name, null);
    assert.equal(unit.compound, false, `${name} is an accessory`);
    assert.doesNotMatch(unit.key, /:accessory$/, name);
  }
  // A raise only a group hint files is never an overhead press.
  assert.deepEqual(capabilityUnitOf("Cable Y Raise", "shoulders"), {
    key: "vertical-push:accessory",
    kind: "pattern",
    compound: false,
  });
});

test("the progress-only families never reach today's card", () => {
  for (const name of ["Plank", "Tibialis Raise", "Hip Abduction Machine", "Pec Deck", "Hip Thrust", "Farmer's Walk"]) {
    assert.ok(progressRegionKey(name), name);
    assert.equal(movementRegionKey(name), null, `${name}: no curated region, so a card never folds it`);
  }
  for (const key of PROGRESS_REGIONS) assert.ok(!MOVEMENT_REGIONS.includes(key), `${key} is not a card region`);
});

test("a tibialis raise never feeds the calves: the calves follow the calf raise", () => {
  assert.deepEqual([...UNIT_NEVER_CREDITS.tibialis], ["calves"]);
  logLift("Standing Calf Raise", "calves", flat([...THEN, ...NOW], 200, 12), { sets: 4 });
  // The tibialis raise slides clearly, on more sets than the calf raise.
  logLift("Tibialis Raise", "calves", [...flat(THEN, 45, 15), ...flat(NOW, 30, 15)], { sets: 5 });
  const r = read();
  assert.equal(unitOf("calf:straight", r).verdict, "holding");
  assert.equal(unitOf("tibialis", r).verdict, "slipping");
  assert.equal(unitOf("tibialis", r).label, "Tibialis raise");
  const calves = muscleOf("calves", r);
  assert.equal(calves.verdict, "holding");
  assert.deepEqual(calves.units, ["calf:straight"]);
  // Three sessions of four calf-raise hard sets in the last three weeks; no tibialis sets.
  assert.equal(calves.weekly_hard_sets, Math.round((12 / 3) * 10) / 10);
});

test("a muscle follows its main unit: a slipping minor unit never makes it slip", () => {
  // Chest: the flat press holds on four hard sets a session; the fly slides on three.
  logLift("Bench Press", "chest", flat([...THEN, ...NOW], 205, 5), { sets: 4 });
  logLift("Cable Fly", "chest", [...flat(THEN, 40, 12), ...flat(NOW, 30, 12)]);
  let r = read();
  assert.equal(unitOf("horizontal-push:flat", r).verdict, "holding");
  assert.equal(unitOf("chest-fly", r).verdict, "slipping");
  assert.equal(muscleOf("chest", r).verdict, "holding", "the main unit holds");
  // The other way round: the press carries most of the work and slides, so the chest does.
  reset();
  logLift("Bench Press", "chest", [...flat(THEN, 225, 5), ...flat(NOW, 195, 5)], { sets: 4 });
  logLift("Cable Fly", "chest", flat([...THEN, ...NOW], 40, 12), { sets: 2 });
  r = read();
  assert.equal(unitOf("horizontal-push:flat", r).verdict, "slipping");
  assert.equal(muscleOf("chest", r).verdict, "slipping");
  assert.ok(MUSCLE_SLIPPING_MIN_WORK_SHARE >= 0.5);
});

test("a muscle never progresses on a minor unit while its main unit holds", () => {
  logLift("Bench Press", "chest", flat([...THEN, ...NOW], 205, 5), { sets: 5 });
  logLift("Cable Fly", "chest", [...flat(THEN, 30, 12), ...flat(NOW, 40, 12)], { sets: 4 });
  const r = read();
  assert.equal(unitOf("chest-fly", r).verdict, "climbing");
  assert.equal(muscleOf("chest", r).verdict, "holding");
});

test("thin evidence: two or fewer sessions in the window never read slipping", () => {
  assert.equal(SLIPPING_MIN_WINDOW_SESSIONS, 3);
  assert.equal(UNIT_MIN_SESSIONS, 3);
  // One lift, four sessions before, two clearly lower now: holds, never slips.
  logLift("Back Squat", "quads", [...flat(THEN, 300, 5), ...flat([-10, -3], 250, 5)]);
  let unit = unitOf("squat");
  assert.equal(unit.verdict, "holding");
  assert.doesNotMatch(unit.line, /eased|slipped|costing/i);
  // Two pushdown variants, one lower session each in the window: two sessions, not a slide
  // (the declines are counted per session, never summed across variants into one).
  reset();
  logLift("Rope Pushdown", "triceps", [...flat([-50, -40], 50, 12), [-9, 40, 12]]);
  logLift("Bar Pushdown", "triceps", [...flat([-48, -38], 60, 12), [-4, 48, 12]]);
  unit = unitOf("triceps:pushdown");
  assert.notEqual(unit.verdict, "slipping");
  assert.equal(unit.verdict, "holding");
  // One session then and one now is two data points: not enough yet, in either direction.
  reset();
  logLift("Leg Extension", "quads", [
    [-40, 100, 12],
    [-5, 120, 12],
  ]);
  unit = unitOf("knee-extension");
  assert.equal(unit.verdict, "not_enough");
  assert.match(unit.line, /not enough|few more comparable sessions/i);
});

test("the read asks the recovery calendar once, and answers exactly as activeRecoveryWeek does", () => {
  resetTables("app_state", "plan_proposals");
  const from = day(-112);
  const dates = [];
  for (let d = from; d <= TODAY; d = addDaysISO(d, 1)) dates.push(d);
  const agrees = (label, expectDays) => {
    const reader = recoveryWeekReader(from, TODAY);
    let days = 0;
    for (const date of dates) {
      const truth = activeRecoveryWeek(date) != null;
      if (truth) days++;
      assert.equal(reader(date), truth, `${label}: ${date}`);
    }
    assert.equal(days > 0, expectDays, `${label}: the fixture ${expectDays ? "has" : "has no"} recovery days`);
  };
  agrees("no recovery week at all", false);
  // A legacy ledger week (an applied recovery-week proposal and its stamp).
  const proposal = db
    .prepare(
      `INSERT INTO plan_proposals (agent, instruction, parsed_json, status) VALUES ('recovery-week', ?, '{}', 'applied')`
    )
    .run(`${RECOVERY_WEEK_INSTRUCTION_PREFIX} fixture`);
  stampRecoveryWeekApplied(Number(proposal.lastInsertRowid), day(-60));
  agrees("a ledger week", true);
  // And a stored cycle after it.
  repo.scheduleRecoveryCycle({ effective_on: day(-20), exit_on: day(-13), reason: "Reader fixture" });
  agrees("a ledger week and a later cycle", true);
  resetTables("app_state", "plan_proposals");
});

test("at most one catch-all per pattern, said in plain words, and a lone leftover beside a named unit is not listed", () => {
  assert.equal(CATCH_ALL_MIN_LIFTS, 2);
  // Two triceps lifts no table names, beside a named pushdown unit.
  logLift("Rope Pushdown", "triceps", flat([...THEN, ...NOW], 50, 12));
  logLift("Cable Tricep Rope", "triceps", flat([...THEN, ...NOW], 30, 12));
  logLift("Tricep Machine", "triceps", flat([...THEN, ...NOW], 90, 12));
  let r = read();
  const catchAlls = r.units.filter((u) => u.key === "triceps:accessory");
  assert.equal(catchAlls.length, 1);
  assert.equal(catchAlls[0].label, "Other triceps work");
  assert.equal(catchAlls[0].contributors.length, 2);
  for (const unit of r.units) assert.doesNotMatch(unit.label, /accessory/i, unit.label);
  // Only one leftover beside the pushdowns: not listed, its sets still count for the triceps.
  reset();
  logLift("Rope Pushdown", "triceps", flat([...THEN, ...NOW], 50, 12));
  logLift("Cable Tricep Rope", "triceps", flat([...THEN, ...NOW], 30, 12));
  r = read();
  assert.equal(unitOf("triceps:accessory", r), undefined);
  assert.ok(unitOf("triceps:pushdown", r));
  // Three sessions x three hard sets each, two lifts, over three weeks.
  assert.equal(muscleOf("triceps", r).weekly_hard_sets, Math.round((18 / 3) * 10) / 10);
  // Alone, with no named triceps unit, the same lift reads as plain triceps work.
  reset();
  logLift("Cable Tricep Rope", "triceps", flat([...THEN, ...NOW], 30, 12));
  r = read();
  assert.equal(unitOf("triceps:accessory", r).label, "Triceps work");
  assert.match(unitOf("triceps:accessory", r).line, /triceps/i);
});
