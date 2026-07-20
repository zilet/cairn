import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { db } from "./db.js";
import {
  DICOM_LIMITS,
  DicomImportError,
  decodeDicomFrame,
  dicomFramePng,
  hasPart10Preamble,
  parseDicomPart10,
  type ParsedDicomInstance,
} from "./dicom.js";
import {
  addImagingStudyFile,
  coerceImagingStudy,
  createImagingStudy,
  getImagingStudy,
  normalizeImagingBodyRegion,
  normalizeImagingClinicalSystem,
  normalizeImagingModality,
  recoverImagingQuarantines,
} from "./repo/imaging.js";
import { getHealthDocumentRaw, setHealthDocEnrichStatus, updateHealthDocFields } from "./repo/health.js";
import { getSettings } from "./repo/settings.js";
import { DATA_DIR, UPLOADS_DIR, safeUploadPath } from "./uploadPaths.js";

const STAGING_DIR = path.join(UPLOADS_DIR, "dicom-staging");
const DICOM_DIR = path.join(UPLOADS_DIR, "dicom");
const PREVIEW_DIR = path.join(UPLOADS_DIR, "dicom-previews");
const PATIENT_KEY_PATH = path.join(DATA_DIR, "dicom-patient.key");
const PATIENT_SECRET_KEY = "dicom_patient_hmac_v1";
const queue: number[] = [];
let draining = false;

export type DicomCandidateMetadata = Omit<ParsedDicomInstance, "dataSet" | "bytes" | "patientId"> & {
  sizeBytes: number;
  patientFingerprint: string | null;
};

interface Candidate {
  filePath: string;
  metadata: DicomCandidateMetadata;
}

function patientKey(): Buffer {
  const stored = db.prepare("SELECT value FROM private_runtime_secrets WHERE key=?").get(PATIENT_SECRET_KEY) as any;
  if (stored?.value) {
    const key = Buffer.from(stored.value);
    if (key.length < 32) throw new DicomImportError("patient_key_invalid");
    return key;
  }

  let legacy: Buffer | null = null;
  try {
    const stat = fs.statSync(PATIENT_KEY_PATH);
    if (stat.isFile()) {
      const candidate = fs.readFileSync(PATIENT_KEY_PATH);
      if (candidate.length >= 32) legacy = candidate;
    }
  } catch {}
  const proposed = legacy ?? crypto.randomBytes(32);
  db.prepare("INSERT OR IGNORE INTO private_runtime_secrets (key, value) VALUES (?, ?)").run(
    PATIENT_SECRET_KEY,
    proposed
  );
  const winner = db.prepare("SELECT value FROM private_runtime_secrets WHERE key=?").get(PATIENT_SECRET_KEY) as any;
  const key = winner?.value ? Buffer.from(winner.value) : Buffer.alloc(0);
  if (key.length < 32) throw new DicomImportError("patient_key_invalid");
  if (legacy && key.length === legacy.length && crypto.timingSafeEqual(key, legacy)) {
    try {
      fs.rmSync(PATIENT_KEY_PATH, { force: true });
    } catch {}
  }
  return key;
}

function fingerprintPatient(patientId: string | null): string | null {
  const normalized = patientId?.normalize("NFKC").trim();
  return normalized ? crypto.createHmac("sha256", patientKey()).update(normalized, "utf8").digest("hex") : null;
}

export function lightweightDicomMetadata(parsed: ParsedDicomInstance): DicomCandidateMetadata {
  const { dataSet: _dataSet, bytes, patientId, ...metadata } = parsed;
  return {
    ...metadata,
    sizeBytes: bytes.length,
    patientFingerprint: fingerprintPatient(patientId),
  };
}

function candidateFromFile(filePath: string): Candidate {
  const parsed = parseDicomPart10(fs.readFileSync(filePath));
  return { filePath, metadata: lightweightDicomMetadata(parsed) };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown, fallback: any) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

export function publicDicomImportJob(idOrRow: number | any) {
  const row =
    typeof idOrRow === "number" ? db.prepare("SELECT * FROM dicom_import_jobs WHERE id = ?").get(idOrRow) : idOrRow;
  if (!row) return null;
  return {
    id: Number(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    source_mime: row.source_mime,
    source_bytes: Number(row.source_bytes),
    target_study_id: row.target_study_id == null ? null : Number(row.target_study_id),
    analyze: row.analyze === 1,
    progress: {
      entries_seen: Number(row.entries_seen ?? 0),
      instances_indexed: Number(row.instances_indexed ?? 0),
      studies_created: Number(row.studies_created ?? 0),
    },
    warnings: parseJson(row.warnings_json, []).slice(0, 20),
    result: parseJson(row.result_json, null),
    error: row.error_code ? { code: String(row.error_code) } : null,
  };
}

export function createDicomImportJob(input: {
  stagingPath: string;
  sourceMime: string;
  sourceBytes: number;
  targetStudyId?: number | null;
  analyze?: boolean;
}) {
  const stagingPath = safeUploadPath(input.stagingPath);
  if (!stagingPath || !stagingPath.startsWith(path.resolve(STAGING_DIR) + path.sep))
    throw new DicomImportError("invalid_staging_path");
  if (!Number.isInteger(input.sourceBytes) || input.sourceBytes < 132 || input.sourceBytes > DICOM_LIMITS.archiveBytes)
    throw new DicomImportError("source_size_limit");
  if (input.targetStudyId != null) {
    const target = getHealthDocumentRaw(input.targetStudyId) as any;
    if (!target || target.kind !== "imaging") throw new DicomImportError("target_study_not_found");
  }
  const info = db
    .prepare(
      `INSERT INTO dicom_import_jobs (source_mime, staging_path, source_bytes, target_study_id, analyze)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.sourceMime, stagingPath, input.sourceBytes, input.targetStudyId ?? null, input.analyze ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  enqueueDicomImport(id);
  return publicDicomImportJob(id);
}

export function discardDicomStagingPath(filePath: unknown) {
  const safe = safeUploadPath(filePath);
  if (!safe || !safe.startsWith(path.resolve(STAGING_DIR) + path.sep)) return false;
  try {
    fs.rmSync(safe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function createDicomImportJobFromStaged(input: Parameters<typeof createDicomImportJob>[0]) {
  try {
    return createDicomImportJob(input);
  } catch (error) {
    discardDicomStagingPath(input.stagingPath);
    throw error;
  }
}

export function enqueueDicomImport(id: number) {
  if (!queue.includes(id)) queue.push(id);
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) await runJob(queue.shift()!);
  } finally {
    draining = false;
  }
}

function magic(bytes: Buffer): "dicom" | "zip" | "unknown" {
  if (hasPart10Preamble(bytes)) return "dicom";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]))
    return "zip";
  return "unknown";
}

function safeEntry(entry: Entry): "file" | "directory" {
  const name = entry.fileName;
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name))
    throw new DicomImportError("unsafe_archive_path");
  const pieces = name.split("/");
  if (pieces.some((part) => part === ".." || part === "." || part === "")) {
    if (name.endsWith("/") && pieces.slice(0, -1).every((part) => part && part !== "." && part !== ".."))
      return "directory";
    throw new DicomImportError("unsafe_archive_path");
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (unixMode === 0xa000) throw new DicomImportError("archive_symlink_rejected");
  if (unixMode !== 0 && unixMode !== 0x8000 && unixMode !== 0x4000)
    throw new DicomImportError("archive_non_regular_entry");
  if (name.endsWith("/") || unixMode === 0x4000) return "directory";
  if (/\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(name)) throw new DicomImportError("nested_archive_rejected");
  return "file";
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(new DicomImportError("invalid_zip"));
        else resolve(zip);
      }
    );
  });
}

function spoolEntry(zip: ZipFile, entry: Entry, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(new DicomImportError("archive_read_failed"));
      const output = fs.createWriteStream(filePath, { flags: "wx", mode: 0o600 });
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > DICOM_LIMITS.entryBytes) stream.destroy(new DicomImportError("entry_size_limit"));
      });
      stream.once("error", (streamError) => {
        output.destroy();
        reject(streamError);
      });
      output.once("error", (outputError) => {
        stream.destroy();
        reject(outputError);
      });
      output.once("finish", () => resolve());
      stream.pipe(output);
    });
  });
}

async function zipCandidates(filePath: string, candidateDir: string, progress: (entries: number) => void) {
  const zip = await openZip(filePath);
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  let entries = 0;
  let expanded = 0;
  return await new Promise<{ candidates: Candidate[]; warnings: string[] }>((resolve, reject) => {
    let active = false;
    const fail = (error: unknown) => {
      try {
        zip.close();
      } catch {}
      reject(error instanceof DicomImportError ? error : new DicomImportError("invalid_zip"));
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (!active) resolve({ candidates, warnings });
    });
    zip.on("entry", async (entry: Entry) => {
      active = true;
      try {
        entries++;
        progress(entries);
        if (entries > DICOM_LIMITS.entries) throw new DicomImportError("archive_entry_limit");
        const kind = safeEntry(entry);
        if (kind === "directory") {
          active = false;
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > DICOM_LIMITS.entryBytes) throw new DicomImportError("entry_size_limit");
        if (entry.compressedSize === 0 && entry.uncompressedSize > 0)
          throw new DicomImportError("compression_ratio_limit");
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > DICOM_LIMITS.compressionRatio)
          throw new DicomImportError("compression_ratio_limit");
        expanded += entry.uncompressedSize;
        if (expanded > DICOM_LIMITS.expandedBytes) throw new DicomImportError("expanded_size_limit");
        const candidatePath = path.join(candidateDir, `${crypto.randomUUID()}.dcm`);
        await spoolEntry(zip, entry, candidatePath);
        const head = Buffer.alloc(132);
        const fd = fs.openSync(candidatePath, "r");
        try {
          fs.readSync(fd, head, 0, head.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (magic(head) === "zip") throw new DicomImportError("nested_archive_rejected");
        try {
          candidates.push(candidateFromFile(candidatePath));
        } catch (error) {
          if (
            !(error instanceof DicomImportError) ||
            !["invalid_part10", "invalid_dicom", "missing_required_identity"].includes(error.code)
          )
            throw error;
          if (warnings.length < 20) warnings.push("An unsupported or invalid entry was skipped.");
          fs.rmSync(candidatePath, { force: true });
        }
        active = false;
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

async function readCandidates(
  filePath: string,
  candidateDir: string,
  sourceBytes: number,
  progress: (entries: number) => void
) {
  if (sourceBytes > DICOM_LIMITS.archiveBytes) throw new DicomImportError("source_size_limit");
  const head = Buffer.alloc(132);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const kind = magic(head);
  if (kind === "dicom") {
    if (sourceBytes > DICOM_LIMITS.entryBytes) throw new DicomImportError("entry_size_limit");
    progress(1);
    return { candidates: [candidateFromFile(filePath)], warnings: [] as string[] };
  }
  if (kind === "zip") return zipCandidates(filePath, candidateDir, progress);
  throw new DicomImportError("unsupported_container");
}

function validateCandidates(candidates: Candidate[]) {
  if (!candidates.length) throw new DicomImportError("no_valid_dicom_instances");
  const patientFingerprints = new Set(candidates.map((item) => item.metadata.patientFingerprint).filter(Boolean));
  if (patientFingerprints.size > 1) throw new DicomImportError("mixed_patient_ids");
  if (patientFingerprints.size && candidates.some((item) => !item.metadata.patientFingerprint))
    throw new DicomImportError("patient_identity_incomplete");
  const bySop = new Map<string, string>();
  const bySeries = new Map<string, string>();
  const studyCounts = new Map<string, { count: number; bytes: number }>();
  for (const { metadata } of candidates) {
    const prior = bySop.get(metadata.sopInstanceUid);
    if (prior && prior !== metadata.sha256) throw new DicomImportError("conflicting_sop_instance");
    bySop.set(metadata.sopInstanceUid, metadata.sha256);
    const seriesStudy = bySeries.get(metadata.seriesInstanceUid);
    if (seriesStudy && seriesStudy !== metadata.studyInstanceUid)
      throw new DicomImportError("conflicting_series_identity");
    bySeries.set(metadata.seriesInstanceUid, metadata.studyInstanceUid);
    const storedSeries = db
      .prepare("SELECT study_instance_uid FROM dicom_series WHERE series_instance_uid=?")
      .get(metadata.seriesInstanceUid) as any;
    if (storedSeries && storedSeries.study_instance_uid !== metadata.studyInstanceUid)
      throw new DicomImportError("conflicting_series_identity");
    const storedFingerprints = (
      db
        .prepare("SELECT DISTINCT patient_fingerprint FROM dicom_series WHERE study_instance_uid=?")
        .all(metadata.studyInstanceUid) as any[]
    ).map((row) => row.patient_fingerprint as string | null);
    if (
      storedFingerprints.some(
        (fingerprint) => fingerprint && metadata.patientFingerprint && fingerprint !== metadata.patientFingerprint
      )
    )
      throw new DicomImportError("patient_identity_conflict");
    if (
      storedFingerprints.length &&
      storedFingerprints.some((fingerprint) => Boolean(fingerprint) !== Boolean(metadata.patientFingerprint))
    )
      throw new DicomImportError("patient_identity_unverifiable");
    const count = studyCounts.get(metadata.studyInstanceUid) ?? { count: 0, bytes: 0 };
    count.count++;
    count.bytes += metadata.sizeBytes;
    if (count.count > DICOM_LIMITS.instancesPerStudy) throw new DicomImportError("instances_per_study_limit");
    if (count.bytes > DICOM_LIMITS.studyBytes) throw new DicomImportError("study_size_limit");
    studyCounts.set(metadata.studyInstanceUid, count);
  }
}

function targetForStudy(studyUid: string, requested: number | null): number {
  const existing = db
    .prepare("SELECT health_document_id FROM dicom_series WHERE study_instance_uid = ? ORDER BY id LIMIT 1")
    .get(studyUid) as any;
  if (existing) return Number(existing.health_document_id);
  if (requested != null) {
    const target = getHealthDocumentRaw(requested) as any;
    if (!target || target.kind !== "imaging") throw new DicomImportError("target_study_not_found");
    const targetUid = db
      .prepare("SELECT study_instance_uid FROM dicom_series WHERE health_document_id = ? ORDER BY id LIMIT 1")
      .get(requested) as any;
    if (!targetUid) return requested;
    if (targetUid.study_instance_uid === studyUid) return requested;
    // A draft already bound to another DICOM study is not an error and must not
    // be re-associated. The incoming study receives its own sibling record.
  }
  const created = createImagingStudy({ original_name: "DICOM study" }) as any;
  return Number(created.id);
}

function persistInstance(
  studyId: number,
  seriesId: number,
  candidate: Candidate,
  parsed: ParsedDicomInstance,
  createdPaths: string[]
) {
  const global = db
    .prepare(
      `SELECT i.sha256, s.health_document_id
         FROM dicom_instances i JOIN dicom_series s ON s.id = i.series_id
        WHERE i.sop_instance_uid = ? LIMIT 1`
    )
    .get(parsed.sopInstanceUid) as any;
  if (global) {
    if (global.sha256 !== parsed.sha256) throw new DicomImportError("conflicting_sop_instance");
    return false;
  }
  fs.mkdirSync(DICOM_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(DICOM_DIR, `${crypto.randomUUID()}.dcm`);
  fs.copyFileSync(candidate.filePath, filePath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(filePath, 0o600);
  createdPaths.push(filePath);
  const file = addImagingStudyFile({
    study_id: studyId,
    mime: "application/dicom",
    file_path: filePath,
    size_bytes: candidate.metadata.sizeBytes,
    sha256: parsed.sha256,
    source_kind: "dicom",
    dicom_study_uid: parsed.studyInstanceUid,
    dicom_series_uid: parsed.seriesInstanceUid,
    dicom_sop_uid: parsed.sopInstanceUid,
  }) as any;
  if (file.reused) {
    fs.rmSync(filePath, { force: true });
    createdPaths.pop();
    return false;
  }
  db.prepare(
    `INSERT INTO dicom_instances (
      series_id, imaging_study_file_id, sop_class_uid, sop_instance_uid, transfer_syntax_uid,
      instance_number, number_of_frames, rows, columns, samples_per_pixel, photometric_interpretation,
      bits_allocated, bits_stored, high_bit, pixel_representation, planar_configuration,
      rescale_slope, rescale_intercept, window_center, window_width, pixel_spacing, image_position,
      image_orientation, slice_location, frame_of_reference_uid, body_part, laterality,
      burned_in_annotation, source_deidentification_claim, preview_support_reason, sha256, size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seriesId,
    file.id,
    parsed.sopClassUid,
    parsed.sopInstanceUid,
    parsed.transferSyntaxUid,
    parsed.instanceNumber,
    parsed.frames,
    parsed.rows,
    parsed.columns,
    parsed.samplesPerPixel,
    parsed.photometricInterpretation,
    parsed.bitsAllocated,
    parsed.bitsStored,
    parsed.highBit,
    parsed.pixelRepresentation,
    parsed.planarConfiguration,
    parsed.rescaleSlope,
    parsed.rescaleIntercept,
    parsed.windowCenter,
    parsed.windowWidth,
    parsed.pixelSpacing,
    parsed.imagePosition,
    parsed.imageOrientation,
    parsed.sliceLocation,
    parsed.frameOfReferenceUid,
    parsed.bodyPart,
    parsed.laterality,
    parsed.burnedInAnnotation,
    parsed.sourceDeidentificationClaim,
    parsed.previewSupportReason,
    parsed.sha256,
    candidate.metadata.sizeBytes
  );
  return true;
}

function consensus<T>(values: Array<T | null | undefined>): T | null {
  const present = [...new Set(values.filter((value): value is T => value != null))];
  return present.length === 1 ? present[0] : null;
}

function normalizedLaterality(value: unknown): "left" | "right" | "bilateral" | null {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  return raw === "L" ? "left" : raw === "R" ? "right" : raw === "B" ? "bilateral" : null;
}

function refreshStudyMetadata(studyId: number) {
  const row = getHealthDocumentRaw(studyId) as any;
  let parsed = parseJson(row?.parsed_json, {});
  const current = coerceImagingStudy(parsed.imaging_study ?? {});
  const series = db
    .prepare(
      `SELECT id, study_instance_uid, series_instance_uid, modality, series_number, study_date,
              study_description, description, body_part,
              laterality, instance_count, frame_count, preview_support_reason
         FROM dicom_series WHERE health_document_id = ? ORDER BY COALESCE(series_number, 2147483647), id`
    )
    .all(studyId) as any[];
  const studyUid = consensus(series.map((item) => item.study_instance_uid));
  const modality = consensus(series.map((item) => normalizeImagingModality(item.modality)));
  const studyDate = consensus(series.map((item) => item.study_date));
  const procedure = consensus(series.map((item) => item.study_description));
  const bodyRegion = consensus(series.map((item) => normalizeImagingBodyRegion(item.body_part)));
  const clinicalSystem = consensus(series.map((item) => normalizeImagingClinicalSystem(item.body_part)));
  const laterality = consensus(series.map((item) => normalizedLaterality(item.laterality)));
  current.dicom.study_instance_uid = studyUid;
  current.dicom.series = series.map((item) => ({
    series_instance_uid: item.series_instance_uid,
    modality: item.modality,
    description: item.description,
    series_number: item.series_number,
    instance_count: item.instance_count,
    frame_count: item.frame_count,
    preview_support_reason: item.preview_support_reason,
  }));
  current.study.modality = modality ?? "UNKNOWN";
  current.study.raw_modality = consensus(series.map((item) => item.modality));
  current.study.study_instance_uid = studyUid;
  current.study.study_date = studyDate;
  current.study.procedure = procedure;
  current.study.accession = null;
  current.anatomy.body_region = bodyRegion ?? "unknown";
  current.anatomy.clinical_system = clinicalSystem ?? "unknown";
  current.anatomy.laterality = laterality ?? "unknown";
  current.provenance.source_kind =
    current.report.impression || current.report.findings ? "report_and_images" : "images";
  current.provenance.extraction = current.provenance.extraction === "corrected" ? "corrected" : "manual";
  current.provenance.extractor = "dicom-parser";
  parsed = { ...parsed, imaging_study: current };
  updateHealthDocFields(studyId, {
    parsed_json: parsed,
    kind: "imaging",
    doc_date: current.study.study_date,
    summary: row.summary || `${current.study.modality} DICOM study indexed for private review.`,
  });
}

function createRepresentativePreview(instanceId: number, createdPaths: string[]) {
  const row = db
    .prepare(
      `SELECT i.preview_support_reason, f.file_path
         FROM dicom_instances i JOIN imaging_study_files f ON f.id = i.imaging_study_file_id
        WHERE i.id = ?`
    )
    .get(instanceId) as any;
  if (!row || row.preview_support_reason) return null;
  const sourcePath = safeUploadPath(row.file_path);
  if (!sourcePath) return null;
  try {
    const parsed = parseDicomPart10(fs.readFileSync(sourcePath));
    const png = dicomFramePng(decodeDicomFrame(parsed, Math.floor(parsed.frames / 2)), 768);
    fs.mkdirSync(PREVIEW_DIR, { recursive: true, mode: 0o700 });
    const previewPath = path.join(PREVIEW_DIR, `${crypto.randomUUID()}.png`);
    fs.writeFileSync(previewPath, png, { flag: "wx", mode: 0o600 });
    createdPaths.push(previewPath);
    db.prepare("UPDATE dicom_instances SET preview_path = ? WHERE id = ?").run(previewPath, instanceId);
    return previewPath;
  } catch {
    return null;
  }
}

function persistCandidates(candidates: Candidate[], targetStudyId: number | null, jobId: number) {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.metadata.studyInstanceUid.localeCompare(b.metadata.studyInstanceUid) ||
      a.metadata.seriesInstanceUid.localeCompare(b.metadata.seriesInstanceUid) ||
      (a.metadata.seriesNumber ?? Number.MAX_SAFE_INTEGER) - (b.metadata.seriesNumber ?? Number.MAX_SAFE_INTEGER) ||
      (a.metadata.instanceNumber ?? Number.MAX_SAFE_INTEGER) - (b.metadata.instanceNumber ?? Number.MAX_SAFE_INTEGER) ||
      a.metadata.sopInstanceUid.localeCompare(b.metadata.sopInstanceUid)
  );
  const groups = new Map<string, Candidate[]>();
  for (const item of sorted) {
    const group = groups.get(item.metadata.studyInstanceUid) ?? [];
    if (!group.some((existing) => existing.metadata.sopInstanceUid === item.metadata.sopInstanceUid)) group.push(item);
    groups.set(item.metadata.studyInstanceUid, group);
  }
  if (targetStudyId != null && groups.size > 1) throw new DicomImportError("target_requires_explicit_association");
  const createdPaths: string[] = [];
  const studyIds: number[] = [];
  let indexed = 0;
  let createdStudies = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const live = db.prepare("SELECT status, target_study_id FROM dicom_import_jobs WHERE id=?").get(jobId) as any;
    if (!live || live.status !== "running") throw new DicomImportError("import_canceled");
    if (
      targetStudyId != null &&
      !db.prepare("SELECT 1 FROM health_documents WHERE id=? AND kind='imaging'").get(targetStudyId)
    )
      throw new DicomImportError("target_study_not_found");
    for (const [studyUid, items] of groups) {
      const before = db
        .prepare("SELECT health_document_id FROM dicom_series WHERE study_instance_uid = ? LIMIT 1")
        .get(studyUid);
      const studyId = targetForStudy(studyUid, targetStudyId);
      if (!before && studyId !== targetStudyId) createdStudies++;
      studyIds.push(studyId);
      const bySeries = new Map<string, Candidate[]>();
      for (const item of items) {
        const seriesItems = bySeries.get(item.metadata.seriesInstanceUid) ?? [];
        seriesItems.push(item);
        bySeries.set(item.metadata.seriesInstanceUid, seriesItems);
      }
      for (const [seriesUid, seriesItems] of bySeries) {
        const metadata = seriesItems.map((item) => item.metadata);
        const rep = {
          modality: consensus(metadata.map((item) => item.modality)),
          seriesNumber: consensus(metadata.map((item) => item.seriesNumber)),
          studyDate: consensus(metadata.map((item) => item.studyDate)),
          studyDescription: consensus(metadata.map((item) => item.studyDescription)),
          seriesDescription: consensus(metadata.map((item) => item.seriesDescription)),
          bodyPart: consensus(metadata.map((item) => item.bodyPart)),
          laterality: consensus(metadata.map((item) => item.laterality)),
          frameOfReferenceUid: consensus(metadata.map((item) => item.frameOfReferenceUid)),
          patientFingerprint: consensus(metadata.map((item) => item.patientFingerprint)),
          previewSupportReason: consensus(metadata.map((item) => item.previewSupportReason)),
        };
        db.prepare(
          `INSERT INTO dicom_series (health_document_id, study_instance_uid, series_instance_uid, modality,
             series_number, study_date, study_description, description, body_part, laterality,
             frame_of_reference_uid, patient_fingerprint, preview_support_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(health_document_id, series_instance_uid) DO UPDATE SET
             modality=COALESCE(excluded.modality, modality), series_number=COALESCE(excluded.series_number, series_number),
             study_date=COALESCE(excluded.study_date, study_date),
             study_description=COALESCE(excluded.study_description, study_description),
             description=COALESCE(excluded.description, description), body_part=COALESCE(excluded.body_part, body_part),
             laterality=COALESCE(excluded.laterality, laterality),
             frame_of_reference_uid=COALESCE(excluded.frame_of_reference_uid, frame_of_reference_uid),
             patient_fingerprint=COALESCE(excluded.patient_fingerprint, patient_fingerprint)`
        ).run(
          studyId,
          studyUid,
          seriesUid,
          rep.modality,
          rep.seriesNumber,
          rep.studyDate,
          rep.studyDescription,
          rep.seriesDescription,
          rep.bodyPart,
          rep.laterality,
          rep.frameOfReferenceUid,
          rep.patientFingerprint,
          rep.previewSupportReason
        );
        const seriesRow = db
          .prepare("SELECT id FROM dicom_series WHERE health_document_id = ? AND series_instance_uid = ?")
          .get(studyId, seriesUid) as any;
        for (const item of seriesItems) {
          // Only one instance buffer/DataSet is resident at a time. The candidate
          // list retains bounded metadata and private file paths, never payloads.
          const parsed = parseDicomPart10(fs.readFileSync(item.filePath));
          if (persistInstance(studyId, Number(seriesRow.id), item, parsed, createdPaths)) indexed++;
        }
        const counts = db
          .prepare(
            "SELECT COUNT(*) n, COALESCE(SUM(number_of_frames),0) frames FROM dicom_instances WHERE series_id = ?"
          )
          .get(seriesRow.id) as any;
        const supported = db
          .prepare(
            "SELECT id FROM dicom_instances WHERE series_id = ? AND preview_support_reason IS NULL ORDER BY COALESCE(instance_number,2147483647), id LIMIT 1"
          )
          .get(seriesRow.id) as any;
        const reason = supported
          ? null
          : (
              db
                .prepare(
                  "SELECT preview_support_reason reason FROM dicom_instances WHERE series_id = ? ORDER BY id LIMIT 1"
                )
                .get(seriesRow.id) as any
            )?.reason;
        db.prepare(
          "UPDATE dicom_series SET instance_count = ?, frame_count = ?, preview_support_reason = ? WHERE id = ?"
        ).run(counts.n, counts.frames, reason, seriesRow.id);
        if (supported) {
          const previewExists = db
            .prepare("SELECT 1 FROM dicom_instances WHERE series_id = ? AND preview_path IS NOT NULL LIMIT 1")
            .get(seriesRow.id);
          if (!previewExists) createRepresentativePreview(Number(supported.id), createdPaths);
        }
      }
      refreshStudyMetadata(studyId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    for (const owned of createdPaths)
      try {
        fs.rmSync(owned, { force: true });
      } catch {}
    throw error;
  }
  return { study_ids: [...new Set(studyIds)], instances_indexed: indexed, studies_created: createdStudies };
}

async function runJob(id: number) {
  const row = db.prepare("SELECT * FROM dicom_import_jobs WHERE id = ?").get(id) as any;
  if (!row || !["queued", "running"].includes(row.status)) return;
  const filePath = safeUploadPath(row.staging_path);
  if (!filePath || !fs.existsSync(filePath)) {
    db.prepare(
      "UPDATE dicom_import_jobs SET status='failed', error_code='staging_file_missing', staging_path=NULL, updated_at=datetime('now') WHERE id=?"
    ).run(id);
    return;
  }
  db.prepare(
    "UPDATE dicom_import_jobs SET status='running', error_code=NULL, updated_at=datetime('now') WHERE id=?"
  ).run(id);
  const candidateDir = path.join(STAGING_DIR, `${id}.candidates-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(candidateDir, { recursive: false, mode: 0o700 });
    const { candidates, warnings } = await readCandidates(
      filePath,
      candidateDir,
      Number(row.source_bytes),
      (entries) => {
        db.prepare(
          "UPDATE dicom_import_jobs SET entries_seen=?, updated_at=datetime('now') WHERE id=? AND status='running'"
        ).run(entries, id);
      }
    );
    validateCandidates(candidates);
    const live = db.prepare("SELECT status FROM dicom_import_jobs WHERE id=?").get(id) as any;
    if (!live || live.status !== "running") throw new DicomImportError("import_canceled");
    const result = persistCandidates(candidates, row.target_study_id == null ? null : Number(row.target_study_id), id);
    db.prepare(
      `UPDATE dicom_import_jobs SET status='done', staging_path=NULL, instances_indexed=?, studies_created=?,
       warnings_json=?, result_json=?, updated_at=datetime('now') WHERE id=? AND status='running'`
    ).run(result.instances_indexed, result.studies_created, json(warnings), json(result), id);
    if (row.analyze === 1 && getSettings().enrich_enabled) {
      for (const studyId of result.study_ids) {
        setHealthDocEnrichStatus(studyId, "pending");
        void import("./enrich.js").then((module) => module.enqueueEnrich("health", studyId)).catch(() => {});
      }
    }
  } catch (error) {
    const code = error instanceof DicomImportError ? error.code : "import_failed";
    db.prepare(
      `UPDATE dicom_import_jobs SET status='failed', staging_path=NULL, error_code=?, updated_at=datetime('now')
        WHERE id=? AND status='running'`
    ).run(code, id);
  } finally {
    discardDicomStagingPath(filePath);
    discardDicomStagingPath(candidateDir);
  }
}

export function recoverDicomImports() {
  const referenced = new Set<string>();
  for (const row of db.prepare("SELECT file_path FROM imaging_study_files WHERE source_kind='dicom'").all() as any[]) {
    const safe = safeUploadPath(row.file_path);
    if (safe) referenced.add(safe);
  }
  for (const row of db
    .prepare("SELECT preview_path FROM dicom_instances WHERE preview_path IS NOT NULL")
    .all() as any[]) {
    const safe = safeUploadPath(row.preview_path);
    if (safe) referenced.add(safe);
  }
  for (const directory of [DICOM_DIR, PREVIEW_DIR]) {
    try {
      for (const name of fs.readdirSync(directory)) {
        const candidate = safeUploadPath(path.join(directory, name));
        if (candidate && !referenced.has(candidate)) fs.rmSync(candidate, { force: true });
      }
    } catch {}
  }
  const liveStaging = new Set<string>();
  for (const row of db
    .prepare(
      "SELECT staging_path FROM dicom_import_jobs WHERE status IN ('queued','running') AND staging_path IS NOT NULL"
    )
    .all() as any[]) {
    const safe = safeUploadPath(row.staging_path);
    if (safe && safe.startsWith(path.resolve(STAGING_DIR) + path.sep)) liveStaging.add(safe);
  }
  try {
    for (const name of fs.readdirSync(STAGING_DIR)) {
      const candidate = safeUploadPath(path.join(STAGING_DIR, name));
      if (candidate && !liveStaging.has(candidate)) discardDicomStagingPath(candidate);
    }
  } catch {}
  const quarantine = recoverImagingQuarantines();
  const rows = db
    .prepare("SELECT id FROM dicom_import_jobs WHERE status IN ('queued','running') ORDER BY id")
    .all() as any[];
  for (const row of rows) {
    db.prepare("UPDATE dicom_import_jobs SET status='queued', updated_at=datetime('now') WHERE id=?").run(row.id);
    enqueueDicomImport(Number(row.id));
  }
  return { recovered: rows.length, quarantine };
}

export function createDicomStagingPath(): string {
  fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
  return path.join(STAGING_DIR, `${crypto.randomUUID()}.upload`);
}

function geometryProjection(instance: any): number | null {
  const orientation = String(instance.image_orientation ?? "")
    .split("\\")
    .map(Number);
  const position = String(instance.image_position ?? "")
    .split("\\")
    .map(Number);
  if (
    orientation.length !== 6 ||
    position.length !== 3 ||
    [...orientation, ...position].some((value) => !Number.isFinite(value))
  )
    return null;
  const normal = [
    orientation[1] * orientation[5] - orientation[2] * orientation[4],
    orientation[2] * orientation[3] - orientation[0] * orientation[5],
    orientation[0] * orientation[4] - orientation[1] * orientation[3],
  ];
  const magnitude = Math.hypot(...normal);
  if (magnitude < 0.5 || magnitude > 1.5) return null;
  return position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2];
}

export function sortDicomManifestInstances(instances: any[]): any[] {
  return [...instances].sort((a, b) => {
    const aProjection = geometryProjection(a);
    const bProjection = geometryProjection(b);
    if (aProjection != null && bProjection != null && Math.abs(aProjection - bProjection) > 1e-6)
      return aProjection - bProjection;
    if (aProjection != null && bProjection == null) return -1;
    if (aProjection == null && bProjection != null) return 1;
    return (
      (a.instance_number ?? Number.MAX_SAFE_INTEGER) - (b.instance_number ?? Number.MAX_SAFE_INTEGER) ||
      Number(a.id) - Number(b.id)
    );
  });
}

export function dicomManifest(studyId: number) {
  if (!getImagingStudy(studyId)) return null;
  const series = db
    .prepare(
      `SELECT id, modality, series_number, description, body_part, laterality, instance_count, frame_count,
            preview_support_reason
       FROM dicom_series WHERE health_document_id = ? ORDER BY COALESCE(series_number,2147483647), id`
    )
    .all(studyId) as any[];
  return {
    study_id: studyId,
    series: series.map((item) => ({
      ...item,
      previewable: item.preview_support_reason == null,
      instances: sortDicomManifestInstances(
        db
          .prepare(
            `SELECT id, instance_number, number_of_frames, rows, columns, samples_per_pixel,
                photometric_interpretation, bits_allocated, bits_stored, high_bit, pixel_representation,
                planar_configuration, rescale_slope, rescale_intercept, window_center, window_width,
                pixel_spacing, image_position, image_orientation, slice_location, body_part, laterality,
                burned_in_annotation, source_deidentification_claim, preview_support_reason,
                CASE WHEN preview_path IS NULL THEN 0 ELSE 1 END AS has_preview
           FROM dicom_instances WHERE series_id = ? ORDER BY COALESCE(instance_number,2147483647), id`
          )
          .all(item.id) as any[]
      ).map((instance) => ({
        ...instance,
        previewable: instance.preview_support_reason == null,
        has_preview: instance.has_preview === 1,
      })),
    })),
  };
}

export function dicomInstanceFile(studyId: number, instanceId: number) {
  const row = db
    .prepare(
      `SELECT f.file_path, f.size_bytes
       FROM dicom_instances i
       JOIN dicom_series s ON s.id=i.series_id
       JOIN imaging_study_files f ON f.id=i.imaging_study_file_id
      WHERE i.id=? AND s.health_document_id=?`
    )
    .get(instanceId, studyId) as any;
  const filePath = safeUploadPath(row?.file_path);
  return row && filePath ? { filePath, sizeBytes: Number(row.size_bytes) } : null;
}

export function dicomFrame(studyId: number, instanceId: number, frameIndex: number) {
  const source = dicomInstanceFile(studyId, instanceId);
  if (!source || !fs.existsSync(source.filePath)) return null;
  const frame = decodeDicomFrame(parseDicomPart10(fs.readFileSync(source.filePath)), frameIndex);
  return frame;
}
