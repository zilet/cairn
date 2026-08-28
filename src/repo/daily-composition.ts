import { normalizeSessionSuggestionResult } from "./adaptive-session.js";
// Imported explicitly, NOT leaned on as a global: client-globals.d.ts declares a
// `pickDayVariant` for the client bundle's shared scope, so a server module that
// forgets this import still typechecks and then throws at runtime.
import { pickDayVariant } from "./brain/day-read-rules.js";
import { cardioPlanIdentity } from "./cardio-plan-identity.js";
import { canonicalGroup, normalizedExerciseKey } from "./exercise-canon.js";
import { cardioPainRelevance, REACH_NO_ROOM_WHY, type DailyDecisionEnvelope } from "./daily-decision.js";
import {
  equipmentCompatibility,
  inferExerciseEquipment,
  parseEquipmentCapability,
} from "./equipment-capability.js";
import {
  findExercise,
  hasUnloadedWorkingHistory,
  recentWorkingSeconds,
  recentWorkingWeight,
} from "./exercises.js";
import { type LongRunRamp, longRunPrescription, longRunRampNote } from "./long-run-ramp.js";
import { getPlanDay } from "./plan.js";
import { adaptBasePlanDayForRecovery } from "./recovery-cycles.js";

// Stage 3 of the adaptive daily training plan — bounded agent composition.
// The agent composes INSIDE the deterministic Stage 2 envelope; it never
// redefines safety. This module is the server-side normalizer + deterministic
// fallback that make that boundary real: every agent item is re-verified,
// clamped, and checked against the envelope's exclusions/caps and the
// safe-exercise-introduction rules, and any invalid/empty/over-excluded output
// falls back to a usable deterministic session built from the same envelope.

export interface ComposedSession {
  name: string | null;
  focus: string | null;
  why: string | null;
  est_minutes: number | null;
  items: any[];
}

export interface CompositionValidation {
  ok: boolean;
  reason: string | null;
  rejected: Array<{ exercise: string; reason: string }>;
  novel_introduced: number;
  capped: boolean;
  reach_landed: boolean;
}

function volumeCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 4;
    case "reduced":
      return 7;
    default:
      return 12;
  }
}

function workingSetCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 6;
    case "reduced":
      return 12;
    default:
      return 24;
  }
}

// The REDUCED areas are a safety decision the server already made — a group that
// is still carrying recent work, or one running above its productive volume.
// Until now `reduced` reached the session as a LINE IN THE PROMPT ("keep light,
// do NOT overload") and NOTHING else, so an agent that ignored it was never
// corrected. That breaks the law the rest of this module exists to enforce:
// safety logic is deterministic, agents only phrase it.
//
// It CLAMPS rather than rejects, because "reduced" means less, not none. The
// envelope deliberately still ALLOWS these areas; dropping their items would
// silently delete work the plan calls for and hand the athlete a thinner session
// than anyone decided on. So sets come down and the target is eased, and both
// compose with (never override) any deeper day-level easing already in force.
const REDUCED_ITEM_SET_CAP = 2;
const REDUCED_INTENSITY_FACTOR = 0.9;

function perItemSetCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 2;
    case "reduced":
      return 3;
    default:
      return 6;
  }
}

function scaledTarget(value: unknown, factor: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return value == null ? null : Number(value);
  // Negative weight means assistance. Multiplying it toward zero would make
  // the movement harder, so retain the known safe anchor instead.
  if (n < 0) return n;
  return Math.round(n * factor * 100) / 100;
}

const ADAPTATION_NOTE_BUDGET = 500;

// The athlete's own note is never truncated. It carries their safety cues — a
// "sharp pain = stop" sits at the END of a long one — so trimming the tail to fit
// a composition sentence would cut exactly the line that must survive. The
// server's sentence is the part that yields: if the prefix will not fit in front
// of the existing note, the note stands alone.
function adaptationNote(note: unknown, text: string): string {
  const existing = String(note ?? "").trim();
  if (!existing) return String(text).slice(0, ADAPTATION_NOTE_BUDGET);
  if (existing.toLowerCase().includes(text.toLowerCase())) return existing;
  const lead = `${String(text).replace(/[.]+$/, "")}. `;
  if (lead.length + existing.length > ADAPTATION_NOTE_BUDGET) return existing;
  return `${lead}${existing}`;
}

// Athlete-facing composition notes. Each branch is a SET rotated by day + exercise
// so two lifts in the same state on one screen do not print the same sentence, and
// one lift stays stable all day. Index 0 is the canonical phrasing.
export const REDUCED_AREA_NOTES: readonly [string, ...string[]] = [
  "Kept light — this area is still carrying recent work",
  "This area is still working through what you did recently, so it stays light today",
  "Keeping this one light; the area hasn't fully come back from the last few days",
  "A lighter look here — this area is still carrying recent work",
  "Still some recent work sitting in this area, so it stays on the lighter side",
];

export const EASED_TODAY_NOTES: readonly [string, ...string[]] = [
  "Eased for today.",
  "Eased for today. This one is set a little easier.",
  "Eased for today. Leave a little more in the tank on this lift.",
  "Eased for today. Keep the effort honest and stop a bit earlier.",
];

export const HOLD_TARGET_NOTES: readonly [string, ...string[]] = [
  "Holding the current target today",
  "Same target as last time — hold here",
  "Keep this one where it is today",
  "No change on the load today; hold what you've been using",
];

function compositionNoteFor(
  variants: readonly [string, ...string[]],
  date: string,
  code: string,
  exercise: unknown
): string {
  return pickDayVariant(variants, date, `daily-composition:${code}:${normalizedExerciseKey(String(exercise ?? ""))}`);
}

// A hold/deload already has a progression why on the card. Prepending a second
// hold sentence is the double-speak this module used to print every morning.
function itemAlreadyHasProgressionHoldWhy(
  candidate: DailyDecisionEnvelope["candidates"][number] | undefined
): boolean {
  const action = candidate?.action;
  if (action !== "hold" && action !== "deload") return false;
  const why = String(candidate?.progression_evidence?.why ?? "").trim();
  return why.length > 0;
}

function trustedCandidateMetadata(candidate: DailyDecisionEnvelope["candidates"][number] | undefined) {
  if (!candidate) return {};
  return {
    brain_decision_id: candidate.brain_decision_id ?? null,
    brain_change_summary: candidate.brain_change_summary ?? null,
    brain_change_reason: candidate.brain_change_reason ?? null,
    brain_change_reason_provenance: candidate.brain_change_reason_provenance ?? null,
    brain_change_reversible: candidate.brain_change_reversible ?? null,
  };
}

function applyAuthorizedTarget(item: any, candidate: DailyDecisionEnvelope["candidates"][number] | undefined): boolean {
  const target = candidate?.authorized_target;
  if (!target) return false;
  let changed = false;
  const assign = (key: string, value: number | null) => {
    if (item[key] !== value) {
      item[key] = value;
      changed = true;
    }
  };
  // The progression target owns challenge (rep range, load, or duration), while
  // the accepted daily composition owns volume. Keeping those responsibilities
  // separate lets recovery-cycle fractions and legitimate one-day set changes
  // survive without giving the agent freedom to invent a heavier target.
  assign("rep_low", target.mode === "timed" ? null : target.rep_low);
  assign("rep_high", target.mode === "timed" ? null : target.rep_high);
  assign("target_weight", target.mode === "timed" ? null : target.target_weight);
  assign("target_seconds", target.mode === "timed" ? target.target_seconds : null);
  if (item.mode !== target.mode) {
    item.mode = target.mode;
    changed = true;
  }
  return changed;
}

function applyRecoveryCycleTarget(item: any, envelope: DailyDecisionEnvelope): boolean {
  const cycle = envelope.recovery_cycle;
  if (!cycle || (cycle.effective_status !== "active" && cycle.effective_status !== "recheck")) return false;
  const adapted = adaptBasePlanDayForRecovery(
    { items: [item] },
    { working_set_fraction: cycle.working_set_fraction }
  ).items[0];
  if (!adapted) return false;
  Object.assign(item, adapted);
  return true;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function holdAnchor(exercise: string, envelope: DailyDecisionEnvelope) {
  const planDay = envelope.template.day_number == null ? null : (getPlanDay(envelope.template.day_number) as any);
  const planned = (Array.isArray(planDay?.items) ? planDay.items : []).find(
    (item: any) => String(item?.exercise ?? "").toLowerCase() === exercise.toLowerCase()
  );
  const mode = findExercise(exercise)?.mode === "timed" || planned?.mode === "timed" ? "timed" : "reps";
  if (mode === "timed") {
    return {
      mode,
      target_seconds: recentWorkingSeconds(exercise) ?? finite(planned?.target_seconds),
      target_weight: null,
    };
  }
  return {
    mode,
    target_seconds: null,
    target_weight: recentWorkingWeight(exercise) ?? finite(planned?.target_weight),
  };
}

function clampHeldTarget(item: any, envelope: DailyDecisionEnvelope): boolean {
  const anchor = holdAnchor(String(item.exercise ?? ""), envelope);
  let changed = false;
  if (anchor.mode === "timed") {
    if (item.target_weight != null) {
      item.target_weight = null;
      changed = true;
    }
    const requested = finite(item.target_seconds);
    if (anchor.target_seconds != null && requested != null && requested > anchor.target_seconds) {
      item.target_seconds = anchor.target_seconds;
      changed = true;
    }
    return changed;
  }

  const requested = finite(item.target_weight);
  const baseline = anchor.target_weight;
  if (baseline == null) {
    if (item.target_weight != null) {
      item.target_weight = null;
      changed = true;
    }
    return changed;
  }
  // Positive weight is external load, so larger is harder. Negative weight is
  // assistance, so closer to zero is harder. A hold may move easier in either
  // regime, but it may never cross the authoritative working/planned anchor.
  if (requested == null || requested > baseline) {
    item.target_weight = baseline;
    changed = true;
  }
  return changed;
}

// ---- the peak week's top tier ------------------------------------------------
// A peak/realization day is TWO-tier work: one heavy set worked up to, then the
// back-off block. `authorized_target` has only ever described the back-off block —
// correctly, since a consumer that knows nothing about peak weeks must land on a
// real session rather than on one near-maximal single with the rest missing — so
// the heavy set survived only as prose inside the candidate's note, and the
// composed session the athlete actually read was the back-off block alone.
//
// It is inserted HERE, from the envelope, and nowhere else. Both composition
// paths (the deterministic fallback and the agent's own) come through this
// normalizer, so one insertion point covers both; and because `normalizeItem`
// whitelists item fields, an agent has no way to author or forge a top set of its
// own. Like every other authorized number, it is the server's to grant.

const TOP_SET_NOTES: readonly [string, ...string[]] = [
  "Work up to this single, then drop to the block below.",
  "One heavy set first — build up to it, then take the back-off work.",
  "Open with this after your warm-up singles, then the block underneath.",
];

export const REACH_TOP_SET_NOTES: readonly [string, ...string[]] = [
  "If the warm-ups move well, take one heavier single-set reach here — stop with a rep in hand",
  "You've earned a heavier look at this one today — one set, leave a rep in the tank",
  "Recovery's backing you — take the top set if the bar moves fast",
  "If the bar moves fast, take one heavier set here and stop with a rep waiting",
];

export const REACH_AMRAP_NOTES: readonly [string, ...string[]] = [
  "Last set: as many clean reps as you have, one in reserve",
  "On the last set, keep going for clean reps and leave one in the tank",
  "Finish with as many clean reps as you have — stop with one in reserve",
  "Last set is the reach: clean reps, one left in the tank",
];

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

// A peak single is a near-maximal effort, and every day-level brake in this file
// exists because near-maximal is exactly what those days are not for. The
// candidate gate in daily-decision already withdraws the top set when the LIFT
// steps back; this is the same question asked of the DAY, which can be eased by a
// cap the lift never saw.
function dayAllowsTopSet(envelope: DailyDecisionEnvelope): boolean {
  if (envelope.caps.intensity !== "normal") return false;
  if (envelope.caps.volume === "minimal") return false;
  const cycle = envelope.recovery_cycle;
  if (cycle && (cycle.effective_status === "active" || cycle.effective_status === "recheck")) return false;
  if (envelope.request.train_anyway === true) return false;
  return true;
}

function reachChallengeOpen(envelope: DailyDecisionEnvelope): boolean {
  if (envelope.reach?.level !== "push") return false;
  if (envelope.precedence.includes("reach_trimmed_by_fueling")) return false;
  if (envelope.soft_preferences.some((entry) => entry.code === "reach_trimmed_by_fueling")) return false;
  if (envelope.soft_preferences.some((entry) => entry.code === "reach_no_room")) return false;
  return dayAllowsTopSet(envelope);
}

function itemMuscleGroup(item: any): string | null {
  const stored = findExercise(item?.exercise);
  const raw = stored?.muscle_group ?? item?.muscle_group;
  if (!raw) return null;
  const group = String(raw).toLowerCase();
  return canonicalGroup(group) ?? group;
}

function reachHostLoad(exercise: string): { kind: "loaded"; weight: number } | { kind: "unloaded" } | null {
  const working = recentWorkingWeight(exercise);
  if (working != null && working > 0) return { kind: "loaded", weight: working };
  if (working != null && working < 0) return { kind: "unloaded" };
  if (hasUnloadedWorkingHistory(exercise)) return { kind: "unloaded" };
  return null;
}

function isReachHostItem(
  item: any,
  reducedExercises: Set<string>,
  saturatedGroups: Set<string>,
  excludedGroups: Set<string>
): boolean {
  if (!item) return false;
  if (item.kind === "cardio" || item.mode === "timed") return false;
  const exercise = String(item.exercise ?? "");
  if (!exercise) return false;
  if (reducedExercises.has(exercise.toLowerCase())) return false;
  const group = itemMuscleGroup(item);
  // Unknown area is not "safe" — skip rather than host a reach we cannot certify.
  if (!group) return false;
  if (excludedGroups.has(group) || excludedGroups.has(String(group).toLowerCase())) return false;
  if (saturatedGroups.has(group) || saturatedGroups.has(String(group).toLowerCase())) return false;
  return reachHostLoad(exercise) != null;
}

function reconcileEnvelopeReach(envelope: DailyDecisionEnvelope, landed: boolean): void {
  if (envelope.reach?.level !== "push") return;
  if (landed) return;
  if (envelope.soft_preferences.some((entry) => entry.code === "reach_trimmed_by_fueling")) return;
  if (envelope.soft_preferences.some((entry) => entry.code === "reach_no_room")) return;
  const why = pickDayVariant(REACH_NO_ROOM_WHY, envelope.date, "daily_decision:reach_no_room");
  // Mutate nested fields in place. Assigning `envelope.reach =` / `envelope.precedence =`
  // would miss a shallow-copied caller, while push/splice land on the original.
  envelope.reach.level = "push";
  envelope.reach.why = why;
  if (!Array.isArray(envelope.reach.backed_by)) envelope.reach.backed_by = [];
  // Soft-only: composition already treats a precedence entry as a constraint
  // (`reach_trimmed_by_fueling`), so a no-room code must not join that list.
  envelope.soft_preferences.push({ code: "reach_no_room", detail: why });
  for (let i = envelope.precedence.length - 1; i >= 0; i--) {
    if (envelope.precedence[i] === "backed_day_reach") envelope.precedence.splice(i, 1);
  }
  let replaced = false;
  for (const line of envelope.rationale) {
    if (line.code === "backed_day_reach") {
      line.code = "reach_no_room";
      line.text = why;
      replaced = true;
    }
  }
  if (!replaced) envelope.rationale.push({ code: "reach_no_room", text: why });
}

// The heavy single as an item, shaped exactly like every other normalized reps
// item so no renderer needs to learn a second shape. Null when this back-off item
// cannot honestly carry one.
function topSetItemFor(backoff: any, candidate: any, dateISO: string): Record<string, unknown> | null {
  const top = candidate?.top_set;
  if (!top) return null;
  if (backoff?.kind === "cardio" || backoff?.mode === "timed") return null;
  const weight = finite(top.weight);
  const reps = finite(top.reps);
  if (weight == null || reps == null || reps <= 0) return null;
  // A "top set" at or under the block it leads into is a broken payload rather
  // than a protocol — and every clamp above may have moved the block down.
  const blockWeight = finite(backoff?.target_weight);
  if (blockWeight == null || weight <= blockWeight) return null;
  const note = pickDayVariant(TOP_SET_NOTES, dateISO, "daily-composition:top-set");
  return {
    position: 0, // renumbered with the rest once the insertion is done
    kind: "strength",
    exercise: backoff.exercise,
    sets: 1,
    rep_low: reps,
    rep_high: reps,
    target_weight: weight,
    target_seconds: null,
    warmup_sets: null,
    mode: "reps",
    note,
    target_distance_km: null,
    target_duration_min: null,
    target_zone: null,
    interval: null,
    superset_group: null,
    reach: { weight, reps, note },
  };
}

function reachTopSetItemFor(backoff: any, working: number, dateISO: string): Record<string, unknown> | null {
  if (backoff?.kind === "cardio" || backoff?.mode === "timed") return null;
  if (working == null || working <= 0) return null;
  const weight = round5(working * 1.075);
  if (weight <= working) return null;
  // A "heavier look" that does not sit above the block the athlete will actually
  // work is not a reach — skip rather than print a same-or-lighter top set.
  const blockWeight = finite(backoff?.target_weight);
  if (blockWeight != null && weight <= blockWeight) return null;
  const note = pickDayVariant(REACH_TOP_SET_NOTES, dateISO, "daily-composition:reach-top-set");
  return {
    position: 0,
    kind: "strength",
    exercise: backoff.exercise,
    sets: 1,
    rep_low: 3,
    rep_high: 5,
    target_weight: weight,
    target_seconds: null,
    warmup_sets: null,
    mode: "reps",
    note,
    target_distance_km: null,
    target_duration_min: null,
    target_zone: null,
    interval: null,
    superset_group: null,
    reach: { weight, reps: 3, note },
  };
}

function applyReachAmrap(item: any, dateISO: string): boolean {
  const note = pickDayVariant(REACH_AMRAP_NOTES, dateISO, "daily-composition:reach-amrap");
  const next = adaptationNote(item.note, note);
  item.note = next;
  item.reach = { note, amrap: true };
  return true;
}

const HARD_CARDIO_LANGUAGE =
  /\b(?:all[- ]?out|anaerobic|fast|hard|hill repeats?|intervals?|race pace|sprints?|tempo|threshold|vo2(?:\s*max)?|z(?:one\s*)?[3-5])\b/i;

function easyCardioName(exercise: unknown): string {
  const text = String(exercise ?? "").toLowerCase();
  if (/\b(?:run|running|jog|jogging)\b/.test(text)) return "Easy run";
  if (/\b(?:ride|riding|bike|biking|cycle|cycling)\b/.test(text)) return "Easy ride";
  if (/\b(?:row|rowing|erg)\b/.test(text)) return "Easy row";
  if (/\b(?:swim|swimming)\b/.test(text)) return "Easy swim";
  if (/\b(?:hike|hiking)\b/.test(text)) return "Easy hike";
  if (/\b(?:walk|walking)\b/.test(text)) return "Easy walk";
  return "Easy cardio";
}

function safeEasySessionText(value: string | null, fallback: string): string {
  return value && !HARD_CARDIO_LANGUAGE.test(value) ? value : fallback;
}

// ---- the modality hold: a quiet day after a hard run is not another run ----
// The envelope decides WHETHER (daily-decision's `endurance_hold`, off yesterday's
// endurance and the same acute leg residual that gates strength items); this decides
// WHAT INSTEAD. Leg-driven endurance — run, ride, row, hike, stairs — becomes an easy
// walk, which is movement the residual does not care about. Swimming and anything
// already a walk are left alone, and the strength half of the day is untouched: it is
// gated by the muscle model, so what survives is exactly the upper-body-only session
// the ruling asks for.
const LEG_DRIVEN_CARDIO =
  /\b(?:run|running|jog|jogging|ride|riding|bike|biking|cycle|cycling|spin|row|rowing|erg|hike|hiking|stair|stairs|elliptical|treadmill)\b/i;

// The hold fires for two DIFFERENT reasons and the words have to match which one
// applied. `longest_run_yesterday` / `hard_endurance_yesterday` are endurance
// evidence — yesterday's RUN is the thing in the legs, and saying so is true. But
// `legs_saturated` alone is the muscle model talking: it can be saturated purely by
// a heavy squat day with no running anywhere in the week, and telling that athlete
// "yesterday's running is still in your legs" is a sentence outrunning its evidence.
// So the note is chosen from the envelope's OWN `endurance_hold.reasons` — never
// re-derived here — and the lifting-only set names leg work without claiming a run.
const RUN_HELD_NOTE_ENDURANCE: readonly string[] = [
  "Yesterday's running is still in your legs — keep today's movement off them",
  "Your legs are still carrying yesterday's run, so this stays a walk today",
  "Today's easy movement stays off the legs while yesterday's running settles",
  "Walking rather than running today — yesterday's endurance work is still there",
];

const RUN_HELD_NOTE_LEGS: readonly string[] = [
  "Your legs are still carrying yesterday's work — walking today instead of running",
  "Recent leg work is still settling, so today's movement stays a walk",
  "Keeping today off the legs while the last leg session clears",
  "Walking rather than running — your legs have had enough load lately",
];

// Which reasons make the running language TRUE. Anything else (today: legs_saturated)
// falls through to the leg-work wording.
const ENDURANCE_HOLD_RUN_REASONS: ReadonlySet<string> = new Set([
  "longest_run_yesterday",
  "hard_endurance_yesterday",
]);

function runHeldNote(envelope: DailyDecisionEnvelope): string {
  const reasons = envelope.endurance_hold?.reasons ?? [];
  const enduranceCaused = reasons.some((r) => ENDURANCE_HOLD_RUN_REASONS.has(String(r)));
  return enduranceCaused
    ? pickDayVariant(RUN_HELD_NOTE_ENDURANCE, envelope.date, "daily_composition:run_held:endurance")
    : pickDayVariant(RUN_HELD_NOTE_LEGS, envelope.date, "daily_composition:run_held:legs");
}

// Returns whether the hold APPLIED (so the easy clamp downstream knows not to
// overwrite the note it just wrote) alongside whether anything changed.
function holdLegDrivenCardio(item: any, envelope: DailyDecisionEnvelope): { held: boolean; changed: boolean } {
  if (envelope.endurance_hold?.no_run !== true) return { held: false, changed: false };
  const label = String(item?.exercise ?? "");
  if (!LEG_DRIVEN_CARDIO.test(label)) return { held: false, changed: false };
  let changed = false;
  if (item.exercise !== "Easy walk") {
    item.exercise = "Easy walk";
    changed = true;
  }
  if (item.target_zone !== "easy") {
    item.target_zone = "easy";
    changed = true;
  }
  if (item.interval != null) {
    item.interval = null;
    changed = true;
  }
  // A distance target written for a run is meaningless once the movement changed.
  if (item.target_distance_km != null) {
    item.target_distance_km = null;
    changed = true;
  }
  const note = runHeldNote(envelope);
  if (item.note !== note) {
    item.note = note;
    changed = true;
  }
  return { held: true, changed };
}

// ---------- the week's long run, shaped to what the legs have earned ----------
// Runs BEFORE the easy clamp and only when the day is genuinely offering a run:
// an endurance hold has already turned this item into a walk with no distance on
// it, and a forced-easy day drops the distance target entirely, so a ramp applied
// there would be arithmetic over a number about to be deleted.
//
// The note it writes is preserved through the clamp for the same reason the hold's
// note is: the generic easy-clamp sentence is the weaker of the two, and it was
// built to fill a silence rather than to overwrite an explanation.
function rampedNote(ramp: LongRunRamp, authored: string, date: string): string {
  const sentence = longRunRampNote(ramp, date);
  // The athlete's own coaching detail ("negative split the back half") is the part of
  // this card nobody else could have written. The ramp explains the NUMBER; it was
  // never entitled to delete the instruction sitting beside it.
  return (authored ? `${authored} — ${sentence}` : sentence).slice(0, 500);
}

function applyLongRunRamp(
  item: any,
  envelope: DailyDecisionEnvelope
): { applied: boolean; changed: boolean; ramp?: LongRunRamp; authored?: string } {
  const distance = finite(item?.target_distance_km);
  if (distance == null || distance <= 0) return { applied: false, changed: false };
  // Distance history is RUN history. A 40 km ride is not a step on the same ladder,
  // and the identity read is the one place that question is already answered.
  if (cardioPlanIdentity(item).sport !== "run") return { applied: false, changed: false };
  const ramp = longRunPrescription(envelope.date, distance);
  if (!ramp || !ramp.building) return { applied: false, changed: false };
  item.target_distance_km = ramp.prescribed_km;
  // A duration written for the template distance would now prescribe the same clock
  // for a shorter run, which is a pace instruction nobody gave. Scaled with the
  // distance so the effort stays the effort the plan asked for.
  const duration = finite(item.target_duration_min);
  if (duration != null && duration > 0) {
    item.target_duration_min = Math.round(duration * (ramp.prescribed_km / ramp.template_km));
  }
  const authored = String(item.note ?? "").trim();
  item.note = rampedNote(ramp, authored, envelope.date);
  return { applied: true, changed: true, ramp, authored };
}

/**
 * The clamp downstream may rescale the distance against the day's duration cap, and
 * `preserveNote` protects the ramp's WORDS without protecting its number — so a 9 km
 * card clamped to 40 minutes could end up reading "9 km today" above a 5.2 km
 * prescription. Re-say the same sentence (same variant, same date pick) about the
 * distance that actually landed. Only when the two genuinely disagree: half-kilometre
 * rounding is not a contradiction worth rewriting a note over.
 */
const RAMP_NOTE_DRIFT_KM = 0.25;

function resyncRampNote(item: any, ramp: LongRunRamp, authored: string, envelope: DailyDecisionEnvelope): boolean {
  const finalKm = finite(item?.target_distance_km);
  if (finalKm == null || finalKm <= 0) return false;
  if (Math.abs(finalKm - ramp.prescribed_km) <= RAMP_NOTE_DRIFT_KM) return false;
  const note = rampedNote({ ...ramp, prescribed_km: finalKm }, authored, envelope.date);
  if (item.note === note) return false;
  item.note = note;
  return true;
}

function clampCardioItem(
  item: any,
  envelope: DailyDecisionEnvelope,
  forceEasy: boolean,
  // The endurance hold already wrote the note that explains WHY this is a walk.
  // The generic easy-clamp note below is the weaker sentence of the two, and it was
  // silently replacing it on every quiet day (which is every day the hold can fire).
  preserveNote = false
): boolean {
  let changed = false;
  const durationCap = envelope.caps.duration_min;
  const requestedDuration = finite(item.target_duration_min);
  const requestedDistance = finite(item.target_distance_km);

  if (durationCap != null) {
    if (requestedDuration == null || requestedDuration > durationCap) {
      item.target_duration_min = durationCap;
      changed = true;
    }
    if (requestedDistance != null && requestedDuration != null && requestedDuration > durationCap) {
      const scaledDistance = Math.round(requestedDistance * (durationCap / requestedDuration) * 100) / 100;
      if (scaledDistance !== requestedDistance) {
        item.target_distance_km = scaledDistance;
        changed = true;
      }
    }
  }

  if (forceEasy) {
    const easyName = easyCardioName(item.exercise);
    if (item.exercise !== easyName) {
      item.exercise = easyName;
      changed = true;
    }
    if (item.target_zone !== "easy") {
      item.target_zone = "easy";
      changed = true;
    }
    if (item.interval != null) {
      item.interval = null;
      changed = true;
    }
    // A distance target can silently preserve the hard pace after duration is
    // shortened. The envelope has no pace anchor, so a restrictive day remains
    // time-based and conversational instead of inventing a "safe" distance.
    if (item.target_distance_km != null) {
      item.target_distance_km = null;
      changed = true;
    }
    const note = "Easy conversational effort; no intervals today";
    if (!preserveNote && item.note !== note) {
      item.note = note;
      changed = true;
    }
  }
  return changed;
}

function baselineNote(note: string | null): string {
  const base = "NEW — establishing a baseline; keep it light and log the actual load";
  const trimmed = (note ?? "").trim();
  if (!trimmed) return base;
  if (/baseline/i.test(trimmed)) return trimmed.slice(0, 500);
  return `${base}. ${trimmed}`.slice(0, 500);
}

// Verify + clamp an agent composition against the envelope. Returns a normalized
// session (identical in shape to a session suggestion) or null when nothing
// usable survives. Enforced here, never trusted from the agent:
//   - every item re-runs the agent-source normalization (load clamps, shape);
//   - items loading an EXCLUDED muscle group are dropped;
//   - at most ONE novel (not-yet-known) movement family is admitted, with no
//     falsely precise load and a baseline label;
//   - item count and duration are clamped to the envelope caps.
export function normalizeComposedSession(
  raw: unknown,
  envelope: DailyDecisionEnvelope
): { session: ComposedSession | null; validation: CompositionValidation } {
  const base = normalizeSessionSuggestionResult(raw);
  const rejected: Array<{ exercise: string; reason: string }> = [];
  if (!base) {
    return {
      session: null,
      validation: {
        ok: false,
        reason: "unparseable",
        rejected,
        novel_introduced: 0,
        capped: false,
        reach_landed: false,
      },
    };
  }
  if (envelope.kind === "rest" && envelope.request.train_anyway !== true) {
    for (const item of base.items) {
      rejected.push({ exercise: String(item.exercise), reason: "rest_requires_train_anyway" });
    }
    return {
      session: null,
      validation: {
        ok: false,
        reason: "rest_requires_train_anyway",
        rejected,
        novel_introduced: 0,
        capped: false,
        reach_landed: false,
      },
    };
  }
  const excluded = new Set(envelope.muscles.excluded.map((g) => g.toLowerCase()));
  const reducedGroups = new Set(
    (Array.isArray(envelope.muscles.reduced) ? envelope.muscles.reduced : []).map(
      (g) => canonicalGroup(g) ?? String(g).toLowerCase()
    )
  );
  // Resolved on the way past, while the stored exercise (and so its group) is in
  // hand — the clamping pass below works on item names alone.
  const reducedExercises = new Set<string>();
  const saturatedGroups = new Set(
    (Array.isArray(envelope.muscles.saturated) ? envelope.muscles.saturated : []).map(
      (g) => canonicalGroup(g) ?? String(g).toLowerCase()
    )
  );
  const hasProtectiveExclusion = envelope.hard_constraints.some((entry) => entry.code === "injury_exclusion");
  const protectiveExclusions = Array.isArray(envelope.protective_exclusions)
    ? envelope.protective_exclusions
    : null;
  const candidates = new Map(envelope.candidates.map((candidate) => [candidate.exercise.toLowerCase(), candidate]));
  const equipmentCapability = parseEquipmentCapability(envelope.request.equipment);
  let novelCount = 0;
  const kept: any[] = [];
  for (const item of base.items) {
    const isCardio = item.kind === "cardio";
    const exercise = isCardio
      ? cardioPlanIdentity(item).movement_label
      : String(item.exercise ?? "");
    if (isCardio) item.exercise = exercise;
    const candidate = candidates.get(exercise.toLowerCase());
    if (envelope.kind === "rest" && item.kind !== "cardio" && envelope.request.train_anyway !== true) {
      rejected.push({ exercise, reason: "rest_requires_train_anyway" });
      continue;
    }
    if (candidate?.action === "exclude") {
      rejected.push({ exercise, reason: "excluded_candidate" });
      continue;
    }
    if (
      isCardio &&
      envelope.reported_joint_pain &&
      cardioPainRelevance(exercise, [envelope.reported_joint_pain]) === true
    ) {
      rejected.push({ exercise, reason: "cardio_pain_relevant" });
      continue;
    }
    if (isCardio && hasProtectiveExclusion) {
      // Historical envelopes did not retain structured areas. Under a live hard
      // exclusion, absence of that evidence is uncertifiable rather than safe.
      if (protectiveExclusions == null) {
        rejected.push({ exercise, reason: "cardio_uncertified_under_exclusions" });
        continue;
      }
      const exactExcluded = protectiveExclusions.some((exclusion) =>
        exclusion.exercises.some(
          (excludedExercise) => excludedExercise.trim().toLowerCase() === exercise.trim().toLowerCase()
        )
      );
      const painRelevance = cardioPainRelevance(
        exercise,
        protectiveExclusions.flatMap((exclusion) => exclusion.areas)
      );
      if (exactExcluded || painRelevance !== false) {
        rejected.push({
          exercise,
          reason: exactExcluded ? "excluded_candidate" : "cardio_uncertified_under_exclusions",
        });
        continue;
      }
    }
    const stored = isCardio ? null : findExercise(exercise);
    if (!isCardio && equipmentCapability.recognized && equipmentCapability.restricted) {
      const compatibility = equipmentCompatibility(
        equipmentCapability,
        inferExerciseEquipment(item.exercise, stored?.equipment)
      );
      if (compatibility !== "compatible") {
        rejected.push({
          exercise,
          reason: compatibility === "incompatible" ? "equipment_incompatible" : "equipment_unverified",
        });
        continue;
      }
    }
    const group = stored?.muscle_group ? String(stored.muscle_group).toLowerCase() : null;
    if (group && excluded.has(group)) {
      rejected.push({ exercise, reason: "excluded_group" });
      continue;
    }
    if (group && reducedGroups.has(canonicalGroup(group) ?? group)) reducedExercises.add(exercise.toLowerCase());
    const novel = !isCardio && !stored;
    if (novel) {
      // A novel movement is not in the canon, so it carries no muscle_group and the
      // excluded-group filter above cannot verify what area it loads. When the envelope
      // excludes ANY muscle group, refuse novel introductions entirely — the server
      // cannot certify an unknown movement avoids the excluded area — and keep the rest
      // of the composition (the agent is told to compose from the canon in this case).
      if (excluded.size) {
        rejected.push({ exercise, reason: "novel_blocked_by_exclusions" });
        continue;
      }
      if (novelCount >= 1) {
        rejected.push({ exercise, reason: "extra_novel_movement" });
        continue;
      }
      novelCount++;
      // No performance baseline exists — never prescribe a falsely precise load.
      item.target_weight = null;
      item.note = baselineNote(item.note == null ? null : String(item.note));
    }
    kept.push(item);
  }
  if (!kept.length) {
    return {
      session: null,
      validation: {
        ok: false,
        reason: "all_items_excluded",
        rejected,
        novel_introduced: novelCount,
        capped: false,
        reach_landed: false,
      },
    };
  }
  const cap = volumeCap(envelope);
  const itemSetCap = perItemSetCap(envelope);
  let remainingSets = workingSetCap(envelope);
  let changed = kept.length > cap;
  const forceEasyCardio =
    envelope.request.train_anyway === true ||
    envelope.caps.intensity === "easy" ||
    envelope.caps.intensity === "deload";
  let hasEasyCardio = false;
  const capped: any[] = [];
  for (const item of kept.slice(0, cap)) {
    const next = { ...item };
    const candidate = candidates.get(String(next.exercise ?? "").toLowerCase());
    if (next.kind === "cardio") {
      if (applyRecoveryCycleTarget(next, envelope)) changed = true;
      // Before the easy clamp, not after: the clamp renames by MODALITY
      // (easyCardioName), so a run reaching it first is only ever an "Easy run".
      const hold = holdLegDrivenCardio(next, envelope);
      if (hold.changed) changed = true;
      // A held day still holds, and a forced-easy day still has no distance target:
      // the ramp only ever shapes a run that is actually being offered.
      const ramp =
        hold.held || forceEasyCardio
          ? ({ applied: false } as ReturnType<typeof applyLongRunRamp>)
          : applyLongRunRamp(next, envelope);
      if (ramp.applied) changed = true;
      if (clampCardioItem(next, envelope, forceEasyCardio, hold.held || ramp.applied)) changed = true;
      // The clamp may have rescaled the distance the note just named.
      if (ramp.applied && ramp.ramp && resyncRampNote(next, ramp.ramp, ramp.authored ?? "", envelope)) changed = true;
      Object.assign(next, trustedCandidateMetadata(candidate));
      if (forceEasyCardio) hasEasyCardio = true;
      capped.push(next);
      continue;
    }
    const requestedSets = Math.max(1, Number(next.sets) || 1);
    if (applyAuthorizedTarget(next, candidate)) changed = true;
    if (applyRecoveryCycleTarget(next, envelope)) changed = true;
    Object.assign(next, trustedCandidateMetadata(candidate));
    const isReduced = reducedExercises.has(String(next.exercise ?? "").toLowerCase());
    const authorizedSets = Math.max(1, Number(next.sets) || requestedSets);
    const setCapForItem = isReduced ? Math.min(itemSetCap, REDUCED_ITEM_SET_CAP) : itemSetCap;
    const boundedSets = Math.min(authorizedSets, setCapForItem, remainingSets);
    if (boundedSets < 1) {
      changed = true;
      continue;
    }
    if (boundedSets !== requestedSets || boundedSets !== authorizedSets) changed = true;
    next.sets = boundedSets;
    remainingSets -= boundedSets;

    let intensityFactor = 1;
    if (envelope.caps.intensity === "easy") intensityFactor = 0.8;
    else if (envelope.caps.intensity === "deload") intensityFactor = 0.9;
    // An authoritative progression deload target is already reduced by the
    // progression engine. Apply the legacy 10% fallback only when no exact
    // target crossed the decision boundary; independent day-level safety caps
    // (easy/recovery) may still reduce the exact target further.
    if (candidate?.action === "deload" && !candidate.authorized_target) {
      intensityFactor = Math.min(intensityFactor, 0.9);
    }
    // A reduced area never gets a heavier target than the day already allows.
    if (isReduced) intensityFactor = Math.min(intensityFactor, REDUCED_INTENSITY_FACTOR);
    const hold = candidate?.action === "hold" || envelope.caps.intensity === "hold";
    if (hold && clampHeldTarget(next, envelope)) changed = true;
    if (intensityFactor < 1) {
      if (next.mode === "timed" && next.target_seconds != null) {
        const seconds = Math.max(1, Math.round(Number(next.target_seconds) * intensityFactor));
        if (seconds !== next.target_seconds) changed = true;
        next.target_seconds = seconds;
      } else if (next.target_weight != null) {
        const weight = scaledTarget(next.target_weight, intensityFactor);
        if (weight !== next.target_weight) changed = true;
        next.target_weight = weight;
      }
      // Reduced-area and day-level easing say something the progression why does
      // not (this area is still carrying work; today's cap came down). Always add.
      next.note = adaptationNote(
        next.note,
        isReduced
          ? compositionNoteFor(REDUCED_AREA_NOTES, envelope.date, "reduced", next.exercise)
          : compositionNoteFor(EASED_TODAY_NOTES, envelope.date, "eased", next.exercise)
      );
    } else if (hold && !itemAlreadyHasProgressionHoldWhy(candidate)) {
      next.note = adaptationNote(
        next.note,
        compositionNoteFor(HOLD_TARGET_NOTES, envelope.date, "hold", next.exercise)
      );
    }
    capped.push(next);
  }
  // ---- the peak week's heavy single, ahead of its own back-off block ----
  // Last, so it reads every clamp above rather than racing them: the block's
  // weight here is the one the athlete will actually be shown, and a single that
  // no longer sits above it is not a top set. The budget is honoured too — the
  // heavy set is one working set like any other, and it never displaces work by
  // pushing the day past its own cap. The guard is against the FINAL list, not a
  // per-insertion snapshot: `capped` is already at most `cap` items, so every top
  // set inserted grows the final count past it unless something is checked against
  // the running total, not `withTopSets.length` (which counts BOTH the top sets
  // already inserted AND the back-off items already copied over, so re-checking it
  // per item silently rearms the budget on every iteration and can seat several top
  // sets in one day). Once the final list would land at `cap`, no further top set is
  // inserted — dropped, never displacing back-off work to make room. By design, a
  // fully-budgeted day (`capped.length === cap`) renders NO top set at all: there is
  // no slack left in the budget for the extra single.
  const withTopSets: any[] = [];
  let insertedTopSet = false;
  let topSetsInserted = 0;
  const topSetsAllowed = dayAllowsTopSet(envelope);
  const reachOpen = reachChallengeOpen(envelope);
  let reachHostConsumed = false;
  let reachLanded = false;
  for (const item of capped) {
    delete item.reach;
    const isHost =
      !reachHostConsumed && isReachHostItem(item, reducedExercises, saturatedGroups, excluded);
    const hostLoad = isHost ? reachHostLoad(String(item.exercise ?? "")) : null;
    if (topSetsAllowed && remainingSets >= 1 && capped.length + topSetsInserted + 1 <= cap) {
      const candidate = candidates.get(String(item.exercise ?? "").toLowerCase());
      let top = topSetItemFor(item, candidate, envelope.date);
      if (!top && reachOpen && isHost && hostLoad) {
        if (hostLoad.kind === "unloaded") {
          if (applyReachAmrap(item, envelope.date)) {
            changed = true;
            reachLanded = true;
            reachHostConsumed = true;
          }
        } else {
          top = reachTopSetItemFor(item, hostLoad.weight, envelope.date);
        }
      }
      if (top) {
        withTopSets.push(top);
        remainingSets -= 1;
        insertedTopSet = true;
        topSetsInserted += 1;
        changed = true;
        if (top.reach) {
          reachLanded = true;
          reachHostConsumed = true;
        }
      }
    } else if (reachOpen && isHost && hostLoad?.kind === "unloaded") {
      if (applyReachAmrap(item, envelope.date)) {
        changed = true;
        reachLanded = true;
        reachHostConsumed = true;
      }
    }
    withTopSets.push(item);
  }
  // Positions are only rewritten when something was actually inserted, so an
  // ordinary day's items come out of here byte-for-byte as they always have.
  if (insertedTopSet) withTopSets.forEach((item, index) => (item.position = index));
  const finalItems = insertedTopSet ? withTopSets : capped;
  // A peak single on a reach-open day is still a top set on a card, so the
  // envelope must not claim there was no room for one.
  if (reachOpen && insertedTopSet) reachLanded = true;
  reconcileEnvelopeReach(envelope, reachLanded);

  let est = base.est_minutes;
  if (envelope.caps.duration_min != null && (est == null || est > envelope.caps.duration_min)) {
    est = envelope.caps.duration_min;
    changed = true;
  }
  const fallbackWhy = envelope.rationale[0]?.text ?? "Keep today's work light and conversational.";
  return {
    session: {
      name: hasEasyCardio ? safeEasySessionText(base.name, "Easy session") : base.name,
      focus: hasEasyCardio ? safeEasySessionText(base.focus, "Easy movement") : base.focus,
      why: hasEasyCardio ? safeEasySessionText(base.why, fallbackWhy) : base.why,
      est_minutes: est,
      items: finalItems,
    },
    validation: {
      ok: true,
      reason: null,
      rejected,
      novel_introduced: novelCount,
      capped: changed,
      reach_landed: reachLanded,
    },
  };
}

function planItemToRaw(it: any): Record<string, unknown> {
  if (it?.kind === "cardio") {
    const identity = cardioPlanIdentity(it);
    return {
      kind: "cardio",
      exercise: identity.movement_label,
      target_distance_km: it.target_distance_km ?? null,
      target_duration_min: it.target_duration_min ?? null,
      target_zone: it.target_zone ?? null,
      interval: it.interval ?? it.interval_json ?? null,
      note: it.note ?? null,
      brain_decision_id: it.brain_decision_id ?? null,
      brain_change_summary: it.brain_change_summary ?? null,
      brain_change_reason: it.brain_change_reason ?? null,
      brain_change_reason_provenance: it.brain_change_reason_provenance ?? null,
      brain_change_reversible: it.brain_change_reversible ?? null,
    };
  }
  return {
    exercise: it.exercise,
    sets: it.sets ?? 3,
    rep_low: it.rep_low ?? null,
    rep_high: it.rep_high ?? null,
    target_weight: it.mode === "timed" ? null : (it.target_weight ?? null),
    target_seconds: it.mode === "timed" ? (it.target_seconds ?? null) : null,
    mode: it.mode ?? "reps",
    warmup_sets: it.warmup_sets ?? null,
    note: it.note ?? null,
    brain_decision_id: it.brain_decision_id ?? null,
    brain_change_summary: it.brain_change_summary ?? null,
    brain_change_reason: it.brain_change_reason ?? null,
    brain_change_reason_provenance: it.brain_change_reason_provenance ?? null,
    brain_change_reversible: it.brain_change_reversible ?? null,
  };
}

// The deterministic session used when the agent is absent, times out, or returns
// nothing usable (docs §5: agent absence never blocks a usable session). Built
// from the envelope's own template day (exclusions applied) so it always honors
// the same safety bounds. Falls back to a short easy-movement session when there
// is no plan day (custom/rest intent). Returned as a RAW payload so it flows back
// through `normalizeComposedSession` and shares the agent path's exact shape.
export function deterministicSessionRawFromEnvelope(envelope: DailyDecisionEnvelope): Record<string, unknown> {
  const excluded = new Set(envelope.muscles.excluded.map((g) => g.toLowerCase()));
  const equipmentCapability = parseEquipmentCapability(envelope.request.equipment);
  const items: Array<Record<string, unknown>> = [];
  if (envelope.template.day_number != null && envelope.kind !== "rest") {
    const baseDay = getPlanDay(envelope.template.day_number) as any;
    // Recovery adaptation is centralized in normalizeComposedSession after the
    // progression target is applied, so it has the final safety precedence for
    // both deterministic and agent-authored compositions.
    const day = baseDay;
    const candidates = new Map(envelope.candidates.map((candidate) => [candidate.exercise.toLowerCase(), candidate]));
    const substitutions = new Map(
      envelope.candidates
        .filter((candidate) => candidate.substitution_for)
        .map((candidate) => [String(candidate.substitution_for).toLowerCase(), candidate])
    );
    for (const it of Array.isArray(day?.items) ? day.items : []) {
      const group = String(it?.muscle_group ?? "").toLowerCase();
      if (group && excluded.has(group)) continue;
      const itemExercise =
        it?.kind === "cardio" ? cardioPlanIdentity(it).movement_label : String(it?.exercise ?? "");
      const direct = candidates.get(itemExercise.toLowerCase());
      if (direct?.action === "exclude") continue;
      if (equipmentCapability.recognized && equipmentCapability.restricted) {
        const stored = findExercise(String(it?.exercise ?? ""));
        if (
          equipmentCompatibility(
            equipmentCapability,
            inferExerciseEquipment(it?.exercise, stored?.equipment)
          ) !== "compatible"
        )
          continue;
      }
      const substitution = substitutions.get(String(it?.exercise ?? "").toLowerCase());
      if (substitution) {
        const stored = findExercise(substitution.exercise);
        if (
          equipmentCapability.recognized &&
          equipmentCapability.restricted &&
          equipmentCompatibility(
            equipmentCapability,
            inferExerciseEquipment(substitution.exercise, stored?.equipment)
          ) !== "compatible"
        )
          continue;
        const raw = planItemToRaw({
          ...it,
          exercise: substitution.exercise,
          mode: stored?.mode ?? it?.mode,
        });
        // A substitution never inherits the replaced movement's target. Reuse a
        // real working anchor only when this exact exercise has one; otherwise
        // establish the baseline without fabricated load/seconds.
        if (stored?.mode === "timed") {
          raw.target_weight = null;
          raw.target_seconds = recentWorkingSeconds(substitution.exercise);
        } else {
          raw.target_weight = recentWorkingWeight(substitution.exercise);
          raw.target_seconds = null;
        }
        if (raw.target_weight == null && raw.target_seconds == null) {
          raw.note = baselineNote(substitution.note);
        }
        items.push(raw);
      } else {
        const raw = planItemToRaw(it);
        applyAuthorizedTarget(raw, direct);
        Object.assign(raw, trustedCandidateMetadata(direct));
        items.push(raw);
      }
    }
  }
  if (!items.length && !(envelope.kind === "rest" && envelope.request.train_anyway !== true)) {
    // Custom intent, or every template item was excluded: a calm, safe, low-load
    // default that always survives normalization. A true rest decision stays
    // itemless; only the explicit train-anyway decision may produce a workout.
    items.push({
      kind: "cardio",
      exercise: "Easy movement",
      target_duration_min: Math.min(envelope.caps.duration_min ?? 25, 25),
      target_zone: "easy",
      note: "Deterministic fallback — keep it light",
    });
  }
  const why = envelope.rationale[0]?.text ?? "Today's deterministic session.";
  const name =
    envelope.kind === "rest"
      ? "Easy recovery"
      : envelope.template.focus
        ? String(envelope.template.focus)
        : "Today's session";
  return {
    name,
    focus: envelope.kind === "rest" ? "Recovery" : envelope.template.focus,
    why,
    est_minutes: envelope.caps.duration_min,
    items,
  };
}

export function deterministicComposedSession(envelope: DailyDecisionEnvelope): ComposedSession {
  if (envelope.kind === "rest" && envelope.request.train_anyway !== true) {
    return {
      name: "Rest day",
      focus: "Recovery",
      // A rest day the WEEK programmed explains itself differently from one a signal
      // earned: the first is structure the athlete built, and the card should sound
      // like their own plan rather than like a brake. The rationale still leads on
      // every other rest morning.
      why:
        envelope.template.day_type === "rest"
          ? pickDayVariant(TEMPLATE_REST_DAY_NOTE, envelope.date, "daily_composition:template_rest")
          : (envelope.rationale[0]?.text ?? "Today is for recovery."),
      est_minutes: null,
      items: [],
    };
  }
  const raw = deterministicSessionRawFromEnvelope(envelope);
  const { session } = normalizeComposedSession(raw, envelope);
  // The raw payload is built from safe template/plan items, so it always
  // normalizes; this null-guard is defensive only.
  return (
    session ?? {
      name: "Easy movement",
      focus: envelope.template.focus,
      why: "Deterministic fallback session.",
      est_minutes: envelope.caps.duration_min ?? 25,
      items: [],
    }
  );
}

// The programmed rest day's own card. Never a brake and never a gate — the athlete
// wrote this day into their week, so it offers what a rest day is actually for. Its
// own set, several phrasings, because it lands on the same weekday every week and one
// literal would print verbatim for as long as the template stands.
export const TEMPLATE_REST_DAY_NOTE: readonly string[] = [
  "Your week has a rest day here. An easy walk or a few minutes of mobility is plenty, and doing nothing counts too.",
  "This is the rest day in your plan. Move gently if you feel like it — a walk, some stretching — or leave it alone.",
  "The week keeps today clear. Easy mobility or a walk fits it well; nothing at all fits it just as well.",
  "Today is yours. Your plan puts a rest day here, so a gentle walk is the whole ask, and even that is optional.",
  "Rest is what the week programmed for today. Some easy movement is welcome; a real day off is too.",
];

// Keep the wire marker a literal here: adaptive-session imports this module to
// build envelope-backed plan snapshots, so eagerly reading its exported constant
// would create an ESM initialization cycle. The normalizer function is only
// invoked after both modules finish evaluating.
export const DAILY_COMPOSITION_NORMALIZATION = "daily_session_v1";
