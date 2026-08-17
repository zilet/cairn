import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyGoalDateAdaptationWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";

// The seam a cut-target derivation calls to MOVE the goal date. It owns the policy and
// the ledger, never the arithmetic: the caller decides the date should move and to where,
// this decides whether the athlete is told first and guarantees they can put it back.
// Under lead a goal change announces with a one-tap undo (2026-08-17 ruling); the other
// lead modes, a user lock and a clinical flag all still ask.

const ADAPTATION = {
  from: "2026-09-01",
  to: "2026-09-29",
  weeks_added: 4,
  reason: "The measured rate of loss has been slower than the plan assumed for three weeks.",
};

function seedGoalDate(date = ADAPTATION.from) {
  repo.setProfile({ goal_date: date, goal_weight_lb: 164 });
  assert.equal(repo.getProfile().goal_date, date, "precondition: the profile carries the starting goal date");
}

test("lead: a goal-date adaptation announces and lands at its boundary with an undo", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate();

  const routed = applyGoalDateAdaptationWithAutonomy(ADAPTATION);
  assert.equal(routed.ok, true);
  assert.equal(routed.announced, true, "a goal change is a heads-up under lead, not a question");
  assert.equal(routed.tier, "announce");
  assert.equal(routed.review_required, undefined);
  assert.equal(routed.decision.status, "announced");
  assert.equal(routed.decision.kind, "goal_change");
  assert.equal(repo.getProfile().goal_date, ADAPTATION.from, "nothing is written before the boundary");

  const due = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(due.applied, [routed.decision.id]);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.to, "the date lands at its natural boundary");

  const landed = repo.getBrainDecision(routed.decision.id);
  assert.equal(landed.status, "applied");
  assert.equal(landed.reversible, true, "an announced goal change is only allowed because undo exists");
  assert.equal(landed.context.rollback_available, true);

  const undone = revertDecision(routed.decision.id, "user undo");
  assert.equal(undone.ok, true);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.from, "one tap puts the original date back");
  assert.equal(repo.getBrainDecision(routed.decision.id).status, "reverted");
});

test("review_everything and announce_first still ask before a goal date moves", () => {
  for (const lead_mode of ["review_everything", "announce_first"]) {
    repo.setSettings({ lead_mode });
    seedGoalDate();
    const routed = applyGoalDateAdaptationWithAutonomy(ADAPTATION);
    assert.equal(routed.review_required, true, lead_mode);
    assert.equal(routed.tier, "ask", lead_mode);
    assert.equal(routed.decision.status, "review", lead_mode);
    assert.equal(routed.effective_date, null, lead_mode);
    assert.equal(repo.getProfile().goal_date, ADAPTATION.from, `${lead_mode}: the date is untouched`);
  }
});

test("a user lock and a clinical flag outrank the heads-up under lead", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate();
  assert.equal(applyGoalDateAdaptationWithAutonomy(ADAPTATION, { user_locked: true }).tier, "ask");
  seedGoalDate();
  assert.equal(applyGoalDateAdaptationWithAutonomy(ADAPTATION, { clinical: true }).tier, "clinician");
  assert.equal(repo.getProfile().goal_date, ADAPTATION.from, "neither wrote anything");
});

test("the athlete's own hand wins: a goal date they moved cancels the waiting adaptation", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate();
  const routed = applyGoalDateAdaptationWithAutonomy(ADAPTATION);
  assert.equal(routed.announced, true);

  // The athlete sets their own date while the adaptation waits.
  repo.setProfile({ goal_date: "2026-10-15" });

  const due = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(due.applied, [], "a stale adaptation never overwrites a date the athlete set");
  assert.deepEqual(due.failed, [routed.decision.id]);
  assert.equal(repo.getBrainDecision(routed.decision.id).status, "canceled");
  assert.equal(repo.getProfile().goal_date, "2026-10-15", "their date stands");
});

test("undo leaves a goal date the athlete changed after the fact alone", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate();
  const routed = applyGoalDateAdaptationWithAutonomy(ADAPTATION);
  applyDueAnnouncedDecisions(routed.effective_date);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.to);

  repo.setProfile({ goal_date: "2026-11-01" });
  const undone = revertDecision(routed.decision.id, "user undo");
  assert.equal(undone.ok, true, "the decision still reverts");
  assert.equal(repo.getProfile().goal_date, "2026-11-01", "but it does not reach past a later hand-set date");
});

test("a no-op adaptation writes nothing and records no decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate(ADAPTATION.to);
  const before = repo.listBrainDecisions({ kind: "goal_change", limit: 50 }).length;
  const result = applyGoalDateAdaptationWithAutonomy(ADAPTATION);
  assert.equal(result.changed, false, "the date is already where the derivation wants it");
  assert.equal(result.decision, undefined);
  assert.equal(repo.listBrainDecisions({ kind: "goal_change", limit: 50 }).length, before);
});

test("an adaptation derived from a goal date the profile no longer holds is refused", () => {
  // The derivation's arithmetic was done against a date that has since changed, so `to`
  // cannot be trusted either. Refusing beats half-trusting it.
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate("2026-10-20");
  const result = applyGoalDateAdaptationWithAutonomy(ADAPTATION);
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer holds/);
  assert.equal(result.derived_from, ADAPTATION.from);
  assert.equal(result.current_goal_date, "2026-10-20");
  assert.equal(repo.getProfile().goal_date, "2026-10-20", "nothing was written");
});

test("a malformed target date is a designed refusal, not a throw", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoalDate();
  const result = applyGoalDateAdaptationWithAutonomy({ ...ADAPTATION, to: "next spring" });
  assert.equal(result.ok, false);
  assert.match(result.error, /YYYY-MM-DD/);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.from);
});

test("a first-ever goal date (from: null) is supported end to end", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile({ goal_date: "" });
  assert.ok(!repo.getProfile().goal_date, "precondition: no goal date on file");

  const routed = applyGoalDateAdaptationWithAutonomy({ ...ADAPTATION, from: null });
  assert.equal(routed.announced, true);
  applyDueAnnouncedDecisions(routed.effective_date);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.to);

  revertDecision(routed.decision.id, "user undo");
  assert.ok(!repo.getProfile().goal_date, "undo returns it to having no goal date at all");
});
