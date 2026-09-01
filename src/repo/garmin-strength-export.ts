// Persistence for Cairn → Garmin strength write-back. The orchestration lives in
// src/garminExport.ts (it needs HTTP); this module holds the four reads and the one
// write that touch the database, so the exporter stays a pure-ish pipeline over a
// repo boundary like every other subsystem.
//
// The export RECORD lives on sessions.garmin_json.export — the same blob that already
// carries the reconciled physiology — as { activity_id, source, fingerprint,
// exported_at, mode }. Keeping it there (rather than in a table of its own) means one
// read answers "what does Garmin already have for this day", and reconcileGarminStrength
// carries it forward so a later watch sync can't silently forget we wrote.
import { db } from "../db.js";
import { isStrengthGarminType } from "./activities.js";

export interface GarminSessionExportRecord {
  activity_id: string;
  source: "watch" | "manual";
  fingerprint: string;
  exported_at: string;
  mode: string;
  /**
   * Every manual shell Cairn authored for this session. `source` cannot carry this:
   * a retarget rewrites it to "watch", and the provenance is then lost for good. Ids
   * are pruned once the activity is gone both locally and on Garmin, so the list stays
   * as short as the number of shells actually outstanding (normally none).
   */
  created_ids?: string[];
  /** Shells Garmin has not accepted the delete for yet. */
  pending_deletes?: string[];
  /**
   * The first outstanding shell, projected on READ only for callers and stored records
   * written before the plural form. Never persisted — set `pending_deletes` instead.
   */
  pending_delete?: string;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

export interface GarminExportSetRow {
  id: number;
  exercise_id: number;
  exercise: string;
  set_number: number;
  weight: number | null; // Cairn pounds; negative = assist, null = bodyweight
  reps: number | null;
  duration_sec: number | null;
  mode: string | null; // 'reps' | 'timed'
  created_at: string | null;
  garmin_category: string | null;
  garmin_exercise: string | null;
}

export interface GarminLinkedStrengthActivity {
  id: number;
  external_id: string | null;
  /** Carries the Cairn marker on a shell we authored — provenance the ledger can lose. */
  name: string | null;
  start_time: string | null;
  duration_min: number | null;
  avg_hr: number | null;
  calories: number | null;
}

function parseGarminBlob(raw: unknown): Record<string, any> {
  if (raw == null || raw === "") return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/**
 * Every logged set on one session, in log order, joined to the movement's resolved
 * FIT mapping. Log order (by row id) is what makes the export fingerprint stable —
 * re-reading the same session must produce the same bytes.
 */
export function garminExportSetRows(sessionId: number): GarminExportSetRow[] {
  return (
    db
      .prepare(
        `SELECT ls.id AS id, ls.exercise_id AS exercise_id, e.name AS exercise, ls.set_number AS set_number,
                ls.weight AS weight, ls.reps AS reps, ls.duration_sec AS duration_sec, e.mode AS mode,
                ls.created_at AS created_at,
                e.garmin_category AS garmin_category, e.garmin_exercise AS garmin_exercise
           FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
          WHERE ls.session_id = ?
          ORDER BY ls.id`
      )
      .all(sessionId) as any[]
  ).map((row) => ({
    id: Number(row.id),
    exercise_id: Number(row.exercise_id),
    exercise: String(row.exercise ?? ""),
    set_number: Number(row.set_number) || 0,
    weight: row.weight == null ? null : Number(row.weight),
    reps: row.reps == null ? null : Number(row.reps),
    duration_sec: row.duration_sec == null ? null : Number(row.duration_sec),
    mode: row.mode == null ? null : String(row.mode),
    created_at: row.created_at == null ? null : String(row.created_at),
    garmin_category: row.garmin_category == null ? null : String(row.garmin_category),
    garmin_exercise: row.garmin_exercise == null ? null : String(row.garmin_exercise),
  }));
}

/**
 * The Garmin strength activities already linked to this session — the watch's own
 * recording of the same workout, and (after a create) the manual activity Cairn
 * made. Physiology is carried so the exporter can rank which recording is the richer
 * home; the NAME is carried because it is the only proof of who authored the activity
 * that survives a lost create response.
 */
export function listSessionGarminStrengthActivities(sessionId: number): GarminLinkedStrengthActivity[] {
  return (
    db
      .prepare(
        `SELECT id, external_id, name, start_time, duration_min, avg_hr, calories, type
           FROM garmin_activities WHERE session_id = ? ORDER BY id`
      )
      .all(sessionId) as any[]
  )
    .filter((row) => isStrengthGarminType(row.type))
    .map((row) => ({
      id: Number(row.id),
      external_id: row.external_id == null ? null : String(row.external_id),
      name: row.name == null ? null : String(row.name),
      start_time: row.start_time == null ? null : String(row.start_time),
      duration_min: row.duration_min == null ? null : Number(row.duration_min),
      avg_hr: row.avg_hr == null ? null : Number(row.avg_hr),
      calories: row.calories == null ? null : Number(row.calories),
    }));
}

export interface SessionGarminExportContext {
  id: number;
  date: string;
  duration_min: number | null;
  title: string;
  cairn_sets_authoritative: boolean | null;
}

/** The handful of session fields write-back needs — not the full hydrated detail. */
export function sessionGarminExportContext(sessionId: number): SessionGarminExportContext | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, s.date AS date, s.duration_min AS duration_min, s.garmin_json AS garmin_json,
              pd.name AS day_name
         FROM sessions s LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
        WHERE s.id = ?`
    )
    .get(sessionId) as any;
  if (!row) return null;
  const auth = parseGarminBlob(row.garmin_json).cairn_sets_authoritative;
  return {
    id: Number(row.id),
    date: String(row.date ?? ""),
    duration_min: row.duration_min == null ? null : Number(row.duration_min),
    title: String(row.day_name ?? "").trim() || "Strength",
    cairn_sets_authoritative: typeof auth === "boolean" ? auth : null,
  };
}

/** What Garmin already holds for this session, or null when we've never written. */
export function getSessionGarminExport(sessionId: number): GarminSessionExportRecord | null {
  const row = db.prepare(`SELECT garmin_json FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!row) return null;
  const record = parseGarminBlob(row.garmin_json).export;
  if (!record || typeof record !== "object") return null;
  const activityId = String(record.activity_id ?? "").trim();
  if (!activityId) return null;
  // Read-compat: a record written before the plural form carried one outstanding shell.
  const legacyPending = String(record.pending_delete ?? "").trim();
  const pending = [...new Set([...idList(record.pending_deletes), ...(legacyPending ? [legacyPending] : [])])];
  const created = idList(record.created_ids);
  return {
    activity_id: activityId,
    source: record.source === "watch" ? "watch" : "manual",
    fingerprint: String(record.fingerprint ?? ""),
    exported_at: String(record.exported_at ?? ""),
    mode: String(record.mode ?? ""),
    ...(created.length ? { created_ids: created } : {}),
    ...(pending.length ? { pending_deletes: pending, pending_delete: pending[0] } : {}),
  };
}

/** Record one successful write-back. Merged into the existing blob, never replacing it. */
export function recordSessionGarminExport(sessionId: number, record: GarminSessionExportRecord): void {
  const row = db.prepare(`SELECT garmin_json FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!row) return;
  const blob = parseGarminBlob(row.garmin_json);
  const stored: Record<string, unknown> = { ...record };
  // Empty lists are noise in a blob a human reads; the singular field is retired.
  for (const key of ["created_ids", "pending_deletes"]) {
    if (!(stored[key] as string[] | undefined)?.length) delete stored[key];
  }
  delete stored.pending_delete;
  blob.export = stored;
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(blob), sessionId);
}

/**
 * When the write-back last landed, across every session — one quiet line of state for
 * the Settings toggle, so "is this actually doing anything?" has an answer without
 * naming activities, ids or counts. Null when nothing has ever been sent.
 */
export function lastGarminStrengthExportAt(): string | null {
  const row = db
    .prepare(
      `SELECT MAX(json_extract(garmin_json, '$.export.exported_at')) AS at
         FROM sessions
        WHERE garmin_json IS NOT NULL`
    )
    .get() as any;
  const at = String(row?.at ?? "").trim();
  return at || null;
}

/**
 * Finished sessions in the sync window that Cairn owns sets for — the candidates a
 * sync enqueues for write-back. Deliberately generous: it does NOT try to decide
 * whether an export is stale (that needs the FIT mapping and the fingerprint), so
 * exportSessionToGarmin stays the single authority and simply skips an unchanged one
 * before touching the network. A watch-authoritative day is excluded here, since
 * Garmin's own sets are never overwritten.
 *
 * A session with NO sets left still qualifies while an export record survives: that
 * is the retraction case (the athlete deleted the work after we pushed it), and it
 * settles itself — the retraction clears the record, so the session drops out again.
 */
export function sessionsEligibleForGarminExport(since: string, until?: string): number[] {
  const from = String(since ?? "").slice(0, 10);
  const to = String(until ?? "").slice(0, 10);
  const rows = db
    .prepare(
      `SELECT s.id AS id
         FROM sessions s
        WHERE s.finished_at IS NOT NULL
          AND (? = '' OR s.date >= ?)
          AND (? = '' OR s.date <= ?)
          AND (EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id)
               OR json_extract(s.garmin_json, '$.export.activity_id') IS NOT NULL)
          AND COALESCE(json_extract(s.garmin_json, '$.cairn_sets_authoritative'), 1) != 0
        ORDER BY s.date DESC, s.id DESC`
    )
    .all(from, from, to, to) as any[];
  return rows.map((row) => Number(row.id));
}

/**
 * Forget that we ever wrote for this session — used only when the export is RETRACTED
 * (the sets it described are gone and the activity carrying them has been deleted).
 * Leaves the rest of the blob, physiology included, exactly as it was.
 */
export function clearSessionGarminExport(sessionId: number): void {
  const row = db.prepare(`SELECT garmin_json FROM sessions WHERE id = ?`).get(sessionId) as any;
  if (!row) return;
  const blob = parseGarminBlob(row.garmin_json);
  if (!("export" in blob)) return;
  delete blob.export;
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify(blob), sessionId);
}

/**
 * Drop a Garmin activity row by its provider id — used when a manual activity Cairn
 * created is superseded by the watch's own recording of the same workout, so the day
 * stops carrying two rows for one session.
 */
export function deleteGarminActivityByExternalId(externalId: string): number {
  const id = String(externalId ?? "").trim();
  if (!id) return 0;
  return Number(db.prepare(`DELETE FROM garmin_activities WHERE external_id = ?`).run(id).changes);
}
