// BODY FAT HAS ONE ESTIMATE — every measurement, weighed by how much it can be trusted.
//
// Most people never get a DEXA, and a home bioimpedance reading is a poor judge of the
// level. So no single source is "the" body fat. Each measurement is a source in ONE table
// with its known error, and the estimate combines them:
//
//   - ANCHOR: a DEXA document, or a Bod Pod / hydrostatic test named as such (±~2
//     points). It ages: projected onto today's weight with its lean mass held, and its
//     error widens with the weight moved and the months since the scan.
//   - TAPE (U.S. Navy circumference formula, ±~3.5, biased by where a body carries fat):
//     the level when there is no anchor; CALIBRATED to an anchor when the two overlap in
//     time — a person-specific offset, the anchor projected to the tape day minus the
//     Navy read that day — and then applied to the latest tape. A calibrated tape already
//     carries its anchor, so the two are never counted as independent.
//   - BIOIMPEDANCE (a home scale, garmin_daily_metrics.body_fat_pct, or an InBody-style
//     "Body Fat %" printout filed as any other document kind): DIRECTION only. It never
//     sets the level.
//   - FALLBACK: height / weight / age / sex (Deurenberg), with a wide range — the level
//     when nothing else exists, and a hand-off when every measured level has aged past it.
//
// Every level is carried from its date to today on the CANONICAL bodyweight series
// (manual weigh-ins plus the watch's scale — the same series resolvedCurrentBodyweight
// reads), averaged over a week so a daily wobble never flips a band. Levels combine
// by inverse variance; levels that disagree beyond their own errors widen the range
// (a Birge-ratio inflation), and the range always spans every measured level, so a
// disagreement is never hidden. The range is never narrower than the best single source.
//
// One estimate, read two ways: the central value for display, and `low` — the LEANER
// end — for anything protective (loss-rate caps, cut planning), so a rough estimate is
// protective by default and loosens as measurements narrow it. Decisions that claim a
// result (a milestone, a goal reached, a percentile) need `measured` — a real level, not
// the fallback. Informational; no score, no grade.

import { db } from "../db.js";
import { canonicalBodyweightSeries, resolvedCurrentBodyweight } from "./bodyweight.js";
import { dailySiteSeries } from "./measurement-series.js";
import { matchOptimalZone } from "./propagation-data.js";
import { copyDeep, requestMemo } from "./request-memo.js";
import { LB_PER_KG, localDateISO } from "./shared.js";
import { round1 } from "../lib/numbers.js";

export type BodyFatSourceKind =
  | "dexa"
  | "bod_pod"
  | "hydrostatic"
  | "tape"
  | "scale"
  | "bioimpedance"
  | "anthropometric";

export interface BodyFatSource {
  kind: BodyFatSourceKind;
  value: number;
  date: string | null;
  used_as: "anchor" | "calibration" | "level" | "calibrated_level" | "direction" | "fallback";
}

export interface BodyFatEstimateRead {
  value: number;
  low: number;
  high: number;
  /** The newest date a level-setting measurement was taken. */
  date: string | null;
  /** The source that carries the most weight in the level. */
  primary: BodyFatSourceKind;
  /** True when a real measurement (a scan or a tape) sets the level — false for the fallback alone. */
  measured: boolean;
  sources: BodyFatSource[];
  basis_line: string;
  sharpen_hint: string | null;
  /** Points added to a raw Navy tape read to calibrate it to this person's anchor; null when uncalibrated. */
  tape_offset: number | null;
  /** The bioimpedance direction over the last weeks, when there is one. */
  scale_trend: "falling" | "rising" | "steady" | null;
  /** The (week-smoothed) bodyweight the estimate is carried to. */
  weight_lb: number | null;
  /** The scan the estimate is anchored to (a DEXA, Bod Pod or hydrostatic test), or null. */
  anchor: BodyFatAnchor | null;
}

// THE TABLE — one row per source tier, its 1-sigma error in body-fat points, and how fast
// a level from it ages. Extend the table, never add a per-source branch below.
export const BODY_FAT_SOURCE_TIERS = {
  anchor: { sd: 2, sd_per_lb_moved: 0.1, sd_per_month: 0.2 },
  tape: { sd: 3.5, sd_per_lb_moved: 0.1, sd_per_month: 0.2 },
  // A calibrated tape keeps the tape's day-to-day noise but loses its distribution bias.
  tape_calibrated: { sd: 1.5, sd_per_lb_moved: 0.1, sd_per_month: 0.2 },
  anthropometric: { sd: 6, sd_per_lb_moved: 0, sd_per_month: 0 },
  // With sex unset the formula's largest term is a midpoint guess.
  anthropometric_sex_unset: { sd: 7.5, sd_per_lb_moved: 0, sd_per_month: 0 },
} as const;
// A scan with no weigh-in near it is projected from the first weigh-in after it, and
// that guess costs this much extra error.
const UNKNOWN_SCAN_WEIGHT_SD = 1.5;
// A tape row this close to an anchor's date may calibrate against it.
const CALIBRATION_WINDOW_DAYS = 60;
// A weigh-in this close to a date counts as that date's weight.
const WEIGHT_NEAR_DAYS = 21;
// The bodyweight a level is carried to is the mean of the last week, never one day.
const WEIGHT_SMOOTH_DAYS = 7;
// The bioimpedance direction window.
const SCALE_WINDOW_DAYS = 42;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateWords(iso: string | null): string {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "an earlier date";
}

const clampPct = (n: number) => Math.max(3, Math.min(70, n));
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 864e5);
}

function heightInFor(p: any): number | null {
  const hin = Number(p?.height_in);
  if (Number.isFinite(hin) && hin >= 24 && hin <= 108) return hin;
  const hcm = Number(p?.height_cm);
  if (Number.isFinite(hcm) && hcm >= 60 && hcm <= 275) return hcm / 2.54;
  return null;
}

/** U.S. Navy circumference body fat, sex-aware; null when the inputs cannot make one. */
export function navyBodyFatPct(input: {
  heightIn: number | null;
  waistIn: number | null;
  neckIn: number | null;
  hipIn?: number | null;
  female: boolean;
}): number | null {
  const { heightIn: h, waistIn: waist, neckIn: neck, hipIn: hip, female } = input;
  if (h == null || waist == null || neck == null || !(h > 0)) return null;
  let value: number;
  if (female) {
    if (hip == null || waist + hip - neck <= 0) return null;
    value = 163.205 * Math.log10(waist + hip - neck) - 97.684 * Math.log10(h) - 78.387;
  } else {
    if (waist - neck <= 0) return null;
    value = 86.01 * Math.log10(waist - neck) - 70.041 * Math.log10(h) + 36.76;
  }
  return Number.isFinite(value) ? round1(clampPct(value)) : null;
}

interface WeightPoint {
  date: string;
  lb: number;
}

function weightSeries(today: string): WeightPoint[] {
  try {
    return canonicalBodyweightSeries({ through: today })
      .map((p) => ({ date: p.date, lb: Number(p.weight_lb) }))
      .filter((p) => isDay(p.date) && Number.isFinite(p.lb) && p.lb > 0);
  } catch {
    return [];
  }
}

function weightNear(series: WeightPoint[], date: string, maxGapDays = WEIGHT_NEAR_DAYS): number | null {
  let best: WeightPoint | null = null;
  let gap = Number.POSITIVE_INFINITY;
  const d = dayNumber(date);
  for (const w of series) {
    const g = Math.abs(dayNumber(w.date) - d);
    if (g < gap) {
      gap = g;
      best = w;
    }
  }
  return best && gap <= maxGapDays ? best.lb : null;
}

// The week-smoothed weight as of `date`: the mean of the series over the week ending on
// the latest point at or before it (a mean, not a median — a median of an alternating
// wobble flips with it). A day's wobble moves it by a seventh, never a band.
function smoothedWeightAt(series: WeightPoint[], date: string): number | null {
  const upTo = series.filter((p) => p.date <= date);
  const last = upTo.at(-1);
  if (!last) return null;
  const from = dayNumber(last.date) - (WEIGHT_SMOOTH_DAYS - 1);
  const week = upTo.filter((p) => dayNumber(p.date) >= from).map((p) => p.lb);
  return week.reduce((a, b) => a + b, 0) / week.length;
}

interface Level {
  kind: BodyFatSourceKind;
  value: number; // as of today
  sd: number;
  date: string | null;
  used_as: BodyFatSource["used_as"];
  measured: number; // the value on its own date
}

// Carry a level from its date to `toDate`, lean mass held; the error widens with the
// weight moved and the months passed. With no weight at the reading, the first weigh-in
// after it stands in (at an extra cost), and with no weigh-in at all only time widens it.
function carry(
  pct: number,
  readingDate: string,
  readingLb: number | null,
  series: WeightPoint[],
  toDate: string,
  toLb: number | null,
  tier: { sd: number; sd_per_lb_moved: number; sd_per_month: number }
): { value: number; sd: number } {
  const months = Math.max(0, (dayNumber(toDate) - dayNumber(readingDate)) / 30.44);
  let fromLb = readingLb ?? weightNear(series, readingDate);
  let extra = 0;
  if (fromLb == null) {
    const after = series.find((p) => p.date >= readingDate && p.date <= toDate);
    if (after) {
      fromLb = after.lb;
      extra = UNKNOWN_SCAN_WEIGHT_SD;
    }
  }
  let value = pct;
  let moved = 0;
  if (fromLb != null && toLb != null && toLb > 0) {
    const ffm = fromLb * (1 - pct / 100);
    if (toLb > ffm) value = clampPct(((toLb - ffm) / toLb) * 100);
    moved = Math.abs(toLb - fromLb);
  }
  return { value, sd: tier.sd + extra + tier.sd_per_lb_moved * moved + tier.sd_per_month * months };
}

// ---- documents: which "body fat %" readings are scans, and which are bioimpedance ----

interface DocReading {
  kind: BodyFatSourceKind;
  value: number;
  date: string;
  scanLb: number | null;
  docId: number;
  markers: Array<{ name: string; value: unknown; unit: string | null }>;
}

/** The scan the estimate is anchored to: its document, its reading and its weight. */
export interface BodyFatAnchor {
  kind: "dexa" | "bod_pod" | "hydrostatic";
  label: string;
  value: number;
  date: string;
  scan_lb: number | null;
  doc_id: number;
  /** The scan document's own rows, for its regional detail (visceral fat, lean mass …). */
  markers: Array<{ name: string; value: unknown; unit: string | null }>;
}

/** Sex as the formulas read it: "female" / "male" by its first letter, else null (unset). */
export function profileSex(p: any): "female" | "male" | null {
  const s = String(p?.sex ?? "").trim().toLowerCase();
  return s.startsWith("f") ? "female" : s.startsWith("m") ? "male" : null;
}

// A total body-fat PERCENTAGE: the canonical total zone ("Body fat %", "Percent Body
// Fat", "Total body fat"), "Body fat (%)", or a bare "Body fat". Never a regional DEXA row
// ("Body Fat - Arms"), never a mass row ("Total Body Fat Mass", lb/kg), and the unit must
// be a percent or absent.
function isTotalBodyFat(name: string, unit: unknown): boolean {
  if (/\b(?:arms?|legs?|trunk|android|gynoid|head|ribs?|pelvis|spine|left|right|regional)\b/i.test(name)) return false;
  if (/\bmass\b|\blbs?\b|\bkgs?\b|\bpounds?\b|\bgrams?\b/i.test(name)) return false;
  const u = String(unit ?? "").trim();
  if (u && !/^%$|percent/i.test(u)) return false;
  return (
    matchOptimalZone(name)?.label === "Body fat" ||
    /^\s*(?:total\s+)?body\s*fat\s*(?:\(\s*%\s*\)|%)?\s*$/i.test(name)
  );
}

function massLb(m: any): number | null {
  const v = Number(m?.value);
  if (!Number.isFinite(v)) return null;
  const lb = /\bkgs?\b|kilo/i.test(String(m?.unit ?? "")) ? v * LB_PER_KG : v;
  return lb >= 60 && lb <= 600 ? lb : null;
}

// A scan mass this far off the weigh-in nearest the scan is a misread unit or row, not
// the person's weight that day.
const SCAN_MASS_MAX_DISAGREEMENT = 0.15;

// A bioimpedance device by name, or by the readings only it prints (body water, phase
// angle, skeletal muscle mass, a device "score").
const BIA_DEVICE = /\b(?:inbody|bia|bioimpedance|bio-impedance|bioelectrical|tanita|withings|omron|evolt|styku|seca|smart scale)\b/i;
const BIA_MARKERS = /body water|\becw\b|\bicw\b|phase angle|skeletal muscle mass|\bsmm\b|inbody score|segmental lean/i;

function documentReadings(): DocReading[] {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, kind, doc_date, created_at, parsed_json, original_name, summary FROM health_documents
          WHERE parsed_json LIKE '%ody%at%' AND COALESCE(enrichment_status,'') != 'pending_confirm'`
      )
      .all() as any[];
  } catch {
    return [];
  }
  const out: DocReading[] = [];
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
    const date = String(row.doc_date ?? row.created_at ?? "").slice(0, 10);
    if (!isDay(date)) continue;
    const totals = markers.filter((m: any) => isTotalBodyFat(String(m?.name ?? ""), m?.unit));
    // A row that says "%" outranks one with no unit.
    const bf = totals.find((m: any) => String(m?.unit ?? "").trim()) ?? totals[0];
    const value = Number(bf?.value);
    if (!bf || !Number.isFinite(value) || value < 3 || value > 70) continue;
    // Tier by what the document IS. A Bod Pod / hydrostatic test named as one is an anchor.
    // A DEXA document is an anchor unless it carries a bioimpedance device's fingerprints
    // (the ingest files any body-fat printout as "dexa", so the kind alone is no proof).
    // Every other "body fat %" printout is bioimpedance — direction only.
    const named = `${row.original_name ?? ""} ${row.summary ?? ""} ${parsed?.type ?? ""}`;
    const markerNames = markers.map((m: any) => String(m?.name ?? "")).join("\n");
    const bioimpedance = BIA_DEVICE.test(named) || BIA_MARKERS.test(markerNames);
    const kind: BodyFatSourceKind = /bod ?pod|air[- ]displacement/i.test(named)
      ? "bod_pod"
      : /hydrostatic|underwater weigh/i.test(named)
        ? "hydrostatic"
        : String(row.kind) === "dexa" && !bioimpedance
          ? "dexa"
          : "bioimpedance";
    const mass = markers.find((m: any) => /\btotal (?:body )?mass\b|^\s*(?:body )?weight\s*$/i.test(String(m?.name ?? "")));
    out.push({
      kind,
      value,
      date,
      scanLb: mass ? massLb(mass) : null,
      docId: Number(row.id),
      markers: markers
        .filter((m: any) => m && typeof m === "object")
        .map((m: any) => ({ name: String(m.name ?? ""), value: m.value, unit: m.unit != null ? String(m.unit) : null })),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function tapeRows(heightIn: number | null, female: boolean, today: string): Array<{ date: string; value: number }> {
  if (heightIn == null) return [];
  const waist = dailySiteSeries("waist_in", { through: today });
  if (!waist.length) return [];
  const neck = dailySiteSeries("neck_in", { through: today });
  const hip = female ? dailySiteSeries("hip_in", { through: today }) : [];
  // A neck (or hip) carries to a nearby waist day — before it, or within a week after.
  const nearest = (series: Array<{ date: string; value: number }>, date: string) => {
    let out: number | null = null;
    for (const r of series) if (String(r.date).slice(0, 10) <= date) out = Number(r.value);
    if (out != null) return out;
    const after = series.find((r) => dayNumber(String(r.date)) - dayNumber(date) <= 7);
    return after ? Number(after.value) : null;
  };
  const out: Array<{ date: string; value: number }> = [];
  for (const w of waist) {
    const date = String(w.date).slice(0, 10);
    const value = navyBodyFatPct({
      heightIn,
      waistIn: Number(w.value),
      neckIn: nearest(neck as any, date),
      hipIn: female ? nearest(hip as any, date) : null,
      female,
    });
    if (value != null) out.push({ date, value });
  }
  return out;
}

function bioimpedanceTrend(today: string, docs: DocReading[]): {
  latest: { value: number; date: string; kind: BodyFatSourceKind } | null;
  trend: BodyFatEstimateRead["scale_trend"];
} {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - SCALE_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  let rows: Array<{ date: string; value: number; kind: BodyFatSourceKind }> = [];
  try {
    rows = (
      db
        .prepare(
          `SELECT date, body_fat_pct FROM garmin_daily_metrics WHERE body_fat_pct IS NOT NULL AND date >= ? AND date <= ? ORDER BY date ASC`
        )
        .all(since, today) as any[]
    )
      .map((r) => ({ date: String(r.date).slice(0, 10), value: Number(r.body_fat_pct), kind: "scale" as BodyFatSourceKind }))
      .filter((r) => Number.isFinite(r.value) && r.value >= 3 && r.value <= 70);
  } catch {
    rows = [];
  }
  for (const d of docs) if (d.kind === "bioimpedance" && d.date >= since && d.date <= today) rows.push(d);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const latest = rows.at(-1) ?? null;
  if (rows.length < 4) return { latest, trend: null };
  const xs = rows.map((r) => dayNumber(r.date));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = rows.reduce((a, r) => a + r.value, 0) / rows.length;
  let num = 0;
  let den = 0;
  rows.forEach((r, i) => {
    num += (xs[i] - mx) * (r.value - my);
    den += (xs[i] - mx) ** 2;
  });
  const perWeek = den > 0 ? (num / den) * 7 : 0;
  return { latest, trend: perWeek <= -0.15 ? "falling" : perWeek >= 0.15 ? "rising" : "steady" };
}

// Deurenberg's sex term: 1 for male, 0 for female, and the midpoint when sex is unset —
// with a wider error, since the formula's largest single term is then a guess.
function deurenberg(p: any, weightLb: number | null, heightIn: number | null): number | null {
  const age = Number(p?.age);
  if (weightLb == null || heightIn == null || !Number.isFinite(age) || age <= 0) return null;
  const bmi = (weightLb / (heightIn * heightIn)) * 703;
  const sex = profileSex(p);
  const male = sex === "male" ? 1 : sex === "female" ? 0 : 0.5;
  return round1(clampPct(1.2 * bmi + 0.23 * age - 10.8 * male - 5.4));
}

function computeBodyFatEstimate(p: any, today: string): BodyFatEstimateRead | null {
  const female = profileSex(p) === "female";
  const heightIn = heightInFor(p);
  const series = weightSeries(today);
  // The weight every level is carried to: the week-smoothed canonical series, else the
  // canonical current bodyweight (which falls back to the profile).
  const resolved = (() => {
    try {
      return resolvedCurrentBodyweight(p, today);
    } catch {
      return null;
    }
  })();
  const nowLb = smoothedWeightAt(series, today) ?? resolved?.weight_lb ?? null;
  const measuredLevels: Level[] = [];
  const sources: BodyFatSource[] = [];

  const docs = documentReadings().filter((d) => d.date <= today);
  const anchor = [...docs].reverse().find((d) => d.kind !== "bioimpedance") ?? null;
  // A scan mass far off the weigh-in nearest the scan is a misread unit or row.
  let anchorScanLb = anchor?.scanLb ?? null;
  if (anchor && anchorScanLb != null) {
    const near = weightNear(series, anchor.date);
    if (near != null && Math.abs(anchorScanLb - near) / near > SCAN_MASS_MAX_DISAGREEMENT) anchorScanLb = null;
  }
  const anchorAt = anchor
    ? (date: string, lb: number | null) =>
        carry(anchor.value, anchor.date, anchorScanLb, series, date, lb, BODY_FAT_SOURCE_TIERS.anchor)
    : null;
  if (anchor && anchorAt) {
    const now = anchorAt(today, nowLb);
    measuredLevels.push({ kind: anchor.kind, value: now.value, sd: now.sd, date: anchor.date, used_as: "anchor", measured: anchor.value });
  }

  const tapes = tapeRows(heightIn, female, today);
  let tapeOffset: number | null = null;
  const latestTape = tapes.at(-1) ?? null;
  if (latestTape) {
    let calibrationSd = 0;
    if (anchor && anchorAt) {
      const near = tapes.reduce<{ row: (typeof tapes)[number]; gap: number } | null>((best, row) => {
        const gap = Math.abs(dayNumber(row.date) - dayNumber(anchor.date));
        return !best || gap < best.gap ? { row, gap } : best;
      }, null);
      if (near && near.gap <= CALIBRATION_WINDOW_DAYS) {
        const projected = anchorAt(near.row.date, smoothedWeightAt(series, near.row.date) ?? weightNear(series, near.row.date));
        tapeOffset = round1(projected.value - near.row.value);
        calibrationSd = projected.sd;
      }
    }
    const tapeLb = smoothedWeightAt(series, latestTape.date) ?? weightNear(series, latestTape.date);
    if (tapeOffset != null) {
      const calibrated = clampPct(latestTape.value + tapeOffset);
      const c = carry(calibrated, latestTape.date, tapeLb, series, today, nowLb, BODY_FAT_SOURCE_TIERS.tape_calibrated);
      const level: Level = {
        kind: "tape",
        value: c.value,
        sd: Math.sqrt(c.sd ** 2 + calibrationSd ** 2),
        date: latestTape.date,
        used_as: "calibrated_level",
        measured: latestTape.value,
      };
      // A calibrated tape already carries its anchor: never count the two as independent.
      // A tape taken after the anchor replaces it; one taken before it adds nothing new.
      const anchorIndex = measuredLevels.findIndex((l) => l.used_as === "anchor");
      if (latestTape.date >= (anchor?.date ?? "")) {
        if (anchorIndex >= 0) {
          sources.push({ kind: measuredLevels[anchorIndex].kind, value: round1(anchor!.value), date: anchor!.date, used_as: "calibration" });
          measuredLevels.splice(anchorIndex, 1);
        }
        measuredLevels.push(level);
      } else {
        sources.push({ kind: "tape", value: round1(latestTape.value), date: latestTape.date, used_as: "calibration" });
      }
    } else {
      const c = carry(latestTape.value, latestTape.date, tapeLb, series, today, nowLb, BODY_FAT_SOURCE_TIERS.tape);
      measuredLevels.push({ kind: "tape", value: c.value, sd: c.sd, date: latestTape.date, used_as: "level", measured: latestTape.value });
    }
  }

  const bia = bioimpedanceTrend(today, docs);

  // The fallback is the level with nothing else, and the hand-off when every measured
  // level has aged past it (an old scan after a big weight change constrains less).
  const fallbackValue = deurenberg(p, nowLb, heightIn);
  const bestMeasuredSd = measuredLevels.length ? Math.min(...measuredLevels.map((l) => l.sd)) : Number.POSITIVE_INFINITY;
  const levels = [...measuredLevels];
  const fallbackTier =
    profileSex(p) == null ? BODY_FAT_SOURCE_TIERS.anthropometric_sex_unset : BODY_FAT_SOURCE_TIERS.anthropometric;
  if (fallbackValue != null && bestMeasuredSd > fallbackTier.sd) {
    levels.push({
      kind: "anthropometric",
      value: fallbackValue,
      sd: fallbackTier.sd,
      date: today,
      used_as: "fallback",
      measured: fallbackValue,
    });
  }
  if (!levels.length) return null;

  for (const l of levels) sources.push({ kind: l.kind, value: round1(l.measured), date: l.date, used_as: l.used_as });
  if (bia.latest) sources.push({ kind: bia.latest.kind, value: round1(bia.latest.value), date: bia.latest.date, used_as: "direction" });

  const weights = levels.map((l) => 1 / (l.sd * l.sd));
  const total = weights.reduce((a, b) => a + b, 0);
  const value = levels.reduce((a, l, i) => a + l.value * weights[i], 0) / total;
  let sd = Math.sqrt(1 / total);
  // Disagreement widens the range: levels that sit further apart than their own errors
  // allow inflate the combined error by the Birge ratio.
  if (levels.length > 1) {
    const chi2 = levels.reduce((a, l, i) => a + weights[i] * (l.value - value) ** 2, 0);
    const birge = Math.sqrt(chi2 / (levels.length - 1));
    if (birge > 1) sd *= birge;
  }
  sd = Math.max(sd, Math.min(...levels.map((l) => l.sd)));
  let low = clampPct(value - sd);
  let high = clampPct(value + sd);
  // The range spans every measured level, so a disagreement is never hidden.
  for (const l of measuredLevels) {
    low = Math.min(low, l.value);
    high = Math.max(high, l.value);
  }
  const primary = levels[weights.indexOf(Math.max(...weights))];
  const dates = measuredLevels.map((l) => l.date).filter(Boolean) as string[];

  const anchorLevel = measuredLevels.find((l) => l.used_as === "anchor");
  const tapeLevel = measuredLevels.find((l) => l.kind === "tape");
  const anchorName = (kind: BodyFatSourceKind) =>
    kind === "bod_pod" ? "Bod Pod" : kind === "hydrostatic" ? "hydrostatic test" : "DEXA";
  let basis: string;
  if (tapeLevel?.used_as === "calibrated_level" && anchor) {
    basis = `Tape (${dateWords(tapeLevel.date)}) calibrated to your ${dateWords(anchor.date)} ${anchorName(anchor.kind)}, carried by your weight since.`;
  } else if (anchorLevel && tapeLevel) {
    basis = `Your ${dateWords(anchorLevel.date)} ${anchorName(anchorLevel.kind)} projected onto your current weight, with your ${dateWords(tapeLevel.date)} tape.`;
  } else if (anchorLevel) {
    basis = `Your ${dateWords(anchorLevel.date)} ${anchorName(anchorLevel.kind)}, projected onto your current weight.`;
  } else if (tapeLevel) {
    basis = `From your ${dateWords(tapeLevel.date)} tape measurements, carried by your weight since.`;
  } else {
    basis = "Estimated from height, weight and age.";
  }
  if (measuredLevels.length && levels.some((l) => l.used_as === "fallback")) {
    basis += " Your measurements are old enough that height and weight weigh in too.";
  }
  if (bia.latest) basis += " Your scale is good for direction, not the number.";

  const sharpen = !anchorLevel && !tapeLevel && !(tapeOffset != null)
    ? "A tape measurement (waist and neck) would narrow this; a DEXA would anchor it."
    : !anchor
      ? "A DEXA or similar scan would calibrate the tape to your own body."
      : sd > 4
        ? "A fresh tape measurement would narrow the range."
        : null;

  return {
    value: round1(value),
    low: round1(low),
    high: round1(high),
    date: dates.sort().at(-1) ?? null,
    primary: primary.kind,
    // A real measurement sets the level only while the fallback is not what carries it: an
    // aged scan that has handed off to height and weight is no longer a measured result.
    measured: measuredLevels.length > 0 && (!levels.some((l) => l.used_as === "fallback") || primary.kind !== "anthropometric"),
    anchor:
      anchor && anchor.kind !== "bioimpedance"
        ? {
            kind: anchor.kind as BodyFatAnchor["kind"],
            label: anchor.kind === "bod_pod" ? "Bod Pod" : anchor.kind === "hydrostatic" ? "hydrostatic test" : "DEXA",
            value: anchor.value,
            date: anchor.date,
            scan_lb: anchorScanLb,
            doc_id: anchor.docId,
            markers: anchor.markers,
          }
        : null,
    sources,
    basis_line: basis,
    sharpen_hint: sharpen,
    tape_offset: tapeOffset,
    scale_trend: bia.trend,
    weight_lb: nowLb != null ? round1(nowLb) : null,
  };
}

/** The one body-fat estimate (central, leaner end `low`, upper `high`), or null when nothing can make one. */
export function bodyFatEstimate(profile: any, today = localDateISO()): BodyFatEstimateRead | null {
  const key = [today, profile?.sex, profile?.age, profile?.height_in, profile?.height_cm, profile?.weight_lb].join("|");
  return requestMemo(`body_fat_estimate:${key}`, () => computeBodyFatEstimate(profile ?? {}, today), copyDeep);
}

/** "~23% (21–25)" — the estimate as a person reads it. */
export function bodyFatRangeText(est: Pick<BodyFatEstimateRead, "value" | "low" | "high">): string {
  return `~${Math.round(est.value)}% (${Math.round(est.low)}–${Math.round(est.high)})`;
}
