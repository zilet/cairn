// Routine deterministic progressions are the coach's standing job, not a surprise
// (Ruling A), and a budget hold is a WAIT rather than an ask (Ruling B). These tests pin:
//   (a) the live repro — a routine auto-progression is NOT budget-held even after a
//       quiet-applied change already spent the domain's surprise budget this week;
//   (b) non-consumption — a routine progression does not spend the budget for a later
//       genuine agentic change;
//   (c) the cap still bites — two genuine agentic training changes in one week still hold;
//   (d) Ruling B — a budget hold never interrupts Today (nor the attention-review list),
//       but review posture's queue still sees it;
//   (e) hygiene — once the budget frees and the held draft finally routes, its stale
//       'review' decision is superseded, never left dangling open.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyProposalWithAutonomy,
  buildProgressionWithAutonomy,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// Direct logged_sets insert via the shared DB singleton (mirrors brainAutonomyPlanPaths).
function dbInsertSet(sessionId, exId, { set_number = 1, weight = null, reps = null, rir = null, duration_sec = null }) {
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, exId, set_number, weight, reps, rir, duration_sec);
}

// A bench lift whose history EARNS a clamped +5 lb on the next exposure, all ≥10 days ago
// so the acute-recovery brake never trips (same seed as brainAutonomyPlanPaths).
function seedEarnedOverload() {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const ex = repo.findExercise("Barbell Bench Press");
  for (const [daysAgo, w] of [
    [28, 175],
    [21, 180],
    [10, 185],
  ]) {
    const sess = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
    dbInsertSet(sess.id, ex.id, { set_number: 1, weight: w, reps: 8, rir: 2 });
  }
}

// A genuine agentic training change that already quiet-applied this week — the domain-wide
// surprise-budget spender, recorded directly like adoptOrphanedDrafts' veto seed.
function seedAppliedAgenticTraining() {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: "An agentic training change already landed this week",
    rationale: null,
    source: "stub",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    context: null,
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

test("live repro: a routine auto-progression is not budget-held after a quiet-applied change this week", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });
  // A bounded training change (e.g. a recovery-week reshape) already quiet-applied earlier
  // this week, spending the domain-wide surprise budget — the exact live condition.
  seedAppliedAgenticTraining();

  const out = buildProgressionWithAutonomy(1);
  assert.equal(out.ok, true);
  assert.notEqual(out.autonomy.review_required, true, "the routine progression is not held for review");
  assert.notEqual(out.autonomy.review_reason_code, "budget_review", "a routine progression is never a surprise");
  assert.equal(out.autonomy.tier, "quiet_apply");
  assert.equal(out.autonomy.ok, true, "it applies immediately, not parked behind the spent budget");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190, "the earned +5 lb landed automatically");
});

test("a routine progression does not consume the surprise budget for a later agentic change", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });

  // The routine progression lands under its own agent name.
  const progression = buildProgressionWithAutonomy(1);
  assert.equal(progression.autonomy.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
  const routine = repo.listBrainDecisions({ domain: "training", limit: 5 })[0];
  assert.equal(routine.source, "auto-progression", "the applied decision is the routine progression");
  assert.equal(routine.status, "applied");

  // A genuine agentic training change the same week still gets to land — the routine
  // progression it followed spent nothing.
  const agentic = repo.createProposal("stub", "coach-authored bump", "", {
    summary: "Push the bench a touch more",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 200 }],
  });
  const out = applyProposalWithAutonomy(agentic.id, { requested_tier: "quiet_apply" });
  assert.notEqual(out.review_reason_code, "budget_review", "the routine progression did not spend the budget");
  assert.equal(out.tier, "quiet_apply");
  assert.equal(out.applied.length, 1, "the agentic change also landed this week");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 200);
});

test("the surprise budget still gates a second genuine agentic training change", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });

  const first = repo.createProposal("stub", "first agentic change", "", {
    summary: "First bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 190 }],
  });
  assert.equal(applyProposalWithAutonomy(first.id, { requested_tier: "quiet_apply" }).applied.length, 1);

  const second = repo.createProposal("stub", "second agentic change", "", {
    summary: "Second bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }],
  });
  const held = applyProposalWithAutonomy(second.id, { requested_tier: "quiet_apply" });
  assert.equal(held.review_required, true);
  assert.equal(held.review_reason_code, "budget_review", "the cap itself must keep working for real surprises");
  assert.equal(repo.getProposal(second.id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190, "the second change did not land");
});

test("Ruling B: a budget hold waits off Today but review posture's queue still sees it", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });
  seedAppliedAgenticTraining(); // spend the domain budget, plan untouched

  const held = repo.createProposal("stub", "second agentic change", "", {
    summary: "A held bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }],
  });
  const routed = applyProposalWithAutonomy(held.id, { requested_tier: "quiet_apply" });
  assert.equal(routed.review_reason_code, "budget_review");

  const attentionIds = repo.listAttentionReviewHeldProposals(20).map((p) => Number(p.id));
  assert.ok(!attentionIds.includes(Number(held.id)), "a budget hold is not a coach-led attention interrupt");

  const reviewIds = repo.listReviewHeldProposals(20).map((p) => Number(p.id));
  assert.ok(reviewIds.includes(Number(held.id)), "review_everything's queue still sees the hold");

  const agenda = repo.todayAgenda();
  const draftCard = [...agenda.primary, ...agenda.more].find((c) => c.id === "draft-proposals");
  assert.equal(draftCard, undefined, "the budget hold never becomes a Today decision card under lead mode");
});

test("hygiene: a later successful routing supersedes the stale budget review row", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });
  const spender = seedAppliedAgenticTraining();

  const draft = repo.createProposal("stub", "bounded bench change", "", {
    summary: "A bounded bench change waiting on the budget",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }],
  });
  const held = applyProposalWithAutonomy(draft.id, { requested_tier: "quiet_apply" });
  assert.equal(held.review_reason_code, "budget_review");
  const reviewRow = repo.listBrainDecisions({ status: "review", domain: "training", limit: 5 })[0];
  assert.equal(reviewRow.source_ref_key, String(draft.id), "a live review row now owns the held draft");

  // The surprise-budget week rolls over: the earlier change ages out of the window.
  db.prepare(`UPDATE brain_decisions SET created_at = datetime('now','-8 days') WHERE id = ?`).run(spender.decision.id);

  const rerouted = applyProposalWithAutonomy(draft.id, { requested_tier: "quiet_apply" });
  assert.equal(rerouted.applied.length, 1, "with the budget freed the draft finally lands");
  assert.equal(
    repo.getBrainDecision(reviewRow.id).status,
    "superseded",
    "the stale budget review row is retired, not left dangling open"
  );
  const reviewIds = repo.listReviewHeldProposals(20).map((p) => Number(p.id));
  assert.ok(!reviewIds.includes(Number(draft.id)), "no dangling open review remains for the now-applied draft");
});
