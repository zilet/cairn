// ============================================================================
// run-capacity.ts — what the athlete's running has already DEMONSTRATED.
//
// The run engine is reactive: each week steps off the closed week before it. That
// forgets ground already covered — one light week (a recovery dip, a trip, a cold)
// and the build re-climbs from there, so the race ladder could peak below a week the
// athlete ran a fortnight earlier. This module is the read the engine and the ladder
// share for "what has this athlete already shown they can carry":
//
//   • floor_km — the best closed Mon–Sun week of the last DEMONSTRATED_CAPACITY_WEEKS
//     that carried NO running harm. Harm is `harmEvidenceOnDay` on every run day of the
//     week, the one law, asked about the RUNNING (`domain: "running"`): a longest run
//     past the build's ceiling, a run graded hard that the next morning did not absorb,
//     a rest-grade or meaningfully past-band next morning — never re-derived here. A
//     lifting session rated under par is a fact about the lifting and never voids a
//     running week. A week the body paid for is set aside and the floor falls back to
//     the best week it did not: capacity is not pushed through harm.
//   • THE BODY ANSWERED (2026-09-29). Harm earlier in a week is cleared for capacity
//     when a LATER key run that week — a run on the athlete's stated long or quality
//     day — carries no running harm of its own and its next morning spoke clean
//     (`nextMorningClean`: no brake, onset or carried over; silence never vouches).
//     A dip on Thursday followed by a long run taken well on Sunday is a week the
//     athlete carried; the Thursday stays harm for every recovery read, it only stops
//     setting the week's volume aside.
//   • Harm on a day a trip or an illness covers (the day or its next morning) is
//     CONFOUNDED — the travel or the bug talking, not the running — and is not charged
//     to the week (the travel-confounder law underfueling.ts already follows). And a
//     light week of that kind never lowers the floor: the floor is a max, so a lighter
//     week simply is not it.
//   • long_km — the longest run of the last 28 days taken well (`demonstratedLongKm`).
//   • best_week_km — the biggest closed week on record, harm or not: what a "new
//     weekly high" is said against.
//
// Read-only and deterministic. It never prescribes: `raceRamp` turns the floor into a
// peak target and `capacityResumeKm` into a bounded resume (run-ramp.ts).
// ============================================================================

import { db } from "../db.js";
import { addDaysISO, daysBetweenISO, isoDaysAgo, mondayOf } from "../lib/dates.js";
import { round1 } from "../lib/numbers.js";
import { distanceWords, type DistanceUnit } from "./display-words.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { harmEvidenceOnDay, nextMorningClean, type HarmEvidence } from "./brain/read-adherence.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { getEnduranceSchedule, isoDow } from "./profile.js";
import { DEMONSTRATED_CAPACITY_WEEKS } from "./run-ramp.js";
import { tripCoversDay } from "./underfueling.js";
import { copyDeep, memoKey, requestMemo } from "./request-memo.js";

export interface DemonstratedRunCapacity {
  /** The closed-week anchor the read is taken at (the Sunday a week closed on). */
  as_of: string;
  window_weeks: number;
  /** The best closed week of the window with no harm evidence, km. Null when none. */
  floor_km: number | null;
  floor_week_start: string | null;
  /** Bigger weeks of the window passed over because the body paid for them. */
  set_aside: { week_start: string; km: number; harm: HarmEvidence }[];
  /**
   * Weeks read on the way to the floor whose harm a later clean key run that week
   * answered (the body answered — see the header). Machine register, provenance only.
   */
  answered: { week_start: string; km: number; harm: HarmEvidence; by: string }[];
  /** The biggest closed week on record, harm or not, km. */
  best_week_km: number | null;
  /** The longest run of the 28 days ending `as_of` taken well, km. */
  long_km: number | null;
}

interface RunDay {
  date: string;
  km: number;
}

function runDays(from: string | null, to: string): RunDay[] {
  try {
    const sport = activitySportWhere("activities", RUN_SPORT_PATTERNS);
    const rows = withoutShadowActivities(
      db
        .prepare(
          `SELECT date, type, source, external_id, duration_min, distance_km FROM activities
            WHERE ${from ? "date >= ? AND " : ""}date <= ? AND distance_km > 0 AND (${sport.sql})`
        )
        .all(...(from ? [from, to] : [to]), ...sport.params) as any[]
    );
    return rows
      .map((r) => ({ date: String(r.date).slice(0, 10), km: Number(r.distance_km) }))
      .filter((r) => Number.isFinite(r.km) && r.km > 0);
  } catch {
    return [];
  }
}

function weekTotals(runs: RunDay[]): Map<string, { km: number; dates: string[] }> {
  const weeks = new Map<string, { km: number; dates: string[] }>();
  for (const r of runs) {
    const wk = mondayOf(r.date);
    const cur = weeks.get(wk) ?? { km: 0, dates: [] };
    cur.km += r.km;
    if (!cur.dates.includes(r.date)) cur.dates.push(r.date);
    weeks.set(wk, cur);
  }
  return weeks;
}

function illnessCoversDay(iso: string): boolean {
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM context_events
          WHERE kind IN ('illness','sick') AND (archived IS NULL OR archived = 0)
            AND (start_date IS NULL OR start_date <= ?)
            AND COALESCE(end_date, resolved_at, ?) >= ? LIMIT 1`
      )
      .get(iso, iso, iso);
  } catch {
    return false;
  }
}

/** A trip or an illness covers the day's run or the morning that judges it. */
function confoundedDay(iso: string): boolean {
  const next = addDaysISO(iso, 1);
  const days = next ? [iso, next] : [iso];
  return days.some((d) => {
    try {
      return tripCoversDay(d) || illnessCoversDay(d);
    } catch {
      return false;
    }
  });
}

/** The running's own harm on one day (`harmEvidenceOnDay`, domain "running"). */
export function runningHarmOnDay(date: string): HarmEvidence | null {
  try {
    return harmEvidenceOnDay(date, { domain: "running" });
  } catch {
    return null;
  }
}

// The weekdays the athlete stated a long or quality run on — the week's key runs.
function statedKeyRunDows(): Set<number> {
  try {
    return new Set(
      (getEnduranceSchedule()?.days ?? []).filter((d) => d.kind === "long" || d.kind === "quality").map((d) => d.dow)
    );
  } catch {
    return new Set();
  }
}

/**
 * The harm evidence a week's running carried: the first run day whose running harm is
 * neither confounded (a trip or an illness) nor answered by a later clean key run the
 * same week (see the header). `confounded` says harm was found only on confounded
 * days; `absorbed` lists the harm a later key run cleared.
 */
export function weekRunHarm(runDates: readonly string[]): {
  harm: HarmEvidence | null;
  confounded: boolean;
  absorbed: { harm: HarmEvidence; by: string }[];
} {
  const key = memoKey(runDates);
  if (key == null) return weekRunHarmRead(runDates);
  return requestMemo(`week_run_harm:${key}`, () => weekRunHarmRead(runDates), copyDeep);
}

function weekRunHarmRead(runDates: readonly string[]): {
  harm: HarmEvidence | null;
  confounded: boolean;
  absorbed: { harm: HarmEvidence; by: string }[];
} {
  let confounded = false;
  const absorbed: { harm: HarmEvidence; by: string }[] = [];
  const dates = [...new Set(runDates)].sort();
  const harmByDate = new Map<string, HarmEvidence | null>();
  const harmOn = (date: string): HarmEvidence | null => {
    if (!harmByDate.has(date)) harmByDate.set(date, runningHarmOnDay(date));
    return harmByDate.get(date) ?? null;
  };
  let keyDows: Set<number> | null = null;
  // A later key run the same week the body answered well: no running harm of its own,
  // not a confounded day, and a next morning that spoke clean.
  const answeredAfter = (date: string): string | null => {
    keyDows ??= statedKeyRunDows();
    if (!keyDows.size) return null;
    for (const later of dates) {
      if (later <= date || !keyDows.has(isoDow(later))) continue;
      if (harmOn(later) || confoundedDay(later)) continue;
      let clean = false;
      try {
        clean = nextMorningClean(later);
      } catch {
        clean = false;
      }
      if (clean) return later;
    }
    return null;
  };
  for (const date of dates) {
    const found = harmOn(date);
    if (!found) continue;
    if (confoundedDay(date)) {
      confounded = true;
      continue;
    }
    const by = answeredAfter(date);
    if (by) {
      absorbed.push({ harm: found, by });
      continue;
    }
    return { harm: found, confounded, absorbed };
  }
  return { harm: null, confounded, absorbed };
}

/**
 * The harm evidence of the Mon–Sun week holding `dateISO`, when its running carried any —
 * for a week still being run, the harm so far.
 */
export function closedWeekRunHarm(dateISO: string): HarmEvidence | null {
  const monday = mondayOf(dateISO);
  const sunday = addDaysISO(monday, 6) ?? dateISO;
  const dates = [...new Set(runDays(monday, sunday).map((r) => r.date))];
  return dates.length ? weekRunHarm(dates).harm : null;
}

/**
 * The longest run of the 28 days ending `asOf` the athlete took WELL — its day carries
 * no RUNNING harm (`runningHarmOnDay`: not past the build's own ceiling, no bad next
 * morning; a lifting session rated under par that day is the lifting's). That is capacity already demonstrated: the ladder
 * holds it on a reset and steps off it on a build, never plans a climb back up to it,
 * and the long-run peak never lands under it. A longest the body paid for is not
 * counted; the next-longest that it took well is. Null when none.
 */
export function demonstratedLongKm(asOf: string, runs: { date: string; km: number }[]): number | null {
  const recent = runs
    .filter((r) => r.km > 0 && r.date <= asOf && (daysBetweenISO(asOf, r.date) ?? 99) <= 28)
    .sort((a, b) => b.km - a.km);
  for (const r of recent) {
    if (runningHarmOnDay(r.date) == null) return round1(r.km);
  }
  return null;
}

/**
 * What the running has demonstrated as of `anchorISO` — the last day of the closed
 * week the read looks back from (the engine's volume anchor: the Sunday before the
 * week being planned). Only CLOSED weeks count, so the read is a property of the week
 * and never chases itself mid-week.
 */
export function demonstratedRunCapacity(anchorISO: string): DemonstratedRunCapacity {
  const anchor = String(anchorISO).slice(0, 10);
  return requestMemo(`demonstrated_run_capacity:${anchor}`, () => demonstratedRunCapacityRead(anchor), copyDeep);
}

function demonstratedRunCapacityRead(anchor: string): DemonstratedRunCapacity {
  const lastMonday = mondayOf(anchor);
  // A week counts only once it has closed at the anchor.
  const lastClosedMonday =
    addDaysISO(lastMonday, 6) === anchor ? lastMonday : (addDaysISO(lastMonday, -7) ?? lastMonday);
  const firstMonday = addDaysISO(lastClosedMonday, -7 * (DEMONSTRATED_CAPACITY_WEEKS - 1)) ?? lastClosedMonday;
  const closedEnd = addDaysISO(lastClosedMonday, 6) ?? anchor;
  const allRuns = runDays(null, closedEnd);
  const weeks = weekTotals(allRuns);
  let best = 0;
  for (const w of weeks.values()) best = Math.max(best, w.km);

  const window = [...weeks.entries()]
    .filter(([wk]) => wk >= firstMonday && wk <= lastClosedMonday)
    .map(([week_start, w]) => ({ week_start, km: round1(w.km), dates: w.dates }))
    .sort((a, b) => b.km - a.km || b.week_start.localeCompare(a.week_start));
  let floor: { week_start: string; km: number } | null = null;
  const set_aside: DemonstratedRunCapacity["set_aside"] = [];
  const answered: DemonstratedRunCapacity["answered"] = [];
  for (const week of window) {
    const { harm, absorbed } = weekRunHarm(week.dates);
    for (const a of absorbed) answered.push({ week_start: week.week_start, km: week.km, harm: a.harm, by: a.by });
    if (harm) {
      set_aside.push({ week_start: week.week_start, km: week.km, harm });
      continue;
    }
    floor = { week_start: week.week_start, km: week.km };
    break;
  }
  return {
    as_of: anchor,
    window_weeks: DEMONSTRATED_CAPACITY_WEEKS,
    floor_km: floor?.km ?? null,
    floor_week_start: floor?.week_start ?? null,
    set_aside,
    answered,
    best_week_km: best > 0 ? round1(best) : null,
    long_km: demonstratedLongKm(
      closedEnd,
      allRuns.filter((r) => r.date >= isoDaysAgo(closedEnd, 28))
    ),
  };
}

// ---------- SAYING WHY A BIG WEEK IS NOT COUNTED (2026-09-29) ----------
//
// A build that climbs from a lighter week than the biggest one the athlete remembers
// running reads as the plan forgetting their work. So when bigger weeks are set aside,
// the plan says which one and why, in plain words — the week's own kilometres and what
// came after it, never the harm kind's name, a number from the body, or a score. The
// sentence is in km; the race page restates its figures in the athlete's run units
// (runWords). Nothing set aside, nothing said.
const SET_ASIDE_REASON: Readonly<Record<string, string>> = {
  hrv: "had a rough night after it, with HRV well under your usual",
  resting_hr: "had a rough night after it, with resting heart rate above your usual",
  readiness_rest_grade: "had a very low readiness morning after it",
  hard_cardio: "had a hard run in it the next morning hadn't absorbed",
  longest_run: "had a run in it longer than the build had prepared you for",
  rated_poorly: "had a session in it that went under par",
};

/** The plain-word reason one set-aside week carries ("had a rough night after it, …"). */
export function setAsideReason(harm: Pick<HarmEvidence, "kind" | "detail"> | null | undefined): string {
  if (!harm) return "cost you more than it gave";
  if (harm.kind === "physiology_brake") {
    return /^resting hr/i.test(String(harm.detail ?? "")) ? SET_ASIDE_REASON.resting_hr : SET_ASIDE_REASON.hrv;
  }
  return SET_ASIDE_REASON[harm.kind] ?? "cost you more than it gave";
}

const SET_ASIDE_WITH_FLOOR: ReadonlyArray<(week: string, why: string, floor: string) => string> = [
  (week, why, floor) => `Your ${week} week ${why}, so the build climbs from your ${floor} week.`,
  (week, why, floor) => `The build steps up from your ${floor} week rather than the ${week} one: that week ${why}.`,
  (week, why, floor) => `Your ${week} week ${why}; the build counts the ${floor} week you ran well instead.`,
];

const SET_ASIDE_NO_FLOOR: ReadonlyArray<(week: string, why: string) => string> = [
  (week, why) => `Your ${week} week ${why}, so the build climbs from where your running is now.`,
  (week, why) => `The build steps up from where your running is now rather than the ${week} week: that week ${why}.`,
];

const OTHER_WEEKS = ["", "One other bigger week is set aside too.", "Two other bigger weeks are set aside too."];

function kmWords(km: number, units: DistanceUnit = "km"): string {
  return distanceWords(km, units);
}

/**
 * One calm sentence naming the biggest week the capacity read set aside and why, and
 * the week the build climbs from instead. "" when nothing is set aside.
 */
export function capacitySetAsideLine(
  capacity: Pick<DemonstratedRunCapacity, "set_aside" | "floor_km"> | null | undefined,
  date: string,
  units: DistanceUnit = "km"
): string {
  const aside = capacity?.set_aside ?? [];
  if (!aside.length) return "";
  const top = aside[0]!;
  const why = setAsideReason(top.harm);
  const floor = capacity?.floor_km != null && capacity.floor_km > 0 ? kmWords(capacity.floor_km, units) : null;
  const lead = floor
    ? pickDayVariant(SET_ASIDE_WITH_FLOOR, date, "run-capacity:set-aside")(kmWords(top.km, units), why, floor)
    : pickDayVariant(SET_ASIDE_NO_FLOOR, date, "run-capacity:set-aside")(kmWords(top.km, units), why);
  const others = aside.length - 1;
  const tail =
    others <= 0
      ? ""
      : others < OTHER_WEEKS.length
        ? OTHER_WEEKS[others]
        : `${others} other bigger weeks are set aside too.`;
  return tail ? `${lead} ${tail}` : lead;
}
