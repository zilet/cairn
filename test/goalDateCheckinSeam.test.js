import assert from "node:assert/strict";
import test from "node:test";
import { maybeAdaptGoalDateFromCut } from "../dist/coachOps.js";
import { applyDueAnnouncedDecisions } from "../dist/domain/brain/autonomy-service.js";
import { repo } from "./_seed.js";

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

test("a different date is a genuinely new decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedGoal();
  maybeAdaptGoalDateFromCut(derivation(ADAPTATION));
  const moved = maybeAdaptGoalDateFromCut(derivation({ ...ADAPTATION, to: "2026-10-20" }));
  assert.equal(moved.announced, true, "the derivation moved, so the athlete hears the new date");
  assert.equal(goalDecisions().length, 2);
});
