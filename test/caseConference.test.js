import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicConferenceConflicts, runCaseConference } from "../dist/domain/brain/case-conference.js";
import { getBrainDecision } from "../dist/repo/brain-decisions.js";
import { applyDueAnnouncedDecisions } from "../dist/domain/brain/autonomy-service.js";
import { repo } from "./_seed.js";

const opinion = (domain, overrides = {}) => ({
  domain,
  recommendation: "Keep the change bounded.",
  rationale: "The shared snapshot supports a cautious next step.",
  evidence_keys: [`${domain}:evidence`],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "ask",
  ...overrides,
});

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
}

function conductorDecision(overrides = {}) {
  return {
    kind: "case_conference",
    domain: "cross_domain",
    summary: "Keep the next change bounded.",
    rationale: "The shared snapshot supports one reversible step.",
    risk_class: "low",
    reversible: true,
    autonomy_tier: "quiet_apply",
    parallel_actions: [],
    resolved_conflicts: [],
    deferred: [],
    expectations: [],
    review_window: "Review in two weeks.",
    user_explanation: "I made one bounded change and will review the response.",
    revision: null,
    ...overrides,
  };
}

test("case conference shares one snapshot, runs specialists in parallel, and emits one clamped voice", async () => {
  const snapshots = new Set();
  const result = await runCaseConference(
    "stub",
    { question: "How should the cut and race build coexist?", domains: ["training", "nutrition", "recovery"] },
    {
      context: () => ({
        profile: { goal: "fat loss" },
        recovery: { state: "poor recovery" },
        plan: { race: "10k", strength: true },
      }),
      specialistRun: async (_agent, _prompt, domain, snapshot) => {
        snapshots.add(snapshot.id);
        return opinion(domain);
      },
      conductorRun: async () => ({
        kind: "case_conference",
        domain: "cross_domain",
        summary: "Keep the deficit shallow during the race build.",
        rationale: "Recovery is the limiting shared signal.",
        risk_class: "moderate",
        reversible: true,
        autonomy_tier: "quiet_apply",
        parallel_actions: ["hold strength volume"],
        resolved_conflicts: [{ key: "race_strength", resolution: "Park hypertrophy progression temporarily." }],
        deferred: [],
        expectations: [],
        review_window: "Review in two weeks.",
        user_explanation: "I am keeping the cut shallow while the race build is the priority.",
        revision: null,
      }),
      now: () => new Date("2026-07-09T12:00:00Z"),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(snapshots.size, 1);
  assert.equal(result.opinions.length, 3);
  assert.equal(result.decision.autonomy_tier, "ask", "specialist/conference policy cannot be promoted to quiet apply");
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.kind, "case_conference");
  assert.equal(recorded.status, "review");
  assert.equal(recorded.specialist.opinions.length, 3);
});

test("an unaccounted deterministic conflict demotes an executable revision to review", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    {
      question: "Should bench load move despite shoulder pain?",
      domains: ["training", "recovery"],
      optimizes: ["recovery"],
      parks: ["strength"],
    },
    {
      context: () => ({ injury: "shoulder pain", training: "progress load" }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () => conductorDecision({
        domain: "training",
        revision: {
          type: "plan_update",
          summary: "Small bench step",
          changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
        },
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.unresolved_conflicts, ["injury_load"]);
  assert.equal(result.execution.tier, "ask");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
  assert.equal(repo.getProposal(result.proposal_id).status, "draft");
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.status, "review");
  assert.equal(recorded.source_ref_type, "plan_proposal");
  assert.equal(repo.listBrainDecisions({ status: "announced" }).length, 0);
});

test("a resolved bounded plan update executes through autonomy and keeps trajectory context", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const trajectory = { objective: "everything better", phase: { optimizes: ["recovery"], parks: ["strength"] } };
  const result = await runCaseConference(
    "stub",
    {
      question: "Make the next bounded adjustment.",
      domains: ["training", "recovery"],
      trajectory,
      optimizes: trajectory.phase.optimizes,
      parks: trajectory.phase.parks,
    },
    {
      context: () => ({ injury: "shoulder pain", training: "progress load" }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () => conductorDecision({
        domain: "training",
        resolved_conflicts: [{ key: "injury_load", resolution: "Use only the already-cleared small load step." }],
        revision: {
          type: "plan_update",
          summary: "Small bench step",
          changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
        },
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.unresolved_conflicts, []);
  assert.equal(result.execution.applied, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
  assert.equal(repo.getProposal(result.proposal_id).status, "applied");
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.status, "applied");
  assert.equal(recorded.source, "case_conference");
  assert.deepEqual(recorded.context.optimizes, ["recovery"]);
  assert.deepEqual(recorded.context.parks, ["strength"]);
  assert.deepEqual(recorded.context.trajectory, trajectory);
  assert.ok(repo.getBrainRollback(recorded.id));
});

test("a plan restructure announcement always points at an executable proposal", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Move to a two-day split.", domains: ["training", "recovery"] },
    {
      context: () => ({ training: "stable" }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () => conductorDecision({
        domain: "training",
        revision: {
          type: "plan_restructure",
          summary: "Two-day split",
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
        },
      }),
    }
  );

  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(result.execution.announced, true);
  assert.equal(recorded.status, "announced");
  assert.equal(Number(recorded.action.proposal_id), result.proposal_id);
  assert.equal(repo.getProposal(result.proposal_id).status, "draft");
  assert.deepEqual(applyDueAnnouncedDecisions(recorded.effective_date).applied, [recorded.id]);
  assert.equal(repo.getProposal(result.proposal_id).status, "applied");
  assert.equal(repo.getPlan().length, 2);
});

test("deterministic conflicts cover the material cross-domain matrix", () => {
  assert.deepEqual(
    deterministicConferenceConflicts({
      injury: "shoulder",
      training: "progress load",
      deficit: true,
      recovery: "low HRV fatigue",
      medication: "x",
      supplement: "y",
      allergies: "nuts",
      meal: "plan",
      race: "10k",
      strength: true,
      clinical: true,
      autonomy: "auto-apply",
    }),
    ["injury_load", "deficit_recovery", "medication_supplement", "allergy_meal", "race_strength", "clinical_autonomy"]
  );
});

test("a conductor cannot self-attest away the clinical floor", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    // The health specialist is absent on purpose: the floor must be deterministic.
    { question: "Should the iron supplement change alongside the medication?", domains: ["training", "nutrition"] },
    {
      context: () => ({
        clinical: "ferritin flagged, medication adjusted",
        autonomy: "quiet_apply candidate",
      }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          risk_class: "low",
          resolved_conflicts: [
            { key: "clinical_autonomy", resolution: "The clinical side is handled." },
            { key: "medication_supplement", resolution: "No interaction expected." },
          ],
          revision: {
            type: "plan_update",
            summary: "Small bench change",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120, reason: "earned" }],
          },
        }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.decision.risk_class, "clinical", "the deterministic floor re-classifies the risk");
  assert.equal(result.decision.autonomy_tier, "clinician");
  assert.equal(result.execution.applied, false, "nothing clinical ever applies autonomously");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115, "the plan is untouched");
});

test("a decision whose own action carries medication changes is clinician-directed even without a flagged snapshot", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Tune training around the new phase.", domains: ["training"] },
    {
      context: () => ({ training: "stable" }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          risk_class: "low",
          parallel_actions: ["reduce the medication dosage alongside the block"],
          revision: {
            type: "plan_update",
            summary: "Small bench change",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
          },
        }),
    }
  );

  assert.equal(result.decision.autonomy_tier, "clinician");
  assert.equal(result.execution.applied, false);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
});

test("a malformed conductor envelope preserves specialist findings as degraded advice", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "How should fueling respond to fatigue?", domains: ["nutrition", "recovery"] },
    {
      context: () => ({ deficit: true, recovery: "fatigue" }),
      specialistRun: async (_agent, _prompt, domain) =>
        opinion(domain, { recommendation: domain === "nutrition" ? "Raise fuel modestly." : "Protect recovery." }),
      conductorRun: async () => ({ malformed: true }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.decision.domain, "nutrition");
  assert.equal(result.decision.revision, null);
  assert.deepEqual(result.unresolved_conflicts, ["deficit_recovery"]);
  assert.equal(result.proposal_id, undefined, "fallback advice never synthesizes a mutation");
});

test("a conference can route a typed nutrition target through the proposal and autonomy path", async () => {
  repo.setProfile({ age: 44, height_cm: 170.2, weight_lb: 174.2, goal_weight_lb: 164, goal_mode: "lose" });
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Adjust the cut fuel target.", domains: ["nutrition", "recovery"] },
    {
      context: () => ({ deficit: true, recovery: "fatigue" }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () => conductorDecision({
        domain: "nutrition",
        resolved_conflicts: [{ key: "deficit_recovery", resolution: "Use a small carb-led increase." }],
        revision: {
          type: "nutrition_target",
          summary: "Fuel the work",
          nutrition: { target_kcal: 2_075, protein_g: 175, carbs_g: 205, fat_g: 62, delta_kcal: 250 },
          notes: "Review performance and weight trend.",
        },
      }),
    }
  );

  assert.equal(result.ok, true);
  assert.ok(result.proposal_id);
  assert.equal(repo.getProposal(result.proposal_id).parsed.kind, "nutrition_target");
  assert.equal(getBrainDecision(result.recorded_decision_id).action.conference_revision_type, "nutrition_target");
});
