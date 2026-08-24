import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAutonomyTier,
  defaultAutonomyTier,
  domainShouldDemote,
  surpriseBudgetAllows,
} from "../dist/brain/autonomy.js";

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

test("a missing lead_mode resolves as lead, not as review-everything", () => {
  const { lead_mode: _omitted, ...without } = base;
  assert.equal(without.lead_mode, undefined);
  assert.equal(defaultAutonomyTier(without), "quiet_apply");
  assert.equal(decideAutonomyTier(without).tier, "quiet_apply");
  assert.equal(decideAutonomyTier({ ...without, lead_mode: null }).tier, "quiet_apply");
  assert.equal(decideAutonomyTier({ ...without, risk_class: "high" }).tier, "announce");
  assert.equal(decideAutonomyTier({ ...without, kind: "goal_change" }).tier, "announce");
});

test("model tier can be demoted by policy but never promoted", () => {
  assert.equal(decideAutonomyTier({ ...base, requested_tier: "observe" }).tier, "quiet_apply");
  assert.equal(decideAutonomyTier({ ...base, requested_tier: "ask" }).tier, "ask");
});

test("clinical, locked, clamp-refused, and irreversible boundaries are sovereign", () => {
  assert.equal(decideAutonomyTier({ ...base, clinical: true }).tier, "clinician");
  assert.equal(decideAutonomyTier({ ...base, user_locked: true }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, clamp_refused: true }).tier, "ask");
  assert.equal(decideAutonomyTier({ ...base, reversible: false }).tier, "ask");
  // Goal identity deliberately LEFT this list on 2026-08-17: under lead it announces with
  // a one-tap undo, because goals are meant to adapt from the signals. It is still an ask
  // in the other two lead modes, and a user lock still outranks it. The full table lives
  // in test/headsUpAutonomy.test.js.
  assert.equal(decideAutonomyTier({ ...base, goal_identity: true }).tier, "announce");
  assert.equal(
    decideAutonomyTier({ ...base, goal_identity: true, lead_mode: "review_everything" }).tier,
    "ask"
  );
});

test("structural and large nutrition changes announce at a natural boundary", () => {
  assert.equal(decideAutonomyTier({ ...base, kind: "training_structure" }).tier, "announce");
  assert.equal(decideAutonomyTier({ ...base, kind: "nutrition_target", magnitude: 300 }).tier, "announce");
});

test("repeated reversals demote a domain and the surprise budget stays calm", () => {
  assert.equal(domainShouldDemote(2, 3), true);
  assert.equal(domainShouldDemote(1, 3), false);
  assert.equal(decideAutonomyTier({ ...base, domain_demoted: true }).tier, "announce");
  // The pace moved from one to three material changes per domain-week on 2026-08-17.
  assert.equal(surpriseBudgetAllows(0), true);
  assert.equal(surpriseBudgetAllows(2), true);
  assert.equal(surpriseBudgetAllows(3), false);
  assert.equal(surpriseBudgetAllows(4, true), true);
});
