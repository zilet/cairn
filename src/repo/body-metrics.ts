import { db } from "../db.js";
import { lsqSlopePerDay } from "./health.js";
import { getProfile, listWeight, setProfile } from "./profile.js";
import { localDateISO } from "./shared.js";

// ---------------------------------------------------------------------------
// Body measurements + derived indicators.
//
// The owner asked for "more data points not just weight and height — logging
// hips, shoulders, chest, legs circumference or other at-home methods — as
// agentic as possible but provide reliable progress tracking toward better
// goals." This module is the deterministic core: at-home circumferences plus
// evidence-anchored indicators (BMI, waist-to-height, waist-to-hip, Navy
// body-fat %) that give a reliable read BETWEEN DEXA scans (which go stale).
//
// Every indicator is plain-language with optimal framing — NO 0-100 scores
// (BMI / ratios are clinical measures, surfaced with words, not graded). Body
// fat from a tape is labelled an ESTIMATE. Nothing here auto-applies anything.
// ---------------------------------------------------------------------------

// The measuring sites, in the order they read on a card (torso → limbs).
export const MEASUREMENT_SITES = [
  "neck_in",
  "shoulder_in",
  "chest_in",
  "waist_in",
  "hip_in",
  "thigh_in",
  "calf_in",
  "upper_arm_in",
  "forearm_in",
] as const;

export type MeasurementSite = (typeof MEASUREMENT_SITES)[number];

export const SITE_LABELS: Record<MeasurementSite, string> = {
  neck_in: "Neck",
  shoulder_in: "Shoulders",
  chest_in: "Chest",
  waist_in: "Waist",
  hip_in: "Hips",
  thigh_in: "Thigh",
  calf_in: "Calf",
  upper_arm_in: "Upper arm",
  forearm_in: "Forearm",
};

// One-line measuring technique per site — the landmark + posture that make a tape
// reading repeatable (and keep the Navy/WHtR math honest). Carried on the summary's
// `sites` so the PWA's ⓘ affordance, MCP readers and chat all give the SAME guidance.
export const SITE_HINTS: Record<MeasurementSite, string> = {
  neck_in: "Just below the Adam's apple, tape sloping slightly down toward the front. Relaxed — don't flex or shrug.",
  shoulder_in: "Around the widest point of both shoulders (over the delts), arms hanging relaxed at your sides.",
  chest_in: "At nipple line, tape level all the way around, at the end of a normal exhale.",
  waist_in: "At the navel, relaxed — don't suck in — at the end of a normal exhale. This one drives waist-to-height and body-fat.",
  hip_in: "Around the widest point of the glutes, feet together, tape level.",
  thigh_in: "Widest point of the upper thigh, standing tall with weight even on both feet.",
  calf_in: "Widest point of the calf, standing, weight even on both feet.",
  upper_arm_in: "Arm hanging relaxed at your side, halfway between shoulder and elbow — not flexed.",
  forearm_in: "Widest point of the forearm, arm relaxed, palm facing up.",
};

export type BodyTone = "ok" | "watch" | "warn" | "info";

export interface BodyMeasurementRow {
  id: number;
  date: string;
  waist_in: number | null;
  hip_in: number | null;
  chest_in: number | null;
  shoulder_in: number | null;
  neck_in: number | null;
  thigh_in: number | null;
  upper_arm_in: number | null;
  calf_in: number | null;
  forearm_in: number | null;
  note: string | null;
  source: string | null;
  created_at?: string;
}

export interface BodyIndicator {
  key: string;
  label: string;
  value: number | null; // the clinical measure (a ratio/BMI/%), NOT a score
  unit: string;
  zone: string | null; // plain-language band: optimal | healthy | elevated | …
  tone: BodyTone;
  read: string; // one plain-language sentence
  estimate?: boolean; // true for the tape-based body-fat estimate
  needs?: MeasurementSite[] | string[]; // what to log to unlock it
}

export interface SiteTrend {
  key: string;
  label: string;
  unit: string;
  latest: number | null;
  n: number;
  points: number[]; // chronological values, for a sparkline
  slope_per_week: number | null;
  change: number | null; // last − first across the window
  span_days: number | null;
  direction: "up" | "down" | "steady" | null;
  text: string; // "waist down 0.8 in over 6 weeks"
}

// --- units ---------------------------------------------------------------------
// Storage is canonical INCHES (the `*_in` columns). A caller anywhere — REST, MCP,
// chat — may speak centimeters by passing unit:"cm"; conversion happens once at the
// trust boundary on the way in, and once on the way out for display.
export type MeasureUnit = "in" | "cm";
const CM_PER_IN = 2.54;

export function normalizeUnit(u: unknown): MeasureUnit {
  return String(u ?? "").trim().toLowerCase() === "cm" ? "cm" : "in";
}

function inToUnit(v: number | null, unit: MeasureUnit): number | null {
  if (v == null) return null;
  return unit === "cm" ? Math.round(v * CM_PER_IN * 10) / 10 : v;
}

// A measurement row re-expressed in the display unit (a copy; storage stays inches).
function rowToUnit(row: BodyMeasurementRow, unit: MeasureUnit): BodyMeasurementRow {
  if (unit !== "cm") return row;
  const out = { ...row };
  for (const site of MEASUREMENT_SITES) if (out[site] != null) (out as any)[site] = inToUnit(out[site], "cm");
  return out;
}

// --- coercion / clamping at the trust boundary --------------------------------
function clampSite(value: unknown, unit: MeasureUnit = "in"): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const n = unit === "cm" ? raw / CM_PER_IN : raw;
  // Generous plausibility bounds for any human circumference, in inches.
  if (n < 1 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

function pickSites(fields: Record<string, unknown> | null | undefined, unit: MeasureUnit = "in"): Record<MeasurementSite, number | null> {
  const out = {} as Record<MeasurementSite, number | null>;
  for (const site of MEASUREMENT_SITES) out[site] = clampSite(fields?.[site], unit);
  return out;
}

function hasAnySite(sites: Record<MeasurementSite, number | null>): boolean {
  return MEASUREMENT_SITES.some((s) => sites[s] != null);
}

// Height resolution: inches is the source of truth; fall back to a cm profile so
// an athlete who set height anywhere still gets BMI / body-fat.
export function effectiveHeightIn(profile?: any): number | null {
  const p = profile ?? getProfile();
  if (p?.height_in != null && Number.isFinite(Number(p.height_in))) return Number(p.height_in);
  if (p?.height_cm != null && Number.isFinite(Number(p.height_cm))) return Math.round((Number(p.height_cm) / 2.54) * 10) / 10;
  return null;
}

function latestWeightLb(profile?: any): number | null {
  const p = profile ?? getProfile();
  if (p?.weight_lb != null && Number.isFinite(Number(p.weight_lb))) return Number(p.weight_lb);
  const w = listWeight(1) as any[];
  const v = w.length ? Number(w[w.length - 1]?.weight_lb) : NaN;
  return Number.isFinite(v) ? v : null;
}

function isFemale(profile?: any): boolean {
  const p = profile ?? getProfile();
  return String(p?.sex || "male").toLowerCase().startsWith("f");
}

// --- CRUD ---------------------------------------------------------------------
export function addBodyMeasurement(
  date: string | undefined,
  fields: Record<string, unknown>,
  note?: string | null,
  source?: string | null,
  unit: MeasureUnit = "in"
): BodyMeasurementRow {
  const d = date || localDateISO();
  const sites = pickSites(fields, unit);
  const info = db
    .prepare(
      `INSERT INTO body_measurements
        (date, waist_in, hip_in, chest_in, shoulder_in, neck_in, thigh_in, upper_arm_in, calf_in, forearm_in, note, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d,
      sites.waist_in,
      sites.hip_in,
      sites.chest_in,
      sites.shoulder_in,
      sites.neck_in,
      sites.thigh_in,
      sites.upper_arm_in,
      sites.calf_in,
      sites.forearm_in,
      note != null ? String(note).slice(0, 500) : null,
      source ? String(source).slice(0, 40) : "manual"
    );
  return getBodyMeasurement(Number(info.lastInsertRowid))!;
}

export function getBodyMeasurement(id: number): BodyMeasurementRow | null {
  return (db.prepare(`SELECT * FROM body_measurements WHERE id = ?`).get(id) as unknown as BodyMeasurementRow) || null;
}

export function listBodyMeasurements(days?: number): BodyMeasurementRow[] {
  const rows = (
    days && Number.isFinite(days)
      ? db
          .prepare(`SELECT * FROM body_measurements WHERE date >= ? ORDER BY date DESC, id DESC`)
          .all(localDateISO(new Date(Date.now() - Number(days) * 864e5)))
      : db.prepare(`SELECT * FROM body_measurements ORDER BY date DESC, id DESC LIMIT 500`).all()
  ) as unknown as BodyMeasurementRow[];
  return rows.reverse(); // chronological for charting
}

export function latestBodyMeasurement(): BodyMeasurementRow | null {
  return (
    (db.prepare(`SELECT * FROM body_measurements ORDER BY date DESC, id DESC LIMIT 1`).get() as unknown as BodyMeasurementRow) ||
    null
  );
}

// A tape session fills in only what was measured — so the indicators/comp read
// each site's LATEST KNOWN value across recent sessions (bounded to a year so a
// waist-only re-tape doesn't pair with ancient hips), not just the newest row.
// Otherwise logging just the waist today would blank waist-to-hip and the Navy
// body-fat estimate until the athlete re-tapes everything in one sitting.
export function latestKnownMeasurement(days = 365): BodyMeasurementRow | null {
  const rows = listBodyMeasurements(days); // chronological
  if (!rows.length) return latestBodyMeasurement();
  const merged = { ...rows[rows.length - 1] };
  for (const site of MEASUREMENT_SITES) {
    if (merged[site] != null) continue;
    for (let i = rows.length - 2; i >= 0; i--) {
      if (rows[i][site] != null) {
        merged[site] = rows[i][site];
        break;
      }
    }
  }
  return merged;
}

export function updateBodyMeasurement(id: number, patch: Record<string, unknown>): BodyMeasurementRow | null {
  const cur = getBodyMeasurement(id);
  if (!cur) return null;
  const sites = MEASUREMENT_SITES.map((site) => {
    const provided = site in patch;
    const value = provided ? clampSite(patch[site]) : cur[site];
    return { site, value };
  });
  const note = "note" in patch ? (patch.note != null ? String(patch.note).slice(0, 500) : null) : cur.note;
  const date = "date" in patch && patch.date ? String(patch.date).slice(0, 10) : cur.date;
  db.prepare(
    `UPDATE body_measurements SET
       date=?, waist_in=?, hip_in=?, chest_in=?, shoulder_in=?, neck_in=?, thigh_in=?, upper_arm_in=?, calf_in=?, forearm_in=?, note=?
     WHERE id=?`
  ).run(
    date,
    sites.find((s) => s.site === "waist_in")!.value,
    sites.find((s) => s.site === "hip_in")!.value,
    sites.find((s) => s.site === "chest_in")!.value,
    sites.find((s) => s.site === "shoulder_in")!.value,
    sites.find((s) => s.site === "neck_in")!.value,
    sites.find((s) => s.site === "thigh_in")!.value,
    sites.find((s) => s.site === "upper_arm_in")!.value,
    sites.find((s) => s.site === "calf_in")!.value,
    sites.find((s) => s.site === "forearm_in")!.value,
    note,
    id
  );
  return getBodyMeasurement(id);
}

export function deleteBodyMeasurement(id: number): { ok: boolean; deleted: number } {
  const info = db.prepare(`DELETE FROM body_measurements WHERE id = ?`).run(id);
  return { ok: info.changes > 0, deleted: Number(info.changes) };
}

// --- derived indicators (deterministic, evidence-anchored) --------------------
function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// BMI = 703 · lb / in². A clinical screen; carries the athlete caveat because it
// cannot tell muscle from fat.
function bmiIndicator(heightIn: number | null, weightLb: number | null): BodyIndicator {
  const base = { key: "bmi", label: "BMI", unit: "", estimate: false as const };
  if (heightIn == null || weightLb == null) {
    return {
      ...base,
      value: null,
      zone: null,
      tone: "info",
      read: "Add your height to compute BMI.",
      needs: heightIn == null ? ["height"] : ["weight"],
    };
  }
  const value = round((703 * weightLb) / (heightIn * heightIn));
  let zone = "healthy";
  let tone: BodyTone = "ok";
  if (value < 18.5) {
    zone = "below range";
    tone = "watch";
  } else if (value < 25) {
    zone = "healthy range";
    tone = "ok";
  } else if (value < 30) {
    zone = "above range";
    tone = "info";
  } else {
    zone = "well above range";
    tone = "watch";
  }
  const caveat =
    value >= 25
      ? " BMI can't tell muscle from fat, so for a trained athlete it often reads high — lean with the waist and body-fat reads."
      : "";
  return { ...base, value, zone, tone, read: `BMI ${value} — ${zone}.${caveat}` };
}

// Waist-to-height ratio. The widely-cited healthy rule: keep your waist to less
// than half your height (WHtR < 0.5).
function whtrIndicator(heightIn: number | null, waistIn: number | null): BodyIndicator {
  const base = { key: "whtr", label: "Waist-to-height", unit: "", estimate: false as const };
  if (heightIn == null || waistIn == null) {
    return {
      ...base,
      value: null,
      zone: null,
      tone: "info",
      read: "Log your waist and height for waist-to-height.",
      needs: heightIn == null ? ["waist_in", "height"] : ["waist_in"],
    };
  }
  const value = round(waistIn / heightIn, 2);
  let zone = "optimal";
  let tone: BodyTone = "ok";
  if (value < 0.4) {
    zone = "lean";
    tone = "watch";
  } else if (value < 0.5) {
    zone = "optimal";
    tone = "ok";
  } else if (value < 0.6) {
    zone = "elevated";
    tone = "watch";
  } else {
    zone = "high";
    tone = "warn";
  }
  const rule = value >= 0.5 ? " Aim to keep your waist under half your height." : " Your waist is under half your height.";
  return { ...base, value, zone, tone, read: `Waist-to-height ${value} — ${zone}.${rule}` };
}

// Waist-to-hip ratio. Sex-aware WHO cutoffs (men ≥0.90, women ≥0.85 = elevated).
function whrIndicator(waistIn: number | null, hipIn: number | null, female: boolean): BodyIndicator {
  const base = { key: "whr", label: "Waist-to-hip", unit: "", estimate: false as const };
  if (waistIn == null || hipIn == null) {
    return {
      ...base,
      value: null,
      zone: null,
      tone: "info",
      read: "Log your waist and hips for waist-to-hip.",
      needs: waistIn == null && hipIn == null ? ["waist_in", "hip_in"] : waistIn == null ? ["waist_in"] : ["hip_in"],
    };
  }
  const value = round(waistIn / hipIn, 2);
  const elevated = female ? 0.85 : 0.9;
  const high = female ? 0.925 : 1.0;
  let zone = "optimal";
  let tone: BodyTone = "ok";
  if (value >= high) {
    zone = "high";
    tone = "warn";
  } else if (value >= elevated) {
    zone = "elevated";
    tone = "watch";
  }
  return { ...base, value, zone, tone, read: `Waist-to-hip ${value} — ${zone}.` };
}

// U.S. Navy circumference body-fat %, sex-aware. An ESTIMATE — a DEXA is the
// gold standard, but this needs only a tape and stays honest between scans.
function navyBodyFat(
  heightIn: number | null,
  neckIn: number | null,
  waistIn: number | null,
  hipIn: number | null,
  female: boolean
): BodyIndicator {
  const base = { key: "bodyfat", label: "Body fat", unit: "%", estimate: true as const };
  const needMsg = female ? "Log height, neck, waist and hips for a body-fat estimate." : "Log height, neck and waist for a body-fat estimate.";
  const needs: string[] = [];
  if (heightIn == null) needs.push("height");
  if (neckIn == null) needs.push("neck_in");
  if (waistIn == null) needs.push("waist_in");
  if (female && hipIn == null) needs.push("hip_in");
  if (needs.length) {
    return { ...base, value: null, zone: null, tone: "info", read: needMsg, needs };
  }
  const h = heightIn as number;
  const neck = neckIn as number;
  const waist = waistIn as number;
  let value: number;
  if (female) {
    const inner = waist + (hipIn as number) - neck;
    if (inner <= 0) return { ...base, value: null, zone: null, tone: "info", read: needMsg, needs: ["waist_in", "hip_in", "neck_in"] };
    value = 163.205 * Math.log10(inner) - 97.684 * Math.log10(h) - 78.387;
  } else {
    const inner = waist - neck;
    if (inner <= 0) return { ...base, value: null, zone: null, tone: "info", read: needMsg, needs: ["waist_in", "neck_in"] };
    value = 86.01 * Math.log10(inner) - 70.041 * Math.log10(h) + 36.76;
  }
  value = round(Math.min(60, Math.max(2, value)));
  // Plain-language bands (ACE-style), sex-aware.
  const bands: [number, string, BodyTone][] = female
    ? [
        [14, "very lean", "info"],
        [21, "athletic", "ok"],
        [25, "fit", "ok"],
        [32, "average", "info"],
        [Infinity, "high", "watch"],
      ]
    : [
        [6, "very lean", "info"],
        [14, "athletic", "ok"],
        [18, "fit", "ok"],
        [25, "average", "info"],
        [Infinity, "high", "watch"],
      ];
  const band = bands.find(([ceil]) => value < ceil) ?? bands[bands.length - 1];
  return {
    ...base,
    value,
    zone: band[1],
    tone: band[2],
    read: `Body fat ~${value}% (${band[1]}) — a tape estimate, so track the trend, not the decimal; a DEXA is the gold standard.`,
  };
}

// Compute the full indicator set from a measurement (defaults to the latest
// KNOWN value per site — see latestKnownMeasurement) + profile.
export function getBodyIndicators(measurement?: BodyMeasurementRow | null, profile?: any): BodyIndicator[] {
  const p = profile ?? getProfile();
  const m = measurement === undefined ? latestKnownMeasurement() : measurement;
  const heightIn = effectiveHeightIn(p);
  const weightLb = latestWeightLb(p);
  const female = isFemale(p);
  const waist = m?.waist_in ?? null;
  const hip = m?.hip_in ?? null;
  const neck = m?.neck_in ?? null;
  return [
    bmiIndicator(heightIn, weightLb),
    whtrIndicator(heightIn, waist),
    whrIndicator(waist, hip, female),
    navyBodyFat(heightIn, neck, waist, hip, female),
  ];
}

// --- trends -------------------------------------------------------------------
function directionOf(change: number | null, spread: number): "up" | "down" | "steady" | null {
  if (change == null) return null;
  // "steady" when the net move is small vs the series spread (or tiny absolutely).
  if (Math.abs(change) < Math.max(0.3, spread * 0.15)) return "steady";
  return change > 0 ? "up" : "down";
}

function trendText(label: string, unit: string, direction: string | null, change: number | null, spanDays: number | null): string {
  if (direction == null || change == null) return `${label}: one reading so far — log again to see the trend.`;
  if (direction === "steady") return `${label} holding steady${spanDays ? ` over ${weeksPhrase(spanDays)}` : ""}.`;
  const word = direction === "down" ? "down" : "up";
  const amt = `${Math.abs(round(change))} ${unit}`.trim();
  return `${label} ${word} ${amt}${spanDays ? ` over ${weeksPhrase(spanDays)}` : ""}.`;
}

function weeksPhrase(days: number): string {
  if (days < 10) return `${Math.max(1, Math.round(days))} days`;
  const wk = Math.round(days / 7);
  if (wk < 9) return `${wk} weeks`;
  const mo = Math.round(days / 30.4);
  return `${mo} month${mo === 1 ? "" : "s"}`;
}

function siteSeries(key: string): { date: string; value: number }[] {
  const rows = db
    .prepare(`SELECT date, ${key} AS value FROM body_measurements WHERE ${key} IS NOT NULL ORDER BY date ASC, id ASC`)
    .all() as unknown as { date: string; value: number }[];
  return rows.map((r) => ({ date: r.date, value: Number(r.value) })).filter((r) => Number.isFinite(r.value));
}

function buildTrend(key: string, label: string, unit: string, series: { date: string; value: number }[]): SiteTrend {
  const points = series.map((s) => s.value);
  const n = points.length;
  const latest = n ? points[n - 1] : null;
  const slopePerDay = lsqSlopePerDay(series);
  const slope_per_week = slopePerDay == null ? null : round(slopePerDay * 7, 2);
  const change = n >= 2 ? round(points[n - 1] - points[0]) : null;
  const span_days =
    n >= 2 ? Math.max(0, Math.round((Date.parse(series[n - 1].date) - Date.parse(series[0].date)) / 864e5)) : null;
  const spread = n >= 2 ? Math.max(...points) - Math.min(...points) : 0;
  const direction = directionOf(change, spread);
  return {
    key,
    label,
    unit,
    latest,
    n,
    points,
    slope_per_week,
    change,
    span_days,
    direction,
    text: trendText(label, unit, direction, change, span_days),
  };
}

// Per-site least-squares trend (like the weight trend), null-safe under 2 points.
// Includes bodyweight (from bodyweight_log) so weight movement reads alongside
// the circumferences and toward the goal.
export function getBodyMetricTrends(days?: number, unit: MeasureUnit = "in"): { window_days: number | null; sites: SiteTrend[]; weight: SiteTrend } {
  const cutoff = days && Number.isFinite(days) ? localDateISO(new Date(Date.now() - Number(days) * 864e5)) : null;
  const within = (series: { date: string; value: number }[]) => (cutoff ? series.filter((s) => s.date >= cutoff) : series);
  const sites: SiteTrend[] = [];
  for (const site of MEASUREMENT_SITES) {
    const series = within(siteSeries(site)).map((s) => ({ date: s.date, value: inToUnit(s.value, unit) as number }));
    if (series.length) sites.push(buildTrend(site, SITE_LABELS[site], unit, series));
  }
  const weighins = (listWeight(500) as any[])
    .map((w) => ({ date: String(w.date), value: Number(w.weight_lb) }))
    .filter((w) => Number.isFinite(w.value));
  const weight = buildTrend("weight_lb", "Weight", "lb", within(weighins));
  return { window_days: days && Number.isFinite(days) ? Number(days) : null, sites, weight };
}

// --- where-you-stand scales + heading (deterministic, evidence-anchored) -------
// Each indicator gets a visual SCALE: contiguous plain-language bands (the same
// cutoffs the indicator functions above use), the current position, and — when a
// waist/weight trend exists — a projected position ~12 weeks out at the current
// pace. This is what the PWA draws as a zone bar with "you are here" and "heading
// here" markers. Bands carry WORDS and tones, never a 0-100 score; the projection
// is a straight-line "at the current pace" read, framed as a suggestion.
export interface BodyCompBand {
  from: number;
  to: number;
  label: string;
  tone: BodyTone;
}

export interface BodyCompScale {
  key: string; // whtr | bodyfat | whr | bmi
  label: string;
  unit: string;
  min: number;
  max: number;
  bands: BodyCompBand[];
  optimal: { from: number; to: number }; // the band(s) to aim for
  value: number | null;
  projected: number | null; // trend-projected value at horizon (null without a trend)
  horizon_weeks: number;
  estimate: boolean;
  read: string; // the indicator's own plain-language sentence
}

export interface BodyCompFocus {
  scales: BodyCompScale[];
  focus: { key: string; label: string; line: string } | null; // ONE lever, plain words
  heading: string | null; // one calm sentence about where the trend is taking this
}

const PROJECTION_WEEKS = 12;

function clampToScale(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
}

// Straight-line projection of a site/weight series `weeks` out; null without a
// usable trend (n<2 or a degenerate slope).
function projectValue(trend: SiteTrend | undefined, weeks: number): number | null {
  if (!trend || trend.latest == null || trend.slope_per_week == null || trend.n < 2) return null;
  return trend.latest + trend.slope_per_week * weeks;
}

export function getBodyCompFocus(unit: MeasureUnit = "in"): BodyCompFocus {
  const p = getProfile();
  const m = latestKnownMeasurement();
  const heightIn = effectiveHeightIn(p);
  const female = isFemale(p);
  const indicators = getBodyIndicators(m, p);
  const byKey = Object.fromEntries(indicators.map((i) => [i.key, i]));

  // Trends drive the "heading" marker: waist for the ratios/body-fat, weight for BMI.
  const trends = getBodyMetricTrends(180);
  const waistTrend = trends.sites.find((s) => s.key === "waist_in");
  const waistProj = projectValue(waistTrend, PROJECTION_WEEKS);
  const weightProj = projectValue(trends.weight, PROJECTION_WEEKS);

  const scales: BodyCompScale[] = [];

  // Waist-to-height: the single highest-leverage tape read.
  {
    const ind = byKey.whtr;
    const bands: BodyCompBand[] = [
      { from: 0.35, to: 0.4, label: "lean", tone: "info" },
      { from: 0.4, to: 0.5, label: "optimal", tone: "ok" },
      { from: 0.5, to: 0.6, label: "elevated", tone: "watch" },
      { from: 0.6, to: 0.65, label: "high", tone: "warn" },
    ];
    const projected =
      waistProj != null && heightIn ? clampToScale(waistProj / heightIn, 0.35, 0.65) : null;
    scales.push({
      key: "whtr",
      label: "Waist-to-height",
      unit: "",
      min: 0.35,
      max: 0.65,
      bands,
      optimal: { from: 0.4, to: 0.5 },
      value: ind?.value ?? null,
      projected,
      horizon_weeks: PROJECTION_WEEKS,
      estimate: false,
      read: ind?.read ?? "",
    });
  }

  // Body fat (Navy tape estimate), sex-aware bands mirroring navyBodyFat's.
  {
    const ind = byKey.bodyfat;
    const bands: BodyCompBand[] = female
      ? [
          { from: 12, to: 14, label: "very lean", tone: "info" },
          { from: 14, to: 21, label: "athletic", tone: "ok" },
          { from: 21, to: 25, label: "fit", tone: "ok" },
          { from: 25, to: 32, label: "average", tone: "info" },
          { from: 32, to: 45, label: "high", tone: "watch" },
        ]
      : [
          { from: 4, to: 6, label: "very lean", tone: "info" },
          { from: 6, to: 14, label: "athletic", tone: "ok" },
          { from: 14, to: 18, label: "fit", tone: "ok" },
          { from: 18, to: 25, label: "average", tone: "info" },
          { from: 25, to: 35, label: "high", tone: "watch" },
        ];
    const optimal = female ? { from: 14, to: 25 } : { from: 6, to: 18 };
    // Project by recomputing the Navy formula with the projected waist (neck/hips held).
    let projected: number | null = null;
    if (waistProj != null && heightIn != null && m?.neck_in != null && (!female || m?.hip_in != null)) {
      const inner = female ? waistProj + (m.hip_in as number) - (m.neck_in as number) : waistProj - (m.neck_in as number);
      if (inner > 0) {
        const bf = female
          ? 163.205 * Math.log10(inner) - 97.684 * Math.log10(heightIn) - 78.387
          : 86.01 * Math.log10(inner) - 70.041 * Math.log10(heightIn) + 36.76;
        projected = clampToScale(Math.round(bf * 10) / 10, bands[0].from, bands[bands.length - 1].to);
      }
    }
    scales.push({
      key: "bodyfat",
      label: "Body fat",
      unit: "%",
      min: bands[0].from,
      max: bands[bands.length - 1].to,
      bands,
      optimal,
      value: ind?.value ?? null,
      projected,
      horizon_weeks: PROJECTION_WEEKS,
      estimate: true,
      read: ind?.read ?? "",
    });
  }

  // Waist-to-hip, sex-aware WHO cutoffs.
  {
    const ind = byKey.whr;
    const elevated = female ? 0.85 : 0.9;
    const high = female ? 0.925 : 1.0;
    const min = female ? 0.65 : 0.7;
    const max = female ? 1.0 : 1.1;
    const bands: BodyCompBand[] = [
      { from: min, to: elevated, label: "optimal", tone: "ok" },
      { from: elevated, to: high, label: "elevated", tone: "watch" },
      { from: high, to: max, label: "high", tone: "warn" },
    ];
    const projected =
      waistProj != null && m?.hip_in != null ? clampToScale(waistProj / (m.hip_in as number), min, max) : null;
    scales.push({
      key: "whr",
      label: "Waist-to-hip",
      unit: "",
      min,
      max,
      bands,
      optimal: { from: min, to: elevated },
      value: ind?.value ?? null,
      projected,
      horizon_weeks: PROJECTION_WEEKS,
      estimate: false,
      read: ind?.read ?? "",
    });
  }

  // BMI — kept last and carrying its athlete caveat in `read`.
  {
    const ind = byKey.bmi;
    const bands: BodyCompBand[] = [
      { from: 16, to: 18.5, label: "below range", tone: "watch" },
      { from: 18.5, to: 25, label: "healthy", tone: "ok" },
      { from: 25, to: 30, label: "above range", tone: "info" },
      { from: 30, to: 35, label: "well above", tone: "watch" },
    ];
    const projected =
      weightProj != null && heightIn ? clampToScale((703 * weightProj) / (heightIn * heightIn), 16, 35) : null;
    scales.push({
      key: "bmi",
      label: "BMI",
      unit: "",
      min: 16,
      max: 35,
      bands,
      optimal: { from: 18.5, to: 25 },
      value: ind?.value ?? null,
      projected,
      horizon_weeks: PROJECTION_WEEKS,
      estimate: false,
      read: ind?.read ?? "",
    });
  }

  // ONE focus lever — the first indicator (in leverage order) sitting outside its
  // optimal band. Calm, concrete, and honest about what moves it.
  const uw = unit === "cm" ? "cm" : "in";
  let focus: BodyCompFocus["focus"] = null;
  const whtr = scales.find((s) => s.key === "whtr")!;
  const bf = scales.find((s) => s.key === "bodyfat")!;
  const whr = scales.find((s) => s.key === "whr")!;
  if (whtr.value != null && whtr.value > whtr.optimal.to && heightIn != null && m?.waist_in != null) {
    const targetWaistIn = whtr.optimal.to * heightIn;
    const deltaIn = Math.max(0, (m.waist_in as number) - targetWaistIn);
    const delta = Math.round((unit === "cm" ? deltaIn * CM_PER_IN : deltaIn) * 10) / 10;
    focus = {
      key: "whtr",
      label: whtr.label,
      line: `Bring the waist in ~${delta} ${uw} to get under half your height — the single highest-leverage body number for long-term health. A lean-safe deficit with the protein anchor does it; the tape will show it in 2–3 weeks.`,
    };
  } else if (whtr.value != null && whtr.value < whtr.optimal.from) {
    focus = {
      key: "whtr",
      label: whtr.label,
      line: "You're on the lean edge — the lever now is building, not cutting: protect the surplus-side fuel and let the arms/thigh tape climb while the waist holds.",
    };
  } else if (bf.value != null && bf.value > bf.optimal.to) {
    focus = {
      key: "bodyfat",
      label: bf.label,
      line: "Nudge body fat toward the fit band — a modest lean-safe deficit, protein first, and keep the strength volume so the loss is fat, not muscle. Judge it on the monthly tape trend, not any single reading.",
    };
  } else if (whr.value != null && whr.value > whr.optimal.to) {
    focus = {
      key: "whr",
      label: whr.label,
      line: "The waist is carrying more than the hips — central fat is the pattern worth moving. Zone-2 work plus a small deficit shifts it; re-tape monthly.",
    };
  }

  // The heading sentence: where the current pace is taking the waist.
  let heading: string | null = null;
  if (waistTrend && waistTrend.n >= 2 && waistTrend.slope_per_week != null && heightIn != null && m?.waist_in != null && whtr.value != null) {
    const slope = waistTrend.slope_per_week; // in/week
    const boundaryIn = whtr.optimal.to * heightIn;
    if (whtr.value > whtr.optimal.to && slope < -0.01) {
      const weeks = Math.round(((m.waist_in as number) - boundaryIn) / -slope);
      if (weeks >= 1 && weeks <= 78)
        heading = `At the current pace your waist-to-height reaches the optimal band in ~${weeks} week${weeks === 1 ? "" : "s"} — keep doing what you're doing.`;
    } else if (whtr.value > whtr.optimal.to && slope > 0.01) {
      heading = "The waist is drifting up at the moment — worth a look at energy balance before it compounds. A small course-correction now beats a big one later.";
    } else if (whtr.value <= whtr.optimal.to && Math.abs(slope) <= 0.01) {
      heading = "Waist is holding steady in a good place — a monthly tape session is enough to catch drift early.";
    } else if (whtr.value <= whtr.optimal.to && slope > 0.01) {
      heading = "You're in the optimal band but the waist has started drifting up — nothing alarming, just worth watching the next few weeks.";
    }
  } else if (m && (!waistTrend || waistTrend.n < 2)) {
    heading = "One tape session logged — log another in a few weeks and the projection markers light up.";
  }

  return { scales, focus, heading };
}

// --- composite summary (REST GET + PWA) ---------------------------------------
export interface BodyMetricsSummary {
  latest: BodyMeasurementRow | null;
  measurements: BodyMeasurementRow[];
  indicators: BodyIndicator[];
  trends: { window_days: number | null; sites: SiteTrend[]; weight: SiteTrend };
  profile: { height_in: number | null; sex: string; weight_lb: number | null; goal_weight_lb: number | null };
  needs_height: boolean;
  unit: MeasureUnit;
  sites: { key: MeasurementSite; label: string; hint: string }[];
  comp: BodyCompFocus;
}

export function getBodyMetricsSummary(days = 365, unit: MeasureUnit = "in"): BodyMetricsSummary {
  const p = getProfile();
  const measurements = listBodyMeasurements(days).map((m) => rowToUnit(m, unit));
  const latest = latestBodyMeasurement();
  const heightIn = effectiveHeightIn(p);
  return {
    latest: latest ? rowToUnit(latest, unit) : null,
    measurements,
    indicators: getBodyIndicators(latestKnownMeasurement(days), p),
    trends: getBodyMetricTrends(days, unit),
    profile: {
      height_in: heightIn,
      sex: String(p?.sex || "male"),
      weight_lb: latestWeightLb(p),
      goal_weight_lb: p?.goal_weight_lb ?? null,
    },
    needs_height: heightIn == null,
    unit,
    sites: MEASUREMENT_SITES.map((key) => ({ key, label: SITE_LABELS[key], hint: SITE_HINTS[key] })),
    comp: getBodyCompFocus(unit),
  };
}

// --- coach-context slice (SEAM: Wave B folds this into getCoachContext) --------
// A bounded, plain-language view so the connected brain SEES the body picture.
export function bodyMetricsContextSlice(): {
  latest_date: string;
  measurements: Partial<Record<MeasurementSite, number>>;
  indicators: { label: string; value: number | null; unit: string; zone: string | null; estimate: boolean }[];
  waist_trend: string | null;
  height_in: number | null;
  focus_line: string | null;
  heading: string | null;
} | null {
  const latest = latestKnownMeasurement();
  const heightIn = effectiveHeightIn();
  if (!latest && heightIn == null) return null;
  const measurements: Partial<Record<MeasurementSite, number>> = {};
  if (latest) for (const site of MEASUREMENT_SITES) if (latest[site] != null) measurements[site] = latest[site] as number;
  const indicators = getBodyIndicators(latest)
    .filter((i) => i.value != null)
    .map((i) => ({ label: i.label, value: i.value, unit: i.unit, zone: i.zone, estimate: !!i.estimate }));
  const waistTrend = getBodyMetricTrends(180).sites.find((s) => s.key === "waist_in");
  // The deterministic where-you-stand read — the SAME lever + heading the PWA's
  // zone bars show, so the coach and the card literally speak from one source.
  let focusLine: string | null = null;
  let heading: string | null = null;
  try {
    const comp = getBodyCompFocus();
    focusLine = comp.focus?.line ?? null;
    heading = comp.heading;
  } catch {
    /* quiet — the slice stays useful without the comp read */
  }
  return {
    latest_date: latest?.date ?? "",
    measurements,
    indicators,
    waist_trend: waistTrend && waistTrend.n >= 2 ? waistTrend.text : null,
    height_in: heightIn,
    focus_line: focusLine,
    heading,
  };
}

// --- agentic chat capture (SEAM: Wave E dispatches the `log_measurement` action) --
// "waist 34, chest 42, arms 15" → one clean call. Optional height_in updates the
// profile so BMI/body-fat light up. Returns the row + fresh indicators, or a
// no-op when nothing measurable was provided.
export interface MeasurementActionResult {
  ok: boolean;
  measurement: BodyMeasurementRow | null;
  height_in: number | null;
  indicators: BodyIndicator[];
  note?: string;
}

export function applyMeasurementAction(action: Record<string, unknown>): MeasurementActionResult {
  const unit = normalizeUnit(action.unit);
  const sites = pickSites(action, unit);
  // Height: `height_cm` is always centimeters; `height_in` follows the action's unit
  // (so a cm-speaking user's "height 178" round-trips correctly). Stored as inches.
  let heightRaw: number | null = null;
  if (action.height_cm != null && action.height_cm !== "" && Number.isFinite(Number(action.height_cm))) {
    heightRaw = Number(action.height_cm) / CM_PER_IN;
  } else if (action.height_in != null && action.height_in !== "" && Number.isFinite(Number(action.height_in))) {
    heightRaw = unit === "cm" ? Number(action.height_in) / CM_PER_IN : Number(action.height_in);
  }
  let heightIn: number | null = null;
  if (heightRaw != null) {
    const p = setProfile({ height_in: Math.round(heightRaw * 10) / 10 });
    heightIn = p?.height_in ?? effectiveHeightIn(p);
  } else {
    heightIn = effectiveHeightIn();
  }
  if (!hasAnySite(sites)) {
    // Height-only capture is still useful (unlocks BMI) — treat as ok when we set it.
    const ok = heightRaw != null;
    return { ok, measurement: null, height_in: heightIn, indicators: getBodyIndicators(latestKnownMeasurement()), note: ok ? "height set" : "nothing to log" };
  }
  const measurement = addBodyMeasurement(
    typeof action.date === "string" ? action.date : undefined,
    sites,
    typeof action.note === "string" ? action.note : null,
    typeof action.source === "string" ? action.source : "chat"
  );
  return { ok: true, measurement, height_in: heightIn, indicators: getBodyIndicators(measurement) };
}
