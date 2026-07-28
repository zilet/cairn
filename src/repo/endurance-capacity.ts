import { db } from "../db.js";
import {
  classifyEnduranceActivity,
  classifyEnduranceSport,
  type EnduranceSportClassification,
} from "./endurance-sports.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { getTrainingIntent, type ResolvedTrainingIntent } from "./training-intent.js";

export type EnduranceCapacityStatus = "ready" | "building" | "rebuilding" | "no_data";

export interface EnduranceCapacityRead {
  status: EnduranceCapacityStatus;
  sport: string;
  target_duration_min: number;
  as_of_date: string;
  evidence: {
    date: string;
    duration_min: number;
    ascent_m?: number;
    elevation_loss_m?: number;
  } | null;
  evidence_specificity: "mode" | "family" | "insufficient" | null;
  summary: string;
  next_step: string;
}

function sportLabel(sport: string): string {
  return classifyEnduranceSport(sport).label.toLowerCase();
}

function activitySport(activity: any): EnduranceSportClassification {
  return classifyEnduranceActivity(
    activity?.type,
    [activity?.raw_text, activity?.notes, activity?.garmin_type, activity?.garmin_name]
      .filter(Boolean)
      .join(" "),
  );
}

function matchingTarget(
  activity: any,
  target: EnduranceSportClassification,
): { family: boolean; exact: boolean; classification: EnduranceSportClassification } {
  const classification = activitySport(activity);
  const family = classification.family === target.family;
  return {
    family,
    exact: family && (target.specificity === "family" || classification.mode === target.mode),
    classification,
  };
}

function evidenceFrom(row: any): EnduranceCapacityRead["evidence"] {
  if (!row) return null;
  const evidence: NonNullable<EnduranceCapacityRead["evidence"]> = {
    date: String(row.date),
    duration_min: Math.round(Number(row.duration_min)),
  };
  const ascent = Number(row.ascent_m);
  const descent = Number(row.elevation_loss_m);
  if (Number.isFinite(ascent) && ascent > 0) evidence.ascent_m = Math.round(ascent);
  if (Number.isFinite(descent) && descent > 0) evidence.elevation_loss_m = Math.round(descent);
  return evidence;
}

function terrainEvidencePhrase(row: any): string {
  const ascent = Number(row?.ascent_m);
  const descent = Number(row?.elevation_loss_m);
  const hasAscent = Number.isFinite(ascent) && ascent > 0;
  const hasDescent = Number.isFinite(descent) && descent > 0;
  if (hasAscent && hasDescent) return " Logged climbing and descending support the terrain-specific read.";
  if (hasAscent) return " Logged climbing supports the terrain-specific read.";
  if (hasDescent) return " Logged descending supports the terrain-specific read.";
  return "";
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
  const targetSport = classifyEnduranceSport(target.sport);
  const allRows = (
    db
      .prepare(
        `SELECT a.date AS date, a.type AS type, a.raw_text AS raw_text, a.notes AS notes,
                COALESCE(a.duration_min, ga.moving_min, ga.duration_min) AS duration_min,
                ga.type AS garmin_type, ga.name AS garmin_name,
                ga.ascent_m AS ascent_m, ga.elevation_loss_m AS elevation_loss_m
           FROM activities a
           LEFT JOIN garmin_activities ga ON ga.activity_id = a.id
          WHERE a.date BETWEEN ? AND ?
            AND COALESCE(a.duration_min, ga.moving_min, ga.duration_min) > 0
          ORDER BY a.date DESC, a.id DESC`
      )
      .all(historyStart, asOf) as any[]
  ).map((row) => ({ ...row, sport_match: matchingTarget(row, targetSport) }));
  const familyRows = allRows.filter((row) => row.sport_match.family);
  const rows = familyRows.filter((row) => row.sport_match.exact);
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
  const evidenceSpecificity = targetSport.specificity === "mode" ? "mode" : "family";
  const readyThreshold = durationTarget * 0.9;
  if (longestRecent && Number(longestRecent.duration_min) >= readyThreshold) {
    return {
      status: "ready",
      sport: target.sport,
      target_duration_min: durationTarget,
      as_of_date: asOf,
      evidence: evidenceFrom(longestRecent),
      evidence_specificity: evidenceSpecificity,
      summary: `A recent ${label} outing reached the duration this capability asks for.${terrainEvidencePhrase(longestRecent)}`,
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
      evidence: evidenceFrom(longestRecent),
      evidence_specificity: evidenceSpecificity,
      summary: `Recent ${label} work is building toward the ${durationTarget}-minute capability.${terrainEvidencePhrase(longestRecent)}`,
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
      evidence: evidenceFrom(longestHistory),
      evidence_specificity: evidenceSpecificity,
      summary: `The ${label} capability has older evidence, but no recent outing to call it current.${terrainEvidencePhrase(longestHistory)}`,
      next_step: `Re-enter calmly with an easy outing around ${next} minutes, then build from how it lands.`,
    };
  }
  const first = conservativeNext(durationTarget, null);
  const hasLowerSpecificityFamilyEvidence = familyRows.length > 0;
  return {
    status: "no_data",
    sport: target.sport,
    target_duration_min: durationTarget,
    as_of_date: asOf,
    evidence: null,
    evidence_specificity: hasLowerSpecificityFamilyEvidence ? "insufficient" : null,
    summary: hasLowerSpecificityFamilyEvidence
      ? `There are logged outings in the same sport family, but none identifies ${label} specifically enough to claim this capability.`
      : `There is not yet a logged ${label} outing to read this capability from.`,
    next_step: `An easy ${first}-minute outing would establish a starting point; adjust from the real response.`,
  };
}
