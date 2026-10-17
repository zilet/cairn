import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCardioSync() {
  class FixedDate extends Date {
    static now() {
      return Date.parse("2026-06-30T12:00:00.000Z");
    }
  }

  const context = {
    Date: FixedDate,
    Infinity,
    Math,
    Number,
    Object,
    String,
    relTime: (at) => `<${at}>`,
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  // date-utils publishes pickDayVariant, which the quiet notes rotate through; the
  // fixture's relTime stub still wins so the assertions stay on the wording.
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  context.relTime = (at) => `<${at}>`;
  vm.runInNewContext(readFileSync(join(root, "public/js/cardio-sync-client.js"), "utf8"), context);
  return context.CairnCardioSync;
}

test("cardio sync helper detects configured Garmin credentials", () => {
  const sync = loadCardioSync();

  assert.equal(typeof sync.wire, "function");
  assert.deepEqual(Array.from(sync.zoneColors), ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"]);
  assert.equal(sync.configured(null), false);
  assert.equal(sync.configured({ garmin_credentials_source: "none" }), false);
  assert.equal(sync.configured({ garmin_credentials_source: "env" }), true);
  assert.equal(sync.configured({ garmin_username: "athlete" }), true);
  assert.equal(sync.configured({ garmin_password_configured: true }), true);
});

test("cardio sync helper stays silent when Garmin is not configured", () => {
  const sync = loadCardioSync();

  assert.equal(sync.lineHtml({ garmin_credentials_source: "none" }), "");
});

test("cardio sync helper nudges stale expected runs calmly", () => {
  const sync = loadCardioSync();
  const html = sync.lineHtml({ garmin_username: "athlete" }, { expectingRun: true });

  assert.match(html, /this morning's run not synced yet\?/);
  assert.match(html, /cardio-sync-dot stale/);
  assert.match(html, /data-syncnow/);
});

test("cardio sync helper renders recent sync freshness", () => {
  const sync = loadCardioSync();
  const html = sync.lineHtml({
    garmin_username: "athlete",
    garmin_last_sync_at: "2026-06-30T11:00:00.000Z",
    garmin_last_sync_status: "ok",
  });

  assert.match(html, /synced &lt;2026-06-30T11:00:00\.000Z&gt;/);
  assert.doesNotMatch(html, /stale/);
});

test("cardio sync helper renders failed sync state", () => {
  const sync = loadCardioSync();
  const html = sync.lineHtml({
    garmin_username: "athlete",
    garmin_last_sync_at: "2026-06-30T11:00:00.000Z",
    garmin_last_sync_status: "failed: auth",
  });

  assert.match(html, /Sync failed/);
  assert.match(html, /cardio-sync-dot err/);
});

// ---- the quiet notes under the sync row ----------------------------------------
// Two things could be wrong and neither was visible anywhere: a strength write-back
// that had stopped landing, and a watch that had stopped sending sleep.

const CONFIGURED = { garmin_credentials_source: "env", garmin_last_sync_at: "2026-06-30T11:00:00.000Z" };

test("a Garmin write-back that stopped landing says so, with what happens next", () => {
  const sync = loadCardioSync();

  const html = sync.lineHtml({
    ...CONFIGURED,
    garmin_last_export_status: "failed: timeout",
    garmin_last_export_attempt_at: "2026-06-30T10:00:00.000Z",
  });

  assert.match(html, /cardio-sync-note/);
  assert.match(html, /didn't land|didn't take|failed/);
  // The stub's angle brackets come back escaped — the note goes through escHtml.
  assert.match(html, /&lt;2026-06-30T10:00:00\.000Z&gt;/);
});

test("a watch that stopped sending sleep is named once, and only past the threshold", () => {
  const sync = loadCardioSync();

  assert.match(sync.lineHtml({ ...CONFIGURED, garmin_sleep_gap_nights: 4 }), /4 of the last 7 nights/);
  // Two stray nights is normal; the line stays quiet.
  assert.doesNotMatch(sync.lineHtml({ ...CONFIGURED, garmin_sleep_gap_nights: 2 }), /cardio-sync-note/);
  assert.doesNotMatch(sync.lineHtml(CONFIGURED), /cardio-sync-note/);
});

test("an unconfigured Garmin says nothing at all, notes included", () => {
  const sync = loadCardioSync();

  assert.equal(sync.lineHtml({ garmin_sleep_gap_nights: 7, garmin_last_export_status: "failed: auth" }), "");
});

// ---- Sync now: a background job, followed to its end -----------------------------
// POST /api/garmin/sync answers at once with a garmin_sync job; the client reads
// /agent-jobs/:id until the job ends and settles with the sync's own result.

function jobApi(script) {
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push([path, opts.method || "GET", opts]);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(path) : next;
  };
  return { api, calls };
}

const RUNNING = { ok: true, job: { id: 7, kind: "garmin_sync", status: "running" } };
const DONE = (result) => ({ ok: true, job: { id: 7, kind: "garmin_sync", status: "done", result } });
const noWait = async () => {};

test("Sync now follows the job to the sync's own result, and two callers share one run", async () => {
  const sync = loadCardioSync();
  const { api, calls } = jobApi([
    { ok: true, queued: true, joined: false, job_id: 7, job: { id: 7, kind: "garmin_sync", status: "queued" } },
    RUNNING,
    DONE({ ok: true, activities: 2, daily_metrics: 14 }),
  ]);
  const first = sync.sync({ api, wait: noWait });
  const second = sync.sync({ api, wait: noWait });
  assert.ok(first === second, "a second ask while one runs is the same run");
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.activities, 2);
  assert.deepEqual(
    calls.map(([path, method]) => `${method} ${path}`),
    ["POST /garmin/sync", "GET /agent-jobs/7", "GET /agent-jobs/7"],
    "one POST, then reads of that job until it ends"
  );
  // The reads skip the client's micro-cache and take a 404 body rather than throwing.
  assert.equal(calls[1][2].cache, "no-store");
  assert.equal(calls[1][2].acceptErrorBody, true);

  // Settled: the next ask is a fresh run.
  const again = jobApi([{ ok: true, job: { id: 8, status: "done", result: { ok: true, activities: 0 } } }]);
  assert.equal((await sync.sync({ api: again.api, wait: noWait })).activities, 0);
});

test("Sync now settles quietly on every way a sync can fail to land", async () => {
  const sync = loadCardioSync();
  // Garmin answered no: the job is done and its result says so.
  let run = jobApi([RUNNING, DONE({ ok: false, error: "auth" })]);
  assert.equal((await sync.sync({ api: run.api, wait: noWait })).ok, false);
  // The job itself failed (a restart, a throw).
  run = jobApi([RUNNING, { ok: true, job: { id: 7, status: "error", error: "interrupted" } }]);
  assert.equal(await sync.sync({ api: run.api, wait: noWait }), null);
  // The job is gone.
  run = jobApi([RUNNING, { ok: false, error: "not found" }]);
  assert.equal(await sync.sync({ api: run.api, wait: noWait }), null);
  // The POST could not reach the server.
  run = jobApi([new Error("offline")]);
  assert.equal(await sync.sync({ api: run.api, wait: noWait }), null);
  // The server went away mid-sync: a few missed reads end the wait, not four minutes of them.
  run = jobApi([RUNNING, ...Array.from({ length: 20 }, () => new Error("offline"))]);
  assert.equal(await sync.sync({ api: run.api, wait: noWait }), null);
  assert.equal(run.calls.length, 1 + 5, "five missed reads, then it stops asking");
  // A missed read in the middle is not an ending.
  run = jobApi([RUNNING, new Error("blip"), RUNNING, DONE({ ok: true, activities: 1 })]);
  assert.equal((await sync.sync({ api: run.api, wait: noWait })).activities, 1);
  // An older server that still answered inline is read as that answer.
  run = jobApi([{ ok: true, activities: 4 }]);
  assert.equal((await sync.sync({ api: run.api, wait: noWait })).activities, 4);
});

function fakeSyncLine() {
  const classes = (initial = []) => {
    const set = new Set(initial);
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  };
  const text = { textContent: "synced 3h ago" };
  const dot = { classList: classes() };
  const line = {
    querySelector: (sel) => (sel === ".cardio-sync-text" ? text : sel === ".cardio-sync-dot" ? dot : null),
  };
  const listeners = {};
  const btn = {
    dataset: {},
    disabled: false,
    isConnected: true,
    textContent: "Sync now",
    closest: () => line,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    click: () => listeners.click(),
  };
  const scope = { querySelectorAll: () => [btn] };
  return { scope, btn, text, dot };
}

// Timers on the next macrotask (whatever their delay): a poll's wait and a read's
// deadline both fire, and a response that does arrive (a microtask) always beats its
// read's deadline. A read that never answers loses to it.
const macroTimers = {
  setTimeout: (fn) => setImmediate(fn),
  clearTimeout: (handle) => clearImmediate(handle),
};

function wiredCardioSync(api) {
  const toasts = [];
  const writes = [];
  const context = {
    Date,
    Infinity,
    Math,
    Number,
    Object,
    String,
    relTime: (at) => `<${at}>`,
    api,
    ...macroTimers,
    toast: (message) => toasts.push(message),
    CairnWriteInvalidation: { invalidateWrite: (name) => writes.push(name) },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/cardio-sync-client.js"), "utf8"), context);
  const line = fakeSyncLine();
  const refreshed = { count: 0 };
  context.CairnCardioSync.wire(line.scope, () => {
    refreshed.count += 1;
  });
  return { ...line, toasts, writes, refreshed };
}

test("tapping Sync now: one calm toast and a refresh when the sync lands", async () => {
  const { api } = jobApi([RUNNING, DONE({ ok: true, activities: 1 })]);
  const w = wiredCardioSync(api);
  const tap = w.btn.click();
  assert.equal(w.btn.disabled, true, "the button is busy while the sync runs");
  assert.equal(w.dot.classList.contains("pulse"), true);
  assert.match(w.text.textContent, /Asking Garmin/);
  await tap;
  assert.deepEqual(w.toasts, ["Garmin synced · 1 activity"]);
  assert.deepEqual(w.writes, ["garmin_sync"], "every read a sync feeds is dropped");
  assert.equal(w.refreshed.count, 1);
});

test("a sync that lands after the athlete left the surface still refreshes the reads it fed", async () => {
  const { api } = jobApi([RUNNING, DONE({ ok: true, activities: 2 })]);
  const w = wiredCardioSync(api);
  const tap = w.btn.click();
  w.btn.isConnected = false; // a tab switch / re-render mid-sync
  await tap;
  assert.deepEqual(w.writes, ["garmin_sync"], "the refresh does not depend on the button still being there");
  assert.deepEqual(w.toasts, [], "nothing paints for a line that is gone");
  assert.equal(w.refreshed.count, 0);
});

test("a sync Garmin turned down points to Settings; one with no answer is a retry", async () => {
  const cases = [
    // Garmin answered no (a sign-in the server could not make): a retry will not help.
    [[RUNNING, DONE({ ok: false, error: "auth" })], /didn't go through · Settings → Sources has the details/],
    // The job failed outright (a deadline, a restart): asking again is the fix.
    [[RUNNING, { ok: true, job: { id: 7, status: "error", error: "Garmin sync timed out" } }], /didn't answer just now · try again/],
  ];
  for (const [script, line] of cases) {
    const { api } = jobApi(script);
    const w = wiredCardioSync(api);
    await w.btn.click();
    assert.deepEqual(w.toasts, [], "a sync that did not land is no toast");
    assert.deepEqual(w.writes, []);
    assert.equal(w.refreshed.count, 0);
    assert.equal(w.btn.disabled, false, "the button is ready again");
    assert.equal(w.dot.classList.contains("pulse"), false);
    assert.match(w.text.textContent, line);
    assert.doesNotMatch(w.text.textContent, /error|failed|job|auth/i);
  }
});

test("a read that never answers (api() leaves a 401 pending) cannot hold the button busy", async () => {
  const never = new Promise(() => {});
  // The POST itself never answers.
  let w = wiredCardioSync(async () => never);
  await w.btn.click();
  assert.equal(w.btn.disabled, false, "the button frees");
  assert.match(w.text.textContent, /try again/);

  // The POST answers, every status read hangs: a few unanswered reads end the wait.
  let reads = 0;
  let answering = false;
  w = wiredCardioSync(async (path) => {
    if (path === "/garmin/sync") return RUNNING;
    reads += 1;
    return answering ? DONE({ ok: true, activities: 1 }) : never;
  });
  await w.btn.click();
  assert.equal(w.btn.disabled, false);
  assert.equal(reads, 5, "five unanswered reads, then it stops asking");
  assert.match(w.text.textContent, /try again/);

  // And the page-wide run was released: the next tap is a fresh run that can land.
  answering = true;
  await w.btn.click();
  assert.deepEqual(w.toasts, ["Garmin synced · 1 activity"]);
  assert.equal(w.refreshed.count, 1);
});

test("the shared run settles on a hung read with its own per-read deadline", async () => {
  const sync = loadCardioSync();
  const never = new Promise(() => {});
  assert.equal(await sync.sync({ api: async () => never, wait: noWait, readTimeoutMs: 5 }), null);
  let reads = 0;
  const api = async (path) => {
    if (path === "/garmin/sync") return RUNNING;
    reads += 1;
    return never;
  };
  assert.equal(await sync.sync({ api, wait: noWait, readTimeoutMs: 5 }), null);
  assert.equal(reads, 5);
});
