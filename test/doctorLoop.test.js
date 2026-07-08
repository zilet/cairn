import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "health_documents",
    "health_directives",
    "health_reviews",
    "attention_schedule",
    "profile",
  );
});

test("recommendedPanel subtracts labs and DEXA already on file", () => {
  seedHealthDoc("2026-01-01", [
    marker("ApoB", 78, { unit: "mg/dL" }),
    marker("Lp(a)", 40, { unit: "nmol/L" }),
    marker("HbA1c", 5.1, { unit: "%" }),
    marker("hs-CRP", 0.7, { unit: "mg/L" }),
    marker("Ferritin", 80, { unit: "ng/mL" }),
    marker("TSH", 1.8, { unit: "uIU/mL" }),
    marker("Free T4", 1.2, { unit: "ng/dL" }),
    marker("Free T3", 3.1, { unit: "pg/mL" }),
    marker("25-OH Vitamin D", 45, { unit: "ng/mL" }),
  ]);
  seedHealthDoc("2026-01-10", [
    marker("Body Fat %", 22, { unit: "%" }),
    marker("ALMI", 8.1, { unit: "kg/m2" }),
  ], "dexa");

  const labels = repo.recommendedPanel().map((x) => x.label);
  assert.ok(!labels.includes("ApoB"));
  assert.ok(!labels.includes("Lp(a)"));
  assert.ok(!labels.includes("HbA1c"));
  assert.ok(!labels.includes("hs-CRP"));
  assert.ok(!labels.includes("Ferritin"));
  assert.ok(!labels.includes("Thyroid panel (TSH, Free T4, Free T3)"));
  assert.ok(!labels.includes("DEXA body composition"));
  assert.ok(labels.includes("Fasting insulin"));
  assert.ok(labels.includes("Urine albumin/creatinine ratio"));
});

test("refreshDoctorLoopAttention schedules active lab and DEXA retests through attention policies", () => {
  seedHealthDoc("2026-01-01", [
    marker("ApoB", 125, { unit: "mg/dL", flag: "high" }),
  ]);
  seedHealthDoc("2026-01-15", [
    marker("Body Fat %", 35, { unit: "%", flag: "high" }),
  ], "dexa");

  const rows = repo.refreshDoctorLoopAttention();
  const apob = rows.find((r) => r.signal_key === "marker:apob");
  const dexa = rows.find((r) => r.signal_key === "dexa:body-composition");

  assert.equal(apob.tier, "active");
  assert.equal(apob.next_due, "2026-03-26");
  assert.match(apob.reason, /ApoB/i);
  assert.ok(apob.release_condition);

  assert.equal(dexa.tier, "active");
  assert.equal(dexa.next_due, "2026-04-09");
  assert.equal(dexa.domain, "body");
  assert.match(dexa.reason, /Body composition/i);

  const read = repo.doctorLoopRead({ asOf: "2026-04-10" });
  assert.ok(read.due.some((r) => r.signal_key === "marker:apob"));
  assert.ok(read.due.some((r) => r.signal_key === "dexa:body-composition"));
  assert.ok(read.frame.includes("Informational"));
});

test("clean stable markers converge to released attention instead of fixed retest cadence", () => {
  seedHealthDoc("2026-01-01", [
    marker("ApoB", 70, { unit: "mg/dL", flag: "normal" }),
    marker("HbA1c", 5.1, { unit: "%", flag: "normal" }),
  ]);

  const rows = repo.refreshDoctorLoopAttention();
  const apob = rows.find((r) => r.signal_key === "marker:apob");
  const a1c = rows.find((r) => r.signal_key === "marker:hba1c");

  assert.equal(apob.tier, "released");
  assert.equal(apob.next_due, null);
  assert.match(apob.reason, /goes quiet/i);
  assert.equal(a1c.tier, "released");
  assert.equal(repo.doctorLoopRead({ asOf: "2027-01-01" }).due.length, 0);
});
