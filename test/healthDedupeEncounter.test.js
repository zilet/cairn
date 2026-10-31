// One clinic encounter, filed by two exports, is one record — and a duplicate is
// caught the moment a record is added, or once at boot when the rules improve.
// Two MyChart exports of the same visit carry the same vitals rows (one export
// may keep only one vital of six); their readings alone are too few to prove a
// draw, but the encounter time each export states is the same to the minute.
// Every value here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, repo } from "./_seed.js";
import {
  DEDUPE_RULES_VERSION_KEY,
  runDedupeRulesUpgradeIfDue,
  settleNewHealthRecords,
} from "../dist/domain/health/record-dedupe.js";
import { DEDUPE_RULES_VERSION, encounterStamp } from "../dist/repo/health-dedupe.js";

const v = (name, value, unit = null) => ({ name, value, unit, flag: null });

function exportRow(createdAt) {
  const row = repo.addHealthDocument({ kind: "other", original_name: "export.zip", enrichment_status: "done" });
  db.prepare("UPDATE health_documents SET created_at = ? WHERE id = ?").run(createdAt, row.id);
  return row.id;
}

function vitals(sourceId, { date = "2026-03-10", at = "15:52", markers, stored = false }) {
  return repo.addHealthDocument({
    kind: "vitals",
    doc_date: date,
    source_doc_id: sourceId,
    enrichment_status: "done",
    summary: `MyChart vitals recorded ${date} ${at}`,
    parsed_json: { type: "ccda_vitals", markers, ...(stored ? { recorded_at: `${date} ${at}` } : {}) },
  }).id;
}

function parsedOf(id) {
  const row = db.prepare("SELECT parsed_json FROM health_documents WHERE id = ?").get(id);
  return row ? JSON.parse(row.parsed_json) : null;
}
const exists = (id) => !!db.prepare("SELECT 1 FROM health_documents WHERE id = ?").get(id);

const SHEET = [
  v("Systolic BP", 128, "mmHg"),
  v("Diastolic BP", 79, "mmHg"),
  v("Pulse", 71, "bpm"),
  v("Temperature", 36.6, "deg C"),
  v("Oxygen Saturation", 97, "%"),
  v("Respiratory Rate", 16, "breaths/min"),
];

test("the encounter time reads from the stored field, else the summary the CCDA pass always wrote", () => {
  assert.equal(encounterStamp({ parsed: { recorded_at: "2026-03-10 15:52" } }), "2026-03-10 15:52");
  assert.equal(encounterStamp({ parsed: {}, summary: "MyChart vitals recorded 2026-03-10 15:52" }), "2026-03-10 15:52");
  assert.equal(encounterStamp({ parsed: {}, summary: "Lipid panel" }), null);
});

test("two exports of one visit fold even when one kept a single vital: the fuller sheet survives", () => {
  const older = exportRow("2026-03-20 09:00:00");
  const newer = exportRow("2026-06-01 09:00:00");
  const full = vitals(older, { markers: SHEET });
  const thin = vitals(newer, { markers: [v("Respiratory Rate", 16, "breaths/min")], stored: true });

  const result = settleNewHealthRecords(newer);
  assert.equal(result.merged, 1);
  assert.equal(result.clusters[0].rule, "same_encounter");
  assert.match(result.clusters[0].reason, /same clinic visit \(2026-03-10 15:52\)/);
  assert.ok(exists(full) && !exists(thin), "the six-reading sheet is the survivor");
  assert.equal(parsedOf(full).markers.length, 6);
  assert.equal(parsedOf(full).superseded_readings, undefined, "nothing disagreed, nothing superseded");
});

test("where two exports of one visit disagree the later export's reading stands, and the replaced one is kept", () => {
  const older = exportRow("2026-01-05 09:00:00");
  const newer = exportRow("2026-05-05 09:00:00");
  const first = vitals(older, { date: "2025-10-29", at: "10:00", markers: [v("BMI", 29.1)] });
  const second = vitals(newer, { date: "2025-10-29", at: "10:00", markers: [v("BMI", 27.2)], stored: true });

  const result = repo.dedupeHealthDocuments({});
  assert.equal(result.merged, 1);
  // same size, so the older row keeps its id (the survivor ranking is unchanged)...
  assert.ok(exists(first) && !exists(second));
  // ...but it now carries the later export's value, and remembers the one it replaced
  const parsed = parsedOf(first);
  assert.deepEqual(
    parsed.markers.map((m) => m.value),
    [27.2]
  );
  assert.deepEqual(parsed.superseded_readings, [
    { name: "BMI", value: 29.1, unit: null, from_doc_id: first, replaced_by_doc_id: second, from_source_doc_id: older },
  ]);
  assert.deepEqual(
    result.clusters[0].superseded.map((s) => s.value),
    [29.1]
  );
  assert.match(result.clusters[0].reason, /later export's reading is kept/);
});

test("an earlier export arriving after the later one never overwrites the later reading", () => {
  const later = exportRow("2026-05-05 09:00:00");
  const earlier = exportRow("2026-01-05 09:00:00");
  const kept = vitals(later, { date: "2025-10-29", at: "10:00", markers: [v("BMI", 27.2), v("Weight", 180, "lb")] });
  const stale = vitals(earlier, { date: "2025-10-29", at: "10:00", markers: [v("BMI", 29.1)] });
  repo.dedupeHealthDocuments({});
  assert.ok(exists(kept) && !exists(stale));
  const parsed = parsedOf(kept);
  assert.equal(parsed.markers.find((m) => m.name === "BMI").value, 27.2);
  assert.deepEqual(parsed.superseded_readings, [
    { name: "BMI", value: 29.1, unit: null, from_doc_id: stale, replaced_by_doc_id: kept, from_source_doc_id: earlier },
  ]);
});

test("different encounter times, one export, or an agent's read are never one encounter", () => {
  const a = exportRow("2026-01-05 09:00:00");
  const b = exportRow("2026-05-05 09:00:00");
  // two visits on one day
  vitals(a, { at: "09:15", markers: [v("BMI", 27.2)] });
  vitals(b, { at: "15:52", markers: [v("BMI", 27.2)] });
  // two rows of ONE export
  vitals(a, { date: "2026-04-01", at: "08:00", markers: [v("Pulse", 70, "bpm")] });
  vitals(a, { date: "2026-04-01", at: "08:00", markers: [v("Pulse", 70, "bpm")] });
  // agent reads (no CCDA type) with the same summary
  for (const source of [a, b]) {
    repo.addHealthDocument({
      kind: "vitals",
      doc_date: "2026-04-02",
      source_doc_id: source,
      enrichment_status: "done",
      summary: "MyChart vitals recorded 2026-04-02 11:00",
      parsed_json: { markers: [v("Weight", 180, "lb")] },
    });
  }
  const before = db.prepare("SELECT COUNT(*) AS n FROM health_documents").get().n;
  assert.equal(repo.dedupeHealthDocuments({}).merged, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_documents").get().n, before);
});

test("the CCDA pass stores the encounter time, and the second export folds at ingest", () => {
  const xml = (lines) => `<?xml version="1.0"?>
<ClinicalDocument><component><structuredBody><component><section>
  <title>Last Filed Vital Signs</title>
  <text>${lines}</text>
</section></component></structuredBody></component></ClinicalDocument>`;
  const write = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-encounter-"));
    fs.writeFileSync(path.join(dir, "DOC0001.XML"), xml(body));
    return dir;
  };
  const fullDir = write(
    "Blood Pressure 128 / 79 03/10/2026 03:52 PM EDT Pulse 71 03/10/2026 03:52 PM EDT Respiratory Rate 16 03/10/2026 03:52 PM EDT"
  );
  const thinDir = write("Respiratory Rate 16 03/10/2026 03:52 PM EDT");
  try {
    const first = exportRow("2026-03-20 09:00:00");
    const second = exportRow("2026-06-01 09:00:00");
    const firstRead = repo.extractCcdaHealthData(fullDir);
    assert.equal(firstRead.vitals_panels[0].recorded_at, "2026-03-10 15:52");
    repo.applyCcdaHealthBackfill(first, firstRead);
    settleNewHealthRecords(first);
    repo.applyCcdaHealthBackfill(second, repo.extractCcdaHealthData(thinDir));
    const derived = db.prepare("SELECT id, parsed_json FROM health_documents WHERE source_doc_id = ?").all(second);
    assert.equal(JSON.parse(derived[0].parsed_json).recorded_at, "2026-03-10 15:52");
    const folded = settleNewHealthRecords(second);
    assert.equal(folded.merged, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_documents WHERE source_doc_id = ?").get(second).n, 0);
  } finally {
    fs.rmSync(fullDir, { recursive: true, force: true });
    fs.rmSync(thinDir, { recursive: true, force: true });
  }
});

test("a record added straight to the set (chat, MCP) folds into the panel already on file", () => {
  const onFile = repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    enrichment_status: "done",
    parsed_json: { markers: [v("LDL-C", 112, "mg/dL"), v("HDL-C", 58, "mg/dL"), v("Triglycerides", 90, "mg/dL")] },
  }).id;
  const pasted = repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-02-02",
    enrichment_status: "done",
    parsed_json: { markers: [v("LDL Cholesterol", 112, "mg/dL"), v("HDL Cholesterol", 58, "mg/dL")] },
  }).id;
  const result = settleNewHealthRecords(pasted);
  assert.equal(result.merged, 1);
  assert.ok(exists(onFile) && !exists(pasted));
});

test("a better rules version folds the old twins once at boot, then never again", () => {
  repo.setAppState(DEDUPE_RULES_VERSION_KEY, String(DEDUPE_RULES_VERSION - 1));
  const older = exportRow("2026-01-05 09:00:00");
  const newer = exportRow("2026-05-05 09:00:00");
  const first = vitals(older, { markers: SHEET });
  const second = vitals(newer, { markers: [v("Respiratory Rate", 16, "breaths/min")] });

  const boot = runDedupeRulesUpgradeIfDue();
  assert.equal(boot.ran, true);
  assert.equal(boot.result.merged, 1);
  assert.ok(exists(first) && !exists(second));
  assert.equal(repo.getAppState(DEDUPE_RULES_VERSION_KEY), String(DEDUPE_RULES_VERSION));

  // a twin filed afterwards is the ingest chokepoint's job, not a recurring sweep
  vitals(exportRow("2026-07-01 09:00:00"), { markers: [v("Pulse", 71, "bpm")] });
  assert.deepEqual(runDedupeRulesUpgradeIfDue(), { ran: false });
});
