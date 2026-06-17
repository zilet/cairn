import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Request, Response } from "express";
import * as repo from "./repo.js";
import {
  agentStatusFor,
  suggestSession,
  draftCoachProposal,
  weekAheadRead,
  draftMealPlan,
  nutritionCheckin,
  swapMealAgentic,
  generateRecipe,
  runHealthReview,
  generateInsight,
  runResearch,
  consolidateMemory,
  growAboutMe,
  reconcileOutcomes,
  distillChat,
  onboardFromText,
} from "./coachOps.js";
import { computeDayRead, localToday } from "./dayread.js";

function asText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "cairn", version: "0.1.0" });

  server.tool(
    "get_plan",
    "Get the full weekly training plan: every day with its exercises, sets, rep ranges, target weights, and injury notes.",
    {},
    async () => asText(repo.getPlan())
  );

  server.tool(
    "get_plan_day",
    "Get one training day by its number (1-5) with prescribed exercises and targets.",
    { day_number: z.number().int().describe("1 through 5") },
    async ({ day_number }) => asText(repo.getPlanDay(day_number))
  );

  server.tool(
    "get_plan_ics",
    "Export the training plan as an iCalendar (.ics) feed — each plan day as a weekly-recurring all-day event. Pull-not-push: subscribe in a calendar app. Day 1 maps to Monday by default; pass start_weekday (0=Sun..6=Sat) to shift.",
    { start_weekday: z.number().int().min(0).max(6).optional().describe("JS weekday (0=Sun..6=Sat) that plan Day 1 lands on; default 1 (Monday)") },
    async ({ start_weekday }) => ({
      content: [{ type: "text" as const, text: repo.buildPlanICS({ startWeekday: start_weekday }) }],
    })
  );

  server.tool(
    "log_set",
    "Log one working set. Uses today's session automatically (creates it if needed). Weight in lb; use negative weight for assisted movements (e.g. -30 = 30lb assist). For timed exercises (plank, dead hang) pass duration_sec instead of weight/reps, with exercise_mode 'timed'.",
    {
      exercise: z.string(),
      weight: z.number().optional(),
      reps: z.number().int().optional(),
      rir: z.number().optional().describe("reps in reserve"),
      duration_sec: z.number().optional().describe("seconds held/hung, for timed exercises"),
      exercise_mode: z.enum(["reps", "timed"]).optional().describe("sets the exercise's mode (applied on create; updates an existing exercise when passed)"),
      set_number: z.number().int().optional(),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      day_number: z.number().int().optional(),
      note: z.string().optional(),
    },
    async (args) => asText(repo.logSetByName(args))
  );

  server.tool(
    "get_progress",
    "Get logged history and estimated-1RM trend (Epley) for one exercise over time.",
    { exercise: z.string() },
    async ({ exercise }) => asText(repo.getProgress(exercise))
  );

  server.tool(
    "get_exercise",
    "Get the guide for one exercise: muscle group, injury constraint, form cues, where it appears in the plan, est-1RM trend, and recent sets.",
    { exercise: z.string() },
    async ({ exercise }) => asText(repo.getExerciseDetail(exercise))
  );

  server.tool(
    "recent_sessions",
    "List recent logged sessions, each with all its sets.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.getRecentSessions(limit ?? 10))
  );

  server.tool(
    "get_session_detail",
    "Get one logged session by its id, with all its sets.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.getSessionDetail(id) ?? { error: "not found", id })
  );

  server.tool(
    "get_recent_training",
    "The unified 'Lately' feed: finished strength sessions and cardio activities merged newest-first, each with a real timestamp (Garmin) and body-reaction detail (HR zones, temperature, effort, VO2) when available.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.recentTraining(limit ?? 6))
  );

  server.tool(
    "finish_session",
    "Mark a session finished (optionally attaching notes) and return its summary (sets, tonnage, PRs).",
    { id: z.number().int(), notes: z.string().nullable().optional() },
    async ({ id, notes }) => asText(repo.finishSession(id, notes ?? null))
  );

  server.tool(
    "delete_set",
    "Delete one logged set by id (e.g. a mis-entry).",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteSet(id))
  );

  server.tool(
    "update_set",
    "Edit one logged set by id (history correction): any subset of weight (lb), reps, rir, note, duration_sec (timed work). Only provided fields change.",
    {
      id: z.number().int(),
      weight: z.number().nullable().optional(),
      reps: z.number().int().nullable().optional(),
      rir: z.number().nullable().optional(),
      note: z.string().nullable().optional(),
      duration_sec: z.number().nullable().optional(),
    },
    async ({ id, ...fields }) => {
      const r = repo.updateSet(id, fields);
      return asText(r ?? { error: "not found", id });
    }
  );

  server.tool(
    "reopen_session",
    "Reopen a finished session to keep logging (clears its finished stamp).",
    { id: z.number().int() },
    async ({ id }) => asText(repo.reopenSession(id) ?? { error: "not found", id })
  );

  server.tool(
    "update_session_notes",
    "Edit a session's notes after the fact (history correction).",
    { id: z.number().int(), notes: z.string().nullable() },
    async ({ id, notes }) => asText(repo.updateSessionNotes(id, notes ?? null) ?? { error: "not found", id })
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
    async (a) => asText(repo.updateTarget(a.day_number, a.exercise, a.target_weight, a.target_seconds))
  );

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

  server.tool(
    "save_plan_day",
    "Create or replace one training day and its full exercise list (manual plan edit). Unknown exercises are created.",
    {
      day_number: z.number().int(),
      name: z.string(),
      focus: z.string().nullable().optional(),
      items: z.array(planItemShape),
    },
    async (a) => asText(repo.savePlanDay(a.day_number, a.name, a.focus ?? null, a.items))
  );

  server.tool(
    "delete_plan_day",
    "Remove a training day from the plan (logged history is kept).",
    { day_number: z.number().int() },
    async ({ day_number }) => asText(repo.deletePlanDay(day_number))
  );

  server.tool(
    "set_plan",
    "Replace the ENTIRE weekly plan — use to change frequency (e.g. 3/4/5/7 days) or to add cardio days. Days not included are removed. Each item may be a strength exercise or a kind:'cardio' endurance prescription.",
    { days: z.array(z.object({
        day_number: z.number().int().optional(),
        name: z.string(),
        focus: z.string().nullable().optional(),
        items: z.array(planItemShape),
      })) },
    async ({ days }) => asText(repo.replacePlan(days))
  );

  // ---- exercise CRUD ----
  server.tool(
    "list_exercises",
    "List every exercise with its muscle group, mode (reps|timed), constraint note, and cues.",
    {},
    async () => asText(repo.listExercises())
  );

  server.tool(
    "upsert_exercise",
    "Create an exercise by name (with optional muscle_group and mode reps|timed), or update those fields on an existing one.",
    {
      name: z.string(),
      muscle_group: z.string().nullable().optional(),
      mode: z.enum(["reps", "timed"]).optional(),
    },
    async (a) => asText(repo.upsertExercise(a))
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
      const ex = repo.findExercise(exercise);
      if (!ex) return asText({ error: "not found", exercise });
      return asText(repo.updateExercise(ex.id, patch));
    }
  );

  server.tool(
    "delete_exercise",
    "Delete an exercise by name. Refuses (ok:false) if it still has logged sets or is referenced in a plan — remove those first.",
    { name: z.string().describe("exact exercise name") },
    async ({ name }) => asText(repo.deleteExercise(name))
  );

  server.tool(
    "get_weekly_stats",
    "Compact weekly dashboard: training days, tonnage, total logged sets (incl. timed) over the last 7 days, plus the consistency streak — and an additive `endurance` block (this week's mileage, moving time, longest effort, time-in-HR-zone, pace trend) for runner/hybrid athletes.",
    {},
    async () => asText(repo.getWeeklyStats())
  );

  server.tool(
    "get_endurance_prs",
    "Endurance PRs from logged cardio: the longest single distance + duration and the fastest pace (min/km) at standard distances (1/5/10k, half, full). Optional type filter (e.g. 'run'|'ride'). Plain numbers, never a score — the endurance analogue of the strength est-1RM.",
    { type: z.string().optional().describe("filter to one activity type, e.g. 'run' | 'ride'") },
    async ({ type }) => asText(repo.getEndurancePRs(type))
  );

  server.tool(
    "get_run_compliance",
    "Run compliance for this week (Monday-anchored): the prescribed plan cardio (sessions / km / min) vs the actual logged cardio efforts, plus a plain-language summary ('32 of 40 km this week'). A ratio, never a 0-100 score — the endurance analogue of plan-day adherence for lifting.",
    {},
    async () => asText(repo.getRunCompliance())
  );

  server.tool(
    "get_cardio",
    "The day's logged cardio efforts (runs/rides/etc.), each hydrated from the linked Garmin record so a synced effort carries its HR zones + pace. Strength is excluded (it's modeled as a session). Defaults to today; pass date YYYY-MM-DD. [] when there's no cardio that day.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(repo.getCardioForDate(date ?? ""))
  );

  server.tool(
    "get_endurance_goal",
    "The athlete's endurance OBJECTIVE (v37), computed. mode 'race' carries a dated event with weeks/days-to-race + a periodization phase hint (base/build/sharpen/taper); mode 'standing' is an ongoing readiness target with no date. null when unset. Orthogonal to primary_discipline. Set it via set_profile { endurance_goal: {…} }.",
    {},
    async () => asText(repo.getEnduranceGoal())
  );

  server.tool(
    "set_endurance_goal",
    "Set or clear the athlete's endurance OBJECTIVE (running goal). mode 'race' → a dated event the coach periodizes a ramp + taper toward (needs date YYYY-MM-DD; optional event, distance_km, target like 'sub-1:45'). mode 'standing' → an ongoing readiness target with NO date (e.g. label '10k-ready', distance_km 10). Pass null to clear. Orthogonal to primary_discipline (a strength-first athlete can hold a standing running goal).",
    {
      mode: z.enum(["race", "standing"]).nullable().optional().describe("'race' | 'standing'; omit/null with no other fields to clear"),
      event: z.string().optional(), date: z.string().optional().describe("YYYY-MM-DD (race mode)"),
      label: z.string().optional().describe("readiness label (standing mode), e.g. '10k-ready'"),
      distance_km: z.number().optional(), target: z.string().optional(),
      weekly_km: z.number().optional(), weekly_sessions: z.number().optional(),
    },
    async (g) => {
      // A race without a date can't be periodized — normalizeEnduranceGoal would
      // reject it to null, which setProfile reads as "clear". Guard so a caller who
      // omits the date gets an explicit error instead of silently wiping the goal.
      if (g.mode === "race" && !g.date) return asText({ ok: false, error: "race mode requires a date (YYYY-MM-DD)" });
      return asText(repo.setProfile({ endurance_goal: g.mode == null ? null : g }));
    }
  );

  server.tool(
    "list_agents",
    "List the configured coaching agents (claude, codex, stub, ...) with their enabled state, order, and whether any required API key is present.",
    {},
    async () => asText(repo.getAgentConfig())
  );

  server.tool(
    "draft_plan_update",
    "Run a coaching agent over recent logs to produce a DRAFT plan-update proposal. Does not change the plan; review then apply_proposal.",
    {
      agent: z.string().optional().describe("agent name from list_agents; omit or 'auto' to use the configured rotation"),
      instruction: z.string().optional().describe("optional extra guidance"),
    },
    async ({ agent, instruction }) => {
      const r = await draftCoachProposal(agent, instruction);
      return asText({ proposal: r.proposal, ok: r.ok, agent: r.agent, tried: r.tried });
    }
  );

  server.tool(
    "list_proposals",
    "List recent plan-update proposals and their status (draft/applied/discarded).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listProposals(limit ?? 20))
  );

  server.tool(
    "apply_proposal",
    "Apply a draft proposal's target changes to the plan.",
    { id: z.number().int() },
    async ({ id }) => {
      try {
        return asText(repo.applyProposal(id));
      } catch (e: any) {
        return asText({ error: e.message });
      }
    }
  );

  server.tool(
    "discard_proposal",
    "Discard a draft proposal without applying it.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.setProposalStatus(id, "discarded"))
  );

  // ---- profile, goal, activities, memory, nutrition ----
  server.tool("get_profile", "Get the athlete's profile (age, height, weight, goal).", {},
    async () => asText(repo.getProfile()));

  server.tool("set_profile", "Update profile fields (any subset). Weight in lb, height in cm. about_me is free-text the coach uses to personalize (training history, work pattern, food likes/dislikes, what 'better' means to you); pass '' to clear. allergies are a HARD safety exclusion for meal planning; dietary_restrictions (vegetarian, no pork, …) are respected strongly. Pass '' to clear either. primary_discipline ('strength'|'endurance'|'hybrid', default 'strength') shapes coaching framing, the day-read, and weekly stats; endurance_sport is optional free text ('running'/'cycling'/'triathlon'), '' clears it.",
    {
      sex: z.string().optional(), age: z.number().optional(), height_cm: z.number().optional(),
      weight_lb: z.number().optional(), goal_weight_lb: z.number().optional(),
      goal_date: z.string().optional(), activity_factor: z.number().optional(), notes: z.string().optional(),
      about_me: z.string().optional(),
      allergies: z.string().optional(), dietary_restrictions: z.string().optional(),
      primary_discipline: z.enum(["strength", "endurance", "hybrid"]).optional(),
      endurance_sport: z.string().optional(),
    },
    async (p) => asText(repo.setProfile(p)));

  server.tool("get_goal_check", "Compute TDEE and a lean-safe feasibility check for the current goal.", {},
    async () => asText(repo.computeGoalCheck()));

  server.tool("log_weight",
    "Record a bodyweight measurement (lb). Also updates the profile's current weight to the latest entry.",
    { weight_lb: z.number(), date: z.string().optional().describe("YYYY-MM-DD; defaults to today"), note: z.string().optional() },
    async (a) => asText(repo.logWeight(a.weight_lb, a.date, a.note)));

  server.tool("list_weight", "List bodyweight history (chronological).", { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listWeight(limit ?? 60)));

  server.tool("log_activity",
    "Log a cardio/other session. Pass free text (e.g. 'ran 50 min @5:30/km') and/or structured fields.",
    {
      text: z.string().optional(), type: z.string().optional(),
      duration_min: z.number().optional(), distance_km: z.number().optional(),
      pace: z.string().optional(), rpe: z.number().optional(), date: z.string().optional(), notes: z.string().optional(),
    },
    async (a) => asText(repo.addActivity(a)));

  server.tool("list_activities", "List recent logged activities.", { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listActivities(limit ?? 20)));

  server.tool("upsert_garmin_source",
    "Create/update the local Garmin source record. Garmin remains one data source; this stores connector mode/status/cursor only.",
    {
      mode: z.enum(["unofficial", "official", "manual"]).optional(),
      label: z.string().nullable().optional(),
      auth_status: z.string().nullable().optional(),
      sync_cursor: z.string().nullable().optional(),
      last_sync_at: z.string().nullable().optional(),
    },
    async (a) => asText(repo.upsertGarminSource(a)));

  server.tool("list_garmin_sources", "List configured Garmin source records without token material.", {},
    async () => asText(repo.listGarminSources()));

  server.tool("sync_garmin",
    "Run a manual Garmin Connect sync using local GARMIN_USERNAME/GARMIN_PASSWORD or stored token files. Experimental unofficial connector. The scheduler also auto-syncs ~every 6h when configured; the result is recorded as garmin_last_sync_at/garmin_last_sync_status (visible via get_settings).",
    {
      days: z.number().int().optional().describe("Backfill window, default 30, max 180"),
      limit: z.number().int().optional().describe("Activity list fetch limit, default 100, max 200"),
      daily: z.boolean().optional().describe("Whether to sync daily metrics; default true"),
    },
    async (opts) => {
      const { syncGarmin } = await import("./garmin.js");
      return asText(await syncGarmin(opts));
    });

  server.tool("upsert_garmin_activity",
    "Ingest one normalized Garmin activity. It is deduped by external_id and mirrored into Cairn activities for calendar/load context.",
    {
      source_id: z.number().int().optional(),
      external_id: z.string(),
      date: z.string().optional(),
      start_time: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      duration_min: z.number().nullable().optional(),
      distance_km: z.number().nullable().optional(),
      calories: z.number().nullable().optional(),
      avg_hr: z.number().nullable().optional(),
      max_hr: z.number().nullable().optional(),
      ascent_m: z.number().nullable().optional(),
      training_load: z.number().nullable().optional(),
      training_effect: z.number().nullable().optional(),
      hr_zones: z.array(z.any()).nullable().optional(),
      exercise_sets: z.array(z.any()).nullable().optional().describe("Detected strength sets: [{category,name,reps,weight_kg,duration_sec,set_type}]"),
    },
    async ({ source_id, ...activity }) => asText(repo.upsertGarminActivity(activity, source_id)));

  server.tool("upsert_garmin_daily_metric",
    "Ingest one normalized Garmin all-day/recovery metric row for a date.",
    {
      source_id: z.number().int().optional(),
      date: z.string(),
      steps: z.number().int().nullable().optional(),
      sleep_min: z.number().nullable().optional(),
      sleep_score: z.number().nullable().optional(),
      resting_hr: z.number().nullable().optional(),
      hrv_ms: z.number().nullable().optional(),
      stress_avg: z.number().nullable().optional(),
      body_battery_avg: z.number().nullable().optional(),
      body_battery_min: z.number().nullable().optional(),
      body_battery_max: z.number().nullable().optional(),
      active_calories: z.number().nullable().optional(),
    },
    async ({ source_id, ...metric }) => asText(repo.upsertGarminDailyMetric(metric, source_id)));

  server.tool("get_garmin_summary",
    "Compact coach-facing Garmin summary: recent endurance load and recovery metrics. Use as context, not as plan authority.",
    { days: z.number().int().optional() },
    async ({ days }) => asText(repo.getGarminCoachSummary(days ?? 14)));

  server.tool("list_unreconciled_garmin_strength",
    "List synced Garmin strength activities not yet linked to a Cairn session (session_id null) over a recent window — the watch logged a lift Cairn doesn't know about. Empty when Garmin isn't configured. Follow with reconcile_garmin_strength to merge them in.",
    { days: z.number().int().optional() },
    async ({ days }) => asText(repo.listUnreconciledGarminStrength(days ?? 30)));

  server.tool("reconcile_garmin_strength",
    "Reconcile synced Garmin strength activities into the day's Cairn session: merge the physiology layer (HR/zones/calories/training effect) now, and queue the agentic narrative + extrapolation of the detected exercises the athlete didn't already log. Pass {date} for one day, else {days} for a recent window.",
    { date: z.string().optional(), days: z.number().int().optional() },
    async ({ date, days }) => {
      const rows = repo.listStrengthGarminActivities(date ? { date } : { days });
      const sessions: any[] = [];
      for (const r of rows) {
        const out = repo.reconcileGarminStrength(r.id);
        if (out?.session) sessions.push(out.session);
      }
      if (rows.length) {
        const { enqueueEnrich } = await import("./enrich.js");
        for (const r of rows) enqueueEnrich("garmin_strength", r.id);
      }
      return asText({ ok: true, reconciled: rows.length, sessions });
    });

  server.tool("get_recovery",
    "Unified recovery view: Garmin + Apple/other daily metrics merged into one sleep / HRV / resting-HR / steps picture over the window, plus acute training load / training readiness / fitness age when present. Also returns acute-vs-chronic baselines: recent (last 7d avg), baseline (30d avg) and delta (recent − baseline) for sleep/hrv/rhr — compare against the athlete's OWN norm, not a population. Graceful (has_data:false) when empty. Use as context, not plan authority.",
    { days: z.number().int().optional() },
    async ({ days }) => asText(repo.getRecoverySummary(days ?? 14)));

  server.tool("add_memory",
    "Add a durable note Cairn should remember (preference, constraint, insight, observation).",
    { content: z.string(), kind: z.string().optional(), source: z.string().optional() },
    async (m) => asText(repo.addMemory(m.content, m.kind, m.source ?? "agent")));

  server.tool("list_memory",
    "List accumulated memory notes (most recent first, superseded rows hidden). Set include_superseded for the full history.",
    { limit: z.number().int().optional(), include_superseded: z.boolean().optional() },
    async ({ limit, include_superseded }) => asText(repo.listMemory(limit ?? 50, { includeSuperseded: include_superseded })));

  server.tool("update_memory",
    "Edit an existing memory note's content/kind/confidence by id. Use when a remembered fact CHANGED and should be corrected in place.",
    { id: z.number().int(), content: z.string().optional(), kind: z.string().optional(), confidence: z.number().optional() },
    async ({ id, content, kind, confidence }) => asText(repo.updateMemory(id, { content, kind, confidence }) ?? { error: "not found", id }));

  server.tool("supersede_memory",
    "Mark a memory note superseded (it CONTRADICTS/REPLACES an older one). Never hard-deletes — the old fact stays in history. Optionally supply a replacement content (a new row is created) or replacement_id.",
    { id: z.number().int(), replacement: z.string().optional(), kind: z.string().optional(), replacement_id: z.number().int().optional(), reason: z.string().optional() },
    async ({ id, replacement, kind, replacement_id, reason }) =>
      asText(repo.supersedeMemory(id, { content: replacement, kind, replacementId: replacement_id, reason }) ?? { error: "not found", id }));

  server.tool("delete_memory",
    "Delete a memory note by id.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteMemory(id)));

  server.tool("consolidate_memory",
    "Quietly tidy the memory store: merge near-duplicates, supersede contradictions, promote recurring observations to durable traits. Marks, never hard-deletes. Returns the counts.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await consolidateMemory(agent)));

  server.tool("grow_about_me",
    "Grow profile.about_me into a coherent person-model from typed memory + family + check-ins. Augments existing (user-authored) content, never overwrites blindly. changed:false is the common answer.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await growAboutMe(agent)));

  server.tool("list_suggestions",
    "List recorded suggestions (Brief / session-suggest / nutrition check-in) and their reconciled outcomes — the outcome-learning audit trail.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listSuggestions(limit ?? 50)));

  server.tool("reconcile_outcomes",
    "Compare past suggestions to what actually happened (logged sets, weight trend, autoregulation) and write durable learning memories. Deterministic, no agent. Returns the counts.",
    { max: z.number().int().optional() },
    async ({ max }) => asText(reconcileOutcomes({ maxPerPass: max })));

  server.tool("draft_meal_plan",
    "Run an agent to draft a goal-aware weekly meal plan (lean-safe deficit, protein target), then a bounded self-critique verify pass against the lean-safe/longevity floors before saving. The saved plan is the verified draft; `verified:{checked,adjustments}` shows it was checked against your protein/fiber/kcal floors. Verify fails open (no agent ⇒ ships unverified).",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"), instruction: z.string().optional() },
    async ({ agent, instruction }) => asText(await draftMealPlan(agent, instruction)));

  // ---- adaptive nutrition (T3) ----
  server.tool("get_expenditure",
    "Derived real daily energy expenditure (TDEE), MacroFactor-style and adherence-neutral: avg logged intake minus the recency-weighted bodyweight trend. Returns { tdee, confidence:'none'|'low'|'medium'|'high', points, window_days, intake_avg_kcal, trend_lb_wk, projected_goal_date, projection_text }. projection_text is a PLAIN-LANGUAGE goal-pace forecast off the measured weigh-in trend ('at this trend, ~Aug 20 — about 3 weeks past your date'); never a score. Null tdee / 'none' confidence when there's too little data; confidence is lowered during a travel/illness window. window defaults to 21 days.",
    { window: z.number().int().optional().describe("days to derive over (default 21)") },
    async ({ window }) => asText(repo.estimateExpenditure(window ?? 21)));

  server.tool("nutrition_checkin",
    "Quiet adaptive-nutrition check-in: when the derived expenditure has drifted meaningfully off the goal, an agent drafts a calorie/macro target CHANGE as a DRAFT proposal to review (never auto-applied). Adherence-neutral — a thin logging week only lowers confidence, never cuts the target. Most weeks nothing has moved (returns change:false, no proposal). ok:false is the designed failure signal.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"), window: z.number().int().optional().describe("days to derive expenditure over (default 21)") },
    async ({ agent, window }) => asText(await nutritionCheckin(agent, window)));

  // ---- settings: agent rotation + auto-coach schedule ----
  server.tool("get_settings",
    "Get app settings: agent selection strategy (round_robin/random/priority), agent order, disabled agents, the weekly auto-coach schedule, and Garmin sync status (garmin_last_sync_at/garmin_last_sync_status). Includes the merged agent list.",
    {},
    async () => asText({ settings: repo.getSettings(), agents: repo.getAgentConfig() }));

  server.tool("set_settings",
    "Update app settings (any subset). agent_strategy: round_robin|random|priority. agent_order / disabled_agents: arrays of agent names. agent_routes: optional per-task agent map pinning a task to one agent. coach_enabled/coach_day(0-6)/coach_hour(0-23) control the weekly auto-draft.",
    {
      agent_strategy: z.enum(["round_robin", "random", "priority"]).optional(),
      agent_order: z.array(z.string()).optional(),
      disabled_agents: z.array(z.string()).optional(),
      agent_routes: z.record(z.string(), z.string()).optional().describe("optional per-task agent routing: a map { task -> agent } pinning a specific agent for a task (chat, meal_plan, meal_swap, recipe, session_suggest, nutrition_checkin, health_review, insight, weekly_read, day_read). Unknown tasks or unknown/disabled agents are dropped; {} or omitted = no routing (Auto rotates as before)."),
      coach_enabled: z.boolean().optional(),
      coach_day: z.number().int().optional(),
      coach_hour: z.number().int().optional(),
      enrich_enabled: z.boolean().optional(),
      proactive_enabled: z.boolean().optional().describe("quiet proactivity on/off: nightly insight + weekly read + weekly nutrition check-in precompute (pull-never-push — only stores a waiting read, never notifies)"),
      art_enabled: z.boolean().optional().describe("generated artwork on/off (needs a Gemini key to do anything)"),
      meal_prefs: z.string().optional().describe("free-text meal/schedule preferences the meal-plan coach always sees (e.g. 'I train fasted first thing most mornings')"),
      gemini_api_key: z.string().optional().describe("optional saved Gemini key; overrides GOOGLE_AI_KEY/GEMINI_API_KEY when non-empty"),
      garmin_username: z.string().optional().describe("optional saved Garmin email; overrides GARMIN_USERNAME when non-empty"),
      garmin_password: z.string().optional().describe("optional saved Garmin password; overrides GARMIN_PASSWORD when non-empty"),
      clear_gemini_api_key: z.boolean().optional().describe("clear the saved Gemini key; env fallback still applies"),
      clear_garmin_password: z.boolean().optional().describe("clear the saved Garmin password; env fallback still applies"),
      research_enabled: z.boolean().optional().describe("host-side evidence research on/off (default OFF; off ⇒ deterministic, no network — used to ground & verify health-review citations)"),
      bg_ops_enabled: z.boolean().optional().describe("run the heavy agentic ops (session-suggest, meal plan/swap/recipe, nutrition check-in, insight, health review) as durable background jobs (default on); off ⇒ legacy inline blocking behavior"),
    },
    async (p) => asText({ settings: repo.setSettings(p), agents: repo.getAgentConfig() }));

  server.tool("get_art_stats",
    "Get generated-artwork spend telemetry: estimated Gemini cost (USD) since artwork was last enabled plus all-time, images generated, generations avoided via semantic reuse (and the estimated savings), and cache size.",
    {},
    async () => asText(repo.getArtStats()));

  server.tool("get_agent_stats",
    "Get agent-run telemetry for the coaching loop: total runs, overall ok-rate, per-agent reliability (ok/fail) + median latency, and the most recent attempts. An operator/health view of which CLI backends are working — NOT a user-facing score. Optional recent (last N attempts, default 25) and days (window the roll-up).",
    { recent: z.number().int().optional(), days: z.number().int().optional() },
    async ({ recent, days }) => asText(repo.getAgentStats({ recent, days })));

  server.tool("list_meal_plans", "List recent meal plans.", { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listMealPlans(limit ?? 10)));

  server.tool("get_meal_plan", "Get one meal plan by id (hydrated: parsed days/meals/macros).",
    { id: z.number().int() },
    async ({ id }) => asText(repo.getMealPlan(id) ?? { error: "not found", id }));

  server.tool("set_meal_plan_status",
    "Accept or discard a drafted meal plan.",
    { id: z.number().int(), status: z.enum(["accepted", "discarded"]) },
    async ({ id, status }) => asText(repo.setMealPlanStatus(id, status)));

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
      const plan = repo.getMealPlan(id);
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
      const plan = repo.getMealPlan(plan_id);
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
    async ({ id, days }) => asText(repo.updateMealPlanDays(id, days) ?? { error: "not found", id }));

  server.tool("log_food_note",
    "Record a meal estimate (e.g. after looking at a plate photo): meal type, description, optional macros.",
    {
      meal: z.string(), raw: z.string().optional(),
      parsed: z.any().optional(), image_path: z.string().optional(),
    },
    async (f) => asText(repo.addFoodNote(f.meal, f.raw ?? "", f.parsed ?? null, f.image_path)));

  server.tool("list_food_notes", "List recent logged food notes (meal type, description, parsed macros, enrichment status).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listFoodNotes(limit ?? 20)));

  server.tool("delete_food_note", "Delete a logged food note by id.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteFoodNote(id)));

  server.tool("get_chat_history",
    "Read the live coaching chat log (the PWA's Chat tab; archived turns excluded) — useful context on what the athlete has recently asked or been told.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listChatMessages(limit ?? 50)));

  server.tool("list_chat_sessions",
    "List past (archived) coaching conversations, newest first — each is a thread a 'fresh start' archived, with its message count, time span, and a one-line preview. Browse history without deleting anything.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listArchivedSessions(limit ?? 50)));

  server.tool("get_chat_session",
    "Read one archived conversation in full (chronological), keyed by its archived_at timestamp from list_chat_sessions.",
    { archived_at: z.string().describe("the archived_at value from list_chat_sessions") },
    async ({ archived_at }) => asText(repo.getArchivedConversation(archived_at)));

  server.tool("search_chat",
    "Keyword-search the whole coaching history (live + archived turns). Returns matches with a snippet and the session they belong to (archived_at, or null for the live thread).",
    { q: z.string(), limit: z.number().int().optional() },
    async ({ q, limit }) => asText(repo.searchChatMessages(q, limit ?? 40)));

  server.tool("reset_chat",
    "Start a fresh coaching conversation: distill durable facts (preferences, constraints, decisions) from the live chat into memory via one agent call, then archive every current message. Never deletes — archived turns stay in the DB and exports. Archiving never blocks on the agent; on agent failure the chat is still reset with distilled=0.",
    { agent: z.string().optional().describe("agent name, or omit/'auto' for the configured rotation") },
    async ({ agent }) => {
      const history = repo.listChatMessages(200);
      if (!history.length) return asText({ ok: true, distilled: 0, archived: 0 });
      // MCP is a synchronous request/response surface (a job id is useless to a
      // one-shot call), so it distills INLINE via the shared helper, then archives.
      const r = await distillChat(agent, history.map((m: any) => ({ role: m.role, content: m.content })));
      const { archived } = repo.archiveChat();
      return asText({ ok: true, distilled: r.distilled, archived, ...(r.note ? { note: r.note } : {}) });
    });

  server.tool(
    "get_volume",
    "Training volume (tonnage) broken down by muscle group over the last N days (default 30).",
    { days: z.number().int().optional().describe("Number of days to look back (default 30)") },
    async ({ days }) => asText(repo.getVolumeByMuscle(days ?? 30))
  );

  server.tool(
    "get_calendar",
    "Day-by-day training calendar/heatmap data (lifted, tonnage, activity, intensity level) for the last N days (default 84).",
    { days: z.number().int().optional().describe("Number of days to include (default 84)") },
    async ({ days }) => asText(repo.getTrainingCalendar(days ?? 84))
  );

  server.tool(
    "get_session",
    "Get the logged session for a specific date (YYYY-MM-DD), with its sets and any skipped exercises.",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) => asText(repo.getSessionByDate(date))
  );

  // ---- T1: day intelligence (read the day, suggest a session) ----
  server.tool(
    "get_day_read",
    "Read what KIND of day today should be — train, easy, or rest — as a calm SUGGESTION (never a verdict, never a score). Synthesizes recent training, recovery, check-ins and life context. The agentic read writes the human sentence; if no agent is reachable it falls back to a deterministic floor. override reshapes the read ('rough night' / 'short on time' / 'I want to train anyway').",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      override: z.string().optional().describe("free-text steer, e.g. 'rough night', 'short on time', 'train anyway'"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ date, override, agent }) => {
      // Mirror the REST fast path: serve the cached canonical read on a hit
      // (filled nightly by the scheduler), else compute + cache via the shared
      // dayread layer. Overrides always recompute and are never cached.
      try {
        if (!override) {
          const cached = repo.getCachedDayRead(date || localToday());
          if (cached) return asText({ ...cached, cached: true, agent_status: agentStatusFor(cached) });
        }
        const r: any = await computeDayRead({ date, override, agent });
        return asText({ ...r, agent_status: agentStatusFor(r) });
      } catch (e: any) {
        const b = repo.dayRead(date);
        const headline = b.kind === "rest" ? "Rest today." : b.kind === "easy" ? "Take it easy." : b.focus ? `${b.focus}.` : "Good to train.";
        return asText({ ...b, headline, source: "deterministic", error: e.message });
      }
    }
  );

  server.tool(
    "suggest_session",
    "Build ONE session for today on demand, honoring constraints (time budget, equipment, focus, an injury) and the day read. Returns a SUGGESTION for review — it is NOT saved or applied as the plan. ok:false is the designed failure signal when the agent returns nothing usable.",
    {
      minutes: z.number().int().optional().describe("time budget in minutes (compresses the session)"),
      equipment: z.string().optional().describe("equipment available, e.g. 'dumbbells only' / 'hotel gym'"),
      focus: z.string().optional().describe("muscle/quality focus, e.g. 'lower body'"),
      constraints: z.string().optional().describe("anything to work around, e.g. 'sore left shoulder'"),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ minutes, equipment, focus, constraints, date, agent }) =>
      asText(await suggestSession(agent, { minutes, equipment, focus, constraints, date }))
  );

  server.tool(
    "get_week_ahead",
    "Sketch the SHAPE of the next several days — lift / run / mixed / rest — as a calm SUGGESTION to reshape, never a fixed schedule. Balances the lifting split with easy aerobic base work, honoring injuries, recovery and training health-directives. Agentic with a deterministic plan-rotation floor, so it always returns a usable shape; cached per day+plan+goal.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await weekAheadRead(agent))
  );

  server.tool(
    "skip_exercise",
    "Mark a planned exercise consciously skipped ('not today') for a date's session — it stops counting against that day's plan. Refuses (ok:false) when the exercise already has logged sets that session.",
    {
      exercise: z.string(),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
    },
    async ({ exercise, date }) => asText(repo.skipExercise(exercise, date))
  );

  server.tool(
    "unskip_exercise",
    "Restore a previously skipped exercise to a date's session plan.",
    {
      exercise: z.string(),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
    },
    async ({ exercise, date }) => asText(repo.unskipExercise(exercise, date))
  );

  server.tool(
    "get_last_set",
    "Get the most recent logged set for an exercise (for prefill).",
    { exercise: z.string() },
    async ({ exercise }) => asText(repo.getLastSet(exercise))
  );

  server.tool(
    "set_session_feedback",
    "Record optional per-session autoregulation feedback for a date (creates that date's session if needed): soreness 1-5, performance 1-5 (how the session felt vs expected), and a free-text joint_pain area (e.g. 'left knee'). The coach reads these to pull volume/load back when sore or under-performing and to de-load/swap movements that load a painful joint. Omit any field to leave it unchanged.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      soreness: z.number().int().min(1).max(5).nullable().optional(),
      performance: z.number().int().min(1).max(5).nullable().optional(),
      joint_pain: z.string().nullable().optional(),
    },
    async ({ date, soreness, performance, joint_pain }) =>
      asText(repo.setSessionFeedback(date, { soreness, performance, joint_pain }))
  );

  // ---- context events (life timeline the coach plans around) ----
  server.tool(
    "add_context_event",
    "Record a life-timeline event the coach should plan around: a trip (training disruption), an injury (deload/swap affected movements), a life_event (high stress / poor sleep / illness → reduce volume), or a family_event (a family/kids commitment like 'Tue 17:00 soccer' → keep that day shorter / more flexible). meta is kind-specific: trip {location}, injury {area, severity}, life_event {impact}, family_event {member, recurrence}.",
    {
      kind: z.enum(["trip", "injury", "life_event", "family_event"]),
      title: z.string(),
      detail: z.string().nullable().optional(),
      start_date: z.string().nullable().optional().describe("YYYY-MM-DD"),
      end_date: z.string().nullable().optional().describe("YYYY-MM-DD; null/omit = ongoing/open-ended"),
      meta: z.any().optional().describe("kind-specific: trip {location}, injury {area,severity}, life_event {impact}, family_event {member,recurrence}"),
    },
    async (a) => asText(repo.addContextEvent(a))
  );

  server.tool(
    "list_context_events",
    "List life-timeline events. Pass active=true for only active/upcoming (not archived and not past their end_date).",
    { active: z.boolean().optional() },
    async ({ active }) => asText(repo.listContextEvents({ activeOnly: !!active }))
  );

  server.tool(
    "update_context_event",
    "Update a life-timeline event by id (any subset of fields). Set archived=true to retire it.",
    {
      id: z.number().int(),
      kind: z.enum(["trip", "injury", "life_event", "family_event"]).optional(),
      title: z.string().optional(),
      detail: z.string().nullable().optional(),
      start_date: z.string().nullable().optional(),
      end_date: z.string().nullable().optional(),
      meta: z.any().optional(),
      archived: z.boolean().optional(),
    },
    async ({ id, ...patch }) => asText(repo.updateContextEvent(id, patch) ?? { error: "not found", id })
  );

  server.tool(
    "delete_context_event",
    "Delete a life-timeline event by id.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteContextEvent(id))
  );

  server.tool(
    "get_injury_impacts",
    "For each ACTIVE injury on the life timeline, the planned exercises it loads (with where they appear in the plan + any existing constraint note) and a few safe alternative exercises to consider. Deterministic, offline. Suggestions only — it never changes the plan.",
    {},
    async () => asText(repo.getInjuryImpacts())
  );

  // ---- family roster (people the coach plans life around) ----
  server.tool(
    "list_family",
    "List the household roster (kids, partner, etc.) the coach plans life around. Their recurring commitments live as context_events with kind:'family_event'.",
    {},
    async () => asText(repo.listFamily())
  );

  server.tool(
    "add_family",
    "Add a family member to the roster. relationship is e.g. son / daughter / partner / parent; color is an optional swatch; birthdate is optional YYYY-MM-DD; notes is free-text. allergies are a HARD exclusion in any shared/household meal; dietary_restrictions surface as optional kid-friendly / shared-meal mods.",
    {
      name: z.string(),
      color: z.string().nullable().optional(),
      relationship: z.string().nullable().optional(),
      birthdate: z.string().nullable().optional().describe("YYYY-MM-DD"),
      notes: z.string().nullable().optional(),
      allergies: z.string().nullable().optional(),
      dietary_restrictions: z.string().nullable().optional(),
    },
    async (a) => asText(repo.addFamily(a))
  );

  server.tool(
    "update_family",
    "Update a family member by id (any subset of fields). allergies are a HARD exclusion in shared meals; dietary_restrictions surface as optional household mods.",
    {
      id: z.number().int(),
      name: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      relationship: z.string().nullable().optional(),
      birthdate: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      allergies: z.string().nullable().optional(),
      dietary_restrictions: z.string().nullable().optional(),
    },
    async ({ id, ...patch }) => asText(repo.updateFamily(id, patch) ?? { error: "not found", id })
  );

  server.tool(
    "delete_family",
    "Delete a family member by id.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteFamily(id))
  );

  // ---- supplements (UNDERSTANDING, not a daily log) ----
  server.tool(
    "list_supplements",
    "List the athlete's understood supplement regimen (canonical name, approximate dose, cadence, the markers/domains each touches). Not a daily log. all=true includes stopped ones.",
    { all: z.boolean().optional() },
    async ({ all }) => asText(repo.listSupplements({ activeOnly: !all }))
  );
  server.tool(
    "understand_supplements",
    "Capture supplements from plain words ('creatine daily, omega-3, some D, whey occasionally') — the system approximates each into name + typical dose + cadence + related markers and stores it (dedup by name). NOT a daily log; say it once. Returns the understood items.",
    { text: z.string().describe("free-text mention of what they take") },
    async ({ text }) => asText(repo.understandSupplements(text))
  );
  server.tool(
    "update_supplement",
    "Edit one understood supplement (dose, frequency, note), or set active=false to mark it stopped (kept for history).",
    { id: z.number().int(), dose: z.string().optional(), frequency: z.string().optional(), note: z.string().optional(), active: z.boolean().optional() },
    async (args) => asText(repo.updateSupplement(args.id, args) ?? { error: "not found", id: args.id })
  );
  server.tool(
    "delete_supplement",
    "Remove one supplement from the regimen by id.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteSupplement(id))
  );
  server.tool(
    "onboard",
    "Frictionless first-run setup from ONE free-text intro ('41, training for longevity, lift 4x/week, bad left shoulder, train fasted, take creatine daily + omega-3'). Understands + applies profile/about-me/supplements/injuries/memories in one pass, then marks onboarded. Never interrogates; degrades to a deterministic base with no agent.",
    { text: z.string().describe("the athlete's short free-text intro"), agent: z.string().optional() },
    async ({ text, agent }) => asText(await onboardFromText(agent, text)),
  );

  // ---- health records (analyses; vision happens in the Claude client) ----
  server.tool(
    "list_health_records",
    "List recent health documents (bloodwork / DEXA / other) with their kind, test date, summary, key markers and analysis status. Does not include the binary file.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listHealthDocuments(limit ?? 50))
  );

  server.tool(
    "add_health_record",
    "Record a health-document ANALYSIS without uploading a binary (e.g. after reading a lab report image in a Claude client). Stores extracted markers + summary directly; status is 'done'.",
    {
      kind: z.enum(["bloodwork", "dexa", "other"]),
      doc_date: z.string().nullable().optional().describe("the test date, YYYY-MM-DD"),
      summary: z.string().describe("plain-language summary, 1-3 sentences"),
      parsed: z.any().optional().describe("structured markers, e.g. { markers: [{name,value,unit,flag}], type }"),
    },
    async (a) =>
      asText(
        repo.addHealthDocument({
          kind: a.kind,
          doc_date: a.doc_date ?? null,
          summary: a.summary,
          parsed_json: a.parsed ?? null,
          enrichment_status: "done",
        })
      )
  );

  server.tool(
    "delete_health_record",
    "Delete a health document by id.",
    { id: z.number().int() },
    async ({ id }) => asText(repo.deleteHealthDocument(id))
  );

  // ---- health insights (marker history + whole-picture agentic review) ----
  server.tool(
    "get_health_markers",
    "Marker history aggregated across every uploaded health document: per marker the latest value/flag, the previous reading, a numeric time series, and a trend ({dir: rising|falling|stable, change, span_days, n}) so you can speak to direction over time, not just the latest value. Each marker also carries its health group (group/group_label — e.g. Lipids & Cardiovascular, Metabolic & Glucose), and the top-level `groups` list gives the canonical-ordered groups present. Flagged (low/high) markers sort first.",
    {},
    async () => asText(repo.getMarkerHistory())
  );

  server.tool(
    "get_health_review",
    "Get the latest whole-picture health review (headline, wins, watchlist, focus areas, follow-ups, training/nutrition impact) — or null when none has been run yet.",
    {},
    async () => asText(repo.getLatestHealthReview())
  );

  server.tool(
    "run_health_review",
    "Run a coaching agent over the athlete's full context plus aggregated marker history to produce a fresh whole-picture health review (informational, not medical advice). Returns ok:false when the agent's output is unusable.",
    { agent: z.string().optional().describe("omit or 'auto' to use the configured rotation") },
    async ({ agent }) => asText(await runHealthReview(agent))
  );

  // ---- the connected brain: priority markers + propagation directives (T4) ----
  server.tool(
    "get_priority_markers",
    "Markers re-ranked by impact: distance from the OPTIMAL zone (not just the lab's normal range), most-actionable first, flagged (low/high) markers always on top, and a marker HEADING out of optimal ranked above a stably-borderline one. Each marker carries optimal/distance/in_optimal/actionable, its health group (group/group_label), a least-squares trend ({dir: rising|falling|stable, change, span_days, n, slope_per_week, projection}) and a forecast ({direction: improving|worsening|stable, eta_text, crossing}) — eta_text is a PLAIN-LANGUAGE projection vs optimal ('trending toward optimal, roughly 6 weeks out'); never a score. The top-level `groups` lists the canonical-ordered groups present. Informational, not medical advice — the internal impact_score is an ordering signal only, never a user-facing grade.",
    {},
    async () => asText(repo.prioritizeMarkers())
  );

  server.tool(
    "get_health_export",
    "Structured, FHIR-inspired health summary: a portable read-only slice of the athlete's markers/observations over time (latest value + unit + effective date + full history[], the OPTIMAL reference band — distinct from the lab's normal range — an optimal-zone status like within-optimal/above-optimal, and the deterministic trend), plus the understood supplement regimen and active connected-brain directives, under a self-describing meta header (exportVersion, generated, subject). Something to hand a physician or another tool. INFORMATIONAL, not medical advice — no 0-100 scores anywhere.",
    {},
    async () => asText(repo.buildHealthExport())
  );

  server.tool(
    "list_directives",
    "List the connected-brain cross-domain health directives (a flagged finding propagated into nutrition/training/watch, with rationale, an evidence citation where well-established, and an `uncertain` flag where the lever is real but unsettled). Active by default; pass all:true for the full history incl. resolved/dismissed feedback rows.",
    { all: z.boolean().optional() },
    async ({ all }) => asText(repo.listDirectives({ all: !!all }))
  );

  server.tool(
    "update_directive",
    "Flip a directive's status (the review side of propose-review-apply — nothing auto-applies). `resolved` means handled for that marker snapshot; `dismissed` suppresses equivalent future advice until the marker materially changes. Returns the updated directive, or null when the id is unknown.",
    { id: z.number().int(), status: z.enum(["active", "resolved", "dismissed"]) },
    async ({ id, status }) => asText(repo.updateDirective(id, { status }))
  );

  server.tool(
    "derive_directives",
    "Re-run the deterministic propagation engine over the latest markers: clears the 'markers' directive source and re-derives evidence-based nutrition/training/watch directives for every out-of-optimal marker, while honoring prior Done/Dismiss feedback. Idempotent; leaves agent-emitted 'health_review' directives untouched.",
    {},
    async () => asText(repo.deriveDirectives())
  );

  server.tool(
    "research",
    "Host-side research & grounding (Stream 4). Runs a cited, web-grounded evidence pass for ONE health/longevity question and caches the sourced claims (each claim must carry a real http(s) source URL — sourceless claims are discarded). Gated by settings.research_enabled: when OFF this serves only already-cached evidence and returns ok:false, never reaching the network. The cached evidence grounds the health review and verifies its citations. INFORMATIONAL, not medical advice.",
    {
      question: z.string().describe("the health/longevity question to ground"),
      markers: z.array(z.string()).optional().describe("relevant marker names, e.g. ['ApoB']"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
      force: z.boolean().optional().describe("re-research even when cached evidence exists for this topic"),
    },
    async ({ question, markers, agent, force }) => asText(await runResearch(question, { markers, agent, force }))
  );

  server.tool(
    "get_evidence",
    "Make a directive's citation INSPECTABLE: returns the cited evidence behind ONE marker as { marker, evidence:[{claim, source_title, source_url, body, confidence, retrieved_at}] }. Reads the evidence cache only (never the network), so it works with research disabled; evidence:[] when research never ran for that marker. INFORMATIONAL, not medical advice.",
    { marker: z.string().optional().describe("the marker name, e.g. 'ApoB' (omit for the most-recent cached evidence overall)"), limit: z.number().int().optional() },
    async ({ marker, limit }) => asText(repo.getEvidenceForMarker(marker, limit))
  );

  server.tool(
    "get_evidence_summary",
    "Make the evidence cache DISCOVERABLE without an N-fetch fan-out: returns { research_enabled, total, by_marker:[{marker, count}] } — the per-marker count of cited rows on file, so a UI can show a 'see the evidence (N)' hint and know up-front where evidence exists. Reads the cache only (never the network). INFORMATIONAL, not medical advice.",
    {},
    async () => asText(repo.evidenceSummary())
  );

  server.tool(
    "get_outcome_learnings",
    "The quiet 'What Cairn has noticed' read: durable, plain-language learnings drawn from suggestion → actual reconciliation (e.g. 'tolerates higher training frequency than the read assumed'). Returns { learnings:[{id, content, noticed_at}] }, newest-first. These season the coach's defaults — never a score, never a gate; pull-never-push.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.getOutcomeLearnings(limit))
  );

  // ---- T5: effortless capture (frequents, optional check-in, Apple Health) ----
  server.tool("get_frequent_foods",
    "The foods most often logged near a time of day (±2h), most-frequent first (max 8), with macros carried from the latest occurrence when known. Powers one-tap re-log of the usual foods for this time. Pass `hour` (0-23) to target a specific time; omit to use the server clock.",
    { hour: z.number().int().min(0).max(23).optional() },
    async ({ hour }) => asText(repo.frequentFoods(hour)));

  server.tool("add_checkin",
    "Record an optional morning check-in (a day-read signal — offered, never required). All fields optional; mood/energy/sleep_feel/soreness are 1-5 (clamped). Several per day are allowed; the latest wins for reads.",
    {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      mood: z.number().optional(), energy: z.number().optional(),
      sleep_feel: z.number().optional(), soreness: z.number().optional(),
      note: z.string().optional(),
    },
    async ({ date, ...fields }) => asText(repo.addCheckin(date ?? "", fields)));

  server.tool("get_checkin",
    "Get the latest check-in for a date (or null if none).",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) => asText(repo.getCheckinByDate(date)));

  server.tool("list_checkins", "List recent check-ins (newest first).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listCheckins(limit ?? 14)));

  server.tool("record_daily_metrics",
    "Upsert one source's daily steps/sleep/recovery metrics for a date (idempotent on source+date) — the Apple Health via Shortcuts path. `source` defaults to 'apple'. All metric fields optional; `raw` keeps the source payload verbatim.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      source: z.string().optional().describe("default 'apple'"),
      steps: z.number().nullable().optional(),
      sleep_min: z.number().nullable().optional(),
      sleep_score: z.number().nullable().optional(),
      resting_hr: z.number().nullable().optional(),
      hrv_ms: z.number().nullable().optional(),
      active_calories: z.number().nullable().optional(),
      raw: z.any().optional(),
    },
    async ({ date, source, ...metrics }) => asText(repo.recordDailyMetrics(source ?? "apple", date, metrics)));

  server.tool("get_daily_metrics",
    "Recent daily metric rows for a source (default all sources) over the last N days (default 30).",
    { source: z.string().optional(), days: z.number().int().optional() },
    async ({ source, days }) => asText(repo.getDailyMetrics(source ?? null, days ?? 30)));

  // ---- quiet cross-domain insights (Phase 6: pull-based, never pushed) ----
  server.tool(
    "list_insights",
    "List the live stream of quiet cross-domain insights (new + seen, most recent first). The Brief surfaces ONE at a time when the app is opened; dismissed insights are hidden here but remain in the DB/exports. Never pushed.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(repo.listVisibleInsights(limit ?? 20))
  );

  server.tool(
    "generate_insight",
    "Run ONE agentic pass over the athlete's whole picture for a single genuine cross-domain connection (or a weekly read), dedupe against what's already been said, and store it. Returns ok:false when there's nothing real to say (found:false / duplicate / unusable shape). NO notification fires — the insight simply waits in-app. Informational, not medical advice.",
    {
      kind: z.enum(["connection", "weekly_read"]).optional().describe("'connection' (default) = one cross-domain link; 'weekly_read' = the standing how-the-week-went read"),
      agent: z.string().optional().describe("omit or 'auto' to use the configured rotation"),
    },
    async ({ kind, agent }) => asText(await generateInsight(agent, kind))
  );

  server.tool(
    "update_insight",
    "Mark an insight seen/dismissed and/or record thumbs feedback (up|down) by id. On feedback:'up' the insight text is ALSO written to memory so the relationship learns which connections land.",
    {
      id: z.number().int(),
      status: z.enum(["new", "seen", "dismissed"]).optional(),
      feedback: z.enum(["up", "down"]).optional(),
    },
    async ({ id, status, feedback }) => {
      const updated = repo.updateInsight(id, { status, feedback }) as any;
      if (!updated) return asText({ error: "not found", id });
      if (feedback === "up") {
        const text = String(updated.text ?? "").trim();
        if (text) repo.addMemory(text, "insight", "insight-feedback");
      }
      return asText(updated);
    }
  );

  return server;
}

// Stateless Streamable HTTP handler: fresh server+transport per request.
export async function handleMcpPost(req: Request, res: Response) {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (_err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

export function methodNotAllowed(_req: Request, res: Response) {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}
