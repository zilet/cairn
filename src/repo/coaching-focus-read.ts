// ============================================================================
// coaching-focus-read.ts — the conductor's WEEK READ: the concrete, dated facts
// underneath "Where to focus".
//
// The conductor (coaching-focus.ts) arbitrates the levers. This module supplies what
// an elite coaching team says around that choice, so the card is a synthesis of the
// week rather than a standing slogan:
//   - `blockRead`     where the athlete is in the block, read through the ONE block
//                     phase resolution (block-phase.ts → coachBlockSummary), and what
//                     the deload / peak decision actually is this week;
//   - `raceRead`      the race build's estimate, fit, this week and next (race-build.ts
//                     already computed every figure; nothing is re-derived here);
//   - `focusEvidence` value-and-direction bullets per domain — never a score, never a
//                     marker's internal impact_score, never a percentile;
//   - `focusChanges`  what moved over a dated window (a new best, the race estimate,
//                     the weight average, a fresh lab, last week's running), each
//                     carrying the date it is measured against.
//
// Pure and null-safe: every input is a read getCoachContext already built, passed in
// through CoachingFocusInput, so this never queries and never writes. "Since" is a
// dated WINDOW over the evidence itself, not a stored snapshot of the last card —
// a GET that wrote a snapshot would make two opens of one morning read differently.
// ============================================================================

import type { CoachingFocusInput } from "./coaching-focus.js";
import { shortDate } from "./dexa-window.js";
import type { FocusDomain } from "./focus-candidate.js";
import { addDaysISO, daysBetweenISO, isoDate as isoDayKey } from "../lib/dates.js";
import { finite, round1 } from "../lib/numbers.js";
import {
  distanceOfWords,
  distanceWords,
  loadWords,
  paceWords,
  raceDistanceName,
  sinceWords,
  unitsFrom,
  weightRateWords,
  weightWords,
  type AthleteUnits,
} from "./display-words.js";

// ---- the published shapes -------------------------------------------------------

/** Which way a value is moving. A direction, never a verdict on it. */
export type FocusDirection = "up" | "down" | "steady";

/** One evidence bullet: a value and its direction, in plain words. No score. */
export interface FocusEvidence {
  domain: FocusDomain;
  label: string;
  value: string;
  direction: FocusDirection | null;
  /** The window or the reference it sits against ("9 min faster since Sep 8"). */
  note: string | null;
  as_of: string | null;
}

export type FocusChangeKind = "new_best" | "race_estimate" | "run_volume" | "weight" | "new_lab";

/** Something that moved, measured against a stated date. */
export interface FocusChange {
  domain: FocusDomain;
  kind: FocusChangeKind;
  text: string;
  /** The date the comparison is made against (the window's start, the prior reading). */
  since: string | null;
  /** `since` in words ("since Sep 25", "since Monday") — the only form a person reads. */
  since_words?: string | null;
  /**
   * Which way the measured value moved, from the SAME evidence the text states — never a
   * verdict on it (a race estimate that got faster moves "down", a lower weight average
   * "down"). Null when the change carries no direction of its own (a lab whose reading
   * has no trend yet). Optional on older cached payloads.
   */
  direction?: FocusDirection | null;
}

/** Today's posture: a DAY state, said apart from the week's lever. */
export interface FocusDayState {
  posture: "rest" | "easy" | "done";
  title: string;
  line: string;
  move: string;
}

export type FocusDeloadDecision =
  | "recovery_week" // an applied recovery week is running
  | "deload_week" // the block's own deload runs this week
  | "set_aside" // the scheduled deload runs as a push week: the loaded weeks did not earn it
  | "next_week" // the block's deload is next week and will run
  | "next_week_if_earned" // next week's scheduled deload runs only if the loaded weeks earn it
  | "earned" // the loaded weeks call for a lighter week now
  | "later" // the deload sits further down the block
  | "none"; // a test week, or no deload in this block's shape

/** The block read, through block-phase.ts's single resolution. */
export interface FocusBlockRead {
  week: number | null;
  of: number | null;
  /** The phase the week actually runs as. */
  phase: string | null;
  /** The block calendar's own phase, only when the week runs as something else. */
  scheduled_phase: string | null;
  deload: FocusDeloadDecision;
  /** One sentence: what the deload / peak decision is this week. */
  decision: string;
  /** Monday the race taper begins, when a dated race build overlaps the block. */
  race_taper_from: string | null;
}

// ---- input shapes (all optional, all read null-safe) -------------------------------

export interface RaceWeekInput {
  week_start?: unknown;
  weeks_to_race?: unknown;
  kind?: unknown;
  km?: unknown;
  long_km?: unknown;
  focus?: unknown;
  focus_short?: unknown;
  new_high?: unknown;
  current?: unknown;
  with_lifting?: unknown;
}

export interface RaceBuildInput {
  available?: unknown;
  as_of?: unknown;
  race?: {
    event?: unknown;
    date?: unknown;
    distance_km?: unknown;
    days_to_race?: unknown;
    weeks_to_race?: unknown;
    phase?: unknown;
    target?: { sec?: unknown; raw?: unknown } | null;
    stretch?: { sec?: unknown; raw?: unknown; fit?: unknown } | null;
  } | null;
  prediction?: {
    estimate_sec?: unknown;
    estimate_pace_sec_per_km?: unknown;
    as_of?: unknown;
    trend?: { delta_sec?: unknown; since?: unknown; word?: unknown } | null;
    fit?: unknown;
  } | null;
  this_week?: {
    km?: unknown;
    long_km?: unknown;
    logged_km?: unknown;
    quality?: { label?: unknown; pace?: { text?: unknown } | null } | null;
  } | null;
  weeks?: unknown;
  leg_map?: unknown;
  ride?: {
    label?: unknown;
    weekday?: unknown;
    day_number?: unknown;
    typical_min?: unknown;
    typical_load?: unknown;
    placement?: unknown;
  } | null;
  capacity?: { best_week_km?: unknown } | null;
  review?: { weeks?: unknown } | null;
}

export interface GoalPaceInput {
  points?: unknown;
  trend?: { lb_wk?: unknown } | null;
  needed?: { lb_wk?: unknown } | null;
  goal?: { weight_lb?: unknown; date?: unknown } | null;
  window_days?: unknown;
}

export interface WeekWinsInput {
  prs?: unknown;
}

export interface CutQualityInput {
  active?: unknown;
  strength?: { considered?: unknown; holding?: unknown; regressing?: unknown } | null;
}

export interface CapacityInput {
  key?: unknown;
  label?: unknown;
  exercise?: unknown;
  est_1rm?: unknown;
  level?: unknown;
  age_band?: unknown;
  to_next?: { level?: unknown; lb?: unknown } | null;
}

export interface LiftInput {
  exercise?: unknown;
  muscle_group?: unknown;
  est_1rm?: unknown;
  trend_per_wk?: unknown;
  status?: unknown;
}

export interface HealthReadingInput {
  name?: unknown;
  value?: unknown;
  unit?: unknown;
  date?: unknown;
  flag?: unknown;
  optimal?: unknown;
  in_optimal?: unknown;
  trend?: unknown;
  status_note?: unknown;
}

export interface HealthPriorityInput {
  group?: unknown;
  tier?: unknown;
  readings?: unknown;
  why?: unknown;
}

// ---- small pure helpers ------------------------------------------------------------

export function lc(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}
function str(s: unknown): string {
  return String(s ?? "").trim();
}
/** A finite number, or null — null/undefined/"" never coerce to 0 (lib/numbers `finite`). */
const fin = finite;
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
/** The day key a value leads with ("2026-10-06T…" → "2026-10-06"), or null. */
function dayOf(v: unknown): string | null {
  return isoDayKey(String(v ?? "").slice(0, 10));
}
function addDays(iso: string, n: number): string {
  return addDaysISO(iso, n) ?? iso;
}
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
/** A finish time: "1:53:52", or "2:00" for a round target. */
export function clock(sec: number, opts: { round?: boolean } = {}): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0 && opts.round && r === 0) return `${h}:${String(m).padStart(2, "0")}`;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}
/** A gap in words: "9 min", "3:52", "40 s". */
function gapWords(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s >= 300) return `${Math.round(s / 60)} min`;
  if (s >= 60) return clock(s);
  return `${s} s`;
}
export function joinAnd(items: string[]): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** "Sharpen · " — the week's one stage word ahead of the block line, when known. */
function stagePrefix(inp: CoachingFocusInput): string {
  const word = str((inp.weekStage as { word?: unknown } | null | undefined)?.word);
  return word ? `${word} · ` : "";
}

/** The read's own date: explicit, else the signal state's, else the race build's. */
export function readDate(inp: CoachingFocusInput): string | null {
  return dayOf(inp.date) ?? dayOf(inp.signalState?.date) ?? dayOf(inp.raceBuild?.as_of) ?? null;
}

// ---- the block: one resolution, one decision ----------------------------------------

/** "week 6 of 6" → {6, 6}. */
function parseWeekOf(weekOf: unknown): { week: number | null; of: number | null } {
  const m = /week\s+(\d+)\s+of\s+(\d+)/i.exec(String(weekOf ?? ""));
  return m ? { week: Number(m[1]), of: Number(m[2]) } : { week: null, of: null };
}

/** The Monday the race build's taper (or race week) starts, when one lies ahead. */
function raceTaperFrom(inp: CoachingFocusInput): string | null {
  const rb = inp.raceBuild;
  if (!rb?.available || !rb.race) return null;
  const week = arr<RaceWeekInput>(rb.weeks).find((w) => {
    const kind = lc(w?.kind);
    return kind === "taper" || kind === "race";
  });
  return dayOf(week?.week_start);
}

export interface BlockReadResult {
  read: FocusBlockRead;
  line: string;
}

/**
 * Where the athlete stands in the block and what the deload decision is. The phase
 * comes from coachBlockSummary (block-phase.ts), which already resolved a push
 * athlete's scheduled deload against the loaded-weeks evidence — this only SAYS it,
 * so the card can never call a week "the deload is in sight" while the prescriptions
 * run it as intensification.
 */
export function blockRead(inp: CoachingFocusInput): BlockReadResult | null {
  const b = inp.programBlock;
  const weekOf = str(b?.week_of);
  if (!weekOf) return null;
  const { week, of } = parseWeekOf(weekOf);
  const wk = cap(weekOf);
  const phase = lc(b?.phase) || null;
  const focus = lc(b?.focus);
  const skipped = b?.scheduled_deload_skipped === true;
  const recoveryActive = inp.recoveryWeekActive === true;
  const mesoPhase = lc(inp.programState?.mesocycle?.phase);
  const nextRuns = b?.next_week_deload_runs;
  const taper = raceTaperFrom(inp);
  const taperWords = taper ? `the race taper from ${shortDate(taper)} lightens the legs` : "";

  let tail = "";
  let deload: FocusDeloadDecision = "none";
  let decision = "";
  if (recoveryActive) {
    tail = "a deload week: absorb the work you've put in";
    deload = "recovery_week";
    decision = "Your recovery week is running: same movements, lighter volume, then back to building.";
  } else if (skipped) {
    // The set-aside is said ONCE, here in the line; the decision says why and what
    // happens instead. Train prints the two side by side ("<line> <decision>"), so
    // neither half repeats the other's reason (the loaded weeks) or move (intensity).
    tail = "the scheduled deload is set aside";
    deload = "set_aside";
    decision = taper
      ? `Your loaded weeks haven't called for one, so intensity carries on; ${taperWords}.`
      : "Your loaded weeks haven't called for one, so intensity carries on.";
  } else if (phase === "deload") {
    tail = "a deload week: absorb the work you've put in";
    deload = "deload_week";
    decision = "The block's deload runs this week: hold the loads, ease the volume, and let the block land.";
  } else if (phase === "realization") {
    tail = "test week: express what the block built";
    deload = "none";
    decision = "Test week: work up to the re-tests while you're fresh.";
  } else if (phase === "intensification") {
    const lastBeforeDeload = week != null && of != null && week + 1 === of && focus !== "peak";
    if (lastBeforeDeload && nextRuns === false) {
      tail = "pushing intensity; next week's scheduled deload runs only if your loaded weeks call for one";
      deload = "next_week_if_earned";
      decision = "Next week's deload is on the calendar, but it runs only if your loaded weeks call for it.";
    } else if (lastBeforeDeload) {
      tail = "pushing intensity; the deload is next week";
      deload = "next_week";
      decision = "Push this week; the block's deload follows next week.";
    } else {
      tail = "pushing intensity";
      deload = of != null && week != null && week < of ? "later" : "none";
      decision =
        of != null && week != null && week < of
          ? `Intensity carries the block now; its scheduled deload is week ${of}.`
          : "Intensity carries the block now.";
    }
  } else if (phase === "accumulation") {
    tail = "building volume";
    deload = "later";
    const turn = of != null ? Math.ceil(of / 2) + 1 : null;
    decision =
      turn != null && of != null && turn <= of
        ? `Volume builds now; intensity takes over from week ${turn}.`
        : "Volume builds now.";
  }
  // The loaded weeks themselves calling for a lighter week outrank the calendar.
  if (mesoPhase === "deload-due" && deload !== "recovery_week" && deload !== "deload_week") {
    deload = "earned";
    decision = "Your loaded weeks now call for a lighter week, whatever the block calendar says.";
  }
  if (taper && deload !== "set_aside" && !decision.includes("taper")) {
    decision = `${decision} ${cap(taperWords)}.`.trim();
  }
  return {
    read: {
      week,
      of,
      phase,
      scheduled_phase: skipped ? "deload" : null,
      deload,
      decision,
      race_taper_from: taper,
    },
    // The week's ONE stage word (week-stage.ts) leads when the orchestrator passed it.
    line: `${stagePrefix(inp)}${tail ? `${wk} — ${tail}.` : `${wk}.`}`,
  };
}

// ---- the race build, read once ------------------------------------------------------

export interface RaceRead {
  event: string;
  raceDate: string | null;
  distanceName: string;
  daysTo: number | null;
  phase: string;
  estimateSec: number | null;
  estimatePace: string | null;
  estimateAsOf: string | null;
  targetSec: number | null;
  stretchSec: number | null;
  fit: string | null;
  trend: { deltaSec: number; since: string | null; word: string } | null;
  current: RaceWeekInput | null;
  next: RaceWeekInput | null;
  thisWeek: {
    km: number | null;
    longKm: number | null;
    loggedKm: number | null;
    quality: string | null;
    qualityPace: string | null;
  } | null;
  ride: {
    label: string;
    weekday: string;
    minutes: number | null;
    load: string;
    placement: string;
    dayNumber: number | null;
  } | null;
  longRunDay: number | null;
  lastClosed: { weekStart: string | null; km: number } | null;
  bestWeekKm: number | null;
  maxLongKmAhead: number | null;
  /** The athlete's units: every sentence built off this read says its numbers in them. */
  units?: AthleteUnits;
}

/** The race read's distance unit (km when a hand-built read carries none). */
function raceDist(r: RaceRead): AthleteUnits["distance"] {
  return r.units?.distance ?? "km";
}

/** The athlete's units off the input (CoachingFocusInput.units), km / lb when absent. */
export function unitsOfInput(inp: CoachingFocusInput): AthleteUnits {
  const u = inp.units as Partial<AthleteUnits> | null | undefined;
  return unitsFrom({ distance: u?.distance, weight: u?.weight });
}

function distanceName(km: number | null, units: AthleteUnits): string {
  if (km == null) return "race";
  const name = raceDistanceName(km, units.distance);
  return /^\d/.test(name) || /^\d+K$/.test(name) ? name : name.toLowerCase();
}

export function raceRead(inp: CoachingFocusInput): RaceRead | null {
  const units = unitsOfInput(inp);
  const rb = inp.raceBuild;
  if (!rb?.available || !rb.race) return null;
  const race = rb.race;
  const phase = lc(race.phase);
  if (phase === "past") return null;
  const weeks = arr<RaceWeekInput>(rb.weeks);
  const at = weeks.findIndex((w) => w?.current === true);
  const current = at >= 0 ? weeks[at] : (weeks[0] ?? null);
  const next = at >= 0 ? (weeks[at + 1] ?? null) : (weeks[1] ?? null);
  const pred = rb.prediction;
  const est = fin(pred?.estimate_sec);
  const trendDelta = fin(pred?.trend?.delta_sec);
  const tw = rb.this_week;
  const ride = rb.ride;
  const longRun = arr<{ day_number?: unknown; run?: { kind?: unknown } | null }>(rb.leg_map).find(
    (d) => lc(d?.run?.kind) === "long"
  );
  const review = arr<{ week_start?: unknown; km?: unknown }>(rb.review?.weeks);
  const last = review.length ? review[review.length - 1] : null;
  const lastKm = fin(last?.km);
  const longAhead = weeks
    .slice(Math.max(0, at), Math.max(0, at) + 2)
    .map((w) => fin(w?.long_km))
    .filter((n): n is number => n != null);
  return {
    event: str(race.event),
    raceDate: dayOf(race.date),
    distanceName: distanceName(fin(race.distance_km), units),
    daysTo: fin(race.days_to_race),
    phase,
    estimateSec: est,
    estimatePace:
      fin(pred?.estimate_pace_sec_per_km) != null
        ? paceWords(Number(pred?.estimate_pace_sec_per_km), units.distance, { spaced: true })
        : null,
    estimateAsOf: dayOf(pred?.as_of),
    targetSec: fin(race.target?.sec),
    stretchSec: fin(race.stretch?.sec),
    fit: lc(pred?.fit) || null,
    trend:
      trendDelta != null
        ? { deltaSec: trendDelta, since: dayOf(pred?.trend?.since), word: lc(pred?.trend?.word) }
        : null,
    current,
    next,
    thisWeek: tw
      ? {
          km: fin(tw.km),
          longKm: fin(tw.long_km),
          loggedKm: fin(tw.logged_km),
          quality: str(tw.quality?.label) || null,
          qualityPace: str(tw.quality?.pace?.text) || null,
        }
      : null,
    ride: ride?.label
      ? {
          label: str(ride.label),
          weekday: str(ride.weekday),
          minutes: fin(ride.typical_min),
          load: lc(ride.typical_load),
          placement: str(ride.placement),
          dayNumber: fin(ride.day_number),
        }
      : null,
    longRunDay: fin(longRun?.day_number),
    lastClosed: lastKm != null ? { weekStart: dayOf(last?.week_start), km: lastKm } : null,
    bestWeekKm: fin(rb.capacity?.best_week_km),
    maxLongKmAhead: longAhead.length ? Math.max(...longAhead) : null,
    units,
  };
}

/** "Cambridge Half Marathon" or "your half marathon". */
export function raceName(r: RaceRead): string {
  return r.event || `your ${r.distanceName}`;
}

/** Where today's estimate sits against the target and the stretch, in words. */
export function raceFitWords(r: RaceRead): string {
  if (r.estimateSec == null) return "";
  const parts: string[] = [];
  if (r.targetSec != null) {
    const target = clock(r.targetSec, { round: true });
    parts.push(
      r.estimateSec <= r.targetSec
        ? `inside the ${target} target`
        : `${gapWords(r.estimateSec - r.targetSec)} outside the ${target} target`
    );
  }
  if (r.stretchSec != null) {
    const stretch = clock(r.stretchSec, { round: true });
    parts.push(
      r.estimateSec <= r.stretchSec
        ? `at the ${stretch} stretch`
        : `${gapWords(r.estimateSec - r.stretchSec)} from the ${stretch} stretch`
    );
  }
  return parts.join(", ");
}

function weekPhrase(w: RaceWeekInput, units: AthleteUnits): string {
  const kind = lc(w?.kind);
  const km = fin(w?.km);
  const long = fin(w?.long_km);
  const kmWords = km != null ? distanceWords(km, units.distance) : "";
  const longWords = long != null ? ` with a ${distanceWords(long, units.distance)} long run` : "";
  if (kind === "peak") return `is the peak${kmWords ? `: ${kmWords}${longWords}` : ""}`;
  if (kind === "taper") return `the taper starts${kmWords ? `: about ${kmWords}` : ""}`;
  if (kind === "race") return "is race week";
  if (kind === "down") return `steps down${kmWords ? ` to ${kmWords}` : ""}`;
  return kmWords ? `builds to ${kmWords}${longWords}` : "keeps building";
}

/** This week's concrete running move, and next week's shape. */
export function raceMove(r: RaceRead): string {
  const bits: string[] = [];
  const tw = r.thisWeek;
  if (tw) {
    const quality = tw.quality ? `${lc(tw.quality)}${tw.qualityPace ? ` (${tw.qualityPace})` : ""}` : "";
    const long = tw.longKm != null ? `a ${distanceWords(tw.longKm, raceDist(r))} long run` : "";
    const both = joinAnd([quality, long].filter(Boolean));
    if (both) bits.push(`This week: ${both}.`);
  }
  if (r.next) bits.push(`Next week ${weekPhrase(r.next, r.units ?? unitsFrom(null))}.`);
  return bits.join(" ");
}

/** The race build's lead/parallel item prose — specific to this week. */
export function raceItem(r: RaceRead): { title: string; why: string; move: string; noun: string } {
  const days = r.daysTo;
  const name = raceName(r);
  const focusShort = str(r.current?.focus_short);
  const title =
    days != null
      ? `${name}, ${days} day${days === 1 ? "" : "s"} out${focusShort ? `: ${focusShort}` : ""}`
      : `${cap(name)}${focusShort ? `: ${focusShort}` : ""}`;
  const shape =
    r.estimateSec != null
      ? `Current shape reads about ${clock(r.estimateSec)}${r.estimatePace ? ` (${r.estimatePace})` : ""}${raceFitWords(r) ? `, ${raceFitWords(r)}` : ""}.`
      : "";
  const why = [str(r.current?.focus), shape].filter(Boolean).join(" ");
  return { title, why, move: raceMove(r), noun: `the ${r.distanceName} build` };
}

/** The current race-build week is the peak, the taper or race week itself. */
export function raceShapesTheWeek(r: RaceRead | null): boolean {
  const kind = lc(r?.current?.kind);
  return kind === "peak" || kind === "taper" || kind === "race";
}

// ---- strength: the lever lift, in values -------------------------------------------

export interface LeverLift {
  cap: CapacityInput;
  lift: LiftInput | null;
  label: string;
  upper: boolean;
}

const UPPER_KEYS = new Set(["press", "bench", "row", "pullup", "chinup", "dip"]);
const UPPER_GROUP = /shoulder|chest|back|lat|arm|bicep|tricep|delt|pec/;

/** The capacity row the performance lever names, and that lift's logged trend. */
export function leverLift(inp: CoachingFocusInput): LeverLift | null {
  const lever = inp.performance?.lever;
  if (!lever?.headline) return null;
  const head = lc(lever.headline);
  const target = lc(lever.target);
  const caps = arr<CapacityInput>(inp.performance?.capacities);
  const found =
    caps.find((c) => lc(c?.label) && head.includes(lc(c.label))) ??
    caps.find((c) => lc(c?.exercise) && target.includes(lc(c.exercise))) ??
    null;
  if (!found) return null;
  const exercise = lc(found.exercise);
  const lift = arr<LiftInput>(inp.programState?.lifts).find((l) => lc(l?.exercise) === exercise) ?? null;
  const upper = UPPER_KEYS.has(lc(found.key)) || UPPER_GROUP.test(lc(lift?.muscle_group));
  return { cap: found, lift, label: str(found.label) || str(found.exercise), upper };
}

/** "Overhead press sits at an est. 1RM of 87 lb — novice for your 40s, about 10 lb from intermediate." */
export function leverFacts(l: LeverLift, units: AthleteUnits = unitsFrom(null)): string {
  const lb = (n: number) => loadWords(Math.round(n), units.weight);
  const e1rm = fin(l.cap.est_1rm);
  const level = lc(l.cap.level);
  const band = str(l.cap.age_band);
  const nextLb = fin(l.cap.to_next?.lb);
  const nextLevel = lc(l.cap.to_next?.level);
  const head =
    e1rm != null
      ? `${cap(lc(l.label))} sits at an est. 1RM of ${lb(e1rm)}${level ? ` — ${level}${band ? ` for your ${band}` : ""}` : ""}${nextLb != null && nextLevel ? `, about ${lb(nextLb)} from ${nextLevel}` : ""}.`
      : "";
  const trend = fin(l.lift?.trend_per_wk);
  let move = "";
  if (trend != null && trend > 0.2) {
    move = ` It's climbing about ${weightWords(trend, units.weight)} a week`;
    if (nextLb != null && nextLevel) {
      const weeks = Math.ceil(nextLb / trend);
      if (weeks <= 26) move += `, so ${nextLevel} is roughly ${weeks} week${weeks === 1 ? "" : "s"} out at this rate`;
    }
    move += ".";
  } else if (trend != null && trend < -0.2) {
    move = ` It has slipped about ${weightWords(Math.abs(trend), units.weight)} a week lately.`;
  } else if (lc(l.lift?.status) === "plateaued") {
    move = " It has held flat for several sessions.";
  } else if (trend != null) {
    move = " It has held steady lately.";
  }
  return `${head}${move}`.trim();
}

/** What the block phase asks of the lever lift this week (progression policy, in words). */
export function phaseMoveFor(phase: string | null, liftLabel: string, deloadSetAside: boolean): string {
  const lift = lc(liftLabel) || "the lift";
  if (phase === "deload") return `Deload week: hold the load on the ${lift} and keep every rep crisp.`;
  if (phase === "realization")
    return `Test week: work up to a heavy triple on the ${lift} to re-anchor where it stands.`;
  if (phase === "intensification" || deloadSetAside)
    return `This week a strong top set at the top of the range earns the load step, so give the ${lift} its best set early in the session.`;
  if (phase === "accumulation")
    return `This block banks volume: one more clean rep across every set of the ${lift} before the load moves.`;
  return "";
}

// ---- evidence ----------------------------------------------------------------------

function shortMarker(name: string): string {
  const m = /\(([^)]+)\)\s*$/.exec(name);
  return m ? m[1] : name;
}

function readingDirection(trend: unknown): FocusDirection | null {
  const t = lc(trend);
  if (t === "rising") return "up";
  if (t === "falling") return "down";
  if (t === "stable") return "steady";
  return null;
}

function bandWords(r: HealthReadingInput): string | null {
  const v = fin(r.value);
  const band = arr<unknown>(r.optimal).map(fin);
  const lo = band[0] ?? null;
  const hi = band[1] ?? null;
  if (v == null || lo == null || hi == null) return r.in_optimal === false ? "outside the optimal band" : null;
  if (v > hi) return `above the ${lo}–${hi} optimal band`;
  if (v < lo) return `below the ${lo}–${hi} optimal band`;
  return r.in_optimal === false ? `at the edge of the ${lo}–${hi} band` : `inside the ${lo}–${hi} band`;
}

/** The flagged readings behind a health priority, value first. */
export function flaggedReadings(p: HealthPriorityInput | null | undefined, max = 2): HealthReadingInput[] {
  return arr<HealthReadingInput>(p?.readings)
    .filter(
      (r) => fin(r?.value) != null && (r?.in_optimal === false || lc(r?.flag) === "high" || lc(r?.flag) === "low")
    )
    .slice(0, max);
}

export function readingPhrase(r: HealthReadingInput): string {
  const unit = str(r.unit);
  const trend = lc(r.trend);
  return `${shortMarker(str(r.name))} ${fin(r.value)}${unit ? ` ${unit}` : ""}${trend === "rising" || trend === "falling" ? ` (${trend})` : ""}`;
}

function strengthStanding(inp: CoachingFocusInput): FocusEvidence | null {
  const caps = arr<CapacityInput>(inp.performance?.capacities).filter((c) => lc(c?.level) && str(c?.label));
  if (caps.length < 2) return null;
  const top = caps[0];
  const bottom = caps[caps.length - 1];
  const band = str(top.age_band || bottom.age_band);
  const climbing = arr<{ kind?: unknown; text?: unknown }>(
    (inp.performance as { momentum?: { chips?: unknown } } | null | undefined)?.momentum?.chips
  ).find((c) => lc(c?.kind) === "climbing");
  return {
    domain: "training",
    label: "Strength standing",
    value: `${lc(top.label)} ${lc(top.level)}, ${lc(bottom.label)} ${lc(bottom.level)}${band ? ` for your ${band}` : ""}`,
    direction: null,
    note: climbing?.text ? str(climbing.text) : null,
    as_of: null,
  };
}

function trainingEvidence(inp: CoachingFocusInput, leverIsLead: boolean): FocusEvidence[] {
  const out: FocusEvidence[] = [];
  const units = unitsOfInput(inp);
  const l = leverLift(inp);
  if (l && fin(l.cap.est_1rm) != null) {
    const trend = fin(l.lift?.trend_per_wk);
    const nextLb = fin(l.cap.to_next?.lb);
    const nextLevel = lc(l.cap.to_next?.level);
    const band = str(l.cap.age_band);
    out.push({
      domain: "training",
      label: cap(lc(l.label)),
      value: `est. 1RM ${loadWords(Math.round(Number(l.cap.est_1rm)), units.weight)}`,
      direction: trend == null ? null : trend > 0.2 ? "up" : trend < -0.2 ? "down" : "steady",
      note:
        [
          trend != null && Math.abs(trend) > 0.2 ? weightRateWords(trend, units.weight) : null,
          nextLb != null && nextLevel
            ? `about ${loadWords(Math.round(nextLb), units.weight)} to ${nextLevel}${band ? ` for your ${band}` : ""}`
            : null,
        ]
          .filter(Boolean)
          .join("; ") || null,
      as_of: null,
    });
  }
  // The strength-level standing is a supporting fact only when strength IS the lever.
  if (leverIsLead) {
    const standing = strengthStanding(inp);
    if (standing) out.push(standing);
  }
  return out;
}

function runningEvidence(r: RaceRead | null, inp: CoachingFocusInput): FocusEvidence[] {
  const out: FocusEvidence[] = [];
  if (r && r.estimateSec != null) {
    const trendNote =
      r.trend && Math.abs(r.trend.deltaSec) >= 30
        ? `${gapWords(r.trend.deltaSec)} ${r.trend.deltaSec < 0 ? "faster" : "slower"}${r.trend.since ? ` ${sinceWords(r.trend.since, readDate(inp))}` : ""}`
        : null;
    out.push({
      domain: "running",
      label: `${cap(r.distanceName)} estimate`,
      value: `${clock(r.estimateSec)}${r.estimatePace ? ` (${r.estimatePace})` : ""}`,
      direction: r.trend ? (r.trend.deltaSec <= -30 ? "down" : r.trend.deltaSec >= 30 ? "up" : "steady") : null,
      note: [trendNote, raceFitWords(r) || null].filter(Boolean).join("; ") || null,
      as_of: r.estimateAsOf,
    });
  }
  // Cardio fitness is a running fact for a runner and a longevity fact for anyone.
  const vo2 = vo2Evidence(inp);
  if (vo2) out.push(vo2);
  if (r?.thisWeek && r.thisWeek.km != null) {
    const logged = r.thisWeek.loggedKm;
    out.push({
      domain: "running",
      label: "Running this week",
      value:
        logged != null
          ? distanceOfWords(logged, r.thisWeek.km, raceDist(r))
          : `${distanceWords(r.thisWeek.km, raceDist(r))} planned`,
      direction: null,
      note:
        [
          r.thisWeek.longKm != null ? `long run ${distanceWords(r.thisWeek.longKm, raceDist(r))}` : null,
          r.lastClosed ? `last week ${distanceWords(r.lastClosed.km, raceDist(r))}` : null,
          // The habitual ride is part of the week's load: one clause here, not a bullet.
          rideClause(r),
        ]
          .filter(Boolean)
          .join("; ") || null,
      as_of: null,
    });
  } else if (r?.ride) {
    out.push({
      domain: "running",
      label: cap(r.ride.label),
      value: rideClause(r) ?? cap(r.ride.label),
      direction: null,
      note: null,
      as_of: null,
    });
  }
  return out;
}

/** "trail MTB Saturdays ~140 min, heavy, the day before the long run". */
function rideClause(r: RaceRead): string | null {
  if (!r.ride) return null;
  const mins = r.ride.minutes != null ? `~${Math.round(r.ride.minutes / 10) * 10} min` : null;
  const dayBefore = r.longRunDay != null && r.ride.dayNumber != null && r.ride.dayNumber + 1 === r.longRunDay;
  const head = [r.ride.label, r.ride.weekday ? `${r.ride.weekday}s` : null, mins].filter(Boolean).join(" ");
  return [head, r.ride.load || null, dayBefore ? "the day before the long run" : null].filter(Boolean).join(", ");
}

function vo2Evidence(inp: CoachingFocusInput): FocusEvidence | null {
  const endurance = inp.performance?.endurance;
  const vo2 = fin(endurance?.vo2max);
  if (vo2 == null) return null;
  return {
    domain: "running",
    label: "VO2max",
    value: `${round1(vo2)} mL/kg/min`,
    direction: null,
    note: str(endurance?.trend) || null,
    as_of: null,
  };
}

export interface WeightRead {
  latest: number;
  latestDate: string | null;
  trend: number | null;
  needed: number | null;
  goalLb: number | null;
  goalDate: string | null;
  windowDays: number | null;
  /** The one on-pace verdict (weight-trend.ts), when the orchestrator passed the read. */
  verdict?: "on_pace" | "ahead" | "behind" | "steady" | null;
}

export function weightRead(inp: CoachingFocusInput): WeightRead | null {
  const gp = inp.goalPace;
  const points = arr<{ date?: unknown; weight_lb?: unknown }>(gp?.points).filter((p) => fin(p?.weight_lb) != null);
  if (!points.length) return null;
  const last = points[points.length - 1];
  // The ONE weight-trend read wins when present: its rate and ask are rounded once, the
  // same figures Today's path, the Body page and the Season print.
  const one = inp.weightTrend;
  return {
    latest: Number(last.weight_lb),
    latestDate: dayOf(last.date),
    trend: one ? fin(one.rate_lb_wk) : fin(gp?.trend?.lb_wk),
    needed: one ? fin(one.needed_lb_wk) : fin(gp?.needed?.lb_wk),
    verdict: one?.verdict ?? null,
    goalLb: fin(gp?.goal?.weight_lb),
    goalDate: dayOf(gp?.goal?.date),
    windowDays: fin(gp?.window_days),
  };
}

/** How the weight trend sits against the line to the goal. Information, never a verdict. */
export function paceRelation(w: WeightRead): "on" | "ahead" | "behind" | null {
  // The ONE verdict (weight-trend.ts paceVerdict) when the read rode in.
  if (w.verdict === "on_pace") return "on";
  if (w.verdict === "ahead" || w.verdict === "behind") return w.verdict;
  if (w.trend == null || w.needed == null) return null;
  const diff = w.trend - w.needed; // both negative on a cut; a more negative trend is ahead
  if (Math.abs(diff) <= 0.2) return "on";
  return w.needed < 0 ? (diff < 0 ? "ahead" : "behind") : diff > 0 ? "ahead" : "behind";
}

function bodyEvidence(inp: CoachingFocusInput): FocusEvidence[] {
  const out: FocusEvidence[] = [];
  const units = unitsOfInput(inp);
  const w = weightRead(inp);
  if (w) {
    // The rate and the ask are the ONE weight-trend read's (weight-trend.ts) when the
    // orchestrator passed it; the figures every other weight surface prints.
    const note = [
      w.trend != null ? `${weightRateWords(w.trend, units.weight)} trend` : null,
      w.goalLb != null && w.goalDate && w.needed != null
        ? `${weightWords(w.goalLb, units.weight)} by ${shortDate(w.goalDate)} asks ${weightRateWords(w.needed, units.weight)}`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
    out.push({
      domain: "body",
      label: "Weight",
      value: weightWords(w.latest, units.weight),
      direction: w.trend == null ? null : w.trend <= -0.1 ? "down" : w.trend >= 0.1 ? "up" : "steady",
      note: note || null,
      as_of: w.latestDate,
    });
  }
  const cq = inp.cutQuality;
  const considered = fin(cq?.strength?.considered);
  const holding = fin(cq?.strength?.holding);
  if (cq?.active === true && considered != null && considered >= 3 && holding != null) {
    out.push({
      domain: "body",
      label: "Strength through the cut",
      value: `${holding} of ${considered} main lifts holding or climbing`,
      direction: null,
      note: "the lean-mass proxy between scans",
      as_of: null,
    });
  }
  return out;
}

function healthEvidence(inp: CoachingFocusInput): FocusEvidence[] {
  const lead = inp.healthFocus?.lead as HealthPriorityInput | null | undefined;
  return flaggedReadings(lead, 2).map((r) => ({
    domain: "health" as FocusDomain,
    label: shortMarker(str(r.name)),
    value: `${fin(r.value)}${str(r.unit) ? ` ${str(r.unit)}` : ""}`,
    direction: readingDirection(r.trend),
    note: bandWords(r),
    as_of: dayOf(r.date),
  }));
}

function recoveryEvidence(inp: CoachingFocusInput): FocusEvidence[] {
  const priorities = arr<HealthPriorityInput>(
    (inp.healthFocus as { priorities?: unknown } | null | undefined)?.priorities
  );
  for (const p of priorities) {
    const hrv = arr<HealthReadingInput>(p?.readings).find((r) => lc(r?.name) === "hrv" && fin(r?.value) != null);
    if (!hrv) continue;
    const v = Number(hrv.value);
    const band = arr<unknown>(hrv.optimal).map(fin);
    const lo = band[0] ?? null;
    const hi = band[1] ?? null;
    const where =
      lo != null && hi != null
        ? v < lo
          ? `below your ${lo}–${hi} ms range`
          : v > hi
            ? `above your ${lo}–${hi} ms range`
            : hrv.in_optimal === false
              ? `at the low edge of your ${lo}–${hi} ms range`
              : `inside your ${lo}–${hi} ms range`
        : null;
    return [
      {
        domain: "recovery",
        label: "HRV",
        value: `${round1(v)} ms`,
        direction: readingDirection(hrv.trend),
        note: [str(hrv.status_note) || null, where].filter(Boolean).join("; ") || null,
        as_of: dayOf(hrv.date),
      },
    ];
  }
  return [];
}

const EVIDENCE_MAX = 9;
const EVIDENCE_PER_DOMAIN = 3;

/**
 * Value-and-direction bullets, ordered by the domains the card leads with. Health
 * readings are the lab's own values against the evidence-anchored optimal band —
 * never a marker's internal impact_score; strength is an est-1RM and its distance to
 * the next recognized standard — never a percentile.
 */
export function focusEvidence(
  inp: CoachingFocusInput,
  order: FocusDomain[],
  opts: { leverIsLead: boolean; race: RaceRead | null }
): FocusEvidence[] {
  const byDomain: Record<FocusDomain, FocusEvidence[]> = {
    training: trainingEvidence(inp, opts.leverIsLead),
    running: runningEvidence(opts.race, inp),
    health: healthEvidence(inp),
    nutrition: [],
    body: bodyEvidence(inp),
    recovery: recoveryEvidence(inp),
  };
  // The cut reads under nutrition as often as under body: one weight bullet either way.
  const sequence: FocusDomain[] = [];
  for (const d of [...order, "training", "running", "body", "health", "recovery"] as FocusDomain[]) {
    const domain: FocusDomain = d === "nutrition" ? "body" : d;
    if (!sequence.includes(domain)) sequence.push(domain);
  }
  const out: FocusEvidence[] = [];
  for (const domain of sequence) {
    for (const item of byDomain[domain].slice(0, EVIDENCE_PER_DOMAIN)) {
      if (out.length >= EVIDENCE_MAX) break;
      out.push(item);
    }
  }
  return out;
}

// ---- what changed --------------------------------------------------------------------

const NEW_LAB_DAYS = 21;
const WEIGHT_CHANGE_MIN_LB = 0.4;
const CHANGES_MAX = 4;

function weightChange(inp: CoachingFocusInput, today: string): FocusChange | null {
  const units = unitsOfInput(inp);
  // The ONE weight-trend read's week change and rate, when the orchestrator passed it.
  const one = inp.weightTrend;
  if (one) {
    const wc = one.week_change;
    if (!wc) return null;
    const rate = fin(one.rate_lb_wk);
    return {
      domain: "body",
      kind: "weight",
      text: `Weight's 7-day average is ${weightWords(wc.avg_lb, units.weight)}, ${str(wc.words)}${rate != null ? ` — trending ${weightRateWords(rate, units.weight)}` : ""}.`,
      since: wc.since,
      direction: wc.delta_lb < 0 ? "down" : "up",
    };
  }
  const points = arr<{ date?: unknown; weight_lb?: unknown }>(inp.goalPace?.points)
    .map((p) => ({ date: dayOf(p?.date), w: fin(p?.weight_lb) }))
    .filter((p): p is { date: string; w: number } => p.date != null && p.w != null);
  const thisStart = addDays(today, -6);
  const priorStart = addDays(today, -13);
  const recent = points.filter((p) => p.date >= thisStart && p.date <= today);
  const prior = points.filter((p) => p.date >= priorStart && p.date < thisStart);
  if (recent.length < 2 || prior.length < 2) return null;
  const mean = (xs: { w: number }[]) => xs.reduce((s, x) => s + x.w, 0) / xs.length;
  const a = mean(recent);
  const b = mean(prior);
  const delta = a - b;
  if (Math.abs(delta) < WEIGHT_CHANGE_MIN_LB) return null;
  return {
    domain: "body",
    kind: "weight",
    text: `Weight's 7-day average is ${weightWords(a, units.weight)}, ${weightWords(Math.abs(delta), units.weight)} ${delta < 0 ? "lower" : "higher"} than the week before.`,
    since: priorStart,
    direction: delta < 0 ? "down" : "up",
  };
}

/**
 * What moved, each against a stated date. Ordered by how much it is news: a new best,
 * the race estimate, a fresh lab, the weight average, last week's running.
 */
export function focusChanges(inp: CoachingFocusInput, race: RaceRead | null): FocusChange[] {
  const today = readDate(inp);
  const out: FocusChange[] = [];
  // New bests this week (weekWins: one per lift, newest first).
  const units = unitsOfInput(inp);
  const prs = arr<{ exercise?: unknown; label?: unknown; weight_lb?: unknown; reps?: unknown }>(inp.weekWins?.prs).filter(
    (p) => str(p?.exercise)
  );
  if (prs.length) {
    // The set in the athlete's weight unit when the best carries it, else its own label.
    const setWords = (p: { label?: unknown; weight_lb?: unknown; reps?: unknown }): string => {
      const lb = fin(p.weight_lb);
      const reps = fin(p.reps);
      if (lb != null && lb > 0 && reps != null) return `${loadWords(lb, units.weight)} × ${reps}`;
      return str(p.label).replace(/\s*[—-]\s*new best\s*$/i, "");
    };
    const words = prs.slice(0, 2).map((p) => `${str(p.exercise)}${setWords(p) ? ` ${setWords(p)}` : ""}`);
    out.push({
      domain: "training",
      kind: "new_best",
      text: `New best${prs.length > 1 ? "s" : ""} this week: ${joinAnd(words)}${prs.length > 2 ? ` (+${prs.length - 2} more)` : ""}.`,
      since: today ? addDays(today, -6) : null,
      // A best is a value that went up, by definition.
      direction: "up",
    });
  }
  if (race?.trend && race.estimateSec != null && Math.abs(race.trend.deltaSec) >= 30) {
    out.push({
      domain: "running",
      kind: "race_estimate",
      text: `${cap(race.distanceName)} estimate ${gapWords(race.trend.deltaSec)} ${race.trend.deltaSec < 0 ? "faster" : "slower"}${race.trend.since ? ` ${sinceWords(race.trend.since, today)}` : ""} — now ${clock(race.estimateSec)}.`,
      since: race.trend.since,
      // The estimate is a TIME: faster is the clock moving down — the evidence bullet's
      // own direction for the same trend.
      direction: race.trend.deltaSec < 0 ? "down" : "up",
    });
  }
  if (today) {
    const lead = inp.healthFocus?.lead as HealthPriorityInput | null | undefined;
    const priorities = arr<HealthPriorityInput>(
      (inp.healthFocus as { priorities?: unknown } | null | undefined)?.priorities
    );
    const pool = [lead, ...priorities].filter(Boolean) as HealthPriorityInput[];
    const fresh = pool
      .flatMap((p) => arr<HealthReadingInput>(p.readings))
      .filter((r) => {
        const d = dayOf(r?.date);
        // Lab draws only — a wearable's weekly average (HRV) is not a new lab.
        const age = d != null ? daysBetweenISO(today, d) : null;
        return age != null && !str(r?.status_note) && age >= 0 && age <= NEW_LAB_DAYS;
      });
    const seen = new Set<string>();
    const uniq = fresh.filter((r) => {
      const k = lc(r.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (uniq.length) {
      const date = dayOf(uniq[0].date);
      // The readings the text names, by their own trend: one shared direction, else none.
      const named = uniq.slice(0, 2).map((r) => readingDirection(r.trend));
      const labDirection = named.every((dir) => dir != null && dir === named[0]) ? named[0] : null;
      out.push({
        domain: "health",
        kind: "new_lab",
        text: `New lab${date ? ` (${shortDate(date)})` : ""}: ${joinAnd(uniq.slice(0, 2).map(readingPhrase))}.`,
        since: date,
        direction: labDirection,
      });
    }
    const weight = weightChange(inp, today);
    if (weight) out.push(weight);
  }
  if (
    race?.lastClosed &&
    race.bestWeekKm != null &&
    race.lastClosed.km > 0 &&
    race.lastClosed.km >= race.bestWeekKm - 0.05
  ) {
    out.push({
      domain: "running",
      kind: "run_volume",
      text: `Last week's ${distanceWords(race.lastClosed.km, raceDist(race))} was your biggest running week of the last eight.`,
      since: race.lastClosed.weekStart,
      // The biggest week of the eight: the weekly volume went up.
      direction: "up",
    });
  }
  // Every change carries its window in words; `since` stays the machine date.
  return out
    .slice(0, CHANGES_MAX)
    .map((c) => ({ ...c, since_words: c.since ? sinceWords(c.since, today) || null : null }));
}
