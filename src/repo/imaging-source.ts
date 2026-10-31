// Which upload is the SOURCE of an imaging study, and when it reads through it.
//
// A pasted or uploaded radiology report becomes two rows: the upload (its file,
// its read) and the study derived from it. Records shows such an upload THROUGH
// its study — one scan, one card — and the study card's delete takes the upload
// with it once nothing else was derived from it. Both decisions are made here, on
// the server, from the stored rows; the client only reads the flag
// (`folds_into_study`) the API row carries.
//
// Depends on nothing but the db, so health.ts (the API row) and imaging.ts (the
// study delete) can both ask without an import cycle.

import { db } from "../db.js";

function parsedOf(row: any): any | null {
  if (!row) return null;
  if (row.parsed && typeof row.parsed === "object") return row.parsed;
  if (!row.parsed_json) return null;
  try {
    return typeof row.parsed_json === "string" ? JSON.parse(row.parsed_json) : row.parsed_json;
  } catch {
    return null;
  }
}

function hasItems(list: unknown): boolean {
  return Array.isArray(list) && list.length > 0;
}

function isImagingStudyRow(row: any): boolean {
  if (!row || row.kind !== "imaging") return false;
  const study = parsedOf(row)?.imaging_study;
  return !!study && typeof study === "object";
}

// An upload whose contents turned out to be an imaging report (a pasted CT
// report, say) is filed with kind 'imaging' by the ordinary ingest, yet it is not
// a study: it owns the uploaded file on its own row, no study attachments and no
// imaging_study of its own — the study it carried is a derived row pointing back
// at it. It re-reads, deletes and dedupes as the upload it is, never as a study.
export function isImagingSourceUpload(row: any): boolean {
  if (!row || row.kind !== "imaging" || !row.file_path) return false;
  if (isImagingStudyRow(row)) return false;
  return !db.prepare("SELECT 1 FROM imaging_study_files WHERE health_document_id = ? LIMIT 1").get(Number(row.id));
}

/**
 * True for a source upload whose only output is the imaging studies it produced — a
 * pasted or uploaded radiology report filed under another kind. The health ingest marks
 * it (`imaging_only`) only when it carries no markers and no clinical facts of its own.
 */
export function isImagingOnlySource(row: any): boolean {
  if (!row || row.kind === "imaging") return false;
  const parsed = parsedOf(row);
  if (parsed?.imaging_only !== true) return false;
  return !hasItems(parsed.markers) && !hasItems(parsed.clinical_facts);
}

/**
 * An upload that exists to carry imaging studies: a pasted report filed as imaging (its
 * clinical facts are the report's own, so they may stand), or an `imaging_only` source.
 * Never one with lab markers — those are a record of their own.
 */
export function imagingSourceFolds(row: any): boolean {
  if (!row || hasItems(parsedOf(row)?.markers)) return false;
  return isImagingSourceUpload(row) || isImagingOnlySource(row);
}

/**
 * Records shows this upload through its study card: it is an imaging source (above), and
 * every row derived from it — superseded studies kept for audit included — is an imaging
 * study. An upload that also split out a lab panel or a note keeps its own card.
 */
export function foldsIntoStudy(row: any): boolean {
  if (row?.id == null || !imagingSourceFolds(row)) return false;
  const derived = db
    .prepare("SELECT kind, parsed_json FROM health_documents WHERE source_doc_id = ?")
    .all(Number(row.id)) as any[];
  if (derived.length > 0) return derived.every(isImagingStudyRow);
  // Its own study folded into a twin and the upload was kept (its text had no copy
  // on the twin's side): it is shown under the study that absorbed it, while that
  // study is still on file.
  return foldedIntoStudyId(row) != null;
}

/**
 * The study a kept imaging source was folded into (`parsed.folded_into_study`, set by
 * the imaging dedupe), while that study is still a current imaging study; else null.
 */
export function foldedIntoStudyId(row: any): number | null {
  const target = Number(parsedOf(row)?.folded_into_study);
  if (!Number.isInteger(target) || target <= 0) return null;
  const study = db.prepare("SELECT kind, parsed_json FROM health_documents WHERE id = ?").get(target) as any;
  return isImagingStudyRow(study) ? target : null;
}
