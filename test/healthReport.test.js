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
import { test, beforeEach, afterEach, mock as testMock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { repo, resetTables, seedHealthDoc, marker, localDaysAgo } from "./_seed.js";
import {
  buildClinicalReportData,
  reportScriptCspHash,
  renderClinicalReportHTML,
  renderClinicalReportText,
} from "../dist/report.js";
import { formatReportDate } from "../dist/reportDates.js";
import { runWithTimeZone } from "../dist/tz.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "supplements", "profile", "bodyweight_log", "body_measurements", "daily_metrics");
});

afterEach(() => {
  testMock.timers.reset();
});

test("buildClinicalReportData groups markers into clinical panels with dated history", () => {
  seedHealthDoc("2022-01-01", [marker("ApoB", 90, { unit: "mg/dL", flag: "normal" })]);
  seedHealthDoc("2024-06-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2024-06-01", [marker("Hemoglobin", 14, { unit: "g/dL", flag: "normal" })]);
  const data = buildClinicalReportData();

  const lipids = data.groups.find((g) => g.label === "Lipids & Cardiovascular");
  assert.ok(lipids, "a Lipids & Cardiovascular panel is present");
  const apob = lipids.markers.find((m) => m.name === "Apolipoprotein B (ApoB)");
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
  seedHealthDoc(localDaysAgo(30), [
    marker("25-OH Vitamin D", 18, { unit: "ng/mL", flag: "low" }),
    marker("LDL-C (direct)", 160, { unit: "mg/dL", flag: "normal" }), // optimal ≤100 → off target
    marker("Hematocrit", 44, { unit: "%", flag: "normal" }), // in range, no optimal trap → not a finding
  ]);
  const data = buildClinicalReportData();
  const names = data.findings.map((f) => f.name);
  assert.ok(names.includes("25-OH Vitamin D"), "lab-flagged low is a finding");
  assert.ok(names.includes("LDL-C (Direct)"), "out-of-optimal but lab-normal is a finding");
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
  // The target/reference footnote distinguishes optimal bands from lab ranges/context.
  assert.ok(/Target \/ reference/i.test(html), "the report labels the target/reference column");
  assert.ok(/optimal.*bands/i.test(html) && /source lab/i.test(html), "the report distinguishes optimal bands from source ranges");
  assert.ok(/not medical advice/i.test(html) && /not medical advice/i.test(text), "disclaimer present on both renders");
  assert.ok(html.includes('class="actionbar no-print"'), "text/PDF export actions live in a sticky bottom action bar");
  assert.ok(html.includes("Copy text for MyChart"), "plain-text doctor copy is directly reachable");
  assert.ok(!/https:\/\/fonts\.(?:googleapis|gstatic)\.com/.test(html), "doctor report is self-contained and makes no third-party font requests");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "report has no inline event-handler attributes");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "report export controls keep their self-contained script");
  const hash = `'sha256-${crypto.createHash("sha256").update(script).digest("base64")}'`;
  assert.equal(reportScriptCspHash(), hash, "report CSP hash matches the rendered inline script exactly");
});

test("plain-text twin carries findings + a copy-ready structure", () => {
  seedHealthDoc("2025-12-01", [marker("Lipoprotein (a)", 130, { unit: "nmol/L", flag: "high" })]);
  const text = renderClinicalReportText(buildClinicalReportData(), { name: "Pat Doe" });
  assert.ok(text.startsWith("HEALTH SUMMARY — Pat Doe"), "named header");
  assert.ok(text.includes("FINDINGS TO DISCUSS"), "findings section present");
  assert.ok(/Lipoprotein \(a\).*130.*High/.test(text), "the flagged marker is listed in findings");
});

test("generated date uses the active local timezone, not UTC", () => {
  testMock.timers.enable({ apis: ["Date"], now: new Date("2026-07-07T01:06:29Z") });
  const data = runWithTimeZone("America/New_York", () => buildClinicalReportData());
  assert.equal(data.generated, "2026-07-06", "9:06 PM New York stays Jul 6 even though UTC is Jul 7");
  assert.equal(runWithTimeZone("America/New_York", () => formatReportDate("2026-07-07T01:06:29Z")), "Jul 6, 2026");
  const text = renderClinicalReportText(data);
  assert.match(text, /Generated Jul 6, 2026/);
  assert.doesNotMatch(text, /Generated Jul 7, 2026/);
});

test("future-dated readings are clamped to the local generated day in report rendering", () => {
  testMock.timers.enable({ apis: ["Date"], now: new Date("2026-07-07T01:06:29Z") });
  seedHealthDoc("2026-07-07", [marker("VO2max", 41.9, { unit: "mL/kg/min" })]);

  const data = runWithTimeZone("America/New_York", () => buildClinicalReportData());
  assert.equal(data.generated, "2026-07-06");
  assert.deepEqual(data.dateRange, { from: "2026-07-06", to: "2026-07-06" });
  const vo2 = data.groups.flatMap((g) => g.markers).find((m) => m.name === "VO2max");
  assert.equal(vo2?.latestDate, "2026-07-06");
  assert.deepEqual(vo2?.history.map((h) => h.date), ["2026-07-06"]);

  const text = renderClinicalReportText(data);
  assert.match(text, /Readings Jul 6, 2026 – Jul 6, 2026/);
  assert.doesNotMatch(text, /Jul 7, 2026|Jul 7 '26/);
});

test("findings include dates and tape body composition wins over DEXA projection", () => {
  repo.setProfile({ age: 44, sex: "male", height_cm: 170, weight_lb: 175.5 });
  const scanDate = localDaysAgo(30);
  const tapeDate = localDaysAgo(4);
  const today = localDaysAgo(0);
  seedHealthDoc(scanDate, [
    marker("Body Fat %", 35.6, { unit: "%", flag: "high" }),
    marker("Lean Mass (Total)", 112.6, { unit: "lbs", flag: "low" }),
    marker("Bone Mineral Content (BMC)", 6.1, { unit: "lbs" }),
    marker("Fat Mass (Total)", 65.6, { unit: "lbs", flag: "high" }),
    marker("Visceral Fat", 1.13, { unit: "lbs", flag: "high" }),
    marker("Total Mass", 184.3, { unit: "lbs", flag: "high" }),
  ], "dexa");
  seedHealthDoc("2025-10-29", [marker("Body Mass Index", 29.1, { unit: "kg/m2" })], "other");
  repo.logWeight(184.3, scanDate);
  repo.logWeight(176.5, tapeDate);
  repo.logWeight(175.5, today);
  repo.addBodyMeasurement(tapeDate, { waist_in: 38, neck_in: 15, hip_in: 42, chest_in: 42 });

  const data = buildClinicalReportData();
  const body = data.groups.find((g) => g.key === "body");
  assert.ok(body, "body composition group present");
  const bf = body.markers.find((m) => /Body Fat/.test(m.name) && m.unit === "%");
  const fatMass = body.markers.find((m) => /Fat Mass/.test(m.name));
  const leanMass = body.markers.find((m) => /Lean Mass/.test(m.name));
  const visceral = body.markers.find((m) => /Visceral Fat/.test(m.name));
  const weight = body.markers.find((m) => m.name === "Body Weight");
  const bmi = body.markers.find((m) => /^(BMI|Body Mass Index)$/i.test(m.name));
  assert.ok(weight, "DEXA total mass is presented as current body weight when a newer logged weight exists");
  assert.equal(weight.value, 175.5);
  assert.equal(weight.latestDate, today);
  assert.equal(weight.flag, null, "body weight does not inherit a DEXA high flag");
  assert.equal(weight.abnormal, false);
  assert.deepEqual(weight.history.map((h) => [h.value, h.date, h.flag]), [[184.3, scanDate, null], [176.5, tapeDate, null], [175.5, today, null]]);
  assert.match(String(weight.methodNote), /dated DEXA\/source body weight readings are kept in history/);
  assert.ok(bmi?.estimated, "BMI is recalculated from current logged weight and profile height");
  assert.equal(bmi.latestDate, today);
  assert.equal(bmi.dateLabel, "calc. as of");
  assert.ok(Number(bmi.value) > 27.4 && Number(bmi.value) < 27.7, `expected current BMI ~27.5, got ${bmi.value}`);
  assert.equal(bmi.referenceSource, "CDC Adult BMI Categories");
  assert.equal(bmi.abnormal, false, "BMI context does not become a headline lab finding");
  assert.match(String(bmi.methodNote), /screening measure/);
  assert.ok(bf?.estimated, "body-fat row is an estimate");
  assert.equal(bf.dateLabel, "tape est.");
  assert.ok(Number(bf.value) > 25.5 && Number(bf.value) < 26.5, `expected ~26%, got ${bf.value}`);
  assert.equal(bf.latestDate, tapeDate, "body-fat date is the tape measurement date");
  assert.match(String(bf.methodNote), /Tape-based Navy body-fat estimate/);
  assert.match(String(bf.methodNote), /DEXA measured 35\.6%/);
  assert.equal(bf.flag, null, "a tape estimate does not inherit the DEXA lab flag");
  assert.equal(bf.inOptimal, false, "the estimate can still be outside the optimal band");
  assert.ok(fatMass?.estimated, "fat-mass row is derived from tape plus current weight");
  assert.ok(Number(fatMass.value) > 45 && Number(fatMass.value) < 46.2, `expected ~45.6 lb, got ${fatMass.value}`);
  assert.equal(fatMass.latestDate, today, "fat-mass date follows the current weight used");
  assert.equal(fatMass.abnormal, false, "derived fat mass does not inherit the DEXA high flag");
  assert.ok(!data.findings.some((f) => f.name === fatMass.name), "derived fat mass is supporting context, not a headline finding without a target");
  assert.equal(leanMass?.abnormal, true, "DEXA lean mass still carries the source flag in the dated panel");
  assert.equal(leanMass?.findingSuppressed, true, "total DEXA lean mass is not promoted as a headline finding");
  assert.match(String(leanMass?.methodNote), /not a direct muscle\/function diagnosis/);
  assert.equal(visceral?.findingSuppressed, true, "DEXA visceral-fat submetric is supporting body-comp context");
  assert.ok(!data.findings.some((f) => /Lean Mass|Visceral Fat/.test(f.name)), "DEXA support-only rows stay out of top findings");
  assert.ok(!data.findings.some((f) => f.name === "Body Weight" || f.name === "BMI"), "weight/BMI context stays out of top findings");

  const html = renderClinicalReportHTML(data, {});
  const text = renderClinicalReportText(data, {});
  const findingsHtml = html.slice(html.indexOf('<section class="findings'), html.indexOf('<div class="cap bodycomp"'));
  assert.doesNotMatch(findingsHtml, /Lean Mass|Visceral Fat/, "findings box omits DEXA support-only rows");
  assert.ok(html.includes("tape est."), "HTML findings/results label the tape estimate");
  assert.ok(html.includes("est. as of"), "HTML labels the current-weight fat-mass estimate");
  assert.ok(html.includes("DEXA"), "HTML keeps the DEXA anchor visible");
  assert.match(html, /DEXA lean mass is lean soft tissue/, "HTML explains total lean mass as dated DEXA context");
  assert.ok(text.includes("tape est."), "text twin labels the tape estimate");
  assert.doesNotMatch(text.split("BODY COMPOSITION")[0], /Lean Mass|Visceral Fat/, "MyChart findings omit DEXA support-only rows");
  assert.equal(data.bodyComp?.label, "At-home body estimate");
  assert.ok(data.bodyComp?.summary.includes("Tape estimate"), "caption names the tape source");
  assert.ok(data.bodyComp?.summary.includes("175.5 lb"), "caption names the current weight used");
});

test("DEXA-only body composition stays dated; current-weight projection is caption context", () => {
  repo.setProfile({ age: 44, sex: "male", height_cm: 170, weight_lb: 175.5 });
  const scanDate = localDaysAgo(30);
  const today = localDaysAgo(0);
  seedHealthDoc(scanDate, [
    marker("Body Fat %", 35.6, { unit: "%", flag: "high" }),
    marker("Lean Mass (Total)", 112.6, { unit: "lbs", flag: "low" }),
    marker("Bone Mineral Content (BMC)", 6.1, { unit: "lbs" }),
    marker("Fat Mass (Total)", 65.6, { unit: "lbs", flag: "high" }),
    marker("Visceral Fat", 1.13, { unit: "lbs", flag: "high" }),
    marker("Total Mass", 184.3, { unit: "lbs" }),
  ], "dexa");
  repo.logWeight(184.3, scanDate);
  repo.logWeight(175.5, today);

  const data = buildClinicalReportData();
  const body = data.groups.find((g) => g.key === "body");
  const bf = body?.markers.find((m) => /Body Fat/.test(m.name) && m.unit === "%");
  const weight = body?.markers.find((m) => m.name === "Body Weight");
  assert.equal(bf?.estimated, false, "DEXA-only rows are not relabeled as current measurements");
  assert.equal(bf?.value, 35.6);
  assert.equal(bf?.latestDate, scanDate);
  assert.equal(weight?.value, 175.5, "DEXA total mass still cross-references newer logged bodyweight");
  assert.equal(weight?.latestDate, today);
  assert.equal(weight?.flag, null);
  assert.equal(data.bodyComp?.label, "DEXA projection context");
  assert.ok(data.bodyComp?.summary.includes("Current-weight-only projection"));
  assert.ok(data.bodyComp?.summary.includes("not a fresh body-fat measurement"));
  assert.ok(data.findings.some((f) => f.name === "Body Fat %"), "DEXA body-fat finding can still headline when it is the best body-comp signal");
  assert.ok(!data.findings.some((f) => /Lean Mass|Visceral Fat/.test(f.name)), "DEXA support-only rows are panel context, not headline findings");
  const lean = body?.markers.find((m) => /Lean Mass/.test(m.name));
  assert.equal(lean?.abnormal, true, "lean mass still shows the DEXA source flag in the panel");
  assert.equal(lean?.findingSuppressed, true);
});

test("wearable recovery markers stay in panels but not PCP headline findings", () => {
  repo.recordDailyMetrics("apple", localDaysAgo(6), { hrv_ms: 55 });
  repo.recordDailyMetrics("apple", localDaysAgo(3), { hrv_ms: 45 });
  repo.recordDailyMetrics("apple", localDaysAgo(0), { hrv_ms: 35 });

  const data = buildClinicalReportData();
  const hrv = data.groups.flatMap((g) => g.markers).find((m) => m.name === "HRV");
  assert.ok(hrv, "HRV remains visible as wearable context");
  assert.equal(hrv.source, "wearable");
  assert.equal(hrv.abnormal, true, "the panel still shows the off-target value");
  assert.equal(hrv.findingSuppressed, true, "wearable HRV is not a doctor-discussion headline");
  assert.match(String(hrv.methodNote), /Wearable-derived/);
  assert.ok(!data.findings.some((f) => f.name === "HRV"));
});

test("stale time-sensitive abnormal readings stay in panels but not headline findings", () => {
  seedHealthDoc(localDaysAgo(90), [marker("hs-CRP", 5.2, { unit: "mg/L", flag: "high" })]);
  const data = buildClinicalReportData();
  assert.deepEqual(data.findings.map((f) => f.name), [], "old acute inflammation is not a current headline finding");
  const inflammation = data.groups.find((g) => g.key === "inflammation");
  const crp = inflammation?.markers.find((m) => /CRP|C-Reactive/i.test(m.name));
  assert.ok(crp?.abnormal, "the dated panel still carries the abnormal result");
  assert.equal(crp.staleForFinding, true);
  const html = renderClinicalReportHTML(data, {});
  const text = renderClinicalReportText(data, {});
  assert.ok(html.includes("older out-of-range"), "HTML explains stale findings were kept in panels");
  assert.ok(text.includes("older out-of-range"), "text twin explains stale findings were kept in panels");
});

test("doctor report omits normal context-only spot vitals but keeps BP and resting HR", () => {
  seedHealthDoc("2026-03-11", [
    marker("Systolic BP", 120, { unit: "mmHg", flag: "normal" }),
    marker("Diastolic BP", 77, { unit: "mmHg", flag: "normal" }),
    marker("Resting HR", 55, { unit: "bpm", flag: "normal" }),
    marker("Average Heart Rate", 57, { unit: "bpm" }),
    marker("Oxygen Saturation", 96, { unit: "%", flag: "normal" }),
    marker("Pulse", 78, { unit: "bpm" }),
    marker("Respiratory Rate", 16, { unit: "breaths/min" }),
    marker("Temperature", 36.3, { unit: "deg C" }),
  ]);

  const data = buildClinicalReportData();
  const vitals = data.groups.find((g) => g.key === "vitals");
  assert.ok(vitals, "vitals group still exists for useful rows");
  assert.deepEqual(vitals.markers.map((m) => m.name), [
    "Systolic BP",
    "Diastolic BP",
    "Resting HR",
  ]);

  const html = renderClinicalReportHTML(data, {});
  const text = renderClinicalReportText(data, {});
  for (const hidden of ["Average Heart Rate", "Oxygen Saturation", "Pulse", "Respiratory Rate", "Temperature"]) {
    assert.doesNotMatch(html, new RegExp(hidden), `${hidden} is omitted from HTML report`);
    assert.doesNotMatch(text, new RegExp(hidden), `${hidden} is omitted from text report`);
  }
});

test("doctor report keeps abnormal spot vitals as clinically relevant", () => {
  seedHealthDoc("2026-03-11", [
    marker("Oxygen Saturation", 92, { unit: "%", flag: "low" }),
    marker("Pulse", 115, { unit: "bpm", flag: "high" }),
  ]);

  const data = buildClinicalReportData();
  const vitals = data.groups.find((g) => g.key === "vitals");
  assert.ok(vitals, "vitals group present");
  assert.deepEqual(vitals.markers.map((m) => m.name), ["Oxygen Saturation", "Pulse"]);
  assert.ok(data.findings.some((f) => f.name === "Oxygen Saturation" && f.flag === "low"));
  assert.ok(data.findings.some((f) => f.name === "Pulse" && f.flag === "high"));
});

test("doctor report cleans Other-marker leftovers into clinical panels or profile context", () => {
  repo.setProfile({ age: 44, sex: "male", height_cm: 170, weight_lb: 175.5 });
  const today = localDaysAgo(0);
  repo.logWeight(175.5, today);
  seedHealthDoc("2026-03-11", [
    marker("Weight", 84.8, { unit: "kg", flag: "normal" }),
    marker("Pain Score", 2, { unit: "/10" }),
  ], "other");
  seedHealthDoc("2026-06-02", [
    marker("Carbohydrate Oxidation", 33.3, { unit: "%" }),
    marker("Fat Oxidation", 67, { unit: "%" }),
    marker("Height", 167.6, { unit: "cm" }),
  ], "dexa");
  seedHealthDoc("2026-06-11", [marker("Mean Corpuscular Volume", 91.9, { unit: "fL" })]);
  seedHealthDoc("2022-01-20", [
    marker("Hepatitis C Antibody", "Non-Reactive"),
    marker("HIV Ag/Ab Qualitative", "Non-Reactive"),
    marker("HIV Result Interpretation", "TNP"),
  ]);

  const data = buildClinicalReportData();
  const byGroup = Object.fromEntries(data.groups.map((g) => [g.key, g]));
  assert.ok(byGroup.fitness?.markers.some((m) => m.name === "Carbohydrate Oxidation"), "carb oxidation moves to fitness/metabolic-rate context");
  assert.ok(byGroup.fitness?.markers.some((m) => m.name === "Fat Oxidation"), "fat oxidation moves to fitness/metabolic-rate context");
  assert.ok(byGroup.iron?.markers.some((m) => m.name === "Mean Corpuscular Volume"), "MCV full-name row moves to CBC/iron");
  assert.ok(byGroup.infectious?.markers.some((m) => m.name === "Hepatitis C Antibody"), "infectious screening rows get their own panel");
  assert.ok(byGroup.infectious?.markers.some((m) => m.name === "HIV Ag/Ab Qualitative"), "parent HIV qualitative result remains");
  assert.ok(!data.groups.some((g) => g.key === "other"), "these real rows no longer fall into Other Markers");

  const body = byGroup.body;
  assert.ok(body, "body panel present");
  assert.ok(!body.markers.some((m) => m.name === "Height"), "profile height is not duplicated as a marker row");
  const bodyWeight = body.markers.find((m) => m.name === "Body Weight");
  assert.ok(bodyWeight, "source Weight is unified into Body Weight");
  assert.equal(bodyWeight.value, 175.5);
  assert.equal(bodyWeight.latestDate, today);
  assert.equal(bodyWeight.unit, "lb");
  assert.deepEqual(bodyWeight.history.map((h) => h.value), [187, 175.5]);
  assert.equal(bodyWeight.abnormal, false);
  assert.equal(bodyWeight.targetText, "tracking context");

  assert.ok(!data.groups.some((g) => g.markers.some((m) => m.name === "Pain Score")), "normal point-in-time pain score is omitted from the PCP report");
  assert.ok(!data.groups.some((g) => g.markers.some((m) => /HIV Result Interpretation/i.test(m.name))), "TNP non-result row is dropped");
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
  seedHealthDoc("2026-06-30", [
    marker("Cholesterol, Total", 238, { unit: "mg/dL", flag: "high" }),
    marker("LDL Chol Calc (NIH)", 173, { unit: "mg/dL", flag: "high" }),
    marker("VLDL Cholesterol Cal", 14, { unit: "mg/dL", flag: "normal" }),
  ]);

  const data = buildClinicalReportData();
  const lipids = data.groups.find((g) => g.key === "lipids");
  assert.ok(lipids, "lipid panel present");
  const names = lipids.markers.map((m) => m.name);
  assert.deepEqual(names.slice(0, 8), [
    "Total Cholesterol",
    "LDL-C",
    "LDL-C (Direct)",
    "HDL Cholesterol",
    "Non-HDL-C",
    "Triglycerides",
    "VLDL Cholesterol",
    "Apolipoprotein B (ApoB)",
  ]);
  assert.ok(names.indexOf("VLDL Cholesterol") < names.indexOf("Apolipoprotein B (ApoB)"), "VLDL stays with the standard lipid panel");
  assert.ok(names.indexOf("LDL Particle Number") < names.indexOf("LDL Small"), "LDL-P comes before subfractions");
  assert.ok(names.indexOf("LDL Small") < names.indexOf("LDL Peak Size"), "subfractions come before peak-size detail");

  const total = lipids.markers.find((m) => m.name === "Total Cholesterol");
  const standard = lipids.markers.find((m) => m.name === "LDL-C");
  const direct = lipids.markers.find((m) => m.name === "LDL-C (Direct)");
  const vldl = lipids.markers.find((m) => m.name === "VLDL Cholesterol");
  assert.deepEqual(total.sourceNames, ["Cholesterol, Total"], "canonical row preserves the lab's source label");
  assert.deepEqual(standard.sourceNames, ["LDL-Cholesterol", "LDL Chol Calc (NIH)"], "standard LDL source labels stay verifiable");
  assert.deepEqual(vldl.sourceNames, ["VLDL Cholesterol Cal"]);
  assert.match(standard.methodNote, /standard lipid-panel LDL-C/i);
  assert.match(direct.methodNote, /Direct LDL-C assay/i);
  assert.equal(vldl.optimalText, null, "VLDL does not inherit LDL-C's optimal target");

  const html = renderClinicalReportHTML(data, {});
  const text = renderClinicalReportText(data, {});
  assert.ok(html.includes("Findings by panel"), "HTML groups the top findings by panel");
  assert.ok(html.includes("Standard lipid panel"), "lipid rows are subheaded like a familiar panel");
  assert.ok(html.includes("LDL-C rows are separated by assay/source method"), "HTML explains the two LDL rows");
  assert.ok(html.includes("Source labels: LDL-Cholesterol; LDL Chol Calc (NIH)"), "HTML keeps source labels as provenance");
  assert.ok(html.includes("as of Jun 30 '26") && html.includes("as of Apr 17 '24"), "latest dates sit next to the result values");
  assert.ok(text.includes("{207 Jun 11 '26 · 173 Jun 30 '26}"), "same-month retests keep day-level dates in history");
  assert.ok(text.includes("Source labels: LDL-Cholesterol; LDL Chol Calc (NIH)"), "text twin keeps source labels as provenance");
  assert.ok(text.includes("Note: LDL-C rows are separated by assay/source method"), "text twin carries the same LDL note");
});

test("non-lipid report panels read in clinician scan order", () => {
  seedHealthDoc("2026-06-11", [
    marker("Hemoglobin A1c", 5.6, { unit: "%", flag: "normal" }),
    marker("Estimated Average Glucose", 114, { unit: "mg/dL", flag: "normal" }),
    marker("Glucose", 92, { unit: "mg/dL", flag: "normal" }),
    marker("ALT", 24, { unit: "U/L", flag: "normal" }),
    marker("Albumin", 4.7, { unit: "g/dL", flag: "normal" }),
    marker("AST", 23, { unit: "U/L", flag: "normal" }),
    marker("GGT", 15, { unit: "U/L", flag: "normal" }),
    marker("Alkaline Phosphatase", 54, { unit: "U/L", flag: "normal" }),
    marker("Total Bilirubin", 0.8, { unit: "mg/dL", flag: "normal" }),
    marker("Total Protein", 7.1, { unit: "g/dL", flag: "normal" }),
    marker("eGFR", 92, { unit: "mL/min/1.73m2", flag: "normal" }),
    marker("Albumin, Random Urine", 0.4, { unit: "mg/dL", flag: "normal" }),
    marker("Creatinine", 0.98, { unit: "mg/dL", flag: "normal" }),
    marker("BUN", 14, { unit: "mg/dL", flag: "normal" }),
  ]);

  const data = buildClinicalReportData();
  const metabolic = data.groups.find((g) => g.key === "metabolic");
  const liver = data.groups.find((g) => g.key === "liver");
  const kidney = data.groups.find((g) => g.key === "kidney");
  assert.ok(metabolic, "metabolic panel present");
  assert.ok(liver, "liver panel present");
  assert.ok(kidney, "kidney panel present");
  assert.deepEqual(metabolic.markers.map((m) => m.name), ["Glucose", "Hemoglobin A1c", "Estimated Average Glucose"]);
  assert.deepEqual(liver.markers.map((m) => m.name), [
    "Albumin",
    "Total Protein",
    "Total Bilirubin",
    "Alkaline Phosphatase",
    "AST",
    "ALT",
    "GGT",
  ]);
  assert.deepEqual(kidney.markers.map((m) => m.name), ["Blood Urea Nitrogen (BUN)", "Creatinine", "eGFR", "Albumin, Random Urine"]);

  const html = renderClinicalReportHTML(data, {});
  assert.ok(html.indexOf("Glucose") < html.indexOf("Hemoglobin A1c"), "HTML follows metabolic order");
  assert.ok(html.indexOf("Albumin") < html.indexOf("Alkaline Phosphatase"), "HTML follows liver order");
});

test("CBC and iron-study rows carry populated target bands and merged labels", () => {
  repo.setProfile({ sex: "male", age: 44 });
  seedHealthDoc("2022-01-20", [
    marker("RBC", 4.55, { unit: "M/uL" }),
    marker("Hemoglobin", 13.7, { unit: "g/dL" }),
  ]);
  seedHealthDoc("2026-03-10", [
    marker("Red Blood Cell Count", 4.65, { unit: "M/uL" }),
    marker("Red Cell Distribution Width, Standard Deviation", 40.9, { unit: "fL" }),
  ]);
  seedHealthDoc("2026-06-11", [
    marker("Red Blood Cell (RBC) Count", 4.67, { unit: "Million/uL" }),
    marker("Mean Corpuscular Hemoglobin", 30, { unit: "pg" }),
    marker("Mean Corpuscular Hemoglobin Concentration", 32.6, { unit: "g/dL" }),
    marker("Hematocrit", 42.9, { unit: "%" }),
    marker("Red Cell Distribution Width (RDW)", 13.2, { unit: "%" }),
    marker("Iron % Saturation", 24, { unit: "%" }),
    marker("Iron", 76, { unit: "mcg/dL" }),
    marker("Iron Binding Capacity", 314, { unit: "mcg/dL" }),
  ]);

  const data = buildClinicalReportData();
  const iron = data.groups.find((g) => g.key === "iron");
  assert.ok(iron, "iron/red blood group present");
  assert.equal(iron.markers.filter((m) => m.name === "Red Blood Cell Count").length, 1, "RBC source labels merge to one row");
  const byName = Object.fromEntries(iron.markers.map((m) => [m.name, m]));
  assert.equal(byName["Red Blood Cell Count"]?.optimalText, "4.35–5.65");
  assert.equal(byName.Hemoglobin?.optimalText, "13.2–16.6");
  assert.equal(byName.Hematocrit?.optimalText, "38.3–48.6");
  assert.equal(byName["Mean Corpuscular Hemoglobin"]?.optimalText, "27–33");
  assert.equal(byName["Mean Corpuscular Hemoglobin Concentration"]?.optimalText, "32–36");
  assert.equal(byName["Red Cell Distribution Width (RDW)"]?.optimalText, "≤ 14.5");
  assert.equal(byName["Red Cell Distribution Width, Standard Deviation"]?.optimalText, "39–46");
  assert.equal(byName["Iron % Saturation"]?.optimalText, "20–50");
  assert.equal(byName.Iron?.optimalText, "65–175");
  assert.equal(byName["Iron Binding Capacity"]?.optimalText, "250–450");

  const html = renderClinicalReportHTML(data, {});
  assert.doesNotMatch(html, /Red Blood Cell Count[\s\S]{0,500}<td class="m-tgt">—<\/td>/, "RBC row does not render an empty target");
  assert.doesNotMatch(html, /Iron Binding Capacity[\s\S]{0,500}<td class="m-tgt">—<\/td>/, "TIBC row does not render an empty target");
});

test("report target/reference column uses lab ranges or context instead of blank dashes", () => {
  seedHealthDoc("2026-06-11", [
    { name: "Unmodeled Quantitative Marker", value: 7, unit: "units", flag: "normal", ref_low: 5, ref_high: 10 },
    { name: "ABO Group", value: "O", unit: null, flag: null },
    { name: "ANA Screen", value: "Negative", unit: null, flag: null },
    { name: "Specialty Marker", value: 42, unit: "units", flag: "high" },
  ]);

  const data = buildClinicalReportData();
  const markers = data.groups.flatMap((g) => g.markers);
  const ref = markers.find((m) => m.name === "Unmodeled Quantitative Marker");
  const abo = markers.find((m) => m.name === "ABO Group");
  const ana = markers.find((m) => m.name === "ANA Screen");
  const specialty = markers.find((m) => m.name === "Specialty Marker");
  assert.equal(ref?.targetText, "ref 5–10");
  assert.equal(ref?.targetKind, "reference");
  assert.equal(abo?.targetText, "fixed trait");
  assert.equal(ana?.targetText, "expected negative");
  assert.equal(specialty?.targetText, "source flagged high");

  const html = renderClinicalReportHTML(data, {});
  assert.ok(html.includes("ref 5–10"));
  assert.ok(html.includes("fixed trait"));
  assert.ok(html.includes("expected negative"));
  assert.doesNotMatch(html, /<td class="m-tgt[^"]*">—<\/td>/, "target/reference cells do not render bare dashes");
});

test("report uses curated sourced reference ranges when uploads omit standard lab intervals", () => {
  seedHealthDoc("2026-06-11", [
    { name: "Amylase", value: 51, unit: "U/L", flag: "normal" },
    { name: "Specific Gravity - Urine", value: 1.003, unit: null, flag: "normal" },
  ]);

  const data = buildClinicalReportData();
  const markers = data.groups.flatMap((g) => g.markers);
  const amylase = markers.find((m) => m.name === "Amylase");
  assert.equal(amylase?.targetText, "ref 40–140");
  assert.equal(amylase?.targetKind, "reference");
  assert.equal(amylase?.referenceSource, "MedlinePlus Amylase - blood");

  const html = renderClinicalReportHTML(data, {});
  assert.ok(html.includes("ref 40–140"));
  assert.ok(html.includes("Reference source: MedlinePlus Amylase - blood"));
  assert.ok(html.includes("1.003"));
  assert.ok(html.includes("ref 1.005–1.03"));
  assert.ok(html.includes("curated adult reference interval"));
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
