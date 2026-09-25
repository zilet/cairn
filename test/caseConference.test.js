import { test } from "node:test";
import assert from "node:assert/strict";
import {
  citedConflictResolutions,
  clinicalAutonomyFromRevision,
  conferenceConflictInputs,
  deterministicConferenceConflicts,
  runCaseConference,
} from "../dist/domain/brain/case-conference.js";
import { getBrainDecision } from "../dist/repo/brain-decisions.js";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  thawParkedReviewDecisions,
} from "../dist/domain/brain/autonomy-service.js";
import { normalizeStrictCaseConferenceDecision } from "../dist/brain/case-conference-contract.js";
import { normalizeSpecialistOpinion } from "../dist/brain/specialist-contract.js";
import { normalizeJsonObject } from "../dist/brain/contract-utils.js";
import { runAgentWithFallback } from "../dist/agents.js";
import { db, repo } from "./_seed.js";

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

// ---- conference-context fixtures -------------------------------------------
// Shaped like the real coach context, because the conflict layer reads VALUES
// out of it. A healthy athlete eating in a surplus with nothing hurt: every key
// the old stringify-and-regex detector tripped over (`cut_quality`, the day-read
// `fatigue` block, `allergies`, `meal_plan`) is present and empty.
const healthyContext = () => ({
  goal_mode: "gain",
  goal: { ok: true, goal_mode: "gain", tdee: 2_800, effective_target: { target_kcal: 3_050 } },
  cut_quality: { active: false },
  day_read: { signals: { fatigue: { anticipate_deload: false, low_readiness: false, acute_load: null } } },
  signal_state: {
    dimensions: { recovery_capacity: { status: "supportive", reason: "Sleep and HRV both read normal." } },
    action: { readiness: "ready", directives: { training: "proceed", fueling: "normal", schedule: "normal" } },
  },
  context_events: [],
  training_signals: {
    progression: [{ exercise: "Barbell Bench Press", progress_ready: true }],
    autoregulation: null,
  },
  progression: [{ exercise: "Barbell Bench Press", action: "overload" }],
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
});

// The same context with every VALUE emptied out — only the key names survive.
// This is what defeated the old regexes; nothing here may fire a conflict.
const keyNamesOnlyContext = () => ({
  goal: null,
  cut_quality: null,
  day_read: { signals: { fatigue: null } },
  signal_state: null,
  context_events: [],
  training_signals: { progression: [], autoregulation: null },
  progression: [],
  health: [],
  supplements: [],
  directives: [],
  health_focus: null,
  profile: { allergies: null },
  family: [],
  meal_plan: null,
  day_intake: null,
  endurance_goal: null,
  training_intent: null,
  discipline: null,
});

const injuryContext = () => ({ ...healthyContext(), context_events: [{ kind: "injury", title: "Left shoulder" }] });

const deficitStrainContext = () => ({
  ...healthyContext(),
  goal_mode: "lose",
  goal: { ok: true, goal_mode: "lose", tdee: 2_800, effective_target: { target_kcal: 2_200 } },
  cut_quality: { active: true, regressing: 1, considered: 4 },
  signal_state: {
    dimensions: { recovery_capacity: { status: "constrained", reason: "HRV has run below norm for four days." } },
    action: { readiness: "protect", directives: { training: "recover", fueling: "protect", schedule: "compress" } },
  },
});

// A clinical priority the brain is being asked to act on, propagated into a
// domain it can change by itself.
const clinicalContext = () => ({
  ...healthyContext(),
  health_focus: {
    priorities: [],
    surfaced: [],
    lead: { group: "Iron & Red Blood", tier: "act_now", flagged: true, markers: ["Ferritin"] },
    act_now: 1,
    track: 0,
  },
  directives: [{ domain: "nutrition", marker: "Ferritin", directive: "Pair iron-rich food with vitamin C." }],
});

// The production shape the compact fixtures above cannot reproduce: the real
// coach context has 73 top-level keys and createImmutableBrainSnapshot keeps only
// the first 50, so every conflict-bearing slice (signal_state, health_focus,
// directives, health, supplements) sits BELOW the cut. Filler keys go first, so
// everything the conflict layer needs is past index 50.
function wideContext(base = deficitStrainContext()) {
  const filler = {};
  for (let i = 0; i < 60; i += 1) filler[`coach_slice_${String(i).padStart(2, "0")}`] = { note: "a context slice" };
  return { ...filler, ...base };
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
        ...healthyContext(),
        endurance_goal: { mode: "race", is_race: true, distance_km: 10, phase: "build", weeks_to_race: 8 },
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
        resolved_conflicts: [
          {
            key: "race_strength",
            evidence_key: "training:evidence",
            resolution: "Park hypertrophy progression temporarily.",
          },
        ],
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
  // Under lead a specialist's "ask" is an opinion about how loudly to say it, not a floor
  // (Amendment 3): the reading is a heads-up, never promoted to a quiet apply, and —
  // being advice, with nothing to approve — never parked in the athlete's queue.
  assert.equal(
    result.decision.autonomy_tier,
    "announce",
    "specialist/conference policy cannot be promoted to quiet apply"
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.kind, "case_conference");
  assert.equal(recorded.status, "observed");
  assert.equal(recorded.context.lead_ceiling_eased, "ask->announce");
  assert.equal(recorded.specialist.opinions.length, 3);
});

test("announce_first keeps a specialist's ask: the same advisory conference parks for review", async () => {
  repo.setSettings({ lead_mode: "announce_first" });
  const result = await runCaseConference(
    "stub",
    { question: "How should the cut and race build coexist?", domains: ["training", "recovery"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision({ autonomy_tier: "ask" }),
    }
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.autonomy_tier, "ask");
  assert.equal(recorded.status, "review");
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
      context: injuryContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
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
      context: injuryContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          resolved_conflicts: [
            {
              key: "injury_load",
              evidence_key: "training:evidence",
              resolution: "Use only the already-cleared small load step.",
            },
          ],
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

// ---- a resolution has to CITE ------------------------------------------------
// Echoing the server's own conflict list back at it used to be the entire
// resolution test, which is the false negative the citation requirement closes.
async function conferenceResolving(claims) {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  return runCaseConference(
    "stub",
    { question: "Should bench load move despite shoulder pain?", domains: ["training", "recovery"] },
    {
      context: injuryContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          resolved_conflicts: claims,
          revision: {
            type: "plan_update",
            summary: "Small bench step",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
          },
        }),
    }
  );
}

test("a conductor echoing a conflict key without a citation is demoted like an unresolved one", async () => {
  const echoed = await conferenceResolving([{ key: "injury_load", resolution: "Handled by the training plan." }]);
  assert.deepEqual(echoed.unresolved_conflicts, ["injury_load"]);
  assert.equal(echoed.execution.tier, "ask");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115, "the echo bought nothing");
});

test("a citation that names no real specialist evidence is not a resolution", async () => {
  const invented = await conferenceResolving([
    { key: "injury_load", evidence_key: "training:the-shoulder-is-fine", resolution: "Cleared." },
  ]);
  assert.deepEqual(invented.unresolved_conflicts, ["injury_load"]);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
});

test("a citation from a specialist who is not party to the conflict is not a resolution", async () => {
  // `recovery` and `training` are parties to injury_load; a nutrition key is not —
  // and no nutrition specialist even sat in this conference.
  const offParty = await conferenceResolving([
    { key: "injury_load", evidence_key: "nutrition:evidence", resolution: "Fuel covers it." },
  ]);
  assert.deepEqual(offParty.unresolved_conflicts, ["injury_load"]);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
});

test("a cited resolution from a party to the conflict closes it and the revision lands", async () => {
  const cited = await conferenceResolving([
    { key: "injury_load", evidence_key: "recovery:evidence", resolution: "The cleared step stays under the limit." },
  ]);
  assert.deepEqual(cited.unresolved_conflicts, []);
  assert.equal(cited.execution.applied, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
});

test("a legacy string[] resolved_conflicts payload leaves every conflict unresolved", async () => {
  const legacy = await conferenceResolving(["injury_load"]);
  assert.deepEqual(legacy.unresolved_conflicts, ["injury_load"]);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115, "an old-shape payload never applies a change");
});

test("a plan restructure announcement always points at an executable proposal", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Move to a two-day split.", domains: ["training", "recovery"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
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

test("a specialist's 'clinician' ceiling over a non-clinical change tightens to an ask, never the floor", async () => {
  // Live shape: the recovery specialist wrote autonomy_ceiling 'clinician' over a
  // hill-repeat stand-down and the conductor wrote risk_class 'clinical' on it. Neither
  // is a clinical fact the server can see, and no clinician exists in the loop — so the
  // held row could never be answered. The floor is deterministic in both directions.
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Should the hill repeats stand down for two weeks?", domains: ["training", "recovery"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) =>
        opinion(domain, { autonomy_ceiling: domain === "recovery" ? "clinician" : "announce" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          risk_class: "clinical",
          autonomy_tier: "clinician",
          revision: {
            type: "plan_update",
            summary: "Bench holds while the shoulder settles",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 115, reason: "hold" }],
          },
        }),
    }
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.notEqual(recorded.autonomy_tier, "clinician", "model discretion never sets the clinician tier");
  assert.notEqual(recorded.risk_class, "clinical", "nor the clinical risk class");
  assert.equal(recorded.context.deterministic_clinical, false);
  assert.equal(recorded.context.conductor_risk_class, "clinical", "what the conductor said is on the record");
  assert.equal(recorded.context.specialist_ceiling_softened, "clinician->ask");
});

test("a change that names a medication DOES hold the clinician floor, whatever the specialists said", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Adjust around the iron protocol?", domains: ["training", "recovery"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          risk_class: "low",
          autonomy_tier: "quiet_apply",
          summary: "Hold bench while the ferrous sulfate medication dosage is reviewed",
          revision: {
            type: "plan_update",
            summary: "Hold bench while the medication dosage is reviewed",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 115, reason: "hold" }],
          },
        }),
    }
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.autonomy_tier, "clinician");
  assert.equal(recorded.status, "review", "held for a clinician, never applied");
  assert.equal(recorded.context.deterministic_clinical, true);
  assert.equal(recorded.context.review_reason_code, "clinical_ceiling", "the floor travels with the change");
});

test("a healthy, surplus-eating athlete with nothing hurt detects ZERO conflicts", () => {
  assert.deepEqual(deterministicConferenceConflicts(healthyContext()), []);
});

test("a context carrying only key names — no values — detects ZERO conflicts", () => {
  assert.deepEqual(deterministicConferenceConflicts(keyNamesOnlyContext()), []);
  assert.deepEqual(deterministicConferenceConflicts({}), []);
  assert.deepEqual(deterministicConferenceConflicts(null), []);
});

// For each conflict: it fires on a genuinely conflicting fixture, stays silent on
// the absent/null fixture, and stays silent on the key-names-only one.
const conflictCases = [
  {
    key: "injury_load",
    firing: () => injuryContext(),
    // The injury is there but nothing is being pushed — no conflict to arbitrate.
    quiet: () => ({
      ...injuryContext(),
      training_signals: { progression: [{ exercise: "Barbell Bench Press", progress_ready: false }] },
      progression: [{ exercise: "Barbell Bench Press", action: "hold" }],
    }),
  },
  {
    key: "deficit_recovery",
    firing: () => deficitStrainContext(),
    // Same measured deficit, recovery reading fine.
    quiet: () => ({ ...deficitStrainContext(), signal_state: healthyContext().signal_state }),
  },
  {
    key: "medication_supplement",
    firing: () => ({
      ...healthyContext(),
      health: [{ kind: "medication_list", clinical_facts: [{ kind: "medication", name: "Atorvastatin" }] }],
      supplements: [{ name: "Creatine monohydrate" }],
    }),
    // A medication on record, nothing taken alongside it.
    quiet: () => ({
      ...healthyContext(),
      health: [{ kind: "medication_list", clinical_facts: [{ kind: "medication", name: "Atorvastatin" }] }],
      supplements: [],
    }),
  },
  {
    key: "allergy_meal",
    firing: () => ({
      ...healthyContext(),
      profile: { allergies: "peanuts" },
      meal_plan: { days: [{ date: "2026-07-09", meals: [] }] },
    }),
    // The allergy is on file but no food is being planned.
    quiet: () => ({ ...healthyContext(), profile: { allergies: "peanuts" } }),
  },
  {
    key: "race_strength",
    firing: () => ({
      ...healthyContext(),
      endurance_goal: { mode: "race", is_race: true, distance_km: 10, phase: "build", weeks_to_race: 8 },
    }),
    // The race has been run; the build is over.
    quiet: () => ({
      ...healthyContext(),
      endurance_goal: { mode: "race", is_race: true, distance_km: 10, phase: "past", weeks_to_race: 0 },
    }),
  },
  {
    key: "clinical_autonomy",
    firing: () => clinicalContext(),
    // An act-now finding that only asks the athlete to WATCH something changes
    // nothing the brain could apply on its own.
    quiet: () => ({
      ...clinicalContext(),
      directives: [{ domain: "watch", marker: "Ferritin", directive: "Recheck ferritin with your doctor." }],
    }),
  },
];

for (const { key, firing, quiet } of conflictCases) {
  test(`${key} fires on real evidence and on nothing else`, () => {
    assert.ok(deterministicConferenceConflicts(firing()).includes(key), "the conflicting fixture fires it");
    assert.ok(!deterministicConferenceConflicts(quiet()).includes(key), "the non-conflicting fixture does not");
    assert.ok(!deterministicConferenceConflicts(keyNamesOnlyContext()).includes(key), "key names alone do not");
    assert.ok(!deterministicConferenceConflicts(healthyContext()).includes(key), "a healthy athlete does not");
  });
}

// ---- the snapshot bound must not blind the deterministic layer ---------------

test("the immutable snapshot really does drop a wide context's conflict-bearing keys", () => {
  const wide = wideContext();
  assert.ok(Object.keys(wide).length >= 73, "the fixture is at least as wide as the real coach context");
  const bounded = normalizeJsonObject(wide);
  assert.equal(bounded.signal_state, undefined, "signal_state is past the 50-key bound");
  assert.equal(bounded.health_focus, undefined);
  assert.equal(bounded.directives, undefined);
  assert.equal(bounded.cut_quality, undefined);
  assert.deepEqual(
    deterministicConferenceConflicts(bounded),
    [],
    "reading the SNAPSHOT is what made three conflicts undetectable in production"
  );
});

test("a conference over a wide context still detects conflicts the snapshot cannot carry", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "Reconcile fuel and recovery.", domains: ["nutrition", "recovery"] },
    {
      context: () => wideContext(),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision({ domain: "nutrition" }),
    }
  );
  assert.deepEqual(result.conflicts, ["deficit_recovery"], "detection reads the full context, not the snapshot");
  assert.deepEqual(result.unresolved_conflicts, ["deficit_recovery"]);
});

test("a wide context's trajectory and focus reach the recorded decision", async () => {
  const trajectory = { objective: "everything better", phase: { optimizes: ["recovery"], parks: ["strength"] } };
  const result = await runCaseConference(
    "stub",
    {
      question: "Make the next bounded adjustment.",
      domains: ["nutrition", "recovery"],
      trajectory,
      optimizes: trajectory.phase.optimizes,
      parks: trajectory.phase.parks,
    },
    {
      context: () => wideContext(),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision({ domain: "nutrition" }),
    }
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  // conferenceContext appends these AFTER the context's own keys, so on a wide
  // context the snapshot bound dropped both and every production conference
  // recorded a null trajectory.
  assert.deepEqual(recorded.context.trajectory, trajectory);
  assert.deepEqual(recorded.context.optimizes, ["recovery"]);
  assert.deepEqual(recorded.context.parks, ["strength"]);
});

test("the recorded decision carries what the deterministic layer actually saw", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "Reconcile fuel and recovery.", domains: ["nutrition", "recovery"] },
    {
      context: () => wideContext(),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision({ domain: "nutrition" }),
    }
  );
  // The stored snapshot is the bounded agent-facing copy, so it cannot re-derive
  // the conflict list. Without the inputs beside it, the ledger says which
  // conflicts fired and nothing about why — unrecoverable once the context moves.
  const inputs = getBrainDecision(result.recorded_decision_id).context.conflict_inputs;
  assert.ok(inputs, "the ledger records the resolved conflict inputs");
  assert.equal(inputs.inDeficit, true);
  assert.equal(inputs.recoveryStrain, true);
  assert.equal(inputs.clinicalAttention, false, "an answered no is recorded as a no, not as absence");
  assert.equal(inputs.activeInjury, false);
  assert.deepEqual(inputs.activeMedications, []);
});

// ---- evidence the coach context cannot carry --------------------------------

test("a lifecycle symptom with no rated session since still counts as an active injury", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Should squat load move?", domains: ["training", "recovery"] },
    {
      // Nothing in the context knows: no injury event, and the autoregulation
      // rollup is empty because nothing has been trained since the report.
      context: healthyContext,
      symptomAreas: () => ["left knee"],
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          revision: {
            type: "plan_update",
            summary: "Small bench step",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
          },
        }),
    }
  );
  assert.deepEqual(result.conflicts, ["injury_load"]);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115, "the change is held, not applied");
});

test("a symptom read that finds nothing is not the same as one that never looked", () => {
  assert.deepEqual(deterministicConferenceConflicts(healthyContext(), { activeSymptomAreas: [] }), []);
  assert.deepEqual(deterministicConferenceConflicts(healthyContext(), { activeSymptomAreas: null }), []);
  assert.deepEqual(deterministicConferenceConflicts(healthyContext(), { activeSymptomAreas: ["left knee"] }), [
    "injury_load",
  ]);
});

// ---- the clinical lever's second arm ----------------------------------------

test("an act-now finding gates a revision that names its marker, even without a directive row", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  // A flagged marker whose propagation produced only a `watch` row — no
  // training/nutrition directive exists, but the change is ABOUT the finding.
  const watchOnly = () => ({
    ...clinicalContext(),
    directives: [{ domain: "watch", marker: "Ferritin", directive: "Recheck ferritin with your doctor." }],
  });
  assert.deepEqual(deterministicConferenceConflicts(watchOnly()), [], "no lever before a revision exists");

  const result = await runCaseConference(
    "stub",
    { question: "Tune training around the flagged panel.", domains: ["training"] },
    {
      context: watchOnly,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          revision: {
            type: "plan_update",
            summary: "Hold bench while ferritin recovers",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
          },
        }),
    }
  );
  assert.ok(result.conflicts.includes("clinical_autonomy"), "a change that names the finding acts on it");
  assert.deepEqual(result.unresolved_conflicts, ["clinical_autonomy"]);
  assert.equal(result.decision.risk_class, "clinical");
  assert.equal(result.decision.autonomy_tier, "clinician");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
});

// Example shape (conference 4033): a lipid act-now finding clinician-gated a squat-load
// hold it has nothing to say about. The floor is RELEVANCE, not co-occurrence.
const lipidContext = () => ({
  ...healthyContext(),
  health_focus: {
    priorities: [{ group: "Lipids & Cardiovascular", tier: "act_now", markers: ["LDL-C", "Apolipoprotein B (ApoB)"] }],
    surfaced: [],
    lead: { group: "Lipids & Cardiovascular", tier: "act_now", flagged: true, markers: ["LDL-C"] },
    act_now: 1,
    track: 0,
  },
  directives: [
    {
      domain: "nutrition",
      marker: "LDL-C",
      directive: "Swap saturated fat for unsaturated oils and add soluble fiber.",
    },
    { domain: "training", marker: "HRV", directive: "Favor easy aerobic work while HRV is low.", uncertain: 1 },
  ],
});

test("a lipid act-now finding does not clinician-gate a training-load hold", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Reconcile the next bounded revision.", domains: ["training"] },
    {
      context: lipidContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "announce" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          revision: {
            type: "plan_update",
            summary: "Hold bench load through the block",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 115, reason: "hold" }],
          },
        }),
    }
  );
  assert.ok(!result.conflicts.includes("clinical_autonomy"), "a lipid finding governs no bench load");
  assert.notEqual(result.decision.autonomy_tier, "clinician");
  assert.notEqual(result.decision.risk_class, "clinical");
  assert.equal(getBrainDecision(result.recorded_decision_id).context.deterministic_clinical, false);
});

test("an act-now finding still gates a revision that acts on what its directive governs", () => {
  const anemia = {
    ...clinicalContext(),
    directives: [
      { domain: "training", marker: "Ferritin", directive: "Keep endurance volume modest until iron recovers." },
    ],
  };
  const inputs = conferenceConflictInputs(anemia);
  const endurance = {
    type: "plan_update",
    summary: "Build the long run",
    changes: [{ day_number: 6, exercise: "Long Run", target_distance_km: 18 }],
  };
  const lifting = {
    type: "plan_update",
    summary: "Small bench step",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
  };
  assert.equal(clinicalAutonomyFromRevision(inputs, endurance), true, "endurance volume is what it governs");
  assert.equal(clinicalAutonomyFromRevision(inputs, lifting), false, "a bench step is not");
  assert.equal(clinicalAutonomyFromRevision(inputs, null), false, "advice changes nothing");
  // The lipid fixture's nutrition directive names fat and fiber: a fueling change that
  // sets fat acts on it; the uncertain HRV row is never a lever.
  const lipid = conferenceConflictInputs(lipidContext());
  assert.equal(lipid.clinicalLevers.length, 1, "the uncertain HRV directive is not a lever");
  const fueling = (fat) => ({
    type: "nutrition_target",
    summary: "Adjust fueling",
    nutrition: { target_kcal: 2300, protein_g: 175, carbs_g: null, fat_g: fat, delta_kcal: 0 },
    notes: null,
  });
  assert.equal(clinicalAutonomyFromRevision(lipid, fueling(60)), true);
  assert.equal(clinicalAutonomyFromRevision(lipid, fueling(null)), false);
  assert.equal(
    clinicalAutonomyFromRevision(lipid, { ...lifting, summary: "Hold bench while ApoB is rechecked" }),
    true
  );
});

test("an advice-only conference over the same finding is not forced to clinician", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "What should I watch?", domains: ["training"] },
    {
      context: () => ({
        ...clinicalContext(),
        directives: [{ domain: "watch", marker: "Ferritin", directive: "Recheck ferritin with your doctor." }],
      }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => conductorDecision({ domain: "training", revision: null }),
    }
  );
  assert.ok(!result.conflicts.includes("clinical_autonomy"), "there is no change for the lever to ride");
});

// ---- deadbands and comparability --------------------------------------------

test("a target a few calories under an estimated maintenance is not a deficit", () => {
  const nearMaintenance = {
    ...deficitStrainContext(),
    cut_quality: { active: false },
    goal_mode: "maintain",
    goal: { ok: true, goal_mode: "maintain", tdee: 2_800, effective_target: { target_kcal: 2_780 } },
  };
  assert.deepEqual(deterministicConferenceConflicts(nearMaintenance), [], "20 kcal is two estimates landing close");
  assert.deepEqual(
    deterministicConferenceConflicts({
      ...nearMaintenance,
      goal: { ok: true, goal_mode: "maintain", tdee: 2_800, effective_target: { target_kcal: 2_600 } },
    }),
    ["deficit_recovery"],
    "a margin that means something does read as a deficit"
  );
});

test("a citation longer than the evidence-key cap still compares equal to its own key", () => {
  const longKey = `sessions:${"bench-press-and-a-very-long-provenance-tail ".repeat(6)}n=4`;
  assert.ok(longKey.length > 160, "the fixture exceeds the 160-char cap both sides normalize to");
  const stored = normalizeSpecialistOpinion(opinion("training", { evidence_keys: [longKey] }));
  const decision = normalizeStrictCaseConferenceDecision(
    conductorDecision({
      resolved_conflicts: [{ key: "injury_load", evidence_key: longKey, resolution: "Cleared under the cap." }],
    })
  );
  assert.ok(decision, "the decision still normalizes");
  const resolved = citedConflictResolutions(decision.resolved_conflicts, ["injury_load"], [stored]);
  assert.ok(resolved.has("injury_load"), "both sides truncate the same way, so the citation matches");
});

test("every conflict can be detected at once when the evidence is genuinely there", () => {
  assert.deepEqual(
    deterministicConferenceConflicts({
      ...deficitStrainContext(),
      ...clinicalContext(),
      goal_mode: "lose",
      goal: { ok: true, goal_mode: "lose", tdee: 2_800, effective_target: { target_kcal: 2_200 } },
      cut_quality: { active: true },
      signal_state: deficitStrainContext().signal_state,
      context_events: [{ kind: "injury", title: "Left shoulder" }],
      health: [{ kind: "medication_list", clinical_facts: [{ kind: "medication", name: "Atorvastatin" }] }],
      supplements: [{ name: "Creatine monohydrate" }],
      profile: { allergies: "peanuts" },
      meal_plan: { days: [] },
      endurance_goal: { mode: "race", is_race: true, distance_km: 10, phase: "build" },
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
        ...clinicalContext(),
        health: [{ kind: "medication_list", clinical_facts: [{ kind: "medication", name: "Ferrous sulfate" }] }],
        supplements: [{ name: "Iron bisglycinate" }],
      }),
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          risk_class: "low",
          // Adversarial: BOTH claims carry a citation that really exists in a
          // specialist's evidence. The clinical conflict must still not close.
          resolved_conflicts: [
            {
              key: "clinical_autonomy",
              evidence_key: "nutrition:evidence",
              resolution: "The clinical side is handled.",
            },
            {
              key: "medication_supplement",
              evidence_key: "nutrition:evidence",
              resolution: "No interaction expected.",
            },
          ],
          revision: {
            type: "plan_update",
            summary: "Small bench change while ferritin recovers",
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
  assert.ok(
    result.unresolved_conflicts.includes("clinical_autonomy"),
    "no citation can close a clinical conflict — the floor is the server's"
  );
  assert.ok(
    !result.unresolved_conflicts.includes("medication_supplement"),
    "an ordinary conflict with a real citation does close"
  );
});

test("a medication sentence among the parallel actions goes to the athlete and their doctor; the bench change beside it lands", async () => {
  // A conference is a bundle routed action by action (2026-09-25 ruling). The clinical
  // sentence used to put the whole bundle — the bench step included — on the floor.
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Tune training around the new phase.", domains: ["training"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          risk_class: "clinical",
          parallel_actions: ["reduce the medication dosage alongside the block", "keep easy runs conversational"],
          revision: {
            type: "plan_update",
            summary: "Small bench change",
            changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
          },
        }),
    }
  );

  assert.notEqual(result.decision.autonomy_tier, "clinician", "a clinical sentence elsewhere never gates the change");
  assert.equal(result.execution.applied, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 120);
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.equal(recorded.context.deterministic_clinical, false);
  assert.equal(recorded.context.clinician_note_count, 1);
  const waiting = repo.awaitingBrainDecisions();
  assert.equal(waiting.filter((row) => !row.for_clinician).length, 0, "nothing waits on the athlete");
  const notes = waiting.filter((row) => row.for_clinician);
  assert.equal(notes.length, 1, "the medication sentence is filed for them and their doctor");
  assert.match(notes[0].explanation, /medication dosage/);
  assert.doesNotMatch(notes[0].explanation, /easy runs/, "only the clinical sentence travels to the doctor");
  assert.equal(getBrainDecision(notes[0].id).status, "observed", "information, not a pending approval");
});

test("a malformed conductor envelope preserves specialist findings as degraded advice", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "How should fueling respond to fatigue?", domains: ["nutrition", "recovery"] },
    {
      context: deficitStrainContext,
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

test("default specialist and conductor dispatch enforce literal contracts and provider fallthrough predicates", async () => {
  const specialistPrompts = [];
  let conductorPrompt = "";
  const controller = new AbortController();
  const result = await runCaseConference(
    "auto",
    { question: "Reconcile fuel and recovery.", domains: ["nutrition", "recovery"] },
    {
      context: deficitStrainContext,
      chosenWithReads: async (_agent, prompt, opts) => {
        assert.equal(opts.signal, controller.signal);
        specialistPrompts.push(prompt);
        const domain = String(opts.op).replace("conference_", "");
        assert.equal(opts.acceptParsed(opinion("training")), domain === "training");
        assert.equal(opts.acceptParsed(opinion(domain)), true);
        const incomplete = opinion(domain);
        delete incomplete.risks;
        assert.equal(opts.acceptParsed(incomplete), false);
        const parsed = opinion(domain);
        return {
          agent: "terra",
          result: { code: 0, raw: JSON.stringify(parsed), stderr: "", parsed, usage: {} },
          tried: [],
        };
      },
      chosen: async (_agent, prompt, opts) => {
        assert.equal(opts.signal, controller.signal);
        conductorPrompt = prompt;
        const invalid = { kind: "case_conference" };
        const parsed = conductorDecision({
          domain: "nutrition",
          resolved_conflicts: [
            { key: "deficit_recovery", evidence_key: "nutrition:evidence", resolution: "Keep the adjustment bounded." },
          ],
        });
        assert.equal(opts.acceptParsed(invalid), false);
        assert.equal(opts.acceptParsed({ ...parsed, kind: "training_target" }), false);
        assert.equal(
          opts.acceptParsed({
            ...parsed,
            revision: {
              type: "nutrition_target",
              summary: "Malformed nested revision",
              nutrition: { target_kcal: "not-a-number", protein_g: 175 },
              notes: null,
            },
          }),
          false
        );
        assert.equal(opts.acceptParsed(parsed), true);
        return {
          agent: "sol",
          result: { code: 0, raw: JSON.stringify(parsed), stderr: "", parsed, usage: {} },
          tried: [],
        };
      },
      signal: controller.signal,
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.degraded, undefined);
  assert.equal(specialistPrompts.length, 2);
  assert.match(
    specialistPrompts[0],
    /"autonomy_ceiling":\{"type":"string","enum":\["observe","quiet_apply","announce","ask","clinician"\]/
  );
  assert.match(specialistPrompts[0], /"metric_key":\{"type":"string","enum":\["weight_trend_lb_wk"/);
  assert.match(specialistPrompts[0], /domain MUST be exactly "nutrition"/);
  assert.match(conductorPrompt, /kind MUST be "case_conference"/);
  assert.match(conductorPrompt, /"risk_class":\{"type":"string","enum":\["low","moderate","high","clinical"\]/);
});

test("post-run specialist validation rejects incomplete opinions before conductor or persistence", async () => {
  let conductorCalled = false;
  const result = await runCaseConference(
    "stub",
    { question: "Reconcile the next training step.", domains: ["training", "recovery"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) => {
        const incomplete = opinion(domain);
        delete incomplete.risks;
        return incomplete;
      },
      conductorRun: async () => {
        conductorCalled = true;
        return conductorDecision();
      },
    }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.opinions, []);
  assert.deepEqual(result.unavailable, ["training", "recovery"]);
  assert.equal(conductorCalled, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
});

test("strict conductor contract rejects a wrong kind and malformed nested executable revision", () => {
  const valid = conductorDecision();
  assert.ok(normalizeStrictCaseConferenceDecision(valid));
  assert.equal(normalizeStrictCaseConferenceDecision({ ...valid, kind: "training_target" }), null);
  assert.equal(
    normalizeStrictCaseConferenceDecision({
      ...valid,
      revision: {
        type: "nutrition_target",
        summary: "Malformed nested revision",
        nutrition: { target_kcal: "2075", protein_g: 175, carbs_g: null, fat_g: null, delta_kcal: 100 },
        notes: null,
      },
    }),
    null
  );
});

test("strict conductor contract rejects coercible or out-of-range nested plan fields", () => {
  const validUpdate = conductorDecision({
    domain: "training",
    revision: {
      type: "plan_update",
      summary: "Bounded update",
      changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 3, target_weight: 120 }],
    },
  });
  assert.ok(normalizeStrictCaseConferenceDecision(validUpdate));
  for (const change of [
    { day_number: "1", exercise: "Barbell Bench Press", sets: 3, target_weight: 120 },
    { day_number: 1, exercise: "Barbell Bench Press", sets: "3", target_weight: 120 },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 3, target_weight: "120" },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 21, target_weight: 120 },
    { day_number: 1, exercise: "Barbell Bench Press", sets: 3, target_weight: -1 },
  ]) {
    assert.equal(
      normalizeStrictCaseConferenceDecision({
        ...validUpdate,
        revision: { ...validUpdate.revision, changes: [change] },
      }),
      null
    );
  }

  const validRestructure = conductorDecision({
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
      ],
    },
  });
  assert.ok(normalizeStrictCaseConferenceDecision(validRestructure));
  for (const days of [
    [{ ...validRestructure.revision.days[0], day_number: "1" }],
    [
      {
        ...validRestructure.revision.days[0],
        items: [{ exercise: "Barbell Bench Press", sets: "3", target_weight: 115 }],
      },
    ],
    [
      {
        ...validRestructure.revision.days[0],
        items: [{ exercise: "Barbell Bench Press", sets: 3, target_weight: "115" }],
      },
    ],
  ]) {
    assert.equal(
      normalizeStrictCaseConferenceDecision({
        ...validRestructure,
        revision: { ...validRestructure.revision, days },
      }),
      null
    );
  }
});

test("conductor repair rejects wrong kind and malformed revision before rotating to a valid provider", async () => {
  const valid = conductorDecision({ domain: "nutrition" });
  let parses = 0;
  const result = await runCaseConference(
    "auto",
    { question: "Reconcile the next fuel step.", domains: ["nutrition", "recovery"] },
    {
      context: healthyContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      chosen: async (_agent, prompt, opts) =>
        runAgentWithFallback(["stub", "stub"], prompt, {
          ...opts,
          extract: () => {
            parses += 1;
            if (parses === 1) return { ...valid, kind: "training_target" };
            if (parses === 2)
              return {
                ...valid,
                revision: {
                  type: "plan_update",
                  summary: "Malformed nested revision",
                  changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: "3", target_weight: 120 }],
                },
              };
            return valid;
          },
        }),
    }
  );

  assert.equal(parses, 3);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, undefined);
  assert.equal(result.decision.kind, "case_conference");
});

test("a malformed nested conductor revision degrades to advice and never becomes a proposal", async () => {
  let parses = 0;
  const result = await runCaseConference(
    "auto",
    { question: "Adjust fuel carefully.", domains: ["nutrition", "recovery"] },
    {
      context: deficitStrainContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      chosen: async (_agent, prompt, opts) =>
        runAgentWithFallback(["stub"], prompt, {
          ...opts,
          extract: () => {
            parses += 1;
            return conductorDecision({
              domain: "nutrition",
              revision: {
                type: "nutrition_target",
                summary: "Malformed fuel target",
                nutrition: { target_kcal: "2075", protein_g: 175, carbs_g: null, fat_g: null, delta_kcal: 100 },
                notes: null,
              },
            });
          },
        }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(parses, 2, "the malformed nested revision receives one repair attempt before safe degradation");
  assert.equal(result.degraded, true);
  assert.equal(result.decision.revision, null);
  assert.equal(result.proposal_id, undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
});

test("cancellation after specialist work propagates and persists no proposal or decision", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "lead" });
  const controller = new AbortController();
  await assert.rejects(
    runCaseConference(
      "auto",
      { question: "Make a bounded bench adjustment.", domains: ["training", "recovery"] },
      {
        context: healthyContext,
        specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
        conductorRun: async () => {
          controller.abort();
          return conductorDecision({
            domain: "training",
            revision: {
              type: "plan_update",
              summary: "Small bench step",
              changes: [{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 120 }],
            },
          });
        },
        signal: controller.signal,
      }
    ),
    /canceled/
  );

  assert.equal(repo.getPlanDay(1).items[0].target_weight, 115);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
});

test("all invalid conductor attempts preserve valid specialists as safe degraded advice", async () => {
  const result = await runCaseConference(
    "auto",
    { question: "Reconcile fuel and recovery.", domains: ["nutrition", "recovery"] },
    {
      context: deficitStrainContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      chosen: async () => {
        throw new Error("all conductor contracts invalid");
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.decision.revision, null);
  assert.equal(result.proposal_id, undefined);
  assert.deepEqual(result.unresolved_conflicts, ["deficit_recovery"]);
});

test("daily conference budget counts durable started attempts even when none produced a decision", async () => {
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO agent_jobs (status, kind, started_at, input_json)
       VALUES ('error', 'case_conference', '2026-07-09 08:00:00', '{}')`
    ).run();
  }

  const result = await runCaseConference(
    "stub",
    { question: "Try once more.", domains: ["training"] },
    { now: () => new Date("2026-07-09T12:00:00Z") }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "daily conference budget exhausted");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
});

test("a conference can route a typed nutrition target through the proposal and autonomy path", async () => {
  repo.setProfile({ age: 44, height_cm: 170.2, weight_lb: 174.2, goal_weight_lb: 164, goal_mode: "lose" });
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "Adjust the cut fuel target.", domains: ["nutrition", "recovery"] },
    {
      context: deficitStrainContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain, { autonomy_ceiling: "quiet_apply" }),
      conductorRun: async () =>
        conductorDecision({
          domain: "nutrition",
          resolved_conflicts: [
            {
              key: "deficit_recovery",
              evidence_key: "nutrition:evidence",
              resolution: "Use a small carb-led increase.",
            },
          ],
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

// ---- a conference is a bundle, routed action by action (2026-09-25 ruling) ----------
// Live shape (brain_decisions 27114): an act-now lipid finding beside a bundle of ordinary
// coaching — a calorie/protein hold, an intake gap, strength aggression during the cut,
// session sizing, an easy-run ceiling. Two coaching trade-offs stayed open and the old
// floor read the whole envelope as clinical, so everything sat at the clinician tier.
const liveBundleContext = () => ({
  ...deficitStrainContext(),
  endurance_goal: { mode: "race", is_race: true, distance_km: 21.1, phase: "build" },
  health_focus: lipidContext().health_focus,
  directives: lipidContext().directives,
});

const LIVE_PARALLEL_ACTIONS = [
  "Hold 2,407 kcal and 175 g protein through the settling window.",
  "Close the logged-intake gap on training days.",
  "Hold strength aggression at RIR 1-2 during the cut.",
  "Size sessions to 30-40 minutes.",
  "Keep easy runs under the aerobic ceiling.",
  "Ask your doctor whether a statin medication fits ApoB 134 and Lp(a) 102.8.",
];

test("a mixed bundle: the fueling hold lands with a heads-up, only the clinical step goes to the doctor", async () => {
  repo.setSettings({ lead_mode: "lead" });
  const result = await runCaseConference(
    "stub",
    { question: "What should the next two weeks be?", domains: ["training", "nutrition", "recovery", "health"] },
    {
      context: liveBundleContext,
      specialistRun: async (_agent, _prompt, domain) =>
        opinion(domain, { autonomy_ceiling: domain === "health" ? "clinician" : "ask" }),
      // Adversarial in every self-attesting field: clinical risk, clinician tier, irreversible.
      conductorRun: async () =>
        conductorDecision({
          domain: "cross_domain",
          risk_class: "clinical",
          autonomy_tier: "clinician",
          reversible: false,
          parallel_actions: LIVE_PARALLEL_ACTIONS,
          revision: {
            type: "nutrition_target",
            summary: "Hold the settling-window target",
            nutrition: { target_kcal: 2407, protein_g: 175, carbs_g: null, fat_g: null, delta_kcal: 0 },
            notes: "Hold through the settling window.",
          },
        }),
    }
  );

  assert.ok(result.conflicts.includes("deficit_recovery") && result.conflicts.includes("race_strength"));
  assert.ok(!result.conflicts.includes("clinical_autonomy"), "a lipid finding governs no calorie or protein number");
  assert.notEqual(result.decision.autonomy_tier, "clinician");
  assert.notEqual(result.decision.autonomy_tier, "ask", "an open trade-off is announced, never parked, under lead");
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.ok(["announced", "pending", "applied"].includes(recorded.status), `got ${recorded.status}`);
  assert.equal(recorded.context.deterministic_clinical, false);
  assert.equal(recorded.context.conductor_risk_class, "clinical", "what the conductor said is on the record");
  assert.equal(recorded.context.conductor_reversible, false);

  const waiting = repo.awaitingBrainDecisions();
  assert.equal(waiting.filter((row) => !row.for_clinician).length, 0, "nothing in the bundle waits on the athlete");
  const notes = waiting.filter((row) => row.for_clinician);
  assert.equal(notes.length, 1);
  assert.match(notes[0].explanation, /statin/);
});

test("the Oct-4 squat-hold shape: a bounded load hold lands under lead with its receipt", async () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(3, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6, target_weight: 205 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const result = await runCaseConference(
    "stub",
    { question: "How should the lower anchors run through the settling window?", domains: ["training", "recovery"] },
    {
      context: lipidContext,
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () =>
        conductorDecision({
          domain: "training",
          autonomy_tier: "ask",
          reversible: false,
          user_explanation: "Back Squat holds at 185 through Oct 4 instead of the 205 step; RDL holds at 185.",
          revision: {
            type: "plan_update",
            summary: "Hold Day 3 lower-body anchor loads through 2026-10-04",
            changes: [
              { day_number: 3, exercise: "Back Squat", target_weight: 185, reason: "hold through 2026-10-04" },
              { day_number: 3, exercise: "Romanian Deadlift", target_weight: 185, reason: "hold through 2026-10-04" },
            ],
          },
        }),
    }
  );
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.notEqual(recorded.status, "review", "a bounded reversible hold is the team's call, not a question");
  assert.ok(["announced", "pending", "applied"].includes(recorded.status), `got ${recorded.status}`);
  assert.equal(recorded.action.user_explanation.includes("185"), true, "the receipt says what changed and why");
  assert.equal(repo.awaitingBrainDecisions().length, 0);
});

test("a squat hold an OLDER rule put on the clinician floor is re-read by today's rule and re-offered", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(3, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6, target_weight: 205 },
  ]);
  const proposal = repo.createProposal("case_conference", "case conference: lower anchors", "", {
    summary: "Hold Day 3 lower-body anchor loads through 2026-10-04",
    changes: [{ day_number: 3, exercise: "Back Squat", target_weight: 185, reason: "hold through 2026-10-04" }],
  });
  // The co-occurrence rule: an act-now lipid finding plus ANY revision was clinical.
  const held = applyProposalWithAutonomy(Number(proposal.id), { clinical: true });
  assert.equal(held.tier, "clinician");
  repo.patchBrainDecision(Number(held.decision.id), {
    source: "case_conference",
    context: { ...held.decision.context, deterministic_clinical: true, unresolved_conflicts: ["clinical_autonomy"] },
  });
  const lipidInputs = conferenceConflictInputs(lipidContext());

  const thaw = thawParkedReviewDecisions("lead", { conflictInputs: () => lipidInputs });
  assert.equal(thaw.thawed, 1);
  const reread = getBrainDecision(Number(held.decision.id));
  assert.equal(reread.context.floor_reread.clinical, false, "a lipid finding governs no squat load");
  assert.ok(
    ["pending", "announced", "applied"].includes(String(repo.getProposal(Number(proposal.id)).autonomy?.status)),
    "the hold owns a boundary now"
  );
  assert.equal(repo.awaitingBrainDecisions().length, 0);
});

test("a referral or a lab retest is filed for the doctor, but only clinical words gate a change", async () => {
  const { clinicalActionText, clinicianNoteText } = await import("../dist/brain/autonomy.js");
  for (const line of [
    "Book a cardiology referral about Lp(a).",
    "Retest ApoB with your doctor in 12 weeks.",
    "Ask your physician whether a statin fits.",
  ]) {
    assert.equal(clinicianNoteText(line), true, line);
    assert.equal(clinicalActionText(line), false, `${line} — a note, never the floor`);
  }
  assert.equal(clinicianNoteText("Hold 2,407 kcal and 175 g protein through the settling window."), false);
  assert.equal(clinicianNoteText("Keep easy runs under the aerobic ceiling."), false);
  assert.equal(clinicianNoteText("Review the medication dosage."), true, "the floor's words are notes too");
});

// ---- a re-offered revision keeps the tier it was asked at; a volume cut is structural ----

test("a thawed conference hold is re-offered at the tier it was asked at, never re-derived quieter", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(3, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6, target_weight: 205 },
  ]);
  const proposal = repo.createProposal("case_conference", "case conference: lower anchors", "", {
    summary: "Hold Day 3 squat at 185",
    changes: [{ day_number: 3, exercise: "Back Squat", target_weight: 185 }],
  });
  // An older pass parked it at the specialist's ask.
  const held = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "ask" });
  assert.equal(held.decision.status, "review");
  assert.equal(held.decision.context.policy_inputs.requested_tier, "ask");
  repo.patchBrainDecision(Number(held.decision.id), { source: "case_conference" });

  const thaw = thawParkedReviewDecisions("lead");
  assert.equal(thaw.thawed, 1);
  // Under lead an ask is a heads-up (leadModelCeiling) — announced, never a quiet landing.
  assert.equal(String(repo.getProposal(Number(proposal.id)).autonomy?.status), "announced");
});

test("a plan_update that CUTS sets is structural on every routing path, not a bounded target nudge", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(3, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 6, target_weight: 205 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  const cut = (agent, instruction = "case conference: volume") =>
    repo.createProposal(agent, instruction, "", {
      summary: "Take a set off the Day 3 squat",
      changes: [{ day_number: 3, exercise: "Back Squat", sets: 3 }],
    });
  // Re-offered with nothing at all (the shape a thaw or an orphan adoption re-derives from).
  const coach = applyProposalWithAutonomy(Number(cut("case_conference").id), {});
  assert.equal(coach.decision.kind, "training_structure");
  assert.equal(coach.decision.status, "announced", "a cut announces rather than landing quietly");

  // A load-only change on the same day is still a bounded target nudge.
  const nudge = repo.createProposal("case_conference", "case conference: load", "", {
    summary: "Hold the RDL at 175",
    changes: [{ day_number: 3, exercise: "Romanian Deadlift", target_weight: 175 }],
  });
  const quiet = applyProposalWithAutonomy(Number(nudge.id), {});
  assert.equal(quiet.decision.kind, "training_target");

  // The athlete's own cut is their decision, and a protective step is what quiet_apply
  // exists for: neither is turned into a structural announcement.
  const asked = applyProposalWithAutonomy(Number(cut("chat").id), { explicit_user_request: true });
  assert.notEqual(asked.decision?.kind, "training_structure");
  const protective = applyProposalWithAutonomy(Number(cut("energy-deficiency").id), {
    requested_tier: "quiet_apply",
    safety_response: true,
  });
  assert.notEqual(protective.decision?.kind, "training_structure");
  // Nor is a cut drafted from the athlete's conversation, or the routine engine's own
  // step, whatever later routes it with nothing (a thaw, an orphan adoption).
  const fromChat = applyProposalWithAutonomy(Number(cut("chat", "chat: plan edit").id), {});
  assert.notEqual(fromChat.decision?.kind, "training_structure");
  const routine = applyProposalWithAutonomy(Number(cut("auto-progression", "auto: progression").id), {});
  assert.notEqual(routine.decision?.kind, "training_structure");
});
