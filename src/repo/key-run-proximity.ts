// ============================================================================
// key-run-proximity.ts — ONE rule for "is this lifting weekday too close to a key run?"
//
// A heavy lower lift day sits too close to a key run (a stated quality or long run; an
// easy run is not a key run) when it lands ON that run's day, the day BEFORE it (the legs
// go into the run worked), or the day AFTER it (the legs are still carrying the run). Two
// readers share it and so can never disagree:
//   - plan-selection.ts `keyRunAwarePlacement` — trades such a day onto a clear weekday
//     when one is free (the live week map and the first week);
//   - week-layout.ts `lowerLiftPlacement` — the read of where the week's heaviest lower
//     day sits (`eve_of_key_run` / `on_key_run` / `after_key_run`, else `neutral`, the only
//     preferred state).
// Pure and dependency-free. Weekdays are JS dows (0 = Sunday … 6 = Saturday); the week
// wraps (Monday follows Sunday's long run).
// ============================================================================

export type KeyRunRelation = "eve" | "on" | "after";

/** The weekday before / after `dow` on the wrapping week. */
export const dowBefore = (dow: number): number => (((dow - 1) % 7) + 7) % 7;
export const dowAfter = (dow: number): number => (((dow + 1) % 7) + 7) % 7;

/**
 * How `dow` relates to the key runs, the WORST relation first: the eve of a key run, then
 * a key run's own day, then the day after one. null when it sits clear of every key run.
 */
export function keyRunRelation(dow: number, keyRunDows: Iterable<number>): KeyRunRelation | null {
  const keyRuns = new Set([...keyRunDows].map((d) => ((Math.trunc(d) % 7) + 7) % 7));
  const d = ((Math.trunc(dow) % 7) + 7) % 7;
  if (keyRuns.has(dowAfter(d))) return "eve";
  if (keyRuns.has(d)) return "on";
  if (keyRuns.has(dowBefore(d))) return "after";
  return null;
}

/** Whether `dow` is a key-run day or the day either side of one (the placement trade's trigger). */
export function nearKeyRun(dow: number, keyRunDows: Iterable<number>): boolean {
  return keyRunRelation(dow, keyRunDows) != null;
}
