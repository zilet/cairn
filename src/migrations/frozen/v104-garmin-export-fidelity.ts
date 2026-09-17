// Frozen snapshot of src/repo/garmin-authorship.ts's rules as of 2026-09-17; migrations
// must not track live code.
//
// WHY A COPY AND NOT AN IMPORT. A migration is a statement about what the ladder did
// on the day it shipped. Importing the live module means a fresh install replays that
// migration against TODAY's semantics — a silently different repair from the one every
// existing database received. The live module stays free to evolve; this snapshot does
// not. Do not "fix" a bug here: fix it in the live module and, if old rows need it,
// append a NEW migration.
//
// DO NOT REFORMAT. This file is a verbatim copy; a formatter reflowing it would
// break the one property that makes it auditable — that every line still matches
// the live source it was taken from.
//
// WHAT v104 REPAIRS. Cairn writes finished strength sessions back to Garmin as a
// manual "shell" activity. The inbound sync then read that shell the way it reads a
// run: `movingDuration` for the time and `calories` verbatim. On a shell neither means
// what it means on a watch recording — `movingDuration` is the summed length of the
// 45-second ACTIVE slots Cairn wrote (a 34-minute session came back as 6), and
// `calories` is Garmin's own auto-calculation for an activity with no heart rate, a
// constant 65.534 flagged `isAutoCalcCalories`. Both landed in `garmin_activities` and
// then in `sessions.garmin_json`, where the training log reads them.

/** The suffix every activity Cairn creates on Garmin carries. */
export const CAIRN_ACTIVITY_MARKER = " · Cairn";

/**
 * The constant Garmin stores as `calories` on a manual activity it auto-calculated
 * with nothing to calculate from. Not a measurement — an artifact of the encoding.
 */
export const GARMIN_AUTOCALC_CALORIE_SENTINEL = 65.534;

/**
 * The four values `garmin_daily_metrics.hrv_status` is documented to hold. Garmin also
 * sends `NONE` — the watch saying it has NO status yet, which stored verbatim reads as
 * a status everywhere the coach context renders it beside "balanced".
 */
export const GARMIN_HRV_STATUSES = ["balanced", "unbalanced", "low", "poor"];

/** Did Cairn create this activity? Read off the name it gave itself. */
export function isCairnAuthoredName(name: unknown): boolean {
  return String(name ?? "").trimEnd().endsWith(CAIRN_ACTIVITY_MARKER);
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The provider payload as stored, or null when it is missing or unparseable. */
export function parseRawActivity(raw: unknown): Record<string, any> | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** Whole minutes, one decimal, from a raw payload's elapsed `duration` in seconds. */
export function elapsedMinutesFromRaw(raw: Record<string, any> | null): number | null {
  const seconds = finite(raw?.duration);
  if (seconds == null || seconds <= 0) return null;
  return Math.round((seconds / 60) * 10) / 10;
}

/** True when this stored calorie figure is the auto-calc placeholder, not a reading. */
export function isPlaceholderCalories(calories: unknown, raw: Record<string, any> | null): boolean {
  const value = finite(calories);
  if (value == null) return false;
  if (value === GARMIN_AUTOCALC_CALORIE_SENTINEL) return true;
  return raw?.isAutoCalcCalories === true;
}

export interface GarminBlobRepairContext {
  /** The session's OWN duration, which is the measurement when the carrier is ours. */
  sessionDurationMin: number | null;
  /** The repaired duration of the Cairn-authored activity fronting this blob. */
  activityDurationMin: number | null;
}

/**
 * Pull one session's reconciled Garmin blob back onto the repaired numbers. Mutates in
 * place and reports whether anything moved, so an already-correct row is left
 * byte-identical (it is only re-serialized when the repair actually changed something).
 *
 * Narrow on purpose: it touches `duration_min` only when the new value is LONGER (the
 * defect only ever shortened it) and `calories` only when the stored figure is exactly
 * the placeholder. A watch recording's own numbers are never in scope — this only ever
 * runs for a blob fronted by an activity Cairn authored.
 */
export function repairCairnAuthoredGarminBlob(blob: Record<string, any>, ctx: GarminBlobRepairContext): boolean {
  let changed = false;
  const best = Math.max(ctx.sessionDurationMin ?? 0, ctx.activityDurationMin ?? 0);
  const stored = finite(blob.duration_min) ?? 0;
  if (best > 0 && best > stored) {
    blob.duration_min = best;
    changed = true;
  }
  if (finite(blob.calories) === GARMIN_AUTOCALC_CALORIE_SENTINEL) {
    blob.calories = null;
    changed = true;
  }
  return changed;
}
