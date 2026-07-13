import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptOrphanedDrafts, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";

// The autonomy pass adopts orphaned drafts: a bounded, reversible change parked as a
// bare `draft` with no autonomy decision behind it (demoted by a since-fixed policy, or
// proposed in a since-elapsed budget week) is re-offered to the autonomy layer so the
// system adapts without the athlete. Deterministic, no agent, cheap enough to run every
// scheduler tick.

// createProposal stamps created_at = datetime('now'); rewrite it to a controlled instant
// so the 2-hour grace window is exercised deterministically regardless of the host tz
// (ISO-with-Z is parsed as UTC, matching Date.now()).
function backdateHours(id, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

function nutritionDraft(instruction, kcal = 2200) {
  return repo.createProposal("stub", instruction, "", {
    kind: "nutrition_target",
    summary: "A small measured intake adjustment",
    nutrition: { target_kcal: kcal, protein_g: 170, reason: "The measured trend missed its expected band." },
  });
}

// A recent same-kind veto (rejected/reverted within the veto window) with no side effects
// on the surprise budget (rejected decisions don't count toward it).
function seedRejectedNutritionVeto() {
  return repo.recordDecision({
    effective_date: null,
    kind: "nutrition_target",
    domain: "nutrition",
    summary: "A previously vetoed intake nudge",
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "rejected",
    autonomy_tier: "ask",
    risk_class: "low",
    reversible: false,
    context: null,
    action: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });
}

test("adopts an orphaned bounded nutrition draft older than 2h under lead (quiet-apply)", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1, "the orphaned draft is adopted");

  const pending = repo.listBrainDecisions({ kind: "nutrition_target" });
  assert.equal(pending.length, 1, "exactly one nutrition decision now exists");
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].autonomy_tier, "quiet_apply");
  assert.equal(pending[0].source_ref_key, String(draft.id), "the decision points at the adopted draft");
});

test("after a recent same-kind veto the orphaned draft is adopted as ANNOUNCED, not quiet-applied", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedRejectedNutritionVeto();
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1);

  const announced = repo.listBrainDecisions({ status: "announced", kind: "nutrition_target" });
  assert.equal(announced.length, 1, "the adoption announced rather than quiet-applied");
  assert.equal(announced[0].autonomy_tier, "announce");
  assert.ok(announced[0].effective_date, "an announced change lands at a natural boundary");
  assert.equal(announced[0].source_ref_key, String(draft.id));
});

test("a draft younger than the 2h grace window is left untouched", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = nutritionDraft("just proposed", 2250);
  backdateHours(draft.id, 0.25); // 15 minutes old — still mid-conversation

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 0, "a fresh draft is not adopted");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 0, "no decision was recorded");
  assert.equal(repo.getProposal(draft.id).status, "draft", "it stays a plain draft");
});

test("under review_everything the layer holds at 'ask', so the draft stays a plain reviewable draft", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 0, "review posture holds it — no adoption");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 0, "no decision was recorded");
  assert.equal(repo.getProposal(draft.id).status, "draft", "it stays a reviewable draft for a later pass");
});

test("a draft already autonomy-owned is skipped — no second decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  const draft = nutritionDraft("weekly nutrition response", 2250);
  backdateHours(draft.id, 3);
  // Route it through the autonomy layer once so it already carries a live decision.
  const first = applyProposalWithAutonomy(draft.id, { requested_tier: "quiet_apply" });
  assert.equal(first.pending, true);
  assert.ok(repo.getProposal(draft.id).autonomy, "the draft is now autonomy-owned");

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 0, "an already-owned draft is not re-adopted");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 1, "still exactly one decision");
});

test("with two orphaned drafts of the same kind, only the newest is adopted", () => {
  repo.setSettings({ lead_mode: "lead" });
  const older = nutritionDraft("older nutrition response", 2240);
  const newer = nutritionDraft("newer nutrition response", 2260); // higher id → newest
  backdateHours(older.id, 5);
  backdateHours(newer.id, 3);

  const result = adoptOrphanedDrafts();
  assert.equal(result.adopted, 1, "at most one adoption per kind per pass");

  const decisions = repo.listBrainDecisions({ kind: "nutrition_target" });
  assert.equal(decisions.length, 1, "only one decision was recorded");
  assert.equal(decisions[0].source_ref_key, String(newer.id), "the newest draft won");
  assert.equal(repo.getProposal(older.id).status, "draft", "the older draft is left for the supersede flows");
  assert.ok(!repo.getProposal(older.id).autonomy, "the older draft remains orphaned");
});
