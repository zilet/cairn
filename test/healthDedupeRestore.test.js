// Second-review regressions for the duplicate fold's bookkeeping: the fold history
// never evicts a snapshot a restore still needs, deleting a twin's export takes back
// exactly what that export brought, the snapshots never reach a client or the search
// index, a re-read never notes the same replaced value twice, and a person's merge
// also agrees on which uploads it deletes.
// Every value here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, repo } from "./_seed.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { deleteHealthDocument, listHealthDocuments, replaceHealthPanelsByType } from "../dist/repo/health.js";
import { dedupeHealthDocuments } from "../dist/repo/health-dedupe.js";
import { searchRecords } from "../dist/domain/health/records-search.js";
import { applyPlannedDedupe, settleNewHealthRecords } from "../dist/domain/health/record-dedupe.js";

const v = (name, value, unit = null) => ({ name, value, unit, flag: null });

function exportRow(createdAt) {
  const row = repo.addHealthDocument({ kind: "other", original_name: "export.zip", enrichment_status: "done" });
  db.prepare("UPDATE health_documents SET created_at = ? WHERE id = ?").run(createdAt, row.id);
  return row.id;
}

const base = [v("Systolic BP", 128, "mmHg"), v("Diastolic BP", 79, "mmHg"), v("Pulse", 71, "bpm")];
const visit = (extra) => [
  {
    doc_date: "2026-03-10",
    kind: "other",
    summary: "MyChart vitals recorded 2026-03-10 15:52",
    recorded_at: "2026-03-10 15:52",
    markers: [...base, ...extra],
  },
];
const pass = (source, extra) => {
  replaceHealthPanelsByType(source, "ccda_vitals", visit(extra));
  return settleNewHealthRecords(source);
};
const visitRows = () =>
  db
    .prepare("SELECT id, source_doc_id, parsed_json FROM health_documents WHERE doc_date = '2026-03-10' ORDER BY id")
    .all()
    .map((r) => ({ id: r.id, source: r.source_doc_id, parsed: JSON.parse(r.parsed_json) }));
const names = (row) => row.parsed.markers.map((m) => m.name).sort();

test("twenty re-reads of one export never evict the snapshot of another export still on file", () => {
  // the reviewer's cap.mjs: only B carries Temperature
  const a = exportRow("2026-01-01 10:00:00");
  const b = exportRow("2026-02-01 10:00:00");
  const c = exportRow("2026-03-01 10:00:00");
  pass(a, [v("Height", 70, "in"), v("BMI", 26)]);
  pass(b, [v("Temperature", 36.6, "deg C")]);
  pass(c, [v("Weight", 182, "lb")]);
  for (let i = 0; i < 20; i++) pass(c, [v("Weight", 182, "lb")]);
  const [survivor] = visitRows();
  const entries = survivor.parsed.merged_from;
  assert.equal(entries.filter((e) => e.source_doc_id === c).length, 1, "one entry per export and draw");
  assert.ok(
    entries.some((e) => e.source_doc_id === b && e.snapshot),
    "B's snapshot survives the re-reads"
  );

  deleteHealthDocument(a);
  const rows = visitRows();
  assert.equal(rows.length, 1, "B and C fold back into one visit");
  assert.ok(names(rows[0]).includes("Temperature"), "B's reading is still on file");
  assert.ok(names(rows[0]).includes("Weight"));
  assert.ok(!names(rows[0]).includes("Height"), "what only A had went with A");
});

test("deleting the twin's export takes back exactly what it brought (the reviewer's deltwin.mjs)", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  // equal sheets, so E1's row (the older id) is the survivor and E2 the twin
  pass(e1, [v("Weight", 180, "lb"), v("Height", 70, "in")]);
  pass(e2, [v("Weight", 181, "lb"), v("Temperature", 36.6, "deg C")]);
  let [row] = visitRows();
  assert.equal(row.source, e1);
  assert.equal(row.parsed.markers.find((m) => m.name === "Weight").value, 181);

  deleteHealthDocument(e2);
  [row] = visitRows();
  assert.equal(row.source, e1);
  assert.equal(row.parsed.markers.find((m) => m.name === "Weight").value, 180, "E1's own weight is back");
  const weightKey = Object.keys(row.parsed.reading_sources).find((k) => /weight/.test(k));
  assert.equal(row.parsed.reading_sources[weightKey].source_doc_id, e1, "sourced from E1 again");
  assert.ok(!names(row).includes("Temperature"), "a reading only E2 had goes with E2");
  assert.ok(names(row).includes("Height"), "E1's own readings stay");
  assert.deepEqual(row.parsed.superseded_readings ?? [], []);
  assert.ok(!(row.parsed.merged_from ?? []).some((e) => e.source_doc_id === e2));
});

test("deleting the export that OWNS the merged row files the other export's visit again as it was", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  pass(e1, [v("Weight", 180, "lb")]);
  pass(e2, [v("Weight", 181, "lb"), v("Temperature", 36.6, "deg C")]); // fuller: E2's row survives
  assert.equal(visitRows()[0].source, e2);
  deleteHealthDocument(e2);
  const [row] = visitRows();
  assert.equal(row.source, e1);
  assert.equal(row.parsed.markers.find((m) => m.name === "Weight").value, 180);
  assert.ok(!names(row).includes("Temperature"));
});

test("a fold's snapshots never reach a client payload or the records search", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  pass(e1, [v("Weight", 180, "lb")]);
  pass(e2, [v("Weight", 181, "lb")]);
  const [stored] = visitRows();
  assert.ok(
    stored.parsed.merged_from.some((e) => e.snapshot),
    "kept on the server"
  );
  const pub = listHealthDocuments(10).find((d) => d.doc_date === "2026-03-10");
  assert.ok(pub.parsed.merged_from.length);
  assert.ok(
    pub.parsed.merged_from.every((e) => !("snapshot" in e)),
    "never in the API row"
  );
  // a word only an absorbed record carried lives on only in its snapshot: never a search hit
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-04-04",
    summary: "Lipids",
    enrichment_status: "done",
    parsed_json: { markers: [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL"), v("Triglycerides", 90, "mg/dL")] },
  });
  const absorbed = repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-04-04",
    summary: "Zebrafinch panel",
    enrichment_status: "done",
    parsed_json: { markers: [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL")] },
  }).id;
  assert.equal(settleNewHealthRecords(absorbed).merged, 1);
  const read = searchRecords({ q: "zebrafinch" });
  const hits = read.sections.flatMap((s) => s.hits);
  assert.equal(hits.length, 0, "the snapshot's words are not this record's text");
});

test("re-reading an export never notes the same replaced value twice", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  pass(e1, [v("Weight", 180, "lb")]);
  pass(e2, [v("Weight", 181, "lb")]);
  pass(e2, [v("Weight", 181, "lb")]);
  pass(e2, [v("Weight", 181, "lb")]);
  const [row] = visitRows();
  assert.equal(row.parsed.superseded_readings.length, 1);
});

test("a planned merge also agrees on the uploads it deletes", () => {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = (name) => {
    const fp = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(fp, "x");
    return fp;
  };
  const markers = [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL")];
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    file_path: file("p1.pdf"),
    mime: "application/pdf",
    enrichment_status: "done",
    parsed_json: { markers },
  });
  repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    file_path: file("p2.pdf"),
    mime: "application/pdf",
    enrichment_status: "done",
    parsed_json: { markers },
  });
  const plan = dedupeHealthDocuments({ dryRun: true });
  const [c] = plan.clusters;
  assert.equal(c.removes.length, 1);
  const base = { survivor: c.survivor.id, merged: c.merged.map((m) => m.id), rule: c.rule };
  // a client that did not agree to the file going: nothing is folded
  const refused = applyPlannedDedupe([{ ...base, removes: [] }]);
  assert.equal(refused.ok, false);
  assert.equal(refused.changed, true);
  // the plan as shown (removes by id, or as the plan's own objects) folds
  const applied = applyPlannedDedupe([{ ...base, removes: c.removes }]);
  assert.equal(applied.ok, true);
  assert.equal(applied.merged, 1);
});
