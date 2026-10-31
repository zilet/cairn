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
//
// What the strict rule leaves apart, an agent may still judge (the same report
// read twice, in different words): two current studies on the same day, of the
// same modality, the same clinical system and body region, sides not
// contradicting, from different uploads. `imagingJudgeCandidates` names those
// pairs; the agent's verdict is remembered on the newer study
// (`parsed_json.dedupe_judgments`, so a pair is never asked twice); and
// `foldJudgedImagingTwins` folds a pair only on a remembered `same_study` at
// `high` confidence with no numeric measurement of one name disagreeing — through
// the same survivor, guard and source rules as the strict fold. No verdict, no fold.

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
  survivor: { id: number; label: string | null };
  merged: Array<{
    id: number;
    source_doc_id: number | null;
    removed_source: boolean;
    // the removed source was a pasted report (text), not an uploaded file
    pasted_source: boolean;
    label: string | null;
  }>;
  rule: "same_scan" | "same_scan_judged";
  // The agent's own words for a judged fold (bounded), else null.
  judged_reason: string | null;
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
  judgments: ImagingDedupeJudgment[];
  content: string; // studyContentHash: what a verdict was given about
  // the study this one's source upload was already folded into (a kept upload re-read),
  // and the content the folded study had then
  folded_into: { study: number; hash: string | null } | null;
  source_has_file: boolean; // its source upload still holds the report it was read from
}

export interface ImagingDedupeJudgment {
  other_id: number;
  same_study: boolean;
  confidence: "high" | "medium" | "low";
  reason: string | null;
  at: string;
  // the content each study had when it was judged; a verdict about other content is no verdict
  self_hash: string | null;
  other_hash: string | null;
}

// Restricts a fold to pairs a person approved, each keyed `${survivorId}:${twinId}`
// (the rule and the removed uploads are checked by applyPlannedDedupe against the plan).
export type FoldAllowList = Set<string>;

// The clinical content of one study a verdict speaks to: its study, anatomy, report,
// findings (with measurements) and recommendations. Verification, provenance and the
// remembered verdicts themselves are not content, so recording a verdict never moves it.
export function studyContentHash(study: any): string {
  const content = {
    study: study?.study ?? null,
    anatomy: study?.anatomy ?? null,
    report: study?.report ?? null,
    findings: study?.findings ?? null,
    recommendations: (Array.isArray(study?.recommendations) ? study.recommendations : []).map(
      ({ status: _status, ...rest }: any) => rest
    ),
  };
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
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

function judgmentsOf(parsed: any): ImagingDedupeJudgment[] {
  const list = Array.isArray(parsed?.dedupe_judgments) ? parsed.dedupe_judgments : [];
  return list
    .filter((j: any) => j && Number.isInteger(Number(j.other_id)) && typeof j.same_study === "boolean")
    .map((j: any) => ({
      other_id: Number(j.other_id),
      same_study: j.same_study,
      confidence: j.confidence === "high" || j.confidence === "medium" ? j.confidence : "low",
      reason: typeof j.reason === "string" ? j.reason.slice(0, 400) : null,
      at: String(j.at ?? ""),
      self_hash: typeof j.self_hash === "string" ? j.self_hash : null,
      other_hash: typeof j.other_hash === "string" ? j.other_hash : null,
    }));
}

const BUSY = new Set(["pending", "in_progress", "running", "pending_confirm"]);

function foldedIntoOf(sourceParsedJson: unknown): { study: number; hash: string | null } | null {
  try {
    const parsed = JSON.parse(String(sourceParsedJson ?? "null"));
    const target = Number(parsed?.folded_into_study);
    if (!Number.isInteger(target) || target <= 0) return null;
    return { study: target, hash: typeof parsed?.folded_study_hash === "string" ? parsed.folded_study_hash : null };
  } catch {
    return null;
  }
}

// A kept source remembers the study it folded into, so Records shows it under that
// study's card and a re-read of it folds again without asking (an inherited verdict).
function markSourceFoldedInto(sourceId: number, studyId: number, foldedContent: string): void {
  const row = db.prepare(`SELECT parsed_json FROM health_documents WHERE id = ?`).get(sourceId) as any;
  if (!row) return;
  let parsed: any = {};
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : {};
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
  parsed.folded_into_study = studyId;
  // the content of the study that folded: a re-read inherits the verdict only while it says the same
  parsed.folded_study_hash = foldedContent;
  db.prepare(`UPDATE health_documents SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), sourceId);
}

function loadStudies(): StudyRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_date, d.source_doc_id, d.parsed_json,
              (SELECT COUNT(*) FROM dicom_series s WHERE s.health_document_id = d.id) AS dicom,
              (SELECT s.enrichment_status FROM health_documents s WHERE s.id = d.source_doc_id) AS source_status,
              (SELECT s.parsed_json FROM health_documents s WHERE s.id = d.source_doc_id) AS source_parsed,
              (SELECT s.file_path FROM health_documents s WHERE s.id = d.source_doc_id) AS source_file
         FROM health_documents d
        WHERE d.kind = 'imaging'
          AND COALESCE(d.enrichment_status, '') NOT IN ('pending', 'in_progress', 'running', 'pending_confirm')
        ORDER BY d.id`
    )
    .all() as any[];
  const hashes = db.prepare(`SELECT sha256 FROM imaging_study_files WHERE health_document_id = ?`);
  const out: StudyRow[] = [];
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const study = parsed?.imaging_study ?? null;
    if (!study || typeof study !== "object") continue;
    // a study whose source upload is still being read is never folded or judged
    if (BUSY.has(String(row.source_status ?? ""))) continue;
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
      judgments: judgmentsOf(parsed),
      content: studyContentHash(study),
      folded_into: foldedIntoOf(row.source_parsed),
      source_has_file: !!row.source_file,
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

// Everything a fold asks of a twin besides being the same scan: never one the
// athlete corrected, one carrying DICOM, an attachment the survivor lacks, notes
// or follow-up tracking the survivor does not hold.
function twinMayFold(twin: StudyRow, survivor: StudyRow): boolean {
  if (twin.study?.provenance?.extraction === "corrected" || twin.dicom > 0) return false;
  for (const hash of twin.hashes) if (!survivor.hashes.has(hash)) return false;
  if (notesLost(twin.study, survivor.study)) return false;
  return !trackingDiffers(twin.study, survivor.study);
}

function foldable(twin: StudyRow, survivor: StudyRow): boolean {
  return sameScan(twin, survivor) && twinMayFold(twin, survivor);
}

// The raw bytes' hash of an upload's file (what an attachment's sha256 is).
const sourceBytesCache = new Map<number, string | null>();
function sourceBytesHash(sourceId: number | null): string | null {
  if (sourceId == null) return null;
  if (sourceBytesCache.has(sourceId)) return sourceBytesCache.get(sourceId)!;
  let hash: string | null = null;
  try {
    const fp = safeUploadPath((getHealthDocumentRaw(sourceId) as any)?.file_path);
    hash = fp && fs.existsSync(fp) ? crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex") : null;
  } catch {
    hash = null;
  }
  sourceBytesCache.set(sourceId, hash);
  return hash;
}

// An equivalent copy of the twin's source stays on the survivor's side: the same
// pasted text, or the same bytes as the survivor's own source or one of its attachments.
function sourceHasCopy(twin: StudyRow, survivor: StudyRow): boolean {
  const text = sourceTextHash(twin.source_doc_id);
  if (text != null && text === sourceTextHash(survivor.source_doc_id)) return true;
  const bytes = sourceBytesHash(twin.source_doc_id);
  if (bytes == null) return false;
  return bytes === sourceBytesHash(survivor.source_doc_id) || survivor.hashes.has(bytes);
}

// The twin's source upload goes with it only when that upload carried nothing else
// (its one derived row is this study, and it is an imaging source: a pasted report
// filed as imaging, or an imaging_only upload, never a lab panel or a note whose
// markers or facts are its own) AND an equivalent copy of it stays on the survivor's
// side. Otherwise the upload stays, with its report text, and only the study folds.
function sourceGoesWithTwin(twin: StudyRow, survivor: StudyRow): number | null {
  const sourceId = twin.source_doc_id;
  if (sourceId == null || sourceId === survivor.source_doc_id) return null;
  const source = getHealthDocumentRaw(sourceId) as any;
  if (!source?.file_path) return null;
  const children = db.prepare(`SELECT id FROM health_documents WHERE source_doc_id = ?`).all(sourceId) as any[];
  if (children.length !== 1 || Number(children[0].id) !== twin.id) return null;
  if (!imagingSourceFolds(source)) return null;
  return sourceHasCopy(twin, survivor) ? sourceId : null;
}

function clearSourceCaches(): void {
  sourceTextCache.clear();
  sourceBytesCache.clear();
}

function studyLabel(row: StudyRow): string | null {
  const procedure = String(row.study?.study?.procedure ?? "").replace(/\s+/g, " ").trim();
  return procedure ? procedure.slice(0, 120) : null;
}

function foldTwins(
  survivor: StudyRow,
  twins: StudyRow[],
  opts: { dryRun?: boolean },
  result: ImagingDedupeResult,
  judged: { reason: string | null } | null = null
): void {
  const fold: ImagingDedupeFold = {
    date: survivor.date,
    survivor: { id: survivor.id, label: studyLabel(survivor) },
    merged: [],
    rule: judged ? "same_scan_judged" : "same_scan",
    judged_reason: judged?.reason ?? null,
  };
  for (const twin of twins) {
    const sourceId = sourceGoesWithTwin(twin, survivor);
    const pasted = sourceId != null && (getHealthDocumentRaw(sourceId) as any)?.mime === "text/plain";
    if (!opts.dryRun) {
      const deleted = (
        sourceId != null
          ? deleteHealthDocument(sourceId, { withdraw: false })
          : deleteImagingStudy(twin.id, { keepSource: true })
      ) as any;
      if (deleted?.error || !deleted?.deleted) {
        result.errors.push(`imaging#${twin.id}: ${deleted?.error ?? "not deleted"}`);
        break;
      }
      if (sourceId != null) result.deleted_files++;
      // the upload stays (no copy of it on the survivor's side): it reads under the
      // survivor's card from now on, never as a stray card of its own
      else if (twin.source_doc_id != null && twin.source_doc_id !== survivor.source_doc_id) {
        const source = getHealthDocumentRaw(twin.source_doc_id) as any;
        const left = db.prepare(`SELECT 1 FROM health_documents WHERE source_doc_id = ? LIMIT 1`).get(twin.source_doc_id);
        if (source && !left && imagingSourceFolds(source)) {
          markSourceFoldedInto(twin.source_doc_id, survivor.id, twin.content);
        }
      }
    }
    fold.merged.push({
      id: twin.id,
      source_doc_id: twin.source_doc_id,
      removed_source: sourceId != null,
      pasted_source: pasted,
      label: studyLabel(twin),
    });
  }
  if (fold.merged.length) {
    result.folds.push(fold);
    result.merged += fold.merged.length;
  }
}

export function dedupeImagingStudies(
  opts: { dryRun?: boolean; scopeSourceId?: number | null; allow?: FoldAllowList } = {}
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
  clearSourceCaches();
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
        const approved = opts.allow
          ? twins.filter((row) => opts.allow!.has(`${survivor.id}:${row.id}`))
          : twins;
        if (!approved.length) continue;
        if (scope != null && !cluster.some((row) => row.id === scope || row.source_doc_id === scope)) continue;
        foldTwins(survivor, approved, opts, result);
      }
      if (result.errors.length) break;
    }
  } finally {
    clearSourceCaches();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Near-twins the strict rule leaves apart, judged by an agent.

const SIDES = new Set(["left", "right", "bilateral"]);
const UNSTATED_SYSTEM = new Set(["", "unknown", "other"]);

export interface ImagingJudgeCandidate {
  older: { id: number; source_doc_id: number | null; content: string };
  newer: { id: number; source_doc_id: number | null; content: string };
  date: string;
}

function lateralityContradicts(a: StudyRow, b: StudyRow): boolean {
  const la = norm(a.study?.anatomy?.laterality);
  const lb = norm(b.study?.anatomy?.laterality);
  return SIDES.has(la) && SIDES.has(lb) && la !== lb;
}

// Same day, same modality, same clinical system and body region (all stated),
// sides not contradicting, from two different uploads.
function nearTwin(a: StudyRow, b: StudyRow): boolean {
  if (a.date !== b.date) return false;
  if (a.source_doc_id != null && a.source_doc_id === b.source_doc_id) return false;
  const modality = norm(a.study?.study?.modality);
  if (!modality || modality === "unknown" || modality !== norm(b.study?.study?.modality)) return false;
  const system = norm(a.study?.anatomy?.clinical_system);
  if (UNSTATED_SYSTEM.has(system) || system !== norm(b.study?.anatomy?.clinical_system)) return false;
  const region = norm(a.study?.anatomy?.body_region);
  if (UNSTATED_ANATOMY.has(region) || region !== norm(b.study?.anatomy?.body_region)) return false;
  return !lateralityContradicts(a, b);
}

// The remembered verdict on this pair, ONLY while both studies still hold the
// content it was given about: an edit to either makes the pair unjudged again.
function judgmentFor(a: StudyRow, b: StudyRow): ImagingDedupeJudgment | null {
  const holds = (j: ImagingDedupeJudgment, self: StudyRow, other: StudyRow) =>
    j.other_id === other.id && j.self_hash === self.content && j.other_hash === other.content;
  const remembered = a.judgments.find((j) => holds(j, a, b)) ?? b.judgments.find((j) => holds(j, b, a)) ?? null;
  if (remembered) return remembered;
  // a re-read of an upload already folded into this study: the earlier verdict stands
  // (the content guards below still apply), so it is never asked about again, but only
  // while the re-read says exactly what the folded study said; otherwise it is unjudged
  const inherits = (row: StudyRow, other: StudyRow) =>
    row.folded_into?.study === other.id && row.folded_into.hash != null && row.folded_into.hash === row.content;
  if (inherits(a, b) || inherits(b, a)) {
    return {
      other_id: inherits(a, b) ? b.id : a.id,
      same_study: true,
      confidence: "high",
      reason: "This report was merged with this study before.",
      at: "",
      self_hash: null,
      other_hash: null,
    };
  }
  return null;
}

// How much a study says: findings, measurements, recommendations and report sections.
function contentWeight(study: any): number {
  const findings = Array.isArray(study?.findings) ? study.findings : [];
  const measures = findings.reduce(
    (n: number, f: any) => n + (Array.isArray(f?.measurements) ? f.measurements.length : 0),
    0
  );
  const recs = Array.isArray(study?.recommendations) ? study.recommendations.length : 0;
  const report = Object.values(study?.report ?? {}).filter((v) => typeof v === "string" && v.trim()).length;
  return findings.length + measures + recs + report;
}

// A judged fold keeps the FULLER study (what the athlete confirmed or corrected
// first, then attachments, then the most content, then the oldest).
function judgedRank(row: StudyRow): number[] {
  return [userTouched(row.study) ? 1 : 0, row.hashes.size ? 1 : 0, contentWeight(row.study), -row.id];
}

function pickJudgedSurvivor(a: StudyRow, b: StudyRow): StudyRow {
  const ra = judgedRank(a);
  const rb = judgedRank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b;
  return a;
}

// Everything the twin says, the survivor already says: each finding's text, each
// measurement by name, qualifier and value, each recommendation's text. Two
// wordings of one report fold only when nothing the twin holds would be lost.
function twinContentCovered(twin: any, survivor: any): boolean {
  const texts = (list: unknown, field: string) =>
    new Set((Array.isArray(list) ? list : []).map((x: any) => norm(x?.[field])).filter(Boolean));
  const survivorFindings = texts(survivor?.findings, "finding_text");
  for (const text of texts(twin?.findings, "finding_text")) if (!survivorFindings.has(text)) return false;
  const survivorRecs = texts(survivor?.recommendations, "recommendation_text");
  for (const text of texts(twin?.recommendations, "recommendation_text")) if (!survivorRecs.has(text)) return false;
  const mine = measurementsOf(survivor);
  for (const [key, values] of measurementsOf(twin)) {
    const theirs = mine.get(key);
    if (!theirs) return false;
    for (const value of values) if (!theirs.some((other) => sameMeasure(value, other))) return false;
  }
  return true;
}

// The pairs worth an agent's judgement: near-twins the strict rule would not fold
// (it folds those itself) and whose twin could fold at all (a corrected study,
// one carrying DICOM or attachments the survivor lacks, is never folded, so
// asking about it is wasted). `scopeId` narrows to pairs touching that study or
// the studies derived from that upload. Each pair is [older, newer].
function candidatePairs(studies: StudyRow[], scopeId: number | null): Array<[StudyRow, StudyRow]> {
  const out: Array<[StudyRow, StudyRow]> = [];
  const touches = (row: StudyRow) => scopeId == null || row.id === scopeId || row.source_doc_id === scopeId;
  for (let i = 0; i < studies.length; i++) {
    for (let j = i + 1; j < studies.length; j++) {
      const a = studies[i];
      const b = studies[j];
      if (!touches(a) && !touches(b)) continue;
      if (!nearTwin(a, b)) continue;
      if (a.key === b.key && sameScan(a, b)) continue;
      const survivor = pickJudgedSurvivor(a, b);
      const twin = survivor === a ? b : a;
      if (!twinMayFold(twin, survivor)) continue;
      // a fold that would lose what only the twin says is never made, so never asked
      if (!twinContentCovered(twin.study, survivor.study)) continue;
      // nor one that would lose its narrative: the twin's own words (impression,
      // findings prose) live on only in its source upload, which the fold keeps or
      // copies, so a twin with no source report on file never folds by judgement
      if (twin.source_doc_id == null || !twin.source_has_file) continue;
      out.push(a.id < b.id ? [a, b] : [b, a]);
    }
  }
  return out;
}

export function imagingJudgeCandidates(opts: { scopeId?: number | null } = {}): ImagingJudgeCandidate[] {
  const scope = opts.scopeId == null ? null : Number(opts.scopeId);
  clearSourceCaches();
  try {
    return candidatePairs(loadStudies(), scope)
      .filter(([a, b]) => !judgmentFor(a, b))
      .map(([older, newer]) => ({
        older: { id: older.id, source_doc_id: older.source_doc_id, content: older.content },
        newer: { id: newer.id, source_doc_id: newer.source_doc_id, content: newer.content },
        date: older.date,
      }));
  } finally {
    clearSourceCaches();
  }
}

function currentStudy(id: number): { parsed: any; study: any; status: string } | null {
  const row = db
    .prepare(`SELECT parsed_json, enrichment_status FROM health_documents WHERE id = ? AND kind = 'imaging'`)
    .get(id) as any;
  if (!row) return null;
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.imaging_study) return null;
  return { parsed, study: parsed.imaging_study, status: String(row.enrichment_status ?? "") };
}

// Remember one verdict on the newer study, so the pair is never asked again, with the
// content hash of BOTH studies as they were judged. `expected` is the content the
// agent was shown: when either study changed meanwhile (an edit during the call) the
// verdict is about something that no longer exists and is not written. A direct
// write of the bookkeeping field only: nothing clinical moves, so neither the marker
// series nor the brain signals are disturbed.
export function recordImagingDedupeJudgment(
  olderId: number,
  newerId: number,
  verdict: { same_study: boolean; confidence: "high" | "medium" | "low"; reason?: string | null },
  expected: { older: string; newer: string } | null = null
): boolean {
  const older = currentStudy(olderId);
  const newer = currentStudy(newerId);
  if (!older || !newer) return false;
  // A study whose read started meanwhile is left untouched (the write would make
  // that read stale); the pair is simply asked again on a later pass.
  if (BUSY.has(newer.status) || BUSY.has(older.status)) return false;
  const olderHash = studyContentHash(older.study);
  const newerHash = studyContentHash(newer.study);
  if (expected && (expected.older !== olderHash || expected.newer !== newerHash)) return false;
  const parsed = newer.parsed;
  const kept = (Array.isArray(parsed.dedupe_judgments) ? parsed.dedupe_judgments : []).filter(
    (j: any) => Number(j?.other_id) !== olderId
  );
  kept.push({
    other_id: olderId,
    same_study: verdict.same_study === true,
    confidence: verdict.confidence,
    reason: verdict.reason ? String(verdict.reason).replace(/\s+/g, " ").trim().slice(0, 400) : null,
    at: new Date().toISOString(),
    self_hash: newerHash,
    other_hash: olderHash,
  });
  parsed.dedupe_judgments = kept.slice(-40);
  db.prepare(`UPDATE health_documents SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), newerId);
  return true;
}

// What an agent is shown of one study: its own words, bounded.
export function imagingJudgeView(id: number): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT id, doc_date, source_doc_id, parsed_json FROM health_documents WHERE id = ?`)
    .get(id) as any;
  if (!row) return null;
  let study: any = null;
  try {
    study = row.parsed_json ? JSON.parse(row.parsed_json)?.imaging_study : null;
  } catch {
    study = null;
  }
  if (!study || typeof study !== "object") return null;
  const clip = (value: unknown, max: number) => {
    const s = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return s ? s.slice(0, max) : null;
  };
  let excerpt: string | null = null;
  try {
    const source = row.source_doc_id == null ? null : (getHealthDocumentRaw(Number(row.source_doc_id)) as any);
    const fp = source?.mime === "text/plain" ? safeUploadPath(source.file_path) : null;
    if (fp && fs.existsSync(fp)) excerpt = clip(fs.readFileSync(fp, "utf8"), 3000);
  } catch {
    excerpt = null;
  }
  return {
    study_date: study.study?.study_date ?? row.doc_date ?? null,
    modality: study.study?.modality ?? null,
    procedure: clip(study.study?.procedure, 240),
    anatomy: {
      clinical_system: study.anatomy?.clinical_system ?? null,
      body_region: study.anatomy?.body_region ?? null,
      laterality: study.anatomy?.laterality ?? null,
    },
    impression: clip(study.report?.impression, 1500),
    findings_text: clip(study.report?.findings, 1500),
    findings: (Array.isArray(study.findings) ? study.findings : []).slice(0, 12).map((f: any) => ({
      text: clip(f?.finding_text, 300),
      measurements: (Array.isArray(f?.measurements) ? f.measurements : []).slice(0, 8).map((m: any) => ({
        name: m?.name ?? null,
        value: m?.value ?? m?.value_text ?? null,
        unit: m?.unit ?? null,
        qualifier: m?.qualifier ?? null,
      })),
    })),
    source_excerpt: excerpt,
  };
}

// Numeric measurements by name and qualifier, lengths in one unit.
const LENGTH_TO_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000 };
function measurementsOf(study: any): Map<string, Array<{ value: number; unit: string | null }>> {
  const out = new Map<string, Array<{ value: number; unit: string | null }>>();
  for (const finding of Array.isArray(study?.findings) ? study.findings : []) {
    for (const m of Array.isArray(finding?.measurements) ? finding.measurements : []) {
      const name = norm(m?.name);
      if (!name || typeof m?.value !== "number" || !Number.isFinite(m.value)) continue;
      let unit: string | null = norm(m?.unit) || null;
      let value = m.value;
      if (unit && LENGTH_TO_MM[unit] != null) {
        value *= LENGTH_TO_MM[unit];
        unit = "mm";
      }
      const key = `${name}|${norm(m?.qualifier)}`;
      const list = out.get(key) ?? [];
      list.push({ value, unit });
      out.set(key, list);
    }
  }
  return out;
}

function sameMeasure(x: { value: number; unit: string | null }, y: { value: number; unit: string | null }): boolean {
  if (x.unit && y.unit && x.unit !== y.unit) return false; // units that do not convert never agree
  const scale = Math.max(Math.abs(x.value), Math.abs(y.value));
  return scale === 0 ? x.value === y.value : Math.abs(x.value - y.value) <= scale * 0.005;
}

// True when a measurement both studies name disagrees: whatever an agent thought,
// two different numbers for one thing are two readings, and both are kept.
export function measurementsContradict(a: any, b: any): boolean {
  const ma = measurementsOf(a);
  const mb = measurementsOf(b);
  for (const [key, xs] of ma) {
    const ys = mb.get(key);
    if (!ys) continue;
    const [small, large] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
    for (const x of small) if (!large.some((y) => sameMeasure(x, y))) return true;
  }
  return false;
}

// Fold the pairs an agent already judged the same study at high confidence, with no
// measurement disagreeing and nothing only the twin says (twinContentCovered), into
// the fuller study, through the strict fold's own guard and source rules.
// Deterministic given the remembered verdicts: no agent runs here.
export function foldJudgedImagingTwins(
  opts: { dryRun?: boolean; scopeId?: number | null; exclude?: Set<number>; allow?: FoldAllowList } = {}
): ImagingDedupeResult {
  const scope = opts.scopeId == null ? null : Number(opts.scopeId);
  clearSourceCaches();
  const result: ImagingDedupeResult = { scanned: 0, folds: [], merged: 0, deleted_files: 0, errors: [] };
  try {
    const studies = loadStudies();
    result.scanned = studies.length;
    // studies another fold already takes (a dry run leaves them in place)
    const gone = new Set<number>(opts.exclude ?? []);
    for (const [a, b] of candidatePairs(studies, scope)) {
      if (result.errors.length) break;
      if (gone.has(a.id) || gone.has(b.id)) continue;
      const verdict = judgmentFor(a, b);
      if (!verdict?.same_study || verdict.confidence !== "high") continue;
      if (measurementsContradict(a.study, b.study)) continue;
      const survivor = pickJudgedSurvivor(a, b);
      const twin = survivor === a ? b : a;
      if (opts.allow && !opts.allow.has(`${survivor.id}:${twin.id}`)) continue;
      const before = result.merged;
      foldTwins(survivor, [twin], opts, result, { reason: verdict.reason });
      if (result.merged > before) gone.add(twin.id);
    }
  } finally {
    clearSourceCaches();
  }
  return result;
}
