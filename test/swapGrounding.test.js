// Rotating a movement into the plan GROUNDS it — the tiers in applyPlanSwap plus
// the deterministic related-lift map behind tier 3.
//
// The bug this pins: buildSwapProposal emits {swap:{from,to}} with no target, so
// applyPlanSwap wrote target_weight = NULL and "start light, log your actual
// working value" — even when the incoming lift had 95 lb × 10 × 3 in its own logs
// from the day before. Grounding has to be server code, because the agent path
// only ever grounded when the MODEL happened to supply a number.
//
// Tiers, in order: a supplied target → the incoming lift's own history → a
// conservative starting idea from a related lift → the baseline cue.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  applySwapSmart,
  buildAndApplySwap,
  buildProgressionProposal,
  nextPrescription,
} from "../dist/repo/progression.js";
import { classifyLiftSlot, relatedLiftStart, RELATED_LIFT_RATIOS } from "../dist/repo/related-lift.js";
import { localDateISO } from "../dist/repo/shared.js";

function reset() {
  for (const t of ["logged_sets", "plan_items", "plan_days", "sessions", "exercises", "plan_proposals", "brain_decisions"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}
beforeEach(reset);

function isoDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}
function logSet(name, date, { weight = null, reps = null, rir = null, duration_sec = null, setNum = 1 } = {}) {
  const ex = repo.findExercise(name) ?? repo.upsertExercise({ name });
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, setNum, weight, reps, rir, duration_sec);
}
function itemOn(day, name) {
  return repo.getPlanDay(day).items.find((it) => it.exercise === name);
}

// ── the related-lift map (pure) ───────────────────────────────────────────────

test("classifyLiftSlot names only the movements it can name with confidence", () => {
  const named = [
    ["Bench Press", "bench_flat_barbell"],
    ["Barbell Bench Press", "bench_flat_barbell"],
    ["Incline Bench Press", "bench_incline_barbell"],
    ["DB Bench Press", "bench_flat_dumbbell"],
    ["Incline Dumbbell Press", "bench_incline_dumbbell"],
    ["Overhead Press", "press_overhead_barbell"],
    ["Seated Dumbbell Shoulder Press", "press_overhead_dumbbell"],
    ["Squat", "squat_back_barbell"],
    ["Back Squat", "squat_back_barbell"],
    ["Front Squat", "squat_front_barbell"],
    ["Deadlift", "hinge_deadlift_barbell"],
    ["Romanian Deadlift", "hinge_rdl_barbell"],
    ["Barbell Row", "row_bentover_barbell"],
    ["Dumbbell Row", "row_dumbbell"],
  ];
  for (const [name, slot] of named) assert.equal(classifyLiftSlot(name), slot, name);

  // An unrecognized word disqualifies the whole name — a machine's numbers are not
  // a barbell's, and a variant we can't name is a variant we can't anchor.
  const unnamed = [
    "Smith Machine Bench Press",
    "Close Grip Bench Press",
    "Leg Press",
    "Goblet Squat",
    "Sumo Deadlift",
    "Trap Bar Deadlift",
    "Seated Cable Row",
    "Hammer Curl",
    "Incline Press",
    "Chest Press",
    "Temporal Back Squat",
    "",
  ];
  for (const name of unnamed) assert.equal(classifyLiftSlot(name), null, name);
});

test("every ratio points DOWNHILL — the map never extrapolates upward from a lighter lift", () => {
  assert.ok(RELATED_LIFT_RATIOS.length > 0);
  for (const edge of RELATED_LIFT_RATIOS) {
    assert.ok(edge.ratio > 0 && edge.ratio <= 1, `${edge.from} → ${edge.to} is ${edge.ratio}`);
    assert.notEqual(edge.from, edge.to);
    assert.ok(edge.basis.length > 0, "each pair says why it is trustworthy");
  }
});

test("relatedLiftStart reads a conservative start off a related lift's real history", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  for (const d of [8, 1]) logSet("Bench Press", isoDaysAgo(d), { weight: 95, reps: 10, rir: 2 });

  const start = relatedLiftStart("Incline Bench Press");
  assert.ok(start, "the flat bench anchors the incline");
  assert.equal(start.source_exercise, "Bench Press");
  assert.equal(start.source_weight, 95);
  // 0.80 × 95 = 76, rounded DOWN to a plate you can actually load.
  assert.equal(start.weight, 75);
  assert.equal(start.weight % 5, 0, "rounds down to a practical increment");
  assert.ok(start.weight < start.source_weight, "the idea is never heavier than the anchor");
});

test("relatedLiftStart stays silent without an anchor, and never anchors off an assist", () => {
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  assert.equal(relatedLiftStart("Incline Bench Press"), null, "no related history → no idea");

  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  assert.equal(relatedLiftStart("Incline Bench Press"), null, "a stored lift with no logs anchors nothing");

  // An assist number describes a different regime — it can never seed a loaded lift.
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Dumbbell Row", muscle_group: "back" });
  logSet("Barbell Row", isoDaysAgo(3), { weight: -30, reps: 8, rir: 2 });
  assert.equal(relatedLiftStart("Dumbbell Row"), null);
});

// ── the tiers, through the real apply path ───────────────────────────────────

test("tier 2: a rotated-in lift picks up from its OWN logged working weight", () => {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  for (let s = 1; s <= 3; s++) logSet("Incline Bench Press", isoDaysAgo(1), { weight: 95, reps: 10, rir: 2, setNum: s });

  const applied = buildAndApplySwap(1, "Bench Press", "Incline Bench Press");
  assert.equal(applied.ok, true);
  const item = itemOn(1, "Incline Bench Press");
  assert.equal(item.target_weight, 95, "the plan starts where the athlete actually left it");
  assert.doesNotMatch(String(item.note), /start light/i, "never 'start light' over a lift with real history");
  assert.match(String(item.note), /Rotated in for Bench Press/);
  assert.match(String(item.note), /95 lb/, "the note names the number it grounded on");
});

test("tier 3: with no direct history, a related lift supplies a STARTING IDEA, not a settled target", () => {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95 },
  ]);
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  for (const d of [9, 2]) logSet("Bench Press", isoDaysAgo(d), { weight: 95, reps: 10, rir: 2 });

  const applied = buildAndApplySwap(1, "Overhead Press", "Incline Bench Press");
  assert.equal(applied.ok, true);
  const item = itemOn(1, "Incline Bench Press");
  // The idea is NEVER stored. Progression grounds each step at the harder of the
  // plan target and real logged weight, so a persisted estimate would become a floor
  // the athlete could not log their way below.
  assert.equal(item.target_weight, null, "an estimate never becomes a plan target");
  assert.match(String(item.note), /Bench Press/, "the note names the lift the idea came from");
  assert.match(String(item.note), /75 lb/);
  assert.match(String(item.note), /log/i, "it is phrased as an idea to overwrite by logging");

  // …and the number still reaches the athlete, through the live prescription, where
  // the first logged set replaces it outright.
  const rx = nextPrescription("Incline Bench Press");
  assert.equal(rx.suggested.weight, 75, "0.80 of the flat bench, rounded down");
  assert.equal(rx.starting_idea, true, "flagged as an idea, not this lift's own history");
  assert.match(rx.why, /Bench Press/);
  assert.match(rx.why, /75 lb/);
  assert.ok(!rx.reground, "a guess is never a reason to rewrite the plan");
});

// The reason tier 3 is never persisted. Progression grounds every step at the
// HARDER of the plan target and real logged weight, so an estimate written into
// plan_items would be a floor no honest session could get under: an athlete who
// really inclines 135 would be measured against 145 forever, planBehind would stay
// false, and even a deload would work off the guess.
test("an overshooting starting idea can never floor the athlete's real logged weight", () => {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  for (const d of [9, 2]) logSet("Bench Press", isoDaysAgo(d), { weight: 185, reps: 8, rir: 2 });

  assert.equal(buildAndApplySwap(1, "Overhead Press", "Incline Bench Press").ok, true);
  assert.equal(itemOn(1, "Incline Bench Press").target_weight, null);
  // 185 × 0.80 = 148 → 145. This athlete actually inclines 135.
  assert.equal(nextPrescription("Incline Bench Press").suggested.weight, 145);
  assert.equal(buildProgressionProposal(1).ok, false, "an idea is never proposed as a plan change");

  for (let s = 1; s <= 3; s++) logSet("Incline Bench Press", isoDaysAgo(1), { weight: 135, reps: 9, rir: 1, setNum: s });

  const rx = nextPrescription("Incline Bench Press");
  assert.ok(!rx.starting_idea, "one logged set retires the idea for good");
  assert.equal(rx.suggested.weight, 135, "reality wins outright — the guess is not a floor");
  assert.ok(rx.suggested.weight < 145);
  assert.equal(rx.reground, true, "now there is real history, the empty plan slot catches up to it");
  assert.match(rx.why, /135 lb/);

  // And what lands on the plan is the logged number, never the estimate.
  const prop = buildProgressionProposal(1);
  assert.equal(prop.ok, true);
  assert.equal(prop.proposal.parsed.changes.find((c) => c.exercise === "Incline Bench Press").target_weight, 135);
  assert.equal(repo.applyProposal(prop.proposal.id).ok, true);
  assert.equal(itemOn(1, "Incline Bench Press").target_weight, 135);
});

test("tier 4: no direct and no related history keeps the baseline cue", () => {
  repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  const applied = buildAndApplySwap(1, "Back Squat", "Front Squat");
  assert.equal(applied.ok, true);
  const item = itemOn(1, "Front Squat");
  assert.equal(item.target_weight, null, "nothing anchors it, so nothing is invented");
  assert.match(String(item.note), /start light, log your actual working value/i);
});

test("a load-limiting note stops at the baseline cue even with history to ground on", () => {
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
  ]);
  const row = repo.upsertExercise({ name: "Dumbbell Row", muscle_group: "back" });
  repo.updateExercise(row.id, { constraint_note: "left elbow — keep light, no heavy pulls" });
  for (const d of [7, 2]) logSet("Dumbbell Row", isoDaysAgo(d), { weight: 60, reps: 10, rir: 2 });

  assert.equal(buildAndApplySwap(1, "Barbell Row", "Dumbbell Row").ok, true);
  const item = itemOn(1, "Dumbbell Row");
  assert.equal(item.target_weight, null, "the constraint note is the authority, not the history");
  assert.match(String(item.note), /start light/i);
});

test("an explicitly proposed target still wins over the grounding tiers", () => {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  for (const d of [9, 2]) logSet("Incline Bench Press", isoDaysAgo(d), { weight: 95, reps: 10, rir: 2 });

  const proposal = repo.createProposal("stub", "rotate", "", {
    summary: "rotate with an explicit target",
    changes: [{ day_number: 1, swap: { from: "Bench Press", to: "Incline Bench Press" }, target_weight: 90 }],
  });
  assert.equal(repo.applyProposal(proposal.id).ok, true);
  assert.equal(itemOn(1, "Incline Bench Press").target_weight, 90);
});

test("a timed rotation grounds on its OWN logged holds, never the outgoing movement's duration", () => {
  repo.savePlanDay(1, "Core", "Core", [
    { exercise: "Plank", sets: 3, target_seconds: 60, mode: "timed" },
  ]);
  repo.upsertExercise({ name: "Dead Hang", mode: "timed" });
  for (const d of [6, 1]) logSet("Dead Hang", isoDaysAgo(d), { duration_sec: 45 });

  assert.equal(buildAndApplySwap(1, "Plank", "Dead Hang").ok, true);
  const item = itemOn(1, "Dead Hang");
  assert.equal(item.target_seconds, 45, "its own hardest recent hold, not the plank's 60s");
  assert.equal(item.target_weight, null, "timed work never carries load");
  assert.match(String(item.note), /45s/);
});

test("applySwapSmart's one-tap rotate lands the grounded target too", () => {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
  ]);
  repo.upsertExercise({ name: "Incline Bench Press", muscle_group: "chest" });
  for (const d of [8, 1]) logSet("Incline Bench Press", isoDaysAgo(d), { weight: 80, reps: 10, rir: 2 });

  const result = applySwapSmart("Bench Press", "Incline Bench Press");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "swapped");
  assert.equal(itemOn(1, "Incline Bench Press").target_weight, 80);
});

// The APPEND path — nothing on the plan trains the outgoing movement, so the
// variation lands on the day that already works that muscle group. Arriving that
// way rather than by a swap is not evidence the athlete has never done it.
test("the added-not-swapped path grounds on the movement's own history too", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads" });
  repo.upsertExercise({ name: "Leg Extension", muscle_group: "quads" });
  repo.upsertExercise({ name: "Front Squat", muscle_group: "quads" });
  repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Leg Extension", sets: 3, rep_low: 10, rep_high: 12, target_weight: 110 },
  ]);
  for (const d of [9, 2]) logSet("Front Squat", isoDaysAgo(d), { weight: 155, reps: 5, rir: 2 });

  // "Hack Squat" is nowhere on the plan → the graceful append, not a swap.
  const result = applySwapSmart("Hack Squat", "Front Squat");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "added");
  const item = itemOn(1, "Front Squat");
  assert.equal(item.target_weight, 155, "the append path grounds on real history, same as a swap");
  assert.match(String(item.note), /Added as a fresh variation for Hack Squat/);
  assert.doesNotMatch(String(item.note), /start light/i);
  assert.match(String(item.note), /155 lb/);
});

test("the added-not-swapped path takes a related-lift idea, and keeps the cue without one", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads" });
  repo.upsertExercise({ name: "Front Squat", muscle_group: "quads" });
  repo.savePlanDay(1, "Legs", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  for (const d of [10, 3]) logSet("Back Squat", isoDaysAgo(d), { weight: 200, reps: 5, rir: 2 });

  assert.equal(applySwapSmart("Hack Squat", "Front Squat").mode, "added");
  const front = itemOn(1, "Front Squat");
  assert.equal(front.target_weight, null, "the append path stores no estimate either");
  assert.match(String(front.note), /Back Squat/, "the note names where the idea came from");
  const rx = nextPrescription("Front Squat");
  assert.equal(rx.suggested.weight, 150, "0.75 of the back squat, rounded down, live only");
  assert.equal(rx.starting_idea, true);

  // A movement with neither direct nor related history keeps the baseline cue.
  repo.upsertExercise({ name: "Leg Extension", muscle_group: "quads" });
  assert.equal(applySwapSmart("Sissy Squat", "Leg Extension").mode, "added");
  const ext = itemOn(1, "Leg Extension");
  assert.equal(ext.target_weight, null);
  assert.match(String(ext.note), /start light, log your actual working value/i);
});

test("a timed movement added to a day starts at its own logged hold, not the 30s default", () => {
  repo.upsertExercise({ name: "Plank", mode: "timed", muscle_group: "core" });
  repo.upsertExercise({ name: "Dead Hang", mode: "timed", muscle_group: "core" });
  repo.savePlanDay(1, "Core", "Core", [{ exercise: "Plank", sets: 3, target_seconds: 60, mode: "timed" }]);
  for (const d of [7, 2]) logSet("Dead Hang", isoDaysAgo(d), { duration_sec: 50 });

  assert.equal(applySwapSmart("Hollow Hold", "Dead Hang").mode, "added");
  const item = itemOn(1, "Dead Hang");
  assert.equal(item.target_seconds, 50, "its own hardest recent hold beats the conservative default");
  assert.equal(item.target_weight, null);

  // A timed slot with no history still lands with the default duration prescribed —
  // so the note must not tell the athlete to start light and log their own value
  // while a 30s hold sits right beside it.
  repo.upsertExercise({ name: "Side Plank", mode: "timed", muscle_group: "core" });
  assert.equal(applySwapSmart("Bird Dog", "Side Plank").mode, "added");
  const fresh = itemOn(1, "Side Plank");
  assert.equal(fresh.target_seconds, 30, "the conservative default is still prescribed");
  assert.doesNotMatch(String(fresh.note), /start light/i, "the cue must agree with the prescribed hold");
  assert.match(String(fresh.note), /Added as a fresh variation for Bird Dog\./);
});
