// Elite-training WAVE C — progression-engine changes:
//   C1  autoregulation + acute-recovery GATE the deterministic prescription (a sore
//       joint / high soreness the morning after must not yield an overload)
//   C2  inverted-deload fix (a never-deloaded athlete who's strung many loaded weeks
//       together reads "deload-due", not "accumulation" forever)
//   C5  proactive variety — a long-tenure steady lift reaches the (previously dead)
//       "introduce" action; movement tenure is read from first-logged history
// Deterministic, offline, temp DB (root beforeEach wipes between cases).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";
import { nextPrescription, buildProgressionProposal, movementTenureWeeks } from "../dist/repo/progression.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { bodyweightLadderKey, progressionLineageIds } from "../dist/repo/exercise-canon.js";
import { OUTCOME_FACTS_SCHEMA_VERSION } from "../dist/repo/daily-reconciliation.js";

function reset() {
  for (const t of ["daily_session_outcomes", "daily_session_compositions", "logged_sets", "plan_items", "plan_days", "sessions", "exercises", "bodyweight_log", "program_blocks", "activities", "garmin_activities", "plan_proposals", "profile"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}
function makeExercise(name, { muscle_group = null, mode = "reps" } = {}) {
  repo.upsertExercise({ name, muscle_group, mode });
  return repo.findExercise(name);
}
function planWith(dayNumber, item) {
  return repo.savePlanDay(dayNumber, item.focus || `Day ${dayNumber}`, item.focus || null, [item]);
}
function logSet(name, date, { weight = null, reps = null, rir = null, setNum = 1 } = {}) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, null);
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sess.id, ex.id, setNum, weight, reps, rir);
}

beforeEach(reset);

// ── C1: autoregulation gate ───────────────────────────────────────────────────
test("C1: an earned overload becomes a HOLD the morning after a sore knee — on knee-loading lifts only", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  makeExercise("Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225, focus: "Legs" });
  // Both lifts earned (top of range at RIR 2 over several weeks).
  for (const d of [14, 7, 1]) logSet("Back Squat", isoDaysAgo(d), { weight: 225, reps: 5, rir: 2 });
  for (const d of [10, 3]) logSet("Bench Press", isoDaysAgo(10 - 0), { weight: 185, reps: 5, rir: 2, setNum: d }); // two bench sets, >2d ago

  // Baseline (no feedback): the squat earns its step up.
  assert.equal(nextPrescription("Back Squat").action, "overload", "earned → overload without any recovery signal");

  // A named sore knee on yesterday's session — a joint the squat loads.
  repo.setSessionFeedback(isoDaysAgo(1), { joint_pain: "left knee" });

  const squat = nextPrescription("Back Squat");
  assert.notEqual(squat.action, "overload", "a sore knee holds the knee-loading lift, never overloads it");
  assert.equal(squat.action, "hold");
  assert.equal(squat.autoregulated, true, "flagged as recovery-braked (informational)");
  assert.equal(squat.suggested.weight, 225, "load held, not stepped up");

  // The bench press (chest — the knee doesn't load it) is untouched by the knee flag.
  const bench = nextPrescription("Bench Press");
  assert.equal(bench.action, "overload", "a knee flag does not brake a lift it doesn't load");
  assert.ok(!bench.autoregulated, "bench isn't autoregulated by a knee-only signal");
});

test("C1: high soreness (5) holds any earned overload — a systemic brake", () => {
  makeExercise("Bench Press", { muscle_group: "chest" });
  planWith(1, { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185, focus: "Push" });
  for (const d of [10, 3]) logSet("Bench Press", isoDaysAgo(d), { weight: 185, reps: 5, rir: 2 });
  repo.setSessionFeedback(isoDaysAgo(1), { soreness: 5 });
  const p = nextPrescription("Bench Press");
  assert.equal(p.action, "hold", "soreness 5 holds the load (recovery informs, never a penalty)");
  assert.equal(p.autoregulated, true);
});

test("C1: the one-tap apply proposal is GATED — no overload change lands after a sore joint", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225, focus: "Legs" });
  for (const d of [14, 7, 1]) logSet("Back Squat", isoDaysAgo(d), { weight: 225, reps: 5, rir: 2 });

  // Without feedback the apply proposes the earned step up.
  const before = buildProgressionProposal(1);
  assert.equal(before.ok, true);
  assert.ok(before.proposal.parsed.changes.some((c) => c.exercise === "Back Squat" && c.target_weight > 225), "proposes the overload");

  // With a sore knee flagged, the squat holds → nothing to propose for the day.
  repo.setSessionFeedback(isoDaysAgo(1), { joint_pain: "left knee" });
  const after = buildProgressionProposal(1);
  assert.equal(after.ok, false, "the braked hold is dropped — no overload proposal survives the gate");
});

// ── C2: never-deloaded → deload-due ───────────────────────────────────────────
test("C2: an athlete who has NEVER deloaded but strung many loaded weeks reads 'deload-due'", () => {
  const REF = "2026-05-01";
  const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
  makeExercise("Back Squat", { muscle_group: "quads" });
  // Six consecutive COMPLETED loaded weeks (steady tonnage, no reset) — the exact
  // athlete the old detector left in "accumulation" forever (weeksSince stayed null).
  for (let wk = 1; wk <= 6; wk++) {
    for (const off of [2, 4]) {
      for (let s = 1; s <= 3; s++) logSet("Back Squat", back(wk * 7 + off), { weight: 225, reps: 5, rir: 2, setNum: s });
    }
  }
  const meso = getProgramState(REF).mesocycle;
  assert.equal(meso.weeks_since_deload, null, "there is no prior deload on record");
  assert.equal(meso.phase, "deload-due", "a long unbroken loaded streak is flagged deload-due regardless of history");
  assert.match(meso.note.toLowerCase(), /lighter|reset|recovery week/);
});

// ── C5: proactive variety (introduce) + tenure ───────────────────────────────
test("C5: movementTenureWeeks reads weeks since a lift was first logged", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  logSet("Back Squat", isoDaysAgo(98), { weight: 200, reps: 5, rir: 2 });
  logSet("Back Squat", isoDaysAgo(0), { weight: 205, reps: 5, rir: 2 });
  const wk = movementTenureWeeks("Back Squat");
  assert.ok(wk >= 13 && wk <= 15, `~14 weeks of tenure, got ${wk}`);
});

test("C5: a long-tenure STEADY lift reaches the 'introduce' action with same-pattern options", () => {
  makeExercise("Back Squat", { muscle_group: "quads" });
  planWith(1, { exercise: "Back Squat", sets: 3, rep_low: 8, rep_high: 8, target_weight: 203, focus: "Legs" });
  // ~14 weeks of steady work: a tiny end bump keeps it 'maintaining' (not plateaued,
  // not progressing) so the proactive-variety path — not a measured plateau — fires.
  const plan = [[98, 200], [70, 200], [42, 200], [21, 200], [0, 203]];
  for (const [d, w] of plan) logSet("Back Squat", isoDaysAgo(d), { weight: w, reps: 8, rir: 2 });

  const p = nextPrescription("Back Squat");
  assert.equal(p.action, "introduce", "a steady long-run lift invites a fresh variation before staleness");
  assert.ok(Array.isArray(p.vary_options) && p.vary_options.length > 0, "carries a menu of same-pattern options");
  assert.equal(p.suggested.weight, 203, "load is held — the novelty is the stimulus");

  // And the apply turns that into a real swap change (not a no-op same-lift write).
  const prop = buildProgressionProposal(1);
  assert.equal(prop.ok, true);
  assert.ok(prop.proposal.parsed.changes.some((c) => c.swap && /Back Squat/i.test(c.swap.from)), "introduce → a swap change");
});

// ── Prescriptions follow what the log proves ──────────────────────────────────
// A swap that mints a new row on a bodyweight ladder keeps the lift's history; an
// assist the log no longer needs comes off; a handicapped day that still cleared
// full load counts toward the step; a lighter capped session never steps past the
// card. Synthetic offline fixtures.
function logSession(name, daysAgo, sets) {
  sets.forEach(([weight, reps, rir], i) =>
    logSet(name, isoDaysAgo(daysAgo), { weight, reps, rir: rir ?? null, setNum: i + 1 })
  );
}

function clearOutcomes() {
  db.prepare(`DELETE FROM daily_session_outcomes`).run();
  db.prepare(`DELETE FROM daily_session_compositions`).run();
}

function linkHandicappedDose(name, daysAgo, { reasons, top, relevantSymptom = false, reference = 195 }) {
  const date = isoDaysAgo(daysAgo);
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(date, null);
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(session.id);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Handicap fixture', '[]', ?)`
    )
    .run(session.id, date, `handicap-${session.id}-${Math.random()}`);
  const facts = {
    schema_version: OUTCOME_FACTS_SCHEMA_VERSION,
    skipped: [],
    dose_context: { comparable: false, non_comparable_reasons: reasons },
    dose_evidence: [
      {
        movement_key: `exercise:${ex.id}`,
        exercise: name,
        mode: "reps",
        // The day's card was a reduced one — the athlete did more than it asked.
        prescribed: { sets: 3, rep_low: 5, rep_high: 5, target_weight: 165 },
        achieved: { sets: 3, top_weight: top, top_reps: 10 },
        full_load_reference: {
          sets: null, target_weight: null, target_seconds: null, rep_low: null,
          recent_working_weight: reference, recent_working_seconds: null,
        },
        performed_at_full_load: false,
        challenge_verdict: "exceeded",
        relevant_symptom: relevantSymptom,
        comparable: false,
        non_comparable_reasons: reasons,
      },
    ],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, date, JSON.stringify(facts));
}

test("a swap onto a new bodyweight-ladder row keeps the lift's history — status reads, never 'new'", () => {
  repo.setProfile({ weight_lb: 160 });
  makeExercise("Assisted Pull-Up", { muscle_group: "back" });
  makeExercise("Neutral-Grip Pull-Up", { muscle_group: "back" });
  makeExercise("Wide-Grip Pull-Up", { muscle_group: "back" });
  makeExercise("Lat Pulldown", { muscle_group: "back" });
  for (const [d, w] of [[60, -40], [53, -35], [46, -35], [39, -30], [32, -30]]) logSession("Assisted Pull-Up", d, [[w, 10], [w, 10]]);
  for (const d of [26, 19, 12]) logSession("Neutral-Grip Pull-Up", d, [[null, 9, 2], [null, 9, 2], [null, 8, 1]]);
  // The shape: bodyweight working sets with an assisted finisher on the last day.
  logSession("Neutral-Grip Pull-Up", 5, [[null, 7, 1], [null, 7, 0], [-15, 9, 0]]);
  // A variant trained ALONGSIDE the new row is its own series, not a predecessor.
  logSession("Wide-Grip Pull-Up", 40, [[null, 6]]);
  logSession("Wide-Grip Pull-Up", 3, [[null, 7]]);
  logSession("Lat Pulldown", 20, [[120, 10]]);

  assert.equal(bodyweightLadderKey("Band-Assisted Pull-Up"), "pull up");
  assert.equal(bodyweightLadderKey("Neutral-Grip Pull-Up"), "pull up");
  assert.equal(bodyweightLadderKey("Chin-Up"), "chin up", "a chin-up is its own ladder");
  assert.equal(bodyweightLadderKey("Incline Push-Up"), null, "a named variation keeps its own history");
  assert.equal(bodyweightLadderKey("Lat Pulldown"), null);

  const assisted = repo.findExercise("Assisted Pull-Up").id;
  const neutral = repo.findExercise("Neutral-Grip Pull-Up").id;
  assert.deepEqual(
    progressionLineageIds("Neutral-Grip Pull-Up"),
    [neutral, assisted],
    "own row first, then the row it replaced; the overlapping variant stays out"
  );
  assert.deepEqual(progressionLineageIds("Lat Pulldown"), [repo.findExercise("Lat Pulldown").id], "a loaded lift is only its own row");

  const state = getProgramState().lifts.find((l) => l.exercise === "Neutral-Grip Pull-Up");
  assert.notEqual(state.status, "new", "the assisted weeks are this lift's history");
  assert.ok(state.sessions >= 9, `reads the full ladder, got ${state.sessions} sessions`);
});

test("bodyweight sets at the top of the range retire the assist — never more help than the log needs", () => {
  repo.setProfile({ weight_lb: 160 });
  makeExercise("Neutral-Grip Pull-Up", { muscle_group: "back" });
  planWith(2, { exercise: "Neutral-Grip Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -10, focus: "Pull" });
  logSession("Neutral-Grip Pull-Up", 12, [[null, 9, 2], [null, 9, 2], [null, 9, 0], [null, 6, 0]]);
  logSession("Neutral-Grip Pull-Up", 5, [[null, 9, 2], [null, 9, 0], [null, 9, 0]]);
  // The latest session's assisted finisher is a back-off, not the working rung.
  logSession("Neutral-Grip Pull-Up", 1, [[null, 8, 1], [null, 8, 0], [-15, 9, 0]]);

  const p = nextPrescription("Neutral-Grip Pull-Up", undefined, { autoreg: null, acute: null });
  assert.equal(p.suggested.weight, null, "bodyweight, not the plan's 10 lb assist");
  assert.equal(p.reground, true, "the assist target was behind the log");
  assert.equal(p.current.weight, null);
  assert.doesNotMatch(p.delta_text, /assist/);

  const proposal = buildProgressionProposal(2, { forNextSession: true });
  assert.equal(proposal.ok, true);
  const change = proposal.proposal.parsed.changes.find((c) => c.exercise === "Neutral-Grip Pull-Up");
  assert.ok(change, "the retired assist lands through propose→apply");
  assert.equal(change.target_weight, null, "bodyweight is a null target");
});

test("one unassisted day is a good day, not the rung — the assist stays until two of three sessions show it", () => {
  makeExercise("Assisted Pull-Up", { muscle_group: "back" });
  planWith(2, { exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -25, focus: "Pull" });
  logSession("Assisted Pull-Up", 12, [[-25, 8, 2], [-25, 8, 2], [-25, 8, 2]]);
  logSession("Assisted Pull-Up", 5, [[-25, 8, 2], [-25, 7, 1], [-25, 6, 1]]);
  logSession("Assisted Pull-Up", 1, [[null, 6, 0], [null, 6, 0], [-25, 8, 1]]);
  const p = nextPrescription("Assisted Pull-Up", undefined, { autoreg: null, acute: null });
  assert.ok(p.suggested.weight != null && p.suggested.weight < 0, `still assisted, got ${p.suggested.weight}`);
});

test("a handicapped day that cleared full load counts toward the step; a light or symptomatic one does not", () => {
  makeExercise("Barbell Deadlift", { muscle_group: "hamstrings" });
  planWith(5, { exercise: "Barbell Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 195, focus: "Lower B" });
  logSession("Barbell Deadlift", 20, [[195, 10, 3], [195, 10, 3]]);
  logSession("Barbell Deadlift", 6, [[175, 10, 5], [195, 10, 2], [195, 10, 2]]);
  linkHandicappedDose("Barbell Deadlift", 6, { reasons: ["loaded_endurance"], top: 195 });

  const earned = nextPrescription("Barbell Deadlift", undefined, { autoreg: null, acute: null });
  assert.equal(earned.dose_eligibility.reason, "full_load_through_confound");
  assert.equal(earned.action, "overload", "195 × 10 at RIR 2 after the run is a lower bound, not noise");
  assert.ok(earned.suggested.weight > 195 && earned.suggested.weight <= 200, `a small step, got ${earned.suggested.weight}`);

  // A movement-relevant symptom keeps full authority.
  clearOutcomes();
  linkHandicappedDose("Barbell Deadlift", 6, { reasons: ["loaded_endurance"], top: 195, relevantSymptom: true });
  const symptom = nextPrescription("Barbell Deadlift", undefined, { autoreg: null, acute: null });
  assert.equal(symptom.dose_eligibility.reason, "non_comparable");
  assert.equal(symptom.suggested.weight, 195);

  // Illness is not a handicap this rule forgives.
  clearOutcomes();
  linkHandicappedDose("Barbell Deadlift", 6, { reasons: ["loaded_endurance", "illness"], top: 195 });
  assert.equal(
    nextPrescription("Barbell Deadlift", undefined, { autoreg: null, acute: null }).dose_eligibility.reason,
    "non_comparable"
  );

  // Under the lift's own recent working weight, the confound still explains it.
  clearOutcomes();
  linkHandicappedDose("Barbell Deadlift", 6, { reasons: ["loaded_endurance"], top: 195, reference: 205 });
  assert.equal(
    nextPrescription("Barbell Deadlift", undefined, { autoreg: null, acute: null }).dose_eligibility.reason,
    "non_comparable"
  );
});

test("a range capped at a lighter load than the card proves the lighter load — no step past the card", () => {
  makeExercise("Pendlay Row", { muscle_group: "back" });
  planWith(2, { exercise: "Pendlay Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 140, focus: "Pull" });
  logSession("Pendlay Row", 20, [[135, 10, 2], [135, 10, 2], [135, 10, 2]]);
  logSession("Pendlay Row", 13, [[135, 10, 2], [135, 10, 2], [135, 10, 2]]);
  logSession("Pendlay Row", 1, [[125, 10, 2], [125, 10, 2], [125, 10, 2]]);
  const p = nextPrescription("Pendlay Row", undefined, { autoreg: null, acute: null });
  assert.equal(p.suggested.weight, 140, "140 is the next load to own — 145 is a number nothing logged has touched");
  assert.equal(p.action, "hold");

  // The same capped session AT the card's load still earns the step.
  db.prepare(`DELETE FROM logged_sets`).run();
  logSession("Pendlay Row", 13, [[140, 10, 2], [140, 10, 2], [140, 10, 2]]);
  logSession("Pendlay Row", 1, [[140, 10, 2], [140, 10, 2], [140, 10, 2]]);
  const stepped = nextPrescription("Pendlay Row", undefined, { autoreg: null, acute: null });
  assert.equal(stepped.action, "overload");
  assert.ok(stepped.suggested.weight > 140);
});
