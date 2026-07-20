import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { UPLOADS_DIR, safeUploadPath } from "../uploadPaths.js";
import {
  addHealthDocument,
  getHealthDocument,
  getHealthDocumentRaw,
  setHealthDocEnrichStatus,
  updateHealthDocFields,
} from "./health.js";

export const IMAGING_SCHEMA_VERSION = 1;
export const IMAGING_FILE_MIMES = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png"]);
export const MAX_IMAGING_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGING_FILES_PER_STUDY = 16;
export const MAX_IMAGING_STUDY_BYTES = 64 * 1024 * 1024;
export const MAX_DICOM_INSTANCE_BYTES = 128 * 1024 * 1024;
export const MAX_DICOM_INSTANCES_PER_STUDY = 4096;
export const MAX_DICOM_STUDY_BYTES = 768 * 1024 * 1024;

const CLINICAL_SYSTEMS = new Set([
  "musculoskeletal",
  "neurologic",
  "cardiovascular",
  "pulmonary",
  "gastrointestinal",
  "genitourinary",
  "reproductive",
  "endocrine",
  "head_and_neck",
  "breast",
  "whole_body",
  "other",
  "unknown",
]);
const LATERALITY = new Set(["left", "right", "bilateral", "midline", "not_applicable", "unknown"]);
const FINDING_SOURCES = new Set(["report", "image_ai", "mychart", "patient"]);
const REPORT_STATUSES = new Set(["draft", "preliminary", "final", "amended", "corrected", "unknown"]);
const SEVERITIES = new Set(["minimal", "mild", "moderate", "severe", "critical", "not_stated", "unknown"]);
const CERTAINTIES = new Set([
  "confirmed",
  "probable",
  "possible",
  "indeterminate",
  "unconfirmed",
  "not_stated",
  "unknown",
]);
const RECOMMENDATION_STATUSES = new Set(["recommended", "scheduled", "completed", "declined", "not_needed", "unknown"]);
const IMAGING_RECORD_STATUSES = new Set(["current", "superseded", "conflict"]);
const SAFE_IMAGE_AI_TEXT = "Unconfirmed image observation withheld pending source-report review.";
const DICOM_QUARANTINE_DIR = path.join(UPLOADS_DIR, "dicom-quarantine");
const DICOM_QUARANTINE_MANIFEST = "manifest.json";
const IMAGE_AI_UNITS = new Map([
  ["mm", "mm"],
  ["millimeter", "mm"],
  ["millimeters", "mm"],
  ["cm", "cm"],
  ["centimeter", "cm"],
  ["centimeters", "cm"],
  ["m", "m"],
  ["meter", "m"],
  ["meters", "m"],
  ["px", "px"],
  ["pixel", "px"],
  ["pixels", "px"],
  ["deg", "deg"],
  ["degree", "deg"],
  ["degrees", "deg"],
  ["°", "deg"],
  ["mm2", "mm2"],
  ["mm²", "mm2"],
  ["cm2", "cm2"],
  ["cm²", "cm2"],
  ["mm3", "mm3"],
  ["mm³", "mm3"],
  ["cm3", "cm3"],
  ["cm³", "cm3"],
  ["%", "%"],
]);

export function normalizeImagingModality(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (/^(dx|digital radiograph)(\b|$)/.test(raw)) return "DX";
  if (/^(cr|computed radiograph)(\b|$)/.test(raw)) return "CR";
  if (/^(rf|radiofluoroscop)(\b|$)/.test(raw)) return "RF";
  if (/^(xa|x-ray angiograph)(\b|$)/.test(raw)) return "XA";
  if (/^(pt)(\b|$)/.test(raw)) return "PT";
  if (/^(mr|mri|magnetic resonance)(\b|$)/.test(raw)) return "MR";
  if (/^(ct|cat|computed tomography)(\b|$)/.test(raw)) return "CT";
  if (/^(x[ -]?ray|radiograph|xr)(\b|$)/.test(raw)) return "XR";
  if (/^(ultrasound|sonograph|us)(\b|$)/.test(raw)) return "US";
  if (/^(mammograph|mammogram|mg)(\b|$)/.test(raw)) return "MG";
  if (/^(pet)(\b|$)/.test(raw)) return "PET";
  if (/^(nm|nuclear medicine)(\b|$)/.test(raw)) return "NM";
  return "UNKNOWN";
}

export function isImagingRecommendationStatus(value: unknown): boolean {
  return RECOMMENDATION_STATUSES.has(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );
}

function text(value: unknown, max: number): string | null {
  if (value == null) return null;
  const out = String(value).replace(/\s+/g, " ").trim();
  return out ? out.slice(0, max) : null;
}

function isoDate(value: unknown): string | null {
  const out = text(value, 32);
  return out && /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}

function isoStamp(value: unknown): string | null {
  const out = text(value, 40);
  if (!out || !Number.isFinite(Date.parse(out))) return null;
  return new Date(out).toISOString();
}

function choice(value: unknown, choices: Set<string>, fallback: string): string {
  const out = String(value ?? "")
    .trim()
    .toLowerCase();
  return choices.has(out) ? out : fallback;
}

function finite(value: unknown, min = -1e9, max = 1e9): number | null {
  if (value == null || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? Math.max(min, Math.min(max, out)) : null;
}

export function normalizeImagingClinicalSystem(value: unknown): string {
  const direct = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
  if (CLINICAL_SYSTEMS.has(direct)) return direct;
  const s = direct;
  if (/bone|joint|muscl|tendon|ligament|spine|orthop/.test(s)) return "musculoskeletal";
  if (/brain|neuro|intracran|nerve/.test(s)) return "neurologic";
  if (/heart|cardi|vascular|arter|vein/.test(s)) return "cardiovascular";
  if (/lung|pulmon|chest|pleur/.test(s)) return "pulmonary";
  if (/liver|bowel|colon|stomach|abdom|gastro/.test(s)) return "gastrointestinal";
  if (/kidney|renal|bladder|urinar|prostat/.test(s)) return "genitourinary";
  if (/uter|ovar|pelvi|testi|reproduct/.test(s)) return "reproductive";
  if (/thyroid|adrenal|pituitar|endocr/.test(s)) return "endocrine";
  if (/head|neck|sinus|orbit|ear|dental/.test(s)) return "head_and_neck";
  if (/breast|mamm/.test(s)) return "breast";
  return s ? "other" : "unknown";
}

export function normalizeImagingBodyRegion(value: unknown): string {
  const raw = text(value, 120);
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  const mappings: Array<[RegExp, string]> = [
    [/cervical|c[ _-]?spine|^cspine$/, "spine.cervical"],
    [/thoracic|t[ _-]?spine|^tspine$/, "spine.thoracic"],
    [/lumbar|l[ _-]?spine|^lspine$/, "spine.lumbar"],
    [/shoulder/, "upper_extremity.shoulder"],
    [/elbow/, "upper_extremity.elbow"],
    [/wrist/, "upper_extremity.wrist"],
    [/hand|finger/, "upper_extremity.hand"],
    [/hip/, "lower_extremity.hip"],
    [/knee/, "lower_extremity.knee"],
    [/ankle/, "lower_extremity.ankle"],
    [/foot|toe/, "lower_extremity.foot"],
    [/brain|head|intracran/, "head.brain"],
    [/neck/, "head_neck.neck"],
    [/chest|thorax|lung/, "torso.chest"],
    [/abdomen|abdominal|liver|kidney|renal/, "torso.abdomen"],
    [/pelvis|pelvic|prostate|uter|ovar/, "torso.pelvis"],
    [/breast|mamm/, "torso.breast"],
    [/whole body|skeletal survey/, "whole_body"],
  ];
  return mappings.find(([pattern]) => pattern.test(s))?.[1] ?? "other";
}

function stableId(prefix: string, parts: unknown[]): string {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${digest}`;
}

function cleanSourceSpans(raw: unknown): any[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && typeof x === "object")
    .slice(0, 20)
    .map((x: any) => ({
      file_id: finite(x.file_id, 1, Number.MAX_SAFE_INTEGER),
      page: finite(x.page, 1, 100000),
      start: finite(x.start, 0, 10_000_000),
      end: finite(x.end, 0, 10_000_000),
      text: text(x.text, 500),
    }))
    .filter((x) => x.file_id != null || x.page != null || x.text);
}

function cleanMeasurements(raw: unknown): any[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && typeof x === "object")
    .slice(0, 30)
    .map((x: any) => {
      const name = text(x.name ?? x.label, 120);
      const value = finite(x.value);
      const value_text = value == null ? text(x.value_text ?? x.value, 120) : null;
      if (!name || (value == null && !value_text)) return null;
      return {
        name,
        value,
        value_text,
        unit: text(x.unit, 40),
        qualifier: text(x.qualifier, 120),
        method: text(x.method, 120),
      };
    })
    .filter(Boolean);
}

function safeImageAiObservation(raw: unknown, hasMeasurement: boolean): string {
  const normalized = String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase();
  if (/\basymmetr(?:y|ic|ical)\b/.test(normalized)) return "Unconfirmed image asymmetry observation.";
  if (/\balignment\b/.test(normalized)) return "Unconfirmed image alignment observation.";
  if (/\b(?:shape|contour)\b/.test(normalized)) return "Unconfirmed image shape observation.";
  if (/\b(?:signal|density|appearance)\b/.test(normalized)) return "Unconfirmed image appearance observation.";
  if (hasMeasurement) return "Unconfirmed image measurement.";
  return SAFE_IMAGE_AI_TEXT;
}

function safeImageAiMeasurementName(raw: unknown): string {
  const normalized = String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const match = normalized.match(
    /^(?:ap |transverse |craniocaudal )?(length|width|height|depth|diameter|distance|angle|area|volume|count)$/
  );
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)}` : "Image measurement";
}

function constrainImageAiFinding(finding: any, index: number): any {
  const measurements = (Array.isArray(finding.measurements) ? finding.measurements : [])
    .map((measurement: any) => {
      const value = finite(measurement?.value);
      if (value == null) return null;
      const rawUnit = String(measurement?.unit ?? "")
        .trim()
        .toLowerCase();
      return {
        name: safeImageAiMeasurementName(measurement?.name),
        value,
        value_text: null,
        unit: IMAGE_AI_UNITS.get(rawUnit) ?? null,
        qualifier: null,
        method: null,
      };
    })
    .filter(Boolean);
  const findingText = safeImageAiObservation(finding.finding_text, measurements.length > 0);
  return {
    ...finding,
    id: stableId("finding", [
      "image_ai",
      finding.clinical_system,
      finding.body_region,
      finding.laterality,
      findingText,
      index,
    ]),
    source: "image_ai",
    verbatim_site: null,
    finding_text: findingText,
    quarantined: true,
    quarantine_reason: "image_ai_free_text_not_published",
    severity: "not_stated",
    certainty: "unconfirmed",
    measurements,
    source_spans: (Array.isArray(finding.source_spans) ? finding.source_spans : []).map((span: any) => ({
      ...span,
      text: null,
    })),
  };
}

function cleanFindings(raw: unknown): any[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && typeof x === "object")
    .slice(0, 200)
    .map((x: any, index) => {
      const finding_text = text(x.finding_text ?? x.text ?? x.finding, 2000);
      if (!finding_text) return null;
      // Missing/invalid attribution is never promoted to a written clinical source.
      // Ownership-aware report/MyChart authority is enforced again at apply time.
      const source = choice(x.source, FINDING_SOURCES, "image_ai");
      const clinical_system = normalizeImagingClinicalSystem(x.clinical_system ?? x.system ?? x.anatomy);
      const body_region = normalizeImagingBodyRegion(x.body_region ?? x.site ?? x.anatomy);
      const finding = {
        id: text(x.id, 80) ?? stableId("finding", [source, clinical_system, body_region, finding_text, index]),
        source,
        clinical_system,
        body_region,
        verbatim_site: text(x.verbatim_site ?? x.site, 240),
        laterality: choice(x.laterality, LATERALITY, "unknown"),
        finding_text,
        quarantined: false,
        quarantine_reason: null,
        severity: source === "image_ai" ? "not_stated" : choice(x.severity, SEVERITIES, "not_stated"),
        certainty: source === "image_ai" ? "unconfirmed" : choice(x.certainty, CERTAINTIES, "not_stated"),
        measurements: cleanMeasurements(x.measurements),
        source_spans: cleanSourceSpans(x.source_spans),
      };
      return source === "image_ai" ? constrainImageAiFinding(finding, index) : finding;
    })
    .filter(Boolean);
}

function cleanRecommendations(raw: unknown): any[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((x) => x && typeof x === "object")
    .slice(0, 80)
    .map((x: any, index) => {
      const recommendation_text = text(x.recommendation_text ?? x.text, 1500);
      if (!recommendation_text) return null;
      const source = choice(x.source, FINDING_SOURCES, "image_ai");
      if (source === "image_ai") return null; // generic image models may never invent follow-up
      return {
        id: text(x.id, 80) ?? stableId("recommendation", [source, recommendation_text, index]),
        source,
        recommendation_text,
        timeframe: text(x.timeframe, 240),
        action: text(x.action, 500),
        status: choice(x.status, RECOMMENDATION_STATUSES, "unknown"),
        source_spans: cleanSourceSpans(x.source_spans),
      };
    })
    .filter(Boolean);
}

export function emptyImagingStudy(input: any = {}): any {
  return coerceImagingStudy({
    schema_version: IMAGING_SCHEMA_VERSION,
    report_status: "draft",
    study: input.study ?? input,
    anatomy: {},
    report: {},
    findings: [],
    recommendations: [],
    provenance: {
      source_kind: input.source_kind ?? "patient",
      extraction: "pending",
      extractor: "cairn",
      source_doc_id: input.source_doc_id ?? null,
    },
    verification: { needs_confirmation: true, user_confirmed: false, clinician_confirmed: false },
    dicom: {},
  });
}

export function coerceImagingStudy(
  raw: any,
  opts: { sourceDocId?: number | null; sourceKind?: string; extractor?: string; sha256?: string | null } = {}
): any {
  const source = raw && typeof raw === "object" ? raw : {};
  const study = source.study && typeof source.study === "object" ? source.study : {};
  const anatomy = source.anatomy && typeof source.anatomy === "object" ? source.anatomy : {};
  const report = source.report && typeof source.report === "object" ? source.report : {};
  const provenance = source.provenance && typeof source.provenance === "object" ? source.provenance : {};
  const verification = source.verification && typeof source.verification === "object" ? source.verification : {};
  const dicom = source.dicom && typeof source.dicom === "object" ? source.dicom : {};
  const rawModality = text(study.raw_modality ?? study.modality, 120);
  const modality = normalizeImagingModality(study.modality ?? rawModality);
  return {
    schema_version: IMAGING_SCHEMA_VERSION,
    report_status: choice(source.report_status, REPORT_STATUSES, "unknown"),
    study: {
      modality,
      raw_modality: rawModality,
      procedure: text(study.procedure, 240),
      accession: text(study.accession, 120),
      study_instance_uid: text(study.study_instance_uid, 128),
      study_date: isoDate(study.study_date),
      issued_at: isoStamp(study.issued_at),
      facility: text(study.facility, 240),
      ordering_clinician: text(study.ordering_clinician, 240),
      interpreting_clinician: text(study.interpreting_clinician, 240),
    },
    anatomy: {
      clinical_system: normalizeImagingClinicalSystem(anatomy.clinical_system),
      body_region: normalizeImagingBodyRegion(anatomy.body_region),
      verbatim_site: text(anatomy.verbatim_site, 240),
      laterality: choice(anatomy.laterality, LATERALITY, "unknown"),
      code: text(anatomy.code, 120),
    },
    report: {
      history: text(report.history, 4000),
      technique: text(report.technique, 4000),
      comparison: text(report.comparison, 4000),
      findings: text(report.findings, 12000),
      impression: text(report.impression, 6000),
      addendum: text(report.addendum, 4000),
    },
    findings: cleanFindings(source.findings),
    recommendations: cleanRecommendations(source.recommendations),
    provenance: {
      source_kind: choice(
        opts.sourceKind ?? provenance.source_kind,
        new Set(["report", "images", "report_and_images", "mychart", "patient"]),
        "patient"
      ),
      extraction: choice(
        provenance.extraction,
        new Set(["pending", "agent", "mychart", "manual", "corrected"]),
        "agent"
      ),
      extractor: text(opts.extractor ?? provenance.extractor, 120) ?? "cairn",
      source_doc_id: finite(opts.sourceDocId ?? provenance.source_doc_id, 1, Number.MAX_SAFE_INTEGER),
      source_hash: text(opts.sha256 ?? provenance.source_hash, 128),
      confidence: choice(provenance.confidence, new Set(["low", "medium", "high", "unknown"]), "unknown"),
      record_status: choice(provenance.record_status, IMAGING_RECORD_STATUSES, "current"),
      source_amended_at: isoStamp(provenance.source_amended_at),
      source_amendment: text(provenance.source_amendment, 500),
    },
    verification: {
      needs_confirmation: verification.needs_confirmation !== false,
      user_confirmed: verification.user_confirmed === true,
      // No clinician-verification workflow exists. Agent, REST and MCP payloads
      // are all untrusted for these fields, so only a future authorized workflow
      // may ever write them.
      clinician_confirmed: false,
      user_confirmed_at: isoStamp(verification.user_confirmed_at),
      clinician_confirmed_at: null,
      corrected_at: isoStamp(verification.corrected_at),
      notes: text(verification.notes, 1000),
    },
    dicom: {
      study_instance_uid: text(dicom.study_instance_uid ?? study.study_instance_uid, 128),
      series: (Array.isArray(dicom.series) ? dicom.series : [])
        .filter((x: any) => x && typeof x === "object")
        .slice(0, 100)
        .map((x: any) => ({
          series_instance_uid: text(x.series_instance_uid, 128),
          modality: text(x.modality, 40),
          description: text(x.description, 240),
          series_number: finite(x.series_number, -1_000_000, 1_000_000),
          instance_count: finite(x.instance_count, 0, MAX_DICOM_INSTANCES_PER_STUDY),
          frame_count: finite(x.frame_count, 0, MAX_DICOM_INSTANCES_PER_STUDY * 512),
          preview_support_reason: text(x.preview_support_reason, 120),
        })),
    },
  };
}

export function imagingStudyHasContent(study: any): boolean {
  const s = coerceImagingStudy(study);
  return !!(
    s.report.impression ||
    s.report.findings ||
    s.report.technique ||
    s.findings.length ||
    s.recommendations.length ||
    s.dicom.series.length
  );
}

function constrainSourceAuthority(
  studyId: number,
  imaging: any,
  opts: { sourceDocId?: number | null; sourceKind?: string; userCorrection?: boolean } = {}
): any {
  const files = listImagingStudyFilesRaw(studyId);
  const owned = new Map(files.map((file) => [Number(file.id), file]));
  const keep = (span: any) => span.file_id != null && owned.has(Number(span.file_id));
  const derivedMyChart =
    opts.sourceKind === "mychart" && Number.isInteger(opts.sourceDocId) && Number(opts.sourceDocId) > 0;
  const writtenFiles = files.filter((file) => file.source_kind === "report" || file.source_kind === "mychart");
  const authoritativeKind = (spans: any[]): "report" | "mychart" | null => {
    if (derivedMyChart) return "mychart";
    const cited = spans
      .map((span) => owned.get(Number(span.file_id)))
      .filter((file) => file?.source_kind === "report" || file?.source_kind === "mychart");
    if (!cited.length) return null;
    return cited.some((file) => file.source_kind === "mychart") ? "mychart" : "report";
  };

  imaging.findings = imaging.findings.map((finding: any, index: number) => {
    finding.source_spans = finding.source_spans.filter(keep);
    if (derivedMyChart) {
      finding.source = "mychart";
    } else if (finding.source === "report" || finding.source === "mychart") {
      const source = authoritativeKind(finding.source_spans);
      if (source) {
        finding.source = source;
      } else {
        finding.source = "image_ai";
        finding.severity = "not_stated";
        finding.certainty = "unconfirmed";
      }
    } else if (finding.source !== "image_ai" && !(opts.userCorrection && finding.source === "patient")) {
      finding.source = "image_ai";
    }
    if (finding.source === "image_ai") {
      return constrainImageAiFinding(finding, index);
    }
    return finding;
  });
  imaging.recommendations = imaging.recommendations.filter((recommendation: any) => {
    recommendation.source_spans = recommendation.source_spans.filter(keep);
    if (derivedMyChart) {
      recommendation.source = "mychart";
      return true;
    }
    if (recommendation.source !== "report" && recommendation.source !== "mychart") return false;
    const source = authoritativeKind(recommendation.source_spans);
    if (!source) return false;
    recommendation.source = source;
    return true;
  });

  // Report-section prose has no per-section span field. It is retained only when
  // the study owns at least one attachment declared as written report/MyChart, or
  // when this is an internal MyChart text study linked to its source document.
  if (!derivedMyChart && !writtenFiles.length) {
    if (!opts.userCorrection) {
      imaging.report = {
        history: null,
        technique: null,
        comparison: null,
        findings: null,
        impression: null,
        addendum: null,
      };
      imaging.report_status = "unknown";
      imaging.study = {
        ...imaging.study,
        raw_modality: imaging.study.modality === "UNKNOWN" ? null : imaging.study.modality,
        procedure: null,
        accession: null,
        study_instance_uid: null,
        facility: null,
        ordering_clinician: null,
        interpreting_clinician: null,
      };
      imaging.anatomy = { ...imaging.anatomy, verbatim_site: null, code: null };
      imaging.dicom = { study_instance_uid: null, series: [] };
      imaging.provenance.source_amended_at = null;
      imaging.provenance.source_amendment = null;
    }
  }
  imaging.provenance.source_kind = derivedMyChart ? "mychart" : imagingStudySourceKind(studyId);
  return imaging;
}

function parsedImaging(row: any): any | null {
  try {
    return row?.parsed_json ? (JSON.parse(row.parsed_json)?.imaging_study ?? null) : null;
  } catch {
    return null;
  }
}

export function imagingStudyRevision(id: number): string | null {
  return imagingStudyRevisionState(id)?.revision ?? null;
}

export interface ImagingStudyRevisionState {
  revision: string;
  parsed_revision: string;
  attachment_revision: string;
}

export function imagingStudyRevisionState(id: number): ImagingStudyRevisionState | null {
  const row = getHealthDocumentRaw(id) as any;
  if (!row || row.kind !== "imaging") return null;
  const files = listImagingStudyFilesRaw(id).map((file) => ({
    id: Number(file.id),
    sequence: Number(file.sequence),
    sha256: String(file.sha256 ?? ""),
    source_kind: String(file.source_kind ?? ""),
  }));
  const parsed_revision = crypto
    .createHash("sha256")
    .update(String(row.parsed_json ?? ""), "utf8")
    .digest("hex");
  const attachment_revision = crypto.createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex");
  const revision = crypto
    .createHash("sha256")
    .update(`${parsed_revision}|${attachment_revision}`, "utf8")
    .digest("hex");
  return { revision, parsed_revision, attachment_revision };
}

function imagingClinicalFingerprint(raw: any): string {
  const study = coerceImagingStudy(raw);
  const clinical = {
    report_status: study.report_status,
    study: study.study,
    anatomy: study.anatomy,
    report: study.report,
    findings: study.findings.map(({ source_spans: _spans, ...finding }: any) => finding),
    recommendations: study.recommendations.map(
      ({ source_spans: _spans, status: _status, ...recommendation }: any) => recommendation
    ),
    dicom: study.dicom,
  };
  return crypto.createHash("sha256").update(JSON.stringify(clinical), "utf8").digest("hex");
}

function preserveUserState(currentRaw: any, next: any): any {
  const current = coerceImagingStudy(currentRaw);
  const unchanged = imagingClinicalFingerprint(current) === imagingClinicalFingerprint(next);
  next.verification.needs_confirmation = unchanged ? current.verification.needs_confirmation : true;
  next.verification.user_confirmed = unchanged ? current.verification.user_confirmed : false;
  next.verification.user_confirmed_at = unchanged ? current.verification.user_confirmed_at : null;
  next.verification.corrected_at = unchanged ? current.verification.corrected_at : next.verification.corrected_at;
  next.verification.notes = unchanged ? current.verification.notes : next.verification.notes;
  next.verification.clinician_confirmed = false;
  next.verification.clinician_confirmed_at = null;
  const statuses = new Map(current.recommendations.map((r: any) => [r.id, r.status]));
  for (const recommendation of next.recommendations) {
    const status = statuses.get(recommendation.id);
    if (status && isImagingRecommendationStatus(status)) recommendation.status = status;
  }
  return next;
}

export function createImagingStudy(input: any = {}) {
  const docDate = isoDate(input.doc_date ?? input.study?.study_date);
  const imaging = emptyImagingStudy({
    ...input,
    study: { ...(input.study && typeof input.study === "object" ? input.study : {}), study_date: docDate },
  });
  return addHealthDocument({
    kind: "imaging",
    doc_date: imaging.study.study_date,
    original_name: text(input.original_name, 240),
    parsed_json: { imaging_study: imaging },
    summary: text(input.summary, 1000),
    enrichment_status: "draft",
    source_doc_id: input.source_doc_id ?? null,
  });
}

export function publicImagingStudyFile(row: any) {
  if (!row) return null;
  const {
    file_path,
    sha256: _sha256,
    dicom_study_uid: _studyUid,
    dicom_series_uid: _seriesUid,
    dicom_sop_uid: _sopUid,
    original_name,
    ...rest
  } = row;
  return { ...rest, original_name: row.source_kind === "dicom" ? null : original_name, has_file: !!file_path };
}

export function publicImagingPayload(raw: any): any {
  const value = raw && typeof raw === "object" ? structuredClone(raw) : raw;
  const imaging = value?.imaging_study ?? value;
  if (!imaging || typeof imaging !== "object") return value;
  if (imaging.study && typeof imaging.study === "object") {
    delete imaging.study.accession;
    delete imaging.study.study_instance_uid;
  }
  if (imaging.provenance && typeof imaging.provenance === "object") delete imaging.provenance.source_hash;
  const series = Array.isArray(imaging.dicom?.series) ? imaging.dicom.series : [];
  imaging.dicom = {
    series_count: series.length,
    instance_count: series.reduce((sum: number, item: any) => sum + Number(item?.instance_count ?? 0), 0),
    frame_count: series.reduce((sum: number, item: any) => sum + Number(item?.frame_count ?? 0), 0),
    preview_limitations: [...new Set(series.map((item: any) => item?.preview_support_reason).filter(Boolean))].slice(
      0,
      8
    ),
  };
  return value;
}

export function listImagingStudyFilesRaw(studyId: number): any[] {
  return db
    .prepare(`SELECT * FROM imaging_study_files WHERE health_document_id = ? ORDER BY sequence, id`)
    .all(studyId) as any[];
}

export function listImagingPromptFilesRaw(studyId: number): any[] {
  const ordinary = listImagingStudyFilesRaw(studyId).filter((file) => file.source_kind !== "dicom");
  const previews = db
    .prepare(
      `SELECT f.id, f.sequence, i.preview_path AS file_path, 'image/png' AS mime,
            'dicom_preview' AS source_kind, NULL AS original_name
       FROM dicom_instances i
       JOIN dicom_series s ON s.id=i.series_id
       JOIN imaging_study_files f ON f.id=i.imaging_study_file_id
      WHERE s.health_document_id=? AND i.preview_path IS NOT NULL
      ORDER BY COALESCE(s.series_number,2147483647), s.id, COALESCE(i.instance_number,2147483647), i.id
      LIMIT 8`
    )
    .all(studyId) as any[];
  return [...ordinary, ...previews];
}

export function listImagingStudyFiles(studyId: number): any[] {
  return listImagingStudyFilesRaw(studyId).map(publicImagingStudyFile);
}

export function imagingStudySourceHash(studyId: number): string | null {
  const hashes = listImagingStudyFilesRaw(studyId)
    .map((file) => String(file.sha256 ?? ""))
    .filter(Boolean);
  return hashes.length ? crypto.createHash("sha256").update(hashes.join("|"), "utf8").digest("hex") : null;
}

export function imagingStudySourceKind(studyId: number): "report" | "images" | "report_and_images" {
  const kinds = new Set(listImagingStudyFilesRaw(studyId).map((file) => file.source_kind));
  const report = kinds.has("report") || kinds.has("mychart");
  const images = kinds.has("image") || kinds.has("dicom") || kinds.has("dicom_preview");
  return report && images ? "report_and_images" : report ? "report" : "images";
}

export function getImagingStudyFileRaw(studyId: number, fileId: number): any | null {
  return (
    db.prepare(`SELECT * FROM imaging_study_files WHERE id = ? AND health_document_id = ?`).get(fileId, studyId) ?? null
  );
}

export function imagingStudyUploadAllowance(
  studyId: number,
  nextBytes: number,
  sourceKind: "ordinary" | "dicom" = "ordinary"
): { ok: true } | { ok: false; status: 400 | 413; error: string } {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM imaging_study_files WHERE health_document_id = ?
         AND ${sourceKind === "dicom" ? "source_kind = 'dicom'" : "source_kind != 'dicom'"}`
    )
    .get(studyId) as any;
  const maxFiles = sourceKind === "dicom" ? MAX_DICOM_INSTANCES_PER_STUDY : MAX_IMAGING_FILES_PER_STUDY;
  const maxBytes = sourceKind === "dicom" ? MAX_DICOM_STUDY_BYTES : MAX_IMAGING_STUDY_BYTES;
  if (Number(totals?.files ?? 0) >= maxFiles) {
    return { ok: false, status: 400, error: `study is limited to ${maxFiles} files` };
  }
  if (Number(totals?.bytes ?? 0) + nextBytes > maxBytes) {
    return {
      ok: false,
      status: 413,
      error:
        sourceKind === "dicom"
          ? "DICOM study files exceed the aggregate limit"
          : "study files exceed the 64 MB aggregate limit",
    };
  }
  return { ok: true };
}

export function addImagingStudyFile(input: {
  study_id: number;
  original_name?: unknown;
  mime: string;
  file_path: string;
  size_bytes: number;
  sha256: string;
  source_kind?: unknown;
  dicom_study_uid?: unknown;
  dicom_series_uid?: unknown;
  dicom_sop_uid?: unknown;
}) {
  const study = getHealthDocumentRaw(input.study_id) as any;
  if (!study || study.kind !== "imaging") throw new Error("imaging study not found");
  const mime = String(input.mime || "").toLowerCase();
  const requestedSource = String(input.source_kind ?? "")
    .trim()
    .toLowerCase();
  const isDicom = requestedSource === "dicom";
  if (!IMAGING_FILE_MIMES.has(mime) && !(isDicom && mime === "application/dicom"))
    throw new Error("imaging files must be JPEG, PNG, PDF, or imported DICOM");
  const maxFileBytes = isDicom ? MAX_DICOM_INSTANCE_BYTES : MAX_IMAGING_FILE_BYTES;
  if (!Number.isInteger(input.size_bytes) || input.size_bytes <= 0 || input.size_bytes > maxFileBytes)
    throw new Error("imaging file exceeds size limit");
  const safePath = safeUploadPath(input.file_path);
  if (!safePath) throw new Error("unsafe imaging file path");
  const sha256 = String(input.sha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid imaging file hash");
  const sourceKind = choice(
    input.source_kind,
    new Set(["report", "image", "mychart", "dicom", "dicom_preview"]),
    mime === "application/pdf" ? "report" : "image"
  );
  const existing = db
    .prepare(`SELECT * FROM imaging_study_files WHERE health_document_id = ? AND sha256 = ?`)
    .get(input.study_id, sha256) as any;
  if (existing) {
    if (
      existing.mime !== mime ||
      Number(existing.size_bytes) !== input.size_bytes ||
      existing.source_kind !== sourceKind
    ) {
      throw new Error("duplicate imaging bytes conflict with stored mime, size, or source role");
    }
    return { ...publicImagingStudyFile(existing), reused: true };
  }
  const allowance = imagingStudyUploadAllowance(input.study_id, input.size_bytes, isDicom ? "dicom" : "ordinary");
  if (!allowance.ok) throw new Error(allowance.error);
  try {
    const info = db
      .prepare(
        `INSERT INTO imaging_study_files (health_document_id, sequence, original_name, mime, file_path, size_bytes, sha256, source_kind,
          dicom_study_uid, dicom_series_uid, dicom_sop_uid)
       SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM imaging_study_files WHERE health_document_id = ?`
      )
      .run(
        input.study_id,
        text(input.original_name, 240),
        mime,
        safePath,
        input.size_bytes,
        sha256,
        sourceKind,
        text(input.dicom_study_uid, 128),
        text(input.dicom_series_uid, 128),
        text(input.dicom_sop_uid, 128),
        input.study_id
      );
    return {
      ...publicImagingStudyFile(
        db.prepare(`SELECT * FROM imaging_study_files WHERE id = ?`).get(Number(info.lastInsertRowid))
      ),
      reused: false,
    };
  } catch (error: any) {
    if (!/UNIQUE constraint failed/.test(String(error?.message ?? ""))) throw error;
    const winner = db
      .prepare(`SELECT * FROM imaging_study_files WHERE health_document_id = ? AND sha256 = ?`)
      .get(input.study_id, sha256) as any;
    if (
      !winner ||
      winner.mime !== mime ||
      Number(winner.size_bytes) !== input.size_bytes ||
      winner.source_kind !== sourceKind
    ) {
      throw new Error("duplicate imaging bytes conflict with stored mime, size, or source role");
    }
    return { ...publicImagingStudyFile(winner), reused: true };
  }
}

export function getImagingStudy(id: number) {
  const row = getHealthDocument(id) as any;
  if (row?.kind !== "imaging") return null;
  return { ...row, study_files: listImagingStudyFiles(id) };
}

function getImagingStudyInternal(id: number): any | null {
  const row = getHealthDocumentRaw(id) as any;
  if (!row || row.kind !== "imaging") return null;
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch {
    parsed = null;
  }
  return { ...row, parsed, study_files: listImagingStudyFilesRaw(id) };
}

function oneValue(values: unknown[]): any | null {
  const present = [...new Set(values.filter((value) => value != null && value !== ""))];
  return present.length === 1 ? present[0] : null;
}

export function restoreServerOwnedDicomFields(studyId: number, imagingRaw: any): any {
  const series = db
    .prepare(
      `SELECT study_instance_uid, series_instance_uid, modality, series_number, study_date,
              study_description, description, body_part, laterality, instance_count, frame_count,
              preview_support_reason
         FROM dicom_series WHERE health_document_id=? ORDER BY COALESCE(series_number,2147483647), id`
    )
    .all(studyId) as any[];
  const imaging = coerceImagingStudy(imagingRaw);
  if (!series.length) return imaging;
  const studyUid = oneValue(series.map((item) => item.study_instance_uid));
  const rawModality = oneValue(series.map((item) => item.modality));
  const normalizedModalities = series.map((item) => normalizeImagingModality(item.modality));
  const bodyRegions = series.map((item) => normalizeImagingBodyRegion(item.body_part));
  const clinicalSystems = series.map((item) => normalizeImagingClinicalSystem(item.body_part));
  const lateralities = series.map((item) => {
    const raw = String(item.laterality ?? "")
      .trim()
      .toUpperCase();
    return raw === "L" ? "left" : raw === "R" ? "right" : raw === "B" ? "bilateral" : null;
  });
  imaging.study = {
    ...imaging.study,
    accession: null,
    study_instance_uid: studyUid,
    modality: oneValue(normalizedModalities) ?? "UNKNOWN",
    raw_modality: rawModality,
    study_date: oneValue(series.map((item) => item.study_date)),
    procedure: oneValue(series.map((item) => item.study_description)),
  };
  imaging.anatomy = {
    ...imaging.anatomy,
    body_region: oneValue(bodyRegions) ?? "unknown",
    clinical_system: oneValue(clinicalSystems) ?? "unknown",
    laterality: oneValue(lateralities) ?? "unknown",
    verbatim_site: null,
    code: null,
  };
  imaging.dicom = {
    study_instance_uid: studyUid,
    series: series.map((item) => ({
      series_instance_uid: item.series_instance_uid,
      modality: item.modality,
      description: item.description,
      series_number: item.series_number,
      instance_count: item.instance_count,
      frame_count: item.frame_count,
      preview_support_reason: item.preview_support_reason,
    })),
  };
  return imaging;
}

export type ImagingAnalysisApplyResult =
  | { status: "applied"; study: any }
  | { status: "stale"; reason: "attachments_changed" | "user_state_changed"; study: any }
  | { status: "invalid"; study: null };

export function applyImagingAnalysisResult(
  id: number,
  raw: any,
  opts: {
    sourceKind?: string;
    extractor?: string;
    sourceDocId?: number | null;
    sha256?: string | null;
    baseRevision?: string | null;
    baseRevisionState?: ImagingStudyRevisionState | null;
  } = {}
): ImagingAnalysisApplyResult {
  const row = getHealthDocumentRaw(id) as any;
  if (!row || row.kind !== "imaging") return { status: "invalid", study: null };
  const currentRevision = imagingStudyRevisionState(id);
  const expectedRevision = opts.baseRevisionState?.revision ?? opts.baseRevision;
  if (expectedRevision && currentRevision?.revision !== expectedRevision) {
    const attachmentsChanged =
      !!opts.baseRevisionState && currentRevision?.attachment_revision !== opts.baseRevisionState.attachment_revision;
    return {
      status: "stale",
      reason: attachmentsChanged ? "attachments_changed" : "user_state_changed",
      study: getImagingStudy(id),
    };
  }
  const candidate = raw?.imaging_study ?? raw;
  let imaging = constrainSourceAuthority(id, coerceImagingStudy(candidate, opts), opts);
  if (!imagingStudyHasContent(imaging)) return { status: "invalid", study: null };
  imaging.verification.needs_confirmation = true;
  imaging.verification.user_confirmed = false;
  imaging.verification.user_confirmed_at = null;
  imaging.verification.corrected_at = null;
  imaging.verification.notes = null;
  const current = parsedImaging(row);
  const hasDicom = db.prepare("SELECT 1 FROM dicom_series WHERE health_document_id=? LIMIT 1").get(id);
  if (hasDicom) {
    // DICOM identity and deterministic technical metadata are server-owned. An
    // image/report agent may add clinical transcription but cannot rewrite them.
    imaging = restoreServerOwnedDicomFields(id, imaging);
  }
  // A retry after an optimistic-lock conflict must never turn into a delayed
  // overwrite of a correction the user made while the first pass was running.
  // The correction remains the current record; the fresh pass only resolves the
  // worker state. The user can still amend it explicitly through the editor.
  if (current?.provenance?.extraction === "corrected") {
    setHealthDocEnrichStatus(id, "done");
    return { status: "applied", study: getImagingStudy(id) };
  }
  if (current) imaging = preserveUserState(current, imaging);
  const summary =
    imaging.report.impression ?? imaging.findings[0]?.finding_text ?? "Imaging report structured for review.";
  updateHealthDocFields(id, {
    parsed_json: { imaging_study: imaging },
    summary,
    kind: "imaging",
    doc_date: imaging.study.study_date ?? row.doc_date ?? null,
  });
  setHealthDocEnrichStatus(id, "done");
  return { status: "applied", study: getImagingStudy(id) };
}

export function applyImagingAnalysis(
  id: number,
  raw: any,
  opts: {
    sourceKind?: string;
    extractor?: string;
    sourceDocId?: number | null;
    sha256?: string | null;
    baseRevision?: string | null;
    baseRevisionState?: ImagingStudyRevisionState | null;
  } = {}
) {
  const result = applyImagingAnalysisResult(id, raw, opts);
  return result.status === "stale"
    ? { ...result.study, analysis_stale: true, stale_reason: result.reason }
    : result.study;
}

export function correctImagingStudy(id: number, raw: any, note?: unknown) {
  const row = getImagingStudyInternal(id) as any;
  if (!row) return null;
  const original = coerceImagingStudy(row.parsed.imaging_study);
  const rawImaging = raw?.imaging_study ?? raw;
  const suppliedStudy = rawImaging?.study && typeof rawImaging.study === "object" ? rawImaging.study : {};
  let imaging = constrainSourceAuthority(
    id,
    coerceImagingStudy(rawImaging, {
      sourceDocId: row.source_doc_id ?? null,
      sourceKind: original.provenance.source_kind,
      extractor: "user",
      sha256: original.provenance.source_hash,
    }),
    { sourceDocId: row.source_doc_id ?? null, sourceKind: original.provenance.source_kind, userCorrection: true }
  );
  // Public DTOs intentionally omit identifiers. A round-trip correction must not
  // erase an existing private/source identifier merely because it was absent.
  if (!Object.hasOwn(suppliedStudy, "accession")) imaging.study.accession = original.study.accession;
  if (!Object.hasOwn(suppliedStudy, "study_instance_uid"))
    imaging.study.study_instance_uid = original.study.study_instance_uid;
  imaging = restoreServerOwnedDicomFields(id, imaging);
  if (!imagingStudyHasContent(imaging)) return null;
  imaging.provenance.extraction = "corrected";
  imaging.provenance.extractor = "user";
  imaging.provenance.source_kind = original.provenance.source_kind;
  imaging.provenance.source_hash = original.provenance.source_hash;
  imaging.verification.needs_confirmation = true;
  imaging.verification.user_confirmed = false;
  imaging.verification.user_confirmed_at = null;
  imaging.verification.corrected_at = new Date().toISOString();
  imaging.verification.notes = text(note, 1000) ?? imaging.verification.notes;
  updateHealthDocFields(id, {
    parsed_json: { imaging_study: imaging },
    summary: imaging.report.impression ?? imaging.findings[0]?.finding_text ?? row.summary,
    kind: "imaging",
    doc_date: imaging.study.study_date ?? row.doc_date,
  });
  setHealthDocEnrichStatus(id, "done");
  return getImagingStudy(id);
}

export function confirmImagingStudy(id: number, notes?: unknown) {
  const row = getImagingStudyInternal(id) as any;
  const imaging = row?.parsed?.imaging_study;
  if (!imaging) return null;
  if (imaging.verification?.user_confirmed === true) return row; // idempotent; preserve first confirmation timestamp
  const clean = coerceImagingStudy(imaging);
  clean.verification.needs_confirmation = false;
  clean.verification.user_confirmed = true;
  clean.verification.user_confirmed_at = new Date().toISOString();
  clean.verification.notes = text(notes, 1000) ?? clean.verification.notes;
  updateHealthDocFields(id, { parsed_json: { imaging_study: clean } });
  return getImagingStudy(id);
}

export function updateImagingRecommendationStatus(id: number, recommendationId: string, status: unknown) {
  if (!isImagingRecommendationStatus(status)) throw new RangeError("invalid imaging recommendation status");
  const row = getImagingStudyInternal(id) as any;
  if (!row?.parsed?.imaging_study) return null;
  const imaging = coerceImagingStudy(row.parsed.imaging_study);
  const target = imaging.recommendations.find((r: any) => r.id === recommendationId);
  if (!target) return null;
  target.status = String(status).trim().toLowerCase();
  updateHealthDocFields(id, { parsed_json: { imaging_study: imaging } });
  return getImagingStudy(id);
}

export function replaceDerivedImagingStudies(
  sourceDocId: number,
  rawStudies: unknown,
  originalName?: string | null,
  opts: { complete?: boolean } = {}
) {
  const rawList = Array.isArray(rawStudies) ? rawStudies.slice(0, 100) : [];
  if (!rawList.length) return [];
  const candidates = rawList.map((raw) => {
    const rawStudy = raw?.imaging_study ?? raw;
    const myChartStudy =
      rawStudy && typeof rawStudy === "object"
        ? {
            ...rawStudy,
            findings: (Array.isArray(rawStudy.findings) ? rawStudy.findings : []).map((finding: any) => ({
              ...finding,
              source: "mychart",
            })),
            recommendations: (Array.isArray(rawStudy.recommendations) ? rawStudy.recommendations : []).map(
              (recommendation: any) => ({ ...recommendation, source: "mychart" })
            ),
          }
        : rawStudy;
    const imaging = constrainSourceAuthority(
      -1,
      coerceImagingStudy(myChartStudy, {
        sourceDocId,
        sourceKind: "mychart",
        extractor: "health-ingest",
      }),
      { sourceDocId, sourceKind: "mychart" }
    );
    if (!imagingStudyHasContent(imaging)) return null;
    imaging.provenance.extraction = "mychart";
    imaging.provenance.record_status = "current";
    imaging.provenance.source_amended_at = null;
    imaging.provenance.source_amendment = null;
    imaging.verification.needs_confirmation = true;
    imaging.verification.user_confirmed = false;
    imaging.verification.user_confirmed_at = null;
    imaging.verification.corrected_at = null;
    imaging.verification.notes = null;
    return imaging;
  });
  if (candidates.some((candidate) => !candidate)) return [];

  const stableStudyKey = (study: any): string | null => {
    const uid = text(study.study?.study_instance_uid ?? study.dicom?.study_instance_uid, 128);
    if (uid) return `uid:${uid}`;
    const accession = text(study.study?.accession, 120);
    if (accession) return `accession:${accession}`;
    const date = isoDate(study.study?.study_date);
    const procedure = text(study.study?.procedure, 240)?.toLowerCase();
    const region = text(study.anatomy?.body_region, 120)?.toLowerCase();
    if (date && procedure && region) return `fallback:${date}|${procedure}|${region}`;
    const conservative = [
      text(study.study?.modality, 40),
      text(study.report?.impression, 6000),
      text(study.report?.findings, 12000),
      text(study.anatomy?.clinical_system, 80),
      text(study.anatomy?.body_region, 120),
      text(study.anatomy?.laterality, 40),
    ];
    return conservative.some(Boolean) ? `content:${stableId("study", conservative)}` : null;
  };
  const existingAll = db
    .prepare(`SELECT * FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging' ORDER BY id`)
    .all(sourceDocId) as any[];
  const existingEntries = existingAll
    .map((row) => {
      const current = parsedImaging(row);
      const key = current && stableStudyKey(current);
      return { row, current, key };
    })
    .filter(
      (entry) =>
        entry.current?.provenance?.record_status !== "superseded" &&
        entry.current?.provenance?.record_status !== "conflict"
    );
  const matches = new Map<any, any>();
  const usedExisting = new Set<number>();
  for (const candidate of candidates as any[]) {
    const key = stableStudyKey(candidate);
    const match = existingEntries.find((entry) => entry.key === key && !usedExisting.has(Number(entry.row.id)));
    if (match) {
      matches.set(candidate, match);
      usedExisting.add(Number(match.row.id));
    }
  }
  const ambiguousCandidates = (candidates as any[]).filter(
    (candidate) => stableStudyKey(candidate)?.startsWith("content:") && !matches.has(candidate)
  );
  const ambiguousExisting = existingEntries.filter(
    (entry) => entry.key?.startsWith("content:") && !usedExisting.has(Number(entry.row.id))
  );
  for (let index = 0; index < Math.min(ambiguousCandidates.length, ambiguousExisting.length); index++) {
    matches.set(ambiguousCandidates[index], ambiguousExisting[index]);
    usedExisting.add(Number(ambiguousExisting[index].row.id));
  }
  const written: any[] = [];
  const amendmentStamp = new Date().toISOString();
  const markHistorical = (entry: any, status: "superseded" | "conflict", amendment: string) => {
    const historical = coerceImagingStudy(entry.current);
    historical.provenance.record_status = status;
    historical.provenance.source_amended_at = amendmentStamp;
    historical.provenance.source_amendment = amendment;
    updateHealthDocFields(Number(entry.row.id), { parsed_json: { imaging_study: historical } });
  };
  const createCandidate = (candidate: any) => {
    const row = addHealthDocument({
      kind: "imaging",
      doc_date: candidate.study.study_date,
      original_name: originalName ?? null,
      parsed_json: { imaging_study: candidate },
      summary: candidate.report.impression ?? candidate.findings[0]?.finding_text ?? "Imported imaging report",
      enrichment_status: "done",
      source_doc_id: sourceDocId,
    });
    const study = getImagingStudy(Number(row.id));
    written.push(study);
    return study;
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const candidate of candidates as any[]) {
      const match = matches.get(candidate);
      if (match) {
        if (match.current.provenance?.extraction === "corrected" && opts.complete === true) {
          markHistorical(
            match,
            "conflict",
            "A complete amended source replaced this user-corrected extraction; the correction is retained for audit."
          );
          createCandidate(candidate);
        } else {
          const imaging =
            match.current.provenance?.extraction === "corrected"
              ? match.current
              : preserveUserState(match.current, candidate);
          updateHealthDocFields(Number(match.row.id), {
            doc_date: imaging.study.study_date ?? match.row.doc_date,
            summary: imaging.report.impression ?? imaging.findings[0]?.finding_text ?? match.row.summary,
            parsed_json: { imaging_study: imaging },
          });
          setHealthDocEnrichStatus(Number(match.row.id), "done");
          written.push(getImagingStudy(Number(match.row.id)));
        }
      } else {
        createCandidate(candidate);
      }
    }
    if (opts.complete === true) {
      for (const entry of existingEntries) {
        if (usedExisting.has(Number(entry.row.id))) continue;
        markHistorical(
          entry,
          entry.current.provenance?.extraction === "corrected" ? "conflict" : "superseded",
          "This study was absent from a validated complete replacement of its source imaging list."
        );
      }
    }
    db.exec("COMMIT");
    return written;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listImagingStudiesStructured(opts: { includeHistorical?: boolean } = {}): any[] {
  const rows = db
    .prepare(
      `SELECT id, doc_date, created_at, parsed_json, summary, source_doc_id FROM health_documents WHERE kind = 'imaging' ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC`
    )
    .all() as any[];
  return rows
    .map((row) => {
      let parsed: any = null;
      try {
        parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
      } catch {
        parsed = null;
      }
      const internal = parsed?.imaging_study ? coerceImagingStudy(parsed.imaging_study) : null;
      if (!internal || !imagingStudyHasContent(internal)) return null;
      const s = publicImagingPayload(internal);
      if (!opts.includeHistorical && s.provenance.record_status !== "current") return null;
      return {
        id: row.id,
        doc_date: row.doc_date ?? null,
        source_doc_id: row.source_doc_id ?? null,
        summary: text(row.summary, 1000),
        report_status: s.report_status,
        study: s.study,
        anatomy: s.anatomy,
        impression: s.report.impression,
        findings: s.findings,
        measurements: s.findings
          .flatMap((f: any) =>
            f.measurements.map((m: any) => ({
              finding_id: f.id,
              clinical_system: f.clinical_system,
              body_region: f.body_region,
              ...m,
            }))
          )
          .slice(0, 300),
        recommendations: s.recommendations,
        provenance: s.provenance,
        verification: s.verification,
        dicom: s.dicom,
      };
    })
    .filter(Boolean);
}

export function dicomTechnicalExport(studyId: number) {
  const series = db
    .prepare(
      `SELECT id, modality, series_number, description, body_part,
            laterality, instance_count, frame_count, preview_support_reason
       FROM dicom_series WHERE health_document_id=? ORDER BY COALESCE(series_number,2147483647), id`
    )
    .all(studyId) as any[];
  return series.map(({ id, ...entry }) => ({
    ...entry,
    instances: db
      .prepare(
        `SELECT instance_number, number_of_frames,
              rows, columns, samples_per_pixel, photometric_interpretation, bits_allocated, bits_stored,
              high_bit, pixel_representation, planar_configuration, rescale_slope, rescale_intercept,
              window_center, window_width, pixel_spacing, image_position, image_orientation, slice_location,
              body_part, laterality, burned_in_annotation,
              source_deidentification_claim, preview_support_reason, size_bytes
         FROM dicom_instances WHERE series_id=? ORDER BY COALESCE(instance_number,2147483647), id`
      )
      .all(id),
  }));
}

export function imagingForCoach(): any {
  const studies = listImagingStudiesStructured();
  const index = studies.slice(0, 100).map((s) => ({
    id: s.id,
    doc_date: s.doc_date,
    modality: text(s.study?.modality, 16),
    procedure: text(s.study?.procedure, 120),
    clinical_system: text(s.anatomy?.clinical_system, 40),
    body_region: text(s.anatomy?.body_region, 80),
    laterality: text(s.anatomy?.laterality, 24),
    impression: text(s.impression, 180),
    user_confirmed: s.verification?.user_confirmed === true,
  }));
  const details = studies.slice(0, 5).map((s) => {
    const { study_instance_uid: _uid, ...safeStudy } = s.study ?? {};
    return {
      ...s,
      dicom: {
        series_count: Number(s.dicom?.series_count ?? 0),
        instance_count: Number(s.dicom?.instance_count ?? 0),
        frame_count: Number(s.dicom?.frame_count ?? 0),
        preview_limitations: Array.isArray(s.dicom?.preview_limitations) ? s.dicom.preview_limitations : [],
      },
      summary: text(s.summary, 300),
      study: {
        ...safeStudy,
        procedure: text(s.study?.procedure, 160),
        facility: text(s.study?.facility, 120),
        ordering_clinician: text(s.study?.ordering_clinician, 120),
        interpreting_clinician: text(s.study?.interpreting_clinician, 120),
      },
      impression: text(s.impression, 600),
      findings: s.findings.slice(0, 8).map((finding: any) => ({
        ...finding,
        finding_text: text(finding.finding_text, 400),
        verbatim_site: text(finding.verbatim_site, 120),
        measurements: finding.measurements.slice(0, 5).map((measurement: any) => ({
          ...measurement,
          name: text(measurement.name, 80),
          value_text: text(measurement.value_text, 80),
          qualifier: text(measurement.qualifier, 80),
          method: text(measurement.method, 80),
        })),
        source_spans: undefined,
      })),
      measurements: s.measurements.slice(0, 10).map((measurement: any) => ({
        ...measurement,
        name: text(measurement.name, 80),
        value_text: text(measurement.value_text, 80),
        qualifier: text(measurement.qualifier, 80),
        method: text(measurement.method, 80),
      })),
      recommendations: s.recommendations.slice(0, 6).map((recommendation: any) => ({
        ...recommendation,
        recommendation_text: text(recommendation.recommendation_text, 320),
        timeframe: text(recommendation.timeframe, 120),
        action: text(recommendation.action, 160),
        source_spans: undefined,
      })),
    };
  });
  const normalizeIdentityPart = (value: unknown): string =>
    String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const series = new Map<
    string,
    {
      name: string;
      concept_key: string;
      body_region: string;
      laterality: string;
      unit: string | null;
      method: string | null;
      points: any[];
    }
  >();
  for (const study of studies) {
    const date = study.study?.study_date ?? study.doc_date;
    if (!date) continue;
    for (const finding of study.findings) {
      if (finding.source !== "report" && finding.source !== "mychart") continue;
      for (const measurement of finding.measurements) {
        if (typeof measurement.value !== "number" || !Number.isFinite(measurement.value)) continue;
        const name = text(measurement.name, 80);
        const region = text(finding.body_region ?? study.anatomy?.body_region, 80);
        const unit = text(measurement.unit, 40);
        const laterality = choice(finding.laterality ?? study.anatomy?.laterality, LATERALITY, "unknown");
        const method = text(measurement.method, 80);
        if (!name || !region) continue;
        const conceptKey = normalizeIdentityPart(name);
        const methodKey = normalizeIdentityPart(method) || "unspecified";
        const key = [
          conceptKey,
          normalizeIdentityPart(region),
          laterality,
          normalizeIdentityPart(unit),
          methodKey,
        ].join("|");
        if (!series.has(key)) {
          series.set(key, {
            name,
            concept_key: conceptKey,
            body_region: region,
            laterality,
            unit,
            method,
            points: [],
          });
        }
        series.get(key)!.points.push({
          date,
          value: measurement.value,
          study_id: study.id,
          source: finding.source,
          user_confirmed: study.verification?.user_confirmed === true,
        });
      }
    }
  }
  const measurement_trends = [...series.values()]
    .map((entry) => {
      const points = entry.points
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.study_id) - Number(b.study_id))
        .slice(-8);
      if (points.length < 2) return null;
      const prior = points[points.length - 2];
      const latest = points[points.length - 1];
      return {
        name: entry.name,
        concept_key: entry.concept_key,
        body_region: entry.body_region,
        laterality: entry.laterality,
        unit: entry.unit,
        method: entry.method,
        points,
        prior,
        latest,
        source_checked: points.every((point) => point.user_confirmed === true),
        direction: latest.value > prior.value ? "increased" : latest.value < prior.value ? "decreased" : "unchanged",
      };
    })
    .filter(Boolean)
    .slice(0, 20);
  return { total: studies.length, truncated: studies.length > index.length, index, details, measurement_trends };
}

interface DicomQuarantineManifest {
  version: 1;
  study_id: number;
  mappings: Array<{ original: string; quarantined: string }>;
}

type DirectorySync = (directory: string) => void;

function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectories(directories: string[], directorySync: DirectorySync) {
  for (const directory of [...new Set(directories)]) directorySync(directory);
}

function regularFileState(filePath: string): "missing" | "regular" | "unsafe" {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? "regular" : "unsafe";
  } catch (error: any) {
    return error?.code === "ENOENT" ? "missing" : "unsafe";
  }
}

function isRegularDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasSafeUploadAncestors(filePath: string): boolean {
  const root = path.resolve(UPLOADS_DIR);
  const parent = path.dirname(path.resolve(filePath));
  const relative = path.relative(root, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !isRegularDirectory(root)) return false;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!isRegularDirectory(current)) return false;
  }
  return true;
}

function quarantinePayloads(directory: string): Set<string> | null {
  try {
    const payloads = new Set<string>();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === DICOM_QUARANTINE_MANIFEST) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) return null;
      payloads.add(path.join(directory, entry.name));
    }
    return payloads;
  } catch {
    return null;
  }
}

function samePaths(actual: Set<string>, expected: Set<string>): boolean {
  return actual.size === expected.size && [...actual].every((item) => expected.has(item));
}

function manifestMappingsAreSafe(
  directory: string,
  mappings: Array<{ original: string; quarantined: string }>
): boolean {
  if (
    path.dirname(directory) !== DICOM_QUARANTINE_DIR ||
    !isRegularDirectory(directory) ||
    !hasSafeUploadAncestors(directory)
  )
    return false;
  const allPaths = new Set<string>();
  for (const mapping of mappings) {
    const original = safeUploadPath(mapping.original);
    const quarantined = safeUploadPath(mapping.quarantined);
    const originalInQuarantine = original ? path.relative(DICOM_QUARANTINE_DIR, original) : "";
    if (
      !original ||
      !quarantined ||
      original !== mapping.original ||
      quarantined !== mapping.quarantined ||
      original === quarantined ||
      path.dirname(quarantined) !== directory ||
      path.basename(quarantined) === DICOM_QUARANTINE_MANIFEST ||
      path.basename(quarantined) === `${DICOM_QUARANTINE_MANIFEST}.tmp` ||
      !hasSafeUploadAncestors(original) ||
      !hasSafeUploadAncestors(quarantined) ||
      (!originalInQuarantine.startsWith("..") && !path.isAbsolute(originalInQuarantine)) ||
      allPaths.has(original) ||
      allPaths.has(quarantined)
    )
      return false;
    allPaths.add(original);
    allPaths.add(quarantined);
  }
  return true;
}

function removeQuarantineDirectory(directory: string, directorySync: DirectorySync) {
  fs.rmSync(directory, { recursive: true, force: true });
  directorySync(DICOM_QUARANTINE_DIR);
}

function writeQuarantineManifest(directory: string, manifest: DicomQuarantineManifest, directorySync: DirectorySync) {
  const temporary = path.join(directory, `${DICOM_QUARANTINE_MANIFEST}.tmp`);
  const target = path.join(directory, DICOM_QUARANTINE_MANIFEST);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  directorySync(directory);
}

function readQuarantineManifest(directory: string): DicomQuarantineManifest | null {
  try {
    if (!isRegularDirectory(directory)) return null;
    const manifestPath = path.join(directory, DICOM_QUARANTINE_MANIFEST);
    if (regularFileState(manifestPath) !== "regular") return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest?.version !== 1 || !Number.isInteger(manifest.study_id) || manifest.study_id <= 0) return null;
    if (!Array.isArray(manifest.mappings) || manifest.mappings.length > 20_000) return null;
    const mappings = manifest.mappings.map((mapping: any) => {
      const original = safeUploadPath(mapping?.original);
      const quarantined = safeUploadPath(mapping?.quarantined);
      const relative = quarantined ? path.relative(directory, quarantined) : "";
      const originalInQuarantine = original ? path.relative(DICOM_QUARANTINE_DIR, original) : "";
      if (
        !original ||
        !quarantined ||
        original === quarantined ||
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        path.dirname(quarantined) !== directory ||
        path.basename(quarantined) === DICOM_QUARANTINE_MANIFEST ||
        path.basename(quarantined) === `${DICOM_QUARANTINE_MANIFEST}.tmp` ||
        !hasSafeUploadAncestors(original) ||
        !hasSafeUploadAncestors(quarantined) ||
        (!originalInQuarantine.startsWith("..") && !path.isAbsolute(originalInQuarantine))
      )
        return null;
      return { original, quarantined };
    });
    if (mappings.some((mapping: any) => !mapping)) return null;
    const completeMappings = mappings as Array<{ original: string; quarantined: string }>;
    const originals = new Set(completeMappings.map((mapping) => mapping.original));
    const quarantined = new Set(completeMappings.map((mapping) => mapping.quarantined));
    const allPaths = new Set([...originals, ...quarantined]);
    if (
      originals.size !== completeMappings.length ||
      quarantined.size !== completeMappings.length ||
      allPaths.size !== completeMappings.length * 2
    )
      return null;

    const payloads = quarantinePayloads(directory);
    if (!payloads) return null;
    if (payloads.size > 0 && completeMappings.length === 0) return null;
    if ([...payloads].some((payload) => !quarantined.has(payload))) return null;
    if (
      completeMappings.some(
        (mapping) =>
          regularFileState(mapping.original) === "unsafe" || regularFileState(mapping.quarantined) === "unsafe"
      )
    )
      return null;
    return { version: 1, study_id: manifest.study_id, mappings: completeMappings };
  } catch {
    return null;
  }
}

function pathOwnerStudyIds(filePath: string): number[] {
  const rows = db
    .prepare(
      `SELECT health_document_id AS study_id FROM imaging_study_files WHERE file_path=?
       UNION ALL
       SELECT s.health_document_id AS study_id FROM dicom_instances i
         JOIN dicom_series s ON s.id=i.series_id WHERE i.preview_path=?
       UNION ALL
       SELECT target_study_id AS study_id FROM dicom_import_jobs
         WHERE staging_path=? AND target_study_id IS NOT NULL`
    )
    .all(filePath, filePath, filePath) as Array<{ study_id: number }>;
  return rows.map((row) => Number(row.study_id)).filter(Number.isInteger);
}

interface QuarantineMappingState {
  mapping: { original: string; quarantined: string };
  original: "missing" | "regular";
  quarantined: "missing" | "regular";
}

function preflightRestore(directory: string, manifest: DicomQuarantineManifest): QuarantineMappingState[] | null {
  if (!manifestMappingsAreSafe(directory, manifest.mappings)) return null;
  const payloads = quarantinePayloads(directory);
  if (!payloads) return null;
  const states: QuarantineMappingState[] = [];
  for (const mapping of manifest.mappings) {
    const owners = pathOwnerStudyIds(mapping.original);
    if (!owners.length || owners.some((owner) => owner !== manifest.study_id)) return null;
    const original = regularFileState(mapping.original);
    const quarantined = regularFileState(mapping.quarantined);
    if (
      original === "unsafe" ||
      quarantined === "unsafe" ||
      (original === "regular" && quarantined === "regular") ||
      (original === "missing" && quarantined === "missing")
    )
      return null;
    states.push({ mapping, original, quarantined });
  }
  const expectedPayloads = new Set(
    states.filter((state) => state.quarantined === "regular").map((state) => state.mapping.quarantined)
  );
  return samePaths(payloads, expectedPayloads) ? states : null;
}

function preflightPurge(directory: string, manifest: DicomQuarantineManifest): QuarantineMappingState[] | null {
  if (!manifestMappingsAreSafe(directory, manifest.mappings)) return null;
  const payloads = quarantinePayloads(directory);
  if (!payloads) return null;
  const states: QuarantineMappingState[] = [];
  for (const mapping of manifest.mappings) {
    const original = regularFileState(mapping.original);
    const quarantined = regularFileState(mapping.quarantined);
    if (original !== "missing" || quarantined !== "regular" || pathOwnerStudyIds(mapping.original).length) return null;
    states.push({ mapping, original, quarantined });
  }
  const expectedPayloads = new Set(states.map((state) => state.mapping.quarantined));
  return samePaths(payloads, expectedPayloads) ? states : null;
}

function restoreQuarantine(
  directory: string,
  manifest: DicomQuarantineManifest,
  directorySync: DirectorySync
): boolean {
  try {
    const states = preflightRestore(directory, manifest);
    if (!states) return false;
    const sourceParents = new Set<string>();
    for (const state of states) {
      if (state.quarantined !== "regular") continue;
      fs.renameSync(state.mapping.quarantined, state.mapping.original);
      sourceParents.add(path.dirname(state.mapping.original));
    }
    const remaining = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name !== DICOM_QUARANTINE_MANIFEST);
    if (remaining.length) return false;
    // These renames move quarantine payloads back to their original parents:
    // persist each destination parent before the quarantine source directory.
    syncDirectories([...sourceParents], directorySync);
    directorySync(directory);
    removeQuarantineDirectory(directory, directorySync);
    return true;
  } catch {
    return false;
  }
}

function purgeQuarantine(directory: string, manifest: DicomQuarantineManifest, directorySync: DirectorySync): boolean {
  try {
    const states = preflightPurge(directory, manifest);
    if (!states) return false;
    for (const state of states) fs.rmSync(state.mapping.quarantined);
    const remaining = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name !== DICOM_QUARANTINE_MANIFEST);
    if (remaining.length) return false;
    directorySync(directory);
    removeQuarantineDirectory(directory, directorySync);
    return true;
  } catch {
    return false;
  }
}

export function recoverImagingQuarantines(opts: { directorySync?: DirectorySync } = {}) {
  const directorySync = opts.directorySync ?? syncDirectory;
  let restored = 0;
  let removed = 0;
  let preserved = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(DICOM_QUARANTINE_DIR);
  } catch {
    return { restored, removed, preserved };
  }
  for (const name of entries) {
    const directory = safeUploadPath(path.join(DICOM_QUARANTINE_DIR, name));
    if (!directory || path.dirname(directory) !== DICOM_QUARANTINE_DIR) {
      preserved++;
      continue;
    }
    const manifest = readQuarantineManifest(directory);
    if (!manifest) {
      preserved++;
      continue;
    }
    const live = db
      .prepare("SELECT 1 FROM health_documents WHERE id=? AND kind='imaging' LIMIT 1")
      .get(manifest.study_id);
    if (live) {
      if (restoreQuarantine(directory, manifest, directorySync)) restored++;
      else preserved++;
      continue;
    }
    if (purgeQuarantine(directory, manifest, directorySync)) removed++;
    else preserved++;
  }
  return { restored, removed, preserved };
}

export function deleteImagingStudy(
  id: number,
  opts: {
    beforeDbDelete?: () => void;
    simulateCrashAfterQuarantine?: boolean;
    simulateCrashAfterCommit?: boolean;
    directorySync?: DirectorySync;
  } = {}
) {
  const row = getHealthDocumentRaw(id) as any;
  if (!row || row.kind !== "imaging") return { deleted: 0, derived: 0, files: 0 };
  const files = listImagingStudyFilesRaw(id);
  const previews = db
    .prepare(
      `SELECT i.preview_path AS file_path FROM dicom_instances i
       JOIN dicom_series s ON s.id=i.series_id
      WHERE s.health_document_id=? AND i.preview_path IS NOT NULL`
    )
    .all(id) as any[];
  const jobs = db
    .prepare(
      "SELECT id, staging_path FROM dicom_import_jobs WHERE target_study_id=? AND status IN ('queued','running')"
    )
    .all(id) as any[];
  const owned = [
    ...files,
    ...previews,
    ...jobs.filter((job) => job.staging_path).map((job) => ({ file_path: job.staging_path })),
  ];
  const paths = [...new Set(owned.map((file) => safeUploadPath(file.file_path)))];
  if (paths.some((filePath) => !filePath))
    return { deleted: 0, derived: 0, files: 0, error: "unsafe owned imaging file path" };
  const safeQuarantineRoot = safeUploadPath(DICOM_QUARANTINE_DIR);
  if (!safeQuarantineRoot) return { deleted: 0, derived: 0, files: 0, error: "unsafe imaging quarantine path" };
  const directorySync = opts.directorySync ?? syncDirectory;
  const quarantineDir = path.join(safeQuarantineRoot, crypto.randomUUID());
  try {
    fs.mkdirSync(safeQuarantineRoot, { recursive: true, mode: 0o700 });
    if (!isRegularDirectory(safeQuarantineRoot)) throw new Error("imaging quarantine root is not a directory");
    fs.mkdirSync(quarantineDir, { mode: 0o700 });
    directorySync(safeQuarantineRoot);
  } catch (error: any) {
    try {
      fs.rmSync(quarantineDir, { recursive: true, force: true });
    } catch {}
    return {
      deleted: 0,
      derived: 0,
      files: 0,
      error: `failed to create durable imaging quarantine: ${error?.message ?? error}`,
    };
  }
  const manifest: DicomQuarantineManifest = {
    version: 1,
    study_id: id,
    mappings: (paths as string[])
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => ({ original: filePath, quarantined: path.join(quarantineDir, crypto.randomUUID()) })),
  };
  try {
    writeQuarantineManifest(quarantineDir, manifest, directorySync);
    const persistedManifest = readQuarantineManifest(quarantineDir);
    if (!persistedManifest || !preflightRestore(quarantineDir, persistedManifest))
      throw new Error("imaging quarantine failed validation before payload move");
    for (const mapping of manifest.mappings) fs.renameSync(mapping.original, mapping.quarantined);
    // Persist the rename destinations before the source-entry removals. A crash
    // between these barriers may leave both names, but never neither name.
    directorySync(quarantineDir);
    syncDirectories(
      manifest.mappings.map((mapping) => path.dirname(mapping.original)),
      directorySync
    );
  } catch (error: any) {
    const restored = restoreQuarantine(quarantineDir, manifest, directorySync);
    return {
      deleted: 0,
      derived: 0,
      files: 0,
      error: `failed to quarantine imaging file: ${error?.message ?? error}`,
      ...(!restored ? { recovery_pending: true } : {}),
    };
  }
  if (opts.simulateCrashAfterQuarantine)
    return { deleted: 0, derived: 0, files: 0, simulated_crash: true, recovery_pending: true };
  let deleted = 0;
  let derived = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `UPDATE dicom_import_jobs
          SET status='failed', error_code='study_deleted', staging_path=NULL, updated_at=datetime('now')
        WHERE target_study_id=? AND status IN ('queued','running')`
    ).run(id);
    opts.beforeDbDelete?.();
    derived = Number(db.prepare("DELETE FROM health_documents WHERE source_doc_id=?").run(id).changes);
    deleted = Number(db.prepare("DELETE FROM health_documents WHERE id=? AND kind='imaging'").run(id).changes);
    if (!deleted) throw new Error("imaging study disappeared during delete");
    db.exec("COMMIT");
  } catch (error: any) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    const restored = restoreQuarantine(quarantineDir, manifest, directorySync);
    return {
      deleted: 0,
      derived: 0,
      files: 0,
      error: `failed to delete imaging study: ${error?.message ?? error}`,
      ...(!restored ? { recovery_pending: true } : {}),
    };
  }
  if (opts.simulateCrashAfterCommit)
    return {
      deleted,
      derived,
      files: manifest.mappings.length,
      jobs_canceled: jobs.length,
      simulated_crash: true,
      cleanup_pending: true,
    };
  let cleanupPending = false;
  try {
    removeQuarantineDirectory(quarantineDir, directorySync);
  } catch {
    cleanupPending = true;
  }
  return {
    deleted,
    derived,
    files: manifest.mappings.length,
    jobs_canceled: jobs.length,
    ...(cleanupPending ? { cleanup_pending: true } : {}),
  };
}
