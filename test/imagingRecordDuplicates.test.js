// A pasted imaging report is one record: an identical re-paste is the record
// already on file (no second document, no second ingest), a pasted report filed
// as imaging still re-reads and deletes as the upload it is, and twin studies of
// one scan (same day, procedure and impression) fold through the dedupe route.
// Every value here is invented.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, repo, resetTables } from "./_seed.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { healthDocsRouter } from "../dist/routes/health-docs.js";
import { findDuplicateHealthUpload, MIN_DUPLICATE_TEXT_CHARS } from "../dist/repo/health-upload-duplicate.js";
import { dedupeHealthDocuments } from "../dist/repo/health-dedupe.js";

beforeEach(() => {
  resetTables("imaging_study_files", "health_documents", "health_directives");
  repo.setSettings({ enrich_enabled: false });
});

const REPORT = `EXAM: CT CARDIAC CALCIUM SCORING
DATE: 2026-10-28
HISTORY: Screening. No known coronary disease.
TECHNIQUE: Non-contrast ECG-gated CT of the heart.
FINDINGS: Total Agatston score 0. No coronary artery calcium in the LM, LAD, LCx or RCA.
IMPRESSION: Calcium score 0, very low risk (CAC-DRS A0).`;

function call(method, routePath, req) {
  const layer = healthDocsRouter.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} is routed`);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
      setHeader() {},
    };
    try {
      layer.route.stack.at(-1).handle({ body: {}, query: {}, params: {}, ...req }, res, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function storedPaste(text) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fp = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(fp, text);
  return fp;
}

// The shape the ordinary ingest leaves behind for a pasted CT report: the paste
// filed as kind 'imaging' with its file, and the study derived from it.
function pastedStudy({ impression = "Calcium score 0, very low risk (CAC-DRS A0).", text = REPORT } = {}) {
  const source = repo.addHealthDocument({
    kind: "imaging",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: storedPaste(text),
    parsed_json: { clinical_facts: [{ kind: "imaging", text: "Calcium score 0" }] },
    summary: "CT coronary calcium score",
    enrichment_status: "done",
  });
  const [study] = repo.replaceDerivedImagingStudies(source.id, [
    {
      imaging_study: {
        study: { modality: "CT", procedure: "CT coronary calcium score", study_date: "2026-10-28" },
        anatomy: { clinical_system: "cardiovascular", body_region: "torso.chest", laterality: "not_applicable" },
        report: { impression },
        findings: [
          {
            finding_text: "No coronary artery calcium",
            measurements: [{ name: "Agatston score", qualifier: "total", value: 0, unit: "Agatston" }],
          },
        ],
      },
    },
  ]);
  return { source, study };
}

test("an identical re-paste returns the record on file and writes nothing", async () => {
  const first = await call("post", "/", { body: { text: REPORT, original_name: "Pasted results" } });
  assert.equal(first.status, 200);
  assert.ok(first.body.id);
  assert.equal(first.body.duplicate_of, undefined);
  const count = () => db.prepare("SELECT COUNT(*) n FROM health_documents").get().n;
  assert.equal(count(), 1);

  // Same report, copied with different line breaks and spacing.
  const again = await call("post", "/", { body: { text: `  ${REPORT.replace(/\n/g, "\n\n   ")}  ` } });
  assert.equal(again.body.duplicate_of, first.body.id);
  assert.equal(again.body.id, first.body.id);
  assert.equal(count(), 1, "no second document");

  const other = await call("post", "/", { body: { text: `${REPORT}\nADDENDUM: Reviewed again.` } });
  assert.equal(other.body.duplicate_of, undefined, "different content is a new record");
  assert.equal(count(), 2);
});

test("an identical file upload matches by its bytes", async () => {
  const bytes = Buffer.from("%PDF-1.7 synthetic report bytes");
  const first = await call("post", "/", {
    body: { original_name: "a.pdf", mime: "application/pdf", data_base64: bytes.toString("base64") },
  });
  assert.equal(findDuplicateHealthUpload({ bytes }), first.body.id);
  const again = await call("post", "/", {
    body: { original_name: "b.pdf", mime: "application/pdf", data_base64: bytes.toString("base64") },
  });
  assert.equal(again.body.duplicate_of, first.body.id);
  assert.equal(findDuplicateHealthUpload({ bytes: Buffer.from("%PDF-1.7 other") }), null);
});

test("a pasted report filed as imaging re-reads as an upload and deletes with its study", async () => {
  repo.setSettings({ enrich_enabled: true });
  const { source, study } = pastedStudy();
  assert.equal(repo.isImagingSourceUpload(repo.getHealthDocumentRaw(source.id)), true);
  assert.equal(repo.isImagingSourceUpload(repo.getHealthDocumentRaw(study.id)), false);

  const rescan = await call("post", "/:id/reanalyze", { params: { id: String(source.id) } });
  assert.equal(rescan.status, 200, "never 'no study files to re-analyze'");
  assert.equal(rescan.body.enrichment_status, "pending");
  assert.ok(Number.isFinite(Date.parse(rescan.body.enrich_since)), "the card can say how long it has read");
  // The re-read was queued as an ordinary health ingest; let it settle (offline
  // agents) before touching the row again.
  const { whenEnrichQueueIdle } = await import("../dist/enrich.js");
  await new Promise((resolve) => setImmediate(resolve));
  await whenEnrichQueueIdle();
  repo.setHealthDocEnrichStatus(source.id, "done");
  assert.equal(repo.getHealthDocument(source.id).enrich_since, undefined, "cleared once settled");

  const filePath = repo.getHealthDocumentRaw(source.id).file_path;
  const removed = await call("delete", "/:id", { params: { id: String(source.id) } });
  assert.equal(removed.status, 200);
  assert.equal(repo.getHealthDocumentRaw(source.id), null);
  assert.equal(repo.getHealthDocumentRaw(study.id), null, "the derived study goes with its upload");
  assert.equal(fs.existsSync(filePath), false, "the pasted file is not orphaned");
});

test("the study delete (MCP delete_health_record / delete_imaging_study) treats a pasted source as the upload", () => {
  const { source, study } = pastedStudy();
  const filePath = repo.getHealthDocumentRaw(source.id).file_path;
  const result = repo.deleteImagingStudy(source.id);
  assert.equal(result.deleted, 1);
  assert.equal(repo.getHealthDocumentRaw(study.id), null);
  assert.equal(fs.existsSync(filePath), false, "no orphaned paste on disk");
});

test("twin studies of one scan fold through the dedupe route; a dry run first", async () => {
  const a = pastedStudy();
  const b = pastedStudy({ text: `${REPORT}\n(copy)` });
  const differs = pastedStudy({ impression: "Calcium score 12, mild plaque.", text: `${REPORT}\nre-read` });

  const dry = await call("post", "/dedupe", { body: {} });
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.merged, 1);
  const cluster = dry.body.clusters.find((c) => c.survivor.kind === "imaging");
  assert.equal(cluster.survivor.id, a.study.id, "the older study survives");
  assert.deepEqual(
    cluster.merged.map((m) => m.id),
    [b.study.id]
  );
  assert.ok(repo.getHealthDocumentRaw(b.study.id), "a dry run deletes nothing");

  const applied = await call("post", "/dedupe", { body: { apply: true } });
  assert.equal(applied.body.merged, 1);
  assert.ok(repo.getHealthDocumentRaw(a.study.id));
  assert.equal(repo.getHealthDocumentRaw(b.study.id), null);
  assert.equal(repo.getHealthDocumentRaw(b.source.id), null, "the twin's paste goes with it — no orphan card");
  assert.ok(repo.getHealthDocumentRaw(differs.study.id), "a different impression never folds");

  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0, "a fixed point");
});

test("a study the athlete corrected is never folded away", () => {
  const a = pastedStudy();
  const b = pastedStudy({ text: `${REPORT}\n(copy)` });
  const corrected = JSON.parse(repo.getHealthDocumentRaw(a.study.id).parsed_json).imaging_study;
  corrected.provenance.extraction = "corrected";
  repo.updateHealthDocFields(a.study.id, { parsed_json: { imaging_study: corrected } });
  // The corrected one ranks as the survivor; the plain twin may fold into it.
  const plan = dedupeHealthDocuments({ dryRun: true });
  const cluster = plan.clusters.find((c) => c.survivor.kind === "imaging");
  assert.equal(cluster.survivor.id, a.study.id);

  // Two corrected twins: neither is folded.
  const second = JSON.parse(repo.getHealthDocumentRaw(b.study.id).parsed_json).imaging_study;
  second.provenance.extraction = "corrected";
  repo.updateHealthDocFields(b.study.id, { parsed_json: { imaging_study: second } });
  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0);
});

// ---- What a re-paste may and may not call "already on file" ----

test("a short reading pasted again is a new reading, never already on file", async () => {
  assert.ok(REPORT.replace(/\s+/g, " ").trim().length >= MIN_DUPLICATE_TEXT_CHARS, "the CT fixture is report-sized");
  const first = await call("post", "/", { body: { text: "BP 120/80" } });
  const again = await call("post", "/", { body: { text: "BP 120/80" } });
  assert.equal(again.body.duplicate_of, undefined);
  assert.notEqual(again.body.id, first.body.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM health_documents").get().n, 2);
  assert.equal(findDuplicateHealthUpload({ text: "BP 120/80" }), null);
});

test("a re-paste that states another date or kind is another record", async () => {
  const first = await call("post", "/", { body: { text: REPORT, doc_date: "2026-10-28" } });
  const sameDay = await call("post", "/", { body: { text: REPORT, doc_date: "2026-10-28" } });
  assert.equal(sameDay.body.duplicate_of, first.body.id, "the same report on the same date is on file");

  const otherDay = await call("post", "/", { body: { text: REPORT, doc_date: "2026-11-04" } });
  assert.equal(otherDay.body.duplicate_of, undefined, "a different stated date is a new record");
  assert.notEqual(otherDay.body.id, first.body.id);

  const otherKind = await call("post", "/", { body: { text: REPORT, kind: "visit_note" } });
  assert.equal(otherKind.body.duplicate_of, undefined, "a different stated kind is a new record");
  assert.notEqual(findDuplicateHealthUpload({ text: REPORT, kind: "other" }), null, "'other' states nothing");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM health_documents").get().n, 3);
});

// ---- Which studies are the same scan ----

function xray({ laterality, text, region = "lower_extremity.knee" }) {
  const source = repo.addHealthDocument({
    kind: "imaging",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: storedPaste(text),
    parsed_json: {},
    enrichment_status: "done",
  });
  const [study] = repo.replaceDerivedImagingStudies(source.id, [
    {
      imaging_study: {
        study: { modality: "XR", procedure: "XR knee 3 views", study_date: "2026-10-20" },
        anatomy: { clinical_system: "musculoskeletal", body_region: region, laterality },
        report: { impression: "Normal." },
      },
    },
  ]);
  return { source, study };
}

test("same-day left and right knee X-rays with a normal impression stay apart", () => {
  const left = xray({ laterality: "left", text: "XR LEFT KNEE 3 VIEWS. Impression: Normal." });
  const right = xray({ laterality: "right", text: "XR RIGHT KNEE 3 VIEWS. Impression: Normal." });
  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0);
  dedupeHealthDocuments({});
  assert.ok(repo.getHealthDocumentRaw(left.study.id));
  assert.ok(repo.getHealthDocumentRaw(right.study.id));

  // Unstated laterality says nothing: two such studies fold only when they were read
  // out of two uploads of identical text.
  const a = xray({ laterality: "unknown", text: "XR KNEE. Impression: Normal.", region: "unknown" });
  const b = xray({ laterality: "unknown", text: "XR KNEE (outside read). Impression: Normal.", region: "unknown" });
  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0, "different text, unstated anatomy");
  const c = xray({ laterality: "unknown", text: "XR KNEE.\n\nImpression:   Normal.", region: "unknown" });
  const plan = dedupeHealthDocuments({ dryRun: true });
  assert.equal(plan.merged, 1, "identical normalized source text is the same scan");
  const fold = plan.clusters.find((cluster) => cluster.survivor.kind === "imaging");
  assert.equal(fold.survivor.id, a.study.id);
  assert.deepEqual(
    fold.merged.map((m) => m.id),
    [c.study.id]
  );
  assert.ok(b.study.id);
});

test("two studies split out of one upload never fold, even on identical words", () => {
  const source = repo.addHealthDocument({
    kind: "imaging",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: storedPaste("XR KNEE BILATERAL. Impression: Normal."),
    parsed_json: {},
    enrichment_status: "done",
  });
  const knee = (accession) => ({
    imaging_study: {
      study: { modality: "XR", procedure: "XR knee", study_date: "2026-10-20", accession },
      anatomy: { clinical_system: "musculoskeletal", body_region: "unknown", laterality: "unknown" },
      report: { impression: "Normal." },
    },
  });
  const studies = repo.replaceDerivedImagingStudies(source.id, [knee("ACC-1"), knee("ACC-2")]);
  assert.equal(studies.length, 2, "two studies on file");
  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0);
});

test("a twin's visit-note source with a medication fact is never deleted with it", () => {
  const a = pastedStudy();
  const note = repo.addHealthDocument({
    kind: "visit_note",
    original_name: "Visit note.txt",
    mime: "text/plain",
    file_path: storedPaste(`Visit note. Started atorvastatin 10 mg daily.\n${REPORT}`),
    parsed_json: { markers: [], clinical_facts: [{ kind: "medication", name: "Atorvastatin 10 mg daily" }] },
    summary: "PCP visit",
    enrichment_status: "done",
  });
  const [twin] = repo.replaceDerivedImagingStudies(note.id, [
    { imaging_study: JSON.parse(repo.getHealthDocumentRaw(a.study.id).parsed_json).imaging_study },
  ]);
  const applied = dedupeHealthDocuments({});
  assert.equal(applied.merged, 1, "the twin study folds");
  assert.equal(repo.getHealthDocumentRaw(twin.id), null);
  const kept = repo.getHealthDocumentRaw(note.id);
  assert.ok(kept, "the visit note stays");
  assert.ok(fs.existsSync(kept.file_path), "and keeps its file");
  assert.match(kept.parsed_json, /Atorvastatin/);
});

test("a twin's confirmation note the survivor lacks keeps the twin", () => {
  const a = pastedStudy();
  const b = pastedStudy({ text: `${REPORT}\n(copy)` });
  repo.confirmImagingStudy(a.study.id);
  repo.confirmImagingStudy(b.study.id, "Discussed with Dr. Example; repeat in 5 years.");
  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0);
  dedupeHealthDocuments({});
  assert.ok(repo.getHealthDocumentRaw(b.study.id), "the note is not lost");

  // The same note on the survivor: nothing is lost, the twin folds.
  const c = pastedStudy({ text: `${REPORT}\n(third copy)` });
  repo.confirmImagingStudy(c.study.id, "discussed with dr. example; repeat in 5 years");
  const plan = dedupeHealthDocuments({ dryRun: true });
  const cluster = plan.clusters.find((entry) => entry.survivor.kind === "imaging");
  assert.equal(cluster.survivor.id, b.study.id);
  assert.deepEqual(
    cluster.merged.map((m) => m.id),
    [c.study.id]
  );
});

// ---- One card per scan, decided on the server ----

async function listed() {
  const res = await call("get", "/", {});
  return new Map(res.body.map((row) => [row.id, row]));
}

test("the API row says which source folds into its study card", async () => {
  const pasted = pastedStudy(); // a pasted CT filed as imaging, carrying its own facts
  const lab = repo.addHealthDocument({
    kind: "bloodwork",
    original_name: "labs.txt",
    mime: "text/plain",
    file_path: storedPaste("ApoB 92 mg/dL"),
    parsed_json: { markers: [{ name: "ApoB", value: 92, unit: "mg/dL" }], imaging_only: true },
    enrichment_status: "done",
  });
  repo.replaceDerivedImagingStudies(lab.id, [
    {
      imaging_study: {
        study: { modality: "CT", procedure: "CT chest", study_date: "2026-09-01" },
        report: { impression: "No nodules." },
      },
    },
  ]);
  const onlyImaging = repo.addHealthDocument({
    kind: "other",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: storedPaste("MRI lumbar spine report"),
    parsed_json: { markers: [], imaging_only: true },
    enrichment_status: "done",
  });
  repo.replaceDerivedImagingStudies(onlyImaging.id, [
    {
      imaging_study: {
        study: { modality: "MR", procedure: "MRI lumbar spine", study_date: "2026-08-01" },
        report: { impression: "Mild L4-5 disc bulge." },
      },
    },
  ]);
  const exportDoc = repo.addHealthDocument({
    kind: "clinical_summary",
    original_name: "export.zip",
    mime: "application/zip",
    file_path: storedPaste("zip"),
    parsed_json: { markers: [] },
    enrichment_status: "done",
  });
  repo.replaceDerivedImagingStudies(exportDoc.id, [
    {
      imaging_study: {
        study: { modality: "US", procedure: "US abdomen", study_date: "2026-07-01" },
        report: { impression: "Normal." },
      },
    },
  ]);
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-07-01",
    source_doc_id: exportDoc.id,
    parsed_json: { markers: [] },
  });

  const rows = await listed();
  assert.equal(rows.get(pasted.source.id).folds_into_study, true, "a pasted CT report with its own facts folds");
  assert.equal(rows.get(onlyImaging.id).folds_into_study, true);
  assert.equal(rows.get(lab.id).folds_into_study, undefined, "a lab source with markers keeps its card");
  assert.equal(rows.get(exportDoc.id).folds_into_study, undefined, "an export that split out a panel keeps its card");
  assert.equal(rows.get(pasted.study.id).folds_into_study, undefined, "a study is never folded");
  assert.deepEqual(
    rows.get(lab.id).parsed.markers.map((m) => m.name),
    ["ApoB"],
    "API rows carry `parsed`"
  );
  assert.equal(rows.get(lab.id).parsed_json, undefined);
});

test("deleting the study card's study takes its folded source, never one with another record", async () => {
  // A pasted CT filed as imaging with its own facts: its only study's delete takes it.
  const pasted = pastedStudy();
  const file = repo.getHealthDocumentRaw(pasted.source.id).file_path;
  const removed = await call("delete", "/:id", { params: { id: String(pasted.study.id) } });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.source_deleted, 1);
  assert.equal(repo.getHealthDocumentRaw(pasted.source.id), null, "no orphan paste left to surface as a card");
  assert.equal(fs.existsSync(file), false);

  // Two studies out of one paste: deleting one keeps the source (and the other).
  const two = repo.addHealthDocument({
    kind: "imaging",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: storedPaste("XR LEFT and RIGHT KNEE"),
    parsed_json: {},
    enrichment_status: "done",
  });
  const knee = (laterality) => ({
    imaging_study: {
      study: { modality: "XR", procedure: `XR ${laterality} knee`, study_date: "2026-10-20" },
      anatomy: { clinical_system: "musculoskeletal", body_region: "lower_extremity.knee", laterality },
      report: { impression: "Normal." },
    },
  });
  const [leftKnee, rightKnee] = repo.replaceDerivedImagingStudies(two.id, [knee("left"), knee("right")]);
  await call("delete", "/:id", { params: { id: String(leftKnee.id) } });
  assert.ok(repo.getHealthDocumentRaw(two.id), "the source still carries the right knee");
  assert.ok(repo.getHealthDocumentRaw(rightKnee.id));

  // A superseded study kept for audit is still a derived row: the source stays.
  const parsed = JSON.parse(repo.getHealthDocumentRaw(rightKnee.id).parsed_json);
  const audit = repo.addHealthDocument({
    kind: "imaging",
    source_doc_id: two.id,
    doc_date: "2026-10-20",
    parsed_json: {
      imaging_study: {
        ...parsed.imaging_study,
        provenance: { ...parsed.imaging_study.provenance, record_status: "superseded" },
      },
    },
  });
  await call("delete", "/:id", { params: { id: String(rightKnee.id) } });
  assert.ok(repo.getHealthDocumentRaw(two.id), "never delete a source that still has a derived row");
  assert.ok(repo.getHealthDocumentRaw(audit.id));

  // A lab source with markers never goes with its study.
  const lab = repo.addHealthDocument({
    kind: "bloodwork",
    original_name: "labs.txt",
    mime: "text/plain",
    file_path: storedPaste("ApoB 92 mg/dL"),
    parsed_json: { markers: [{ name: "ApoB", value: 92, unit: "mg/dL" }], imaging_only: true },
    enrichment_status: "done",
  });
  const [ct] = repo.replaceDerivedImagingStudies(lab.id, [
    {
      imaging_study: {
        study: { modality: "CT", procedure: "CT chest", study_date: "2026-09-01" },
        report: { impression: "No nodules." },
      },
    },
  ]);
  await call("delete", "/:id", { params: { id: String(ct.id) } });
  assert.ok(repo.getHealthDocumentRaw(lab.id), "the lab record stays");
});
