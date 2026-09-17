// THE LIFTING WEEK — what the athlete SAID, or, failing that, what they DO.
//
// `profile.strength_schedule_json` (v102) holds the weekdays the athlete named. It is
// the better answer whenever it exists, and chat is the door: "my strength training is
// Mon-Fri" writes it in one turn, with no form to fill in.
//
// But the point of this system is to learn rather than to interrogate, so a schedule
// nobody has stated is not the end of the question. An athlete who has lifted on the
// same weekdays for a month and a half has told us their week just as plainly — they
// simply told us by doing it. This module reads that.
//
// The habit law is the one already in the repo, not a new one: the weekly ride in
// `src/repo/race-build.ts` is "a PATTERN read off the log (3 of 6 weeks)". A weekday
// earns its place here on exactly those terms — a real strength session landed on that
// weekday in at least three of the last six calendar weeks. Two weeks is a coincidence;
// three is a week. The counting is per WEEKDAY (not per session, and not one winning
// day like the ride), because a lifting week is several days and the question is which
// of them recur.
//
// This is a READ. Nothing here writes a schedule, promotes an observation into a stated
// fact, or asks the athlete to confirm anything. An observed week is a weaker claim than
// a stated one and every surface says which it is holding.
import { db } from "../db.js";
import { mondayOf } from "../lib/dates.js";
import { getStrengthSchedule, isoDow, type StrengthScheduleDay } from "./profile.js";
import { localDateISO } from "./shared.js";

/** Six calendar weeks, and three of them make a habit — the race-build ride law. */
export const OBSERVED_WEEKS_WINDOW = 6;
export const OBSERVED_WEEKS_TO_COUNT = 3;

export interface StrengthScheduleRead {
  /** The lifting weekdays, ascending by dow (0 = Sunday). [] when nothing is known. */
  days: StrengthScheduleDay[];
  /**
   * Where the days came from. "stated" is the athlete's own words and always wins;
   * "observed" is the 3-of-6 read off the log; null means neither — the ring stays
   * positional and every surface stays quiet.
   */
  source: "stated" | "observed" | null;
  /**
   * For an observed read, the number of weeks the THINNEST named weekday was seen in —
   * so "3 of 6 weeks" is a claim true of every day in the list, not just the best one.
   * 0 for a stated read (the athlete said it; no week count is being asserted).
   */
  weeks_seen: number;
  weeks_window: number;
}

const EMPTY: StrengthScheduleRead = { days: [], source: null, weeks_seen: 0, weeks_window: OBSERVED_WEEKS_WINDOW };

/**
 * The six week-buckets ending with the one `asOf` falls in, as Monday dates.
 * The current week is included even when it is half over: a partial week can only ADD
 * a sighting, never remove one, so counting it can raise a weekday to the threshold but
 * never drop one below it.
 */
function observedWindow(asOf: string): { weeks: string[]; start: string } {
  const thisMonday = mondayOf(asOf);
  const weeks: string[] = [];
  const cursor = new Date(`${thisMonday}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 7 * (OBSERVED_WEEKS_WINDOW - 1));
  for (let i = 0; i < OBSERVED_WEEKS_WINDOW; i++) {
    weeks.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return { weeks, start: weeks[0] };
}

/**
 * The weekdays a real strength session actually landed on, 3-of-6-weeks.
 *
 * "Real" means a session that happened, not a row that exists: `kind = 'strength'` plus
 * either a `finished_at` stamp or at least one logged set. An opened-and-abandoned
 * session is not a lifting day, and neither is a cardio row.
 */
export function observedLiftDows(asOf?: string): { dows: number[]; weeks_seen: number } {
  const date = asOf || localDateISO();
  const { weeks, start } = observedWindow(date);
  const inWindow = new Set(weeks);
  let rows: { date: string }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT s.date AS date
           FROM sessions s
          WHERE s.date >= ? AND s.date <= ?
            AND COALESCE(s.kind, 'strength') = 'strength'
            AND (s.finished_at IS NOT NULL
                 OR EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id))`
      )
      .all(start, date) as { date: string }[];
  } catch {
    return { dows: [], weeks_seen: 0 };
  }
  const weeksByDow = new Map<number, Set<string>>();
  for (const row of rows) {
    const week = mondayOf(row.date);
    if (!inWindow.has(week)) continue;
    const dow = isoDow(row.date);
    const seen = weeksByDow.get(dow) ?? new Set<string>();
    seen.add(week);
    weeksByDow.set(dow, seen);
  }
  const qualifying = [...weeksByDow.entries()].filter(([, seen]) => seen.size >= OBSERVED_WEEKS_TO_COUNT);
  if (!qualifying.length) return { dows: [], weeks_seen: 0 };
  // The thinnest qualifying day sets the number the sentence may claim.
  const weeks_seen = Math.min(...qualifying.map(([, seen]) => seen.size));
  return { dows: qualifying.map(([dow]) => dow).sort((a, b) => a - b), weeks_seen };
}

/**
 * The lifting week, stated first. The one read every consumer should call: the ring
 * mapping, the week-layout read, the prompt line and the coach context all take their
 * answer from here, so the athlete never sees two surfaces holding different weeks.
 *
 * A STATED schedule always wins, including an explicitly emptied one — "stop assuming
 * my lifting days" is an instruction, and falling back to the log would be the system
 * arguing with it. An empty stated schedule therefore reads as `source: null`, exactly
 * like unset, which is what every downstream gate already treats as "no opinion".
 */
export function strengthScheduleRead(asOf?: string): StrengthScheduleRead {
  const stated = getStrengthSchedule();
  if (stated?.days.length) {
    return { days: stated.days, source: "stated", weeks_seen: 0, weeks_window: OBSERVED_WEEKS_WINDOW };
  }
  if (stated) return EMPTY; // explicitly cleared — a deliberate silence, not an opening
  const { dows, weeks_seen } = observedLiftDows(asOf);
  if (!dows.length) return EMPTY;
  return {
    days: dows.map((dow) => ({ dow: dow as StrengthScheduleDay["dow"] })),
    source: "observed",
    weeks_seen,
    weeks_window: OBSERVED_WEEKS_WINDOW,
  };
}

/** The lifting weekdays as dow numbers, stated or observed. [] when neither. */
export function liftDows(asOf?: string): number[] {
  return strengthScheduleRead(asOf).days.map((d) => d.dow);
}
