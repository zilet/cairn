// A PERSON's plan save — the editor's PUT /plan[/:day] and the set_plan / save_plan_day
// tools. What makes it different from the brain's own writes (applyProposal, Undo) is
// ownership: once the athlete writes a prescription, it is theirs.
//
// So a person's save does two things beyond the write itself:
//   1. it releases the brain's claim on every item whose prescription it changed
//      (plan-annotation-release.ts) — no stale "resetting to 192.5 lb" under a lift the
//      athlete just set to 185, and no Undo that would walk their value back; and
//   2. it re-takes today's unstarted plan-sourced session from the saved plan
//      (refreshPreparedDayForPlanChange), so Today never serves the prescription the
//      athlete just replaced. A session with logged work, or one the athlete composed
//      themselves (athlete_override / agent_suggest), is never touched.
import { recordAsyncFailure } from "../../diagnostics.js";
import { activeCompositionPlanDayNumber, refreshPreparedDayForPlanChange } from "../../repo/adaptive-session.js";
import {
  type PlanPrescription,
  getPlan,
  getPlanDay,
  planPrescriptionSnapshot,
  replacePlanChecked,
  savePlanDayChecked,
} from "../../repo/plan.js";
import { releasePlanAnnotationsForPersonSave } from "../../repo/plan-annotation-release.js";
import { localDateISO } from "../../repo/shared.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";

type SavePlanDayOpts = Parameters<typeof savePlanDayChecked>[4];
type ReplacePlanOpts = Parameters<typeof replacePlanChecked>[1];

function samePrescription(a: PlanPrescription, b: PlanPrescription): boolean {
  return (
    a.sets === b.sets &&
    a.rep_low === b.rep_low &&
    a.rep_high === b.rep_high &&
    a.target_weight === b.target_weight &&
    a.target_seconds === b.target_seconds
  );
}

// The `day|exercise` keys whose prescription the save changed — rewritten, added or
// removed. An item saved back exactly as it stood is not taken over: the brain's note on
// it is still the truth about that prescription. Keys on a removed or renumbered day fall
// out of `after` and so count as changed on their own.
function changedPrescriptionKeys(
  before: Map<string, PlanPrescription>,
  after: Map<string, PlanPrescription>
): string[] {
  const keys = new Set<string>();
  for (const map of [before, after]) {
    for (const key of map.keys()) {
      const prior = before.get(key);
      const next = after.get(key);
      if (!prior || !next || !samePrescription(prior, next)) keys.add(key);
    }
  }
  return [...keys];
}

// What a day's session is built from, per plan day: the items in order, each with every
// field a composition reads. Name and focus are left out on purpose — a renamed day
// hands the athlete the same work.
function dayItemSignatures(): Map<number, string> {
  const map = new Map<number, string>();
  for (const day of getPlan() as any[]) {
    map.set(
      Number(day.day_number),
      JSON.stringify(
        (day.items ?? []).map((item: any) => [
          item.exercise,
          item.sets,
          item.rep_low,
          item.rep_high,
          item.target_weight,
          item.target_seconds,
          item.warmup_sets,
          item.note,
          item.superset_group,
        ])
      )
    );
  }
  return map;
}

function changedItemDays(before: Map<number, string>, after: Map<number, string>): number[] {
  const days = new Set<number>();
  for (const day of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(day) !== after.get(day)) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

// Re-take today's session only for a day whose items the save actually changed: a
// re-take clears the session's skips and re-runs the adaptive decision, so a rename or
// an untouched day must never trigger one. When the save REMOVED the day today's
// snapshot came from, the unstarted snapshot is retired instead.
function refreshToday(changedDays: number[], todayDayBefore: number | null, date: string): void {
  if (!changedDays.length) return;
  try {
    const dayGone = todayDayBefore != null && getPlanDay(todayDayBefore) == null;
    refreshPreparedDayForPlanChange({ date, day_numbers: changedDays, retire_when_day_gone: dayGone });
  } catch (err) {
    // The plan save already committed; a session that cannot be re-taken keeps its
    // snapshot, exactly as before this path existed.
    recordAsyncFailure("plan_save", "refresh_prepared_day", err);
  }
}

export function savePlanDayByPerson(
  day_number: number,
  name: string,
  focus: string | null,
  items: Parameters<typeof savePlanDayChecked>[3],
  opts: SavePlanDayOpts & { date?: string } = {}
) {
  const { date = localDateISO(), ...checkedOpts } = opts;
  const todayDayBefore = activeCompositionPlanDayNumber(date);
  const { result, changed } = withSqliteSavepoint("person_plan_day_save", () => {
    const before = planPrescriptionSnapshot();
    const itemsBefore = dayItemSignatures();
    // `by: "person"`: the athlete's own set count is a new prescription for them
    // (prescription-authorship.ts), so the catch-up never walks their cut back.
    const saved = savePlanDayChecked(day_number, name, focus, items, { ...checkedOpts, by: "person" });
    releasePlanAnnotationsForPersonSave(changedPrescriptionKeys(before, planPrescriptionSnapshot()));
    return { result: saved, changed: changedItemDays(itemsBefore, dayItemSignatures()) };
  });
  refreshToday(changed, todayDayBefore, date);
  // Re-read: the day handed back must not carry the annotations just released.
  return { ...result, day: getPlanDay(day_number) };
}

export function replacePlanByPerson(
  days: Parameters<typeof replacePlanChecked>[0],
  opts: ReplacePlanOpts & { date?: string } = {}
) {
  const { date = localDateISO(), ...checkedOpts } = opts;
  const todayDayBefore = activeCompositionPlanDayNumber(date);
  const { result, changed } = withSqliteSavepoint("person_plan_replace", () => {
    const before = planPrescriptionSnapshot();
    const itemsBefore = dayItemSignatures();
    const saved = replacePlanChecked(days, { ...checkedOpts, by: "person" });
    // The editor saves the whole week at once, so only what moved is the athlete's —
    // an untouched lift keeps its note and its Undo.
    releasePlanAnnotationsForPersonSave(changedPrescriptionKeys(before, planPrescriptionSnapshot()), {
      retireUndoWhenFullyReleased: true,
    });
    return { result: saved, changed: changedItemDays(itemsBefore, dayItemSignatures()) };
  });
  refreshToday(changed, todayDayBefore, date);
  return { ...result, plan: getPlan() };
}
