/**
 * The athlete's training DRIVE — the one read every consumer asks, for any date.
 *
 * Two layers, both the athlete's own word:
 *
 *   • `settings.training_drive` ("steady" | "push") is the STANDING preference (the
 *     Settings toggle). Its push buys a bounded handful of things (the stacked-days
 *     drive read, a reach on a backed morning, a strong top set earning the step, a
 *     scheduled deload set aside unless the loaded weeks earn it).
 *   • A PUSH STANCE (`training_stances`) is the DATED statement on top of it: "I can
 *     push harder than this — push me until the block ends / until <date>". While its
 *     window covers a day it widens those licenses (PUSH_STANCE_* below). It always has
 *     an end: past `until` it stops reading and the drive falls back to what it was
 *     before the stance (`previous_drive`) — read-time, with no write, so a GET never
 *     mutates and no scheduler has to remember to expire it.
 *
 * Neither layer reaches a SAFETY floor. Every consumer that widens anything for a
 * stance still checks its own floors first (rest-grade readiness, harm evidence,
 * symptoms and injuries, the clinician floor, an act-now health finding, a recovery
 * week, an earned deload, a protective fueling hold) — this module only answers "what
 * did the athlete ask for, and does it cover this day".
 *
 * The write path (setting / ending a stance, its ledger decision and one-tap Undo)
 * lives in src/domain/training/training-drive.ts; the UI-ready read (what it licenses
 * today and what is still holding the day back) in src/repo/training-drive-read.ts.
 */
import { db } from "../db.js";
import { addDaysISO, daysBetweenISO, mondayOf } from "../lib/dates.js";
import { getActiveBlock } from "./program-blocks.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { getSettings } from "./settings.js";
import { localDateISO } from "./shared.js";

export type TrainingDriveValue = "steady" | "push";
export type PushStanceScope = "block" | "date";
export type PushStanceVia = "athlete" | "chat" | "mcp";
export type PushStanceEndReason = "replaced" | "stepped_back" | "settings_toggle" | "undone";

export interface PushStance {
  id: number;
  since: string;
  until: string;
  scope: PushStanceScope;
  words: string | null;
  previous_drive: TrainingDriveValue;
  set_via: PushStanceVia;
  decision_id: number | null;
  ended_at: string | null;
  ended_reason: PushStanceEndReason | null;
  created_at: string | null;
}

export interface TrainingDriveState {
  date: string;
  /** The drive in force on `date`: the stance's push while it covers the day, else the standing value. */
  drive: TrainingDriveValue;
  /** What the Settings toggle holds. */
  standing: TrainingDriveValue;
  /** The open stance covering `date`, or null. Its presence IS "the stance is active". */
  stance: PushStance | null;
  /** The newest open stance whose window closed within the last PUSH_STANCE_ENDED_SAY_DAYS —
   * said, never silently dropped, and then no longer news (the drive still falls back). */
  expired_stance: PushStance | null;
}

// ---- the widened licenses, one constant each, so tests and docs can name them ----

/** Days a stance may run at most before the athlete re-states it. */
export const PUSH_STANCE_MAX_DAYS = 84;
/** The stance's length when the athlete names neither a date nor the block. */
export const PUSH_STANCE_DEFAULT_DAYS = 28;
/** The stacked loading-day count at which an uncorroborated stack reads easy (5 without a stance). */
export const PUSH_STANCE_CONSEC_CEILING = 7;
/** Challenge top sets a reach day may seat (1 without a stance), each on a different movement pattern. */
export const PUSH_STANCE_REACH_HOSTS = 2;
/** Reserve (reps in hand at the ceiling) that still counts a top set as strong (2 without a stance). */
export const PUSH_STANCE_RIR_RESERVE = 1;
/** Days after a stance's last day that its end is still SAID (the Brief's line, the prompts'
 * "their push ended"). Past it the fall-back drive simply stands, with nothing to announce. */
export const PUSH_STANCE_ENDED_SAY_DAYS = 7;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function driveValue(value: unknown): TrainingDriveValue {
  return String(value) === "push" ? "push" : "steady";
}

function hydrateStance(row: any): PushStance | null {
  if (!row || !ISO.test(String(row.since ?? "")) || !ISO.test(String(row.until ?? ""))) return null;
  const scope = row.scope === "block" ? "block" : "date";
  const via = row.set_via === "chat" || row.set_via === "mcp" ? row.set_via : "athlete";
  const ended = ["replaced", "stepped_back", "settings_toggle", "undone"].includes(String(row.ended_reason))
    ? (row.ended_reason as PushStanceEndReason)
    : null;
  return {
    id: Number(row.id),
    since: String(row.since),
    until: String(row.until),
    scope,
    words: row.words == null ? null : String(row.words),
    previous_drive: driveValue(row.previous_drive),
    set_via: via,
    decision_id: row.decision_id == null ? null : Number(row.decision_id),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
    ended_reason: ended,
    created_at: row.created_at == null ? null : String(row.created_at),
  };
}

/** The newest stance that has not been ended (it may be in force, future-dated or expired). */
export function latestOpenStance(): PushStance | null {
  return requestMemo(
    "training_stance:open",
    () => {
      try {
        return hydrateStance(
          db.prepare(`SELECT * FROM training_stances WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`).get()
        );
      } catch {
        // A DB that predates the table (a bare script) has no stance — the standing drive answers.
        return null;
      }
    },
    copyDeep
  );
}

export function getStance(id: number): PushStance | null {
  try {
    return hydrateStance(db.prepare(`SELECT * FROM training_stances WHERE id = ?`).get(id));
  } catch {
    return null;
  }
}

/**
 * The drive in force on `date`. Fail-soft to the standing value, and from there to
 * "steady": every reader of this is choosing whether to OPEN something, and a read that
 * fails must never be the thing that hands out more.
 */
export function trainingDriveState(date?: string | null): TrainingDriveState {
  const d = String(date || localDateISO()).slice(0, 10);
  let standing: TrainingDriveValue = "steady";
  try {
    standing = driveValue(getSettings().training_drive);
  } catch {
    standing = "steady";
  }
  const open = latestOpenStance();
  if (open && standing === "push") {
    if (open.since <= d && d <= open.until)
      return { date: d, drive: "push", standing, stance: open, expired_stance: null };
    if (d > open.until) {
      // The drive falls back for good; the END is news only for a week after it.
      const since = daysBetweenISO(d, open.until);
      const said = since != null && since <= PUSH_STANCE_ENDED_SAY_DAYS;
      return { date: d, drive: open.previous_drive, standing, stance: null, expired_stance: said ? open : null };
    }
  }
  return { date: d, drive: standing, standing, stance: null, expired_stance: null };
}

export function effectiveTrainingDrive(date?: string | null): TrainingDriveValue {
  try {
    return trainingDriveState(date).drive;
  } catch {
    return "steady";
  }
}

/** A dated push stance covers `date` (and the standing drive still says push). */
export function pushStanceActive(date?: string | null): boolean {
  try {
    return trainingDriveState(date).stance != null;
  } catch {
    return false;
  }
}

/** The last day of the active program block, read off the calendar week it is in. */
export function activeBlockEndDate(date?: string | null): string | null {
  const d = String(date || localDateISO()).slice(0, 10);
  try {
    const block = getActiveBlock();
    if (!block) return null;
    const weeksLeft = Math.max(0, Number(block.total_weeks) - Number(block.week_index));
    if (!Number.isFinite(weeksLeft)) return null;
    const sunday = addDaysISO(mondayOf(d), 6);
    return sunday ? addDaysISO(sunday, weeksLeft * 7) : null;
  } catch {
    return null;
  }
}

export function stanceDaysLeft(stance: Pick<PushStance, "until">, date: string): number | null {
  const left = daysBetweenISO(stance.until, date);
  return left == null ? null : Math.max(0, left);
}

// ---- writes (the domain service is the only caller) ----

export function insertStance(input: {
  since: string;
  until: string;
  scope: PushStanceScope;
  words: string | null;
  previous_drive: TrainingDriveValue;
  set_via: PushStanceVia;
}): PushStance {
  const info = db
    .prepare(
      `INSERT INTO training_stances (since, until, scope, words, previous_drive, set_via) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.since,
      input.until,
      input.scope,
      input.words ? input.words.slice(0, 240) : null,
      input.previous_drive,
      input.set_via
    );
  const stored = getStance(Number(info.lastInsertRowid));
  if (!stored) throw new Error("push stance was not stored");
  return stored;
}

export function linkStanceDecision(stanceId: number, decisionId: number): void {
  db.prepare(`UPDATE training_stances SET decision_id = ? WHERE id = ?`).run(decisionId, stanceId);
}

/** End every open stance (or one). Returns the ids it ended. */
export function endOpenStances(reason: PushStanceEndReason, onlyId?: number | null): number[] {
  try {
    const rows = (
      onlyId != null
        ? db.prepare(`SELECT id FROM training_stances WHERE ended_at IS NULL AND id = ?`).all(onlyId)
        : db.prepare(`SELECT id FROM training_stances WHERE ended_at IS NULL`).all()
    ) as Array<{ id: number }>;
    for (const row of rows) {
      db.prepare(`UPDATE training_stances SET ended_at = datetime('now'), ended_reason = ? WHERE id = ?`).run(
        reason,
        row.id
      );
    }
    return rows.map((row) => Number(row.id));
  } catch {
    return [];
  }
}

/** Re-open an ended stance (Undo of a step-back). Only while its window still has a day left. */
export function reopenStance(id: number, today: string): boolean {
  const stance = getStance(id);
  if (!stance || stance.until < today) return false;
  db.prepare(`UPDATE training_stances SET ended_at = NULL, ended_reason = NULL WHERE id = ?`).run(id);
  return true;
}
