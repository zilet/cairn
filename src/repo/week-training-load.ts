// THE WHOLE-WEEK LOAD READ — every sport plus the lifting, in one picture.
//
// The prompts used to get the week in fragments: raw activity rows, a week of runs, a
// two-day muscle list, the saturated gates, the run agenda. None of them said "Saturday
// was a long ride, Sunday the long run, and Monday is a leg day" in one place, so a model
// had to assemble the week itself — and could not, because the fragments disagree on
// window and on what counts. This read assembles it ONCE, deterministically, from the
// reads that already own each answer:
//
//   runs        — the week's run closures (flexible-training-agenda: the agenda's own
//                 matcher, its grading by stated effort → personal model → watch)
//   cross       — recentEnduranceImpacts (hybrid-load: family, load band, stated easy)
//   strength    — the logged session (title, sessionLoad) and the acute gates for the
//                 groups it trained (strengthLegLoad / acuteGates)
//   day_load    — dayLoad (training-read: the day's harder of lifting and cardio)
//   intents     — flexibleTrainingAgenda (what the week planned and what closed it)
//   cross day   — crossTrainingDays (stated, else the observed pattern)
//   next 48 h   — the agenda's suggested dates, the stated calendar (calendarDayRead)
//                 and the lifting map (thisWeekPlanDayMap), and the leg gate.
//
// NOTHING here grades, matches, windows or doses anything of its own: no SQL, no type
// regexes, no TE/zone/HR thresholds. Where a read is silent the field is null or empty.
// No scores and no internal magnitudes (residual, bar, heavy_ratio) ever leave it; the
// one athlete-facing string (`next_48h.line`) rotates through pickDayVariant.
import { mondayOf } from "../lib/dates.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { travelOn } from "./travel-days.js";
import { crossTrainingDays, type CrossTrainingDay } from "./cross-training-day.js";
import type { LoadFamily } from "./endurance-sports.js";
import { canonicalGroup, isMobility, type MuscleGroup } from "./exercise-canon.js";
import { getExercise } from "./exercises.js";
import {
  flexibleTrainingAgenda,
  weekRunClosures,
  type FlexibleRunKind,
  type FlexibleTrainingAgenda,
  type RunClosure,
  type RunEffortWord,
  type RunIntensityBasis,
} from "./flexible-training-agenda.js";
import {
  acuteGates,
  muscleResidual,
  recentEnduranceImpacts,
  RESIDUAL_LOOKBACK_DAYS,
  RUN_PRIME_GROUPS,
  strengthLegLoad,
  type AcuteBand,
  type EnduranceImpact,
} from "./hybrid-load.js";
import { calendarDayRead, thisWeekPlanDayMap } from "./plan-selection.js";
import { getEnduranceSchedule, isoDow, WEEKDAY_NAMES } from "./profile.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { getSessionByDate } from "./sessions.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { dayLoad, sessionLoad, type TrainingLoad } from "./training-read.js";

export type WeekLoadBand = "none" | "loaded" | "saturated";

export interface WeekLoadRun {
  activity_id: number;
  km: number | null;
  minutes: number | null;
  /** The agenda's own grade of the run, in the athlete's words. */
  effort_word: RunEffortWord;
  basis: RunIntensityBasis;
  title: string | null;
  /** The week's intention this run closed; null for an extra. */
  closed: FlexibleRunKind | null;
}

export interface WeekLoadCross {
  activity_id: number | null;
  type: string;
  label: string;
  family: LoadFamily;
  known_sport: boolean;
  minutes: number | null;
  km: number | null;
  load: "light" | "moderate" | "heavy";
  intensity: "easy" | "moderate" | "hard";
  /** The athlete stated it easy (activities.rpe <= 4). */
  stated_easy: boolean;
}

export interface WeekLoadStrength {
  title: string;
  load: TrainingLoad;
  legs: WeekLoadBand;
  upper: WeekLoadBand;
}

export interface WeekLoadDay {
  date: string;
  weekday: string;
  runs: WeekLoadRun[];
  cross: WeekLoadCross[];
  strength: WeekLoadStrength | null;
  day_load: TrainingLoad | "none";
}

export interface WeekLoadIntent {
  kind: FlexibleRunKind;
  status: "open" | "completed";
  /** The completion's date, else the agenda's suggested date (null: no clean opening). */
  date: string | null;
  planned_weekday: string;
}

export interface WeekLoadPlannedDay {
  date: string;
  weekday: string;
  run_kind: FlexibleRunKind | null;
  strength_title: string | null;
  cross_training: boolean;
}

export type WeekLoadImplication =
  | "clear"
  | "legs_loaded_before_key_run"
  | "key_run_after_hard_day"
  | "back_to_back_hard";

export interface WeekTrainingLoad {
  as_of: string;
  window_start: string;
  window_end: string;
  days: WeekLoadDay[];
  week: {
    week_start: string;
    intents: WeekLoadIntent[];
    extras_count: number;
    run_km: number;
    cross_minutes_by_family: Partial<Record<LoadFamily, number>>;
    strength_sessions: number;
    loading_days: number;
    hard_days: number;
  };
  spacing: {
    key_runs: Array<{ kind: FlexibleRunKind; date: string }>;
    /** Fewest days between two consecutive key runs this week; null with fewer than two. */
    min_gap_days: number | null;
    hard_back_to_back: Array<{ first: string; second: string; what: string }>;
  };
  cross_training_day: CrossTrainingDay | null;
  next_48h: {
    dates: [string, string];
    planned: WeekLoadPlannedDay[];
    legs: AcuteBand;
    implication_code: WeekLoadImplication;
    line: string;
  };
}

const BAND_RANK: Record<AcuteBand, number> = { fresh: 0, loaded: 1, saturated: 2 };
const KEY_KINDS = new Set<FlexibleRunKind>(["quality", "long"]);

function weekdayOf(date: string): string {
  return WEEKDAY_NAMES[isoDow(date)];
}

function windowDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(start, i) ?? start);
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

// ---- runs ------------------------------------------------------------------------

// Every run of the window with the intention it closed. The current ISO week's verdict is
// the agenda's (its live prescriptions); a run in the week before is read off that week's
// own closures (the stated-shape read of the same matcher). One matcher either way.
function windowRuns(windowStart: string, asOf: string, agenda: FlexibleTrainingAgenda | null): RunClosure[] {
  const monday = mondayOf(asOf);
  const closures: RunClosure[] = [];
  if (windowStart < monday) {
    const prevMonday = mondayOf(windowStart);
    const prevSunday = addDaysISO(monday, -1) ?? windowStart;
    closures.push(
      ...safe(() => weekRunClosures(prevMonday, prevSunday), [] as RunClosure[]).filter(
        (closure) => closure.date >= windowStart
      )
    );
  }
  const current = safe(() => weekRunClosures(monday, asOf), [] as RunClosure[]);
  if (agenda?.available) {
    const closedBy = new Map<number, FlexibleRunKind>();
    for (const intent of agenda.intents) {
      if (intent.completion) closedBy.set(intent.completion.activity_id, intent.kind);
    }
    for (const closure of current) closures.push({ ...closure, closed: closedBy.get(closure.activity_id) ?? null });
  } else {
    closures.push(...current);
  }
  return closures;
}

function runEntry(closure: RunClosure): WeekLoadRun {
  const evidence = closure.evidence;
  return {
    activity_id: closure.activity_id,
    km: evidence.distance_km,
    minutes: evidence.duration_min,
    effort_word: evidence.intensity_word,
    basis: evidence.intensity_basis,
    title: evidence.title,
    closed: closure.closed,
  };
}

// ---- cross-training --------------------------------------------------------------

function crossEntry(impact: EnduranceImpact): WeekLoadCross {
  return {
    activity_id: impact.activity_id,
    type: impact.type,
    label: impact.label,
    family: impact.family,
    known_sport: impact.known_sport,
    minutes: impact.duration_min,
    km: impact.distance_km,
    load: impact.load,
    intensity: impact.intensity,
    stated_easy: impact.stated_easy,
  };
}

// ---- strength --------------------------------------------------------------------

function trainedGroups(sets: Array<{ exercise_id?: unknown }>): Set<MuscleGroup> {
  const groups = new Set<MuscleGroup>();
  const seen = new Set<number>();
  for (const set of sets) {
    const id = Number(set.exercise_id);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    const group = canonicalGroup(getExercise(id)?.muscle_group ?? null);
    if (group) groups.add(group);
  }
  return groups;
}

// The day's lifting: its content-true title, its grade, and where it landed. A region the
// session trained reads at least "loaded"; "saturated" is the shared gate's own answer as
// of that day (strengthLegLoad for the legs — the lifting alone; acuteGates for the rest).
function strengthOn(date: string): WeekLoadStrength | null {
  const session = getSessionByDate(date) as { id: number; title?: string; sets?: any[] } | null;
  if (!session || !Array.isArray(session.sets) || !session.sets.length) return null;
  const groups = trainedGroups(session.sets);
  const prime = new Set<MuscleGroup>(RUN_PRIME_GROUPS);
  const legGroups = [...groups].filter((g) => prime.has(g));
  const upperGroups = [...groups].filter((g) => !prime.has(g) && !isMobility(g));
  const residuals = muscleResidual(RESIDUAL_LOOKBACK_DAYS, date);
  const legs: WeekLoadBand = legGroups.length
    ? strengthLegLoad(date, residuals).saturated
      ? "saturated"
      : "loaded"
    : "none";
  let upper: WeekLoadBand = "none";
  if (upperGroups.length) {
    const gates = acuteGates(date);
    upper = upperGroups.some((g) => gates.get(g)?.band === "saturated") ? "saturated" : "loaded";
  }
  return { title: session.title || "Session", load: sessionLoad(session.id), legs, upper };
}

// ---- next 48 hours ---------------------------------------------------------------

function plannedOn(
  date: string,
  agenda: FlexibleTrainingAgenda | null,
  crossDay: CrossTrainingDay | null
): WeekLoadPlannedDay {
  let run_kind: FlexibleRunKind | null = null;
  if (agenda?.available && date >= agenda.week_start && date <= agenda.week_end) {
    const intent = agenda.intents.find((i) => i.status === "open" && i.suggested_date === date);
    run_kind = intent?.kind ?? null;
  } else {
    // Past the agenda's week: the stated calendar's own read of the weekday.
    // With no lifting week stated the calendar read is silent, and the stated run days
    // still answer the weekday on their own.
    const calendar = safe(() => calendarDayRead(date), null);
    const kind = calendar
      ? (calendar.run_kind ?? null)
      : (safe(() => getEnduranceSchedule()?.days ?? [], []).find((day) => day.dow === isoDow(date))?.kind ?? null);
    run_kind = kind == null ? null : kind === "any" ? "easy" : (kind as FlexibleRunKind);
  }
  const map = safe(() => thisWeekPlanDayMap(date).map, new Map());
  const day = map.get(isoDow(date)) as { name?: string } | undefined;
  return {
    date,
    weekday: weekdayOf(date),
    run_kind,
    strength_title: day?.name ?? null,
    // An optional day inside a trip is not projected: the week does not lean on it.
    cross_training:
      crossDay != null && crossDay.dow === isoDow(date) && !(crossDay.optional && safe(() => travelOn(date), null)),
  };
}

function runNoun(kind: FlexibleRunKind): string {
  return kind === "quality" ? "quality run" : kind === "long" ? "long run" : "easy run";
}

export const NEXT_48H_LINES: Record<WeekLoadImplication, readonly string[]> = {
  legs_loaded_before_key_run: [
    "Your legs are still carrying {cause}; {weekday}'s {run} keeps its place — start it conversational and let the pace come to you.",
    "Keep {weekday}'s {run} where it is and run it at an easy, talkable effort — {cause} is still in the legs.",
    "With {cause} still in the legs, take {weekday}'s {run} relaxed from the first step — it counts just the same.",
  ],
  key_run_after_hard_day: [
    "Today was a big day, and {weekday}'s {run} comes right after it — ease into it and let the body answer.",
    "{weekday}'s {run} follows a big day; start it gently and build only if the legs say yes.",
    "After a big day today, keep the opening of {weekday}'s {run} easy and let it come to you.",
  ],
  back_to_back_hard: [
    "Today was a big day and {weekday} brings {what}; keep that one honest rather than heroic.",
    "Two big days sit side by side — today's and {weekday}'s {what}; hold a little back on the second.",
    "{weekday}'s {what} lands right after a big day; do the work and leave something in the tank.",
  ],
  clear: [
    "Nothing in the last few days crowds the next two; take them as planned.",
    "The next two days hold no key run the recent work would crowd — the plan stands as written.",
    "The coming two days have room for what's planned; nothing recent asks you to hold back.",
  ],
};

// A saturated leg day before a QUALITY run does not rewrite that run into an easy
// one. The morning read owns the dose; this line only says the run stays on the card.
// Kept out of NEXT_48H_LINES so the long-run set above stays the conversational one.
const LEGS_BEFORE_QUALITY_LINES = [
  "{weekday}'s quality run stays on the card; its morning read decides the dose.",
  "{weekday}'s quality run keeps its place — that morning's read is what sets the dose.",
  "Leave {weekday}'s quality run on the card. The morning of it decides how hard it goes.",
] as const;

function fill(template: string, parts: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => parts[key] ?? "");
}

function next48h(
  asOf: string,
  todayLoad: TrainingLoad | "none",
  agenda: FlexibleTrainingAgenda | null,
  crossDay: CrossTrainingDay | null
): WeekTrainingLoad["next_48h"] {
  const dates: [string, string] = [addDaysISO(asOf, 1) ?? asOf, addDaysISO(asOf, 2) ?? asOf];
  const planned = dates.map((date) => plannedOn(date, agenda, crossDay));
  const gates = safe(() => acuteGates(asOf), new Map());
  let legs: AcuteBand = "fresh";
  let legGate: { band: AcuteBand; activity: string | null } | null = null;
  for (const group of RUN_PRIME_GROUPS) {
    const gate = gates.get(group);
    if (!gate) continue;
    if (BAND_RANK[gate.band as AcuteBand] > BAND_RANK[legs]) {
      legs = gate.band as AcuteBand;
      legGate = { band: gate.band as AcuteBand, activity: gate.activity ?? null };
    }
  }
  const key = planned.find((p) => p.run_kind != null && KEY_KINDS.has(p.run_kind));
  let implication_code: WeekLoadImplication = "clear";
  let focus: WeekLoadPlannedDay | null = key ?? null;
  // 'loaded' is ordinary residual. Only 'saturated' — the band acuteGate reserves
  // for a muscle that is still recovering — speaks before a key run. A merely
  // loaded day falls through to the hard-day lines below.
  if (key && legs === "saturated") implication_code = "legs_loaded_before_key_run";
  else if (key && key.date === dates[0] && todayLoad === "hard") implication_code = "key_run_after_hard_day";
  else if (todayLoad === "hard" && (planned[0].run_kind != null || planned[0].strength_title != null)) {
    implication_code = "back_to_back_hard";
    focus = planned[0];
  }
  const what = focus?.run_kind
    ? `the ${runNoun(focus.run_kind)}`
    : focus?.strength_title
      ? focus.strength_title
      : "the next session";
  // A quality run keeps the long-run implication code (one slot in the type) and
  // speaks its own line: the morning read decides the dose, the run stays put.
  const qualityDefer = implication_code === "legs_loaded_before_key_run" && focus?.run_kind === "quality";
  const line = fill(
    pickDayVariant(
      qualityDefer ? LEGS_BEFORE_QUALITY_LINES : NEXT_48H_LINES[implication_code],
      asOf,
      qualityDefer ? "week_load:legs_loaded_before_quality" : `week_load:${implication_code}`
    ),
    {
      weekday: focus?.weekday ?? weekdayOf(dates[0]),
      run: focus?.run_kind ? runNoun(focus.run_kind) : "run",
      what,
      cause: legGate?.activity ? `the ${legGate.activity}` : "the recent work",
    }
  );
  return { dates, planned, legs, implication_code, line };
}

// ---- the read --------------------------------------------------------------------

/**
 * The rolling week (as-of minus six days through as-of) across every sport and the
 * lifting, the ISO week's intentions and totals, key-run spacing, the recurring
 * cross-training day and the next 48 hours. Request-memoized by date; pass the agenda a
 * caller already holds (the coach context does) to reuse it.
 */
export function weekTrainingLoad(asOf?: string, opts?: { agenda?: FlexibleTrainingAgenda | null }): WeekTrainingLoad {
  const date = String(asOf || localDateISO()).slice(0, 10);
  if (opts?.agenda !== undefined) return weekTrainingLoadRead(date, opts.agenda);
  return requestMemo(`week_training_load:${date}`, () => weekTrainingLoadRead(date, undefined), copyDeep);
}

function weekTrainingLoadRead(asOf: string, given: FlexibleTrainingAgenda | null | undefined): WeekTrainingLoad {
  const windowStart = addDaysISO(asOf, -6) ?? asOf;
  const weekStart = mondayOf(asOf);
  const agenda = given !== undefined ? given : safe(() => flexibleTrainingAgenda(asOf), null);

  const runs = windowRuns(windowStart, asOf, agenda);
  const impacts = safe(() => recentEnduranceImpacts(7, asOf), [] as EnduranceImpact[]).filter(
    (impact) => impact.family !== "run" && impact.date >= windowStart && impact.date <= asOf
  );

  const days: WeekLoadDay[] = windowDates(windowStart).map((date) => ({
    date,
    weekday: weekdayOf(date),
    runs: runs.filter((closure) => closure.date === date).map(runEntry),
    cross: impacts.filter((impact) => impact.date === date).map(crossEntry),
    strength: safe(() => strengthOn(date), null),
    day_load: safe(() => dayLoad(date, { countsCardio: true }), "none" as const),
  }));

  // The ISO week's totals: the days of the rolling window from its Monday on.
  const isoDays = days.filter((day) => day.date >= weekStart);
  const crossMinutes: Partial<Record<LoadFamily, number>> = {};
  for (const day of isoDays)
    for (const entry of day.cross)
      if (entry.minutes != null)
        crossMinutes[entry.family] = Math.round((crossMinutes[entry.family] ?? 0) + entry.minutes);
  const runKm = isoDays.reduce((sum, day) => sum + day.runs.reduce((s, r) => s + (r.km ?? 0), 0), 0);

  const intents: WeekLoadIntent[] = agenda?.available
    ? agenda.intents.map((intent) => ({
        kind: intent.kind,
        status: intent.status,
        date: intent.completion?.date ?? intent.suggested_date ?? null,
        planned_weekday: weekdayOf(intent.provisional_date),
      }))
    : [];
  const extras_count = agenda?.available
    ? agenda.extras.length
    : isoDays.reduce((n, day) => n + day.runs.filter((r) => r.closed == null).length, 0);

  const keyRuns = intents
    .filter((intent) => KEY_KINDS.has(intent.kind) && intent.date)
    .map((intent) => ({ kind: intent.kind, date: intent.date as string }))
    .sort((a, b) => a.date.localeCompare(b.date));
  let minGap: number | null = null;
  for (let i = 1; i < keyRuns.length; i++) {
    const a = Date.parse(`${keyRuns[i - 1].date}T00:00:00Z`);
    const b = Date.parse(`${keyRuns[i].date}T00:00:00Z`);
    const gap = Math.round((b - a) / 864e5);
    if (minGap == null || gap < minGap) minGap = gap;
  }
  const describe = (day: WeekLoadDay): string => {
    const parts: string[] = [];
    for (const r of day.runs) parts.push(r.closed ? runNoun(r.closed) : r.title || "run");
    for (const c of day.cross) if (c.load !== "light") parts.push(c.label);
    if (day.strength && day.strength.load !== "easy") parts.push(day.strength.title);
    return parts.join(" + ") || "training";
  };
  const hardBackToBack: WeekTrainingLoad["spacing"]["hard_back_to_back"] = [];
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1].day_load === "hard" && days[i].day_load === "hard")
      hardBackToBack.push({
        first: days[i - 1].date,
        second: days[i].date,
        what: `${describe(days[i - 1])}, then ${describe(days[i])}`,
      });
  }

  const crossDay = safe(() => crossTrainingDays(asOf)[0] ?? null, null);
  return {
    as_of: asOf,
    window_start: windowStart,
    window_end: asOf,
    days,
    week: {
      week_start: weekStart,
      intents,
      extras_count,
      run_km: Math.round(runKm * 10) / 10,
      cross_minutes_by_family: crossMinutes,
      strength_sessions: isoDays.filter((day) => day.strength != null).length,
      loading_days: isoDays.filter((day) => day.day_load === "hard" || day.day_load === "moderate").length,
      hard_days: isoDays.filter((day) => day.day_load === "hard").length,
    },
    spacing: { key_runs: keyRuns, min_gap_days: minGap, hard_back_to_back: hardBackToBack },
    cross_training_day: crossDay,
    next_48h: next48h(asOf, days[days.length - 1]?.day_load ?? "none", agenda, crossDay),
  };
}
