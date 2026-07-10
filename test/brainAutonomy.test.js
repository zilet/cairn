import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutonomyTier, domainShouldDemote, surpriseBudgetAllows } from "../dist/brain/autonomy.js";

const base = {
  kind: "training_target",
  risk_class: "low",
  reversible: true,
  lead_mode: "lead",
};

test("low-risk reversible target changes may quiet-apply only in lead mode", () => {
  assert.equal(decideAutonomyTier(base).tier, "quiet_apply");
  assert.equal(decideAutonomyTier({ ...base, lead_mode: "announce_first" }).tier, "announce");
  assert.equal(decideAutonomyTier({ ...base, lead_mode: "review_everything" }).tier, "ask");
});

test("model tier can be demoted by policy but never promoted", () => {
  assert.equal(decideAutonomyTier({ ...base, requested_tier: "observe" }).tier, "quiet_apply");
  assert.equal(decideAutonomyTier({ ...base, requested_tier: "ask" }).tier, "ask");
});

test("clinical, goal identity, locked, clamp-refused, and irreversible boundaries are sovereign", () => {
  assert.equal(decideAutonomyTier({ ...base, clinical: true }).tier, "clinician");
  assert.equal(decideAutonomyTier({ ...base, goal_identity: true }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, user_locked: true }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, clamp_refused: true }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, reversible: false }).tier, "ask");
});

test("structural and large nutrition changes announce at a natural boundary", () => {
  assert.equal(decideAutonomyTier({ ...base, kind: "training_structure" }).tier, "announce");
  assert.equal(decideAutonomyTier({ ...base, kind: "nutrition_target", magnitude: 300 }).tier, "announce");
});

test("repeated reversals demote a domain and the surprise budget stays calm", () => {
  assert.equal(domainShouldDemote(2, 3), true);
  assert.equal(domainShouldDemote(1, 3), false);
  assert.equal(decideAutonomyTier({ ...base, domain_demoted: true }).tier, "announce");
  assert.equal(surpriseBudgetAllows(0), true);
  assert.equal(surpriseBudgetAllows(1), false);
  assert.equal(surpriseBudgetAllows(4, true), true);
});
