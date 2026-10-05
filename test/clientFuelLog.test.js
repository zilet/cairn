// Fuel — "Log food" (fuel-log-client/-controller.ts, docs/V2-PLAN.md wave 2). One
// button opens the ONE food composer (stream C's component) under it in food mode; a
// meal logged there comes back through onLogged without leaving the screen, and the
// panel closes. "Start from this" fills the composer for editing and never sends.
// The last test runs the real composer end to end on the shared DOM harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeTimers, createHost, flush, loadClientModule } from "./_dom.mjs";

function load(extra = [], globals = {}) {
  return loadClientModule(["html-utils", "ui-actions-client", ...extra, "fuel-log-client", "fuel-log-controller"], {
    globals,
  });
}

function fakeComposer() {
  const mounts = [];
  const mountComposer = (host, deps) => {
    host.innerHTML = `<textarea id="${deps.idPrefix}Input"></textarea>`;
    const record = { host, deps, fills: [], torn: 0 };
    mounts.push(record);
    const handle = () => {
      record.torn++;
    };
    handle.fill = (text) => {
      record.fills.push(text);
      host.querySelector("textarea").value = text;
    };
    handle.send = async () => {};
    handle.clearAttachment = () => {};
    return handle;
  };
  return { mounts, mountComposer };
}

function mount(win, overrides = {}) {
  const composer = fakeComposer();
  const logged = [];
  const host = createHost(win.document);
  const handle = win.CairnFuelLogController.mount(host, {
    mountComposer: composer.mountComposer,
    api: async () => null,
    toast: () => {},
    reducedMotion: () => true,
    onLogged: (x) => logged.push(x),
    ...overrides,
  });
  return { host, handle, composer, logged };
}

test("the Log button is a real 44px-class button that opens the composer in food mode", async () => {
  const win = load();
  const { host, composer } = mount(win);
  const btn = host.querySelector("[data-fuel-log-toggle]");
  assert.equal(btn.getAttribute("type"), "button");
  assert.equal(btn.hasAttribute("aria-label"), false, "its name is its visible words, so the spoken name matches the seen one");
  assert.match(btn.querySelector(".fuel-log-faux").textContent, /What did you eat\?/);
  assert.equal(btn.querySelector(".fuel-log-fold").textContent, "Close");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(composer.mounts.length, 0, "the composer mounts on first open, not before");
  await btn.click();
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.ok(host.querySelector(".fuel-log").classList.contains("is-open"));
  assert.equal(composer.mounts.length, 1);
  assert.equal(composer.mounts[0].deps.mode, "food");
  assert.equal(composer.mounts[0].deps.idPrefix, "fuelLog");
  assert.equal(win.document.activeElement, host.querySelector("textarea"), "the athlete can type at once");
  await btn.click();
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  await btn.click();
  assert.equal(composer.mounts.length, 1, "closing hides the composer; it is not remounted");
});

test("Start from this fills the composer for editing and never sends", () => {
  const win = load();
  const { host, handle, composer } = mount(win);
  handle.open("Greek yogurt (a half portion)");
  assert.equal(host.querySelector("[data-fuel-log-toggle]").getAttribute("aria-expanded"), "true");
  assert.deepEqual(composer.mounts[0].fills, ["Greek yogurt (a half portion)"]);
  assert.equal(host.querySelector("textarea").value, "Greek yogurt (a half portion)");
});

test("a logged meal is handed back and the panel closes; the composer lives until teardown", () => {
  const win = load();
  const { host, handle, composer, logged } = mount(win);
  handle.open();
  composer.mounts[0].deps.onLogged({ turnId: 1, notes: [{ id: 9 }], reply: null });
  assert.equal(logged.length, 1);
  assert.equal(host.querySelector("[data-fuel-log-toggle]").getAttribute("aria-expanded"), "false");
  assert.equal(composer.mounts[0].torn, 0, "a send still being followed is never cut off by closing");
  handle();
  assert.equal(composer.mounts[0].torn, 1);
  host.remove();
  composer.mounts[0].deps.onLogged({ turnId: 2, notes: [], reply: null });
  assert.equal(logged.length, 1, "nothing reaches a surface the athlete has left");
});

test("mounting twice on one host leaves one listener", async () => {
  const win = load();
  const composer = fakeComposer();
  const host = createHost(win.document);
  const deps = {
    mountComposer: composer.mountComposer,
    api: async () => null,
    toast: () => {},
    reducedMotion: () => true,
    onLogged: () => {},
  };
  win.CairnFuelLogController.mount(host, deps);
  win.CairnFuelLogController.mount(host, deps);
  const btn = host.querySelector("[data-fuel-log-toggle]");
  await btn.click();
  assert.equal(btn.getAttribute("aria-expanded"), "true", "one tap opens (a second listener would close it again)");
});

test("end to end: a multi-line meal sent from Fuel logs without leaving the screen", async () => {
  const win = load(
    [
      "chat-composer-focus-client",
      "food-composer-model",
      "food-composer-client",
      "food-composer-chips-controller",
      "food-composer-turn-controller",
      "food-composer-controller",
    ],
    {
      matchMedia: () => ({ matches: false }),
      ...createFakeTimers(),
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      crypto: { randomUUID: () => "request-1" },
      CairnChatAttachment: {
        compressImage: async () => null,
        previewImage: (el) => el ?? null,
        resetFocusAfterNativePicker() {},
        settleAfterNativePicker() {},
      },
    }
  );
  const posts = [];
  const api = async (path, opts = {}) => {
    if (path === "/chat" && opts.method === "POST") {
      posts.push(JSON.parse(opts.body));
      return {
        ok: true,
        turn: {
          id: 11,
          status: "done",
          meta: { applied: [{ type: "log_food", result: { id: 88, meal: "lunch", enrichment_status: "done" } }] },
        },
      };
    }
    return null;
  };
  const logged = [];
  const toasts = [];
  const host = createHost(win.document);
  const handle = win.CairnFuelLogController.mount(host, {
    mountComposer: (h, deps) => win.CairnFoodComposer.mount(h, deps),
    api,
    toast: (m) => toasts.push(m),
    reducedMotion: () => true,
    onLogged: (x) => logged.push(x),
  });
  handle.open("chicken 200 g\nrice 150 g");
  const input = host.querySelector("#fuelLogInput");
  assert.equal(input.value, "chicken 200 g\nrice 150 g", "filled, not sent");
  assert.equal(posts.length, 0);
  await host.querySelector("#fuelLogSend").click();
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].capture, "food", "the send is marked as a food capture");
  assert.equal(posts[0].message, "chicken 200 g\nrice 150 g", "the athlete's words as typed");
  assert.equal(logged.length, 1);
  assert.deepEqual(
    [...logged[0].notes].map((n) => n.id),
    [88]
  );
  assert.equal(host.querySelector("[data-fuel-log-toggle]").getAttribute("aria-expanded"), "false");
  assert.equal(toasts.at(-1), "Logged your lunch");
});

test("Start from this keeps what the athlete already typed: the idea goes on a line below", () => {
  const win = load();
  const toasts = [];
  const { host, handle, composer } = mount(win, { toast: (m) => toasts.push(m) });
  handle.open();
  const input = host.querySelector("textarea");
  input.value = "eggs 3\ntoast 2 slices\n";
  handle.open("Greek yogurt (a half portion)");
  assert.equal(input.value, "eggs 3\ntoast 2 slices\nGreek yogurt (a half portion)");
  assert.deepEqual(toasts, ["Added below what you'd typed"]);
  handle.open("Greek yogurt (a half portion)");
  assert.equal(input.value, "eggs 3\ntoast 2 slices\nGreek yogurt (a half portion)", "never twice");
  assert.equal(composer.mounts.length, 1);
});

test("the Fuel composer carries a retry store, so a send lost to a reload replays once", () => {
  const win = load();
  const store = { loadRetry: () => null, saveRetry() {}, clearRetry() {} };
  const { handle, composer } = mount(win, { retryStore: store });
  handle.open();
  assert.equal(composer.mounts[0].deps.retryStore, store);
});

test("Fuel's retry store keeps a live envelope per viewer and drops an expired or broken one", () => {
  const win = loadClientModule(["fuel-deps"]);
  const store = win.CairnFuelDeps.retryStore();
  const later = Date.now() + 60_000;
  store.saveRetry({ requestId: "req-1", text: "chicken 200 g", hasImage: false, expiresAt: later });
  assert.equal(
    JSON.stringify(store.loadRetry()),
    JSON.stringify({ requestId: "req-1", text: "chicken 200 g", hasImage: false, expiresAt: later })
  );
  assert.equal(win.CairnFuelDeps.retryStore().loadRetry()?.requestId, "req-1", "survives a remount");
  store.clearRetry();
  assert.equal(store.loadRetry(), null);
  store.saveRetry({ requestId: "req-2", text: "rice", hasImage: false, expiresAt: Date.now() - 1 });
  assert.equal(store.loadRetry(), null, "an expired envelope never replays");
  win.localStorage.setItem("cairn.fuelLogRetry.v1", "{not json");
  assert.equal(store.loadRetry(), null);
  assert.equal(win.localStorage.getItem("cairn.fuelLogRetry.v1"), null, "a broken envelope is cleared");
  win.localStorage.getItem = () => {
    throw new Error("blocked");
  };
  assert.equal(store.loadRetry(), null, "blocked storage reads as no envelope");
});

function fuelDepsWin({ peeks, fresh = new Set(), asked = [], answers = [], primed = [], fanIns = [], bundles = [] }) {
  return loadClientModule(["fuel-deps"], {
    globals: {
      MEALS_KEY: "meals:plans",
      CairnFuelTodayController: {
        dayKey: (d) => `food:day:${d}`,
        bandKey: (d) => `fuel:band:${d}`,
        dayPath: (d) => `/nutrition/day?date=${d}`,
        bandPath: (d) => `/nutrition/intake-band?date=${d}`,
      },
      CairnIdeaCardController: { key: (d) => `fuel:ideas:${d}`, path: (d, h) => `/fuel/ideas?date=${d}&hour=${h}` },
      peekCached: (key) => (peeks.has(key) ? { data: {}, fresh: fresh.has(key) } : null),
      cachedApi: (path, options) => {
        asked.push(options.key);
        return new Promise((resolve) => answers.push(resolve));
      },
      settledWithin: (reads) => Promise.allSettled(reads).then(() => undefined),
      ensureBundle: (name) => {
        bundles.push(name);
        return Promise.resolve();
      },
      apiWriteGeneration: () => 0,
      api: (path) => {
        fanIns.push(path);
        return Promise.resolve({ responses: { "/mealplans?limit=12": [] } });
      },
      apiPrime: (paths, source) => primed.push({ paths: [...paths], source }),
    },
  });
}

test("Fuel's first paint asks the top slots' reads together, by the slots' own keys, and is null once all are warm", async () => {
  const asked = [];
  const peeks = new Set();
  const answers = [];
  const bundles = [];
  const win = fuelDepsWin({ peeks, asked, answers, bundles });
  const cold = win.CairnFuelDeps.firstPaint("2026-04-25", true);
  assert.ok(cold, "a cold open waits on the reads");
  // Today's Fuel also waits on the week-menu card's read and its lazy bundle, so the
  // card paints in the same frame as the slots around it instead of pushing them down.
  assert.deepEqual(asked, ["food:day:2026-04-25", "fuel:band:2026-04-25", "fuel:ideas:2026-04-25", "meals:plans"]);
  assert.deepEqual(bundles, ["meals"]);
  for (const resolve of answers) resolve({});
  await cold;

  // Another day asks no ideas and no menu; and once every read is warm there is nothing to wait for.
  asked.length = 0;
  bundles.length = 0;
  void win.CairnFuelDeps.firstPaint("2026-04-20", false);
  assert.deepEqual(asked, ["food:day:2026-04-20", "fuel:band:2026-04-20"]);
  assert.deepEqual(bundles, []);
  for (const key of ["food:day:2026-04-25", "fuel:band:2026-04-25", "fuel:ideas:2026-04-25", "meals:plans"]) peeks.add(key);
  assert.equal(win.CairnFuelDeps.firstPaint("2026-04-25", true), null);
});

test("today's Fuel asks its slots' reads in ONE /train-home?view=fuel, once per open, and never when every peek still serves", async () => {
  const peeks = new Set();
  const fresh = new Set();
  const primed = [];
  const fanIns = [];
  const win = fuelDepsWin({ peeks, fresh, primed, fanIns });
  const hour = new Date().getHours();
  void win.CairnFuelDeps.firstPaint("2026-04-25", true);
  assert.deepEqual(fanIns, [`/train-home?view=fuel&date=2026-04-25&hour=${hour}`]);
  assert.deepEqual(primed[0].paths, [
    "/nutrition/day?date=2026-04-25",
    "/nutrition/intake-band?date=2026-04-25",
    `/fuel/ideas?date=2026-04-25&hour=${hour}`,
    "/mealplans?limit=12",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(await primed[0].source)), { "/mealplans?limit=12": [] });

  // A repaint seconds later rides the standing primes.
  void win.CairnFuelDeps.firstPaint("2026-04-25", true);
  assert.equal(fanIns.length, 1);

  // A warm open whose peeks are stale still revalidates through the fan-in; another day never asks it.
  for (const key of ["food:day:2026-04-26", "fuel:band:2026-04-26", "fuel:ideas:2026-04-26", "meals:plans"]) peeks.add(key);
  assert.equal(win.CairnFuelDeps.firstPaint("2026-04-26", true), null);
  assert.equal(fanIns.length, 2);
  void win.CairnFuelDeps.firstPaint("2026-04-20", false);
  assert.equal(fanIns.length, 2);

  // Every peek young enough to serve without asking: no slot asks, so neither does the fan-in.
  for (const key of ["food:day:2026-04-27", "fuel:band:2026-04-27", "fuel:ideas:2026-04-27", "meals:plans"]) {
    peeks.add(key);
    fresh.add(key);
  }
  assert.equal(win.CairnFuelDeps.firstPaint("2026-04-27", true), null);
  assert.equal(fanIns.length, 2);
});
