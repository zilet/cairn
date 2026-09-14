// AN ATHLETE'S RESTRUCTURE REQUEST IS HONOURED AT THE BOUNDARY, NOT HELD.
//
// The live failure: the athlete asked in chat for the week rebuilt around Tue/Thu/weekend
// runs. The coach built it Sunday night and announced it for Monday. At Monday's
// boundary the compare-and-set gate found the `context` fingerprint had moved (a
// check-in, a memory — nothing about the plan or the log), an agent-built draft has no
// deterministic producer to regenerate it, so it was parked at `ask`, and the thaw sweep
// set it aside. Meanwhile it had also been budget-deferred behind the automatic weekly
// evolution. The athlete's plan never changed and the "waiting on you" row had no door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import {
  STRUCTURE_REQUEST_INSTRUCTION_PREFIX,
  athleteRestructureLandingDate,
  describeLandingDay,
  isAthleteRequestedRestructure,
  requestFromInstruction,
  structureRequestInstruction,
} from "../dist/domain/brain/structure-request.js";
import * as repo from "../dist/repo.js";
import { localDateISO } from "../dist/repo/shared.js";

const REQUEST = "Run Tuesday, Thursday and a long run on the weekend; fit my lifting around that.";

function seedWeek() {
  repo.savePlanDay(1, "Lower A", "legs", [{ exercise: "Back Squat", sets: 3, target_weight: 200 }]);
  repo.savePlanDay(2, "Push", "chest", [{ exercise: "Barbell Bench Press", sets: 3, target_weight: 120 }]);
}

const restructuredWeek = () => ({
  summary: "Rebuilt the week around the athlete's run days.",
  rationale: "Tuesday and Thursday carry the runs; lower days sit clear of them.",
  days: [
    { day_number: 1, name: "Lower A", focus: "legs", items: [{ exercise: "Back Squat", sets: 3, target_weight: 200 }] },
    {
      day_number: 2,
      name: "Push + Easy Run",
      focus: "chest",
      items: [{ exercise: "Barbell Bench Press", sets: 3, target_weight: 120 }],
    },
    { day_number: 3, name: "Pull", focus: "back", items: [{ exercise: "Pendlay Row", sets: 3, target_weight: 140 }] },
  ],
});

function athleteDraft() {
  return repo.createProposal("stub", structureRequestInstruction(REQUEST), "", restructuredWeek());
}

function automaticDraft() {
  return repo.createProposal("stub", repo.AUTO_EVOLUTION_INSTRUCTION, "", restructuredWeek());
}

function spendTrainingBudget() {
  for (let i = 0; i < 3; i += 1) {
    repo.recordDecision({
      effective_date: localDateISO(),
      kind: "training_target",
      domain: "training",
      summary: `material change ${i}`,
      rationale: null,
      source: "stub",
      source_ref_type: null,
      source_ref_key: null,
      status: "applied",
      autonomy_tier: "quiet_apply",
      risk_class: "low",
      reversible: true,
      input_fingerprint: null,
      context: {},
      action: { n: i },
      specialist: null,
      applied_at: new Date().toISOString(),
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  }
}

test("the instruction prefix is the provenance, and the athlete's words round-trip out of it", () => {
  const instruction = structureRequestInstruction(REQUEST);
  assert.ok(instruction.startsWith(STRUCTURE_REQUEST_INSTRUCTION_PREFIX));
  assert.equal(requestFromInstruction(instruction), REQUEST);
  assert.equal(isAthleteRequestedRestructure({ instruction }), true);
  assert.equal(isAthleteRequestedRestructure({ instruction: repo.AUTO_EVOLUTION_INSTRUCTION }), false);
  assert.equal(isAthleteRequestedRestructure(null), false);
});

test("an athlete-requested restructure lands at THEIR boundary — today, or tomorrow once they trained today", () => {
  const today = localDateISO();
  assert.equal(athleteRestructureLandingDate(today), today, "nothing logged today: it lands today");
  assert.equal(describeLandingDay(today), "today");
  repo.logSetByName({ exercise: "Back Squat", weight: 200, reps: 5, rir: 2, date: today });
  const tomorrow = athleteRestructureLandingDate(today);
  assert.notEqual(tomorrow, today, "a half-lived day is still protected");
  assert.equal(describeLandingDay(tomorrow), "tomorrow");
});

test("announce: the athlete's ask is exempt from the surprise budget and is dated for today, not Monday", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedWeek();
  spendTrainingBudget();
  const proposal = athleteDraft();
  const routed = applyProposalWithAutonomy(Number(proposal.id));
  assert.equal(routed.announced, true, "structural: it still announces, with the heads-up and the Undo");
  assert.equal(routed.decision.status, "announced");
  assert.equal(routed.effective_date, localDateISO(), "the athlete's boundary, not the week's");
  assert.equal(routed.budget_deferred, undefined, "an ask is never a surprise");
  assert.equal(routed.decision.context.surprise_budget_deferred, false);
  assert.equal(routed.decision.context.athlete_requested_restructure, true);
  assert.equal(routed.decision.context.explicit_user_request, true);

  // The very same payload as an AUTOMATIC draft keeps every ordinary ruling.
  const automatic = applyProposalWithAutonomy(Number(automaticDraft().id));
  assert.equal(automatic.budget_deferred, true, "the automatic sibling still waits on the budget");
  assert.notEqual(automatic.effective_date, localDateISO(), "and still targets the week boundary");
});

test("boundary: context-only drift is tolerated for the athlete's ask — it applies, and the drift is on the record", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedWeek();
  const proposal = athleteDraft();
  const routed = applyProposalWithAutonomy(Number(proposal.id));
  // The picture moves between the announcement and the boundary — but only the
  // CONTEXT component (profile / check-ins / memories), never the plan or the log.
  repo.setProfile({ notes: "slept badly, travelling next week" });
  repo.addCheckin(localDateISO(), { energy: 3, source_kind: "app" });

  const due = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(due.applied, [routed.decision.id], "landed");
  assert.deepEqual(due.failed, []);
  assert.deepEqual(due.regenerated, []);
  const landed = repo.getBrainDecision(routed.decision.id);
  assert.equal(landed.status, "applied");
  assert.equal(landed.reversible, true, "with the Undo");
  assert.deepEqual(landed.context.boundary_drift_tolerated, ["context"]);
  assert.equal(repo.getProposal(Number(proposal.id)).status, "applied");
  const plan = repo.getPlan();
  assert.ok(
    plan.some((day) => day.name === "Push + Easy Run"),
    "the athlete's week is now the plan"
  );
});

test("boundary: the SAME context drift still holds an automatic restructure (ordinary ruling untouched)", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedWeek();
  const proposal = automaticDraft();
  const routed = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "announce" });
  repo.setProfile({ notes: "a note that moves the context fingerprint" });
  const due = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(due.applied, []);
  assert.ok(due.failed.includes(routed.decision.id));
  assert.equal(repo.getBrainDecision(routed.decision.id).context.boundary_outcome, "stale_snapshot");
});

test("boundary: plan drift on the athlete's ask REBUILDS it instead of setting it aside", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedWeek();
  const proposal = athleteDraft();
  const routed = applyProposalWithAutonomy(Number(proposal.id));
  // The plan itself moved after the draft was written (a sibling change landed).
  repo.savePlanDay(1, "Lower A", "legs", [{ exercise: "Back Squat", sets: 3, target_weight: 205 }]);

  const jobsBefore = repo.listAgentJobs ? repo.listAgentJobs().length : null;
  const due = applyDueAnnouncedDecisions(routed.effective_date);
  assert.deepEqual(due.applied, []);
  assert.deepEqual(due.failed, [], "not a hold, not a refusal");
  assert.deepEqual(due.regenerated, [routed.decision.id], "a rewrite against today's picture");

  const retired = repo.getBrainDecision(routed.decision.id);
  assert.equal(retired.status, "superseded");
  assert.equal(retired.context.regenerated_reason, "evidence_moved");
  assert.deepEqual(retired.context.changed_components, ["plan"]);
  assert.equal(repo.getProposal(Number(proposal.id)).status, "superseded", "the stale draft is retired with it");

  const jobId = Number(retired.context.structure_rebuild_job_id);
  assert.ok(jobId > 0, "the rebuild is a durable job");
  const job = repo.getAgentJob(jobId);
  assert.equal(job.kind, "evolve_program");
  assert.equal(job.status, "queued");
  assert.equal(job.input.structure_rebuild.of_decision_id, routed.decision.id);
  assert.equal(job.input.structure_rebuild.of_proposal_id, Number(proposal.id));
  assert.equal(job.input.instruction, structureRequestInstruction(REQUEST), "the same ask, verbatim");
  assert.ok(job.input.task.includes(REQUEST), "framed as the same task");
  if (jobsBefore != null) assert.equal(repo.listAgentJobs().length, jobsBefore + 1);

  // Nothing is asked of the athlete: no review row points at the retired draft.
  const holds = repo
    .listBrainDecisions({ status: "review", limit: 50 })
    .filter((d) => Number(d.action?.proposal_id) === Number(proposal.id));
  assert.deepEqual(holds, []);
});

test("boundary: under review_everything the athlete's stale ask is held for them, never rebuilt behind their back", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedWeek();
  const proposal = athleteDraft();
  const routed = applyProposalWithAutonomy(Number(proposal.id));
  repo.savePlanDay(1, "Lower A", "legs", [{ exercise: "Back Squat", sets: 3, target_weight: 205 }]);
  repo.setSettings({ lead_mode: "review_everything" });
  try {
    const due = applyDueAnnouncedDecisions(routed.effective_date);
    assert.deepEqual(due.regenerated, []);
    assert.equal(repo.getBrainDecision(routed.decision.id).status, "review");
  } finally {
    repo.setSettings({ lead_mode: "lead" });
  }
});
