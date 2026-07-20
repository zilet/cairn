import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function uploadModel() {
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    CairnHealthClient: { MAX_DOC_BYTES: 15 * 1024 * 1024, MAX_DICOM_BYTES: 256 * 1024 * 1024 },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/imaging-upload-model.js"), "utf8"), context);
  return context.CairnImagingUploadModel;
}

function viewerModel() {
  const context = { Array, Math, Number, Object, String, Uint8ClampedArray };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/dicom-viewer-model.js"), "utf8"), context);
  return context.CairnDicomViewerModel;
}

function imagingClient() {
  const context = {
    Array,
    Boolean,
    Error,
    FormData: class {},
    JSON,
    Map,
    Number,
    Object,
    String,
    withToken: (path) => path,
    CairnHealthClient: { askCoach() {} },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/imaging-client.js"), "utf8"), context);
  return context.CairnImaging;
}

test("DICOM batch imports direct files sequentially and deduplicates same-study results", async () => {
  const model = uploadModel();
  const items = [
    { file: { name: "one.dcm" }, mime: "application/dicom" },
    { file: { name: "two.dcm" }, mime: "application/dicom" },
  ];
  const events = [];
  let nextJob = 0;
  const different = await model.processDicomImportBatch(items, {
    start: async (item) => {
      const id = ++nextJob;
      events.push(`start:${item.file.name}:${id}`);
      return { id, status: "queued" };
    },
    wait: async (id) => {
      events.push(`wait:${id}`);
      return { id, status: "done", result: { study_ids: [id === 1 ? 101 : 202] } };
    },
    remember: (id) => events.push(`remember:${id}`),
    forget: (id) => events.push(`forget:${id}`),
    onState() {},
    onDone: (item) => events.push(`done:${item.file.name}`),
  });
  assert.deepEqual([...different.studyIds], [101, 202]);
  assert.deepEqual(events, [
    "start:one.dcm:1",
    "remember:1",
    "wait:1",
    "forget:1",
    "done:one.dcm",
    "start:two.dcm:2",
    "remember:2",
    "wait:2",
    "forget:2",
    "done:two.dcm",
  ]);

  nextJob = 0;
  const same = await model.processDicomImportBatch(
    [
      { file: { name: "slice-1.dcm" }, mime: "application/dicom" },
      { file: { name: "slice-2.dcm" }, mime: "application/dicom" },
    ],
    {
      start: async () => ({ id: ++nextJob, status: "queued" }),
      wait: async (id) => ({ id, status: "done", result: { study_ids: [303] } }),
      remember() {},
      forget() {},
      onState() {},
      onDone() {},
    }
  );
  assert.deepEqual([...same.studyIds], [303]);
  assert.deepEqual([...model.imagingAnalysisTargets(same.studyIds, false, null)], [303]);
});

test("failed DICOM job remains actionable and a polling error preserves its active job", async () => {
  const model = uploadModel();
  const failed = { file: { name: "failed.dcm" }, mime: "application/dicom" };
  let removed = 0;
  const terminal = await model.processDicomImportBatch([failed], {
    start: async () => ({ id: 8, status: "queued" }),
    wait: async () => ({ id: 8, status: "failed" }),
    remember() {},
    forget() {},
    onState() {},
    onDone: () => removed++,
  });
  assert.equal(terminal.reason, "failed");
  assert.equal(failed.state, "failed");
  assert.equal(failed.jobId, undefined);
  assert.equal(removed, 0);

  const unknown = { file: { name: "running.zip" }, mime: "application/zip" };
  const polling = await model.processDicomImportBatch([unknown], {
    start: async () => ({ id: 9, status: "queued" }),
    wait: async () => {
      throw new Error("offline");
    },
    remember() {},
    forget() {},
    onState() {},
    onDone: () => removed++,
  });
  assert.equal(polling.reason, "status_unknown");
  assert.equal(unknown.state, "status_unknown");
  assert.equal(unknown.jobId, 9);
  assert.equal(removed, 0);
});

test("multi-study DICOM plus report pauses for an explicit safe association", () => {
  const model = uploadModel();
  assert.deepEqual(JSON.parse(JSON.stringify(model.imagingAssociationTarget([12, 7], true, null))), {
    state: "choose",
    studyId: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(model.imagingAssociationTarget([12, 7], true, 7))), {
    state: "ready",
    studyId: 7,
  });
  assert.deepEqual([...model.imagingAnalysisTargets([12, 7], true, 7)], [7]);
  const label = model.dicomStudyChoiceLabel({
    doc_date: "2026-07-18",
    parsed: {
      imaging_study: {
        study: { modality: "MR", study_date: "2026-07-17" },
        anatomy: { body_region: "lower_extremity.knee" },
        dicom: { study_instance_uid: "1.2.840.secret" },
      },
    },
  });
  assert.equal(label, "2026-07-17 · MR · lower extremity knee");
  assert.doesNotMatch(label, /1\.2\.840|UID|secret/i);
});

test("active DICOM jobs persist only numeric IDs and reconnect without uploading again", async () => {
  const model = uploadModel();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  model.rememberActiveDicomJob(42, storage);
  model.writeActiveDicomJobIds([42, "bad", -1, { name: "secret.dcm", uid: "1.2.3" }], storage);
  assert.equal(values.get(model.DICOM_IMPORT_SESSION_KEY), "[42]");
  assert.deepEqual([...model.readActiveDicomJobIds(storage)], [42]);

  let starts = 0;
  const recovered = { file: { name: "not persisted.dcm" }, mime: "application/dicom", jobId: 42 };
  const result = await model.processDicomImportBatch([recovered], {
    start: async () => {
      starts++;
      return { id: 99, status: "queued" };
    },
    wait: async (id) => ({ id, status: "done", result: { study_ids: [55] } }),
    remember() {},
    forget: (id) => model.forgetActiveDicomJob(id, storage),
    onState() {},
    onDone() {},
  });
  assert.equal(starts, 0);
  assert.deepEqual([...result.studyIds], [55]);
  assert.equal(values.has(model.DICOM_IMPORT_SESSION_KEY), false);
});

test("DICOM routing accepts 100 MiB while ordinary attachments keep the 15 MiB cap", () => {
  const model = uploadModel();
  const dicom = model.imagingUploadRoute({ name: "scan.dcm", type: "", size: 100 * 1024 * 1024 });
  const zip = model.imagingUploadRoute({
    name: "study.zip",
    type: "application/octet-stream",
    size: 100 * 1024 * 1024,
  });
  const ordinary = model.imagingUploadRoute({ name: "report.pdf", type: "application/pdf", size: 16 * 1024 * 1024 });
  assert.equal(dicom.accepted, true);
  assert.equal(dicom.mime, "application/dicom");
  assert.equal(zip.accepted, true);
  assert.equal(zip.mime, "application/zip");
  assert.equal(ordinary.accepted, false);
  assert.equal(ordinary.maxBytes, 15 * 1024 * 1024);
});

test("viewer recognizes server orientation strings and rejects stale frame responses", () => {
  const model = viewerModel();
  assert.deepEqual([...model.dicomOrientationCosines("1\\0\\0\\0\\1\\0")], [1, 0, 0, 0, 1, 0]);
  assert.equal(model.dicomOrientationCosines([1, 0, 0, 0, 1, 0]), null);
  assert.equal(model.dicomOrientationCosines("1\\0\\0\\0\\NaN\\0"), null);
  assert.equal(model.dicomResponseIsCurrent(2, 1, "A", "B", true), false);
  assert.equal(model.dicomResponseIsCurrent(2, 2, "B", "B", true), true);
  assert.equal(model.dicomResponseIsCurrent(2, 2, "B", "B", false), false);
  assert.doesNotMatch(model.dicomPreviewReason("compressed_or_unsupported_transfer_syntax"), /transfer|syntax|_/i);
});

test("viewer button renders only for an actual DICOM series", () => {
  const imaging = imagingClient();
  const base = { id: 4, parsed: { imaging_study: { study: { modality: "MR" } } } };
  assert.doesNotMatch(imaging.imagingInner(base), /data-dicom-open/);
  assert.doesNotMatch(
    imaging.imagingInner({ id: 4, parsed: { imaging_study: { study: { modality: "MR" }, dicom: { series: [] } } } }),
    /data-dicom-open/
  );
  assert.match(
    imaging.imagingInner({ id: 4, parsed: { imaging_study: { study: { modality: "MR" }, dicom: { series: [{}] } } } }),
    /data-dicom-open="4"/
  );
});

test("upload controller never sends a DICOM filename in a draft payload or requests early analysis", () => {
  const source = readFileSync(join(root, "src/client/health-doc-upload-controller.ts"), "utf8");
  assert.match(source, /deps\.api\("\/health-docs\/imaging\/dicom-imports"/);
  assert.doesNotMatch(source, /dicom-imports\?target_study_id|dicom-imports\?analyze|&analyze=1/);
  assert.doesNotMatch(source, /original_name:\s*imagingFiles\[0\]/);
  assert.match(source, /body:\s*item\.file/);
  const importedAt = source.indexOf("await runDicomImports()");
  const targetsAt = source.indexOf("pendingAnalysisIds = CairnImagingUploadModel.imagingAnalysisTargets", importedAt);
  const analyzedAt = source.indexOf("await analyzePendingStudies()", targetsAt);
  assert.ok(importedAt >= 0 && importedAt < targetsAt && targetsAt < analyzedAt);
});
