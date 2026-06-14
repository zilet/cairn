// Marker intelligence (src/repo.ts): getMarkerHistory trend + prioritizeMarkers
// ranking, plus the GOLDEN CONSTITUTION TEST. The constitution bans 0-100 grades
// anywhere — a marker's "impact" is an INTERNAL ordering signal, never a
// user-facing score. These cases pin the deterministic trend and prove no 0-100
// grade leaks out of the priority ranking.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives");
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
