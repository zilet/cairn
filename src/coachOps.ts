// Shared coaching orchestration: the "run agent → validate parsed JSON shape →
// persist as draft/insight/review → return ok/ok:false" logic that src/api.ts
// (REST) and src/mcp.ts (MCP) both adapt. Per the project's architecture rule,
// this business logic lives in ONE place; the two protocol surfaces are thin
// wrappers that only translate the returned OBJECT into an HTTP response or an
// MCP asText payload. Each function here returns the plain result object — the
// designed { ok:true, ... } / { ok:false, error, tried } shape — never an HTTP
// response and never an MCP wrapper.

import * as repo from "./repo.js";
import { addDaysISO, localDateISO } from "./repo/shared.js";
import { sessionNoteSuggestsFatigue, sessionNoteSuggestsRapidFade } from "./repo/training-fatigue.js";
import { AgentFallbackError, agentInfo, listAgentModels, loadAgents, type FallbackResult } from "./agents.js";
import { runChosen, runChosenStreaming, runChosenWithCoachReads } from "./runChosen.js";
import {
  buildCoachPrompt,
  buildProgramEvolutionPrompt,
  buildMealPlanPrompt,
  buildMealSwapPrompt,
  buildRecipePrompt,
  buildHealthReviewPrompt,
  buildSessionPrompt,
  buildDailyCompositionPrompt,
  buildExerciseExplanationPrompt,
  buildWeekAheadPrompt,
  buildSessionVerifyPrompt,
  buildPlanVerifyPrompt,
  buildNutritionCheckinPrompt,
  buildInsightPrompt,
  buildWeeklyReadPrompt,
  buildHealthSynthesisPrompt,
  buildMemoryConsolidationPrompt,
  buildAboutMeGrowthPrompt,
  buildChatDistillPrompt,
  buildOnboardPrompt,
  buildMarkerReconcilePrompt,
  buildExerciseReconcilePrompt,
  buildReactionNarrativePrompt,
} from "./prompt.js";
import { researchEnabled, gatherReviewGrounding, researchEvidence } from "./research.js";
import { normalizeHealthSynthesis } from "./health-synthesis.js";
import { clampNutritionFloors } from "./repo/nutrition-safety.js";
import { applyMealPlanWithAutonomy, applyProposalWithAutonomy } from "./domain/brain/autonomy-service.js";
import { personalizedNutritionStep } from "./domain/brain/underfueling-service.js";
import {
  DAILY_SESSION_SUGGESTION_NORMALIZATION,
  MEAL_PLAN_STRUCTURE_SCHEMA,
  MEAL_SWAP_SCHEMA,
  PLAN_PROPOSAL_SCHEMA,
  WEEK_AHEAD_SCHEMA,
  hasPlanProposalActions,
  isExerciseExplanationResult,
  isHealthReviewResult,
  isHealthSynthesisResult,
  isInsightResult,
  isMealPlanStructureResult,
  isMealSwapResult,
  isNutritionCheckinResult,
  isPlanProposalResult,
  isReactionNarrativeResult,
  isRecipeResult,
  isReconciliationResult,
  isSessionSuggestionResult,
  isVerifyResult,
  isWeekAheadResult,
  normalizeSessionSuggestionResult,
} from "./agent-contracts.js";

// runChosen is the shared agent-dispatch helper (see ./runChosen.ts). It's
// re-exported here because api.ts / mcp.ts import it from coachOps as the
// single agentic-ops entry point.
export { runChosen };

// Exported for a focused deterministic boundary test. This is the same guard
// draftMealPlan runs immediately before persistence/autonomy; the verifier agent
// remains advisory and cannot authorize an inadequate plan.
export function validateMealPlanDraftForPersistence(parsed: any, dietaryInstruction?: string) {
  const check = repo.validateMealPlanForPersistence(parsed, { dietary_instruction: dietaryInstruction });
  return check.ok
    ? { ok: true as const, parsed: check.parsed, adequacy_checked: check.adequacy_checked }
    : { ok: false as const, error: check.error };
}

// Turn an agent's adaptive-nutrition suggestion into the bounded target the
// proposal actually carries. The personal-response layer may tune the SIZE of
// the nudge, but the universal 250-kcal ceiling and lean-safe kcal/protein floors
// remain authoritative. Exported so the deterministic boundary is testable.
export function personalizeNutritionCheckinTarget(nutrition: any, goalInput?: any): any {
  if (!nutrition || typeof nutrition !== "object") return nutrition;
  const goal = goalInput ?? repo.computeGoalCheck();
  const rawTarget = Number(nutrition.target_kcal);
  if (!Number.isFinite(rawTarget)) return nutrition;
  const fallbackTarget = Number(goal?.effective_target?.target_kcal);
  let activeTarget = Number.NaN;
  if (!Number.isFinite(fallbackTarget)) {
    try {
      activeTarget = Number(repo.getActiveNutritionTarget()?.target_kcal);
    } catch {
      activeTarget = Number.NaN;
    }
  }
  // Agent-supplied prev_target_kcal is display context, never authority. The
  // active/effective server target owns both the delta and the +/-250 boundary.
  const previous = Number.isFinite(fallbackTarget) ? fallbackTarget : activeTarget;
  let target = rawTarget;
  if (Number.isFinite(previous)) {
    const rawDelta = rawTarget - previous;
    const sign = rawDelta < 0 ? -1 : rawDelta > 0 ? 1 : 0;
    // Any requested change becomes the same phase-aware, canonical 100-250 kcal
    // step the deterministic underfuel controller uses. The model chooses the
    // direction; Cairn owns magnitude, 25-kcal rounding and safety authority.
    const standardStep = Math.min(250, Math.abs(rawDelta));
    const learnedStep = sign === 0 ? 0 : personalizedNutritionStep(standardStep, localDateISO(), 250);
    target = Math.round(previous + sign * learnedStep);
  }
  const bounded = clampNutritionFloors(
    { ...nutrition, target_kcal: target, prev_target_kcal: Number.isFinite(previous) ? Math.round(previous) : null },
    { kcal: "target_kcal", protein: "protein_g" },
    goal
  );
  if (Number.isFinite(previous)) {
    const delta = Math.round(Number(bounded.target_kcal) - previous);
    if ("delta_kcal" in bounded) bounded.delta_kcal = delta;
    if ("change_kcal" in bounded) bounded.change_kcal = delta;
  }
  return bounded;
}

// A low-confidence outcome estimate may never justify a calorie cut. It may,
// however, support a bounded protective RAISE when fresh deterministic training
// evidence says the athlete is under-fueled or performance is fading. These are
// planning signals only; wearable burn is never added to the target here.
export function protectiveFuelEvidence(date = localDateISO()): string[] {
  const reasons: string[] = [];
  try {
    const program = repo.getProgramState(date) as any;
    if (program?.hybrid?.fuel?.risk === "high") reasons.push("high hybrid fuel-risk from recent endurance load");
  } catch {
    /* no deterministic program read */
  }
  try {
    const since = addDaysISO(date, -13) ?? date;
    const sessions = (repo.getRecentSessions(12) as any[]).filter(
      (session) => String(session?.date ?? "") >= since && String(session?.date ?? "") <= date
    );
    const lowPerformance = sessions.filter(
      (session) => session?.performance != null && Number(session.performance) <= 2
    ).length;
    const fatigueNotes = sessions.filter((session) => sessionNoteSuggestsFatigue(session?.notes));
    const rapidFade = fatigueNotes.some((session) => sessionNoteSuggestsRapidFade(session?.notes));
    if (lowPerformance >= 2) reasons.push("repeated low performance in recent session feedback");
    if (fatigueNotes.length >= 2 || rapidFade)
      reasons.push("fresh session notes describe under-fueling or performance fade");
  } catch {
    /* no recent session evidence */
  }
  return [...new Set(reasons)];
}
// ---- agent connect/visibility helpers (read-only; see src/agents.ts) ----
// The two protocol surfaces (api.ts / mcp.ts) read agent connect-state through
// coachOps so they stay thin adapters. These wrap the agents.ts probes and shape
// the designed { ok, ... } result — version/model visibility + the model catalog,
// neither of which makes a coaching/paid call.

// "What's running" for one agent: installed version + best-effort current model.
// ok:false (at the adapter's HTTP 200) for an unknown agent.
export function agentInfoOp(name: string) {
  if (!loadAgents()[name]) return { ok: false as const, error: `unknown agent "${name}"` };
  const info = agentInfo(name);
  return { ok: true as const, ...info };
}

// A CLI's model catalog (grok/agy). Empty list for a CLI with no `models_list`
// or on any probe failure; ok:false only for an unknown agent.
export function agentModelsOp(name: string) {
  if (!loadAgents()[name]) return { ok: false as const, error: `unknown agent "${name}"`, models: [] as string[] };
  return { ok: true as const, models: listAgentModels(name) };
}

// Agent-status contract (v35) — a calm, additive provenance hint the PWA reads to
// distinguish "no coaching CLI is configured" from "an agent was tried and failed"
// from a real agentic result. NEVER changes existing fields; it's a sidecar string.
//   'unconfigured' — repo.pickAgentOrder() is empty (no usable agent installed/enabled)
//   'all_failed'   — agents WERE available but every attempt failed (fell to the floor)
//   'ok'           — an agent produced the result
// A `result` carries `source`/`agent`/`tried`/`ok` from the op; any subset is fine.
export function agentStatusFor(
  result: {
    source?: string | null;
    agent?: string | null;
    ok?: boolean;
    tried?: { agent: string; error: string }[] | null;
  } = {}
): "ok" | "unconfigured" | "all_failed" {
  let configured = true;
  try {
    configured = repo.pickAgentOrder().length > 0;
  } catch {
    configured = true;
  }
  if (!configured) return "unconfigured";
  // An agentic result is one that came from an agent (source === 'agent') or that
  // succeeded (ok !== false with a chosen agent). The deterministic floor / a
  // failed op means every available attempt failed.
  const agentic =
    result.source === "agent" || (result.ok !== false && !!result.agent && result.source !== "deterministic");
  return agentic ? "ok" : "all_failed";
}

// Optional hooks the durable agent-job worker threads into a backgrounded op:
// `signal` lets a Stop SIGKILL the live subprocess (through runChosen→runAgent),
// `onPhase` reports real progress to the job bus. ADDITIVE — when both are
// omitted (every existing caller: REST inline path, MCP, scheduler), behavior is
// byte-for-byte unchanged. The hooks default to no-ops.
export interface OpHooks {
  signal?: AbortSignal;
  onPhase?: (phase: string, meta?: any) => void;
  // Live prose tokens for the four prose-bearing ops (synthesis / session-suggest /
  // nutrition check-in / weekly read), streamed into the waiting card. The agent-job
  // worker wires this to a `delta` bus event; every other caller omits it, so those
  // ops run exactly as before (runChosenStreaming with no onDelta === runChosen).
  onDelta?: (chunk: string) => void;
}

function agentFailure(error: unknown, hooks?: OpHooks): { agent: null; tried: { agent: string; error: string }[] } {
  // A user Stop is control flow, not graceful degradation: preserve cancellation
  // so the durable job worker can mark the operation canceled instead of failed.
  if (hooks?.signal?.aborted) throw error;
  return {
    agent: null,
    tried: error instanceof AgentFallbackError ? error.tried : [],
  };
}

// ---------- self-critique verify pass (Trust build V1) ----------
// Run ONE bounded follow-up agent turn that checks a just-produced high-stakes
// draft against its HARD floors/constraints and applies a returned fix. The
// contract is { ok, violations:[], fixed_draft? }. FAIL-OPEN by design: any
// failure (agent down, unparseable, wrong shape) returns the ORIGINAL draft
// unchanged with `verified:null` — exactly today's behavior, never load-bearing.
// `validate` re-checks a fixed_draft so a broken "fix" can't replace a good draft.
// Always-on, cheap, fully try/catch-wrapped (no setting, no schema).
export interface VerifyOutcome<T> {
  draft: T;
  verified: { checked: true; adjustments: string[] } | null;
}
async function runVerify<T>(
  agent: string | undefined,
  draft: T,
  buildPrompt: (d: T) => string,
  validate: (fixed: any) => boolean,
  op: string,
  hooks?: OpHooks
): Promise<VerifyOutcome<T>> {
  try {
    const { result } = await runChosen(agent, buildPrompt(draft), {
      op,
      timeoutMs: repo.interactiveTimeoutForOp(op),
      signal: hooks?.signal,
      acceptParsed: (parsed) => isVerifyResult(parsed, validate),
    });
    const v: any = result.parsed;
    if (!v || typeof v !== "object") return { draft, verified: null };
    const violations: string[] = Array.isArray(v.violations)
      ? v.violations.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 240))
      : [];
    // A real fix that re-validates against the schema → adopt it.
    if (v.ok === false && v.fixed_draft && typeof v.fixed_draft === "object" && validate(v.fixed_draft)) {
      return {
        draft: v.fixed_draft as T,
        verified: { checked: true, adjustments: violations.length ? violations : ["adjusted to honor your floors"] },
      };
    }
    if (v.ok === true) return { draft, verified: { checked: true, adjustments: [] } };
    // Defensive only: acceptParsed rejects this before rotation stops. Never show
    // "checked" for a malformed verdict or an unusable fix.
    return { draft, verified: null };
  } catch (error) {
    // A failed verifier is deliberately fail-open, but a user-initiated Stop is
    // not an agent-quality failure. Preserve cancellation all the way to the
    // request/job boundary so we never persist work the athlete canceled.
    if (hooks?.signal?.aborted) throw error;
    // Verify unavailable → ship the draft unverified (graceful degrade).
    return { draft, verified: null };
  }
}

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
  const cached = repo.getAiCache("session_suggest", cacheKey);
  // Exercise mode is durable identity. Re-check even a fresh cache hit against
  // the current database so a suggestion can never render as actionable and then
  // fail preparation because that movement is authoritatively timed/reps work.
  const sessionSane = (s: any) => isSessionSuggestionResult(s);
  const cachedSession = normalizeSessionSuggestionResult(cached?.result?.session);
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
      timeoutMs: repo.interactiveTimeoutForOp("session_suggest"),
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: sessionSane,
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
  const p = normalizeSessionSuggestionResult(result.parsed);
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
  // Self-critique: check the suggestion against the athlete's HARD constraints
  // (injury, time budget, equipment, encoding) and adopt a fix if one is returned.
  // Fail-open — verify down/garbage ⇒ the draft ships exactly as before.
  hooks?.onPhase?.("checking it against your floors", { frac: { done: 1, total: 2 } });
  const { draft, verified } = await runVerify(
    agent,
    p,
    (d) => buildSessionVerifyPrompt(d, opts),
    sessionSane,
    "session_verify",
    hooks
  );
  const session = normalizeSessionSuggestionResult(draft) ?? p;
  // Outcome learning: record what was suggested so a later pass can compare it to
  // what the athlete actually trained. Best-effort; never blocks the response.
  repo.recordSuggestion("session_suggest", opts.date ?? null, {
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
    repo.saveAiCache("session_suggest", cacheKey, {
      result: out,
      chosen_agent: chosen,
      freshForMs: 3 * 60 * 60 * 1000,
    });
  } catch {
    /* cache write never breaks the op */
  }
  return out;
}

// Stage 3 — bounded agent composition (docs/ADAPTIVE_DAILY_TRAINING_PLAN.md §5).
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
  const { envelope } = repo.decideDailySession(opts.date, {
    override: opts.override ?? null,
    train_anyway: opts.train_anyway === true,
    equipment: opts.equipment ?? null,
    minutes: opts.minutes ?? null,
  });

  // A rest read composes deterministically — never spend an agent run to say
  // "take it easy today".
  if (envelope.kind === "rest") {
    const session = repo.deterministicComposedSession(envelope);
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
      timeoutMs: repo.interactiveTimeoutForOp("session_compose"),
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: (s: any) => isSessionSuggestionResult(s),
    });
  } catch (error) {
    // A user Stop must propagate (agentFailure re-throws on abort); any other
    // agent failure degrades to the deterministic fallback (never fail the
    // composition), preserving the attempted-agent list for observability.
    triedFromFailure = agentFailure(error, hooks).tried;
    run = null;
  }

  let session = null as ReturnType<typeof repo.deterministicComposedSession> | null;
  let fallback: string | null = null;
  let validation: any = null;
  let chosen: string | null = run?.agent ?? null;
  const tried = run?.tried ?? triedFromFailure;

  if (run?.result?.parsed) {
    const normalized = repo.normalizeComposedSession(run.result.parsed, envelope);
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
    session = repo.deterministicComposedSession(envelope);
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
function sessionSuggestCacheKey(opts: {
  minutes?: number;
  equipment?: string;
  focus?: string;
  constraints?: string;
  date?: string;
}): string {
  const date = opts.date || localDateISO();
  let dayContext = "";
  try {
    const dr = repo.dayRead(date);
    dayContext = `${dr.kind}|${dr.focus ?? ""}`;
  } catch {
    /* a missing read just yields a coarser key */
  }
  let profileContext: Record<string, unknown> | null = null;
  try {
    const profile = repo.getProfile();
    profileContext = profile
      ? {
          updated_at: profile.updated_at ?? null,
          primary_discipline: profile.primary_discipline ?? null,
          endurance_sport: profile.endurance_sport ?? null,
          endurance_goal_json: profile.endurance_goal_json ?? null,
          training_intent_json: profile.training_intent_json ?? null,
        }
      : null;
  } catch {
    /* a missing profile keeps the cache usable on a fresh install */
  }
  return repo.fingerprint({
    minutes: opts.minutes ?? null,
    equipment: (opts.equipment ?? "").trim().toLowerCase(),
    focus: (opts.focus ?? "").trim().toLowerCase(),
    constraints: (opts.constraints ?? "").trim().toLowerCase(),
    date,
    dayContext,
    profileContext,
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
  const proposal = repo.createProposal(chosen, instruction ?? "", result.raw, result.parsed);
  let autonomy: any = null;
  if (result.parsed && hasPlanProposalActions(result.parsed)) {
    try {
      autonomy = applyProposalWithAutonomy(Number(proposal.id));
    } catch {
      autonomy = null;
    }
  }
  return {
    proposal: repo.getProposal(Number(proposal.id)),
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
  const state = repo.getProgramState();
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
  const proposal = repo.createProposal(chosen, instruction ?? "evolve program", result.raw, result.parsed);
  // A fresh recovery-week draft retires the prior one (same one-tap ask — the newest
  // read wins), so repeated taps never stack duplicate drafts in the Coach list.
  if (proposal?.id != null && String(instruction ?? "").startsWith(repo.RECOVERY_WEEK_INSTRUCTION_PREFIX)) {
    repo.supersedeRecoveryWeekDrafts(Number(proposal.id));
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

export function exerciseExplanationCacheKey(detail: any): string {
  return repo.fingerprint({
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
  const detail: any = repo.getExerciseDetail(name);
  if (!detail?.found) return { ok: false as const, found: false as const, exercise: name, error: "exercise not found" };
  const cacheKey = exerciseExplanationCacheKey(detail);
  const cached = repo.getAiCache(EXERCISE_EXPLANATION_KIND, cacheKey);
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
  const detail: any = repo.getExerciseDetail(name);
  if (!detail?.found) return { ok: false as const, found: false as const, exercise: name, error: "exercise not found" };
  const cacheKey = exerciseExplanationCacheKey(detail);
  const cached = repo.getAiCache(EXERCISE_EXPLANATION_KIND, cacheKey);
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
      timeoutMs: repo.interactiveTimeoutForOp(EXERCISE_EXPLANATION_KIND),
      signal: hooks?.signal,
      acceptParsed: isExerciseExplanationResult,
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
    repo.saveAiCache(EXERCISE_EXPLANATION_KIND, cacheKey, {
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
export async function weekAheadRead(agent: string | undefined, hooks?: OpHooks) {
  const floor = repo.weekAheadPlan();
  const floorResult = {
    ok: true as const,
    days: floor.days,
    summary: floor.summary,
    source: "deterministic" as const,
    cached: false as const,
  };
  const profile: any = repo.getProfile();
  const cacheKey = repo.fingerprint({
    op: WEEK_AHEAD_KIND,
    date: new Date().toISOString().slice(0, 10),
    plan: floor.days.map((d) => `${d.kind}:${d.label}`),
    goal: { gw: profile?.goal_weight_lb ?? null, gd: profile?.goal_date ?? null },
  });
  const cached = repo.getAiCache(WEEK_AHEAD_KIND, cacheKey);
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
      timeoutMs: repo.interactiveTimeoutForOp(WEEK_AHEAD_KIND),
      signal: hooks?.signal,
      acceptParsed: isWeekAheadResult,
      schema: WEEK_AHEAD_SCHEMA,
    });
    const sane = sanitizeWeekAhead(result.parsed);
    if (sane) {
      const out = { ok: true as const, ...sane, source: "agent" as const, cached: false as const, agent: chosen };
      try {
        repo.saveAiCache(WEEK_AHEAD_KIND, cacheKey, {
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

// Draft a goal-aware weekly meal plan, then run a bounded self-critique verify
// pass against the lean-safe / longevity floors before persisting. ok:false on a
// non-JSON result mirrors the other agentic ops. The persisted plan is the
// VERIFIED draft (a fix is adopted only when it re-validates); `verified` carries
// the "checked against your floors" signal. Verify fails open (no agent / garbage
// ⇒ the original draft is persisted unverified — exactly today's behavior).
export async function draftMealPlan(
  agent: string | undefined,
  instruction?: string,
  hooks?: OpHooks,
  opts: { coordinated_update?: boolean } = {}
) {
  hooks?.onPhase?.("drafting your week of meals");
  const prompt = buildMealPlanPrompt(instruction);
  // Accept the useful weekly shape into the optional verifier pass, then make
  // actual meal totals authoritative at the deterministic server boundary below.
  const planSane = (m: any) => isMealPlanStructureResult(m);
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "meal_plan",
      signal: hooks?.signal,
      acceptParsed: planSane,
      // Structure only. Nutritional ADEQUACY stays a server-side judgement
      // (validateMealPlanDraftForPersistence) — a schema must never look like it
      // authorized a plan the safety gate would reject.
      schema: MEAL_PLAN_STRUCTURE_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "agent returned no usable meal plan",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  // Defensive only: the shared fallback already enforces this same predicate.
  // Never persist an off-contract object as a meal plan.
  if (!planSane(p)) {
    return {
      ok: false as const,
      error: "agent returned no usable meal plan",
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Self-critique: check the plan against the lean-safe / longevity floors and
  // adopt a returned fix when it re-validates. Fail-open (verify down/garbage ⇒
  // the original draft is persisted, exactly today's behavior).
  hooks?.onPhase?.("checking it against your floors", { frac: { done: 1, total: 2 } });
  const { draft: verifiedParsed, verified } = await runVerify(
    agent,
    p,
    buildPlanVerifyPrompt,
    planSane,
    "meal_plan_verify",
    hooks
  );
  const safety = validateMealPlanDraftForPersistence(verifiedParsed, instruction);
  if (!safety.ok) {
    return {
      ok: false as const,
      error: safety.error,
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Defense in depth: createMealPlan repeats the same check for every non-agent
  // caller. No row exists yet, so a failure can never enter autonomy.
  const plan = repo.createMealPlan(chosen, result.raw, safety.parsed, { dietary_instruction: instruction });
  let autonomy: any = null;
  try {
    autonomy = applyMealPlanWithAutonomy(Number(plan.id), {
      requested_tier: "announce",
      coordinated_update: opts.coordinated_update === true,
    });
  } catch {
    // The durable, safety-clamped plan is still useful in review mode. Autonomy
    // bookkeeping is fail-soft and never discards an otherwise valid week.
    autonomy = null;
  }
  return {
    ok: true as const,
    plan: repo.getMealPlan(Number(plan.id)),
    autonomy,
    agent: chosen,
    tried,
    agent_status: "ok" as const,
    ...(verified ? { verified } : {}),
  };
}

// Quiet adaptive-nutrition check-in. Creates a nutrition_target proposal only on
// meaningful drift, then routes it through the server autonomy policy; change:false
// is the calm, common answer. ok:false is the
// designed failure signal. windowDays is passed verbatim to both the expenditure
// estimate (with a finite guard) and the prompt, mirroring the REST behavior.
export async function nutritionCheckin(
  agent: string | undefined,
  windowDays?: number,
  hooks?: OpHooks,
  opts: { initiated?: "user" | "auto" } = {}
) {
  hooks?.onPhase?.("reading your energy balance");
  const expenditure = repo.estimateExpenditure(Number.isFinite(windowDays as number) ? (windowDays as number) : 21);
  // The athlete's veto is respected for a bounded window on AUTOMATIC paths only
  // (scheduler cadence, brain signal boundaries): one "no" to a target change must
  // not be re-asked at the next weigh-in. A manual check-in (Energy Balance button,
  // REST, MCP) still runs because the athlete explicitly asked. Deliberately scoped
  // to nutrition_target — a discarded meal-plan draft must NOT suppress target
  // rechecks. Placed before every other branch so it always wins.
  if (opts.initiated === "auto" && repo.hasRecentDecisionVeto("nutrition_target", 5)) {
    return {
      ok: true as const,
      change: false as const,
      proposal: null,
      summary: "You recently passed on a similar nutrition change, so Cairn is holding the current target.",
      reason: "recent_veto" as const,
      expenditure,
    };
  }
  const outcomeReady = expenditure.confidence === "medium" || expenditure.confidence === "high";
  const protectiveEvidence = outcomeReady ? [] : protectiveFuelEvidence();
  if (!outcomeReady && !protectiveEvidence.length) {
    return {
      ok: true as const,
      change: false as const,
      proposal: null,
      summary: "The outcome trend is still settling, so Cairn is holding the current target.",
      reason: "insufficient_outcome_confidence" as const,
      expenditure,
    };
  }
  const prompt = buildNutritionCheckinPrompt(undefined, { windowDays });
  let run: FallbackResult;
  try {
    run = await runChosenStreaming(agent, prompt, {
      op: "nutrition_checkin",
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: isNutritionCheckinResult,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "agent returned no usable check-in",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
      expenditure,
    };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  if (!p || typeof p !== "object") {
    return { ok: false as const, error: "agent returned no usable check-in", agent: chosen, tried, expenditure };
  }
  // No meaningful drift → no proposal. The calm, common answer.
  if (!p.change || !p.nutrition || !Number.isFinite(Number(p.nutrition.target_kcal))) {
    return {
      ok: true as const,
      change: false,
      summary: typeof p.summary === "string" ? p.summary : "",
      agent: chosen,
      tried,
      expenditure,
    };
  }
  const nutrition = personalizeNutritionCheckinTarget(p.nutrition);
  // The protective low-confidence exception is raise-only. A model cannot turn
  // wearable/load/fatigue evidence into a deficit cut, and the delta is already
  // measured from the server-owned active target by the boundary above.
  if (!outcomeReady) {
    const previous = Number(nutrition?.prev_target_kcal);
    const target = Number(nutrition?.target_kcal);
    // A raise-only exception is meaningless with no established target to raise
    // from — Number(null) is 0 (finite), so prev_target_kcal must be checked
    // explicitly rather than relying on Number.isFinite alone.
    if (
      nutrition?.prev_target_kcal == null ||
      !Number.isFinite(previous) ||
      !Number.isFinite(target) ||
      target <= previous
    ) {
      return {
        ok: true as const,
        change: false as const,
        proposal: null,
        summary: "The trend is still settling. Recent training supports protecting fuel, not lowering the target.",
        reason: "protective_raise_only" as const,
        protective_evidence: protectiveEvidence,
        agent: chosen,
        tried,
        expenditure,
      };
    }
  }
  // Persist the target change, then route it through the shared autonomy policy.
  // Lead mode schedules it for the next un-lived food day with Undo; explicit
  // review posture keeps the same row as a reviewable draft.
  const proposal = repo.createProposal(chosen, "nutrition: adaptive check-in", result.raw, {
    kind: "nutrition_target",
    summary: typeof p.summary === "string" ? p.summary : "",
    nutrition,
    notes: typeof p.notes === "string" ? p.notes : "",
    expenditure,
  });
  // Outcome learning: record the proposed target + implied direction so a later
  // pass can check whether the bodyweight trend actually followed. Best-effort.
  const targetKcal = Number(nutrition.target_kcal);
  const tdee = Number((expenditure as any)?.tdee);
  // Local day so the date matches reconcileSuggestions' local "today" cutoff
  // (date < today) — a UTC stamp could record tomorrow's date in an evening
  // western zone and never reconcile on time.
  repo.recordSuggestion("nutrition_checkin", localDateISO(), {
    target_kcal: Number.isFinite(targetKcal) ? targetKcal : null,
    tdee: Number.isFinite(tdee) ? tdee : null,
    direction:
      Number.isFinite(targetKcal) && Number.isFinite(tdee)
        ? targetKcal < tdee
          ? "down"
          : targetKcal > tdee
            ? "up"
            : "hold"
        : null,
  });
  let autonomy: any = null;
  try {
    autonomy = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
  } catch {
    autonomy = null;
  }
  return {
    ok: true as const,
    change: true,
    proposal: repo.getProposal(Number(proposal.id)),
    autonomy,
    summary: typeof p.summary === "string" ? p.summary : "",
    agent: chosen,
    tried,
    expenditure,
    ...(protectiveEvidence.length ? { protective_evidence: protectiveEvidence } : {}),
  };
}

// Agentically swap ONE meal in a drafted plan, honoring an optional free-text
// hint. The caller must have already resolved the plan (404 on unknown id lives
// in the adapter); this runs the agent + validation + persistence. ok:false at
// the protocol layer's 200 is the designed failure signal.
export async function swapMealAgentic(
  agent: string | undefined,
  args: { plan: any; id: number; day: string; mealIndex: number; hint?: string },
  hooks?: OpHooks
) {
  hooks?.onPhase?.("finding a swap");
  const { plan, id, day, mealIndex, hint } = args;
  const prompt = buildMealSwapPrompt({ plan, day, mealIndex, hint });
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "meal_swap",
      signal: hooks?.signal,
      acceptParsed: isMealSwapResult,
      schema: MEAL_SWAP_SCHEMA,
    });
  } catch (error) {
    return { ok: false as const, error: "agent returned no usable meal", ...agentFailure(error, hooks) };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  const saneMeal =
    p && typeof p === "object" && typeof p.name === "string" && p.name.trim() && Number.isFinite(Number(p.kcal));
  if (!saneMeal) return { ok: false as const, error: "agent returned no usable meal", agent: chosen, tried };
  const swapped = repo.swapMealInPlan(id, day, mealIndex, p, { dietary_instruction: hint });
  if (!swapped) return { ok: false as const, error: "day or meal_index not found in plan", agent: chosen, tried };
  return { ok: true as const, plan: swapped.plan, meal: swapped.meal, agent: chosen, tried };
}

// Agentic recipe for ONE planned meal, cached on the meal inside parsed_json.
// The caller has already resolved the plan + checked for a cached recipe (the
// instant cached:true path lives in the adapter). ok:false at 200 is the
// designed failure signal.
export async function generateRecipe(
  agent: string | undefined,
  args: { plan: any; id: number; day: string; mealIndex: number },
  hooks?: OpHooks
) {
  hooks?.onPhase?.("writing the recipe");
  const { plan, id, day, mealIndex } = args;
  const livePlan = repo.getMealPlan(id);
  const safety = repo.validateMealPlanForPersistence(livePlan?.parsed);
  if (!safety.ok) {
    return { ok: false as const, error: safety.error, agent: null, tried: [] };
  }
  const prompt = buildRecipePrompt({ plan, day, mealIndex });
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "recipe",
      signal: hooks?.signal,
      acceptParsed: isRecipeResult,
    });
  } catch (error) {
    return { ok: false as const, error: "agent returned no usable recipe", ...agentFailure(error, hooks) };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  let saved: any = null;
  try {
    saved = p && typeof p === "object" ? repo.setMealRecipe(id, day, mealIndex, p) : null;
  } catch (error: any) {
    return { ok: false as const, error: error?.message ?? "meal plan is not safe to update", agent: chosen, tried };
  }
  if (!saved) return { ok: false as const, error: "agent returned no usable recipe", agent: chosen, tried };
  return { ok: true as const, recipe: saved.recipe, plan: saved.plan, agent: chosen, tried };
}

// Run a fresh whole-picture health review via the shared agent rotation.
// ok:false at 200 is the designed failure signal when addHealthReview rejects
// the shape (the agent returned garbage).
//
// GROUNDING (Stream 4): when settings.research_enabled is on, a host-side research
// pass first gathers cited evidence for the top off-optimal markers and the review
// prompt is asked to cite it; the agent-emitted citations are then VERIFIED inside
// addHealthReview → applyReviewDirectives (repo.verifyCitation). Research off / a
// research failure → ungrounded review, exactly today's behavior (never blocks).
export async function runHealthReview(agent: string | undefined, hooks?: OpHooks) {
  let grounding: { passages?: any[] } | undefined;
  if (researchEnabled()) {
    hooks?.onPhase?.("gathering the evidence");
    try {
      const passages = await gatherReviewGrounding(agent);
      if (passages.length) grounding = { passages };
    } catch {
      /* research failed → run ungrounded (graceful degrade) */
    }
  }
  hooks?.onPhase?.("reading your whole picture");
  const prompt = buildHealthReviewPrompt(grounding);
  let run: FallbackResult;
  try {
    // Depth-on-demand: the review is accuracy-critical and NOT streamed, so it routes
    // through the bounded coach-read loop. Same success criterion (isHealthReviewResult),
    // same signal, same default (300s) timeout envelope treated as the total deadline;
    // an agent that answers straight makes exactly one call as before.
    run = await runChosenWithCoachReads(agent, prompt, {
      op: "health_review",
      mode: "ordinary",
      signal: hooks?.signal,
      acceptParsed: isHealthReviewResult,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "agent returned no usable review",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
      grounded: !!grounding,
    };
  }
  const { agent: chosen, result, tried } = run;
  const review =
    result.parsed && typeof result.parsed === "object" ? repo.addHealthReview(result.parsed, chosen, result.raw) : null;
  if (!review) return { ok: false as const, error: "agent returned no usable review", agent: chosen, tried };
  return { ok: true as const, review, agent: chosen, tried, grounded: !!grounding };
}

// The elite-coach WHOLE-PICTURE synthesis (pull): reads the deterministic
// healthFocus tiering + full context and writes the prioritized, connected health
// story — the headline, the 2-3 priorities that matter most right now and how
// they relate, and the single highest-leverage move. Cached in app_state so the
// Health → Read view opens instantly; refreshed on demand / when the picture changes.
// Degrades calmly (no agent → keeps the last cached synthesis, never throws).
export async function synthesizeHealth(agent: string | undefined, hooks?: OpHooks) {
  hooks?.onPhase?.("reading your whole picture");
  const prompt = buildHealthSynthesisPrompt();
  let chosen: string | null = null;
  let result: any = null;
  let tried: { agent: string; error: string }[] = [];
  try {
    const run = await runChosenStreaming(agent, prompt, {
      op: "health_synthesis",
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      acceptParsed: isHealthSynthesisResult,
      boundedReads: true,
    });
    chosen = run.agent;
    result = run.result;
    tried = run.tried;
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      synthesis: repo.getHealthSynthesis(),
      focus: repo.healthFocus(),
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const synthesis = normalizeHealthSynthesis(result.parsed, { agent: chosen, generated_at: new Date().toISOString() });
  if (synthesis) {
    // Stamp the newest health-document date this synthesis was written against, so a
    // later doc upload can mark the cached synthesis STALE. The SAME helper feeds
    // propagation.getHealthSynthesisView's read, so the two can't drift.
    repo.saveHealthSynthesis({ ...synthesis, source_doc_at: repo.newestHealthDocDate() });
  }
  return {
    ok: !!synthesis,
    synthesis: synthesis ?? repo.getHealthSynthesis(),
    focus: repo.healthFocus(),
    agent: chosen,
    tried,
    agent_status: agentStatusFor({ ok: !!synthesis, agent: chosen, tried }),
  };
}

// Run ONE agentic pass over the whole picture for a single genuine cross-domain
// connection (or a weekly read), dedupe against what's already been said, and
// store it. ok:false is the designed failure signal — found:false, no text, a
// near-repeat, or an unusable shape. NO push notification ever fires.
export async function generateInsight(
  agent: string | undefined,
  kind?: string,
  hooks?: OpHooks,
  opts?: { freshForMs?: number }
) {
  const k = kind === "weekly_read" ? "weekly_read" : "connection";
  const recent = repo.recentInsightTexts(12);
  // Serve-stale-then-revalidate, keyed on a coarse time bucket + the set of
  // recently-said insight texts (so a new connection can't be masked by a stale
  // hit, and an identical same-window repeat returns instantly with no agent run).
  const cacheKind = k === "weekly_read" ? "weekly_read" : "insight";
  const cacheKey = insightCacheKey(k, recent);
  const cached = repo.getAiCache(cacheKind, cacheKey);
  if (cached && !cached.stale) {
    hooks?.onPhase?.("served from cache");
    return cached.result;
  }
  hooks?.onPhase?.(k === "weekly_read" ? "reading your week" : "looking for a connection");
  const prompt = k === "weekly_read" ? buildWeeklyReadPrompt() : buildInsightPrompt(undefined, recent);
  // Only the weekly read is reshaped to the streaming contract + wired for deltas; a
  // connection insight keeps the bare-JSON prompt and (with no onDelta) delegates
  // straight to the one-shot rotation — unchanged.
  let chosen: string | null = null;
  let result: any = null;
  let tried: { agent: string; error: string }[] = [];
  try {
    const run = await runChosenStreaming(agent, prompt, {
      op: k === "weekly_read" ? "weekly_read" : "insight",
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: isInsightResult,
    });
    chosen = run.agent;
    result = run.result;
    tried = run.tried;
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "no genuine new insight",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const p: any = result.parsed;
  const text = p && typeof p === "object" ? String(p.text ?? "").trim() : "";
  if (!p || typeof p !== "object" || p.found === false || !text || repo.isDuplicateInsight(text, recent)) {
    // Distinguish "no agent configured / every attempt failed" from a legitimate
    // quiet answer (the agent ran and genuinely found nothing new). When the agent
    // DID parse a result (p is an object), it succeeded — found:false is calm 'ok'.
    const status = p && typeof p === "object" ? ("ok" as const) : agentStatusFor({ ok: false, agent: chosen, tried });
    return { ok: false as const, error: "no genuine new insight", agent: chosen, tried, agent_status: status };
  }
  const insight = repo.addInsight({
    kind: k,
    text,
    rationale: p.rationale ?? null,
    next_step: p.next_step ?? null,
    status: "new",
  });
  // Stamp the weekly read's freshness signature so a later serve can tell when the
  // picture has moved past this read (pull-only staleness — see weeklyReadFreshness).
  if (k === "weekly_read" && (insight as any)?.id != null) {
    repo.stampWeeklyReadFreshness(Number((insight as any).id));
  }
  const out = { ok: true as const, insight, agent: chosen, tried, agent_status: "ok" as const };
  // Short freshness by default (a quiet insight should refresh within the hour);
  // the nightly scheduler passes a longer window so the morning open is a fresh hit.
  const freshForMs = Number.isFinite(opts?.freshForMs as number) ? (opts!.freshForMs as number) : 60 * 60 * 1000;
  try {
    repo.saveAiCache(cacheKind, cacheKey, {
      result: out,
      chosen_agent: chosen,
      ref_table: "insights",
      ref_id: (insight as any)?.id ?? null,
      freshForMs,
    });
  } catch {
    /* cache write never breaks the op */
  }
  return out;
}

// Fingerprint an insight pass: the kind + a coarse hour bucket + the recently-said
// insight texts (the dedup floor). A new said-set or a fresh hour busts it.
function insightCacheKey(kind: string, recent: string[]): string {
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return repo.fingerprint({ kind, hourBucket, recent: [...recent].map((t) => String(t).trim().toLowerCase()).sort() });
}

// ---------- chat distill (lifted from the inlined api.ts / mcp.ts reset paths) ----------
// Distill durable facts (preferences, constraints, decisions) from a chat history
// into memory via ONE agent call, then return the counts. The caller decides when
// to archive (the durable path archives FIRST, then distills in the background;
// the legacy inline path distilled then archived). Never throws — a dead agent
// yields distilled:0 with note:"agent unavailable". `history` is the pre-archive
// messages (so the worker can distill an already-archived conversation).
export async function distillChat(
  agent: string | undefined,
  history: { role: string; content: string }[],
  hooks?: OpHooks
): Promise<{ ok: true; distilled: number; farewell?: string; note?: string }> {
  if (!Array.isArray(history) || !history.length) return { ok: true as const, distilled: 0 };
  hooks?.onPhase?.("remembering what matters");
  let distilled = 0;
  let farewell: string | undefined;
  let note: string | undefined;
  try {
    const prompt = buildChatDistillPrompt(history.map((m) => ({ role: m.role, content: m.content })));
    const { result } = await runChosen(agent, prompt, { op: "chat_distill", signal: hooks?.signal });
    if (result.parsed) {
      distilled = repo.saveDistilledMemories(result.parsed);
      const f = (result.parsed as any).farewell;
      if (typeof f === "string" && f.trim()) farewell = f.trim().slice(0, 240);
    } else {
      note = "agent unavailable";
    }
  } catch (error) {
    if (hooks?.signal?.aborted) throw error;
    note = "agent unavailable";
  }
  return { ok: true as const, distilled, ...(farewell ? { farewell } : {}), ...(note ? { note } : {}) };
}

// Frictionless onboarding: ONE free-text intro → understood + applied, then onboarded.
// "Get me started and let me go." The deterministic base ALWAYS runs first (the
// athlete's words are never lost — about_me is saved, KB-recognized supplements are
// captured), then an agent enriches it (profile numbers, memories, injuries, the
// long-tail supplements). Fail-open: no agent → the deterministic base stands. Marks
// onboarded at the end regardless, so a flaky agent never traps the user on setup.
export async function onboardFromText(
  agent: string | undefined,
  text: string,
  hooks?: OpHooks
): Promise<{
  ok: true;
  source: "agent" | "deterministic" | "empty";
  applied: { about_me: boolean; profile: boolean; supplements: number; memories: number; context_events: number };
}> {
  const raw = String(text ?? "").trim();
  const applied = { about_me: false, profile: false, supplements: 0, memories: 0, context_events: 0 };
  if (!raw) {
    try {
      repo.setSettings({ onboarded: true });
    } catch {}
    return { ok: true as const, source: "empty", applied };
  }

  // Deterministic base — never lose what they said.
  try {
    repo.setProfile({ about_me: raw.slice(0, 8000) });
    applied.about_me = true;
  } catch {}
  try {
    applied.supplements = repo.understandSupplements(raw, { strict: true }).length;
  } catch {}

  let source: "agent" | "deterministic" = "deterministic";
  try {
    hooks?.onPhase?.("getting to know you");
    const { result } = await runChosen(agent, buildOnboardPrompt(raw), {
      op: "onboard",
      timeoutMs: repo.interactiveTimeoutForOp("onboard"),
      signal: hooks?.signal,
    });
    const p: any = result.parsed;
    if (p && typeof p === "object") {
      source = "agent";
      if (typeof p.about_me === "string" && p.about_me.trim()) {
        try {
          repo.setProfile({ about_me: p.about_me.trim().slice(0, 8000) });
          applied.about_me = true;
        } catch {}
      }
      const pr = p.profile && typeof p.profile === "object" ? p.profile : {};
      const patch: any = {};
      for (const k of ["sex", "age", "height_cm", "weight_lb", "goal_weight_lb", "goal_date"])
        if (pr[k] != null && pr[k] !== "") patch[k] = pr[k];
      if (Object.keys(patch).length) {
        try {
          repo.setProfile(patch);
          applied.profile = true;
        } catch {}
      }
      if (Array.isArray(p.supplements) && p.supplements.length) {
        let n = 0;
        for (const it of p.supplements) {
          if (it?.name) {
            try {
              repo.addSupplement(it);
              n++;
            } catch {}
          }
        }
        if (n) applied.supplements = n; // the agent's structured set supersedes the deterministic count
      }
      if (Array.isArray(p.memories))
        for (const m of p.memories) {
          if (m?.content) {
            try {
              repo.addMemory(String(m.content), m.kind, "onboard");
              applied.memories++;
            } catch {}
          }
        }
      if (Array.isArray(p.context_events))
        for (const ev of p.context_events) {
          if (ev?.title || ev?.kind) {
            try {
              repo.addContextEvent({
                kind: ev.kind,
                title: ev.title,
                detail: ev.detail,
                start_date: ev.start_date,
                end_date: ev.end_date,
                meta: ev.meta,
              });
              applied.context_events++;
            } catch {}
          }
        }
      // days_per_week stays a soft signal (remembered), not an auto plan rewrite —
      // the seeded plan is already there; the athlete adjusts it when they want to.
      if (pr.days_per_week != null && Number(pr.days_per_week) > 0) {
        try {
          repo.addMemory(`Trains about ${Number(pr.days_per_week)} days/week`, "preference", "onboard");
          applied.memories++;
        } catch {}
      }
    }
  } catch (error) {
    if (hooks?.signal?.aborted) throw error;
    // Fail-open: the deterministic base already applied.
  }

  try {
    repo.setSettings({ onboarded: true });
  } catch {}
  return { ok: true as const, source, applied };
}

// Host-side research for the optional POST /api/research + MCP `research` tool.
// Runs a cited, web-grounded evidence pass and returns the cached rows. Gated by
// settings.research_enabled — when off it serves only what's already cached and
// reports ok:false (never reaches the network). INFORMATIONAL, not medical advice.
export async function runResearch(
  question: string,
  opts: { markers?: string[]; agent?: string; force?: boolean } = {}
) {
  return researchEvidence(String(question ?? ""), opts.markers ?? [], { agent: opts.agent, force: opts.force });
}

// ---------- self-updating memory ops (Stream 2) ----------

// Quiet memory consolidation: ask an agent to propose merges / supersessions /
// promotions over the live store, then apply them through the repo functions
// (which MARK, never hard-delete). Calm by default — an empty result is a clean
// no-op. Scheduled nightly; also callable on demand. NEVER notifies.
export async function consolidateMemory(agent: string | undefined) {
  const prompt = buildMemoryConsolidationPrompt();
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt);
  } catch (error) {
    return { ok: false as const, error: "agent returned no usable plan", ...agentFailure(error) };
  }
  const { agent: chosen, result, tried } = run;
  const p: any = result.parsed;
  if (!p || typeof p !== "object")
    return { ok: false as const, error: "agent returned no usable plan", agent: chosen, tried };

  const idSet = new Set((repo.listMemory(200, { includeSuperseded: true }) as any[]).map((m: any) => Number(m.id)));
  let merged = 0,
    superseded = 0,
    promoted = 0;

  // MERGES: fold every other id into the first, with one combined sentence.
  for (const m of Array.isArray(p.merges) ? p.merges : []) {
    const ids = (Array.isArray(m?.ids) ? m.ids : []).map(Number).filter((n: number) => idSet.has(n));
    if (ids.length < 2 || !m?.content) continue;
    const [keep, ...rest] = ids;
    try {
      repo.updateMemory(keep, { content: String(m.content), kind: m.kind });
      for (const dup of rest) {
        repo.supersedeMemory(dup, { replacementId: keep, reason: "merged duplicate" });
        merged++;
      }
    } catch {
      /* skip a bad row, keep going */
    }
  }
  // SUPERSEDES: a later fact contradicts an older one.
  for (const s of Array.isArray(p.supersedes) ? p.supersedes : []) {
    const id = Number(s?.id);
    if (!idSet.has(id)) continue;
    try {
      repo.supersedeMemory(id, { content: s?.replacement, reason: s?.reason || "superseded" });
      superseded++;
    } catch {}
  }
  // PROMOTIONS: a recurring observation has become a stable trait.
  for (const pr of Array.isArray(p.promotions) ? p.promotions : []) {
    const id = Number(pr?.id);
    if (!idSet.has(id) || !pr?.kind) continue;
    try {
      repo.updateMemory(id, { content: pr?.content, kind: String(pr.kind) });
      promoted++;
    } catch {}
  }
  return { ok: true as const, merged, superseded, promoted, agent: chosen, tried };
}

// Grow profile.about_me into a coherent person-model from typed memory + family +
// check-ins. AUGMENTS, never overwrites blindly — the prompt preserves existing
// (user-authored) content, and we only write when the agent reports a real change.
export async function growAboutMe(agent: string | undefined) {
  const prompt = buildAboutMeGrowthPrompt();
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt);
  } catch (error) {
    return {
      ok: false as const,
      changed: false as const,
      error: "agent returned no usable profile growth",
      ...agentFailure(error),
    };
  }
  const { agent: chosen, result, tried } = run;
  const p: any = result.parsed;
  const text = p && typeof p === "object" ? String(p.about_me ?? "").trim() : "";
  if (!p || typeof p !== "object" || p.changed === false || !text) {
    return { ok: true as const, changed: false, agent: chosen, tried };
  }
  const before = String((repo.getProfile() || {}).about_me ?? "").trim();
  if (text === before) return { ok: true as const, changed: false, agent: chosen, tried };
  const profile = repo.setProfile({ about_me: text });
  return { ok: true as const, changed: true, profile, agent: chosen, tried };
}

// Write the plain-language NARRATIVE over the DETERMINISTIC reaction-model patterns
// — the warm "how your body responds" read that reactionModelForCoach() / GET
// /api/reaction-model / the coach context surface (the slot was dangling: nothing
// wrote it). Reads the cached model via the repo; with ZERO patterns there's nothing
// to narrate, so it SKIPS the agent entirely (a cheap, calm no-op that never touches
// an existing narrative). Otherwise ONE agent turn writes 2-3 grounded sentences,
// validated to a non-empty string and clamped before persist. Fail-open: no agent /
// a wrong-shape reply / any throw is a no-op; deterministic rebuilds already clear
// prose tied to the prior evidence set.
// The `run` dep is injectable so tests can drive the success path offline without a
// CLI; production callers (the nightly scheduler) omit it and get the real rotation.
export async function refreshReactionNarrative(
  agent: string | undefined,
  hooks?: OpHooks,
  deps?: { run?: typeof runChosen }
) {
  const run = deps?.run ?? runChosen;
  const model = repo.reactionModelForCoach();
  const patterns = Array.isArray(model?.patterns) ? model.patterns : [];
  // No patterns → nothing to say. Skip the agent call; saveReactionModel already
  // cleared prose tied to the prior evidence set.
  if (!patterns.length) return { ok: true as const, skipped: true as const };
  hooks?.onPhase?.("summarizing how your body responds");
  try {
    const prompt = buildReactionNarrativePrompt(patterns);
    const {
      agent: chosen,
      result,
      tried,
    } = await run(agent, prompt, {
      op: "reaction_narrative",
      signal: hooks?.signal,
      acceptParsed: isReactionNarrativeResult,
    });
    const p: any = result?.parsed;
    const text = p && typeof p === "object" ? String(p.narrative ?? "").trim() : "";
    if (!text) {
      // Wrong-shape / empty reply → keep the prior narrative untouched.
      return {
        ok: false as const,
        error: "agent returned no usable narrative",
        agent: chosen,
        tried,
        agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
      };
    }
    repo.setReactionNarrative(text);
    return { ok: true as const, narrative: text.slice(0, 600), agent: chosen, tried, agent_status: "ok" as const };
  } catch (error) {
    // Any failure degrades to a no-op; the existing narrative stands.
    return { ok: false as const, error: "agent returned no usable narrative", ...agentFailure(error, hooks) };
  }
}

// Reconcile passed suggestions to actuals and write durable learnings. Pure repo
// math — no agent needed (calm, deterministic). Returns the counts.
export function reconcileOutcomes(opts?: { maxPerPass?: number }) {
  const r = repo.reconcileSuggestions(opts);
  return { ok: true as const, ...r };
}

// ---------- agentic marker reconciliation ----------
// Learn the harder analyte synonyms a lab introduces (the clinical-judgment layer
// over the deterministic canonicalizer — see buildMarkerReconcilePrompt). The
// agent clusters same-analyte names; we persist each member→canonical decision in
// marker_aliases (source 'agent'), so getMarkerHistory merges their series and
// exposes the canonical display label from then on. SAFETY: persist ONLY genuine
// merges (a group with ≥2 distinct keys), every member must be a verbatim input
// name, and members whose units are clearly incompatible are rejected (the agent
// shouldn't merge across dimensions; this is the belt-and-suspenders guard).
// Fail-open: no agent / bad shape → nothing persisted, the deterministic floor
// still stands.
export async function reconcileMarkers(agent?: string, hooks?: OpHooks) {
  const items = repo.distinctMarkerNames();
  if (items.length < 2) return { ok: true as const, aligned: 0, applied: 0, candidates: items.length };
  hooks?.onPhase?.("aligning lab names");
  const prompt = buildMarkerReconcilePrompt(
    items.map((i) => ({ name: i.name, unit: i.unit, sample: i.sample, canonical: i.canonical }))
  );
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "marker_reconcile",
      signal: hooks?.signal,
      acceptParsed: isReconciliationResult,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "no usable reconciliation",
      candidates: items.length,
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
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Validate the agent's groups into concrete alias rows (pure guards: verbatim
  // members, ≥2 members, unit-compatible, real merge) and persist each one.
  const merges = repo.planMarkerMerges(
    items.map((i) => ({ name: i.name, unit: i.unit })),
    p.groups
  );
  for (const m of merges) repo.setMarkerAlias(m.rawNorm, m.canonicalKey, m.canonicalName, "agent");
  // Realigned analyte series shift the connected-brain read → bust today's cached
  // Brief HERE so BOTH surfaces (REST /markers/reconcile, MCP reconcile_markers) stay
  // consistent, instead of only the REST route remembering to.
  if (merges.length) {
    try {
      repo.invalidateDayRead();
    } catch {
      /* best-effort */
    }
  }
  const aligned = new Set(merges.map((m) => m.canonicalKey)).size;
  return {
    ok: true as const,
    aligned,
    applied: merges.length,
    candidates: items.length,
    agent: chosen,
    tried,
    agent_status: "ok" as const,
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
  let items = repo.distinctExerciseNames();
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
    const key = repo.normalizedExerciseKey(it.name);
    if (!key) continue;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(it);
    else clusters.set(key, [it]);
  }
  const cleaner = (a: string, b: string): number => {
    const ca = repo.cleanExerciseName(a) === a ? 0 : 1;
    const cb = repo.cleanExerciseName(b) === b ? 0 : 1;
    return ca - cb || a.length - b.length || a.localeCompare(b);
  };
  for (const bucket of clusters.values()) {
    const distinct = [...new Map(bucket.map((m) => [m.name, m])).values()];
    if (distinct.length < 2) continue;
    distinct.sort((a, b) => b.days - a.days || cleaner(a.name, b.name));
    const into = distinct[0].name;
    for (const m of distinct.slice(1)) {
      const res = repo.mergeExercises(m.name, into);
      if (res.ok) {
        merged.push({ from: m.name, into });
        mergedFrom.add(repo.normalizeExerciseName(m.name));
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
  for (const ex of repo.listExercises()) {
    const auth = repo.authoritativeGroup(ex.name);
    if (!auth) continue;
    const cur = repo.canonicalGroup(ex.muscle_group ?? null);
    if (cur === auth) continue;
    if (cur == null || overrideGroups) {
      // cur == null means the stored group is empty/"other"/unknown (fill), else it's a
      // recognized-but-wrong group we only touch under an explicit override.
      try {
        repo.updateExercise(Number(ex.id), { muscle_group: auth });
        groups_fixed++;
      } catch {
        /* skip a bad row, keep going */
      }
    }
  }

  // Re-read after the deterministic merges/corrections so the agent sees the tidied
  // list (no folded-away ghost names, corrected groups).
  items = repo.distinctExerciseNames();
  const prompt = buildExerciseReconcilePrompt(items);

  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "exercise_reconcile",
      signal: hooks?.signal,
      acceptParsed: isReconciliationResult,
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
  const aliases = repo.planExerciseAliases(
    items.map((i) => ({ name: i.name })),
    p.groups
  );
  for (const a of aliases) repo.setExerciseAlias(a.rawNorm, a.canonical, "agent");

  // Conservatively IMPROVE a canonical movement's muscle group only when it's
  // currently null/"other" AND the agent supplied a confident group for the cluster.
  // Never overwrite a good group; never throw on a bad row.
  const validGroups = (() => {
    try {
      return new Set<string>([...repo.MUSCLE_GROUPS]);
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
      const ex: any = repo.findExercise(canonical);
      const cur = String(ex?.muscle_group ?? "")
        .trim()
        .toLowerCase();
      if (ex && (!cur || cur === "other") && cur !== suggestedGroup) {
        repo.updateExercise(Number(ex.id), { muscle_group: suggestedGroup });
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
  for (const it of items) daysByNorm.set(repo.normalizeExerciseName(it.name), it.days);
  const seenPair = new Set<string>();
  for (const m of Array.isArray(p.merges) ? p.merges : []) {
    const from = String(m?.from ?? "").trim();
    const into = String(m?.into ?? "").trim();
    const confidence = String(m?.confidence ?? "").toLowerCase();
    const fromNorm = repo.normalizeExerciseName(from);
    const intoNorm = repo.normalizeExerciseName(into);
    if (!fromNorm || !intoNorm || fromNorm === intoNorm) continue;
    if (mergedFrom.has(fromNorm)) continue; // already folded deterministically
    const pairKey = `${fromNorm}=>${intoNorm}`;
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);
    const fromRow: any = repo.findExercise(from);
    const intoRow: any = repo.findExercise(into);
    if (!fromRow || !intoRow) {
      skipped.push({ from, into, reason: "exercise not found" });
      continue;
    }
    const verdict = repo.validateExerciseMergePlan(
      { name: fromRow.name, group: fromRow.muscle_group, mode: fromRow.mode, days: daysByNorm.get(fromNorm) ?? 0 },
      { name: intoRow.name, group: intoRow.muscle_group, mode: intoRow.mode, days: daysByNorm.get(intoNorm) ?? 0 }
    );
    if (!verdict.ok) {
      skipped.push({ from, into, reason: verdict.reason ?? "rejected" });
      continue;
    }
    if (repo.shouldAutoApplyMerge(verdict, confidence)) {
      const res = repo.mergeExercises(fromRow.name, intoRow.name);
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
