// Pure, dependency-free helpers for identifying a hand-logged "shadow" of a
// synced activity — kept in their own leaf module (no imports) rather than in
// src/repo/activities.ts because activities.ts imports src/repo/training-read.ts
// (deriveSessionTitle), and training-read.ts is deliberately kept leaf so
// sessions/activities/intelligence (which import each other) never cycle through
// it. A COUNTING read of `activities` inside training-read.ts (or any other leaf
// consumer) can safely import from HERE without reopening that cycle. Its one
// import, endurance-sports.ts, is itself import-free.
//
// A SHADOW is a hand log (no source, no external id) written AFTER a synced row
// already holds the same effort — "morning run (fasted)" typed into chat an hour
// after the watch synced it. The insert-time soft-dedup never sees it (it only
// fires when the synced row arrives second), and the row is not erased at read
// time either: it is the athlete's own words, often carrying a note the watch
// never had. Reads that COUNT or MEASURE efforts skip it instead, so one run
// never reads as two. A shadow shares the date and modality of a sourced row,
// and every measurement it carries agrees with that row under the same
// tolerances the soft-dedup uses; a row that carries none adds no volume and no
// pace, only a phantom second outing. A metric that DISAGREES keeps it a real
// effort (a genuine second run the same day).

import { activityLoadFamily } from "./endurance-sports.js";

export function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function duplicateMetricError(a: unknown, b: unknown, absoluteTolerance: number, relativeTolerance: number) {
  const left = positiveNumber(a);
  const right = positiveNumber(b);
  if (left == null || right == null) return null;
  const tolerance = Math.max(absoluteTolerance, Math.max(left, right) * relativeTolerance);
  const error = Math.abs(left - right) / tolerance;
  return error <= 1 ? error : Number.POSITIVE_INFINITY;
}

// Same folding rule addActivity/getCardioForDate rely on: separator-normalized,
// leading-word-boundary matched, endurance checks before the strength/cardio
// catch-all so a strength activity never reads as a run/ride. Unknown types fall
// through to the lowercased original so they never cross-match.
export function normalizeGarminType(t: unknown): string {
  const s = String(t ?? "").toLowerCase();
  const m = s.replace(/[_-]+/g, " ");
  if (/\b(run|running|jog|trail running|treadmill|tempo|interval)/.test(m)) return "run";
  if (/\b(cycl|bike|biking|biked|mountain|mtb|gravel|ride|rode|road biking)/.test(m)) return "ride";
  if (/\b(swim|swimming|swam)/.test(m)) return "swim";
  if (/\b(walk|walked|hike|hiked|hiking|ruck|fell)/.test(m)) return "hike";
  if (/\b(strength|cardio|training|fitness equipment)/.test(m)) return "other";
  return s || "other";
}

// The modality a shadow is compared within: normalizeGarminType's coarse bucket, with
// paddle (and combat) sports folded to one stable bucket each so a hand-typed "kayak" and the
// watch's "kayaking_v2" read as the same outing. Shadow detection only: the STORED
// type (normalizeGarminType) keeps the provider's own key.
export function shadowModality(t: unknown): string {
  const bucket = normalizeGarminType(t);
  if (["run", "ride", "swim", "hike"].includes(bucket)) return bucket;
  const family = activityLoadFamily(t).family;
  return family === "paddle" || family === "combat" ? family : bucket;
}

// A hand-typed "boxing" beside the watch's "boxing" is one outing too (combat, 2026-11-07).
const SHADOW_MODALITIES = ["run", "ride", "swim", "hike", "paddle", "combat"];

export interface ShadowCheckActivity {
  id?: unknown;
  date: unknown;
  type: unknown;
  source?: unknown;
  external_id?: unknown;
  duration_min?: unknown;
  distance_km?: unknown;
}

function isSourcedActivity(row: ShadowCheckActivity): boolean {
  return row.source != null && String(row.source).trim() !== "";
}

/**
 * The synced row `row` shadows, or null when `row` is its own effort. Same rule as
 * isShadowActivity (which is this, non-null); exposed so a history list can FLAG a
 * shadow (`shadow_of`) instead of hiding the athlete's own entry.
 */
export function shadowedActivity<T extends ShadowCheckActivity>(row: ShadowCheckActivity, sameDay: T[]): T | null {
  if (isSourcedActivity(row) || (row.external_id != null && String(row.external_id).trim() !== "")) return null;
  const modality = shadowModality(row.type);
  if (!SHADOW_MODALITIES.includes(modality)) return null;
  const match = sameDay.find((other) => {
    if (other === row || !isSourcedActivity(other)) return false;
    if (String(other.date).slice(0, 10) !== String(row.date).slice(0, 10)) return false;
    if (shadowModality(other.type) !== modality) return false;
    const durationError = duplicateMetricError(row.duration_min, other.duration_min, 3, 0.08);
    const distanceError = duplicateMetricError(row.distance_km, other.distance_km, 0.3, 0.05);
    // A metric the hand log carries but the synced row lacks cannot be vouched for.
    if (positiveNumber(row.duration_min) != null && durationError == null) return false;
    if (positiveNumber(row.distance_km) != null && distanceError == null) return false;
    return [durationError, distanceError].every((error) => error == null || Number.isFinite(error));
  });
  return match ?? null;
}

export function isShadowActivity(row: ShadowCheckActivity, sameDay: ShadowCheckActivity[]): boolean {
  return shadowedActivity(row, sameDay) != null;
}

/** `rows` with every shadow hand log (see isShadowActivity) dropped. Order kept. */
export function withoutShadowActivities<T extends ShadowCheckActivity>(rows: T[]): T[] {
  const byDate = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(row.date).slice(0, 10);
    const list = byDate.get(key);
    if (list) list.push(row);
    else byDate.set(key, [row]);
  }
  return rows.filter((row) => !isShadowActivity(row, byDate.get(String(row.date).slice(0, 10)) ?? []));
}
