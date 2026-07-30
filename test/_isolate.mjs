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
import { resetMarkerHistoryCache } from "../dist/repo/health.js";
import { resetDayReadRefresh } from "../dist/dayread-refresh.js";
import { resetDayReadComputeCoalescing } from "../dist/dayread.js";
import { resetBrainEventsForTest } from "../dist/brainEvents.js";
import { resetTrainingDataCache } from "../dist/repo/training-cache.js";

// The schema is fixed for the life of the process, so enumerate + prepare once.
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((row) => row.name);
const wipes = tables.map((name) => db.prepare(`DELETE FROM ${name}`));
// AUTOINCREMENT tables keep their high-water mark in sqlite_sequence, and a
// `DELETE FROM <t>` on an AUTOINCREMENT table does NOT touch it — that persistence
// is the whole point of AUTOINCREMENT (ids never get reused within a live DB). But
// this harness gives one worker's tests a SHARED DB, so without resetting it here a
// test that asserts on an id's literal value (e.g. a variant-set key keyed by
// `decision.id`) silently depends on how many rows earlier files in the same shard
// inserted before this test ever ran — passes standalone, fails or flips inside the
// shard depending on file order. `sqlite_sequence` only exists once at least one
// AUTOINCREMENT table has been created; guard so a schema with none doesn't throw.
const hasSqliteSequence = !!db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
  .get();

beforeEach(() => {
  // Single transaction with deferred FK checks: intermediate deletes may briefly
  // violate foreign keys, but every table is empty at COMMIT so nothing trips.
  // `DELETE FROM <t>` with no WHERE uses SQLite's truncate optimization, so an
  // already-empty table costs almost nothing — cheap even for DB-less tests.
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys = ON");
  try {
    for (const wipe of wipes) wipe.run();
    // Reset every AUTOINCREMENT counter back to zero right after the wipe, in the
    // same transaction, so id-dependent assertions are independent of shard order
    // and shard count — same guarantee the table wipe above already gives every
    // other kind of state.
    if (hasSqliteSequence) db.exec("DELETE FROM sqlite_sequence");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // The wipe bypasses every repo write path (and thus the getMarkerHistory write
  // counter), and rowids can collide across a wipe — so the in-process marker-history
  // memo could otherwise serve a prior test's markers. Drop it explicitly here.
  resetMarkerHistoryCache();
  // A brain-signal write in one test arms a debounced day-read recompute timer; clear
  // it (and restore default hooks) so it can never leak into — or spawn a CLI during —
  // a later test.
  resetDayReadRefresh();
  // And the canonical-recompute lane: an unsettled run left by one test must never
  // be joined by the next one, whose DB has just been wiped out from under it.
  resetDayReadComputeCoalescing();
  resetBrainEventsForTest();
  // Same hazard for the training memos (getProgramState / getWeeklyStats /
  // estimateExpenditure): reset their counters to 0 and drop every registered memo so a
  // same-shape next test can't land on a colliding key and read a prior test's read.
  resetTrainingDataCache();
});
