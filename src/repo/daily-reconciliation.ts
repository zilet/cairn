import { getActiveDailySessionForSession } from "./adaptive-session.js";
import { db } from "../db.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { isLoadRelevantEnduranceImpact, recentEnduranceImpacts } from "./hybrid-load.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { registerDailyOutcomeReconcileHook } from "./reconciliation-hooks.js";
import { recoveryCycleAt } from "./recovery-cycles.js";
import { localDateISO } from "./shared.js";
import type { ChallengeVerdict } from "./training-response.js";
import { activeRelevantTrainingSymptoms } from "./training-symptoms.js";

export {
  recentMovementResponse,
  type RecentMovementResponse,
  type RecentMovementResponseVerdict,
} from "./training-response.js";

// Stage 4 — outcome reconciliation (docs/ADAPTIVE_DAILY_TRAINING_PLAN.md §6).
// After a session, deterministically compare what was SUGGESTED/accepted (the
// active daily-session composition) against what was actually TRAINED (logged
// sets + skips), and store a durable, idempotent outcome record with confidence
// and reason codes. It is ADHERENCE-NEUTRAL by contract: a reduced or skipped
// session that travel, time, recovery, pain, or another activity explains is
// recorded as such, never as "poor adherence" (constitution: no adherence
// score). It NEVER mutates the weekly plan — repeated evidence flows to the
// existing program-evolution/proposal path, not from one session here.
//
// This "rides" the existing brain machinery rather than emitting a fresh event:
// finishSession/setSessionFeedback already emit session_finished/session_feedback
// which route to brain review; the outcome record is the additive evidence those
// reviews (and the progression engine) can read. Best-effort at every call site.

export interface DailySessionOutcomeFacts {
  schema_version: 2;
  suggested_count: number;
  suggested_exercises: string[];
  logged_exercises: string[];
  completed: string[];
  substituted: string[];
  skipped: string[];
  reordered: boolean;
  achieved: Array<{
    exercise: string;
    sets: number;
    top_weight: number | null;
    top_reps: number | null;
    top_seconds: number | null;
  }>;
  progression_evidence: Array<{
    composition_item_key: string;
    movement_key: string;
    intent_key: string;
    exercise: string;
    target_sets: number | null;
    achieved_sets: number;
    target_weight: number | null;
    achieved_weight: number | null;
    target_rep_low: number | null;
    target_rep_high: number | null;
    achieved_reps: number | null;
    target_seconds: number | null;
    achieved_seconds: number | null;
    verdict: "met_or_exceeded" | "under_target" | "no_target";
    challenge_verdict: ChallengeVerdict;
  }>;
  dose_evidence: MovementDoseEvidence[];
  dose_context: DoseContext;
  feedback: { soreness: number | null; performance: number | null; joint_pain: string | null };
  confounders: string[];
  reason_codes: string[];
  confidence: "low" | "moderate" | "high";
}

export interface MovementDoseEvidence {
  composition_item_key: string;
  movement_key: string;
  intent_key: string;
  exercise: string;
  mode: "reps" | "timed";
  prescribed: {
    sets: number | null;
    rep_low: number | null;
    rep_high: number | null;
    target_weight: number | null;
    target_seconds: number | null;
  };
  achieved: {
    sets: number;
    top_weight: number | null;
    top_reps: number | null;
    top_seconds: number | null;
    total_reps: number;
    total_seconds: number;
    sets_detail: Array<{
      weight: number | null;
      reps: number | null;
      duration_sec: number | null;
    }>;
  };
  challenge_verdict: ChallengeVerdict;
  relevant_symptom: boolean;
  symptom_event_ids: number[];
}

export interface DoseContext {
  recovery: boolean;
  athlete_override: boolean;
  travel: boolean;
  illness: boolean;
  symptom: boolean;
  endurance: boolean;
  partial: boolean;
  comparable: boolean;
  non_comparable_reasons: string[];
}

export interface DailySessionOutcome {
  composition_id: number;
  session_id: number;
  date: string;
  status: "not_started" | "in_progress" | "completed";
  facts: DailySessionOutcomeFacts;
}

const lower = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase();
const finite = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function loggedSetsFor(sessionId: number): any[] {
  return db
    .prepare(
      `SELECT e.id AS exercise_id, e.name AS exercise, e.muscle_group, e.mode AS mode,
              ls.weight, ls.reps, ls.duration_sec, ls.id
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
        WHERE ls.session_id = ? ORDER BY ls.id`
    )
    .all(sessionId) as any[];
}

function skipsFor(sessionId: number): string[] {
  return (db.prepare(`SELECT exercise FROM session_skips WHERE session_id = ?`).all(sessionId) as any[]).map((r) =>
    String(r.exercise)
  );
}

function confounders(session: any, date: string): string[] {
  const out: string[] = [];
  // Travel window active on the date → a reduced/portable session is expected.
  const travel = db
    .prepare(
      `SELECT 1 FROM context_events
        WHERE kind = 'trip' AND (archived IS NULL OR archived = 0) AND resolved_at IS NULL
          AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) LIMIT 1`
    )
    .get(date, date);
  if (travel) out.push("travel_window");
  const illness = db
    .prepare(
      `SELECT 1 FROM context_events
        WHERE kind IN ('illness','sick') AND (archived IS NULL OR archived = 0) AND resolved_at IS NULL
          AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) LIMIT 1`
    )
    .get(date, date);
  if (illness) out.push("illness_window");
  if (session?.joint_pain != null && String(session.joint_pain).trim()) out.push("joint_pain");
  if (finite(session?.soreness) != null && Number(session.soreness) >= 4) out.push("high_soreness");
  if (finite(session?.performance) != null && Number(session.performance) <= 2) out.push("low_performance");
  // Another endurance activity the same day is a legitimate reason strength work
  // was trimmed — never counted as skipping.
  const otherActivity = recentEnduranceImpacts(1, date).some(isLoadRelevantEnduranceImpact);
  if (otherActivity) out.push("other_activity");
  return out;
}

function movementIdentity(exercise: string): string {
  const stored = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(exercise) as any;
  return stored?.id != null ? `exercise:${Number(stored.id)}` : `movement:${normalizedExerciseKey(exercise)}`;
}

function intentIdentity(item: any): string {
  if (item?.kind === "cardio") return `endurance:${lower(item.target_zone || "general")}`;
  if (item?.mode === "timed" || finite(item?.target_seconds) != null) return "strength:timed";
  const low = finite(item?.rep_low);
  const high = finite(item?.rep_high);
  return `strength:reps:${low ?? "open"}-${high ?? low ?? "open"}`;
}

function contextMentions(value: unknown, pattern: RegExp): boolean {
  try {
    return pattern.test(JSON.stringify(value ?? {}).toLowerCase());
  } catch {
    return false;
  }
}

function serverTrainAnyway(composition: any): boolean {
  for (const value of [composition?.constraints, composition?.provenance]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, any>;
    if (record.train_anyway === true || record.daily_decision?.train_anyway === true) return true;
  }
  return false;
}

function challengeVerdict(
  prescribed: MovementDoseEvidence["prescribed"],
  achieved: MovementDoseEvidence["achieved"]
): ChallengeVerdict {
  if (achieved.sets <= 0) return "not_attempted";
  const hasTarget =
    prescribed.sets != null ||
    prescribed.target_weight != null ||
    prescribed.rep_low != null ||
    prescribed.rep_high != null ||
    prescribed.target_seconds != null;
  if (!hasTarget) return "no_target";
  if (prescribed.sets != null && achieved.sets < prescribed.sets) return "under_prescribed";
  const qualifyingSets = achieved.sets_detail.filter(
    (set) =>
      (prescribed.target_weight == null || (set.weight != null && set.weight >= prescribed.target_weight)) &&
      (prescribed.target_seconds == null ||
        (set.duration_sec != null && set.duration_sec >= prescribed.target_seconds)) &&
      (prescribed.rep_low == null || (set.reps != null && set.reps >= prescribed.rep_low))
  ).length;
  if (prescribed.sets != null && qualifyingSets < prescribed.sets) return "under_prescribed";
  const exceeded =
    (prescribed.sets != null && qualifyingSets > prescribed.sets) ||
    (prescribed.target_weight != null &&
      achieved.top_weight != null &&
      achieved.top_weight > prescribed.target_weight) ||
    (prescribed.target_seconds != null &&
      achieved.top_seconds != null &&
      achieved.top_seconds > prescribed.target_seconds) ||
    (prescribed.rep_high != null && achieved.top_reps != null && achieved.top_reps > prescribed.rep_high);
  return exceeded ? "exceeded" : "met";
}

// Reconcile one session's daily-session composition against what was logged.
// Idempotent: re-running for the same composition upserts the same row. Returns
// the stored outcome, or null when the session has no daily-session composition
// (a plain plan/legacy session — nothing bespoke to reconcile).
export function reconcileDailySession(sessionId: number): DailySessionOutcome | null {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
  if (!session) return null;
  const composition = getActiveDailySessionForSession(id) as any;
  if (!composition) return null;

  const date = String(session.date ?? localDateISO()).slice(0, 10);
  const items = (Array.isArray(composition.items) ? composition.items : []).filter(
    (it: any) => it && it.kind !== "cardio" && it.exercise
  );
  const suggestedExercises: string[] = items.map((it: any) => String(it.exercise));
  const suggestedSet = new Set(suggestedExercises.map(lower));

  const sets = loggedSetsFor(id);
  const skips = skipsFor(id);

  // Aggregate achieved work per exercise (top weight / reps / seconds).
  const achievedMap = new Map<
    string,
    {
      exercise: string;
      sets: number;
      top_weight: number | null;
      top_reps: number | null;
      top_seconds: number | null;
      total_reps: number;
      total_seconds: number;
      sets_detail: Array<{ weight: number | null; reps: number | null; duration_sec: number | null }>;
      muscle_group: string | null;
      firstId: number;
    }
  >();
  const loggedOrder: string[] = [];
  for (const s of sets) {
    const key = lower(s.exercise);
    if (!achievedMap.has(key)) {
      achievedMap.set(key, {
        exercise: String(s.exercise),
        sets: 0,
        top_weight: null,
        top_reps: null,
        top_seconds: null,
        total_reps: 0,
        total_seconds: 0,
        sets_detail: [],
        muscle_group: s.muscle_group == null ? null : String(s.muscle_group),
        firstId: Number(s.id),
      });
      loggedOrder.push(key);
    }
    const agg = achievedMap.get(key)!;
    agg.sets += 1;
    const w = finite(s.weight);
    if (w != null && (agg.top_weight == null || w > agg.top_weight)) agg.top_weight = w;
    const r = finite(s.reps);
    if (r != null && (agg.top_reps == null || r > agg.top_reps)) agg.top_reps = r;
    if (r != null) agg.total_reps += r;
    const sec = finite(s.duration_sec);
    if (sec != null && (agg.top_seconds == null || sec > agg.top_seconds)) agg.top_seconds = sec;
    if (sec != null) agg.total_seconds += sec;
    agg.sets_detail.push({
      weight: finite(s.weight),
      reps: r,
      duration_sec: sec,
    });
  }

  const loggedExercises = [...achievedMap.values()].map((a) => a.exercise);
  const completed = suggestedExercises.filter((ex) => achievedMap.has(lower(ex)));
  const substituted = loggedExercises.filter((ex) => !suggestedSet.has(lower(ex)));
  const skippedSuggested = suggestedExercises.filter((ex) => !achievedMap.has(lower(ex)));
  const skipped = Array.from(new Set([...skippedSuggested, ...skips.filter((s) => suggestedSet.has(lower(s)))]));

  // Reordered: the order suggested-and-logged exercises were actually trained in
  // differs from the composition's prescribed order.
  const suggestedLoggedOrder = loggedOrder.filter((k) => suggestedSet.has(k));
  const prescribedOrder = suggestedExercises.map(lower).filter((k) => achievedMap.has(k));
  const reordered = suggestedLoggedOrder.join("|") !== prescribedOrder.join("|");

  // Full prescribed/achieved dose. Stable identity is independent of mutable
  // display order across compositions: movement + intent survive later rewrites,
  // while composition_item_key anchors the exact historical item.
  const dose_evidence: MovementDoseEvidence[] = items.map((it: any, index: number) => {
    const agg = achievedMap.get(lower(it.exercise));
    const exercise = {
      name: String(it.exercise),
      muscle_group: agg?.muscle_group ?? null,
    };
    const symptomEvents = activeRelevantTrainingSymptoms(date, exercise);
    const prescribed: MovementDoseEvidence["prescribed"] = {
      sets: finite(it.sets),
      rep_low: finite(it.rep_low),
      rep_high: finite(it.rep_high),
      target_weight: finite(it.target_weight),
      target_seconds: finite(it.target_seconds),
    };
    const achievedDose: MovementDoseEvidence["achieved"] = {
      sets: agg?.sets ?? 0,
      top_weight: agg?.top_weight ?? null,
      top_reps: agg?.top_reps ?? null,
      top_seconds: agg?.top_seconds ?? null,
      total_reps: agg?.total_reps ?? 0,
      total_seconds: agg?.total_seconds ?? 0,
      sets_detail: agg?.sets_detail ?? [],
    };
    const movement_key = movementIdentity(String(it.exercise));
    const intent_key = intentIdentity(it);
    return {
      composition_item_key: `composition:${Number(composition.id)}:item:${Number(it.position ?? index)}`,
      movement_key,
      intent_key,
      exercise: String(it.exercise),
      mode: it.mode === "timed" || finite(it.target_seconds) != null ? "timed" : "reps",
      prescribed,
      achieved: achievedDose,
      challenge_verdict: challengeVerdict(prescribed, achievedDose),
      relevant_symptom:
        (!!session.joint_pain && painAreaLoadsExercise(String(session.joint_pain), exercise)) ||
        symptomEvents.length > 0,
      symptom_event_ids: symptomEvents.map((event) => event.id),
    };
  });

  // Legacy progression_evidence remains readable for existing consumers, with
  // additive stable identity and the stricter whole-dose verdict.
  const progression_evidence = dose_evidence.map((dose) => {
    const targetWeight = dose.prescribed.target_weight;
    const targetSeconds = dose.prescribed.target_seconds;
    const achievedWeight = dose.achieved.top_weight;
    const achievedSeconds = dose.achieved.top_seconds;
    const whole = dose.challenge_verdict;
    const verdict: "met_or_exceeded" | "under_target" | "no_target" =
      whole === "met" || whole === "exceeded"
        ? "met_or_exceeded"
        : whole === "no_target"
          ? "no_target"
          : "under_target";
    return {
      composition_item_key: dose.composition_item_key,
      movement_key: dose.movement_key,
      intent_key: dose.intent_key,
      exercise: dose.exercise,
      target_sets: dose.prescribed.sets,
      achieved_sets: dose.achieved.sets,
      target_weight: targetWeight,
      achieved_weight: achievedWeight,
      target_rep_low: dose.prescribed.rep_low,
      target_rep_high: dose.prescribed.rep_high,
      achieved_reps: dose.achieved.top_reps,
      target_seconds: targetSeconds,
      achieved_seconds: achievedSeconds,
      verdict,
      challenge_verdict: whole,
    };
  });

  const started = sets.length > 0;
  const finished = !!session.finished_at;
  const status: DailySessionOutcome["status"] = finished ? "completed" : started ? "in_progress" : "not_started";

  const conf = confounders(session, date);
  const reason_codes: string[] = [];
  if (!started) {
    reason_codes.push("not_started");
  } else if (substituted.length && !completed.length) {
    reason_codes.push("substituted_movements");
  } else {
    if (completed.length >= suggestedExercises.length && suggestedExercises.length > 0 && !substituted.length) {
      reason_codes.push("completed_as_suggested");
    } else if (skipped.length) {
      reason_codes.push("partial_session");
    }
    if (substituted.length) reason_codes.push("substituted_movements");
    if (!skipped.length && substituted.length && completed.length >= suggestedExercises.length) {
      reason_codes.push("extended_session");
    }
  }
  // A reduction with a legitimate confounder is explicitly NOT poor adherence.
  if ((skipped.length || substituted.length) && conf.length) reason_codes.push("explained_by_context");

  const confidence: DailySessionOutcomeFacts["confidence"] = !started
    ? "low"
    : finished && completed.length >= Math.max(1, Math.ceil(suggestedExercises.length * 0.6))
      ? "high"
      : "moderate";

  const recovery =
    ["active", "recheck"].includes(recoveryCycleAt(date)?.effective_status ?? "") ||
    contextMentions(composition.constraints, /\brecovery\b|\bdeload\b/) ||
    contextMentions(composition.provenance, /\brecovery\b|\bdeload\b/);
  const athleteOverride =
    composition.source === "athlete_override" ||
    serverTrainAnyway(composition);
  const travel = conf.includes("travel_window");
  const illness = conf.includes("illness_window");
  const symptom = dose_evidence.some((dose) => dose.relevant_symptom);
  const endurance = conf.includes("other_activity") || session.kind === "cardio";
  const partial =
    reason_codes.includes("partial_session") ||
    dose_evidence.some((dose) => dose.prescribed.sets != null && dose.achieved.sets < dose.prescribed.sets);
  const nonComparable = [
    recovery ? "recovery_dose" : null,
    athleteOverride ? "athlete_override" : null,
    travel ? "travel" : null,
    illness ? "illness" : null,
    symptom ? "relevant_symptom" : null,
    endurance ? "loaded_endurance" : null,
    partial ? "partial" : null,
  ].filter((reason): reason is string => reason != null);
  const dose_context: DoseContext = {
    recovery,
    athlete_override: athleteOverride,
    travel,
    illness,
    symptom,
    endurance,
    partial,
    comparable: nonComparable.length === 0,
    non_comparable_reasons: nonComparable,
  };

  const facts: DailySessionOutcomeFacts = {
    schema_version: 2,
    suggested_count: suggestedExercises.length,
    suggested_exercises: suggestedExercises,
    logged_exercises: loggedExercises,
    completed,
    substituted,
    skipped,
    reordered,
    achieved: [...achievedMap.values()].map((value) => ({
      exercise: value.exercise,
      sets: value.sets,
      top_weight: value.top_weight,
      top_reps: value.top_reps,
      top_seconds: value.top_seconds,
    })),
    progression_evidence,
    dose_evidence,
    dose_context,
    feedback: {
      soreness: finite(session.soreness),
      performance: finite(session.performance),
      joint_pain: session.joint_pain != null && String(session.joint_pain).trim() ? String(session.joint_pain) : null,
    },
    confounders: conf,
    reason_codes,
    confidence,
  };

  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(composition_id) DO UPDATE SET
       status = excluded.status, facts_json = excluded.facts_json, updated_at = datetime('now')`
  ).run(Number(composition.id), id, date, status, JSON.stringify(facts));

  return { composition_id: Number(composition.id), session_id: id, date, status, facts };
}

// Best-effort variant for write hooks (finishSession / setSessionFeedback): a
// reconciliation failure must never break the underlying session write.
export function reconcileDailySessionSafe(sessionId: number): void {
  try {
    reconcileDailySession(sessionId);
  } catch {
    /* additive learning is never load-bearing on the write path */
  }
}

export function reconcileDailySessionsForDateSafe(date: string): void {
  const readDate = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(readDate)) return;
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT s.id
         FROM sessions s
         JOIN daily_session_compositions dsc
           ON dsc.session_id = s.id AND dsc.status = 'active'
         WHERE s.date = ?`
      )
      .all(readDate) as any[];
    for (const row of rows) reconcileDailySessionSafe(Number(row.id));
  } catch {
    /* same additive best-effort boundary as single-session reconciliation */
  }
}

registerDailyOutcomeReconcileHook(reconcileDailySessionsForDateSafe);

export function getDailySessionOutcome(date?: string): DailySessionOutcome | null {
  const d = String(date || localDateISO()).slice(0, 10);
  const row = db.prepare(`SELECT * FROM daily_session_outcomes WHERE date = ? ORDER BY id DESC LIMIT 1`).get(d) as any;
  if (!row) return null;
  let facts: DailySessionOutcomeFacts;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return null;
  }
  return {
    composition_id: Number(row.composition_id),
    session_id: Number(row.session_id),
    date: String(row.date),
    status: row.status,
    facts,
  };
}

export function getDailySessionOutcomeForSession(sessionId: number): DailySessionOutcome | null {
  const row = db
    .prepare(`SELECT * FROM daily_session_outcomes WHERE session_id = ? ORDER BY id DESC LIMIT 1`)
    .get(Number(sessionId)) as any;
  if (!row) return null;
  let facts: DailySessionOutcomeFacts;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return null;
  }
  return {
    composition_id: Number(row.composition_id),
    session_id: Number(row.session_id),
    date: String(row.date),
    status: row.status,
    facts,
  };
}
