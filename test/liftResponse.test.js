// Selection by response (src/repo/lift-response.ts + the plateau branch of
// src/repo/progression.ts). A stalled lift is answered with the right tool, not just
// "less weight":
//   - an ISOLATION lift grinding at a load whose next step is coarse for it moves up a
//     rep range at the held weight (escalated:"rep_range"), once;
//   - a barbell compound grinding keeps the deload; so does an isolation lift whose
//     next step is fine-grained;
//   - a progressing, fresh or untested lift is never rotated out;
//   - the rep-range move is written as a training_target change, re-stamps the slot,
//     and holds until trained — it never re-fires and never loops.
// Deterministic, offline, temp DB (test/run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { buildProgressionProposal, nextPrescription } from "../dist/repo/progression.js";
import {
  bouncedOffLoadStep,
  coarseLoadStep,
  isIsolationLift,
  isStackLoaded,
  lastAppliedRepRangeMove,
  movedRepRange,
  REP_RANGE_CEILING,
} from "../dist/repo/lift-response.js";
import * as voice from "../dist/repo/progression-voice.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { buildProgressionWithAutonomy, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { localDateISO } from "../dist/repo/shared.js";

function isoDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}

function makeExercise(name, muscle_group) {
  repo.upsertExercise({ name, muscle_group, mode: "reps" });
  return repo.findExercise(name);
}

// One plan day holding one item, authored long ago (an established prescription).
function planWith(item, prescribedDaysAgo = 90) {
  const day = repo.savePlanDay(1, "Day", "Day", [item]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(
    isoDaysAgo(prescribedDaysAgo),
    day.id
  );
  return day;
}

function logSets(name, date, { weight, reps, rir = null, sets = 3 }) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  for (let s = 1; s <= sets; s++)
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.id, ex.id, s, weight, reps, rir);
}

function seedAppliedRepRange(exercise, daysAgo, rep_low, rep_high, weight) {
  db.prepare(
    `INSERT INTO plan_proposals (created_at, agent, instruction, raw_output, parsed_json, status)
     VALUES (?, 'auto-progression', 'day 1 progression', '', ?, 'applied')`
  ).run(
    `${isoDaysAgo(daysAgo)} 12:00:00`,
    JSON.stringify({
      summary: "Auto-progression",
      changes: [
        { day_number: 1, exercise, rep_low, rep_high, target_weight: weight, progression_escalation: "rep_range" },
      ],
    })
  );
}

// The live rope pushdown: 57.5 lb for 12–15, eight sessions over five weeks, every set at
// 14 reps with one or none left. The next pin (62.5) is a jump of nearly a tenth.
const GRIND_DAYS = [38, 33, 28, 23, 17, 12, 7, 2];
function seedPushdownGrind(name = "Rope Pushdown", weight = 57.5, group = "triceps") {
  makeExercise(name, group);
  planWith({ exercise: name, sets: 3, rep_low: 12, rep_high: 15, target_weight: weight });
  GRIND_DAYS.forEach((d, i) => logSets(name, isoDaysAgo(d), { weight, reps: 14, rir: i % 2 ? 0 : 1 }));
}

// ---------------------------------------------------------------------------
// the pure predicate
// ---------------------------------------------------------------------------

test("coarseLoadStep: an isolation stack whose next step is a large fraction of the load", () => {
  assert.equal(coarseLoadStep("Cable Lateral Raise", 15, "shoulders"), true, "15 → 20 on a lateral raise");
  assert.equal(coarseLoadStep("Rope Pushdown", 57.5, "triceps"), true, "a stack's next pin is 5 lb away");
  assert.equal(coarseLoadStep("Rope Pushdown", 70, "triceps"), false, "5 of 70 is under the line");
  assert.equal(coarseLoadStep("Cable Curl", 60, "biceps"), true);
  assert.equal(coarseLoadStep("Seated Leg Curl", 50, "hamstrings"), true, "a leg curl is single-joint on a stack");
  assert.equal(coarseLoadStep("Leg Extension", 60, "quads"), true);
  assert.equal(coarseLoadStep("Pec Deck", 60, "chest"), true);
  assert.equal(coarseLoadStep("EZ Bar Curl", 60, "biceps"), false, "a bar keeps the engine's 2.5 step");
  assert.equal(coarseLoadStep("Dumbbell Curl", 40, "biceps"), false, "dumbbells keep the engine step");
  assert.equal(coarseLoadStep("Dumbbell Curl", 25, "biceps"), true, "…which is coarse on a light pair");
  assert.equal(coarseLoadStep("Barbell Bench Press", 95, "chest"), false, "a compound is never on this ladder");
  assert.equal(coarseLoadStep("Back Squat", 45, "quads"), false, "a light compound is still a compound");
  assert.equal(coarseLoadStep("Assisted Dip", -30, "triceps"), false, "assist is not a stack to jump");
  assert.equal(coarseLoadStep("Rope Pushdown", null, "triceps"), false, "bodyweight has no step");
  assert.equal(coarseLoadStep("Rope Pushdown", 0, "triceps"), false);
  assert.equal(isIsolationLift("Cable Lateral Raise", "shoulders"), true, "the pattern covers a shared group");
  assert.equal(isIsolationLift("Overhead Press", "shoulders"), false);
  assert.equal(isIsolationLift("Back Extension", "hamstrings"), false, "a back extension is a hinge");
  assert.equal(isStackLoaded("Rope Pushdown"), true);
  assert.equal(isStackLoaded("Machine Lateral Raise"), true);
  assert.equal(isStackLoaded("Dumbbell Lateral Raise"), false);
  assert.equal(isStackLoaded("Barbell Curl"), false);
  assert.equal(isStackLoaded("Smith Machine Calf Raise"), false, "a smith machine is plate-loaded");
});

test("movedRepRange lifts both ends by three and stops at the ceiling", () => {
  assert.deepEqual(movedRepRange(12, 15), { rep_low: 15, rep_high: 18 });
  assert.equal(movedRepRange(20, REP_RANGE_CEILING - 2), null, "never past the ceiling");
  assert.equal(movedRepRange(15, 12), null, "an inverted range is not moved");
});

// ---------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------

test("an isolation grind on a coarse stack moves up a rep range at the held weight", () => {
  seedPushdownGrind();
  const p = nextPrescription("Rope Pushdown");
  assert.equal(p.escalated, "rep_range");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 57.5, "the weight is unchanged");
  assert.equal(p.suggested.rep_low, 15);
  assert.equal(p.suggested.rep_high, 18);
  assert.ok(!p.vary_to && !p.vary_options, "no rotation rides along");
  assert.ok(voice.ISOLATION_REP_RANGE.includes(p.why), `the rep-range sentence: ${p.why}`);
  assert.equal(violatesReadingGrammar(p.why), null);
  assert.doesNotMatch(p.why, /\d/, "no numbers in the sentence");
});

test("the rep-range voice is plain: one sentence, no numbers, grammar-clean", () => {
  for (const line of [...voice.ISOLATION_REP_RANGE, ...voice.ISOLATION_REP_RANGE_EARNED]) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\d/, line);
    assert.equal(line.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, `one sentence: ${line}`);
  }
  assert.ok(voice.progressionVoicePhrases().includes(voice.ISOLATION_REP_RANGE[0]), "registered in the vocabulary");
  assert.ok(voice.progressionVoicePhrases().includes(voice.ISOLATION_REP_RANGE_EARNED[0]));
});

test("a barbell compound grinding keeps the deload", () => {
  makeExercise("Barbell Overhead Press", "shoulders");
  planWith({ exercise: "Barbell Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 100 });
  for (const d of [28, 21]) logSets("Barbell Overhead Press", isoDaysAgo(d), { weight: 100, reps: 8, rir: 1 });
  for (const d of [10, 1]) logSets("Barbell Overhead Press", isoDaysAgo(d), { weight: 100, reps: 8, rir: 0 });
  const p = nextPrescription("Barbell Overhead Press");
  assert.equal(p.action, "deload");
  assert.ok(p.suggested.weight < 100);
  assert.equal(p.escalated, undefined);
  assert.equal(p.suggested.rep_low, 8, "the range is untouched");
});

test("an isolation grind whose next step is fine-grained keeps the deload", () => {
  seedPushdownGrind("EZ Bar Curl", 60, "biceps");
  const p = nextPrescription("EZ Bar Curl");
  assert.equal(p.action, "deload", "60 → 62.5 on a bar is not a coarse jump");
  assert.equal(p.escalated, undefined);
});

test("a grind well below the new floor is not moved up — the reps are not there yet", () => {
  makeExercise("Rope Pushdown", "triceps");
  planWith({ exercise: "Rope Pushdown", sets: 3, rep_low: 12, rep_high: 15, target_weight: 57.5 });
  GRIND_DAYS.forEach((d) => logSets("Rope Pushdown", isoDaysAgo(d), { weight: 57.5, reps: 12, rir: 1 }));
  const p = nextPrescription("Rope Pushdown");
  assert.notEqual(p.escalated, "rep_range");
  assert.equal(p.action, "deload");
});

test("an assisted isolation lift is never moved up a rep range", () => {
  makeExercise("Assisted Dip", "triceps");
  planWith({ exercise: "Assisted Dip", sets: 3, rep_low: 12, rep_high: 15, target_weight: -30 });
  GRIND_DAYS.forEach((d) => logSets("Assisted Dip", isoDaysAgo(d), { weight: -30, reps: 14, rir: 1 }));
  const p = nextPrescription("Assisted Dip");
  assert.notEqual(p.escalated, "rep_range");
});

// ---------------------------------------------------------------------------
// progressing / fresh / untested lifts are never rotated
// ---------------------------------------------------------------------------

test("a progressing isolation lift on a fine step gets its overload, not a rotation or a range move", () => {
  makeExercise("Dumbbell Curl", "biceps");
  planWith({ exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 40 });
  logSets("Dumbbell Curl", isoDaysAgo(24), { weight: 35, reps: 12 });
  logSets("Dumbbell Curl", isoDaysAgo(17), { weight: 40, reps: 10 });
  logSets("Dumbbell Curl", isoDaysAgo(10), { weight: 40, reps: 11 });
  logSets("Dumbbell Curl", isoDaysAgo(3), { weight: 40, reps: 12 });
  const p = nextPrescription("Dumbbell Curl");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.weight, 42.5);
  assert.equal(p.escalated, undefined);
  assert.ok(!p.vary_to);
});

function seedLongFlat(prescribedDaysAgo) {
  makeExercise("Leg Press", "quads");
  planWith({ exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400 }, prescribedDaysAgo);
  for (const d of [35, 28, 21, 14, 7, 2])
    logSets("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2, sets: 1 });
}

test("a settled vary carries one plain sentence and one lead option; the menu stays in vary_options", () => {
  seedLongFlat(90);
  const p = nextPrescription("Leg Press");
  assert.equal(p.action, "vary");
  assert.ok(p.vary_to, "a lead option");
  assert.equal(p.vary_to, p.vary_options[0].name, "the lead is the menu's first");
  assert.ok(
    p.vary_options.every((o) => Object.keys(o).sort().join() === "name,why"),
    "no score on the menu"
  );
  assert.equal(p.why.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, `one sentence: ${p.why}`);
  assert.equal(violatesReadingGrammar(p.why), null);
  const many = p.vary_options.slice(1).filter((o) => p.why.includes(o.name));
  assert.equal(many.length, 0, "the sentence names only the lead");
});

test("the forced-variation escalation reads as one sentence in every phrasing", () => {
  for (const fn of voice.ESCALATE_VARIATION) {
    const line = fn("Front Squat");
    assert.equal(line.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length, 1, line);
  }
});

test("a fresh prescription is never rotated out", () => {
  seedLongFlat(5);
  const p = nextPrescription("Leg Press");
  assert.ok(!["vary", "introduce"].includes(p.action), `got ${p.action}`);
  assert.ok(!p.vary_to);
});

test("an untested prescription is never rotated out", () => {
  seedLongFlat(90);
  // Re-written after the last session: nothing has been trained at it yet.
  db.prepare(`UPDATE plan_items SET target_weight = 410, prescribed_at = ?`).run(isoDaysAgo(1));
  const p = nextPrescription("Leg Press");
  assert.equal(p.action, "hold");
  assert.ok(!p.vary_to && !p.vary_options);
});

// ---------------------------------------------------------------------------
// the proposal, the stamp, and no loop
// ---------------------------------------------------------------------------

test("the proposal writes the range move as a marked target change", () => {
  seedPushdownGrind();
  const out = buildProgressionProposal(1);
  assert.equal(out.ok, true);
  const change = out.proposal.parsed.changes.find((c) => c.exercise === "Rope Pushdown");
  assert.ok(change, "the move is a real change");
  assert.equal(change.swap, undefined, "not a rotation");
  assert.equal(change.rep_low, 15);
  assert.equal(change.rep_high, 18);
  assert.equal(change.target_weight, 57.5, "the load is held");
  assert.equal(change.progression_escalation, "rep_range");
  assert.equal(change.progression_action, undefined, "not a deload in the audit trail");
});

test("lead mode: the range move quiet-applies as a training_target, re-stamps the slot, and holds until trained", () => {
  seedPushdownGrind();
  repo.setSettings({ lead_mode: "lead" });
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true);
  assert.equal(out.autonomy.tier, "quiet_apply");
  assert.equal(out.autonomy.decision.kind, "training_target");
  const item = repo.getPlanDay(1).items[0];
  assert.equal(item.rep_low, 15);
  assert.equal(item.rep_high, 18);
  assert.equal(item.target_weight, 57.5);
  const stamp = db.prepare(`SELECT prescribed_at FROM plan_items`).get().prescribed_at;
  assert.equal(String(stamp).slice(0, 10), localDateISO(), "the normal writer re-stamped the slot");
  assert.ok(lastAppliedRepRangeMove("Rope Pushdown"), "the ledger carries the move");

  const next = nextPrescription("Rope Pushdown");
  assert.equal(next.action, "hold", "an untested range stands as written");
  assert.equal(next.escalated, undefined, "it does not re-fire");
  assert.equal(next.suggested.rep_low, 15);
  assert.equal(next.suggested.weight, 57.5);
});

test("an Undo of the range move sticks: the next boundary never re-proposes it", () => {
  seedPushdownGrind();
  repo.setSettings({ lead_mode: "lead" });
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.autonomy.tier, "quiet_apply");
  assert.equal(repo.getPlanDay(1).items[0].rep_low, 15);
  const undone = revertDecision(out.autonomy.decision.id);
  assert.equal(undone.ok, true, undone.error);
  const item = repo.getPlanDay(1).items[0];
  assert.equal(item.rep_low, 12, "Undo restored the range");
  assert.equal(item.rep_high, 15);

  // The next boundary: the athlete's "no" is the move's answer; it never comes back.
  const next = nextPrescription("Rope Pushdown");
  assert.notEqual(next.escalated, "rep_range", "no re-proposal of the vetoed move");
  const again = buildProgressionWithAutonomy(1);
  const change = again.ok ? again.proposal?.parsed?.changes?.find((c) => c.exercise === "Rope Pushdown") : null;
  assert.notEqual(change?.progression_escalation, "rep_range", "no second range move is drafted");
  const after = repo.getPlanDay(1).items[0];
  assert.equal(after.rep_low, 12, "nothing re-applied the range");
  assert.ok(lastAppliedRepRangeMove("Rope Pushdown")?.vetoed, "the ledger reads the move as vetoed");
});

test("a range moved today off today's session does not re-fire or fall to a deload", () => {
  makeExercise("Rope Pushdown", "triceps");
  planWith({ exercise: "Rope Pushdown", sets: 3, rep_low: 12, rep_high: 15, target_weight: 57.5 });
  [35, 30, 25, 20, 14, 9, 4, 0].forEach((d) =>
    logSets("Rope Pushdown", isoDaysAgo(d), { weight: 57.5, reps: 14, rir: 1 })
  );
  // Applied at today's finish: a brain step stamps the bare day, so today's session reads
  // as trained under it — the fresh stamp is what keeps the plateau read quiet.
  db.prepare(`UPDATE plan_items SET rep_low = 15, rep_high = 18, prescribed_at = ?`).run(localDateISO());
  seedAppliedRepRange("Rope Pushdown", 0, 15, 18, 57.5);
  const p = nextPrescription("Rope Pushdown");
  assert.notEqual(p.action, "deload");
  assert.equal(p.escalated, undefined);
  assert.equal(p.suggested.rep_low, 15);
});

test("still grinding after a run in the higher range falls to the ordinary ladder — never a second move", () => {
  makeExercise("Rope Pushdown", "triceps");
  // The range was moved three weeks ago and has been trained since.
  planWith({ exercise: "Rope Pushdown", sets: 3, rep_low: 15, rep_high: 18, target_weight: 57.5 }, 21);
  seedAppliedRepRange("Rope Pushdown", 21, 15, 18, 57.5);
  // Flat at 57.5 × 17 with nothing in reserve: the reps would reach a second move's floor,
  // so only the ledger stands between this lift and a loop.
  GRIND_DAYS.forEach((d, i) => logSets("Rope Pushdown", isoDaysAgo(d), { weight: 57.5, reps: 17, rir: i % 2 ? 0 : 1 }));
  const p = nextPrescription("Rope Pushdown");
  assert.notEqual(p.escalated, "rep_range", "no second range move");
  assert.equal(p.action, "deload", "the existing ladder answers");
  assert.equal(p.suggested.rep_low, 15, "the moved range stays");
});

// ---------------------------------------------------------------------------
// the earned door: extended double progression (no RIR needed)
// ---------------------------------------------------------------------------

// The live cable lateral: 15 lb for 12–15, every working set capping 15, no RIR logged.
function seedCableLateralCapped({ days = [24, 17, 10, 3], rep_low = 12, rep_high = 15, reps = 15 } = {}) {
  makeExercise("Cable Lateral Raise", "shoulders");
  planWith({ exercise: "Cable Lateral Raise", sets: 3, rep_low, rep_high, target_weight: 15 });
  for (const d of days) logSets("Cable Lateral Raise", isoDaysAgo(d), { weight: 15, reps, rir: null });
}

test("live-like: a cable lateral capping 12–15 at 15 lb holds 15 and moves to 15–18 instead of jumping to 20", () => {
  seedCableLateralCapped();
  const p = nextPrescription("Cable Lateral Raise");
  assert.equal(p.escalated, "rep_range");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 15);
  assert.equal(p.suggested.rep_low, 15);
  assert.equal(p.suggested.rep_high, 18);
  assert.equal(p.delta_text, "hold, 15–18 reps");
  assert.ok(voice.ISOLATION_REP_RANGE_EARNED.includes(p.why), `the earned sentence: ${p.why}`);
  assert.doesNotMatch(p.why, /RIR|\d/, "no rating asked for, no numbers");

  const out = buildProgressionProposal(1);
  assert.equal(out.ok, true);
  const change = out.proposal.parsed.changes.find((c) => c.exercise === "Cable Lateral Raise");
  assert.equal(change.rep_low, 15);
  assert.equal(change.rep_high, 18);
  assert.equal(change.target_weight, 15);
  assert.equal(change.progression_escalation, "rep_range");
});

test("once the higher range is capped too, the ordinary load step follows — no second move", () => {
  makeExercise("Cable Lateral Raise", "shoulders");
  planWith({ exercise: "Cable Lateral Raise", sets: 3, rep_low: 15, rep_high: 18, target_weight: 15 }, 21);
  seedAppliedRepRange("Cable Lateral Raise", 21, 15, 18, 15);
  for (const d of [24, 17]) logSets("Cable Lateral Raise", isoDaysAgo(d), { weight: 15, reps: 15, rir: null });
  for (const d of [10, 3]) logSets("Cable Lateral Raise", isoDaysAgo(d), { weight: 15, reps: 18, rir: null });
  const p = nextPrescription("Cable Lateral Raise");
  assert.equal(p.action, "overload");
  assert.equal(p.escalated, undefined, "the move is spent");
  assert.equal(p.suggested.weight, 20);
});

test("an earned step on a fine-grained lift is the ordinary load step", () => {
  makeExercise("EZ Bar Curl", "biceps");
  planWith({ exercise: "EZ Bar Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 60 });
  for (const d of [17, 10, 3]) logSets("EZ Bar Curl", isoDaysAgo(d), { weight: 60, reps: 12, rir: null });
  const p = nextPrescription("EZ Bar Curl");
  assert.equal(p.action, "overload");
  assert.equal(p.escalated, undefined);
});

test("a capped top set over uncapped back-offs is not the earned door", () => {
  makeExercise("Cable Lateral Raise", "shoulders");
  planWith({ exercise: "Cable Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 15 });
  for (const d of [17, 10, 3]) {
    const ex = repo.findExercise("Cable Lateral Raise");
    const sess = repo.getOrCreateSession(isoDaysAgo(d), null);
    [15, 13, 12].forEach((reps, i) =>
      db
        .prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, ?, 15, ?)`)
        .run(sess.id, ex.id, i + 1, reps)
    );
  }
  const p = nextPrescription("Cable Lateral Raise");
  assert.notEqual(p.escalated, "rep_range");
  assert.equal(p.suggested.weight, 15);
});

test("a recovery brake wins over the earned range move", () => {
  seedCableLateralCapped({ days: [24, 17, 10, 1] });
  // Yesterday's session came back sore: an earned step holds, and so does the move.
  db.prepare(`UPDATE sessions SET soreness = 5 WHERE date = ?`).run(isoDaysAgo(1));
  const p = nextPrescription("Cable Lateral Raise");
  assert.equal(p.escalated, undefined);
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.rep_low, 12, "the plan's range stands");
  assert.equal(p.suggested.weight, 15);
});

test("push drive never turns the range move back into the coarse jump", () => {
  seedCableLateralCapped();
  repo.setSettings({ training_drive: "push" });
  const p = nextPrescription("Cable Lateral Raise");
  assert.equal(p.escalated, "rep_range");
  assert.equal(p.suggested.weight, 15);
});

test("a plan behind the log is re-grounded first, never range-moved in the same breath", () => {
  makeExercise("Cable Lateral Raise", "shoulders");
  planWith({ exercise: "Cable Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 10 });
  for (const d of [17, 10, 3]) logSets("Cable Lateral Raise", isoDaysAgo(d), { weight: 15, reps: 15, rir: null });
  const p = nextPrescription("Cable Lateral Raise");
  assert.notEqual(p.escalated, "rep_range");
});

// ---------------------------------------------------------------------------
// a bounce off the last load step prefers the range on the next earned step
// ---------------------------------------------------------------------------

function seedCurlBounce() {
  makeExercise("Dumbbell Curl", "biceps");
  planWith({ exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 40 });
  logSets("Dumbbell Curl", isoDaysAgo(35), { weight: 40, reps: 12 });
  logSets("Dumbbell Curl", isoDaysAgo(28), { weight: 42.5, reps: 8 }); // the step did not hold
  logSets("Dumbbell Curl", isoDaysAgo(21), { weight: 40, reps: 11 });
  for (const d of [14, 7, 2]) logSets("Dumbbell Curl", isoDaysAgo(d), { weight: 40, reps: 12 });
}

test("bouncedOffLoadStep reads a step taken, missed and returned from", () => {
  seedCurlBounce();
  assert.equal(bouncedOffLoadStep("Dumbbell Curl", 40, 10), true);
  assert.equal(bouncedOffLoadStep("Dumbbell Curl", 40, 8), false, "8 reps at the new load met a floor of 8");
});

test("a lift that bounced off its last step takes the range move on the next earned step", () => {
  seedCurlBounce();
  const p = nextPrescription("Dumbbell Curl");
  assert.equal(p.escalated, "rep_range", "40 → 42.5 is a fine step on paper, but the log says it did not hold");
  assert.equal(p.suggested.weight, 40);
  assert.equal(p.suggested.rep_low, 13);
  assert.equal(p.suggested.rep_high, 15);
});
