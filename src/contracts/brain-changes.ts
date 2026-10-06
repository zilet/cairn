// The Changes feed contract (v2 wave 1, "The team decides, you Undo").
//
// An athlete-facing projection of `brain_decisions` (src/domain/brain/changes-feed.ts):
// what the team changed, why in the spoken voice, one of four fixed outcome phrases, a
// confidence WORD, and the server-owned Undo. Served by `GET /api/brain/changes` and the
// `get_brain_changes` MCP tool; `POST /api/brain/changes/seen` (`mark_brain_changes_seen`)
// moves the "since you last looked" marker the Today line counts from.
//
// Every string here arrives FINISHED — a renderer frames it and never works it out
// again (docs/DESIGN.md "Component architecture", rule 6). No evaluator score,
// coefficient, tier or number-as-grade ever crosses this contract.
//
// Self-contained on purpose: src/client/** reads these types through
// `import("../contracts/brain-changes.js")`, and this module imports nothing.

/** The four fixed outcome phrases (docs/DESIGN.md "Coach-change rationale and outcome language"). */
export const BRAIN_CHANGE_OUTCOME_PHRASES = {
  as_expected: "this moved as expected",
  not_as_expected: "the result didn't match what I expected",
  too_early: "we can't tell yet",
  stopped: "this was stopped before we could tell",
} as const;

export type ClientBrainChangeOutcomeKey = keyof typeof BRAIN_CHANGE_OUTCOME_PHRASES;

export interface ClientBrainChangeOutcome {
  key: ClientBrainChangeOutcomeKey;
  /** One of BRAIN_CHANGE_OUTCOME_PHRASES, verbatim. */
  phrase: (typeof BRAIN_CHANGE_OUTCOME_PHRASES)[ClientBrainChangeOutcomeKey];
}

/** Confidence is a word, never a number. */
export type ClientBrainChangeConfidence = "tentative" | "observed" | "strong";

/**
 * Where the change stands:
 * - `announced` — decided, lands at `lands_on` (Undo holds it before it lands);
 * - `applied` — in effect (Undo restores the server's snapshot);
 * - `reverted` — put back with Undo;
 * - `held` — an announced change the athlete held before it landed.
 */
export type ClientBrainChangeState = "announced" | "applied" | "reverted" | "held";

export interface ClientBrainChangeUndo {
  /** True only when the server's revert path can take this change back right now. */
  available: boolean;
  /** Server-owned, names the concrete effect ("Restore previous Bench Press target"); null when unavailable. */
  label: string | null;
}

export interface ClientBrainChange {
  /** The durable `brain_decisions` id — what Undo posts to `/api/brain/decisions/:id/revert`. */
  id: number;
  /** Local YYYY-MM-DD the row is grouped under (the day it landed, or was decided when still announced). */
  day: string;
  state: ClientBrainChangeState;
  domain: string;
  /** The finished headline: what changed. */
  title: string;
  /** Why, in the spoken voice. Null when nothing athlete-facing was written. */
  why: string | null;
  /** A short timing line: "Lands Monday", "Landed today", "Put back", "Held before it landed". */
  status_line: string;
  /** Local YYYY-MM-DD it lands on, for an announced change; null otherwise. */
  lands_on: string | null;
  outcome: ClientBrainChangeOutcome;
  confidence: ClientBrainChangeConfidence;
  undo: ClientBrainChangeUndo;
  /** True when the team made this change after the athlete last opened the feed. */
  new: boolean;
  /**
   * The athlete's OWN words when this change is what they said (a push stance, a stated
   * quality session): the row reads "You said X → the brain changed Y", with `title` the
   * Y and `why` opening on the quote. Absent on a change the team decided.
   */
  said?: string | null;
}

export interface ClientBrainChangeDay {
  /** Local YYYY-MM-DD. */
  day: string;
  /** "Today", "Yesterday", a weekday within the week, else "Sep 14". */
  label: string;
  changes: ClientBrainChange[];
}

/**
 * A held draft the team SET ASIDE instead of applying it — housekeeping, not a change:
 * nothing moved. One quiet, finished line in plain words ("An older draft for Back Squat
 * was set aside: a newer review replaced it."), never the draft's own agent text, an
 * ISO date or a threshold. It never counts toward `since_seen` and carries no Undo.
 */
export interface ClientBrainSetAside {
  /** The receipt's `brain_decisions` id. */
  id: number;
  /** Local YYYY-MM-DD it was set aside. */
  day: string;
  /** "Today", "Yesterday", a weekday within the week, else "Sep 14". */
  label: string;
  /** The finished sentence. */
  line: string;
}

export interface ClientBrainChanges {
  /** Local YYYY-MM-DD the read was built for. */
  as_of: string;
  /** Newest day first; rows newest first within a day. */
  days: ClientBrainChangeDay[];
  /** How many rows carry `new: true` — the Today line's count. Zero hides the line. */
  since_seen: number;
  /** The Today line itself ("2 changes overnight"); null when `since_seen` is zero. */
  since_seen_line: string | null;
  /** ISO instant of the current seen marker; null before the feed was ever opened. */
  seen_at: string | null;
  /** ISO instant to pass back as `through` when marking this read seen, so a change that lands meanwhile stays new. */
  seen_through: string;
  /** Held drafts set aside inside the window, newest first; empty when none. */
  set_aside: ClientBrainSetAside[];
}

export interface ClientBrainChangesSeenRequest {
  /** ISO instant the feed was read at (`seen_through`); defaults to now. The marker never moves backwards. */
  through?: string;
}

export interface ClientBrainChangesSeenResponse {
  ok: boolean;
  /** The marker now in force. */
  seen_at: string;
}
