import { db } from "../db.js";
import { annotateDirectiveFreshness } from "./propagation.js";
import { listActiveDirectives } from "./coach.js";
import { getDayIntake, hydrateNutritionTarget } from "./nutrition.js";
import { addDaysISO, localDateISO } from "./shared.js";

export type NutritionProgressNutrient = "kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g";
type TargetNutrient = Exclude<NutritionProgressNutrient, "fiber_g">;

export interface NutritionTargetProvenance {
  source: string;
  effective_date: string | null;
  freshness: "fresh" | "explicit";
}

export interface NutritionProgressDay {
  date: string;
  logged: boolean;
  entry_count: number;
  pending_entries: number;
  capture: "unlogged" | "partial" | "macro_known" | "open";
  nutrients: Record<NutritionProgressNutrient, number | null>;
  known: Record<NutritionProgressNutrient, boolean>;
  target: {
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    source: string;
    effective_date: string | null;
    provenance: Record<TargetNutrient, NutritionTargetProvenance | null>;
  } | null;
}

export interface NutritionProgressSummary {
  nutrient: NutritionProgressNutrient;
  label: string;
  unit: "kcal" | "g";
  average: number | null;
  known_days: number;
  trend: "rising" | "falling" | "steady" | "unknown";
  change: number | null;
  reference: number | null;
  reference_label: string | null;
}

type NutritionPatternBand = "low" | "moderate" | "high" | "unknown";
type FoodQualityBand = "mostly_whole" | "mixed" | "mostly_ultra_processed" | "unknown";

export interface NutritionPatternEstimate {
  sampled_entries: number;
  sampled_days: number;
  total_entries: number;
  total_logged_days: number;
  note: string;
  food_quality: Record<FoodQualityBand, number>;
  saturated_fat: Record<NutritionPatternBand, number>;
  added_sugar: Record<NutritionPatternBand, number>;
  sodium: Record<NutritionPatternBand, number>;
  potassium: Record<NutritionPatternBand, number>;
  calcium: Record<NutritionPatternBand, number>;
  iron: Record<NutritionPatternBand, number>;
  omega_3_source: { yes: number; no: number; unknown: number };
  confidence: { low: number; medium: number; high: number; unknown: number };
  basis: { label: number; user_report: number; estimated_from_foods: number; photo: number; unknown: number };
  fat_grams: {
    sampled_entries: number;
    average_saturated_fat_g: number | null;
    average_unsaturated_fat_g: number | null;
  };
}

const NUTRIENTS: readonly NutritionProgressNutrient[] = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"];
const LABELS: Record<NutritionProgressNutrient, string> = {
  kcal: "Recorded energy",
  protein_g: "Protein",
  carbs_g: "Carbohydrate",
  fat_g: "Fat",
  fiber_g: "Fiber",
};
const WATCH_NUTRITION_RE =
  /\b(apo\s?b|ldl|cholesterol|lipoprotein|triglycer|glucose|a1c|vitamin d|omega-?3|homocysteine|ferritin|iron)\b/i;
const FIBER_REFERENCE_G = 30;

function clampDays(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(14, Math.min(90, Math.trunc(n))) : 35;
}

function parseJson(value: unknown): any {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function finiteNonnegative(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function emptyCounts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function nutritionPatternEstimate(rows: any[], loggedDays: number): NutritionPatternEstimate {
  const patterns = rows
    .map((row) => ({
      date: String(row.day || "").slice(0, 10),
      parsed: row.parsed ?? parseJson(row.parsed_json),
    }))
    .map((sample) => ({ ...sample, value: sample.parsed?.nutrition_pattern }))
    .filter((sample) => sample.value && typeof sample.value === "object" && !Array.isArray(sample.value));
  const patternDays = new Set(patterns.map((sample) => sample.date).filter(Boolean));
  const patternBands = ["low", "moderate", "high", "unknown"] as const;
  const qualityBands = ["mostly_whole", "mixed", "mostly_ultra_processed", "unknown"] as const;
  const confidenceBands = ["low", "medium", "high", "unknown"] as const;
  const basisBands = ["label", "user_report", "estimated_from_foods", "photo", "unknown"] as const;
  const bandFields = {
    saturated_fat: emptyCounts(patternBands),
    added_sugar: emptyCounts(patternBands),
    sodium: emptyCounts(patternBands),
    potassium: emptyCounts(patternBands),
    calcium: emptyCounts(patternBands),
    iron: emptyCounts(patternBands),
  };
  const foodQuality = emptyCounts(qualityBands);
  const confidence = emptyCounts(confidenceBands);
  const basis = emptyCounts(basisBands);
  const omega = { yes: 0, no: 0, unknown: 0 };
  let saturatedFatG = 0;
  let unsaturatedFatG = 0;
  let fatGramSamples = 0;

  for (const { parsed, value } of patterns) {
    const confidenceValue = String(value.confidence ?? "unknown").toLowerCase() as keyof typeof confidence;
    // Band tallies are COUNTS an athlete reads verbatim ("2 high saturated-fat
    // estimates"), so they only ever move by whole entries. A low-confidence
    // estimate is an uncertain guess — not evidence either way, exactly as
    // foodRecovery treats it — so it is left out of the bands entirely rather
    // than fractionally weighted. It still shows up in the provenance
    // confidence/basis histograms below, which is where "2 of your 5 were rough
    // guesses" lives.
    if (confidenceValue !== "low") {
      for (const key of Object.keys(bandFields) as Array<keyof typeof bandFields>) {
        const band = String(value[key] ?? "unknown").toLowerCase() as NutritionPatternBand;
        bandFields[key][patternBands.includes(band) ? band : "unknown"] += 1;
      }
    }
    const quality = String(value.food_quality ?? "unknown").toLowerCase() as FoodQualityBand;
    foodQuality[qualityBands.includes(quality) ? quality : "unknown"] += 1;
    confidence[confidenceBands.includes(confidenceValue) ? confidenceValue : "unknown"] += 1;
    const basisValue = String(value.basis ?? "unknown").toLowerCase() as keyof typeof basis;
    basis[basisBands.includes(basisValue) ? basisValue : "unknown"] += 1;
    if (value.omega_3_source === true) omega.yes += 1;
    else if (value.omega_3_source === false) omega.no += 1;
    else omega.unknown += 1;

    const saturated = finiteNonnegative(value.saturated_fat_g);
    const unsaturated = finiteNonnegative(value.unsaturated_fat_g);
    const totalFat = finiteNonnegative(parsed?.fat_g);
    const internallyConsistent =
      totalFat != null && saturated != null && unsaturated != null && saturated + unsaturated <= totalFat * 1.15;
    if (internallyConsistent) {
      fatGramSamples += 1;
      saturatedFatG += saturated;
      unsaturatedFatG += unsaturated;
    }
  }

  return {
    sampled_entries: patterns.length,
    sampled_days: patternDays.size,
    total_entries: rows.length,
    total_logged_days: loggedDays,
    note: patterns.length
      ? `These are entry-level estimates from ${patterns.length} of ${rows.length} recorded entries across ${patternDays.size} of ${loggedDays} logged days; they are not extrapolated to the rest of the window.`
      : "No recorded entries in this window have food-quality estimates yet; nothing is extrapolated from the macro totals.",
    food_quality: foodQuality,
    ...bandFields,
    omega_3_source: omega,
    confidence,
    basis,
    fat_grams: {
      sampled_entries: fatGramSamples,
      average_saturated_fat_g: fatGramSamples ? Math.round((saturatedFatG / fatGramSamples) * 10) / 10 : null,
      average_unsaturated_fat_g: fatGramSamples ? Math.round((unsaturatedFatG / fatGramSamples) * 10) / 10 : null,
    },
  };
}

function historicalTarget(row: any, date: string): NutritionProgressDay["target"] {
  const hydrated = hydrateNutritionTarget(row, date);
  if (!hydrated || hydrated.review_due) return null;
  const kcal = finiteNonnegative(hydrated.target_kcal);
  const protein = finiteNonnegative(hydrated.protein_g);
  const carbs = finiteNonnegative(hydrated.carbs_g);
  const fat = finiteNonnegative(hydrated.fat_g);
  if (kcal == null && protein == null && carbs == null && fat == null) return null;
  const source = String(hydrated.source || "accepted");
  const effectiveDate = String(hydrated.effective_date || date);
  const freshness = hydrated.freshness === "explicit" ? "explicit" : "fresh";
  const provenanceFor = (value: number | null): NutritionTargetProvenance | null =>
    value == null ? null : { source, effective_date: effectiveDate, freshness };
  return {
    kcal: kcal == null ? null : Math.round(kcal),
    protein_g: protein == null ? null : Math.round(protein),
    carbs_g: carbs == null ? null : Math.round(carbs),
    fat_g: fat == null ? null : Math.round(fat),
    source,
    effective_date: effectiveDate,
    provenance: {
      kcal: provenanceFor(kcal),
      protein_g: provenanceFor(protein),
      carbs_g: provenanceFor(carbs),
      fat_g: provenanceFor(fat),
    },
  };
}

function roundAverage(values: number[], nutrient: NutritionProgressNutrient): number | null {
  if (!values.length) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return nutrient === "kcal" ? Math.round(avg) : Math.round(avg * 10) / 10;
}

function nutrientTrend(
  values: Array<{ date: string; value: number }>,
  nutrient: NutritionProgressNutrient
): Pick<NutritionProgressSummary, "trend" | "change"> {
  if (values.length < 8) return { trend: "unknown", change: null };
  const midpoint = Math.floor(values.length / 2);
  const first = roundAverage(
    values.slice(0, midpoint).map((point) => point.value),
    nutrient
  );
  const second = roundAverage(
    values.slice(midpoint).map((point) => point.value),
    nutrient
  );
  if (first == null || second == null) return { trend: "unknown", change: null };
  const change = Math.round((second - first) * 10) / 10;
  const threshold = nutrient === "kcal" ? Math.max(75, Math.abs(first) * 0.05) : Math.max(2, Math.abs(first) * 0.05);
  return {
    trend: Math.abs(change) < threshold ? "steady" : change > 0 ? "rising" : "falling",
    change,
  };
}

function recordObservationDensity(
  days: number,
  closedLoggedDays: number,
  macroKnownDays: number,
  knownDays: number
): "none" | "sparse" | "moderate" | "dense" {
  if (!closedLoggedDays || !knownDays) return "none";
  const loggedCoverage = closedLoggedDays / Math.max(1, days - 1);
  const knownCoverage = macroKnownDays / Math.max(1, days - 1);
  if (days >= 28 && loggedCoverage >= 0.8 && knownCoverage >= 0.65 && knownDays >= 21) return "dense";
  if (loggedCoverage >= 0.5 && knownCoverage >= 0.35 && knownDays >= 10) return "moderate";
  return "sparse";
}

function currentReference(targetRow: any): {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number;
  source: string;
  effective_date: string | null;
  provenance: Record<NutritionProgressNutrient, NutritionTargetProvenance | null>;
} {
  const today = getDayIntake(localDateISO());
  const accepted = historicalTarget(targetRow, localDateISO());
  const todaySource = String(today.target?.source || "formula");
  const todayEffectiveDate = todaySource === "formula" ? null : (accepted?.provenance.kcal?.effective_date ?? null);
  const todayFreshness: NutritionTargetProvenance["freshness"] = accepted?.provenance.kcal?.freshness ?? "fresh";
  const provenanceForToday = (value: number | null | undefined): NutritionTargetProvenance | null =>
    value == null ? null : { source: todaySource, effective_date: todayEffectiveDate, freshness: todayFreshness };
  const acceptedProtein = accepted?.protein_g ?? null;
  const displayedProtein = finiteNonnegative(today.target?.protein_g);
  // An accepted kcal target can coexist with a formula-derived protein floor.
  // Do not describe the raised protein value as accepted when the accepted row
  // did not actually supply it.
  const proteinSource =
    todaySource === "accepted" &&
    (acceptedProtein == null || (displayedProtein != null && displayedProtein > acceptedProtein))
      ? "formula"
      : todaySource;
  const proteinProvenance =
    displayedProtein == null
      ? null
      : proteinSource === "formula"
        ? { source: "formula", effective_date: null, freshness: "fresh" as const }
        : {
            source: proteinSource,
            effective_date: accepted?.provenance.protein_g?.effective_date ?? todayEffectiveDate,
            freshness: accepted?.provenance.protein_g?.freshness ?? todayFreshness,
          };
  const provenance = {
    kcal: provenanceForToday(today.target?.kcal),
    protein_g: proteinProvenance,
    carbs_g: accepted?.provenance.carbs_g ?? null,
    fat_g: accepted?.provenance.fat_g ?? null,
    fiber_g: {
      source: "longevity_floor",
      effective_date: null,
      freshness: "explicit",
    } as NutritionTargetProvenance,
  };
  const sources = new Set(
    Object.values(provenance)
      .filter((item): item is NutritionTargetProvenance => item != null)
      .map((item) => item.source)
  );
  const effectiveDates = new Set(
    Object.values(provenance)
      .map((item) => item?.effective_date)
      .filter((value): value is string => value != null)
  );
  return {
    kcal: today.target?.kcal ?? null,
    protein_g: today.target?.protein_g ?? null,
    carbs_g: accepted?.carbs_g ?? null,
    fat_g: accepted?.fat_g ?? null,
    fiber_g: FIBER_REFERENCE_G,
    source: sources.size === 1 ? [...sources][0] : "mixed",
    effective_date: effectiveDates.size === 1 ? [...effectiveDates][0] : null,
    provenance,
  };
}

// Is an active directive one this athlete's nutrition should account for? A
// domain:'nutrition' directive always qualifies; a domain:'watch' one qualifies
// only when it names a nutrition-actionable marker (lipids, glucose, key
// micronutrients). Exported so callers outside this file (meal-plan validation)
// identify nutrition-relevant directives the same way, rather than re-deriving
// the domain/marker check themselves.
export function nutritionRelevantDirectives(): any[] {
  return annotateDirectiveFreshness(listActiveDirectives(), localDateISO()).filter((directive: any) => {
    if (directive?.domain === "nutrition") return true;
    return (
      directive?.domain === "watch" &&
      WATCH_NUTRITION_RE.test(`${directive.marker || ""} ${directive.directive || ""}`)
    );
  });
}

function directiveContext() {
  const active = nutritionRelevantDirectives()
    .sort((a: any, b: any) => {
      const domain = Number(b.domain === "nutrition") - Number(a.domain === "nutrition");
      if (domain) return domain;
      const stale = Number(!!a.stale || !!a.stale_measurement) - Number(!!b.stale || !!b.stale_measurement);
      return stale || Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, 4);
  return active.map((directive: any) => ({
    id: directive.id,
    domain: directive.domain,
    marker: directive.marker ?? null,
    directive: directive.directive ?? null,
    rationale: directive.rationale ?? null,
    citation: directive.citation ?? null,
    uncertain: !!directive.uncertain,
    trigger_date: directive.trigger_date ?? null,
    acute: !!directive.acute,
    age_days: directive.age_days ?? null,
    stale: !!directive.stale,
    transient: !!directive.transient,
    transient_reason: directive.transient_reason ?? null,
    stale_measurement: !!directive.stale_measurement,
    rescan_reason: directive.rescan_reason ?? null,
  }));
}

export function nutritionProgress(windowDays = 35) {
  const days = clampDays(windowDays);
  const through = localDateISO();
  const since = addDaysISO(through, -(days - 1)) ?? through;
  const rows = db
    .prepare(
      `SELECT id, COALESCE(date, substr(created_at, 1, 10)) AS day, meal, parsed_json, enrichment_status
         FROM food_notes
        WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?
          AND COALESCE(date, substr(created_at, 1, 10)) <= ?
        ORDER BY day, id`
    )
    .all(since, through) as any[];
  const targetRows = db
    .prepare(
      `SELECT *
         FROM nutrition_targets
        WHERE effective_date <= ?
        ORDER BY effective_date ASC, id ASC`
    )
    .all(through) as any[];
  const byDay = new Map<string, any[]>();
  for (const row of rows) {
    const date = String(row.day || "").slice(0, 10);
    if (!date) continue;
    const entries = byDay.get(date) ?? [];
    entries.push({ ...row, parsed: parseJson(row.parsed_json) });
    byDay.set(date, entries);
  }

  const series: NutritionProgressDay[] = [];
  let targetIndex = 0;
  let targetRow: any = null;
  for (let index = 0; index < days; index++) {
    const date = addDaysISO(since, index) ?? since;
    while (targetIndex < targetRows.length && String(targetRows[targetIndex]?.effective_date || "") <= date) {
      targetRow = targetRows[targetIndex];
      targetIndex += 1;
    }
    const entries = byDay.get(date) ?? [];
    const nutrients = Object.fromEntries(NUTRIENTS.map((key) => [key, null])) as Record<
      NutritionProgressNutrient,
      number | null
    >;
    const known = Object.fromEntries(NUTRIENTS.map((key) => [key, false])) as Record<
      NutritionProgressNutrient,
      boolean
    >;
    for (const nutrient of NUTRIENTS) {
      const values = entries.map((entry) => finiteNonnegative(entry.parsed?.[nutrient]));
      if (entries.length && values.every((value) => value != null)) {
        nutrients[nutrient] = Math.round(values.reduce((sum, value) => sum + Number(value), 0) * 10) / 10;
        known[nutrient] = true;
      }
    }
    const pending = entries.filter((entry) =>
      ["pending", "in_progress"].includes(String(entry.enrichment_status))
    ).length;
    const macroKnown = NUTRIENTS.every((key) => nutrients[key] != null) && pending === 0;
    series.push({
      date,
      logged: entries.length > 0,
      entry_count: entries.length,
      pending_entries: pending,
      capture:
        date === through && entries.length
          ? "open"
          : entries.length
            ? macroKnown
              ? "macro_known"
              : "partial"
            : "unlogged",
      nutrients,
      known,
      target: historicalTarget(targetRow, date),
    });
  }

  const closedSeries = series.filter((day) => day.date < through);
  const closedRows = rows.filter((row) => String(row.day || "").slice(0, 10) < through);
  const closedDays = Math.max(1, days - 1);
  const closedLoggedDays = closedSeries.filter((day) => day.logged).length;
  const loggedDays = closedLoggedDays;
  const macroKnownDays = closedSeries.filter((day) => day.capture === "macro_known").length;
  const partialDays = closedSeries.filter((day) => day.capture === "partial").length;
  const pendingEntries = closedSeries.reduce((sum, day) => sum + day.pending_entries, 0);
  const pendingEntryIds = rows
    .filter((row) => ["pending", "in_progress"].includes(String(row.enrichment_status)))
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const reference = currentReference(targetRows.at(-1));
  const summaries = NUTRIENTS.map((nutrient): NutritionProgressSummary => {
    const values = closedSeries
      .filter((day) => day.nutrients[nutrient] != null)
      .map((day) => ({ date: day.date, value: Number(day.nutrients[nutrient]) }));
    const trend = nutrientTrend(values, nutrient);
    const ref =
      nutrient === "kcal"
        ? reference.kcal
        : nutrient === "protein_g"
          ? reference.protein_g
          : nutrient === "carbs_g"
            ? reference.carbs_g
            : nutrient === "fat_g"
              ? reference.fat_g
              : nutrient === "fiber_g"
                ? FIBER_REFERENCE_G
                : null;
    return {
      nutrient,
      label: LABELS[nutrient],
      unit: nutrient === "kcal" ? "kcal" : "g",
      average: roundAverage(
        values.map((point) => point.value),
        nutrient
      ),
      known_days: values.length,
      ...trend,
      reference: ref,
      reference_label:
        nutrient === "fiber_g"
          ? "longevity floor"
          : ref == null
            ? null
            : `current ${reference.provenance[nutrient]?.source === "formula" ? "formula" : "accepted"} reference`,
    };
  });
  const summaryByKey = Object.fromEntries(summaries.map((summary) => [summary.nutrient, summary])) as Record<
    NutritionProgressNutrient,
    NutritionProgressSummary
  >;
  const allMacroDays = closedSeries.filter(
    (day) => day.nutrients.protein_g != null && day.nutrients.carbs_g != null && day.nutrients.fat_g != null
  );
  const proteinKcal = allMacroDays.reduce((sum, day) => sum + Number(day.nutrients.protein_g) * 4, 0);
  const carbsKcal = allMacroDays.reduce((sum, day) => sum + Number(day.nutrients.carbs_g) * 4, 0);
  const fatKcal = allMacroDays.reduce((sum, day) => sum + Number(day.nutrients.fat_g) * 9, 0);
  const macroKcal = proteinKcal + carbsKcal + fatKcal;
  const observationDensity = recordObservationDensity(
    days,
    closedLoggedDays,
    macroKnownDays,
    summaryByKey.kcal.known_days
  );
  // A dense diary is still only dense records. Cairn has no independent
  // complete-day signal today, so this read can never claim strong confidence.
  const confidence: "none" | "tentative" | "observed" =
    observationDensity === "none" ? "none" : observationDensity === "sparse" ? "tentative" : "observed";
  const alignment = Object.fromEntries(
    NUTRIENTS.filter((nutrient) => nutrient !== "fiber_g").map((nutrient) => {
      const targetKey =
        nutrient === "kcal"
          ? "kcal"
          : nutrient === "protein_g"
            ? "protein_g"
            : nutrient === "carbs_g"
              ? "carbs_g"
              : "fat_g";
      const comparable = closedSeries.filter(
        (day) => day.nutrients[nutrient] != null && day.target?.[targetKey] != null
      );
      const recorded = comparable.reduce((sum, day) => sum + Number(day.nutrients[nutrient]), 0);
      const target = comparable.reduce((sum, day) => sum + Number(day.target?.[targetKey]), 0);
      return [
        nutrient,
        {
          comparable_days: comparable.length,
          recorded_average: comparable.length ? Math.round((recorded / comparable.length) * 10) / 10 : null,
          target_average: comparable.length ? Math.round((target / comparable.length) * 10) / 10 : null,
          recorded_to_target: target > 0 ? Math.round((recorded / target) * 100) / 100 : null,
        },
      ];
    })
  ) as Record<
    string,
    {
      comparable_days: number;
      recorded_average: number | null;
      target_average: number | null;
      recorded_to_target: number | null;
    }
  >;

  let read = "There is not enough recorded intake yet for a useful multi-week read.";
  let nextMove = "No target comparison is suggested yet; the gaps stay visible rather than being counted as zero.";
  if (loggedDays) {
    const condition = "If these records reflect most of your day";
    if (confidence !== "observed") {
      read = `Recorded intake is visible across ${loggedDays} of ${closedDays} closed days, but the complete-day picture is still loose.`;
      nextMove = `${condition}, treat the averages as context rather than a verdict; partial and unlogged days stay out of the math.`;
    } else {
      const protein = summaryByKey.protein_g.average;
      const fiber = summaryByKey.fiber_g.average;
      const carbLedGap =
        reference.carbs_g != null &&
        reference.fat_g != null &&
        alignment.kcal.comparable_days >= 7 &&
        Number(alignment.kcal.recorded_to_target) < 0.9 &&
        Number(alignment.carbs_g.recorded_to_target) < 0.82 &&
        Number(alignment.protein_g.recorded_to_target) >= 0.88 &&
        Number(alignment.fat_g.recorded_to_target) >= 0.8;
      const proteinNear = protein != null && reference.protein_g != null && protein >= reference.protein_g * 0.9;
      const fiberNear = fiber != null && fiber >= FIBER_REFERENCE_G * 0.9;
      read = carbLedGap
        ? `${condition}, recorded energy and carbohydrate are running below the accepted references for those days, while protein and fat are closer.`
        : proteinNear && fiberNear
          ? `${condition}, recorded protein and fiber are staying near their current anchors across the available days.`
          : proteinNear
            ? `${condition}, recorded protein is steady near its current anchor; fiber is the clearer longevity lever in the available days.`
            : fiberNear
              ? `${condition}, recorded fiber is near the longevity floor; protein is the clearer macro lever in the available days.`
              : `${condition}, the recorded pattern suggests protein and fiber are the most useful anchors to review.`;
      nextMove = carbLedGap
        ? `${condition}, close a modest amount of energy with carbohydrate around training.`
        : fiber != null && fiber < FIBER_REFERENCE_G * 0.9
          ? `${condition}, keep the rest steady and make one regular meal a little more fiber-rich.`
          : protein != null && reference.protein_g != null && protein < reference.protein_g * 0.9
            ? `${condition}, keep the day flexible and strengthen one dependable protein anchor.`
            : `${condition}, keep the current anchors steady; these records do not suggest a broad macro overhaul.`;
    }
  }

  return {
    window_days: days,
    since,
    through,
    read,
    next_move: nextMove,
    coverage: {
      logged_days: loggedDays,
      closed_logged_days: closedLoggedDays,
      unlogged_days: closedDays - loggedDays,
      macro_known_days: macroKnownDays,
      partial_days: partialDays,
      open_day_logged: !!series.find((day) => day.date === through)?.logged,
      pending_entries: pendingEntries,
      pending_entry_ids: pendingEntryIds,
      logged_fraction: Math.round((loggedDays / closedDays) * 100) / 100,
      macro_known_fraction: Math.round((macroKnownDays / closedDays) * 100) / 100,
      observation_density: observationDensity,
      confidence,
      completeness_signal: null,
      note: "Record coverage only: macro-known means every tracked nutrient is present for that closed day; it does not prove every meal or the full day was captured.",
    },
    current_reference: reference,
    nutrients: summaries,
    target_alignment: alignment,
    energy_split:
      macroKcal > 0
        ? {
            known_days: allMacroDays.length,
            protein_pct: Math.round((proteinKcal / macroKcal) * 100),
            carbs_pct: Math.round((carbsKcal / macroKcal) * 100),
            fat_pct: Math.round((fatKcal / macroKcal) * 100),
          }
        : null,
    food_quality_estimates: nutritionPatternEstimate(closedRows, loggedDays),
    series,
    health_context: directiveContext(),
    frame: "Food and bloodwork context is informational and is not medical advice.",
  };
}
