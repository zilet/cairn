// The migration ladder (src/migrate.ts + src/db.ts). Down-migrations aren't
// supported, so the ladder MUST be well-formed (strictly ascending, unique,
// gapless versions) and a fresh DB MUST boot to the latest version with every
// migration applied. The runner gives us exactly that: a brand-new temp DB that
// ran the full ladder on import — we assert its PRAGMA user_version matches the
// max migration version (computed dynamically so this test never goes stale).
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../dist/db.js";
import { MIGRATIONS, runMigrations } from "../dist/migrate.js";

const MAX_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

test("a fresh temp DB boots to the latest migration version", () => {
  const v = Number(db.prepare("PRAGMA user_version").get().user_version);
  assert.equal(v, MAX_VERSION, `fresh DB should be at user_version ${MAX_VERSION}`);
});

// v36 must rebuild plan_items on a DB that migrated up from an older schema
// (exercise_id still NOT NULL after v35's ALTER) so planned cardio (null
// exercise_id) is accepted — while preserving the existing strength rows. This
// is the real rpi-class case: a deployed DB, not a fresh one.
test("v36 makes plan_items.exercise_id nullable on a migrated DB, preserving rows", () => {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec("CREATE TABLE plan_days (id INTEGER PRIMARY KEY AUTOINCREMENT, day_number INTEGER, name TEXT);");
  d.exec("CREATE TABLE exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);");
  // Old-schema plan_items: exercise_id NOT NULL, but v35's columns already added
  // (i.e. a DB sitting at user_version 35 with the unfixable constraint).
  d.exec(`CREATE TABLE plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_day_id INTEGER NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    sets INTEGER NOT NULL DEFAULT 3,
    rep_low INTEGER, rep_high INTEGER, target_weight REAL, note TEXT,
    warmup_sets INTEGER, target_seconds INTEGER,
    kind TEXT DEFAULT 'strength', target_distance_km REAL, target_duration_min REAL, target_zone TEXT, interval_json TEXT
  );`);
  d.exec("INSERT INTO plan_days (id, day_number, name) VALUES (1, 1, 'Day 1');");
  d.exec("INSERT INTO exercises (id, name) VALUES (1, 'Back Squat');");
  d.exec("INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, kind) VALUES (1, 0, 1, 3, 5, 8, 185, 'strength');");
  d.exec("PRAGMA user_version = 35;");

  // Before v36: a cardio item (null exercise_id) is rejected by the constraint.
  assert.throws(
    () => d.exec("INSERT INTO plan_items (plan_day_id, position, exercise_id, kind, target_distance_km, target_zone) VALUES (1, 1, NULL, 'cardio', 12, 'Z2');"),
    /NOT NULL/,
  );

  runMigrations(d);
  assert.equal(Number(d.prepare("PRAGMA user_version").get().user_version), MAX_VERSION);

  // The strength row survived the rebuild intact.
  const kept = d.prepare("SELECT exercise_id, target_weight, kind FROM plan_items WHERE position = 0").get();
  assert.equal(kept.exercise_id, 1);
  assert.equal(kept.target_weight, 185);
  assert.equal(kept.kind, "strength");

  // And a cardio item now inserts cleanly.
  d.exec("INSERT INTO plan_items (plan_day_id, position, exercise_id, kind, target_distance_km, target_zone) VALUES (1, 1, NULL, 'cardio', 12, 'Z2');");
  const cardio = d.prepare("SELECT exercise_id, kind, target_distance_km, target_zone FROM plan_items WHERE position = 1").get();
  assert.equal(cardio.exercise_id, null);
  assert.equal(cardio.kind, "cardio");
  assert.equal(cardio.target_distance_km, 12);
  assert.equal(cardio.target_zone, "Z2");
  d.close();
});

test("migration versions are strictly ascending, unique, and gapless from 1", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted, "MIGRATIONS array is declared in ascending order");
  assert.equal(new Set(versions).size, versions.length, "no duplicate version numbers");
  // Gapless 1..N — runMigrations applies them in order keyed off user_version.
  for (let i = 0; i < versions.length; i++) {
    assert.equal(versions[i], i + 1, `version at index ${i} should be ${i + 1}`);
  }
});

test("every migration carries a name and an up() function", () => {
  for (const m of MIGRATIONS) {
    assert.equal(typeof m.version, "number");
    assert.ok(m.name && typeof m.name === "string", `migration v${m.version} has a name`);
    assert.equal(typeof m.up, "function", `migration v${m.version} has an up()`);
  }
});

test("re-running migrations on an up-to-date DB is a no-op (idempotent boot)", async () => {
  const { runMigrations } = await import("../dist/migrate.js");
  const before = Number(db.prepare("PRAGMA user_version").get().user_version);
  const res = runMigrations(db);
  assert.equal(res.applied, 0, "nothing to apply on an already-current DB");
  const after = Number(db.prepare("PRAGMA user_version").get().user_version);
  assert.equal(after, before);
});

test("the migrated schema has the columns later code depends on", () => {
  // Spot-check a few columns added by migrations so a dropped ALTER is caught.
  const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  assert.ok(cols("sessions").has("garmin_json"), "v24 sessions.garmin_json");
  assert.ok(cols("sessions").has("soreness"), "v19 sessions.soreness");
  assert.ok(cols("profile").has("about_me"), "v20 profile.about_me");
  assert.ok(cols("health_directives").has("directive_key"), "v26 health_directives.directive_key");
  assert.ok(cols("insights").has("next_step"), "v25 insights.next_step");
  // v35 — endurance/runner-first + first-class planned cardio.
  assert.ok(cols("profile").has("primary_discipline"), "v35 profile.primary_discipline");
  assert.ok(cols("profile").has("endurance_sport"), "v35 profile.endurance_sport");
  assert.ok(cols("plan_items").has("kind"), "v35 plan_items.kind");
  assert.ok(cols("plan_items").has("target_distance_km"), "v35 plan_items.target_distance_km");
  assert.ok(cols("plan_items").has("target_zone"), "v35 plan_items.target_zone");
  assert.ok(cols("sessions").has("kind"), "v35 sessions.kind");
  assert.ok(cols("settings").has("garmin_password_encrypted"), "v48 settings.garmin_password_encrypted");
  assert.ok(cols("settings").has("gemini_api_key_encrypted"), "v48 settings.gemini_api_key_encrypted");
});
