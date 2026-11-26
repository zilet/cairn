// The plateau ladder's server-made changes, held to the guards a reviewer found missing
// (src/domain/brain/unit-plateau-change.ts, src/repo/lift-structural-change.ts):
//   1. a rotation's premise re-checks the INCOMING lift at landing: protected → held; no
//      longer the ladder's candidate → gone;
//   2. one server-owned structural change per lift per week: a volume step open or landed on
//      the lift first holds the ladder, at creation and at landing (whichever came first);
//   3. the rep-range lever is made by the server only off the day's anchor and outside the
//      strength range (AUTONOMOUS_REP_SCHEME_MIN_REP_LOW); the ladder still names it;
//   4. a lift on more than one plan day is fenced (a change names one day's slot).
// State is built from REAL rows through the repo's writers. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  AUTONOMOUS_REP_SCHEME_MIN_REP_LOW,
  settleUnitPlateau,
  unitPlateauChangeStillFits,
} from "../dist/domain/brain/unit-plateau-change.js";
import { UNIT_PLATEAU_AGENT, unitPlateauLadder } from "../dist/repo/unit-plateau.js";
import { otherStructuralChangeOnLift } from "../dist/repo/lift-structural-change.js";
import { createBlock } from "../dist/repo/program-blocks.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

function sql(statement, ...args) {
  db.prepare(statement).run(...args);
  bumpTrainingDataVersion();
}

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);
const WEEKS = [56, 49, 42, 35, 28, 21, 14, 7, 1];

// One plan day (or several) of held lifts: each logged weekly at one weight and one rep count.
function base({ leadMode = "lead", days = null, lifts = null } = {}) {
  repo.setSettings({ lead_mode: leadMode });
  const items =
    lifts ??
    [{ exercise: "Rope Pushdown", muscle_group: "triceps", rep_low: 10, rep_high: 12, weight: 50, reps: [12, 11, 10] }];
  const plan = (days ?? [1]).map((n) => ({
    day_number: n,
    name: `Day ${n}`,
    items: items.map((l) => ({
      exercise: l.exercise,
      muscle_group: l.muscle_group,
      sets: 3,
      rep_low: l.rep_low,
      rep_high: l.rep_high,
      target_weight: l.weight,
    })),
  }));
  repo.replacePlan(plan);
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-200));
  for (const l of items) {
    repo.upsertExercise({ name: l.exercise, muscle_group: l.muscle_group, mode: "reps" });
    for (const d of WEEKS)
      for (const reps of l.reps) repo.logSetByName({ exercise: l.exercise, weight: l.weight, reps, date: day(-d) });
  }
}

const rows = () => db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ? ORDER BY id`).all(UNIT_PLATEAU_AGENT);
const rung = (key) => unitPlateauLadder(today()).units.find((u) => u.unit_key === key);

// A volume step's stored row on a lift: open (a draft), or applied with its landing decision.
function volumeStepRow(lift, { status = "draft", landedDaysAgo = 0 } = {}) {
  const info = db
    .prepare(
      `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status)
       VALUES ('volume-step', 'x', '', ?, ?)`
    )
    .run(JSON.stringify({ volume_step: { group: "triceps", lift, to: 4 } }), status);
  const id = Number(info.lastInsertRowid);
  if (status === "applied") {
    db.prepare(
      `INSERT INTO brain_decisions
         (kind, domain, summary, status, autonomy_tier, risk_class, source_ref_type, source_ref_key, effective_date)
       VALUES ('plan_change', 'training', 'x', 'applied', 'quiet_apply', 'low', 'plan_proposal', ?, ?)`
    ).run(String(id), day(-landedDaysAgo));
  }
  return id;
}

// ---- 1. the incoming lift is re-checked at landing --------------------------------------

function rotationDraft() {
  base({ leadMode: "review_everything" });
  // The earlier levers spent: the rep range moved and standing, a volume step tried.
  db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status, created_at)
     VALUES ('progression', 'x', '', ?, 'applied', datetime('now', '-70 days'))`
  ).run(
    JSON.stringify({
      changes: [
        { day_number: 1, exercise: "Rope Pushdown", rep_low: 10, rep_high: 12, progression_escalation: "rep_range" },
      ],
    })
  );
  db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status, created_at)
     VALUES ('volume-step', 'x', '', ?, 'discarded', datetime('now', '-5 days'))`
  ).run(JSON.stringify({ volume_step: { group: "triceps" } }));
  repo.upsertExercise({ name: "Straight Bar Pushdown", muscle_group: "triceps", mode: "reps" });
  for (const reps of [10, 10, 10])
    repo.logSetByName({ exercise: "Straight Bar Pushdown", weight: 55, reps, date: day(-150) });
  createBlock({ goal: "strength", focus: "strength", week_index: 1, total_weeks: 4 });
  const out = settleUnitPlateau({ act: true });
  assert.equal(out.status, "routed", JSON.stringify(out));
  assert.equal(out.lever, "variation");
  assert.equal(out.asked, true, "held for a yes");
  assert.equal(out.to_lift, "Straight Bar Pushdown");
  return out;
}

test("a rotation whose incoming lift now carries a constraint note is held at landing", () => {
  const out = rotationDraft();
  const parsed = repo.getProposal(out.proposal_id).parsed;
  assert.equal(unitPlateauChangeStillFits(parsed, today(), out.proposal_id), "fits");
  sql(`UPDATE exercises SET constraint_note = 'elbow: keep it light' WHERE name = 'Straight Bar Pushdown'`);
  assert.equal(unitPlateauChangeStillFits(parsed, today(), out.proposal_id), "held");
});

test("a rotation whose incoming lift now hurts is held at landing", () => {
  const out = rotationDraft();
  const parsed = repo.getProposal(out.proposal_id).parsed;
  const event = Number(
    db
      .prepare(
        `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
         VALUES ('test', 'left ankle', 'active', 'area', ?, ?)`
      )
      .run(day(-3), day(-1)).lastInsertRowid
  );
  const ex = repo.findExercise("Straight Bar Pushdown");
  for (const d of [3, 1])
    db.prepare(
      `INSERT INTO movement_tolerance_observations
         (symptom_event_id, session_id, exercise_id, movement_key, movement_name, observed_on, outcome, relevant)
       VALUES (?, NULL, ?, ?, ?, ?, 'pain_present', 1)`
    ).run(event, ex.id, `exercise:${ex.id}`, ex.name, day(-d));
  bumpTrainingDataVersion();
  assert.equal(unitPlateauChangeStillFits(parsed, today(), out.proposal_id), "held");
  // ...and the boundary pass does not land it: the draft stays a draft.
  settleUnitPlateau({ act: true });
  assert.equal(repo.getProposal(out.proposal_id).status, "draft");
  assert.equal(repo.getPlan()[0].items[0].exercise, "Rope Pushdown");
});

test("a rotation whose incoming lift is no longer the ladder's candidate is gone", () => {
  const out = rotationDraft();
  const parsed = repo.getProposal(out.proposal_id).parsed;
  repo.upsertExercise({ name: "V-Bar Pushdown", muscle_group: "triceps", mode: "reps" });
  const stale = { ...parsed, unit_plateau: { ...parsed.unit_plateau, to_lift: "V-Bar Pushdown" } };
  assert.equal(rung("triceps:pushdown").candidate.exercise, "Straight Bar Pushdown");
  assert.equal(unitPlateauChangeStillFits(stale, today()), "gone");
});

// ---- 2. one structural change per lift per week -----------------------------------------

test("a volume step open on the lift holds the ladder: nothing is drafted", () => {
  base();
  volumeStepRow("Rope Pushdown");
  const out = settleUnitPlateau({ act: true });
  assert.notEqual(out.status, "routed", JSON.stringify(out));
  assert.ok(out.blocked.some((b) => b.code === "volume_step_this_week"), JSON.stringify(out));
  assert.equal(rows().length, 0);
  assert.equal(repo.getPlan()[0].items[0].rep_low, 10);
});

test("a volume step landed on the lift this week holds the ladder; one from an earlier week does not", () => {
  base();
  const id = volumeStepRow("Rope Pushdown", { status: "applied", landedDaysAgo: 0 });
  assert.notEqual(settleUnitPlateau({ act: true }).status, "routed");
  assert.equal(rows().length, 0);
  // Landed before this calendar week: the lift is free again.
  db.prepare(`UPDATE brain_decisions SET effective_date = ? WHERE source_ref_key = ?`).run(day(-14), String(id));
  db.prepare(`UPDATE plan_proposals SET created_at = datetime('now', '-14 days') WHERE id = ?`).run(id);
  assert.equal(settleUnitPlateau({ act: true }).status, "routed");
});

test("at landing: a volume step that came first holds the ladder's draft; one written after it does not", () => {
  base({ leadMode: "review_everything" });
  const out = settleUnitPlateau({ act: true });
  assert.equal(out.status, "routed");
  const parsed = repo.getProposal(out.proposal_id).parsed;
  const later = volumeStepRow("Rope Pushdown");
  assert.ok(later > out.proposal_id);
  assert.equal(unitPlateauChangeStillFits(parsed, today(), out.proposal_id), "fits", "the ladder came first");
  assert.equal(otherStructuralChangeOnLift(["Rope Pushdown"], today(), { self: "volume-step", before: later }), true);
  sql(`DELETE FROM plan_proposals WHERE id = ?`, later);
  volumeStepRow("Rope Pushdown", { status: "applied" });
  assert.equal(unitPlateauChangeStillFits(parsed, today(), out.proposal_id), "held", "a step landed this week");
});

// ---- 3. the rep-range lever: off the anchor, outside the strength range ------------------

test("the day's anchor compound keeps its rep range: the ladder names the lever, the server drafts nothing", () => {
  base({
    lifts: [
      { exercise: "Barbell Bench Press", muscle_group: "chest", rep_low: 8, rep_high: 10, weight: 135, reps: [10, 9, 8] },
    ],
  });
  const bench = rung("horizontal-push:flat");
  assert.equal(bench.lever, "rep_scheme", JSON.stringify(bench));
  const out = settleUnitPlateau({ act: true });
  assert.notEqual(out.status, "routed");
  assert.ok(out.blocked.some((b) => b.code === "day_anchor"), JSON.stringify(out));
  assert.equal(rows().length, 0);
  assert.equal(repo.getPlan()[0].items[0].rep_low, 8);
});

test("strength-range work keeps its rep range: the ladder names the lever, the server drafts nothing", () => {
  assert.equal(AUTONOMOUS_REP_SCHEME_MIN_REP_LOW, 6);
  base({
    lifts: [{ exercise: "Rope Pushdown", muscle_group: "triceps", rep_low: 4, rep_high: 6, weight: 70, reps: [6, 5, 4] }],
  });
  const pushdown = rung("triceps:pushdown");
  assert.equal(pushdown.lever, "rep_scheme", JSON.stringify(pushdown));
  const out = settleUnitPlateau({ act: true });
  assert.notEqual(out.status, "routed");
  assert.ok(out.blocked.some((b) => b.code === "strength_range"), JSON.stringify(out));
  assert.equal(rows().length, 0);
});

// ---- 4. a lift on several plan days is fenced -------------------------------------------

test("a lift on two plan days is fenced: no change lands on one of its slots", () => {
  base({ days: [1, 2] });
  const out = settleUnitPlateau({ act: true });
  assert.notEqual(out.status, "routed", JSON.stringify(out));
  assert.ok(out.blocked.some((b) => b.code === "multi_day"), JSON.stringify(out));
  for (const d of repo.getPlan()) assert.equal(d.items[0].rep_low, 10);
});

test("a draft whose lift has since been added to a second plan day is gone", () => {
  base({ leadMode: "review_everything" });
  const out = settleUnitPlateau({ act: true });
  assert.equal(out.status, "routed");
  const parsed = repo.getProposal(out.proposal_id).parsed;
  repo.savePlanDay(2, "Day 2", null, [
    { exercise: "Rope Pushdown", muscle_group: "triceps", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 },
  ]);
  assert.equal(unitPlateauChangeStillFits(parsed, today(), out.proposal_id), "gone");
});
