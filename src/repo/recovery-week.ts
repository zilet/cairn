import { db } from "../db.js";
import { getProposal, proposalSummary, setProposalStatus } from "./proposals.js";
import {
  cancelRecoveryCycleForProposal,
  recoveryCycleAt,
  recoveryCycleCooldown,
} from "./recovery-cycles.js";
import {
  activeRecoveryWeekLedger,
  clearRecoveryWeekStampIfOwned,
  clearRecoveryWeekStampIfOwnedStrict,
  RECOVERY_WEEK_ACTIVE_DAYS,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
} from "./recovery-week-ledger.js";
import { recoveryWeekMayBeAnnounced } from "./recovery-refusal.js";
import { localDateISO } from "./shared.js";

// Keep these public through recovery-week/repo without duplicating the ledger's
// source of truth. The explicit local export is also legible to source-contract checks.
export { RECOVERY_WEEK_ACTIVE_DAYS, RECOVERY_WEEK_INSTRUCTION_PREFIX };

// The conductor's one-tap "Draft my recovery week" is tagged by this instruction
// PREFIX (the client sends the full instruction; the prefix is the stable contract —
// test/engineeringContracts.test.js pins the client text to it). Two consumers:
// pendingRecoveryDraft() flips the Program button into a "Review your recovery
// week →" link while a draft waits, and supersedeRecoveryWeekDrafts() retires the
// prior draft when a fresh one lands so repeated taps never pile up drafts.
// The canonical full recovery-week instruction — shared by the lead-mode auto-draft
// (scheduler) and kept prefix-compatible with the PWA's one-tap draft so the
// drafted/active state machine (pendingRecoveryDraft, supersedeRecoveryWeekDrafts)
// treats both sources as the same thing.
export const RECOVERY_WEEK_INSTRUCTION =
  "Reshape next week into a RECOVERY (deload) week: cut working-set volume roughly in half, " +
  "keep every movement pattern, keep efforts easy and crisp (3-4 reps in reserve), no new " +
  "exercises and no load PRs — an earned reset after sustained loading, so the athlete comes back stronger.";

// Whether the lead-mode coach should draft the recovery week ITSELF right now: the
// conductor is asking for one (a recovery lead that is neither running nor already
// drafted), the athlete has chosen the lead posture, and no open/cooldown cycle
// already owns the recovery window. The scheduler owns the ≤1×/day cadence stamp.
// This is what keeps the conductor's "your coach sets
// this up automatically" copy honest: the same read that makes the promise is the
// read that triggers the draft.
export function shouldAutoDraftRecoveryWeek(opts: {
  lead_mode?: unknown;
  focus_lead_domain?: unknown;
  recovery_active?: unknown;
  status: unknown;
  deload_due?: unknown;
  mesocycle_phase?: unknown;
}): boolean {
  const deloadDue =
    opts.deload_due === true || String(opts.mesocycle_phase ?? "") === "deload-due";
  const requested =
    String(opts.lead_mode) === "lead" &&
    String(opts.focus_lead_domain) === "recovery" &&
    opts.recovery_active !== true &&
    opts.status == null &&
    deloadDue;
  if (!requested) return false;
  const today = localDateISO();
  // The athlete's "no" to a recovery week stands for the block unless something
  // safety-grade has arrived since — the same one rule the announcement asks.
  return recoveryCycleCooldown(today).allowed && recoveryWeekMayBeAnnounced(today).allowed;
}

export function pendingRecoveryDraft(): { id: number } | null {
  // parsed_json IS NOT NULL: a failed agent run persists an unparseable draft row —
  // that is a retry case, not a reviewable recovery week.
  const row = db
    .prepare(
      `SELECT id FROM plan_proposals
        WHERE status = 'draft' AND parsed_json IS NOT NULL AND instruction LIKE ?
        ORDER BY id DESC LIMIT 1`
    )
    .get(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`) as any;
  return row ? { id: Number(row.id) } : null;
}

export function supersedeRecoveryWeekDrafts(exceptId?: number) {
  const drafts = db
    .prepare(`SELECT id FROM plan_proposals WHERE status = 'draft' AND instruction LIKE ?`)
    .all(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`) as any[];
  let retired = 0;
  for (const d of drafts) {
    if (exceptId != null && Number(d.id) === Number(exceptId)) continue;
    // Through setProposalStatus so a standing announced/pending decision is canceled too.
    setProposalStatus(Number(d.id), "superseded");
    retired++;
  }
  return retired;
}

// The recovery-week story as ONE state the surfaces read — an elite coach doesn't
// hand you a silently-halved week. Three states: a draft is waiting ('drafted' —
// actionable, wins over informational), the applied week is running ('applied',
// active for RECOVERY_WEEK_ACTIVE_DAYS from the apply stamp), or null. The Plan
// banner, the conductor's recovery lead, and the Program button all speak from this.
export type RecoveryWeekStatus =
  | { state: "drafted"; proposal_id: number; summary: string | null }
  | { state: "upcoming"; proposal_id: number; decision_id: number; effective_date: string; summary: string | null }
  | {
      state: "applied";
      applied_on: string;
      until: string;
      summary: string | null;
      cycle_id?: number | null;
      effective_status?: "active" | "recheck";
    }
  | null;

export type ActiveRecoveryWeek = Extract<RecoveryWeekStatus, { state: "applied" }>;

// The authoritative date-bound answer to "is the reduced recovery plan running?".
// It is ledger state, never inferred from a proposal summary or agent prose. The
// optional date keeps historical reads and deterministic tests independent of the
// wall clock; the interval is [applied_on, until), matching the seven plan dates.
export function activeRecoveryWeek(date = localDateISO()): ActiveRecoveryWeek | null {
  const cycle = recoveryCycleAt(date);
  if (
    cycle &&
    !cycle.legacy &&
    (cycle.effective_status === "active" || cycle.effective_status === "recheck")
  ) {
    return {
      state: "applied",
      applied_on: cycle.effective_on,
      until: cycle.exit_on,
      summary: cycle.reason,
      cycle_id: cycle.id,
      effective_status: cycle.effective_status,
    };
  }
  const ledger = activeRecoveryWeekLedger(date);
  if (!ledger) return null;
  return {
    state: "applied",
    applied_on: ledger.applied_on,
    until: ledger.until,
    summary: proposalSummary({ parsed: ledger.parsed }),
  };
}

export function recoveryWeekStatus(date = localDateISO()): RecoveryWeekStatus {
  // A running week is the primary truth even if a later draft exists. Surfaces may
  // still show that future draft after this window closes, but never at the cost of
  // making the active deload disappear from the daily/program brain.
  const active = activeRecoveryWeek(date);
  if (active) return active;
  const draft = pendingRecoveryDraft();
  if (draft) {
    const p = getProposal(draft.id);
    if ((p?.autonomy?.status === "announced" || p?.autonomy?.status === "pending") && p.autonomy.effective_date) {
      return {
        state: "upcoming",
        proposal_id: draft.id,
        decision_id: Number(p.autonomy.id),
        effective_date: String(p.autonomy.effective_date),
        summary: proposalSummary(p),
      };
    }
    return { state: "drafted", proposal_id: draft.id, summary: proposalSummary(p) };
  }
  return null;
}

// Autonomy Undo restores the plan and retires only the recovery proposal that
// owned that decision. A newer recovery window keeps its stamp and plan intact.
export function revertRecoveryWeekIfOwned(proposalId: number, opts: { strict?: boolean } = {}): boolean {
  const p = getProposal(Number(proposalId));
  if (!p || !String(p.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX)) return false;
  cancelRecoveryCycleForProposal(Number(proposalId), localDateISO());
  if (opts.strict) clearRecoveryWeekStampIfOwnedStrict(Number(proposalId));
  else clearRecoveryWeekStampIfOwned(Number(proposalId));
  if (p.status === "applied") setProposalStatus(Number(proposalId), "reverted");
  return true;
}
