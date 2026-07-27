import crypto from "node:crypto";
import { db } from "../db.js";
import { getCheckinByDate, getRecoverySummary } from "./coach.js";
import { dayRead } from "./day-read.js";
import {
  equipmentCompatibility,
  inferExerciseEquipment,
  parseEquipmentCapability,
} from "./equipment-capability.js";
import { findExercise } from "./exercises.js";
import { getInjuryImpacts, listContextEvents } from "./health.js";
import { recentEnduranceImpacts, recentMuscleLoad } from "./hybrid-load.js";
import { getPlanDay } from "./plan.js";
import { selectAdaptivePlanDay, selectedPlanDayForDate } from "./plan-selection.js";
import { getProgramState } from "./program-state.js";
import { muscleGroupsForPainArea, painAreaLoadsExercise } from "./pain-relevance.js";
import { planDayProgression, recentAutoregulation } from "./progression.js";
import { adaptBasePlanDayForRecovery, recoveryCycleAt } from "./recovery-cycles.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { listTrainingSymptoms } from "./training-symptoms.js";

// The deterministic daily-decision envelope (Stage 2 of the adaptive daily
// training plan, docs/ADAPTIVE_DAILY_TRAINING_PLAN.md §4). This is the
// explainable, reproducible default the athlete sees BEFORE any agent is
// involved: a bounded snapshot of the day's signals in, a versioned decision
// envelope out. The same snapshot always yields the same envelope and
// `input_fingerprint`. It never fabricates certainty — missing signals degrade
// to the existing adaptive plan selection rather than failing.
//
// Design note: the train/easy/rest KIND is delegated to the already-tested
// deterministic `dayRead()` (which folds recovery, soreness, consecutive
// training days, illness/travel and endurance volume into that read) rather
// than re-derived here — duplicating that logic would risk it drifting out of
// sync with the Brief. Stage 2 layers the movement/muscle/caps ENVELOPE and the
// reason-coded rationale on top of that kind. See the wave report for this
// intentional deviation from the doc's "re-derive precedence 3" wording.

export const DAILY_DECISION_POLICY_VERSION = "daily_decision_v3";

export const DAILY_DECISION_REASONS = [
  "injury_exclusion",
  "injury_recheck",
  "joint_pain_reduce",
  "equipment_limited",
  "low_recovery_rest",
  "low_recovery_easy",
  "high_soreness",
  "recent_underperformance",
  "repeated_underperformance",
  "illness_window",
  "travel_window",
  "consecutive_training_days",
  "endurance_lower_conflict",
  "muscle_saturated",
  "muscle_due",
  "progression_overload",
  "progression_hold",
  "progression_deload",
  "progression_vary",
  "progression_introduce",
  "time_constrained",
  "athlete_override",
  "template_rotation",
] as const;

export type DailyDecisionReason = (typeof DAILY_DECISION_REASONS)[number];

export type DailyDecisionKind = "train" | "easy" | "rest";

export interface DailyDecisionSnapshot {
  date: string;
  request: {
    override: string | null;
    train_anyway: boolean;
    equipment: string | null;
    minutes: number | null;
    goal: string | null;
  };
  plan: {
    day_number: number | null;
    focus: string | null;
    plan_day_id: number | null;
    source: string | null;
    reason: string | null;
    due: string[];
    over: string[];
  };
  day_read: {
    kind: "train" | "easy" | "rest" | "done" | null;
    focus: string | null;
    est_minutes: number | null;
    consecutive_training_days: number | null;
    recovery_week: boolean;
    trained_today: boolean;
  };
  recovery: {
    has_data: boolean;
    readiness: "low" | "moderate" | "high" | null;
    hrv_drift: "down" | "flat" | "up" | null;
    rhr_drift: "down" | "flat" | "up" | null;
    sleep_drift: "down" | "flat" | "up" | null;
  };
  recovery_cycle: {
    id: number;
    effective_status: "active" | "recheck";
    effective_on: string;
    recheck_on: string;
    exit_on: string;
    working_set_fraction: number;
  } | null;
  muscle_load: Array<{ group: string; days_ago: number; heavy: boolean; source: string }>;
  endurance: Array<{ type: string; days_ago: number; intensity: string; load: string; regions: string[] }>;
  checkin: { soreness: number | null; energy: number | null; sleep_feel: number | null } | null;
  feedback: {
    soreness: number | null;
    performance: number | null;
    joint_pain: string | null;
    low_performance_count?: number;
  } | null;
  constraints: {
    injuries: Array<{
      title: string;
      constraint_level: "protective" | "soft_recheck";
      areas: string[];
      exercises: string[];
    }>;
    illness: boolean;
    travel: boolean;
  };
  program: {
    mesocycle_phase: string | null;
    adaptations_due: string[];
    volume_low_groups: string[];
    volume_high_groups: string[];
  };
  progression: Array<{
    exercise: string;
    muscle_group: string | null;
    action: string;
    why: string;
    vary_to: string | null;
  }>;
  plan_items: Array<{
    exercise: string;
    muscle_group: string | null;
    equipment: string | null;
    mode: string;
    kind: string;
    sets?: number | null;
    rep_low?: number | null;
    rep_high?: number | null;
    target_weight?: number | null;
    target_seconds?: number | null;
    target_distance_km?: number | null;
    target_duration_min?: number | null;
    target_zone?: string | null;
  }>;
}

export interface DailyDecisionCandidate {
  exercise: string;
  muscle_group: string | null;
  action: "overload" | "hold" | "deload" | "vary" | "introduce" | "carry" | "exclude";
  reason_code: DailyDecisionReason | null;
  substitution_for: string | null;
  note: string | null;
}

export interface DailyDecisionEnvelope {
  policy_version: string;
  input_fingerprint: string;
  generated_at: string;
  date: string;
  kind: DailyDecisionKind;
  baseline_kind: DailyDecisionKind;
  request: {
    override: string | null;
    train_anyway: boolean;
    equipment: string | null;
    minutes: number | null;
    goal: string | null;
  };
  template: {
    day_number: number | null;
    plan_day_id: number | null;
    focus: string | null;
    intent: "template" | "custom";
  };
  muscles: { required: string[]; allowed: string[]; reduced: string[]; excluded: string[] };
  caps: {
    volume: "minimal" | "reduced" | "normal";
    intensity: "easy" | "deload" | "hold" | "normal";
    duration_min: number | null;
  };
  recovery_cycle: DailyDecisionSnapshot["recovery_cycle"];
  candidates: DailyDecisionCandidate[];
  hard_constraints: Array<{ code: DailyDecisionReason; detail: string }>;
  soft_preferences: Array<{ code: DailyDecisionReason; detail: string }>;
  rationale: Array<{ code: DailyDecisionReason; text: string }>;
  precedence: DailyDecisionReason[];
}

const KNEE_GROUPS = ["quads", "hamstrings", "calves", "glutes"];

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown, max = 200): string | null {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function dedupe(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw == null ? "" : String(raw).trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// A stable, key-sorted serialization so two evaluations of an equivalent snapshot
// hash identically regardless of object key insertion order.
function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

export function dailyDecisionFingerprint(snapshot: DailyDecisionSnapshot): string {
  return crypto.createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

function driftOf(value: unknown): "down" | "flat" | "up" | null {
  const n = finite(value);
  if (n == null) return null;
  if (n <= -0.5) return "down";
  if (n >= 0.5) return "up";
  return "flat";
}

function recoveryReadiness(recovery: any): "low" | "moderate" | "high" | null {
  const r = recovery?.recovery ?? recovery ?? {};
  const candidates = [r.training_readiness, r.avg_training_readiness, recovery?.quality?.training_readiness];
  for (const c of candidates) {
    const n = finite(c);
    if (n == null) continue;
    if (n >= 66) return "high";
    if (n >= 40) return "moderate";
    return "low";
  }
  return null;
}

const ILLNESS_RE = /\b(ill|sick|flu|cold|fever|covid|infection|unwell)\b/i;
const TRAIN_INTENT_RE =
  /^(?:(?:i|we)\s+(?:still\s+)?(?:(?:want|choose|plan|intend)\s+to|(?:am|are)\s+going\s+to|will|can)\s+)?(?:train anyway|train|lift|push|do (?:the )?full (?:session|workout)|full (?:session|workout))(?:\s+(?:today|now|anyway))?[.!]?$/i;
const NEGATED_TRAIN_INTENT_RE =
  /\b(?:do not|don't|cannot|can't|won't|shouldn't|mustn't|not going to|unable to|skip|avoid|no)\b[\s\S]{0,40}\b(?:train|lift|push|session|workout)\b/i;

export function isTrainIntentOverride(value: unknown): boolean {
  const input = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return !!input && !NEGATED_TRAIN_INTENT_RE.test(input) && TRAIN_INTENT_RE.test(input);
}

function recentLowPerformanceCount(date: string): number {
  const since = addDaysISO(date, -42) ?? date;
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT s.date
           FROM sessions s
           LEFT JOIN daily_session_compositions d
             ON d.session_id = s.id AND d.status = 'active'
          WHERE s.date >= ? AND s.date <= ?
            AND COALESCE(s.kind, 'strength') = 'strength'
            AND s.performance <= 2
            AND (
              d.id IS NULL
              OR json_extract(d.provenance_json, '$.daily_decision.caps.intensity') IS NULL
              OR json_extract(d.provenance_json, '$.daily_decision.caps.intensity') = 'normal'
            )
          ORDER BY s.date DESC
          LIMIT 2`
      )
      .all(since, date) as any[];
    return rows.length;
  } catch {
    return 0;
  }
}

// Gather the bounded, serializable decision snapshot for a date. Every source is
// read defensively: an absent optional signal degrades to null/empty rather than
// throwing, so the policy always has SOMETHING to decide from (at minimum the
// adaptive plan selection). No raw health payloads are captured — only bounded,
// render-safe derived facts (per docs §4 / §11 observability).
export function gatherDailyDecisionSnapshot(
  date?: string,
  opts: {
    override?: string | null;
    train_anyway?: boolean;
    equipment?: string | null;
    minutes?: number | null;
    goal?: string | null;
  } = {}
): DailyDecisionSnapshot {
  const d = String(date || localDateISO()).slice(0, 10);

  let selected = safe(() => selectedPlanDayForDate(d), null);
  // Preparing an adaptive session creates and links an otherwise-empty session
  // row. That row is persistence plumbing, not new coaching evidence. Re-run the
  // original adaptive selector while the composition is unstarted so an exact
  // lost-response retry does not refresh solely because its own row now says
  // source=existing-session.
  if (selected?.source === "existing-session" && hasUnstartedAdaptiveComposition(d)) {
    const adaptive = safe(() => selectAdaptivePlanDay(d), null);
    const adaptiveDay = adaptive?.day_number != null ? safe(() => getPlanDay(adaptive.day_number), null) : null;
    if (adaptive && adaptiveDay) {
      selected = {
        date: d,
        plan_day_id: Number(adaptiveDay.id),
        day_number: adaptive.day_number,
        focus: adaptive.focus,
        selection: adaptive.selection,
        source: "adaptive" as const,
      };
    }
  }
  const basePlanDay = selected?.day_number != null ? safe(() => getPlanDay(selected.day_number), null) : null;
  const recoveryCycle = safe(() => recoveryCycleAt(d), null);
  const activeCycle =
    recoveryCycle &&
    recoveryCycle.id != null &&
    (recoveryCycle.effective_status === "active" || recoveryCycle.effective_status === "recheck")
      ? recoveryCycle
      : null;
  const planDay =
    basePlanDay && activeCycle ? adaptBasePlanDayForRecovery(basePlanDay, activeCycle.overlay) : basePlanDay;
  const selection = (selected?.selection ?? {}) as Record<string, any>;

  const recoverySummary = safe(() => getRecoverySummary(14, undefined, d), null);
  const read = safe(() => dayRead(d, recoverySummary), null);
  const signals = (read?.signals ?? {}) as Record<string, any>;

  const injuryImpacts = safe(() => getInjuryImpacts(d), { injuries: [], count: 0 }) as any;
  const contextEvents = safe(() => listContextEvents({ activeOnly: true, on: d }), []) as any[];
  const symptomEvents = (
    safe(() => listTrainingSymptoms({ on: d, seed_legacy: false }), []) as any[]
  ).filter((event) => event.source_kind !== "legacy_session_feedback");

  const autoreg = safe(() => recentAutoregulation(undefined, d), {
    soreness: null,
    performance: null,
    joint_pain: null,
    date: null,
  });
  const checkinRow = safe(() => getCheckinByDate(d), null) as any;

  const muscleLoad = safe(() => recentMuscleLoad(2, d), new Map()) as Map<string, any>;
  const endurance = safe(() => recentEnduranceImpacts(3, d), []) as any[];

  const programState = safe(() => getProgramState(d, recoverySummary), null) as any;
  const progression =
    selected?.day_number != null ? (safe(() => planDayProgression(selected.day_number), []) as any[]) : [];

  const override = text(opts.override, 200);
  const contextInjuries = (Array.isArray(injuryImpacts?.injuries) ? injuryImpacts.injuries : []).map((inj: any) => ({
    title: text(inj?.title ?? inj?.text, 120) ?? "injury",
    constraint_level: inj?.constraint_level === "soft_recheck" ? ("soft_recheck" as const) : ("protective" as const),
    areas: dedupe([...(Array.isArray(inj?.areas) ? inj.areas : []), inj?.area]),
    exercises: dedupe((Array.isArray(inj?.affected) ? inj.affected : []).map((a: any) => a?.exercise)).slice(0, 12),
  }));
  const symptomInjuries = symptomEvents.slice(0, 8).map((event) => {
    const area = text(event.area_text, 300) ?? "reported discomfort";
    const affected = (Array.isArray(planDay?.items) ? planDay.items : [])
      .filter((item: any) =>
        painAreaLoadsExercise(area, {
          name: item?.exercise,
          muscle_group: item?.muscle_group,
        })
      )
      .map((item: any) => item?.exercise);
    return {
      title: `Reported ${area}`.slice(0, 120),
      constraint_level:
        event.freshness === "acute_movement_brake" ? ("protective" as const) : ("soft_recheck" as const),
      areas: [area.toLowerCase()],
      exercises: dedupe(affected).slice(0, 12),
    };
  });
  return {
    date: d,
    request: {
      override,
      // `train_anyway` is a first-class request bit. Recognizing the legacy
      // phrase keeps cached/offline requests from older clients replayable
      // without letting arbitrary "train" prose silently become an override.
      train_anyway: opts.train_anyway === true || isTrainIntentOverride(override),
      equipment: text(opts.equipment, 200),
      minutes: opts.minutes != null ? finite(opts.minutes) : null,
      goal: text(opts.goal, 120),
    },
    plan: {
      day_number: selected?.day_number ?? null,
      focus: text(selected?.focus ?? planDay?.focus ?? null, 160),
      plan_day_id: selected?.plan_day_id ?? planDay?.id ?? null,
      source: text(selected?.source ?? null, 40),
      reason: text(selection?.reason ?? null, 300),
      due: dedupe(Array.isArray(selection?.due) ? selection.due : []),
      over: dedupe(Array.isArray(selection?.over) ? selection.over : []),
    },
    day_read: {
      kind: (read?.kind as any) ?? null,
      focus: text(read?.focus ?? null, 160),
      est_minutes: finite(read?.est_minutes),
      consecutive_training_days: finite(signals?.consecutive_training_days),
      recovery_week: signals?.recovery_week != null && signals.recovery_week !== false,
      trained_today: signals?.trained_today === true || signals?.logged_today === true,
    },
    recovery: {
      has_data: recoverySummary?.has_data === true,
      readiness: recoveryReadiness(recoverySummary),
      hrv_drift: driftOf(recoverySummary?.delta?.hrv),
      rhr_drift: driftOf(recoverySummary?.delta?.rhr),
      sleep_drift: driftOf(recoverySummary?.delta?.sleep),
    },
    recovery_cycle: activeCycle
      ? {
          id: Number(activeCycle.id),
          effective_status: activeCycle.effective_status as "active" | "recheck",
          effective_on: activeCycle.effective_on,
          recheck_on: activeCycle.recheck_on,
          exit_on: activeCycle.exit_on,
          working_set_fraction: Number(activeCycle.overlay?.working_set_fraction ?? 0.5),
        }
      : null,
    muscle_load: [...muscleLoad.values()]
      .map((rl: any) => ({
        group: String(rl?.group ?? "").toLowerCase(),
        days_ago: finite(rl?.days_ago) ?? 0,
        heavy: rl?.heavy === true,
        source: text(rl?.source, 20) ?? "strength",
      }))
      .filter((rl) => rl.group)
      .sort((a, b) => a.group.localeCompare(b.group)),
    endurance: endurance
      .map((e: any) => ({
        type: text(e?.type, 40) ?? "cardio",
        days_ago: finite(e?.days_ago) ?? 0,
        intensity: text(e?.intensity, 20) ?? "moderate",
        load: text(e?.load, 20) ?? "moderate",
        regions: dedupe(Array.isArray(e?.regions) ? e.regions : []),
      }))
      .sort((a, b) => a.days_ago - b.days_ago || a.type.localeCompare(b.type)),
    checkin: checkinRow
      ? {
          soreness: finite(checkinRow.soreness),
          energy: finite(checkinRow.energy),
          sleep_feel: finite(checkinRow.sleep_feel),
        }
      : null,
    feedback:
      autoreg.soreness != null || autoreg.performance != null || autoreg.joint_pain
        ? {
            soreness: finite(autoreg.soreness),
            performance: finite(autoreg.performance),
            joint_pain: text(autoreg.joint_pain, 300),
            low_performance_count: recentLowPerformanceCount(d),
          }
        : null,
    constraints: {
      injuries: [...contextInjuries, ...symptomInjuries].slice(0, 16),
      illness: contextEvents.some((e) => ILLNESS_RE.test(`${e?.title ?? ""} ${e?.detail ?? ""}`)),
      travel: contextEvents.some((e) => e?.kind === "trip"),
    },
    program: {
      mesocycle_phase: text(programState?.mesocycle?.phase, 40),
      adaptations_due: dedupe(Array.isArray(programState?.adaptations_due) ? programState.adaptations_due : []).slice(
        0,
        12
      ),
      volume_low_groups: dedupe(
        (Array.isArray(programState?.volume) ? programState.volume : [])
          .filter((v: any) => v?.band === "low")
          .map((v: any) => v?.muscle_group)
      ),
      volume_high_groups: dedupe(
        (Array.isArray(programState?.volume) ? programState.volume : [])
          .filter((v: any) => v?.band === "high")
          .map((v: any) => v?.muscle_group)
      ),
    },
    progression: progression
      .map((p: any) => ({
        exercise: text(p?.exercise, 120) ?? "",
        muscle_group: null as string | null,
        action: text(p?.action, 20) ?? "hold",
        why: text(p?.why, 240) ?? "",
        vary_to: text(p?.vary_to ?? p?.vary_options?.[0]?.name, 120),
      }))
      .filter((p) => p.exercise)
      .slice(0, 24),
    plan_items: (Array.isArray(planDay?.items) ? planDay.items : [])
      .map((it: any) => ({
        exercise: text(it?.exercise, 120) ?? "",
        muscle_group: text(it?.muscle_group, 40),
        equipment: text(findExercise(String(it?.exercise ?? ""))?.equipment, 40),
        mode: text(it?.mode, 20) ?? "reps",
        kind: text(it?.kind, 20) ?? "strength",
        sets: finite(it?.sets),
        rep_low: finite(it?.rep_low),
        rep_high: finite(it?.rep_high),
        target_weight: finite(it?.target_weight),
        target_seconds: finite(it?.target_seconds),
        target_distance_km: finite(it?.target_distance_km),
        target_duration_min: finite(it?.target_duration_min),
        target_zone: text(it?.target_zone, 40),
      }))
      .filter((it: any) => it.exercise)
      .slice(0, 24),
  };
}

function hasUnstartedAdaptiveComposition(date: string): boolean {
  try {
    return !!db
      .prepare(
        `SELECT d.id
           FROM daily_session_compositions d
           JOIN sessions s ON s.id = d.session_id
          WHERE d.date = ? AND d.status = 'active' AND d.source = 'adaptive_plan'
            AND NOT EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM session_skips ss WHERE ss.session_id = s.id)
            AND s.finished_at IS NULL
            AND s.duration_min IS NULL
            AND NULLIF(TRIM(COALESCE(s.notes, '')), '') IS NULL
            AND s.soreness IS NULL
            AND s.performance IS NULL
            AND NULLIF(TRIM(COALESCE(s.joint_pain, '')), '') IS NULL
            AND NULLIF(TRIM(COALESCE(s.garmin_json, '')), '') IS NULL
          LIMIT 1`
      )
      .get(date);
  } catch {
    return false;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Groups an active/joint-pain injury excludes from loaded work today. Injury
// `areas` are body areas; joint pain maps through the shared JOINT_GROUP_MAP so
// "left knee" reduces quads/hams/calves the same way every other consumer sees.
function excludedGroups(snapshot: DailyDecisionSnapshot): { groups: string[]; jointGroups: string[] } {
  const injuryGroups: string[] = [];
  for (const inj of snapshot.constraints.injuries) {
    if ((inj.constraint_level ?? "protective") !== "protective") continue;
    for (const area of inj.areas) injuryGroups.push(...muscleGroupsForPainArea(area));
  }
  const jointText = snapshot.feedback?.joint_pain ?? null;
  const jointGroups: string[] = [];
  if (jointText) {
    // Reuse the movement-level relevance test on the plan items to find groups the
    // sore joint loads. Deterministic and conservative (unmapped text → nothing).
    for (const it of snapshot.plan_items) {
      if (it.muscle_group && painAreaLoadsExercise(jointText, { name: it.exercise, muscle_group: it.muscle_group })) {
        jointGroups.push(it.muscle_group);
      }
    }
    if (/knee/i.test(jointText)) jointGroups.push(...KNEE_GROUPS);
  }
  return { groups: dedupe(injuryGroups), jointGroups: dedupe(jointGroups) };
}

const PROGRESSION_REASON: Record<string, DailyDecisionReason> = {
  overload: "progression_overload",
  hold: "progression_hold",
  deload: "progression_deload",
  vary: "progression_vary",
  introduce: "progression_introduce",
};

// The pure decision. A bounded snapshot in, a versioned reason-coded envelope
// out. Deterministic apart from `generated_at` (which is excluded from the
// fingerprint), so the same snapshot always produces the same fingerprint AND
// the same decision content.
export function buildDailySessionDecision(
  snapshot: DailyDecisionSnapshot,
  opts: { now?: string } = {}
): DailyDecisionEnvelope {
  const fingerprint = dailyDecisionFingerprint(snapshot);
  const precedence: DailyDecisionReason[] = [];
  const hard: Array<{ code: DailyDecisionReason; detail: string }> = [];
  const soft: Array<{ code: DailyDecisionReason; detail: string }> = [];
  const rationale: Array<{ code: DailyDecisionReason; text: string }> = [];
  const fire = (list: DailyDecisionReason[], code: DailyDecisionReason) => {
    if (!list.includes(code)) list.push(code);
  };

  // ---- Precedence 2: injury / joint pain / equipment (hard exclusions) ----
  const { groups: injuryGroups, jointGroups } = excludedGroups(snapshot);
  for (const inj of snapshot.constraints.injuries) {
    if ((inj.constraint_level ?? "protective") === "protective") {
      hard.push({ code: "injury_exclusion", detail: `Working around ${inj.title}` });
      fire(precedence, "injury_exclusion");
    } else {
      soft.push({ code: "injury_recheck", detail: `Recheck ${inj.title} on the affected movement` });
      fire(precedence, "injury_recheck");
    }
  }
  if (snapshot.feedback?.joint_pain) {
    soft.push({ code: "joint_pain_reduce", detail: `Reported ${snapshot.feedback.joint_pain}` });
    fire(precedence, "joint_pain_reduce");
  }
  if (snapshot.request.equipment) {
    const capability = parseEquipmentCapability(snapshot.request.equipment);
    if (capability.recognized) {
      hard.push({ code: "equipment_limited", detail: `Only what ${snapshot.request.equipment} allows` });
      fire(precedence, "equipment_limited");
    }
  }

  // ---- Precedence 3: recovery / soreness / illness / travel / consecutive ----
  // KIND itself comes from the already-tested dayRead; here we record WHY and set
  // caps. An explicit "train anyway" override still wins the kind below.
  const baseKind: DailyDecisionKind = (() => {
    const k = snapshot.day_read.kind;
    if (k === "rest") return "rest";
    if (k === "easy") return "easy";
    if (k === "done") return "rest";
    return "train";
  })();
  const highSoreness =
    (snapshot.feedback?.soreness != null && snapshot.feedback.soreness >= 4) ||
    (snapshot.checkin?.soreness != null && snapshot.checkin.soreness >= 4);
  const lowPerformance = snapshot.feedback?.performance != null && snapshot.feedback.performance <= 2;
  const repeatedUnder = lowPerformance && Number(snapshot.feedback?.low_performance_count ?? 1) >= 2;
  if (snapshot.recovery.readiness === "low") {
    fire(precedence, baseKind === "rest" ? "low_recovery_rest" : "low_recovery_easy");
    soft.push({
      code: baseKind === "rest" ? "low_recovery_rest" : "low_recovery_easy",
      detail: "Recovery is running low",
    });
  }
  if (highSoreness) {
    fire(precedence, "high_soreness");
    soft.push({ code: "high_soreness", detail: "Elevated soreness reported" });
  }
  if (repeatedUnder) {
    fire(precedence, "repeated_underperformance");
    soft.push({ code: "repeated_underperformance", detail: "Recent sessions felt underpowered" });
  } else if (lowPerformance) {
    fire(precedence, "recent_underperformance");
    soft.push({ code: "recent_underperformance", detail: "The latest session felt underpowered" });
  }
  if (snapshot.constraints.illness) {
    fire(precedence, "illness_window");
    soft.push({ code: "illness_window", detail: "Feeling-under-the-weather window" });
  }
  if (snapshot.constraints.travel) {
    fire(precedence, "travel_window");
    soft.push({ code: "travel_window", detail: "Traveling — keep it portable" });
  }
  const consecutive = snapshot.day_read.consecutive_training_days ?? 0;
  if (consecutive >= 3) {
    fire(precedence, "consecutive_training_days");
    soft.push({ code: "consecutive_training_days", detail: `${consecutive} training days in a row` });
  }

  // ---- Athlete override (docs §7: wins unless a hard safety bound) ----
  let kind = baseKind;
  const override = (snapshot.request.override ?? "").toLowerCase();
  const trainAnyway = snapshot.request.train_anyway === true || isTrainIntentOverride(override);
  let durationOverrideOnly = false;
  if (trainAnyway) {
    kind = "train";
    fire(precedence, "athlete_override");
    soft.push({ code: "athlete_override", detail: "You chose to train — recovery bounds still apply" });
    rationale.push({
      code: "athlete_override",
      text:
        baseKind === "rest"
          ? "Training by choice — the session stays shorter and more conservative today."
          : "Training by choice — today's safety context still shapes the session.",
    });
  } else if (override) {
    if (isTrainIntentOverride(override)) {
      kind = "train";
      fire(precedence, "athlete_override");
      soft.push({ code: "athlete_override", detail: "You asked to train — kept it conservative" });
    } else if (/\b(rest|off|skip|recover)\b/.test(override)) {
      kind = "rest";
      fire(precedence, "athlete_override");
      soft.push({ code: "athlete_override", detail: "You asked to rest today" });
    } else if (/\b(easy|light|tired|rough|short|quick|busy)\b/.test(override)) {
      if (/\b(short|quick|busy|time)\b/.test(override) && !/\b(easy|light|tired|rough)\b/.test(override)) {
        durationOverrideOnly = true;
      } else if (kind === "train") {
        kind = "easy";
      }
      fire(precedence, "athlete_override");
      soft.push({ code: "athlete_override", detail: "You flagged less capacity today" });
    }
  }

  // ---- Precedence 4: recent endurance load vs conflicting lower-body work ----
  const lowerGroups = new Set(["quads", "hamstrings", "glutes", "calves"]);
  const enduranceReduced: string[] = [];
  const heavyEndurance = snapshot.endurance.filter((e) => e.load === "heavy" || e.intensity === "hard");
  for (const e of heavyEndurance) {
    for (const region of e.regions) {
      if (lowerGroups.has(region.toLowerCase())) enduranceReduced.push(region.toLowerCase());
    }
  }
  if (enduranceReduced.length) {
    fire(precedence, "endurance_lower_conflict");
    soft.push({
      code: "endurance_lower_conflict",
      detail: `Recent ${heavyEndurance[0]?.type ?? "endurance"} already loaded the legs`,
    });
  }

  // ---- Precedence 5: balance due vs saturated muscle exposures ----
  const saturated = dedupe([
    ...snapshot.muscle_load.filter((m) => m.heavy && m.days_ago <= 1).map((m) => m.group),
    ...snapshot.program.volume_high_groups,
  ]);
  if (saturated.length) {
    fire(precedence, "muscle_saturated");
    soft.push({ code: "muscle_saturated", detail: `Recently saturated: ${saturated.join(", ")}` });
  }
  const due = dedupe([...snapshot.plan.due, ...snapshot.program.volume_low_groups]);
  if (due.length) {
    fire(precedence, "muscle_due");
    soft.push({ code: "muscle_due", detail: `Due for work: ${due.join(", ")}` });
  }

  // ---- Muscle envelope ----
  const excluded = dedupe([...injuryGroups, ...jointGroups]);
  const injuredExercises = new Set(
    snapshot.constraints.injuries
      .filter((injury) => (injury.constraint_level ?? "protective") === "protective")
      .flatMap((injury) => injury.exercises)
      .map((exercise) => exercise.toLowerCase())
  );
  const recheckExercises = new Set(
    snapshot.constraints.injuries
      .filter((injury) => injury.constraint_level === "soft_recheck")
      .flatMap((injury) => injury.exercises)
      .map((exercise) => exercise.toLowerCase())
  );
  const reduced = dedupe([...enduranceReduced, ...saturated, ...snapshot.plan.over]).filter(
    (g) => !excluded.includes(g)
  );
  const required = dedupe(snapshot.plan_items.map((it) => it.muscle_group).filter((g): g is string => !!g)).filter(
    (g) => !excluded.includes(g)
  );
  const allowed = dedupe([...required, ...due]).filter((g) => !excluded.includes(g) && !reduced.includes(g));

  // ---- Precedence 6: progression only where recent performance supports it ----
  const progByExercise = new Map<string, { action: string; why: string; vary_to: string | null }>();
  for (const p of snapshot.progression) {
    progByExercise.set(p.exercise.toLowerCase(), { action: p.action, why: p.why, vary_to: p.vary_to ?? null });
  }

  // ---- Precedence 7: time / life fit ----
  const requestMinutes = snapshot.request.minutes;
  if (requestMinutes != null && requestMinutes > 0) {
    fire(precedence, "time_constrained");
    hard.push({ code: "time_constrained", detail: `About ${Math.round(requestMinutes)} minutes` });
  }

  // ---- Precedence 8: template rotation as the stable fallback ----
  const planIntent: "template" | "custom" =
    snapshot.plan.day_number != null && snapshot.plan_items.length ? "template" : "custom";
  const intent: "template" | "custom" = kind === "rest" ? "custom" : planIntent;
  if (intent === "template") {
    fire(precedence, "template_rotation");
    rationale.push({
      code: "template_rotation",
      text:
        snapshot.plan.reason ??
        `Day ${snapshot.plan.day_number}${snapshot.plan.focus ? ` · ${snapshot.plan.focus}` : ""}`,
    });
  }

  // ---- Caps ----
  const deloadPhase =
    snapshot.program.mesocycle_phase === "deload" || snapshot.program.mesocycle_phase === "recovery";
  const softenVolume =
    kind === "easy" ||
    (trainAnyway && baseKind === "rest") ||
    snapshot.recovery.readiness === "low" ||
    highSoreness ||
    consecutive >= 3 ||
    snapshot.day_read.recovery_week;
  const volume: DailyDecisionEnvelope["caps"]["volume"] =
    kind === "rest" ? "minimal" : softenVolume ? "reduced" : "normal";
  const intensity: DailyDecisionEnvelope["caps"]["intensity"] =
    kind === "rest" || kind === "easy"
      ? "easy"
      : deloadPhase || repeatedUnder || (trainAnyway && baseKind === "rest")
        ? "deload"
        : snapshot.recovery.readiness === "low" || highSoreness || lowPerformance
          ? "hold"
          : "normal";
  let duration = requestMinutes ?? snapshot.day_read.est_minutes ?? null;
  if (duration != null) {
    if (kind === "rest") duration = Math.min(duration, 20);
    else if (kind === "easy") duration = Math.min(duration, 40);
    duration = Math.round(duration);
  }
  if (trainAnyway && baseKind === "rest") duration = Math.min(duration ?? 40, 40);
  if (durationOverrideOnly && duration != null) duration = Math.min(duration, 35);

  // ---- Candidates (template intent only; custom leaves composition to Stage 3) ----
  const candidates: DailyDecisionCandidate[] = [];
  if (intent === "template" && kind !== "rest") {
    for (const it of snapshot.plan_items) {
      const group = it.muscle_group ? it.muscle_group.toLowerCase() : null;
      if (injuredExercises.has(it.exercise.toLowerCase()) || (group && excluded.includes(group))) {
        candidates.push({
          exercise: it.exercise,
          muscle_group: it.muscle_group,
          action: "exclude",
          reason_code:
            injuredExercises.has(it.exercise.toLowerCase()) || (group != null && injuryGroups.includes(group))
              ? "injury_exclusion"
              : "joint_pain_reduce",
          substitution_for: null,
          note: "Swap for a pattern that spares the flagged area",
        });
        continue;
      }
      const prog = progByExercise.get(it.exercise.toLowerCase());
      let action: DailyDecisionCandidate["action"] = "carry";
      let reason: DailyDecisionReason | null = null;
      if (prog && PROGRESSION_REASON[prog.action]) {
        action = prog.action as DailyDecisionCandidate["action"];
        reason = PROGRESSION_REASON[prog.action];
      }
      if (recheckExercises.has(it.exercise.toLowerCase())) {
        action = "hold";
        reason = "injury_recheck";
      }
      // A saturated/reduced group holds load rather than advancing today.
      if (group && reduced.includes(group) && (action === "overload" || action === "carry")) {
        action = "hold";
        reason = saturated.includes(group) ? "muscle_saturated" : "endurance_lower_conflict";
      }
      if (lowPerformance && !repeatedUnder && (action === "overload" || action === "carry")) {
        action = "hold";
        reason = "recent_underperformance";
      }
      if (intensity === "deload" && (action === "overload" || action === "carry")) {
        action = "deload";
        reason = reason ?? "progression_deload";
      }
      const substitution =
        prog?.vary_to && (action === "vary" || action === "introduce") ? prog.vary_to : null;
      candidates.push({
        exercise: substitution ?? it.exercise,
        muscle_group: it.muscle_group,
        action,
        reason_code: reason,
        substitution_for: substitution ? it.exercise : null,
        note: prog?.why ?? null,
      });
      if (recheckExercises.has(it.exercise.toLowerCase())) {
        candidates[candidates.length - 1]!.note = "Recheck the affected movement before loading";
      }
    }
  }

  const equipmentCapability = parseEquipmentCapability(snapshot.request.equipment);
  if (equipmentCapability.recognized && equipmentCapability.restricted) {
    for (const candidate of candidates) {
      const stored = findExercise(candidate.exercise);
      const compatibility = equipmentCompatibility(
        equipmentCapability,
        inferExerciseEquipment(candidate.exercise, stored?.equipment)
      );
      if (compatibility !== "compatible") {
        candidate.action = "exclude";
        candidate.reason_code = "equipment_limited";
        candidate.note = "Unavailable with today's equipment";
      }
    }
  }

  // ---- Render-safe rationale ----
  rationale.push({
    code:
      kind === "rest"
        ? snapshot.constraints.illness
          ? "illness_window"
          : "low_recovery_rest"
        : kind === "easy"
          ? "low_recovery_easy"
          : "template_rotation",
    text:
      kind === "rest"
        ? "Today reads as a rest day — recovery earns tomorrow's work."
        : kind === "easy"
          ? "Today reads as an easy day — keep it light and short."
          : `Today reads as a training day${snapshot.plan.focus ? ` · ${snapshot.plan.focus}` : ""}.`,
  });

  return {
    policy_version: DAILY_DECISION_POLICY_VERSION,
    input_fingerprint: fingerprint,
    generated_at: opts.now ?? new Date().toISOString(),
    date: snapshot.date,
    kind,
    baseline_kind: baseKind,
    request: { ...snapshot.request, train_anyway: trainAnyway },
    template: {
      day_number: kind === "rest" ? null : snapshot.plan.day_number,
      plan_day_id: kind === "rest" ? null : snapshot.plan.plan_day_id,
      focus: kind === "rest" ? "Recovery" : snapshot.plan.focus,
      intent,
    },
    muscles: { required, allowed, reduced, excluded },
    caps: { volume, intensity, duration_min: duration },
    recovery_cycle: snapshot.recovery_cycle,
    candidates,
    hard_constraints: hard,
    soft_preferences: soft,
    rationale,
    precedence,
  };
}

// Convenience: gather + decide in one call for the surfaces. Pure-per-DB-state:
// two calls against the same database and date return equivalent envelopes (bar
// `generated_at`).
export function decideDailySession(
  date?: string,
  opts: {
    override?: string | null;
    train_anyway?: boolean;
    equipment?: string | null;
    minutes?: number | null;
    goal?: string | null;
  } = {},
  buildOpts: { now?: string } = {}
): { envelope: DailyDecisionEnvelope; snapshot: DailyDecisionSnapshot } {
  const snapshot = gatherDailyDecisionSnapshot(date, opts);
  return { envelope: buildDailySessionDecision(snapshot, buildOpts), snapshot };
}

// Persist the decision envelope (docs §4: "Stage 2 preparation persists enough
// decision metadata to explain why it was chosen"). Idempotent by fingerprint:
// re-recording the same decision for a date is a no-op, so a repeated prepare or
// diagnostic read never floods the table. Best-effort at the call site — a write
// failure must never break a prepare. Only render-safe envelope facts are stored.
export function recordDailySessionDecision(
  envelope: DailyDecisionEnvelope,
  opts: { composition_id?: number | null } = {}
): void {
  const existing = db
    .prepare(`SELECT id FROM daily_session_decisions WHERE date = ? AND input_fingerprint = ? LIMIT 1`)
    .get(envelope.date, envelope.input_fingerprint) as any;
  if (existing?.id) {
    if (opts.composition_id != null) {
      db.prepare(`UPDATE daily_session_decisions SET composition_id = ? WHERE id = ?`).run(
        Number(opts.composition_id),
        existing.id
      );
    }
    return;
  }
  db.prepare(
    `INSERT INTO daily_session_decisions (date, composition_id, policy_version, input_fingerprint, kind, envelope_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    envelope.date,
    opts.composition_id != null ? Number(opts.composition_id) : null,
    envelope.policy_version,
    envelope.input_fingerprint,
    envelope.kind,
    JSON.stringify(envelope)
  );
}

export function getLatestDailySessionDecision(date?: string): DailyDecisionEnvelope | null {
  const d = String(date || localDateISO()).slice(0, 10);
  const row = db
    .prepare(`SELECT envelope_json FROM daily_session_decisions WHERE date = ? ORDER BY id DESC LIMIT 1`)
    .get(d) as any;
  if (!row?.envelope_json) return null;
  try {
    return JSON.parse(row.envelope_json) as DailyDecisionEnvelope;
  } catch {
    return null;
  }
}
