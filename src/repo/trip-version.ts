// ---------- the trip version of a lift day: its identity and its premise ----------
// The evening-before question "Lifting on the trip?" is gone (brief-asks.ts). The coach
// lays the lighter trip version over a planned lift day inside a BOUNDED trip (both dates
// named, at most MAX_TRIP_VERSION_DAYS) by itself — the SAME one-day layer the "Easier"
// answer always wrote (`until` = that date, `layer: 'trip'`, restored the day after by
// plan-adaptations.ts) — routed through the ordinary autonomy path the day before, and
// never landing before its own day: lead lands it that morning with the server-owned
// Undo, announce_first tells first, and review_everything asks. Undo, a Hold, or a
// discard is the athlete's "as planned", remembered on the trip
// (`meta.lift_defaults[date]`) and by the draft itself, and that day is never offered
// again. Its Undo never counts toward the training domain's demotion (domainIsDemoted).
//
// This module owns the facts the autonomy layer reads off such a draft without
// importing the Brief: who wrote it, whether its trip is bounded, and whether its
// premise still stands.
import { db } from "../db.js";
import { getPlan } from "./plan.js";
import { localDateISO } from "./shared.js";

/** The proposal author of a trip version the coach laid down by itself. */
export const TRIP_VERSION_AGENT = "trip-version";
/** The proposal author of the "Easier" answer an older client can still send. */
export const TRIP_ANSWER_AGENT = "trip-ask";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one date a trip version is scoped to, or null when the payload is not one: every
 * change a one-day `layer: 'trip'` over the same date. A layer restores itself the day
 * after (plan-adaptations.ts), which is what makes it bounded however many sets it trims.
 */
export function tripVersionDate(parsed: any): string | null {
  const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
  if (!changes.length || Array.isArray(parsed?.days)) return null;
  const dates = new Set<string>();
  for (const change of changes) {
    if (change?.layer !== "trip") return null;
    const until = String(change?.until ?? "").slice(0, 10);
    if (!ISO_DAY.test(until)) return null;
    dates.add(until);
  }
  return dates.size === 1 ? [...dates][0] : null;
}

/** A trip version: written by the coach's trip pass or by the Easier answer, and shaped as one. */
export function isTripVersionProposal(proposal: any): boolean {
  const agent = String(proposal?.agent ?? "");
  return (agent === TRIP_VERSION_AGENT || agent === TRIP_ANSWER_AGENT) && tripVersionDate(proposal?.parsed) != null;
}

export type TripVersionPremise = "fits" | "gone" | "unknown";

/** A bounded trip covers `date` (tripIsBounded); null when the read failed. */
export function tripCovers(date: string): boolean | null {
  try {
    const rows = db
      .prepare(
        `SELECT start_date, end_date FROM context_events
          WHERE kind = 'trip' AND (archived IS NULL OR archived = 0)
            AND start_date IS NOT NULL AND end_date IS NOT NULL
            AND substr(start_date, 1, 10) <= ? AND substr(end_date, 1, 10) >= ?
            AND (resolved_at IS NULL OR substr(resolved_at, 1, 10) >= ?)`
      )
      .all(date, date, date) as any[];
    return rows.some((row) => tripIsBounded(row.start_date, row.end_date, date));
  } catch {
    return null;
  }
}

/**
 * Whether the coach already wrote a trip version for `date`, in ANY status (landed,
 * undone, held, set aside). The trip's own `meta.lift_defaults` can be lost when the trip
 * is edited (its meta is replaced whole), so the drafts themselves are the second record
 * that a day was already handled. Null when the read fails.
 */
export function tripVersionWrittenFor(date: string): boolean | null {
  try {
    const rows = db
      .prepare(`SELECT parsed_json FROM plan_proposals WHERE agent = ? ORDER BY id DESC LIMIT 500`)
      .all(TRIP_VERSION_AGENT) as Array<{ parsed_json: string | null }>;
    return rows.some((row) => {
      try {
        return tripVersionDate(JSON.parse(String(row.parsed_json ?? "null"))) === date;
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
}

/** The longest trip (inclusive days) the coach lays a trip version over by itself. */
export const MAX_TRIP_VERSION_DAYS = 14;

/**
 * Whether a trip is one the coach may lay a trip version over on `date`: it names BOTH
 * its first and last day, `date` falls inside them, and it lasts at most
 * MAX_TRIP_VERSION_DAYS. An undated trip, a start-only one (read as open-ended
 * elsewhere) or a long stay is a fact about the calendar, never a reason to lighten
 * every lift day in it.
 */
export function tripIsBounded(start: unknown, end: unknown, date: string): boolean {
  const from = String(start ?? "").slice(0, 10);
  const to = String(end ?? "").slice(0, 10);
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || !ISO_DAY.test(date)) return false;
  if (date < from || date > to) return false;
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
  return Number.isFinite(days) && days >= 1 && days <= MAX_TRIP_VERSION_DAYS;
}

/**
 * Whether a trip version still describes a day that is coming: its date is today or
 * later, a trip still covers it, and every lift it lays the layer over is still on its
 * plan day. Read in place of the generic evidence fingerprint — a set logged on the eve
 * says nothing about a hotel room tomorrow. `unknown` when a read failed: the caller
 * changes nothing on it.
 */
export function tripVersionStillFits(parsed: any, asOf: string = localDateISO()): TripVersionPremise {
  const date = tripVersionDate(parsed);
  if (!date) return "unknown";
  if (date < asOf) return "gone";
  const covered = tripCovers(date);
  if (covered == null) return "unknown";
  if (!covered) return "gone";
  let plan: any[];
  try {
    plan = getPlan() as any[];
  } catch {
    return "unknown";
  }
  for (const change of parsed.changes as any[]) {
    const day = plan.find((d) => Number(d?.day_number) === Number(change?.day_number));
    if (!day) return "gone";
    const name = String(change?.swap?.from ?? change?.exercise ?? "")
      .trim()
      .toLowerCase();
    const items = Array.isArray(day.items) ? day.items : [];
    if (
      !name ||
      !items.some(
        (it: any) =>
          String(it?.exercise ?? "")
            .trim()
            .toLowerCase() === name
      )
    )
      return "gone";
  }
  return "fits";
}
