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
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach } from "node:test";
// Offline floor for a run started without test/run.mjs; must precede any dist import.
import "./_offline.mjs";

// test/run.mjs starts each test file as `node --import _isolate.mjs <file>` — no `node
// --test` parent — detached, so the file's process leads its own process group and its
// parent is the runner, whose pid the runner hands down. That identifies it exactly: a
// node process a TEST starts (inheriting the env) has the file's process as its parent.
const runnerPid = Number(process.env.CAIRN_TEST_RUNNER_PID);
const fromRunner = runnerPid > 0 && process.ppid === runnerPid;

// What a `node --test` child sees: node:test marks its file processes NODE_TEST_CONTEXT,
// and src/ reads it (dataDir.ts and agents.ts refuse the real data dir and agent table
// under it; the guide auto-import stays off), as does every process a test starts. A file
// the runner starts directly must see the same — but node:test reads the variable to pick
// its reporter (child-v8 = serialize to a parent), lazily, when the first test or hook
// bootstraps the harness. So register the per-test hook FIRST (below, its body runs only
// once the tests do), and only then set the variable. A harness that read it late would
// print serialized events instead of the reporter's summary, which the runner refuses.
let wipeDb = async () => {};
beforeEach(() => wipeDb());
if (fromRunner) process.env.NODE_TEST_CONTEXT = "child-v8";

// test/run.mjs records each file's peak memory: the file's process (and any node process
// a test starts with this module imported) appends its maxRSS, in KB, at exit.
const rssFile = process.env.CAIRN_TEST_RSS_FILE;
if (rssFile) {
  process.once("exit", () => {
    try {
      appendFileSync(rssFile, `${process.resourceUsage().maxRSS}\n`);
    } catch {}
  });
}
// The lifeline. A runner killed outright (SIGKILL: no handler runs) would leave every
// running file's process group orphaned, so the file's process — the group's leader —
// keeps the watch: once the runner is gone it takes its group (itself and whatever it
// started) down. Only when the runner started this process and it really leads a group (a
// group with its own pid as its id exists), so a bare `node --test`, or a process a test
// starts, never signals a group that is not a runner's.
if (fromRunner && process.platform !== "win32") {
  let leads = false;
  try {
    process.kill(-process.pid, 0);
    leads = true;
  } catch {}
  if (leads) {
    setInterval(() => {
      try {
        process.kill(runnerPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") process.kill(0, "SIGKILL");
      }
    }, 500).unref();
  }
}

// Where the runner cannot sample other processes (an OS sandbox refusing `ps`), the test
// file's own process watches its RSS from a worker thread — a thread, so a main thread
// stuck in a synchronous runaway is still caught — and past the budget leaves the figure
// for the runner and kills itself. Only the file's process, never one a test starts.
const guardMb = Number(process.env.CAIRN_TEST_RSS_GUARD_MB);
if (guardMb > 0 && process.env.CAIRN_TEST_RSS_GUARD_FILE && fromRunner) {
  const { Worker } = await import("node:worker_threads");
  const guard = new Worker(
    `const { workerData } = require("node:worker_threads");
     const fs = require("node:fs");
     setInterval(() => {
       const mb = process.memoryUsage.rss() / 2 ** 20;
       if (mb <= workerData.mb) return;
       try { fs.writeFileSync(workerData.file, String(Math.round(mb))); } catch {}
       process.kill(process.pid, "SIGKILL");
     }, 100);`,
    { eval: true, workerData: { mb: guardMb, file: process.env.CAIRN_TEST_RSS_GUARD_FILE } }
  );
  guard.unref();
}

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

// Only the DB is loaded here. A watched module is reset only once something has loaded it
// (the hook above notices it whenever it loads, however late), so each test file enters
// the server graph through its own imports and pays only for the part it uses — a module
// never loaded has no state to reset. Any import cycle member may load first:
// test/moduleLoadOrder.test.js holds that.
const { db } = await import("../dist/db.js");

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

// Has anything written to the DB since the last wipe? The wipe itself (~1 ms: a statement
// per table) is most of a test's fixed cost, and many tests never write. Two counters
// prove a DB untouched: this connection's total_changes() (every row an INSERT, UPDATE or
// DELETE on it changed, triggers included, rolled-back ones too — it never goes down) and
// PRAGMA data_version, which moves whenever ANY other connection commits — another
// DatabaseSync a test opens, a process it starts on the same file. Unchanged both ⇒ every
// table is still exactly as the last wipe left it. Anything unreadable counts as dirty.
const changesNow = db.prepare("SELECT total_changes() AS n");
const versionNow = db.prepare("PRAGMA data_version");
const odometer = () => {
  try {
    return `${changesNow.get().n}:${versionNow.get().data_version}`;
  } catch {
    return null;
  }
};
let wipedAt = null; // the odometer right after the last wipe; null = never wiped here

wipeDb = async () => {
  const now = odometer();
  if (now === null || now !== wipedAt) wipeTables();
  await resetMemos();
};

function wipeTables() {
  // Single transaction with deferred FK checks: intermediate deletes may briefly
  // violate foreign keys, but every table is empty at COMMIT so nothing trips.
  // `DELETE FROM <t>` with no WHERE uses SQLite's truncate optimization, so an
  // already-empty table costs almost nothing.
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
  wipedAt = odometer();
}

// In-process state is reset before EVERY test, wiped DB or not.
async function resetMemos() {
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
}
