import { db } from "../db.js";
import { addDaysISO } from "./shared.js";
import { tripRows, tripWindowEnd } from "./underfueling.js";

// Which dates of a window fall inside an active trip (a `trip` context event). One read
// for every surface that wants to say "he is away that day": the plan week's cells, the
// race build's leg map, the optional cross-training day. It reuses underfueling's trip
// window rules (archived trips ignored, a closed trip ends at the earlier of end_date and
// resolved_at, an unclosed open-ended one is capped) and only adds the label.
//
// A trip is a fact about the calendar, never a gate: nothing here moves a run or removes
// a lift. It lets an OPTIONAL day stand aside and lets a cell say where he is.

export interface TravelDay {
  title: string;
  location: string | null;
}

/** Every date of [from, to] inside a trip -> what it is. The first trip listed wins a date. */
export function travelDaysIn(from: string, to: string): Map<string, TravelDay> {
  const out = new Map<string, TravelDay>();
  if (!from || !to || from > to) return out;
  for (const row of tripRows(from, to)) {
    let location: string | null = null;
    try {
      const meta = row.meta_json ? JSON.parse(String(row.meta_json)) : null;
      const raw = meta && typeof meta === "object" ? meta.location : null;
      location = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } catch {
      location = null;
    }
    const label: TravelDay = { title: String(row.title ?? "").trim() || "Trip", location };
    const start = row.start_date ? String(row.start_date).slice(0, 10) : from;
    const first = start > from ? start : from;
    const end = tripWindowEnd(row);
    const last = end && end < to ? end : to;
    for (let d: string | null = first; d && d <= last; d = addDaysISO(d, 1)) {
      if (!out.has(d)) out.set(d, label);
    }
  }
  return out;
}

/** The trip `date` falls in, or null. */
export function travelOn(date: string): TravelDay | null {
  return travelDaysIn(date, date).get(date) ?? null;
}

// ---- the trip itself, for the trip version of a lift day ----
// The coach lays the lighter trip version over a planned lift day inside a trip by itself
// (brief-asks.ts routeTripVersions) and remembers it ON THE TRIP — `meta.lift_defaults
// [date]` — so each trip day is handled at most once. An older client may still answer
// the retired evening question; those answers stay in `meta.lift_answers[date]`. Deleting
// the trip takes both with it.

export type TripLiftAnswer = "yes" | "skip" | "easier";

export interface TripEvent {
  id: number;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  meta: Record<string, unknown>;
  /** Answers already given for this trip's lift days, by date. */
  lift_answers: Record<string, TripLiftAnswer>;
  /**
   * The trip versions the coach laid down by itself, by date -> the draft it wrote
   * (trip-version.ts). One per trip day, ever: an Undo of it is the athlete's "as
   * planned", and the day is never offered again.
   */
  lift_defaults: Record<string, number>;
}

const TRIP_ANSWERS: ReadonlySet<string> = new Set(["yes", "skip", "easier"]);

function tripMeta(raw: unknown): Record<string, unknown> {
  try {
    const parsed = typeof raw === "string" && raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function liftAnswersOf(meta: Record<string, unknown>): Record<string, TripLiftAnswer> {
  const raw = meta.lift_answers;
  const out: Record<string, TripLiftAnswer> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [date, answer] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && TRIP_ANSWERS.has(String(answer))) out[date] = answer as TripLiftAnswer;
  }
  return out;
}

function liftDefaultsOf(meta: Record<string, unknown>): Record<string, number> {
  const raw = meta.lift_defaults;
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [date, id] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Number(id))) out[date] = Number(id);
  }
  return out;
}

/** The trip (a `trip` context event) `date` falls inside, with its id — the first one wins, as travelDaysIn. */
export function tripEventOn(date: string): TripEvent | null {
  const day = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, title, meta_json, start_date, end_date, resolved_at FROM context_events
          WHERE kind = 'trip' AND (archived IS NULL OR archived = 0)
            AND (start_date IS NULL OR start_date <= ?)
            AND (end_date IS NULL OR end_date >= ?)
            AND (resolved_at IS NULL OR resolved_at >= ?)
          ORDER BY id`
      )
      .all(day, day, day) as any[];
  } catch {
    return null;
  }
  for (const row of rows) {
    const end = tripWindowEnd(row);
    if (end != null && end < day) continue;
    const meta = tripMeta(row.meta_json);
    const location = typeof meta.location === "string" && meta.location.trim() ? meta.location.trim() : null;
    return {
      id: Number(row.id),
      title: String(row.title ?? "").trim() || "Trip",
      location,
      start_date: row.start_date ? String(row.start_date).slice(0, 10) : null,
      end_date: row.end_date ? String(row.end_date).slice(0, 10) : null,
      meta,
      lift_answers: liftAnswersOf(meta),
      lift_defaults: liftDefaultsOf(meta),
    };
  }
  return null;
}

/** Remember the answer for one trip day on the trip itself. Returns false with no such trip. */
export function recordTripLiftAnswer(tripId: number, date: string, answer: TripLiftAnswer): boolean {
  if (!TRIP_ANSWERS.has(answer)) return false;
  const row = db.prepare(`SELECT meta_json FROM context_events WHERE id = ? AND kind = 'trip'`).get(Number(tripId)) as any;
  if (!row) return false;
  const meta = tripMeta(row.meta_json);
  const answers = { ...liftAnswersOf(meta), [String(date).slice(0, 10)]: answer };
  db.prepare(`UPDATE context_events SET meta_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...meta, lift_answers: answers }),
    Number(tripId)
  );
  return true;
}

/**
 * Remember that the coach laid a trip version over one trip day (`proposalId` is the
 * draft it wrote; 0 when the attempt wrote nothing). Recorded once, whatever came of it,
 * so a day is never offered twice. Returns false with no such trip.
 */
export function recordTripLiftDefault(tripId: number, date: string, proposalId: number): boolean {
  const row = db
    .prepare(`SELECT meta_json FROM context_events WHERE id = ? AND kind = 'trip'`)
    .get(Number(tripId)) as any;
  if (!row) return false;
  const meta = tripMeta(row.meta_json);
  const defaults = {
    ...liftDefaultsOf(meta),
    [String(date).slice(0, 10)]: Math.max(0, Math.trunc(Number(proposalId)) || 0),
  };
  db.prepare(`UPDATE context_events SET meta_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...meta, lift_defaults: defaults }),
    Number(tripId)
  );
  return true;
}
