// Lipid / directive de-noising (grounded on the owner's real panel, which carried
// ~8 overlapping lipid directives across two sources with un-aliased duplicate marker
// names: "LDL-C" AND "LDL Chol Calc (NIH)", "Non-HDL-C" AND "Non-HDL Cholesterol").
// Two fixes together: (1) marker-canon KB aliases fold the duplicate NAMES onto one
// canonical series; (2) health_review markers are canonicalized onto the optimal-zone
// label so the cross-source dedup (coach.dedupeActiveDirectives) collapses one lipid
// finding into one coherent directive set instead of near-duplicates.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "health_reviews", "profile");
});

test("duplicate lab LDL names canonicalize to ONE series key", () => {
  assert.equal(repo.canonicalMarker("LDL Chol Calc (NIH)").key, repo.canonicalMarker("LDL-C").key);
  assert.equal(repo.canonicalMarker("LDL Cholesterol").key, repo.canonicalMarker("LDL-C").key);
  assert.equal(repo.canonicalMarker("Non-HDL Cholesterol").key, repo.canonicalMarker("Non-HDL-C").key);
  // The clinically-DISTINCT direct-measured LDL stays separate (never merged).
  assert.notEqual(repo.canonicalMarker("LDL-C (direct)").key, repo.canonicalMarker("LDL-C").key);
});

test("a multi-name lipid panel reads as ONE LDL series and ONE non-HDL series", () => {
  seedHealthDoc("2026-06-30", [
    marker("LDL-C", 173, { unit: "mg/dL", flag: "high" }),
    marker("LDL Chol Calc (NIH)", 171, { unit: "mg/dL", flag: "high" }),
    marker("Non-HDL-C", 190, { unit: "mg/dL", flag: "high" }),
    marker("Non-HDL Cholesterol", 189, { unit: "mg/dL", flag: "high" }),
  ]);
  const { markers } = repo.getMarkerHistory();
  const ldl = markers.filter((m) => /ldl/i.test(m.name) && !/non/i.test(m.name));
  const nonhdl = markers.filter((m) => /non[\s-]?hdl/i.test(m.name));
  assert.equal(ldl.length, 1, "the two LDL names fold to one series");
  assert.equal(nonhdl.length, 1, "the two non-HDL names fold to one series");
});

test("one lipid finding yields one coherent directive set (within the markers source)", () => {
  seedHealthDoc("2026-06-30", [
    marker("LDL-C", 173, { unit: "mg/dL", flag: "high" }),
    marker("LDL Chol Calc (NIH)", 171, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const ldlNut = repo.listActiveDirectives().filter((d) => (d.marker || "") === "LDL-C" && d.domain === "nutrition");
  assert.equal(ldlNut.length, 1, "no per-name duplicate LDL nutrition directive");
});

test("a health_review LDL directive collapses with the deterministic one (cross-source)", () => {
  // The deterministic 'markers' source emits an LDL-C nutrition directive.
  seedHealthDoc("2026-06-30", [marker("LDL-C", 173, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  // The agent review names the SAME finding by a lab-specific name.
  repo.addHealthReview(
    {
      headline: "Lipids are the lead.",
      directives: [{
        domain: "nutrition",
        marker: "LDL Chol Calc (NIH)",
        directive: "Cut saturated fat and add soluble fiber to bring LDL toward optimal.",
        rationale: "LDL is the atherogenic lever.",
        citation: "AHA/ACC 2018 Cholesterol Guideline",
      }],
    },
    "stub",
  );
  const ldlKey = repo.canonicalMarker("LDL-C").key;
  const ldlNut = repo.listActiveDirectives().filter(
    (d) => d.domain === "nutrition" && repo.canonicalMarker(d.marker || "").key === ldlKey,
  );
  assert.equal(ldlNut.length, 1, "the markers + health_review LDL nutrition directives collapse to one");
  assert.equal(ldlNut[0].source, "markers", "the deterministic source is preferred");
});

test("canonicalDirectiveMarker aligns a lab-specific lipid name onto its zone label", () => {
  assert.equal(repo.canonicalDirectiveMarker("LDL Chol Calc (NIH)"), "LDL-C");
  assert.equal(repo.canonicalDirectiveMarker("Non-HDL Cholesterol"), "Non-HDL-C");
  // A synthesized cluster marker ("A+B+C") is left untouched.
  assert.equal(repo.canonicalDirectiveMarker("ApoB+LDL-C+Lp(a)"), "ApoB+LDL-C+Lp(a)");
});

// Wave H item 2 — the USER-FACING directives listing (the /directives route fn,
// listDirectives) must read through the SAME cross-source collapse as the coach prompt,
// so a "Non-HDL-C" (markers) + "Non-HDL Cholesterol" (health_review) pair reads as one
// clean row. Collapse is at READ time — the underlying rows are never deleted.
test("the /directives listing (listDirectives) collapses the cross-source non-HDL pair", () => {
  seedHealthDoc("2026-06-30", [marker("Non-HDL-C", 190, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives(); // deterministic 'markers' → Non-HDL-C nutrition + watch
  repo.addHealthReview(
    {
      headline: "Lipids lead.",
      directives: [{
        domain: "nutrition",
        marker: "Non-HDL Cholesterol",
        directive: "Cut saturated fat and add soluble fiber to bring non-HDL toward optimal.",
        rationale: "Non-HDL sums the atherogenic particles.",
        citation: "AHA/ACC 2018 Cholesterol Guideline",
      }],
    },
    "stub",
  );
  const key = repo.canonicalMarker("Non-HDL-C").key;
  const nonhdlNut = (d) => d.domain === "nutrition" && repo.canonicalMarker(d.marker || "").key === key;
  // Route-level active listing = ONE collapsed nutrition directive, deterministic source kept.
  const active = repo.listDirectives({ all: false }).filter(nonhdlNut);
  assert.equal(active.length, 1, "the cross-source non-HDL nutrition dup collapses to one row");
  assert.equal(active[0].source, "markers", "the deterministic source is preferred");
  // …but both rows still exist (collapse never deletes) — visible in the ?all history view.
  const all = repo.listDirectives({ all: true }).filter(nonhdlNut);
  assert.ok(all.length >= 2, "the underlying rows are preserved, only collapsed at read time");
});
