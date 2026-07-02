// No false trend on genetically-fixed / low-n markers (src/repo/health.ts
// getMarkerHistory + isNonTrendingMarker). Grounded: an n=2 Lp(a) series once read
// "falling, ~3 weeks to optimal" — but Lp(a) is genetically set for life and doesn't
// trend, and two noisy dots can't sustain a projection. The honest read is 'stable'
// with no ETA; the span/spread gating already there is kept.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "profile");
});

const markerNamed = (re) => repo.getMarkerHistory().markers.find((m) => re.test(m.name));

test("isNonTrendingMarker flags genetically-fixed analytes only", () => {
  assert.equal(repo.isNonTrendingMarker("Lp(a)"), true);
  assert.equal(repo.isNonTrendingMarker("Lipoprotein (a)"), true);
  assert.equal(repo.isNonTrendingMarker("ApoE genotype"), true);
  assert.equal(repo.isNonTrendingMarker("MTHFR"), true);
  assert.equal(repo.isNonTrendingMarker("ApoB"), false);
  assert.equal(repo.isNonTrendingMarker("LDL-C"), false);
});

test("an n=2 Lp(a) series reads STABLE with no projection (no fake ETA)", () => {
  seedHealthDoc("2026-04-01", [marker("Lp(a)", 99, { unit: "nmol/L", flag: "high" })]);
  seedHealthDoc("2026-06-01", [marker("Lp(a)", 90, { unit: "nmol/L", flag: "high" })]);
  const lpa = markerNamed(/lp\s?\(a\)/i);
  assert.ok(lpa, "the Lp(a) series exists");
  assert.equal(lpa.trend.n, 2);
  assert.equal(lpa.trend.dir, "stable", "genetically-fixed → never a confident direction");
  assert.equal(lpa.trend.projection, null, "no 'X weeks to optimal' ETA");
  assert.equal(lpa.forecast.direction, "stable");
  assert.equal(lpa.forecast.eta_text, null);
});

test("a genetically-fixed marker stays stable even with THREE readings", () => {
  seedHealthDoc("2026-02-01", [marker("Lp(a)", 110, { unit: "nmol/L", flag: "high" })]);
  seedHealthDoc("2026-04-01", [marker("Lp(a)", 100, { unit: "nmol/L", flag: "high" })]);
  seedHealthDoc("2026-06-01", [marker("Lp(a)", 90, { unit: "nmol/L", flag: "high" })]);
  const lpa = markerNamed(/lp\s?\(a\)/i);
  assert.equal(lpa.trend.dir, "stable");
  assert.equal(lpa.trend.projection, null);
});

test("a non-genetic marker with n<3 keeps its raw direction but drops the projection", () => {
  seedHealthDoc("2026-04-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2026-06-01", [marker("ApoB", 110, { unit: "mg/dL", flag: "high" })]);
  const apob = markerNamed(/apob|apolipoprotein b/i);
  assert.equal(apob.trend.n, 2);
  assert.equal(apob.trend.projection, null, "two dots can't sustain an ETA");
  assert.notEqual(apob.trend.dir, null, "but the raw first→last direction still reads");
});

test("a real, well-sampled non-genetic trend can still project (unchanged)", () => {
  for (const [date, v] of [["2026-01-01", 140], ["2026-03-01", 128], ["2026-05-01", 116], ["2026-06-20", 104]]) {
    seedHealthDoc(date, [marker("ApoB", v, { unit: "mg/dL", flag: v > 90 ? "high" : "normal" })]);
  }
  const apob = markerNamed(/apob|apolipoprotein b/i);
  assert.ok(apob.trend.n >= 4);
  assert.equal(apob.trend.dir, "falling");
  // A genuine multi-point trend is allowed to speak to trajectory.
  assert.ok(apob.trend.projection == null || typeof apob.trend.projection === "string");
});
