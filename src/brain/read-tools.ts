import {
  asRecord,
  boundedInteger,
  cleanOptionalText,
  cleanText,
  enumValue,
  isoDate,
  type JsonValue,
} from "./contract-utils.js";
import { BRAIN_DECISION_KINDS, type BrainDecisionKind } from "./decision-contract.js";

export const COACH_READ_TOOL_NAMES = [
  "read_exercise_history",
  "read_training_window",
  "read_marker_history",
  "read_recovery_window",
  "read_nutrition_window",
  "read_body_composition_history",
  "read_life_context_window",
  "read_decision_history",
  "read_current_plan_detail",
  "read_activity_detail",
  // The reads behind chat's lean core (src/prompt/context-projection.ts CHAT_CORE_MOVED_KEYS):
  // each answers what the core no longer inlines, from the same coach-context reads the
  // full DATA block carried — so a moved block is one call away, never gone.
  "read_run_week",
  "read_health_summary",
  "read_strength_progress",
  "read_goal_progress",
  // What Today will actually serve: the day's composed session and whether it is started.
  "read_today_session",
] as const;
export type CoachReadToolName = (typeof COACH_READ_TOOL_NAMES)[number];

export interface CoachReadTool {
  name: CoachReadToolName;
  description: string;
  effect: "read";
  launches_agent: false;
  exposes_sensitive_raw_data: false;
  max_rows: number;
  max_days: number | null;
  max_response_bytes: number;
}

export const COACH_READ_TOOL_CATALOG: Readonly<Record<CoachReadToolName, CoachReadTool>> = Object.freeze({
  read_exercise_history: {
    name: "read_exercise_history",
    description:
      "Logged sets, current plan targets, and best capacity (est-1RM or longest hold) for ONE canonical exercise over a bounded date window, with per-set feedback where it was rated. Use it when the question is a single movement's trajectory — a stall, a regression, the last full-load session. It returns nothing about other exercises from the same sessions and no day-level load; read_training_window covers the whole training picture.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 200,
    max_days: 180,
    max_response_bytes: 65_536,
  },
  read_training_window: {
    name: "read_training_window",
    description:
      "A date-ordered event stream for the last N weeks: every session with its dose and feedback, every cardio activity (distance, duration, pace, average/max heart rate, the athlete's stated rpe, and its shape — interval bouts, walking, hills — when the watch recorded one), and skipped days, so consistency, volume trend, and missed work can be judged as a whole. Use it for the shape of recent training. It does not detail one exercise's sets (read_exercise_history) or the athlete's physiology (read_recovery_window).",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 500,
    max_days: 84,
    max_response_bytes: 98_304,
  },
  read_marker_history: {
    name: "read_marker_history",
    description:
      "Every recorded value of ONE lab marker in date order, plus the directives, supplements, and active medications related to it. Use it when a health question hinges on how a single marker has moved between draws. It returns only the marker named — no full-panel view — and reports found:false when the name resolves to nothing.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 100,
    max_days: null,
    max_response_bytes: 65_536,
  },
  read_recovery_window: {
    name: "read_recovery_window",
    description:
      "One row per day for the last N days: sleep, HRV, resting heart rate, stress, body battery, steps, acute load, and Garmin training status, with the source of each day named. Use it when physiology, not behavior, is the question. It carries no training or nutrition data; pair it with read_training_window or read_nutrition_window when load or fuel is part of the question.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 90,
    max_days: 90,
    max_response_bytes: 65_536,
  },
  read_nutrition_window: {
    name: "read_nutrition_window",
    description:
      "Daily logged intake for the last N days with coverage (how many of the requested days were logged at all), estimated expenditure, the nutrition targets in force, and the weight trend over the same span. Use it for fueling questions and target adjustments. A day that was not logged is reported as missing, never as low intake.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 42,
    max_days: 42,
    max_response_bytes: 65_536,
  },
  read_body_composition_history: {
    name: "read_body_composition_history",
    description:
      "Weigh-ins, tape measurements, and DEXA results as one date-ordered event list, most recent first. Use it when composition or the rate of change over months matters. It does not include the current target or intake; read_nutrition_window carries those.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 120,
    max_days: null,
    max_response_bytes: 65_536,
  },
  read_life_context_window: {
    name: "read_life_context_window",
    description:
      "Life-timeline events that overlap a date range — trips, injuries, illness, family and life events — each with its dates, expected recovery, and whether it has been resolved. Use it to explain a disrupted stretch or to check for a constraint still in force before proposing load. It does not include same-day context tags or free-text symptom reports.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 100,
    max_days: 366,
    max_response_bytes: 65_536,
  },
  read_decision_history: {
    name: "read_decision_history",
    description:
      "Prior brain decisions of one kind (day_read, session_suggestion, training_target, meal_plan, recovery_adjustment, and the other kinds in the args contract) or about one subject key, each with the expectations it set and the latest evaluation of each. Use it before repeating a call the system has already made, to see what was tried and whether it held — or, with neither kind nor subject_key, for the most recent decisions of every kind (\"what changed in my plan recently\"). It returns no raw training or health data.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 50,
    max_days: null,
    max_response_bytes: 65_536,
  },
  read_current_plan_detail: {
    name: "read_current_plan_detail",
    description:
      "The exact stored prescription for ONE training day (by day number) or ONE meal-plan day (by day name): every item with its targets and notes. Use it when the DATA snapshot summarizes a day and the full items are needed before proposing a change. It returns the plan only, never logged work or adherence, and found:false when no such day exists.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 50,
    max_days: null,
    max_response_bytes: 65_536,
  },
  read_activity_detail: {
    name: "read_activity_detail",
    description:
      "ONE run or cardio activity in full, by its activity_id (from the RECENT RUNS lines or read_training_window): every lap with its time, distance, pace, grade-adjusted pace, average/max heart rate, climb and cadence; the workout's segments (warm-up, work bouts, recoveries, walking); time in each heart-rate band; running form (ground contact, vertical oscillation/ratio, stride); power, temperature, Body Battery change, the athlete's stated effort and their own HR model's read. Use it when a question turns on how a run went inside — the reps of an interval day, a fade, a hill — not for every run. No second-by-second stream or GPS track exists. found:false when the id is not an activity.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 120,
    max_days: null,
    max_response_bytes: 65_536,
  },
  read_run_week: {
    name: "read_run_week",
    description:
      "This week's running in full: the run engine's plan for the week (each run's kind, distance, zone and note, plus its rationale), the rolling agenda of run intentions (which are done, which are open, today's adjustment and why), the stated run days and any one-week move, the resolved pace/heart-rate zones, compliance with recent prescriptions, endurance capacity and variety, the race build when a race is set, and the whole-week load across every sport. Use it for \"what's my run plan this week and why\", a moved run, or a zone question. It carries no lap detail (read_activity_detail) and no lifting prescription (read_current_plan_detail).",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 120,
    max_days: 14,
    max_response_bytes: 98_304,
  },
  read_health_summary: {
    name: "read_health_summary",
    description:
      "The connected brain's health picture: the tiered health focus (act-now and track priorities, with their markers), every active directive with its trigger reading and date, the latest health review and synthesis, the condensed lab records and imaging reports, symptom-to-lift links, directive feedback, and the supplement regimen. Use it when a question touches labs, a finding, a directive or a supplement and needs more than the core's one-line focus. For one marker's full history use read_marker_history. Informational, never medical advice.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 200,
    max_days: null,
    max_response_bytes: 98_304,
  },
  read_strength_progress: {
    name: "read_strength_progress",
    description:
      "The strength program read in full: per-lift progression signals and their reasons, the program state (per-lift trend and stalls, mesocycle position, deload evidence, weekly volume), the training block, per-group trajectory and balance, program adjustments due, logged performance and capacity benchmarks, the strength journey toward stated objectives, and a scheduled test week. Use it for how a lift or the program has been moving, a stall, a deload question or what is due to progress. For one lift's raw sets over a window use read_exercise_history.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 300,
    max_days: null,
    max_response_bytes: 98_304,
  },
  read_goal_progress: {
    name: "read_goal_progress",
    description:
      "Where the athlete stands against their goals: the weight/body journey (body-fat estimate, recomposition stage, pace and timeline, phase), the road ahead (each goal's next milestones in priority order), the trajectory and the whole-person trajectory, the next best step, and the quiet insights already surfaced. Use it for \"am I on track\", a timeline, or what to work on next. Energy targets and intake live in read_nutrition_window.",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 120,
    max_days: null,
    max_response_bytes: 65_536,
  },
  read_today_session: {
    name: "read_today_session",
    description:
      "The session Today will actually serve on one date (today when no date is given): the composed session's title, why, source (the plan's day, the athlete's own, a suggestion) and every item with its sets, reps or seconds, load and superset pairing, plus whether it is started (a set is logged). found:false when nothing is composed yet — Today then builds from the plan. Use it before building, opening or describing today's session. It is not the weekly template (read_current_plan_detail) and carries no logged sets (read_training_window).",
    effect: "read",
    launches_agent: false,
    exposes_sensitive_raw_data: false,
    max_rows: 30,
    max_days: 1,
    max_response_bytes: 32_768,
  },
});

export type ExerciseHistoryArgs = {
  exercise: string;
  start_date: string | null;
  end_date: string | null;
  limit: number;
};
export type TrainingWindowArgs = { end_date: string | null; weeks: number };
export type MarkerHistoryArgs = { marker: string; limit: number };
export type RecoveryWindowArgs = { end_date: string | null; days: number };
export type NutritionWindowArgs = { end_date: string | null; days: number };
export type BodyCompositionHistoryArgs = { limit: number };
export type LifeContextWindowArgs = { start_date: string; end_date: string };
export type DecisionHistoryArgs = { kind: BrainDecisionKind | null; subject_key: string | null; limit: number };
export type CurrentPlanDetailArgs = { scope: "training"; day_number: number } | { scope: "meal"; day: string };
export type ActivityDetailArgs = { activity_id: number };
export type TodaySessionArgs = { date: string | null };
/** The no-argument reads: each is the current picture of one domain, bounded by its own budget. */
type EmptyArgs = Record<string, never>;

export type CoachReadToolRequest =
  | { tool: "read_exercise_history"; args: ExerciseHistoryArgs }
  | { tool: "read_training_window"; args: TrainingWindowArgs }
  | { tool: "read_marker_history"; args: MarkerHistoryArgs }
  | { tool: "read_recovery_window"; args: RecoveryWindowArgs }
  | { tool: "read_nutrition_window"; args: NutritionWindowArgs }
  | { tool: "read_body_composition_history"; args: BodyCompositionHistoryArgs }
  | { tool: "read_life_context_window"; args: LifeContextWindowArgs }
  | { tool: "read_decision_history"; args: DecisionHistoryArgs }
  | { tool: "read_current_plan_detail"; args: CurrentPlanDetailArgs }
  | { tool: "read_activity_detail"; args: ActivityDetailArgs }
  | { tool: "read_run_week"; args: EmptyArgs }
  | { tool: "read_health_summary"; args: EmptyArgs }
  | { tool: "read_strength_progress"; args: EmptyArgs }
  | { tool: "read_goal_progress"; args: EmptyArgs }
  | { tool: "read_today_session"; args: TodaySessionArgs };

export interface CoachReadToolResult {
  tool: CoachReadToolName;
  data: JsonValue;
  rows_returned: number;
  truncated: boolean;
}

function optionalDate(value: unknown): string | null | undefined {
  if (value == null || value === "") return null;
  return isoDate(value) ?? undefined;
}

function dateSpanDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000) + 1;
}

export function normalizeCoachReadToolRequest(value: unknown): CoachReadToolRequest | null {
  const input = asRecord(value);
  if (!input) return null;
  const tool = enumValue(input.tool, COACH_READ_TOOL_NAMES);
  // An omitted `args` is an empty object (a native MCP call to a no-argument read sends
  // none); anything else that is not an object is refused.
  const args = input.args == null ? {} : asRecord(input.args);
  if (!tool || !args) return null;

  switch (tool) {
    case "read_exercise_history": {
      const exercise = cleanText(args.exercise, 160);
      const startDate = optionalDate(args.start_date);
      const endDate = optionalDate(args.end_date);
      const limit = args.limit == null ? 120 : boundedInteger(args.limit, 1, 200);
      if (!exercise || startDate === undefined || endDate === undefined || !limit) return null;
      if ((startDate && !endDate) || (!startDate && endDate)) return null;
      if (startDate && endDate && (startDate > endDate || dateSpanDays(startDate, endDate) > 180)) return null;
      return { tool, args: { exercise, start_date: startDate, end_date: endDate, limit } };
    }
    case "read_training_window": {
      const endDate = optionalDate(args.end_date);
      const weeks = args.weeks == null ? 6 : boundedInteger(args.weeks, 1, 12);
      return endDate !== undefined && weeks ? { tool, args: { end_date: endDate, weeks } } : null;
    }
    case "read_marker_history": {
      const marker = cleanText(args.marker, 160);
      const limit = args.limit == null ? 40 : boundedInteger(args.limit, 1, 100);
      return marker && limit ? { tool, args: { marker, limit } } : null;
    }
    case "read_recovery_window": {
      const endDate = optionalDate(args.end_date);
      const days = args.days == null ? 30 : boundedInteger(args.days, 1, 90);
      return endDate !== undefined && days ? { tool, args: { end_date: endDate, days } } : null;
    }
    case "read_nutrition_window": {
      const endDate = optionalDate(args.end_date);
      const days = args.days == null ? 21 : boundedInteger(args.days, 1, 42);
      return endDate !== undefined && days ? { tool, args: { end_date: endDate, days } } : null;
    }
    case "read_body_composition_history": {
      const limit = args.limit == null ? 80 : boundedInteger(args.limit, 1, 120);
      return limit ? { tool, args: { limit } } : null;
    }
    case "read_life_context_window": {
      const startDate = isoDate(args.start_date);
      const endDate = isoDate(args.end_date);
      if (!startDate || !endDate || startDate > endDate || dateSpanDays(startDate, endDate) > 366) return null;
      return { tool, args: { start_date: startDate, end_date: endDate } };
    }
    case "read_decision_history": {
      const kind = args.kind == null ? null : enumValue(args.kind, BRAIN_DECISION_KINDS);
      const subjectKey = cleanOptionalText(args.subject_key, 160);
      const limit = args.limit == null ? 20 : boundedInteger(args.limit, 1, 50);
      // Neither kind nor subject_key is the RECENT read: the latest decisions of any kind
      // (chat's "what changed recently" — the lean core keeps only the undoable ones).
      if ((args.kind != null && !kind) || !limit) return null;
      return { tool, args: { kind, subject_key: subjectKey, limit } };
    }
    case "read_current_plan_detail": {
      const scope = enumValue(args.scope, ["training", "meal"] as const);
      if (scope === "training") {
        const dayNumber = boundedInteger(args.day_number, 1, 14);
        return dayNumber ? { tool, args: { scope, day_number: dayNumber } } : null;
      }
      if (scope === "meal") {
        const day = cleanText(args.day, 40);
        return day ? { tool, args: { scope, day } } : null;
      }
      return null;
    }
    case "read_activity_detail": {
      const activityId = boundedInteger(args.activity_id, 1, Number.MAX_SAFE_INTEGER);
      return activityId ? { tool, args: { activity_id: activityId } } : null;
    }
    case "read_run_week":
    case "read_health_summary":
    case "read_strength_progress":
    case "read_goal_progress":
      // No arguments: whatever was sent is dropped, never echoed into a query.
      return { tool, args: {} };
    case "read_today_session": {
      const date = optionalDate(args.date);
      return date === undefined ? null : { tool, args: { date } };
    }
  }
}
