// ============================================================================
// composition-set-quality.ts — the plateau ladder's EFFORT lever on today's card.
//
// The ladder (unit-plateau.ts `unitPlateauLadder`) names, per movement unit on the plan,
// the next lever for a plateau. Its third rung, `set_quality`, fires when the athlete's
// own logged RIR shows most working sets ending well short of failure: the lever is
// effort, not load and not more sets. Here that becomes ONE short plain-words note on the
// card item for the unit's plan lift — take the working sets closer to the limit, inside
// the rep range — and nothing else: never a load, a set count or a rep range.
//
// The note is held back (fail closed) when:
//   - the day's read is not a plain training day (`kind` easy/rest, or the day's intensity
//     cap is anything but normal: an eased, held or deload day is no day to push sets);
//   - the item is in a reduced area (the stress budget's trim, a recovering group), is a
//     stand-in, hosts a top set or a reach, or is prep/cardio;
//   - the lift is held for pain (an injury recheck, joint pain), or the athlete reported
//     joint pain today at all — and the ladder itself never rungs a lift with a pain
//     report, a pain band, an open injury or a dated plan adaptation (`liftProtectedOn`);
//   - another item already carries it: at most SET_QUALITY_NOTES_PER_SESSION a card.
//
// The ladder is taken as a PRE-COMPUTED input (`setQualityLiftsFromLadder`), never read
// from composition: it reads the capability read and the progression engine — a real
// cost on every Today open, and a call path that can reach back into today's card.
//
// Evidence: proximity to failure drives hypertrophy and strength adaptation for a given
// load and set count, and sets left far short of it (several reps in reserve) under-dose
// the stimulus; moving effort before volume or variation is the conservative order
// (moderate evidence; RIR self-ratings are themselves noisy, which is why the ladder only
// counts rated sets and needs several).
// ============================================================================
import { pickDayVariant } from "./brain/day-read-rules.js";
import type { DailyDecisionEnvelope } from "./daily-decision.js";
import { isMobility, isPrepMovement, normalizedExerciseKey } from "./exercise-canon.js";
import type { UnitPlateauLadder } from "./unit-plateau.js";

/** The plan lifts (exercise keys) whose unit's next plateau lever is effort. */
export type SetQualityLifts = ReadonlySet<string>;

/** At most this many items on one card carry the effort note. */
export const SET_QUALITY_NOTES_PER_SESSION = 1;

/** Plain words, no numbers, never a load or a set count; rotated by day and lift. */
export const SET_QUALITY_NOTES: readonly [string, ...string[]] = [
  "Take the working sets a little closer to your limit today, staying inside the rep range.",
  "Same weight and the same rep range, but finish each working set nearer the point where one more rep would be hard.",
  "Your sets have had plenty left in them lately: push each working set a bit closer to the last good rep, inside the rep range.",
  "No change to the weight or the sets: just end each working set closer to your limit, still inside the rep range.",
];

// A candidate held for pain never takes an effort cue.
const PAIN_REASON_CODES: ReadonlySet<string> = new Set(["injury_recheck", "joint_pain_reduce", "injury_exclusion"]);

/** The plan lifts the ladder points at its `set_quality` lever, as exercise keys. Empty when unavailable. */
export function setQualityLiftsFromLadder(ladder: UnitPlateauLadder | null | undefined): SetQualityLifts {
  const out = new Set<string>();
  if (!ladder?.available) return out;
  for (const unit of ladder.units ?? []) {
    if (unit?.lever !== "set_quality" || !unit.plan_lift?.exercise) continue;
    const key = normalizedExerciseKey(String(unit.plan_lift.exercise));
    if (key) out.add(key);
  }
  return out;
}

/**
 * Pick the ONE card item that carries the effort note, and its text, or null. Pure apart
 * from the day-variant pick: it never touches a load or a set count, and it does not
 * write the note itself (the caller folds it into the item's own note).
 */
export function setQualityNoteFor(
  items: readonly any[],
  ctx: {
    envelope: Pick<DailyDecisionEnvelope, "kind" | "caps" | "date" | "candidates"> & { reported_joint_pain?: unknown };
    lifts: SetQualityLifts | null | undefined;
    /** Lower-cased names of every item a reduced area clamped (the stress budget's trim included). */
    reducedExercises: ReadonlySet<string>;
  }
): { item: any; text: string } | null {
  const { envelope, lifts } = ctx;
  if (!lifts || !lifts.size) return null;
  if (envelope.kind !== "train" || envelope.caps?.intensity !== "normal") return null;
  if (envelope.reported_joint_pain) return null;
  const candidates = new Map(
    (envelope.candidates ?? []).map((candidate) => [String(candidate.exercise ?? "").toLowerCase(), candidate])
  );
  const topSetHosts = new Set(
    items.filter((item) => item?.top_set_of).map((item) => String(item.top_set_of ?? "").toLowerCase())
  );
  // The first eligible item in card order (compounds lead), and only that one
  // (SET_QUALITY_NOTES_PER_SESSION).
  for (const item of items) {
    if (!item || item.kind === "cardio" || item.top_set_of || item.reach || item.substitution_for) continue;
    const name = String(item.exercise ?? "");
    const lower = name.toLowerCase();
    if (!name || !lifts.has(normalizedExerciseKey(name))) continue;
    if (isMobility(item.muscle_group == null ? null : String(item.muscle_group)) || isPrepMovement(name)) continue;
    if (item.mode === "timed" || ctx.reducedExercises.has(lower) || topSetHosts.has(lower)) continue;
    const candidate = candidates.get(lower);
    if (candidate?.action === "deload" || candidate?.action === "exclude") continue;
    if (candidate?.reason_code && PAIN_REASON_CODES.has(String(candidate.reason_code))) continue;
    return {
      item,
      text: pickDayVariant(SET_QUALITY_NOTES, envelope.date, `daily-composition:set_quality:${normalizedExerciseKey(name)}`),
    };
  }
  return null;
}
