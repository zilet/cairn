import { db } from "../../db.js";
import { CASE_CONFERENCE_DECISION_SCHEMA, SPECIALIST_OPINION_SCHEMA } from "../../agent-contracts.js";
import { decideAutonomyTier, leadModelCeiling } from "../../brain/autonomy.js";
import {
  normalizeStrictCaseConferenceDecision,
  type CaseConferenceDecision,
} from "../../brain/case-conference-contract.js";
import { AUTONOMY_TIERS, BRAIN_DOMAINS, BRAIN_RISK_CLASSES } from "../../brain/decision-contract.js";
import {
  BRAIN_METRIC_KEYS,
  EXPECTATION_CONFIDENCE,
  EXPECTATION_CONFOUNDER_POLICIES,
  EXPECTATION_DIRECTIONS,
  EXPECTATION_EVALUATORS,
} from "../../brain/expectation-contract.js";
import { normalizeJsonObject } from "../../brain/contract-utils.js";
import { createImmutableBrainSnapshot, type ImmutableBrainSnapshot } from "../../brain/snapshot-id.js";
import {
  isSpecialistOpinion,
  normalizeSpecialistOpinion,
  SPECIALIST_DOMAINS,
  type SpecialistDomain,
  type SpecialistOpinion,
} from "../../brain/specialist-contract.js";
import {
  citedConflictResolutions,
  clinicalAutonomyFromRevision,
  conferenceConflictInputs,
  conflictIsSafetyFloor,
  conflictParties,
  conflictsFromInputs,
  deterministicConferenceConflicts,
  revisionHoldsClinicalFloor,
  type ConferenceConflictKey,
} from "./conference-conflicts.js";
import { getCoachContext } from "../../repo/coach.js";
import { projectCoachContext } from "../../prompt/context-projection.js";
import { localDateISO } from "../../repo/shared.js";
import { listTrainingSymptoms } from "../../repo/training-symptoms.js";
import { getSettings } from "../../repo/settings.js";
import { patchBrainDecision, recordDecision } from "../../repo/brain-decisions.js";
import { MAX_DEFERRED_EXPECTATIONS } from "../../repo/brain/change-expectations.js";
import { createProposal } from "../../repo/proposals.js";
import { changesReduceSets } from "../../repo/volume-guard.js";
import { runChosen, runChosenWithCoachReads } from "../../runChosen.js";
import {
  applyProposalWithAutonomy,
  conferenceClinicianNotes,
  recordConferenceClinicianNotes,
} from "./autonomy-service.js";
import { specialistCharter } from "./specialist-charters.js";
import { blockPriority, type PriorityTrack } from "../../repo/road-ahead.js";

// The conflict layer lives in its own module (typed predicates over context
// VALUES, never over serialized key names). Re-exported here because this is
// where every caller already reaches for it.
export type { ConferenceConflictInputs } from "./conference-conflicts.js";
export {
  citedConflictResolutions,
  clinicalAutonomyFromRevision,
  conferenceConflictInputs,
  conflictParties,
  conflictsFromInputs,
  deterministicConferenceConflicts,
};
export type { ConferenceConflictKey };

/** Lifecycle symptoms currently ACTIVE and area-scoped, as display labels. Never
 * a systemic report (which must not drive movement relevance) and never a legacy
 * row nobody confirmed (absence of evidence). Best-effort: a read that throws
 * leaves the conflict layer with `null` — nothing looked — rather than a false
 * "nothing hurts". */
function defaultActiveSymptomAreas(on: string): string[] | null {
  try {
    // seed_legacy:false — the default backfills legacy rows, and a read that
    // decides a conflict must not write on its way past (same reason coach.ts
    // passes it on its own lifecycle read).
    return listTrainingSymptoms({ on, include_resolved: false, seed_legacy: false })
      .filter((event) => event.status === "active" && event.scope !== "systemic" && !event.legacy_unconfirmed)
      .map((event) => event.area_text);
  } catch {
    return null;
  }
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
  chosenWithReads?: typeof runChosenWithCoachReads;
  chosen?: typeof runChosen;
  /** Active area-scoped symptom labels — evidence the coach context cannot carry. */
  symptomAreas?: (on: string) => string[] | null;
  now?: () => Date;
  /** Running durable job, excluded when counting prior daily attempts. */
  jobId?: number;
  signal?: AbortSignal;
}

const EXPECTATION_PROMPT_SCHEMA = {
  type: "object",
  required: [
    "metric_key",
    "subject_key",
    "direction",
    "baseline",
    "target",
    "window_start",
    "window_end",
    "minimum_data",
    "confounder_policy",
    "confidence",
    "evaluator",
    "evaluator_version",
  ],
  properties: {
    metric_key: { type: "string", enum: BRAIN_METRIC_KEYS },
    subject_key: { type: ["string", "null"] },
    direction: { type: "string", enum: EXPECTATION_DIRECTIONS },
    baseline: { type: ["object", "null"] },
    target: { type: "object" },
    window_start: { type: "string", format: "YYYY-MM-DD" },
    window_end: { type: "string", format: "YYYY-MM-DD" },
    minimum_data: { type: ["object", "null"] },
    confounder_policy: { type: "string", enum: EXPECTATION_CONFOUNDER_POLICIES },
    confidence: { type: "string", enum: EXPECTATION_CONFIDENCE },
    evaluator: { type: "string", enum: EXPECTATION_EVALUATORS },
    evaluator_version: { type: "string" },
  },
};

const SPECIALIST_PROMPT_SCHEMA = JSON.stringify({
  type: "object",
  required: [
    "domain",
    "recommendation",
    "rationale",
    "evidence_keys",
    "risks",
    "contraindications",
    "uncertainties",
    "expected_outcomes",
    "autonomy_ceiling",
  ],
  properties: {
    domain: { type: "string", enum: SPECIALIST_DOMAINS },
    recommendation: { type: "string" },
    rationale: { type: "string" },
    evidence_keys: { type: "array", minItems: 1, items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    contraindications: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    expected_outcomes: { type: "array", items: EXPECTATION_PROMPT_SCHEMA },
    autonomy_ceiling: { type: "string", enum: AUTONOMY_TIERS },
  },
});

const PLAN_ITEM_PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    exercise: { type: ["string", "null"] },
    sets: { type: ["integer", "null"], minimum: 1, maximum: 20 },
    rep_low: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    rep_high: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    target_weight: { type: ["number", "null"], minimum: 0, maximum: 5_000 },
    note: { type: ["string", "null"] },
    warmup_sets: { type: ["integer", "null"], minimum: 0, maximum: 20 },
    target_seconds: { type: ["integer", "null"], minimum: 1, maximum: 3_600 },
    superset_group: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    mode: { enum: ["reps", "timed", null] },
    kind: { enum: ["strength", "cardio", null] },
    target_distance_km: { type: ["number", "null"], minimum: 0, maximum: 1_000 },
    target_duration_min: { type: ["number", "null"], minimum: 0, maximum: 1_440 },
    target_zone: { type: ["string", "null"] },
    interval: { type: ["object", "null"] },
    interval_json: { type: ["string", "null"] },
  },
};

const PLAN_CHANGE_PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["day_number"],
  properties: {
    day_number: { type: "integer", minimum: 1, maximum: 14 },
    exercise: { type: ["string", "null"] },
    remove: { type: ["boolean", "null"] },
    target_weight: { type: ["number", "null"], minimum: 0, maximum: 5_000 },
    target_seconds: { type: ["integer", "null"], minimum: 1, maximum: 3_600 },
    sets: { type: ["integer", "null"], minimum: 0, maximum: 20 },
    rep_low: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    rep_high: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    reason: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
    mode: { enum: ["reps", "timed", null] },
    swap: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["from", "to"],
      properties: { from: { type: "string" }, to: { type: "string" } },
    },
  },
  anyOf: [{ required: ["exercise"] }, { required: ["swap"] }],
};

const CONFERENCE_PROMPT_SCHEMA = JSON.stringify({
  type: "object",
  required: [
    "kind",
    "domain",
    "summary",
    "rationale",
    "risk_class",
    "reversible",
    "autonomy_tier",
    "parallel_actions",
    "resolved_conflicts",
    "deferred",
    "expectations",
    "review_window",
    "user_explanation",
    "revision",
  ],
  properties: {
    kind: { type: "string", enum: ["case_conference"] },
    domain: { type: "string", enum: BRAIN_DOMAINS },
    summary: { type: "string" },
    rationale: { type: "string" },
    risk_class: { type: "string", enum: BRAIN_RISK_CLASSES },
    reversible: { type: "boolean" },
    autonomy_tier: { type: "string", enum: AUTONOMY_TIERS },
    parallel_actions: { type: "array", items: { type: "string" } },
    resolved_conflicts: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "evidence_key", "resolution"],
        properties: {
          key: { type: "string" },
          evidence_key: { type: "string" },
          resolution: { type: "string" },
        },
      },
    },
    deferred: { type: "array", items: { type: "string" } },
    expectations: { type: "array", items: EXPECTATION_PROMPT_SCHEMA },
    review_window: { type: "string" },
    user_explanation: { type: "string" },
    revision: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "summary", "changes"],
          properties: {
            type: { const: "plan_update" },
            summary: { type: ["string", "null"] },
            changes: {
              type: "array",
              minItems: 1,
              maxItems: 24,
              items: PLAN_CHANGE_PROMPT_SCHEMA,
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "summary", "days"],
          properties: {
            type: { const: "plan_restructure" },
            summary: { type: ["string", "null"] },
            days: {
              type: "array",
              minItems: 1,
              maxItems: 14,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["day_number", "name", "items"],
                properties: {
                  day_number: { type: "integer", minimum: 1, maximum: 14 },
                  name: { type: "string" },
                  focus: { type: ["string", "null"] },
                  items: { type: "array", items: PLAN_ITEM_PROMPT_SCHEMA },
                },
              },
            },
          },
        },
        {
          type: "object",
          required: ["type", "summary", "nutrition", "notes"],
          properties: {
            type: { const: "nutrition_target" },
            summary: { type: ["string", "null"] },
            nutrition: {
              type: "object",
              required: ["target_kcal", "protein_g", "carbs_g", "fat_g", "delta_kcal"],
              properties: {
                target_kcal: { type: "number", minimum: 1200, maximum: 10000 },
                protein_g: { type: "number", minimum: 0, maximum: 500 },
                carbs_g: { type: ["number", "null"] },
                fat_g: { type: ["number", "null"] },
                delta_kcal: { type: ["number", "null"], minimum: -500, maximum: 500 },
              },
            },
            notes: { type: ["string", "null"] },
          },
        },
      ],
    },
  },
});

function specialistPrompt(
  domain: SpecialistDomain,
  question: string,
  snapshot: ImmutableBrainSnapshot,
  conflicts: ConferenceConflictKey[]
): string {
  return `You are Cairn's ${domain} specialist in a multidisciplinary case conference — ${specialistCharter(domain)} Return ONLY a SpecialistOpinion JSON object; no hidden reasoning or transcript. The literal contract is ${SPECIALIST_PROMPT_SCHEMA}. domain MUST be exactly ${JSON.stringify(domain)}. Use evidence_keys for the facts that matter, name uncertainty, and never exceed clinical or safety boundaries. Snapshot id: ${snapshot.id}. Question: ${question}. Deterministic conflicts already detected: ${JSON.stringify(conflicts)}. Immutable bounded context: ${JSON.stringify(snapshot.context)}`;
}

const TRACK_WORDS: Record<PriorityTrack, string> = { muscle: "muscle & strength", race: "the race", cut: "the cut" };

function conductorPrompt(
  question: string,
  snapshot: ImmutableBrainSnapshot,
  opinions: SpecialistOpinion[],
  conflicts: ConferenceConflictKey[],
  priority: readonly PriorityTrack[]
): string {
  // Say honestly what makes a resolution VALID. The old line ("every conflict must
  // appear in resolved_conflicts or the server will demote") trained the model to
  // echo the server's own list, which dissolved every conflict without evidence.
  const resolvable = conflicts
    .map((conflict) => {
      const parties = conflictParties(conflict);
      return parties.length
        ? `${conflict} (closeable only by ${parties.join("/")})`
        : `${conflict} (NOT closeable by citation — a revision that acts on what the act-now finding governs stays clinician-directed whatever you write)`;
    })
    .join("; ");
  return `You are Cairn's conductor. Reconcile the structured specialist opinions into ONE CaseConferenceDecision JSON object. The literal contract is ${CONFERENCE_PROMPT_SCHEMA}. kind MUST be "case_conference". A resolved_conflicts entry is only counted when its evidence_key is one of the evidence_keys of a specialist whose domain is a party to that conflict, and its resolution says in one line how that evidence settles it — naming a conflict without a real citation leaves it unresolved and the decision is safely demoted, so leave a conflict you cannot honestly close out of the array. ${conflicts.length ? `Conflicts open here: ${resolvable}.` : "No deterministic conflicts were detected, so resolved_conflicts should be empty."} revision is null for advice only, exactly {"type":"plan_update","summary":"...","changes":[...]} for bounded existing-plan changes, {"type":"plan_restructure","summary":"...","days":[...]} for a full split rewrite, or {"type":"nutrition_target","summary":"...","nutrition":{"target_kcal":1200,"protein_g":0,"carbs_g":null,"fat_g":null,"delta_kcal":0},"notes":"..."} for a bounded fueling adjustment. Never claim a change is live in prose; the server owns proposal creation, safety clamps, autonomy, and natural-boundary application. Never output a debate transcript. Clinical decisions stay clinician-directed: keep any clinical step (a medication, a referral, a clinical test) in its own parallel_actions sentence and out of the revision — the server routes it to the athlete and their doctor, and it never holds the non-clinical changes beside it. ${
    priority.length
      ? `RECONCILE BY THE BLOCK'S PRIORITY ORDER: ${priority.map((track) => TRACK_WORDS[track]).join(" > ")}. When two opinions pull against each other, the earlier goal's next step wins and the later goal's step is protected or deferred, never silently dropped; name the deferral in deferred. `
      : ""
  }Snapshot id: ${snapshot.id}. Question: ${question}. Conflicts: ${JSON.stringify(conflicts)}. Opinions: ${JSON.stringify(opinions)}`;
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
  const root = base && typeof base === "object" && !Array.isArray(base) ? (base as Record<string, unknown>) : {};
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

// The seat that speaks for each goal, so the advice-only fallback follows the block's
// priority instead of always handing the day to recovery.
const TRACK_SEAT: Record<PriorityTrack, SpecialistDomain> = { muscle: "training", race: "endurance", cut: "nutrition" };

function fallbackConferenceDecision(
  opinions: SpecialistOpinion[],
  conflicts: ConferenceConflictKey[],
  unavailable: SpecialistDomain[],
  priority: readonly PriorityTrack[] = []
): CaseConferenceDecision {
  const preferred =
    opinions.find((opinion) => conflicts.includes("deficit_recovery") && opinion.domain === "nutrition") ??
    priority.map((track) => opinions.find((opinion) => opinion.domain === TRACK_SEAT[track])).find(Boolean) ??
    opinions.find((opinion) => opinion.domain === "recovery") ??
    opinions[0];
  const autonomy = opinions.reduce<(typeof TIER_ORDER)[number]>(
    (ceiling, opinion) => moreRestrictiveTier(ceiling, opinion.autonomy_ceiling),
    conflicts.includes("clinical_autonomy") ? "clinician" : "ask"
  );
  const expectations = opinions.flatMap((opinion) => opinion.expected_outcomes).slice(0, 10);
  return {
    kind: "case_conference",
    // The endurance seat files its decisions under training — a race build is training.
    domain: preferred.domain === "endurance" ? "training" : preferred.domain,
    summary: preferred.recommendation.slice(0, 300),
    rationale: preferred.rationale.slice(0, 1_500),
    risk_class: conflicts.includes("clinical_autonomy") ? "clinical" : conflicts.length ? "moderate" : "low",
    reversible: false,
    autonomy_tier: autonomy,
    parallel_actions: opinions
      .filter((opinion) => opinion !== preferred)
      .map((opinion) => opinion.recommendation)
      .slice(0, 10),
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
    // CLI calls each specialist may spend (its bounded read loop). The standing weekly
    // team review passes 1 so the whole review stays ~6 spawns.
    maxCallsPerSpecialist?: number;
  },
  deps: CaseConferenceDeps = {}
): Promise<CaseConferenceResult> {
  const assertActive = () => {
    if (deps.signal?.aborted) throw new Error("canceled");
  };
  assertActive();
  const question = String(input.question || "")
    .trim()
    .slice(0, 1_000);
  const domains = [...new Set(input.domains)]
    .filter((domain) => SPECIALIST_DOMAINS.includes(domain))
    .slice(0, SPECIALIST_DOMAINS.length);
  const now = (deps.now ?? (() => new Date()))();
  const today = now.toISOString().slice(0, 10);
  const priorAttempts = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_jobs
           WHERE kind = 'case_conference'
             AND started_at IS NOT NULL
             AND substr(started_at,1,10) = ?
             AND (? IS NULL OR id <> ?)`
        )
        .get(today, deps.jobId ?? null, deps.jobId ?? null) as any
    )?.n ?? 0
  );
  if (priorAttempts >= 3)
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
  // THE FULL CONTEXT IS THE DETERMINISTIC LAYER'S INPUT; THE SNAPSHOT IS THE AGENT'S.
  // createImmutableBrainSnapshot bounds what an agent may be handed, and part of
  // that bound is normalizeJsonObject keeping only the first 50 keys of an object.
  // The real coach context has 73, and signal_state (64), health_focus (56),
  // directives (55), health (52) and supplements (62) all sit past the cut — so a
  // conflict layer reading the SNAPSHOT could never see recovery strain, a clinical
  // finding, a medication or an allergy on record, whatever the athlete's picture
  // actually was. Everything deterministic therefore reads `fullContext`; only the
  // prompts read `snapshot.context`.
  const rawContext = (deps.context ?? getCoachContext)();
  const fullContext = conferenceContext(rawContext, input);
  // The agents' copy goes through the conference's own promptData site, so what they
  // see is chosen (road_ahead first) rather than whatever the 50-key bound left over.
  const snapshot = createImmutableBrainSnapshot(
    conferenceContext(projectCoachContext((rawContext ?? {}) as any, "case_conference"), input),
    now
  );
  // The symptom lifecycle reaches the coach context only THROUGH a rated session's
  // autoregulation rollup, so pain reported in chat with nothing trained since is
  // invisible there. Read it directly, area-scoped only (a systemic report never
  // drives movement relevance) and never from an unconfirmed legacy row.
  //
  // Keyed on the LOCAL day, not `today` above: that one is a UTC slice serving the
  // agent_jobs budget query, and every evening after UTC rolls over it names
  // tomorrow — which would resolve the lifecycle against a day that has not
  // happened here yet.
  const activeSymptomAreas = (deps.symptomAreas ?? defaultActiveSymptomAreas)(localDateISO());
  const conflictInputs = conferenceConflictInputs(fullContext, { activeSymptomAreas });
  const conflicts = conflictsFromInputs(conflictInputs);
  const perSpecialistCalls = Math.max(
    1,
    Math.min(Math.floor(12 / Math.max(1, domains.length)), Math.trunc(Number(input.maxCallsPerSpecialist)) || 12)
  );
  // The block's goal order, which the conductor reconciles by: the agents' own
  // road_ahead when the context carries it, the deterministic read otherwise.
  const priority: PriorityTrack[] = (() => {
    const fromContext = (fullContext as any)?.road_ahead?.priority?.order;
    if (Array.isArray(fromContext))
      return fromContext.filter((track: unknown): track is PriorityTrack => Object.hasOwn(TRACK_WORDS, String(track)));
    try {
      return blockPriority().order;
    } catch {
      return [];
    }
  })();
  const specialistRun =
    deps.specialistRun ??
    (async (chosen, prompt, domain, snap, maxCalls) => {
      const out = await (deps.chosenWithReads ?? runChosenWithCoachReads)(chosen, prompt, {
        op: `conference_${domain}`,
        mode: "conference",
        maxCalls,
        runId: `${snap.id}:${domain}`,
        acceptParsed: (parsed) => isSpecialistOpinion(parsed) && parsed.domain === domain,
        // Forwarded for the protocol turn as well as the final opinion (one schema
        // for the whole loop), which is why it carries the coach_read protocol.
        schema: SPECIALIST_OPINION_SCHEMA,
        signal: deps.signal,
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
      const opinion = isSpecialistOpinion(value) ? normalizeSpecialistOpinion(value) : null;
      if (!opinion || opinion.domain !== domain) throw new Error("invalid specialist opinion");
      return opinion;
    })
  );
  assertActive();
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
    (async (chosen, prompt) => {
      try {
        return (
          await (deps.chosen ?? runChosen)(chosen, prompt, {
            op: "case_conference",
            acceptParsed: (parsed) => normalizeStrictCaseConferenceDecision(parsed) !== null,
            schema: CASE_CONFERENCE_DECISION_SCHEMA,
            signal: deps.signal,
          })
        ).result.parsed;
      } catch {
        if (deps.signal?.aborted) throw new Error("canceled");
        // Valid specialist findings remain useful even when every conductor
        // provider/process/contract attempt fails. The advice-only fallback below
        // cannot mutate anything and keeps every conflict unresolved.
        return null;
      }
    });
  const rawDecision = await conductorRun(agent, conductorPrompt(question, snapshot, opinions, conflicts, priority));
  assertActive();
  const normalizedDecision = normalizeStrictCaseConferenceDecision(rawDecision);
  const degraded = normalizedDecision == null;
  // Valid specialist work must never disappear because the conductor emitted a
  // malformed envelope. Preserve one conservative, advice-only voice, leave all
  // conflicts unresolved, and hold it for review. No mutation is synthesized.
  const decision = normalizedDecision ?? fallbackConferenceDecision(opinions, conflicts, unavailable, priority);
  // The clinical floor the server ENFORCES is judged against the revision itself: an
  // act-now finding gates only a change that acts on what it governs (same domain and
  // area, or the change names the marker). The pre-revision rule above was the
  // specialists' heads-up; advice with no revision changes nothing and is not gated.
  const withoutClinical = conflicts.filter((conflict) => conflict !== "clinical_autonomy");
  const enforcedConflicts = clinicalAutonomyFromRevision(conflictInputs, decision.revision)
    ? [...withoutClinical, "clinical_autonomy" as ConferenceConflictKey]
    : withoutClinical;
  // A RESOLUTION MUST CITE. Membership of the key used to be the whole test, and
  // the prompt asked the model to list every conflict — so an echo of the server's
  // own list dissolved every conflict it had just detected. The claim now has to
  // name an evidence key that really appears in the opinion of a specialist party
  // to that conflict; an uncited echo (and a legacy `string[]` payload, which
  // normalizes away entirely) leaves the conflict unresolved and the existing
  // demotion applies untouched.
  const accounted = citedConflictResolutions(decision.resolved_conflicts, enforcedConflicts, opinions);
  const unresolvedConflicts = enforcedConflicts.filter((conflict) => !accounted.has(conflict));
  // The clinician floor is deterministic. A conductor echoing "clinical_autonomy"
  // into resolved_conflicts — or down-classifying its own risk_class — must never
  // lower that floor: a clinical decision stays clinician-directed even when the
  // clinical specialist was absent or permissive.
  //
  // A CONFERENCE IS A BUNDLE, ROUTED ACTION BY ACTION (2026-09-25 ruling). The floor is
  // judged against the one change the server can execute — the revision — never against
  // the whole envelope. It used to read summary + revision + every parallel action as
  // one string, so a single "ask your doctor about a statin" beside a calorie hold put
  // the hold, the protein target and the run ceiling on the clinician floor together,
  // and the whole bundle sat waiting for days. A clinical sentence elsewhere in the
  // bundle is lifted out as a note FOR THE ATHLETE AND THEIR DOCTOR (recorded below as
  // its own observed row) and never gates the change beside it.
  const deterministicClinical =
    enforcedConflicts.includes("clinical_autonomy") ||
    (decision.revision != null && revisionHoldsClinicalFloor(conflictInputs, decision.revision));
  const clinicianNotes = conferenceClinicianNotes([decision.summary, ...decision.parallel_actions]);
  // Reversibility is the SERVER's fact, not the conductor's claim. Every executable
  // revision type lands with a server-owned rollback snapshot and one-tap Undo, and
  // advice changes nothing there is to take back. A conductor writing reversible:false
  // used to walk any change onto the irreversibility floor — model discretion over the
  // tier, the same thing clinicianFloorHolds refuses in the clinical direction.
  const conductorReversible = decision.reversible;
  decision.reversible = true;
  // …and in the OTHER direction too (clinicianFloorHolds, src/brain/autonomy.ts): a
  // conductor's own `risk_class:'clinical'` on a change the server finds non-clinical
  // is model discretion over the tier. It is recorded as what the conductor said and
  // otherwise read as moderate, so a kcal hold or a hill-repeat stand-down is routed by
  // ordinary policy instead of waiting forever for a clinician who is not in the loop.
  const conductorRiskClass = decision.risk_class;
  if (deterministicClinical && decision.risk_class !== "clinical") decision.risk_class = "clinical";
  if (!deterministicClinical && decision.risk_class === "clinical") decision.risk_class = "moderate";
  let specialistCeiling = opinions.reduce<(typeof TIER_ORDER)[number]>(
    (ceiling, opinion) => moreRestrictiveTier(ceiling, opinion.autonomy_ceiling),
    decision.autonomy_tier
  );
  // A specialist may tighten a change to an ASK; only the deterministic floor makes it
  // clinician-directed.
  const specialistAskedForClinician = specialistCeiling === "clinician";
  if (specialistAskedForClinician && !deterministicClinical) specialistCeiling = "ask";
  const leadMode = getSettings().lead_mode;
  // Under lead, a model-requested ask is a heads-up (leadModelCeiling, Amendment 3).
  const modelCeiling = leadModelCeiling(specialistCeiling, leadMode);
  const leadCeilingEased = modelCeiling !== specialistCeiling ? `${specialistCeiling}->${modelCeiling}` : null;
  specialistCeiling = modelCeiling;
  // What an UNRESOLVED conflict does depends on what kind of question it is. The clinical
  // one is the clinician floor; a safety one (a hurt part under load, an allergy, a
  // medication meeting a supplement) keeps the change at ask in every mode; a coaching
  // trade-off (deficit vs recovery, race vs strength) is the team's call by the block's
  // priority order, so under lead it is announced with the reasoning, never parked.
  const safetyUnresolved = unresolvedConflicts.some((conflict) => conflictIsSafetyFloor(conflict));
  if (unresolvedConflicts.length) {
    specialistCeiling = moreRestrictiveTier(
      specialistCeiling,
      unresolvedConflicts.includes("clinical_autonomy")
        ? "clinician"
        : safetyUnresolved
          ? "ask"
          : leadModelCeiling("ask", leadMode)
    );
  }
  // A plan_update that LOWERS prescribed volume is not one bounded load step, and
  // it must not take the tier meant for one. Volume is the field nothing downstream
  // can raise again (src/repo/volume-guard.ts), so a cut is structural: it announces
  // rather than landing quietly. Detected deterministically against what the plan
  // actually holds — never from the conductor's own account of how small it is.
  const reducesVolume = decision.revision?.type === "plan_update" && changesReduceSets(decision.revision.changes);
  const executableKind =
    decision.revision?.type === "plan_restructure"
      ? "training_structure"
      : decision.revision?.type === "nutrition_target"
        ? "nutrition_target"
        : reducesVolume
          ? "training_structure"
          : "training_target";
  const policy = decideAutonomyTier({
    kind: decision.revision ? executableKind : decision.kind,
    risk_class: decision.risk_class,
    reversible: decision.reversible,
    requested_tier: specialistCeiling,
    lead_mode: leadMode,
    clinical: deterministicClinical,
  });
  decision.autonomy_tier = policy.tier;

  // From the FULL context, not the snapshot. `whole_person_trajectory` is already
  // a coach-context key that conferenceContext overwrites in place (~index 68) and
  // `conference_focus` is appended after all 73 — either way both sit past the
  // snapshot's first-50-keys bound, so on every production conference the recorded
  // decision carried a null trajectory and an empty optimizes/parks. The tests,
  // whose contexts are small, saw them fine.
  const trajectory = (fullContext as any)?.whole_person_trajectory ?? null;
  const focus = (fullContext as any)?.conference_focus ?? {};
  const sharedContext =
    normalizeJsonObject({
      snapshot_id: snapshot.id,
      question,
      conflicts: enforcedConflicts,
      unresolved_conflicts: unresolvedConflicts,
      // WHAT THE DETERMINISTIC LAYER SAW. The stored snapshot is the bounded
      // agent-facing copy, so it cannot re-derive this conflict list; without the
      // resolved inputs beside it, a decision's ledger row records which conflicts
      // fired but nothing about why, and the answer is unrecoverable after the day
      // the context moves on.
      conflict_inputs: conflictInputs,
      unavailable,
      review_window: decision.review_window,
      // The floor as the SERVER read it, beside what the conductor and specialists said.
      deterministic_clinical: deterministicClinical,
      conductor_risk_class: conductorRiskClass,
      specialist_ceiling_softened: specialistAskedForClinician && !deterministicClinical ? "clinician->ask" : null,
      lead_ceiling_eased: leadCeilingEased,
      conductor_reversible: conductorReversible,
      clinician_note_count: clinicianNotes.length,
      trajectory,
      optimizes: boundedStrings(focus.optimizes),
      parks: boundedStrings(focus.parks),
    }) ?? {};
  const sharedSpecialist =
    normalizeJsonObject({
      snapshot_id: snapshot.id,
      opinions,
      trajectory,
      optimizes: boundedStrings(focus.optimizes),
      parks: boundedStrings(focus.parks),
    }) ?? {};

  // The clinical half of the bundle, filed for the athlete and their doctor
  // (recordConferenceClinicianNotes) — never a gate on the change beside it.
  const recordClinicianNotes = (conferenceDecisionId: number | null): void =>
    recordConferenceClinicianNotes(clinicianNotes, {
      rationale: decision.rationale,
      conference_decision_id: conferenceDecisionId,
      snapshot_id: snapshot.id,
    });

  if (decision.revision) {
    const parsed =
      decision.revision.type === "plan_restructure"
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
    assertActive();
    const proposal = createProposal(
      "case_conference",
      `case conference: ${question}`,
      JSON.stringify(rawDecision),
      parsed
    );
    assertActive();
    // The floor travels with the change: the executable decision is marked clinical by
    // the SERVER's read, so its hold carries the clinical_ceiling code and the thaw
    // recognises it — never by the tier alone.
    // …and so does an unresolved SAFETY conflict: it holds as a refused safety floor
    // (`safety_floor`), which no sweep re-offers on the athlete's behalf.
    const autonomy = applyProposalWithAutonomy(proposal.id, {
      requested_tier: policy.tier,
      clinical: deterministicClinical || undefined,
      clamp_refused: (!deterministicClinical && safetyUnresolved) || undefined,
    });
    const execution = executionSummary(autonomy);
    assertActive();
    // Predictions ride the CHANGE, not the record of it. Autonomy either landed
    // or scheduled this revision — in which case its expectations are live and
    // will mature against work that actually happened — or it clamped the tier and
    // held the proposal for review, in which case nothing has happened at all.
    // Judging an unapplied revision on schedule would write a verdict about a
    // counterfactual, so a held revision parks its predictions on its own record
    // instead; recordAppliedProposalDecision thaws them, with re-based windows,
    // if and when the proposal is finally applied.
    const revisionHeld = autonomy?.decision?.status === "review" || autonomy?.decision?.status === "observed";
    const parkedExpectations = revisionHeld ? decision.expectations.slice(0, MAX_DEFERRED_EXPECTATIONS) : [];
    const autonomyDecision = autonomy?.decision?.id
      ? patchBrainDecision(Number(autonomy.decision.id), {
          source: "case_conference",
          context: { ...(autonomy.decision.context ?? {}), ...sharedContext },
          action: {
            ...(autonomy.decision.action ?? {}),
            conference_revision_type: decision.revision.type,
            parallel_actions: decision.parallel_actions,
            resolved_conflicts: decision.resolved_conflicts,
            deferred: decision.deferred,
            user_explanation: decision.user_explanation,
            ...(parkedExpectations.length ? { deferred_expectations: parkedExpectations } : {}),
          },
          specialist: sharedSpecialist,
          evaluator_version: decision.expectations.length ? "case-conference-v2" : autonomy.decision.evaluator_version,
        })
      : null;
    if (autonomyDecision) {
      assertActive();
      recordDecision(autonomyDecision, revisionHeld ? [] : decision.expectations);
      recordClinicianNotes(Number(autonomyDecision.id) || null);
      decision.autonomy_tier = autonomyDecision.autonomy_tier;
      return {
        ok: autonomy?.ok === true,
        snapshot_id: snapshot.id,
        opinions,
        unavailable,
        conflicts: enforcedConflicts,
        unresolved_conflicts: unresolvedConflicts,
        decision,
        recorded_decision_id: autonomyDecision.id,
        proposal_id: proposal.id,
        execution,
        ...(degraded ? { degraded: true } : {}),
        ...(autonomy?.ok === true
          ? {}
          : { error: String(autonomy?.error ?? "conference revision was not actionable") }),
      };
    }

    // A held/rejected executable recommendation stays a review record linked to
    // its real proposal. It is never marked announced without a boundary-appliable
    // proposal decision, which prevents inert announcements.
    //
    // Its predictions are PARKED on the record rather than attached as live
    // expectations. They describe the effect of a plan revision that has not
    // happened, and evaluateExpectation would judge a non-terminal `review`
    // decision on schedule — writing a verdict about a counterfactual. Held
    // here, they survive the hold intact and are thawed with re-based windows by
    // recordAppliedProposalDecision if and when this proposal is finally applied.
    // This branch is only reached when autonomy produced NO decision at all — i.e. the
    // revision could not be routed. That is a genuine dead end, so it still parks at
    // review under an ask/clinician tier: announcing a change with no boundary-appliable
    // decision behind it would be an inert promise. The advisory path below is where the
    // 2026-08-17 "no parking above ask" ruling bites.
    const heldTier = policy.tier === "observe" ? "observe" : policy.tier === "clinician" ? "clinician" : "ask";
    decision.autonomy_tier = heldTier;
    assertActive();
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
      context: {
        ...sharedContext,
        proposal_held: true,
        policy_reasons: execution.reasons,
        deferred_expectation_count: Math.min(decision.expectations.length, MAX_DEFERRED_EXPECTATIONS),
      },
      action: {
        proposal_id: proposal.id,
        conference_revision_type: decision.revision.type,
        parallel_actions: decision.parallel_actions,
        resolved_conflicts: decision.resolved_conflicts,
        deferred: decision.deferred,
        user_explanation: decision.user_explanation,
        deferred_expectations: decision.expectations.slice(0, MAX_DEFERRED_EXPECTATIONS),
      },
      specialist: sharedSpecialist,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
    recordClinicianNotes(Number(held.decision.id) || null);
    return {
      ok: autonomy?.ok === true,
      snapshot_id: snapshot.id,
      opinions,
      unavailable,
      conflicts: enforcedConflicts,
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
  //
  // Its predictions DO stay live, unlike the held-revision path above. There is
  // no unapplied change here whose effect they would misattribute: advice is a
  // read of where the picture is heading, and "where it heads" is exactly what
  // the window measures. That makes an advisory conference checkable — the miss
  // is real information about the read, not about a change that never landed.
  // Any real change that lands on the same metric mid-window is picked up as an
  // overlapping-decision confounder, so attribution stays honest.
  //
  // The tier is the POLICY's, not a blanket "ask" (2026-08-17 ruling). A conference
  // whose reading policy says announce is a heads-up the athlete can read when they
  // open the app — it is recorded as `observed`, not parked at `review` where it would
  // sit in the queue asking for a decision that has no change behind it to approve.
  // Only ask and clinician — the floors — still park for review.
  //
  // And under lead, not even those (2026-09-25 ruling): advice changes nothing, so there
  // is nothing on it for the athlete to approve. A conference that found a safety
  // question it could not close says so in its reading; its clinical half is filed for
  // the athlete and their doctor (recordClinicianNotes) — neither waits in the queue.
  // announce_first and review_everything keep the park, as the athlete asked.
  const advisoryTier = policy.tier;
  const advisoryParks = leadMode !== "lead" && (advisoryTier === "ask" || advisoryTier === "clinician");
  decision.autonomy_tier = advisoryTier;
  assertActive();
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
      status: advisoryParks ? "review" : "observed",
      autonomy_tier: advisoryTier,
      risk_class: decision.risk_class,
      reversible: decision.reversible,
      input_fingerprint: null,
      context: { ...sharedContext, advisory_only: true, observational_expectations: true },
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
    decision.expectations
  );
  recordClinicianNotes(Number(recorded.decision.id) || null);
  return {
    ok: true,
    snapshot_id: snapshot.id,
    opinions,
    unavailable,
    conflicts: enforcedConflicts,
    unresolved_conflicts: unresolvedConflicts,
    decision,
    recorded_decision_id: recorded.decision.id,
    ...(degraded ? { degraded: true } : {}),
  };
}
