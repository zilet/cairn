// The per-session auto-progression engine (src/repo/progression.ts) — the
// deterministic "MacroFactor-for-lifting" loop. Invariants under test:
//   - nextPrescription proposes the NEXT target from the LAST logged top set +
//     the lift's program-state trend: overload (earned) / hold / deload (grind or
//     slip) / vary (long plateau)
//   - the load step is CLAMPED (≤10% or ≤5 lb compound / ≤2.5 lb isolation) — an
//     off-spec history never produces a giant jump, and never a negative number
//   - an injury constraint_note HOLDS load (never bumps it)
//   - timed lifts progress in SECONDS, never load
//   - assisted lifts (negative weight) REDUCE the assist toward bodyweight
//   - programBalance bands by the canonical taxonomy + flags DUE groups
//   - programAdjustments detects missing-pattern GAPS (no core / grip / mobility)
// Deterministic, offline, temp DB (see test/run.mjs). Imports progression.js
// directly (the barrel re-export is the LEAD's wire-up, landing at merge).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  nextPrescription,
  planDayProgression,
  buildProgressionProposal,
  programBalance,
  programAdjustments,
  recentMuscleLoad,
} from "../dist/repo/progression.js";
import { progressionVoicePhrases } from "../dist/repo/progression-voice.js";
import * as blocks from "../dist/repo/program-blocks.js";
import { detectStrengthCalibration, dueCalibrations, estimateConfidenceFor } from "../dist/repo/calibration.js";
import { normalizedExerciseKey } from "../dist/repo/exercise-canon.js";
import { trainingPlaybook } from "../dist/repo/training-playbook.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { currentUnderfuelingRead } from "../dist/repo/underfueling-snapshot.js";
import { registerProgramTools } from "../dist/surfaces/mcp/program.js";
import { localDateISO, addDaysISO } from "../dist/repo/shared.js";
import { recordDecision } from "../dist/repo/brain-decisions.js";
import { insertBrainEvaluation } from "../dist/repo/brain-evaluations.js";

// ---- local seeding (kept in-file so we don't touch the shared _seed.js) ----
function reset() {
  for (const t of ["daily_session_outcomes", "daily_session_compositions", "logged_sets", "plan_items", "plan_days", "sessions", "exercises", "bodyweight_log", "program_blocks", "activities", "garmin_activities", "plan_proposals", "food_notes", "fueling_feedback", "nutrition_targets"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}

function linkLatestDoseOutcome(name, date, {
  status = "completed",
  comparable = true,
  prescribedSets = 3,
  achievedSets = 3,
  challengeVerdict = achievedSets >= prescribedSets ? "met" : "under_prescribed",
} = {}) {
  const exercise = repo.findExercise(name);
  const session = repo.getSessionByDate(date);
  assert.ok(session, `session exists for ${name}`);
  if (status === "completed") {
    db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(session.id);
  }
  const planDay = repo.getPlan().find((day) => day.items.some((item) => item.exercise === name));
  const item = planDay.items.find((entry) => entry.exercise === name);
  const composition = db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'Dose fixture', ?, ?)`
  ).run(
    session.id,
    date,
    planDay.id,
    JSON.stringify([{ exercise: name, sets: prescribedSets, rep_low: item.rep_low, rep_high: item.rep_high, target_weight: item.target_weight }]),
    `dose-${exercise.id}-${date}`
  );
  const partial = achievedSets < prescribedSets;
  const facts = {
    schema_version: 2,
    confidence: status === "completed" ? "high" : "moderate",
    dose_context: {
      partial,
      comparable,
      non_comparable_reasons: comparable ? [] : [partial ? "partial" : "test_context"],
    },
    dose_evidence: [{
      movement_key: `exercise:${exercise.id}`,
      intent_key: `strength:reps:${item.rep_low}-${item.rep_high}`,
      exercise: name,
      prescribed: { sets: prescribedSets },
      achieved: { sets: achievedSets },
      challenge_verdict: challengeVerdict,
    }],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes
      (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(composition.lastInsertRowid, session.id, date, status, JSON.stringify(facts));
}

function makeExercise(name, { muscle_group = null, mode = "reps", constraint_note = null } = {}) {
  const ex = repo.upsertExercise({ name, muscle_group, mode });
  if (constraint_note) repo.updateExercise(ex.id, { constraint_note });
  return repo.findExercise(name);
}

// One plan day with a single strength item carrying its prescribed targets.
function planWith(dayNumber, item) {
  return repo.savePlanDay(dayNumber, item.focus || `Day ${dayNumber}`, item.focus || null, [item]);
}

// Log a top set for an exercise on a given ISO date (UTC). reps/weight for reps
// lifts; duration_sec for timed; rir optional.
function logSet(name, date, { weight = null, reps = null, rir = null, duration_sec = null, setNum = 1, note = null } = {}) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sess.id, ex.id, setNum, weight, reps, rir, duration_sec, note);
}

function isoDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}

async function callProgramTool(name, args = {}) {
  const tools = new Map();
  registerProgramTools({
    tool(toolName, _description, _schema, handler) {
      tools.set(toolName, handler);
    },
  });
  const handler = tools.get(name);
  assert.ok(handler, `MCP tool registered: ${name}`);
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

beforeEach(reset);

// ---------------------------------------------------------------------------
test("earned overload: hit the top of the range at RIR 2 → a clamped step up", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185, focus: "Push" });
  // A few progressing sessions, last one at the top of the range, RIR 2.
  logSet("Barbell Bench Press", isoDaysAgo(28), { weight: 175, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", isoDaysAgo(21), { weight: 180, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", isoDaysAgo(10), { weight: 185, reps: 8, rir: 2 });

  const p = nextPrescription("Barbell Bench Press");
  assert.ok(p, "a prescription is returned");
  assert.equal(p.action, "overload");
  assert.equal(p.mode, "reps");
  // A compound: the step is clamped to ≤5 lb (so 185 → 190, not a leap).
  assert.equal(p.suggested.weight, 190);
  assert.equal(p.delta_text, "+5 lb");
  assert.ok(p.suggested.weight > 0, "never a negative weight");
});

// ---- DOUBLE PROGRESSION (reps within range first, load only at the top of all sets) ----
test("double progression: ALL prescribed sets at the top → LOAD bump + reps reset to bottom", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 185, focus: "Push" });
  // A prior session mid-range, then a session where EVERY working set capped the range (12s)
  // at RIR 2 — the earned LOAD step in double progression.
  logSet("Barbell Bench Press", isoDaysAgo(10), { weight: 185, reps: 10, rir: 2, setNum: 1 });
  for (let s = 1; s <= 3; s++) logSet("Barbell Bench Press", isoDaysAgo(3), { weight: 185, reps: 12, rir: 2, setNum: s });

  const p = nextPrescription("Barbell Bench Press");
  assert.equal(p.action, "overload");
  assert.ok(!p.rep_step, "capping every set earns the LOAD step, not another rep step");
  assert.equal(p.suggested.weight, 190, "a clamped +5 lb compound step up");
  assert.equal(p.delta_text, "+5 lb");
  // Reset reps to the BOTTOM of the range at the new load (the range itself is unchanged).
  assert.equal(p.suggested.rep_low, 8);
  assert.equal(p.suggested.rep_high, 12);
  assert.match(p.why, /reset to 8 reps/i, "the why calls out the reset to the bottom of the range");
});

test("double progression: a MID-RANGE lift earns a REP, not load (no plan change)", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 185, focus: "Push" });
  // Every working set was strong (RIR 2) but mid-range (9 reps, below the 12 ceiling) — the
  // earned step is a REP within the range, the load is HELD, and it's not a plan change.
  for (let s = 1; s <= 3; s++) logSet("Barbell Bench Press", isoDaysAgo(3), { weight: 185, reps: 9, rir: 2, setNum: s });

  const p = nextPrescription("Barbell Bench Press");
  assert.equal(p.action, "overload");
  assert.equal(p.rep_step, true, "a mid-range earned step is a rep advance");
  assert.equal(p.suggested.weight, 185, "the load is held while reps climb in the range");
  assert.equal(p.delta_text, "+1 rep");

  // A rep advance is NOT a plan change — the plan already prescribes the range, so it
  // never lands as a target edit in the one-tap apply proposal.
  const prop = buildProgressionProposal(1);
  assert.equal(prop.ok, false, "a rep-only advance produces nothing to apply — the range already covers it");
});

test("double progression: top set caps but a WORKING set falls short → hold and level the sets", () => {
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  planWith(1, { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95, focus: "Push" });
  // The top set hit 8 but the other working sets dropped to 6 — not every set capped, so
  // the load holds (no rep step: the top set has no room; no load: the sets aren't level).
  logSet("Overhead Press", isoDaysAgo(3), { weight: 95, reps: 8, rir: 2, setNum: 1 });
  logSet("Overhead Press", isoDaysAgo(3), { weight: 95, reps: 6, rir: 1, setNum: 2 });
  logSet("Overhead Press", isoDaysAgo(3), { weight: 95, reps: 6, rir: 1, setNum: 3 });

  const p = nextPrescription("Overhead Press");
  assert.equal(p.action, "hold");
  assert.ok(!p.rep_step);
  assert.equal(p.suggested.weight, 95, "load held until every set caps the range");
  assert.match(p.why, /not every set/i);
});

test("overload step is CLAMPED — a giant history never yields a giant jump", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 300, focus: "Legs" });
  // Top set blew past the range at RIR 3 — the engine still caps the step.
  logSet("Back Squat", isoDaysAgo(21), { weight: 285, reps: 5, rir: 3 });
  logSet("Back Squat", isoDaysAgo(7), { weight: 300, reps: 8, rir: 3 });

  const p = nextPrescription("Back Squat");
  assert.equal(p.action, "overload");
  // 10% of 300 = 30, but the proportional compound ceiling caps it at 7.5 lb.
  assert.equal(p.suggested.weight, 307.5);
  assert.ok(p.suggested.weight - 300 <= 7.5, "step never exceeds the proportional compound cap");
});

// The cap used to be a flat 5 lb for every compound, so a 300 lb squat and a 100 lb
// press earned the identical increment — a rounding error on one, a real week's work
// on the other. It scales with what is actually on the bar, and the light lift keeps
// exactly the step it always had.
test("the compound step SCALES with the load — heavy lifts earn more than light ones", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 300, focus: "Legs" });
  planWith(2, { exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 100, focus: "Push" });
  for (const setNum of [1, 2, 3]) {
    logSet("Back Squat", isoDaysAgo(5), { weight: 300, reps: 5, rir: 2, setNum });
    logSet("Overhead Press", isoDaysAgo(5), { weight: 100, reps: 5, rir: 2, setNum });
  }

  const squat = nextPrescription("Back Squat");
  const press = nextPrescription("Overhead Press");
  assert.equal(squat.action, "overload");
  assert.equal(press.action, "overload");
  const squatStep = squat.suggested.weight - 300;
  const pressStep = press.suggested.weight - 100;
  assert.ok(squatStep > pressStep, `the heavy compound steps up more (${squatStep} vs ${pressStep})`);
  assert.equal(pressStep, 5, "a 100 lb press keeps the familiar 5 lb jump");
  assert.equal(squatStep, 7.5, "a 300 lb squat earns a proportional 7.5 lb jump, on the plate grid");
});

test("isolation lifts get the smaller 2.5 lb plate jump", () => {
  makeExercise("Dumbbell Curl", { muscle_group: "biceps" });
  planWith(1, { exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30, focus: "Arms" });
  logSet("Dumbbell Curl", isoDaysAgo(14), { weight: 27.5, reps: 12, rir: 2 });
  logSet("Dumbbell Curl", isoDaysAgo(4), { weight: 30, reps: 12, rir: 2 });

  const p = nextPrescription("Dumbbell Curl");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.weight, 32.5, "isolation step is 2.5 lb, not 5");
});

test("hold: reps not at the top / RIR low → hold the load, no bump", () => {
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  planWith(1, { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95, focus: "Push" });
  // Last set short of the top at RIR 1 — not earned.
  logSet("Overhead Press", isoDaysAgo(10), { weight: 95, reps: 6, rir: 1 });

  const p = nextPrescription("Overhead Press");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 95, "load held, not increased");
  assert.match(p.delta_text, /^hold/);
});

// SEAM: calibration.ts's estimateConfidenceFor (src/repo/calibration.ts) is the
// evidence gate the strength-core track built against while it was still a stub
// that answered "verified" for everything. Live, a regressing est-1RM nothing
// heavy has confirmed reads as an unconfirmed FORMULA, not a confirmed slip — the
// prescription HOLDS and asks for a test instead of cutting the load.
test("deload gated on estimate confidence: unverified holds with a test story, verified deloads", () => {
  makeExercise("Deadlift", { muscle_group: "hamstrings" });
  planWith(1, { exercise: "Deadlift", sets: 1, rep_low: 5, rep_high: 5, target_weight: 365, focus: "Pull" });
  // Est-1RM clearly sliding over several sessions → program-state reads regressing.
  // No set here is a genuinely heavy single/AMRAP near the running estimate, so
  // nothing has ever VERIFIED it — the ladder's honest "unverified" case.
  logSet("Deadlift", isoDaysAgo(28), { weight: 365, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(21), { weight: 355, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(14), { weight: 345, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(5), { weight: 335, reps: 5, rir: 1 });

  assert.equal(estimateConfidenceFor("Deadlift"), "unverified");
  const unverified = nextPrescription("Deadlift");
  assert.equal(unverified.action, "hold", "an unconfirmed formula holds rather than deloads");
  assert.equal(unverified.suggested.weight, 365, "load stays where it is while the estimate is untested");
  assert.match(unverified.why, /heavy set|confirm/i, "the why tells the settle-it-with-a-test story");
  assert.equal(violatesReadingGrammar(unverified.why), null);

  // Mark the FIRST day's set AMRAP — a genuine test of that day's ceiling. It
  // verifies on its own (no prior estimate needed to compare against), anchoring
  // the estimate recently enough to read as "verified" without touching the
  // weights the decline trend is graded on.
  db.prepare(
    `UPDATE logged_sets SET note = 'AMRAP' WHERE id = (
       SELECT ls.id FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE s.date = ? ORDER BY ls.id ASC LIMIT 1
     )`
  ).run(isoDaysAgo(28));

  assert.equal(estimateConfidenceFor("Deadlift"), "verified");
  const verified = nextPrescription("Deadlift");
  assert.equal(verified.action, "deload", "a confirmed estimate returns to the ordinary deload path");
  assert.ok(verified.suggested.weight < 365 && verified.suggested.weight > 0, "load backed off, never negative");
  assert.match(verified.delta_text, /^−/, "delta reads as a decrease");
});

test("vary: a long flat plateau (not grinding) suggests rotating a variation", () => {
  makeExercise("Leg Press", { muscle_group: "quads" });
  planWith(1, { exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400, focus: "Legs" });
  // Same top load for many sessions across >3 weeks, RIR 2 (not grinding) → flat-long.
  for (const d of [35, 28, 21, 14, 7, 2]) logSet("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2 });

  const p = nextPrescription("Leg Press");
  assert.equal(p.action, "vary");
  assert.equal(p.suggested.weight, 400, "load held while a variation is suggested");
});

test("injury constraint HOLDS load even when reps were earned", () => {
  makeExercise("Barbell Row", { muscle_group: "back", constraint_note: "left elbow — keep light, no heavy pulls" });
  planWith(1, { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135, focus: "Pull" });
  // Reps fully earned at RIR 2 — but the injury note must override the overload.
  logSet("Barbell Row", isoDaysAgo(14), { weight: 135, reps: 10, rir: 2 });
  logSet("Barbell Row", isoDaysAgo(4), { weight: 135, reps: 10, rir: 2 });

  const p = nextPrescription("Barbell Row");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 135, "constraint holds the load, never bumps it");
  assert.match(p.why.toLowerCase(), /load-limiting|hold the (weight|load)/);
});

test("a GRIP/form constraint progresses load — it is NOT a load cap", () => {
  // Cubital tunnel = a grip cue (neutral grip), not a load limit. The athlete manages it
  // technically and still EARNS load — it must never freeze the lift at a stale weight
  // (the exact bug: logging 45-50 lb every week, still prescribed "hold 27").
  makeExercise("Hammer Curl", { muscle_group: "biceps", constraint_note: "Cubital tunnel: neutral grip only, no supinated curls." });
  planWith(1, { exercise: "Hammer Curl", sets: 3, rep_low: 12, rep_high: 12, target_weight: 27, focus: "Pull" });
  logSet("Hammer Curl", isoDaysAgo(18), { weight: 45, reps: 12, rir: 2 });
  logSet("Hammer Curl", isoDaysAgo(8), { weight: 50, reps: 12, rir: 2 });
  const p = nextPrescription("Hammer Curl");
  assert.equal(p.action, "overload", "a grip cue must not hold load when the lift is earned");
  assert.ok((p.suggested.weight ?? 0) >= 50, "the step is grounded in the real working weight (~50), not the stale plan 27");
});

test("progression GROUNDS in logged reality — a stale plan target never strands a lift", () => {
  makeExercise("Dumbbell Curl", { muscle_group: "biceps" });
  planWith(1, { exercise: "Dumbbell Curl", sets: 3, rep_low: 12, rep_high: 12, target_weight: 27, focus: "Pull" });
  // Logged heavy for weeks — the plan target (27) is far behind reality (45-50).
  logSet("Dumbbell Curl", isoDaysAgo(16), { weight: 45, reps: 12, rir: 1 });
  logSet("Dumbbell Curl", isoDaysAgo(7), { weight: 50, reps: 12, rir: 2 });
  const p = nextPrescription("Dumbbell Curl");
  assert.equal(p.reground, true, "the plan was behind logged reality → re-ground flag set");
  assert.ok((p.current?.weight ?? 0) >= 45, "the displayed current reflects reality, not the stale 27");
  assert.ok((p.suggested.weight ?? 0) >= 50, "the next step builds from ~50, never crawls up from 27");
});

// A NULL plan target used to be excluded from the "behind reality" read entirely
// (`planWeight != null`), so the whole re-grounding path was unreachable for
// exactly the lifts that need it most: a movement rotated in with no target, then
// loaded for real, stayed NULL forever while the catch-up prose sat dead.
test("a plan slot with NO target and real logged history re-grounds onto reality", () => {
  makeExercise("Incline Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, focus: "Push" });
  // Real work at 95, but grinding (RIR 1) — so it is a HOLD, and the hold still
  // has to catch the plan up to the number the athlete is actually handling.
  for (const d of [8, 2])
    for (let s = 1; s <= 3; s++) logSet("Incline Bench Press", isoDaysAgo(d), { weight: 95, reps: 9, rir: 1, setNum: s });

  const p = nextPrescription("Incline Bench Press");
  assert.equal(p.action, "hold");
  assert.equal(p.reground, true, "an empty plan target with real history reads as behind");
  assert.equal(p.suggested.weight, 95, "the suggestion is the real working weight");
  assert.match(p.why, /95 lb/, "the why reports the real number");
  assert.doesNotMatch(p.why, /plan was behind/i, "an empty slot is a different fact from a lighter one");

  // …and the catch-up actually LANDS: a re-grounding hold is a real change, so it
  // flows through the ordinary propose→apply path instead of dying as prose.
  const prop = buildProgressionProposal(1);
  assert.equal(prop.ok, true, "the re-grounding hold is proposed, not dropped as 'no change'");
  const change = prop.proposal.parsed.changes.find((c) => c.exercise === "Incline Bench Press");
  assert.ok(change, "the re-ground lands as a target change");
  assert.equal(change.target_weight, 95);
  assert.equal(repo.applyProposal(prop.proposal.id).ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 95, "the plan target caught up");
});

test("a plan target that already matches reality proposes nothing", () => {
  makeExercise("Incline Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Incline Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95, focus: "Push" });
  for (const d of [8, 2])
    for (let s = 1; s <= 3; s++) logSet("Incline Bench Press", isoDaysAgo(d), { weight: 95, reps: 9, rir: 1, setNum: s });

  const p = nextPrescription("Incline Bench Press");
  assert.equal(p.action, "hold");
  assert.ok(!p.reground, "plan and reality already agree");
  assert.equal(buildProgressionProposal(1).ok, false, "an ordinary hold is still no change");
});

test("timed lifts progress in SECONDS, never load", () => {
  makeExercise("Dead Hang", { muscle_group: "forearms", mode: "timed" });
  planWith(1, { exercise: "Dead Hang", sets: 3, target_seconds: 45, focus: "Grip" });
  // The hold comfortably meets the target → +5s, and no weight in the suggestion.
  logSet("Dead Hang", isoDaysAgo(3), { duration_sec: 50 });

  const p = nextPrescription("Dead Hang");
  assert.equal(p.mode, "timed");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.seconds, 50, "45 + 5s step");
  assert.equal(p.suggested.weight, undefined, "no load on a timed lift");
  assert.equal(p.delta_text, "+5s");
});

test("timed progression is RELATIVE — a short and a long hold advance proportionally", () => {
  // A 20s plank and a 120s dead hang must NOT get the same flat step: the step is a
  // fraction of the current hold, clamped, so each progresses proportionally.
  makeExercise("Plank", { muscle_group: "core", mode: "timed" });
  makeExercise("Dead Hang", { muscle_group: "forearms", mode: "timed" });
  planWith(1, { exercise: "Plank", sets: 3, target_seconds: 20, focus: "Core" });
  planWith(2, { exercise: "Dead Hang", sets: 3, target_seconds: 120, focus: "Grip" });
  logSet("Plank", isoDaysAgo(3), { duration_sec: 20 });
  logSet("Dead Hang", isoDaysAgo(3), { duration_sec: 120 });

  const plank = nextPrescription("Plank");
  const hang = nextPrescription("Dead Hang");
  assert.equal(plank.action, "overload");
  assert.equal(hang.action, "overload");
  const plankStep = plank.suggested.seconds - 20;
  const hangStep = hang.suggested.seconds - 120;
  assert.ok(plankStep >= 3, `short hold gets at least the 3s floor (got +${plankStep}s)`);
  assert.ok(hangStep > plankStep, `the 120s hold steps up MORE in absolute seconds than the 20s hold (${hangStep} vs ${plankStep})`);
  // The long hold's ~10% step (12s) dwarfs the short hold's floored step (3s).
  assert.equal(hangStep, 12, "a 120s hold advances ~10% (+12s)");
  assert.equal(plankStep, 3, "a 20s hold advances by the 3s floor, not a full 10% (2s)");
  assert.match(plank.delta_text, /^\+\d+s$/, "timed delta reads in seconds");
});

test("assisted lifts reduce the assist toward bodyweight (never a positive flip)", () => {
  makeExercise("Assisted Pull-up", { muscle_group: "back" });
  // negative target_weight = assist: -50 lb assist.
  planWith(1, { exercise: "Assisted Pull-up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -50, focus: "Pull" });
  logSet("Assisted Pull-up", isoDaysAgo(10), { weight: -50, reps: 8, rir: 2 });

  const p = nextPrescription("Assisted Pull-up");
  assert.equal(p.action, "overload");
  // Assist is reduced (toward 0) — a SMALLER absolute value, still negative here.
  assert.ok(p.suggested.weight < 0, "still assisted");
  assert.ok(p.suggested.weight > -50, "assist reduced toward bodyweight");
  assert.match(p.delta_text, /assist/);
});

test("only a finished full comparable linked dose can earn the next overload", () => {
  const cases = [
    { name: "Partial Press", day: 1, ago: 8, status: "completed", comparable: false, achievedSets: 1, expected: "partial" },
    { name: "Open Press", day: 2, ago: 7, status: "in_progress", comparable: true, achievedSets: 3, expected: "unfinished" },
    { name: "Confounded Press", day: 3, ago: 6, status: "completed", comparable: false, achievedSets: 3, expected: "non_comparable" },
    { name: "Complete Press", day: 4, ago: 5, status: "completed", comparable: true, achievedSets: 3, expected: "full_comparable" },
    {
      name: "Under Press",
      day: 5,
      ago: 4,
      status: "completed",
      comparable: true,
      achievedSets: 3,
      challengeVerdict: "under_prescribed",
      expected: "under_prescribed",
    },
  ];
  for (const fixture of cases) {
    makeExercise(fixture.name, { muscle_group: "chest" });
    planWith(fixture.day, {
      exercise: fixture.name,
      sets: 3,
      rep_low: 5,
      rep_high: 5,
      target_weight: 100,
      focus: fixture.name,
    });
    const date = isoDaysAgo(fixture.ago);
    for (let setNum = 1; setNum <= fixture.achievedSets; setNum++) {
      logSet(fixture.name, date, { weight: 100, reps: 5, rir: 2, setNum });
    }
    linkLatestDoseOutcome(fixture.name, date, fixture);
  }

  for (const fixture of cases) {
    const prescription = nextPrescription(fixture.name);
    assert.equal(prescription.dose_eligibility.reason, fixture.expected, fixture.name);
    if (fixture.expected === "full_comparable") {
      assert.equal(prescription.action, "overload", fixture.name);
      assert.equal(prescription.suggested.weight, 105, fixture.name);
    } else {
      assert.equal(prescription.action, "hold", fixture.name);
      assert.equal(prescription.suggested.weight, 100, fixture.name);
      assert.match(prescription.why, /linked|part|comparable|full dose/i, fixture.name);
    }
  }
});

test("planDayProgression covers every strength item and skips cardio", () => {
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Incline Press", { muscle_group: "chest" });
  repo.savePlanDay(1, "Push + run", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Incline Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { kind: "cardio", exercise: "Easy run", target_distance_km: 5, target_zone: "Z2" },
  ]);
  logSet("Bench Press", isoDaysAgo(5), { weight: 185, reps: 8, rir: 2 });

  const rows = planDayProgression(1);
  const names = rows.map((r) => r.exercise);
  assert.ok(names.includes("Bench Press"));
  assert.ok(names.includes("Incline Press"));
  assert.ok(!names.some((n) => /run/i.test(n)), "cardio is skipped");
  for (const r of rows) assert.ok(typeof r.plan_item_id === "number", "each row carries its plan_item_id for the apply path");
});

test("multi-channel execution strain holds an earned progression in the actual next-session prescription", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185, focus: "Push" });
  logSet("Barbell Bench Press", isoDaysAgo(28), { weight: 175, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", isoDaysAgo(21), { weight: 180, reps: 8, rir: 2 });
  logSet("Barbell Bench Press", isoDaysAgo(10), { weight: 185, reps: 8, rir: 2 });
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, source)
     VALUES (?, 2200, 175, 'test')`
  ).run(isoDaysAgo(30));
  for (const daysAgo of [1, 2, 3, 4]) {
    for (const [meal, kcal] of [["breakfast", 750], ["dinner", 1000]]) {
      db.prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json) VALUES (?, ?, '', ?)`
      ).run(isoDaysAgo(daysAgo), meal, JSON.stringify({ kcal }));
    }
  }
  for (const daysAgo of [1, 2]) {
    db.prepare(`INSERT INTO fueling_feedback (date, energy, hunger) VALUES (?, 1, 3)`).run(isoDaysAgo(daysAgo));
    db.prepare(`INSERT INTO sessions (date, performance, finished_at) VALUES (?, 2, datetime('now'))`).run(isoDaysAgo(daysAgo));
  }

  const prescription = planDayProgression(1).find((item) => item.exercise === "Barbell Bench Press");
  assert.equal(prescription.action, "hold", "the next exposure cannot add load while the fuel/performance pattern is unresolved");
  assert.equal(prescription.suggested.weight, 185);
  assert.equal(prescription.autoregulated, true);
  // The card names the reason that ACTUALLY held this lift. The fueling read is a
  // property of the day, and it speaks on a lift card only where it changed that
  // lift — here the autoregulation brake got there first, so its own plain
  // sentence stands rather than the day's fueling clause glued on behind it.
  assert.match(
    prescription.why,
    /flat|sore|recovery|meal pattern|complete/i,
    "the brake that actually held this lift names itself"
  );
  assert.doesNotMatch(
    prescription.why,
    /fuel/i,
    "…and the day's fueling sentence never lands on a lift held for its own reason"
  );

  // …in the TRAINING register. The nutrition read's own sentence is written for
  // the nutrition surfaces; concatenating it here is what put "A recent fuel
  // correction is still inside its seven-day settling window, so no second calorie
  // move is made." on a bench-press card.
  const read = currentUnderfuelingRead(localDateISO());
  assert.ok(read.action.line.length > 0, "the fuel read still carries its own line for its own surfaces");
  assert.ok(!prescription.why.includes(read.action.line), "the nutrition sentence never reaches a lift card");
  assert.doesNotMatch(
    prescription.why,
    /calorie|kcal|carb-forward|settling window|maintenance|fuel step|recovery package/i,
    "no calorie mechanics in a strength why"
  );
});

// Every verdict branch used to set ONE hard literal, so two lifts sitting in the
// same state printed the identical sentence on one screen. Distinctness here is a
// property of the exercise keys (the day shifts every phrasing by the same step),
// so this is deterministic rather than date-dependent.
test("two lifts in the same state on one day do not print the same sentence", () => {
  const names = ["Barbell Bench Press", "Overhead Press", "Barbell Row", "Back Squat", "Lateral Raise"];
  for (const name of names) makeExercise(name, { muscle_group: "chest" });
  repo.savePlanDay(1, "Full", "Full", names.map((exercise) => ({ exercise, sets: 3, rep_low: 8, rep_high: 10, target_weight: 100 })));

  // Nothing logged for any of them → every lift lands in the same branch.
  const whys = planDayProgression(1).map((p) => p.why);
  assert.equal(whys.length, names.length);
  assert.ok(new Set(whys).size > 1, `the same verdict reads differently per lift, got ${JSON.stringify(whys)}`);
});

test("one lift's sentence is stable within a day and rotates across days", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 100, focus: "Push" });

  const today = nextPrescription("Barbell Bench Press", undefined, { date: "2026-07-29" }).why;
  const again = nextPrescription("Barbell Bench Press", undefined, { date: "2026-07-29" }).why;
  const tomorrow = nextPrescription("Barbell Bench Press", undefined, { date: "2026-07-30" }).why;
  assert.equal(today, again, "a card must not change its words on a re-render");
  assert.notEqual(today, tomorrow, "consecutive days always differ");
});

test("the whole progression vocabulary holds the reading grammar", () => {
  const phrases = progressionVoicePhrases();
  assert.ok(phrases.length >= 100, "the vocabulary is enumerable");
  for (const phrase of phrases) {
    assert.equal(violatesReadingGrammar(phrase), null, `reading grammar: ${phrase}`);
    // A lift card speaks about training. Calorie mechanics belong to the nutrition
    // surfaces that already carry them.
    assert.doesNotMatch(phrase, /calorie|kcal|carb-forward|settling window|recovery package/i, phrase);
  }
});

test("MCP apply_progression mirrors REST proposal shape and supersedes stale same-day drafts", async () => {
  // apply_progression now routes through the autonomy layer; pin review_everything so the
  // proposals PARK as drafts (autonomy inert) and this stays a pure builder-shape + same-day
  // dedup contract. The lead-mode auto-apply routing is covered in brainAutonomyPlanPaths.test.js.
  repo.setSettings({ lead_mode: "review_everything" });
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95 },
  ]);
  logSet("Bench Press", isoDaysAgo(14), { weight: 180, reps: 8, rir: 2 });
  logSet("Bench Press", isoDaysAgo(5), { weight: 185, reps: 8, rir: 2 });
  logSet("Overhead Press", isoDaysAgo(5), { weight: 95, reps: 6, rir: 1 });

  const first = await callProgramTool("apply_progression", { day: 1 });
  assert.equal(first.ok, true);
  assert.equal(first.proposal.agent, "auto-progression");
  assert.equal(first.proposal.parsed.summary, "Auto-progression for day 1 — 1 lift");
  assert.deepEqual(first.proposal.parsed.changes, [
    {
      day_number: 1,
      exercise: "Bench Press",
      sets: 3,
      rep_low: 6,
      rep_high: 8,
      reason: first.proposal.parsed.changes[0].reason,
      target_weight: 190,
      reason_provenance: first.proposal.parsed.changes[0].reason_provenance,
    },
  ]);
  assert.ok(first.proposal.parsed.changes[0].reason, "change carries a plain-words reason");
  const reasonProvenance = first.proposal.parsed.changes[0].reason_provenance;
  assert.deepEqual(reasonProvenance, {
    reason_code: "training_evidence",
    evidence_date: isoDaysAgo(5),
    as_of_date: isoDaysAgo(0),
    source_ref_type: "training_evidence_snapshot",
    source_ref_key: reasonProvenance.source_ref_key,
  });
  assert.match(reasonProvenance.source_ref_key, /^[a-f0-9]{64}$/);
  assert.ok(!first.proposal.parsed.changes.some((c) => c.exercise === "Overhead Press"), "hold prescriptions stay out of apply proposals");

  const second = await callProgramTool("apply_progression", { day: 1 });
  assert.equal(second.ok, true);
  assert.equal(repo.getProposal(first.proposal.id).status, "superseded");
  assert.equal(repo.getProposal(second.proposal.id).status, "draft");
});

test("nextPrescription returns null when there's no history and no plan item", () => {
  makeExercise("Phantom Lift", { muscle_group: "chest" });
  assert.equal(nextPrescription("Phantom Lift"), null);
});

// ---------------------------------------------------------------------------
test("programBalance bands by the canonical taxonomy and flags DUE groups", () => {
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Lateral Raise", { muscle_group: "shoulders" });
  // Two weeks of heavy shoulder volume, thin chest volume.
  for (const d of [12, 10, 8, 6, 4, 2, 1]) {
    for (let s = 1; s <= 4; s++) logSet("Lateral Raise", isoDaysAgo(d), { weight: 20, reps: 15, rir: 1, setNum: s });
  }
  // Chest only twice → under its low landmark (chest low = 10/wk).
  logSet("Bench Press", isoDaysAgo(9), { weight: 185, reps: 8, rir: 2 });
  logSet("Bench Press", isoDaysAgo(3), { weight: 185, reps: 8, rir: 2 });

  const bal = programBalance(2);
  const chest = bal.groups.find((g) => g.group === "chest");
  const shoulders = bal.groups.find((g) => g.group === "shoulders");
  assert.ok(chest, "chest is tracked under the canonical taxonomy");
  assert.equal(chest.band, "low", "thin chest volume bands LOW");
  assert.ok(bal.due.includes("chest"), "chest is flagged DUE");
  assert.ok(shoulders, "shoulders tracked");
  // Plain words only — no numeric grade in the summary.
  assert.doesNotMatch(bal.summary, /\b\d{2,3}%/);
});

test("programBalance collapses to a calm broad-low read when MOST groups are due", () => {
  // An endurance-led week: thin strength logs across many groups → most read 'due'.
  // The honest signal is "volume's light across the board", not a 10-item to-do list.
  const groups = [
    ["Bench Press", "chest"], ["Barbell Row", "back"], ["Back Squat", "quads"],
    ["Romanian Deadlift", "hamstrings"], ["Overhead Press", "shoulders"],
    ["Barbell Curl", "biceps"], ["Triceps Pushdown", "triceps"],
  ];
  for (const [name, mg] of groups) {
    makeExercise(name, { muscle_group: mg });
    logSet(name, isoDaysAgo(10), { weight: 100, reps: 8, rir: 2 }); // one thin set, > a week ago
  }
  const bal = programBalance(2);
  assert.equal(bal.broad_low, true, "most groups due → broad-low");
  assert.match(bal.summary, /light across most groups/i, "one calm line, not a per-group list");
  assert.match(bal.summary, /running is the priority/i, "frames it as expected, not a failure");
  assert.doesNotMatch(bal.summary, /chest, back, quads/i, "no wall of group names");
  assert.doesNotMatch(bal.summary, /\b\d{2,3}%/, "plain words — no numeric grade");
});

test("programBalance EXCLUDES mobility from the set-count math", () => {
  makeExercise("90/90 Hip Switch", { muscle_group: "mobility" });
  makeExercise("Bench Press", { muscle_group: "chest" });
  for (const d of [5, 3, 1]) {
    for (let s = 1; s <= 5; s++) logSet("90/90 Hip Switch", isoDaysAgo(d), { weight: null, reps: 10, rir: 9, setNum: s });
  }
  logSet("Bench Press", isoDaysAgo(2), { weight: 185, reps: 8, rir: 2 });

  const bal = programBalance(2);
  assert.ok(!bal.groups.some((g) => g.group === "mobility"), "mobility never appears in the working-set bands");
});

test("programBalance honors an explicit as-of date", () => {
  makeExercise("Bench Press", { muscle_group: "chest" });
  logSet("Bench Press", "2026-02-10", { weight: 185, reps: 8, rir: 2 });

  const bal = programBalance(2, "2026-02-10");
  const chest = bal.groups.find((g) => g.group === "chest");
  assert.ok(chest, "the as-of day is included even when it is not the real current date");
  assert.equal(chest.last_trained, "2026-02-10");
});

test("programAdjustments flags missing-pattern GAPS (no core / grip / mobility)", () => {
  // A plan that's all pressing — no core, no grip, no mobility programmed.
  makeExercise("Bench Press", { muscle_group: "chest" });
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95 },
  ]);

  const adj = programAdjustments();
  const gaps = adj.filter((a) => a.kind === "gap").map((a) => a.title.toLowerCase());
  assert.ok(gaps.some((t) => t.includes("core")), "flags missing core work");
  assert.ok(gaps.some((t) => t.includes("grip") || t.includes("forearm")), "flags missing grip work");
  assert.ok(gaps.some((t) => t.includes("mobility")), "flags missing mobility work");
});

test("programAdjustments surfaces a due deload + a due group, plain words", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 315 }]);
  // Sliding squat → a deload adaptation should appear. The first set is marked
  // AMRAP so the estimate is genuinely VERIFIED (see the calibration seam test
  // above) — an unverified slide reads as "hold and test", not "deload".
  logSet("Back Squat", isoDaysAgo(28), { weight: 315, reps: 5, rir: 1, note: "AMRAP" });
  logSet("Back Squat", isoDaysAgo(21), { weight: 305, reps: 5, rir: 1 });
  logSet("Back Squat", isoDaysAgo(14), { weight: 295, reps: 5, rir: 1 });
  logSet("Back Squat", isoDaysAgo(5), { weight: 285, reps: 5, rir: 1 });

  const adj = programAdjustments();
  assert.ok(adj.length > 0, "adaptations are surfaced");
  for (const a of adj) {
    assert.doesNotMatch(`${a.title} ${a.why}`, /\b\d{1,3}\/100\b/, "never a 0-100 score");
  }
  assert.ok(adj.some((a) => a.kind === "deload"), "the sliding squat earns a deload adaptation");
});

test("programAdjustments reframes a due group ALREADY in the plan — train it, don't add more", () => {
  // Back is programmed (a Pull day) but its logged volume is thin → due. The honest
  // read is "get those sessions in", NOT "add a back movement you already have".
  makeExercise("Barbell Row", { muscle_group: "back" });
  makeExercise("Lat Pulldown", { muscle_group: "back" });
  repo.savePlanDay(3, "Pull", "Back", [
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
  ]);
  // A little logged back work over a week ago keeps it DUE (thin volume), not absent.
  logSet("Barbell Row", isoDaysAgo(9), { weight: 135, reps: 8, rir: 2 });

  const adj = programAdjustments();
  const back = adj.find((a) => a.kind === "balance" && /back is due/i.test(a.title));
  assert.ok(back, "back surfaces as due");
  assert.equal(back.programmed, true, "flagged programmed — it's already in the plan");
  assert.match(back.why, /already in your plan/i, "the why says it's already programmed");
  assert.match(back.why, /Day 3/i, "names the day it's on");
  assert.match(back.why, /logged volume/i, "frames the gap as logged volume, not a missing movement");
  // Its suggestions are the movements you ALREADY have, never generic 'add X'.
  assert.ok(
    back.suggestions.some((s) => /Barbell Row|Lat Pulldown/.test(s)),
    "suggestions list the programmed movements, not new ones to add"
  );
});

// ---- acute recovery: never recommend a just-smoked muscle for the next session ---
function logRide(date, { type = "ride", duration_min = 180, distance_km = 40 } = {}) {
  db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(date, type, `${type} ride`, duration_min, distance_km, "test");
}

test("recentMuscleLoad maps a long ride to the leg + core regions it torched (heavy)", () => {
  // "ride" is exactly what normalizeGarminType folds cycling onto — the real sync path.
  logRide(isoDaysAgo(1)); // a 3 h ride yesterday
  const load = recentMuscleLoad(2);
  for (const g of ["quads", "hamstrings", "glutes", "calves", "core"]) {
    const rl = load.get(g);
    assert.ok(rl, `${g} is flagged as recently loaded by the ride`);
    assert.equal(rl.heavy, true, `${g} is HEAVY (a 3 h ride is a real dose)`);
    assert.equal(rl.source, "endurance");
    assert.equal(rl.activity, "ride");
  }
  // A ride doesn't torch the chest/biceps — they stay fresh.
  assert.ok(!load.get("chest"), "the ride doesn't flag chest");
  assert.ok(!load.get("biceps"), "the ride doesn't flag biceps");
  // The raw provider type ("mountain_biking") in a free-text log matches too.
  reset();
  logRide(isoDaysAgo(1), { type: "mountain_biking" });
  assert.equal(recentMuscleLoad(2).get("quads")?.heavy, true, "raw mountain_biking is recognized");
});

test("recentMuscleLoad does NOT gate legs after a short casual walk", () => {
  // A 40-min walk folds onto "hike" but is well under hike's heavy bar (90 min).
  db.prepare(`INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(isoDaysAgo(1), "hike", "evening walk", 40, 3, "test");
  const rl = recentMuscleLoad(2).get("quads");
  if (rl) assert.equal(rl.heavy, false, "a short walk loads legs but not HEAVY — it won't hold back leg training");
});

test("recentMuscleLoad honors an explicit as-of date", () => {
  logRide("2026-02-10");
  const rl = recentMuscleLoad(2, "2026-02-11").get("quads");
  assert.ok(rl, "the as-of window includes yesterday's ride");
  assert.equal(rl.last_date, "2026-02-10");
  assert.equal(rl.days_ago, 1);
  assert.equal(rl.heavy, true);
});

test("programAdjustments holds back a due group the athlete just smoked on a ride", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  makeExercise("Bench Press", { muscle_group: "chest" });
  // Both quads and chest are DUE (thin, trained > a week ago) — but only legs got
  // hammered by yesterday's long ride.
  logSet("Back Squat", isoDaysAgo(9), { weight: 225, reps: 5, rir: 2 });
  logSet("Bench Press", isoDaysAgo(9), { weight: 185, reps: 8, rir: 2 });
  logRide(isoDaysAgo(1)); // 3 h MTB ride yesterday → quads recovering

  const adj = programAdjustments();
  const quads = adj.find((a) => a.kind === "balance" && /quad/i.test(a.title));
  const chest = adj.find((a) => a.kind === "balance" && /chest/i.test(a.title));
  assert.ok(quads, "quads still appears (it IS due on the week)");
  assert.equal(quads.recovering, true, "but it's reframed as RECOVERING, not a call to act");
  assert.match(quads.title, /recovering/i);
  assert.ok(!(quads.suggestions && quads.suggestions.length), "a recovering group offers no 'do it now' movements");
  assert.match(quads.why, /ride/i, "the why names the ride that loaded it (the connected read)");
  assert.ok(chest, "chest — fresh, untouched by the ride — is a normal due item");
  assert.ok(!chest.recovering, "chest is NOT recovering");
  assert.ok(chest.suggestions && chest.suggestions.length, "a fresh due group carries concrete movements");
  // Fresh work leads; the recovering group is sunk below it.
  assert.ok(adj.indexOf(chest) < adj.indexOf(quads), "fresh due group ranks above the recovering one");
  // Plain words only — never a 0-100 score.
  for (const a of adj) assert.doesNotMatch(`${a.title} ${a.why}`, /\b\d{1,3}\/100\b/);
});

test("multiple smoked due groups consolidate into ONE calm recovering note", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  makeExercise("Romanian Deadlift", { muscle_group: "hamstrings" });
  logSet("Back Squat", isoDaysAgo(9), { weight: 225, reps: 5, rir: 2 });
  logSet("Romanian Deadlift", isoDaysAgo(9), { weight: 185, reps: 8, rir: 2 });
  logRide(isoDaysAgo(1)); // a long ride yesterday torches both quads and hamstrings

  const adj = programAdjustments();
  const rec = adj.filter((a) => a.recovering);
  assert.equal(rec.length, 1, "the smoked groups collapse into ONE recovering line, not three rows");
  assert.match(rec[0].title, /quad/i);
  assert.match(rec[0].title, /hamstring/i);
  assert.match(rec[0].why, /they're due/i, "plural phrasing for multiple groups");
  assert.match(rec[0].why, /ride/i, "names the ride that loaded them");
});

// ===========================================================================
// PERIODIZATION — the block's phase is read by the math, not just the prompt
// ===========================================================================
// The program-block model has always carried accumulation / intensification /
// deload / realization, and until now NOTHING that prescribes read it. These
// tests pin the seam: same logged inputs, different phase, different answer —
// and with no block running, byte-for-byte the old behavior.

function seedCappedBenchWeek(reps = 8) {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185, focus: "Push" });
  for (let s = 1; s <= 3; s++) logSet("Barbell Bench Press", isoDaysAgo(4), { weight: 185, reps, rir: 2, setNum: s });
}

// The multi-channel fuel fixture: enough logged intake below target, flat energy
// and flat sessions that the protective fuel read stops asking for aggression.
function seedUnderfueledWeek() {
  db.prepare(
    `INSERT INTO nutrition_targets (effective_date, target_kcal, protein_g, source) VALUES (?, 2200, 175, 'test')`
  ).run(isoDaysAgo(30));
  for (const daysAgo of [1, 2, 3, 4]) {
    for (const [meal, kcal] of [["breakfast", 750], ["dinner", 1000]]) {
      db.prepare(`INSERT INTO food_notes (date, meal, raw_output, parsed_json) VALUES (?, ?, '', ?)`).run(
        isoDaysAgo(daysAgo),
        meal,
        JSON.stringify({ kcal })
      );
    }
  }
  for (const daysAgo of [1, 2]) {
    db.prepare(`INSERT INTO fueling_feedback (date, energy, hunger) VALUES (?, 1, 3)`).run(isoDaysAgo(daysAgo));
    db.prepare(`INSERT INTO sessions (date, performance, finished_at) VALUES (?, 2, datetime('now'))`).run(
      isoDaysAgo(daysAgo)
    );
  }
}

// A slipping lift: est-1RM clearly sliding over several sessions. `verified: true`
// marks the first day's set AMRAP so the calibration ladder reads the estimate as
// confirmed (see the calibration seam test above) — callers exercising the
// ordinary REGRESSING_DELOAD path need that; callers only after cut-pressure hold
// (which short-circuits before the confidence check) don't.
function seedRegressingDeadlift({ verified = false } = {}) {
  makeExercise("Deadlift", { muscle_group: "hamstrings" });
  planWith(1, { exercise: "Deadlift", sets: 3, rep_low: 5, rep_high: 5, target_weight: 365, focus: "Pull" });
  logSet("Deadlift", isoDaysAgo(28), { weight: 365, reps: 5, rir: 1, note: verified ? "AMRAP" : null });
  logSet("Deadlift", isoDaysAgo(21), { weight: 355, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(14), { weight: 345, reps: 5, rir: 1 });
  logSet("Deadlift", isoDaysAgo(5), { weight: 335, reps: 5, rir: 1 });
}

test("the training phase changes the prescription — same logs, different answer", () => {
  seedCappedBenchWeek(8); // every set capped the plan's 6–8 range at RIR 2

  // NO BLOCK — the engine behaves exactly as it did before periodization existed.
  const noBlock = nextPrescription("Barbell Bench Press");
  assert.equal(noBlock.action, "overload");
  assert.equal(noBlock.suggested.weight, 190, "the ordinary earned compound step");
  assert.ok(!noBlock.rep_step);
  assert.equal(noBlock.block_phase, undefined, "no block, nothing periodized");

  // ACCUMULATION — the range has to be genuinely full (a clean rep on top of the
  // ceiling) before load moves, so the same session earns REPS, not weight.
  blocks.createBlock({ goal: "Build", focus: "strength", total_weeks: 6, week_index: 1 });
  const accumulation = nextPrescription("Barbell Bench Press");
  assert.equal(accumulation.block_phase, "accumulation");
  assert.equal(accumulation.rep_step, true, "a volume stretch is spent at the top of the window");
  assert.equal(accumulation.suggested.weight, 185, "the load is held while the reps saturate");

  // INTENSIFICATION — a strong top set at the ceiling buys the load on its own.
  blocks.createBlock({ goal: "Sharpen", focus: "strength", total_weeks: 6, week_index: 5 });
  const intensification = nextPrescription("Barbell Bench Press");
  assert.equal(intensification.block_phase, "intensification");
  assert.ok(!intensification.rep_step);
  assert.equal(intensification.suggested.weight, 190, "intensity earns the step");

  // DELOAD — the work was there; the week is the reason it waits.
  blocks.createBlock({ goal: "Ease", focus: "strength", total_weeks: 6, week_index: 6 });
  const deload = nextPrescription("Barbell Bench Press");
  assert.equal(deload.block_phase, "deload");
  assert.equal(deload.action, "hold");
  assert.equal(deload.suggested.weight, 185, "an easy week adds nothing");
});

test("a volume phase paces the step down when it IS earned", () => {
  seedCappedBenchWeek(9); // a clean rep ON TOP of the 6–8 range, every set
  blocks.createBlock({ goal: "Build", focus: "strength", total_weeks: 6, week_index: 1 });

  const p = nextPrescription("Barbell Bench Press");
  assert.equal(p.action, "overload");
  assert.ok(!p.rep_step, "the window is saturated — this is the LOAD stage");
  assert.equal(p.suggested.weight, 187.5, "a build stretch takes half the ordinary step");
});

test("an isolation lift is untouched by the phase — plain double progression", () => {
  makeExercise("Dumbbell Curl", { muscle_group: "biceps" });
  planWith(1, { exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30, focus: "Arms" });
  for (let s = 1; s <= 3; s++) logSet("Dumbbell Curl", isoDaysAgo(4), { weight: 30, reps: 12, rir: 2, setNum: s });
  blocks.createBlock({ goal: "Build", focus: "strength", total_weeks: 6, week_index: 1 });

  const p = nextPrescription("Dumbbell Curl");
  assert.equal(p.action, "overload");
  assert.equal(p.suggested.weight, 32.5, "accessory work keeps its own 2.5 lb ladder");
});

test("peak week prescribes a heavy top set — and logging it re-anchors the estimate", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  planWith(1, { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 190, focus: "Legs" });
  // A genuine single early in the trail VERIFIES the estimate (see the calibration
  // seam test above) — a peak week the calibration ladder trusts expresses as a
  // heavy SINGLE; an unconfirmed one widens to a double instead.
  logSet("Back Squat", isoDaysAgo(25), { weight: 185, reps: 1, rir: 0 });
  logSet("Back Squat", isoDaysAgo(21), { weight: 185, reps: 5, rir: 2 });
  logSet("Back Squat", isoDaysAgo(10), { weight: 190, reps: 5, rir: 2 });
  blocks.createBlock({ goal: "Peak", focus: "peak", total_weeks: 3, week_index: 3 });

  const p = nextPrescription("Back Squat");
  assert.equal(p.block_phase, "realization");
  assert.ok(p.top_set, "peak week carries a top-set protocol");
  assert.equal(p.top_set.reps, 1, "a confirmed estimate is expressed as a heavy single");
  assert.ok(p.top_set.weight > 190, "the top set is heavier than the working load");
  assert.ok(p.top_set.backoff, "…with back-off work after it");
  assert.ok(p.top_set.backoff.weight < p.top_set.weight);
  assert.ok(p.top_set.backoff.sets >= 1);
  assert.match(p.delta_text, /^top set /);
  // `suggested` describes the BULK of the session — the back-off block — so a
  // consumer that composes today's work from it lands on a real, lighter session
  // rather than on one near-maximal single with the rest of the work missing.
  assert.equal(p.suggested.weight, p.top_set.backoff.weight);
  assert.equal(p.suggested.sets, p.top_set.backoff.sets);
  assert.equal(p.suggested.rep_low, 5, "the back-off block keeps the plan's own window");
  assert.equal(violatesReadingGrammar(p.why), null);

  // A near-maximal single is a SESSION protocol, never a plan target — writing it
  // into plan_items would make it the number every later step is measured from.
  assert.equal(buildProgressionProposal(1).ok, false, "the peak set never lands as a plan change");

  // …and the logged result is exactly what the calibration ledger counts as a
  // verifying set, so the peak re-anchors the estimate instead of just feeling heavy.
  const today = localDateISO();
  logSet("Back Squat", today, { weight: p.top_set.weight, reps: p.top_set.reps, rir: 0 });
  const session = repo.getSessionByDate(today);
  const events = detectStrengthCalibration(session.id);
  assert.ok(
    events.some((e) => e.kind === "strength_topset" && /squat/i.test(String(e.result?.exercise ?? ""))),
    "the peak set anchors the estimate"
  );
});

// ===========================================================================
// THE CUT AS A LEVER — "holding is a win" stops being a sentence in a playbook
// ===========================================================================

test("a slip while fueling is behind HOLDS the load — cutting weight can't fix a food problem", () => {
  seedRegressingDeadlift();
  seedUnderfueledWeek();

  const p = nextPrescription("Deadlift");
  assert.equal(p.action, "hold", "the automatic tenth off is the wrong answer here");
  assert.equal(p.suggested.weight, 365, "the load stays where it is");
  assert.match(p.why, /fuel|food|eating/i, "the why tells the fueling story");
  assert.equal(violatesReadingGrammar(p.why), null);
  assert.doesNotMatch(p.why, /calorie|kcal|settling window/i, "…in the training register, not the nutrition one");
});

test("a flat lift on a real cut is holding ground — no variation is forced mid-cut", () => {
  makeExercise("Leg Press", { muscle_group: "quads" });
  planWith(1, { exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400, focus: "Legs" });
  for (const d of [28, 21, 14, 7, 2]) logSet("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2 });

  const wellFed = nextPrescription("Leg Press");
  assert.equal(wellFed.action, "vary", "flat this long ordinarily asks for a variation");

  seedUnderfueledWeek();
  const cutting = nextPrescription("Leg Press");
  assert.notEqual(cutting.action, "vary", "a cut buys the movement patience — the same weeks read differently");
  assert.equal(cutting.suggested.weight, 400);
});

// ===========================================================================
// A SECOND DELOAD IS NOT ANOTHER DELOAD
// ===========================================================================

function seedAppliedDeload(exercise, daysAgo, weight) {
  db.prepare(
    `INSERT INTO plan_proposals (created_at, agent, instruction, raw_output, parsed_json, status)
     VALUES (?, 'auto-progression', 'day 1 progression', '', ?, 'applied')`
  ).run(
    `${isoDaysAgo(daysAgo)} 12:00:00`,
    JSON.stringify({
      summary: "Auto-progression",
      changes: [{ day_number: 1, exercise, target_weight: weight, progression_action: "deload" }],
    })
  );
}

test("a SECOND deload on the same lift changes the SHAPE instead of cutting load again", () => {
  seedRegressingDeadlift({ verified: true });

  // First, the ordinary answer — and it carries the marker a repeat is recognised from.
  const first = nextPrescription("Deadlift");
  assert.equal(first.action, "deload");
  assert.ok(!first.escalated, "the first step back is an ordinary one");
  const proposal = buildProgressionProposal(1);
  assert.equal(proposal.ok, true);
  const change = proposal.proposal.parsed.changes.find((c) => c.exercise === "Deadlift");
  assert.equal(change.progression_action, "deload", "an applied deload leaves an audit trail");

  // Now the same lift, three weeks after a deload that was actually applied.
  seedAppliedDeload("Deadlift", 21, 330);
  const second = nextPrescription("Deadlift");
  assert.equal(second.escalated, "rep_wave");
  assert.equal(second.suggested.rep_low, 3, "the window drops into heavier reps");
  assert.equal(second.suggested.rep_high, 4);
  assert.ok(
    second.suggested.weight > first.suggested.weight,
    `the load barely moves — the scheme is the change (${second.suggested.weight} vs ${first.suggested.weight})`
  );
  assert.equal(violatesReadingGrammar(second.why), null);
});

test("the playbook tells the escalation story instead of asking for another light deload", () => {
  seedRegressingDeadlift();
  seedAppliedDeload("Deadlift", 21, 330);

  const play = trainingPlaybook().plateau_plays.find((p) => /deadlift/i.test(p.title));
  assert.ok(play, "the slipping lift still gets a play");
  assert.doesNotMatch(play.adaptations.join(" "), /light deload/i, "it stops recommending the move that failed");
  assert.match(play.adaptations.join(" "), /rep window|rep bracket|variation/i);
  assert.match(play.why, /already/i, "the why names the earlier step back");
});

// A wave already applied is not a reason to wave again. Without a termination
// bound the ladder had none: every week the lift still read regressing, the
// escalation fired, and the shape changed again before the last change had shown
// anything. The applied wave carries its own marker, and the branch reads it back.
function seedAppliedWave(exercise, daysAgo, weight) {
  db.prepare(
    `INSERT INTO plan_proposals (created_at, agent, instruction, raw_output, parsed_json, status)
     VALUES (?, 'auto-progression', 'day 1 progression', '', ?, 'applied')`
  ).run(
    `${isoDaysAgo(daysAgo)} 12:00:00`,
    JSON.stringify({
      summary: "Auto-progression",
      changes: [
        {
          day_number: 1,
          exercise,
          target_weight: weight,
          progression_action: "deload",
          progression_escalation: "rep_wave",
        },
      ],
    })
  );
}

test("an escalated wave does not stack another one — the lift runs the wave out", () => {
  seedRegressingDeadlift({ verified: true });
  // The applied wave IS an applied deload too, so the repeat condition still holds.
  seedAppliedWave("Deadlift", 21, 347.5);

  const p = nextPrescription("Deadlift");
  assert.equal(p.action, "hold", "the shape does not change again on top of a change in flight");
  assert.equal(p.escalated, undefined, "and nothing new is marked as an escalation");
  assert.equal(p.suggested.weight, 365, "the load stays where the wave left it");
  assert.match(p.why, /already|still|mid-way/i, "the why says the wave is still running");
  assert.equal(violatesReadingGrammar(p.why), null);
});

test("the applied wave leaves the audit trail the bound is read from", () => {
  seedRegressingDeadlift({ verified: true });
  seedAppliedDeload("Deadlift", 21, 330);
  const proposal = buildProgressionProposal(1);
  assert.equal(proposal.ok, true);
  const change = proposal.proposal.parsed.changes.find((c) => c.exercise === "Deadlift");
  assert.equal(change.progression_escalation, "rep_wave", "a wave records that it was one");
  assert.equal(change.progression_action, "deload", "…and still counts as a step back");
});

// ===========================================================================
// THE UNVERIFIED-REGRESSION HOLD IS SCOPED AND BOUNDED
// ===========================================================================
// "Unverified" is near-universal on real data — a verifying set is an AMRAP or a
// set at 0.92× the running estimate, which ordinary work rarely is. So an
// unconditional hold on every unverified regression would have switched the deload
// arm off entirely, and on a lift the calibration ladder never offers a test for,
// the hold's own "let a heavy set settle it" story is unreachable: the lift would
// sit at its current weight indefinitely. Three bounds, one test each.

// An accessory: third on the day, so mainPlanLifts (the day's first two loaded
// movements) does not track it and no test is ever suggested for it.
function seedRegressingAccessory() {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  makeExercise("Overhead Press", { muscle_group: "shoulders" });
  makeExercise("Cable Fly", { muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 135 },
    { exercise: "Cable Fly", sets: 3, rep_low: 10, rep_high: 12, target_weight: 60 },
  ]);
  for (const [days, weight] of [[28, 60], [21, 57.5], [14, 55], [5, 52.5]]) {
    logSet("Cable Fly", isoDaysAgo(days), { weight, reps: 10, rir: 1 });
  }
}

test("an accessory keeps the ordinary deload — the hold's test is unreachable there", () => {
  seedRegressingAccessory();
  assert.equal(estimateConfidenceFor("Cable Fly"), "unverified", "nothing has confirmed this estimate either");
  const p = nextPrescription("Cable Fly");
  assert.equal(p.action, "deload", "Epley noise on an accessory is cheap; a silent dead end is not");
  assert.ok(p.suggested.weight < 60 && p.suggested.weight > 0);
  // …and the ladder confirms why: it would never put a test in front of this lift.
  assert.ok(
    !dueCalibrations().some((entry) => entry.target_key === normalizedExerciseKey("Cable Fly")),
    "the calibration ladder does not track an accessory"
  );
});

test("a main lift holds ONCE, then falls through to the deload on a continued slide", () => {
  // A fresh slide: the peak is recent, so the hold's story ("one heavy set would
  // settle this") is still live.
  makeExercise("Deadlift", { muscle_group: "hamstrings" });
  planWith(1, { exercise: "Deadlift", sets: 3, rep_low: 5, rep_high: 5, target_weight: 365, focus: "Pull" });
  for (const [days, weight] of [[28, 365], [21, 355], [14, 345], [5, 335]]) {
    logSet("Deadlift", isoDaysAgo(days), { weight, reps: 5, rir: 1 });
  }
  const fresh = nextPrescription("Deadlift");
  assert.equal(fresh.action, "hold", "a fresh, shallow slide gets the pause");
  assert.match(fresh.why, /heavy set|confirm/i);

  // The same lift, the same shallow slide — but it has been running for two months.
  // The heavy set has been offered and not taken; the deload arm takes over.
  reset();
  makeExercise("Deadlift", { muscle_group: "hamstrings" });
  planWith(1, { exercise: "Deadlift", sets: 3, rep_low: 5, rep_high: 5, target_weight: 365, focus: "Pull" });
  for (const [days, weight] of [[55, 365], [40, 360], [25, 355], [5, 350]]) {
    logSet("Deadlift", isoDaysAgo(days), { weight, reps: 5, rir: 1 });
  }
  const continued = nextPrescription("Deadlift");
  assert.equal(continued.action, "deload", "a slide still running a month later is not estimate noise");
  assert.ok(continued.suggested.weight < 365 && continued.suggested.weight > 0);
});

test("a DEEP slide deloads even unverified — holding there is not the conservative arm", () => {
  makeExercise("Deadlift", { muscle_group: "hamstrings" });
  planWith(1, { exercise: "Deadlift", sets: 3, rep_low: 5, rep_high: 5, target_weight: 365, focus: "Pull" });
  // Down about 18% off its own recent peak — further than the deload would have
  // taken it, so calling it a formula artifact stops being honest.
  for (const [days, weight] of [[28, 365], [21, 345], [14, 325], [5, 300]]) {
    logSet("Deadlift", isoDaysAgo(days), { weight, reps: 5, rir: 1 });
  }
  assert.equal(estimateConfidenceFor("Deadlift"), "unverified");
  const p = nextPrescription("Deadlift");
  assert.equal(p.action, "deload");
});

test("the playbook agrees with whichever arm the engine actually takes", () => {
  // Held: the playbook asks for the heavy set, not for the cut the engine refused.
  seedRegressingDeadlift();
  const held = trainingPlaybook().plateau_plays.find((p) => /deadlift/i.test(p.title));
  assert.ok(held);
  assert.equal(nextPrescription("Deadlift").action, "hold", "the engine is holding this one");
  assert.doesNotMatch(held.adaptations.join(" "), /light deload/i, "so the playbook does not ask for a deload");
  assert.match(held.adaptations.join(" "), /heavy set|heavy top set/i);
  for (const line of [...held.adaptations, held.why]) assert.equal(violatesReadingGrammar(line), null, `"${line}"`);

  // Deloading: the deload story is the honest one again.
  reset();
  seedRegressingDeadlift({ verified: true });
  const deloading = trainingPlaybook().plateau_plays.find((p) => /deadlift/i.test(p.title));
  assert.ok(deloading);
  assert.equal(nextPrescription("Deadlift").action, "deload", "a confirmed estimate returns to the deload arm");
  assert.match(deloading.adaptations.join(" "), /light deload/i);
});

// ===========================================================================
// SEAM: THE LEDGER'S OWN RECORD MOVES THE PLATEAU-VARY BOUNDARY (ledgerCounsel,
// consuming reaction-model.ts's liftLedgerRead — brain_decisions/brain_evaluations
// on THIS lift's own progression expectations, not just liftLedgerRead's own unit
// coverage in test/reactionModelV2.test.js)
// ===========================================================================

// Minimal, valid brain_decisions/brain_expectations/brain_evaluations rows for one
// lift's progression expectation — mirrors test/reactionModelV2.test.js's fixture
// shape (recordDecision validates the full decision, so every field here matters).
function ledgerDecision(key, exercise) {
  return {
    effective_date: "2026-01-01",
    kind: "training_target",
    domain: "training",
    summary: `Lift target ${key} for ${exercise}.`,
    rationale: "Measure the response before changing the target again.",
    source: "test",
    // BRAIN_SOURCE_REF_TYPES (src/brain/decision-contract.ts) has no
    // "training_target" member — "nutrition_target" is just a valid enum slot
    // here, unrelated to this decision's actual (training) kind/domain.
    source_ref_type: "nutrition_target",
    source_ref_key: key,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: { lift: exercise, slot: key },
    specialist: null,
    applied_at: "2026-01-01T12:00:00.000Z",
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "seam-test-v1",
  };
}

function ledgerExpectation(exercise) {
  return {
    metric_key: "exercise_est_1rm_trend",
    subject_key: exercise,
    direction: "at_least",
    baseline: { est_1rm: 200 },
    target: { value: 194 },
    window_start: "2026-01-01",
    window_end: "2026-01-21",
    minimum_data: { exposures: 3 },
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "exercise_est_1rm",
    evaluator_version: "seam-test-v1",
  };
}

// Record ONE conclusive verdict on `exercise`'s progression, dated `daysAgo` back —
// the shape liftLedgerRead (src/repo/reaction-model.ts) reads as the ledger's word
// on this specific lift.
function recordLiftVerdict(exercise, key, verdict, daysAgo) {
  const recorded = recordDecision(ledgerDecision(key, exercise), [ledgerExpectation(exercise)]);
  const evaluation = insertBrainEvaluation({
    expectation_id: recorded.expectations[0].id,
    verdict,
    actual: { value: verdict === "aligned" ? 205 : 180, exposures: 5 },
    evidence_keys: [`logged_sets:2026-01-01..2026-01-21:n=5`],
    confounders: [],
    explanation: verdict === "aligned" ? "The estimate held." : "The estimate did not hold.",
    evaluator_version: "seam-test-v1",
  });
  db.prepare(`UPDATE brain_evaluations SET evaluated_at = ? WHERE id = ?`).run(
    `${addDaysISO(localDateISO(), -daysAgo)} 12:00:00`,
    evaluation.id
  );
  return recorded;
}

test("ledger counsel: two MISSED verdicts bring the plateau-vary boundary a week sooner", () => {
  makeExercise("Leg Press", { muscle_group: "quads" });
  planWith(1, { exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400, focus: "Legs" });
  // Same top load, 4 sessions spanning 15 days → plateaued, exactly 2 weeks static.
  // Ordinarily (PLATEAU_VARY_WEEKS = 3) that is not long enough to vary yet.
  for (const d of [16, 11, 6, 1]) logSet("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2 });

  const before = nextPrescription("Leg Press");
  assert.equal(before.action, "hold", "2 static weeks doesn't clear the ordinary 3-week bar yet");

  // Two conclusive MISSED verdicts on this lift's own progression, both inside the
  // ledger's window and among its most recent — enough for `informative: true` and
  // for ledgerCounsel to read doubt.
  recordLiftVerdict("Leg Press", "m1", "not_aligned", 40);
  recordLiftVerdict("Leg Press", "m2", "not_aligned", 5);

  const after = nextPrescription("Leg Press");
  assert.equal(after.action, "vary", "a ledger that keeps missing brings the change forward a week");
  assert.equal(violatesReadingGrammar(after.why), null);
});

test("ledger counsel: two ALIGNED verdicts buy the plateau extra patience before varying", () => {
  makeExercise("Leg Press", { muscle_group: "quads" });
  planWith(1, { exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 400, focus: "Legs" });
  // Same top load, 5 sessions spanning 27 days → plateaued, 4 weeks static — past
  // the ordinary 3-week bar, so the baseline answer is already "vary".
  for (const d of [28, 21, 14, 7, 1]) logSet("Leg Press", isoDaysAgo(d), { weight: 400, reps: 10, rir: 2 });

  const before = nextPrescription("Leg Press");
  assert.equal(before.action, "vary", "4 static weeks ordinarily clears the bar");

  // Two conclusive ALIGNED verdicts, no misses — the ledger has been honest about
  // this lift, buying it patience instead of a reshuffle.
  recordLiftVerdict("Leg Press", "a1", "aligned", 40);
  recordLiftVerdict("Leg Press", "a2", "aligned", 5);

  const after = nextPrescription("Leg Press");
  assert.equal(after.action, "hold", "a ledger that keeps landing buys the lift another clean run");
  assert.match(after.why, /answering|landed|honest/i, "the why credits the lift's own record");
  assert.equal(violatesReadingGrammar(after.why), null);
});

// ===========================================================================
// SEAM: MOVEMENT-RISK DEMOTES A VARY CANDIDATE (riskRerank, consuming
// movement-risk.ts's movementRiskFor — proven live through rankedVaryOptions
// inside nextPrescription's vary path, not just movementRisk.test.js's direct
// unit coverage of movementRiskFor itself)
// ===========================================================================

function openSymptomOn(areaText, onsetDaysAgo, lastDaysAgo) {
  const info = db
    .prepare(
      `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
       VALUES ('test', ?, 'active', 'area', ?, ?)`
    )
    .run(areaText, isoDaysAgo(onsetDaysAgo), isoDaysAgo(lastDaysAgo));
  return Number(info.lastInsertRowid);
}

function painOnDays(eventId, exerciseName, daysAgoList) {
  const ex = repo.findExercise(exerciseName);
  for (const d of daysAgoList) {
    db.prepare(
      `INSERT INTO movement_tolerance_observations
         (symptom_event_id, session_id, exercise_id, movement_key, movement_name, observed_on, outcome, relevant)
       VALUES (?, NULL, ?, ?, ?, ?, 'pain_present', 1)`
    ).run(eventId, ex.id, `exercise:${ex.id}`, ex.name, isoDaysAgo(d));
  }
}

test("movement risk demotes a flagged vary candidate below an otherwise lower-ranked clear one", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 315, focus: "Legs" });
  for (const d of [35, 28, 21, 14, 7, 2]) logSet("Back Squat", isoDaysAgo(d), { weight: 315, reps: 10, rir: 2 });

  // Register the two same-pattern candidates the athlete has actually trained.
  // Every other candidate suggestAlternatives("Back Squat") offers stays a bare
  // catalog name (never trained → riskRerank can't hold tolerance memory against
  // it), so excluding them isolates the ranking to these two real lifts.
  makeExercise("Front Squat", { muscle_group: "quads" });
  makeExercise("Hack Squat", { muscle_group: "quads" });
  const excludeNames = ["Box Squat", "Safety Bar Squat", "Zercher Squat", "Leg Press", "DB Goblet Squat", "Goblet Squat"];

  const before = nextPrescription("Back Squat", undefined, { excludeNames });
  assert.equal(before.action, "vary");
  assert.equal(before.vary_to, "Front Squat", "unflagged, Front Squat leads the menu");
  assert.deepEqual(
    before.vary_options.map((o) => o.name),
    ["Front Squat", "Hack Squat"]
  );

  // Repeated pain on Front Squat, 2 separate days inside the tolerance window.
  const event = openSymptomOn("left knee", 60, 10);
  painOnDays(event, "Front Squat", [60, 10]);

  const after = nextPrescription("Back Squat", undefined, { excludeNames });
  assert.equal(after.action, "vary");
  assert.equal(after.vary_to, "Hack Squat", "the flagged candidate no longer leads the menu");
  assert.deepEqual(
    after.vary_options.map((o) => o.name),
    ["Hack Squat", "Front Squat"],
    "Front Squat is demoted below Hack Squat, which ranked behind it before the flag"
  );
  assert.equal(violatesReadingGrammar(after.why), null);
});

// ---------------------------------------------------------------------------
// THE PAIN TRAFFIC LIGHT — per movement, never per session (src/repo/pain-band.ts).
// Amber holds the load and waits for the next exposure to answer the settling
// question; red takes a bounded step off THAT movement. Everything the symptom does
// not cover keeps training exactly as it was.

function earnedOverload(name, group) {
  makeExercise(name, { muscle_group: group });
  planWith(group === "chest" ? 2 : 1, {
    exercise: name,
    sets: 3,
    rep_low: 6,
    rep_high: 8,
    target_weight: 185,
    focus: group === "chest" ? "Push" : "Legs",
  });
  logSet(name, isoDaysAgo(28), { weight: 175, reps: 8, rir: 2 });
  logSet(name, isoDaysAgo(21), { weight: 180, reps: 8, rir: 2 });
  logSet(name, isoDaysAgo(10), { weight: 185, reps: 8, rir: 2 });
}

function statePain(area, onsetDaysAgo, movement, exerciseId, days) {
  const event = repo.reportTrainingSymptom({ area_text: area, onset_on: isoDaysAgo(onsetDaysAgo) });
  for (const { at, painFree } of days) {
    repo.recordMovementTolerance({
      symptom_event_id: event.id,
      movement,
      exercise_id: exerciseId,
      observed_on: isoDaysAgo(at),
      pain_free: painFree,
    });
  }
  return event;
}

test("pain amber holds the earned step on that movement while the rest of the session proceeds", () => {
  earnedOverload("Back Squat", "quads");
  earnedOverload("Barbell Bench Press", "chest");
  const squat = repo.findExercise("Back Squat");
  statePain("left knee", 6, "Back Squat", squat.id, [{ at: 4, painFree: false }]);

  const braked = nextPrescription("Back Squat");
  assert.equal(braked.action, "hold", "an open settling question holds the load");
  assert.equal(braked.suggested.weight, 185, "the load stays where it is — the step waits, it is not lost");
  assert.ok(braked.autoregulated, "a safety brake shaped this");
  assert.match(braked.why, /next (go|session|time)|settled/i);

  const untouched = nextPrescription("Barbell Bench Press");
  assert.equal(untouched.action, "overload", "one hurting movement never blocks the session");
  assert.equal(untouched.suggested.weight, 190);
});

test("pain red reduces THAT movement's load, and a settled report leaves the step alone", () => {
  earnedOverload("Back Squat", "quads");
  const squat = repo.findExercise("Back Squat");
  statePain("left knee", 9, "Back Squat", squat.id, [
    { at: 6, painFree: false },
    { at: 2, painFree: false },
  ]);
  const red = nextPrescription("Back Squat");
  assert.equal(red.action, "deload", "it did not settle between exposures, so the load comes down");
  assert.ok(red.suggested.weight < 185, "a bounded step down on this movement");
  assert.match(red.why, /rest of the session|Nothing else|everything else/i, "the sentence says the day still runs");

  reset();
  earnedOverload("Back Squat", "quads");
  const again = repo.findExercise("Back Squat");
  statePain("left knee", 9, "Back Squat", again.id, [
    { at: 6, painFree: false },
    { at: 4, painFree: true },
  ]);
  const green = nextPrescription("Back Squat");
  assert.equal(green.action, "overload", "a report that settled by the next exposure does not brake anything");
  assert.equal(green.suggested.weight, 190);
});

test("a pain deload stays out of the repeat-deload audit trail, and says nothing it cannot do", () => {
  earnedOverload("Back Squat", "quads");
  const squat = repo.findExercise("Back Squat");
  statePain("left knee", 9, "Back Squat", squat.id, [
    { at: 6, painFree: false },
    { at: 2, painFree: false },
  ]);
  const red = nextPrescription("Back Squat");
  assert.equal(red.action, "deload");
  assert.equal(red.pain_protected, true);

  // The repeat-deload ladder asks "is cutting load failing this lift?". A cut the
  // athlete's own pain asked for is no evidence about that, so it never becomes the
  // "first" deload that makes the next ordinary one a repeat (and escalates a rep
  // wave, or rotates the movement out). Same exemption fuel-protection cuts carry.
  const proposal = buildProgressionProposal(1);
  assert.equal(proposal.ok, true);
  const change = proposal.proposal.parsed.changes.find((c) => c.exercise === "Back Squat");
  assert.ok(change, "the cut is still proposed and applied like any other");
  assert.equal(change.progression_action, undefined, "but it does not stamp the repeat-deload marker");

  // An assisted or bodyweight lift has no external load to take off, so red degrades
  // to the HOLD's sentence rather than printing a cut over a number that never moved.
  reset();
  makeExercise("Assisted Pull-up", { muscle_group: "back" });
  planWith(1, { exercise: "Assisted Pull-up", sets: 3, rep_low: 6, rep_high: 8, target_weight: null, focus: "Pull" });
  logSet("Assisted Pull-up", isoDaysAgo(21), { weight: null, reps: 8, rir: 2 });
  logSet("Assisted Pull-up", isoDaysAgo(10), { weight: null, reps: 8, rir: 2 });
  const pullup = repo.findExercise("Assisted Pull-up");
  statePain("elbow", 9, "Assisted Pull-up", pullup.id, [
    { at: 6, painFree: false },
    { at: 2, painFree: false },
  ]);
  const bodyweight = nextPrescription("Assisted Pull-up");
  assert.equal(bodyweight.action, "hold", "nothing to ease, so the honest answer is a hold");
  assert.equal(bodyweight.pain_protected, undefined, "and nothing claims a cut happened");
  assert.doesNotMatch(bodyweight.why, /comes down|step off|Easing the load/i);
});
