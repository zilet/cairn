// Unified daily signal state — the deterministic arbitration layer between raw
// evidence and planning. It resolves duplicate observations once, then groups the
// survivors into independent latent dimensions. Dimensions are never averaged
// together: sleep, training load, fueling, health constraints, and life pressure
// retain their own provenance/conflicts and only meet at one bounded INTERNAL
// arbitration index that emits plain-language posture/reasons (never a score).

export type SignalDimension =
  | "recovery_capacity"
  | "training_load_tolerance"
  | "energy_fueling"
  | "health_constraints"
  | "life_capacity";
export type SignalDirection = "support" | "neutral" | "caution" | "constraint";
export type SignalConfidence = "none" | "low" | "medium" | "high";
export type SignalFreshness = "fresh" | "recent" | "stale";
export type SignalPosture = "train" | "modify" | "easy" | "rest" | "done";

export interface SignalObservation {
  dimension: SignalDimension;
  field: string;
  date: string | null;
  source: string;
  direction: SignalDirection;
  summary: string;
  confidence?: Exclude<SignalConfidence, "none">;
  coverage?: { samples: number; expected?: number | null; window_days?: number | null };
  value?: unknown;
  observation_id?: string | null;
  subject_key?: string | null;
  max_age_days?: number;
  safety_override?: boolean;
}

export interface ResolvedSignalEvidence extends SignalObservation {
  identity: string;
  age_days: number | null;
  freshness: SignalFreshness;
  selected_from: string[];
}

export interface SignalDimensionState {
  dimension: SignalDimension;
  status: "unknown" | "supportive" | "steady" | "watch" | "constrained";
  confidence: SignalConfidence;
  latest_date: string | null;
  coverage: {
    observed_fields: string[];
    active_fields: string[];
    stale_fields: string[];
    samples: number;
  };
  provenance: Array<{ field: string; source: string; date: string | null; freshness: SignalFreshness }>;
  evidence: ResolvedSignalEvidence[];
  conflicts: string[];
  reason: string;
}

export interface UnifiedSignalState {
  date: string;
  dimensions: Record<SignalDimension, SignalDimensionState>;
  action: {
    readiness: "ready" | "caution" | "protect" | "complete" | "unknown";
    posture: SignalPosture;
    reason: string;
    reasons: string[];
    source_dimensions: SignalDimension[];
    confidence: SignalConfidence;
    directives: {
      training: "proceed" | "hold_aggression" | "modify" | "recover";
      fueling: "normal" | "settling" | "protect";
      schedule: "normal" | "compress" | "reschedule";
    };
  };
  provenance: string[];
  conflicts: string[];
}

const DIMENSIONS: SignalDimension[] = [
  "recovery_capacity",
  "training_load_tolerance",
  "energy_fueling",
  "health_constraints",
  "life_capacity",
];
const DIRECTION_RANK: Record<SignalDirection, number> = { neutral: 0, support: 1, caution: 2, constraint: 3 };

function ageDays(reference: string, date: string | null): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const age = Math.floor((Date.parse(`${reference}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function sourceRank(observation: SignalObservation): number {
  const source = observation.source.toLowerCase();
  if (observation.safety_override && /user|checkin|manual|session/.test(source)) return 1_000;
  if (/manual_session|cairn_session/.test(source)) return 950;
  if (/user|checkin/.test(source)) return 925;
  if (/garmin/.test(source)) return 900;
  if (/oura|whoop/.test(source)) return 850;
  if (/apple/.test(source)) return 800;
  if (/manual/.test(source)) return 750;
  if (/profile|formula/.test(source)) return 600;
  return 500;
}

function canonicalIdentity(observation: SignalObservation): string {
  if (observation.observation_id) return `${observation.dimension}:${observation.observation_id}`;
  return [observation.dimension, observation.field, observation.subject_key ?? "", observation.date ?? "undated"].join(
    ":"
  );
}

export function resolveSignalObservations(date: string, observations: SignalObservation[]): ResolvedSignalEvidence[] {
  const groups = new Map<string, SignalObservation[]>();
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!observation || !DIMENSIONS.includes(observation.dimension) || !observation.field || !observation.source)
      continue;
    const identity = canonicalIdentity(observation);
    groups.set(identity, [...(groups.get(identity) ?? []), observation]);
  }
  const resolved: ResolvedSignalEvidence[] = [];
  for (const [identity, candidates] of groups) {
    const selected = [...candidates].sort((a, b) => {
      const safety = Number(!!b.safety_override) - Number(!!a.safety_override);
      if (safety) return safety;
      const source = sourceRank(b) - sourceRank(a);
      if (source) return source;
      return DIRECTION_RANK[b.direction] - DIRECTION_RANK[a.direction];
    })[0];
    const age = ageDays(date, selected.date);
    const maxAge = Math.max(0, selected.max_age_days ?? 7);
    const freshness: SignalFreshness =
      age == null || age > maxAge ? "stale" : age <= Math.min(1, maxAge) ? "fresh" : "recent";
    resolved.push({
      ...selected,
      identity,
      age_days: age,
      freshness,
      selected_from: [...new Set(candidates.map((candidate) => candidate.source))],
    });
  }
  return resolved.sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
      a.field.localeCompare(b.field)
  );
}

function dimensionState(dimension: SignalDimension, evidence: ResolvedSignalEvidence[]): SignalDimensionState {
  const all = evidence.filter((item) => item.dimension === dimension);
  const active = all.filter((item) => item.freshness !== "stale");
  const strongest = [...active].sort((a, b) => {
    const safety = Number(!!b.safety_override) - Number(!!a.safety_override);
    return safety || DIRECTION_RANK[b.direction] - DIRECTION_RANK[a.direction];
  })[0];
  const status: SignalDimensionState["status"] = !strongest
    ? "unknown"
    : strongest.direction === "constraint"
      ? "constrained"
      : strongest.direction === "caution"
        ? "watch"
        : strongest.direction === "support"
          ? "supportive"
          : "steady";
  const directions = new Set(active.map((item) => item.direction));
  const conflicts: string[] = [];
  if (directions.has("support") && (directions.has("caution") || directions.has("constraint"))) {
    const support = active.find((item) => item.direction === "support");
    const brake =
      active.find((item) => item.direction === "constraint") ?? active.find((item) => item.direction === "caution");
    if (support && brake)
      conflicts.push(`${support.summary} But ${brake.summary.charAt(0).toLowerCase()}${brake.summary.slice(1)}`);
  }
  const activeFields = [...new Set(active.map((item) => item.field))];
  const staleFields = [...new Set(all.filter((item) => item.freshness === "stale").map((item) => item.field))];
  let confidence: SignalConfidence = "none";
  if (all.length)
    confidence =
      active.length === 0
        ? "low"
        : activeFields.length >= 3 && conflicts.length === 0
          ? "high"
          : activeFields.length >= 2
            ? "medium"
            : "low";
  const latestDate =
    all
      .map((item) => item.date)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
  return {
    dimension,
    status,
    confidence,
    latest_date: latestDate,
    coverage: {
      observed_fields: [...new Set(all.map((item) => item.field))],
      active_fields: activeFields,
      stale_fields: staleFields,
      samples: all.reduce((sum, item) => sum + Math.max(1, Number(item.coverage?.samples) || 1), 0),
    },
    provenance: all.map((item) => ({
      field: item.field,
      source: item.source,
      date: item.date,
      freshness: item.freshness,
    })),
    evidence: all,
    conflicts,
    reason:
      strongest?.summary ??
      (all.length ? "Only stale evidence is available, so this stays open." : "No current evidence in this dimension."),
  };
}

const DIMENSION_WEIGHT: Record<SignalDimension, number> = {
  recovery_capacity: 3,
  training_load_tolerance: 3,
  energy_fueling: 1,
  health_constraints: 4,
  life_capacity: 2,
};
const STATUS_VALUE: Record<SignalDimensionState["status"], number> = {
  unknown: 0,
  supportive: 2,
  steady: 0,
  watch: -1,
  constrained: -3,
};
const CONFIDENCE_WEIGHT: Record<SignalConfidence, number> = { none: 0, low: 0.5, medium: 0.75, high: 1 };

// Private structured metric: fixed dimension/confidence weights and a bounded
// result. Hard safety gates run first; this breaks only the remaining mixed-signal
// ties. The number is deliberately never returned or rendered.
function privateArbitration(dimensions: Record<SignalDimension, SignalDimensionState>) {
  const components = DIMENSIONS.map((dimension) => ({
    dimension,
    contribution:
      STATUS_VALUE[dimensions[dimension].status] *
      DIMENSION_WEIGHT[dimension] *
      CONFIDENCE_WEIGHT[dimensions[dimension].confidence],
  }));
  return {
    components,
    value: Math.max(
      -12,
      Math.min(
        12,
        components.reduce((sum, component) => sum + component.contribution, 0)
      )
    ),
  };
}

function planningDirectives(dimensions: Record<SignalDimension, SignalDimensionState>) {
  const recovery = dimensions.recovery_capacity.status;
  const trainingLoad = dimensions.training_load_tolerance.status;
  const health = dimensions.health_constraints.status;
  const energy = dimensions.energy_fueling.status;
  const life = dimensions.life_capacity.status;
  const training: "proceed" | "hold_aggression" | "modify" | "recover" =
    recovery === "constrained" || trainingLoad === "constrained"
      ? "recover"
      : health === "constrained"
        ? "modify"
        : recovery === "watch" || trainingLoad === "watch" || health === "watch" || energy === "constrained"
          ? "hold_aggression"
          : "proceed";
  return {
    training,
    fueling:
      energy === "constrained"
        ? ("protect" as const)
        : energy === "watch"
          ? ("settling" as const)
          : ("normal" as const),
    schedule:
      life === "constrained" ? ("reschedule" as const) : life === "watch" ? ("compress" as const) : ("normal" as const),
  };
}

function actionState(dimensions: Record<SignalDimension, SignalDimensionState>) {
  const active = Object.values(dimensions).flatMap((dimension) =>
    dimension.evidence.filter((item) => item.freshness !== "stale")
  );
  const done = active.find((item) => item.field === "completed_today" && item.direction === "support");
  if (done) return { readiness: "complete" as const, posture: "done" as const, evidence: [done] };
  const feltProtect = active.find(
    (item) =>
      item.safety_override && item.direction === "constraint" && /fatigue|energy|sleep_feel|illness/.test(item.field)
  );
  if (feltProtect) return { readiness: "protect" as const, posture: "rest" as const, evidence: [feltProtect] };
  // Recovery and accumulated-load protection own the overall posture before a
  // simultaneous health work-around. The health dimension remains intact, so an
  // injury still caveats any movement; it just cannot reopen hard training on a
  // day the canonical recovery/load state has already made easy.
  const recoveryConstraints = active.filter(
    (item) =>
      (item.dimension === "recovery_capacity" || item.dimension === "training_load_tolerance") &&
      item.direction === "constraint"
  );
  if (recoveryConstraints.length)
    return { readiness: "protect" as const, posture: "easy" as const, evidence: recoveryConstraints };
  const healthConstraints = active.filter(
    (item) => item.dimension === "health_constraints" && item.direction === "constraint"
  );
  if (healthConstraints.length)
    return { readiness: "caution" as const, posture: "modify" as const, evidence: healthConstraints };
  const fuelPrescription = active.find(
    (item) => item.dimension === "energy_fueling" && item.field === "underfueling_control" && item.direction === "constraint"
  );
  if (fuelPrescription)
    return { readiness: "caution" as const, posture: "modify" as const, evidence: [fuelPrescription] };
  const arbitration = privateArbitration(dimensions);
  const brakes = active.filter((item) => item.direction === "constraint" || item.direction === "caution");
  if (arbitration.value <= -8) return { readiness: "protect" as const, posture: "rest" as const, evidence: brakes };
  if (arbitration.value <= -4) return { readiness: "protect" as const, posture: "easy" as const, evidence: brakes };
  if (arbitration.value <= -2) return { readiness: "caution" as const, posture: "modify" as const, evidence: brakes };
  if (!active.length) return { readiness: "unknown" as const, posture: "train" as const, evidence: [] };
  return {
    readiness: "ready" as const,
    posture: "train" as const,
    evidence: active.filter((item) => item.direction === "support"),
  };
}

export function buildUnifiedSignalState(date: string, observations: SignalObservation[]): UnifiedSignalState {
  const resolved = resolveSignalObservations(date, observations);
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, dimensionState(dimension, resolved)])
  ) as Record<SignalDimension, SignalDimensionState>;
  const action = actionState(dimensions);
  const directives = planningDirectives(dimensions);
  const reasons = action.evidence
    .map((item) => item.summary)
    .filter(Boolean)
    .slice(0, 3);
  const reason =
    reasons[0] ??
    (action.readiness === "unknown"
      ? "There is not enough fresh signal to call recovery either way; use how you feel and keep the default flexible."
      : "The current signals leave room for the planned day.");
  const sourceDimensions = [...new Set(action.evidence.map((item) => item.dimension))];
  const actionConfidence: SignalConfidence =
    sourceDimensions.length === 0
      ? "none"
      : sourceDimensions.some((dimension) => dimensions[dimension].confidence === "high")
        ? "high"
        : sourceDimensions.some((dimension) => dimensions[dimension].confidence === "medium")
          ? "medium"
          : "low";
  return {
    date,
    dimensions,
    action: {
      readiness: action.readiness,
      posture: action.posture,
      reason,
      reasons,
      source_dimensions: sourceDimensions,
      confidence: actionConfidence,
      directives,
    },
    provenance: [...new Set(resolved.map((item) => `${item.field}:${item.source}:${item.date ?? "undated"}`))],
    conflicts: DIMENSIONS.flatMap((dimension) => dimensions[dimension].conflicts),
  };
}

function observation(
  dimension: SignalDimension,
  field: string,
  date: string | null,
  source: string,
  direction: SignalDirection,
  summary: string,
  extra: Partial<SignalObservation> = {}
): SignalObservation {
  return { dimension, field, date, source, direction, summary, ...extra };
}

// Adapter from the existing deterministic domain reads. It does no DB access:
// getCoachContext and dayRead pass the exact snapshot they already computed.
export function planningSignalState(input: {
  date: string;
  recovery?: any;
  checkin?: any;
  trainingSignals?: any;
  programState?: any;
  expenditure?: any;
  underfueling?: any;
  context?: any;
  contextEvents?: any[];
  completedToday?: boolean;
}): UnifiedSignalState {
  const date = input.date;
  const observations: SignalObservation[] = [];
  const quality = input.recovery?.quality ?? input.recovery?.recovery?.quality ?? {};
  const addRecovery = (field: string, qualityField: string, direction: SignalDirection, summary: string) => {
    const q = quality[qualityField] ?? {};
    observations.push(
      observation("recovery_capacity", field, q.latest_date ?? null, q.source ?? "recovery", direction, summary, {
        coverage: {
          samples: Number(q.sample_count) || 1,
          expected: q.expected_days ?? null,
          window_days: q.window_days ?? null,
        },
        max_age_days: 3,
      })
    );
  };
  const current = input.recovery?.recovery ?? {};
  if (current.sleep_min != null)
    addRecovery(
      "sleep",
      "sleep_min",
      Number(current.sleep_min) < 300 ? "constraint" : Number(current.sleep_min) < 360 ? "caution" : "support",
      Number(current.sleep_min) < 360 ? "Recent sleep is running short." : "Recent sleep supports the planned day."
    );
  if (current.training_readiness != null)
    addRecovery(
      "training_readiness",
      "training_readiness",
      Number(current.training_readiness) < 35
        ? "constraint"
        : Number(current.training_readiness) < 50
          ? "caution"
          : "support",
      Number(current.training_readiness) < 50
        ? "The fresh wearable readiness signal is subdued."
        : "The fresh wearable readiness signal is supportive."
    );
  if (input.recovery?.delta?.hrv != null)
    addRecovery(
      "hrv",
      "hrv_ms",
      Number(input.recovery.delta.hrv) < -5 ? "caution" : "support",
      Number(input.recovery.delta.hrv) < -5
        ? "HRV is below the athlete's recent norm."
        : "HRV is steady against the athlete's norm."
    );
  if (input.recovery?.delta?.rhr != null)
    addRecovery(
      "resting_hr",
      "resting_hr",
      Number(input.recovery.delta.rhr) > 3 ? "caution" : "support",
      Number(input.recovery.delta.rhr) > 3
        ? "Resting heart rate is above the athlete's norm."
        : "Resting heart rate is steady against the athlete's norm."
    );

  // Apple daily activity is not a sport-specific workout record, but meaningful
  // exercise minutes/distance still say the athlete has carried recent load. Keep
  // it deliberately generic and caution-only: it may hold aggression, but cannot
  // invent a run/ride, satisfy compliance, or force a recovery day. When the
  // program state already has an endurance activity on the same date, that richer
  // record owns the observation so a mirrored Apple total is not counted twice.
  const activityCandidates = [
    { field: "exercise_min", value: current.exercise_min, quality: quality.exercise_min },
    { field: "distance_km", value: current.distance_km, quality: quality.distance_km },
  ]
    .filter(
      (candidate) =>
        candidate.value != null &&
        candidate.quality?.latest_date &&
        /apple/i.test(String(candidate.quality?.source ?? ""))
    )
    .sort((a, b) => String(b.quality.latest_date).localeCompare(String(a.quality.latest_date)));
  const genericActivity = activityCandidates[0];
  const activityDate = genericActivity?.quality?.latest_date ?? null;
  const mirroredEnduranceDates = new Set(
    [input.programState?.hybrid?.recent_endurance, ...(input.programState?.hybrid?.recent_endurance_all ?? [])]
      .map((item) => item?.date)
      .filter(Boolean)
  );
  const exerciseMinutes =
    quality.exercise_min?.latest_date === activityDate && /apple/i.test(String(quality.exercise_min?.source ?? ""))
      ? Number(current.exercise_min)
      : Number.NaN;
  const distanceKm =
    quality.distance_km?.latest_date === activityDate && /apple/i.test(String(quality.distance_km?.source ?? ""))
      ? Number(current.distance_km)
      : Number.NaN;
  const meaningfulGenericActivity =
    (Number.isFinite(exerciseMinutes) && exerciseMinutes >= 20) || (Number.isFinite(distanceKm) && distanceKm >= 2);
  if (genericActivity && meaningfulGenericActivity && !mirroredEnduranceDates.has(activityDate)) {
    const details = [
      Number.isFinite(exerciseMinutes) && exerciseMinutes > 0
        ? `${Math.round(exerciseMinutes)} exercise minutes`
        : null,
      Number.isFinite(distanceKm) && distanceKm > 0 ? `${Math.round(distanceKm * 10) / 10} km of movement` : null,
    ].filter(Boolean);
    observations.push(
      observation(
        "training_load_tolerance",
        "generic_activity_load",
        activityDate,
        String(genericActivity.quality.source),
        "caution",
        `Apple daily activity shows ${details.join(" and ")}; treat it as generic recent load without assuming a sport.`,
        {
          coverage: {
            samples: Number(genericActivity.quality.sample_count) || 1,
            expected: genericActivity.quality.expected_days ?? null,
            window_days: genericActivity.quality.window_days ?? null,
          },
          max_age_days: genericActivity.quality.freshness === "fresh" ? 1 : 3,
        }
      )
    );
  }

  const checkin = input.checkin;
  if (checkin?.energy != null)
    observations.push(
      observation(
        "recovery_capacity",
        "felt_energy",
        date,
        "user_checkin",
        Number(checkin.energy) <= 2 ? "constraint" : Number(checkin.energy) >= 4 ? "support" : "neutral",
        Number(checkin.energy) <= 2
          ? "You're feeling run-down today — rest is the smart call."
          : "The athlete reports workable energy today.",
        { safety_override: Number(checkin.energy) <= 2, max_age_days: 0 }
      )
    );
  if (checkin?.sleep_feel != null)
    observations.push(
      observation(
        "recovery_capacity",
        "sleep_feel",
        date,
        "user_checkin",
        Number(checkin.sleep_feel) <= 2 ? "constraint" : Number(checkin.sleep_feel) >= 4 ? "support" : "neutral",
        Number(checkin.sleep_feel) <= 2
          ? "The athlete feels poorly recovered despite any wearable reading."
          : "The athlete feels reasonably rested.",
        { safety_override: Number(checkin.sleep_feel) <= 2, max_age_days: 0 }
      )
    );
  if (checkin?.soreness != null)
    observations.push(
      observation(
        "training_load_tolerance",
        "felt_soreness",
        date,
        "user_checkin",
        Number(checkin.soreness) >= 4 ? "constraint" : "neutral",
        Number(checkin.soreness) >= 4
          ? "The athlete reports high soreness today."
          : "The athlete reports no high soreness today.",
        { safety_override: Number(checkin.soreness) >= 4, max_age_days: 0 }
      )
    );

  const autoreg = input.trainingSignals?.autoregulation;
  if (autoreg?.joint_areas?.length)
    observations.push(
      observation(
        "health_constraints",
        "joint_pain",
        date,
        "manual_session",
        "constraint",
        `Recent user-reported joint pain calls for pain-free substitutions around ${autoreg.joint_areas.join(", ")}.`,
        { safety_override: true, max_age_days: 7 }
      )
    );
  if (autoreg?.low_performance_flag)
    observations.push(
      observation(
        "training_load_tolerance",
        "felt_fatigue",
        date,
        "manual_session",
        "constraint",
        "Recent sessions felt below usual performance, so loading should ease.",
        { safety_override: true, max_age_days: 7 }
      )
    );
  else if (autoreg?.soreness_flag)
    observations.push(
      observation(
        "training_load_tolerance",
        "felt_soreness",
        date,
        "manual_session",
        "caution",
        "Recent session feedback shows elevated soreness.",
        { safety_override: true, max_age_days: 7 }
      )
    );

  const meso = input.programState?.mesocycle;
  if (meso?.phase === "deload-due")
    observations.push(
      observation(
        "training_load_tolerance",
        "mesocycle",
        date,
        "cairn_program_state",
        "constraint",
        meso.note || "Accumulated training load says recovery is due.",
        { max_age_days: 1 }
      )
    );
  else if (meso?.acute_chronic_ratio != null)
    observations.push(
      observation(
        "training_load_tolerance",
        "acute_load",
        date,
        "cairn_program_state",
        Number(meso.acute_chronic_ratio) > 1.5 ? "caution" : "support",
        Number(meso.acute_chronic_ratio) > 1.5
          ? "Acute training load is running above the established base."
          : "Training load is within the established tolerance band.",
        { max_age_days: 1 }
      )
    );
  if (input.programState?.hybrid?.status === "fuel-protect")
    observations.push(
      observation(
        "energy_fueling",
        "hybrid_fuel",
        date,
        "cairn_hybrid_state",
        "constraint",
        input.programState.hybrid.headline || "Recent endurance work raises fueling needs around the planned training.",
        { max_age_days: 2 }
      )
    );
  else if (input.programState?.hybrid?.status && input.programState.hybrid.status !== "clear")
    observations.push(
      observation(
        "training_load_tolerance",
        "hybrid_interference",
        date,
        "cairn_hybrid_state",
        "caution",
        input.programState.hybrid.headline ||
          "Recent endurance work changes how the next strength session should land.",
        { max_age_days: 2 }
      )
    );

  const exp = input.expenditure;
  if (exp?.tdee != null)
    observations.push(
      observation(
        "energy_fueling",
        "expenditure",
        date,
        String(exp.prior_basis || exp.tdee_basis || "cairn_expenditure"),
        exp.quality?.intake === "partial" || exp.quality?.outcome?.startsWith?.("implausible")
          ? "caution"
          : exp.confidence === "high"
            ? "support"
            : "neutral",
        exp.quality?.explanation || exp.basis || "Energy balance is still settling.",
        {
          coverage: {
            samples: Number(exp.points) || 1,
            expected: exp.window_days ?? null,
            window_days: exp.window_days ?? null,
          },
          max_age_days: 3,
        }
      )
    );

  const underfueling = input.underfueling;
  if (["execution_gap", "prescription_strain", "settling", "persistent_strain"].includes(String(underfueling?.state))) {
    const persistent = underfueling.state === "persistent_strain";
    const protective = ["prescription_strain", "persistent_strain"].includes(String(underfueling.state));
    observations.push(
      observation(
        "energy_fueling",
        "underfueling_control",
        date,
        "cairn_underfueling",
        protective ? "constraint" : "caution",
        String(underfueling.action?.line || underfueling.rationale || "Fuel availability is being protected."),
        {
          coverage: { samples: Number(underfueling.agreeing_channels?.length) || 1, window_days: 14 },
          max_age_days: 1,
        }
      )
    );
    if (
      persistent ||
      (underfueling.action?.training === "hold_aggression" && underfueling.state !== "prescription_strain")
    ) {
      observations.push(
        observation(
          "training_load_tolerance",
          "fuel_protection",
          date,
          "cairn_underfueling",
          persistent ? "constraint" : "caution",
          persistent
            ? "Independent fuel, performance, and recovery channels still show strain after the correction settled, so the next training dose should reduce."
            : "Fuel and outcome signals agree enough to hold progression aggression while the next correction settles.",
          { max_age_days: 1 }
        )
      );
    }
  }

  const context = input.context;
  const activeLoadContexts = Array.isArray(context?.active)
    ? context.active.filter((item: any) => item?.reduce_load !== false)
    : [];
  const activeInjuries = activeLoadContexts.filter((item: any) => String(item?.kind ?? "") === "injury");
  const activeIllnesses = activeLoadContexts.filter(
    (item: any) => String(item?.kind ?? "") !== "injury" && item?.reduce_load === true
  );
  const injurySummary = activeInjuries[0]
    ? [activeInjuries[0]?.title, activeInjuries[0]?.reason].filter(Boolean).join(": ")
    : "";
  if (context?.reduce_load && activeInjuries.length)
    observations.push(
      observation(
        "health_constraints",
        "active_injury",
        date,
        "user_context",
        "constraint",
        injurySummary || "An active injury calls for easing or working around load.",
        { safety_override: true, max_age_days: 0 }
      )
    );
  if (context?.reduce_load && activeIllnesses.length)
    observations.push(
      observation(
        "health_constraints",
        "illness",
        date,
        "user_context",
        "constraint",
        activeIllnesses[0]?.reason || "An active illness calls for protecting recovery.",
        { safety_override: true, max_age_days: 0 }
      )
    );
  if (context?.reduce_load && !activeInjuries.length && !activeIllnesses.length)
    observations.push(
      observation(
        "health_constraints",
        "active_health_constraint",
        date,
        "user_context",
        "constraint",
        "An active health constraint calls for easing or working around load.",
        { safety_override: true, max_age_days: 0 }
      )
    );
  if (context?.fueling_disrupted)
    observations.push(
      observation(
        "energy_fueling",
        "routine_disruption",
        date,
        "user_context",
        "caution",
        "Current travel or illness may disrupt normal fueling.",
        { max_age_days: 0 }
      )
    );
  if (context?.expect_worse_sleep)
    observations.push(
      observation(
        "life_capacity",
        "schedule_pressure",
        date,
        "user_context",
        "caution",
        "A current commitment or stressful stretch is likely to compress recovery capacity.",
        { max_age_days: 0 }
      )
    );
  const activePressure = (Array.isArray(input.contextEvents) ? input.contextEvents : []).filter(
    (event) =>
      event &&
      event.start_date <= date &&
      (!event.end_date || event.end_date >= date) &&
      /trip|life_event|family_event/.test(String(event.kind || ""))
  );
  if (activePressure.length && !context?.expect_worse_sleep)
    observations.push(
      observation(
        "life_capacity",
        "schedule_pressure",
        date,
        "user_context",
        "caution",
        `${activePressure[0].title || "A current commitment"} adds schedule pressure today.`,
        { max_age_days: 0, observation_id: `life:${activePressure[0].id ?? activePressure[0].title}` }
      )
    );
  if (input.completedToday)
    observations.push(
      observation(
        "training_load_tolerance",
        "completed_today",
        date,
        "cairn_training_log",
        "support",
        "Today's planned work is already complete.",
        { max_age_days: 0 }
      )
    );

  return buildUnifiedSignalState(date, observations);
}
