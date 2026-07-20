import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, repo, resetTables } from "./_seed.js";
import { applyHealthIngest } from "../dist/enrich.js";
import { buildImagingStudyPrompt } from "../dist/prompt.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { imagingBuffer, imagingMimeMatches, publicImagingDraftInput } from "../dist/routes/health-docs.js";

beforeEach(() => resetTables("imaging_study_files", "health_documents", "health_directives"));

function payload(overrides = {}) {
  return {
    schema_version: 99,
    report_status: "FINAL",
    study: { modality: "MRI", raw_modality: "MR", procedure: "MRI knee without contrast", study_date: "2026-07-01" },
    anatomy: {
      clinical_system: "orthopedic",
      body_region: "left knee",
      verbatim_site: "LEFT KNEE",
      laterality: "left",
    },
    report: { findings: "Small joint effusion.", impression: "Small joint effusion. No acute osseous abnormality." },
    findings: [
      {
        source: "report",
        finding_text: "Small joint effusion",
        site: "left knee",
        laterality: "left",
        severity: "mild",
        certainty: "confirmed",
        measurements: [{ name: "effusion depth", value: 4.2, unit: "mm" }],
      },
    ],
    recommendations: [
      {
        source: "report",
        recommendation_text: "Clinical follow-up if symptoms persist",
        timeframe: "if symptoms persist",
        status: "recommended",
      },
    ],
    provenance: { source_kind: "report", extraction: "agent", extractor: "test", confidence: "high" },
    verification: { needs_confirmation: true, user_confirmed: false },
    dicom: { study_instance_uid: null, series: [] },
    ...overrides,
  };
}

function addAttachment(
  studyId,
  { sourceKind = "report", mime = "application/pdf", bytes = Buffer.from("%PDF-1.7") } = {}
) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const ext = mime === "application/pdf" ? "pdf" : "png";
  const fp = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(fp, bytes);
  return repo.addImagingStudyFile({
    study_id: studyId,
    original_name: `study.${ext}`,
    mime,
    file_path: fp,
    size_bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    source_kind: sourceKind,
  });
}

function citedPayload(fileId, overrides = {}) {
  const out = payload(overrides);
  out.findings = out.findings.map((finding) => ({ ...finding, source_spans: [{ file_id: fileId, page: 1 }] }));
  out.recommendations = out.recommendations.map((recommendation) => ({
    ...recommendation,
    source_spans: [{ file_id: fileId, page: 1 }],
  }));
  return out;
}

test("imaging coercion is bounded, normalized, stable, and keeps measurements nested", () => {
  const first = repo.coerceImagingStudy(payload());
  const second = repo.coerceImagingStudy(payload());
  assert.equal(first.schema_version, repo.IMAGING_SCHEMA_VERSION);
  assert.equal(first.report_status, "final");
  assert.equal(first.study.modality, "MR");
  assert.equal(first.study.raw_modality, "MR");
  assert.equal(first.anatomy.clinical_system, "musculoskeletal");
  assert.equal(first.anatomy.body_region, "lower_extremity.knee");
  assert.equal(first.findings[0].id, second.findings[0].id, "derived ids are stable across reanalysis");
  assert.equal(first.findings[0].measurements[0].value, 4.2);
  assert.equal("markers" in first, false);
});

test("common modality spellings normalize while preserving source wording", () => {
  const mri = repo.coerceImagingStudy(payload({ study: { modality: "MRI", raw_modality: "MRI" } }));
  const xray = repo.coerceImagingStudy(payload({ study: { modality: "X-ray" } }));
  const cat = repo.coerceImagingStudy(payload({ study: { modality: "CAT scan" } }));
  assert.deepEqual([mri.study.modality, xray.study.modality, cat.study.modality], ["MR", "XR", "CT"]);
  assert.deepEqual(
    [mri.study.raw_modality, xray.study.raw_modality, cat.study.raw_modality],
    ["MRI", "X-ray", "CAT scan"]
  );
});

test("public imaging draft input cannot forge provenance linkage and keeps dates aligned", () => {
  const input = publicImagingDraftInput(
    {
      original_name: "study.pdf",
      modality: "CAT scan",
      source_doc_id: 999,
      provenance: { source_doc_id: 999, source_kind: "mychart" },
    },
    "2026-07-18"
  );
  assert.equal("source_doc_id" in input, false);
  assert.equal("provenance" in input, false);
  const draft = repo.createImagingStudy(input);
  assert.equal(draft.doc_date, "2026-07-18");
  assert.equal(draft.parsed.imaging_study.study.study_date, "2026-07-18");
  assert.equal(draft.source_doc_id, null);
});

test("imaging upload boundary accepts only declared formats and verifies magic bytes", () => {
  assert.deepEqual([...repo.IMAGING_FILE_MIMES].sort(), ["application/pdf", "image/jpeg", "image/jpg", "image/png"]);
  assert.equal(repo.MAX_IMAGING_FILE_BYTES, 15 * 1024 * 1024);
  assert.equal(imagingBuffer("not base64!"), null);
  assert.equal(imagingMimeMatches(Buffer.from("%PDF-1.7"), "application/pdf"), true);
  assert.equal(imagingMimeMatches(Buffer.from("<svg></svg>"), "image/png"), false);
  assert.equal(imagingMimeMatches(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]), "image/jpeg"), true);
});

test("image AI stays unconfirmed and cannot invent severity or follow-up", () => {
  const study = repo.coerceImagingStudy(
    payload({
      findings: [
        {
          source: "image_ai",
          finding_text: "ACL appears fully torn; stop running and see an orthopedist",
          verbatim_site: "ACL complete tear",
          severity: "critical",
          certainty: "confirmed",
          measurements: [
            {
              name: "ACL complete tear",
              value: 12,
              unit: "mm",
              qualifier: "surgery recommended",
              method: "orthopedic diagnosis",
            },
          ],
          source_spans: [{ file_id: 1, page: 1, text: "surgery recommended" }],
        },
        {
          source: "image_ai",
          finding_text: "Asymmetric density is visible in the upper image.",
          measurements: [{ name: "AP diameter", value: 4, unit: "millimeters", qualifier: "approximately" }],
        },
      ],
      recommendations: [{ source: "image_ai", recommendation_text: "Urgent biopsy", status: "recommended" }],
    })
  );
  assert.equal(study.findings[0].source, "image_ai");
  assert.equal(study.findings[0].finding_text, "Unconfirmed image measurement.");
  assert.equal(study.findings[0].quarantined, true);
  assert.equal(study.findings[0].quarantine_reason, "image_ai_free_text_not_published");
  assert.equal(study.findings[0].severity, "not_stated");
  assert.equal(study.findings[0].certainty, "unconfirmed");
  assert.equal(study.findings[0].verbatim_site, null);
  assert.deepEqual(study.findings[0].measurements, [
    { name: "Image measurement", value: 12, value_text: null, unit: "mm", qualifier: null, method: null },
  ]);
  assert.equal(study.findings[0].source_spans[0].text, null);
  assert.equal(study.findings[1].finding_text, "Unconfirmed image asymmetry observation.");
  assert.equal(study.findings[1].quarantined, true);
  assert.deepEqual(study.findings[1].measurements, [
    { name: "Diameter", value: 4, value_text: null, unit: "mm", qualifier: null, method: null },
  ]);
  for (const bypass of [
    "ACL appears fully torn",
    "stop running",
    "orthopedist",
    "ACL complete tear",
    "surgery recommended",
    "orthopedic diagnosis",
    "approximately",
  ]) {
    assert.equal(JSON.stringify(study).toLowerCase().includes(bypass.toLowerCase()), false, bypass);
  }
  assert.deepEqual(study.recommendations, []);
});

test("image-only apply strips every untrusted free-text surface before UI, coach, or export", () => {
  const draft = repo.createImagingStudy();
  const image = addAttachment(draft.id, {
    sourceKind: "image",
    mime: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8]),
  });
  const result = repo.applyImagingAnalysis(
    draft.id,
    payload({
      study: {
        modality: "MRI",
        raw_modality: "MRI - ACL complete tear",
        procedure: "stop running and see an orthopedist",
        accession: "surgery recommended",
        study_instance_uid: "ACL-fully-torn",
        study_date: "2026-07-01",
        facility: "orthopedic surgery",
        ordering_clinician: "stop running",
        interpreting_clinician: "see an orthopedist",
      },
      anatomy: {
        clinical_system: "musculoskeletal",
        body_region: "left knee",
        verbatim_site: "ACL complete tear",
        laterality: "left",
        code: "surgery recommended",
      },
      report: { findings: "ACL appears fully torn", impression: "stop running" },
      findings: [
        {
          source: "report",
          finding_text: "ACL appears fully torn; stop running and see an orthopedist",
          measurements: [{ name: "ACL complete tear", value_text: "surgery recommended", qualifier: "stop" }],
          source_spans: [{ file_id: image.id, page: 1, text: "see an orthopedist" }],
        },
      ],
      recommendations: [{ source: "report", recommendation_text: "surgery recommended" }],
      dicom: {
        study_instance_uid: "ACL-fully-torn",
        series: [{ series_instance_uid: "surgery", modality: "MR", description: "stop running" }],
      },
    })
  );
  const imaging = result.parsed.imaging_study;
  assert.equal(imaging.study.modality, "MR");
  assert.equal(imaging.study.raw_modality, "MR");
  assert.equal(imaging.study.procedure, null);
  assert.equal(imaging.study.facility, null);
  assert.equal(imaging.anatomy.body_region, "lower_extremity.knee");
  assert.equal(imaging.anatomy.laterality, "left");
  assert.equal(imaging.anatomy.verbatim_site, null);
  assert.deepEqual(imaging.report, {
    history: null,
    technique: null,
    comparison: null,
    findings: null,
    impression: null,
    addendum: null,
  });
  assert.deepEqual(imaging.dicom, { series_count: 0, instance_count: 0, frame_count: 0, preview_limitations: [] });
  assert.deepEqual(imaging.recommendations, []);
  const publicSurfaces = JSON.stringify({ result, coach: repo.imagingForCoach(), export: repo.buildHealthExport() });
  for (const bypass of [
    "ACL appears fully torn",
    "stop running",
    "orthopedist",
    "ACL complete tear",
    "surgery recommended",
  ]) {
    assert.equal(publicSurfaces.toLowerCase().includes(bypass.toLowerCase()), false, bypass);
  }
});

test("missing or forged written attribution cannot become authoritative", () => {
  const draft = repo.createImagingStudy();
  const image = addAttachment(draft.id, {
    sourceKind: "image",
    mime: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const analyzed = repo.applyImagingAnalysis(
    draft.id,
    payload({
      report: { impression: "Model-authored diagnosis" },
      findings: [
        { finding_text: "Missing source", severity: "critical", certainty: "confirmed" },
        {
          source: "report",
          finding_text: "Forged report source",
          severity: "severe",
          certainty: "confirmed",
          source_spans: [{ file_id: image.id, page: 1 }],
        },
        { source: "patient", finding_text: "Forged patient diagnosis", severity: "critical", certainty: "confirmed" },
      ],
    }),
    { sourceKind: "report" }
  );
  const study = analyzed.parsed.imaging_study;
  assert.equal(study.provenance.source_kind, "images", "caller provenance cannot override owned file roles");
  assert.equal(study.report.impression, null);
  assert.deepEqual(study.recommendations, []);
  for (const finding of study.findings) {
    assert.equal(finding.source, "image_ai");
    assert.equal(finding.severity, "not_stated");
    assert.equal(finding.certainty, "unconfirmed");
  }
});

test("an owned written citation grants report authority, including a labeled screenshot", () => {
  const draft = repo.createImagingStudy();
  const screenshot = addAttachment(draft.id, {
    sourceKind: "report",
    mime: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  const analyzed = repo.applyImagingAnalysis(draft.id, citedPayload(screenshot.id));
  assert.equal(analyzed.parsed.imaging_study.findings[0].source, "report");
  assert.equal(analyzed.parsed.imaging_study.findings[0].severity, "mild");
  assert.equal(analyzed.parsed.imaging_study.recommendations.length, 1);
  assert.match(analyzed.parsed.imaging_study.report.impression, /effusion/i);
});

test("clinician verification fields are rejected from every coerced payload", () => {
  const study = repo.coerceImagingStudy(
    payload({
      verification: {
        needs_confirmation: false,
        user_confirmed: true,
        user_confirmed_at: "2026-07-01T00:00:00Z",
        clinician_confirmed: true,
        clinician_confirmed_at: "2026-07-01T00:00:00Z",
      },
    })
  );
  assert.equal(study.verification.clinician_confirmed, false);
  assert.equal(study.verification.clinician_confirmed_at, null);
});

test("prose-only report is successful imaging ingestion and remains marker-isolated", () => {
  const draft = repo.createImagingStudy({ doc_date: "2026-07-01" });
  addAttachment(draft.id);
  const result = repo.applyImagingAnalysis(
    draft.id,
    payload({ findings: [], recommendations: [], report: { impression: "Normal chest radiograph." } })
  );
  assert.ok(result);
  assert.equal(result.parsed.imaging_study.report.impression, "Normal chest radiograph.");
  assert.deepEqual(repo.getMarkerHistory().markers, []);
  repo.deriveDirectives();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM health_directives").get().n, 0);
});

test("confirmation and source-stated follow-up status are idempotent", () => {
  const draft = repo.createImagingStudy();
  const file = addAttachment(draft.id);
  const analyzed = repo.applyImagingAnalysis(draft.id, citedPayload(file.id));
  const recommendationId = analyzed.parsed.imaging_study.recommendations[0].id;
  const confirmed = repo.confirmImagingStudy(draft.id, "Checked against report");
  const stamp = confirmed.parsed.imaging_study.verification.user_confirmed_at;
  const confirmedAgain = repo.confirmImagingStudy(draft.id, "second call");
  assert.equal(confirmedAgain.parsed.imaging_study.verification.user_confirmed_at, stamp);
  const followed = repo.updateImagingRecommendationStatus(draft.id, recommendationId, "scheduled");
  assert.equal(followed.parsed.imaging_study.recommendations[0].status, "scheduled");
  assert.equal(repo.isImagingRecommendationStatus("bogus"), false);
  assert.throws(
    () => repo.updateImagingRecommendationStatus(draft.id, recommendationId, "bogus"),
    /invalid imaging recommendation status/
  );
});

test("late imaging analysis cannot overwrite user confirmation and non-stale reanalysis preserves tracking", () => {
  const draft = repo.createImagingStudy();
  const file = addAttachment(draft.id);
  const first = repo.applyImagingAnalysis(draft.id, citedPayload(file.id));
  const recommendationId = first.parsed.imaging_study.recommendations[0].id;
  const baseRevision = repo.imagingStudyRevision(draft.id);
  repo.confirmImagingStudy(draft.id, "source checked");
  repo.updateImagingRecommendationStatus(draft.id, recommendationId, "scheduled");
  const stale = repo.applyImagingAnalysis(
    draft.id,
    citedPayload(file.id, { report: { impression: "Late stale overwrite" } }),
    { baseRevision }
  );
  assert.equal(stale.analysis_stale, true);
  assert.equal(stale.parsed.imaging_study.verification.user_confirmed, true);
  assert.notEqual(stale.parsed.imaging_study.report.impression, "Late stale overwrite");
  assert.equal(stale.parsed.imaging_study.recommendations[0].status, "scheduled");

  const freshRevision = repo.imagingStudyRevision(draft.id);
  const unchanged = repo.applyImagingAnalysis(draft.id, citedPayload(file.id), { baseRevision: freshRevision });
  assert.equal(
    unchanged.parsed.imaging_study.verification.user_confirmed,
    true,
    "identical extraction keeps source check"
  );
  assert.equal(unchanged.parsed.imaging_study.recommendations[0].status, "scheduled");
  const changedRevision = repo.imagingStudyRevision(draft.id);
  const fresh = repo.applyImagingAnalysis(
    draft.id,
    citedPayload(file.id, { report: { impression: "Fresh source re-read" } }),
    { baseRevision: changedRevision }
  );
  assert.equal(fresh.parsed.imaging_study.report.impression, "Fresh source re-read");
  assert.equal(
    fresh.parsed.imaging_study.verification.user_confirmed,
    false,
    "changed clinical output requires a new source check"
  );
  assert.equal(fresh.parsed.imaging_study.verification.needs_confirmation, true);
  assert.equal(fresh.parsed.imaging_study.recommendations[0].status, "scheduled");
});

test("adding an attachment while analysis runs invalidates the optimistic revision", () => {
  const draft = repo.createImagingStudy();
  const report = addAttachment(draft.id);
  repo.applyImagingAnalysis(draft.id, citedPayload(report.id));
  const baseRevision = repo.imagingStudyRevision(draft.id);
  addAttachment(draft.id, {
    sourceKind: "image",
    mime: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]),
  });
  const stale = repo.applyImagingAnalysis(
    draft.id,
    citedPayload(report.id, { report: { impression: "Did not inspect newly added file" } }),
    { baseRevision }
  );
  assert.equal(stale.analysis_stale, true);
  assert.notEqual(stale.parsed.imaging_study.report.impression, "Did not inspect newly added file");
});

test("retry after a user-state conflict resolves without overwriting the correction", () => {
  const draft = repo.createImagingStudy();
  const file = addAttachment(draft.id);
  const first = repo.applyImagingAnalysis(draft.id, citedPayload(file.id));
  const correctedPayload = structuredClone(first.parsed.imaging_study);
  correctedPayload.report.impression = "User-corrected transcription must survive retry";
  repo.correctImagingStudy(draft.id, correctedPayload);
  repo.setHealthDocEnrichStatus(draft.id, "retry_needed");
  const baseRevisionState = repo.imagingStudyRevisionState(draft.id);

  const retried = repo.applyImagingAnalysisResult(
    draft.id,
    citedPayload(file.id, { report: { impression: "Fresh agent output must not overwrite correction" } }),
    { baseRevisionState }
  );
  assert.equal(retried.status, "applied");
  const after = repo.getImagingStudy(draft.id);
  assert.equal(after.enrichment_status, "done");
  assert.equal(after.parsed.imaging_study.report.impression, "User-corrected transcription must survive retry");
  assert.equal(after.parsed.imaging_study.provenance.extraction, "corrected");
});

test("user correction preserves source provenance and cannot forge clinician verification", () => {
  const draft = repo.createImagingStudy();
  const file = addAttachment(draft.id);
  const analyzed = repo.applyImagingAnalysis(draft.id, citedPayload(file.id), {
    sha256: repo.imagingStudySourceHash(draft.id),
  });
  const correction = structuredClone(analyzed.parsed.imaging_study);
  correction.report.impression = "User-corrected transcription";
  correction.provenance = { source_kind: "patient", source_hash: "forged" };
  correction.verification.clinician_confirmed = true;
  correction.verification.clinician_confirmed_at = "2026-07-01T00:00:00Z";
  const corrected = repo.correctImagingStudy(draft.id, correction);
  const study = corrected.parsed.imaging_study;
  assert.equal(study.provenance.source_kind, "report");
  assert.equal(study.provenance.source_hash, analyzed.parsed.imaging_study.provenance.source_hash);
  assert.equal(study.provenance.extraction, "corrected");
  assert.equal(study.provenance.extractor, "user");
  assert.equal(study.verification.clinician_confirmed, false);
  assert.equal(study.verification.clinician_confirmed_at, null);
});

test("ordered attachments enforce ownership, safe paths, public privacy, and complete deletion", () => {
  const a = repo.createImagingStudy();
  const b = repo.createImagingStudy();
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fp = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.png`);
  fs.writeFileSync(fp, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const file = repo.addImagingStudyFile({
    study_id: a.id,
    original_name: "knee.png",
    mime: "image/png",
    file_path: fp,
    size_bytes: 4,
    sha256: "a".repeat(64),
  });
  assert.equal(file.sequence, 1);
  const analyzed = repo.applyImagingAnalysis(
    a.id,
    payload({
      findings: [
        {
          source: "report",
          finding_text: "Owned citation",
          source_spans: [
            { file_id: file.id, page: 1 },
            { file_id: 999999, page: 2 },
            { file_id: null, page: 3, text: "detached" },
          ],
        },
      ],
    }),
    { sha256: repo.imagingStudySourceHash(a.id) }
  );
  assert.deepEqual(
    analyzed.parsed.imaging_study.findings[0].source_spans.map((span) => span.file_id),
    [file.id],
    "foreign attachment citations are removed"
  );
  assert.equal(analyzed.parsed.imaging_study.provenance.source_hash, undefined);
  assert.equal(
    JSON.parse(repo.getHealthDocumentRaw(a.id).parsed_json).imaging_study.provenance.source_hash,
    repo.imagingStudySourceHash(a.id),
    "private DB state retains the source hash"
  );
  const persisted = repo.getImagingStudyFileRaw(a.id, file.id);
  assert.equal(persisted.health_document_id, a.id);
  assert.equal(persisted.size_bytes, 4);
  assert.equal(persisted.sha256, "a".repeat(64));
  assert.equal(persisted.source_kind, "image");
  assert.equal(repo.getImagingStudyFileRaw(b.id, file.id), null, "file id cannot cross study ownership");
  assert.equal(JSON.stringify(repo.getImagingStudy(a.id)).includes(fp), false, "public study never leaks file path");
  assert.throws(
    () =>
      repo.addImagingStudyFile({
        study_id: a.id,
        mime: "image/png",
        file_path: "/tmp/outside.png",
        size_bytes: 4,
        sha256: "b".repeat(64),
      }),
    /unsafe imaging file path/
  );
  const deleted = repo.deleteImagingStudy(a.id);
  assert.equal(deleted.deleted, 1);
  assert.equal(fs.existsSync(fp), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM imaging_study_files WHERE health_document_id = ?").get(a.id).n, 0);
});

test("same-byte upload retry is idempotent and role conflicts fail closed", () => {
  const draft = repo.createImagingStudy();
  const bytes = Buffer.from("%PDF-1.7 retry");
  const first = addAttachment(draft.id, { bytes });
  const retryPath = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(retryPath, bytes);
  const retry = repo.addImagingStudyFile({
    study_id: draft.id,
    original_name: "retry.pdf",
    mime: "application/pdf",
    file_path: retryPath,
    size_bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    source_kind: "report",
  });
  assert.equal(retry.id, first.id);
  assert.equal(retry.reused, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM imaging_study_files WHERE health_document_id = ?").get(draft.id).n,
    1
  );
  assert.throws(
    () =>
      repo.addImagingStudyFile({
        study_id: draft.id,
        mime: "application/pdf",
        file_path: retryPath,
        size_bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        source_kind: "mychart",
      }),
    /conflict/
  );
  fs.rmSync(retryPath, { force: true });
});

test("unsafe owned attachment paths keep the DB row discoverable on deletion failure", () => {
  const draft = repo.createImagingStudy();
  db.prepare(
    `INSERT INTO imaging_study_files
      (health_document_id, sequence, mime, file_path, size_bytes, sha256, source_kind)
     VALUES (?, 1, 'application/pdf', '/outside/phi.pdf', 8, ?, 'report')`
  ).run(draft.id, "f".repeat(64));
  const result = repo.deleteImagingStudy(draft.id);
  assert.match(result.error, /unsafe owned imaging file path/);
  assert.ok(repo.getImagingStudy(draft.id));
});

test("per-study attachment count and aggregate byte limits are bounded", () => {
  const countStudy = repo.createImagingStudy();
  const insert = db.prepare(
    `INSERT INTO imaging_study_files
      (health_document_id, sequence, mime, file_path, size_bytes, sha256, source_kind)
     VALUES (?, ?, 'image/png', ?, 1, ?, 'image')`
  );
  for (let i = 1; i <= repo.MAX_IMAGING_FILES_PER_STUDY; i++) {
    insert.run(countStudy.id, i, path.join(UPLOADS_DIR, `count-${i}.png`), String(i).padStart(64, "0"));
  }
  assert.deepEqual(repo.imagingStudyUploadAllowance(countStudy.id, 1), {
    ok: false,
    status: 400,
    error: `study is limited to ${repo.MAX_IMAGING_FILES_PER_STUDY} files`,
  });

  const byteStudy = repo.createImagingStudy();
  db.prepare(
    `INSERT INTO imaging_study_files
      (health_document_id, sequence, mime, file_path, size_bytes, sha256, source_kind)
     VALUES (?, 1, 'application/pdf', ?, ?, ?, 'report')`
  ).run(byteStudy.id, path.join(UPLOADS_DIR, "large.pdf"), repo.MAX_IMAGING_STUDY_BYTES - 1, "c".repeat(64));
  assert.deepEqual(repo.imagingStudyUploadAllowance(byteStudy.id, 2), {
    ok: false,
    status: 413,
    error: "study files exceed the 64 MB aggregate limit",
  });
});

test("deleting a MyChart source removes attached files owned by derived imaging children", () => {
  const source = repo.addHealthDocument({ kind: "clinical_summary", original_name: "mychart.zip" });
  const child = repo.createImagingStudy({ source_doc_id: source.id, doc_date: "2026-07-01" });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fp = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(fp, Buffer.from("%PDF-1.7"));
  repo.addImagingStudyFile({
    study_id: child.id,
    original_name: "report.pdf",
    mime: "application/pdf",
    file_path: fp,
    size_bytes: 8,
    sha256: "d".repeat(64),
    source_kind: "mychart",
  });
  const deleted = repo.deleteHealthDocument(source.id);
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.derived, 1);
  assert.equal(deleted.derived_files, 1);
  assert.equal(fs.existsSync(fp), false);
  assert.equal(repo.getHealthDocument(child.id), null);
});

test("legacy imaging markers never enter marker history or deterministic directives", () => {
  repo.addHealthDocument({
    kind: "imaging",
    doc_date: "2026-07-01",
    parsed_json: { markers: [{ name: "LDL-C", value: 250, unit: "mg/dL", flag: "high" }] },
    enrichment_status: "done",
  });
  assert.deepEqual(repo.getMarkerHistory().markers, []);
  repo.deriveDirectives();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM health_directives").get().n, 0);
});

test("MyChart ingest creates linked imaging documents without conflating lab panels", () => {
  const source = repo.addHealthDocument({
    kind: "clinical_summary",
    original_name: "mychart.zip",
    enrichment_status: "pending",
  });
  const applied = applyHealthIngest(source.id, {
    panels: [
      {
        doc_date: "2026-06-01",
        kind: "bloodwork",
        summary: "lipids",
        markers: [{ name: "LDL-C", value: 120, unit: "mg/dL", flag: "high" }],
      },
    ],
    imaging_studies: [
      {
        imaging_study: payload({
          provenance: { source_kind: "mychart" },
          verification: {
            needs_confirmation: false,
            user_confirmed: true,
            user_confirmed_at: "2026-07-01T00:00:00Z",
          },
        }),
      },
    ],
  });
  assert.equal(applied, true);
  const imaging = db
    .prepare("SELECT * FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging'")
    .get(source.id);
  assert.ok(imaging);
  const parsed = JSON.parse(imaging.parsed_json);
  assert.equal(parsed.imaging_study.provenance.source_kind, "mychart");
  assert.equal(parsed.imaging_study.findings[0].source, "mychart");
  assert.equal(parsed.imaging_study.recommendations[0].source, "mychart");
  assert.equal(parsed.imaging_study.verification.needs_confirmation, true);
  assert.equal(parsed.imaging_study.verification.user_confirmed, false);
  assert.equal(parsed.imaging_study.verification.user_confirmed_at, null);
  assert.equal(Array.isArray(parsed.markers), false);
  assert.equal(repo.getMarkerHistory().markers.length, 1, "only the lab panel enters marker history");
  repo.replaceHealthPanels(source.id, [], "mychart.zip");
  assert.ok(
    db.prepare("SELECT id FROM health_documents WHERE id = ?").get(imaging.id),
    "lab-panel refresh preserves derived imaging stream"
  );
});

test("empty MyChart imaging output never erases studies and stable replacement preserves user state", () => {
  const source = repo.addHealthDocument({ kind: "clinical_summary", original_name: "mychart.zip" });
  applyHealthIngest(source.id, {
    panels: [
      { doc_date: "2026-06-01", kind: "bloodwork", summary: "lab", markers: [{ name: "A1c", value: 5.2, unit: "%" }] },
    ],
    imaging_studies: [{ imaging_study: payload({ provenance: { source_kind: "mychart" } }) }],
  });
  const firstRow = db
    .prepare("SELECT id FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging'")
    .get(source.id);
  const first = repo.getImagingStudy(firstRow.id);
  const recommendationId = first.parsed.imaging_study.recommendations[0].id;
  repo.confirmImagingStudy(firstRow.id, "checked");
  repo.updateImagingRecommendationStatus(firstRow.id, recommendationId, "scheduled");

  assert.equal(
    applyHealthIngest(source.id, {
      panels: [
        {
          doc_date: "2026-06-02",
          kind: "bloodwork",
          summary: "lab refresh",
          markers: [{ name: "A1c", value: 5.1, unit: "%" }],
        },
      ],
      imaging_studies: [],
    }),
    true
  );
  assert.ok(repo.getImagingStudy(firstRow.id), "empty candidate array preserves the imaging stream");

  applyHealthIngest(source.id, {
    panels: [
      {
        doc_date: "2026-06-03",
        kind: "bloodwork",
        summary: "lab refresh",
        markers: [{ name: "A1c", value: 5.0, unit: "%" }],
      },
    ],
    imaging_studies: [
      {
        imaging_study: payload({
          report: { findings: "Updated source", impression: "Updated MyChart impression" },
          provenance: { source_kind: "mychart" },
        }),
      },
    ],
  });
  const rows = db
    .prepare("SELECT id FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging'")
    .all(source.id);
  assert.deepEqual(
    rows.map((row) => row.id),
    [firstRow.id]
  );
  const refreshed = repo.getImagingStudy(firstRow.id).parsed.imaging_study;
  assert.equal(refreshed.report.impression, "Updated MyChart impression");
  assert.equal(refreshed.verification.user_confirmed, false, "changed clinical text requires a fresh source check");
  assert.equal(refreshed.recommendations[0].status, "scheduled");
});

test("complete nonempty MyChart replacement retires absent studies while incomplete or invalid output preserves them", () => {
  const source = repo.addHealthDocument({ kind: "clinical_summary", original_name: "mychart.zip" });
  const first = payload({
    study: { modality: "MR", procedure: "MRI left knee", accession: "ACC-1", study_date: "2026-05-01" },
    report: { impression: "First current study" },
    provenance: { source_kind: "mychart" },
  });
  const second = payload({
    study: { modality: "CT", procedure: "CT chest", accession: "ACC-2", study_date: "2026-06-01" },
    anatomy: { clinical_system: "pulmonary", body_region: "torso.chest", laterality: "not_applicable" },
    report: { impression: "Second current study" },
    provenance: { source_kind: "mychart" },
  });
  applyHealthIngest(source.id, {
    panels: [{ doc_date: "2026-06-01", markers: [{ name: "A1c", value: 5.2, unit: "%" }] }],
    imaging_studies_complete: true,
    imaging_studies: [{ imaging_study: first }, { imaging_study: second }],
  });
  assert.equal(repo.listImagingStudiesStructured().length, 2);

  applyHealthIngest(source.id, {
    panels: [{ doc_date: "2026-06-02", markers: [{ name: "A1c", value: 5.1, unit: "%" }] }],
    imaging_studies_complete: false,
    imaging_studies: [],
  });
  assert.equal(repo.listImagingStudiesStructured().length, 2, "empty incomplete extraction preserves current studies");

  applyHealthIngest(source.id, {
    panels: [{ doc_date: "2026-06-03", markers: [{ name: "A1c", value: 5.0, unit: "%" }] }],
    imaging_studies_complete: true,
    imaging_studies: [{ imaging_study: {} }],
  });
  assert.equal(repo.listImagingStudiesStructured().length, 2, "invalid complete extraction cannot retire studies");

  applyHealthIngest(source.id, {
    panels: [{ doc_date: "2026-06-04", markers: [{ name: "A1c", value: 4.9, unit: "%" }] }],
    imaging_studies_complete: true,
    imaging_studies: [{ imaging_study: first }],
  });
  assert.equal(repo.listImagingStudiesStructured().length, 1);
  const all = repo.listImagingStudiesStructured({ includeHistorical: true });
  assert.equal(all.length, 2);
  const retired = all.find((study) => study.id !== repo.listImagingStudiesStructured()[0].id);
  assert.equal(retired.provenance.record_status, "superseded");
  assert.match(retired.provenance.source_amendment, /absent from a validated complete replacement/i);
  assert.equal(repo.listHealthDocuments().filter((doc) => doc.kind === "imaging").length, 1);
  assert.equal(repo.imagingForCoach().total, 1);
  assert.equal(repo.buildHealthExport().imagingStudies.length, 1);
});

test("complete amended MyChart source preserves a corrected conflict and publishes a new current study", () => {
  const source = repo.addHealthDocument({ kind: "clinical_summary", original_name: "mychart.zip" });
  const original = payload({
    study: { modality: "XR", procedure: "Chest radiograph", accession: "ACC-AMEND", study_date: "2026-06-01" },
    anatomy: { clinical_system: "pulmonary", body_region: "torso.chest", laterality: "not_applicable" },
    report: { impression: "Original source impression" },
    provenance: { source_kind: "mychart" },
  });
  applyHealthIngest(source.id, {
    panels: [{ doc_date: "2026-06-01", markers: [{ name: "A1c", value: 5.2, unit: "%" }] }],
    imaging_studies_complete: true,
    imaging_studies: [{ imaging_study: original }],
  });
  const old = repo.listImagingStudiesStructured()[0];
  const correctedPayload = structuredClone(repo.getImagingStudy(old.id).parsed.imaging_study);
  correctedPayload.report.impression = "User-corrected transcription retained for audit";
  repo.correctImagingStudy(old.id, correctedPayload);

  const amended = payload({
    study: { modality: "XR", procedure: "Chest radiograph", accession: "ACC-AMEND", study_date: "2026-06-01" },
    anatomy: { clinical_system: "pulmonary", body_region: "torso.chest", laterality: "not_applicable" },
    report: { impression: "Amended radiologist impression" },
    provenance: { source_kind: "mychart" },
  });
  applyHealthIngest(source.id, {
    panels: [{ doc_date: "2026-06-02", markers: [{ name: "A1c", value: 5.1, unit: "%" }] }],
    imaging_studies_complete: true,
    imaging_studies: [{ imaging_study: amended }],
  });

  const current = repo.listImagingStudiesStructured();
  assert.equal(current.length, 1);
  assert.notEqual(current[0].id, old.id);
  assert.equal(current[0].impression, "Amended radiologist impression");
  const all = repo.listImagingStudiesStructured({ includeHistorical: true });
  assert.equal(all.length, 2);
  const conflict = all.find((study) => study.id === old.id);
  assert.equal(conflict.provenance.record_status, "conflict");
  assert.equal(conflict.provenance.extraction, "corrected");
  assert.equal(conflict.impression, "User-corrected transcription retained for audit");
  assert.match(conflict.provenance.source_amendment, /retained for audit/i);
  assert.equal(repo.buildHealthExport().imagingStudies.length, 1);
});

test("identifier-poor MyChart imaging import is idempotent by conservative content fingerprint", () => {
  const source = repo.addHealthDocument({ kind: "clinical_summary", original_name: "mychart.zip" });
  const candidate = payload({
    study: { modality: "XR", procedure: null, study_date: null, accession: null, study_instance_uid: null },
    anatomy: { clinical_system: "pulmonary", body_region: "torso.chest", laterality: "not_applicable" },
    report: { findings: "Clear lungs.", impression: "No acute cardiopulmonary finding." },
    provenance: { source_kind: "mychart" },
  });
  repo.replaceDerivedImagingStudies(source.id, [{ imaging_study: candidate }], "mychart.zip");
  repo.replaceDerivedImagingStudies(source.id, [{ imaging_study: candidate }], "mychart.zip");
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging'").get(source.id).n,
    1
  );
  const second = {
    ...candidate,
    report: { findings: "Small effusion.", impression: "Small pleural effusion." },
  };
  repo.replaceDerivedImagingStudies(
    source.id,
    [{ imaging_study: candidate }, { imaging_study: second }],
    "mychart.zip"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging'").get(source.id).n,
    2,
    "a surplus ambiguous study is inserted instead of silently dropped"
  );
});

test("coach context includes all studies and structured export uses DiagnosticReport/Observation semantics", () => {
  for (let i = 0; i < 7; i++) {
    const draft = repo.createImagingStudy({ doc_date: `2026-07-${String(i + 1).padStart(2, "0")}` });
    const file = addAttachment(draft.id, { bytes: Buffer.from(`%PDF-1.7 study-${i}`) });
    repo.applyImagingAnalysis(
      draft.id,
      citedPayload(file.id, {
        report: { impression: `Study ${i + 1}` },
        findings: [
          {
            source: "report",
            finding_text: `Finding ${i + 1}`,
            measurements: [{ name: "length", value: i + 1, unit: "mm" }],
          },
        ],
      })
    );
  }
  const context = repo.getCoachContext();
  assert.equal(context.imaging.total, 7);
  assert.equal(context.imaging.index.length, 7, "coach receives a compact full index");
  assert.equal(context.imaging.details.length, 5, "detailed studies are bounded");
  assert.equal(JSON.stringify(context.imaging).includes("file_path"), false);
  const exp = repo.buildHealthExport();
  assert.equal(exp.imagingStudies.length, 7);
  assert.equal(exp.imagingStudies[0].resourceType, "DiagnosticReport");
  assert.equal(exp.imagingStudies[0].result[0].resourceType, "Observation");
  assert.equal(exp.imagingStudies[0].result[0].components[0].valueQuantity.unit, "mm");
});

test("coach projection caps detailed imaging text and strips source excerpts without truncating export", () => {
  for (let i = 0; i < 10; i++) {
    const draft = repo.createImagingStudy({ doc_date: `2026-06-${String(i + 1).padStart(2, "0")}` });
    const file = addAttachment(draft.id, { bytes: Buffer.from(`%PDF-1.7 bound-${i}`) });
    repo.applyImagingAnalysis(
      draft.id,
      citedPayload(file.id, {
        report: { impression: `I${i} ${"x".repeat(8000)}` },
        findings: [
          {
            source: "report",
            finding_text: `F${i} ${"y".repeat(3000)}`,
            source_spans: [{ file_id: file.id, page: 1, text: "private excerpt" }],
            measurements: Array.from({ length: 20 }, (_, m) => ({
              name: `measure-${m}-${"z".repeat(200)}`,
              value: m,
              unit: "mm",
            })),
          },
        ],
        recommendations: [],
      })
    );
  }
  const imaging = repo.getCoachContext().imaging;
  assert.equal(imaging.total, 10);
  assert.equal(imaging.index.length, 10);
  assert.equal(imaging.details.length, 5);
  assert.equal(JSON.stringify(imaging).includes("private excerpt"), false);
  assert.ok(JSON.stringify(imaging).length < 60_000);
  assert.equal(repo.buildHealthExport().imagingStudies.length, 10);
});

test("coach imaging index is capped while full listing/export remain complete", () => {
  for (let i = 0; i < 105; i++) {
    repo.addHealthDocument({
      kind: "imaging",
      doc_date: "2026-01-01",
      parsed_json: {
        imaging_study: payload({
          report: { impression: `Indexed study ${i}` },
          findings: [],
          recommendations: [],
          provenance: { source_kind: "mychart", source_doc_id: 1 },
        }),
      },
      enrichment_status: "done",
    });
  }
  const projection = repo.imagingForCoach();
  assert.equal(projection.total, 105);
  assert.equal(projection.index.length, 100);
  assert.equal(projection.truncated, true);
  assert.equal(projection.details.length, 5);
  assert.ok(JSON.stringify(projection).length < 100_000);
  assert.equal(repo.listImagingStudiesStructured().length, 105);
  assert.equal(repo.buildHealthExport().imagingStudies.length, 105);
});

test("coach projection summarizes comparable imaging measurements without interpretation", () => {
  for (const [date, angle] of [
    ["2026-01-01", 18],
    ["2026-07-01", 14],
  ]) {
    const draft = repo.createImagingStudy({ doc_date: date });
    const file = addAttachment(draft.id, { bytes: Buffer.from(`%PDF-1.7 cobb-${date}`) });
    repo.applyImagingAnalysis(
      draft.id,
      citedPayload(file.id, {
        study: { modality: "XR", procedure: "Standing scoliosis series", study_date: date },
        anatomy: { clinical_system: "musculoskeletal", body_region: "spine.thoracic", laterality: "midline" },
        findings: [
          {
            source: "report",
            finding_text: "Thoracic curvature",
            body_region: "spine.thoracic",
            measurements: [{ name: "Cobb angle", value: angle, unit: "deg" }],
          },
        ],
        recommendations: [],
      })
    );
  }
  const aiDraft = repo.createImagingStudy({ doc_date: "2026-08-01" });
  addAttachment(aiDraft.id, {
    sourceKind: "image",
    mime: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4]),
  });
  repo.applyImagingAnalysis(
    aiDraft.id,
    payload({
      study: { modality: "XR", study_date: "2026-08-01" },
      anatomy: { clinical_system: "musculoskeletal", body_region: "spine.thoracic", laterality: "midline" },
      report: {},
      findings: [
        {
          source: "image_ai",
          finding_text: "Model-estimated curvature",
          body_region: "spine.thoracic",
          measurements: [{ name: "Cobb angle", value: 40, unit: "deg" }],
        },
      ],
      recommendations: [],
    })
  );
  const trends = repo.imagingForCoach().measurement_trends;
  assert.equal(trends.length, 1);
  assert.equal(trends[0].name, "Cobb angle");
  assert.deepEqual(
    trends[0].points.map((point) => point.value),
    [18, 14]
  );
  assert.equal(trends[0].prior.value, 18);
  assert.equal(trends[0].latest.value, 14);
  assert.equal(trends[0].direction, "decreased");
  assert.equal(trends[0].source_checked, false);
  assert.deepEqual(
    trends[0].points.map((point) => point.source),
    ["report", "report"]
  );
  assert.equal("interpretation" in trends[0], false);
});

test("imaging trend identity keeps laterality and measurement methods separate", () => {
  const series = [
    ["2026-01-01", "left", "manual caliper", 3.1, "Tendon thickness"],
    ["2026-02-01", "left", "manual caliper", 3.4, "TENDON-thickness"],
    ["2026-01-01", "right", "manual caliper", 4.1, "Tendon thickness"],
    ["2026-02-01", "right", "manual caliper", 4.0, "Tendon thickness"],
    ["2026-01-01", "left", "automated segmentation", 2.8, "Tendon thickness"],
    ["2026-02-01", "left", "automated segmentation", 2.9, "Tendon thickness"],
  ];
  for (const [date, laterality, method, value, name] of series) {
    const draft = repo.createImagingStudy({ doc_date: date });
    const file = addAttachment(draft.id, { bytes: Buffer.from(`%PDF-1.7 trend-${date}-${laterality}-${method}`) });
    repo.applyImagingAnalysis(
      draft.id,
      citedPayload(file.id, {
        study: { modality: "US", procedure: "Patellar tendon ultrasound", study_date: date },
        anatomy: { clinical_system: "musculoskeletal", body_region: "lower_extremity.knee", laterality },
        findings: [
          {
            source: "report",
            finding_text: "Patellar tendon measurement",
            body_region: "lower_extremity.knee",
            laterality,
            measurements: [{ name, value, unit: "mm", method }],
          },
        ],
        recommendations: [],
      })
    );
  }
  const trends = repo.imagingForCoach().measurement_trends;
  assert.equal(trends.length, 3);
  assert.ok(trends.every((trend) => trend.concept_key === "tendon thickness"));
  assert.deepEqual(
    trends
      .map((trend) => [trend.laterality, trend.method, trend.points.map((point) => point.value)])
      .sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`)),
    [
      ["left", "automated segmentation", [2.8, 2.9]],
      ["left", "manual caliper", [3.1, 3.4]],
      ["right", "manual caliper", [4.1, 4]],
    ]
  );
});

test("joint imaging prompt makes written report authoritative and forbids AI follow-up", () => {
  const prompt = buildImagingStudyPrompt([
    { id: 1, sequence: 1, path: "/uploads/report.pdf", mime: "application/pdf", source_kind: "report" },
  ]);
  assert.match(prompt, /written radiologist report is authoritative/i);
  assert.match(prompt, /may NOT invent or assign a diagnosis, severity, certainty, prognosis, or follow-up/i);
  assert.match(prompt, /prose-only written report is valid/i);
  assert.doesNotMatch(prompt, /\/uploads\/report\.pdf/);
  assert.match(prompt, /"relative_path":"uploads\/report\.pdf"/);
  assert.match(prompt, /unconfirmed/);
  assert.match(prompt, /Never emit a span without file_id/i);
});
