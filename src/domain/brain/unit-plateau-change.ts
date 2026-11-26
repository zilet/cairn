// ============================================================================
// unit-plateau-change.ts — the plateau ladder's bounded levers, made by the server.
//
// The ladder (repo/unit-plateau.ts) names one next lever per movement unit that has held
// one load and one rep count for weeks. Two of its levers are bounded and reversible, and
// those two the coach makes by itself, through the ORDINARY autonomy path
// (applyProposalWithAutonomy, no requested tier) with the server-owned Undo:
//   - `rep_scheme`: the unit's plan lift moves up one rep range at the held load
//     (lift-response.ts movedRepRangeFor), written as a target change marked
//     `progression_escalation: "rep_range"` so the applied-proposal ledger remembers it
//     exactly as the engine's own isolation move (lastAppliedRepRangeMove) — once per lift
//     per plateau, an Undo a "no" for that plateau. A training_target: quiet under lead,
//     announced under announce_first, one held draft under review_everything.
//   - `variation` for an ACCESSORY (non-compound unit) at a block boundary: a swap inside
//     the same unit. The incoming lift's first target comes from the unit
//     (variant-start.ts through the swap's own grounding) and the slot is stamped untested.
//     An exercise_rotation, low risk, the same tiers.
// Never autonomous: rotating a compound anchor (left to the program redraw as ladder
// output), set quality (a note), volume (the volume step's own path), anything waiting.
//
// Holds, each re-checked at landing by the premise (registerServerPremise):
//   - pain reported in words, the pain band, an open injury, or a dated plan adaptation on
//     the lift — or, for a rotation, on the INCOMING lift (the protective state owns that
//     slot: a lock); a rotation whose incoming lift is no longer the ladder's candidate is gone;
//   - the rep-range lever only on a lift that is not its day's anchor (first compound) and
//     whose range starts at AUTONOMOUS_REP_SCHEME_MIN_REP_LOW reps or more, and never on a
//     slot the progression engine is about to re-ground; elsewhere the ladder names the
//     lever and nothing is drafted;
//   - a lift on more than one plan day (a change names one day's slot): fenced;
//   - the volume step's open change on the lift, or one it landed this calendar week (one
//     server-owned structural change per lift per week, whichever came first:
//     repo/lift-structural-change.ts);
//   - a load-limiting constraint note on the lift;
//   - a prescription written inside the settle window (prescription-authorship.ts): a
//     person's or a redraw's number is theirs, and the ladder waits on any fresh one;
//   - a timed lift;
//   - one ladder change per unit per block (landed, or refused), or with no block running
//     one per unit per NO_BLOCK_UNIT_DAYS;
//   - at most MAX_UNITS_PER_WEEK units changed in a calendar week, one change per pass,
//     one open draft per unit.
// A read that fails changes nothing and withdraws nothing (`unavailable`). Calm: no
// scores, no digits in the words, nothing pushed; the words rotate by day.
// ============================================================================
import { mondayOf } from "../../lib/dates.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { resolveExerciseName } from "../../repo/exercise-canon.js";
import { getExercise } from "../../repo/exercises.js";
import { otherStructuralChangeOnLift, STRUCTURAL_CHANGE_AGENTS } from "../../repo/lift-structural-change.js";
import { getPlan } from "../../repo/plan.js";
import { slotAuthorship } from "../../repo/prescription-authorship.js";
import { nextPrescription } from "../../repo/progression.js";
import { createProposal, getProposal, setProposalStatus } from "../../repo/proposals.js";
import { isPrepPlanItem, PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "../training/plan-item-order.js";
import { addDaysISO, localDateISO } from "../../repo/shared.js";
import {
  ladderChangeRows,
  type LadderChangeRow,
  liftProtectedOn,
  planItemStamp,
  type PlateauPlanLift,
  UNIT_PLATEAU_AGENT,
  type UnitPlateauLadder,
  unitPlateauLadder,
  type UnitPlateauRung,
} from "../../repo/unit-plateau.js";
import { applyProposalWithAutonomy, registerServerPremise } from "./autonomy-service.js";

/** The single instruction every ladder change carries. Never `auto:`/`chat:` — no orphan sweep adopts it. */
export const UNIT_PLATEAU_INSTRUCTION = "plateau: the next lever for a movement that has stopped progressing";
/** At most this many units take a ladder change in one calendar week. */
export const MAX_UNITS_PER_WEEK = 2;
/** With no block running, one ladder change per unit inside this many days. */
export const NO_BLOCK_UNIT_DAYS = 42;
/**
 * The server moves a lift's rep range by itself only when its range starts at this many reps
 * or more. Below it the slot is strength-range work (the same line the weekly dose ledger
 * draws, WEEKLY_DOSE_STRENGTH_REP_LOW = 5): a heavy triple or five moved to a higher range at
 * the same weight stops training what it was written for (maximal strength wants heavy,
 * low-rep work), so that is the program's or the athlete's call. The ladder still names the
 * lever; no draft is made.
 */
export const AUTONOMOUS_REP_SCHEME_MIN_REP_LOW = 6;

export type UnitPlateauPremise = "fits" | "gone" | "held" | "unknown";

export type UnitPlateauBlock =
  | "not_autonomous"
  | "anchor"
  // The rep-range lever on the day's anchor (its first compound) or on strength-range work.
  | "day_anchor"
  | "strength_range"
  // The progression engine is about to re-ground the slot (plan behind / out of reach).
  | "engine_moving"
  // The lift sits on more than one plan day: a change lands on one slot, so it is fenced.
  | "multi_day"
  | "timed"
  | "constraint_note"
  | "protected"
  | "fresh_prescription"
  // The volume step has an open change on the lift, or one landed this calendar week.
  | "volume_step_this_week"
  | "block_used"
  | "recent_change"
  | "open_draft";

export interface UnitPlateauOutcome {
  status: "routed" | "would_route" | "deferred" | "none" | "held" | "unavailable";
  hold?: "week_used" | null;
  unit_key?: string | null;
  lever?: "rep_scheme" | "variation" | null;
  lift?: string | null;
  to_lift?: string | null;
  rep_low?: number | null;
  rep_high?: number | null;
  tier?: string | null;
  proposal_id?: number | null;
  decision_id?: number | null;
  effective_date?: string | null;
  summary?: string | null;
  explanation?: string | null;
  asked?: boolean;
  withdrawn: number[];
  blocked: Array<{ unit_key: string; lever: string; code: UnitPlateauBlock }>;
}

function outcome(status: UnitPlateauOutcome["status"], extra: Partial<UnitPlateauOutcome> = {}): UnitPlateauOutcome {
  return { status, withdrawn: [], blocked: [], ...extra };
}

// ---- the words ----------------------------------------------------------------------

const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

const REP_SUMMARIES: ReadonlyArray<(lift: string) => string> = [
  (lift) => `${lift} moves up a rep range at the same weight.`,
  (lift) => `A higher rep range for ${lift}, same weight.`,
  (lift) => `${lift} keeps its weight and takes a higher rep range.`,
];
const REP_ACTS: ReadonlyArray<(unit: string, lift: string) => string> = [
  (unit, lift) =>
    `Your ${unit} work has held one weight and one rep count for a few weeks, so ${lift} climbs the reps before the weight moves again. Undo puts the old range back.`,
  (unit, lift) =>
    `${capitalize(lift)} has sat at the same weight and reps for weeks; earning more reps at that weight is the next step for your ${unit}. Undo takes it back.`,
];
const REP_OFFERS: ReadonlyArray<(unit: string, lift: string) => string> = [
  (unit, lift) =>
    `Your ${unit} work has held one weight and one rep count for a few weeks; a higher rep range for ${lift} at the same weight is ready if you want it.`,
  (unit, lift) =>
    `${capitalize(lift)} has sat still for a while. Building reps at the same weight would be the next step for your ${unit}, and it is your call.`,
];
const SWAP_SUMMARIES: ReadonlyArray<(from: string, to: string) => string> = [
  (from, to) => `${to} rotates in for ${from}.`,
  (from, to) => `${from} makes way for ${to} this block.`,
  (from, to) => `A fresh variation: ${to} in place of ${from}.`,
];
const SWAP_ACTS: ReadonlyArray<(unit: string, from: string, to: string) => string> = [
  (unit, from, to) =>
    `Your ${unit} work has stalled through the other levers, so ${to} takes over from ${from} for the new block and starts a little light. Undo brings ${from} back.`,
  (unit, from, to) =>
    `${capitalize(from)} has stopped moving, so the new block rotates in ${to} for your ${unit}, starting on the light side. Undo puts ${from} back.`,
];
const SWAP_OFFERS: ReadonlyArray<(unit: string, from: string, to: string) => string> = [
  (unit, from, to) =>
    `Your ${unit} work has stalled; rotating ${to} in for ${from} with the new block is ready if you want it.`,
  (unit, from, to) =>
    `${capitalize(from)} has stopped moving. ${capitalize(to)} in its place for this block would be the next step for your ${unit}, and it is your call.`,
];

function words(
  rung: UnitPlateauRung,
  date: string,
  to?: string
): { summary: string; explanation: string; ask: string } {
  const lift = rung.plan_lift?.exercise ?? rung.label;
  const unit = rung.label.toLowerCase();
  const key = `${rung.unit_key}:${lift}`;
  if (rung.lever === "variation" && to) {
    return {
      summary: pickDayVariant(SWAP_SUMMARIES, date, `unit_plateau_swap_summary:${key}`)(lift, to),
      explanation: pickDayVariant(SWAP_ACTS, date, `unit_plateau_swap_act:${key}`)(unit, lift, to),
      ask: pickDayVariant(SWAP_OFFERS, date, `unit_plateau_swap_ask:${key}`)(unit, lift, to),
    };
  }
  return {
    summary: capitalize(pickDayVariant(REP_SUMMARIES, date, `unit_plateau_rep_summary:${key}`)(lift)),
    explanation: pickDayVariant(REP_ACTS, date, `unit_plateau_rep_act:${key}`)(unit, lift),
    ask: pickDayVariant(REP_OFFERS, date, `unit_plateau_rep_ask:${key}`)(unit, lift),
  };
}

// ---- the payload ----------------------------------------------------------------------

/** The proposal payload one ladder change is written as. */
export function unitPlateauProposalPayload(
  rung: UnitPlateauRung,
  date: string,
  blockId: number | null
): Record<string, unknown> | null {
  const lift = rung.plan_lift;
  if (!lift) return null;
  if (rung.lever === "rep_scheme" && rung.rep_range) {
    const w = words(rung, date);
    return {
      summary: w.summary,
      rationale: w.explanation,
      changes: [
        {
          day_number: lift.day_number,
          exercise: lift.exercise,
          rep_low: rung.rep_range.rep_low,
          rep_high: rung.rep_range.rep_high,
          // The ledger marker lastAppliedRepRangeMove reads: once per lift, Undo a no.
          progression_escalation: "rep_range",
          reason: `Your ${rung.label.toLowerCase()} work builds reps at the same weight.`,
        },
      ],
      unit_plateau: {
        version: 1,
        as_of: date,
        unit_key: rung.unit_key,
        label: rung.label,
        lever: "rep_scheme",
        lift: lift.exercise,
        day_number: lift.day_number,
        since: rung.since,
        block_id: blockId,
        from: { rep_low: lift.rep_low, rep_high: lift.rep_high },
        to: { rep_low: rung.rep_range.rep_low, rep_high: rung.rep_range.rep_high },
        explanation: w.ask,
      },
    };
  }
  if (rung.lever === "variation" && rung.candidate) {
    const to = rung.candidate.exercise;
    const w = words(rung, date, to);
    return {
      summary: w.summary,
      rationale: w.explanation,
      changes: [
        {
          day_number: lift.day_number,
          swap: { from: lift.exercise, to },
          reason: `A close variation keeps your ${rung.label.toLowerCase()} work moving.`,
        },
      ],
      unit_plateau: {
        version: 1,
        as_of: date,
        unit_key: rung.unit_key,
        label: rung.label,
        lever: "variation",
        lift: lift.exercise,
        day_number: lift.day_number,
        since: rung.since,
        block_id: blockId,
        to_lift: to,
        explanation: w.ask,
      },
    };
  }
  return null;
}

// ---- the lift-level gates -------------------------------------------------------------

// The lift's own stored constraint note (the exercise row), beside the plan item's.
function storedConstraint(name: string): string | null {
  const id = resolveExerciseName(name).exercise_id;
  if (id == null) return null;
  const row = getExercise(id);
  return row?.constraint_note == null ? null : String(row.constraint_note);
}

// Any constraint note on the lift holds it, load-limiting or not (the volume step's rule):
// the note is the athlete's word about that lift, and the ladder never edits around it.
function hasConstraint(lift: PlateauPlanLift): boolean {
  return !!String(lift.constraint_note ?? "").trim() || !!String(storedConstraint(lift.exercise) ?? "").trim();
}

// The slot as the plan holds it now (by day and lift), or null.
function slotNow(dayNumber: number, exercise: string): any | null {
  const id = resolveExerciseName(exercise).exercise_id;
  const day = (getPlan() as any[]).find((d) => Number(d.day_number) === Number(dayNumber));
  const items = Array.isArray(day?.items) ? day.items : [];
  return (
    items.find(
      (item: any) =>
        String(item.exercise) === exercise ||
        (id != null && resolveExerciseName(String(item.exercise)).exercise_id === id)
    ) ?? null
  );
}

// The plan days the lift sits on (resolved identity), in plan order.
function planDaysOf(exercise: string): number[] {
  const id = resolveExerciseName(exercise).exercise_id;
  const days: number[] = [];
  for (const day of getPlan() as any[]) {
    const items = Array.isArray(day?.items) ? day.items : [];
    const here = items.some(
      (item: any) =>
        String(item?.exercise ?? "") === exercise ||
        (id != null && resolveExerciseName(String(item?.exercise ?? "")).exercise_id === id)
    );
    if (here) days.push(Number(day.day_number));
  }
  return days;
}

// Is the lift the ANCHOR of a plan day it sits on: that day's first primary-tier (compound)
// item, prep and cardio aside — the same read the weekly dose ledger, the stress budget and
// the pairing pass use (weekly-dose-ledger.ts dayAnchorIndex).
function isDayAnchor(exercise: string): boolean {
  const id = resolveExerciseName(exercise).exercise_id;
  for (const day of getPlan() as any[]) {
    const items = (Array.isArray(day?.items) ? day.items : []).filter(
      (item: any) => item && String(item.kind ?? "strength").toLowerCase() !== "cardio" && String(item.exercise ?? "")
    );
    const anchor = items.find(
      (item: any) => !isPrepPlanItem(item) && planItemEffectTier(item) === PLAN_ITEM_EFFECT_TIER.primary
    );
    if (!anchor) continue;
    const name = String(anchor.exercise);
    if (name === exercise || (id != null && resolveExerciseName(name).exercise_id === id)) return true;
  }
  return false;
}

// The rep-range lever's own lift gates: never the day's anchor, never strength-range work,
// never a slot the progression engine is about to re-ground (the plan behind the log or out
// of its reach: its `reground` answer). The ladder already waits on the engine's own moves
// (a load step, a deload, a set step, an escalation) and on an untested slot.
function repSchemeLiftBlock(lift: PlateauPlanLift): UnitPlateauBlock | null {
  if (isDayAnchor(lift.exercise)) return "day_anchor";
  if (lift.rep_low == null || lift.rep_low < AUTONOMOUS_REP_SCHEME_MIN_REP_LOW) return "strength_range";
  if (nextPrescription(lift.exercise)?.reground === true) return "engine_moving";
  return null;
}

/** Why this rung may not be acted on by the server, or null. Reads that fail throw. */
function rungBlock(
  rung: UnitPlateauRung,
  ladder: UnitPlateauLadder,
  rows: readonly LadderChangeRow[],
  date: string,
  touches: (name: string, group: string | null) => boolean
): UnitPlateauBlock | null {
  const lift = rung.plan_lift as PlateauPlanLift;
  if (rung.lever !== "rep_scheme" && rung.lever !== "variation") return "not_autonomous";
  if (rung.lever === "variation" && rung.compound) return "anchor";
  // A change names ONE plan day's slot (applyPlanChange edits that day only), so a lift on
  // several days would be half-changed: a second range, or one slot rotated and its twin
  // not. The server leaves such a lift to the program redraw.
  if (planDaysOf(lift.exercise).length > 1) return "multi_day";
  if (lift.mode === "timed") return "timed";
  if (rung.lever === "rep_scheme") {
    const code = repSchemeLiftBlock(lift);
    if (code) return code;
  }
  if (hasConstraint(lift)) return "constraint_note";
  if (touches(lift.exercise, lift.muscle_group)) return "protected";
  if (rung.lever === "variation" && rung.candidate) {
    if (touches(rung.candidate.exercise, lift.muscle_group)) return "protected";
    if (String(storedConstraint(rung.candidate.exercise) ?? "").trim()) return "constraint_note";
  }
  const authorship = slotAuthorship(planItemStamp(lift.plan_item_id), null, date);
  if (authorship.fresh) return "fresh_prescription";
  // One server-owned structural change per lift per week: the volume step came first.
  const liftsTouched = [lift.exercise, ...(rung.lever === "variation" && rung.candidate ? [rung.candidate.exercise] : [])];
  if (otherStructuralChangeOnLift(liftsTouched, date, { self: STRUCTURAL_CHANGE_AGENTS.unit_plateau }))
    return "volume_step_this_week";
  if (rows.some((r) => r.unit_key === rung.unit_key && r.answer === "open")) return "open_draft";
  const blockId = ladder.block?.id ?? null;
  if (blockId != null) {
    if (rows.some((r) => r.unit_key === rung.unit_key && r.block_id === blockId)) return "block_used";
  } else {
    const from = addDaysISO(date, -NO_BLOCK_UNIT_DAYS) ?? date;
    if (rows.some((r) => r.unit_key === rung.unit_key && r.created >= from)) return "recent_change";
  }
  return null;
}

// ---- the premise ----------------------------------------------------------------------

/**
 * Does a routed ladder change still stand? `fits`: the ladder still names the same lever
 * (and, for a rotation, the same incoming lift) for the unit, the slot still holds what the
 * change was made against, and no gate holds it. `gone`: the lever or the incoming lift moved
 * on, or the slot changed (or the lift now sits on several plan days). `held`: the unit now
 * waits for a protective or explaining reason, a gate holds the lift, the INCOMING lift is
 * protected (pain, the pain band, an injury, a plan adaptation, a constraint note), or the
 * volume step changed the lift first this week. `unknown`: a read failed. `ownId`: the
 * change's own proposal id, so an open volume step counts against it only when written
 * earlier (with none, any open one does).
 */
export function unitPlateauChangeStillFits(
  parsed: any,
  asOf: string = localDateISO(),
  ownId: number | null = null
): UnitPlateauPremise {
  const step = parsed?.unit_plateau;
  const unitKey = String(step?.unit_key ?? "");
  const lever = String(step?.lever ?? "");
  if (!unitKey || (lever !== "rep_scheme" && lever !== "variation")) return "unknown";
  try {
    const date = String(asOf || localDateISO()).slice(0, 10);
    // The slot first: a change whose subject moved under it has no premise left, whatever
    // the ladder now says.
    const slot = slotNow(Number(step.day_number), String(step.lift ?? ""));
    if (!slot) return "gone";
    if (planDaysOf(String(step.lift ?? "")).length > 1) return "gone";
    if (lever === "rep_scheme") {
      if (Number(slot.rep_low) !== Number(step.from?.rep_low) || Number(slot.rep_high) !== Number(step.from?.rep_high))
        return "gone";
    } else {
      const to = String(step.to_lift ?? "");
      const toId = resolveExerciseName(to).exercise_id;
      const onPlan = (getPlan() as any[]).some((d) =>
        (Array.isArray(d.items) ? d.items : []).some(
          (item: any) => toId != null && resolveExerciseName(String(item.exercise)).exercise_id === toId
        )
      );
      if (!to || onPlan) return "gone";
    }
    const ladder = unitPlateauLadder(date);
    if (!ladder.available) return "unknown";
    const rung = ladder.units.find((u) => u.unit_key === unitKey);
    if (!rung || !rung.plan_lift) return "gone";
    if (rung.code === "unavailable") return "unknown";
    const touches = liftProtectedOn(date);
    // The INCOMING lift is held to the same protection as the outgoing one: pain reported
    // on it since the draft was written (the ladder's own candidate read skips it, and would
    // otherwise just name another variant while this draft lands the painful one).
    if (lever === "variation") {
      const to = String(step.to_lift ?? "");
      const group = rung.plan_lift.muscle_group;
      if (touches(to, group) || String(storedConstraint(to) ?? "").trim()) return "held";
    }
    if (rung.lever === "wait") return "held";
    if (rung.lever !== lever) return "gone";
    if (rung.plan_lift.exercise !== String(step.lift ?? "")) return "gone";
    // The ladder's current candidate must still be the lift this draft rotates in.
    if (lever === "variation") {
      const to = String(step.to_lift ?? "");
      const toId = resolveExerciseName(to).exercise_id;
      const candidate = String(rung.candidate?.exercise ?? "");
      const candidateId = candidate ? resolveExerciseName(candidate).exercise_id : null;
      const same = candidate === to || (toId != null && candidateId != null && Number(toId) === Number(candidateId));
      if (!same) return "gone";
    }
    const lift = rung.plan_lift;
    if (touches(lift.exercise, lift.muscle_group)) return "held";
    if (hasConstraint(lift)) return "held";
    if (slotAuthorship(planItemStamp(lift.plan_item_id), null, date).fresh) return "held";
    if (lever === "rep_scheme" && repSchemeLiftBlock(lift)) return "held";
    const liftsTouched = [lift.exercise, ...(lever === "variation" ? [String(step.to_lift ?? "")] : [])];
    if (
      otherStructuralChangeOnLift(liftsTouched, date, {
        self: STRUCTURAL_CHANGE_AGENTS.unit_plateau,
        before: ownId ?? Number.MAX_SAFE_INTEGER,
      })
    )
      return "held";
    return "fits";
  } catch {
    return "unknown";
  }
}

// ---- the pass -------------------------------------------------------------------------

function withdraw(id: number, withdrawn: number[]): void {
  // Quietly: the athlete did not answer it, so it is not a "no".
  setProposalStatus(id, "superseded", { recordDecision: false });
  withdrawn.push(id);
}

function routedOutcome(
  id: number,
  rung: UnitPlateauRung,
  withdrawn: number[],
  blocked: UnitPlateauOutcome["blocked"],
  routed: any
) {
  const proposal = getProposal(id) as any;
  const step = proposal?.parsed?.unit_plateau;
  const autonomy = proposal?.autonomy ?? null;
  const asked = routed?.review_required === true || autonomy?.status === "review";
  return outcome("routed", {
    unit_key: rung.unit_key,
    lever: rung.lever as "rep_scheme" | "variation",
    lift: rung.plan_lift?.exercise ?? null,
    to_lift: typeof step?.to_lift === "string" ? step.to_lift : null,
    rep_low: Number.isFinite(Number(step?.to?.rep_low)) ? Number(step.to.rep_low) : null,
    rep_high: Number.isFinite(Number(step?.to?.rep_high)) ? Number(step.to.rep_high) : null,
    tier: String(routed?.tier ?? routed?.decision?.autonomy_tier ?? autonomy?.tier ?? "") || null,
    proposal_id: id,
    decision_id: routed?.decision?.id ?? autonomy?.id ?? null,
    effective_date: routed?.effective_date ?? routed?.decision?.effective_date ?? autonomy?.effective_date ?? null,
    summary: typeof proposal?.parsed?.summary === "string" ? proposal.parsed.summary : null,
    explanation: asked
      ? typeof step?.explanation === "string"
        ? step.explanation
        : null
      : typeof proposal?.parsed?.rationale === "string"
        ? proposal.parsed.rationale
        : null,
    ...(asked ? { asked: true } : {}),
    withdrawn,
    blocked,
  });
}

/**
 * Read the ladder and make at most ONE bounded ladder change (a rep range at the held
 * load, or an accessory's rotation at a block boundary) through the ordinary autonomy path
 * with Undo — or nothing. `act:false` never routes (status `deferred`); `dry:true` writes
 * nothing and reports what an acting pass would do (`would_route`). Idempotent. Never
 * throws: every read failing is `unavailable` (nothing changed, nothing withdrawn).
 */
export function settleUnitPlateau(opts: { date?: string; act?: boolean; dry?: boolean } = {}): UnitPlateauOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const dry = opts.dry === true;
  const act = opts.act !== false;
  try {
    return runPass(date, act, dry);
  } catch {
    return outcome("unavailable");
  }
}

function runPass(date: string, act: boolean, dry: boolean): UnitPlateauOutcome {
  const ladder = unitPlateauLadder(date);
  if (!ladder.available) return outcome("unavailable");
  const touches = liftProtectedOn(date);
  let rows = ladderChangeRows();

  // Open drafts whose premise is gone (or that no longer wait on anyone) are withdrawn quietly.
  const withdrawn: number[] = [];
  for (const row of rows) {
    if (row.status !== "draft") continue;
    const proposal = getProposal(row.id) as any;
    const live = ["review", "pending", "announced"].includes(String(proposal?.autonomy?.status ?? ""));
    // A week that merely holds it changes nothing; the boundary re-reads it.
    if (!live || unitPlateauChangeStillFits(proposal?.parsed, date, row.id) === "gone") {
      if (dry) withdrawn.push(row.id);
      else withdraw(row.id, withdrawn);
    }
  }
  if (withdrawn.length && !dry) rows = ladderChangeRows();

  // At most MAX_UNITS_PER_WEEK units changed (or offered) this calendar week.
  const monday = mondayOf(date);
  const thisWeek = new Set(rows.filter((r) => r.created >= monday && !withdrawn.includes(r.id)).map((r) => r.unit_key));
  if (thisWeek.size >= MAX_UNITS_PER_WEEK) return outcome("held", { hold: "week_used", withdrawn });

  const blocked: UnitPlateauOutcome["blocked"] = [];
  for (const rung of ladder.units) {
    if (rung.lever !== "rep_scheme" && rung.lever !== "variation") continue;
    if (thisWeek.has(rung.unit_key)) continue;
    const code = rungBlock(rung, ladder, rows, date, touches);
    if (code) {
      blocked.push({ unit_key: rung.unit_key, lever: rung.lever, code });
      continue;
    }
    const payload = unitPlateauProposalPayload(rung, date, ladder.block?.id ?? null);
    if (!payload) continue;
    const base: Partial<UnitPlateauOutcome> = {
      unit_key: rung.unit_key,
      lever: rung.lever,
      lift: rung.plan_lift?.exercise ?? null,
      to_lift: rung.candidate?.exercise ?? null,
      rep_low: rung.rep_range?.rep_low ?? null,
      rep_high: rung.rep_range?.rep_high ?? null,
      summary: String(payload.summary ?? "") || null,
      explanation: String(payload.rationale ?? "") || null,
      withdrawn,
      blocked,
    };
    if (!act) return outcome("deferred", base);
    if (dry) return outcome("would_route", base);
    const proposal = createProposal(UNIT_PLATEAU_AGENT, UNIT_PLATEAU_INSTRUCTION, "", payload) as any;
    const id = Number(proposal?.id);
    if (!Number.isFinite(id) || id <= 0) return outcome("none", { withdrawn, blocked });
    const routed = applyProposalWithAutonomy(id, {}) as any;
    if (routed?.review_required === true) return routedOutcome(id, rung, withdrawn, blocked, routed);
    if (routed?.ok === true && routed?.superseded !== true && routed?.decision?.id != null)
      return routedOutcome(id, rung, withdrawn, blocked, routed);
    // A routing that neither acted nor held leaves nothing behind.
    if ((getProposal(id) as any)?.status === "draft") setProposalStatus(id, "superseded", { recordDecision: false });
    return outcome("none", { withdrawn, blocked });
  }
  return outcome("none", { withdrawn, blocked });
}

/** What the next acting pass WOULD do, without writing anything. */
export function previewUnitPlateau(date?: string): UnitPlateauOutcome {
  return settleUnitPlateau({ date, act: true, dry: true });
}

// The change's own premise stands in for the evidence fingerprint at routing and at the
// boundary; it never lands into a session composed on its plan day; a held draft speaks
// its own sentence (autonomy-service.ts registerServerPremise).
registerServerPremise({
  owns: (proposal) => String(proposal?.agent ?? "") === UNIT_PLATEAU_AGENT && !!proposal?.parsed?.unit_plateau,
  premise: (proposal, asOf) =>
    unitPlateauChangeStillFits(
      proposal.parsed,
      asOf,
      Number.isFinite(Number(proposal?.id)) ? Number(proposal.id) : null
    ),
  waits_for_composed_day: true,
  explanation: (proposal) => proposal?.parsed?.unit_plateau?.explanation,
});
