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
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { beforeEach } from "node:test";
// Offline floor for a run started without test/run.mjs; must precede any dist import.
import "./_offline.mjs";

// In-process memos and timers that must not leak from one test into the next.
const dist = (rel) => new URL(rel, import.meta.url).href;
const watched = new Map(
  [
    ["../dist/repo/health.js", "resetMarkerHistoryCache"],
    ["../dist/dayread-refresh.js", "resetDayReadRefresh"],
    ["../dist/dayread.js", "resetDayReadComputeCoalescing"],
    ["../dist/brainEvents.js", "resetBrainEventsForTest"],
    ["../dist/repo/training-cache.js", "resetTrainingDataCache"],
  ].map(([rel, name]) => [dist(rel), { url: dist(rel), name, reset: null }])
);
const loaded = new Set();
registerHooks({
  load(url, context, nextLoad) {
    const entry = watched.get(url);
    if (entry) loaded.add(entry);
    return nextLoad(url, context);
  },
});
// Resolve a loaded module's reset once; the module is already in the cache by then.
async function resetIfLoaded(url) {
  const entry = watched.get(url);
  if (!loaded.has(entry)) return;
  entry.reset ??= (await import(entry.url))[entry.name];
  entry.reset();
}

// A third of the suite (client, script and contract tests) never loads dist/, and
// importing the server graph here cost each such file ~150 ms of process start. So a test
// file that never names dist — itself or in the relative modules it imports —
// loads only the DB; a module never loaded has no state to reset, and the hook above
// still notices one that loads late. Every other file keeps the full, ordered graph
// import below, so a dist test starts from the same module it always has (any cycle
// member loading first is safe on its own — test/moduleLoadOrder.test.js holds that).
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
function reachesDist(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return true;
  }
  // Conservative: any mention of dist (a built path, an import by URL) counts.
  if (/\bdist\b/.test(source)) return true;
  for (const [, spec] of source.matchAll(RELATIVE_IMPORT)) {
    const target = path.resolve(path.dirname(file), spec);
    if (target.split(path.sep).includes("dist")) return true;
    if (/\.m?js$/.test(target) && reachesDist(target, seen)) return true;
  }
  return false;
}
const testFiles = process.argv.slice(1).filter((arg) => /\.test\.m?js$/.test(arg));
const lightweight = testFiles.length > 0 && !testFiles.some((file) => reachesDist(path.resolve(file)));

const { db } = await import("../dist/db.js");
if (!lightweight) {
  for (const url of watched.keys()) await import(url);
}

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

beforeEach(async () => {
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
  // memo could otherwise serve a prior test's markers. Drop it explicitly here (when loaded).
  await resetIfLoaded(dist("../dist/repo/health.js"));
  // A brain-signal write in one test arms a debounced day-read recompute timer; clear
  // it (and restore default hooks) so it can never leak into — or spawn a CLI during —
  // a later test.
  await resetIfLoaded(dist("../dist/dayread-refresh.js"));
  // And the canonical-recompute lane: an unsettled run left by one test must never
  // be joined by the next one, whose DB has just been wiped out from under it.
  await resetIfLoaded(dist("../dist/dayread.js"));
  await resetIfLoaded(dist("../dist/brainEvents.js"));
  // Same hazard for the training memos (getProgramState / getWeeklyStats /
  // estimateExpenditure): reset their counters to 0 and drop every registered memo so a
  // same-shape next test can't land on a colliding key and read a prior test's read.
  await resetIfLoaded(dist("../dist/repo/training-cache.js"));
});
