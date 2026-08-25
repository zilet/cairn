// One panel per draw date. The same lab draw reaches Cairn more than once — a
// PDF and a zip of the same export, a later re-export, one import read both by
// the CCDA pass and by an agent — and each arrival used to become its own dated
// record. These cases pin the fold: twins are recognized by DISCRIMINATING
// agreeing readings on the same date, the uploaded source row survives, a twin's
// extra analytes join the survivor — and records that merely share a date, a
// weight, or a day-apart weigh-in stay apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, repo } from "./_seed.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";

// A file the delete path is allowed to remove: one that lives under the uploads root.
function uploadFile(name) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = path.join(UPLOADS_DIR, name);
  fs.writeFileSync(file, "pdf");
  return file;
}

const m = (name, value, extra = {}) => ({ name, value, unit: "mg/dL", flag: null, ...extra });

function doc(input) {
  return repo.addHealthDocument({ kind: "bloodwork", enrichment_status: "done", ...input });
}

function parsedOf(id) {
  const row = db.prepare("SELECT parsed_json FROM health_documents WHERE id = ?").get(id);
  return row ? JSON.parse(row.parsed_json) : null;
}
const markersOf = (id) => parsedOf(id)?.markers ?? null;
const ids = () => db.prepare("SELECT id FROM health_documents ORDER BY id").all().map((r) => r.id);

test("the same draw uploaded twice folds into the source row and gains the twin's extra analytes", () => {
  const source = doc({
    doc_date: "2024-04-17",
    file_path: "/nonexistent/upload.pdf",
    original_name: "summary.pdf",
    parsed_json: {
      markers: [m("Cholesterol", 251), m("HDL (High Density Lipoprotein)", 49), m("LDL-C (Direct)", 175)],
      clinical_facts: [{ kind: "condition", name: "Elevated LDL" }],
    },
  });
  const twin = doc({
    doc_date: "2024-04-17",
    source_doc_id: 999,
    parsed_json: {
      markers: [m("Total Cholesterol", 251, { ref_low: 100, ref_high: 199 }), m("HDL Cholesterol", 49), m("Sodium", 140, { unit: "mmol/L" })],
      clinical_facts: [{ kind: "condition", name: "Elevated LDL" }, { kind: "medication", name: "Rosuvastatin" }],
    },
  });
  const dry = repo.dedupeHealthDocuments({ dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.merged, 1);
  assert.deepEqual(ids(), [source.id, twin.id], "a dry run writes nothing");

  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 1);
  assert.equal(result.added_markers, 1);
  assert.equal(result.clusters[0].survivor.id, source.id);
  assert.deepEqual(ids(), [source.id]);
  const parsed = parsedOf(source.id);
  assert.deepEqual(
    parsed.markers.map((x) => x.name),
    ["Total Cholesterol", "HDL (High Density Lipoprotein)", "LDL-C (Direct)", "Sodium"]
  );
  assert.equal(parsed.markers[0].ref_high, 199, "the reading that kept the lab's printed range takes the slot");
  assert.deepEqual(parsed.clinical_facts.map((f) => f.name), ["Elevated LDL", "Rosuvastatin"], "facts union, deduped");
  assert.deepEqual(parsed.merged_from.map((x) => x.id), [twin.id]);
  assert.equal(repo.dedupeHealthDocuments().merged, 0, "a second run is a no-op");
});

test("records that merely share a date stay apart: nothing in common, or readings that disagree", () => {
  const chem = doc({ doc_date: "2026-03-11", parsed_json: { markers: [m("Sodium", 137), m("Potassium", 4.1)] } });
  const ecg = doc({ doc_date: "2026-03-11", kind: "ecg", parsed_json: { markers: [m("Ventricular Rate", 71, { unit: "bpm" })] } });
  const morning = doc({ doc_date: "2026-03-11", kind: "vitals", parsed_json: { markers: [m("Systolic BP", 144), m("Pulse", 83)] } });
  const evening = doc({ doc_date: "2026-03-11", kind: "vitals", parsed_json: { markers: [m("Systolic BP", 121), m("Pulse", 62)] } });
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 0);
  assert.deepEqual(ids(), [chem.id, ecg.id, morning.id, evening.id]);
});

test("a shared weight or BMI is not identity: a DEXA and a lab panel the same morning stay apart", () => {
  const dexa = doc({ doc_date: "2026-05-01", kind: "dexa", file_path: "/nonexistent/dexa.pdf", parsed_json: { markers: [m("Weight", 183, { unit: "lb" }), m("Body Fat %", 35.6, { unit: "%" }), m("Body Mass Index", 27.2)] } });
  const labs = doc({ doc_date: "2026-05-01", file_path: "/nonexistent/labs.pdf", parsed_json: { markers: [m("Weight", 183, { unit: "lb" }), m("BMI", 27.2), m("Sodium", 140)] } });
  const vitals = doc({ doc_date: "2026-05-01", kind: "vitals", parsed_json: { markers: [m("BMI", 27.2)] } });
  const office = doc({ doc_date: "2026-05-01", kind: "vitals", parsed_json: { markers: [m("Weight", 183, { unit: "lb" }), m("Body Temperature", 36.6, { unit: "C" }), m("O2 Sat", 97, { unit: "%" }), m("Pulse", 60)] } });
  const bodyComp = doc({ doc_date: "2026-05-01", kind: "dexa", parsed_json: { markers: [m("Weight", 183, { unit: "lb" }), m("Body Temperature", 36.6, { unit: "C" }), m("O2 Sat", 97, { unit: "%" }), m("Bone Density", 1.21, { unit: "g/cm2" })] } });
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 0, "office vitals under any canon spelling never fold a DEXA into a vitals sheet");
  assert.equal(result.converged, true);
  assert.deepEqual(ids(), [dexa.id, labs.id, vitals.id, office.id, bodyComp.id]);
  for (const key of ["body temperature", "o2 sat", "weight lb", "systolic bp", "respiratory rate", "body mass index"]) {
    assert.equal(repo.isNonDiscriminatingKey(key), true, key);
  }
  assert.equal(repo.isNonDiscriminatingKey("hba1c"), false);
});

test("a whole vitals sheet agreeing IS the same reading", () => {
  const sheet = doc({ doc_date: "2026-03-11", kind: "clinical_summary", file_path: "/nonexistent/summary.pdf", parsed_json: { markers: [m("Systolic Blood Pressure", 113), m("Diastolic Blood Pressure", 75), m("Pulse", 78), m("Temperature", 36.3)] } });
  const twin = doc({ doc_date: "2026-03-11", kind: "vitals", source_doc_id: 7, parsed_json: { type: "ccda_vitals", markers: [m("Systolic BP", 113), m("Diastolic BP", 75), m("Pulse", 78), m("Oxygen Saturation", 96)] } });
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 1);
  assert.deepEqual(ids(), [sheet.id]);
  assert.ok(markersOf(sheet.id).some((x) => x.name === "Oxygen Saturation"));
  assert.equal(markersOf(twin.id), null);
});

test("an agent's read of what the CCDA pass filed folds into the deterministic panel, tolerant of rounding", () => {
  const sourceId = doc({ doc_date: "2026-08-24", file_path: "/nonexistent/export.zip", parsed_json: { markers: [m("Vitamin D", 28)] } }).id;
  const deterministic = doc({
    doc_date: "2025-10-29",
    source_doc_id: sourceId,
    parsed_json: { type: "ccda_results", markers: [m("Hemoglobin A1c", 5.4, { unit: "%" }), m("LDL-C (Direct)", 175), m("BMI", 27.2)] },
  });
  const agent = doc({
    doc_date: "2025-10-29",
    source_doc_id: sourceId,
    parsed_json: { markers: [m("Low Density Lipoprotein Direct", 175), m("Body Mass Index", 27.21), m("Height", 167.6, { unit: "cm" })] },
  });
  const result = repo.dedupeHealthDocuments({ scopeSourceId: sourceId });
  assert.equal(result.merged, 1);
  assert.equal(result.clusters[0].survivor.id, deterministic.id, "the deterministic read survives over the agent's");
  assert.equal(markersOf(agent.id), null);
  assert.deepEqual(markersOf(deterministic.id).map((x) => x.name), ["Hemoglobin A1c", "LDL-C (Direct)", "BMI", "Height"]);
});

test("the two deterministic streams of one export never fold into each other", () => {
  const results = doc({ doc_date: "2026-03-10", source_doc_id: 53, parsed_json: { type: "ccda_results", markers: [m("Sodium", 137), m("Pulse", 83), m("Systolic BP", 144), m("Diastolic BP", 87)] } });
  const vitals = doc({ doc_date: "2026-03-10", kind: "vitals", source_doc_id: 53, parsed_json: { type: "ccda_vitals", markers: [m("Pulse", 83), m("Systolic BP", 144), m("Diastolic BP", 87)] } });
  assert.equal(repo.dedupeHealthDocuments({ scopeSourceId: 53 }).merged, 0);
  assert.deepEqual(ids(), [results.id, vitals.id]);
});

test("an agent panel a day off its draw snaps to the dated record it agrees with; consecutive weigh-ins do not", () => {
  const drawn = doc({ doc_date: "2022-01-20", parsed_json: { type: "ccda_results", markers: [m("Hemoglobin A1c", 5.4), m("Estimated Average Glucose", 108), m("Sodium", 139)] } });
  const drifted = doc({ doc_date: "2022-01-21", parsed_json: { markers: [m("HbA1c", 5.4), m("Estimated Average Glucose", 108), m("HIV Ag/Ab Qualitative", "Non-Reactive")] } });
  const other = doc({ doc_date: "2022-01-21", parsed_json: { markers: [m("Hemoglobin A1c", 5.4), m("Estimated Average Glucose", 108), m("Sodium", 142)] } });
  const dayOne = doc({ doc_date: "2026-06-01", kind: "vitals", parsed_json: { markers: [m("Weight", 183.0, { unit: "lb" }), m("BMI", 27.2)] } });
  const dayTwo = doc({ doc_date: "2026-06-02", kind: "vitals", parsed_json: { markers: [m("Weight", 183.4, { unit: "lb" }), m("BMI", 27.25)] } });
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 1);
  assert.deepEqual(ids(), [drawn.id, other.id, dayOne.id, dayTwo.id]);
  assert.ok(markersOf(drawn.id).some((x) => x.name === "HIV Ag/Ab Qualitative"));
  assert.equal(markersOf(drifted.id), null);
});

test("a chain folds to a fixed point in one call, and the dry run reports that same end state", () => {
  const a = doc({ doc_date: "2023-02-20", parsed_json: { type: "ccda_results", markers: [m("Total Cholesterol", 219), m("Triglycerides", 110)] } });
  const b = doc({ doc_date: "2023-02-20", parsed_json: { markers: [m("Cholesterol", 219), m("Triglycerides", 110), m("HDL-C", 52), m("LDL-C (Direct)", 155)] } });
  const c = doc({ doc_date: "2023-02-20", parsed_json: { markers: [m("HDL Cholesterol", 52), m("LDL-C (Direct)", 155)] } });
  const dry = repo.dedupeHealthDocuments({ dryRun: true });
  assert.equal(dry.merged, 2);
  assert.equal(dry.passes, 2);
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 2);
  assert.deepEqual(ids(), [a.id]);
  assert.deepEqual(markersOf(a.id).map((x) => x.name), ["Total Cholesterol", "Triglycerides", "HDL-C", "LDL-C (Direct)"]);
  assert.equal(markersOf(b.id), null);
  assert.equal(markersOf(c.id), null);
});

test("the ingest scope only folds clusters this upload touched, and sees the upload while it is still in progress", () => {
  const older = doc({ doc_date: "2026-06-30", file_path: "/nonexistent/older.pdf", parsed_json: { markers: [m("Cholesterol, Total", 238), m("Triglycerides", 74), m("HDL Cholesterol", 51)] } });
  const again = uploadFile("again.pdf");
  const upload = doc({ doc_date: "2026-06-30", file_path: again, enrichment_status: "in_progress", parsed_json: { markers: [m("Total Cholesterol", 238), m("Triglycerides", 74)] } });
  const a = doc({ doc_date: "2023-02-20", source_doc_id: 41, parsed_json: { markers: [m("Total Cholesterol", 219), m("Triglycerides", 110)] } });
  const b = doc({ doc_date: "2023-02-20", source_doc_id: 42, parsed_json: { markers: [m("Cholesterol", 219), m("Triglycerides", 110)] } });
  const scoped = repo.dedupeHealthDocuments({ scopeSourceId: upload.id });
  assert.equal(scoped.merged, 1, "the in-progress re-upload folds into the record that already holds its draw");
  assert.equal(scoped.deleted_files, 1);
  assert.deepEqual(scoped.errors, []);
  assert.equal(fs.existsSync(again), false, "the identical second upload's file goes with its record");
  assert.deepEqual(ids(), [older.id, a.id, b.id]);
  assert.equal(repo.dedupeHealthDocuments({ scopeSourceId: 42 }).merged, 1);
  assert.deepEqual(ids(), [older.id, a.id]);
});

test("an upload that knows something the survivor does not keeps its record, even as a twin", () => {
  const first = doc({ doc_date: "2026-03-10", file_path: "/nonexistent/a.pdf", parsed_json: { markers: [m("Sodium", 137), m("Potassium", 4.1), m("Chloride", 100), m("Calcium", 9.3)] } });
  const second = doc({ doc_date: "2026-03-10", file_path: "/nonexistent/b.pdf", parsed_json: { markers: [m("Sodium", 137), m("Potassium", 4.1), m("Chloride", 100), m("Magnesium", 2.1)] } });
  assert.equal(repo.dedupeHealthDocuments().merged, 0);
  assert.deepEqual(ids(), [first.id, second.id]);
});

test("an upload with its own derived set is never folded away", () => {
  const first = doc({ doc_date: "2026-03-10", file_path: "/nonexistent/a.pdf", parsed_json: { markers: [m("Sodium", 137), m("Potassium", 4.1)] } });
  doc({ doc_date: "2026-02-24", source_doc_id: first.id, kind: "vitals", parsed_json: { markers: [m("Pulse", 73), m("Systolic BP", 125), m("Diastolic BP", 78)] } });
  const second = doc({ doc_date: "2026-03-10", file_path: "/nonexistent/b.zip", parsed_json: { markers: [m("Sodium", 137), m("Potassium", 4.1), m("Chloride", 100)] } });
  doc({ doc_date: "2026-02-24", source_doc_id: second.id, kind: "vitals", parsed_json: { markers: [m("Pulse", 73), m("Systolic BP", 125), m("Diastolic BP", 78)] } });
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 1, "the derived vitals twins fold; the two uploads both stay");
  const remaining = db.prepare("SELECT id FROM health_documents WHERE file_path IS NOT NULL ORDER BY id").all();
  assert.deepEqual(remaining.map((r) => r.id), [first.id, second.id]);
});

test("a lab's free-text observation row is not a marker", () => {
  assert.equal(repo.isNonAnalyteMarkerName("Lab Interpretation"), true);
  assert.equal(repo.isNonAnalyteMarkerName("LDL-C (Direct)"), false);
  const created = repo.replaceHealthPanels(12345, [
    { doc_date: "2023-02-20", markers: [m("Lab Interpretation", "Abnormal"), m("Vitamin D,25 Hydroxy", 18, { unit: "ng/mL" })] },
  ]);
  assert.deepEqual(markersOf(created[0].id).map((x) => x.name), ["Vitamin D,25 Hydroxy"]);
});

test("the canon recognizes the CCDA spellings of everyday analytes", () => {
  assert.equal(repo.canonicalMarker("High Density Lipoprotein").key, "hdl cholesterol");
  assert.equal(repo.canonicalMarker("Low Density Lipoprotein Direct").key, "ldl c direct");
  assert.equal(repo.canonicalMarker("CO2").key, "carbon dioxide");
  assert.equal(repo.canonicalMarker("BMI").key, "body mass index");
  assert.equal(repo.canonicalMarker("LDL Cholesterol").key, "ldl c", "calculated LDL still never folds into direct");
});

test("a twin whose file cannot be removed is not folded: the survivor stays untouched and the fold reports it", () => {
  const older = doc({ doc_date: "2026-06-30", file_path: uploadFile("older.pdf"), parsed_json: { markers: [m("Cholesterol, Total", 238), m("Triglycerides", 74), m("HDL Cholesterol", 51)] } });
  const stuck = doc({ doc_date: "2026-06-30", file_path: "/nonexistent/outside-uploads.pdf", parsed_json: { markers: [m("Total Cholesterol", 238), m("Triglycerides", 74)] } });
  const before = JSON.stringify(parsedOf(older.id));
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.converged, false);
  assert.deepEqual(ids(), [older.id, stuck.id]);
  assert.equal(JSON.stringify(parsedOf(older.id)), before);
});

test("a fold that stops on a failed delete still names the twin it did fold", () => {
  const older = doc({ doc_date: "2026-06-30", file_path: uploadFile("older.pdf"), parsed_json: { markers: [m("Cholesterol, Total", 238), m("Triglycerides", 74), m("HDL Cholesterol", 51)] } });
  const fine = doc({ doc_date: "2026-06-30", parsed_json: { markers: [m("Total Cholesterol", 238), m("Triglycerides", 74), m("Calcium", 9.3)] } });
  const stuck = doc({ doc_date: "2026-06-30", file_path: "/nonexistent/outside-uploads.pdf", parsed_json: { markers: [m("Total Cholesterol", 238), m("Triglycerides", 74)] } });
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 1);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.clusters.map((c) => [c.survivor.id, c.merged.map((t) => t.id)]), [[older.id, [fine.id]]]);
  assert.deepEqual(ids(), [older.id, stuck.id]);
  assert.ok(markersOf(older.id).some((x) => x.name === "Calcium"));
});
