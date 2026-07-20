export const SESSION_PRESCRIPTION_LIMITS = {
  sets: 20,
  reps: 100,
  targetSeconds: 3600,
  minutes: 360,
  distanceKm: 500,
} as const;

export type PrescriptionMode = "reps" | "timed";

export interface NormalizedPrescriptionCore {
  kind: "strength" | "cardio";
  exercise: string;
  mode: PrescriptionMode | null;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_seconds: number | null;
  target_duration_min: number | null;
  target_distance_km: number | null;
}

export interface NormalizePrescriptionOptions {
  storedMode?: unknown;
  clampBounds?: boolean;
  strictShape?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function finite(value: unknown): number | null {
  if (!present(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(
  value: unknown,
  field: string,
  max: number,
  options: { integer?: boolean; clamp?: boolean } = {}
): number | null {
  if (!present(value)) return null;
  const number = finite(value);
  if (number == null || number <= 0) throw new Error(`${field} must be positive`);
  if (options.integer && !Number.isInteger(number) && !options.clamp) {
    throw new Error(`${field} must be a whole number`);
  }
  const normalized = options.integer ? Math.round(number) : Math.round(number * 100) / 100;
  if (normalized > max && !options.clamp) throw new Error(`${field} must be at most ${max}`);
  return Math.min(max, normalized);
}

function meaningful(item: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => present(item[field]));
}

// Pure trust-boundary normalizer shared by agent-result acceptance and durable
// daily-session persistence. Database exercise identity remains authoritative:
// persistence resolves it first and supplies `storedMode`; this function itself
// has no database or other ambient dependency.
export function normalizePrescriptionItem(
  raw: unknown,
  position = 0,
  options: NormalizePrescriptionOptions = {}
): NormalizedPrescriptionCore {
  const item = record(raw);
  if (!item) throw new Error(`item ${position + 1} must be an object`);
  if (item.kind != null && item.kind !== "strength" && item.kind !== "cardio") {
    throw new Error(`item ${position + 1} kind must be strength or cardio`);
  }
  const kind = item.kind === "cardio" ? "cardio" : "strength";
  const exercise = String(item.exercise ?? (kind === "cardio" ? (item.note ?? "") : ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!exercise) throw new Error(`item ${position + 1} exercise is required`);

  if (kind === "cardio") {
    if (
      options.strictShape &&
      meaningful(item, [
        "sets",
        "rep_low",
        "rep_high",
        "target_reps",
        "target_weight",
        "target_seconds",
        "warmup_sets",
        "mode",
      ])
    ) {
      throw new Error(`cardio item ${position + 1} cannot also prescribe strength fields`);
    }
    const duration = positiveNumber(
      item.target_duration_min,
      `cardio item ${position + 1} target_duration_min`,
      SESSION_PRESCRIPTION_LIMITS.minutes,
      { integer: true, clamp: options.clampBounds }
    );
    const distance = positiveNumber(
      item.target_distance_km,
      `cardio item ${position + 1} target_distance_km`,
      SESSION_PRESCRIPTION_LIMITS.distanceKm,
      { clamp: options.clampBounds }
    );
    if (duration == null && distance == null) {
      throw new Error(`cardio item ${position + 1} needs a duration or distance`);
    }
    return {
      kind,
      exercise,
      mode: null,
      sets: null,
      rep_low: null,
      rep_high: null,
      target_seconds: null,
      target_duration_min: duration,
      target_distance_km: distance,
    };
  }

  if (
    options.strictShape &&
    meaningful(item, ["target_duration_min", "target_distance_km", "target_zone", "interval", "interval_json"])
  ) {
    throw new Error(`strength item ${position + 1} cannot also prescribe cardio fields`);
  }
  if (item.mode != null && item.mode !== "reps" && item.mode !== "timed") {
    throw new Error(`item ${position + 1} mode must be reps or timed`);
  }
  const declaredMode = item.mode === "reps" || item.mode === "timed" ? item.mode : null;
  const storedMode = options.storedMode === "reps" || options.storedMode === "timed" ? options.storedMode : null;
  const rawSeconds = positiveNumber(
    item.target_seconds,
    `timed item ${position + 1} target_seconds`,
    SESSION_PRESCRIPTION_LIMITS.targetSeconds,
    { integer: true, clamp: options.clampBounds }
  );
  const impliedMode = rawSeconds != null ? "timed" : null;
  const modes = new Set([declaredMode, storedMode, impliedMode].filter(Boolean));
  if (modes.size > 1) throw new Error(`item ${position + 1} mode conflicts with its exercise or prescription`);
  const mode = (declaredMode ?? storedMode ?? impliedMode ?? "reps") as PrescriptionMode;
  const sets = positiveNumber(item.sets, `strength item ${position + 1} sets`, SESSION_PRESCRIPTION_LIMITS.sets, {
    integer: true,
    clamp: options.clampBounds,
  });
  if (sets == null) throw new Error(`strength item ${position + 1} sets are required`);

  let repLow = positiveNumber(item.rep_low, `reps item ${position + 1} targets`, SESSION_PRESCRIPTION_LIMITS.reps, {
    integer: true,
    clamp: options.clampBounds,
  });
  let repHigh = positiveNumber(item.rep_high, `reps item ${position + 1} targets`, SESSION_PRESCRIPTION_LIMITS.reps, {
    integer: true,
    clamp: options.clampBounds,
  });
  const targetReps = positiveNumber(
    item.target_reps,
    `reps item ${position + 1} targets`,
    SESSION_PRESCRIPTION_LIMITS.reps,
    { integer: true, clamp: options.clampBounds }
  );

  if (mode === "timed") {
    if (repLow != null || repHigh != null || targetReps != null) {
      throw new Error(`timed item ${position + 1} cannot also prescribe reps`);
    }
    if (rawSeconds == null) throw new Error(`timed item ${position + 1} target_seconds must be positive`);
    const weight = finite(item.target_weight);
    if (present(item.target_weight) && weight == null) {
      throw new Error(`timed item ${position + 1} target_weight must be numeric`);
    }
    if (weight != null && weight !== 0) throw new Error(`timed item ${position + 1} cannot also prescribe a weight`);
  } else {
    if (present(item.target_seconds)) throw new Error(`reps item ${position + 1} cannot prescribe target_seconds`);
    if (targetReps != null) {
      if (repLow == null && repHigh == null) [repLow, repHigh] = [targetReps, targetReps];
      else {
        const low = repLow ?? repHigh!;
        const high = repHigh ?? repLow!;
        if (targetReps < low || targetReps > high) {
          throw new Error(`reps item ${position + 1} target_reps conflicts with its rep range`);
        }
      }
    }
    if (repLow == null && repHigh == null) {
      throw new Error(`reps item ${position + 1} needs a positive rep target`);
    }
    if (repLow != null && repHigh != null && repLow > repHigh) {
      if (options.strictShape) throw new Error(`reps item ${position + 1} rep range is reversed`);
      [repLow, repHigh] = [repHigh, repLow];
    }
    if (present(item.target_weight) && finite(item.target_weight) == null) {
      throw new Error(`reps item ${position + 1} target_weight must be numeric`);
    }
  }

  return {
    kind,
    exercise,
    mode,
    sets,
    rep_low: mode === "timed" ? null : repLow,
    rep_high: mode === "timed" ? null : repHigh,
    target_seconds: mode === "timed" ? rawSeconds : null,
    target_duration_min: null,
    target_distance_km: null,
  };
}
