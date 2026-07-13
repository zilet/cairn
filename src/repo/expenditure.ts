// Adaptive nutrition — the MacroFactor-style energy-balance derivation (TDEE from
// intake vs. the recency-weighted weigh-in trend). Adherence-neutral: a thin logging
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
  quality: {
    intake: "none" | "partial" | "plausible" | "complete";
    outcome: "unavailable" | "plausible" | "implausible_low" | "implausible_high";
    explanation: string;
    plausible_tdee_min: number;
    plausible_tdee_max: number;
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
}

type PriorAnchor = Omit<ExpenditureAnchor, "kind"> & { kind: ExpenditurePriorBasis };

const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;
const MIN_PRIOR_DAYS = 7;
const ABSOLUTE_TDEE_MIN = 1_200;
const ABSOLUTE_TDEE_MAX = 8_000;
const CONSERVATIVE_FALLBACK_TDEE = 1_800;

function normalizeWindowDays(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 21;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.trunc(n)));
}

// Energy-balance derivation (MacroFactor-style, adherence-neutral). TDEE ≈ avg
// daily intake − (weighted weekly weight change in lb × 3500 / 7). Null-safe:
// too few weigh-ins or no intake → tdee null, confidence 'none'. Adherence-
// neutral: a thin logging week only lowers confidence — it NEVER blames the
// athlete and NEVER reads a gap as a number to act on. The deepening over the
// baseline: recent weigh-ins are weighted more heavily (the body's "now" matters
// most), higher confidence demands BOTH enough intake days AND enough weigh-ins
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
  const since = addDaysISO(today, -Math.max(1, windowDays - 1)) ?? today;
  const nowDay = Date.parse(`${today}T00:00:00Z`) / 864e5;

  // Goal-pace projection off the measured weigh-in trend — surfaced on the Energy
  // Balance view alongside the expenditure read (plain language, never a score).
  // Shared with computeGoalCheck so /api/goal and /api/nutrition/expenditure agree.
  const storedProfile = getProfile() as any;
  const currentWeight = resolvedCurrentBodyweight(storedProfile, today);
  const prof = currentWeight ? { ...storedProfile, weight_lb: currentWeight.weight_lb } : storedProfile;
  const lbsToLose =
    prof?.goal_weight_lb != null && prof?.weight_lb != null ? Math.max(0, prof.weight_lb - prof.goal_weight_lb) : 0;
  const goalPace = projectGoalPace(prof, lbsToLose);

  // Bodyweight trend over the window — a RECENCY-WEIGHTED least-squares slope
  // (lb/week). Each weigh-in gets weight exp(-ageDays / halfLife*1.4427) so the
  // newest days dominate; MacroFactor's adaptive expenditure leans the same way
  // (the body's current trajectory matters more than three weeks ago).
  const wpts = canonicalBodyweightSeries({ since, through: today });
  let trend: number | null = null;
  const weighDays = new Set(wpts.map((p) => String(p.date))).size;
  let weighSpanDays = 0; // first→last calendar span, for confidence
  if (wpts.length >= 2) {
    const xs = wpts.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
    const ys = wpts.map((p) => Number(p.weight_lb));
    weighSpanDays = xs[xs.length - 1] - xs[0];
    if (weighSpanDays >= 3) {
      // Half-life ~10 days: a weigh-in 10 days old counts ~half a fresh one.
      const halfLife = Math.max(7, windowDays / 2);
      const ws = xs.map((x) => Math.exp(-((nowDay - x) * Math.LN2) / halfLife));
      const sw = ws.reduce((a, b) => a + b, 0);
      const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / sw;
      const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / sw;
      let num = 0,
        den = 0;
      for (let i = 0; i < xs.length; i++) {
        num += ws[i] * (xs[i] - mx) * (ys[i] - my);
        den += ws[i] * (xs[i] - mx) ** 2;
      }
      if (den > 0) trend = (num / den) * 7; // lb/day → lb/wk
    }
  }

  // Average daily intake from food_notes over the window (sum kcal per day,
  // then average across days that have any logged food). Days with no food
  // logged are simply absent — never counted as zero (that would slander an
  // off-logging day as a crash diet); they only thin the data.
  const notes = db
    .prepare(
      `SELECT COALESCE(date, substr(created_at, 1, 10)) AS day, meal, parsed_json
      FROM food_notes
      WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?
        AND COALESCE(date, substr(created_at, 1, 10)) <= ?`
    )
    .all(since, today) as any[];
  const kcalByDay = new Map<string, number>();
  const mealsByDay = new Map<string, string[]>();
  for (const n of notes) {
    let parsed: any = null;
    try {
      parsed = n.parsed_json ? JSON.parse(n.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const kcal = Number(parsed?.kcal);
    if (!Number.isFinite(kcal) || kcal <= 0) continue;
    const day = String(n.day ?? "").slice(0, 10);
    if (!day) continue;
    kcalByDay.set(day, (kcalByDay.get(day) ?? 0) + kcal);
    mealsByDay.set(day, [...(mealsByDay.get(day) ?? []), String(n.meal || "meal").trim().toLowerCase()]);
  }
  const dayTotals = [...kcalByDay.values()];
  const intakeAvg = dayTotals.length ? Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length) : null;

  const points = dayTotals.length;
  let credibleIntakeDays = 0;
  let partialIntakeDays = 0;
  for (const [day, total] of kcalByDay) {
    const meals = mealsByDay.get(day) ?? [];
    const snackOnly = meals.length > 0 && meals.every((meal) => /^(snack|treat|drink|beverage)$/.test(meal));
    const primarySlots = new Set(meals.filter((meal) => /^(breakfast|brunch|lunch|dinner|supper)$/.test(meal))).size;
    const genericDayTotal = meals.some((meal) => meal === "meal") && total >= 1_000;
    if (!snackOnly && (primarySlots >= 2 || meals.filter((meal) => !/^(snack|treat|drink|beverage)$/.test(meal)).length >= 2 || genericDayTotal)) {
      credibleIntakeDays++;
    } else {
      partialIntakeDays++;
    }
  }
  const intakeQuality: ExpenditureEstimate["quality"]["intake"] =
    points === 0
      ? "none"
      : partialIntakeDays === 0 && credibleIntakeDays === points
        ? "complete"
        : credibleIntakeDays >= Math.ceil(points * 0.6)
          ? "plausible"
          : "partial";
  // TDEE = intake − (weekly Δweight as a daily kcal balance). This stays
  // visible as outcome_tdee even when another anchor owns or helps settle the
  // chosen estimate. Activity is NEVER added on top of this outcome anchor.
  const outcomeTdee = intakeAvg != null && trend != null ? Math.round(intakeAvg - (trend * KCAL_PER_LB) / 7) : null;

  const profilePrior = profileSeedAnchor(prof);
  const plausibleMin = profilePrior ? Math.max(ABSOLUTE_TDEE_MIN, Math.round(profilePrior.tdee * 0.55)) : ABSOLUTE_TDEE_MIN;
  const plausibleMax = profilePrior ? Math.min(ABSOLUTE_TDEE_MAX, Math.round(profilePrior.tdee * 1.8)) : ABSOLUTE_TDEE_MAX;
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
  if (outcomeTdee != null) {
    if (points >= 14 && weighDays >= 8 && weighSpanDays >= 14) confidence = "high";
    else if (points >= 7 && weighDays >= 4 && weighSpanDays >= 7) confidence = "medium";
    else confidence = "low";
  }
  if (confidence === "high" && intakeQuality !== "complete") confidence = "medium";
  if (confidence === "medium" && intakeQuality === "partial") confidence = "low";
  if (outcomeQuality === "implausible_low" || outcomeQuality === "implausible_high") confidence = "low";

  // Suppress during an active travel/illness window: the scale and the food log
  // are both unreliable mid-trip / mid-illness, so we lower confidence by a step
  // rather than re-target on disrupted data. NOT a judgement — just caution.
  if (confidence !== "none" && confidence !== "low" && expenditureDisruptedNow()) {
    confidence = confidence === "high" ? "medium" : "low";
  }

  const priors = priorAnchors({ since, today, profile: prof });
  if (
    outcomeTdee != null &&
    priors.length === 0 &&
    (intakeQuality === "partial" || outcomeQuality !== "plausible")
  ) {
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
  const chosenTdee = rawChosenTdee == null ? null : Math.min(ABSOLUTE_TDEE_MAX, Math.max(ABSOLUTE_TDEE_MIN, rawChosenTdee));
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
      basis: "Logged intake calibrated against the recency-weighted bodyweight trend.",
      provenance: [
        "food_notes.parsed_json.kcal",
        ...new Set(wpts.map((point) => point.provenance)),
      ],
      selected: fusion.outcome_weight > 0,
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
    quality: {
      intake: intakeQuality,
      outcome: outcomeQuality,
      explanation:
        intakeQuality === "partial"
          ? "Some logged days look partial, so the outcome trend stays low-confidence and is blended with a safer starting anchor."
          : outcomeQuality === "implausible_low" || outcomeQuality === "implausible_high"
            ? "The raw outcome falls outside a conservative physiological range, so it stays visible but cannot set the target by itself."
            : confidence === "high"
              ? "The intake and weight record is complete enough for the outcome trend to lead."
              : "The estimate is still settling as intake and weight coverage grows.",
      plausible_tdee_min: plausibleMin,
      plausible_tdee_max: plausibleMax,
    },
  };
}

function fusionWeights(
  confidence: ExpenditureEstimate["confidence"],
  outcomeTdee: number | null,
  priorTdee: number | null
): { outcome_weight: number; prior_weight: number } {
  if (outcomeTdee == null) return { outcome_weight: 0, prior_weight: priorTdee == null ? 0 : 1 };
  if (priorTdee == null || confidence === "high") return { outcome_weight: 1, prior_weight: 0 };
  if (confidence === "medium") return { outcome_weight: 2 / 3, prior_weight: 1 / 3 };
  if (confidence === "low") return { outcome_weight: 1 / 3, prior_weight: 2 / 3 };
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
  const active = Math.round(readings.reduce((sum, row) => sum + row.value, 0) / readings.length);
  const sources = [...new Set(readings.map((row) => row.source))].sort();
  const formula = profileSeedAnchor(profile);
  const formulaRmr = formula ? formula.tdee / Math.min(2.5, Math.max(1.1, Number(profile?.activity_factor) || 1.5)) : rmr.kcal;
  const effectiveRmr = Math.round(formulaRmr + (rmr.kcal - formulaRmr) * rmr.freshness_weight);
  return {
    kind: "measured_rmr_active",
    tdee: Math.round(effectiveRmr + active),
    days: activeByDay.size,
    basis: `${rmr.freshness === "fresh" ? "Measured" : "Aging measured"} RMR (${rmr.kcal} kcal) plus ${activeByDay.size}-day average active calories (${active} kcal).`,
    provenance: [
      `profile.measured_rmr_kcal:${rmr.source}`,
      ...sources.map((source) => `daily_active_calories:${source}`),
    ],
    selected: false,
    source_date: rmr.date,
    age_days: rmr.age_days,
    freshness: rmr.freshness,
    freshness_weight: rmr.freshness_weight,
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
  const values = [...byDay.values()];
  return {
    kind: "garmin_total_calories",
    tdee: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    days: byDay.size,
    basis: `${byDay.size}-day average of Garmin total calories.`,
    provenance: ["garmin_daily_metrics.total_calories"],
    selected: false,
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
