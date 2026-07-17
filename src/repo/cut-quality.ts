// The CUT-QUALITY read — during an active weight-loss phase, is the athlete
// PRESERVING muscle? This is the goal-aware complement to the under-fueling read
// (repo/underfueling.ts): under-fueling asks "is training under strain?" without
// caring whether weight is actually dropping; this only speaks up while the scale
// is genuinely coming down, and asks the narrower question the cut cares about —
// are the anchor lifts holding while the weight falls, or sliding with it?
//
// Constitution (docs/VISION.md): calm, second-person, banded — NO numeric scores.
// Adherence-neutral: thin logging lowers CERTAINTY ('insufficient'), it never
// blames. Muscle DEVELOPMENT stays the objective; this is a suggestion, not a gate.
//
// Every input comes from the existing robust helpers — computeGoalCheck (28-day
// robust trend + leanness-aware lean-safe ceilings), estimateExpenditure (Theil-Sen
// weight trend), and getProgramState's per-lift graded status. It NEVER computes a
// fresh ad-hoc slope; a naive slope over the noisy tail badly over-reads the rate.

import { computeGoalCheck } from "./profile.js";
import { estimateExpenditure, type ExpenditureEstimate } from "./expenditure.js";
import { getProgramState, type LiftState, type ProgramState } from "./program-state.js";
import { normalizeExerciseName } from "./exercise-canon.js";
import { addDaysISO, localDateISO } from "./shared.js";

export type CutQualityVerdict = "preserving" | "mixed" | "sliding" | "insufficient";

export interface CutQualityAnchor {
  name: string;
  status: LiftState["status"];
}

export interface CutQualityActive {
  active: true;
  verdict: CutQualityVerdict;
  words: string; // calm, second-person, banded — no numbers
  weight: { trend_lb_wk: number | null; window_days: number };
  strength: {
    considered: number; // established lifts we could read during the cut
    holding: number; // progressing / maintaining / plateaued (holding load as weight drops)
    regressing: number; // status === 'regressing'
    anchors: CutQualityAnchor[]; // representative lifts, regressing-first then compound-preferred
  };
  endurance: { note: string } | null;
  rate: { vs_lean_safe: "within" | "above" | null };
}

export interface CutQualityInactive {
  active: false;
}

export type CutQualityRead = CutQualityActive | CutQualityInactive;

// A genuine downtrend, not scale noise. Maintenance jitter sits inside ~±0.2 lb/wk;
// even a very-lean cut (lean-ideal ~0.25%/wk) clears this floor.
const LOSS_TREND_FLOOR_LB_WK = -0.25;
// An anchor lift must have been trained inside the recent cut window to count —
// a lift last touched two months ago says nothing about how the cut is landing.
const LIFT_RECENCY_DAYS = 28;
// Below this many established lifts the strength channel is too thin to call
// (neutral 'insufficient', never a blame).
const MIN_ESTABLISHED_LIFTS = 3;

function finite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Cheap compound/primary-movement gate over the NORMALIZED exercise name (reuses
// exercise-canon's normalizer). Anchor selection prefers these so the read speaks to
// squats/presses/rows, not lateral raises — top-by-set-count is isolation-heavy.
const COMPOUND_PATTERN =
  /\b(squat|dead ?lift|bench|chest press|overhead press|shoulder press|military press|push press|ohp|\brow\b|pull ?up|chin ?up|pull ?down|leg press|hip thrust|lunge|split squat|\bdip\b|clean|snatch|thruster)\b/;
function isCompoundLift(name: string): boolean {
  return COMPOUND_PATTERN.test(normalizeExerciseName(name));
}

function safeExpenditure(): ExpenditureEstimate | null {
  try {
    return estimateExpenditure();
  } catch {
    return null;
  }
}
function safeGoal(expenditure: ExpenditureEstimate | null): any {
  try {
    return computeGoalCheck(undefined, { expenditure });
  } catch {
    return null;
  }
}
function safeProgramState(asOf: string): ProgramState | null {
  try {
    return getProgramState(asOf);
  } catch {
    return null;
  }
}

function cutQualityWords(verdict: CutQualityVerdict, vsLeanSafe: "within" | "above" | null): string {
  switch (verdict) {
    case "preserving":
      return "Strength is holding while you lean out — the cut is preserving muscle. Keep protein where it is and this stays on track.";
    case "sliding":
      return vsLeanSafe === "above"
        ? "A couple of anchor lifts are sliding while your weight drops — and you're losing a little faster than the lean-safe pace, which makes that more likely. Easing the deficit a touch and anchoring protein higher will help you hold onto muscle."
        : "A couple of anchor lifts are sliding while your weight drops — worth easing the deficit a touch or anchoring protein a bit higher so you hold onto muscle.";
    case "mixed":
      return "Most of your lifting is holding as you lean out, though one or two lifts have slipped — keep protein high and the deficit gentle and they should steady.";
    default:
      return "You're leaning out, and there isn't quite enough recent lifting logged yet to tell whether strength is fully holding — a few more sessions will make that clear.";
  }
}

/**
 * The cut-quality read. Active ONLY during a genuine weight-loss phase
 * (goal_mode 'lose' AND a real measured downtrend); otherwise `{ active: false }`.
 *
 * @param asOf local date to read as-of (default: today, local).
 * @param opts inject already-computed reads to avoid recompute (the coach-context
 *   path threads the shared goal / program-state / expenditure); each defaults to a
 *   fresh, null-safe compute.
 */
export function cutQualityRead(
  asOf?: string,
  opts: { goal?: any; programState?: ProgramState | null; expenditure?: ExpenditureEstimate | null } = {}
): CutQualityRead {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) ? String(asOf) : localDateISO();

  const expenditure = opts.expenditure !== undefined ? opts.expenditure : safeExpenditure();
  const goal = opts.goal ?? safeGoal(expenditure);

  // Gate 1 — only during an active weight-loss phase.
  if (!goal || goal.ok === false || goal.goal_mode !== "lose") return { active: false };

  // Gate 2 — a genuine measured downtrend from the robust helpers (Theil-Sen
  // expenditure trend preferred, else computeGoalCheck's robust goal-pace trend).
  // Negative = losing weight (shared sign convention with expenditure/under-fueling).
  const trend = finite(expenditure?.trend_lb_wk) ?? finite(goal?.trend_lb_wk);
  if (trend == null || trend > LOSS_TREND_FLOOR_LB_WK) return { active: false };

  const windowDays = Number(expenditure?.window_days) || 21;
  const weightConfident = ["medium", "high"].includes(String(expenditure?.confidence));

  // Strength direction — the deterministic per-lift graded status. Consider only
  // ESTABLISHED lifts (a real trend, not 'new') trained inside the recent cut window.
  const programState = opts.programState ?? safeProgramState(today);
  const lifts: LiftState[] = Array.isArray(programState?.lifts) ? programState!.lifts : [];
  const recencyFloor = addDaysISO(today, -LIFT_RECENCY_DAYS) ?? today;
  const established = lifts.filter(
    (l) => l.status !== "new" && typeof l.last_trained === "string" && l.last_trained >= recencyFloor
  );
  const regressingLifts = established.filter((l) => l.status === "regressing");
  const considered = established.length;
  const regressing = regressingLifts.length;
  const holding = considered - regressing; // progressing / maintaining / plateaued

  // Anchors: name what slipped first (regressing), then compound-preferred, capped
  // at 3 — never top-by-set-count, which is isolation-heavy (lateral raise / curls).
  const compoundFirst = (a: LiftState, b: LiftState) =>
    (isCompoundLift(b.exercise) ? 1 : 0) - (isCompoundLift(a.exercise) ? 1 : 0) ||
    (Number(b.sessions) || 0) - (Number(a.sessions) || 0);
  const anchors: CutQualityAnchor[] = [
    ...regressingLifts.slice().sort(compoundFirst),
    ...established.filter((l) => l.status !== "regressing").sort(compoundFirst),
  ]
    .slice(0, 3)
    .map((l) => ({ name: l.exercise, status: l.status }));

  // Rate vs the leanness-aware lean-safe ceiling — losing faster than lean-safe
  // makes muscle loss more likely and strengthens a 'sliding' message.
  const safeMax = finite(goal?.leanness_rate?.safe_max_rate_lb ?? goal?.safe_max_rate_lb);
  const vsLeanSafe: "within" | "above" | null =
    safeMax == null || safeMax <= 0 ? null : Math.abs(trend) > safeMax ? "above" : "within";

  // Endurance — only a clearly-declining easy-pace read during the cut (present only
  // for endurance/hybrid disciplines; null for a pure strength athlete).
  const paceTrend = programState?.endurance?.pace_trend ?? null;
  const endurance =
    paceTrend === "declining"
      ? {
          note: "Your easy-pace endurance has been drifting slower through the cut as well — another reason to keep carbohydrate and protein up.",
        }
      : null;

  // Verdict — 'insufficient' (neutral) whenever either channel is too thin; otherwise
  // from the counts. Holding load as weight drops IS muscle preservation.
  let verdict: CutQualityVerdict;
  if (!weightConfident || considered < MIN_ESTABLISHED_LIFTS) verdict = "insufficient";
  else if (regressing >= 2 || regressing > holding) verdict = "sliding";
  else if (regressing === 0) verdict = "preserving";
  else verdict = "mixed";

  return {
    active: true,
    verdict,
    words: cutQualityWords(verdict, vsLeanSafe),
    weight: { trend_lb_wk: trend, window_days: windowDays },
    strength: { considered, holding, regressing, anchors },
    endurance,
    rate: { vs_lean_safe: vsLeanSafe },
  };
}

// The team's-week ("week in review") line — ONE plain line, only when the cut read
// is active AND confident enough to say something (verdict !== 'insufficient'), so a
// thin week stays silent rather than surfacing a neutral non-statement.
export function cutQualityWeekLine(read: CutQualityRead): { text: string } | null {
  if (!read.active || read.verdict === "insufficient") return null;
  return { text: read.words };
}
