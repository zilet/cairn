// @ts-check
// The coming-next week on a meal plan: when it takes over, and how the targets
// move. meal-plan-client paints the week; this only shapes that block. Loaded
// after meal-row-client and before meal-plan-client (lazy meals bundle).

const mealRecord: (value: unknown) => MealRecord = CairnMealRows.record;

function scheduledMealPlan(plan: unknown): MealRecord | null {
  const p = mealRecord(plan);
  const autonomy = mealRecord(p.autonomy);
  return p.status === "draft" && (autonomy.status === "announced" || autonomy.status === "pending") ? autonomy : null;
}

function mealBoundaryLabel(value: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return "at the next food-day boundary";
  return CairnFmt.date(String(value), { fmt: { weekday: "long", month: "short", day: "numeric" } });
}

function mealTargetValue(value: unknown): number | null {
  const target = Number(value);
  return Number.isFinite(target) && target > 0 ? Math.round(target) : null;
}

function mealTargetSummary(plan: unknown): string {
  const parsed = mealRecord(mealRecord(plan).parsed);
  const kcal = mealTargetValue(parsed.daily_kcal);
  const protein = mealTargetValue(parsed.daily_protein_g);
  return [kcal == null ? "" : `${kcal.toLocaleString()} kcal`, protein == null ? "" : `${protein} g protein`]
    .filter(Boolean)
    .join(" · ");
}

function mealTargetDifference(plan: unknown, current: unknown): string {
  const nextParsed = mealRecord(mealRecord(plan).parsed);
  const currentParsed = mealRecord(mealRecord(current).parsed);
  const nextKcal = mealTargetValue(nextParsed.daily_kcal);
  const currentKcal = mealTargetValue(currentParsed.daily_kcal);
  const nextProtein = mealTargetValue(nextParsed.daily_protein_g);
  const currentProtein = mealTargetValue(currentParsed.daily_protein_g);
  const differences: string[] = [];
  if (nextKcal != null && currentKcal != null && nextKcal !== currentKcal) {
    differences.push(
      `${Math.abs(nextKcal - currentKcal).toLocaleString()} kcal ${nextKcal > currentKcal ? "more" : "less"}`
    );
  }
  if (nextProtein != null && currentProtein != null) {
    if (nextProtein === currentProtein) differences.push(`protein stays at ${nextProtein} g`);
    else
      differences.push(
        `${Math.abs(nextProtein - currentProtein)} g protein ${nextProtein > currentProtein ? "more" : "less"}`
      );
  }
  return differences.join(" · ");
}

function mealPlanUpcomingHtml(plan: unknown, current?: unknown): string {
  const p = mealRecord(plan);
  const autonomy = scheduledMealPlan(p);
  if (!autonomy) return "";
  const target = mealTargetSummary(p);
  const difference = mealTargetDifference(p, current);
  const detail = String(
    autonomy.summary || mealRecord(p.parsed).summary || "Your next week is ready around the latest picture."
  );
  return `<div class="plan-upcoming reveal" style="${stagger(0)}">
      <span class="lbl plan-upcoming-mast">COMING NEXT</span>
      <p class="plan-upcoming-line"><span class="plan-upcoming-when">${escHtml(mealBoundaryLabel(autonomy.effective_date))}</span> — your meals refresh automatically.</p>
      ${target ? `<p class="sess-line mp-flush">${escHtml(target)}</p>` : ""}
      ${difference ? `<p class="sess-line mp-flush mp-muted">${escHtml(difference)}</p>` : ""}
      <div class="logrow mp-upcoming-row">
        <details class="hist-fold mp-upcoming-fold">
          <summary>Preview changes</summary>
          <p class="sess-line mp-muted mp-fold-body">${escHtml(detail)}</p>
        </details>
        ${CairnDecisionUndo.buttonHtml({ id: autonomy.id, label: "Hold", attr: "meal-decision-hold" })}
      </div>
    </div>`;
}

const CAIRN_MEAL_PLAN_UPCOMING = {
  scheduledMealPlan,
  mealBoundaryLabel,
  mealPlanUpcomingHtml,
};

Object.assign(globalThis, {
  CairnMealPlanUpcoming: CAIRN_MEAL_PLAN_UPCOMING,
  scheduledMealPlan,
  mealBoundaryLabel,
  mealPlanUpcomingHtml,
});
