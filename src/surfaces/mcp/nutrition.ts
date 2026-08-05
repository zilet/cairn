import { z } from "zod";
import {
  acceptMealPlan,
  addFoodNote,
  deleteFoodNote,
  estimateExpenditure,
  frequentFoods,
  getDayIntake,
  getMealPlan,
  listFoodNotes,
  listMealPlans,
  nutritionProgress,
  setMealPlanStatus,
  updateFoodNote,
  updateMealPlanDays,
} from "../../domain/nutrition/index.js";
import { goalPace } from "../../repo/goal-pace.js";
import { dayFuelDemand } from "../../repo/fuel-demand.js";
import { setFuelingFeedback } from "../../repo/fueling.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";
import { currentUnderfuelingRead } from "../../domain/brain/underfueling-service.js";
import { cutQualityRead } from "../../repo/cut-quality.js";

export function registerNutritionTools(server: McpToolRegistrar) {
  server.tool(
    "get_frequent_foods",
    "The foods most often logged near a time of day (±2h), most-frequent first (max 8), with macros carried from the latest occurrence when known. Powers one-tap re-log of the usual foods for this time. Pass `hour` (0-23) to target a specific time; omit to use the server clock.",
    { hour: z.number().int().min(0).max(23).optional() },
    async ({ hour }) => asText(frequentFoods(hour))
  );

  server.tool(
    "draft_meal_plan",
    "Queue a durable goal-aware weekly meal-plan refresh and bounded verification pass. Returns a job immediately; poll get_agent_job. In Lead mode the result announces and becomes current at the next food-day boundary with Undo; review posture keeps a draft. Lean-safe, protein, fiber, and longevity floors always apply.",
    {
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
      instruction: z.string().optional(),
    },
    async ({ agent, instruction }) => asText(queueMcpAgentJob("meal_plan", { instruction }, agent))
  );

  // ---- adaptive nutrition (T3) ----
  server.tool(
    "get_expenditure",
    "Best-effort daily energy expenditure (TDEE), adherence-neutral and provenance-rich. Preserves the outcome anchor (avg logged intake minus recency-weighted bodyweight trend), then deterministically chooses/blends it with the strongest eligible prior: measured RMR + source-resolved active calories, Garmin total calories, or a profile seed. Returns additive basis/anchors/coverage/provenance fields; confidence remains the outcome-data confidence, so a prior-backed tdee may honestly carry 'none'. Missing days stay absent, future rows are excluded, and window is clamped to 7–90 days. projection_text remains a plain-language goal-pace forecast, never a score.",
    { window: z.number().int().optional().describe("days to derive over (default 21)") },
    async ({ window }) => {
      const expenditure = estimateExpenditure(window ?? 21);
      return asText({
        ...expenditure,
        underfueling: currentUnderfuelingRead(undefined, { expenditure }),
        cut_quality: cutQualityRead(undefined, { expenditure }),
      });
    }
  );

  server.tool(
    "nutrition_checkin",
    "Queue a quiet adaptive-nutrition check-in. Returns a job immediately; poll get_agent_job. Meaningful drift may schedule a bounded reversible target change at the next food-day boundary under Lead mode; review posture holds it. Thin logging lowers confidence and cannot itself cut the target.",
    {
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
      window: z.number().int().optional().describe("days to derive expenditure over (default 21)"),
    },
    async ({ agent, window }) => asText(queueMcpAgentJob("nutrition_checkin", { window }, agent))
  );

  server.tool(
    "get_goal_pace",
    "The goal-pace series behind the motivational weight-progress chart: { points:[{date,weight_lb}] (canonical weigh-ins, manual beats Garmin), trend:{lb_wk, line:[{date,weight_lb},{date,weight_lb}]|null} (unweighted least-squares slope over the most recent ≤21 days, projected ~28 days out; null under 2 points or a <3-day span), needed:{lb_wk, line:[…]|null} (the straight line from today's weight to goal_weight_lb by goal_date; null with no goal, a past date, or no current weight), goal:{weight_lb,date}, window_days }. Read-only, null-safe, no scores. ?days clamps to 14–365 (default 90).",
    { days: z.number().int().optional().describe("trailing window of weigh-ins to read (default 90, clamped 14–365)") },
    async ({ days }) => asText(goalPace(days ?? 90))
  );

  server.tool(
    "get_day_intake",
    "A calm review of ONE day's logged food: { date, totals:{kcal,protein_g,carbs_g,fat_g,fiber_g}, known:{kcal,protein_g,carbs_g,fat_g,fiber_g}, entries:[{id,meal,summary,kcal,protein_g,carbs_g,fat_g,fiber_g,enrichment_status,created_at}], count, target, remaining, fuel_demand }. fuel_demand ({date, demand: light|standard|big, drivers, evidence}) is how much work the day carries, from the training plan and the week's run intentions — a reason to bias carbohydrate toward a big day, NEVER a change to the target and never a judgement about a day already lived. For patch compatibility totals and remaining stay numeric and missing entry nutrients contribute zero; newer clients MUST consult known flags before presenting a total or target comparison. target ({kcal,protein_g,mode}) and remaining are present ONLY when the profile can derive one — else null. 'remaining', never 'consumed'; no score. ?date defaults to the user's local today.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    // The same shape the REST route returns — MCP ⊆ REST, so the demand read rides
    // alongside the log here too rather than being folded into getDayIntake (which
    // also feeds the coach context, the Brief's fuel signal and the pace gauge).
    async ({ date }) => asText({ ...getDayIntake(date), fuel_demand: dayFuelDemand(date) })
  );

  server.tool(
    "get_nutrition_progress",
    "A calm multi-week read of recorded intake. Returns a complete chronological local-day series with unlogged days and unknown nutrients as null, explicit record observation density (never proof of full-day capture), confidence capped at observed because no independent completeness signal exists, and target comparisons/advice qualified with 'if these records reflect most of your day'. Nutrient averages/trends use only known values; historical accepted targets stay attached per day; food/fat-quality estimates are sampled, never extrapolated. Informational, not medical advice; no score, streak, or blame.",
    { days: z.number().int().optional().describe("trailing days (default 35, safely clamped 14–90)") },
    async ({ days }) => asText(nutritionProgress(days ?? 35))
  );

  server.tool("list_meal_plans", "List recent meal plans.", { limit: z.number().int().optional() }, async ({ limit }) =>
    asText(listMealPlans(limit ?? 10))
  );

  server.tool(
    "get_meal_plan",
    "Get one meal plan by id (hydrated: parsed days/meals/macros).",
    { id: z.number().int() },
    async ({ id }) => asText(getMealPlan(id) ?? { error: "not found", id })
  );

  server.tool(
    "set_meal_plan_status",
    "Accept or discard a drafted meal plan.",
    { id: z.number().int(), status: z.enum(["accepted", "discarded"]) },
    async ({ id, status }) => asText(status === "accepted" ? acceptMealPlan(id) : setMealPlanStatus(id, status))
  );

  server.tool(
    "swap_meal",
    "Queue one meal swap in a drafted plan, honoring an optional hint and the existing kcal/protein guardrails. Returns a job immediately; poll get_agent_job.",
    {
      id: z.number().int().describe("meal plan id"),
      day: z.string().describe("day label as in the plan, e.g. 'Mon'"),
      meal_index: z.number().int().describe("0-based index into that day's meals"),
      hint: z.string().optional().describe("free-text direction for the replacement"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ id, day, meal_index, hint, agent }) => {
      if (!getMealPlan(id)) return asText({ error: "not found", id });
      return asText(queueMcpAgentJob("meal_swap", { id, day, meal_index, hint }, agent));
    }
  );

  server.tool(
    "get_meal_recipe",
    "Get a cached recipe immediately, or queue a durable recipe-writing job when absent/forced. Poll get_agent_job for a queued result.",
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
        (d: any) =>
          String(d?.day ?? "")
            .trim()
            .toLowerCase() ===
          String(day ?? "")
            .trim()
            .toLowerCase()
      );
      const existing = Array.isArray(dayObj?.meals) ? dayObj.meals[meal_index]?.recipe : undefined;
      if (existing && !force) return asText({ ok: true, recipe: existing, cached: true });
      return asText(queueMcpAgentJob("recipe", { id: plan_id, day, meal_index }, agent));
    }
  );

  server.tool(
    "update_meal_plan_days",
    "Replace a meal plan's days array (manual meal reorder/edit). Preserves every other parsed key (daily_kcal, shopping, notes).",
    {
      id: z.number().int(),
      days: z.array(z.any()).describe("[{ day, note?, meals: [{name, items, kcal, protein_g, carbs_g, fat_g}] }]"),
    },
    async ({ id, days }) => asText(updateMealPlanDays(id, days) ?? { error: "not found", id })
  );

  server.tool(
    "log_food_note",
    "Record a meal estimate (e.g. after looking at a plate photo): meal type, description, optional macros. Optionally backdate it with `date` and say when it was eaten with `eaten_at`.",
    {
      meal: z.string(),
      raw: z.string().optional(),
      parsed: z.any().optional(),
      image_path: z.string().optional(),
      date: z
        .string()
        .optional()
        .describe(
          "YYYY-MM-DD local day the meal belongs to; defaults to today. Past days up to a year back are fine; a future day is ignored (the entry still records, on today)."
        ),
      eaten_at: z
        .string()
        .optional()
        .describe(
          "Local 24-hour wall-clock time it was eaten, 'HH:MM'. Omit when unknown — an unstated time is normal and nothing needs one. When omitted, a stated meal label sets the slot; when given, it names the meal (breakfast/lunch/dinner/snack) unless a label was stated."
        ),
    },
    // Lenient: a model resolved this "when" from a sentence, so a date it got wrong
    // degrades to today and the meal is still recorded. Losing a food entry over a
    // guessed timestamp is by far the worse failure.
    async (f) => {
      try {
        return asText(
          addFoodNote(f.meal, f.raw ?? "", f.parsed ?? null, f.image_path, {
            date: f.date,
            eaten_at: f.eaten_at,
            lenient: true,
          })
        );
      } catch (error: any) {
        return asText({ error: error?.message || "could not log food note" });
      }
    }
  );

  server.tool(
    "list_food_notes",
    "List recent logged food notes (meal type, description, parsed macros, enrichment status).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listFoodNotes(limit ?? 20))
  );

  server.tool(
    "update_food_note",
    "Correct a logged food note (fix a macro, rename it, change the meal slot, move it to the day it was actually eaten, 'I changed my mind'). Pass the id + any subset of { meal, summary, kcal, protein_g, carbs_g, fat_g, fiber_g, notes, items, date, eaten_at }. Coerced/clamped; marks the note's enrichment terminal so a background enricher can't later overwrite the correction. Returns the updated row, or an error when the id is unknown.",
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
      date: z
        .string()
        .optional()
        .describe(
          "Move the entry to this YYYY-MM-DD local day — 'that was last night, not this morning'. Omit to leave the day alone. A future day is ignored."
        ),
      eaten_at: z
        .string()
        .optional()
        .describe(
          "Correct the local 24-hour time it was eaten, 'HH:MM'. Omit to leave it alone; send an empty string to unstate a time that was wrong. Correcting the time never renames the meal."
        ),
    },
    // Lenient for the same reason as log_food_note: a bad guess must not cost the
    // correction. Note this never re-infers the meal label from a corrected time —
    // the row already carries a label someone chose.
    async ({ id, ...fields }) => asText(updateFoodNote(id, { ...fields, lenient: true }) ?? { error: "not found", id })
  );

  server.tool("delete_food_note", "Delete a logged food note by id.", { id: z.number().int() }, async ({ id }) =>
    asText(deleteFoodNote(id))
  );

  server.tool(
    "log_fueling_feedback",
    "Record the athlete's one-tap fueling read for a day — the follow-through after a nutrition-target change: energy on a calm 1-3 running-low/steady/plenty scale, an optional hunger read (1-3), and an optional note. Adherence-neutral, no scores. Upserts one row per day and, when an applied target change is still in its 7-day follow-through window, links the answer to it so the next check-in weighs the subjective signal. Returns the saved row.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      energy: z.number().int().min(1).max(3).describe("1 running low · 2 steady · 3 plenty"),
      hunger: z.number().int().min(1).max(3).optional().describe("optional appetite read (1-3)"),
      note: z.string().optional(),
    },
    async ({ date, energy, hunger, note }) => asText(setFuelingFeedback(date ?? "", { energy, hunger, note }))
  );
}
