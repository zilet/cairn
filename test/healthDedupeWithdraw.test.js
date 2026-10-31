// Final-check regressions for taking an upload's readings back out (the reviewer's
// withdraw.mjs): a reading another export on file also carried is re-attributed, not
// dropped; a fold that deletes a duplicate upload never withdraws (it re-points), and
// never deletes an upload that still stands behind a reading; a replaced value comes
// back whole; and no record is left with an empty provenance map.
// Every value here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, repo } from "./_seed.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { deleteHealthDocument, replaceHealthPanels, replaceHealthPanelsByType } from "../dist/repo/health.js";
import { dedupeHealthDocuments } from "../dist/repo/health-dedupe.js";
import { settleNewHealthRecords } from "../dist/domain/health/record-dedupe.js";

const v = (name, value, unit = null, extra = {}) => ({ name, value, unit, flag: null, ...extra });

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
const rowsOn = (date) =>
  db
    .prepare("SELECT id, source_doc_id, parsed_json FROM health_documents WHERE doc_date = ? ORDER BY id")
    .all(date)
    .map((r) => ({ id: r.id, source: r.source_doc_id, parsed: JSON.parse(r.parsed_json) }));
const marker = (row, name) => row.parsed.markers.find((m) => m.name === name);
const present = (id) => !!db.prepare("SELECT 1 FROM health_documents WHERE id = ?").get(id);
const noEmptyProvenance = () =>
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM health_documents WHERE parsed_json LIKE '%"reading_sources":{}%'`).get().n,
    0,
    "no record keeps an empty reading_sources map"
  );

function upload(markers) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fp = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(fp, crypto.randomUUID());
  return repo.addHealthDocument({
    kind: "lab",
    doc_date: "2026-05-01",
    original_name: "labs.pdf",
    mime: "application/pdf",
    file_path: fp,
    parsed_json: { markers },
    enrichment_status: "done",
  }).id;
}
const primary = [v("LDL", 120, "mg/dL"), v("HDL", 55, "mg/dL"), v("Triglycerides", 90, "mg/dL")];

test("deleting an export re-attributes a reading another export on file also carried", () => {
  const a = exportRow("2026-01-01 10:00:00");
  const b = exportRow("2026-02-01 10:00:00");
  const c = exportRow("2026-03-01 10:00:00");
  pass(a, [v("Height", 70, "in"), v("BMI", 26)]);
  pass(b, [v("Temperature", 36.6, "deg C")]);
  pass(c, [v("Temperature", 36.6, "deg C")]);
  deleteHealthDocument(b);
  const [row] = rowsOn("2026-03-10");
  assert.equal(marker(row, "Temperature")?.value, 36.6, "C still carries it");
  const key = Object.keys(row.parsed.reading_sources).find((k) => /temperature/.test(k));
  assert.equal(row.parsed.reading_sources[key].source_doc_id, c, "now sourced from C");
  noEmptyProvenance();
});

test("an upload that still stands behind a reading elsewhere is never folded away as a file twin", () => {
  const u1 = upload(primary);
  replaceHealthPanels(u1, [
    {
      doc_date: "2025-11-01",
      kind: "lab",
      markers: [v("HbA1c", 5.4, "%"), v("Glucose", 90, "mg/dL"), v("Insulin", 6, "uIU/mL"), v("TSH", 2.1, "mIU/L")],
    },
  ]);
  settleNewHealthRecords(u1);
  const u2 = upload(primary);
  replaceHealthPanels(u2, [
    {
      doc_date: "2025-11-01",
      kind: "lab",
      markers: [v("HbA1c", 5.4, "%"), v("Glucose", 90, "mg/dL"), v("Ferritin", 80, "ng/mL")],
    },
  ]);
  settleNewHealthRecords(u2);
  assert.ok(marker(rowsOn("2025-11-01")[0], "Ferritin"), "Ferritin folded in from U2's panel");
  // the whole-set pass (boot / Records check) sees U2's upload row as a twin of U1's
  assert.equal(dedupeHealthDocuments({ dryRun: true }).clusters.length, 0, "U2 still brings Ferritin: not a twin");
  dedupeHealthDocuments({});
  assert.ok(present(u2), "its file stays");
  assert.equal(marker(rowsOn("2025-11-01")[0], "Ferritin")?.value, 80, "and its reading with it");
});

test("a fold that deletes a duplicate upload re-points what it brought, never withdraws it", () => {
  const u1 = upload(primary);
  replaceHealthPanels(u1, [
    { doc_date: "2025-11-01", kind: "lab", markers: [v("HbA1c", 5.4, "%"), v("Glucose", 90, "mg/dL")] },
  ]);
  settleNewHealthRecords(u1);
  const u2 = upload(primary);
  replaceHealthPanels(u2, [
    { doc_date: "2025-11-01", kind: "lab", markers: [v("HbA1c", 5.4, "%"), v("Glucose", 90, "mg/dL")] },
  ]);
  settleNewHealthRecords(u2); // U2's panel folds into U1's: it added nothing
  const [panel] = rowsOn("2025-11-01");
  assert.ok(panel.parsed.merged_from.some((e) => e.source_doc_id === u2));

  const out = dedupeHealthDocuments({});
  assert.equal(out.merged, 1, "the identical second upload folds");
  assert.ok(!present(u2));
  const [after] = rowsOn("2025-11-01");
  assert.deepEqual(
    after.parsed.markers.map((m) => m.name),
    ["HbA1c", "Glucose"],
    "nothing withdrawn"
  );
  const text = JSON.stringify(after.parsed);
  assert.ok(!after.parsed.merged_from.some((e) => e.source_doc_id === u2), "re-pointed to the survivor's upload");
  assert.ok(after.parsed.merged_from.some((e) => e.source_doc_id === u1));
  assert.ok(!Object.values(after.parsed.reading_sources ?? {}).some((s) => s.source_doc_id === u2), text);
  noEmptyProvenance();
});

test("a replaced value comes back whole, flag and printed range included", () => {
  const e1 = exportRow("2026-01-01 10:00:00");
  const e2 = exportRow("2026-02-01 10:00:00");
  pass(e1, [v("Weight", 180, "lb", { flag: "high", ref_low: 120, ref_high: 175 }), v("Height", 70, "in")]);
  pass(e2, [v("Weight", 181, "lb"), v("Temperature", 36.6, "deg C")]);
  let [row] = rowsOn("2026-03-10");
  assert.equal(marker(row, "Weight").value, 181);
  assert.equal(row.parsed.superseded_readings[0].marker.ref_high, 175, "the replaced marker is kept whole");

  deleteHealthDocument(e2);
  [row] = rowsOn("2026-03-10");
  const weight = marker(row, "Weight");
  assert.equal(weight.value, 180);
  assert.equal(weight.flag, "high");
  assert.equal(weight.ref_low, 120);
  assert.equal(weight.ref_high, 175);
  noEmptyProvenance();
});
