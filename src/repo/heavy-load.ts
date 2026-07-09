// Single source of truth for training "heavy / hard" load thresholds — the tuning
// knobs that decide how much a session or an endurance effort actually loaded the
// body. Both the day-grade reader (training-read.cardioEffort, which grades a whole
// day easy/moderate/hard for the earned-rest count) and the per-muscle hybrid-load
// reader pull their thresholds from here, so "heavy" can never drift between the two.
//
// Runtime-dependency-free (the only import is a type, erased at build): keeps
// training-read a leaf module.
import type { MuscleGroup } from "./exercise-canon.js";

// A logged strength effort counts as a heavy dose on a muscle at this many sets.
export const HEAVY_SETS = 4;

// Per-modality endurance thresholds: at/above these a real effort has loaded the
// listed prime movers heavily (a long/hard run fatigues legs + trunk; a casual walk
// does not block lower-body training). heavyMin = minutes, heavyKm = distance km.
export interface EnduranceModality {
  re: RegExp;
  label: string;
  regions: MuscleGroup[];
  heavyMin: number;
  heavyKm: number;
}

// Conservative prime movers only, matched by keyword against the activity text.
export const ENDURANCE_MODALITIES: EnduranceModality[] = [
  { re: /\b(ride|cycl|bik|mtb|gravel|spin|peloton)/, label: "ride", regions: ["quads", "hamstrings", "glutes", "calves", "core"], heavyMin: 75, heavyKm: 30 },
  { re: /\b(run|jog|sprint|tempo|interval)/, label: "run", regions: ["quads", "hamstrings", "glutes", "calves", "core"], heavyMin: 55, heavyKm: 9 },
  { re: /\b(hik|walk|ruck|trek|stair|stepper|elliptical)/, label: "hike", regions: ["quads", "glutes", "calves", "hamstrings"], heavyMin: 120, heavyKm: 16 },
  { re: /\b(row|erg|kayak|paddle)/, label: "row", regions: ["back", "hamstrings", "glutes", "core"], heavyMin: 45, heavyKm: 8 },
  { re: /\b(swim)/, label: "swim", regions: ["back", "shoulders", "chest", "core"], heavyMin: 45, heavyKm: 2.5 },
  { re: /\b(ski|skat|snowboard)/, label: "session", regions: ["quads", "glutes", "calves", "hamstrings"], heavyMin: 90, heavyKm: 15 },
];

export function normalizeActivityText(text: string): string {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchEnduranceModality(text: string): EnduranceModality | null {
  const norm = normalizeActivityText(text);
  if (!norm) return null;
  for (const m of ENDURANCE_MODALITIES) if (m.re.test(norm)) return m;
  return null;
}

// Generic cardio day-grade thresholds (training-read.cardioEffort): coarser than the
// per-modality table above — they grade ONE effort easy/moderate/hard for the day's
// earned-rest read, not per-muscle loading. Kept distinct from the modality table on
// purpose (a day-grade shouldn't fork per activity type); co-located so both sets of
// "heavy" knobs live in one file.
export const CARDIO_GRADE = {
  walkHikeModerateMin: 90,   // a walk/hike is only moderate past this duration…
  walkHikeModerateKm: 8,     // …or this distance
  hardMin: 50,               // a run/ride/etc. grades hard at/above this duration…
  hardKm: 9,                 // …or this distance
  moderateMin: 25,           // …moderate at/above this duration…
  moderateKm: 4,             // …or this distance
} as const;
