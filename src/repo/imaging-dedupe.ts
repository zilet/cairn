// One study per scan.
//
// The same imaging report pasted twice used to become two source uploads, each
// with its own derived study: one CT, two identical cards. Two studies are the
// same scan when they are dated the same day, name the same procedure, carry the
// same impression (compared case- and whitespace-insensitively), AND either name
// the same body region and laterality (both stated) or were read out of two
// uploads of identical text. Anything less is not identity — a same-day left and
// right knee X-ray share a date, a procedure and a "normal" impression; two
// studies split out of ONE upload are distinct by construction; and studies whose
// impressions differ (a re-read, an amendment) never fold.
//
// The fold is conservative because the delete is irreversible: a twin the
// athlete corrected, a twin carrying DICOM series, a twin with an attachment the
// survivor does not hold, a twin whose follow-up tracking says something the
// survivor's does not, or a twin with confirmation notes the survivor lacks, is
// left alone. The survivor is the study the athlete
// already worked with (confirmed or corrected), else the one holding attachments,
// else the oldest. A twin whose source upload exists only to carry it (a pasted
// report with nothing else split out of it) goes WITH that upload, so no orphan
// paste is left behind to show up as its own card.

import fs from "node:fs";
import crypto from "node:crypto";
import { db } from "../db.js";
import { safeUploadPath } from "../uploadPaths.js";
import { deleteHealthDocument, getHealthDocumentRaw } from "./health.js";
import { normalizedUploadText } from "./health-upload-duplicate.js";
import { deleteImagingStudy } from "./imaging.js";
import { imagingSourceFolds } from "./imaging-source.js";

export interface ImagingDedupeFold {
  date: string;
  survivor: { id: number };
  merged: Array<{ id: number; source_doc_id: number | null; removed_source: boolean }>;
}

export interface ImagingDedupeResult {
  scanned: number;
  folds: ImagingDedupeFold[];
  merged: number;
  deleted_files: number;
  errors: string[];
}

interface StudyRow {
  id: number;
  date: string;
  source_doc_id: number | null;
  key: string;
  // "region|laterality" when the study states both, else null (says nothing).
  anatomy: string | null;
  study: any;
  hashes: Set<string>;
  dicom: number;
}

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.;,:]+$/, "")
    .trim();
}

const UNSTATED_ANATOMY = new Set(["", "unknown", "other", "not stated", "unsorted imaging"]);

function anatomyKey(study: any): string | null {
  const region = norm(study?.anatomy?.body_region);
  const laterality = norm(study?.anatomy?.laterality);
  if (UNSTATED_ANATOMY.has(region) || UNSTATED_ANATOMY.has(laterality)) return null;
  return `${region}|${laterality}`;
}

// The normalized text of a study's source upload, when that upload is a paste.
const sourceTextCache = new Map<number, string | null>();
function sourceTextHash(sourceId: number | null): string | null {
  if (sourceId == null) return null;
  if (sourceTextCache.has(sourceId)) return sourceTextCache.get(sourceId)!;
  let hash: string | null = null;
  try {
    const row = getHealthDocumentRaw(sourceId) as any;
    const fp = row?.mime === "text/plain" ? safeUploadPath(row.file_path) : null;
    const text = fp && fs.existsSync(fp) ? normalizedUploadText(fs.readFileSync(fp, "utf8")) : "";
    hash = text ? crypto.createHash("sha256").update(text).digest("hex") : null;
  } catch {
    hash = null;
  }
  sourceTextCache.set(sourceId, hash);
  return hash;
}

// Same date, procedure and impression (the group key) is necessary, never enough.
function sameScan(a: StudyRow, b: StudyRow): boolean {
  if (a.anatomy && a.anatomy === b.anatomy) return true;
  if (a.source_doc_id == null || b.source_doc_id == null || a.source_doc_id === b.source_doc_id) return false;
  const text = sourceTextHash(a.source_doc_id);
  return text != null && text === sourceTextHash(b.source_doc_id);
}

function userTouched(study: any): boolean {
  return study?.verification?.user_confirmed === true || study?.provenance?.extraction === "corrected";
}

function loadStudies(): StudyRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_date, d.source_doc_id, d.parsed_json,
              (SELECT COUNT(*) FROM dicom_series s WHERE s.health_document_id = d.id) AS dicom
         FROM health_documents d
        WHERE d.kind = 'imaging'
          AND COALESCE(d.enrichment_status, '') NOT IN ('pending', 'in_progress', 'running', 'pending_confirm')
        ORDER BY d.id`
    )
    .all() as any[];
  const hashes = db.prepare(`SELECT sha256 FROM imaging_study_files WHERE health_document_id = ?`);
  const out: StudyRow[] = [];
  for (const row of rows) {
    let study: any = null;
    try {
      study = row.parsed_json ? JSON.parse(row.parsed_json)?.imaging_study : null;
    } catch {
      study = null;
    }
    if (!study || typeof study !== "object") continue;
    const status = study.provenance?.record_status;
    if (status && status !== "current") continue;
    const date = String(study.study?.study_date || row.doc_date || "").slice(0, 10);
    const procedure = norm(study.study?.procedure);
    const impression = norm(study.report?.impression);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !procedure || !impression) continue;
    out.push({
      id: Number(row.id),
      date,
      source_doc_id: row.source_doc_id == null ? null : Number(row.source_doc_id),
      key: `${date}|${procedure}|${impression}`,
      anatomy: anatomyKey(study),
      study,
      hashes: new Set((hashes.all(row.id) as any[]).map((file) => String(file.sha256))),
      dicom: Number(row.dicom ?? 0),
    });
  }
  return out;
}

function rank(row: StudyRow): number[] {
  return [userTouched(row.study) ? 1 : 0, row.hashes.size ? 1 : 0, -row.id];
}

function pickSurvivor(rows: StudyRow[]): StudyRow {
  return rows.reduce((best, row) => {
    const a = rank(row);
    const b = rank(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? row : best;
    return best;
  });
}

// The athlete's own tracking on a follow-up the survivor does not echo.
function trackingDiffers(twin: any, survivor: any): boolean {
  const mine = new Map<string, string>();
  for (const rec of Array.isArray(survivor?.recommendations) ? survivor.recommendations : []) {
    mine.set(norm(rec?.recommendation_text), String(rec?.status ?? "unknown"));
  }
  for (const rec of Array.isArray(twin?.recommendations) ? twin.recommendations : []) {
    const status = String(rec?.status ?? "unknown");
    if (status === "recommended" || status === "unknown") continue;
    if (mine.get(norm(rec?.recommendation_text)) !== status) return true;
  }
  return false;
}

// A note the athlete wrote when confirming the twin that the survivor does not hold
// would be lost with the twin.
function notesLost(twin: any, survivor: any): boolean {
  const mine = norm(twin?.verification?.notes);
  return !!mine && !norm(survivor?.verification?.notes).includes(mine);
}

function foldable(twin: StudyRow, survivor: StudyRow): boolean {
  if (twin.study?.provenance?.extraction === "corrected" || twin.dicom > 0) return false;
  if (!sameScan(twin, survivor)) return false;
  for (const hash of twin.hashes) if (!survivor.hashes.has(hash)) return false;
  if (notesLost(twin.study, survivor.study)) return false;
  return !trackingDiffers(twin.study, survivor.study);
}

// The twin's source upload goes with it when that upload carried nothing else:
// its one derived row is this study, and it is an imaging source (a pasted report
// filed as imaging, or an imaging_only upload) — never a lab panel, and never a
// note whose markers or clinical facts (a medication, a diagnosis) are its own.
function sourceGoesWithTwin(twin: StudyRow, survivor: StudyRow): number | null {
  const sourceId = twin.source_doc_id;
  if (sourceId == null || sourceId === survivor.source_doc_id) return null;
  const source = getHealthDocumentRaw(sourceId) as any;
  if (!source?.file_path) return null;
  const children = db.prepare(`SELECT id FROM health_documents WHERE source_doc_id = ?`).all(sourceId) as any[];
  if (children.length !== 1 || Number(children[0].id) !== twin.id) return null;
  return imagingSourceFolds(source) ? sourceId : null;
}

function foldTwins(
  survivor: StudyRow,
  twins: StudyRow[],
  opts: { dryRun?: boolean },
  result: ImagingDedupeResult
): void {
  const fold: ImagingDedupeFold = { date: survivor.date, survivor: { id: survivor.id }, merged: [] };
  for (const twin of twins) {
    const sourceId = sourceGoesWithTwin(twin, survivor);
    if (!opts.dryRun) {
      const deleted = (sourceId != null ? deleteHealthDocument(sourceId) : deleteImagingStudy(twin.id)) as any;
      if (deleted?.error || !deleted?.deleted) {
        result.errors.push(`imaging#${twin.id}: ${deleted?.error ?? "not deleted"}`);
        break;
      }
      if (sourceId != null) result.deleted_files++;
    }
    fold.merged.push({ id: twin.id, source_doc_id: twin.source_doc_id, removed_source: sourceId != null });
  }
  if (fold.merged.length) {
    result.folds.push(fold);
    result.merged += fold.merged.length;
  }
}

export function dedupeImagingStudies(
  opts: { dryRun?: boolean; scopeSourceId?: number | null } = {}
): ImagingDedupeResult {
  const studies = loadStudies();
  const result: ImagingDedupeResult = { scanned: studies.length, folds: [], merged: 0, deleted_files: 0, errors: [] };
  const groups = new Map<string, StudyRow[]>();
  for (const row of studies) {
    const group = groups.get(row.key) ?? [];
    group.push(row);
    groups.set(row.key, group);
  }
  const scope = opts.scopeSourceId == null ? null : Number(opts.scopeSourceId);
  sourceTextCache.clear();
  try {
    for (const group of groups.values()) {
      // One date/procedure/impression group can hold several scans (a left and a
      // right knee): take the survivor, fold only what is the same scan as it,
      // and look again among what is left.
      let rest = group;
      while (rest.length >= 2 && !result.errors.length) {
        const survivor = pickSurvivor(rest);
        const twins = rest.filter((row) => row.id !== survivor.id && foldable(row, survivor));
        const cluster = [survivor, ...twins];
        rest = rest.filter((row) => row.id !== survivor.id && !twins.includes(row));
        if (!twins.length) continue;
        if (scope != null && !cluster.some((row) => row.id === scope || row.source_doc_id === scope)) continue;
        foldTwins(survivor, twins, opts, result);
      }
      if (result.errors.length) break;
    }
  } finally {
    sourceTextCache.clear();
  }
  return result;
}
