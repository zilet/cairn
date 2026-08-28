// ============================================================================
// protective-fuel-draft.ts — the identity of ONE deliberate draft shape.
//
// The deterministic under-fuelling loop writes a `nutrition_target` draft that
// asks the athlete for one bounded step toward maintenance. Under a coach-led
// posture that ask lands at the `ask` tier as an ordinary `requested_review`
// hold — and Today's attention filter deliberately drops `requested_review`,
// because most rows carrying it are bookkeeping that resolves itself.
//
// This one does not resolve itself. It is a QUESTION, addressed to the athlete,
// that changes nothing until they answer it, and an ask nobody ever sees is
// indistinguishable from no ask at all: on the live box it sat open for days
// while the athlete had no surface on which it appeared. So this exact shape —
// and only this shape — is admitted to the attention surface alongside the
// safety/lock/policy/clinical boundaries.
//
// The identity lives here rather than in either reader so the SQL filter
// (`listAttentionReviewHeldProposals`) and the TS filter (`planDraftCandidate`)
// cannot drift apart, and so the write side (`underfueling-service`) keys off
// the same two strings it always did.
// ============================================================================

/** The agent name every automatic protective-fuel draft is written under. */
export const UNDERFUEL_BRAIN_AGENT = "underfuel-brain";

/** The single-source instruction those drafts carry. */
export const PROTECTIVE_FUEL_INSTRUCTION = "auto: protective fuel correction";

/**
 * Is this hydrated proposal the standing protective-fuel ask? Narrow on purpose:
 * the source agent AND its instruction AND an `ask`-tier decision still sitting
 * in `review`. Anything else carrying `requested_review` stays excluded.
 */
export function isProtectiveFuelAsk(proposal: unknown): boolean {
  const row = proposal as any;
  if (!row || typeof row !== "object") return false;
  if (String(row.agent ?? "") !== UNDERFUEL_BRAIN_AGENT) return false;
  if (String(row.instruction ?? "") !== PROTECTIVE_FUEL_INSTRUCTION) return false;
  return String(row.autonomy?.status ?? "") === "review" && String(row.autonomy?.tier ?? "") === "ask";
}

/**
 * The same test as a SQL fragment, over a `plan_proposals p` row and a correlated
 * `brain_decisions d`. Kept beside its TS twin so the two cannot drift.
 */
export const PROTECTIVE_FUEL_ASK_SQL = `(
  p.agent = '${UNDERFUEL_BRAIN_AGENT}'
  AND p.instruction = '${PROTECTIVE_FUEL_INSTRUCTION}'
  AND d.kind = 'nutrition_target'
  AND d.domain = 'nutrition'
  AND d.autonomy_tier = 'ask'
)`;
