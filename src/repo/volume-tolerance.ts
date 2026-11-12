import { cutReaffirmation } from "./cut-target.js";
import { recentPlannedVolumeVerdicts } from "./session-dose-log.js";

// VOLUME: THE PLAN'S SETS ARE THE DEFAULT, AND TOLERANCE IS LEARNED FROM THE LOG
// (owner ruling, 2026-11-12). Two reads and the bounds every volume catch-up honours,
// in one place:
//
//   - `volumeToleranceRead` — has the athlete's own log, over their recent sessions,
//     carried every planned set with load and reps held or rising? When it has, a
//     PRECAUTIONARY volume trim (soft, non-floor — daily-decision.ts) is not applied. It
//     never adds work: learning stops trimming, nothing more.
//   - `VOLUME_BOUNDS` — the ceiling on any catch-up toward what the log shows (the plan's
//     set count stepping up, progression.ts `setCatchUp`): about 1.2× the athlete's own
//     habitual per-lift set count, and about 20 weekly effective sets per muscle group
//     counted the weekly dose ledger's way. Neither is ever a target; both only cap.
//   - `affirmedCutHoldsSetCount` — inside an affirmed cut the plan's set count is not
//     raised: more sets in a deficit are tolerated, but not shown to add lean mass.
//
// Evidence (cited in docs/ARCHITECTURE.md): weekly set volume has a positive dose-response
// with diminishing returns; past ~20 weekly sets per muscle is not better; individualizing
// to ~1.2× the athlete's own prior volume beat a fixed prescription; the reliable
// overreaching marker in resistance training is a sustained performance decrease, so
// tolerance is judged on performance — never on the absence of complaints.

export const VOLUME_BOUNDS = Object.freeze({
  // A catch-up never takes a lift past this multiple of its own habitual set count.
  PER_LIFT_HABITUAL_FACTOR: 1.2,
  // …nor a muscle group's week past this many effective working sets.
  WEEKLY_EFFECTIVE_SETS_PER_GROUP: 20,
});

// The learned-tolerance window: the latest sessions with reconciled dose evidence.
export const VOLUME_TOLERANCE = Object.freeze({
  WINDOW_DAYS: 28,
  // The sessions read, newest first…
  SESSIONS: 4,
  // …of which at least this many must have a verdict, and every one must have carried
  // its planned sets at a held-or-rising load. One session that slipped answers no.
  MIN_SESSIONS: 3,
});

export interface VolumeToleranceRead {
  // Sessions that vouched, newest first (all of those read).
  sessions: number;
}

/** The athlete's log vouches for the plan's full sets, or null (it does not, or cannot yet). */
export function volumeToleranceRead(date: string): VolumeToleranceRead | null {
  const verdicts = recentPlannedVolumeVerdicts(date, {
    windowDays: VOLUME_TOLERANCE.WINDOW_DAYS,
    limit: VOLUME_TOLERANCE.SESSIONS,
  });
  if (verdicts.length < VOLUME_TOLERANCE.MIN_SESSIONS) return null;
  if (!verdicts.every((verdict) => verdict.carried)) return null;
  return { sessions: verdicts.length };
}

/** The athlete's habitual set count for a lift: the median of its recent good-set counts. */
export function habitualSetCount(counts: readonly number[]): number | null {
  const clean = counts.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/** The most sets a catch-up may give a lift whose habitual count is `habitual`. */
export function perLiftSetCeiling(habitual: number): number {
  return Math.max(1, Math.floor(habitual * VOLUME_BOUNDS.PER_LIFT_HABITUAL_FACTOR + 1e-9));
}

/** May a group whose week already holds `weekly` effective sets take `adding` more? Unknown is room. */
export function weeklyGroupHasRoom(weekly: number | null, adding: number): boolean {
  if (weekly == null || !Number.isFinite(weekly)) return true;
  return weekly + adding <= VOLUME_BOUNDS.WEEKLY_EFFECTIVE_SETS_PER_GROUP + 1e-9;
}

/** An affirmed cut is running: the plan's set count is not raised while it lasts. */
export function affirmedCutHoldsSetCount(date: string): boolean {
  try {
    return cutReaffirmation(date).reaffirmed === true;
  } catch {
    return false;
  }
}
