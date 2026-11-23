// Endurance, read over the run engine's own reads: the race estimate's trend (the race
// build's prediction, else the watch's predictor), weekly running distance now against
// four weeks ago, the longest run taken well (run-capacity.ts) and VO2max as a plain
// reading. NEVER the whole-person endurance verdict: its first-half/second-half volume
// compare reads a race taper and the recovery days after it as decline. Here a week that
// a race's taper or recovery touches is simply not compared for volume, and the row's
// direction comes from the lines.
import type {
  WeekReadStandingDirection,
  WeekReadStandingLine,
  WeekReadStandingRow,
} from "../../../contracts/week-read.js";
import { db } from "../../../db.js";
import { addDaysISO, daysBetweenISO, mondayOf } from "../../../lib/dates.js";
import {
  clockWords,
  distanceWords,
  paceWords,
  raceDistanceName,
  sinceWords,
  type AthleteUnits,
} from "../../../repo/display-words.js";
import { RUN_SPORT_PATTERNS } from "../../../repo/endurance-sports.js";
import { getEnduranceGoal } from "../../../repo/profile.js";
import { weeklyKm } from "../../../repo/program-state.js";
import { watchPrediction, type RaceBuild, type RacePrediction } from "../../../repo/race-build.js";
import { latestFinishedRace, raceRecoveryWindow, raceRunDates } from "../../../repo/race-recovery.js";
import { demonstratedRunCapacity } from "../../../repo/run-capacity.js";
import { sensorIsCurrent } from "../../../repo/sensor-freshness.js";
import { cap, secondsWords, standingLine, standingRow } from "./words.js";

/** A race this many days after a week's end means the week sat in its taper. */
export const STANDING_TAPER_DAYS = 14;
/** A race this many days before a week's start still colours it (the longest recovery window). */
export const STANDING_RECOVERY_DAYS = 7;
/** Weekly distance this much above or below four weeks ago reads as a move. */
const VOLUME_MOVE_SHARE = 0.1;
/** Four weeks back: the window every endurance line is read over. */
const AGO_WEEKS = 4;

interface Clause {
  line: WeekReadStandingLine;
  clause: string | null;
}

/** Whether a race's taper or its recovery days touch the week [start, end]. */
export function raceTouchesWeek(start: string, end: string, today: string): boolean {
  const from = addDaysISO(start, -STANDING_RECOVERY_DAYS) ?? start;
  const to = addDaysISO(end, STANDING_TAPER_DAYS) ?? end;
  try {
    if (raceRunDates(from, to).size > 0) return true;
  } catch {
    /* fall through to the window and the goal */
  }
  try {
    if (raceRecoveryWindow(end)) return true;
  } catch {
    /* no window known */
  }
  try {
    const goal = getEnduranceGoal(today);
    const date = goal?.is_race && goal.date ? String(goal.date).slice(0, 10) : null;
    if (date && date >= start && date <= to) return true;
  } catch {
    /* no goal */
  }
  return false;
}

function predictionOf(
  build: RaceBuild | null | undefined,
  today: string,
  units: AthleteUnits
): { p: RacePrediction; km: number } | null {
  if (build?.prediction && build.race?.distance_km) return { p: build.prediction, km: build.race.distance_km };
  let km: number | null = null;
  try {
    const goal = getEnduranceGoal(today);
    if (goal?.is_race && Number(goal.distance_km) > 0) km = Number(goal.distance_km);
  } catch {
    km = null;
  }
  if (km == null) {
    try {
      const last = latestFinishedRace(today, 120);
      if (last && last.distance_km > 0) km = last.distance_km;
    } catch {
      km = null;
    }
  }
  if (km == null) return null;
  const p = watchPrediction(today, km, units.distance);
  return p ? { p, km } : null;
}

function racePaceLine(build: RaceBuild | null | undefined, today: string, units: AthleteUnits): Clause | null {
  const hit = predictionOf(build, today, units);
  if (!hit) return null;
  const { p, km } = hit;
  const t = p.trend;
  const direction: WeekReadStandingDirection | null = t
    ? t.word === "faster"
      ? "better"
      : t.word === "slower"
        ? "worse"
        : "holding"
    : null;
  const when = t ? sinceWords(t.since, today) : "";
  const move =
    !t || !when
      ? null
      : Math.round(Math.abs(t.delta_sec)) < 1
        ? `level ${when}`
        : `${secondsWords(t.delta_sec)} ${t.delta_sec < 0 ? "faster" : "slower"} ${when}`;
  const basis = p.basis === "watch_predictor" ? "by your watch" : "off a recent run";
  return {
    line: standingLine("capacity", {
      id: "endurance:race_pace",
      label: "Race pace",
      now_text: paceWords(p.estimate_pace_sec_per_km, units.distance),
      direction,
      move_words: move,
      note: `${raceDistanceName(km, units.distance).toLowerCase()} in about ${clockWords(p.estimate_sec)}, ${basis}`,
    }),
    clause:
      direction === "better"
        ? "race pace quicker"
        : direction === "worse"
          ? "race pace slower"
          : direction
            ? "race pace level"
            : null,
  };
}

function weeklyDistanceLine(today: string, units: AthleteUnits, floorKm: number | null): Clause | null {
  const now = weeklyKm(today, 0, RUN_SPORT_PATTERNS);
  const ago = weeklyKm(today, AGO_WEEKS, RUN_SPORT_PATTERNS);
  if (!(now > 0) && !(ago > 0)) return null;
  const nowStart = addDaysISO(today, -6) ?? today;
  const agoEnd = addDaysISO(today, -7 * AGO_WEEKS) ?? today;
  const agoStart = addDaysISO(agoEnd, -6) ?? agoEnd;
  const raceInside = raceTouchesWeek(nowStart, today, today) || raceTouchesWeek(agoStart, agoEnd, today);
  const comparable = !raceInside && ago >= 1;
  let direction: WeekReadStandingDirection | null = null;
  let move: string | null = null;
  if (comparable) {
    const diff = now - ago;
    if (Math.abs(diff) <= ago * VOLUME_MOVE_SHARE) {
      direction = "holding";
      move = "about the same as four weeks ago";
    } else {
      direction = diff > 0 ? "better" : "worse";
      move = `${distanceWords(Math.abs(diff), units.distance, { whole: true })} ${diff > 0 ? "more" : "less"} than four weeks ago`;
    }
  }
  const note = raceInside
    ? "a race sits in this stretch, so it is not compared"
    : // The capacity already shown, said only beside a lighter week, where it is context.
      floorKm && floorKm > now
      ? `your best recent week taken well was ${distanceWords(floorKm, units.distance, { whole: true })}`
      : null;
  return {
    line: standingLine("capacity", {
      id: "endurance:weekly_distance",
      label: "Weekly distance",
      now_text: distanceWords(now, units.distance, { whole: true }),
      direction,
      move_words: move,
      note,
    }),
    clause: raceInside
      ? "weekly distance set aside around the race"
      : direction === "better"
        ? "more running each week"
        : direction === "worse"
          ? "less running each week"
          : direction
            ? "weekly distance steady"
            : null,
  };
}

function longRunLine(longKm: number | null, units: AthleteUnits): Clause | null {
  if (!longKm) return null;
  return {
    line: standingLine("capacity", {
      id: "endurance:long_run",
      label: "Long run",
      now_text: distanceWords(longKm, units.distance),
      direction: null,
      move_words: null,
      note: "the longest taken well in four weeks",
    }),
    clause: null,
  };
}

/** VO2max readings, newest first, over the last ten weeks (the watch's, else another wearable's). */
function vo2Series(today: string): { date: string; value: number }[] {
  const since = addDaysISO(today, -70) ?? today;
  const read = (table: string): { date: string; value: number }[] => {
    try {
      return (
        db
          .prepare(
            `SELECT date, vo2max AS value FROM ${table}
              WHERE date >= ? AND date <= ? AND vo2max IS NOT NULL AND vo2max > 0
              ORDER BY date DESC`
          )
          .all(since, today) as any[]
      )
        .map((r) => ({ date: String(r.date).slice(0, 10), value: Number(r.value) }))
        .filter((r) => Number.isFinite(r.value) && r.value >= 10 && r.value <= 100);
    } catch {
      return [];
    }
  };
  const garmin = read("garmin_daily_metrics");
  return garmin.length ? garmin : read("daily_metrics");
}

function aerobicLine(today: string): Clause | null {
  const rows = vo2Series(today);
  const latest = rows[0];
  // A fitness reading weeks old says nothing about today (sensor-freshness.ts).
  if (!latest || !sensorIsCurrent("fitness_marker", latest.date, today)) return null;
  const earlier = rows
    .filter((r) => (daysBetweenISO(latest.date, r.date) ?? 0) >= 21)
    .sort(
      (a, b) =>
        Math.abs((daysBetweenISO(latest.date, a.date) ?? 0) - 28) -
        Math.abs((daysBetweenISO(latest.date, b.date) ?? 0) - 28)
    )[0];
  let direction: WeekReadStandingDirection | null = null;
  let move: string | null = null;
  if (earlier) {
    const diff = Math.round(latest.value) - Math.round(earlier.value);
    const when = sinceWords(earlier.date, today);
    direction = diff > 0 ? "better" : diff < 0 ? "worse" : "holding";
    move = diff === 0 ? `level ${when}` : `${diff > 0 ? "up" : "down"} ${Math.abs(diff)} ${when}`;
  }
  return {
    line: standingLine("capacity", {
      id: "endurance:vo2max",
      label: "Aerobic capacity",
      now_text: `VO2max ${Math.round(latest.value)}`,
      direction,
      move_words: move,
      note: "your watch's estimate",
    }),
    clause:
      direction === "better"
        ? "aerobic capacity rising"
        : direction === "worse"
          ? "aerobic capacity easing"
          : direction
            ? "aerobic capacity level"
            : null,
  };
}

/** The endurance row; null when nothing about running can be said. */
export function enduranceRow(today: string, units: AthleteUnits, build?: RaceBuild | null): WeekReadStandingRow | null {
  const safe = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  // The engine's volume anchor: the Sunday before the week being planned (memoized read).
  const capacity = safe(() => demonstratedRunCapacity(addDaysISO(mondayOf(today), -1) ?? today));
  const parts = [
    safe(() => racePaceLine(build, today, units)),
    safe(() => weeklyDistanceLine(today, units, capacity?.floor_km ?? null)),
    safe(() => longRunLine(capacity?.long_km ?? null, units)),
    safe(() => aerobicLine(today)),
  ].filter((p): p is Clause => p != null);
  if (!parts.length) return null;
  const clauses = parts.map((p) => p.clause).filter((c): c is string => !!c);
  const long = parts.find((p) => p.line.id === "endurance:long_run")?.line;
  const words = clauses.length
    ? `${cap(clauses.slice(0, 3).join(", "))}.`
    : long
      ? `Long run of ${long.now_text} taken well, nothing to compare yet.`
      : "Nothing to compare yet.";
  const lines = parts.map((p) => p.line);
  // Every endurance line is read over about four weeks.
  const windowStart = addDaysISO(today, -7 * AGO_WEEKS);
  return standingRow("capacity", {
    key: "endurance",
    stone: "endurance",
    label: "Endurance",
    words,
    since_words: windowStart ? sinceWords(windowStart, today) || null : null,
    lines,
    invite: null,
    href: "/app/horizon/race",
  });
}
