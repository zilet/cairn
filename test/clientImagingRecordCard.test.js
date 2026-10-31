// How a pasted imaging report reads in Records: one card per scan that leads
// with what it found, zero values that print as zero, no stored keys, and the
// study interleaved with every other record by date. Fixtures are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load() {
  const context = {
    localISO: () => "2026-10-30",
    relAge: (iso) => (iso === "2026-10-30" ? "today" : `rel:${iso}`),
    absDate: (iso) => `abs:${iso}`,
    stagger: (idx) => `--i:${idx}`,
    enrichmentActive: (status) => status === "pending" || status === "in_progress",
    CairnHealthClient: { H_FILE_PROMPT: "Share a document" },
  };
  context.window = context;
  for (const file of [
    "html-utils",
    "health-docs-client",
    "imaging-words-client",
    "imaging-client",
    "health-records-client",
  ]) {
    vm.runInNewContext(readFileSync(join(root, `public/js/${file}.js`), "utf8"), context);
  }
  return context;
}

function cacStudy(overrides = {}) {
  return {
    study: { modality: "CT", procedure: "CT coronary calcium score", study_date: "2026-10-30" },
    anatomy: { clinical_system: "cardiovascular", body_region: "torso.chest", laterality: "not_applicable" },
    report: {
      impression: "Calcium score 0, very low risk (CAC-DRS A0). No further imaging is suggested at this time.",
      findings: "No coronary artery calcium is identified.",
    },
    findings: [
      {
        source: "mychart",
        clinical_system: "cardiovascular",
        body_region: "torso.chest",
        laterality: "not_applicable",
        finding_text: "No coronary artery calcium",
        measurements: [
          { name: "Agatston score", qualifier: "LM", value: 0, unit: "Agatston" },
          { name: "Calcium volume", qualifier: "Total", value: 0, value_text: null, unit: "mm3" },
        ],
      },
    ],
    recommendations: [],
    verification: { user_confirmed: false },
    ...overrides,
  };
}

const PASTE = {
  id: 136,
  kind: "imaging",
  doc_date: "2026-10-30",
  has_file: true,
  enrichment_status: "done",
  summary: "CT coronary calcium score",
  parsed: { clinical_facts: [{ text: "Calcium score 0" }] },
  // What GET /health-docs says of a pasted CT whose only derived row is its study.
  folds_into_study: true,
};
const STUDY = {
  id: 137,
  kind: "imaging",
  doc_date: "2026-10-30",
  source_doc_id: 136,
  enrichment_status: "done",
  parsed: { imaging_study: cacStudy() },
};

test("a measurement of 0 prints its 0", () => {
  const { CairnImaging, CairnImagingWords } = load();
  assert.equal(
    CairnImagingWords.imagingMeasurementText({ name: "Agatston score", qualifier: "LM", value: 0, unit: "Agatston" }),
    "Agatston score LM 0 Agatston"
  );
  assert.equal(
    CairnImagingWords.imagingMeasurementText({ name: "Calcium volume", value: 0, value_text: "", unit: "mm3" }),
    "Calcium volume 0 mm3"
  );
  assert.equal(
    CairnImagingWords.imagingMeasurementText({ name: "Length", value_text: "<1", unit: "mm" }),
    "Length <1 mm"
  );
  const html = CairnImaging.imagingCard(STUDY, 0);
  assert.match(html, /Agatston score LM 0 Agatston/);
  assert.match(html, /Calcium volume Total 0 mm3/);
});

test("stored keys read as words and empty values are omitted", () => {
  const { CairnImaging, CairnImagingWords } = load();
  assert.equal(CairnImaging.imagingLabel("torso.chest"), "Chest");
  assert.equal(CairnImaging.imagingLabel("spine.lumbar"), "Lumbar spine");
  assert.equal(CairnImaging.imagingLabel("head_and_neck"), "Head and neck");
  for (const silent of ["not_applicable", "unknown", "Unsorted imaging", "not stated", "other", ""]) {
    assert.equal(CairnImaging.imagingLabel(silent), "", silent);
  }
  assert.equal(CairnImaging.imagingLabel("LEFT KNEE"), "LEFT KNEE", "a report's own wording is kept");

  // The hidden correction editor holds the stored values on purpose; the card
  // a person reads does not.
  const html = CairnImaging.imagingCard(STUDY, 0).replace(/<form[\s\S]*<\/form>/, "");
  assert.doesNotMatch(html, /torso\.chest|Torso Chest|not_applicable|Not Applicable|NOT APPLICABLE|Unsorted/i);
  assert.match(html, /<h4>Cardiovascular<\/h4>/);
  assert.match(html, /<h5>Chest<\/h5>/);
  assert.doesNotMatch(html, /<h6>/, "no laterality heading when none applies");
  assert.match(html, /<dd>CT coronary calcium score · Chest<\/dd>/);
});

test("the card leads with the procedure, the date and what the study found", () => {
  const { CairnImaging, CairnImagingWords } = load();
  const html = CairnImaging.imagingCard(STUDY, 0);
  assert.match(html, /<span class="sess-date">CT coronary calcium score · <span title="abs:2026-10-30">today<\/span>/);
  assert.match(html, /<p class="imaging-headline">Calcium score 0, very low risk \(CAC-DRS A0\)<\/p>/);
  assert.match(html, /aria-expanded="true"/, "the newest record opens");
  assert.match(
    CairnImaging.imagingCard(STUDY, 3),
    /hdoc-collapsed[^"]*"[^>]*data-hdoc="137"/,
    "older records stay collapsed"
  );

  // Capitals and a missing modality word read as a sentence led by the modality.
  assert.equal(
    CairnImagingWords.imagingStudyTitle(cacStudy({ study: { modality: "CT", procedure: "CARDIAC CALCIUM SCORING" } })),
    "CT cardiac calcium scoring"
  );
  assert.equal(
    CairnImagingWords.imagingStudyTitle({
      study: { modality: "MR" },
      anatomy: { body_region: "lower_extremity.knee" },
    }),
    "MR · Knee"
  );
  // No impression: a total the study states, then its first finding.
  assert.equal(CairnImagingWords.imagingHeadline(cacStudy({ report: {} })), "Calcium volume Total 0 mm3");
  const long = CairnImagingWords.imagingHeadline(
    cacStudy({
      report: { impression: `IMPRESSION: 1. ${"Mild degenerative change across several levels ".repeat(4)}` },
    })
  );
  assert.ok(long.length <= 111 && long.endsWith("…"), long);
  assert.doesNotMatch(long, /IMPRESSION|^1\./);
});

test("the paste folds into its study's card, which carries its file, re-analyze and delete", () => {
  const { CairnHealthRecords } = load();
  const html = CairnHealthRecords.recordsListHtml([STUDY, PASTE]);
  assert.doesNotMatch(html, /data-hdoc="136"/, "no card of its own for the paste");
  assert.equal((html.match(/class="sess hdoc/g) || []).length, 1);
  assert.match(html, /data-hdoc="137" data-hsource="136"/);
  assert.match(html, /data-hrescan="136"/);
  assert.match(html, /href="\/api\/health-docs\/136\/file"/);

  // A source that also split out lab panels keeps its own card.
  const exportDoc = {
    id: 50,
    kind: "clinical_summary",
    doc_date: "2026-01-02",
    has_file: true,
    enrichment_status: "done",
  };
  const panel = { id: 51, kind: "bloodwork", doc_date: "2025-12-01", source_doc_id: 50, enrichment_status: "done" };
  const derivedStudy = { ...STUDY, id: 52, source_doc_id: 50 };
  const mixed = CairnHealthRecords.recordsListHtml([exportDoc, derivedStudy, panel]);
  assert.match(mixed, /data-hdoc="50"/);
  assert.doesNotMatch(mixed, /data-hsource="50"/);
});

// The API strips parsed_json and sends `parsed`. A lab upload with markers and a CT
// read out of it is two cards, and the lab card shows its markers.
test("an API-shaped lab source with a derived CT keeps its card and its markers", () => {
  const { CairnHealthRecords, CairnHealthDocs } = load();
  const lab = {
    id: 60,
    kind: "bloodwork",
    doc_date: "2026-10-30",
    has_file: true,
    enrichment_status: "done",
    summary: "Lipid panel",
    parsed: {
      markers: [
        { name: "ApoB", value: 92, unit: "mg/dL", flag: "high" },
        { name: "LDL-C", value: 0, unit: "mg/dL", flag: "normal" },
      ],
    },
  };
  const ct = { ...STUDY, id: 61, source_doc_id: 60 };
  const html = CairnHealthRecords.recordsListHtml([lab, ct]);
  assert.match(html, /data-hdoc="60"/, "the lab source is its own card");
  assert.doesNotMatch(html, /data-hsource="60"/);
  assert.match(html, /<td class="hm-name">ApoB<\/td>/);
  assert.match(html, /2 markers · 1 flagged/);
  assert.equal(CairnHealthDocs.parsedDoc(lab).markers.length, 2);
  assert.equal(
    CairnHealthDocs.parsedDoc({ parsed_json: JSON.stringify({ markers: [{ name: "A" }] }) }).markers.length,
    1
  );
});

test("imaging studies interleave with every record by date, newest first", () => {
  const { CairnHealthRecords } = load();
  const newer = { id: 200, kind: "bloodwork", doc_date: "2026-10-30", enrichment_status: "done" };
  const older = { id: 20, kind: "bloodwork", doc_date: "2021-05-04", enrichment_status: "done" };
  const study = { ...STUDY, doc_date: "2026-06-01" };
  // The server's order: effective date, newest first.
  const html = CairnHealthRecords.recordsListHtml([newer, study, PASTE, older]);
  const order = [...html.matchAll(/data-hdoc="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["200", "137", "20"]);
  assert.doesNotMatch(html, /imaging-record-group|<h3>/, "no imaging section after the documents");
});

test("a source being re-read shows on its study card, with elapsed time once it has been a while", () => {
  const { CairnHealthRecords, CairnHealthDocs } = load();
  const since = new Date(Date.now() - 4 * 60_000).toISOString();
  const busy = { ...PASTE, enrichment_status: "in_progress", enrich_since: since };
  const html = CairnHealthRecords.recordsListHtml([STUDY, busy]);
  assert.match(html, /data-hpoll="136"/);
  assert.match(html, /Still reading — 4 min so far\. The coach is busy; it'll finish on its own\./);
  assert.match(html, /data-hrescan="136" disabled/);

  const t0 = Date.parse("2026-10-30T12:00:00Z");
  const lead = "Reading the document and splitting it by date...";
  assert.equal(CairnHealthDocs.analyzingText(lead, t0, t0 + 30_000), lead, "quiet for the first minute");
  assert.match(CairnHealthDocs.analyzingText(lead, t0, t0 + 2 * 60_000), /^Still reading — 2 min so far/);
  assert.match(CairnHealthDocs.analyzingText(lead, t0, t0 + 95 * 60_000), /about 2 hours so far/);
  assert.equal(CairnHealthDocs.analyzingText(lead, t0, t0 + 3 * 86_400_000), lead, "a stale stamp says nothing");
  // created_at is SQLite UTC without a zone mark.
  const line = CairnHealthDocs.analyzingLineHtml({ created_at: "2026-10-30 12:00:00" }, lead, t0 + 5 * 60_000);
  assert.match(line, new RegExp(`data-enr-since="${t0}"`));
  assert.match(line, /5 min so far/);
});

test("an upload already on file settles the status line calmly; a new one clears it", () => {
  const { CairnHealthDocs } = load();
  const status = { textContent: "Uploading…" };
  const polls = [];
  const poll = (id) => polls.push(id);
  assert.equal(CairnHealthDocs.settleUploadStatus({ id: 9 }, status, poll), false);
  assert.equal(status.textContent, "");
  assert.equal(CairnHealthDocs.settleUploadStatus({ id: 7, duplicate_of: 7 }, status, poll), true);
  assert.equal(status.textContent, "That report is already on file.");
  assert.deepEqual(polls, []);
  assert.equal(CairnHealthDocs.settleUploadStatus({ id: 7, duplicate_of: 7, reanalyzing: true }, status, poll), true);
  assert.match(status.textContent, /already on file\. Its earlier read didn’t finish/);
  assert.deepEqual(polls, [7], "a retried read is watched");
});
