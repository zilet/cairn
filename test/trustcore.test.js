// Trust-build (round 2) surface: the verifiable + trustworthy additions.
// Covers the code-enforced apply guardrails (V1), the research/safety pure
// functions + evidence cache (Stream 4), marker forecasting + cross-marker
// clusters (Stream 3), and self-updating memory supersession (Stream 2) — the
// pieces the harness couldn't reach when it was first written on a stale base.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

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

// Applying one training proposal retires the OTHER open training drafts (they were
// alternative reads of the same week) — marked 'superseded', distinct from a user
// 'discarded'. An advisory nutrition_target draft is a different category and is left
// alone (it's applied from Energy Balance, not the proposals list).
test("applying a training proposal retires sibling training drafts, leaves a nutrition_target draft", () => {
  resetTables("plan_proposals", "plan_items", "plan_days");
  repo.savePlanDay(1, "Day 1", "legs", [{ exercise: "ZSupSquat", sets: 3, target_weight: 190 }]);
  const draftA = repo.createProposal("stub", "", "{}", { summary: "a", changes: [{ day_number: 1, exercise: "ZSupSquat", target_weight: 195, reason: "x" }] });
  const draftB = repo.createProposal("stub", "", "{}", { summary: "b", changes: [{ day_number: 1, exercise: "ZSupSquat", target_weight: 200, reason: "y" }] });
  const nut = repo.createProposal("stub", "", "{}", { kind: "nutrition_target", nutrition: { target_kcal: 2400, protein_g: 180 } });

  repo.applyProposal(draftB.id);

  const byId = Object.fromEntries(repo.listProposals(20).map((p) => [p.id, p.status]));
  assert.equal(byId[draftB.id], "applied", "the applied proposal is applied");
  assert.equal(byId[draftA.id], "superseded", "the sibling training draft is retired");
  assert.equal(byId[nut.id], "draft", "the nutrition_target draft is a different category — untouched");
});

test("accepting a meal plan retires the other meal-plan drafts", () => {
  resetTables("meal_plans");
  const a = repo.createMealPlan("stub", "{}", { daily_kcal: 2200, days: [] });
  const b = repo.createMealPlan("stub", "{}", { daily_kcal: 2300, days: [] });
  repo.acceptMealPlan(b.id);
  const byId = Object.fromEntries(repo.listMealPlans(20).map((p) => [p.id, p.status]));
  assert.equal(byId[b.id], "accepted", "the accepted plan is kept");
  assert.equal(byId[a.id], "superseded", "the other draft is retired");
});

// A proposal can carry a week of run prescriptions (`cardio`) applied SURGICALLY:
// each run attaches to its day, replacing that day's cardio while strength stays put;
// a day with no plan yet is created as a dedicated run day. This is how a runner/hybrid
// athlete accepts "this week's runs" without a full-plan restructure.
test("applying a proposal's cardio prescriptions adds runs without disturbing strength", () => {
  resetTables("plan_proposals", "plan_items", "plan_days");
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "ZRunSquat", sets: 3, target_weight: 185 }]);
  const p = repo.createProposal("stub", "", "{}", {
    summary: "base week",
    changes: [{ day_number: 1, exercise: "ZRunSquat", target_weight: 190, reason: "progress" }],
    cardio: [
      { day_number: 1, label: "Easy run", target_distance_km: 8, target_zone: "Z2", reason: "aerobic base" },
      { day_number: 6, label: "Long run", target_distance_km: 16, target_zone: "easy", reason: "weekly long" },
    ],
  });
  repo.applyProposal(p.id);

  // Day 1 keeps its (progressed) strength item AND gains the easy run.
  const d1 = repo.getPlanDay(1);
  const d1strength = d1.items.filter((i) => i.kind !== "cardio");
  const d1cardio = d1.items.filter((i) => i.kind === "cardio");
  assert.equal(d1strength.length, 1, "strength work preserved");
  assert.equal(d1strength[0].target_weight, 190, "strength target progressed in place");
  assert.equal(d1cardio.length, 1, "the easy run was added to day 1");
  assert.equal(d1cardio[0].target_distance_km, 8);
  assert.equal(d1cardio[0].target_zone, "Z2");

  // Day 6 was created as a dedicated run day with the long run.
  const d6 = repo.getPlanDay(6);
  assert.ok(d6, "a dedicated run day was created");
  const d6cardio = d6.items.filter((i) => i.kind === "cardio");
  assert.equal(d6cardio.length, 1);
  assert.equal(d6cardio[0].target_distance_km, 16);
});

// Applying a proposal whose change references a movement NOT yet on that day ADDS it
// — the coach's most natural plan edit ("add a back movement"). This used to vanish:
// applyProposal looped updateTarget, whose UPDATE matched zero rows, yet the proposal
// still flipped to 'applied' and the UI claimed "✓ Applied" over a no-op.
test("applying a proposal ADDS a movement that isn't on the day yet (not a silent no-op)", () => {
  resetTables("plan_proposals", "plan_items", "plan_days");
  repo.savePlanDay(1, "Lower A", "legs", [{ exercise: "ZAddSquat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 190 }]);
  const p = repo.createProposal("stub", "", "{}", {
    summary: "add a back movement",
    changes: [{ day_number: 1, exercise: "ZSingleArmRow", target_weight: 55, reason: "raise back volume conservatively" }],
  });

  const r = repo.applyProposal(p.id);
  assert.equal(r.ok, true, "the apply concretely succeeded");
  assert.equal(r.added.length, 1, "the movement was ADDED, not skipped");

  const d1 = repo.getPlanDay(1);
  const names = d1.items.map((i) => i.exercise);
  assert.ok(names.includes("ZSingleArmRow"), "the new movement is on the plan day");
  assert.ok(names.includes("ZAddSquat"), "the existing work is preserved");
  const row = d1.items.find((i) => i.exercise === "ZSingleArmRow");
  assert.equal(row.target_weight, 55, "carries the proposed target");
  assert.match(row.note || "", /back volume/i, "carries the coach's reason as the note");
  assert.equal(repo.getProposal(p.id).status, "applied", "marked applied because it really applied");
});

// The honest-feedback guard: when NOTHING can apply, the proposal must NOT lie
// "applied" — it stays a live draft and reports ok:false so the surface can say so.
test("applyProposal reports ok:false (no false 'applied') when a change can't apply", () => {
  resetTables("plan_proposals", "plan_items", "plan_days");
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "ZNoopSquat", sets: 3, target_weight: 185 }]);
  const p = repo.createProposal("stub", "", "{}", {
    summary: "tweak a day that doesn't exist",
    changes: [{ day_number: 99, exercise: "ZNoopSquat", target_weight: 190, reason: "x" }],
  });

  const r = repo.applyProposal(p.id);
  assert.equal(r.ok, false, "honest: nothing changed");
  assert.ok(r.skipped.length >= 1, "the impossible change is reported as skipped");
  assert.equal(repo.getProposal(p.id).status, "draft", "the proposal stays a live draft — not falsely applied");
});

// A target tweak phrased with light name drift updates the EXISTING prescription
// (normalized-key match) instead of adding a near-duplicate movement.
test("applyPlanChange updates an existing item via a normalized-key match (no duplicate)", () => {
  resetTables("plan_proposals", "plan_items", "plan_days");
  repo.savePlanDay(1, "Pull", "back", [{ exercise: "Dead Hang Timed", sets: 3, target_seconds: 30 }]);
  // "Dead Hang" normalizes to the same key as "Dead Hang Timed" → update, not add.
  const r = repo.applyPlanChange({ day_number: 1, exercise: "Dead Hang", target_seconds: 45 }, {});
  assert.equal(r.action, "updated", "matched the existing movement by normalized key");
  const items = repo.getPlanDay(1).items;
  assert.equal(items.length, 1, "no duplicate movement was created");
  assert.equal(items[0].target_seconds, 45, "the existing prescription was updated");
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

test("verifyCitation matches short acronyms on word boundaries (no 'who' inside 'Whoop')", () => {
  // The short-acronym allowlist must not false-accept a substring: "Whoop" contains
  // "who", "across" contains "acr", "Canada" contains "ada" — none are guideline bodies.
  for (const fake of ["Whoop-derived cohort, 2024", "a study of who responds to statins", "data from across the cohort"]) {
    const r = repo.verifyCitation(fake);
    assert.equal(r.verified, false, `"${fake}" must NOT verify as a guideline body`);
  }
  // A genuine short-acronym body on a word boundary still verifies.
  assert.equal(repo.verifyCitation("WHO 2023 physical activity guidelines").verified, true);
  assert.equal(repo.verifyCitation("NIH Office of Dietary Supplements").verified, true);
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

// The text-only blind spot: a contraindicated supplement phrased WITHOUT the obvious
// trigger words ("iron"/"supplement"/"add") used to slip past the gate. Now a
// supplement-name from the lexicon (ferrous bisglycinate) catches it on its own.
test("safetyGate catches a contraindicated iron combo phrased without 'iron'/'supplement'", () => {
  seedHealthDoc("2025-12-01", [marker("Ferritin", 350, { unit: "ng/mL", flag: "high" })]);
  const ctx = repo.buildSafetyMarkerContext();
  const res = repo.safetyGate(
    { domain: "nutrition", marker: "Ferritin", directive: "Boost your stores with a daily ferrous bisglycinate." },
    ctx
  );
  assert.equal(res.annotated, true, "the supplement-name lexicon caught it without the word 'iron'");
  assert.equal(res.uncertain, true);
});

// "keep taking your usual creatine scoop" — no "supplement"/"add" verb, but the
// supplement name 'creatine' implies intent on its own. Caught when eGFR is low.
test("safetyGate catches a verb-less creatine combo when kidney markers are off-optimal", () => {
  seedHealthDoc("2025-12-01", [marker("eGFR", 55, { unit: "mL/min", flag: "low" })]);
  const ctx = repo.buildSafetyMarkerContext();
  const res = repo.safetyGate(
    { domain: "nutrition", marker: "Creatine", directive: "Keep taking your usual creatine scoop." },
    ctx
  );
  assert.equal(res.annotated, true);
  assert.equal(res.uncertain, true);
});

// Marker-field keying broadens the analyte word, but a verb is STILL required — a
// directive merely ABOUT a marker (no supplement intent) must not trip the gate.
test("safetyGate fires off the structured marker field + a verb (text avoids the obvious word)", () => {
  seedHealthDoc("2025-12-01", [marker("Vitamin D", 70, { unit: "ng/mL", flag: "high" })]);
  const ctx = repo.buildSafetyMarkerContext();
  const res = repo.safetyGate(
    // text says "take a high dose" but never "vitamin D"/"D3" — the marker field carries it
    { domain: "nutrition", marker: "Vitamin D", directive: "You could take a high dose to push it higher." },
    ctx
  );
  assert.equal(res.annotated, true, "the marker field + 'take'/'high dose' verb tripped the D rule");
  assert.equal(res.uncertain, true);
});

// Conservative: a directive that only DISCUSSES a marker (no supplement/dose verb)
// is left untouched — no false alarm on an unrelated/observational directive.
test("safetyGate does NOT fire on a marker-only directive with no supplement intent", () => {
  seedHealthDoc("2025-12-01", [marker("Ferritin", 350, { unit: "ng/mL", flag: "high" })]);
  const ctx = repo.buildSafetyMarkerContext();
  const res = repo.safetyGate(
    { domain: "watch", marker: "Ferritin", directive: "Your ferritin is on the higher side — worth rechecking at your next panel." },
    ctx
  );
  assert.equal(res.annotated, false, "no supplement/dose verb → no annotation");
  assert.equal(res.uncertain, false);
});

// The kidney MARKER "Creatinine" must never self-trip the creatine SUPPLEMENT rule
// (\bcreatine\b excludes the longer word) — a directive about creatinine isn't a
// creatine-supplement suggestion.
test("safetyGate does NOT confuse the creatinine marker for creatine supplementation", () => {
  seedHealthDoc("2025-12-01", [marker("eGFR", 55, { unit: "mL/min", flag: "low" })]);
  const ctx = repo.buildSafetyMarkerContext();
  const res = repo.safetyGate(
    { domain: "watch", marker: "Creatinine", directive: "Take your creatinine reading with a grain of salt — it tracks muscle mass." },
    ctx
  );
  assert.equal(res.annotated, false, "'creatinine' is the marker, not the supplement — no false alarm");
});

// ---------- day_read outcome learning: idempotent per (kind, date) ----------
// The /today-read handler records a day_read suggestion for outcome learning even on
// the cache HIT (the canonical read is precomputed nightly + served cached every
// morning, so otherwise reconcileOutcomes would have almost no day_read rows). It
// dedupes the CANONICAL read per (kind, date) — repeated opens don't pile up — while
// an OVERRIDE read (a transient steer with its own payload) always records. These
// guard the dedup CONTRACT the handler's recordDayReadSuggestion helper relies on.
const CANONICAL_DAY_READ_EXISTS =
  `SELECT 1 FROM suggestions WHERE kind='day_read' AND date=? AND payload_json LIKE '%"override":null%' LIMIT 1`;
const countDayReads = (date) =>
  db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind='day_read' AND date=?`).get(date).n;

test("canonical day_read suggestion is detectable + deduped per (kind, date); override is distinct", () => {
  resetTables("suggestions");
  const date = "2026-06-22";
  assert.equal(!!db.prepare(CANONICAL_DAY_READ_EXISTS).get(date), false, "nothing recorded yet");

  // First canonical open records.
  repo.recordSuggestion("day_read", date, { kind: "train", focus: "legs", est_minutes: 60, override: null });
  assert.equal(!!db.prepare(CANONICAL_DAY_READ_EXISTS).get(date), true, "canonical row is detectable");
  assert.equal(countDayReads(date), 1);

  // A repeat canonical open is deduped (the handler's guard short-circuits) — count
  // stays 1 because the existence check found the prior canonical row.
  if (!db.prepare(CANONICAL_DAY_READ_EXISTS).get(date)) {
    repo.recordSuggestion("day_read", date, { kind: "train", focus: "legs", est_minutes: 60, override: null });
  }
  assert.equal(countDayReads(date), 1, "repeated canonical open does NOT duplicate the row");

  // An OVERRIDE read is a distinct payload and always records (its row never matches
  // the canonical existence check, so it can't be mistaken for the canonical one).
  repo.recordSuggestion("day_read", date, { kind: "easy", focus: null, est_minutes: 30, override: "rough night" });
  assert.equal(!!db.prepare(CANONICAL_DAY_READ_EXISTS).get(date), true, "override row didn't satisfy the canonical check");
  assert.equal(countDayReads(date), 2, "override recorded as its own row");
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
