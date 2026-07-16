// Adaptive nutrition — the MacroFactor-style energy-balance derivation (TDEE from
// intake vs. a robust completed-day weigh-in trend). Adherence-neutral: a thin logging
// week only lowers confidence, it NEVER blames the athlete and NEVER reads a gap as a
// number to act on. Null-safe throughout.
//
// Split out of the former intelligence.ts monolith (K4).
import { db } from "../db.js";
import { listContextEvents } from "./health.js";
import { measuredRmrAssessment } from "./metabolism.js";
import { KCAL_PER_LB, getProfile, projectGoalPace } from "./profile.js";
import { LB_PER_KG, addDaysISO, localDateISO } from "./shared.js";
import { foodBackstopSignature, registerTrainingCacheClear, trainingBackstopSignature } from "./training-cache.js";
import { canonicalBodyweightSeries, resolvedCurrentBodyweight } from "./bodyweight.js";
import { completedIntakeWindow } from "./intake-window.js";
import { robustWeightEvidence } from "./weight-evidence.js";

export interface ExpenditureEstimate {
  // Best current maintenance estimate. The outcome-calibrated value remains an
  // explicit anchor below; this chosen value may be a prior or a deterministic
  // blend while that outcome evidence is still settling.
  tdee: number | null;
  confidence: "none" | "low" | "medium" | "high";
  points: number; // how many days of usable data backed it
  window_days: number;
  intake_avg_kcal: number | null;
  trend_lb_wk: number | null; // weighted bodyweight trend over the window
  // Goal-pace projection off the ACTUAL weigh-in trend (plain language, no score).
  // null/absent when there's no goal or too little scale data.
  projected_goal_date?: string | null;
  projection_text?: string | null;
  outcome_tdee: number | null;
  prior_tdee: number | null;
  prior_basis: ExpenditurePriorBasis | null;
  tdee_basis: ExpenditureBasis;
  basis: string;
  anchors: ExpenditureAnchor[];
  coverage: {
    intake_days: number;
    credible_intake_days: number;
    partial_intake_days: number;
    weigh_in_days: number;
    weigh_in_span_days: number;
    prior_days: number;
    required_prior_days: number;
  };
  provenance: string[];
  fusion: { outcome_weight: number; prior_weight: number };
  // `typical_tdee` is the ordinary-day maintenance read. `tdee` includes only
  // the frequency-amortized share of genuinely exceptional activity (a long
  // ride every other week is not promoted into every day's baseline).
  typical_tdee: number | null;
  maintenance_range: { low: number | null; high: number | null };
  exceptional_activity: {
    window_days: number;
    observed_days: number;
    coverage_ratio: number;
    typical_active_kcal: number | null;
    exceptional_days: number;
    frequency_per_week: number;
    allowance_kcal_per_day: number;
  };
  quality: {
    intake: "none" | "partial" | "plausible" | "complete";
    outcome: "unavailable" | "plausible" | "implausible_low" | "implausible_high";
    explanation: string;
    plausible_tdee_min: number;
    plausible_tdee_max: number;
    terminal_weight_shock: boolean;
    terminal_weight_shock_date: string | null;
    weight_level_shift: "none" | "unconfirmed" | "corroborated";
    outcome_overlap_days: number;
    outcome_calendar_coverage: number;
  };
}

export type ExpenditurePriorBasis = "measured_rmr_active" | "garmin_total_calories" | "profile_seed";
export type ExpenditureBasis = "outcome_trend" | "blended_outcome_prior" | ExpenditurePriorBasis | "unavailable";

export interface ExpenditureAnchor {
  kind: "outcome" | ExpenditurePriorBasis;
  tdee: number;
  days: number;
  basis: string;
  provenance: string[];
  selected: boolean;
  source_date?: string | null;
  age_days?: number | null;
  freshness?: "fresh" | "aging" | "expired" | "undated";
  freshness_weight?: number;
  typical_tdee?: number;
  exceptional_allowance_kcal?: number;
  activity_window_days?: number;
  activity_observed_days?: number;
  activity_coverage_ratio?: number;
  typical_active_kcal?: number | null;
  exceptional_days?: number;
  rmr_adjustment?: {
    original_kcal: number;
    adjusted_kcal: number;
    test_weight_lb: number;
    current_weight_lb: number;
    delta_lb: number;
    test_weight_date: string;
  } | null;
}

type PriorAnchor = Omit<ExpenditureAnchor, "kind"> & { kind: ExpenditurePriorBasis };

const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;
const MIN_PRIOR_DAYS = 14;
const MIN_PRIOR_COVERAGE = 0.5;
const ACTIVITY_WINDOW_DAYS = 42;
const ABSOLUTE_TDEE_MIN = 1_200;
const ABSOLUTE_TDEE_MAX = 8_000;
const CONSERVATIVE_FALLBACK_TDEE = 1_800;

function normalizeWindowDays(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 21;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.trunc(n)));
}

function calendarSpanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function activityPattern(byDay: Map<string, number>): {
  typical: number;
  allowance: number;
  exceptionalDays: number;
  observedDays: number;
  exposureDays: number;
  coverageRatio: number;
} {
  const entries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const values = entries.map(([, value]) => value);
  const typical = Math.round(median(values));
  const deviations = values.map((value) => Math.abs(value - typical));
  const mad = median(deviations);
  const threshold = typical + Math.max(400, Number.isFinite(mad) ? mad * 3 : 0);
  const exceptional = values.filter((value) => value > threshold);
  const span = entries.length ? calendarSpanDays(entries[0][0], entries.at(-1)![0]) + 1 : 0;
  // Exceptional frequency needs a genuinely long denominator. A short seven-
  // day sync may establish the ordinary median, but it cannot promote one long
  // ride into a weekly baseline; missing days stay visible in coverage.
  const exposureDays = Math.max(28, Math.min(ACTIVITY_WINDOW_DAYS, span || values.length));
  const excess = exceptional.reduce((sum, value) => sum + Math.max(0, value - typical), 0);
  return {
    typical,
    allowance: Math.round(excess / exposureDays),
    exceptionalDays: exceptional.length,
    observedDays: values.length,
    exposureDays,
    coverageRatio: exposureDays ? Math.round((values.length / exposureDays) * 1000) / 1000 : 0,
  };
}

// Energy-balance derivation (MacroFactor-style, adherence-neutral). TDEE ≈ avg
// daily intake − (weighted weekly weight change in lb × 3500 / 7). Null-safe:
// too few weigh-ins or no intake → tdee null, confidence 'none'. Adherence-
// neutral: a thin logging week only lowers confidence — it NEVER blames the
// athlete and NEVER reads a gap as a number to act on. The deepening over the
// baseline: scale shocks are held until confirmed, higher confidence demands BOTH enough intake days AND enough weigh-ins
// spanning enough calendar days, and an active travel/illness window (from
// context_events) suppresses confidence — intake logging and the scale are both
// disrupted then, so we lean conservative rather than re-target on noise.
// MEMOIZED (repo/training-cache.ts): this JSON-parses every food note in the window
// on each call, and the Energy Balance view + coach context both reach it. It's a pure
// function of (windowDays, today, weigh-ins/profile/context [the training backstop] and
// food notes [the food backstop]), so memoize on exactly that and serve a structuredClone.
// Single-slot — the hot path is windowDays=21 for today.
let expenditureCache: { key: string; value: ExpenditureEstimate } | null = null;
registerTrainingCacheClear(() => {
  expenditureCache = null;
});

export function estimateExpenditure(windowDays = 21): ExpenditureEstimate {
  const normalizedWindow = normalizeWindowDays(windowDays);
  const key = `${normalizedWindow}|${localDateISO()}|${trainingBackstopSignature()}|${foodBackstopSignature()}`;
  if (expenditureCache && expenditureCache.key === key) return structuredClone(expenditureCache.value);
  const value = computeExpenditure(normalizedWindow);
  expenditureCache = { key, value };
  return structuredClone(value);
}

function computeExpenditure(windowDays = 21): ExpenditureEstimate {
  const today = localDateISO();
  // Today's food, movement and scale picture is incomplete until the local day
  // closes. It can inform the live diary, but never maintenance estimation.
  const completedThrough = addDaysISO(today, -1) ?? today;
  const since = addDaysISO(completedThrough, -Math.max(1, windowDays - 1)) ?? completedThrough;

  // Goal-pace projection off the measured weigh-in trend — surfaced on the Energy
  // Balance view alongside the expenditure read (plain language, never a score).
  // Shared with computeGoalCheck so /api/goal and /api/nutrition/expenditure agree.
  const storedProfile = getProfile() as any;
  const currentWeight = resolvedCurrentBodyweight(storedProfile, completedThrough);
  const prof = currentWeight ? { ...storedProfile, weight_lb: currentWeight.weight_lb } : storedProfile;
  const lbsToLose =
    prof?.goal_weight_lb != null && prof?.weight_lb != null ? Math.max(0, prof.weight_lb - prof.goal_weight_lb) : 0;
  const goalPace = projectGoalPace(prof, lbsToLose);

  // Intake is read first so scale and intake evidence can be restricted to one
  // common completed-day interval. Missing food days stay absent, never zero.
  const intakeWindow = completedIntakeWindow(windowDays, today);
  const kcalByDay = new Map(intakeWindow.days.filter((day) => day.credible).map((day) => [day.date, day.kcal]));
  const intakeDates = [...kcalByDay.keys()].sort();
  const overlapStart = intakeDates[0] ?? since;
  const overlapEnd = intakeDates.at(-1) ?? completedThrough;
  const overlapCalendarDays = Math.max(0, calendarSpanDays(overlapStart, overlapEnd) + 1);

  // Robust bodyweight trend over the overlap. A lone abrupt final drop is
  // treated as an unconfirmed scale/fluid shock and withheld until a later
  // weigh-in corroborates the new level. Theil-Sen then keeps any remaining
  // single noisy point from owning the energy calculation.
  const robust = robustWeightEvidence(overlapStart, overlapEnd);
  const wpts = robust.points;
  const trend = robust.trend_lb_wk;
  const weighDays = robust.weigh_ins;
  const weighSpanDays = robust.span_days;

  const dayTotals = [...kcalByDay.values()];
  const intakeAvg = dayTotals.length ? Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length) : null;

  const points = dayTotals.length;
  const credibleIntakeDays = intakeWindow.credible_days;
  const partialIntakeDays = intakeWindow.partial_days;
  const observedIntakeDays = credibleIntakeDays + partialIntakeDays;
  const intakeQuality: ExpenditureEstimate["quality"]["intake"] =
    observedIntakeDays === 0
      ? "none"
      : partialIntakeDays === 0 && credibleIntakeDays === points
        ? "complete"
        : credibleIntakeDays >= Math.ceil(observedIntakeDays * 0.6)
          ? "plausible"
          : "partial";
  // TDEE = intake − (weekly Δweight as a daily kcal balance). This stays
  // visible as outcome_tdee even when another anchor owns or helps settle the
  // chosen estimate. Activity is NEVER added on top of this outcome anchor.
  const outcomeTdee = intakeAvg != null && trend != null ? Math.round(intakeAvg - (trend * KCAL_PER_LB) / 7) : null;

  const profilePrior = profileSeedAnchor(prof);
  const plausibleMin = profilePrior
    ? Math.max(ABSOLUTE_TDEE_MIN, Math.round(profilePrior.tdee * 0.55))
    : ABSOLUTE_TDEE_MIN;
  const plausibleMax = profilePrior
    ? Math.min(ABSOLUTE_TDEE_MAX, Math.round(profilePrior.tdee * 1.8))
    : ABSOLUTE_TDEE_MAX;
  const outcomeQuality: ExpenditureEstimate["quality"]["outcome"] =
    outcomeTdee == null
      ? "unavailable"
      : outcomeTdee < plausibleMin
        ? "implausible_low"
        : outcomeTdee > plausibleMax
          ? "implausible_high"
          : "plausible";

  // Confidence demands BOTH enough intake days AND enough weigh-ins over enough
  // calendar span — a slope off two clustered days isn't trustworthy.
  let confidence: ExpenditureEstimate["confidence"] = "none";
  const calendarCoverage = overlapCalendarDays > 0 ? points / overlapCalendarDays : 0;
  if (outcomeTdee != null) {
    if (
      overlapCalendarDays >= 28 &&
      points >= 20 &&
      weighDays >= 10 &&
      weighSpanDays >= 28 &&
      calendarCoverage >= 0.7 &&
      !robust.terminal_shock
    )
      confidence = "high";
    else if (points >= 7 && weighDays >= 4 && weighSpanDays >= 7 && calendarCoverage >= 0.45) confidence = "medium";
    else confidence = "low";
  }
  if (robust.terminal_shock && confidence === "high") confidence = "medium";
  if (confidence === "high" && intakeQuality !== "complete") confidence = "medium";
  if (confidence === "medium" && intakeQuality === "partial") confidence = "low";
  if (outcomeQuality === "implausible_low" || outcomeQuality === "implausible_high") confidence = "low";

  // Suppress during an active travel/illness window: the scale and the food log
  // are both unreliable mid-trip / mid-illness, so we lower confidence by a step
  // rather than re-target on disrupted data. NOT a judgement — just caution.
  if (confidence !== "none" && confidence !== "low" && expenditureDisruptedNow()) {
    confidence = confidence === "high" ? "medium" : "low";
  }

  const activitySince = addDaysISO(completedThrough, -(ACTIVITY_WINDOW_DAYS - 1)) ?? since;
  const priors = priorAnchors({ since: activitySince, today: completedThrough, profile: prof });
  if (outcomeTdee != null && priors.length === 0 && (intakeQuality === "partial" || outcomeQuality !== "plausible")) {
    priors.push({
      kind: "profile_seed",
      tdee: CONSERVATIVE_FALLBACK_TDEE,
      days: 0,
      basis: "Conservative absolute fallback while intake coverage settles.",
      provenance: ["safety:conservative_absolute_fallback"],
      selected: false,
    });
  }
  const selectedPrior = priors[0] ?? null;
  const fusion = fusionWeights(confidence, outcomeTdee, selectedPrior?.tdee ?? null);
  const rawChosenTdee = weightedTdee(outcomeTdee, selectedPrior?.tdee ?? null, fusion);
  const chosenTdee =
    rawChosenTdee == null ? null : Math.min(ABSOLUTE_TDEE_MAX, Math.max(ABSOLUTE_TDEE_MIN, rawChosenTdee));
  const selectedExceptional = selectedPrior?.exceptional_allowance_kcal ?? 0;
  // `tdee` is the long-run average whichever anchor leads. When a wearable
  // pattern identifies an amortized exceptional-activity share, remove that
  // whole share to describe an ordinary day; prior fusion must not dilute it.
  const exceptionalAllowance = Math.max(0, Math.round(selectedExceptional));
  const typicalTdee = chosenTdee == null ? null : Math.max(ABSOLUTE_TDEE_MIN, chosenTdee - exceptionalAllowance);
  const uncertainty = confidence === "high" ? 100 : confidence === "medium" ? 175 : confidence === "low" ? 275 : 350;
  const tdeeBasis: ExpenditureBasis =
    outcomeTdee != null && selectedPrior && fusion.outcome_weight > 0 && fusion.prior_weight > 0
      ? "blended_outcome_prior"
      : outcomeTdee != null
        ? "outcome_trend"
        : (selectedPrior?.kind ?? "unavailable");
  const anchors: ExpenditureAnchor[] = [];
  if (outcomeTdee != null) {
    anchors.push({
      kind: "outcome",
      tdee: outcomeTdee,
      days: Math.min(points, weighDays),
      basis: "Logged intake calibrated against the robust completed-day bodyweight trend.",
      provenance: ["food_notes.parsed_json.kcal", ...new Set(wpts.map((point) => point.provenance))],
      selected: fusion.outcome_weight > 0,
      typical_tdee: outcomeTdee,
      exceptional_allowance_kcal: 0,
    });
  }
  anchors.push(
    ...priors.map((anchor) => ({ ...anchor, selected: anchor === selectedPrior && fusion.prior_weight > 0 }))
  );
  const basis = basisText(tdeeBasis, selectedPrior?.kind ?? null, confidence);
  const provenance = anchors.filter((anchor) => anchor.selected).flatMap((anchor) => anchor.provenance);

  return {
    tdee: chosenTdee,
    confidence,
    points,
    window_days: windowDays,
    intake_avg_kcal: intakeAvg,
    trend_lb_wk: trend == null ? null : Math.round(trend * 100) / 100,
    projected_goal_date: goalPace.projected_goal_date,
    projection_text: goalPace.projection_text,
    outcome_tdee: outcomeTdee,
    prior_tdee: selectedPrior?.tdee ?? null,
    prior_basis: selectedPrior?.kind ?? null,
    tdee_basis: tdeeBasis,
    basis,
    anchors,
    coverage: {
      intake_days: points,
      credible_intake_days: credibleIntakeDays,
      partial_intake_days: partialIntakeDays,
      weigh_in_days: weighDays,
      weigh_in_span_days: weighSpanDays,
      prior_days: selectedPrior?.days ?? 0,
      required_prior_days: MIN_PRIOR_DAYS,
    },
    provenance: [...new Set(provenance)],
    fusion,
    typical_tdee: typicalTdee,
    maintenance_range: {
      low: chosenTdee == null ? null : Math.max(ABSOLUTE_TDEE_MIN, chosenTdee - uncertainty),
      high: chosenTdee == null ? null : Math.min(ABSOLUTE_TDEE_MAX, chosenTdee + uncertainty),
    },
    exceptional_activity: {
      window_days: selectedPrior?.activity_window_days ?? ACTIVITY_WINDOW_DAYS,
      observed_days: selectedPrior?.activity_observed_days ?? 0,
      coverage_ratio: selectedPrior?.activity_coverage_ratio ?? 0,
      typical_active_kcal: selectedPrior?.typical_active_kcal ?? null,
      exceptional_days: selectedPrior?.exceptional_days ?? 0,
      frequency_per_week:
        selectedPrior?.exceptional_days && selectedPrior?.activity_window_days
          ? Math.round((selectedPrior.exceptional_days * 7 * 100) / selectedPrior.activity_window_days) / 100
          : 0,
      allowance_kcal_per_day: exceptionalAllowance,
    },
    quality: {
      intake: intakeQuality,
      outcome: outcomeQuality,
      explanation: robust.terminal_shock
        ? "The latest abrupt scale change is unconfirmed, so it stays visible but is withheld from tissue-energy math until another weigh-in corroborates it."
        : robust.level_shift === "corroborated"
          ? "Repeated weigh-ins corroborate a new scale level, so Cairn admits it cautiously over time instead of converting the whole step into tissue-energy change."
        : intakeQuality === "partial"
          ? "Some logged days look partial, so the outcome trend stays low-confidence and is blended with a safer starting anchor."
          : outcomeQuality === "implausible_low" || outcomeQuality === "implausible_high"
            ? "The raw outcome falls outside a conservative physiological range, so it stays visible but cannot set the target by itself."
            : confidence === "high"
              ? "The intake and weight record is complete enough for the outcome trend to lead."
              : "The estimate is still settling as intake and weight coverage grows.",
      plausible_tdee_min: plausibleMin,
      plausible_tdee_max: plausibleMax,
      terminal_weight_shock: robust.terminal_shock,
      terminal_weight_shock_date: robust.terminal_shock_date,
      weight_level_shift: robust.level_shift,
      outcome_overlap_days: overlapCalendarDays,
      outcome_calendar_coverage: Math.round(calendarCoverage * 1000) / 1000,
    },
  };
}

function fusionWeights(
  confidence: ExpenditureEstimate["confidence"],
  outcomeTdee: number | null,
  priorTdee: number | null
): { outcome_weight: number; prior_weight: number } {
  if (outcomeTdee == null) return { outcome_weight: 0, prior_weight: priorTdee == null ? 0 : 1 };
  if (priorTdee == null) return { outcome_weight: 1, prior_weight: 0 };
  // Outcome evidence earns authority slowly. A 21-day read can inform but never
  // own maintenance; even a stable 28+ day history retains an independent prior
  // so one model never becomes the whole-person truth.
  if (confidence === "high") return { outcome_weight: 3 / 4, prior_weight: 1 / 4 };
  if (confidence === "medium") return { outcome_weight: 1 / 3, prior_weight: 2 / 3 };
  if (confidence === "low") return { outcome_weight: 1 / 5, prior_weight: 4 / 5 };
  return { outcome_weight: 0, prior_weight: 1 };
}

function weightedTdee(
  outcomeTdee: number | null,
  priorTdee: number | null,
  weights: { outcome_weight: number; prior_weight: number }
): number | null {
  const terms = [
    outcomeTdee == null ? null : { value: outcomeTdee, weight: weights.outcome_weight },
    priorTdee == null ? null : { value: priorTdee, weight: weights.prior_weight },
  ].filter((term): term is { value: number; weight: number } => !!term && term.weight > 0);
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0);
  if (!totalWeight) return null;
  return Math.round(terms.reduce((sum, term) => sum + term.value * term.weight, 0) / totalWeight);
}

function basisText(
  basis: ExpenditureBasis,
  prior: ExpenditurePriorBasis | null,
  confidence: ExpenditureEstimate["confidence"]
): string {
  if (basis === "outcome_trend") return "Learned from logged intake and the bodyweight trend.";
  if (basis === "blended_outcome_prior") {
    const priorText =
      prior === "measured_rmr_active"
        ? "measured RMR and recent activity"
        : prior === "garmin_total_calories"
          ? "recent Garmin total calories"
          : "the profile starting estimate";
    return `${confidence === "medium" ? "Settling in" : "Early estimate"}: blending the outcome trend with ${priorText}.`;
  }
  if (basis === "measured_rmr_active") return "Backed by measured RMR and source-resolved recent active calories.";
  if (basis === "garmin_total_calories") return "Backed by recent Garmin total-calorie days.";
  if (basis === "profile_seed") return "Starting estimate from the profile and activity setting.";
  return "Not enough information to form an expenditure estimate yet.";
}

function priorAnchors(opts: { since: string; today: string; profile: any }): PriorAnchor[] {
  const candidates: PriorAnchor[] = [];
  const measured = measuredRmrActiveAnchor(opts.since, opts.today, opts.profile);
  const garminTotal = garminTotalAnchor(opts.since, opts.today);
  if (measured?.freshness === "fresh") candidates.push(measured);
  if (garminTotal) candidates.push(garminTotal);
  if (measured?.freshness === "aging") candidates.push(measured);
  const profileSeed = profileSeedAnchor(opts.profile);
  if (profileSeed) candidates.push(profileSeed);
  return candidates;
}

function measuredRmrActiveAnchor(since: string, today: string, profile: any): PriorAnchor | null {
  const rmr = measuredRmrAssessment(today);
  if (!rmr || rmr.freshness === "expired" || rmr.freshness === "undated") return null;
  const activeByDay = new Map<string, { value: number; source: string }>();
  const garminRows = db
    .prepare(
      `SELECT date, active_calories
         FROM garmin_daily_metrics
        WHERE date >= ? AND date <= ? AND active_calories IS NOT NULL AND active_calories >= 0
        ORDER BY date, id DESC`
    )
    .all(since, today) as any[];
  for (const row of garminRows) {
    const date = String(row.date ?? "").slice(0, 10);
    const value = Number(row.active_calories);
    if (date && Number.isFinite(value) && !activeByDay.has(date)) activeByDay.set(date, { value, source: "garmin" });
  }
  const genericRows = db
    .prepare(
      `SELECT date, source, active_calories
         FROM daily_metrics
        WHERE date >= ? AND date <= ? AND active_calories IS NOT NULL AND active_calories >= 0
        ORDER BY date, updated_at DESC, id DESC`
    )
    .all(since, today) as any[];
  for (const row of genericRows) {
    const date = String(row.date ?? "").slice(0, 10);
    const value = Number(row.active_calories);
    if (date && Number.isFinite(value) && !activeByDay.has(date)) {
      activeByDay.set(date, { value, source: String(row.source || "generic") });
    }
  }
  if (activeByDay.size < MIN_PRIOR_DAYS) return null;
  const readings = [...activeByDay.values()];
  const pattern = activityPattern(new Map([...activeByDay].map(([date, row]) => [date, row.value])));
  if (pattern.coverageRatio < MIN_PRIOR_COVERAGE) return null;
  const active = pattern.typical + pattern.allowance;
  const sources = [...new Set(readings.map((row) => row.source))].sort();
  const formula = profileSeedAnchor(profile);
  const formulaRmr = formula
    ? formula.tdee / Math.min(2.5, Math.max(1.1, Number(profile?.activity_factor) || 1.5))
    : rmr.kcal;
  const weightAdjustment = measuredRmrWeightAdjustment(rmr, today);
  const adjustedRmr = weightAdjustment?.adjusted_kcal ?? rmr.kcal;
  const effectiveRmr = Math.round(formulaRmr + (adjustedRmr - formulaRmr) * rmr.freshness_weight);
  return {
    kind: "measured_rmr_active",
    tdee: Math.round(effectiveRmr + active),
    typical_tdee: Math.round(effectiveRmr + pattern.typical),
    exceptional_allowance_kcal: pattern.allowance,
    days: activeByDay.size,
    basis: `${rmr.freshness === "fresh" ? "Measured" : "Aging measured"} RMR (${adjustedRmr} kcal${weightAdjustment ? `, adjusted ${weightAdjustment.adjustment_kcal >= 0 ? "+" : ""}${weightAdjustment.adjustment_kcal} for measured weight change` : ""}) plus ordinary active calories (${pattern.typical} kcal) and ${pattern.allowance} kcal/day frequency-amortized exceptional activity.`,
    provenance: [
      `profile.measured_rmr_kcal:${rmr.source}`,
      ...(weightAdjustment ? ["bodyweight:rmr_test_nearest", "bodyweight:current_robust"] : []),
      ...sources.map((source) => `daily_active_calories:${source}`),
    ],
    selected: false,
    source_date: rmr.date,
    age_days: rmr.age_days,
    freshness: rmr.freshness,
    freshness_weight: rmr.freshness_weight,
    activity_window_days: pattern.exposureDays,
    activity_observed_days: pattern.observedDays,
    activity_coverage_ratio: pattern.coverageRatio,
    typical_active_kcal: pattern.typical,
    exceptional_days: pattern.exceptionalDays,
    rmr_adjustment: weightAdjustment
      ? {
          original_kcal: rmr.kcal,
          adjusted_kcal: weightAdjustment.adjusted_kcal,
          test_weight_lb: weightAdjustment.test_weight_lb,
          current_weight_lb: weightAdjustment.current_weight_lb,
          delta_lb: weightAdjustment.delta_lb,
          test_weight_date: weightAdjustment.test_weight_date,
        }
      : null,
  };
}

function garminTotalAnchor(since: string, today: string): PriorAnchor | null {
  const rows = db
    .prepare(
      `SELECT date, total_calories
         FROM garmin_daily_metrics
        WHERE date >= ? AND date <= ? AND total_calories IS NOT NULL AND total_calories > 0
        ORDER BY date, id DESC`
    )
    .all(since, today) as any[];
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const date = String(row.date ?? "").slice(0, 10);
    const value = Number(row.total_calories);
    if (date && Number.isFinite(value) && !byDay.has(date)) byDay.set(date, value);
  }
  if (byDay.size < MIN_PRIOR_DAYS) return null;
  const pattern = activityPattern(byDay);
  if (pattern.coverageRatio < MIN_PRIOR_COVERAGE) return null;
  return {
    kind: "garmin_total_calories",
    tdee: pattern.typical + pattern.allowance,
    typical_tdee: pattern.typical,
    exceptional_allowance_kcal: pattern.allowance,
    days: byDay.size,
    basis: `${byDay.size} Garmin total-calorie days: ordinary-day median ${pattern.typical} kcal plus ${pattern.allowance} kcal/day frequency-amortized exceptional activity.`,
    provenance: ["garmin_daily_metrics.total_calories"],
    selected: false,
    activity_window_days: pattern.exposureDays,
    activity_observed_days: pattern.observedDays,
    activity_coverage_ratio: pattern.coverageRatio,
    typical_active_kcal: null,
    exceptional_days: pattern.exceptionalDays,
  };
}

function measuredRmrWeightAdjustment(
  rmr: { kcal: number; date: string | null },
  through: string
): {
  adjusted_kcal: number;
  adjustment_kcal: number;
  test_weight_lb: number;
  current_weight_lb: number;
  delta_lb: number;
  test_weight_date: string;
} | null {
  if (!rmr.date || !/^\d{4}-\d{2}-\d{2}$/.test(rmr.date)) return null;
  const near = canonicalBodyweightSeries({
    since: addDaysISO(rmr.date, -14),
    through: addDaysISO(rmr.date, 14),
  });
  const testDay = Date.parse(`${rmr.date}T00:00:00Z`);
  const nearest = near
    .map((point) => ({ point, distance: Math.abs(Date.parse(`${point.date}T00:00:00Z`) - testDay) }))
    .sort((a, b) => a.distance - b.distance || b.point.date.localeCompare(a.point.date))[0]?.point;
  if (!nearest) return null; // never invent test-time weight
  const recent = canonicalBodyweightSeries({ since: addDaysISO(through, -13), through });
  if (!recent.length) return null;
  const currentWeight = median(recent.slice(-3).map((point) => Number(point.weight_lb)));
  const deltaLb = currentWeight - Number(nearest.weight_lb);
  if (!Number.isFinite(deltaLb) || Math.abs(deltaLb) < 5) return null;
  // Mifflin's weight coefficient is ~4.54 kcal/lb. Keep the correction modest
  // because a scale change does not tell us how much was lean versus fat mass.
  const maxAdjustment = Math.round(rmr.kcal * 0.08);
  const adjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, Math.round(deltaLb * 4.54)));
  return {
    adjusted_kcal: Math.round(rmr.kcal + adjustment),
    adjustment_kcal: adjustment,
    test_weight_lb: Math.round(Number(nearest.weight_lb) * 100) / 100,
    current_weight_lb: Math.round(currentWeight * 100) / 100,
    delta_lb: Math.round(deltaLb * 100) / 100,
    test_weight_date: nearest.date,
  };
}

function profileSeedAnchor(profile: any): PriorAnchor | null {
  const weightLb = Number(profile?.weight_lb);
  const heightCm = Number(profile?.height_cm);
  const age = Number(profile?.age);
  if (![weightLb, heightCm, age].every(Number.isFinite) || weightLb <= 0 || heightCm <= 0 || age <= 0) return null;
  const sexAdjustment = String(profile?.sex || "male").toLowerCase() === "female" ? -161 : 5;
  const bmr = 10 * (weightLb / LB_PER_KG) + 6.25 * heightCm - 5 * age + sexAdjustment;
  const rawFactor = Number(profile?.activity_factor);
  const factor = Number.isFinite(rawFactor) ? Math.min(2.5, Math.max(1.1, rawFactor)) : 1.5;
  return {
    kind: "profile_seed",
    tdee: Math.round(bmr * factor),
    days: 0,
    basis: `Mifflin-St Jeor profile seed using activity factor ${Math.round(factor * 100) / 100}.`,
    provenance: ["profile:mifflin_st_jeor", "profile.activity_factor"],
    selected: false,
  };
}

// True when an active/upcoming context_event makes intake + weight unreliable
// right now: any trip overlapping today, or a life_event whose text reads as
// illness/sick. Used to lower expenditure confidence (never to scold).
function expenditureDisruptedNow(): boolean {
  const today = localDateISO();
  const events = listContextEvents({ activeOnly: true }) as any[];
  const ILLNESS =
    /\b(ill|illness|sick|sickness|flu|fever|cold|covid|infection|food ?poison|stomach|gastro|bug|virus|unwell)\b/i;
  for (const e of events) {
    const start = e?.start_date ? String(e.start_date) : null;
    const end = e?.end_date ? String(e.end_date) : null;
    // Active today = started on/before today AND not yet ended (open-ended counts).
    const startedByNow = !start || start <= today;
    const notEnded = !end || end >= today;
    if (!startedByNow || !notEnded) continue;
    if (e?.kind === "trip") return true;
    if (e?.kind === "life_event") {
      const txt = `${e?.title ?? ""} ${e?.detail ?? ""} ${e?.meta?.impact ?? ""}`;
      if (ILLNESS.test(txt)) return true;
    }
  }
  return false;
}
