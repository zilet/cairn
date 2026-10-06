import { db } from "../db.js";
import type { WeeklyRunPlan, RunPlanPrescription } from "./run-progression.js";
import { weekAsPlanned, weeklyRunPlan } from "./run-progression.js";
import { applyRunDayIntensity, type RunDayIntensity, runDayIntensity } from "./run-day-intensity.js";
import { activityLoadFamily, activitySportWhere, canonicalEnduranceSport, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { cardioEffort, sessionLoad } from "./training-read.js";
import type { HrModel } from "./hr-model.js";
import { isLongRunForAthlete, personalRunReadForRow, runLengthBars, usablePersonalHrModel } from "./run-intensity.js";
import { CARDIO_GRADE } from "./heavy-load.js";
import { isStatedEasyRpe, namesQualityRun } from "./stated-effort.js";
import { intervalSessionEvidence } from "./run-structure.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { copyDeep, memoKey, requestMemo } from "./request-memo.js";
import { mondayOf } from "../lib/dates.js";
import { dowToDayNumber, getEnduranceSchedule, isoDow, nextScheduledRunWeekday } from "./profile.js";
import { crossTrainingLoadsLegs, crossTrainingNoun, impactFamily, isKnownCrossTrainingDate } from "./cross-training-day.js";
import { pickDayVariant } from "./brain/day-read-rules.js";

export type FlexibleRunKind = "easy" | "quality" | "long";
export type FlexibleRunStatus = "open" | "completed";

/** How hard a run was, in the athlete's words: "easy", "steady" (his own steady band,
 * not quality) or "hard". Never a score. */
export type RunEffortWord = "easy" | "steady" | "hard";
/**
 * What graded the run, in the order the law asks (run-intensity.ts, stated-effort.ts):
 * the athlete's own stated effort first, then his personal heart-rate model (with his
 * own title for the session), and the watch's signals only when neither can speak.
 */
export type RunIntensityBasis = "stated_easy" | "personal_model" | "watch";

export interface RunCompletionEvidence {
  activity_id: number;
  date: string;
  duration_min: number | null;
  distance_km: number | null;
  intensity: "easy" | "quality";
  /** The same grade as the athlete reads it (see RunEffortWord). */
  intensity_word: RunEffortWord;
  intensity_basis: RunIntensityBasis;
  /** The session's own title ("Hill Sprints"), when it has one. */
  title: string | null;
  avg_hr: number | null;
  pace_sec_per_km: number | null;
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
  /** The week's own plan for this slot, before any morning re-decided it. */
  planned_label: string | null;
  planned_distance_km: number | null;
  rationale: string;
  // This morning's call on the run (runDayIntensity): present only on the intent the
  // morning re-decided, whose kind/label/targets above already carry the answer. The
  // intent's `id` keeps the kind the WEEK planned, so the slot's identity is stable.
  adjustment?: RunDayIntensity | null;
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
  // The morning's call on the run the agenda opened for TODAY, when it is a quality or
  // long run (the same object as that intent's `adjustment`). Null otherwise.
  today_adjustment?: RunDayIntensity | null;
  /**
   * Runs logged this week (Monday through `as_of`) that closed no intention — an extra
   * run the week did not plan, or one too short to answer a slot. Date order. The log
   * is truth: a run is never dropped from the week because no slot was left for it.
   */
  extras: RunCompletionEvidence[];
}

interface RunObservation {
  id: number;
  date: string;
  duration_min: number | null;
  distance_km: number | null;
  quality: boolean;
  effort: RunEffortWord;
  basis: RunIntensityBasis;
  title: string | null;
  avg_hr: number | null;
  signals: string[];
  /**
   * How strongly the run's own evidence says it was the week's quality session, for the
   * quality slot's arbitration: 3 the athlete named it quality work ("Hill Sprints") or
   * ran a structured interval workout, 2 his personal model read it hard, 1 the watch
   * alone did, 0 not quality at all.
   */
  evidence_rank: number;
}

/** One logged run of a week and the intention it closed (null: an extra). */
export interface RunClosure {
  activity_id: number;
  date: string;
  closed: FlexibleRunKind | null;
  evidence: RunCompletionEvidence;
  /** The index of the prescription it closed in the slots it was matched against. */
  slot_index: number | null;
}

function validNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseZoneSeconds(raw: unknown, minZone: number, maxZone = Number.POSITIVE_INFINITY): number {
  if (!raw) return 0;
  try {
    const zones = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(zones)) return 0;
    return zones.reduce((sum, zone) => {
      const number = Number(zone?.zone);
      const seconds = Number(zone?.secs ?? zone?.seconds ?? 0);
      return sum + (number >= minZone && number <= maxZone && Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    }, 0);
  } catch {
    return 0;
  }
}

function sustainedZ3Evidence(zoneSeconds: number, durationMin: number | null): boolean {
  if (zoneSeconds < 20 * 60) return false;
  // With a recorded activity duration, Z3 must occupy at least half the run.
  // Without one, require a stronger absolute 30-minute signal rather than
  // treating an unbounded zone fragment as a tempo session.
  return durationMin != null ? zoneSeconds >= durationMin * 60 * 0.5 : zoneSeconds >= 30 * 60;
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sessionTitle(row: any): string | null {
  for (const raw of [row?.g_name, row?.raw_text]) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) return text.slice(0, 80);
  }
  return null;
}

// The watch's own bars — the documented FALLBACK only, for a run the athlete did not
// state easy and his personal model cannot judge (no heart rate, no usable model).
function watchRunRead(row: any, durationMin: number | null): { quality: boolean; signals: string[] } {
  const te = Math.max(Number(row.training_effect) || 0, Number(row.aerobic_te) || 0, Number(row.anaerobic_te) || 0);
  const label = String(row.te_label ?? "")
    .trim()
    .toUpperCase();
  const z4Seconds = parseZoneSeconds(row.hr_zones_json, 4);
  const z3Seconds = parseZoneSeconds(row.hr_zones_json, 3, 3);
  const sustainedZ3 = sustainedZ3Evidence(z3Seconds, durationMin);
  const hardLabel = /\b(?:TEMPO|THRESHOLD|VO2(?:MAX)?|ANAEROBIC|SPRINT|INTERVAL|LACTATE_THRESHOLD)\b/.test(label);
  // The watch's own EASY verdict is evidence too. A 31-minute conversational run
  // whose HR sat one beat over the Z2 ceiling read as "27 min sustained in Z3" and
  // closed the week's quality slot; the watch had called it AEROBIC BASE. Zone
  // drift on an easy run is not a workout — only Z4+ time or a hard label
  // overrides the watch's easy call. Aerobic TE 3.0–3.9 is "improving base", the
  // ordinary result of an easy hour, so the TE bar sits at 4 (highly improving).
  const easyLabel = /\b(?:RECOVERY|AEROBIC_BASE|EASY|BASE)\b/.test(label);
  const teHard = te >= 4;
  const quality = hardLabel || z4Seconds >= 240 || (!easyLabel && (teHard || sustainedZ3));
  const signals: string[] = [];
  if (label) signals.push(`watch effort: ${label.toLowerCase().replaceAll("_", " ")}`);
  if (teHard) signals.push("training effect supports a quality effort");
  if (z4Seconds >= 240) signals.push(`${Math.round(z4Seconds / 60)} min in Z4+`);
  if (sustainedZ3) {
    signals.push(
      easyLabel && !quality
        ? `${Math.round(z3Seconds / 60)} min in Z3, read as easy — the watch called it ${label.toLowerCase().replaceAll("_", " ")}`
        : `${Math.round(z3Seconds / 60)} min sustained in Z3`
    );
  }
  if (!signals.length) signals.push("no hard-effort signal; treated as easy running");
  return { quality, signals };
}

/**
 * How hard one run was, by the law (CLAUDE.md "trainedWithoutHarm"; run-intensity.ts):
 *   1. the athlete STATED it easy (activities.rpe ≤ 4) — easy, whatever the watch says;
 *   2. a run with heart rate and a usable personal model — `personalRunRead`, his own
 *      zones plus his own title for the session ("Hill Sprints" is quality work) and a
 *      structured interval workout he ran;
 *   3. otherwise the watch's training-effect label, Garmin zone time and training
 *      effect — the documented fallback for a run the personal model cannot judge.
 * `modelFor(date)` is a memoized thunk so a week with no heart rate never builds one.
 */
export function gradeRunRow(
  row: any,
  modelFor: (date: string) => () => HrModel | null
): { quality: boolean; effort: RunEffortWord; basis: RunIntensityBasis; signals: string[] } {
  const durationMin = validNumber(row?.duration_min);
  if (isStatedEasyRpe(row?.rpe)) {
    return {
      quality: false,
      effort: "easy",
      basis: "stated_easy",
      signals: [`you said it felt easy (effort ${Number(row.rpe)} of 10)`],
    };
  }
  const personal = personalRunReadForRow({ ...row, zones: row?.hr_zones_json }, modelFor(String(row?.date)));
  if (personal) {
    const hr = Math.round(Number(row.avg_hr));
    const signals = [`your own heart-rate model reads it ${personal.effort} (average ${hr} bpm)`];
    const title = sessionTitle(row);
    if (personal.hard && personal.effort !== "quality") {
      signals.push(
        title && namesQualityRun(title)
          ? `you named it quality work: ${title}`
          : "the session itself was hard work (intervals or time above your threshold)"
      );
    }
    return {
      quality: personal.hard,
      effort: personal.hard ? "hard" : personal.effort === "steady" ? "steady" : "easy",
      basis: "personal_model",
      signals,
    };
  }
  const watch = watchRunRead(row, durationMin);
  return { quality: watch.quality, effort: watch.quality ? "hard" : "easy", basis: "watch", signals: watch.signals };
}

function runObservations(start: string, through: string): RunObservation[] {
  const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
  try {
    const rawRows = db
      .prepare(
        `SELECT a.id, a.date, a.type, a.source, a.external_id, a.duration_min, a.distance_km, a.rpe, a.raw_text,
                MAX(g.training_effect) AS training_effect,
                MAX(g.aerobic_te) AS aerobic_te,
                MAX(g.anaerobic_te) AS anaerobic_te,
                MAX(g.te_label) AS te_label,
                MAX(g.hr_zones_json) AS hr_zones_json,
                MAX(g.avg_hr) AS avg_hr,
                MAX(COALESCE(g.moving_min, g.duration_min)) AS hr_minutes,
                MAX(g.name) AS g_name,
                MAX(g.structure_json) AS structure,
                MAX(g.laps_json) AS laps
           FROM activities a
           LEFT JOIN garmin_activities g ON g.activity_id = a.id
          WHERE a.date >= ? AND a.date <= ? AND (${sport.sql})
          GROUP BY a.id
          ORDER BY a.date, a.id`
      )
      .all(start, through, ...sport.params) as any[];
    // A hand-logged shadow of a synced run is one observation, not two — left
    // unfiltered, matchCompletions() could close two different weekly slots
    // (e.g. both "long" and "easy") off a single real run.
    const rows = withoutShadowActivities(rawRows);
    // The run is graded by the athlete's own model, not the watch (run-intensity.ts).
    const models = new Map<string, HrModel | null>();
    const modelFor = (date: string) => () => {
      if (!models.has(date)) models.set(date, usablePersonalHrModel(date));
      return models.get(date) ?? null;
    };
    return rows.map((row) => {
      // runObservations reads runs only; a row with no type is still one of them.
      const graded = gradeRunRow({ ...row, type: row.type || "run" }, modelFor);
      const named =
        [row.g_name, row.raw_text].some((name) => namesQualityRun(name)) ||
        intervalSessionEvidence(row.structure, null, null);
      return {
        id: Number(row.id),
        date: String(row.date),
        duration_min: validNumber(row.duration_min),
        distance_km: validNumber(row.distance_km),
        quality: graded.quality,
        effort: graded.effort,
        basis: graded.basis,
        title: sessionTitle(row),
        avg_hr: positiveNumber(row.avg_hr),
        signals: graded.signals,
        evidence_rank: !graded.quality ? 0 : named ? 3 : graded.basis === "personal_model" ? 2 : 1,
      };
    });
  } catch {
    return [];
  }
}

// Was the week's harder running already done before `date`? The same observation
// read that closes a quality intention (the athlete's own model and title, the watch's
// signals only as the fallback), at the smallest dose that could close one. The
// run engine's morning read asks this before it re-decides today's quality day, so
// the plan and this agenda cannot disagree about whether the week's quality is in.
export function qualityRunLoggedBefore(weekStart: string, date: string): boolean {
  const through = addDaysISO(date, -1);
  if (!through || through < weekStart) return false;
  return runObservations(weekStart, through).some(
    (observation) => observation.quality && ((observation.duration_min ?? 0) >= 20 || (observation.distance_km ?? 0) >= 3)
  );
}

/**
 * The longest run graded QUALITY (the same observation read that closes a quality
 * intention) in `from..through`, km — what the athlete has already shown a hard session
 * can hold. The run engine sizes a STATED quality session against it (one step past it,
 * never a leap). Null when no quality run with a distance is on record in the window.
 */
export function longestQualityRunKm(from: string, through: string): number | null {
  if (!from || !through || through < from) return null;
  let best = 0;
  for (const observation of runObservations(from, through)) {
    if (!observation.quality) continue;
    const km = observation.distance_km ?? 0;
    if (km > best) best = km;
  }
  return best > 0 ? Math.round(best * 10) / 10 : null;
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

// A long slot with a target closes at 75% of it. A target-less long slot (the stated
// shape weekRunClosures matches against) has nothing to compare a distance to, so any
// outing used to answer it. It closes only on the stated long weekday, or when the run
// is long for this athlete. A short extra stays an extra.
function longDoseMet(observation: RunObservation, prescription: RunPlanPrescription): boolean {
  const targetKm = validNumber(prescription.target_distance_km);
  const targetMin = validNumber(prescription.target_duration_min);
  if (targetKm == null && targetMin == null) {
    if (observation.distance_km == null && observation.duration_min == null) return false;
    const dow = isoDow(observation.date);
    const onStatedLong = (getEnduranceSchedule()?.days ?? []).some((day) => day.kind === "long" && day.dow === dow);
    if (onStatedLong) return true;
    const bars = runLengthBars(observation.date, { min: CARDIO_GRADE.hardMin, km: CARDIO_GRADE.hardKm });
    return isLongRunForAthlete(bars, {
      date: observation.date,
      minutes: observation.duration_min,
      km: observation.distance_km,
    });
  }
  return targetDoseMet(observation, prescription, 0.75);
}

// Clearly long-biased dose: ≥0.9 of the long target, or duration ≥ max(75 min, long target duration).
// Used only to gate quality-flagged observations against open long intentions (see matchCompletions).
function longShapedDose(observation: RunObservation, prescription: RunPlanPrescription): boolean {
  const targetKm = validNumber(prescription.target_distance_km);
  const targetMin = validNumber(prescription.target_duration_min);
  if (targetKm != null && observation.distance_km != null && observation.distance_km >= targetKm * 0.9) return true;
  if (targetMin != null && observation.duration_min != null) {
    if (observation.duration_min >= targetMin * 0.9) return true;
    if (observation.duration_min >= Math.max(75, targetMin)) return true;
  }
  return false;
}

// A run harder than asked is still the run. While a quality slot is open the hard run
// belongs there, but with none left an easy slot takes it — otherwise a watch-labelled
// TEMPO on an easy day closes nothing and the week asks for the run again. The
// intensity is not lost: completionEvidence keeps it on the completion.
function easyDoseMet(observation: RunObservation, prescription: RunPlanPrescription, qualityOpen: boolean): boolean {
  if (observation.quality && qualityOpen) return false;
  return targetDoseMet(observation, prescription, 0.5);
}

function completionEvidence(observation: RunObservation): RunCompletionEvidence {
  const pace =
    observation.duration_min != null && observation.distance_km != null
      ? Math.round((observation.duration_min * 60) / observation.distance_km)
      : null;
  return {
    activity_id: observation.id,
    date: observation.date,
    duration_min: observation.duration_min,
    distance_km: observation.distance_km,
    intensity: observation.quality ? "quality" : "easy",
    intensity_word: observation.effort,
    intensity_basis: observation.basis,
    title: observation.title,
    avg_hr: observation.avg_hr,
    pace_sec_per_km: pace,
    signals: observation.signals,
  };
}

function openQualityRemains(prescriptions: RunPlanPrescription[], remaining: Set<number>): boolean {
  return prescriptions.some((run, index) => remaining.has(index) && run.kind_label === "quality");
}

function matchingLongIndex(
  observation: RunObservation,
  prescriptions: RunPlanPrescription[],
  remaining: Set<number>,
  slotFor: (index: number, observation: RunObservation) => RunPlanPrescription,
  longShaped: (observation: RunObservation, index: number) => boolean,
  heldForOwnDay: (observation: RunObservation, index: number) => boolean = () => false
): number {
  return prescriptions.findIndex((_planned, index) => {
    const run = slotFor(index, observation);
    if (!remaining.has(index) || run.kind_label !== "long" || !longDoseMet(observation, run)) return false;
    if (heldForOwnDay(observation, index)) return false;
    if (!observation.quality) return true;
    if (!openQualityRemains(prescriptions, remaining)) return true;
    return longShaped(observation, index);
  });
}

function matchCompletions(
  prescriptions: RunPlanPrescription[],
  observations: RunObservation[],
  dayOf?: {
    weekStart: string;
    asOf: string;
    statedQualityDows: Set<number>;
    morningOwned?: Set<number>;
    earlierSlots?: Map<number, RunPlanPrescription>;
  }
): { completed: Map<number, RunCompletionEvidence>; extras: RunCompletionEvidence[] } {
  const completed = new Map<number, RunCompletionEvidence>();
  const remaining = new Set(prescriptions.map((_, index) => index));
  const consumed = new Set<number>();
  // A slot THIS morning re-decided (a long run shortened to 11 km) is today's call: a run
  // from an earlier day is judged against what the WEEK planned there, never against the
  // morning's smaller dose — Tuesday's 9.7 km easy run is not Sunday's shortened long run.
  // A run today is judged against the morning's own dose.
  const slotFor = (index: number, observation: RunObservation): RunPlanPrescription => {
    const planned = dayOf?.earlierSlots?.get(index);
    return planned && observation.date < dayOf!.asOf ? planned : prescriptions[index];
  };

  // Biggest dose first, not calendar order. Read against a live week, date order
  // let a 4.9 km Tuesday jog close a long intention whose target a protective cut
  // had shrunk to 4.9 km, while Thursday's 9.8 km — the week's actual long run —
  // matched nothing. The long slot belongs to the longest run that meets it.
  const byDose = [...observations].sort(
    (a, b) =>
      (b.distance_km ?? 0) - (a.distance_km ?? 0) ||
      (b.duration_min ?? 0) - (a.duration_min ?? 0) ||
      a.date.localeCompare(b.date) ||
      a.id - b.id
  );
  // Which run the QUALITY slot belongs to is not a question of size. A bigger run the
  // watch alone called hard (a social run at tempo) used to take the slot before a
  // smaller one the athlete titled "Hill Sprints" — the session the week planned, moved
  // a day on purpose. So the slot goes to the strongest evidence first (named quality
  // work or a structured interval session, then his own model, then the watch), then
  // the run nearest the stated quality weekday, then the bigger dose.
  const qualityOpenTo = (observation: RunObservation, index: number): boolean =>
    remaining.has(index) &&
    prescriptions[index].kind_label === "quality" &&
    !(dayOf?.morningOwned?.has(index) && observation.date < dayOf.asOf) &&
    qualityDoseMet(observation, slotFor(index, observation));
  const qualityAnchor = (observation: RunObservation, index: number): string => {
    const weekStart = dayOf?.weekStart ?? mondayOf(observation.date);
    const stated = [...(dayOf?.statedQualityDows ?? [])].map((dow) => provisionalDate(weekStart, dowToDayNumber(dow)));
    const anchors = stated.length ? stated : [provisionalDate(weekStart, prescriptions[index].day_number)];
    return anchors.sort(
      (a, b) => Math.abs(daysBetweenISO(observation.date, a) ?? 0) - Math.abs(daysBetweenISO(observation.date, b) ?? 0)
    )[0];
  };
  // Is a quality-graded run the LONG run rather than the quality one? By its dose
  // against the long target (longShapedDose). A slot with no targets at all (the stated
  // shape, weekRunClosures) has no dose to judge, so it asks which stated weekday the run
  // sits nearer: a hard 17.7 km on the long-run day is the long run, hill sprints a day
  // after the quality day are the quality session.
  const longShaped = (observation: RunObservation, longIndex: number): boolean => {
    const run = slotFor(longIndex, observation);
    if (validNumber(run.target_distance_km) != null || validNumber(run.target_duration_min) != null)
      return longShapedDose(observation, run);
    const weekStart = dayOf?.weekStart ?? mondayOf(observation.date);
    const toLong = Math.abs(daysBetweenISO(observation.date, provisionalDate(weekStart, run.day_number)) ?? 0);
    const toQuality = prescriptions
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot, index }) => remaining.has(index) && slot.kind_label === "quality")
      .map(({ index }) => Math.abs(daysBetweenISO(observation.date, qualityAnchor(observation, index)) ?? 0));
    return !toQuality.length || toLong <= Math.min(...toQuality);
  };
  // While the long day is still ahead, a run on another stated run day answers THAT
  // day's slot, not the long one: Tuesday's 9.7 km easy run on the easy weekday is the
  // easy run, and Sunday's long run stays open on Saturday. Only a run that already
  // reached the whole long target is the long run moved early. Once the long day has
  // passed, the biggest-dose rule decides as before.
  const heldForOwnDay = (observation: RunObservation, longIndex: number): boolean => {
    if (!dayOf) return false;
    const longDate = provisionalDate(dayOf.weekStart, prescriptions[longIndex].day_number);
    if (!(observation.date < longDate) || longDate < dayOf.asOf) return false;
    // daysBetweenISO is later-first (the run's date minus Monday), so Monday is 1
    // and Sunday is 7 — the same numbering as dowToDayNumber.
    const dayNumber = (daysBetweenISO(observation.date, dayOf.weekStart) ?? -1) + 1;
    const ownSlot = prescriptions.some((planned, index) => {
      if (index === longIndex || !remaining.has(index) || planned.day_number !== dayNumber) return false;
      const run = slotFor(index, observation);
      if (run.kind_label === "quality") return qualityDoseMet(observation, run);
      return run.kind_label === "easy" && targetDoseMet(observation, run, 0.5);
    });
    if (!ownSlot) return false;
    const long = slotFor(longIndex, observation);
    const hasTarget = validNumber(long.target_distance_km) != null || validNumber(long.target_duration_min) != null;
    return !(hasTarget && targetDoseMet(observation, long, 1));
  };
  const qualityRank = (a: RunObservation, b: RunObservation, index: number): number =>
    b.evidence_rank - a.evidence_rank ||
    Math.abs(daysBetweenISO(a.date, qualityAnchor(a, index)) ?? 0) -
      Math.abs(daysBetweenISO(b.date, qualityAnchor(b, index)) ?? 0) ||
    (b.distance_km ?? 0) - (a.distance_km ?? 0) ||
    (b.duration_min ?? 0) - (a.duration_min ?? 0) ||
    a.date.localeCompare(b.date) ||
    a.id - b.id;
  // A still-unmatched run that would take this quality slot (and not go to the long
  // run as a clearly long-shaped outing) and outranks `observation` for it.
  const betterQualityWaiting = (observation: RunObservation, index: number): boolean =>
    observations.some((other) => {
      if (other.id === observation.id || consumed.has(other.id) || !other.quality) return false;
      if (!qualityOpenTo(other, index)) return false;
      const long = matchingLongIndex(other, prescriptions, remaining, slotFor, longShaped, heldForOwnDay);
      if (long >= 0 && longShaped(other, long)) return false;
      return qualityRank(other, observation, index) < 0;
    });
  for (const observation of byDose) {
    // Arbitrate quality-vs-long before consuming either slot. A quality-bearing
    // observation can also be a clearly long-shaped outing; in that dual-match
    // case it closes the long intention rather than producing duplicate long work.
    // A quality session THIS morning kept on (runDayIntensity — the athlete's word
    // after the week's harder work was already in) belongs to today: an earlier run
    // cannot close it.
    const quality = prescriptions.findIndex(
      (_run, index) => qualityOpenTo(observation, index) && !betterQualityWaiting(observation, index)
    );
    // Quality must not steal long: a quality-flagged observation closes long only when
    // longDoseMet AND either (a) no open quality slot remains, or (b) the dose is clearly
    // long-shaped (longShapedDose). Prefer leaving long open over mis-closing.
    const long = matchingLongIndex(observation, prescriptions, remaining, slotFor, longShaped, heldForOwnDay);
    if (quality >= 0 && !(observation.quality && long >= 0 && longShaped(observation, long))) {
      completed.set(quality, completionEvidence(observation));
      remaining.delete(quality);
      consumed.add(observation.id);
      continue;
    }
    if (long >= 0) {
      completed.set(long, completionEvidence(observation));
      remaining.delete(long);
      consumed.add(observation.id);
      continue;
    }
    // A quality slot this observation may not close (today's, kept by this morning) is
    // not "open" to it either — otherwise a hard earlier run closes nothing at all.
    const qualityOpenToIt = prescriptions.some(
      (run, index) =>
        remaining.has(index) &&
        run.kind_label === "quality" &&
        !(dayOf?.morningOwned?.has(index) && observation.date < dayOf.asOf)
    );
    const easy = prescriptions.findIndex(
      (run, index) =>
        remaining.has(index) &&
        run.kind_label === "easy" &&
        easyDoseMet(observation, slotFor(index, observation), qualityOpenToIt)
    );
    if (easy >= 0) {
      completed.set(easy, completionEvidence(observation));
      remaining.delete(easy);
      consumed.add(observation.id);
    }
  }
  // The quality DAY was run. A quality session is re-decided on its own morning
  // (runDayIntensity), so a run logged on that day — easy because the morning said so,
  // or because the athlete chose it — is that slot's answer once the day has passed:
  // a trimmed week's short set (optional by construction) or the athlete's stated
  // quality weekday. Leaving it open re-asked the session later in the week, which is
  // exactly the catch-up this agenda never piles on.
  if (dayOf) {
    for (const index of [...remaining]) {
      const run = prescriptions[index];
      if (run.kind_label !== "quality") continue;
      const date = provisionalDate(dayOf.weekStart, run.day_number);
      if (!(date < dayOf.asOf)) continue;
      if (!(run.dose === "short" || dayOf.statedQualityDows.has(isoDow(date)))) continue;
      const onTheDay = observations.find((observation) => observation.date === date && !consumed.has(observation.id));
      if (!onTheDay) continue;
      completed.set(index, completionEvidence(onTheDay));
      remaining.delete(index);
      consumed.add(onTheDay.id);
    }
  }
  // Every run that answered no slot is still the week's running: it rides out as an
  // extra rather than vanishing from the week.
  const extras = observations
    .filter((observation) => !consumed.has(observation.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map(completionEvidence);
  return { completed, extras };
}

// The stated run week as slots, for a reader that must not build the live week (the harm
// read sits underneath weeklyRunPlan, so it can never ask for one): one slot per stated
// run day, its kind as stated ("any" is an easy run), no targets. An easy slot takes any
// real run; a quality slot still needs positive intensity evidence. The long slot, with
// no distance to compare against, closes only on the stated long weekday or when the run
// is long for this athlete — a short extra never answers it.
function statedShapePrescriptions(): RunPlanPrescription[] {
  const days = getEnduranceSchedule()?.days ?? [];
  return days
    .map(
      (day) =>
        ({
          day_number: dowToDayNumber(day.dow),
          kind_label: day.kind === "any" ? "easy" : day.kind,
          label: null,
          day_name: null,
          target_distance_km: null,
          target_duration_min: null,
          target_zone: null,
          note: null,
        }) as unknown as RunPlanPrescription
    )
    .sort((a, b) => a.day_number - b.day_number);
}

/**
 * Which intention each run logged in `weekStart..through` closed — THE week matcher,
 * the one `flexibleTrainingAgenda` itself runs against its live prescriptions. Without
 * prescriptions it matches against the stated run week's shape (statedShapePrescriptions).
 *
 * CYCLE-FREE by contract: it reads the log, the athlete's own grading (stated effort,
 * personal model, title) and the stated schedule, and never weeklyRunPlan,
 * flexibleTrainingAgenda, harmEvidenceOnDay or demonstratedRunCapacity — the harm read
 * asks it (closedRunIntentOn), and the run plan sits on top of the harm read.
 */
export function weekRunClosures(
  weekStart: string,
  through: string,
  opts?: {
    prescriptions?: RunPlanPrescription[];
    morningOwned?: number[];
    /** Per slot index: what the WEEK planned for a slot this morning re-decided. */
    earlierSlots?: Array<RunPlanPrescription | null>;
  }
): RunClosure[] {
  const prescriptions = opts?.prescriptions ?? statedShapePrescriptions();
  const owned = [...(opts?.morningOwned ?? [])].sort((a, b) => a - b);
  const earlier = opts?.earlierSlots ?? [];
  const shapeOf = (run: RunPlanPrescription | null | undefined) =>
    run
      ? [
          run.kind_label,
          run.day_number,
          validNumber(run.target_distance_km),
          validNumber(run.target_duration_min),
          run.dose ?? null,
        ]
      : null;
  const key = memoKey({
    weekStart,
    through,
    owned,
    shape: prescriptions.map(shapeOf),
    earlier: earlier.map(shapeOf),
  });
  const read = () => weekRunClosuresRead(weekStart, through, prescriptions, owned, earlier);
  return key == null ? read() : requestMemo(`week_run_closures:${key}`, read, copyDeep);
}

function weekRunClosuresRead(
  weekStart: string,
  through: string,
  prescriptions: RunPlanPrescription[],
  owned: number[],
  earlier: Array<RunPlanPrescription | null>
): RunClosure[] {
  const observations = runObservations(weekStart, through);
  const statedQualityDows = new Set(
    (getEnduranceSchedule()?.days ?? []).filter((day) => day.kind === "quality").map((day) => day.dow)
  );
  const { completed, extras } = matchCompletions(prescriptions, observations, {
    weekStart,
    asOf: through,
    statedQualityDows,
    morningOwned: new Set(owned),
    earlierSlots: new Map(
      earlier.flatMap((run, index): Array<[number, RunPlanPrescription]> => (run ? [[index, run]] : []))
    ),
  });
  const closures: RunClosure[] = [
    ...[...completed.entries()].map(([index, evidence]) => ({
      activity_id: evidence.activity_id,
      date: evidence.date,
      closed: prescriptions[index].kind_label,
      evidence,
      slot_index: index,
    })),
    ...extras.map((evidence) => ({
      activity_id: evidence.activity_id,
      date: evidence.date,
      closed: null,
      evidence,
      slot_index: null,
    })),
  ];
  return closures.sort((a, b) => a.date.localeCompare(b.date) || a.activity_id - b.activity_id);
}

/**
 * The intentions the runs logged on `date` closed in their week (the stated-shape read
 * of weekRunClosures) — a quality session moved off its weekday is still the quality
 * session. [] for a day with no run, or only an extra one. Cycle-free like its source.
 */
export function closedRunIntentOn(date: string): FlexibleRunKind[] {
  const day = String(date).slice(0, 10);
  const monday = mondayOf(day);
  const sunday = addDaysISO(monday, 6) ?? day;
  const kinds = weekRunClosures(monday, sunday)
    .filter((closure) => closure.date === day && closure.closed != null)
    .map((closure) => closure.closed as FlexibleRunKind);
  return [...new Set(kinds)];
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

// Moderate/hard cardio dates, and among them the dates where that load came from
// something other than a run (a ride, a paddle) — the only kind a known cross-training
// day can excuse.
function cardioConflictDates(
  start: string,
  through: string
): { dates: Set<string>; nonRun: Set<string>; nonRunFamilies: Map<string, Set<string>> } {
  const empty = {
    dates: new Set<string>(),
    nonRun: new Set<string>(),
    nonRunFamilies: new Map<string, Set<string>>(),
  };
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.date, a.type, a.duration_min, a.distance_km, a.rpe, a.raw_text,
                MAX(g.training_effect) AS training_effect,
                MAX(g.aerobic_te) AS aerobic_te,
                MAX(g.anaerobic_te) AS anaerobic_te,
                MAX(g.te_label) AS te_label,
                MAX(g.avg_hr) AS avg_hr,
                MAX(COALESCE(g.moving_min, g.duration_min)) AS hr_minutes,
                MAX(g.name) AS g_name,
                MAX(g.hr_zones_json) AS zones,
                MAX(g.structure_json) AS structure,
                MAX(g.laps_json) AS laps
           FROM activities a
           LEFT JOIN garmin_activities g ON g.activity_id = a.id
          WHERE a.date >= ? AND a.date <= ?
          GROUP BY a.id`
      )
      .all(start, through) as any[];
    const dates = new Set<string>();
    const runDates = new Set<string>();
    const nonRunFamilies = new Map<string, Set<string>>();
    // A run is graded by the athlete's own model, not the watch (run-intensity.ts).
    const models = new Map<string, HrModel | null>();
    const modelFor = (date: string) => () => {
      if (!models.has(date)) models.set(date, usablePersonalHrModel(date));
      return models.get(date) ?? null;
    };
    for (const row of rows) {
      const date = String(row.date);
      const isRun = canonicalEnduranceSport(row.type).key === "run";
      const load = cardioEffort(
        row,
        isStatedEasyRpe(row.rpe) ? null : personalRunReadForRow(row, modelFor(date)),
        isRun ? { bars: runLengthBars(date, { min: CARDIO_GRADE.hardMin, km: CARDIO_GRADE.hardKm }), date } : null
      );
      if (load === "moderate" || load === "hard") {
        dates.add(date);
        if (isRun) runDates.add(date);
        else {
          // The family's own name, with an unplaced sport spoken as "other" — the
          // same word crossTrainingDays uses, so a known day can be matched to it.
          const family = impactFamily({ family: activityLoadFamily(row.type, row.raw_text).family });
          const have = nonRunFamilies.get(date) ?? new Set<string>();
          have.add(family);
          nonRunFamilies.set(date, have);
        }
      }
    }
    return { dates, nonRun: new Set([...dates].filter((date) => !runDates.has(date))), nonRunFamilies };
  } catch {
    return empty;
  }
}

// A moderate/hard day blocks itself and the next day for a key run. A KNOWN cross-
// training day (stated, or the observed pattern — cross-training-day.ts) is the
// exception the athlete already lives with: a Saturday ride before the Sunday long run is
// their week, not a conflict, so it blocks its own date and leaves the stated long-run
// weekday after it open (the long run carries a caveat instead). The logged effort has
// to be that day's own sport — a hike on an MTB Saturday is not the ride. An
// unpatterned hard ride still blocks the next day.
function blockedKeyRunDates(
  lowerDates: Set<string>,
  cardio: { dates: Set<string>; nonRun: Set<string> },
  knownCross: Set<string>,
  longDows: Set<number>
): Set<string> {
  const blocked = new Set<string>();
  for (const date of [...lowerDates, ...cardio.dates]) {
    blocked.add(date);
    const next = addDaysISO(date, 1);
    if (!next) continue;
    const excused =
      !lowerDates.has(date) && cardio.nonRun.has(date) && knownCross.has(date) && longDows.has(isoDow(next));
    if (!excused) blocked.add(next);
  }
  return blocked;
}

const CROSS_TRAINING_LONG_CAVEATS = [
  "{weekday}'s {noun} is in the legs; keep the long run conversational.",
  "The {noun} on {weekday} still sits in the legs — run this one conversational and let the pace come to you.",
  "Your {weekday} {noun} is in the legs, which is the week you keep; hold the long run at a conversational effort.",
] as const;

// Swim, paddle, row and an unnamed session do not load the run's prime movers.
// Say where the day sits; do not claim the legs.
const CROSS_TRAINING_LONG_NEUTRAL = [
  "{weekday}'s {noun} sits the day before the long run.",
  "The {noun} on {weekday} sits the day before the long run — the week you keep.",
  "Your {weekday} {noun} sits the day before the long run.",
] as const;

// The caveat for a long run the day after a known cross-training day: said when
// that day's effort is logged, or still ahead (the usual outing before the long run).
// A cross-training day already past with nothing logged says nothing. Leg-loading
// families (crossTrainingLoadsLegs) name the legs; the others only name the day.
function crossTrainingLongCaveat(suggested: string, asOf: string, cardio: { nonRun: Set<string> }): string | null {
  const before = addDaysISO(suggested, -1);
  if (!before) return null;
  if (before <= asOf && !cardio.nonRun.has(before)) return null;
  const known = safeKnownCrossTraining(before, asOf);
  if (!known) return null;
  const legs = crossTrainingLoadsLegs(known.sport_family);
  return pickDayVariant(
    legs ? CROSS_TRAINING_LONG_CAVEATS : CROSS_TRAINING_LONG_NEUTRAL,
    suggested,
    legs ? "agenda:cross-training-long" : "agenda:cross-training-long-neutral"
  )
    .replaceAll("{weekday}", known.weekday)
    .replaceAll("{noun}", crossTrainingNoun(known.sport_family));
}

function safeKnownCrossTraining(date: string, asOf: string) {
  try {
    return isKnownCrossTrainingDate(date, asOf <= date ? asOf : date);
  } catch {
    return null;
  }
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
  const schedule = getEnduranceSchedule();
  const scheduledDows = schedule?.days.length ? new Set(schedule.days.map((d) => d.dow)) : null;
  const eligible = scheduledDows ? candidates.filter((date) => scheduledDows.has(isoDow(date))) : candidates;
  if (!eligible.length) return [];
  const anchor = provisionalDate(mondayOf(asOf), run.day_number);
  const ranked = eligible.sort((a, b) => {
    const da = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`));
    const db = Math.abs(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`));
    return da - db || a.localeCompare(b);
  });
  return run.kind_label === "easy" ? ranked : ranked.filter((date) => !blocked.has(date));
}

// Is this the run the plan's morning read decided? The plan decides the run on the
// plan date's own weekday; its answer already sits on that run.
function adjustedByPlan(plan: WeeklyRunPlan, run: RunPlanPrescription, weekStart: string): boolean {
  const adj = plan.today_adjustment;
  if (!adj) return false;
  return provisionalDate(weekStart, run.day_number) === adj.date && run.kind_label === adj.kind;
}

// A completed slot is named for what was RUN, never for a morning call the run went
// past: a long run the morning shortened to 8 km and then run for 13.5 is the long run,
// not "Long run · shorter". A run that kept to the shortened dose keeps the morning's
// honest label.
function completedLabel(
  label: string,
  plannedLabel: string | null,
  completion: RunCompletionEvidence | null,
  adjustedKm: number | null
): string {
  if (!completion || !plannedLabel || plannedLabel === label) return label;
  if (!/·\s*shorter/i.test(label)) return label;
  const ran = completion.distance_km;
  return ran != null && adjustedKm != null && ran > adjustedKm ? plannedLabel : label;
}

/**
 * The plan for one completed slot in a quiet line, in km — the week's own run first,
 * then what this morning made of it: "Planned long run 10.7 km, shortened to 8 km this
 * morning." Actual-first surfaces print the run and put this line second.
 */
export function plannedRunLine(intent: Pick<FlexibleRunIntent, "kind" | "label" | "planned_label" | "planned_distance_km" | "target_distance_km" | "adjustment">): string {
  const name = String(intent.planned_label || intent.label || `${intent.kind} run`).replace(/\s*·\s*shorter$/i, "");
  const plannedKm = intent.planned_distance_km ?? null;
  const head = `Planned ${name[0].toLowerCase()}${name.slice(1)}${plannedKm != null ? ` ${kmText(plannedKm)}` : ""}`;
  const adj = intent.adjustment;
  if (!adj?.changed) return `${head}.`;
  if (adj.dose === "rest") return `${head}, turned to a rest day this morning.`;
  if (adj.dose === "shortened" && adj.target_distance_km != null)
    return `${head}, shortened to ${kmText(adj.target_distance_km)} this morning.`;
  if (adj.kind === "easy" && adj.planned_kind !== "easy") return `${head}, eased to an easy run this morning.`;
  if (adj.kind === "quality" && adj.planned_kind !== "quality") return `${head}, opened to a quality run this morning.`;
  return `${head}.`;
}

function kmText(km: number): string {
  const r = Math.round(km * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} km`;
}

export function flexibleTrainingAgenda(
  date?: string,
  opts?: {
    runPlan?: WeeklyRunPlan | null;
  }
): FlexibleTrainingAgenda {
  // Request-memoized when the pass reads its own run plan (one Today open asks for the
  // same day's agenda about ten times). A threaded-in run plan is an object the key
  // cannot name, so that pass always computes. Keyed by the local date as well as the
  // day the agenda is for, since the morning decision beneath it reads both.
  if (opts?.runPlan === undefined) {
    const asOf = date || localDateISO();
    const today = localDateISO();
    if (typeof asOf === "string")
      return requestMemo(
        `flexible_training_agenda:${asOf}:${today}`,
        () => flexibleTrainingAgendaRead(date, opts),
        copyDeep
      );
  }
  return flexibleTrainingAgendaRead(date, opts);
}

function flexibleTrainingAgendaRead(
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
      extras: [],
    };
  }

  const morningOwned =
    plan.today_adjustment?.kind === "quality"
      ? plan.runs.map((run, index) => (adjustedByPlan(plan, run, weekStart) ? index : -1)).filter((index) => index >= 0)
      : [];
  // A slot this morning turned to rest carries no distance, and a run with no target
  // would close it on any outing; it is matched against what the WEEK planned there.
  const planned = weekAsPlanned(plan);
  const matchRuns = plan.runs.map((run, index) =>
    plan.today_adjustment?.dose === "rest" && adjustedByPlan(plan, run, weekStart) && planned[index]
      ? planned[index]
      : run
  );
  // One matcher: the same week read every cycle-free consumer asks (weekRunClosures),
  // here against the live prescriptions.
  const earlierSlots = plan.runs.map((run, index) =>
    adjustedByPlan(plan, run, weekStart) && planned[index] ? planned[index] : null
  );
  const closures = weekRunClosures(weekStart, asOf, { prescriptions: matchRuns, morningOwned, earlierSlots });
  const completions = new Map<number, RunCompletionEvidence>(
    closures
      .filter((closure) => closure.slot_index != null)
      .map((closure) => [closure.slot_index as number, closure.evidence])
  );
  const extras = closures.filter((closure) => closure.closed == null).map((closure) => closure.evidence);
  const lowerDates = actualLowerBodyDates(weekStart, asOf);
  const cardio = cardioConflictDates(weekStart, asOf);
  const cardioDates = cardio.dates;
  // A known cross-training weekday excuses the next day's long run only when a
  // moderate or hard non-run logged THAT day is the pattern's own family. A hike
  // on an MTB Saturday is a different sport and still blocks Sunday.
  const knownCross = new Set(
    [...cardio.nonRun].filter((date) => {
      const known = safeKnownCrossTraining(date, asOf);
      if (!known) return false;
      return cardio.nonRunFamilies.get(date)?.has(known.sport_family) === true;
    })
  );
  const longDows = new Set(
    (getEnduranceSchedule()?.days ?? []).filter((day) => day.kind === "long").map((day) => day.dow)
  );
  const blocked = blockedKeyRunDates(lowerDates, cardio, knownCross, longDows);
  const windowStart = asOf < weekStart ? weekStart : asOf;

  const kindCount = new Map<FlexibleRunKind, number>();
  const intents: FlexibleRunIntent[] = plan.runs.map((run, index) => {
    const kind = run.kind_label;
    // The slot's identity is the kind the WEEK put there, so a morning that turns
    // Thursday's quality easy does not rename the slot.
    const slotKind = run.planned_kind_label ?? kind;
    const occurrence = (kindCount.get(slotKind) ?? 0) + 1;
    kindCount.set(slotKind, occurrence);
    const anchor = provisionalDate(weekStart, run.day_number);
    const completion = completions.get(index) ?? null;
    const asPlanned = planned[index] ?? null;
    const plannedLabel = asPlanned ? (asPlanned.label ?? asPlanned.day_name ?? `${asPlanned.kind_label} run`) : null;
    const plannedKm = asPlanned ? validNumber(asPlanned.target_distance_km) : null;
    const label = run.label ?? run.day_name ?? `${kind} run`;
    return {
      id: `${weekStart}:${slotKind}:${occurrence}`,
      kind,
      label: completedLabel(label, plannedLabel, completion, validNumber(run.target_distance_km)),
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
      planned_label: plannedLabel,
      planned_distance_km: plannedKm,
      rationale: completion
        ? `A compatible ${kind} run is already logged this week; its calendar day does not need to match the provisional anchor.`
        : "This is a movable weekly intention; choose the calmest compatible opening in the window.",
      ...(adjustedByPlan(plan, run, weekStart) ? { adjustment: plan.today_adjustment } : {}),
    };
  });

  // Allocate the remaining openings as one agenda, not one intent at a time.
  // Key runs go first, nearest their provisional anchor; easy work cannot consume
  // the only clean key-run opening. Dates are unique, and quality/long intentions
  // need at least one day between them. If the remaining week cannot provide that,
  // the later intent stays undated rather than piling onto the same/adjacent day.
  // Any actual run consumes that date even when its dose is too small to close a
  // weekly intention. Moderate/hard cross-training also consumes the date; light
  // cross-training may still share an easy-run day rather than becoming a blanket
  // veto for active commuters or recovery walks.
  const actualOccupiedDates = new Set<string>([...cardioDates, ...closures.map((item) => item.date)]);
  for (const intent of intents) {
    if (intent.completion?.date) actualOccupiedDates.add(intent.completion.date);
  }
  const usedDates = new Set<string>(actualOccupiedDates);
  const keyDates = intents
    .filter((intent) => intent.status === "completed" && intent.kind !== "easy" && intent.completion?.date)
    .map((intent) => intent.completion!.date);
  const openIndexes = plan.runs
    .map((run, index) => ({ run, index, intent: intents[index] }))
    .filter((row) => row.intent.status === "open")
    .sort((a, b) => {
      const aKey = a.run.kind_label === "easy" ? 1 : 0;
      const bKey = b.run.kind_label === "easy" ? 1 : 0;
      if (aKey !== bKey) return aKey - bKey;
      const aAnchor = provisionalDate(weekStart, a.run.day_number);
      const bAnchor = provisionalDate(weekStart, b.run.day_number);
      // ABSOLUTE distance from today: this sorts by "closest to now", so a date two
      // days behind and one two days ahead are equally close. 0 for an unusable date.
      const aDistance = Math.abs(daysBetweenISO(aAnchor, asOf) ?? 0);
      const bDistance = Math.abs(daysBetweenISO(bAnchor, asOf) ?? 0);
      return aDistance - bDistance || a.run.day_number - b.run.day_number;
    });
  for (const row of openIndexes) {
    const key = row.run.kind_label !== "easy";
    const suggested =
      suggestedDatesFor(row.run, windowStart, weekEnd, blocked).find(
        (candidate) =>
          !usedDates.has(candidate) &&
          (!key || keyDates.every((existing) => Math.abs(daysBetweenISO(candidate, existing) ?? 0) >= 2))
      ) ?? null;
    row.intent.suggested_date = suggested;
    if (suggested) {
      usedDates.add(suggested);
      if (key) keyDates.push(suggested);
    }
    const shifted = suggested != null && suggested !== row.intent.provisional_date;
    const nextWeekday = suggested == null ? nextScheduledRunWeekday(asOf, row.intent.kind) : null;
    row.intent.rationale =
      suggested == null
        ? nextWeekday
          ? `Your next scheduled run day is ${nextWeekday}; leave this ${row.intent.kind} run open without catch-up volume.`
          : `No clean, separated opening remains for this ${row.intent.kind} run; leave it open without catch-up volume.`
        : shifted && key
          ? `The day number is only an anchor; this window moves the ${row.intent.kind} run around actual lower-body and cardio load.`
          : "This is a movable weekly intention; choose the calmest compatible opening in the window.";
    if (suggested && row.intent.kind === "long") {
      const caveat = crossTrainingLongCaveat(suggested, asOf, cardio);
      if (caveat) row.intent.rationale = `${row.intent.rationale} ${caveat}`;
    }
  }

  // ---- today's run, re-decided this morning ----
  // The plan already decided the run on today's own weekday. A key run the window
  // moved ONTO today (a long run placed on the other stated weekend day, a quality run
  // shifted off a leg-loaded day) is decided here the same way, under the week's locks.
  let todayAdjustment: RunDayIntensity | null = null;
  const todayIndex = intents.findIndex((intent) => intent.status === "open" && intent.suggested_date === asOf);
  if (todayIndex >= 0) {
    const intent = intents[todayIndex];
    if (intent.adjustment) {
      todayAdjustment = intent.adjustment;
    } else if (plan.adapt?.today) {
      // Any run the window moved onto today — an easy one too, since a hard floor
      // (rest-grade readiness, illness, pain) takes every run day.
      try {
        const run = plan.runs[todayIndex];
        const adj = runDayIntensity(asOf, run, { locks: plan.adapt.locks, weekAnswersDip: plan.adapt.dip === true });
        if (run.kind_label !== "easy" || adj.changed) {
          const easyZone = plan.runs.find((r) => r.kind_label !== "quality")?.target_zone ?? null;
          const moved = applyRunDayIntensity(run, adj, easyZone);
          intent.kind = moved.kind_label;
          intent.label = moved.label ?? intent.label;
          intent.target_distance_km = validNumber(moved.target_distance_km);
          intent.target_duration_min = validNumber(moved.target_duration_min);
          intent.target_zone = adj.dose === "rest" ? null : (moved.target_zone ?? intent.target_zone);
          intent.adjustment = adj;
          todayAdjustment = adj;
        }
      } catch {
        todayAdjustment = null;
      }
    }
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
  const todayAlreadyOccupied = actualOccupiedDates.has(asOf);
  const todayGuidance: FlexibleTrainingAgenda["today_guidance"] = allComplete
    ? "complete"
    : todayAlreadyOccupied
      ? "not_first_choice"
      : todayBlocked && easyToday
        ? "easy_only"
        : todayBlocked && keyOpen
          ? "not_first_choice"
          : "open";
  const nextCaveat =
    nextIntent?.suggested_date && nextIntent.kind === "long"
      ? crossTrainingLongCaveat(nextIntent.suggested_date, asOf, cardio)
      : null;
  const next = nextIntent?.suggested_date
    ? {
        intent_id: nextIntent.id,
        kind: nextIntent.kind,
        suggested_date: nextIntent.suggested_date,
        guidance:
          (todayAlreadyOccupied
            ? "Today's logged cardio already fills today's opening; keep the remaining weekly intention for a later day."
            : todayGuidance === "easy_only"
              ? "Easy running is the cleaner option around the lower-body/cardio load; keep the key run for a fresher opening."
              : todayGuidance === "not_first_choice"
                ? "Today is not the first choice for a key run; the weekly intention stays open without catch-up volume."
                : `The ${nextIntent.kind} intention has the cleanest remaining opening here, but it stays movable.`) +
          (nextCaveat ? ` ${nextCaveat}` : ""),
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
    today_adjustment: todayAdjustment,
    extras,
  };
}
