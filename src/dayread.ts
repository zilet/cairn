// The Brief's compute + cache layer. repo.dayRead() is the deterministic floor;
// this wraps it with the agentic judgment (buildDayReadPrompt → an agent writes
// the human sentence) and PERSISTS the canonical read so the morning open is
// instant. The scheduler precomputes it nightly; api.ts / mcp.ts serve the cache
// on a hit and call computeDayRead() on a miss. Kept in its own module so the
// agent-running orchestration lives in one place (api and mcp were near-duplicates).
import * as repo from "./repo.js";
import { buildDayReadPrompt } from "./prompt.js";
import { runAgent, runAgentWithFallback, INTERACTIVE_TIMEOUT_MS } from "./agents.js";

// The PWA drives every request with its LOCAL calendar date (state.logDate), so
// the cache key — and the nightly precompute — must use the server's local date
// to line up (a home server shares the owner's timezone). A timezone mismatch
// only ever costs a cache miss → one compute on open, never a wrong answer.
export function localToday(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function deterministicHeadline(r: { kind: string; focus?: string | null }): string {
  return r.kind === "rest" ? "Rest today." : r.kind === "easy" ? "Take it easy." : r.focus ? `${r.focus}.` : "Good to train.";
}

// The day-read is interactive (the Brief is on the morning-open request path),
// so it runs on the short leash. The "auto" path records its own telemetry
// inside runAgentWithFallback; the explicit-agent path records one row here,
// failure-safe — a telemetry hiccup must never break the Brief.
async function runChosen(agent: string | undefined, prompt: string) {
  if (!agent || agent === "auto") {
    const fb = await runAgentWithFallback(repo.pickAgentOrder(), prompt, { op: "day_read", timeoutMs: INTERACTIVE_TIMEOUT_MS });
    return { agent: fb.agent, result: fb.result, tried: fb.tried };
  }
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runAgent>> | null = null;
  try {
    result = await runAgent(agent, prompt, { timeoutMs: INTERACTIVE_TIMEOUT_MS });
    return { agent, result, tried: [] as any[] };
  } finally {
    try {
      repo.recordAgentRun({ op: "day_read", agent, ok: !!result?.parsed, parsed: !!result?.parsed, latency_ms: Date.now() - started, tried_json: false });
    } catch { /* telemetry never breaks the Brief */ }
  }
}

// Compute the agentic day-read with the deterministic floor as fallback. The
// canonical (no-override) read is persisted to the day_reads cache; escape-hatch
// overrides ("rough night" / "train anyway") are transient and never cached so
// they can't poison tomorrow's instant open. Always resolves to a real read.
export async function computeDayRead(
  opts: { date?: string; override?: string; agent?: string } = {}
): Promise<any> {
  const { date, override, agent } = opts;
  const baseline = repo.dayRead(date);
  let out: any;
  try {
    const prompt = buildDayReadPrompt(undefined, { override, date });
    const { agent: chosen, result, tried } = await runChosen(agent, prompt);
    const p = result.parsed;
    const sane =
      p && typeof p === "object" &&
      (p.kind === "train" || p.kind === "easy" || p.kind === "rest") &&
      typeof p.why === "string" && p.why.trim();
    if (sane) {
      out = {
        kind: p.kind,
        headline:
          typeof p.headline === "string" && p.headline.trim()
            ? p.headline.trim()
            : deterministicHeadline({ kind: p.kind, focus: p.focus ?? null }),
        why: String(p.why).trim(),
        focus: p.focus == null ? null : String(p.focus).trim() || null,
        est_minutes: Number.isFinite(Number(p.est_minutes)) ? Number(p.est_minutes) : baseline.est_minutes,
        signals: baseline.signals,
        source: "agent",
        agent: chosen,
        tried,
      };
    } else {
      // Agent unreachable / wrong shape → the deterministic floor (still a real read).
      out = { ...baseline, headline: deterministicHeadline(baseline), source: "deterministic", agent: chosen, tried };
    }
  } catch (e: any) {
    out = { ...baseline, headline: deterministicHeadline(baseline), source: "deterministic", error: e?.message };
  }
  // Record the athlete's steer on the read and ALWAYS persist it (the no-clobber
  // guard in saveDayRead protects a stored steer from a later canonical recompute).
  // Persisting the steer is what makes it survive a reload and reach the coach context.
  out.override = override && override.trim() ? override.trim() : null;
  try { repo.saveDayRead(date || localToday(), out); } catch {}
  return out;
}

// Nightly / boot warm: compute & cache today's canonical read so the first open
// never waits on an agent. Never throws — a failed compute still caches the
// deterministic floor (instant), and the next material change re-derives it.
export async function precomputeDayRead(date?: string): Promise<void> {
  try { await computeDayRead({ date: date || localToday() }); } catch {}
}
