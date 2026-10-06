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
import { withoutShadowActivities } from "./activity-shadow.js";
import { weekLayoutRead, type WeekLayoutRead } from "../domain/training/week-layout.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { matchEnduranceModality } from "./heavy-load.js";
import { easyCeiling, getHrModel } from "./hr-model.js";
import { crossTrainingDays, crossTrainingLoadsLegs, crossTrainingNoun } from "./cross-training-day.js";
import { heavyLowerWeekdaySlots, thisWeekPlanDayMap } from "./plan-selection.js";
import { getEnduranceGoal, isoDow, statedRunDows } from "./profile.js";
import { strengthScheduleRead } from "./strength-schedule.js";
import {
  type CurrentWeekClosed,
  type CurrentWeekClosedReason,
  currentWeekClosedEarly,
  weekLayoutClosed,
} from "./week-layout-closed.js";
import {
  type FlexibleRunIntent,
  type FlexibleTrainingAgenda,
  flexibleTrainingAgenda,
  plannedRunLine,
  type RunCompletionEvidence,
  type RunEffortWord,
} from "./flexible-training-agenda.js";
import { ENDURANCE_CHRONIC_FLOOR_KM } from "./program-state.js";
import {
  acwrCeilingKm,
  capacityResumeKm,
  deliverableRunWeek,
  raceRamp,
  RESET_TAKEN_FRACTION,
  type RaceRampCapacity,
  type RaceRampGoal,
} from "./run-ramp.js";
import { weekAsPlanned, weeklyRunPlan, type WeeklyRunPlan } from "./run-progression.js";
import {
  capacitySetAsideLine,
  closedWeekRunHarm,
  demonstratedLongKm,
  demonstratedRunCapacity,
} from "./run-capacity.js";
import type { HarmEvidenceKind } from "./brain/read-adherence.js";
import { localDateISO } from "./shared.js";
import {
  dateWords,
  distanceWords,
  KM_PER_MI,
  paceBandWords,
  paceWords,
  type DistanceUnit,
} from "./display-words.js";
import { athleteUnits } from "./settings.js";
import { STAGE_WEEK_WORD, stageKeyOf } from "./stage-words.js";
import { planDayStrengthGroups } from "./training-read.js";
import { registerRaceLadderPeak, type RaceLadderPlanDraft } from "./race-ladder-hook.js";
import { type RaceStrengthLead, raceStrengthLead, raceStrengthPrinciple } from "./race-strength.js";
import { getTrainingIntent } from "./training-intent.js";
import { copyFlat, memoKey, requestMemo } from "./request-memo.js";

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
  /**
   * Easy and long bands only: the personal HR model's easy ceiling (top of Z2), so
   * the card carries the pull line beside the pace. Absent when the model can't say.
   */
  hr_ceiling_bpm?: number | null;
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
  /**
   * The week's ONE coaching sentence, in the athlete's register (never the engine's):
   * what this week is for. `quality_hint` / `strength_hint` stay the machine register
   * the prompts read.
   */
  focus: string;
  /** The same week in a few words, for a row: "Race-pace work", "Longest long run". */
  focus_short: string;
  /**
   * The week's ONE stage word as a week tag (stage-words.ts: a build rung by its phase,
   * every other rung by its kind) — "Sharpen week", "Peak week". Every surface that
   * names this week reads it.
   */
  stage_word?: string;
  /**
   * The rung is bigger than any closed week on record (`best_week_km`, run-capacity.ts)
   * and every rung before it — a genuine new milestone, said in words, never a score.
   */
  new_high: boolean;
  /**
   * How the lifting and the running fit this week, in words: heavy-leg days against the
   * key runs on the week's ring, and the taper / race-week / key-run-eve trims the
   * stress budget (stress-budget.ts) already applies. "" when the week has no lifting
   * or no running to fit together (a lifting-only or running-only athlete).
   */
  with_lifting: string;
  /** True for the week containing `as_of`. */
  current: boolean;
  /**
   * The current week only, once its running is done before Sunday night
   * (`currentWeekClosedEarly`): the rung then IS the week as run — `km` is the logged
   * volume — and `planned_km` keeps what the engine prescribed for it.
   */
  closed?: boolean;
  planned_km?: number | null;
  /**
   * The peak sits within ~5% of the biggest week already run (either side): it is said
   * as about that week rather than claimed as a new high.
   */
  holds_high?: boolean;
}

/**
 * One run of this week, actual first: what was run, then the plan it answered. Lines
 * and the adjustment words are in km; a surface restates figures in run units.
 */
export interface RaceWeekRun {
  activity_id: number;
  date: string;
  weekday: string;
  title: string | null;
  km: number | null;
  duration_min: number | null;
  pace_sec_per_km: number | null;
  avg_hr: number | null;
  /** The grade, machine form: the personal model's easy / steady / quality (stated easy is easy). */
  intensity: "easy" | "steady" | "quality";
  /** The same grade as the athlete reads it: "easy", "steady" or "hard" — never the watch's label. */
  intensity_word: RunEffortWord;
  /** The athlete stated it easy (RPE ≤ 4): easy whatever the heart rate says. */
  stated_easy: boolean;
  /** The planned run it closed (its slot's kind and id); null for an extra. */
  kind: "easy" | "quality" | "long" | null;
  intent_id: string | null;
  /** A run that closed no planned run: shown as an extra, never dropped. */
  extra: boolean;
  /** The week's own plan for the run it closed — never a morning label it ran past. */
  planned: { kind: "easy" | "quality" | "long"; label: string; km: number | null } | null;
  /** What this morning made of that plan, in words ("shortened to 8 km this morning"); null when nothing. */
  adjustment: string | null;
  /** The run as run, in km: "13.5 km · 6:11/km · easy". */
  actual_line: string;
  /** The plan as a quiet second line, in km ("Planned long run 10.7 km, shortened to 8 km this morning."). */
  plan_line: string;
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
  /** "stated" — the optional day the athlete named; "observed" — a pattern read off the log. */
  source: "stated" | "observed";
  /** The load family of the day (ride, paddle, swim, walk, …): the field keeps its name. */
  sport_family: string;
}

/**
 * What running the athlete has, so a surface can size itself to the person: `race` a
 * dated race build, `runs` running without one (stated run days, a goal that is not a
 * dated race, or runs in the log), `none` a lifting-only athlete — no run or race
 * surface at all.
 */
export type RunningPresence = "race" | "runs" | "none";

export interface RaceBuild {
  available: boolean;
  as_of: string;
  /** The athlete's run units: every SENTENCE here (and each band's `text`) says its distances and paces in them. */
  units?: DistanceUnit;
  /**
   * `null` on a no-race read that did not ask (`describeRunning` off): telling a runner
   * from a lifter costs a log read the internal callers never need. A dated build is
   * always `race`.
   */
  running: RunningPresence | null;
  race: {
    event: string | null;
    date: string;
    distance_km: number;
    days_to_race: number;
    weeks_to_race: number;
    phase: RacePhase;
    target: RaceTarget | null;
    /**
     * The faster milestone the athlete named beside the target ("…; 1:50 stretch"), with
     * where today's estimate sits against it — a place, never a grade. null with none.
     */
    stretch: (RaceTarget & { fit: RaceFit | null }) | null;
    target_raw: string | null;
  } | null;
  prediction: RacePrediction | null;
  /** Pace bands, from the target pace when there is one, else the estimate. */
  paces: { anchored_on: "target" | "estimate"; race_pace_sec_per_km: number; bands: PaceBand[] } | null;
  this_week: {
    week_start: string;
    km: number;
    long_km: number | null;
    /** Kilometres already run this week (Monday through `as_of`), from the log. */
    logged_km: number;
    quality: { label: string; pace: PaceBand | null } | null;
    why: string;
    /**
     * The week's running is done before Sunday night (`currentWeekClosedEarly`): the
     * ladder and the capacity read treat it as a closed week today, not next Monday.
     */
    closed: boolean;
    closed_reason: CurrentWeekClosedReason | null;
    /** Every run logged this week, date order, actual first — extras included (`extra: true`). */
    runs: RaceWeekRun[];
    /**
     * The week in two lines, written here and never in a renderer: a short headline
     * (variant set) and one detail line in km built from actual vs plan, a new high,
     * the easy/hard mix and the long run. Null with no run logged yet.
     */
    headline: string | null;
    detail: string | null;
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
  /**
   * What the running has already demonstrated, read at the Sunday this week is planned
   * from (run-capacity.ts): the week the build climbs from, and the bigger weeks set
   * aside because the body paid for them. `note` is the one plain-word sentence saying
   * so, in km ("" when nothing is set aside) — the page restates its figures in the
   * athlete's run units. Null on a read with no dated race.
   */
  capacity: {
    floor_km: number | null;
    floor_week_start: string | null;
    best_week_km: number | null;
    set_aside: { week_start: string; km: number; kind: HarmEvidenceKind }[];
    note: string;
  } | null;
  review: {
    weeks: { week_start: string; km: number; runs: number }[];
    longest_recent_km: number | null;
    volume_word: "rising" | "steady" | "easing" | null;
    /** The current week closed early and is the last of the four (see `this_week.closed`). */
    includes_this_week?: boolean;
  };
  /**
   * One calm sentence when the forward ladder moved because of this week: "" otherwise.
   * In km; a suggestion, never a verdict.
   */
  adapted: string;
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
  // "1:50 stretch; sub-2:00" is a goal of 2:00 — the stretch clause is never the target.
  const parts = targetClauses(raw);
  const primary = parts.length > 1 ? parts.filter((p) => !STRETCH_WORD.test(p)).join(" ") : "";
  return parseTargetClause(primary || raw, raw, distanceKm);
}

/** "sub-2:00 target; 1:50 stretch" → ["sub-2:00 target", "1:50 stretch"]. */
function targetClauses(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/[;,|\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const STRETCH_WORD = /\bstretch\b/i;

/**
 * The stretch the athlete named beside the target ("sub-2:00 target; 1:50 stretch"):
 * a second, faster milestone, never the goal itself. null when none is named, or when it
 * is not faster than the target.
 */
export function parseRaceStretch(raw: string | null | undefined, distanceKm: number): RaceTarget | null {
  const clause = targetClauses(raw).find((p) => STRETCH_WORD.test(p));
  if (!clause) return null;
  const stretch = parseTargetClause(clause, clause, distanceKm);
  const target = parseRaceTarget(raw, distanceKm);
  return stretch && target && stretch.sec < target.sec ? stretch : null;
}

function parseTargetClause(clause: string | null | undefined, raw: string | null | undefined, distanceKm: number): RaceTarget | null {
  const text = String(clause ?? "")
    .trim()
    .toLowerCase();
  if (!text || !(distanceKm > 0)) return null;
  const cleaned = text.replace(/\b(sub|under|below|around|about|~|<)\b/g, " ").replace(/[<~]/g, " ");

  // Pace first — it carries its own unit, so it is unambiguous.
  const pace = cleaned.match(/(\d{1,2})[:.](\d{2})\s*(?:min)?\s*(?:\/|per)\s*(km|k|mi|mile)/);
  if (pace) {
    let perKm = Number(pace[1]) * 60 + Number(pace[2]);
    if (pace[3].startsWith("mi")) perKm /= KM_PER_MI;
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
export function paceBandsFor(racePaceSecPerKm: number, distanceKm: number, units: DistanceUnit = "km"): PaceBand[] {
  const offsets = offsetsFor(distanceKm);
  const band = (key: SessionPaceKey, slowOff: number, fastOff: number): PaceBand => {
    const slow = Math.round(racePaceSecPerKm + slowOff);
    const fast = Math.round(racePaceSecPerKm + fastOff);
    return {
      key,
      label: PACE_LABELS[key],
      slow_sec_per_km: slow,
      fast_sec_per_km: fast,
      text: paceBandWords(fast, slow, units),
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

// The easy ceiling the run intensity read and the prescriptions already hold easy
// running to (the personal model's Z2 top plus its one noise tolerance — `easyCeiling`,
// the same number every other surface speaks). A pace band alone lets an easy run drift
// into Z3 on a warm or hilly day at the right pace; the ceiling is the line that holds.
function easyCeilingBpm(asOf: string): number | null {
  try {
    const ceiling = easyCeiling(getHrModel(asOf));
    return ceiling != null && ceiling > 0 ? ceiling : null;
  } catch {
    return null;
  }
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

// The phase's strength principle has ONE source (race-strength.ts): it depends on the
// athlete's training intent, so a strength-led athlete keeps progressing through the
// build while an endurance-led one keeps the classic maintenance-then-taper arc.

// The week's ONE coaching sentence, the athlete's register. The kind speaks first (a
// peak, a reset, the taper and race week are their own weeks); a build week speaks by
// its phase. Motivating, never a quota, never an engine word.
const WEEK_FOCUS: Record<Exclude<RaceWeekKind, "build"> | Exclude<RacePhase, "past" | "taper">, string> = {
  base: "Mostly easy running to grow the engine, with hills or a short tempo to keep the legs sharp.",
  build: "The weeks that make the fitness: one threshold or tempo session, and a long run that keeps stretching.",
  sharpen: "Sharpen rather than add: race-pace tempo and shorter threshold work while the volume holds.",
  peak: "The biggest week of the build: the long run tops out, so the other runs stay truly easy.",
  down: "A lighter week on purpose, so the last few weeks of work settle in and the next one starts fresh.",
  taper: "Less volume with a little speed kept in, so race day finds the legs sharp.",
  race: "Short easy runs and a few strides. The work is done; arrive fresh.",
};

const WEEK_FOCUS_SHORT: typeof WEEK_FOCUS = {
  base: "Easy volume, hills",
  build: "Threshold and a longer long run",
  sharpen: "Race-pace work",
  peak: "Longest long run",
  down: "A lighter week",
  taper: "Less volume, speed kept",
  race: "Easy runs and strides",
};

function focusKey(kind: RaceWeekKind, phase: RacePhase): keyof typeof WEEK_FOCUS | null {
  if (kind !== "build") return kind;
  if (phase === "taper") return "sharpen";
  return phase === "past" ? null : phase;
}

/** This week's focus when the engine's week holds no quality run: the week as it is. */
const AEROBIC_WEEK_FOCUS = "An aerobic week: the easy runs and the long run carry the build, with no hard session asked.";
const AEROBIC_WEEK_FOCUS_SHORT = "Easy runs and the long run";

/** The coaching sentence for one rung of the ladder. */
export function weekFocus(kind: RaceWeekKind, phase: RacePhase): string {
  const key = focusKey(kind, phase);
  return key ? WEEK_FOCUS[key] : "";
}

/** The rung's focus in a few words, for a ladder row. */
export function weekFocusShort(kind: RaceWeekKind, phase: RacePhase): string {
  const key = focusKey(kind, phase);
  return key ? WEEK_FOCUS_SHORT[key] : "";
}

// The quality session a label asks for, as a phrase in the athlete's words, or null
// for a label no session word fits (a fartlek, a label the engine never writes).
function qualitySessionWords(label: string | null | undefined): string | null {
  if (/hill/i.test(String(label ?? ""))) return "hill repeats";
  const key = paceKeyForQuality(label);
  if (key === "vo2") return "VO2 intervals";
  if (key === "threshold") return "threshold work";
  if (key === "tempo") return "a tempo run";
  return null;
}

const capFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * This week's focus when the engine's week holds a quality run: the phase's sentence
 * with the session the week actually carries named in it, so the focus never asks for a
 * threshold session on the week the card lists VO2 intervals. Only a build week whose
 * phase sentence names a session is rewritten (base, build, sharpen); a peak, reset,
 * taper or race week names none, and an unrecognised label keeps the phase's words.
 * `null` when there is nothing to rewrite.
 */
export function qualityWeekFocus(
  kind: RaceWeekKind,
  phase: RacePhase,
  qualityLabel: string | null | undefined
): { focus: string; focus_short: string } | null {
  if (kind !== "build") return null;
  const session = qualitySessionWords(qualityLabel);
  if (!session) return null;
  switch (focusKey(kind, phase)) {
    case "base":
      return {
        focus: `Mostly easy running to grow the engine, with ${session} to keep the legs sharp.`,
        focus_short: `Easy volume and ${session}`,
      };
    case "build":
      return {
        focus: `The weeks that make the fitness: ${session}, and a long run that keeps stretching.`,
        focus_short: `${capFirst(session)} and a longer long run`,
      };
    case "sharpen":
      return {
        focus: `Sharpen rather than add: ${session} while the volume holds.`,
        focus_short: `${capFirst(session)}, volume holds`,
      };
    default:
      return null;
  }
}

// The stress budget's own week kinds and phases for the key-run eve (stress-budget.ts
// EVE_WEEK_KINDS / EVE_PHASES): outside them the eve is left as written, so the words
// never claim a trim the day will not carry.
const EVE_KINDS: ReadonlySet<RaceWeekKind> = new Set(["build", "down", "peak"]);
const EVE_PHASES: ReadonlySet<RacePhase> = new Set(["build", "sharpen", "taper"]);

const RUN_WORD = (kind: "quality" | "long"): string => (kind === "long" ? "long run" : "quality run");

function weekdayList(days: readonly string[]): string {
  if (days.length <= 1) return days[0] ?? "";
  return `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
}

/**
 * How lifting and running fit in one week of the build, in words, off the week's ring
 * (`legMap`, the same seven days the athlete trains every week of it). Taper and race
 * week say the stress budget's leg trims; a build, reset or peak week says where heavy
 * legs sit against the key runs, and names the key-run eve trim only where the stress
 * budget applies it. "" when there is no lifting or no running to fit together.
 */
export function liftingLine(
  week: Pick<RaceBuildWeek, "kind" | "phase">,
  legMap: readonly LegMapDay[],
  lead: RaceStrengthLead = "endurance_led"
): string {
  const lifts = legMap.filter((d) => d.strength);
  const runs = legMap.filter((d) => d.run);
  if (!lifts.length || !runs.length) return "";
  // A strength-led athlete's upper body keeps taking its earned steps through the last
  // two weeks (race-strength.ts); only the legs are trimmed.
  const strengthLed = lead === "strength_led";
  if (week.kind === "race") {
    return strengthLed
      ? "Race week: heavy leg work sits out, calves and core stay light, and the upper-body days keep progressing."
      : "Race week: heavy leg work sits out, calves and core stay light, and the upper-body days carry on.";
  }
  if (week.kind === "taper") {
    return strengthLed
      ? "Taper week: leg work stays on the card with fewer sets at a lighter weight, and the upper-body days keep progressing."
      : "Taper week: leg work stays on the card with fewer sets at a lighter weight, and the upper-body days carry on as usual.";
  }
  const heavy = lifts.filter((d) => d.strength?.heavy_lower);
  // The long run first: it is the week's biggest leg demand.
  const keys = runs
    .filter((d) => d.run && d.run.kind !== "easy")
    .sort((a, b) => (a.run?.kind === "long" ? -1 : 0) - (b.run?.kind === "long" ? -1 : 0));
  const keyWords = (days: LegMapDay[]): string =>
    weekdayList(days.map((d) => `${d.weekday}'s ${RUN_WORD(d.run?.kind === "long" ? "long" : "quality")}`));
  if (!heavy.length) {
    return keys.length
      ? `No heavy leg day this week, so ${keyWords(keys)} ${keys.length > 1 ? "get" : "gets"} fresh legs while the lifting carries on.`
      : "";
  }
  const heavyDays = weekdayList(heavy.map((d) => d.weekday));
  if (!keys.length) return `Heavy legs on ${heavyDays}; every run this week is easy, so they sit alongside.`;
  // Rank what needs saying: a heavy lift on the SAME day as a key run first (the one
  // collision the athlete has to space out within a day), then the heaviest key run's
  // heavy eve. Both can hold in one week, so both can be said — at most two sentences.
  const runWord = (d: LegMapDay): string => RUN_WORD(d.run?.kind === "long" ? "long" : "quality");
  const clauses: string[] = [];
  const sameDay = keys.find((key) => heavy.some((d) => d.day_number === key.day_number));
  if (sameDay) {
    const lift = heavy.find((d) => d.day_number === sameDay.day_number);
    clauses.push(
      `${sameDay.weekday} carries both ${lift?.strength?.name} and the ${runWord(sameDay)}; give them as many hours apart as the day allows.`
    );
  }
  for (const key of keys) {
    if (key === sameDay) continue;
    const run = runWord(key);
    // The last lift day before the key run, at most two days back with no lift between
    // (the ring wraps: a Monday run's eve is the Sunday before it).
    const back = (n: number): LegMapDay | undefined =>
      legMap.find((d) => d.day_number === ((key.day_number - n + 6) % 7) + 1);
    const eve = back(1)?.strength ? back(1) : back(2)?.strength ? back(2) : undefined;
    if (!eve?.strength?.heavy_lower) continue;
    const gap = eve === back(1) ? "the day before" : "two days before";
    clauses.push(
      EVE_KINDS.has(week.kind) && EVE_PHASES.has(week.phase)
        ? `${eve.strength.name} on ${eve.weekday} is the last lift before ${key.weekday}'s ${run}: the main lift stands and the leg extras drop a set, so the legs arrive ready.`
        : `${eve.strength.name} on ${eve.weekday} lands ${gap} ${key.weekday}'s ${run}; both stay as written, so keep that run conversational.`
    );
    break;
  }
  if (clauses.length) return clauses.join(" ");
  return `Heavy legs on ${heavyDays} sit clear of ${keyWords(keys)}.`;
}

/**
 * The ladder from `asOf`'s week to race week, walked through raceRamp one Monday at a
 * time so every week is the engine's own next safe step off the week before it.
 *
 * `thisWeek` is the live engine's prescription for the current week, when there is
 * one. It is not decoration: raceRamp reads its anchor as the week BEFORE, so the
 * current rung has to BE the prescription and has to be what the next rung steps
 * off. Hand it in and the ladder walks from what the athlete is actually running;
 * leave it out and the walk projects the current week from the anchor like any other.
 *
 * `opts.priorWeekKm` is the closed week before this one, as logged — what a reset
 * this week paused at. `opts.demonstratedLongKm` is the longest recent run the
 * athlete took WELL (`demonstratedLongKm`): capacity already shown, which the long-run
 * ladder never plans back up to. Both mirror weeklyRunPlan: the week after a reset
 * steps off the level the reset paused, and a reset holds a well-taken long run.
 *
 * `opts.demonstratedWeekKm` is the best closed week of the capacity window run without
 * harm (`demonstratedRunCapacity().floor_km`): the ramp aims its peak one step past it
 * (`peakTargetKm`), and a projected build rung that follows a lighter one resumes toward
 * it inside the engine's own ACWR ceiling (`capacityResumeKm`) — weeklyRunPlan's rule,
 * so the ladder never re-climbs ground already covered. `opts.bestWeekKm` is the biggest
 * closed week on record, which a rung has to pass to be a new weekly high. With
 * `opts.currentWeekHarmed` next week's rung does not resume: the engine will not resume
 * through a week that carried harm, so neither does the ladder.
 */
export function projectRaceBuildWeeks(
  goal: RaceRampGoal & { date: string; distance_km: number },
  asOf: string,
  anchorKm: number,
  anchorLongKm: number,
  thisWeek?: { km: number; long_km: number | null } | null,
  nextWeek?: { km: number; long_km: number | null } | null,
  opts?: {
    priorWeekKm?: number | null;
    demonstratedLongKm?: number | null;
    capacity?: RaceRampCapacity | null;
    closedWeeksKm?: readonly number[] | null;
    demonstratedWeekKm?: number | null;
    bestWeekKm?: number | null;
    /** This week's running already carries harm evidence: next week does not resume through it. */
    currentWeekHarmed?: boolean;
    /** Whose goals the lifting serves (race-strength.ts); endurance-led when absent. */
    strengthLead?: RaceStrengthLead;
  }
): RaceBuildWeek[] {
  const out: RaceBuildWeek[] = [];
  const raceMonday = mondayOf(goal.date);
  const currentMonday = mondayOf(asOf);
  const nextMonday = addDaysISO(currentMonday, 7);
  const demonstrated = Number(opts?.demonstratedLongKm) > 0 ? Number(opts?.demonstratedLongKm) : 0;
  const capacity = opts?.capacity ?? null;
  // The longest mid-week run the walk has on record — the engine's read to start, then
  // grown by every projected week's own easy and quality runs, as running them would.
  let shownMidweek = Number(capacity?.demonstratedMidweekKm) > 0 ? Number(capacity?.demonstratedMidweekKm) : 0;
  // Every closed week before the walked rung, most recent last: the logged weeks
  // before this one, then each rung as the walk lays it down.
  const history: number[] = [...(opts?.closedWeeksKm ?? [])];
  let monday = currentMonday;
  let anchor = anchorKm > 0 ? anchorKm : 6;
  let long = Math.max(anchorLongKm > 0 ? anchorLongKm : Math.max(3, anchor * 0.3), demonstrated);
  // The volume of the rung BEFORE the one being walked — for the current rung that is
  // last week's logged volume, which the walk's own anchor (this week's prescription)
  // is not.
  let prevRungKm = Number(opts?.priorWeekKm) > 0 ? Number(opts?.priorWeekKm) : 0;
  const shown = {
    week_km: Number(opts?.demonstratedWeekKm) > 0 ? Number(opts?.demonstratedWeekKm) : null,
    long_km: demonstrated || null,
  };
  let guard = 0;
  while (monday <= raceMonday && guard++ < 60) {
    let r = raceRamp(goal, monday, anchor, long, null, shown);
    if (!r) break;
    const isLive =
      (monday === currentMonday && !!thisWeek && thisWeek.km > 0) ||
      (monday === nextMonday && !!nextWeek && nextWeek.km > 0);
    // A projected rung before the taper that follows a lighter one resumes toward the
    // demonstrated floor, inside the ACWR ceiling of the weeks before it — the same
    // rule weeklyRunPlan anchors a real week with (capacityResumeKm).
    const afterHarm = monday === nextMonday && opts?.currentWeekHarmed === true;
    if (!isLive && !afterHarm && r.weeks_to_race_week >= 2) {
      const resumed = capacityResumeKm(anchor, shown.week_km, history, ENDURANCE_CHRONIC_FLOOR_KM);
      if (resumed > anchor) {
        anchor = resumed;
        r = raceRamp(goal, monday, anchor, long, null, shown) ?? r;
      }
    }
    // The ladder is read by CALENDAR week: the week that holds race day is race week,
    // whatever weekday the start line falls on — and so is the engine's taper now
    // (`weeks_to_race_week`), so the label and the prescription are one count.
    const w = r.weeks_to_race_week;
    const phase = phaseForWeeks(r.weeks_to_race, goal.distance_km);
    // The KIND follows the engine's arrival shape: race week, the final taper week
    // before it, the peak week before that — so a weekend half peaks ~3 weeks before
    // race day and TAPERS the week before race week, instead of peaking into it.
    const kind: RaceWeekKind =
      w <= 0 ? "race" : w === 1 ? "taper" : w === 2 ? "peak" : r.down_week ? "down" : "build";
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
    // A projected reset HOLDS the long run where the walk has it (at or above what was
    // already run well) — it neither steps under it nor past it; the week comes out of
    // the easy days. raceRamp's long-run curve has no down weeks of its own.
    let longKm = live
      ? (live.long_km ?? r.required_long_km)
      : kind === "down"
        ? round1(Math.min(r.required_long_km, long))
        : r.required_long_km;
    // A projected rung is what the engine will PRESCRIBE, not the volume it is asked
    // for: in the athlete's own run week (`capacity`, the engine's fixed run count)
    // each run keeps its cap, and what the caps cannot carry is not on the card
    // (deliverableRunWeek — the same arithmetic the engine distributes with). The
    // next rung steps off what this one really holds, as the engine will.
    let km = live ? live.km : r.required_km;
    // And never a step the engine's own ACWR ceiling would trim (acwrCeilingKm, over
    // the four weeks before this rung — logged, then the rungs themselves): never below
    // the level the rung steps off, exactly as weeklyRunPlan applies it.
    const acwrCeiling = live ? null : acwrCeilingKm(history, ENDURANCE_CHRONIC_FLOOR_KM);
    if (acwrCeiling != null) km = round1(Math.min(km, Math.max(anchor, acwrCeiling)));
    if (!live && capacity) {
      const carried = deliverableRunWeek(km, longKm, capacity.shape, shownMidweek || null);
      km = Math.min(km, carried.km);
      longKm = carried.long_km;
      shownMidweek = Math.max(shownMidweek, carried.easy_km, carried.quality_km);
    }
    out.push({
      week_start: monday,
      weeks_to_race: w,
      phase,
      kind,
      km,
      long_km: longKm,
      quality_hint: kind === "race" ? QUALITY_HINT.race_week : kind === "down" ? QUALITY_HINT.down : QUALITY_HINT[phase],
      strength_hint: raceStrengthPrinciple({ phase, kind, lead: opts?.strengthLead ?? "endurance_led" }).principle,
      focus: weekFocus(kind, phase),
      focus_short: weekFocusShort(kind, phase),
      new_high: false,
      // Filled by raceBuild once the week's ring is read; the pure walk has no ring.
      with_lifting: "",
      current: monday === currentMonday,
    });
    history.push(km);
    // The next rung steps off this one — except after a reset actually run as a
    // lighter week, where it steps off the level the reset paused (weeklyRunPlan's
    // RESET_TAKEN_FRACTION rule), and never plans the long run back UP to what has
    // already been run well.
    const resumes = kind === "down" && prevRungKm > km && km >= prevRungKm * RESET_TAKEN_FRACTION;
    anchor = resumes ? prevRungKm : km;
    long = kind === "race" || kind === "taper" ? longKm : Math.max(longKm, demonstrated, kind === "down" ? long : 0);
    prevRungKm = km;
    const next = addDaysISO(monday, 7);
    if (!next) break;
    monday = next;
  }
  markNewHighs(out, opts?.bestWeekKm);
  return out;
}

const NEW_HIGH_PEAK_FOCUS =
  "A new weekly high: the biggest week you have run, with the long run at its top, so the other runs stay truly easy.";
const NEW_HIGH_SHORT = "A new weekly high";
// Said as ABOUT the biggest week, never "holds it rather than passing it": the band is
// either side, so a peak up to 5% past the week is inside it too.
const HOLDS_HIGH_PEAK_FOCUS =
  "About your biggest week rather than a new high: the long run tops out, so the other runs stay truly easy.";
const HOLDS_HIGH_SHORT = "About your biggest week";
/**
 * A peak within this share of the biggest week already run (either side) is said as
 * about that week: a rung 0.5 km past a 35.8 km week is not a new milestone worth claiming.
 */
export const PEAK_HOLDS_HIGH_SHARE = 0.05;

/** A rung's words once it is a new weekly high. Idempotent; a taper or race week never is one. */
export function newHighWords(week: RaceBuildWeek): void {
  if (week.holds_high && week.kind === "peak") {
    week.focus = HOLDS_HIGH_PEAK_FOCUS;
    week.focus_short = HOLDS_HIGH_SHORT;
    return;
  }
  if (!week.new_high) return;
  if (week.kind === "peak") {
    week.focus = NEW_HIGH_PEAK_FOCUS;
    week.focus_short = NEW_HIGH_SHORT;
  } else if (week.focus && !week.focus.startsWith(NEW_HIGH_SHORT)) {
    week.focus = `${NEW_HIGH_SHORT} — ${week.focus[0].toLowerCase()}${week.focus.slice(1)}`;
  }
}

/**
 * Mark the rungs that would be the biggest week on record: above `bestWeekKm` and
 * above every rung before them. Only a building rung (a build or the peak) can be one;
 * a reset, the taper and race week are lighter by design.
 */
export function markNewHighs(weeks: RaceBuildWeek[], bestWeekKm: number | null | undefined): void {
  let high = Number(bestWeekKm) > 0 ? Number(bestWeekKm) : 0;
  if (!(high > 0)) return;
  for (const week of weeks) {
    if (week.kind !== "build" && week.kind !== "peak") continue;
    // The peak near the biggest week already run — a closed current week included — is
    // said as about that week, never as a new milestone by half a km.
    if (week.kind === "peak" && Math.abs(week.km - high) <= high * PEAK_HOLDS_HIGH_SHARE) {
      week.new_high = false;
      week.holds_high = true;
      newHighWords(week);
      continue;
    }
    if (week.km > high + 0.05) {
      week.new_high = true;
      high = week.km;
      newHighWords(week);
    }
  }
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

function watchPrediction(asOf: string, distanceKm: number, units: DistanceUnit = "km"): RacePrediction | null {
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
    basis_detail: `your watch's ${nearest.km >= 42 ? "marathon" : nearest.km >= 21 ? "half-marathon" : `${nearest.km}k`} prediction, adjusted to ${distanceWords(distanceKm, units)}`,
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
        `SELECT date, type, source, external_id, raw_text, notes, distance_km, duration_min FROM activities
          WHERE date <= ? AND date >= ? ORDER BY date DESC`
      )
      .all(asOf, isoDaysAgo(asOf, days)) as any[];
    // A hand-typed shadow of a synced run carries a rounded duration — never let it
    // stand in for the watch's own numbers in the prediction.
    rows = withoutShadowActivities(rows);
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

function runPrediction(distanceKm: number, runs: RunRow[], asOf: string, units: DistanceUnit = "km"): RacePrediction | null {
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
    basis_detail: `your ${distanceWords(best.km, units)} run on ${dateWords(best.date, asOf)} (${paceWords((best.min * 60) / best.km, units, { spaced: true })}), extended to race distance — a training run, so this reads conservative`,
    as_of: best.date,
    trend: null,
    gap_sec: null,
    fit: null,
  };
}

// The longest run of the last 28 days taken well lives with the rest of what the running
// has demonstrated (run-capacity.ts); re-exported here for the callers that read it off
// the race build.
export { demonstratedLongKm };

/**
 * The four most recent CLOSED Mon–Sun weeks. With `includeThisWeek` (the current week
 * closed early — `currentWeekClosedEarly`) the window ends with this week, run through
 * `asOf`; otherwise it ends with last week and this week is never in it.
 */
function weeklyReview(asOf: string, runs: RunRow[], includeThisWeek = false): RaceBuild["review"] {
  const thisMonday = mondayOf(asOf);
  const lastMonday = includeThisWeek ? thisMonday : (addDaysISO(thisMonday, -7) ?? thisMonday);
  const byWeek = new Map<string, { km: number; runs: number }>();
  for (const r of runs) {
    const wk = mondayOf(r.date);
    if (wk > lastMonday || r.date > asOf) continue; // closed weeks only
    const cur = byWeek.get(wk) ?? { km: 0, runs: 0 };
    cur.km += r.km;
    cur.runs += 1;
    byWeek.set(wk, cur);
  }
  const weeks: RaceBuild["review"]["weeks"] = [];
  for (let i = 3; i >= 0; i--) {
    const wk = addDaysISO(lastMonday, -7 * i);
    if (!wk) continue;
    const cur = byWeek.get(wk) ?? { km: 0, runs: 0 };
    weeks.push({ week_start: wk, km: round1(cur.km), runs: cur.runs });
  }
  const longest = runs.filter((r) => (daysBetweenISO(asOf, r.date) ?? 99) <= 28).reduce((m, r) => Math.max(m, r.km), 0);
  const first = weeks.slice(0, 2).reduce((s, w) => s + w.km, 0) / 2;
  const last = weeks.slice(2).reduce((s, w) => s + w.km, 0) / 2;
  const volume_word: RaceBuild["review"]["volume_word"] =
    first <= 0 && last <= 0 ? null : last >= first * 1.1 ? "rising" : last <= first * 0.9 ? "easing" : "steady";
  return {
    weeks,
    longest_recent_km: longest > 0 ? round1(longest) : null,
    volume_word,
    ...(includeThisWeek ? { includes_this_week: true } : {}),
  };
}

// The week's recurring cross-training day — the one read (cross-training-day.ts): the
// optional day the athlete named, else a non-run, non-light family on the same weekday in
// two of the last six weeks. Only efforts that load the legs make a pattern worth
// placing runs around (a light e-bike commute never wins the weekday). The field keeps
// its `ride` name for the client; `sport_family` says what it is.
function ridePattern(asOf: string): Omit<RidePattern, "placement"> | null {
  const day = (safe(() => crossTrainingDays(asOf)) ?? [])[0];
  if (!day) return null;
  return {
    label: day.label,
    day_number: day.day_number,
    weekday: day.weekday,
    weeks_seen: day.weeks_seen ?? 0,
    weeks_window: day.weeks_window,
    typical_min: day.typical_min,
    // A stated day the log has not shown yet is planned around as an ordinary one.
    typical_load: day.typical_load ?? "moderate",
    source: day.source,
    sport_family: day.sport_family,
  };
}

const RIDE_BEFORE_LONG_VARIANTS = [
  "Your {label} sits the day before the long run — the week you keep. It stays in the legs, so the long run goes conversational; keep the {noun} easy if you want the legs fresher.",
  "The {label} lands the day before the long run. That is your pattern, not a conflict: the legs carry it into the long run, so run that one conversational.",
  "{weekday}'s {label} comes the day before the long run. Keep the long run conversational the morning after — the {noun} is still in the legs — or keep the {noun} easy.",
] as const;
const OPTIONAL_RIDE_BEFORE_LONG_VARIANTS = [
  "The optional {label} you named sits the day before the long run. When you take it, the legs carry it into the long run — keep that run conversational.",
  "Your optional {weekday} {label} comes the day before the long run: on the weeks you take the {noun}, the legs carry it and the long run goes conversational the morning after.",
  "The {label} you keep optional on {weekday} is the day before the long run. Take the {noun} easy or run the long one conversational — it stays in the legs either way.",
] as const;
// Upper-body and unnamed sessions sit the day before the long run without a claim
// on the legs. The phrase the long-run placement is known by stays in every line.
const CROSS_BEFORE_LONG_VARIANTS = [
  "Your {label} sits the day before the long run — the week you keep.",
  "The {label} lands the day before the long run. That is your pattern, not a conflict, and the long run stays as planned.",
  "{weekday}'s {label} comes the day before the long run. The long run keeps its place the morning after.",
] as const;
const OPTIONAL_CROSS_BEFORE_LONG_VARIANTS = [
  "The optional {label} you named sits the day before the long run — the week you keep.",
  "Your optional {weekday} {label} comes the day before the long run: on the weeks you take the {noun}, the long run stays as planned.",
  "The {label} you keep optional on {weekday} is the day before the long run.",
] as const;

function fillRide(template: string, ride: { label: string; weekday: string; sport_family: string }): string {
  const noun = crossTrainingNoun(ride.sport_family);
  return template.replaceAll("{label}", ride.label).replaceAll("{weekday}", ride.weekday).replaceAll("{noun}", noun);
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
  const noun = crossTrainingNoun(ride.sport_family);
  const d = ride.day_number;
  if (longDay != null && d === longDay) {
    return `Your ${ride.label} usually lands on the long-run day (${ride.weekday}). One or the other — if it has to be both, the ${noun} goes easy and short.`;
  }
  if (longDay != null && nextDay(d) === longDay) {
    const legs = crossTrainingLoadsLegs(ride.sport_family);
    const variants = legs
      ? ride.source === "stated"
        ? OPTIONAL_RIDE_BEFORE_LONG_VARIANTS
        : RIDE_BEFORE_LONG_VARIANTS
      : ride.source === "stated"
        ? OPTIONAL_CROSS_BEFORE_LONG_VARIANTS
        : CROSS_BEFORE_LONG_VARIANTS;
    return fillRide(
      pickDayVariant(variants, date, legs ? "race-build:ride-before-long" : "race-build:cross-before-long"),
      ride
    );
  }
  if (qualityDay != null && nextDay(d) === qualityDay) {
    return `Your ${ride.label} sits the day before the quality run. Keep the ${noun} easy — the hard effort is tomorrow.`;
  }
  if (heavyLower.has(d)) {
    const clear = [...easyDays].filter((e) => e !== longDay && e !== qualityDay && !heavyLower.has(e) && nextDay(e) !== longDay);
    const move = clear.length ? ` — or move the ${noun} to ${weekdayOfDayNumber(clear[0])}, an easy-run day` : "";
    return `The ${noun} and heavy legs share ${ride.weekday}. Lift first if both happen, and let the ${noun} be the easy half${move}.`;
  }
  if (longDay != null && prevDay(d) === longDay) {
    return `Your ${ride.label} follows the long run (${weekdayOfDayNumber(longDay)} then ${ride.weekday}). That is a loaded weekend — keep the ${noun} easy, not a second hard day.`;
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

// {km} and {long} arrive already said in the athlete's run units ("31 km", "8.1 mi").
const WHY_VARIANTS = [
  "{weeks} weeks to {event}: this week is {km} with a {long} long run. {estimate}",
  "{event} is {weeks} weeks out. The week asks for {km}, long run {long}. {estimate}",
  "Building toward {event}, {weeks} weeks away — {km} this week, {long} long. {estimate}",
] as const;

function estimateSentence(p: RacePrediction | null, t: RaceTarget | null, units: DistanceUnit = "km"): string {
  const pace = (sec: number) => paceWords(sec, units, { spaced: true });
  if (!p) return t ? `Target ${fmtClock(t.sec)} (${pace(t.pace_sec_per_km)}).` : "";
  const est = `Current shape reads about ${fmtClock(p.estimate_sec)} (${pace(p.estimate_pace_sec_per_km)})`;
  const trend = p.trend ? `, ${p.trend.word === "steady" ? "holding steady" : `${Math.abs(Math.round(p.trend.delta_sec / 60))} min ${p.trend.word}`} over the last month` : "";
  if (!t) return `${est}${trend}.`;
  const gap = p.gap_sec ?? 0;
  const vs =
    p.fit === "fits"
      ? `— inside the ${fmtClock(t.sec)} target`
      : p.fit === "stretch"
        ? `— ${fmtClock(Math.abs(gap))} off the ${fmtClock(t.sec)} target, a stretch the build can close`
        : `— ${fmtClock(Math.abs(gap))} off the ${fmtClock(t.sec)} target; the paces train from today's shape, and the target stays the reach`;
  return `${est}${trend} ${vs}.`;
}

/**
 * Running without a dated race to build to: stated run days, an endurance goal that is
 * not an upcoming race, or a run in the last six weeks. None of those is a lifting-only
 * athlete, who gets no run or race surface at all.
 */
function runningWithoutRace(asOf: string, goal: ReturnType<typeof getEnduranceGoal>): "runs" | "none" {
  if (goal) return "runs";
  if ((safe(() => statedRunDows()) ?? []).length) return "runs";
  return recentRuns(asOf, 42).length ? "runs" : "none";
}

/** What `thisWeekRead` needs beyond the plan: the agenda's week as run, and its closure. */
interface ThisWeekContext {
  agenda: FlexibleTrainingAgenda | null;
  /** The athlete's run units: the week's sentences say their distances in them. */
  units?: DistanceUnit;
  closed: CurrentWeekClosed;
  /** The biggest closed week BEFORE this one (a new high is said against it). */
  bestBeforeKm: number | null;
  adapt: RaceLadderAdapt | null;
}

/** This week's running as planned, what the log already holds of it, and the week as run. */
function thisWeekRead(
  plan: WeeklyRunPlan | null,
  asOf: string,
  logRuns: RunRow[],
  qualityPace: PaceBand | null,
  ctx: ThisWeekContext
): RaceBuild["this_week"] {
  if (!plan?.available) return null;
  const runs = weekAsPlanned(plan);
  const km = round1(runs.reduce((s, r) => s + (r.target_distance_km != null ? Number(r.target_distance_km) : 0), 0));
  const longRun = runs.find((r) => r.kind_label === "long") ?? null;
  const qualityRun = runs.find((r) => r.kind_label === "quality") ?? null;
  const monday = mondayOf(asOf);
  const logged = round1(logRuns.filter((r) => r.date >= monday && r.date <= asOf).reduce((s, r) => s + r.km, 0));
  const units = ctx.units ?? "km";
  const weekRuns = raceWeekRuns(ctx.agenda, units);
  const recap = weekRecap(
    {
      logged_km: logged,
      planned_km: km > 0 ? km : null,
      runs: weekRuns,
      closed: ctx.closed.closed,
      long_done: !!ctx.agenda?.intents?.some((i) => i.kind === "long" && i.status === "completed"),
      long_planned: !!longRun,
      best_before_km: ctx.bestBeforeKm,
      harmed: !!ctx.adapt?.harmed,
    },
    asOf,
    units
  );
  return {
    week_start: plan.week_start,
    km,
    long_km: longRun?.target_distance_km != null ? Number(longRun.target_distance_km) : null,
    logged_km: logged,
    quality: qualityRun ? { label: qualityRun.label || plan.quality_focus || "Quality run", pace: qualityPace } : null,
    why: (units === "mi" ? plan.why_mi : null) || plan.why,
    closed: ctx.closed.closed,
    closed_reason: ctx.closed.reason,
    runs: weekRuns,
    headline: recap?.headline ?? null,
    detail: recap?.detail ?? null,
  };
}

const RUN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** What this morning made of the run a slot planned, in words (km); null when nothing. */
function adjustmentWords(intent: FlexibleRunIntent, units: DistanceUnit = "km"): string | null {
  const adj = intent.adjustment;
  if (!adj?.changed) return null;
  if (adj.dose === "rest") return "turned to a rest day this morning";
  if (adj.dose === "shortened" && adj.target_distance_km != null)
    return `shortened to ${kmText(adj.target_distance_km, units)} this morning`;
  if (adj.kind === "easy" && adj.planned_kind !== "easy") return "eased to an easy run this morning";
  if (adj.kind === "quality" && adj.planned_kind !== "quality") return "opened to a quality run this morning";
  return null;
}

/** "13.5 km · 6:11/km · easy" — the run as run, in km. */
export function actualRunLine(
  run: Pick<RunCompletionEvidence, "distance_km" | "duration_min" | "pace_sec_per_km" | "intensity_word">,
  units: DistanceUnit = "km"
): string {
  const bits: string[] = [];
  if (run.distance_km != null) bits.push(kmText(run.distance_km, units));
  else if (run.duration_min != null) bits.push(`${Math.round(run.duration_min)} min`);
  if (run.pace_sec_per_km != null && run.pace_sec_per_km > 0) bits.push(paceWords(run.pace_sec_per_km, units));
  bits.push(run.intensity_word);
  return bits.join(" · ");
}

const EXTRA_RUN_LINE = "An extra run, beyond the week's plan.";

/**
 * Every run logged this week from the agenda — the runs that answered a planned slot and
 * the extras that answered none — in date order, actual first.
 */
export function raceWeekRuns(agenda: FlexibleTrainingAgenda | null | undefined, units: DistanceUnit = "km"): RaceWeekRun[] {
  if (!agenda?.available) return [];
  const out: RaceWeekRun[] = [];
  const toRun = (c: RunCompletionEvidence, intent: FlexibleRunIntent | null): RaceWeekRun => {
    const word: RunEffortWord = c.intensity_word ?? (c.intensity === "quality" ? "hard" : "easy");
    const plannedKind = (intent?.adjustment?.changed ? intent.adjustment.planned_kind : null) ?? intent?.kind ?? null;
    return {
      activity_id: c.activity_id,
      date: c.date,
      weekday: RUN_WEEKDAYS[isoDow(c.date)] ?? c.date,
      title: c.title ?? null,
      km: c.distance_km != null ? round1(c.distance_km) : null,
      duration_min: c.duration_min,
      pace_sec_per_km: c.pace_sec_per_km ?? null,
      avg_hr: c.avg_hr ?? null,
      intensity: word === "hard" ? "quality" : word,
      intensity_word: word,
      stated_easy: c.intensity_basis === "stated_easy",
      kind: intent?.kind ?? null,
      intent_id: intent?.id ?? null,
      extra: !intent,
      planned:
        intent && plannedKind
          ? {
              kind: plannedKind,
              label: String(intent.planned_label || intent.label).replace(/\s*·\s*shorter$/i, ""),
              km: intent.planned_distance_km ?? null,
            }
          : null,
      adjustment: intent ? adjustmentWords(intent, units) : null,
      actual_line: actualRunLine({ ...c, intensity_word: word }, units),
      plan_line: intent ? plannedRunLine(intent, units) : EXTRA_RUN_LINE,
    };
  };
  for (const intent of agenda.intents ?? []) {
    if (intent.status === "completed" && intent.completion) out.push(toRun(intent.completion, intent));
  }
  for (const extra of agenda.extras ?? []) out.push(toRun(extra, null));
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.activity_id - b.activity_id);
}

// ---------- the week's recap (headline + one detail line) ----------
//
// Written here, never in a renderer, and held to the reading grammar: no score, no
// grade, no gate. A variant set per state, so a stable week does not print one literal
// every morning (pickDayVariant).
const RECAP_HEADLINES = {
  biggest: ["Your biggest week yet.", "More running than any week before it.", "A new high for your running."],
  // A new high that carried harm: said as a big week that asked a lot, never celebrated
  // beside a capacity read that sets the same week aside.
  asked: ["A big week, and it asked a lot.", "More running than before — and the body felt it.", "A big week the body is still answering."],
  done: ["The week's work is in.", "That's the week, done.", "The week is in."],
  lighter: ["A lighter week, and that's fine.", "A lighter week — the build carries on from here.", "A quieter week, and the build holds."],
  underway: ["The week is under way.", "The week is taking shape.", "Running so far this week."],
} as const;

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

export interface WeekRecapInput {
  logged_km: number;
  planned_km: number | null;
  runs: Pick<RaceWeekRun, "intensity_word">[];
  closed: boolean;
  long_done: boolean;
  long_planned: boolean;
  /** The biggest closed week before this one, km (null when unknown). */
  best_before_km: number | null;
  /** The week's running carried harm evidence (closedWeekRunHarm). */
  harmed?: boolean;
}

/** The week in two lines (see above). Null with no run logged. */
export function weekRecap(
  input: WeekRecapInput,
  date: string,
  units: DistanceUnit = "km"
): { headline: string; detail: string } | null {
  const kmText = (km: number) => distanceWords(km, units);
  const n = input.runs.length;
  if (!n || !(input.logged_km > 0)) return null;
  const planned = input.planned_km != null && input.planned_km > 0 ? input.planned_km : null;
  const newHigh = input.best_before_km != null && input.best_before_km > 0 && input.logged_km > input.best_before_km + 0.05;
  const lighter = input.closed && planned != null && input.logged_km < planned * 0.9;
  const state: keyof typeof RECAP_HEADLINES = newHigh
    ? input.harmed
      ? "asked"
      : "biggest"
    : input.closed
      ? lighter
        ? "lighter"
        : "done"
      : "underway";
  const headline = pickDayVariant(RECAP_HEADLINES[state], date, `race-build:recap:${state}`);

  const vsPlan =
    planned == null
      ? ""
      : input.logged_km >= planned * 1.25
        ? `, well past the ${kmText(planned)} planned`
        : input.logged_km > planned * 1.05
          ? `, a little past the ${kmText(planned)} planned`
          : input.logged_km >= planned * 0.95
            ? `, right about the ${kmText(planned)} planned`
            : input.closed
              ? ` of the ${kmText(planned)} planned`
              : ` so far of the ${kmText(planned)} planned`;
  const hard = input.runs.filter((r) => r.intensity_word === "hard").length;
  const steady = input.runs.filter((r) => r.intensity_word === "steady").length;
  const easy = n - hard - steady;
  const mix =
    n >= 2 && hard === n
      ? "every run on the hard side"
      : hard === 0 && steady === 0
        ? n === 1
          ? "an easy run"
          : "all of it easy"
        : [easy ? `${countWord(easy)} easy` : "", steady ? `${countWord(steady)} steady` : "", hard ? `${countWord(hard)} hard` : ""]
            .filter(Boolean)
            .join(", ")
            .replace(/, ([^,]*)$/, " and $1");
  const long = input.long_done ? ", with the long run in" : input.closed && input.long_planned ? ", with no long run this time" : "";
  const runsWord = `${countWord(n)} run${n === 1 ? "" : "s"}`;
  const lead = pickDayVariant(
    [
      `${kmText(input.logged_km)} over ${runsWord}${vsPlan}: ${mix}${long}.`,
      `${capFirst(runsWord)} for ${kmText(input.logged_km)}${vsPlan} — ${mix}${long}.`,
    ],
    date,
    "race-build:recap:detail"
  );
  // What the ladder does next is the ladder's own sentence (`adapted`), never repeated here.
  const forward = n >= 2 && hard === n ? " Next week the easy days stay easy." : "";
  return { headline, detail: `${lead}${forward}` };
}

export function raceBuild(
  date?: string,
  opts?: {
    runPlan?: WeeklyRunPlan | null;
    weekLayout?: WeekLayoutRead | null;
    /**
     * With no dated race, still read the running week (the engine's plan and the
     * closed weeks from the log) for an athlete who runs, so the surface that asked can
     * show the week without a build. Off for the internal callers, which only ever
     * want the build.
     */
    describeRunning?: boolean;
    /** The rolling agenda the caller already holds (read here off the live week otherwise). */
    agenda?: FlexibleTrainingAgenda | null;
    /** The units the sentences speak (default: the athlete's, athleteUnits()). */
    units?: DistanceUnit;
  }
): RaceBuild {
  const asOf = date || localDateISO();
  const units: DistanceUnit = opts?.units ?? athleteUnits().distance;
  const goal = getEnduranceGoal(asOf);
  // The week as RUN: the agenda grades and matches every logged run (extras included),
  // off the live week with this morning's call on it, so a completed slot can say what
  // the morning made of it.
  const readAgenda = (): FlexibleTrainingAgenda | null =>
    opts?.agenda !== undefined
      ? opts.agenda
      : safe(() => (opts?.runPlan === undefined ? flexibleTrainingAgenda(asOf) : flexibleTrainingAgenda(asOf, { runPlan: opts.runPlan })));
  const empty = (reason: string): RaceBuild => {
    // Only a surface that asked pays for the read of whether the athlete runs at all.
    const running = opts?.describeRunning ? runningWithoutRace(asOf, goal) : null;
    const out: RaceBuild = {
      available: false,
      as_of: asOf,
      units,
      running,
      race: null,
      prediction: null,
      paces: null,
      this_week: null,
      weeks: [],
      leg_map: [],
      strength: null,
      ride: null,
      capacity: null,
      review: { weeks: [], longest_recent_km: null, volume_word: null },
      adapted: "",
      why: "",
      reason,
    };
    if (running !== "runs") return out;
    const logRuns = recentRuns(asOf, 42);
    const plan = opts?.runPlan === undefined ? safe(() => weeklyRunPlan(asOf, { adjustToday: false })) : opts.runPlan;
    const agenda = plan?.available ? readAgenda() : null;
    const closed = safe(() => currentWeekClosedEarly(asOf, { agenda })) ?? NOT_CLOSED;
    return {
      ...out,
      this_week: thisWeekRead(plan, asOf, logRuns, null, { agenda, closed, bestBeforeKm: null, adapt: null, units }),
      review: weeklyReview(asOf, logRuns, closed.closed),
    };
  };

  if (!goal || !goal.is_race || !goal.date) return empty("No dated race yet. Set one and the build lays out week by week.");
  const distance = Number(goal.distance_km);
  if (!(distance > 0)) return empty("The race has no distance yet — add it and the build can be laid out.");
  if (goal.phase === "past" || (goal.days_to_race ?? 0) < 0) return empty("The race is behind you. A new date starts a new build.");
  const weeksToRace = Math.max(0, goal.weeks_to_race ?? 0);
  const phase: RacePhase = goal.phase ?? phaseForWeeks(weeksToRace, distance);

  // ---- this week, from the live engine ----
  // The WEEK as planned — never this morning's call on today's run (a shortened long run
  // or a rest morning must not move the week's volume, its long run or the banked test).
  const plan = opts?.runPlan === undefined ? safe(() => weeklyRunPlan(asOf, { adjustToday: false })) : opts.runPlan;
  const runs = plan?.available ? weekAsPlanned(plan) : [];
  const weekKm = round1(runs.reduce((s, r) => s + (r.target_distance_km != null ? Number(r.target_distance_km) : 0), 0));
  const longRun = runs.find((r) => r.kind_label === "long") ?? null;
  const qualityRun = runs.find((r) => r.kind_label === "quality") ?? null;
  const longKm = longRun?.target_distance_km != null ? Number(longRun.target_distance_km) : null;

  // ---- prediction + target ----
  const logRuns = recentRuns(asOf, 42);
  const target = parseRaceTarget(goal.target, distance);
  const stretchTarget = parseRaceStretch(goal.target, distance);
  let prediction = watchPrediction(asOf, distance, units) ?? runPrediction(distance, logRuns, asOf, units);
  if (prediction && target) {
    prediction = { ...prediction, gap_sec: prediction.estimate_sec - target.sec, fit: raceFit(prediction.estimate_sec, target.sec) };
  }
  // Training paces are anchored on CURRENT fitness, with the target as a ceiling: a
  // threshold band built off a goal the body cannot yet hold asks for efforts faster
  // than today's 10K, and every quality session turns into a race. So the bands come
  // off the slower of estimate and target (a faster estimate never speeds training
  // past the goal), and only the race band keeps the target — the race-pace touch.
  const racePace = target?.pace_sec_per_km ?? prediction?.estimate_pace_sec_per_km ?? null;
  const estimatePace = prediction?.estimate_pace_sec_per_km ?? null;
  const trainingPace = racePace != null && estimatePace != null ? Math.max(racePace, estimatePace) : racePace;
  const hrCeiling = trainingPace != null ? easyCeilingBpm(asOf) : null;
  const paces =
    racePace != null && trainingPace != null
      ? {
          anchored_on: (target && trainingPace === target.pace_sec_per_km ? "target" : "estimate") as "target" | "estimate",
          race_pace_sec_per_km: Math.round(racePace),
          bands: [
            ...paceBandsFor(racePace, distance, units).filter((b) => b.key === "race"),
            ...paceBandsFor(trainingPace, distance, units)
              .filter((b) => b.key !== "race")
              .map((b) => (b.key === "easy" || b.key === "long" ? { ...b, hr_ceiling_bpm: hrCeiling } : b)),
          ],
        }
      : null;
  const qualityKey = paceKeyForQuality(qualityRun?.label ?? plan?.quality_focus);
  const qualityPace = paces && qualityKey ? paces.bands.find((b) => b.key === qualityKey) ?? null : null;

  // ---- the ladder ----
  // Whose goals the lifting serves, read once: every rung's strength words and the
  // build's principle speak from it (race-strength.ts).
  const strengthLead: RaceStrengthLead = safe(() => raceStrengthLead(getTrainingIntent())) ?? "endurance_led";
  // ---- the week as run, and whether it is already closed ----
  const agenda = plan?.available ? readAgenda() : null;
  const closedRead = safe(() => currentWeekClosedEarly(asOf, { agenda })) ?? NOT_CLOSED;
  const thisMonday = mondayOf(asOf);
  const closedWeek = closedWeekAsRun(asOf, logRuns, closedRead);
  const { weeks, review, shownCapacity, adapt } = raceLadderFor(
    { ...goal, date: goal.date, distance_km: distance },
    asOf,
    plan,
    logRuns,
    { strengthLead, closed: closedWeek }
  );
  // The biggest week before this one — what a new high this week is said against.
  const bestBeforeKm = closedWeek
    ? (safe(() => demonstratedRunCapacity(addDaysISO(thisMonday, -1) ?? asOf).best_week_km) ?? null)
    : (shownCapacity?.best_week_km ?? null);

  // ---- the ring: runs, strength, ride ----
  // Runs are the engine's week (never plan rows); strength is the lifting week laid onto
  // its weekdays. `heavyLower` is therefore WEEKDAY slots (Mon = 1), the same axis the
  // runs and the ride sit on — never a plan day number.
  const heavyLower = safe(() => heavyLowerWeekdaySlots(asOf)) ?? new Set<number>();
  const strengthDays = new Map<number, { name: string; heavy_lower: boolean }>();
  for (const g of safe(() => planDayStrengthGroups()) ?? []) {
    if (!g.groups.length) continue;
    strengthDays.set(g.day_number, { name: planDayName(g.day_number) ?? g.focus ?? "Strength", heavy_lower: g.heavy_lower });
  }
  const rideBase = ridePattern(asOf);
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
  // This week's focus speaks to the week the engine actually prescribed: a build week
  // whose runs are all easy (no quality run on the card) is an aerobic week, and says
  // so, rather than asking for the phase's threshold session the week does not hold.
  // And a week that holds one names the session it holds, not the phase's usual one.
  const currentRung = weeks.find((w) => w.current);
  if (currentRung && plan?.available && runs.length) {
    if (!qualityRun && (currentRung.kind === "build" || currentRung.kind === "peak")) {
      currentRung.focus = AEROBIC_WEEK_FOCUS;
      currentRung.focus_short = AEROBIC_WEEK_FOCUS_SHORT;
    } else if (qualityRun) {
      const named = qualityWeekFocus(currentRung.kind, currentRung.phase, qualityRun.label || plan.quality_focus);
      if (named) Object.assign(currentRung, named);
    }
    newHighWords(currentRung);
  }
  // A ring with nothing on it (no run placed, nothing lifted, no ride) is no map: it
  // goes out empty rather than as seven blank columns.
  if (!leg_map.some((d) => d.run || d.strength || d.ride)) leg_map.length = 0;
  // Every rung speaks to the same ring: how lifting and running fit, week by week — and
  // carries the ONE stage word every surface names that week with.
  for (const week of weeks) {
    week.with_lifting = liftingLine(week, leg_map, strengthLead);
    const stage = stageKeyOf(week.kind, week.phase);
    if (stage) week.stage_word = STAGE_WEEK_WORD[stage];
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
            // Only the days still ahead: never a move onto (or of) a day already trained.
            closed: weekLayoutClosed(asOf, { runPlan: plan ?? null }),
          });
        })
      : opts.weekLayout;
  const strength: RaceBuild["strength"] = {
    // Same map as the leg map: with a stated lifting week a template day's weekday is
    // wherever the ring lands it, not its number. Unmapped (a day the week does not
    // reach) is left out rather than given a weekday it will not be trained on.
    heavy_lower_days: [...heavyLower].sort((a, b) => a - b).map(weekdayOfDayNumber),
    // The current rung's kind — calendar weeks to race week, the ladder's own count
    // (a taper week is the taper for a strength-led athlete; an endurance-led one reads
    // by phase). Only a build with no rung falls back to the race's day count.
    principle: raceStrengthPrinciple({
      phase,
      kind: currentRung?.kind ?? (weeksToRace <= 0 ? "race" : "build"),
      lead: strengthLead,
    }).principle,
    layout: layout && !layout.clean ? layout.suggestion : null,
    clean: layout ? layout.clean : true,
  };

  const event = goal.event || `your ${distanceWords(distance, units)} race`;
  const why = pickDayVariant(WHY_VARIANTS, asOf, "race-build:why")
    .replace("{weeks}", String(weeksToRace))
    .replace("{event}", event)
    .replace("{km}", distanceWords(weekKm || review.weeks.at(-1)?.km || 0, units, { whole: true }))
    .replace("{long}", distanceWords(longKm != null ? longKm : (weeks[0]?.long_km ?? 0), units))
    .replace("{estimate}", estimateSentence(prediction, target, units))
    .trim();

  return {
    available: true,
    as_of: asOf,
    units,
    running: "race",
    race: {
      event: goal.event ?? null,
      date: goal.date,
      distance_km: distance,
      days_to_race: goal.days_to_race ?? 0,
      weeks_to_race: weeksToRace,
      phase,
      target,
      stretch: stretchTarget
        ? { ...stretchTarget, fit: prediction ? raceFit(prediction.estimate_sec, stretchTarget.sec) : null }
        : null,
      target_raw: goal.target ?? null,
    },
    prediction,
    paces,
    this_week: thisWeekRead(plan, asOf, logRuns, qualityPace, { agenda, closed: closedRead, bestBeforeKm, adapt, units }),
    weeks,
    leg_map,
    strength,
    ride,
    capacity: shownCapacity
      ? {
          floor_km: shownCapacity.floor_km,
          floor_week_start: shownCapacity.floor_week_start,
          best_week_km: shownCapacity.best_week_km,
          set_aside: shownCapacity.set_aside.map((w) => ({ week_start: w.week_start, km: w.km, kind: w.harm.kind })),
          note: capacitySetAsideLine(shownCapacity, asOf, units),
        }
      : null,
    review,
    adapted: adaptedLine(adapt, asOf, units),
    why,
    reason: null,
  };
}

const NOT_CLOSED: CurrentWeekClosed = { closed: false, reason: null, last_run_day: null };

/**
 * The ladder from `asOf`'s week to race week, off the engine's own week `plan` — the ONE
 * walk every surface reads: the race build prints it, and the engine's race-feasibility
 * sentence reads its peak through race-ladder-hook.ts (the engine cannot import this
 * module back). `logRuns` is the recent-runs read raceBuild already holds.
 */
export function raceLadderFor(
  goal: RaceRampGoal & { date: string; distance_km: number },
  asOf: string,
  plan: Pick<WeeklyRunPlan, "available" | "runs" | "planned_runs" | "goal_feasibility"> | null,
  logRuns: RunRow[] = recentRuns(asOf, 42),
  ladderOpts?: {
    strengthLead?: RaceStrengthLead;
    /**
     * The current week closed early (`currentWeekClosedEarly`), as run: the walk then
     * steps off the logged week rather than its prescription, today rather than next
     * Monday — exactly as the engine will on Monday. The engine's own feasibility read
     * (race-ladder-hook.ts) passes the same closed week, so both name one peak.
     */
    closed?: { logged_km: number; long_km: number | null } | null;
  }
): {
  weeks: RaceBuildWeek[];
  review: RaceBuild["review"];
  shownCapacity: ReturnType<typeof demonstratedRunCapacity> | null;
  /** What the closed week did to the walk (machine register; `adaptedLine` speaks it). */
  adapt: RaceLadderAdapt;
} {
  const runs = plan?.available ? weekAsPlanned(plan) : [];
  const weekKm = round1(runs.reduce((s, r) => s + (r.target_distance_km != null ? Number(r.target_distance_km) : 0), 0));
  const longRun = runs.find((r) => r.kind_label === "long") ?? null;
  const longKm = longRun?.target_distance_km != null ? Number(longRun.target_distance_km) : null;
  const priorReview = weeklyReview(asOf, logRuns);
  const closed = ladderOpts?.closed && ladderOpts.closed.logged_km > 0 ? ladderOpts.closed : null;
  const review = closed ? weeklyReview(asOf, logRuns, true) : priorReview;
  const anchorKm = closed ? round1(closed.logged_km) : weekKm > 0 ? weekKm : priorReview.weeks.at(-1)?.km || 0;
  const anchorLong = closed
    ? Math.max(closed.long_km ?? 0, 0) || (longKm ?? priorReview.longest_recent_km ?? 0)
    : (longKm ?? priorReview.longest_recent_km ?? 0);
  // The engine's own prescription is the truth for this week, and the rung the rest
  // of the ladder steps off (see projectRaceBuildWeeks) — until the week is closed,
  // when what was RUN is the week.
  // The engine already knows next week (an upcoming recovery week, a hold, a stated
  // schedule change); handed to the ladder, the second rung is the engine's own number
  // rather than a projection that disagrees with the run list one card down.
  //
  // But only once THIS week's volume is in the bank. The engine sizes a week off the
  // Mon–Sun before it, so asked about next Monday mid-week it anchors on the three or
  // four kilometres logged so far and hands back a collapsed rung the ladder then
  // walks from. Until the log has caught up with this week's prescription (or the week
  // has closed early), next week steps off the prescription (the walk's own projection).
  const thisMonday = mondayOf(asOf);
  const loggedThisWeek = logRuns.filter((r) => r.date >= thisMonday && r.date <= asOf).reduce((s, r) => s + r.km, 0);
  const thisWeekBanked = closed != null || (weekKm > 0 && loggedThisWeek >= weekKm);
  const nextMonday = addDaysISO(thisMonday, 7);
  const nextPlan = nextMonday && thisWeekBanked ? safe(() => weeklyRunPlan(nextMonday)) : null;
  const nextRuns = nextPlan?.available ? nextPlan.runs : [];
  const nextKm = round1(nextRuns.reduce((s, r) => s + (r.target_distance_km != null ? Number(r.target_distance_km) : 0), 0));
  const nextLong = nextRuns.find((r) => r.kind_label === "long");
  const priorWeekKm = priorReview.weeks.find((w) => w.week_start === addDaysISO(thisMonday, -7))?.km ?? null;
  // What the running has already shown, read at the same closed week the engine plans
  // this week from (the Sunday before this Monday) — or, once this week has closed
  // early, at its own Sunday, so the week just run counts (or is set aside) today.
  const priorCapacity = safe(() => demonstratedRunCapacity(addDaysISO(thisMonday, -1) ?? asOf));
  const thisSunday = addDaysISO(thisMonday, 6);
  const shownCapacity = closed && thisSunday ? (safe(() => demonstratedRunCapacity(thisSunday)) ?? priorCapacity) : priorCapacity;
  const currentWeekHarmed = safe(() => closedWeekRunHarm(asOf)) != null;
  // A closed week is stepped off as run — no rule of the ladder's own after a big or a
  // harmed week. What follows it is the engine's: its next week (read once this week is
  // banked) and the ACWR ceiling the walk already applies over the logged weeks, so the
  // ladder read on the Sunday a week closes is the ladder Monday's engine walks.
  const priorKms = priorReview.weeks.map((w) => w.km);
  const weeks = projectRaceBuildWeeks(
    goal,
    asOf,
    anchorKm,
    anchorLong,
    closed ? { km: round1(closed.logged_km), long_km: anchorLong || longKm } : weekKm > 0 ? { km: weekKm, long_km: longKm } : null,
    nextKm > 0 ? { km: nextKm, long_km: nextLong?.target_distance_km != null ? Number(nextLong.target_distance_km) : null } : null,
    {
      priorWeekKm,
      closedWeeksKm: priorKms,
      demonstratedLongKm: demonstratedLongKm(asOf, logRuns),
      demonstratedWeekKm: shownCapacity?.floor_km ?? null,
      // A new weekly high is said against the biggest week BEFORE this one: a closed
      // current week that passed it is itself the new high, and the peak is then read
      // against it.
      bestWeekKm: priorCapacity?.best_week_km ?? null,
      currentWeekHarmed,
      strengthLead: ladderOpts?.strengthLead,
      // The engine's own run week, when its run count is fixed — so a projected rung is
      // what the engine will prescribe in those runs, not a volume they cannot carry.
      capacity: plan?.goal_feasibility?.capacity
        ? {
            shape: plan.goal_feasibility.capacity,
            demonstratedMidweekKm: plan.goal_feasibility.capacity.demonstrated_midweek_km,
          }
        : null,
    }
  );
  const current = weeks.find((w) => w.current);
  if (current && closed) {
    current.closed = true;
    current.planned_km = weekKm > 0 ? weekKm : null;
  }
  return {
    weeks,
    review,
    shownCapacity,
    adapt: {
      closed: !!closed,
      logged_km: closed ? round1(closed.logged_km) : round1(loggedThisWeek),
      planned_km: weekKm > 0 ? weekKm : null,
      harmed: currentWeekHarmed,
      next_km: nextKm > 0 ? nextKm : null,
    },
  };
}

/** The closed current week as run, off the log the caller holds; null while the week is open. */
function closedWeekAsRun(asOf: string, logRuns: RunRow[], read: CurrentWeekClosed): { logged_km: number; long_km: number | null } | null {
  if (!read.closed) return null;
  const monday = mondayOf(asOf);
  const week = logRuns.filter((r) => r.date >= monday && r.date <= asOf);
  return {
    logged_km: round1(week.reduce((s, r) => s + r.km, 0)),
    long_km: week.reduce((m, r) => Math.max(m, r.km), 0) || null,
  };
}

export interface RaceLadderAdapt {
  /** The current week closed early and the walk stepped off it as run. */
  closed: boolean;
  logged_km: number;
  planned_km: number | null;
  /** The week's running carried harm evidence (closedWeekRunHarm). */
  harmed: boolean;
  /** The engine's own next week, when the walk read it (the ladder's next rung). */
  next_km: number | null;
}

// After a harmed week, said only when the engine's own next week really does not climb
// past it — the sentence names that rung, never a hold the ladder does not draw.
const ADAPTED_HARMED: ReadonlyArray<(logged: string, next: string) => string> = [
  (logged, next) => `This week's ${logged} asked a lot of the body, so next week sits at ${next} rather than climbing off it.`,
  (logged, next) => `The body is still answering this week's ${logged}, so next week stays at ${next} rather than climbing past it.`,
];
const ADAPTED_REREAD: ReadonlyArray<(logged: string, planned: string) => string> = [
  (logged, planned) => `The weeks ahead now read from the ${logged} you ran rather than the ${planned} planned.`,
  (logged, planned) => `This week is in at ${logged} against ${planned} planned, and the ladder steps on from what you ran.`,
];

/**
 * The ONE calm sentence for when the forward ladder moved because of this week. "" when
 * the week is still open, or closed close to its plan. Every claim is one the ladder
 * draws: next week's figure is the engine's own rung. In km; a suggestion, never a verdict.
 */
export function adaptedLine(adapt: RaceLadderAdapt | null | undefined, date: string, units: DistanceUnit = "km"): string {
  if (!adapt?.closed) return "";
  const kmText = (km: number) => distanceWords(km, units);
  const logged = kmText(adapt.logged_km);
  const planned = adapt.planned_km != null ? kmText(adapt.planned_km) : null;
  if (adapt.harmed && adapt.next_km != null && adapt.next_km > 0 && adapt.next_km <= adapt.logged_km + 0.05) {
    return pickDayVariant(ADAPTED_HARMED, date, "race-build:adapted:harmed")(logged, kmText(adapt.next_km));
  }
  if (!planned) return "";
  const gap = Math.abs(adapt.logged_km - (adapt.planned_km ?? 0));
  if (gap < Math.max(2, (adapt.planned_km ?? 0) * 0.1)) return "";
  return pickDayVariant(ADAPTED_REREAD, date, "race-build:adapted:reread")(logged, planned);
}

function kmText(km: number, units: DistanceUnit = "km"): string {
  return distanceWords(km, units);
}

// The engine's race-feasibility sentence reads the same walk (race-ladder-hook.ts).
registerRaceLadderPeak((asOf, plan) => {
  const key = memoKey(plan);
  if (key == null) return raceLadderPeakRead(asOf, plan);
  return requestMemo(`race_ladder_peak:${asOf}:${key}`, () => raceLadderPeakRead(asOf, plan), copyFlat);
});

function raceLadderPeakRead(asOf: string, plan: RaceLadderPlanDraft): number | null {
  const goal = getEnduranceGoal(asOf);
  const distance = Number(goal?.distance_km);
  if (!goal?.is_race || !goal.date || !(distance > 0) || goal.phase === "past") return null;
  // The same closed week the race page walks from (raceBuild), so a Sunday the week
  // closes early names one peak on both surfaces. currentWeekClosedEarly may read the
  // agenda, and so the engine, back: that nested engine read is inside this walk, where
  // raceLadderPeak answers null, so it cannot recurse.
  const logRuns = recentRuns(asOf, 42);
  const closedRead = safe(() => currentWeekClosedEarly(asOf)) ?? NOT_CLOSED;
  const weeks = raceLadderFor({ ...goal, date: goal.date, distance_km: distance }, asOf, plan as any, logRuns, {
    closed: closedWeekAsRun(asOf, logRuns, closedRead),
  }).weeks;
  return weeks.find((w) => w.kind === "peak")?.km ?? null;
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
