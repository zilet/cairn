// health.ts plausibleMarkerValue — the conservative numeric/unit guard at lab
// ingest. It rejects ONLY clear physiologic impossibilities (a transcription typo,
// a unit mix-up, a negative) using generous per-analyte ceilings, so a real-but-
// unusual value is never dropped — and it's wired into insertHealthPanels so a
// poison value never reaches the connected brain's directives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

test("accepts real values across families (incl. disease extremes)", () => {
  assert.equal(repo.plausibleMarkerValue("ApoB", 95, "mg/dL").plausible, true);
  assert.equal(repo.plausibleMarkerValue("Fasting glucose", 92, "mg/dL").plausible, true);
  assert.equal(repo.plausibleMarkerValue("LDL Cholesterol", 3.2, "mmol/L").plausible, true); // converts ~124 mg/dL
  assert.equal(repo.plausibleMarkerValue("Ferritin", 18000, "ng/mL").plausible, true);       // hemochromatosis extreme, real
  assert.equal(repo.plausibleMarkerValue("Triglycerides", 4000, "mg/dL").plausible, true);    // severe HTG, real
  assert.equal(repo.plausibleMarkerValue("Systolic BP", 144, "mmHg").plausible, true);
});

test("rejects a transcription-typo magnitude (glucose 5000 mg/dL)", () => {
  const g = repo.plausibleMarkerValue("Glucose", 5000, "mg/dL");
  assert.equal(g.plausible, false);
  assert.match(g.reason, /exceeds|unit|transcription/i);
  assert.equal(g.value, 5000);
});

test("catches a unit mix-up (a mmol/L value held against a mg/dL band)", () => {
  // 200 "mmol/L" LDL converts to ~7700 mg/dL — physiologically impossible.
  const ldl = repo.plausibleMarkerValue("LDL Cholesterol", 200, "mmol/L");
  assert.equal(ldl.plausible, false);
});

test("rejects a negative where impossible", () => {
  const a = repo.plausibleMarkerValue("ApoB", -10, "mg/dL");
  assert.equal(a.plausible, false);
  assert.match(a.reason, /negative/i);
});

test("is conservative: unknown families + qualitative values pass untouched", () => {
  assert.equal(repo.plausibleMarkerValue("Some Novel Marker", 999999, "x").plausible, true);
  assert.equal(repo.plausibleMarkerValue("Urine Color", "Yellow").plausible, true);
  assert.equal(repo.plausibleMarkerValue("ABO Group", "O").plausible, true);
  assert.equal(repo.plausibleMarkerValue("ApoB", "", "mg/dL").plausible, true); // empty/non-numeric not judged
});

test("does not magnitude-judge an unconvertible unit (Lp(a) mg/dL vs nmol/L)", () => {
  // Lp(a)'s band is nmol/L; mg/dL can't be safely converted, so only sign is judged.
  assert.equal(repo.plausibleMarkerValue("Lp(a)", 45, "mg/dL").plausible, true);
});

test("insertHealthPanels drops an implausible reading but keeps the rest of the panel", () => {
  resetTables("health_documents");
  const source = repo.addHealthDocument({ kind: "bloodwork", doc_date: "2026-06-11", enrichment_status: "done" });
  const created = repo.replaceHealthPanels(source.id, [{
    doc_date: "2026-06-11", kind: "bloodwork", summary: "panel",
    markers: [
      { name: "ApoB", value: 95, unit: "mg/dL", flag: "normal" },
      { name: "Fasting Glucose", value: 5000, unit: "mg/dL", flag: "high" }, // typo — must be skipped
      { name: "Ferritin", value: 60, unit: "ng/mL", flag: "normal" },
    ],
  }]);
  const names = created[0].parsed.markers.map((m) => m.name);
  assert.ok(names.includes("ApoB") && names.includes("Ferritin"), "the plausible markers survive");
  assert.ok(!names.includes("Fasting Glucose"), "the 5000 mg/dL glucose typo is dropped");
});

test("a dropped implausible value never reaches the connected brain's directives", () => {
  resetTables("health_documents", "health_directives");
  const source = repo.addHealthDocument({ kind: "bloodwork", doc_date: "2026-06-11", enrichment_status: "done" });
  repo.replaceHealthPanels(source.id, [{
    doc_date: "2026-06-11", kind: "bloodwork",
    markers: [{ name: "Fasting Glucose", value: 5000, unit: "mg/dL", flag: "high" }],
  }]);
  repo.deriveDirectives();
  const glucoseDirectives = repo.listActiveDirectives().filter((d) => /glucose/i.test(d.marker || ""));
  assert.equal(glucoseDirectives.length, 0, "the impossible glucose can't propagate a directive");
});
