// Clinician-facing health report (src/report.ts) — the doctor-ready, print-to-PDF
// HTML document + its plain-text twin (for pasting into a MyChart message), built
// over the SAME marker history as buildHealthExport. The invariants that matter:
//   - markers group into clinical panels in canonical order, with full dated history
//   - "findings to discuss" = every marker the lab flagged H/L OR that sits outside
//     a TRUSTED optimal target (the lab's own flag is authoritative either way)
//   - the optimal-zone matcher's substring over-match (a composite/qualitative name
//     grabbing an unrelated band) is suppressed on this doc — a false target reads
//     as an error to a physician
//   - the constitution invariant: no 0-100 score (impact_score) leaks into either render
//   - all document-sourced strings are HTML-escaped in the HTML render
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";
import {
  buildClinicalReportData,
  renderClinicalReportHTML,
  renderClinicalReportText,
} from "../dist/report.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "supplements", "profile");
});

test("buildClinicalReportData groups markers into clinical panels with dated history", () => {
  seedHealthDoc("2022-01-01", [marker("ApoB", 90, { unit: "mg/dL", flag: "normal" })]);
  seedHealthDoc("2024-06-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2024-06-01", [marker("Hemoglobin", 14, { unit: "g/dL", flag: "normal" })]);
  const data = buildClinicalReportData();

  const lipids = data.groups.find((g) => g.label === "Lipids & Cardiovascular");
  assert.ok(lipids, "a Lipids & Cardiovascular panel is present");
  const apob = lipids.markers.find((m) => m.name === "ApoB");
  assert.ok(apob, "ApoB lands in the lipids panel");
  assert.equal(apob.value, 120, "latest value");
  assert.equal(apob.flag, "high");
  assert.equal(apob.history.length, 2, "full dated history carried");
  assert.deepEqual(apob.history.map((h) => h.value), [90, 120]);
  assert.equal(data.dateRange.from, "2022-01-01");
  assert.equal(data.dateRange.to, "2024-06-01");
});

test("findings = lab-flagged OR outside a trusted optimal target, in priority order", () => {
  // Lab-flagged low (authoritative), an out-of-optimal-but-lab-normal LDL, and a clean marker.
  seedHealthDoc("2025-12-01", [
    marker("25-OH Vitamin D", 18, { unit: "ng/mL", flag: "low" }),
    marker("LDL-C (direct)", 160, { unit: "mg/dL", flag: "normal" }), // optimal ≤100 → off target
    marker("Hematocrit", 44, { unit: "%", flag: "normal" }), // in range, no optimal trap → not a finding
  ]);
  const data = buildClinicalReportData();
  const names = data.findings.map((f) => f.name);
  assert.ok(names.includes("25-OH Vitamin D"), "lab-flagged low is a finding");
  assert.ok(names.includes("LDL-C (direct)"), "out-of-optimal but lab-normal is a finding");
  assert.ok(!names.includes("Hematocrit"), "an in-range marker with no concern is not a finding");
  const vd = data.findings.find((f) => f.name === "25-OH Vitamin D");
  assert.equal(vd.flag, "low");
  assert.equal(vd.optimalText, "≥ 40", "optimal target rendered as a 'higher is better' phrase");
});

test("optimal-zone over-match is suppressed (composite / qualitative names)", () => {
  seedHealthDoc("2025-12-01", [
    marker("Total Cholesterol / HDL Ratio", 5.2, { flag: "high" }), // must NOT grab HDL's ≥50 band
    marker("LDL Pattern", "A", {}), // qualitative — must NOT grab LDL's ≤100 band
    marker("Albumin, Random Urine", 0.2, { unit: "mg/dL" }), // must NOT grab serum creatinine's band
  ]);
  const data = buildClinicalReportData();
  const ratio = data.groups.flatMap((g) => g.markers).find((m) => m.name.includes("Ratio"));
  const pattern = data.groups.flatMap((g) => g.markers).find((m) => m.name === "LDL Pattern");
  const urine = data.groups.flatMap((g) => g.markers).find((m) => m.name.includes("Urine"));
  assert.equal(ratio.optimal, null, "ratio gets no optimal band");
  assert.equal(ratio.optimalText, null);
  assert.equal(pattern.optimal, null, "qualitative pattern gets no optimal band");
  assert.equal(urine.optimal, null, "urine marker doesn't inherit a serum band");
  // The lab flag itself is untouched — the ratio is still a finding because the lab flagged it.
  assert.ok(data.findings.some((f) => f.name.includes("Ratio") && f.flag === "high"));
});

test("renders no 0-100 score and escapes document-sourced strings (HTML)", () => {
  seedHealthDoc("2025-12-01", [marker("LDL <script> & \"evil\"", 130, { unit: "mg/dL", flag: "high" })]);
  const data = buildClinicalReportData();
  const html = renderClinicalReportHTML(data, { name: "Ann <b>O'Neil</b>" });
  const text = renderClinicalReportText(data, { name: "Ann O'Neil" });
  assert.ok(!html.includes("impact_score") && !text.includes("impact_score"), "no internal score leaks");
  assert.ok(!html.includes("<script> &"), "raw marker name is not injected unescaped");
  assert.ok(html.includes("&lt;script&gt;"), "marker name is HTML-escaped");
  assert.ok(html.includes("&lt;b&gt;O&#39;Neil") || html.includes("Ann &lt;b&gt;"), "patient name is escaped");
  // The optimal-target footnote framing is present and clearly preventive (not a lab range).
  assert.ok(/optimal target/i.test(html), "the report labels the optimal-target column");
  assert.ok(/not medical advice/i.test(html) && /not medical advice/i.test(text), "disclaimer present on both renders");
});

test("plain-text twin carries findings + a copy-ready structure", () => {
  seedHealthDoc("2025-12-01", [marker("Lipoprotein (a)", 130, { unit: "nmol/L", flag: "high" })]);
  const text = renderClinicalReportText(buildClinicalReportData(), { name: "Pat Doe" });
  assert.ok(text.startsWith("HEALTH SUMMARY — Pat Doe"), "named header");
  assert.ok(text.includes("FINDINGS TO DISCUSS"), "findings section present");
  assert.ok(/Lipoprotein \(a\).*130.*High/.test(text), "the flagged marker is listed in findings");
});

test("lipid report reads in clinician order and keeps direct LDL clearly separate", () => {
  seedHealthDoc("2024-04-17", [
    marker("LDL-C (direct)", 175, { unit: "mg/dL", flag: "normal" }),
    marker("Total Cholesterol", 251, { unit: "mg/dL", flag: "high" }),
    marker("HDL-Cholesterol", 49, { unit: "mg/dL", flag: "normal" }),
    marker("Triglycerides", 229, { unit: "mg/dL", flag: "high" }),
  ]);
  seedHealthDoc("2026-06-11", [
    marker("Apolipoprotein B (ApoB)", 148, { unit: "mg/dL", flag: "high" }),
    marker("LDL-Cholesterol", 207, { unit: "mg/dL", flag: "high" }),
    marker("Non-HDL Cholesterol", 234, { unit: "mg/dL", flag: "high" }),
    marker("Lipoprotein (a)", 127, { unit: "nmol/L", flag: "high" }),
    marker("LDL Particle Number", 2136, { unit: "nmol/L", flag: "high" }),
    marker("LDL Peak Size", 217.9, { unit: "Angstrom", flag: "low" }),
    marker("LDL Small", 573, { unit: "nmol/L", flag: "high" }),
  ]);

  const data = buildClinicalReportData();
  const lipids = data.groups.find((g) => g.key === "lipids");
  assert.ok(lipids, "lipid panel present");
  const names = lipids.markers.map((m) => m.name);
  assert.deepEqual(names.slice(0, 7), [
    "Total Cholesterol",
    "LDL-Cholesterol",
    "LDL-C (direct)",
    "HDL-Cholesterol",
    "Non-HDL Cholesterol",
    "Triglycerides",
    "Apolipoprotein B (ApoB)",
  ]);
  assert.ok(names.indexOf("LDL Particle Number") < names.indexOf("LDL Small"), "LDL-P comes before subfractions");
  assert.ok(names.indexOf("LDL Small") < names.indexOf("LDL Peak Size"), "subfractions come before peak-size detail");

  const standard = lipids.markers.find((m) => m.name === "LDL-Cholesterol");
  const direct = lipids.markers.find((m) => m.name === "LDL-C (direct)");
  assert.match(standard.methodNote, /standard lipid-panel LDL-C/i);
  assert.match(direct.methodNote, /Direct LDL-C assay/i);

  const html = renderClinicalReportHTML(data, {});
  const text = renderClinicalReportText(data, {});
  assert.ok(html.includes("Findings by panel"), "HTML groups the top findings by panel");
  assert.ok(html.includes("Standard lipid panel"), "lipid rows are subheaded like a familiar panel");
  assert.ok(html.includes("LDL-C rows are separated by assay/source method"), "HTML explains the two LDL rows");
  assert.ok(html.includes("as of Jun '26") && html.includes("as of Apr '24"), "latest dates sit next to the result values");
  assert.ok(text.includes("Note: LDL-C rows are separated by assay/source method"), "text twin carries the same LDL note");
});

test("the profile name is stamped on the report; an explicit name overrides it", () => {
  repo.setProfile({ name: "Sam Carter" });
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  const data = buildClinicalReportData();
  assert.equal(data.subject.name, "Sam Carter", "the profile name rides on the report data");
  // No ?name= override → the profile name fills the header on both renders.
  assert.ok(renderClinicalReportText(data, {}).startsWith("HEALTH SUMMARY — Sam Carter"), "text twin stamps the profile name");
  assert.ok(renderClinicalReportHTML(data, {}).includes("Sam Carter"), "HTML stamps the profile name");
  // An explicit ?name= still wins (fill-in-on-paper / different patient).
  assert.ok(renderClinicalReportText(data, { name: "Other Name" }).startsWith("HEALTH SUMMARY — Other Name"), "explicit name overrides the profile");
});

test("empty health history yields a calm, valid report (no throw)", () => {
  const data = buildClinicalReportData();
  assert.deepEqual(data.groups, []);
  assert.deepEqual(data.findings, []);
  assert.equal(data.dateRange, null);
  const html = renderClinicalReportHTML(data, {});
  assert.ok(html.includes("No markers fall outside"), "calm empty findings state");
  assert.ok(html.startsWith("<!doctype html>"), "still a full document");
});
