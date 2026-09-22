// The road ahead, oriented: WHICH goal leads this block, and the next milestone on
// each goal's road. Deterministic and pull-only — the weekly read, the week-ahead
// sketch, the program evolution and the case conference read it so every one of them
// steers toward the same next step instead of re-deriving (or ignoring) it.
//
// Constitution: a milestone is a direction, never a countdown. Each strength objective
// carries a FIT word — it fits this block, it is a stretch for it, or it lies beyond
// it — and never a percent or a score. A lift with no recent read claims no fit at all.
import { getEnduranceGoal, effectiveGoalMode, getProfile } from "./profile.js";
import { getActiveBlock } from "./program-blocks.js";
import type { ProgramState } from "./program-state.js";
import { getStrengthJourneys, type StrengthJourney } from "./strength-objectives.js";
import { getTrainingIntent } from "./training-intent.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { round1 } from "../lib/numbers.js";

export type PriorityTrack = "muscle" | "race" | "cut";

export interface BlockPriority {
  order: PriorityTrack[];
  source: "block" | "intent" | "default";
  why: string;
}

const TRACK_WORDS: Record<PriorityTrack, string> = {
  muscle: "muscle and strength",
  race: "the race",
  cut: "the cut",
};

function blockLead(focus: string, goal: string): PriorityTrack | null {
  const text = `${focus} ${goal}`.toLowerCase();
  // The block's FOCUS names what it trains; its goal sentence may mention the others
  // ("keep the half as supporting work"), so the focus is read first.
  const read = (value: string): PriorityTrack | null =>
    /hypertroph|strength|power|muscle/.test(value)
      ? "muscle"
      : /endurance|race|aerobic|marathon|\brun/.test(value)
        ? "race"
        : /\bcut\b|fat[- ]loss|lean/.test(value)
          ? "cut"
          : null;
  return read(focus.toLowerCase()) ?? read(text);
}

/**
 * The block's goal priority order, read off the athlete's own data: the active
 * block's focus leads when there is one, otherwise the stated training intent. Only
 * goals that exist are ordered (a race needs a dated race ahead, a cut an affirmed
 * loss phase). The cut ranks after the training goals it serves — it is the lever,
 * not a rival lead — unless leanness is the athlete's own first priority.
 */
export function blockPriority(today = localDateISO(), profile: any = getProfile()): BlockPriority {
  const intent = getTrainingIntent(profile ?? undefined);
  const priorities = intent.priorities as readonly string[];
  const race = getEnduranceGoal(today);
  const present: PriorityTrack[] = [];
  if (priorities.includes("muscle") || priorities.includes("strength") || intent.endurance_role !== "primary")
    present.push("muscle");
  if (race?.is_race === true && race.phase !== "past") present.push("race");
  if (effectiveGoalMode(profile) === "lose") present.push("cut");
  if (!present.length) return { order: [], source: "default", why: "No goal is set, so nothing is ordered." };

  const block = getActiveBlock();
  const fromBlock = block ? blockLead(String(block.focus ?? ""), String(block.goal ?? "")) : null;
  const enduranceLeads = intent.endurance_role === "primary" || intent.endurance_role === "co_primary";
  const leannessFirst = priorities[0] === "leanness";
  const fromIntent: PriorityTrack = leannessFirst ? "cut" : intent.endurance_role === "primary" ? "race" : "muscle";
  const lead =
    fromBlock && present.includes(fromBlock) ? fromBlock : present.includes(fromIntent) ? fromIntent : present[0];
  const rank = (track: PriorityTrack): number =>
    track === lead ? 0 : track === "cut" ? (leannessFirst ? 1 : 3) : track === "race" ? (enduranceLeads ? 1 : 2) : 2;
  const order = [...present].sort((a, b) => rank(a) - rank(b));
  const source: BlockPriority["source"] =
    fromBlock && fromBlock === lead ? "block" : intent.source === "explicit" ? "intent" : "default";
  const words = order.map((track) => TRACK_WORDS[track]);
  const why =
    source === "block"
      ? `The active block (${String(block?.focus ?? "")}) leads with ${words[0]}${words.length > 1 ? `; then ${words.slice(1).join(", then ")}` : ""}.`
      : `Your stated priorities lead with ${words[0]}${words.length > 1 ? `; then ${words.slice(1).join(", then ")}` : ""}.`;
  return { order, source, why };
}

// ---------- strength objectives as milestones ----------

export type ObjectiveFit = "fits" | "stretch" | "beyond_this_block";

export interface ObjectiveMilestone {
  objective_id: number;
  exercise: string;
  target_est_1rm: number;
  current_est_1rm: number | null;
  fit: ObjectiveFit | null;
  basis: string;
}

// With no active block, "this block" is the next six weeks — the ordinary block length.
const FALLBACK_HORIZON_DAYS = 42;
// A trend-only read (no projection) may call a target a stretch up to this much past
// the horizon; further than that it lies beyond it.
const STRETCH_FACTOR = 1.5;

/** The last day of the active block, or six weeks out when there is none. */
export function blockHorizon(today = localDateISO()): { end: string; from_block: boolean } {
  const block = getActiveBlock();
  const started = String(block?.started_at ?? "").slice(0, 10);
  const weeks = Number(block?.total_weeks);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(started) && weeks > 0 ? addDaysISO(started, weeks * 7) : null;
  if (end && end > today) return { end, from_block: true };
  return { end: addDaysISO(today, FALLBACK_HORIZON_DAYS) ?? today, from_block: false };
}

const FIT_BASIS: Record<ObjectiveFit, string> = {
  fits: "fits inside this block at the current trend",
  stretch: "a stretch for this block",
  beyond_this_block: "beyond this block — a target for the next one",
};

function objectiveFit(journey: StrengthJourney, weeksLeft: number): ObjectiveFit | null {
  const gap = Number(journey.gap_lb);
  if (!journey.current || !Number.isFinite(gap)) return null;
  const projection = journey.projection;
  if (projection) {
    if (projection.latest_weeks <= weeksLeft) return "fits";
    return projection.earliest_weeks <= weeksLeft ? "stretch" : "beyond_this_block";
  }
  const rate = Number(journey.trend?.est_1rm_lb_per_week);
  if (journey.trend?.direction !== "rising" || !(rate > 0)) return "beyond_this_block";
  const weeks = gap / rate;
  return weeks <= weeksLeft ? "fits" : weeks <= weeksLeft * STRETCH_FACTOR ? "stretch" : "beyond_this_block";
}

/** Each ACTIVE strength objective not yet reached, with its honest fit word. */
export function objectiveMilestones(
  today = localDateISO(),
  opts: { programState?: ProgramState } = {}
): ObjectiveMilestone[] {
  let journeys: StrengthJourney[] = [];
  try {
    journeys = getStrengthJourneys(opts).filter((journey) => journey.objective?.status === "active");
  } catch {
    return [];
  }
  const horizon = blockHorizon(today);
  const weeksLeft = Math.max(0, (daysBetweenISO(horizon.end, today) ?? 0) / 7);
  const out: ObjectiveMilestone[] = [];
  for (const journey of journeys) {
    const objective = journey.objective!;
    if (journey.phase === "reached" || (journey.gap_lb != null && journey.gap_lb <= 0)) continue;
    const fit = objectiveFit(journey, weeksLeft);
    out.push({
      objective_id: objective.id,
      exercise: objective.exercise,
      target_est_1rm: round1(objective.target_est_1rm),
      current_est_1rm: journey.current ? round1(journey.current.est_1rm) : null,
      fit,
      basis: fit ? FIT_BASIS[fit] : "no recent read of this lift yet, so no fit is claimed",
    });
  }
  const fitRank = (fit: ObjectiveFit | null) => (fit === "fits" ? 0 : fit === "stretch" ? 1 : fit ? 2 : 3);
  return out.sort((a, b) => fitRank(a.fit) - fitRank(b.fit) || a.exercise.localeCompare(b.exercise));
}
