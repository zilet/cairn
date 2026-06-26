// Marker intelligence (src/repo.ts): getMarkerHistory trend + prioritizeMarkers
// ranking, plus the GOLDEN CONSTITUTION TEST. The constitution bans 0-100 grades
// anywhere — a marker's "impact" is an INTERNAL ordering signal, never a
// user-facing score. These cases pin the deterministic trend and prove no 0-100
// grade leaks out of the priority ranking.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker, isoDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives");
});

test("matchOptimalZone suppresses mis-routed analyte names (the clinically-wrong-directive guard)", () => {
  // Ratios, urine specimens, free-T, and lipoprotein subfractions must NOT claim a serum band.
  assert.equal(repo.matchOptimalZone("Total Cholesterol / HDL Ratio"), null);
  assert.equal(repo.matchOptimalZone("Albumin, Random Urine without Creatinine"), null);
  assert.equal(repo.matchOptimalZone("Testosterone, Free"), null);
  assert.equal(repo.matchOptimalZone("LDL Particle Number"), null);
  assert.equal(repo.matchOptimalZone("HDL Large"), null);
  // eGFR's full lab name matches the eGFR band, not the serum Creatinine band.
  assert.equal(repo.matchOptimalZone("Creatinine-Based Estimated Glomerular Filtration Rate")?.label, "eGFR");
  // The real serum analytes still match.
  assert.equal(repo.matchOptimalZone("HDL-Cholesterol")?.label, "HDL-C");
  assert.equal(repo.matchOptimalZone("Creatinine")?.label, "Creatinine");
  assert.equal(repo.matchOptimalZone("Testosterone, Total")?.label, "Testosterone");
  // New coverage zones.
  assert.equal(repo.matchOptimalZone("Body Fat %")?.label, "Body fat");
  assert.equal(repo.matchOptimalZone("Omega-3 Index")?.label, "Omega-3 index");
  assert.equal(repo.matchOptimalZone("Total Cholesterol")?.label, "Total cholesterol");
});

test("getMarkerHistory builds a per-marker series and a deterministic RISING trend", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 95, { unit: "mg/dL" })]);
  seedHealthDoc("2025-12-01", [marker("ApoB", 110, { unit: "mg/dL" })]);
  const { markers } = repo.getMarkerHistory();
  const apob = markers.find((m) => m.key === "apob");
  assert.ok(apob, "apob series present");
  assert.equal(apob.points.length, 3);
  assert.equal(apob.latest.value, 110, "latest = most recent reading");
  assert.equal(apob.trend.dir, "rising");
  assert.equal(apob.trend.change, 30); // 110 - 80
  assert.equal(apob.trend.n, 3);
  assert.ok(apob.trend.span_days > 300);
  assert.equal(apob.group, "lipids");
});

test("getMarkerHistory reports a FALLING trend when values drop", () => {
  seedHealthDoc("2025-01-01", [marker("LDL Cholesterol", 150, { flag: "high" })]);
  seedHealthDoc("2025-09-01", [marker("LDL Cholesterol", 100, { flag: "normal" })]);
  const ldl = repo.getMarkerHistory().markers.find((m) => m.key.includes("ldl"));
  assert.equal(ldl.trend.dir, "falling");
  assert.equal(ldl.trend.change, -50);
});

test("getMarkerHistory reads a flat (unchanging) series as STABLE", () => {
  // Identical readings => least-squares slope 0 => 'stable', never a spurious trend.
  // (v30 uses an LSQ fit, not a two-point delta, so the stable case is an unmoving line.)
  seedHealthDoc("2025-01-01", [marker("HbA1c", 5.4)]);
  seedHealthDoc("2025-04-01", [marker("HbA1c", 5.4)]);
  seedHealthDoc("2025-08-01", [marker("HbA1c", 5.4)]);
  const a1c = repo.getMarkerHistory().markers.find((m) => m.key.includes("hba1c") || m.key.includes("a1c"));
  assert.equal(a1c.trend.dir, "stable");
  assert.equal(a1c.trend.change, 0);
});

test("getMarkerHistory single reading => trend dir null (unknowable)", () => {
  seedHealthDoc("2025-01-01", [marker("Ferritin", 60)]);
  const f = repo.getMarkerHistory().markers.find((m) => m.key === "ferritin");
  assert.equal(f.trend.dir, null);
  assert.equal(f.trend.n, 1);
});

test("prioritizeMarkers puts lab-flagged (low/high) markers first", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 70, { flag: "normal" }),        // in-flag
    marker("Vitamin D 25-OH", 22, { flag: "low" }), // flagged
    marker("LDL Cholesterol", 130, { flag: "high" }), // flagged
  ]);
  const { markers, flagged_count } = repo.prioritizeMarkers();
  assert.equal(flagged_count, 2);
  // The first two ranked markers must be the flagged ones.
  const topTwoFlags = markers.slice(0, 2).map((m) => m.latest.flag);
  assert.ok(topTwoFlags.every((f) => f === "low" || f === "high"), "flagged markers rank first");
});

test("prioritizeMarkers carries optimal-zone framing (in_optimal + direction), not a raw verdict", () => {
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL", flag: "high" })]);
  const ldl = repo.prioritizeMarkers().markers.find((m) => m.key.includes("ldl"));
  assert.equal(ldl.in_optimal, false);            // 130 is above the optimal band
  assert.equal(ldl.optimal.dir, "high");          // higher is worse for LDL
  assert.equal(ldl.actionable, true);
});

test("getMarkerHistory normalizes SI/EU lipid units before optimal-zone reasoning", () => {
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", 3.2, { unit: "mmol/L", flag: "high" })]);
  const ldl = repo.prioritizeMarkers().markers.find((m) => m.key.includes("ldl"));
  assert.equal(ldl.latest.value, 123.7);
  assert.equal(ldl.unit, "mg/dL");
  assert.equal(ldl.latest.source_value, 3.2);
  assert.equal(ldl.latest.source_unit, "mmol/L");
  assert.equal(ldl.latest.unit_converted, true);
  assert.equal(ldl.in_optimal, false);
  assert.equal(ldl.optimal.high, 100);
});

test("getMarkerHistory trends mixed US/SI units in one canonical series", () => {
  seedHealthDoc("2025-01-01", [marker("LDL Cholesterol", 100, { unit: "mg/dL" })]);
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", "3,2", { unit: "mmol/L" })]);
  const ldl = repo.getMarkerHistory().markers.find((m) => m.key.includes("ldl"));
  assert.equal(ldl.points.length, 2);
  assert.deepEqual(ldl.points.map((p) => p.value), [100, 123.7]);
  assert.equal(ldl.prev.value, 100);
  assert.equal(ldl.trend.dir, "rising");
});

test("vitamin D nmol/L is converted before the low-side guard runs", () => {
  seedHealthDoc("2025-12-01", [marker("Vitamin D 25-OH", 50, { unit: "nmol/L" })]);
  const vd = repo.prioritizeMarkers().markers.find((m) => m.key.includes("vitamin d"));
  assert.equal(vd.latest.value, 20);
  assert.equal(vd.unit, "ng/mL");
  assert.equal(vd.in_optimal, false);
  repo.deriveDirectives();
  assert.ok(repo.listActiveDirectives().some((d) => /vitamin/i.test(d.marker || "") && /D3|supplement/i.test(d.directive || "")));
});

test("Lp(a) mass units are not compared to nmol/L with a fake fixed conversion", () => {
  seedHealthDoc("2025-12-01", [marker("Lp(a)", 40, { unit: "mg/dL" })]);
  // Series key is now the canonical marker key (marker-canon.ts: "lpa"); the
  // display name stays the lab's own "Lp(a)". Find by name so this stays robust.
  const lpa = repo.prioritizeMarkers().markers.find((m) => m.name === "Lp(a)");
  assert.equal(lpa.latest.unit_mismatch, true);
  assert.equal(lpa.latest.expected_unit, "nmol/L");
  assert.equal(lpa.optimal, null);
  assert.equal(lpa.in_optimal, null);
});

// A random / post-prandial / non-fasting glucose must NOT be held to the FASTING
// glucose optimal band (70–90) — that band only applies to a fasting draw. The
// guard suppresses the fasting zone for an explicitly non-fasting name, while
// fasting glucose, bare "Glucose", eAG and HbA1c stay matched as before.
test("matchOptimalZone: a non-fasting glucose is NOT held to the fasting band", () => {
  for (const n of ["Glucose (random)", "Glucose, random", "non-fasting glucose", "Glucose - PP", "2hr postprandial glucose"]) {
    assert.equal(repo.matchOptimalZone(n), null, `${n} must not match the fasting band`);
  }
  // Untouched: genuinely fasting / bare / eAG keep their band; HbA1c keeps its own.
  assert.equal(repo.matchOptimalZone("Glucose, Fasting")?.label, "Fasting glucose");
  assert.equal(repo.matchOptimalZone("Glucose")?.label, "Fasting glucose");
  assert.equal(repo.matchOptimalZone("Estimated Average Glucose")?.label, "Fasting glucose");
  assert.equal(repo.matchOptimalZone("HbA1c")?.label, "HbA1c");
  // Word-boundary safety: "pp" inside a word must not trip the non-fasting guard.
  assert.equal(repo.matchOptimalZone("Supplemental glucose")?.label, "Fasting glucose");
});

test("a random glucose does NOT prioritize as out-of-optimal against a fasting target", () => {
  // 130 is a normal post-meal value but would be 'high' against the fasting band.
  seedHealthDoc("2025-12-01", [marker("Glucose (random)", 130, { unit: "mg/dL" })]);
  const g = repo.prioritizeMarkers().markers.find((m) => /glucose/i.test(m.name));
  assert.ok(g, "the random-glucose series is still tracked");
  assert.equal(g.optimal, null, "no fasting optimal band is applied");
  assert.equal(g.in_optimal, null, "so it can't read out-of-optimal against a fasting target");
});

test("getMarkerHistory flags dropped readings on an incompatible-unit split (no silent truncation)", () => {
  // Lp(a) measured mg/dL twice, then nmol/L — incompatible families. The trend
  // keeps only the latest (nmol/L) unit; the older mg/dL readings are surfaced as
  // a count, never silently discarded.
  seedHealthDoc("2024-01-01", [marker("Lp(a)", 30, { unit: "mg/dL" })]);
  seedHealthDoc("2024-06-01", [marker("Lp(a)", 35, { unit: "mg/dL" })]);
  seedHealthDoc("2025-01-01", [marker("Lp(a)", 90, { unit: "nmol/L" })]);
  const lpa = repo.getMarkerHistory().markers.find((m) => m.name === "Lp(a)");
  assert.equal(lpa.points.length, 1, "trend holds only the latest unit family");
  assert.equal(lpa.unit, "nmol/L");
  assert.equal(lpa.dropped_other_units, 2, "the two mg/dL readings are surfaced as a count");
});

test("getMarkerHistory: a clean single-unit series reports dropped_other_units = 0", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 90, { unit: "mg/dL" })]);
  const apob = repo.getMarkerHistory().markers.find((m) => m.key === "apob");
  assert.equal(apob.dropped_other_units, 0);
});

test("prioritizeMarkers: a lab VO2max and a wearable VO2max collapse to one (no duplicate)", () => {
  db.prepare("DELETE FROM garmin_daily_metrics").run();
  db.prepare("DELETE FROM garmin_sources").run();
  const sid = Number(db.prepare("INSERT INTO garmin_sources (provider) VALUES ('garmin')").run().lastInsertRowid);
  // A lab "VO2 Max" canonicalizes to key "vo2 max" while the wearable spec emits
  // "vo2max" — keying the fold on the raw key let BOTH through. Dedup on the zone
  // label ("VO2max") must collapse them, with the lab reading winning.
  seedHealthDoc("2025-06-01", [marker("VO2 Max", 48, { unit: "mL/kg/min" })]);
  for (let i = 0; i < 4; i++) {
    db.prepare("INSERT INTO garmin_daily_metrics (source_id, date, vo2max) VALUES (?, ?, ?)").run(sid, isoDaysAgo(i), 50);
  }
  const vo2 = repo.prioritizeMarkers().markers.filter((m) => /vo2/i.test(String(m.name)));
  assert.equal(vo2.length, 1, "lab + wearable VO2max collapse to one entry");
  assert.notEqual(vo2[0].source, "wearable", "the lab reading wins over the device estimate");

  // With NO lab present the wearable VO2max still surfaces (the fold isn't broken).
  db.prepare("DELETE FROM health_documents").run();
  const wearableOnly = repo.prioritizeMarkers().markers.filter((m) => /vo2/i.test(String(m.name)));
  assert.equal(wearableOnly.length, 1);
  assert.equal(wearableOnly[0].source, "wearable");
});

// ---- GOLDEN CONSTITUTION TEST ----------------------------------------------
// The constitution forbids surfacing a 0-100 grade ANYWHERE. impact_score is an
// internal ordering signal; whether or not it is stripped at the surface, the
// hard invariant is that NO field is ever a 0-100 (or 0-1 percent) user-facing
// GRADE. These assertions hold today and must keep holding as the surface evolves.
test("GOLDEN: no marker carries a 0-100 grade / score / rating / percent field", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 110, { unit: "mg/dL", flag: "high" }),
    marker("Vitamin D 25-OH", 18, { unit: "ng/mL", flag: "low" }),
    marker("Ferritin", 250, { unit: "ng/mL", flag: "high" }),
  ]);
  const { markers } = repo.prioritizeMarkers();
  for (const m of markers) {
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== "number") continue;
      // impact_score is the only score-shaped field; assert it is a bounded
      // INTERNAL ordering signal (small, never a 0-100 grade), and that nothing
      // else masquerades as a percentage/rating grade in the 0-100 band.
      if (k === "impact_score") {
        assert.ok(v >= 0 && v <= 3, `impact_score must be a small internal signal, got ${v}`);
        continue;
      }
      if (/grade|rating|percent|pct|out_of/i.test(k)) {
        assert.fail(`unexpected grade-shaped field "${k}" = ${v} leaked to a marker`);
      }
    }
  }
});

test("GOLDEN: prioritizeMarkers never serializes the internal impact_score (constitution: no scores)", () => {
  // The ordering signal is computed internally and STRIPPED before it crosses the
  // API/MCP boundary — a serialized marker must carry no impact_score (nor any
  // 0-100 grade). This is the user-facing no-scores guarantee, enforced.
  seedHealthDoc("2025-12-01", [marker("ApoB", 400, { unit: "mg/dL", flag: "high" })]);
  const m = repo.prioritizeMarkers().markers[0];
  assert.ok(!("impact_score" in m), "impact_score must not be serialized over API/MCP");
  assert.equal(m.impact_score, undefined);
});
