import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAutonomyTier,
  defaultAutonomyTier,
  surpriseBudgetAllows,
  SURPRISE_BUDGET_PER_DOMAIN_WEEK,
} from "../dist/brain/autonomy.js";
import {
  applyProposalWithAutonomy,
  thawParkedReviewDecisions,
  adoptOrphanedDrafts,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";
import { localDateISO } from "../dist/repo/shared.js";

// HEADS-UP AUTONOMY (owner ruling, 2026-08-17). Under lead_mode 'lead' only, a goal
// change and a REVERSIBLE high-risk change land with a heads-up and a one-tap undo
// instead of stopping to ask. The floors do not move: clinical stays clinician, and
// irreversible / user_locked / clamp_refused stay ask at every lead mode. The other two
// lead modes keep exactly the answers they gave before.

const base = { kind: "training_target", risk_class: "low", reversible: true };

test("lead: a goal_change kind announces instead of asking", () => {
  assert.equal(defaultAutonomyTier({ ...base, kind: "goal_change", lead_mode: "lead" }), "announce");
  assert.equal(decideAutonomyTier({ ...base, kind: "goal_change", lead_mode: "lead" }).tier, "announce");
});

test("lead: the goal_identity flag announces instead of asking", () => {
  const decision = decideAutonomyTier({ ...base, lead_mode: "lead", goal_identity: true });
  assert.equal(decision.tier, "announce");
  assert.ok(
    decision.reasons.some((reason) => /heads-up/.test(reason)),
    "the athlete-facing reason says a heads-up is coming, not that they must decide"
  );
  assert.ok(decision.natural_boundary_required, "an announced change still waits for a natural boundary");
});

test("lead: a reversible high-risk change announces instead of asking", () => {
  assert.equal(decideAutonomyTier({ ...base, risk_class: "high", lead_mode: "lead" }).tier, "announce");
});

test("lead: the floors do not move", () => {
  // Clinical is the deterministic floor a conductor cannot self-attest away.
  assert.equal(decideAutonomyTier({ ...base, risk_class: "clinical", lead_mode: "lead" }).tier, "clinician");
  assert.equal(decideAutonomyTier({ ...base, clinical: true, lead_mode: "lead" }).tier, "clinician");
  // An irreversible action stays ask even when it is also high-risk or a goal change.
  assert.equal(decideAutonomyTier({ ...base, reversible: false, lead_mode: "lead" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, kind: "goal_change", reversible: false, lead_mode: "lead" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, risk_class: "high", reversible: false, lead_mode: "lead" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, user_locked: true, lead_mode: "lead" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, clamp_refused: true, lead_mode: "lead" }).tier, "ask");
  // A user lock outranks the goal-change softening rather than being softened by it.
  assert.equal(decideAutonomyTier({ ...base, kind: "goal_change", user_locked: true, lead_mode: "lead" }).tier, "ask");
});

test("review_everything and announce_first keep their previous answers", () => {
  for (const lead_mode of ["review_everything", "announce_first"]) {
    assert.equal(decideAutonomyTier({ ...base, kind: "goal_change", lead_mode }).tier, "ask", lead_mode);
    assert.equal(decideAutonomyTier({ ...base, goal_identity: true, lead_mode }).tier, "ask", lead_mode);
    assert.equal(decideAutonomyTier({ ...base, risk_class: "high", lead_mode }).tier, "ask", lead_mode);
    assert.equal(decideAutonomyTier({ ...base, risk_class: "clinical", lead_mode }).tier, "clinician", lead_mode);
  }
  // And review_everything still pulls an ordinary bounded change up to ask.
  assert.equal(decideAutonomyTier({ ...base, lead_mode: "review_everything" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, lead_mode: "announce_first" }).tier, "announce");
  assert.equal(decideAutonomyTier({ ...base, lead_mode: "lead" }).tier, "quiet_apply");
});

test("the surprise budget paces at three material changes per domain-week", () => {
  assert.equal(SURPRISE_BUDGET_PER_DOMAIN_WEEK, 3);
  assert.equal(surpriseBudgetAllows(0), true);
  assert.equal(surpriseBudgetAllows(1), true);
  assert.equal(surpriseBudgetAllows(2), true);
  assert.equal(surpriseBudgetAllows(3), false);
  assert.equal(surpriseBudgetAllows(9, true), true, "a safety response is never rationed");
});

// ---------- surprise-budget miss is a WAIT, not an ask ----------

function seedMaterialTrainingChange(index) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: `A material training change ${index}`,
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: false,
    context: null,
    // A distinct action matters: recordDecision fingerprints on
    // kind + source_ref_type + source_ref_key + effective_date + action, so three
    // otherwise identical seeds would collapse into ONE row and never fill the budget.
    action: { seed: index },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

// The plan is seeded BEFORE the draft on purpose: createProposal fingerprints the plan
// it was written against, so seeding afterwards would read as changed evidence and send
// every one of these through the staleness path instead of the one under test.
function seedPlanDay() {
  repo.savePlanDay(1, "Push", "chest", [{ exercise: "ZHeadsUp Press", sets: 3, target_weight: 100 }]);
}

function trainingDraft(summary = "A bounded target nudge") {
  return repo.createProposal("stub", `auto: ${summary}`, "", {
    summary,
    changes: [{ day_number: 1, exercise: "ZHeadsUp Press", target_weight: 105, reason: summary }],
  });
}

test("a spent surprise budget delays to the next boundary instead of demoting to ask", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  for (let index = 0; index < SURPRISE_BUDGET_PER_DOMAIN_WEEK; index += 1) seedMaterialTrainingChange(index);

  const proposal = trainingDraft("A nudge proposed in a full week");
  const result = applyProposalWithAutonomy(Number(proposal.id));

  assert.equal(result.ok, true);
  assert.equal(result.review_required, undefined, "a full week never becomes a question for the athlete");
  assert.notEqual(result.tier, "ask");
  assert.equal(result.announced, true, "it announces and waits for its natural boundary");
  assert.equal(result.budget_deferred, true);
  assert.ok(result.effective_date, "it carries a real boundary date");
  assert.equal(result.decision.status, "announced");
  assert.equal(result.decision.context.surprise_budget_deferred, true);
  assert.equal(repo.getProposal(Number(proposal.id)).status, "draft", "the draft is not retired by the wait");
});

// ---------- parked-state thaw ----------

function heldReviewDecision(proposalId, { userLocked = false } = {}) {
  return applyProposalWithAutonomy(Number(proposalId), {
    requested_tier: "ask",
    ...(userLocked ? { user_locked: true } : {}),
  });
}

test("the thaw re-offers a parked decision once, and only once", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = trainingDraft("A change parked by an older, stricter posture");
  const held = heldReviewDecision(proposal.id);
  assert.equal(held.review_required, true, "it starts parked at review");
  assert.equal(held.decision.status, "review");

  const first = thawParkedReviewDecisions();
  assert.equal(first.thawed, 1, "today's policy re-offers it");
  assert.equal(first.superseded, 0);
  const reoffered = repo.getProposal(Number(proposal.id));
  assert.ok(
    ["pending", "announced", "applied"].includes(String(reoffered.autonomy?.status)),
    `expected an owned boundary, got ${reoffered.autonomy?.status}`
  );

  // Idempotent: the attempt is stamped on the decision, so a second tick does nothing.
  const second = thawParkedReviewDecisions();
  assert.equal(second.thawed, 0);
  assert.equal(second.superseded, 0);
});

test("the thaw leaves a user-locked hold exactly where it is", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = trainingDraft("A change the athlete locked");
  const held = heldReviewDecision(proposal.id, { userLocked: true });
  assert.equal(held.review_reason_code, "user_lock");

  const result = thawParkedReviewDecisions();
  assert.equal(result.thawed, 0, "a lock is the athlete's own word, not a posture artefact");
  assert.equal(result.superseded, 0);
  assert.equal(repo.getBrainDecision(Number(held.decision.id)).status, "review");
});

test("the thaw leaves a clinician-tier hold exactly where it is", () => {
  repo.setSettings({ lead_mode: "lead" });
  const recorded = repo.recordDecision({
    effective_date: null,
    kind: "case_conference",
    domain: "health",
    summary: "A conference that reached a clinical question",
    rationale: null,
    source: "case_conference",
    source_ref_type: null,
    source_ref_key: null,
    status: "review",
    autonomy_tier: "clinician",
    risk_class: "clinical",
    reversible: false,
    context: { advisory_only: true },
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  const id = Number(recorded.decision.id);

  assert.equal(thawParkedReviewDecisions().thawed, 0);
  assert.equal(repo.getBrainDecision(id).status, "review", "the clinician floor is deterministic");
  assert.equal(repo.getBrainDecision(id).autonomy_tier, "clinician");
});

test("the thaw stops an advisory conference from parking at review", () => {
  // The live shape this exists for: a case_conference sitting at `review` with no draft
  // behind it, asking for a decision that has no change to approve.
  repo.setSettings({ lead_mode: "lead" });
  const recorded = repo.recordDecision({
    effective_date: null,
    kind: "case_conference",
    domain: "training",
    summary: "A whole-person read with no executable revision",
    rationale: "The picture is heading the right way; nothing needs to change this week.",
    source: "case_conference",
    source_ref_type: null,
    source_ref_key: null,
    status: "review",
    autonomy_tier: "ask",
    risk_class: "moderate",
    reversible: false,
    context: { advisory_only: true },
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  const id = Number(recorded.decision.id);

  const result = thawParkedReviewDecisions();
  assert.equal(result.thawed, 1);
  const thawed = repo.getBrainDecision(id);
  assert.equal(thawed.status, "observed", "it becomes a record to read, not a queue item to answer");
  assert.equal(thawed.autonomy_tier, "announce");
  assert.equal(thawed.context.review_required, false);
});

test("the thaw supersedes a stale-evidence draft with a receipt instead of adopting it", () => {
  // The live cases: diet-break / maintenance drafts written before the cut was
  // reaffirmed. Adopting one on thaw would apply a plan the athlete's own picture has
  // already contradicted, so it is set aside with a reason they can read.
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "auto: a diet break", "", {
    kind: "nutrition_target",
    summary: "Move intake toward maintenance for a week",
    nutrition: { target_kcal: 2600, protein_g: 170 },
  });
  // Nutrition drafts now carry a bodyweight/maintenance snapshot; a weigh-in trend
  // that wasn't there when the draft was written is the contradiction this case
  // exists for (legacy unverified drafts with no snapshot still supersede too).
  const today = localDateISO();
  const ago = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  repo.logWeight(180, ago(14));
  repo.logWeight(176, ago(7));
  repo.logWeight(172, ago(1));
  const held = heldReviewDecision(proposal.id);
  assert.equal(held.decision.status, "review");

  const result = thawParkedReviewDecisions();
  assert.equal(result.superseded, 1, "it is set aside, not adopted");
  assert.equal(result.thawed, 0);

  const after = repo.getProposal(Number(proposal.id));
  assert.equal(after.status, "superseded", "the stale draft can never auto-apply later");

  const receipt = repo
    .listBrainDecisions({ limit: 50 })
    .find((decision) => decision.action?.outcome === "superseded_stale_evidence");
  assert.ok(receipt, "a receipt decision records the supersession");
  assert.equal(Number(receipt.action.proposal_id), Number(proposal.id));
  assert.equal(receipt.context.thaw_receipt, true);
  assert.match(receipt.rationale, /Nothing changed/, "the receipt says plainly that nothing was applied");
  assert.doesNotMatch(receipt.rationale, /must|you have to|required/i, "no gate language in athlete-facing prose");
});

test("the thaw does nothing at all under review_everything", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedPlanDay();
  const proposal = trainingDraft("A change parked while the athlete reviews everything");
  const held = heldReviewDecision(proposal.id);

  const result = thawParkedReviewDecisions();
  assert.deepEqual(result, { thawed: 0, superseded: 0, skipped: 0 });
  assert.equal(repo.getBrainDecision(Number(held.decision.id)).status, "review");
  assert.equal(repo.getProposal(Number(proposal.id)).status, "draft");
});

test("an explicit review_everything still demotes everything to ask", () => {
  const ask = { kind: "training_target", risk_class: "low", reversible: true, lead_mode: "review_everything" };
  assert.equal(decideAutonomyTier(ask).tier, "ask");
  assert.equal(decideAutonomyTier({ ...ask, kind: "training_structure" }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...ask, kind: "nutrition_target", magnitude: 50 }).tier, "ask");
  assert.equal(defaultAutonomyTier({ ...ask, lead_mode: undefined }), "quiet_apply");
});

test("the adoption sweep runs the thaw on the same tick", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = trainingDraft("A change parked by a since-elapsed budget week");
  heldReviewDecision(proposal.id);

  const sweep = adoptOrphanedDrafts();
  assert.equal(sweep.thawed, 1, "no separate scheduler wiring is needed for the thaw to run");
  assert.equal(typeof sweep.adopted, "number");
});

// ---------- a parked PENDING CHANGE is never thawed as an advisory ----------
// applyDueAnnouncedDecisions parks a meal-plan or goal-date decision at review when the
// change itself failed to land ("could not become current", "the goal date did not reach
// the profile"). Those carry the pending change in `action`, not behind a plan_proposal
// row, so the thaw's draft lookup cannot see them. Reading them as advisory would observe
// the change away and take the recorded apply_error with it.

function parkedPendingChange({ kind, domain, action, error }) {
  return repo.recordDecision({
    effective_date: null,
    kind,
    domain,
    summary: `A ${kind} change that failed to land`,
    rationale: null,
    source: "autonomy",
    source_ref_type: null,
    source_ref_key: null,
    status: "review",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: false,
    context: { review_required: true, apply_error: error },
    action,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

test("the thaw leaves a parked MEAL-PLAN change parked, with its apply_error intact", () => {
  repo.setSettings({ lead_mode: "lead" });
  const parked = parkedPendingChange({
    kind: "meal_plan",
    domain: "nutrition",
    action: { meal_plan_id: 4242, previous_meal_plan_id: null },
    error: "the meal plan could not become current",
  });
  const id = Number(parked.decision.id);

  const result = thawParkedReviewDecisions();
  assert.equal(result.thawed, 0, "a pending change is not a reading to be observed away");
  assert.equal(result.superseded, 0);
  assert.equal(result.skipped, 1);

  const after = repo.getBrainDecision(id);
  assert.equal(after.status, "review", "the change still waits for the athlete");
  assert.equal(after.context.review_required, true, "and still says so");
  assert.equal(after.context.apply_error, "the meal plan could not become current", "the receipt survives");
  assert.equal(Number(after.action.meal_plan_id), 4242, "the change itself is still attached");
  assert.equal(after.context.thaw_outcome, undefined, "it was never re-offered");
  assert.equal(after.context.thaw_attempted, undefined, "and never even stamped");
});

test("the thaw leaves a parked GOAL-DATE change parked, with its apply_error intact", () => {
  repo.setSettings({ lead_mode: "lead" });
  const parked = parkedPendingChange({
    kind: "goal_change",
    domain: "nutrition",
    action: {
      goal_date_adaptation: {
        from: "2026-09-01",
        to: "2026-10-06",
        weeks_added: 5,
        reason: "the pace cannot reach it",
      },
    },
    error: "the goal date did not reach the profile",
  });
  const id = Number(parked.decision.id);

  const result = thawParkedReviewDecisions();
  assert.equal(result.thawed, 0);
  assert.equal(result.skipped, 1);

  const after = repo.getBrainDecision(id);
  assert.equal(after.status, "review");
  assert.equal(after.context.review_required, true);
  assert.equal(after.context.apply_error, "the goal date did not reach the profile");
  assert.equal(after.action.goal_date_adaptation.to, "2026-10-06", "the date it wanted is still on the row");
  assert.equal(after.context.thaw_attempted, undefined);
});

test("a thawed decision keeps its ledger row and its undo machinery", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = trainingDraft("A bounded nudge parked and then re-offered");
  const held = heldReviewDecision(proposal.id);
  const heldId = Number(held.decision.id);

  thawParkedReviewDecisions();

  // The original hold is retired rather than left dangling, and the re-offer owns a
  // real decision row with a boundary of its own.
  const retired = repo.getBrainDecision(heldId);
  assert.notEqual(retired.status, "review", "the stale hold does not linger beside the live decision");
  const live = repo.getProposal(Number(proposal.id)).autonomy;
  assert.ok(live, "the proposal carries an autonomy decision after the thaw");
  assert.ok(["pending", "announced", "applied"].includes(String(live.status)));
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?`
      )
      .get(String(proposal.id)).n >= 2,
    true,
    "the hold and the re-offer are both preserved as history"
  );
});
