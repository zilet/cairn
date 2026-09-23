// Today's per-render GET prefetch (CairnTodayPrefetch, today-data-loader.ts) and the
// rail's use of it: renderToday starts reads before their slots mount, and each
// loader takes the in-flight request instead of asking twice. What renders is
// unchanged; these tests pin the one-shot contract that keeps it that way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(files, extra = {}) {
  let now = 1000;
  const context = {
    Array,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    Date: { now: () => now },
    ...extra,
  };
  context.window = context;
  for (const file of files) vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  return { context, advance: (ms) => (now += ms) };
}

test("a prefetched GET is handed out once, then the caller fetches its own", async () => {
  const { context } = load(["public/js/today-data-loader.js"]);
  const prefetch = context.CairnTodayPrefetch;
  let starts = 0;
  const first = prefetch.prefetch("/week-ahead", async () => {
    starts += 1;
    return { ok: 1 };
  });
  // A second prefetch of the same path joins the first request.
  assert.equal(
    prefetch.prefetch("/week-ahead", async () => (starts += 1)),
    first
  );
  assert.equal(starts, 1);
  assert.equal(prefetch.take("/week-ahead"), first);
  assert.equal(prefetch.take("/week-ahead"), undefined, "one-shot: a later draw is a deliberate refresh");
  assert.deepEqual(await first, { ok: 1 });

  const fetched = [];
  const own = await prefetch.get("/week-ahead", async (path) => {
    fetched.push(path);
    return "fresh";
  });
  assert.equal(own, "fresh");
  assert.deepEqual(fetched, ["/week-ahead"]);
});

test("an old or reset prefetch is never served", async () => {
  const { context, advance } = load(["public/js/today-data-loader.js"]);
  const prefetch = context.CairnTodayPrefetch;
  prefetch.prefetch("/insights", async () => "old");
  advance(15001);
  assert.equal(prefetch.take("/insights"), undefined, "past the TTL it falls through to a fresh fetch");

  prefetch.prefetch("/insights", async () => "this render");
  prefetch.reset();
  assert.equal(prefetch.take("/insights"), undefined, "a new render starts from an empty registry");
});

test("a failed prefetch never surfaces as an unhandled rejection, and the taker still sees it fail", async () => {
  const { context } = load(["public/js/today-data-loader.js"]);
  const prefetch = context.CairnTodayPrefetch;
  prefetch.prefetch("/team-week", () => Promise.reject(new Error("offline")));
  prefetch.prefetch("/sync-throw", () => {
    throw new Error("boom");
  });
  await assert.rejects(prefetch.take("/team-week"), /offline/);
  await assert.rejects(prefetch.take("/sync-throw"), /boom/);
});

test("the rail prefetch starts exactly the reads its loaders then take", async () => {
  const calls = [];
  const api = (path, opts) => {
    calls.push({ path, opts });
    if (path === "/insights") return Promise.resolve([{ id: 1, kind: "weekly_read", feedback: null }]);
    if (path === "/recent-training?limit=6") return Promise.resolve([]);
    return Promise.resolve(null);
  };
  const slots = new Map([["#qlRecent", { innerHTML: "x", isConnected: true }]]);
  const deps = {
    root: { querySelector: (sel) => slots.get(sel) || null },
    state: { tab: "today", logDate: "2026-09-23" },
    api,
  };
  const { context } = load(
    ["public/js/today-data-loader.js", "public/js/capture-reads-client.js", "public/js/today-rail-loaders-client.js"],
    { CairnCaptureReadDate: { weekRangeLabel: () => "" }, CairnTodayLately: { rowHtml: () => "" } }
  );
  context.CairnTodayRailLoaders.prefetchRail(["fuel", "lately", "weekly-read", "connection-insight"], deps);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const started = calls.map((c) => c.path).sort();
  assert.deepEqual(started, [
    "/insights",
    "/nutrition/day?date=2026-09-23",
    "/recent-training?limit=6",
    "/team-week",
    "/week-wins",
  ]);
  // The loader takes the in-flight request: no second GET for the same path.
  await context.CairnTodayRailLoaders.loadRecentActivities(deps);
  assert.equal(calls.filter((c) => c.path === "/recent-training?limit=6").length, 1);
  assert.equal(slots.get("#qlRecent").innerHTML, "", "an empty feed still clears the slot exactly as before");
  // A second draw is a refresh and fetches on its own.
  await context.CairnTodayRailLoaders.loadRecentActivities(deps);
  assert.equal(calls.filter((c) => c.path === "/recent-training?limit=6").length, 2);
});

test("an acknowledged weekly read does not prefetch the wins it will never draw", async () => {
  const calls = [];
  const api = (path) => {
    calls.push(path);
    return Promise.resolve(path === "/insights" ? [{ id: 1, kind: "weekly_read", feedback: "up" }] : null);
  };
  const { context } = load(["public/js/today-data-loader.js", "public/js/capture-reads-client.js"], {
    CairnCaptureReadDate: { weekRangeLabel: () => "" },
  });
  context.CairnCaptureReads.prefetch({ weekly: true, insight: false }, api);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.sort(), ["/insights", "/team-week"]);
});

test("renderToday starts its independent reads before it awaits the paint-critical ones", () => {
  const today = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
  const body = today.slice(today.indexOf("async function renderToday("));
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `renderToday contains ${needle}`);
    return index;
  };
  const load = at("await todayDataLoader.load(");
  const prepAwait = at("await Promise.all([prepPromise, readPromise, previewPromise])");
  // The Brief read and the preview need only the date: they start before the load.
  assert.ok(at("const readPromise = loadBrief(") < load);
  assert.ok(at("const previewPromise = loadAdaptiveSessionPreview(") < load);
  // Run line, agenda, conductor, the rail prefetch and the side reads start before
  // the prep/Brief/preview await — not after the first paint.
  for (const needle of [
    "const runLinePromise",
    "const agendaPromise",
    "const conductorPromise",
    ".prefetchRail?.(",
    "todayPrefetch.prefetch(sidePath",
    'todayPrefetch.prefetch("/context-tags/vocab"',
  ]) {
    assert.ok(at(needle) < prepAwait, `${needle} starts before the paint-critical await`);
  }
  // The registry is reset once per render, before anything is prefetched into it.
  assert.ok(at("todayPrefetch?.reset()") < at("const readPromise = loadBrief("));
});
