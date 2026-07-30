import { db } from "../db.js";
import { localDateISO } from "./shared.js";
import { requestSymptomExtraction } from "./symptom-extraction-hooks.js";

// The athlete's own words about pain, stored verbatim and synchronously.
//
// This module exists because the old path had exactly ONE place to put a pain
// report — `training_symptom_events.area_text`, a 60-character display LABEL — so
// every sentence longer than a label was silently clipped mid-word and the rest
// discarded. The label is still a label; the record lives here.
//
// Nothing in this module derives anything. Structure comes later, from the agentic
// extraction lane (src/symptomCapture.ts + the `symptom` enrichment kind), and a
// failed extraction costs nothing because the words are already stored.

// Generous but bounded: long enough for a whole session note, short enough that a
// runaway paste can't put a megabyte in a row the UI renders.
export const SYMPTOM_REPORT_TEXT_MAX = 4000;

export type SymptomReportSourceKind = "session_note" | "session_feedback" | "chat" | "api";
export type SymptomReportExtractionStatus = "pending" | "done" | "skipped" | "failed";

export interface SymptomReport {
  id: number;
  symptom_event_id: number | null;
  session_id: number | null;
  text: string;
  source_kind: SymptomReportSourceKind;
  reported_on: string;
  extraction: unknown | null;
  extraction_status: SymptomReportExtractionStatus;
  created_at: string;
}

const SOURCE_KINDS: readonly SymptomReportSourceKind[] = [
  "session_note",
  "session_feedback",
  "chat",
  "api",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reportDate(value: unknown): string {
  const date = String(value ?? "").trim();
  return DATE_RE.test(date) ? date : localDateISO();
}

function sourceKind(value: unknown): SymptomReportSourceKind {
  const kind = String(value ?? "").trim() as SymptomReportSourceKind;
  return SOURCE_KINDS.includes(kind) ? kind : "api";
}

/**
 * The stored form of the athlete's words. Whitespace at the ends goes (it is not
 * content) and the length is clamped — nothing else is touched. No clause split, no
 * vocabulary extraction, no case folding: this string must stay something they can
 * read back and recognize as theirs.
 */
export function normalizeSymptomReportText(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length > SYMPTOM_REPORT_TEXT_MAX ? text.slice(0, SYMPTOM_REPORT_TEXT_MAX).trim() : text;
}

function hydrate(row: any): SymptomReport | null {
  if (!row) return null;
  let extraction: unknown = null;
  if (row.extraction_json != null) {
    try {
      extraction = JSON.parse(String(row.extraction_json));
    } catch {
      extraction = null;
    }
  }
  return {
    id: Number(row.id),
    symptom_event_id: row.symptom_event_id == null ? null : Number(row.symptom_event_id),
    session_id: row.session_id == null ? null : Number(row.session_id),
    text: String(row.text),
    source_kind: sourceKind(row.source_kind),
    reported_on: String(row.reported_on),
    extraction,
    extraction_status: String(row.extraction_status) as SymptomReportExtractionStatus,
    created_at: String(row.created_at ?? ""),
  };
}

export interface RecordSymptomReportInput {
  text: unknown;
  source_kind?: unknown;
  reported_on?: unknown;
  symptom_event_id?: number | null;
  session_id?: number | null;
  /** Skip the extraction queue (an already-structured write has nothing to derive). */
  extract?: boolean;
}

/**
 * Store one verbatim report. Returns null only when the text is empty — there is
 * nothing to keep.
 *
 * Deduped on (source_kind, day, exact words, session): re-finishing a session or
 * replaying an offline note delivers the same sentence again, and that is one
 * report, not two. A repeat returns the existing row and never re-queues extraction,
 * so the guard also keeps agent calls off a retry.
 */
export function recordSymptomReport(input: RecordSymptomReportInput): SymptomReport | null {
  const text = normalizeSymptomReportText(input.text);
  if (!text) return null;
  const kind = sourceKind(input.source_kind);
  const on = reportDate(input.reported_on);
  const sessionId = input.session_id == null ? null : Number(input.session_id);
  const eventId = input.symptom_event_id == null ? null : Number(input.symptom_event_id);
  const existing = db
    .prepare(
      `SELECT * FROM symptom_reports
       WHERE source_kind = ? AND reported_on = ? AND text = ? AND IFNULL(session_id, -1) = IFNULL(?, -1)
       ORDER BY id DESC LIMIT 1`
    )
    .get(kind, on, text, sessionId) as any;
  if (existing) {
    // A later delivery may finally know which event these words belong to; adopting
    // it is a strict improvement and never rewrites an attribution already made.
    if (eventId != null) {
      linkSymptomReportEvent(Number(existing.id), eventId);
      if (existing.symptom_event_id == null) {
        db.prepare(`UPDATE symptom_reports SET symptom_event_id = ? WHERE id = ?`).run(eventId, Number(existing.id));
      }
      return getSymptomReport(Number(existing.id));
    }
    return hydrate(existing);
  }
  const inserted = db
    .prepare(
      `INSERT INTO symptom_reports (symptom_event_id, session_id, text, source_kind, reported_on)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(eventId, sessionId, text, kind, on);
  if (eventId != null) linkSymptomReportEvent(Number(inserted.lastInsertRowid), eventId);
  const report = getSymptomReport(Number(inserted.lastInsertRowid))!;
  if (input.extract !== false) requestSymptomExtraction(report.id);
  return report;
}

export function getSymptomReport(id: number): SymptomReport | null {
  return hydrate(db.prepare(`SELECT * FROM symptom_reports WHERE id = ?`).get(Number(id)));
}

// Both directions of the link at once: the legacy single column AND the link table.
// Reads have to span the two because the column is the only attribution older rows
// carry, and the table is the only place a second or third watch can be named.
const EVENT_MATCH = `(
  symptom_event_id = ?
  OR id IN (SELECT symptom_report_id FROM symptom_report_events WHERE symptom_event_id = ?)
)`;

/** The athlete's latest words for one open watch — what the surface renders. */
export function latestSymptomReportForEvent(symptomEventId: number): SymptomReport | null {
  const eventId = Number(symptomEventId);
  return hydrate(
    db
      .prepare(
        `SELECT * FROM symptom_reports WHERE ${EVENT_MATCH}
         ORDER BY reported_on DESC, id DESC LIMIT 1`
      )
      .get(eventId, eventId)
  );
}

/**
 * The last day the athlete said something about this watch, on or before `through`.
 * The freshness ladder reads it, so it must see every report linked to the event —
 * not only the one the `symptom_event_id` column happens to name.
 */
export function latestSymptomReportDateForEvent(symptomEventId: number, through: string): string | null {
  const eventId = Number(symptomEventId);
  const row = db
    .prepare(
      `SELECT MAX(reported_on) AS latest FROM symptom_reports
       WHERE ${EVENT_MATCH} AND reported_on <= ?`
    )
    .get(eventId, eventId, String(through)) as any;
  return row?.latest == null ? null : String(row.latest);
}

/**
 * Whether the athlete said ANYTHING about their body on this day. The deterministic
 * half of the inferred-exposure veto: a day they spoke on is not a day silence can be
 * read as tolerance, and this must not wait on an extraction that may never run.
 */
export function hasSymptomReportsOn(date: string): boolean {
  return !!db.prepare(`SELECT 1 FROM symptom_reports WHERE reported_on = ? LIMIT 1`).get(String(date));
}

function linkSymptomReportEvent(reportId: number, symptomEventId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO symptom_report_events (symptom_report_id, symptom_event_id) VALUES (?, ?)`
  ).run(Number(reportId), Number(symptomEventId));
}

/**
 * Point these words at a watch. Repeatable: one extraction that opens two watches
 * calls this twice, and BOTH end up holding the athlete's sentence. The single
 * column keeps naming the first watch attributed — an attribution already made is
 * never rewritten — while the link table carries the rest.
 */
export function attachSymptomReportEvent(id: number, symptomEventId: number | null): void {
  const reportId = Number(id);
  if (symptomEventId == null) {
    db.prepare(`UPDATE symptom_reports SET symptom_event_id = NULL WHERE id = ?`).run(reportId);
    db.prepare(`DELETE FROM symptom_report_events WHERE symptom_report_id = ?`).run(reportId);
    return;
  }
  const eventId = Number(symptomEventId);
  linkSymptomReportEvent(reportId, eventId);
  db.prepare(
    `UPDATE symptom_reports SET symptom_event_id = ? WHERE id = ? AND symptom_event_id IS NULL`
  ).run(eventId, reportId);
}

export function setSymptomReportExtraction(
  id: number,
  status: SymptomReportExtractionStatus,
  extraction?: unknown
): void {
  if (extraction === undefined) {
    db.prepare(`UPDATE symptom_reports SET extraction_status = ? WHERE id = ?`).run(status, Number(id));
    return;
  }
  db.prepare(`UPDATE symptom_reports SET extraction_status = ?, extraction_json = ? WHERE id = ?`).run(
    status,
    extraction == null ? null : JSON.stringify(extraction),
    Number(id)
  );
}

/** Crash recovery: reports queued for extraction that never got one. */
export function listPendingSymptomReports(limit = 100): SymptomReport[] {
  return (
    db
      .prepare(`SELECT * FROM symptom_reports WHERE extraction_status = 'pending' ORDER BY id LIMIT ?`)
      .all(Number(limit)) as any[]
  )
    .map(hydrate)
    .filter((report): report is SymptomReport => report != null);
}
