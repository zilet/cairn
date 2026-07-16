// ============================================================================
// Program-state engine — the deterministic FLOOR under adaptive program
// intelligence. It reads what's actually been logged and answers, per lift and
// for the program as a whole: is this progressing, stalling, plateaued, or
// regressing — and what's the next adaptation due (overload, deload, rotate a
// variation, probe an alternative)? No agent on this path; this is the trusted,
// tested signal layer the agentic plan-evolution loop (buildProgramEvolutionPrompt
// → coachOps.evolveProgram) reads to PROPOSE plan changes through the usual
// propose→apply flow. Mirrors the dayRead deterministic-floor pattern.
//
// Constitution: this surfaces trajectory and a suggested action in PLAIN words —
// never a 0-100 score, never a gate. "Plateaued ~4 weeks" is information; the
// athlete (and the coach proposal) drive.
// ============================================================================
import { db } from "../db.js";
import { localDateISO } from "./shared.js";
import { getRecoverySummary } from "./coach.js";
import { currentTrainingDataVersion, registerTrainingCacheClear, trainingBackstopSignature } from "./training-cache.js";
import { canonicalGroup, classifyMuscleGroup, MUSCLE_LANDMARKS, type MuscleGroup } from "./exercise-canon.js";
import { effectiveVolumeByGroup, type VolumeSet } from "./exercise-variations.js";
import {
  activeRecoveryWeek,
  type ActiveRecoveryWeek,
  effectiveGoalMode,
  getPrimaryDiscipline,
  getProfile,
} from "./profile.js";
import { completedRecoveryWeekLedger, type CompletedRecoveryWeekLedger } from "./recovery-week-ledger.js";
import { getProgress } from "./sessions.js";
import { recoverySessionDose } from "./training-read.js";
import {
  activitySportWhere,
  canonicalEnduranceSport,
  configuredEnduranceSportKeys,
  enduranceSportPatterns,
  sportPatternsForKey,
} from "./endurance-sports.js";
import { recentEnduranceImpacts, type EnduranceImpact } from "./hybrid-load.js";
import { sessionNoteSuggestsFatigue, sessionNoteSuggestsRapidFade } from "./training-fatigue.js";

// ---- ACWR low-base guards ---------------------------------------------------
// An acute-vs-chronic ratio is only meaningful once there's a real CHRONIC base
// to compare against. A returning/new athlete with a near-zero chronic average
// produces an absurd ratio (the live data shows tonnage ACWR 2.77 and endurance
// ACWR 8.79 off essentially nothing) — that's not "spiking", it's BUILDING a
// base. Below these floors we suppress the scary "spiking" read entirely.
const TONNAGE_CHRONIC_FLOOR = 4000; // lb/wk of chronic tonnage before ACWR means anything
const ENDURANCE_CHRONIC_FLOOR_KM = 8; // km/wk of chronic running before ACWR means anything
const NON_TONNAGE_WEEK_FLOOR = 3; // timed/bodyweight/endurance units before a week counts as loaded
const FATIGUE_DELOAD_MIN_WEEKS = 4; // enough accumulated work that feedback can bring the reset forward

export type LiftStatus = "progressing" | "plateaued" | "regressing" | "maintaining" | "new";
export type LiftAction = "overload" | "hold" | "deload" | "vary" | "technique" | "introduce" | null;
export type MesoPhase = "accumulation" | "intensification" | "deload-due" | "deload" | null;

export interface LiftState {
  exercise: string;
  muscle_group: string | null;
  mode: "reps" | "timed";
  sessions: number; // logged sessions that included this lift (loaded)
  est_1rm: number | null; // latest best est-1RM (reps lifts); null for timed
  best_seconds: number | null; // latest best hold (timed lifts); null for reps
  trend_per_wk: number | null; // est-1RM lb/wk (or seconds/wk for timed), least-squares
  status: LiftStatus;
  stall_signals: string[]; // plain-language tells ("same load 4 sessions", "grinding")
  weeks_static: number | null; // weeks the top load/hold hasn't moved
  suggested_action: LiftAction;
  why: string; // one plain sentence
}

export interface MuscleVolumeState {
  muscle_group: string;
  weekly_sets: number; // avg working sets/wk over the window
  band: "low" | "productive" | "high";
  trend: "rising" | "falling" | "stable" | null;
}

export interface MesocycleState {
  weeks_since_deload: number | null;
  phase: MesoPhase;
  acute_chronic_ratio: number | null; // tonnage ACWR (acute 7d vs chronic 28d/wk)
  note: string;
}

export interface EnduranceState {
  sport: string;
  sport_label: string;
  last_week_km: number | null;
  acute_chronic_ratio: number | null; // weekly-km ACWR
  longest_km_4wk: number | null;
  has_quality: boolean; // any tempo/interval/Z4+ effort in the window
  pace_trend: "improving" | "declining" | "stable" | null; // easy-pace efficiency
  status: "building" | "maintaining" | "detraining" | "spiking" | null;
  suggested_action: "build" | "hold" | "add-quality" | "ease" | null;
  why: string;
  by_sport: Record<string, EnduranceSportVolumeEvidence>;
}

export interface EnduranceSportVolumeEvidence {
  sport: string;
  label: string;
  sessions: number;
  distance_km: number;
  moving_min: number;
  sources: string[];
  last_date: string | null;
  provenance: "activities";
}

export type HybridStatus = "clear" | "watch" | "shift-legs" | "fuel-protect";
export type HybridStrengthAdvice = "ok" | "hold-load" | "swap-or-upper" | "easy-only";

export interface HybridEnduranceImpact {
  date: string;
  days_ago: number;
  type: string;
  label: string;
  duration_min: number | null;
  distance_km: number | null;
  intensity: "easy" | "moderate" | "hard";
  load: "light" | "moderate" | "heavy";
  regions: MuscleGroup[];
  detail: string;
  why: string;
  training_load?: number | null;
}

export interface HybridStrengthConflict {
  day_number: number;
  day_name: string;
  focus: string | null;
  days_until: number;
  groups: MuscleGroup[];
  impacted_groups: MuscleGroup[];
  heavy_leg_day: boolean;
  advice: HybridStrengthAdvice;
  why: string;
}

export interface HybridFuelRead {
  risk: "low" | "watch" | "high";
  why: string;
}

export interface HybridState {
  status: HybridStatus;
  headline: string;
  affected_groups: MuscleGroup[];
  recent_endurance: HybridEnduranceImpact | null;
  recent_endurance_all?: HybridEnduranceImpact[];
  next_strength: HybridStrengthConflict | null;
  fuel: HybridFuelRead | null;
}

export interface ProgramState {
  generated_for: string;
  discipline: string;
  lifts: LiftState[];
  volume: MuscleVolumeState[];
  mesocycle: MesocycleState;
  recovery_week: ActiveRecoveryWeek | null;
  endurance: EnduranceState | null;
  hybrid: HybridState | null;
  headline: string; // one plain sentence, no score
  adaptations_due: string[]; // the plain-language "what to evolve next" list
}

// ---- small deterministic helpers ----
function lsqSlopePerDay(pts: { x: number; y: number }[]): number | null {
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0,
    den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function dayIndex(iso: string, base: string): number {
  return Math.round((new Date(iso + "T00:00:00Z").getTime() - new Date(base + "T00:00:00Z").getTime()) / 864e5);
}

function isoDaysAgo(d: string, n: number): string {
  return new Date(new Date(d + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
}

// ---- per-lift progression ----
const REPS_RECENT = 8; // analyze the most recent N sessions (state, not ancient history)

// A deliberately reduced, compliant recovery exposure is not a failed strength
// test. Keep the raw log intact, but exclude that session from comparable-lift
// trajectory math. Above-plan / overdosed / unknown sessions remain ordinary
// evidence. The recovery-dose ledger is the one policy owner for this decision.
let trajectorySessionEligibility = new Map<number, boolean>();
registerTrainingCacheClear(() => {
  trajectorySessionEligibility = new Map();
});

function sessionCountsTowardLiftTrajectory(sessionId: number): boolean {
  const id = Number(sessionId);
  const cached = trajectorySessionEligibility.get(id);
  if (cached != null) return cached;
  const eligible = recoverySessionDose(id).classification !== "compliant";
  trajectorySessionEligibility.set(id, eligible);
  return eligible;
}

function comparableLiftDates(name: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.id AS session_id, s.date AS date
       FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id
      WHERE e.name = ? COLLATE NOCASE
      ORDER BY s.date, s.id`
    )
    .all(name) as any[];
  return new Set(
    rows.filter((row) => sessionCountsTowardLiftTrajectory(Number(row.session_id))).map((row) => String(row.date))
  );
}

function gradeRepsLift(name: string, mg: string | null): LiftState | null {
  const prog = getProgress(name) as any;
  // getProgress can now emit points with best1rm === null (a bodyweight/weight-0
  // set, or an assisted lift logged before bodyweight was known). Those carry no
  // 1RM trajectory, so drop them before grading — Math.round(null)/null-as-y would
  // otherwise read as 0 / NaN. A lift left with too few real points falls to the
  // "new" baseline path below, exactly like a lift that's only just been logged.
  const comparableDates = comparableLiftDates(name);
  const points: any[] = (Array.isArray(prog.points) ? prog.points : []).filter(
    (p: any) => p.best1rm != null && comparableDates.has(String(p.date))
  );
  if (points.length < 2) {
    return points.length
      ? {
          exercise: name,
          muscle_group: mg,
          mode: "reps",
          sessions: points.length,
          est_1rm: Math.round(points[points.length - 1].best1rm),
          best_seconds: null,
          trend_per_wk: null,
          status: "new",
          stall_signals: [],
          weeks_static: null,
          suggested_action: "hold",
          why: "Just getting started — a couple more sessions and the trend reads clearly.",
        }
      : null;
  }
  const recent = points.slice(-REPS_RECENT);
  const base = recent[0].date;
  const slopeDay = lsqSlopePerDay(recent.map((p) => ({ x: dayIndex(p.date, base), y: p.best1rm })));
  const trendWk = slopeDay == null ? null : Math.round(slopeDay * 7 * 10) / 10;
  const latest = recent[recent.length - 1];
  const est1rm = Math.round(latest.best1rm);
  const spanDays = dayIndex(latest.date, base);

  // Top-load stall: how many trailing sessions sit at (or below) the same top weight.
  let staticCount = 1;
  for (let i = recent.length - 2; i >= 0; i--) {
    if (recent[i].topWeight >= latest.topWeight - 0.01) staticCount++;
    else break;
  }
  const weeksStatic =
    staticCount >= 2
      ? Math.max(1, Math.round(dayIndex(latest.date, recent[recent.length - staticCount].date) / 7))
      : null;

  // Grinding: recent top sets taken at RIR 0-1 while the load isn't moving.
  const ex = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as any;
  let grinding = false;
  if (ex) {
    const rirRows = db
      .prepare(
        `SELECT ls.rir AS rir, s.id AS session_id FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? AND ls.rir IS NOT NULL ORDER BY s.date DESC, ls.id DESC LIMIT 24`
      )
      .all(ex.id) as any[];
    const comparableRirRows = rirRows
      .filter((row) => sessionCountsTowardLiftTrajectory(Number(row.session_id)))
      .slice(0, 6);
    const lowRir = comparableRirRows.filter((r) => Number(r.rir) <= 1).length;
    grinding = comparableRirRows.length >= 3 && lowRir >= 2;
  }

  // Status — judged on the recent trend, with enough history to be fair. A lift
  // still building its baseline makes NO stall claims (a "grinding" flag on
  // two weeks of data would be a false alarm).
  const enough = recent.length >= 4 && spanDays >= 14;
  const stall_signals: string[] = [];
  if (enough && staticCount >= 3) stall_signals.push(`same top load ${staticCount} sessions running`);
  if (enough && grinding) stall_signals.push("top sets grinding (RIR 0–1) without the load moving");
  let status: LiftStatus;
  if (!enough) status = "new";
  else if (trendWk != null && trendWk >= 0.5) status = "progressing";
  else if (trendWk != null && trendWk <= -0.75) status = "regressing";
  else if (staticCount >= 3 || grinding) status = "plateaued";
  else status = "maintaining";

  let suggested_action: LiftAction;
  let why: string;
  switch (status) {
    case "progressing":
      suggested_action = "overload";
      why = `Climbing ~${trendWk} lb/wk — keep the progression going.`;
      break;
    case "regressing":
      suggested_action = "deload";
      why = "Drifting down — back the load off a touch and let it rebuild.";
      break;
    case "plateaued":
      suggested_action = grinding ? "deload" : weeksStatic && weeksStatic >= 3 ? "vary" : "technique";
      why = grinding
        ? "Stuck and grinding — a light deload, then a fresh run usually breaks it."
        : weeksStatic && weeksStatic >= 3
          ? `Flat ~${weeksStatic} wk — rotating to a close variation tends to unstick it.`
          : "Flat lately — tighten technique / add a rep before chasing load.";
      break;
    case "maintaining":
      suggested_action = "overload";
      why = "Holding steady — a small, deliberate push is in order.";
      break;
    default:
      suggested_action = "hold";
      why = "Building a baseline — keep logging and the trend will show.";
  }

  return {
    exercise: name,
    muscle_group: mg,
    mode: "reps",
    sessions: points.length,
    est_1rm: est1rm,
    best_seconds: null,
    trend_per_wk: trendWk,
    status,
    stall_signals,
    weeks_static: weeksStatic,
    suggested_action,
    why,
  };
}

function gradeTimedLift(name: string, mg: string | null): LiftState | null {
  const ex = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as any;
  if (!ex) return null;
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.date AS date, MAX(ls.duration_sec) AS best FROM logged_sets ls
     JOIN sessions s ON s.id = ls.session_id
     WHERE ls.exercise_id = ? AND ls.duration_sec IS NOT NULL
     GROUP BY s.id, s.date ORDER BY s.date, s.id`
    )
    .all(ex.id) as any[];
  const comparableRows = rows.filter((row) => sessionCountsTowardLiftTrajectory(Number(row.session_id)));
  const byDate = new Map<string, number>();
  for (const row of comparableRows) {
    const date = String(row.date);
    byDate.set(date, Math.max(byDate.get(date) ?? 0, Number(row.best)));
  }
  const points = [...byDate.entries()].map(([date, best]) => ({ date, best }));
  if (!points.length) return null;
  const recent = points.slice(-REPS_RECENT);
  const base = recent[0].date;
  const slopeDay = lsqSlopePerDay(recent.map((p) => ({ x: dayIndex(p.date, base), y: Number(p.best) })));
  const trendWk = slopeDay == null ? null : Math.round(slopeDay * 7);
  const latest = recent[recent.length - 1];
  const spanDays = dayIndex(latest.date, base);
  const enough = recent.length >= 4 && spanDays >= 14;
  // A flat-but-established hold reads as 'maintaining' (keep extending), NOT a
  // plateau — for a timed lift the first lever is more seconds, not "rotate to a
  // harder variation". Only a clear decline is 'regressing'. (Was a dead branch
  // that classified every steady hold as plateaued → vary.)
  let status: LiftStatus;
  if (!enough) status = "new";
  else if (trendWk != null && trendWk >= 1) status = "progressing";
  else if (trendWk != null && trendWk <= -2) status = "regressing";
  else status = "maintaining";
  const suggested_action: LiftAction =
    status === "progressing"
      ? "overload"
      : status === "regressing"
        ? "deload"
        : status === "maintaining"
          ? "overload"
          : "hold";
  const why =
    status === "progressing"
      ? `Holds are getting longer (~${trendWk}s/wk) — keep extending.`
      : status === "maintaining"
        ? "Holding steady — add a few seconds when it feels solid (or a harder variation)."
        : status === "regressing"
          ? "Holds shortening — reset and rebuild."
          : "Building a baseline on this hold.";
  return {
    exercise: name,
    muscle_group: mg,
    mode: "timed",
    sessions: points.length,
    est_1rm: null,
    best_seconds: Number(latest.best),
    trend_per_wk: trendWk,
    status,
    stall_signals: [],
    weeks_static: null,
    suggested_action,
    why,
  };
}

function liftStates(date: string): LiftState[] {
  // Lifts with real logged history (a reps lift needs loaded sets; a timed lift
  // needs duration). One row per exercise, newest activity first.
  const exs = db
    .prepare(
      `SELECT e.name AS name, e.muscle_group AS mg, e.mode AS mode,
            MAX(s.date) AS last_date, COUNT(DISTINCT s.date) AS days
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date <= ?
        AND ((e.mode = 'timed' AND ls.duration_sec IS NOT NULL)
             OR (COALESCE(e.mode,'reps') != 'timed' AND ls.weight IS NOT NULL AND ls.reps IS NOT NULL))
      GROUP BY e.id
      HAVING days >= 1
      ORDER BY last_date DESC`
    )
    .all(date) as any[];

  const out: LiftState[] = [];
  for (const e of exs) {
    const st = String(e.mode) === "timed" ? gradeTimedLift(e.name, e.mg) : gradeRepsLift(e.name, e.mg);
    if (st) out.push(st);
  }
  return out;
}

// ---- volume landmarks ----
// Working-set volume per CANONICAL muscle group, banded against the taxonomy's
// per-group MUSCLE_LANDMARKS (RP-style). Sets are folded onto canonical groups
// (so a bench logged with no/legacy group still counts under chest), and
// MOBILITY work is EXCLUDED from the set-count math — it's tracked but must never
// inflate the working-set picture. A group without a landmark falls back to the
// old generic 6/20 band thresholds.
function muscleVolume(date: string, weeks = 3): MuscleVolumeState[] {
  const start = isoDaysAgo(date, weeks * 7 - 1);
  const half = isoDaysAgo(date, Math.floor((weeks * 7) / 2));
  const rows = db
    .prepare(
      `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
            ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date >= ? AND s.date <= ?`
    )
    .all(start, date) as any[];

  // ONE honest-volume truth (shared with programBalance / getVolumeByMuscle): warmups
  // excluded, RIR-weighted, indirect credit, canon taxonomy (mobility never counts).
  // Effective volume over the FULL window + the RECENT half → the rising/falling trend.
  const full = effectiveVolumeByGroup(rows as VolumeSet[]);
  const recentMap = effectiveVolumeByGroup((rows as VolumeSet[]).filter((r) => String(r.date) >= half));

  return [...full.entries()]
    .map(([group, v]) => {
      const total = v.sets;
      const recent = recentMap.get(group)?.sets ?? 0;
      const weekly = Math.round((total / weeks) * 10) / 10;
      const firstHalf = total - recent;
      const trend: MuscleVolumeState["trend"] =
        recent > firstHalf * 1.2 ? "rising" : recent < firstHalf * 0.8 ? "falling" : "stable";
      const lm = MUSCLE_LANDMARKS[group];
      const lo = lm?.low ?? 6;
      const hi = lm?.high ?? 20;
      const band: MuscleVolumeState["band"] = weekly < lo ? "low" : weekly > hi ? "high" : "productive";
      return { muscle_group: group, weekly_sets: weekly, band, trend };
    })
    .sort((a, b) => b.weekly_sets - a.weekly_sets);
}

// ---- mesocycle / fatigue position ----
// Exported for the reaction-model + next-step engines (they correlate prior-week
// training load against acute markers / leverage). weekBack=0 is the trailing 7 days.
export function weeklyTonnage(date: string, weekBack: number): number {
  const end = isoDaysAgo(date, weekBack * 7);
  const start = isoDaysAgo(date, weekBack * 7 + 6);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ls.weight * ls.reps), 0) AS t FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
     WHERE ls.weight > 0 AND ls.reps > 0 AND s.date >= ? AND s.date <= ?`
    )
    .get(start, end) as any;
  return Math.round(Number(row?.t ?? 0));
}

// Consecutive loaded weeks with no reset before a deload reads "about due". A reset
// every ~4-6 weeks is the norm; string 6 loaded weeks together and a deload is due —
// EVEN for an athlete who has NEVER deloaded (the exact case that most needs one).
const DELOAD_DUE_CONSECUTIVE_WEEKS = 6;

function weeklyNonTonnageLoad(
  date: string,
  weekBack: number
): { units: number; timed_seconds: number; bodyweight_sets: number; endurance_minutes: number } {
  const end = isoDaysAgo(date, weekBack * 7);
  const start = isoDaysAgo(date, weekBack * 7 + 6);
  let timedSeconds = 0;
  let bodyweightSets = 0;
  try {
    const row = db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN ls.duration_sec IS NOT NULL AND ls.duration_sec > 0 THEN ls.duration_sec ELSE 0 END), 0) AS timed_seconds,
          COALESCE(SUM(CASE WHEN ls.reps IS NOT NULL AND ls.reps > 0 AND (ls.weight IS NULL OR ls.weight <= 0) THEN 1 ELSE 0 END), 0) AS bodyweight_sets
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE s.date >= ? AND s.date <= ?`
      )
      .get(start, end) as any;
    timedSeconds = Number(row?.timed_seconds ?? 0) || 0;
    bodyweightSets = Number(row?.bodyweight_sets ?? 0) || 0;
  } catch {
    /* older DB → no non-tonnage load */
  }

  let enduranceMinutes = 0;
  let enduranceKm = 0;
  try {
    const patterns = enduranceSportPatterns(getProfile()?.endurance_sport);
    const sport = activitySportWhere("activities", patterns);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(duration_min), 0) AS min, COALESCE(SUM(distance_km), 0) AS km
         FROM activities
        WHERE date >= ? AND date <= ? AND (${sport.sql})`
      )
      .get(start, end, ...sport.params) as any;
    enduranceMinutes = Number(row?.min ?? 0) || 0;
    enduranceKm = Number(row?.km ?? 0) || 0;
  } catch {
    /* no endurance rows */
  }

  const units = Math.round((timedSeconds / 60 + bodyweightSets + enduranceMinutes / 25 + enduranceKm / 5) * 10) / 10;
  return {
    units,
    timed_seconds: Math.round(timedSeconds),
    bodyweight_sets: Math.round(bodyweightSets),
    endurance_minutes: Math.round(enduranceMinutes),
  };
}

function recentFeedbackFatigue(date: string, days = 14): { high: boolean; reasons: string[] } {
  const end = String(date).slice(0, 10);
  const start = isoDaysAgo(end, Math.max(1, days) - 1);
  try {
    const rows = db
      .prepare(
        `SELECT soreness, performance, joint_pain, notes FROM sessions
        WHERE date >= ? AND date <= ?
          AND (soreness IS NOT NULL OR performance IS NOT NULL OR
               (joint_pain IS NOT NULL AND TRIM(joint_pain) != '') OR
               (notes IS NOT NULL AND TRIM(notes) != ''))`
      )
      .all(start, end) as any[];
    if (!rows.length) return { high: false, reasons: [] };
    const highSoreness = rows.filter((r) => Number(r.soreness) >= 4).length;
    const lowPerformance = rows.filter((r) => Number(r.performance) <= 2).length;
    const jointFlags = rows.filter((r) => r.joint_pain != null && String(r.joint_pain).trim()).length;
    const fatigueNotes = rows.filter((r) => sessionNoteSuggestsFatigue(r.notes));
    const rapidFade = fatigueNotes.some((r) => sessionNoteSuggestsRapidFade(r.notes));
    const reasons: string[] = [];
    if (highSoreness >= 2) reasons.push("soreness is staying high");
    if (lowPerformance >= 2) reasons.push("recent sessions are feeling flat");
    if (jointFlags >= 1) reasons.push("joint feedback is still flagged");
    if (fatigueNotes.length >= 2 || rapidFade)
      reasons.push("session notes repeatedly describe strength-endurance fading");
    return { high: reasons.length > 0, reasons };
  } catch {
    return { high: false, reasons: [] };
  }
}

function mesocycle(
  date: string,
  recovery?: any,
  recoveryWeek?: ActiveRecoveryWeek | null,
  completedRecoveryWeek?: CompletedRecoveryWeekLedger | null
): MesocycleState {
  // A "deload week" = a COMPLETED week whose tonnage fell well below the trailing
  // base. Start at w=1 (the current week is in-progress — a half-logged week early
  // in the week would otherwise read as a deload). Walk back up to 8 weeks.
  let weeksSince: number | null = null;
  for (let w = 1; w <= 8; w++) {
    const here = weeklyTonnage(date, w);
    const base = [w + 1, w + 2, w + 3].map((b) => weeklyTonnage(date, b));
    const chronic = base.reduce((a, b) => a + b, 0) / base.length;
    if (chronic > 0 && here > 0 && here < chronic * 0.6) {
      weeksSince = w;
      break;
    }
  }
  // Consecutive COMPLETED loaded weeks (from w=1) with no reset — a training gap
  // (an empty week) or the detected deload above breaks the streak. This is what
  // catches the never-deloaded athlete: `weeksSince` stays null for them, so the
  // old code read "accumulation" forever no matter how long they'd been grinding.
  let loadedStreak = 0;
  for (let w = 1; w <= 12; w++) {
    if (weeksSince != null && w >= weeksSince) break; // hit the last reset — streak resets there
    const tonnage = weeklyTonnage(date, w);
    const nonTonnage = weeklyNonTonnageLoad(date, w);
    if (tonnage <= 0 && nonTonnage.units < NON_TONNAGE_WEEK_FLOOR) break; // an untrained week ends the streak
    loadedStreak++;
  }
  const deloadDueByStreak = weeksSince == null && loadedStreak >= DELOAD_DUE_CONSECUTIVE_WEEKS;
  // ACWR: this week's load vs the chronic base of the FOUR PRIOR weeks (the chronic
  // window must EXCLUDE the acute week, or the ratio is biased toward 1 and a real
  // spike never crosses the threshold). Mirrors the endurance ACWR below.
  const acute = weeklyTonnage(date, 0);
  const chronicWeeks = [1, 2, 3, 4].map((b) => weeklyTonnage(date, b));
  const chronic4 = chronicWeeks.reduce((a, b) => a + b, 0) / 4;
  // LOW-BASE GUARD: a ratio off a near-zero / barely-logged chronic base is
  // meaningless (a returning athlete logging their first couple of weeks reads as
  // a huge "spike"). Two gates: enough WEEKS of real history (≥3 of the prior 4
  // weeks actually trained — otherwise the chronic average is mostly pre-logging
  // zeros, which the absolute floor alone won't catch) AND a chronic average above
  // the floor. Below either we don't trust an ACWR — they're BUILDING a base, not
  // spiking. Above both the ratio is honest.
  const chronicWeeksWithData = chronicWeeks.filter((t) => t > 0).length;
  const hasChronicBase = chronicWeeksWithData >= 3 && chronic4 >= TONNAGE_CHRONIC_FLOOR;
  const acwr = hasChronicBase ? Math.round((acute / chronic4) * 100) / 100 : null;
  const buildingBase = acute > 0 && !hasChronicBase;

  const rec = recovery ?? getRecoverySummary(14);
  const drift = rec?.delta ?? null;
  const recoveryDrifting = (drift?.hrv != null && drift.hrv < 0) || (drift?.rhr != null && drift.rhr > 2);
  const feedbackFatigue = recentFeedbackFatigue(date);
  const recentHybridHeavy = recentEnduranceImpacts(7, date).some((i) => i.load === "heavy");
  const currentNonTonnage = weeklyNonTonnageLoad(date, 0);
  const fatigueDeload =
    loadedStreak >= FATIGUE_DELOAD_MIN_WEEKS &&
    feedbackFatigue.high &&
    (recoveryDrifting || recentHybridHeavy || currentNonTonnage.units >= NON_TONNAGE_WEEK_FLOOR);

  // (An athlete who is actively IN a deload this week is read from the active
  // periodization block's phase, not from this completed-week detector.)
  let phase: MesoPhase;
  let note: string;
  if (recoveryWeek) {
    phase = "deload";
    note = `Recovery week is active through ${recoveryWeek.until} — keep the programmed frequency, reduced working-set dose, and easy aerobic continuation.`;
    weeksSince = 0;
  } else if (completedRecoveryWeek) {
    // Prefer whichever reset is newer: the deliberate applied recovery ledger,
    // or a later low-load week detected from the logs.
    weeksSince =
      weeksSince == null
        ? completedRecoveryWeek.weeks_since_completion
        : Math.min(weeksSince, completedRecoveryWeek.weeks_since_completion);
    if (weeksSince >= 4) {
      phase = "deload-due";
      note = `~${weeksSince} weeks since the completed recovery week${recoveryDrifting ? " and recovery's drifting" : ""} — a reset week is about due.`;
    } else {
      phase = "accumulation";
      note =
        weeksSince === 0
          ? "Recovery week completed — resume the build conservatively and let normal progression earn its next step."
          : `${weeksSince} week${weeksSince === 1 ? "" : "s"} since the completed recovery week — building.`;
    }
  } else if (weeksSince != null && weeksSince >= 4) {
    phase = "deload-due";
    note = `~${weeksSince} weeks since a deload${recoveryDrifting ? " and recovery's drifting" : ""} — a reset week is about due.`;
  } else if (fatigueDeload) {
    phase = "deload-due";
    const fatigue = feedbackFatigue.reasons.join(" and ");
    const loadText = recentHybridHeavy
      ? "with hard endurance layered onto the block"
      : currentNonTonnage.units >= NON_TONNAGE_WEEK_FLOOR
        ? "with timed/bodyweight work adding fatigue beyond tonnage"
        : "with recovery drifting";
    note = `~${loadedStreak} loaded weeks plus ${fatigue} ${loadText} — a reset week is about due.`;
  } else if (buildingBase) {
    phase = "accumulation";
    note =
      "You're rebuilding your training base — keep volume steady and conservative; the load will feel like a jump only because the base is still thin, not because you're overreaching.";
  } else if (deloadDueByStreak) {
    const source =
      weeklyTonnage(date, 1) > 0 ? "" : " — timed/bodyweight/endurance work counts here even when tonnage is low";
    phase = "deload-due";
    note = `You've strung ~${loadedStreak} loaded weeks together with no reset${recoveryDrifting ? " and recovery's drifting" : ""}${source} — a deload week is about due, even though there's no prior deload on record.`;
  } else if (acwr != null && acwr >= 1.4) {
    phase = "intensification";
    note = "Load's ramped this block — hold the line, don't pile on.";
  } else if (weeksSince == null) {
    phase = "accumulation";
    note = "No recent deload on record — keep building, plan a reset every 4–6 weeks.";
  } else {
    phase = "accumulation";
    note = `${weeksSince} week${weeksSince === 1 ? "" : "s"} since your last deload — building.`;
  }

  return { weeks_since_deload: weeksSince, phase, acute_chronic_ratio: acwr, note };
}

// ---- endurance state ----
// Exported for the reaction-model + next-step engines (prior-week endurance load).
export function weeklyKm(date: string, weekBack: number, patterns: string[]): number {
  const end = isoDaysAgo(date, weekBack * 7);
  const start = isoDaysAgo(date, weekBack * 7 + 6);
  const sport = activitySportWhere("activities", patterns);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(distance_km), 0) AS km FROM activities
      WHERE date >= ? AND date <= ? AND (${sport.sql})`
    )
    .get(start, end, ...sport.params) as any;
  return Math.round(Number(row?.km ?? 0) * 10) / 10;
}

function weeklySportEvidence(date: string): Record<string, EnduranceSportVolumeEvidence> {
  const start = isoDaysAgo(date, 6);
  const rows = db
    .prepare(`SELECT date, type, duration_min, distance_km, source FROM activities WHERE date >= ? AND date <= ?`)
    .all(start, date) as any[];
  const grouped = new Map<string, EnduranceSportVolumeEvidence & { sourceSet: Set<string> }>();
  for (const activity of rows) {
    const sport = canonicalEnduranceSport(activity.type);
    let row = grouped.get(sport.key);
    if (!row) {
      row = {
        sport: sport.key,
        label: sport.label,
        sessions: 0,
        distance_km: 0,
        moving_min: 0,
        sources: [],
        sourceSet: new Set(),
        last_date: null,
        provenance: "activities",
      };
      grouped.set(sport.key, row);
    }
    row.sessions++;
    const km = Number(activity.distance_km);
    const min = Number(activity.duration_min);
    if (Number.isFinite(km) && km > 0) row.distance_km += km;
    if (Number.isFinite(min) && min > 0) row.moving_min += min;
    const activityDate = String(activity.date ?? "").slice(0, 10);
    if (activityDate && (!row.last_date || activityDate > row.last_date)) row.last_date = activityDate;
    row.sourceSet.add(String(activity.source || "manual"));
  }
  const out: Record<string, EnduranceSportVolumeEvidence> = {};
  for (const [key, row] of grouped) {
    const { sourceSet, ...publicRow } = row;
    out[key] = {
      ...publicRow,
      distance_km: Math.round(row.distance_km * 10) / 10,
      moving_min: Math.round(row.moving_min),
      sources: [...sourceSet].sort(),
    };
  }
  return out;
}

function enduranceState(date: string): EnduranceState {
  const profile = getProfile();
  const configuredSports = configuredEnduranceSportKeys(profile?.endurance_sport);
  const primarySport = configuredSports[0] ?? "run";
  const patterns = sportPatternsForKey(primarySport);
  const primaryDescriptor = canonicalEnduranceSport(primarySport);
  const bySport = weeklySportEvidence(date);
  const lastWeek = weeklyKm(date, 0, patterns);
  const chronicWeeksKm = [1, 2, 3, 4].map((b) => weeklyKm(date, b, patterns));
  const chronic = chronicWeeksKm.reduce((a, b) => a + b, 0) / 4;
  // LOW-BASE GUARD (mirrors the tonnage one): a weekly-km ratio off a near-zero
  // chronic base reads as a huge spike for a returning runner logging their first
  // real week. Below the floor we don't trust the ACWR — they're rebuilding aerobic
  // base, not spiking dangerous mileage.
  const chronicWeeksWithData = chronicWeeksKm.filter((k) => k > 0).length;
  const hasEnduranceBase = chronicWeeksWithData >= 3 && chronic >= ENDURANCE_CHRONIC_FLOOR_KM;
  const acwr = hasEnduranceBase ? Math.round((lastWeek / chronic) * 100) / 100 : null;
  const buildingBase = lastWeek > 0 && !hasEnduranceBase;
  const start4 = isoDaysAgo(date, 27);
  const activitySport = activitySportWhere("activities", patterns);
  const aSport = activitySportWhere("a", patterns);

  const longest = db
    .prepare(
      `SELECT MAX(distance_km) AS km FROM activities
      WHERE date >= ? AND date <= ? AND (${activitySport.sql})`
    )
    .get(start4, date, ...activitySport.params) as any;

  // Quality = a synced effort with a hard label or meaningful Z4+ time.
  const quality = db
    .prepare(
      `SELECT COUNT(*) AS n FROM activities a JOIN garmin_activities g ON g.activity_id = a.id
     WHERE a.date >= ? AND a.date <= ?
       AND (${aSport.sql})
       AND (UPPER(COALESCE(g.te_label,'')) IN ('TEMPO','THRESHOLD','VO2MAX','ANAEROBIC','LACTATE_THRESHOLD')
            OR COALESCE(g.anaerobic_te,0) >= 2)`
    )
    .get(start4, date, ...aSport.params) as any;
  const hasQuality = Number(quality?.n ?? 0) > 0;

  // Easy-pace efficiency: avg pace (min/km) of the chosen endurance sport, recent half vs older half.
  const paceRows = db
    .prepare(
      `SELECT a.date AS date, a.duration_min AS dur, a.distance_km AS km FROM activities a
     WHERE a.date >= ? AND a.date <= ? AND a.distance_km > 1 AND a.duration_min > 0
       AND (${aSport.sql}) ORDER BY a.date`
    )
    .all(isoDaysAgo(date, 41), date, ...aSport.params) as any[];
  let paceTrend: EnduranceState["pace_trend"] = null;
  if (paceRows.length >= 4) {
    const paces = paceRows.map((r) => ({ date: r.date, pace: Number(r.dur) / Number(r.km) }));
    const mid = Math.floor(paces.length / 2);
    const older = paces.slice(0, mid).reduce((a, b) => a + b.pace, 0) / mid;
    const newer = paces.slice(mid).reduce((a, b) => a + b.pace, 0) / (paces.length - mid);
    paceTrend = newer < older * 0.98 ? "improving" : newer > older * 1.02 ? "declining" : "stable";
  }

  // Status reads the load trajectory; the action is the single most useful nudge —
  // decoupled so "all one pace, add a quality session" (the ceiling-raiser) isn't
  // masked by a mild base build. Established volume = the larger of this week and
  // the chronic average, so a quiet week doesn't hide a real base.
  const base = Math.max(lastWeek, chronic);
  // buildingBase (returning runner, thin chronic base, ACWR suppressed) reads as
  // "building" — NEVER "spiking" — so the action is a calm conservative build, not
  // a scary "ease off". A real ACWR only kicks in once the base clears the floor.
  const status: EnduranceState["status"] = buildingBase
    ? "building"
    : acwr != null && acwr >= 1.5
      ? "spiking"
      : acwr != null && acwr < 0.7 && chronic > 0
        ? "detraining"
        : acwr != null && acwr >= 1.1
          ? "building"
          : "maintaining";
  let action: EnduranceState["suggested_action"];
  let why: string;
  const volumeWord = primarySport === "run" ? "Mileage" : `${primaryDescriptor.label} distance`;
  if (status === "spiking") {
    action = "ease";
    why = `${volumeWord} jumped this week — hold it here and let it absorb before adding more.`;
  } else if (status === "detraining") {
    action = "build";
    why = `${primaryDescriptor.label} has tapered off — a gentle, steady rebuild will bring the base back.`;
  } else if (buildingBase) {
    action = "build";
    why = `You're rebuilding your aerobic base — keep ${primaryDescriptor.label.toLowerCase()} easy and conservative; this is base-building, not overreaching.`;
  } else if (!hasQuality && base >= 10) {
    action = "add-quality";
    why = "Solid easy base, but it's all one pace — one tempo or interval session a week would lift your ceiling.";
  } else if (status === "building") {
    action = "build";
    why = "Base is building nicely — keep the weekly step conservative (~10%).";
  } else {
    action = "hold";
    why = "Endurance is ticking over steadily.";
  }

  return {
    sport: primarySport,
    sport_label: primaryDescriptor.label,
    last_week_km: lastWeek,
    acute_chronic_ratio: acwr,
    longest_km_4wk: longest?.km != null ? Math.round(Number(longest.km) * 10) / 10 : null,
    has_quality: hasQuality,
    pace_trend: paceTrend,
    status,
    suggested_action: action,
    why,
    by_sport: bySport,
  };
}

// ---- hybrid interference: endurance load x strength plan x fat-loss context ----
const LOWER_GROUPS = new Set<MuscleGroup>(["quads", "hamstrings", "glutes", "calves"]);

function weekDayNumber(iso: string): number {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 ? 7 : day;
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function impactSummary(impact: EnduranceImpact): HybridEnduranceImpact {
  return {
    date: impact.date,
    days_ago: impact.days_ago,
    type: impact.type,
    label: impact.label,
    duration_min: impact.duration_min,
    distance_km: impact.distance_km,
    intensity: impact.intensity,
    load: impact.load,
    regions: impact.regions,
    detail: impact.detail,
    why: impact.why,
    training_load: impact.training_load,
  };
}

interface PlannedStrengthDay {
  plan_day_id: number;
  day_number: number;
  day_name: string;
  focus: string | null;
  groups: MuscleGroup[];
  heavy_leg_day: boolean;
}

function plannedStrengthDays(): PlannedStrengthDay[] {
  const rows = db
    .prepare(
      `SELECT pd.id AS plan_day_id, pd.day_number AS day_number, pd.name AS day_name, pd.focus AS focus,
            e.name AS exercise, e.muscle_group AS muscle_group,
            pi.sets AS sets, pi.target_weight AS target_weight
       FROM plan_days pd
       JOIN plan_items pi ON pi.plan_day_id = pd.id
       LEFT JOIN exercises e ON e.id = pi.exercise_id
      WHERE COALESCE(pi.kind, 'strength') != 'cardio'
      ORDER BY pd.day_number, pi.position`
    )
    .all() as any[];
  const byDay = new Map<number, PlannedStrengthDay>();
  for (const row of rows) {
    const group = canonicalGroup(row.muscle_group) ?? classifyMuscleGroup(String(row.exercise || ""));
    if (!group || group === "mobility") continue;
    const dayNumber = Number(row.day_number);
    if (!Number.isFinite(dayNumber)) continue;
    const cur = byDay.get(dayNumber) ?? {
      plan_day_id: Number(row.plan_day_id),
      day_number: dayNumber,
      day_name: String(row.day_name || `Day ${dayNumber}`),
      focus: row.focus == null ? null : String(row.focus),
      groups: [],
      heavy_leg_day: false,
    };
    if (!cur.groups.includes(group)) cur.groups.push(group);
    const lower = LOWER_GROUPS.has(group);
    const loaded = Number(row.target_weight ?? 0) > 0 || Number(row.sets ?? 0) >= 3;
    const heavyName = /\b(squat|deadlift|hinge|leg press|lunge|split squat|step up|hack|rdl)\b/i.test(
      String(row.exercise || "")
    );
    if (lower && (loaded || heavyName || /leg|lower|squat|hinge/i.test(`${row.day_name || ""} ${row.focus || ""}`))) {
      cur.heavy_leg_day = true;
    }
    byDay.set(dayNumber, cur);
  }
  return [...byDay.values()].sort((a, b) => a.day_number - b.day_number);
}

function completedPlanDayOnDate(planDayId: number, date: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS yes FROM sessions s
        WHERE s.plan_day_id = ? AND s.date = ?
          AND (s.finished_at IS NOT NULL OR EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id))
        LIMIT 1`
    )
    .get(planDayId, date) as any;
  return !!row?.yes;
}

function nextStrengthConflict(
  date: string,
  affectedGroups: MuscleGroup[],
  impacts: EnduranceImpact[]
): HybridStrengthConflict | null {
  const days = plannedStrengthDays();
  if (!days.length) return null;
  const today = weekDayNumber(date);
  const ordered = days
    .map((d) => {
      let daysUntil = (d.day_number - today + 7) % 7;
      // Today's plan day is no longer "next" once its real session is complete;
      // the next occurrence is a week away.
      if (daysUntil === 0 && completedPlanDayOnDate(d.plan_day_id, date)) daysUntil = 7;
      return { ...d, days_until: daysUntil };
    })
    .sort((a, b) => a.days_until - b.days_until || a.day_number - b.day_number);
  const next = ordered[0];
  const affected = new Set(affectedGroups);
  const impacted = next.groups.filter((g) => affected.has(g));
  const impactedLower = impacted.some((g) => LOWER_GROUPS.has(g));
  const overlappingImpacts = impacts.filter((impact) => impact.regions.some((group) => impacted.includes(group)));
  const leadImpact = overlappingImpacts[0] ?? impacts[0] ?? null;
  let advice: HybridStrengthAdvice = "ok";
  let why = "The next strength day does not meaningfully overlap the recent endurance load.";
  if (leadImpact && impacted.length) {
    const labels = [...new Set(overlappingImpacts.map((impact) => impact.label))];
    const what =
      labels.length > 1 ? labels.join(" + ") : `${leadImpact.detail ? `${leadImpact.detail} ` : ""}${leadImpact.label}`;
    const anyHeavy = overlappingImpacts.some((impact) => impact.load === "heavy");
    if (anyHeavy && next.heavy_leg_day && impactedLower && next.days_until <= 1) {
      advice = "swap-or-upper";
      why = `${cap(impacted.join(", "))} just took a ${what} dose — make the next lower-body session upper/core, technique-only, or keep legs easy.`;
    } else if (overlappingImpacts.some((impact) => impact.load !== "light") && next.days_until <= 2) {
      advice = "hold-load";
      why = `${cap(impacted.join(", "))} overlaps the recent ${what}; hold lower-body load or trim sets until it absorbs.`;
    } else {
      why = `${cap(impacted.join(", "))} overlaps the recent endurance work, but there is enough space before this day to keep it as planned if recovery is normal.`;
    }
  }
  return {
    day_number: next.day_number,
    day_name: next.day_name,
    focus: next.focus,
    days_until: next.days_until,
    groups: next.groups,
    impacted_groups: impacted,
    heavy_leg_day: next.heavy_leg_day,
    advice,
    why,
  };
}

function hybridFuelRead(
  profile: any,
  impact: EnduranceImpact | null,
  endurance: EnduranceState | null
): HybridFuelRead | null {
  const mode = effectiveGoalMode(profile);
  if (mode !== "lose") return null;
  if (!impact) {
    return {
      risk: "low",
      why: "Fat-loss mode is active, but there is no recent endurance load competing for recovery right now.",
    };
  }
  if (impact.load === "heavy" || endurance?.status === "spiking") {
    return {
      risk: "high",
      why: "Fat-loss mode plus a hard/long endurance dose raises the cost of adding more load — protect protein, carbs around the session, sleep, and lean-safe pace before pushing volume.",
    };
  }
  if (impact.load === "moderate") {
    return {
      risk: "watch",
      why: "Fat-loss mode and endurance work can coexist, but do not deepen the deficit on quality or long-run days.",
    };
  }
  return { risk: "low", why: "Keep the deficit lean-safe and protein anchored; today's endurance load is light." };
}

function hybridState(date: string, endurance: EnduranceState | null, discipline: string): HybridState | null {
  const impacts = recentEnduranceImpacts(3, date);
  const materialImpacts = impacts.filter((impact) => impact.load !== "light");
  const lead = materialImpacts[0] ?? impacts[0] ?? null;
  const affectedGroups = [...new Set(materialImpacts.flatMap((impact) => impact.regions))];
  const conflict = nextStrengthConflict(date, affectedGroups, materialImpacts);
  const profile = getProfile();
  const fuel = hybridFuelRead(profile, lead, endurance);
  const shouldShow = discipline === "hybrid" || discipline === "endurance" || !!lead || fuel?.risk !== "low";
  if (!shouldShow) return null;

  let status: HybridStatus = "clear";
  if (fuel?.risk === "high") status = "fuel-protect";
  else if (conflict?.advice === "swap-or-upper" || conflict?.advice === "easy-only") status = "shift-legs";
  else if (conflict?.advice === "hold-load" || fuel?.risk === "watch" || lead?.load === "heavy") status = "watch";

  let headline: string;
  if (!lead) {
    headline = "No recent endurance load is competing with strength right now.";
  } else if (status === "fuel-protect") {
    headline = "Endurance plus fat loss is the limiter today — protect fuel and recovery before adding load.";
  } else if (status === "shift-legs") {
    const labels = [...new Set(materialImpacts.map((impact) => impact.label))];
    headline = `${cap(labels.join(" + ") || lead.label)} loaded the legs hard; move heavy lower-body work or keep it easy.`;
  } else if (status === "watch") {
    const labels = [...new Set(materialImpacts.map((impact) => impact.label))];
    headline = `${cap(labels.join(" + ") || lead.label)} is in the worked regions; keep overlapping strength conservative until it absorbs.`;
  } else {
    headline = "Endurance and strength are not meaningfully competing today.";
  }

  return {
    status,
    headline,
    affected_groups: affectedGroups,
    recent_endurance: lead ? impactSummary(lead) : null,
    recent_endurance_all: materialImpacts.map(impactSummary).slice(0, 6),
    next_strength: conflict,
    fuel,
  };
}

// ---- the aggregate ----
// MEMOIZED (repo/training-cache.ts): a single page render fans this heavy read
// (~100–200 synchronous queries — an N+1 over every distinct exercise, each an
// unbounded est-1RM history scan) out several times. It's a pure function of the
// logged training + recovery data for a given date, so memoize on (date, training
// version + SQL backstop) and serve a structuredClone (callers sort/mutate lifts).
//
// Why `recovery` is NOT in the key: getProgramState(date, recovery) is only ever
// passed a recovery equal to getRecoverySummary(14) of the CURRENT data (getCoachContext
// threads exactly that; every other caller passes none, so mesocycle() computes the
// same thing internally). Recovery-source tables (daily_metrics / garmin_daily_metrics)
// are in the backstop and bump the version, so a fixed (date, version) pins one recovery
// → one result, whether the object is passed or recomputed.
//
// Single-slot (bounded) — the hot path is always `today`; a rare historical ?date=
// simply misses and replaces. Registered for the test-isolate reset.
let programStateCache: { key: string; value: ProgramState } | null = null;
registerTrainingCacheClear(() => {
  programStateCache = null;
});

export function getProgramState(date?: string, recovery?: any): ProgramState {
  const d = date || localDateISO();
  const key = `${d}|${currentTrainingDataVersion()}|${trainingBackstopSignature()}`;
  if (programStateCache && programStateCache.key === key) return structuredClone(programStateCache.value);
  const value = computeProgramState(d, recovery);
  programStateCache = { key, value };
  return structuredClone(value);
}

function computeProgramState(date?: string, recovery?: any): ProgramState {
  const d = date || localDateISO();
  const discipline = getPrimaryDiscipline();
  const lifts = liftStates(d);
  const volume = muscleVolume(d);
  const recoveryWeek = activeRecoveryWeek(d);
  const completedRecoveryWeek = recoveryWeek ? null : completedRecoveryWeekLedger(d);
  const meso = mesocycle(d, recovery, recoveryWeek, completedRecoveryWeek);
  const endurance = discipline === "endurance" || discipline === "hybrid" ? enduranceState(d) : null;
  const hybrid = hybridState(d, endurance, discipline);

  // The "what to evolve next" list — plain language, deduped, most actionable first.
  const adaptations: string[] = [];
  if (recoveryWeek)
    adaptations.push("Continue the reduced recovery-week sessions; resume progression after the week has absorbed.");
  const plateaued = lifts.filter((l) => l.status === "plateaued");
  const progressing = lifts.filter((l) => l.status === "progressing");
  const regressing = lifts.filter((l) => l.status === "regressing");
  for (const l of plateaued) {
    adaptations.push(
      l.suggested_action === "vary"
        ? `Rotate a variation for ${l.exercise} — it's been flat${l.weeks_static ? ` ~${l.weeks_static} wk` : ""}.`
        : l.suggested_action === "deload"
          ? `Deload ${l.exercise}, then re-run — it's grinding without moving.`
          : `Unstick ${l.exercise}: tighten technique / add a rep before chasing load.`
    );
  }
  for (const l of regressing) adaptations.push(`Back off ${l.exercise} and let it rebuild.`);
  if (meso.phase === "deload-due") adaptations.push(meso.note);
  if (
    endurance &&
    endurance.suggested_action &&
    endurance.suggested_action !== "hold" &&
    (!recoveryWeek || endurance.suggested_action === "ease")
  )
    adaptations.push(endurance.why);
  if (hybrid?.next_strength?.advice === "swap-or-upper" || hybrid?.next_strength?.advice === "hold-load") {
    adaptations.push(hybrid.next_strength.why);
  }
  if (hybrid?.fuel?.risk === "high") adaptations.push(hybrid.fuel.why);
  if (progressing.length && !recoveryWeek)
    adaptations.push(
      `Push the next load step on ${progressing
        .slice(0, 3)
        .map((l) => l.exercise)
        .join(", ")}.`
    );

  // Headline — one calm sentence, no score.
  const parts: string[] = [];
  if (progressing.length) parts.push(`${progressing.length} lift${progressing.length === 1 ? "" : "s"} climbing`);
  if (plateaued.length) parts.push(`${plateaued.length} stalled`);
  if (regressing.length) parts.push(`${regressing.length} slipping`);
  if (hybrid?.status === "shift-legs") parts.push("legs absorbing endurance");
  else if (hybrid?.status === "fuel-protect") parts.push("fuel/recovery is the limiter");
  const headline = recoveryWeek
    ? "Recovery week is active — keep the training rhythm and let the reduced dose absorb."
    : parts.length
      ? `${parts.join(", ")}${meso.phase === "deload-due" ? "; a deload's about due" : ""}.`
      : lifts.length
        ? "Everything's holding steady — room for a deliberate push."
        : "Not enough logged yet to read your program — keep training and it'll come into focus.";

  return {
    generated_for: d,
    discipline,
    lifts,
    volume,
    mesocycle: meso,
    recovery_week: recoveryWeek,
    endurance,
    hybrid,
    headline,
    adaptations_due: adaptations,
  };
}
