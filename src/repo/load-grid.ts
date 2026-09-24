// The load grid — what a bar, a pair of dumbbells or a pinned stack can actually be set
// to — and the ONE easing every "take this lift down by a factor" path goes through.
//
// Every eased load used to be its own arithmetic (`× 0.9` to the hundredth in
// composition, `× 0.85` / `× 0.9` to the half-pound in the recovery overlay, the fuel
// recovery dose and the recovery-week proposal), so a card printed 166.5 or 191.5 — a
// number no bar loads. A leaf module on purpose: it reads only exercise-canon, so
// progression, lift-response, composition, the recovery overlay and the brain services
// all import it without a cycle.
import {
  canonicalGroup,
  classifyMuscleGroup,
  detectImplement,
  expandExerciseAbbreviations,
  ISOLATION_GROUPS,
} from "./exercise-canon.js";

/** The compound plate floor: the engine's overload step is never smaller than 5 lb. */
export const STEP_CEIL_COMPOUND = 5;
/** The isolation plate floor: never smaller than 2.5 lb. */
export const STEP_CEIL_ISOLATION = 2.5;
/** The smallest real jump on a pinned weight stack (cable or selectorized machine). */
export const STACK_MIN_STEP = 5;
/** How far under the intended ease the grid may round before it reads as a cut (0.9 → ≥ ~0.85). */
export const EASED_LOAD_SLACK = 0.05;

// A name that says the load is a pinned stack even when no implement word is in it.
const STACK_NAME_RE =
  /\b(pushdowns?|push downs?|pec decks?|ropes?|stack|selectori[sz]ed|leg extensions?|leg curls?|hamstring curls?|face pulls?|abduct\w*|adduct\w*)\b/;
// Implements with their own (finer) loading grid: never a stack, whatever else the name says.
const FREE_OR_PLATE_IMPLEMENTS = new Set([
  "a barbell",
  "dumbbells",
  "a kettlebell",
  "an EZ bar",
  "a smith machine",
  "a trap bar",
  "a hex bar",
  "a landmine",
  "a band",
]);

function nameKey(name: string): string {
  return expandExerciseAbbreviations(String(name ?? "")).toLowerCase();
}

/** Isolation groups get the smaller (2.5 lb) plate jump; compounds get 5 lb. */
export function isIsolationGroup(group: string | null): boolean {
  const g = canonicalGroup(group);
  return !!g && ISOLATION_GROUPS.has(g);
}

/**
 * The smallest real load jump the engine takes on a lift of this group — the plate-grid
 * floor its own overload step never goes under.
 */
export function minimumLoadStep(group: string | null): number {
  return isIsolationGroup(group) ? STEP_CEIL_ISOLATION : STEP_CEIL_COMPOUND;
}

/**
 * A pinned weight stack: the name carries a cable or machine implement, or a stack
 * movement word (pushdown, pec deck, leg extension…), and no free-weight or plate
 * implement. Its real jump is at least STACK_MIN_STEP whatever the plate grid says.
 */
export function isStackLoaded(name: string): boolean {
  const implement = detectImplement(String(name ?? ""));
  if (implement && FREE_OR_PLATE_IMPLEMENTS.has(implement)) return false;
  if (implement === "a cable machine" || implement === "a machine") return true;
  return STACK_NAME_RE.test(nameKey(name));
}

/**
 * The lift's own load increment: the engine's minimum plate jump for its group
 * (5 lb compound, 2.5 lb isolation), never under STACK_MIN_STEP on a pinned stack.
 * Dumbbells and barbells keep the engine grid for their group. With no group known, the
 * name's own classification answers.
 */
export function loadIncrement(name: string, group: string | null | undefined): number {
  const g = canonicalGroup(group ?? null) ?? classifyMuscleGroup(String(name ?? ""));
  const grid = minimumLoadStep(g);
  return isStackLoaded(name) ? Math.max(grid, STACK_MIN_STEP) : grid;
}

export interface EasedLoadOptions {
  // How much MORE assistance an eased assisted lift takes (1.1 = 10% more). Omitted, an
  // assisted (negative) load is returned unchanged — easing never makes it harder.
  assistFactor?: number;
}

/**
 * An eased load the lift can actually be set to. Pure.
 *
 * Positive load: `factor` × load rounded DOWN onto `loadIncrement`, so a 185 lb squat
 * eases to 165, never 166.5. When a coarse step at a light load would round further than
 * EASED_LOAD_SLACK under the intended ease, the nearest step below the prescription
 * stands in; when no step lands under it at all, the prescription holds (whatever else
 * the path trims carries the easing).
 *
 * Assisted (negative) load: less assist is harder, so it is never multiplied toward zero.
 * With `assistFactor`, the assist grows and rounds UP onto the same grid (more help,
 * easier), under the same slack rule mirrored. null / 0 / non-numeric pass through.
 */
export function easedLoad(
  value: unknown,
  factor: number,
  name: unknown,
  group: string | null | undefined,
  opts: EasedLoadOptions = {}
): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return n;
  const step = loadIncrement(String(name ?? ""), group);
  if (n < 0) {
    const assistFactor = opts.assistFactor;
    if (assistFactor == null || !(assistFactor > 1)) return n;
    const assist = -n;
    const more = assist * assistFactor;
    const up = Math.ceil(more / step - 1e-9) * step;
    if (up > assist && up <= assist * (assistFactor + EASED_LOAD_SLACK) + 1e-9) return -up;
    const nearest = Math.round(more / step) * step;
    return nearest > assist ? -nearest : n;
  }
  if (!(factor > 0 && factor < 1)) return n;
  const eased = n * factor;
  const down = Math.floor(eased / step + 1e-9) * step;
  if (down > 0 && down < n && down >= n * (factor - EASED_LOAD_SLACK) - 1e-9) return down;
  const nearest = Math.round(eased / step) * step;
  return nearest > 0 && nearest < n ? nearest : n;
}
