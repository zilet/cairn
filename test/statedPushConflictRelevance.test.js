// The athlete's stated push meeting evidence that holds against it (`stated_push`,
// src/domain/brain/conference-conflicts.ts) is a question about RAISING training load.
// Left unresolved it used to hold EVERY revision of the conference — a protective
// load cap and an unrelated fueling target were tightened to announce/ask by a push
// they do not act on. It now follows the injury_load relevance rule: it governs a
// training/running change that adds load, never an easing-only change, never a
// nutrition target (conflictGovernsRevision).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCaseConference } from "../dist/domain/brain/case-conference.js";
import {
  conflictGovernsRevision,
  deterministicConferenceConflicts,
  statedPushGovernsRevision,
} from "../dist/domain/brain/conference-conflicts.js";
import { getBrainDecision } from "../dist/repo/brain-decisions.js";
import { repo } from "./_seed.js";

const opinion = (domain) => ({
  domain,
  recommendation: "Keep the change bounded.",
  rationale: "The shared snapshot supports a cautious next step.",
  evidence_keys: [`${domain}:evidence`],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "quiet_apply",
});

// A push stance in force, and recovery reading `watch` — the stated_push conflict fires.
const context = ({ pushing = true } = {}) => ({
  goal_mode: "gain",
  goal: { ok: true, goal_mode: "gain", tdee: 2_800, effective_target: { target_kcal: 3_050 } },
  cut_quality: { active: false },
  signal_state: {
    dimensions: { recovery_capacity: { status: "watch", reason: "HRV sits under its band." } },
    action: { readiness: "ready", directives: { training: "proceed", fueling: "normal", schedule: "normal" } },
  },
  context_events: [],
  training_signals: { progression: [], autoregulation: null },
  progression: [],
  health: [],
  supplements: [],
  directives: [],
  health_focus: { priorities: [], surfaced: [], lead: null, act_now: 0, track: 0 },
  profile: { allergies: null },
  family: [],
  meal_plan: null,
  day_intake: { count: 0 },
  endurance_goal: null,
  training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" },
  discipline: { primary: "strength", endurance_sport: null },
  training_drive: pushing
    ? { drive: "push", standing: "push", stance: { since: "2026-10-01", until: "2026-10-20", words: "push me" } }
    : { drive: "steady", standing: "steady", stance: null },
});

const conductor = (revision) => ({
  kind: "case_conference",
  domain: revision?.type === "nutrition_target" ? "nutrition" : "training",
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
  user_explanation: "One bounded change.",
  revision,
});

const capPallof = {
  type: "plan_update",
  summary: "Cap the Pallof press",
  changes: [{ day_number: 5, exercise: "Pallof Press", target_weight: 42.5, sets: 2, reason: "A bounded hold." }],
};
const stepPallof = {
  type: "plan_update",
  summary: "Step the Pallof press",
  changes: [{ day_number: 5, exercise: "Pallof Press", target_weight: 55, reason: "Earned." }],
};
const fuel = {
  type: "nutrition_target",
  summary: "Hold intake",
  nutrition: { target_kcal: 3_000, protein_g: 180, carbs_g: null, fat_g: null, delta_kcal: -50 },
  notes: "A small hold.",
};

function seedPallofDay() {
  repo.savePlanDay(5, "Lower B", "Legs", [
    { exercise: "Pallof Press", sets: 2, rep_low: 12, rep_high: 12, target_weight: 50 },
  ]);
}

async function confer(revision, ctx) {
  seedPallofDay();
  const result = await runCaseConference(
    "stub",
    { question: "Standing monthly whole-person review.", domains: ["training", "recovery", "nutrition"] },
    {
      context: () => ctx,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductor(revision),
    }
  );
  return { result, recorded: getBrainDecision(result.recorded_decision_id) };
}

test("stated_push governs only a revision that raises training load", () => {
  assert.equal(statedPushGovernsRevision(stepPallof), true, "a training change loads by default");
  assert.equal(statedPushGovernsRevision(capPallof, { easesLoad: true }), false, "easing is the answer, not a breach");
  assert.equal(statedPushGovernsRevision(fuel), false, "a fueling target is not what a push is about");
  assert.equal(statedPushGovernsRevision(null), true, "advice changes nothing either way");
  assert.equal(conflictGovernsRevision("stated_push", capPallof, { easesLoad: true }), false);
  assert.equal(conflictGovernsRevision("stated_push", fuel), false);
  // The other rules are unchanged: a safety conflict by its own relevance, a trade-off holds the bundle.
  assert.equal(conflictGovernsRevision("allergy_meal", stepPallof), false);
  assert.equal(conflictGovernsRevision("injury_load", stepPallof), true);
  assert.equal(conflictGovernsRevision("deficit_recovery", fuel), true);
  assert.equal(conflictGovernsRevision("race_strength", capPallof, { easesLoad: true }), true);
});

test("under lead, an unresolved stated_push no longer tightens a protective cap or a fueling target", async () => {
  repo.setSettings({ lead_mode: "lead" });
  assert.ok(deterministicConferenceConflicts(context()).includes("stated_push"));
  assert.ok(!deterministicConferenceConflicts(context({ pushing: false })).includes("stated_push"));

  for (const revision of [capPallof, fuel]) {
    const baseline = await confer(revision, context({ pushing: false }));
    const pushed = await confer(revision, context());
    assert.ok(pushed.result.unresolved_conflicts.includes("stated_push"), "still recorded as what the layer saw");
    assert.equal(
      pushed.recorded.autonomy_tier,
      baseline.recorded.autonomy_tier,
      `${revision.type} (${revision.summary}) lands as it would without the push`
    );
    assert.equal(pushed.recorded.status, baseline.recorded.status);
  }
});

test("under lead, a load step against the evidence is still said out loud", async () => {
  repo.setSettings({ lead_mode: "lead" });
  const baseline = await confer(stepPallof, context({ pushing: false }));
  const pushed = await confer(stepPallof, context());
  assert.ok(pushed.result.unresolved_conflicts.includes("stated_push"));
  assert.equal(pushed.recorded.autonomy_tier, "announce", "the trade-off is announced with the evidence");
  assert.notEqual(baseline.recorded.autonomy_tier, "announce", "and only because of the push");
});
