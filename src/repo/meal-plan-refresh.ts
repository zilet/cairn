// MEAL-PLAN REFRESH SHAPE — is this week's plan a rotation, or a change?
//
// The weekly refresh drafts a fresh week against the same whole-person context on
// a standing cadence. Almost every one of those drafts says the same thing the last
// one did — same calorie and protein targets, same shape of week — with different
// food in the slots. Routing that through the same "structural, announce it" lane as
// a genuine change of target is what left the plan waiting on a ritual it never
// needed, week after week: the refresh is the plan STAYING FRESH, not a surprise.
//
// So this module answers one question, deterministically and in the machine
// register: does the new draft change anything the athlete would want a heads-up
// about, or does it only rotate the meals? The answer feeds `routine` into the
// autonomy policy (src/brain/autonomy.ts) — it never decides a tier itself, because
// a tier is server policy and lives in one place.
//
// Conservative by construction: anything it cannot compare (no current plan, an
// unreadable payload, a missing target) is NOT bounded, so the fallback is always
// the louder lane.

import { getAppState } from "./app-state.js";
import { TODAY_LAST_SEEN_KEY } from "./since-last.js";

export interface MealRefreshShape {
  /** True only when the week's targets AND its structure are unchanged. */
  bounded: boolean;
  /** MACHINE register: what made it structural. Empty when bounded. */
  reasons: string[];
}

// What counts as "the same number" between two drafts. A plan's daily totals are
// assembled from rounded per-meal figures, so two weeks built to an identical
// target routinely land a few kcal apart; treating that as a target change would
// make every refresh structural and this module pointless.
const SAME_KCAL_TOLERANCE = 40;
const SAME_PROTEIN_TOLERANCE = 8;

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function days(parsed: any): any[] {
  return Array.isArray(parsed?.days) ? parsed.days : [];
}

/**
 * How different is the incoming draft from the plan currently in force?
 *
 * PURE — two parsed payloads in, a verdict out. No database, no clock.
 */
export function mealPlanRefreshShape(next: any, current: any): MealRefreshShape {
  const reasons: string[] = [];
  const nextDays = days(next);
  const currentDays = days(current);
  if (!nextDays.length || !currentDays.length) {
    // Nothing to compare against is not the same as nothing changing. A first plan,
    // or a plan whose predecessor cannot be read, is a structural event.
    return { bounded: false, reasons: ["no comparable plan is currently in force"] };
  }

  const nextKcal = num(next?.daily_kcal);
  const currentKcal = num(current?.daily_kcal);
  if (nextKcal == null || currentKcal == null) reasons.push("a daily calorie target could not be compared");
  else if (Math.abs(nextKcal - currentKcal) > SAME_KCAL_TOLERANCE) reasons.push("the daily calorie target moved");

  const nextProtein = num(next?.daily_protein_g);
  const currentProtein = num(current?.daily_protein_g);
  if (nextProtein != null && currentProtein != null && Math.abs(nextProtein - currentProtein) > SAME_PROTEIN_TOLERANCE)
    reasons.push("the daily protein target moved");

  if (nextDays.length !== currentDays.length) reasons.push("the week has a different number of days");
  else {
    for (let i = 0; i < nextDays.length; i++) {
      const a = Array.isArray(nextDays[i]?.meals) ? nextDays[i].meals.length : -1;
      const b = Array.isArray(currentDays[i]?.meals) ? currentDays[i].meals.length : -1;
      if (a !== b || a < 0) {
        reasons.push("the shape of the eating day changed");
        break;
      }
    }
  }

  return { bounded: reasons.length === 0, reasons };
}

/**
 * Has this draft ever been in front of the athlete?
 *
 * There is no per-plan view stamp to read, and inventing one would mean a schema
 * change for a question an existing stamp already answers well enough: Today's
 * last-seen stamp (`since-last.ts`) advances whenever the app is opened. A draft
 * created after the last open has never had a chance to be seen; one created
 * before it has.
 *
 * Fail-SAFE toward "seen": an unreadable stamp or created_at leaves the ordinary
 * superseding path in place rather than quietly rewriting a decision the athlete
 * may already be looking at.
 */
export function mealPlanDraftUnseen(plan: { created_at?: unknown } | null | undefined): boolean {
  const created = String(plan?.created_at ?? "").trim();
  if (!created) return false;
  let stamp: string | null = null;
  try {
    stamp = getAppState(TODAY_LAST_SEEN_KEY);
  } catch {
    return false;
  }
  // Never opened at all: nothing has been seen, including this.
  if (!stamp) return true;
  return String(stamp) < created;
}
