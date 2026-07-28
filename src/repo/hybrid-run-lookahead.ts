// Override hybridDayContext.planned_run_next with the flexible training agenda's
// soonest open key run (quality/long). Template projection in hybridDayContext stays
// the fallback only when the agenda is unavailable or errors.
//
// Lives outside training-read.ts on purpose: flexible-training-agenda already imports
// from training-read (cardioEffort, sessionLoad), so training-read must never import
// the agenda (or this module would re-create the cycle if inlined there).
import type { WeeklyRunPlan } from "./run-progression.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import type { HybridDayContext } from "./training-read.js";

export type HybridRunLookaheadOpts = {
  /** Test injection — mirrors flexibleTrainingAgenda's runPlan override. */
  runPlan?: WeeklyRunPlan | null;
};

/**
 * Prefer the flexible agenda's next open key run over the fixed weekly-template
 * projection for `planned_run_next`. Other hybrid fields are left untouched.
 */
export function withFlexibleRunLookahead(
  base: HybridDayContext,
  date: string,
  opts?: HybridRunLookaheadOpts
): HybridDayContext {
  try {
    const agenda = flexibleTrainingAgenda(date, opts?.runPlan !== undefined ? { runPlan: opts.runPlan } : undefined);
    // Once the agenda is available it is the source of truth: a fixed template
    // must not resurrect work the rolling, actual-log-aware agenda has closed,
    // intentionally left undated, or reduced to easy-only work.
    if (!agenda.available) return base;

    const keyOpen = agenda.intents
      .filter(
        (intent) =>
          intent.status === "open" &&
          (intent.kind === "quality" || intent.kind === "long") &&
          intent.suggested_date
      )
      .sort((a, b) => {
        const byDate = a.suggested_date!.localeCompare(b.suggested_date!);
        if (byDate !== 0) return byDate;
        // Stable tie-break: quality before long on the same suggested day.
        if (a.kind === b.kind) return 0;
        return a.kind === "quality" ? -1 : 1;
      });

    const next = keyOpen[0];
    if (!next?.suggested_date) return { ...base, planned_run_next: null };

    return {
      ...base,
      planned_run_next: {
        date: next.suggested_date,
        kind: next.kind,
        km: next.target_distance_km,
      },
    };
  } catch {
    return base;
  }
}
