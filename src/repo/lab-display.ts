// Lab values as a PERSON reads them.
//
// Every marker series is stored and compared in its analyte's canonical unit
// (src/repo/lab-units.ts — the optimal band's own unit), so a reading from a lab on
// either system is comparable the moment it is read. This module is the other edge:
// the unit system the athlete reads labs in (`labUnitSystem()`, settings.ts — their
// explicit choice, else derived from their weight units) decides what a surface SHOWS.
//
//   - Display only. A row is converted AFTER every judgement on it (in/out of optimal,
//     the lab range, the trend direction) was made in canonical units, and the
//     conversion is monotonic, so no judgement can flip by being displayed.
//   - Source truth is never lost. A reading the lab printed in the display unit shows
//     its own printed number (no round trip through the canonical unit); one printed
//     in the other system carries `reported` ("201 mg/dL") beside the shown value.
//   - Lp(a) mass and molar readings are never converted (lab-units.ts `never`); an
//     unrecognized analyte, or a row not in its canonical unit, passes through as is.
//
// Pure, apart from `labUnitSystem()` as the default system.

import {
  displayUnitFor,
  fromCanonical,
  LAB_UNIT_TABLE,
  type LabUnitSystem,
  labUnitSpec,
  labUnitsCompatible,
  parseLabNumber,
  toCanonical,
} from "./lab-units.js";
import { unitAnalyteZone } from "./propagation-data.js";
import { labUnitSystem } from "./settings.js";

/** Display rounding for a converted value: about three significant figures, no float noise. */
export function roundLabDisplay(n: number): number {
  const abs = Math.abs(n);
  const places = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

/** The analyte label a row converts by — only while the row is in that analyte's canonical unit. */
export function labAnalyteFor(name: unknown, unit: unknown): string | null {
  const zone = unitAnalyteZone(String(name ?? ""));
  const spec = labUnitSpec(zone?.label);
  if (!zone || !spec || !unit || !labUnitsCompatible(unit, spec.canonical)) return null;
  return zone.label;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function shownValue(label: string, value: unknown, system: LabUnitSystem, delta = false): unknown {
  const n = numeric(value);
  if (n == null) return value;
  const out = fromCanonical(label, n, system, { delta });
  if (out == null || out === n) return value;
  return roundLabDisplay(out);
}

/** "201 mg/dL" — a reading exactly as its lab printed it. */
function reportedText(sourceValue: unknown, sourceUnit: unknown): string | null {
  const v = String(sourceValue ?? "").trim();
  const u = String(sourceUnit ?? "").trim();
  return v && u ? `${v} ${u}` : null;
}

// One reading (latest / prev / a chart point) in the display unit. A reading with no
// source fields was printed in the canonical unit itself (nothing was converted at read).
function presentReading(r: any, label: string, unit: string, canonicalUnit: string, system: LabUnitSystem): any {
  if (!r || typeof r !== "object") return r;
  const out: any = { ...r };
  const sourceUnit = r.source_unit ?? canonicalUnit;
  const sourceValue = r.source_unit ? r.source_value : r.value;
  const printedHere = labUnitsCompatible(sourceUnit, unit);
  const printed = printedHere && r.source_unit ? parseLabNumber(r.source_value, r.source_unit) : null;
  out.value = printed != null ? printed : shownValue(label, r.value, system);
  if (r.ref_low != null) out.ref_low = shownValue(label, r.ref_low, system);
  if (r.ref_high != null) out.ref_high = shownValue(label, r.ref_high, system);
  if (!printedHere) {
    const reported = reportedText(sourceValue, sourceUnit);
    if (reported) out.reported = reported;
  }
  return out;
}

function presentBand(band: any, label: string, system: LabUnitSystem): any {
  if (!band || typeof band !== "object") return band;
  const out: any = { ...band };
  if (band.low != null) out.low = shownValue(label, band.low, system);
  if (band.high != null) out.high = shownValue(label, band.high, system);
  return out;
}

/**
 * A marker row (the getMarkerHistory / prioritizeMarkers / publicMarkerRow shape) in the
 * athlete's lab-unit system: `unit`, every reading, the optimal band, the reference range
 * and the trend's change/slope. Adds `canonical_unit` when the shown unit differs, and a
 * reading's `reported` text when its lab printed it in another unit. A row with nothing to
 * convert and nothing reported comes back unchanged.
 */
export function presentMarkerRow<T>(marker: T, system: LabUnitSystem = labUnitSystem()): T {
  const m = marker as any;
  if (!m || typeof m !== "object") return marker;
  const label = labAnalyteFor(m.name ?? m.key, m.unit);
  if (!label) return marker;
  const unit = displayUnitFor(label, system) ?? m.unit;
  const convertsUnit = !labUnitsCompatible(unit, m.unit);
  const anyReported = [m.latest, m.prev, ...(Array.isArray(m.points) ? m.points : [])].some(
    (r: any) => r?.source_unit && !labUnitsCompatible(r.source_unit, unit)
  );
  if (!convertsUnit && !anyReported) return marker;
  const out: any = {
    ...m,
    unit,
    ...(convertsUnit ? { canonical_unit: m.unit } : {}),
    latest: presentReading(m.latest, label, unit, m.unit, system),
    prev: presentReading(m.prev, label, unit, m.unit, system),
  };
  if (Array.isArray(m.points)) out.points = m.points.map((p: any) => presentReading(p, label, unit, m.unit, system));
  if (m.optimal) out.optimal = presentBand(m.optimal, label, system);
  if (m.reference) out.reference = presentBand(m.reference, label, system);
  if (m.trend && typeof m.trend === "object") {
    out.trend = { ...m.trend };
    if (m.trend.change != null) out.trend.change = shownValue(label, m.trend.change, system, true);
    if (m.trend.slope_per_week != null)
      out.trend.slope_per_week = shownValue(label, m.trend.slope_per_week, system, true);
  }
  return out as T;
}

/**
 * One marker exactly as a document stored it ({ name, value, unit, ref_low, ref_high, … },
 * in the unit its lab printed) shown in the athlete's lab-unit system, with the printed
 * reading kept as `reported`. Anything that cannot convert safely — an unknown analyte, a
 * qualified "<5", Lp(a) across mass/molar — comes back unchanged.
 */
export function presentSourceMarker<T>(marker: T, system: LabUnitSystem = labUnitSystem()): T {
  const m = marker as any;
  if (!m || typeof m !== "object" || !m.unit) return marker;
  const label = unitAnalyteZone(String(m.name ?? ""))?.label ?? null;
  const target = displayUnitFor(label, system);
  if (!label || !target || labUnitsCompatible(m.unit, target)) return marker;
  if (typeof m.value === "string" && /^\s*[<>≤≥]/.test(m.value)) return marker;
  const shown = (v: unknown): number | null => {
    const n = parseLabNumber(v, m.unit);
    const canonical = n == null ? null : toCanonical(label, n, m.unit);
    const out = canonical == null ? null : fromCanonical(label, canonical, system);
    return out == null ? null : roundLabDisplay(out);
  };
  const value = shown(m.value);
  if (value == null) return marker;
  const out: any = { ...m, value, unit: target, reported: reportedText(m.value, m.unit) };
  if (m.ref_low != null && m.ref_low !== "") out.ref_low = shown(m.ref_low);
  if (m.ref_high != null && m.ref_high !== "") out.ref_high = shown(m.ref_high);
  return out as T;
}

/** A whole marker list ({ markers, … }) in the athlete's lab-unit system. */
export function presentMarkerList<T extends { markers?: unknown[] }>(
  list: T,
  system: LabUnitSystem = labUnitSystem()
): T {
  if (!list || !Array.isArray(list.markers)) return list;
  return { ...list, markers: list.markers.map((m) => presentMarkerRow(m, system)) };
}

/**
 * One lab value as words, always with its unit: "5.2 mmol/L". A recognized analyte in
 * its canonical unit is shown in the athlete's system; anything else exactly as given.
 */
export function labValueText(
  name: unknown,
  value: unknown,
  unit: unknown,
  system: LabUnitSystem = labUnitSystem()
): string {
  const raw = value == null ? "" : String(value).trim();
  const label = labAnalyteFor(name, unit);
  if (label) {
    const shown = shownValue(label, value, system);
    const shownUnit = displayUnitFor(label, system) ?? String(unit ?? "");
    return `${String(shown ?? raw).trim()}${shownUnit ? ` ${shownUnit}` : ""}`.trim();
  }
  const u = String(unit ?? "").trim();
  return `${raw}${raw && u ? ` ${u}` : ""}`.trim();
}

// ---------------------------------------------------------------------------
// Lab quantities inside stored PROSE (a directive's sentence).
//
// Stored prose is unit-neutral: it is written in each analyte's CANONICAL unit (the
// table's US conventional unit), never in the athlete's display system, so a unit switch
// never rewrites a stored row, never moves the directive engine's fingerprint and never
// mints a decision event. The athlete's system is applied when the row is READ
// (`renderLabQuantities`, directives-read.ts), the same way a marker row is presented.
//
// A quantity is "<number> <canonical unit>" ("0.8 mg/dL", "4.0 g/dL"). Its analyte is
// the row's own marker when that analyte's canonical unit matches, else the ONE analyte
// the sentence names whose canonical unit matches ("…your albumin sits below 4.0 g/dL");
// an ambiguous or unknown quantity is left exactly as written. Every quantity is read as
// a level: an offset analyte (HbA1c) is only ever written as a level in prose, and every
// other map is linear, so a step ("add ~0.8 mg/dL") converts the same way.
// ---------------------------------------------------------------------------

const CONVERTIBLE_LABELS = Object.keys(LAB_UNIT_TABLE).filter((label) => LAB_UNIT_TABLE[label].si);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// "%" is left out on purpose: prose says "~10%" about everything, and a percent is never
// unambiguously a lab level.
const PROSE_UNITS = [
  ...new Set(CONVERTIBLE_LABELS.map((label) => LAB_UNIT_TABLE[label].canonical).filter((u) => u !== "%")),
].sort((a, b) => b.length - a.length);

const LAB_QUANTITY_RE = new RegExp(
  `(?<![\\w.])(\\d+(?:\\.\\d+)?) (${PROSE_UNITS.map(escapeRegExp).join("|")})(?![\\w/])`,
  "g"
);

// Either system's spelling, for the neutral form below.
const ANY_LAB_QUANTITY_RE = new RegExp(
  `(?<![\\w.])\\d+(?:\\.\\d+)? (?:${[
    ...new Set(
      CONVERTIBLE_LABELS.flatMap((label) => [LAB_UNIT_TABLE[label].canonical, LAB_UNIT_TABLE[label].si?.unit ?? ""])
    ),
  ]
    .filter((u) => u && u !== "%")
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})(?![\\w/])`,
  "g"
);

/** The convertible analytes a row speaks about: its own marker(s) first, then any the sentence names. */
function proseAnalytes(text: string, marker: unknown): { own: string[]; named: string[] } {
  const own = String(marker ?? "")
    .split("+")
    .map((tok) => unitAnalyteZone(tok.replace(/^\s*(?:low|high|elevated|borderline|reduced|raised)\s+/i, ""))?.label)
    .map((label) => (label ? String(label).toLowerCase() : null))
    .filter((label): label is string => !!label && !!LAB_UNIT_TABLE[label]?.si);
  const lc = text.toLowerCase();
  const named = CONVERTIBLE_LABELS.filter((label) =>
    new RegExp(`(?<![a-z0-9])${escapeRegExp(label)}(?![a-z0-9])`).test(lc)
  );
  return { own, named };
}

/**
 * Stored prose (canonical units) with every recognizable lab quantity shown in the
 * athlete's system — `system` resolved ONCE by the caller for a whole list. US prose
 * (the canonical system) comes back untouched.
 */
export function renderLabQuantities(text: string, marker: unknown, system: LabUnitSystem): string;
export function renderLabQuantities(text: string | null, marker: unknown, system: LabUnitSystem): string | null;
export function renderLabQuantities(text: string | null, marker: unknown, system: LabUnitSystem): string | null {
  if (text == null || system !== "si") return text;
  LAB_QUANTITY_RE.lastIndex = 0;
  if (!LAB_QUANTITY_RE.test(text)) return text;
  const { own, named } = proseAnalytes(text, marker);
  return text.replace(LAB_QUANTITY_RE, (whole, num: string, unit: string) => {
    const fits = (label: string) => labUnitsCompatible(LAB_UNIT_TABLE[label].canonical, unit);
    const mine = own.filter(fits);
    const theirs = named.filter(fits);
    const label = mine.length === 1 ? mine[0] : !mine.length && theirs.length === 1 ? theirs[0] : null;
    if (!label) return whole;
    const shown = fromCanonical(label, Number(num), system);
    const shownUnit = displayUnitFor(label, system);
    if (shown == null || !shownUnit) return whole;
    return `${roundLabDisplay(shown)} ${shownUnit}`;
  });
}

/**
 * Prose with every lab quantity reduced to a placeholder — what a fingerprint of shown
 * text hashes, so the SAME sentence read in either system hashes the same.
 */
export function labQuantityNeutral(text: string | null | undefined): string {
  return String(text ?? "").replace(ANY_LAB_QUANTITY_RE, "#");
}

/** The system in words, for a heading or a prompt ("SI units (mmol/L, µmol/L, g/L)"). */
export function labUnitSystemWords(system: LabUnitSystem = labUnitSystem()): string {
  return system === "si" ? "SI units (mmol/L, µmol/L, g/L, nmol/L)" : "US conventional units (mg/dL, g/dL, ng/mL)";
}

/**
 * The line every prompt that carries lab values states, so the model never guesses
 * which system a number is in — and never converts a value Cairn did not.
 */
export function labUnitsPromptLine(system: LabUnitSystem = labUnitSystem()): string {
  return `LAB UNITS: every lab value in this prompt is in ${labUnitSystemWords(system)}, the system this athlete reads their labs in, and each value carries its unit. Write lab values in exactly these units, always with the unit, and never convert a number yourself. A reading's "reported" field is the value as its lab printed it in another unit — the same measurement, not a second reading. Lp(a) keeps the unit its lab printed: mg/dL and nmol/L measure it differently and must never be converted into each other.`;
}
