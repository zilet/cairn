// The learning ops: cross-domain insight generation, chat distill, onboarding
// from free text, the grounded research pass, and the self-updating memory
// layer (consolidation, about-me growth, reaction narrative).
// Split out of the former single-file src/coachOps.ts — behavior-preserving.

import { fingerprint, getAiCache, saveAiCache, saveDistilledMemories } from "../repo/chat.js";
import { addContextEvent } from "../repo/health.js";
import { insightIntentCorpus, isDuplicateInsightIntent, resolveInsightIntent } from "../repo/insight-intent.js";
import { addInsight, isDuplicateInsight, recentInsightTexts, stampWeeklyReadFreshness, upvotedInsightTexts } from "../repo/insights.js";
import { addMemory, listMemory, supersedeMemory, updateMemory } from "../repo/memory.js";
import { getProfile, setProfile } from "../repo/profile.js";
import { movementConsiderationsRead } from "../repo/movement-considerations.js";
import { reactionModelForCoach, setReactionNarrative } from "../repo/reaction-model.js";
import { interactiveTimeoutForOp, setSettings } from "../repo/settings.js";
import { addSupplement, understandSupplements } from "../repo/supplements.js";
import type { FallbackResult } from "../agents.js";
import { runChosen, runChosenStreaming } from "../runChosen.js";
import { buildInsightPrompt, buildWeeklyReadPrompt, buildMemoryConsolidationPrompt, buildAboutMeGrowthPrompt, buildChatDistillPrompt, buildOnboardPrompt, buildReactionNarrativePrompt } from "../prompt.js";
import { researchEvidence } from "../research.js";
import { INSIGHT_SCHEMA, ABOUT_ME_GROWTH_SCHEMA, CHAT_DISTILL_SCHEMA, MEMORY_CONSOLIDATION_SCHEMA, ONBOARD_SCHEMA, REACTION_NARRATIVE_SCHEMA, isInsightResult, isReactionNarrativeResult, isChatDistillResult, isMemoryConsolidationResult } from "../agent-contracts.js";
import { log } from "../log.js";
import { agentFailure, agentStatusFor } from "./shared.js";
import type { OpHooks } from "./shared.js";

export type InsightVerdict =
  | { accept: true; text: string; key: string | null }
  // `agent_ran` is the difference between "the agent answered and had nothing" and
  // "no agent answered at all" — the caller turns it into agent_status.
  | { accept: false; agent_ran: boolean };

// The acceptance ladder for a parsed insight, extracted so it can be tested without
// spawning a CLI (no offline e2e exists for this op — the stub agent emits proposal
// JSON that isInsightResult rejects before it ever reaches here). Every rejection is
// the SAME calm silence; an insight that doesn't clear the ladder is not an error the
// athlete ever sees.
//
//   1. the agent named a VALID connection -> dedupe on its key: territory, not words.
//      A valid key that COLLIDES with covered territory is still a rejection: that is
//      the whole point of the key layer.
//   2. it named an INVALID one (unknown facet, same domain, malformed) -> fall through
//      to rung 3 exactly as if it had named none. Silence was the original design here,
//      and preserving the insight won: a vocabulary miss in one optional field must not
//      cost a genuine connection, and corpus safety is identical either way — the
//      invalid key is discarded, never stored, so nothing downstream can be poisoned.
//   3. it named none -> derive the key from the text; ambiguous derivation falls back
//      to the text-only guard with a NULL key (the pre-key status quo, no regression)
//
// The text guard runs regardless, as a second net. `weekly_read` is exempt from the
// key layer entirely: it legitimately recurs on the same territory every week.
export function insightVerdict(opts: {
  parsed: unknown;
  kind: string;
  keyCorpus: string[];
  recentTexts: string[];
}): InsightVerdict {
  const p: any = opts.parsed;
  if (!p || typeof p !== "object") return { accept: false, agent_ran: false };
  const text = String(p.text ?? "").trim();
  if (p.found === false || !text) return { accept: false, agent_ran: true };
  const keyed = opts.kind === "connection";
  const named = keyed
    ? resolveInsightIntent(p.connection, text, p.rationale)
    : ({ status: "unkeyed", key: null } as const);
  // An unusable `connection` is treated as no connection at all: drop it and derive.
  const intent = named.status === "invalid" ? resolveInsightIntent(undefined, text, p.rationale) : named;
  if (intent.status === "keyed" && isDuplicateInsightIntent(intent.key, opts.keyCorpus)) {
    return { accept: false, agent_ran: true };
  }
  if (isDuplicateInsight(text, opts.recentTexts)) return { accept: false, agent_ran: true };
  return { accept: true, text, key: intent.key };
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
  const recent = recentInsightTexts(12);
  // The territory already covered (facet-pair keys) + the residue of rows whose
  // territory couldn't be derived. Only the connection pass is keyed — a weekly read
  // legitimately recurs on the same territory every week.
  const corpus = k === "connection" ? insightIntentCorpus() : { keys: [], unkeyedTexts: [] };
  // Serve-stale-then-revalidate, keyed on a coarse time bucket + the set of
  // recently-said insight texts AND the covered-territory keys, so cache identity and
  // guard identity are the same model (a new connection can't be masked by a stale
  // hit, and an identical same-window repeat returns instantly with no agent run).
  const cacheKind = k === "weekly_read" ? "weekly_read" : "insight";
  const cacheKey = insightCacheKey(k, recent, corpus.keys);
  const cached = getAiCache(cacheKind, cacheKey);
  if (cached && !cached.stale) {
    hooks?.onPhase?.("served from cache");
    return cached.result;
  }
  hooks?.onPhase?.(k === "weekly_read" ? "reading your week" : "looking for a connection");
  const prompt =
    k === "weekly_read"
      ? buildWeeklyReadPrompt()
      : buildInsightPrompt(undefined, corpus.unkeyedTexts, upvotedInsightTexts(), corpus.keys);
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
      schema: INSIGHT_SCHEMA,
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
  const verdict = insightVerdict({ parsed: p, kind: k, keyCorpus: corpus.keys, recentTexts: recent });
  if (!verdict.accept) {
    // Distinguish "no agent configured / every attempt failed" from a legitimate
    // quiet answer (the agent ran and genuinely found nothing new). When the agent
    // DID parse a result, it succeeded — found:false is calm 'ok'.
    const status = verdict.agent_ran ? ("ok" as const) : agentStatusFor({ ok: false, agent: chosen, tried });
    return { ok: false as const, error: "no genuine new insight", agent: chosen, tried, agent_status: status };
  }
  const insight = addInsight({
    kind: k,
    text: verdict.text,
    rationale: p.rationale ?? null,
    next_step: p.next_step ?? null,
    status: "new",
    intent_key: verdict.key,
  });
  // Stamp the weekly read's freshness signature so a later serve can tell when the
  // picture has moved past this read (pull-only staleness — see weeklyReadFreshness).
  if (k === "weekly_read" && (insight as any)?.id != null) {
    stampWeeklyReadFreshness(Number((insight as any).id));
  }
  const out = { ok: true as const, insight, agent: chosen, tried, agent_status: "ok" as const };
  // Short freshness by default (a quiet insight should refresh within the hour);
  // the nightly scheduler passes a longer window so the morning open is a fresh hit.
  const freshForMs = Number.isFinite(opts?.freshForMs as number) ? (opts!.freshForMs as number) : 60 * 60 * 1000;
  try {
    saveAiCache(cacheKind, cacheKey, {
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

// Fingerprint an insight pass: the kind + a coarse hour bucket + the dedup floor —
// both halves of it, the recently-said texts AND the covered-territory keys. Keeping
// the keys out would let a newly-covered connection be served from a cache built
// before the guard knew about it. A new said-set, new territory, or a fresh hour
// busts it.
export function insightCacheKey(kind: string, recent: string[], keys: string[] = []): string {
  const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return fingerprint({
    kind,
    hourBucket,
    recent: [...recent].map((t) => String(t).trim().toLowerCase()).sort(),
    keys: [...keys].map((k) => String(k).trim()).sort(),
  });
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
    const { result } = await runChosen(agent, prompt, {
      op: "chat_distill",
      signal: hooks?.signal,
      // Without a contract ANY parseable object stopped the rotation — including
      // another op's payload from a confused CLI.
      acceptParsed: isChatDistillResult,
      schema: CHAT_DISTILL_SCHEMA,
    });
    if (result.parsed) {
      distilled = saveDistilledMemories(result.parsed);
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
  applied: {
    about_me: boolean;
    profile: boolean;
    supplements: number;
    memories: number;
    context_events: number;
    movement_considerations: number;
  };
}> {
  const raw = String(text ?? "").trim();
  const applied = { about_me: false, profile: false, supplements: 0, memories: 0, context_events: 0, movement_considerations: 0 };
  if (!raw) {
    try {
      setSettings({ onboarded: true });
    } catch (err) { log.warn("[onboard] could not mark the profile onboarded", { error: err }); }
    return { ok: true as const, source: "empty", applied };
  }

  // Deterministic base — never lose what they said.
  try {
    setProfile({ about_me: raw.slice(0, 8000) });
    applied.about_me = true;
  } catch (err) { log.warn("[onboard] could not store the athlete's own words", { error: err }); }
  try {
    applied.supplements = understandSupplements(raw, { strict: true }).length;
  } catch (err) { log.debug("[onboard] no supplements understood from the text", { error: err }); }

  let source: "agent" | "deterministic" = "deterministic";
  try {
    hooks?.onPhase?.("getting to know you");
    const { result } = await runChosen(agent, buildOnboardPrompt(raw), {
      op: "onboard",
      timeoutMs: interactiveTimeoutForOp("onboard"),
      signal: hooks?.signal,
      schema: ONBOARD_SCHEMA,
    });
    const p: any = result.parsed;
    if (p && typeof p === "object") {
      source = "agent";
      if (typeof p.about_me === "string" && p.about_me.trim()) {
        try {
          setProfile({ about_me: p.about_me.trim().slice(0, 8000) });
          applied.about_me = true;
        } catch (err) { log.warn("[onboard] could not store the agent's about_me", { error: err }); }
      }
      const pr = p.profile && typeof p.profile === "object" ? p.profile : {};
      const patch: any = {};
      for (const k of ["sex", "age", "height_cm", "weight_lb", "goal_weight_lb", "goal_date"])
        if (pr[k] != null && pr[k] !== "") patch[k] = pr[k];
      if (Object.keys(patch).length) {
        try {
          setProfile(patch);
          applied.profile = true;
        } catch (err) { log.warn("[onboard] could not apply the agent's profile patch", { error: err }); }
      }
      if (Array.isArray(p.supplements) && p.supplements.length) {
        let n = 0;
        for (const it of p.supplements) {
          if (it?.name) {
            try {
              addSupplement(it);
              n++;
            } catch (err) { log.debug("[onboard] skipped one supplement", { error: err }); }
          }
        }
        if (n) applied.supplements = n; // the agent's structured set supersedes the deterministic count
      }
      if (Array.isArray(p.memories))
        for (const m of p.memories) {
          if (m?.content) {
            try {
              addMemory(String(m.content), m.kind, "onboard");
              applied.memories++;
            } catch (err) { log.debug("[onboard] skipped one memory", { error: err }); }
          }
        }
      if (Array.isArray(p.context_events))
        for (const ev of p.context_events) {
          if (ev?.title || ev?.kind) {
            try {
              addContextEvent({
                kind: ev.kind,
                title: ev.title,
                detail: ev.detail,
                start_date: ev.start_date,
                end_date: ev.end_date,
                meta: ev.meta,
              });
              applied.context_events++;
            } catch (err) { log.debug("[onboard] skipped one context event", { error: err }); }
          }
        }
      // A lasting, painless condition goes onto the profile — never a context event,
      // because an injury event would hard-gate the very lifts they want kept.
      if (Array.isArray(p.movement_considerations) && p.movement_considerations.length) {
        try {
          const items = p.movement_considerations.map((item: any) => ({ ...item, source: "onboard" }));
          setProfile({ movement_considerations: { items } });
          applied.movement_considerations = movementConsiderationsRead()?.items.length ?? 0;
        } catch (err) { log.warn("[onboard] could not store the stated movement considerations", { error: err }); }
      }
      // days_per_week stays a soft signal (remembered), not an auto plan rewrite —
      // the seeded plan is already there; the athlete adjusts it when they want to.
      if (pr.days_per_week != null && Number(pr.days_per_week) > 0) {
        try {
          addMemory(`Trains about ${Number(pr.days_per_week)} days/week`, "preference", "onboard");
          applied.memories++;
        } catch (err) { log.debug("[onboard] could not remember the weekly training cadence", { error: err }); }
      }
    }
  } catch (error) {
    if (hooks?.signal?.aborted) throw error;
    // Fail-open: the deterministic base already applied.
  }

  try {
    setSettings({ onboarded: true });
  } catch (err) { log.warn("[onboard] could not mark the profile onboarded", { error: err }); }
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

/**
 * Apply one librarian plan to the live memory store, through the repo functions
 * (which MARK, never hard-delete). Exported so the protection floor below is
 * testable without an agent in the loop; `consolidateMemory` is the only caller in
 * production.
 */
export function applyMemoryConsolidation(plan: any): { merged: number; superseded: number; promoted: number } {
  const p: any = plan;
  const rows = listMemory(200, { includeSuperseded: true }) as any[];
  const idSet = new Set(rows.map((m: any) => Number(m.id)));
  const byId = new Map<number, any>(rows.map((m: any) => [Number(m.id), m]));
  let merged = 0,
    superseded = 0,
    promoted = 0;

  // The floor under the librarian. The consolidation prompt is TOLD not to supersede a
  // goal or constraint the user stated themselves, but an instruction is not an
  // enforcement: one hallucinated id and a nightly unattended pass would quietly retire
  // the athlete's own words in favour of something Cairn merely inferred. So the server
  // refuses it. Deliberately narrow — only a USER-stated goal/constraint is protected,
  // and only from being replaced by something that is not also user-stated (a user
  // correcting their own goal still lands). A refusal is a quiet skip, never an error:
  // the rest of the pass is good work and must still apply.
  const PROTECTED_KINDS = new Set(["goal", "constraint"]);
  const userStated = (row: any): boolean => String(row?.source ?? "").toLowerCase() === "user";
  const isProtected = (id: number): boolean => {
    const row = byId.get(Number(id));
    return !!row && userStated(row) && PROTECTED_KINDS.has(String(row.kind ?? "").toLowerCase());
  };

  // MERGES: fold every other id into the first, with one combined sentence.
  for (const m of Array.isArray(p.merges) ? p.merges : []) {
    const ids = (Array.isArray(m?.ids) ? m.ids : []).map(Number).filter((n: number) => idSet.has(n));
    if (ids.length < 2 || !m?.content) continue;
    const [keep, ...rest] = ids;
    try {
      updateMemory(keep, { content: String(m.content), kind: m.kind });
      for (const dup of rest) {
        // Folding a user-stated goal into a row the user did not state is a supersede
        // wearing a merge's clothes — the surviving row is the other one.
        if (isProtected(dup) && !userStated(byId.get(Number(keep)))) continue;
        supersedeMemory(dup, { replacementId: keep, reason: "merged duplicate" });
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
    // A supersede writes its replacement through addMemory, which sources it
    // "supersede" — never "user". So a protected row can never be retired down this
    // path, which is exactly the intent: the athlete changes their own goal by saying
    // so, not by a consolidation pass deciding they have.
    if (isProtected(id)) continue;
    try {
      supersedeMemory(id, { content: s?.replacement, reason: s?.reason || "superseded" });
      superseded++;
    } catch (err) { log.debug("[memory] one supersede did not apply", { error: err }); }
  }
  // PROMOTIONS: a recurring observation has become a stable trait.
  for (const pr of Array.isArray(p.promotions) ? p.promotions : []) {
    const id = Number(pr?.id);
    if (!idSet.has(id) || !pr?.kind) continue;
    try {
      updateMemory(id, { content: pr?.content, kind: String(pr.kind) });
      promoted++;
    } catch (err) { log.debug("[memory] one promotion did not apply", { error: err }); }
  }
  return { merged, superseded, promoted };
}

// Quiet memory consolidation: ask an agent to propose merges / supersessions /
// promotions over the live store, then apply them through the repo functions
// (which MARK, never hard-delete). Calm by default — an empty result is a clean
// no-op. Scheduled nightly; also callable on demand. NEVER notifies.
export async function consolidateMemory(agent: string | undefined) {
  const prompt = buildMemoryConsolidationPrompt();
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "memory_consolidation",
      acceptParsed: isMemoryConsolidationResult,
      schema: MEMORY_CONSOLIDATION_SCHEMA,
    });
  } catch (error) {
    return { ok: false as const, error: "agent returned no usable plan", ...agentFailure(error) };
  }
  const { agent: chosen, result, tried } = run;
  const p: any = result.parsed;
  if (!p || typeof p !== "object")
    return { ok: false as const, error: "agent returned no usable plan", agent: chosen, tried };
  return { ok: true as const, ...applyMemoryConsolidation(p), agent: chosen, tried };
}

// Grow profile.about_me into a coherent person-model from typed memory + family +
// check-ins. AUGMENTS, never overwrites blindly — the prompt preserves existing
// (user-authored) content, and we only write when the agent reports a real change.
export async function growAboutMe(agent: string | undefined) {
  const prompt = buildAboutMeGrowthPrompt();
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, { op: "about_me_growth", schema: ABOUT_ME_GROWTH_SCHEMA });
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
  const before = String((getProfile() || {}).about_me ?? "").trim();
  if (text === before) return { ok: true as const, changed: false, agent: chosen, tried };
  const profile = setProfile({ about_me: text });
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
  const model = reactionModelForCoach();
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
      schema: REACTION_NARRATIVE_SCHEMA,
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
    setReactionNarrative(text);
    return { ok: true as const, narrative: text.slice(0, 600), agent: chosen, tried, agent_status: "ok" as const };
  } catch (error) {
    // Any failure degrades to a no-op; the existing narrative stands.
    return { ok: false as const, error: "agent returned no usable narrative", ...agentFailure(error, hooks) };
  }
}
