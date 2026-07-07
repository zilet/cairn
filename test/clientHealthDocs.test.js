import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHealthDocs() {
  const context = {
    Object,
    String,
    JSON,
    localISO: () => "2026-06-30",
    stagger: (idx) => `--i:${idx}`,
    withToken: (url) => `TOKEN:${url}`,
    enrichmentActive: (status) => status === "pending" || status === "enriching",
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-docs-client.js"), "utf8"), context);
  return context.CairnHealthDocs;
}

test("health document helpers render analyzed records safely", () => {
  const docs = loadHealthDocs();
  const row = {
    id: 12,
    kind: "bloodwork",
    doc_date: "2026-06-01",
    original_name: "labs <raw>.pdf",
    has_file: true,
    enrichment_status: "done",
    summary: "Looks <steady>",
    parsed_json: JSON.stringify({
      markers: [
        { name: "LDL-C <direct>", value: 101, unit: "mg/dL", flag: "high" },
        { name: "Vitamin D", value: 44, unit: "ng/mL", flag: "normal" },
      ],
    }),
  };

  const inner = docs.healthDocInner(row);
  assert.match(inner, /Bloodwork · 2026-06-01/);
  assert.match(inner, /✦ analyzed/);
  assert.match(inner, /2 markers · 1 flagged/);
  assert.match(inner, /LDL-C &lt;direct&gt;/);
  assert.match(inner, /Looks &lt;steady&gt;/);
  assert.match(inner, /id="hdate-12"/);
  assert.match(inner, /name="health_doc_date_12"/);
  assert.match(inner, /TOKEN:\/api\/health-docs\/12\/file/);
  assert.doesNotMatch(inner, /<direct>|<steady>|labs <raw>/);
  assert.equal(docs.docCollapsible(row), true);
  assert.equal(docs.markerFlagClass("critical"), "hm-flag warn");
  assert.equal(docs.healthKindLabel("dexa"), "DEXA");
  assert.equal(docs.healthKindLabel("ecg"), "ECG");
  assert.equal(docs.healthKindLabel("visit_note"), "Visit Note");
  assert.equal(docs.healthKindLabel("after_visit_summary"), "After Visit Summary");
  assert.equal(docs.healthKindLabel("metabolic_test"), "Metabolic Test");
  assert.equal(docs.healthKindLabel("vision"), "Vision");
});

test("health document wrappers collapse older cards and handle pending rows", () => {
  const docs = loadHealthDocs();
  const done = { id: 1, kind: "other", enrichment_status: "done", summary: "Done" };
  const pending = { id: 2, kind: "other", enrichment_status: "pending", has_file: true };

  assert.match(docs.healthDocHtml(done, 1), /hdoc-collapsed/);
  assert.doesNotMatch(docs.healthDocHtml(done, 0), /hdoc-collapsed/);
  assert.match(docs.healthDocInner(pending), /analyzing/);
  assert.match(docs.healthDocInner(pending), /disabled/);
  assert.equal(docs.markersTable({ markers: [] }), "");
  assert.equal(docs.parsedDoc({ parsed_json: "not json" }), null);
});

test("health document teaser names structured clinical facts", () => {
  const docs = loadHealthDocs();
  const note = {
    id: 3,
    kind: "visit_note",
    enrichment_status: "done",
    summary: "PCP follow-up note.",
    parsed_json: {
      markers: [],
      clinical_facts: [
        { kind: "encounter", name: "Visit" },
        { kind: "other", name: "Lab order" },
      ],
    },
  };

  const inner = docs.healthDocInner(note);
  assert.match(inner, /Visit Note/);
  assert.match(inner, /2 facts/);
});
