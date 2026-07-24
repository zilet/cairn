// Learned cross-domain models (src/repo/learned-models.ts):
//   - endurance_strength_interference: bigger RUN weeks precede flatter lower-body
//     lifting for THIS athlete. Gated on >=4 qualifying pairs (>=2 per bucket) AND a
//     real performance gap; silent otherwise.
//   - sleep_fuel_correlation: hunger runs higher after short nights. Gated on >=4
//     short AND >=4 normal nights with a hunger read, and a real hunger gap.
//   - day-lines: the interference line is a standing tendency; the sleep→fuel line is
//     timely (only when TONIGHT'S read is short) — learned voice when the correlation
//     exists, deterministic short-night nudge otherwise, silent on a normal night.
//   - GOLDEN: saveLearnedModels round-trips through app_state and NEVER leaks params.
// Deterministic, offline, temp DB (see test/run.mjs). Imports from dist.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";
import {
  buildLearnedModels,
  learnedModelsForCoach,
  learnedModelDayLines,
  saveLearnedModels,
} from "../dist/repo/learned-models.js";

const REF = "2026-06-15";
function daysBefore(dateISO, n) {
  return new Date(Date.parse(dateISO + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
}

function reset() {
  for (const t of ["activities", "sessions", "logged_sets", "exercises", "daily_metrics", "checkins", "fueling_feedback", "app_state"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
}
beforeEach(reset);

// ---- seeding helpers --------------------------------------------------------

function ensureLegExercise() {
  db.prepare(`INSERT OR IGNORE INTO exercises (name, muscle_group) VALUES ('Back Squat', 'quads')`).run();
  return db.prepare(`SELECT id FROM exercises WHERE name = 'Back Squat'`).get().id;
}

// A lower-body (quads-dominant) strength session on a date, with a performance read.
function seedLegSession(date, performance) {
  const exId = ensureLegExercise();
  const info = db.prepare(`INSERT INTO sessions (date, performance, kind) VALUES (?, ?, 'strength')`).run(date, performance);
  const sid = info.lastInsertRowid;
  db.prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps) VALUES (?, ?, 1, 225, 5)`).run(sid, exId);
  return sid;
}

function seedRunWeek(refDate, weekBack, km) {
  // A run mid-way through week `weekBack` (covers [ref-wb*7-6, ref-wb*7]).
  repo.addActivity({ type: "run", distance_km: km, duration_min: km * 6, date: daysBefore(refDate, weekBack * 7 + 3) });
}

// Weeks 1..pairs run; a leg session sits in each FOLLOWING week (weeks 0..pairs-1).
// Odd run weeks are BIG (40 km) and the leg session that follows them comes in flat
// (perf 2); even weeks are TYPICAL (10 km) and the following session is strong (perf 4).
function seedInterference(refDate, pairs, { flatAfterBig = true } = {}) {
  for (let w = 1; w <= pairs; w++) seedRunWeek(refDate, w, w % 2 === 1 ? 40 : 10);
  for (let k = 0; k < pairs; k++) {
    const runWeek = k + 1; // the leg session in week k is the "next week" of run-week k+1
    const bigRun = runWeek % 2 === 1;
    const perf = !flatAfterBig ? 3 : bigRun ? 2 : 4;
    seedLegSession(daysBefore(refDate, k * 7 + 3), perf);
  }
}

function seedSleep(date, sleepMin) {
  db.prepare(
    `INSERT INTO daily_metrics (source, date, sleep_min, updated_at) VALUES ('apple', ?, ?, datetime('now'))`
  ).run(date, sleepMin);
}
function seedHunger(date, hunger) {
  db.prepare(`INSERT INTO fueling_feedback (date, hunger, decision_id) VALUES (?, ?, 1)`).run(date, hunger);
}

// ---------------------------------------------------------------------------
// endurance_strength_interference
// ---------------------------------------------------------------------------
test("interference surfaces when bigger run weeks precede flatter lower-body lifting", () => {
  seedInterference(REF, 8);
  const p = buildLearnedModels(REF).patterns.find((x) => x.kind === "endurance_strength_interference");
  assert.ok(p, "expected an interference pattern");
  assert.match(p.statement.toLowerCase(), /running weeks|lower-body/);
  assert.deepEqual(new Set(p.domains), new Set(["endurance", "training"]));
  assert.ok(p.evidence_n >= 4);
});

test("interference stays silent below the qualifying-pairs floor", () => {
  seedInterference(REF, 3); // only 3 pairs < 4
  assert.equal(
    buildLearnedModels(REF).patterns.find((x) => x.kind === "endurance_strength_interference"),
    undefined
  );
});

test("interference stays silent when big weeks are not actually flatter", () => {
  seedInterference(REF, 8, { flatAfterBig: false }); // every following session perf 3
  assert.equal(
    buildLearnedModels(REF).patterns.find((x) => x.kind === "endurance_strength_interference"),
    undefined,
    "no performance gap → no coincidence claim"
  );
});

// ---------------------------------------------------------------------------
// sleep_fuel_correlation
// ---------------------------------------------------------------------------
test("sleep_fuel_correlation surfaces when hunger runs higher after short nights", () => {
  for (let i = 1; i <= 5; i++) {
    seedSleep(daysBefore(REF, i), 300); // short night (<6h)
    seedHunger(daysBefore(REF, i), 3); // high hunger
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(daysBefore(REF, i), 480); // normal night
    seedHunger(daysBefore(REF, i), 1); // low hunger
  }
  const p = buildLearnedModels(REF).patterns.find((x) => x.kind === "sleep_fuel_correlation");
  assert.ok(p, "expected a sleep_fuel_correlation pattern");
  assert.match(p.statement.toLowerCase(), /shorter-sleep|protein anchor|hunger/);
  assert.deepEqual(new Set(p.domains), new Set(["recovery", "nutrition"]));
});

test("sleep_fuel_correlation is adherence-neutral: sparse buckets make no claim", () => {
  for (let i = 1; i <= 3; i++) {
    seedSleep(daysBefore(REF, i), 300);
    seedHunger(daysBefore(REF, i), 3);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(daysBefore(REF, i), 480);
    seedHunger(daysBefore(REF, i), 1);
  }
  assert.equal(
    buildLearnedModels(REF).patterns.find((x) => x.kind === "sleep_fuel_correlation"),
    undefined,
    "fewer than 4 short-night reads is below the floor"
  );
});

test("sleep_fuel_correlation makes no claim when hunger does not differ by sleep", () => {
  for (let i = 1; i <= 5; i++) {
    seedSleep(daysBefore(REF, i), 300);
    seedHunger(daysBefore(REF, i), 2);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(daysBefore(REF, i), 480);
    seedHunger(daysBefore(REF, i), 2);
  }
  assert.equal(
    buildLearnedModels(REF).patterns.find((x) => x.kind === "sleep_fuel_correlation"),
    undefined
  );
});

// ---------------------------------------------------------------------------
// day-lines
// ---------------------------------------------------------------------------
test("day-lines fire the LEARNED sleep→fuel line only when tonight's read is short", () => {
  for (let i = 1; i <= 5; i++) {
    seedSleep(daysBefore(REF, i), 300);
    seedHunger(daysBefore(REF, i), 3);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(daysBefore(REF, i), 480);
    seedHunger(daysBefore(REF, i), 1);
  }
  const patterns = buildLearnedModels(REF).patterns;

  seedSleep(REF, 310); // a short night for REF itself
  const onShort = learnedModelDayLines(REF, patterns);
  assert.ok(onShort.some((l) => /shorter-sleep|protein anchor/i.test(l)), "learned line on a short night");

  const normalDay = daysBefore(REF, 20);
  seedSleep(normalDay, 470); // a normal night
  const onNormal = learnedModelDayLines(normalDay, patterns);
  assert.ok(!onNormal.some((l) => /short|protein anchor/i.test(l)), "no sleep→fuel line on a normal night");
});

test("day-lines fall back to the deterministic short-night nudge with no learned correlation", () => {
  seedSleep(REF, 300); // a short night, but no correlation data seeded
  const lines = learnedModelDayLines(REF, []);
  assert.ok(lines.some((l) => /short night/i.test(l)), "deterministic nudge fires on a positively-short night");
});

test("day-lines stay silent when the night cannot be classified", () => {
  // No sleep record and no check-in for REF → shortNight is null → no nudge, no throw.
  assert.deepEqual(learnedModelDayLines(REF, []), []);
});

// ---------------------------------------------------------------------------
// nightly insertion point + GOLDEN (no params leak)
// ---------------------------------------------------------------------------
test("saveLearnedModels round-trips through app_state and strips the params blob", () => {
  // saveLearnedModels() builds against the real local "today"; seed relative to it.
  for (let i = 1; i <= 5; i++) {
    seedSleep(isoDaysAgo(i), 300);
    seedHunger(isoDaysAgo(i), 3);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(isoDaysAgo(i), 480);
    seedHunger(isoDaysAgo(i), 1);
  }
  saveLearnedModels();
  const raw = db.prepare(`SELECT value FROM app_state WHERE key = 'learned_models'`).get();
  assert.ok(raw && raw.value, "learned_models cached to app_state");

  const coach = learnedModelsForCoach();
  assert.ok(coach.patterns.some((p) => p.kind === "sleep_fuel_correlation"), "cached patterns read back");
  const serialized = JSON.stringify(coach);
  assert.ok(!/"params"/.test(serialized), "params blob never surfaces");
  for (const p of coach.patterns) assert.equal(p.params, undefined);
});

test("learnedModelsForCoach falls back to a live build on a cold cache", () => {
  for (let i = 1; i <= 5; i++) {
    seedSleep(isoDaysAgo(i), 300);
    seedHunger(isoDaysAgo(i), 3);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(isoDaysAgo(i), 480);
    seedHunger(isoDaysAgo(i), 1);
  }
  const coach = learnedModelsForCoach(); // no saveLearnedModels() first
  assert.ok(coach.patterns.some((p) => p.kind === "sleep_fuel_correlation"));
});

test("a corrupt (unparseable) cache triggers the live rebuild rather than reading empty", () => {
  for (let i = 1; i <= 5; i++) {
    seedSleep(isoDaysAgo(i), 300);
    seedHunger(isoDaysAgo(i), 3);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(isoDaysAgo(i), 480);
    seedHunger(isoDaysAgo(i), 1);
  }
  // A truthy-but-unparseable cache string. Before the fix, `!cached` was false so the
  // live-rebuild branch was skipped and patterns read back empty.
  db.prepare(`INSERT OR REPLACE INTO app_state (key, value) VALUES ('learned_models', '{not valid json')`).run();
  const coach = learnedModelsForCoach();
  assert.ok(coach.patterns.some((p) => p.kind === "sleep_fuel_correlation"), "corrupt cache rebuilt live");
});

test("a validly-empty cache is honored (no live rebuild)", () => {
  // Data that WOULD produce a pattern if a live build ran — but a valid empty cache
  // must be authoritative and suppress the rebuild.
  for (let i = 1; i <= 5; i++) {
    seedSleep(isoDaysAgo(i), 300);
    seedHunger(isoDaysAgo(i), 3);
  }
  for (let i = 6; i <= 10; i++) {
    seedSleep(isoDaysAgo(i), 480);
    seedHunger(isoDaysAgo(i), 1);
  }
  db.prepare(`INSERT OR REPLACE INTO app_state (key, value) VALUES ('learned_models', '{"patterns":[]}')`).run();
  const coach = learnedModelsForCoach();
  assert.equal(coach.patterns.length, 0, "a valid empty cache is authoritative — no rebuild");
});
