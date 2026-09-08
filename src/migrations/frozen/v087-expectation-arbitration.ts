// Frozen snapshot of src/repo/brain/expectation-arbitration.ts#retireSupersededExpectations as of 2026-09-08 (commit 456211f0); migrations must not track live code.
//
// WHY A COPY AND NOT AN IMPORT. A migration is a statement about what the ladder did
// on the day it shipped. Importing the live module means a fresh install replays that
// migration against TODAY's semantics — a silently different repair from the one every
// existing database received. The live module stays free to evolve; this snapshot does
// not. Do not "fix" a bug here: fix it in the live module and, if old rows need it,
// append a NEW migration.
//
// DO NOT REFORMAT. This file is a verbatim copy; a formatter reflowing it would
// break the one property that makes it auditable — that every line still matches
// the live source it was taken from.

import type { DatabaseSync } from "node:sqlite";

// The decision statuses whose expectations COUNT — the same set
// `overlappingDecisionConfounders` reads, so arbitration and confounding can never disagree
// about which windows are in play. An advisory `review`/`observed` conference prediction is
// outside it in both directions: it neither retires a real change nor is retired by one, and
// stays confounded exactly as its own comment says it should be.
export const ARBITRATED_DECISION_STATUSES = ["applied", "announced"] as const;

// A window that is still ASKING something, and therefore can take part on either side.
export const LIVE_EXPECTATION_STATUSES = ["pending", "mature"] as const;

// A window that has stopped asking: `canceled` means the decision behind it was undone,
// `superseded` means a newer change took its metric over. Neither confounds anything, and
// neither is "matured but unevaluated" — counting them would read as a stalled scheduler.
export const RETIRED_EXPECTATION_STATUSES = ["superseded", "canceled"] as const;

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

// Every (loser, winner) pair the rule recognizes. Written as a symmetric predicate rather
// than "find the rivals of one row" so that scoping it to a single freshly written row gives
// both halves of the write-path behavior at once — the new row losing to a newer window it
// arrived behind, and the new row retiring the older ones it overtook — and dropping the
// scope gives the whole-table repair. A row survives exactly when it loses to nobody.
const SUPERSEDED_PAIRS_SQL = `
  SELECT DISTINCT loser.id AS id
    FROM brain_expectations loser
    JOIN brain_decisions loser_decision ON loser_decision.id = loser.decision_id
    JOIN brain_expectations winner
      ON winner.id <> loser.id
     AND winner.decision_id <> loser.decision_id
     AND winner.metric_key = loser.metric_key
     AND COALESCE(winner.subject_key, '') = COALESCE(loser.subject_key, '')
     AND winner.window_start <= loser.window_end
     AND winner.window_end >= loser.window_start
     AND winner.status IN (${list(LIVE_EXPECTATION_STATUSES)})
     AND (winner.window_start > loser.window_start
          OR (winner.window_start = loser.window_start AND winner.id > loser.id))
    JOIN brain_decisions winner_decision ON winner_decision.id = winner.decision_id
   WHERE loser.status IN (${list(LIVE_EXPECTATION_STATUSES)})
     AND loser_decision.status IN (${list(ARBITRATED_DECISION_STATUSES)})
     AND winner_decision.status IN (${list(ARBITRATED_DECISION_STATUSES)})`;

/**
 * Retire every live window a newer live window has taken over, and return the ids retired.
 *
 * `opts.expectationId` scopes the pass to pairs involving that one row — what a write does.
 * Omitted, it sweeps the whole table, which is what migration 87 needs.
 *
 * ONE pass is enough, and only because the losers are read before any of them is written.
 * Retiring a row can never create a new loser (it only removes a possible winner), and two
 * survivors cannot overlap each other: whichever of them started later would have beaten the
 * other. So the fixpoint is reached immediately, and a second call finds nothing — which is
 * what makes the repair migration idempotent.
 *
 * Two windows on the SAME decision are deliberately untouched: they never confounded each
 * other (`overlappingDecisionConfounders` excludes same-decision rows), so there is nothing
 * to arbitrate, and an apply that legitimately predicts two things about one metric keeps
 * both.
 */
export function retireSupersededExpectations(db: DatabaseSync, opts: { expectationId?: number } = {}): number[] {
  const scoped = Number.isInteger(opts.expectationId) && Number(opts.expectationId) > 0;
  const sql = scoped ? `${SUPERSEDED_PAIRS_SQL}\n     AND (loser.id = ? OR winner.id = ?)` : SUPERSEDED_PAIRS_SQL;
  const args = scoped ? [Number(opts.expectationId), Number(opts.expectationId)] : [];
  const losers = (db.prepare(sql).all(...args) as Array<{ id: number }>)
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!losers.length) return [];
  const update = db.prepare(`UPDATE brain_expectations SET status = 'superseded' WHERE id = ?`);
  for (const id of losers) update.run(id);
  return losers;
}
