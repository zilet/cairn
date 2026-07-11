import { db } from "../../db.js";
import { decideAutonomyTier } from "../../brain/autonomy.js";
import { normalizeCaseConferenceDecision, type CaseConferenceDecision } from "../../brain/case-conference-contract.js";
import { normalizeJsonObject } from "../../brain/contract-utils.js";
import { createImmutableBrainSnapshot, type ImmutableBrainSnapshot } from "../../brain/snapshot-id.js";
import {
  normalizeSpecialistOpinion,
  type SpecialistDomain,
  type SpecialistOpinion,
} from "../../brain/specialist-contract.js";
import { getCoachContext } from "../../repo/coach.js";
import { getSettings } from "../../repo/settings.js";
import { patchBrainDecision, recordDecision } from "../../repo/brain-decisions.js";
import { createProposal } from "../../repo/profile.js";
import { runChosen, runChosenWithCoachReads } from "../../runChosen.js";
import { applyProposalWithAutonomy } from "./autonomy-service.js";

export type ConferenceConflictKey =
  | "injury_load"
  | "deficit_recovery"
  | "medication_supplement"
  | "allergy_meal"
  | "race_strength"
  | "clinical_autonomy";

export function deterministicConferenceConflicts(context: any): ConferenceConflictKey[] {
  const text = JSON.stringify(context ?? {}).toLowerCase();
  const conflicts: ConferenceConflictKey[] = [];
  if (/injur|joint.?pain|chest.?wall/.test(text) && /load|progress|volume|training/.test(text))
    conflicts.push("injury_load");
  if (/deficit|fat.?loss|cut/.test(text) && /poor.?recovery|low.?hrv|fatigue|declining.?performance/.test(text))
    conflicts.push("deficit_recovery");
  if (/medication/.test(text) && /supplement/.test(text)) conflicts.push("medication_supplement");
  if (/allerg/.test(text) && /meal|recipe|food/.test(text)) conflicts.push("allergy_meal");
  if (/race|marathon|10k|5k/.test(text) && /strength|hypertrophy|lifting/.test(text)) conflicts.push("race_strength");
  if (/clinical|diagnos|medication|dose/.test(text) && /quiet_apply|announce|auto.?apply/.test(text))
    conflicts.push("clinical_autonomy");
  return [...new Set(conflicts)];
}

export interface CaseConferenceResult {
  ok: boolean;
  snapshot_id: string;
  opinions: SpecialistOpinion[];
  unavailable: SpecialistDomain[];
  conflicts: ConferenceConflictKey[];
  unresolved_conflicts: ConferenceConflictKey[];
  decision: CaseConferenceDecision | null;
  recorded_decision_id?: number;
  proposal_id?: number;
  execution?: {
    ok: boolean;
    tier: string | null;
    applied: boolean;
    announced: boolean;
    pending: boolean;
    reasons: string[];
  };
  degraded?: boolean;
  error?: string;
}

export interface CaseConferenceDeps {
  context?: () => unknown;
  specialistRun?: (
    agent: string | undefined,
    prompt: string,
    domain: SpecialistDomain,
    snapshot: ImmutableBrainSnapshot,
    maxCalls: number
  ) => Promise<unknown>;
  conductorRun?: (agent: string | undefined, prompt: string) => Promise<unknown>;
  now?: () => Date;
}

function specialistPrompt(
  domain: SpecialistDomain,
  question: string,
  snapshot: ImmutableBrainSnapshot,
  conflicts: ConferenceConflictKey[]
): string {
  return `You are Cairn's ${domain} specialist in a multidisciplinary case conference. Return ONLY a SpecialistOpinion JSON object; no hidden reasoning or transcript. Use evidence_keys for the facts that matter, name uncertainty, and never exceed clinical or safety boundaries. Snapshot id: ${snapshot.id}. Question: ${question}. Deterministic conflicts already detected: ${JSON.stringify(conflicts)}. Immutable bounded context: ${JSON.stringify(snapshot.context)}`;
}

function conductorPrompt(
  question: string,
  snapshot: ImmutableBrainSnapshot,
  opinions: SpecialistOpinion[],
  conflicts: ConferenceConflictKey[]
): string {
  return `You are Cairn's conductor. Reconcile the structured specialist opinions into ONE CaseConferenceDecision JSON object with kind, domain, summary, rationale, risk_class, reversible, autonomy_tier, parallel_actions, resolved_conflicts[{key,resolution}], deferred, expectations, review_window, user_explanation, and revision. Every deterministic conflict must appear in resolved_conflicts or the server will safely demote the decision. revision is null for advice only, exactly {"type":"plan_update","summary":"...","changes":[...]} for bounded existing-plan changes, {"type":"plan_restructure","summary":"...","days":[...]} for a full split rewrite, or {"type":"nutrition_target","summary":"...","nutrition":{"target_kcal":0,"protein_g":0,"carbs_g":null,"fat_g":null,"delta_kcal":0},"notes":"..."} for a bounded fueling adjustment. Never claim a change is live in prose; the server owns proposal creation, safety clamps, autonomy, and natural-boundary application. Never output a debate transcript. Clinical decisions stay clinician-directed. Snapshot id: ${snapshot.id}. Question: ${question}. Conflicts: ${JSON.stringify(conflicts)}. Opinions: ${JSON.stringify(opinions)}`;
}

const TIER_ORDER = ["observe", "quiet_apply", "announce", "ask", "clinician"] as const;

function moreRestrictiveTier(
  first: (typeof TIER_ORDER)[number],
  second: (typeof TIER_ORDER)[number]
): (typeof TIER_ORDER)[number] {
  return TIER_ORDER.indexOf(first) >= TIER_ORDER.indexOf(second) ? first : second;
}

function boundedStrings(value: unknown, max = 20): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, max)
    : [];
}

function conferenceContext(
  base: unknown,
  input: { trajectory?: unknown; optimizes?: unknown; parks?: unknown }
): unknown {
  const root = base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, unknown> : {};
  if (input.trajectory == null && input.optimizes == null && input.parks == null) return root;
  return {
    ...root,
    whole_person_trajectory: input.trajectory ?? null,
    conference_focus: {
      optimizes: boundedStrings(input.optimizes),
      parks: boundedStrings(input.parks),
    },
  };
}

function executionSummary(result: any): NonNullable<CaseConferenceResult["execution"]> {
  return {
    ok: result?.ok === true,
    tier: typeof result?.tier === "string" ? result.tier : null,
    applied: result?.applied === true || result?.decision?.status === "applied",
    announced: result?.announced === true || result?.decision?.status === "announced",
    pending: result?.pending === true || result?.decision?.status === "pending",
    reasons: boundedStrings(result?.reasons, 10),
  };
}

function fallbackConferenceDecision(
  opinions: SpecialistOpinion[],
  conflicts: ConferenceConflictKey[],
  unavailable: SpecialistDomain[]
): CaseConferenceDecision {
  const preferred =
    opinions.find((opinion) => conflicts.includes("deficit_recovery") && opinion.domain === "nutrition") ??
    opinions.find((opinion) => opinion.domain === "recovery") ??
    opinions[0];
  const autonomy = opinions.reduce<(typeof TIER_ORDER)[number]>(
    (ceiling, opinion) => moreRestrictiveTier(ceiling, opinion.autonomy_ceiling),
    conflicts.includes("clinical_autonomy") ? "clinician" : "ask"
  );
  const expectations = opinions.flatMap((opinion) => opinion.expected_outcomes).slice(0, 10);
  return {
    kind: "case_conference",
    domain: preferred.domain,
    summary: preferred.recommendation.slice(0, 300),
    rationale: preferred.rationale.slice(0, 1_500),
    risk_class: conflicts.includes("clinical_autonomy") ? "clinical" : conflicts.length ? "moderate" : "low",
    reversible: false,
    autonomy_tier: autonomy,
    parallel_actions: opinions.filter((opinion) => opinion !== preferred).map((opinion) => opinion.recommendation).slice(0, 10),
    resolved_conflicts: [],
    deferred: [
      ...conflicts.map((conflict) => `${conflict}: held for conservative review`),
      ...unavailable.map((domain) => `${domain} specialist unavailable`),
    ].slice(0, 10),
    expectations,
    review_window: "Review at the next material signal or within two weeks.",
    user_explanation: preferred.recommendation.slice(0, 700),
    revision: null,
  };
}

export async function runCaseConference(
  agent: string | undefined,
  input: {
    question: string;
    domains: SpecialistDomain[];
    trajectory?: unknown;
    optimizes?: string[];
    parks?: string[];
  },
  deps: CaseConferenceDeps = {}
): Promise<CaseConferenceResult> {
  const question = String(input.question || "")
    .trim()
    .slice(0, 1_000);
  const domains = [...new Set(input.domains)]
    .filter((domain) => ["training", "nutrition", "health", "recovery", "lifestyle"].includes(domain))
    .slice(0, 5);
  const now = (deps.now ?? (() => new Date()))();
  const today = now.toISOString().slice(0, 10);
  const count = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM brain_decisions
           WHERE (kind = 'case_conference' OR source = 'case_conference') AND substr(created_at,1,10) = ?`
        )
        .get(today) as any
    )?.n ?? 0
  );
  if (count >= 3)
    return {
      ok: false,
      snapshot_id: "",
      opinions: [],
      unavailable: domains,
      conflicts: [],
      unresolved_conflicts: [],
      decision: null,
      error: "daily conference budget exhausted",
    };
  const snapshot = createImmutableBrainSnapshot(
    conferenceContext((deps.context ?? getCoachContext)(), input),
    now
  );
  const conflicts = deterministicConferenceConflicts(snapshot.context);
  const perSpecialistCalls = Math.max(1, Math.floor(12 / Math.max(1, domains.length)));
  const specialistRun =
    deps.specialistRun ??
    (async (chosen, prompt, domain, snap, maxCalls) => {
      const out = await runChosenWithCoachReads(chosen, prompt, {
        op: `conference_${domain}`,
        mode: "conference",
        maxCalls,
        runId: `${snap.id}:${domain}`,
      });
      return out.result.parsed;
    });
  const settled = await Promise.allSettled(
    domains.map(async (domain) => {
      const value = await specialistRun(
        agent,
        specialistPrompt(domain, question, snapshot, conflicts),
        domain,
        snapshot,
        perSpecialistCalls
      );
      const opinion = normalizeSpecialistOpinion(value);
      if (!opinion || opinion.domain !== domain) throw new Error("invalid specialist opinion");
      return opinion;
    })
  );
  const opinions: SpecialistOpinion[] = [];
  const unavailable: SpecialistDomain[] = [];
  settled.forEach((result, index) =>
    result.status === "fulfilled" ? opinions.push(result.value) : unavailable.push(domains[index])
  );
  if (!opinions.length)
    return {
      ok: false,
      snapshot_id: snapshot.id,
      opinions,
      unavailable,
      conflicts,
      unresolved_conflicts: conflicts,
      decision: null,
      error: "specialists unavailable; use deterministic floors",
    };
  const conductorRun =
    deps.conductorRun ??
    (async (chosen, prompt) => (await runChosen(chosen, prompt, { op: "case_conference" })).result.parsed);
  const rawDecision = await conductorRun(agent, conductorPrompt(question, snapshot, opinions, conflicts));
  const normalizedDecision = normalizeCaseConferenceDecision(rawDecision);
  const degraded = normalizedDecision == null;
  // Valid specialist work must never disappear because the conductor emitted a
  // malformed envelope. Preserve one conservative, advice-only voice, leave all
  // conflicts unresolved, and hold it for review. No mutation is synthesized.
  const decision = normalizedDecision ?? fallbackConferenceDecision(opinions, conflicts, unavailable);
  const accounted = new Set(
    decision.resolved_conflicts
      .map((item) => item.key)
      .filter((key): key is ConferenceConflictKey => conflicts.includes(key as ConferenceConflictKey))
  );
  const unresolvedConflicts = conflicts.filter((conflict) => !accounted.has(conflict));
  // The clinician floor is deterministic. The conflict is detected from the bounded
  // snapshot, and a conductor echoing "clinical_autonomy" into resolved_conflicts —
  // or down-classifying its own risk_class — must never lower that floor: a
  // clinical decision stays clinician-directed even when the clinical specialist
  // was absent or permissive.
  const clinicalActionText = JSON.stringify({
    summary: decision.summary,
    revision: decision.revision,
    parallel_actions: decision.parallel_actions,
  }).toLowerCase();
  const deterministicClinical =
    conflicts.includes("clinical_autonomy") || /diagnos|medication|dosage|\bdose\b|prescri/.test(clinicalActionText);
  if (deterministicClinical && decision.risk_class !== "clinical") decision.risk_class = "clinical";
  let specialistCeiling = opinions.reduce<(typeof TIER_ORDER)[number]>(
    (ceiling, opinion) =>
      moreRestrictiveTier(ceiling, opinion.autonomy_ceiling),
    decision.autonomy_tier
  );
  if (unresolvedConflicts.length) {
    specialistCeiling = moreRestrictiveTier(
      specialistCeiling,
      unresolvedConflicts.includes("clinical_autonomy") ? "clinician" : "ask"
    );
  }
  const executableKind =
    decision.revision?.type === "plan_restructure"
      ? "training_structure"
      : decision.revision?.type === "nutrition_target"
        ? "nutrition_target"
        : "training_target";
  const policy = decideAutonomyTier({
    kind: decision.revision ? executableKind : decision.kind,
    risk_class: decision.risk_class,
    reversible: decision.reversible,
    requested_tier: specialistCeiling,
    lead_mode: getSettings().lead_mode,
    clinical: deterministicClinical || decision.risk_class === "clinical",
  });
  decision.autonomy_tier = policy.tier;

  const trajectory = (snapshot.context as any).whole_person_trajectory ?? null;
  const focus = (snapshot.context as any).conference_focus ?? {};
  const sharedContext = normalizeJsonObject({
    snapshot_id: snapshot.id,
    question,
    conflicts,
    unresolved_conflicts: unresolvedConflicts,
    unavailable,
    review_window: decision.review_window,
    trajectory,
    optimizes: boundedStrings(focus.optimizes),
    parks: boundedStrings(focus.parks),
  }) ?? {};
  const sharedSpecialist = normalizeJsonObject({
    snapshot_id: snapshot.id,
    opinions,
    trajectory,
    optimizes: boundedStrings(focus.optimizes),
    parks: boundedStrings(focus.parks),
  }) ?? {};

  if (decision.revision) {
    const parsed = decision.revision.type === "plan_restructure"
      ? {
          summary: decision.revision.summary ?? decision.summary,
          rationale: decision.rationale,
          days: decision.revision.days,
        }
      : decision.revision.type === "nutrition_target"
        ? {
            kind: "nutrition_target",
            summary: decision.revision.summary ?? decision.summary,
            nutrition: decision.revision.nutrition,
            notes: decision.revision.notes ?? decision.rationale,
          }
        : {
          summary: decision.revision.summary ?? decision.summary,
          rationale: decision.rationale,
          changes: decision.revision.changes,
        };
    const proposal = createProposal("case_conference", `case conference: ${question}`, JSON.stringify(rawDecision), parsed);
    const autonomy = applyProposalWithAutonomy(proposal.id, { requested_tier: policy.tier });
    const execution = executionSummary(autonomy);
    const autonomyDecision = autonomy?.decision?.id ? patchBrainDecision(Number(autonomy.decision.id), {
      source: "case_conference",
      context: { ...(autonomy.decision.context ?? {}), ...sharedContext },
      action: {
        ...(autonomy.decision.action ?? {}),
        conference_revision_type: decision.revision.type,
        parallel_actions: decision.parallel_actions,
        resolved_conflicts: decision.resolved_conflicts,
        deferred: decision.deferred,
        user_explanation: decision.user_explanation,
      },
      specialist: sharedSpecialist,
      evaluator_version: decision.expectations.length
        ? "case-conference-v2"
        : autonomy.decision.evaluator_version,
    }) : null;
    if (autonomyDecision) {
      recordDecision(autonomyDecision, decision.expectations);
      decision.autonomy_tier = autonomyDecision.autonomy_tier;
      return {
        ok: autonomy?.ok === true,
        snapshot_id: snapshot.id,
        opinions,
        unavailable,
        conflicts,
        unresolved_conflicts: unresolvedConflicts,
        decision,
        recorded_decision_id: autonomyDecision.id,
        proposal_id: proposal.id,
        execution,
        ...(degraded ? { degraded: true } : {}),
        ...(autonomy?.ok === true ? {} : { error: String(autonomy?.error ?? "conference revision was not actionable") }),
      };
    }

    // A held/rejected executable recommendation stays a review record linked to
    // its real proposal. It is never marked announced without a boundary-appliable
    // proposal decision, which prevents inert announcements.
    const heldTier = policy.tier === "observe" ? "observe" : policy.tier === "clinician" ? "clinician" : "ask";
    decision.autonomy_tier = heldTier;
    const held = recordDecision({
      effective_date: null,
      kind: "case_conference",
      domain: decision.domain,
      summary: decision.summary,
      rationale: decision.rationale,
      source: "case_conference",
      source_ref_type: "plan_proposal",
      source_ref_key: String(proposal.id),
      status: heldTier === "observe" ? "observed" : "review",
      autonomy_tier: heldTier,
      risk_class: decision.risk_class,
      reversible: false,
      input_fingerprint: null,
      context: { ...sharedContext, proposal_held: true, policy_reasons: execution.reasons },
      action: {
        proposal_id: proposal.id,
        conference_revision_type: decision.revision.type,
        parallel_actions: decision.parallel_actions,
        resolved_conflicts: decision.resolved_conflicts,
        deferred: decision.deferred,
        user_explanation: decision.user_explanation,
      },
      specialist: sharedSpecialist,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    return {
      ok: autonomy?.ok === true,
      snapshot_id: snapshot.id,
      opinions,
      unavailable,
      conflicts,
      unresolved_conflicts: unresolvedConflicts,
      decision,
      recorded_decision_id: held.decision.id,
      proposal_id: proposal.id,
      execution,
      ...(degraded ? { degraded: true } : {}),
      ...(autonomy?.ok === true ? {} : { error: String(autonomy?.error ?? "conference revision was not actionable") }),
    };
  }

  // Advice-only output cannot be executed at a natural boundary, so an agent's
  // quiet_apply/announce request is safely held for review instead of creating a
  // zombie announced decision.
  const advisoryTier = policy.tier === "observe" ? "observe" : policy.tier === "clinician" ? "clinician" : "ask";
  decision.autonomy_tier = advisoryTier;
  const recorded = recordDecision(
    {
      effective_date: null,
      kind: "case_conference",
      domain: decision.domain,
      summary: decision.summary,
      rationale: decision.rationale,
      source: "case_conference",
      source_ref_type: null,
      source_ref_key: null,
      status: advisoryTier === "observe" ? "observed" : "review",
      autonomy_tier: advisoryTier,
      risk_class: decision.risk_class,
      reversible: decision.reversible,
      input_fingerprint: null,
      context: { ...sharedContext, advisory_only: true },
      action: {
        parallel_actions: decision.parallel_actions,
        resolved_conflicts: decision.resolved_conflicts,
        deferred: decision.deferred,
        user_explanation: decision.user_explanation,
      },
      specialist: sharedSpecialist,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    },
    []
  );
  return {
    ok: true,
    snapshot_id: snapshot.id,
    opinions,
    unavailable,
    conflicts,
    unresolved_conflicts: unresolvedConflicts,
    decision,
    recorded_decision_id: recorded.decision.id,
    ...(degraded ? { degraded: true } : {}),
  };
}
