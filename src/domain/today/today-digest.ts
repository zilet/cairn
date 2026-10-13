// THE OVERNIGHT DIGEST — what the team did, one lift per row (the Today redesign).
//
// The Changes feed (src/domain/brain/changes-feed.ts) is the authority on WHICH rows are
// the team's changes, their titles, timing words, newness and Undo. This read keeps
// every one of those verbatim and adds only the per-lift detail a person can check at a
// glance: which way each lift moved and its prescription before → after, read off the
// snapshot the change carries (`action.changes[].before` beside the after-values the
// apply wrote) or, for a change still announced, off the live plan it is about to
// overwrite. A held draft the team SET ASIDE is housekeeping, not news for the day:
// it is not on Today at all — Ask › Changes carries it as one quiet line
// (`set_aside`, src/domain/brain/changes-feed.ts).
//
// Read-only and deterministic; a row it cannot read is thinned, never invented.
import type {
  TodayDigest,
  TodayDigestChange,
  TodayDigestDirection,
  TodayDigestMove,
} from "../../contracts/today-digest.js";
import type { BrainDecision } from "../../brain/decision-contract.js";
import { brainChangesRead } from "../brain/index.js";
import { getBrainDecision, rollbackBuiltOnEmptyPlan } from "../../repo/brain-decisions.js";
import { athleteLine } from "../../repo/brain/clinician-ask.js";
import { type PlanPrescription, planPrescriptionKey, planPrescriptionSnapshot } from "../../repo/plan.js";
import { getProposal } from "../../repo/proposals.js";
import { addDaysISO, localDateISO, localHourFraction } from "../../repo/shared.js";

const MAX_CHANGES = 6;

type Rx = Partial<Record<"sets" | "rep_low" | "rep_high" | "target_weight" | "target_seconds", unknown>>;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The value a field holds after the change: a field the change did not name keeps its
// value; only `target_weight` reads an explicit null as a value (bodyweight).
function after(change: Rx, before: Rx, key: keyof Rx): unknown {
  const value = change[key];
  return value === undefined || (value === null && key !== "target_weight") ? before[key] : value;
}

function loadText(weight: unknown): string {
  const w = num(weight);
  if (w == null || w === 0) return "bodyweight";
  return w < 0 ? `${Math.abs(w)} lb assist` : `${w} lb`;
}

function repsText(low: unknown, high: unknown): string {
  const lo = num(low);
  const hi = num(high);
  if (lo == null) return "";
  return hi != null && hi > lo ? `${lo}–${hi} reps` : `${lo} reps`;
}

function doseText(rx: Rx): string {
  const sets = num(rx.sets);
  const seconds = num(rx.target_seconds);
  const dose = seconds != null ? `${seconds} s` : repsText(rx.rep_low, rx.rep_high).replace(/ reps$/, "");
  const head = [sets != null ? String(sets) : "", dose].filter(Boolean).join(" × ");
  const load = num(rx.target_weight) != null ? ` at ${loadText(rx.target_weight)}` : "";
  return `${head}${load}`.trim() || "on your plan";
}

/** One lift's move, read off its before and after. Null when nothing can be said. */
export function liftMoveOf(
  change: Rx & { exercise?: unknown; reason?: unknown; change?: unknown },
  before: Rx | null
): TodayDigestMove | null {
  const exercise = String(change.exercise ?? "").trim();
  if (!exercise) return null;
  const reason = athleteLine(change.reason, 90);
  if (change.change === "added") {
    return { exercise, direction: "added", from_text: null, to_text: doseText(change), reason };
  }
  if (!before) return null;
  const wBefore = num(before.target_weight) ?? 0;
  const wAfter = num(after(change, before, "target_weight")) ?? 0;
  let direction: TodayDigestDirection = "same";
  let from: string | null = null;
  let to = loadText(after(change, before, "target_weight"));
  if (wAfter !== wBefore) {
    // Bodyweight (0) sits between an assist (negative) and added load: numeric order is harder-to-lift order.
    direction = wAfter > wBefore ? "up" : "down";
    from = loadText(before.target_weight);
  } else {
    const sBefore = num(before.target_seconds);
    const sAfter = num(after(change, before, "target_seconds"));
    const lowBefore = num(before.rep_low);
    const lowAfter = num(after(change, before, "rep_low"));
    const highBefore = num(before.rep_high);
    const highAfter = num(after(change, before, "rep_high"));
    const setsBefore = num(before.sets);
    const setsAfter = num(after(change, before, "sets"));
    if (sBefore != null && sAfter != null && sAfter !== sBefore) {
      direction = sAfter > sBefore ? "up" : "down";
      from = `${sBefore} s`;
      to = `${sAfter} s`;
    } else if (lowAfter !== lowBefore || highAfter !== highBefore) {
      const step = (highAfter ?? lowAfter ?? 0) - (highBefore ?? lowBefore ?? 0);
      const sameWidth =
        (highAfter ?? lowAfter ?? 0) - (lowAfter ?? 0) === (highBefore ?? lowBefore ?? 0) - (lowBefore ?? 0);
      if (sameWidth && Math.abs(step) === 1) {
        direction = step > 0 ? "up" : "down";
        to = `${step > 0 ? "+" : "−"}1 rep`;
      } else {
        direction = "range";
        from = repsText(lowBefore, highBefore) || null;
        to = repsText(lowAfter, highAfter) || to;
      }
    } else if (setsBefore != null && setsAfter != null && setsAfter !== setsBefore) {
      direction = setsAfter > setsBefore ? "up" : "down";
      from = `${setsBefore} sets`;
      to = `${setsAfter} sets`;
    }
  }
  return { exercise, direction, from_text: from, to_text: to, reason };
}

function proposalIdOf(decision: BrainDecision): number | null {
  const action = (decision.action ?? {}) as Record<string, unknown>;
  const id =
    Number(action.proposal_id) ||
    (decision.source_ref_type === "plan_proposal" ? Number(decision.source_ref_key) : Number.NaN);
  return id > 0 ? id : null;
}

function movesOf(decision: BrainDecision, livePlan: () => Map<string, PlanPrescription>): TodayDigestMove[] {
  const action = (decision.action ?? {}) as Record<string, any>;
  const out: TodayDigestMove[] = [];
  const seen = new Set<string>();
  const push = (move: TodayDigestMove | null) => {
    if (!move || seen.has(move.exercise.toLowerCase())) return;
    seen.add(move.exercise.toLowerCase());
    out.push(move);
  };
  if (Array.isArray(action.changes)) {
    for (const change of action.changes) {
      if (!change || typeof change !== "object") continue;
      const before = change.before && typeof change.before === "object" ? (change.before as Rx) : null;
      push(liftMoveOf(change, before));
    }
    return out;
  }
  // Announced: the draft says what it will do; the plan it has not touched yet is its before.
  const proposalId = proposalIdOf(decision);
  if (!proposalId) return out;
  const proposal = getProposal(proposalId) as any;
  const changes = Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : [];
  for (const change of changes) {
    if (!change || typeof change !== "object" || change.swap) continue;
    const key = planPrescriptionKey(change.day_number, change.exercise);
    const before = key ? (livePlan().get(key) ?? null) : null;
    push(liftMoveOf(change, before));
  }
  return out;
}

function whenWord(changes: Array<{ new: boolean; day: string }>, asOf: string, now: Date): string {
  const yesterday = addDaysISO(asOf, -1) ?? asOf;
  if (localHourFraction(now) < 12 && changes.every((row) => row.day === asOf || row.day === yesterday))
    return "Overnight";
  return changes.some((row) => row.new) ? "Since you last looked" : "Lately";
}

export function overnightDigest(date?: string, opts: { now?: Date } = {}): TodayDigest {
  const now = opts.now ?? new Date();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? String(date) : localDateISO(now);
  const feed = brainChangesRead({ days: 3, asOf, now });
  const yesterday = addDaysISO(asOf, -1) ?? asOf;
  let live: Map<string, PlanPrescription> | null = null;
  const livePlan = () => (live ??= planPrescriptionSnapshot());
  const picked: Array<TodayDigestChange & { day: string }> = [];
  // Every qualifying change counts toward the totals, including those past the
  // MAX_CHANGES rows the payload carries — so the client's "+N more in Changes" and
  // the headline count what is really there, not what fit.
  let lifts = 0;
  let others = 0;
  for (const day of feed.days) {
    for (const change of day.changes) {
      if (change.state !== "applied" && change.state !== "announced") continue;
      // Fresh news, or anything from today and yesterday; announced changes are always ahead.
      if (!change.new && change.state !== "announced" && change.day < yesterday) continue;
      let moves: TodayDigestMove[] = [];
      try {
        const decision = getBrainDecision(change.id);
        // The first week, composed onto an empty plan (the welcome), is not news about a
        // change: every lift would read "added" under "Overnight · N lifts moved". The
        // person watched it land; Ask › Changes still carries it with its Undo.
        if (decision?.kind === "training_structure" && rollbackBuiltOnEmptyPlan(change.id)) continue;
        if (decision) moves = movesOf(decision, livePlan);
      } catch {
        moves = [];
      }
      if (moves.length) lifts += moves.length;
      else others += 1;
      if (picked.length >= MAX_CHANGES) continue;
      picked.push({
        id: change.id,
        day: change.day,
        state: change.state,
        title: change.title,
        status_line: change.status_line,
        moves,
        undo: change.undo,
        new: change.new,
      });
    }
  }
  let headline: string | null = null;
  if (lifts && !others) headline = `${lifts} lift${lifts === 1 ? "" : "s"} moved`; // short: the mast shares a phone line with its link
  else if (picked.length) {
    const count = lifts + others;
    headline = `${count} change${count === 1 ? "" : "s"}`;
  }
  return {
    as_of: asOf,
    when: whenWord(picked, asOf, now),
    headline,
    total_rows: lifts + others,
    changes: picked.map(({ day: _day, ...change }) => change),
  };
}
