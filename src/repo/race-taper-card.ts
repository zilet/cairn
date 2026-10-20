// ---------- a taper / race-week day AHEAD, as its card will read ----------
// The race build trims the legs in its last two weeks through the stress budget
// (stress-budget.ts): taper week every lower group on the card goes lighter with fewer
// sets, race week the heavy leg lifts sit out. That trim is applied by daily composition
// on the MORNING of the day — and only there. So a read surface showing the week ahead
// (the plan day-detail: next Friday's Lower in taper week) printed the untrimmed
// prescription — Back Squat 155, Deadlift 210 at full sets — and an athlete or an agent
// reading it saw a taper that did not taper.
//
// This is the one bridge for those surfaces: the stress budget's own calendar decision
// (stressBudgetCalendarTrim) applied with composition's own clamp (stressReducedItemDose).
// No second gate, no second set of numbers, and the stored prescription is untouched —
// the trim is still a property of the day, never a plan write.
import { stressReducedItemDose } from "./daily-composition.js";
import { canonicalGroup, classifyMuscleGroup } from "./exercise-canon.js";
import { type StressBudgetCalendarCode, stressBudgetCalendarTrim } from "./stress-budget.js";
import { getTrainingIntent } from "./training-intent.js";

export interface RaceTrimmedSlot {
  code: StressBudgetCalendarCode;
  /** Race week: the lift sits out that day. */
  excluded: boolean;
  sets: number | null;
  target_weight: number | null;
  target_seconds: number | null;
  /** The card's own note for the trim (rotated as composition rotates it). */
  note: string | null;
}

function groupOf(item: any): string | null {
  const group = canonicalGroup(item?.muscle_group ?? null) ?? classifyMuscleGroup(String(item?.exercise ?? ""));
  return group ? String(group).toLowerCase() : null;
}

/**
 * The race-build trim of a plan day on `date`, per exercise (lower-cased name), with the
 * prescription the slot carries that day (`prescribed`, e.g. the progression engine's next
 * one) as the input. Null when the date is not a taper or race week of a dated race, or
 * nothing on the day is a leg lift.
 */
export function raceTrimForPlanDay(
  date: string,
  items: readonly any[],
  prescribed: (item: any) => { sets: unknown; target_weight: unknown; target_seconds: unknown }
): Map<string, RaceTrimmedSlot> | null {
  let role: any = "none";
  try {
    role = getTrainingIntent().endurance_role;
  } catch {
    return null;
  }
  const trim = stressBudgetCalendarTrim(date, items, role);
  if (!trim) return null;
  const reduced = new Set(trim.reduced.map((g) => g.toLowerCase()));
  const excluded = new Set(trim.excluded.map((g) => g.toLowerCase()));
  const out = new Map<string, RaceTrimmedSlot>();
  for (const item of items) {
    const name = String(item?.exercise ?? "").trim();
    const group = groupOf(item);
    if (!name || !group) continue;
    if (excluded.has(group)) {
      out.set(name.toLowerCase(), {
        code: trim.code,
        excluded: true,
        sets: 0,
        target_weight: null,
        target_seconds: null,
        note: trim.excluded_note,
      });
      continue;
    }
    if (!reduced.has(group)) continue;
    const rx = prescribed(item);
    const dose = stressReducedItemDose(
      {
        exercise: name,
        muscle_group: group,
        mode: item?.mode,
        sets: rx.sets,
        target_weight: rx.target_weight,
        target_seconds: rx.target_seconds,
        note: null,
      },
      date,
      trim.code
    );
    out.set(name.toLowerCase(), { code: trim.code, excluded: false, ...dose });
  }
  return out.size ? out : null;
}
