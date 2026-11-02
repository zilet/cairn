// "BEHIND YOU" — every FINISHED goal, snapshotted once and looked back on once.
//
// A goal that is done is a story worth saying back: the half marathon just run, the
// squat objective completed, the goal weight reached. This module is the deterministic
// half of that — WHICH goals are finished, the FACTS each one is read from, and the
// store the agent's review is frozen into. The words themselves are the `goal_review`
// op's (src/coachOps/goal-review.ts); the list and the page are Horizon › Season.
//
// DETECTION (detectGoalReviews, idempotent, one row per (kind, ref_key)):
//   - race: every race kept in `completed_races` and the live goal's matched effort
//     (latestFinishedRace) — snapshotted as soon as the EFFORT is matched, not only when
//     the goal slot changes. ref_key `goal_date|distance_km`. One run is one race: two
//     goals resolving to the same run day keep the one nearest the run's distance.
//     `waiting` while the post-race recovery window is open (raceRecoverySpan, the same
//     window raceRecoveryWindow reads), then `pending` — and the facts are rebuilt ONCE
//     at that flip, so the recovery days are known when the review is written.
//   - strength_objective: a strength_objectives row with status 'completed' (never
//     'superseded'/'archived'). ref_key = its id. If the ledger REOPENS the objective
//     (a set correction took its evidence away) before the review froze, the unfrozen
//     row is dropped; a frozen review stays — what was written was true when written.
//   - weight_goal: the first `goal_reached` journey milestone (journey.ts). Snapshotted
//     the first time it is seen, so a later regain never erases it. ref_key
//     `goal_lb|date reached`.
//
// THE BUILD WINDOW (race facts). The weekly bars run Monday weeks from the build's
// start through race week. The start is the later of (a) RACE_BUILD_MAX_WEEKS (16)
// Mondays before race week and (b) the first week of the RUN-UP: walking back from
// race week, the run-up ends at the first stretch of RUN_UP_GAP_WEEKS (2) consecutive
// weeks with no running. So an athlete who started from nothing ten weeks out gets ten
// bars, and a year-round runner gets the last sixteen. The race's own kilometres are
// kept separate (stacked on race week), never counted as training.
//
// Everything here reads the engine's own reads — harm is runningHarmOnDay /
// the capacity read's set-aside weeks (run-capacity.ts), the held floor is
// preRaceRunCapacity, the recovery window is race-recovery.ts — never re-derived.
// Pure reads plus this module's own table; no agent, no network.
import { db } from "../db.js";
import { addDaysISO, daysBetweenISO, mondayOf } from "../lib/dates.js";
import { round1 } from "../lib/numbers.js";
import type {
  GoalReviewBuildChart,
  GoalReviewDetail,
  GoalReviewKind,
  GoalReviewLever,
  GoalReviewRow,
  GoalReviewStatus,
  GoalReviewText,
} from "../contracts/goal-reviews.js";
import type { BuildLeverFacts } from "./build-levers.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { nextMorningClean } from "./brain/read-adherence.js";
import {
  clockWords,
  dateWords,
  distanceValue,
  distanceWords,
  LB_PER_KG,
  loadWords,
  paceWords,
  raceDistanceName,
  weightWords,
  type AthleteUnits,
} from "./display-words.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { journeyMilestones, listJourneyPhases } from "./journey.js";
import { getEnduranceGoal, getProfile } from "./profile.js";
import { latestFinishedRace, raceRecoveryShape, raceRecoverySpan } from "./race-recovery.js";
import { completedRaceRows, pickRaceEffort, raceLikeRuns, raceRunActivity } from "./race-results.js";
import { demonstratedRunCapacity, preRaceRunCapacity, runningHarmOnDay, setAsideReason } from "./run-capacity.js";
import { athleteUnits } from "./settings.js";
import { localDateISO } from "./shared.js";
import { strengthObjectiveHistory } from "./strength-objectives.js";

/** The most weeks a race build's bars reach back from race week. */
export const RACE_BUILD_MAX_WEEKS = 16;
/** Consecutive weeks with no running that end the run-up (walking back from the race). */
export const RUN_UP_GAP_WEEKS = 2;
/** A review is attempted at most this many times; a failed row is retried on later nights. */
export const GOAL_REVIEW_MAX_ATTEMPTS = 3;
/** Levers are proposed only off the latest race, and only while it is this recent. */
export const LEVER_REVIEW_MAX_DAYS = 120;
/** How far back a finished race is looked for on the live goal (the kept rows cover the rest). */
const LIVE_RACE_LOOKBACK_DAYS = 3650;

export const WAITING_LINE = "Looked back on once the recovery days are done";

// ---------- facts ----------

export interface RaceWeekFact {
  week_start: string;
  /** Training km that week — the race's own km never in it. */
  km: number;
  /** The race's own km: race week only. */
  race_km: number;
  /** The capacity read set this week's volume aside (the body paid for it). */
  set_aside: boolean;
}

export interface RaceReviewFacts {
  kind: "race";
  v: 1;
  event: string | null;
  goal_date: string;
  race_date: string;
  distance_km: number;
  activity_id: number | null;
  /** The logged race run: distance, finish time, pace. Time/pace null without a duration. */
  result: { km: number; finish_sec: number | null; pace_sec_per_km: number | null };
  /** What the athlete said they were aiming at — CONTEXT only, never a yardstick. */
  target_text: string | null;
  build: { start: string; weeks: RaceWeekFact[]; training_km: number };
  /** The longest training run before the race (the race excluded), and whether it was taken well. */
  longest_run: { date: string; km: number; pace_sec_per_km: number | null; clean: boolean } | null;
  capacity: {
    /** The best harm-free closed week going into the race (preRaceRunCapacity). */
    held_week_km: number | null;
    /** The biggest training week of the build, harmed or not. */
    best_week_km: number | null;
    best_week_start: string | null;
    /** Bigger weeks the capacity read set aside, with the plain-word reason. */
    set_aside: { week_start: string; km: number; reason: string }[];
  };
  /** Race pace minus the longest run's pace, sec/km (negative: the race ran faster). */
  pace_vs_long_run_sec_per_km: number | null;
  /** The taper: race week's km before race day, against the week before. */
  taper: { race_week_km_before_race: number; week_before_km: number | null };
  recovery: {
    /** The window the engine applies (race-recovery.ts), in days. */
    expected_days: number;
    ends_on: string | null;
    back_on: string | null;
    /** Days from race day to the first clean morning (null: no clean morning read yet). */
    recovery_days: number | null;
    /** True once the window has passed and the facts were rebuilt. */
    settled: boolean;
  };
  lifting: { sessions: number; weeks: number; race_week_sessions: number; lifts: string[] };
  build_lever_facts: BuildLeverFacts;
}

export interface StrengthReviewFacts {
  kind: "strength_objective";
  v: 1;
  objective_id: number;
  exercise: string;
  target_kind: string;
  target_est_1rm: number;
  baseline_est_1rm: number | null;
  baseline_date: string | null;
  started_on: string | null;
  achieved_est_1rm: number | null;
  achieved_date: string;
  /** Exposures (one per session date) between the start and the day it was reached. */
  exposures: number;
  weeks: number | null;
  first: { date: string; top_weight: number; top_reps: number; est_1rm: number } | null;
  last: { date: string; top_weight: number; top_reps: number; est_1rm: number } | null;
}

export interface WeightReviewFacts {
  kind: "weight_goal";
  v: 1;
  goal_lb: number;
  start_lb: number | null;
  start_date: string | null;
  achieved_lb: number | null;
  achieved_date: string;
  weeks: number | null;
  rate_lb_per_week: number | null;
  weigh_ins: number;
  phases: { kind: string; start_date: string | null; end_date: string | null; status: string }[];
}

export type GoalReviewFacts = RaceReviewFacts | StrengthReviewFacts | WeightReviewFacts;

/** The agent's review as stored (review_json): the text, plus what the levers came to. */
export interface StoredGoalReview extends GoalReviewText {
  levers?: { key: string; value: number; because: string }[];
  levers_result?: {
    accepted: { key: string; value: number; because: string; clamped_from?: number }[];
    rejected: { key: string; reason: string }[];
    decision_id: number | null;
    /**
     * Levers that held up but were NOT adopted (the athlete's lead mode asks first and a
     * lever set has no approve door) — never shown as carried forward.
     */
    parked?: { key: string; value: number; because: string; clamped_from?: number }[];
    error?: string;
  } | null;
  source?: "agent" | "stub";
}

export interface GoalReviewRecord {
  id: number;
  kind: GoalReviewKind;
  ref_key: string;
  title: string;
  achieved_on: string;
  facts: GoalReviewFacts;
  status: GoalReviewStatus;
  review: StoredGoalReview | null;
  agent: string | null;
  attempts: number;
  last_error: string | null;
  reviewed_at: string | null;
  frozen_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- small reads ----------

function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

function hydrate(row: any): GoalReviewRecord | null {
  if (!row) return null;
  const facts = parseJson<GoalReviewFacts>(row.facts_json);
  if (!facts) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    ref_key: String(row.ref_key),
    title: String(row.title),
    achieved_on: String(row.achieved_on).slice(0, 10),
    facts,
    status: row.status,
    review: parseJson<StoredGoalReview>(row.review_json),
    agent: row.agent ?? null,
    attempts: Number(row.attempts) || 0,
    last_error: row.last_error ?? null,
    reviewed_at: row.reviewed_at ?? null,
    frozen_at: row.frozen_at ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

/** One stored review, raw (facts and review parsed). Null when absent. */
export function goalReviewRecord(id: number): GoalReviewRecord | null {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return hydrate(db.prepare(`SELECT * FROM goal_reviews WHERE id = ?`).get(n));
}

/** Every stored review, newest achieved first. */
export function goalReviewRecords(): GoalReviewRecord[] {
  return (db.prepare(`SELECT * FROM goal_reviews ORDER BY achieved_on DESC, id DESC`).all() as any[])
    .map(hydrate)
    .filter((r): r is GoalReviewRecord => !!r);
}

function findRow(kind: GoalReviewKind, refKey: string): { id: number; frozen_at: string | null; status: string } | null {
  return (
    (db.prepare(`SELECT id, frozen_at, status FROM goal_reviews WHERE kind = ? AND ref_key = ?`).get(kind, refKey) as
      | { id: number; frozen_at: string | null; status: string }
      | undefined) ?? null
  );
}

function insertRow(input: {
  kind: GoalReviewKind;
  ref_key: string;
  title: string;
  achieved_on: string;
  facts: GoalReviewFacts;
  status: GoalReviewStatus;
}): boolean {
  const info = db
    .prepare(
      `INSERT INTO goal_reviews (kind, ref_key, title, achieved_on, facts_json, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, ref_key) DO NOTHING`
    )
    .run(input.kind, input.ref_key, input.title.slice(0, 160), input.achieved_on, JSON.stringify(input.facts), input.status);
  return Number(info.changes) > 0;
}

interface RunRow {
  id: number;
  date: string;
  km: number;
  duration_min: number | null;
}

function runsBetween(from: string, to: string): RunRow[] {
  try {
    const sport = activitySportWhere("activities", RUN_SPORT_PATTERNS);
    const rows = db
      .prepare(
        `SELECT id, date, type, source, external_id, duration_min, distance_km FROM activities
          WHERE date >= ? AND date <= ? AND distance_km > 0 AND (${sport.sql})
          ORDER BY date, id`
      )
      .all(from, to, ...sport.params) as any[];
    return withoutShadowActivities(rows)
      .map((r: any) => ({
        id: Number(r.id),
        date: String(r.date).slice(0, 10),
        km: Number(r.distance_km),
        duration_min: Number(r.duration_min) > 0 ? Number(r.duration_min) : null,
      }))
      .filter((r) => Number.isFinite(r.km) && r.km > 0);
  } catch {
    return [];
  }
}

const paceOf = (r: { km: number; duration_min: number | null }): number | null =>
  r.duration_min != null && r.km > 0 ? Math.round((r.duration_min * 60) / r.km) : null;

// ---------- race facts ----------

/** The build's first Monday: the later of the 16-week cap and the run-up's start. */
export function raceBuildStart(raceDate: string, runs: readonly { date: string; km: number }[]): string {
  const raceWeek = mondayOf(raceDate);
  const cap = addDaysISO(raceWeek, -7 * (RACE_BUILD_MAX_WEEKS - 1)) ?? raceWeek;
  const ran = new Set(runs.filter((r) => r.km > 0 && r.date < raceDate).map((r) => mondayOf(r.date)));
  let start = raceWeek;
  let gap = 0;
  for (let wk = addDaysISO(raceWeek, -7); wk && wk >= cap; wk = addDaysISO(wk, -7)) {
    if (ran.has(wk)) {
      start = wk;
      gap = 0;
    } else if (++gap >= RUN_UP_GAP_WEEKS) {
      break;
    }
  }
  return start;
}

function liftingDuring(from: string, to: string, raceWeek: string): RaceReviewFacts["lifting"] {
  try {
    const days = (
      db
        .prepare(
          `SELECT DISTINCT s.date AS date FROM sessions s
            WHERE s.date >= ? AND s.date <= ?
              AND EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id)`
        )
        .all(from, to) as { date: string }[]
    ).map((r) => String(r.date).slice(0, 10));
    const lifts = (
      db
        .prepare(
          `SELECT e.name AS name, COUNT(DISTINCT s.date) AS n FROM logged_sets ls
             JOIN sessions s ON s.id = ls.session_id JOIN exercises e ON e.id = ls.exercise_id
            WHERE s.date >= ? AND s.date <= ?
            GROUP BY e.id ORDER BY n DESC, e.name LIMIT 3`
        )
        .all(from, to) as { name: string }[]
    ).map((r) => String(r.name));
    const weeks = Math.max(1, Math.round(((daysBetweenISO(to, from) ?? 0) + 1) / 7));
    return { sessions: days.length, weeks, race_week_sessions: days.filter((d) => d >= raceWeek).length, lifts };
  } catch {
    return { sessions: 0, weeks: 0, race_week_sessions: 0, lifts: [] };
  }
}

/** Days from race day to the first morning that read clean (silence never vouches). */
function recoveryDaysAfter(raceDate: string, today: string): number | null {
  for (let k = 1; k <= 14; k++) {
    const morning = addDaysISO(raceDate, k);
    if (!morning || morning > today) return null;
    const eve = addDaysISO(raceDate, k - 1);
    try {
      if (eve && nextMorningClean(eve)) return k;
    } catch {
      return null;
    }
  }
  return null;
}

export interface RaceRef {
  goal_date: string;
  distance_km: number;
  event: string | null;
  run_date: string;
  activity_id: number | null;
  run_km: number | null;
}

/** The race's deterministic facts, as known on `today`. */
export function buildRaceFacts(race: RaceRef, today: string = localDateISO()): RaceReviewFacts {
  const raceDate = race.run_date;
  const raceWeek = mondayOf(raceDate);
  const lookback = addDaysISO(raceWeek, -7 * (RACE_BUILD_MAX_WEEKS + RUN_UP_GAP_WEEKS)) ?? raceWeek;
  const raceSunday = addDaysISO(raceWeek, 6) ?? raceDate;
  const runs = runsBetween(lookback, raceSunday);
  const raceRun =
    (race.activity_id != null ? runs.find((r) => r.id === race.activity_id) : null) ??
    runs.filter((r) => r.date === raceDate).sort((a, b) => b.km - a.km)[0] ??
    null;
  const logged = raceRunActivity(race.activity_id);
  const resultKm = logged?.km ?? raceRun?.km ?? race.run_km ?? race.distance_km;
  const finishMin = logged?.duration_min ?? raceRun?.duration_min ?? null;
  const finishSec = finishMin != null ? Math.round(finishMin * 60) : null;
  const racePace = finishSec != null && resultKm > 0 ? Math.round(finishSec / resultKm) : null;
  // Training only: the race run itself never counts as a week's volume or the longest run.
  const training = runs.filter((r) => r !== raceRun && r.date <= raceSunday);

  const start = raceBuildStart(raceDate, training);
  const capacity = demonstratedRunCapacity(raceDate);
  const setAsideWeeks = new Set(capacity.set_aside.map((w) => w.week_start));
  const weeks: RaceWeekFact[] = [];
  for (let wk: string | null = start; wk && wk <= raceWeek; wk = addDaysISO(wk, 7)) {
    const end = addDaysISO(wk, 6) ?? wk;
    const km = training.filter((r) => r.date >= wk! && r.date <= end).reduce((s, r) => s + r.km, 0);
    weeks.push({
      week_start: wk,
      km: round1(km),
      race_km: wk === raceWeek ? round1(resultKm) : 0,
      set_aside: setAsideWeeks.has(wk),
    });
  }
  const buildWeeks = weeks.filter((w) => w.week_start < raceWeek);
  const best = buildWeeks.reduce<RaceWeekFact | null>((b, w) => (!b || w.km > b.km ? w : b), null);

  const before = training.filter((r) => r.date >= start && r.date < raceDate);
  const longest = [...before].sort((a, b) => b.km - a.km || b.date.localeCompare(a.date))[0] ?? null;
  const longestClean = longest ? runningHarmOnDay(longest.date) == null : false;
  // A RAISE of the long-run ceiling stands on positive evidence: no harm on the day AND a
  // next morning that spoke and spoke clean (nextMorningClean — absent data never vouches).
  const longestVouched = longest ? longestClean && safeVouch(longest.date) : false;
  const longPace = longest ? paceOf(longest) : null;

  const held = preRaceRunCapacity(raceDate);
  const weekBefore = weeks.find((w) => w.week_start === addDaysISO(raceWeek, -7)) ?? null;
  const raceWeekBeforeRace = training
    .filter((r) => r.date >= raceWeek && r.date < raceDate)
    .reduce((s, r) => s + r.km, 0);

  const shape = raceRecoveryShape(race.distance_km);
  const span = raceRecoverySpan({ run_date: raceDate, distance_km: race.distance_km });
  const endsOn = span?.to ?? null;
  const backOn = endsOn ? addDaysISO(endsOn, 1) : null;
  const settled = !!endsOn && today > endsOn;
  const recoveryDays = recoveryDaysAfter(raceDate, today);

  let targetText: string | null = null;
  try {
    const goal = getEnduranceGoal(today);
    if (goal?.date && String(goal.date).slice(0, 10) === race.goal_date && goal.target) targetText = String(goal.target);
  } catch {
    targetText = null;
  }

  const setAside = capacity.set_aside
    .filter((w) => w.week_start >= start && w.week_start <= raceWeek)
    .map((w) => ({ week_start: w.week_start, km: w.km, reason: setAsideReason(w.harm) }));

  const facts: RaceReviewFacts = {
    kind: "race",
    v: 1,
    event: race.event,
    goal_date: race.goal_date,
    race_date: raceDate,
    distance_km: race.distance_km,
    activity_id: race.activity_id ?? raceRun?.id ?? null,
    result: { km: round1(resultKm), finish_sec: finishSec, pace_sec_per_km: racePace },
    target_text: targetText,
    build: { start, weeks, training_km: round1(buildWeeks.reduce((s, w) => s + w.km, 0)) },
    longest_run: longest
      ? { date: longest.date, km: round1(longest.km), pace_sec_per_km: longPace, clean: longestClean }
      : null,
    capacity: {
      held_week_km: held.floor_km,
      best_week_km: best ? best.km : null,
      best_week_start: best ? best.week_start : null,
      set_aside: setAside,
    },
    pace_vs_long_run_sec_per_km: racePace != null && longPace != null ? racePace - longPace : null,
    taper: { race_week_km_before_race: round1(raceWeekBeforeRace), week_before_km: weekBefore ? weekBefore.km : null },
    recovery: {
      expected_days: shape?.days ?? 0,
      ends_on: endsOn,
      back_on: backOn,
      recovery_days: recoveryDays,
      settled,
    },
    lifting: liftingDuring(start, raceDate, raceWeek),
    build_lever_facts: {
      race_date: raceDate,
      race_distance_km: race.distance_km,
      held_week_km: held.floor_km,
      best_week_km: best ? best.km : null,
      harmed_weeks: setAside.length,
      longest_run_km: longest ? round1(longest.km) : null,
      longest_run_clean: longestVouched,
      recovery_days: settled ? recoveryDays : null,
      expected_recovery_days: shape?.days ?? 0,
    },
  };
  return facts;
}

// ---------- strength / weight facts ----------

function isoOf(v: unknown): string | null {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function buildStrengthFacts(o: any): StrengthReviewFacts {
  const achieved = isoOf(o.achieved_date) ?? isoOf(o.completed_at) ?? localDateISO();
  const started = isoOf(o.created_at) ?? isoOf(o.baseline_date);
  let history: { date: string; top_weight: number; top_reps: number; est_1rm: number }[] = [];
  try {
    history = strengthObjectiveHistory(String(o.exercise));
  } catch {
    history = [];
  }
  const span = history.filter((p) => (!started || p.date >= started) && p.date <= achieved);
  const weeks = started ? Math.max(0, Math.round((daysBetweenISO(achieved, started) ?? 0) / 7)) : null;
  return {
    kind: "strength_objective",
    v: 1,
    objective_id: Number(o.id),
    exercise: String(o.exercise),
    target_kind: String(o.target_kind),
    target_est_1rm: Number(o.target_est_1rm),
    baseline_est_1rm: o.baseline_est_1rm == null ? null : Number(o.baseline_est_1rm),
    baseline_date: isoOf(o.baseline_date),
    started_on: started,
    achieved_est_1rm: o.achieved_est_1rm == null ? null : Number(o.achieved_est_1rm),
    achieved_date: achieved,
    exposures: span.length,
    weeks,
    first: span[0] ?? null,
    last: span.at(-1) ?? null,
  };
}

export function buildWeightFacts(input: {
  goal_lb: number;
  achieved_date: string;
  achieved_lb: number | null;
}): WeightReviewFacts {
  const p = getProfile() ?? {};
  const startLb = Number(p.start_weight_lb);
  const startDate = isoOf(p.start_date);
  const weeks = startDate ? Math.max(0, (daysBetweenISO(input.achieved_date, startDate) ?? 0) / 7) : null;
  const rate =
    Number.isFinite(startLb) && input.achieved_lb != null && weeks && weeks >= 1
      ? Math.round(((startLb - input.achieved_lb) / weeks) * 10) / 10
      : null;
  let weighIns = 0;
  try {
    weighIns = Number(
      (
        db
          .prepare(`SELECT COUNT(DISTINCT date) AS n FROM bodyweight_log WHERE date >= ? AND date <= ?`)
          .get(startDate ?? "0000-01-01", input.achieved_date) as { n?: number }
      )?.n ?? 0
    );
  } catch {
    weighIns = 0;
  }
  let phases: WeightReviewFacts["phases"] = [];
  try {
    phases = (listJourneyPhases("all") as any[])
      .filter((ph) => ph && ph.status !== "discarded" && ph.status !== "proposed")
      .filter((ph) => {
        const s = isoOf(ph.start_date);
        const e = isoOf(ph.end_date);
        return (!s || s <= input.achieved_date) && (!e || !startDate || e >= startDate);
      })
      .map((ph) => ({
        kind: String(ph.kind),
        start_date: isoOf(ph.start_date),
        end_date: isoOf(ph.end_date),
        status: String(ph.status),
      }))
      .reverse();
  } catch {
    phases = [];
  }
  return {
    kind: "weight_goal",
    v: 1,
    goal_lb: input.goal_lb,
    start_lb: Number.isFinite(startLb) ? startLb : null,
    start_date: startDate,
    achieved_lb: input.achieved_lb,
    achieved_date: input.achieved_date,
    weeks: weeks != null ? Math.round(weeks) : null,
    rate_lb_per_week: rate,
    weigh_ins: weighIns,
    phases,
  };
}

// ---------- detection ----------

function raceRefKey(goalDate: string, distanceKm: number): string {
  return `${goalDate}|${Number(distanceKm)}`;
}

/** Every finished race (a matched effort), one per run day, as known on `today`. */
export function finishedRaces(today: string = localDateISO()): RaceRef[] {
  const out: RaceRef[] = [];
  for (const row of completedRaceRows()) {
    if (!(row.distance_km > 0)) continue;
    if (row.run_date) {
      if (row.run_date > today) continue;
      out.push({ ...row, run_date: row.run_date, run_km: row.run_km });
      continue;
    }
    const ref = { goal_date: row.goal_date, distance_km: row.distance_km, event: row.event };
    const run = pickRaceEffort(ref, raceLikeRuns(ref), today);
    if (run) out.push({ ...ref, run_date: run.date, activity_id: run.activity_id, run_km: run.km });
  }
  try {
    const live = latestFinishedRace(today, LIVE_RACE_LOOKBACK_DAYS);
    if (live && !live.provisional) {
      out.push({
        goal_date: live.goal_date,
        distance_km: live.distance_km,
        event: live.event,
        run_date: live.run_date,
        activity_id: live.activity_id,
        run_km: live.run_km,
      });
    }
  } catch {
    /* no live race */
  }
  // One run is one race: the candidate nearest the run's own distance wins the day.
  const byDay = new Map<string, RaceRef>();
  const fit = (r: RaceRef) => Math.abs((r.run_km ?? r.distance_km) - r.distance_km);
  for (const r of out) {
    const held = byDay.get(r.run_date);
    if (!held || fit(r) < fit(held)) byDay.set(r.run_date, r);
  }
  return [...byDay.values()].sort((a, b) => a.run_date.localeCompare(b.run_date));
}

function raceStatusOn(race: { run_date: string; distance_km: number }, today: string): GoalReviewStatus {
  const span = raceRecoverySpan(race);
  return span && today <= span.to ? "waiting" : "pending";
}

function raceTitle(race: { event: string | null; distance_km: number }, units: AthleteUnits): string {
  return race.event?.trim() || raceDistanceName(race.distance_km, units.distance);
}

export interface GoalReviewDetection {
  created: number;
  dropped: number;
  settled: number;
}

/**
 * Snapshot every finished goal not yet snapshotted, drop an unfrozen strength review
 * whose objective the ledger reopened, and flip a race out of `waiting` once its
 * recovery window has passed (its facts rebuilt once, so the recovery is known).
 * Idempotent: the rows ARE the state. Each kind is fail-soft on its own.
 */
export function detectGoalReviews(today: string = localDateISO()): GoalReviewDetection {
  const d = String(today).slice(0, 10);
  const units = athleteUnits();
  let created = 0;
  let dropped = 0;

  try {
    for (const race of finishedRaces(d)) {
      const key = raceRefKey(race.goal_date, race.distance_km);
      if (findRow("race", key)) continue;
      // The same run already reviewed under another goal key (a goal corrected after the race).
      const sameRun = db
        .prepare(`SELECT 1 FROM goal_reviews WHERE kind = 'race' AND json_extract(facts_json, '$.race_date') = ?`)
        .get(race.run_date);
      if (sameRun) continue;
      const facts = buildRaceFacts(race, d);
      const status = raceStatusOn(race, d);
      if (status === "pending") facts.recovery.settled = true;
      if (insertRow({ kind: "race", ref_key: key, title: raceTitle(race, units), achieved_on: race.run_date, facts, status }))
        created++;
    }
  } catch {
    /* races are best-effort: the other kinds still run */
  }

  try {
    const done = db
      .prepare(`SELECT * FROM strength_objectives WHERE status = 'completed' ORDER BY id`)
      .all() as any[];
    for (const o of done) {
      const key = String(o.id);
      if (findRow("strength_objective", key)) continue;
      const facts = buildStrengthFacts(o);
      const title = `${String(o.exercise)} ${loadWords(Number(o.target_est_1rm), units.weight)}`;
      if (insertRow({ kind: "strength_objective", ref_key: key, title, achieved_on: facts.achieved_date, facts, status: "pending" }))
        created++;
    }
    // A reopened objective (the ledger took its evidence back) loses its UNFROZEN review.
    const info = db
      .prepare(
        `DELETE FROM goal_reviews
          WHERE kind = 'strength_objective' AND frozen_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM strength_objectives so
               WHERE CAST(so.id AS TEXT) = goal_reviews.ref_key AND so.status = 'completed'
            )`
      )
      .run();
    dropped += Number(info.changes) || 0;
  } catch {
    /* strength is best-effort */
  }

  try {
    const reached = journeyMilestones(d).find((m) => m.kind === "goal_reached");
    const p = getProfile();
    const goalLb = Number(p?.goal_weight_lb ?? NaN);
    if (reached?.achieved_date && Number.isFinite(goalLb)) {
      const key = `${goalLb}|${reached.achieved_date}`;
      const already = db
        .prepare(`SELECT 1 FROM goal_reviews WHERE kind = 'weight_goal' AND ref_key LIKE ?`)
        .get(`${goalLb}|%`);
      if (!already) {
        const achievedLb = weighInOn(reached.achieved_date) ?? reached.value ?? null;
        const facts = buildWeightFacts({ goal_lb: goalLb, achieved_date: reached.achieved_date, achieved_lb: achievedLb });
        const title = `Goal weight ${weightWords(goalLb, units.weight, { whole: true })}`;
        if (insertRow({ kind: "weight_goal", ref_key: key, title, achieved_on: reached.achieved_date, facts, status: "pending" }))
          created++;
      }
    }
  } catch {
    /* weight is best-effort */
  }

  const settled = settleWaitingGoalReviews(d);
  return { created, dropped, settled };
}

function weighInOn(date: string): number | null {
  try {
    const row = db
      .prepare(`SELECT weight_lb FROM bodyweight_log WHERE date = ? ORDER BY id DESC LIMIT 1`)
      .get(date) as { weight_lb?: number } | undefined;
    const lb = Number(row?.weight_lb);
    return Number.isFinite(lb) ? lb : null;
  } catch {
    return null;
  }
}

/** Waiting races whose recovery window has passed → pending, with their facts rebuilt once. */
export function settleWaitingGoalReviews(today: string = localDateISO()): number {
  let n = 0;
  const rows = (db.prepare(`SELECT * FROM goal_reviews WHERE status = 'waiting'`).all() as any[])
    .map(hydrate)
    .filter((r): r is GoalReviewRecord => !!r);
  for (const row of rows) {
    if (row.facts.kind !== "race") continue;
    const f = row.facts;
    if (raceStatusOn({ run_date: f.race_date, distance_km: f.distance_km }, today) !== "pending") continue;
    let facts: RaceReviewFacts;
    try {
      facts = buildRaceFacts(
        {
          goal_date: f.goal_date,
          distance_km: f.distance_km,
          event: f.event,
          run_date: f.race_date,
          activity_id: f.activity_id,
          run_km: f.result.km,
        },
        today
      );
      facts.target_text = facts.target_text ?? f.target_text;
    } catch {
      facts = f;
    }
    facts.recovery.settled = true;
    db.prepare(
      `UPDATE goal_reviews SET status = 'pending', facts_json = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'waiting'`
    ).run(JSON.stringify(facts), row.id);
    n++;
  }
  return n;
}

// ---------- review lifecycle ----------

function attemptedOn(row: GoalReviewRecord): string | null {
  if (!row.attempts && !row.reviewed_at) return null;
  const stamp = row.reviewed_at ?? row.updated_at;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? localDateISO(new Date(t)) : null;
}

/** True when a review was attempted (written or failed) on `today` — the one-a-night gate. */
export function goalReviewAttemptedOn(today: string = localDateISO()): boolean {
  return goalReviewRecords().some(
    (r) => (r.status === "ready" || r.status === "failed") && (r.attempts > 0 || r.reviewed_at) && attemptedOn(r) === today
  );
}

/**
 * The next row to review: the OLDEST achieved pending row, or a failed one still under
 * its attempt cap. Null when nothing waits (or a review was already attempted today).
 */
export function nextGoalReviewDue(today: string = localDateISO()): GoalReviewRecord | null {
  if (goalReviewAttemptedOn(today)) return null;
  return (
    hydrate(
      db
        .prepare(
          `SELECT * FROM goal_reviews
            WHERE frozen_at IS NULL
              AND (status = 'pending' OR (status = 'failed' AND attempts < ?))
            ORDER BY achieved_on ASC, id ASC LIMIT 1`
        )
        .get(GOAL_REVIEW_MAX_ATTEMPTS)
    ) ?? null
  );
}

/** Save the agent's review and FREEZE the row: a frozen review is never rewritten. */
export function saveGoalReview(id: number, review: StoredGoalReview, agent: string | null, at: Date = new Date()): boolean {
  const now = at.toISOString();
  const info = db
    .prepare(
      `UPDATE goal_reviews
          SET review_json = ?, status = 'ready', agent = ?, attempts = attempts + 1, last_error = NULL,
              reviewed_at = ?, frozen_at = ?, updated_at = ?
        WHERE id = ? AND frozen_at IS NULL`
    )
    .run(JSON.stringify(review), agent, now, now, now, Number(id));
  return Number(info.changes) > 0;
}

/** What the levers came to, recorded onto an already-frozen review (the one write after freeze). */
function safeVouch(date: string): boolean {
  try {
    return nextMorningClean(date);
  } catch {
    return false;
  }
}

export function saveGoalReviewLeversResult(id: number, result: StoredGoalReview["levers_result"]): void {
  const row = goalReviewRecord(id);
  if (!row?.review) return;
  db.prepare(`UPDATE goal_reviews SET review_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify({ ...row.review, levers_result: result }),
    new Date().toISOString(),
    Number(id)
  );
}

/** One failed attempt: status failed, attempts++, the reason kept. Never on a frozen row. */
export function recordGoalReviewFailure(id: number, error: string, at: Date = new Date()): void {
  db.prepare(
    `UPDATE goal_reviews SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE id = ? AND frozen_at IS NULL`
  ).run(String(error).slice(0, 300), at.toISOString(), Number(id));
}

/**
 * Whether this race review may propose levers for the next build: only the LATEST race
 * (no later race snapshotted) and only while it is recent — an old race backfilled
 * months later says what it taught, but it does not reshape today's engine.
 */
export function raceLeversEligible(row: GoalReviewRecord, today: string = localDateISO()): boolean {
  if (row.facts.kind !== "race") return false;
  const raceDate = row.facts.race_date;
  const age = daysBetweenISO(today, raceDate);
  if (age == null || age < 0 || age > LEVER_REVIEW_MAX_DAYS) return false;
  const later = db
    .prepare(`SELECT 1 FROM goal_reviews WHERE kind = 'race' AND id != ? AND achieved_on > ? LIMIT 1`)
    .get(row.id, row.achieved_on);
  return !later;
}

// ---------- words (read time, the athlete's current units) ----------

function resultLine(row: GoalReviewRecord, units: AthleteUnits): string {
  const f = row.facts;
  if (f.kind === "race") {
    const dist = distanceWords(f.result.km, units.distance);
    return [
      f.result.finish_sec != null ? `${dist} in ${clockWords(f.result.finish_sec)}` : dist,
      f.result.pace_sec_per_km != null ? paceWords(f.result.pace_sec_per_km, units.distance, { spaced: true }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (f.kind === "strength_objective") {
    const reached = f.achieved_est_1rm ?? f.target_est_1rm;
    const from = f.baseline_est_1rm ?? f.first?.est_1rm ?? null;
    return [
      `Estimated max ${loadWords(round1(reached), units.weight)}`,
      from != null ? `from ${loadWords(round1(from), units.weight)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const at = f.achieved_lb ?? f.goal_lb;
  return [
    weightWords(at, units.weight),
    f.start_lb != null ? `from ${weightWords(f.start_lb, units.weight)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The plain fact lines under the hero — measures, never grades. */
export function goalReviewFactLines(row: GoalReviewRecord, units: AthleteUnits, today: string = localDateISO()): string[] {
  const f = row.facts;
  const dw = (iso: string | null | undefined) => dateWords(iso, today);
  const lines: string[] = [];
  if (f.kind === "race") {
    const km = (n: number) => distanceWords(n, units.distance);
    if (f.longest_run) {
      lines.push(
        `Longest run before the race: ${km(f.longest_run.km)} on ${dw(f.longest_run.date)}${
          f.longest_run.clean ? ", taken well" : ", and the morning after was a hard one"
        }.`
      );
    }
    if (f.capacity.best_week_km != null && f.capacity.best_week_km > 0) {
      const held =
        f.capacity.held_week_km != null && f.capacity.held_week_km > 0 && f.capacity.held_week_km !== f.capacity.best_week_km
          ? `; the week the build held without cost was ${km(f.capacity.held_week_km)}`
          : "";
      lines.push(`Biggest week of the build: ${km(f.capacity.best_week_km)}${held}.`);
    }
    if (f.taper.week_before_km != null) {
      lines.push(
        `Race week before race day: ${km(f.taper.race_week_km_before_race)}, after ${km(f.taper.week_before_km)} the week before.`
      );
    }
    if (f.result.pace_sec_per_km != null && f.longest_run?.pace_sec_per_km != null) {
      lines.push(
        `Race pace ${paceWords(f.result.pace_sec_per_km, units.distance, { spaced: true })}; the longest run went at ${paceWords(
          f.longest_run.pace_sec_per_km,
          units.distance,
          { spaced: true }
        )}.`
      );
    }
    if (f.recovery.ends_on) {
      lines.push(
        row.status === "waiting"
          ? `Recovery days through ${dw(f.recovery.ends_on)}.`
          : `${f.recovery.expected_days} recovery days, full training again ${dw(f.recovery.back_on)}.`
      );
    }
    if (f.lifting.sessions > 0) {
      lines.push(
        `Lifting through the build: ${f.lifting.sessions} ${f.lifting.sessions === 1 ? "session" : "sessions"} over ${f.lifting.weeks} ${
          f.lifting.weeks === 1 ? "week" : "weeks"
        }.`
      );
    }
    return lines;
  }
  if (f.kind === "strength_objective") {
    if (f.started_on) lines.push(`Chosen ${dw(f.started_on)}, reached ${dw(f.achieved_date)}.`);
    if (f.exposures > 0)
      lines.push(`${f.exposures} ${f.exposures === 1 ? "session" : "sessions"} with ${f.exercise} on the way.`);
    if (f.last) {
      lines.push(
        `The set that reached it: ${loadWords(f.last.top_weight, units.weight)} for ${f.last.top_reps} on ${dw(f.last.date)}.`
      );
    }
    return lines;
  }
  if (f.start_date && f.start_lb != null)
    lines.push(`From ${weightWords(f.start_lb, units.weight)} on ${dw(f.start_date)} to ${dw(f.achieved_date)}.`);
  if (f.rate_lb_per_week != null && f.weeks != null) {
    const rate = units.weight === "kg" ? round1(f.rate_lb_per_week / LB_PER_KG) : f.rate_lb_per_week;
    lines.push(`About ${rate} ${units.weight} a week across ${f.weeks} weeks.`);
  }
  if (f.phases.length) {
    const kinds = [...new Set(f.phases.map((p) => p.kind.replace(/_/g, " ")))];
    lines.push(`Phases along the way: ${kinds.join(", ")}.`);
  }
  return lines;
}

function buildChart(row: GoalReviewRecord, units: AthleteUnits): GoalReviewBuildChart | null {
  if (row.facts.kind !== "race" || !row.facts.build.weeks.length) return null;
  const u = units.distance;
  const weeks = row.facts.build.weeks.map((w) => {
    const value = distanceValue(w.km, u);
    const raceValue = w.race_km > 0 ? distanceValue(w.race_km, u) : 0;
    const raceWeek = w.race_km > 0;
    return {
      week_start: w.week_start,
      label: dateWords(w.week_start, w.week_start),
      value,
      race_value: raceValue,
      race_week: raceWeek,
      set_aside: w.set_aside,
      words: `${distanceWords(w.km, u)}${raceWeek ? ` · race ${distanceWords(w.race_km, u)}` : ""}`,
    };
  });
  const max = weeks.reduce((m, w) => Math.max(m, w.value + w.race_value), 0);
  return { units: u, weeks, max_value: round1(max) };
}

function leversOf(row: GoalReviewRecord): { levers: GoalReviewLever[]; undoable: boolean } {
  try {
    const rows = db
      .prepare(`SELECT key, value, because, status FROM build_levers WHERE source_review_id = ? ORDER BY id`)
      .all(row.id) as any[];
    const levers = rows.map((r) => ({
      key: String(r.key),
      value: Number(r.value),
      because: String(r.because),
      status: (["active", "superseded", "reverted"].includes(r.status) ? r.status : "active") as GoalReviewLever["status"],
    }));
    return { levers, undoable: levers.some((l) => l.status === "active") };
  } catch {
    return { levers: [], undoable: false };
  }
}

function rowLine(row: GoalReviewRecord): string | null {
  if (row.status === "waiting") return WAITING_LINE;
  if (row.status === "ready" && row.review?.headline) return row.review.headline;
  return null;
}

export function goalReviewRow(row: GoalReviewRecord, units: AthleteUnits = athleteUnits(), today = localDateISO()): GoalReviewRow {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    achieved_on: row.achieved_on,
    date_text: dateWords(row.achieved_on, today, "weekday"),
    status: row.status,
    result_line: resultLine(row, units),
    line: rowLine(row),
  };
}

/** GET /api/goal-reviews: every finished goal, newest first. */
export function listGoalReviews(today: string = localDateISO()): { reviews: GoalReviewRow[] } {
  const units = athleteUnits();
  return { reviews: goalReviewRecords().map((r) => goalReviewRow(r, units, today)) };
}

/** GET /api/goal-reviews/:id: one review in full, or null. */
export function getGoalReview(id: number, today: string = localDateISO()): GoalReviewDetail | null {
  const row = goalReviewRecord(id);
  if (!row) return null;
  const units = athleteUnits();
  const text =
    row.status === "ready" && row.review
      ? {
          headline: row.review.headline,
          story: row.review.story,
          lessons: row.review.lessons,
          carry_forward: row.review.carry_forward,
        }
      : null;
  const { levers, undoable } = leversOf(row);
  const decisionId = row.review?.levers_result?.decision_id ?? null;
  return {
    ...goalReviewRow(row, units, today),
    review: text,
    build: buildChart(row, units),
    fact_lines: goalReviewFactLines(row, units, today),
    carried: {
      text: text?.carry_forward ?? null,
      levers,
      decision_id: decisionId,
      undoable: undoable && decisionId != null,
    },
    reviewed_at: row.reviewed_at,
  };
}
