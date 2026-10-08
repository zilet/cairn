// Deterministic unit handling for lab markers. Agent extraction preserves the
// source value/unit; marker history normalizes recognized markers here before
// comparing them with Cairn's optimal-zone bands.

import { LB_PER_KG } from "./display-words.js";
export interface LabUnitZone {
  label?: string;
  unit?: string | null;
}

export interface NormalizedMarkerReading {
  value: number | string;
  unit: string | null;
  source_value?: number | string | null;
  source_unit?: string | null;
  unit_converted?: boolean;
  unit_mismatch?: boolean;
  expected_unit?: string | null;
}

export function parseLabNumber(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  // Accept common lab formatting: "<1.0", "3,2 mmol/L", "1,234.5".
  s = s.replace(/^[<>≤≥=~]\s*/, "").trim();
  const m = s.match(/[+-]?(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[.,]\d+)?|[+-]?[.,]\d+/);
  if (!m) return null;
  let n = m[0].replace(/\s/g, "");
  const hasDot = n.includes(".");
  const hasComma = n.includes(",");
  if (hasComma && !hasDot) {
    const parts = n.split(",");
    n = parts.length === 2 && parts[1].length <= 2 ? `${parts[0]}.${parts[1]}` : n.replace(/,/g, "");
  } else if (hasComma && hasDot) {
    n = n.replace(/,/g, "");
  }
  const out = Number(n);
  return Number.isFinite(out) ? out : null;
}

// One spelling per unit, so "µmol/L", "umol/l", "μmol / L" and UCUM's "umol/L" compare
// equal, and the count spellings ("10*9/L", "×10⁹/L", "x10e9/L") all read "10^9/l".
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

function normUnit(unit: unknown): string | null {
  if (unit === null || unit === undefined) return null;
  const raw = String(unit).trim();
  if (!raw) return null;
  return raw
    .replace(/[[\]]/g, "") // UCUM annotations: "[IU]/L", "m[IU]/mL"
    .replace(/[μµ]/g, "u")
    .replace(/mcg/gi, "ug")
    .replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_m, d: string) => `10^${[...d].map((c) => SUPERSCRIPT_DIGITS[c]).join("")}`)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUPERSCRIPT_DIGITS[c])
    .replace(/\s+/g, "")
    .replace(/10(?:\*|e|E)(\d+)/g, "10^$1")
    .replace(/^[x×*](?=10\^)/i, "")
    .replace(/per/gi, "/")
    .replace(/litre/gi, "l")
    .replace(/liter/gi, "l")
    .toLowerCase();
}

function sameUnit(a: unknown, b: unknown): boolean {
  const ua = normUnit(a);
  const ub = normUnit(b);
  if (!ua || !ub) return false;
  if (ua === ub) return true;
  const groups = [
    ["mg/dl"],
    ["mmol/l"],
    ["ng/ml", "ug/l"],
    ["pg/ml", "ng/l"],
    // Micro-units per millilitre ARE milli-units per litre (TSH, insulin)...
    ["uiu/ml", "miu/l", "mu/l", "uu/ml"],
    // ...and milli-units per millilitre are WHOLE units per litre (FSH, LH, enzymes) —
    // a thousand times the row above, so the two families never compare equal.
    ["u/l", "iu/l", "miu/ml", "mu/ml"],
    ["ml/min", "ml/min/1.73m2", "ml/min/1.73m^2"],
    ["mg/l"],
    ["nmol/l"],
    ["umol/l"],
    ["pmol/l"],
    ["%"],
    // 10^6/µL is exactly 10^12/L, and 10^3/µL exactly 10^9/L.
    ["m/ul", "million/ul", "10^6/ul", "10e6/ul", "x10^6/ul", "x10e6/ul", "10^12/l"],
    ["k/ul", "th/ul", "thou/ul", "thousand/ul", "10^3/ul", "10e3/ul", "x10^3/ul", "x10e3/ul", "10^9/l"],
    ["g/dl"],
    ["mcg/dl", "ug/dl"],
    ["pg"],
    ["fl"],
    ["bpm"],
    ["ms"],
    ["mmhg"],
    ["lb", "lbs", "pound", "pounds"],
    ["kg"],
    ["cm"],
    ["m"],
    ["in", "inch", "inches"],
  ];
  return groups.some((g) => g.includes(ua) && g.includes(ub));
}

function roundLabValue(n: number): number {
  const abs = Math.abs(n);
  const places = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

// ---------------------------------------------------------------------------
// The ONE conversion table.
//
// Every recognized analyte has ONE canonical unit — the unit its optimal band is written
// in (OPTIMAL_ZONES, propagation-data.ts; US conventional). Every comparison (optimal
// band, lab range, trend, dedupe agreement, directives) runs in that unit, so a reading
// from a lab on the other system is comparable the moment it is read. The table also
// names the analyte's SI unit, which is what a person who reads SI labs is SHOWN
// (`fromCanonical`, src/repo/lab-display.ts), and any other spelling a lab prints (`alt`).
//
// A map is linear: target = value × factor + offset. Factors are molar-mass based:
//   glucose mg/dL ÷ 18.016 = mmol/L; total/LDL/HDL/non-HDL cholesterol × 0.02586;
//   triglycerides × 0.01129; creatinine × 88.42 = µmol/L; vitamin D ng/mL × 2.496 =
//   nmol/L; testosterone ng/dL × 0.03467 = nmol/L; HbA1c IFCC mmol/mol = (% − 2.15) ×
//   10.929; ApoB mg/dL ÷ 100 = g/L; hemoglobin g/dL × 10 = g/L.
// Lp(a) is deliberately NOT convertible: mg/dL ↔ nmol/L has no fixed factor (the apo(a)
// isoform size changes the mass per particle), so a reading in the other unit is only
// ever LABELLED, never converted (`never`).
// ---------------------------------------------------------------------------

export type LabUnitSystem = "us" | "si";

export const LAB_UNIT_SYSTEMS: readonly LabUnitSystem[] = ["us", "si"];

interface LinearMap {
  factor: number;
  offset?: number;
}

export interface LabUnitSpec {
  /** The unit every comparison runs in — the optimal band's own unit (US conventional). */
  canonical: string;
  /** The SI unit and the canonical → SI map. Absent: both systems print the canonical unit. */
  si?: LinearMap & { unit: string };
  /** Other spellings a lab prints, each with its map INTO the canonical unit. */
  alt?: Array<LinearMap & { units: string[] }>;
  /** Units that measure the analyte on a scale with no fixed conversion (labelled, never converted). */
  never?: string[];
}

const LIPID_SI = { unit: "mmol/L", factor: 0.02586 };
const PROTEIN_SI = { unit: "g/L", factor: 10 };
const COUNT_SI = { unit: "×10⁹/L", factor: 1 };
const COUNT_ALT = [
  { units: ["g/l", "giga/l"], factor: 1 }, // "G/L" (giga per litre) on French/German counts
  { units: ["cells/ul", "cell/ul", "/ul"], factor: 0.001 },
];
const MEQ_ALT = [{ units: ["meq/l"], factor: 1 }]; // monovalent ions: mEq/L ≡ mmol/L
const ENZYME_ALT = [{ units: ["ukat/l"], factor: 60 }]; // 1 µkat/L = 60 U/L
const HBA1C_FACTOR = 10.929;

/** Keyed by the lowercased OPTIMAL_ZONES label. */
export const LAB_UNIT_TABLE: Readonly<Record<string, LabUnitSpec>> = {
  apob: { canonical: "mg/dL", si: { unit: "g/L", factor: 0.01 }, alt: [{ units: ["mg/l"], factor: 0.1 }] },
  "ldl-c": { canonical: "mg/dL", si: LIPID_SI },
  "hdl-c": { canonical: "mg/dL", si: LIPID_SI },
  "non-hdl-c": { canonical: "mg/dL", si: LIPID_SI },
  "total cholesterol": { canonical: "mg/dL", si: LIPID_SI },
  triglycerides: { canonical: "mg/dL", si: { unit: "mmol/L", factor: 0.01129 } },
  "fasting glucose": { canonical: "mg/dL", si: { unit: "mmol/L", factor: 1 / 18.016 } },
  hba1c: { canonical: "%", si: { unit: "mmol/mol", factor: HBA1C_FACTOR, offset: -2.15 * HBA1C_FACTOR } },
  "fasting insulin": { canonical: "uIU/mL", si: { unit: "mIU/L", factor: 1 }, alt: [{ units: ["pmol/l"], factor: 1 / 6 }] },
  creatinine: { canonical: "mg/dL", si: { unit: "µmol/L", factor: 88.42 } },
  bun: { canonical: "mg/dL", si: { unit: "mmol/L", factor: 0.357 } },
  "uric acid": { canonical: "mg/dL", si: { unit: "µmol/L", factor: 59.48 } },
  magnesium: { canonical: "mg/dL", si: { unit: "mmol/L", factor: 0.4114 } },
  calcium: { canonical: "mg/dL", si: { unit: "mmol/L", factor: 0.2495 } },
  "total bilirubin": { canonical: "mg/dL", si: { unit: "µmol/L", factor: 17.1 } },
  albumin: { canonical: "g/dL", si: PROTEIN_SI },
  "total protein": { canonical: "g/dL", si: PROTEIN_SI },
  globulin: { canonical: "g/dL", si: PROTEIN_SI },
  hemoglobin: { canonical: "g/dL", si: PROTEIN_SI, alt: [{ units: ["mmol/l"], factor: 1.611 }] },
  mchc: { canonical: "g/dL", si: PROTEIN_SI },
  hematocrit: { canonical: "%", alt: [{ units: ["l/l"], factor: 100 }] },
  "serum iron": { canonical: "mcg/dL", si: { unit: "µmol/L", factor: 0.1791 } },
  tibc: { canonical: "mcg/dL", si: { unit: "µmol/L", factor: 0.1791 } },
  transferrin: { canonical: "mg/dL", si: { unit: "g/L", factor: 0.01 } },
  ferritin: { canonical: "ng/mL", si: { unit: "µg/L", factor: 1 } },
  "vitamin d": { canonical: "ng/mL", si: { unit: "nmol/L", factor: 2.496 } },
  "vitamin b12": { canonical: "pg/mL", si: { unit: "pmol/L", factor: 0.738 } },
  folate: { canonical: "ng/mL", si: { unit: "nmol/L", factor: 2.266 } },
  testosterone: { canonical: "ng/dL", si: { unit: "nmol/L", factor: 0.03467 }, alt: [{ units: ["ng/ml"], factor: 100 }] },
  estradiol: { canonical: "pg/mL", si: { unit: "pmol/L", factor: 3.671 } },
  "free t3": { canonical: "pg/mL", si: { unit: "pmol/L", factor: 1.536 } },
  "free t4": { canonical: "ng/dL", si: { unit: "pmol/L", factor: 12.87 } },
  tsh: { canonical: "uIU/mL", si: { unit: "mIU/L", factor: 1 } },
  "morning cortisol": { canonical: "ug/dL", si: { unit: "nmol/L", factor: 27.59 } },
  "dhea-s": { canonical: "ug/dL", si: { unit: "µmol/L", factor: 0.02714 } },
  psa: { canonical: "ng/mL", si: { unit: "µg/L", factor: 1 } },
  "hs-crp": { canonical: "mg/L", alt: [{ units: ["mg/dl"], factor: 10 }] },
  alt: { canonical: "U/L", alt: ENZYME_ALT },
  ast: { canonical: "U/L", alt: ENZYME_ALT },
  ggt: { canonical: "U/L", alt: ENZYME_ALT },
  "alkaline phosphatase": { canonical: "U/L", alt: ENZYME_ALT },
  sodium: { canonical: "mmol/L", alt: MEQ_ALT },
  potassium: { canonical: "mmol/L", alt: MEQ_ALT },
  chloride: { canonical: "mmol/L", alt: MEQ_ALT },
  co2: { canonical: "mmol/L", alt: MEQ_ALT },
  "anion gap": { canonical: "mmol/L", alt: MEQ_ALT },
  rbc: { canonical: "M/uL", si: { unit: "×10¹²/L", factor: 1 }, alt: [{ units: ["t/l", "tera/l"], factor: 1 }] },
  wbc: { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  platelets: { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute neutrophils": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute lymphocytes": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute monocytes": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute eosinophils": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute basophils": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute immature granulocytes": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  "absolute nrbc": { canonical: "K/uL", si: COUNT_SI, alt: COUNT_ALT },
  // Lp(a): nmol/L (particle count) is the band's unit; a mass reading (mg/dL, mg/L) is
  // a different measure with no fixed factor — kept as reported, flagged, never converted.
  "lp(a)": { canonical: "nmol/L", never: ["mg/dl", "mg/l"] },
};

/** The conversion spec for an analyte (its OPTIMAL_ZONES label), or null when unknown. */
export function labUnitSpec(label: string | null | undefined): LabUnitSpec | null {
  if (!label) return null;
  return LAB_UNIT_TABLE[String(label).toLowerCase()] ?? null;
}

function applyMap(value: number, map: LinearMap): number {
  return value * map.factor + (map.offset ?? 0);
}

/**
 * A value in `fromUnit` brought into the analyte's canonical unit, or null when the unit
 * is not one this analyte converts from (unknown, or a `never` scale like Lp(a) mg/dL).
 * Unrounded — callers round for storage/display.
 */
export function toCanonical(label: string | null | undefined, value: number, fromUnit: unknown): number | null {
  const spec = labUnitSpec(label);
  if (!spec || !Number.isFinite(value)) return null;
  const from = normUnit(fromUnit);
  if (!from) return null;
  if (spec.never?.some((u) => sameUnit(u, from))) return null;
  if (sameUnit(from, spec.canonical)) return value;
  if (spec.si && sameUnit(from, spec.si.unit)) return (value - (spec.si.offset ?? 0)) / spec.si.factor;
  for (const alt of spec.alt ?? []) {
    if (alt.units.some((u) => sameUnit(u, from))) return applyMap(value, alt);
  }
  return null;
}

/** The unit an analyte is SHOWN in under a unit system (the canonical unit when the system has no other). */
export function displayUnitFor(label: string | null | undefined, system: LabUnitSystem): string | null {
  const spec = labUnitSpec(label);
  if (!spec) return null;
  return system === "si" && spec.si ? spec.si.unit : spec.canonical;
}

/**
 * A canonical value in the display unit of `system`. A delta (a trend's change, a weekly
 * slope) scales by the factor alone — an offset (HbA1c's IFCC map) never applies to a
 * difference. Unrounded.
 */
export function fromCanonical(
  label: string | null | undefined,
  value: number,
  system: LabUnitSystem,
  opts: { delta?: boolean } = {}
): number | null {
  const spec = labUnitSpec(label);
  if (!spec || !Number.isFinite(value)) return null;
  if (system !== "si" || !spec.si) return value;
  return opts.delta ? value * spec.si.factor : applyMap(value, spec.si);
}

function convertByZone(value: number, fromUnit: string | null, zone: LabUnitZone): { value: number; converted: boolean } | null {
  const expected = zone.unit ?? null;
  const from = normUnit(fromUnit);
  const to = normUnit(expected);
  if (!to) return { value, converted: false };
  if (!from) return { value, converted: false };
  if (sameUnit(from, to)) return { value, converted: from !== to };
  const spec = labUnitSpec(zone.label);
  // The table's canonical unit must BE the band's unit, or its maps point somewhere else.
  if (!spec || !sameUnit(spec.canonical, expected)) return null;
  const canonical = toCanonical(zone.label, value, from);
  return canonical == null ? null : { value: canonical, converted: true };
}

function isBodyWeightName(name: string): boolean {
  return /\bbody weight\b|^weight$|\btotal (?:body )?mass\b/i.test(name);
}

function isHeightName(name: string): boolean {
  return /^height$|\bstature\b/i.test(name);
}

function normalizeAnthropometricReading(name: string, numeric: number, value: unknown, unit: string | null): NormalizedMarkerReading | null {
  const from = normUnit(unit);
  const sourceValue = typeof value === "number" ? value : String(value ?? "").trim();

  if (isBodyWeightName(name)) {
    if (!from || sameUnit(from, "lb")) return { value: numeric, unit: "lb" };
    if (sameUnit(from, "kg")) {
      return {
        value: roundLabValue(numeric * LB_PER_KG),
        unit: "lb",
        source_value: sourceValue,
        source_unit: unit,
        unit_converted: true,
      };
    }
    return { value: numeric, unit, unit_mismatch: true, expected_unit: "lb", source_value: sourceValue, source_unit: unit };
  }

  if (isHeightName(name)) {
    if (!from || sameUnit(from, "cm")) return { value: numeric, unit: "cm" };
    if (sameUnit(from, "m")) {
      return {
        value: roundLabValue(numeric * 100),
        unit: "cm",
        source_value: sourceValue,
        source_unit: unit,
        unit_converted: true,
      };
    }
    if (sameUnit(from, "in")) {
      return {
        value: roundLabValue(numeric * 2.54),
        unit: "cm",
        source_value: sourceValue,
        source_unit: unit,
        unit_converted: true,
      };
    }
    return { value: numeric, unit, unit_mismatch: true, expected_unit: "cm", source_value: sourceValue, source_unit: unit };
  }

  return null;
}

export function normalizeMarkerReading(
  name: string,
  value: unknown,
  unit: string | null,
  zone: LabUnitZone | null,
): NormalizedMarkerReading | null {
  const textValue = value === null || value === undefined ? "" : String(value).trim();
  const numeric = parseLabNumber(value);
  if (numeric === null) {
    if (!textValue) return null;
    return { value: textValue, unit };
  }

  const anthropometric = normalizeAnthropometricReading(name, numeric, value, unit);
  if (anthropometric) return anthropometric;

  const expectedUnit = zone?.unit ?? null;
  if (!zone || !expectedUnit) return { value: numeric, unit };

  const converted = convertByZone(numeric, unit, zone);
  if (!converted) {
    return {
      value: numeric,
      unit,
      unit_mismatch: !!unit,
      expected_unit: expectedUnit,
      source_value: typeof value === "number" ? value : textValue,
      source_unit: unit,
    };
  }

  const outValue = roundLabValue(converted.value);
  const unitChanged = converted.converted || (!!unit && !sameUnit(unit, expectedUnit));
  return {
    value: outValue,
    unit: expectedUnit,
    ...(unitChanged ? {
      source_value: typeof value === "number" ? value : textValue,
      source_unit: unit,
      unit_converted: true,
    } : {}),
  };
}

export function seriesUnitsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return sameUnit(a, b);
}

export function normalizeLabUnit(unit: unknown): string | null {
  return normUnit(unit);
}

export function labUnitsCompatible(a: unknown, b: unknown): boolean {
  return sameUnit(a, b);
}
