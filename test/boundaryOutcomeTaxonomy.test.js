// WHY A BOUNDARY CHANGE DID NOT APPLY, AND WHAT MAY RE-OFFER IT AFTERWARDS.
//
// Two live defects sit behind this file. (1) Every non-applying ending of the
// natural-boundary pass was reported to telemetry as one generic `Error`, so an
// operator saw `worker:final_failure:apply:announced_boundary:Error` every single day
// and could never tell a broken payload from the system working exactly as designed.
// (2) An age-REJECTED draft stayed at `draft`, so the orphan-adoption sweep re-adopted
// it within the minute, the autonomy layer re-announced it, and the next boundary
// rejected it again for the same reason — one identical refusal a day, forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adoptOrphanedDrafts,
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  thawParkedReviewDecisions,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";
import { tsDaysAgo } from "./_seed.js";

// Seeded BEFORE any draft: createProposal fingerprints the plan it was written against,
// so a plan written afterwards reads as changed evidence and sends every case here down
// the staleness path instead of the one under test.
function seedPlanDay() {
  repo.savePlanDay(1, "Push", "chest", [{ exercise: "ZBoundary Press", sets: 3, target_weight: 100 }]);
}

// `auto:` provenance is what makes a bare draft eligible for orphan adoption; agent
// "stub" keeps it out of the regeneration path, which keys off the producer's name.
function automaticDraft(summary = "A bounded target nudge") {
  return repo.createProposal("stub", `auto: ${summary}`, "", {
    summary,
    changes: [{ day_number: 1, exercise: "ZBoundary Press", target_weight: 105, reason: summary }],
  });
}

function backdateProposal(id, days) {
  db.prepare(`UPDATE plan_proposals SET created_at = ? WHERE id = ?`).run(tsDaysAgo(days), Number(id));
}

function decisionsForProposal(proposalId) {
  return repo
    .listBrainDecisions({ limit: 200 })
    .filter(
      (decision) =>
        Number(decision.action?.proposal_id) === Number(proposalId) ||
        (decision.source_ref_type === "plan_proposal" && decision.source_ref_key === String(proposalId))
    );
}

// ---------- the taxonomy ----------

test("an age-rejected draft names its ending as a calm one, and is retired with the decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge that waited too long");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  assert.equal(announced.decision.status, "announced");
  // Past the 7-day ceiling for a bounded target change, with its evidence unmoved.
  backdateProposal(proposal.id, 10);

  const due = applyDueAnnouncedDecisions(announced.effective_date);
  assert.deepEqual(due.applied, []);
  assert.deepEqual(due.failed, [announced.decision.id]);
  assert.deepEqual(due.failed_outcomes, [
    { id: announced.decision.id, class: "stale_proposal", calm: true },
    // Calm: the age ceiling is a designed refusal with a reason the athlete can read,
    // not a defect an operator can act on.
  ]);
  const rejected = repo.getBrainDecision(announced.decision.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.context.boundary_outcome, "stale_proposal");
  assert.equal(
    repo.getProposal(Number(proposal.id)).status,
    "superseded",
    "a terminal refusal retires the draft it refused"
  );
});

test("the age-rejected draft leaves a receipt the athlete can actually read", () => {
  // `rejected` is not a status any athlete-facing list walks, and the rejected row
  // still carries the ORIGINAL proposal's summary — so from the athlete's side a
  // change they had been told about simply stopped existing. The thaw already
  // writes a receipt for a stale snapshot; the boundary's terminal endings write
  // the same one.
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge that waited too long");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  backdateProposal(proposal.id, 10);
  applyDueAnnouncedDecisions(announced.effective_date);

  const receipt = decisionsForProposal(proposal.id).find((d) => d.status === "superseded");
  assert.ok(receipt, "the ending is on the ledger, not only in the rejected row");
  assert.equal(receipt.summary, "A held draft was set aside instead of applied.");
  assert.equal(receipt.context.thaw_receipt, true);
  assert.equal(receipt.context.review_reason_code, "stale_proposal");
  assert.equal(receipt.context.superseded_review_decision_id, announced.decision.id);
  assert.match(receipt.rationale, /no longer describes where you are/);
  // Athlete-facing register: no engineering vocabulary in the sentence they read.
  assert.doesNotMatch(receipt.rationale, /proposal|status|boundary/i);
  // …and the original decision still carries the machine record.
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "rejected");
});

test("a draft that cannot be retired leaves the decision adoptable, and says so out loud", () => {
  // The retire is what makes the rejection safe: without it the orphan sweep
  // re-adopts the draft within the minute. Swallowing the failure and rejecting
  // anyway strands exactly the pair this ending exists to break — so the retire
  // goes first, and a failure leaves the decision at `review`.
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge that cannot be retired");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  backdateProposal(proposal.id, 10);

  db.exec(
    `CREATE TEMP TRIGGER t_block_retire BEFORE UPDATE OF status ON plan_proposals
     WHEN NEW.status = 'superseded' BEGIN SELECT RAISE(ABORT, 'retire blocked'); END`
  );
  try {
    applyDueAnnouncedDecisions(announced.effective_date);
  } finally {
    db.exec(`DROP TRIGGER IF EXISTS temp.t_block_retire`);
  }

  const held = repo.getBrainDecision(announced.decision.id);
  assert.equal(held.status, "review", "still adoptable — never rejected behind a live draft");
  assert.equal(held.context.retire_failed, true);
  assert.equal(held.context.boundary_outcome, "stale_proposal");
  assert.equal(repo.getProposal(Number(proposal.id)).status, "draft", "the draft really did survive");
});

test("the age-rejected draft is never re-adopted, re-announced, or refused a second time", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge that waited too long");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  backdateProposal(proposal.id, 10);
  applyDueAnnouncedDecisions(announced.effective_date);

  const settledDecisions = decisionsForProposal(proposal.id).length;
  // Three ticks of the real sweep, exactly as the scheduler runs it every 60 seconds.
  for (let tick = 0; tick < 3; tick += 1) {
    const sweep = adoptOrphanedDrafts();
    assert.equal(sweep.adopted, 0, "a refused draft is not free to be re-offered");
    const rerun = applyDueAnnouncedDecisions(announced.effective_date);
    assert.deepEqual(rerun.failed, [], "and so nothing arrives at the boundary to refuse again");
    assert.deepEqual(rerun.failed_outcomes, []);
  }
  assert.equal(
    decisionsForProposal(proposal.id).length,
    settledDecisions,
    "no ledger churn: the refusal is written once, not once a day"
  );
});

test("a proposal that left draft status ends as canceled_moot, also calm", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge the athlete answered elsewhere");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  // Straight to the row: setProposalStatus would cancel the announcement itself, and the
  // ending under test is the boundary meeting a proposal that is no longer live.
  db.prepare(`UPDATE plan_proposals SET status = 'discarded' WHERE id = ?`).run(Number(proposal.id));

  const due = applyDueAnnouncedDecisions(announced.effective_date);
  assert.deepEqual(due.failed_outcomes, [{ id: announced.decision.id, class: "canceled_moot", calm: true }]);
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "canceled");
});

test("a throwing apply is the one ending that is NOT calm", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge whose payload is broken");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  db.prepare(`UPDATE plan_proposals SET parsed_json = ? WHERE id = ?`).run(
    JSON.stringify({ summary: "no actionable shape" }),
    Number(proposal.id)
  );

  const due = applyDueAnnouncedDecisions(announced.effective_date);
  assert.deepEqual(due.failed_outcomes, [{ id: announced.decision.id, class: "apply_threw", calm: false }]);
  const parked = repo.getBrainDecision(announced.decision.id);
  assert.equal(parked.status, "review");
  assert.equal(parked.context.boundary_outcome, "apply_threw");
  assert.ok(parked.context.apply_error, "the per-decision reason still reaches the athlete's ledger");
});

test("a decision pointing at a proposal that no longer exists is a broken reference, not a calm ending", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = automaticDraft("A nudge whose draft vanished");
  const announced = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  db.prepare(`DELETE FROM plan_proposals WHERE id = ?`).run(Number(proposal.id));

  const due = applyDueAnnouncedDecisions(announced.effective_date);
  assert.deepEqual(due.failed_outcomes, [{ id: announced.decision.id, class: "missing_proposal", calm: false }]);
});

// ---------- the conference door ----------
// A case_conference revision with a live draft behind it is a question the conductor put
// to the athlete. The deterministic sweeps may not answer it for them — the live rows
// this exists for are ids 71/72/74, drafted 2026-08-08 and still waiting.

test("a case-conference draft awaiting the athlete is never adopted, set aside, or re-announced", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlanDay();
  const proposal = repo.createProposal("case_conference", "case conference: what should this week be?", "", {
    summary: "A bounded revision the conference proposed",
    changes: [{ day_number: 1, exercise: "ZBoundary Press", target_weight: 110, reason: "conference revision" }],
  });
  const held = repo.recordDecision({
    effective_date: null,
    kind: "case_conference",
    domain: "training",
    summary: "A whole-person read with an executable revision behind it",
    rationale: "The conductor put a bounded revision to the athlete and is waiting on it.",
    source: "case_conference",
    source_ref_type: "plan_proposal",
    source_ref_key: String(proposal.id),
    status: "review",
    autonomy_tier: "ask",
    risk_class: "moderate",
    reversible: false,
    input_fingerprint: null,
    context: { proposal_held: true },
    action: { proposal_id: Number(proposal.id) },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
  const decisionId = Number(held.decision.id);
  const before = decisionsForProposal(proposal.id).length;

  for (let tick = 0; tick < 3; tick += 1) {
    const thaw = thawParkedReviewDecisions();
    assert.equal(thaw.thawed, 0, "the sweep does not adopt the athlete's open question");
    assert.equal(thaw.superseded, 0, "nor does it set it aside on their behalf");
    adoptOrphanedDrafts();
  }

  assert.equal(repo.getProposal(Number(proposal.id)).status, "draft", "the draft is still waiting for them");
  const after = repo.getBrainDecision(decisionId);
  assert.equal(after.status, "review", "and the question is still open");
  assert.equal(after.context.thaw_attempted, undefined, "the sweep did not even stamp the row");
  assert.equal(decisionsForProposal(proposal.id).length, before, "no decision churn across repeated ticks");
});

test("an ADVISORY conference with no draft behind it still thaws out of the review queue", () => {
  // The 2026-08-17 ruling is untouched by the door above: a reading with no change behind
  // it must not sit in the queue asking for a decision that has nothing to approve.
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
    input_fingerprint: null,
    context: { advisory_only: true },
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });

  assert.equal(thawParkedReviewDecisions().thawed, 1);
  assert.equal(repo.getBrainDecision(Number(recorded.decision.id)).status, "observed");
});
