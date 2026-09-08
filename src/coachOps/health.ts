// Health coaching ops: the agentic health review, the health synthesis, the
// deterministic outcome reconciliation and agentic lab-marker reconciliation.
// Split out of the former single-file src/coachOps.ts — behavior-preserving.

import { invalidateDayRead } from "../repo/day-read-cache.js";
import { addHealthReview, newestHealthDocDate } from "../repo/health.js";
import { getHealthSynthesis, healthFocus, saveHealthSynthesis } from "../repo/health-focus.js";
import { distinctMarkerNames, planMarkerMerges, setMarkerAlias } from "../repo/marker-canon.js";
import { reconcileSuggestions } from "../repo/memory.js";
import type { FallbackResult } from "../agents.js";
import { runChosen, runChosenStreaming, runChosenWithCoachReads } from "../runChosen.js";
import { buildHealthReviewPrompt, buildHealthSynthesisPrompt, buildMarkerReconcilePrompt } from "../prompt.js";
import { researchEnabled, gatherReviewGrounding } from "../research.js";
import { normalizeHealthSynthesis } from "../health-synthesis.js";
import { HEALTH_REVIEW_SCHEMA, HEALTH_SYNTHESIS_SCHEMA, MARKER_RECONCILE_SCHEMA, isHealthReviewResult, isHealthSynthesisResult, isReconciliationResult } from "../agent-contracts.js";
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
