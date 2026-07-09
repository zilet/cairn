import { z } from "zod";
import { reconcileExercises } from "../../coachOps.js";
import {
  buildPlanICS,
  deleteExercise,
  deletePlanDay,
  findExercise,
  getExerciseDetail,
  getPlan,
  getPlanDay,
  listExerciseAliases,
  listExercises,
  mergeExercises,
  reconcileExerciseGroups,
  replacePlan,
  savePlanDay,
  suggestAlternatives,
  suggestVariations,
  updateExercise,
  updateTarget,
  upsertExercise,
} from "../../domain/training/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

const planItemShape = z.object({
  exercise: z.string().optional().describe("exercise name (required for a strength item; a label for a cardio item)"),
  sets: z.number().int().optional(),
  rep_low: z.number().int().nullable().optional(),
  rep_high: z.number().int().nullable().optional(),
  target_weight: z.number().nullable().optional().describe("lb; negative = assisted, null = bodyweight"),
  note: z.string().nullable().optional(),
  warmup_sets: z.number().int().nullable().optional().describe("# of warmup sets before working sets"),
  target_seconds: z.number().int().nullable().optional().describe("prescribed hold/duration in seconds, for timed exercises"),
  mode: z.enum(["reps", "timed"]).nullable().optional().describe("exercise mode, applied when a new exercise is created"),
  // First-class planned cardio (v35): a kind:'cardio' item carries an endurance
  // prescription instead of a loaded exercise (no exercise_id is stored).
  kind: z.enum(["strength", "cardio"]).nullable().optional().describe("'cardio' = an endurance prescription with no loaded exercise; default 'strength'"),
  target_distance_km: z.number().nullable().optional().describe("planned distance in km (cardio)"),
  target_duration_min: z.number().nullable().optional().describe("planned moving time in minutes (cardio)"),
  target_zone: z.string().nullable().optional().describe("HR/effort zone, e.g. 'Z2' | 'tempo' | 'easy' (cardio)"),
  interval: z.any().optional().describe("optional structured interval JSON (cardio)"),
});

export function registerPlanExerciseTools(server: McpToolRegistrar) {
  server.tool(
    "get_plan",
    "Get the full weekly training plan: every day with its exercises, sets, rep ranges, target weights, and injury notes.",
    {},
    async () => asText(getPlan())
  );

  server.tool(
    "get_plan_day",
    "Get one training day by its number (1-5) with prescribed exercises and targets.",
    { day_number: z.number().int().describe("1 through 5") },
    async ({ day_number }) => asText(getPlanDay(day_number))
  );

  server.tool(
    "get_plan_ics",
    "Export the training plan as an iCalendar (.ics) feed — each plan day as a weekly-recurring all-day event. Pull-not-push: subscribe in a calendar app. Day 1 maps to Monday by default; pass start_weekday (0=Sun..6=Sat) to shift.",
    { start_weekday: z.number().int().min(0).max(6).optional().describe("JS weekday (0=Sun..6=Sat) that plan Day 1 lands on; default 1 (Monday)") },
    async ({ start_weekday }) => ({
      content: [{ type: "text" as const, text: buildPlanICS({ startWeekday: start_weekday }) }],
    })
  );

  server.tool(
    "get_exercise",
    "Get the guide for one exercise: muscle group, injury constraint, form cues, where it appears in the plan, est-1RM trend, and recent sets.",
    { exercise: z.string() },
    async ({ exercise }) => asText(getExerciseDetail(exercise))
  );

  server.tool(
    "update_target",
    "Update the prescribed target for an exercise on a given plan day: target_weight (lb) for reps exercises and/or target_seconds for timed exercises.",
    {
      day_number: z.number().int(),
      exercise: z.string(),
      target_weight: z.number().optional(),
      target_seconds: z.number().int().optional().describe("prescribed hold/duration in seconds, for timed exercises"),
    },
    async (target) => asText(updateTarget(target.day_number, target.exercise, target.target_weight, target.target_seconds))
  );

  server.tool(
    "save_plan_day",
    "Create or replace one training day and its full exercise list (manual plan edit). Unknown exercises are created.",
    {
      day_number: z.number().int(),
      name: z.string(),
      focus: z.string().nullable().optional(),
      items: z.array(planItemShape),
    },
    async (day) => asText(savePlanDay(day.day_number, day.name, day.focus ?? null, day.items))
  );

  server.tool(
    "delete_plan_day",
    "Remove a training day from the plan (logged history is kept).",
    { day_number: z.number().int() },
    async ({ day_number }) => asText(deletePlanDay(day_number))
  );

  server.tool(
    "set_plan",
    "Replace the ENTIRE weekly plan — use to change frequency (e.g. 3/4/5/7 days) or to add cardio days. Days not included are removed. Each item may be a strength exercise or a kind:'cardio' endurance prescription.",
    {
      days: z.array(z.object({
        day_number: z.number().int().optional(),
        name: z.string(),
        focus: z.string().nullable().optional(),
        items: z.array(planItemShape),
      })),
    },
    async ({ days }) => asText(replacePlan(days))
  );

  server.tool(
    "list_exercises",
    "List every exercise with its muscle group, mode (reps|timed), constraint note, and cues.",
    {},
    async () => asText(listExercises())
  );

  server.tool(
    "upsert_exercise",
    "Create an exercise by name (with optional muscle_group and mode reps|timed), or update those fields on an existing one.",
    {
      name: z.string(),
      muscle_group: z.string().nullable().optional(),
      mode: z.enum(["reps", "timed"]).optional(),
    },
    // A user-facing create (via the coach/MCP client) opts into the same quiet
    // background enrichment the REST route does — canonicalize + classify + guide
    // + art on a genuine new exercise. Mirrors POST /api/exercises.
    async (exercise) => asText(upsertExercise(exercise, { enrich: true }))
  );

  server.tool(
    "update_exercise",
    "Update an existing exercise by name: mode (reps|timed), muscle_group, cues, constraint_note (any subset).",
    {
      exercise: z.string().describe("exact exercise name"),
      mode: z.enum(["reps", "timed"]).optional(),
      muscle_group: z.string().nullable().optional(),
      cues: z.string().nullable().optional(),
      constraint_note: z.string().nullable().optional(),
    },
    async ({ exercise, ...patch }) => {
      const row = findExercise(exercise);
      if (!row) return asText({ error: "not found", exercise });
      return asText(updateExercise(row.id, patch));
    }
  );

  server.tool(
    "delete_exercise",
    "Delete an exercise by name. Refuses (ok:false) if it still has logged sets or is referenced in a plan — remove those first.",
    { name: z.string().describe("exact exercise name") },
    async ({ name }) => asText(deleteExercise(name))
  );

  server.tool(
    "suggest_variations",
    "Variation candidates for an exercise (same movement pattern, different bar path/implement) to break a plateau or keep training fresh; mode:'alternatives' returns equipment/injury-aware swaps.",
    {
      exercise: z.string(),
      mode: z.enum(["variations", "alternatives"]).optional(),
      bodyweight_only: z.boolean().optional(),
      avoid_equipment: z.array(z.string()).optional(),
      injury_areas: z.array(z.string()).optional().describe("areas to keep load off (e.g. ['knee','shoulder']) — filters injury-risky swaps in 'alternatives' mode"),
    },
    async ({ exercise, mode, bodyweight_only, avoid_equipment, injury_areas }) =>
      asText(mode === "alternatives"
        ? suggestAlternatives(exercise, { bodyweightOnly: bodyweight_only, avoidEquipment: avoid_equipment as any, injuryAreas: injury_areas })
        : suggestVariations(exercise))
  );

  server.tool(
    "reconcile_exercise_groups",
    "Backfill and normalize the muscle_group for every exercise: null values are auto-classified from the exercise name; legacy values (e.g. 'legs' → 'quads', 'posterior' → 'hamstrings') are mapped to the canonical taxonomy. Idempotent — safe to run repeatedly.",
    {},
    async () => asText(reconcileExerciseGroups())
  );

  server.tool(
    "merge_exercises",
    "Merge two exercises: repoints all logged_sets and plan_items from `from` into `into`, then removes the now-empty `from` exercise. ok:false when `into` does not exist (guard — nothing is changed). Use after reconcile_exercise_groups reveals duplicate names ('Dead hang' / 'Dead hang timed').",
    {
      from: z.string().describe("the exercise name to merge away (will be deleted after merge)"),
      into: z.string().describe("the exercise name to keep (must already exist)"),
    },
    async ({ from, into }) => asText(mergeExercises(from, into))
  );

  server.tool(
    "list_exercise_aliases",
    "List the learned exercise-name aliases (variant → canonical movement) — the de-duplication map behind the volume/progression read. Each row is { alias, canonical, source }. The deterministic exercise-canon normalizer is always on; these are the harder synonyms learned by reconcile_exercise_names.",
    {},
    async () => asText(listExerciseAliases())
  );

  server.tool(
    "reconcile_exercise_names",
    "Tidy descriptive / duplicate exercise titles into clean, reusable CANONICAL movement names so each lift's history merges into one trend (e.g. 'DB bench'/'Dumbbell bench press' → one movement, 'Dead hang'/'Dead hang timed' folded together) and profiles each movement's muscle group. A deterministic canonicalizer (exercise-canon) always folds the obvious cases; this AGENTIC pass learns the harder synonyms a human would catch and persists them as exercise_aliases, so future logging resolves them automatically. CONSERVATIVE — only merges unambiguous same-movement names, and NEVER changes any logged numbers (only the series merge). Returns {aligned, applied}. The mirror of reconcile_markers for movements.",
    { agent: z.string().optional().describe("agent name from list_agents; omit/'auto' for the rotation") },
    async ({ agent }) => asText(await reconcileExercises(agent))
  );
}
