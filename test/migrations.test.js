// The migration ladder (src/migrate.ts + src/db.ts). Down-migrations aren't
// supported, so the ladder MUST be well-formed (strictly ascending, unique,
// gapless versions) and a fresh DB MUST boot to the latest version with every
// migration applied. The runner gives us exactly that: a brand-new temp DB that
// ran the full ladder on import — we assert its PRAGMA user_version matches the
// max migration version (computed dynamically so this test never goes stale).
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db } from "../dist/db.js";
import { MIGRATIONS, runMigrations } from "../dist/migrate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

test("v49 backfills stable chat session ids for archived conversations", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent TEXT,
    meta TEXT,
    archived_at TEXT
  );`);
  d.exec(`INSERT INTO chat_messages (role, content, archived_at) VALUES
    ('user', 'first thread question', '2026-06-29 10:00:00'),
    ('assistant', 'first thread answer', '2026-06-29 10:00:00'),
    ('user', 'second thread question', '2026-06-29 11:00:00')`);
  d.exec("PRAGMA user_version = 48;");

  runMigrations(d);

  assert.equal(Number(d.prepare("PRAGMA user_version").get().user_version), MAX_VERSION);
  const cols = new Set(d.prepare("PRAGMA table_info(chat_messages)").all().map((c) => c.name));
  assert.ok(cols.has("session_id"), "v49 chat_messages.session_id");
  const rows = d.prepare("SELECT id, session_id FROM chat_messages ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.session_id), ["chat_1", "chat_1", "chat_3"]);
  const indexes = new Set(d.prepare("PRAGMA index_list(chat_messages)").all().map((idx) => idx.name));
  assert.ok(indexes.has("idx_chat_messages_session"), "v49 chat session index");
  d.close();
});

test("v61-v62 clear legacy dynamic telemetry and add build-scoped storage", () => {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, error_message TEXT);");
  d.exec("INSERT INTO agent_runs (id,error_message) VALUES (1,'private raw CLI output');");
  d.exec(`CREATE TABLE diagnostic_events (
    id INTEGER PRIMARY KEY, source TEXT, kind TEXT, level TEXT, fingerprint TEXT, created_at TEXT
  );`);
  d.exec("INSERT INTO diagnostic_events VALUES (1,'api','slow_request','warning','slow','2026-07-10 10:00:00');");
  d.exec("PRAGMA user_version=60;");
  runMigrations(d);
  assert.equal(d.prepare("SELECT error_message FROM agent_runs").get().error_message, null);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM diagnostic_events").get().n, 0);
  assert.ok(new Set(d.prepare("PRAGMA table_info(agent_runs)").all().map((row) => row.name)).has("build_id"));
  const metricColumns = new Set(d.prepare("PRAGMA table_info(request_metric_buckets)").all().map((row) => row.name));
  assert.ok(metricColumns.has("build_id"));
  assert.ok(metricColumns.has("scope"));
  d.close();
});

// The deployed-Pi boot order: db.ts runs the SCHEMA exec BEFORE runMigrations, so a
// statement in the main schema block that references a MIGRATED column (e.g. an index
// on request_metric_buckets.build_id, which only v62's rebuild adds) crashes boot
// before the migration can ever run — the exact crash-loop that took the live
// deployment down. This spawns the real dist/db.js against a pre-v62 file DB, so the
// true ordering (schema exec → runMigrations → post-migration indexes) is exercised.
test("dist/db.js BOOTS a pre-v62 database — the schema exec never references migrated columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-v61-boot-"));
  const dbPath = join(dir, "cairn.db");
  const staged = new DatabaseSync(dbPath);
  // The Pi's pre-v62 table shape: no build_id column.
  staged.exec(`CREATE TABLE request_metric_buckets (
    hour TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'product', protocol TEXT NOT NULL,
    method TEXT NOT NULL, route TEXT NOT NULL, status_class TEXT NOT NULL,
    latency_bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER NOT NULL DEFAULT 0, max_duration_ms INTEGER NOT NULL DEFAULT 0,
    UNIQUE(hour, scope, protocol, method, route, status_class, latency_bucket_ms)
  );`);
  staged.exec("PRAGMA user_version = 61;");
  staged.close();

  const dbModule = pathToFileURL(join(root, "dist/db.js")).href;
  const boot = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(dbModule)});`], {
    env: { ...process.env, DATA_DIR: dir, DB_PATH: dbPath },
    timeout: 60_000,
    encoding: "utf8",
  });
  assert.equal(boot.status, 0, `boot must survive a pre-v62 DB — stderr: ${(boot.stderr || "").slice(0, 500)}`);

  const after = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(Number(after.prepare("PRAGMA user_version").get().user_version), MAX_VERSION, "the ladder completed");
  const cols = new Set(after.prepare("PRAGMA table_info(request_metric_buckets)").all().map((c) => c.name));
  assert.ok(cols.has("build_id"), "v62 rebuilt the table with build_id");
  assert.ok(
    after.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_request_metric_route'").get(),
    "the build-scoped index exists (created post-migration)"
  );
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migration versions are gapless 1..N, unique, and strictly ascending", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted, "MIGRATIONS array is declared in ascending order");
  assert.equal(new Set(versions).size, versions.length, "no duplicate version numbers");
  assert.equal(versions[0], 1, "the ladder starts at version 1");
  // The canonical invariant: the ladder is a gapless run of integers 1..N. A GAP would
  // silently skip a version number (user_version jumps past it, and it can never be
  // filled later without re-numbering), so we hold the ladder strictly contiguous.
  for (let i = 0; i < versions.length; i++) {
    assert.equal(versions[i], i + 1, `version at index ${i} must be ${i + 1} (gapless, unique, ascending)`);
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
  assert.ok(cols("chat_messages").has("session_id"), "v49 chat_messages.session_id");
});
