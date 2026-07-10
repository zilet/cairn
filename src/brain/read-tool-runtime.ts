import { db, todayISO } from "../db.js";
import { getBrainDecision, listBrainExpectations } from "../repo/brain-decisions.js";
import { latestBrainEvaluation, recordBrainToolCall } from "../repo/brain-evaluations.js";
import { activeMedications, getMarkerHistory } from "../repo/health.js";
import { currentMealPlan } from "../repo/nutrition.js";
import { getPlanDay } from "../repo/plan.js";
import { directivesForCoach } from "../repo/propagation.js";
import { supplementsForCoach } from "../repo/supplements.js";
import { normalizedExerciseKey, normalizeExerciseName } from "../repo/exercise-canon.js";
import { canonicalMarker } from "../repo/marker-canon.js";
import {
  COACH_READ_TOOL_CATALOG,
  normalizeCoachReadToolRequest,
  type CoachReadToolName,
  type CoachReadToolRequest,
  type CoachReadToolResult,
} from "./read-tools.js";
import type { JsonObject, JsonValue } from "./contract-utils.js";

export interface CoachReadToolExecutionContext {
  run_id: string;
  op?: string;
  /** Injectable UTC calendar day for deterministic historical runs and tests. */
  today?: string;
}

export class CoachReadToolExecutionError extends Error {
  constructor(
    public readonly code: "invalid_request" | "execution_failed",
    message: string
  ) {
    super(message);
    this.name = "CoachReadToolExecutionError";
  }
}

type MutableRow = Record<string, unknown>;
type RawRead = {
  data: Record<string, unknown>;
  /** Arrays whose elements count toward rows_returned and may be trimmed for the byte cap. */
  row_arrays: unknown[][];
  truncated?: boolean;
};

const DAY_MS = 86_400_000;
const MAX_SOURCE_ROWS = 1_000;
const FORBIDDEN_RESULT_KEYS = new Set([
  "raw_json",
  "parsed_json",
  "raw_output",
  "raw_text",
  "file_path",
  "image_path",
  "token_json",
  "auth_status",
  "sync_cursor",
  "command",
  "env",
]);

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function executionToday(context: CoachReadToolExecutionContext): string {
  return validDate(context.today) ? context.today : todayISO();
}

function cappedText(value: unknown, max = 500): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Preserve useful bounded arrays while stripping prototypes, non-finite values, and forbidden raw fields. */
function safeJson(value: unknown, depth = 0): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (depth >= 7) return undefined;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, 500)) {
      const normalized = safeJson(item, depth + 1);
      if (normalized !== undefined) result.push(normalized);
    }
    return result;
  }
  if (!value || typeof value !== "object") return undefined;
  const result: JsonObject = {};
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key || FORBIDDEN_RESULT_KEYS.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) continue;
    const normalized = safeJson(item, depth + 1);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function finalize(tool: CoachReadToolName, raw: RawRead): CoachReadToolResult {
  const catalog = COACH_READ_TOOL_CATALOG[tool];
  let rows = raw.row_arrays.reduce((sum, items) => sum + items.length, 0);
  let truncated = !!raw.truncated;
  let candidate = { tool, data: raw.data, rows_returned: rows, truncated };

  while (resultBytes(candidate) > catalog.max_response_bytes) {
    const longest = [...raw.row_arrays].sort((a, b) => b.length - a.length)[0];
    if (!longest?.length) {
      throw new CoachReadToolExecutionError("execution_failed", "Coach read result could not fit its response budget");
    }
    longest.pop();
    rows--;
    truncated = true;
    candidate = { tool, data: raw.data, rows_returned: rows, truncated };
  }

  const data = safeJson(raw.data);
  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new CoachReadToolExecutionError("execution_failed", "Coach read produced an invalid result");
  }
  const result: CoachReadToolResult = { tool, data, rows_returned: rows, truncated };
  if (rows > catalog.max_rows || resultBytes(result) > catalog.max_response_bytes) {
    throw new CoachReadToolExecutionError("execution_failed", "Coach read exceeded its catalog bounds");
  }
  return result;
}

function resolveExercise(name: string): MutableRow | null {
  const exact = db
    .prepare(`SELECT id, name, muscle_group, unit, constraint_note, mode FROM exercises WHERE name = ? COLLATE NOCASE`)
    .get(name) as MutableRow | undefined;
  if (exact) return exact;
  const normalized = normalizeExerciseName(name);
  const alias = normalized
    ? (db.prepare(`SELECT canonical FROM exercise_aliases WHERE alias = ?`).get(normalized) as
        | { canonical?: string }
        | undefined)
    : undefined;
  if (alias?.canonical) {
    const row = db
      .prepare(
        `SELECT id, name, muscle_group, unit, constraint_note, mode FROM exercises WHERE name = ? COLLATE NOCASE`
      )
      .get(alias.canonical) as MutableRow | undefined;
    if (row) return row;
  }
  const key = normalizedExerciseKey(name);
  if (!key) return null;
  const rows = db
    .prepare(`SELECT id, name, muscle_group, unit, constraint_note, mode FROM exercises LIMIT 500`)
    .all() as MutableRow[];
  return rows.find((row) => normalizedExerciseKey(String(row.name ?? "")) === key) ?? null;
}

function readExerciseHistory(
  request: Extract<CoachReadToolRequest, { tool: "read_exercise_history" }>,
  today: string
): RawRead {
  const { exercise, limit } = request.args;
  const end = request.args.end_date ?? today;
  const start = request.args.start_date ?? addDays(end, -179);
  const found = resolveExercise(exercise);
  const sets: MutableRow[] = [];
  if (!found)
    return {
      data: { exercise: { requested: exercise, found: false }, range: { start_date: start, end_date: end }, sets },
      row_arrays: [sets],
    };

  const rows = db
    .prepare(
      `SELECT ls.id, s.date, s.id AS session_id, ls.set_number, ls.weight, ls.reps, ls.rir,
            ls.duration_sec, ls.note, s.soreness, s.performance, s.joint_pain, s.finished_at
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date BETWEEN ? AND ?
      ORDER BY s.date DESC, s.id DESC, ls.set_number DESC, ls.id DESC LIMIT ?`
    )
    .all(Number(found.id), start, end, limit + 1) as MutableRow[];
  const hasMore = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    sets.push({
      id: row.id,
      date: row.date,
      session_id: row.session_id,
      set_number: row.set_number,
      weight: row.weight,
      reps: row.reps,
      rir: row.rir,
      duration_sec: row.duration_sec,
      note: cappedText(row.note),
      feedback: { soreness: row.soreness, performance: row.performance, joint_pain: cappedText(row.joint_pain, 160) },
      finished: row.finished_at != null,
    });
  }
  const targets = (
    db
      .prepare(
        `SELECT pd.day_number, pd.name AS day_name, pi.position, pi.sets, pi.rep_low, pi.rep_high,
            pi.target_weight, pi.target_seconds, pi.warmup_sets, pi.note
       FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
      WHERE pi.exercise_id = ? ORDER BY pd.day_number, pi.position LIMIT 50`
      )
      .all(Number(found.id)) as MutableRow[]
  ).map((row) => ({ ...row, note: cappedText(row.note) }));
  const weighted = sets.filter((row) => finite(row.weight) != null && finite(row.reps) != null && Number(row.reps) > 0);
  const bestEst = weighted.reduce<number | null>((best, row) => {
    const weight = Number(row.weight);
    const reps = Number(row.reps);
    if (weight <= 0) return best;
    const estimate = Math.round(weight * (1 + reps / 30) * 10) / 10;
    return best == null || estimate > best ? estimate : best;
  }, null);
  const bestDuration = sets.reduce<number | null>((best, row) => {
    const duration = finite(row.duration_sec);
    return duration != null && (best == null || duration > best) ? duration : best;
  }, null);
  return {
    data: {
      exercise: { ...found, found: true },
      range: { start_date: start, end_date: end },
      current_plan_targets: targets,
      capacity: { best_est_1rm: bestEst, best_duration_sec: bestDuration },
      sets,
    },
    row_arrays: [sets],
    truncated: hasMore,
  };
}

function readTrainingWindow(
  request: Extract<CoachReadToolRequest, { tool: "read_training_window" }>,
  today: string
): RawRead {
  const end = request.args.end_date ?? today;
  const start = addDays(end, -(request.args.weeks * 7 - 1));
  const sessionRows = db
    .prepare(
      `SELECT s.id, s.date, s.kind, s.duration_min, s.notes, s.soreness, s.performance, s.joint_pain,
            s.finished_at, pd.day_number, pd.name AS plan_day,
            (SELECT COUNT(*) FROM plan_items pi WHERE pi.plan_day_id = s.plan_day_id) AS planned_items,
            (SELECT COUNT(DISTINCT ls.exercise_id) FROM logged_sets ls WHERE ls.session_id = s.id) AS completed_items,
            (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS logged_sets,
            (SELECT ROUND(SUM(CASE WHEN ls.weight > 0 AND ls.reps > 0 THEN ls.weight * ls.reps ELSE 0 END), 1) FROM logged_sets ls WHERE ls.session_id = s.id) AS tonnage,
            (SELECT GROUP_CONCAT(DISTINCT e.name) FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id WHERE ls.session_id = s.id) AS exercises,
            (SELECT GROUP_CONCAT(ss.exercise, ' | ') FROM session_skips ss WHERE ss.session_id = s.id) AS skipped
       FROM sessions s LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
      WHERE s.date BETWEEN ? AND ? ORDER BY s.date DESC, s.id DESC LIMIT ?`
    )
    .all(start, end, COACH_READ_TOOL_CATALOG.read_training_window.max_rows + 1) as MutableRow[];
  const activityRows = db
    .prepare(
      `SELECT id, date, type, duration_min, distance_km, pace, rpe, notes, source
       FROM activities WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(start, end, COACH_READ_TOOL_CATALOG.read_training_window.max_rows + 1) as MutableRow[];
  const events: MutableRow[] = [
    ...sessionRows.map((row) => ({
      event: "session",
      ...row,
      notes: cappedText(row.notes),
      joint_pain: cappedText(row.joint_pain, 160),
      exercises: cappedText(row.exercises, 500),
      skipped: cappedText(row.skipped, 500),
      finished: row.finished_at != null,
      finished_at: undefined,
      adherence:
        Number(row.planned_items) > 0
          ? {
              completed_or_skipped:
                Number(row.completed_items || 0) +
                String(row.skipped || "")
                  .split(" | ")
                  .filter(Boolean).length,
              planned: row.planned_items,
            }
          : null,
    })),
    ...activityRows.map((row) => ({ event: "activity", ...row, notes: cappedText(row.notes) })),
  ];
  events.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
  const max = COACH_READ_TOOL_CATALOG.read_training_window.max_rows;
  const bounded = events.slice(0, max);
  return {
    data: { range: { start_date: start, end_date: end, weeks: request.args.weeks }, events: bounded },
    row_arrays: [bounded],
    truncated: events.length > max || sessionRows.length > max || activityRows.length > max,
  };
}

function markerMatches(candidate: unknown, requested: string): boolean {
  const value = cappedText(candidate, 160);
  return !!value && canonicalMarker(value).key === requested;
}

function readMarkerHistory(request: Extract<CoachReadToolRequest, { tool: "read_marker_history" }>): RawRead {
  const requested = canonicalMarker(request.args.marker);
  const history = getMarkerHistory();
  const marker = history.markers.find(
    (item: any) => item?.key === requested.key || markerMatches(item?.name, requested.key)
  );
  const points: unknown[] = marker
    ? Array.isArray(marker.points)
      ? marker.points.slice(-request.args.limit)
      : []
    : [];
  const directives = directivesForCoach()
    .filter((item: any) => markerMatches(item?.marker, requested.key))
    .slice(0, 20);
  const supplements = supplementsForCoach()
    .filter(
      (item: any) =>
        Array.isArray(item?.related_markers) &&
        item.related_markers.some((name: unknown) => markerMatches(name, requested.key))
    )
    .slice(0, 20);
  const medications = activeMedications().slice(0, 30);
  return {
    data: {
      requested: { marker: request.args.marker, canonical_key: requested.key, canonical_name: requested.name },
      found: !!marker,
      marker: marker ? { ...marker, points } : null,
      related_directives: directives,
      related_supplements: supplements,
      active_medications: medications,
    },
    row_arrays: [points],
    truncated: !!marker && Array.isArray(marker.points) && marker.points.length > points.length,
  };
}

function readRecoveryWindow(
  request: Extract<CoachReadToolRequest, { tool: "read_recovery_window" }>,
  today: string
): RawRead {
  const end = request.args.end_date ?? today;
  const start = addDays(end, -(request.args.days - 1));
  const garmin = db
    .prepare(
      `SELECT id, date, steps, sleep_min, sleep_score, resting_hr, hrv_ms, stress_avg,
            body_battery_avg, body_battery_min, body_battery_max, active_calories,
            deep_sleep_min, rem_sleep_min, awake_min, avg_sleep_stress, hrv_status,
            training_readiness, acute_load, training_status, spo2_avg, skin_temp_dev_c
       FROM garmin_daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date DESC, updated_at DESC, id DESC LIMIT 500`
    )
    .all(start, end) as MutableRow[];
  const other = db
    .prepare(
      `SELECT id, source, date, steps, sleep_min, sleep_score, resting_hr, hrv_ms, active_calories
       FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date DESC, updated_at DESC, id DESC LIMIT 500`
    )
    .all(start, end) as MutableRow[];
  const byGarmin = new Map<string, MutableRow>();
  const byOther = new Map<string, MutableRow>();
  for (const row of garmin) if (!byGarmin.has(String(row.date))) byGarmin.set(String(row.date), row);
  for (const row of other) if (!byOther.has(String(row.date))) byOther.set(String(row.date), row);
  const dates = [...new Set([...byGarmin.keys(), ...byOther.keys()])].sort().reverse().slice(0, request.args.days);
  const pick = (primary: unknown, fallback: unknown) => primary ?? fallback ?? null;
  const days = dates.map((date) => {
    const g = byGarmin.get(date) ?? {};
    const o = byOther.get(date) ?? {};
    return {
      date,
      sources: [...(Object.keys(g).length ? ["garmin"] : []), ...(o.source ? [String(o.source).slice(0, 40)] : [])],
      steps: pick(g.steps, o.steps),
      sleep_min: pick(g.sleep_min, o.sleep_min),
      sleep_score: pick(g.sleep_score, o.sleep_score),
      resting_hr: pick(g.resting_hr, o.resting_hr),
      hrv_ms: pick(g.hrv_ms, o.hrv_ms),
      stress_avg: g.stress_avg ?? null,
      body_battery_avg: g.body_battery_avg ?? null,
      body_battery_min: g.body_battery_min ?? null,
      body_battery_max: g.body_battery_max ?? null,
      active_calories: pick(g.active_calories, o.active_calories),
      deep_sleep_min: g.deep_sleep_min ?? null,
      rem_sleep_min: g.rem_sleep_min ?? null,
      awake_min: g.awake_min ?? null,
      sleep_stress: g.avg_sleep_stress ?? null,
      hrv_status: cappedText(g.hrv_status, 80),
      training_readiness: g.training_readiness ?? null,
      acute_load: g.acute_load ?? null,
      training_status: cappedText(g.training_status, 80),
      spo2_avg: g.spo2_avg ?? null,
      skin_temp_dev_c: g.skin_temp_dev_c ?? null,
    };
  });
  return { data: { range: { start_date: start, end_date: end, days: request.args.days }, days }, row_arrays: [days] };
}

function leastSquaresWeightTrend(rows: MutableRow[]): number | null {
  if (rows.length < 2) return null;
  const ordered = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const first = Date.parse(`${ordered[0].date}T00:00:00.000Z`);
  const points = ordered.map((row) => ({
    x: (Date.parse(`${row.date}T00:00:00.000Z`) - first) / DAY_MS,
    y: Number(row.weight_lb),
  }));
  if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) || points.at(-1)!.x < 3)
    return null;
  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0);
  if (!denominator) return null;
  const daily = points.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0) / denominator;
  return Math.round(daily * 7 * 100) / 100;
}

function readNutritionWindow(
  request: Extract<CoachReadToolRequest, { tool: "read_nutrition_window" }>,
  today: string
): RawRead {
  const end = request.args.end_date ?? today;
  const start = addDays(end, -(request.args.days - 1));
  const rawRows = db
    .prepare(
      `SELECT id, COALESCE(date, substr(created_at,1,10)) AS date, parsed_json
       FROM food_notes WHERE COALESCE(date, substr(created_at,1,10)) BETWEEN ? AND ?
      ORDER BY COALESCE(date, substr(created_at,1,10)) DESC, id DESC LIMIT ?`
    )
    .all(start, end, MAX_SOURCE_ROWS + 1) as MutableRow[];
  const sourceTruncated = rawRows.length > MAX_SOURCE_ROWS;
  const byDate = new Map<
    string,
    {
      date: string;
      entries: number;
      usable_entries: number;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      fiber_g: number;
    }
  >();
  for (const row of rawRows.slice(0, MAX_SOURCE_ROWS)) {
    const date = String(row.date);
    const day = byDate.get(date) ?? {
      date,
      entries: 0,
      usable_entries: 0,
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      fiber_g: 0,
    };
    day.entries++;
    const parsed = parsedObject(row.parsed_json);
    const kcal = finite(parsed?.kcal);
    if (kcal != null) {
      day.usable_entries++;
      day.kcal += Math.max(0, kcal);
      for (const key of ["protein_g", "carbs_g", "fat_g", "fiber_g"] as const)
        day[key] += Math.max(0, finite(parsed?.[key]) ?? 0);
    }
    byDate.set(date, day);
  }
  const days = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((day) => ({
      ...day,
      kcal: Math.round(day.kcal),
      protein_g: Math.round(day.protein_g),
      carbs_g: Math.round(day.carbs_g),
      fat_g: Math.round(day.fat_g),
      fiber_g: Math.round(day.fiber_g),
      coverage: day.entries ? Math.round((day.usable_entries / day.entries) * 100) / 100 : 0,
    }));
  const weights = db
    .prepare(`SELECT date, weight_lb FROM bodyweight_log WHERE date BETWEEN ? AND ? ORDER BY date, id LIMIT 200`)
    .all(start, end) as MutableRow[];
  const trend = leastSquaresWeightTrend(weights);
  const intakeDays = days.filter((day) => day.usable_entries > 0);
  const intakeAverage = intakeDays.length
    ? Math.round(intakeDays.reduce((sum, day) => sum + day.kcal, 0) / intakeDays.length)
    : null;
  const impliedTdee = intakeAverage != null && trend != null ? Math.round(intakeAverage - trend * 500) : null;
  const targets = (
    db
      .prepare(
        `SELECT id, effective_date, target_kcal, protein_g, carbs_g, fat_g, source, note
       FROM nutrition_targets WHERE effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 50`
      )
      .all(end) as MutableRow[]
  ).map((row) => ({ ...row, note: cappedText(row.note, 300) }));
  return {
    data: {
      range: { start_date: start, end_date: end, days: request.args.days },
      coverage: {
        requested_days: request.args.days,
        logged_days: intakeDays.length,
        source_entries_truncated: sourceTruncated,
      },
      expenditure: {
        intake_avg_kcal: intakeAverage,
        weight_trend_lb_wk: trend,
        implied_tdee_kcal: impliedTdee,
        weigh_ins: weights.length,
      },
      target_history: targets,
      days,
    },
    row_arrays: [days],
    truncated: sourceTruncated,
  };
}

function bodyDexaMarkers(parsed: Record<string, unknown> | null): unknown[] {
  if (!Array.isArray(parsed?.markers)) return [];
  return parsed.markers.slice(0, 24).map((marker: any) => ({
    name: cappedText(marker?.name, 120),
    value: typeof marker?.value === "string" ? cappedText(marker.value, 120) : finite(marker?.value),
    unit: cappedText(marker?.unit, 40),
    flag: ["low", "normal", "high"].includes(marker?.flag) ? marker.flag : null,
  }));
}

function readBodyCompositionHistory(
  request: Extract<CoachReadToolRequest, { tool: "read_body_composition_history" }>
): RawRead {
  const fetchLimit = request.args.limit + 1;
  const weights = db
    .prepare(`SELECT id, date, weight_lb, note FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT ?`)
    .all(fetchLimit) as MutableRow[];
  const measurements = db
    .prepare(
      `SELECT id, date, waist_in, hip_in, chest_in, shoulder_in, neck_in, thigh_in, upper_arm_in,
            calf_in, forearm_in, note, source FROM body_measurements ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(fetchLimit) as MutableRow[];
  const dexas = db
    .prepare(
      `SELECT id, doc_date, created_at, parsed_json, summary FROM health_documents
      WHERE lower(kind) = 'dexa' ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC LIMIT ?`
    )
    .all(fetchLimit) as MutableRow[];
  const events: MutableRow[] = [
    ...weights.map((row) => ({
      type: "weight",
      id: row.id,
      date: row.date,
      weight_lb: row.weight_lb,
      note: cappedText(row.note),
    })),
    ...measurements.map((row) => ({
      type: "measurement",
      ...row,
      note: cappedText(row.note),
      source: cappedText(row.source, 40),
    })),
    ...dexas.map((row) => ({
      type: "dexa",
      id: row.id,
      date: row.doc_date ?? String(row.created_at ?? "").slice(0, 10),
      markers: bodyDexaMarkers(parsedObject(row.parsed_json)),
      summary: cappedText(row.summary, 500),
    })),
  ];
  events.sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));
  const bounded = events.slice(0, request.args.limit);
  return {
    data: { events: bounded },
    row_arrays: [bounded],
    truncated:
      events.length > request.args.limit ||
      weights.length > request.args.limit ||
      measurements.length > request.args.limit ||
      dexas.length > request.args.limit,
  };
}

function readLifeContextWindow(request: Extract<CoachReadToolRequest, { tool: "read_life_context_window" }>): RawRead {
  const limit = COACH_READ_TOOL_CATALOG.read_life_context_window.max_rows;
  const rows = db
    .prepare(
      `SELECT id, kind, title, detail, start_date, end_date, meta_json, archived, expected_recovery_days, resolved_at
       FROM context_events
      WHERE (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)
      ORDER BY start_date DESC, id DESC LIMIT ?`
    )
    .all(request.args.end_date, request.args.start_date, limit + 1) as MutableRow[];
  const events = rows.slice(0, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: cappedText(row.title, 200),
    detail: cappedText(row.detail, 800),
    start_date: row.start_date,
    end_date: row.end_date,
    meta: safeJson(parsedObject(row.meta_json)),
    archived: !!row.archived,
    expected_recovery_days: row.expected_recovery_days,
    resolved_at: row.resolved_at,
  }));
  return {
    data: { range: { start_date: request.args.start_date, end_date: request.args.end_date }, events },
    row_arrays: [events],
    truncated: rows.length > limit,
  };
}

function readDecisionHistory(request: Extract<CoachReadToolRequest, { tool: "read_decision_history" }>): RawRead {
  const where: string[] = [];
  const params: any[] = [];
  if (request.args.kind) {
    where.push("d.kind = ?");
    params.push(request.args.kind);
  }
  if (request.args.subject_key) {
    where.push(
      "(d.source_ref_key = ? OR EXISTS (SELECT 1 FROM brain_expectations be WHERE be.decision_id = d.id AND be.subject_key = ?))"
    );
    params.push(request.args.subject_key, request.args.subject_key);
  }
  const rows = db
    .prepare(`SELECT d.id FROM brain_decisions d WHERE ${where.join(" AND ")} ORDER BY d.id DESC LIMIT ?`)
    .all(...params, request.args.limit + 1) as Array<{ id: number }>;
  const decisions = rows.slice(0, request.args.limit).flatMap(({ id }) => {
    const decision = getBrainDecision(id);
    if (!decision) return [];
    const expectations = listBrainExpectations({ decisionId: id, limit: 20 }).map((expectation) => ({
      ...expectation,
      latest_evaluation: expectation.id ? latestBrainEvaluation(expectation.id) : null,
    }));
    return [{ ...decision, expectations }];
  });
  return { data: { decisions }, row_arrays: [decisions], truncated: rows.length > request.args.limit };
}

function readCurrentPlanDetail(request: Extract<CoachReadToolRequest, { tool: "read_current_plan_detail" }>): RawRead {
  if (request.args.scope === "training") {
    const day = getPlanDay(request.args.day_number);
    const items =
      day?.items?.slice(0, COACH_READ_TOOL_CATALOG.read_current_plan_detail.max_rows).map((item: any) => ({
        ...item,
        note: cappedText(item.note, 800),
        constraint_note: cappedText(item.constraint_note, 500),
      })) ?? [];
    return {
      data: { scope: "training", found: !!day, day: day ? { ...day, items } : null },
      row_arrays: [items],
      truncated: !!day && day.items.length > items.length,
    };
  }
  const plan = currentMealPlan();
  const sourceDays = Array.isArray(plan?.parsed?.days) ? plan.parsed.days : [];
  const query = request.args.day.trim().toLowerCase();
  const matched = sourceDays.find((day: any) => {
    const label = String(day?.day ?? "")
      .trim()
      .toLowerCase();
    return label === query || (query.length >= 3 && label.startsWith(query.slice(0, 3)));
  });
  const meals = Array.isArray(matched?.meals)
    ? matched.meals.slice(0, COACH_READ_TOOL_CATALOG.read_current_plan_detail.max_rows).map((meal: any) => ({
        name: cappedText(meal?.name, 200),
        items: cappedText(meal?.items, 800),
        kcal: finite(meal?.kcal),
        protein_g: finite(meal?.protein_g),
        carbs_g: finite(meal?.carbs_g),
        fat_g: finite(meal?.fat_g),
      }))
    : [];
  return {
    data: {
      scope: "meal",
      found: !!plan && !!matched,
      plan: plan
        ? {
            id: plan.id,
            status: plan.status,
            week_of: plan.week_of,
            daily_kcal: plan.parsed?.daily_kcal ?? null,
            daily_protein_g: plan.parsed?.daily_protein_g ?? null,
          }
        : null,
      day: matched ? { day: cappedText(matched.day, 40), note: cappedText(matched.note, 500), meals } : null,
    },
    row_arrays: [meals],
    truncated: Array.isArray(matched?.meals) && matched.meals.length > meals.length,
  };
}

function argsSummary(request: CoachReadToolRequest): string {
  switch (request.tool) {
    case "read_exercise_history":
      return `subject=exercise;dated=${request.args.start_date ? "yes" : "default"};limit=${request.args.limit}`;
    case "read_training_window":
      return `weeks=${request.args.weeks};end=${request.args.end_date ?? "today"}`;
    case "read_marker_history":
      return `subject=marker;limit=${request.args.limit}`;
    case "read_recovery_window":
      return `days=${request.args.days};end=${request.args.end_date ?? "today"}`;
    case "read_nutrition_window":
      return `days=${request.args.days};end=${request.args.end_date ?? "today"}`;
    case "read_body_composition_history":
      return `limit=${request.args.limit}`;
    case "read_life_context_window":
      return `bounded_range=yes`;
    case "read_decision_history":
      return `kind=${request.args.kind ?? "any"};subject=${request.args.subject_key ? "present" : "none"};limit=${request.args.limit}`;
    case "read_current_plan_detail":
      return `scope=${request.args.scope}`;
  }
}

function rawToolName(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const tool = (value as Record<string, unknown>).tool;
  return typeof tool === "string" && /^[a-z_]{1,100}$/.test(tool) ? tool : "invalid";
}

/**
 * Executes one catalogued coach read. The dispatch is intentionally closed: callers
 * cannot supply SQL, table names, commands, agent names, settings, or filesystem paths.
 */
export function executeCoachReadTool(
  requestValue: unknown,
  context: CoachReadToolExecutionContext
): CoachReadToolResult {
  const started = performance.now();
  const request = normalizeCoachReadToolRequest(requestValue);
  const runId = cappedText(context?.run_id, 120) ?? "unattributed";
  const op = cappedText(context?.op, 80) ?? "coach_read";
  if (!request) {
    recordBrainToolCall({
      run_id: runId,
      op,
      tool: rawToolName(requestValue),
      latency_ms: performance.now() - started,
      status: "invalid_request",
    });
    throw new CoachReadToolExecutionError("invalid_request", "Invalid or out-of-bounds coach read request");
  }

  try {
    const today = executionToday(context);
    let raw: RawRead;
    switch (request.tool) {
      case "read_exercise_history":
        raw = readExerciseHistory(request, today);
        break;
      case "read_training_window":
        raw = readTrainingWindow(request, today);
        break;
      case "read_marker_history":
        raw = readMarkerHistory(request);
        break;
      case "read_recovery_window":
        raw = readRecoveryWindow(request, today);
        break;
      case "read_nutrition_window":
        raw = readNutritionWindow(request, today);
        break;
      case "read_body_composition_history":
        raw = readBodyCompositionHistory(request);
        break;
      case "read_life_context_window":
        raw = readLifeContextWindow(request);
        break;
      case "read_decision_history":
        raw = readDecisionHistory(request);
        break;
      case "read_current_plan_detail":
        raw = readCurrentPlanDetail(request);
        break;
    }
    const result = finalize(request.tool, raw);
    recordBrainToolCall({
      run_id: runId,
      op,
      tool: request.tool,
      args_summary: argsSummary(request),
      rows_returned: result.rows_returned,
      latency_ms: performance.now() - started,
      status: result.truncated ? "truncated" : "ok",
    });
    return result;
  } catch (error) {
    recordBrainToolCall({
      run_id: runId,
      op,
      tool: request.tool,
      args_summary: argsSummary(request),
      latency_ms: performance.now() - started,
      status: "error",
    });
    if (error instanceof CoachReadToolExecutionError) throw error;
    throw new CoachReadToolExecutionError("execution_failed", "Coach read failed safely");
  }
}
