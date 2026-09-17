// Training coaching ops: session suggestion + daily composition, the plan
// proposal / program-evolution drafts, the blank-slate week compose, exercise
// explanation, the week-ahead forward look, and agentic exercise reconciliation.
// Split out of the former single-file src/coachOps.ts — behavior-preserving.

import { getActiveDailySession } from "../repo/adaptive-session.js";
import { fingerprint, getAiCache, saveAiCache } from "../repo/chat.js";
import { listCheckins } from "../repo/coach.js";
import { deterministicComposedSession, normalizeComposedSession } from "../repo/daily-composition.js";
import { decideDailySession } from "../repo/daily-decision.js";
import { getDailySessionOutcome } from "../repo/daily-reconciliation.js";
import { dayRead, weekAheadPlan } from "../repo/day-read.js";
import { weekAheadRaceLine } from "../repo/day-read-prose.js";
import { MUSCLE_GROUPS, authoritativeGroup, canonicalGroup, cleanExerciseName, normalizeExerciseName, normalizedExerciseKey, planExerciseAliases, setExerciseAlias, shouldAutoApplyMerge, validateExerciseMergePlan } from "../repo/exercise-canon.js";
import { distinctExerciseNames, findExercise, getExerciseDetail, listExercises, mergeExercises, updateExercise } from "../repo/exercises.js";
import { listContextEvents } from "../repo/health.js";
import { getLocationContext } from "../repo/location-context.js";
import { recordSuggestion } from "../repo/memory.js";
import { getPlan } from "../repo/plan.js";
import { getEnduranceGoal, getProfile } from "../repo/profile.js";
import { getProgramState } from "../repo/program-state.js";
import { createProposal, getProposal } from "../repo/proposals.js";
import { RECOVERY_WEEK_INSTRUCTION_PREFIX, supersedeRecoveryWeekDrafts } from "../repo/recovery-week.js";
import { interactiveTimeoutForOp } from "../repo/settings.js";
import { listTrainingSymptoms } from "../repo/training-symptoms.js";
import { sessionFloorPrecheck } from "../repo/verify-floors.js";
import { localDateISO } from "../repo/shared.js";
import { pickDayVariant } from "../repo/brain/day-read-rules.js";
import { trainingBackstopSignature } from "../repo/training-cache.js";
import type { FallbackResult } from "../agents.js";
import { runChosen, runChosenStreaming } from "../runChosen.js";
import { buildCoachPrompt, buildProgramEvolutionPrompt, buildWeekComposePrompt, buildSessionPrompt, buildDailyCompositionPrompt, buildExerciseExplanationPrompt, buildWeekAheadPrompt, buildSessionVerifyPrompt, buildExerciseReconcilePrompt } from "../prompt.js";
import { applyProposalWithAutonomy } from "../domain/brain/autonomy-service.js";
import { DAILY_SESSION_SUGGESTION_NORMALIZATION, EXERCISE_EXPLANATION_SCHEMA, EXERCISE_RECONCILE_SCHEMA, PLAN_PROPOSAL_SCHEMA, SESSION_SUGGESTION_SCHEMA, WEEK_AHEAD_SCHEMA, hasPlanProposalActions, isExerciseExplanationResult, isPlanProposalResult, isReconciliationResult, isSessionSuggestionResult, isWeekAheadResult, normalizeSessionSuggestionResult } from "../agent-contracts.js";
import { agentFailure, agentStatusFor, runVerify } from "./shared.js";
import type { OpHooks } from "./shared.js";

// Build ONE session on demand. ok:false is the designed failure signal when the
// agent returns nothing usable. Inputs are the already-typed prompt options.
export async function suggestSession(
  agent: string | undefined,
  opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string },
  hooks?: OpHooks
) {
  // Serve-stale-then-revalidate: an identical request inside the freshness window
  // is served instantly (no agent run, no spend). The key folds the normalized
  // constraints with a coarse day-context stamp so a new training day / fresh
  // recovery signal busts it. A stale hit still returns instantly; the background
  // job worker calls again and rewrites the cache.
  const cacheKey = sessionSuggestCacheKey(opts);
  const cached = getAiCache("session_suggest", cacheKey);
  // Exercise mode is durable identity. Re-check even a fresh cache hit against
  // the current database so a suggestion can never render as actionable and then
  // fail preparation because that movement is authoritatively timed/reps work.
  const sessionSane = (s: any) => isSessionSuggestionResult(s);
  const foldTopSets = { foldTopSets: true } as const;
  const cachedSession = normalizeSessionSuggestionResult(cached?.result?.session, foldTopSets);
  const usableCached =
    cached && cachedSession && cached.result && typeof cached.result === "object"
      ? {
          ...cached,
          result: {
            ...cached.result,
            session: cachedSession,
            session_normalization: DAILY_SESSION_SUGGESTION_NORMALIZATION,
          },
        }
      : null;
  if (usableCached && !usableCached.stale) {
    hooks?.onPhase?.("served from cache");
    return usableCached.result;
  }
  hooks?.onPhase?.("drafting your session");
  const prompt = buildSessionPrompt(undefined, opts);
  // Interactive: a user is waiting on the request path — short the leash. Streams the
  // session's "why" prose into the card when the chosen agent is stream-capable;
  // otherwise (no delta sink / non-streaming agent) it gets depth-on-demand reads.
  let run: FallbackResult;
  try {
    run = await runChosenStreaming(agent, prompt, {
      op: "session_suggest",
      timeoutMs: interactiveTimeoutForOp("session_suggest"),
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: sessionSane,
      // Inert while streaming (agents.ts declares no {schema_args} on the stream
      // args); it binds on the non-streamed fallback and on the bounded read loop,
      // which is why it carries the coach_read protocol.
      schema: SESSION_SUGGESTION_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    if (usableCached) return { ...usableCached.result, cached: true, stale: true };
    return {
      ok: false as const,
      error: "agent returned no usable session",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const { agent: chosen, result, tried } = run;
  const p = normalizeSessionSuggestionResult(result.parsed, foldTopSets);
  if (!p) {
    // Nothing fresh and usable — fall back to a stale cache hit rather than fail.
    if (usableCached) return usableCached.result;
    return {
      ok: false as const,
      error: "agent returned no usable session",
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Self-critique: the server checks the time budget deterministically, then an
  // agent turn repairs what it found and judges injury contraindication / encoding.
  // Fail-open — verify down/garbage ⇒ the draft ships exactly as before.
  hooks?.onPhase?.("checking it against your floors", { frac: { done: 1, total: 2 } });
  const { draft, verified } = await runVerify(
    agent,
    p,
    (d) => sessionFloorPrecheck(d, opts),
    (d, violations) => buildSessionVerifyPrompt(d, opts, violations),
    sessionSane,
    "session_verify",
    hooks,
    SESSION_SUGGESTION_SCHEMA
  );
  const session = normalizeSessionSuggestionResult(draft, foldTopSets) ?? p;
  // Outcome learning: record what was suggested so a later pass can compare it to
  // what the athlete actually trained. Best-effort; never blocks the response.
  recordSuggestion("session_suggest", opts.date ?? null, {
    minutes: opts.minutes ?? null,
    focus: opts.focus ?? null,
    est_minutes: Number(session.est_minutes) || null,
    item_count: session.items.length,
  });
  const out = {
    ok: true as const,
    session,
    agent: chosen,
    tried,
    agent_status: "ok" as const,
    session_normalization: DAILY_SESSION_SUGGESTION_NORMALIZATION,
    ...(verified ? { verified } : {}),
  };
  try {
    saveAiCache("session_suggest", cacheKey, {
      result: out,
      chosen_agent: chosen,
      freshForMs: 3 * 60 * 60 * 1000,
    });
  } catch {
    /* cache write never breaks the op */
  }
  return out;
}

// Stage 3 of the adaptive daily training plan — bounded agent composition.
// Compose ONE session strictly inside the deterministic Stage 2 decision
// envelope. The agent proposes; the server VERIFIES: every item is clamped and
// checked against the envelope's exclusions/caps and the safe novel-exercise
// rules (`normalizeComposedSession`). Invalid, empty, over-excluded, timed-out,
// or agent-absent output falls back to a usable deterministic session built from
// the same envelope — a usable session is GUARANTEED. Preview-only: nothing is
// persisted or applied here; the athlete accepts it later via prepare
// (agent_suggest), which snapshots it durably. ok:false is never returned — the
// deterministic fallback always yields ok:true.
export async function composeDailySession(
  agent: string | undefined,
  opts: { date?: string; minutes?: number; equipment?: string; override?: string; train_anyway?: boolean } = {},
  hooks?: OpHooks
) {
  const { envelope } = decideDailySession(opts.date, {
    override: opts.override ?? null,
    train_anyway: opts.train_anyway === true,
    equipment: opts.equipment ?? null,
    minutes: opts.minutes ?? null,
  });

  // A rest read composes deterministically — never spend an agent run to say
  // "take it easy today".
  if (envelope.kind === "rest") {
    const session = deterministicComposedSession(envelope);
    return {
      ok: true as const,
      session,
      envelope,
      fallback: "rest_day",
      validation: null,
      agent_status: "ok" as const,
      session_normalization: DAILY_SESSION_SUGGESTION_NORMALIZATION,
    };
  }

  hooks?.onPhase?.("composing today's session");
  const prompt = buildDailyCompositionPrompt(envelope);
  let run: FallbackResult | null = null;
  let triedFromFailure: { agent: string; error: string }[] = [];
  try {
    run = await runChosenStreaming(agent, prompt, {
      op: "session_compose",
      timeoutMs: interactiveTimeoutForOp("session_compose"),
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: (s: any) => isSessionSuggestionResult(s),
      schema: SESSION_SUGGESTION_SCHEMA,
    });
  } catch (error) {
    // A user Stop must propagate (agentFailure re-throws on abort); any other
    // agent failure degrades to the deterministic fallback (never fail the
    // composition), preserving the attempted-agent list for observability.
    triedFromFailure = agentFailure(error, hooks).tried;
    run = null;
  }

  let session = null as ReturnType<typeof deterministicComposedSession> | null;
  let fallback: string | null = null;
  let validation: any = null;
  let chosen: string | null = run?.agent ?? null;
  const tried = run?.tried ?? triedFromFailure;

  if (run?.result?.parsed) {
    const normalized = normalizeComposedSession(run.result.parsed, envelope);
    validation = normalized.validation;
    if (normalized.session) {
      session = normalized.session;
    } else {
      fallback = normalized.validation.reason ?? "unusable_agent_output";
    }
  } else {
    fallback = run ? "no_parsed_output" : "agent_unavailable";
  }

  if (!session) {
    session = deterministicComposedSession(envelope);
    chosen = chosen ?? "deterministic";
  }

  return {
    ok: true as const,
    session,
    envelope,
    fallback,
    validation,
    agent: chosen,
    tried,
    agent_status: "ok" as const,
    session_normalization: DAILY_SESSION_SUGGESTION_NORMALIZATION,
  };
}

// Fingerprint a session-suggest request: the normalized explicit constraints +
// a coarse day-context stamp (the calendar date + the suggested plan day) plus the
// profile's identity/goal generation. A goal hierarchy or race can change within
// the same day; serving the pre-change session after that write would make the
// coach look oblivious precisely when the athlete clarified what should lead.
// Compact, privacy-preserving cache identity for the material training reality
// shared by same-day session suggestions and the week-ahead read. The aggregate
// backstop covers logged sets/sessions, activities, recovery metrics, plan and
// context writes. Explicit projections cover the same-day state that aggregate
// count/max signals do not fully describe (ordered intent/goals, active symptoms
// and injuries, check-ins, and the accepted composition/outcome). Only the hash
// is persisted in an ai_cache key; none of this athlete context is stored there.
export function coachingCacheFreshnessFingerprint(date = localDateISO()): string {
  let profile: any = null;
  let location: any = null;
  let symptoms: any[] = [];
  let injuries: any[] = [];
  let checkins: any[] = [];
  let composition: any = null;
  let outcome: any = null;
  try {
    const p = getProfile();
    profile = p
      ? {
          primary_discipline: p.primary_discipline ?? null,
          endurance_sport: p.endurance_sport ?? null,
          endurance_goal_json: p.endurance_goal_json ?? null,
          endurance_schedule_json: p.endurance_schedule_json ?? null,
          strength_schedule_json: p.strength_schedule_json ?? null,
          training_intent_json: p.training_intent_json ?? null,
          goal_weight_lb: p.goal_weight_lb ?? null,
          goal_bodyfat_pct: p.goal_bodyfat_pct ?? null,
          goal_date: p.goal_date ?? null,
          goal_mode: p.goal_mode ?? null,
        }
      : null;
  } catch {
    /* a blank profile keeps the cache available on first boot */
  }
  try {
    const effective = getLocationContext({ on: date });
    // Feed only the normalized planning identity into the one-way fingerprint.
    // Raw location text never reaches ai_cache: callers persist only the final
    // hash returned below. trip_title is deliberately excluded because editing
    // prose without changing where the athlete is should not stale a session.
    location = {
      home: effective.home,
      effective: effective.effective,
      source: effective.source,
      trip_id: effective.trip_id,
    };
  } catch {
    /* an interrupted migration may not have location storage yet */
  }
  try {
    symptoms = listTrainingSymptoms({ on: date, include_resolved: false, seed_legacy: false });
  } catch {
    /* symptom storage may be absent during an interrupted migration */
  }
  try {
    injuries = (listContextEvents({ activeOnly: true, on: date }) as any[]).filter(
      (event) => event?.kind === "injury"
    );
  } catch {
    /* context storage may be absent during an interrupted migration */
  }
  try {
    checkins = listCheckins(7) as any[];
  } catch {
    /* a fresh install has no subjective recovery history */
  }
  try {
    composition = getActiveDailySession(date);
  } catch {
    /* no accepted daily composition */
  }
  try {
    outcome = getDailySessionOutcome(date);
  } catch {
    /* no reconciled daily outcome */
  }
  return fingerprint({
    date,
    training: trainingBackstopSignature(),
    profile,
    location,
    symptoms,
    injuries,
    checkins,
    composition,
    outcome,
  });
}

export function sessionSuggestCacheKey(opts: {
  minutes?: number;
  equipment?: string;
  focus?: string;
  constraints?: string;
  date?: string;
}): string {
  const date = opts.date || localDateISO();
  let dayContext = "";
  try {
    const dr = dayRead(date);
    dayContext = `${dr.kind}|${dr.focus ?? ""}`;
  } catch {
    /* a missing read just yields a coarser key */
  }
  let profileContext: Record<string, unknown> | null = null;
  try {
    const profile = getProfile();
    profileContext = profile
      ? {
          updated_at: profile.updated_at ?? null,
          primary_discipline: profile.primary_discipline ?? null,
          endurance_sport: profile.endurance_sport ?? null,
          endurance_goal_json: profile.endurance_goal_json ?? null,
          endurance_schedule_json: profile.endurance_schedule_json ?? null,
          strength_schedule_json: profile.strength_schedule_json ?? null,
          training_intent_json: profile.training_intent_json ?? null,
        }
      : null;
  } catch {
    /* a missing profile keeps the cache usable on a fresh install */
  }
  return fingerprint({
    minutes: opts.minutes ?? null,
    equipment: (opts.equipment ?? "").trim().toLowerCase(),
    focus: (opts.focus ?? "").trim().toLowerCase(),
    constraints: (opts.constraints ?? "").trim().toLowerCase(),
    date,
    dayContext,
    profileContext,
    trainingReality: coachingCacheFreshnessFingerprint(date),
  });
}

// Draft a plan proposal from a free-text instruction — the agentic "ask the coach"
// op behind the Coach tab's DRAFT PLAN UPDATE and the Plan → Endurance "shape your
// running" composer. Runs ONE agent over buildCoachPrompt, persists the result as a
// `draft` plan_proposals row, routes it through the shared autonomy policy, and
// returns the same stable body plus an additive autonomy sidecar. Lead mode lands
// bounded adaptations at natural boundaries; review posture keeps the draft.
// synchronous /agent/run handler used to return (proposal + ok + agent + tried +
// agent_status + exit/stderr) so both surfaces render unchanged. Backgrounded via
// the agentJobs `proposal` kind (live caption progress + reconnect) or run inline
// when bg ops are off. Degrades like the rest of the loop: no agent → ok:false
// with agent_status and no meaningless empty draft is persisted.
export async function draftCoachProposal(agent: string | undefined, instruction: string | undefined, hooks?: OpHooks) {
  hooks?.onPhase?.("reading your training");
  const prompt = buildCoachPrompt(instruction);
  // No determinate `frac` here: the single draft call IS the long, opaque step, so we
  // let the indeterminate filament keep OSCILLATING throughout rather than pinning a
  // frozen half-full bar (a determinate frac only fits ops with a fast tail phase, like
  // session-suggest's verify pass). The rotating client caption carries "what's happening".
  hooks?.onPhase?.("drafting your plan");
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "proposal",
      signal: hooks?.signal,
      acceptParsed: isPlanProposalResult,
      // The SAME artifact isPlanProposalResult checks. On a CLI that can enforce it, a
      // prose-wrapped or malformed proposal becomes structurally impossible; on one
      // that can't, it is ignored and the prose contract still applies.
      schema: PLAN_PROPOSAL_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      proposal: null,
      autonomy: null,
      ok: false as const,
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
      exit_code: null,
      stderr: "",
    };
  }
  const { agent: chosen, result, tried } = run;
  const proposal = createProposal(chosen, instruction ?? "", result.raw, result.parsed);
  let autonomy: any = null;
  if (result.parsed && hasPlanProposalActions(result.parsed)) {
    try {
      autonomy = applyProposalWithAutonomy(Number(proposal.id));
    } catch {
      autonomy = null;
    }
  }
  return {
    proposal: getProposal(Number(proposal.id)),
    autonomy,
    ok: !!result.parsed,
    agent: chosen,
    tried,
    // Honest degradation sidecar (mirrors today-read / session-suggest / mealplan)
    // so callers can distinguish "no agent configured" from "agent failed".
    agent_status: agentStatusFor({ ok: !!result.parsed, agent: chosen, tried }),
    exit_code: result.code,
    stderr: (result.stderr || "").slice(0, 800),
  };
}

// Adaptive program evolution: read the deterministic program-state (per-lift
// plateau/trend) and draft a plan EVOLUTION — progress what's working, deload/
// rotate what's stalled, introduce novelty, periodize — as a proposal candidate
// that routes through the shared autonomy policy: Lead mode lands bounded changes
// at natural boundaries; explicit review posture keeps a proposal.
// Returns the program-state snapshot alongside so the surface can show "why this".
export async function evolveProgram(
  agent: string | undefined,
  instruction: string | undefined,
  hooks?: OpHooks,
  opts?: { task?: string }
) {
  hooks?.onPhase?.("reading how your lifts are trending");
  // Compute the program-state ONCE and thread it into the prompt + the response
  // (it's a few dozen DB queries — don't run it twice).
  const state = getProgramState();
  // opts.task lets a caller focus the agent on a specific trigger ("your bench has
  // stalled + core is under-trained") WITHOUT changing the stored `instruction`
  // (the dedup key the scheduler uses to retire prior auto-evolution drafts).
  const prompt = buildProgramEvolutionPrompt(opts?.task ?? instruction, state);
  hooks?.onPhase?.("drafting how your plan should evolve");
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "evolve_program",
      signal: hooks?.signal,
      acceptParsed: isPlanProposalResult,
      schema: PLAN_PROPOSAL_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      proposal: null,
      state,
      autonomy: null,
      ok: false as const,
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
      exit_code: null,
      stderr: "",
    };
  }
  const { agent: chosen, result, tried } = run;
  const proposal = createProposal(chosen, instruction ?? "evolve program", result.raw, result.parsed);
  // A fresh recovery-week draft retires the prior one (same one-tap ask — the newest
  // read wins), so repeated taps never stack duplicate drafts in the Coach list.
  if (proposal?.id != null && String(instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX)) {
    supersedeRecoveryWeekDrafts(Number(proposal.id));
  }
  // Route the fresh draft through the autonomy layer (the same machinery the brain-review
  // and case-conference paths use). Under lead_mode='lead' a bounded, reversible evolution
  // (target/volume nudges → kind 'training_target') quiet-applies at its natural boundary
  // with a decision + one-tap Undo, while a structural restructure (parsed.days → kind
  // 'training_structure') ANNOUNCES first and lands at the boundary pass via repo.applyProposal
  // (so the recovery-week stamp + supersession still fire); under 'announce_first' bounded
  // changes also announce; under 'review_everything' the layer records an explicit review hold
  // and keeps the draft unchanged, so Today can show the real reason without guessing. No
  // requested_tier: decideAutonomyTier derives the default from the proposal shape and never
  // loosens. Only a genuinely parsed proposal has something to apply; a failed/unparsed draft
  // is left as a raw draft. Never throws — a bookkeeping failure never breaks the draft return.
  let autonomy: any = null;
  if (proposal?.id != null && result.parsed && hasPlanProposalActions(result.parsed)) {
    try {
      autonomy = applyProposalWithAutonomy(Number(proposal.id));
    } catch {
      autonomy = null;
    }
  }
  return {
    proposal,
    state,
    autonomy,
    ok: !!result.parsed,
    agent: chosen,
    tried,
    agent_status: agentStatusFor({ ok: !!result.parsed, agent: chosen, tried }),
    exit_code: result.code,
    stderr: (result.stderr || "").slice(0, 800),
  };
}

// ---------- the FIRST week (blank slate) ----------
// The stored `instruction` for a composed first week, as a PREFIX contract — the same
// shape RECOVERY_WEEK_INSTRUCTION_PREFIX uses (src/repo/profile.ts), and for the same
// reason: both surfaces invite the athlete to send their own instruction, so a marker
// that only survives an EMPTY one marks nothing on the calls that actually happen.
// The athlete's words are kept and appended, so `startsWith` is the stable key any
// future supersede/dedup pass would use (cf. supersedeAutoEvolutionDrafts, which can
// match on equality only because the scheduler is its sole caller).
// Deliberately readable prose, not a code: `instruction` is the athlete-facing
// fallback for a decision's `reason` when the agent writes no rationale
// (recordAppliedProposalDecision, src/repo/profile.ts), so a machine token here would
// surface as coaching text.
export const COMPOSE_WEEK_INSTRUCTION = "compose the first training week";

// What the athlete reads when they ask for a first week and already have one. It is a
// redirect, not a refusal — so it rotates like every other deterministic sentence
// (src/repo/brain/day-read-rules.ts) instead of printing one literal forever, and it
// names the path that CAN change a running week. Exported so the set itself is
// testable (add a PHRASING here; never call one by name).
export const WEEK_ALREADY_BUILT_VARIANTS = [
  "You already have a training week — this one only writes the first. To change what's there, evolve it.",
  "There's a week on your plan already. Composing starts from nothing; evolving it is how it changes from here.",
  "This builds a first week, and yours already exists. Evolve the week you're running instead of starting over.",
  "Your week is already written. From here it changes by evolving, not by composing a new one.",
] as const;

/**
 * Does a real training week already exist? Deliberately the SAME predicate the
 * scheduler uses to decide there is "no plan to evolve yet" (src/scheduler.ts) — a
 * plan day carrying items. A stray empty shell day is not a week, and treating one as
 * a plan would leave the athlete with the blank page and no way out of it: every other
 * producer would still no-op, and this op would refuse.
 */
function trainingWeekExists(): boolean {
  try {
    return (getPlan() as any[]).some((day) => Array.isArray(day?.items) && day.items.length > 0);
  } catch {
    return false;
  }
}

/**
 * Compose the athlete's FIRST training week — strength and endurance in one Mon-Sun
 * template — for someone who has no plan at all.
 *
 * This is the blank-slate counterpart to evolveProgram, and the ONLY producer that can
 * write a week from nothing: buildProgressionProposal, buildRunPlanProposal and the
 * scheduler's weekly evolution all require a plan to already exist and degrade to a
 * calm no-op without one. It runs ONE agent over buildWeekComposePrompt, persists the
 * result as a `draft` plan_proposals row carrying a `days` restructure, and hands that
 * draft to the shared autonomy policy — which classifies a whole-week `days` payload as
 * structural, so it ANNOUNCES first and lands at a natural boundary with one-tap Undo.
 * The op itself never applies anything; an agent never applies its own change.
 *
 * GUARD: this is the first week only. With a week already on the plan it returns the
 * designed { ok:false, error } at 200 pointing at the evolve path, and writes nothing.
 */
export async function composeWeek(agent: string | undefined, instruction: string | undefined, hooks?: OpHooks) {
  // The one choke point both surfaces share, so the bound is server policy rather
  // than something the route and the MCP tool each remember to do. The athlete's
  // words go into a prompt AND into the stored proposal instruction, so a
  // non-string body value or a pasted essay must be normalized once, here, before
  // either sees it. 240 matches what the PWA field accepts.
  // slice() cuts UTF-16 code units, so the 240 boundary can split an emoji and
  // leave a lone lead surrogate that round-trips as U+FFFD; drop it, don't store it.
  const asked =
    (typeof instruction === "string" ? instruction : "")
      .trim()
      .slice(0, 240)
      .replace(/[\uD800-\uDBFF]$/, "") || undefined;
  if (trainingWeekExists()) {
    return {
      proposal: null,
      autonomy: null,
      ok: false as const,
      error: pickDayVariant(WEEK_ALREADY_BUILT_VARIANTS, localDateISO(), "compose-week-already-built"),
      agent: null,
      tried: [] as { agent: string; error: string }[],
    };
  }
  hooks?.onPhase?.("reading where you're starting from");
  const prompt = buildWeekComposePrompt(asked);
  hooks?.onPhase?.("composing your first week");
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "compose_week",
      signal: hooks?.signal,
      acceptParsed: isPlanProposalResult,
      schema: PLAN_PROPOSAL_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      proposal: null,
      autonomy: null,
      ok: false as const,
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
      exit_code: null,
      stderr: "",
    };
  }
  const { agent: chosen, result, tried } = run;
  // The marker leads and the athlete's own words follow, so a composed week is
  // recognizable by prefix whether or not they said anything (see the constant).
  const proposal = createProposal(
    chosen,
    asked ? `${COMPOSE_WEEK_INSTRUCTION} — ${asked}` : COMPOSE_WEEK_INSTRUCTION,
    result.raw,
    result.parsed
  );
  // Only a `days` payload is a WEEK. A first-week reply that came back as `changes` or
  // `cardio` is an edit to a plan that does not exist — there is nothing for it to land
  // on, so it stays a plain reviewable draft rather than being pushed at an empty plan.
  const composedDays = Array.isArray((result.parsed as any)?.days) ? (result.parsed as any).days.length : 0;
  let autonomy: any = null;
  if (proposal?.id != null && composedDays > 0 && hasPlanProposalActions(result.parsed)) {
    try {
      autonomy = applyProposalWithAutonomy(Number(proposal.id));
    } catch {
      autonomy = null;
    }
  }
  return {
    proposal: proposal?.id != null ? getProposal(Number(proposal.id)) : proposal,
    autonomy,
    days: composedDays,
    ok: !!result.parsed,
    agent: chosen,
    tried,
    agent_status: agentStatusFor({ ok: !!result.parsed, agent: chosen, tried }),
    exit_code: result.code,
    stderr: (result.stderr || "").slice(0, 800),
  };
}

export interface ExerciseExplanation {
  setup: string;
  move: string;
  feel: string;
  avoid?: string;
}

const EXERCISE_EXPLANATION_KIND = "exercise_explanation";
const EXERCISE_EXPLANATION_FRESH_MS = 14 * 24 * 60 * 60 * 1000;

function cleanExerciseExplanationField(v: any): string {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= 140) return s;
  const wordCut = s.slice(0, 140).replace(/\s+\S*$/, "");
  return (wordCut || s.slice(0, 140)).trim();
}

export function normalizeExerciseExplanation(input: any): ExerciseExplanation | null {
  const source = input?.explanation && typeof input.explanation === "object" ? input.explanation : input;
  if (!source || typeof source !== "object") return null;
  const setup = cleanExerciseExplanationField(source.setup);
  const move = cleanExerciseExplanationField(source.move);
  const feel = cleanExerciseExplanationField(source.feel);
  const avoid = cleanExerciseExplanationField(source.avoid ?? source.watch ?? source.caution);
  if (!setup || !move || !feel) return null;
  return { setup, move, feel, ...(avoid ? { avoid } : {}) };
}

/**
 * The movement itself, in one or two sentences, for the art prompt's pose clause
 * (src/art.ts). Setup then move, first sentence of each — enough to place the
 * body without handing the image model the whole guide.
 */
export function exercisePoseFromExplanation(explanation: ExerciseExplanation | null | undefined): string | null {
  const firstSentence = (v: any): string => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    const m = s.match(/^[^.!?]+[.!?]?/);
    return (m ? m[0] : s).replace(/[.!?]+$/, "").trim();
  };
  const parts = [firstSentence(explanation?.setup), firstSentence(explanation?.move)].filter(Boolean);
  return parts.length ? parts.join(". ") : null;
}

export function exerciseExplanationCacheKey(detail: any): string {
  return fingerprint({
    name: String(detail?.name ?? "")
      .trim()
      .toLowerCase(),
    muscle_group: String(detail?.muscle_group ?? "")
      .trim()
      .toLowerCase(),
    mode: detail?.mode ?? "reps",
    constraint_note: String(detail?.constraint_note ?? "").trim(),
    cues: String(detail?.cues ?? "").trim(),
    appears: (Array.isArray(detail?.appears) ? detail.appears : []).map((a: any) => ({
      day: Number(a?.day_number) || null,
      name: String(a?.day_name ?? ""),
      sets: Number(a?.sets) || null,
      rep_low: Number(a?.rep_low) || null,
      rep_high: Number(a?.rep_high) || null,
      target_seconds: Number(a?.target_seconds) || null,
      note: String(a?.note ?? "").trim(),
    })),
  });
}

export function getCachedExerciseExplanation(name: string) {
  const detail: any = getExerciseDetail(name);
  if (!detail?.found) return { ok: false as const, found: false as const, exercise: name, error: "exercise not found" };
  const cacheKey = exerciseExplanationCacheKey(detail);
  const cached = getAiCache(EXERCISE_EXPLANATION_KIND, cacheKey);
  const explanation = normalizeExerciseExplanation(cached?.result);
  if (!cached || !explanation) {
    return { ok: true as const, found: true as const, exercise: detail.name, cached: false as const };
  }
  return {
    ok: true as const,
    found: true as const,
    exercise: detail.name,
    explanation,
    cached: true as const,
    stale: cached.stale,
    agent: cached.chosen_agent,
    computed_at: cached.computed_at,
  };
}

export async function explainExercise(agent: string | undefined, name: string, hooks?: OpHooks) {
  const detail: any = getExerciseDetail(name);
  if (!detail?.found) return { ok: false as const, found: false as const, exercise: name, error: "exercise not found" };
  const cacheKey = exerciseExplanationCacheKey(detail);
  const cached = getAiCache(EXERCISE_EXPLANATION_KIND, cacheKey);
  const cachedExplanation = normalizeExerciseExplanation(cached?.result);
  if (cached && cachedExplanation && !cached.stale) {
    hooks?.onPhase?.("served from cache");
    return {
      ok: true as const,
      found: true as const,
      exercise: detail.name,
      explanation: cachedExplanation,
      cached: true as const,
      stale: false as const,
      agent: cached.chosen_agent,
      computed_at: cached.computed_at,
    };
  }

  hooks?.onPhase?.("writing exercise cues");
  const prompt = buildExerciseExplanationPrompt(detail);
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: EXERCISE_EXPLANATION_KIND,
      timeoutMs: interactiveTimeoutForOp(EXERCISE_EXPLANATION_KIND),
      signal: hooks?.signal,
      acceptParsed: isExerciseExplanationResult,
      schema: EXERCISE_EXPLANATION_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    if (cachedExplanation) {
      return {
        ok: true as const,
        found: true as const,
        exercise: detail.name,
        explanation: cachedExplanation,
        cached: true as const,
        stale: true as const,
        agent: cached?.chosen_agent ?? null,
        computed_at: cached?.computed_at ?? null,
      };
    }
    return {
      ok: false as const,
      found: true as const,
      exercise: detail.name,
      error: "agent returned no usable exercise explanation",
      ...failure,
    };
  }
  const { agent: chosen, result, tried } = run;
  const explanation = normalizeExerciseExplanation(result.parsed);
  if (!explanation) {
    if (cachedExplanation) {
      return {
        ok: true as const,
        found: true as const,
        exercise: detail.name,
        explanation: cachedExplanation,
        cached: true as const,
        stale: true as const,
        agent: cached?.chosen_agent ?? null,
        computed_at: cached?.computed_at ?? null,
      };
    }
    return {
      ok: false as const,
      found: true as const,
      exercise: detail.name,
      error: "agent returned no usable exercise explanation",
      agent: chosen,
      tried,
    };
  }

  const out = {
    ok: true as const,
    found: true as const,
    exercise: detail.name,
    explanation,
    cached: false as const,
    agent: chosen,
    tried,
  };
  try {
    saveAiCache(EXERCISE_EXPLANATION_KIND, cacheKey, {
      result: out,
      chosen_agent: chosen,
      ref_table: "exercises",
      ref_id: Number(detail.id) || null,
      freshForMs: EXERCISE_EXPLANATION_FRESH_MS,
    });
  } catch {
    /* cache write never breaks the op */
  }
  return out;
}

// ---------- the week ahead (forward look) ----------
const WEEK_AHEAD_KIND = "week_ahead";
const WEEK_AHEAD_FRESH_MS = 18 * 60 * 60 * 1000; // a day's shape — recompute ~daily
const WEEK_AHEAD_DAY_KINDS = new Set(["lift", "run", "mixed", "rest"]);

function sanitizeWeekAhead(input: any): { days: any[]; summary: string } | null {
  const rawDays = Array.isArray(input?.days) ? input.days : null;
  if (!rawDays || !rawDays.length) return null;
  const days = rawDays
    .slice(0, 7)
    .map((d: any) => ({
      day: d?.day == null ? null : String(d.day).replace(/\s+/g, " ").trim().slice(0, 16) || null,
      kind: WEEK_AHEAD_DAY_KINDS.has(String(d?.kind)) ? String(d.kind) : "lift",
      label: String(d?.label ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60),
      ...(d?.note != null && String(d.note).trim()
        ? { note: String(d.note).replace(/\s+/g, " ").trim().slice(0, 90) }
        : {}),
    }))
    .filter((d: any) => d.label);
  if (!days.length) return null;
  return {
    days,
    summary: String(input?.summary ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240),
  };
}

// A calm sketch of the next several days (lift / run / mixed / rest), the day-read
// projected forward. Agentic with the deterministic plan-rotation floor as the
// always-available fallback; cached per day+plan+goal (serve-stale-then-revalidate).
//
// `cacheKey` is passed by the background job runner, which was handed the key the
// enqueue deduped on. It must be the SAME slot: re-deriving it here off today's
// localDateISO() would let a run started before a midnight rollover fill a key
// nothing is waiting for, leaving the guarded one permanently cold.
export async function weekAheadRead(agent: string | undefined, hooks?: OpHooks, cacheKeyOverride?: string) {
  const floor = weekAheadPlan();
  const floorResult = {
    ok: true as const,
    days: floor.days,
    summary: floor.summary,
    source: "deterministic" as const,
    cached: false as const,
  };
  const cacheKey = cacheKeyOverride?.trim() || weekAheadCacheKey(floor);
  const cached = getAiCache(WEEK_AHEAD_KIND, cacheKey);
  const cachedSane = sanitizeWeekAhead(cached?.result);
  if (cached && cachedSane && !cached.stale) {
    hooks?.onPhase?.("served from cache");
    return {
      ok: true as const,
      ...cachedSane,
      source: "agent" as const,
      cached: true as const,
      agent: cached.chosen_agent,
    };
  }

  hooks?.onPhase?.("sketching your week");
  try {
    const prompt = buildWeekAheadPrompt();
    const { agent: chosen, result } = await runChosen(agent, prompt, {
      op: WEEK_AHEAD_KIND,
      timeoutMs: interactiveTimeoutForOp(WEEK_AHEAD_KIND),
      signal: hooks?.signal,
      acceptParsed: isWeekAheadResult,
      schema: WEEK_AHEAD_SCHEMA,
    });
    const sane = sanitizeWeekAhead(result.parsed);
    if (sane) {
      const out = { ok: true as const, ...sane, source: "agent" as const, cached: false as const, agent: chosen };
      try {
        saveAiCache(WEEK_AHEAD_KIND, cacheKey, {
          result: out,
          chosen_agent: chosen,
          freshForMs: WEEK_AHEAD_FRESH_MS,
        });
      } catch {
        /* cache write never breaks the op */
      }
      return out;
    }
  } catch (error) {
    // Stale/deterministic fallback is correct for an unavailable coach, not for
    // an explicit Stop. Cancellation must remain observable to the caller.
    if (hooks?.signal?.aborted) throw error;
    /* fall through to a stale-cache or the deterministic floor */
  }
  if (cachedSane)
    return {
      ok: true as const,
      ...cachedSane,
      source: "agent" as const,
      cached: true as const,
      stale: true as const,
      agent: cached?.chosen_agent ?? null,
    };
  return floorResult;
}

export function weekAheadCacheKey(floor: ReturnType<typeof weekAheadPlan>, date = localDateISO()): string {
  const profile: any = getProfile();
  return fingerprint({
    op: WEEK_AHEAD_KIND,
    date,
    plan: floor.days.map((d) => `${d.kind}:${d.label}`),
    goal: { gw: profile?.goal_weight_lb ?? null, gd: profile?.goal_date ?? null },
    trainingReality: coachingCacheFreshnessFingerprint(date),
  });
}

// Synchronous, agent-free counterpart to weekAheadRead for the HTTP GET: a cold
// or stale cache must never spawn a coaching CLI inline on a user-facing
// request. This returns the best answer already on hand (fresh cache / stale
// cache / the deterministic floor) instantly and reports `needsRefresh` so the
// caller (the route, or the scheduler's day-rollover warm) can kick a
// background job — agentJobs.ensureWeekAheadJob — that runs the real
// weekAheadRead computation and fills the cache for next time. `computing:
// true` marks a floor/stale answer a background read is already chasing; the
// PWA's today-week-ahead-client only reads ok/days/summary and ignores it.
export function weekAheadServe(date = localDateISO()): {
  response: Awaited<ReturnType<typeof weekAheadRead>> & {
    computing?: true;
    race?: ReturnType<typeof weekAheadRaceLine>;
  };
  needsRefresh: boolean;
  cacheKey: string;
} {
  const floor = weekAheadPlan(date);
  const cacheKey = weekAheadCacheKey(floor, date);
  const cached = getAiCache(WEEK_AHEAD_KIND, cacheKey);
  const cachedSane = sanitizeWeekAhead(cached?.result);
  // Composed fresh at serve time, never stored inside the AI cache blob: the
  // race line must reflect TODAY's days-to-race even when a day-old cached
  // week-ahead is served, and it must ride on the deterministic floor too.
  let race: ReturnType<typeof weekAheadRaceLine> = null;
  try {
    race = weekAheadRaceLine(getEnduranceGoal(date), date);
  } catch {
    race = null;
  }
  if (cached && cachedSane && !cached.stale) {
    return {
      response: { ok: true, ...cachedSane, source: "agent", cached: true, agent: cached.chosen_agent, race },
      needsRefresh: false,
      cacheKey,
    };
  }
  if (cachedSane) {
    return {
      response: {
        ok: true,
        ...cachedSane,
        source: "agent",
        cached: true,
        stale: true,
        agent: cached?.chosen_agent ?? null,
        computing: true,
        race,
      },
      needsRefresh: true,
      cacheKey,
    };
  }
  return {
    response: {
      ok: true,
      days: floor.days,
      summary: floor.summary,
      source: "deterministic",
      cached: false,
      computing: true,
      race,
    },
    needsRefresh: true,
    cacheKey,
  };
}

// ---------- agentic exercise reconciliation ----------
// The movement-name counterpart to reconcileMarkers: different logging passes name
// the same lift differently ("Dead hang"/"Dead hang timed", "DB bench"/"Dumbbell
// bench press"), splitting one movement's history into parallel series and muddying
// the volume/progression read. The deterministic canonicalizer (exercise-canon) is
// the offline FLOOR; this learns the harder synonyms a human would catch. The agent
// clusters same-movement names; repo.planExerciseAliases validates each member→
// canonical decision (pure guards) and we persist them as exercise_aliases rows
// (source 'agent'), so findOrCreateExercise / the canon resolve them from then on.
// Conservatively, when a cluster's canonical movement has a missing/"other" group
// and the agent gave a confident group, we IMPROVE it (never overwrite a real one).
// Fail-open: no agent / bad shape → nothing persisted, the deterministic floor stands.
export async function reconcileExercises(
  agent?: string,
  hooks?: OpHooks,
  opts: { authoritativeGroups?: boolean } = {}
) {
  let items = distinctExerciseNames();
  if (items.length < 2) {
    return {
      ok: true as const,
      aligned: 0,
      applied: 0,
      candidates: items.length,
      aliased: 0,
      groups_fixed: 0,
      merged: [] as Array<{ from: string; into: string }>,
      suggested: [] as Array<{ from: string; into: string; why: string; confidence: string }>,
      skipped: [] as Array<{ from: string; into: string; reason: string }>,
    };
  }
  hooks?.onPhase?.("tidying exercise names");

  const merged: Array<{ from: string; into: string }> = [];
  const skipped: Array<{ from: string; into: string; reason: string }> = [];
  const suggested: Array<{ from: string; into: string; why: string; confidence: string }> = [];
  const mergedFrom = new Set<string>(); // normalized from-names already merged
  let groups_fixed = 0;

  // ---- 1. DETERMINISTIC auto-merge: exact-key clusters are one movement ----
  // Rows sharing normalizedExerciseKey ("Leg Extensions" / "Leg Extension", "Dead hang
  // timed" / "Dead hang") are the same lift — fold them with no agent. Survivor = most
  // distinct logged days; tie → the cleaner display name. A mode-incompatible pair
  // (a rare mis-tag) is refused by mergeExercises and lands in `skipped`.
  const clusters = new Map<string, typeof items>();
  for (const it of items) {
    const key = normalizedExerciseKey(it.name);
    if (!key) continue;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(it);
    else clusters.set(key, [it]);
  }
  const cleaner = (a: string, b: string): number => {
    const ca = cleanExerciseName(a) === a ? 0 : 1;
    const cb = cleanExerciseName(b) === b ? 0 : 1;
    return ca - cb || a.length - b.length || a.localeCompare(b);
  };
  for (const bucket of clusters.values()) {
    const distinct = [...new Map(bucket.map((m) => [m.name, m])).values()];
    if (distinct.length < 2) continue;
    distinct.sort((a, b) => b.days - a.days || cleaner(a.name, b.name));
    const into = distinct[0].name;
    for (const m of distinct.slice(1)) {
      const res = mergeExercises(m.name, into);
      if (res.ok) {
        merged.push({ from: m.name, into });
        mergedFrom.add(normalizeExerciseName(m.name));
      } else {
        skipped.push({ from: m.name, into, reason: res.error ?? "merge refused" });
      }
    }
  }

  // ---- 2. DETERMINISTIC group correction: fill an empty group; optionally override ----
  // authoritativeGroup fires ONLY for unambiguous movements (a "pulldown" imported as
  // forearms → back), skipping the contested single-token cases (dip/pullover/curl).
  // An empty/unknown group is ALWAYS filled. OVERRIDING a valid-but-wrong non-null group
  // happens only when the caller opts in (`authoritativeGroups`) — the user-initiated
  // "Tidy" fixes a wrong group on demand, while the nightly pass never re-litigates a
  // group the athlete may have set (no background tug-of-war).
  const overrideGroups = opts.authoritativeGroups === true;
  for (const ex of listExercises()) {
    const auth = authoritativeGroup(ex.name);
    if (!auth) continue;
    const cur = canonicalGroup(ex.muscle_group ?? null);
    if (cur === auth) continue;
    if (cur == null || overrideGroups) {
      // cur == null means the stored group is empty/"other"/unknown (fill), else it's a
      // recognized-but-wrong group we only touch under an explicit override.
      try {
        updateExercise(Number(ex.id), { muscle_group: auth });
        groups_fixed++;
      } catch {
        /* skip a bad row, keep going */
      }
    }
  }

  // Re-read after the deterministic merges/corrections so the agent sees the tidied
  // list (no folded-away ghost names, corrected groups).
  items = distinctExerciseNames();
  const prompt = buildExerciseReconcilePrompt(items);

  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "exercise_reconcile",
      signal: hooks?.signal,
      acceptParsed: isReconciliationResult,
      schema: EXERCISE_RECONCILE_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    // The deterministic pass already did real work — report it even when the agent is
    // unavailable (ok:false still signals the agentic reconcile didn't complete).
    return {
      ok: false as const,
      error: "no usable reconciliation",
      candidates: items.length,
      merged,
      suggested,
      skipped,
      groups_fixed,
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const { agent: chosen, result, tried } = run;
  const p: any = result?.parsed;
  if (!p || typeof p !== "object" || !Array.isArray(p.groups)) {
    return {
      ok: false as const,
      error: "no usable reconciliation",
      agent: chosen,
      tried,
      candidates: items.length,
      merged,
      suggested,
      skipped,
      groups_fixed,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Validate the agent's clusters into concrete alias rows (pure guards: verbatim
  // members, ≥2 distinct names, a real merge) and persist each one.
  const aliases = planExerciseAliases(
    items.map((i) => ({ name: i.name })),
    p.groups
  );
  for (const a of aliases) setExerciseAlias(a.rawNorm, a.canonical, "agent");

  // Conservatively IMPROVE a canonical movement's muscle group only when it's
  // currently null/"other" AND the agent supplied a confident group for the cluster.
  // Never overwrite a good group; never throw on a bad row.
  const validGroups = (() => {
    try {
      return new Set<string>([...MUSCLE_GROUPS]);
    } catch {
      return null;
    }
  })();
  for (const g of p.groups) {
    const canonical = String(g?.canonical ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const suggestedGroup = String(g?.group ?? g?.muscle_group ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!canonical || !suggestedGroup || suggestedGroup === "other") continue;
    if (validGroups && !validGroups.has(suggestedGroup)) continue; // only a recognized canonical group
    try {
      const ex: any = findExercise(canonical);
      const cur = String(ex?.muscle_group ?? "")
        .trim()
        .toLowerCase();
      if (ex && (!cur || cur === "other") && cur !== suggestedGroup) {
        updateExercise(Number(ex.id), { muscle_group: suggestedGroup });
        groups_fixed++;
      }
    } catch {
      /* skip a bad row, keep going */
    }
  }

  // ---- AGENTIC merges — the same lift under two names. Each is validated by the pure
  // guard (repo.validateExerciseMergePlan). A merge is AUTO-APPLIED only when it's
  // confidence:"high" AND structurally related (same key / token subset) — a pass that
  // rests only on a shared muscle group is irreversible and ambiguous, so it's demoted
  // to a suggestion for one-tap confirmation. Everything else (medium/low, group-only)
  // returns as a suggestion; a validator rejection is skipped. ----
  const daysByNorm = new Map<string, number>();
  for (const it of items) daysByNorm.set(normalizeExerciseName(it.name), it.days);
  const seenPair = new Set<string>();
  for (const m of Array.isArray(p.merges) ? p.merges : []) {
    const from = String(m?.from ?? "").trim();
    const into = String(m?.into ?? "").trim();
    const confidence = String(m?.confidence ?? "").toLowerCase();
    const fromNorm = normalizeExerciseName(from);
    const intoNorm = normalizeExerciseName(into);
    if (!fromNorm || !intoNorm || fromNorm === intoNorm) continue;
    if (mergedFrom.has(fromNorm)) continue; // already folded deterministically
    const pairKey = `${fromNorm}=>${intoNorm}`;
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);
    const fromRow: any = findExercise(from);
    const intoRow: any = findExercise(into);
    if (!fromRow || !intoRow) {
      skipped.push({ from, into, reason: "exercise not found" });
      continue;
    }
    const verdict = validateExerciseMergePlan(
      { name: fromRow.name, group: fromRow.muscle_group, mode: fromRow.mode, days: daysByNorm.get(fromNorm) ?? 0 },
      { name: intoRow.name, group: intoRow.muscle_group, mode: intoRow.mode, days: daysByNorm.get(intoNorm) ?? 0 }
    );
    if (!verdict.ok) {
      skipped.push({ from, into, reason: verdict.reason ?? "rejected" });
      continue;
    }
    if (shouldAutoApplyMerge(verdict, confidence)) {
      const res = mergeExercises(fromRow.name, intoRow.name);
      if (res.ok) {
        merged.push({ from: fromRow.name, into: intoRow.name });
        mergedFrom.add(fromNorm);
      } else {
        skipped.push({ from, into, reason: res.error ?? "merge refused" });
      }
    } else {
      suggested.push({
        from: fromRow.name,
        into: intoRow.name,
        why: String(m?.why ?? "").slice(0, 200),
        confidence: confidence || "medium",
      });
    }
  }

  const aligned = new Set(aliases.map((a) => a.canonical)).size;
  return {
    ok: true as const,
    aligned,
    applied: aliases.length,
    candidates: items.length,
    aliased: aliases.length,
    groups_fixed,
    merged,
    suggested,
    skipped,
    agent: chosen,
    tried,
    agent_status: "ok" as const,
  };
}
