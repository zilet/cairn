// The change receipt contract (v2 wave 2, "say what changed and why").
//
// One uniform, finished line for a change the server made: WHAT changed, from WHEN, until
// WHEN (a scoped race adaptation ends by itself), where it stands, and the server-owned
// Undo. Built by src/repo/change-receipt.ts from a `brain_decisions` row or a
// `plan_adaptations` row — never from model prose. Carried by:
//   - a chat assistant message (`receipts`): exactly the changes that landed that turn;
//   - each Changes feed item (`receipt`, src/contracts/brain-changes.ts).
//
// Undo routes (the existing ones; nothing new):
//   - `{ kind: "brain_decision", id }` → `POST /api/brain/decisions/:id/revert`
//     (MCP `revert_brain_decision`). An applied change is restored from the server's
//     snapshot; a scheduled (announced) one is held before it lands. A plan adaptation's
//     Undo is the Undo of the decision that made it (or of the after-the-race restore),
//     so an adaptation receipt also carries `kind: "brain_decision"`.
//   - `{ kind: "plan_adaptation", id }` is reserved: there is no adaptation-level route,
//     and the builders never emit it.
//
// Every string arrives FINISHED — a renderer prints it (escHtml) and never works it out
// again. No score, tier or number-as-grade crosses it. Self-contained: imports nothing.

export type ChangeReceiptUndo = { kind: "brain_decision"; id: number } | { kind: "plan_adaptation"; id: number };

// Where the change stands:
//   applied    — it landed and is in force;
//   scheduled  — decided, landing on its own ("Lands Thursday" / "Lands soon", the
//                Changes feed's words) — nobody is waiting on an answer;
//   undone     — put back, held before it landed, or a scoped change that has ended;
//   not_landed — a stored receipt whose change was later refused or held for a look:
//                it never took effect.
export type ChangeReceiptStatus = "applied" | "scheduled" | "undone" | "not_landed";

export interface ChangeReceipt {
  /** Stable id: "decision:<brain_decisions.id>" | "adaptation:<plan_adaptations.id>". */
  key: string;
  /** What changed, finished: "Back Squat adapted for the race until Nov 1". */
  what: string;
  /** Local YYYY-MM-DD the change first applies to. */
  when?: string | null;
  /** Local YYYY-MM-DD a scoped change ends on (the regular plan returns the day after). */
  until?: string | null;
  /** The end, in words: "Ends after the race (Nov 1)" / "Ends after Nov 1". */
  until_words?: string | null;
  /** The server-owned Undo, present only while the server's revert path would take it. */
  undo?: ChangeReceiptUndo | null;
  status: ChangeReceiptStatus;
  /**
   * The state in words when it is not simply "applied": "Lands Thursday", "Put back",
   * "Held before it landed", "Ended", "Didn't land". Re-worded on every read.
   */
  status_words?: string | null;
}
