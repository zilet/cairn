// Wave H item 1 — the generic long-tail must NOT fire for a marker in a clinical group
// the mapping + cluster layer already models end-to-end (Lipids & Cardiovascular). On a
// real lipid panel the LDL sub-fractions, particle counts, peak size and composite
// "x / y" ratios each fall through matchOptimalZone (zoneNameTrustworthy rightly refuses
// to map a subfraction/ratio to a serum band) and used to each spawn their OWN standalone
// `watch` note — one lipid story becoming ~10 noise rows on top of the ApoB/LDL/Non-HDL
// mappings + the cardiovascular cluster. The fix is group-based (deriveGenericLongTail
// skips markerGroup === 'lipids'); a genuinely-unmapped flagged marker still surfaces.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile");
});

const isGeneric = (d) => /isn't one of the levers/i.test(String(d.directive || ""));

test("lipid sub-fraction / particle / ratio names spawn NO generic long-tail notes", () => {
  seedHealthDoc("2026-06-30", [
    marker("LDL Small", 500, { unit: "nmol/L", flag: "high" }),
    marker("LDL Medium", 300, { unit: "nmol/L", flag: "high" }),
    marker("LDL Peak Size", 210, { unit: "A", flag: "high" }),
    marker("LDL Particle Number", 2000, { unit: "nmol/L", flag: "high" }),
    marker("Total Cholesterol", 240, { unit: "mg/dL", flag: "high" }),
    marker("Total Cholesterol / HDL Ratio", 5.2, { unit: "", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const generic = repo.listActiveDirectives().filter(isGeneric);
  assert.equal(generic.length, 0, "the lipid panel's noise names produce zero generic watch notes");
});

test("a genuinely-unmapped flagged marker (potassium / ALP / PSA) STILL gets one generic note", () => {
  seedHealthDoc("2026-06-30", [
    marker("Potassium", 5.9, { unit: "mmol/L", flag: "high" }),
    marker("ALP", 160, { unit: "U/L", flag: "high" }),
    marker("PSA", 5.5, { unit: "ng/mL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const active = repo.listActiveDirectives();
  for (const name of ["Potassium", "ALP", "PSA"]) {
    const g = active.filter((d) => (d.marker || "") === name && isGeneric(d));
    assert.equal(g.length, 1, `${name} still surfaces exactly one generic watch note`);
    assert.equal(g[0].domain, "watch");
    assert.equal(!!g[0].uncertain, true);
  }
  assert.equal(repo.markerGroup("Potassium").key, "electrolytes");
  assert.equal(repo.markerGroup("ALP").key, "liver");
  assert.equal(repo.markerGroup("PSA").key, "screening");
});

test("a full lipid panel still surfaces the mapped ApoB/LDL/Non-HDL directives + the cluster", () => {
  seedHealthDoc("2026-06-30", [
    marker("ApoB", 115, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 170, { unit: "mg/dL", flag: "high" }),
    marker("Non-HDL-C", 190, { unit: "mg/dL", flag: "high" }),
    marker("LDL Small", 500, { unit: "nmol/L", flag: "high" }),
    marker("LDL Particle Number", 2000, { unit: "nmol/L", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const active = repo.listActiveDirectives();
  assert.ok(active.some((d) => (d.marker || "") === "ApoB"), "ApoB lever kept");
  assert.ok(active.some((d) => (d.marker || "") === "LDL-C"), "LDL-C lever kept");
  assert.ok(active.some((d) => /elevated-risk|elevated together|cardiovascular/i.test(d.directive)), "cluster read kept");
  assert.equal(active.filter(isGeneric).length, 0, "still no generic lipid noise");
});
