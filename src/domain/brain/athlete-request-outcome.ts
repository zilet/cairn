import type { BrainDecision } from "../../brain/decision-contract.js";
import { getBrainDecision, patchBrainDecision } from "../../repo/brain-decisions.js";
import { addChatMessage } from "../../repo/chat.js";
import { recordAsyncFailure } from "../../diagnostics.js";
import { parseDbTime } from "../../repo/shared.js";

// ---- THE ATHLETE'S OWN REQUEST IS ANSWERED, NEVER SILENTLY SET ASIDE --------------
//
// A change the athlete asked for in their own words (a chat plan edit, their own
// restructure) is THEIR decision. When one cannot land — the plan moved under it past
// what a rebuild can answer, an apply refused it, it waited past its ceiling — the
// ending used to be a `superseded` ledger row no athlete surface reads: live, a chat
// "rebuild today's session" was held, then set aside at the next 04:00 sweep, and nobody
// told the person who asked. So every such ending also answers them, in chat, once, in
// plain words — pull-only (it waits in the conversation, never a notification).

type DecisionRef = { id?: number | null; summary?: unknown; action?: unknown; context?: unknown };

const DAY_MS = 86_400_000;

export function decisionWasTheAthletesRequest(decision: { context?: unknown } | null | undefined): boolean {
  const context = (decision?.context ?? {}) as Record<string, any>;
  // A legacy background-chat draft the orphan sweep adopted is routed with the explicit
  // flag for its boundary, but it was the coach reading a chat signal — not the athlete's
  // own words — so its endings are ledger receipts, not chat replies.
  if (context.orphan_sibling_cleanup?.provenance === "background_chat") return false;
  return context.explicit_user_request === true || context.athlete_requested_restructure === true;
}

// The row as it stands NOW — a sweep walks a list read at its start, and an earlier step
// of the same sweep may already have stamped this decision — plus its context.
function currentDecision(decision: DecisionRef | null | undefined): {
  id: number;
  row: DecisionRef | null | undefined;
  context: Record<string, any>;
} {
  const id = Number(decision?.id);
  const row = (id > 0 ? getBrainDecision(id) : null) ?? decision;
  return { id, row, context: ((row as DecisionRef | null | undefined)?.context ?? {}) as Record<string, any> };
}

export function tellAthleteTheirRequestDidNotLand(decision: DecisionRef | null | undefined, why: string): void {
  try {
    if (!(Number(decision?.id) > 0)) return;
    const { id, row, context } = currentDecision(decision);
    // Once per request: every later sweep that walks the same row stays quiet.
    if (context.athlete_told_at) return;
    const asked = String(row?.summary ?? "")
      .trim()
      .replace(/[.!\s]+$/, "")
      .slice(0, 200);
    const text = `${asked ? `The change you asked for — ${asked} — didn't land.` : "A change you asked for didn't land."} ${why.trim()} Nothing on your plan changed from it; ask again and I'll build it from where you are now.`;
    addChatMessage("assistant", text, null, {
      kind: "request_outcome",
      decision_id: id,
      proposal_id: Number((row?.action as any)?.proposal_id) || null,
    });
    patchBrainDecision(id, {
      context: { ...context, athlete_told_at: new Date().toISOString(), athlete_told: text.slice(0, 700) },
    });
  } catch (err) {
    // The chat line is the athlete-facing half; losing it must never abort a sweep.
    recordAsyncFailure("apply", "tell_athlete_request_outcome", err);
  }
}

// An apply error in words a person can read: the plan-quality prefix is dropped (the
// messages behind it are already sentences), and a bare machine error is not repeated.
export function plainApplyRefusal(reason: string): string {
  const text = String(reason ?? "")
    .replace(/^Plan quality check failed:\s*/i, "")
    .trim();
  if (!text || /^(?:Error|TypeError|SqliteError)\b|\bproposal \d+\b/i.test(text))
    return "it no longer fit the plan as it stands.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// The age-ceiling ending, as the athlete hears it (the thaw's set-aside and the
// boundary's age ceiling say the same thing).
export function agedRequestReason(ceilingDays: number): string {
  return `It waited more than ${ceilingDays} days for its day, so it no longer described your week.`;
}

// ---- HOW LONG A HELD DRAFT STAYS CURRENT ------------------------------------------

/** The age past which a held draft no longer describes the athlete's week: a
 * restructure gets two weeks, every other change one. */
export function draftAgeCeilingDays(shape: { kind: string }): number {
  return shape.kind === "training_structure" ? 14 : 7;
}

/** Days since a proposal was drafted; NaN when its stamp is unreadable, so every
 * comparison against a ceiling is false (neither aged nor current). */
export function draftAgeDays(proposal: { created_at?: unknown } | null | undefined, now = Date.now()): number {
  const createdAt = parseDbTime(proposal?.created_at)?.getTime() ?? Number.NaN;
  return (now - createdAt) / DAY_MS;
}

// ---- A SWEEP ANSWERS WHAT IS STILL CURRENT, AND NEVER IN A BURST -----------------
//
// Both deterministic sweeps end athlete requests — the thaw (which re-reads every row an
// older pass stamped, THAW_PASS_VERSION) and the boundary pass (whose age ceiling retires
// whatever waited too long). The first of either after a deploy can walk requests that
// are weeks old, and telling the athlete about each one would land a stack of "the change
// you asked for didn't land" lines about things they asked for a month ago. So a sweep
// ending tells only when the request is still current — inside its own age ceiling, plus
// the grace a daily sweep needs to catch it at expiry — and at most
// REQUEST_TELLS_PER_SWEEP times a sweep, counted on ONE budget the scheduler tick shares
// across both passes. Any other ending is closed silently with its receipt (the ledger
// still reads it), and the row is stamped so no later pass tells it either: once per
// decision, told or not.
const REQUEST_TELLS_PER_SWEEP = 2;
const REQUEST_TELL_GRACE_DAYS = 2;

/** How many "your request didn't land" lines a sweep may still write. One per tick,
 * shared by the thaw and the boundary pass (see scheduler.ts). */
export interface RequestTellBudget {
  remaining: number;
}

export function newRequestTellBudget(): RequestTellBudget {
  return { remaining: REQUEST_TELLS_PER_SWEEP };
}

function sweepMayTellAthlete(
  decision: BrainDecision,
  proposal: { created_at?: unknown } | null | undefined,
  ceilingDays: number,
  tells: RequestTellBudget,
  isRequest: boolean = decisionWasTheAthletesRequest(decision)
): boolean {
  if (!isRequest) return false;
  const { id, context } = currentDecision(decision);
  // Already answered: nothing to spend, and tellAthleteTheirRequestDidNotLand stays quiet.
  if (context.athlete_told_at || context.athlete_not_told) return false;
  const current = draftAgeDays(proposal) <= ceilingDays + REQUEST_TELL_GRACE_DAYS;
  if (current && tells.remaining > 0) {
    tells.remaining -= 1;
    return true;
  }
  if (id > 0) {
    try {
      patchBrainDecision(id, {
        context: { ...context, athlete_not_told: current ? "sweep_cap" : "request_not_current" },
      });
    } catch (err) {
      recordAsyncFailure("apply", "sweep_request_not_told", err);
    }
  }
  return false;
}

/** A sweep ending that answers the athlete when it may (sweepMayTellAthlete) — the gate
 * and the chat line, always together. `isRequest` defaults to the ledger's own flag; the
 * boundary pass also passes a restructure the athlete asked for by instruction
 * (isAthleteRequestedRestructure). */
export function tellAthleteFromSweep(
  decision: BrainDecision,
  proposal: { created_at?: unknown } | null | undefined,
  ceilingDays: number,
  tells: RequestTellBudget,
  why: string,
  isRequest?: boolean
): void {
  if (sweepMayTellAthlete(decision, proposal, ceilingDays, tells, isRequest ?? decisionWasTheAthletesRequest(decision)))
    tellAthleteTheirRequestDidNotLand(decision, why);
}
