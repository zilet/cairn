// Today's per-render GET prefetch (CairnTodayPrefetch, today-prefetch.ts) and the
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
  const { context } = load(["public/js/today-prefetch.js"]);
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
  const { context, advance } = load(["public/js/today-prefetch.js"]);
  const prefetch = context.CairnTodayPrefetch;
  prefetch.prefetch("/insights", async () => "old");
  advance(15001);
  assert.equal(prefetch.take("/insights"), undefined, "past the TTL it falls through to a fresh fetch");

  prefetch.prefetch("/insights", async () => "this render");
  prefetch.reset();
  assert.equal(prefetch.take("/insights"), undefined, "a new render starts from an empty registry");
});

test("a failed prefetch never surfaces as an unhandled rejection, and the taker still sees it fail", async () => {
  const { context } = load(["public/js/today-prefetch.js"]);
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
    ["public/js/today-prefetch.js", "public/js/capture-reads-client.js", "public/js/today-rail-loaders-client.js"],
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
  const { context } = load(["public/js/today-prefetch.js", "public/js/capture-reads-client.js"], {
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

test("primeFanIn primes every Today path from ONE widened aggregate, and skips a fetch seconds old", async () => {
  const primed = [];
  const asked = [];
  const { context } = load(["public/js/today-prefetch.js"], {
    encodeURIComponent,
    apiPrime: (paths, source) => primed.push({ paths: [...paths], source }),
    CairnTodayDataLoader: { aggregatePath: (date, tab) => `/today?date=${date}&surface=${tab}` },
  });
  const deps = {
    api: (path) => {
      asked.push(path);
      return Promise.resolve({ responses: { "/directives": { directives: [] } } });
    },
    localISO: () => "2026-09-26",
  };
  context.CairnTodayPrefetch.primeFanIn("2026-09-26", deps);
  assert.deepEqual(asked, ["/today?date=2026-09-26&surface=today"], "one request for the whole open");
  const paths = primed[0].paths;
  for (const path of [
    "/today-plan-day?date=2026-09-26",
    "/today-agenda?date=2026-09-26",
    "/today-side?date=2026-09-26",
    "/training-agenda?date=2026-09-26",
    "/directives",
    "/brain/changes",
    "/settings",
  ]) {
    assert.ok(paths.includes(path), path);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await primed[0].source)), { "/directives": { directives: [] } });

  // A past date has no run line: its agenda is not asked for.
  context.CairnTodayPrefetch.primeFanIn("2026-09-20", deps);
  assert.equal(primed[1].paths.some((p) => p.startsWith("/training-agenda")), false);

  // This page primed the same date seconds ago (a soft repaint): those primes stand.
  context.CairnTodayPrefetch.primeFanIn("2026-09-20", deps);
  assert.equal(primed.length, 2);
  assert.equal(asked.length, 2);
});

test("primeFanIn(…, 'session') primes the Session's own reads from ONE /today?surface=session", async () => {
  const primed = [];
  const asked = [];
  const { context } = load(["public/js/today-prefetch.js"], {
    encodeURIComponent,
    apiPrime: (paths, source) => primed.push({ paths: [...paths], source }),
    CairnTodayDataLoader: { aggregatePath: (date, tab) => `/today?date=${date}&surface=${tab}` },
  });
  const deps = {
    api: (path) => {
      asked.push(path);
      return Promise.resolve({ responses: { "/profile": { name: "A" } } });
    },
    localISO: () => "2026-09-26",
  };
  context.CairnTodayPrefetch.primeFanIn("2026-09-26", deps, "session");
  assert.deepEqual(asked, ["/today?date=2026-09-26&surface=session"]);
  assert.deepEqual([...primed[0].paths].sort(), [
    "/profile",
    "/settings",
    "/strength-journey",
    "/today-plan-day?date=2026-09-26",
    "/today-strength-line?date=2026-09-26",
    "/training-symptoms?on=2026-09-26&include_resolved=1",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(await primed[0].source)), { "/profile": { name: "A" } });
  // The Today open's primes for the same date never stand in for the Session's.
  context.CairnTodayPrefetch.primeFanIn("2026-09-26", deps, "today");
  assert.equal(asked.length, 2);
  context.CairnTodayPrefetch.primeFanIn("2026-09-26", deps, "today");
  assert.equal(asked.length, 2, "a repaint seconds later rides the standing primes");
});

test("the Train fan-in primes each view's reads from ONE /train-home", async () => {
  const primed = [];
  const asked = [];
  const { context } = load(["public/js/train-fan-in-client.js"], {
    encodeURIComponent,
    localISO: () => "2026-09-26",
    api: (path) => {
      asked.push(path);
      return Promise.resolve({ responses: { "/stats": {} } });
    },
    apiPrime: (paths, source) => primed.push({ paths: [...paths], source }),
  });
  context.CairnTrainFanIn.prime("endurance");
  context.CairnTrainFanIn.prime("program");
  context.CairnTrainFanIn.prime("overview", ["/stats", "/journey"]);
  context.CairnTrainFanIn.prime("goal");
  assert.deepEqual(asked, [
    "/train-home?view=endurance&date=2026-09-26",
    "/train-home?view=program&date=2026-09-26",
    "/train-home?view=overview&date=2026-09-26",
    "/train-home?view=goal&date=2026-09-26",
  ]);
  assert.deepEqual(
    primed[3].paths,
    ["/journey", "/journey/milestones", "/journey/timeline", "/today-path?date=2026-09-26"],
    "Horizon's goal line: the journey cards and the All-goals board"
  );
  assert.ok(primed[0].paths.includes("/training-agenda?date=2026-09-26"));
  assert.ok(primed[0].paths.includes("/calibration/status?date=2026-09-26"));
  assert.ok(primed[1].paths.includes("/strength-journeys") && primed[1].paths.includes("/dexa-targeting"));
  assert.deepEqual(primed[2].paths, ["/stats", "/journey"], "the home passes its own list");
  assert.deepEqual(JSON.parse(JSON.stringify(await primed[2].source)), { "/stats": {} });
});

test("the Train fan-in is asked once per open; a write or a later open asks again", async () => {
  const asked = [];
  let gen = 0;
  const { context, advance } = load(["public/js/train-fan-in-client.js"], {
    encodeURIComponent,
    localISO: () => "2026-09-26",
    api: (path) => {
      asked.push(path);
      return Promise.resolve({ responses: {} });
    },
    apiPrime: () => {},
    apiWriteGeneration: () => gen,
  });
  context.CairnTrainFanIn.prime("program");
  context.CairnTrainFanIn.prime("program");
  assert.equal(asked.length, 1, "a repaint seconds later rides the standing primes");
  context.CairnTrainFanIn.prime("endurance");
  assert.equal(asked.length, 2, "another view is its own open");
  gen++;
  context.CairnTrainFanIn.prime("endurance");
  assert.equal(asked.length, 3, "a write cleared the primes: ask afresh");
  advance(3000);
  context.CairnTrainFanIn.prime("endurance");
  assert.equal(asked.length, 4, "a later open asks again");
});

test("the Health fan-in primes the overview's reads plus the open leaf's, once per open", async () => {
  const primed = [];
  const asked = [];
  const { context, advance } = load(["public/js/health-fan-in-client.js"], {
    api: (path) => {
      asked.push(path);
      return Promise.resolve({ responses: {} });
    },
    apiPrime: (paths, source) => primed.push({ paths: [...paths], source }),
  });
  context.CairnHealthFanIn.prime("share");
  context.CairnHealthFanIn.prime("share");
  assert.deepEqual(asked, ["/you-health?leaf=share"], "the warm-behind rides the open's fan-in");
  assert.ok(primed[0].paths.includes("/markers/priority") && primed[0].paths.includes("/health/visit-questions"));
  context.CairnHealthFanIn.prime("records");
  assert.equal(asked[1], "/you-health?leaf=records");
  assert.ok(primed[1].paths.includes("/health-docs") && !primed[1].paths.includes("/health/visit-questions"));
  advance(3000);
  context.CairnHealthFanIn.prime("records");
  assert.equal(asked.length, 3, "a later open asks again");
  assert.equal(context.CairnHealthFanIn.leafOf("connections"), "health");
  assert.equal(context.CairnHealthFanIn.leafOf("toString"), "health");
});

test("takeEarly hands a live early response over once, and a failed one as a network failure", async () => {
  const live = { status: 200 };
  const { context } = load(["public/js/today-prefetch.js"], {
    TypeError,
    __cairnEarly: {
      "/today-read?date=2026-09-26": { at: 1000, res: Promise.resolve(live) },
      "/today?date=2026-09-26": { at: 1000, res: Promise.resolve(null) }, // index.html's catch
    },
  });
  context.globalThis = context;
  const prefetch = context.CairnTodayPrefetch;
  assert.equal(await prefetch.takeEarly("/today-read?date=2026-09-26"), live);
  assert.equal(prefetch.takeEarly("/today-read?date=2026-09-26"), undefined, "handed over once");
  await assert.rejects(prefetch.takeEarly("/today?date=2026-09-26"), TypeError);
  assert.equal(prefetch.takeEarly("/daily-session/preview?date=2026-09-26"), undefined);
});
