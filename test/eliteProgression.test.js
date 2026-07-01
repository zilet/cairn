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

function reset() {
  for (const t of ["logged_sets", "plan_items", "plan_days", "sessions", "exercises", "bodyweight_log", "program_blocks", "activities", "garmin_activities", "plan_proposals", "profile"]) {
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
  assert.match(meso.note.toLowerCase(), /deload/);
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
