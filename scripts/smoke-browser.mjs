// Dependency-free browser smoke for the generated PWA app shell.
//
// This intentionally stays outside `npm run verify`: it needs a local Chrome
// binary and loopback CDP, so it is a release/manual gate rather than a fast
// deterministic unit gate. It catches the runtime class that static checks
// cannot: syntax errors, broken script order, missing globals, and route boot
// failures in a real browser.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cdp, launchChrome, stopChrome, tail } from "./cdp-chrome.mjs";
import { serverEntry, sleep, withServer } from "./smoke-server.mjs";

const SMOKE_NAME = "browser";
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 600;
const WORKFLOW_COUNT = 14;

// Five homes (v2 wave 5): Today / Train / Horizon / Ask / You. `tab` is the VIEW
// (window.state.tab); `home` is the lit tab-bar button. Every v1 path is rewritten
// in place (replaceState) to its v2 form: `expectedHref`.
const routes = [
  { path: "/", tab: "today", home: "today" },
  { path: "/app/today", tab: "today", home: "today" },
  // The v2 grammar, /app/<home>/<section>.
  { path: "/app/today/fuel", tab: "plan", home: "today", expectedState: { planSeg: "food" } },
  // The week menu: the current meal plan's days, meals, swaps and recipes.
  { path: "/app/today/menu", tab: "plan", home: "today", expectedState: { planSeg: "meals" } },
  { path: "/app/train/energy", tab: "progress", home: "train", expectedState: { progressSeg: "energy" } },
  // Program hosts the multi-anchor strength card (GET /api/strength-journeys).
  { path: "/app/train/program", tab: "progress", home: "train", expectedState: { progressSeg: "program" } },
  { path: "/app/train/plan", tab: "plan", home: "train", expectedState: { planSeg: "edit" } },
  { path: "/app/horizon", tab: "horizon", home: "horizon" },
  { path: "/app/horizon/race", tab: "plan", home: "horizon", expectedState: { planSeg: "endurance" } },
  { path: "/app/ask", tab: "chat", home: "ask" },
  { path: "/app/ask/changes", tab: "plan", home: "ask", expectedState: { planSeg: "coach" } },
  { path: "/app/you", tab: "you", home: "you" },
  { path: "/app/you/health", tab: "stand", home: "you", expectedState: { standSeg: null } },
  { path: "/app/you/age", tab: "stand", home: "you", expectedState: { standSeg: "age" } },
  { path: "/app/you/records", tab: "stand", home: "you", expectedState: { standSeg: "records" } },
  { path: "/app/you/markers", tab: "stand", home: "you", expectedState: { standSeg: "markers" } },
  // The marker-domain drill-in is a real route carrying its domain key in ?id=.
  { path: "/app/you/domain?id=heart", tab: "stand", home: "you", expectedState: { standSeg: "domain" } },
  { path: "/app/you/memory", tab: "me", home: "you", expectedState: { meSeg: "memory" } },
  { path: "/app/you/family", tab: "me", home: "you", expectedState: { meSeg: "family" } },
  { path: "/app/you/settings/data", tab: "settings", home: "you", expectedState: { setSeg: "data" } },
  { path: "/app/you/settings/agents", tab: "settings", home: "you", expectedState: { setSeg: "agents" } },
  // v1 paths land on the same surface and are rewritten to v2.
  { path: "/app/plan/food", tab: "plan", home: "today", expectedHref: "/app/today/fuel", expectedState: { planSeg: "food" } },
  // Plan → Meals lands on the week menu.
  { path: "/app/plan/meals", tab: "plan", home: "today", expectedHref: "/app/today/menu", expectedState: { planSeg: "meals" } },
  { path: "/app/plan/coach", tab: "plan", home: "ask", expectedHref: "/app/ask/changes", expectedState: { planSeg: "coach" } },
  { path: "/app/plan/edit", tab: "plan", home: "train", expectedHref: "/app/train/plan", expectedState: { planSeg: "edit" } },
  { path: "/app/progress/program", tab: "progress", home: "train", expectedHref: "/app/train/program", expectedState: { progressSeg: "program" } },
  { path: "/app/stand", tab: "stand", home: "you", expectedHref: "/app/you/health", expectedState: { standSeg: null } },
  { path: "/app/stand/records", tab: "stand", home: "you", expectedHref: "/app/you/records", expectedState: { standSeg: "records" } },
  // A domain URL with no key is not an error — Health falls back to the overview.
  { path: "/app/stand/domain", tab: "stand", home: "you", expectedHref: "/app/you/health", expectedState: { standSeg: null } },
  { path: "/app/me/standing", tab: "stand", home: "you", expectedHref: "/app/you/age", expectedState: { standSeg: "age" } },
  { path: "/app/me/health/read", tab: "stand", home: "you", expectedHref: "/app/you/health", expectedState: { standSeg: null } },
  { path: "/app/me/health/records", tab: "stand", home: "you", expectedHref: "/app/you/records", expectedState: { standSeg: "records" } },
  { path: "/app/me/memory", tab: "me", home: "you", expectedHref: "/app/you/memory", expectedState: { meSeg: "memory" } },
  { path: "/app/chat", tab: "chat", home: "ask", expectedHref: "/app/ask" },
  { path: "/app/settings", tab: "you", home: "you", expectedHref: "/app/you" },
  { path: "/app/settings/data", tab: "settings", home: "you", expectedHref: "/app/you/settings/data", expectedState: { setSeg: "data" } },
];

const requiredGlobals = {
  startAppShell: "function",
  activateTab: "function",
  switchTab: "function",
  teardownJobs: "function",
  registerJobReconnector: "function",
  registerAppJobReconnectors: "function",
  jobReconnect: "function",
  installMobileViewportGuards: "function",
  CairnRoutes: "object",
  "CairnRoutes.parseRoute": "function",
  CairnTodayAddExerciseController: "object",
  CairnTodaySessionController: "object",
  CairnChatAttachment: "object",
  CairnMealRecipeController: "object",
  CairnFuelTodayController: "object",
  // The eager half of the lazy-bundle contract.
  ensureBundle: "function",
  withBundle: "function",
  prefetchLazyBundles: "function",
};

// Each LAZY bundle (index.html loads none of them) and a few globals it brings.
// Absent on boot by design; asserted once a route that needs the bundle has
// navigated, which is what proves the on-demand injection actually works.
const lazyBundles = {
  "me-health": { file: "bundle-05-me-health", globals: { CairnStand: "object", CairnMeMemoryController: "object", CairnHealthClient: "object", renderMe: "function" } },
  train: { file: "bundle-08-train", globals: { renderTrainOverview: "function", renderProgress: "function", renderPlanEditor: "function", CairnBodyMetrics: "object" } },
  horizon: { file: "bundle-09-horizon", globals: { renderHorizon: "function", renderPlanEndurance: "function" } },
  ask: { file: "bundle-10-ask", globals: { renderChat: "function", CairnChatClient: "object", CairnRippleCardController: "object" } },
  settings: { file: "bundle-11-settings", globals: { renderSettings: "function", CairnSettingsAgents: "object" } },
  calendar: { file: "bundle-12-calendar", globals: { renderDay: "function", CairnDayRecord: "object", CairnDrill: "object" } },
};

/** The lazy bundles a smoke route's destination must have injected (dependencies included). */
function lazyBundlesFor(route) {
  const planSeg = route.expectedState?.planSeg;
  if (route.tab === "stand" || route.tab === "me") return ["me-health", "train"];
  if (route.tab === "progress") return ["train"];
  if (route.tab === "horizon") return ["horizon", "train"];
  if (route.tab === "chat") return ["ask"];
  if (route.tab === "settings") return ["settings"];
  if (route.tab === "day") return ["calendar"];
  if (route.tab === "plan" && planSeg === "edit") return ["train"];
  if (route.tab === "plan" && planSeg === "endurance") return ["horizon", "train"];
  if (route.tab === "plan" && planSeg === "coach") return ["ask"];
  return [];
}

function ok(cond, label, detail) {
  if (!cond) throw new Error(`assertion failed: ${label}${detail ? ` - ${detail}` : ""}`);
  console.log(`  OK ${label}`);
}

function createSmokeAgentsConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "cairn-browser-smoke-agents-"));
  const file = path.join(dir, "agents.json");
  const streamCommand = [
    "sleep 0.4",
    "printf '%s\\n' '{\"type\":\"thought\",\"data\":\"checking the training context\"}'",
    "sleep 0.2",
    "printf '%s\\n' '{\"type\":\"text\",\"data\":\"Smoke chat stream\"}'",
    "sleep 0.5",
    "printf '%s\\n' '{\"type\":\"text\",\"data\":\" complete.\"}'",
  ].join("; ");
  writeFileSync(file, JSON.stringify({
    chat_smoke: {
      command: "sh",
      args: ["-c", "printf '%s' 'Smoke chat fallback complete.'"],
      input: "arg",
      description: "Offline streaming browser-smoke agent.",
      env_required: [],
      login: null,
      status_check: null,
      auth_state: null,
      models_list: null,
      model_flag: ["--model", "{model}"],
      stream: {
        format: "grok",
        args: ["-c", streamCommand],
      },
    },
  }, null, 2));
  return { dir, file };
}

async function newPage(chrome) {
  const res = await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  ok(res.ok, "Chrome created a fresh page", `status ${res.status}`);
  const page = await res.json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.command("Page.enable");
  await cdp.command("Runtime.enable");
  await cdp.command("Network.enable");
  await cdp.command("Log.enable");
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  return cdp;
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(describeException(result.exceptionDetails));
  }
  return result.result?.value;
}

async function waitForHydration(cdp, expectedTab) {
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, `(() => {
      const view = document.querySelector("#view");
      return {
        tab: window.state && window.state.tab,
        viewTextLength: view ? view.textContent.trim().length : 0,
        viewChildren: view ? view.children.length : 0
      };
    })()`);
    if (last && last.tab === expectedTab && last.viewTextLength > 0) return last;
    await sleep(100);
  }
  throw new Error(`route did not hydrate as ${expectedTab}; last state ${JSON.stringify(last)}`);
}

async function waitForCondition(cdp, label, expression, timeoutMs = NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (last?.ok === true) {
      ok(true, label);
      return last;
    }
    await sleep(100);
  }
  throw new Error(`${label} did not complete; last state ${JSON.stringify(last)}`);
}

async function apiJson(base, pathName, opts = {}) {
  const headers = {
    ...(opts.body != null ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${base}/api${pathName}`, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  ok(res.ok && !(body && body.error), `API ${opts.method || "GET"} ${pathName}`, body?.error || `status ${res.status}`);
  return body;
}

async function assertGlobals(cdp) {
  const globalsJson = JSON.stringify(requiredGlobals);
  const result = await evaluate(cdp, `(() => {
    const required = ${globalsJson};
    const missing = [];
    const types = {};
    for (const [name, expected] of Object.entries(required)) {
      let value = window;
      for (const part of name.split(".")) value = value && value[part];
      const actual = value === null ? "null" : typeof value;
      types[name] = actual;
      if (actual !== expected) missing.push(name + ":" + actual);
    }
    return { missing, types };
  })()`);
  ok(result && result.missing.length === 0, "critical app globals are present", JSON.stringify(result?.missing || []));
}

// A lazy bundle is injected on the first navigation that needs it. Assert both
// halves: the loader marked its <script> loaded, and the bundle's globals landed
// — and that no navigation ever injected a second tag for it.
async function assertLazyBundle(cdp, name, label) {
  const { file, globals } = lazyBundles[name];
  const result = await evaluate(cdp, `(() => {
    const required = ${JSON.stringify(globals)};
    const missing = [];
    for (const [name, expected] of Object.entries(required)) {
      const actual = window[name] === null ? "null" : typeof window[name];
      if (actual !== expected) missing.push(name + ":" + actual);
    }
    return {
      missing,
      injected: !!document.querySelector('script[data-cairn-bundle="${name}"][data-cairn-bundle-loaded="1"]'),
      tags: [...document.querySelectorAll("script[src]")].filter((s) => s.src.includes("${file}")).length
    };
  })()`);
  ok(result?.injected === true, `${label} injected the lazy ${name} bundle`, JSON.stringify(result));
  ok(result?.missing.length === 0, `${label} lazy ${name} globals are present`, JSON.stringify(result?.missing || []));
  ok(result?.tags === 1, `${label} loaded ${file} exactly once`, JSON.stringify(result));
}

function describeConsole(args) {
  return (args || []).map((arg) => arg.value ?? arg.description ?? arg.type ?? "").join(" ");
}

function describeException(detail) {
  const exception = detail?.exception;
  return exception?.description || exception?.value || detail?.text || "unknown";
}

function collectFailures(cdp, base) {
  const failures = [];
  const allowedTypes = new Set(["Document", "Script", "Stylesheet", "Fetch", "XHR"]);
  const off = cdp.on((msg) => {
    const params = msg.params || {};
    if (msg.method === "Runtime.exceptionThrown") {
      const detail = params.exceptionDetails;
      failures.push(`runtime exception: ${describeException(detail)}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && params.type === "error") {
      failures.push(`console error: ${describeConsole(params.args)}`);
    } else if (msg.method === "Log.entryAdded" && params.entry?.level === "error") {
      failures.push(`log error: ${params.entry.text || params.entry.url || "unknown"}`);
    } else if (msg.method === "Network.responseReceived") {
      const res = params.response || {};
      if (allowedTypes.has(params.type) && String(res.url || "").startsWith(base) && Number(res.status) >= 400) {
        failures.push(`${params.type} ${res.status}: ${res.url}`);
      }
    } else if (msg.method === "Network.loadingFailed") {
      if (allowedTypes.has(params.type) && !params.canceled) {
        failures.push(`${params.type} failed: ${params.errorText || "unknown"}`);
      }
    }
  });
  return { failures, off };
}

async function smokeRoute(cdp, base, route) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, route.path, route.tab);
    await assertGlobals(cdp);
    for (const name of lazyBundlesFor(route)) await assertLazyBundle(cdp, name, route.path);
    const state = await evaluate(cdp, `(() => {
      const view = document.querySelector("#view");
      return {
        href: location.pathname + location.search,
        tab: window.state && window.state.tab,
        planSeg: window.state && window.state.planSeg,
        progressSeg: window.state && window.state.progressSeg,
        standSeg: window.state && window.state.standSeg,
        meSeg: window.state && window.state.meSeg,
        healthSeg: window.state && window.state.healthSeg,
        setSeg: window.state && window.state.setSeg,
        home: document.querySelector(".tab.active")?.dataset.tab || null,
        tabCount: document.querySelectorAll(".tabbar .tab").length,
        viewTextLength: view ? view.textContent.trim().length : 0,
        scripts: document.scripts.length
      };
    })()`);
    const expectedHref = route.expectedHref || route.path;
    ok(state.href === expectedHref, `${route.path} lands on ${expectedHref} after hydration`, JSON.stringify(state));
    ok(state.tab === route.tab, `${route.path} active tab is ${route.tab}`, JSON.stringify(state));
    ok(state.home === route.home, `${route.path} lights the ${route.home} home`, JSON.stringify(state));
    ok(state.tabCount === 5, `${route.path} shows the five-home tab bar`, JSON.stringify(state));
    for (const [key, value] of Object.entries(route.expectedState || {})) {
      ok(state[key] === value, `${route.path} preserves ${key}=${value}`, JSON.stringify(state));
    }
    ok(state.viewTextLength > 0, `${route.path} hydrated non-empty view`, JSON.stringify(state));
    ok(failures.length === 0, `${route.path} has no browser runtime/load errors`, failures.join("\n"));
  } finally {
    off();
  }
}

async function navigateAndHydrate(cdp, base, path, tab) {
  const loaded = cdp.waitFor("Page.loadEventFired");
  const nav = await cdp.command("Page.navigate", { url: `${base}${path}` });
  ok(!nav.errorText, `navigate ${path}`, nav.errorText || "");
  await loaded;
  await waitForHydration(cdp, tab);
  await sleep(SETTLE_MS);
}

// The idle warm-up executes every lazy bundle ~1.5 s after load, so the route pass
// above can be satisfied by the warm-up rather than by the navigation path. This
// pass boots with the warm-up OFF (CAIRN_NO_WARMUP) and proves a tab switch onto a
// COLD bundle injects it, paints the destination, and never double-injects.
async function smokeColdTabNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const { identifier } = await cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.CAIRN_NO_WARMUP = true;",
  });
  try {
    await navigateAndHydrate(cdp, base, "/app/today", "today");
    await sleep(2500); // well past the warm-up's delay: nothing may have loaded itself
    const cold = await evaluate(cdp, `[...document.querySelectorAll("script[data-cairn-bundle]")].map((s) => s.dataset.cairnBundle)`);
    ok(Array.isArray(cold) && cold.length === 0, "with the warm-up off, no lazy bundle loads on its own", JSON.stringify(cold));
    const hops = [
      { home: "train", tab: "progress", bundles: ["train"] },
      { home: "horizon", tab: "horizon", bundles: ["horizon", "train"] },
      { home: "ask", tab: "chat", bundles: ["ask"] },
    ];
    for (const hop of hops) {
      await evaluate(cdp, `(() => {
        const btn = document.querySelector('.tabbar .tab[data-tab="${hop.home}"]');
        if (!btn) throw new Error("missing the ${hop.home} home");
        btn.click();
        return true;
      })()`);
      await waitForCondition(cdp, `a tap on the cold ${hop.home} home paints its destination`, `(() => {
        const view = document.querySelector("#view");
        return {
          ok: Boolean(window.state?.tab === "${hop.tab}" && view && view.textContent.trim().length > 0 &&
            document.querySelector('script[data-cairn-bundle="${hop.bundles[0]}"][data-cairn-bundle-loaded="1"]')),
          tab: window.state && window.state.tab
        };
      })()`);
      for (const name of hop.bundles) await assertLazyBundle(cdp, name, `cold tap on ${hop.home}`);
    }
    ok(failures.length === 0, "cold tab navigation has no browser runtime/load errors", failures.join("\n"));
  } finally {
    await cdp.command("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    off();
  }
}

async function smokeTodayAddExercise(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const exercise = `Smoke off-plan ${Date.now()}`;
  const exerciseJson = JSON.stringify(exercise);
  try {
    await navigateAndHydrate(cdp, base, "/app/today", "today");
    await assertGlobals(cdp);

    // Set-by-set logging (add-exercise, log rows) now lives in the isolated
    // Session destination, opened from Today via the #sessLaunch card — or, when the
    // Brief already carries this session's start (one action, one button), via the
    // Brief's own start-session button instead. Enter it before exercising add-exercise.
    const launched = await evaluate(cdp, `(() => {
      const launch = document.querySelector("#sessLaunch") ||
        document.querySelector('[data-redirect="start-session"]');
      if (!launch) return { ok: false, reason: "missing #sessLaunch and the Brief's start-session button" };
      launch.click();
      return { ok: true };
    })()`);
    ok(launched?.ok === true, "Today opens the Session destination", JSON.stringify(launched));
    await waitForCondition(cdp, "Session destination renders the add-exercise control", `(() => {
      const dest = document.querySelector(".sess-dest");
      const button = document.querySelector("#addExBtn");
      return { ok: Boolean(dest && button), hasDest: Boolean(dest), hasBtn: Boolean(button) };
    })()`);

    const opened = await evaluate(cdp, `(() => {
      const button = document.querySelector("#addExBtn");
      if (!button) return { ok: false, reason: "missing #addExBtn" };
      button.click();
      const form = document.querySelector("#addExForm");
      const input = document.querySelector("#addExInput");
      return {
        ok: Boolean(form && input && form.hidden === false),
        formHidden: form ? form.hidden : null,
        activeId: document.activeElement ? document.activeElement.id : ""
      };
    })()`);
    ok(opened?.ok === true, "Today add exercise form opens", JSON.stringify(opened));

    await evaluate(cdp, `(() => {
      const input = document.querySelector("#addExInput");
      const go = document.querySelector("#addExGo");
      if (!input || !go) throw new Error("missing Today add exercise input/button");
      input.value = ${exerciseJson};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      go.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Today adds a custom off-plan card", `(() => {
      const name = ${exerciseJson};
      const card = [...document.querySelectorAll(".ex[data-card]")]
        .find((el) => (el.dataset.card || "").toLowerCase() === name.toLowerCase());
      const form = document.querySelector("#addExForm");
      const button = document.querySelector("#addExBtn");
      const input = card ? card.querySelector(".logrow .in-r, .logrow .in-dur") : null;
      return {
        ok: Boolean(
          card &&
          card.querySelector(".ex-offplan") &&
          card.querySelector("[data-remove-card]") &&
          input &&
          form?.hidden === true &&
          button?.hidden === false
        ),
        card: card ? card.dataset.card : null,
        mode: card ? card.dataset.mode : null,
        hasOffPlanLabel: Boolean(card?.querySelector(".ex-offplan")),
        hasRemoveButton: Boolean(card?.querySelector("[data-remove-card]")),
        hasLogInput: Boolean(input),
        formHidden: form ? form.hidden : null,
        buttonHidden: button ? button.hidden : null
      };
    })()`);

    await evaluate(cdp, `(() => {
      const name = ${exerciseJson};
      const card = [...document.querySelectorAll(".ex[data-card]")]
        .find((el) => (el.dataset.card || "").toLowerCase() === name.toLowerCase());
      const reps = card && card.querySelector(".logrow .in-r");
      const log = card && card.querySelector(".logbtn");
      if (!card || !reps || !log) throw new Error("missing off-plan set logging controls");
      reps.value = "5";
      reps.dispatchEvent(new Event("input", { bubbles: true }));
      log.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Today logs a set through the session controller", `(() => {
      const name = ${exerciseJson};
      const card = [...document.querySelectorAll(".ex[data-card]")]
        .find((el) => (el.dataset.card || "").toLowerCase() === name.toLowerCase());
      const chip = card && card.querySelector("[data-logged] .chip");
      const skip = card && card.querySelector(".ex-skip");
      return {
        ok: Boolean(card && chip && !skip),
        card: card ? card.dataset.card : null,
        hasChip: Boolean(chip),
        hasSkip: Boolean(skip)
      };
    })()`);
    ok(failures.length === 0, "Session destination add-exercise workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeChatAttachmentFocus(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/ask", "chat");
    await assertGlobals(cdp);
    const result = await evaluate(cdp, `(() => new Promise((resolve) => {
      const input = document.querySelector("#chatInput");
      const fileInput = document.querySelector("#chatFile");
      const attach = document.querySelector("#chatAttach");
      const preview = document.querySelector("#chatPreview");
      const attachment = window.CairnChatAttachment;
      const hasHelpers = Boolean(
        attachment &&
        typeof attachment.resetFocusAfterNativePicker === "function" &&
        typeof attachment.settleAfterNativePicker === "function" &&
        typeof attachment.compressImage === "function" &&
        typeof attachment.previewImage === "function"
      );
      if (!input || !fileInput || !attach || !preview || !hasHelpers) {
        resolve({
          ok: false,
          reason: "missing chat attachment globals/dom",
          hasInput: Boolean(input),
          hasFileInput: Boolean(fileInput),
          hasAttach: Boolean(attach),
          hasPreview: Boolean(preview),
          hasHelpers
        });
        return;
      }

      const events = [];
      const onSettle = (event) => {
        events.push({
          type: event.type,
          chatFocusGraceMs: event.detail && event.detail.chatFocusGraceMs
        });
      };
      document.addEventListener("cairn:keyboard-settle", onSettle, { once: true });

      input.focus();
      const focusedBeforeReset = document.activeElement === input;
      document.body.classList.add("kb-open");
      document.body.classList.add("kb-geometry-open");
      attachment.resetFocusAfterNativePicker({ input, fileInput, isSoftKeyboard: () => true });

      let measureCount = 0;
      attachment.settleAfterNativePicker({
        isActive: () => window.state && window.state.tab === "chat",
        measure: () => { measureCount += 1; },
        graceMs: 1300
      });

      setTimeout(() => {
        document.removeEventListener("cairn:keyboard-settle", onSettle);
        resolve({
          ok: Boolean(
            document.body.classList.contains("chat-mode") &&
            focusedBeforeReset &&
            document.activeElement !== input &&
            document.activeElement !== fileInput &&
            !document.body.classList.contains("kb-open") &&
            !document.body.classList.contains("kb-geometry-open") &&
            events.length === 1 &&
            events[0].chatFocusGraceMs === 1300 &&
            measureCount >= 1
          ),
          chatMode: document.body.classList.contains("chat-mode"),
          focusedBeforeReset,
          activeId: document.activeElement ? document.activeElement.id : "",
          kbOpen: document.body.classList.contains("kb-open"),
          kbGeometryOpen: document.body.classList.contains("kb-geometry-open"),
          events,
          measureCount
        });
      }, 120);
    }))()`);
    ok(result?.ok === true, "Chat attachment focus recovery globals/events work", JSON.stringify(result));
    ok(failures.length === 0, "/app/ask attachment workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeChatSendStreamReconnect(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const message = `Smoke stream check ${Date.now()}`;
  const messageJson = JSON.stringify(message);
  try {
    await navigateAndHydrate(cdp, base, "/app/ask", "chat");
    await assertGlobals(cdp);
    await waitForCondition(cdp, "Chat composer hydrates before send", `(() => {
      const input = document.querySelector("#chatInput");
      const send = document.querySelector("#chatSend");
      const log = document.querySelector("#chatlog");
      return {
        ok: Boolean(input && send && log && !log.querySelector(".loadstate")),
        hasInput: Boolean(input),
        hasSend: Boolean(send),
        hasLog: Boolean(log),
        loading: Boolean(log?.querySelector(".loadstate")),
        href: location.pathname + location.search
      };
    })()`);

    await evaluate(cdp, `(() => {
      const input = document.querySelector("#chatInput");
      const send = document.querySelector("#chatSend");
      if (!input || !send) throw new Error("missing Chat input/send controls");
      input.value = ${messageJson};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
      return { value: input.value, activeId: document.activeElement ? document.activeElement.id : "" };
    })()`);

    await waitForCondition(cdp, "Chat send creates the user bubble", `(() => {
      const message = ${messageJson};
      const userBubble = [...document.querySelectorAll(".bubble.user .bubble-text")]
        .find((el) => el.textContent?.includes(message));
      return {
        ok: Boolean(userBubble && location.pathname === "/app/ask" && window.state?.tab === "chat"),
        found: Boolean(userBubble),
        href: location.pathname + location.search,
        tab: window.state && window.state.tab
      };
    })()`);

    await waitForCondition(cdp, "Chat stream opens a live assistant bubble", `(() => {
      const live = [...document.querySelectorAll(".bubble.assistant.pending, .bubble.assistant.streaming")];
      const captions = live.map((el) => el.textContent?.trim() || "");
      return {
        ok: live.length === 1,
        count: live.length,
        captions,
        classes: live.map((el) => el.className)
      };
    })()`, 10000);

    const reconnected = await evaluate(cdp, `(() => Promise.resolve(window.chatReconnect?.()).then(() => {
      const live = [...document.querySelectorAll(".bubble.assistant.pending, .bubble.assistant.streaming")];
      return {
        ok: live.length <= 1,
        count: live.length,
        classes: live.map((el) => el.className)
      };
    }).catch((error) => ({ ok: false, error: error?.message || String(error) })))()`);
    ok(reconnected?.ok === true, "Chat reconnect runs without duplicate live bubbles", JSON.stringify(reconnected));

    await waitForCondition(cdp, "Chat stream reaches a terminal assistant reply", `(async () => {
      const turnsRes = await fetch("/api/chat/turns");
      const turns = turnsRes.ok ? await turnsRes.json() : [];
      const final = [...document.querySelectorAll(".bubble.assistant:not(.pending):not(.streaming) .bubble-text")]
        .map((el) => el.textContent?.replace(/\\s+/g, " ").trim() || "")
        .find((text) => text.includes("Smoke chat stream complete."));
      const live = [...document.querySelectorAll(".bubble.assistant.pending, .bubble.assistant.streaming")];
      return {
        ok: Boolean(
          final &&
          Array.isArray(turns) &&
          turns.length === 0 &&
          live.length === 0 &&
          location.pathname === "/app/ask" &&
          window.state?.tab === "chat"
        ),
        final: final || "",
        liveCount: live.length,
        turns: Array.isArray(turns) ? turns.map((turn) => ({ id: turn.id, status: turn.status, phase: turn.phase })) : turns,
        href: location.pathname + location.search,
        tab: window.state && window.state.tab
      };
    })()`, 30000);
    ok(failures.length === 0, "/app/ask send/stream/reconnect workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeSettingsDataControls(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/you/settings/data", "settings");
    await assertGlobals(cdp);
    const initial = await evaluate(cdp, `(() => {
      const updateCard = document.querySelector("#updateCard");
      const toggle = document.querySelector("#updateCheckEnabled");
      const checkNow = document.querySelector("#updateCheckNow");
      const json = document.querySelector("#dlJson");
      const db = document.querySelector("#dlDb");
      const rerun = document.querySelector("#rerunSetup");
      const tokenBtn = document.querySelector("#phoneGenToken");
      if (!updateCard || !toggle || !checkNow || !json || !db || !rerun || !tokenBtn) {
        return {
          ok: false,
          hasUpdateCard: Boolean(updateCard),
          hasToggle: Boolean(toggle),
          hasCheckNow: Boolean(checkNow),
          hasJson: Boolean(json),
          hasDb: Boolean(db),
          hasRerun: Boolean(rerun),
          hasTokenBtn: Boolean(tokenBtn)
        };
      }
      return {
        ok: true,
        checked: toggle.checked,
        checkNowDisplay: getComputedStyle(checkNow).display,
        href: location.pathname + location.search
      };
    })()`);
    ok(initial?.ok === true, "Settings Data backup/update/setup controls render", JSON.stringify(initial));

    await evaluate(cdp, `(() => {
      const toggle = document.querySelector("#updateCheckEnabled");
      if (!toggle) throw new Error("missing update-check toggle");
      toggle.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Settings Data update toggle rewires the check-now action", `(() => {
      const toggle = document.querySelector("#updateCheckEnabled");
      const checkNow = document.querySelector("#updateCheckNow");
      if (!toggle || !checkNow) return { ok: false, reason: "missing toggle/check-now" };
      const expectedDisplay = toggle.checked ? "" : "none";
      return {
        ok: checkNow.style.display === expectedDisplay,
        checked: toggle.checked,
        inlineDisplay: checkNow.style.display,
        expectedDisplay
      };
    })()`);

    await evaluate(cdp, `(() => {
      const tokenBtn = document.querySelector("#phoneGenToken");
      if (!tokenBtn) throw new Error("missing phone token button");
      tokenBtn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Settings Data phone token helper generates a local token", `(() => {
      const out = document.querySelector("#phoneTokenOut");
      const text = out ? out.textContent.trim() : "";
      return {
        ok: text.length >= 20,
        length: text.length,
        title: out ? out.title : ""
      };
    })()`);

    const finalState = await evaluate(cdp, `(() => ({
      ok: location.pathname === "/app/you/settings/data" && window.state?.tab === "settings" && window.state?.setSeg === "data",
      href: location.pathname + location.search,
      tab: window.state && window.state.tab,
      setSeg: window.state && window.state.setSeg
    }))()`);
    ok(finalState?.ok === true, "Settings Data controls preserve the routed Data slice", JSON.stringify(finalState));
    ok(failures.length === 0, "/app/you/settings/data workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeProgressSegmentNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/train/energy", "progress");
    await assertGlobals(cdp);
    // Train's nav is one level: a deeper leaf wears only a step back to its landing.
    await evaluate(cdp, `(() => {
      if (document.querySelector(".segbtn[data-proggroup]")) throw new Error("a deeper leaf wears no group bar");
      const back = document.querySelector('.train-crumb[data-train-leaf="intake"]');
      if (!back) throw new Error("missing Energy's step back to Fuel");
      back.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Energy's step back lands on Fuel's landing (Intake)", `(() => {
      const activeGroup = document.querySelector('.segbtn.active[data-proggroup="fuel"]');
      return {
        ok: Boolean(activeGroup && window.state?.progressSeg === "intake" && location.pathname === "/app/train/intake"),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg
      };
    })()`);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-proggroup="program"]');
      if (!btn) throw new Error("missing Train Program group");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Train's Program group opens the Program read", `(() => {
      const active = document.querySelector('.segbtn.active[data-proggroup="program"]');
      const view = document.querySelector("#view");
      return {
        ok: Boolean(
          active &&
          window.state?.tab === "progress" &&
          window.state?.progressSeg === "program" &&
          location.pathname === "/app/train/program" &&
          view &&
          view.textContent.trim().length > 0
        ),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg
      };
    })()`);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-proggroup="fuel"]');
      if (!btn) throw new Error("missing Train Fuel group");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Train's Fuel group opens Intake, with Energy one row deeper", `(() => {
      const activeGroup = document.querySelector('.segbtn.active[data-proggroup="fuel"]');
      const row = document.querySelector('.train-deeper-row[data-train-leaf="energy"]');
      return {
        ok: Boolean(activeGroup && row && window.state?.progressSeg === "intake" && location.pathname === "/app/train/intake"),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg,
        hasRow: Boolean(row)
      };
    })()`);
    await evaluate(cdp, `(() => {
      const row = document.querySelector('.train-deeper-row[data-train-leaf="energy"]');
      if (!row) throw new Error("missing Fuel's Energy row");
      row.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Fuel's Energy row opens Energy", `(() => ({
      ok: Boolean(window.state?.progressSeg === "energy" && location.pathname === "/app/train/energy" && document.querySelector("#energyCard")),
      href: location.pathname,
      progressSeg: window.state && window.state.progressSeg,
      hasEnergyCard: Boolean(document.querySelector("#energyCard"))
    }))()`);
    ok(failures.length === 0, "/app/train segment workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

// The Plan view split across three homes (v2 wave 5): Fuel is Today's, Changes is
// Ask's and the editor is Train's (Program → Plan). None wears the old Plan bar;
// Fuel and Changes step back to their home, and the editor rides Train's nav.
async function smokePlanSegmentNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const lit = `document.querySelector(".tab.active")?.dataset.tab`;
  try {
    await navigateAndHydrate(cdp, base, "/app/today/fuel", "plan");
    await assertGlobals(cdp);
    await waitForCondition(cdp, "Fuel lives under Today: history fold, no Plan bar, a way back", `(() => {
      const fold = document.querySelector("#fuelHistory");
      const planBar = document.querySelector('.segbtn[data-seg="food"], .segbtn[data-seg="coach"]');
      const back = document.querySelector('[data-home-back="today"]');
      return {
        ok: Boolean(fold && !planBar && back && ${lit} === "today" && document.querySelector("#dayFuelSlot")),
        hasFold: Boolean(fold), hasPlanBar: Boolean(planBar), hasBack: Boolean(back), lit: ${lit}
      };
    })()`, 15000);
    await evaluate(cdp, `(() => { document.querySelector('[data-home-back="today"]').click(); return true; })()`);
    await waitForCondition(cdp, "Fuel's back link returns to Today", `(() => ({
      ok: Boolean(window.state?.tab === "today" && location.pathname === "/app/today" && ${lit} === "today"),
      href: location.pathname, tab: window.state && window.state.tab
    }))()`);

    await navigateAndHydrate(cdp, base, "/app/ask/changes", "plan");
    await waitForCondition(cdp, "Changes lives under Ask with a way back", `(() => ({
      ok: Boolean(
        window.state?.planSeg === "coach" &&
        document.querySelector("#proplist") &&
        document.querySelector('[data-home-back="ask"]') &&
        !document.querySelector('.segbtn[data-seg="coach"]') &&
        ${lit} === "ask"
      ),
      href: location.pathname, planSeg: window.state && window.state.planSeg, lit: ${lit}
    }))()`);
    await evaluate(cdp, `(() => { document.querySelector('[data-home-back="ask"]').click(); return true; })()`);
    await waitForCondition(cdp, "Changes' back link returns to Ask", `(() => ({
      ok: Boolean(window.state?.tab === "chat" && location.pathname === "/app/ask" && ${lit} === "ask"),
      href: location.pathname, tab: window.state && window.state.tab
    }))()`);

    await navigateAndHydrate(cdp, base, "/app/train/program", "progress");
    await waitForCondition(cdp, "the Program read lists the plan one row deeper", `(() => ({
      ok: Boolean(document.querySelector('.train-deeper-row[data-train-leaf="plan"]'))
    }))()`);
    await evaluate(cdp, `(() => {
      const row = document.querySelector('.train-deeper-row[data-train-leaf="plan"]');
      if (!row) throw new Error("missing Train Program → The plan row");
      row.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Program → Plan opens the editor under Train", `(() => ({
      ok: Boolean(
        window.state?.tab === "plan" &&
        window.state?.planSeg === "edit" &&
        location.pathname === "/app/train/plan" &&
        document.querySelector("#planedit") &&
        document.querySelector('.train-crumb[data-train-leaf="program"]') &&
        ${lit} === "train"
      ),
      href: location.pathname, planSeg: window.state && window.state.planSeg, lit: ${lit}
    }))()`);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.train-crumb[data-train-leaf="program"]');
      if (!btn) throw new Error("missing the editor's step back to Program");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "the editor's step back returns to the Program read", `(() => ({
      ok: Boolean(window.state?.tab === "progress" && window.state?.progressSeg === "program" && location.pathname === "/app/train/program"),
      href: location.pathname, tab: window.state && window.state.tab
    }))()`);
    ok(failures.length === 0, "/app Fuel/Changes/Plan home workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeHealthInnerNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/you/health", "stand");
    await assertGlobals(cdp);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector("[data-allmarkers]");
      if (!btn) throw new Error("missing Stand all-markers control");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Stand marker control routes to Markers", `(() => {
      const content = document.querySelector("#standRecords");
      return {
        ok: Boolean(
          window.state?.tab === "stand" &&
          window.state?.standSeg === "markers" &&
          location.pathname === "/app/you/markers" &&
          content &&
          content.textContent.trim().length > 0
        ),
        href: location.pathname,
        standSeg: window.state && window.state.standSeg,
        contentLength: content ? content.textContent.trim().length : 0
      };
    })()`);

    await navigateAndHydrate(cdp, base, "/app/you/records", "stand");
    await waitForCondition(cdp, "Stand records route renders upload", `(() => {
      return {
        ok: Boolean(window.state?.standSeg === "records" && location.pathname === "/app/you/records" && document.querySelector("#hUploadBox") && document.querySelector("#hUpload")),
        href: location.pathname,
        standSeg: window.state && window.state.standSeg,
        hasUploadBox: Boolean(document.querySelector("#hUploadBox")),
        hasUploadButton: Boolean(document.querySelector("#hUpload"))
      };
    })()`);
    // The domain drill-in must advance history, so browser/OS Back steps back UP
    // to the Stand overview instead of leaving Stand entirely.
    await navigateAndHydrate(cdp, base, "/app/you/health", "stand");
    await evaluate(cdp, `(() => {
      const btn = document.querySelector("[data-domain]");
      if (!btn) throw new Error("missing Stand domain tile");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Stand domain tile advances to its own route", `(() => ({
      ok: Boolean(
        window.state?.standSeg === "domain" &&
        location.pathname === "/app/you/domain" &&
        new URLSearchParams(location.search).get("id") &&
        document.querySelector("#standRecords")
      ),
      href: location.pathname + location.search,
      standSeg: window.state && window.state.standSeg
    }))()`);
    await evaluate(cdp, `(() => { history.back(); return true; })()`);
    await waitForCondition(cdp, "browser Back from a domain returns to the Health overview", `(() => ({
      ok: Boolean(window.state?.tab === "stand" && window.state?.standSeg == null && location.pathname === "/app/you/health"),
      href: location.pathname + location.search,
      tab: window.state && window.state.tab,
      standSeg: window.state && window.state.standSeg
    }))()`);
    ok(failures.length === 0, "/app/you Health navigation workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeFamilyCrud(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const addedName = `Smoke Guardian ${Date.now()}`;
  const addedNameJson = JSON.stringify(addedName);
  const editedNote = `Edited note ${Date.now()}`;
  const editedNoteJson = JSON.stringify(editedNote);
  try {
    await navigateAndHydrate(cdp, base, "/app/you/family", "me");
    await assertGlobals(cdp);

    await waitForCondition(cdp, "Family renders the seeded roster", `(() => {
      const names = [...document.querySelectorAll("#flist .fam-card .fam-name")].map((el) => el.textContent.trim());
      const seeded = ["Maya", "Leo", "Iris"];
      return { ok: seeded.every((name) => names.includes(name)), names };
    })()`);

    await evaluate(cdp, `(() => {
      const name = document.querySelector("#fName");
      const rel = document.querySelector("#fRel");
      const add = document.querySelector("#fAdd");
      if (!name || !rel || !add) throw new Error("missing Family add-member form controls");
      name.value = ${addedNameJson};
      name.dispatchEvent(new Event("input", { bubbles: true }));
      rel.value = "friend";
      rel.dispatchEvent(new Event("input", { bubbles: true }));
      add.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Family adds a new member through the form", `(() => {
      const name = ${addedNameJson};
      const card = [...document.querySelectorAll("#flist .fam-card")]
        .find((el) => el.querySelector(".fam-name")?.textContent?.trim() === name);
      return { ok: Boolean(card), found: Boolean(card) };
    })()`);

    await evaluate(cdp, `(() => {
      const name = ${addedNameJson};
      const card = [...document.querySelectorAll("#flist .fam-card")]
        .find((el) => el.querySelector(".fam-name")?.textContent?.trim() === name);
      const editBtn = card ? card.querySelector("[data-fedit]") : null;
      if (!card || !editBtn) throw new Error("missing new family member edit control");
      editBtn.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Family edit form opens for the new member", `(() => {
      const name = ${addedNameJson};
      const card = [...document.querySelectorAll("#flist .fam-card")]
        .find((el) => el.querySelector(".fe-name")?.value === name);
      return { ok: Boolean(card && card.querySelector(".fe-notes")) };
    })()`);

    await evaluate(cdp, `(() => {
      const name = ${addedNameJson};
      const card = [...document.querySelectorAll("#flist .fam-card")]
        .find((el) => el.querySelector(".fe-name")?.value === name);
      const notes = card ? card.querySelector(".fe-notes") : null;
      const save = card ? card.querySelector(".fe-save") : null;
      if (!card || !notes || !save) throw new Error("missing family edit notes/save controls");
      notes.value = ${editedNoteJson};
      notes.dispatchEvent(new Event("input", { bubbles: true }));
      save.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Family edit persists the updated note", `(() => {
      const name = ${addedNameJson};
      const note = ${editedNoteJson};
      const card = [...document.querySelectorAll("#flist .fam-card")]
        .find((el) => el.querySelector(".fam-name")?.textContent?.trim() === name);
      const line = card ? card.querySelector(".fam-notes") : null;
      return { ok: Boolean(line && line.textContent.trim() === note), text: line ? line.textContent.trim() : null };
    })()`);

    const afterEdit = await apiJson(base, "/family");
    const editedMember = Array.isArray(afterEdit) ? afterEdit.find((m) => m.name === addedName) : null;
    ok(Boolean(editedMember) && editedMember.notes === editedNote, "API reflects the edited family member's note", JSON.stringify(editedMember));

    await evaluate(cdp, `(() => {
      const name = ${addedNameJson};
      const card = [...document.querySelectorAll("#flist .fam-card")]
        .find((el) => el.querySelector(".fam-name")?.textContent?.trim() === name);
      const del = card ? card.querySelector("[data-fdel]") : null;
      if (!card || !del) throw new Error("missing family delete control");
      del.click();
      del.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Family delete removes the member from the roster", `(() => {
      const name = ${addedNameJson};
      const names = [...document.querySelectorAll("#flist .fam-card .fam-name")].map((el) => el.textContent.trim());
      const seeded = ["Maya", "Leo", "Iris"];
      return { ok: !names.includes(name) && seeded.every((n) => names.includes(n)), names };
    })()`);

    const afterDelete = await apiJson(base, "/family");
    ok(
      Array.isArray(afterDelete) && !afterDelete.some((m) => m.name === addedName),
      "API confirms the family member was deleted",
      JSON.stringify(afterDelete?.map((m) => m.name)),
    );

    ok(failures.length === 0, "/app/you/family workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokePlanEditorSaveAndMealRecipe(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const NEW_WEIGHT = "199";
  const newWeightJson = JSON.stringify(NEW_WEIGHT);
  try {
    await navigateAndHydrate(cdp, base, "/app/train/plan", "plan");
    await assertGlobals(cdp);

    await waitForCondition(cdp, "Plan editor renders Day 1 with an Edit-day control", `(() => {
      const day = document.querySelector('.prog-day[data-pd="0"]');
      const editBtn = day ? day.querySelector("[data-editday]") : null;
      return { ok: Boolean(day && editBtn), name: day ? day.querySelector(".prog-name")?.textContent?.trim() : null };
    })()`);

    await evaluate(cdp, `(() => {
      const day = document.querySelector('.prog-day[data-pd="0"]');
      const editBtn = day ? day.querySelector("[data-editday]") : null;
      if (!editBtn) throw new Error("missing Plan editor Edit-day button");
      editBtn.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Plan editor Day 1 opens with an editable target-weight field", `(() => {
      const day = document.querySelector('.pday[data-d="0"]');
      const item = day ? day.querySelector('.pitem[data-i="0"]') : null;
      const input = item ? item.querySelector(".pi-tw") : null;
      return { ok: Boolean(input), value: input ? input.value : null };
    })()`);

    await evaluate(cdp, `(() => {
      const day = document.querySelector('.pday[data-d="0"]');
      const item = day ? day.querySelector('.pitem[data-i="0"]') : null;
      const input = item ? item.querySelector(".pi-tw") : null;
      if (!input) throw new Error("missing target-weight input");
      input.value = ${newWeightJson};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);

    await waitForCondition(cdp, "Plan editor shows unsaved changes after editing a target weight", `(() => ({
      ok: Boolean(document.querySelector(".savebar.show"))
    }))()`);

    await evaluate(cdp, `(() => {
      const save = document.querySelector(".savebar-save");
      if (!save) throw new Error("missing plan editor save button");
      save.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Plan editor save persists the edited target weight", `(() => {
      const day = document.querySelector('.prog-day[data-pd="0"]');
      const row = day ? day.querySelector(".prog-row") : null;
      const wt = row ? row.querySelector(".prog-row-wt") : null;
      const text = wt ? wt.textContent.trim() : null;
      return { ok: Boolean(text && text.includes(${newWeightJson})), text };
    })()`, 15000);

    const savedPlan = await apiJson(base, "/plan");
    const day1 = Array.isArray(savedPlan) ? savedPlan.find((d) => Number(d.day_number) === 1) : null;
    const squat = day1?.items?.find((it) => it.exercise === "Back Squat");
    ok(Number(squat?.target_weight) === Number(NEW_WEIGHT), "API plan reflects the saved target weight", JSON.stringify(squat));

    await navigateAndHydrate(cdp, base, "/app/plan/meals", "plan");
    await assertGlobals(cdp);

    await waitForCondition(cdp, "Meals renders Monday's Dinner row with a cached recipe", `(() => {
      const row = document.querySelector('.meal-row[data-di="0"][data-mi="3"]');
      const name = row ? row.querySelector(".meal-name")?.textContent?.trim() : null;
      return { ok: Boolean(row && name === "Dinner"), name };
    })()`);

    await evaluate(cdp, `(() => {
      const row = document.querySelector('.meal-row[data-di="0"][data-mi="3"]');
      if (!row) throw new Error("missing Monday dinner meal row");
      row.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Meals opens the cached recipe sheet for Monday dinner", `(() => {
      const sheet = document.querySelector(".sheet");
      const recipe = sheet ? sheet.querySelector("[data-recipe]") : null;
      const steps = recipe ? recipe.querySelectorAll(".recipe-steps li").length : 0;
      const hasCta = Boolean(recipe && recipe.querySelector("[data-getrecipe]"));
      return {
        ok: Boolean(sheet && document.body.classList.contains("sheet-open") && steps > 0 && !hasCta),
        steps,
        hasCta
      };
    })()`);

    await evaluate(cdp, `(() => {
      const close = document.querySelector(".sheet .sheet-x");
      if (!close) throw new Error("missing recipe sheet close button");
      close.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Meals recipe sheet closes", `(() => ({
      ok: !document.querySelector(".sheet") && !document.body.classList.contains("sheet-open")
    }))()`);

    ok(failures.length === 0, "/app/plan editor-save + meal-recipe workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeHealthRecordActions(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/you/records", "stand");
    await assertGlobals(cdp);

    await waitForCondition(cdp, "Health Records renders the seeded bloodwork/DEXA documents", `(() => {
      const rows = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")];
      return { ok: rows.length >= 5, count: rows.length };
    })()`);

    const collapsed = await evaluate(cdp, `(() => {
      const row = document.querySelector("#hlist .hdoc.hdoc-collapsed[data-hdoc]");
      return { id: row ? row.dataset.hdoc : null };
    })()`);
    ok(Boolean(collapsed?.id), "Health Records has at least one initially-collapsed record", JSON.stringify(collapsed));
    const collapsedIdJson = JSON.stringify(collapsed.id);

    await evaluate(cdp, `(() => {
      const id = ${collapsedIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const toggle = row ? row.querySelector("[data-hdoc-toggle]") : null;
      if (!row || !toggle) throw new Error("missing collapsed-record toggle control");
      toggle.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Health Records expands a collapsed record's detail", `(() => {
      const id = ${collapsedIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      return { ok: Boolean(row && !row.classList.contains("hdoc-collapsed")) };
    })()`);

    await evaluate(cdp, `(() => {
      const id = ${collapsedIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const toggle = row ? row.querySelector("[data-hdoc-toggle]") : null;
      if (!row || !toggle) throw new Error("missing record toggle control (re-collapse)");
      toggle.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Health Records re-collapses the record", `(() => {
      const id = ${collapsedIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      return { ok: Boolean(row && row.classList.contains("hdoc-collapsed")) };
    })()`);

    const first = await evaluate(cdp, `(() => {
      const row = document.querySelector("#hlist .hdoc[data-hdoc]");
      const dateInput = row ? row.querySelector("[data-hdate]") : null;
      return {
        ok: Boolean(row && !row.classList.contains("hdoc-collapsed") && dateInput),
        id: row ? row.dataset.hdoc : null,
        date: dateInput ? dateInput.value : null
      };
    })()`);
    ok(first?.ok === true, "Health Records' first record is expanded with a result-date field", JSON.stringify(first));
    const firstIdJson = JSON.stringify(first.id);

    const newDate = await evaluate(cdp, `(() => {
      const current = ${JSON.stringify(first.date)};
      const d = new Date((current || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })()`);
    const newDateJson = JSON.stringify(newDate);

    await evaluate(cdp, `(() => {
      const id = ${firstIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const editBtn = row ? row.querySelector("[data-hdate-edit]") : null;
      if (!row || !editBtn) throw new Error("missing result-date edit button");
      editBtn.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Health Records opens the result-date editor", `(() => {
      const id = ${firstIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const editor = row ? row.querySelector("[data-hdate-editor]") : null;
      return { ok: Boolean(editor && editor.hidden === false) };
    })()`);

    await evaluate(cdp, `(() => {
      const id = ${firstIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const input = row ? row.querySelector("[data-hdate]") : null;
      const save = row ? row.querySelector("[data-hdate-save]") : null;
      if (!input || !save) throw new Error("missing result-date input/save controls");
      input.value = ${newDateJson};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      save.click();
      return true;
    })()`);

    // The control's LABEL reads human (DESIGN.md: no bare YYYY-MM-DD in copy); the
    // date input behind it still carries the exact ISO the picker needs.
    await waitForCondition(cdp, "Health Records saves the edited result date", `(() => {
      const id = ${firstIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const val = row ? row.querySelector(".hdoc-date-val") : null;
      const input = row ? row.querySelector("[data-hdate]") : null;
      const text = val ? val.textContent.trim() : null;
      const human = window.absDate ? window.absDate(${newDateJson}) : null;
      return { ok: Boolean(text && text === human && input && input.value === ${newDateJson}), text, human };
    })()`);

    const savedDoc = await apiJson(base, `/health-docs/${first.id}`);
    ok(savedDoc?.doc_date === newDate, "API reflects the edited result date", JSON.stringify(savedDoc?.doc_date));

    ok(failures.length === 0, "/app/you/records workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeSettingsAgentsSourcesAutomation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/you/settings/agents", "settings");
    await assertGlobals(cdp);

    const initialSettings = await apiJson(base, "/settings");
    const initialCoachDay = Number(initialSettings?.settings?.coach_day);
    const initialCoachHour = Number(initialSettings?.settings?.coach_hour);
    ok(Number.isInteger(initialCoachDay), "Settings API exposes the weekly review day", JSON.stringify(initialSettings?.settings?.coach_day));
    ok(Number.isInteger(initialCoachHour), "Settings API exposes the weekly review hour", JSON.stringify(initialSettings?.settings?.coach_hour));
    const nextCoachDay = (initialCoachDay + 1) % 7;

    const agentCard = await evaluate(cdp, `(() => {
      const cards = [...document.querySelectorAll("#agentlist .agent-card")];
      const card = cards.find((el) => el.querySelector(".agentname")?.textContent?.trim() === "chat_smoke");
      const chip = card ? card.querySelector(".agent-chip") : null;
      return {
        ok: Boolean(card && chip && !chip.className.includes("agent-chip-absent")),
        count: cards.length,
        chipClass: chip ? chip.className : null,
        chipLabel: chip ? chip.textContent.trim() : null
      };
    })()`);
    ok(agentCard?.ok === true, "Settings Agents renders the smoke agent card as installed/usable", JSON.stringify(agentCard));

    await evaluate(cdp, `(() => {
      const cards = [...document.querySelectorAll("#agentlist .agent-card")];
      const card = cards.find((el) => el.querySelector(".agentname")?.textContent?.trim() === "chat_smoke");
      const detail = card ? card.querySelector("[data-detail]") : null;
      if (!card || !detail) throw new Error("missing agent detail/check control");
      detail.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Settings Agents detail check reports CLI info for the smoke agent", `(() => {
      const cards = [...document.querySelectorAll("#agentlist .agent-card")];
      const card = cards.find((el) => el.querySelector(".agentname")?.textContent?.trim() === "chat_smoke");
      const detail = card ? card.querySelector("[data-detail]") : null;
      const infoLine = card ? card.querySelector(".agent-info-line") : null;
      return {
        ok: Boolean(detail && detail.textContent.trim() === "details" && infoLine),
        detailText: detail ? detail.textContent.trim() : null,
        infoLine: infoLine ? infoLine.textContent.trim() : null
      };
    })()`);

    await evaluate(cdp, `(() => {
      const day = document.querySelector("#coachDay");
      const hour = document.querySelector("#coachHour");
      const heading = [...document.querySelectorAll("h1")].find((el) => /weekly\\s+review\\s+cadence/i.test(el.textContent || ""));
      if (!heading || !day || !hour) throw new Error("missing weekly review cadence controls");
      if (Number(day.value) !== ${initialCoachDay}) throw new Error("weekly review day does not match the API setting");
      if (Number(hour.value) !== ${initialCoachHour}) throw new Error("weekly review hour does not match the API setting");
      day.value = String(${nextCoachDay});
      day.dispatchEvent(new Event("change", { bubbles: true }));
      return { heading: heading.textContent.trim(), day: Number(day.value), hour: Number(hour.value) };
    })()`);

    await waitForCondition(cdp, "Settings Agents weekly review day shows unsaved changes", `(() => ({
      ok: Boolean(document.querySelector(".savebar.show")) && Number(document.querySelector("#coachDay")?.value) === ${nextCoachDay},
      day: Number(document.querySelector("#coachDay")?.value)
    }))()`);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-seg="sources"]');
      if (!btn) throw new Error("missing Settings Sources segment");
      btn.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Settings Sources renders the Garmin connector controls", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="sources"]');
      const status = document.querySelector("#garminStatus");
      return {
        ok: Boolean(
          active &&
          window.state?.setSeg === "sources" &&
          location.pathname === "/app/you/settings/sources" &&
          document.querySelector("#garminUsername") &&
          status && status.textContent.includes("Never synced")
        ),
        href: location.pathname,
        setSeg: window.state && window.state.setSeg,
        statusText: status ? status.textContent.trim() : null
      };
    })()`);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector("#garminSyncBtn");
      if (!btn) throw new Error("missing Garmin sync button");
      btn.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Settings Sources Garmin sync reports a real credential-less failure", `(() => {
      const status = document.querySelector("#garminStatus");
      const btn = document.querySelector("#garminSyncBtn");
      const text = status ? status.textContent.trim() : "";
      return {
        ok: Boolean(btn && !btn.disabled && btn.textContent.trim() === "Sync now" && /sync failed/i.test(text)),
        text,
        btnText: btn ? btn.textContent.trim() : null
      };
    })()`, 15000);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-seg="automation"]');
      if (!btn) throw new Error("missing Settings Automation segment");
      btn.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Settings Automation renders the background-touch toggles", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="automation"]');
      return {
        ok: Boolean(
          active &&
          window.state?.setSeg === "automation" &&
          location.pathname === "/app/you/settings/automation" &&
          document.querySelector("#enrichEnabled") &&
          document.querySelector("#artEnabled") &&
          document.querySelector("#researchEnabled")
        ),
        href: location.pathname,
        setSeg: window.state && window.state.setSeg
      };
    })()`);

    await evaluate(cdp, `(() => {
      const save = document.querySelector(".savebar-save");
      if (!save) throw new Error("missing Settings save button");
      save.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Settings save completes for the weekly review cadence change", `(() => ({
      ok: !document.querySelector(".savebar.busy")
    }))()`, 10000);

    const savedSettings = await apiJson(base, "/settings");
    ok(savedSettings?.settings?.coach_day === nextCoachDay, "API reflects the saved weekly review day", JSON.stringify(savedSettings?.settings?.coach_day));
    ok(savedSettings?.settings?.coach_hour === initialCoachHour, "saving the weekly review day preserves its hour", JSON.stringify(savedSettings?.settings?.coach_hour));
    ok(
      /^failed:/.test(String(savedSettings?.settings?.garmin_last_sync_status || "")),
      "API reflects the real credential-less Garmin sync failure",
      String(savedSettings?.settings?.garmin_last_sync_status),
    );

    ok(failures.length === 0, "/app/you/settings agents/sources/automation workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

if (!existsSync(serverEntry)) {
  console.error(`x ${serverEntry} is missing - run \`npm run build\` first (presmoke:browser does this).`);
  process.exit(1);
}

if (typeof WebSocket !== "function") {
  console.error("x Browser smoke needs Node's built-in WebSocket support (Node 24 baseline).");
  process.exit(1);
}

let exitCode = 1;
let chrome = null;
let cdp = null;
let smokeAgents = null;
try {
  smokeAgents = createSmokeAgentsConfig();
  chrome = await launchChrome();
  console.log(`Cairn browser smoke: using ${chrome.bin}`);
  cdp = await newPage(chrome);
  await withServer({ label: SMOKE_NAME, authToken: "", portOffset: 2, extraEnv: { AGENTS_CONFIG: smokeAgents.file, CAIRN_SEED_DEMO: "1" } }, async (ctx) => {
    for (const route of routes) await smokeRoute(cdp, ctx.base, route);
    await smokeColdTabNavigation(cdp, ctx.base);
    await smokeTodayAddExercise(cdp, ctx.base);
    await smokeChatAttachmentFocus(cdp, ctx.base);
    await smokeChatSendStreamReconnect(cdp, ctx.base);
    await smokeSettingsDataControls(cdp, ctx.base);
    await smokeProgressSegmentNavigation(cdp, ctx.base);
    await smokePlanSegmentNavigation(cdp, ctx.base);
    await smokeHealthInnerNavigation(cdp, ctx.base);
    await smokeFamilyCrud(cdp, ctx.base);
    await smokePlanEditorSaveAndMealRecipe(cdp, ctx.base);
    await smokeHealthRecordActions(cdp, ctx.base);
    await smokeSettingsAgentsSourcesAutomation(cdp, ctx.base);
  });
  console.log(`\nBrowser smoke OK - ${routes.length} route(s) and ${WORKFLOW_COUNT} workflow(s) loaded without runtime errors.`);
  exitCode = 0;
} catch (error) {
  console.error(`\nx Browser smoke FAILED: ${error.message}`);
  if (error.serverLog?.trim()) {
    console.error("--- server output (tail) ---");
    console.error(tail(error.serverLog));
  }
  if (chrome?.log?.().trim()) {
    console.error("--- chrome output (tail) ---");
    console.error(tail(chrome.log()));
  }
  exitCode = 1;
} finally {
  if (smokeAgents?.dir) {
    try { rmSync(smokeAgents.dir, { recursive: true, force: true }); } catch {}
  }
  if (cdp) cdp.close();
  await stopChrome(chrome);
}

process.exit(exitCode);
