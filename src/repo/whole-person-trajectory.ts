import { db } from "../db.js";
import { effectiveGoalMode, getEnduranceGoal, getProfile } from "./profile.js";
import { getActiveBlock } from "./program-blocks.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { getMarkerHistory } from "./health.js";
import { matchOptimalZone, optimalDistance } from "./propagation.js";

export type WholePersonVerdict = "better" | "holding" | "worse" | "unknown";
export type WholePersonDomain =
  | "strength"
  | "endurance"
  | "body_composition"
  | "metabolic_health"
  | "recovery_wellbeing";

export interface WholePersonDomainRead {
  domain: WholePersonDomain;
  verdict: WholePersonVerdict;
  why: string;
  evidence_keys: string[];
  parked: boolean;
}

export interface WholePersonTrajectory {
  window: { start: string; end: string; days: number };
  objective: "everything better";
  phase: { name: string | null; optimizes: string[]; protects: WholePersonDomain[]; parks: WholePersonDomain[] };
  domains: WholePersonDomainRead[];
  unexplained_worse: WholePersonDomain[];
  revision_needed: boolean;
  line: string;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function halves(values: Array<{ date: string; value: number }>): { first: number | null; last: number | null } {
  const ordered = [...values].sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length < 4) return { first: null, last: null };
  const half = Math.max(2, Math.floor(ordered.length / 2));
  return {
    first: average(ordered.slice(0, half).map((row) => row.value)),
    last: average(ordered.slice(-half).map((row) => row.value)),
  };
}

function compare(
  first: number | null,
  last: number | null,
  tolerance: number,
  lowerIsBetter = false
): WholePersonVerdict {
  if (first == null || last == null) return "unknown";
  const delta = last - first;
  if (Math.abs(delta) <= tolerance) return "holding";
  const improving = lowerIsBetter ? delta < 0 : delta > 0;
  return improving ? "better" : "worse";
}

function strengthRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const rows = db
    .prepare(
      `SELECT s.date, ls.exercise_id, ls.weight, ls.reps
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE s.date BETWEEN ? AND ? AND ls.weight > 0 AND ls.reps > 0
      ORDER BY s.date, ls.id LIMIT 3000`
    )
    .all(start, end) as any[];
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const estimate = Number(row.weight) * (1 + Number(row.reps) / 30);
    const key = `${row.date}|${row.exercise_id}`;
    byDate.set(key, Math.max(byDate.get(key) ?? 0, estimate));
  }
  const points = [...byDate.entries()].map(([key, value]) => ({ date: key.slice(0, 10), value }));
  const split = halves(points);
  const verdict = compare(split.first, split.last, 1.5);
  return {
    domain: "strength",
    verdict,
    parked,
    why:
      verdict === "unknown"
        ? "Not enough comparable loaded exposures yet."
        : verdict === "better"
          ? "Estimated capacity rose across the window."
          : verdict === "holding"
            ? "Estimated capacity held steady."
            : "Estimated capacity fell across comparable exposures.",
    evidence_keys: rows.length ? [`logged_sets:${start}..${end}:n=${rows.length}`] : [],
  };
}

function enduranceRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const rows = db
    .prepare(
      `SELECT date, COALESCE(distance_km, 0) AS distance_km, COALESCE(duration_min, 0) AS duration_min
       FROM activities WHERE date BETWEEN ? AND ? AND (distance_km > 0 OR duration_min > 0)
      ORDER BY date, id LIMIT 1000`
    )
    .all(start, end) as any[];
  const points = rows.map((row) => ({
    date: String(row.date),
    value: Number(row.distance_km) > 0 ? Number(row.distance_km) : Number(row.duration_min) / 10,
  }));
  const split = halves(points);
  const verdict = compare(split.first, split.last, 0.25);
  return {
    domain: "endurance",
    verdict,
    parked,
    why:
      verdict === "unknown"
        ? "Not enough comparable endurance work yet."
        : verdict === "better"
          ? "Endurance capacity or completed volume moved up."
          : verdict === "holding"
            ? "Endurance work held its level."
            : "Endurance capacity or completed volume moved down.",
    evidence_keys: rows.length ? [`activities:${start}..${end}:n=${rows.length}`] : [],
  };
}

function bodyRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const profile = getProfile();
  const mode = effectiveGoalMode(profile);
  const weights = db
    .prepare(
      `SELECT date, weight_lb AS value FROM bodyweight_log WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 500`
    )
    .all(start, end) as any[];
  const split = halves(weights.map((row) => ({ date: String(row.date), value: Number(row.value) })));
  let verdict: WholePersonVerdict = "unknown";
  if (split.first != null && split.last != null) {
    const delta = split.last - split.first;
    verdict =
      mode === "lose"
        ? compare(split.first, split.last, 0.5, true)
        : mode === "gain"
          ? compare(split.first, split.last, 0.5)
          : Math.abs(delta) <= 2
            ? "holding"
            : "worse";
  }
  return {
    domain: "body_composition",
    verdict,
    parked,
    why:
      verdict === "unknown"
        ? "Not enough body-composition trend data yet."
        : verdict === "better"
          ? `Weight moved in the ${mode} phase's intended direction.`
          : verdict === "holding"
            ? "Bodyweight stayed inside the phase's intended range."
            : `Bodyweight moved against the ${mode} phase's intended direction.`,
    evidence_keys: weights.length ? [`bodyweight_log:${start}..${end}:n=${weights.length}`] : [],
  };
}

function healthRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  let improving = 0;
  let worsening = 0;
  let comparable = 0;
  let pointCount = 0;
  const history = getMarkerHistory();
  for (const marker of history.markers) {
    const points = (Array.isArray(marker?.points) ? marker.points : [])
      .filter((point: any) => point?.date >= start && point?.date <= end && Number.isFinite(Number(point?.value)))
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    if (points.length < 2) continue;
    const zone = matchOptimalZone(marker.name);
    if (!zone) continue;
    const firstDistance = optimalDistance(Number(points[0].value), zone);
    const lastDistance = optimalDistance(Number(points[points.length - 1].value), zone);
    const delta = lastDistance - firstDistance;
    comparable++;
    pointCount += points.length;
    if (delta < -0.02) improving++;
    else if (delta > 0.02) worsening++;
  }
  const verdict: WholePersonVerdict =
    worsening > improving ? "worse" : improving > worsening ? "better" : comparable > 0 ? "holding" : "unknown";
  return {
    domain: "metabolic_health",
    verdict,
    parked,
    why:
      verdict === "unknown"
        ? "No comparable follow-up clinical window yet."
        : verdict === "better"
          ? "More tracked markers moved favorably than unfavorably."
          : verdict === "holding"
            ? "The available marker picture held without a clear directional change."
            : "More tracked markers moved unfavorably than favorably.",
    evidence_keys: comparable ? [`marker_history:${start}..${end}:markers=${comparable}:n=${pointCount}`] : [],
  };
}

function recoveryRead(start: string, end: string, parked: boolean): WholePersonDomainRead {
  const rows = db
    .prepare(
      `SELECT date, sleep_min, resting_hr, hrv_ms FROM daily_metrics WHERE date BETWEEN ? AND ?
     UNION ALL SELECT date, sleep_min, resting_hr, hrv_ms FROM garmin_daily_metrics WHERE date BETWEEN ? AND ?
     ORDER BY date LIMIT 1000`
    )
    .all(start, end, start, end) as any[];
  const signals: Array<{ key: "sleep_min" | "hrv_ms" | "resting_hr"; tolerance: number; lower: boolean }> = [
    { key: "sleep_min", tolerance: 15, lower: false },
    { key: "hrv_ms", tolerance: 2, lower: false },
    { key: "resting_hr", tolerance: 1, lower: true },
  ];
  const reads = signals
    .map((signal) => {
      const points = rows
        .map((row) => ({ date: String(row.date), value: Number(row[signal.key]) }))
        .filter((point) => Number.isFinite(point.value));
      const split = halves(points);
      return compare(split.first, split.last, signal.tolerance, signal.lower);
    })
    .filter((read) => read !== "unknown");
  const better = reads.filter((read) => read === "better").length;
  const worse = reads.filter((read) => read === "worse").length;
  const verdict: WholePersonVerdict = !reads.length
    ? "unknown"
    : better > worse
      ? "better"
      : worse > better
        ? "worse"
        : "holding";
  return {
    domain: "recovery_wellbeing",
    verdict,
    parked,
    why:
      verdict === "unknown"
        ? "Not enough comparable recovery nights yet."
        : verdict === "better"
          ? "Sleep, HRV, and resting-heart-rate direction improved together."
          : verdict === "holding"
            ? "Recovery signals held their level."
            : "Recovery signals weakened across the window.",
    evidence_keys: rows.length ? [`daily_metrics:${start}..${end}:n=${rows.length}`] : [],
  };
}

export function wholePersonTrajectory(opts: { end?: string; days?: number } = {}): WholePersonTrajectory {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.end || "")) ? String(opts.end) : localDateISO();
  const days = Math.max(28, Math.min(120, Math.trunc(Number(opts.days) || 56)));
  const start = addDaysISO(end, -(days - 1)) ?? end;
  const block = (() => {
    try {
      return getActiveBlock();
    } catch {
      return null;
    }
  })() as any;
  const race = (() => {
    try {
      return getEnduranceGoal(end);
    } catch {
      return null;
    }
  })() as any;
  const mode = effectiveGoalMode(getProfile());
  const parks: WholePersonDomain[] = [];
  const protects: WholePersonDomain[] = [];
  const optimizes: string[] = [];
  if (race?.is_race) {
    optimizes.push("endurance");
    protects.push("strength");
    optimizes.push("strength retention");
  }
  if (mode === "lose") {
    optimizes.push("body composition");
    if (!protects.includes("strength")) protects.push("strength");
    optimizes.push("lean mass retention");
  }
  if (mode === "gain") optimizes.push("strength and lean mass");
  if (block?.phase) optimizes.push(String(block.phase));
  const parked = (domain: WholePersonDomain) => parks.includes(domain);
  const domains = [
    strengthRead(start, end, parked("strength")),
    enduranceRead(start, end, parked("endurance")),
    bodyRead(start, end, parked("body_composition")),
    healthRead(start, end, parked("metabolic_health")),
    recoveryRead(start, end, parked("recovery_wellbeing")),
  ];
  const unexplainedWorse = domains
    .filter((domain) => domain.verdict === "worse" && !domain.parked)
    .map((domain) => domain.domain);
  const better = domains
    .filter((domain) => domain.verdict === "better")
    .map((domain) => domain.domain.replaceAll("_", " "));
  const line = unexplainedWorse.length
    ? `${better.length ? `${better.join(", ")} improved; ` : ""}${unexplainedWorse.map((domain) => domain.replaceAll("_", " ")).join(", ")} moved the wrong way, so the plan needs a revision.`
    : better.length
      ? `${better.join(", ")} improved; the rest is holding or still too early to call.`
      : "The whole-person picture is holding or still too early to call; no unexplained regression is visible.";
  return {
    window: { start, end, days },
    objective: "everything better",
    phase: { name: block?.phase ?? race?.phase ?? mode, optimizes: [...new Set(optimizes)], protects, parks },
    domains,
    unexplained_worse: unexplainedWorse,
    revision_needed: unexplainedWorse.length > 0,
    line,
  };
}
