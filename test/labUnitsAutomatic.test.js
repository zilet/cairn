// "Automatic" lab units read the system the athlete's OWN labs were printed in, never the weight
// unit: the majority of a year of convertible readings, else the most recent draw; a tie is US.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker } from "./_seed.js";
import { reportedLabSystem, reportedLabSystemComputeCount } from "../dist/repo/lab-reported-system.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const ago = (days) => addDaysISO(localDateISO(), -days);
const usDraw = (days, n = 2) =>
  seedHealthDoc(ago(days), [marker("LDL Cholesterol", 130, { unit: "mg/dL" }), marker("Glucose", 90, { unit: "mg/dL" })].slice(0, n));
const siDraw = (days) =>
  seedHealthDoc(ago(days), [
    marker("LDL Cholesterol", 3.4, { unit: "mmol/L" }),
    marker("Glucose", 5.0, { unit: "mmol/L" }),
    marker("Creatinine", 80, { unit: "µmol/L" }),
  ]);

test("Automatic follows the athlete's own labs, never the weight unit — and one SI lab abroad does not flip it", () => {
  repo.setSettings({ weight_units: "kg" });
  assert.equal(repo.labUnitSystem(), "us", "kg with no labs reads conventional");
  assert.equal(repo.getSettings().lab_units_effective, "us");

  usDraw(120);
  usDraw(60);
  assert.equal(reportedLabSystem(), "us");
  assert.equal(repo.labUnitSystem(), "us", "a kg country printing mg/dL stays mg/dL");

  // One draw abroad, printed in SI: three SI readings against the year's four US ones.
  siDraw(20);
  assert.equal(repo.labUnitSystem(), "us", "the year's majority still prints mg/dL");

  // The athlete's labs move to SI: once the year's majority prints SI, Automatic follows.
  siDraw(5);
  assert.equal(repo.labUnitSystem(), "si");
  assert.equal(repo.getSettings().lab_units_effective, "si");

  // The weight unit never matters in either direction; an explicit choice always wins.
  repo.setSettings({ weight_units: "lb" });
  assert.equal(repo.labUnitSystem(), "si", "lb with SI labs still reads SI");
  repo.setSettings({ lab_units: "us" });
  assert.equal(repo.labUnitSystem(), "us");
  repo.setSettings({ lab_units: "auto" });
  assert.equal(repo.labUnitSystem(), "si");
});

test("Automatic: a tie reads US; with no reading in the year the most recent draw speaks", () => {
  seedHealthDoc(ago(200), [marker("LDL Cholesterol", 3.4, { unit: "mmol/L" })]);
  seedHealthDoc(ago(100), [marker("LDL Cholesterol", 130, { unit: "mg/dL" })]);
  assert.equal(repo.labUnitSystem(), "us", "one reading each way is a tie");

  db.prepare("DELETE FROM health_documents").run();
  seedHealthDoc(ago(700), [marker("LDL Cholesterol", 130, { unit: "mg/dL" }), marker("Glucose", 90, { unit: "mg/dL" })]);
  seedHealthDoc(ago(400), [marker("LDL Cholesterol", 3.4, { unit: "mmol/L" })]);
  assert.equal(reportedLabSystem(), "si", "outside the year: the most recent draw, not the older majority");

  // Analytes both systems print alike tell nothing, inside the year or not.
  seedHealthDoc(ago(10), [marker("Ferritin", 50, { unit: "ng/mL" }), marker("TSH", 2, { unit: "uIU/mL" })]);
  assert.equal(reportedLabSystem(), "si");
  db.prepare("DELETE FROM health_documents").run();
  seedHealthDoc(ago(10), [marker("Ferritin", 50, { unit: "ng/mL" }), marker("TSH", 2, { unit: "uIU/mL" })]);
  assert.equal(reportedLabSystem(), null, "ferritin ng/mL and µg/L are the same number: nothing to read");
  assert.equal(repo.labUnitSystem(), "us");
});

test("Automatic is cached on the marker data: a new draw flips it, unrelated writes never recompute it", () => {
  assert.equal(repo.labUnitSystem(), "us");
  assert.equal(reportedLabSystem(), null);
  const settled = reportedLabSystemComputeCount();
  // Everyday writes that never touch a health document, and many reads between them.
  for (let i = 0; i < 3; i++) {
    repo.logWeight(180 + i, ago(i));
    repo.addCheckin(ago(i), { energy: 3 });
    repo.addMemory(`note ${i}`);
    repo.getSettings();
    repo.labUnitSystem();
  }
  assert.equal(reportedLabSystemComputeCount(), settled, "no recompute without a health-doc write");

  siDraw(1);
  assert.equal(repo.labUnitSystem(), "si", "a new SI draw flips Automatic");
  assert.equal(reportedLabSystemComputeCount(), settled + 1, "recomputed exactly once");
  repo.getSettings();
  repo.labUnitSystem();
  assert.equal(reportedLabSystemComputeCount(), settled + 1);
});
