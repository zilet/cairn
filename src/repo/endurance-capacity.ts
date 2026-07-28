import { db } from "../db.js";
import { canonicalEnduranceSport } from "./endurance-sports.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { getTrainingIntent, type ResolvedTrainingIntent } from "./training-intent.js";

export type EnduranceCapacityStatus = "ready" | "building" | "rebuilding" | "no_data";

export interface EnduranceCapacityRead {
  status: EnduranceCapacityStatus;
  sport: string;
  target_duration_min: number;
  as_of_date: string;
  evidence: { date: string; duration_min: number } | null;
  summary: string;
  next_step: string;
}

function sportLabel(sport: string): string {
  return canonicalEnduranceSport(sport).label.toLowerCase();
}

function matchingSport(activity: any, targetKey: string): boolean {
  const fromType = canonicalEnduranceSport(activity?.type);
  // A structured activity type is authoritative. Raw prose is only a fallback:
  // a ride note such as "legs tired after yesterday's run" must not turn the
  // ride into running merely because canonical token precedence sees "run".
  if (["run", "ride", "swim", "row", "walk"].includes(fromType.key)) return fromType.key === targetKey;
  return canonicalEnduranceSport(activity?.raw_text).key === targetKey;
}

function conservativeNext(target: number, best: number | null): number {
  if (best == null) return Math.min(target, Math.max(20, Math.round(target * 0.4)));
  return Math.min(target, Math.max(20, Math.round(best + Math.min(15, Math.max(5, best * 0.1)))));
}

/**
 * A deterministic, sport-aware read of one explicitly named duration capability.
 * It observes logged outings only; it never changes a plan.
 */
export function getEnduranceCapacity(
  intent: ResolvedTrainingIntent = getTrainingIntent(),
  opts: { asOf?: string; recentDays?: number; historyDays?: number } = {}
): EnduranceCapacityRead | null {
  const target = intent.endurance_capacity;
  if (intent.endurance_role === "none" || !target) return null;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf ?? "")) ? String(opts.asOf) : localDateISO();
  const recentDays = Math.max(14, Math.min(90, Math.trunc(Number(opts.recentDays) || 42)));
  const historyDays = Math.max(recentDays, Math.min(730, Math.trunc(Number(opts.historyDays) || 180)));
  const historyStart = addDaysISO(asOf, -(historyDays - 1)) ?? asOf;
  const recentStart = addDaysISO(asOf, -(recentDays - 1)) ?? asOf;
  const targetKey = canonicalEnduranceSport(target.sport).key;
  const rows = (
    db
      .prepare(
        `SELECT date, type, raw_text, duration_min
           FROM activities
          WHERE date BETWEEN ? AND ? AND duration_min > 0
          ORDER BY date DESC, id DESC`
      )
      .all(historyStart, asOf) as any[]
  ).filter((row) => matchingSport(row, targetKey));
  const recent = rows.filter((row) => String(row.date) >= recentStart);
  const longestRecent = recent.reduce<any | null>(
    (best, row) => (!best || Number(row.duration_min) > Number(best.duration_min) ? row : best),
    null
  );
  const longestHistory = rows.reduce<any | null>(
    (best, row) => (!best || Number(row.duration_min) > Number(best.duration_min) ? row : best),
    null
  );
  const durationTarget = target.target_duration_min;
  const label = sportLabel(target.sport);
  const readyThreshold = durationTarget * 0.9;
  if (longestRecent && Number(longestRecent.duration_min) >= readyThreshold) {
    return {
      status: "ready",
      sport: target.sport,
      target_duration_min: durationTarget,
      as_of_date: asOf,
      evidence: { date: String(longestRecent.date), duration_min: Math.round(Number(longestRecent.duration_min)) },
      summary: `A recent ${label} outing reached the duration this capability asks for.`,
      next_step: `Keep an outing around ${durationTarget} minutes in the rhythm when it fits; no automatic plan change is needed.`,
    };
  }
  if (longestRecent) {
    const best = Math.round(Number(longestRecent.duration_min));
    const next = conservativeNext(durationTarget, best);
    return {
      status: "building",
      sport: target.sport,
      target_duration_min: durationTarget,
      as_of_date: asOf,
      evidence: { date: String(longestRecent.date), duration_min: best },
      summary: `Recent ${label} work is building toward the ${durationTarget}-minute capability.`,
      next_step: `When recovery and life allow, make the next longer easy outing about ${next} minutes.`,
    };
  }
  if (longestHistory) {
    const best = Math.round(Number(longestHistory.duration_min));
    const next = conservativeNext(durationTarget, Math.min(best, durationTarget * 0.6));
    return {
      status: "rebuilding",
      sport: target.sport,
      target_duration_min: durationTarget,
      as_of_date: asOf,
      evidence: { date: String(longestHistory.date), duration_min: best },
      summary: `The ${label} capability has older evidence, but no recent outing to call it current.`,
      next_step: `Re-enter calmly with an easy outing around ${next} minutes, then build from how it lands.`,
    };
  }
  const first = conservativeNext(durationTarget, null);
  return {
    status: "no_data",
    sport: target.sport,
    target_duration_min: durationTarget,
    as_of_date: asOf,
    evidence: null,
    summary: `There is not yet a logged ${label} outing to read this capability from.`,
    next_step: `An easy ${first}-minute outing would establish a starting point; adjust from the real response.`,
  };
}
