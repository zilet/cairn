// Progress-only movement regions: the accessory families the curated region table
// (movement-region.ts) deliberately leaves without a region, named here so the
// capability read (strength-capability.ts) can give each its own unit instead of a
// "<pattern> accessory" catch-all.
//
// Why a second table and not new rows in movement-region.ts: `movementRegionKey` without
// `{profile:true}` also decides what folds together on TODAY'S CARD
// (composition-pairing.ts `collapseRegionDuplicates` keeps one item per region, so a
// plank and an ab wheel sharing a region would lose one of them), which items pair as
// supersets, a plan item's effect tier, the weekly dose ledger's anchor, strength-energy's
// accessory test and muscle-trajectory's family match. A new region there would change
// all of that for lifts nobody asked about. A progress read only GROUPS evidence, so the
// families live here, consulted after the curated table and never by a card.
//
// The same contract as the curated table: a pure function of the name, `null` means "no
// rule applies" (never "drop it"), and two lifts share a region only when they are the
// same movement for the same muscle: a hip thrust and a glute kickback are not one
// unit, nor are a front raise and a lateral raise, nor a plank and a crunch. Names are
// matched normalized (lowercase, punctuation to spaces), so "Lean-Away" reads "lean away".
import { normalizeExerciseName } from "./exercise-canon.js";

export type ProgressRegion =
  | "tibialis"
  | "rotator-cuff"
  | "hip-adduction"
  | "hip-abduction"
  | "front-raise"
  | "upright-row"
  | "shrug"
  | "straight-arm-pull"
  | "chest-fly"
  | "hip-thrust"
  | "glute-kickback"
  | "back-extension"
  | "carry"
  | "core:lateral"
  | "core:rotation"
  | "core:anti-extension"
  | "core:flexion";

// First match wins; the order settles names two rules would both read (a side plank is
// lateral core before it is a plank; a side-lying leg raise is abduction before it is a
// leg raise; a reverse hyper is a back extension, never a crunch).
const PROGRESS_REGION_RULES: ReadonlyArray<readonly [ProgressRegion, RegExp]> = [
  // Tibialis anterior: dorsiflexion against load. Not a calf (that is plantar flexion).
  // A bare "toe raise" is left alone: gyms use it for both directions.
  ["tibialis", /\btib(?:ialis)?\b|\btib raises?\b|\bdorsiflex(?:ion|ions)?\b/],
  // Shoulder rotation against light load: cuff work, never an overhead press.
  ["rotator-cuff", /\brotator cuff\b|\b(?:external|internal) rotations?\b/],
  ["hip-adduction", /\badduct(?:ion|ions|or|ors)?\b|\bcopenhagen\b/],
  [
    "hip-abduction",
    /\babduct(?:ion|ions|or|ors)?\b|\bclamshells?\b|\blateral (?:band )?walks?\b|\bmonster walks?\b|\bside lying leg raises?\b/,
  ],
  ["front-raise", /\bfront (?:delt |plate |cable |dumbbell |db )?raises?\b/],
  ["upright-row", /\bupright rows?\b/],
  ["shrug", /\bshrugs?\b/],
  // Shoulder extension with a straight arm: the lats, not the triceps and not a pulldown.
  [
    "straight-arm-pull",
    /\bstraight arm (?:lat |cable |rope |bar )?(?:pull ?downs?|push ?downs?|press ?downs?|pulls?)\b|\bpull ?overs?\b/,
  ],
  // A chest fly in any implement (a reverse or rear fly is the curated rear-delt region,
  // asked first).
  ["chest-fly", /\b(?:fly|flye|flyes|flies)\b|\bpec deck\b|\bpec fly\b|\bcrossovers?\b|\bcable cross\b/],
  ["hip-thrust", /\bhip thrusts?\b|\b(?:glute|hip) bridges?\b/],
  // A triceps kickback is the curated triceps region, asked first; every other kickback
  // is the glutes' (the swap-family table settles the same names the same way).
  ["glute-kickback", /\bkickbacks?\b|\bdonkey kicks?\b/],
  ["back-extension", /\bback extensions?\b|\bhyper ?extensions?\b|\breverse hypers?\b/],
  ["carry", /\bcarry\b|\bcarries\b|\bfarmers? walks?\b|\bfarmer s walks?\b|\bsuitcase (?:hold|walk)s?\b/],
  ["core:lateral", /\bside planks?\b|\bside bends?\b/],
  [
    "core:rotation",
    /\bpallof\b|\bwood ?chops?\b|\brussian twists?\b|\banti rotation\b|\b(?:landmine|cable) (?:rotations?|twists?)\b/,
  ],
  [
    "core:anti-extension",
    /\bplanks?\b|\bab wheel\b|\broll ?outs?\b|\bdead ?bugs?\b|\bbody ?saws?\b|\bstir the pot\b|\bhollow (?:body )?holds?\b/,
  ],
  [
    "core:flexion",
    /\bcrunch(?:es)?\b|\bsit ?ups?\b|\bleg raises?\b|\bknee raises?\b|\btoes to bar\b|\bv ups?\b|\bjack ?knifes?\b|\bab machine\b/,
  ],
];

/** Every key progressRegionKey can answer. */
export const PROGRESS_REGIONS: readonly ProgressRegion[] = PROGRESS_REGION_RULES.map(([key]) => key);

/**
 * The progress-only region a lift name falls in, or null. Read ONLY by progress reads
 * (the capability read), after the curated `movementRegionKey`: never by a card.
 */
export function progressRegionKey(name: string): ProgressRegion | null {
  const n = normalizeExerciseName(String(name ?? ""));
  if (!n) return null;
  for (const [key, rule] of PROGRESS_REGION_RULES) if (rule.test(n)) return key;
  return null;
}
