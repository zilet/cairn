import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthRecords() {
  const calls = [];
  const context = {
    Object,
    String,
    Array,
    CairnHealthClient: {
      H_FILE_PROMPT: "Share a document <now>",
    },
    CairnHealthDocs: {
      healthDocHtml: (doc, index) => {
        calls.push([doc, index]);
        return `<article class="hdoc" data-id="${String(doc.id)}" data-index="${index}">${String(doc.name || "")}</article>`;
      },
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-records-client.js"), "utf8"), context);
  return { records: context.CairnHealthRecords, calls };
}

test("health records shell renders stable upload controls and escapes file prompt", () => {
  const { records } = loadHealthRecords();

  const html = records.recordsTabHtml();

  assert.match(html, /id="hUploadBox"/);
  assert.match(html, /id="hFile"/);
  assert.match(html, /accept="image\/\*,application\/pdf,.zip,.htm,.html,.xml,application\/zip,text\/html,application\/xml"/);
  assert.match(html, /id="hText"/);
  assert.match(html, /id="hUpload"/);
  assert.match(html, /id="hStatus"/);
  assert.match(html, /id="hlist"/);
  assert.match(html, /Share a document &lt;now&gt;/);
  assert.doesNotMatch(html, /Share a document <now>/);
});

test("health records list composes typed health document cards and filters junk rows", () => {
  const { records, calls } = loadHealthRecords();

  const html = records.recordsListHtml([
    { id: 1, name: "A" },
    null,
    "bad",
    { id: 2, name: "B" },
  ]);

  assert.match(html, /data-id="1" data-index="0">A/);
  assert.match(html, /data-id="2" data-index="1">B/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0].id, 1);
  assert.equal(calls[1][1], 1);
  assert.deepEqual(records.normalizeDocuments(["bad", null, { id: 3 }]).map((doc) => doc.id), [3]);
  assert.match(records.recordsListHtml([]), /No documents yet/);
  assert.match(records.recordsEmptyHtml("No <docs>"), /No &lt;docs&gt;/);
});

// A pasted report whose only output is its imaging study is ONE card: the source folds
// into the study card, which carries its "view file". A source with markers keeps its card.
test("health records fold an imaging-only source into its study card", () => {
  const calls = [];
  const context = {
    Object,
    String,
    Array,
    Map,
    CairnHealthClient: { H_FILE_PROMPT: "Share" },
    CairnHealthDocs: {
      parsedDoc: (doc) => doc.parsed ?? null,
      healthDocHtml: (doc, index, opts = {}) => {
        calls.push(doc);
        return `<article data-id="${String(doc.id)}" data-source-file="${opts.sourceHidden ? String(opts.source?.id ?? "") : ""}"></article>`;
      },
    },
    CairnImaging: {
      imagingStudy: (doc) => doc.parsed?.imaging_study ?? null,
      imagingStudyGrouping: () => ({ system: "cardiovascular", region: "heart", laterality: "" }),
      imagingLabel: (value) => String(value),
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-records-client.js"), "utf8"), context);
  const records = context.CairnHealthRecords;
  const source = { id: 7, kind: "other", has_file: true, parsed: { markers: [], imaging_only: true }, summary: "CT" };
  const mixed = { id: 8, kind: "other", has_file: true, parsed: { markers: [{ name: "ApoB" }], imaging_only: true } };
  const study = { id: 9, kind: "imaging", source_doc_id: 7, parsed: { imaging_study: { study: {} } } };
  const mixedStudy = { id: 10, kind: "imaging", source_doc_id: 8, parsed: { imaging_study: { study: {} } } };
  const html = records.recordsListHtml([source, mixed, study, mixedStudy]);
  assert.doesNotMatch(html, /data-id="7"/, "the empty source is not its own card");
  assert.match(html, /data-id="9" data-source-file="7"/, "the study card carries the source's file");
  assert.match(html, /data-id="8"/, "a source with markers keeps its card");
  assert.match(html, /data-id="10" data-source-file=""/);
  // An imaging-only source whose study is not on the list stays visible (never lost).
  assert.match(records.recordsListHtml([source]), /data-id="7"/);
});
