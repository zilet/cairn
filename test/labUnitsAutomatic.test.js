// "Automatic" lab units read the system the athlete's OWN labs were printed in, never the weight unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker } from "./_seed.js";
import { reportedLabSystem } from "../dist/repo/lab-reported-system.js";

test("Automatic lab units follow the athlete's own labs, never the weight unit", () => {
  repo.setSettings({ weight_units: "kg" });
  assert.equal(repo.labUnitSystem(), "us", "kg with no labs reads conventional");
  assert.equal(repo.getSettings().lab_units_effective, "us");

  seedHealthDoc("2026-05-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL" }), marker("Glucose", 90, { unit: "mg/dL" })]);
  assert.equal(reportedLabSystem(), "us");
  assert.equal(repo.labUnitSystem(), "us", "a kg country printing mg/dL stays mg/dL");

  // A newer SI draw wins, by majority of the most recent draw.
  seedHealthDoc("2026-08-01", [
    marker("LDL Cholesterol", 3.4, { unit: "mmol/L" }),
    marker("Glucose", 5.0, { unit: "mmol/L" }),
    marker("Triglycerides", 150, { unit: "mg/dL" }),
  ]);
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

test("Automatic ignores analytes both systems print alike, and an older SI draw behind a newer US one", () => {
  seedHealthDoc("2026-03-01", [marker("LDL Cholesterol", 3.4, { unit: "mmol/L" })]);
  seedHealthDoc("2026-07-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL" })]);
  assert.equal(repo.labUnitSystem(), "us", "the most recent draw speaks");
  db.prepare("DELETE FROM health_documents").run();
  seedHealthDoc("2026-07-01", [marker("Ferritin", 50, { unit: "ng/mL" }), marker("TSH", 2, { unit: "uIU/mL" })]);
  assert.equal(reportedLabSystem(), null, "ferritin ng/mL and µg/L are the same number: nothing to read");
  assert.equal(repo.labUnitSystem(), "us");
});

