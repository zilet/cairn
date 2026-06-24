/**
 * trajectory.ts — ONE forward arc to the athlete's goals, with today as the
 * next step on it.
 *
 * The Brief answers "what is today"; the connected brain answers "what's going
 * on across your labs / training / body comp". Neither answers the question an
 * athlete actually carries around: *where is this all going, and is today a step
 * toward it?* `getTrajectory()` fuses the goal-shaped signals that already exist
 * — the active periodization block, an approaching race, the body-comp goal date,
 * the mesocycle's next deload, and the single highest-leverage health lever — into
 * ONE arc with a handful of milestones and a single plain clause that names where
 * the athlete is on it and what today's step is.
 *
 * It is a READ, not a planner: it never invents dates, never recomputes math that
 * a lower module already owns (the body-comp date is `projectGoalPace().projection_text`
 * VERBATIM), and degrades to a quiet NULL-shape when there's no goal, block, or race.
 *
 * Constitution invariants (binding):
 *  - NO 0-100 scores or numeric grades EVER cross this boundary. Internal
 *    coefficients (precedence rank, sort key) stay internal; only plain words +
 *    a date + an optional confidence WORD ('tentative'|'observed'|'strong') surface.
 *  - A SUGGESTION, never a gate. PULL, never push. Calm, bounded output (≤4 milestones).
 *  - Deterministic + pure + null-safe. No agent calls. Never throws on missing data.
 *
 * Cycle hygiene: this module sits UNDER the coach layer (getCoachContext imports
 * it, not the reverse). It must NEVER import coach.ts. It imports only the
 * low-level domain modules that own each signal.
 */

import {
  computeGoalCheck,
  getEnduranceGoal,
  getProfile,
  projectGoalPace,
} from "./profile.js";
import { blockForCoach, getActiveBlock } from "./program-blocks.js";
import { getProgramState } from "./program-state.js";
// forwardLook may not exist on every build of intelligence.js (it landed in a
// later round). Import the namespace and feature-detect so this module builds
// and runs against any version — never a hard dependency on a possibly-absent
// export. dayRead is always present.
import * as intelligence from "./intelligence.js";
import { getHealthSynthesis } from "./propagation.js";
import { localDateISO } from "./shared.js";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface TrajectoryMilestone {
  /** Plain-language label, e.g. "Deload week" / "Race day — Boston" / "Goal weight". */
  label: string;
  /** ISO date (YYYY-MM-DD) the milestone is anchored to, or null when it has no date. */
  when: string | null;
  /** Kind tag for rendering: 'race' | 'goal' | 'deload' | 'block' | 'lever'. */
  kind: string;
}

export interface Trajectory {
  /** Length of the arc in weeks, clamped 8–12, or null when nothing anchors it. */
  horizon_weeks: number | null;
  /** Plain-language phase of where the athlete is ("build", "accumulation", …), or null. */
  phase: string | null;
  /** 1-based week within the active block, or null when no block is running. */
  week_of: number | null;
  /** Up to 4 milestones along the arc, sorted by when (dated first, in date order). */
  milestones: TrajectoryMilestone[];
  /** Today's single concrete step on the arc, or null when there's nothing to say. */
  today_step: string | null;
  /** One plain clause naming the arc + today's step, or null when there's no goal AND no block AND no race. */
  line: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run `fn`, swallowing any throw and returning `fallback` instead. Each fusion
 * source is wrapped in its own `safe()` so one missing/throwing signal never
 * sinks the whole read — mirrors the today-agenda producer pattern.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v);
}

/** Clamp a horizon to the calm 8–12 week band; null passes through. */
function clampHorizon(weeks: number | null): number | null {
  if (weeks == null || !Number.isFinite(weeks)) return null;
  return Math.min(12, Math.max(8, Math.round(weeks)));
}

/** Add `weeks` whole weeks to an ISO day and return the ISO day. */
function addWeeksISO(fromISO: string, weeks: number): string | null {
  const ms = Date.parse(`${fromISO}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + weeks * 7 * 864e5).toISOString().slice(0, 10);
}

/**
 * Sort milestones for display: dated milestones first in ascending date order,
 * undated milestones last (in stable insertion order). Then cap at 4.
 */
function sortAndCap(ms: TrajectoryMilestone[]): TrajectoryMilestone[] {
  const dated = ms.filter((m) => isISODate(m.when));
  const undated = ms.filter((m) => !isISODate(m.when));
  dated.sort((a, b) => String(a.when).localeCompare(String(b.when)));
  return [...dated, ...undated].slice(0, 4);
}

/**
 * Pull today's concrete step from the forward-look + day-read. Prefer the
 * day-ahead forward line's focus when present (the next plan day), else the
 * day-read's focus/why. Returns null when neither says anything actionable.
 */
function deriveTodayStep(date: string): string | null {
  // forwardLook (when this build has it) names the NEXT plan day's focus — the
  // truest "step toward the arc". Shape (later builds): { next_focus, due, text }.
  const fwd = safe<any>(
    () =>
      typeof (intelligence as any).forwardLook === "function"
        ? (intelligence as any).forwardLook(date)
        : null,
    null,
  );
  if (fwd) {
    const focus = typeof fwd.next_focus === "string" ? fwd.next_focus.trim() : "";
    const text = typeof fwd.text === "string" ? fwd.text.trim() : "";
    if (focus) return focus;
    if (text) return text;
  }

  // Fall back to the day-read: a train day's focus, else its plain "why".
  const read = safe<any>(() => intelligence.dayRead(date), null);
  if (read) {
    if (read.kind === "train" && typeof read.focus === "string" && read.focus.trim()) {
      return read.focus.trim();
    }
    if (typeof read.why === "string" && read.why.trim()) {
      return read.why.trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Fuse the goal-shaped signals into one forward arc. Pure + deterministic +
 * null-safe. Returns the quiet NULL-shape (line === null) when there is no goal,
 * no active block, and no race.
 */
export function getTrajectory(date?: string): Trajectory {
  const today = isISODate(date) ? (date as string) : localDateISO();

  const empty: Trajectory = {
    horizon_weeks: null,
    phase: null,
    week_of: null,
    milestones: [],
    today_step: null,
    line: null,
  };

  // ---- the active periodization block (top precedence for horizon + phase) ----
  const block = safe<any>(() => getActiveBlock(), null);
  const blockSummary = safe<any>(() => blockForCoach(), null);

  // ---- the endurance race countdown ----
  const goal = safe<any>(() => getEnduranceGoal(today), null);
  const isRace = !!(goal && goal.is_race && isISODate(goal.date));
  const weeksToRace: number | null = isRace
    ? Number.isFinite(goal.weeks_to_race)
      ? goal.weeks_to_race
      : null
    : null;
  const racePhase: string | null = isRace && typeof goal.phase === "string" ? goal.phase : null;
  // A race is "in build" when its phase is build OR it's ~5–10 weeks out — the
  // window where it should anchor the horizon over body comp.
  const raceInBuild =
    isRace && (racePhase === "build" || (weeksToRace != null && weeksToRace >= 5 && weeksToRace <= 10));

  // ---- the body-comp goal (date is projectGoalPace's text, VERBATIM) ----
  const profile = safe<any>(() => getProfile(), null);
  const goalCheck = safe<any>(() => computeGoalCheck(), null);
  const lbsToLose: number =
    goalCheck && Number.isFinite(goalCheck.lbs_to_lose) ? goalCheck.lbs_to_lose : 0;
  const pace = safe<any>(
    () => (profile ? projectGoalPace(profile, lbsToLose) : null),
    null,
  );
  // The body-comp arc is only real when there's weight to lose AND a measured trend.
  const hasBodyComp = lbsToLose > 0;
  const bodyCompDate: string | null =
    pace && isISODate(pace.projected_goal_date) ? pace.projected_goal_date : null;
  // REUSE the projection text VERBATIM — never recompute a date or a sentence.
  const bodyCompText: string | null =
    pace && typeof pace.projection_text === "string" && pace.projection_text.trim()
      ? pace.projection_text
      : null;

  // ---- the mesocycle's next deload milestone ----
  const programState = safe<any>(() => getProgramState(today), null);
  const meso = programState?.mesocycle ?? null;

  // ---- the health synthesis "one change" as the lever milestone ----
  const synthesis = safe<any>(() => getHealthSynthesis(), null);
  const oneChange: string | null =
    synthesis && typeof synthesis.one_change === "string" && synthesis.one_change.trim()
      ? synthesis.one_change.trim().slice(0, 160)
      : null;

  // Nothing to anchor an arc — quiet NULL-shape (the constitution: silence over noise).
  if (!block && !isRace && !hasBodyComp) {
    return empty;
  }

  // ---- horizon + phase (precedence: active block → race-in-build → body-comp) ----
  let horizon_weeks: number | null = null;
  let phase: string | null = null;
  let week_of: number | null = null;

  if (block) {
    const total = Number.isFinite(block.total_weeks) ? block.total_weeks : null;
    const weekIdx = Number.isFinite(block.week_index) ? block.week_index : null;
    // Weeks REMAINING in the block anchor the arc (the road still ahead), clamped.
    const remaining = total != null && weekIdx != null ? Math.max(1, total - weekIdx + 1) : total;
    horizon_weeks = clampHorizon(remaining ?? total);
    phase = typeof block.phase === "string" ? block.phase : (blockSummary?.phase ?? null);
    week_of = weekIdx;
  } else if (raceInBuild && weeksToRace != null) {
    horizon_weeks = clampHorizon(weeksToRace);
    phase = racePhase;
  } else if (hasBodyComp) {
    // The body-comp arc anchors the horizon only when nothing stronger does.
    // Without a recomputed date we still give the arc the calm default length.
    horizon_weeks = clampHorizon(
      bodyCompDate
        ? Math.round((Date.parse(`${bodyCompDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / (7 * 864e5))
        : 8,
    );
    phase = null;
  }

  // ---- assemble milestones ----
  const milestones: TrajectoryMilestone[] = [];

  // Race day.
  if (isRace) {
    const event = typeof goal.event === "string" && goal.event.trim() ? goal.event.trim().slice(0, 80) : null;
    milestones.push({
      label: event ? `Race day — ${event}` : "Race day",
      when: goal.date,
      kind: "race",
    });
  }

  // Body-comp goal date (only when we have a real projected date).
  if (hasBodyComp && bodyCompDate) {
    milestones.push({
      label: "Goal weight",
      when: bodyCompDate,
      kind: "goal",
    });
  }

  // Next deload (mesocycle). Project a date from weeks_since_deload against a
  // typical ~4-week accumulation cadence when the phase says one's due/coming.
  if (meso && (meso.phase === "deload-due" || meso.phase === "deload" || meso.phase === "accumulation" || meso.phase === "intensification")) {
    let when: string | null = null;
    let label = "Deload week";
    if (meso.phase === "deload" || meso.phase === "deload-due") {
      // Due now / underway — anchor to today, plain label.
      when = today;
      label = meso.phase === "deload" ? "Deload week (now)" : "Deload due";
    } else if (Number.isFinite(meso.weeks_since_deload)) {
      // Accumulation/intensification — project the next deload ~4 weeks out from
      // the last one (a typical mesocycle), but never before today.
      const wks = Math.max(1, 4 - Number(meso.weeks_since_deload));
      const proj = addWeeksISO(today, wks);
      if (proj) {
        when = proj;
        label = "Next deload";
      }
    }
    if (when) {
      milestones.push({ label, when, kind: "deload" });
    }
  }

  // Block end (when a block is running and we can date it).
  if (block) {
    const total = Number.isFinite(block.total_weeks) ? block.total_weeks : null;
    const weekIdx = Number.isFinite(block.week_index) ? block.week_index : null;
    if (total != null && weekIdx != null && isISODate(block.started_at?.slice?.(0, 10))) {
      const end = addWeeksISO(block.started_at.slice(0, 10), total);
      if (end && end > today) {
        const goalLabel = typeof block.goal === "string" && block.goal.trim() ? block.goal.trim().slice(0, 80) : "Block";
        milestones.push({ label: `${goalLabel} — block ends`, when: end, kind: "block" });
      }
    }
  }

  // The health lever — the single highest-leverage move ("one change"). Undated:
  // it's a standing lever to hold across the whole arc, not a calendar event.
  if (oneChange) {
    milestones.push({ label: oneChange, when: null, kind: "lever" });
  }

  const sorted = sortAndCap(milestones);

  // ---- today's step ----
  const today_step = deriveTodayStep(today);

  // ---- the one plain clause ----
  // Lead with where the athlete is on the arc (week / phase / countdown), then
  // today's step. No scores; plain words; calm. When the body-comp arc is the
  // anchor, reuse projectGoalPace's projection_text VERBATIM as the framing.
  let lead: string | null = null;
  if (block && week_of != null) {
    const total = Number.isFinite(block.total_weeks) ? block.total_weeks : null;
    const phaseWord = phase ? phase.replace(/-/g, " ") : "your block";
    lead = total != null ? `Week ${week_of} of ${total} — your ${phaseWord} block` : `Week ${week_of} of your ${phaseWord} block`;
  } else if (raceInBuild && weeksToRace != null) {
    const event = typeof goal.event === "string" && goal.event.trim() ? goal.event.trim() : "your race";
    lead = `${weeksToRace} week${weeksToRace === 1 ? "" : "s"} out from ${event} — in the build`;
  } else if (hasBodyComp && bodyCompText) {
    lead = bodyCompText; // VERBATIM
  } else if (isRace && weeksToRace != null) {
    const event = typeof goal.event === "string" && goal.event.trim() ? goal.event.trim() : "your race";
    lead =
      racePhase === "taper"
        ? `${weeksToRace} week${weeksToRace === 1 ? "" : "s"} out from ${event} — tapering`
        : `${weeksToRace} week${weeksToRace === 1 ? "" : "s"} out from ${event}`;
  }

  let line: string | null = null;
  if (lead) {
    line = today_step ? `${lead} — today's step: ${today_step}` : lead;
  } else if (today_step) {
    // No strong lead but there IS an arc (block/race/body-comp gated above) and a
    // step — still surface something honest.
    line = `Today's step: ${today_step}`;
  }

  return {
    horizon_weeks,
    phase,
    week_of,
    milestones: sorted,
    today_step,
    line,
  };
}
