import {
  asRecord,
  boundedInteger,
  cleanOptionalText,
  cleanText,
  enumValue,
  isoDate,
  normalizeJsonObject,
  type JsonObject,
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
      "A date-ordered event stream for the last N weeks: every session with its dose and feedback, every cardio activity, and skipped days, so consistency, volume trend, and missed work can be judged as a whole. Use it for the shape of recent training. It does not detail one exercise's sets (read_exercise_history) or the athlete's physiology (read_recovery_window).",
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
      "Prior brain decisions of one kind (day_read, session_suggestion, training_target, meal_plan, recovery_adjustment, and the other kinds in the args contract) or about one subject key, each with the expectations it set and the latest evaluation of each. Use it before repeating a call the system has already made, to see what was tried and whether it held. Either kind or subject_key is required; it returns no raw training or health data.",
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

export type CoachReadToolRequest =
  | { tool: "read_exercise_history"; args: ExerciseHistoryArgs }
  | { tool: "read_training_window"; args: TrainingWindowArgs }
  | { tool: "read_marker_history"; args: MarkerHistoryArgs }
  | { tool: "read_recovery_window"; args: RecoveryWindowArgs }
  | { tool: "read_nutrition_window"; args: NutritionWindowArgs }
  | { tool: "read_body_composition_history"; args: BodyCompositionHistoryArgs }
  | { tool: "read_life_context_window"; args: LifeContextWindowArgs }
  | { tool: "read_decision_history"; args: DecisionHistoryArgs }
  | { tool: "read_current_plan_detail"; args: CurrentPlanDetailArgs };

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
  const args = asRecord(input.args);
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
      if ((args.kind != null && !kind) || (!kind && !subjectKey) || !limit) return null;
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
  }
}

export function normalizeCoachReadToolResult(value: unknown): CoachReadToolResult | null {
  const input = asRecord(value);
  if (!input) return null;
  const tool = enumValue(input.tool, COACH_READ_TOOL_NAMES);
  const rowsReturned = boundedInteger(input.rows_returned, 0, 10_000);
  const wrapped = normalizeJsonObject({ data: input.data });
  if (
    !tool ||
    rowsReturned == null ||
    rowsReturned > COACH_READ_TOOL_CATALOG[tool].max_rows ||
    typeof input.truncated !== "boolean" ||
    !wrapped ||
    !("data" in wrapped)
  )
    return null;
  return { tool, data: wrapped.data, rows_returned: rowsReturned, truncated: input.truncated };
}

export function coachReadToolArgsSummary(request: CoachReadToolRequest): JsonObject {
  return normalizeJsonObject(request.args) ?? {};
}
