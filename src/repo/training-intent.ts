import { effectiveGoalMode, getProfile, normalizeDiscipline, type GoalMode } from "./profile.js";

export const TRAINING_PRIORITIES = ["longevity", "muscle", "leanness", "strength", "endurance"] as const;
export type TrainingPriority = (typeof TRAINING_PRIORITIES)[number];
export type EnduranceRole = "none" | "supporting" | "co_primary" | "primary";

export interface EnduranceCapacityTarget {
  sport: string;
  target_duration_min: number;
  context?: string | null;
}

export interface TrainingIntent {
  priorities: TrainingPriority[];
  endurance_role: EnduranceRole;
  endurance_capacity?: EnduranceCapacityTarget | null;
}

export interface ResolvedTrainingIntent extends TrainingIntent {
  source: "explicit" | "derived";
}

const PRIORITY_SET = new Set<TrainingPriority>(TRAINING_PRIORITIES);
const ENDURANCE_ROLES = new Set<EnduranceRole>(["none", "supporting", "co_primary", "primary"]);

function capString(value: unknown, max: number): string | null {
  if (value == null) return null;
  const clean = String(value).trim().replace(/\s+/g, " ").slice(0, max);
  return clean || null;
}

function normalizeCapacity(value: unknown): EnduranceCapacityTarget | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sport = capString(raw.sport, 60);
  const duration = Number(raw.target_duration_min);
  if (!sport || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    sport,
    target_duration_min: Math.max(1, Math.min(1_440, Math.round(duration))),
    context: capString(raw.context, 240),
  };
}

/**
 * Normalize the profile-facing intent contract. Invalid values return null so a
 * persisted malformed/unknown shape safely falls back to the legacy-derived read.
 */
export function normalizeTrainingIntent(value: unknown): TrainingIntent | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.priorities)) return null;
  const priorities: TrainingPriority[] = [];
  for (const item of obj.priorities) {
    const priority = String(item ?? "")
      .trim()
      .toLowerCase() as TrainingPriority;
    if (PRIORITY_SET.has(priority) && !priorities.includes(priority)) priorities.push(priority);
    if (priorities.length === 5) break;
  }
  const role = String(obj.endurance_role ?? "")
    .trim()
    .toLowerCase() as EnduranceRole;
  if (!priorities.length || !ENDURANCE_ROLES.has(role)) return null;
  const hasCapacity = Object.hasOwn(obj, "endurance_capacity");
  const capacity = hasCapacity ? normalizeCapacity(obj.endurance_capacity) : null;
  if (hasCapacity && obj.endurance_capacity != null && capacity == null) return null;
  return {
    priorities,
    endurance_role: role,
    endurance_capacity: capacity,
  };
}

export function serializeTrainingIntent(value: unknown): string | null {
  if (value == null) return null;
  const normalized = normalizeTrainingIntent(value);
  return normalized ? JSON.stringify(normalized) : null;
}

function derivedPriorities(discipline: "strength" | "endurance" | "hybrid", mode: GoalMode): TrainingPriority[] {
  const priorities: TrainingPriority[] =
    discipline === "endurance"
      ? ["endurance", "longevity", "strength"]
      : discipline === "hybrid"
        ? ["strength", "endurance", "muscle", "longevity"]
        : ["strength", "muscle", "longevity"];
  if (mode === "lose") {
    const insertAt = discipline === "endurance" ? 1 : 2;
    priorities.splice(insertAt, 0, "leanness");
  } else if (mode === "gain") {
    const withoutMuscle: TrainingPriority[] = priorities.filter((priority) => priority !== "muscle");
    withoutMuscle.unshift("muscle");
    return withoutMuscle.slice(0, 5);
  }
  return [...new Set(priorities)].slice(0, 5);
}

/**
 * Resolve the athlete's durable goal hierarchy. Explicit intent wins; old
 * profiles keep their prior discipline/goal-mode behavior through a derived view.
 */
export function getTrainingIntent(profile?: any): ResolvedTrainingIntent {
  const athlete = profile ?? getProfile() ?? {};
  const explicit = normalizeTrainingIntent(athlete.training_intent_json);
  if (explicit) return { ...explicit, source: "explicit" };
  const discipline = normalizeDiscipline(athlete.primary_discipline, athlete.primary_discipline);
  const endurance_role: EnduranceRole =
    discipline === "endurance" ? "primary" : discipline === "hybrid" ? "co_primary" : "none";
  return {
    priorities: derivedPriorities(discipline, effectiveGoalMode(athlete)),
    endurance_role,
    endurance_capacity: null,
    source: "derived",
  };
}

function priorityIndex(priorities: readonly string[] | undefined, key: string): number {
  if (!priorities) return -1;
  return priorities.indexOf(key);
}

/**
 * Endurance sits behind both muscle and strength in the athlete's own order
 * (or is absent while both of those are present). Used as a ranking fallback
 * when the stored role is missing or unrecognized — never to override an
 * explicit co_primary / primary role.
 */
export function enduranceRanksBelowMuscleAndStrength(
  priorities: readonly string[] | undefined
): boolean {
  const muscle = priorityIndex(priorities, "muscle");
  const strength = priorityIndex(priorities, "strength");
  if (muscle < 0 || strength < 0) return false;
  const endurance = priorityIndex(priorities, "endurance");
  const endRank = endurance < 0 ? Number.POSITIVE_INFINITY : endurance;
  return muscle < endRank && strength < endRank;
}

/**
 * Strength/muscle is the block's main work only when the athlete actually
 * stated their hierarchy (`source === "explicit"`) AND the role is
 * none/supporting — or, when the role is missing, endurance ranked below both
 * muscle and strength. Derived intent keeps the endurance-led tree, including
 * the default `endurance_role: "none"` every never-set strength athlete gets.
 * co_primary / primary also keep that tree.
 */
export function isStrengthLedIntent(intent: TrainingIntent | ResolvedTrainingIntent | null | undefined): boolean {
  if (!intent || (intent as { source?: string }).source !== "explicit") return false;
  const role = intent.endurance_role;
  if (role === "none" || role === "supporting") return true;
  if (role === "co_primary" || role === "primary") return false;
  return enduranceRanksBelowMuscleAndStrength(intent.priorities);
}

/**
 * Which of muscle vs strength sits higher in the priority order. Muscle before
 * strength (or muscle present and strength absent) ⇒ hypertrophy; otherwise strength.
 */
export function muscleLeadsStrength(priorities: readonly string[] | undefined): boolean {
  const muscle = priorityIndex(priorities, "muscle");
  const strength = priorityIndex(priorities, "strength");
  if (muscle < 0) return false;
  if (strength < 0) return true;
  return muscle < strength;
}
