// The durable half of provider availability.
//
// src/agentAvailability.ts decides WHAT a failure was and how long to believe
// it; this module remembers it across restarts. Persisted because a weekly quota
// outlives a container restart — the process-local circuit breaker in agents.ts
// deliberately does not, and is left exactly as it is.
//
// A row is a PREDICTION with an expiry: once `hold_until` passes, reads return
// null and the provider is a first-class candidate again. Any success clears the
// row outright (see clearAgentAvailability).
import { db } from "../db.js";
import type { AgentFailure } from "../agentAvailability.js";
import { holdUntil } from "../agentAvailability.js";

export interface AgentAvailabilityRow {
  agent: string;
  state: string;
  detail: string | null;
  window: string | null;
  resets_at: string | null;
  hold_until: string | null;
  observed_at: string;
  op: string | null;
  streak: number;
}

function rowFrom(raw: any): AgentAvailabilityRow | null {
  if (!raw) return null;
  return {
    agent: String(raw.agent),
    state: String(raw.state),
    detail: raw.detail == null ? null : String(raw.detail),
    window: raw.window == null ? null : String(raw.window),
    resets_at: raw.resets_at == null ? null : String(raw.resets_at),
    hold_until: raw.hold_until == null ? null : String(raw.hold_until),
    observed_at: String(raw.observed_at),
    op: raw.op == null ? null : String(raw.op),
    streak: Number(raw.streak) || 0,
  };
}

function held(row: AgentAvailabilityRow | null, now: Date): boolean {
  if (!row?.hold_until) return false;
  const until = new Date(row.hold_until).getTime();
  return Number.isFinite(until) && until > now.getTime();
}

/** The raw row regardless of expiry — for the streak, and for tests. */
export function readAgentAvailabilityRow(agent: string): AgentAvailabilityRow | null {
  return rowFrom(db.prepare(`SELECT * FROM agent_availability WHERE agent = ?`).get(String(agent)));
}

/**
 * Record what a failed run told us. The streak only advances while the SAME
 * state repeats, so a rate-limit back-off grows but a different failure restarts
 * the ladder honestly.
 */
export function noteAgentFailure(
  agent: string,
  failure: AgentFailure,
  op: string | null = null,
  now: Date = new Date()
): AgentAvailabilityRow | null {
  const name = String(agent || "").trim();
  if (!name) return null;
  const previous = readAgentAvailabilityRow(name);
  const streak = previous && previous.state === failure.state ? previous.streak + 1 : 1;
  const hold = holdUntil(failure, streak - 1, now);
  if (!hold) {
    // A non-holding class (permission/invalid/process) is not durable state —
    // the breaker owns those. Never leave a stale hold behind for it.
    clearAgentAvailability(name);
    return null;
  }
  db.prepare(
    `INSERT INTO agent_availability (agent, state, detail, "window", resets_at, hold_until, observed_at, op, streak)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET
       state=excluded.state, detail=excluded.detail, "window"=excluded."window",
       resets_at=excluded.resets_at, hold_until=excluded.hold_until,
       observed_at=excluded.observed_at, op=excluded.op, streak=excluded.streak`
  ).run(
    name,
    failure.state,
    failure.detail ? String(failure.detail).slice(0, 160) : null,
    failure.window ?? null,
    failure.resets_at ?? null,
    hold,
    now.toISOString(),
    op ? String(op).slice(0, 60) : null,
    streak
  );
  return readAgentAvailabilityRow(name);
}

/** A success (or a completed login) is proof the provider answers. Forget everything. */
export function clearAgentAvailability(agent: string): void {
  const name = String(agent || "").trim();
  if (!name) return;
  db.prepare(`DELETE FROM agent_availability WHERE agent = ?`).run(name);
}

/** The live hold for one agent, or null once it has expired. */
export function getAgentAvailability(agent: string, now: Date = new Date()): AgentAvailabilityRow | null {
  const row = readAgentAvailabilityRow(agent);
  return held(row, now) ? row : null;
}

/** Every live hold, newest observation first. */
export function listAgentAvailability(now: Date = new Date()): AgentAvailabilityRow[] {
  const rows = db.prepare(`SELECT * FROM agent_availability ORDER BY observed_at DESC`).all() as any[];
  return rows.map(rowFrom).filter((r): r is AgentAvailabilityRow => held(r, now));
}
