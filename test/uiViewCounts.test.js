import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { api } from "../dist/api.js";
import { CLIENT_ROUTE_DEFINITIONS as ROUTES } from "../dist/contracts/client-routes.js";
import { db } from "../dist/db.js";
import { getDiagnostics, pruneDiagnosticEvents } from "../dist/repo/diagnostics.js";
import { localDateISO } from "../dist/repo/shared.js";
import {
  isUiViewKey,
  parseUiViewBatch,
  recordUiViewCounts,
  resolveUiViewDay,
  pruneUiViewCounts,
  uiViewKeys,
  uiViewSummary,
} from "../dist/repo/ui-views.js";
import { uiViewsHandler, uiViewsRouter } from "../dist/routes/ui-views.js";
import { runWithTimeZone } from "../dist/tz.js";
import { BUNDLES, CLIENT_OUTPUTS } from "../scripts/build-client.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function responseDouble() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

function post(body) {
  const res = responseDouble();
  uiViewsHandler({ body }, res);
  return res;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function opens() {
  return db
    .prepare("SELECT day, view, opens FROM ui_view_counts ORDER BY view")
    .all()
    .map((row) => ({ day: row.day, view: row.view, opens: row.opens }));
}

test("view keys are the closed route-contract set", () => {
  for (const key of ["today", "train", "train/intake", "horizon", "ask", "you", "you/stone", "settings/agents"]) {
    assert.equal(isUiViewKey(key), true, key);
  }
  assert.equal(isUiViewKey("nope"), false);
  assert.equal(isUiViewKey("train/not-a-section"), false);
  assert.equal(isUiViewKey("day/2026-01-01"), false);
  assert.equal(isUiViewKey("you/strength"), false);
  assert.equal(isUiViewKey("Today"), false);
  const keys = uiViewKeys();
  assert.deepEqual(keys, [...new Set(keys)].sort());
});

test("a batch is rejected whole on a bad entry, an unknown key, or a broken cap", () => {
  const bad = [
    null,
    [],
    {},
    { views: [] },
    { views: {} },
    { views: [null] },
    { views: [{ view: "today" }] },
    { views: [{ n: 1 }] },
    { views: [{ view: "today", n: 0 }] },
    { views: [{ view: "today", n: 51 }] },
    { views: [{ view: "today", n: 1.5 }] },
    { views: [{ view: "today", n: "1" }] },
    { views: [{ view: "not-a-view", n: 1 }] },
    {
      views: [
        { view: "today", n: 1 },
        { view: "made-up", n: 1 },
      ],
    },
    { views: Array.from({ length: 21 }, () => ({ view: "today", n: 1 })) },
  ];
  for (const body of bad) {
    assert.equal(parseUiViewBatch(body), null);
    const res = post(body);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ui_view_counts").get().n, 0);
  // Unknown-but-shaped is a rejection, not a quiet 204.
  const unknown = post({ views: [{ view: "not-a-view", n: 1 }] });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.error, "invalid ui view batch");
});

test("accepted batches upsert into today's local day and ignore a client-supplied day", () => {
  const first = post({
    views: [
      { view: "today", n: 2 },
      { view: "today", n: 3, day: "1999-01-01" },
    ],
  });
  assert.equal(first.statusCode, 204);
  const second = post({
    views: [
      { view: "today", n: 4 },
      { view: "ask", n: 1 },
    ],
  });
  assert.equal(second.statusCode, 204);
  assert.deepEqual(opens(), [
    { day: localDateISO(), view: "ask", opens: 1 },
    { day: localDateISO(), view: "today", opens: 9 },
  ]);
  const capped = post({ views: Array.from({ length: 20 }, () => ({ view: "horizon", n: 1 })) });
  assert.equal(capped.statusCode, 204);
  assert.equal(db.prepare("SELECT opens FROM ui_view_counts WHERE view = 'horizon'").get().opens, 20);
});

test("POST /ui-views is mounted on the API router", () => {
  const route = uiViewsRouter.stack.find((layer) => layer.route && layer.route.path === "/ui-views");
  assert.equal(route.route.methods.post, true);
  const found = [];
  const walk = (stack) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const path of paths) if (layer.route.methods?.post) found.push(path);
      } else if (Array.isArray(layer.handle?.stack)) walk(layer.handle.stack);
    }
  };
  walk(api.stack);
  assert.equal(found.includes("/ui-views"), true);
});

test("diagnostics ui_views is the last 30 days, highest first, top 25", () => {
  assert.deepEqual(getDiagnostics().ui_views, []);
  const keys = uiViewKeys();
  assert.equal(keys.length > 25, true);
  const today = localDateISO();
  const insert = db.prepare("INSERT INTO ui_view_counts (day, view, opens) VALUES (?, ?, ?)");
  keys.slice(0, 30).forEach((view, index) => insert.run(today, view, index + 1));
  insert.run("1999-01-01", keys[0], 9999);
  const summary = getDiagnostics().ui_views;
  assert.equal(summary.length, 25);
  assert.equal(summary[0].view, keys[29]);
  assert.equal(summary[0].opens, 30);
  assert.equal(typeof summary[0].opens, "number");
  assert.equal(
    summary.some((row) => row.opens === 9999),
    false
  );
  for (let i = 1; i < summary.length; i++) assert.equal(summary[i - 1].opens >= summary[i].opens, true);
});

test("tied view counts sort by name, and prune drops days older than 90", () => {
  post({
    views: [
      { view: "you", n: 2 },
      { view: "ask", n: 2 },
      { view: "train", n: 5 },
    ],
  });
  db.prepare("INSERT INTO ui_view_counts (day, view, opens) VALUES ('1999-01-01', 'horizon', 7)").run();
  assert.deepEqual(getDiagnostics().ui_views, [
    { view: "train", opens: 5 },
    { view: "ask", opens: 2 },
    { view: "you", opens: 2 },
  ]);
  pruneDiagnosticEvents();
  assert.deepEqual(
    opens().map((row) => row.view),
    ["ask", "train", "you"]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ui_view_counts WHERE day = '1999-01-01'").get().n, 0);
});

test("the counter ships in the eager core bundle, not as its own precached asset", () => {
  const output = CLIENT_OUTPUTS.find((item) => item.source === "src/client/ui-view-counter.ts");
  assert.equal(output && output.output, "public/js/ui-view-counter.js");
  const core = BUNDLES.find((bundle) => bundle.output === "public/js/bundle-01-core.js");
  assert.equal(core.inputs.includes("public/js/ui-view-counter.js"), true);
  const sw = readFileSync(join(root, "public/sw.js"), "utf8");
  assert.equal(sw.includes('"/js/ui-view-counter.js"'), false);
  assert.equal(sw.includes('"/js/client-diagnostics.js"'), false);
  const source = readFileSync(join(root, "src/client/ui-view-counter.ts"), "utf8");
  assert.match(source, /\/\/ @ts-check/);
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(source.includes("CairnClientDiagnostics"), false);
  const routeSync = readFileSync(join(root, "src/client/app/route-sync.ts"), "utf8");
  const tabs = readFileSync(join(root, "src/client/app/tabs.ts"), "utf8");
  assert.equal(routeSync.includes("CairnUiViewCounter?.noteActive?.()"), true);
  assert.equal(tabs.includes("noteUiViewOpen()"), true);
});

function loadCounter() {
  const context = {
    Blob,
    JSON,
    Map,
    Object,
    Array,
    String,
    Number,
    Promise,
    Intl,
    Error,
    Date,
    Math,
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-view-counter.js"), "utf8"), context);
  return context.CairnUiViewCounterCore;
}

function counter(extra = {}) {
  const { createUiViewCounter } = loadCounter();
  return createUiViewCounter({
    online: () => true,
    doNotTrack: () => null,
    sendBeacon: () => true,
    day: () => "2026-03-04",
    ...extra,
  });
}

test("screen keys name the home or section and never a date or an id", () => {
  const { uiViewKey } = loadCounter();
  assert.equal(uiViewKey({ tab: "today" }), "today");
  assert.equal(uiViewKey({ tab: "progress" }), "train");
  assert.equal(uiViewKey({ tab: "progress", progressSeg: "overview" }), "train");
  assert.equal(uiViewKey({ tab: "progress", progressSeg: "intake" }), "train/intake");
  assert.equal(uiViewKey({ tab: "chat" }), "ask");
  assert.equal(uiViewKey({ tab: "horizon" }), "horizon");
  assert.equal(uiViewKey({ tab: "horizon", horizonSeg: "goal" }), "horizon/goal");
  assert.equal(uiViewKey({ tab: "you" }), "you");
  assert.equal(uiViewKey({ tab: "you", youSeg: "stone", youStone: "strength" }), "you/stone");
  assert.equal(uiViewKey({ tab: "settings", setSeg: "agents" }), "settings/agents");
  assert.equal(uiViewKey({ tab: "day", dayDate: "2026-01-02" }), "day");
  assert.equal(uiViewKey({ tab: "stand", standSeg: "domain", standDomain: "lipids" }), "stand/domain");
  assert.equal(uiViewKey({ tab: "plan", planSeg: "food" }), "plan/food");
  assert.equal(uiViewKey({ tab: "" }), null);
});

test("every key the client counter can emit is accepted by the server allowlist", () => {
  const { uiViewKey } = loadCounter();
  const segField = {
    progress: "progressSeg",
    plan: "planSeg",
    stand: "standSeg",
    me: "meSeg",
    settings: "setSeg",
    horizon: "horizonSeg",
    you: "youSeg",
  };
  const states = [];
  for (const tab of ROUTES.tabs) {
    states.push({ tab });
    const field = segField[tab];
    for (const section of ROUTES.sections[tab] || []) {
      if (field) states.push({ tab, [field]: section });
      if (tab === "plan") states.push({ tab, planJump: section });
    }
  }
  states.push({ tab: "chat" }, { tab: "ask" }, { tab: "train" });
  let checked = 0;
  for (const state of states) {
    const key = uiViewKey(state);
    assert.notEqual(key, null, JSON.stringify(state));
    assert.equal(isUiViewKey(key), true, `${JSON.stringify(state)} -> ${key} is not on the server allowlist`);
    checked += 1;
  }
  assert.equal(checked > 40, true);
});

test("the counter debounces a repeated open, caps the batch, and flushes through sendBeacon", async () => {
  const sent = [];
  let fetched = 0;
  const seen = counter({
    sendBeacon(url, body) {
      sent.push({ url, body });
      return true;
    },
    fetch() {
      fetched += 1;
      return Promise.resolve();
    },
  });
  seen.note("today");
  seen.note("today");
  seen.note("ask");
  seen.note("today");
  assert.deepEqual(plain(seen.pending()), [
    { view: "ask", n: 1 },
    { view: "today", n: 2 },
  ]);
  seen.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/ui-views");
  assert.equal(fetched, 0);
  assert.deepEqual(JSON.parse(await sent[0].body.text()), {
    views: [
      { view: "ask", n: 1 },
      { view: "today", n: 2 },
    ],
    day: "2026-03-04",
  });
  assert.deepEqual(plain(seen.pending()), []);

  const capped = counter();
  for (const letter of "abcdefghijklmnopqrstu") capped.note(letter);
  const pending = capped.pending();
  assert.equal(pending.length, 20);
  assert.equal(
    pending.some((row) => row.view === "u"),
    false
  );
});

test("a view opened more than 50 times before a flush stops at 50", () => {
  const seen = counter();
  for (let i = 0; i < 60; i++) {
    seen.note(i % 2 === 0 ? "today" : "ask");
  }
  assert.equal(seen.pending().find((row) => row.view === "today").n, 30);
  assert.equal(seen.pending().find((row) => row.view === "ask").n, 30);
  // Drive today alone up to the cap by leaving and returning.
  for (let i = 0; i < 40; i++) {
    seen.note("ask");
    seen.note("today");
  }
  assert.equal(seen.pending().find((row) => row.view === "today").n, 50);
  assert.equal(seen.pending().find((row) => row.view === "ask").n, 50);
});

test("Do Not Track and offline drop counts instead of queueing them", () => {
  let beacons = 0;
  const quiet = counter({
    doNotTrack: () => "1",
    sendBeacon() {
      beacons += 1;
      return true;
    },
  });
  quiet.note("today");
  quiet.flush();
  assert.deepEqual(plain(quiet.pending()), []);
  assert.equal(beacons, 0);

  const allowed = counter({ doNotTrack: () => "0" });
  allowed.note("today");
  assert.equal(allowed.pending()[0].n, 1);

  let online = false;
  const dropped = counter({
    online: () => online,
    sendBeacon() {
      beacons += 1;
      return true;
    },
  });
  dropped.note("today");
  assert.deepEqual(plain(dropped.pending()), []);
  online = true;
  dropped.note("ask");
  assert.deepEqual(plain(dropped.pending()), [{ view: "ask", n: 1 }]);
  online = false;
  dropped.flush();
  assert.equal(beacons, 0);
  assert.deepEqual(plain(dropped.pending()), []);
});

test("flush uses fetch keepalive when sendBeacon cannot deliver", () => {
  const fetched = [];
  const fallback = counter({
    sendBeacon: () => false,
    fetch(url, init) {
      fetched.push({ url, init });
      return Promise.resolve();
    },
  });
  fallback.note("horizon");
  fallback.note("train");
  fallback.flush();
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "/api/ui-views");
  assert.equal(fetched[0].init.method, "POST");
  assert.equal(fetched[0].init.keepalive, true);
  assert.equal(fetched[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(fetched[0].init.body), {
    views: [
      { view: "horizon", n: 1 },
      { view: "train", n: 1 },
    ],
    day: "2026-03-04",
  });

  const authed = [];
  const withToken = counter({
    authToken: () => "secret-token",
    sendBeacon() {
      throw new Error("beacon must not run when a token has to be sent");
    },
    fetch(url, init) {
      authed.push(init.headers);
      return Promise.resolve();
    },
  });
  withToken.note("you");
  withToken.note("today");
  withToken.flush();
  assert.equal(authed.length, 1);
  assert.equal(authed[0]["X-Cairn-Token"], "secret-token");
});

test("a hidden page and the 60s timer flush, and nothing the counter does throws", () => {
  let visibility = "visible";
  const listeners = {};
  const host = {
    get visibilityState() {
      return visibility;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
  let sent = 0;
  let timer = null;
  const seen = counter({
    schedule(fn, delay) {
      timer = { fn, delay };
      return 1;
    },
    sendBeacon() {
      sent += 1;
      return true;
    },
  });
  seen.install(host);
  seen.install(host);
  assert.equal(timer.delay, 60_000);
  seen.note("today");
  seen.note("train");
  visibility = "hidden";
  listeners.visibilitychange();
  assert.equal(sent, 1);
  visibility = "visible";
  listeners.visibilitychange();
  assert.equal(sent, 1);
  seen.note("ask");
  timer.fn();
  assert.equal(sent, 2);

  const hostile = counter({
    doNotTrack: () => {
      throw new Error("dnt");
    },
    sendBeacon() {
      throw new Error("beacon");
    },
    fetch() {
      throw new Error("fetch");
    },
  });
  assert.doesNotThrow(() => {
    hostile.note("today");
    hostile.note("@@@");
    hostile.noteActive();
    hostile.flush();
    hostile.install({
      addEventListener() {
        throw new Error("listen");
      },
    });
  });
});

test("noteActive reads the shell state the hooks share", () => {
  let state = { tab: "progress", progressSeg: "intake" };
  const seen = counter({ state: () => state });
  seen.noteActive();
  seen.noteActive();
  state = { tab: "settings", setSeg: "agents" };
  seen.noteActive();
  assert.deepEqual(plain(seen.pending()), [
    { view: "settings/agents", n: 1 },
    { view: "train/intake", n: 1 },
  ]);
});

test("a beacon's device day is honoured within one day of the server date, else ignored", () => {
  assert.equal(resolveUiViewDay("2026-03-03", "2026-03-04"), "2026-03-03");
  assert.equal(resolveUiViewDay("2026-03-05", "2026-03-04"), "2026-03-05");
  assert.equal(resolveUiViewDay("2026-03-04", "2026-03-04"), "2026-03-04");
  assert.equal(resolveUiViewDay("2026-03-06", "2026-03-04"), "2026-03-04");
  assert.equal(resolveUiViewDay("1999-01-01", "2026-03-04"), "2026-03-04");
  assert.equal(resolveUiViewDay("2026-02-30", "2026-02-28"), "2026-02-28");
  assert.equal(resolveUiViewDay("2026-3-4", "2026-03-04"), "2026-03-04");
  assert.equal(resolveUiViewDay(20260304, "2026-03-04"), "2026-03-04");
  assert.equal(resolveUiViewDay(undefined, "2026-03-04"), "2026-03-04");
  // Month and year edges.
  assert.equal(resolveUiViewDay("2025-12-31", "2026-01-01"), "2025-12-31");
  assert.equal(resolveUiViewDay("2026-03-01", "2026-02-28"), "2026-03-01");

  const near = localDateISO(new Date(Date.now() - 86_400_000));
  const sameish = post({ views: [{ view: "today", n: 1 }], day: near });
  assert.equal(sameish.statusCode, 204);
  const far = post({ views: [{ view: "ask", n: 1 }], day: "1999-01-01" });
  assert.equal(far.statusCode, 204);
  const rows = opens();
  assert.equal(rows.find((r) => r.view === "ask").day, localDateISO());
  assert.equal(rows.find((r) => r.view === "today").day === resolveUiViewDay(near), true);
});

test("the 30-day summary and 90-day prune count calendar days across a DST change", () => {
  const insert = db.prepare("INSERT INTO ui_view_counts (day, view, opens) VALUES (?, ?, ?)");
  // Autumn: 2026-01-01 23:00 in Los Angeles; 90 calendar days back is 2025-10-03.
  insert.run("2025-10-03", "today", 1);
  insert.run("2025-10-02", "ask", 1);
  runWithTimeZone("America/Los_Angeles", () => pruneUiViewCounts(new Date("2026-01-02T07:00:00Z").getTime()));
  assert.deepEqual(
    opens().map((r) => r.day),
    ["2025-10-03"]
  );
  // Spring: 2026-03-20 00:30 PDT (DST began 03-08); 29 days back is 2026-02-19.
  insert.run("2026-02-19", "train", 3);
  insert.run("2026-02-18", "you", 4);
  const spring = runWithTimeZone("America/Los_Angeles", () =>
    uiViewSummary(new Date("2026-03-20T07:30:00Z").getTime())
  );
  assert.deepEqual(
    spring.map((r) => r.view),
    ["train"]
  );
});

test("a duplicate key in one batch is clamped to the per-key cap", () => {
  const res = post({
    views: [
      { view: "today", n: 50 },
      { view: "today", n: 50 },
      { view: "ask", n: 20 },
      { view: "ask", n: 20 },
    ],
  });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(
    opens().map((r) => [r.view, r.opens]),
    [
      ["ask", 40],
      ["today", 50],
    ]
  );
  recordUiViewCounts([
    { view: "ask", n: 50 },
    { view: "ask", n: 50 },
  ]);
  assert.equal(opens().find((r) => r.view === "ask").opens, 90);
});
