// Unit spellings, decimal commas and the insulin factor the lab-unit table must understand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";

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

