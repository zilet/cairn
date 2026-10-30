// THE CARDIOVASCULAR READ'S CONTEXT — what sits beside the PREVENT number.
//
// PREVENT's vascular age reads cholesterol, blood pressure, BMI, kidney function, smoking
// and diabetes. It does not see fitness, and it is not adjusted to (no fudge factor here,
// ever). So the card shows the other ages beside it, each labelled with what it reads and
// its date, plus what is working for the person — and says, calmly, when a reading may no
// longer describe them.
//
// Every number comes from the ONE source the standing read uses (src/repo/standing.ts:
// vo2maxReading, bodyFatReading, bloodworkAgeReading, fitnessComparison) — never a second
// curve or a second body-fat chain. Staleness is the marker-validity table
// (src/repo/marker-validity.ts) and the weight-change table (weightChangeStaleness,
// src/repo/propagation.ts) — never a hardcoded age.
//
// Informational, never medical advice; no score, no grade. A protective factor never
// softens, clears or rewrites a finding: it is listed beside them.

import { getRecoverySummary } from "./coach.js";
import { bpRead, listBloodPressureReadings } from "./health.js";
import { markerAgingClause, readingAgeDays, readingPastValidity } from "./marker-validity.js";
import { listWeight } from "./profile.js";
import { prioritizeMarkers, weightChangeStaleness } from "./propagation.js";
import { cardiovascularImagingOnFile, type CardiovascularImagingFact } from "./scans-on-file.js";
import {
  bloodworkAgeReading,
  bodyFatReading,
  fitnessComparison,
  vo2AtPercentile,
  vo2maxReading,
  type BloodworkAgeReading,
  type BodyFatReading,
  type HealthReading,
} from "./standing.js";

export interface RiskAge {
  key: "vascular" | "bloodwork" | "fitness";
  label: string;
  value: number;
  date: string | null;
  source: string;
  reads: string;
  recheck: string | null;
}

export interface ProtectiveFactor {
  key: string;
  label: string;
  finding: string;
  date: string | null;
  recheck: string | null;
}

export interface RiskReadingContext {
  vo2: HealthReading | null;
  fitness: ReturnType<typeof fitnessComparison> | null;
  bodyFat: BodyFatReading | null;
  bloodworkAge: BloodworkAgeReading | null;
  bp: ReturnType<typeof bpRead>;
  imaging: CardiovascularImagingFact[];
  weights: any[];
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The readings beside the PREVENT number, each from its one shared source. */
export function riskReadingContext(profile: any, age: number | null): RiskReadingContext {
  const markers = safe(() => (prioritizeMarkers() as any).markers as any[], [] as any[]);
  const rec = safe(() => (getRecoverySummary(30) as any)?.recovery ?? {}, {} as any);
  // Enough of the weigh-in log to reach back to a panel drawn months ago.
  const weights = safe(() => listWeight(400) as any[], [] as any[]);
  const vo2 = vo2maxReading(markers, rec);
  return {
    vo2,
    fitness: vo2 ? safe(() => fitnessComparison(vo2, profile, age), null) : null,
    bodyFat: safe(() => bodyFatReading(markers, profile, rec, { weights }), null),
    bloodworkAge: safe(() => bloodworkAgeReading(markers, age), null),
    bp: bpRead(safe(() => listBloodPressureReadings(12) as any[], [] as any[])),
    imaging: safe(() => cardiovascularImagingOnFile(), [] as CardiovascularImagingFact[]),
    weights,
  };
}

/**
 * When a reading may no longer describe the person, the calm sentence that says so:
 * past its own class's validity window (markerAgingClause), else taken before a material
 * weight change on a reading that moves with bodyweight (weightChangeStaleness). Null
 * while the reading still stands.
 */
export function recheckNote(
  name: string,
  date: string | null | undefined,
  weights: any[],
  today?: string
): string | null {
  if (!date) return null;
  if (readingPastValidity(name, readingAgeDays(date, today))) {
    return markerAgingClause(name, date, today)?.clause ?? null;
  }
  const moved = weightChangeStaleness(name, date, weights, today);
  return moved.stale ? moved.reason : null;
}

function sexWord(profile: any): string {
  const sex = String(profile?.sex ?? "").toLowerCase();
  return sex === "female" ? "women" : sex === "male" ? "men" : "people";
}

/** The ages side by side, each with what it reads and when it was read. */
export function riskAges(
  ctx: RiskReadingContext,
  vascular: { value: number | null; date: string | null },
  today?: string
): RiskAge[] {
  const out: RiskAge[] = [];
  if (vascular.value != null) {
    out.push({
      key: "vascular",
      label: "Vascular age",
      value: Math.round(vascular.value),
      date: vascular.date,
      source: "AHA PREVENT (2023)",
      reads:
        "Reads cholesterol, blood pressure, BMI, kidney function, smoking and diabetes. It does not see fitness.",
      recheck: recheckNote("vascular age", vascular.date, ctx.weights, today),
    });
  }
  if (ctx.bloodworkAge) {
    out.push({
      key: "bloodwork",
      label: "Bloodwork age",
      value: Math.round(ctx.bloodworkAge.value),
      date: ctx.bloodworkAge.date,
      source: ctx.bloodworkAge.source,
      reads:
        ctx.bloodworkAge.kind === "phenoage"
          ? "Reads nine routine blood markers: glucose, inflammation, kidney, liver and blood-count readings."
          : "Your lab's own biological-age read from the panel.",
      recheck: recheckNote("bloodwork age", ctx.bloodworkAge.date, ctx.weights, today),
    });
  }
  if (ctx.vo2 && ctx.fitness) {
    out.push({
      key: "fitness",
      label: "Fitness age",
      value: Math.round(ctx.fitness.equivalent_age),
      date: ctx.vo2.date,
      source: `VO2max ${Math.round(ctx.vo2.value * 10) / 10} (${ctx.vo2.source}) against the ${ctx.fitness.source}`,
      reads: "Reads cardiorespiratory fitness (VO2max) only.",
      recheck: recheckNote("VO2max", ctx.vo2.date, ctx.weights, today),
    });
  }
  return out;
}

// Thresholds are the standing read's own: a VO2max at or past the 60th percentile is the
// "strong for your age" chip there, and ≤2 lb of visceral fat is its "low" line.
const FITNESS_PROTECTIVE_PERCENTILE = 60;
// THE one fitness threshold of the risk read: VO2max "below target" means under this
// FRIEND percentile for the person's own age and sex — never a fixed number, which a
// watch reading would trip for every older athlete while the card says "fitter than N%".
export const VO2MAX_BELOW_TARGET_PERCENTILE = 40;

/** True when the VO2max on file sits under the target percentile for age and sex. */
export function vo2maxBelowTarget(ctx: RiskReadingContext): boolean {
  return !!ctx.fitness && ctx.fitness.percentile < VO2MAX_BELOW_TARGET_PERCENTILE;
}

/** The VO2max the target percentile names for this person (the projection's target). */
export function vo2maxTarget(profile: any, age: number | null): number {
  return vo2AtPercentile(profile, age, VO2MAX_BELOW_TARGET_PERCENTILE);
}
const VISCERAL_LOW_LB = 2;

/** What is working for the person, each with its date. Listed beside the enhancers, never netted against them. */
export function workingForYou(ctx: RiskReadingContext, profile: any, today?: string): ProtectiveFactor[] {
  const out: ProtectiveFactor[] = [];
  if (ctx.vo2 && ctx.fitness && ctx.fitness.percentile >= FITNESS_PROTECTIVE_PERCENTILE) {
    out.push({
      key: "vo2max",
      label: "Cardiorespiratory fitness",
      finding: `VO2max ${Math.round(ctx.vo2.value * 10) / 10} (${ctx.vo2.source}): ${ctx.fitness.verb} ${ctx.fitness.percentile}% of ${sexWord(profile)} your age.`,
      date: ctx.vo2.date,
      recheck: recheckNote("VO2max", ctx.vo2.date, ctx.weights, today),
    });
  }
  if (ctx.bp.category === "optimal" && ctx.bp.latest) {
    const latest = ctx.bp.latest;
    const date = String(latest.measured_at ?? latest.date ?? "").slice(0, 10) || null;
    out.push({
      key: "home_bp",
      label: "Home blood pressure",
      finding: `Home readings in the optimal range (latest ${Math.round(Number(latest.systolic))}/${Math.round(Number(latest.diastolic))} mmHg).`,
      date,
      recheck: recheckNote("Systolic BP", date, ctx.weights, today),
    });
  }
  // Only the NEWEST coronary-calcium result speaks: an old zero never stands in for a
  // newer positive score (a positive one is no protective entry at all).
  const newestCac = ctx.imaging.find((s) => s.coronary_calcium?.agatston_total != null);
  if (newestCac && newestCac.coronary_calcium?.agatston_total === 0) {
    const pct = newestCac.coronary_calcium?.percentile;
    out.push({
      key: "cac",
      label: "Coronary calcium",
      finding: `Calcium score 0${pct ? ` (${/percentile/i.test(pct) ? pct : `${pct} percentile`})` : ""}. ${newestCac.note ?? ""}`.trim(),
      date: newestCac.date,
      recheck: recheckNote("calcium score", newestCac.date, ctx.weights, today),
    });
  }
  const comp = ctx.bodyFat?.body_comp;
  const visceral = comp?.regional?.visceral_fat_lbs;
  if (typeof visceral === "number" && Number.isFinite(visceral) && visceral <= VISCERAL_LOW_LB) {
    const date = comp?.measured?.date ? String(comp.measured.date).slice(0, 10) : null;
    out.push({
      key: "visceral_fat",
      label: "Visceral fat",
      finding: `Visceral fat ${Math.round(visceral * 10) / 10} lb on your DEXA, which is low.`,
      date,
      recheck: recheckNote("visceral fat", date, ctx.weights, today),
    });
  }
  return out;
}
