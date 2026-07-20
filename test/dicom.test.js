import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { minimalDicom, storedZip } from "./fixtures/dicom.js";
import { decodeDicomFrame, isValidDicomUid, parseDicomPart10 } from "../dist/dicom.js";
import {
  createDicomImportJobFromStaged,
  createDicomImportJob,
  createDicomStagingPath,
  dicomManifest,
  lightweightDicomMetadata,
  publicDicomImportJob,
  recoverDicomImports,
  sortDicomManifestInstances,
} from "../dist/dicomImports.js";
import { db } from "../dist/db.js";
import { DATA_DIR } from "../dist/uploadPaths.js";
import { healthDocsRouter, stageDicomRequest } from "../dist/routes/health-docs.js";
import { registerImagingTools } from "../dist/surfaces/mcp/imaging.js";
import * as repo from "../dist/repo.js";

async function importBytes(bytes, sourceMime = "application/zip") {
  const stagingPath = createDicomStagingPath();
  fs.writeFileSync(stagingPath, bytes, { mode: 0o600 });
  let job = createDicomImportJob({ stagingPath, sourceMime, sourceBytes: bytes.length });
  for (let attempt = 0; attempt < 200 && !["done", "failed"].includes(job.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = publicDicomImportJob(job.id);
  }
  return job;
}

test("native little-endian DICOM decoding applies signed masking, rescale, window, and inversion", () => {
  const unsigned = parseDicomPart10(minimalDicom({ slope: 2, intercept: -10, photometric: "MONOCHROME1" }));
  const frame = decodeDicomFrame(unsigned, 0);
  assert.deepEqual([...frame.pixels], [-10, 244, 500]);
  assert.equal(frame.windowCenter, 100);
  assert.equal(frame.windowWidth, 200);
  assert.equal(frame.inverted, true);

  const signed = parseDicomPart10(minimalDicom({ bitsAllocated: 16, signed: true }));
  assert.deepEqual([...decodeDicomFrame(signed, 0).pixels], [-1, 0, 32767]);
});

test("classic multiframe bounds and unsupported transfer syntaxes fail explicitly", () => {
  const multi = parseDicomPart10(minimalDicom({ frames: 2, columns: 2, pixels: [1, 2, 3, 4] }));
  assert.deepEqual([...decodeDicomFrame(multi, 1).pixels], [3, 4]);
  assert.throws(() => decodeDicomFrame(multi, 2), /frame_out_of_bounds/);
  const compressed = parseDicomPart10(minimalDicom({ transferSyntax: "1.2.840.10008.1.2.4.90" }));
  assert.equal(compressed.previewSupportReason, "compressed_or_unsupported_transfer_syntax");
});

test("durable direct import creates one DICOM-only study and a UID-redacted manifest", async () => {
  const bytes = minimalDicom();
  const job = await importBytes(bytes, "application/dicom");
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.progress.instances_indexed, 1);
  const studyId = job.result.study_ids[0];
  const study = repo.getImagingStudy(studyId);
  assert.ok(study);
  assert.equal(repo.listImagingStudiesStructured().length, 1, "DICOM-only studies are valid structured records");
  const manifest = dicomManifest(studyId);
  assert.equal(manifest.series.length, 1);
  assert.equal(manifest.series[0].instances.length, 1);
  assert.equal(JSON.stringify(manifest).includes("1.2.826"), false, "ordinary manifest omits raw UIDs");
  assert.equal(JSON.stringify(repo.imagingForCoach()).includes("1.2.826"), false, "coach context omits raw UIDs");
  assert.equal(JSON.stringify(job).includes("staging"), false);
  repo.deleteImagingStudy(studyId);
});

test("extensionless ZIP entries split multiple Study UIDs deterministically", async () => {
  const zip = storedZip([
    { name: "series/a", data: minimalDicom({ study: "1.2.3.1", series: "1.2.3.1.1", sop: "1.2.3.1.1.1" }) },
    { name: "series/b", data: minimalDicom({ study: "1.2.3.2", series: "1.2.3.2.1", sop: "1.2.3.2.1.1" }) },
    { name: "notes.txt", data: Buffer.from("not a DICOM object") },
  ]);
  const job = await importBytes(zip);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(job.result.study_ids.length, 2);
  assert.equal(job.progress.instances_indexed, 2);
  assert.equal(job.warnings.length, 1);
  const stagingDir = path.join(DATA_DIR, "uploads", "dicom-staging");
  assert.equal(
    fs.existsSync(stagingDir) && fs.readdirSync(stagingDir).some((name) => name.includes(".candidates-")),
    false,
    "terminal ZIP import removes every spooled candidate"
  );
  for (const id of job.result.study_ids) repo.deleteImagingStudy(id);
});

test("mixed nonempty Patient IDs and structural ZIP paths reject the whole import generically", async () => {
  const mixed = storedZip([
    { name: "a", data: minimalDicom({ patientId: "ONE", sop: "1.2.3.10" }) },
    { name: "b", data: minimalDicom({ patientId: "TWO", sop: "1.2.3.11" }) },
  ]);
  const mixedJob = await importBytes(mixed);
  assert.equal(mixedJob.status, "failed");
  assert.equal(mixedJob.error.code, "mixed_patient_ids");
  assert.equal(JSON.stringify(mixedJob).includes("ONE"), false);
  assert.equal(repo.listImagingStudiesStructured().length, 0);

  const traversal = await importBytes(storedZip([{ name: "../escape.dcm", data: minimalDicom() }]));
  assert.equal(traversal.status, "failed");
  assert.ok(["unsafe_archive_path", "invalid_zip"].includes(traversal.error.code));
  assert.equal(JSON.stringify(traversal).includes("escape"), false);

  const nested = await importBytes(storedZip([{ name: "inner.bin", data: storedZip([]) }]));
  assert.equal(nested.status, "failed");
  assert.equal(nested.error.code, "nested_archive_rejected");
});

test("staged input is owned by job creation and recovery sweeps crash orphans", async () => {
  const undersized = await stageDicomRequest({
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(100);
    },
  });
  assert.equal(fs.existsSync(undersized.path), true, "request staging itself succeeds");
  assert.throws(
    () =>
      createDicomImportJobFromStaged({
        stagingPath: undersized.path,
        sourceMime: "application/dicom",
        sourceBytes: undersized.bytes,
      }),
    /source_size_limit/
  );
  assert.equal(fs.existsSync(undersized.path), false);

  const invalidTargetPath = createDicomStagingPath();
  const validBytes = minimalDicom();
  fs.writeFileSync(invalidTargetPath, validBytes, { mode: 0o600 });
  assert.throws(
    () =>
      createDicomImportJobFromStaged({
        stagingPath: invalidTargetPath,
        sourceMime: "application/dicom",
        sourceBytes: validBytes.length,
        targetStudyId: 999_999,
      }),
    /target_study_not_found/
  );
  assert.equal(fs.existsSync(invalidTargetPath), false);
  const orphan = createDicomStagingPath();
  fs.writeFileSync(orphan, Buffer.from("orphan"), { mode: 0o600 });
  recoverDicomImports();
  assert.equal(fs.existsSync(orphan), false);
});

test("candidate metadata is payload-free and legacy patient keys migrate into private SQLite state", () => {
  const legacyKey = Buffer.alloc(32, 0x5a);
  const keyPath = path.join(DATA_DIR, "dicom-patient.key");
  db.prepare("DELETE FROM private_runtime_secrets WHERE key='dicom_patient_hmac_v1'").run();
  fs.writeFileSync(keyPath, legacyKey, { mode: 0o600 });
  const parsed = parseDicomPart10(minimalDicom({ patientId: "PRIVATE-PATIENT" }));
  const candidate = lightweightDicomMetadata(parsed);
  assert.equal("bytes" in candidate, false);
  assert.equal("dataSet" in candidate, false);
  assert.equal("patientId" in candidate, false);
  assert.match(candidate.patientFingerprint, /^[0-9a-f]{64}$/);
  const stored = db.prepare("SELECT value FROM private_runtime_secrets WHERE key='dicom_patient_hmac_v1'").get();
  assert.deepEqual(Buffer.from(stored.value), legacyKey);
  assert.equal(fs.existsSync(keyPath), false, "valid legacy key is removed only after durable DB migration");
  assert.equal(JSON.stringify(repo.exportAll()).includes("dicom_patient_hmac_v1"), false);
});

test("UID, classic SOP, pixel contract, modality, laterality, and spine normalization are strict", () => {
  assert.equal(isValidDicomUid("1.2.840.10008.1.2.1"), true);
  for (const invalid of ["", "1..2", "1.02.3", "1.2.a", `1.${"2".repeat(64)}`])
    assert.equal(isValidDicomUid(invalid), false);
  assert.throws(() => parseDicomPart10(minimalDicom({ study: "1.02.3" })), /invalid_uid/);
  assert.throws(() => parseDicomPart10(minimalDicom({ studyDate: "20260231" })), /invalid_study_date/);
  assert.equal(
    parseDicomPart10(minimalDicom({ sopClass: "1.2.840.10008.5.1.4.1.1.999" })).previewSupportReason,
    "unsupported_sop_class"
  );
  assert.equal(
    parseDicomPart10(minimalDicom({ bitsStored: 7, highBit: 7 })).previewSupportReason,
    "invalid_pixel_encoding"
  );
  for (const code of ["DX", "CR", "RF", "XA", "PT"]) assert.equal(repo.normalizeImagingModality(code), code);
  assert.equal(repo.normalizeImagingBodyRegion("CSPINE"), "spine.cervical");
  assert.equal(repo.normalizeImagingBodyRegion("T-SPINE"), "spine.thoracic");
  assert.equal(repo.normalizeImagingBodyRegion("L Spine"), "spine.lumbar");
});

test("cross-job patient conflicts and incomplete patient identity cannot attach to a Study UID", async () => {
  const study = "1.2.826.0.1.3680043.10.543.200";
  const first = await importBytes(minimalDicom({ study, patientId: "ONE" }), "application/dicom");
  assert.equal(first.status, "done");
  const conflict = await importBytes(
    minimalDicom({ study, series: `${study}.2`, sop: `${study}.2.1`, patientId: "TWO" }),
    "application/dicom"
  );
  assert.equal(conflict.error.code, "patient_identity_conflict");
  const missing = await importBytes(
    minimalDicom({ study, series: `${study}.3`, sop: `${study}.3.1`, patientId: null }),
    "application/dicom"
  );
  assert.equal(missing.error.code, "patient_identity_unverifiable");
  repo.deleteImagingStudy(first.result.study_ids[0]);
});

test("SQLite snapshot restore preserves the patient key for same-patient append and conflict rejection", async () => {
  const study = "1.2.826.0.1.3680043.10.543.220";
  const first = await importBytes(minimalDicom({ study, patientId: "SNAPSHOT-PATIENT" }), "application/dicom");
  assert.equal(first.status, "done");
  const restoredDir = path.join(DATA_DIR, "snapshot-restore");
  fs.mkdirSync(restoredDir, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(restoredDir, "restored.db");
  repo.snapshotDbTo(snapshotPath);
  const samePath = path.join(restoredDir, "same.dcm");
  const conflictPath = path.join(restoredDir, "conflict.dcm");
  fs.writeFileSync(
    samePath,
    minimalDicom({ study, series: `${study}.2`, sop: `${study}.2.1`, patientId: "SNAPSHOT-PATIENT" }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    conflictPath,
    minimalDicom({ study, series: `${study}.3`, sop: `${study}.3.1`, patientId: "OTHER-PATIENT" }),
    { mode: 0o600 }
  );
  const script = `
    import fs from "node:fs";
    const imports = await import("./dist/dicomImports.js");
    async function run(input) {
      const bytes = fs.readFileSync(input);
      const stagingPath = imports.createDicomStagingPath();
      fs.writeFileSync(stagingPath, bytes, { mode: 0o600 });
      let job = imports.createDicomImportJob({ stagingPath, sourceMime: "application/dicom", sourceBytes: bytes.length });
      for (let attempt = 0; attempt < 300 && !["done", "failed"].includes(job.status); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        job = imports.publicDicomImportJob(job.id);
      }
      return job;
    }
    const same = await run(process.env.DICOM_SAME_INPUT);
    const conflict = await run(process.env.DICOM_CONFLICT_INPUT);
    process.stdout.write(JSON.stringify({ same: same.status, conflict: conflict.error?.code }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: restoredDir,
      DB_PATH: snapshotPath,
      DICOM_SAME_INPUT: samePath,
      DICOM_CONFLICT_INPUT: conflictPath,
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { same: "done", conflict: "patient_identity_conflict" });
  repo.deleteImagingStudy(first.result.study_ids[0]);
});

test("targeting never rebinds a DICOM study and multi-study targeting requires explicit association", async () => {
  const draft = repo.createImagingStudy({ original_name: "report draft" });
  const first = await importBytes(
    minimalDicom({ study: "1.2.3.40", series: "1.2.3.40.1", sop: "1.2.3.40.1.1" }),
    "application/dicom"
  );
  // Re-run against an explicit target so the helper can exercise draft binding.
  repo.deleteImagingStudy(first.result.study_ids[0]);
  async function targeted(bytes) {
    const stagingPath = createDicomStagingPath();
    fs.writeFileSync(stagingPath, bytes, { mode: 0o600 });
    let job = createDicomImportJob({
      stagingPath,
      sourceMime: "application/zip",
      sourceBytes: bytes.length,
      targetStudyId: draft.id,
    });
    for (let attempt = 0; attempt < 200 && !["done", "failed"].includes(job.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = publicDicomImportJob(job.id);
    }
    return job;
  }
  const bound = await targeted(minimalDicom({ study: "1.2.3.40", series: "1.2.3.40.1", sop: "1.2.3.40.1.1" }));
  assert.deepEqual(bound.result.study_ids, [draft.id]);
  const sibling = await targeted(minimalDicom({ study: "1.2.3.41", series: "1.2.3.41.1", sop: "1.2.3.41.1.1" }));
  assert.notEqual(sibling.result.study_ids[0], draft.id);
  const ambiguous = await targeted(
    storedZip([
      { name: "a", data: minimalDicom({ study: "1.2.3.42", series: "1.2.3.42.1", sop: "1.2.3.42.1.1" }) },
      { name: "b", data: minimalDicom({ study: "1.2.3.43", series: "1.2.3.43.1", sop: "1.2.3.43.1.1" }) },
    ])
  );
  assert.equal(ambiguous.error.code, "target_requires_explicit_association");
  repo.deleteImagingStudy(draft.id);
  repo.deleteImagingStudy(sibling.result.study_ids[0]);
});

test("DICOM correction restores server identity across repo, REST, and MCP and every public projection is redacted", async () => {
  const job = await importBytes(
    minimalDicom({
      study: "1.2.3.50",
      series: "1.2.3.50.1",
      sop: "1.2.3.50.1.1",
      modality: "DX",
      bodyPart: "CSPINE",
      laterality: "B",
      studyDate: "20260718",
      studyDescription: "Cervical spine radiographs",
      frameOfReference: "1.2.3.50.9",
    }),
    "application/dicom"
  );
  const studyId = job.result.study_ids[0];
  const correction = {
    ...repo.getImagingStudy(studyId).parsed.imaging_study,
    study: { modality: "MR", study_date: "1999-01-01", study_instance_uid: "9.9.9", accession: "PHI" },
    anatomy: { body_region: "head.brain", clinical_system: "neurologic", laterality: "left" },
    report: { impression: "User-authored report correction" },
    findings: [{ source: "patient", finding_text: "User-authored finding correction" }],
    dicom: { study_instance_uid: "9.9.9", series: [{ series_instance_uid: "9.9.9.1" }] },
  };
  const assertPrivateIdentity = (impression) => {
    const raw = JSON.parse(repo.getHealthDocumentRaw(studyId).parsed_json).imaging_study;
    assert.equal(raw.study.study_instance_uid, "1.2.3.50");
    assert.equal(raw.dicom.series[0].series_instance_uid, "1.2.3.50.1");
    assert.equal(raw.study.modality, "DX");
    assert.equal(raw.study.study_date, "2026-07-18");
    assert.equal(raw.anatomy.body_region, "spine.cervical");
    assert.equal(raw.anatomy.laterality, "bilateral");
    assert.equal(raw.study.accession, null);
    assert.equal(raw.report.impression, impression);
  };
  repo.correctImagingStudy(studyId, correction);
  assertPrivateIdentity("User-authored report correction");

  const routeLayer = healthDocsRouter.stack.find((layer) => layer.route?.path === "/:id/imaging-details");
  const routeHandler = routeLayer.route.stack.at(-1).handle;
  let restStatus = 200;
  let restBody = null;
  await routeHandler(
    { params: { id: String(studyId) }, body: { ...correction, report: { impression: "REST correction" } } },
    {
      status(code) {
        restStatus = code;
        return this;
      },
      json(body) {
        restBody = body;
        return this;
      },
    }
  );
  assert.equal(restStatus, 200);
  assert.equal(JSON.stringify(restBody).includes("1.2.3.50"), false, JSON.stringify(restBody));
  assertPrivateIdentity("REST correction");

  const tools = new Map();
  registerImagingTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  const mcpResult = await tools.get("update_imaging_study")({
    id: studyId,
    imaging_study: { ...correction, report: { impression: "MCP correction" } },
  });
  assert.equal(mcpResult.content[0].text.includes("1.2.3.50"), false);
  assertPrivateIdentity("MCP correction");

  const publicJson = JSON.stringify({
    study: repo.getImagingStudy(studyId),
    list: repo.listImagingStudiesStructured(),
    docs: repo.listHealthDocuments(),
    coach: repo.imagingForCoach(),
    healthExport: repo.buildHealthExport(),
    manifest: dicomManifest(studyId),
  });
  for (const secret of [
    "1.2.3.50",
    "PHI",
    "patientFingerprint",
    "sha256",
    "sop_instance_uid",
    "frame_of_reference_uid",
  ])
    assert.equal(publicJson.includes(secret), false, secret);
  const backup = JSON.stringify(repo.exportAll());
  assert.equal(backup.includes("1.2.3.50"), true, "private backup remains lossless");
  assert.equal(backup.includes("patient_fingerprint"), false);
  repo.deleteImagingStudy(studyId);
});

test("manifest geometry sorting follows orientation normal then stable fallbacks", () => {
  const sorted = sortDicomManifestInstances([
    { id: 3, instance_number: 1, image_orientation: "1\\0\\0\\0\\1\\0", image_position: "0\\0\\20" },
    { id: 2, instance_number: 9, image_orientation: "1\\0\\0\\0\\1\\0", image_position: "0\\0\\10" },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    [2, 3]
  );
  assert.equal(sorted[0].image_orientation, "1\\0\\0\\0\\1\\0");
  assert.deepEqual(
    sortDicomManifestInstances([
      { id: 3, instance_number: null },
      { id: 2, instance_number: 2 },
      { id: 1, instance_number: 1 },
    ]).map((item) => item.id),
    [1, 2, 3]
  );
});

test("deletion cancels live target jobs, restores quarantined files on DB failure, and commits atomically", async () => {
  const imported = await importBytes(minimalDicom(), "application/dicom");
  const studyId = imported.result.study_ids[0];
  const sourcePath = repo.listImagingStudyFilesRaw(studyId)[0].file_path;
  const staged = createDicomStagingPath();
  fs.writeFileSync(staged, minimalDicom({ sop: "1.2.3.99" }), { mode: 0o600 });
  db.prepare(
    `INSERT INTO dicom_import_jobs (status, source_mime, staging_path, source_bytes, target_study_id)
     VALUES ('running','application/dicom',?,?,?)`
  ).run(staged, fs.statSync(staged).size, studyId);
  const rollback = repo.deleteImagingStudy(studyId, {
    beforeDbDelete: () => {
      throw new Error("simulated DB failure");
    },
  });
  assert.match(rollback.error, /simulated DB failure/);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(staged), true);
  assert.ok(repo.getImagingStudy(studyId));
  assert.equal(
    db.prepare("SELECT status FROM dicom_import_jobs WHERE target_study_id=?").get(studyId).status,
    "running"
  );

  const result = repo.deleteImagingStudy(studyId);
  assert.equal(result.deleted, 1);
  assert.equal(result.jobs_canceled, 1);
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.existsSync(staged), false);
  const canceled = db
    .prepare("SELECT status, error_code FROM dicom_import_jobs WHERE id=(SELECT MAX(id) FROM dicom_import_jobs)")
    .get();
  assert.equal(canceled.status, "failed");
  assert.equal(canceled.error_code, "study_deleted");
  assert.equal(repo.getImagingStudy(studyId), null);
});

test("quarantine recovery restores live studies and removes only post-commit data", async () => {
  const imported = await importBytes(
    minimalDicom({ study: "1.2.3.240", series: "1.2.3.240.1", sop: "1.2.3.240.1.1" }),
    "application/dicom"
  );
  const studyId = imported.result.study_ids[0];
  const sourcePath = repo.listImagingStudyFilesRaw(studyId)[0].file_path;
  const quarantineRoot = path.join(DATA_DIR, "uploads", "dicom-quarantine");

  const beforeCommit = repo.deleteImagingStudy(studyId, { simulateCrashAfterQuarantine: true });
  assert.equal(beforeCommit.simulated_crash, true);
  assert.ok(repo.getImagingStudy(studyId), "DB row is still live before commit");
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.readdirSync(quarantineRoot).length, 1);
  const restored = repo.recoverImagingQuarantines();
  assert.equal(restored.restored, 1);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.readdirSync(quarantineRoot).length, 0);

  const afterCommit = repo.deleteImagingStudy(studyId, { simulateCrashAfterCommit: true });
  assert.equal(afterCommit.deleted, 1);
  assert.equal(afterCommit.simulated_crash, true);
  assert.equal(repo.getImagingStudy(studyId), null);
  assert.equal(fs.readdirSync(quarantineRoot).length, 1);
  const removed = repo.recoverImagingQuarantines();
  assert.equal(removed.removed, 1);
  assert.equal(fs.existsSync(sourcePath), false);
  assert.equal(fs.readdirSync(quarantineRoot).length, 0);

  const corruptDir = path.join(quarantineRoot, "corrupt-ledger");
  fs.mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(corruptDir, "manifest.json"), "not-json", { mode: 0o600 });
  fs.writeFileSync(path.join(corruptDir, "possible-live-data"), "preserve", { mode: 0o600 });
  const conservative = repo.recoverImagingQuarantines();
  assert.equal(conservative.preserved, 1);
  assert.equal(fs.existsSync(path.join(corruptDir, "possible-live-data")), true);
  fs.rmSync(corruptDir, { recursive: true, force: true });
});

test("quarantine recovery preserves incomplete and ambiguous valid manifests", (t) => {
  const study = repo.createImagingStudy({ original_name: "quarantine validation" });
  const quarantineRoot = path.join(DATA_DIR, "uploads", "dicom-quarantine");
  const sourceRoot = path.join(DATA_DIR, "uploads", "quarantine-validation-sources");
  const caseDirs = [];
  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  t.after(() => {
    repo.deleteImagingStudy(study.id);
    for (const directory of caseDirs) fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  function writeCase(name, mappings, payloads) {
    const directory = path.join(quarantineRoot, name);
    caseDirs.push(directory);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({ version: 1, study_id: study.id, mappings }),
      { mode: 0o600 }
    );
    for (const payload of payloads) fs.writeFileSync(payload, `preserve:${name}`, { mode: 0o600 });
    return directory;
  }

  const emptyDir = path.join(quarantineRoot, "empty-mapping");
  writeCase("empty-mapping", [], [path.join(emptyDir, "unlisted-payload")]);

  const unknownDir = path.join(quarantineRoot, "unknown-payload");
  const mappedPayload = path.join(unknownDir, "mapped-payload");
  const unknownPayload = path.join(unknownDir, "unknown-payload");
  writeCase(
    "unknown-payload",
    [{ original: path.join(sourceRoot, "unknown-original"), quarantined: mappedPayload }],
    [mappedPayload, unknownPayload]
  );

  const duplicateDir = path.join(quarantineRoot, "duplicate-original");
  const duplicateOriginal = path.join(sourceRoot, "duplicate-original");
  writeCase(
    "duplicate-original",
    [
      { original: duplicateOriginal, quarantined: path.join(duplicateDir, "payload-a") },
      { original: duplicateOriginal, quarantined: path.join(duplicateDir, "payload-b") },
    ],
    [path.join(duplicateDir, "payload-a"), path.join(duplicateDir, "payload-b")]
  );

  const ambiguousDir = path.join(quarantineRoot, "both-copies");
  const ambiguousOriginal = path.join(sourceRoot, "both-copies-original");
  const ambiguousPayload = path.join(ambiguousDir, "payload");
  fs.writeFileSync(ambiguousOriginal, "preserve:original", { mode: 0o600 });
  writeCase("both-copies", [{ original: ambiguousOriginal, quarantined: ambiguousPayload }], [ambiguousPayload]);

  const recovered = repo.recoverImagingQuarantines();
  assert.equal(recovered.preserved, 4);
  for (const preservedPath of [
    path.join(emptyDir, "unlisted-payload"),
    mappedPayload,
    unknownPayload,
    path.join(duplicateDir, "payload-a"),
    path.join(duplicateDir, "payload-b"),
    ambiguousOriginal,
    ambiguousPayload,
  ])
    assert.equal(fs.existsSync(preservedPath), true, preservedPath);
});

test("quarantine preflight preserves wrong ownership, late ambiguity, unsafe paths, and non-commit states", (t) => {
  const quarantineRoot = path.join(DATA_DIR, "uploads", "dicom-quarantine");
  const sourceRoot = path.join(DATA_DIR, "uploads", "quarantine-preflight-sources");
  const ancestorTarget = path.join(DATA_DIR, "quarantine-ancestor-target");
  const ancestorLink = path.join(sourceRoot, "linked-parent");
  const caseDirs = [];
  const studies = [];
  let ownedSequence = 0;
  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ancestorTarget, { recursive: true, mode: 0o700 });
  fs.symlinkSync(ancestorTarget, ancestorLink, "dir");
  t.after(() => {
    for (const study of studies) db.prepare("DELETE FROM health_documents WHERE id=?").run(study.id);
    for (const directory of caseDirs) fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(ancestorTarget, { recursive: true, force: true });
  });

  function study() {
    const created = repo.createImagingStudy({ original_name: "quarantine preflight" });
    studies.push(created);
    return created;
  }

  function own(studyId, filePath) {
    ownedSequence++;
    db.prepare(
      `INSERT INTO imaging_study_files
        (health_document_id, sequence, mime, file_path, size_bytes, sha256, source_kind)
       VALUES (?, ?, 'application/pdf', ?, 1, ?, 'report')`
    ).run(studyId, ownedSequence, filePath, ownedSequence.toString(16).padStart(64, "0"));
  }

  function writeManifest(name, studyId, mappings) {
    const directory = path.join(quarantineRoot, name);
    caseDirs.push(directory);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({ version: 1, study_id: studyId, mappings }),
      { mode: 0o600 }
    );
    return directory;
  }

  const wrongManifestStudy = study();
  const wrongOwnerStudy = study();
  const wrongOriginal = path.join(sourceRoot, "wrong-owner-original");
  own(wrongOwnerStudy.id, wrongOriginal);
  const wrongDir = path.join(quarantineRoot, "wrong-owner");
  const wrongPayload = path.join(wrongDir, "payload");
  writeManifest("wrong-owner", wrongManifestStudy.id, [{ original: wrongOriginal, quarantined: wrongPayload }]);
  fs.writeFileSync(wrongPayload, "wrong-owner", { mode: 0o600 });

  const laterBothStudy = study();
  const bothFirstOriginal = path.join(sourceRoot, "both-first-original");
  const bothSecondOriginal = path.join(sourceRoot, "both-second-original");
  own(laterBothStudy.id, bothFirstOriginal);
  own(laterBothStudy.id, bothSecondOriginal);
  const laterBothDir = path.join(quarantineRoot, "later-both");
  const bothFirstPayload = path.join(laterBothDir, "first-payload");
  const bothSecondPayload = path.join(laterBothDir, "second-payload");
  writeManifest("later-both", laterBothStudy.id, [
    { original: bothFirstOriginal, quarantined: bothFirstPayload },
    { original: bothSecondOriginal, quarantined: bothSecondPayload },
  ]);
  fs.writeFileSync(bothFirstPayload, "first", { mode: 0o600 });
  fs.writeFileSync(bothSecondOriginal, "second-original", { mode: 0o600 });
  fs.writeFileSync(bothSecondPayload, "second-quarantined", { mode: 0o600 });

  const laterNeitherStudy = study();
  const neitherFirstOriginal = path.join(sourceRoot, "neither-first-original");
  const neitherSecondOriginal = path.join(sourceRoot, "neither-second-original");
  own(laterNeitherStudy.id, neitherFirstOriginal);
  own(laterNeitherStudy.id, neitherSecondOriginal);
  const laterNeitherDir = path.join(quarantineRoot, "later-neither");
  const neitherFirstPayload = path.join(laterNeitherDir, "first-payload");
  writeManifest("later-neither", laterNeitherStudy.id, [
    { original: neitherFirstOriginal, quarantined: neitherFirstPayload },
    { original: neitherSecondOriginal, quarantined: path.join(laterNeitherDir, "missing-payload") },
  ]);
  fs.writeFileSync(neitherFirstPayload, "first", { mode: 0o600 });

  const reservedStudy = study();
  const reservedOriginal = path.join(sourceRoot, "reserved-original");
  own(reservedStudy.id, reservedOriginal);
  fs.writeFileSync(reservedOriginal, "reserved-original", { mode: 0o600 });
  const reservedDir = writeManifest("reserved-target", reservedStudy.id, [
    { original: reservedOriginal, quarantined: path.join(quarantineRoot, "reserved-target", "manifest.json") },
  ]);

  const duplicateStudy = study();
  const duplicateOriginalA = path.join(sourceRoot, "duplicate-a");
  const duplicateOriginalB = path.join(sourceRoot, "duplicate-b");
  own(duplicateStudy.id, duplicateOriginalA);
  own(duplicateStudy.id, duplicateOriginalB);
  const duplicateDir = path.join(quarantineRoot, "duplicate-quarantine");
  const duplicatePayload = path.join(duplicateDir, "payload");
  writeManifest("duplicate-quarantine", duplicateStudy.id, [
    { original: duplicateOriginalA, quarantined: duplicatePayload },
    { original: duplicateOriginalB, quarantined: duplicatePayload },
  ]);
  fs.writeFileSync(duplicatePayload, "duplicate", { mode: 0o600 });

  const symlinkStudy = study();
  const symlinkOriginal = path.join(sourceRoot, "symlink-original");
  own(symlinkStudy.id, symlinkOriginal);
  const symlinkDir = path.join(quarantineRoot, "symlink-payload");
  const symlinkPayload = path.join(symlinkDir, "payload");
  const symlinkTarget = path.join(sourceRoot, "symlink-target");
  fs.writeFileSync(symlinkTarget, "target", { mode: 0o600 });
  writeManifest("symlink-payload", symlinkStudy.id, [{ original: symlinkOriginal, quarantined: symlinkPayload }]);
  fs.symlinkSync(symlinkTarget, symlinkPayload);

  const ancestorStudy = study();
  const ancestorOriginal = path.join(ancestorLink, "ancestor-original");
  own(ancestorStudy.id, ancestorOriginal);
  const ancestorDir = path.join(quarantineRoot, "symlink-ancestor");
  const ancestorPayload = path.join(ancestorDir, "payload");
  writeManifest("symlink-ancestor", ancestorStudy.id, [{ original: ancestorOriginal, quarantined: ancestorPayload }]);
  fs.writeFileSync(ancestorPayload, "ancestor", { mode: 0o600 });

  const absentOriginal = path.join(sourceRoot, "unrelated-live-upload");
  fs.writeFileSync(absentOriginal, "unrelated", { mode: 0o600 });
  const absentDir = path.join(quarantineRoot, "absent-original-present");
  writeManifest("absent-original-present", 2_147_483_647, [
    { original: absentOriginal, quarantined: path.join(absentDir, "missing-payload") },
  ]);

  const recovered = repo.recoverImagingQuarantines();
  assert.equal(recovered.preserved, 8);
  assert.equal(fs.existsSync(wrongOriginal), false);
  assert.equal(fs.existsSync(wrongPayload), true);
  assert.equal(fs.existsSync(bothFirstOriginal), false, "earlier mapping was not restored before later both");
  assert.equal(fs.existsSync(bothFirstPayload), true);
  assert.equal(fs.existsSync(bothSecondOriginal), true);
  assert.equal(fs.existsSync(bothSecondPayload), true);
  assert.equal(fs.existsSync(neitherFirstOriginal), false, "earlier mapping was not restored before later neither");
  assert.equal(fs.existsSync(neitherFirstPayload), true);
  assert.equal(fs.existsSync(path.join(reservedDir, "manifest.json")), true);
  assert.equal(fs.existsSync(reservedOriginal), true);
  assert.equal(fs.existsSync(duplicatePayload), true);
  assert.equal(fs.lstatSync(symlinkPayload).isSymbolicLink(), true);
  assert.equal(fs.existsSync(ancestorPayload), true);
  assert.equal(fs.existsSync(absentOriginal), true, "an absent-study ledger never deletes an original path");
  assert.equal(fs.existsSync(absentDir), true);
});

test("directory fsync failures abort deletion and restore quarantined payloads", async () => {
  const imported = await importBytes(
    minimalDicom({ study: "1.2.3.250", series: "1.2.3.250.1", sop: "1.2.3.250.1.1" }),
    "application/dicom"
  );
  const studyId = imported.result.study_ids[0];
  const ownedPaths = [
    ...repo.listImagingStudyFilesRaw(studyId).map((file) => file.file_path),
    ...db
      .prepare(
        `SELECT i.preview_path AS file_path FROM dicom_instances i
         JOIN dicom_series s ON s.id=i.series_id
         WHERE s.health_document_id=? AND i.preview_path IS NOT NULL`
      )
      .all(studyId),
  ].map((file) => (typeof file === "string" ? file : file.file_path));
  const sourcePath = ownedPaths[0];
  const sourceParent = path.dirname(sourcePath);
  const sourceParents = [...new Set(ownedPaths.map((filePath) => path.dirname(filePath)))];
  const quarantineRoot = path.join(DATA_DIR, "uploads", "dicom-quarantine");
  const synced = [];
  let failed = false;
  const result = repo.deleteImagingStudy(studyId, {
    directorySync(directory) {
      synced.push(directory);
      if (!failed && directory === sourceParent) {
        failed = true;
        throw new Error("simulated directory fsync failure");
      }
    },
  });

  assert.match(result.error, /simulated directory fsync failure/);
  assert.equal(result.deleted, 0);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.ok(repo.getImagingStudy(studyId));
  const quarantineOperation = synced[1];
  assert.equal(path.dirname(quarantineOperation), quarantineRoot);
  assert.deepEqual(
    synced,
    [
      quarantineRoot,
      quarantineOperation,
      quarantineOperation,
      sourceParent,
      ...sourceParents,
      quarantineOperation,
      quarantineRoot,
    ],
    "delete syncs the quarantine destination before source parents; restore reverses that order"
  );
  assert.equal(fs.readdirSync(quarantineRoot).length, 0);
  repo.deleteImagingStudy(studyId);
});
