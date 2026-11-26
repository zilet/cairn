import { normalizeExerciseName } from "./exercise-canon.js";
import { appliedProfileFor } from "./exercise-profile-lookup.js";
import { classifyPattern } from "./exercise-variations.js";
import { pressSlotKey } from "./plan-quality.js";

// Which movement REGION an exercise occupies on one card: two items in the same region
// are the same stimulus twice (flat dumbbell bench then flat barbell bench, a rope
// pushdown then a bar pushdown), so a composed session keeps one of them
// (composition-pairing.ts `collapseRegionDuplicates`). A region is narrower than a
// movement pattern — flat and incline press are different regions, and so are a
// straight-leg and a bent-knee calf raise, an overhead triceps extension and a
// pushdown, a supinated curl and a hammer curl.
//
// Contract: a pure function of the name (and, when known, the stored muscle group).
// `null` means "no region rule applies" — never "unknown, drop it". The big compounds
// (squat, hinge, row, pull-up) have no region: a squat and a leg press both stay on a
// card, and so does a compound with its back-off.
//
// Deliberately NOT classifyPattern: that table answers "which swap family", so a leg
// curl reads as a hinge and a dip as a triceps isolation. Here a leg curl is knee
// flexion and a dip is its own region (a loaded press, never folded into a pushdown).
//
// Region keys:
//   horizontal-press:flat|incline|decline   (pressSlotKey, unchanged)
//   vertical-press                          overhead / shoulder / military / Arnold / push press
//   dip                                     any loaded or bodyweight dip
//   knee-extension                          leg extension
//   knee-flexion                            leg curl, lying / seated / standing (not a Nordic)
//   calf:straight | calf:bent               standing-type raises vs seated / bent-knee
//   curl:supinated | curl:neutral | curl:pronated
//   triceps:overhead | triceps:pushdown | triceps:lying | triceps:kickback | triceps:extension
//   lateral-raise                           side / lateral raises (not an upright row)
//   rear-delt                               reverse fly / rear-delt fly / face pull (not a band pull-apart)
export type MovementRegion = string;

const DIP = /\bdips?\b/;
const VERTICAL_PRESS =
  /\b(?:ohp|military press|shoulder press|arnold press|push press|overhead (?:barbell |dumbbell |db |bb |machine |seated |standing )?press)\b/;
const KNEE_EXTENSION = /\b(?:leg|knee|quad) ext(?:ension)?s?\b/;
const KNEE_FLEXION = /\b(?:leg|hamstring) curls?\b|\blying curls?\b|\bknee flexion\b/;
const NOT_KNEE_FLEXION = /\bnordic\b/;
const CALF = /\bcalf\b|\bcalves\b/;
const CALF_BENT = /\bseated\b|\bbent knee\b|\bsoleus\b/;
const CURL = /\bcurls?\b|\bpreacher\b/;
const NOT_ARM_CURL = /\b(?:leg|hamstring|nordic|wrist|lying leg|seated leg|standing leg|prone leg)\b/;
const CURL_NEUTRAL = /\b(?:hammer|neutral|rope curl|cross body|crossbody)\b/;
const CURL_PRONATED = /\breverse (?:grip )?curls?\b|\bpronated\b/;
// Elbow extension by name. "Press down" spelled apart is a pressdown, and an overhead
// extension that never says "triceps" is still one (the swap-family table would read it
// as an overhead press).
const TRICEPS =
  /\btri(?:cep|ceps)?\b|\bpushdowns?\b|\bpush downs?\b|\bpress ?downs?\b|\bskull ?crushers?\b|\bfrench press\b|\boverhead (?:[a-z]+ ){0,2}ext(?:ension)?s?\b/;
// A straight-arm pushdown is the lats' shoulder extension, never a triceps pushdown.
const NOT_TRICEPS = /\bstraight arm\b|\bclose grip\b/;
// Every cable pushdown is one region whatever the attachment (rope, straight bar, V-bar,
// single arm, reverse grip); a "triceps pulldown" is the same movement misnamed.
const TRICEPS_PUSHDOWN = /\bpushdowns?\b|\bpush downs?\b|\bpress ?downs?\b|\bpull ?downs?\b/;
const TRICEPS_OVERHEAD = /\b(?:overhead|oh)\b|\bfrench press\b/;
const TRICEPS_LYING = /\bskull ?crushers?\b|\blying\b/;
const TRICEPS_EXTENSION = /\bext(?:ension)?s?\b|\bfrench press\b|\bskull ?crushers?\b/;
const TRICEPS_KICKBACK = /\bkickbacks?\b/;
// A dumbbell kickback is the triceps' (the swap-family table reads it the same way); a
// glute kickback never is.
const TRICEPS_KICKBACK_IMPLEMENT = /\btri(?:cep|ceps)?\b|\b(?:db|dumbbells?)\b/;
const GLUTE = /\bglutes?\b/;
// Every lateral raise is one region whatever the implement or lean (cable, machine,
// dumbbell, lean-away, single arm). A front raise and an upright row are not lateral raises.
const LATERAL_RAISE =
  /\blateral (?:delt |deltoid |shoulder )?raises?\b|\bside (?:lateral |delt |deltoid )?raises?\b|\b(?:medial|side) delt(?:oid)? raises?\b|\blat raises?\b|\b(?:cable|dumbbell|db|machine|lean away|leaning|single arm|one arm) laterals?\b/;
const REAR_DELT =
  /\brear delt\b|\breverse (?:pec deck|pec|fly|flye|flyes|flies|delt)\b|\brear (?:fly|flye|flyes|flies)\b|\bface pulls?\b|\breverse (?:cable )?crossovers?\b/;
const NOT_REAR_DELT = /\bpull aparts?\b/;

// Every key movementRegionKey can answer, as a value list: the vocabulary an agent's exercise
// profile is held to (repo/exercise-profile.ts). A new key added above belongs here too; the
// profile test asserts every curated answer is a member.
export const MOVEMENT_REGIONS: readonly MovementRegion[] = [
  "horizontal-press:flat",
  "horizontal-press:incline",
  "horizontal-press:decline",
  "vertical-press",
  "dip",
  "knee-extension",
  "knee-flexion",
  "calf:straight",
  "calf:bent",
  "curl:supinated",
  "curl:neutral",
  "curl:pronated",
  "triceps:overhead",
  "triceps:pushdown",
  "triceps:lying",
  "triceps:kickback",
  "triceps:extension",
  "lateral-raise",
  "rear-delt",
];

export function isMovementRegion(value: unknown): value is MovementRegion {
  return typeof value === "string" && MOVEMENT_REGIONS.includes(value);
}

/** How movementRegionKey may be asked. */
export interface MovementRegionOptions {
  /**
   * Fill a name no region rule answers from the agent's exercise profile. OFF by default: a
   * newly placed region folds items together on a composed card (one of two same-region items
   * is dropped), pairs supersets and reorders a plan day, so only a progress/credit read opts
   * in. A curated region is never replaced either way.
   */
  profile?: boolean;
}

export function movementRegionKey(
  name: string,
  group?: string | null,
  opts?: MovementRegionOptions,
): MovementRegion | null {
  const curated = movementRegionKeyCurated(name, group);
  if (curated !== null || !opts?.profile) return curated;
  const region = appliedProfileFor(name)?.region;
  return isMovementRegion(region) ? region : null;
}

/** The curated answer alone: never reads a profile. */
export function movementRegionKeyCurated(name: string, _group?: string | null): MovementRegion | null {
  const n = normalizeExerciseName(name);
  if (!n) return null;
  // A dip before the press test: "Bench Dip" is a dip, never a flat bench press.
  if (DIP.test(n)) return "dip";
  const press = pressSlotKey(name);
  if (press) return press;
  if (TRICEPS_KICKBACK.test(n) && TRICEPS_KICKBACK_IMPLEMENT.test(n) && !GLUTE.test(n)) return "triceps:kickback";
  if (TRICEPS.test(n) && !NOT_TRICEPS.test(n)) {
    if (TRICEPS_PUSHDOWN.test(n)) return "triceps:pushdown";
    if (TRICEPS_LYING.test(n)) return "triceps:lying";
    if (TRICEPS_OVERHEAD.test(n)) return "triceps:overhead";
    // A bare "triceps extension" names no arm position; it is its own region, so it
    // only ever folds with another bare extension.
    if (TRICEPS_EXTENSION.test(n)) return "triceps:extension";
    return null;
  }
  if (VERTICAL_PRESS.test(n)) return "vertical-press";
  if (KNEE_EXTENSION.test(n)) return "knee-extension";
  if (KNEE_FLEXION.test(n) && !NOT_KNEE_FLEXION.test(n)) return "knee-flexion";
  if (CALF.test(n)) return CALF_BENT.test(n) ? "calf:bent" : "calf:straight";
  if (CURL.test(n) && !NOT_ARM_CURL.test(n)) {
    if (CURL_PRONATED.test(n)) return "curl:pronated";
    if (CURL_NEUTRAL.test(n)) return "curl:neutral";
    return "curl:supinated";
  }
  if (LATERAL_RAISE.test(n)) return "lateral-raise";
  if (REAR_DELT.test(n) && !NOT_REAR_DELT.test(n)) return "rear-delt";
  // A bare name the table does not know, filed under an isolation group, still has no
  // region: absence of a rule is never a reason to fold two items together.
  return null;
}

// A regional isolation lift is an accessory whatever the swap-family table says: a leg
// curl files as a hinge there and a leg extension as a squat, which would seat both
// among the compounds (plan-item-order.ts `planItemEffectTier` reads this).
const ACCESSORY_REGION = /^(?:knee-extension|knee-flexion|calf:|curl:|triceps:|lateral-raise|rear-delt)/;

export function isAccessoryRegion(region: MovementRegion | null | undefined): boolean {
  return !!region && ACCESSORY_REGION.test(region);
}

// A loaded press region (any bench angle, overhead) is compound work whatever group the
// item carries — an incline dumbbell press with no stored group is still a press.
export function isPressRegion(region: MovementRegion | null | undefined): boolean {
  return !!region && (region.startsWith("horizontal-press:") || region === "vertical-press");
}

// Which side of an antagonist pair an exercise works, for supersets
// (composition-pairing.ts `pairForSession`). Presses and rows are read off the region
// first and the swap-family table second (a row has no region, but it is plainly a
// horizontal pull); flyes, dips, carries, hinges and squats sit on no side and never pair.
export type AntagonistSide =
  | "horizontal-push"
  | "horizontal-pull"
  | "vertical-push"
  | "vertical-pull"
  | "elbow-flexion"
  | "elbow-extension"
  | "knee-extension"
  | "knee-flexion";

export const ANTAGONIST_OF: Readonly<Record<AntagonistSide, AntagonistSide>> = {
  "horizontal-push": "horizontal-pull",
  "horizontal-pull": "horizontal-push",
  "vertical-push": "vertical-pull",
  "vertical-pull": "vertical-push",
  "elbow-flexion": "elbow-extension",
  "elbow-extension": "elbow-flexion",
  "knee-extension": "knee-flexion",
  "knee-flexion": "knee-extension",
};

export function antagonistSide(name: string, group?: string | null): AntagonistSide | null {
  const region = movementRegionKey(name, group);
  if (region) {
    if (region.startsWith("horizontal-press:")) return "horizontal-push";
    if (region === "vertical-press") return "vertical-push";
    if (region === "knee-extension") return "knee-extension";
    if (region === "knee-flexion") return "knee-flexion";
    if (region.startsWith("curl:")) return "elbow-flexion";
    if (region.startsWith("triceps:")) return "elbow-extension";
    return null;
  }
  const n = normalizeExerciseName(name);
  // Never guess a side from the muscle group alone: only a named pattern pairs.
  const pattern = classifyPattern(name);
  if (pattern === "horizontal-push") {
    if (/\b(?:fly|flye|flyes|flies|pec deck|crossover)\b/.test(n)) return null;
    return "horizontal-push";
  }
  if (pattern === "horizontal-pull") return "horizontal-pull";
  if (pattern === "vertical-pull") {
    if (/\bpullovers?\b/.test(n)) return null;
    return "vertical-pull";
  }
  return null;
}
