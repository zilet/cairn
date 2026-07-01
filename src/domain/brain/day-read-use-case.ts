import { agentStatusFor } from "../../coachOps.js";
import { db } from "../../db.js";
import { computeDayRead, localToday } from "../../dayread.js";
import { dayRead, forwardLook, getCachedDayRead, invalidateDayRead } from "../../repo/intelligence.js";
import { recordSuggestion } from "../../repo/memory.js";
import { getTrajectory } from "../../repo/trajectory.js";

type AgentStatus = ReturnType<typeof agentStatusFor>;

export interface DayReadResult {
  kind: "train" | "easy" | "rest" | "done";
  focus: string | null;
  why: string;
  est_minutes: number | null;
  signals: Record<string, unknown>;
  headline?: string;
  source?: string;
  cached?: boolean;
  forward: string | null;
  arc: string | null;
  agent_status?: AgentStatus;
  error?: string;
  [key: string]: unknown;
}

export interface ReadTodayOptions {
  date?: string;
  override?: string;
  agent?: string;
  reset?: boolean;
  recordOutcome?: boolean;
}

function dayReadHeadline(read: { kind: string; focus?: string | null }): string {
  return read.kind === "done"
    ? "You're done for today."
    : read.kind === "rest"
      ? "Rest today."
      : read.kind === "easy"
        ? "Take it easy."
        : read.focus
          ? `${read.focus}.`
          : "Good to train.";
}

export function attachDayReadContext(readDate: string, read: Record<string, unknown>): DayReadResult {
  let arc: string | null = null;
  try {
    arc = getTrajectory(readDate)?.line ?? null;
  } catch {
    arc = null;
  }

  let forward: string | null = null;
  if (read?.kind !== "done") {
    try {
      forward = forwardLook(readDate).text || null;
    } catch {
      forward = null;
    }
  }

  return { ...read, forward, arc } as DayReadResult;
}

// Record the Brief suggestion for outcome learning, idempotent for the canonical
// read and intentionally non-idempotent for steered override reads.
export function recordDayReadSuggestion(date: string, read: Record<string, unknown>, override?: string | null): void {
  try {
    if (!override) {
      const existing = db
        .prepare(`SELECT 1 FROM suggestions WHERE kind = 'day_read' AND date = ? AND payload_json LIKE '%"override":null%' LIMIT 1`)
        .get(date);
      if (existing) return;
    }
    recordSuggestion("day_read", date, {
      kind: read?.kind ?? null,
      focus: read?.focus ?? null,
      est_minutes: read?.est_minutes ?? null,
      override: override ?? null,
    });
  } catch {
    // Outcome recording is best-effort and must never block the Brief.
  }
}

export async function readToday(options: ReadTodayOptions = {}): Promise<DayReadResult> {
  const { date, override, agent, reset, recordOutcome = false } = options;
  const readDate = date || localToday();

  try {
    if (reset) {
      invalidateDayRead(readDate);
      const read = await computeDayRead({ date, agent });
      if (recordOutcome) recordDayReadSuggestion(readDate, read, null);
      return attachDayReadContext(readDate, { ...read, agent_status: agentStatusFor(read) });
    }

    if (!override) {
      const cached = getCachedDayRead(readDate);
      if (cached) {
        if (recordOutcome) recordDayReadSuggestion(readDate, cached, null);
        return attachDayReadContext(readDate, { ...cached, cached: true, agent_status: agentStatusFor(cached) });
      }
    }

    const read = await computeDayRead({ date, override, agent });
    if (recordOutcome) recordDayReadSuggestion(readDate, read, override ?? null);
    return attachDayReadContext(readDate, { ...read, agent_status: agentStatusFor(read) });
  } catch (e: any) {
    const fallback = dayRead(date);
    return attachDayReadContext(readDate, {
      ...fallback,
      headline: dayReadHeadline(fallback),
      source: "deterministic",
      error: e?.message ?? String(e),
    });
  }
}
