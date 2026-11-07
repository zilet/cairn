// Single source of truth for training "heavy / hard" load thresholds — the tuning
// knobs that decide how much a session or an endurance effort actually loaded the
// body. Both the day-grade reader (training-read.cardioEffort, which grades a whole
// day easy/moderate/hard for the earned-rest count) and the per-muscle hybrid-load
// reader pull their thresholds from here, so "heavy" can never drift between the two.
//
import type { MuscleGroup } from "./exercise-canon.js";
import {
  activityLoadFamily,
  classifyEnduranceActivity,
  isStrengthActivityType,
  type EnduranceSportMode,
  type LoadFamily,
} from "./endurance-sports.js";
import { STATED_EASY_RPE_MAX } from "./stated-effort.js";

// A logged strength effort counts as a heavy dose on a muscle at this many sets.
export const HEAVY_SETS = 4;

// Per-modality endurance thresholds: at/above these a real effort has loaded the
// listed prime movers heavily (a long/hard run fatigues legs + trunk; a casual walk
// does not block lower-body training). heavyMin = minutes, heavyKm = distance km.
export interface EnduranceModality {
  re: RegExp;
  /** The classifier's mode, or a load family that has no legacy mode of its own. */
  mode: EnduranceSportMode | "paddle" | "court" | "snow" | "combat" | "whole_body";
  /** The load family (endurance-sports.activityLoadFamily) this modality reads as. */
  family: LoadFamily;
  label: string;
  regions: MuscleGroup[];
  heavyMin: number;
  heavyKm: number;
  loadCharacter: "aerobic" | "mixed-terrain" | "technical-eccentric" | "eccentric" | "full-body-aerobic";
  // How much of one session-equivalent each listed region actually takes (default
  // 1). A region can be genuinely involved without being a prime mover: a run holds
  // the trunk up but does not train it, and a trail ride grips and braces with the
  // back and forearms far below a rowing session. Crediting them evenly read a
  // two-hour ride as a full back day.
  regionWeights?: Partial<Record<MuscleGroup, number>>;
}

// Families with no legacy mode, matched from the type key (activityLoadFamily)
// rather than the text regex loop above.
export const COURT_MODALITY: EnduranceModality = {
  re: /\b(tennis|padel|pickleball|squash|badminton|racquet\w*|soccer|football|basketball|volleyball|hockey|rugby)\b/,
  mode: "court",
  family: "court",
  label: "court sport",
  regions: ["quads", "hamstrings", "glutes", "calves", "core"],
  heavyMin: 75,
  heavyKm: 12,
  loadCharacter: "mixed-terrain",
  regionWeights: { hamstrings: 0.6, calves: 0.6, core: 0.4 },
};

export const SNOW_MODALITY: EnduranceModality = {
  re: /\b(snowboard\w*|skat\w*|inline\w*|snowshoe\w*)\b/,
  mode: "snow",
  family: "snow",
  label: "snow sport",
  regions: ["quads", "hamstrings", "glutes", "calves", "core"],
  heavyMin: 90,
  heavyKm: 20,
  loadCharacter: "eccentric",
  regionWeights: { hamstrings: 0.6, calves: 0.6, core: 0.5 },
};

// Bag work, pads, sparring, grappling: the shoulders and arms throw, the trunk turns
// every punch, the calves carry the footwork. A short round of bag work is a light
// upper-body touch, never a leg day.
export const COMBAT_MODALITY: EnduranceModality = {
  re: /\b(boxing|kickbox\w*|punching bag|bag punching|heavy bag|mma|muay thai|martial arts?|sparring)\b/,
  mode: "combat",
  family: "combat",
  label: "combat sport",
  regions: ["shoulders", "triceps", "back", "core", "calves"],
  heavyMin: 60,
  heavyKm: 999,
  loadCharacter: "full-body-aerobic",
  regionWeights: { triceps: 0.5, back: 0.5, core: 0.6, calves: 0.4 },
};

// The GENERIC fallback: an activity whose type names no sport Cairn can place
// (fishing, bouldering, yoga, whatever Garmin adds next). It is never nothing — a
// light whole-body exposure, every region at a low weight — and it is graded only
// by the watch's generic bars: length alone never makes it more than light
// (hybrid-load.classifyImpactLoad), because three hours of fishing is not three
// hours of exercise.
export const WHOLE_BODY_MODALITY: EnduranceModality = {
  re: /(?!)/,
  mode: "whole_body",
  family: "whole_body",
  label: "activity",
  regions: ["quads", "hamstrings", "glutes", "calves", "back", "shoulders", "core", "forearms"],
  heavyMin: 120,
  heavyKm: 15,
  loadCharacter: "full-body-aerobic",
  regionWeights: {
    quads: 0.3,
    hamstrings: 0.3,
    glutes: 0.3,
    calves: 0.3,
    back: 0.3,
    shoulders: 0.3,
    core: 0.3,
    forearms: 0.3,
  },
};

// Conservative prime movers only, matched by keyword against the activity text.
export const ENDURANCE_MODALITIES: EnduranceModality[] = [
  {
    re: /\b(downhill|lift served|bike park|gravity mtb|dh mtb)\b/,
    mode: "ride-downhill-mtb",
    family: "ride",
    label: "downhill MTB",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back", "forearms"],
    heavyMin: 120,
    heavyKm: 20,
    loadCharacter: "technical-eccentric",
  },
  {
    re: /\b(mountain bik|mtb|trail rid|trail bik|single ?track|xc mtb)\b/,
    mode: "ride-trail-mtb",
    family: "ride",
    label: "trail MTB",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back", "forearms"],
    heavyMin: 75,
    heavyKm: 20,
    loadCharacter: "mixed-terrain",
    regionWeights: { hamstrings: 0.6, calves: 0.5, core: 0.4, back: 0.35, forearms: 0.35 },
  },
  {
    re: /\b(gravel|cyclocross)\b/,
    mode: "ride-gravel",
    family: "ride",
    label: "gravel ride",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 75,
    heavyKm: 30,
    loadCharacter: "aerobic",
    regionWeights: { hamstrings: 0.6, calves: 0.6, core: 0.3 },
  },
  {
    re: /\b(road bik|road cycl|road rid)\b/,
    mode: "ride-road",
    family: "ride",
    label: "road ride",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 75,
    heavyKm: 30,
    loadCharacter: "aerobic",
    regionWeights: { hamstrings: 0.6, calves: 0.6, core: 0.3 },
  },
  {
    re: /\b(ride|cycl|bik|spin|peloton)\b/,
    mode: "ride",
    family: "ride",
    label: "ride",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 75,
    heavyKm: 30,
    loadCharacter: "aerobic",
    regionWeights: { hamstrings: 0.6, calves: 0.6, core: 0.3 },
  },
  {
    re: /\b(run|jog|sprint|tempo|interval)\b/,
    mode: "run",
    family: "run",
    label: "run",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 55,
    heavyKm: 9,
    loadCharacter: "aerobic",
    regionWeights: { core: 0.3 },
  },
  {
    re: /\b(hik|walk|ruck|trek|stair|stepper|elliptical)\b/,
    mode: "walk",
    family: "walk",
    label: "hike",
    regions: ["quads", "glutes", "calves", "hamstrings"],
    heavyMin: 120,
    heavyKm: 16,
    loadCharacter: "aerobic",
  },
  {
    // Paddle sports read as their own family (activityLoadFamily): Garmin's
    // "kayaking_v2" / "stand_up_paddleboarding_v2" never matched a bare \bkayak\b
    // or \bpaddle\b, so every paddle outing used to be dropped as dose 0.
    re: /\b(kayak\w*|canoe\w*|paddl\w*|sup|stand up paddle\w*|rafting|dragon boat\w*|whitewater)\b/,
    mode: "paddle",
    family: "paddle",
    label: "paddle",
    regions: ["back", "shoulders", "core", "forearms", "biceps"],
    heavyMin: 60,
    heavyKm: 10,
    loadCharacter: "full-body-aerobic",
    regionWeights: { core: 0.6, forearms: 0.5, biceps: 0.4 },
  },
  {
    re: /\b(row\w*|erg)\b/,
    mode: "row",
    family: "row",
    label: "row",
    regions: ["back", "hamstrings", "glutes", "core"],
    heavyMin: 45,
    heavyKm: 8,
    loadCharacter: "full-body-aerobic",
  },
  {
    re: /\b(swim)\b/,
    mode: "swim",
    family: "swim",
    label: "swim",
    regions: ["back", "shoulders", "chest", "core"],
    heavyMin: 45,
    heavyKm: 2.5,
    loadCharacter: "full-body-aerobic",
  },
  {
    re: /\b(backcountry|ski tour|alpine tour|uphill ski|skimo)\b/,
    mode: "ski-touring",
    family: "ski",
    label: "ski touring",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back"],
    heavyMin: 75,
    heavyKm: 8,
    loadCharacter: "mixed-terrain",
  },
  {
    re: /\b(nordic|cross country ski|xc ski|skate ski|classic ski)\b/,
    mode: "ski-nordic",
    family: "ski",
    label: "Nordic ski",
    regions: ["quads", "hamstrings", "glutes", "calves", "core", "back", "shoulders", "triceps"],
    heavyMin: 60,
    heavyKm: 10,
    loadCharacter: "full-body-aerobic",
  },
  {
    re: /\b(alpine|downhill ski|lift served ski|resort ski)\b/,
    mode: "ski-alpine",
    family: "ski",
    label: "alpine ski",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 120,
    heavyKm: 20,
    loadCharacter: "eccentric",
  },
  {
    re: /\b(ski|skiing|skied)\b/,
    mode: "ski",
    family: "ski",
    label: "skiing",
    regions: ["quads", "hamstrings", "glutes", "calves", "core"],
    heavyMin: 90,
    heavyKm: 15,
    loadCharacter: "mixed-terrain",
  },
  COURT_MODALITY,
  SNOW_MODALITY,
  COMBAT_MODALITY,
  WHOLE_BODY_MODALITY,
];


const FAMILY_MODALITY: Partial<Record<LoadFamily, EnduranceModality>> = {
  paddle: ENDURANCE_MODALITIES.find((m) => m.mode === "paddle"),
  court: COURT_MODALITY,
  snow: SNOW_MODALITY,
  combat: COMBAT_MODALITY,
  whole_body: WHOLE_BODY_MODALITY,
};

/** The generic modality a load family reads as, for a type the classifier cannot place. */
export function modalityForLoadFamily(family: LoadFamily): EnduranceModality | null {
  return (
    FAMILY_MODALITY[family] ??
    ENDURANCE_MODALITIES.find((m) => m.family === family && m.mode === family) ??
    null
  );
}

/**
 * Families with no legacy endurance mode (paddle, court, snow, combat): the type key
 * is authoritative, and their length alone never makes a session heavy — only a
 * session that showed effort reaches the heavy bar on time.
 */
export function lengthNeedsEffortFamily(family: string): boolean {
  return family === "paddle" || family === "court" || family === "snow" || family === "combat";
}

export function regionWeight(modality: Pick<EnduranceModality, "regionWeights">, group: MuscleGroup): number {
  return modality.regionWeights?.[group] ?? 1;
}

export function normalizeActivityText(text: string): string {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// The modality one activity loads. Null ONLY for empty input and for a strength
// activity (a lift is a Cairn session; dosing it here too would count it twice):
// every other logged activity reads as SOME modality, so no outing is ever dose 0.
export function matchEnduranceModality(structuredType: string, supportingText = ""): EnduranceModality | null {
  const norm = normalizeActivityText(`${structuredType} ${supportingText}`);
  if (!norm) return null;
  if (isStrengthActivityType(structuredType, supportingText)) return null;
  // A structured type in a family the classifier has no mode for (paddle, court,
  // snow, combat) is authoritative: a kayak named "lake run" is still a paddle.
  const typed = activityLoadFamily(structuredType);
  if (lengthNeedsEffortFamily(typed.family)) {
    const familyModality = modalityForLoadFamily(typed.family);
    if (familyModality) return familyModality;
  }
  const classified = classifyEnduranceActivity(structuredType, supportingText);
  const exact = ENDURANCE_MODALITIES.find((modality) => modality.mode === classified.mode);
  if (exact) return exact;
  // Keep support for non-canonical modalities historically handled here.
  for (const modality of ENDURANCE_MODALITIES) if (modality.re.test(norm)) return modality;
  // Nothing named a sport: the family guess, else light whole-body activity.
  return modalityForLoadFamily(activityLoadFamily(structuredType, supportingText).family) ?? WHOLE_BODY_MODALITY;
}

// ---- what makes ONE endurance effort "hard" (the single source of truth) ----
// These knobs used to live as anonymous literals in three files: the per-muscle
// reader (hybrid-load.classifyImpactLoad), the day grade (training-read
// .hardCardioDay), and the coarse day bands below. They drifted — the per-muscle
// reader's label test was missing "sprint", "interval" and "maximal" and had no
// word boundaries, so a logged VO2 interval session did not read as hard there
// while it did in the day grade. One definition now, consumed by both.
//
// The two TE bars are deliberately different, and are named together so the
// difference is visible rather than being two magic numbers in two files:
// `aerobicTe`/`anaerobicTe` answer "did this load these MUSCLES hard", read per
// axis; `dayGradeTe` answers the coarser "was this a hard DAY" for the
// earned-rest count and is taken as one bar across the higher of the two axes.
export const HARD_EFFORT = {
  /** Seconds at threshold and above (Z4/Z5) that make an effort genuinely hard. */
  z4Seconds: 240,
  // Letter/digit lookarounds rather than \b: Garmin's labels are SNAKE_CASE, and \b never
  // matches beside "_", so LACTATE_THRESHOLD and ANAEROBIC_CAPACITY read as easy.
  /** A session label that names a hard workout outright. */
  label: /(?<![a-z0-9])(?:vo2(?:[\s_-]*max)?|maximal|anaerobic|sprint|interval|threshold|tempo|lactate)(?![a-z0-9])/i,
  /** Absolute Garmin training_load floor, for when there is no personal baseline. */
  trainingLoadFloor: 80,
  /** …and the multiple of the athlete's OWN recent cardio median when there is one. */
  loadMedianMultiple: 1.5,
  /** Minutes that make a genuine endurance session (run/ride/swim/row) a loading day. */
  sustainedMin: 40,
  /** Per-axis training-effect bars for the per-muscle read. */
  aerobicTe: 3,
  anaerobicTe: 2,
  /** The coarser single bar the day grade takes across both axes. */
  dayGradeTe: 4,
} as const;

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Did this session show muscular effort, rather than only time on the clock?
 * Aerobic training effect at 2 or above, any time in Z4/Z5, a training load above
 * zero, or a stated effort past easy. A missing RPE is silence, not an easy day.
 */
export function sawSessionEffort(input: {
  aerobicTe?: unknown;
  zones45Sec?: unknown;
  trainingLoad?: unknown;
  rpe?: unknown;
}): boolean {
  const ate = finiteNumber(input.aerobicTe);
  if (ate != null && ate >= 2) return true;
  const zones = finiteNumber(input.zones45Sec);
  if (zones != null && zones > 0) return true;
  const load = finiteNumber(input.trainingLoad);
  if (load != null && load > 0) return true;
  const rpe = finiteNumber(input.rpe);
  return rpe != null && rpe > STATED_EASY_RPE_MAX;
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
