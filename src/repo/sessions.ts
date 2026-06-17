import { db, todayISO } from "../db.js";
import { listActivities, listGarminActivities, listGarminDailyMetrics, listGarminSources } from "./activities.js";
import { findExercise, findOrCreateExercise, listExercises } from "./exercises.js";
import { listContextEvents, listHealthDocuments, listHealthReviews } from "./health.js";
import { invalidateDayRead } from "./intelligence.js";
import { listMemory, listSuggestions } from "./memory.js";
import { listFoodNotes, listMealPlans } from "./nutrition.js";
import { getPlan } from "./plan.js";
import { getProfile, listWeight } from "./profile.js";
import { getSettings } from "./settings.js";

// ---------- sessions ----------
export function getOrCreateSession(date: string, planDayId?: number | null): any {
  const s = db.prepare(`SELECT * FROM sessions WHERE date = ?`).get(date) as any;
  if (s) {
    if (planDayId && !s.plan_day_id) {
      db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE id = ?`).run(planDayId, s.id);
      s.plan_day_id = planDayId;
    }
    return s;
  }
  const info = db
    .prepare(`INSERT INTO sessions (date, plan_day_id) VALUES (?, ?)`)
    .run(date, planDayId ?? null);
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(info.lastInsertRowid);
}

// Parse the reconciled Garmin strength physiology blob off a session row into a
// `garmin` object (dropping the raw `garmin_json` string). Null when absent/bad.
function hydrateSession(s: any) {
  if (!s) return s;
  let garmin: any = null;
  try { garmin = s.garmin_json ? JSON.parse(s.garmin_json) : null; } catch { garmin = null; }
  const { garmin_json, ...rest } = s;
  return { ...rest, garmin };
}

export function getRecentSessions(limit = 10) {
  const sessions = db
    .prepare(`SELECT s.*, pd.name AS day_name FROM sessions s
              LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
              ORDER BY s.date DESC, s.id DESC LIMIT ?`)
    .all(limit) as any[];
  return sessions.map((s) => ({ ...hydrateSession(s), sets: setsForSession(s.id), skips: skipsForSession(s.id) }));
}

export function getSessionByDate(date: string) {
  const s = db
    .prepare(`SELECT s.*, pd.name AS day_name FROM sessions s
              LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
              WHERE s.date = ?`)
    .get(date) as any;
  if (!s) return null;
  return { ...hydrateSession(s), sets: setsForSession(s.id), skips: skipsForSession(s.id) };
}

export function getSessionDetail(id: number) {
  const s = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
  if (!s) return null;
  return { ...hydrateSession(s), sets: setsForSession(id), skips: skipsForSession(id) };
}

export function sessionSummary(sessionId: number) {
  const sets = setsForSession(sessionId) as any[];
  const tonnage = sets.reduce((t, s) => t + (s.weight > 0 && s.reps ? s.weight * s.reps : 0), 0);
  return {
    sets: sets.length,
    exercises: new Set(sets.map((s) => s.exercise)).size,
    tonnage: Math.round(tonnage),
    skipped: skipsForSession(sessionId).length, // consciously skipped, not unfinished
  };
}

// Mark a workout done: derive duration from first→last set timestamp, save notes.
export function finishSession(sessionId: number, notes?: string | null) {
  const s = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) throw new Error(`No session ${sessionId}`);
  const span = db
    .prepare(`SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM logged_sets WHERE session_id = ?`)
    .get(sessionId) as any;
  let duration_min = s.duration_min ?? null;
  if (span?.first && span?.last) {
    const mins = Math.round((new Date(span.last + "Z").getTime() - new Date(span.first + "Z").getTime()) / 60000);
    if (mins > 0) duration_min = mins;
  }
  db.prepare(`UPDATE sessions SET duration_min = ?, notes = COALESCE(?, notes), finished_at = datetime('now') WHERE id = ?`)
    .run(duration_min, notes ?? null, sessionId);
  return { ...getSessionDetail(sessionId), summary: sessionSummary(sessionId) };
}

// Reopen a finished session to keep logging (clears finished_at). Idempotent — a
// no-op on an already-open session. The Today "done" card offers this so a wrap-up
// is never a one-way door.
export function reopenSession(sessionId: number) {
  const s = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  db.prepare(`UPDATE sessions SET finished_at = NULL WHERE id = ?`).run(sessionId);
  return getSessionDetail(sessionId);
}

// Edit a session's notes after the fact (history correction). Returns the full
// session detail, or null if the id is unknown. trainingSignals reads sessions
// live, so the coach sees the corrected note on its next prompt — no re-trigger.
export function updateSessionNotes(sessionId: number, notes: string | null) {
  const s = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  const clean = notes != null ? String(notes).trim().slice(0, 1000) || null : null;
  db.prepare(`UPDATE sessions SET notes = ? WHERE id = ?`).run(clean, sessionId);
  return getSessionDetail(sessionId);
}

// Optional per-session autoregulation feedback (Phase 3B): 1-tap soreness /
// performance (clamped 1-5) and a free-text joint/area flag. Only the fields
// provided are written; the session is created for `date` if it doesn't exist.
// Stage-2 T3 reads these in buildCoachPrompt to bend volume / de-load a movement.
export function setSessionFeedback(
  date: string,
  fields: { soreness?: number | null; performance?: number | null; joint_pain?: string | null }
) {
  const session = getOrCreateSession(date || todayISO());
  const clamp15 = (v: any): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(5, Math.max(1, Math.round(n)));
  };
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.soreness !== undefined) { sets.push("soreness = ?"); vals.push(fields.soreness == null ? null : clamp15(fields.soreness)); }
  if (fields.performance !== undefined) { sets.push("performance = ?"); vals.push(fields.performance == null ? null : clamp15(fields.performance)); }
  if (fields.joint_pain !== undefined) { sets.push("joint_pain = ?"); vals.push(fields.joint_pain == null ? null : String(fields.joint_pain).trim().slice(0, 300) || null); }
  if (sets.length) {
    vals.push(session.id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getSessionDetail(session.id);
}

export function setsForSession(sessionId: number) {
  return db
    .prepare(
      `SELECT ls.*, e.name AS exercise, e.mode AS mode FROM logged_sets ls
       JOIN exercises e ON e.id = ls.exercise_id
       WHERE ls.session_id = ? ORDER BY ls.id`
    )
    .all(sessionId);
}

// ---------- session skips ("not today") ----------
// A planned exercise the athlete consciously skipped for one date's session.
// Skipped exercises are simply absent from that day's expectations — they never
// count against completion, and weekly stats are untouched (those join
// logged_sets only). The exercise column is COLLATE NOCASE, so lookups and the
// UNIQUE(session_id, exercise) guard are case-insensitive.
function skipsForSession(sessionId: number): string[] {
  return (
    db.prepare(`SELECT exercise FROM session_skips WHERE session_id = ? ORDER BY id`).all(sessionId) as any[]
  ).map((r) => r.exercise);
}

export function skipExercise(exercise: string, date?: string) {
  const d = date || todayISO();
  const ex = findExercise(exercise);
  const name = (ex?.name as string) || exercise.trim();
  if (!name) throw new Error("exercise required");
  const session = getOrCreateSession(d);
  if (ex) {
    const logged = db
      .prepare(`SELECT COUNT(*) AS c FROM logged_sets WHERE session_id = ? AND exercise_id = ?`)
      .get(session.id, ex.id) as any;
    if (Number(logged?.c ?? 0) > 0) {
      // Designed refusal, not an error: sets already logged this session win.
      return {
        ok: false as const,
        error: "exercise already has logged sets this session",
        date: d, exercise: name, session_id: session.id, skips: skipsForSession(session.id),
      };
    }
  }
  db.prepare(`INSERT OR IGNORE INTO session_skips (session_id, exercise) VALUES (?, ?)`).run(session.id, name);
  return { ok: true as const, date: d, exercise: name, session_id: session.id, skips: skipsForSession(session.id) };
}

export function unskipExercise(exercise: string, date?: string) {
  const d = date || todayISO();
  const name = exercise.trim();
  const s = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(d) as any;
  if (!s) return { ok: true as const, date: d, exercise: name, removed: 0, skips: [] as string[] };
  const removed = db.prepare(`DELETE FROM session_skips WHERE session_id = ? AND exercise = ?`).run(s.id, name).changes;
  return { ok: true as const, date: d, exercise: name, removed, skips: skipsForSession(s.id) };
}

// ---------- logging ----------
export interface LogSetInput {
  exercise: string;
  weight?: number | null;
  reps?: number | null;
  rir?: number | null;
  duration_sec?: number | null;
  exercise_mode?: string; // 'reps' | 'timed' — applied on create; updates mode if explicitly passed
  set_number?: number;
  date?: string;
  day_number?: number;
  note?: string;
}

export function logSetByName(input: LogSetInput) {
  const date = input.date || todayISO();
  const ex = findOrCreateExercise(input.exercise, undefined, undefined, input.exercise_mode);
  // An explicitly-passed mode also updates an existing exercise (e.g. converting
  // "Plank" to timed on the first timed log).
  if (input.exercise_mode && ["reps", "timed"].includes(input.exercise_mode) && ex.mode !== input.exercise_mode) {
    db.prepare(`UPDATE exercises SET mode = ? WHERE id = ?`).run(input.exercise_mode, ex.id);
    ex.mode = input.exercise_mode;
  }
  let planDayId: number | null = null;
  if (input.day_number) {
    const d = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(input.day_number) as any;
    planDayId = d?.id ?? null;
  }
  const session = getOrCreateSession(date, planDayId);
  let setNumber = input.set_number ?? 0;
  if (!setNumber) {
    const row = db
      .prepare(`SELECT MAX(set_number) AS m FROM logged_sets WHERE session_id = ? AND exercise_id = ?`)
      .get(session.id, ex.id) as any;
    setNumber = (row?.m ?? 0) + 1;
  }
  const info = db
    .prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, note, duration_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(session.id, ex.id, setNumber, input.weight ?? null, input.reps ?? null, input.rir ?? null, input.note ?? null, input.duration_sec ?? null);

  invalidateDayRead(date); // logging a set flips "trained today" → refresh the Brief

  // PR check. Reps exercises: a new all-time est-1RM (Epley). Timed exercises:
  // strictly beating the previous max duration; est_1rm stays null for timed.
  let pr = false;
  let est_1rm: number | null = null;
  if (ex.mode === "timed") {
    if ((input.duration_sec ?? 0) > 0) {
      const prev = db
        .prepare(`SELECT MAX(duration_sec) AS m FROM logged_sets WHERE exercise_id = ? AND id != ? AND duration_sec IS NOT NULL`)
        .get(ex.id, info.lastInsertRowid) as any;
      pr = input.duration_sec! > (prev?.m ?? 0);
    }
  } else if ((input.weight ?? 0) > 0 && (input.reps ?? 0) > 0) {
    est_1rm = epley1RM(input.weight!, input.reps!);
    const prev = db
      .prepare(`SELECT weight, reps FROM logged_sets WHERE exercise_id = ? AND id != ? AND weight > 0 AND reps > 0`)
      .all(ex.id, info.lastInsertRowid) as any[];
    const prevBest = prev.reduce((m, r) => Math.max(m, epley1RM(r.weight, r.reps)), 0);
    pr = est_1rm > prevBest;
  }

  return {
    id: info.lastInsertRowid,
    session_id: session.id,
    date,
    exercise: ex.name,
    mode: ex.mode ?? "reps",
    set_number: setNumber,
    weight: input.weight ?? null,
    reps: input.reps ?? null,
    rir: input.rir ?? null,
    duration_sec: input.duration_sec ?? null,
    est_1rm,
    pr,
  };
}

export function deleteSet(id: number) {
  return { deleted: db.prepare(`DELETE FROM logged_sets WHERE id = ?`).run(id).changes };
}

// Edit a single logged set after the fact (history correction: a mistyped weight,
// a wrong rep count). Only the fields provided are touched; numeric fields coerce,
// note trims/caps. Returns the refreshed set row (with exercise name), or null on
// an unknown id. The connected brain (trainingSignals) re-reads logged_sets on
// every coach prompt, so a correction flows into future planning with no extra step.
export function updateSet(
  id: number,
  fields: { weight?: number | null; reps?: number | null; rir?: number | null; note?: string | null; duration_sec?: number | null }
) {
  const cur = db.prepare(`SELECT id FROM logged_sets WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const num = (v: any): number | null => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.weight !== undefined) { sets.push("weight = ?"); vals.push(num(fields.weight)); }
  if (fields.reps !== undefined) { sets.push("reps = ?"); vals.push(num(fields.reps)); }
  if (fields.rir !== undefined) { sets.push("rir = ?"); vals.push(num(fields.rir)); }
  if (fields.duration_sec !== undefined) { sets.push("duration_sec = ?"); vals.push(num(fields.duration_sec)); }
  if (fields.note !== undefined) { sets.push("note = ?"); vals.push(fields.note == null ? null : String(fields.note).trim().slice(0, 500) || null); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE logged_sets SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return db.prepare(
    `SELECT ls.*, e.name AS exercise, e.mode AS mode FROM logged_sets ls
     JOIN exercises e ON e.id = ls.exercise_id WHERE ls.id = ?`
  ).get(id);
}

// Most recent logged set for an exercise across all sessions (for prefill).
// Timed sets have reps NULL but a duration_sec — both count as a real set.
export function getLastSet(exercise: string) {
  const row = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir, ls.duration_sec AS duration_sec, s.date AS date
       FROM logged_sets ls
       JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
       WHERE e.name = ? COLLATE NOCASE AND (ls.reps IS NOT NULL OR ls.duration_sec IS NOT NULL)
       ORDER BY s.date DESC, ls.id DESC
       LIMIT 1`
    )
    .get(exercise) as any;
  return row ?? null;
}

// ---------- progress ----------
function epley1RM(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// Compact dashboard: training days + tonnage over the last 7 days, plus a
// consistency streak (consecutive days with a logged session or activity).
export function getWeeklyStats() {
  const today = todayISO();
  const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const sixtyAgo = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);

  const weekSess = db
    .prepare(`SELECT DISTINCT s.date FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ?`)
    .all(weekAgo) as any[];
  const ton = db
    .prepare(
      `SELECT COALESCE(SUM(l.weight * l.reps), 0) AS t FROM logged_sets l JOIN sessions s ON s.id = l.session_id
       WHERE s.date >= ? AND l.weight > 0 AND l.reps > 0`
    )
    .get(weekAgo) as any;
  // ALL logged sets count here — including timed sets, which the tonnage math
  // above intentionally excludes (weight > 0 AND reps > 0).
  const weekSets = db
    .prepare(`SELECT COUNT(*) AS c FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date >= ?`)
    .get(weekAgo) as any;

  const sessDates = new Set(
    (db.prepare(`SELECT DISTINCT s.date AS d FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ?`).all(sixtyAgo) as any[]).map((r) => r.d)
  );
  const actDates = new Set((db.prepare(`SELECT DISTINCT date AS d FROM activities WHERE date >= ?`).all(sixtyAgo) as any[]).map((r) => r.d));
  const active = (d: string) => sessDates.has(d) || actDates.has(d);
  let streak = 0;
  let t = new Date(today + "T00:00:00Z").getTime();
  if (!active(today)) t -= 864e5; // grace: an unbroken streak can end yesterday
  while (active(new Date(t).toISOString().slice(0, 10))) { streak++; t -= 864e5; }

  // --- compass: plan adherence this calendar week + weight-trend pace vs goal ---
  // Monday-start week (the plan is weekly; the rolling-7d "sessions" count
  // reads as a vanity number, adherence-to-plan is the honest version).
  const monday = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const weekDone = db
    .prepare(`SELECT COUNT(DISTINCT s.date) AS c FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ?`)
    .get(monday) as any;
  const weekPlanned = db.prepare(`SELECT COUNT(*) AS c FROM plan_days`).get() as any;
  // Cardio this week (activities table) — so the "This Week" summary speaks to
  // BOTH modalities, not just lifting adherence. Count + total distance.
  const weekCardio = db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(distance_km), 0) AS km FROM activities WHERE date >= ?`)
    .get(monday) as any;

  // Weight trend: least-squares slope over the last 21 days of weigh-ins,
  // in lb/week. Needs ≥2 points spanning ≥3 days to mean anything.
  const since21 = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const wpts = db
    .prepare(`SELECT date, weight_lb FROM bodyweight_log WHERE date >= ? ORDER BY date, id`)
    .all(since21) as any[];
  let trend: number | null = null;
  if (wpts.length >= 2) {
    const xs = wpts.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
    const ys = wpts.map((p) => Number(p.weight_lb));
    if (xs[xs.length - 1] - xs[0] >= 3) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0, den = 0;
      for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
      if (den > 0) trend = Math.round((num / den) * 7 * 10) / 10; // lb/day → lb/wk
    }
  }

  const prof = db.prepare(`SELECT weight_lb, goal_weight_lb, goal_date FROM profile WHERE id = 1`).get() as any;
  const currentW = wpts.length ? Number(wpts[wpts.length - 1].weight_lb) : (prof?.weight_lb ?? null);
  let needed: number | null = null;
  if (prof?.goal_weight_lb != null && prof?.goal_date && currentW != null) {
    const weeksLeft = Math.max((Date.parse(prof.goal_date) - Date.parse(today)) / (7 * 864e5), 0.5);
    needed = Math.round(((prof.goal_weight_lb - currentW) / weeksLeft) * 10) / 10;
  }
  // Pace verdict. "fast" = losing more than ~1% bodyweight/week — the lean-safe
  // ceiling the coaching guardrails enforce — and matters as much as "behind".
  let pace: "on" | "behind" | "fast" | null = null;
  if (trend != null && needed != null && currentW != null) {
    const maxSafe = currentW * 0.01;
    if (needed < 0 && trend < -maxSafe) pace = "fast";
    else if (needed < 0 ? trend <= needed + 0.25 : trend >= needed - 0.25) pace = "on";
    else pace = "behind";
  }

  return {
    week_sessions: weekSess.length, week_tonnage: Math.round(ton.t || 0), week_sets: Number(weekSets?.c ?? 0), streak,
    week_done: Number(weekDone?.c ?? 0), week_planned: Number(weekPlanned?.c ?? 0),
    week_cardio: Number(weekCardio?.c ?? 0), week_cardio_km: Math.round(Number(weekCardio?.km ?? 0) * 10) / 10,
    trend_lb_wk: trend, needed_lb_wk: needed, pace_status: pace,
    weight_lb: currentW, goal_weight_lb: prof?.goal_weight_lb ?? null, goal_date: prof?.goal_date ?? null,
  };
}

export function getVolumeByMuscle(days = 30) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT COALESCE(e.muscle_group, 'other') AS muscle_group,
              CAST(ROUND(SUM(ls.weight * ls.reps)) AS INTEGER) AS tonnage,
              COUNT(*) AS sets
       FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id
       WHERE ls.weight > 0 AND ls.reps > 0 AND s.date >= ?
       GROUP BY COALESCE(e.muscle_group, 'other')
       ORDER BY tonnage DESC`
    )
    .all(cutoff) as any[];

  const total_tonnage = rows.reduce((sum, r) => sum + r.tonnage, 0);
  const by_muscle = rows.map((r) => ({
    muscle_group: r.muscle_group as string,
    tonnage: r.tonnage as number,
    sets: r.sets as number,
    pct: total_tonnage > 0 ? Math.round((r.tonnage / total_tonnage) * 100) : 0,
  }));
  return { days, total_tonnage, by_muscle };
}

export function getTrainingCalendar(days = 84) {
  const cutoff = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);

  // Build complete date range in JS so empty days are present.
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  }

  // Aggregate lifting data per day.
  const liftRows = db
    .prepare(
      `SELECT s.date, CAST(ROUND(SUM(ls.weight * ls.reps)) AS INTEGER) AS tonnage, COUNT(*) AS sets
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.weight > 0 AND ls.reps > 0 AND s.date >= ?
       GROUP BY s.date`
    )
    .all(cutoff) as any[];
  const liftMap = new Map<string, { tonnage: number; sets: number }>();
  for (const r of liftRows) liftMap.set(r.date, { tonnage: r.tonnage, sets: r.sets });

  // Activity days.
  const actRows = db
    .prepare(`SELECT DISTINCT date FROM activities WHERE date >= ?`)
    .all(cutoff) as any[];
  const actDates = new Set(actRows.map((r: any) => r.date as string));

  const cells = dates.map((date) => {
    const lift = liftMap.get(date);
    const lifted = !!lift;
    const activity = actDates.has(date);
    const tonnage = lift?.tonnage ?? 0;
    const sets = lift?.sets ?? 0;
    let level: number;
    if (!lifted && !activity) {
      level = 0;
    } else if (lifted) {
      level = 1 + Math.min(3, Math.floor(tonnage / 5000));
    } else {
      level = 1;
    }
    return { date, lifted, tonnage, sets, activity, level };
  });

  return { days, cells };
}

export function exportAll() {
  return {
    version: 2,
    profile: getProfile(),
    settings: getSettings(),
    plan: getPlan(),
    exercises: listExercises(),
    sessions: getRecentSessions(100000),
    activities: listActivities(100000),
    // Include superseded rows in the export — they're history we MARK rather than
    // destroy, so a backup/restore is lossless.
    memory: listMemory(100000, { includeSuperseded: true }),
    suggestions: listSuggestions(100000),
    bodyweight: listWeight(100000),
    meal_plans: listMealPlans(100000),
    food_notes: listFoodNotes(100000),
    health_documents: listHealthDocuments(100000),
    health_reviews: listHealthReviews(100000),
    context_events: listContextEvents(),
    garmin: {
      sources: listGarminSources(),
      activities: listGarminActivities(100000),
      daily_metrics: listGarminDailyMetrics(100000),
    },
  };
}

export function snapshotDbTo(filePath: string): string {
  db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
  return filePath;
}

export function getProgress(exerciseName: string) {
  const ex = findExercise(exerciseName);
  if (!ex) return { exercise: exerciseName, found: false, points: [] };
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? AND ls.weight IS NOT NULL AND ls.reps IS NOT NULL
       ORDER BY s.date`
    )
    .all(ex.id) as any[];

  const byDate = new Map<string, { topWeight: number; topReps: number; best1rm: number }>();
  for (const r of rows) {
    const e1 = epley1RM(r.weight, r.reps);
    const cur = byDate.get(r.date);
    if (!cur || e1 > cur.best1rm) {
      byDate.set(r.date, { topWeight: r.weight, topReps: r.reps, best1rm: e1 });
    }
  }
  const points = [...byDate.entries()].map(([date, v]) => ({ date, ...v }));
  return { exercise: ex.name, found: true, unit: ex.unit, points };
}

