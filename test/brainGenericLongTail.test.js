// Generic long-tail propagation (src/repo/propagation.ts deriveGenericLongTail).
// deriveDirectives only maps ~37 analytes; a lab-FLAGGED marker outside that set
// (potassium, ALP, PSA, WBC, cortisol, calcium, lipase, …) used to propagate NOTHING.
// Now each surfaces ONE soft, clearly-uncertain `watch` note so nothing the lab
// flagged goes unnoticed — without turning a big panel into a wall.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile");
});

test("a flagged, unmapped marker (potassium) yields ONE soft uncertain watch note", () => {
  seedHealthDoc("2025-12-01", [marker("Potassium", 5.9, { unit: "mmol/L", flag: "high" })]);
  repo.deriveDirectives();
  const pot = repo.listActiveDirectives().filter((d) => /potassium/i.test(String(d.marker || "")));
  assert.equal(pot.length, 1, "exactly one generic watch note");
  assert.equal(pot[0].domain, "watch");
  assert.equal(!!pot[0].uncertain, true, "generic long-tail notes are always uncertain");
  assert.equal(pot[0].citation, null);
  assert.match(pot[0].directive, /flagged|next visit|mentioning/i);
});

test("an UNflagged unmapped marker propagates nothing (fires only on an explicit flag)", () => {
  seedHealthDoc("2025-12-01", [marker("Lipase", 40, { unit: "U/L" })]); // in-range, no flag
  repo.deriveDirectives();
  const lip = repo.listActiveDirectives().filter((d) => /lipase/i.test(String(d.marker || "")));
  assert.equal(lip.length, 0);
});

test("a mapped marker does NOT also get a generic note (no double-fire)", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const apob = repo.listActiveDirectives().filter((d) => (d.marker || "") === "ApoB");
  assert.ok(apob.length >= 2, "ApoB keeps its mapped nutrition + watch levers");
  // None of ApoB's directives is the generic "isn't one of the levers Cairn maps" note.
  assert.equal(apob.some((d) => /isn't one of the levers/i.test(d.directive)), false);
});

test("many flagged long-tail markers are capped, not a wall", () => {
  const names = ["Potassium", "Calcium", "ALP", "Lipase", "Amylase", "PSA", "Cortisol", "Chloride", "Total Protein", "Globulin", "Sodium", "Uric Acid Extra", "Copper", "Zinc Extra", "Selenium Extra"];
  seedHealthDoc("2025-12-01", names.map((n) => marker(n, 999, { unit: "x", flag: "high" })));
  repo.deriveDirectives();
  const generic = repo.listActiveDirectives().filter((d) => /isn't one of the levers/i.test(String(d.directive || "")));
  assert.ok(generic.length > 0, "some generic notes surface");
  assert.ok(generic.length <= 12, "capped at the generic-directive ceiling");
});

test("re-deriving stays idempotent with generic notes present", () => {
  seedHealthDoc("2025-12-01", [marker("Potassium", 5.9, { unit: "mmol/L", flag: "high" })]);
  repo.deriveDirectives();
  const first = repo.listActiveDirectives().length;
  repo.deriveDirectives();
  repo.deriveDirectives();
  assert.equal(repo.listActiveDirectives().length, first, "generic notes clear + rewrite like the rest");
});
