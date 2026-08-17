// Routine deterministic progressions are the coach's standing job, not a surprise
// (Ruling A), and a budget hold is a WAIT rather than an ask (Ruling B). These tests pin:
//   (a) the live repro — a routine auto-progression is NOT budget-held even after a
//       quiet-applied change already spent the domain's surprise budget this week;
//   (b) non-consumption — a routine progression does not spend the budget for a later
//       genuine agentic change;
//   (c) the cap still bites — a fourth genuine agentic training change in one week is
//       paced (the 2026-08-17 ruling moved the pace from one to three per domain-week);
//   (d) Ruling B — a budget miss is a WAIT: it never interrupts Today, and it never
//       enters a review queue at all, because there is nothing to review;
//   (e) the boundary pass delays such a change forward while the week is full, keeping
//       its ledger row and its announced status, and lands it once the week frees.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
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
// surprise-budget spender, recorded directly like adoptOrphanedDrafts' veto seed. The
// index makes each seed a distinct decision: recordDecision fingerprints on
// kind + source_ref_type + source_ref_key + effective_date + action, so identical seeds
// would collapse into one row and never fill the week.
function seedAppliedAgenticTraining(index = 0) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: `An agentic training change already landed this week (${index})`,
    rationale: null,
    source: "stub",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    context: null,
    action: { seed: index },
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

test("the surprise budget still paces genuine agentic training changes", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });

  // The pace is three material changes per domain-week (2026-08-17 ruling). The first
  // three land; the fourth overruns the week.
  for (const [index, weight] of [190, 195, 200].entries()) {
    const change = repo.createProposal("stub", `agentic change ${index}`, "", {
      summary: `Bench change ${index}`,
      changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: weight }],
    });
    assert.equal(applyProposalWithAutonomy(change.id, { requested_tier: "quiet_apply" }).applied.length, 1);
  }
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 200);

  const overrun = repo.createProposal("stub", "the change that overruns the week", "", {
    summary: "A fourth bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 205 }],
  });
  const deferred = applyProposalWithAutonomy(overrun.id, { requested_tier: "quiet_apply" });
  // The cap still works for real surprises — but a miss WAITS. It is never demoted to a
  // bare draft or to an ask the athlete has to answer.
  assert.equal(deferred.review_required, undefined);
  assert.notEqual(deferred.tier, "ask");
  assert.equal(deferred.announced, true);
  assert.equal(deferred.budget_deferred, true);
  assert.equal(repo.getProposal(overrun.id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 200, "the fourth change did not land yet");
});

test("Ruling B: a budget-deferred change never interrupts Today and is not a review hold", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });
  for (let index = 0; index < 3; index += 1) seedAppliedAgenticTraining(index);

  const waiting = repo.createProposal("stub", "the change that overruns the week", "", {
    summary: "A bench change waiting on the week",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }],
  });
  const routed = applyProposalWithAutonomy(waiting.id, { requested_tier: "quiet_apply" });
  assert.equal(routed.budget_deferred, true);
  assert.equal(routed.announced, true);

  // It is not an interrupt, and it is not in ANY review queue — there is nothing to
  // review. It simply has a boundary date in front of it.
  const attentionIds = repo.listAttentionReviewHeldProposals(20).map((p) => Number(p.id));
  assert.ok(!attentionIds.includes(Number(waiting.id)), "a wait is not a coach-led attention interrupt");
  const reviewIds = repo.listReviewHeldProposals(20).map((p) => Number(p.id));
  assert.ok(!reviewIds.includes(Number(waiting.id)), "a wait never enters the review queue at all");

  const agenda = repo.todayAgenda();
  const draftCard = [...agenda.primary, ...agenda.more].find((c) => c.id === "draft-proposals");
  assert.equal(draftCard, undefined, "the waiting change never becomes a Today decision card under lead mode");
});

test("the boundary pass delays a due change while the week is full, then lands it", () => {
  seedEarnedOverload();
  repo.setSettings({ lead_mode: "lead" });
  const spenders = [0, 1, 2].map((index) => seedAppliedAgenticTraining(index));

  const draft = repo.createProposal("stub", "bounded bench change", "", {
    summary: "A bounded bench change waiting on the week",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 195 }],
  });
  const routed = applyProposalWithAutonomy(draft.id, { requested_tier: "quiet_apply" });
  assert.equal(routed.budget_deferred, true);
  const decisionId = Number(routed.decision.id);

  // At its boundary the week is still full: the pass pushes it forward rather than
  // parking it at review, and it stays announced with its ledger row intact.
  const blocked = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(blocked.applied, []);
  assert.deepEqual(blocked.delayed, [decisionId], "it is delayed, not failed");
  const waited = repo.getBrainDecision(decisionId);
  assert.equal(waited.status, "announced", "still announced, never demoted to review");
  assert.equal(waited.context.surprise_budget_deferred, true);
  assert.ok(waited.effective_date > routed.effective_date, "its boundary moved forward");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 185, "nothing landed while it waited");

  // The surprise-budget week rolls over: the earlier changes age out of the window.
  for (const spender of spenders) {
    db.prepare(`UPDATE brain_decisions SET created_at = datetime('now','-8 days') WHERE id = ?`).run(
      spender.decision.id
    );
  }

  const landed = applyDueAnnouncedDecisions(waited.effective_date);
  assert.deepEqual(landed.applied, [decisionId], "with the week freed it lands at its boundary");
  assert.equal(repo.getProposal(draft.id).status, "applied");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 195);
});
