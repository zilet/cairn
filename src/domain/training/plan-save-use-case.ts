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
//
// And every person write here — a save, a deleted day, an in-session swap — runs inside
// withPersonAuthoredCoverage (plan-coverage.ts), WITHOUT ever editing the plan back: a
// coverage gap the write itself made or deepened (they took chest sets out) is the
// person's own choice — recorded as such, left alone, and marked declined for the
// plan-shaping prompts — and an open coverage draft the write closed is withdrawn
// (coverage-change.ts). Any other gap is the daily pass's to close. A failed coverage
// read only skips it; the write is untouched.
import { recordAsyncFailure } from "../../diagnostics.js";
import { type CoverageChangeOutcome, settlePlanCoverageAfterSave } from "../brain/coverage-change.js";
import { withPersonAuthoredCoverage } from "../../repo/plan-coverage.js";
import { applySwapSmart } from "../../repo/plan-swap.js";
import { activeCompositionPlanDayNumber, refreshPreparedDayForPlanChange } from "../../repo/adaptive-session.js";
import {
  type PlanPrescription,
  deletePlanDay,
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


// The coverage settle rides AFTER the write commits (the write itself ran inside
// withPersonAuthoredCoverage, which recorded any gap it made as the person's own) and
// can never undo or fail it.
function coverageAfterSave(date: string, keptByPerson: string[]): CoverageChangeOutcome | null {
  try {
    return settlePlanCoverageAfterSave({ date, kept_by_person: keptByPerson });
  } catch (err) {
    recordAsyncFailure("plan_save", "coverage_settle", err);
    return null;
  }
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
  const { result: written, kept_by_person } = withPersonAuthoredCoverage(
    () =>
      withSqliteSavepoint("person_plan_day_save", () => {
        const before = planPrescriptionSnapshot();
        const itemsBefore = dayItemSignatures();
        // `by: "person"`: the athlete's own set count is a new prescription for them
        // (prescription-authorship.ts), so the catch-up never walks their cut back.
        const saved = savePlanDayChecked(day_number, name, focus, items, { ...checkedOpts, by: "person" });
        releasePlanAnnotationsForPersonSave(changedPrescriptionKeys(before, planPrescriptionSnapshot()));
        return { result: saved, changed: changedItemDays(itemsBefore, dayItemSignatures()) };
      }),
    date
  );
  refreshToday(written.changed, todayDayBefore, date);
  const coverage = coverageAfterSave(date, kept_by_person);
  // Re-read: the day handed back must not carry the annotations just released.
  return { ...written.result, day: getPlanDay(day_number), coverage };
}

export function replacePlanByPerson(
  days: Parameters<typeof replacePlanChecked>[0],
  opts: ReplacePlanOpts & { date?: string } = {}
) {
  const { date = localDateISO(), ...checkedOpts } = opts;
  const todayDayBefore = activeCompositionPlanDayNumber(date);
  const { result: written, kept_by_person } = withPersonAuthoredCoverage(
    () =>
      withSqliteSavepoint("person_plan_replace", () => {
        const before = planPrescriptionSnapshot();
        const itemsBefore = dayItemSignatures();
        const saved = replacePlanChecked(days, { ...checkedOpts, by: "person" });
        // The editor saves the whole week at once, so only what moved is the athlete's —
        // an untouched lift keeps its note and its Undo.
        releasePlanAnnotationsForPersonSave(changedPrescriptionKeys(before, planPrescriptionSnapshot()), {
          retireUndoWhenFullyReleased: true,
        });
        return { result: saved, changed: changedItemDays(itemsBefore, dayItemSignatures()) };
      }),
    date
  );
  refreshToday(written.changed, todayDayBefore, date);
  const coverage = coverageAfterSave(date, kept_by_person);
  return { ...written.result, plan: getPlan(), coverage };
}

// A person deleting a whole plan day (DELETE /plan/:day, MCP delete_plan_day): a gap it
// leaves is theirs, exactly as a save's is.
export function deletePlanDayByPerson(day_number: number, opts: { date?: string } = {}) {
  const date = opts.date ?? localDateISO();
  const { result, kept_by_person } = withPersonAuthoredCoverage(() => deletePlanDay(day_number), date);
  return { ...result, coverage: coverageAfterSave(date, kept_by_person) };
}

// A person's in-session swap (POST /program/swap/apply, MCP swap_exercise_now): their
// direct edit of a named slot, so a gap it leaves is theirs too.
export function applySwapByPerson(from: string, to: string, day: number | null, opts: { date?: string } = {}) {
  const date = opts.date ?? localDateISO();
  const { result, kept_by_person } = withPersonAuthoredCoverage(() => applySwapSmart(from, to, day), date);
  return result.ok ? { ...result, coverage: coverageAfterSave(date, kept_by_person) } : result;
}
