import { db } from "../db.js";
import type { WeeklyRunPlan, RunPlanPrescription } from "./run-progression.js";
import { weeklyRunPlan } from "./run-progression.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { cardioEffort, sessionLoad } from "./training-read.js";
import { addDaysISO, localDateISO } from "./shared.js";

export type FlexibleRunKind = "easy" | "quality" | "long";
export type FlexibleRunStatus = "open" | "completed";

export interface RunCompletionEvidence {
  activity_id: number;
  date: string;
  duration_min: number | null;
  distance_km: number | null;
  intensity: "easy" | "quality";
  signals: string[];
}

export interface FlexibleRunIntent {
  id: string;
  kind: FlexibleRunKind;
  label: string;
  status: FlexibleRunStatus;
  provisional_day_number: number;
  provisional_date: string;
  window_start: string;
  window_end: string;
  suggested_date: string | null;
  target_distance_km: number | null;
  target_duration_min: number | null;
  target_zone: string | null;
  completion: RunCompletionEvidence | null;
  rationale: string;
}

export interface FlexibleTrainingAgenda {
  available: boolean;
  week_start: string;
  week_end: string;
  as_of: string;
  intents: FlexibleRunIntent[];
  next: {
    intent_id: string;
    kind: FlexibleRunKind;
    suggested_date: string;
    guidance: string;
  } | null;
  today_guidance: "open" | "easy_only" | "not_first_choice" | "complete";
  why: string;
}

interface RunObservation {
  id: number;
  date: string;
  duration_min: number | null;
  distance_km: number | null;
  quality: boolean;
  signals: string[];
}

function mondayOf(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function validNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseZoneSeconds(raw: unknown, minZone: number): number {
  if (!raw) return 0;
  try {
    const zones = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(zones)) return 0;
    return zones.reduce((sum, zone) => {
      const number = Number(zone?.zone);
      const seconds = Number(zone?.secs ?? zone?.seconds ?? 0);
      return sum + (number >= minZone && Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    }, 0);
  } catch {
    return 0;
  }
}

function runObservations(start: string, through: string): RunObservation[] {
  const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.date, a.duration_min, a.distance_km,
                MAX(g.training_effect) AS training_effect,
                MAX(g.aerobic_te) AS aerobic_te,
                MAX(g.anaerobic_te) AS anaerobic_te,
                MAX(g.te_label) AS te_label,
                MAX(g.hr_zones_json) AS hr_zones_json
           FROM activities a
           LEFT JOIN garmin_activities g ON g.activity_id = a.id
          WHERE a.date >= ? AND a.date <= ? AND (${sport.sql})
          GROUP BY a.id
          ORDER BY a.date, a.id`
      )
      .all(start, through, ...sport.params) as any[];
    return rows.map((row) => {
      const te = Math.max(Number(row.training_effect) || 0, Number(row.aerobic_te) || 0, Number(row.anaerobic_te) || 0);
      const label = String(row.te_label ?? "")
        .trim()
        .toUpperCase();
      const z4Seconds = parseZoneSeconds(row.hr_zones_json, 4);
      const quality =
        te >= 3 ||
        /\b(?:TEMPO|THRESHOLD|VO2(?:MAX)?|ANAEROBIC|SPRINT|INTERVAL|LACTATE_THRESHOLD)\b/.test(label) ||
        z4Seconds >= 240;
      const signals: string[] = [];
      if (label) signals.push(`watch effort: ${label.toLowerCase().replaceAll("_", " ")}`);
      if (te >= 3) signals.push("training effect supports a quality effort");
      if (z4Seconds >= 240) signals.push(`${Math.round(z4Seconds / 60)} min in Z4+`);
      if (!signals.length) signals.push("no hard-effort signal; treated as easy running");
      return {
        id: Number(row.id),
        date: String(row.date),
        duration_min: validNumber(row.duration_min),
        distance_km: validNumber(row.distance_km),
        quality,
        signals,
      };
    });
  } catch {
    return [];
  }
}

function targetDoseMet(observation: RunObservation, prescription: RunPlanPrescription, fraction: number): boolean {
  const targetKm = validNumber(prescription.target_distance_km);
  const targetMin = validNumber(prescription.target_duration_min);
  if (targetKm != null && observation.distance_km != null) return observation.distance_km >= targetKm * fraction;
  if (targetMin != null && observation.duration_min != null) return observation.duration_min >= targetMin * fraction;
  // A real run with no comparable prescription/recorded dose may satisfy an easy
  // intention, but never a long/quality one (those need positive evidence below).
  return targetKm == null && targetMin == null && (observation.distance_km != null || observation.duration_min != null);
}

function qualityDoseMet(observation: RunObservation, prescription: RunPlanPrescription): boolean {
  if (!observation.quality) return false;
  if (!targetDoseMet(observation, prescription, 0.5)) return false;
  return (observation.duration_min ?? 0) >= 20 || (observation.distance_km ?? 0) >= 3;
}

function longDoseMet(observation: RunObservation, prescription: RunPlanPrescription): boolean {
  return targetDoseMet(observation, prescription, 0.75);
}

function easyDoseMet(observation: RunObservation, prescription: RunPlanPrescription): boolean {
  return !observation.quality && targetDoseMet(observation, prescription, 0.5);
}

function completionEvidence(observation: RunObservation): RunCompletionEvidence {
  return {
    activity_id: observation.id,
    date: observation.date,
    duration_min: observation.duration_min,
    distance_km: observation.distance_km,
    intensity: observation.quality ? "quality" : "easy",
    signals: observation.signals,
  };
}

function matchCompletions(
  prescriptions: RunPlanPrescription[],
  observations: RunObservation[]
): Map<number, RunCompletionEvidence> {
  const completed = new Map<number, RunCompletionEvidence>();
  const remaining = new Set(prescriptions.map((_, index) => index));

  for (const observation of observations) {
    const quality = prescriptions.findIndex(
      (run, index) => remaining.has(index) && run.kind_label === "quality" && qualityDoseMet(observation, run)
    );
    if (quality >= 0) {
      completed.set(quality, completionEvidence(observation));
      remaining.delete(quality);
      continue;
    }
    const long = prescriptions.findIndex(
      (run, index) => remaining.has(index) && run.kind_label === "long" && longDoseMet(observation, run)
    );
    if (long >= 0) {
      completed.set(long, completionEvidence(observation));
      remaining.delete(long);
      continue;
    }
    const easy = prescriptions.findIndex(
      (run, index) => remaining.has(index) && run.kind_label === "easy" && easyDoseMet(observation, run)
    );
    if (easy >= 0) {
      completed.set(easy, completionEvidence(observation));
      remaining.delete(easy);
    }
  }
  return completed;
}

const LOWER_GROUP = /\b(?:quad|hamstring|glute|lower body|legs?)\b/i;
const LOWER_MOVEMENT =
  /\b(?:squat|deadlift|rdl|romanian deadlift|leg press|lunge|split squat|step[- ]?up|hip thrust|good morning)\b/i;

function actualLowerBodyDates(start: string, through: string): Set<string> {
  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.date, COUNT(l.id) AS set_count,
                GROUP_CONCAT(DISTINCT e.name) AS exercises,
                GROUP_CONCAT(DISTINCT e.muscle_group) AS muscle_groups
           FROM sessions s
           JOIN logged_sets l ON l.session_id = s.id
           JOIN exercises e ON e.id = l.exercise_id
          WHERE s.date >= ? AND s.date <= ?
          GROUP BY s.id, s.date`
      )
      .all(start, through) as any[];
    const dates = new Set<string>();
    for (const row of rows) {
      const lower =
        LOWER_GROUP.test(String(row.muscle_groups ?? "")) || LOWER_MOVEMENT.test(String(row.exercises ?? ""));
      if (!lower || Number(row.set_count) < 2) continue;
      const load = sessionLoad(Number(row.id));
      if (load === "moderate" || load === "hard") dates.add(String(row.date));
    }
    return dates;
  } catch {
    return new Set();
  }
}

function cardioConflictDates(start: string, through: string): Set<string> {
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.date, a.type, a.duration_min, a.distance_km,
                MAX(g.training_effect) AS training_effect,
                MAX(g.aerobic_te) AS aerobic_te,
                MAX(g.anaerobic_te) AS anaerobic_te,
                MAX(g.te_label) AS te_label
           FROM activities a
           LEFT JOIN garmin_activities g ON g.activity_id = a.id
          WHERE a.date >= ? AND a.date <= ?
          GROUP BY a.id`
      )
      .all(start, through) as any[];
    const dates = new Set<string>();
    for (const row of rows) {
      const load = cardioEffort(row);
      if (load === "moderate" || load === "hard") dates.add(String(row.date));
    }
    return dates;
  } catch {
    return new Set();
  }
}

function blockedKeyRunDates(lowerDates: Set<string>, cardioDates: Set<string>): Set<string> {
  const blocked = new Set<string>();
  for (const date of [...lowerDates, ...cardioDates]) {
    blocked.add(date);
    const next = addDaysISO(date, 1);
    if (next) blocked.add(next);
  }
  return blocked;
}

function provisionalDate(weekStart: string, dayNumber: number): string {
  return addDaysISO(weekStart, Math.max(0, Math.min(6, dayNumber - 1))) ?? weekStart;
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let cursor: string | null = start; cursor && cursor <= end; cursor = addDaysISO(cursor, 1)) out.push(cursor);
  return out;
}

function suggestedDatesFor(run: RunPlanPrescription, asOf: string, weekEnd: string, blocked: Set<string>): string[] {
  const candidates = datesBetween(asOf, weekEnd);
  if (!candidates.length) return [];
  const anchor = provisionalDate(mondayOf(asOf), run.day_number);
  const ranked = candidates.sort((a, b) => {
    const da = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`));
    const db = Math.abs(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`));
    return da - db || a.localeCompare(b);
  });
  return run.kind_label === "easy" ? ranked : ranked.filter((date) => !blocked.has(date));
}

function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
}

export function flexibleTrainingAgenda(
  date?: string,
  opts?: {
    runPlan?: WeeklyRunPlan | null;
  }
): FlexibleTrainingAgenda {
  const asOf = date || localDateISO();
  const weekStart = mondayOf(asOf);
  const weekEnd = addDaysISO(weekStart, 6) ?? asOf;
  const plan = opts?.runPlan === undefined ? weeklyRunPlan(asOf) : opts.runPlan;
  if (!plan?.available || !Array.isArray(plan.runs) || !plan.runs.length) {
    return {
      available: false,
      week_start: weekStart,
      week_end: weekEnd,
      as_of: asOf,
      intents: [],
      next: null,
      today_guidance: "complete",
      why: "No running intentions are active for this week.",
    };
  }

  const observations = runObservations(weekStart, asOf);
  const completions = matchCompletions(plan.runs, observations);
  const lowerDates = actualLowerBodyDates(weekStart, asOf);
  const cardioDates = cardioConflictDates(weekStart, asOf);
  const blocked = blockedKeyRunDates(lowerDates, cardioDates);
  const windowStart = asOf < weekStart ? weekStart : asOf;

  const kindCount = new Map<FlexibleRunKind, number>();
  const intents: FlexibleRunIntent[] = plan.runs.map((run, index) => {
    const kind = run.kind_label;
    const occurrence = (kindCount.get(kind) ?? 0) + 1;
    kindCount.set(kind, occurrence);
    const anchor = provisionalDate(weekStart, run.day_number);
    const completion = completions.get(index) ?? null;
    return {
      id: `${weekStart}:${kind}:${occurrence}`,
      kind,
      label: run.label ?? run.day_name ?? `${kind} run`,
      status: completion ? "completed" : "open",
      provisional_day_number: run.day_number,
      provisional_date: anchor,
      window_start: windowStart,
      window_end: weekEnd,
      suggested_date: null,
      target_distance_km: validNumber(run.target_distance_km),
      target_duration_min: validNumber(run.target_duration_min),
      target_zone: run.target_zone ?? null,
      completion,
      rationale: completion
        ? `A compatible ${kind} run is already logged this week; its calendar day does not need to match the provisional anchor.`
        : "This is a movable weekly intention; choose the calmest compatible opening in the window.",
    };
  });

  // Allocate the remaining openings as one agenda, not one intent at a time.
  // Key runs go first, nearest their provisional anchor; easy work cannot consume
  // the only clean key-run opening. Dates are unique, and quality/long intentions
  // need at least one day between them. If the remaining week cannot provide that,
  // the later intent stays undated rather than piling onto the same/adjacent day.
  const usedDates = new Set<string>();
  const keyDates: string[] = [];
  const openIndexes = plan.runs
    .map((run, index) => ({ run, index, intent: intents[index] }))
    .filter((row) => row.intent.status === "open")
    .sort((a, b) => {
      const aKey = a.run.kind_label === "easy" ? 1 : 0;
      const bKey = b.run.kind_label === "easy" ? 1 : 0;
      if (aKey !== bKey) return aKey - bKey;
      const aAnchor = provisionalDate(weekStart, a.run.day_number);
      const bAnchor = provisionalDate(weekStart, b.run.day_number);
      const aDistance = daysBetween(aAnchor, asOf);
      const bDistance = daysBetween(bAnchor, asOf);
      return aDistance - bDistance || a.run.day_number - b.run.day_number;
    });
  for (const row of openIndexes) {
    const key = row.run.kind_label !== "easy";
    const suggested =
      suggestedDatesFor(row.run, windowStart, weekEnd, blocked).find(
        (candidate) =>
          !usedDates.has(candidate) && (!key || keyDates.every((existing) => daysBetween(candidate, existing) >= 2))
      ) ?? null;
    row.intent.suggested_date = suggested;
    if (suggested) {
      usedDates.add(suggested);
      if (key) keyDates.push(suggested);
    }
    const shifted = suggested != null && suggested !== row.intent.provisional_date;
    row.intent.rationale =
      suggested == null
        ? `No clean, separated opening remains for this ${row.intent.kind} run; leave it open without catch-up volume.`
        : shifted && key
          ? `The day number is only an anchor; this window moves the ${row.intent.kind} run around actual lower-body and cardio load.`
          : "This is a movable weekly intention; choose the calmest compatible opening in the window.";
  }

  const open = intents.filter((intent) => intent.status === "open" && intent.suggested_date);
  const todayBlocked = blocked.has(asOf);
  const easyToday = open.find((intent) => intent.kind === "easy" && intent.suggested_date === asOf);
  const nextIntent =
    (todayBlocked ? easyToday : null) ??
    open
      .slice()
      .sort(
        (a, b) =>
          String(a.suggested_date).localeCompare(String(b.suggested_date)) ||
          { quality: 0, long: 1, easy: 2 }[a.kind] - { quality: 0, long: 1, easy: 2 }[b.kind]
      )[0] ??
    null;
  const allComplete = intents.every((intent) => intent.status === "completed");
  const keyOpen = intents.some((intent) => intent.status === "open" && intent.kind !== "easy");
  const todayGuidance: FlexibleTrainingAgenda["today_guidance"] = allComplete
    ? "complete"
    : todayBlocked && easyToday
      ? "easy_only"
      : todayBlocked && keyOpen
        ? "not_first_choice"
        : "open";
  const next = nextIntent?.suggested_date
    ? {
        intent_id: nextIntent.id,
        kind: nextIntent.kind,
        suggested_date: nextIntent.suggested_date,
        guidance:
          todayGuidance === "easy_only"
            ? "Easy running is the cleaner option around the lower-body/cardio load; keep the key run for a fresher opening."
            : todayGuidance === "not_first_choice"
              ? "Today is not the first choice for a key run; the weekly intention stays open without catch-up volume."
              : `The ${nextIntent.kind} intention has the cleanest remaining opening here, but it stays movable.`,
      }
    : null;

  return {
    available: true,
    week_start: weekStart,
    week_end: weekEnd,
    as_of: asOf,
    intents,
    next,
    today_guidance: todayGuidance,
    why: allComplete
      ? "This week's compatible run intentions are already covered by actual logs."
      : "Run days are flexible: actual work closes compatible intentions, and unfinished work is never piled into catch-up volume.",
  };
}
