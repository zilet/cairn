/**
 * PROVIDER EXHAUSTION IS NOT A CODE DEFECT, AND MUST NOT LOOK LIKE ONE.
 *
 * Every agentic scheduler task ends the same way when no CLI can answer: the op returns
 * a designed `{ok:false, error, agent_status:'all_failed', tried}`, the task body threw
 * `new Error(String(r.error))`, and by the time telemetry saw it the only surviving fact
 * was the name "Error". Three different nightly jobs therefore reported
 * `scheduler:task_failure:<slot>:Error` on a night when the honest answer was "claude is
 * at its weekly limit, codex is at its usage limit, grok is out of credit".
 *
 * This is the typed carrier for that answer. It lives in its own leaf module, importing
 * nothing but the privacy contract, so both the scheduler (which throws it) and the
 * durable operation ladder in `repo/` (which defers its retry) can see it without
 * anyone importing `agents.ts` or `repo.ts` and closing an import cycle.
 *
 * Everything it carries is TAXONOMY: a low-cardinality availability class and the agent
 * names from `agents.json`. Raw provider output never reaches it.
 */

import { agentErrorClass, telemetryIdentifier } from "./telemetry-privacy.js";

/** One entry of `AgentFallbackError.tried[]`, read defensively. */
export interface ProviderAttempt {
  agent?: string;
  error?: string;
  /**
   * Optional availability class published by the agent layer. Read defensively: it is
   * owned by another module and may be absent on any given attempt.
   */
  availability?: {
    state?: string | null;
    resets_at?: string | null;
    hold_until?: string | null;
    detail?: string | null;
  } | null;
}

/** The shape every agentic coachOp returns; only the fields this module needs. */
export interface AgenticOpResult {
  ok?: boolean;
  error?: unknown;
  agent_status?: string | null;
  tried?: ProviderAttempt[] | null;
}

/** The longest a provider outage may push a retry out. */
const MAX_PROVIDER_DEFER_MS = 24 * 60 * 60 * 1000;

/** The shortest. A weekly limit does not clear in fifteen minutes. */
export const PROVIDER_UNAVAILABLE_MIN_BACKOFF_MS = 4 * 60 * 60 * 1000;

function attemptClass(attempt: ProviderAttempt): string {
  const state = attempt?.availability?.state;
  if (typeof state === "string" && state.trim()) return telemetryIdentifier(state, 40, "unknown_state");
  return agentErrorClass(null, attempt?.error) ?? "unknown_error";
}

/**
 * The class that best describes WHY nothing answered: the most common one across the
 * attempts, ties broken alphabetically so the fingerprint is stable across runs.
 */
export function dominantAvailabilityState(
  tried: ProviderAttempt[] | null | undefined,
  agentStatus?: string | null
): string {
  if (agentStatus === "unconfigured") return "unconfigured";
  const attempts = Array.isArray(tried) ? tried : [];
  if (!attempts.length) return "no_agent";
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    const cls = attemptClass(attempt);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * The earliest moment any attempted provider says it will be available again, as a delay
 * from now. Absent, unparseable, or already-past stamps read as "no idea" (null) rather
 * than "retry immediately"; the caller's own floor still applies.
 */
export function providerRetryAfterMs(tried: ProviderAttempt[] | null | undefined, now = Date.now()): number | null {
  const stamps = (Array.isArray(tried) ? tried : [])
    .flatMap((attempt) => [attempt?.availability?.resets_at, attempt?.availability?.hold_until])
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((ms) => Number.isFinite(ms) && ms > now);
  if (!stamps.length) return null;
  return Math.min(MAX_PROVIDER_DEFER_MS, Math.min(...stamps) - now);
}

export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailableError";
  readonly operation: string;
  readonly tried: ProviderAttempt[];
  /** Low-cardinality availability class, safe as a telemetry fingerprint segment. */
  readonly dominantState: string;
  /** How long the providers themselves say to wait, when any of them said. */
  readonly retryAfterMs: number | null;

  constructor(operation: string, result: AgenticOpResult = {}, now = Date.now()) {
    const tried = Array.isArray(result.tried) ? result.tried : [];
    const dominantState = dominantAvailabilityState(tried, result.agent_status);
    // Taxonomy only. The op's own `error` string is deliberately NOT the message: it is
    // free text that has already carried provider prose into durable storage.
    super(
      `every configured agent was unavailable for ${telemetryIdentifier(operation, 80, "operation")}: ${dominantState}`
    );
    this.operation = telemetryIdentifier(operation, 80, "operation");
    this.tried = tried;
    this.dominantState = dominantState;
    this.retryAfterMs = providerRetryAfterMs(tried, now);
  }
}

/**
 * Did this agentic result fail because nothing could run it, rather than because the
 * work itself was wrong? `all_failed` (every CLI tried and failed) and `unconfigured`
 * (no CLI is enabled at all) are both availability, not a defect.
 */
export function isProviderUnavailable(result: AgenticOpResult | null | undefined): boolean {
  const status = result?.agent_status;
  return status === "all_failed" || status === "unconfigured";
}

/**
 * The one seam a scheduler task body uses: throw the typed error when the op failed for
 * want of a provider, and the caller's own generic error otherwise (a real contract
 * violation, an unusable draft — things a person should look at).
 */
export function schedulerTaskError(operation: string, result: AgenticOpResult, fallbackMessage: string): Error {
  if (isProviderUnavailable(result)) return new ProviderUnavailableError(operation, result);
  return new Error(String(result?.error || fallbackMessage));
}
