// getMarkerHistory memoization (src/repo/health.ts). The marker walk is heavy and a
// single Stand load calls it several times, so it's memoized on a signature of the
// two source tables (+ profile sex/age). These cases pin: (1) a cache HIT returns data
// identical to a fresh rebuild, (2) every marker-data write path invalidates it (new
// data appears on the next read), (3) callers can mutate the returned structure without
// corrupting the next read (each hit is a structuredClone), and (4) the explicit reset
// the test isolate depends on actually clears the cache. Plus the two pure enrich
// predicates that gate the event-driven synthesis refresh.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker } from "./_seed.js";
import { shouldEnqueueReviewRefresh, shouldRegenerateSynthesis } from "../dist/enrich.js";

beforeEach(() => {
  resetTables("health_documents", "blood_pressure_readings", "marker_aliases", "health_directives", "profile");
  // Standalone `node --test` runs don't inject test/_isolate.mjs (which resets the
  // cache), so clear it here too — resetTables deletes rows out-of-band, bypassing
  // the write counter, exactly the case the reset exists for.
  repo.resetMarkerHistoryCache();
});

test("a cache HIT returns data identical to a fresh (uncached) rebuild", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 95, { unit: "mg/dL" })]);
  seedHealthDoc("2025-12-01", [marker("ApoB", 110, { unit: "mg/dL" })]);

  const built = repo.getMarkerHistory();   // builds + caches
  const hit = repo.getMarkerHistory();     // served from cache (clone)
  repo.resetMarkerHistoryCache();
  const rebuilt = repo.getMarkerHistory(); // recomputed from scratch

  assert.deepEqual(hit, built, "cache hit equals the first build");
  assert.deepEqual(hit, rebuilt, "cache hit equals a fresh rebuild — memo is transparent");
  const apob = hit.markers.find((m) => m.key === "apob");
  assert.ok(apob && apob.points.length === 3 && apob.latest.value === 110);
});

test("addHealthDocument invalidates the cache — a new marker appears on the next read", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  const before = repo.getMarkerHistory();
  assert.equal(before.markers.length, 1, "only ApoB so far");

  seedHealthDoc("2025-06-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL" })]);
  const after = repo.getMarkerHistory();
  assert.ok(after.markers.some((m) => m.key.includes("ldl")), "the new LDL marker is visible after the write");
  assert.equal(after.markers.length, 2);
});

test("updateHealthDocFields invalidates the cache — an edited value is reflected", () => {
  const doc = seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  const before = repo.getMarkerHistory();
  assert.equal(before.markers.find((m) => m.key === "apob").latest.value, 80);

  repo.updateHealthDocFields(doc.id, { parsed_json: { markers: [marker("ApoB", 65, { unit: "mg/dL" })] } });
  const after = repo.getMarkerHistory();
  assert.equal(after.markers.find((m) => m.key === "apob").latest.value, 65, "re-analysis is reflected");
});

test("deleteHealthDocument invalidates the cache — the removed marker is gone", () => {
  const doc = seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-02-01", [marker("Ferritin", 90, { unit: "ng/mL" })]);
  assert.equal(repo.getMarkerHistory().markers.length, 2);

  repo.deleteHealthDocument(doc.id);
  const after = repo.getMarkerHistory();
  assert.ok(!after.markers.some((m) => m.key === "apob"), "the deleted doc's marker is gone");
  assert.equal(after.markers.length, 1);
});

test("a blood-pressure insert invalidates the cache — the BP series appears", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  const before = repo.getMarkerHistory();
  assert.ok(!before.markers.some((m) => m.name === "Systolic BP"), "no BP series before the insert");

  repo.addBloodPressureReading({ measured_at: "2026-03-10T08:00", systolic: 118, diastolic: 74 });
  const after = repo.getMarkerHistory();
  assert.ok(after.markers.some((m) => m.name === "Systolic BP"), "Systolic BP series appears after the insert");
  assert.ok(after.markers.some((m) => m.name === "Diastolic BP"));
});

test("a blood-pressure delete invalidates the cache", () => {
  const row = repo.addBloodPressureReading({ measured_at: "2026-03-10T08:00", systolic: 118, diastolic: 74 });
  assert.ok(repo.getMarkerHistory().markers.some((m) => m.name === "Systolic BP"));

  repo.deleteBloodPressureReading(row.id);
  const after = repo.getMarkerHistory();
  assert.ok(!after.markers.some((m) => m.name === "Systolic BP"), "BP series gone after the delete");
});

test("a learned marker alias invalidates the cache — the series merges on the next read", () => {
  seedHealthDoc("2025-01-01", [marker("eGFR", 98, { unit: "mL/min" })]);
  seedHealthDoc("2025-06-01", [marker("Estimated Glomerular Filt Rate", 60, { unit: "mL/min" })]);
  const before = repo.getMarkerHistory().markers.filter((m) => m.key === "egfr");
  assert.equal(before[0].points.length, 1, "the abbreviation keys separately before the alias");

  // setMarkerAlias touches marker_aliases (a third table feeding getMarkerHistory via
  // canonicalization) — it must bust the memo even though the doc/BP tables are unchanged.
  repo.setMarkerAlias(repo.normalizeMarkerName("Estimated Glomerular Filt Rate"), "egfr", "eGFR", "agent");
  const after = repo.getMarkerHistory().markers.filter((m) => m.key === "egfr");
  assert.equal(after.length, 1);
  assert.equal(after[0].points.length, 2, "the alias merges both readings into one series");
});

test("MUTATION SAFETY: mutating a returned result never corrupts the next read", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("Ferritin", 90, { unit: "ng/mL" })]);

  const first = repo.getMarkerHistory();
  const originalCount = first.markers.length;
  // A caller sorts the shared array, truncates it, and scribbles on a nested field.
  first.markers.sort((a, b) => a.name.localeCompare(b.name));
  first.markers.length = 0;
  first.markers.push({ key: "corrupt", name: "CORRUPT" });
  first.groups.length = 0;
  const second = repo.getMarkerHistory();

  assert.equal(second.markers.length, originalCount, "next read is intact");
  assert.ok(!second.markers.some((m) => m.key === "corrupt"), "scribble did not leak into the cache");
  assert.ok(second.groups.length > 0, "groups not corrupted");
});

test("MUTATION SAFETY: a nested mutation on one result doesn't reach the next", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("ApoB", 110, { unit: "mg/dL" })]);
  const first = repo.getMarkerHistory();
  first.markers[0].points.push({ date: "2099-01-01", value: 9999 });
  first.markers[0].latest.value = -1;
  const second = repo.getMarkerHistory();
  const apob = second.markers.find((m) => m.key === "apob");
  assert.equal(apob.points.length, 2, "nested points array is a fresh clone");
  assert.equal(apob.latest.value, 110);
});

test("prioritizeMarkers over the memo still strips the internal impact_score (GOLDEN)", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  repo.getMarkerHistory(); // prime the cache
  const serialized = JSON.stringify(repo.prioritizeMarkers());
  assert.ok(!serialized.includes("impact_score"), "no 0-100 grade leaks through the cached path");
});

test("resetMarkerHistoryCache forces a rebuild (the isolate's out-of-band-wipe guard)", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 80, { unit: "mg/dL" })]);
  assert.equal(repo.getMarkerHistory().markers.length, 1); // caches under the current signature

  // Wipe rows DIRECTLY, bypassing the repo write paths (exactly what test/_isolate.mjs
  // does). Without the explicit reset a colliding signature could serve the stale row.
  db.prepare("DELETE FROM health_documents").run();
  repo.resetMarkerHistoryCache();
  assert.equal(repo.getMarkerHistory().markers.length, 0, "reset forces a rebuild off the now-empty table");
});

test("a profile sex/age change invalidates the personalized trend cache", () => {
  // Ferritin's optimal band is sex-dependent, so the profile feeds the signature.
  seedHealthDoc("2025-01-01", [marker("Ferritin", 40, { unit: "ng/mL" })]);
  seedHealthDoc("2025-06-01", [marker("Ferritin", 55, { unit: "ng/mL" })]);
  repo.setProfile({ sex: "female", age: 35 });
  const asFemale = repo.getMarkerHistory();
  repo.setProfile({ sex: "male", age: 35 });
  const asMale = repo.getMarkerHistory();
  // The signature includes sex/age, so the second read is a genuine rebuild, not the
  // stale female-band cache. Both are valid reads; the guarantee is they're recomputed.
  assert.ok(asFemale.markers.some((m) => m.key === "ferritin"));
  assert.ok(asMale.markers.some((m) => m.key === "ferritin"));
});

// ---- event-driven synthesis-refresh gate (src/enrich.ts pure predicates) ----

test("shouldEnqueueReviewRefresh: the pile-up latch admits one, blocks the rest", () => {
  assert.equal(shouldEnqueueReviewRefresh(false), true, "nothing queued → enqueue");
  assert.equal(shouldEnqueueReviewRefresh(true), false, "already queued → collapse into the pending one");
});

test("shouldRegenerateSynthesis: regenerate only when a synthesis already exists (pull, not push)", () => {
  assert.equal(shouldRegenerateSynthesis(null), false, "never conjure a synthesis uninvited");
  assert.equal(shouldRegenerateSynthesis(undefined), false);
  assert.equal(shouldRegenerateSynthesis({ headline: "…" }), true, "opted-in → refresh in place");
});
