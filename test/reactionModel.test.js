// The personal-response model (src/repo/reaction-model.ts) — how THIS athlete
// reacts, the keystone the higher coaching layers read. Invariants under test:
//   - deficit_response speaks only when estimateExpenditure confidence is
//     medium/high (the engine's ladder); silent on a thin window
//   - load_crp stays SILENT with <3 hs-CRP draws and speaks (observational) at
//     >=3 when the readings track prior-week training load
//   - data_gap is FIRST-CLASS: fires when synced sleep/HRV is absent or stale
//   - app_state round-trip: saveReactionModel() → reactionModelForCoach() reads
//     'cache' and the built_at stamp
//   - GOLDEN: the serialized reactionModelForCoach() output leaks NO raw numeric
//     grade/score (the internal `params` blob never surfaces)
// Deterministic, offline, temp DB (see test/run.mjs). Imports the module
// directly from dist (the LEAD wires the barrel re-export at merge).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  buildReactionModel,
  reactionModelForCoach,
  saveReactionModel,
} from "../dist/repo/reaction-model.js";

// ---- local seeding (kept in-file; we never touch the shared _seed.js) ----
function reset() {
  for (const t of [
    "logged_sets", "plan_items", "plan_days", "sessions", "session_skips", "exercises",
    "bodyweight_log", "food_notes", "activities", "garmin_daily_metrics", "daily_metrics",
    "garmin_sources", "health_documents", "health_directives", "context_events",
    "plan_proposals", "meal_plans", "app_state", "memory",
  ]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}
function tsDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 19).replace("T", " ");
}

// Bodyweight + intake to drive estimateExpenditure's confidence ladder.
function seedWeight(daysAgo, lb) {
  db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(isoDaysAgo(daysAgo), lb);
}
function seedIntake(daysAgo, kcal) {
  db.prepare(
    `INSERT INTO food_notes (meal, raw_output, parsed_json, enrichment_status, created_at)
     VALUES ('meal', '', ?, NULL, ?)`
  ).run(JSON.stringify({ kcal }), tsDaysAgo(daysAgo));
}

// One dated health doc carrying a markers[] array (a per-marker time series).
function seedDoc(docDate, markers) {
  return repo.addHealthDocument({ kind: "bloodwork", doc_date: docDate, parsed_json: { markers }, enrichment_status: "done" });
}

// Synced sleep night (source-agnostic table).
function seedSleep(daysAgo, sleepMin, hrv = null) {
  db.prepare(
    `INSERT INTO daily_metrics (source, date, sleep_min, hrv_ms, updated_at) VALUES ('apple', ?, ?, ?, datetime('now'))`
  ).run(isoDaysAgo(daysAgo), sleepMin, hrv);
}

// Training day producing real prior-week tonnage (so load_crp has an x-axis).
function seedTonnage(date, sets = 4, weight = 200, reps = 5) {
  const ex = repo.upsertExercise({ name: "RM Squat", muscle_group: "quads" });
  const sess = repo.getOrCreateSession(date, null);
  for (let n = 1; n <= sets; n++) {
    db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, 2)`)
      .run(sess.id, ex.id, n, weight, reps);
  }
}

beforeEach(reset);

// ---------------------------------------------------------------------------
// deficit_response — the expenditure confidence ladder gate
// ---------------------------------------------------------------------------
test("deficit_response is silent on a thin window (low/none confidence)", () => {
  // Only two weigh-ins a couple days apart, almost no intake — confidence stays
  // below medium, so no kcal-per-lb sensitivity is claimed.
  seedWeight(2, 200);
  seedWeight(1, 199.6);
  seedIntake(1, 2000);
  const model = buildReactionModel();
  assert.equal(model.patterns.find((p) => p.id === "deficit_response"), undefined);
});

test("deficit_response speaks on a rich, drifting window", () => {
  // ~18 days of daily weigh-ins trending down ~0.4 lb/wk + daily intake under a
  // derived maintenance → medium/high confidence, a real deficit + direction.
  for (let d = 18; d >= 0; d--) {
    seedWeight(d, 200 - (18 - d) * 0.06); // ~0.42 lb/wk down
    seedIntake(d, 2100);
  }
  const model = buildReactionModel();
  const dr = model.patterns.find((p) => p.id === "deficit_response");
  assert.ok(dr, "expected a deficit_response pattern on a rich window");
  assert.match(dr.statement, /lb\/wk/);
  assert.ok(["observed", "strong"].includes(dr.confidence));
  assert.equal(dr.domains.includes("nutrition"), true);
});

// ---------------------------------------------------------------------------
// load_crp — observational, gated at >=3 readings
// ---------------------------------------------------------------------------
test("load_crp stays SILENT with fewer than 3 hs-CRP draws", () => {
  seedDoc(isoDaysAgo(40), [{ name: "hs-CRP", value: 1.2, unit: "mg/L" }]);
  seedDoc(isoDaysAgo(10), [{ name: "hs-CRP", value: 3.8, unit: "mg/L" }]);
  // Some training so an x-axis exists — still only 2 readings.
  seedTonnage(isoDaysAgo(12));
  const model = buildReactionModel();
  assert.equal(model.patterns.find((p) => p.id === "load_crp"), undefined);
});

test("load_crp speaks (observational, never causal) when CRP tracks load at >=3 draws", () => {
  // Three+ hs-CRP readings whose value rises with the prior-week tonnage near
  // each draw: low CRP on a light week, high CRP after heavy weeks.
  const draws = [
    { day: 60, crp: 0.8, tonnDay: 62, heavy: false },
    { day: 40, crp: 2.4, tonnDay: 42, heavy: true },
    { day: 20, crp: 3.6, tonnDay: 22, heavy: true },
    { day: 6, crp: 1.0, tonnDay: 8, heavy: false },
  ];
  for (const d of draws) {
    seedDoc(isoDaysAgo(d.day), [{ name: "hs-CRP", value: d.crp, unit: "mg/L" }]);
    if (d.heavy) {
      // heavy week → big tonnage in the 7 days before the draw
      for (let k = 0; k < 4; k++) seedTonnage(isoDaysAgo(d.tonnDay + k), 5, 245, 5);
    } else {
      // light week → a little tonnage
      seedTonnage(isoDaysAgo(d.tonnDay), 2, 95, 5);
    }
  }
  const model = buildReactionModel();
  const lc = model.patterns.find((p) => p.id === "load_crp");
  assert.ok(lc, "expected a load_crp pattern when CRP tracks training load");
  assert.ok(lc.evidence_n >= 3);
  // Observational framing — must NOT call it causal or a red flag.
  assert.match(lc.statement, /training[- ]induced|alongside/i);
  assert.doesNotMatch(lc.statement, /\bcauses?\b/i);
});

// ---------------------------------------------------------------------------
// data_gap — FIRST-CLASS recovery-dark signal
// ---------------------------------------------------------------------------
test("data_gap fires when there is NO synced sleep/HRV at all", () => {
  const model = buildReactionModel();
  const dg = model.patterns.find((p) => p.id === "data_gap");
  assert.ok(dg, "expected a data_gap pattern when recovery is dark");
  assert.equal(dg.evidence_n, 0);
  assert.match(dg.statement, /dark|no synced/i);
  assert.equal(dg.domains.includes("recovery"), true);
});

test("data_gap fires when synced sleep is STALE (older than ~2 days)", () => {
  seedSleep(6, 420, 55); // last night of data is 6 days old
  const model = buildReactionModel();
  const dg = model.patterns.find((p) => p.id === "data_gap");
  assert.ok(dg, "expected a stale data_gap pattern");
  assert.match(dg.statement, /quiet|days old/i);
});

test("data_gap is silent when sleep/HRV is fresh", () => {
  seedSleep(1, 430, 58);
  seedSleep(0, 410, 56);
  const model = buildReactionModel();
  assert.equal(model.patterns.find((p) => p.id === "data_gap"), undefined);
});

// ---------------------------------------------------------------------------
// app_state round-trip
// ---------------------------------------------------------------------------
test("saveReactionModel persists to app_state and reactionModelForCoach reads it back from cache", () => {
  // Seed something that produces at least one pattern (data_gap fires with no recovery).
  saveReactionModel();
  const stored = db.prepare(`SELECT value FROM app_state WHERE key = 'reaction_model'`).get();
  assert.ok(stored && stored.value, "expected reaction_model stored in app_state");
  const built = db.prepare(`SELECT value FROM app_state WHERE key = 'reaction_model_built_at'`).get();
  assert.ok(built && built.value, "expected a built_at stamp");

  const read = reactionModelForCoach();
  assert.equal(read.source, "cache");
  assert.equal(read.built_at, built.value);
  assert.ok(Array.isArray(read.patterns));
});

test("reactionModelForCoach falls back to deterministic when no cache exists", () => {
  const read = reactionModelForCoach();
  assert.equal(read.source, "deterministic");
});

test("saveReactionModel promotes strong/observed patterns into memory", () => {
  saveReactionModel(); // data_gap is 'observed' → memorialized
  const rows = db.prepare(`SELECT content, kind FROM memory WHERE kind = 'reaction'`).all();
  assert.ok(rows.length >= 1, "expected at least one reaction memory row");
});

test("reactionModelForCoach caps the surfaced patterns at 6, strongest first", () => {
  const read = reactionModelForCoach();
  assert.ok(read.patterns.length <= 6);
  // Confidence WORD only — never a numeric grade.
  for (const p of read.patterns) {
    assert.ok(["tentative", "observed", "strong"].includes(p.confidence));
  }
});

// ---------------------------------------------------------------------------
// GOLDEN — no raw numeric grade/score may cross the public boundary
// ---------------------------------------------------------------------------
test("GOLDEN: serialized reactionModelForCoach() leaks NO params/score/grade field", () => {
  // Build a model with several patterns (each carries an INTERNAL params blob).
  for (let d = 18; d >= 0; d--) { seedWeight(d, 200 - (18 - d) * 0.06); seedIntake(d, 2100); }
  saveReactionModel();
  const read = reactionModelForCoach();
  const json = JSON.stringify(read);
  // The internal coefficient/score keys must NEVER appear in the surfaced JSON.
  assert.doesNotMatch(json, /"params"/);
  assert.doesNotMatch(json, /"impact_score"/);
  assert.doesNotMatch(json, /"score"/);
  assert.doesNotMatch(json, /"deficit_kcal"/);
  assert.doesNotMatch(json, /"lb_per_wk"/);
  assert.doesNotMatch(json, /\b"r"\s*:/);
  // Per-pattern structural check: no `params`, confidence is a WORD.
  for (const p of read.patterns) {
    assert.equal(Object.hasOwn(p, "params"), false);
    assert.equal(typeof p.confidence, "string");
    assert.equal(typeof p.statement, "string");
  }
});
