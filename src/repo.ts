import { db, todayISO } from "./db.js";
import { listAgents } from "./agents.js";

// The day_reads cache is keyed by the server's LOCAL calendar date (the PWA drives
// every read with its local date, and a home server shares the owner's timezone) —
// mirror dayread.localToday() here so getCoachContext reads the same row the Brief
// wrote. Defined locally to avoid a circular import (dayread.ts imports repo.ts).
function localDateISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- exercises ----------
const EXERCISE_MODES = ["reps", "timed"];

function validMode(mode: any): string | undefined {
  return typeof mode === "string" && EXERCISE_MODES.includes(mode) ? mode : undefined;
}

export function listExercises() {
  return db.prepare(`SELECT * FROM exercises ORDER BY name`).all();
}

export function findExercise(name: string): any {
  return db.prepare(`SELECT * FROM exercises WHERE name = ? COLLATE NOCASE`).get(name);
}

export function getExercise(id: number): any {
  return db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(id) ?? null;
}

export function findOrCreateExercise(name: string, muscle_group?: string, constraint_note?: string, mode?: string): any {
  const existing = findExercise(name);
  if (existing) return existing;
  const info = db
    .prepare(`INSERT INTO exercises (name, muscle_group, constraint_note, mode) VALUES (?, ?, ?, ?)`)
    .run(name.trim(), muscle_group ?? null, constraint_note ?? null, validMode(mode) ?? "reps");
  return db.prepare(`SELECT * FROM exercises WHERE id = ?`).get(info.lastInsertRowid);
}

// Create-or-update by name: new exercises get the given fields; existing ones
// only update fields that were explicitly provided.
export function upsertExercise(input: { name: string; muscle_group?: string | null; mode?: string | null }): any {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name required");
  const existing = findExercise(name);
  if (existing) {
    return updateExercise(existing.id, {
      muscle_group: input.muscle_group !== undefined ? input.muscle_group : undefined,
      mode: input.mode ?? undefined,
    });
  }
  return findOrCreateExercise(name, input.muscle_group ?? undefined, undefined, input.mode ?? undefined);
}

export function updateExercise(
  id: number,
  patch: { mode?: string | null; muscle_group?: string | null; cues?: string | null; constraint_note?: string | null }
): any {
  const cur = getExercise(id);
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.mode !== undefined && patch.mode !== null) {
    const m = validMode(patch.mode);
    if (!m) throw new Error(`mode must be one of: ${EXERCISE_MODES.join(", ")}`);
    sets.push("mode = ?"); vals.push(m);
  }
  if (patch.muscle_group !== undefined) { sets.push("muscle_group = ?"); vals.push(patch.muscle_group ?? null); }
  if (patch.cues !== undefined) { sets.push("cues = ?"); vals.push(patch.cues ?? null); }
  if (patch.constraint_note !== undefined) { sets.push("constraint_note = ?"); vals.push(patch.constraint_note ?? null); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE exercises SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getExercise(id);
}

// ---------- plan ----------
export function getPlan() {
  const days = db.prepare(`SELECT * FROM plan_days ORDER BY day_number`).all() as any[];
  return days.map((d) => ({
    ...d,
    items: db
      .prepare(
        `SELECT pi.id, pi.plan_day_id, pi.position, pi.sets, pi.rep_low, pi.rep_high,
                pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds,
                e.name AS exercise, e.muscle_group, e.unit, e.constraint_note, e.mode
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
         WHERE pi.plan_day_id = ? ORDER BY pi.position`
      )
      .all(d.id),
  }));
}

export function getPlanDay(dayNumber: number) {
  const d = db.prepare(`SELECT * FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!d) return null;
  return {
    ...d,
    items: db
      .prepare(
        `SELECT pi.id, pi.plan_day_id, pi.position, pi.sets, pi.rep_low, pi.rep_high,
                pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds,
                e.name AS exercise, e.muscle_group, e.unit, e.constraint_note, e.mode
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
         WHERE pi.plan_day_id = ? ORDER BY pi.position`
      )
      .all(d.id),
  };
}

export function updateTarget(
  dayNumber: number,
  exerciseName: string,
  target_weight?: number | null,
  target_seconds?: number | null
) {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) throw new Error(`No plan day ${dayNumber}`);
  const ex = findExercise(exerciseName);
  if (!ex) throw new Error(`No exercise "${exerciseName}"`);
  const sets: string[] = [];
  const vals: any[] = [];
  if (target_weight !== undefined) { sets.push("target_weight = ?"); vals.push(target_weight); }
  if (target_seconds !== undefined) { sets.push("target_seconds = ?"); vals.push(target_seconds); }
  if (!sets.length) throw new Error("target_weight or target_seconds required");
  vals.push(day.id, ex.id);
  const info = db
    .prepare(`UPDATE plan_items SET ${sets.join(", ")} WHERE plan_day_id = ? AND exercise_id = ?`)
    .run(...vals);
  return {
    updated: info.changes, day: dayNumber, exercise: ex.name,
    ...(target_weight !== undefined ? { target_weight } : {}),
    ...(target_seconds !== undefined ? { target_seconds } : {}),
  };
}

// ---------- plan editing (manual + restructure) ----------
export interface PlanItemInput {
  exercise: string;
  sets?: number;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  note?: string | null;
  warmup_sets?: number | null;
  target_seconds?: number | null;
  mode?: string | null; // applied when the exercise is created (reps | timed)
}

// Upsert one day and replace its full exercise list. Unknown exercises are created.
export function savePlanDay(day_number: number, name: string, focus: string | null, items: PlanItemInput[]) {
  const existing = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  let dayId: number;
  if (existing) {
    db.prepare(`UPDATE plan_days SET name = ?, focus = ? WHERE id = ?`).run(name, focus ?? null, existing.id);
    dayId = existing.id;
    db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(dayId);
  } else {
    dayId = Number(
      db.prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (?, ?, ?)`).run(day_number, name, focus ?? null).lastInsertRowid
    );
  }
  const ins = db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, warmup_sets, target_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (items || []).forEach((it, i) => {
    if (!it.exercise || !String(it.exercise).trim()) return;
    const ex = findOrCreateExercise(String(it.exercise), undefined, undefined, it.mode ?? undefined);
    ins.run(dayId, i, ex.id, it.sets ?? 3, it.rep_low ?? null, it.rep_high ?? null, it.target_weight ?? null, it.note ?? null, it.warmup_sets ?? null, it.target_seconds ?? null);
  });
  return getPlanDay(day_number);
}

export function deletePlanDay(day_number: number) {
  const d = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  if (!d) return { deleted: 0, day_number };
  db.prepare(`UPDATE sessions SET plan_day_id = NULL WHERE plan_day_id = ?`).run(d.id); // keep history, drop the link
  const r = db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(d.id); // plan_items cascade
  return { deleted: r.changes, day_number };
}

// Full restructure: make the plan exactly the given days (add/remove/rewrite).
export function replacePlan(days: { day_number?: number; name?: string; focus?: string | null; items?: PlanItemInput[] }[]) {
  if (!Array.isArray(days) || !days.length) throw new Error("replacePlan needs a non-empty days array");
  db.exec("BEGIN");
  try {
    const normalized = days.map((d, i) => ({ ...d, day_number: Number(d.day_number ?? i + 1) }));
    const keep = new Set(normalized.map((d) => d.day_number));
    const existing = db.prepare(`SELECT day_number FROM plan_days`).all() as any[];
    for (const e of existing) if (!keep.has(e.day_number)) deletePlanDay(e.day_number);
    normalized.forEach((d, i) => savePlanDay(d.day_number, d.name || `Day ${i + 1}`, d.focus ?? null, d.items || []));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getPlan();
}

// ---------- sessions ----------
export function getOrCreateSession(date: string, planDayId?: number | null): any {
  let s = db.prepare(`SELECT * FROM sessions WHERE date = ?`).get(date) as any;
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
  db.prepare(`UPDATE sessions SET duration_min = ?, notes = COALESCE(?, notes) WHERE id = ?`)
    .run(duration_min, notes ?? null, sessionId);
  return { ...getSessionDetail(sessionId), summary: sessionSummary(sessionId) };
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

function setsForSession(sessionId: number) {
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
  const today = todayISO();
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
    memory: listMemory(100000),
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

// ---------- exercise guide ----------
export function getExerciseDetail(name: string) {
  const ex = findExercise(name);
  if (!ex) return { found: false, name };
  const recent = db
    .prepare(
      `SELECT s.date AS date, ls.weight, ls.reps, ls.rir, ls.duration_sec FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? ORDER BY s.date DESC, ls.id DESC LIMIT 8`
    )
    .all(ex.id);
  const appears = db
    .prepare(
      `SELECT pd.day_number, pd.name AS day_name, pi.sets, pi.rep_low, pi.rep_high, pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds
       FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
       WHERE pi.exercise_id = ? ORDER BY pd.day_number`
    )
    .all(ex.id);
  return { found: true, ...ex, progress: getProgress(ex.name), recent, appears };
}

// ---------- proposals ----------
export function createProposal(agent: string, instruction: string, raw: string, parsed: any) {
  const info = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES (?, ?, ?, ?)`)
    .run(agent, instruction || "", raw || "", parsed ? JSON.stringify(parsed) : null);
  return getProposal(Number(info.lastInsertRowid));
}

export function listProposals(limit = 20) {
  const rows = db
    .prepare(`SELECT * FROM plan_proposals ORDER BY id DESC LIMIT ?`)
    .all(limit) as any[];
  return rows.map(hydrateProposal);
}

export function getProposal(id: number) {
  const row = db.prepare(`SELECT * FROM plan_proposals WHERE id = ?`).get(id) as any;
  return row ? hydrateProposal(row) : null;
}

function hydrateProposal(row: any) {
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch {
    parsed = null;
  }
  return { ...row, parsed };
}

export function setProposalStatus(id: number, status: string) {
  db.prepare(`UPDATE plan_proposals SET status = ? WHERE id = ?`).run(status, id);
  return getProposal(id);
}

export function applyProposal(id: number) {
  const p = getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (!p.parsed) throw new Error("Proposal has no parsed payload");
  // Adaptive nutrition-target drafts (from the nutrition check-in) are advisory —
  // there is no plan to mutate. Recognize the shape so "applying" one is a clean
  // acknowledgement on every surface (REST + MCP) instead of throwing
  // "no valid changes or days". The PWA surfaces these via the Energy Balance
  // check-in card, not the plan-proposals apply button.
  if (p.parsed.kind === "nutrition_target") {
    setProposalStatus(id, "applied");
    return { id, applied: [], note: "advisory nutrition target — no plan changes to apply" };
  }
  // Restructure proposal: full plan replacement (changed frequency / split).
  if (Array.isArray(p.parsed.days)) {
    replacePlan(p.parsed.days);
    setProposalStatus(id, "applied");
    return { id, restructured: true, days: p.parsed.days.length };
  }
  if (!Array.isArray(p.parsed.changes)) {
    throw new Error("Proposal has no valid changes or days");
  }
  const applied: any[] = [];
  const skipped: any[] = [];
  for (const c of p.parsed.changes) {
    try {
      // A change carries target_weight (reps exercises) and/or target_seconds (timed).
      const tw = c.target_weight !== undefined && c.target_weight !== null ? Number(c.target_weight) : undefined;
      const ts = c.target_seconds !== undefined && c.target_seconds !== null ? Number(c.target_seconds) : undefined;
      const r = updateTarget(Number(c.day_number), String(c.exercise), tw, ts);
      applied.push({ ...c, updated: r.updated });
    } catch (e: any) {
      skipped.push({ ...c, error: e.message });
    }
  }
  setProposalStatus(id, "applied");
  return { id, applied, skipped };
}

// ---------- profile ----------
export function getProfile(): any {
  return db.prepare(`SELECT * FROM profile WHERE id = 1`).get() || null;
}

export function setProfile(p: any) {
  const cur = getProfile() || {};
  const merged = {
    sex: p.sex ?? cur.sex ?? "male",
    age: p.age ?? cur.age ?? null,
    height_cm: p.height_cm ?? cur.height_cm ?? null,
    weight_lb: p.weight_lb ?? cur.weight_lb ?? null,
    goal_weight_lb: p.goal_weight_lb ?? cur.goal_weight_lb ?? null,
    goal_date: p.goal_date ?? cur.goal_date ?? null,
    activity_factor: p.activity_factor ?? cur.activity_factor ?? 1.5,
    notes: p.notes ?? cur.notes ?? null,
    // Rich free-text understanding (Phase 2A). Trimmed/capped; explicit empty
    // string clears it, undefined leaves the existing value intact.
    about_me: p.about_me !== undefined ? (p.about_me == null ? null : String(p.about_me).slice(0, 8000)) : (cur.about_me ?? null),
  };
  db.prepare(
    `INSERT INTO profile (id, sex, age, height_cm, weight_lb, goal_weight_lb, goal_date, activity_factor, notes, about_me, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       sex=excluded.sex, age=excluded.age, height_cm=excluded.height_cm, weight_lb=excluded.weight_lb,
       goal_weight_lb=excluded.goal_weight_lb, goal_date=excluded.goal_date,
       activity_factor=excluded.activity_factor, notes=excluded.notes, about_me=excluded.about_me, updated_at=datetime('now')`
  ).run(merged.sex, merged.age, merged.height_cm, merged.weight_lb, merged.goal_weight_lb, merged.goal_date, merged.activity_factor, merged.notes, merged.about_me);
  return getProfile();
}

// ---------- bodyweight log ----------
export function logWeight(weight_lb: number, date?: string, note?: string) {
  const d = date || todayISO();
  const info = db
    .prepare(`INSERT INTO bodyweight_log (date, weight_lb, note) VALUES (?, ?, ?)`)
    .run(d, weight_lb, note ?? null);
  // Keep the profile's current weight in sync with the most recent entry.
  const latest = db.prepare(`SELECT weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() as any;
  if (latest) setProfile({ weight_lb: latest.weight_lb });
  return db.prepare(`SELECT * FROM bodyweight_log WHERE id = ?`).get(info.lastInsertRowid);
}

export function listWeight(limit = 60) {
  // chronological for charting
  const rows = db.prepare(`SELECT * FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[];
  return rows.reverse();
}

// ---------- goal feasibility check ----------
const LB_PER_KG = 2.2046226218;
const KCAL_PER_LB = 3500;

export function computeGoalCheck() {
  const p = getProfile();
  if (!p || !p.weight_lb || !p.height_cm || !p.age) {
    return { ok: false, message: "Profile incomplete (need age, height, weight)." };
  }
  const kg = p.weight_lb / LB_PER_KG;
  const sexAdj = (p.sex || "male") === "female" ? -161 : 5;
  const bmr = 10 * kg + 6.25 * p.height_cm - 5 * p.age + sexAdj;
  const tdee = Math.round(bmr * (p.activity_factor || 1.5));

  const lbsToLose = p.goal_weight_lb != null ? Math.max(0, p.weight_lb - p.goal_weight_lb) : 0;

  // lean-safe loss: ~0.5-1% bodyweight/week; >1%/wk risks lean mass.
  const safeMaxRate = +(0.01 * p.weight_lb).toFixed(2);   // upper bound (lb/wk)
  const leanIdealRate = +(0.0075 * p.weight_lb).toFixed(2); // recommended (lb/wk)

  let requested: any = null;
  if (p.goal_date && lbsToLose > 0) {
    const weeks = Math.max(0.1, (new Date(p.goal_date).getTime() - Date.now()) / (7 * 864e5));
    const rate = +(lbsToLose / weeks).toFixed(2);
    const dailyDeficit = Math.round((rate * KCAL_PER_LB) / 7);
    requested = {
      weeks: +weeks.toFixed(1),
      weekly_rate_lb: rate,
      daily_deficit_kcal: dailyDeficit,
      target_intake_kcal: Math.max(0, tdee - dailyDeficit),
      aggressive: rate > safeMaxRate,
    };
  }

  const recDailyDeficit = Math.round((leanIdealRate * KCAL_PER_LB) / 7);
  const recommended = {
    weekly_rate_lb: leanIdealRate,
    daily_deficit_kcal: recDailyDeficit,
    target_intake_kcal: tdee - recDailyDeficit,
    weeks_to_goal: lbsToLose > 0 ? Math.ceil(lbsToLose / leanIdealRate) : 0,
    protein_g: Math.round((p.weight_lb || 0) * 1.0),
  };

  let message: string;
  if (lbsToLose <= 0) {
    message = "At or below goal weight — maintain and keep training for lean mass.";
  } else if (requested?.aggressive) {
    message = `Goal of ${lbsToLose} lb by ${p.goal_date} needs ~${requested.weekly_rate_lb} lb/wk (~${requested.daily_deficit_kcal} kcal/day deficit). That's above the lean-safe ceiling of ~${safeMaxRate} lb/wk and will likely cost muscle. Recommended: ~${recommended.weekly_rate_lb} lb/wk → about ${recommended.weeks_to_goal} weeks, eating ~${recommended.target_intake_kcal} kcal with ~${recommended.protein_g} g protein.`;
  } else if (requested) {
    message = `On track: ~${requested.weekly_rate_lb} lb/wk is within the lean-safe range. Eat ~${requested.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
  } else {
    message = `No target date set. Lean-safe pace ~${recommended.weekly_rate_lb} lb/wk → ${recommended.weeks_to_goal} weeks to lose ${lbsToLose} lb, eating ~${recommended.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
  }

  return {
    ok: true, bmr: Math.round(bmr), tdee, lbs_to_lose: lbsToLose,
    safe_max_rate_lb: safeMaxRate, requested, recommended, message,
  };
}

// ---------- activities ----------
export function parseActivity(text: string) {
  const t = text.toLowerCase();
  let type = "other";
  if (/\b(mtb|mountain ?bike|ride|rode|riding|cycl|bike|biked|biking|gravel)\b/.test(t)) type = "ride";
  else if (/\b(run|ran|running|jog|jogged|jogging|tempo|intervals?|park ?run|5k|10k)\b/.test(t)) type = "run";
  else if (/\bswim|swam|swimming\b/.test(t)) type = "swim";
  else if (/\b(hike|hiked|hiking|walk|walked|fell ?run|fells)\b/.test(t)) type = "hike";
  // a /km pace strongly implies a run if nothing else matched
  if (type === "other" && /\d+:\d{2}\s*(?:\/|per)\s*km/.test(t)) type = "run";

  let duration_min: number | null = null;
  const h = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/);
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  if (h) duration_min = parseFloat(h[1]) * 60;
  if (m) duration_min = (duration_min || 0) + parseFloat(m[1]);
  const hm = t.match(/\b(\d+):(\d{2})\b(?!\s*\/)/); // 1:30 as h:mm when no /km after
  if (!duration_min && hm) duration_min = parseInt(hm[1]) * 60 + parseInt(hm[2]);

  let distance_km: number | null = null;
  const km = t.match(/(\d+(?:\.\d+)?)\s*(?:km|k\b)/);
  const mi = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/); // \b so "min" isn't read as miles
  if (km) distance_km = parseFloat(km[1]);
  else if (mi) distance_km = +(parseFloat(mi[1]) * 1.60934).toFixed(2);

  let pace: string | null = null;
  const pc = t.match(/(\d+:\d{2})\s*(?:\/|per)\s*km/);
  if (pc) pace = `${pc[1]}/km`;

  return { type, duration_min, distance_km, pace };
}

export function addActivity(input: any) {
  const date = input.date || todayISO();
  const source = input.source ? String(input.source).trim() : null;
  const externalId = input.external_id ? String(input.external_id).trim() : null;
  if (source && externalId) {
    const existing = db.prepare(`SELECT * FROM activities WHERE source = ? AND external_id = ?`).get(source, externalId) as any;
    if (existing) return existing;
  }
  let { type, duration_min, distance_km, pace } = input;
  const fromText = !!(input.text && String(input.text).trim());
  if (fromText && (!type || duration_min == null)) {
    const p = parseActivity(input.text);
    type = type || p.type;
    duration_min = duration_min ?? p.duration_min;
    distance_km = distance_km ?? p.distance_km;
    pace = pace ?? p.pace;
  }
  // Free-text entries get queued for background agentic enrichment — but only if
  // it's enabled, so a disabled install records 'skipped' directly (no pending
  // churn, no wasted queue round-trip) rather than briefly showing 'pending'.
  const status = input.enrichment_status !== undefined
    ? input.enrichment_status
    : fromText && !source ? (getSettings().enrich_enabled ? "pending" : "skipped") : null;
  const info = db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, pace, rpe, notes, source, external_id, enrichment_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(date, type || "other", input.text || null, duration_min ?? null, distance_km ?? null, pace ?? null, input.rpe ?? null, input.notes ?? null, source, externalId, status);
  const row = db.prepare(`SELECT * FROM activities WHERE id = ?`).get(info.lastInsertRowid) as any;
  // Kick the enrichment queue AFTER the row exists. enrich.ts imports repo.ts,
  // so we import lazily here to avoid a module-eval circular dependency.
  if (status === "pending") {
    import("./enrich.js").then((m) => m.enqueueEnrich("activity", row.id)).catch(() => {});
  }
  invalidateDayRead(date); // a logged activity (run/walk/class) is movement — today's Brief should reflect it
  return row;
}

export function listActivities(limit = 20) {
  return db.prepare(`SELECT * FROM activities ORDER BY date DESC, id DESC LIMIT ?`).all(limit);
}

export function getActivity(id: number) {
  return db.prepare(`SELECT * FROM activities WHERE id = ?`).get(id) ?? null;
}

// Update only the structured fields the enricher provides; leave the rest intact.
export function updateActivityFields(id: number, fields: Record<string, any>) {
  const allowed = ["type", "duration_min", "distance_km", "pace", "rpe", "notes"];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getActivity(id);
  vals.push(id);
  db.prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getActivity(id);
}

export function setActivityEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE activities SET enrichment_status = ? WHERE id = ?`).run(status, id);
  return getActivity(id);
}

// ---------- Garmin source data ----------
export interface GarminSourceInput {
  mode?: "unofficial" | "official" | "manual";
  label?: string | null;
  auth_status?: string | null;
  token_json?: any;
  sync_cursor?: string | null;
  last_sync_at?: string | null;
}

export interface GarminActivityInput {
  external_id: string;
  date?: string;
  start_time?: string | null;
  type?: string | null;
  name?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  calories?: number | null;
  avg_hr?: number | null;
  max_hr?: number | null;
  ascent_m?: number | null;
  training_load?: number | null;
  training_effect?: number | null;
  moving_min?: number | null;
  elevation_loss_m?: number | null;
  aerobic_te?: number | null;
  anaerobic_te?: number | null;
  te_label?: string | null;
  avg_cadence?: number | null;
  max_cadence?: number | null;
  avg_power?: number | null;
  max_power?: number | null;
  norm_power?: number | null;
  avg_speed?: number | null;
  max_speed?: number | null;
  avg_temp?: number | null;
  vo2max?: number | null;
  hr_zones?: any;            // [{zone,secs,low_hr}] — serialized to hr_zones_json
  exercise_sets?: any;       // [{category,name,reps,weight_kg,duration_sec,set_type}] — serialized to exercise_sets_json
  raw?: any;
}

export interface GarminDailyMetricInput {
  date: string;
  steps?: number | null;
  sleep_min?: number | null;
  sleep_score?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  stress_avg?: number | null;
  body_battery_avg?: number | null;
  body_battery_min?: number | null;
  body_battery_max?: number | null;
  active_calories?: number | null;
  // full-body dataset
  deep_sleep_min?: number | null;
  light_sleep_min?: number | null;
  rem_sleep_min?: number | null;
  awake_min?: number | null;
  nap_min?: number | null;
  restless_count?: number | null;
  avg_sleep_stress?: number | null;
  hrv_status?: string | null;
  max_hr?: number | null;
  min_hr?: number | null;
  hr_7d_avg?: number | null;
  stress_max?: number | null;
  body_battery_charged?: number | null;
  body_battery_drained?: number | null;
  respiration_avg?: number | null;
  respiration_min?: number | null;
  respiration_max?: number | null;
  spo2_avg?: number | null;
  spo2_min?: number | null;
  skin_temp_dev_c?: number | null;
  total_calories?: number | null;
  bmr_calories?: number | null;
  floors_climbed?: number | null;
  intensity_min_moderate?: number | null;
  intensity_min_vigorous?: number | null;
  distance_m?: number | null;
  vo2max?: number | null;
  vo2max_cycling?: number | null;
  training_readiness?: number | null;
  training_status?: string | null;
  acute_load?: number | null;
  fitness_age?: number | null;
  weight_kg?: number | null;
  body_fat_pct?: number | null;
  muscle_mass_kg?: number | null;
  body_water_pct?: number | null;
  bone_mass_kg?: number | null;
  bmi?: number | null;
  visceral_fat?: number | null;
  raw?: any;
}

function jsonOrNull(v: any): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function hydrateJson(row: any, key = "raw_json") {
  if (!row) return row;
  let raw: any = null;
  try { raw = row[key] ? JSON.parse(row[key]) : null; } catch { raw = null; }
  return { ...row, raw };
}

function cleanGarminMode(mode: any): "unofficial" | "official" | "manual" {
  return ["unofficial", "official", "manual"].includes(mode) ? mode : "unofficial";
}

function normalizeGarminType(t: any): string {
  const s = String(t ?? "").toLowerCase();
  if (/\b(run|running|trail_running|treadmill)\b/.test(s)) return "run";
  if (/\b(cycl|bike|biking|mountain|mtb|gravel|road_biking)\b/.test(s)) return "ride";
  if (/\b(swim|swimming)\b/.test(s)) return "swim";
  if (/\b(walk|hike|hiking)\b/.test(s)) return "hike";
  if (/\b(strength|cardio|training|fitness_equipment)\b/.test(s)) return "other";
  return s || "other";
}

// Garmin strength-style activities (strength_training, functional_strength_training,
// indoor_cardio with weights, etc.) are modeled as Cairn *sessions*, not loose
// activities. Matches the raw provider type, not normalizeGarminType (which folds
// these into "other"). Lifting/weight phrasing also counts.
export function isStrengthGarminType(t: any): boolean {
  return /strength|weight|lifting/i.test(String(t ?? ""));
}

function paceFrom(durationMin?: number | null, distanceKm?: number | null, type?: string | null): string | null {
  if (!durationMin || !distanceKm || distanceKm <= 0 || normalizeGarminType(type) !== "run") return null;
  const secPerKm = Math.round((durationMin * 60) / distanceKm);
  const m = Math.floor(secPerKm / 60);
  const s = String(secPerKm % 60).padStart(2, "0");
  return `${m}:${s}/km`;
}

export function upsertGarminSource(input: GarminSourceInput = {}) {
  const label = (input.label ?? "default").toString().trim() || "default";
  const mode = cleanGarminMode(input.mode);
  const cur = db.prepare(`SELECT * FROM garmin_sources WHERE provider = 'garmin' AND label = ?`).get(label) as any;
  if (!cur) {
    const info = db.prepare(
      `INSERT INTO garmin_sources (provider, mode, label, auth_status, token_json, sync_cursor, last_sync_at)
       VALUES ('garmin', ?, ?, ?, ?, ?, ?)`
    ).run(mode, label, input.auth_status ?? "not_configured", jsonOrNull(input.token_json), input.sync_cursor ?? null, input.last_sync_at ?? null);
    return db.prepare(`SELECT * FROM garmin_sources WHERE id = ?`).get(info.lastInsertRowid);
  }
  db.prepare(
    `UPDATE garmin_sources SET mode = ?, auth_status = COALESCE(?, auth_status),
       token_json = COALESCE(?, token_json), sync_cursor = COALESCE(?, sync_cursor),
       last_sync_at = COALESCE(?, last_sync_at), updated_at = datetime('now')
     WHERE id = ?`
  ).run(mode, input.auth_status ?? null, jsonOrNull(input.token_json), input.sync_cursor ?? null, input.last_sync_at ?? null, cur.id);
  return db.prepare(`SELECT * FROM garmin_sources WHERE id = ?`).get(cur.id);
}

export function listGarminSources() {
  return db.prepare(`SELECT id, provider, mode, label, auth_status, sync_cursor, last_sync_at, created_at, updated_at FROM garmin_sources ORDER BY id`).all();
}

export function getGarminSource(id?: number | null) {
  if (id) return db.prepare(`SELECT * FROM garmin_sources WHERE id = ?`).get(id) ?? null;
  return db.prepare(`SELECT * FROM garmin_sources WHERE provider = 'garmin' ORDER BY id LIMIT 1`).get() ?? null;
}

export function upsertGarminActivity(input: GarminActivityInput, sourceId?: number | null) {
  if (!input.external_id || !String(input.external_id).trim()) throw new Error("external_id required");
  const source = sourceId ? getGarminSource(sourceId) : upsertGarminSource({ label: "default" });
  if (!source) throw new Error("Garmin source not found");
  const start = input.start_time ?? null;
  const date = input.date || (start ? String(start).slice(0, 10) : todayISO());
  const type = normalizeGarminType(input.type);
  const name = input.name || `Garmin ${type}`;
  // Strength activities become enriched Cairn *sessions* (see reconcileGarminStrength),
  // so they never get a generic `activities` row that would duplicate the workout in
  // Today's RECENT list. Cardio (run/walk/ride) still surfaces as an activity.
  const strength = isStrengthGarminType(input.type);
  const activity = strength ? null : (addActivity({
    date, type, duration_min: input.duration_min ?? null, distance_km: input.distance_km ?? null,
    pace: paceFrom(input.duration_min, input.distance_km, type), text: name,
    source: "garmin", external_id: String(input.external_id), enrichment_status: null,
    notes: [
      input.avg_hr ? `avg HR ${Math.round(input.avg_hr)}` : null,
      input.training_load ? `load ${Math.round(input.training_load)}` : null,
      input.training_effect ? `effect ${input.training_effect}` : null,
    ].filter(Boolean).join(" · ") || null,
  }) as any);
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, activity_id, date, start_time, type, name, duration_min, distance_km,
        calories, avg_hr, max_hr, ascent_m, training_load, training_effect,
        moving_min, elevation_loss_m, aerobic_te, anaerobic_te, te_label, avg_cadence, max_cadence,
        avg_power, max_power, norm_power, avg_speed, max_speed, avg_temp, vo2max, hr_zones_json,
        exercise_sets_json, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_id, external_id) DO UPDATE SET
       activity_id = COALESCE(excluded.activity_id, garmin_activities.activity_id),
       date = excluded.date, start_time = excluded.start_time, type = excluded.type, name = excluded.name,
       duration_min = excluded.duration_min, distance_km = excluded.distance_km, calories = excluded.calories,
       avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, ascent_m = excluded.ascent_m,
       training_load = excluded.training_load, training_effect = excluded.training_effect,
       moving_min = excluded.moving_min, elevation_loss_m = excluded.elevation_loss_m,
       aerobic_te = excluded.aerobic_te, anaerobic_te = excluded.anaerobic_te, te_label = excluded.te_label,
       avg_cadence = excluded.avg_cadence, max_cadence = excluded.max_cadence,
       avg_power = excluded.avg_power, max_power = excluded.max_power, norm_power = excluded.norm_power,
       avg_speed = excluded.avg_speed, max_speed = excluded.max_speed, avg_temp = excluded.avg_temp,
       vo2max = excluded.vo2max,
       hr_zones_json = COALESCE(excluded.hr_zones_json, garmin_activities.hr_zones_json),
       exercise_sets_json = COALESCE(excluded.exercise_sets_json, garmin_activities.exercise_sets_json),
       raw_json = excluded.raw_json, synced_at = datetime('now')`
  ).run(
    source.id, String(input.external_id), activity?.id ?? null, date, start, type, name,
    input.duration_min ?? null, input.distance_km ?? null, input.calories ?? null,
    input.avg_hr ?? null, input.max_hr ?? null, input.ascent_m ?? null,
    input.training_load ?? null, input.training_effect ?? null,
    input.moving_min ?? null, input.elevation_loss_m ?? null, input.aerobic_te ?? null,
    input.anaerobic_te ?? null, input.te_label ?? null, input.avg_cadence ?? null, input.max_cadence ?? null,
    input.avg_power ?? null, input.max_power ?? null, input.norm_power ?? null,
    input.avg_speed ?? null, input.max_speed ?? null, input.avg_temp ?? null, input.vo2max ?? null,
    jsonOrNull(input.hr_zones), jsonOrNull(input.exercise_sets), jsonOrNull(input.raw)
  );
  return hydrateJson(db.prepare(`SELECT * FROM garmin_activities WHERE source_id = ? AND external_id = ?`).get(source.id, String(input.external_id)));
}

// The normalized daily columns, in the order they bind. `date`/`source_id` are
// the conflict key (handled separately); `raw_json` is appended last. Built from
// a map so the ~40-column upsert stays readable and COALESCE-merges on conflict
// (a later partial sync never nulls a field an earlier richer one filled).
const GARMIN_DAILY_COLS = [
  "steps", "sleep_min", "sleep_score", "resting_hr", "hrv_ms", "stress_avg",
  "body_battery_avg", "body_battery_min", "body_battery_max", "active_calories",
  "deep_sleep_min", "light_sleep_min", "rem_sleep_min", "awake_min", "nap_min",
  "restless_count", "avg_sleep_stress", "hrv_status", "max_hr", "min_hr", "hr_7d_avg",
  "stress_max", "body_battery_charged", "body_battery_drained",
  "respiration_avg", "respiration_min", "respiration_max", "spo2_avg", "spo2_min",
  "skin_temp_dev_c", "total_calories", "bmr_calories", "floors_climbed",
  "intensity_min_moderate", "intensity_min_vigorous", "distance_m", "vo2max",
  "vo2max_cycling", "training_readiness", "training_status", "acute_load", "fitness_age",
  "weight_kg", "body_fat_pct", "muscle_mass_kg", "body_water_pct", "bone_mass_kg",
  "bmi", "visceral_fat",
] as const;

export function upsertGarminDailyMetric(input: GarminDailyMetricInput, sourceId?: number | null) {
  const source = sourceId ? getGarminSource(sourceId) : upsertGarminSource({ label: "default" });
  if (!source) throw new Error("Garmin source not found");
  const cols = ["source_id", "date", ...GARMIN_DAILY_COLS, "raw_json"];
  const placeholders = cols.map(() => "?").join(", ");
  // COALESCE(excluded, existing) so a sparse re-sync preserves richer prior values.
  const updates = [...GARMIN_DAILY_COLS, "raw_json"]
    .map((c) => `${c} = COALESCE(excluded.${c}, garmin_daily_metrics.${c})`)
    .join(", ");
  const values: any[] = [source.id, input.date];
  for (const c of GARMIN_DAILY_COLS) values.push((input as any)[c] ?? null);
  values.push(jsonOrNull(input.raw));
  db.prepare(
    `INSERT INTO garmin_daily_metrics (${cols.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT(source_id, date) DO UPDATE SET ${updates}, updated_at = datetime('now')`
  ).run(...values);
  invalidateDayRead(); // a Garmin sync brings fresh recovery → today's Brief recomputes
  return hydrateJson(db.prepare(`SELECT * FROM garmin_daily_metrics WHERE source_id = ? AND date = ?`).get(source.id, input.date));
}

// hydrateJson + parse the per-activity JSON arrays (hr_zones, exercise_sets) into
// clean fields, dropping the raw *_json strings.
function hydrateGarminActivity(r: any) {
  if (!r) return r;
  const out = hydrateJson(r) as any;
  for (const key of ["hr_zones_json", "exercise_sets_json"] as const) {
    const field = key.replace(/_json$/, "");
    let v: any = null;
    try { v = out[key] ? JSON.parse(out[key]) : null; } catch { v = null; }
    out[field] = v;
    delete out[key];
  }
  return out;
}

export function listGarminActivities(limit = 30) {
  return (db.prepare(`SELECT * FROM garmin_activities ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[]).map((r) => hydrateGarminActivity(r));
}

export function getGarminActivity(id: number) {
  return hydrateGarminActivity(db.prepare(`SELECT * FROM garmin_activities WHERE id = ?`).get(id));
}

// Strength-style Garmin activities for a single date or a recent window (used by
// the reconcile endpoint / MCP tool). Filtered by raw provider type.
export function listStrengthGarminActivities(opts: { date?: string; days?: number } = {}): any[] {
  if (opts.date) {
    return (db.prepare(`SELECT * FROM garmin_activities WHERE date = ? ORDER BY id`).all(opts.date) as any[])
      .filter((r) => isStrengthGarminType(r.type));
  }
  const days = Math.max(1, Math.min(365, opts.days ?? 30));
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  return (db.prepare(`SELECT * FROM garmin_activities WHERE date >= ? ORDER BY date DESC, id DESC`).all(since) as any[])
    .filter((r) => isStrengthGarminType(r.type));
}

// Deterministic merge of a Garmin strength activity into the day's Cairn session:
// attach the physiology layer (HR/zones/calories/TE) to sessions.garmin_json, link
// garmin_activities.session_id, and drop any stale duplicate generic activity row.
// Runs during sync regardless of agent availability; the agentic layer (enrich.ts)
// adds the narrative summary + extrapolated exercises on top. Returns null if the
// row isn't a strength activity. Idempotent (safe to re-run on every sync).
export function reconcileGarminStrength(garminActivityId: number) {
  const row = db.prepare(`SELECT * FROM garmin_activities WHERE id = ?`).get(garminActivityId) as any;
  if (!row || !isStrengthGarminType(row.type)) return null;
  const date = row.date || todayISO();

  // Clean up any stale generic activity row this Garmin activity created before we
  // started modeling strength as a session (so it stops duplicating in RECENT).
  if (row.external_id) {
    db.prepare(`DELETE FROM activities WHERE source = 'garmin' AND external_id = ?`).run(String(row.external_id));
  }

  const session = getOrCreateSession(date) as any;

  let hr_zones: any = null;
  try { hr_zones = row.hr_zones_json ? JSON.parse(row.hr_zones_json) : null; } catch { hr_zones = null; }
  const durationMin = row.duration_min ?? row.moving_min ?? null;

  // A day with two strength activities keeps the longer one as the session's
  // primary blob, but always refreshes the link. When re-reconciling the SAME
  // activity, preserve any narrative/extrapolation a prior agentic pass wrote.
  let existing: any = null;
  try { existing = session.garmin_json ? JSON.parse(session.garmin_json) : null; } catch { existing = null; }
  const sameActivity = existing && existing.external_id === row.external_id;
  const isPrimary = !existing || sameActivity || (durationMin ?? 0) >= (existing.duration_min ?? -1);

  if (isPrimary) {
    const blob = {
      external_id: row.external_id ?? null,
      type: row.type ?? "strength_training",
      name: row.name ?? null,
      duration_min: durationMin,
      avg_hr: row.avg_hr ?? null,
      max_hr: row.max_hr ?? null,
      calories: row.calories ?? null,
      training_effect: row.training_effect ?? null,
      aerobic_te: row.aerobic_te ?? null,
      anaerobic_te: row.anaerobic_te ?? null,
      hr_zones,
      summary: sameActivity ? existing.summary ?? null : null,
      intensity: sameActivity ? existing.intensity ?? null : null,
      extrapolated: sameActivity ? !!existing.extrapolated : false,
      reconciled_at: new Date().toISOString(),
      agent: sameActivity ? existing.agent ?? null : null,
    };
    db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(blob), session.id);
  }
  db.prepare(`UPDATE garmin_activities SET session_id = ? WHERE id = ?`).run(session.id, garminActivityId);
  invalidateDayRead(date);

  let exercise_sets: any = null;
  try { exercise_sets = row.exercise_sets_json ? JSON.parse(row.exercise_sets_json) : null; } catch { exercise_sets = null; }
  const sets = setsForSession(session.id) as any[];
  return { session: getSessionDetail(session.id), has_manual_sets: sets.length > 0, exercise_sets, is_primary: isPrimary };
}

// Merge the agentic narrative (summary / intensity / extrapolated flag / agent)
// into a session's existing Garmin blob. Used by enrich.ts after the agent runs.
export function updateSessionGarminNarrative(
  sessionId: number,
  patch: { summary?: string | null; intensity?: string | null; extrapolated?: boolean; agent?: string | null }
) {
  const s = db.prepare(`SELECT garmin_json FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  let blob: any = {};
  try { blob = s.garmin_json ? JSON.parse(s.garmin_json) : {}; } catch { blob = {}; }
  if (patch.summary !== undefined) blob.summary = patch.summary;
  if (patch.intensity !== undefined) blob.intensity = patch.intensity;
  if (patch.extrapolated !== undefined) blob.extrapolated = !!patch.extrapolated;
  if (patch.agent !== undefined) blob.agent = patch.agent;
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(blob), sessionId);
  invalidateDayRead();
  return getSessionDetail(sessionId);
}

export function listGarminDailyMetrics(limit = 30) {
  return (db.prepare(`SELECT * FROM garmin_daily_metrics ORDER BY date DESC LIMIT ?`).all(limit) as any[]).map((r) => hydrateJson(r));
}

export function getGarminCoachSummary(days = 14) {
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);
  const source = listGarminSources()[0] ?? null;
  const activities = db.prepare(
    `SELECT type,
            COUNT(*) AS sessions,
            ROUND(COALESCE(SUM(duration_min), 0), 1) AS minutes,
            ROUND(COALESCE(SUM(distance_km), 0), 2) AS distance_km,
            ROUND(AVG(avg_hr), 1) AS avg_hr,
            ROUND(COALESCE(SUM(training_load), 0), 1) AS training_load,
            MAX(date) AS last_date
     FROM garmin_activities
     WHERE date >= ?
     GROUP BY type
     ORDER BY minutes DESC`
  ).all(since) as any[];
  const hard = (db.prepare(
    `SELECT date, type, name, duration_min, distance_km, avg_hr, max_hr, training_load,
            training_effect, aerobic_te, anaerobic_te, te_label, avg_power, vo2max, hr_zones_json
     FROM garmin_activities
     WHERE date >= ? AND (training_load >= 80 OR training_effect >= 3.5 OR duration_min >= 90)
     ORDER BY date DESC, id DESC LIMIT 8`
  ).all(since) as any[]).map((r) => {
    let hr_zones: any = null;
    try { hr_zones = r.hr_zones_json ? JSON.parse(r.hr_zones_json) : null; } catch { hr_zones = null; }
    const { hr_zones_json, ...rest } = r;
    return { ...rest, hr_zones };
  });
  const daily = db.prepare(
    `SELECT
       ROUND(AVG(sleep_min), 1) AS avg_sleep_min,
       ROUND(AVG(sleep_score), 1) AS avg_sleep_score,
       ROUND(AVG(deep_sleep_min), 1) AS avg_deep_sleep_min,
       ROUND(AVG(rem_sleep_min), 1) AS avg_rem_sleep_min,
       ROUND(AVG(resting_hr), 1) AS avg_resting_hr,
       ROUND(AVG(hrv_ms), 1) AS avg_hrv_ms,
       ROUND(AVG(stress_avg), 1) AS avg_stress,
       ROUND(AVG(body_battery_avg), 1) AS avg_body_battery,
       ROUND(AVG(body_battery_max), 1) AS avg_body_battery_max,
       ROUND(AVG(respiration_avg), 1) AS avg_respiration,
       ROUND(AVG(spo2_avg), 1) AS avg_spo2,
       ROUND(AVG(active_calories), 1) AS avg_active_calories,
       ROUND(AVG(intensity_min_vigorous), 1) AS avg_vigorous_min,
       ROUND(AVG(training_readiness), 1) AS avg_training_readiness,
       MAX(vo2max) AS vo2max,
       MAX(training_status) AS training_status,
       MAX(hrv_status) AS hrv_status,
       MAX(skin_temp_dev_c) AS skin_temp_dev_c,
       MAX(weight_kg) AS weight_kg,
       MAX(body_fat_pct) AS body_fat_pct,
       MAX(muscle_mass_kg) AS muscle_mass_kg,
       MAX(date) AS last_date
     FROM garmin_daily_metrics
     WHERE date >= ?`
  ).get(since) as any;
  return { days, since, source, activities, hard_sessions: hard, recovery: daily };
}

// ---------- memory ----------
export function addMemory(content: string, kind = "observation", source = "user") {
  const trimmed = (content ?? "").toString().trim();
  // Dedupe exact repeats (case-insensitive) — background enrichment can re-surface
  // the same fact across entries; prompt-only dedup isn't enforced. Return the
  // existing row instead of accumulating near-identical noise.
  const dup = db.prepare(`SELECT * FROM memory WHERE content = ? COLLATE NOCASE`).get(trimmed);
  if (dup) return dup;
  const info = db.prepare(`INSERT INTO memory (kind, content, source) VALUES (?, ?, ?)`).run(kind, trimmed, source);
  return db.prepare(`SELECT * FROM memory WHERE id = ?`).get(info.lastInsertRowid);
}

export function listMemory(limit = 50) {
  return db.prepare(`SELECT * FROM memory ORDER BY id DESC LIMIT ?`).all(limit);
}

export function getMemory(id: number) {
  return db.prepare(`SELECT * FROM memory WHERE id = ?`).get(id) ?? null;
}

export function updateMemory(id: number, patch: { content?: string; kind?: string }) {
  const cur = getMemory(id) as any;
  if (!cur) return null;
  db.prepare(`UPDATE memory SET content = ?, kind = ? WHERE id = ?`).run(
    patch.content ?? cur.content,
    patch.kind ?? cur.kind,
    id
  );
  return getMemory(id);
}

export function deleteMemory(id: number) {
  return { deleted: db.prepare(`DELETE FROM memory WHERE id = ?`).run(id).changes };
}

// ---------- meal plans ----------
export function createMealPlan(agent: string, raw: string, parsed: any) {
  const info = db.prepare(
    `INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json) VALUES (?, ?, ?, ?)`
  ).run(todayISO(), agent, raw || "", parsed ? JSON.stringify(parsed) : null);
  return hydrate(db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(info.lastInsertRowid));
}

export function listMealPlans(limit = 10) {
  return (db.prepare(`SELECT * FROM meal_plans ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrate);
}

export function setMealPlanStatus(id: number, status: string) {
  db.prepare(`UPDATE meal_plans SET status = ? WHERE id = ?`).run(status, id);
  return hydrate(db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id));
}

export function getMealPlan(id: number) {
  const row = db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id);
  return row ? hydrate(row) : null;
}

// Agent (and PWA) supplied meal objects are coerced/clamped before write —
// numbers via Number() with sane ceilings, strings capped to keep parsed_json honest.
function clampNum(v: any, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n));
}

// Length guard for stored human-facing text. When it has to truncate it breaks on
// a word boundary and adds an ellipsis (never a mid-word cut like "…bloodwork pane"),
// and the result still fits within `max`.
function capStr(v: any, max = 300): string {
  const s = String(v ?? "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  const head = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.!?-]+$/, "");
  return head + "…";
}

function coerceMeal(m: any) {
  return {
    name: capStr(m?.name),
    items: capStr(m?.items),
    kcal: clampNum(m?.kcal, 3000),
    protein_g: clampNum(m?.protein_g, 500),
    carbs_g: clampNum(m?.carbs_g, 500),
    fat_g: clampNum(m?.fat_g, 500),
  };
}

// Replace the days array inside a meal plan's parsed_json — used for manual
// reordering/editing of meals. PRESERVES every other key the agent emitted
// (daily_kcal, shopping, notes, ...). Returns the hydrated updated row, or
// null on unknown id / invalid days.
export function updateMealPlanDays(id: number, days: any) {
  const plan = getMealPlan(id);
  if (!plan) return null;
  if (!Array.isArray(days)) throw new Error("days must be an array");
  const cleanDays = days.map((d: any) => ({
    ...(d && typeof d === "object" ? d : {}),
    day: capStr(d?.day, 40),
    ...(d?.note !== undefined && d?.note !== null ? { note: capStr(d.note) } : {}),
    // Carry a cached recipe through reorders/edits (re-clamped) — coerceMeal
    // alone would silently drop it. Swaps still drop it on purpose: a new
    // meal needs a new recipe.
    meals: (Array.isArray(d?.meals) ? d.meals : []).map((m: any) => {
      const recipe = m?.recipe ? coerceRecipe(m.recipe) : null;
      return recipe ? { ...coerceMeal(m), recipe } : coerceMeal(m);
    }),
  }));
  const parsed = { ...(plan.parsed && typeof plan.parsed === "object" ? plan.parsed : {}), days: cleanDays };
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), id);
  return getMealPlan(id);
}

// Swap one meal in place (agentic "swap this meal"). Returns { plan, meal }
// with the coerced/clamped meal actually written, or null when the plan/day/
// index can't be found.
export function swapMealInPlan(id: number, day: string, mealIndex: number, meal: any) {
  const plan = getMealPlan(id);
  if (!plan || !plan.parsed || !Array.isArray(plan.parsed.days)) return null;
  const dayKey = String(day ?? "").trim().toLowerCase();
  const target = plan.parsed.days.find((d: any) => String(d?.day ?? "").trim().toLowerCase() === dayKey);
  if (!target || !Array.isArray(target.meals)) return null;
  const idx = Number(mealIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= target.meals.length) return null;
  const clean = coerceMeal(meal);
  target.meals[idx] = clean;
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(plan.parsed), id);
  return { plan: getMealPlan(id), meal: clean };
}

// Agent-provided recipes are coerced/clamped before write, same discipline as
// coerceMeal. Returns null when nothing usable remains (no steps AND no
// ingredients after coercion).
function coerceRecipe(r: any) {
  if (!r || typeof r !== "object") return null;
  const strList = (v: any, maxItems: number, maxLen: number): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((s: any) => typeof s === "string" && s.trim())
      .slice(0, maxItems)
      .map((s: string) => s.trim().slice(0, maxLen));
  const timeMin = Number(r.time_min);
  const servings = Number(r.servings);
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .filter((i: any) => i && typeof i === "object" && typeof i.item === "string" && i.item.trim())
    .slice(0, 20)
    .map((i: any) => ({ item: capStr(i.item, 120), qty: capStr(i.qty, 40) }));
  const steps = strList(r.steps, 15, 300);
  const tips = strList(r.tips, 6, 200);
  if (!steps.length && !ingredients.length) return null;
  return {
    summary: capStr(r.summary, 400),
    time_min: Number.isFinite(timeMin) ? Math.min(240, Math.max(0, Math.round(timeMin))) : 0,
    servings: Number.isFinite(servings) ? Math.min(8, Math.max(1, Math.round(servings))) : 1,
    ingredients,
    steps,
    tips,
  };
}

// Cache an agent-written recipe on one planned meal, under
// parsed.days[day].meals[mealIndex].recipe. Day matches case-insensitively
// like swapMealInPlan; every other parsed_json key is preserved. Returns
// { plan, recipe } or null when plan/day/meal is missing or the recipe is
// unusable after coercion.
export function setMealRecipe(planId: number, day: string, mealIndex: number, recipe: any) {
  const plan = getMealPlan(planId);
  if (!plan || !plan.parsed || !Array.isArray(plan.parsed.days)) return null;
  const dayKey = String(day ?? "").trim().toLowerCase();
  const target = plan.parsed.days.find((d: any) => String(d?.day ?? "").trim().toLowerCase() === dayKey);
  if (!target || !Array.isArray(target.meals)) return null;
  const idx = Number(mealIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= target.meals.length) return null;
  const clean = coerceRecipe(recipe);
  if (!clean) return null;
  target.meals[idx] = { ...(target.meals[idx] && typeof target.meals[idx] === "object" ? target.meals[idx] : {}), recipe: clean };
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(plan.parsed), planId);
  return { plan: getMealPlan(planId), recipe: clean };
}

// ---------- food notes ----------
export function addFoodNote(meal: string, raw: string, parsed: any, imagePath?: string) {
  // Free-text food notes (non-empty raw) get queued for background enrichment —
  // only when enabled, else recorded 'skipped' directly (see addActivity).
  const fromText = !!(raw && String(raw).trim());
  const status = fromText ? (getSettings().enrich_enabled ? "pending" : "skipped") : null;
  const info = db.prepare(
    `INSERT INTO food_notes (meal, raw_output, parsed_json, image_path, enrichment_status) VALUES (?, ?, ?, ?, ?)`
  ).run(meal || "meal", raw || "", parsed ? JSON.stringify(parsed) : null, imagePath ?? null, status);
  const row = hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(info.lastInsertRowid));
  // Lazy import to avoid a circular dependency (enrich.ts imports repo.ts).
  if (status === "pending") {
    import("./enrich.js").then((m) => m.enqueueEnrich("food", row.id)).catch(() => {});
  }
  return row;
}

export function listFoodNotes(limit = 20) {
  return (db.prepare(`SELECT * FROM food_notes ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrate);
}

export function getFoodNote(id: number) {
  return hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(id));
}

export function deleteFoodNote(id: number) {
  const row = getFoodNote(id);
  if (!row) return { deleted: false, id };
  db.prepare(`DELETE FROM food_notes WHERE id = ?`).run(id);
  return { deleted: true, id };
}

// Overwrite the parsed_json blob with the enricher's structured estimate.
export function updateFoodNoteParsed(id: number, parsed: any) {
  db.prepare(`UPDATE food_notes SET parsed_json = ? WHERE id = ?`).run(
    parsed ? JSON.stringify(parsed) : null,
    id
  );
  return getFoodNote(id);
}

export function setFoodNoteEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE food_notes SET enrichment_status = ? WHERE id = ?`).run(status, id);
  return getFoodNote(id);
}

function hydrate(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// ---------- chat ----------
function hydrateChat(row: any) {
  if (!row) return row;
  let meta: any = null;
  try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { meta = null; }
  // A draft's apply button is rendered from this meta on every load, but the
  // proposal lives on independently — once applied (here or from the proposals
  // list) the chat message must reflect that, not keep offering "Apply". Stamp
  // each draft with its CURRENT proposal status so the UI can show it applied.
  if (meta?.drafts?.length) {
    for (const d of meta.drafts) {
      if (d?.id == null) continue;
      const p = db.prepare(`SELECT status FROM plan_proposals WHERE id = ?`).get(d.id) as any;
      d.status = p?.status ?? "missing"; // 'missing' = proposal was deleted/never persisted
    }
  }
  return { ...row, meta };
}

export function addChatMessage(role: string, content: string, agent?: string | null, meta?: any) {
  const info = db
    .prepare(`INSERT INTO chat_messages (role, content, agent, meta) VALUES (?, ?, ?, ?)`)
    .run(role, content, agent ?? null, meta ? JSON.stringify(meta) : null);
  return hydrateChat(db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(info.lastInsertRowid));
}

// The live conversation: archived turns are excluded (they stay in the DB and
// in /api/export, but a "fresh start" or clear removes them from view).
export function listChatMessages(limit = 50) {
  const rows = db.prepare(`SELECT * FROM chat_messages WHERE archived_at IS NULL ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  return rows.reverse().map(hydrateChat);
}

// "Fresh start" / clear both archive rather than delete: chat turns are part of
// the athlete's history and exports, so nothing is ever hard-deleted anymore.
export function archiveChat() {
  return { archived: db.prepare(`UPDATE chat_messages SET archived_at = datetime('now') WHERE archived_at IS NULL`).run().changes };
}

// Kept for the existing DELETE /api/chat surface; same archive semantics,
// same `{ cleared }` response shape callers already expect.
export function clearChat() {
  return { cleared: archiveChat().archived };
}

// Persist the durable facts an agent distilled out of a conversation being
// archived (chat reset). Type-coerced and clamped before write; addMemory
// dedupes exact repeats, so re-distilling the same fact is a no-op.
export function saveDistilledMemories(parsed: any) {
  const KINDS = new Set(["observation", "preference", "constraint", "decision", "injury", "milestone"]);
  const items = Array.isArray(parsed?.memories) ? parsed.memories : [];
  let saved = 0;
  for (const m of items.slice(0, 12)) {
    const content = (m?.content ?? "").toString().trim().slice(0, 300);
    if (!content) continue;
    const kind = KINDS.has(String(m?.kind)) ? String(m.kind) : "observation";
    addMemory(content, kind, "chat-distill");
    saved++;
  }
  return saved;
}

// ---------- chat history (read-only browse + search over archived turns) ----------
// Each "fresh start" stamps the live turns with one shared archived_at, so a
// past conversation IS the set of rows sharing an archived_at. Group them into
// browsable sessions, newest first, each with a one-line preview.
export function listArchivedSessions(limit = 50) {
  const rows = db.prepare(`
    SELECT m.archived_at,
           COUNT(*)          AS count,
           MIN(m.created_at) AS started_at,
           MAX(m.created_at) AS ended_at,
           (SELECT content FROM chat_messages p
             WHERE p.archived_at = m.archived_at AND p.role = 'user'
               AND p.content <> '' AND p.content <> '(photo)'
             ORDER BY p.id ASC LIMIT 1) AS preview
    FROM chat_messages m
    WHERE m.archived_at IS NOT NULL
    GROUP BY m.archived_at
    ORDER BY m.archived_at DESC
    LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as any[];
  return rows.map((r) => ({
    archived_at: r.archived_at, count: r.count, started_at: r.started_at, ended_at: r.ended_at,
    preview: (r.preview ?? "").toString().replace(/\s+/g, " ").trim().slice(0, 120),
  }));
}

// One archived conversation, chronological, hydrated like the live list.
export function getArchivedConversation(archivedAt: string) {
  const rows = db.prepare(`SELECT * FROM chat_messages WHERE archived_at = ? ORDER BY id ASC`).all(archivedAt) as any[];
  return rows.map(hydrateChat);
}

// Keyword search across the whole history (live + archived). Each hit carries
// its session key (archived_at, or null for the live thread) and a short
// snippet centered on the match, so the UI can jump straight to the source.
export function searchChatMessages(q: string, limit = 40) {
  const query = (q ?? "").toString().trim();
  if (!query) return [];
  const like = "%" + query.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const rows = db.prepare(`
    SELECT * FROM chat_messages
    WHERE content LIKE ? ESCAPE '\\'
    ORDER BY id DESC LIMIT ?`).all(like, Math.min(200, Math.max(1, limit))) as any[];
  const lower = query.toLowerCase();
  return rows.map((r) => {
    const m = hydrateChat(r);
    const content = (m.content ?? "").toString();
    const idx = content.toLowerCase().indexOf(lower);
    let snippet = content.replace(/\s+/g, " ").trim();
    if (idx > 60) snippet = "…" + content.slice(Math.max(0, idx - 40)).replace(/\s+/g, " ").trim();
    return { id: m.id, role: m.role, created_at: m.created_at, archived_at: m.archived_at ?? null, snippet: snippet.slice(0, 160) };
  });
}

// ---------- settings & agent selection ----------
export interface Settings {
  agent_strategy: "round_robin" | "random" | "priority";
  agent_order: string[];
  disabled_agents: string[];
  rr_cursor: string | null;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  onboarded: boolean;
  enrich_enabled: boolean;
  proactive_enabled: boolean;           // nightly quiet insight + weekly read/nutrition-checkin precompute (pull-never-push)
  art_enabled: boolean;
  art_enabled_at: string | null;
  meal_prefs: string;
  garmin_username: string;
  garmin_password_configured: boolean;
  garmin_credentials_source: "settings" | "env" | "mixed" | "none";
  garmin_last_sync_at: string | null;   // UTC ISO of the last completed sync (ok or failed)
  garmin_last_sync_status: string;      // short result line: "ok: 12 activities · 14 daily" | "failed: …"
  gemini_api_key_configured: boolean;
  gemini_api_key_source: "settings" | "env" | "none";
  research_enabled: boolean;            // host-side evidence research (default OFF; off ⇒ deterministic, no network)
  updated_at?: string;
}

function defaultSettings(): Settings {
  // Seed from env on first run so existing COACH_* deployments keep working.
  return {
    agent_strategy: "round_robin",
    agent_order: [],
    disabled_agents: ["stub"], // stub returns a fake proposal; off by default
    rr_cursor: null,
    coach_enabled: !!process.env.COACH_AGENT,
    coach_day: Number(process.env.COACH_DAY ?? 0),
    coach_hour: Number(process.env.COACH_HOUR ?? 20),
    onboarded: false,
    enrich_enabled: true, // background enrichment on by default
    proactive_enabled: true, // calm precompute (quiet insight / weekly read / nutrition check-in) on by default
    art_enabled: true,    // generated artwork on by default (no-op without GEMINI_API_KEY)
    art_enabled_at: null, // unset → spend telemetry shows all-time
    meal_prefs: "",       // free-text meal/schedule preferences embedded in meal prompts
    garmin_username: process.env.GARMIN_USERNAME || "",
    garmin_password_configured: !!process.env.GARMIN_PASSWORD,
    garmin_credentials_source: process.env.GARMIN_USERNAME || process.env.GARMIN_PASSWORD ? "env" : "none",
    garmin_last_sync_at: null,
    garmin_last_sync_status: "",
    gemini_api_key_configured: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY),
    gemini_api_key_source: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY ? "env" : "none",
    research_enabled: false, // host-side research off by default — opt-in, deterministic when off
  };
}

function parseArr(s: any): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToSettings(row: any): Settings {
  const rowGarminUser = String(row.garmin_username ?? "").trim();
  const rowGarminPass = String(row.garmin_password ?? "").trim();
  const envGarminUser = process.env.GARMIN_USERNAME || "";
  const envGarminPass = process.env.GARMIN_PASSWORD || "";
  const hasSettingsGarmin = !!(rowGarminUser || rowGarminPass);
  const hasEnvGarmin = !!(envGarminUser || envGarminPass);
  const garminSource =
    rowGarminUser && rowGarminPass ? "settings" :
    hasSettingsGarmin && hasEnvGarmin ? "mixed" :
    hasSettingsGarmin ? "settings" :
    hasEnvGarmin ? "env" : "none";
  const rowGemini = String(row.gemini_api_key ?? "").trim();
  const envGemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || "";
  return {
    agent_strategy: row.agent_strategy || "round_robin",
    agent_order: parseArr(row.agent_order),
    disabled_agents: parseArr(row.disabled_agents),
    rr_cursor: row.rr_cursor ?? null,
    coach_enabled: !!row.coach_enabled,
    coach_day: row.coach_day ?? 0,
    coach_hour: row.coach_hour ?? 20,
    onboarded: !!row.onboarded,
    // NULL on old rows (column added by migration) defaults to enabled.
    enrich_enabled: row.enrich_enabled == null ? true : !!row.enrich_enabled,
    proactive_enabled: row.proactive_enabled == null ? true : !!row.proactive_enabled,
    art_enabled: row.art_enabled == null ? true : !!row.art_enabled,
    art_enabled_at: String(row.art_enabled_at ?? "").trim() || null,
    meal_prefs: row.meal_prefs == null ? "" : String(row.meal_prefs),
    garmin_username: rowGarminUser || envGarminUser,
    garmin_password_configured: !!(rowGarminPass || envGarminPass),
    garmin_credentials_source: garminSource,
    garmin_last_sync_at: String(row.garmin_last_sync_at ?? "").trim() || null,
    garmin_last_sync_status: row.garmin_last_sync_status == null ? "" : String(row.garmin_last_sync_status),
    gemini_api_key_configured: !!(rowGemini || envGemini),
    gemini_api_key_source: rowGemini ? "settings" : envGemini ? "env" : "none",
    // NULL on old rows (column added by migration v28) defaults to OFF.
    research_enabled: row.research_enabled == null ? false : !!row.research_enabled,
    updated_at: row.updated_at,
  };
}

export function getSettings(): Settings {
  const row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
  if (row) return rowToSettings(row);
  const d = defaultSettings();
  db.prepare(
    `INSERT INTO settings (id, agent_strategy, agent_order, disabled_agents, rr_cursor, coach_enabled, coach_day, coach_hour, enrich_enabled, proactive_enabled, art_enabled, meal_prefs)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(d.agent_strategy, JSON.stringify(d.agent_order), JSON.stringify(d.disabled_agents), d.rr_cursor, d.coach_enabled ? 1 : 0, d.coach_day, d.coach_hour, d.enrich_enabled ? 1 : 0, d.proactive_enabled ? 1 : 0, d.art_enabled ? 1 : 0, d.meal_prefs);
  return d;
}

export function setSettings(patch: any): Settings {
  const cur = getSettings();
  const raw = db.prepare(`SELECT garmin_username, garmin_password, gemini_api_key FROM settings WHERE id = 1`).get() as any;
  const incomingGarminPassword = patch.garmin_password !== undefined ? String(patch.garmin_password).trim() : undefined;
  const incomingGeminiKey = patch.gemini_api_key !== undefined ? String(patch.gemini_api_key).trim() : undefined;
  const garminPassword =
    incomingGarminPassword === undefined ? (raw?.garmin_password ?? "") :
    incomingGarminPassword ? incomingGarminPassword :
    (patch.clear_garmin_password ? "" : (raw?.garmin_password ?? ""));
  const geminiApiKey =
    incomingGeminiKey === undefined ? (raw?.gemini_api_key ?? "") :
    incomingGeminiKey ? incomingGeminiKey :
    (patch.clear_gemini_api_key ? "" : (raw?.gemini_api_key ?? ""));
  const merged: Settings = {
    agent_strategy: patch.agent_strategy ?? cur.agent_strategy,
    agent_order: patch.agent_order ?? cur.agent_order,
    disabled_agents: patch.disabled_agents ?? cur.disabled_agents,
    rr_cursor: patch.rr_cursor !== undefined ? patch.rr_cursor : cur.rr_cursor,
    coach_enabled: patch.coach_enabled ?? cur.coach_enabled,
    coach_day: patch.coach_day ?? cur.coach_day,
    coach_hour: patch.coach_hour ?? cur.coach_hour,
    onboarded: patch.onboarded !== undefined ? !!patch.onboarded : cur.onboarded,
    enrich_enabled: patch.enrich_enabled !== undefined ? !!patch.enrich_enabled : cur.enrich_enabled,
    proactive_enabled: patch.proactive_enabled !== undefined ? !!patch.proactive_enabled : cur.proactive_enabled,
    art_enabled: patch.art_enabled !== undefined ? !!patch.art_enabled : cur.art_enabled,
    // Stamp the moment art flips off→on; spend telemetry reports from here.
    // Stored as UTC "YYYY-MM-DD HH:MM:SS" so it compares with datetime('now').
    art_enabled_at:
      patch.art_enabled !== undefined && !!patch.art_enabled && !cur.art_enabled
        ? new Date().toISOString().slice(0, 19).replace("T", " ")
        : cur.art_enabled_at,
    meal_prefs: String(patch.meal_prefs ?? cur.meal_prefs).trim().slice(0, 2000),
    garmin_username: patch.garmin_username !== undefined ? String(patch.garmin_username).trim().slice(0, 320) : String(raw?.garmin_username ?? ""),
    garmin_password_configured: !!garminPassword || cur.garmin_password_configured,
    garmin_credentials_source: cur.garmin_credentials_source,
    // Sync status is read-only here — recorded by setGarminSyncStatus() and not
    // part of the UPDATE below, so a settings save never clobbers it.
    garmin_last_sync_at: cur.garmin_last_sync_at,
    garmin_last_sync_status: cur.garmin_last_sync_status,
    gemini_api_key_configured: !!geminiApiKey || cur.gemini_api_key_configured,
    gemini_api_key_source: cur.gemini_api_key_source,
    research_enabled: patch.research_enabled !== undefined ? !!patch.research_enabled : cur.research_enabled,
  };
  if (!["round_robin", "random", "priority"].includes(merged.agent_strategy)) merged.agent_strategy = "round_robin";
  db.prepare(
    `UPDATE settings SET agent_strategy=?, agent_order=?, disabled_agents=?, rr_cursor=?,
       coach_enabled=?, coach_day=?, coach_hour=?, onboarded=?, enrich_enabled=?, proactive_enabled=?, art_enabled=?, art_enabled_at=?, meal_prefs=?,
       garmin_username=?, garmin_password=?, gemini_api_key=?, research_enabled=?, updated_at=datetime('now') WHERE id = 1`
  ).run(
    merged.agent_strategy, JSON.stringify(merged.agent_order), JSON.stringify(merged.disabled_agents),
    merged.rr_cursor, merged.coach_enabled ? 1 : 0, merged.coach_day, merged.coach_hour,
    merged.onboarded ? 1 : 0, merged.enrich_enabled ? 1 : 0, merged.proactive_enabled ? 1 : 0, merged.art_enabled ? 1 : 0, merged.art_enabled_at ?? "", merged.meal_prefs,
    merged.garmin_username, garminPassword, geminiApiKey, merged.research_enabled ? 1 : 0
  );
  return getSettings();
}

export function getGarminCredentials() {
  const row = db.prepare(`SELECT garmin_username, garmin_password FROM settings WHERE id = 1`).get() as any;
  const username = String(row?.garmin_username ?? "").trim() || process.env.GARMIN_USERNAME || "";
  const password = String(row?.garmin_password ?? "").trim() || process.env.GARMIN_PASSWORD || "";
  return { username, password, configured: !!(username && password) };
}

// Recorded by syncGarmin() (src/garmin.ts) wherever a sync completes — the
// scheduler's auto-sync, manual POST /api/garmin/sync, MCP sync_garmin and the
// CLI entry point all funnel through it. Surfaced read-only in Settings.
export function setGarminSyncStatus(status: string) {
  getSettings(); // lazily creates the singleton row
  db.prepare(`UPDATE settings SET garmin_last_sync_at = ?, garmin_last_sync_status = ? WHERE id = 1`).run(
    new Date().toISOString(),
    String(status ?? "").trim().slice(0, 200)
  );
}

export function getGeminiApiKey() {
  const row = db.prepare(`SELECT gemini_api_key FROM settings WHERE id = 1`).get() as any;
  return String(row?.gemini_api_key ?? "").trim() || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || "";
}

// ---------- generated-artwork bookkeeping (see src/art.ts) ----------
// art_assets: what each cached PNG depicts. art_aliases: normalized query →
// asset, so semantically-equivalent phrasings resolve to one image without
// re-asking the model. art_usage: the spend ledger behind getArtStats().

export function getArtAlias(kind: string, query: string): string | null {
  const row = db.prepare(`SELECT asset_key FROM art_aliases WHERE kind = ? AND query = ?`).get(kind, query) as any;
  return row?.asset_key ?? null;
}

export function setArtAlias(kind: string, query: string, assetKey: string) {
  db.prepare(
    `INSERT INTO art_aliases (kind, query, asset_key) VALUES (?, ?, ?)
     ON CONFLICT(kind, query) DO UPDATE SET asset_key = excluded.asset_key`
  ).run(kind, query, assetKey);
}

export function addArtAsset(key: string, kind: string, text: string) {
  db.prepare(
    `INSERT INTO art_assets (key, kind, text) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET text = excluded.text`
  ).run(key, kind, text);
}

export function listArtAssets(kind: string, limit = 150): { key: string; text: string }[] {
  return db.prepare(
    `SELECT key, text FROM art_assets WHERE kind = ? ORDER BY created_at DESC, key LIMIT ?`
  ).all(kind, limit) as any[];
}

export function recordArtUsage(u: {
  kind: string;
  query: string;
  asset_key?: string | null;
  action: "generate" | "canonicalize" | "reuse" | "fail";
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  est_cost_usd?: number;
  est_saved_usd?: number;
}) {
  db.prepare(
    `INSERT INTO art_usage (kind, query, asset_key, action, model, input_tokens, output_tokens, est_cost_usd, est_saved_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u.kind, String(u.query).slice(0, 200), u.asset_key ?? null, u.action, u.model ?? null,
    u.input_tokens ?? null, u.output_tokens ?? null,
    Number(u.est_cost_usd ?? 0) || 0, Number(u.est_saved_usd ?? 0) || 0
  );
}

export interface ArtUsageTotals {
  images_generated: number;
  canonicalize_calls: number;
  reused: number;
  failed: number;
  est_cost_usd: number;
  est_saved_usd: number;
}

function artUsageTotals(since?: string | null): ArtUsageTotals {
  const sql = `SELECT
      COALESCE(SUM(CASE WHEN action = 'generate' THEN 1 ELSE 0 END), 0) AS images_generated,
      COALESCE(SUM(CASE WHEN action = 'canonicalize' THEN 1 ELSE 0 END), 0) AS canonicalize_calls,
      COALESCE(SUM(CASE WHEN action = 'reuse' THEN 1 ELSE 0 END), 0) AS reused,
      COALESCE(SUM(CASE WHEN action = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
      COALESCE(SUM(est_saved_usd), 0) AS est_saved_usd
    FROM art_usage` + (since ? ` WHERE created_at >= ?` : ``);
  const row = (since ? db.prepare(sql).get(since) : db.prepare(sql).get()) as any;
  return {
    images_generated: Number(row?.images_generated ?? 0),
    canonicalize_calls: Number(row?.canonicalize_calls ?? 0),
    reused: Number(row?.reused ?? 0),
    failed: Number(row?.failed ?? 0),
    est_cost_usd: Number((Number(row?.est_cost_usd ?? 0)).toFixed(6)),
    est_saved_usd: Number((Number(row?.est_saved_usd ?? 0)).toFixed(6)),
  };
}

// Spend telemetry for the Settings UI / MCP: money since art was last enabled
// (falls back to all-time when the toggle predates the telemetry column),
// plus all-time totals and cache size. Costs are estimates from fixed rates.
export function getArtStats() {
  const s = getSettings();
  const assets = db.prepare(`SELECT COUNT(*) AS n FROM art_assets`).get() as any;
  const aliases = db.prepare(`SELECT COUNT(*) AS n FROM art_aliases`).get() as any;
  return {
    art_enabled: s.art_enabled,
    gemini_configured: !!getGeminiApiKey(),
    enabled_at: s.art_enabled_at,
    since_enabled: artUsageTotals(s.art_enabled_at),
    all_time: artUsageTotals(),
    cached_assets: Number(assets?.n ?? 0),
    aliases: Number(aliases?.n ?? 0),
  };
}

// ---------- agent-run telemetry (see src/agents.ts) ----------
// One row per agent ATTEMPT, written from the runChosen / runAgentWithFallback /
// day-read paths. Makes the agentic loop observable. Mirrors the art_usage
// telemetry shape: a cheap insert + a stats roll-up. recordAgentRun NEVER throws
// into the coaching loop (callers wrap it in try/catch; we also guard here).
export function recordAgentRun(r: {
  op: string;
  agent: string;
  ok: boolean;
  parsed: boolean;
  latency_ms: number;
  tried_json: boolean;
}) {
  try {
    db.prepare(
      `INSERT INTO agent_runs (op, agent, ok, parsed, latency_ms, tried_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      String(r.op ?? "").slice(0, 60),
      String(r.agent ?? "").slice(0, 60),
      r.ok ? 1 : 0,
      r.parsed ? 1 : 0,
      Number.isFinite(r.latency_ms) ? Math.round(r.latency_ms) : null,
      r.tried_json ? 1 : 0
    );
  } catch {
    /* telemetry is best-effort — never break the loop on a write error */
  }
}

// Roll-up for the Settings "agent health" card / MCP get_agent_stats. ok_rate is
// a plain reliability fraction over the window (NOT a user-facing grade — this is
// an operator/health view, never surfaced as a score against the athlete). p50_ms
// is the per-agent median latency. `recent` carries the last N raw attempts.
export function getAgentStats(opts: { recent?: number; days?: number } = {}) {
  const recentN = Math.min(Math.max(Number(opts.recent) || 25, 1), 200);
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? (opts.days as number) : null;
  const where = days ? `WHERE created_at >= datetime('now', ?)` : ``;
  const bind: any[] = days ? [`-${days} days`] : [];

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(ok), 0) AS ok FROM agent_runs ${where}`
  ).get(...bind) as any;
  const runs = Number(totalRow?.runs ?? 0);
  const okCount = Number(totalRow?.ok ?? 0);

  const perAgent = db.prepare(
    `SELECT agent,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS fail,
            COUNT(*) AS n
       FROM agent_runs ${where}
      GROUP BY agent
      ORDER BY n DESC`
  ).all(...bind) as any[];

  const by_agent = perAgent.map((a) => {
    // Median latency for this agent over the window (SQLite has no percentile fn).
    const lats = (db.prepare(
      `SELECT latency_ms FROM agent_runs ${where ? where + " AND" : "WHERE"} agent = ? AND latency_ms IS NOT NULL ORDER BY latency_ms`
    ).all(...bind, a.agent) as any[]).map((r) => Number(r.latency_ms));
    const p50 = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
    return { agent: a.agent, ok: Number(a.ok), fail: Number(a.fail), p50_ms: p50 };
  });

  const recent = db.prepare(
    `SELECT op, agent, ok, parsed, latency_ms, tried_json, created_at
       FROM agent_runs ${where} ORDER BY id DESC LIMIT ?`
  ).all(...bind, recentN).map((r: any) => ({
    op: r.op,
    agent: r.agent,
    ok: !!r.ok,
    parsed: !!r.parsed,
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    tried_json: !!r.tried_json,
    created_at: r.created_at,
  }));

  return {
    runs,
    ok_rate: runs ? Number((okCount / runs).toFixed(3)) : null,
    by_agent,
    recent,
  };
}

// ---------- app_state: tiny KV scratchpad for scheduler bookkeeping ----------
// Used by the proactive scheduler to persist last-run stamps so a missed slot
// still fires once after a restart. Best-effort; failure-safe.
export function getAppState(key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  } catch { return null; }
}

export function setAppState(key: string, value: string) {
  try {
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(key, String(value ?? ""));
  } catch { /* best-effort */ }
}

// agents.json merged with settings: effective order + enabled/usable flags.
export function getAgentConfig() {
  const s = getSettings();
  const all = listAgents() as any[];
  const byName = new Map(all.map((a) => [a.name, a]));
  const ordered: string[] = [];
  for (const n of s.agent_order) if (byName.has(n) && !ordered.includes(n)) ordered.push(n);
  for (const a of all) if (!ordered.includes(a.name)) ordered.push(a.name);
  const disabled = new Set(s.disabled_agents);
  return ordered.map((name) => {
    const a = byName.get(name);
    return { name, description: a.description, env_ok: a.env_ok, enabled: !disabled.has(name) };
  });
}

// The order in which to try agents for an "auto" run, per the configured strategy.
// Round-robin advances a persisted cursor so usage rotates across drafts.
export function pickAgentOrder(): string[] {
  const s = getSettings();
  const enabled = getAgentConfig().filter((a) => a.enabled).map((a) => a.name);
  if (enabled.length <= 1) return enabled;
  if (s.agent_strategy === "priority") return enabled;
  if (s.agent_strategy === "random") {
    const a = [...enabled];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // round_robin
  const idx = s.rr_cursor ? enabled.indexOf(s.rr_cursor) : -1;
  const start = (idx + 1) % enabled.length;
  const rotated = [...enabled.slice(start), ...enabled.slice(0, start)];
  setSettings({ rr_cursor: rotated[0] });
  return rotated;
}

// ---------- health documents ----------
function hydrateHealthDoc(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// Strip the on-disk path from API payloads — it's an internal detail and the
// file is served via a dedicated streaming endpoint, not exposed as a path.
function publicHealthDoc(row: any) {
  if (!row) return row;
  const { file_path, ...rest } = hydrateHealthDoc(row);
  return { ...rest, has_file: !!file_path };
}

export interface HealthDocInput {
  kind?: string;
  doc_date?: string | null;
  original_name?: string | null;
  mime?: string | null;
  file_path?: string | null;
  enrichment_status?: string | null;
  parsed_json?: any;
  summary?: string | null;
  source_doc_id?: number | null;
}

export function addHealthDocument(input: HealthDocInput) {
  const kind = input.kind && ["bloodwork", "dexa", "other"].includes(input.kind) ? input.kind : "other";
  const info = db
    .prepare(
      `INSERT INTO health_documents (kind, doc_date, original_name, mime, file_path, parsed_json, summary, enrichment_status, source_doc_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      input.doc_date ?? null,
      input.original_name ?? null,
      input.mime ?? null,
      input.file_path ?? null,
      input.parsed_json != null ? JSON.stringify(input.parsed_json) : null,
      input.summary ?? null,
      input.enrichment_status ?? null,
      input.source_doc_id ?? null
    );
  return getHealthDocument(Number(info.lastInsertRowid));
}

// A single dated panel split out of a multi-record import (one lab visit, scan
// date, etc.). Coerced/clamped like the enrichment apply path.
export interface HealthPanelInput {
  doc_date?: string | null;
  kind?: string;
  summary?: string | null;
  markers?: any[];
  type?: string | null;
}

// Replace the derived panels of a source upload with a fresh set (used by
// multi-record ingestion + re-analysis). Each panel becomes its own dated row
// pointing back at `sourceId`; the binary stays only on the source row. Returns
// the rows created. `original_name` is carried through for provenance.
export function replaceHealthPanels(sourceId: number, panels: HealthPanelInput[], originalName?: string | null) {
  deleteDerivedHealthDocs(sourceId);
  const created: any[] = [];
  for (const p of Array.isArray(panels) ? panels : []) {
    if (!p || typeof p !== "object") continue;
    const markers = Array.isArray(p.markers)
      ? p.markers
        .filter((m: any) => m && typeof m === "object")
        .slice(0, 100)
        .map((m: any) => ({
          name: String(m.name ?? "").slice(0, 120),
          value: typeof m.value === "number" ? m.value : (m.value == null ? null : String(m.value).slice(0, 80)),
          unit: m.unit == null ? null : String(m.unit).slice(0, 40),
          flag: ["low", "normal", "high"].includes(m.flag) ? m.flag : null,
        }))
        .filter((m: any) => m.name)
      : [];
    const date = typeof p.doc_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.doc_date) ? p.doc_date : null;
    const summary = p.summary == null ? null : String(p.summary).slice(0, 1000);
    if (!markers.length && !summary) continue; // an empty panel is noise
    const parsed: Record<string, any> = { markers };
    if (p.type) parsed.type = String(p.type).slice(0, 80);
    const row = addHealthDocument({
      kind: p.kind && ["bloodwork", "dexa", "other"].includes(p.kind) ? p.kind : "other",
      doc_date: date,
      original_name: originalName ?? null,
      file_path: null,             // the binary lives on the source row only
      parsed_json: parsed,
      summary,
      enrichment_status: "done",
      source_doc_id: sourceId,
    });
    created.push(row);
  }
  return created;
}

function deleteDerivedHealthDocs(sourceId: number) {
  return db.prepare(`DELETE FROM health_documents WHERE source_doc_id = ?`).run(sourceId).changes;
}

// Raw row incl. file_path — for internal use (enrichment, file streaming, delete).
export function getHealthDocumentRaw(id: number) {
  return db.prepare(`SELECT * FROM health_documents WHERE id = ?`).get(id) ?? null;
}

// Hydrated row WITHOUT file_path — for API responses.
export function getHealthDocument(id: number) {
  const row = getHealthDocumentRaw(id) as any;
  return row ? publicHealthDoc(row) : null;
}

export function listHealthDocuments(limit = 50) {
  // Newest results first — order by the effective result date (doc_date, falling
  // back to upload time) so a split multi-year import reads as a clean timeline.
  return (db
    .prepare(`SELECT * FROM health_documents ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC LIMIT ?`)
    .all(limit) as any[]).map(publicHealthDoc);
}

export function updateHealthDocFields(id: number, fields: { parsed_json?: any; summary?: string | null; kind?: string | null; doc_date?: string | null }) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.parsed_json !== undefined) { sets.push("parsed_json = ?"); vals.push(fields.parsed_json != null ? JSON.stringify(fields.parsed_json) : null); }
  if (fields.summary !== undefined) { sets.push("summary = ?"); vals.push(fields.summary ?? null); }
  if (fields.kind !== undefined) {
    const kind = fields.kind && ["bloodwork", "dexa", "other"].includes(fields.kind) ? fields.kind : "other";
    sets.push("kind = ?");
    vals.push(kind);
  }
  if (fields.doc_date !== undefined) { sets.push("doc_date = ?"); vals.push(fields.doc_date ?? null); }
  if (!sets.length) return getHealthDocument(id);
  vals.push(id);
  db.prepare(`UPDATE health_documents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getHealthDocument(id);
}

export function setHealthDocEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE health_documents SET enrichment_status = ? WHERE id = ?`).run(status, id);
  return getHealthDocument(id);
}

export function deleteHealthDocument(id: number) {
  // Deleting a source upload takes its derived dated panels with it (they have
  // no binary of their own and are meaningless without the source).
  const derived = deleteDerivedHealthDocs(id);
  const deleted = db.prepare(`DELETE FROM health_documents WHERE id = ?`).run(id).changes;
  return { deleted, derived };
}

// ---------- health insights: marker history across all documents ----------
// Aggregates every marker from every health document into one per-marker series.
// Docs are walked in effective-date order (doc_date, falling back to the upload
// date), so "latest" is the most recent reading and points form a time series.
export function getMarkerHistory() {
  const docs = db
    .prepare(
      `SELECT id, kind, doc_date, created_at, parsed_json FROM health_documents
       ORDER BY COALESCE(doc_date, substr(created_at,1,10)) ASC, id ASC`
    )
    .all() as any[];

  interface Reading {
    date: string;
    value: number | string;
    flag: string | null;
    unit: string | null;
    name: string;
    doc_id: number;
    kind: string;
  }
  const byKey = new Map<string, Reading[]>();

  for (const d of docs) {
    let parsed: any = null;
    try { parsed = d.parsed_json ? JSON.parse(d.parsed_json) : null; } catch { parsed = null; }
    const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
    const date = (d.doc_date && String(d.doc_date).trim()) || String(d.created_at ?? "").slice(0, 10);
    for (const m of markers) {
      if (!m || typeof m !== "object") continue;
      const rawName = String(m.name ?? "").replace(/\s+/g, " ").trim();
      if (!rawName) continue;
      // A reading is usable when the value is a finite number or a non-empty
      // string (e.g. "negative"); anything else is skipped, and a marker with
      // no usable reading at all never appears in the output.
      const value: number | string | null =
        typeof m.value === "number" && Number.isFinite(m.value)
          ? m.value
          : m.value !== null && m.value !== undefined && String(m.value).trim()
            ? String(m.value).trim()
            : null;
      if (value === null) continue;
      const key = rawName.toLowerCase();
      const flag = ["low", "normal", "high"].includes(m.flag) ? m.flag : null;
      const unit = m.unit !== null && m.unit !== undefined && String(m.unit).trim() ? String(m.unit).trim() : null;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({ date, value, flag, unit, name: rawName, doc_id: d.id, kind: d.kind ?? "other" });
    }
  }

  const markers = [...byKey.entries()].map(([key, readings]) => {
    const last = readings[readings.length - 1];
    const before = readings.length > 1 ? readings[readings.length - 2] : null;
    // Most recent non-null unit seen for this marker.
    let unit: string | null = null;
    for (let i = readings.length - 1; i >= 0; i--) {
      if (readings[i].unit) { unit = readings[i].unit; break; }
    }
    // Chart points carry NUMERIC values only (a "5.4" string still counts);
    // readings are already ascending by effective date from the SQL ordering.
    const points = readings
      .map((r) => ({ date: r.date, value: typeof r.value === "number" ? r.value : Number(r.value), flag: r.flag, doc_id: r.doc_id }))
      .filter((p) => Number.isFinite(p.value));
    // Deterministic trend over the numeric series (ascending by date). n<2 is
    // unknowable; otherwise dir is 'stable' when the net change is small vs the
    // series' own spread (so a marker that barely moved doesn't read as a trend),
    // else 'rising'/'falling'. No score — just direction + raw change + span.
    const n = points.length;
    let trend: { dir: "rising" | "falling" | "stable" | null; change: number | null; span_days: number | null; n: number };
    if (n < 2) {
      trend = { dir: null, change: null, span_days: null, n };
    } else {
      const first = points[0];
      const lastP = points[n - 1];
      // round to 2 decimals so float noise (5.6-5.8 = -0.1999…) never leaks into the JSON/agent prompt
      const change = Math.round((lastP.value - first.value) * 100) / 100;
      const vals = points.map((p) => p.value);
      const range = Math.max(...vals) - Math.min(...vals);
      const span_days = Math.round((Date.parse(lastP.date) - Date.parse(first.date)) / 86_400_000) || 0;
      const dir = range > 0 && Math.abs(change) < range * 0.05 ? "stable" : change > 0 ? "rising" : change < 0 ? "falling" : "stable";
      trend = { dir, change, span_days, n };
    }
    const grp = markerGroup(last.name);
    return {
      key,
      name: last.name, // most recent casing seen
      unit,
      group: grp.key,
      group_label: grp.label,
      latest: { value: last.value, flag: last.flag, date: last.date, doc_id: last.doc_id, kind: last.kind },
      prev: before ? { value: before.value, date: before.date } : null,
      trend,
      points,
    };
  });

  // Flagged-latest markers (low/high) first, then alphabetical by display name.
  markers.sort((a, b) => {
    const af = a.latest.flag === "low" || a.latest.flag === "high" ? 0 : 1;
    const bf = b.latest.flag === "low" || b.latest.flag === "high" ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });

  const sliced = markers.slice(0, 200);
  return { markers: sliced, groups: presentGroups(sliced) };
}

// ---------- health reviews (agentic whole-picture read) ----------
function hydrateHealthReview(row: any) {
  if (!row) return null;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// Agent-provided reviews are coerced/clamped before write, same discipline as
// coerceMeal/coerceRecipe. Returns the hydrated row, or null when the parsed
// shape is unusable (headline, focus AND watchlist all empty — e.g. a stray
// coach-proposal response).
export function addHealthReview(parsed: any, agent: string | null, raw?: string) {
  if (!parsed || typeof parsed !== "object") return null;
  const STATUSES = new Set(["low", "high", "watch"]);
  const headline = capStr(parsed.headline, 240);
  const wins = (Array.isArray(parsed.wins) ? parsed.wins : [])
    .map((w: any) => capStr(w, 200))
    .filter(Boolean)
    .slice(0, 5);
  const watchlist = (Array.isArray(parsed.watchlist) ? parsed.watchlist : [])
    .filter((w: any) => w && typeof w === "object")
    .map((w: any) => ({
      marker: capStr(w.marker, 60),
      status: STATUSES.has(String(w.status)) ? String(w.status) : "watch",
      why: capStr(w.why, 240),
      action: capStr(w.action, 240),
    }))
    .filter((w: any) => w.marker)
    .slice(0, 8);
  const focus = (Array.isArray(parsed.focus) ? parsed.focus : [])
    .filter((f: any) => f && typeof f === "object")
    .map((f: any) => ({ title: capStr(f.title, 80), why: capStr(f.why, 240), action: capStr(f.action, 240) }))
    .filter((f: any) => f.title)
    .slice(0, 4);
  const followups = (Array.isArray(parsed.followups) ? parsed.followups : [])
    .filter((f: any) => f && typeof f === "object")
    .map((f: any) => ({ what: capStr(f.what, 200), when: capStr(f.when, 80) }))
    .filter((f: any) => f.what)
    .slice(0, 6);
  const training_impact = capStr(parsed.training_impact, 400);
  const nutrition_impact = capStr(parsed.nutrition_impact, 400);
  // Cross-domain directives the agent emitted (the connected brain). Coerced/
  // clamped like the rest; carried on the review so the propagation engine
  // (Stage-2 T4) can persist them into health_directives. Additive — older
  // consumers ignore it.
  const DOMAINS = new Set(["nutrition", "training", "watch"]);
  const directives = (Array.isArray(parsed.directives) ? parsed.directives : [])
    .filter((d: any) => d && typeof d === "object")
    .map((d: any) => ({
      domain: DOMAINS.has(String(d.domain)) ? String(d.domain) : "watch",
      marker: d.marker != null && String(d.marker).trim() ? capStr(d.marker, 60) : null,
      directive: capStr(d.directive, 600),
      rationale: capStr(d.rationale, 600),
      citation: d.citation == null || String(d.citation).trim() === "" ? null : capStr(d.citation, 600) || null,
    }))
    .filter((d: any) => d.directive)
    .slice(0, 12);
  if (!headline && !focus.length && !watchlist.length) return null;
  const clean = { headline, wins, watchlist, focus, followups, training_impact, nutrition_impact, directives };
  const info = db
    .prepare(`INSERT INTO health_reviews (agent, parsed_json, raw_output) VALUES (?, ?, ?)`)
    .run(agent ?? null, JSON.stringify(clean), raw ?? null);
  // Propagate the review's directives into health_directives (source
  // 'health_review', coexisting with the deterministic 'markers' source).
  // Never auto-applies anything beyond recording the directive for review. Only
  // rewrite when the agent actually addressed directives: an explicit array (even
  // empty = "nothing flagged now") replaces the set; an ABSENT field preserves it.
  if (Array.isArray(parsed.directives)) applyReviewDirectives(directives);
  return hydrateHealthReview(db.prepare(`SELECT * FROM health_reviews WHERE id = ?`).get(info.lastInsertRowid));
}

export function getLatestHealthReview() {
  return hydrateHealthReview(db.prepare(`SELECT * FROM health_reviews ORDER BY id DESC LIMIT 1`).get() ?? null);
}

export function listHealthReviews(limit = 10) {
  return (db.prepare(`SELECT * FROM health_reviews ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrateHealthReview);
}

// ---------- context events (life timeline the coach plans around) ----------
function hydrateContextEvent(row: any) {
  if (!row) return row;
  let meta: any = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  const { meta_json, ...rest } = row;
  return { ...rest, meta };
}

export interface ContextEventInput {
  kind?: string;
  title?: string | null;
  detail?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  meta?: any;
  archived?: boolean;
}

export function addContextEvent(input: ContextEventInput) {
  const kind = input.kind && ["trip", "injury", "life_event", "family_event"].includes(input.kind) ? input.kind : "life_event";
  const info = db
    .prepare(
      `INSERT INTO context_events (kind, title, detail, start_date, end_date, meta_json, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      input.title ?? null,
      input.detail ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.meta != null ? JSON.stringify(input.meta) : null,
      input.archived ? 1 : 0
    );
  return getContextEvent(Number(info.lastInsertRowid));
}

export function listContextEvents(opts: { activeOnly?: boolean } = {}) {
  let rows: any[];
  if (opts.activeOnly) {
    // Active/upcoming = not archived AND (no end_date OR end_date >= today).
    const today = todayISO();
    rows = db
      .prepare(
        `SELECT * FROM context_events
         WHERE archived = 0 AND (end_date IS NULL OR end_date >= ?)
         ORDER BY (start_date IS NULL), start_date, id`
      )
      .all(today) as any[];
  } else {
    rows = db.prepare(`SELECT * FROM context_events ORDER BY (start_date IS NULL), start_date DESC, id DESC`).all() as any[];
  }
  return rows.map(hydrateContextEvent);
}

export function getContextEvent(id: number) {
  const row = db.prepare(`SELECT * FROM context_events WHERE id = ?`).get(id) as any;
  return row ? hydrateContextEvent(row) : null;
}

export function updateContextEvent(id: number, patch: ContextEventInput) {
  const cur = db.prepare(`SELECT * FROM context_events WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const kind = patch.kind && ["trip", "injury", "life_event", "family_event"].includes(patch.kind) ? patch.kind : cur.kind;
  const merged = {
    kind,
    title: patch.title !== undefined ? patch.title : cur.title,
    detail: patch.detail !== undefined ? patch.detail : cur.detail,
    start_date: patch.start_date !== undefined ? patch.start_date : cur.start_date,
    end_date: patch.end_date !== undefined ? patch.end_date : cur.end_date,
    meta_json: patch.meta !== undefined ? (patch.meta != null ? JSON.stringify(patch.meta) : null) : cur.meta_json,
    archived: patch.archived !== undefined ? (patch.archived ? 1 : 0) : cur.archived,
  };
  db.prepare(
    `UPDATE context_events SET kind=?, title=?, detail=?, start_date=?, end_date=?, meta_json=?, archived=? WHERE id=?`
  ).run(merged.kind, merged.title, merged.detail, merged.start_date, merged.end_date, merged.meta_json, merged.archived, id);
  return getContextEvent(id);
}

export function deleteContextEvent(id: number) {
  return { deleted: db.prepare(`DELETE FROM context_events WHERE id = ?`).run(id).changes };
}

// ---------- coach context (shared by prompts) ----------
// Compact view of a health doc for coaching: kind, date, summary, key markers
// (capped) — never the raw file or the full marker list.
function healthForCoach() {
  const docs = db.prepare(`SELECT * FROM health_documents ORDER BY id DESC LIMIT 5`).all() as any[];
  return docs.map((d) => {
    const h = hydrateHealthDoc(d);
    const markers = Array.isArray(h.parsed?.markers) ? h.parsed.markers.slice(0, 30) : undefined;
    return { kind: h.kind, doc_date: h.doc_date, summary: h.summary, type: h.parsed?.type, markers };
  });
}

// The latest whole-picture health review, condensed for the coach: just the
// headline plus the actionable focus/watchlist/followup items — never the raw
// agent output.
function healthReviewForCoach() {
  const r = getLatestHealthReview();
  if (!r || !r.parsed) return null;
  const p = r.parsed;
  return {
    created_at: r.created_at,
    headline: p.headline,
    focus: (Array.isArray(p.focus) ? p.focus : []).map((f: any) => ({ title: f?.title, action: f?.action })),
    watchlist: (Array.isArray(p.watchlist) ? p.watchlist : []).map((w: any) => ({ marker: w?.marker, status: w?.status, action: w?.action })),
    followups: Array.isArray(p.followups) ? p.followups : [],
  };
}

export function getCoachContext() {
  // Compute the Garmin summary and the unified recovery view ONCE, then thread
  // them through the recovery + day_read keys so a single context build doesn't
  // fan out into getGarminCoachSummary three times.
  const garmin = getGarminCoachSummary(14);
  const recovery = getRecoverySummary(14, garmin);
  return {
    profile: getProfile(),
    goal: computeGoalCheck(),
    plan: getPlan(),
    recent_sessions: getRecentSessions(20),
    recent_activities: listActivities(15),
    garmin,
    memory: listMemory(40),
    health: healthForCoach(),
    health_review: healthReviewForCoach(),
    context_events: listContextEvents({ activeOnly: true }),
    // Vision build (the connected brain + understanding): new keys are ADDITIVE
    // — every existing consumer keeps working untouched.
    directives: directivesForCoach(),         // cross-domain consequences of flagged findings (condensed, bounded)
    directive_feedback: directiveFeedbackForCoach(), // Done/Dismiss memory so the coach avoids stale repeats
    recovery,                                 // unified Garmin + Apple/other recovery view
    checkins: listCheckins(7),                // optional subjective morning check-ins
    family: listFamily(),                     // family roster the coach plans around
    // The persisted read carries the agentic sentence AND the athlete's steer
    // ("rough night" / "easy day") so chat/coach/meals echo the Brief the user is
    // actually looking at; the deterministic floor backs it when nothing's cached.
    // Keyed by the server's LOCAL date to match the day_reads cache (saveDayRead).
    day_read: getCachedDayRead(localDateISO()) ?? dayRead(undefined, recovery),
    // Recent quiet cross-domain insights (bounded) so the chat/coach brain can
    // reference and build on connections it has already surfaced — closing the
    // "one brain" loop instead of re-deriving them each turn.
    insights: listVisibleInsights(5).map((i: any) => ({ text: i.text, kind: i.kind, rationale: i.rationale, next_step: i.next_step })),
  };
}

// ============================================================================
// VISION BUILD — shared foundation for the parallel feature teams (Stage 1).
// Everything below is additive and null-safe. Feature teams flesh out the
// stubs (dayRead / estimateExpenditure / frequentFoods / prioritizeMarkers)
// against the signatures here; the deterministic bodies keep the build and the
// app working today.
// ============================================================================

// ---------- check-ins (Phase 5C / day-read signal) ----------
export interface CheckinInput {
  mood?: number | null;
  energy?: number | null;
  sleep_feel?: number | null;
  soreness?: number | null;
  note?: string | null;
}

function clampScale15(v: any): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// One check-in per save (a date can have several; the latest wins for reads).
export function addCheckin(date: string, fields: CheckinInput = {}) {
  const d = date || todayISO();
  const info = db
    .prepare(`INSERT INTO checkins (date, mood, energy, sleep_feel, soreness, note) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      d,
      clampScale15(fields.mood),
      clampScale15(fields.energy),
      clampScale15(fields.sleep_feel),
      clampScale15(fields.soreness),
      fields.note == null ? null : String(fields.note).trim().slice(0, 500) || null
    );
  invalidateDayRead(d); // a fresh subjective signal can change today's read
  return db.prepare(`SELECT * FROM checkins WHERE id = ?`).get(info.lastInsertRowid);
}

// Most recent check-in for a date (or null) — the day-read reads "today".
export function getCheckinByDate(date: string) {
  return db.prepare(`SELECT * FROM checkins WHERE date = ? ORDER BY id DESC LIMIT 1`).get(date) ?? null;
}

export function listCheckins(limit = 14) {
  return db.prepare(`SELECT * FROM checkins ORDER BY date DESC, id DESC LIMIT ?`).all(limit);
}

// ---------- family members (Phase 2B) ----------
export interface FamilyInput {
  name?: string | null;
  color?: string | null;
  relationship?: string | null;
  birthdate?: string | null;
  notes?: string | null;
}

export function listFamily() {
  return db.prepare(`SELECT * FROM family_members ORDER BY id`).all();
}

export function getFamilyMember(id: number) {
  return db.prepare(`SELECT * FROM family_members WHERE id = ?`).get(id) ?? null;
}

export function addFamily(fields: FamilyInput = {}) {
  const info = db
    .prepare(`INSERT INTO family_members (name, color, relationship, birthdate, notes) VALUES (?, ?, ?, ?, ?)`)
    .run(
      fields.name == null ? null : String(fields.name).trim().slice(0, 120) || null,
      fields.color == null ? null : String(fields.color).trim().slice(0, 40) || null,
      fields.relationship == null ? null : String(fields.relationship).trim().slice(0, 60) || null,
      fields.birthdate == null ? null : String(fields.birthdate).trim().slice(0, 10) || null,
      fields.notes == null ? null : String(fields.notes).trim().slice(0, 1000) || null
    );
  return getFamilyMember(Number(info.lastInsertRowid));
}

export function updateFamily(id: number, fields: FamilyInput) {
  const cur = getFamilyMember(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: any, max: number) => {
    sets.push(`${col} = ?`);
    vals.push(v == null ? null : String(v).trim().slice(0, max) || null);
  };
  if (fields.name !== undefined) put("name", fields.name, 120);
  if (fields.color !== undefined) put("color", fields.color, 40);
  if (fields.relationship !== undefined) put("relationship", fields.relationship, 60);
  if (fields.birthdate !== undefined) put("birthdate", fields.birthdate, 10);
  if (fields.notes !== undefined) put("notes", fields.notes, 1000);
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE family_members SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getFamilyMember(id);
}

export function deleteFamily(id: number) {
  return { deleted: db.prepare(`DELETE FROM family_members WHERE id = ?`).run(id).changes };
}

// ---------- health directives (the connected brain — Phase 4C / T4) ----------
// A flagged/sub-optimal finding (a lab marker, a pattern) propagated into every
// domain it touches — nutrition, training, watch — grounded in reputable
// guideline citations where the lever is well-established, flagged uncertain
// (citation null) where the mapping is real but not settled. INFORMATIONAL, not
// medical advice. Two sources coexist: 'markers' (deterministic propagation
// engine) and 'health_review' (agent-emitted on a saved review).
export interface DirectiveInput {
  source?: string | null;       // markers | health_review
  domain?: string | null;       // nutrition | training | watch
  marker?: string | null;       // the source marker key (e.g. 'LDL-C') when applicable
  directive_key?: string | null; // stable advice family key for repeat suppression
  directive?: string | null;
  rationale?: string | null;
  citation?: string | null;
  uncertain?: boolean;          // 1 when the lever is real but not settled
  status?: string | null;       // active | resolved | dismissed
  status_at?: string | null;
  trigger_value?: number | null;
  trigger_side?: string | null;  // low | high | unknown
  trigger_date?: string | null;
  resurfaced_from_id?: number | null;
}

const DIRECTIVE_DOMAINS = new Set(["nutrition", "training", "watch"]);
const DIRECTIVE_STATUSES = new Set(["active", "resolved", "dismissed"]);

function normalizeDirectiveKey(v: any): string | null {
  const s = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160);
  return s || null;
}

function defaultDirectiveKey(marker: string | null, domain: string, directive: string | null): string | null {
  const directivePart = directive ? normalizeDirectiveKey(directive) : null;
  const parts = [
    marker ? normalizeDirectiveKey(marker) : null,
    normalizeDirectiveKey(domain),
    directivePart ? directivePart.slice(0, 90) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(":") : null;
}

function directiveTriggerFromMarker(marker: string | null) {
  if (!marker) return null;
  const target = String(marker).toLowerCase();
  const { markers } = prioritizeMarkers();
  const m = markers.find((x: any) => String(x?.name || x?.key || "").toLowerCase() === target)
    || markers.find((x: any) => String(x?.name || x?.key || "").toLowerCase().includes(target));
  if (!m) return null;
  const z = matchOptimalZone(m?.name);
  if (!z) return null;
  const value = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
  if (!Number.isFinite(value)) return null;
  const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
  return { value, side: markerSide(value, z, flag), date: m?.latest?.date ?? null };
}

// hydrate a stored row: surface `uncertain` as a boolean for consumers.
function hydrateDirective(row: any) {
  if (!row) return row;
  return { ...row, uncertain: !!row.uncertain };
}

export function addDirective(fields: DirectiveInput = {}) {
  const domain = DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : "watch";
  const status = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : "active";
  const marker = fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null;
  const directive = fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null;
  const directive_key = fields.directive_key == null
    ? defaultDirectiveKey(marker, domain, directive)
    : normalizeDirectiveKey(fields.directive_key);
  const triggerSide = ["low", "high", "unknown"].includes(String(fields.trigger_side)) ? String(fields.trigger_side) : null;
  const triggerValue = fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value)) ? null : Number(fields.trigger_value);
  const info = db
    .prepare(`INSERT INTO health_directives (source, domain, marker, directive_key, directive, rationale, citation, uncertain, status, status_at, trigger_value, trigger_side, trigger_date, resurfaced_from_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null,
      domain,
      marker,
      directive_key,
      directive,
      fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null,
      fields.citation == null || String(fields.citation).trim() === "" ? null : String(fields.citation).trim().slice(0, 600),
      fields.uncertain ? 1 : 0,
      status,
      fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null,
      triggerValue,
      triggerSide,
      fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null,
      fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id)) ? null : Number(fields.resurfaced_from_id)
    );
  return getDirective(Number(info.lastInsertRowid));
}

export function getDirective(id: number) {
  return hydrateDirective(db.prepare(`SELECT * FROM health_directives WHERE id = ?`).get(id) ?? null);
}

export function listActiveDirectives() {
  return dedupeActiveDirectives(
    (db.prepare(`SELECT * FROM health_directives WHERE status = 'active' ORDER BY id DESC`).all() as any[]).map(hydrateDirective)
  ).reverse();
}

// Defaults to the active set (what the user/coach should act on); pass
// { all: true } for the full history incl. resolved/dismissed.
export function listDirectives(opts: { all?: boolean } = {}) {
  const rows = opts.all
    ? (db.prepare(`SELECT * FROM health_directives ORDER BY id DESC`).all() as any[])
    : (db.prepare(`SELECT * FROM health_directives WHERE status = 'active' ORDER BY id DESC`).all() as any[]);
  const hydrated = rows.map(hydrateDirective);
  return opts.all ? hydrated : dedupeActiveDirectives(hydrated);
}

function directiveKey(d: any): string {
  return [
    String(d?.domain || "watch").toLowerCase(),
    String(d?.marker || "").toLowerCase().replace(/\s+/g, " ").trim(),
    String(d?.directive_key || "").toLowerCase().replace(/\s+/g, " ").trim(),
  ].join("|");
}

function directiveTextKey(d: any): string {
  return String(d?.directive || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function dedupeActiveDirectives(rows: any[]) {
  const seenMarkerDomain = new Set<string>();
  const seenText = new Set<string>();
  const out: any[] = [];
  for (const row of rows) {
    const mdKey = directiveKey(row);
    const txtKey = directiveTextKey(row);
    if ((mdKey !== "|" && seenMarkerDomain.has(mdKey)) || (txtKey && seenText.has(txtKey))) continue;
    seenMarkerDomain.add(mdKey);
    if (txtKey) seenText.add(txtKey);
    out.push(row);
  }
  return out;
}

export function updateDirective(id: number, fields: DirectiveInput) {
  const cur = getDirective(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  let statusChanged = false;
  if (fields.source !== undefined) { sets.push("source = ?"); vals.push(fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null); }
  if (fields.domain !== undefined) { sets.push("domain = ?"); vals.push(DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : cur.domain); }
  if (fields.marker !== undefined) { sets.push("marker = ?"); vals.push(fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null); }
  if (fields.directive_key !== undefined) { sets.push("directive_key = ?"); vals.push(fields.directive_key == null ? null : normalizeDirectiveKey(fields.directive_key)); }
  if (fields.directive !== undefined) { sets.push("directive = ?"); vals.push(fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null); }
  if (fields.rationale !== undefined) { sets.push("rationale = ?"); vals.push(fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null); }
  if (fields.citation !== undefined) { sets.push("citation = ?"); vals.push(fields.citation == null || String(fields.citation).trim() === "" ? null : String(fields.citation).trim().slice(0, 600)); }
  if (fields.uncertain !== undefined) { sets.push("uncertain = ?"); vals.push(fields.uncertain ? 1 : 0); }
  if (fields.status !== undefined) {
    const nextStatus = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status;
    sets.push("status = ?");
    vals.push(nextStatus);
    statusChanged = nextStatus !== cur.status;
    if (nextStatus !== cur.status && fields.status_at === undefined) {
      sets.push("status_at = datetime('now')");
    }
  }
  if (statusChanged && !cur.directive_key && fields.directive_key === undefined) {
    sets.push("directive_key = ?");
    vals.push(defaultDirectiveKey(cur.marker ?? null, cur.domain || "watch", cur.directive ?? null));
  }
  if (statusChanged && (cur.trigger_value == null || !cur.trigger_side || !cur.trigger_date)) {
    const trigger = directiveTriggerFromMarker(cur.marker ?? null);
    if (trigger) {
      if (cur.trigger_value == null && fields.trigger_value === undefined) { sets.push("trigger_value = ?"); vals.push(trigger.value); }
      if (!cur.trigger_side && fields.trigger_side === undefined) { sets.push("trigger_side = ?"); vals.push(trigger.side); }
      if (!cur.trigger_date && fields.trigger_date === undefined) { sets.push("trigger_date = ?"); vals.push(trigger.date); }
    }
  }
  if (fields.status_at !== undefined) { sets.push("status_at = ?"); vals.push(fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null); }
  if (fields.trigger_value !== undefined) { sets.push("trigger_value = ?"); vals.push(fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value)) ? null : Number(fields.trigger_value)); }
  if (fields.trigger_side !== undefined) { sets.push("trigger_side = ?"); vals.push(["low", "high", "unknown"].includes(String(fields.trigger_side)) ? String(fields.trigger_side) : null); }
  if (fields.trigger_date !== undefined) { sets.push("trigger_date = ?"); vals.push(fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null); }
  if (fields.resurfaced_from_id !== undefined) { sets.push("resurfaced_from_id = ?"); vals.push(fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id)) ? null : Number(fields.resurfaced_from_id)); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE health_directives SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getDirective(id);
}

// Clear a whole source's directives before re-deriving them, so a fresh
// deriveDirectives() pass never accumulates stale rows. Soft-resolves rather
// than deletes, keeping a history. Sources coexist: clearing 'markers' leaves
// 'health_review' directives untouched and vice-versa.
export function clearDirectivesForSource(source: string) {
  return {
    cleared: db
      .prepare(`UPDATE health_directives SET status = 'resolved' WHERE source = ? AND status = 'active'`)
      .run(source).changes,
  };
}

// ---------- insights (quiet cross-domain intelligence — Phase 6) ----------
export interface InsightInput {
  kind?: string | null;
  text?: string | null;
  rationale?: string | null;
  next_step?: string | null;  // optional concrete, low-friction suggestion
  status?: string | null;     // new | seen | dismissed
  feedback?: string | null;   // up | down
}

const INSIGHT_STATUSES = new Set(["new", "seen", "dismissed"]);
const INSIGHT_FEEDBACK = new Set(["up", "down"]);

// The card surfaces the headline plainly and tucks the reasoning behind a quiet
// "why" disclosure, so we keep each field short — the rationale is one or two
// sentences, not an evidence dump — and clamp on a WORD boundary (capStr) so a
// long value never gets sliced mid-word the way a raw .slice() would.
export function addInsight(fields: InsightInput = {}) {
  const status = INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : "new";
  const info = db
    .prepare(`INSERT INTO insights (kind, text, rationale, next_step, status, feedback) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null,
      fields.text == null ? null : capStr(fields.text, 320) || null,
      fields.rationale == null ? null : capStr(fields.rationale, 360) || null,
      fields.next_step == null ? null : capStr(fields.next_step, 200) || null,
      status,
      INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null
    );
  return getInsight(Number(info.lastInsertRowid));
}

export function getInsight(id: number) {
  return db.prepare(`SELECT * FROM insights WHERE id = ?`).get(id) ?? null;
}

export function updateInsight(id: number, fields: InsightInput) {
  const cur = getInsight(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.kind !== undefined) { sets.push("kind = ?"); vals.push(fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null); }
  if (fields.text !== undefined) { sets.push("text = ?"); vals.push(fields.text == null ? null : capStr(fields.text, 320) || null); }
  if (fields.rationale !== undefined) { sets.push("rationale = ?"); vals.push(fields.rationale == null ? null : capStr(fields.rationale, 360) || null); }
  if (fields.next_step !== undefined) { sets.push("next_step = ?"); vals.push(fields.next_step == null ? null : capStr(fields.next_step, 200) || null); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status); }
  if (fields.feedback !== undefined) { sets.push("feedback = ?"); vals.push(INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE insights SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getInsight(id);
}

// The Brief surfaces ONE insight at a time, in-app, when opened — so the public
// read is the live set only: new + seen, most recent first (dismissed stays in
// the DB and exports but is hidden). Quiet by default.
export function listVisibleInsights(limit = 20) {
  return db
    .prepare(`SELECT * FROM insights WHERE status IN ('new', 'seen') ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

// A compact, bounded list of recent insight TEXTS (any status) so the generator
// can tell the agent what it already said and avoid repeating a connection.
// Dedup is a soft prompt hint here; isDuplicateInsight() is the real guard.
export function recentInsightTexts(limit = 12): string[] {
  return db
    .prepare(`SELECT text FROM insights ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
}

// Normalize for a forgiving similarity check (lowercase, collapse whitespace,
// drop punctuation) — catches "the same connection reworded".
function normInsight(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// True when a candidate insight essentially repeats one of the recent ones:
// exact-after-normalize, or a high word-overlap (Jaccard) match. Keeps the
// quiet stream from echoing the same connection twice.
export function isDuplicateInsight(candidate: string, recent: string[] = recentInsightTexts()): boolean {
  const cand = normInsight(candidate);
  if (!cand) return true; // nothing to say is a no-op, never a fresh insight
  const candSet = new Set(cand.split(" "));
  for (const r of recent) {
    const rn = normInsight(r);
    if (!rn) continue;
    if (rn === cand) return true;
    const rSet = new Set(rn.split(" "));
    let inter = 0;
    for (const w of candSet) if (rSet.has(w)) inter++;
    const union = candSet.size + rSet.size - inter;
    if (union > 0 && inter / union >= 0.7) return true;
  }
  return false;
}

// ---------- source-agnostic daily metrics (Phase 5D — Apple Health etc.) ----------
export interface DailyMetricsInput {
  steps?: number | null;
  sleep_min?: number | null;
  sleep_score?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  active_calories?: number | null;
  raw?: any;
}

// Upsert one source's metrics for a date (mirrors upsertGarminDailyMetric, but
// source-agnostic). `source` defaults to 'apple' — the documented Shortcuts path.
export function recordDailyMetrics(source: string, date: string, metrics: DailyMetricsInput = {}) {
  const src = (source || "apple").toString().trim() || "apple";
  if (!date) throw new Error("date required");
  // Coerce/clamp at the trust boundary so non-numeric junk (e.g. steps:"abc" from
  // a hand-rolled Shortcut, which sqlite would otherwise store verbatim as TEXT in
  // an INTEGER column) never pollutes the metrics. Protects REST and MCP alike.
  const num = (v: any, lo: number, hi: number): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  db.prepare(
    `INSERT INTO daily_metrics (source, date, steps, sleep_min, sleep_score, resting_hr, hrv_ms, active_calories, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, date) DO UPDATE SET
       steps = excluded.steps, sleep_min = excluded.sleep_min, sleep_score = excluded.sleep_score,
       resting_hr = excluded.resting_hr, hrv_ms = excluded.hrv_ms, active_calories = excluded.active_calories,
       raw_json = excluded.raw_json, updated_at = datetime('now')`
  ).run(
    src, date,
    num(metrics.steps, 0, 200000), num(metrics.sleep_min, 0, 1440), num(metrics.sleep_score, 0, 100),
    num(metrics.resting_hr, 0, 250), num(metrics.hrv_ms, 0, 500), num(metrics.active_calories, 0, 20000),
    jsonOrNull(metrics.raw)
  );
  invalidateDayRead(); // fresh recovery data feeds today's Brief — recompute on next open
  return hydrateJson(db.prepare(`SELECT * FROM daily_metrics WHERE source = ? AND date = ?`).get(src, date));
}

// Recent rows for a source (or all sources) over the last `days`.
export function getDailyMetrics(source?: string | null, days = 30) {
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);
  const rows = source
    ? (db.prepare(`SELECT * FROM daily_metrics WHERE source = ? AND date >= ? ORDER BY date DESC, id DESC`).all(source, since) as any[])
    : (db.prepare(`SELECT * FROM daily_metrics WHERE date >= ? ORDER BY date DESC, id DESC`).all(since) as any[]);
  return rows.map((r) => hydrateJson(r));
}

// ---------- unified recovery summary (Phase 5D) ----------
// Generalize getGarminCoachSummary into a SOURCE-AGNOSTIC recovery view by
// merging garmin_daily_metrics with daily_metrics. Garmin is preferred for
// sleep/HRV/RHR/body-battery (richer recovery signals); steps + active calories
// fold in from ANY source. Keeps getGarminCoachSummary working untouched — this
// wraps it and layers the non-Garmin sources on top. Everything null-safe: no
// data at all → zeroed/empty fields, never a throw.
export function getRecoverySummary(days = 14, garminSummary?: any) {
  // Accept a pre-fetched Garmin summary so getCoachContext can compute it once
  // and thread it through (it otherwise fans out into getGarminCoachSummary three
  // times per context build via the garmin/recovery/day_read paths).
  const garmin = garminSummary ?? getGarminCoachSummary(days);
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);

  // Garmin recovery aggregates (may be all-null when there's no Garmin source).
  const g = (garmin?.recovery ?? {}) as any;

  // Non-Garmin daily_metrics aggregates over the same window.
  const other = db.prepare(
    `SELECT
       ROUND(AVG(sleep_min), 1) AS avg_sleep_min,
       ROUND(AVG(sleep_score), 1) AS avg_sleep_score,
       ROUND(AVG(resting_hr), 1) AS avg_resting_hr,
       ROUND(AVG(hrv_ms), 1) AS avg_hrv_ms,
       ROUND(AVG(active_calories), 1) AS avg_active_calories,
       ROUND(AVG(steps), 0) AS avg_steps,
       MAX(date) AS last_date
     FROM daily_metrics
     WHERE date >= ?`
  ).get(since) as any;

  // Steps live only on garmin_daily_metrics / daily_metrics raw rows — pull a
  // garmin steps average directly (getGarminCoachSummary doesn't surface it).
  const garminSteps = db.prepare(
    `SELECT ROUND(AVG(steps), 0) AS avg_steps FROM garmin_daily_metrics WHERE date >= ?`
  ).get(since) as any;

  // Prefer Garmin for recovery signals; fall back to other sources; fold steps
  // & active calories from whichever source has them (prefer Garmin).
  const pick = (a: any, b: any) => (a != null ? a : b != null ? b : null);
  const recovery = {
    avg_sleep_min: pick(g.avg_sleep_min, other?.avg_sleep_min),
    avg_sleep_score: pick(g.avg_sleep_score, other?.avg_sleep_score),
    avg_resting_hr: pick(g.avg_resting_hr, other?.avg_resting_hr),
    avg_hrv_ms: pick(g.avg_hrv_ms, other?.avg_hrv_ms),
    avg_stress: g.avg_stress ?? null,                          // Garmin-only signal
    avg_body_battery: g.avg_body_battery ?? null,              // Garmin-only signal
    avg_active_calories: pick(g.avg_active_calories, other?.avg_active_calories),
    avg_steps: pick(garminSteps?.avg_steps, other?.avg_steps),
    // Richer Garmin-only recovery signals (null when no Garmin source / device).
    avg_deep_sleep_min: g.avg_deep_sleep_min ?? null,
    avg_rem_sleep_min: g.avg_rem_sleep_min ?? null,
    hrv_status: g.hrv_status ?? null,
    avg_body_battery_max: g.avg_body_battery_max ?? null,
    avg_respiration: g.avg_respiration ?? null,
    avg_spo2: g.avg_spo2 ?? null,
    skin_temp_dev_c: g.skin_temp_dev_c ?? null,
    avg_vigorous_min: g.avg_vigorous_min ?? null,
    avg_training_readiness: g.avg_training_readiness ?? null,
    vo2max: g.vo2max ?? null,
    training_status: g.training_status ?? null,
    weight_kg: g.weight_kg ?? null,
    body_fat_pct: g.body_fat_pct ?? null,
    muscle_mass_kg: g.muscle_mass_kg ?? null,
    last_date: g.last_date || other?.last_date || null,
  };

  // Which sources contributed, for transparency / graceful-degradation copy.
  const sources: string[] = [];
  if (garmin?.source) sources.push("garmin");
  const otherSrc = db.prepare(`SELECT DISTINCT source FROM daily_metrics WHERE date >= ?`).all(since) as any[];
  for (const r of otherSrc) if (r?.source && !sources.includes(r.source)) sources.push(r.source);

  const has_data =
    recovery.avg_sleep_min != null || recovery.avg_resting_hr != null ||
    recovery.avg_hrv_ms != null || recovery.avg_steps != null || recovery.avg_active_calories != null;

  return {
    days,
    since,
    sources,
    has_data,
    recovery,
    // Carry the Garmin activity/hard-session detail through unchanged so any
    // consumer that wants the sports layer still has it.
    activities: garmin?.activities ?? [],
    hard_sessions: garmin?.hard_sessions ?? [],
  };
}

// ============================================================================
// THE CONNECTED BRAIN — marker prioritization + the propagation engine (T4).
// ============================================================================

// A meaningful, clinically-prioritized grouping for blood/health markers, so a
// long panel reads as a handful of health stories rather than an alphabet soup.
// Matching mirrors matchOptimalZone: lowercased substring against the marker
// name, LONGEST-MATCH-WINS (so "non-hdl" beats "hdl"). Order is intentional
// (most clinically prioritized first) and is the canonical display order. The
// "other" fallback has empty keys and only catches what nothing else claims.
interface MarkerGroup { key: string; label: string; keys: string[]; }
const MARKER_GROUPS: MarkerGroup[] = [
  { key: "lipids", label: "Lipids & Cardiovascular", keys: ["apob", "apolipoprotein", "apo b", "non-hdl", "non hdl", "ldl", "hdl", "cholesterol", "triglyceride", "lp(a)", "lipoprotein"] },
  { key: "metabolic", label: "Metabolic & Glucose", keys: ["hba1c", "a1c", "glucose", "insulin", "homa", "c-peptide", "fructosamine"] },
  { key: "inflammation", label: "Inflammation", keys: ["crp", "c-reactive", "c reactive", "homocysteine", "esr", "sed rate", "fibrinogen"] },
  { key: "iron", label: "Iron & Red Blood", keys: ["ferritin", "transferrin", "tibc", "iron", "hemoglobin", "hgb", "hematocrit", "hct", "rbc", "mcv", "mch", "rdw"] },
  { key: "blood", label: "White Cells & Platelets", keys: ["wbc", "white blood", "platelet", "neutrophil", "lymphocyte", "monocyte", "eosinophil", "basophil"] },
  { key: "liver", label: "Liver", keys: ["alt", "sgpt", "ast", "sgot", "ggt", "alp", "alkaline phosphatase", "bilirubin", "albumin", "total protein"] },
  { key: "kidney", label: "Kidney", keys: ["egfr", "creatinine", "bun", "urea", "uric acid", "cystatin"] },
  { key: "thyroid", label: "Thyroid", keys: ["tsh", "free t3", "free t4", "thyroxine", "triiodo", "thyroid"] },
  { key: "hormones", label: "Hormones", keys: ["testosterone", "estradiol", "estrogen", "cortisol", "dhea", "shbg", "progesterone", "prolactin", "igf", "lh", "fsh"] },
  { key: "vitamins", label: "Vitamins & Minerals", keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)", "b12", "cobalamin", "folate", "vitamin b", "magnesium", "zinc", "calcium", "potassium", "sodium", "selenium", "omega"] },
  { key: "vitals", label: "Blood Pressure & Vitals", keys: ["systolic", "diastolic", "blood pressure", "resting heart", "heart rate"] },
  { key: "body", label: "Body Composition", keys: ["body fat", "fat mass", "lean mass", "bone density", "bmd", "t-score", "z-score", "visceral", "bmi"] },
  { key: "other", label: "Other Markers", keys: [] },
];
const OTHER_GROUP: MarkerGroup = MARKER_GROUPS[MARKER_GROUPS.length - 1];

// Best group for a marker name — longest-match-wins over substrings (so
// "non-hdl" outranks "hdl", "alkaline phosphatase" outranks "alp"). Falls back
// to the "other" group when nothing matches.
function markerGroup(name: string): { key: string; label: string } {
  const n = String(name ?? "").toLowerCase();
  let best: MarkerGroup | null = null;
  let bestLen = 0;
  for (const g of MARKER_GROUPS) {
    for (const k of g.keys) {
      if (k && n.includes(k) && k.length > bestLen) { best = g; bestLen = k.length; }
    }
  }
  const g = best ?? OTHER_GROUP;
  return { key: g.key, label: g.label };
}

// Canonical-ordered list of {key,label} for the groups actually present in a
// set of enriched markers (each carrying a .group key). Shared by
// getMarkerHistory and prioritizeMarkers so both surface the same taxonomy.
function presentGroups(markers: { group?: string }[]): { key: string; label: string }[] {
  const present = new Set(markers.map((m) => m.group).filter(Boolean) as string[]);
  return MARKER_GROUPS.filter((g) => present.has(g.key)).map((g) => ({ key: g.key, label: g.label }));
}

// A marker's clinical normal range often hides what matters: a value can sit
// "in range" yet far from where the longevity literature wants it (LDL/ApoB
// "normal" but well above optimal). OPTIMAL_ZONES are evidence-anchored target
// bands (longevity / preventive-cardiology framing — AHA/ACC, Endocrine
// Society, ADA), distinct from the lab's population reference interval. `dir`
// says which way is worse: 'high' = higher is worse (LDL), 'low' = lower is
// worse (vitamin D), 'band' = either side of the band is worse. Everything is
// INFORMATIONAL, not medical advice.
interface OptimalZone {
  keys: string[];            // normalized marker-name matches (substring, lowercased)
  unit?: string;             // expected unit hint (informational; not enforced)
  optimal: [number, number]; // the optimal band
  dir: "high" | "low" | "band";
  actionable: boolean;       // we have a well-established lever (drives the score + derivation)
  label: string;             // canonical display label / marker key
}

const OPTIMAL_ZONES: OptimalZone[] = [
  { keys: ["apob", "apolipoprotein b", "apo b"], unit: "mg/dL", optimal: [40, 80], dir: "high", actionable: true, label: "ApoB" },
  { keys: ["ldl"], unit: "mg/dL", optimal: [40, 100], dir: "high", actionable: true, label: "LDL-C" },
  { keys: ["non-hdl", "non hdl"], unit: "mg/dL", optimal: [50, 130], dir: "high", actionable: true, label: "Non-HDL-C" },
  { keys: ["lp(a)", "lipoprotein(a)", "lipoprotein (a)"], unit: "nmol/L", optimal: [0, 75], dir: "high", actionable: false, label: "Lp(a)" },
  { keys: ["triglyceride"], unit: "mg/dL", optimal: [40, 100], dir: "high", actionable: true, label: "Triglycerides" },
  { keys: ["hdl"], unit: "mg/dL", optimal: [50, 90], dir: "low", actionable: true, label: "HDL-C" },
  { keys: ["hs-crp", "hscrp", "c-reactive", "c reactive", "crp"], unit: "mg/L", optimal: [0, 1], dir: "high", actionable: true, label: "hs-CRP" },
  { keys: ["homocysteine"], unit: "umol/L", optimal: [4, 9], dir: "high", actionable: true, label: "Homocysteine" },
  { keys: ["hba1c", "a1c", "hemoglobin a1c"], unit: "%", optimal: [4.5, 5.4], dir: "high", actionable: true, label: "HbA1c" },
  { keys: ["fasting glucose", "glucose"], unit: "mg/dL", optimal: [70, 90], dir: "band", actionable: true, label: "Fasting glucose" },
  { keys: ["fasting insulin", "insulin"], unit: "uIU/mL", optimal: [2, 6], dir: "high", actionable: true, label: "Fasting insulin" },
  { keys: ["ferritin"], unit: "ng/mL", optimal: [50, 150], dir: "band", actionable: true, label: "Ferritin" },
  { keys: ["vitamin d", "25-oh", "25 hydroxy", "25(oh)d", "25-hydroxy"], unit: "ng/mL", optimal: [40, 60], dir: "low", actionable: true, label: "Vitamin D" },
  { keys: ["egfr"], unit: "mL/min", optimal: [90, 130], dir: "low", actionable: false, label: "eGFR" },
  { keys: ["creatinine"], unit: "mg/dL", optimal: [0.7, 1.1], dir: "band", actionable: false, label: "Creatinine" },
  { keys: ["alt", "sgpt"], unit: "U/L", optimal: [0, 30], dir: "high", actionable: true, label: "ALT" },
  { keys: ["ggt"], unit: "U/L", optimal: [0, 30], dir: "high", actionable: true, label: "GGT" },
  { keys: ["tsh"], unit: "uIU/mL", optimal: [0.5, 2.5], dir: "band", actionable: false, label: "TSH" },
  { keys: ["uric acid"], unit: "mg/dL", optimal: [3, 6], dir: "high", actionable: true, label: "Uric acid" },
  { keys: ["systolic", "blood pressure", "bp systolic"], unit: "mmHg", optimal: [105, 120], dir: "high", actionable: true, label: "Systolic BP" },
];

function matchOptimalZone(name: string): OptimalZone | null {
  const n = String(name ?? "").toLowerCase();
  // Prefer the most specific (longest key) match so "non-hdl" doesn't read as "hdl".
  let best: OptimalZone | null = null;
  let bestLen = 0;
  for (const z of OPTIMAL_ZONES) {
    for (const k of z.keys) {
      if (n.includes(k) && k.length > bestLen) { best = z; bestLen = k.length; }
    }
  }
  return best;
}

// Distance from the optimal band, normalized 0..1 by the band's own width
// (capped). 0 = inside optimal; grows as the value drifts the "worse" way.
function optimalDistance(value: number, z: OptimalZone): number {
  const [lo, hi] = z.optimal;
  const width = Math.max(hi - lo, 1);
  let over = 0;
  if (z.dir === "high") over = value - hi;             // only the high side is "worse"
  else if (z.dir === "low") over = lo - value;         // only the low side is "worse"
  else over = Math.max(lo - value, value - hi);        // either side
  if (over <= 0) return 0;
  return Math.min(over / width, 3) / 3;                 // 0..1 (clamped at 3 band-widths out)
}

// Impact-Score ranking over the latest marker readings. Returns the same marker
// objects as getMarkerHistory plus { optimal, distance, in_optimal, actionable,
// impact_score } — most-actionable, furthest-from-optimal first. `flagged_count`
// counts markers the lab flagged low/high. Red-first stays the top-level sort
// (any low/high-flagged marker outranks an in-flag one); within each tier the
// Impact-Score orders most-actionable first.
//
// impact_score is an INTERNAL ordering signal ONLY — never surface it to the
// user as a 0-100 grade (the constitution bans those). The UI shows optimal-zone
// framing (in/out of optimal, the direction), never the number.
export function prioritizeMarkers() {
  const { markers } = getMarkerHistory();
  let flagged_count = 0;
  const enriched = markers.map((m: any) => {
    const flagged = m?.latest?.flag === "low" || m?.latest?.flag === "high";
    if (flagged) flagged_count++;
    const z = matchOptimalZone(m?.name);
    const numericVal = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    const hasNum = Number.isFinite(numericVal);
    let distance = 0;
    let in_optimal: boolean | null = null;
    let optimal: { low: number; high: number; dir: string } | null = null;
    if (z) {
      optimal = { low: z.optimal[0], high: z.optimal[1], dir: z.dir };
      if (hasNum) {
        distance = optimalDistance(numericVal, z);
        in_optimal = distance === 0;
      }
    }
    const actionable = z ? z.actionable : false;
    // Impact-Score: distance from optimal (the real signal) weighted up when we
    // have a lever for it, plus a floor from the lab's own flag so a flagged
    // marker we lack an optimal band for still ranks.
    const impact_score = distance * (actionable ? 1 : 0.55) + (flagged ? 0.5 : 0);
    return { ...m, optimal, distance, in_optimal, actionable, impact_score };
  });

  enriched.sort((a: any, b: any) => {
    const af = a?.latest?.flag === "low" || a?.latest?.flag === "high" ? 0 : 1;
    const bf = b?.latest?.flag === "low" || b?.latest?.flag === "high" ? 0 : 1;
    if (af !== bf) return af - bf;
    if (b.impact_score !== a.impact_score) return b.impact_score - a.impact_score;
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
  });

  // enriched carries group/group_label/trend via `...m` from getMarkerHistory;
  // recompute the present-groups list in canonical order off the enriched set.
  return { flagged_count, markers: enriched, groups: presentGroups(enriched) };
}

// ---------- the propagation engine: derive cross-domain directives (T4) ----------
// A single mapping from a flagged/sub-optimal marker to the domains it touches.
// `when(value, flag)` decides whether this marker currently warrants directives;
// `derive` returns the per-domain rows. citation is filled where the lever is a
// well-established guideline; left null (with uncertain:true) where the mapping
// is real but not settled, so the user/coach sees it flagged research-recommended.
interface MappingDirective { key?: string; domain: "nutrition" | "training" | "watch"; directive: string; rationale: string; citation?: string | null; uncertain?: boolean; }
interface MarkerContext { value: number; flag: string | null; zone: OptimalZone; side: "low" | "high" | "unknown"; marker: any; }
interface MarkerMapping {
  zone: string;            // OPTIMAL_ZONES label this keys off
  derive: (ctx: MarkerContext) => MappingDirective[];
}

// Helper: a value is "actionably off" when it's flagged low/high OR sits outside
// its optimal band the worse way.
function offOptimal(value: number, zoneLabel: string, flag: string | null): boolean {
  if (flag === "low" || flag === "high") return true;
  const z = OPTIMAL_ZONES.find((x) => x.label === zoneLabel);
  if (!z || !Number.isFinite(value)) return false;
  return optimalDistance(value, z) > 0;
}

function markerSide(value: number, zone: OptimalZone, flag: string | null): MarkerContext["side"] {
  if (flag === "low" || flag === "high") return flag;
  if (!Number.isFinite(value)) return "unknown";
  if (value < zone.optimal[0]) return "low";
  if (value > zone.optimal[1]) return "high";
  return "unknown";
}

function mappingDirectiveKey(zoneLabel: string, d: MappingDirective): string | null {
  return normalizeDirectiveKey(`${zoneLabel}:${d.domain}:${d.key || d.directive}`);
}

function lastDirectiveFeedback(source: string, marker: string | null, domain: string, directiveKey: string | null) {
  if (!directiveKey) return null;
  return hydrateDirective(db.prepare(
    `SELECT * FROM health_directives
     WHERE source = ? AND (marker = ? OR (marker IS NULL AND ? IS NULL)) AND domain = ? AND directive_key = ?
       AND status IN ('resolved', 'dismissed')
       AND status_at IS NOT NULL
     ORDER BY COALESCE(status_at, created_at) DESC, id DESC
     LIMIT 1`
  ).get(source, marker, marker, domain, directiveKey) ?? null);
}

function overageForSide(value: number, zone: OptimalZone, side: MarkerContext["side"]): number {
  if (!Number.isFinite(value)) return 0;
  if (side === "low") return Math.max(0, zone.optimal[0] - value);
  if (side === "high") return Math.max(0, value - zone.optimal[1]);
  return optimalDistance(value, zone) * Math.max(zone.optimal[1] - zone.optimal[0], 1) * 3;
}

function markerMateriallyWorse(feedback: any, ctx: MarkerContext): boolean {
  if (!feedback) return false;
  const oldSide = String(feedback.trigger_side || "unknown");
  if (oldSide !== ctx.side) return true;
  const oldValue = Number(feedback.trigger_value);
  if (!Number.isFinite(oldValue)) return true;
  const width = Math.max(ctx.zone.optimal[1] - ctx.zone.optimal[0], 1);
  const oldOver = overageForSide(oldValue, ctx.zone, ctx.side);
  const newOver = overageForSide(ctx.value, ctx.zone, ctx.side);
  const threshold = Math.max(width * 0.1, Math.abs(oldValue) * 0.05, 1);
  return newOver > oldOver + threshold;
}

function shouldSuppressDirective(feedback: any, ctx: MarkerContext): boolean {
  if (!feedback) return false;
  if (feedback.status === "dismissed") return !markerMateriallyWorse(feedback, ctx);
  if (feedback.status === "resolved") {
    const oldDate = String(feedback.trigger_date || "");
    const newDate = String(ctx.marker?.latest?.date || "");
    return !newDate || oldDate === newDate;
  }
  return false;
}

const MARKER_MAPPINGS: MarkerMapping[] = [
  { zone: "ApoB", derive: () => [
    { domain: "nutrition", directive: "Lower saturated fat (swap toward olive oil, nuts, oily fish) and add ~10g/day soluble fiber (oats, legumes, psyllium) to bring ApoB toward optimal.", rationale: "ApoB counts atherogenic particles; lowering it is the most direct dietary lever for cardiovascular risk.", citation: "AHA/ACC 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia" },
    { domain: "watch", directive: "Recheck ApoB (and a full lipid panel) in ~12 weeks after dietary changes; discuss with your doctor if it stays elevated.", rationale: "ApoB is the preferred residual-risk marker; a 12-week retest captures dietary response.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "LDL-C", derive: () => [
    { domain: "nutrition", directive: "Reduce saturated fat and add soluble fiber + plant sterols to nudge LDL-C toward optimal; favor unsaturated fats.", rationale: "Dietary saturated-fat reduction is a first-line, evidence-backed LDL lever.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "watch", directive: "Retest lipids in ~12 weeks; if LDL-C remains high despite diet, raise it with your doctor.", rationale: "Elevated LDL-C is a well-established atherosclerosis driver worth tracking and discussing clinically.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "Non-HDL-C", derive: () => [
    { domain: "nutrition", directive: "Cut saturated fat and refined carbs and raise fiber — non-HDL captures all atherogenic cholesterol, so the lipid-lowering diet applies.", rationale: "Non-HDL-C sums LDL + other atherogenic particles; the same dietary levers move it.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "watch", directive: "Retest a full lipid panel in ~12 weeks and discuss persistent elevation with your doctor.", rationale: "Non-HDL-C is a strong residual-risk marker worth confirming.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
  ] },
  { zone: "Triglycerides", derive: () => [
    { domain: "nutrition", directive: "Cut added sugar, refined carbs and alcohol; add oily fish 2-3×/week — the strongest dietary levers for high triglycerides.", rationale: "Triglycerides respond sharply to carbohydrate/alcohol load and omega-3 intake.", citation: "AHA 2021 Scientific Statement on Triglycerides; Endocrine Society 2012" },
    { domain: "training", directive: "Keep regular aerobic work in the week — endurance volume meaningfully lowers fasting triglycerides.", rationale: "Aerobic exercise is an established, dose-responsive triglyceride-lowering lever.", citation: "AHA 2021 Scientific Statement on Triglycerides" },
  ] },
  { zone: "HDL-C", derive: () => [
    { domain: "training", directive: "Prioritize regular aerobic exercise — it's the most reliable lever for raising low HDL-C.", rationale: "Aerobic training modestly but reliably raises HDL-C; pharmacologic HDL-raising has not shown benefit.", citation: "AHA/ACC 2018 Cholesterol Guideline" },
    { domain: "nutrition", directive: "Favor unsaturated fats (olive oil, nuts, fish) over refined carbs; this can help low HDL alongside training.", rationale: "Fat-quality and carbohydrate-quality shifts support HDL; diet is a softer lever than exercise here.", citation: "AHA/ACC 2018 Cholesterol Guideline", uncertain: true },
  ] },
  { zone: "hs-CRP", derive: () => [
    { domain: "watch", directive: "Elevated hs-CRP is non-specific inflammation — recheck when not fighting an acute illness/injury, and discuss persistent elevation with your doctor.", rationale: "hs-CRP spikes with any acute inflammation; a single high reading needs context before it means cardiovascular risk.", citation: "AHA/CDC 2003 Markers of Inflammation Statement" },
    { domain: "nutrition", directive: "Lean toward an anti-inflammatory pattern (oily fish, olive oil, plenty of vegetables, fewer ultra-processed foods) while hs-CRP is up.", rationale: "Dietary pattern is associated with lower hs-CRP, though the effect size is modest.", citation: "AHA/CDC 2003 Markers of Inflammation Statement", uncertain: true },
  ] },
  { zone: "Homocysteine", derive: () => [
    { domain: "nutrition", directive: "Ensure adequate folate, B12 and B6 (leafy greens, legumes, eggs, fish); a B-complex can lower elevated homocysteine — confirm B12 status with your doctor.", rationale: "Homocysteine is lowered by B-vitamin status; whether that lowers cardiovascular events is unproven, so this is informational.", citation: "Endocrine Society / AHA — B-vitamin homocysteine literature", uncertain: true },
    { domain: "watch", directive: "Recheck homocysteine after a few months of B-vitamin sufficiency; discuss persistent elevation with your doctor.", rationale: "Confirms response and flags the small subset where elevation reflects another issue.", citation: null, uncertain: true },
  ] },
  { zone: "HbA1c", derive: () => [
    { domain: "nutrition", directive: "Reduce refined carbs and added sugar, anchor meals on protein and fiber, and avoid large glucose spikes to bring HbA1c toward optimal.", rationale: "HbA1c reflects 3-month average glucose; carbohydrate quality is the primary dietary lever.", citation: "ADA Standards of Care 2024; Endocrine Society" },
    { domain: "training", directive: "Keep both resistance training and aerobic work in the week — each independently improves glucose handling.", rationale: "Exercise improves insulin sensitivity; combined modalities outperform either alone.", citation: "ADA/ACSM 2010 Joint Position Statement" },
    { domain: "watch", directive: "Recheck HbA1c in ~3 months; if it stays in the pre-diabetic range, discuss with your doctor.", rationale: "A1c moves on a ~3-month cycle; pre-diabetic trends warrant clinical follow-up.", citation: "ADA Standards of Care 2024" },
  ] },
  { zone: "Fasting glucose", derive: (ctx) => ctx.side === "high" ? [
    { domain: "nutrition", directive: "Watch evening refined-carb load and prioritize protein/fiber at meals to steady fasting glucose.", rationale: "Fasting glucose responds to overall carbohydrate load and insulin sensitivity.", citation: "ADA Standards of Care 2024" },
    { domain: "watch", directive: "Confirm with HbA1c and recheck fasting glucose; a single high reading can be stress/illness-driven — raise a persistent trend with your doctor.", rationale: "Fasting glucose is noisy day-to-day; A1c contextualizes it.", citation: "ADA Standards of Care 2024" },
  ] : [
    { domain: "watch", directive: "Low fasting glucose is not a carb-cutting signal; confirm the reading and discuss repeated lows or symptoms with your doctor.", rationale: "Fasting glucose can run low from timing, illness, medications, or measurement noise; repeated lows need context.", citation: "ADA Standards of Care 2024" },
  ] },
  { zone: "Fasting insulin", derive: () => [
    { domain: "training", directive: "Add or maintain resistance training plus aerobic work — both improve insulin sensitivity and lower fasting insulin.", rationale: "Elevated fasting insulin signals insulin resistance, which exercise directly improves.", citation: "ADA/ACSM 2010 Joint Position Statement", uncertain: true },
    { domain: "nutrition", directive: "Reduce refined carbs and overall energy excess; fat loss is a strong lever on fasting insulin.", rationale: "Insulin resistance tracks with adiposity and carbohydrate load.", citation: null, uncertain: true },
  ] },
  { zone: "Ferritin", derive: (ctx) => ctx.side === "low" ? [
    { domain: "nutrition", directive: "Add iron-rich foods (red meat, lentils, spinach) with vitamin C, and avoid tea/coffee around iron-rich meals while ferritin is low.", rationale: "Ferritin reflects iron stores; low stores often respond to dietary or supplemental iron when clinically appropriate.", citation: "WHO 2020 Ferritin Guideline" },
    { domain: "training", directive: "While ferritin runs low, be cautious adding endurance volume and keep easy sessions easy.", rationale: "Iron is rate-limiting for oxygen transport; training hard on low stores can impair recovery.", citation: "IOC consensus on iron in athletes" },
    { domain: "watch", directive: "Recheck ferritin with iron studies / CBC after ~8-12 weeks; discuss supplementation with your doctor.", rationale: "Iron repletion takes weeks; a retest confirms direction and rules out other causes.", citation: "WHO 2020 Ferritin Guideline" },
  ] : [
    { domain: "nutrition", directive: "Do not add iron to chase ferritin down; high ferritin needs clinical context rather than a diet lever.", rationale: "Ferritin can rise with inflammation, liver stress, iron overload, or recent illness, so the cause matters.", citation: "WHO 2020 Ferritin Guideline" },
    { domain: "watch", directive: "Discuss elevated ferritin with your doctor and consider iron studies / CBC to understand why it is high.", rationale: "A high ferritin result is a context marker, not a standalone nutrition target.", citation: "WHO 2020 Ferritin Guideline" },
  ] },
  { zone: "Vitamin D", derive: () => [
    { domain: "nutrition", directive: "If vitamin D is low, get sensible sun exposure and consider a D3 supplement with a fat-containing meal — confirm the dose with your doctor.", rationale: "Low 25-OH vitamin D is common and corrects reliably with D3; dosing should be clinically guided.", citation: "Endocrine Society 2011 Vitamin D Guideline" },
    { domain: "watch", directive: "Recheck vitamin D in ~3 months after supplementing to confirm you've reached an adequate level.", rationale: "Vitamin D corrects over weeks-months; a retest confirms repletion and avoids over-supplementation.", citation: "Endocrine Society 2011 Vitamin D Guideline" },
  ] },
  { zone: "Systolic BP", derive: () => [
    { domain: "nutrition", directive: "Lean toward a DASH-style pattern: more vegetables, fruit and potassium, less sodium and alcohol, to support a healthier blood pressure.", rationale: "DASH and sodium reduction are first-line, evidence-backed dietary levers for blood pressure.", citation: "ACC/AHA 2017 Hypertension Guideline" },
    { domain: "training", directive: "Keep regular aerobic exercise in the week — it reliably lowers resting blood pressure.", rationale: "Aerobic training produces a consistent, dose-responsive reduction in resting BP.", citation: "ACC/AHA 2017 Hypertension Guideline" },
    { domain: "watch", directive: "Confirm with repeated home readings (a single clinic value can be elevated); discuss a sustained high reading with your doctor.", rationale: "Single BP readings overstate risk; home averaging is the standard for confirmation.", citation: "ACC/AHA 2017 Hypertension Guideline" },
  ] },
  { zone: "Uric acid", derive: () => [
    { domain: "nutrition", directive: "Cut back on alcohol (especially beer), sugary drinks and very high-purine foods to lower elevated uric acid.", rationale: "Uric acid responds to fructose, alcohol and purine intake; reduction lowers gout risk.", citation: "ACR 2020 Gout Management Guideline", uncertain: true },
    { domain: "watch", directive: "Discuss persistently high uric acid with your doctor, especially with any joint pain history.", rationale: "Hyperuricemia is clinically actionable when symptomatic; otherwise it's a watch item.", citation: "ACR 2020 Gout Management Guideline" },
  ] },
  { zone: "ALT", derive: () => [
    { domain: "watch", directive: "Mildly elevated ALT is often fatty-liver-related; reducing alcohol, added sugar and excess body fat tends to help — discuss a persistent elevation with your doctor.", rationale: "ALT elevation commonly reflects metabolic/fatty liver, which lifestyle change improves; persistent elevation needs evaluation.", citation: "AASLD 2023 NAFLD/MASLD Guidance", uncertain: true },
  ] },
  { zone: "GGT", derive: () => [
    { domain: "watch", directive: "Elevated GGT often tracks with alcohol intake and fatty liver; cutting alcohol is the clearest lever — discuss a persistent elevation with your doctor.", rationale: "GGT is sensitive to alcohol and hepatic stress; reduction is the first dietary lever.", citation: "AASLD 2023 NAFLD/MASLD Guidance", uncertain: true },
  ] },
];

// THE PROPAGATION ENGINE. A flagged/sub-optimal biomarker propagates into every
// domain it touches — nutrition, training and watch — grounded in reputable
// guideline citations where the lever is well-established, flagged uncertain
// (citation null) where the mapping is real but not settled. Idempotent: clears
// the 'markers' source then re-derives, so directives never pile up across runs.
// Leaves the 'health_review' source untouched. INFORMATIONAL, not medical advice.
// Return shape kept as { source:'markers', derived, directives } for back-compat.
export function deriveDirectives() {
  const SOURCE = "markers";
  clearDirectivesForSource(SOURCE);
  const { markers } = prioritizeMarkers();
  let saved = 0;
  for (const m of markers) {
    const z = matchOptimalZone(m?.name);
    if (!z) continue;
    const mapping = MARKER_MAPPINGS.find((x) => x.zone === z.label);
    if (!mapping) continue;
    const numericVal = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    if (!Number.isFinite(numericVal)) continue;
    const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    if (!offOptimal(numericVal, z.label, flag)) continue;
    const ctx: MarkerContext = { value: numericVal, flag, zone: z, side: markerSide(numericVal, z, flag), marker: m };
    for (const d of mapping.derive(ctx)) {
      const directive_key = mappingDirectiveKey(z.label, d);
      const feedback = lastDirectiveFeedback(SOURCE, z.label, d.domain, directive_key);
      if (shouldSuppressDirective(feedback, ctx)) continue;
      const row = addDirective({
        source: SOURCE,
        domain: d.domain,
        marker: z.label,
        directive_key,
        directive: d.directive,
        rationale: d.rationale,
        citation: d.citation ?? null,
        uncertain: d.uncertain || !d.citation,
        trigger_value: numericVal,
        trigger_side: ctx.side,
        trigger_date: m?.latest?.date ?? null,
        resurfaced_from_id: feedback?.id ?? null,
        status: "active",
      });
      if (row) saved++;
    }
  }
  return { source: SOURCE, derived: saved, directives: listActiveDirectives() };
}

// Persist the agent-emitted directives carried on a saved health review. Stored
// under the 'health_review' source so they coexist with the deterministic
// 'markers' directives — each review save clears & rewrites only its own source.
// Never auto-applies anything; this is the review side of propose-review-apply
// for the clinical layer.
export function applyReviewDirectives(directives: any[]) {
  // Replace the health_review directive set with this list (clear + rewrite).
  // An explicit empty array legitimately means "this review flagged nothing now"
  // and SHOULD clear stale directives. The CALLER (addHealthReview) gates this so
  // it's only invoked when the agent actually addressed directives — an ABSENT
  // field (partial / old-shape response) preserves the prior set instead.
  clearDirectivesForSource("health_review");
  const list = Array.isArray(directives) ? directives : [];
  let count = 0;
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const domain = DIRECTIVE_DOMAINS.has(String(d.domain)) ? String(d.domain) : "watch";
    const marker = d.marker == null || String(d.marker).trim() === "" ? null : String(d.marker).trim().slice(0, 60);
    const directive = d.directive == null ? null : String(d.directive).trim().slice(0, 600) || null;
    const directive_key = defaultDirectiveKey(marker, domain, directive);
    const feedback = lastDirectiveFeedback("health_review", marker, domain, directive_key);
    if (feedback) continue;
    // Citation verification (Stream 4 — grounding): a medical system must not
    // surface an unverified citation. An agent-emitted citation is accepted only
    // when it matches a recognized guideline body OR a cached evidence_cache row;
    // otherwise the unverifiable string is STRIPPED and the directive downgraded
    // to uncertain (a softer nudge). The directive itself is never dropped.
    const verified = verifyCitation(d.citation ?? null, d.source_url ?? null);
    // Supplement / interaction safety gate: annotate (never block) a supplement
    // suggestion the user's markers contraindicate (e.g. iron with replete ferritin).
    const safe = safetyGate(
      { domain, marker, directive, rationale: d.rationale ?? null },
      buildSafetyMarkerContext()
    );
    const row = addDirective({
      source: "health_review",
      domain,
      marker,
      directive_key,
      directive: safe.directive,
      rationale: safe.rationale,
      citation: verified.citation,
      uncertain: verified.uncertain || safe.uncertain,
      status: "active",
    });
    if (row) count++;
  }
  return count;
}

// Active health directives condensed for the coach: domain + plain-language
// guidance (with its marker, citation and uncertain flag). INFORMATIONAL, not
// medical advice — the coach folds nutrition/training directives into plans and
// surfaces 'watch' items, never treats them as orders. Bounded.
export function directivesForCoach() {
  return listActiveDirectives().slice(0, 24).map((d: any) => ({
    domain: d.domain,
    marker: d.marker,
    directive: d.directive,
    rationale: d.rationale,
    citation: d.citation,
    uncertain: d.uncertain,
    directive_key: d.directive_key,
    trigger_value: d.trigger_value,
    trigger_side: d.trigger_side,
    trigger_date: d.trigger_date,
  }));
}

export function directiveFeedbackForCoach(limit = 12) {
  return (db.prepare(
    `SELECT * FROM health_directives
     WHERE status IN ('resolved', 'dismissed')
       AND status_at IS NOT NULL
     ORDER BY COALESCE(status_at, created_at) DESC, id DESC
     LIMIT ?`
  ).all(limit) as any[]).map(hydrateDirective).map((d: any) => ({
    status: d.status,
    status_at: d.status_at || d.created_at,
    domain: d.domain,
    marker: d.marker,
    directive: d.directive,
    rationale: d.rationale,
    directive_key: d.directive_key,
    trigger_value: d.trigger_value,
    trigger_side: d.trigger_side,
    trigger_date: d.trigger_date,
  }));
}

// ============================================================================
// RESEARCH & GROUNDING (Stream 4). Three layers, all INFORMATIONAL not medical
// advice, all degrading to today's behavior when research is off / unavailable:
//   1. evidence_cache — a host-side store of cited claims (src/research.ts fills
//      it; the health review can inject the retrieved passages and cite them).
//   2. verifyCitation — a directive's citation is accepted only if it matches a
//      recognized guideline body OR a cached evidence row; else it's stripped and
//      the directive is downgraded to uncertain (closing the hallucination surface).
//   3. safetyGate — a curated rule set that annotates (never blocks) a supplement
//      suggestion the user's markers contraindicate.
// NOTE (clean-merge boundary): this layer is implemented as SEPARATE wrapper
// functions called from applyReviewDirectives / coachOps — it does NOT edit
// OPTIMAL_ZONES / MARKER_MAPPINGS / deriveDirectives (Stream 3's territory).
// ============================================================================

// ---------- evidence cache ----------
export interface EvidenceInput {
  topic?: string | null;
  marker?: string | null;
  claim?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  body?: string | null;
  confidence?: string | null;        // high | moderate | low (plain band, never a score)
}

function normTopic(s: any): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

const EVIDENCE_CONFIDENCE = new Set(["high", "moderate", "low"]);

// Persist one cited evidence row. Coerced/clamped at the trust boundary like the
// rest of the agent-fed writes. A row with neither a claim nor a body is skipped.
export function addEvidence(fields: EvidenceInput) {
  const claim = fields.claim == null ? null : String(fields.claim).trim().slice(0, 800) || null;
  const body = fields.body == null ? null : String(fields.body).trim().slice(0, 4000) || null;
  if (!claim && !body) return null;
  const sourceUrl = fields.source_url == null ? null : String(fields.source_url).trim().slice(0, 600) || null;
  const confidence = EVIDENCE_CONFIDENCE.has(String(fields.confidence)) ? String(fields.confidence) : "moderate";
  const info = db
    .prepare(`INSERT INTO evidence_cache (topic, marker, claim, source_title, source_url, body, confidence, retrieved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(
      fields.topic == null ? null : normTopic(fields.topic) || null,
      fields.marker == null || String(fields.marker).trim() === "" ? null : String(fields.marker).trim().slice(0, 60),
      claim,
      fields.source_title == null ? null : String(fields.source_title).trim().slice(0, 300) || null,
      sourceUrl,
      body,
      confidence
    );
  return db.prepare(`SELECT * FROM evidence_cache WHERE id = ?`).get(info.lastInsertRowid);
}

// Read cached evidence by topic and/or marker (most recent first). Pass neither
// to get the most-recent rows overall (bounded).
export function getEvidence(opts: { topic?: string | null; marker?: string | null; limit?: number } = {}) {
  const limit = Number.isFinite(opts.limit as number) ? Math.max(1, Math.min(50, Number(opts.limit))) : 20;
  const where: string[] = [];
  const vals: any[] = [];
  if (opts.topic != null && String(opts.topic).trim()) { where.push("topic = ?"); vals.push(normTopic(opts.topic)); }
  if (opts.marker != null && String(opts.marker).trim()) { where.push("marker = ? COLLATE NOCASE"); vals.push(String(opts.marker).trim()); }
  const sql = `SELECT * FROM evidence_cache ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY retrieved_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, limit) as any[];
}

// Topics whose newest evidence row is older than ttlDays — the re-research pass
// reads this to refresh stale grounding. Returns distinct {topic, marker, age_days}.
export function staleEvidence(ttlDays = 90) {
  const ttl = Number.isFinite(ttlDays) ? Math.max(1, Number(ttlDays)) : 90;
  const rows = db.prepare(
    `SELECT topic, marker, MAX(retrieved_at) AS newest FROM evidence_cache
     WHERE topic IS NOT NULL GROUP BY topic, marker`
  ).all() as any[];
  const out: { topic: string; marker: string | null; age_days: number }[] = [];
  for (const r of rows) {
    const t = Date.parse(String(r.newest ?? "").replace(" ", "T") + "Z");
    if (!Number.isFinite(t)) continue;
    const ageDays = Math.floor((Date.now() - t) / 86_400_000);
    if (ageDays >= ttl) out.push({ topic: r.topic, marker: r.marker ?? null, age_days: ageDays });
  }
  return out.sort((a, b) => b.age_days - a.age_days);
}

// ---------- citation verification ----------
// Recognized guideline / evidence bodies. An agent-emitted citation naming one of
// these is accepted on its face (they're the institutions the deterministic
// MARKER_MAPPINGS already cite); anything else must match a cached evidence row.
// Lowercased substring match, longest list wins — kept deliberately broad but
// finite so a hallucinated journal title doesn't pass.
const GUIDELINE_ALLOWLIST = [
  "aha", "acc", "aha/acc", "acc/aha", "esc", "eas", "esc/eas", "ada", "aasld",
  "endocrine society", "uspstf", "nice", "who", "cochrane", "nla", "kdigo",
  "ata", "acr", "iom", "iof", "afp", "acsm", "ada/acsm", "cdc", "nih",
  "national lipid association", "american heart association", "american college of cardiology",
  "european society of cardiology", "european atherosclerosis society",
  "american diabetes association", "world health organization",
  "kidney disease improving global outcomes", "american thyroid association",
];

export interface CitationVerdict {
  citation: string | null;   // the kept citation string (null when stripped)
  uncertain: boolean;        // true when the citation could not be verified
  verified: boolean;
}

// Verify an agent-emitted citation. Accepts when it names a recognized guideline
// body OR matches a cached evidence_cache row (by source title/url). On failure
// the unverifiable string is STRIPPED (returned null) and `uncertain` is set, so
// the directive survives as a softer nudge rather than carrying a fake source.
export function verifyCitation(citation: string | null | undefined, sourceUrl?: string | null): CitationVerdict {
  const raw = citation == null ? "" : String(citation).trim();
  if (!raw) return { citation: null, uncertain: true, verified: false };
  const low = raw.toLowerCase();
  // 1) A recognized guideline body named anywhere in the citation.
  if (GUIDELINE_ALLOWLIST.some((g) => low.includes(g))) {
    return { citation: raw.slice(0, 600), uncertain: false, verified: true };
  }
  // 2) A cached evidence row whose title or url corroborates it.
  const url = sourceUrl == null ? "" : String(sourceUrl).trim();
  try {
    const rows = db.prepare(`SELECT source_title, source_url FROM evidence_cache ORDER BY id DESC LIMIT 500`).all() as any[];
    for (const r of rows) {
      const title = String(r.source_title ?? "").trim().toLowerCase();
      const rurl = String(r.source_url ?? "").trim().toLowerCase();
      if (title && (low.includes(title) || title.includes(low))) return { citation: raw.slice(0, 600), uncertain: false, verified: true };
      if (url && rurl && (rurl === url.toLowerCase())) return { citation: raw.slice(0, 600), uncertain: false, verified: true };
      if (rurl && low.includes(rurl)) return { citation: raw.slice(0, 600), uncertain: false, verified: true };
    }
  } catch { /* evidence_cache absent on a very old DB — treat as unverifiable */ }
  // Unverifiable → strip the string, downgrade to uncertain. Directive survives.
  return { citation: null, uncertain: true, verified: false };
}

// Validate a URL is a plausible http(s) source (used by src/research.ts before a
// claim is cached, and reusable anywhere a citation URL needs a sanity check).
export function isPlausibleSourceUrl(url: any): boolean {
  const s = String(url ?? "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // host must have a dot and at least a 2-char TLD; reject bare/localhost-ish.
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return false;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (!/\.[a-z]{2,}$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------- supplement / interaction safety gate ----------
// A curated rule set that DOWNGRADES/ANNOTATES (never hard-blocks) a supplement
// suggestion when the user's own markers contraindicate it. Applied as a PASS
// over directives AFTER they're derived/emitted — NOT by editing MARKER_MAPPINGS.
// Each rule: detect a supplement intent in the directive text, then check the
// relevant marker context; if contraindicated, append an informational note and
// mark the directive uncertain. INFORMATIONAL, defer to a clinician.
export interface SafetyMarkerContext {
  // latest numeric value + side ('low'/'high'/'normal'/null) per recognized marker, keyed by zone label.
  byLabel: Record<string, { value: number; side: string | null; inOptimal: boolean | null }>;
}

// Build the marker context the gate reads, from the impact-ranked markers. Cheap,
// null-safe; an empty context means the gate is a no-op (degrades gracefully).
export function buildSafetyMarkerContext(): SafetyMarkerContext {
  const byLabel: SafetyMarkerContext["byLabel"] = {};
  try {
    const { markers } = prioritizeMarkers();
    for (const m of markers as any[]) {
      const z = matchOptimalZone(m?.name);
      if (!z) continue;
      const v = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
      if (!Number.isFinite(v)) continue;
      const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
      const side = flag ?? (v < z.optimal[0] ? "low" : v > z.optimal[1] ? "high" : "normal");
      // First (highest-impact) reading per label wins.
      if (!(z.label in byLabel)) byLabel[z.label] = { value: v, side, inOptimal: m?.in_optimal ?? null };
    }
  } catch { /* no markers / engine unavailable → empty context, gate no-ops */ }
  return { byLabel };
}

interface SafetyRule {
  // true when the directive text suggests this supplement
  matches: (text: string) => boolean;
  // returns an informational note when the marker context contraindicates it, else null
  check: (ctx: SafetyMarkerContext) => string | null;
}

const SAFETY_RULES: SafetyRule[] = [
  {
    // Iron / ferritin: supplementing iron is contraindicated when ferritin is
    // already normal/high (iron overload risk). Only low ferritin warrants it.
    matches: (t) => /\biron\b|ferritin/.test(t) && /(supplement|tablet|capsule|take\b|add\b)/.test(t),
    check: (ctx) => {
      const f = ctx.byLabel["Ferritin"];
      if (f && (f.side === "high" || (f.side === "normal" && f.inOptimal !== false))) {
        return "Safety note: your most recent ferritin is not low, so don't add iron to chase it — excess iron can accumulate. Confirm iron status with your doctor before supplementing.";
      }
      return null;
    },
  },
  {
    // High-dose vitamin D3 when 25-OH D is already replete (in/above optimal).
    matches: (t) => /(vitamin d|d3|25-oh|cholecalciferol)/.test(t) && /(supplement|high-dose|high dose|\biu\b|take\b|add\b)/.test(t),
    check: (ctx) => {
      const d = ctx.byLabel["Vitamin D"];
      if (d && (d.side === "high" || (d.side === "normal" && d.inOptimal === true))) {
        return "Safety note: your vitamin D already looks replete, so a high dose isn't needed and over-supplementing carries risk — keep any dose modest and confirm with your doctor.";
      }
      return null;
    },
  },
  {
    // Creatine when kidney function is reduced (low eGFR / high creatinine).
    matches: (t) => /creatine/.test(t) && /(supplement|take\b|add\b|\bg\/day|grams?\b|loading)/.test(t),
    check: (ctx) => {
      const egfr = ctx.byLabel["eGFR"];
      const creat = ctx.byLabel["Creatinine"];
      if ((egfr && egfr.side === "low") || (creat && creat.side === "high")) {
        return "Safety note: your kidney markers (eGFR/creatinine) are off-optimal — clear creatine with your doctor first, as it can raise creatinine and isn't advised with reduced kidney function.";
      }
      return null;
    },
  },
];

export interface SafetyResult { directive: string | null; rationale: string | null; uncertain: boolean; annotated: boolean; }

// Run the gate over one directive. Only nutrition/watch supplement suggestions are
// candidates; everything else passes through untouched. Appends the informational
// note to the directive text (so it travels into every consumer) and flags
// uncertain. Never blocks — the suggestion still appears, with the caveat.
export function safetyGate(
  directive: { domain?: string | null; marker?: string | null; directive?: string | null; rationale?: string | null },
  ctx: SafetyMarkerContext
): SafetyResult {
  const text = String(directive?.directive ?? "");
  const base: SafetyResult = { directive: directive?.directive ?? null, rationale: directive?.rationale ?? null, uncertain: false, annotated: false };
  if (!text.trim()) return base;
  const low = text.toLowerCase();
  const notes: string[] = [];
  for (const rule of SAFETY_RULES) {
    if (!rule.matches(low)) continue;
    const note = rule.check(ctx);
    if (note) notes.push(note);
  }
  if (!notes.length) return base;
  const annotated = `${text} ${notes.join(" ")}`.trim().slice(0, 600);
  return { directive: annotated, rationale: directive?.rationale ?? null, uncertain: true, annotated: true };
}

// ============================================================================
// STUBS for the Stage-2 feature teams. Each has the FINAL signature + return
// shape the teams must honor, with a sane, deterministic, null-safe body so
// the build is green and the app works TODAY. Teams replace the bodies (and
// add the agent calls / api+mcp mirrors), NOT the signatures.
// ============================================================================

// ---------- T1: day intelligence ----------
export interface DayRead {
  kind: "train" | "easy" | "rest";
  focus: string | null;          // e.g. "Lower body" on a train day
  why: string;                   // one plain-language sentence
  est_minutes: number | null;
  signals: Record<string, any>;  // the deterministic inputs behind the call
}

// Deterministic baseline (T1 layers the agentic sentence + buildDayReadPrompt on
// top). Rules: rest if >=3 consecutive training days OR recovery clearly low;
// else train the suggested plan day; else easy. Never throws on missing data.
export function dayRead(date?: string, recovery?: any): DayRead {
  const d = date || todayISO();

  // Consecutive training days ending the day before `d` (a logged session counts).
  const sessionDates = new Set(
    (db.prepare(`SELECT DISTINCT s.date AS dt FROM sessions s JOIN logged_sets l ON l.session_id = s.id`).all() as any[]).map((r) => r.dt)
  );
  let consec = 0;
  let t = new Date(d + "T00:00:00Z").getTime() - 864e5; // start from yesterday
  while (sessionDates.has(new Date(t).toISOString().slice(0, 10))) { consec++; t -= 864e5; }

  // Recovery signal (unified). "clearly low" = short sleep or a low subjective
  // check-in for the day. All optional — absent signals never force rest. The
  // window is always "last 14 days from now" (date-independent), so a caller that
  // already has it (getCoachContext) can pass it in to avoid a redundant fetch.
  const rec = recovery ?? getRecoverySummary(14);
  const checkin = getCheckinByDate(d) as any;
  const avgSleepMin = rec?.recovery?.avg_sleep_min ?? null;
  const lowSleep = avgSleepMin != null && avgSleepMin > 0 && avgSleepMin < 360; // <6h average
  const lowSubjective = checkin && ((checkin.energy != null && checkin.energy <= 2) || (checkin.sleep_feel != null && checkin.sleep_feel <= 2));

  // What's already been logged for `d` — a lifting session (sets) or a real
  // activity (a run/ride/class). The Brief must reflect this: once you've moved
  // today it should acknowledge it, not keep suggesting a fresh session as if the
  // day were blank. A "real" activity clears a light bar (≥20 min or any logged
  // distance) so an incidental short walk doesn't suppress a genuinely-due day.
  const todaysActivities = db.prepare(
    `SELECT type, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id DESC`
  ).all(d) as any[];
  const todaysSetCount = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`).get(d) as any)?.n ?? 0
  );
  const bigActivity =
    todaysActivities.find((a) => (a.duration_min != null && Number(a.duration_min) >= 20) || a.distance_km != null) || null;

  const signals = {
    consecutive_training_days: consec,
    avg_sleep_min: avgSleepMin,
    low_sleep: lowSleep,
    checkin: checkin ? { energy: checkin.energy, sleep_feel: checkin.sleep_feel, soreness: checkin.soreness, mood: checkin.mood } : null,
    has_recovery_data: !!rec?.has_data,
    logged_today: {
      sets: todaysSetCount,
      activities: todaysActivities.map((a) => ({ type: a.type, duration_min: a.duration_min, distance_km: a.distance_km })),
    },
  };

  // Already trained today (a logged lifting session)? Then today reads as covered.
  const trainedToday = sessionDates.has(d);

  // Pick a suggested plan day for the "train" case. ADVANCE the rotation off the
  // last day actually trained — mirror the PWA's plan-tab logic (it picks the day
  // after your most recent logged session) so the Brief and the exercise plan can
  // never disagree, and so the read "follows yesterday" instead of repeating it.
  // The last session's plan day is resolved by its plan_day_id, falling back to
  // the best exercise-name overlap (ad-hoc sessions logged without a plan link),
  // walking back through recent sessions until one resolves. With no resolvable
  // history at all, fall back to the weekday rotation, then the first plan day.
  function suggestedPlanDay(): { day_number: number; focus: string | null } | null {
    const days = db.prepare(`SELECT id, day_number, name, focus FROM plan_days ORDER BY day_number`).all() as any[];
    if (!days.length) return null;
    const shape = (day: any) => (day ? { day_number: day.day_number, focus: day.focus || day.name || null } : null);
    const nextAfter = (dayNumber: number) => {
      const idx = days.findIndex((x) => x.day_number === dayNumber);
      return days[idx >= 0 ? (idx + 1) % days.length : 0];
    };

    // Lazily-built name-set per plan day, only when we need an overlap match.
    let dayNameSets: { day_number: number; names: Set<string> }[] | null = null;
    const resolveByOverlap = (sessionId: number): number | null => {
      if (!dayNameSets) {
        dayNameSets = days.map((day) => ({
          day_number: day.day_number,
          names: new Set(
            (db.prepare(`SELECT e.name AS name FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ?`).all(day.id) as any[]).map((r) => r.name)
          ),
        }));
      }
      const logged = new Set(
        (db.prepare(`SELECT DISTINCT e.name AS name FROM logged_sets l JOIN exercises e ON e.id = l.exercise_id WHERE l.session_id = ?`).all(sessionId) as any[]).map((r) => r.name)
      );
      let best: { day_number: number; hits: number } | null = null;
      for (const ds of dayNameSets) {
        let hits = 0;
        logged.forEach((n) => { if (ds.names.has(n)) hits++; });
        if (hits && (!best || hits > best.hits)) best = { day_number: ds.day_number, hits };
      }
      return best?.day_number ?? null;
    };

    // Most recent prior sessions that actually logged work — first one that maps
    // to a plan day sets the rotation (an ad-hoc cardio session is skipped, not a
    // reset). Excludes `d` and the future via the date filter.
    const recent = db.prepare(
      `SELECT s.id, s.plan_day_id FROM sessions s
       WHERE s.date < ? AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
       ORDER BY s.date DESC, s.id DESC LIMIT 20`
    ).all(d) as any[];
    for (const sess of recent) {
      const linked = sess.plan_day_id ? days.find((x) => x.id === sess.plan_day_id) : null;
      const lastDayNum = linked ? linked.day_number : resolveByOverlap(sess.id);
      if (lastDayNum != null) return shape(nextAfter(lastDayNum));
    }

    // No resolvable training history → weekday rotation as a gentle default.
    const idx = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon=0
    return shape(days[idx % days.length]);
  }

  if (consec >= 3 || lowSleep || lowSubjective) {
    return {
      kind: "rest",
      focus: null,
      why: consec >= 3
        ? "You've trained several days running — let it consolidate."
        : lowSleep
          ? "Sleep's run short lately — an easier day will serve you better."
          : "You're feeling run-down today — rest is the smart call.",
      est_minutes: null,
      signals,
    };
  }
  if (trainedToday) {
    return { kind: "easy", focus: null, why: "You've already trained today — keep the rest of it easy.", est_minutes: 20, signals };
  }
  if (bigActivity) {
    const label = bigActivity.type && bigActivity.type !== "other" ? String(bigActivity.type) : "workout";
    return { kind: "easy", focus: null, why: `You've already got a ${label} in today — nice. Keep the rest of the day easy.`, est_minutes: 20, signals };
  }
  const sd = suggestedPlanDay();
  if (sd) {
    return { kind: "train", focus: sd.focus, why: "You're recovered and due — good to go.", est_minutes: 60, signals };
  }
  return { kind: "easy", focus: null, why: "Nothing programmed — some easy movement is plenty today.", est_minutes: 20, signals };
}

// ---------- Day-read cache (the Brief) ----------
// One canonical (no-override) read per calendar day, persisted so the morning
// open is instant. The nightly scheduler pass (and any cache miss) fills it; the
// few events that materially change the read invalidate the affected day, and
// the next open recomputes once and re-caches. See src/dayread.ts for the
// agentic compute + write path that wraps the deterministic dayRead() above.
export function getCachedDayRead(date: string): any | null {
  const row = db.prepare(`SELECT * FROM day_reads WHERE date = ?`).get(date) as any;
  if (!row) return null;
  let signals: any = {};
  try { signals = row.signals ? JSON.parse(row.signals) : {}; } catch { signals = {}; }
  return {
    kind: row.kind,
    headline: row.headline,
    why: row.why,
    focus: row.focus ?? null,
    est_minutes: row.est_minutes ?? null,
    signals,
    source: row.source || "deterministic",
    agent: row.agent || undefined,
    override: row.override ?? null,
    computed_at: row.computed_at,
  };
}

export function saveDayRead(date: string, read: any): void {
  if (!date || !read || !read.kind) return;
  const override = read.override != null && String(read.override).trim() ? String(read.override).trim() : null;
  // No-clobber guard: a canonical (no-steer) recompute — nightly precompute, boot
  // warm, a cache-miss compute — must never overwrite an athlete's persisted steer
  // for the day. Only a real material change (a logged set / check-in) clears it,
  // via invalidateDayRead() deleting the row first.
  if (!override) {
    const existing = db.prepare(`SELECT override FROM day_reads WHERE date = ?`).get(date) as any;
    if (existing && existing.override) return;
  }
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, est_minutes, signals, source, agent, override, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       kind=excluded.kind, headline=excluded.headline, why=excluded.why, focus=excluded.focus,
       est_minutes=excluded.est_minutes, signals=excluded.signals, source=excluded.source,
       agent=excluded.agent, override=excluded.override, computed_at=excluded.computed_at`
  ).run(
    date,
    read.kind,
    read.headline ?? null,
    read.why ?? null,
    read.focus ?? null,
    read.est_minutes != null && Number.isFinite(Number(read.est_minutes)) ? Math.round(Number(read.est_minutes)) : null,
    JSON.stringify(read.signals ?? {}),
    read.source ?? "deterministic",
    read.agent ?? null,
    override
  );
  // Keep the table to a rolling few weeks — old reads are never served.
  try { db.prepare(`DELETE FROM day_reads WHERE date < date('now','-21 days')`).run(); } catch {}
}

export function invalidateDayRead(date?: string): void {
  const d = date || todayISO();
  try { db.prepare(`DELETE FROM day_reads WHERE date = ?`).run(d); } catch {}
}

// ---------- T3: adaptive nutrition (expenditure / TDEE) ----------
export interface ExpenditureEstimate {
  tdee: number | null;            // derived maintenance kcal, or null when too little data
  confidence: "none" | "low" | "medium" | "high";
  points: number;                // how many days of usable data backed it
  window_days: number;
  intake_avg_kcal: number | null;
  trend_lb_wk: number | null;    // weighted bodyweight trend over the window
}

// Energy-balance derivation (MacroFactor-style, adherence-neutral). TDEE ≈ avg
// daily intake − (weighted weekly weight change in lb × 3500 / 7). Null-safe:
// too few weigh-ins or no intake → tdee null, confidence 'none'. Adherence-
// neutral: a thin logging week only lowers confidence — it NEVER blames the
// athlete and NEVER reads a gap as a number to act on. The deepening over the
// baseline: recent weigh-ins are weighted more heavily (the body's "now" matters
// most), higher confidence demands BOTH enough intake days AND enough weigh-ins
// spanning enough calendar days, and an active travel/illness window (from
// context_events) suppresses confidence — intake logging and the scale are both
// disrupted then, so we lean conservative rather than re-target on noise.
export function estimateExpenditure(windowDays = 21): ExpenditureEstimate {
  const since = new Date(Date.now() - Math.max(1, windowDays - 1) * 864e5).toISOString().slice(0, 10);
  const nowDay = Date.now() / 864e5;

  // Bodyweight trend over the window — a RECENCY-WEIGHTED least-squares slope
  // (lb/week). Each weigh-in gets weight exp(-ageDays / halfLife*1.4427) so the
  // newest days dominate; MacroFactor's adaptive expenditure leans the same way
  // (the body's current trajectory matters more than three weeks ago).
  const wpts = db.prepare(`SELECT date, weight_lb FROM bodyweight_log WHERE date >= ? ORDER BY date, id`).all(since) as any[];
  let trend: number | null = null;
  let weighDays = 0;        // distinct weigh-in days, for confidence
  let weighSpanDays = 0;    // first→last calendar span, for confidence
  if (wpts.length >= 2) {
    const xs = wpts.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
    const ys = wpts.map((p) => Number(p.weight_lb));
    weighDays = new Set(wpts.map((p) => String(p.date))).size;
    weighSpanDays = xs[xs.length - 1] - xs[0];
    if (weighSpanDays >= 3) {
      // Half-life ~10 days: a weigh-in 10 days old counts ~half a fresh one.
      const halfLife = Math.max(7, windowDays / 2);
      const ws = xs.map((x) => Math.exp(-((nowDay - x) * Math.LN2) / halfLife));
      const sw = ws.reduce((a, b) => a + b, 0);
      const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / sw;
      const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / sw;
      let num = 0, den = 0;
      for (let i = 0; i < xs.length; i++) { num += ws[i] * (xs[i] - mx) * (ys[i] - my); den += ws[i] * (xs[i] - mx) ** 2; }
      if (den > 0) trend = (num / den) * 7; // lb/day → lb/wk
    }
  }

  // Average daily intake from food_notes over the window (sum kcal per day,
  // then average across days that have any logged food). Days with no food
  // logged are simply absent — never counted as zero (that would slander an
  // off-logging day as a crash diet); they only thin the data.
  const notes = db.prepare(`SELECT created_at, parsed_json FROM food_notes WHERE substr(created_at,1,10) >= ?`).all(since) as any[];
  const kcalByDay = new Map<string, number>();
  for (const n of notes) {
    let parsed: any = null;
    try { parsed = n.parsed_json ? JSON.parse(n.parsed_json) : null; } catch { parsed = null; }
    const kcal = Number(parsed?.kcal);
    if (!Number.isFinite(kcal) || kcal <= 0) continue;
    const day = String(n.created_at ?? "").slice(0, 10);
    kcalByDay.set(day, (kcalByDay.get(day) ?? 0) + kcal);
  }
  const dayTotals = [...kcalByDay.values()];
  const intakeAvg = dayTotals.length ? Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length) : null;

  const points = dayTotals.length;
  if (intakeAvg == null || trend == null) {
    return { tdee: null, confidence: "none", points, window_days: windowDays, intake_avg_kcal: intakeAvg, trend_lb_wk: trend == null ? null : Math.round(trend * 100) / 100 };
  }
  // TDEE = intake − (weekly Δweight as a daily kcal balance).
  const dailyBalance = (trend * KCAL_PER_LB) / 7; // +ve trend (gaining) ⇒ surplus
  const tdee = Math.round(intakeAvg - dailyBalance);

  // Confidence demands BOTH enough intake days AND enough weigh-ins over enough
  // calendar span — a slope off two clustered days isn't trustworthy.
  let confidence: ExpenditureEstimate["confidence"];
  if (points >= 14 && weighDays >= 8 && weighSpanDays >= 14) confidence = "high";
  else if (points >= 7 && weighDays >= 4 && weighSpanDays >= 7) confidence = "medium";
  else confidence = "low";

  // Suppress during an active travel/illness window: the scale and the food log
  // are both unreliable mid-trip / mid-illness, so we lower confidence by a step
  // rather than re-target on disrupted data. NOT a judgement — just caution.
  if (confidence !== "low" && expenditureDisruptedNow()) {
    confidence = confidence === "high" ? "medium" : "low";
  }

  return { tdee, confidence, points, window_days: windowDays, intake_avg_kcal: intakeAvg, trend_lb_wk: Math.round(trend * 100) / 100 };
}

// True when an active/upcoming context_event makes intake + weight unreliable
// right now: any trip overlapping today, or a life_event whose text reads as
// illness/sick. Used to lower expenditure confidence (never to scold).
function expenditureDisruptedNow(): boolean {
  const today = todayISO();
  const events = listContextEvents({ activeOnly: true }) as any[];
  const ILLNESS = /\b(ill|illness|sick|sickness|flu|fever|cold|covid|infection|food ?poison|stomach|gastro|bug|virus|unwell)\b/i;
  for (const e of events) {
    const start = e?.start_date ? String(e.start_date) : null;
    const end = e?.end_date ? String(e.end_date) : null;
    // Active today = started on/before today AND not yet ended (open-ended counts).
    const startedByNow = !start || start <= today;
    const notEnded = !end || end >= today;
    if (!startedByNow || !notEnded) continue;
    if (e?.kind === "trip") return true;
    if (e?.kind === "life_event") {
      const txt = `${e?.title ?? ""} ${e?.detail ?? ""} ${e?.meta?.impact ?? ""}`;
      if (ILLNESS.test(txt)) return true;
    }
  }
  return false;
}

// ---------- T5: frequent foods by time of day ----------
// summary/count/last_at are the load-bearing fields; the macro carry-through
// (kcal/protein_g/carbs_g/fat_g, all optional) is additive — populated from the
// most recent occurrence's parsed_json when present, so a one-tap re-log can
// prefill macros without another agent call. Absent when never enriched.
export interface FrequentFood {
  summary: string;
  count: number;
  last_at: string;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}

// Collapse a food summary into a grouping key: lowercase, fold whitespace, drop
// trailing punctuation and a leading "a/an/the". Slightly broader than a bare
// toLowerCase() so "Chicken & rice", "chicken and rice " and "the chicken &
// rice." all group together — but conservative on purpose (no stemming, no
// synonym table) so genuinely different meals stay distinct.
function frequentFoodKey(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[.,;:!?]+$/g, "")          // trailing punctuation
    .replace(/\s*&\s*/g, " and ")        // "&" ⇒ "and" so both spellings merge
    .replace(/^\s*(a|an|the)\s+/, "")    // leading article
    .replace(/\s+/g, " ")                // fold internal whitespace
    .trim();
}

// Recent distinct foods logged near a given hour-of-day (±2h), most-frequent
// first — powers one-tap "frequents" in fast logging. Deterministic, null-safe.
export function frequentFoods(hour?: number): FrequentFood[] {
  const targetHour = Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : new Date().getHours();
  // Push the ±2h hour band into SQL (created_at is UTC "YYYY-MM-DD HH:MM:SS", so
  // substr pos 12-13 is the hour) so the LIMIT is a horizon over MATCHING rows,
  // not a blanket recency truncation — otherwise a heavy logger's rarely-used
  // off-peak slot could fall entirely outside the 400 newest rows and return [].
  // The hour set wraps midnight naturally.
  const bandHours: number[] = [];
  for (let dh = -2; dh <= 2; dh++) bandHours.push(((targetHour + dh) % 24 + 24) % 24);
  const rows = db.prepare(
    `SELECT created_at, meal, parsed_json FROM food_notes
     WHERE CAST(substr(created_at, 12, 2) AS INTEGER) IN (${bandHours.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 400`
  ).all(...bandHours) as any[];
  const agg = new Map<string, { count: number; last_at: string }>();
  for (const r of rows) {
    // created_at is stored UTC ("YYYY-MM-DD HH:MM:SS"); read the hour and accept
    // a ±2h window (wrapping midnight) around the target.
    const hh = Number(String(r.created_at ?? "").slice(11, 13));
    if (!Number.isFinite(hh)) continue;
    const diff = Math.min(Math.abs(hh - targetHour), 24 - Math.abs(hh - targetHour));
    if (diff > 2) continue;
    let parsed: any = null;
    try { parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null; } catch { parsed = null; }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    const cur = agg.get(key);
    if (cur) { cur.count++; if (String(r.created_at) > cur.last_at) cur.last_at = String(r.created_at); }
    else agg.set(key, { count: 1, last_at: String(r.created_at) });
  }
  // Recover display casing from the NEWEST occurrence of each key (rows are
  // id-DESC, so the first one we see per key wins), and macros from the newest
  // occurrence that actually CARRIES them — the most recent log of a food is
  // often a quick text entry not yet enriched, so we want the freshest enriched
  // estimate to prefill, not null.
  const display = new Map<string, string>();
  const macros = new Map<string, { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }>();
  const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  for (const r of rows) {
    let parsed: any = null;
    try { parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null; } catch { parsed = null; }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    if (!display.has(key)) display.set(key, summary);
    if (!macros.has(key)) {
      const m = {
        kcal: num(parsed?.kcal),
        protein_g: num(parsed?.protein_g),
        carbs_g: num(parsed?.carbs_g),
        fat_g: num(parsed?.fat_g),
      };
      // Only lock in macros once we find an occurrence that has at least one —
      // skip bare text logs so a later (older) enriched row can supply them.
      if (m.kcal != null || m.protein_g != null || m.carbs_g != null || m.fat_g != null) macros.set(key, m);
    }
  }
  return [...agg.entries()]
    .map(([key, v]) => {
      const m = macros.get(key);
      return {
        summary: display.get(key) ?? key,
        count: v.count,
        last_at: v.last_at,
        kcal: m?.kcal ?? null,
        protein_g: m?.protein_g ?? null,
        carbs_g: m?.carbs_g ?? null,
        fat_g: m?.fat_g ?? null,
      };
    })
    .sort((a, b) => b.count - a.count || (b.last_at > a.last_at ? 1 : -1))
    .slice(0, 8);
}

// prioritizeMarkers + the OPTIMAL_ZONES infrastructure live up with the
// propagation engine (deriveDirectives consumes them); see that section above.
