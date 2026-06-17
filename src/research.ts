// Host-side research & grounding (Stream 4 — Research & Grounding).
//
// "Cairn does its own research": when research is ENABLED in settings, this runs a
// dedicated, web-capable agentic call (the configured CLI has web access) over a
// strict, CITED contract (buildResearchPrompt), then acts as the hallucination
// firewall on the way back — it validates every source URL, discards any claim
// without a real source, and caches the survivors into evidence_cache. That cache
// then GROUNDS the health review (injected passages) and VERIFIES agent-emitted
// citations (repo.verifyCitation).
//
// Everything degrades to exactly today's behavior: research disabled / no agent /
// the call fails → researchEvidence returns { ok:false, ... } and nothing is
// cached. NO caller blocks or crashes on a research failure. INFORMATIONAL, not
// medical advice — clinical questions defer to a clinician.

import * as repo from "./repo.js";
import { runChosen } from "./runChosen.js";
import { buildResearchPrompt } from "./prompt.js";

export interface ResearchResult {
  ok: boolean;
  enabled: boolean;
  topic: string;
  summary?: string;
  evidence: any[];          // the cached evidence_cache rows produced this run
  cached?: boolean;         // true when results came from the cache (no agent call)
  agent?: string;
  tried?: { agent: string; error: string }[];
  error?: string;
}

// Research is OFF by default. When off, this is a pure no-op: no network, no agent,
// the exact deterministic behavior the system has today.
export function researchEnabled(): boolean {
  try {
    return !!repo.getSettings().research_enabled;
  } catch {
    return false;
  }
}

// Validate + filter a single claim's sources to plausible http(s) URLs. Returns
// the surviving {title,url} list (deduped by url). A claim with none is dropped.
function validateSources(raw: any): { title: string; url: string }[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: { title: string; url: string }[] = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const url = String(s.url ?? "").trim();
    if (!repo.isPlausibleSourceUrl(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: String(s.title ?? "").trim().slice(0, 300) || url, url: url.slice(0, 600) });
  }
  return out;
}

/**
 * Research one health/longevity question and cache the cited evidence.
 *
 * - Cache-first: if recent evidence exists for this topic and `force` is not set,
 *   it's returned without an agent call (cheap + deterministic).
 * - Sourceless / bad-URL claims are DISCARDED (the hallucination firewall).
 * - Returns ok:false (never throws) when research is disabled or the agent fails.
 *
 * @param question  the health question to ground
 * @param markers   relevant marker names (optional) — narrows the prompt + tags rows
 */
export async function researchEvidence(
  question: string,
  markers: string[] = [],
  opts: { agent?: string; force?: boolean; timeoutMs?: number } = {}
): Promise<ResearchResult> {
  const topic = repo.normTopic(question);
  if (!topic) return { ok: false, enabled: researchEnabled(), topic, evidence: [], error: "empty question" };

  if (!researchEnabled()) {
    // Degrade to today's behavior: serve whatever is already cached (if anything),
    // never reach for the network.
    const cached = repo.getEvidence({ topic, limit: 20 });
    return { ok: false, enabled: false, topic, evidence: cached, cached: true, error: "research disabled" };
  }

  // Cache hit (unless force): no agent call.
  if (!opts.force) {
    const cached = repo.getEvidence({ topic, limit: 20 });
    if (cached.length) return { ok: true, enabled: true, topic, evidence: cached, cached: true };
  }

  const prompt = buildResearchPrompt(question, markers);
  // Background timeout band (research is never on the interactive path).
  const timeoutMs = Number.isFinite(opts.timeoutMs as number) ? (opts.timeoutMs as number) : 300000;
  let chosen = "";
  let tried: { agent: string; error: string }[] = [];
  let parsed: any = null;
  try {
    const r = await runChosen(opts.agent, prompt, { op: "research", timeoutMs });
    chosen = r.agent;
    tried = r.tried;
    parsed = r.result.parsed;
  } catch (e: any) {
    return { ok: false, enabled: true, topic, evidence: [], agent: chosen, tried, error: e?.message || "research agent failed" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, enabled: true, topic, evidence: [], agent: chosen, tried, error: "agent returned no usable research" };
  }

  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const stored: any[] = [];
  for (const c of claims) {
    if (!c || typeof c !== "object") continue;
    const sources = validateSources(c.sources);
    if (!sources.length) continue; // sourceless claim → discarded
    const src = sources[0];
    const row = repo.addEvidence({
      topic,
      marker: c.marker ?? null,
      claim: c.claim ?? null,
      body: c.body ?? null,
      source_title: src.title,
      source_url: src.url,
      confidence: c.confidence ?? null,
    });
    if (row) stored.push(row);
  }

  if (!stored.length) {
    return {
      ok: false,
      enabled: true,
      topic,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      evidence: [],
      agent: chosen,
      tried,
      error: "no sourced claims survived validation",
    };
  }

  return {
    ok: true,
    enabled: true,
    topic,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    evidence: stored,
    agent: chosen,
    tried,
  };
}

// Grounding for the health review: research the highest-impact off-optimal markers
// (when enabled) and return the cited passages buildHealthReviewPrompt injects.
// Best-effort and bounded — a failure on any one marker is swallowed so the review
// still runs ungrounded (today's behavior). Returns [] when research is off.
export async function gatherReviewGrounding(
  agent?: string
): Promise<{ marker: string | null; claim: string | null; source_title: string | null; source_url: string | null; confidence: string | null }[]> {
  if (!researchEnabled()) return [];
  let priorityMarkers: any[] = [];
  try {
    const { markers } = repo.prioritizeMarkers();
    // Only off-optimal / flagged markers are worth grounding; cap to the top few
    // so a review never fans out into a dozen agent calls.
    priorityMarkers = (markers as any[])
      .filter((m) => m?.in_optimal === false || m?.latest?.flag === "low" || m?.latest?.flag === "high")
      .slice(0, 3);
  } catch {
    priorityMarkers = [];
  }
  // The (≤3) markers are independent (each caches its own evidence rows), so
  // research them concurrently — a grounded review shouldn't pay 3× the wall-clock
  // serially when each agent call can take minutes. Each marker yields ≤4 passages,
  // so the flattened result is already ≤12; cap defensively all the same.
  const perMarker = await Promise.all(
    priorityMarkers.map(async (m) => {
      const name = String(m?.name ?? "").trim();
      if (!name) return [];
      const side = m?.latest?.flag || (m?.optimal && typeof m?.latest?.value === "number"
        ? (m.latest.value < m.optimal.low ? "low" : m.latest.value > m.optimal.high ? "high" : "off-optimal")
        : "off-optimal");
      const question = `What current clinical guidance applies to ${side} ${name}, and what are the safe, evidence-based lifestyle (diet/training) levers? Informational only.`;
      try {
        const r = await researchEvidence(question, [name], { agent });
        return r.evidence.slice(0, 4).map((e) => ({
          marker: e.marker ?? name,
          claim: e.claim ?? null,
          source_title: e.source_title ?? null,
          source_url: e.source_url ?? null,
          confidence: e.confidence ?? null,
        }));
      } catch {
        return []; // swallow — the review runs ungrounded for this marker
      }
    })
  );
  return perMarker.flat().slice(0, 12);
}
