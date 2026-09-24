import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProposalWithAutonomy, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { prepareDailySessionUseCase } from "../dist/domain/training/adaptive-session-use-case.js";
import { replacePlanByPerson, savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import { db, repo } from "./_seed.js";

const DATE = "2031-04-14";

const BENCH = { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 };
const ROW = { exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 40 };
const SQUAT = { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 };

function seedPlan() {
  repo.savePlanDay(1, "Upper", "Chest and back", [BENCH, ROW]);
  repo.savePlanDay(2, "Lower", "Legs", [SQUAT]);
}

// The brain's own quiet step on both day-1 lifts, landed through the one autonomy path.
function quietApplyStep() {
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "progression", "", {
    summary: "Auto-progression for day 1 — 2 lifts",
    changes: [
      {
        day_number: 1,
        exercise: BENCH.exercise,
        target_weight: 120,
        reason: "Every set capped the range — add the step.",
      },
      { day_number: 1, exercise: ROW.exercise, target_weight: 45, reason: "Setting it at what you actually lift." },
    ],
  });
  const applied = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);
  assert.equal(applied.tier, "quiet_apply");
  return applied.decision.id;
}

const item = (day, name) => repo.getPlanDay(day).items.find((it) => it.exercise === name);

test("a person's day save drops the brain's note from the lift it rewrote, and only that lift", () => {
  seedPlan();
  const decisionId = quietApplyStep();
  assert.equal(item(1, BENCH.exercise).brain_decision_id, decisionId, "precondition: the step is annotated");
  assert.match(item(1, BENCH.exercise).brain_change_reason, /add the step/);

  const saved = savePlanDayByPerson(1, "Upper", "Chest and back", [
    { ...BENCH, target_weight: 110 },
    { ...ROW, target_weight: 45 },
  ]);
  const bench = saved.day.items.find((it) => it.exercise === BENCH.exercise);
  assert.equal(bench.target_weight, 110);
  assert.equal(bench.brain_decision_id, undefined, "the returned day carries no stale claim");
  assert.equal(bench.brain_change_reason, undefined);
  assert.equal(bench.brain_change_before, undefined);
  assert.equal(item(1, BENCH.exercise).brain_change_summary, undefined, "nor does a later read");
  assert.equal(
    item(1, ROW.exercise).brain_decision_id,
    decisionId,
    "a lift saved back exactly as the brain left it keeps its note"
  );
  assert.equal(repo.getBrainDecision(decisionId).status, "applied", "the ledger row is not rewritten");
  assert.equal(repo.getBrainDecision(decisionId).reversible, true, "the decision still owns the row step");

  // Undo puts back only what is still the decision's: the row, never the athlete's bench.
  const reverted = revertDecision(decisionId, "undo");
  assert.equal(reverted.ok, true);
  assert.equal(item(1, BENCH.exercise).target_weight, 110, "the athlete's own value stands");
  assert.equal(item(1, ROW.exercise).target_weight, 40, "the decision's own change is undone");
});

test("a whole-plan save releases only the lifts it changed; an untouched lift keeps its note and Undo", () => {
  seedPlan();
  const decisionId = quietApplyStep();

  // The editor sends the whole week. The bench stays exactly where the brain put it;
  // only the row is the athlete's new number.
  const result = replacePlanByPerson([
    {
      day_number: 1,
      name: "Upper",
      focus: "Chest and back",
      items: [
        { ...BENCH, target_weight: 120 },
        { ...ROW, target_weight: 50 },
      ],
    },
    { day_number: 2, name: "Lower", focus: "Legs", items: [SQUAT] },
  ]);
  const day1 = result.plan.find((day) => day.day_number === 1);
  const bench = day1.items.find((it) => it.exercise === BENCH.exercise);
  const row = day1.items.find((it) => it.exercise === ROW.exercise);
  assert.equal(bench.brain_decision_id, decisionId, "the untouched lift keeps its note");
  assert.match(bench.brain_change_reason, /add the step/);
  assert.equal(row.brain_decision_id, undefined, "the lift the athlete rewrote carries no stale claim");

  const decision = repo.getBrainDecision(decisionId);
  assert.equal(decision.status, "applied");
  assert.equal(decision.reversible, true, "Undo stays for what is still the decision's");
  assert.deepEqual(decision.context.person_superseded.keys, [`1|${ROW.exercise.toLowerCase()}`]);

  const reverted = revertDecision(decisionId, "undo");
  assert.equal(reverted.ok, true);
  assert.equal(item(1, BENCH.exercise).target_weight, 115, "the decision's own step is undone");
  assert.equal(item(1, ROW.exercise).target_weight, 50, "the athlete's own value stands");
});

test("a whole-plan save that takes over every recorded lift retires Undo and its per-lift expectations", () => {
  seedPlan();
  const decisionId = quietApplyStep();
  const liftWindows = () =>
    db
      .prepare(
        `SELECT status FROM brain_expectations WHERE decision_id = ? AND subject_key IS NOT NULL
            AND LOWER(subject_key) IN (?, ?)`
      )
      .all(decisionId, BENCH.exercise.toLowerCase(), ROW.exercise.toLowerCase())
      .map((row) => row.status);
  const sessionWindows = () =>
    db
      .prepare(`SELECT status FROM brain_expectations WHERE decision_id = ? AND subject_key IS NULL`)
      .all(decisionId)
      .map((row) => row.status);
  const sessionBefore = sessionWindows();

  replacePlanByPerson([
    {
      day_number: 1,
      name: "Upper",
      focus: "Chest and back",
      items: [
        { ...BENCH, target_weight: 110 },
        { ...ROW, target_weight: 50 },
      ],
    },
    { day_number: 2, name: "Lower", focus: "Legs", items: [SQUAT] },
  ]);
  const decision = repo.getBrainDecision(decisionId);
  assert.equal(decision.status, "applied");
  assert.equal(decision.reversible, false, "nothing recorded is the decision's any more");
  assert.equal(revertDecision(decisionId, "undo").ok, false, "Undo never runs over the athlete's own plan");
  assert.equal(item(1, BENCH.exercise).target_weight, 110);
  assert.equal(item(1, ROW.exercise).target_weight, 50);
  assert.ok(liftWindows().length > 0, "precondition: the step opened per-lift windows");
  for (const status of liftWindows()) {
    assert.equal(status, "superseded", "the brain is never graded on a prescription the athlete wrote");
  }
  assert.deepEqual(sessionWindows(), sessionBefore, "session-wide windows are left alone");
});

test("a day save keeps Undo even when every recorded lift was taken over", () => {
  seedPlan();
  const decisionId = quietApplyStep();
  savePlanDayByPerson(1, "Upper", "Chest and back", [
    { ...BENCH, target_weight: 110 },
    { ...ROW, target_weight: 50 },
  ]);
  assert.equal(repo.getBrainDecision(decisionId).reversible, true);
  assert.equal(revertDecision(decisionId, "undo").ok, true);
  assert.equal(item(1, BENCH.exercise).target_weight, 110, "a released lift is never walked back");
  assert.equal(item(1, ROW.exercise).target_weight, 50);
});

test("a newer brain step after a person's save annotates again", () => {
  seedPlan();
  quietApplyStep();
  savePlanDayByPerson(1, "Upper", "Chest and back", [{ ...BENCH, target_weight: 110 }, ROW]);
  const proposal = repo.createProposal("stub", "progression", "", {
    summary: "Auto-progression for day 1 — 1 lift",
    changes: [{ day_number: 1, exercise: BENCH.exercise, target_weight: 115, reason: "Back to the earned step." }],
  });
  const applied = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);
  assert.equal(item(1, BENCH.exercise).brain_decision_id, applied.decision.id);
  assert.match(item(1, BENCH.exercise).brain_change_reason, /earned step/);
});

test("a person's day save re-takes today's unstarted plan session", () => {
  seedPlan();
  prepareDailySessionUseCase({ date: DATE, source: "manual_plan", day_number: 1 });
  const before = repo.getActiveDailySession(DATE);
  assert.equal(before.items.find((it) => it.exercise === BENCH.exercise).target_weight, 115);

  savePlanDayByPerson(1, "Upper", "Chest and back", [{ ...BENCH, target_weight: 105 }, ROW], { date: DATE });
  const after = repo.getActiveDailySession(DATE);
  assert.notEqual(Number(after.id), Number(before.id), "a new version supersedes the stale snapshot");
  assert.equal(Number(after.session_id), Number(before.session_id));
  assert.equal(after.items.find((it) => it.exercise === BENCH.exercise).target_weight, 105);
});

test("a save that leaves today's day's items alone never re-takes today's session", () => {
  seedPlan();
  prepareDailySessionUseCase({ date: DATE, source: "manual_plan", day_number: 1 });
  const before = repo.getActiveDailySession(DATE);

  savePlanDayByPerson(1, "Upper, renamed", "Chest and back", [BENCH, ROW], { date: DATE });
  assert.equal(Number(repo.getActiveDailySession(DATE).id), Number(before.id), "a rename re-takes nothing");

  replacePlanByPerson(
    [
      { day_number: 1, name: "Upper, renamed", focus: "Chest and back", items: [BENCH, ROW] },
      { day_number: 2, name: "Lower", focus: "Legs", items: [{ ...SQUAT, target_weight: 195 }] },
    ],
    { date: DATE }
  );
  assert.equal(Number(repo.getActiveDailySession(DATE).id), Number(before.id), "another day's change re-takes nothing");
});

test("a whole-plan save that removes today's day retires its unstarted snapshot", () => {
  seedPlan();
  prepareDailySessionUseCase({ date: DATE, source: "manual_plan", day_number: 2 });
  assert.ok(repo.getActiveDailySession(DATE));

  replacePlanByPerson([{ day_number: 1, name: "Upper", focus: "Chest and back", items: [BENCH, ROW] }], {
    date: DATE,
  });
  assert.equal(repo.getActiveDailySession(DATE), null, "the next Today read composes from the saved plan");
});

test("a person's plan save never rewrites a session the athlete composed or already lifted in", () => {
  seedPlan();
  prepareDailySessionUseCase({
    date: DATE,
    source: "athlete_override",
    session: {
      name: "My own",
      focus: "Whatever",
      items: [{ exercise: BENCH.exercise, sets: 2, rep_low: 5, rep_high: 5, target_weight: 100 }],
    },
  });
  const custom = repo.getActiveDailySession(DATE);
  savePlanDayByPerson(1, "Upper", "Chest and back", [{ ...BENCH, target_weight: 105 }, ROW], { date: DATE });
  assert.equal(Number(repo.getActiveDailySession(DATE).id), Number(custom.id));

  prepareDailySessionUseCase({ date: DATE, source: "manual_plan", day_number: 1, replace: true });
  const planned = repo.getActiveDailySession(DATE);
  repo.logSetByName({ date: DATE, exercise: BENCH.exercise, weight: 105, reps: 6, day_number: 1 });
  savePlanDayByPerson(1, "Upper", "Chest and back", [{ ...BENCH, target_weight: 95 }, ROW], { date: DATE });
  assert.equal(Number(repo.getActiveDailySession(DATE).id), Number(planned.id), "never mid-session");
});

test("an athlete override keeps the plan day the session was already of", () => {
  seedPlan();
  const prepared = prepareDailySessionUseCase({ date: DATE, source: "manual_plan", day_number: 1 });
  const dayOneId = Number(repo.getPlanDay(1).id);
  assert.equal(
    Number(db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(prepared.session.id).plan_day_id),
    dayOneId
  );

  const override = prepareDailySessionUseCase({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: {
      name: "Upper, my way",
      focus: "Chest",
      items: [{ exercise: BENCH.exercise, sets: 4, rep_low: 5, rep_high: 5, target_weight: 110 }],
    },
  });
  assert.equal(Number(override.session.id), Number(prepared.session.id));
  assert.equal(
    Number(db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(override.session.id).plan_day_id),
    dayOneId,
    "the session is still the plan day's"
  );
  assert.equal(Number(repo.getActiveDailySession(DATE).plan_day_id), dayOneId);
});

test("an athlete override may name its plan day, and links nothing a day never had", () => {
  seedPlan();
  const named = prepareDailySessionUseCase({
    date: DATE,
    source: "athlete_override",
    day_number: 2,
    session: {
      name: "Legs, my way",
      focus: "Legs",
      items: [{ exercise: SQUAT.exercise, sets: 3, rep_low: 5, rep_high: 5, target_weight: 175 }],
    },
  });
  assert.equal(
    Number(db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(named.session.id).plan_day_id),
    Number(repo.getPlanDay(2).id)
  );

  const fallback = prepareDailySessionUseCase({
    date: DATE,
    source: "athlete_override",
    day_number: 9,
    replace: true,
    session: {
      name: "Legs again",
      focus: "Legs",
      items: [{ exercise: SQUAT.exercise, sets: 2, rep_low: 5, rep_high: 5, target_weight: 175 }],
    },
  });
  assert.equal(
    Number(db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(fallback.session.id).plan_day_id),
    Number(repo.getPlanDay(2).id),
    "a day that is not on the plan falls back to the link the day already holds"
  );

  const other = "2031-04-15";
  const open = prepareDailySessionUseCase({
    date: other,
    source: "athlete_override",
    session: { name: "Open session", focus: "Choose as you go", items: [] },
  });
  assert.equal(db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(open.session.id).plan_day_id, null);
});

test("a kept plan-day link never makes the plan day the full-load anchor of an athlete override", () => {
  seedPlan();
  prepareDailySessionUseCase({ date: DATE, source: "manual_plan", day_number: 1 });
  const override = prepareDailySessionUseCase({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: {
      name: "Upper, my way",
      focus: "Chest",
      items: [{ exercise: BENCH.exercise, sets: 4, rep_low: 5, rep_high: 5, target_weight: 110 }],
    },
  });
  for (let i = 0; i < 4; i++) {
    repo.logSetByName({ date: DATE, exercise: BENCH.exercise, weight: 110, reps: 5, day_number: null });
  }
  repo.finishSession(override.session.id, null);
  const outcome = repo.getDailySessionOutcome(DATE);
  const dose = outcome.facts.dose_evidence.find((entry) => entry.exercise === BENCH.exercise);
  assert.equal(dose.full_load_reference.sets, null, "the athlete's own prescription, not the plan day's");
  assert.equal(dose.full_load_reference.target_weight, null);
});
