// @ts-check
// "Today's remaining fuel" context, threaded into the meal-swap panel, the
// recipe sheet, and the "+ Log it" toast — the same DAYFUEL numbers the
// Plan -> Meals fuel card already shows (day-fuel-client.ts), just quieter.
// An absent/unlogged day (or an incomplete profile with no derivable target)
// renders NOTHING — never a claim like "behind".

let _mealFuelCache: { at: number; remaining: number | null } | null = null;

async function remainingFuelKcal(): Promise<number | null> {
  if (_mealFuelCache && Date.now() - _mealFuelCache.at < 4000) return _mealFuelCache.remaining;
  let remaining: number | null = null;
  try {
    const day: any = await api("/nutrition/day");
    const known = day?.known?.kcal !== false;
    const rk = Number(day?.remaining?.kcal);
    remaining = known && Number.isFinite(rk) ? Math.round(rk) : null;
  } catch {
    remaining = null;
  }
  _mealFuelCache = { at: Date.now(), remaining };
  return remaining;
}

// itemKcal omitted (or not a positive number) -> plain context line, no
// fit/exceeds claim (used by the swap panel, which has no candidate yet).
function mealFuelFitLine(itemKcal: unknown, remaining: number | null): string {
  if (remaining == null) return "";
  const ik = Number(itemKcal);
  if (!Number.isFinite(ik) || ik <= 0) return `today's remaining ~${remaining} kcal`;
  return ik <= remaining ? `fits today's remaining ~${remaining} kcal` : `runs past today's remaining ~${remaining} kcal`;
}

// Fills a `[data-fuel-line]` slot inside `scope` once the remaining-kcal read
// resolves. Safe to call speculatively (e.g. right after a panel/sheet opens)
// — it no-ops if the slot has since left the document.
async function loadMealFuelLine(scope: ParentNode | null | undefined, itemKcal?: unknown): Promise<void> {
  const slot = typeof scope?.querySelector === "function" ? scope.querySelector<HTMLElement>("[data-fuel-line]") : null;
  if (!slot) return;
  const remaining = await remainingFuelKcal();
  if (!slot.isConnected) return;
  const line = mealFuelFitLine(itemKcal, remaining);
  slot.hidden = !line;
  slot.textContent = line;
}

const CAIRN_MEAL_FUEL_CONTEXT = {
  remainingFuelKcal,
  mealFuelFitLine,
  loadMealFuelLine,
};

Object.assign(globalThis, { CairnMealFuelContext: CAIRN_MEAL_FUEL_CONTEXT });
if (typeof window !== "undefined") {
  Object.assign(window, { CairnMealFuelContext: CAIRN_MEAL_FUEL_CONTEXT });
}
