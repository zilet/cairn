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
import { findDuplicateHealthUpload } from "../dist/repo/health-upload-duplicate.js";
import { dedupeHealthDocuments } from "../dist/repo/health-dedupe.js";

beforeEach(() => {
  resetTables("imaging_study_files", "health_documents", "health_directives");
  repo.setSettings({ enrich_enabled: false });
});

const REPORT = `EXAM: CT CARDIAC CALCIUM SCORING
DATE: 2026-10-28
FINDINGS: Total Agatston score 0.
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
