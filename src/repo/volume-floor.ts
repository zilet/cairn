// The weekly volume FLOOR a plan is held to — the low side of MUSCLE_LANDMARKS.
//
// The plan compiler always knew when a group was planned ABOVE its high landmark
// (`muscle_density_high`) and said nothing when one sat BELOW its low one. An
// agent-authored week could prescribe 1-2 working sets on most items, leave chest
// at half its low landmark, and read clean — while the balance read called the
// same groups due for weeks. This module is the one place that says which groups
// the floor applies to for THIS athlete, and at what number. It is pure: the plan
// compiler (plan-quality.ts), the redraw precheck (verify-floors.ts) and the prompt
// all read the same targets, and the live context that feeds them is resolved once
// by `readVolumeFloorContext` (volume-floor-context.ts).
//
// The floor is CONTEXTUAL, never a universal rule:
//   - it applies only when the athlete's own intent puts muscle or strength among
//     their priorities, and endurance is not the primary role — an endurance-led
//     athlete's supporting lifting is not measured against hypertrophy landmarks;
//   - the major movers (chest, back, shoulders, quads, hamstrings, glutes) are held
//     to it whenever it applies; the smaller groups (arms, calves) only when muscle
//     itself is a stated priority;
//   - a group the athlete's endurance work is already carrying is EXEMPT, by the
//     same rule the balance read uses to stop calling it "due" (the legs' lifting
//     prime movers never qualify — running keeps them busy, not stronger);
//   - a deliberate recovery week or a deload phase is exempt outright: a light week
//     is what it is FOR.
import { MUSCLE_LANDMARKS } from "./exercise-canon.js";

export interface VolumeFloorContext {
  /** The athlete's intent names strength (and endurance is not the primary role). */
  strength_priority: boolean;
  /** The athlete's intent names muscle (and endurance is not the primary role). */
  muscle_priority: boolean;
  /** Groups the athlete's endurance work is already carrying — exempt from the floor. */
  endurance_carried: string[];
  /** A deliberate light window in force (or about to be); no floor applies while it is. */
  exempt: VolumeFloorExemption | null;
}

// Every deliberately light week the floor stands aside for, read off the live context
// (volume-floor-context.ts). The athlete's own words are NOT an exemption: a request
// for less still goes through the precheck and the repair turn (which is handed the
// words to honor); it only keeps an unresolved finding from HOLDING the draft
// (athleteAskedForLess below).
export type VolumeFloorExemption =
  | "recovery_week" // an active or scheduled recovery week
  | "deload_phase" // the active block is in (or about to enter) its deload
  | "deload_due" // the mesocycle read says a deload is earned
  | "race_taper"; // this week or next is the race taper or race week

// EXPLICIT reductions of the week or its volume — nothing looser. A word that merely
// sits near "less" is not a request for less: "less cardio, more lifting" asks for
// more, "sore in my knee" is a symptom (it has its own path), "sick of lunges" is a
// swap, "shorter rest times" is density. Each pattern names the week/volume/training
// it reduces, or is a phrase that only ever means that ("deload", "short on time").
const ASKED_FOR_LESS: RegExp[] = [
  // a lighter/easier/easy week (or session, block, training)
  /\b(?:light(?:er)?|easier|easy)\s+(?:this\s+|next\s+|a\s+|the\s+)?(?:week|weeks|session|sessions|block|training|workouts?)\b/i,
  /\b(?:this|next)\s+week\b[^.!?]{0,20}\b(?:light(?:er)?|easier|easy)\b/i,
  /\b(?:make|keep|take)\s+(?:it|things|the\s+week|this\s+week)\s+(?:a\s+(?:bit|little)\s+)?(?:light(?:er)?|easier|easy)\b/i,
  /\bgo\s+(?:light(?:er)?|easier|easy)\b/i,
  /\bdeload\b/i,
  // fewer sets / days / sessions; less volume / training
  /\bfewer\s+(?:working\s+)?(?:sets|days|sessions|workouts|training\s+days|lifting\s+days)\b/i,
  /\bless\s+(?:volume|training|lifting|work)\b/i,
  /\breduce\s+(?:the\s+|my\s+)?(?:volume|sets|training|lifting)\b/i,
  // cut / scale / dial back ON the volume or the training (or with nothing after)
  /\b(?:cut|scale|dial)\s+(?:it\s+)?(?:back|down)\s+(?:on\s+)?(?:the\s+|my\s+)?(?:volume|training|sets|lifting|work)\b/i,
  /\b(?:cut|scale|dial)\s+(?:it\s+|things\s+)?(?:back|down)\s*(?:(?:this|next)\s+week|for\s+a\s+(?:week|bit))?\s*[.!]?\s*$/i,
  /\bshort\s+on\s+time\b/i,
  /\b(?:don'?t|do\s+not)\s+have\s+(?:much\s+)?time\b/i,
  // away this week
  /\b(?:travel(?:l)?ing|away|on\s+the\s+road|on\s+a\s+trip)\b[^.!?]{0,20}\b(?:this|next)\s+week\b/i,
  /\b(?:this|next)\s+week\b[^.!?]{0,20}\b(?:travel(?:l)?ing|away|on\s+the\s+road|on\s+a\s+trip)\b/i,
];

// "less X, more Y" / "fewer X, more Y" asks for a trade, not a reduction.
const CONTRAST = /\b(?:less|fewer)\b[^.!?]*\bmore\b|\bmore\b[^.!?]*\b(?:less|fewer)\b/i;
// A negation just before the match flips it ("don't make it lighter", "no deload").
const NEGATION = /\b(?:no|not|don'?t|do\s+not|never|without|instead\s+of)\s+(?:\w+\s+){0,2}$/i;

/**
 * Does this athlete-authored request explicitly ask for a lighter / smaller week?
 * Narrow on purpose (see ASKED_FOR_LESS). What it buys is small: an unresolved volume
 * finding on such a request does not HOLD the draft — the precheck and the repair
 * turn still run, with the athlete's words in hand.
 */
export function athleteAskedForLess(text: unknown): boolean {
  const words = String(text ?? "").trim();
  if (!words || CONTRAST.test(words)) return false;
  for (const re of ASKED_FOR_LESS) {
    const match = re.exec(words);
    if (!match) continue;
    if (NEGATION.test(words.slice(0, match.index))) continue;
    return true;
  }
  return false;
}

export interface WeeklySetTarget {
  group: string;
  /** Effective weekly working sets below which the group is under-dosed. */
  low: number;
  /** The high landmark — above it the compiler already warns. */
  high: number;
}

const MAJOR_GROUPS = ["chest", "back", "shoulders", "quads", "hamstrings", "glutes"] as const;
const MUSCLE_ONLY_GROUPS = ["biceps", "triceps", "calves"] as const;

export function volumeFloorApplies(ctx: VolumeFloorContext | null | undefined): ctx is VolumeFloorContext {
  return !!ctx && !ctx.exempt && (ctx.strength_priority || ctx.muscle_priority);
}

/**
 * The per-group weekly set targets this athlete's plan is held to, landmark low..high.
 * Empty when the floor does not apply (no muscle/strength priority, or a light window).
 */
export function weeklySetTargets(ctx: VolumeFloorContext | null | undefined): WeeklySetTarget[] {
  if (!volumeFloorApplies(ctx)) return [];
  const carried = new Set(ctx.endurance_carried.map((g) => String(g).toLowerCase()));
  const groups: string[] = [...MAJOR_GROUPS, ...(ctx.muscle_priority ? MUSCLE_ONLY_GROUPS : [])];
  const out: WeeklySetTarget[] = [];
  for (const group of groups) {
    const landmark = MUSCLE_LANDMARKS[group];
    if (!landmark || carried.has(group)) continue;
    out.push({ group, low: landmark.low, high: landmark.high });
  }
  return out;
}
