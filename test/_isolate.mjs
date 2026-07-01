// Per-test full-DB reset, injected into every worker process via `--import` from
// test/run.mjs. This runs a root-level `beforeEach` that node:test applies to
// EVERY test across EVERY file loaded into the process (verified: an imported
// top-level hook fires for all files in a `node --test a.js b.js` run).
//
// Why this exists: the harness gives each worker ONE shared DB (dist/db.js is a
// singleton keyed on DB_PATH), and files were expected to reset "the tables they
// touch" (test/_seed.js `resetTables`). That model is worker-count-fragile — a
// file can READ a table (e.g. buildHealthExport reads daily_metrics / blood
// pressure) that another file in the same round-robin shard SEEDED but it never
// reset, so whether the suite passes depends on how files partition across
// workers. Wiping the whole DB before each test makes every test start from a
// pristine floor, so correctness is independent of file order, shard count, and
// added test files. Per-file `resetTables` calls stay valid (they just delete
// already-empty tables) — this is the belt over their suspenders.
import { beforeEach } from "node:test";
import { db } from "../dist/db.js";

// The schema is fixed for the life of the process, so enumerate + prepare once.
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((row) => row.name);
const wipes = tables.map((name) => db.prepare(`DELETE FROM ${name}`));

beforeEach(() => {
  // Single transaction with deferred FK checks: intermediate deletes may briefly
  // violate foreign keys, but every table is empty at COMMIT so nothing trips.
  // `DELETE FROM <t>` with no WHERE uses SQLite's truncate optimization, so an
  // already-empty table costs almost nothing — cheap even for DB-less tests.
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys = ON");
  try {
    for (const wipe of wipes) wipe.run();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
});
