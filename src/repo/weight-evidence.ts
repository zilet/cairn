import { canonicalBodyweightSeries, type CanonicalBodyweightPoint } from "./bodyweight.js";

export interface RobustWeightEvidence {
  since: string;
  through: string;
  points: CanonicalBodyweightPoint[];
  raw_points: number;
  weigh_ins: number;
  span_days: number;
  trend_lb_wk: number | null;
  terminal_shock: boolean;
  terminal_shock_date: string | null;
  level_shift: "none" | "unconfirmed" | "corroborated";
  evidence_keys: string[];
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calendarSpanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
}

function theilSenSlope(xs: number[], ys: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const dx = xs[j] - xs[i];
      if (dx > 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  const value = median(slopes);
  return Number.isFinite(value) ? value : 0;
}

// Shared scale-quality rule for expenditure and decision outcomes. The final
// point is withheld when it is an unconfirmed fluid/scale shock. A repeated new
// level is admitted gradually, never converted wholesale into tissue change.
export function robustWeightTrend<T extends { date: string; weight_lb: number }>(
  points: T[]
): {
  points: T[];
  terminalShock: boolean;
  terminalShockDate: string | null;
  corroboratedShift: boolean;
} {
  const settled = { points, terminalShock: false, terminalShockDate: null, corroboratedShift: false };
  if (points.length < 4) return settled;
  const last = points.at(-1)!;
  const prior = points.slice(0, -1);
  const recent = prior.slice(-3).map((point) => Number(point.weight_lb));
  const recentMedian = median(recent);
  const xs = prior.map((point) => Date.parse(`${point.date}T00:00:00Z`) / 86_400_000);
  const ys = prior.map((point) => Number(point.weight_lb));
  const slope = theilSenSlope(xs, ys);
  const lastX = Date.parse(`${last.date}T00:00:00Z`) / 86_400_000;
  const predicted = median(ys.map((y, i) => y + slope * (lastX - xs[i])));
  const reference = Number.isFinite(predicted) ? predicted : recentMedian;
  const threshold = Math.max(2, Math.abs(recentMedian) * 0.0125);
  const shock = Number.isFinite(reference) && Math.abs(Number(last.weight_lb) - reference) >= threshold;

  const clusterTolerance = Math.max(0.75, threshold * 0.4);
  let clusterStart = points.length - 1;
  while (
    clusterStart > 0 &&
    Math.abs(Number(points[clusterStart - 1].weight_lb) - Number(last.weight_lb)) <= clusterTolerance
  ) {
    clusterStart--;
  }
  const cluster = points.slice(clusterStart);
  const baseline = points.slice(0, clusterStart);
  if (baseline.length < 3) {
    return shock
      ? { points: prior, terminalShock: true, terminalShockDate: last.date, corroboratedShift: false }
      : settled;
  }

  const baselineXs = baseline.map((point) => Date.parse(`${point.date}T00:00:00Z`) / 86_400_000);
  const baselineYs = baseline.map((point) => Number(point.weight_lb));
  const baselineSlope = theilSenSlope(baselineXs, baselineYs);
  const firstClusterX = Date.parse(`${cluster[0].date}T00:00:00Z`) / 86_400_000;
  const predictedFirst = median(baselineYs.map((y, i) => y + baselineSlope * (firstClusterX - baselineXs[i])));
  const firstResidual = Number(cluster[0].weight_lb) - predictedFirst;
  if (!Number.isFinite(firstResidual) || Math.abs(firstResidual) < threshold) {
    return shock
      ? { points: prior, terminalShock: true, terminalShockDate: last.date, corroboratedShift: false }
      : settled;
  }
  if (cluster.length < 2) {
    return { points: prior, terminalShock: true, terminalShockDate: last.date, corroboratedShift: false };
  }

  const persistedDays = calendarSpanDays(cluster[0].date, last.date) + 1;
  const baselineWeight = Math.abs(predictedFirst || recentMedian);
  const earnedShift = Math.max(0.75, baselineWeight * 0.005 * Math.max(1, persistedDays / 7));
  const shrink = Math.min(1, earnedShift / Math.abs(firstResidual));
  const adjusted = cluster.map((point) => {
    const x = Date.parse(`${point.date}T00:00:00Z`) / 86_400_000;
    const expected = median(baselineYs.map((y, i) => y + baselineSlope * (x - baselineXs[i])));
    return { ...point, weight_lb: expected + (Number(point.weight_lb) - expected) * shrink };
  });
  return {
    points: [...baseline, ...adjusted] as T[],
    terminalShock: false,
    terminalShockDate: null,
    corroboratedShift: true,
  };
}

export function robustWeightEvidence(since: string, through: string): RobustWeightEvidence {
  const canonical = canonicalBodyweightSeries({ since, through });
  const robust = robustWeightTrend(canonical);
  const points = robust.points;
  const spanDays = points.length > 1 ? calendarSpanDays(points[0].date, points.at(-1)!.date) : 0;
  let trend: number | null = null;
  if (points.length >= 2 && spanDays >= 3) {
    const xs = points.map((point) => Date.parse(`${point.date}T00:00:00Z`) / 86_400_000);
    const ys = points.map((point) => Number(point.weight_lb));
    trend = theilSenSlope(xs, ys) * 7;
  }
  const manual = canonical.filter((point) => point.source === "manual").length;
  const garmin = canonical.length - manual;
  return {
    since,
    through,
    points,
    raw_points: canonical.length,
    weigh_ins: new Set(points.map((point) => point.date)).size,
    span_days: spanDays,
    trend_lb_wk: trend == null ? null : Math.round(trend * 100) / 100,
    terminal_shock: robust.terminalShock,
    terminal_shock_date: robust.terminalShockDate,
    level_shift: robust.terminalShock ? "unconfirmed" : robust.corroboratedShift ? "corroborated" : "none",
    evidence_keys: canonical.length
      ? [`canonical_bodyweight:${since}..${through}:n=${canonical.length}:manual=${manual}:garmin=${garmin}`]
      : [],
  };
}
