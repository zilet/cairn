import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { db, repo, resetTables } from "./_seed.js";

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ccda-test-"));
  fs.writeFileSync(path.join(dir, "DOC0001.XML"), `<?xml version="1.0"?>
<ClinicalDocument>
  <component><structuredBody>
    <component><section>
      <title>Last Filed Vital Signs</title>
      <text>
        Blood Pressure 125 / 78 02/24/2026 10:10 AM EDT
        Pulse 73 02/24/2026 10:10 AM EDT
        Temperature 36.4 deg C (97.6 deg F) 02/24/2026 10:10 AM EDT
        Oxygen Saturation 96% 02/24/2026 10:10 AM EDT
        Respiratory Rate 16 02/24/2026 10:10 AM EDT
      </text>
    </section></component>
    <component><section>
      <title>Allergies</title>
      <text>No known active allergies</text>
    </section></component>
    <component><section>
      <title>Active Problems</title>
      <text>Problem Noted Date Diagnosed Date h/o Right ankle fracture 10/29/2025 10/29/2025 documented by Orthopedics</text>
    </section></component>
    <component><section>
      <title>Visit Diagnoses</title>
      <text>Diagnosis Start Date Chest pain, unspecified type 03/10/2026 Abnormal EKG 03/11/2026</text>
    </section></component>
    <component><section>
      <title>Medications</title>
      <text>Medication Sig acetaminophen (TYLENOL) 325 mg tablet Take 3 tablets by mouth every 8 hours documented 03/10/2026</text>
    </section></component>
    <component><section>
      <title>Social History</title>
      <text>Smoking Tobacco: Never Smokeless Tobacco: Never Legal Sex Male</text>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`);
  return dir;
}

test("extractCcdaHealthData parses MyChart CCDA vitals and clinical facts", () => {
  const dir = writeFixture();
  try {
    const extracted = repo.extractCcdaHealthData(dir);
    assert.equal(extracted.files, 1);
    assert.equal(extracted.vitals_panels.length, 1);
    assert.equal(extracted.blood_pressure_readings.length, 1);
    assert.equal(extracted.blood_pressure_readings[0].systolic, 125);
    assert.equal(extracted.blood_pressure_readings[0].diastolic, 78);
    assert.equal(extracted.blood_pressure_readings[0].pulse, 73);
    const markerNames = extracted.vitals_panels[0].markers.map((m) => m.name);
    assert.deepEqual(markerNames, ["Systolic BP", "Diastolic BP", "Pulse", "Temperature", "Oxygen Saturation", "Respiratory Rate"]);
    const factNames = extracted.clinical_facts.map((f) => f.name);
    assert.ok(factNames.includes("No known active allergies"));
    assert.ok(factNames.includes("h/o Right ankle fracture"));
    assert.ok(factNames.includes("acetaminophen (TYLENOL) 325 mg tablet"));
    assert.ok(factNames.includes("Smoking tobacco: Never"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});

test("applyCcdaHealthBackfill preserves existing split lab panels and is BP-idempotent", () => {
  resetTables("health_documents", "blood_pressure_readings");
  const dir = writeFixture();
  try {
    const source = repo.addHealthDocument({
      kind: "bloodwork",
      doc_date: "2026-03-10",
      original_name: "health_summary_milos_mychart.zip",
      parsed_json: { markers: [{ name: "LDL-C", value: 102, unit: "mg/dL" }] },
      enrichment_status: "done",
    });
    repo.replaceHealthPanels(source.id, [
      {
        doc_date: "2025-10-29",
        kind: "bloodwork",
        markers: [{ name: "HbA1c", value: 5.4, unit: "%" }],
        type: "bloodwork",
      },
    ], "health_summary_milos_mychart.zip");

    const extracted = repo.extractCcdaHealthData(dir);
    const first = repo.applyCcdaHealthBackfill(source.id, extracted);
    const second = repo.applyCcdaHealthBackfill(source.id, extracted);

    assert.equal(first.vitalsPanels, 1);
    assert.equal(first.bpReadings, 1);
    assert.equal(second.bpReadings, 0);
    assert.equal(repo.listBloodPressureReadings().length, 1);

    const rows = db.prepare(`SELECT * FROM health_documents WHERE source_doc_id = ? ORDER BY id`).all(source.id);
    const parsedRows = rows.map((r) => JSON.parse(r.parsed_json));
    assert.ok(parsedRows.some((p) => p.type === "bloodwork" && p.markers.some((m) => m.name === "HbA1c")));
    assert.ok(parsedRows.some((p) => p.type === repo.CCDA_VITALS_TYPE && p.markers.some((m) => m.name === "Systolic BP")));

    const updated = repo.getHealthDocument(source.id);
    const sourceFacts = updated.parsed.clinical_facts.map((f) => f.name);
    assert.ok(sourceFacts.includes("No known active allergies"));
    assert.ok(sourceFacts.includes("h/o Right ankle fracture"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});
