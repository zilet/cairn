// Pre-migration snapshot (src/migrationSnapshot.ts): on boot, an EXISTING database
// that is about to be migrated forward is first copied with VACUUM INTO to
// ${DATA_DIR}/backups/pre-migration-v<from>-to-v<to>-<timestamp>.db, keeping only the
// newest few of those. Fresh/test databases (user_version 0), up-to-date ones and
// in-memory ones are never snapshotted, and a failed snapshot warns unless required.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../dist/migrate.js";
import { PRE_MIGRATION_KEEP, migrationSnapshotRequired, snapshotBeforeMigrations } from "../dist/migrationSnapshot.js";

const TOP = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cairn-snap-"));
}

function fileDb(dir, version) {
  const dbPath = path.join(dir, "cairn.db");
  const d = new DatabaseSync(dbPath);
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);");
  d.exec("INSERT INTO notes (body) VALUES ('kept across the upgrade');");
  d.exec(`PRAGMA user_version = ${version};`);
  return { d, dbPath };
}

test("an existing DB behind the ladder is snapshotted with its data and old version", () => {
  const dir = tempDir();
  try {
    const { d, dbPath } = fileDb(dir, TOP - 2);
    const res = snapshotBeforeMigrations(d, { dbPath, dataDir: dir, now: new Date("2026-01-02T03:04:05.678Z") });
    assert.equal(res.status, "written");
    assert.equal(path.basename(res.file), `pre-migration-v${TOP - 2}-to-v${TOP}-2026-01-02T03-04-05-678Z.db`);
    assert.equal(path.dirname(res.file), path.join(dir, "backups"));
    const copy = new DatabaseSync(res.file, { readOnly: true });
    assert.equal(copy.prepare("SELECT body FROM notes").get().body, "kept across the upgrade");
    assert.equal(Number(copy.prepare("PRAGMA user_version").get().user_version), TOP - 2);
    copy.close();
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "backups")).filter((n) => n.endsWith(".partial")),
      [],
      "no scratch file is left behind"
    );
    d.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh, up-to-date and in-memory databases are never snapshotted", () => {
  const dir = tempDir();
  try {
    const fresh = fileDb(dir, 0);
    assert.deepEqual(snapshotBeforeMigrations(fresh.d, { dbPath: fresh.dbPath, dataDir: dir }), {
      status: "skipped",
      reason: "fresh_database",
    });
    fresh.d.exec(`PRAGMA user_version = ${TOP};`);
    assert.deepEqual(snapshotBeforeMigrations(fresh.d, { dbPath: fresh.dbPath, dataDir: dir }), {
      status: "skipped",
      reason: "up_to_date",
    });
    fresh.d.close();
    const mem = new DatabaseSync(":memory:");
    mem.exec("PRAGMA user_version = 1;");
    assert.deepEqual(snapshotBeforeMigrations(mem, { dbPath: ":memory:", dataDir: dir }), {
      status: "skipped",
      reason: "in_memory",
    });
    mem.close();
    assert.equal(fs.existsSync(path.join(dir, "backups")), false, "no backups dir is created for a skip");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only the newest pre-migration snapshots are kept; other backups are untouched", () => {
  const dir = tempDir();
  try {
    const backups = path.join(dir, "backups");
    fs.mkdirSync(backups, { recursive: true });
    const old = [];
    for (let i = 0; i < 4; i++) {
      const name = `pre-migration-v${10 + i}-to-v${11 + i}-2025-01-0${i + 1}T00-00-00-000Z.db`;
      const full = path.join(backups, name);
      fs.writeFileSync(full, "old");
      const t = new Date(Date.UTC(2025, 0, i + 1)).getTime() / 1000;
      fs.utimesSync(full, t, t);
      old.push(name);
    }
    fs.writeFileSync(path.join(backups, "my-own-backup.db"), "mine");
    fs.writeFileSync(path.join(backups, "pre-migration-v1-to-v2-crashed.db.partial"), "half");

    const { d, dbPath } = fileDb(dir, TOP - 1);
    const res = snapshotBeforeMigrations(d, { dbPath, dataDir: dir });
    d.close();
    assert.equal(res.status, "written");

    const left = fs.readdirSync(backups).sort();
    const snapshots = left.filter((n) => n.startsWith("pre-migration-") && n.endsWith(".db"));
    assert.equal(snapshots.length, PRE_MIGRATION_KEEP);
    assert.ok(snapshots.includes(path.basename(res.file)), "the new snapshot survives the prune");
    assert.ok(snapshots.includes(old[3]) && snapshots.includes(old[2]), "the newest older ones survive");
    assert.ok(!snapshots.includes(old[0]) && !snapshots.includes(old[1]), "the oldest are pruned");
    assert.ok(left.includes("my-own-backup.db"), "files without the prefix are never touched");
    assert.ok(!left.some((n) => n.endsWith(".partial")), "a stale partial is cleared");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a snapshot that cannot be written warns and continues, unless required", () => {
  const dir = tempDir();
  try {
    // `backups` exists as a FILE, so the directory cannot be created.
    fs.writeFileSync(path.join(dir, "backups"), "not a directory");
    const { d, dbPath } = fileDb(dir, TOP - 1);
    const res = snapshotBeforeMigrations(d, { dbPath, dataDir: dir });
    assert.equal(res.status, "failed");
    assert.equal(res.from, TOP - 1);
    assert.throws(
      () => snapshotBeforeMigrations(d, { dbPath, dataDir: dir, required: true }),
      /CAIRN_REQUIRE_MIGRATION_SNAPSHOT/
    );
    d.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CAIRN_REQUIRE_MIGRATION_SNAPSHOT parses like the other boolean flags", () => {
  assert.equal(migrationSnapshotRequired({}), false);
  assert.equal(migrationSnapshotRequired({ CAIRN_REQUIRE_MIGRATION_SNAPSHOT: "0" }), false);
  assert.equal(migrationSnapshotRequired({ CAIRN_REQUIRE_MIGRATION_SNAPSHOT: "1" }), true);
  assert.equal(migrationSnapshotRequired({ CAIRN_REQUIRE_MIGRATION_SNAPSHOT: " yes " }), true);
});
