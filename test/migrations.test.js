// The migration ladder (src/migrate.ts + src/db.ts). Down-migrations aren't
// supported, so the ladder MUST be well-formed (strictly ascending, unique,
// gapless versions) and a fresh DB MUST boot to the latest version with every
// migration applied. The runner gives us exactly that: a brand-new temp DB that
// ran the full ladder on import — we assert its PRAGMA user_version matches the
// max migration version (computed dynamically so this test never goes stale).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../dist/db.js";
import { MIGRATIONS } from "../dist/migrate.js";

const MAX_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

test("a fresh temp DB boots to the latest migration version", () => {
  const v = Number(db.prepare("PRAGMA user_version").get().user_version);
  assert.equal(v, MAX_VERSION, `fresh DB should be at user_version ${MAX_VERSION}`);
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
});
