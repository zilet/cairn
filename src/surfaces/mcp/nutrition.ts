import { z } from "zod";
import { draftMealPlan, generateRecipe, nutritionCheckin, swapMealAgentic } from "../../coachOps.js";
import {
  addFoodNote,
  deleteFoodNote,
  estimateExpenditure,
  frequentFoods,
  getDayIntake,
  getMealPlan,
  listFoodNotes,
  listMealPlans,
  setMealPlanStatus,
  updateFoodNote,
  updateMealPlanDays,
} from "../../domain/nutrition/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerNutritionTools(server: McpToolRegistrar) {
  server.tool("get_frequent_foods",
    "The foods most often logged near a time of day (±2h), most-frequent first (max 8), with macros carried from the latest occurrence when known. Powers one-tap re-log of the usual foods for this time. Pass `hour` (0-23) to target a specific time; omit to use the server clock.",
    { hour: z.number().int().min(0).max(23).optional() },
    async ({ hour }) => asText(frequentFoods(hour)));

  server.tool("draft_meal_plan",
    "Run an agent to draft a goal-aware weekly meal plan (lean-safe deficit, protein target), then a bounded self-critique verify pass against the lean-safe/longevity floors before saving. The saved plan is the verified draft; `verified:{checked,adjustments}` shows it was checked against your protein/fiber/kcal floors. Verify fails open (no agent ⇒ ships unverified).",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"), instruction: z.string().optional() },
    async ({ agent, instruction }) => asText(await draftMealPlan(agent, instruction)));

  // ---- adaptive nutrition (T3) ----
  server.tool("get_expenditure",
    "Derived real daily energy expenditure (TDEE), MacroFactor-style and adherence-neutral: avg logged intake minus the recency-weighted bodyweight trend. Returns { tdee, confidence:'none'|'low'|'medium'|'high', points, window_days, intake_avg_kcal, trend_lb_wk, projected_goal_date, projection_text }. projection_text is a PLAIN-LANGUAGE goal-pace forecast off the measured weigh-in trend ('at this trend, ~Aug 20 — about 3 weeks past your date'); never a score. Null tdee / 'none' confidence when there's too little data; confidence is lowered during a travel/illness window. window defaults to 21 days.",
    { window: z.number().int().optional().describe("days to derive over (default 21)") },
    async ({ window }) => asText(estimateExpenditure(window ?? 21)));

  server.tool("nutrition_checkin",
    "Quiet adaptive-nutrition check-in: when the derived expenditure has drifted meaningfully off the goal, an agent drafts a calorie/macro target CHANGE as a DRAFT proposal to review (never auto-applied). Adherence-neutral — a thin logging week only lowers confidence, never cuts the target. Most weeks nothing has moved (returns change:false, no proposal). ok:false is the designed failure signal.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"), window: z.number().int().optional().describe("days to derive expenditure over (default 21)") },
    async ({ agent, window }) => asText(await nutritionCheckin(agent, window)));

  server.tool("get_day_intake",
    "A calm review of ONE day's logged food: { date, totals:{kcal,protein_g,carbs_g,fat_g,fiber_g}, entries:[{id,meal,summary,kcal,protein_g,carbs_g,fat_g,fiber_g,enrichment_status,created_at}], count, target, remaining }. target ({kcal,protein_g,mode}) and remaining are present ONLY when the profile can derive one (a loss/gain goal, or the maintenance anchor) — else null (descriptive-only). 'remaining', never 'consumed'; no score. ?date defaults to the user's local today.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(getDayIntake(date)));

  server.tool("list_meal_plans", "List recent meal plans.", { limit: z.number().int().optional() },
    async ({ limit }) => asText(listMealPlans(limit ?? 10)));

  server.tool("get_meal_plan", "Get one meal plan by id (hydrated: parsed days/meals/macros).",
    { id: z.number().int() },
    async ({ id }) => asText(getMealPlan(id) ?? { error: "not found", id }));

  server.tool("set_meal_plan_status",
    "Accept or discard a drafted meal plan.",
    { id: z.number().int(), status: z.enum(["accepted", "discarded"]) },
    async ({ id, status }) => asText(setMealPlanStatus(id, status)));

  server.tool("swap_meal",
    "Agentically swap ONE meal in a drafted meal plan for a different dish, honoring an optional free-text hint (e.g. 'let's go with fish'). Keeps kcal/protein within ±10% unless the hint asks otherwise.",
    {
      id: z.number().int().describe("meal plan id"),
      day: z.string().describe("day label as in the plan, e.g. 'Mon'"),
      meal_index: z.number().int().describe("0-based index into that day's meals"),
      hint: z.string().optional().describe("free-text direction for the replacement"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ id, day, meal_index, hint, agent }) => {
      const plan = getMealPlan(id);
      if (!plan) return asText({ error: "not found", id });
      return asText(await swapMealAgentic(agent, { plan, id, day, mealIndex: meal_index, hint }));
    });

  server.tool("get_meal_recipe",
    "Get the recipe for one planned meal — returns the cached recipe if the meal already has one, otherwise runs an agent to write it and caches it on the meal inside the plan.",
    {
      plan_id: z.number().int().describe("meal plan id"),
      day: z.string().describe("day label as in the plan, e.g. 'Mon'"),
      meal_index: z.number().int().describe("0-based index into that day's meals"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
      force: z.boolean().optional().describe("regenerate even when a cached recipe exists"),
    },
    async ({ plan_id, day, meal_index, agent, force }) => {
      const plan = getMealPlan(plan_id);
      if (!plan) return asText({ error: "not found", id: plan_id });
      const dayObj = (Array.isArray(plan.parsed?.days) ? plan.parsed.days : []).find(
        (d: any) => String(d?.day ?? "").trim().toLowerCase() === String(day ?? "").trim().toLowerCase()
      );
      const existing = Array.isArray(dayObj?.meals) ? dayObj.meals[meal_index]?.recipe : undefined;
      if (existing && !force) return asText({ ok: true, recipe: existing, cached: true });
      return asText(await generateRecipe(agent, { plan, id: plan_id, day, mealIndex: meal_index }));
    });

  server.tool("update_meal_plan_days",
    "Replace a meal plan's days array (manual meal reorder/edit). Preserves every other parsed key (daily_kcal, shopping, notes).",
    { id: z.number().int(), days: z.array(z.any()).describe("[{ day, note?, meals: [{name, items, kcal, protein_g, carbs_g, fat_g}] }]") },
    async ({ id, days }) => asText(updateMealPlanDays(id, days) ?? { error: "not found", id }));

  server.tool("log_food_note",
    "Record a meal estimate (e.g. after looking at a plate photo): meal type, description, optional macros.",
    {
      meal: z.string(), raw: z.string().optional(),
      parsed: z.any().optional(), image_path: z.string().optional(),
    },
    async (f) => asText(addFoodNote(f.meal, f.raw ?? "", f.parsed ?? null, f.image_path)));

  server.tool("list_food_notes", "List recent logged food notes (meal type, description, parsed macros, enrichment status).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listFoodNotes(limit ?? 20)));

  server.tool("update_food_note",
    "Correct a logged food note (fix a macro, rename it, change the meal slot, 'I changed my mind'). Pass the id + any subset of { meal, summary, kcal, protein_g, carbs_g, fat_g, fiber_g, notes, items }. Coerced/clamped; marks the note's enrichment terminal so a background enricher can't later overwrite the correction. Returns the updated row, or an error when the id is unknown.",
    {
      id: z.number().int(),
      meal: z.string().optional(),
      summary: z.string().optional(),
      kcal: z.number().optional(),
      protein_g: z.number().optional(),
      carbs_g: z.number().optional(),
      fat_g: z.number().optional(),
      fiber_g: z.number().optional(),
      notes: z.string().optional(),
      items: z.array(z.string()).optional(),
    },
    async ({ id, ...fields }) => asText(updateFoodNote(id, fields) ?? { error: "not found", id }));

  server.tool("delete_food_note", "Delete a logged food note by id.",
    { id: z.number().int() },
    async ({ id }) => asText(deleteFoodNote(id)));
}
