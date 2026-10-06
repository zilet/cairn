// THE PATH — Today's one forward read under the Brief (the Today redesign).
//
// Where the race estimate, the bodyweight and the anchor lift stand, which way each
// is moving, the dated road from today to the furthest goal, and the ONE lever that
// would most help it this week. A composition, never a second engine: every fact comes
// from the read that already owns it and is re-derived nowhere —
//   - the race: raceBuild (estimate, target, fit, trend, the ladder's peak week),
//   - the weight: goalPace (trend and needed slope) over the canonical weigh-ins,
//   - the anchors: getStrengthJourneys (one per active objective),
//   - the checkup: nextCheckupRead (its `visit` window when the read carries one),
//   - the strength checkpoint: the attention schedule's test-week row.
//
// Laws this module holds:
//   - Real measures in real units with a direction. No score, no grade, no percent.
//     The race against its target is the build's FIT word, never a verdict.
//   - The lever is ONE sentence from a small ranked rule set over real signals, said
//     calmly, with no gate language; each rule rotates its phrasing by day
//     (pickDayVariant) so a stable input never prints one literal for weeks.
//   - Sleep is a WINDOW claim here ("recent nights"), held to the sleep window's own
//     freshness: no night newer than SENSOR_MAX_AGE_DAYS.sleep, no sleep lever.
//   - Every part is computed behind its own try/catch: a thin or broken read thins
//     the path, it never breaks it, and an athlete with no race and no goal gets a
//     path of nulls and an empty board.
import type {
  TodayPath,
  TodayPathAnchor,
  TodayPathBoardRow,
  TodayPathLever,
  TodayPathMilestone,
  TodayPathRace,
  TodayPathWeek,
  TodayPathWeight,
} from "../contracts/today-path.js";
import { db } from "../db.js";
import { getAttentionSchedule } from "./attention.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getRecoveryBaselineRead } from "./baseline-bands.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import { goalPace } from "./goal-pace.js";
import { nextCheckupRead, type NextCheckupRead } from "./next-checkup.js";
import { effectiveGoalMode, getProfile } from "./profile.js";
import { fmtClock, raceBuild, type RaceBuild } from "./race-build.js";
import { SENSOR_MAX_AGE_DAYS } from "./sensor-freshness.js";
import { addDaysISO, clipText, daysBetweenISO, localDateISO } from "./shared.js";
import { getStrengthJourneys, type StrengthJourney } from "./strength-objectives.js";
import { isoDate } from "../lib/dates.js";
import { round1 } from "../lib/numbers.js";
import {
  dateRangeWords,
  dateWords,
  distanceOfWords,
  distanceWords,
  raceDistanceName,
  sinceWords,
  weightRateWords,
  weightWords,
  type AthleteUnits,
} from "./display-words.js";
import { athleteUnits } from "./settings.js";
import { weekFrameLine } from "./week-stage.js";
import { GOAL_PACE_WINDOW_DAYS, weightTrendRead } from "./weight-trend.js";

const HORIZON_DAYS = 200;
const TRAIL_BACK_DAYS = 28;
const MONTH_WEEKS = 30 / 7;

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
// A stored day or timestamp, as its YYYY-MM-DD day (or null).
const dayOf = (value: unknown): string | null => isoDate(String(value ?? "").slice(0, 10));

/** Where Today's one glance line into Horizon goes. */
const HORIZON_HREF = "/app/horizon";

// ---------- the race ----------

function raceOf(build: RaceBuild | null, asOf: string, units: AthleteUnits): TodayPathRace | null {
  const race = build?.race;
  const prediction = build?.prediction;
  if (!build?.available || !race || !prediction || !(prediction.estimate_sec > 0)) return null;
  return {
    event: race.event ? String(race.event).trim() || null : null,
    distance_label: raceDistanceName(race.distance_km, units.distance),
    date: race.date,
    date_words: dateWords(race.date, asOf),
    estimate_text: fmtClock(Math.round(prediction.estimate_sec)),
    target_text: race.target_raw ?? race.target?.raw ?? (race.target?.sec ? fmtClock(race.target.sec) : null),
    days_to_race: race.days_to_race,
    estimate_sec: Math.round(prediction.estimate_sec),
    target_sec: race.target?.sec ? Math.round(race.target.sec) : null,
    target_raw: race.target_raw ?? race.target?.raw ?? null,
    trend_delta_sec: prediction.trend ? Math.round(prediction.trend.delta_sec) : null,
    since: prediction.trend?.since ?? null,
    since_words: prediction.trend?.since ? sinceWords(prediction.trend.since, asOf) : null,
    fit: prediction.fit ?? null,
  };
}

function raceFitSentence(race: TodayPathRace): string {
  const est = fmtClock(race.estimate_sec);
  const target = race.target_raw || (race.target_sec ? fmtClock(race.target_sec) : "");
  if (!target || !race.fit) return `Now reading ${est}.`;
  if (race.fit === "fits") return `Now reading ${est}, inside ${target}.`;
  if (race.fit === "stretch") return `Now reading ${est}; ${target} is a stretch from here.`;
  return `Now reading ${est}; ${target} sits past this build.`;
}

// ---------- the weight ----------

// The rate, the ask and the verdict are the ONE weight-trend read (weight-trend.ts) —
// the same figures the Body page, the Season and What moved print.
function weightOf(asOf: string, profile: any, units: AthleteUnits): TodayPathWeight | null {
  const pace = goalPace(GOAL_PACE_WINDOW_DAYS, asOf);
  const trend = weightTrendRead(asOf, { units: units.weight, pace });
  const last = pace.points.at(-1) ?? null;
  const current = last?.weight_lb ?? num(profile?.weight_lb);
  if (current == null || !(current > 0)) return null;
  const since = addDaysISO(asOf, -42) ?? asOf;
  const goalLb = num(pace.goal.weight_lb);
  return {
    mode: effectiveGoalMode(profile),
    current_lb: round1(current),
    current_date: last?.date ?? null,
    goal_lb: goalLb,
    goal_date: pace.goal.date ?? null,
    trend_lb_wk: trend.rate_lb_wk,
    needed_lb_wk: trend.needed_lb_wk,
    points: pace.points.filter((p) => p.date >= since).map((p) => ({ date: p.date, weight_lb: round1(p.weight_lb) })),
    units: units.weight,
    current_text: weightWords(current, units.weight),
    goal_text: goalLb != null ? weightWords(goalLb, units.weight) : null,
    trend_words: trend.rate_words,
    needed_words: trend.needed_words,
    verdict: trend.verdict,
    line: trend.line,
  };
}

// ---------- the anchors ----------

function liveJourneys(): StrengthJourney[] {
  return attempt(() => getStrengthJourneys(), [] as StrengthJourney[]).filter(
    (j) => j?.available && j.objective && (j.current ?? j.latest)
  );
}

function anchorOf(journeys: StrengthJourney[]): TodayPathAnchor | null {
  if (!journeys.length) return null;
  const rate = (j: StrengthJourney) => num(j.trend?.est_1rm_lb_per_week) ?? Number.NEGATIVE_INFINITY;
  // The objective with the strongest positive trend; with none rising, the primary.
  const rising = journeys.filter((j) => rate(j) > 0).sort((a, b) => rate(b) - rate(a));
  const pick = rising[0] ?? journeys[0];
  const now = pick.current ?? pick.latest;
  if (!now || !pick.objective) return null;
  const lbWk = num(pick.trend?.est_1rm_lb_per_week);
  const projection = pick.projection;
  return {
    exercise: pick.objective.exercise,
    est_1rm: Math.round(now.est_1rm),
    target_est_1rm: Math.round(pick.objective.target_est_1rm),
    lb_per_week: lbWk == null || lbWk === 0 ? null : round1(lbWk),
    projection_weeks: projection ? [projection.earliest_weeks, projection.latest_weeks] : null,
  };
}

// ---------- the milestones ----------

function nextLongRun(asOf: string, build: RaceBuild | null, units: AthleteUnits): TodayPathMilestone | null {
  const agenda = attempt(() => flexibleTrainingAgenda(asOf), null);
  const long = agenda?.intents?.find((intent) => intent.kind === "long" && intent.status === "open");
  if (!long) return null;
  const date = long.suggested_date || long.provisional_date;
  if (!date || date < asOf) return null;
  const km = num(long.target_distance_km);
  const band = build?.paces?.bands?.find((b) => b.key === "long") ?? null;
  const detail = band
    ? `Easy, ${band.text}${band.hr_ceiling_bpm ? `, under ${band.hr_ceiling_bpm} bpm` : ""}.`
    : long.target_zone
      ? `Easy, ${long.target_zone}.`
      : null;
  return {
    date,
    end_date: null,
    label: km ? `Long run · ${distanceWords(km, units.distance)}` : "Long run",
    kind: "long_run",
    detail,
  };
}

function peakWeek(asOf: string, build: RaceBuild | null, units: AthleteUnits): TodayPathMilestone | null {
  const week = build?.weeks?.find((w) => w.kind === "peak" && (addDaysISO(w.week_start, 6) ?? w.week_start) >= asOf);
  if (!week) return null;
  const detail = [week.long_km ? `Long run ${distanceWords(week.long_km, units.distance)}.` : "", week.with_lifting || ""]
    .filter(Boolean)
    .join(" ");
  return {
    date: week.week_start,
    end_date: addDaysISO(week.week_start, 6),
    label: `Peak week · ${distanceWords(week.km, units.distance, { whole: true })}${week.new_high ? ", a new high" : ""}`,
    kind: "peak_week",
    detail: detail ? clipText(detail, 200, { collapseWhitespace: true, ellipsis: "…" }) : null,
  };
}

function strengthCheckpoint(asOf: string): TodayPathMilestone | null {
  const row = attempt(() => getAttentionSchedule("training:strength:test-week"), null);
  const due = dayOf(row?.next_due);
  if (!due || due < asOf) return null;
  return {
    date: due,
    end_date: null,
    label: "Strength checkpoint",
    kind: "checkpoint",
    detail: pickDayVariant(
      [
        "A test session re-reads where your main lifts stand before the next build.",
        "A heavier test session checks where the main lifts really are.",
      ],
      asOf,
      "path:checkpoint"
    ),
  };
}

type CheckupVisit = {
  window_start?: unknown;
  window_end?: unknown;
  why?: unknown;
  dexa?: unknown;
};

function checkupMilestone(asOf: string, checkup: NextCheckupRead | null): TodayPathMilestone | null {
  if (!checkup) return null;
  // `visit` is additive on the next-checkup read; consumed defensively.
  const visit = (checkup as NextCheckupRead & { visit?: CheckupVisit | null }).visit;
  const start = dayOf(visit?.window_start);
  if (visit && start) {
    const end = dayOf(visit.window_end);
    const why = String(visit.why ?? "").trim();
    return {
      date: start < asOf ? asOf : start,
      end_date: end && end > start ? end : null,
      label: `Checkup week · blood draw${visit.dexa ? " + DEXA" : ""}`,
      kind: "checkup",
      detail: why ? clipText(why, 200, { collapseWhitespace: true, ellipsis: "…" }) : null,
    };
  }
  const due = [...(checkup.due_now ?? [])]
    .filter((item) => dayOf(item.next_due))
    .sort((a, b) => String(a.next_due).localeCompare(String(b.next_due)))[0];
  if (!due) return null;
  const date = dayOf(due.next_due) as string;
  return {
    date: date < asOf ? asOf : date,
    end_date: null,
    label: `Checkup · ${due.label}`,
    kind: "checkup",
    detail: due.why ? clipText(due.why, 200, { collapseWhitespace: true, ellipsis: "…" }) : null,
  };
}

function milestonesOf(
  asOf: string,
  build: RaceBuild | null,
  race: TodayPathRace | null,
  weight: TodayPathWeight | null,
  checkup: NextCheckupRead | null,
  units: AthleteUnits
): TodayPathMilestone[] {
  const out: TodayPathMilestone[] = [];
  const add = (m: TodayPathMilestone | null) => {
    if (m && m.date >= asOf && (daysBetweenISO(m.date, asOf) ?? 0) <= HORIZON_DAYS) {
      out.push({ ...m, date_words: m.end_date ? dateRangeWords(m.date, m.end_date, asOf) : dateWords(m.date, asOf) });
    }
  };
  add(attempt(() => nextLongRun(asOf, build, units), null));
  add(attempt(() => peakWeek(asOf, build, units), null));
  add(attempt(() => strengthCheckpoint(asOf), null));
  if (race) {
    add({
      date: race.date,
      end_date: null,
      label: race.event || race.distance_label,
      kind: "race",
      detail: raceFitSentence(race),
    });
  }
  if (weight?.goal_lb != null && weight.goal_date && weight.mode !== "maintain") {
    const needed = weight.needed_lb_wk;
    add({
      date: weight.goal_date,
      end_date: null,
      label: `Goal weight · ${weightWords(weight.goal_lb, units.weight)}`,
      kind: "goal",
      detail:
        needed != null && weight.trend_lb_wk != null
          ? `${weightRateWords(needed, units.weight)} gets there; the trend reads ${weightRateWords(weight.trend_lb_wk, units.weight)}.`
          : null,
    });
  }
  add(attempt(() => checkupMilestone(asOf, checkup), null));
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

// ---------- the lever ----------

// The last few nights' sleep, newest first, Garmin preferred over a generic row on
// the same date (the baseline band's own preference). Window claim only.
function recentSleepNights(asOf: string): Array<{ date: string; min: number }> {
  const since = addDaysISO(asOf, -6) ?? asOf;
  const read = (table: string) =>
    db
      .prepare(`SELECT date, sleep_min FROM ${table} WHERE date >= ? AND date <= ? AND sleep_min IS NOT NULL`)
      .all(since, asOf) as Array<{ date: string; sleep_min: number }>;
  const byDate = new Map<string, number>();
  for (const row of read("daily_metrics")) byDate.set(row.date, Number(row.sleep_min));
  for (const row of read("garmin_daily_metrics")) byDate.set(row.date, Number(row.sleep_min));
  return [...byDate.entries()]
    .filter(([, min]) => Number.isFinite(min) && min > 0)
    .map(([date, min]) => ({ date, min }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);
}

function sleepLever(asOf: string): TodayPathLever | null {
  const nights = recentSleepNights(asOf);
  const newest = nights[0];
  const age = newest ? daysBetweenISO(asOf, newest.date) : null;
  if (!newest || age == null || age > SENSOR_MAX_AGE_DAYS.sleep || nights.length < 3) return null;
  const band = getRecoveryBaselineRead().dimensions.find((d) => d.key === "sleep");
  if (!band) return null;
  if (nights.filter((night) => night.min < band.p25).length < 2) return null;
  return {
    kind: "sleep",
    text: pickDayVariant(
      [
        "Recent nights have come in under your usual sleep. A couple of earlier nights would help this week land.",
        "Sleep has run shorter than your usual lately. An earlier night or two protects the work already in.",
      ],
      asOf,
      "path:lever:sleep"
    ),
  };
}

function weightLever(asOf: string, weight: TodayPathWeight | null, peakAhead: boolean): TodayPathLever | null {
  if (!weight?.goal_date || weight.trend_lb_wk == null || weight.needed_lb_wk == null) return null;
  const left = daysBetweenISO(weight.goal_date, asOf);
  if (left == null || left < 14) return null;
  const { needed_lb_wk: needed } = weight;
  const through = peakAhead ? " through peak week" : "";
  // Behind is the ONE verdict the weight-trend read gives (weight-trend.ts paceVerdict).
  const behind = weight.verdict === "behind";
  if (weight.mode === "lose" && needed < 0 && behind) {
    return {
      kind: "weight",
      text: pickDayVariant(
        [
          `Weight is a little behind the line. The team keeps the cut steady${through} rather than chase the date.`,
          `The weight trend runs a touch behind the goal date. A steady cut${through} serves the rest of the work better than chasing it.`,
        ],
        asOf,
        "path:lever:weight"
      ),
    };
  }
  if (weight.mode === "gain" && needed > 0 && behind) {
    return {
      kind: "weight",
      text: pickDayVariant(
        [
          "Weight is building a little slower than the date asks. Steady eating around the lift days keeps it moving.",
          "The gain runs a touch behind the goal date. Fuel on lift days is where it catches up.",
        ],
        asOf,
        "path:lever:gain"
      ),
    };
  }
  return null;
}

function raceLever(
  asOf: string,
  race: TodayPathRace | null,
  longRun: TodayPathMilestone | null
): TodayPathLever | null {
  if (!race || race.fit !== "stretch" || race.days_to_race > 70 || !longRun) return null;
  const days = daysBetweenISO(longRun.date, asOf);
  if (days == null || days > 7) return null;
  const day = days === 0 ? "today's" : days === 1 ? "tomorrow's" : `${weekdayName(longRun.date)}'s`;
  return {
    kind: "race",
    text: pickDayVariant(
      [
        `The long run carries the race from here. Keeping ${day} easy and unhurried does the most for it.`,
        `From here the race is built on the long runs. ${capitalize(day)} long run, easy and unhurried, is the one that counts.`,
      ],
      asOf,
      "path:lever:race"
    ),
  };
}

function weekdayName(iso: string): string {
  const ms = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(ms)
    ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(ms).getUTCDay()]
    : iso;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// ---------- the board ----------

function raceRow(race: TodayPathRace | null, asOf: string): TodayPathBoardRow | null {
  if (!race) return null;
  const now = race.estimate_sec;
  const start = race.trend_delta_sec != null ? now - race.trend_delta_sec : null;
  const goal = race.target_sec;
  const reached = goal != null && now <= goal;
  let progress: number | null = null;
  if (goal != null && start != null) progress = start <= goal ? 1 : clamp01((start - now) / (start - goal));
  else if (goal != null) progress = reached ? 1 : null;
  const span = start != null && goal != null ? Math.abs(start - goal) : 0;
  return {
    key: "race",
    id: "race",
    label: race.distance_label,
    start_text: start != null && start !== now ? fmtClock(start) : null,
    now_text: fmtClock(now),
    goal_text: goal != null ? fmtClock(goal) : null,
    progress,
    reached,
    note: reached
      ? "Past your target."
      : race.trend_delta_sec != null && race.trend_delta_sec !== 0 && race.since
        ? `${Math.abs(Math.round(race.trend_delta_sec / 60)) || 1} min ${race.trend_delta_sec < 0 ? "faster" : "slower"} ${sinceWords(race.since, asOf)}`
        : null,
    direction: null,
    movement: span > 0 && race.trend_delta_sec != null ? Math.abs(race.trend_delta_sec) / span : 0,
  };
}

function weightRow(
  weight: TodayPathWeight | null,
  profile: any,
  asOf: string,
  units: AthleteUnits
): TodayPathBoardRow | null {
  if (!weight || weight.goal_lb == null || weight.mode === "maintain") return null;
  const startLb = num(profile?.start_weight_lb);
  const startDate = dayOf(profile?.start_date);
  const start = startLb != null && startLb > 0 ? startLb : (weight.points[0]?.weight_lb ?? null);
  const now = weight.current_lb;
  const goal = weight.goal_lb;
  const lose = weight.mode === "lose";
  const reached = lose ? now <= goal : now >= goal;
  const span = start != null ? Math.abs(start - goal) : 0;
  const moved = start != null ? (lose ? start - now : now - start) : 0;
  const progress = start == null || span === 0 ? (reached ? 1 : null) : clamp01(moved / span);
  const since = startLb != null && startDate ? ` ${sinceWords(startDate, asOf)}` : "";
  const lbText = (n: number) => weightWords(n, units.weight);
  return {
    key: "weight",
    id: "weight",
    label: "Weight",
    start_text: start != null ? lbText(start) : null,
    now_text: lbText(now),
    goal_text: lbText(goal),
    progress,
    reached,
    note:
      start != null && Math.abs(start - now) >= 0.5
        ? `${weightWords(Math.abs(start - now), units.weight)} ${now < start ? "down" : "up"}${since}`
        : weight.trend_lb_wk != null
          ? weightRateWords(weight.trend_lb_wk, units.weight)
          : null,
    direction: null,
    movement: span > 0 && weight.trend_lb_wk != null ? Math.abs(weight.trend_lb_wk * MONTH_WEEKS) / span : 0,
  };
}

function strengthRow(journey: StrengthJourney, units: AthleteUnits): TodayPathBoardRow | null {
  const objective = journey.objective;
  const nowRead = journey.current ?? journey.latest;
  if (!objective || !nowRead) return null;
  const now = nowRead.est_1rm;
  const goal = objective.target_est_1rm;
  const start = num(journey.baseline?.est_1rm) ?? num(objective.baseline_est_1rm);
  const reached = now >= goal;
  const span = start != null ? goal - start : 0;
  const progress = start == null || span <= 0 ? (reached ? 1 : null) : clamp01((now - start) / span);
  const lbWk = num(journey.trend?.est_1rm_lb_per_week);
  const load = (lb: number) => weightWords(lb, units.weight, { whole: true });
  const note =
    lbWk != null && lbWk !== 0
      ? weightRateWords(lbWk, units.weight)
      : journey.phase === "rebuilding"
        ? "Rebuilding"
        : journey.phase === "consolidating"
          ? "Holding"
          : null;
  return {
    key: "strength",
    id: `strength:${objective.exercise_key || objective.exercise.toLowerCase()}`,
    label: objective.exercise,
    start_text: start != null && Math.round(start) !== Math.round(now) ? load(start) : null,
    now_text: load(now),
    goal_text: load(goal),
    progress,
    reached,
    note,
    direction: null,
    movement: span > 0 && lbWk != null ? Math.abs(lbWk * MONTH_WEEKS) / span : 0,
  };
}

function markerRow(checkup: NextCheckupRead | null): TodayPathBoardRow | null {
  const rows = (checkup?.follow_through ?? []).filter((row) => row.latest_value);
  const pick = rows.find((row) => /apo\s*-?\s*b/i.test(`${row.marker_key} ${row.marker}`)) ?? rows[0];
  if (!pick || !pick.latest_value) return null;
  const direction =
    pick.status === "moving_your_way" ? "toward" : pick.status === "not_yet" && pick.trend_dir ? "away" : "steady";
  const trend = pick.trend_dir === "falling" ? "falling" : pick.trend_dir === "rising" ? "rising" : null;
  const recheck = String(pick.recheck_text || "").trim();
  return {
    key: "marker",
    id: `marker:${pick.marker_key}`,
    label: pick.marker,
    start_text: null,
    now_text: pick.latest_value,
    goal_text: null,
    progress: null,
    reached: false,
    note: [trend ? capitalize(trend) : "", recheck ? capitalize(recheck) : ""].filter(Boolean).join(" · ") || null,
    direction,
    movement: 0,
  };
}

// ---------- the season's focus ----------

function focusWords(
  checkup: NextCheckupRead | null,
  weight: TodayPathWeight | null,
  race: TodayPathRace | null,
  journeys: StrengthJourney[]
): string | null {
  const words: string[] = [];
  const marker = (checkup?.follow_through ?? [])[0];
  if (marker) {
    const text = `${marker.marker_key} ${marker.marker}`;
    words.push(
      /apo|ldl|hdl|cholesterol|triglycer|lipo/i.test(text)
        ? "lipids"
        : /glucose|a1c|insulin/i.test(text)
          ? "glucose"
          : marker.marker
    );
  }
  if (weight && weight.goal_lb != null && weight.mode === "lose")
    words.push(journeys.length ? "recomposition" : "the cut");
  else if (weight && weight.goal_lb != null && weight.mode === "gain") words.push("building");
  if (race && words.length < 2) words.push(race.distance_label.toLowerCase());
  if (journeys.length && words.length < 2) words.push("strength");
  return words.length ? words.slice(0, 2).join(" & ") : null;
}

// ---------- the week ----------

// The week's name is the ONE stage word (week-stage.ts), never a table of its own.
function weekOf(build: RaceBuild | null, stageWord: string | null, units: AthleteUnits): TodayPathWeek | null {
  const week = build?.this_week;
  if (!week) return null;
  const planned = num(week.km);
  const logged = num(week.logged_km);
  return {
    km_planned: planned,
    km_logged: logged,
    long_km: num(week.long_km),
    phase: stageWord,
    distance_words:
      planned != null && planned > 0
        ? logged != null && logged > 0
          ? distanceOfWords(logged, planned, units.distance)
          : distanceWords(planned, units.distance)
        : null,
  };
}

// ---------- the read ----------

export function todayPath(date?: string, opts: { build?: RaceBuild | null } = {}): TodayPath {
  const asOf = dayOf(date) ?? localDateISO();
  const units = athleteUnits();
  const profile = attempt(() => getProfile(), null);
  const build =
    opts.build !== undefined ? opts.build : attempt(() => raceBuild(asOf, { describeRunning: true }), null);
  const frame = attempt(() => weekFrameLine(asOf, { build }), null);
  const race = attempt(() => raceOf(build, asOf, units), null);
  const weight = attempt(() => weightOf(asOf, profile, units), null);
  const journeys = liveJourneys();
  const anchor = attempt(() => anchorOf(journeys), null);
  const checkup = attempt(() => nextCheckupRead({ asOf }), null);
  const milestones = attempt(() => milestonesOf(asOf, build, race, weight, checkup, units), [] as TodayPathMilestone[]);
  const longRun = milestones.find((m) => m.kind === "long_run") ?? null;
  const peakAhead = milestones.some((m) => m.kind === "peak_week");
  const lever =
    attempt(() => weightLever(asOf, weight, peakAhead), null) ??
    attempt(() => sleepLever(asOf), null) ??
    attempt(() => raceLever(asOf, race, longRun), null);
  const board = [
    attempt(() => raceRow(race, asOf), null),
    attempt(() => weightRow(weight, profile, asOf, units), null),
    ...journeys.map((journey) => attempt(() => strengthRow(journey, units), null)),
    attempt(() => markerRow(checkup), null),
  ]
    .filter((row): row is TodayPathBoardRow => !!row)
    // Most movement this month first; a row with no measured movement keeps its place.
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.movement - a.row.movement || a.index - b.index)
    .map(({ row }) => row);
  return {
    as_of: asOf,
    trail_start: race?.since && race.since < asOf ? race.since : (addDaysISO(asOf, -TRAIL_BACK_DAYS) ?? asOf),
    race,
    weight,
    anchor,
    milestones,
    lever,
    focus: attempt(() => focusWords(checkup, weight, race, journeys), null),
    board,
    week: attempt(() => weekOf(build, frame?.stage?.word ?? null, units), null),
    frame: frame
      ? {
          headline: frame.headline,
          line: frame.line,
          glance: frame.glance ? { line: frame.glance, href: HORIZON_HREF } : null,
        }
      : null,
    units: { distance: units.distance, weight: units.weight },
  };
}

/**
 * The path in a few hundred bytes for the Brief's prompt (`today_path`, the day_read
 * site): the three threads as numbers with direction, the next few milestones and the
 * lever. The board and the weigh-in points stay out — the Brief points forward ONCE.
 */
export function todayPathPromptView(path: TodayPath): Record<string, unknown> {
  const race = path.race
    ? {
        race: path.race.event || path.race.distance_label,
        date: path.race.date,
        days_to_race: path.race.days_to_race,
        estimate: fmtClock(path.race.estimate_sec),
        target: path.race.target_raw,
        fit: path.race.fit,
        trend_min: path.race.trend_delta_sec != null ? round1(path.race.trend_delta_sec / 60) : null,
      }
    : null;
  const weight = path.weight
    ? {
        current_lb: path.weight.current_lb,
        goal_lb: path.weight.goal_lb,
        goal_date: path.weight.goal_date,
        trend_lb_wk: path.weight.trend_lb_wk,
        needed_lb_wk: path.weight.needed_lb_wk,
      }
    : null;
  return {
    race,
    weight,
    anchor: path.anchor,
    milestones: path.milestones.slice(0, 4).map((m) => ({ date: m.date, label: m.label })),
    lever: path.lever?.text ?? null,
  };
}
