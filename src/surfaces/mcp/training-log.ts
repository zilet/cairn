import { z } from "zod";
import {
  addActivity,
  deleteSet,
  finishSession,
  getLastSet,
  getProgress,
  getStrengthJourney,
  getRecentSessions,
  getSessionByDate,
  getSessionDetail,
  getTrainingCalendar,
  getVolumeByMuscle,
  listActivities,
  logSetByName,
  recentTraining,
  resolveImplicitPlanDay,
  reopenSession,
  sessionHighlights,
  setSessionFeedback,
  setStrengthObjective,
  skipExercise,
  unskipExercise,
  updateSessionNotes,
  updateSet,
  weekWins,
} from "../../domain/training/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerTrainingLogTools(server: McpToolRegistrar) {
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
    async (args) => asText(logSetByName(resolveImplicitPlanDay(args)))
  );

  server.tool(
    "get_progress",
    "Get logged history and estimated-1RM trend (Epley) for one exercise over time.",
    { exercise: z.string() },
    async ({ exercise }) => asText(getProgress(exercise))
  );

  server.tool(
    "get_strength_journey",
    "Read the athlete-selected anchor-lift comeback journey: exact-lift history, current/best/baseline/gap/trend, safe next prescription, support roles, and a conditional wide projection. Read-only; never selects a goal.",
    {},
    async () => asText(getStrengthJourney())
  );

  server.tool(
    "set_strength_objective",
    "Set one athlete-explicit anchor-lift objective. Supersedes the prior active objective and snapshots either the exact exercise's current personal best or an explicit estimated-1RM target.",
    {
      exercise: z.string().min(1),
      target_kind: z.enum(["return_to_personal_best", "explicit_est_1rm"]),
      target_est_1rm: z.number().positive().max(5000).optional(),
    },
    async (input) => {
      const objective = setStrengthObjective(input);
      return asText({ objective, journey: getStrengthJourney() });
    }
  );

  server.tool(
    "recent_sessions",
    "List recent logged sessions, each with all its sets.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(getRecentSessions(limit ?? 10))
  );

  server.tool(
    "get_session_detail",
    "Get one logged session by its id, with all its sets.",
    { id: z.number().int() },
    async ({ id }) => asText(getSessionDetail(id) ?? { error: "not found", id })
  );

  server.tool(
    "get_recent_training",
    "The unified 'Lately' feed: finished strength sessions and cardio activities merged newest-first, each with a real timestamp (Garmin) and body-reaction detail (HR zones, temperature, effort, VO2) when available.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(recentTraining(limit ?? 6))
  );

  server.tool(
    "finish_session",
    "Mark a session finished (optionally attaching notes) and return its summary (sets, tonnage, PRs).",
    { id: z.number().int(), notes: z.string().nullable().optional() },
    async ({ id, notes }) => asText(finishSession(id, notes ?? null))
  );

  server.tool(
    "delete_set",
    "Delete one logged set by id (e.g. a mis-entry).",
    { id: z.number().int() },
    async ({ id }) => asText(deleteSet(id))
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
      const row = updateSet(id, fields);
      return asText(row ?? { error: "not found", id });
    }
  );

  server.tool(
    "reopen_session",
    "Reopen a finished session to keep logging (clears its finished stamp).",
    { id: z.number().int() },
    async ({ id }) => asText(reopenSession(id) ?? { error: "not found", id })
  );

  server.tool(
    "update_session_notes",
    "Edit a session's notes after the fact (history correction).",
    { id: z.number().int(), notes: z.string().nullable() },
    async ({ id, notes }) => asText(updateSessionNotes(id, notes ?? null) ?? { error: "not found", id })
  );

  server.tool(
    "log_activity",
    "Log a cardio/other session. Pass free text (e.g. 'ran 50 min @5:30/km') and/or structured fields.",
    {
      text: z.string().optional(),
      type: z.string().optional(),
      duration_min: z.number().optional(),
      distance_km: z.number().optional(),
      pace: z.string().optional(),
      rpe: z.number().optional(),
      date: z.string().optional(),
      notes: z.string().optional(),
    },
    async (activity) => asText(addActivity(activity))
  );

  server.tool(
    "list_activities",
    "List recent logged activities.",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listActivities(limit ?? 20))
  );

  server.tool(
    "get_volume",
    "Training volume (tonnage) broken down by muscle group over the last N days (default 30).",
    { days: z.number().int().optional().describe("Number of days to look back (default 30)") },
    async ({ days }) => asText(getVolumeByMuscle(days ?? 30))
  );

  server.tool(
    "get_calendar",
    "Day-by-day training calendar/heatmap data (lifted, tonnage, activity, intensity level) for the last N days (default 84).",
    { days: z.number().int().optional().describe("Number of days to include (default 84)") },
    async ({ days }) => asText(getTrainingCalendar(days ?? 84))
  );

  server.tool(
    "get_session",
    "Get the logged session for a specific date (YYYY-MM-DD), with its sets and any skipped exercises.",
    { date: z.string().describe("YYYY-MM-DD") },
    async ({ date }) => asText(getSessionByDate(date))
  );

  server.tool(
    "get_session_highlights",
    "Evidence of forward motion for one logged session: any PRs set (a new best est-1RM, or a longer timed hold), how each exercise compares to its previous session (delta + direction), and a small trailing-7-day rollup (new bests, days trained). Read-only and factual — never a score. An unknown session id returns null.",
    { id: z.number().int() },
    async ({ id }) => asText(sessionHighlights(id))
  );

  server.tool(
    "get_week_wins",
    "The week's motivational rollup ending on a date (default today): new bests set, days trained, hard sets, muscle groups whose volume reached its productive range, and weight-trend pace toward the goal in plain words. Read-only and factual — never a score.",
    { date: z.string().optional().describe("YYYY-MM-DD; defaults to today") },
    async ({ date }) => asText(weekWins(date))
  );

  server.tool(
    "skip_exercise",
    "Mark a planned exercise consciously skipped ('not today') for a date's session — it stops counting against that day's plan. Refuses (ok:false) when the exercise already has logged sets that session.",
    {
      exercise: z.string(),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
    },
    async ({ exercise, date }) => asText(skipExercise(exercise, date))
  );

  server.tool(
    "unskip_exercise",
    "Restore a previously skipped exercise to a date's session plan.",
    {
      exercise: z.string(),
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
    },
    async ({ exercise, date }) => asText(unskipExercise(exercise, date))
  );

  server.tool(
    "get_last_set",
    "Get the most recent logged set for an exercise (for prefill).",
    { exercise: z.string() },
    async ({ exercise }) => asText(getLastSet(exercise))
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
      asText(setSessionFeedback(date, { soreness, performance, joint_pain }))
  );
}
