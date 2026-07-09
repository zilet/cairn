// DEXA canon — the single home for how a DEXA scan's analytes are RECOGNIZED and
// read into a structured numeric shape. A modern DEXA reports far more than one
// body-fat number: regional fat % and lean mass (trunk/arms/legs), visceral fat,
// ALMI/FFMI, and bone density with T/Z-scores. The recognition regexes and the
// canonical `DexaRegional` shape used to live inline in standing.ts and were mirrored
// again in dexa-targeting.ts; both now import from here so the parsing can't drift.
//
// Pure + presentation-free: this extracts NUMBERS only (the plain-language, tone-
// tagged notes stay with the standing read that renders them). Informational reads;
// T/Z-scores and ALMI/FFMI are recognized reference reads, never a Cairn-invented score.

// The regional DEXA read as a structured numeric object. `notes` (optional) carries
// the standing read's plain-language interpretation when present.
export interface DexaRegional {
  visceral_fat_lbs: number | null;
  almi: number | null;
  ffmi: number | null;
  bmd_total: number | null;
  t_score: number | null;
  z_score: number | null;
  android_gynoid: number | null;
  fat: { trunk: number | null; arms: number | null; legs: number | null };
  lean: { trunk: number | null; arms: number | null; legs: number | null };
  notes?: any[];
}

// The recognition regexes for each DEXA analyte — one canonical table.
export const DEXA_MARKER_RES = {
  visceral_fat: /visceral fat/i,
  almi: /\balmi\b|appendicular lean mass index/i,
  ffmi: /\bffmi\b|fat[\s-]?free mass index/i,
  bmd_total: /bmd[\s-]*total body|total body bmd/i,
  t_score: /^t[\s-]?score\b/i,
  z_score: /^z[\s-]?score\b/i,
  android_gynoid: /android\/gynoid|a\/g ratio/i,
  fat_trunk: /body fat[\s-]*trunk/i,
  fat_arms: /body fat[\s-]*arms/i,
  fat_legs: /body fat[\s-]*legs/i,
  lean_trunk: /lean mass[\s-]*trunk/i,
  lean_arms: /lean mass[\s-]*arms/i,
  lean_legs: /lean mass[\s-]*legs/i,
} as const;

// Plausible ranges, paired with each regex, so a mis-parsed value is dropped.
type MarkerNumber = (re: RegExp, min: number, max: number) => number | null;

// Extract the numeric regional read from a marker set, given the caller's marker-
// number accessor (findMarker → latestNumber → plausibleNumber composed). Behavior-
// preserving move of standing.ts's inline extraction; ranges unchanged.
export function parseDexaRegional(num: MarkerNumber): Omit<DexaRegional, "notes"> {
  return {
    visceral_fat_lbs: num(DEXA_MARKER_RES.visceral_fat, 0, 25),
    almi: num(DEXA_MARKER_RES.almi, 3, 20),
    ffmi: num(DEXA_MARKER_RES.ffmi, 10, 40),
    bmd_total: num(DEXA_MARKER_RES.bmd_total, 0.4, 2.5),
    t_score: num(DEXA_MARKER_RES.t_score, -6, 6),
    z_score: num(DEXA_MARKER_RES.z_score, -6, 6),
    android_gynoid: num(DEXA_MARKER_RES.android_gynoid, 0.3, 2.5),
    fat: {
      trunk: num(DEXA_MARKER_RES.fat_trunk, 3, 70),
      arms: num(DEXA_MARKER_RES.fat_arms, 3, 70),
      legs: num(DEXA_MARKER_RES.fat_legs, 3, 70),
    },
    lean: {
      trunk: num(DEXA_MARKER_RES.lean_trunk, 5, 160),
      arms: num(DEXA_MARKER_RES.lean_arms, 2, 90),
      legs: num(DEXA_MARKER_RES.lean_legs, 5, 160),
    },
  };
}
