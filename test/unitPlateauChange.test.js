// The plateau ladder's bounded levers, made by the server (src/domain/brain/unit-plateau-change.ts).
// Invariants:
//   1. lead: the rep-range move quiet-applies through the ordinary autonomy path with Undo,
//      marked on the ledger the engine reads; review_everything holds one draft;
//   2. Undo is a no for that plateau: the range goes back and the lever is not re-proposed;
//   3. at most two units a calendar week, one change a pass, one open draft a unit;
//   4. holds: a constraint note, pain, a fresh prescription; a compound anchor is never
//      rotated by the server; an accessory rotates only at a block boundary;
//   5. the premise is re-read: fits / gone / held.
// State is built from REAL rows through the repo's writers. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  MAX_UNITS_PER_WEEK,
  previewUnitPlateau,
  settleUnitPlateau,
  UNIT_PLATEAU_INSTRUCTION,
  unitPlateauChangeStillFits,
} from "../dist/domain/brain/unit-plateau-change.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { lastAppliedRepRangeMove } from "../dist/repo/lift-response.js";
import { UNIT_PLATEAU_AGENT, unitPlateauLadder } from "../dist/repo/unit-plateau.js";
import { createBlock } from "../dist/repo/program-blocks.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

// A raw fixture write, then the cache bump every repo writer does (plan and lift reads are memoized on it).
function sql(statement, ...args) {
  db.prepare(statement).run(...args);
  bumpTrainingDataVersion();
}

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);
const WEEKS = [56, 49, 42, 35, 28, 21, 14, 7, 1];

const ISOLATION = [
  { exercise: "Rope Pushdown", muscle_group: "triceps", weight: 50, unit: "triceps:pushdown" },
  { exercise: "Cable Curl", muscle_group: "biceps", weight: 40, unit: "curl:supinated" },
  { exercise: "Leg Extension", muscle_group: "quads", weight: 90, unit: "knee-extension" },
];

function base({ leadMode = "lead", lifts = ISOLATION.slice(0, 1), bench = false } = {}) {
  repo.setSettings({ lead_mode: leadMode });
  repo.replacePlan([
    {
      day_number: 1,
      name: "Upper",
      items: [
        ...(bench
          ? [
              {
                exercise: "Barbell Bench Press",
                muscle_group: "chest",
                sets: 3,
                rep_low: 12,
                rep_high: 15,
                target_weight: 135,
              },
            ]
          : []),
        ...lifts.map((l) => ({
          exercise: l.exercise,
          muscle_group: l.muscle_group,
          sets: 3,
          rep_low: 10,
          rep_high: 12,
          target_weight: l.weight,
        })),
      ],
    },
  ]);
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-200));
  for (const l of [
    ...lifts,
    ...(bench ? [{ exercise: "Barbell Bench Press", muscle_group: "chest", weight: 135 }] : []),
  ]) {
    repo.upsertExercise({ name: l.exercise, muscle_group: l.muscle_group, mode: "reps" });
    for (const d of WEEKS)
      for (const reps of [12, 11, 10])
        repo.logSetByName({ exercise: l.exercise, weight: l.weight, reps, date: day(-d) });
  }
}

const item = (name) => repo.getPlan()[0].items.find((i) => i.exercise === name);
const rows = () =>
  db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ? ORDER BY id`).all(UNIT_PLATEAU_AGENT);

function snapshot() {
  const count = (sql) => db.prepare(sql).get().n;
  return JSON.stringify({
    plan: repo.getPlan(),
    proposals: count(`SELECT COUNT(*) AS n FROM plan_proposals`),
    decisions: count(`SELECT COUNT(*) AS n FROM brain_decisions`),
  });
}

function assertHouseVoice(...texts) {
  for (const text of texts) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.doesNotMatch(text, /\bmust\b|\bshould\b|\bscore\b|\d/i, text);
  }
}

test("lead: a higher rep range at the held load quiet-applies with Undo, on the ledger the engine reads", () => {
  base();
  const out = settleUnitPlateau({ act: true });
  assert.equal(out.status, "routed", JSON.stringify(out));
  assert.equal(out.lever, "rep_scheme");
  assert.equal(out.tier, "quiet_apply");
  assert.equal(out.lift, "Rope Pushdown");
  const pushdown = item("Rope Pushdown");
  assert.equal(pushdown.rep_low, 13);
  assert.equal(pushdown.rep_high, 15);
  assert.equal(pushdown.target_weight, 50, "the load holds");
  assert.equal(pushdown.sets, 3, "never a set");
  assertHouseVoice(out.summary, out.explanation);
  assert.match(out.explanation, /Undo/);
  const proposal = repo.getProposal(out.proposal_id);
  assert.equal(proposal.status, "applied");
  assert.equal(proposal.instruction, UNIT_PLATEAU_INSTRUCTION);
  const move = lastAppliedRepRangeMove("Rope Pushdown");
  assert.equal(move?.rep_low, 13, "the engine's own ledger carries the move");
  const decision = db.prepare(`SELECT * FROM brain_decisions WHERE id = ?`).get(out.decision_id);
  assert.equal(decision.reversible, 1, "the server-owned Undo rides along");
  // The slot is a new prescription: the ladder waits on it now.
  assert.equal(unitPlateauLadder(today()).units.find((u) => u.unit_key === "triceps:pushdown").lever, "wait");
});

test("Undo is a no for this plateau: the range goes back and the lever is not offered again", () => {
  base();
  const out = settleUnitPlateau({ act: true });
  assert.equal(revertDecision(out.decision_id).ok, true);
  assert.equal(item("Rope Pushdown").rep_low, 10, "the plan is as it was");
  const rung = unitPlateauLadder(today()).units.find((u) => u.unit_key === "triceps:pushdown");
  assert.notEqual(rung.lever, "rep_scheme", JSON.stringify(rung));
  const before = snapshot();
  const again = settleUnitPlateau({ act: true });
  assert.notEqual(again.status, "routed", "nothing else lands on that unit");
  assert.equal(snapshot(), before);
});

test("review_everything holds exactly one draft, asked in the asking register, and a second pass adds none", () => {
  base({ leadMode: "review_everything" });
  const out = settleUnitPlateau({ act: true });
  assert.equal(out.status, "routed");
  assert.equal(out.asked, true);
  assert.equal(item("Rope Pushdown").rep_low, 10, "nothing applied");
  assertHouseVoice(out.explanation);
  assert.doesNotMatch(out.explanation, /Undo/);
  settleUnitPlateau({ act: true });
  assert.equal(rows().filter((r) => r.status === "draft").length, 1);
});

test("at most two units a calendar week, one change a pass", () => {
  base({ lifts: ISOLATION });
  const first = settleUnitPlateau({ act: true });
  const second = settleUnitPlateau({ act: true });
  assert.equal(first.status, "routed");
  assert.equal(second.status, "routed");
  assert.notEqual(first.unit_key, second.unit_key);
  const before = snapshot();
  const third = settleUnitPlateau({ act: true });
  assert.equal(third.status, "held");
  assert.equal(third.hold, "week_used");
  assert.equal(MAX_UNITS_PER_WEEK, 2);
  assert.equal(snapshot(), before);
});

test("holds: a constraint note keeps the lift untouched; a dry pass writes nothing", () => {
  base();
  sql(`UPDATE exercises SET constraint_note = 'elbow: keep it light' WHERE name = 'Rope Pushdown'`);
  const before = snapshot();
  const held = settleUnitPlateau({ act: true });
  assert.notEqual(held.status, "routed");
  assert.ok(
    held.blocked.some((b) => b.code === "constraint_note"),
    JSON.stringify(held)
  );
  assert.equal(snapshot(), before);
  sql(`UPDATE exercises SET constraint_note = NULL WHERE name = 'Rope Pushdown'`);
  const cleared = snapshot();
  const preview = previewUnitPlateau();
  assert.equal(preview.status, "would_route");
  assert.equal(preview.lever, "rep_scheme");
  assert.equal(snapshot(), cleared, "a preview writes nothing");
});

test("the premise is re-read: fits now, gone once the slot changes under it, held under a constraint note", () => {
  base({ leadMode: "review_everything" });
  const out = settleUnitPlateau({ act: true });
  const parsed = repo.getProposal(out.proposal_id).parsed;
  assert.equal(unitPlateauChangeStillFits(parsed), "fits");
  sql(`UPDATE exercises SET constraint_note = 'shoulder' WHERE name = 'Rope Pushdown'`);
  assert.equal(unitPlateauChangeStillFits(parsed), "held");
  sql(`UPDATE exercises SET constraint_note = NULL WHERE name = 'Rope Pushdown'`);
  sql(`UPDATE plan_items SET rep_low = 8, rep_high = 10`);
  assert.equal(unitPlateauChangeStillFits(parsed), "gone");
  assert.equal(unitPlateauChangeStillFits({ unit_plateau: { unit_key: "x", lever: "volume" } }), "unknown");
});

function exhaustEarlierLevers(group) {
  // The rep range already moved and still standing, and a volume step tried in the plateau.
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
  ).run(JSON.stringify({ volume_step: { group } }));
}

test("an accessory rotates inside its unit at a block boundary, starting untested; never off the boundary", () => {
  base();
  exhaustEarlierLevers("triceps");
  repo.upsertExercise({ name: "Straight Bar Pushdown", muscle_group: "triceps", mode: "reps" });
  for (const reps of [10, 10, 10])
    repo.logSetByName({ exercise: "Straight Bar Pushdown", weight: 55, reps, date: day(-150) });
  const off = settleUnitPlateau({ act: true });
  assert.notEqual(off.status, "routed", "no block: no boundary");
  createBlock({ goal: "strength", focus: "strength", week_index: 1, total_weeks: 4 });
  const out = settleUnitPlateau({ act: true });
  assert.equal(out.status, "routed", JSON.stringify(out));
  assert.equal(out.lever, "variation");
  assert.equal(out.to_lift, "Straight Bar Pushdown");
  assertHouseVoice(out.summary, out.explanation);
  const slot = repo.getPlan()[0].items[0];
  assert.equal(slot.exercise, "Straight Bar Pushdown");
  const stamp = db.prepare(`SELECT prescribed_at FROM plan_items WHERE id = ?`).get(slot.id).prescribed_at;
  assert.equal(String(stamp).slice(0, 10), today(), "the slot is a new prescription: untested until lifted");
  // One change per unit per block.
  assert.notEqual(settleUnitPlateau({ act: true }).status, "routed");
});

test("a compound anchor is never rotated by the server, even at a block boundary", () => {
  base({ lifts: [], bench: true });
  db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status, created_at)
     VALUES ('volume-step', 'x', '', ?, 'discarded', datetime('now', '-5 days'))`
  ).run(JSON.stringify({ volume_step: { group: "chest" } }));
  createBlock({ goal: "strength", focus: "strength", week_index: 1, total_weeks: 4 });
  const bench = unitPlateauLadder(today()).units.find((u) => u.unit_key === "horizontal-push:flat");
  assert.equal(bench.lever, "variation", JSON.stringify(bench));
  const before = snapshot();
  const out = settleUnitPlateau({ act: true });
  assert.notEqual(out.status, "routed");
  assert.ok(out.blocked.some((b) => b.code === "anchor"));
  assert.equal(snapshot(), before);
});
