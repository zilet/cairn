// ============================================================================
// Which logged sessions COUNT as a comparable strength exposure — the one
// question "was this lift actually trained since?" reduces to.
//
// A LEAF module by construction: it imports only `db`, the recovery-dose ledger
// read and the training-cache clear registry (whose registered clears run from
// the test isolate's full reset, not from production writes — a session's
// cached eligibility lives for the process, same as it always has), and it
// must never import program-state,
// coach, or whole-person-trajectory. That is the whole reason it exists as its
// own file. The trajectory read (repo/whole-person-trajectory.ts) needs this
// counter, program-state.ts needs it too, and program-state reaches up into
// coach.ts, which reaches back into whole-person-trajectory.ts — so importing
// the counter from its old home closed a three-module cycle that only happened
// to survive because every edge in it resolves at call time. Pulling the
// counter down here breaks the cycle structurally instead of relying on that.
//
// program-state.ts re-exports `comparableLiftDates`, so every existing caller
// and test keeps importing it from where it has always been.
// ============================================================================
import { db } from "../db.js";
import { recoverySessionDose } from "./training-read.js";
import { registerTrainingCacheClear } from "./training-cache.js";

// A deliberately reduced, compliant recovery exposure is not a failed strength
// test. Keep the raw log intact, but exclude that session from comparable-lift
// trajectory math. Above-plan / overdosed / unknown sessions remain ordinary
// evidence. The recovery-dose ledger is the one policy owner for this decision.
let trajectorySessionEligibility = new Map<number, boolean>();
registerTrainingCacheClear(() => {
  trajectorySessionEligibility = new Map();
});

export function sessionCountsTowardLiftTrajectory(sessionId: number): boolean {
  const id = Number(sessionId);
  const cached = trajectorySessionEligibility.get(id);
  if (cached != null) return cached;
  const eligible = recoverySessionDose(id).classification !== "compliant";
  trajectorySessionEligibility.set(id, eligible);
  return eligible;
}

// `through` is the day being read. liftStates() already scopes which lifts EXIST
// as of that date, but every grade underneath it was computed from the full
// history — so a read of an earlier date graded the lift, its trend and its
// push/hold/deload status from sets logged AFTER it. Same bug class as the
// programState/trainingSignals date-scoping, one layer down.
// Also the counter the whole-person trajectory read asks when it tests whether
// an explanation for a slide has outlived itself: "how many times was this lift
// ACTUALLY trained since?" — where a compliant recovery week must not be
// mistaken for exposure. One counter, one answer.
export function comparableLiftDates(name: string, through: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.id AS session_id, s.date AS date
       FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id
      WHERE e.name = ? COLLATE NOCASE AND s.date <= ?
      ORDER BY s.date, s.id`
    )
    .all(name, through) as any[];
  return new Set(
    rows.filter((row) => sessionCountsTowardLiftTrajectory(Number(row.session_id))).map((row) => String(row.date))
  );
}
