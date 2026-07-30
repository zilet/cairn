import type { DatabaseSync } from "node:sqlite";

// Who owns a metric when two changes reach for it at once.
//
// THE PROBLEM. `overlappingDecisionConfounders` (src/domain/brain/evaluation-service.ts)
// forces an inconclusive verdict on ANY expectation whose metric + subject window overlaps
// another live decision's, and it is right to: two changes racing over one outcome genuinely
// cannot be told apart. But the writers fire far faster than the windows close. An applied
// training proposal opens 14-28 day windows on every exercise it touched
// (src/repo/profile.ts), auto-progression applies several times a week, an accepted meal plan
// opens a 28-day intake window (src/repo/nutrition.ts). Left alone, every pair silences both
// halves, and the ledger — the whole apparatus for finding out whether the coach's changes
// work — learns nothing at all.
//
// THE RULE. The NEWEST change owns the metric. A window is retired ("superseded") when
// another still-live window from a DIFFERENT decision covers part of the same metric +
// subject and started later; ties go to the row written last. Exactly one live window per
// metric + subject, so the survivor can reach a real verdict.
//
// This is the same move `recordBlockDecision` (src/repo/program-blocks.ts:180-183) already
// makes for `vo2max_trend`, only generalized and from the other side: there, a duplicate
// aerobic window is never opened; here, the older one steps aside. That guard stays where it
// is — it is deliberately WIDER than this rule (it counts any non-terminal decision, not only
// applied/announced ones), so it keeps suppressing the write before this ever sees the row.
//
// This module owns the rule as ONE predicate, parameterized by the database handle, so the
// live write path (src/repo/brain-decisions.ts) and the data-repair migration that applied it
// to rows written before it existed (migration 87) cannot drift apart. It imports no `db`
// singleton precisely so a migration can call it: db.ts statically imports migrate.ts, and a
// module reaching back for the singleton would close that cycle.

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
