// The same report, pasted or uploaded twice, is ONE record.
//
// A re-paste of a report already on file used to become a second document and
// a second multi-minute agent ingest that could only produce a twin. The upload
// route asks this module first: an exact-content match against a stored upload
// answers "already on file" instead of writing anything.
//
// No hash column, on purpose. The comparison reads the stored uploads on the
// fly, which is cheap because it is bounded:
//   - a paste is compared only with stored PASTES (text/plain, capped at
//     400 KB each on write) — the most recent MAX_TEXT_CANDIDATES of them — after
//     whitespace normalization, so a re-copy that differs only in line breaks
//     still matches;
//   - a file is compared only with stored files of the SAME byte size (a stat,
//     no read), and an imaging attachment through the sha256 its row already
//     carries.
// It also works for every upload already on disk, with no backfill migration.
//
// Content is necessary, never enough. A short paste is a reading, not a report:
// "BP 120/80" pasted on a later day is a NEW reading, so a paste below
// MIN_DUPLICATE_TEXT_CHARS never matches. And when the request states a date or a
// kind, a match must agree on it — the same text filed under another date is
// another record.

import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "../db.js";
import { normalizeHealthDocumentKind } from "../healthDocumentKinds.js";
import { safeUploadPath } from "../uploadPaths.js";

const MAX_TEXT_CANDIDATES = 200;
const MAX_FILE_CANDIDATES = 500;
const MAX_TEXT_BYTES = 1024 * 1024;
/** A paste shorter than this (whitespace-normalized) is a reading, never "already on file". */
export const MIN_DUPLICATE_TEXT_CHARS = 200;

export function normalizedUploadText(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Rows that are records (a chat paste awaiting confirm is not one yet).
const RECORD_ROWS = `file_path IS NOT NULL AND COALESCE(enrichment_status, '') != 'pending_confirm'`;

function storedFile(row: { file_path?: unknown }): string | null {
  const fp = safeUploadPath(row.file_path as string);
  return fp && fs.existsSync(fp) ? fp : null;
}

// What the request itself states about the record; a match must agree on each.
// "other" is the route's own default, not a statement, so it never narrows.
function statedFilter(input: { kind?: unknown; doc_date?: unknown }, alias = ""): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  const kind = input.kind != null && String(input.kind).trim() ? normalizeHealthDocumentKind(input.kind) : "other";
  if (kind !== "other") {
    parts.push(`${alias}kind = ?`);
    args.push(kind);
  }
  if (input.doc_date != null && String(input.doc_date).trim()) {
    parts.push(`COALESCE(${alias}doc_date, '') = ?`);
    args.push(String(input.doc_date).trim().slice(0, 10));
  }
  return { sql: parts.map((part) => ` AND ${part}`).join(""), args };
}

// The id of the health document whose stored upload has exactly this content,
// or null. `text` is a paste; `bytes` is a file upload. `kind` / `doc_date` are
// what the request stated, if anything.
export function findDuplicateHealthUpload(input: {
  text?: string | null;
  bytes?: Buffer | null;
  kind?: unknown;
  doc_date?: unknown;
}): number | null {
  const stated = statedFilter(input);
  if (input.text != null) {
    const text = normalizedUploadText(input.text);
    if (text.length < MIN_DUPLICATE_TEXT_CHARS) return null;
    const want = sha256(text);
    const rows = db
      .prepare(
        `SELECT id, file_path FROM health_documents WHERE ${RECORD_ROWS} AND mime = 'text/plain'${stated.sql} ORDER BY id DESC LIMIT ?`
      )
      .all(...stated.args, MAX_TEXT_CANDIDATES) as any[];
    for (const row of rows) {
      const fp = storedFile(row);
      if (!fp) continue;
      try {
        if (fs.statSync(fp).size > MAX_TEXT_BYTES) continue;
        if (sha256(normalizedUploadText(fs.readFileSync(fp, "utf8"))) === want) return Number(row.id);
      } catch {
        /* an unreadable upload is simply not a match */
      }
    }
    return null;
  }
  const bytes = input.bytes;
  if (!bytes?.length) return null;
  let want: string | null = null;
  const rows = db
    .prepare(`SELECT id, file_path FROM health_documents WHERE ${RECORD_ROWS}${stated.sql} ORDER BY id DESC LIMIT ?`)
    .all(...stated.args, MAX_FILE_CANDIDATES) as any[];
  for (const row of rows) {
    const fp = storedFile(row);
    if (!fp) continue;
    try {
      if (fs.statSync(fp).size !== bytes.length) continue;
      want ??= sha256(bytes);
      if (sha256(fs.readFileSync(fp)) === want) return Number(row.id);
    } catch {
      /* an unreadable upload is simply not a match */
    }
  }
  want ??= sha256(bytes);
  const attachedStated = statedFilter(input, "d.");
  const attachment = db
    .prepare(
      `SELECT f.health_document_id AS id FROM imaging_study_files f
         JOIN health_documents d ON d.id = f.health_document_id
        WHERE f.sha256 = ? AND f.size_bytes = ?${attachedStated.sql}
        ORDER BY f.health_document_id DESC LIMIT 1`
    )
    .get(want, bytes.length, ...attachedStated.args) as any;
  return attachment ? Number(attachment.id) : null;
}
