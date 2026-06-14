// Trust-build (round 2) surface: the verifiable + trustworthy additions.
// Covers the code-enforced apply guardrails (V1), the research/safety pure
// functions + evidence cache (Stream 4), marker forecasting + cross-marker
// clusters (Stream 3), and self-updating memory supersession (Stream 2) — the
// pieces the harness couldn't reach when it was first written on a stale base.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("plan_items", "plan_days", "memory", "evidence_cache", "health_documents", "health_directives");
});

// ---------- code-enforced apply guardrails (the headline trust feature) ----------

test("apply-path clamp caps an implausible load jump (off-spec agent value can't apply)", () => {
  repo.savePlanDay(1, "Day 1", "legs", [{ exercise: "ZTest Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 190 }]);
  repo.updateTarget(1, "ZTest Squat", 270, undefined, { clamp: true }); // +80 lb proposal
  const item = repo.getPlanDay(1).items.find((i) => i.exercise === "ZTest Squat");
  assert.ok(item.target_weight <= 209, `clamped to a safe step (max ~10% / 10lb), got ${item.target_weight}`);
  assert.ok(item.target_weight > 190, "still progresses — a clamp, not a freeze");
});

test("a deliberate manual edit is NEVER clamped — the user drives", () => {
  repo.savePlanDay(1, "Day 1", "legs", [{ exercise: "ZTest Squat", sets: 3, target_weight: 190 }]);
  repo.updateTarget(1, "ZTest Squat", 270, undefined); // no {clamp:true} => verbatim
  const item = repo.getPlanDay(1).items.find((i) => i.exercise === "ZTest Squat");
  assert.equal(item.target_weight, 270);
});

test("apply-path clamp holds load on an injury-constrained exercise", () => {
  const ex = repo.upsertExercise({ name: "ZTest Knee Ext" });
  repo.updateExercise(ex.id, { constraint_note: "left knee — keep it light" });
  repo.savePlanDay(2, "Day 2", "legs", [{ exercise: "ZTest Knee Ext", sets: 3, target_weight: 100 }]);
  repo.updateTarget(2, "ZTest Knee Ext", 150, undefined, { clamp: true });
  const item = repo.getPlanDay(2).items.find((i) => i.exercise === "ZTest Knee Ext");
  assert.ok(item.target_weight <= 100, `constrained exercise held on increase, got ${item.target_weight}`);
});

// ---------- evidence cache + citation verification + safety gate (grounding) ----------

test("getEvidenceForMarker is empty until research caches a row, then round-trips", () => {
  assert.deepEqual(repo.getEvidenceForMarker("ApoB").evidence, []);
  repo.addEvidence({
    marker: "ApoB", claim: "Lower ApoB lowers ASCVD risk",
    source_title: "AHA/ACC 2018 Cholesterol Guideline",
    source_url: "https://www.ahajournals.org/doi/10.1161/CIR.0000000000000625",
    body: "Apolipoprotein B is a causal driver of atherosclerosis.", confidence: "high",
  });
  const ev = repo.getEvidenceForMarker("ApoB");
  assert.equal(ev.evidence.length, 1);
  assert.equal(ev.evidence[0].source_title, "AHA/ACC 2018 Cholesterol Guideline");
});

test("verifyCitation accepts a guideline body and strips an unverifiable claim", () => {
  const ok = repo.verifyCitation("AHA/ACC 2018 Cholesterol Guideline");
  assert.equal(ok.verified, true);
  assert.equal(ok.uncertain, false);
  const bad = repo.verifyCitation("trust me — a random blog post");
  assert.equal(bad.verified, false);
  assert.equal(bad.uncertain, true);
  assert.equal(bad.citation, null); // stripped, but the directive survives (uncertain)
});

test("isPlausibleSourceUrl rejects internal/non-http URLs (SSRF-shaped), accepts a real https source", () => {
  assert.equal(repo.isPlausibleSourceUrl("https://www.nih.gov/health"), true);
  assert.equal(repo.isPlausibleSourceUrl("http://localhost/admin"), false);
  assert.equal(repo.isPlausibleSourceUrl("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(repo.isPlausibleSourceUrl("ftp://files/x"), false);
  assert.equal(repo.isPlausibleSourceUrl("not a url"), false);
});

test("safetyGate annotates a contradictory iron suggestion when ferritin is already replete", () => {
  seedHealthDoc("2025-12-01", [marker("Ferritin", 350, { unit: "ng/mL", flag: "high" })]);
  const ctx = repo.buildSafetyMarkerContext();
  const res = repo.safetyGate(
    { domain: "nutrition", marker: "Ferritin", directive: "Add an iron supplement to raise ferritin." },
    ctx
  );
  assert.equal(res.annotated, true);
  assert.equal(res.uncertain, true); // a contradicted supplement is a softer nudge, never silently applied
});

// ---------- marker forecasting (predictive, plain-language, no score) ----------

test("a marker drifting further from optimal reads as RISING and forecasts WORSENING", () => {
  seedHealthDoc("2025-01-01", [marker("ApoB", 90, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2025-04-01", [marker("ApoB", 110, { unit: "mg/dL", flag: "high" })]);
  seedHealthDoc("2025-08-01", [marker("ApoB", 130, { unit: "mg/dL", flag: "high" })]);
  const apob = repo.getMarkerHistory().markers.find((m) => (m.label || "").toLowerCase().includes("apob") || m.key.includes("apob"));
  assert.equal(apob.trend.dir, "rising");
  assert.equal(apob.forecast.direction, "worsening");
  assert.equal(typeof apob.trend.projection, "string"); // plain language, never a number-as-score
});

// ---------- cross-marker synthesis (the connected brain compounds, not isolates) ----------

test("low ferritin + low hemoglobin surfaces an anemia-pattern read", () => {
  seedHealthDoc("2025-12-01", [
    marker("Ferritin", 12, { unit: "ng/mL", flag: "low" }),
    marker("Hemoglobin", 11.5, { unit: "g/dL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const blob = repo.listActiveDirectives().map((d) => `${d.marker || ""} ${d.directive || ""} ${d.rationale || ""}`).join(" ").toLowerCase();
  assert.ok(/anemia|iron[- ]defic/.test(blob), "an anemia / iron-deficiency pattern is surfaced");
});

// ---------- self-updating memory: supersession marks, never deletes ----------

test("supersedeMemory marks (not deletes) and hides the old row from the coach by default", () => {
  resetTables("memory");
  const m = repo.addMemory("Trains in the mornings", "preference", "test");
  repo.addMemory("trains in the mornings", "preference", "test"); // case-only dup folds
  assert.equal(repo.listMemory(50).filter((x) => x.kind === "preference").length, 1, "duplicate folded, log didn't grow");

  repo.supersedeMemory(m.id, { content: "Now trains in the evenings", kind: "preference", reason: "schedule changed" });
  assert.ok(!repo.listMemory(50).find((x) => x.id === m.id), "superseded row hidden from the default (coach) view");
  assert.ok(repo.listMemory(50, { includeSuperseded: true }).find((x) => x.id === m.id), "but still in the DB — marked, recoverable, never hard-deleted");
});

test("memoryForCoach retains load-bearing kinds (an injury constraint)", () => {
  resetTables("memory");
  repo.addMemory("Left shoulder impingement — avoid overhead press", "injury", "test");
  for (let i = 0; i < 20; i++) repo.addMemory(`stray observation number ${i}`, "observation", "test");
  const coach = repo.memoryForCoach(40);
  assert.ok(coach.some((x) => x.kind === "injury"), "a load-bearing injury is never evicted by chatter");
});

// ---------- settings: the new trust/proactivity toggles round-trip ----------

test("proactive_enabled and research_enabled persist through setSettings/getSettings", () => {
  const before = repo.getSettings();
  repo.setSettings({ proactive_enabled: false, research_enabled: true });
  const after = repo.getSettings();
  assert.equal(after.proactive_enabled, false);
  assert.equal(after.research_enabled, true);
  repo.setSettings({ proactive_enabled: before.proactive_enabled, research_enabled: before.research_enabled });
});
