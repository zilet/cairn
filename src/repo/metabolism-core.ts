export interface MeasuredRmrReading {
  kcal: number;
  date: string | null;
  source: string;
  document_id?: number | null;
}

export type MeasuredRmrFreshness = "fresh" | "aging" | "expired" | "undated";

export interface MeasuredRmrAssessment extends MeasuredRmrReading {
  age_days: number | null;
  freshness: MeasuredRmrFreshness;
  freshness_weight: number;
  fresh_for_days: number;
  expires_after_days: number;
}

export const MEASURED_RMR_FRESH_DAYS = 180;
export const MEASURED_RMR_EXPIRES_DAYS = 365;

// A lab measurement is a valuable anchor, not a permanent identity. Keep it at
// full strength for six months, then linearly fade its authority until it expires
// at one year. Undated/future readings stay visible but do not outrank current
// wearable or profile evidence.
export function assessMeasuredRmr(
  reading: MeasuredRmrReading,
  referenceDate: string
): MeasuredRmrAssessment {
  const measured = /^\d{4}-\d{2}-\d{2}$/.test(String(reading.date ?? ""))
    ? Date.parse(`${reading.date}T00:00:00Z`)
    : Number.NaN;
  const reference = /^\d{4}-\d{2}-\d{2}$/.test(referenceDate)
    ? Date.parse(`${referenceDate}T00:00:00Z`)
    : Number.NaN;
  const age = Number.isFinite(measured) && Number.isFinite(reference) ? Math.floor((reference - measured) / 86_400_000) : null;
  let freshness: MeasuredRmrFreshness = "undated";
  let freshnessWeight = 0;
  if (age != null && age >= 0 && age <= MEASURED_RMR_FRESH_DAYS) {
    freshness = "fresh";
    freshnessWeight = 1;
  } else if (age != null && age > MEASURED_RMR_FRESH_DAYS && age < MEASURED_RMR_EXPIRES_DAYS) {
    freshness = "aging";
    freshnessWeight =
      (MEASURED_RMR_EXPIRES_DAYS - age) / (MEASURED_RMR_EXPIRES_DAYS - MEASURED_RMR_FRESH_DAYS);
  } else if (age != null) {
    freshness = "expired";
  }
  return {
    ...reading,
    age_days: age,
    freshness,
    freshness_weight: Math.round(freshnessWeight * 1000) / 1000,
    fresh_for_days: MEASURED_RMR_FRESH_DAYS,
    expires_after_days: MEASURED_RMR_EXPIRES_DAYS,
  };
}

function plausibleRmr(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed < 700 || parsed > 5_000) return null;
  return Math.round(parsed);
}

function markerRmr(parsed: any): number | null {
  const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
  for (const marker of markers) {
    const name = String(marker?.name ?? marker?.marker ?? "");
    if (!/\b(?:measured\s+)?(?:resting\s+metabolic\s+rate|rmr)\b/i.test(name)) continue;
    if (/predicted|estimate/i.test(name)) continue;
    const value = plausibleRmr(marker?.value);
    if (value != null) return value;
  }
  return null;
}

export function extractMeasuredRmr(row: any): MeasuredRmrReading | null {
  let parsed = row?.parsed_json ?? row?.parsed ?? null;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const markerValue = markerRmr(parsed);
  const text = `${row?.summary ?? ""} ${parsed?.summary ?? ""}`;
  const match = /(?:measured\s+)?(?:resting\s+metabolic\s+rate|rmr)[^\d]{0,80}([\d,]{3,5})\s*(?:kcal|calories)/i.exec(
    text
  );
  const kcal = markerValue ?? plausibleRmr(match?.[1]);
  if (kcal == null) return null;
  return {
    kcal,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(row?.doc_date ?? "")) ? String(row.doc_date) : null,
    source: String(row?.kind || "metabolic_test").slice(0, 80),
    document_id: Number.isFinite(Number(row?.id)) ? Number(row.id) : null,
  };
}
