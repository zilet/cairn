// ============================================================================
// run-day-intensity.ts — the MORNING decision for a stated quality or long run day.
//
// weeklyRunPlan shapes a WEEK: how much running, which days, which kind of session
// sits on each. What it cannot know on Monday is how Thursday morning will read.
// Strength already re-decides every morning from the day's own signals (the daily
// envelope); runs used to be fixed at week build — a scheduled down week or a spike
// brake turned the stated quality slot into an easy run regardless of how the
// athlete actually was that morning, and a green morning inside a normal week could
// never be told apart from a poor one.
//
// So the week keeps the SHAPE (and every volume law: the spike brake, the ACWR
// ceiling, the reset week, the taper, race week, health holds), and this read decides
// the INTENSITY of today's run from today's evidence:
//   • HARD FLOORS — a rest-grade readiness reading, illness, active pain or injury the
//     run loads. On ANY run day (easy days included) and through the week's locks
//     (race day excepted) no run is prescribed at all: rest, or optional easy movement
//     (dose "rest"). The Brief rests on the same mornings.
//   • FLOORS — last night's HRV below or resting HR above the athlete's OWN band (a
//     VERIFIED reading only), a short night, a run-down / poorly-rested check-in, high
//     soreness, legs still DEEP in lifting, harm evidence on yesterday's work, a
//     running-volume spike (the Brief's own definition). Any one turns a quality
//     session easy and shortens a long run. Nothing outranks a floor, the athlete's own
//     word included.
//   • SOFT BRAKES — subdued readiness, legs still carrying a leg day, a trailing
//     recovery dip (dropped when the week's own trim already answers it), the watch
//     reading the training as strained. Weighed against the supports.
//   • SUPPORTS — good readiness, last night inside the athlete's own band, enough
//     sleep, a good check-in, legs clear of the lifting, the athlete's record of
//     training through quiet reads without harm, a recent harm-free stretch, fitness
//     trending up (VO2max or the watch's race predictor).
//   • THE ATHLETE'S WORD — today's check-in note or the Brief's steer (heard by the
//     steered read itself, run-day-steer.ts). An explicit ask ("feel great, hills
//     today") opens a quality session the evidence alone left easy — on the stated
//     quality weekday of a week with no quality session too — as long as no floor
//     fires; any down cue ("rough night", "knee hurts", "not feeling great") closes one.
//   • LOCKS — the week's own structure the morning never re-decides: race day and the
//     taper, an applied recovery week, an endurance-limiting health flag.
//
// Deterministic and read-only. The agent's prose may explain the answer; it never
// decides it. Every athlete-facing sentence rotates through pickDayVariant, speaks in
// plain words, and never hands the athlete a number as a grade.
// ============================================================================
import { brainSignal } from "../brain/snapshot.js";
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import {
  harmEvidenceOnDay,
  LEARNED_TRAIN_WINDOW_DAYS,
  personalBand,
  readAdherenceModel,
  trainsAnywayWithoutHarm,
  withMorningReadiness,
} from "./brain/read-adherence.js";
import { RECOVERY_BASELINE_MAX_POINTS } from "./baseline-bands.js";
import { getCheckinByDate, getRecoverySummary } from "./coach.js";
import { acuteGates, strengthLegLoad } from "./hybrid-load.js";
import { runVolumeSpikeRead } from "./program-state.js";
import { WEARABLE_TREND_MIN_NIGHTS, WEARABLE_TREND_WINDOW_DAYS } from "./propagation-data.js";
import { LOW_READINESS, readsRestGradeReadiness, SUPPORTIVE_READINESS } from "./readiness-bands.js";
import { SHORT_NIGHT_MIN } from "./recovery-science.js";
import { recoveryTrendBars } from "./recovery-trend.js";
import { runDaySteer, runDaySteerKey } from "./run-day-steer.js";
import { isLastNight, isReadDayReadiness, SENSOR_MAX_AGE_DAYS } from "./sensor-freshness.js";
import { addDaysISO } from "./shared.js";
import { activeRelevantTrainingSymptoms, activeSystemicTrainingSymptoms } from "./training-symptoms.js";
import { round1 } from "../lib/numbers.js";

export type RunDayKind = "easy" | "quality" | "long";
// "rest": a hard floor (rest-grade readiness, illness, pain the run loads) — no run is
// prescribed; rest, or optional easy movement. The Brief says rest on those mornings.
export type RunDayDose = "full" | "short" | "shortened" | "rest";

// The week's structure the morning never re-decides (see the header).
export type RunDayLock = "race_day" | "taper" | "recovery_week" | "health_hold" | "pending";

export interface RunDayPlanned {
  kind_label: RunDayKind;
  /** "short" marks a trimmed week's quality session: kept only on a green morning. */
  dose?: "full" | "short" | null;
  label?: string | null;
  target_distance_km?: number | null;
  race?: true;
}

export interface RunDayIntensity {
  date: string;
  planned_kind: RunDayKind;
  planned_dose: "full" | "short";
  kind: RunDayKind;
  dose: RunDayDose;
  /** The morning's distance: the planned one, or a shortened long run's. */
  target_distance_km: number | null;
  /** Machine register ("green_keeps_short", "floor:hrv_below_own_band", …). Never rendered. */
  reason_code: string;
  supports: string[];
  /** Every brake that fired, floors included. */
  brakes: string[];
  /** The subset of `brakes` that are safety floors. */
  floors: string[];
  locks: RunDayLock[];
  athlete_word: "up" | "down" | null;
  /** The morning moved the day off what the week planned (kind or dose). */
  changed: boolean;
  /** One calm sentence for the athlete (variant set, reading-grammar clean). */
  why: string;
}

// ---------- the evidence ----------

// Plain-word causes, one per code. Third person about the body, second person about
// what the athlete said — the register every Brief sentence uses. No numbers.
const FLOOR_WORDS: Readonly<Record<string, string>> = {
  rest_grade_readiness: "readiness is reading very low this morning",
  hrv_below_own_band: "HRV is still settling below your usual",
  rhr_above_own_band: "resting heart rate is running above your usual",
  short_night: "last night was a short one",
  felt_run_down: "you checked in feeling run-down",
  high_soreness: "you're carrying a lot of soreness",
  legs_deep: "the legs are still deep in the last lower-body session",
  harm_yesterday: "yesterday's work is still being absorbed",
  volume_spike: "the running has jumped well above your recent weeks",
  pain_or_injury: "that sore spot is still active",
  illness: "you're under the weather",
};
// The HARD floors: the morning the Brief itself rests (rest-grade readiness is rest,
// softenable only to easy movement), a sick athlete, pain the run loads. On these no run
// is prescribed at all — not a shortened long run, not a full-distance easy one — on ANY
// run day (easy days included) and through the week's locks; only race day itself is the
// athlete's own call. The milder floors (a short night, HRV/RHR past the own band, the
// legs, a run-down check-in, a volume spike…) turn quality easy and shorten a long run.
export const HARD_RUN_FLOORS: ReadonlySet<string> = new Set(["rest_grade_readiness", "illness", "pain_or_injury"]);
const SOFT_BRAKE_WORDS: Readonly<Record<string, string>> = {
  readiness_subdued: "readiness is on the quiet side",
  legs_carrying_lift: "the legs are still carrying the lifting",
  recovery_trend_down: "recovery has dipped over the last stretch",
  watch_strained: "your watch reads the training as strained",
};
const SUPPORT_WORDS: Readonly<Record<string, string>> = {
  readiness_supportive: "readiness is good",
  hrv_at_usual: "HRV is right where it usually sits",
  rhr_at_usual: "resting heart rate is steady",
  slept_enough: "sleep was solid",
  felt_good: "you feel good",
  rested: "you feel rested",
  legs_feel_fresh: "the legs feel fresh",
  legs_clear: "the legs are clear of the lifting",
  trains_anyway_clean: "days like this have been going down well",
  harm_free_recent: "the recent work has landed well",
  fitness_improving: "your fitness is trending up",
};
// Supports read off THIS morning (a sensor dated today, the athlete's own check-in).
// A green morning needs at least one: history can tip a decision, never originate one.
const FRESH_SUPPORTS: ReadonlySet<string> = new Set([
  "readiness_supportive",
  "hrv_at_usual",
  "rhr_at_usual",
  "slept_enough",
  "felt_good",
  "rested",
  "legs_feel_fresh",
]);
// Order floors are named in when several fire: the body's own answer first.
const FLOOR_ORDER = Object.keys(FLOOR_WORDS);
const SOFT_ORDER = Object.keys(SOFT_BRAKE_WORDS);
const SUPPORT_ORDER = Object.keys(SUPPORT_WORDS);

export interface RunMorningEvidence {
  floors: string[];
  soft_brakes: string[];
  supports: string[];
  athlete_word: "up" | "down" | null;
  /**
   * Did anything from THIS morning come in — a readiness reading dated today, last
   * night's sleep or a verified overnight HRV/RHR, a check-in, the athlete's word?
   * False before the morning syncs: the read then says nothing about the morning
   * (absent is never "quiet"). Omitted (a hand-built evidence) reads as present.
   */
  morning_read?: boolean;
}

const LOWER_GROUPS = ["quads", "hamstrings", "glutes", "calves"] as const;
// An injury NAMED somewhere running loads. Structured symptom events go through the
// pain-relevance map below; this is the fallback for a context-event title, which is a
// label rather than a recognized area.
const LOWER_BODY_WORDS =
  /\b(?:knee|ankle|achilles|calf|calves|shin|foot|feet|heel|plantar|hip|groin|hamstring|quad|glute|it band|lower back|back)\b/i;
// How far back one night's own band reads (the same window the harm arms use).
const OWN_BAND_NIGHTS = RECOVERY_BASELINE_MAX_POINTS;
// A VO2max step worth calling a trend, and the predictor's relative step.
const VO2_IMPROVING_STEP = 0.5;
const PREDICTOR_IMPROVING_FRACTION = 0.01;
const FITNESS_TREND_DAYS = 28;
const HARM_FREE_WINDOW_DAYS = 7;
const HARM_FREE_MIN_TRAINED_DAYS = 2;

function safe<T>(compute: () => T, fallback: T): T {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

function positive(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Last night's HRV and resting HR against the athlete's OWN nights before it — the
// same line the harm arms charge a bad morning against (personalBand in
// read-adherence.ts: their mean less/plus one of their own standard deviations, never
// narrower than recoveryTrendBars). Below the line brakes; at or above their own mean
// supports; between the two is neutral. Only the night dated the read day speaks (the
// one-night law).
//
// Both sides read the recovery summary's VERIFIED series (coach.ts READING_TRUST): only
// a verified reading may open a caution, and a contradicted one — the provisional
// mid-day resting HR far above the same source's own floor — may not vouch for the
// morning either. An unwitnessed reading is simply not spoken of: absent, never low.
function lastNightOwnBand(
  date: string,
  rec: any
): { hrv: "below" | "usual" | null; rhr: "above" | "usual" | null; tonight: boolean } {
  const from = addDaysISO(date, -(OWN_BAND_NIGHTS + SENSOR_MAX_AGE_DAYS.hrv));
  const read = (field: "hrv_ms" | "resting_hr") => {
    const byDate = new Map<string, number>();
    for (const reading of Array.isArray(rec?.verified?.[field]?.readings) ? rec.verified[field].readings : []) {
      const day = String(reading?.date ?? "").slice(0, 10);
      const value = positive(reading?.value);
      if (!day || value == null || byDate.has(day)) continue;
      byDate.set(day, value);
    }
    const prior = [...byDate.entries()].filter(([day]) => day < date && (!from || day >= from)).map(([, v]) => v);
    return { tonight: byDate.get(date) ?? null, band: personalBand(prior, field) };
  };
  const hrvRead = read("hrv_ms");
  const rhrRead = read("resting_hr");
  let hrv: "below" | "usual" | null = null;
  if (hrvRead.tonight != null && hrvRead.band) {
    hrv = hrvRead.tonight < hrvRead.band.line ? "below" : hrvRead.tonight >= hrvRead.band.mean ? "usual" : null;
  }
  let rhr: "above" | "usual" | null = null;
  if (rhrRead.tonight != null && rhrRead.band) {
    rhr = rhrRead.tonight > rhrRead.band.line ? "above" : rhrRead.tonight <= rhrRead.band.mean ? "usual" : null;
  }
  return { hrv, rhr, tonight: hrvRead.tonight != null || rhrRead.tonight != null };
}

// ---------------------------------------------------------------------------
// THE RECOVERY DIP — a stretch of nights past the athlete's own band, never one night
// and never a missing one.
//
// The weekly run engine used to read the dip off `recovery.delta` — the 7-day median
// minus the 30-day median — which is a median of WHATEVER nights happen to have synced.
// On an episodically-worn watch that window holds four or five readings, so one late
// sync moved the median across the line: one night not having landed yet cut a normal
// week by about a third and nearly halved its long run, and the week flipped back when
// the row arrived. Absence became a finding.
//
// So the dip is now read off the NIGHTS themselves. A signal dips when the newest
// RECOVERY_DIP_MIN_NIGHTS readings inside the last RECOVERY_DIP_WINDOW_DAYS all sit past
// the athlete's OWN line — the same line one morning's floor uses (their baseline less
// one of their own standard deviations, never narrower than recoveryTrendBars; for HRV
// never narrower than the owner's 7% band either). Consecutive READINGS, not calendar
// days: a night that never synced is simply not in the list, so it can neither start a
// dip (it is not low) nor end one (it is not usual). The newest of them must still be
// current (SENSOR_MAX_AGE_DAYS) — a stale reading behaves as absent. Too few readings,
// no baseline, or no measured spread of the athlete's own → no dip at all.
//
// HRV and resting HR read the summary's VERIFIED series (only a verified reading may
// open a caution); sleep is self-verifying and reads the wake-dated nights directly.
export const RECOVERY_DIP_WINDOW_DAYS = WEARABLE_TREND_WINDOW_DAYS;
export const RECOVERY_DIP_MIN_NIGHTS = WEARABLE_TREND_MIN_NIGHTS;
// The owner's 7% HRV band (2026-08-17, `hrvReadsDown` in run-progression.ts reads the
// same number): the per-night line never sits closer to the baseline than this.
export const HRV_DIP_MIN_RELATIVE_DROP = 0.07;

export interface RecoveryDipRead {
  down: boolean;
  hrv: boolean;
  rhr: boolean;
  sleep: boolean;
}

type DatedReading = { date: string; value: number };

// PURE: the newest `RECOVERY_DIP_MIN_NIGHTS` readings in the window ending `asOf`, all
// past the line, the newest of them current. One reading per date (the first seen wins).
export function sustainedPastOwnLine(
  readings: readonly DatedReading[] | null | undefined,
  asOf: string,
  past: (value: number) => boolean,
  maxAgeDays: number
): boolean {
  const from = addDaysISO(asOf, -(RECOVERY_DIP_WINDOW_DAYS - 1));
  if (!from) return false;
  const byDate = new Map<string, number>();
  for (const reading of Array.isArray(readings) ? readings : []) {
    const date = String(reading?.date ?? "").slice(0, 10);
    const value = positive(reading?.value);
    if (!date || value == null || date < from || date > asOf || byDate.has(date)) continue;
    byDate.set(date, value);
  }
  const newest = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, RECOVERY_DIP_MIN_NIGHTS);
  if (newest.length < RECOVERY_DIP_MIN_NIGHTS) return false;
  const newestAge = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${newest[0][0]}T00:00:00Z`)) / 864e5);
  if (!Number.isFinite(newestAge) || newestAge > maxAgeDays) return false;
  return newest.every(([, value]) => past(value));
}

// The wake-dated sleep nights in the dip window, Garmin preferred per date.
function sleepNights(asOf: string): DatedReading[] {
  const from = addDaysISO(asOf, -(RECOVERY_DIP_WINDOW_DAYS - 1));
  if (!from) return [];
  const rows = safe(
    () =>
      db
        .prepare(
          `SELECT 0 AS pref, date, sleep_min FROM garmin_daily_metrics WHERE date >= ? AND date <= ? AND sleep_min > 0
           UNION ALL
           SELECT 1 AS pref, date, sleep_min FROM daily_metrics WHERE date >= ? AND date <= ? AND sleep_min > 0
           ORDER BY pref`
        )
        .all(from, asOf, from, asOf) as any[],
    [] as any[]
  );
  return rows.map((row) => ({ date: String(row.date ?? "").slice(0, 10), value: Number(row.sleep_min) }));
}

/**
 * Is recovery genuinely dipping as of `asOf`? `recovery` is a getRecoverySummary view
 * (its `baseline`, `dispersion` and `verified` series). Absent evidence reads `down:false`.
 */
export function recoveryDipRead(recovery: any, asOf: string): RecoveryDipRead {
  const bars = recoveryTrendBars(recovery?.baseline, recovery?.dispersion);
  // The own line for one signal: its baseline and the athlete's own measured spread are
  // both required — a band with no spread behind it is not the athlete's band.
  const line = (key: "hrv" | "rhr" | "sleep"): { base: number; width: number } | null => {
    const base = positive(recovery?.baseline?.[key]);
    const sd = positive(recovery?.dispersion?.[key]);
    if (base == null || sd == null) return null;
    const floor = key === "hrv" ? base * HRV_DIP_MIN_RELATIVE_DROP : 0;
    return { base, width: Math.max(bars[key], sd, floor) };
  };
  const hrvLine = line("hrv");
  const rhrLine = line("rhr");
  const sleepLine = line("sleep");
  const hrv =
    !!hrvLine &&
    sustainedPastOwnLine(
      recovery?.verified?.hrv_ms?.readings,
      asOf,
      (value) => value < hrvLine.base - hrvLine.width,
      SENSOR_MAX_AGE_DAYS.hrv
    );
  const rhr =
    !!rhrLine &&
    sustainedPastOwnLine(
      recovery?.verified?.resting_hr?.readings,
      asOf,
      (value) => value > rhrLine.base + rhrLine.width,
      SENSOR_MAX_AGE_DAYS.resting_hr
    );
  const sleep =
    !!sleepLine &&
    sustainedPastOwnLine(
      safe(() => sleepNights(asOf), [] as DatedReading[]),
      asOf,
      (value) => value < sleepLine.base - sleepLine.width,
      SENSOR_MAX_AGE_DAYS.sleep
    );
  return { down: hrv || rhr || sleep, hrv, rhr, sleep };
}

// Is fitness trending UP? VO2max, then the watch's half-marathon predictor, each read
// now against the newest reading at least FITNESS_TREND_DAYS older. Only an
// improvement counts — a flat or falling trend is simply not a support, never a brake.
function fitnessImproving(date: string): boolean {
  const anchor = addDaysISO(date, -FITNESS_TREND_DAYS);
  const since = addDaysISO(date, -(FITNESS_TREND_DAYS + 90));
  const recentFloor = addDaysISO(date, -SENSOR_MAX_AGE_DAYS.fitness_marker);
  if (!anchor || !since || !recentFloor) return false;
  const pair = (column: "vo2max" | "race_predict_half_sec"): [number, number] | null =>
    safe(() => {
      const now = db
        .prepare(
          `SELECT ${column} AS v FROM garmin_daily_metrics
            WHERE date >= ? AND date <= ? AND ${column} > 0 ORDER BY date DESC LIMIT 1`
        )
        .get(recentFloor, date) as any;
      const then = db
        .prepare(
          `SELECT ${column} AS v FROM garmin_daily_metrics
            WHERE date >= ? AND date <= ? AND ${column} > 0 ORDER BY date DESC LIMIT 1`
        )
        .get(since, anchor) as any;
      const a = positive(now?.v);
      const b = positive(then?.v);
      return a != null && b != null ? ([a, b] as [number, number]) : null;
    }, null);
  const vo2 = pair("vo2max");
  if (vo2 && vo2[0] - vo2[1] >= VO2_IMPROVING_STEP) return true;
  const half = pair("race_predict_half_sec");
  return !!half && half[1] - half[0] >= half[1] * PREDICTOR_IMPROVING_FRACTION;
}

// The last week's training, harm-free: at least two trained days before today and none
// of them carrying harm evidence. Positive evidence only — an empty week vouches for
// nothing.
function recentHarmFree(date: string): boolean {
  const from = addDaysISO(date, -HARM_FREE_WINDOW_DAYS);
  const through = addDaysISO(date, -1);
  if (!from || !through) return false;
  const days = safe(
    () =>
      (
        db
          .prepare(
            `SELECT DISTINCT s.date AS date FROM sessions s JOIN logged_sets l ON l.session_id = s.id
              WHERE s.date >= ? AND s.date <= ?
             UNION
             SELECT DISTINCT date FROM activities WHERE date >= ? AND date <= ?`
          )
          .all(from, through, from, through) as any[]
      ).map((row) => String(row.date)),
    [] as string[]
  );
  if (days.length < HARM_FREE_MIN_TRAINED_DAYS) return false;
  return days.every((day) => safe(() => harmEvidenceOnDay(day), null) == null);
}

// Pain the RUN loads (a structured symptom on the legs, a lower-body injury, a painful
// joint on a recent session), or illness. The pain map is conservative on purpose: an
// unrecognized area loads nothing.
function painOrIllness(date: string): { pain: boolean; illness: boolean } {
  const pain =
    LOWER_GROUPS.some(
      (group) =>
        safe(
          () => activeRelevantTrainingSymptoms(date, { name: "run", muscle_group: group }, { seed_legacy: false }),
          []
        ).length > 0
    ) ||
    safe(() => {
      const rows = db
        .prepare(
          `SELECT title FROM context_events
            WHERE kind = 'injury' AND (archived IS NULL OR archived = 0) AND resolved_at IS NULL
              AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)`
        )
        .all(date, date) as any[];
      return rows.some((row) => LOWER_BODY_WORDS.test(String(row.title ?? "")));
    }, false) ||
    safe(() => {
      const rows = db
        .prepare(
          `SELECT joint_pain FROM sessions
            WHERE date >= ? AND date <= ? AND joint_pain IS NOT NULL AND TRIM(joint_pain) != ''`
        )
        .all(addDaysISO(date, -3) ?? date, date) as any[];
      return rows.some((row) => LOWER_BODY_WORDS.test(String(row.joint_pain ?? "")));
    }, false);
  const illness =
    safe(() => activeSystemicTrainingSymptoms(date, { seed_legacy: false }).length > 0, false) ||
    safe(
      () =>
        !!db
          .prepare(
            `SELECT 1 FROM context_events
              WHERE kind IN ('illness','sick') AND (archived IS NULL OR archived = 0) AND resolved_at IS NULL
                AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) LIMIT 1`
          )
          .get(date, date),
      false
    );
  return { pain, illness };
}

// ---------- the athlete's own word today ----------
// The existing channels, nothing new: a check-in note (the app's check-in, or chat's
// log_checkin, which stores the athlete's sentence verbatim) and the Brief's steer
// (recorded on the day's suggestion row — and, for the steered read itself, held in
// scope by run-day-steer.ts). The newest statement of the day wins.
//
// SAFETY FIRST. The word can only OPEN a session when it is unambiguous, so the reading
// is asymmetric:
//   • DOWN on any cue that the body is not right or the athlete wants less — pain or
//     injury words, illness, poor sleep, fatigue, an easier/shorter/skipped day, dislike
//     ("hate hills") — and on any negation near a positive ("not feeling great", "do not
//     push it", "no hills"). One such cue anywhere makes the whole note DOWN, so a mixed
//     note ("feel good but my knee hurts") is down.
//   • UP only on an explicit ask for the work ("hills today", "let's do the intervals",
//     "go hard", "push it", "train anyway", "up for it") or a clear "feel great / strong
//     / fresh", with no down cue anywhere in the note. A bare mention ("quality",
//     "tempo", "push") or a lukewarm "feel fine" says nothing.
const WORD_PAIN_OR_ILLNESS =
  /\b(?:hurts?|hurting|pain(?:ful|s)?|sore(?:ness)?|ach(?:e|es|y|ing)|injur(?:y|ed|ies)|tweak(?:ed)?|niggl(?:e|es|y|ing)|twinges?|strain(?:ed)?|pulled|tight(?:ness)?|stiff(?:ness)?|swollen|limp(?:ing)?|cold|flu|fever(?:ish)?|ill(?:ness)?|sick|covid|cough(?:ing)?|congest(?:ed|ion)|nause(?:a|ous)|dizzy|headache|migraine|under the weather|run[- ]?down)\b/i;
const WORD_FATIGUE_OR_LESS =
  /\b(?:tired|exhausted|wrecked|knackered|drained|fatigued?|shattered|spent|flat|sluggish|heavy legs|legs (?:are|feel) heavy|rough (?:night|sleep|day)|poor(?:ly)?|bad(?:ly)?|awful|terrible|lousy|crappy|meh|barely slept|didn'?t sleep|no sleep|easy day|easier|go easy|take it easy|keep it easy|easy (?:today|one|run)|rest(?: day| up)?|recover(?:y|ing)?|day off|skip(?:ping)?|short on time|no time|busy|not up for|hate|dread(?:ing)?|don'?t (?:want|fancy|feel like)|do not (?:want|feel like))\b/i;
const WORD_NEGATED_POSITIVE =
  /\b(?:not|no|never|don'?t|do not|didn'?t|did not|isn'?t|wasn'?t|aren'?t|can'?t|cannot|won'?t|without)\b(?:\W+\w+){0,3}?\W+(?:good|great|fresh|strong|ready|well|fine|rested|recovered|energ\w*|push\w*|hills?|intervals?|tempo|threshold|quality|hard|up)\b/i;
const WORD_UP_FEEL =
  /\b(?:feel(?:s|ing)?|felt|legs (?:are|feel)|i'?m|i am)\s+(?:really\s+|so\s+|very\s+|super\s+|pretty\s+)?(?:great|strong|fresh|amazing|awesome|fantastic|springy|bouncy)\b/i;
const WORD_UP_ASK =
  /\b(?:(?:hills?|intervals?|tempo|threshold|quality|speed(?:work| work)?|reps)\s+(?:today|please|it is|it'?s on|are on|is on)|(?:let'?s|want to|wanna|keen to|ready to|going to|gonna|i'?ll)\s+(?:do|run|hit|go for|smash)\s+(?:the\s+|some\s+)?(?:hills?|intervals?|tempo|threshold|quality|speed(?:work| work)?|reps|session)|(?:up for|ready for|keen for|bring on|time for|go for)\s+(?:the\s+|some\s+)?(?:hills?|intervals?|tempo|threshold|quality|speed(?:work| work)?|reps|it)|go hard|push (?:it|hard)|let'?s push|want to push|train anyway|ready to go)\b/i;

export function classifyRunWord(text: unknown): "up" | "down" | null {
  const sentence = String(text ?? "")
    .replace(/[‘’ʼ]/g, "'")
    .trim();
  if (!sentence) return null;
  if (
    WORD_PAIN_OR_ILLNESS.test(sentence) ||
    WORD_FATIGUE_OR_LESS.test(sentence) ||
    WORD_NEGATED_POSITIVE.test(sentence)
  )
    return "down";
  if (WORD_UP_ASK.test(sentence) || WORD_UP_FEEL.test(sentence)) return "up";
  return null;
}

function athleteWordToday(date: string): "up" | "down" | null {
  // The steer this very read is being computed for is the newest statement there is.
  const steer = runDaySteer(date);
  if (steer) {
    const word = classifyRunWord(steer);
    if (word) return word;
  }
  const statements = safe(
    () =>
      db
        .prepare(
          `SELECT created_at AS at, note AS text FROM checkins
            WHERE date = ? AND note IS NOT NULL AND TRIM(note) != ''
           UNION ALL
           SELECT created_at AS at, json_extract(payload_json, '$.override') AS text FROM suggestions
            WHERE kind = 'day_read' AND date = ? AND payload_json IS NOT NULL
              AND json_extract(payload_json, '$.override') IS NOT NULL
           ORDER BY at DESC`
        )
        .all(date, date) as any[],
    [] as any[]
  );
  for (const row of statements) {
    const word = classifyRunWord(row.text);
    if (word) return word;
  }
  return null;
}

// Readiness dated the read day, from the summary (the morning value where the ledger has
// it). `Number(null)` is 0 and 0 is rest-grade, so absence is tested before the coercion.
function readDayReadiness(rec: any, date: string): number | null {
  const raw = rec?.recovery?.training_readiness;
  const value = raw == null || raw === "" ? null : Number(raw);
  if (value == null || !Number.isFinite(value)) return null;
  return isReadDayReadiness(rec?.quality?.training_readiness?.latest_date ?? null, date) ? value : null;
}

function morningRecovery(date: string): any {
  return brainSignal(`run_morning_rec:${date}`, () =>
    safe(() => withMorningReadiness(getRecoverySummary(14, undefined, date), date), null as any)
  );
}

// The HARD floors alone — cheap enough for every run day, easy and locked days
// included (the full evidence below is only needed where the morning decides).
export function runHardFloors(date: string): string[] {
  return brainSignal(`run_morning_hard:${date}`, () => {
    const floors = new Set<string>();
    const readiness = readDayReadiness(morningRecovery(date), date);
    if (readiness != null && readsRestGradeReadiness(readiness)) floors.add("rest_grade_readiness");
    const { pain, illness } = painOrIllness(date);
    if (pain) floors.add("pain_or_injury");
    if (illness) floors.add("illness");
    return FLOOR_ORDER.filter((code) => floors.has(code));
  });
}

// Everything the morning knows, once per date per request. A steered read computes
// under its own key (run-day-steer.ts), so the steer never leaks into the canonical one.
export function runMorningEvidence(date: string): RunMorningEvidence {
  return brainSignal(`run_morning:${date}${runDaySteerKey() ? `:${runDaySteerKey()}` : ""}`, () =>
    runMorningEvidenceUncached(date)
  );
}

function runMorningEvidenceUncached(date: string): RunMorningEvidence {
  const floors = new Set<string>();
  const soft = new Set<string>();
  const supports = new Set<string>();
  let morningRead = false;

  const rec = morningRecovery(date);
  // Readiness: one reading, dated the read day.
  const readiness = readDayReadiness(rec, date);
  if (readiness != null) {
    morningRead = true;
    if (readsRestGradeReadiness(readiness)) floors.add("rest_grade_readiness");
    else if (readiness < LOW_READINESS) soft.add("readiness_subdued");
    else if (readiness >= SUPPORTIVE_READINESS) supports.add("readiness_supportive");
  }
  // Last night: sleep (the wake-dated night), HRV and resting HR against the OWN band.
  const sleepMin = positive(rec?.recovery?.sleep_min);
  if (sleepMin != null && isLastNight(rec?.quality?.sleep_min?.latest_date ?? null, date)) {
    morningRead = true;
    if (sleepMin < SHORT_NIGHT_MIN) floors.add("short_night");
    else supports.add("slept_enough");
  }
  const own = safe(() => lastNightOwnBand(date, rec), { hrv: null, rhr: null, tonight: false } as ReturnType<
    typeof lastNightOwnBand
  >);
  if (own.tonight) morningRead = true;
  if (own.hrv === "below") floors.add("hrv_below_own_band");
  else if (own.hrv === "usual") supports.add("hrv_at_usual");
  if (own.rhr === "above") floors.add("rhr_above_own_band");
  else if (own.rhr === "usual") supports.add("rhr_at_usual");
  // The trailing recovery dip weekly volume already answers — soft here, never a floor.
  // The same nights-past-the-own-line read the week uses, so a missing night is absent
  // here too: it neither brakes nor supports. (When the week's trim IS the dip, the
  // decision drops this brake — see RunDayOptions.weekAnswersDip.)
  if (rec && safe(() => recoveryDipRead(rec, date).down, false)) soft.add("recovery_trend_down");
  // The watch's own training status reading strained / overreaching — the same fatigue
  // tell the weekly volume reads, and only while it is current.
  const statusFresh = ["fresh", "recent"].includes(String(rec?.quality?.training_status?.freshness ?? ""));
  if (statusFresh && /strain|overreach|unproductive/i.test(String(rec?.recovery?.training_status ?? "")))
    soft.add("watch_strained");

  // The athlete's own check-in: 1–5, 3 is neutral. Soreness runs the other way (≥4 is
  // a lot of soreness), exactly as the signal state reads it.
  const checkin = safe(() => getCheckinByDate(date) as any, null);
  if (checkin) morningRead = true;
  const energy = checkin?.energy == null ? null : Number(checkin.energy);
  const sleepFeel = checkin?.sleep_feel == null ? null : Number(checkin.sleep_feel);
  const soreness = checkin?.soreness == null ? null : Number(checkin.soreness);
  if ((energy != null && energy <= 2) || (sleepFeel != null && sleepFeel <= 2)) floors.add("felt_run_down");
  if (energy != null && energy >= 4) supports.add("felt_good");
  if (sleepFeel != null && sleepFeel >= 4) supports.add("rested");
  if (soreness != null && soreness >= 4) floors.add("high_soreness");
  else if (soreness != null && soreness <= 2) supports.add("legs_feel_fresh");

  // The legs: the one acute answer (deep moves a session, shallow holds it) and the
  // composite leg-day read the run builder already uses.
  const gates = safe(() => acuteGates(date), new Map() as ReturnType<typeof acuteGates>);
  const lower = LOWER_GROUPS.map((group) => gates.get(group)).filter((gate) => !!gate);
  const legLoad = safe(() => strengthLegLoad(date), null as ReturnType<typeof strengthLegLoad> | null);
  if (lower.some((gate) => gate?.deep)) floors.add("legs_deep");
  else if (lower.some((gate) => gate?.saturated) || legLoad?.band === "saturated") soft.add("legs_carrying_lift");
  else if (legLoad && legLoad.band === "fresh") supports.add("legs_clear");

  // Yesterday's work, as the one harm test reads it. Its next-morning arms (a rest-grade
  // readiness, last night past the own band) ARE this morning's readings, already
  // floors above — naming them twice would charge one night as two causes.
  const yesterday = addDaysISO(date, -1);
  const harm = yesterday ? safe(() => harmEvidenceOnDay(yesterday), null) : null;
  if (harm && harm.kind !== "physiology_brake" && harm.kind !== "readiness_rest_grade") floors.add("harm_yesterday");

  // The running week against the three before it — the Brief's own volume spike
  // (runVolumeSpikeRead, the one definition). A floor: the Brief reads a spiking week
  // easy, so the run engine must never keep a hard session on it, and no word opens one.
  if (safe(() => runVolumeSpikeRead(date).volume_spike, false)) floors.add("volume_spike");

  const { pain, illness } = painOrIllness(date);
  if (pain) floors.add("pain_or_injury");
  if (illness) floors.add("illness");

  // The athlete's record: trains through quiet reads without harm, a harm-free week,
  // fitness moving the right way.
  const learned = safe(
    () =>
      brainSignal(`train_anyway:${date}`, () =>
        trainsAnywayWithoutHarm(
          readAdherenceModel(date, LEARNED_TRAIN_WINDOW_DAYS + 2, LEARNED_TRAIN_WINDOW_DAYS + 2),
          date
        )
      ),
    null
  );
  if (learned && learned.weight > 0) supports.add("trains_anyway_clean");
  if (!floors.has("harm_yesterday") && recentHarmFree(date)) supports.add("harm_free_recent");
  if (safe(() => fitnessImproving(date), false)) supports.add("fitness_improving");

  const word = athleteWordToday(date);
  if (word) morningRead = true;
  return {
    floors: FLOOR_ORDER.filter((code) => floors.has(code)),
    soft_brakes: SOFT_ORDER.filter((code) => soft.has(code)),
    supports: SUPPORT_ORDER.filter((code) => supports.has(code)),
    athlete_word: word,
    morning_read: morningRead,
  };
}

// ---------- the athlete-facing sentences (variant sets) ----------
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayOf(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? WEEKDAYS[new Date(ms).getUTCDay()] : "today";
}
// What the session is called in a sentence ("hills", "intervals", "tempo").
function sessionWord(label: unknown): string {
  const text = String(label ?? "").toLowerCase();
  if (/hill/.test(text)) return "hills";
  if (/tempo/.test(text)) return "tempo";
  if (/threshold/.test(text)) return "threshold reps";
  if (/interval|vo2|800/.test(text)) return "intervals";
  return "quality session";
}
function joinCauses(words: string[]): string {
  const two = words.slice(0, 2);
  return two.length === 2 ? `${two[0]} and ${two[1]}` : (two[0] ?? "");
}
// The leading supports, THIS morning's first.
function supportPhrase(supports: string[]): string {
  const ordered = [...supports.filter((s) => FRESH_SUPPORTS.has(s)), ...supports.filter((s) => !FRESH_SUPPORTS.has(s))];
  return joinCauses(ordered.map((code) => SUPPORT_WORDS[code]).filter(Boolean));
}

type Say = (cause: string, day: string, session: string) => string;

export const RUN_DAY_KEEP_SHORT_VARIANTS: readonly Say[] = [
  (cause, day, session) => `${cap(cause)} — keep ${day}'s ${session}, a shorter set this week.`,
  (cause, _day, session) => `${cap(cause)}, so the ${session} stay on today — fewer reps, same quality.`,
  (cause, day, session) =>
    `${cap(cause)} — ${day}'s ${session} are on, trimmed to a short set while the week stays light.`,
];
export const RUN_DAY_KEEP_FULL_VARIANTS: readonly Say[] = [
  (cause, day, session) => `${cap(cause)} — ${day}'s ${session} are on as planned.`,
  (cause, _day, session) => `${cap(cause)}, so today's ${session} stay just as planned.`,
  (cause, day, session) => `${cap(cause)} — a good morning for ${day}'s ${session}.`,
];
export const RUN_DAY_NEUTRAL_KEEP_VARIANTS: readonly Say[] = [
  (_cause, day, session) => `Nothing this morning argues with it — ${day}'s ${session} stay on.`,
  (_cause, _day, session) => `The morning reads steady, so today's ${session} go ahead as planned.`,
  (_cause, day, session) => `No reason to change course — ${day}'s ${session} are on.`,
];
export const RUN_DAY_WORD_UP_VARIANTS: readonly Say[] = [
  (_cause, day, session) =>
    `You said you're up for it and nothing this morning says otherwise — ${day}'s ${session} are on.`,
  (_cause, _day, session) => `Your call, and the morning backs it — today's ${session} go ahead.`,
  (_cause, day, session) => `You feel ready and nothing is braking — ${day}'s ${session} stay on the card.`,
];
export const RUN_DAY_WORD_UP_SHORT_VARIANTS: readonly Say[] = [
  (_cause, day, session) =>
    `You said you're up for it and nothing this morning says otherwise — ${day}'s ${session} are on, a shorter set this week.`,
  (_cause, _day, session) =>
    `Your call, and the morning backs it — today's ${session} go ahead, kept short while the week stays light.`,
  (_cause, day, session) =>
    `You feel ready and nothing is braking — ${day}'s ${session} stay on, trimmed to a short set.`,
];
// The easy-day sentences promise the session no particular later day: the agenda closes
// a quality day that was run, so "the hills wait for a fresher day" could not be kept.
export const RUN_DAY_EASY_FLOOR_VARIANTS: readonly Say[] = [
  (cause, _day, session) => `${cap(cause)} — make today easy; the ${session} can wait.`,
  (cause, day, session) => `${cap(cause)}, so ${day} becomes an easy run and the ${session} come round again.`,
  (cause, _day, session) => `${cap(cause)} — an easy, conversational run today; the ${session} will come round again.`,
];
export const RUN_DAY_EASY_BRAKES_VARIANTS: readonly Say[] = [
  (cause, _day, session) => `${cap(cause)} — an easy run is the better call today; the ${session} can wait.`,
  (cause, day, session) => `${cap(cause)}, so ${day} reads easy and the ${session} come round again.`,
  (cause, _day, session) => `${cap(cause)} — easy running today; the ${session} will come round again.`,
];
export const RUN_DAY_EASY_NEUTRAL_VARIANTS: readonly Say[] = [
  (_cause, _day, session) =>
    `It's a lighter week and this morning isn't asking for more — keep it easy; the ${session} come back with the next build.`,
  (_cause, day, session) =>
    `A lighter week, and nothing this morning is pulling for the ${session} — ${day} stays easy unless you feel up for a short set.`,
  (_cause, _day, session) =>
    `Easy running today: the week is trimmed and the morning is quiet, so the ${session} can wait.`,
];
// A trimmed week's quality day before anything from the morning has come in. Absent is
// never "quiet": these say what the week planned and what would open the short set, and
// stay true once the morning lands (the Brief pins one wording per identity).
export const RUN_DAY_EASY_PENDING_VARIANTS: readonly Say[] = [
  (_cause, day, session) =>
    `A lighter week — ${day} is an easy run as planned, and the short ${session} set opens on a morning that's clearly ready for it.`,
  (_cause, _day, session) =>
    `The week is trimmed, so today starts as an easy run; the short ${session} set is there if the morning backs it, or if you say you're up for it.`,
  (_cause, _day, session) =>
    `Easy running is the plan for today in a lighter week — the short ${session} set waits for a morning that clearly reads ready.`,
];
export const RUN_DAY_WORD_DOWN_VARIANTS: readonly Say[] = [
  (_cause, _day, session) => `You asked for an easier day — easy it is; the ${session} can wait.`,
  (_cause, day, session) => `Taking your word for it — ${day} goes easy and the ${session} keep.`,
  (_cause, _day, session) => `Easy today, as you said; the ${session} will come round again.`,
];
// A HARD floor: no run at all today, whatever the week planned. `session` names the
// run the week put here ("the hills", "the long run", "the run").
export const RUN_DAY_REST_FLOOR_VARIANTS: readonly Say[] = [
  (cause, _day, session) =>
    `${cap(cause)} — today reads as rest rather than a run; an easy walk if you'd like to move, and ${session} can wait.`,
  (cause, day, session) =>
    `${cap(cause)}, so ${day} is better as a rest day than a run — gentle movement only if it feels good; ${session} can wait.`,
  (cause, _day, session) =>
    `${cap(cause)} — let today be rest instead of a run, an easy walk at most; ${session} will keep.`,
];
export const RUN_DAY_LONG_SHORTEN_VARIANTS: readonly Say[] = [
  (cause) => `${cap(cause)} — keep the long run, but shorter and fully easy today.`,
  (cause, day) => `${cap(cause)}, so ${day}'s long run is shorter today and stays conversational throughout.`,
  (cause) => `${cap(cause)} — a shorter, easy long run today; the distance comes back when that clears.`,
];
export const RUN_DAY_LONG_WORD_DOWN_VARIANTS: readonly Say[] = [
  () => `You asked for an easier day — the long run is a bit shorter and stays easy.`,
  (_cause, day) => `Taking your word for it — ${day}'s long run is shorter and easy throughout.`,
  () => `A shorter, easy long run today, as you said.`,
];
export const RUN_DAY_LONG_KEEP_VARIANTS: readonly Say[] = [
  (cause, day) => `${cap(cause)} — ${day}'s long run is on, steady and easy.`,
  (cause) => `${cap(cause)}, so the long run goes ahead as planned — easy all the way.`,
  (cause, day) => `${cap(cause)} — a good morning for ${day}'s long run at an easy effort.`,
];
export const RUN_DAY_LONG_PENDING_VARIANTS: readonly Say[] = [
  (_cause, day) => `${day}'s long run is on as the week planned it, at an easy effort throughout.`,
  () => `The long run goes ahead as planned — steady and easy all the way.`,
  (_cause, day) => `${day}'s long run stays on the card, conversational from start to finish.`,
];
export const RUN_DAY_NEUTRAL_PENDING_VARIANTS: readonly Say[] = [
  (_cause, day, session) =>
    `${day}'s ${session} are on as the week planned them — ease off if the morning says otherwise.`,
  (_cause, _day, session) => `Today's ${session} stay as planned; the morning's own read can still ease them.`,
  (_cause, day, session) => `The week puts ${day}'s ${session} here, and nothing has changed that yet.`,
];
export const RUN_DAY_LONG_NEUTRAL_VARIANTS: readonly Say[] = [
  (_cause, day) => `Nothing this morning argues with it — ${day}'s long run is on, steady and easy.`,
  () => `The morning reads steady, so the long run goes ahead as planned.`,
  (_cause, day) => `No reason to change course — ${day}'s long run at an easy effort.`,
];

export const RUN_DAY_WEEK_QUALITY_DONE_VARIANTS: readonly Say[] = [
  (_cause, _day, session) =>
    `An earlier run this week already carried the harder work — today stays easy, and the ${session} come round again next week.`,
  (_cause, day) => `This week's harder running is already in from an earlier run, so ${day} is an easy one.`,
  (_cause, _day, session) =>
    `You've already had this week's harder effort — easy running today, and the ${session} return next week.`,
];

// Every set, for the grammar guard and the tests.
export const RUN_DAY_VARIANT_SETS: Readonly<Record<string, readonly Say[]>> = {
  keep_short: RUN_DAY_KEEP_SHORT_VARIANTS,
  keep_full: RUN_DAY_KEEP_FULL_VARIANTS,
  neutral_keep: RUN_DAY_NEUTRAL_KEEP_VARIANTS,
  word_up: RUN_DAY_WORD_UP_VARIANTS,
  word_up_short: RUN_DAY_WORD_UP_SHORT_VARIANTS,
  easy_floor: RUN_DAY_EASY_FLOOR_VARIANTS,
  easy_brakes: RUN_DAY_EASY_BRAKES_VARIANTS,
  easy_neutral: RUN_DAY_EASY_NEUTRAL_VARIANTS,
  easy_pending: RUN_DAY_EASY_PENDING_VARIANTS,
  neutral_pending: RUN_DAY_NEUTRAL_PENDING_VARIANTS,
  long_pending: RUN_DAY_LONG_PENDING_VARIANTS,
  rest_floor: RUN_DAY_REST_FLOOR_VARIANTS,
  word_down: RUN_DAY_WORD_DOWN_VARIANTS,
  long_shorten: RUN_DAY_LONG_SHORTEN_VARIANTS,
  long_word_down: RUN_DAY_LONG_WORD_DOWN_VARIANTS,
  long_keep: RUN_DAY_LONG_KEEP_VARIANTS,
  long_neutral: RUN_DAY_LONG_NEUTRAL_VARIANTS,
  week_quality_done: RUN_DAY_WEEK_QUALITY_DONE_VARIANTS,
};

// ---------- the decision ----------
// A long run under a floor keeps its place and loses a quarter; under brakes or the
// athlete's own "easier", a sixth. Easy throughout either way.
export const LONG_FLOOR_FACTOR = 0.75;
export const LONG_BRAKE_FACTOR = 0.85;

// Green: nothing on the floor, at least one support read off THIS morning, and the
// supports clearly outnumber the soft brakes. History can tip a morning; it cannot
// make one.
function isGreen(evidence: RunMorningEvidence): boolean {
  const fresh = evidence.supports.filter((code) => FRESH_SUPPORTS.has(code)).length;
  return !evidence.floors.length && fresh >= 1 && evidence.supports.length - evidence.soft_brakes.length >= 2;
}
// Poor enough to pull a normal week's quality session easy: two or more soft brakes,
// and more of them than supports.
function softBrakesWin(evidence: RunMorningEvidence): boolean {
  return evidence.soft_brakes.length >= 2 && evidence.soft_brakes.length > evidence.supports.length;
}

export interface RunDayOptions {
  locks?: RunDayLock[];
  evidence?: RunMorningEvidence;
  // The week's quality session was already run earlier this week (the agenda's own
  // completion read). Today's stated quality day is then easy — only the athlete's
  // word reopens it.
  weekQualityDone?: boolean;
  // `planned` is an EASY run sitting on the athlete's stated QUALITY weekday in a week
  // that holds no quality session (a thin base, fewer than three runs), and `quality` is
  // the short set it would be. A green morning or the athlete's explicit word opens it —
  // still under every floor, and never once the week's harder running is already in.
  statedQualityDay?: boolean;
  quality?: { label?: string | null; dose?: "full" | "short" | null; target_distance_km?: number | null } | null;
  // The week's own trim is ALREADY the answer to a recovery dip (weeklyRunPlan
  // `adapt.dip`): the eased volume, the short set, the long run held a step under the
  // longest. The same nights must not brake the morning a second time, so the
  // `recovery_trend_down` soft brake is dropped from this decision.
  weekAnswersDip?: boolean;
}

// The run the week put here, named in a hard-floor sentence.
function restSessionPhrase(kind: RunDayKind, label: unknown): string {
  if (kind === "long") return "the long run";
  if (kind === "quality") return `the ${sessionWord(label)}`;
  return "the run";
}

export function runDayIntensity(date: string, planned: RunDayPlanned, opts: RunDayOptions = {}): RunDayIntensity {
  const plannedKind: RunDayKind = planned.kind_label;
  const plannedDose: "full" | "short" = planned.dose === "short" ? "short" : "full";
  const plannedKm = positive(planned.target_distance_km);
  const locks = [...new Set([...(opts.locks ?? []), ...(planned.race ? (["race_day"] as RunDayLock[]) : [])])];
  const day = weekdayOf(date);
  // The quality day whose session is ALREADY answered for the week: an easy run on
  // the stated quality weekday, or the quality run itself once an earlier run carried
  // the week's hard work.
  const qualityAnswered =
    (plannedKind === "easy" && opts.statedQualityDay === true && !!opts.quality) ||
    (plannedKind === "quality" && opts.weekQualityDone === true);
  const session = sessionWord(plannedKind === "easy" ? opts.quality?.label : planned.label);
  const reopenDose: "full" | "short" =
    plannedKind === "quality" ? plannedDose : opts.quality?.dose === "short" ? "short" : "full";
  const base = {
    date,
    planned_kind: plannedKind,
    planned_dose: plannedDose,
    locks,
  };
  const asPlanned = (reason: string): RunDayIntensity => ({
    ...base,
    kind: plannedKind,
    dose: plannedDose,
    target_distance_km: plannedKm,
    reason_code: reason,
    supports: [],
    brakes: [],
    floors: [],
    athlete_word: null,
    changed: false,
    why: "",
  });
  // Race day is the athlete's own call — nothing re-decides it.
  if (locks.includes("race_day")) return asPlanned("locked:race_day");

  // Only a day the morning decides needs the full evidence; every other run day (an
  // easy day, a locked week) is asked the hard floors alone.
  const decides = !locks.length && (plannedKind !== "easy" || qualityAnswered);
  const raw: RunMorningEvidence =
    opts.evidence ??
    (decides
      ? runMorningEvidence(date)
      : { floors: runHardFloors(date), soft_brakes: [], supports: [], athlete_word: null });
  const evidence: RunMorningEvidence = opts.weekAnswersDip
    ? { ...raw, soft_brakes: raw.soft_brakes.filter((code) => code !== "recovery_trend_down") }
    : raw;
  const floors = evidence.floors;
  const hardFloors = floors.filter((code) => HARD_RUN_FLOORS.has(code));
  const brakes = [...floors, ...evidence.soft_brakes];
  const word = evidence.athlete_word;
  const morningRead = evidence.morning_read !== false;
  const floorCause = joinCauses(floors.map((code) => FLOOR_WORDS[code]));
  const softCause = joinCauses(evidence.soft_brakes.map((code) => SOFT_BRAKE_WORDS[code]));
  const green = isGreen(evidence);
  const say = (set: readonly Say[], key: string, cause: string, what: string = session): string =>
    pickDayVariant(set, date, `run_day:${key}`)(cause, day, what);
  const out = (
    kind: RunDayKind,
    dose: RunDayDose,
    km: number | null,
    reason: string,
    why: string
  ): RunDayIntensity => ({
    ...base,
    kind,
    dose,
    target_distance_km: km,
    reason_code: reason,
    supports: evidence.supports,
    brakes,
    floors,
    athlete_word: word,
    changed: kind !== plannedKind || dose !== plannedDose,
    why,
  });

  // A HARD floor — the morning the Brief rests, illness, pain the run loads: no run at
  // all, on any run day and through the week's locks. Rest, or optional easy movement.
  if (hardFloors.length)
    return out(
      "easy",
      "rest",
      null,
      `floor:${hardFloors[0]}`,
      say(
        RUN_DAY_REST_FLOOR_VARIANTS,
        "rest_floor",
        joinCauses(hardFloors.map((code) => FLOOR_WORDS[code])),
        restSessionPhrase(plannedKind, planned.label)
      )
    );
  // The week's structure (taper, recovery week, health hold) and an ordinary easy day
  // are exactly what was planned.
  if (locks.length) return asPlanned(`locked:${locks[0]}`);
  if (plannedKind === "easy" && !qualityAnswered) return asPlanned("planned");

  if (plannedKind === "long") {
    const shorter = (factor: number) => (plannedKm != null ? round1(plannedKm * factor) : null);
    if (floors.length)
      return out(
        "long",
        "shortened",
        shorter(LONG_FLOOR_FACTOR),
        `floor:${floors[0]}`,
        say(RUN_DAY_LONG_SHORTEN_VARIANTS, "long_floor", floorCause)
      );
    if (word === "down")
      return out(
        "long",
        "shortened",
        shorter(LONG_BRAKE_FACTOR),
        "athlete_word_easy",
        say(RUN_DAY_LONG_WORD_DOWN_VARIANTS, "long_word_down", "")
      );
    if (softBrakesWin(evidence))
      return out(
        "long",
        "shortened",
        shorter(LONG_BRAKE_FACTOR),
        "brakes_shorten",
        say(RUN_DAY_LONG_SHORTEN_VARIANTS, "long_brakes", softCause)
      );
    if (green)
      return out(
        "long",
        "full",
        plannedKm,
        "green_keeps_long",
        say(RUN_DAY_LONG_KEEP_VARIANTS, "long_keep", supportPhrase(evidence.supports))
      );
    return out(
      "long",
      "full",
      plannedKm,
      "planned",
      morningRead
        ? say(RUN_DAY_LONG_NEUTRAL_VARIANTS, "long_neutral", "")
        : say(RUN_DAY_LONG_PENDING_VARIANTS, "long_pending", "")
    );
  }

  if (qualityAnswered) {
    // The week's hard work is already in, or this day was left easy by the week. Floors
    // speak first; the athlete's word opens the session; on the stated quality weekday
    // of a week with no quality session, a green morning opens its short set too.
    const reopenKm = plannedKind === "easy" ? (positive(opts.quality?.target_distance_km) ?? plannedKm) : plannedKm;
    if (floors.length)
      return out(
        "easy",
        "full",
        plannedKm,
        `floor:${floors[0]}`,
        say(RUN_DAY_EASY_FLOOR_VARIANTS, "easy_floor", floorCause)
      );
    if (word === "down")
      return out("easy", "full", plannedKm, "athlete_word_easy", say(RUN_DAY_WORD_DOWN_VARIANTS, "word_down", ""));
    if (word === "up")
      return out(
        "quality",
        reopenDose,
        reopenKm,
        "athlete_word_quality",
        say(reopenDose === "short" ? RUN_DAY_WORD_UP_SHORT_VARIANTS : RUN_DAY_WORD_UP_VARIANTS, "word_up", "")
      );
    if (plannedKind === "easy" && !opts.weekQualityDone && green)
      return out(
        "quality",
        "short",
        reopenKm,
        "green_opens_short",
        say(RUN_DAY_KEEP_SHORT_VARIANTS, "keep_short", supportPhrase(evidence.supports))
      );
    return out(
      "easy",
      "full",
      plannedKm,
      opts.weekQualityDone ? "week_quality_done" : "planned",
      opts.weekQualityDone ? say(RUN_DAY_WEEK_QUALITY_DONE_VARIANTS, "week_quality_done", "") : ""
    );
  }

  // A quality day. Floors first — nothing outranks one, the athlete's word included.
  if (floors.length)
    return out(
      "easy",
      "full",
      plannedKm,
      `floor:${floors[0]}`,
      say(RUN_DAY_EASY_FLOOR_VARIANTS, "easy_floor", floorCause)
    );
  if (word === "down")
    return out("easy", "full", plannedKm, "athlete_word_easy", say(RUN_DAY_WORD_DOWN_VARIANTS, "word_down", ""));
  if (word === "up")
    return out(
      "quality",
      plannedDose,
      plannedKm,
      "athlete_word_quality",
      say(plannedDose === "short" ? RUN_DAY_WORD_UP_SHORT_VARIANTS : RUN_DAY_WORD_UP_VARIANTS, "word_up", "")
    );
  if (plannedDose === "short") {
    // A trimmed week's quality session is kept only on a green morning.
    if (green)
      return out(
        "quality",
        "short",
        plannedKm,
        "green_keeps_short",
        say(RUN_DAY_KEEP_SHORT_VARIANTS, "keep_short", supportPhrase(evidence.supports))
      );
    if (evidence.soft_brakes.length)
      return out("easy", "full", plannedKm, "brakes_easy", say(RUN_DAY_EASY_BRAKES_VARIANTS, "easy_brakes", softCause));
    // Nothing from the morning yet is not a quiet morning: the week's default stands,
    // decided when the morning comes in.
    return morningRead
      ? out("easy", "full", plannedKm, "quiet_trim_week", say(RUN_DAY_EASY_NEUTRAL_VARIANTS, "easy_neutral", ""))
      : out("easy", "full", plannedKm, "awaiting_morning", say(RUN_DAY_EASY_PENDING_VARIANTS, "easy_pending", ""));
  }
  // Subdued readiness is the house's own "easy" band (readiness-bands.ts): on its own it
  // turns a hard session easy. It is not a floor — the athlete's word above outranks it.
  if (softBrakesWin(evidence) || evidence.soft_brakes.includes("readiness_subdued"))
    return out("easy", "full", plannedKm, "brakes_easy", say(RUN_DAY_EASY_BRAKES_VARIANTS, "easy_brakes", softCause));
  if (green)
    return out(
      "quality",
      "full",
      plannedKm,
      "green_keeps_quality",
      say(RUN_DAY_KEEP_FULL_VARIANTS, "keep_full", supportPhrase(evidence.supports))
    );
  return out(
    "quality",
    "full",
    plannedKm,
    "planned",
    morningRead
      ? say(RUN_DAY_NEUTRAL_KEEP_VARIANTS, "neutral_keep", "")
      : say(RUN_DAY_NEUTRAL_PENDING_VARIANTS, "neutral_pending", "")
  );
}

// The adjusted prescription for a run the morning moved. Only the fields a surface
// reads change; the planned kind is kept beside it so a surface (and the agenda's
// intent id) can still name the slot the week put there.
export function applyRunDayIntensity<
  T extends {
    kind_label: RunDayKind;
    label?: string | null;
    day_name?: string | null;
    focus?: string | null;
    note?: string | null;
    target_distance_km?: number | null;
    target_duration_min?: number | null;
    target_zone?: string | null;
    interval?: unknown;
  },
>(
  run: T,
  adj: RunDayIntensity,
  easyZone: string | null,
  // The week's quality session, for an easy day the athlete's word reopens.
  qualityRun?: Partial<T> | null
): T & { planned_kind_label?: RunDayKind } {
  if (!adj.changed) return run;
  const out: T & { planned_kind_label?: RunDayKind } = { ...run, planned_kind_label: run.kind_label };
  if (adj.dose === "rest") {
    // A hard floor: no run is prescribed — rest, or optional easy movement.
    out.kind_label = "easy";
    out.label = "Rest or an easy walk";
    out.day_name = "Rest or an easy walk";
    out.focus = "Recovery";
    out.interval = null;
    out.target_zone = null;
    out.target_distance_km = null;
    if ("target_duration_min" in out) out.target_duration_min = null;
    out.note = "Rest today — an easy walk is plenty if you'd like to move.";
  } else if (adj.kind === "quality" && run.kind_label === "easy" && qualityRun) {
    out.kind_label = "quality";
    out.label = qualityRun.label ?? "Quality run";
    out.day_name = qualityRun.day_name ?? out.label;
    out.focus = qualityRun.focus ?? "Endurance · quality";
    out.interval = qualityRun.interval ?? null;
    out.target_zone = qualityRun.target_zone ?? null;
    out.target_distance_km = qualityRun.target_distance_km ?? run.target_distance_km ?? null;
    out.note = qualityRun.note ?? null;
  } else if (adj.kind === "easy" && run.kind_label !== "easy") {
    out.kind_label = "easy";
    out.label = "Easy run";
    out.day_name = "Easy run";
    out.focus = "Endurance";
    out.interval = null;
    out.target_zone = easyZone ?? run.target_zone ?? null;
    out.target_distance_km = adj.target_distance_km;
    out.note = `Easy aerobic${easyZone ? ` at ${easyZone}` : ""} — relaxed and conversational.`;
  } else if (adj.kind === "long" && adj.dose === "shortened") {
    out.label = "Long run · shorter";
    out.day_name = "Long run · shorter";
    out.target_distance_km = adj.target_distance_km;
    out.note = `Shorter today and easy throughout${easyZone ? ` at ${easyZone}` : ""}.`;
  }
  return out;
}
