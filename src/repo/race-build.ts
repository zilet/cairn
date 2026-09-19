// ============================================================================
// race-build.ts — the RACE-BUILD coaching layer over the weekly run engine.
//
// weeklyRunPlan answers "what does THIS week look like"; raceRamp answers "is the
// build going to arrive". Neither says what the athlete is actually shooting for
// on race day, how that estimate is moving, what pace a quality session should
// touch, or how the run build sits against the rest of a hybrid week — the heavy
// squat day and the weekly ride. This module is that layer, read-only:
//
//   • prediction   — an estimated finish time / pace for the goal distance, from the
//                    watch's own race predictor when it has one (Riegel-adjusted to
//                    the exact distance), else a conservative Riegel off the best
//                    recent run; plus how it has MOVED over the last few weeks and
//                    how it sits against the stated target. A fit, never a grade.
//   • paces        — per-session pace bands (easy / long / tempo / threshold / VO2)
//                    derived from the TARGET pace (or the estimate when no target),
//                    distance-aware, so "threshold intervals" has a number on it.
//   • weeks        — the week-by-week ladder from this week to race week, walked
//                    through raceRamp so it is the SAME arithmetic the engine uses:
//                    volume, long run, down weeks, peak, taper, and a quality hint.
//   • leg_map      — the seven-day ring: runs, strength days (heavy-lower flagged)
//                    and the athlete's habitual ride, so the hard days can be seen
//                    together on one line.
//   • strength     — where heavy legs belong in this phase, plus the week-layout
//                    read's collision sentence when the lifting and running stack.
//   • ride         — the weekly ride as a PATTERN read off the log (no new field to
//                    fill in), and one sentence about where it sits in the week.
//
// Everything here is a suggestion in the athlete's register. No scores, no
// verdicts, no quotas: `beyond_horizon` describes a calendar, never an athlete.
// ============================================================================

import { db } from "../db.js";
import { addDaysISO, daysBetweenISO, isoDaysAgo, mondayOf } from "../lib/dates.js";
import { round1 } from "../lib/numbers.js";
import { weekLayoutRead, type WeekLayoutRead } from "../domain/training/week-layout.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { matchEnduranceModality } from "./heavy-load.js";
import { recentEnduranceImpacts, type EnduranceImpact } from "./hybrid-load.js";
import { thisWeekPlanDayMap } from "./plan-selection.js";
import { dowToDayNumber, getEnduranceGoal, isoDow, statedRunDows } from "./profile.js";
import { strengthScheduleRead } from "./strength-schedule.js";
import { raceRamp, type RaceRampGoal } from "./run-ramp.js";
import { weeklyRunPlan, type WeeklyRunPlan } from "./run-progression.js";
import { localDateISO } from "./shared.js";
import { lowerBodyPlanDayNumbers, planDayStrengthGroups } from "./training-read.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RacePhase = "base" | "build" | "sharpen" | "taper" | "past";
export type RaceWeekKind = "build" | "down" | "peak" | "taper" | "race";
export type RaceFit = "fits" | "stretch" | "beyond_horizon";
export type SessionPaceKey = "easy" | "long" | "tempo" | "threshold" | "vo2" | "race";

export interface RaceTarget {
  /** Total seconds for the goal distance. */
  sec: number;
  /** Seconds per km implied for the goal distance. */
  pace_sec_per_km: number;
  /** What the athlete actually wrote ("sub-1:45", "4:55/km"). */
  raw: string;
  kind: "time" | "pace";
}

export interface RacePrediction {
  /** Estimated finish for the goal distance, seconds. */
  estimate_sec: number;
  estimate_pace_sec_per_km: number;
  /** Where the number comes from. */
  basis: "watch_predictor" | "recent_run_riegel";
  basis_detail: string;
  as_of: string;
  /** Movement over the recent window (watch predictor only). null when one point. */
  trend: { delta_sec: number; since: string; word: "faster" | "steady" | "slower" } | null;
  /** Against the stated target: gap (+ = slower than target) and the fit band. */
  gap_sec: number | null;
  fit: RaceFit | null;
}

export interface PaceBand {
  key: SessionPaceKey;
  label: string;
  /** Slower bound (larger number) and faster bound, seconds per km. */
  slow_sec_per_km: number;
  fast_sec_per_km: number;
  /** "5:10–5:40 /km" */
  text: string;
}

export interface RaceBuildWeek {
  week_start: string;
  weeks_to_race: number;
  phase: RacePhase;
  kind: RaceWeekKind;
  km: number;
  long_km: number;
  quality_hint: string;
  strength_hint: string;
  /** True for the week containing `as_of`. */
  current: boolean;
}

export interface LegMapDay {
  day_number: number; // 1 = Monday … 7 = Sunday (the plan's template ring)
  weekday: string;
  run: { kind: "easy" | "quality" | "long"; label: string; km: number | null } | null;
  strength: { name: string; heavy_lower: boolean } | null;
  ride: boolean;
  /** The day reads as one of the week's hard days (quality, long, heavy lower, ride). */
  hard: boolean;
}

export interface RidePattern {
  label: string; // "trail MTB", "ride", …
  day_number: number;
  weekday: string;
  weeks_seen: number;
  weeks_window: number;
  typical_min: number | null;
  typical_load: "light" | "moderate" | "heavy";
  /** One sentence about where it sits in the week. */
  placement: string;
}

export interface RaceBuild {
  available: boolean;
  as_of: string;
  race: {
    event: string | null;
    date: string;
    distance_km: number;
    days_to_race: number;
    weeks_to_race: number;
    phase: RacePhase;
    target: RaceTarget | null;
    target_raw: string | null;
  } | null;
  prediction: RacePrediction | null;
  /** Pace bands, from the target pace when there is one, else the estimate. */
  paces: { anchored_on: "target" | "estimate"; race_pace_sec_per_km: number; bands: PaceBand[] } | null;
  this_week: {
    week_start: string;
    km: number;
    long_km: number | null;
    quality: { label: string; pace: PaceBand | null } | null;
    why: string;
  } | null;
  weeks: RaceBuildWeek[];
  leg_map: LegMapDay[];
  strength: {
    heavy_lower_days: string[];
    principle: string;
    layout: string | null; // the week-layout read's ONE sentence, when the week stacks
    clean: boolean;
  } | null;
  ride: RidePattern | null;
  review: {
    weeks: { week_start: string; km: number; runs: number }[];
    longest_recent_km: number | null;
    volume_word: "rising" | "steady" | "easing" | null;
  };
  why: string;
  reason: string | null; // why unavailable, in plain words
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const weekdayOfDayNumber = (n: number): string => WEEKDAYS[n - 1] ?? `day ${n}`;

/** Riegel's endurance model: T2 = T1 · (D2/D1)^1.06. */
export function riegel(knownSec: number, knownKm: number, targetKm: number): number {
  if (!(knownSec > 0) || !(knownKm > 0) || !(targetKm > 0)) return Number.NaN;
  return knownSec * (targetKm / knownKm) ** 1.06;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtPace(secPerKm: number): string {
  const s = Math.max(0, Math.round(secPerKm));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Parse what the athlete wrote as a race target. Accepts a finish time ("sub-1:45",
 * "1:45:00", "1h45", "under 1:50", "105 min") or a pace ("4:55/km", "5:00 min/km",
 * "7:55/mi"). A bare m:ss under 10 minutes on a race of 15 km or more is read as h:mm
 * ("1:45" for a half), otherwise as mm:ss ("22:30" for a 5k). null when nothing usable.
 */
export function parseRaceTarget(raw: string | null | undefined, distanceKm: number): RaceTarget | null {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text || !(distanceKm > 0)) return null;
  const cleaned = text.replace(/\b(sub|under|below|around|about|~|<)\b/g, " ").replace(/[<~]/g, " ");

  // Pace first — it carries its own unit, so it is unambiguous.
  const pace = cleaned.match(/(\d{1,2})[:.](\d{2})\s*(?:min)?\s*(?:\/|per)\s*(km|k|mi|mile)/);
  if (pace) {
    let perKm = Number(pace[1]) * 60 + Number(pace[2]);
    if (pace[3].startsWith("mi")) perKm /= 1.609344;
    if (perKm < 120 || perKm > 900) return null;
    return { sec: Math.round(perKm * distanceKm), pace_sec_per_km: perKm, raw: String(raw).trim(), kind: "pace" };
  }

  let sec: number | null = null;
  const hms = cleaned.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  const hM = cleaned.match(/(\d{1,2})\s*h(?:ours?|rs?)?\s*(\d{1,2})?/);
  const ms = cleaned.match(/(\d{1,3}):(\d{2})/);
  const minutes = cleaned.match(/(\d{2,3})\s*(?:min|minutes|mins)\b/);
  if (hms) sec = Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  else if (hM) sec = Number(hM[1]) * 3600 + (hM[2] ? Number(hM[2]) * 60 : 0);
  else if (ms) {
    const a = Number(ms[1]);
    const b = Number(ms[2]);
    // "1:45" on a half is an hour and forty-five; "22:30" on a 5k is minutes.
    sec = a <= 6 && distanceKm >= 15 ? a * 3600 + b * 60 : a * 60 + b;
  } else if (minutes) sec = Number(minutes[1]) * 60;
  if (sec == null || !(sec > 0)) return null;
  const perKm = sec / distanceKm;
  // Anything outside a 2:00–15:00 /km band is a typo, not a target.
  if (perKm < 120 || perKm > 900) return null;
  return { sec, pace_sec_per_km: perKm, raw: String(raw).trim(), kind: "time" };
}

/** Same calendar phase getEnduranceGoal derives, for a projected week. */
export function phaseForWeeks(weeksToRace: number, distanceKm: number): RacePhase {
  if (weeksToRace < 0) return "past";
  const longRace = distanceKm >= 15;
  const sharpenTo = longRace ? 5 : 4;
  const buildTo = longRace ? 14 : 10;
  return weeksToRace <= 2 ? "taper" : weeksToRace <= sharpenTo ? "sharpen" : weeksToRace <= buildTo ? "build" : "base";
}

// Offsets from RACE pace, seconds per km, by race class. The half is the reference:
// easy runs a minute-plus slower, the long run a little quicker than easy, tempo AT
// race pace, threshold around 10k pace, VO2 work around 5k pace. Shorter races push
// tempo/threshold slower relative to race pace (the race itself is the hard pace);
// the marathon pulls everything closer to race pace.
type Offsets = Record<Exclude<SessionPaceKey, "race">, [slow: number, fast: number]>;
function offsetsFor(distanceKm: number): Offsets {
  if (distanceKm > 30) return { easy: [80, 50], long: [50, 20], tempo: [-5, -12], threshold: [-15, -25], vo2: [-30, -40] };
  if (distanceKm >= 15) return { easy: [90, 60], long: [70, 40], tempo: [5, 0], threshold: [-5, -12], vo2: [-15, -25] };
  if (distanceKm >= 8) return { easy: [95, 65], long: [80, 50], tempo: [15, 8], threshold: [5, 0], vo2: [-8, -15] };
  return { easy: [100, 70], long: [90, 60], tempo: [35, 25], threshold: [20, 12], vo2: [3, 0] };
}

const PACE_LABELS: Record<SessionPaceKey, string> = {
  easy: "Easy",
  long: "Long run",
  tempo: "Tempo · race pace",
  threshold: "Threshold",
  vo2: "VO2 intervals",
  race: "Race pace",
};

/** Per-session pace bands from a race pace, for the goal distance. */
export function paceBandsFor(racePaceSecPerKm: number, distanceKm: number): PaceBand[] {
  const offsets = offsetsFor(distanceKm);
  const band = (key: SessionPaceKey, slowOff: number, fastOff: number): PaceBand => {
    const slow = Math.round(racePaceSecPerKm + slowOff);
    const fast = Math.round(racePaceSecPerKm + fastOff);
    return {
      key,
      label: PACE_LABELS[key],
      slow_sec_per_km: slow,
      fast_sec_per_km: fast,
      text: slow === fast ? `${fmtPace(fast)} /km` : `${fmtPace(fast)}–${fmtPace(slow)} /km`,
    };
  };
  return [
    band("race", 0, 0),
    band("easy", offsets.easy[0], offsets.easy[1]),
    band("long", offsets.long[0], offsets.long[1]),
    band("tempo", offsets.tempo[0], offsets.tempo[1]),
    band("threshold", offsets.threshold[0], offsets.threshold[1]),
    band("vo2", offsets.vo2[0], offsets.vo2[1]),
  ];
}

/** Which pace band a quality-session label is asking for. Hills are effort, not pace. */
export function paceKeyForQuality(label: string | null | undefined): SessionPaceKey | null {
  const s = String(label ?? "").toLowerCase();
  if (!s) return null;
  if (/hill/.test(s)) return null;
  if (/threshold|cruise/.test(s)) return "threshold";
  if (/vo2|400|800|1k rep|repeat|interval/.test(s)) return "vo2";
  if (/tempo|race[- ]pace|steady/.test(s)) return "tempo";
  return null;
}

const QUALITY_HINT: Record<RacePhase | "race_week" | "down", string> = {
  base: "Aerobic base — tempo touches and hills, mostly easy volume.",
  build: "Threshold repeats and race-pace tempo; the long run gets a race-pace finish once.",
  sharpen: "Race-pace tempo and shorter threshold — sharper, not more.",
  taper: "Short race-pace touches inside easy running; nothing that leaves the legs sore.",
  past: "",
  race_week: "Strides only. The work is done.",
  down: "A reset week — one light quality touch at most, the rest easy.",
};

const STRENGTH_HINT: Record<RacePhase | "race_week", string> = {
  base: "Two lower sessions a week, building loads — the base is where legs get strong.",
  build: "Heavy lower once a week, a lighter second; squats land after the quality run or the day after the long run.",
  sharpen: "Maintenance loads (2–3 sets of 3–5, nothing new) — power without soreness.",
  taper: "Light and fast: one short session, ~80% of working loads, last heavy lower ~10 days out.",
  past: "",
  race_week: "Legs off. A mobility session at most.",
};

/**
 * The ladder from `asOf`'s week to race week, walked through raceRamp one Monday at a
 * time so every week is the engine's own next safe step off the week before it.
 *
 * `thisWeek` is the live engine's prescription for the current week, when there is
 * one. It is not decoration: raceRamp reads its anchor as the week BEFORE, so the
 * current rung has to BE the prescription and has to be what the next rung steps
 * off. Hand it in and the ladder walks from what the athlete is actually running;
 * leave it out and the walk projects the current week from the anchor like any other.
 */
export function projectRaceBuildWeeks(
  goal: RaceRampGoal & { date: string; distance_km: number },
  asOf: string,
  anchorKm: number,
  anchorLongKm: number,
  thisWeek?: { km: number; long_km: number | null } | null,
  nextWeek?: { km: number; long_km: number | null } | null
): RaceBuildWeek[] {
  const out: RaceBuildWeek[] = [];
  const raceMonday = mondayOf(goal.date);
  const currentMonday = mondayOf(asOf);
  const nextMonday = addDaysISO(currentMonday, 7);
  let monday = currentMonday;
  let anchor = anchorKm > 0 ? anchorKm : 6;
  let long = anchorLongKm > 0 ? anchorLongKm : Math.max(3, anchor * 0.3);
  let guard = 0;
  while (monday <= raceMonday && guard++ < 60) {
    const r = raceRamp(goal, monday, anchor, long);
    if (!r) break;
    // The ladder is read by CALENDAR week: the week that holds race day is race week,
    // whatever weekday the start line falls on. raceRamp's own count is ceil(days/7)
    // from the Monday, so a Sunday race reads "1 week out" from its own Monday — the
    // right number for the engine's taper arithmetic, the wrong label for a ladder.
    const w = Math.round((Date.parse(`${raceMonday}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / (7 * 864e5));
    const phase = phaseForWeeks(r.weeks_to_race, goal.distance_km);
    // The KIND follows the engine's arithmetic, so the ladder never labels a week
    // "peak" that the engine will prescribe as a taper: race week is the calendar
    // week holding the race; the engine's 1 and 2 are its taper and peak weeks (for a
    // weekend race the peak is the week before race week and the taper IS race week).
    const e = r.weeks_to_race;
    const kind: RaceWeekKind =
      w <= 0 ? "race" : e <= 1 ? "taper" : e === 2 ? "peak" : r.down_week ? "down" : "build";
    // THIS week is not a projection when the engine has already prescribed it. And
    // the prescription cannot just be painted over the rung afterwards: raceRamp
    // takes the PRIOR week's volume as its anchor, so a walk that carried its own
    // projected step forward seeded the very next Monday one full ramp high — the
    // patched first rung, then every week after it two steps above the ladder it
    // claims to walk. The rung the athlete is running is the rung the walk steps off.
    // Same rule for next week: the engine's prescription, when it has one, is the rung.
    const live =
      monday === currentMonday && thisWeek && thisWeek.km > 0
        ? thisWeek
        : monday === nextMonday && nextWeek && nextWeek.km > 0
          ? nextWeek
          : null;
    const km = live ? live.km : r.required_km;
    const longKm = live ? (live.long_km ?? r.required_long_km) : r.required_long_km;
    out.push({
      week_start: monday,
      weeks_to_race: w,
      phase,
      kind,
      km,
      long_km: longKm,
      quality_hint: kind === "race" ? QUALITY_HINT.race_week : kind === "down" ? QUALITY_HINT.down : QUALITY_HINT[phase],
      strength_hint: kind === "race" ? STRENGTH_HINT.race_week : STRENGTH_HINT[phase],
      current: monday === currentMonday,
    });
    anchor = km;
    long = longKm;
    const next = addDaysISO(monday, 7);
    if (!next) break;
    monday = next;
  }
  return out;
}

/** The fit of an estimate against a target: a band, never a grade. */
export function raceFit(estimateSec: number, targetSec: number): RaceFit {
  const ratio = estimateSec / targetSec;
  return ratio <= 1.015 ? "fits" : ratio <= 1.08 ? "stretch" : "beyond_horizon";
}

// ---------------------------------------------------------------------------
// Readers (DB-backed)
// ---------------------------------------------------------------------------

const STANDARD_DISTANCES = [
  { key: "race_predict_5k_sec", km: 5 },
  { key: "race_predict_10k_sec", km: 10 },
  { key: "race_predict_half_sec", km: 21.0975 },
  { key: "race_predict_marathon_sec", km: 42.195 },
] as const;

function watchPrediction(asOf: string, distanceKm: number): RacePrediction | null {
  // The watch predicts four standard distances; the closest one is Riegel-adjusted
  // to the exact goal distance (a 21.1 km "half" moves by seconds, a 15 km race by
  // more — either way it is the athlete's own fitness, not a table).
  const nearest = STANDARD_DISTANCES.reduce((best, d) =>
    Math.abs(Math.log(d.km / distanceKm)) < Math.abs(Math.log(best.km / distanceKm)) ? d : best
  );
  let rows: { date: string; sec: number | null }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, ${nearest.key} AS sec FROM garmin_daily_metrics
          WHERE date <= ? AND date >= ? AND ${nearest.key} IS NOT NULL AND ${nearest.key} > 0
          ORDER BY date DESC, updated_at DESC, id DESC`
      )
      .all(asOf, isoDaysAgo(asOf, 70)) as any[];
  } catch {
    rows = [];
  }
  const latest = rows.find((r) => Number(r.sec) > 0);
  if (!latest) return null;
  // A stale predictor is not a current one: past ~3 weeks it says nothing about today.
  if ((daysBetweenISO(asOf, latest.date) ?? 99) > 21) return null;
  const estimate = riegel(Number(latest.sec), nearest.km, distanceKm);
  if (!Number.isFinite(estimate)) return null;
  // Trend: the reading closest to four weeks before the latest, at least three weeks back.
  const earlier = rows
    .filter((r) => Number(r.sec) > 0 && (daysBetweenISO(latest.date, r.date) ?? 0) >= 21)
    .sort((a, b) => Math.abs((daysBetweenISO(latest.date, a.date) ?? 0) - 28) - Math.abs((daysBetweenISO(latest.date, b.date) ?? 0) - 28))[0];
  let trend: RacePrediction["trend"] = null;
  if (earlier) {
    const before = riegel(Number(earlier.sec), nearest.km, distanceKm);
    const delta = Math.round(estimate - before);
    const rel = delta / before;
    trend = { delta_sec: delta, since: earlier.date, word: rel <= -0.01 ? "faster" : rel >= 0.01 ? "slower" : "steady" };
  }
  return {
    estimate_sec: Math.round(estimate),
    estimate_pace_sec_per_km: Math.round(estimate / distanceKm),
    basis: "watch_predictor",
    basis_detail: `your watch's ${nearest.km >= 42 ? "marathon" : nearest.km >= 21 ? "half-marathon" : `${nearest.km}k`} prediction, adjusted to ${round1(distanceKm)} km`,
    as_of: latest.date,
    trend,
    gap_sec: null,
    fit: null,
  };
}

interface RunRow {
  date: string;
  km: number;
  min: number;
}

function recentRuns(asOf: string, days: number): RunRow[] {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, type, raw_text, notes, distance_km, duration_min FROM activities
          WHERE date <= ? AND date >= ? ORDER BY date DESC`
      )
      .all(asOf, isoDaysAgo(asOf, days)) as any[];
  } catch {
    return [];
  }
  const out: RunRow[] = [];
  for (const r of rows) {
    const region = matchEnduranceModality(String(r.type || ""), `${r.raw_text || ""} ${r.notes || ""}`);
    if (!region || region.mode !== "run") continue;
    const km = Number(r.distance_km);
    const min = Number(r.duration_min);
    out.push({ date: String(r.date), km: Number.isFinite(km) ? km : 0, min: Number.isFinite(min) ? min : 0 });
  }
  return out;
}

function runPrediction(distanceKm: number, runs: RunRow[]): RacePrediction | null {
  // The fastest recent run of at least 5 km, extrapolated with Riegel. Training runs
  // are not races, so this reads conservative — it is said as such.
  const paced = runs.filter((r) => r.km >= 5 && r.min > 0);
  if (!paced.length) return null;
  const best = paced.reduce((a, b) => (b.min / b.km < a.min / a.km ? b : a));
  const estimate = riegel(best.min * 60, best.km, distanceKm);
  if (!Number.isFinite(estimate)) return null;
  return {
    estimate_sec: Math.round(estimate),
    estimate_pace_sec_per_km: Math.round(estimate / distanceKm),
    basis: "recent_run_riegel",
    basis_detail: `your ${round1(best.km)} km run on ${best.date} (${fmtPace((best.min * 60) / best.km)} /km), extended to race distance — a training run, so this reads conservative`,
    as_of: best.date,
    trend: null,
    gap_sec: null,
    fit: null,
  };
}

function weeklyReview(asOf: string, runs: RunRow[]): RaceBuild["review"] {
  const thisMonday = mondayOf(asOf);
  const byWeek = new Map<string, { km: number; runs: number }>();
  for (const r of runs) {
    const wk = mondayOf(r.date);
    if (wk >= thisMonday) continue; // closed weeks only
    const cur = byWeek.get(wk) ?? { km: 0, runs: 0 };
    cur.km += r.km;
    cur.runs += 1;
    byWeek.set(wk, cur);
  }
  const weeks: RaceBuild["review"]["weeks"] = [];
  for (let i = 4; i >= 1; i--) {
    const wk = addDaysISO(thisMonday, -7 * i);
    if (!wk) continue;
    const cur = byWeek.get(wk) ?? { km: 0, runs: 0 };
    weeks.push({ week_start: wk, km: round1(cur.km), runs: cur.runs });
  }
  const longest = runs.filter((r) => (daysBetweenISO(asOf, r.date) ?? 99) <= 28).reduce((m, r) => Math.max(m, r.km), 0);
  const first = weeks.slice(0, 2).reduce((s, w) => s + w.km, 0) / 2;
  const last = weeks.slice(2).reduce((s, w) => s + w.km, 0) / 2;
  const volume_word: RaceBuild["review"]["volume_word"] =
    first <= 0 && last <= 0 ? null : last >= first * 1.1 ? "rising" : last <= first * 0.9 ? "easing" : "steady";
  return { weeks, longest_recent_km: longest > 0 ? round1(longest) : null, volume_word };
}

const RIDE_LABEL = /ride|mtb|cycling|gravel/i;

function ridePattern(impacts: EnduranceImpact[]): Omit<RidePattern, "placement"> | null {
  const rides = impacts.filter((i) => RIDE_LABEL.test(i.label) || RIDE_LABEL.test(i.type));
  if (!rides.length) return null;
  const weeksWindow = 6;
  const weeks = new Set(rides.map((r) => mondayOf(r.date)));
  if (weeks.size < 3) return null; // three of six weeks makes a habit; less is an outing
  const byDow = new Map<number, number>();
  for (const r of rides) byDow.set(isoDow(r.date), (byDow.get(isoDow(r.date)) ?? 0) + 1);
  const [dow] = [...byDow.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const mins = rides.map((r) => r.duration_min ?? 0).filter((m) => m > 0).sort((a, b) => a - b);
  const typical_min = mins.length ? mins[Math.floor(mins.length / 2)] : null;
  const loads = rides.map((r) => r.load);
  const typical_load: RidePattern["typical_load"] = loads.filter((l) => l === "heavy").length * 2 >= loads.length
    ? "heavy"
    : loads.filter((l) => l !== "light").length * 2 >= loads.length
      ? "moderate"
      : "light";
  const labelCounts = new Map<string, number>();
  for (const r of rides) labelCounts.set(r.label, (labelCounts.get(r.label) ?? 0) + 1);
  const label = [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const day_number = dowToDayNumber(dow);
  return { label, day_number, weekday: weekdayOfDayNumber(day_number), weeks_seen: weeks.size, weeks_window: weeksWindow, typical_min, typical_load };
}

const nextDay = (d: number): number => (d === 7 ? 1 : d + 1);
const prevDay = (d: number): number => (d === 1 ? 7 : d - 1);

function ridePlacement(
  ride: Omit<RidePattern, "placement">,
  longDay: number | null,
  qualityDay: number | null,
  heavyLower: Set<number>,
  easyDays: Set<number>,
  date: string
): string {
  const d = ride.day_number;
  if (longDay != null && d === longDay) {
    return `Your ${ride.label} usually lands on the long-run day (${ride.weekday}). One or the other — if it has to be both, the ride goes easy and short.`;
  }
  if (longDay != null && nextDay(d) === longDay) {
    return `Your ${ride.label} sits the day before the long run. Keep it genuinely easy so the legs arrive fresh, or trade it onto an easy-run day.`;
  }
  if (qualityDay != null && nextDay(d) === qualityDay) {
    return `Your ${ride.label} sits the day before the quality run. Easy spinning only — the hard effort is tomorrow.`;
  }
  if (heavyLower.has(d)) {
    const clear = [...easyDays].filter((e) => e !== longDay && e !== qualityDay && !heavyLower.has(e) && nextDay(e) !== longDay);
    const move = clear.length ? ` — or move the ride to ${weekdayOfDayNumber(clear[0])}, an easy-run day` : "";
    return `Ride and heavy legs share ${ride.weekday}. Lift first if both happen, and let the ride be the easy half${move}.`;
  }
  if (longDay != null && prevDay(d) === longDay) {
    return `Your ${ride.label} follows the long run (${weekdayOfDayNumber(longDay)} then ${ride.weekday}). That is a loaded weekend — keep the ride easy and let it be the recovery spin, not a second hard day.`;
  }
  const variants = [
    `Your ${ride.label} on ${ride.weekday} sits clear of the hard runs — it counts as aerobic work, so keep it mostly easy through the build.`,
    `${ride.weekday}'s ${ride.label} is in a clean slot. Treat it as an easy aerobic day: it adds to the base without taking from the key runs.`,
    `The ${ride.label} on ${ride.weekday} fits the week as it is. Mostly easy, and it never needs to replace a run.`,
  ];
  return pickDayVariant(variants, date, "race-build:ride-clear");
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

const WHY_VARIANTS = [
  "{weeks} weeks to {event}: this week is {km} km with a {long} km long run. {estimate}",
  "{event} is {weeks} weeks out. The week asks for {km} km, long run {long} km. {estimate}",
  "Building toward {event}, {weeks} weeks away — {km} km this week, {long} km long. {estimate}",
] as const;

function estimateSentence(p: RacePrediction | null, t: RaceTarget | null): string {
  if (!p) return t ? `Target ${fmtClock(t.sec)} (${fmtPace(t.pace_sec_per_km)} /km).` : "";
  const est = `Current shape reads about ${fmtClock(p.estimate_sec)} (${fmtPace(p.estimate_pace_sec_per_km)} /km)`;
  const trend = p.trend ? `, ${p.trend.word === "steady" ? "holding steady" : `${Math.abs(Math.round(p.trend.delta_sec / 60))} min ${p.trend.word}`} over the last month` : "";
  if (!t) return `${est}${trend}.`;
  const gap = p.gap_sec ?? 0;
  const vs =
    p.fit === "fits"
      ? `— inside the ${fmtClock(t.sec)} target`
      : p.fit === "stretch"
        ? `— ${fmtClock(Math.abs(gap))} off the ${fmtClock(t.sec)} target, a stretch the build can close`
        : `— ${fmtClock(Math.abs(gap))} off the ${fmtClock(t.sec)} target; the honest goal this time may be the distance itself`;
  return `${est}${trend} ${vs}.`;
}

export function raceBuild(
  date?: string,
  opts?: { runPlan?: WeeklyRunPlan | null; weekLayout?: WeekLayoutRead | null }
): RaceBuild {
  const asOf = date || localDateISO();
  const empty = (reason: string): RaceBuild => ({
    available: false,
    as_of: asOf,
    race: null,
    prediction: null,
    paces: null,
    this_week: null,
    weeks: [],
    leg_map: [],
    strength: null,
    ride: null,
    review: { weeks: [], longest_recent_km: null, volume_word: null },
    why: "",
    reason,
  });

  const goal = getEnduranceGoal(asOf);
  if (!goal || !goal.is_race || !goal.date) return empty("No dated race on file — set one and the build reads from it.");
  const distance = Number(goal.distance_km);
  if (!(distance > 0)) return empty("The race has no distance yet — add it and the build can be laid out.");
  if (goal.phase === "past" || (goal.days_to_race ?? 0) < 0) return empty("The race is behind you. A new date starts a new build.");
  const weeksToRace = Math.max(0, goal.weeks_to_race ?? 0);
  const phase: RacePhase = goal.phase ?? phaseForWeeks(weeksToRace, distance);

  // ---- this week, from the live engine ----
  const plan = opts?.runPlan === undefined ? safe(() => weeklyRunPlan(asOf)) : opts.runPlan;
  const runs = plan?.available ? plan.runs : [];
  const weekKm = round1(runs.reduce((s, r) => s + (r.target_distance_km != null ? Number(r.target_distance_km) : 0), 0));
  const longRun = runs.find((r) => r.kind_label === "long") ?? null;
  const qualityRun = runs.find((r) => r.kind_label === "quality") ?? null;
  const longKm = longRun?.target_distance_km != null ? Number(longRun.target_distance_km) : null;

  // ---- prediction + target ----
  const logRuns = recentRuns(asOf, 42);
  const target = parseRaceTarget(goal.target, distance);
  let prediction = watchPrediction(asOf, distance) ?? runPrediction(distance, logRuns);
  if (prediction && target) {
    prediction = { ...prediction, gap_sec: prediction.estimate_sec - target.sec, fit: raceFit(prediction.estimate_sec, target.sec) };
  }
  const racePace = target?.pace_sec_per_km ?? prediction?.estimate_pace_sec_per_km ?? null;
  const paces =
    racePace != null
      ? { anchored_on: (target ? "target" : "estimate") as "target" | "estimate", race_pace_sec_per_km: Math.round(racePace), bands: paceBandsFor(racePace, distance) }
      : null;
  const qualityKey = paceKeyForQuality(qualityRun?.label ?? plan?.quality_focus);
  const qualityPace = paces && qualityKey ? paces.bands.find((b) => b.key === qualityKey) ?? null : null;

  // ---- the ladder ----
  const review = weeklyReview(asOf, logRuns);
  const anchorKm = weekKm > 0 ? weekKm : review.weeks.at(-1)?.km || 0;
  const anchorLong = longKm ?? review.longest_recent_km ?? 0;
  const rampGoal = { ...goal, date: goal.date, distance_km: distance };
  // The engine's own prescription is the truth for this week, and the rung the rest
  // of the ladder steps off (see projectRaceBuildWeeks).
  // The engine already knows next week (an upcoming recovery week, a hold, a stated
  // schedule change); handed to the ladder, the second rung is the engine's own number
  // rather than a projection that disagrees with the run list one card down.
  const nextMonday = addDaysISO(mondayOf(asOf), 7);
  const nextPlan = nextMonday ? safe(() => weeklyRunPlan(nextMonday)) : null;
  const nextRuns = nextPlan?.available ? nextPlan.runs : [];
  const nextKm = round1(nextRuns.reduce((s, r) => s + (r.target_distance_km != null ? Number(r.target_distance_km) : 0), 0));
  const nextLong = nextRuns.find((r) => r.kind_label === "long");
  const weeks = projectRaceBuildWeeks(
    rampGoal,
    asOf,
    anchorKm,
    anchorLong,
    weekKm > 0 ? { km: weekKm, long_km: longKm } : null,
    nextKm > 0 ? { km: nextKm, long_km: nextLong?.target_distance_km != null ? Number(nextLong.target_distance_km) : null } : null
  );

  // ---- the ring: runs, strength, ride ----
  const heavyLower = safe(() => lowerBodyPlanDayNumbers()) ?? new Set<number>();
  const strengthDays = new Map<number, { name: string; heavy_lower: boolean }>();
  for (const g of safe(() => planDayStrengthGroups()) ?? []) {
    if (g.day_type === "rest" || !g.groups.length) continue;
    strengthDays.set(g.day_number, { name: planDayName(g.day_number) ?? g.focus ?? "Strength", heavy_lower: g.heavy_lower });
  }
  const impacts = safe(() => recentEnduranceImpacts(42, asOf)) ?? [];
  const rideBase = ridePattern(impacts);
  const longDay = longRun?.day_number ?? null;
  const qualityDay = qualityRun?.day_number ?? null;
  const easyDays = new Set(runs.filter((r) => r.kind_label === "easy").map((r) => r.day_number));
  const ride: RidePattern | null = rideBase
    ? { ...rideBase, placement: ridePlacement(rideBase, longDay, qualityDay, heavyLower, easyDays, asOf) }
    : null;
  // The run engine's slots are weekday-numbered (Mon=1) once a schedule is stated,
  // but the strength template's day_number is a ring index — the athlete's lifting
  // week lays that ring onto weekdays (thisWeekPlanDayMap), the same map the Plan
  // tab's week strip draws from. Read strength through it so the two agree; with no
  // lifting week stated the plain Mon=Day1 convention is the only honest fallback.
  const weekMap = safe(() => thisWeekPlanDayMap(asOf).map) ?? new Map<number, { day_number: number }>();
  const weekdayMap = new Map([...weekMap].map(([dow, c]) => [dow, c.day_number]));
  const leg_map: LegMapDay[] = [];
  for (let d = 1; d <= 7; d++) {
    const run = runs.find((r) => r.day_number === d) ?? null;
    const mapped = weekMap.size ? weekMap.get(d === 7 ? 0 : d) ?? null : null;
    const strengthDayNumber = weekMap.size ? (mapped ? mapped.day_number : null) : d;
    const strength = strengthDayNumber == null ? null : strengthDays.get(strengthDayNumber) ?? null;
    const isRide = ride?.day_number === d;
    leg_map.push({
      day_number: d,
      weekday: weekdayOfDayNumber(d),
      run: run ? { kind: run.kind_label, label: run.label || `${run.kind_label} run`, km: run.target_distance_km != null ? Number(run.target_distance_km) : null } : null,
      strength,
      ride: isRide,
      hard: !!(run && run.kind_label !== "easy") || !!strength?.heavy_lower || (isRide && ride?.typical_load !== "light"),
    });
  }

  // ---- strength placement ----
  const layout =
    opts?.weekLayout === undefined
      ? safe(() => {
          const lifting = strengthScheduleRead(asOf);
          return weekLayoutRead(asOf, {
            runPlan: plan ?? null,
            strengthDows: lifting.days.map((d) => d.dow),
            liftDaysSource: lifting.source,
            enduranceDows: statedRunDows(),
            weekdayMap,
          });
        })
      : opts.weekLayout;
  const strength: RaceBuild["strength"] = {
    // Same map as the leg map: with a stated lifting week a template day's weekday is
    // wherever the ring lands it, not its number. Unmapped (a day the week does not
    // reach) is left out rather than given a weekday it will not be trained on.
    heavy_lower_days: weekMap.size
      ? [1, 2, 3, 4, 5, 6, 7]
          .filter((d) => {
            const m = weekMap.get(d === 7 ? 0 : d);
            return !!m && heavyLower.has(m.day_number);
          })
          .map(weekdayOfDayNumber)
      : [...heavyLower].sort((a, b) => a - b).map(weekdayOfDayNumber),
    principle: weeksToRace <= 0 ? STRENGTH_HINT.race_week : STRENGTH_HINT[phase],
    layout: layout && !layout.clean ? layout.suggestion : null,
    clean: layout ? layout.clean : true,
  };

  const event = goal.event || `your ${round1(distance)} km race`;
  const why = pickDayVariant(WHY_VARIANTS, asOf, "race-build:why")
    .replace("{weeks}", String(weeksToRace))
    .replace("{event}", event)
    .replace("{km}", String(Math.round(weekKm || anchorKm)))
    .replace("{long}", String(longKm != null ? round1(longKm) : round1(weeks[0]?.long_km ?? 0)))
    .replace("{estimate}", estimateSentence(prediction, target))
    .trim();

  return {
    available: true,
    as_of: asOf,
    race: {
      event: goal.event ?? null,
      date: goal.date,
      distance_km: distance,
      days_to_race: goal.days_to_race ?? 0,
      weeks_to_race: weeksToRace,
      phase,
      target,
      target_raw: goal.target ?? null,
    },
    prediction,
    paces,
    this_week: plan?.available
      ? {
          week_start: plan.week_start,
          km: weekKm,
          long_km: longKm,
          quality: qualityRun ? { label: qualityRun.label || plan.quality_focus || "Quality run", pace: qualityPace } : null,
          why: plan.why,
        }
      : null,
    weeks,
    leg_map,
    strength,
    ride,
    review,
    why,
    reason: null,
  };
}

function planDayName(dayNumber: number): string | null {
  try {
    const row = db.prepare(`SELECT name FROM plan_days WHERE day_number = ?`).get(dayNumber) as { name?: string } | undefined;
    return row?.name ? String(row.name) : null;
  } catch {
    return null;
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
