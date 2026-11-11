// HOW HARD A RUN WAS — read off the athlete, never the watch (owner law, 2026-09-25:
// "Garmin te_label must never classify his runs; use the personal HR model").
//
// The one answer every intensity reader asks for a RUN with an average heart rate and
// a usable personal model: the harm read's hard-cardio bar (`hardCardioDayCore`), the
// day-load grade (`cardioEffort`/`dayLoad`, training-read.ts) and the per-muscle
// endurance dose (`classifyImpactLoad`, hybrid-load.ts). A run is HARD when
//   • `classifyRunEffort` reads it as quality against his own zones (above the steady
//     band for 12+ minutes, or 75+ minutes held in it);
//   • the athlete NAMED it quality ("Hills", "5k+sprints", "LT HR Test" —
//     `namesQualityRun`): an interval day's recoveries pull the average into the
//     steady band, and his title is his own input;
//   • he RAN it as a structured interval workout on the watch (≥3 work bouts with
//     recoveries and ≥6 min of work — `intervalSessionEvidence`, run-structure.ts):
//     the workout he chose and executed is input of the same standing as his title.
//     Its own work laps, read against HIS easy line, can still say the bouts were
//     all easy (a run/walk workout) — the watch's labels never grade it;
//   • HARD_EFFORT.z4Seconds sat in heart-rate bins lying wholly ABOVE his threshold
//     band (bin floor > z4_top). Garmin's bins are drawn on Garmin's zones, so a bin
//     straddling his line proves nothing either way.
// Training effect, te_label, time in Garmin's Z4 and the training load no longer speak
// for such a run: the load is Garmin's EPOC estimate, the quantity the training effect
// is itself computed from.
//
// Null means the personal model cannot judge (not a run, no heart rate, no usable
// model) and the caller keeps its old bars — rides, hikes, runs before any model.
// A run the athlete STATED easy (stated-effort.ts) is not hard whatever this says;
// callers check that first, since it holds with or without a model.
import { db } from "../db.js";
import { withoutShadowActivities } from "./activity-shadow.js";
import { canonicalEnduranceSport } from "./endurance-sports.js";
import { HARD_EFFORT } from "./heavy-load.js";
import { classifyRunEffort, easyCeiling, getHrModel, type HrModel } from "./hr-model.js";
import { getEnduranceSchedule, isoDow } from "./profile.js";
import { addDaysISO } from "./shared.js";
import { median } from "../lib/numbers.js";
import { namesQualityRun } from "./stated-effort.js";
import { intervalSessionEvidence } from "./run-structure.js";
import { copyDeep, requestMemo } from "./request-memo.js";

export interface PersonalRunRead {
  hard: boolean;
  /** The personal model's own read of the average: easy / steady / quality. */
  effort: "easy" | "steady" | "quality";
}

/** The personal model as of `date`, when it can judge a run at all — the bar
 * runIntensityDiscipline holds: not insufficient, and a plausible easy line. */
export function usablePersonalHrModel(date: string): HrModel | null {
  try {
    const m = getHrModel(date);
    return m.confidence !== "insufficient" && m.zones && m.lthr != null && m.zones.z2_top >= 100 ? m : null;
  } catch {
    return null;
  }
}

export function personalRunRead(
  run: { avg_hr?: unknown; minutes?: unknown; names?: unknown[]; zones?: unknown; structure?: unknown; laps?: unknown },
  model: HrModel | null
): PersonalRunRead | null {
  if (!model?.zones) return null;
  const avg = Number(run.avg_hr);
  if (!Number.isFinite(avg) || avg <= 0) return null;
  const minutesRaw = run.minutes == null ? null : Number(run.minutes);
  const minutes = minutesRaw != null && Number.isFinite(minutesRaw) ? minutesRaw : null;
  const effort = classifyRunEffort(avg, minutes, model);
  if (effort === "unknown") return null;
  if (effort === "quality") return { hard: true, effort };
  if ((run.names ?? []).some((name) => namesQualityRun(name))) return { hard: true, effort };
  if (intervalSessionEvidence(run.structure, run.laps, easyCeiling(model))) return { hard: true, effort };
  let above = 0;
  try {
    const z = typeof run.zones === "string" ? JSON.parse(run.zones) : run.zones;
    if (Array.isArray(z))
      for (const it of z) {
        const floor = Number(it?.low_hr);
        if (Number.isFinite(floor) && floor > model.zones.z4_top) above += Number(it?.secs ?? it?.seconds ?? 0) || 0;
      }
  } catch {
    /* malformed zone blob → no time evidence */
  }
  return { hard: above >= HARD_EFFORT.z4Seconds, effort };
}

/**
 * The personal read of one activities ⨝ garmin_activities row: null when it is not a
 * run with heart rate, or no usable model exists (the caller keeps the watch's bars).
 * Rows carry `type`, `avg_hr`, `hr_minutes`, `g_name`, `raw_text`, `zones`, and
 * `structure`/`laps` (garmin_activities.structure_json/laps_json); the
 * model is a thunk so a day with no run never pays for one.
 */
export function personalRunReadForRow(r: any, model: () => HrModel | null): PersonalRunRead | null {
  if (canonicalEnduranceSport(r?.type).key !== "run") return null;
  const avg = Number(r?.avg_hr);
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return personalRunRead(
    {
      avg_hr: avg,
      minutes: r.hr_minutes,
      names: [r.g_name, r.raw_text],
      zones: r.zones,
      structure: r.structure,
      laps: r.laps,
    },
    model()
  );
}

// ---------- how LONG is long, for THIS runner ----------
//
// Two readers ask "was this run long enough to count on its length alone": the
// per-muscle dose (a run past the modality's long bar is a HEAVY leg dose,
// hybrid-load.ts) and the day grade (a run past CARDIO_GRADE.hardMin/hardKm is a
// HARD loading day, training-read.ts `cardioEffort`). Both bars were fixed — 55 min /
// 9 km and 50 min / 9 km — so for a runner whose ordinary run is ~40 minutes, most
// of his week read as long runs and every morning after one read as recovering (owner
// ruling, 2026-09-29: push forward, judge by his own data).
//
// So the bar is RELATIVE to his own recent running: OWN_RUN_LONG_MULTIPLE × the median
// duration / distance of his runs over the OWN_RUN_WINDOW_DAYS before the day — a run
// is long when it is clearly past his ordinary one. Bounded on both sides:
//   • never below the fixed bar the caller passes in: a novice, or an athlete with
//     fewer than OWN_RUN_MIN_RUNS runs in the window, keeps today's defaults exactly;
//   • never above OWN_RUN_BAR_CAP (90 min / 16 km): past that a run is long for anyone.
// And the raised bar never demotes his genuine long run: a run that clears the FIXED
// bar stays long when it is
//   • on his stated LONG-run weekday (the build's long run is the long run), or
//   • at least LONG_RUN_SHARE_OF_LONGEST (75%) of the longest run in the window.
// Neither rule ever makes a run long that the fixed bar would not — they only keep the
// relative bar from reading his long run as an ordinary one.
export const OWN_RUN_WINDOW_DAYS = 42;
export const OWN_RUN_MIN_RUNS = 4;
export const OWN_RUN_LONG_MULTIPLE = 1.5;
export const OWN_RUN_BAR_CAP = { min: 90, km: 16 } as const;
export const LONG_RUN_SHARE_OF_LONGEST = 0.75;

export interface RunLengthBars {
  /** Minutes / km at or past which a run is long on its length alone. */
  min: number;
  km: number;
  /** "own" when his recent running set the bar, "fixed" when the caller's default stands. */
  basis: "own" | "fixed";
  /** His ordinary run over the window — the medians the bar is drawn from (null when fixed). */
  median_min: number | null;
  median_km: number | null;
  /** The longest run in the window, km (null when none). */
  longest_km: number | null;
  /** The stated long-run weekday(s) (0 = Sunday). */
  long_dows: number[];
  /** The caller's fixed bar — the floor, and the gate on the long-run rules. */
  fixed: { min: number; km: number };
}

/** The long-run bars for a run dated `date`, read off the runs in the window BEFORE it. */
export function runLengthBars(date: string, fixed: { min: number; km: number }): RunLengthBars {
  const day = String(date).slice(0, 10);
  return requestMemo(`run_length_bars:${day}:${JSON.stringify(fixed)}`, () => runLengthBarsRead(day, fixed), copyDeep);
}

function runLengthBarsRead(day: string, fixed: { min: number; km: number }): RunLengthBars {
  let long_dows: number[] = [];
  try {
    // The long weekday of THIS run's week (a one-week move included).
    long_dows = (getEnduranceSchedule(day)?.days ?? []).filter((d) => d.kind === "long").map((d) => d.dow);
  } catch {
    long_dows = [];
  }
  const out: RunLengthBars = {
    ...fixed,
    basis: "fixed",
    median_min: null,
    median_km: null,
    longest_km: null,
    long_dows,
    fixed: { ...fixed },
  };
  const from = addDaysISO(day, -OWN_RUN_WINDOW_DAYS);
  const to = addDaysISO(day, -1);
  if (!from || !to) return out;
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, type, source, external_id, duration_min, distance_km FROM activities
          WHERE date >= ? AND date <= ?`
      )
      .all(from, to) as any[];
  } catch {
    return out;
  }
  const runs = withoutShadowActivities(rows).filter((r) => canonicalEnduranceSport(r.type).key === "run");
  const kms = runs.map((r) => Number(r.distance_km)).filter((x) => Number.isFinite(x) && x > 0);
  out.longest_km = kms.length ? Math.max(...kms) : null;
  if (runs.length < OWN_RUN_MIN_RUNS) return out;
  const medMin = median(runs.map((r) => Number(r.duration_min)).filter((x) => Number.isFinite(x) && x > 0));
  const medKm = median(kms);
  out.median_min = medMin;
  out.median_km = medKm;
  const ownMin = medMin != null ? Math.round(medMin * OWN_RUN_LONG_MULTIPLE) : null;
  const ownKm = medKm != null ? Math.round(medKm * OWN_RUN_LONG_MULTIPLE * 10) / 10 : null;
  out.min = Math.max(fixed.min, Math.min(ownMin ?? fixed.min, Math.max(OWN_RUN_BAR_CAP.min, fixed.min)));
  out.km = Math.max(fixed.km, Math.min(ownKm ?? fixed.km, Math.max(OWN_RUN_BAR_CAP.km, fixed.km)));
  if (out.min !== fixed.min || out.km !== fixed.km) out.basis = "own";
  return out;
}

/** Is this run long on its length alone, against his own bars (see runLengthBars)? */
export function isLongRunForAthlete(
  bars: RunLengthBars,
  run: { date: string; minutes: number | null; km: number | null }
): boolean {
  const { minutes, km } = run;
  if ((minutes != null && minutes >= bars.min) || (km != null && km >= bars.km)) return true;
  if (bars.basis === "fixed") return false;
  const clearsFixed = (minutes != null && minutes >= bars.fixed.min) || (km != null && km >= bars.fixed.km);
  if (!clearsFixed) return false;
  if (km != null && bars.longest_km != null && km >= bars.longest_km * LONG_RUN_SHARE_OF_LONGEST) return true;
  return bars.long_dows.includes(isoDow(String(run.date).slice(0, 10)));
}
