// Health coaching ops: the agentic health review, the health synthesis, the
// deterministic outcome reconciliation and agentic lab-marker reconciliation.
// Split out of the former single-file src/coachOps.ts — behavior-preserving.

import { invalidateDayRead } from "../repo/day-read-cache.js";
import { addHealthReview, newestHealthDocDate } from "../repo/health.js";
import { getHealthSynthesis, healthFocus, saveHealthSynthesis } from "../repo/health-focus.js";
import { distinctMarkerNames, planMarkerMerges, setMarkerAlias } from "../repo/marker-canon.js";
import { reconcileSuggestions } from "../repo/memory.js";
import type { FallbackResult } from "../agents.js";
import { resolveOrder, runChosen, runChosenStreaming, runChosenWithCoachReads } from "../runChosen.js";
import { buildHealthReviewPrompt, buildHealthSynthesisPrompt, buildMarkerReconcilePrompt, buildImagingTwinPrompt } from "../prompt.js";
import { researchEnabled, gatherReviewGrounding } from "../research.js";
import { normalizeHealthSynthesis } from "../health-synthesis.js";
import { HEALTH_REVIEW_SCHEMA, HEALTH_SYNTHESIS_SCHEMA, IMAGING_TWIN_JUDGE_SCHEMA, MARKER_RECONCILE_SCHEMA, isHealthReviewResult, isHealthSynthesisResult, isImagingTwinVerdict, isReconciliationResult } from "../agent-contracts.js";
import { isAgentBusyError } from "../agent-busy.js";
import { dedupeHealthDocuments } from "../repo/health-dedupe.js";
import type { DedupeHealthDocumentsResult } from "../repo/health-dedupe.js";
import {
  dedupeImagingStudies,
  foldJudgedImagingTwins,
  imagingJudgeCandidates,
  imagingJudgeView,
  recordImagingDedupeJudgment,
} from "../repo/imaging-dedupe.js";
import { deriveDirectives } from "../repo/propagation.js";
import { log } from "../log.js";
import { agentFailure, agentStatusFor } from "./shared.js";
import type { OpHooks } from "./shared.js";

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
      schema: HEALTH_REVIEW_SCHEMA,
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
    result.parsed && typeof result.parsed === "object" ? addHealthReview(result.parsed, chosen, result.raw) : null;
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
      schema: HEALTH_SYNTHESIS_SCHEMA,
    });
    chosen = run.agent;
    result = run.result;
    tried = run.tried;
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      synthesis: getHealthSynthesis(),
      focus: healthFocus(),
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const synthesis = normalizeHealthSynthesis(result.parsed, { agent: chosen, generated_at: new Date().toISOString() });
  if (synthesis) {
    // Stamp the newest health-document date this synthesis was written against, so a
    // later doc upload can mark the cached synthesis STALE. The SAME helper feeds
    // propagation.getHealthSynthesisView's read, so the two can't drift.
    saveHealthSynthesis({ ...synthesis, source_doc_at: newestHealthDocDate() });
  }
  return {
    ok: !!synthesis,
    synthesis: synthesis ?? getHealthSynthesis(),
    focus: healthFocus(),
    agent: chosen,
    tried,
    agent_status: agentStatusFor({ ok: !!synthesis, agent: chosen, tried }),
  };
}

// Reconcile passed suggestions to actuals and write durable learnings. Pure repo
// math — no agent needed (calm, deterministic). Returns the counts.
export function reconcileOutcomes(opts?: { maxPerPass?: number }) {
  const r = reconcileSuggestions(opts);
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
  const items = distinctMarkerNames();
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
      schema: MARKER_RECONCILE_SCHEMA,
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
  const merges = planMarkerMerges(
    items.map((i) => ({ name: i.name, unit: i.unit })),
    p.groups
  );
  for (const m of merges) setMarkerAlias(m.rawNorm, m.canonicalKey, m.canonicalName, "agent");
  // Realigned analyte series shift the connected-brain read → bust today's cached
  // Brief HERE so BOTH surfaces (REST /markers/reconcile, MCP reconcile_markers) stay
  // consistent, instead of only the REST route remembering to.
  if (merges.length) {
    try {
      invalidateDayRead();
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

// ---------- imaging near-twins: the agent's judgement ----------

export const IMAGING_TWIN_JUDGE_OP = "imaging_twin_judge";
// One pass asks about at most this many pairs; the rest wait for the next pass.
const MAX_JUDGED_PAIRS_PER_PASS = 8;

export interface ImagingJudgeOptions {
  // Only pairs touching this study, or the studies derived from this upload.
  scopeId?: number | null;
  hooks?: OpHooks;
  maxPairs?: number;
  // Test seam: the dispatch, defaulting to runChosen.
  run?: typeof runChosen;
}

export interface ImagingJudgeOutcome {
  candidates: number;
  asked: number;
  judged: number;
  agent: string | null;
  skipped: "no_candidates" | "no_agent" | null;
}

/**
 * Ask an agent about every unjudged pair of imaging near-twins (same day, modality,
 * system and region, sides not contradicting, that the strict rule left apart), and
 * remember each verdict on the newer study so a pair is never asked twice. Folds
 * nothing itself. No usable agent (or only the offline stub) judges nothing; an
 * agent that fails leaves the pair unjudged; host congestion (AgentBusyError) is
 * rethrown untouched so the runner defers and retries.
 */
export async function judgeImagingTwins(agent: string | undefined, opts: ImagingJudgeOptions = {}): Promise<ImagingJudgeOutcome> {
  const candidates = imagingJudgeCandidates({ scopeId: opts.scopeId ?? null });
  const out: ImagingJudgeOutcome = { candidates: candidates.length, asked: 0, judged: 0, agent: null, skipped: null };
  if (!candidates.length) return { ...out, skipped: "no_candidates" };
  const run = opts.run ?? runChosen;
  if (!opts.run && !resolveOrder(agent, IMAGING_TWIN_JUDGE_OP).some((name) => name !== "stub")) {
    return { ...out, skipped: "no_agent" };
  }
  for (const pair of candidates.slice(0, opts.maxPairs ?? MAX_JUDGED_PAIRS_PER_PASS)) {
    if (opts.hooks?.signal?.aborted) break;
    const older = imagingJudgeView(pair.older.id);
    const newer = imagingJudgeView(pair.newer.id);
    if (!older || !newer) continue;
    opts.hooks?.onPhase?.("comparing two imaging reports");
    out.asked++;
    let parsed: any = null;
    try {
      const result = await run(agent, buildImagingTwinPrompt(older, newer), {
        op: IMAGING_TWIN_JUDGE_OP,
        signal: opts.hooks?.signal,
        schema: IMAGING_TWIN_JUDGE_SCHEMA,
        acceptParsed: isImagingTwinVerdict,
      });
      out.agent = result?.agent ?? out.agent;
      parsed = result?.result?.parsed ?? null;
    } catch (error) {
      if (isAgentBusyError(error)) throw error;
      if (opts.hooks?.signal?.aborted) throw error;
      // Every agent failed: no verdict, so the pair stays unjudged and is asked
      // again next time. The rest of this pass would only fail the same way.
      log.warn(`[dedupe] imaging pair ${pair.older.id}/${pair.newer.id}: no verdict (${(error as any)?.message ?? error}).`);
      break;
    }
    if (out.agent === "stub" || !isImagingTwinVerdict(parsed)) continue;
    if (
      recordImagingDedupeJudgment(pair.older.id, pair.newer.id, {
        same_study: parsed.same_study,
        confidence: parsed.confidence,
        reason: parsed.reason,
      })
    ) {
      out.judged++;
    }
  }
  return out;
}

/**
 * After an imaging ingest (the enrichment queue's `imaging_dedupe` job, once that
 * ingest has finished): fold the strict twins of what `id` created, ask about its
 * near-twins, and fold the ones judged the same study at high confidence with no
 * measurement disagreeing. AgentBusyError propagates so the queue defers the job.
 */
export async function settleImagingTwins(
  id: number,
  opts: Omit<ImagingJudgeOptions, "scopeId"> & { ask?: boolean } = {}
) {
  const strict = dedupeImagingStudies({ scopeSourceId: id });
  const judgement =
    opts.ask === false
      ? null
      : await judgeImagingTwins(undefined, { ...opts, scopeId: id });
  const judged = foldJudgedImagingTwins({ scopeId: id });
  const merged = strict.merged + judged.merged;
  if (merged) {
    log.info(`[dedupe] imaging#${id}: folded ${merged} duplicate stud${merged === 1 ? "y" : "ies"}.`);
    try {
      deriveDirectives();
    } catch {
      /* the fold is done; the connected brain settles on its next pass */
    }
  }
  return { merged, judgement, errors: [...strict.errors, ...judged.errors] };
}

/**
 * The Records screen's "Check for duplicates": ask an agent about every unjudged
 * imaging near-twin, then plan the whole-record fold as a DRY RUN (deterministic
 * rules plus the verdicts just remembered). Nothing is folded here; the person
 * applies the plan with POST /api/health-docs/dedupe {apply:true}, which reaches
 * the same end state from the same verdicts without asking again.
 */
export async function checkHealthDuplicates(
  agent: string | undefined,
  hooks?: OpHooks,
  opts: Pick<ImagingJudgeOptions, "run" | "maxPairs"> = {}
): Promise<DedupeHealthDocumentsResult & { ok: true; judgement: ImagingJudgeOutcome; agent: string | null }> {
  hooks?.onPhase?.("looking for duplicates");
  const judgement = await judgeImagingTwins(agent, { hooks, ...opts, maxPairs: opts.maxPairs ?? 20 });
  const plan = dedupeHealthDocuments({ dryRun: true });
  return { ok: true as const, ...plan, judgement, agent: judgement.agent };
}
