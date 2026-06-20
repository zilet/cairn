// Deterministic unit handling for lab markers. Agent extraction preserves the
// source value/unit; marker history normalizes recognized markers here before
// comparing them with Cairn's optimal-zone bands.

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

function normUnit(unit: unknown): string | null {
  if (unit === null || unit === undefined) return null;
  const raw = String(unit).trim();
  if (!raw) return null;
  return raw
    .replace(/[μµ]/g, "u")
    .replace(/\u00b3/g, "3")
    .replace(/\u00b2/g, "2")
    .replace(/\s+/g, "")
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
    ["uiu/ml", "miu/l", "mu/l"],
    ["u/l", "iu/l"],
    ["ml/min", "ml/min/1.73m2", "ml/min/1.73m^2"],
    ["mg/l"],
    ["nmol/l"],
    ["umol/l"],
    ["pmol/l"],
    ["%"],
    ["bpm"],
    ["ms"],
    ["mmhg"],
  ];
  return groups.some((g) => g.includes(ua) && g.includes(ub));
}

function roundLabValue(n: number): number {
  const abs = Math.abs(n);
  const places = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

function convertByZone(value: number, fromUnit: string | null, zone: LabUnitZone): { value: number; converted: boolean } | null {
  const label = String(zone.label ?? "").toLowerCase();
  const expected = zone.unit ?? null;
  const from = normUnit(fromUnit);
  const to = normUnit(expected);
  if (!to) return { value, converted: false };
  if (!from) return { value, converted: false };
  if (sameUnit(from, to)) return { value, converted: from !== to };

  const mgDl = ["apob", "ldl-c", "non-hdl-c", "hdl-c", "triglycerides", "fasting glucose", "creatinine", "magnesium", "uric acid"];
  if (mgDl.includes(label) && to !== "mg/dl") return null;

  if (label === "apob") {
    if (from === "g/l") return { value: value * 100, converted: true };
    if (from === "mg/l") return { value: value / 10, converted: true };
  }
  if (["ldl-c", "non-hdl-c", "hdl-c"].includes(label) && from === "mmol/l") {
    return { value: value * 38.67, converted: true };
  }
  if (label === "triglycerides" && from === "mmol/l") return { value: value * 88.57, converted: true };
  if (label === "fasting glucose" && from === "mmol/l") return { value: value * 18.0182, converted: true };
  if (label === "creatinine" && from === "umol/l") return { value: value / 88.4, converted: true };
  if (label === "magnesium" && from === "mmol/l") return { value: value / 0.4114, converted: true };
  if (label === "uric acid" && from === "umol/l") return { value: value / 59.48, converted: true };

  if (label === "vitamin d") {
    if (from === "nmol/l") return { value: value * 0.4, converted: true };
    if (sameUnit(from, "ug/l")) return { value, converted: true };
  }
  if (label === "free t3" && from === "pmol/l") return { value: value / 1.536, converted: true };
  if (label === "free t4" && from === "pmol/l") return { value: value / 12.87, converted: true };
  if (label === "vitamin b12" && from === "pmol/l") return { value: value / 0.738, converted: true };
  if (label === "folate" && from === "nmol/l") return { value: value / 2.266, converted: true };
  if (label === "testosterone") {
    if (from === "nmol/l") return { value: value / 0.0347, converted: true };
    if (from === "ng/ml") return { value: value * 100, converted: true };
  }
  if (label === "estradiol" && from === "pmol/l") return { value: value / 3.671, converted: true };
  if (label === "hs-crp" && from === "mg/dl") return { value: value * 10, converted: true };
  if (["alt", "ast", "ggt"].includes(label) && from === "ukat/l") return { value: value * 60, converted: true };
  if (["tsh", "fasting insulin"].includes(label) && sameUnit(from, expected)) {
    return { value, converted: from !== to };
  }
  // Lp(a) is intentionally absent: mg/dL<->nmol/L has no reliable fixed
  // conversion because apo(a) isoform size changes the particle-to-mass ratio.
  return null;
}

export function normalizeMarkerReading(
  _name: string,
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
