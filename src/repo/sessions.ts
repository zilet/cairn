import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import { reconcileDailySessionSafe } from "./daily-reconciliation.js";
import { sessionNoteSuggestsFatigue } from "./training-fatigue.js";
import { localDateISO } from "./shared.js";
import {
  isStrengthGarminType,
  listActivities,
  listGarminActivities,
  listGarminDailyMetrics,
  listGarminSources,
} from "./activities.js";
import { activitySportWhere, canonicalEnduranceSport } from "./endurance-sports.js";
import { MUSCLE_LANDMARKS } from "./exercise-canon.js";
import { effectiveVolumeByGroup, type VolumeSet } from "./exercise-variations.js";
import { findExercise, findOrCreateExercise, listExercises } from "./exercises.js";
import { listContextEvents, listHealthReviews } from "./health.js";
import { invalidateDayRead, invalidateDayReadIfDecisionChanged } from "./intelligence.js";
import { listMemory, listSuggestions } from "./memory.js";
import { listFoodNotes, listMealPlans } from "./nutrition.js";
import { getPlan } from "./plan.js";
import { effectiveGoalMode, getProfile, leanGainRate, listWeight } from "./profile.js";
import { getSettings } from "./settings.js";
import { normalizeSymptomArea } from "./symptom-area.js";
import { recordSymptomReport } from "./symptom-reports.js";
import { inferTrainingSymptomExposures } from "./training-symptoms.js";
import { symptomTextMentionsBody } from "../symptomCapture.js";
import {
  bumpTrainingDataVersion,
  currentTrainingDataVersion,
  registerTrainingCacheClear,
  trainingBackstopSignature,
} from "./training-cache.js";
import { deriveSessionTitle } from "./training-read.js";
import { canonicalBodyweightSeries, resolvedCurrentBodyweight } from "./bodyweight.js";
import {
  completeStrengthObjectiveFromLoggedSet,
  reconcileStrengthObjectiveFromLoggedSets,
  strengthJourneySessionMovement,
} from "./strength-objective-ledger.js";
import { getActiveDailySessionForSession, listDailySessionCompositions } from "./adaptive-session.js";
import { getAuthoritativeSessionRow, getOrCreateSessionRow } from "./session-core.js";

// ---------- sessions ----------
export function getOrCreateSession(date: string, planDayId?: number | null): any {
  return getOrCreateSessionRow(date, planDayId);
}

// Parse the reconciled Garmin strength physiology blob off a session row into a
// `garmin` object (dropping the raw `garmin_json` string). Null when absent/bad.
function hydrateSession(s: any) {
  if (!s) return s;
  let garmin: any = null;
  try {
    garmin = s.garmin_json ? JSON.parse(s.garmin_json) : null;
  } catch {
    garmin = null;
  }
  const { garmin_json, ...rest } = s;
  return { ...rest, garmin };
}

// `through` bounds the read to sessions logged ON OR BEFORE a calendar date. It
// exists for the signal builders, which may be reading a FIXED HISTORICAL date:
// unbounded, the twenty newest sessions are relative to now, so a read of last
// Tuesday was derived from work logged after it. Omitted (the default and every
// pre-existing caller) the behavior is unchanged.
export function getRecentSessions(limit = 10, opts: { through?: string } = {}) {
  const through = typeof opts.through === "string" && opts.through.trim() ? opts.through.trim() : null;
  const sessions = db
    .prepare(`SELECT s.*, pd.name AS day_name FROM sessions s
              LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
              ${through ? "WHERE s.date <= ?" : ""}
              ORDER BY s.date DESC, s.id DESC LIMIT ?`)
    .all(...(through ? [through] : []), limit) as any[];
  // `title` is the content-true display name (see deriveSessionTitle); `day_name`
  // stays the raw plan-day label so existing consumers are untouched.
  return sessions.map((s) => ({
    ...hydrateSession(s),
    title: deriveSessionTitle(s.id, s.plan_day_id, s.day_name),
    daily_session: getActiveDailySessionForSession(s.id),
    sets: setsForSession(s.id),
    skips: skipsForSession(s.id),
  }));
}

export function getSessionByDate(date: string) {
  const s = db
    .prepare(`SELECT s.*, pd.name AS day_name FROM sessions s
              LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
              LEFT JOIN daily_session_compositions dsc
                ON dsc.session_id = s.id AND dsc.status = 'active'
              WHERE s.date = ?
              ORDER BY CASE WHEN dsc.id IS NOT NULL THEN 0 ELSE 1 END, s.id
              LIMIT 1`)
    .get(date) as any;
  if (!s) return null;
  return {
    ...hydrateSession(s),
    title: deriveSessionTitle(s.id, s.plan_day_id, s.day_name),
    daily_session: getActiveDailySessionForSession(s.id),
    sets: setsForSession(s.id),
    skips: skipsForSession(s.id),
  };
}

export function getSessionDetail(id: number) {
  const s = db
    .prepare(
      `SELECT s.*, pd.name AS day_name FROM sessions s
     LEFT JOIN plan_days pd ON pd.id = s.plan_day_id WHERE s.id = ?`
    )
    .get(id) as any;
  if (!s) return null;
  return {
    ...hydrateSession(s),
    title: deriveSessionTitle(s.id, s.plan_day_id, s.day_name),
    daily_session: getActiveDailySessionForSession(s.id),
    sets: setsForSession(id),
    skips: skipsForSession(id),
    strength_journey_movement: s.finished_at ? strengthJourneySessionMovement(id) : null,
  };
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
  // COALESCE preserves the existing note ONLY when the incoming value is NULL — an
  // empty/whitespace-only string would overwrite a real note with "". Normalize it
  // to null here (the guard closest to the write) so a note-less re-finish — e.g. an
  // offline outbox replay that lost the typed note — can never clobber a saved note.
  const cleanNotes = notes != null && String(notes).trim() ? String(notes).trim() : null;
  const span = db
    .prepare(`SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM logged_sets WHERE session_id = ?`)
    .get(sessionId) as any;
  let duration_min = s.duration_min ?? null;
  if (span?.first && span?.last) {
    const mins = Math.round((new Date(span.last + "Z").getTime() - new Date(span.first + "Z").getTime()) / 60000);
    if (mins > 0) duration_min = mins;
  }
  db.prepare(
    `UPDATE sessions SET duration_min = ?, notes = COALESCE(?, notes), finished_at = datetime('now') WHERE id = ?`
  ).run(duration_min, cleanNotes, sessionId);
  bumpTrainingDataVersion();
  emitBrainEvent({
    kind: "session_finished",
    domain: "training",
    date: s.date,
    entity_id: sessionId,
    subject_key: `session:${sessionId}`,
  });
  if (sessionNoteSuggestsFatigue(cleanNotes ?? s.notes)) {
    emitBrainEvent({
      kind: "session_feedback",
      domain: "training",
      date: s.date,
      entity_id: sessionId,
      subject_key: `session:${sessionId}`,
      reason: "session note reports performance fatigue",
      material: true,
    });
  }
  const spokeAboutBody = captureSessionNoteSymptomReport(sessionId, s.date, cleanNotes ?? s.notes);
  // Tolerance read off what they actually trained, not off a button they remembered
  // to press. Idempotent, so a re-finish or a Garmin re-sync adds nothing.
  //
  // Skipped outright when this very note said something about their body. Reading
  // silence off a session they wrote "left knee hurt badly on every squat today" on
  // would record the opposite of what they said — and the deterministic layer already
  // knows, one line above, without waiting on an extraction that may never run.
  if (!spokeAboutBody) {
    try {
      inferTrainingSymptomExposures(sessionId, s.date);
    } catch {
      /* inferred evidence is additive — it must never fail a finish */
    }
  }
  // Stage 4: reconcile the accepted daily-session composition against what was
  // actually trained (idempotent, additive; a no-op for plain plan sessions).
  reconcileDailySessionSafe(sessionId);
  return { ...getSessionDetail(sessionId), summary: sessionSummary(sessionId) };
}

// A session note is where an athlete most naturally says "wrist was grumpy on
// presses". Keep those words VERBATIM (the extraction lane derives structure from
// them later); skip the note entirely when it says nothing about the body, so
// "felt strong, good session" never costs an agent call.
//
// Returns whether the note was about the body at all — the one thing the finish path
// can know deterministically, before any structure has been derived from the words.
function captureSessionNoteSymptomReport(sessionId: number, date: unknown, notes: unknown): boolean {
  const text = notes == null ? "" : String(notes).trim();
  if (!text || !symptomTextMentionsBody(text)) return false;
  try {
    recordSymptomReport({
      text,
      source_kind: "session_note",
      reported_on: String(date ?? localDateISO()),
      session_id: sessionId,
    });
  } catch {
    /* capturing the words is additive — never fail the session write over it */
  }
  return true;
}

// Reopen a finished session to keep logging (clears finished_at). Idempotent — a
// no-op on an already-open session. The Today "done" card offers this so a wrap-up
// is never a one-way door.
export function reopenSession(sessionId: number) {
  const s = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  db.prepare(`UPDATE sessions SET finished_at = NULL WHERE id = ?`).run(sessionId);
  reconcileDailySessionSafe(sessionId);
  return getSessionDetail(sessionId);
}

// Edit a session's notes after the fact (history correction). Returns the full
// session detail, or null if the id is unknown. A corrected fatigue note is a
// material signal, so the coach can re-evaluate instead of waiting for another set.
export function updateSessionNotes(sessionId: number, notes: string | null) {
  const s = db.prepare(`SELECT id, date FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!s) return null;
  const clean = notes != null ? String(notes).trim().slice(0, 1000) || null : null;
  db.prepare(`UPDATE sessions SET notes = ? WHERE id = ?`).run(clean, sessionId);
  bumpTrainingDataVersion();
  // Deliberately UNCONDITIONAL while the set-logging paths around it are guarded. A
  // note is athlete-authored prose — it is not in the decision fingerprint and must
  // not be (prose is exactly what that hash exists to exclude), so the guarded form
  // would read "nothing moved" and silently swallow a corrected fatigue report. It
  // is also a rare, deliberate action, not the per-set churn this economy is about.
  invalidateDayRead(s.date || localDateISO());
  if (sessionNoteSuggestsFatigue(clean)) {
    emitBrainEvent({
      kind: "session_feedback",
      domain: "training",
      date: s.date || localDateISO(),
      entity_id: sessionId,
      subject_key: `session:${sessionId}`,
      reason: "corrected session note reports performance fatigue",
      material: true,
    });
  }
  captureSessionNoteSymptomReport(sessionId, s.date, clean);
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
  const session = getOrCreateSession(date || localDateISO());
  const clamp15 = (v: any): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(5, Math.max(1, Math.round(n)));
  };
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.soreness !== undefined) {
    sets.push("soreness = ?");
    vals.push(fields.soreness == null ? null : clamp15(fields.soreness));
  }
  if (fields.performance !== undefined) {
    sets.push("performance = ?");
    vals.push(fields.performance == null ? null : clamp15(fields.performance));
  }
  if (fields.joint_pain !== undefined) {
    // joint_pain is the same concept as a symptom area_text (the legacy importer
    // turns one into the other), so it obeys the same short-label contract. An
    // agent that answers with a coach paragraph here used to poison every
    // downstream relevance check; the normalizer keeps it a place, not prose.
    //
    // The normalizer is why the athlete's FULL sentence has to be captured first,
    // one line below: everything after the first clause is about to be dropped from
    // this column, and it used to be dropped from existence.
    sets.push("joint_pain = ?");
    vals.push(fields.joint_pain == null ? null : normalizeSymptomArea(fields.joint_pain) || null);
    const spoken = fields.joint_pain == null ? "" : String(fields.joint_pain).trim();
    if (spoken) {
      try {
        recordSymptomReport({
          text: spoken,
          source_kind: "session_feedback",
          reported_on: date || localDateISO(),
          session_id: session.id,
        });
      } catch {
        /* additive capture — never fail the feedback write over it */
      }
    }
  }
  if (sets.length) {
    vals.push(session.id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    bumpTrainingDataVersion(); // soreness/performance bends the program-state deload read
    emitBrainEvent({
      kind: "session_feedback",
      domain: "training",
      date: date || localDateISO(),
      entity_id: session.id,
      subject_key: `session:${session.id}`,
      reason: fields.joint_pain ? "joint discomfort reported" : "session feedback updated",
      material:
        (fields.performance != null && Number(fields.performance) <= 2) ||
        Number(fields.soreness) >= 4 ||
        !!String(fields.joint_pain ?? "").trim(),
    });
  }
  // A fresh 1-tap soreness/performance/joint signal is a day-read input (its sibling
  // addCheckin already busts the Brief) — refresh so today's read reflects it.
  // Deliberately UNCONDITIONAL: joint pain and a low performance flag reach the
  // fingerprint only INDIRECTLY, through whatever posture/directives the signal
  // state derives from them, and "the Brief was blind to logged joint pain" is a bug
  // this codebase has already shipped once. A one-tap feedback write is rare, so the
  // guard would buy nothing and risk re-opening that. Same for the athlete's steer.
  invalidateDayRead(date || localDateISO());
  // Stage 4: feedback is a reconciliation confounder (joint pain / soreness /
  // performance) — refresh the outcome so it reflects the reported signal.
  reconcileDailySessionSafe(session.id);
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
  const d = date || localDateISO();
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
        date: d,
        exercise: name,
        session_id: session.id,
        skips: skipsForSession(session.id),
      };
    }
  }
  const inserted = db
    .prepare(`INSERT OR IGNORE INTO session_skips (session_id, exercise) VALUES (?, ?)`)
    .run(session.id, name).changes;
  if (inserted) {
    emitBrainEvent({
      kind: "exercise_skipped",
      domain: "training",
      date: d,
      entity_id: session.id,
      subject_key: name,
    });
    reconcileDailySessionSafe(session.id);
  }
  return { ok: true as const, date: d, exercise: name, session_id: session.id, skips: skipsForSession(session.id) };
}

export function unskipExercise(exercise: string, date?: string) {
  const d = date || localDateISO();
  const name = exercise.trim();
  const s = getAuthoritativeSessionRow(d);
  if (!s) {
    return {
      ok: true as const,
      date: d,
      exercise: name,
      session_id: null,
      removed: 0,
      skips: [] as string[],
    };
  }
  const removed = db.prepare(`DELETE FROM session_skips WHERE session_id = ? AND exercise = ?`).run(s.id, name).changes;
  if (removed) reconcileDailySessionSafe(s.id);
  return {
    ok: true as const,
    date: d,
    exercise: name,
    session_id: s.id,
    removed,
    skips: skipsForSession(s.id),
  };
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
  day_number?: number | null;
  note?: string;
}

function insertSetByName(input: LogSetInput, emitEffects: boolean) {
  const date = input.date || localDateISO();
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
    .run(
      session.id,
      ex.id,
      setNumber,
      input.weight ?? null,
      input.reps ?? null,
      input.rir ?? null,
      input.note ?? null,
      input.duration_sec ?? null
    );

  if (emitEffects) {
    bumpTrainingDataVersion(); // a new logged set moves lifts/volume/weekly reads
    // The FIRST set of the day flips "trained today" and later ones can push the
    // day's grade up, both of which move the decision fingerprint and refresh the
    // Brief. The twelfth set of a session already read as done moves neither, and
    // used to buy a fresh ~90s agent run anyway — hence the guarded form.
    invalidateDayReadIfDecisionChanged(date);
    emitBrainEvent({
      kind: "set_logged",
      domain: "training",
      date,
      entity_id: session.id,
      subject_key: ex.name,
    });
  }

  // PR check. Reps exercises: a new all-time est-1RM (Epley). Timed exercises:
  // strictly beating the previous max duration; est_1rm stays null for timed.
  let pr = false;
  let est_1rm: number | null = null;
  if (ex.mode === "timed") {
    if ((input.duration_sec ?? 0) > 0) {
      const prev = db
        .prepare(
          `SELECT MAX(duration_sec) AS m FROM logged_sets WHERE exercise_id = ? AND id != ? AND duration_sec IS NOT NULL`
        )
        .get(ex.id, info.lastInsertRowid) as any;
      pr = input.duration_sec! > (prev?.m ?? 0);
    }
  } else if ((input.weight ?? 0) > 0 && (input.reps ?? 0) > 0) {
    est_1rm = epley1RM(input.weight!, input.reps!);
    const prev = db
      .prepare(`SELECT weight, reps FROM logged_sets WHERE exercise_id = ? AND id != ? AND weight > 0 AND reps > 0`)
      .all(ex.id, info.lastInsertRowid) as any[];
    // Shared with sessionHighlights' read-time PR recompute (best Epley est-1RM over
    // loaded working sets) so the two paths can never drift subtly apart.
    const prevBest = bestE1rm(prev);
    pr = est_1rm > prevBest;
    if (emitEffects) completeStrengthObjectiveFromLoggedSet({ exercise: ex.name, est_1rm, date });
  }

  if (emitEffects) reconcileDailySessionSafe(session.id);

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

export function logSetByName(input: LogSetInput) {
  return insertSetByName(input, true);
}

export interface GarminSetImportInput {
  exercise: string;
  weight?: number | null;
  reps?: number | null;
  duration_sec?: number | null;
  exercise_mode?: "reps" | "timed";
}

export interface GarminSetImportResult {
  authority: boolean | null;
  imported: number;
  already_imported: boolean;
}

// Atomically claim set authority for one Garmin activity, write its complete set
// batch, and append its idempotency key to the session ledger. A pending session
// (no boolean marker) only becomes watch-authoritative when at least one usable set
// is successfully committed. If a Cairn set arrived first, Cairn wins instead.
export function importGarminActivitySets(input: {
  session_id: number;
  date: string;
  activity_key: string;
  sets: GarminSetImportInput[];
}): GarminSetImportResult {
  const sessionId = Number(input.session_id);
  const date = String(input.date || "").trim();
  const activityKey = String(input.activity_key || "").trim();
  const sets = Array.isArray(input.sets) ? input.sets : [];
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error("valid session_id required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("valid date required");
  if (!activityKey) throw new Error("activity_key required");

  const savepoint = "garmin_set_import";
  let result: GarminSetImportResult = { authority: null, imported: 0, already_imported: false };
  let firstExercise: string | null = null;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const session = db.prepare(`SELECT id, date, garmin_json FROM sessions WHERE id = ?`).get(sessionId) as any;
    if (!session) throw new Error(`No session ${sessionId}`);
    if (String(session.date) !== date) throw new Error(`Session ${sessionId} is not on ${date}`);

    let garmin: any = {};
    try {
      garmin = session.garmin_json ? JSON.parse(session.garmin_json) : {};
    } catch {
      garmin = {};
    }
    if (!garmin || typeof garmin !== "object" || Array.isArray(garmin)) garmin = {};
    const importedIds = Array.isArray(garmin.imported_set_activity_ids)
      ? [...new Set<string>(garmin.imported_set_activity_ids.map((id: any) => String(id)).filter(Boolean))]
      : [];
    const storedAuthority =
      typeof garmin.cairn_sets_authoritative === "boolean" ? garmin.cairn_sets_authoritative : null;
    const alreadyImported = importedIds.includes(activityKey);
    const setCount = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE session_id = ?`).get(sessionId) as any)?.n ?? 0
    );

    if (storedAuthority === true || (storedAuthority === null && setCount > 0)) {
      if (storedAuthority !== true) {
        garmin.cairn_sets_authoritative = true;
        db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(garmin), sessionId);
      }
      result = { authority: true, imported: 0, already_imported: alreadyImported };
    } else if (alreadyImported) {
      result = { authority: storedAuthority, imported: 0, already_imported: true };
    } else if (sets.length === 0) {
      // An empty or unusable Garmin payload is not evidence that Garmin owns sets.
      // Keep a markerless session pending so a later Cairn log can still win.
      result = { authority: storedAuthority, imported: 0, already_imported: false };
    } else {
      for (const set of sets) {
        const logged = insertSetByName({ ...set, date }, false);
        if (Number(logged.session_id) !== sessionId) {
          throw new Error(`Garmin set landed in unexpected session ${logged.session_id}`);
        }
        firstExercise ??= logged.exercise;
        result.imported++;
      }
      garmin.cairn_sets_authoritative = false;
      garmin.extrapolated = true;
      garmin.imported_set_activity_ids = [...new Set([...importedIds, activityKey])].slice(-32);
      db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(garmin), sessionId);
      result.authority = false;
    }
    db.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${savepoint}`);
    } finally {
      db.exec(`RELEASE ${savepoint}`);
    }
    throw error;
  }

  if (result.imported > 0) {
    bumpTrainingDataVersion();
    // Same shape as hand-logging, and re-syncs must stay idempotent: an import that
    // re-derives the same session must not retire the day's read a second time.
    invalidateDayReadIfDecisionChanged(date);
    emitBrainEvent({
      kind: "set_logged",
      domain: "training",
      date,
      entity_id: sessionId,
      subject_key: firstExercise,
    });
    reconcileDailySessionSafe(sessionId);
  }
  return result;
}

export function deleteSet(id: number) {
  // LEFT JOIN: the date is what the day-read cache is keyed by, but an orphaned set
  // must still reach reconcileDailySessionSafe exactly as it did before.
  const existing = db
    .prepare(
      `SELECT ls.session_id AS session_id, s.date AS date
         FROM logged_sets ls LEFT JOIN sessions s ON s.id = ls.session_id
        WHERE ls.id = ?`
    )
    .get(id) as any;
  const deleted = db.prepare(`DELETE FROM logged_sets WHERE id = ?`).run(id).changes;
  if (deleted) {
    bumpTrainingDataVersion();
    // Removing a set is a training-log write like any other, and it was the one that
    // never reached the Brief at all: deleting the LAST set of the day flips
    // trained_today and the day's grade back, so a `done` read stayed cached on a day
    // with no work left in it until something unrelated invalidated. Guarded like its
    // siblings, so removing one of many sets — which moves neither the fact nor the
    // grade — still costs nothing.
    if (existing?.date) invalidateDayReadIfDecisionChanged(String(existing.date));
    if (existing?.session_id != null) reconcileDailySessionSafe(Number(existing.session_id));
  }
  return { deleted };
}

// Edit a single logged set after the fact (history correction: a mistyped weight,
// a wrong rep count). Only the fields provided are touched; numeric fields coerce,
// note trims/caps. Returns the refreshed set row (with exercise name), or null on
// an unknown id. The connected brain (trainingSignals) re-reads logged_sets on
// every coach prompt, so a correction flows into future planning with no extra step.
export function updateSet(
  id: number,
  fields: {
    weight?: number | null;
    reps?: number | null;
    rir?: number | null;
    note?: string | null;
    duration_sec?: number | null;
  }
) {
  const cur = db
    .prepare(
      `SELECT ls.id, ls.session_id, e.name AS exercise, s.date AS date
       FROM logged_sets ls
       JOIN exercises e ON e.id=ls.exercise_id
       JOIN sessions s ON s.id=ls.session_id
      WHERE ls.id=?`
    )
    .get(id) as any;
  if (!cur) return null;
  const num = (v: any): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.weight !== undefined) {
    sets.push("weight = ?");
    vals.push(num(fields.weight));
  }
  if (fields.reps !== undefined) {
    sets.push("reps = ?");
    vals.push(num(fields.reps));
  }
  if (fields.rir !== undefined) {
    sets.push("rir = ?");
    vals.push(num(fields.rir));
  }
  if (fields.duration_sec !== undefined) {
    sets.push("duration_sec = ?");
    vals.push(num(fields.duration_sec));
  }
  if (fields.note !== undefined) {
    sets.push("note = ?");
    vals.push(fields.note == null ? null : String(fields.note).trim().slice(0, 500) || null);
  }
  if (sets.length) {
    db.exec("SAVEPOINT update_set_correction");
    try {
      vals.push(id);
      db.prepare(`UPDATE logged_sets SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      if (fields.weight !== undefined || fields.reps !== undefined) {
        reconcileStrengthObjectiveFromLoggedSets({ exercise: cur.exercise, preferred_date: cur.date });
      }
      db.exec("RELEASE update_set_correction");
    } catch (error) {
      try {
        db.exec("ROLLBACK TO update_set_correction");
      } finally {
        db.exec("RELEASE update_set_correction");
      }
      throw error;
    }
    bumpTrainingDataVersion(); // an in-place set correction the SQL backstop can't see
    reconcileDailySessionSafe(Number(cur.session_id));
  }
  return db
    .prepare(
      `SELECT ls.*, e.name AS exercise, e.mode AS mode FROM logged_sets ls
     JOIN exercises e ON e.id = ls.exercise_id WHERE ls.id = ?`
    )
    .get(id);
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

// ---------- endurance PRs (v35; sport-aware) ----------
// The endurance analogue to the Epley est-1RM: best efforts from the logged cardio
// (the `activities` table). Deterministic, null-safe — no agent. PLAIN numbers,
// never a score.
//
// Bests are grouped BY SPORT, because a best is only meaningful within its modality:
// a cyclist's "3:53/km" is just speed inverted and reads as a nonsense running PR
// next to an actual run. So PACE bests (min/km at standard distances) are computed
// only for foot sports (run/walk); cycling/swim/row get SPEED (km/h) + the longest
// distance/duration instead. `sports` is ordered with the athlete's primary
// endurance sport first (profile `endurance_sport`, default running), then by how
// much they've logged. The flat top-level fields mirror that lead sport for
// back-compat with older callers.
export interface SportBests {
  sport: string; // canonical key: "run" | "walk" | "ride" | "swim" | "row" | <raw>
  label: string; // display label, e.g. "Running" / "Cycling"
  count: number; // # of logged efforts with distance or duration (relevance/ordering)
  paced: boolean; // pace (min/km) is the meaningful metric for this sport
  longest_km: { value: number; date: string; type: string } | null;
  longest_min: { value: number; date: string; type: string } | null;
  best_pace: { distance_km: number; min_per_km: number; date: string; type: string }[]; // paced sports only
  best_speed_kmh: { value: number; date: string; type: string } | null; // non-paced sports only
}
export interface EndurancePRs {
  type: string | null;
  primary_sport: string | null;
  sports: SportBests[];
  // Back-compat flat fields = the lead sport's bests (nulls/[] when nothing logged).
  longest_km: SportBests["longest_km"];
  longest_min: SportBests["longest_min"];
  best_pace: SportBests["best_pace"];
}

const PR_DISTANCES_KM = [1, 5, 10, 21.0975, 42.195];

function computeSportBests(key: string, label: string, paced: boolean, rows: any[]): SportBests {
  let longest_km: SportBests["longest_km"] = null;
  let longest_min: SportBests["longest_min"] = null;
  let best_speed: SportBests["best_speed_kmh"] = null;
  // Best pace (min/km) achieved at or beyond each standard distance — a longer effort
  // counts toward a shorter PR distance (you covered it en route).
  const bestPace = new Map<number, { min_per_km: number; date: string; type: string }>();
  let count = 0;

  for (const r of rows) {
    const km = Number(r.distance_km);
    const min = Number(r.duration_min);
    const rowType = String(r.type ?? "activity");
    const hasKm = Number.isFinite(km) && km > 0;
    const hasMin = Number.isFinite(min) && min > 0;
    if (hasKm || hasMin) count++;
    if (hasKm && (!longest_km || km > longest_km.value))
      longest_km = { value: Math.round(km * 100) / 100, date: r.date, type: rowType };
    if (hasMin && (!longest_min || min > longest_min.value))
      longest_min = { value: Math.round(min), date: r.date, type: rowType };
    // A pace/speed PR needs BOTH distance and duration.
    if (hasKm && hasMin) {
      if (paced) {
        const pace = min / km; // min/km (lower is faster)
        for (const dist of PR_DISTANCES_KM) {
          if (km + 1e-9 < dist) continue; // effort didn't reach this distance
          const cur = bestPace.get(dist);
          if (!cur || pace < cur.min_per_km)
            bestPace.set(dist, { min_per_km: Math.round(pace * 100) / 100, date: r.date, type: rowType });
        }
      } else {
        const kmh = (km / min) * 60; // km/h (higher is faster) — the metric riders read
        if (!best_speed || kmh > best_speed.value)
          best_speed = { value: Math.round(kmh * 10) / 10, date: r.date, type: rowType };
      }
    }
  }

  const best_pace = [...bestPace.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([distance_km, v]) => ({ distance_km, min_per_km: v.min_per_km, date: v.date, type: v.type }));

  return {
    sport: key,
    label,
    count,
    paced,
    longest_km,
    longest_min,
    best_pace,
    best_speed_kmh: paced ? null : best_speed,
  };
}

export function getEndurancePRs(type?: string | null): EndurancePRs {
  const t = type != null && String(type).trim() ? String(type).trim().toLowerCase() : null;
  const rows = (
    t
      ? db
          .prepare(
            `SELECT date, type, distance_km, duration_min FROM activities
         WHERE lower(COALESCE(type,'')) = ? AND (distance_km IS NOT NULL OR duration_min IS NOT NULL)
         ORDER BY date`
          )
          .all(t)
      : db
          .prepare(
            `SELECT date, type, distance_km, duration_min FROM activities
         WHERE (distance_km IS NOT NULL OR duration_min IS NOT NULL) ORDER BY date`
          )
          .all()
  ) as any[];

  // Bucket every effort into its canonical sport, then compute that sport's own bests.
  const groups = new Map<string, { label: string; paced: boolean; rows: any[] }>();
  for (const r of rows) {
    const sp = canonicalEnduranceSport(r.type);
    let g = groups.get(sp.key);
    if (!g) {
      g = { label: sp.label, paced: sp.paced, rows: [] };
      groups.set(sp.key, g);
    }
    g.rows.push(r);
  }

  // Lead with the athlete's primary endurance sport (so a runner sees running first),
  // then the most-logged remaining sports.
  const primaryKey = canonicalEnduranceSport(getProfile()?.endurance_sport || "running").key;
  const sports = [...groups.entries()]
    .map(([key, g]) => computeSportBests(key, g.label, g.paced, g.rows))
    .filter((s) => s.count > 0)
    .sort((a, b) => {
      const ap = a.sport === primaryKey ? 1 : 0;
      const bp = b.sport === primaryKey ? 1 : 0;
      if (ap !== bp) return bp - ap; // primary sport first
      if (b.count !== a.count) return b.count - a.count; // then most-logged
      return a.label.localeCompare(b.label);
    });

  const lead = sports[0] ?? null;
  return {
    type: t,
    primary_sport: primaryKey,
    sports,
    longest_km: lead?.longest_km ?? null,
    longest_min: lead?.longest_min ?? null,
    best_pace: lead?.best_pace ?? [],
  };
}

// Compact dashboard: training days + tonnage over the last 7 days, plus a
// consistency streak (consecutive days with a logged session or activity).
//
// MEMOIZED (repo/training-cache.ts): a single Today render calls this up to ~6×
// (routes /stats + /today, twice inside healthStanding, three producers in
// todayAgenda). It's a pure function of the logged training/weigh-in/plan data for
// a date, so memoize on (date, training version + SQL backstop) and serve a
// structuredClone. Single-slot — the hot path is always `today`.
let weeklyStatsCache: { key: string; value: WeeklyStats } | null = null;
registerTrainingCacheClear(() => {
  weeklyStatsCache = null;
});

type WeeklyStats = ReturnType<typeof computeWeeklyStats>;

export function getWeeklyStats(date?: string): WeeklyStats {
  const requested = String(date || "").slice(0, 10);
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : localDateISO();
  const key = `${anchor}|${currentTrainingDataVersion()}|${trainingBackstopSignature()}`;
  if (weeklyStatsCache && weeklyStatsCache.key === key) return structuredClone(weeklyStatsCache.value);
  const value = computeWeeklyStats(date);
  weeklyStatsCache = { key, value };
  return structuredClone(value);
}

function computeWeeklyStats(date?: string) {
  const requested = String(date || "").slice(0, 10);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : localDateISO();
  // Anchor the rolling windows to LOCAL today (the same anchor the streak/Monday
  // math below uses), not the UTC instant — sessions are keyed by local date, so a
  // UTC-anchored cutoff could clip the trailing day in an evening western zone.
  const asOf = new Date(today + "T00:00:00Z").getTime();
  const weekAgo = new Date(asOf - 6 * 864e5).toISOString().slice(0, 10);
  const sixtyAgo = new Date(asOf - 60 * 864e5).toISOString().slice(0, 10);

  const weekSess = db
    .prepare(
      `SELECT DISTINCT s.date FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ? AND s.date <= ?`
    )
    .all(weekAgo, today) as any[];
  const ton = db
    .prepare(
      `SELECT COALESCE(SUM(l.weight * l.reps), 0) AS t FROM logged_sets l JOIN sessions s ON s.id = l.session_id
       WHERE s.date >= ? AND s.date <= ? AND l.weight > 0 AND l.reps > 0`
    )
    .get(weekAgo, today) as any;
  // ALL logged sets count here — including timed sets, which the tonnage math
  // above intentionally excludes (weight > 0 AND reps > 0).
  const weekSets = db
    .prepare(
      `SELECT COUNT(*) AS c FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date >= ? AND s.date <= ?`
    )
    .get(weekAgo, today) as any;

  const sessDates = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT s.date AS d FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ? AND s.date <= ?`
        )
        .all(sixtyAgo, today) as any[]
    ).map((r) => r.d)
  );
  const actDates = new Set(
    (
      db
        .prepare(`SELECT DISTINCT date AS d FROM activities WHERE date >= ? AND date <= ?`)
        .all(sixtyAgo, today) as any[]
    ).map((r) => r.d)
  );
  const active = (d: string) => sessDates.has(d) || actDates.has(d);
  let streak = 0;
  let t = new Date(today + "T00:00:00Z").getTime();
  if (!active(today)) t -= 864e5; // grace: an unbroken streak can end yesterday
  while (active(new Date(t).toISOString().slice(0, 10))) {
    streak++;
    t -= 864e5;
  }

  // --- compass: plan adherence this calendar week + weight-trend pace vs goal ---
  // Monday-start week (the plan is weekly; the rolling-7d "sessions" count
  // reads as a vanity number, adherence-to-plan is the honest version).
  const monday = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const nextMonday = new Date(new Date(monday + "T00:00:00Z").getTime() + 7 * 864e5).toISOString().slice(0, 10);
  const weekDone = db
    .prepare(
      `SELECT COUNT(DISTINCT s.date) AS c FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ? AND s.date < ?`
    )
    .get(monday, nextMonday) as any;
  const weekPlanned = db.prepare(`SELECT COUNT(*) AS c FROM plan_days`).get() as any;
  // Cardio this week (activities table) — so the "This Week" summary speaks to
  // BOTH modalities, not just lifting adherence. Count + total distance.
  const weekCardio = db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(distance_km), 0) AS km FROM activities WHERE date >= ? AND date < ?`)
    .get(monday, nextMonday) as any;

  // ---- endurance weekly read (v35, additive) ----
  // A runner/cyclist-first picture: mileage, moving time, the longest single
  // effort, time-in-HR-zone (from synced Garmin activities), and a pace trend.
  // All deterministic + null-safe. The `activities` table is the source-agnostic
  // log; `garmin_activities` adds richer per-effort detail (zones, moving time).
  const endurance = computeEnduranceWeekly(monday, nextMonday);

  // Weight trend: least-squares slope over the last 21 days of weigh-ins,
  // in lb/week. Needs ≥2 points spanning ≥3 days to mean anything.
  const since21 = new Date(asOf - 21 * 864e5).toISOString().slice(0, 10);
  const wpts = canonicalBodyweightSeries({ since: since21, through: today });
  let trend: number | null = null;
  if (wpts.length >= 2) {
    const xs = wpts.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
    const ys = wpts.map((p) => Number(p.weight_lb));
    if (xs[xs.length - 1] - xs[0] >= 3) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0,
        den = 0;
      for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
      }
      if (den > 0) trend = Math.round((num / den) * 7 * 10) / 10; // lb/day → lb/wk
    }
  }

  const prof = db
    .prepare(`SELECT weight_lb, goal_weight_lb, goal_date, goal_mode FROM profile WHERE id = 1`)
    .get() as any;
  const currentW = resolvedCurrentBodyweight(prof, today)?.weight_lb ?? null;
  const goalMode = effectiveGoalMode(currentW == null ? prof : { ...prof, weight_lb: currentW });

  // Pace verdict, in the LANGUAGE of the goal mode — never "behind" when you're
  // just maintaining (the constitution: kind, never anxious). Plain words, no score:
  //   lose     → on / behind / fast (fast = losing >~1%/wk, the lean-safe ceiling)
  //   maintain → holding / drifting_up / drifting_down (a calm dead-band, no pressure)
  //   gain     → on / behind / fast (fast = gaining >~1%/wk, i.e. fat-biased)
  let needed: number | null = null;
  let pace: "on" | "behind" | "fast" | "holding" | "drifting_up" | "drifting_down" | null = null;
  if (goalMode === "maintain") {
    needed = 0;
    if (trend != null) {
      const band = 0.3; // lb/wk — within this you're holding steady
      pace = trend > band ? "drifting_up" : trend < -band ? "drifting_down" : "holding";
    }
  } else if (goalMode === "gain") {
    // Conservative lean-gain rate — shared with computeGoalCheck (single source).
    const gainRate = currentW != null ? leanGainRate(currentW) : 0.25;
    needed = gainRate;
    if (trend != null && currentW != null) {
      const tooFast = currentW * 0.01; // >1% bodyweight/wk gain is fat-biased
      if (trend > tooFast) pace = "fast";
      else if (trend >= gainRate - 0.15)
        pace = "on"; // building at/above the lean rate
      else pace = "behind"; // not building yet
    }
  } else {
    // lose
    if (prof?.goal_weight_lb != null && prof?.goal_date && currentW != null) {
      const weeksLeft = Math.max((Date.parse(prof.goal_date) - Date.parse(today)) / (7 * 864e5), 0.5);
      needed = Math.round(((prof.goal_weight_lb - currentW) / weeksLeft) * 10) / 10;
    }
    if (trend != null && needed != null && currentW != null) {
      const maxSafe = currentW * 0.01;
      if (needed < 0 && trend < -maxSafe) pace = "fast";
      else if (needed < 0 ? trend <= needed + 0.25 : trend >= needed - 0.25) pace = "on";
      else pace = "behind";
    }
  }

  return {
    week_sessions: weekSess.length,
    week_tonnage: Math.round(ton.t || 0),
    week_sets: Number(weekSets?.c ?? 0),
    streak,
    week_done: Number(weekDone?.c ?? 0),
    week_planned: Number(weekPlanned?.c ?? 0),
    week_cardio: Number(weekCardio?.c ?? 0),
    week_cardio_km: Math.round(Number(weekCardio?.km ?? 0) * 10) / 10,
    trend_lb_wk: trend,
    needed_lb_wk: needed,
    pace_status: pace,
    goal_mode: goalMode,
    weight_lb: currentW,
    goal_weight_lb: prof?.goal_weight_lb ?? null,
    goal_date: prof?.goal_date ?? null,
    // Endurance/runner-first weekly read (v35) — additive; existing consumers ignore.
    endurance,
  };
}

// Endurance weekly stats (v35). Deterministic, null-safe. Mileage + moving time
// from the source-agnostic `activities` log; longest single effort; time-in-HR-zone
// rolled up from synced `garmin_activities` (hr_zones_json); and a pace trend — this
// week's avg pace (min/km) vs the prior week's, in plain words. Everything degrades to
// nulls/empties when there's no endurance data, never throwing.
export interface EnduranceWeekly {
  // Backward-compatible RUNNING fields. Cross-training never inflates these.
  week_km: number;
  week_moving_min: number;
  longest_km: number | null;
  longest_min: number | null;
  longest_type: string | null;
  time_in_zone: Record<string, number>; // { Z1: secs, Z2: secs, … } from Garmin, when present
  total_moving_min: number;
  total_sessions: number;
  by_sport: Record<string, EnduranceSportWeek>;
  provenance: { distance: "activities"; load: "garmin_activities" };
  pace_trend: {
    this_min_per_km: number | null;
    prev_min_per_km: number | null;
    dir: "faster" | "slower" | "steady" | null;
  };
}

export interface EnduranceSportWeek {
  sport: string;
  label: string;
  sessions: number;
  distance_km: number;
  moving_min: number;
  longest_km: number | null;
  longest_min: number | null;
  last_date: string | null;
  sources: string[];
  training_load: number | null;
  quality_sessions: number;
  time_in_zone: Record<string, number>;
}

function computeEnduranceWeekly(mondayISO: string, nextMondayISO?: string): EnduranceWeekly {
  const prevMonday = new Date(new Date(mondayISO + "T00:00:00Z").getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const weekEnd =
    nextMondayISO || new Date(new Date(mondayISO + "T00:00:00Z").getTime() + 7 * 864e5).toISOString().slice(0, 10);

  type MutableSportWeek = EnduranceSportWeek & { sourceSet: Set<string> };
  const bySport = new Map<string, MutableSportWeek>();
  const sportWeek = (type: unknown): MutableSportWeek => {
    const sport = canonicalEnduranceSport(type);
    let row = bySport.get(sport.key);
    if (!row) {
      row = {
        sport: sport.key,
        label: sport.label,
        sessions: 0,
        distance_km: 0,
        moving_min: 0,
        longest_km: null,
        longest_min: null,
        last_date: null,
        sources: [],
        sourceSet: new Set(),
        training_load: null,
        quality_sessions: 0,
        time_in_zone: {},
      };
      bySport.set(sport.key, row);
    }
    return row;
  };

  // Activities are the source of truth for distance/session volume. Keep each
  // modality separate: 30 km of MTB is useful load evidence, but never 30 km of
  // running base.
  const activityRows = db
    .prepare(`SELECT date, type, distance_km, duration_min, source FROM activities WHERE date >= ? AND date < ?`)
    .all(mondayISO, weekEnd) as any[];
  for (const activity of activityRows) {
    if (isStrengthGarminType(activity.type)) continue;
    const row = sportWeek(activity.type);
    const km = Number(activity.distance_km);
    const min = Number(activity.duration_min);
    row.sessions++;
    if (Number.isFinite(km) && km > 0) {
      row.distance_km += km;
      row.longest_km = row.longest_km == null ? km : Math.max(row.longest_km, km);
    }
    if (Number.isFinite(min) && min > 0) {
      row.moving_min += min;
      row.longest_min = row.longest_min == null ? min : Math.max(row.longest_min, min);
    }
    const date = String(activity.date ?? "").slice(0, 10);
    if (date && (!row.last_date || date > row.last_date)) row.last_date = date;
    row.sourceSet.add(String(activity.source || "manual"));
  }

  // Garmin adds physiological load provenance. It enriches the matching sport
  // bucket without changing activity distance/session totals.
  const garminRows = db
    .prepare(
      `SELECT date, type, training_load, te_label, aerobic_te, anaerobic_te, hr_zones_json
         FROM garmin_activities WHERE date >= ? AND date < ?`
    )
    .all(mondayISO, weekEnd) as any[];
  for (const r of garminRows) {
    if (isStrengthGarminType(r.type)) continue;
    const row = sportWeek(r.type);
    row.sourceSet.add("garmin");
    const trainingLoad = Number(r.training_load);
    if (Number.isFinite(trainingLoad) && trainingLoad > 0) {
      row.training_load = Math.round(((row.training_load ?? 0) + trainingLoad) * 10) / 10;
    }
    const quality =
      /TEMPO|THRESHOLD|VO2MAX|ANAEROBIC|LACTATE/i.test(String(r.te_label ?? "")) ||
      Number(r.anaerobic_te ?? 0) >= 2 ||
      Number(r.aerobic_te ?? 0) >= 3;
    if (quality) row.quality_sessions++;
    let zones: any = null;
    try {
      zones = r.hr_zones_json ? JSON.parse(r.hr_zones_json) : null;
    } catch {
      zones = null;
    }
    if (!Array.isArray(zones)) continue;
    for (const z of zones) {
      const label = z?.zone != null ? `Z${z.zone}` : z?.label != null ? String(z.label) : null;
      const secs = Number(z?.secs ?? z?.seconds ?? z?.secsInZone);
      if (!label || !Number.isFinite(secs) || secs <= 0) continue;
      row.time_in_zone[label] = Math.round((row.time_in_zone[label] ?? 0) + secs);
    }
  }

  const normalizedBySport: Record<string, EnduranceSportWeek> = {};
  for (const [key, row] of bySport) {
    const { sourceSet, ...publicRow } = row;
    normalizedBySport[key] = {
      ...publicRow,
      distance_km: Math.round(row.distance_km * 10) / 10,
      moving_min: Math.round(row.moving_min),
      longest_km: row.longest_km == null ? null : Math.round(row.longest_km * 10) / 10,
      longest_min: row.longest_min == null ? null : Math.round(row.longest_min),
      sources: [...sourceSet].sort(),
    };
  }
  const run = normalizedBySport.run ?? null;
  const week_km = run?.distance_km ?? 0;
  const week_moving_min = run?.moving_min ?? 0;
  const longest_km = run?.longest_km ?? null;
  const longest_min = run?.longest_min ?? null;
  const longest_type = run ? "run" : null;
  const time_in_zone = run?.time_in_zone ?? {};
  const total_moving_min = Math.round([...bySport.values()].reduce((sum, row) => sum + row.moving_min, 0));
  const total_sessions = [...bySport.values()].reduce((sum, row) => sum + row.sessions, 0);

  // Pace trend: avg pace (min/km) this week vs the prior week, from activities that
  // carry BOTH distance and duration. Lower min/km = faster. Plain direction word.
  // SCOPED to the athlete's endurance sport (default running) — a bike ride's speed
  // mixed into a "min/km" average reads as a nonsense running pace.
  const sport = activitySportWhere("activities", ["run", "running", "jog", "jogging"]);
  const avgPace = (startIso: string, endIso?: string): number | null => {
    const rows = end(startIso, endIso);
    let km = 0,
      min = 0;
    for (const r of rows) {
      const dk = Number(r.distance_km),
        dm = Number(r.duration_min);
      if (Number.isFinite(dk) && dk > 0 && Number.isFinite(dm) && dm > 0) {
        km += dk;
        min += dm;
      }
    }
    return km > 0 ? Math.round((min / km) * 100) / 100 : null;
  };
  function end(startIso: string, endIso?: string): any[] {
    return endIso
      ? (db
          .prepare(`SELECT distance_km, duration_min FROM activities WHERE date >= ? AND date < ? AND (${sport.sql})`)
          .all(startIso, endIso, ...sport.params) as any[])
      : (db
          .prepare(`SELECT distance_km, duration_min FROM activities WHERE date >= ? AND (${sport.sql})`)
          .all(startIso, ...sport.params) as any[]);
  }
  const this_min_per_km = avgPace(mondayISO, weekEnd);
  const prev_min_per_km = avgPace(prevMonday, mondayISO);
  let dir: "faster" | "slower" | "steady" | null = null;
  if (this_min_per_km != null && prev_min_per_km != null) {
    const delta = this_min_per_km - prev_min_per_km;
    dir = Math.abs(delta) < 0.1 ? "steady" : delta < 0 ? "faster" : "slower";
  }

  return {
    week_km,
    week_moving_min,
    longest_km,
    longest_min,
    longest_type,
    time_in_zone,
    total_moving_min,
    total_sessions,
    by_sport: normalizedBySport,
    provenance: { distance: "activities", load: "garmin_activities" },
    pace_trend: { this_min_per_km, prev_min_per_km, dir },
  };
}

// ---------- run compliance (closing the runner loop) ----------
// Prescribed (from the CURRENT plan's cardio items) vs. actual (this week's logged
// cardio efforts), in plain language. Deterministic + null-safe — no agent. This
// is the endurance analogue of week_done/week_planned for lifting: did the runs
// the plan asked for actually happen? Constitution: a RATIO in plain words
// ("32 of 40 km this week") is fine; a 0-100 score is NOT — `pct_km` stays an
// internal proportion the UI may render as a ratio/bar, never a grade.
//
// Prescribed: every RUN cardio plan item (kind==='cardio' across getPlan() days) —
// count = number of cardio items, km/min summed (nulls skipped). The plan is
// weekly, so the full template IS this week's prescription.
// Actual: this week (Monday-anchored, same as computeEnduranceWeekly, or an
// explicit weekStartISO) from RUN activities only. Cross-training is reported in
// endurance.by_sport, but a ride/swim/hike can never satisfy a run prescription.
export interface RunCompliance {
  prescribed_sessions: number;
  prescribed_km: number;
  prescribed_min: number;
  actual_sessions: number;
  actual_km: number;
  actual_min: number;
  pct_km: number | null; // actual_km / prescribed_km when prescribed_km>0, else null — a proportion, never a 0-100 grade
  in_words: string;
}

export function getRunCompliance(weekStartISO?: string): RunCompliance {
  // Monday-anchored week start (mirror computeEnduranceWeekly / getWeeklyStats).
  const monday =
    weekStartISO ||
    (() => {
      const d = new Date(localDateISO() + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
  const nextMonday = new Date(new Date(monday + "T00:00:00Z").getTime() + 7 * 864e5).toISOString().slice(0, 10);

  // Prescribed: the current plan's cardio items.
  let prescribed_sessions = 0;
  let prescribed_km = 0;
  let prescribed_min = 0;
  for (const day of getPlan() as any[]) {
    for (const it of day.items || []) {
      if (it.kind !== "cardio") continue;
      if (canonicalEnduranceSport(`${it.exercise || ""} ${it.note || ""}`).key !== "run") continue;
      prescribed_sessions++;
      const km = Number(it.target_distance_km);
      const min = Number(it.target_duration_min);
      if (Number.isFinite(km) && km > 0) prescribed_km += km;
      if (Number.isFinite(min) && min > 0) prescribed_min += min;
    }
  }
  prescribed_km = Math.round(prescribed_km * 10) / 10;
  prescribed_min = Math.round(prescribed_min);

  // Actual: this week's logged RUN efforts only.
  const rows = db
    .prepare(`SELECT type, distance_km, duration_min FROM activities WHERE date >= ? AND date < ?`)
    .all(monday, nextMonday) as any[];
  let actual_sessions = 0;
  let actual_km = 0;
  let actual_min = 0;
  for (const r of rows) {
    if (canonicalEnduranceSport(r.type).key !== "run") continue;
    actual_sessions++;
    const km = Number(r.distance_km);
    const min = Number(r.duration_min);
    if (Number.isFinite(km) && km > 0) actual_km += km;
    if (Number.isFinite(min) && min > 0) actual_min += min;
  }
  actual_km = Math.round(actual_km * 10) / 10;
  actual_min = Math.round(actual_min);

  const pct_km = prescribed_km > 0 ? Math.round((actual_km / prescribed_km) * 100) / 100 : null;

  // Plain-language summary — a ratio, never a grade. Prefer distance (the runner's
  // native unit); fall back to session count when there's no prescribed mileage.
  let in_words: string;
  if (prescribed_sessions === 0) {
    in_words =
      actual_sessions > 0
        ? `${actual_sessions} run${actual_sessions === 1 ? "" : "s"} this week, none prescribed`
        : "no runs prescribed this week";
  } else if (prescribed_km > 0) {
    in_words = `${actual_km} of ${prescribed_km} km this week`;
  } else {
    in_words = `${actual_sessions} of ${prescribed_sessions} run${prescribed_sessions === 1 ? "" : "s"} this week`;
  }

  return {
    prescribed_sessions,
    prescribed_km,
    prescribed_min,
    actual_sessions,
    actual_km,
    actual_min,
    pct_km,
    in_words,
  };
}

// ---------- this week's aerobic load (closing the runner loop, all sports) ----------
// The broad endurance picture for the CURRENT week — runs, hikes, rides, swims, rows —
// so a fueling read can see a big aerobic week even when there's no run PLAN (the
// run-compliance read above is run-only). Deterministic + null-safe: an empty week is
// zeros, never a throw. Distance/duration are plain numbers, never a score.
export interface WeeklyAerobicLoad {
  week_start: string;
  outings: number; // count of endurance outings this week (any sport)
  runs: number;
  hikes: number; // the walk/hike bucket
  rides: number;
  km: number; // total distance across outings
  minutes: number; // total duration
  longest_km: number | null;
  longest_min: number | null;
  in_words: string; // e.g. "24.3 km over 6 outings this week (3 runs, 3 hikes)"
}

export function weeklyAerobicLoad(weekStartISO?: string): WeeklyAerobicLoad {
  const monday =
    weekStartISO ||
    (() => {
      const d = new Date(localDateISO() + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
  const nextMonday = new Date(new Date(monday + "T00:00:00Z").getTime() + 7 * 864e5).toISOString().slice(0, 10);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(`SELECT type, distance_km, duration_min FROM activities WHERE date >= ? AND date < ?`)
      .all(monday, nextMonday) as any[];
  } catch {
    /* activities table absent → zeros */
  }
  const ENDURANCE_KEYS = new Set(["run", "walk", "ride", "swim", "row"]);
  let outings = 0;
  let runs = 0;
  let hikes = 0;
  let rides = 0;
  let km = 0;
  let minutes = 0;
  let longestKm = 0;
  let longestMin = 0;
  for (const r of rows) {
    const key = canonicalEnduranceSport(r.type).key;
    if (!ENDURANCE_KEYS.has(key)) continue; // endurance outings only (strength is a session)
    outings++;
    if (key === "run") runs++;
    else if (key === "walk") hikes++;
    else if (key === "ride") rides++;
    const d = Number(r.distance_km);
    const m = Number(r.duration_min);
    if (Number.isFinite(d) && d > 0) {
      km += d;
      if (d > longestKm) longestKm = d;
    }
    if (Number.isFinite(m) && m > 0) {
      minutes += m;
      if (m > longestMin) longestMin = m;
    }
  }
  km = Math.round(km * 10) / 10;
  minutes = Math.round(minutes);
  const longest_km = longestKm > 0 ? Math.round(longestKm * 10) / 10 : null;
  const longest_min = longestMin > 0 ? Math.round(longestMin) : null;
  const mix: string[] = [];
  if (runs) mix.push(`${runs} run${runs === 1 ? "" : "s"}`);
  if (hikes) mix.push(`${hikes} hike${hikes === 1 ? "" : "s"}`);
  if (rides) mix.push(`${rides} ride${rides === 1 ? "" : "s"}`);
  const outingWord = `${outings} outing${outings === 1 ? "" : "s"}`;
  const in_words =
    outings === 0
      ? "no aerobic outings this week"
      : km > 0
        ? `${km} km over ${outingWord} this week${mix.length ? ` (${mix.join(", ")})` : ""}`
        : `${outingWord} this week${mix.length ? ` (${mix.join(", ")})` : ""}`;
  return { week_start: monday, outings, runs, hikes, rides, km, minutes, longest_km, longest_min, in_words };
}

export function getVolumeByMuscle(days = 30) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  // UNIFIED onto the ONE honest-volume truth (effectiveVolumeByGroup): folds sets
  // onto CANONICAL groups (not a raw muscle_group + 'other' bucket), excludes warmups,
  // weights by proximity-to-failure, and credits ~0.5 indirect sets — the same model
  // programBalance / muscleVolume use. Fetches per-set rows (incl. bodyweight/timed)
  // rather than a raw COUNT(*); tonnage still comes only from loaded working sets.
  const rows = db
    .prepare(
      `SELECT s.date AS date, e.name AS exercise, e.muscle_group AS muscle_group,
              ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       JOIN exercises e ON e.id = ls.exercise_id
       WHERE s.date >= ?`
    )
    .all(cutoff) as any[];

  const byGroup = effectiveVolumeByGroup(rows as VolumeSet[]);
  const total_tonnage = [...byGroup.values()].reduce((sum, v) => sum + v.tonnage, 0);
  const by_muscle = [...byGroup.entries()]
    .map(([group, v]) => ({
      muscle_group: group as string,
      tonnage: Math.round(v.tonnage),
      sets: Math.round(v.sets * 10) / 10, // effective working sets (may be fractional)
      pct: total_tonnage > 0 ? Math.round((v.tonnage / total_tonnage) * 100) : 0,
    }))
    .sort((a, b) => b.sets - a.sets);
  return { days, total_tonnage: Math.round(total_tonnage), by_muscle };
}

export function getTrainingCalendar(days = 84) {
  const cutoff = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);

  // Build complete date range in JS so empty days are present.
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  }

  // Aggregate lifting data per day — tonnage only ever counts loaded working sets
  // (weight>0 AND reps>0); this is the basis for the tonnage buckets below.
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

  // ALL logged sets per day, including zero-tonnage timed/bodyweight work the
  // tonnage query above can't see (no weight to sum) — the basis for the sets
  // signal below, so a hard bodyweight/timed session isn't invisible.
  const allSetRows = db
    .prepare(
      `SELECT s.date, COUNT(*) AS sets
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE s.date >= ?
       GROUP BY s.date`
    )
    .all(cutoff) as any[];
  const totalSetsMap = new Map<string, number>();
  for (const r of allSetRows) totalSetsMap.set(r.date, r.sets);

  // Training minutes per day — a finished session's duration_min plus any logged
  // cardio/activity duration that day — the basis for the duration signal below,
  // so a long run/ride/hike registers honestly rather than reading as the floor.
  const minutesMap = new Map<string, number>();
  const sessionMinRows = db
    .prepare(
      `SELECT date, SUM(duration_min) AS min FROM sessions WHERE date >= ? AND duration_min IS NOT NULL GROUP BY date`
    )
    .all(cutoff) as any[];
  for (const r of sessionMinRows) minutesMap.set(r.date, (minutesMap.get(r.date) ?? 0) + (r.min ?? 0));
  const actMinRows = db
    .prepare(
      `SELECT date, SUM(duration_min) AS min FROM activities WHERE date >= ? AND duration_min IS NOT NULL GROUP BY date`
    )
    .all(cutoff) as any[];
  for (const r of actMinRows) minutesMap.set(r.date, (minutesMap.get(r.date) ?? 0) + (r.min ?? 0));

  // Activity days.
  const actRows = db.prepare(`SELECT DISTINCT date FROM activities WHERE date >= ?`).all(cutoff) as any[];
  const actDates = new Set(actRows.map((r: any) => r.date as string));

  const cells = dates.map((date) => {
    const lift = liftMap.get(date);
    const lifted = !!lift;
    const activity = actDates.has(date);
    const tonnage = lift?.tonnage ?? 0;
    const sets = lift?.sets ?? 0;
    const totalSets = totalSetsMap.get(date) ?? 0;
    const minutes = minutesMap.get(date) ?? 0;

    // Honest continuity, not a streak: intensity is judged per-modality rather
    // than by tonnage alone, since a hybrid athlete's hardest days are just as
    // often a long run/ride/hike or a bodyweight/timed session as a heavy
    // barbell one. Each signal is independent and the day's level is their MAX,
    // so a modality that doesn't apply never floors a day that earned more:
    //  - tonnage buckets (unchanged 5000 lb steps) for loaded strength work;
    //  - a sets bucket (>=10 sets=2, >=20=3) for a zero-tonnage strength day
    //    (timed/bodyweight), so it isn't floored just because there's no load
    //    to sum;
    //  - a duration bucket (any=1, >=30min=2, >=60min=3, >=100min=4) over
    //    session + activity minutes together, so a long cardio day — or a
    //    long day of any kind — isn't flattened to the lowest active shade.
    let level: number;
    if (lifted) {
      level = 1 + Math.min(3, Math.floor(tonnage / 5000));
    } else if (totalSets >= 20) {
      level = 3;
    } else if (totalSets >= 10) {
      level = 2;
    } else if (totalSets > 0 || activity) {
      level = 1;
    } else {
      level = 0;
    }
    if (minutes >= 100) level = Math.max(level, 4);
    else if (minutes >= 60) level = Math.max(level, 3);
    else if (minutes >= 30) level = Math.max(level, 2);
    else if (minutes > 0) level = Math.max(level, 1);
    level = Math.min(4, level);

    return { date, lifted, tonnage, sets, activity, level };
  });

  return { days, cells };
}

function parseExportJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function exportBrainTable(
  table: "brain_decisions" | "brain_expectations" | "brain_evaluations" | "brain_tool_calls" | "brain_rollbacks"
): any[] {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(`SELECT * FROM ${table} ORDER BY ${table === "brain_rollbacks" ? "decision_id" : "id"}`)
      .all() as any[];
  } catch {
    return [];
  }
  if (table === "brain_decisions") {
    return rows.map((row) => {
      const { context_json, action_json, specialist_json, ...rest } = row;
      return {
        ...rest,
        reversible: !!row.reversible,
        context: parseExportJson(context_json),
        action: parseExportJson(action_json),
        specialist: parseExportJson(specialist_json),
      };
    });
  }
  if (table === "brain_expectations") {
    return rows.map((row) => {
      const { baseline_json, target_json, minimum_data_json, ...rest } = row;
      return {
        ...rest,
        baseline: parseExportJson(baseline_json),
        target: parseExportJson(target_json),
        minimum_data: parseExportJson(minimum_data_json),
      };
    });
  }
  if (table === "brain_evaluations") {
    return rows.map((row) => {
      const { actual_json, evidence_json, confounders_json, ...rest } = row;
      return {
        ...rest,
        actual: parseExportJson(actual_json),
        evidence_keys: parseExportJson(evidence_json) ?? [],
        confounders: parseExportJson(confounders_json) ?? [],
      };
    });
  }
  if (table === "brain_rollbacks") {
    return rows.map((row) => {
      const { payload_json, ...rest } = row;
      return { ...rest, payload: parseExportJson(payload_json) };
    });
  }
  return rows;
}

export function exportAll() {
  const dailyMetrics = (db.prepare(`SELECT * FROM daily_metrics ORDER BY date DESC, id DESC`).all() as any[]).map(
    (row) => {
      let raw: any = null;
      try {
        raw = row.raw_json ? JSON.parse(row.raw_json) : null;
      } catch {
        raw = null;
      }
      const { raw_json, ...rest } = row;
      return { ...rest, raw };
    }
  );
  return {
    version: 2,
    profile: getProfile(),
    settings: getSettings(),
    plan: getPlan(),
    exercises: listExercises(),
    sessions: getRecentSessions(100000),
    daily_session_compositions: listDailySessionCompositions(),
    // The athlete-selected anchor and its immutable target snapshot are durable
    // coaching state, not a derived card. Keep superseded rows for a lossless
    // history just like memories and brain decisions.
    strength_objectives: db.prepare(`SELECT * FROM strength_objectives ORDER BY id DESC`).all(),
    activities: listActivities(100000),
    // Include superseded rows in the export — they're history we MARK rather than
    // destroy, so a backup/restore is lossless.
    memory: listMemory(100000, { includeSuperseded: true }),
    suggestions: listSuggestions(100000),
    bodyweight: listWeight(100000),
    meal_plans: listMealPlans(100000),
    food_notes: listFoodNotes(100000),
    health_documents: (
      db
        .prepare(
          `SELECT id, created_at, kind, doc_date, original_name, mime, parsed_json, summary,
                enrichment_status, source_doc_id
           FROM health_documents ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC`
        )
        .all() as any[]
    ).map(({ parsed_json, ...row }) => ({ ...row, parsed: parseExportJson(parsed_json) })),
    imaging_study_files: db
      .prepare(
        `SELECT id, health_document_id, sequence, created_at, original_name, mime, size_bytes, sha256, source_kind,
              dicom_study_uid, dicom_series_uid, dicom_sop_uid
         FROM imaging_study_files ORDER BY health_document_id, sequence, id`
      )
      .all(),
    dicom_series: db
      .prepare(
        `SELECT id, health_document_id, study_instance_uid, series_instance_uid, modality, series_number,
                study_date, study_description, description, body_part, laterality, frame_of_reference_uid, instance_count, frame_count,
                preview_support_reason, created_at
           FROM dicom_series ORDER BY health_document_id, COALESCE(series_number,2147483647), id`
      )
      .all(),
    dicom_instances: db
      .prepare(
        `SELECT id, series_id, imaging_study_file_id, sop_class_uid, sop_instance_uid, transfer_syntax_uid,
                instance_number, number_of_frames, rows, columns, samples_per_pixel, photometric_interpretation,
                bits_allocated, bits_stored, high_bit, pixel_representation, planar_configuration,
                rescale_slope, rescale_intercept, window_center, window_width, pixel_spacing, image_position,
                image_orientation, slice_location, frame_of_reference_uid, body_part, laterality,
                burned_in_annotation, source_deidentification_claim, preview_support_reason, sha256, size_bytes,
                created_at
           FROM dicom_instances ORDER BY series_id, COALESCE(instance_number,2147483647), id`
      )
      .all(),
    health_reviews: listHealthReviews(100000),
    context_events: listContextEvents(),
    // Source-agnostic wearable rows (Apple Health / Oura / manual) are first-class
    // backup data, not only a derived recovery view. Raw payloads stay preserved.
    daily_metrics: dailyMetrics,
    // The accountability spine is first-class backup data. Export every row (no
    // UI pagination cap), hydrating bounded JSON columns into the same structured
    // shape consumers receive from the repository.
    brain_decisions: exportBrainTable("brain_decisions"),
    brain_expectations: exportBrainTable("brain_expectations"),
    brain_evaluations: exportBrainTable("brain_evaluations"),
    brain_tool_calls: exportBrainTable("brain_tool_calls"),
    brain_rollbacks: exportBrainTable("brain_rollbacks"),
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

// `through` bounds the history to sets logged ON OR BEFORE a calendar date. It
// exists for the signal builders reading a FIXED HISTORICAL date: the est-1RM trend
// is read off the last two points, so unbounded, a read of last Tuesday was told
// which way a lift was moving using sessions logged AFTER it. Omitted — the default
// and every "what is true now" caller (the REST route, the MCP tool, program-state,
// muscle-trajectory, the exercise detail view) — the history stays unbounded, which
// is what an all-time est-1RM and PR detection require.
export function getProgress(exerciseName: string, opts: { through?: string } = {}) {
  const ex = findExercise(exerciseName);
  if (!ex) return { exercise: exerciseName, found: false, points: [] };
  const through = typeof opts.through === "string" && opts.through.trim() ? opts.through.trim() : null;

  // For assisted lifts (negative weight = assist), we need the athlete's bodyweight
  // to compute effective load = bodyweight - assist. Fetch it once.
  const profRow = db.prepare("SELECT weight_lb FROM profile WHERE id = 1").get() as any;
  const bodyweightLb: number | null = profRow?.weight_lb != null ? Number(profRow.weight_lb) : null;

  // Full, UNBOUNDED history on purpose: an all-time est-1RM and PR detection are only
  // correct over every set ever logged for this lift — a window could miss the true max.
  // The cost is contained by CALLERS, not here: getProgramState (the N+1 that hits this
  // per distinct exercise) is memoized on the training-data version, so a page render
  // pays this scan once per lift per data change, not on every read. Left unbounded.
  // `through` is the ONE exception, and it is a horizon, not a window: everything ever
  // logged up to that day, so the all-time max as of that day is still exact.
  const rows = db
    .prepare(
      `SELECT s.date AS date, ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? AND ls.weight IS NOT NULL AND ls.reps IS NOT NULL
       ${through ? "AND s.date <= ?" : ""}
       ORDER BY s.date`
    )
    .all(...(through ? [ex.id, through] : [ex.id])) as any[];

  // Per-date: track the best set by its effective 1RM (or by reps for assisted
  // sets where bodyweight is unknown). NEVER emit a negative best1rm.
  const byDate = new Map<string, { topWeight: number; topReps: number; best1rm: number | null }>();
  for (const r of rows) {
    const w = Number(r.weight);
    const reps = Number(r.reps);
    if (!Number.isFinite(w) || !Number.isFinite(reps) || reps <= 0) continue;

    let best1rm: number | null;
    if (w < 0) {
      // Assisted movement: effective load = bodyweight − assist.
      // If bodyweight is known, compute Epley on effective load (floor 0).
      if (bodyweightLb != null && bodyweightLb > 0) {
        const effectiveLoad = Math.max(0, bodyweightLb - Math.abs(w));
        best1rm = epley1RM(effectiveLoad, reps);
      } else {
        // Bodyweight unknown — can't compute a meaningful 1RM; omit it.
        best1rm = null;
      }
    } else if (w > 0) {
      best1rm = epley1RM(w, reps);
    } else {
      // Bodyweight (weight === 0): the effective load IS the athlete's bodyweight, so a
      // bodyweight movement DOES have a real est-1RM (and therefore a trend/status) when
      // bodyweight is known — more reps at bodyweight is genuinely getting stronger.
      // Unknown bodyweight → null (can't compute a meaningful number). This stops a
      // pure-bodyweight lift from silently defaulting to "new"/null trend forever.
      best1rm = bodyweightLb != null && bodyweightLb > 0 ? epley1RM(bodyweightLb, reps) : null;
    }

    const cur = byDate.get(r.date);
    // Rank sets: a non-null 1RM always beats a null one; among non-nulls, higher wins.
    const betterThan = (candidate: number | null): boolean => {
      if (!cur) return true;
      if (candidate === null) return false; // a null can't beat anything
      if (cur.best1rm === null) return true; // anything beats null
      return candidate > cur.best1rm;
    };
    if (betterThan(best1rm)) {
      byDate.set(r.date, { topWeight: w, topReps: reps, best1rm });
    }
  }
  const points = [...byDate.entries()].map(([date, v]) => ({ date, ...v }));
  return { exercise: ex.name, found: true, unit: ex.unit, points };
}

// ---------- motivational progress (session highlights + week wins) ----------
// Two read-only, deterministic, null-safe reads that surface EVIDENCE of forward
// motion: a session's PRs/comparisons, and a week's rollup of new bests, days
// trained, hard sets, filled volume, and weight-trend pace. Constitution: factual,
// calm, motivational-by-evidence — never a 0-100 score, never anxious/blaming.
// Absent data → empty arrays / nulls, never a throw.

// Best est-1RM (Epley) over LOADED working sets only (weight>0 && reps>0), mirroring
// logSetByName's PR comparison — assisted/bodyweight sets don't generate an est-1RM
// PR, and this is the ONE definition both the live-log path and the read-time
// recompute share. Returns 0 when no loaded set qualifies.
function bestE1rm(rows: Array<{ weight: any; reps: any }>): number {
  let best = 0;
  for (const r of rows) {
    const w = Number(r.weight);
    const reps = Number(r.reps);
    if (w > 0 && reps > 0) best = Math.max(best, epley1RM(w, reps));
  }
  return best;
}

// Best (longest) hold over timed sets. Returns 0 when none.
function bestDuration(rows: Array<{ duration_sec: any }>): number {
  let best = 0;
  for (const r of rows) {
    const d = Number(r.duration_sec);
    if (Number.isFinite(d) && d > 0) best = Math.max(best, d);
  }
  return best;
}

// Display helpers — whole loads render clean, a plate-and-a-half shows one decimal;
// a hold renders as M:SS (or Ns under a minute); a prior date renders "Jul 6".
function fmtWeight(w: number): string {
  return Number.isInteger(w) ? String(w) : String(Math.round(w * 10) / 10);
}
function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${SHORT_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : String(iso ?? "");
}
function fmtReps(delta: number): string {
  const n = Math.abs(delta);
  return `${delta > 0 ? "+" : "-"}${n} rep${n === 1 ? "" : "s"}`;
}

// The 7-day window ending on (and including) a date. Anchored in UTC-midnight day
// arithmetic like computeWeeklyStats, so a session date maps to [date-6, date].
function window7(dateISO: string): { start: string; end: string } {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(dateISO) ? dateISO : localDateISO();
  const start = new Date(new Date(end + "T00:00:00Z").getTime() - 6 * 864e5).toISOString().slice(0, 10);
  return { start, end };
}

// Distinct dates with any logged set OR any activity in the trailing 7 days — the
// same "a trained day" union getWeeklyStats' streak uses (sessions-with-sets ∪
// activity dates), scoped to the window.
function trainedDays7(dateISO: string): number {
  const { start, end } = window7(dateISO);
  const sessDates = (
    db
      .prepare(
        `SELECT DISTINCT s.date AS d FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ? AND s.date <= ?`
      )
      .all(start, end) as any[]
  ).map((r) => r.d);
  const actDates = (
    db.prepare(`SELECT DISTINCT date AS d FROM activities WHERE date >= ? AND date <= ?`).all(start, end) as any[]
  ).map((r) => r.d);
  return new Set([...sessDates, ...actDates]).size;
}

interface SessionSet {
  exercise_id: number;
  exercise: string;
  mode: string | null;
  weight: number | null;
  reps: number | null;
  duration_sec: number | null;
}
interface ExerciseGroup {
  exId: number;
  name: string;
  mode: string;
  exSets: SessionSet[];
}

function groupByExercise(rows: SessionSet[]): Map<number, ExerciseGroup> {
  const map = new Map<number, ExerciseGroup>();
  for (const r of rows) {
    const exId = Number(r.exercise_id);
    let g = map.get(exId);
    if (!g) {
      g = { exId, name: String(r.exercise), mode: String(r.mode ?? "reps"), exSets: [] };
      map.set(exId, g);
    }
    g.exSets.push(r);
  }
  return map;
}

type WeightType = "loaded" | "assisted" | "bodyweight";
function weightType(w: number | null): WeightType {
  const n = Number(w);
  if (Number.isFinite(n) && n > 0) return "loaded";
  if (Number.isFinite(n) && n < 0) return "assisted"; // negative = assisted (e.g. -30 = 30lb assist)
  return "bodyweight"; // null or 0
}

// The session's REPRESENTATIVE reps-mode set ("top set"): the loaded set with the
// best est-1RM; else the assisted set with the LEAST assistance (highest signed
// weight); else the bodyweight set with the most reps. null when nothing usable.
function topRepsSet(sets: SessionSet[]): SessionSet | null {
  let loaded: SessionSet | null = null;
  let loadedE = -1;
  let assisted: SessionSet | null = null;
  let bodyweight: SessionSet | null = null;
  for (const s of sets) {
    const w = s.weight == null ? null : Number(s.weight);
    const reps = Number(s.reps);
    if (!(reps > 0)) continue;
    if (w != null && w > 0) {
      const e = epley1RM(w, reps);
      if (e > loadedE) {
        loadedE = e;
        loaded = s;
      }
    } else if (w != null && w < 0) {
      if (!assisted || w > Number(assisted.weight) || (w === Number(assisted.weight) && reps > Number(assisted.reps)))
        assisted = s;
    } else if (!bodyweight || reps > Number(bodyweight.reps)) {
      bodyweight = s;
    }
  }
  return loaded ?? assisted ?? bodyweight ?? null;
}

// PRs the session set (recomputed at read time — PR flags aren't persisted). A
// first-ever logging of an exercise has no baseline and is NOT a PR (omitted).
function prsForSession(
  sessionId: number,
  date: string,
  sets?: SessionSet[]
): Array<{ exercise: string; kind: "e1rm" | "duration"; label: string }> {
  const rows = sets ?? (setsForSession(sessionId) as unknown as SessionSet[]);
  const out: Array<{ exercise: string; kind: "e1rm" | "duration"; label: string }> = [];
  for (const { exId, name, mode, exSets } of groupByExercise(rows).values()) {
    if (mode === "timed") {
      const sessionBest = bestDuration(exSets);
      if (sessionBest <= 0) continue;
      const prior = db
        .prepare(`SELECT l.duration_sec AS duration_sec FROM logged_sets l JOIN sessions s ON s.id = l.session_id
                  WHERE l.exercise_id = ? AND s.date < ? AND l.duration_sec IS NOT NULL`)
        .all(exId, date) as any[];
      if (!prior.length) continue; // no baseline — first-ever timed logging
      if (sessionBest > bestDuration(prior)) {
        out.push({ exercise: name, kind: "duration", label: `${fmtDuration(sessionBest)} hold — new best` });
      }
    } else {
      const sessionBest = bestE1rm(exSets);
      if (sessionBest <= 0) continue; // no loaded working set this session
      const prior = db
        .prepare(`SELECT l.weight AS weight, l.reps AS reps FROM logged_sets l JOIN sessions s ON s.id = l.session_id
                  WHERE l.exercise_id = ? AND s.date < ? AND l.weight > 0 AND l.reps > 0`)
        .all(exId, date) as any[];
      if (!prior.length) continue; // no baseline — first-ever loaded logging
      if (sessionBest > bestE1rm(prior)) {
        const win = topRepsSet(exSets);
        if (win && Number(win.weight) > 0) {
          out.push({
            exercise: name,
            kind: "e1rm",
            label: `${fmtWeight(Number(win.weight))} lb × ${Number(win.reps)} — new best`,
          });
        }
      }
    }
  }
  return out;
}

// A fair plain-language description of the previous session's top effort — used when
// a clean delta can't be computed (a mode/type mismatch, e.g. graduating off assistance).
function describePrev(mode: string, prevSets: SessionSet[], prevDate: string): string {
  if (mode === "timed") {
    const d = bestDuration(prevSets);
    return d > 0 ? `${fmtDuration(d)} hold on ${shortDate(prevDate)}` : `logged on ${shortDate(prevDate)}`;
  }
  const top = topRepsSet(prevSets);
  if (top) {
    const w = top.weight == null ? null : Number(top.weight);
    if (w != null && w > 0) return `${fmtWeight(w)} × ${Number(top.reps)} on ${shortDate(prevDate)}`;
    if (w != null && w < 0)
      return `${fmtWeight(Math.abs(w))} lb assist × ${Number(top.reps)} on ${shortDate(prevDate)}`;
    return `${Number(top.reps)} reps on ${shortDate(prevDate)}`;
  }
  return `logged on ${shortDate(prevDate)}`;
}

interface Comparison {
  exercise: string;
  prev_date: string | null;
  prev_label: string;
  delta_label: string | null;
  direction: "up" | "down" | "even" | null;
}

// Compare the session's top set for one exercise against its previous session. Like
// is compared with like (loaded↔loaded, assisted↔assisted, bodyweight↔bodyweight,
// timed↔timed). LESS assistance counts as an improvement (direction up). A type
// mismatch degrades to a fair label with direction:null rather than a wrong sign.
function buildComparison(
  name: string,
  mode: string,
  curSets: SessionSet[],
  prevSets: SessionSet[],
  prevDate: string
): Comparison {
  const base = { exercise: name, prev_date: prevDate };
  if (mode === "timed") {
    const cur = bestDuration(curSets);
    const prev = bestDuration(prevSets);
    if (cur > 0 && prev > 0) {
      const d = Math.round(cur - prev);
      return {
        ...base,
        prev_label: `${fmtDuration(prev)} hold on ${shortDate(prevDate)}`,
        delta_label: d === 0 ? "matched" : `${d > 0 ? "+" : "-"}${Math.abs(d)}s`,
        direction: d > 0 ? "up" : d < 0 ? "down" : "even",
      };
    }
    return { ...base, prev_label: describePrev(mode, prevSets, prevDate), delta_label: null, direction: null };
  }
  const cur = topRepsSet(curSets);
  const prev = topRepsSet(prevSets);
  if (!cur || !prev)
    return { ...base, prev_label: describePrev(mode, prevSets, prevDate), delta_label: null, direction: null };
  const ct = weightType(cur.weight);
  const pt = weightType(prev.weight);
  if (ct !== pt)
    return { ...base, prev_label: describePrev(mode, prevSets, prevDate), delta_label: null, direction: null };

  if (ct === "loaded") {
    const cw = Number(cur.weight);
    const pw = Number(prev.weight);
    const prev_label = `${fmtWeight(pw)} × ${Number(prev.reps)} on ${shortDate(prevDate)}`;
    if (cw !== pw) {
      const d = cw - pw;
      return {
        ...base,
        prev_label,
        delta_label: `${d > 0 ? "+" : "-"}${fmtWeight(Math.abs(d))} lb`,
        direction: d > 0 ? "up" : "down",
      };
    }
    const dr = Number(cur.reps) - Number(prev.reps);
    if (dr !== 0) return { ...base, prev_label, delta_label: fmtReps(dr), direction: dr > 0 ? "up" : "down" };
    return { ...base, prev_label, delta_label: "matched", direction: "even" };
  }
  if (ct === "bodyweight") {
    const prev_label = `${Number(prev.reps)} reps on ${shortDate(prevDate)}`;
    const dr = Number(cur.reps) - Number(prev.reps);
    if (dr !== 0) return { ...base, prev_label, delta_label: fmtReps(dr), direction: dr > 0 ? "up" : "down" };
    return { ...base, prev_label, delta_label: "matched", direction: "even" };
  }
  // assisted: less assistance (a smaller magnitude) is the improvement.
  const ca = Math.abs(Number(cur.weight));
  const pa = Math.abs(Number(prev.weight));
  const prev_label = `${fmtWeight(pa)} lb assist × ${Number(prev.reps)} on ${shortDate(prevDate)}`;
  if (ca !== pa) {
    const d = pa - ca; // >0 → less assist now → improvement
    return {
      ...base,
      prev_label,
      delta_label: `${fmtWeight(Math.abs(d))} lb ${d > 0 ? "less" : "more"} assist`,
      direction: d > 0 ? "up" : "down",
    };
  }
  const dr = Number(cur.reps) - Number(prev.reps);
  if (dr !== 0) return { ...base, prev_label, delta_label: fmtReps(dr), direction: dr > 0 ? "up" : "down" };
  return { ...base, prev_label, delta_label: "matched", direction: "even" };
}

function comparisonsForSession(sessionId: number, date: string, sets?: SessionSet[]): Comparison[] {
  const rows = sets ?? (setsForSession(sessionId) as unknown as SessionSet[]);
  const out: Comparison[] = [];
  for (const { exId, name, mode, exSets } of groupByExercise(rows).values()) {
    const prev = db
      .prepare(`SELECT s.date AS date FROM sessions s JOIN logged_sets l ON l.session_id = s.id
                WHERE l.exercise_id = ? AND s.date < ? ORDER BY s.date DESC LIMIT 1`)
      .get(exId, date) as any;
    if (!prev) {
      out.push({
        exercise: name,
        prev_date: null,
        prev_label: "first time logged",
        delta_label: null,
        direction: null,
      });
      continue;
    }
    const prevDate = String(prev.date);
    const prevSets = db
      .prepare(`SELECT l.exercise_id AS exercise_id, l.weight AS weight, l.reps AS reps, l.duration_sec AS duration_sec
                FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE l.exercise_id = ? AND s.date = ?`)
      .all(exId, prevDate) as unknown as SessionSet[];
    out.push(buildComparison(name, mode, exSets, prevSets, prevDate));
  }
  return out;
}

// Raw PR events (one per session×exercise that set a new best) over a window, oldest
// first — the shared basis for the week rollup count and the week-wins list.
function prEventsInWindow(
  startISO: string,
  endISO: string
): Array<{ exercise: string; kind: "e1rm" | "duration"; label: string; date: string }> {
  const sessions = db
    .prepare(`SELECT DISTINCT s.id AS id, s.date AS date FROM sessions s
              JOIN logged_sets l ON l.session_id = s.id WHERE s.date >= ? AND s.date <= ? ORDER BY s.date, s.id`)
    .all(startISO, endISO) as any[];
  const out: Array<{ exercise: string; kind: "e1rm" | "duration"; label: string; date: string }> = [];
  for (const sess of sessions) {
    for (const pr of prsForSession(Number(sess.id), String(sess.date))) {
      out.push({ ...pr, date: String(sess.date) });
    }
  }
  return out;
}

// Evidence of forward motion for ONE logged session. Unknown id → null (the route's
// soft-lookup 200 + null convention). All fields degrade to empty/zero, never throw.
export function sessionHighlights(sessionId: number) {
  const sess = db.prepare(`SELECT id, date FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!sess) return null;
  const date = String(sess.date);
  const sets = setsForSession(sessionId) as unknown as SessionSet[];
  const { start, end } = window7(date);
  return {
    prs: prsForSession(sessionId, date, sets),
    comparisons: comparisonsForSession(sessionId, date, sets),
    week: {
      // Raw count of new-best events set in the trailing 7 days (may exceed the
      // distinct-exercise weekWins list when a lift PRs on more than one day).
      prs: prEventsInWindow(start, end).length,
      trained_days_7: trainedDays7(date),
    },
  };
}

// The week's motivational rollup ending at `date` (default today, local day). Every
// field is null-safe: an empty log yields empty arrays / zeros / null pace.
export function weekWins(date?: string) {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : localDateISO();
  const { start } = window7(end);

  // New bests this week, DEDUPED to one entry per exercise (the latest supersedes an
  // earlier one — events arrive oldest-first, so the last write is the newest label),
  // sorted newest-first: a calm display list, not a raw event stream.
  const byExercise = new Map<string, { exercise: string; label: string; date: string }>();
  for (const e of prEventsInWindow(start, end))
    byExercise.set(e.exercise, { exercise: e.exercise, label: e.label, date: e.date });
  const prs = [...byExercise.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map(({ exercise, label }) => ({ exercise, label }));

  const ws = getWeeklyStats(end);
  return {
    prs,
    trained_days_7: trainedDays7(end),
    week_sets: Number(ws.week_sets ?? 0),
    volume_filled: weekVolumeFilled(start, end),
    pace: composePace(ws),
  };
}

// Muscle groups whose THIS-WEEK effective hard-set count landed IN their productive
// volume range (RP-style MUSCLE_LANDMARKS band), most-filled first. Reuses the ONE
// honest-volume truth (effectiveVolumeByGroup: warmups excluded, RIR-weighted,
// canonical groups, indirect credit) — the same model muscleVolume/getVolumeByMuscle
// use. Groups below MEV (not enough yet) and above MRV (over-range, not a clean win)
// are excluded. [] when nothing reached the band.
function weekVolumeFilled(startISO: string, endISO: string): Array<{ muscle: string; label: string }> {
  const rows = db
    .prepare(`SELECT s.date AS date, e.name AS exercise, e.muscle_group AS muscle_group,
                     ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
              FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
              JOIN exercises e ON e.id = ls.exercise_id WHERE s.date >= ? AND s.date <= ?`)
    .all(startISO, endISO) as any[];
  const byGroup = effectiveVolumeByGroup(rows as VolumeSet[]);
  const filled: Array<{ muscle: string; sets: number }> = [];
  for (const [group, v] of byGroup) {
    const lm = MUSCLE_LANDMARKS[group];
    if (!lm) continue; // mobility / no landmark
    if (v.sets >= lm.low && v.sets <= lm.high) filled.push({ muscle: group, sets: v.sets });
  }
  filled.sort((a, b) => b.sets - a.sets);
  return filled.map(({ muscle, sets }) => ({ muscle, label: `${Math.round(sets)} hard sets — productive volume` }));
}

// Compose the pace read off getWeeklyStats: a factual weight-trend phrase plus the
// goal verdict, in plain words. status is narrowed to the shape's on|behind|fast|null
// (maintain/gain drift states fold to null status but still describe themselves in
// the label). label is null only when there aren't enough weigh-ins for a trend.
function composePace(ws: any): { status: "on" | "behind" | "fast" | null; label: string | null } {
  const raw = ws?.pace_status ?? null;
  const status: "on" | "behind" | "fast" | null = raw === "on" || raw === "behind" || raw === "fast" ? raw : null;
  const trend = ws?.trend_lb_wk;
  if (trend == null || !Number.isFinite(Number(trend))) return { status, label: null };
  const t = Number(trend);
  const mag = Math.abs(Math.round(t * 10) / 10);
  const phrase = t <= -0.1 ? `losing ~${mag} lb/wk` : t >= 0.1 ? `gaining ~${mag} lb/wk` : "holding steady";
  const goalDate = ws?.goal_date;
  let tail = "";
  if (raw === "on") tail = goalDate ? ` — on pace for ${shortDate(goalDate)}` : " — on pace";
  else if (raw === "behind") tail = " — a bit behind pace";
  else if (raw === "fast") tail = t < 0 ? " — quicker than the lean-safe pace" : " — building faster than lean";
  else if (raw === "drifting_up") tail = " — drifting up a little";
  else if (raw === "drifting_down") tail = " — drifting down a little";
  return { status, label: `${phrase}${tail}` };
}
