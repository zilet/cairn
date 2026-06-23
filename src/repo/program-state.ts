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
import { canonicalGroup, isMobility, MUSCLE_LANDMARKS } from "./exercise-canon.js";
import { getPrimaryDiscipline, getProfile } from "./profile.js";
import { getProgress } from "./sessions.js";
import { activitySportWhere, enduranceSportPatterns } from "./endurance-sports.js";

// ---- ACWR low-base guards ---------------------------------------------------
// An acute-vs-chronic ratio is only meaningful once there's a real CHRONIC base
// to compare against. A returning/new athlete with a near-zero chronic average
// produces an absurd ratio (the live data shows tonnage ACWR 2.77 and endurance
// ACWR 8.79 off essentially nothing) — that's not "spiking", it's BUILDING a
// base. Below these floors we suppress the scary "spiking" read entirely.
const TONNAGE_CHRONIC_FLOOR = 4000; // lb/wk of chronic tonnage before ACWR means anything
const ENDURANCE_CHRONIC_FLOOR_KM = 8; // km/wk of chronic running before ACWR means anything

export type LiftStatus = "progressing" | "plateaued" | "regressing" | "maintaining" | "new";
export type LiftAction = "overload" | "hold" | "deload" | "vary" | "technique" | "introduce" | null;
export type MesoPhase = "accumulation" | "intensification" | "deload-due" | "deload" | null;

export interface LiftState {
  exercise: string;
  muscle_group: string | null;
  mode: "reps" | "timed";
  sessions: number;            // logged sessions that included this lift (loaded)
  est_1rm: number | null;      // latest best est-1RM (reps lifts); null for timed
  best_seconds: number | null; // latest best hold (timed lifts); null for reps
  trend_per_wk: number | null; // est-1RM lb/wk (or seconds/wk for timed), least-squares
  status: LiftStatus;
  stall_signals: string[];     // plain-language tells ("same load 4 sessions", "grinding")
  weeks_static: number | null; // weeks the top load/hold hasn't moved
  suggested_action: LiftAction;
  why: string;                 // one plain sentence
}

export interface MuscleVolumeState {
  muscle_group: string;
  weekly_sets: number;         // avg working sets/wk over the window
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
  last_week_km: number | null;
  acute_chronic_ratio: number | null; // weekly-km ACWR
  longest_km_4wk: number | null;
  has_quality: boolean;        // any tempo/interval/Z4+ effort in the window
  pace_trend: "improving" | "declining" | "stable" | null; // easy-pace efficiency
  status: "building" | "maintaining" | "detraining" | "spiking" | null;
  suggested_action: "build" | "hold" | "add-quality" | "ease" | null;
  why: string;
}

export interface ProgramState {
  generated_for: string;
  discipline: string;
  lifts: LiftState[];
  volume: MuscleVolumeState[];
  mesocycle: MesocycleState;
  endurance: EnduranceState | null;
  headline: string;            // one plain sentence, no score
  adaptations_due: string[];   // the plain-language "what to evolve next" list
}

// ---- small deterministic helpers ----
function lsqSlopePerDay(pts: { x: number; y: number }[]): number | null {
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
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

function gradeRepsLift(name: string, mg: string | null): LiftState | null {
  const prog = getProgress(name) as any;
  // getProgress can now emit points with best1rm === null (a bodyweight/weight-0
  // set, or an assisted lift logged before bodyweight was known). Those carry no
  // 1RM trajectory, so drop them before grading — Math.round(null)/null-as-y would
  // otherwise read as 0 / NaN. A lift left with too few real points falls to the
  // "new" baseline path below, exactly like a lift that's only just been logged.
  const points: any[] = (Array.isArray(prog.points) ? prog.points : []).filter((p: any) => p.best1rm != null);
  if (points.length < 2) {
    return points.length
      ? {
          exercise: name, muscle_group: mg, mode: "reps", sessions: points.length,
          est_1rm: Math.round(points[points.length - 1].best1rm), best_seconds: null, trend_per_wk: null,
          status: "new", stall_signals: [], weeks_static: null, suggested_action: "hold",
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
  const weeksStatic = staticCount >= 2 ? Math.max(1, Math.round(dayIndex(latest.date, recent[recent.length - staticCount].date) / 7)) : null;

  // Grinding: recent top sets taken at RIR 0-1 while the load isn't moving.
  const ex = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as any;
  let grinding = false;
  if (ex) {
    const rirRows = db.prepare(
      `SELECT ls.rir AS rir FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? AND ls.rir IS NOT NULL ORDER BY s.date DESC, ls.id DESC LIMIT 6`
    ).all(ex.id) as any[];
    const lowRir = rirRows.filter((r) => Number(r.rir) <= 1).length;
    grinding = rirRows.length >= 3 && lowRir >= 2;
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
      suggested_action = grinding ? "deload" : (weeksStatic && weeksStatic >= 3 ? "vary" : "technique");
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
    exercise: name, muscle_group: mg, mode: "reps", sessions: points.length,
    est_1rm: est1rm, best_seconds: null, trend_per_wk: trendWk,
    status, stall_signals, weeks_static: weeksStatic, suggested_action, why,
  };
}

function gradeTimedLift(name: string, mg: string | null): LiftState | null {
  const ex = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(name) as any;
  if (!ex) return null;
  const rows = db.prepare(
    `SELECT s.date AS date, MAX(ls.duration_sec) AS best FROM logged_sets ls
     JOIN sessions s ON s.id = ls.session_id
     WHERE ls.exercise_id = ? AND ls.duration_sec IS NOT NULL
     GROUP BY s.date ORDER BY s.date`
  ).all(ex.id) as any[];
  if (!rows.length) return null;
  const recent = rows.slice(-REPS_RECENT);
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
    status === "progressing" ? "overload" : status === "regressing" ? "deload" : status === "maintaining" ? "overload" : "hold";
  const why =
    status === "progressing" ? `Holds are getting longer (~${trendWk}s/wk) — keep extending.`
    : status === "maintaining" ? "Holding steady — add a few seconds when it feels solid (or a harder variation)."
    : status === "regressing" ? "Holds shortening — reset and rebuild."
    : "Building a baseline on this hold.";
  return {
    exercise: name, muscle_group: mg, mode: "timed", sessions: rows.length,
    est_1rm: null, best_seconds: Number(latest.best), trend_per_wk: trendWk,
    status, stall_signals: [], weeks_static: null, suggested_action, why,
  };
}

function liftStates(date: string): LiftState[] {
  // Lifts with real logged history (a reps lift needs loaded sets; a timed lift
  // needs duration). One row per exercise, newest activity first.
  const exs = db.prepare(
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
  ).all(date) as any[];

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
  const rows = db.prepare(
    `SELECT e.muscle_group AS mg, e.name AS name,
            SUM(CASE WHEN s.date >= ? THEN 1 ELSE 0 END) AS recent_sets,
            COUNT(*) AS total_sets
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date >= ? AND s.date <= ?
      GROUP BY e.id ORDER BY total_sets DESC`
  ).all(half, start, date) as any[];

  // Fold the per-exercise rows onto canonical groups (mobility dropped).
  const tally = new Map<string, { total: number; recent: number }>();
  for (const r of rows) {
    const g = canonicalGroup(r.mg) ?? canonicalGroup(r.name);
    if (!g || isMobility(g)) continue; // mobility never counts toward volume
    const cur = tally.get(g) ?? { total: 0, recent: 0 };
    cur.total += Number(r.total_sets) || 0;
    cur.recent += Number(r.recent_sets) || 0;
    tally.set(g, cur);
  }

  return [...tally.entries()]
    .map(([group, v]) => {
      const weekly = Math.round((v.total / weeks) * 10) / 10;
      const firstHalf = v.total - v.recent;
      const trend: MuscleVolumeState["trend"] =
        v.recent > firstHalf * 1.2 ? "rising" : v.recent < firstHalf * 0.8 ? "falling" : "stable";
      const lm = MUSCLE_LANDMARKS[group];
      const lo = lm?.low ?? 6;
      const hi = lm?.high ?? 20;
      const band: MuscleVolumeState["band"] = weekly < lo ? "low" : weekly > hi ? "high" : "productive";
      return { muscle_group: group, weekly_sets: weekly, band, trend };
    })
    .sort((a, b) => b.weekly_sets - a.weekly_sets);
}

// ---- mesocycle / fatigue position ----
function weeklyTonnage(date: string, weekBack: number): number {
  const end = isoDaysAgo(date, weekBack * 7);
  const start = isoDaysAgo(date, weekBack * 7 + 6);
  const row = db.prepare(
    `SELECT COALESCE(SUM(ls.weight * ls.reps), 0) AS t FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
     WHERE ls.weight > 0 AND ls.reps > 0 AND s.date >= ? AND s.date <= ?`
  ).get(start, end) as any;
  return Math.round(Number(row?.t ?? 0));
}

function mesocycle(date: string, recovery?: any): MesocycleState {
  // A "deload week" = a COMPLETED week whose tonnage fell well below the trailing
  // base. Start at w=1 (the current week is in-progress — a half-logged week early
  // in the week would otherwise read as a deload). Walk back up to 8 weeks.
  let weeksSince: number | null = null;
  for (let w = 1; w <= 8; w++) {
    const here = weeklyTonnage(date, w);
    const base = [w + 1, w + 2, w + 3].map((b) => weeklyTonnage(date, b));
    const chronic = base.reduce((a, b) => a + b, 0) / base.length;
    if (chronic > 0 && here > 0 && here < chronic * 0.6) { weeksSince = w; break; }
  }
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

  // (An athlete who is actively IN a deload this week is read from the active
  // periodization block's phase, not from this completed-week detector.)
  let phase: MesoPhase;
  let note: string;
  if (weeksSince != null && weeksSince >= 4) { phase = "deload-due"; note = `~${weeksSince} weeks since a deload${recoveryDrifting ? " and recovery's drifting" : ""} — a reset week is about due.`; }
  else if (buildingBase) { phase = "accumulation"; note = "You're rebuilding your training base — keep volume steady and conservative; the load will feel like a jump only because the base is still thin, not because you're overreaching."; }
  else if (acwr != null && acwr >= 1.4) { phase = "intensification"; note = "Load's ramped this block — hold the line, don't pile on."; }
  else if (weeksSince == null) { phase = "accumulation"; note = "No recent deload on record — keep building, plan a reset every 4–6 weeks."; }
  else { phase = "accumulation"; note = `${weeksSince} week${weeksSince === 1 ? "" : "s"} since your last deload — building.`; }

  return { weeks_since_deload: weeksSince, phase, acute_chronic_ratio: acwr, note };
}

// ---- endurance state ----
function weeklyKm(date: string, weekBack: number, patterns: string[]): number {
  const end = isoDaysAgo(date, weekBack * 7);
  const start = isoDaysAgo(date, weekBack * 7 + 6);
  const sport = activitySportWhere("activities", patterns);
  const row = db.prepare(
    `SELECT COALESCE(SUM(distance_km), 0) AS km FROM activities
      WHERE date >= ? AND date <= ? AND (${sport.sql})`
  ).get(start, end, ...sport.params) as any;
  return Math.round(Number(row?.km ?? 0) * 10) / 10;
}

function enduranceState(date: string): EnduranceState {
  const patterns = enduranceSportPatterns(getProfile()?.endurance_sport);
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

  const longest = db.prepare(
    `SELECT MAX(distance_km) AS km FROM activities
      WHERE date >= ? AND date <= ? AND (${activitySport.sql})`
  ).get(start4, date, ...activitySport.params) as any;

  // Quality = a synced effort with a hard label or meaningful Z4+ time.
  const quality = db.prepare(
    `SELECT COUNT(*) AS n FROM activities a JOIN garmin_activities g ON g.activity_id = a.id
     WHERE a.date >= ? AND a.date <= ?
       AND (${aSport.sql})
       AND (UPPER(COALESCE(g.te_label,'')) IN ('TEMPO','THRESHOLD','VO2MAX','ANAEROBIC','LACTATE_THRESHOLD')
            OR COALESCE(g.anaerobic_te,0) >= 2)`
  ).get(start4, date, ...aSport.params) as any;
  const hasQuality = Number(quality?.n ?? 0) > 0;

  // Easy-pace efficiency: avg pace (min/km) of the chosen endurance sport, recent half vs older half.
  const paceRows = db.prepare(
    `SELECT a.date AS date, a.duration_min AS dur, a.distance_km AS km FROM activities a
     WHERE a.date >= ? AND a.date <= ? AND a.distance_km > 1 AND a.duration_min > 0
       AND (${aSport.sql}) ORDER BY a.date`
  ).all(isoDaysAgo(date, 41), date, ...aSport.params) as any[];
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
  const status: EnduranceState["status"] =
    buildingBase ? "building"
    : acwr != null && acwr >= 1.5 ? "spiking"
    : acwr != null && acwr < 0.7 && chronic > 0 ? "detraining"
    : acwr != null && acwr >= 1.1 ? "building"
    : "maintaining";
  let action: EnduranceState["suggested_action"];
  let why: string;
  if (status === "spiking") {
    action = "ease"; why = "Mileage jumped this week — hold it here and let it absorb before adding more.";
  } else if (status === "detraining") {
    action = "build"; why = "Running's tapered off — a gentle, steady rebuild will bring the base back.";
  } else if (buildingBase) {
    action = "build"; why = "You're rebuilding your aerobic base — keep runs easy and conservative; this is base-building, not overreaching.";
  } else if (!hasQuality && base >= 10) {
    action = "add-quality"; why = "Solid easy base, but it's all one pace — one tempo or interval session a week would lift your ceiling.";
  } else if (status === "building") {
    action = "build"; why = "Base is building nicely — keep the weekly step conservative (~10%).";
  } else {
    action = "hold"; why = "Endurance is ticking over steadily.";
  }

  return {
    last_week_km: lastWeek, acute_chronic_ratio: acwr,
    longest_km_4wk: longest?.km != null ? Math.round(Number(longest.km) * 10) / 10 : null,
    has_quality: hasQuality, pace_trend: paceTrend, status, suggested_action: action, why,
  };
}

// ---- the aggregate ----
export function getProgramState(date?: string, recovery?: any): ProgramState {
  const d = date || localDateISO();
  const discipline = getPrimaryDiscipline();
  const lifts = liftStates(d);
  const volume = muscleVolume(d);
  const meso = mesocycle(d, recovery);
  const endurance = discipline === "endurance" || discipline === "hybrid" ? enduranceState(d) : null;

  // The "what to evolve next" list — plain language, deduped, most actionable first.
  const adaptations: string[] = [];
  const plateaued = lifts.filter((l) => l.status === "plateaued");
  const progressing = lifts.filter((l) => l.status === "progressing");
  const regressing = lifts.filter((l) => l.status === "regressing");
  for (const l of plateaued) {
    adaptations.push(
      l.suggested_action === "vary" ? `Rotate a variation for ${l.exercise} — it's been flat${l.weeks_static ? ` ~${l.weeks_static} wk` : ""}.`
      : l.suggested_action === "deload" ? `Deload ${l.exercise}, then re-run — it's grinding without moving.`
      : `Unstick ${l.exercise}: tighten technique / add a rep before chasing load.`
    );
  }
  for (const l of regressing) adaptations.push(`Back off ${l.exercise} and let it rebuild.`);
  if (meso.phase === "deload-due") adaptations.push(meso.note);
  if (endurance && endurance.suggested_action && endurance.suggested_action !== "hold") adaptations.push(endurance.why);
  if (progressing.length) adaptations.push(`Push the next load step on ${progressing.slice(0, 3).map((l) => l.exercise).join(", ")}.`);

  // Headline — one calm sentence, no score.
  const parts: string[] = [];
  if (progressing.length) parts.push(`${progressing.length} lift${progressing.length === 1 ? "" : "s"} climbing`);
  if (plateaued.length) parts.push(`${plateaued.length} stalled`);
  if (regressing.length) parts.push(`${regressing.length} slipping`);
  const headline = parts.length
    ? `${parts.join(", ")}${meso.phase === "deload-due" ? "; a deload's about due" : ""}.`
    : lifts.length
      ? "Everything's holding steady — room for a deliberate push."
      : "Not enough logged yet to read your program — keep training and it'll come into focus.";

  return { generated_for: d, discipline, lifts, volume, mesocycle: meso, endurance, headline, adaptations_due: adaptations };
}
