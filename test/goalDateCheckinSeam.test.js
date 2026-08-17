import assert from "node:assert/strict";
import test from "node:test";
import { maybeAdaptGoalDateFromCut } from "../dist/coachOps.js";
import { applyDueAnnouncedDecisions } from "../dist/domain/brain/autonomy-service.js";
import { db, repo } from "./_seed.js";

// Where the cut-target derivation's `goal_date_adaptation` becomes a DECISION.
// deriveCutTarget is read-only and runs behind several surfaces, so the ledger entry is
// made on the nutrition check-in cadence instead — and, because the check-in repeats,
// the same unreachable date must not be announced again every time it comes round.

const ADAPTATION = {
  from: "2026-09-01",
  to: "2026-10-06",
  weeks_added: 5,
  reason: "The lean-safe ceiling cannot reach the goal weight by the date on file.",
};

const derivation = (adaptation) => ({ goal_date_adaptation: adaptation });

function seedGoal(date = ADAPTATION.from) {
  repo.setProfile({ goal_date: date, goal_weight_lb: 164 });
}

const goalDecisions = () => repo.listBrainDecisions({ kind: "goal_change", limit: 50 });

test("a derivation the pace can still reach asks for nothing", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal();
  assert.equal(maybeAdaptGoalDateFromCut(derivation(null)), null);
  assert.equal(maybeAdaptGoalDateFromCut(null), null);
  assert.equal(goalDecisions().length, 0, "no reading became a decision");
});

test("under lead an unreachable goal date announces once, with the date left untouched", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal();
  const routed = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(routed.ok, true);
  assert.equal(routed.announced, true);
  assert.equal(routed.tier, "announce");
  assert.equal(routed.decision.kind, "goal_change");
  assert.equal(repo.getProfile().goal_date, ADAPTATION.from, "nothing is written before the boundary");

  applyDueAnnouncedDecisions(routed.effective_date);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.to, "it lands at its own natural boundary");
});

test("the next check-in does not re-announce a goal date already waiting", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal();
  const first = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(first.announced, true);
  const after = goalDecisions().length;

  const second = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(second.changed, false);
  assert.equal(second.deduped, true);
  assert.equal(second.decision, undefined);
  assert.equal(goalDecisions().length, after, "the cadence repeating did not cost a second ledger row");
});

test("a date already on the profile is a no-op, not a fresh announcement", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal(ADAPTATION.to);
  const result = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(result.changed, false);
  assert.equal(result.decision, undefined);
  assert.equal(goalDecisions().length, 0);
});

test("a stricter posture asks, and the parked question is not re-asked next cadence", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedGoal();
  const first = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(first.review_required, true);
  assert.equal(first.tier, "ask");
  assert.equal(first.decision.status, "review");
  const after = goalDecisions().length;

  const second = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(second.deduped, true);
  assert.equal(goalDecisions().length, after, "a question already waiting is not asked twice");
  assert.equal(repo.getProfile().goal_date, ADAPTATION.from, "and nothing was written either time");
});

// ---- the ratchet guards ----
// The derivation re-projects the arrival from TODAY on every read, so the date drifts a
// little by construction. Without a bar on how far it must have slipped, and a floor on
// how often the question may be put at all, one applied adaptation is followed by a
// slightly later one next week and the athlete's goal identity is renegotiated forever.

const backdateGoalDecisions = (days) => {
  db.prepare(`UPDATE brain_decisions SET created_at = datetime('now', ?) WHERE kind = 'goal_change'`).run(
    `-${days} days`
  );
};

test("a projection a few days past the date on file is not worth moving a goal for", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal("2026-09-01");
  const result = maybeAdaptGoalDateFromCut(derivation({ ...ADAPTATION, to: "2026-09-07" }));
  assert.equal(result.changed, false);
  assert.equal(result.immaterial, true);
  assert.equal(result.decision, undefined);
  assert.equal(goalDecisions().length, 0, "six days of drift never reaches the athlete");
  assert.equal(repo.getProfile().goal_date, "2026-09-01");
});

test("a projection a fortnight or more out is material, and does adapt", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal("2026-09-01");
  const result = maybeAdaptGoalDateFromCut(derivation({ ...ADAPTATION, to: "2026-09-21" }));
  assert.equal(result.ok, true);
  assert.equal(result.announced, true);
  assert.equal(goalDecisions().length, 1);
});

test("a second material projection soon after a goal change waits, however different the date", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal();
  const first = maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  assert.equal(first.announced, true);
  applyDueAnnouncedDecisions(first.effective_date);
  assert.equal(repo.getProfile().goal_date, ADAPTATION.to, "the first one landed");

  // Eight days later the projection has slipped materially again — an APPLIED change is
  // still a change the athlete heard about, so the cooldown counts it.
  backdateGoalDecisions(8);
  const again = maybeAdaptGoalDateFromCut(derivation({ from: ADAPTATION.to, to: "2026-11-10", weeks_added: 5 }));
  assert.equal(again.changed, false);
  assert.equal(again.cooldown, true);
  assert.equal(goalDecisions().length, 1, "the goal date is not renegotiated every cadence");
  assert.equal(repo.getProfile().goal_date, ADAPTATION.to, "and nothing moved");
});

test("once the cooldown has passed a genuinely moved date is heard again", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal();
  maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  backdateGoalDecisions(20);
  const moved = maybeAdaptGoalDateFromCut(derivation({ from: ADAPTATION.from, to: "2026-11-10", weeks_added: 5 }));
  assert.equal(moved.announced, true, "the guard is a cooldown, not a permanent silence");
  assert.equal(goalDecisions().length, 2);
});
