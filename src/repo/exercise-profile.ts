// An agent's profile of what a lift IS: its movement pattern, region, primary muscle group and
// synergists, estimated once per lift (enrich.ts, `exercise_profile` jobs and the 'exercise'
// enrichment) and stored in `exercise_profile`.
//
// THE AGENT FILLS GAPS ONLY. The order of authority for any answer about a lift is
//   1. a person's own value (a group stored with muscle_group_source 'user' is never moved),
//   2. the curated deterministic tables (classifyPattern's rules, movementRegionKey's rules,
//      the named-lift credit rows),
//   3. this profile,
//   4. the name classifier's guess.
// The three classifiers consult the profile only where they would otherwise answer nothing
// (exercise-profile-lookup.ts is the cheap cached read they share); a profile that DISAGREES
// with a curated answer is stored, never applied, and shown on the exercise detail read
// (`disagrees_with_curated`) and nowhere else.
//
// Every value an agent names is held to the engine's own vocabularies: an unknown pattern,
// region or group is dropped (that field only), never added as a new category.
import { db } from "../db.js";
import { canonicalGroup, isPlaceholderExerciseName, MUSCLE_GROUPS, type MuscleGroup, resolveExerciseName } from "./exercise-canon.js";
import { classifyPatternCurated, isMovementPattern, MOVEMENT_PATTERNS } from "./exercise-variations.js";
import { isMovementRegion, MOVEMENT_REGIONS, movementRegionKeyCurated } from "./movement-region.js";
import { curatedMuscleCredit, curatedMuscleGroup, HALF_SHARE, TOUCHED_SHARE } from "./muscle-credit.js";
import { bumpTrainingDataVersion } from "./training-cache.js";

/**
 * The version of the profile RULES: the vocabularies and the prompt the agent answers. A row
 * stamped with an older version is re-classified at the next boot (the backfill queries for
 * "no row at the current version"), so bumping this is how a better contract re-runs the library.
 */
export const EXERCISE_PROFILE_RULES_VERSION = 1;

export const PROFILE_LENGTH_BIAS = ["lengthened", "mid", "shortened"] as const;
export type ProfileLengthBias = (typeof PROFILE_LENGTH_BIAS)[number];
export const PROFILE_CONFIDENCE = ["high", "medium", "low"] as const;
export type ProfileConfidence = (typeof PROFILE_CONFIDENCE)[number];
export type ProfileSource = "agent" | "user";

/**
 * The synergist shares the credit model has: 0.5 is COUNTED toward volume, 0.25 only TOUCHED
 * (muscle-credit.ts HALF_SHARE / TOUCHED_SHARE; a test pins the two together). Literals here,
 * not the imports: this module sits in an import cycle with the classifiers, so nothing may
 * read another module's binding while it is still loading.
 */
export const PROFILE_SHARES: readonly number[] = [0.5, 0.25];
const MAX_SECONDARIES = 4;

/**
 * The vocabularies an agent is shown and held to. Getters, for the same reason as above: the
 * tables live in modules this one is loaded alongside, and are read only when asked.
 */
export const PROFILE_VOCABULARY = {
  get patterns() {
    return MOVEMENT_PATTERNS;
  },
  get regions() {
    return MOVEMENT_REGIONS;
  },
  get groups() {
    return MUSCLE_GROUPS;
  },
  length_bias: PROFILE_LENGTH_BIAS,
  shares: PROFILE_SHARES,
  confidence: PROFILE_CONFIDENCE,
};

export interface ProfileSecondary {
  group: MuscleGroup;
  share: number;
}

/** A profile after validation: every field is in-vocabulary or null. */
export interface SanitizedExerciseProfile {
  pattern: string | null;
  region: string | null;
  primary_group: MuscleGroup | null;
  secondary: ProfileSecondary[];
  length_bias: ProfileLengthBias | null;
  compound: boolean | null;
  confidence: ProfileConfidence;
}

export interface ExerciseProfile extends SanitizedExerciseProfile {
  exercise_id: number;
  source: ProfileSource;
  agent: string | null;
  rules_version: number;
  classified_at: string | null;
}

function lowered(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v || null;
}

/**
 * Hold an agent's (or a person's) profile to the engine's vocabularies. A field outside them is
 * dropped on its own; the rest of the profile stands. Never throws, never invents a value.
 * `confidence` falls to "low" (stored, never applied) when missing or unreadable.
 */
export function sanitizeExerciseProfile(raw: unknown): SanitizedExerciseProfile {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const patternText = lowered(r.pattern);
  const pattern = patternText && isMovementPattern(patternText) ? patternText : null;

  const regionText = lowered(r.region);
  const region = regionText && isMovementRegion(regionText) ? regionText : null;

  const primary = canonicalGroup(typeof r.primary_group === "string" ? r.primary_group : null);

  const secondary: ProfileSecondary[] = [];
  const rawSecondary = Array.isArray(r.secondary) ? r.secondary : [];
  for (const item of rawSecondary) {
    if (secondary.length >= MAX_SECONDARIES) break;
    const group = canonicalGroup(typeof (item as any)?.group === "string" ? (item as any).group : null);
    const share = Number((item as any)?.share);
    if (!group || group === primary || group === "mobility") continue;
    if (!PROFILE_SHARES.some((s) => Math.abs(s - share) < 1e-9)) continue;
    if (secondary.some((s) => s.group === group)) continue;
    secondary.push({ group, share: share > 0.4 ? HALF_SHARE : TOUCHED_SHARE });
  }

  const biasText = lowered(r.length_bias);
  const length_bias = (PROFILE_LENGTH_BIAS as readonly string[]).includes(biasText ?? "") ? (biasText as ProfileLengthBias) : null;

  const compound = typeof r.compound === "boolean" ? r.compound : r.compound === 1 ? true : r.compound === 0 ? false : null;

  const confText = lowered(r.confidence);
  const confidence = (PROFILE_CONFIDENCE as readonly string[]).includes(confText ?? "") ? (confText as ProfileConfidence) : "low";

  return { pattern, region, primary_group: primary, secondary, length_bias, compound, confidence };
}

function rowToProfile(row: any): ExerciseProfile {
  let secondary: ProfileSecondary[] = [];
  try {
    const parsed = row.secondary_json ? JSON.parse(String(row.secondary_json)) : [];
    if (Array.isArray(parsed)) secondary = sanitizeExerciseProfile({ secondary: parsed }).secondary;
  } catch {
    secondary = [];
  }
  return {
    exercise_id: Number(row.exercise_id),
    pattern: row.pattern ?? null,
    region: row.region ?? null,
    primary_group: canonicalGroup(row.primary_group ?? null),
    secondary,
    length_bias: (PROFILE_LENGTH_BIAS as readonly string[]).includes(row.length_bias) ? row.length_bias : null,
    compound: row.compound == null ? null : Number(row.compound) === 1,
    confidence: (PROFILE_CONFIDENCE as readonly string[]).includes(row.confidence) ? row.confidence : "low",
    source: row.source === "user" ? "user" : "agent",
    agent: row.agent ?? null,
    rules_version: Number(row.rules_version) || 0,
    classified_at: row.classified_at ?? null,
  };
}

export function getExerciseProfile(exerciseId: number): ExerciseProfile | null {
  const row = db.prepare(`SELECT * FROM exercise_profile WHERE exercise_id = ?`).get(exerciseId);
  return row ? rowToProfile(row) : null;
}

/** A lift's stored profile, addressed by id or by any spelling the one resolver understands. */
export function exerciseProfileFor(nameOrId: string | number): ExerciseProfile | null {
  if (typeof nameOrId === "number") return Number.isFinite(nameOrId) ? getExerciseProfile(nameOrId) : null;
  const name = String(nameOrId ?? "").trim();
  if (!name) return null;
  const id = resolveExerciseName(name).exercise_id;
  return id == null ? null : getExerciseProfile(Number(id));
}

export interface WriteProfileResult {
  /** A row was written (false: the lift is gone, or a person's row stands). */
  written: boolean;
  profile: ExerciseProfile | null;
}

/**
 * THE one writer. Validates, then upserts; an agent never replaces a person's row. A profile
 * with nothing usable in it is still written (confidence low): it settles the lift for this
 * rules version so the backfill does not ask again, and the engine never applies a low row.
 */
export function writeExerciseProfile(
  exerciseId: number,
  raw: unknown,
  opts: { source?: ProfileSource; agent?: string | null; rulesVersion?: number } = {},
): WriteProfileResult {
  const source: ProfileSource = opts.source === "user" ? "user" : "agent";
  const exists = db.prepare(`SELECT id, name FROM exercises WHERE id = ?`).get(exerciseId) as { id: number; name: string } | undefined;
  if (!exists) return { written: false, profile: null };
  // A legacy placeholder row ("Unknown", "Other") is not a movement: a profile on it would start
  // crediting its old sets to a muscle group in the weekly volume. Refused for every source.
  if (isPlaceholderExerciseName(exists.name)) return { written: false, profile: null };
  const p = sanitizeExerciseProfile(raw);
  const usable = p.pattern || p.region || p.primary_group || p.secondary.length || p.length_bias || p.compound != null;
  const confidence: ProfileConfidence = usable ? p.confidence : "low";
  const result = db
    .prepare(
      `INSERT INTO exercise_profile
         (exercise_id, pattern, region, primary_group, secondary_json, length_bias, compound,
          confidence, source, agent, rules_version, classified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(exercise_id) DO UPDATE SET
         pattern = excluded.pattern, region = excluded.region, primary_group = excluded.primary_group,
         secondary_json = excluded.secondary_json, length_bias = excluded.length_bias,
         compound = excluded.compound, confidence = excluded.confidence, source = excluded.source,
         agent = excluded.agent, rules_version = excluded.rules_version, classified_at = excluded.classified_at
       WHERE exercise_profile.source != 'user' OR excluded.source = 'user'`
    )
    .run(
      exerciseId,
      p.pattern,
      p.region,
      p.primary_group,
      JSON.stringify(p.secondary),
      p.length_bias,
      p.compound == null ? null : p.compound ? 1 : 0,
      confidence,
      source,
      source === "agent" ? (opts.agent ?? null) : null,
      opts.rulesVersion ?? EXERCISE_PROFILE_RULES_VERSION,
    );
  const written = Number(result.changes) > 0;
  // A profile feeds credit reads, so a changed row is a changed training read.
  if (written) bumpTrainingDataVersion();
  return { written, profile: getExerciseProfile(exerciseId) };
}

/**
 * The lifts that still lack a profile at `version`, in the order the backfill should ask: only
 * lifts that are on the plan or have at least one logged set (a seeded, never-trained or
 * placeholder-named row is not a movement the athlete does), the plan first, then the most
 * recently trained. A person's row is never listed (nothing re-asks over it). This IS the
 * backfill's resume point: a classified lift drops out, a failed one stays, and a bumped
 * version lists every older row again. `limit` caps how many come back (the per-boot budget).
 */
export function exerciseIdsNeedingProfile(version: number = EXERCISE_PROFILE_RULES_VERSION, limit?: number): number[] {
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.name AS name,
              EXISTS (SELECT 1 FROM plan_items pi WHERE pi.exercise_id = e.id) AS in_plan,
              (SELECT MAX(s.date) FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
                WHERE ls.exercise_id = e.id) AS last_logged
         FROM exercises e
         LEFT JOIN exercise_profile p ON p.exercise_id = e.id
        WHERE (p.exercise_id IS NULL OR (p.source != 'user' AND p.rules_version < ?))
          AND (EXISTS (SELECT 1 FROM plan_items pi WHERE pi.exercise_id = e.id)
            OR EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.exercise_id = e.id))
        ORDER BY in_plan DESC, last_logged IS NULL, last_logged DESC, e.id`,
    )
    .all(version) as Array<{ id: number; name: string }>;
  const ids = rows.filter((r) => !isPlaceholderExerciseName(r.name)).map((r) => Number(r.id));
  return limit != null && limit >= 0 ? ids.slice(0, limit) : ids;
}

/** Does this one lift still lack a profile at `version` (and is no person's row standing)? */
export function exerciseNeedsProfile(exerciseId: number, version: number = EXERCISE_PROFILE_RULES_VERSION): boolean {
  const row = db.prepare(`SELECT source, rules_version FROM exercise_profile WHERE exercise_id = ?`).get(exerciseId) as
    | { source: string; rules_version: number }
    | undefined;
  if (!row) return true;
  return row.source !== "user" && Number(row.rules_version) < version;
}

export interface ExerciseProfileRead extends ExerciseProfile {
  /** True when the profile contradicts what the curated tables say about this lift (it is stored, not applied). */
  disagrees_with_curated: boolean;
  /** Which of `pattern`, `region`, `primary_group`, `secondary` differ from the curated answer. */
  disagreements: Array<"pattern" | "region" | "primary_group" | "secondary">;
  /** The stored muscle group is a different group than a high-confidence profile names (the group-correction path decides; nothing here moves it). */
  stored_group_differs: boolean;
}

function countedGroups(credits: ReadonlyArray<{ group: string; share: number; role: string }>): string[] {
  return credits
    .filter((c) => c.role === "secondary" && c.share >= HALF_SHARE - 1e-9)
    .map((c) => c.group)
    .sort();
}

/**
 * The profile as the exercise detail shows it, with where it disagrees with the curated tables.
 * A disagreement exists only where the tables gave an answer: a gap the profile fills is not one.
 * Pull-only; nothing reads this to decide anything.
 */
export function exerciseProfileRead(ex: { id: number; name: string; muscle_group?: string | null }): ExerciseProfileRead | null {
  const profile = getExerciseProfile(Number(ex.id));
  if (!profile) return null;
  const stored = ex.muscle_group ?? null;
  const disagreements: ExerciseProfileRead["disagreements"] = [];

  const curatedPattern = classifyPatternCurated(ex.name, stored ?? undefined);
  if (curatedPattern && profile.pattern && curatedPattern !== profile.pattern) disagreements.push("pattern");

  const curatedRegion = movementRegionKeyCurated(ex.name, stored);
  if (curatedRegion && profile.region && curatedRegion !== profile.region) disagreements.push("region");

  const curatedGroup = curatedMuscleGroup(ex.name);
  if (curatedGroup && profile.primary_group && curatedGroup !== profile.primary_group) disagreements.push("primary_group");

  const curated = curatedMuscleCredit(ex.name, stored);
  if (curated.settled && profile.secondary.length) {
    const theirs = profile.secondary.filter((s) => s.share >= HALF_SHARE - 1e-9).map((s) => s.group).sort();
    const ours = countedGroups(curated.credits);
    if (theirs.length !== ours.length || theirs.some((g, i) => g !== ours[i])) disagreements.push("secondary");
  }

  const storedGroup = canonicalGroup(stored);
  return {
    ...profile,
    disagrees_with_curated: disagreements.length > 0,
    disagreements,
    stored_group_differs: profile.confidence === "high" && !!storedGroup && !!profile.primary_group && storedGroup !== profile.primary_group,
  };
}
