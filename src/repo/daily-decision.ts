import crypto from "node:crypto";
import { db } from "../db.js";
import { getCheckinByDate, getRecoverySummary } from "./coach.js";
import { dayRead } from "./day-read.js";
import { getInjuryImpacts, listContextEvents } from "./health.js";
import { recentEnduranceImpacts, recentMuscleLoad } from "./hybrid-load.js";
import { getPlanDay } from "./plan.js";
import { selectedPlanDayForDate } from "./plan-selection.js";
import { getProgramState } from "./program-state.js";
import { painAreaLoadsExercise, planDayProgression, recentAutoregulation } from "./progression.js";
import { localDateISO } from "./shared.js";

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

export const DAILY_DECISION_POLICY_VERSION = "daily_decision_v1";

export const DAILY_DECISION_REASONS = [
  "injury_exclusion",
  "joint_pain_reduce",
  "equipment_limited",
  "low_recovery_rest",
  "low_recovery_easy",
  "high_soreness",
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
  request: { override: string | null; equipment: string | null; minutes: number | null; goal: string | null };
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
  muscle_load: Array<{ group: string; days_ago: number; heavy: boolean; source: string }>;
  endurance: Array<{ type: string; days_ago: number; intensity: string; load: string; regions: string[] }>;
  checkin: { soreness: number | null; energy: number | null; sleep_feel: number | null } | null;
  feedback: { soreness: number | null; performance: number | null; joint_pain: string | null } | null;
  constraints: {
    injuries: Array<{ title: string; areas: string[]; exercises: string[] }>;
    illness: boolean;
    travel: boolean;
  };
  program: {
    mesocycle_phase: string | null;
    adaptations_due: string[];
    volume_low_groups: string[];
    volume_high_groups: string[];
  };
  progression: Array<{ exercise: string; muscle_group: string | null; action: string; why: string }>;
  plan_items: Array<{ exercise: string; muscle_group: string | null; mode: string; kind: string }>;
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
  template: { day_number: number | null; focus: string | null; intent: "template" | "custom" };
  muscles: { required: string[]; allowed: string[]; reduced: string[]; excluded: string[] };
  caps: {
    volume: "minimal" | "reduced" | "normal";
    intensity: "easy" | "deload" | "hold" | "normal";
    duration_min: number | null;
  };
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

// Gather the bounded, serializable decision snapshot for a date. Every source is
// read defensively: an absent optional signal degrades to null/empty rather than
// throwing, so the policy always has SOMETHING to decide from (at minimum the
// adaptive plan selection). No raw health payloads are captured — only bounded,
// render-safe derived facts (per docs §4 / §11 observability).
export function gatherDailyDecisionSnapshot(
  date?: string,
  opts: { override?: string | null; equipment?: string | null; minutes?: number | null; goal?: string | null } = {}
): DailyDecisionSnapshot {
  const d = String(date || localDateISO()).slice(0, 10);

  const selected = safe(() => selectedPlanDayForDate(d), null);
  const planDay = selected?.day_number != null ? safe(() => getPlanDay(selected.day_number), null) : null;
  const selection = (selected?.selection ?? {}) as Record<string, any>;

  const recoverySummary = safe(() => getRecoverySummary(14), null);
  const read = safe(() => dayRead(d, recoverySummary), null);
  const signals = (read?.signals ?? {}) as Record<string, any>;

  const injuryImpacts = safe(() => getInjuryImpacts(), { injuries: [], count: 0 }) as any;
  const contextEvents = safe(() => listContextEvents({ activeOnly: true }), []) as any[];

  const autoreg = safe(() => recentAutoregulation(), {
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

  return {
    date: d,
    request: {
      override: text(opts.override, 200),
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
          }
        : null,
    constraints: {
      injuries: (Array.isArray(injuryImpacts?.injuries) ? injuryImpacts.injuries : [])
        .map((inj: any) => ({
          title: text(inj?.title ?? inj?.text, 120) ?? "injury",
          areas: dedupe(Array.isArray(inj?.areas) ? inj.areas : []),
          exercises: dedupe((Array.isArray(inj?.affected) ? inj.affected : []).map((a: any) => a?.name)).slice(0, 12),
        }))
        .slice(0, 8),
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
      }))
      .filter((p) => p.exercise)
      .slice(0, 24),
    plan_items: (Array.isArray(planDay?.items) ? planDay.items : [])
      .map((it: any) => ({
        exercise: text(it?.exercise, 120) ?? "",
        muscle_group: text(it?.muscle_group, 40),
        mode: text(it?.mode, 20) ?? "reps",
        kind: text(it?.kind, 20) ?? "strength",
      }))
      .filter((it: any) => it.exercise)
      .slice(0, 24),
  };
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
  for (const inj of snapshot.constraints.injuries) injuryGroups.push(...inj.areas);
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
    hard.push({ code: "injury_exclusion", detail: `Working around ${inj.title}` });
    fire(precedence, "injury_exclusion");
  }
  if (snapshot.feedback?.joint_pain) {
    soft.push({ code: "joint_pain_reduce", detail: `Reported ${snapshot.feedback.joint_pain}` });
    fire(precedence, "joint_pain_reduce");
  }
  if (snapshot.request.equipment) {
    hard.push({ code: "equipment_limited", detail: `Only what ${snapshot.request.equipment} allows` });
    fire(precedence, "equipment_limited");
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
  const repeatedUnder = snapshot.feedback?.performance != null && snapshot.feedback.performance <= 2;
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
  let durationOverrideOnly = false;
  if (override) {
    if (/\b(train|lift|go hard|anyway|push|full)\b/.test(override)) {
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
  const reduced = dedupe([...enduranceReduced, ...saturated, ...snapshot.plan.over]).filter(
    (g) => !excluded.includes(g)
  );
  const required = dedupe(snapshot.plan_items.map((it) => it.muscle_group).filter((g): g is string => !!g)).filter(
    (g) => !excluded.includes(g)
  );
  const allowed = dedupe([...required, ...due]).filter((g) => !excluded.includes(g) && !reduced.includes(g));

  // ---- Precedence 6: progression only where recent performance supports it ----
  const progByExercise = new Map<string, { action: string; why: string }>();
  for (const p of snapshot.progression) progByExercise.set(p.exercise.toLowerCase(), { action: p.action, why: p.why });

  // ---- Precedence 7: time / life fit ----
  const requestMinutes = snapshot.request.minutes;
  if (requestMinutes != null && requestMinutes > 0) {
    fire(precedence, "time_constrained");
    hard.push({ code: "time_constrained", detail: `About ${Math.round(requestMinutes)} minutes` });
  }

  // ---- Precedence 8: template rotation as the stable fallback ----
  const intent: "template" | "custom" =
    snapshot.plan.day_number != null && snapshot.plan_items.length ? "template" : "custom";
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
    snapshot.program.mesocycle_phase === "deload" || snapshot.program.mesocycle_phase === "deload-due";
  const softenVolume =
    kind === "easy" ||
    snapshot.recovery.readiness === "low" ||
    highSoreness ||
    consecutive >= 3 ||
    snapshot.day_read.recovery_week;
  const volume: DailyDecisionEnvelope["caps"]["volume"] =
    kind === "rest" ? "minimal" : softenVolume ? "reduced" : "normal";
  const intensity: DailyDecisionEnvelope["caps"]["intensity"] =
    kind === "rest" || kind === "easy"
      ? "easy"
      : deloadPhase || repeatedUnder
        ? "deload"
        : snapshot.recovery.readiness === "low" || highSoreness
          ? "hold"
          : "normal";
  let duration = requestMinutes ?? snapshot.day_read.est_minutes ?? null;
  if (duration != null) {
    if (kind === "rest") duration = Math.min(duration, 20);
    else if (kind === "easy") duration = Math.min(duration, 40);
    duration = Math.round(duration);
  }
  if (durationOverrideOnly && duration != null) duration = Math.min(duration, 35);

  // ---- Candidates (template intent only; custom leaves composition to Stage 3) ----
  const candidates: DailyDecisionCandidate[] = [];
  if (intent === "template" && kind !== "rest") {
    for (const it of snapshot.plan_items) {
      const group = it.muscle_group ? it.muscle_group.toLowerCase() : null;
      if (group && excluded.includes(group)) {
        candidates.push({
          exercise: it.exercise,
          muscle_group: it.muscle_group,
          action: "exclude",
          reason_code: injuryGroups.includes(group) ? "injury_exclusion" : "joint_pain_reduce",
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
      // A saturated/reduced group holds load rather than advancing today.
      if (group && reduced.includes(group) && (action === "overload" || action === "carry")) {
        action = "hold";
        reason = saturated.includes(group) ? "muscle_saturated" : "endurance_lower_conflict";
      }
      if (intensity === "deload" && (action === "overload" || action === "carry")) {
        action = "deload";
        reason = reason ?? "progression_deload";
      }
      candidates.push({
        exercise: it.exercise,
        muscle_group: it.muscle_group,
        action,
        reason_code: reason,
        substitution_for: null,
        note: prog?.why ?? null,
      });
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
    template: {
      day_number: snapshot.plan.day_number,
      focus: snapshot.plan.focus,
      intent,
    },
    muscles: { required, allowed, reduced, excluded },
    caps: { volume, intensity, duration_min: duration },
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
  opts: { override?: string | null; equipment?: string | null; minutes?: number | null; goal?: string | null } = {},
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
