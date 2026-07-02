// Wave H item 3 — evidence-anchored OPTIMAL_ZONES for cystatin C, calcium, morning
// cortisol, DHEA-S and PSA. These are optimal TARGET bands, not lab reference ranges,
// and carry NO score. They are sex/age-personalized where the physiology demands it
// (cystatin C rises with age, PSA's upper edge is age-banded, DHEA-S falls with age and
// runs lower in women) and guarded so a DIFFERENT analyte with an overlapping name
// (ionized/CT calcium, a PM/salivary/urine cortisol, free-PSA) is never held to the
// serum band. Golden tests pin the matches + guards + personalization.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile");
});

const z = (name, prof) => repo.matchOptimalZone(name, prof);

test("cystatin C matches (kidney) and is age-banded on the high edge", () => {
  assert.equal(z("Cystatin C")?.label, "Cystatin C");
  assert.equal(z("Cystatin C", { sex: "male", age: 30 }).optimal[1], 1.0);
  assert.equal(z("Cystatin C", { sex: "male", age: 72 }).optimal[1], 1.3, "older adult gets a wider high edge");
  assert.equal(repo.markerGroup("Cystatin C").key, "kidney");
});

test("PSA matches, is age-banded, and free-PSA / %-free-PSA are kept off the total band", () => {
  assert.equal(z("PSA")?.label, "PSA");
  assert.equal(z("Prostate Specific Antigen")?.label, "PSA");
  assert.equal(z("PSA", { sex: "male", age: 45 }).optimal[1], 2.5);
  assert.equal(z("PSA", { sex: "male", age: 65 }).optimal[1], 4.5);
  assert.equal(z("PSA", { sex: "male", age: 75 }).optimal[1], 6.5);
  assert.equal(z("Free PSA"), null, "free PSA is a distinct measure");
  assert.equal(z("% Free PSA"), null);
  assert.equal(repo.markerGroup("PSA").key, "screening");
});

test("DHEA-S matches the SULFATE form only and is sex+age banded (never bare DHEA)", () => {
  assert.equal(z("DHEA-S")?.label, "DHEA-S");
  assert.equal(z("DHEA Sulfate")?.label, "DHEA-S");
  assert.equal(z("Dehydroepiandrosterone Sulfate")?.label, "DHEA-S");
  assert.equal(z("DHEA"), null, "bare unsulfated DHEA is a different, less stable analyte");
  assert.deepEqual(z("DHEA-S", { sex: "male", age: 25 }).optimal, [280, 640]);
  assert.deepEqual(z("DHEA-S", { sex: "female", age: 25 }).optimal, [65, 380]);
  const fYoung = z("DHEA-S", { sex: "female", age: 25 }).optimal[1];
  const fOld = z("DHEA-S", { sex: "female", age: 68 }).optimal[1];
  assert.ok(fOld < fYoung, "the band falls with age");
  assert.equal(repo.markerGroup("DHEA-S").key, "hormones");
});

test("morning cortisol matches; a PM / salivary / urine cortisol is kept off the AM band", () => {
  assert.equal(z("Cortisol")?.label, "Morning cortisol");
  assert.equal(z("Morning Cortisol")?.label, "Morning cortisol");
  assert.equal(z("Cortisol, PM"), null);
  assert.equal(z("Cortisol Evening"), null);
  assert.equal(z("Salivary Cortisol"), null);
  assert.equal(z("Cortisol, Free, Urine"), null);
  assert.equal(repo.markerGroup("Cortisol").key, "hormones");
});

test("serum calcium matches; an ionized / CT calcium score / urine calcium is kept off the serum band", () => {
  assert.equal(z("Calcium")?.label, "Calcium");
  assert.equal(z("Ionized Calcium"), null);
  assert.equal(z("Coronary Artery Calcium Score"), null);
  assert.equal(z("Agatston Score"), null);
  assert.equal(z("Urine Calcium"), null);
  assert.equal(repo.markerGroup("Calcium").key, "vitamins");
});

test("an off-band calcium fires the albumin-correction interpretive watch note", () => {
  seedHealthDoc("2026-06-30", [marker("Calcium", 10.6, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const cal = repo.listActiveDirectives().filter((d) => (d.marker || "") === "Calcium");
  assert.ok(cal.length >= 1, "calcium surfaces a directive");
  assert.ok(cal.some((d) => d.domain === "watch" && /albumin/i.test(d.directive)), "carries the albumin-correction note");
  assert.ok(cal.every((d) => !!d.uncertain), "interpretive, flagged uncertain");
});

test("these zones carry NO numeric score anywhere (constitution)", () => {
  for (const name of ["Cystatin C", "Calcium", "Cortisol", "DHEA-S", "PSA"]) {
    const zone = z(name, { sex: "male", age: 55 });
    assert.ok(zone, `${name} resolves`);
    assert.equal(typeof zone.optimal[0], "number");
    assert.equal(typeof zone.optimal[1], "number");
    assert.ok(!("score" in zone), `${name} zone exposes no score field`);
  }
});
