// The Brief's compute + cache layer. repo.dayRead() is the deterministic floor;
// this wraps it with the agentic judgment (buildDayReadPrompt → an agent writes
// the human sentence) and PERSISTS the canonical read so the morning open is
// instant. The scheduler precomputes it nightly; api.ts / mcp.ts serve the cache
// on a hit and call computeDayRead() on a miss. Kept in its own module so the
// agent-running orchestration lives in one place (api and mcp were near-duplicates).
import * as repo from "./repo.js";
import { buildDayReadPrompt } from "./prompt.js";
import { runChosenWithCoachReads } from "./runChosen.js";
import { localDateISO } from "./repo/shared.js";
import { isValidTimeZone } from "./tz.js";
import { pickDayVariant } from "./repo/brain/day-read-rules.js";
import {
  dayReadHeadline,
  dayReadPolicyReason,
  RECOVERY_WEEK_SOFTEN_WHY,
  violatesReadingGrammar,
} from "./repo/day-read.js";

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

function decisionAt(): string {
  return new Date().toISOString();
}

function policyDecision(
  baseline: any,
  ruleCode: string,
  date: string,
  evidence: Array<{ label: string; value: string; date?: string }> = []
) {
  const computedAt = decisionAt();
  // Rotated the same way as every athlete-facing `why` (see DAY_READ_WHY_VARIANTS):
  // the Brief renders this reason whenever it's non-empty, and every server-policy
  // clamp that reaches this helper can fire on consecutive days, so an unrotated
  // literal here repeats exactly like an unrotated `why` did. The lookup itself is
  // shared with computeDayRead's agent branch (dayReadPolicyReason) — that branch had
  // its own hand-written literal, which is how the fifth reason came to be the one the
  // rotation missed.
  const reason = dayReadPolicyReason(ruleCode, date);
  return {
    rule_code: ruleCode,
    basis: "server_policy",
    baseline_kind: baseline?.kind ?? "easy",
    reason,
    evidence: evidence.slice(0, 5),
    computed_at: computedAt,
  };
}

export interface DayReadProseConsistencyIssue {
  code: "completed_load_understated";
  classified_load: "moderate" | "hard";
  evidence: string;
}

const COMPLETED_ACTIVITY =
  /\b(?:that|this|today(?:'s)?|the|your)\s+(?:run|ride|session|workout|lift|training|activity|effort|work)\b/gi;
const EASY_DESCRIPTOR = /\b(?:easy|light|gentle|recovery(?:-paced)?)\b/gi;
const FUTURE_OR_RECOVERY_CUE =
  /\b(?:next|tomorrow(?:'s)?|later|upcoming|afterward|afterwards|follow(?:-?up)?|cool(?:-?down)?|remainder)\b/i;
const NEGATED_EASY = /\b(?:not|never|wasn't|weren't|isn't|no)\s+(?:an?\s+)?(?:easy|light|gentle)\b/i;

// Structured, deliberately conservative semantic guard for the one contradiction
// that materially changes the athlete's read: a completed moderate/hard effort
// described as easy. It does NOT reject forward-looking recovery advice such as
// "keep tomorrow easy"; the completed activity must be the grammatical subject
// near the easy descriptor (or an "easy run complete" construction).
export function dayReadProseConsistencyIssue(
  read: { kind?: unknown; headline?: unknown; why?: unknown },
  signals: Record<string, any> | null | undefined
): DayReadProseConsistencyIssue | null {
  const classifiedLoad = String(signals?.today_load ?? "").toLowerCase();
  if (classifiedLoad !== "moderate" && classifiedLoad !== "hard") return null;
  if (signals?.trained_today !== true && read?.kind !== "done") return null;

  const prose = [read?.headline, read?.why]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .join("\n");
  const sentences = prose
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (NEGATED_EASY.test(sentence)) continue;

    COMPLETED_ACTIVITY.lastIndex = 0;
    EASY_DESCRIPTOR.lastIndex = 0;
    const subjects = [...sentence.matchAll(COMPLETED_ACTIVITY)];
    const descriptors = [...sentence.matchAll(EASY_DESCRIPTOR)];
    for (const subject of subjects) {
      const subjectEnd = (subject.index ?? 0) + subject[0].length;
      for (const descriptor of descriptors) {
        const descriptorAt = descriptor.index ?? 0;
        if (descriptorAt < subjectEnd || descriptorAt - subjectEnd > 90) continue;
        const bridge = sentence.slice(subjectEnd, descriptorAt);
        if (FUTURE_OR_RECOVERY_CUE.test(bridge)) continue;
        return {
          code: "completed_load_understated",
          classified_load: classifiedLoad,
          evidence: sentence.slice(0, 240),
        };
      }
    }

    // Headline-style construction: "Easy run complete." This is kept narrower
    // than a generic "easy run" match so suggested future easy work remains valid.
    if (
      /\b(?:easy|light|gentle|recovery(?:-paced)?)\s+(?:run|ride|session|workout|lift|training|activity|effort)\b.{0,30}\b(?:complete|completed|done|finished|logged|in the books)\b/i.test(
        sentence
      ) &&
      !FUTURE_OR_RECOVERY_CUE.test(sentence)
    ) {
      return {
        code: "completed_load_understated",
        classified_load: classifiedLoad,
        evidence: sentence.slice(0, 240),
      };
    }
  }
  return null;
}

// Completion is a server-owned fact IN BOTH DIRECTIONS — the agent may voice a
// DONE day warmly, but it can neither downgrade a completed day back into a
// recommendation NOR claim "done" on a day the deterministic baseline says is
// not done (a midnight precompute reading yesterday's session as today's would
// otherwise lock the fresh day into a no-CTA "You're done" until the next
// invalidation). Pure so the contract is directly unit-testable.
export function enforceCompletionContract(out: any, baseline: any, date?: string): any {
  const resolvedDate = date || localToday();
  if (out.kind === "done" && baseline.kind !== "done") {
    const decision = policyDecision(baseline, "completion_fact_not_logged", resolvedDate);
    return {
      ...baseline,
      headline: dayReadHeadline(baseline, resolvedDate),
      source: "deterministic",
      agent: out.agent,
      tried: out.tried,
      decision,
      computed_at: decision.computed_at,
    };
  }
  if (baseline.kind === "done") {
    // An agent may phrase the debrief, but it cannot leave a prospective
    // focus/duration behind or turn the completed work back into another
    // recommendation. Older agents that still emit easy/train for the debrief
    // fall all the way back to the deterministic acknowledgement.
    if (out.kind !== "done") {
      out.headline = dayReadHeadline(baseline, resolvedDate);
      out.why = baseline.why;
      out.source = "deterministic";
      out.decision = policyDecision(baseline, "completion_fact_preserved", resolvedDate);
      out.computed_at = out.decision.computed_at;
    }
    out.kind = "done";
    out.focus = null;
    out.est_minutes = null;
  }
  return out;
}

// The agent supplies judgment and voice, but without an explicit athlete steer it
// cannot outrank the deterministic safety posture. `rest < easy < train` is the
// recommendation ladder: moving left is always allowed; moving right is clamped
// to the server-owned baseline with matching deterministic wording. Completion is
// deliberately handled separately below because it is a fact, not a posture.
export function enforceDayReadSafetyPosture(out: any, baseline: any, hasOverride = false, date?: string): any {
  if (hasOverride || baseline?.kind === "done" || out?.kind === "done") return out;
  const rank: Record<string, number> = { rest: 0, easy: 1, train: 2 };
  const baselineRank = rank[String(baseline?.kind ?? "")];
  const outRank = rank[String(out?.kind ?? "")];
  if (baselineRank == null || outRank == null || outRank <= baselineRank) return out;
  const resolvedDate = date || localToday();
  const decision = policyDecision(baseline, "deterministic_safety_floor", resolvedDate);
  return {
    ...baseline,
    headline: dayReadHeadline(baseline, resolvedDate),
    source: "deterministic",
    agent: out.agent,
    tried: out.tried,
    decision,
    computed_at: decision.computed_at,
  };
}

// A recovery week is already the deterministic answer to accumulated load: seven
// days of reduced volume, not seven consecutive days of rest. The prose layer may
// make the day easier immediately after a real loading day, but cannot keep
// stacking non-loading days from broad context alone. Acute deterministic
// baselines remain untouched because this policy applies only to baseline=train.
export function enforceRecoveryWeekCadence(out: any, baseline: any, hasOverride = false, date?: string): any {
  if (
    hasOverride ||
    baseline?.kind !== "train" ||
    baseline?.signals?.recovery_week?.state !== "applied" ||
    (out?.kind !== "easy" && out?.kind !== "rest")
  ) {
    return out;
  }
  const yesterday = Array.isArray(baseline.signals.recent_load) ? baseline.signals.recent_load[0] : null;
  const loadedYesterday = yesterday?.load === "moderate" || yesterday?.load === "hard";
  const evidence = [
    {
      label: "Yesterday's load",
      value: String(yesterday?.load ?? "none"),
      ...(typeof yesterday?.date === "string" ? { date: yesterday.date } : {}),
    },
    {
      label: "Recovery overlay",
      value: "reduced volume",
      ...(typeof baseline.signals.recovery_week.applied_on === "string"
        ? { date: baseline.signals.recovery_week.applied_on }
        : {}),
    },
  ];
  const resolvedDate = date || localToday();
  if (!loadedYesterday) {
    const decision = policyDecision(
      baseline,
      "recovery_week_reduced_train_after_non_loading_day",
      resolvedDate,
      evidence
    );
    return {
      ...baseline,
      headline: dayReadHeadline(baseline, resolvedDate),
      source: "deterministic",
      agent: out.agent,
      tried: out.tried,
      decision,
      computed_at: decision.computed_at,
    };
  }
  if (out.kind === "rest") {
    const decision = policyDecision(
      baseline,
      "recovery_week_rest_softened_to_easy_after_loading_day",
      resolvedDate,
      evidence
    );
    return {
      ...baseline,
      kind: "easy",
      // The headline rotates for the same reason the `why` below it does, and it is the
      // MORE visible of the two — it was the only literal left on this branch after the
      // `why` was fixed, one line above the comment explaining why a literal here is the
      // worst place for one. dayReadHeadline is passed the CLAMPED kind, not the
      // baseline's, so the sentence matches the day it now describes.
      headline: dayReadHeadline({ kind: "easy", focus: null }, resolvedDate),
      focus: null,
      // Rotated the same way as every other rule (see DAY_READ_WHY_VARIANTS): this
      // clamp fires inside an APPLIED recovery week, so an unrotated literal here was
      // the branch most likely to repeat verbatim for up to seven days straight.
      why: pickDayVariant(
        RECOVERY_WEEK_SOFTEN_WHY,
        resolvedDate,
        "recovery_week_rest_softened_to_easy_after_loading_day"
      ),
      est_minutes: 20,
      source: "deterministic",
      agent: out.agent,
      tried: out.tried,
      decision,
      computed_at: decision.computed_at,
    };
  }
  return out;
}

export function isValidDayReadAgentResult(
  value: any,
  baseline?: { kind?: unknown; signals?: Record<string, any> }
): boolean {
  const validShape = !!(
    value &&
    typeof value === "object" &&
    (value.kind === "train" || value.kind === "easy" || value.kind === "rest" || value.kind === "done") &&
    typeof value.why === "string" &&
    value.why.trim() &&
    (value.headline == null || typeof value.headline === "string") &&
    (value.focus == null || typeof value.focus === "string") &&
    (value.est_minutes == null || Number.isFinite(Number(value.est_minutes)))
  );
  if (!validShape) return false;
  // The reading grammar (VISION.md Amendment 2) applies to the layer that can actually
  // break it. The deterministic vocabulary has been held to these four rules for a
  // while; the AGENT's sentence — the one the athlete reads on most mornings — was
  // held to nothing, so `{headline:"Readiness 38/100 — rest.", why:"…you must not
  // train today."}` validated and rendered verbatim as the Brief's headline and `why`.
  // The prompt already forbids both, twice, so a violation is model non-compliance:
  // rejecting here is exactly right, because acceptParsed retries and the fallback
  // ladder can still land a compliant sentence (and the deterministic floor, which
  // passes this predicate by construction, is the worst case).
  if (violatesReadingGrammar(value.headline)) return false;
  if (violatesReadingGrammar(value.why)) return false;
  if (dayReadProseConsistencyIssue(value, baseline?.signals)) return false;
  // Whether meaningful training is already DONE is a server-owned fact, not a
  // nuance the prose layer may reinterpret. Reject a mismatch before fallback
  // stops so the same agent can repair it or the next healthy agent can answer.
  if (baseline?.kind === "done") return value.kind === "done";
  if (baseline?.kind != null && value.kind === "done") return false;
  return true;
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
  const resolvedDate = date || localToday();
  let out: any;
  try {
    // Thread the SAME baseline the clamps, the persisted `signals` and the
    // `input_fingerprint` below are taken from, so the agent is never shown one
    // state while the server acts on another. (Inside a request the shared
    // signal-state memo already lines them up; the scheduler's warm runs outside
    // any request scope, where only explicit threading can.)
    const prompt = buildDayReadPrompt(undefined, { override, date, baseline });
    // Interactive (the Brief is on the morning-open path) → the short leash, which
    // the bounded-read loop treats as the TOTAL deadline across all query rounds, so
    // the timeout envelope is unchanged. An agent that just answers makes exactly one
    // call (same as before); depth-on-demand reads only run when it requests them.
    const {
      agent: chosen,
      result,
      tried,
    } = await runChosenWithCoachReads(agent, prompt, {
      op: "day_read",
      mode: "ordinary",
      timeoutMs: repo.interactiveTimeoutForOp("day_read"),
      acceptParsed: (parsed) => isValidDayReadAgentResult(parsed, baseline),
    });
    const p = result.parsed;
    if (isValidDayReadAgentResult(p, baseline)) {
      const computedAt = decisionAt();
      const conservative = baseline.kind === "train" && (p.kind === "easy" || p.kind === "rest");
      out = {
        kind: p.kind,
        headline:
          typeof p.headline === "string" && p.headline.trim()
            ? p.headline.trim()
            : dayReadHeadline({ kind: p.kind, focus: p.focus ?? null }, resolvedDate),
        why: String(p.why).trim(),
        focus: p.focus == null ? null : String(p.focus).trim() || null,
        est_minutes: Number.isFinite(Number(p.est_minutes)) ? Number(p.est_minutes) : baseline.est_minutes,
        signals: baseline.signals,
        source: "agent",
        agent: chosen,
        tried,
        decision: {
          rule_code: conservative ? "agent_conservative_adjustment" : "agent_day_read",
          basis: "agent",
          baseline_kind: baseline.kind,
          // Only the conservative adjustment adds something the read's own `why`
          // does not already say. The ordinary case leaves the reason EMPTY rather
          // than narrating Cairn's internals at the athlete (the Brief renders a
          // reason only when there is a specific one).
          //
          // It rotates through the SAME registered vocabulary as every server-policy
          // clamp, via the same lookup. This was the one athlete-facing reason the
          // rotation missed — a single literal, and `conservative` is true only on
          // rest/easy days, which is exactly the shape the Brief renders — precisely
          // because it was hand-written here instead of read from the map.
          reason: conservative ? dayReadPolicyReason("agent_conservative_adjustment", resolvedDate) : "",
          evidence: Array.isArray(baseline.decision?.evidence) ? baseline.decision.evidence.slice(0, 5) : [],
          computed_at: computedAt,
        },
        input_fingerprint: baseline.input_fingerprint,
        computed_at: computedAt,
      };
    } else {
      // Agent unreachable / wrong shape → the deterministic floor (still a real read).
      out = {
        ...baseline,
        headline: dayReadHeadline(baseline, resolvedDate),
        source: "deterministic",
        agent: chosen,
        tried,
      };
    }
  } catch (e: any) {
    out = {
      ...baseline,
      headline: dayReadHeadline(baseline, resolvedDate),
      source: "deterministic",
      error: e?.message,
      agent_issue: agentIssueFor(e),
    };
  }
  out = enforceDayReadSafetyPosture(out, baseline, !!override?.trim(), resolvedDate);
  out = enforceRecoveryWeekCadence(out, baseline, !!override?.trim(), resolvedDate);
  out = enforceCompletionContract(out, baseline, resolvedDate);
  // The day-ahead `forward` line is NOT persisted here — it's attached fresh on every
  // /today-read response (it must reflect the current plan/balance, not a snapshot).
  // Record the athlete's steer on the read and ALWAYS persist it (the no-clobber
  // guard in saveDayRead protects a stored steer from a later canonical recompute).
  // Persisting the steer is what makes it survive a reload and reach the coach context.
  out.override = override && override.trim() ? override.trim() : null;
  try {
    repo.saveDayRead(resolvedDate, out);
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
