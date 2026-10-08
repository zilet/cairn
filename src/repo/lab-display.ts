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
  normalizeLabUnit,
  parseLabNumber,
  toCanonical,
} from "./lab-units.js";
import { OPTIMAL_ZONES, unitAnalyteZone } from "./propagation-data.js";
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
 * One canonical reading as a {value, unit} pair in the athlete's system, for a structured
 * field a person or a prompt reads (symptom links). An unrecognized analyte, a non-numeric
 * value or a unit that is not the analyte's canonical one comes back exactly as given.
 */
export function presentLabReading<V>(
  name: unknown,
  value: V,
  unit: string | null,
  system: LabUnitSystem = labUnitSystem()
): { value: V | number; unit: string | null } {
  const label = labAnalyteFor(name, unit);
  if (!label) return { value, unit };
  return { value: shownValue(label, value, system) as V | number, unit: displayUnitFor(label, system) ?? unit };
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
// Lab quantities inside stored PROSE (a directive's sentence, a health read).
//
// Cairn's own prose is unit-neutral: it is written in each analyte's CANONICAL unit (the
// table's US conventional unit), never in the athlete's display system, so a unit switch
// never rewrites a stored row, never moves the directive engine's fingerprint and never
// mints a decision event. An agent's prose (a health_review directive, the health
// synthesis) is written in the system the athlete read at the time. Either way the
// athlete's CURRENT system is applied when the text is READ (`renderLabQuantities`), the
// same way a marker row is presented: a canonical quantity shows in SI for an SI reader,
// an SI quantity in canonical units for a US reader, and one already in the reader's unit
// stays exactly as written.
//
// A quantity is "<number> <unit>" ("0.8 mg/dL", "4.0 mmol/L") or a joined pair of numbers
// ahead of one unit ("70-100 mg/dL", "70 to 100 mg/dL", "between 70 and 100 mg/dL",
// "160 → 130 mg/dL") — BOTH numbers convert, or the whole quantity stays as written. A
// bare number tied to a quantity some other way ("160 down to 130 mg/dL", "130 mg/dL, from
// 160") leaves the quantity as written, so a sentence never mixes the two systems.
//
// Its analyte (strict — when in doubt the quantity stays as written):
//   1. An analyte named right AFTER it ("0.8 mg/dL to the calcium", "1 g/dL your
//      albumin") is its subject.
//   2. Else the NEAREST PRECEDING analyte the sentence names — any analyte the optimal
//      zones know, Lp(a) and the non-converting ones included, so "Lp(a) 75 mg/dL" never
//      converts by an LDL named earlier. A parenthetical aside that closed before the
//      quantity is not the subject ("ApoB (the particle count behind LDL) is 120 mg/dL"
//      is ApoB). Two different analytes joined only by "and"/"or"/a comma ("calcium and
//      creatinine near 9 mg/dL") are ambiguous.
//   3. Else, with nothing named before it, the ONE analyte the whole sentence and the
//      row's own marker speak of — any second analyte makes it ambiguous.
// The subject converts only when the quantity is in its canonical or SI unit. HbA1c's map
// is affine, so a step written in prose would not convert like a level — it is never
// converted in prose (nor is "%", which prose uses for everything).
// ---------------------------------------------------------------------------

/** Analytes whose quantities convert in prose: a linear SI map. */
const PROSE_LABELS = Object.keys(LAB_UNIT_TABLE).filter((label) => {
  const spec = LAB_UNIT_TABLE[label];
  return !!spec.si && !spec.si.offset;
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// A unit as a pattern: any micro sign ("µmol/L", "μmol/L", "umol/L") reads the same.
function unitPattern(unit: string): string {
  return escapeRegExp(unit).replace(/µ/g, "[µμu]").replace(/^u/, "[uµμ]");
}

function unitsPattern(units: string[]): string {
  return [...new Set(units.filter((u) => u && u !== "%"))]
    .sort((a, b) => b.length - a.length)
    .map(unitPattern)
    .join("|");
}

const PROSE_UNITS_RE = unitsPattern(
  PROSE_LABELS.flatMap((label) => [LAB_UNIT_TABLE[label].canonical, LAB_UNIT_TABLE[label].si?.unit ?? ""])
);

// Between the two numbers of a pair: "70-100", "70–100", "160 → 130", "70 to 100", and
// "and" (only after "between", checked where it matches).
const PAIR_JOIN = "\\s*(?:[-\\u2013\\u2014\\u2192\\u21d2]|->|=>)\\s*|\\s+(?:to|and)\\s+";
const LAB_QUANTITY_RE = new RegExp(
  `(?<![\\w.])(\\d+(?:\\.\\d+)?)(?:(${PAIR_JOIN})(\\d+(?:\\.\\d+)?))? (${PROSE_UNITS_RE})(?![\\w/])`,
  "g"
);

// Either system's spelling, for the neutral form below.
const RANGE_JOIN = "(?:\\s*(?:[-\\u2013\\u2014\\u2192\\u21d2]|->|=>)\\s*|\\s+to\\s+)";
const ANY_LAB_QUANTITY_RE = new RegExp(
  `(?<![\\w.])\\d+(?:\\.\\d+)?(?:${RANGE_JOIN}\\d+(?:\\.\\d+)?)? (?:${unitsPattern(
    Object.keys(LAB_UNIT_TABLE)
      .filter((label) => LAB_UNIT_TABLE[label].si)
      .flatMap((label) => [LAB_UNIT_TABLE[label].canonical, LAB_UNIT_TABLE[label].si?.unit ?? ""])
  )})(?![\\w/])`,
  "g"
);

// A bare number tied to the quantity in a way the pair above does not cover.
const BARE_LINK = "(?:[-\\u2013\\u2014\\u2192\\u21d2]|->|=>|(?:(?:down|up|back|then|now)\\s+)?(?:to|from)|and|or|vs\\.?|versus)";
const BARE_BEFORE_RE = new RegExp(`(?<![\\w.])\\d+(?:\\.\\d+)?,?\\s*${BARE_LINK}\\s*$`, "i");
const BARE_AFTER_RE = new RegExp(`^,?\\s*\\(?${BARE_LINK}\\s*(\\d+(?:\\.\\d+)?)(?!\\.?\\d)`, "i");
const UNIT_AHEAD_RE = new RegExp(`^\\s?(?:${PROSE_UNITS_RE}|%|${unitsPattern(
  Object.values(LAB_UNIT_TABLE).flatMap((spec) => [spec.canonical, spec.si?.unit ?? "", ...(spec.alt ?? []).flatMap((a) => a.units)])
)})(?![\\w])`, "i");

// What a sentence can call an analyte: every optimal zone's label and the marker-name keys
// it matches by ("ldl", "triglyceride", "25-oh", "lp(a)", …) — converting or not.
const MENTION_LABEL = new Map<string, string>();
for (const zone of OPTIMAL_ZONES) {
  const label = String(zone.label ?? "").toLowerCase();
  if (!label) continue;
  for (const term of [label, ...zone.keys]) if (term.length >= 3) MENTION_LABEL.set(term.toLowerCase(), label);
}
const MENTION_RE = new RegExp(
  `(?<![a-z0-9])(?:${[...MENTION_LABEL.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})(?![a-z0-9])`,
  "gi"
);

interface Mention {
  label: string;
  start: number;
  end: number;
  /** Inside a parenthetical that closes at this index (an aside once the quantity is past it). */
  asideUntil: number | null;
}

function proseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const label = MENTION_LABEL.get(m[0].toLowerCase());
    if (label && m.index != null) out.push({ label, start: m.index, end: m.index + m[0].length, asideUntil: null });
  }
  // Parenthetical groups, ignoring the parentheses inside a name ("Lp(a)", "25(OH)D").
  const inName = (i: number) => out.some((m) => i >= m.start && i < m.end);
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (inName(i)) continue;
    if (text[i] === "(") open.push(i);
    else if (text[i] === ")" && open.length) {
      const from = open.pop() as number;
      for (const m of out) if (m.start > from && m.end <= i && m.asideUntil == null) m.asideUntil = i;
    }
  }
  return out;
}

// Only a conjunction or punctuation between two mentions: "calcium and creatinine".
const JOINED_RE = /^[\s,;/&+]*(?:and|or|&|\+|\/)?[\s,;]*$/i;
// An analyte named right after a quantity: "0.8 mg/dL to the calcium", "1 g/dL your albumin".
const FOLLOWING_RE = /^\s+(?:(?:of|to|in|for|on)\s+)?(?:(?:the|your)\s+)?/i;

function ownAnalytes(marker: unknown): string[] {
  return String(marker ?? "")
    .split("+")
    .map((tok) => unitAnalyteZone(tok.replace(/^\s*(?:low|high|elevated|borderline|reduced|raised)\s+/i, ""))?.label)
    .map((label) => (label ? String(label).toLowerCase() : null))
    .filter((label): label is string => !!label);
}

/** The analyte a quantity at [at, end) belongs to, or null when that is not certain. */
function proseSubject(text: string, at: number, end: number, mentions: Mention[], own: string[]): string | null {
  const lead = text.slice(end).match(FOLLOWING_RE);
  const following = lead ? mentions.find((m) => m.start === end + lead[0].length) : undefined;
  if (following) return following.label;
  const before = mentions.filter((m) => m.end <= at && (m.asideUntil == null || m.asideUntil > at));
  if (before.length) {
    const near = before[before.length - 1];
    const prev = before[before.length - 2];
    const joined = !!prev && prev.label !== near.label && JOINED_RE.test(text.slice(prev.end, near.start));
    return joined ? null : near.label;
  }
  const named = [...new Set([...mentions.map((m) => m.label), ...own])];
  return named.length === 1 ? named[0] : null;
}

/**
 * Stored prose with every lab quantity it can attribute for certain shown in the
 * athlete's system — `system` resolved ONCE by the caller for a whole list. A quantity
 * already in the reader's unit, or one whose analyte is not certain, stays as written.
 */
export function renderLabQuantities(text: string, marker: unknown, system: LabUnitSystem): string;
export function renderLabQuantities(text: string | null, marker: unknown, system: LabUnitSystem): string | null;
export function renderLabQuantities(text: string | null, marker: unknown, system: LabUnitSystem): string | null {
  if (text == null) return text;
  LAB_QUANTITY_RE.lastIndex = 0;
  if (!LAB_QUANTITY_RE.test(text)) return text;
  const mentions = proseMentions(text);
  const own = ownAnalytes(marker);
  return text.replace(
    LAB_QUANTITY_RE,
    (whole: string, lo: string, join: string | undefined, hi: string | undefined, unit: string, at: number) => {
      const end = at + whole.length;
      if (join && /^\s+and\s+$/i.test(join) && !/\bbetween\s+$/i.test(text.slice(0, at))) return whole;
      if (BARE_BEFORE_RE.test(text.slice(0, at))) return whole;
      const after = text.slice(end).match(BARE_AFTER_RE);
      if (after && !UNIT_AHEAD_RE.test(text.slice(end + after[0].length))) return whole;
      const label = proseSubject(text, at, end, mentions, own);
      const spec = label && PROSE_LABELS.includes(label) ? LAB_UNIT_TABLE[label] : null;
      const shownUnit = label ? displayUnitFor(label, system) : null;
      // Spelled in the reader's unit already: as written ("50 ng/mL" is relabelled "50 µg/L").
      if (!label || !spec?.si || !shownUnit || normalizeLabUnit(unit) === normalizeLabUnit(shownUnit)) return whole;
      const fromUnit = labUnitsCompatible(unit, spec.canonical)
        ? spec.canonical
        : labUnitsCompatible(unit, spec.si.unit)
          ? spec.si.unit
          : null;
      if (!fromUnit) return whole;
      const one = (n: string): string | null => {
        const canonical = toCanonical(label, Number(n), fromUnit);
        const v = canonical == null ? null : fromCanonical(label, canonical, system);
        return v == null ? null : String(roundLabDisplay(v));
      };
      const a = one(lo);
      const b = hi == null ? null : one(hi);
      if (a == null || (hi != null && b == null)) return whole;
      return `${hi == null ? a : `${a}${join}${b}`} ${shownUnit}`;
    }
  );
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
