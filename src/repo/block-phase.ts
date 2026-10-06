/**
 * The block phase a WEEK actually runs as — one answer for every reader.
 *
 * A block's scheduled deload is the calendar's, not the body's: deload-due is earned
 * by loaded weeks and a log-confirmed shortfall, never a weeks count (program-state.ts).
 * So for an athlete who has asked to be pushed (`training_drive = 'push'`), the block's
 * own last-week deload runs as INTENSIFICATION unless the loaded-weeks evidence also
 * calls for it. An earned easy week (an applied recovery week) still holds for
 * everyone, and a steady athlete keeps the scheduled week as written.
 *
 * The progression math, the coach's block summary, the day read's effective phase,
 * the volume floor's deload exemption and the set catch-up all ask this module, so no
 * surface says "deload week" about a week the prescriptions are running as a push.
 */
import {
  type ActiveBlockContext,
  type BlockCoachSummary,
  type BlockPhase,
  activeBlockContext,
  blockForCoach,
  derivePhase,
  getActiveBlock,
} from "./program-blocks.js";
import { getProgramState } from "./program-state.js";
import { effectiveTrainingDrive } from "./training-drive.js";

export type BlockDrive = "steady" | "push";

// The drive in force on the day (a dated push stance past its end no longer counts).
function readDrive(date?: string): BlockDrive {
  return effectiveTrainingDrive(date);
}

// Whether the loaded-weeks evidence calls for a deload (program-state's mesocycle,
// read past the block's own suppression). Lazy and memoized per reader.
export function deloadEvidenceReader(date?: string): () => boolean {
  let cached: boolean | null = null;
  return () => {
    if (cached == null) {
      try {
        cached = getProgramState(date).mesocycle?.deload_evidence === true;
      } catch {
        cached = false;
      }
    }
    return cached;
  };
}

/** The block's scheduled deload is being run as intensification this week. Pure. */
export function scheduledDeloadSkipped(
  block: ActiveBlockContext | null | undefined,
  drive: BlockDrive | null | undefined,
  deloadEvidence: () => boolean
): boolean {
  return block?.scheduled_deload === true && (drive ?? "steady") === "push" && !deloadEvidence();
}

/** The phase the week runs as, given the block context. Pure. */
export function resolvedPhaseOf(
  block: ActiveBlockContext | null | undefined,
  drive: BlockDrive | null | undefined,
  deloadEvidence: () => boolean
): BlockPhase | null {
  if (!block) return null;
  return scheduledDeloadSkipped(block, drive, deloadEvidence) ? "intensification" : block.phase;
}

/** The active block's phase on `date` as the week actually runs it, or null with no block. */
export function resolvedBlockPhase(date?: string): BlockPhase | null {
  return resolvedPhaseOf(activeBlockContext(date), readDrive(date), deloadEvidenceReader(date));
}

/**
 * The coach's plain-language block summary, with the phase the week actually runs.
 * `scheduled_deload_skipped` marks a scheduled deload being run as intensification.
 */
export function coachBlockSummary(date?: string): (BlockCoachSummary & { scheduled_deload_skipped?: true }) | null {
  const summary = blockForCoach(date);
  if (!summary) return null;
  const block = activeBlockContext(date);
  if (!scheduledDeloadSkipped(block, readDrive(date), deloadEvidenceReader(date))) return summary;
  return { ...summary, phase: "intensification", scheduled_deload_skipped: true };
}

/**
 * The block's NEXT week is its scheduled deload and that deload will actually run —
 * a push athlete without the loaded-weeks evidence runs it as intensification, so a
 * volume-floor exemption for "about to enter the deload" must not fire for them.
 */
export function nextWeekScheduledDeloadRuns(
  date?: string,
  // A caller that already holds the day's program state passes its loaded-weeks
  // evidence, so this never builds a second one.
  deloadEvidence: () => boolean = deloadEvidenceReader(date)
): boolean {
  const block = getActiveBlock();
  if (!block) return false;
  const total = Number(block.total_weeks);
  const week = Number(block.week_index);
  if (!(total > 2 && week < total && derivePhase(week + 1, total, block.focus) === "deload")) return false;
  return readDrive(date) !== "push" || deloadEvidence();
}
