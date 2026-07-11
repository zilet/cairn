// The Brief's compute + cache layer. repo.dayRead() is the deterministic floor;
// this wraps it with the agentic judgment (buildDayReadPrompt → an agent writes
// the human sentence) and PERSISTS the canonical read so the morning open is
// instant. The scheduler precomputes it nightly; api.ts / mcp.ts serve the cache
// on a hit and call computeDayRead() on a miss. Kept in its own module so the
// agent-running orchestration lives in one place (api and mcp were near-duplicates).
import * as repo from "./repo.js";
import { buildDayReadPrompt } from "./prompt.js";
import { INTERACTIVE_TIMEOUT_MS } from "./agents.js";
import { runChosen } from "./runChosen.js";
import { localDateISO } from "./repo/shared.js";
import { isValidTimeZone } from "./tz.js";

// The PWA drives every request with its LOCAL calendar date (state.logDate), so
// the cache key — and the nightly precompute — must use the server's local date
// to line up (a home server shares the owner's timezone). A timezone mismatch
// only ever costs a cache miss → one compute on open, never a wrong answer.
export function localToday(d: Date = new Date()): string {
  // Delegate to the zone-aware shared helper so the day_reads cache key matches
  // the row getCoachContext reads (both follow the active device zone, else the
  // server's). Kept as a named export for its existing callers (api/scheduler).
  return localDateISO(d);
}

// The calendar date to WARM the Brief for. The scheduler runs outside any request
// so there's no device zone in scope; passing the recorded client zone explicitly
// makes the boot-warm + nightly precompute compute "today" in the DEVICE's zone
// (the date its next open will request), falling back to server-local when no zone
// has been recorded. Pure (zone in, date out) so it's trivially testable.
export function warmDate(tz: string | undefined, now: Date = new Date()): string {
  return localDateISO(now, isValidTimeZone(tz) ? tz : undefined);
}

// warmDate bound to the last recorded client zone — the date the scheduler warms.
export function warmToday(now: Date = new Date()): string {
  return warmDate(repo.recordedClientTimeZone(), now);
}

function deterministicHeadline(r: { kind: string; focus?: string | null }): string {
  return r.kind === "done"
    ? "You're done for today."
    : r.kind === "rest"
      ? "Rest today."
      : r.kind === "easy"
        ? "Take it easy."
        : r.focus
          ? `${r.focus}.`
          : "Good to train.";
}

// Completion is a server-owned fact IN BOTH DIRECTIONS — the agent may voice a
// DONE day warmly, but it can neither downgrade a completed day back into a
// recommendation NOR claim "done" on a day the deterministic baseline says is
// not done (a midnight precompute reading yesterday's session as today's would
// otherwise lock the fresh day into a no-CTA "You're done" until the next
// invalidation). Pure so the contract is directly unit-testable.
export function enforceCompletionContract(out: any, baseline: any): any {
  if (out.kind === "done" && baseline.kind !== "done") {
    return {
      ...baseline,
      headline: deterministicHeadline(baseline),
      source: "deterministic",
      agent: out.agent,
      tried: out.tried,
    };
  }
  if (baseline.kind === "done") {
    // An agent may phrase the debrief, but it cannot leave a prospective
    // focus/duration behind or turn the completed work back into another
    // recommendation. Older agents that still emit easy/train for the debrief
    // fall all the way back to the deterministic acknowledgement.
    if (out.kind !== "done") {
      out.headline = deterministicHeadline(baseline);
      out.why = baseline.why;
    }
    out.kind = "done";
    out.focus = null;
    out.est_minutes = null;
  }
  return out;
}

export function isValidDayReadAgentResult(value: any): boolean {
  return !!(
    value &&
    typeof value === "object" &&
    (value.kind === "train" || value.kind === "easy" || value.kind === "rest" || value.kind === "done") &&
    typeof value.why === "string" &&
    value.why.trim() &&
    (value.headline == null || typeof value.headline === "string") &&
    (value.focus == null || typeof value.focus === "string") &&
    (value.est_minutes == null || Number.isFinite(Number(value.est_minutes)))
  );
}

function agentIssueFor(error: unknown): "invalid_response" | "unreachable" {
  const message = String((error as any)?.message ?? error ?? "");
  return /outside the requested contract|no valid JSON/i.test(message) ? "invalid_response" : "unreachable";
}

// Compute the agentic day-read with the deterministic floor as fallback. The
// canonical (no-override) read is persisted to the day_reads cache; escape-hatch
// overrides ("rough night" / "train anyway") are transient and never cached so
// they can't poison tomorrow's instant open. Always resolves to a real read.
export async function computeDayRead(opts: { date?: string; override?: string; agent?: string } = {}): Promise<any> {
  const { date, override, agent } = opts;
  const baseline = repo.dayRead(date);
  let out: any;
  try {
    const prompt = buildDayReadPrompt(undefined, { override, date });
    // Interactive (the Brief is on the morning-open path) → the short leash.
    const {
      agent: chosen,
      result,
      tried,
    } = await runChosen(agent, prompt, {
      op: "day_read",
      timeoutMs: INTERACTIVE_TIMEOUT_MS,
      acceptParsed: isValidDayReadAgentResult,
    });
    const p = result.parsed;
    if (isValidDayReadAgentResult(p)) {
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
    out = {
      ...baseline,
      headline: deterministicHeadline(baseline),
      source: "deterministic",
      error: e?.message,
      agent_issue: agentIssueFor(e),
    };
  }
  out = enforceCompletionContract(out, baseline);
  // The day-ahead `forward` line is NOT persisted here — it's attached fresh on every
  // /today-read response (it must reflect the current plan/balance, not a snapshot).
  // Record the athlete's steer on the read and ALWAYS persist it (the no-clobber
  // guard in saveDayRead protects a stored steer from a later canonical recompute).
  // Persisting the steer is what makes it survive a reload and reach the coach context.
  out.override = override && override.trim() ? override.trim() : null;
  try {
    repo.saveDayRead(date || localToday(), out);
  } catch {}
  return out;
}

// Nightly / boot warm: compute & cache today's canonical read so the first open
// never waits on an agent. Never throws — a failed compute still caches the
// deterministic floor (instant), and the next material change re-derives it.
export async function precomputeDayRead(date?: string): Promise<void> {
  try {
    await computeDayRead({ date: date || localToday() });
  } catch {}
}
