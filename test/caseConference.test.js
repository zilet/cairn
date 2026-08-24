import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicConferenceConflicts, runCaseConference } from "../dist/domain/brain/case-conference.js";
import { getBrainDecision } from "../dist/repo/brain-decisions.js";
import { applyDueAnnouncedDecisions } from "../dist/domain/brain/autonomy-service.js";
import { normalizeStrictCaseConferenceDecision } from "../dist/brain/case-conference-contract.js";
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
    lead: { group: "Iron & Blood", tier: "act_now", flagged: true },
    act_now: 1,
    track: 0,
  },
  directives: [{ domain: "nutrition", marker: "Ferritin", directive: "Pair iron-rich food with vitamin C." }],
});

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
  assert.ok(
    result.unresolved_conflicts.includes("clinical_autonomy"),
    "no citation can close a clinical conflict — the floor is the server's"
  );
  assert.ok(
    !result.unresolved_conflicts.includes("medication_supplement"),
    "an ordinary conflict with a real citation does close"
  );
});

test("a decision whose own action carries medication changes is clinician-directed even without a flagged snapshot", async () => {
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
