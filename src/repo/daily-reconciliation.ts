import { getActiveDailySessionForSession } from "./adaptive-session.js";
import { db } from "../db.js";
import { localDateISO } from "./shared.js";

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
    exercise: string;
    target_weight: number | null;
    achieved_weight: number | null;
    target_seconds: number | null;
    achieved_seconds: number | null;
    verdict: "met_or_exceeded" | "under_target" | "no_target";
  }>;
  feedback: { soreness: number | null; performance: number | null; joint_pain: string | null };
  confounders: string[];
  reason_codes: string[];
  confidence: "low" | "moderate" | "high";
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
      `SELECT e.name AS exercise, e.mode AS mode, ls.weight, ls.reps, ls.duration_sec, ls.id
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
  if (session?.joint_pain != null && String(session.joint_pain).trim()) out.push("joint_pain");
  if (finite(session?.soreness) != null && Number(session.soreness) >= 4) out.push("high_soreness");
  if (finite(session?.performance) != null && Number(session.performance) <= 2) out.push("low_performance");
  // Another endurance activity the same day is a legitimate reason strength work
  // was trimmed — never counted as skipping.
  const otherActivity = db.prepare(`SELECT 1 FROM activities WHERE date = ? LIMIT 1`).get(date);
  if (otherActivity) out.push("other_activity");
  return out;
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
    const sec = finite(s.duration_sec);
    if (sec != null && (agg.top_seconds == null || sec > agg.top_seconds)) agg.top_seconds = sec;
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

  // Progression evidence: did achieved work meet the prescribed target?
  const progression_evidence = items.map((it: any) => {
    const agg = achievedMap.get(lower(it.exercise));
    const targetWeight = finite(it.target_weight);
    const targetSeconds = finite(it.target_seconds);
    const achievedWeight = agg?.top_weight ?? null;
    const achievedSeconds = agg?.top_seconds ?? null;
    let verdict: "met_or_exceeded" | "under_target" | "no_target" = "no_target";
    if (agg) {
      if (targetWeight != null && achievedWeight != null) {
        verdict = achievedWeight >= targetWeight ? "met_or_exceeded" : "under_target";
      } else if (targetSeconds != null && achievedSeconds != null) {
        verdict = achievedSeconds >= targetSeconds ? "met_or_exceeded" : "under_target";
      }
    }
    return {
      exercise: String(it.exercise),
      target_weight: targetWeight,
      achieved_weight: achievedWeight,
      target_seconds: targetSeconds,
      achieved_seconds: achievedSeconds,
      verdict,
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

  const facts: DailySessionOutcomeFacts = {
    suggested_count: suggestedExercises.length,
    suggested_exercises: suggestedExercises,
    logged_exercises: loggedExercises,
    completed,
    substituted,
    skipped,
    reordered,
    achieved: [...achievedMap.values()].map(({ firstId: _firstId, ...rest }) => rest),
    progression_evidence,
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
