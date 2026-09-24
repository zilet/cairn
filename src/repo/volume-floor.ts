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

// Every deliberately light week the floor stands aside for. The first four are read
// off the live context (volume-floor-context.ts); `athlete_asked_less` is the
// athlete's own words on the request being drafted (athleteAskedForLess below).
export type VolumeFloorExemption =
  | "recovery_week" // an active or scheduled recovery week
  | "deload_phase" // the active block is in (or about to enter) its deload
  | "deload_due" // the mesocycle read says a deload is earned
  | "race_taper" // this week or next is the race taper or race week
  | "athlete_asked_less";

// Words an athlete uses when they ask for LESS: a lighter week, fewer sets or days, a
// trip, a short-on-time stretch. Deliberately generous — a floor pushed onto a week the
// athlete asked to be lighter is the worse error, so anything that reads like "less"
// exempts. Only ever applied to the athlete's own words, never to a system instruction.
const ASKED_FOR_LESS = [
  /\blight(?:er|en)?\b/i,
  /\b(?:less|fewer|reduc\w*|cut(?:ting)?\s+(?:back|down)|scale\s+(?:back|down)|trim\w*|drop\w*|shorter|shorten\w*)\b/i,
  /\beas(?:e|ier|ing)\b/i,
  /\bback\s+off\b/i,
  /\b(?:deload|recover\w*|rest(?:\s+week)?|taper\w*)\b/i,
  /\b(?:travel\w*|trip|vacation|holiday|hotel|away\s+from|on\s+the\s+road)\b/i,
  /\b(?:short\s+on\s+time|busy|no\s+time|limited\s+time|time[-\s]crunch\w*|quick(?:er)?|minimal|minimum)\b/i,
  /\b(?:tired|exhausted|burn(?:ed|t)?\s*out|sick|ill|injur\w*|sore|pain)\b/i,
  /\b(?:two|three|2|3)[-\s]?days?\b/i,
];

/** Does this athlete-authored request ask for a lighter / smaller week? Cautious toward yes. */
export function athleteAskedForLess(text: unknown): boolean {
  const words = String(text ?? "").trim();
  if (!words) return false;
  return ASKED_FOR_LESS.some((re) => re.test(words));
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
