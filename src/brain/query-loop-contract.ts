import { asRecord } from "./contract-utils.js";
import { normalizeCoachReadToolRequest, type CoachReadToolRequest } from "./read-tools.js";

export const COACH_READ_TURN_KIND = "coach_read" as const;

export interface CoachReadQueryTurn {
  kind: typeof COACH_READ_TURN_KIND;
  requests: CoachReadToolRequest[];
}

/**
 * True when an agent is attempting the query-loop protocol. Kept separate from
 * normalization so a malformed tool turn cannot accidentally be accepted as the
 * operation's final domain payload.
 */
export function isCoachReadQueryTurn(value: unknown): boolean {
  return asRecord(value)?.kind === COACH_READ_TURN_KIND;
}

/** Closed, all-or-nothing normalization: every requested read must be in the
 * frozen catalog and within its argument bounds before any of them executes. */
export function normalizeCoachReadQueryTurn(value: unknown): CoachReadQueryTurn | null {
  const input = asRecord(value);
  if (!input || input.kind !== COACH_READ_TURN_KIND || !Array.isArray(input.requests) || !input.requests.length)
    return null;
  const requests: CoachReadToolRequest[] = [];
  for (const candidate of input.requests) {
    const request = normalizeCoachReadToolRequest(candidate);
    if (!request) return null;
    requests.push(request);
  }
  return { kind: COACH_READ_TURN_KIND, requests };
}
