// Dismissals as evidence (W3.2, docs/VISION.md "125 of 144 insights got zero
// feedback; thumbs-down never gets used"). A Today-agenda card dismiss was
// previously client-only (removed from the DOM, nothing written) and an insight
// marked 'dismissed' only ever flipped a status column — neither left a trace the
// coaching loop could learn from. This module is the ONE write/read surface for
// that trace.
//
// ONE dismissal teaches nothing (the audit's own risk: a single idle tap is not
// a preference). Every consumer of this table gates on REPETITION — at least
// DISMISSAL_REPEAT_THRESHOLD DISTINCT DAYS for the same (surface, item_key) —
// never on mere presence of a row. The unique index on (surface, item_key, date)
// makes "distinct days" exactly COUNT(*): repeated taps the same day collapse to
// one row, so a person mashing the dismiss button once cannot manufacture
// repetition on their own.
import { db } from "../db.js";
import { localDateISO } from "./shared.js";

export type DismissalSurface = "today_agenda" | "insight";

// A theme is suppressed only after this many DISTINCT days carry a dismissal —
// the soft repetition gate item 2 of the spec asks for, mirroring the thumbs-down
// treatment already applied to insight intent keys.
export const DISMISSAL_REPEAT_THRESHOLD = 2;

// Record one dismissal. Idempotent per day by construction (INSERT OR IGNORE
// against the unique index) — a second tap the same day is a no-op, not a second
// count. Returns true when a NEW row was written (false when the day already had
// one, or on a bad input).
export function recordDismissal(surface: DismissalSurface, itemKey: string, date: string = localDateISO()): boolean {
  const key = String(itemKey ?? "").trim();
  if (!key || (surface !== "today_agenda" && surface !== "insight")) return false;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : localDateISO();
  const info = db
    .prepare(`INSERT OR IGNORE INTO surface_dismissals (surface, item_key, date) VALUES (?, ?, ?)`)
    .run(surface, key, day);
  return Number(info.changes) > 0;
}

// Distinct-day dismissal count for one (surface, item_key) — the number the
// repetition gate compares against DISMISSAL_REPEAT_THRESHOLD.
export function dismissalDayCount(surface: DismissalSurface, itemKey: string): number {
  const key = String(itemKey ?? "").trim();
  if (!key) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM surface_dismissals WHERE surface = ? AND item_key = ?`)
    .get(surface, key) as any;
  return Number(row?.n) || 0;
}

// True once a (surface, item_key) has been dismissed on at least
// DISMISSAL_REPEAT_THRESHOLD distinct days — the soft, repetition-gated signal.
// Never a permanent silence: callers feed this into the SAME dedupe/prompt
// mechanism a thumbs-down already drives, not a hard block.
export function isRepeatedlyDismissed(surface: DismissalSurface, itemKey: string): boolean {
  return dismissalDayCount(surface, itemKey) >= DISMISSAL_REPEAT_THRESHOLD;
}

// Every item_key for a surface that has crossed the repetition threshold, most
// recently dismissed first. Bounded like the other corpus reads in this codebase
// (DOWNVOTED_KEY_LIMIT / KEY_WINDOW_ROW_LIMIT) so a very dismiss-heavy history
// cannot grow the read unbounded.
export function repeatedlyDismissedKeys(surface: DismissalSurface, limit = 50): string[] {
  const rows = db
    .prepare(
      `SELECT item_key, COUNT(*) AS n, MAX(date) AS last_date
         FROM surface_dismissals
        WHERE surface = ?
        GROUP BY item_key
       HAVING COUNT(*) >= ?
        ORDER BY last_date DESC
        LIMIT ?`
    )
    .all(surface, DISMISSAL_REPEAT_THRESHOLD, Math.max(1, Math.trunc(limit))) as any[];
  return rows.map((r) => String(r.item_key)).filter(Boolean);
}
