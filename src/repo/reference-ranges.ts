import { labUnitsCompatible, normalizeLabUnit } from "./lab-units.js";
import { normalizeMarkerName } from "./marker-canon.js";

export interface ClinicalReferenceRangeMatch {
  low: number | null;
  high: number | null;
  source: string;
  source_url: string;
}

type ProfileLike = { sex?: string | null; age?: number | null } | null | undefined;

interface ClinicalReferenceRange extends ClinicalReferenceRangeMatch {
  keys: string[];
  unit: string | null;
  sex?: "male" | "female";
  minAge?: number;
  maxAge?: number;
}

// Conservative fallback ranges used ONLY when the uploaded lab did not provide a
// reference interval. These are not Cairn "optimal" targets and do not drive
// directives; they are display/interpretation context for standard measurements.
const CLINICAL_REFERENCE_RANGES: ClinicalReferenceRange[] = [
  {
    keys: ["amylase"],
    unit: "U/L",
    low: 40,
    high: 140,
    source: "MedlinePlus Amylase - blood",
    source_url: "https://medlineplus.gov/ency/article/003464.htm",
  },
  {
    keys: ["lipase"],
    unit: "U/L",
    low: 0,
    high: 160,
    source: "MedlinePlus Lipase test",
    source_url: "https://medlineplus.gov/ency/article/003465.htm",
  },
  {
    keys: ["vldl cholesterol", "vldl chol", "vldl"],
    unit: "mg/dL",
    low: 2,
    high: 30,
    source: "MedlinePlus VLDL test",
    source_url: "https://medlineplus.gov/ency/article/003494.htm",
  },
  {
    keys: ["luteinizing hormone lh", "luteinizing hormone", "lh"],
    unit: "IU/L",
    low: 1.8,
    high: 8.6,
    sex: "male",
    minAge: 18,
    source: "MedlinePlus LH blood test",
    source_url: "https://medlineplus.gov/ency/article/003708.htm",
  },
  {
    keys: ["follicle stimulating hormone fsh", "follicle stimulating hormone", "fsh"],
    unit: "mIU/mL",
    low: 1.5,
    high: 12.4,
    sex: "male",
    minAge: 18,
    source: "MedlinePlus FSH blood test",
    source_url: "https://medlineplus.gov/ency/article/003710.htm",
  },
  {
    keys: ["prolactin"],
    unit: "ng/mL",
    low: null,
    high: 20,
    sex: "male",
    minAge: 18,
    source: "MedlinePlus Prolactin blood test",
    source_url: "https://medlineplus.gov/ency/article/003718.htm",
  },
  {
    keys: ["zinc", "zinc serum", "zinc plasma", "zinc serum or plasma"],
    unit: "ug/dL",
    low: 44,
    high: 115,
    minAge: 1,
    source: "Labcorp Zinc, Serum or Plasma",
    source_url: "https://www.labcorp.com/tests/001800/zinc-serum-or-plasma",
  },
  {
    keys: ["methylmalonic acid mma", "methylmalonic acid", "mma"],
    unit: "nmol/L",
    low: 0,
    high: 378,
    source: "Labcorp Methylmalonic Acid, Serum or Plasma",
    source_url: "https://www.labcorp.com/tests/706961/methylmalonic-acid-serum-or-plasma",
  },
  {
    keys: ["sex hormone binding globulin shbg", "sex hormone binding globulin", "shbg"],
    unit: "nmol/L",
    low: 16.5,
    high: 55.9,
    sex: "male",
    minAge: 20,
    maxAge: 49,
    source: "Labcorp Sex Hormone-binding Globulin",
    source_url: "https://www.labcorp.com/tests/082016/sex-hormone-binding-globulin",
  },
  {
    keys: ["sex hormone binding globulin shbg", "sex hormone binding globulin", "shbg"],
    unit: "nmol/L",
    low: 19.3,
    high: 76.4,
    sex: "male",
    minAge: 50,
    source: "Labcorp Sex Hormone-binding Globulin",
    source_url: "https://www.labcorp.com/tests/082016/sex-hormone-binding-globulin",
  },
  {
    keys: ["thyroxine t4 free", "thyroxine free", "free thyroxine", "free t4", "t4 free", "ft4"],
    unit: "ng/dL",
    low: 0.82,
    high: 1.77,
    minAge: 20,
    source: "Labcorp Thyroxine (T4), Free, Direct",
    source_url: "https://www.labcorp.com/tests/001974/thyroxine-t4-free-direct",
  },
  {
    keys: ["triiodothyronine t3 free", "triiodothyronine free", "free triiodothyronine", "free t3", "t3 free", "ft3"],
    unit: "pg/mL",
    low: 2,
    high: 4.4,
    minAge: 20,
    source: "Labcorp Triiodothyronine (T3), Free",
    source_url: "https://www.labcorp.com/tests/010389/triiodothyronine-t3-free",
  },
  {
    keys: ["ph urine", "urine ph", "p h urine", "p h"],
    unit: null,
    low: 4.6,
    high: 8,
    source: "MedlinePlus Urine pH test",
    source_url: "https://medlineplus.gov/ency/article/003583.htm",
  },
  {
    keys: ["specific gravity urine", "urine specific gravity", "specific gravity"],
    unit: null,
    low: 1.005,
    high: 1.03,
    source: "MedlinePlus Urine specific gravity test",
    source_url: "https://medlineplus.gov/ency/article/003587.htm",
  },
];

function sexMatches(entry: ClinicalReferenceRange, profile: ProfileLike): boolean {
  if (!entry.sex) return true;
  return String(profile?.sex ?? "").trim().toLowerCase() === entry.sex;
}

function ageMatches(entry: ClinicalReferenceRange, profile: ProfileLike): boolean {
  const age = Number(profile?.age);
  if (!Number.isFinite(age)) return entry.minAge == null && entry.maxAge == null;
  if (entry.minAge != null && age < entry.minAge) return false;
  if (entry.maxAge != null && age > entry.maxAge) return false;
  return true;
}

function unitMatches(entry: ClinicalReferenceRange, unit: string | null | undefined): boolean {
  if (!entry.unit) {
    const u = normalizeLabUnit(unit);
    return !u || u === "ph" || u === "ratio" || u === "index";
  }
  return labUnitsCompatible(unit, entry.unit);
}

function keyMatches(name: string, key: string): boolean {
  if (name === key) return true;
  if (key.length <= 4) return new RegExp(`(^|\\s)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(name);
  return name.includes(key);
}

export function matchClinicalReferenceRange(name: string, unit: string | null | undefined, profile?: ProfileLike): ClinicalReferenceRangeMatch | null {
  const normalized = normalizeMarkerName(name);
  if (!normalized) return null;
  let best: ClinicalReferenceRange | null = null;
  let bestLen = 0;
  for (const entry of CLINICAL_REFERENCE_RANGES) {
    if (!sexMatches(entry, profile) || !ageMatches(entry, profile) || !unitMatches(entry, unit)) continue;
    for (const key of entry.keys) {
      const normalizedKey = normalizeMarkerName(key);
      if (!normalizedKey || !keyMatches(normalized, normalizedKey)) continue;
      if (normalizedKey.length > bestLen) {
        best = entry;
        bestLen = normalizedKey.length;
      }
    }
  }
  return best ? { low: best.low, high: best.high, source: best.source, source_url: best.source_url } : null;
}
