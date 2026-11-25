// Earned load lands, and a steady lift is never stranded on `top_set_earned`
// (src/repo/progression.ts). Invariants under test:
//   - every step the engine EARNS and the plan can carry is in the auto-progression
//     draft: a load step, less assist, a seconds step, a rep-range move; a rep step
//     inside the range is not a plan change, and a bodyweight "step" is no longer a
//     null-onto-null no-op;
//   - a step earned in a session with no plan day still lands at the lift's plan
//     day's next proposal;
//   - a capped bodyweight range moves up ONCE (the rep-range move), never a set;
//   - steady drive: two near-capped `top_set_earned` exposures in a row take ONE load
//     step from the worked load; one does not, and a set two reps short does not;
//     every existing veto still wins; fast_loss and a soft fuel hold do not veto;
//     an Undo is remembered until a newer prescription has been trained;
//   - assisted work steps by LESS assist;
//   - after a recovery week the card picks up at the pre-week load and progression
//     resumes on the next full exposure.
// Deterministic, offline, temp DB (test/run.mjs wipes it before every test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo } from "./_seed.js";
import { buildProgressionProposal, nextPrescription, planDayProgression } from "../dist/repo/progression.js";
import * as voice from "../dist/repo/progression-voice.js";
import { progressionVoicePhrases } from "../dist/repo/progression-voice.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import * as blocks from "../dist/repo/program-blocks.js";
import { buildProgressionWithAutonomy, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { lastAppliedRepRangeMove } from "../dist/repo/lift-response.js";
import { RECOVERY_WEEK_APPLIED_KEY, RECOVERY_WEEK_INSTRUCTION_PREFIX } from "../dist/repo/recovery-week-ledger.js";
import { sessionCountsTowardLiftTrajectory } from "../dist/repo/lift-comparability.js";

const isoDaysAgo = (n) => localDaysAgo(n);

function makeExercise(name, { muscle_group = null, mode = "reps" } = {}) {
  repo.upsertExercise({ name, muscle_group, mode });
  return repo.findExercise(name);
}

// One plan day carrying `items`, authored long ago (an established prescription).
function planDay(dayNumber, items, prescribedDaysAgo = 90) {
  const day = repo.savePlanDay(dayNumber, `Day ${dayNumber}`, null, items);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(
    isoDaysAgo(prescribedDaysAgo),
    day.id
  );
  return day;
}

// One session's sets for one lift: `reps` is one entry per set.
function logSession(name, date, { weight = null, reps, rir = null, planDayId = null, duration = null }) {
  const ex = repo.findExercise(name);
  const sess = repo.getOrCreateSession(date, planDayId);
  reps.forEach((r, i) =>
    db
      .prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sess.id, ex.id, i + 1, weight, duration == null ? r : null, rir, duration)
  );
  return sess;
}

const cut = (over = {}) => ({
  hold: false,
  reduce: false,
  sliding: false,
  fast_loss: false,
  deep: false,
  any: false,
  near_goal: false,
  ...over,
});

// The quiet read: no fresh feedback, no acute saturation, steady drive.
const QUIET = { autoreg: null, acute: null, drive: "steady", pushStance: false };

// ---- the steady top_set_earned fixture ------------------------------------------
// Bench 3 × 6–8 @ 140. Each listed session: the top set caps the range and the back-off
// lands `backoff` reps; no RIR logged (capping the range IS the signal).
function steadyBench(sessions = [[10, 7], [4, 7]]) {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planDay(1, [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 }]);
  for (const [daysAgo, backoff] of sessions)
    logSession("Barbell Bench Press", isoDaysAgo(daysAgo), { weight: 140, reps: [8, 8, backoff] });
}

test("steady: two near-capped top_set_earned exposures take ONE step from the worked load", () => {
  steadyBench();
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145, "one ordinary step off the 140 worked");
  assert.equal(p.earned_by, "repeated_top_set");
  assert.equal(p.top_set_earned, undefined, "a step taken is no longer a hold");
  assert.ok(voice.REPEATED_TOP_SET_OVERLOAD.map((fn) => fn(8, 6)).includes(p.why), p.why);
  assert.equal(p.suggested.rep_low, 6);
  assert.equal(p.suggested.sets, 3, "never a set: the count is the plan's");
});

test("steady: ONE near-capped exposure still holds as top_set_earned", () => {
  steadyBench([[10, 6], [4, 7]]); // the earlier back-off was two reps short
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.suggested.weight, 140);
  assert.deepEqual(p.top_set_earned, { weight: 140 });
  assert.equal(p.earned_by, undefined);
});

test("steady: a back-off two reps short holds, however often it repeats", () => {
  steadyBench([[10, 6], [4, 6]]);
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.suggested.weight, 140);
});

test("steady: the card's full set count is part of the answer — a missing set holds", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planDay(1, [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 }]);
  logSession("Barbell Bench Press", isoDaysAgo(10), { weight: 140, reps: [8, 7] });
  logSession("Barbell Bench Press", isoDaysAgo(4), { weight: 140, reps: [8, 8, 7] });
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.notEqual(p.earned_by, "repeated_top_set", p.why);
  assert.equal(p.suggested.weight, 140);
});

test("steady: a logged grind on a top set is not strong — the pair holds", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  planDay(1, [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 }]);
  logSession("Barbell Bench Press", isoDaysAgo(10), { weight: 140, reps: [8, 8, 7], rir: 0 });
  logSession("Barbell Bench Press", isoDaysAgo(4), { weight: 140, reps: [8, 8, 7], rir: 2 });
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.notEqual(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 140);
});

for (const [label, pressure] of [
  ["a sliding cut", cut({ sliding: true, deep: true, any: true })],
  ["a reduce away from goal", cut({ reduce: true, any: true })],
]) {
  test(`the repetition step yields to ${label}`, () => {
    steadyBench();
    const p = nextPrescription("Barbell Bench Press", undefined, { ...QUIET, cut: pressure });
    assert.equal(p.action, "hold", p.why);
    assert.equal(p.suggested.weight, 140);
    assert.equal(p.earned_by, undefined);
  });
}

for (const [label, pressure] of [
  ["fast_loss", cut({ fast_loss: true, deep: true, any: true })],
  ["a soft fuel hold", cut({ hold: true, any: true })],
  ["a reduce at the goal", cut({ reduce: true, any: true, near_goal: true })],
]) {
  test(`${label} does not veto the repetition step`, () => {
    steadyBench();
    const p = nextPrescription("Barbell Bench Press", undefined, { ...QUIET, cut: pressure });
    assert.equal(p.action, "overload", p.why);
    assert.equal(p.suggested.weight, 145);
  });
}

test("an untested slot holds at the plan, whatever the pair says", () => {
  steadyBench();
  // Rewritten after the last session: nothing has been trained at it yet.
  db.prepare(`UPDATE plan_items SET target_weight = 142.5, prescribed_at = ?`).run(new Date().toISOString());
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.suggested.weight, 142.5);
  assert.equal(p.untested, true);
});

test("a holds-load phase (a scheduled deload week, steady) wins", () => {
  steadyBench();
  blocks.createBlock({ goal: "Ease", focus: "strength", total_weeks: 6, week_index: 6 });
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.suggested.weight, 140);
  assert.equal(p.earned_by, undefined);
});

test("the autoregulation brake wins over the repetition step", () => {
  steadyBench();
  const p = nextPrescription("Barbell Bench Press", undefined, {
    ...QUIET,
    autoreg: {
      soreness: 5,
      performance: null,
      joint_pain: null,
      date: isoDaysAgo(0),
      soreness_groups: ["chest"],
      performance_groups: [],
    },
  });
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.suggested.weight, 140);
  assert.ok(p.autoregulated);
  assert.equal(p.earned_by, undefined);
});

test("the pain brake wins over the repetition step", () => {
  steadyBench();
  const bench = repo.findExercise("Barbell Bench Press");
  const event = repo.reportTrainingSymptom({ area_text: "left shoulder", onset_on: isoDaysAgo(6) });
  repo.recordMovementTolerance({
    symptom_event_id: event.id,
    movement: "Barbell Bench Press",
    exercise_id: bench.id,
    observed_on: isoDaysAgo(2),
    pain_free: false,
  });
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.ok(["hold", "deload"].includes(p.action), p.why);
  assert.ok(p.suggested.weight <= 140, "a pain band never lets the step through");
  assert.ok(p.autoregulated);
});

test("a pair stale past the rotation window does not count as repetition", () => {
  steadyBench([[40, 7], [4, 7]]);
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.notEqual(p.earned_by, "repeated_top_set", p.why);
  assert.equal(p.suggested.weight, 140);
});

test("assisted work: the repetition step is LESS assist, never a flip", () => {
  makeExercise("Assisted Pull-Up", { muscle_group: "back" });
  planDay(1, [{ exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -40 }]);
  for (const d of [10, 4]) logSession("Assisted Pull-Up", isoDaysAgo(d), { weight: -40, reps: [8, 8, 7] });
  const p = nextPrescription("Assisted Pull-Up", undefined, QUIET);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.earned_by, "repeated_top_set", `${p.action} ${p.why} ${JSON.stringify(p)}`);
  assert.ok(p.suggested.weight > -40 && p.suggested.weight < 0, `less assist, still assisted (${p.suggested.weight})`);
  assert.match(p.delta_text, /assist/);
});

test("the repetition step lands through the ordinary draft with its own audit marker", () => {
  steadyBench();
  const built = buildProgressionProposal(1, { forNextSession: true });
  assert.equal(built.ok, true, built.error);
  const change = built.proposal.parsed.changes.find((c) => c.exercise === "Barbell Bench Press");
  assert.equal(change.target_weight, 145);
  assert.equal(change.sets, 3);
  assert.equal(change.progression_rule, "repeated_top_set");
});

test("Undo is a remembered no: blocked until a newer prescription has been trained", () => {
  steadyBench();
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.autonomy.tier, "quiet_apply", JSON.stringify(out.autonomy));
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 145, "lead quiet-applies the step");
  const undone = revertDecision(out.autonomy.decision.id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 140, "Undo restored the load");

  // The same two sessions, the restored (older) prescription: the athlete's no stands.
  let p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.notEqual(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 140);
  const again = buildProgressionProposal(1, { forNextSession: true });
  const change = again.ok ? again.proposal.parsed.changes.find((c) => c.exercise === "Barbell Bench Press") : undefined;
  assert.equal(change, undefined, "no re-proposal of the vetoed step");

  // Later: a newer prescription stands (written after the vetoed change) and two
  // sessions have been trained at it — the rule may answer again.
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE agent = 'auto-progression'`).run(`${isoDaysAgo(20)} 12:00:00`);
  p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.notEqual(p.action, "overload", "an older stamp still reads the veto");
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(isoDaysAgo(12));
  p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145);
});

test("a coarse isolation step answers with the rep-range move, once, instead of the load", () => {
  makeExercise("Rope Pushdown", { muscle_group: "triceps" });
  planDay(1, [{ exercise: "Rope Pushdown", sets: 3, rep_low: 12, rep_high: 15, target_weight: 57.5 }]);
  for (const d of [10, 4]) logSession("Rope Pushdown", isoDaysAgo(d), { weight: 57.5, reps: [15, 15, 14] });
  const p = nextPrescription("Rope Pushdown", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.escalated, "rep_range");
  assert.equal(p.suggested.weight, 57.5, "the load holds");
  assert.equal(p.suggested.rep_low, 15);
  assert.equal(p.suggested.rep_high, 18);
  assert.ok(voice.REPEATED_TOP_SET_REP_RANGE.includes(p.why), p.why);
});

// ---- Part A: earned steps land --------------------------------------------------

test("every earned step the plan can carry is in the finish-time draft", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  makeExercise("Assisted Dip", { muscle_group: "triceps" });
  makeExercise("Front Plank", { muscle_group: "core", mode: "timed" });
  makeExercise("Tibialis Raise", { muscle_group: "calves" });
  planDay(1, [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 },
    { exercise: "Assisted Dip", sets: 3, rep_low: 6, rep_high: 8, target_weight: -40 },
    { exercise: "Front Plank", sets: 3, target_seconds: 30 },
    { exercise: "Tibialis Raise", sets: 2, rep_low: 12, rep_high: 15, target_weight: 25 },
  ]);
  logSession("Barbell Bench Press", isoDaysAgo(3), { weight: 140, reps: [8, 8, 8] });
  logSession("Assisted Dip", isoDaysAgo(3), { weight: -40, reps: [8, 8, 8] });
  logSession("Front Plank", isoDaysAgo(3), { reps: [0, 0, 0], duration: 35 });
  logSession("Tibialis Raise", isoDaysAgo(3), { weight: 25, reps: [13, 12] });

  const rx = new Map(planDayProgression(1, { forNextSession: true }).map((p) => [p.exercise, p]));
  assert.equal(rx.get("Barbell Bench Press").action, "overload");
  assert.equal(rx.get("Assisted Dip").action, "overload");
  assert.equal(rx.get("Front Plank").action, "overload");
  assert.equal(rx.get("Tibialis Raise").rep_step, true, "a rep inside the range is the card's own ask");

  const built = buildProgressionProposal(1, { forNextSession: true });
  assert.equal(built.ok, true, built.error);
  const byName = new Map(built.proposal.parsed.changes.map((c) => [c.exercise, c]));
  assert.equal(byName.get("Barbell Bench Press").target_weight, 145, "the load step lands");
  const dip = byName.get("Assisted Dip").target_weight;
  assert.ok(dip > -40 && dip < 0, `less assist lands (${dip})`);
  assert.ok(byName.get("Front Plank").target_seconds > 30, "the seconds step lands");
  assert.equal(byName.has("Tibialis Raise"), false, "a rep step is not a plan change: the range already says it");
});

test("a step earned in a session with no plan day lands at that plan day's next proposal", () => {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  makeExercise("Cable Row", { muscle_group: "back" });
  const day = planDay(1, [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 },
    { exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 100 },
  ]);
  // An off-plan session (plan_day_id NULL) capped the bench.
  const offPlan = logSession("Barbell Bench Press", isoDaysAgo(6), { weight: 140, reps: [8, 8, 8] });
  assert.equal(repo.getSessionDetail(offPlan.id).plan_day_id ?? null, null);
  // The next time day 1 itself is finished (its own session logs only the row), the
  // day's draft carries the bench step the off-plan session earned.
  logSession("Cable Row", isoDaysAgo(2), { weight: 100, reps: [9, 9, 9], planDayId: day.id });
  const built = buildProgressionProposal(1, { forNextSession: true });
  assert.equal(built.ok, true, built.error);
  const bench = built.proposal.parsed.changes.find((c) => c.exercise === "Barbell Bench Press");
  assert.equal(bench?.target_weight, 145, "the off-plan step is not lost");
});

test("a capped bodyweight range moves up ONCE, through the draft, and never adds a set", () => {
  makeExercise("Dead Bug", { muscle_group: "core" });
  planDay(1, [{ exercise: "Dead Bug", sets: 3, rep_low: 8, rep_high: 12 }]);
  logSession("Dead Bug", isoDaysAgo(3), { reps: [12, 12, 12] });
  const p = nextPrescription("Dead Bug", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.escalated, "rep_range");
  assert.equal(p.suggested.rep_low, 11);
  assert.equal(p.suggested.rep_high, 15);
  assert.equal(p.suggested.sets, 3, "never another set");
  assert.equal(p.suggested.weight, null);
  assert.ok(voice.BODYWEIGHT_REP_RANGE_EARNED.includes(p.why), p.why);

  repo.setSettings({ lead_mode: "lead" });
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true, out.error);
  const change = out.proposal.parsed.changes.find((c) => c.exercise === "Dead Bug");
  assert.equal(change.progression_escalation, "rep_range");
  assert.equal(change.target_weight, null);
  assert.equal(out.autonomy.tier, "quiet_apply");
  const item = repo.getPlanDay(1).items[0];
  assert.equal(item.rep_low, 11);
  assert.equal(item.rep_high, 15);
  assert.equal(item.sets, 3);
  assert.ok(lastAppliedRepRangeMove("Dead Bug"), "the move is on the ledger");

  // Trained at the higher range and capped again: the move is spent — the card holds,
  // names the next lever, and the draft carries no no-op for it.
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(isoDaysAgo(2));
  db.prepare(`UPDATE plan_proposals SET created_at = ?`).run(`${isoDaysAgo(2)} 08:00:00`);
  logSession("Dead Bug", isoDaysAgo(1), { reps: [15, 15, 15] });
  const spent = nextPrescription("Dead Bug", undefined, QUIET);
  assert.equal(spent.action, "hold", spent.why);
  assert.equal(spent.escalated, undefined);
  assert.equal(spent.suggested.rep_low, 11);
  assert.equal(spent.suggested.sets, 3);
  assert.ok(voice.BODYWEIGHT_RANGE_OWNED_HOLD.includes(spent.why), spent.why);
  assert.deepEqual(spent.top_set_earned, { weight: null }, "a push day may still seat its reach here");
  const built = buildProgressionProposal(1, { forNextSession: true });
  const noop = built.ok ? built.proposal.parsed.changes.find((c) => c.exercise === "Dead Bug") : undefined;
  assert.equal(noop, undefined, "no null-onto-null change is drafted");
});

test("a bodyweight range move the athlete undid is not re-proposed", () => {
  makeExercise("Dead Bug", { muscle_group: "core" });
  planDay(1, [{ exercise: "Dead Bug", sets: 3, rep_low: 8, rep_high: 12 }]);
  logSession("Dead Bug", isoDaysAgo(3), { reps: [12, 12, 12] });
  repo.setSettings({ lead_mode: "lead" });
  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.autonomy.tier, "quiet_apply");
  assert.equal(revertDecision(out.autonomy.decision.id).ok, true);
  assert.equal(repo.getPlanDay(1).items[0].rep_low, 8, "Undo restored the range");
  const p = nextPrescription("Dead Bug", undefined, QUIET);
  assert.notEqual(p.escalated, "rep_range", p.why);
  assert.equal(p.action, "hold");
});

// ---- Part C: after a recovery week ------------------------------------------------

// The recovery week as stream 1 lands it: the plan's targets untouched, the week's
// prescription (half the sets, the load eased about a tenth) on the applied recovery
// proposal the ledger owns, and the week's sessions logged against it.
function recoveryWeek({ appliedDaysAgo, planDayId }) {
  const proposal = db
    .prepare(
      `INSERT INTO plan_proposals (created_at, agent, instruction, raw_output, parsed_json, status)
       VALUES (?, 'recovery-week', ?, '', ?, 'applied')`
    )
    .run(
      `${isoDaysAgo(appliedDaysAgo)} 07:00:00`,
      `${RECOVERY_WEEK_INSTRUCTION_PREFIX} week.`,
      JSON.stringify({
        days: [
          {
            day_number: 1,
            items: [{ exercise: "Barbell Bench Press", sets: 2, rep_low: 6, rep_high: 8, target_weight: 125 }],
          },
        ],
      })
    );
  db.prepare(`INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now', '-1 minute'))`).run(
    RECOVERY_WEEK_APPLIED_KEY,
    JSON.stringify({ applied_on: isoDaysAgo(appliedDaysAgo), proposal_id: Number(proposal.lastInsertRowid) })
  );
  return planDayId;
}

function preWeekBench() {
  makeExercise("Barbell Bench Press", { muscle_group: "chest" });
  const day = planDay(1, [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 }]);
  // Pre-week: the top set capped, a back-off one short — held at 140.
  for (const d of [24, 20])
    logSession("Barbell Bench Press", isoDaysAgo(d), { weight: 140, reps: [8, 8, 7], planDayId: day.id });
  recoveryWeek({ appliedDaysAgo: 16, planDayId: day.id });
  // The week itself: two compliant sessions, half the sets at the eased load, easy.
  const inWeek = [14, 11].map((d) =>
    logSession("Barbell Bench Press", isoDaysAgo(d), { weight: 125, reps: [8, 8], rir: 4, planDayId: day.id })
  );
  return { day, inWeek };
}

test("after a recovery week the first card is the pre-week load: no step, no cut, no untested hold", () => {
  const { inWeek } = preWeekBench();
  for (const s of inWeek)
    assert.equal(sessionCountsTowardLiftTrajectory(s.id), false, "the week's sessions are not a test of the lift");
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.suggested.weight, 140, "the pre-week load, not the eased one");
  assert.equal(p.suggested.sets, 3, "the plan's sets");
  assert.equal(p.untested, undefined, "the week did not make the slot a fresh prescription");
  assert.equal(p.earned_by, undefined);
  assert.ok(voice.RECOVERY_WEEK_RESUME_HOLD.includes(p.why), p.why);
  // …and the finish of a recovery session never writes a step into the plan.
  const built = buildProgressionProposal(1, { forNextSession: true });
  const change = built.ok ? built.proposal.parsed.changes.find((c) => c.exercise === "Barbell Bench Press") : undefined;
  assert.equal(change, undefined, "nothing drafted off the week's lighter work");
});

test("after a recovery week a full exposure that caps the range resumes progression", () => {
  const { day } = preWeekBench();
  logSession("Barbell Bench Press", isoDaysAgo(3), { weight: 140, reps: [8, 8, 8], planDayId: day.id });
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145);
});

test("the repetition pair steps OVER the recovery week, never onto it", () => {
  const { day } = preWeekBench();
  // The first full session back repeats the pre-week shape: with the week's sessions
  // set aside, the pair is the last pre-week exposure and this one.
  logSession("Barbell Bench Press", isoDaysAgo(3), { weight: 140, reps: [8, 8, 7], planDayId: day.id });
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.earned_by, "repeated_top_set");
  assert.equal(p.suggested.weight, 145, "from the worked 140, never the week's 125");
});

// ---- the vocabulary ---------------------------------------------------------------

test("the new phrasings hold the reading grammar and name no score", () => {
  const added = [
    ...voice.REPEATED_TOP_SET_OVERLOAD.map((fn) => fn(8, 6)),
    ...voice.REPEATED_TOP_SET_ASSIST_PEEL.map((fn) => fn(8)),
    ...voice.REPEATED_TOP_SET_REP_RANGE,
    ...voice.BODYWEIGHT_REP_RANGE_EARNED,
    ...voice.BODYWEIGHT_RANGE_OWNED_HOLD,
    ...voice.RECOVERY_WEEK_RESUME_HOLD,
  ];
  const all = new Set(progressionVoicePhrases());
  for (const line of added) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.ok(all.has(line), `registered in progressionVoicePhrases: ${line}`);
    assert.doesNotMatch(line, /\bRIR\b|another set|add a set/i, line);
    assert.doesNotMatch(line, /\b(linked|dose|comparable|evidence|exposure)\b/i, line);
  }
});

// A failed attempt at more is evidence against the step: a working set ABOVE the card's
// load that fell under the rep floor. The working load never sees it (it reads only sets
// that reached the floor), so the pair is rejected on it directly.
function addSet(name, sessionId, weight, reps) {
  const ex = repo.findExercise(name);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE session_id = ?`).get(sessionId).n;
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, ex.id, Number(n) + 1, weight, reps, null);
}

for (const [label, daysAgo] of [
  ["the latest", 4],
  ["the earlier", 10],
]) {
  test(`a failed attempt at the next load in ${label} exposure blocks the repetition step`, () => {
    steadyBench();
    const session = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(isoDaysAgo(daysAgo));
    addSet("Barbell Bench Press", session.id, 145, 4); // tried 145, under the 6-rep floor
    const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
    assert.notEqual(p.earned_by, "repeated_top_set", p.why);
    assert.notEqual(p.suggested.weight, 145, p.why);
  });
}

test("a heavier set that REACHED the floor is not a failed attempt (the working load reads it)", () => {
  steadyBench();
  const session = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(isoDaysAgo(4));
  addSet("Barbell Bench Press", session.id, 135, 5); // lighter and short: a back-off, not an attempt
  const p = nextPrescription("Barbell Bench Press", undefined, QUIET);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145);
});

test("push drive: a back-off a rep short across two exposures steps (one ordinary step off the worked load)", () => {
  steadyBench();
  const p = nextPrescription("Barbell Bench Press", undefined, { ...QUIET, drive: "push" });
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145, "one ordinary step off the 140 worked");
});
