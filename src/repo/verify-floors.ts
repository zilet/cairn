// The deterministic half of the self-critique verify pass.
//
// The verify turn used to ask a MODEL to do arithmetic the server already holds:
// "is any day below the lean-safe floor", "is protein at target", "is fiber 30g+",
// "does est_minutes fit the time budget". Every input to those questions is a
// number Cairn computed, so the answer was fully determined before the prompt was
// built — an LLM call whose output its own inputs decide. That is now computed
// here, and the model is handed the FINDINGS instead of the arithmetic.
//
// What stays with the model (genuine judgement, not arithmetic):
//   - injury-area contraindication — "is this movement loaded through the area
//     the athlete hurt", which needs reading a free-text injury note against an
//     exercise's mechanics;
//   - dietary/allergy/preference and meal-timing fit against the athlete's own
//     words;
//   - mechanics-encoding integrity in a REPAIR it authors (a fix must not corrupt
//     the assist-sign / timed-mode encoding on its way through).
//
// Everything here is pure per function pair: a `…Violations` function takes the
// numbers explicitly and is unit-testable with no database, and a `…Precheck`
// wrapper resolves those numbers from the repo's existing single sources of truth
// (`mealPlanFloorReference` / `nutritionFloorsFor` / `mealPlanDayTotals`). No
// floor is re-derived here — a second derivation is exactly how the prompt's
// numbers and the server's own answer drift apart.
import { listActiveDirectives } from "./directives-read.js";
import { findExercise } from "./exercises.js";
import { listContextEvents } from "./health.js";
import { athleteAllergies, athleteDietaryDeclarations, mealPlanFloorReference } from "./nutrition.js";
import {
  MEAL_PLAN_FIBER_FLOOR_G,
  MEAL_PLAN_FIBER_MIN_DAY_FRACTION,
  mealPlanDayTotals,
  nutritionFloorsFor,
} from "./nutrition-safety.js";

export interface FloorViolation {
  /** Stable machine code — the surface never renders it; tests and telemetry read it. */
  code: string;
  /** The field that breached, in the draft's own schema. */
  field: string;
  /** The named day it breached on, for a per-day check. Absent for a whole-draft one. */
  day?: string;
  /** What the draft says. Null when the draft carries no usable number at all. */
  observed: number | null;
  /** What the server requires. */
  floor: number;
  /** One athlete-readable line. This is what reaches the prompt and the badge. */
  message: string;
}

export interface FloorPrecheck {
  violations: FloorViolation[];
  /**
   * True when a check only a model can make still applies to this draft, so the
   * verify turn is worth its cost even with zero numeric violations. Resolved
   * conservatively: anything unreadable counts as APPLICABLE, because skipping a
   * judgement check on a failed lookup would quietly weaken the backstop.
   */
  judgment_applies: boolean;
  /** Why the judgement turn applies. Empty when it does not. */
  judgment_reasons: string[];
}

const clean = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- meal plan --

export interface MealPlanFloorRefs {
  /** max(universal 1500, the goal's lean-safe recommended intake). */
  kcalFloor: number;
  /** The recommended daily protein target, or null when the profile is too thin. */
  proteinFloor: number | null;
  /** The 30 g/day fiber floor, raised by the plan's own higher declared target. */
  fiberFloor: number;
}

/**
 * Every numeric floor a drafted week breaches, computed from the draft's own
 * per-day meal totals against explicitly supplied floors. Pure — no repo reads.
 *
 * Fiber is checked ONLY on a fiber-tracked week (every meal on every day carries
 * an estimate). A legacy week with no fiber data is unverified, not deficient:
 * missing data must never read as a measured zero.
 */
export function mealPlanFloorViolations(draft: any, refs: MealPlanFloorRefs): FloorViolation[] {
  const out: FloorViolation[] = [];
  if (!draft || typeof draft !== "object") return out;
  const days = mealPlanDayTotals(draft);

  const headlineKcal = num(draft.daily_kcal);
  if (headlineKcal != null && headlineKcal < refs.kcalFloor) {
    out.push({
      code: "meal_plan_kcal_below_floor",
      field: "daily_kcal",
      observed: Math.round(headlineKcal),
      floor: refs.kcalFloor,
      message: `The plan's headline target of ${Math.round(headlineKcal)} kcal/day is below the lean-safe floor of ${refs.kcalFloor} kcal.`,
    });
  }
  const headlineProtein = num(draft.daily_protein_g);
  if (refs.proteinFloor != null && headlineProtein != null && headlineProtein < refs.proteinFloor) {
    out.push({
      code: "meal_plan_protein_below_target",
      field: "daily_protein_g",
      observed: Math.round(headlineProtein),
      floor: refs.proteinFloor,
      message: `The plan's headline protein of ${Math.round(headlineProtein)} g/day is below the ${refs.proteinFloor} g target.`,
    });
  }

  for (const day of days) {
    if (day.kcal < refs.kcalFloor) {
      out.push({
        code: "meal_plan_day_kcal_below_floor",
        field: "days[].meals[].kcal",
        day: day.day,
        observed: day.kcal,
        floor: refs.kcalFloor,
        message: `${day.day} totals ${day.kcal} kcal, below the lean-safe floor of ${refs.kcalFloor} kcal.`,
      });
    }
    if (refs.proteinFloor != null && day.protein_g < refs.proteinFloor) {
      out.push({
        code: "meal_plan_day_protein_below_target",
        field: "days[].meals[].protein_g",
        day: day.day,
        observed: day.protein_g,
        floor: refs.proteinFloor,
        message: `${day.day} totals ${day.protein_g} g protein, below the ${refs.proteinFloor} g target.`,
      });
    }
  }

  // Fiber: a tracked week must average the floor with no day under the allowance.
  const fiberTracked = days.length > 0 && days.every((day) => day.fiber_g != null);
  if (fiberTracked) {
    const declared = num(draft.daily_fiber_g);
    const fiberFloor = Math.max(refs.fiberFloor, declared != null && declared > 0 ? Math.round(declared) : 0);
    const minimumDay = Math.round(fiberFloor * MEAL_PLAN_FIBER_MIN_DAY_FRACTION);
    const average = days.reduce((sum, day) => sum + Number(day.fiber_g), 0) / days.length;
    if (average < fiberFloor) {
      out.push({
        code: "meal_plan_fiber_below_floor",
        field: "days[].meals[].fiber_g",
        observed: Math.round(average * 10) / 10,
        floor: fiberFloor,
        message: `The week averages ${Math.round(average * 10) / 10} g fiber/day, below the ${fiberFloor} g/day floor.`,
      });
    }
    for (const day of days) {
      const fiber = Number(day.fiber_g);
      if (fiber < minimumDay) {
        out.push({
          code: "meal_plan_day_fiber_below_minimum",
          field: "days[].meals[].fiber_g",
          day: day.day,
          observed: fiber,
          floor: minimumDay,
          message: `${day.day} totals ${fiber} g fiber, below the ${minimumDay} g minimum day.`,
        });
      }
    }
  }
  return out;
}

/** The floors a drafted week is judged against, read from the live goal. */
export function mealPlanFloorRefs(): MealPlanFloorRefs {
  const { floorGoal } = mealPlanFloorReference();
  const { kcalFloor, proteinFloor } = nutritionFloorsFor(floorGoal);
  return { kcalFloor, proteinFloor, fiberFloor: MEAL_PLAN_FIBER_FLOOR_G };
}

/**
 * Does a drafted week still need a judgement turn? Only when the athlete has
 * declared something a model must read in their own words: an ALLERGY, a dietary
 * restriction, a hard diet, a meal-timing preference, a current-turn dietary
 * instruction, an active health context event, or an active health directive.
 * With none of those on file the verify prompt's remaining checks are all
 * arithmetic, which is done above.
 *
 * `profile.allergies` is its OWN column and is NOT part of
 * `athleteDietaryDeclarations` (which reads dietary_restrictions + meal_prefs), so
 * it has to be asked for separately — an athlete whose only declaration is a
 * peanut allergy must never satisfy "nothing to judge".
 */
function mealPlanJudgmentReasons(draft: any, dietaryInstruction?: unknown): string[] {
  const reasons: string[] = [];
  try {
    const declared = athleteDietaryDeclarations(dietaryInstruction, draft);
    if (clean(declared.restrictions)) reasons.push("dietary restrictions on file");
    if (clean(declared.mealPrefs)) reasons.push("stated meal-timing or meal preferences");
    if (clean(declared.instruction)) reasons.push("a dietary instruction on this request");
    if (Array.isArray(declared.hardDietKeys) && declared.hardDietKeys.length)
      reasons.push("a hard diet declared on the plan");
  } catch {
    // Unreadable declarations are not evidence of absence — keep the judgement turn.
    reasons.push("dietary declarations could not be read");
  }
  try {
    if (clean(athleteAllergies())) reasons.push("food allergies on file");
  } catch {
    reasons.push("allergies could not be read");
  }
  try {
    if ((listContextEvents({ activeOnly: true }) as any[]).length) reasons.push("active health context events");
  } catch {
    reasons.push("health context could not be read");
  }
  try {
    if (listActiveDirectives().length) reasons.push("active health directives");
  } catch {
    reasons.push("health directives could not be read");
  }
  return [...new Set(reasons)];
}

export function mealPlanFloorPrecheck(draft: any, opts: { dietary_instruction?: unknown } = {}): FloorPrecheck {
  const violations = mealPlanFloorViolations(draft, mealPlanFloorRefs());
  const judgment_reasons = mealPlanJudgmentReasons(draft, opts.dietary_instruction);
  return { violations, judgment_applies: judgment_reasons.length > 0, judgment_reasons };
}

// ------------------------------------------------------------------ session --

/**
 * The session's one numeric floor: a requested time budget the draft must fit
 * inside. Pure. No budget requested means nothing to check — an unbounded session
 * is not over budget.
 */
export function sessionFloorViolations(draft: any, opts: { minutes?: number } = {}): FloorViolation[] {
  const budget = num(opts.minutes);
  const est = num(draft?.est_minutes);
  if (budget == null || budget <= 0 || est == null) return [];
  const ceiling = Math.round(budget);
  if (est <= ceiling) return [];
  return [
    {
      code: "session_over_time_budget",
      field: "est_minutes",
      observed: Math.round(est),
      floor: ceiling,
      message: `The session estimates ${Math.round(est)} minutes against a ${ceiling}-minute budget; trim accessories before compounds.`,
    },
  ];
}

/**
 * Does a suggested session still need a judgement turn? Only when there is
 * something to judge: an active injury the movements could load through, an
 * ACTIVE HEALTH DIRECTIVE (the prompt asks the model to read "context_events /
 * health directives", so a clinical directive with no matching injury event must
 * not skip the turn), an exercise carrying a constraint note, or a free-text
 * equipment/constraint limit the athlete typed. Encoding integrity is NOT a
 * reason on its own — the draft reaching here already VALIDATED through
 * `normalizeSessionSuggestionResult`, and whatever survives this pass is
 * re-normalized by the caller afterwards, so a mode or assist-sign slip cannot
 * reach a card either way. (The raw payload is what this function sees; the
 * normalized object was discarded at the acceptance gate.) It stays in the prompt
 * because a model-authored REPAIR can still corrupt the encoding on its way out.
 */
function sessionJudgmentReasons(
  draft: any,
  opts: { equipment?: string; constraints?: string; date?: string } = {}
): string[] {
  const reasons: string[] = [];
  if (clean(opts.equipment)) reasons.push("an equipment limit was requested");
  if (clean(opts.constraints)) reasons.push("the athlete stated a constraint");
  try {
    const active = (listContextEvents({ activeOnly: true, on: opts.date }) as any[]).filter(
      (event) => event?.kind === "injury"
    );
    if (active.length) reasons.push("an active injury is on file");
  } catch {
    reasons.push("injury context could not be read");
  }
  try {
    if (listActiveDirectives().length) reasons.push("active health directives");
  } catch {
    reasons.push("health directives could not be read");
  }
  try {
    const items = Array.isArray(draft?.items) ? draft.items : [];
    const constrained = items.some((item: any) => clean(findExercise(clean(item?.exercise))?.constraint_note));
    if (constrained) reasons.push("a suggested movement carries a constraint note");
  } catch {
    reasons.push("exercise constraint notes could not be read");
  }
  return [...new Set(reasons)];
}

export function sessionFloorPrecheck(
  draft: any,
  opts: { minutes?: number; equipment?: string; constraints?: string; date?: string } = {}
): FloorPrecheck {
  const violations = sessionFloorViolations(draft, opts);
  const judgment_reasons = sessionJudgmentReasons(draft, opts);
  return { violations, judgment_applies: judgment_reasons.length > 0, judgment_reasons };
}

/** The prompt's hand-over line for one violation set. Empty list → empty string. */
export function renderFloorViolations(violations: FloorViolation[]): string {
  return violations
    .map((v) => `- [${v.code}] ${v.message} (field: ${v.field}${v.day ? `, day: ${v.day}` : ""})`)
    .join("\n");
}
