// The meal plan is visible to the brain + carries a freshness signal (Wave B / B5).
// getCoachContext exposes a bounded today/tomorrow meal slice; a drafted plan outrun
// by newer upstream data reads "worth re-drafting"; and food-preference memory reaches
// the swap/recipe prompts so a disliked food never gets reintroduced.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { buildMealSwapPrompt } from "../dist/prompt.js";

const ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const abbrOf = (iso) => ABBR[new Date(`${iso}T00:00:00Z`).getUTCDay()];

beforeEach(() => resetTables("meal_plans", "memory", "health_directives", "bodyweight_log", "profile", "health_documents"));

function seedPlan(extraParsed = {}) {
  const today = localDaysAgo(0);
  const tomorrow = localDaysAgo(-1);
  return repo.createMealPlan("stub", "", {
    daily_kcal: 2400,
    daily_protein_g: 180,
    days: [
      { day: abbrOf(today), note: "training day", meals: [{ name: "Salmon rice bowl", kcal: 600, protein_g: 45 }, { name: "Chicken salad", kcal: 500, protein_g: 40 }] },
      { day: abbrOf(tomorrow), meals: [{ name: "Steak & potatoes", kcal: 700, protein_g: 50 }] },
    ],
    ...extraParsed,
  });
}

test("mealPlanForCoach exposes today's + tomorrow's meals and the daily targets", () => {
  seedPlan();
  const mp = repo.mealPlanForCoach();
  assert.ok(mp, "a live plan is visible to the brain");
  assert.equal(mp.daily_kcal, 2400);
  assert.equal(mp.daily_protein_g, 180);
  assert.ok(mp.today, "today's meals are picked");
  assert.equal(mp.today.meals[0].name, "Salmon rice bowl");
  assert.equal(mp.today.meals.length, 2);
  assert.ok(mp.tomorrow, "tomorrow's meals are picked");
  assert.equal(mp.tomorrow.meals[0].name, "Steak & potatoes");

  // And it flows into the coach context.
  const ctx = repo.getCoachContext();
  assert.ok(ctx.meal_plan, "getCoachContext carries the meal_plan slice");
  assert.equal(ctx.meal_plan.today.meals[0].name, "Salmon rice bowl");
});

test("a plan outrun by newer upstream data reads stale (worth re-drafting)", () => {
  // Upstream at draft time is 10 days ago → the plan stamps that.
  repo.logWeight(180, localDaysAgo(10));
  const plan = seedPlan();
  assert.equal(repo.mealPlanFreshness(plan).stale, false, "fresh at draft time");

  // A newer weigh-in lands → the plan is now outrun.
  repo.logWeight(179, localDaysAgo(1));
  const f = repo.mealPlanFreshness(plan);
  assert.equal(f.stale, true, "a newer upstream source makes it stale");
  assert.match(f.reason, /re-draft/i);

  // listMealPlans annotates the live plan so the PWA can show the quiet chip.
  const listed = repo.listMealPlans().find((p) => p.id === plan.id);
  assert.equal(listed.stale, true);
});

test("food-preference memory reaches the swap prompt (a disliked food is honored)", () => {
  repo.addMemory("Hates salmon — never plan it", "preference", "test");
  const plan = seedPlan();
  const today = localDaysAgo(0);
  const prompt = buildMealSwapPrompt({ plan, day: abbrOf(today), mealIndex: 0 });
  assert.match(prompt, /FOOD PREFERENCES & CONSTRAINTS/, "the swap prompt renders food memory");
  assert.match(prompt, /Hates salmon/, "the disliked food reaches the swap");
});
