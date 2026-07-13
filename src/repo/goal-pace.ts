// Goal-pace series — the deterministic data behind a calm, motivational weight-
// progress chart. Three parallel reads over one canonical bodyweight series:
//   • points  — the athlete's actual weigh-ins over the window (manual beats Garmin)
//   • trend   — where the recent (≤21-day) least-squares slope is actually taking them
//   • needed  — the straight line to the goal (today's weight → goal by goal_date)
// It is a suggestion, never a verdict: everything degrades to nulls/empty and NEVER
// throws, and there are no scores — just the two lines and the dots between them.
//
// Convention note: `trend.lb_wk` mirrors getWeeklyStats' `trend_lb_wk` (an UNWEIGHTED
// least-squares slope over the most recent ≤21 days of weigh-ins, expressed lb/week,
// null under 2 points or a <3-day span). estimateExpenditure leans on the same slope
// with recency weighting for the TDEE outcome anchor; here the plain slope is the
// honest thing to draw.
import { canonicalBodyweightSeries, resolvedCurrentBodyweight } from "./bodyweight.js";
import { getProfile } from "./profile.js";
import { addDaysISO, localDateISO } from "./shared.js";

export interface GoalPacePoint {
  date: string;
  weight_lb: number;
}

export interface GoalPaceLineResult {
  lb_wk: number | null;
  line: [GoalPacePoint, GoalPacePoint] | null;
}

export interface GoalPaceResult {
  points: GoalPacePoint[];
  trend: GoalPaceLineResult;
  needed: GoalPaceLineResult;
  goal: { weight_lb: number | null; date: string | null };
  window_days: number;
}

const MIN_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 365;
// The recent slice the trend slope is fit over — mirrors getWeeklyStats' 21-day
// weigh-in window so the two "trend_lb_wk" reads agree in spirit.
const TREND_WINDOW_DAYS = 21;
// A short forward projection so the trend line reads as momentum, not a wall.
const TREND_PROJECTION_DAYS = 28;

function clampWindowDays(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return MIN_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.trunc(n)));
}

// Days since the Unix epoch for an ISO date — the x-axis unit for the regression.
function dayNumber(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 864e5;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// A weight only ever makes sense as a positive number; a wild projection is clamped
// to a small plausible floor so the drawn line never dips to zero or below.
function clampWeight(lb: number): number {
  return round2(Math.max(1, lb));
}

// Unweighted least-squares over the trailing ≤21-day slice of the series. Returns
// the raw per-day slope + intercept (for projecting endpoints) or null under the
// established rules: fewer than 2 points, or a first→last span under 3 days.
function fitTrend(points: GoalPacePoint[], today: string): { slopePerDay: number; intercept: number; firstDate: string } | null {
  const since = addDaysISO(today, -TREND_WINDOW_DAYS);
  const recent = since ? points.filter((p) => p.date >= since) : points;
  if (recent.length < 2) return null;
  const xs = recent.map((p) => dayNumber(p.date));
  const ys = recent.map((p) => p.weight_lb);
  if (xs[xs.length - 1] - xs[0] < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den <= 0) return null;
  const slopePerDay = num / den;
  return { slopePerDay, intercept: my - slopePerDay * mx, firstDate: recent[0].date };
}

// The motivational weight-progress read. `windowDays` clamps to 14–365; everything
// is null-safe and never throws (an empty DB returns empty points + all-null lines).
export function goalPace(windowDays = 90): GoalPaceResult {
  const window = clampWindowDays(windowDays);
  const today = localDateISO();
  const since = addDaysISO(today, -(window - 1)) ?? today;

  // The canonical series: one lb-valued point per date, manual weigh-ins winning
  // every same-date collision over Garmin (both handled inside canonicalBodyweightSeries).
  const points: GoalPacePoint[] = canonicalBodyweightSeries({ since, through: today })
    .map((p) => ({ date: p.date, weight_lb: p.weight_lb }))
    .filter((p) => Number.isFinite(p.weight_lb) && p.weight_lb > 0);

  // ---- trend: where the recent slope is actually taking them ----
  let trend: GoalPaceLineResult = { lb_wk: null, line: null };
  const fit = fitTrend(points, today);
  if (fit) {
    const x0 = dayNumber(fit.firstDate);
    const endDate = addDaysISO(today, TREND_PROJECTION_DAYS) ?? today;
    const x1 = dayNumber(endDate);
    trend = {
      lb_wk: round2(fit.slopePerDay * 7),
      line: [
        { date: fit.firstDate, weight_lb: clampWeight(fit.intercept + fit.slopePerDay * x0) },
        { date: endDate, weight_lb: clampWeight(fit.intercept + fit.slopePerDay * x1) },
      ],
    };
  }

  // ---- needed: the straight line to the goal ----
  const profile = getProfile();
  const goalWeight = Number(profile?.goal_weight_lb);
  const goalWeightLb = Number.isFinite(goalWeight) && goalWeight > 0 ? goalWeight : null;
  const goalDate = typeof profile?.goal_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(profile.goal_date) ? profile.goal_date : null;
  const current = resolvedCurrentBodyweight(profile, today);
  const currentLb = current && Number.isFinite(current.weight_lb) && current.weight_lb > 0 ? current.weight_lb : null;

  let needed: GoalPaceLineResult = { lb_wk: null, line: null };
  if (goalWeightLb != null && goalDate != null && currentLb != null) {
    const weeksRemaining = (dayNumber(goalDate) - dayNumber(today)) / 7;
    if (weeksRemaining > 0) {
      needed = {
        lb_wk: round2((goalWeightLb - currentLb) / weeksRemaining),
        line: [
          { date: today, weight_lb: round2(currentLb) },
          { date: goalDate, weight_lb: round2(goalWeightLb) },
        ],
      };
    }
  }

  return {
    points,
    trend,
    needed,
    goal: { weight_lb: goalWeightLb, date: goalDate },
    window_days: window,
  };
}
