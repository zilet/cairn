// Unit spellings, decimal commas and the insulin factor the lab-unit table must understand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedHealthDoc, marker } from "./_seed.js";

test("count and molar unit spellings from US and EU labs compare equal", () => {
  for (const u of ["K/mcL", "cells/mm3", "cells/mm³", "10^3/uL"]) {
    assert.ok(repo.labUnitsCompatible(u, u === "K/mcL" || u === "10^3/uL" ? "K/uL" : "cells/uL"), u);
  }
  assert.equal(repo.toCanonical("WBC", 6500, "cells/mm3"), 6.5);
  assert.equal(repo.toCanonical("WBC", 6500, "/mm3"), 6.5);
  assert.equal(repo.toCanonical("Platelets", 250, "K/mcL"), 250);
  assert.ok(repo.labUnitsCompatible("micromol/L", "µmol/L"));
  assert.ok(Math.abs(repo.toCanonical("Creatinine", 88.42, "micromol/L") - 1) < 1e-9);
});

test("parseLabNumber: a leading '0,' is a decimal; a single comma in an SI reading is a decimal", () => {
  assert.equal(repo.parseLabNumber("0,350"), 0.35);
  assert.equal(repo.parseLabNumber("-0,5"), -0.5);
  assert.equal(repo.parseLabNumber("1,234"), 1234, "bare comma-3 stays a thousands group");
  assert.equal(repo.parseLabNumber("1,234", "mmol/L"), 1.234, "…unless the reading is SI");
  assert.equal(repo.parseLabNumber("5,2", "mmol/L"), 5.2);
  assert.equal(repo.parseLabNumber("1,234", "mg/dL"), 1234);
  assert.equal(repo.parseLabNumber("1,234.5"), 1234.5);
  // Through the normalizer: 0,350 mmol/L reads 0.35, and 4,1 mmol/L LDL comes out canonical.
  assert.equal(repo.normalizeMarkerReading("Triglycerides", "0,350", "mmol/L", { label: "Triglycerides", unit: "mg/dL" }).value, 31);
});

test("insulin pmol/L converts at 6.0 pmol per µIU", () => {
  assert.equal(repo.toCanonical("Fasting insulin", 60, "pmol/L"), 10);
});


test("TSH and fasting insulin printed 'mIU/mL' read as µIU/mL and keep their trend", () => {
  // mIU/mL is a thousand µIU/mL for FSH/LH, but no TSH or insulin runs in the thousands.
  const tsh = repo.normalizeMarkerReading("TSH", "2.0", "mIU/mL", { label: "TSH", unit: "uIU/mL" });
  assert.equal(tsh.value, 2);
  assert.equal(tsh.unit, "uIU/mL");
  assert.equal(tsh.unit_converted, true);
  assert.equal(tsh.unit_mismatch, undefined);
  assert.equal(repo.toCanonical("Fasting insulin", 7, "mIU/mL"), 7);
  assert.equal(repo.labUnitsCompatible("uIU/mL", "mIU/mL"), false, "the generic families stay apart");

  seedHealthDoc("2025-01-10", [marker("TSH", 1.6, { unit: "uIU/mL" }), marker("Fasting insulin", 5, { unit: "uIU/mL" })]);
  seedHealthDoc("2025-06-10", [marker("TSH", "2.0", { unit: "mIU/mL" }), marker("Fasting insulin", 6, { unit: "mIU/mL" })]);
  repo.resetMarkerHistoryCache();
  const markers = repo.getMarkerHistory().markers;
  const t = markers.find((m) => /tsh/i.test(m.name));
  assert.equal(t.unit, "uIU/mL");
  assert.deepEqual(t.points.map((p) => p.value), [1.6, 2]);
  assert.equal(t.dropped_other_units, 0);
  const ins = markers.find((m) => /insulin/i.test(m.name));
  assert.deepEqual(ins.points.map((p) => p.value), [5, 6]);
  assert.equal(ins.dropped_other_units, 0);
});
