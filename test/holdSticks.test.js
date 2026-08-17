// "Hold this" must STICK, and every terminal transition of a held draft must retire
// its outstanding review hold. This file pins the audited defects:
//   FIX 1 — a review-held draft that later applies / is discarded / is superseded
//           leaves ZERO live `review` rows behind (setProposalStatus retires them on
//           every terminal transition, not only through applyProposalWithAutonomy).
//   FIX 2 — a user "Hold this" on an announced plan-proposal decision supersedes the
//           underlying draft (so orphan adoption can never re-adopt it) and stamps the
//           canceled decision with a held_by_user marker.
//   FIX 3 — a user hold counts as a recent veto for the same kind (so a rebuilt twin
//           ANNOUNCES rather than quiet-applies), while SYSTEM cancels (weekly
//           supersede) never register as a veto and never touch demotion counting.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptOrphanedDrafts,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import { domainShouldDemote } from "../dist/brain/autonomy.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// createProposal stamps created_at = datetime('now'); rewrite it so the 2h adoption
// grace window is exercised deterministically (ISO-with-Z parses as UTC).
function backdateHours(id, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

function dbInsertSet(sessionId, exId, { set_number = 1, weight = null, reps = null, rir = null }) {
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, exId, set_number, weight, reps, rir);
}

// A bench lift + plan day so plan-proposal target changes apply against a real target.
function seedBenchPlan() {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "chest", [
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

// A genuine agentic training change that already quiet-applied this week: the domain-wide
// surprise-budget spender. Applying a further bounded training change now parks in review.
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

function benchDraft(instruction, targetWeight, opts = {}) {
  return repo.createProposal(opts.agent ?? "stub", instruction, "", {
    summary: `A bounded bench change to ${targetWeight}`,
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: targetWeight, reason: "test" }],
  });
}

// Route a bench draft into a live review hold (a real live `review` row that
// listReviewHeldProposals reads). Routed through an explicitly REQUESTED review: since
// the 2026-08-17 ruling a spent surprise budget delays rather than parking, so it is no
// longer a way to produce the review row these retirement tests need.
function makeReviewHeldBenchDraft(instruction = "bounded bench change", targetWeight = 195) {
  seedBenchPlan();
  repo.setSettings({ lead_mode: "lead" });
  seedAppliedAgenticTraining();
  const draft = benchDraft(instruction, targetWeight);
  const held = applyProposalWithAutonomy(draft.id, { requested_tier: "ask" });
  assert.equal(held.review_reason_code, "requested_review", "the draft is parked in a live review hold");
  const reviewRow = repo.listBrainDecisions({ status: "review", domain: "training", limit: 5 })
    .find((d) => d.source_ref_key === String(draft.id));
  assert.ok(reviewRow, "a live review row now owns the held draft");
  return { draft, reviewRow };
}

function liveReviewRowsFor(proposalId) {
  return repo
    .listBrainDecisions({ status: "review", limit: 100 })
    .filter((d) => d.source_ref_type === "plan_proposal" && d.source_ref_key === String(proposalId));
}

// Make an ANNOUNCED plan-proposal training_target decision (source plan_proposal),
// backdated past the adoption grace window. Returns { draft, decision }.
function makeAnnouncedBenchDecision(targetWeight = 200) {
  seedBenchPlan();
  const draft = benchDraft("auto: weekly bench read", targetWeight);
  backdateHours(draft.id, 3);
  repo.setSettings({ lead_mode: "announce_first" });
  const routed = applyProposalWithAutonomy(draft.id, {
    requested_tier: "quiet_apply",
    explicit_user_request: true,
  });
  assert.equal(routed.decision?.status, "announced", "the change is scheduled, not yet applied");
  assert.equal(routed.decision.source_ref_key, String(draft.id));
  return { draft, decision: routed.decision };
}

// FIX 2 + FIX 3 (adoption): a user hold supersedes the draft, retires its announced
// row, and a later adoptOrphanedDrafts sweep never re-adopts or re-announces it.
test("holding an announced plan-proposal supersedes the draft and adoption never revives it", () => {
  const { draft, decision } = makeAnnouncedBenchDecision(200);

  const reverted = revertDecision(decision.id, "user hold");
  assert.equal(reverted.ok, true);

  const held = repo.getBrainDecision(decision.id);
  assert.equal(held.status, "canceled", "the announced decision is canceled");
  assert.equal(held.context?.held_by_user, true, "the cancel is stamped as a user hold");
  assert.equal(repo.getProposal(draft.id).status, "superseded", "the underlying draft is retired");
  assert.equal(
    repo.listBrainDecisions({ status: "announced", limit: 100 }).filter((d) => d.source_ref_key === String(draft.id)).length,
    0,
    "no live announced row remains for the held draft"
  );

  repo.setSettings({ lead_mode: "lead" });
  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.adopted, 0, "a superseded held draft is never re-adopted");
  assert.equal(repo.getProposal(draft.id).status, "superseded", "the held draft stays retired after a sweep");
  // No NEW live decision was minted for the held draft beyond the canceled hold.
  const forDraft = repo
    .listBrainDecisions({ limit: 100 })
    .filter((d) => d.source_ref_key === String(draft.id) && ["pending", "announced", "review"].includes(d.status));
  assert.equal(forDraft.length, 0, "the held draft has no live decision after the sweep");
});

// FIX 1: a manual apply (applyProposal) of a review-held draft leaves zero live review rows.
test("manually applying a review-held draft retires its live review rows", () => {
  const { draft } = makeReviewHeldBenchDraft("manually applied bench change", 195);
  assert.equal(liveReviewRowsFor(draft.id).length, 1, "precondition: one live review row");

  const applied = repo.applyProposal(draft.id);
  assert.equal(repo.getProposal(draft.id).status, "applied", "the draft applied");
  assert.ok(applied, "applyProposal returned a result");
  assert.equal(liveReviewRowsFor(draft.id).length, 0, "no live review row remains after apply");
  assert.ok(
    !repo.listReviewHeldProposals(50).map((p) => Number(p.id)).includes(Number(draft.id)),
    "the applied draft no longer surfaces as a review hold"
  );
});

// FIX 1: discarding a review-held draft leaves zero live review rows.
test("discarding a review-held draft retires its live review rows", () => {
  const { draft } = makeReviewHeldBenchDraft("discarded bench change", 195);
  assert.equal(liveReviewRowsFor(draft.id).length, 1, "precondition: one live review row");

  repo.setProposalStatus(draft.id, "discarded");
  assert.equal(repo.getProposal(draft.id).status, "discarded");
  assert.equal(liveReviewRowsFor(draft.id).length, 0, "no live review row remains after discard");
});

// FIX 1: supersedeAutoEvolutionDrafts retiring a review-held draft leaves zero live review rows.
test("a weekly auto-evolution supersede retires a review-held draft's live review rows", () => {
  seedBenchPlan();
  repo.setSettings({ lead_mode: "lead" });
  seedAppliedAgenticTraining();
  const draft = benchDraft(repo.AUTO_EVOLUTION_INSTRUCTION, 195);
  const held = applyProposalWithAutonomy(draft.id, { requested_tier: "ask" });
  assert.equal(held.review_reason_code, "requested_review");
  assert.equal(liveReviewRowsFor(draft.id).length, 1, "precondition: one live review row");
  assert.equal(repo.getProposal(draft.id).status, "draft", "a review hold leaves the draft as a draft");

  const retired = repo.supersedeAutoEvolutionDrafts();
  assert.ok(retired >= 1, "the stale auto-evolution draft is superseded");
  assert.equal(repo.getProposal(draft.id).status, "superseded");
  assert.equal(liveReviewRowsFor(draft.id).length, 0, "no live review row remains after the weekly supersede");
});

// FIX 3 (a): a SYSTEM weekly supersede cancels the announced decision WITHOUT the
// user-hold marker, so it does NOT register as a recent veto.
test("a system weekly supersede does not register as a veto", () => {
  seedBenchPlan();
  const older = benchDraft(repo.AUTO_EVOLUTION_INSTRUCTION, 200);
  backdateHours(older.id, 3);
  repo.setSettings({ lead_mode: "announce_first" });
  const routed = applyProposalWithAutonomy(older.id, {
    requested_tier: "quiet_apply",
    explicit_user_request: true,
  });
  assert.equal(routed.decision?.status, "announced");
  assert.equal(routed.decision.kind, "training_target");

  // A fresh weekly draft lands and retires the older one (system 'superseded'), which
  // cancels the older announced decision — a system cancel, no user-hold marker.
  const fresh = repo.createProposal("stub", repo.AUTO_EVOLUTION_INSTRUCTION, "", {
    summary: "Fresh weekly evolution",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 205 }],
  });
  repo.supersedeAutoEvolutionDrafts(fresh.id);
  assert.equal(repo.getProposal(older.id).status, "superseded");

  const canceled = repo.getBrainDecision(routed.decision.id);
  assert.equal(canceled.status, "canceled", "the older announced decision was canceled by the supersede");
  assert.notEqual(canceled.context?.held_by_user, true, "a system cancel carries no user-hold marker");
  assert.equal(
    repo.hasRecentDecisionVeto("training_target", 5),
    false,
    "a system weekly supersede must never count as a recent veto"
  );
});

// FIX 3 (b): a user hold DOES register as a veto (so a rebuilt twin ANNOUNCES rather
// than quiet-applies), while canceled rows never touch demotion counting.
test("a user hold counts as a veto for re-proposal without affecting demotion", () => {
  const { decision } = makeAnnouncedBenchDecision(200);
  const reverted = revertDecision(decision.id, "user hold");
  assert.equal(reverted.ok, true);
  assert.equal(repo.getBrainDecision(decision.id).context?.held_by_user, true);

  // The hold registers as a recent veto for the same kind.
  assert.equal(repo.hasRecentDecisionVeto("training_target", 5), true, "a user hold is a recent veto");

  // A routine builder rebuilds a same-kind twin: the veto makes adoption ANNOUNCE, not quiet-apply.
  repo.setSettings({ lead_mode: "lead" });
  const twin = benchDraft("auto: rebuilt bench read", 201);
  backdateHours(twin.id, 3);
  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.adopted, 1, "the rebuilt twin is adopted");
  const twinDecision = repo
    .listBrainDecisions({ domain: "training", limit: 20 })
    .find((d) => d.source_ref_key === String(twin.id));
  assert.ok(twinDecision, "the twin acquired a decision");
  assert.equal(twinDecision.status, "announced", "a recent hold makes the twin ANNOUNCE, not quiet-apply");
  assert.equal(twinDecision.autonomy_tier, "announce");

  // Demotion is computed only from reverted / applied+reverted rows — canceled (held)
  // rows contribute nothing, so demotion counting is unchanged.
  const training = repo.listBrainDecisions({ domain: "training", limit: 100 });
  assert.ok(
    training.some((d) => d.status === "canceled" && d.context?.held_by_user === true),
    "the ledger holds a user-canceled row"
  );
  const revertedCount = training.filter((d) => d.status === "reverted").length;
  const appliedOrReverted = training.filter((d) => ["applied", "reverted"].includes(d.status)).length;
  assert.equal(revertedCount, 0, "a hold is a cancel, never a revert — demotion numerator is untouched");
  assert.equal(
    domainShouldDemote(revertedCount, appliedOrReverted),
    false,
    "canceled holds never demote the domain"
  );
});
