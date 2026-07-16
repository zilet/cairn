import { db } from "../db.js";
import { getAppState, setAppState, setAppStateStrict } from "./app-state.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";

export const RECOVERY_WEEK_INSTRUCTION_PREFIX = "Reshape next week into a RECOVERY";
export const RECOVERY_WEEK_ACTIVE_DAYS = 7;
export const RECOVERY_WEEK_APPLIED_KEY = "recovery_week_applied";

interface RecoveryWeekStamp {
  applied_on: string;
  proposal_id: number | null;
}

export interface ActiveRecoveryWeekLedger {
  applied_on: string;
  until: string;
  proposal_id: number;
  stamped_at: string | null;
  parsed: any;
}

export interface CompletedRecoveryWeekLedger extends ActiveRecoveryWeekLedger {
  days_since_completion: number;
  weeks_since_completion: number;
}

function parseStamp(value: unknown): RecoveryWeekStamp | null {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { applied_on: raw, proposal_id: null };
  try {
    const parsed = JSON.parse(raw);
    const appliedOn = String(parsed?.applied_on ?? "").slice(0, 10);
    const proposalId = Number(parsed?.proposal_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appliedOn)) return null;
    return {
      applied_on: appliedOn,
      proposal_id: Number.isInteger(proposalId) && proposalId > 0 ? proposalId : null,
    };
  } catch {
    return null;
  }
}

function appliedProposal(stamp: RecoveryWeekStamp): any | null {
  const row =
    stamp.proposal_id != null
      ? db
          .prepare(
            `SELECT * FROM plan_proposals
            WHERE id = ? AND status = 'applied' AND instruction LIKE ?`
          )
          .get(stamp.proposal_id, `${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`)
      : db
          .prepare(
            `SELECT * FROM plan_proposals
            WHERE status = 'applied' AND instruction LIKE ?
            ORDER BY id DESC LIMIT 1`
          )
          .get(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`);
  if (!row) return null;
  let parsed: any = null;
  try {
    parsed = (row as any).parsed_json ? JSON.parse((row as any).parsed_json) : null;
  } catch {
    parsed = null;
  }
  return { ...(row as any), parsed };
}

function recoveryWeekLedger(): ActiveRecoveryWeekLedger | null {
  const stampRow = db
    .prepare(`SELECT value, updated_at FROM app_state WHERE key = ?`)
    .get(RECOVERY_WEEK_APPLIED_KEY) as any;
  const stamp = parseStamp(stampRow?.value ?? getAppState(RECOVERY_WEEK_APPLIED_KEY));
  if (!stamp) return null;
  const until = addDaysISO(stamp.applied_on, RECOVERY_WEEK_ACTIVE_DAYS);
  if (!until) return null;
  const proposal = appliedProposal(stamp);
  if (!proposal) return null;
  return {
    applied_on: stamp.applied_on,
    until,
    proposal_id: Number(proposal.id),
    stamped_at: stampRow?.updated_at == null ? null : String(stampRow.updated_at),
    parsed: proposal.parsed,
  };
}

// One authoritative answer shared by the daily read and recovery-dose grader.
// The app-state stamp owns the calendar window; the still-applied immutable
// proposal owns the prescription. Either side missing means inactive, never an
// inferred deload from stale prose.
export function activeRecoveryWeekLedger(date = localDateISO()): ActiveRecoveryWeekLedger | null {
  const readDate = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(readDate)) return null;
  const ledger = recoveryWeekLedger();
  if (!ledger || readDate < ledger.applied_on || readDate >= ledger.until) return null;
  return ledger;
}

// The active interval is deliberately exclusive at `until`, but periodization
// still needs the applied ledger after that boundary so the completed reset is
// not immediately forgotten. This is calendar math over the owned stamp and its
// still-applied proposal, never a guess from current tonnage or wall-clock time.
export function completedRecoveryWeekLedger(date = localDateISO()): CompletedRecoveryWeekLedger | null {
  const readDate = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(readDate)) return null;
  const ledger = recoveryWeekLedger();
  if (!ledger || readDate < ledger.until) return null;
  const daysSince = daysBetweenISO(readDate, ledger.until);
  if (daysSince == null || daysSince < 0) return null;
  return {
    ...ledger,
    days_since_completion: daysSince,
    weeks_since_completion: Math.floor(daysSince / 7),
  };
}

export function stampRecoveryWeekApplied(proposalId: number, appliedOn = localDateISO()): void {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(appliedOn)) return;
  setAppState(RECOVERY_WEEK_APPLIED_KEY, JSON.stringify({ applied_on: appliedOn, proposal_id: id }));
}

export function stampRecoveryWeekAppliedStrict(proposalId: number, appliedOn = localDateISO()): void {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(appliedOn)) {
    throw new Error("invalid recovery-week ownership stamp");
  }
  setAppStateStrict(RECOVERY_WEEK_APPLIED_KEY, JSON.stringify({ applied_on: appliedOn, proposal_id: id }));
}

// Undo must not clear a newer recovery week. JSON stamps have exact ownership;
// legacy date-only stamps are attributed conservatively to the latest still-
// applied recovery proposal.
export function clearRecoveryWeekStampIfOwned(proposalId: number): boolean {
  const stamp = parseStamp(getAppState(RECOVERY_WEEK_APPLIED_KEY));
  if (!stamp) return false;
  const owner = stamp.proposal_id ?? Number(appliedProposal(stamp)?.id);
  if (!Number.isInteger(owner) || owner !== Number(proposalId)) return false;
  setAppState(RECOVERY_WEEK_APPLIED_KEY, "");
  return true;
}

export function clearRecoveryWeekStampIfOwnedStrict(proposalId: number): boolean {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(RECOVERY_WEEK_APPLIED_KEY) as any;
  const stamp = parseStamp(row?.value);
  if (!stamp) return false;
  const owner = stamp.proposal_id ?? Number(appliedProposal(stamp)?.id);
  if (!Number.isInteger(owner) || owner !== Number(proposalId)) return false;
  setAppStateStrict(RECOVERY_WEEK_APPLIED_KEY, "");
  return true;
}
