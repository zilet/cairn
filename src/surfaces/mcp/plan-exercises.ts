import { z } from "zod";
import {
  attachGuide,
  buildPlanICS,
  dayDetail,
  dayDetailDate,
  deleteExercise,
  deletePlanDay,
  detachGuide,
  exerciseGuideStatus,
  findExercise,
  getExerciseDetail,
  getExerciseGuide,
  getPlanDay,
  getPlanQuality,
  importExerciseGuides,
  listExerciseAliases,
  listExercises,
  listGuideSuggestions,
  mergeExercises,
  orderPlanDayForEffect,
  planLookAhead,
  planUpcomingNote,
  planWeek,
  weekRead,
  weekReadStart,
  reconcileExerciseGroups,
  replacePlanByPerson,
  savePlanDayByPerson,
  suggestAlternatives,
  suggestVariations,
  updateExercise,
  updateTarget,
  upsertExercise,
} from "../../domain/training/index.js";
import {
  MIN_REDRAW_REQUEST_CHARS,
  requestStructureRedraw,
  structureRedrawStatus,
} from "../../domain/brain/structure-request.js";
import { getPlanWithPurpose } from "../../repo.js";
import { PlanQualityError } from "../../repo/plan-quality.js";
import { asText, type McpToolRegistrar } from "./shared.js";
import { queueMcpAgentJob } from "./background.js";

const planItemShape = z.object({
  exercise: z.string().optional().describe("exercise name (required)"),
  sets: z.number().int().optional(),
  rep_low: z.number().int().nullable().optional(),
  rep_high: z.number().int().nullable().optional(),
  target_weight: z
    .number()
    .nullable()
    .optional()
    .describe("lb; negative = assisted, null = bodyweight. A timed item may carry one too (a carry or weighted hold: load × target_seconds)"),
  note: z.string().nullable().optional(),
  warmup_sets: z.number().int().nullable().optional().describe("# of warmup sets before working sets"),
  target_seconds: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("prescribed hold/duration in seconds, for timed exercises (never with rep_low/rep_high)"),
  mode: z
    .enum(["reps", "timed"])
    .nullable()
    .optional()
    .describe("exercise mode, applied when a new exercise is created"),
  // Plan days hold STRENGTH work only (migration 110) — runs are the run engine's
  // (get_run_plan / get_training_agenda), never a plan item.
  kind: z
    .enum(["strength"])
    .nullable()
    .optional()
    .describe("always 'strength' — runs are not plan items; they follow the stated run days"),
});

export function registerPlanExerciseTools(server: McpToolRegistrar) {
  server.tool(
    "get_plan",
    "Get the full weekly training plan: every LIFTING day with its exercises, sets, rep ranges, target weights, injury notes, and the grounded 'purpose' line for that day. Plan days hold strength work only: the week's runs come from get_run_plan / get_training_agenda (built on the stated run days), and a rest day is a weekday the athlete neither lifts nor runs — neither is a plan day.",
    {},
    // Same payload as GET /api/plan — getPlanWithPurpose attaches the per-day
    // purpose line, so the two surfaces stay mirrors.
    async () => asText(getPlanWithPurpose())
  );

  server.tool(
    "get_plan_week",
    "The Plan tab's connected week: calendar Mon–Sun when lift/run schedules map weekdays, otherwise template day order with weekday null. Each cell carries status (done/today/upcoming/rest/open), the plan day, any logged session, and any run intent. Layout suggestion is a quiet collision note when the week stacks heavy lower next to a long/quality run.",
    {},
    async () => asText(planWeek())
  );

  server.tool(
    "get_week",
    "One calendar week as Horizon's Week page reads it → { as_of, today, week_start, week_end, range_words, this_week, units, frame:{stage{key,word,week_word,source}, block{week,of,words}, countdown{days,event,race_date,race_date_words,words}, push{until,until_words,words}, headline, line, glance}, summary, totals:{lift_days_done/planned, runs_done/planned, run_km_done/planned, lift_words, run_words}, days:[DayChip{date, date_words, weekday, status, today, lift, run{distance_words}, rest, hard, words, load{dose: rest|easy|moderate|hard|big, word, height 0..1}, href}], layout_note, still_open[≤2], next_milestones[≤3], goals:[race (estimate WITH its time), weight (the one weight trend), strength], journey (this week only, else null){start_date, start_words, today, marks[every dated mark ahead{…milestone, short, days_away, days_words, summit}], behind[≤3]{key, words}, line}, weight_trend }. Built on the plan strip's own week (get_plan_week's cells), the one stage word, the race build and the one weight-trend read; every sentence is in the athlete's units and names dates in words. `load.height` is a drawing aid, never a score. Pure read, mirrors GET /api/week. `start` (YYYY-MM-DD, any day of the week) defaults to this week.",
    { start: z.string().optional().describe("any day of the week to read (YYYY-MM-DD); defaults to this week") },
    async ({ start }) => {
      const day = weekReadStart(start);
      return asText(day ? weekRead(day) : { error: "start must be YYYY-MM-DD" });
    }
  );

  server.tool(
    "get_plan_look_ahead",
    "The training days ahead, read-only: today through the end of next week, one row a day — the lifting day's name and first few movements (plan days hold strength only), the calendar's run (easy/quality/long, km when known) or rest, today's lift in the server's one strength line, and each week's context (race-build rung, a recovery or deload week). mode 'order' when no lifting weekdays are known (the lifting days in the order they come round), 'empty' when nothing is planned. Mirrors GET /api/plan/look-ahead.",
    {},
    async () => asText(planLookAhead())
  );

  server.tool(
    "get_plan_day_detail",
    "One calendar day of the training week, opened → { date, weekday, today, status: done|today|upcoming|rest|open, placed, focus, headline, why, week:{race,block}, lift, run, watch[], stack, done, caveats[], run_units }. `lift`: the plan day's name/focus, an intent line specific to the day, the point of the session, the anchor lift, every exercise with sets × rep range and its load (the progression engine's next prescription for a day ahead, the plan's target for a day already lived; a guess is never a load). `run`: kind easy|quality|long, the engine's km (with a miles twin), the target zone with its bpm band, the race build's pace band when a race is dated, and the structure — warm-up / the work (reps × distance at threshold, VO2, hills) / cool-down, sized from the engine's own numbers. `watch`: a training-symptom watch the day's lifts load, a constraint note, a best set this past week, a new or changing prescription. `stack`: a quiet note when heavy legs sit beside a quality or long run. `done`: the logged session and runs for a lived day. No scores; suggestions only. Pure read, mirrors GET /api/plan/day-detail. `date` (YYYY-MM-DD) is required; null past the end of next week.",
    { date: z.string() },
    async ({ date }) => {
      const day = dayDetailDate(date);
      return asText(day ? dayDetail(day) : { error: "date (YYYY-MM-DD) required" });
    }
  );

  server.tool(
    "get_plan_day",
    "Read one lifting day of the weekly training plan by its day number, with its prescribed exercises, set and rep targets, and any injury notes. Day numbers are whatever the current plan defines; call get_plan first when the numbering is unknown. Plan days hold strength only (runs and rest are the calendar's). Returns null when no day carries that number.",
    { day_number: z.number().int().describe("the day's number in the current plan; see get_plan") },
    async ({ day_number }) => asText(getPlanDay(day_number))
  );

  server.tool(
    "get_plan_quality",
    "Validate the current training week for structural errors and evidence-based quality warnings.",
    {},
    async () => asText(getPlanQuality())
  );

  server.tool(
    "get_plan_upcoming",
    "The calm forward look for the Plan surface: queued training/recovery changes the brain will land soon (e.g. a recovery week landing Monday, a bounded target change), each with its summary and effective_date. Deduped against the recovery-week draft; returns null when nothing is waiting.",
    {},
    async () => asText(planUpcomingNote())
  );

  server.tool(
    "request_plan_redraw",
    "Ask the coach to redraw the shape of the training week in the athlete's own words — which days they train, what the week is built around, what to drop (e.g. 'move heavy legs to Thursday', 'build my week around my six anchors', 'drop to three days'). The coach drafts the whole week in the background; under the default lead posture it lands at the next natural boundary with a one-tap Undo, and under review_everything it waits for the athlete to confirm. Asking again with the same words never builds a second week — it points back at the one already in flight. Mirrors POST /api/plan/redraw. Returns the server's own readback: ok/verified, the request row's decision_id, the posture and landing day, and the background build.",
    {
      // No upper bound here on purpose: the domain trims and slices to the same bound
      // chat does, so a long ask through any door is stored as the SAME sentence and
      // collapses onto one standing request instead of building the week twice.
      request: z
        .string()
        .min(MIN_REDRAW_REQUEST_CHARS)
        .describe("the athlete's own sentence about how the training week should change; trimmed to ~1,000 characters"),
      agent: z.string().optional().describe("CLI backend to build it with; omit for the configured rotation"),
    },
    async ({ request, agent }) => asText(requestStructureRedraw({ request, source: "plan", agent: agent ?? null }))
  );

  server.tool(
    "get_plan_redraw",
    "The redraw requests still standing: what the athlete asked for, whether a build is queued or running, whether it was built into a change that has not landed yet, and the coach's own sentence about when it lands (or that it is waiting to be confirmed). A failed build reports its calm reason and review_required. Newest first, at most three. Mirrors GET /api/plan/redraw.",
    {},
    async () => asText(structureRedrawStatus())
  );

  server.tool(
    "get_plan_ics",
    "Export the training plan as an iCalendar (.ics) feed — each plan day as a weekly-recurring all-day event. Pull-not-push: subscribe in a calendar app. Day 1 maps to Monday by default; pass start_weekday (0=Sun..6=Sat) to shift.",
    {
      start_weekday: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe("JS weekday (0=Sun..6=Sat) that plan Day 1 lands on; default 1 (Monday)"),
    },
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
    "Update the prescribed target for an exercise on a given plan day: target_weight (lb) and/or target_seconds for timed exercises (a loaded carry or hold carries both).",
    {
      day_number: z.number().int(),
      exercise: z.string(),
      target_weight: z.number().optional(),
      target_seconds: z.number().int().optional().describe("prescribed hold/duration in seconds, for timed exercises"),
      quality_override: z.boolean().optional().describe("Explicitly allow an incoherent manual target edit after reviewing the quality report"),
    },
    async (target) =>
      asText(updateTarget(target.day_number, target.exercise, target.target_weight, target.target_seconds, {
        quality_override: target.quality_override === true,
        by: "person",
      }))
  );

  server.tool(
    "save_plan_day",
    "Create or replace one training day and its full exercise list (manual plan edit). Unknown exercises are created.",
    {
      day_number: z.number().int(),
      name: z.string(),
      focus: z.string().nullable().optional(),
      day_type: z.enum(["training"]).optional().describe("always 'training' — a rest day is not a plan day (it is any weekday with no lifting and no run)."),
      items: z.array(planItemShape),
      quality_override: z.boolean().optional().describe("Set only after reading the quality report returned by a refused save ({ok:false, quality}); it allows a structurally invalid day the athlete deliberately wants. The zero-items invariant on a training day is never overridable."),
    },
    async (day) => {
      try {
        const result = savePlanDayByPerson(day.day_number, day.name, day.focus ?? null, day.items, {
          quality_override: day.quality_override,
          day_type: day.day_type ?? null,
        });
        return asText(result.day);
      } catch (error) {
        // The refusal IS the contract: hand back the structured report so the caller can
        // enumerate the blocking errors instead of retrying quality_override blind.
        if (error instanceof PlanQualityError) return asText({ ok: false, quality: error.report });
        throw error;
      }
    }
  );

  server.tool(
    "order_plan_day_for_effect",
    "Rewrite one plan day's exercises into effect order: primary compounds first (barbell before machine), then secondary loaded work, isolation, then core. No-op when already ordered. Returns the day, or null when that day_number is absent.",
    { day_number: z.number().int().describe("the day's number in the current plan; see get_plan") },
    async ({ day_number }) => {
      try {
        const result = orderPlanDayForEffect(day_number);
        return asText(result ? result.day : null);
      } catch (error) {
        if (error instanceof PlanQualityError) return asText({ ok: false, quality: error.report });
        throw error;
      }
    }
  );

  server.tool(
    "delete_plan_day",
    "Remove a training day from the plan (logged history is kept).",
    { day_number: z.number().int() },
    async ({ day_number }) => asText(deletePlanDay(day_number))
  );

  server.tool(
    "set_plan",
    "Replace the ENTIRE weekly lifting plan — use to change lifting frequency (e.g. 3/4/5 days). Days not included are removed. Every day carries strength work: a run item is stripped and a day left with nothing to lift is not stored (runs follow the stated run days; a rest day is a weekday with neither).",
    {
      quality_override: z.boolean().optional().describe("Set only after reading the quality report returned by a refused save ({ok:false, quality}); it allows a structurally invalid week the athlete deliberately wants. The zero-items invariant on a training day is never overridable."),
      days: z.array(
        z.object({
          day_number: z.number().int().optional(),
          name: z.string(),
          focus: z.string().nullable().optional(),
          day_type: z.enum(["training"]).optional().describe("always 'training' — rest days aren't plan days."),
          items: z.array(planItemShape),
        })
      ),
    },
    async ({ days, quality_override }) => {
      try {
        const result = replacePlanByPerson(days, { quality_override });
        return asText(result.plan);
      } catch (error) {
        if (error instanceof PlanQualityError) return asText({ ok: false, quality: error.report });
        throw error;
      }
    }
  );

  server.tool(
    "list_exercises",
    "List every exercise with its muscle group, mode (reps|timed), constraint note, cues, and `input` — what its log row asks for: profile loaded (weight·reps·RIR) | bodyweight (reps·RIR, load optional) | mobility (reps or time only — never a load target or RIR), and per_side (the dose is each side's).",
    {},
    async () => asText(listExercises())
  );

  server.tool(
    "upsert_exercise",
    "Create an exercise by name (with optional muscle_group and mode reps|timed), or update those fields on an existing one.",
    {
      name: z
        .string()
        .describe(
          "exercise name; matched against the catalog (exact/alias/key). A match updates that exercise's fields, anything else creates a new one and queues background enrichment (canonicalize + classify + how-to guide + art)"
        ),
      muscle_group: z
        .string()
        .nullable()
        .optional()
        .describe("canonical or legacy muscle-group label, canonicalized on write; null clears it. Omit to leave unchanged on an existing exercise"),
      mode: z.enum(["reps", "timed"]).optional().describe("'timed' logs duration_sec instead of reps (plus an optional load for carries/weighted holds). Omit to leave unchanged on an existing exercise"),
    },
    // A user-facing create (via the coach/MCP client) opts into the same quiet
    // background enrichment the REST route does — canonicalize + classify + guide
    // + art on a genuine new exercise. Mirrors POST /api/exercises.
    async (exercise) => asText(upsertExercise(exercise, { enrich: true }))
  );

  server.tool(
    "update_exercise",
    "Update an existing exercise by name: mode (reps|timed), muscle_group, cues, constraint_note, input_profile / per_side (what its log row asks for), or rename it with `name` (a person's rename always lands; if the new name already exists the two fold into one). `keep_name` declines a parked `suggested_name` and remembers the no. Logged numbers never move.",
    {
      exercise: z.string().describe("exact exercise name"),
      name: z.string().optional().describe("the new display name (cleaned; the old spelling keeps resolving as an alias)"),
      keep_name: z.boolean().optional().describe("true to decline the parked suggested_name and keep the current one"),
      mode: z.enum(["reps", "timed"]).optional(),
      muscle_group: z.string().nullable().optional(),
      cues: z.string().nullable().optional(),
      constraint_note: z.string().nullable().optional(),
      input_profile: z
        .enum(["loaded", "bodyweight", "mobility"])
        .nullable()
        .optional()
        .describe("state what the log row asks for: loaded = weight·reps·RIR; bodyweight = reps·RIR with load optional; mobility = reps or time only, no load target, no RIR. null returns it to the derived read"),
      per_side: z
        .boolean()
        .nullable()
        .optional()
        .describe("true when the dose is each side's (\"2 × 6 / side\"); null returns it to the name-based read"),
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
      exercise: z
        .string()
        .describe(
          "exercise name; classified into a movement pattern by keyword matching on the name itself (not the exercise catalog), so free text works as long as it names the movement. Returns [] when no pattern is recognized"
        ),
      mode: z
        .enum(["variations", "alternatives"])
        .optional()
        .describe(
          "'variations' (default) = same-pattern movements with no equipment/injury filtering; 'alternatives' = same-pattern swaps filtered by bodyweight_only/avoid_equipment/injury_areas"
        ),
      bodyweight_only: z.boolean().optional().describe("mode:'alternatives' only — restrict candidates to bodyweight movements"),
      avoid_equipment: z
        .array(z.string())
        .optional()
        .describe("mode:'alternatives' only — equipment types to exclude from candidates (e.g. ['barbell'])"),
      injury_areas: z
        .array(z.string())
        .optional()
        .describe(
          "areas to keep load off (e.g. ['knee','shoulder']) — filters injury-risky swaps in 'alternatives' mode"
        ),
    },
    async ({ exercise, mode, bodyweight_only, avoid_equipment, injury_areas }) =>
      asText(
        mode === "alternatives"
          ? suggestAlternatives(exercise, {
              bodyweightOnly: bodyweight_only,
              avoidEquipment: avoid_equipment as any,
              injuryAreas: injury_areas,
            })
          : suggestVariations(exercise)
      )
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
    "Queue a conservative reconciliation of duplicate exercise titles into canonical movements. Returns a job immediately; poll get_agent_job. It never changes logged numbers.",
    { agent: z.string().optional().describe("agent name from list_agents; omit/'auto' for the rotation") },
    async ({ agent }) => asText(queueMcpAgentJob("exercise_reconcile", {}, agent))
  );

  server.tool(
    "get_exercise_guide",
    "The imported how-to guide for one exercise: ordered step-by-step instructions, primary/secondary muscles, equipment, difficulty, and the URLs of two demonstration photos. Sourced from free-exercise-db (public domain). Returns null when the guide library has not been imported or nothing matched this movement confidently — both ordinary states, not errors.",
    { exercise: z.string().describe("exercise name, as Cairn knows it") },
    async ({ exercise }) => asText(getExerciseGuide(exercise))
  );

  server.tool(
    "exercise_guide_status",
    "Whether the optional exercise guide library is imported, and how much of it matched: total guides stored, how many are linked to the athlete's own exercises, how many low-confidence suggestions await confirmation, and how many demonstration photos are cached locally.",
    {},
    async () => asText(exerciseGuideStatus())
  );

  server.tool(
    "import_exercise_guides",
    "Download (or refresh) the free-exercise-db instruction dataset into local storage and match it against the athlete's exercises. Only unambiguous name matches are linked; looser ones are recorded as suggestions for confirmation rather than shown, because the dataset holds many near-identical variants and a wrong demonstration photo is worse than none. Idempotent. Demonstration photos are fetched lazily on first view unless prefetch_images is set. ok:false at the call level (offline, upstream down) is the designed failure signal.",
    {
      refresh: z.boolean().optional().describe("re-download the metadata instead of reusing the local cache"),
      prefetch_images: z
        .boolean()
        .optional()
        .describe("eagerly cache the demonstration photos for every linked guide (slower; default lazy)"),
    },
    async ({ refresh, prefetch_images }) =>
      asText(await importExerciseGuides({ refresh, prefetchImages: prefetch_images }))
  );

  server.tool(
    "list_exercise_guide_suggestions",
    "The low-confidence guide matches waiting on a yes/no: each is an exercise plus the dataset movement that plausibly (but not certainly) describes it. These are never rendered to the athlete until confirmed with attach_exercise_guide.",
    {},
    async () => asText(listGuideSuggestions())
  );

  server.tool(
    "attach_exercise_guide",
    "Confirm which imported guide describes an exercise, linking it so the how-to appears in the app. Use with a guide_id from list_exercise_guide_suggestions. Replaces whatever guide that exercise had. ok:false when either the exercise or the guide is unknown.",
    {
      exercise: z.string().describe("exercise name, as Cairn knows it"),
      guide_id: z.string().describe("free-exercise-db id, e.g. 'Barbell_Bench_Press_-_Medium_Grip'"),
    },
    async ({ exercise, guide_id }) => asText(attachGuide(exercise, guide_id))
  );

  server.tool(
    "detach_exercise_guide",
    "Unlink a guide from its exercise, or dismiss a suggestion that describes the wrong movement. The refusal is remembered: a later import will not re-attach this guide on its own, though attach_exercise_guide still can. The imported text itself is kept.",
    {
      guide_id: z.string().describe("free-exercise-db id, e.g. 'Lateral_Raise_-_With_Bands'"),
    },
    async ({ guide_id }) => asText(detachGuide(guide_id))
  );
}
