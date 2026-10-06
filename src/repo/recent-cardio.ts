// THE LAST WEEK OF RUNS AND CARDIO, AS A COACH READS THEM.
//
// `recent_activities` in the coach context is `listActivities(15)` verbatim: the
// storage row, with distance and pace in km whatever unit the athlete runs in, and
// the heart rate the watch measured nowhere but a free-text `notes` string
// ("avg HR 157 · load 219 · effect 4.5"). Serialized into a chat DATA block of
// several hundred KB it sits one line among thousands — and on 2026-09-29 the chat
// coach told the athlete his morning run's distance, pace and heart rate "aren't
// visible in my data right now" while that exact row was in its DATA.
//
// This is the same week, read the way a coach reads a run: when it was (today /
// yesterday / weekday, and the watch's own start time), what it was, how far in the
// athlete's own unit, how long, the pace, the average and max heart rate off the
// linked Garmin row, what the athlete SAID it felt like (their stated rpe), and how
// the athlete's OWN heart-rate model reads the average. Garmin's training-effect
// number and label never ride here — the owner law retired them as a verdict on a
// run (run-intensity.ts), and a stated effort outranks the model's read.
//
// It carries the summary plus the run's SHAPE when the watch recorded one — the work
// bouts and recoveries of an interval session, walking, grade-adjusted pace on a hilly
// run, each work rep's time, pace and heart rate (run-structure.ts). Every lap is one
// coach read away (`read_activity_detail`). There are no second-by-second HR streams
// or GPS tracks in the database, so nothing may be narrated as "not pulled through
// yet" — the prompt blocks built on this say so.
import { KM_PER_MI } from "./display-words.js";
import { db } from "../db.js";
import { addDaysISO } from "../lib/dates.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { isStrengthGarminType } from "./activities.js";
import { canonicalEnduranceSport } from "./endurance-sports.js";
import type { HrModel } from "./hr-model.js";
import { personalRunReadForRow, usablePersonalHrModel } from "./run-intensity.js";
import { athleteUnits } from "./settings.js";
import { clipText, clockLabel, localDateISO } from "./shared.js";
import { isStatedEasyRpe } from "./stated-effort.js";
import { structureNote } from "./run-structure.js";

export const RECENT_CARDIO_DAYS = 7;
const RECENT_CARDIO_MAX_ROWS = 14;
// Pace is a foot-sport number; a ride or a swim reads by distance and time.
const PACED_SPORTS = new Set(["run", "walk"]);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface RecentCardioRow {
  /** activities.id — the id a chat action (set_activity_effort) names. */
  activity_id: number;
  date: string;
  /** "today" | "yesterday" | the weekday — relative to the read's as-of date. */
  when: string;
  /** The watch's local start time ("6:34 AM"), when a synced row carries one. */
  started: string | null;
  type: string;
  title: string | null;
  distance_km: number | null;
  /** Distance in the athlete's display unit, e.g. "6.01 mi" / "9.68 km". */
  distance: string | null;
  duration_min: number | null;
  /** Pace in the athlete's display unit, e.g. "8:58/mi"; null off foot sports. */
  pace: string | null;
  avg_hr: number | null;
  max_hr: number | null;
  /** The athlete's own stated effort, 1-10 — never written by a watch. */
  stated_rpe: number | null;
  /** True when that stated effort is in the talk-test band (stated-effort.ts). */
  stated_easy: boolean;
  /** The personal HR model's read of the average — null when it cannot judge. */
  personal_effort: "easy" | "steady" | "quality" | null;
  /** A hand log's own words (a synced row's auto-summary is not carried). */
  note: string | null;
  /** The run's shape off the watch — work bouts, recoveries, walking, grade-adjusted
   * pace on a hilly run, each work rep (run-structure.ts `structureNote`). Null on a
   * plain run with nothing beyond its summary. */
  structure: string | null;
  source: string | null;
}

export interface RecentCardioRead {
  as_of: string;
  window_days: number;
  units: "km" | "mi";
  /** Newest first; shadows (a hand log duplicating the watch's row) folded away. */
  rows: RecentCardioRow[];
}

const num = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function whenLabel(date: string, asOf: string): string {
  if (date === asOf) return "today";
  if (date === addDaysISO(asOf, -1)) return "yesterday";
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? WEEKDAYS[new Date(t).getUTCDay()] : date;
}

function formatDistance(km: number | null, units: "km" | "mi"): string | null {
  if (km == null || km <= 0) return null;
  return units === "mi" ? `${(km / KM_PER_MI).toFixed(2)} mi` : `${km.toFixed(2)} km`;
}

function formatPace(km: number | null, minutes: number | null, units: "km" | "mi"): string | null {
  if (km == null || km <= 0 || minutes == null || minutes <= 0) return null;
  const perUnit = units === "mi" ? minutes / (km / KM_PER_MI) : minutes / km;
  let whole = Math.floor(perUnit);
  let seconds = Math.round((perUnit - whole) * 60);
  if (seconds === 60) {
    whole += 1;
    seconds = 0;
  }
  return `${whole}:${String(seconds).padStart(2, "0")}/${units}`;
}

function runUnits(): "km" | "mi" {
  try {
    return athleteUnits().distance;
  } catch {
    return "km";
  }
}

/**
 * The last `days` days of runs and cardio (inclusive of `asOf`), newest first. Pure
 * read; empty rows for an athlete who logs no cardio.
 */
export function recentCardioRead(asOf: string = localDateISO(), days: number = RECENT_CARDIO_DAYS): RecentCardioRead {
  const units = runUnits();
  const span = Math.max(1, Math.min(28, Math.trunc(days) || RECENT_CARDIO_DAYS));
  const start = addDaysISO(asOf, -(span - 1)) ?? asOf;
  const raw = db
    .prepare(
      `SELECT a.id, a.date, a.type, a.raw_text, a.notes, a.duration_min, a.distance_km, a.pace, a.rpe,
              a.source, a.external_id,
              g.start_time AS g_start, g.name AS g_name, g.avg_hr, g.max_hr,
              COALESCE(g.moving_min, g.duration_min, a.duration_min) AS hr_minutes,
              g.hr_zones_json AS zones, g.structure_json AS structure, g.laps_json AS laps,
              g.gap_speed AS gap_speed, g.ascent_m AS g_ascent
         FROM activities a
         LEFT JOIN garmin_activities g ON g.activity_id = a.id
        WHERE a.date BETWEEN ? AND ?
        ORDER BY a.date DESC, a.id DESC
        LIMIT ?`
    )
    .all(start, asOf, RECENT_CARDIO_MAX_ROWS * 2) as any[];
  const models = new Map<string, HrModel | null>();
  const modelFor = (date: string) => () => {
    if (!models.has(date)) models.set(date, usablePersonalHrModel(date));
    return models.get(date) ?? null;
  };
  const rows: RecentCardioRow[] = [];
  for (const r of withoutShadowActivities(raw)) {
    if (isStrengthGarminType(r.type)) continue; // a lift is a session, never cardio
    const date = String(r.date).slice(0, 10);
    const km = num(r.distance_km);
    const minutes = num(r.duration_min);
    const sport = canonicalEnduranceSport(r.type).key;
    const synced = r.g_start != null || r.source === "garmin";
    let personal: RecentCardioRow["personal_effort"] = null;
    try {
      personal = personalRunReadForRow(r, modelFor(date))?.effort ?? null;
    } catch {
      personal = null;
    }
    const rpe = num(r.rpe);
    const start = typeof r.g_start === "string" ? r.g_start.slice(11, 16) : "";
    rows.push({
      activity_id: Number(r.id),
      date,
      when: whenLabel(date, asOf),
      started: clockLabel(start) || null,
      type: String(r.type || "activity"),
      title: r.raw_text ? clipText(r.raw_text, 80) : r.g_name ? clipText(r.g_name, 80) : null,
      distance_km: km,
      distance: formatDistance(km, units),
      duration_min: minutes,
      // The stored pace already IS the km answer (the watch's, or the capture's); only
      // a miles runner needs it computed.
      pace: !PACED_SPORTS.has(sport)
        ? null
        : units === "km" && typeof r.pace === "string" && r.pace.endsWith("/km")
          ? r.pace
          : formatPace(km, minutes, units),
      avg_hr: num(r.avg_hr),
      max_hr: num(r.max_hr),
      stated_rpe: rpe,
      stated_easy: isStatedEasyRpe(rpe),
      personal_effort: personal,
      // A synced row's notes are the sync's own summary line (heart rate, Garmin's
      // load and training-effect number) — the heart rate is carried above, and the
      // training effect is never a verdict on a run. A hand log's notes are the
      // athlete's words and ride along.
      note: !synced && r.notes ? clipText(r.notes, 160) : null,
      structure: structureNote(r.structure, r.laps, units, { gap_speed: num(r.gap_speed), ascent_m: num(r.g_ascent) }),
      source: r.source ?? null,
    });
    if (rows.length >= RECENT_CARDIO_MAX_ROWS) break;
  }
  return { as_of: asOf, window_days: span, units, rows };
}
