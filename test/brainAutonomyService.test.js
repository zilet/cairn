import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
}

test("lead mode quiet-applies a bounded target with rollback and one-turn veto", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "plateau", "", {
    summary: "Small bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120, reason: "earned" }],
  });
  const applied = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);
  assert.equal(applied.tier, "quiet_apply");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
  assert.equal(applied.decision.context.rollback_available, true);
  assert.ok(repo.getBrainRollback(applied.decision.id));

  const reverted = revertDecision(applied.decision.id, "that did not work for me");
  assert.equal(reverted.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
  assert.equal(repo.getBrainDecision(applied.decision.id).status, "reverted");
  assert.equal(
    repo.latestBrainEvaluation(repo.listBrainExpectations({ decisionId: applied.decision.id })[0].id).verdict,
    "canceled"
  );
});

test("undo restores only decision-owned plan fields and preserves later edits", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "plateau", "", {
    summary: "Small bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120, reason: "earned" }],
  });
  const applied = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(applied.ok, true);

  // This happened after the coaching decision and must survive its Undo.
  repo.savePlanDay(2, "Pull", "Back", [
    { exercise: "Single-Arm Dumbbell Row", sets: 4, rep_low: 8, rep_high: 10, target_weight: 55 },
  ]);
  repo.updateTarget(1, "Barbell Bench Press", 125);

  const reverted = revertDecision(applied.decision.id, "undo the older coaching change");
  assert.equal(reverted.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 125, "a newer user target wins");
  assert.equal(repo.getPlanDay(2).items[0].target_weight, 55, "an unrelated later day survives");
});

test("announce-first schedules structure and applies it at the boundary without a tap", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "announce_first" });
  const proposal = repo.createProposal("stub", "new split", "", {
    summary: "Two-day structure",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  });
  const announced = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  assert.equal(announced.announced, true);
  assert.equal(repo.getPlan().length, 1);
  const due = applyDueAnnouncedDecisions(announced.effective_date);
  assert.deepEqual(due.applied, [announced.decision.id]);
  assert.equal(repo.getPlan().length, 2);
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "applied");
  assert.equal(
    repo.listBrainDecisions({ kind: "training_structure" }).length,
    1,
    "the boundary applies into the announced record instead of creating a duplicate"
  );
});

test("hold on cancels an announced change before its boundary", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "announce_first" });
  const proposal = repo.createProposal("stub", "new split", "", {
    summary: "Two-day structure",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  });
  const announced = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  const held = revertDecision(announced.decision.id, "hold on");
  assert.equal(held.ok, true);
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "canceled");
  assert.deepEqual(applyDueAnnouncedDecisions(announced.effective_date).applied, []);
  assert.equal(repo.getPlan().length, 1);
});

test("review-everything and clinical boundaries never auto-apply", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "review_everything" });
  const proposal = repo.createProposal("stub", "change", "", {
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
  });
  const held = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(held.applied, false);
  assert.equal(held.tier, "ask");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
});

test("a quiet nutrition adjustment waits for the next day boundary", () => {
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "weekly nutrition response", "", {
    kind: "nutrition_target",
    summary: "Small measured intake adjustment",
    nutrition: { target_kcal: 2_250, protein_g: 170, reason: "The measured trend missed its expected band." },
  });
  const pending = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(pending.pending, true);
  assert.equal(repo.getProposal(proposal.id).status, "draft");
  const due = applyDueAnnouncedDecisions(pending.effective_date);
  assert.deepEqual(due.applied, [pending.decision.id]);
  assert.equal(repo.getProposal(proposal.id).status, "applied");
  assert.equal(repo.getBrainDecision(pending.decision.id).status, "applied");
  assert.equal(repo.listBrainDecisions({ kind: "nutrition_target" }).length, 1);
  assert.equal(
    repo.getAppState("meal_plan_refresh_requested"),
    pending.effective_date,
    "a landed fuel target asks the background team to realign meals"
  );
});

test("surprise-budget exhaustion requires an explicit review instead of silently announcing", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const first = repo.createProposal("stub", "first bounded change", "", {
    summary: "First bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
  });
  assert.equal(applyProposalWithAutonomy(first.id, { requested_tier: "quiet_apply" }).applied.length, 1);

  const second = repo.createProposal("stub", "second bounded change", "", {
    summary: "Second bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 125 }],
  });
  const held = applyProposalWithAutonomy(second.id, { requested_tier: "quiet_apply" });
  assert.equal(held.applied, false);
  assert.equal(held.tier, "ask");
  assert.equal(held.review_required, true);
  assert.match(held.reasons.join(" "), /weekly surprise budget already used/i);
  assert.equal(repo.getProposal(second.id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
});

test("stale proposal snapshots require a fresh review before autonomous apply", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const proposal = repo.createProposal("stub", "old target", "", {
    summary: "Old bench change",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
  });
  db.prepare(`UPDATE plan_proposals SET created_at = datetime('now','-8 days') WHERE id = ?`).run(proposal.id);

  const held = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(held.applied, false);
  assert.equal(held.review_required, true);
  assert.equal(held.tier, "ask");
  assert.match(held.reasons.join(" "), /older than 7 days/i);
  assert.equal(repo.getProposal(proposal.id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
});

test("a throwing due decision parks in review and never blocks the rest of the pass", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "announce_first" });
  const structure = (name) => ({
    summary: `${name} structure`,
    days: [
      {
        day_number: 1,
        name,
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  });
  const broken = applyProposalWithAutonomy(repo.createProposal("stub", "broken", "", structure("Broken")).id, {
    requested_tier: "announce",
  });
  // A different domain, so the surprise budget cannot mask the isolation being tested.
  const healthy = applyProposalWithAutonomy(
    repo.createProposal("stub", "healthy nutrition", "", {
      kind: "nutrition_target",
      summary: "Small measured intake adjustment",
      nutrition: { target_kcal: 2_250, protein_g: 170, reason: "Measured drift." },
    }).id,
    { requested_tier: "quiet_apply" }
  );
  // Corrupt the first proposal's payload so its apply throws at the boundary.
  db.prepare(`UPDATE plan_proposals SET parsed_json = ? WHERE id = ?`).run(
    JSON.stringify({ summary: "no actionable shape" }),
    Number(broken.decision.action.proposal_id)
  );

  const due = applyDueAnnouncedDecisions(broken.effective_date);
  assert.deepEqual(due.applied, [healthy.decision.id], "the healthy change still lands");
  assert.deepEqual(due.failed, [broken.decision.id]);
  const parked = repo.getBrainDecision(broken.decision.id);
  assert.equal(parked.status, "review", "the throwing decision reaches a reviewable status");
  assert.ok(parked.context.apply_error);

  // The next pass must not re-touch either decision.
  const rerun = applyDueAnnouncedDecisions(broken.effective_date);
  assert.deepEqual(rerun.applied, []);
  assert.deepEqual(rerun.failed, []);
});

test("an announced decision whose proposal was applied elsewhere cancels instead of re-applying", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "announce_first" });
  const proposal = repo.createProposal("stub", "structure", "", {
    summary: "Two-day structure",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  });
  const announced = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  // The user applies the draft manually before the boundary arrives.
  repo.applyProposal(proposal.id);
  assert.equal(repo.getPlan().length, 2);

  const due = applyDueAnnouncedDecisions(announced.effective_date);
  assert.deepEqual(due.applied, [], "the boundary never re-applies an already-applied proposal");
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "canceled");
});

test("a manual apply cancels the standing announcement at once and re-apply is refused", () => {
  seedPlan();
  repo.setSettings({ lead_mode: "announce_first" });
  const proposal = repo.createProposal("stub", "structure", "", {
    summary: "Two-day structure",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }],
      },
      {
        day_number: 2,
        name: "Lower",
        focus: "Lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
      },
    ],
  });
  const announced = applyProposalWithAutonomy(proposal.id, { requested_tier: "announce" });
  assert.equal(repo.getBrainDecision(announced.decision.id).status, "announced");

  const manual = repo.applyProposal(proposal.id);
  assert.equal(manual.ok, true);
  assert.equal(
    repo.getBrainDecision(announced.decision.id).status,
    "canceled",
    "the announcement is moot the moment the user applies the draft"
  );

  const again = repo.applyProposal(proposal.id);
  assert.equal(again.ok, false);
  assert.match(String(again.error), /already applied/i);
  assert.equal(repo.getPlan().length, 2, "the plan was applied exactly once");
});
