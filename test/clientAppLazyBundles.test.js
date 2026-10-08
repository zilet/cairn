// LAZY APP-SHELL BUNDLES.
//
// index.html loads only the Today / You / Fuel shell; Train, Horizon, Ask,
// Settings and Me/Health are injected on first navigation (and warmed on idle). Everything that can go wrong here
// is invisible until a user taps a tab: two <script> tags for one bundle, a
// failed fetch that permanently wedges the destination, or a token/query string
// on the url that would miss the service worker's precache entry offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function fakeDom() {
  const scripts = [];
  // A lazy bundle's stylesheet <link>s. By default one lands on the next tick (the
  // precached, cache-hit case); `holdSheets` keeps them pending so a test can fire them.
  const sheets = [];
  const gate = { holdSheets: false };
  function makeNode(sink, onAttach) {
    const listeners = new Map();
    const node = {
      dataset: {},
      src: "",
      href: "",
      attached: false,
      addEventListener: (type, fn) => listeners.set(type, fn),
      remove() {
        node.attached = false;
        const at = sink.indexOf(node);
        if (at >= 0) sink.splice(at, 1);
      },
      fire: (type) => listeners.get(type)?.(),
    };
    node.onAttach = onAttach;
    return node;
  }
  const head = {
    appendChild(node) {
      node.attached = true;
      node.parentNode = head;
      (node.rel === "stylesheet" ? sheets : scripts).push(node);
      node.onAttach?.(node);
      return node;
    },
    insertBefore(node, ref) {
      node.attached = true;
      node.parentNode = head;
      sheets.splice(sheets.indexOf(ref), 0, node);
      node.onAttach?.(node);
      return node;
    },
  };
  const document = {
    createElement: (tag) => (tag === "link" ? makeNode(sheets, (n) => !gate.holdSheets && queueMicrotask(() => n.fire("load"))) : makeNode(scripts)),
    head,
    querySelectorAll: (selector) => (selector.includes("data-cairn-sheet") ? [...sheets] : []),
    querySelector(selector) {
      const sheet = /data-cairn-sheet="([^"]+)"/.exec(selector)?.[1];
      if (sheet) return sheets.find((l) => l.dataset.cairnSheet === sheet) || null;
      const name = /data-cairn-bundle="([^"]+)"/.exec(selector)?.[1];
      const wantLoaded = selector.includes('data-cairn-bundle-loaded="1"');
      return (
        scripts.find((s) => s.dataset.cairnBundle === name && (!wantLoaded || s.dataset.cairnBundleLoaded === "1")) ||
        null
      );
    },
  };
  return { document, scripts, sheets, gate };
}

function loadLoader(extra = {}) {
  const source = readFileSync(new URL("../public/js/app-lazy-bundles.js", import.meta.url), "utf8");
  const dom = fakeDom();
  const context = {
    document: dom.document,
    window: {},
    globalThis: null,
    ...extra,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-lazy-bundles.js" });
  return { context, ...dom };
}

const byName = (scripts, name) => scripts.find((s) => s.dataset.cairnBundle === name);

test("a bundle is injected once, with a precache-matching url", async () => {
  const env = loadLoader();
  assert.equal(typeof env.context.ensureBundle, "function");
  assert.equal(typeof env.context.window.ensureBundle, "function");

  const first = env.context.ensureBundle("meals");
  const second = env.context.ensureBundle("meals");
  assert.equal(env.scripts.length, 1, "concurrent callers share one <script>");

  const script = env.scripts[0];
  // No query string, ever: Cache Storage keys on the full url, so `?token=` would
  // miss the worker's precached CORE_ASSETS entry and break the offline first open.
  assert.equal(script.src, "/js/bundle-13-meals.js");
  assert.equal(script.dataset.cairnBundle, "meals");
  assert.equal(env.context.bundleLoaded("meals"), false);

  script.fire("load");
  await Promise.all([first, second]);

  assert.equal(env.context.bundleLoaded("meals"), true);
  await env.context.ensureBundle("meals");
  assert.equal(env.scripts.length, 1, "a loaded bundle is never re-injected");
});

test("every lazy bundle maps to its own precached url", () => {
  const env = loadLoader();
  assert.deepEqual({ ...env.context.LAZY_BUNDLE_SRC }, {
    "me-health": "/js/bundle-05-me-health.js",
    train: "/js/bundle-08-train.js",
    horizon: "/js/bundle-09-horizon.js",
    ask: "/js/bundle-10-ask.js",
    settings: "/js/bundle-11-settings.js",
    glance: "/js/bundle-18-glance.js",
    "day-view": "/js/bundle-19-day-view.js",
    calendar: "/js/bundle-12-calendar.js",
    journey: "/js/bundle-20-journey.js",
    body: "/js/bundle-21-body.js",
    meals: "/js/bundle-13-meals.js",
    fuel: "/js/bundle-22-fuel.js",
    "today-ahead": "/js/bundle-14-today-ahead.js",
    // The first-run welcome, and the AI sign-in panel it and Settings → Agents share.
    welcome: "/js/bundle-15-welcome.js",
    "agent-login": "/js/bundle-17-agent-login.js",
    auth: "/js/bundle-16-auth.js",
  });
});

test("a bundle resolves only once its dependencies have executed too", async () => {
  const env = loadLoader();
  // Train mounts body metrics, paints the journey reads and draws its Program rows with
  // the day view (which draws its chip and row with the glance under it).
  let done = false;
  const pending = env.context.ensureBundle("train").then(() => {
    done = true;
  });
  assert.deepEqual(env.scripts.map((s) => s.src).sort(), [
    "/js/bundle-08-train.js",
    "/js/bundle-18-glance.js",
    "/js/bundle-19-day-view.js",
    "/js/bundle-20-journey.js",
    "/js/bundle-21-body.js",
  ]);
  byName(env.scripts, "train").fire("load");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(done, false, "train alone is not enough");
  assert.equal(env.context.bundleLoaded("train"), false);
  for (const dep of ["glance", "day-view", "journey"]) {
    byName(env.scripts, dep).fire("load");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(done, false, `train's dependencies are still loading after ${dep}`);
  }
  byName(env.scripts, "body").fire("load");
  await pending;
  assert.equal(env.context.bundleLoaded("train"), true);
  // Horizon shares the already-loaded day view and journey reads: only its own tag is added.
  const horizon = env.context.ensureBundle("horizon");
  assert.equal(env.scripts.filter((s) => s.dataset.cairnBundle === "day-view").length, 1);
  assert.equal(env.scripts.filter((s) => s.dataset.cairnBundle === "train").length, 1);
  byName(env.scripts, "horizon").fire("load");
  await horizon;
});

test("Health loads the body bundle, not all of Train; Horizon the journey reads, not the rest of Train; Ask brings Fuel", async () => {
  const health = loadLoader();
  const pendingHealth = health.context.ensureBundle("me-health");
  assert.deepEqual(health.scripts.map((s) => s.src).sort(), ["/js/bundle-05-me-health.js", "/js/bundle-21-body.js"]);
  for (const s of [...health.scripts]) s.fire("load");
  await pendingHealth;
  assert.equal(health.context.bundleLoaded("train"), false, "Health never needed Train");

  const horizon = loadLoader();
  const pendingHorizon = horizon.context.ensureBundle("horizon");
  assert.deepEqual(horizon.scripts.map((s) => s.src).sort(), [
    "/js/bundle-09-horizon.js",
    "/js/bundle-18-glance.js",
    "/js/bundle-20-journey.js",
  ]);
  for (const s of [...horizon.scripts]) s.fire("load");
  await pendingHorizon;
  assert.equal(horizon.context.bundleLoaded("train"), false, "Horizon never needed Train");

  // Ask's chat composer mounts the food composer, so Ask brings Fuel's bundle; Fuel alone
  // (and Today) never load Ask.
  const ask = loadLoader();
  const pendingAsk = ask.context.ensureBundle("ask");
  assert.deepEqual(ask.scripts.map((s) => s.src).sort(), ["/js/bundle-10-ask.js", "/js/bundle-22-fuel.js"]);
  for (const s of [...ask.scripts]) s.fire("load");
  await pendingAsk;
  const fuel = loadLoader();
  const pendingFuel = fuel.context.ensureBundle("fuel");
  assert.deepEqual(fuel.scripts.map((s) => s.src), ["/js/bundle-22-fuel.js"]);
  fuel.scripts[0].fire("load");
  await pendingFuel;
  assert.equal(fuel.context.bundleLoaded("ask"), false, "Fuel never needed Ask");

  // Today's lower half draws its strip with the glance alone; a tapped day brings the rest.
  const ahead = loadLoader();
  const pendingAhead = ahead.context.ensureBundle("today-ahead");
  assert.deepEqual(ahead.scripts.map((s) => s.src).sort(), ["/js/bundle-14-today-ahead.js", "/js/bundle-18-glance.js"]);
  for (const s of [...ahead.scripts]) s.fire("load");
  await pendingAhead;
  assert.equal(ahead.context.bundleLoaded("calendar"), false, "the page waits for a tap");
});

test("a bundle with its own stylesheet is loaded only once script AND sheet landed", async () => {
  const env = loadLoader();
  env.gate.holdSheets = true;
  let done = false;
  const pending = env.context.ensureBundle("horizon").then(() => {
    done = true;
  });
  // The sheet is requested beside the script, at its precached, query-free url.
  const sheet = env.sheets.find((l) => l.dataset.cairnSheet === "horizon");
  assert.ok(sheet, "the horizon bundle adds its stylesheet");
  assert.equal(sheet.href, "/css/horizon.css");
  assert.equal(sheet.rel, "stylesheet");
  assert.deepEqual(env.sheets.map((l) => l.dataset.cairnSheet), ["horizon"], "a dependency without a sheet adds none");
  for (const s of [...env.scripts]) s.fire("load");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(done, false, "the code alone is not enough: the surface would paint unstyled");
  assert.equal(env.context.bundleLoaded("horizon"), false);
  sheet.fire("load");
  await pending;
  assert.equal(env.context.bundleLoaded("horizon"), true);
  // A second caller finds both and adds neither.
  await env.context.ensureBundle("horizon");
  assert.equal(env.sheets.length, 1);
});

test("lazy sheets keep CASCADE order whatever order their bundles load in", async () => {
  const env = loadLoader();
  const loadAll = async (name) => {
    const pending = env.context.ensureBundle(name);
    for (const s of env.scripts) if (s.dataset.cairnBundleLoaded !== "1" && s.dataset.cairnScriptDone !== "1") s.fire("load");
    await pending;
  };
  // The welcome (last in the cascade) lands first, then Ask, then the day view, Settings, Horizon.
  await loadAll("welcome");
  await loadAll("ask");
  await loadAll("day-view");
  await loadAll("settings");
  await loadAll("horizon");
  assert.deepEqual(
    env.sheets.map((l) => l.dataset.cairnSheet),
    ["settings", "day-view", "ask", "horizon", "welcome"],
    "the DOM order is LAZY_STYLE_SHEETS' order, so a tie is won exactly as when one file held them"
  );
});

test("a stylesheet that fails to load rejects, keeps the code, and a retry asks only for the sheet", async () => {
  const env = loadLoader();
  env.gate.holdSheets = true;
  const attempt = env.context.ensureBundle("day-view");
  env.sheets[0].fire("error");
  for (const s of [...env.scripts]) s.fire("load");
  await assert.rejects(attempt, /failed to load \/css\/day-view\.css/);
  assert.equal(env.sheets.length, 0, "the dead link is removed");
  assert.equal(env.scripts.length, 2, "the scripts that ran stay (glance, then the day view)");

  env.gate.holdSheets = false;
  await env.context.ensureBundle("day-view");
  assert.equal(env.sheets.length, 1, "the retry re-requests the sheet");
  assert.equal(env.scripts.length, 2, "and never the script");
  assert.equal(env.context.bundleLoaded("day-view"), true);
});

test("a failed load rejects and stays retryable", async () => {
  const env = loadLoader();
  const attempt = env.context.ensureBundle("meals");
  env.scripts[0].fire("error");
  await assert.rejects(attempt, /failed to load \/js\/bundle-13-meals\.js/);
  assert.equal(env.scripts.length, 0, "the dead tag is removed");

  const retry = env.context.ensureBundle("meals");
  assert.equal(env.scripts.length, 1, "a later navigation may retry");
  env.scripts[0].fire("load");
  await retry;
  assert.equal(env.context.bundleLoaded("meals"), true);
});

test("an unknown bundle name rejects instead of injecting anything", async () => {
  const env = loadLoader();
  await assert.rejects(env.context.ensureBundle("not-a-bundle"), /unknown lazy bundle/);
  await assert.rejects(env.context.ensureBundle("toString"), /unknown lazy bundle/);
  assert.equal(env.scripts.length, 0);
  assert.equal(env.context.bundleLoaded("toString"), false);
});

test("withBundle runs synchronously when warm and after the load when cold", async () => {
  const env = loadLoader();
  const calls = [];
  const cold = env.context.withBundle("train", () => {
    calls.push("cold");
    return "painted";
  });
  assert.deepEqual(calls, [], "a cold destination waits for its bundle");
  assert.equal(typeof cold.then, "function");
  for (const s of env.scripts) s.fire("load"); // train and the day bundle it depends on
  assert.equal(await cold, "painted");

  // Warm: the render runs inside the caller's turn (a view transition's update
  // callback paints real content, not a microtask later).
  const warm = env.context.withBundle("train", () => {
    calls.push("warm");
    return "sync";
  });
  assert.equal(warm, "sync");
  assert.deepEqual(calls, ["cold", "warm"]);
});

const settle = () => new Promise((r) => setImmediate(r));

function reconnectEnv(extra = {}, newRegistrations = 1) {
  const calls = [];
  const env = loadLoader({
    registerAppJobReconnectors: () => {
      calls.push("register");
      return newRegistrations;
    },
    jobReconnect: async () => {
      calls.push("reconnect");
    },
    ...extra,
  });
  return { env, calls };
}

test("a navigation into a bundle that brought a reconnector sweeps once, after it paints", async () => {
  const { env, calls } = reconnectEnv();
  const nav = env.context.withBundle("meals", () => {
    calls.push("paint");
  });
  assert.deepEqual(calls, [], "nothing runs before the script executes");
  env.scripts[0].fire("load");
  await nav;
  await settle();
  // The health_review reconnector lives on the Stand screen and reattaches only
  // while its view is on screen, so the sweep follows the paint.
  assert.deepEqual(calls, ["register", "paint", "reconnect"]);
  // The owed sweep is paid once: a later visit costs no /agent-jobs round trip.
  env.context.withBundle("meals", () => calls.push("paint"));
  await settle();
  assert.deepEqual(calls, ["register", "paint", "reconnect", "paint"]);
});

test("a sweep waits for an async destination render to settle", async () => {
  const { env, calls } = reconnectEnv();
  let finish;
  const nav = env.context.withBundle("meals", () =>
    new Promise((resolve) => {
      finish = () => {
        calls.push("painted");
        resolve();
      };
    })
  );
  env.scripts[0].fire("load");
  await settle();
  assert.deepEqual(calls, ["register"], "the render has not landed yet");
  finish();
  await nav;
  await settle();
  assert.deepEqual(calls, ["register", "painted", "reconnect"]);
});

test("a bundle that registers no new reconnector costs no /agent-jobs sweep", async () => {
  const { env, calls } = reconnectEnv({}, 0);
  const nav = env.context.withBundle("meals", () => calls.push("paint"));
  env.scripts[0].fire("load");
  await nav;
  await settle();
  assert.deepEqual(calls, ["register", "paint"]);
});

// The regression this guards: the idle warm-up loaded me-health on Today and ran
// the one reconnect sweep there, where the health_review reconnector (which only
// reattaches on the Health read view) found nothing. The later tap into Health was
// warm — no load, no sweep — so a running review never reattached, and every open
// paid a second /agent-jobs round trip for nothing.
test("the idle warm-up never sweeps; the first navigation into the warmed bundle does", async () => {
  const idle = [];
  const timers = [];
  const { env, calls } = reconnectEnv({
    requestIdleCallback: (cb) => idle.push(cb),
    setTimeout: (cb) => timers.push(cb),
    navigator: {},
  });
  env.context.prefetchLazyBundles();
  timers.shift()();
  while (idle.length) {
    idle.shift()();
    for (const s of env.scripts) if (s.dataset.cairnBundleLoaded !== "1") s.fire("load");
    await settle();
  }
  assert.equal(env.context.bundleLoaded("me-health"), true, "the warm-up executed me-health");
  assert.equal(calls.includes("reconnect"), false, "no /agent-jobs sweep at warm-up time");

  // Later, the athlete opens Health: warm, so it paints synchronously — and the
  // sweep it is owed follows, now that the Health view is on screen.
  const out = env.context.withBundle("me-health", () => {
    calls.push("paint-health");
    return "health";
  });
  assert.equal(out, "health", "a warm destination still paints inside the caller's turn");
  await settle();
  assert.deepEqual(calls.slice(-2), ["paint-health", "reconnect"]);
  assert.equal(calls.filter((c) => c === "reconnect").length, 1);
});

test("CAIRN_NO_WARMUP keeps every bundle cold for the browser smoke's navigation pass", () => {
  const timers = [];
  const env = loadLoader({ setTimeout: (cb) => timers.push(cb), navigator: {}, CAIRN_NO_WARMUP: true });
  env.context.prefetchLazyBundles();
  assert.equal(timers.length, 0);
  assert.equal(env.scripts.length, 0);
});

test("the idle warm-up executes every lazy bundle one at a time, once", async () => {
  const idle = [];
  const timers = [];
  const env = loadLoader({
    requestIdleCallback: (cb) => idle.push(cb),
    setTimeout: (cb) => timers.push(cb),
    navigator: {},
  });
  env.context.prefetchLazyBundles();
  env.context.prefetchLazyBundles(); // a second call is a no-op
  assert.equal(timers.length, 1, "the warm-up waits past the first paint");
  timers.shift()();
  const order = [];
  while (idle.length) {
    idle.shift()();
    for (const s of env.scripts) {
      if (s.dataset.cairnBundleLoaded !== "1" && !order.includes(s.dataset.cairnBundle)) {
        order.push(s.dataset.cairnBundle);
        s.fire("load");
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  // Today's lower half brings the glance it depends on with it (the dependency's tag
  // goes in first); train brings the day view, the journey reads and body metrics, and
  // the calendar (a tapped day's page) is warmed after Horizon.
  // Settings brings the AI sign-in panel bundle ahead of itself; the welcome follows.
  assert.deepEqual(order, [
    "glance",
    "today-ahead",
    "fuel",
    "day-view",
    "journey",
    "body",
    "train",
    "ask",
    "horizon",
    "calendar",
    "me-health",
    "meals",
    "agent-login",
    "settings",
    "welcome",
  ]);
  assert.equal(env.scripts.length, 15, "one tag per bundle");
});

test("the idle warm-up stands down on Save-Data", () => {
  const timers = [];
  const env = loadLoader({ setTimeout: (cb) => timers.push(cb), navigator: { connection: { saveData: true } } });
  env.context.prefetchLazyBundles();
  assert.equal(timers.length, 0);
  assert.equal(env.scripts.length, 0);
});

test("an owed sweep asks to reuse the boot sweep's seconds-old job list, never a second /agent-jobs", async () => {
  const seen = [];
  const env = loadLoader({
    registerAppJobReconnectors: () => 1,
    jobReconnect: async (opts) => {
      seen.push(opts);
    },
  });
  const nav = env.context.withBundle("meals", () => {});
  env.scripts[0].fire("load");
  await nav;
  await settle();
  assert.equal(seen.length, 1);
  assert.ok(seen[0] && seen[0].reuseWithinMs > 0, "the sweep reuses a recent list");
});
