import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function imaging() {
  const context = {
    Object,
    String,
    Array,
    Map,
    JSON,
    Number,
    Boolean,
    Error,
    FormData: class {},
    withToken: (path) => `TOKEN:${path}`,
    // date-utils in the browser: recency reads relative, precise on hover.
    relAge: (iso) => `about the time of ${iso}`,
    absDate: (iso) => `absolute:${iso}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  context.CairnHealthClient = {
    askCoach: (value) => {
      context.question = value;
    },
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/imaging-client.js"), "utf8"), context);
  return context;
}

test("imaging cards group atomic findings, distinguish AI observations, and escape sources", () => {
  const { CairnImaging } = imaging();
  const doc = {
    id: 44,
    kind: "imaging",
    doc_date: "2026-07-10",
    study_files: [{ id: 7, original_name: "scan <source>.pdf", source_kind: "report" }],
    parsed: {
      imaging_study: {
        study: { modality: "MR", procedure: "Spine <scan>" },
        anatomy: { clinical_system: "musculoskeletal", body_region: "lumbar_spine" },
        report: { impression: "No <acute> fracture", findings: "Disc <bulge>" },
        verification: { needs_confirmation: true },
        findings: [
          {
            source: "report",
            clinical_system: "musculoskeletal",
            body_region: "lumbar_spine",
            finding_text: "Mild <disc> change",
            measurements: [{ name: "AP diameter", value_text: "4", unit: "mm", qualifier: "approximately" }],
          },
          {
            source: "image_ai",
            clinical_system: "musculoskeletal",
            body_region: "lumbar_spine",
            finding_text: "Possible <signal>",
          },
        ],
        recommendations: [
          { id: "rec-1", recommendation_text: "Follow up <if> needed", timeframe: "6 weeks", status: "scheduled" },
        ],
      },
    },
  };
  const html = CairnImaging.imagingCard(doc, 1);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="imaging-detail-44"/);
  assert.match(html, /AI image observation · unconfirmed/);
  assert.match(html, /AP diameter approximately 4 mm/);
  assert.match(html, /value="scheduled" selected/);
  assert.match(html, /value="recommended"/);
  assert.doesNotMatch(html, /value="open"|value="planned"|value="done"/);
  assert.match(html, /scan &lt;source&gt;\.pdf/);
  assert.match(html, /No &lt;acute&gt; fracture/);
  assert.doesNotMatch(html, /<acute>|<disc>|<signal>|<source>/);
  assert.match(html, /TOKEN:\/api\/health-docs\/44\/imaging-files\/7/);
  assert.equal(CairnImaging.imagingGroups(doc.parsed.imaging_study)[0][0], "musculoskeletal");
  assert.equal(CairnImaging.imagingGroups(doc.parsed.imaging_study)[0][1][0].lateralities[0].laterality, "not stated");
  assert.equal(CairnImaging.imagingLabel("lower_extremity.knee"), "Lower Extremity Knee");
});

test("imaging groups an otherwise atomic-free study by its study-level anatomy", () => {
  const { CairnImaging } = imaging();
  const study = {
    anatomy: { clinical_system: "spine", body_region: "spine.lumbar", laterality: "left" },
    report: { impression: "Stable" },
  };
  const groups = CairnImaging.imagingGroups(study);
  assert.equal(groups[0][0], "spine");
  assert.equal(groups[0][1][0].body, "spine.lumbar");
  assert.equal(groups[0][1][0].lateralities[0].laterality, "left");
  assert.match(CairnImaging.imagingInner({ id: 2, parsed: { imaging_study: study } }), /Stable/);
});

test("records grouping uses study anatomy or an explicit multi-region label, never findings[0]", () => {
  const { CairnImaging } = imaging();
  const explicit = CairnImaging.imagingStudyGrouping({
    anatomy: { clinical_system: "musculoskeletal", body_region: "spine.lumbar", laterality: "midline" },
    findings: [{ clinical_system: "neurologic", body_region: "head.brain" }],
  });
  assert.equal(
    JSON.stringify(explicit),
    JSON.stringify({ system: "musculoskeletal", region: "spine.lumbar", laterality: "midline" })
  );
  const multiple = CairnImaging.imagingStudyGrouping({
    anatomy: { clinical_system: "unknown", body_region: "unknown" },
    findings: [
      { clinical_system: "musculoskeletal", body_region: "lower_extremity.knee", laterality: "left" },
      { clinical_system: "neurologic", body_region: "head.brain", laterality: "midline" },
    ],
  });
  assert.equal(multiple.system, "Multiple systems");
  assert.equal(multiple.region, "Multiple regions");
  assert.equal(multiple.laterality, "Multiple lateralities");
  const records = readFileSync(join(root, "src/client/health-records-client.ts"), "utf8");
  assert.doesNotMatch(records, /findings\?\.\[0\]/);
  assert.match(records, /imagingStudyGrouping/);
});

test("source-check correction covers study/report atoms while preserving server-owned state", () => {
  const { CairnImaging } = imaging();
  const provenance = { source_kind: "report", source_hash: "abc" };
  const verification = { user_confirmed: true, clinician_confirmed: false };
  const study = {
    report_status: "final",
    study: { modality: "MR", procedure: "Old", study_date: "2026-07-01", facility: "Old facility" },
    anatomy: { clinical_system: "musculoskeletal", body_region: "spine.lumbar", laterality: "midline" },
    report: { impression: "Old" },
    findings: [{ id: "finding-1", source: "report", finding_text: "Old", source_spans: [{ file_id: 7 }] }],
    recommendations: [
      { id: "rec-1", source: "report", recommendation_text: "Old follow-up", source_spans: [{ file_id: 7 }] },
    ],
    provenance,
    verification,
  };
  const corrected = CairnImaging.imagingCorrectionPayload(study, {
    study_date: "2026-07-02",
    facility: "New facility",
    report_status: "amended",
    modality: "MR",
    procedure: "Updated procedure",
    clinical_system: "musculoskeletal",
    body_region: "spine.lumbar",
    verbatim_site: "LUMBAR SPINE",
    laterality: "midline",
    history: "Pain",
    technique: "Without contrast",
    comparison: "Prior",
    report_findings: "Updated written findings",
    impression: "Updated impression",
    addendum: "Addendum",
    findings_json: JSON.stringify([
      {
        id: "finding-1",
        source: "report",
        finding_text: "Updated atom",
        measurements: [{ name: "length", value: 4, unit: "mm" }],
      },
    ]),
    recommendations_json: JSON.stringify([
      {
        id: "rec-1",
        source: "report",
        recommendation_text: "Repeat if symptoms persist",
        timeframe: "as needed",
        status: "scheduled",
      },
    ]),
    clinician_confirmed: true,
  });
  assert.equal(corrected.study.study_date, "2026-07-02");
  assert.equal(corrected.study.facility, "New facility");
  assert.equal(corrected.report_status, "amended");
  assert.equal(corrected.report.technique, "Without contrast");
  assert.equal(corrected.findings[0].measurements[0].value, 4);
  assert.equal(corrected.findings[0].source_spans[0].file_id, 7);
  assert.equal(corrected.recommendations[0].source_spans[0].file_id, 7);
  assert.equal(corrected.provenance, provenance);
  assert.equal(corrected.verification, verification);
  assert.throws(
    () =>
      CairnImaging.imagingCorrectionPayload(study, {
        ...corrected,
        report_status: "forged",
        findings_json: "[]",
        recommendations_json: "[]",
      }),
    /Report status is invalid/
  );
});

test("imaging upload keeps analysis retry enabled for an existing draft", () => {
  const source = readFileSync(join(root, "src/client/health-doc-upload-controller.ts"), "utf8");
  assert.match(source, /!imagingFiles\.length && !imagingDraft/);
  assert.match(source, /imagingDraft = null;\s*setUploadReady\(\);/);
  const records = readFileSync(join(root, "src/client/health-records-client.ts"), "utf8");
  assert.match(records, /id="hStatus" role="status" aria-live="polite"/);
});

test("retry-needed imaging shows a calm re-analyze action and keeps imaging rendering during retry", () => {
  const { CairnImaging } = imaging();
  const html = CairnImaging.imagingCard({
    id: 91,
    kind: "imaging",
    enrichment_status: "retry_needed",
    parsed: {
      imaging_study: {
        study: { modality: "MR" },
        anatomy: { body_region: "lower_extremity.knee" },
        findings: [{ source: "patient", finding_text: "User correction" }],
      },
    },
  });
  assert.match(html, /role="status"/);
  assert.match(html, /Your correction was kept/);
  assert.match(html, /data-hrescan="91"/);
  assert.match(html, />Re-analyze</);

  const lifecycle = readFileSync(join(root, "src/client/health-doc-lifecycle-actions-client.ts"), "utf8");
  assert.match(lifecycle, /`\/health-docs\/\$\{id\}\/reanalyze`/);
  assert.match(lifecycle, /doc\.kind === "imaging" && CairnImaging\.imagingStudy\(doc\)/);
  assert.match(lifecycle, /row\.outerHTML = CairnImaging\.imagingCard\(doc\)/);
  const routes = readFileSync(join(root, "src/routes/health-docs.ts"), "utf8");
  assert.match(routes, /post\("\/:id\/imaging-analyze"/);
  const mcp = readFileSync(join(root, "src/surfaces/mcp/imaging.ts"), "utf8");
  assert.match(mcp, /"analyze_imaging_study"/);
});
