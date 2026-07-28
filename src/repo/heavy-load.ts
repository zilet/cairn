// Single source of truth for training "heavy / hard" load thresholds — the tuning
// knobs that decide how much a session or an endurance effort actually loaded the
// body. Both the day-grade reader (training-read.cardioEffort, which grades a whole
// day easy/moderate/hard for the earned-rest count) and the per-muscle hybrid-load
// reader pull their thresholds from here, so "heavy" can never drift between the two.
//
import type { MuscleGroup } from "./exercise-canon.js";
import {
  classifyEnduranceActivity,
  type EnduranceSportMode,
} from "./endurance-sports.js";

// A logged strength effort counts as a heavy dose on a muscle at this many sets.
export const HEAVY_SETS = 4;

// Per-modality endurance thresholds: at/above these a real effort has loaded the
// listed prime movers heavily (a long/hard run fatigues legs + trunk; a casual walk
// does not block lower-body training). heavyMin = minutes, heavyKm = distance km.
export interface EnduranceModality {
  re: RegExp;
  mode: EnduranceSportMode;
  label: string;
  regions: MuscleGroup[];
  heavyMin: number;
  heavyKm: number;
  loadCharacter: "aerobic" | "mixed-terrain" | "technical-eccentric" | "eccentric" | "full-body-aerobic";
}

// Conservative prime movers only, matched by keyword against the activity text.
export const ENDURANCE_MODALITIES: EnduranceModality[] = [
  {
    re: /\b(downhill|lift served|bike park|gravity mtb|dh mtb)\b/,
    mode: "ride-downhill-mtb",
    label: "downhill MTB",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back", "forearms"],
    heavyMin: 120,
    heavyKm: 20,
    loadCharacter: "technical-eccentric",
  },
  {
    re: /\b(mountain bik|mtb|trail rid|trail bik|single ?track|xc mtb)\b/,
    mode: "ride-trail-mtb",
    label: "trail MTB",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back", "forearms"],
    heavyMin: 75,
    heavyKm: 20,
    loadCharacter: "mixed-terrain",
  },
  {
    re: /\b(gravel|cyclocross)\b/,
    mode: "ride-gravel",
    label: "gravel ride",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 75,
    heavyKm: 30,
    loadCharacter: "aerobic",
  },
  {
    re: /\b(road bik|road cycl|road rid)\b/,
    mode: "ride-road",
    label: "road ride",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 75,
    heavyKm: 30,
    loadCharacter: "aerobic",
  },
  {
    re: /\b(ride|cycl|bik|spin|peloton)\b/,
    mode: "ride",
    label: "ride",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 75,
    heavyKm: 30,
    loadCharacter: "aerobic",
  },
  {
    re: /\b(run|jog|sprint|tempo|interval)\b/,
    mode: "run",
    label: "run",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 55,
    heavyKm: 9,
    loadCharacter: "aerobic",
  },
  {
    re: /\b(hik|walk|ruck|trek|stair|stepper|elliptical)\b/,
    mode: "walk",
    label: "hike",
    regions: ["quads", "glutes", "calves", "hamstrings"],
    heavyMin: 120,
    heavyKm: 16,
    loadCharacter: "aerobic",
  },
  {
    re: /\b(row|erg|kayak|paddle)\b/,
    mode: "row",
    label: "row",
    regions: ["back", "hamstrings", "glutes", "core"],
    heavyMin: 45,
    heavyKm: 8,
    loadCharacter: "full-body-aerobic",
  },
  {
    re: /\b(swim)\b/,
    mode: "swim",
    label: "swim",
    regions: ["back", "shoulders", "chest", "core"],
    heavyMin: 45,
    heavyKm: 2.5,
    loadCharacter: "full-body-aerobic",
  },
  {
    re: /\b(backcountry|ski tour|alpine tour|uphill ski|skimo)\b/,
    mode: "ski-touring",
    label: "ski touring",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back"],
    heavyMin: 75,
    heavyKm: 8,
    loadCharacter: "mixed-terrain",
  },
  {
    re: /\b(nordic|cross country ski|xc ski|skate ski|classic ski)\b/,
    mode: "ski-nordic",
    label: "Nordic ski",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back", "shoulders", "triceps"],
    heavyMin: 60,
    heavyKm: 10,
    loadCharacter: "full-body-aerobic",
  },
  {
    re: /\b(alpine|downhill ski|lift served ski|resort ski)\b/,
    mode: "ski-alpine",
    label: "alpine ski",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 120,
    heavyKm: 20,
    loadCharacter: "eccentric",
  },
  {
    re: /\b(ski|skiing|skied)\b/,
    mode: "ski",
    label: "skiing",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 90,
    heavyKm: 15,
    loadCharacter: "mixed-terrain",
  },
];

export function normalizeActivityText(text: string): string {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchEnduranceModality(structuredType: string, supportingText = ""): EnduranceModality | null {
  const norm = normalizeActivityText(`${structuredType} ${supportingText}`);
  if (!norm) return null;
  const classified = classifyEnduranceActivity(structuredType, supportingText);
  const exact = ENDURANCE_MODALITIES.find((modality) => modality.mode === classified.mode);
  if (exact) return exact;
  // Keep support for non-canonical modalities historically handled here.
  for (const modality of ENDURANCE_MODALITIES) if (modality.re.test(norm)) return modality;
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
