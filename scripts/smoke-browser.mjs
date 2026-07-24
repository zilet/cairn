// Dependency-free browser smoke for the generated PWA app shell.
//
// This intentionally stays outside `npm run verify`: it needs a local Chrome
// binary and loopback CDP, so it is a release/manual gate rather than a fast
// deterministic unit gate. It catches the runtime class that static checks
// cannot: syntax errors, broken script order, missing globals, and route boot
// failures in a real browser.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { root, serverEntry, sleep, withServer } from "./smoke-server.mjs";

const SMOKE_NAME = "browser";
const DEBUG_PORT_MIN = 25000;
const DEBUG_PORT_SPAN = 5000;
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 600;
const WORKFLOW_COUNT = 13;

const routes = [
  { path: "/", tab: "today" },
  { path: "/app/today", tab: "today" },
  { path: "/app/plan/food", tab: "plan", expectedState: { planSeg: "food" } },
  { path: "/app/plan/meals", tab: "plan", expectedState: { planSeg: "meals" } },
  { path: "/app/plan/coach", tab: "plan", expectedState: { planSeg: "coach" } },
  { path: "/app/progress/energy", tab: "progress", expectedState: { progressSeg: "energy" } },
  { path: "/app/stand", tab: "stand", expectedState: { standSeg: null } },
  { path: "/app/stand/age", tab: "stand", expectedState: { standSeg: "age" } },
  { path: "/app/stand/records", tab: "stand", expectedState: { standSeg: "records" } },
  { path: "/app/stand/markers", tab: "stand", expectedState: { standSeg: "markers" } },
  { path: "/app/me/standing", tab: "stand", expectedHref: "/app/stand/age", expectedState: { standSeg: "age" } },
  { path: "/app/me/health/read", tab: "stand", expectedHref: "/app/stand", expectedState: { standSeg: null } },
  { path: "/app/me/health/records", tab: "stand", expectedHref: "/app/stand/records", expectedState: { standSeg: "records" } },
  { path: "/app/me/memory", tab: "me", expectedState: { meSeg: "memory" } },
  { path: "/app/me/family", tab: "me", expectedState: { meSeg: "family" } },
  { path: "/app/chat", tab: "chat" },
  { path: "/app/settings/data", tab: "settings", expectedState: { setSeg: "data" } },
  { path: "/app/settings/agents", tab: "settings", expectedState: { setSeg: "agents" } },
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
  CairnChatClient: "object",
  CairnChatAttachment: "object",
  CairnMealRecipeController: "object",
  CairnDayFuelController: "object",
  CairnMeMemoryController: "object",
  CairnSettingsAgents: "object",
};

const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean);

function ok(cond, label, detail) {
  if (!cond) throw new Error(`assertion failed: ${label}${detail ? ` - ${detail}` : ""}`);
  console.log(`  OK ${label}`);
}

function chromeBinary() {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Chrome not found. Set CHROME_BIN to a Chrome/Chromium binary. Checked: ${chromeCandidates.join(", ")}`);
}

function debugPort() {
  const explicit = process.env.SMOKE_CHROME_PORT ? Number(process.env.SMOKE_CHROME_PORT) : 0;
  if (explicit) return explicit;
  return DEBUG_PORT_MIN + Math.floor(Math.random() * DEBUG_PORT_SPAN);
}

async function freeDebugPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (error) => {
      // Some locked-down sandboxes reject a throwaway listen() probe even though
      // Chrome itself can still bind a remote-debugging port. In that case keep
      // the historical randomized-port fallback instead of failing before Chrome.
      if (error?.code === "EPERM" || error?.code === "EACCES") resolve(debugPort());
      else reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("could not allocate a Chrome debug port"));
      });
    });
  });
}

function tail(log) {
  return String(log || "").split("\n").slice(-20).join("\n");
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

async function waitForJson(port, child, logRef, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`Chrome exited before CDP was ready\n${tail(logRef())}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (error) {
      lastError = error?.cause?.code || error?.cause?.message || error?.message || String(error);
    }
    await sleep(100);
  }
  throw new Error(`Chrome CDP did not become ready on ${port}${lastError ? ` (${lastError})` : ""}\n${tail(logRef())}`);
}

async function launchChrome() {
  const bin = chromeBinary();
  let lastError = null;
  const explicitPort = process.env.SMOKE_CHROME_PORT ? debugPort() : 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = explicitPort ? explicitPort + attempt : await freeDebugPort();
    const profileDir = mkdtempSync(path.join(tmpdir(), "cairn-browser-smoke-"));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      "--disable-dev-shm-usage",
      "--window-size=390,844",
      "about:blank",
    ];
    if (process.env.CAIRN_CHROME_NO_SANDBOX === "1") args.unshift("--no-sandbox");
    const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => { log += d.toString(); });
    child.stderr.on("data", (d) => { log += d.toString(); });
    try {
      await waitForJson(port, child, () => log);
      return { bin, child, port, profileDir, log: () => log };
    } catch (error) {
      lastError = error;
      try { child.kill("SIGKILL"); } catch {}
      try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
      if (process.env.SMOKE_CHROME_PORT) break;
    }
  }
  throw lastError || new Error("Chrome launch failed");
}

async function stopChrome(ctx) {
  try {
    if (ctx?.child && ctx.child.exitCode == null && ctx.child.signalCode == null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        ctx.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        ctx.child.kill("SIGKILL");
      });
    }
  } finally {
    if (ctx?.profileDir) {
      try { rmSync(ctx.profileDir, { recursive: true, force: true }); } catch {}
    }
  }
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP socket did not open within 10s")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        const message = event && typeof event === "object" && "message" in event ? String(event.message) : "CDP socket error";
        reject(new Error(message));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("CDP socket closed"));
      }
      this.waiters = [];
    });
  }

  onMessage(data) {
    const msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    if (msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method} failed: ${msg.error.message || JSON.stringify(msg.error)}`));
      else pending.resolve(msg.result || {});
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.method === msg.method && waiter.predicate(msg.params || {})) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(msg.params || {});
      }
    }
    for (const listener of this.listeners || []) listener(msg);
  }

  async command(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(payload);
    });
  }

  on(listener) {
    this.listeners ||= [];
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  waitFor(method, predicate = () => true, timeoutMs = NAV_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error(`timed out waiting for ${method}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
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

function planItemForSave(item) {
  if (item?.kind === "cardio") {
    const label = String(item.note || item.exercise || "").trim();
    return {
      kind: "cardio",
      exercise: label,
      note: label || null,
      sets: item.sets ?? 1,
      target_distance_km: item.target_distance_km ?? null,
      target_duration_min: item.target_duration_min ?? null,
      target_zone: item.target_zone ?? null,
      interval: item.interval ?? null,
    };
  }
  return {
    kind: "strength",
    exercise: item.exercise,
    sets: item.sets,
    rep_low: item.rep_low,
    rep_high: item.rep_high,
    target_weight: item.target_weight,
    note: item.note,
    warmup_sets: item.warmup_sets,
    target_seconds: item.target_seconds,
    mode: item.mode,
  };
}

async function addSmokeCardioToPlanDay(base, dayNumber, label) {
  const plan = await apiJson(base, "/plan");
  const day = Array.isArray(plan) ? plan.find((row) => Number(row.day_number) === Number(dayNumber)) : null;
  ok(day, `smoke plan day ${dayNumber} exists`);
  const withoutPriorSmoke = (Array.isArray(day.items) ? day.items : [])
    .filter((item) => {
      const itemLabel = String(item.note || item.exercise || "");
      return itemLabel !== label && !/^Smoke (easy|synced) run \d+$/.test(itemLabel);
    })
    .map(planItemForSave);
  const items = [
    ...withoutPriorSmoke,
    {
      kind: "cardio",
      exercise: label,
      note: label,
      sets: 1,
      target_distance_km: 4.8,
      target_duration_min: 32,
      target_zone: "Z2",
    },
  ];
  const saved = await apiJson(base, `/plan/${encodeURIComponent(dayNumber)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: day.name || `Day ${dayNumber}`,
      focus: day.focus ?? null,
      items,
    }),
  });
  const savedLabels = (Array.isArray(saved?.items) ? saved.items : [])
    .map((item) => String(item.note || item.exercise || ""));
  ok(savedLabels.includes(label), `API saved smoke cardio on plan day ${dayNumber}`, JSON.stringify(savedLabels));
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
        viewTextLength: view ? view.textContent.trim().length : 0,
        scripts: document.scripts.length
      };
    })()`);
    const expectedHref = route.expectedHref || route.path;
    ok(state.href === expectedHref, `${route.path} lands on ${expectedHref} after hydration`, JSON.stringify(state));
    ok(state.tab === route.tab, `${route.path} active tab is ${route.tab}`, JSON.stringify(state));
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

async function smokeTodayAddExercise(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const exercise = `Smoke off-plan ${Date.now()}`;
  const exerciseJson = JSON.stringify(exercise);
  try {
    await navigateAndHydrate(cdp, base, "/app/today", "today");
    await assertGlobals(cdp);

    // Set-by-set logging (add-exercise, log rows) now lives in the isolated
    // Session destination, opened from Today via the #sessLaunch card rather than
    // inline on the Brief. Enter it before exercising the add-exercise workflow.
    const launched = await evaluate(cdp, `(() => {
      const launch = document.querySelector("#sessLaunch");
      if (!launch) return { ok: false, reason: "missing #sessLaunch" };
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

async function smokeTodayCardioSkip(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const label = `Smoke easy run ${Date.now()}`;
  const labelJson = JSON.stringify(label);
  const smokeDate = "2000-01-03";
  try {
    await navigateAndHydrate(cdp, base, "/app/today", "today");
    await assertGlobals(cdp);
    const dayState = await evaluate(cdp, `(() => ({
      day: window.state && window.state.day,
      logDate: window.state && window.state.logDate,
      href: location.pathname + location.search
    }))()`);
    ok(Number.isFinite(Number(dayState?.day)), "Today has a selected plan day for the cardio smoke", JSON.stringify(dayState));
    await addSmokeCardioToPlanDay(base, Number(dayState.day), label);

    await evaluate(cdp, `(() => {
      if (typeof swrInvalidate === "function") swrInvalidate("plan");
      if (window.state) {
        window.state.plan = [];
        window.state.day = Number(${JSON.stringify(dayState.day)});
        window.state.dayPicked = true;
      }
      // Prepare a fresh, explicit snapshot after mutating the weekly plan. A
      // previously accepted daily composition is immutable and must not absorb
      // this smoke-only cardio item implicitly.
      if (typeof openSession !== "function") throw new Error("missing openSession");
      openSession(${JSON.stringify(smokeDate)}, {
        source: "manual_plan",
        dayNumber: Number(${JSON.stringify(dayState.day)}),
        replace: true,
        provenance: { entry: "browser_smoke_cardio_skip" }
      });
      return true;
    })()`);
    await waitForCondition(cdp, "Session destination renders a planned cardio card", `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const skip = card?.querySelector(".ex-skip[data-skip]");
      const log = card?.querySelector("[data-cardio-log]");
      return {
        ok: Boolean(card && skip && log && location.pathname === "/app/session"),
        label,
        found: Boolean(card),
        hasSkip: Boolean(skip),
        hasLog: Boolean(log),
        stateDay: window.state && window.state.day,
        planLabels: ((window.state && Array.isArray(window.state.plan)) ? window.state.plan : [])
          .find((day) => Number(day.day_number) === Number(window.state && window.state.day))
          ?.items?.map((item) => item.note || item.exercise || item.kind) || [],
        renderedCardioLabels: [...document.querySelectorAll(".ex-cardio .cardio-name-txt")]
          .map((el) => el.textContent?.trim()),
        hasPlanSurface: Boolean(document.querySelector(".plansurface")),
        href: location.pathname + location.search,
        tab: window.state && window.state.tab
      };
    })()`);

    await evaluate(cdp, `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const skip = card?.querySelector(".ex-skip[data-skip]");
      if (!card || !skip) throw new Error("missing planned cardio skip button");
      skip.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Today skips a planned cardio card into the skipped line", `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const unskip = [...document.querySelectorAll("#skipLine [data-unskip]")]
        .find((button) => decodeURIComponent(button.dataset.unskip || "") === label);
      return {
        ok: Boolean(!card && unskip && !document.querySelector("#skipLine")?.classList.contains("skipline-empty")),
        cardPresent: Boolean(card),
        hasUnskip: Boolean(unskip),
        skipLineEmpty: Boolean(document.querySelector("#skipLine")?.classList.contains("skipline-empty")),
        href: location.pathname + location.search
      };
    })()`);

    await evaluate(cdp, `(() => {
      const label = ${labelJson};
      const unskip = [...document.querySelectorAll("#skipLine [data-unskip]")]
        .find((button) => decodeURIComponent(button.dataset.unskip || "") === label);
      if (!unskip) throw new Error("missing planned cardio restore button");
      unskip.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Session destination restores a skipped planned cardio card", `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const unskip = [...document.querySelectorAll("#skipLine [data-unskip]")]
        .find((button) => decodeURIComponent(button.dataset.unskip || "") === label);
      return {
        ok: Boolean(card && !unskip && location.pathname === "/app/session" && window.state?.tab === "session"),
        cardPresent: Boolean(card),
        hasUnskip: Boolean(unskip),
        href: location.pathname + location.search,
        tab: window.state && window.state.tab
      };
    })()`);
    ok(failures.length === 0, "Session destination planned-cardio skip workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeTodaySyncedCardioOverridesSkip(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const label = `Smoke synced run ${Date.now()}`;
  const labelJson = JSON.stringify(label);
  const smokeDate = "2000-01-04";
  try {
    await navigateAndHydrate(cdp, base, "/app/today", "today");
    await assertGlobals(cdp);
    const dayState = await evaluate(cdp, `(() => ({
      day: window.state && window.state.day,
      logDate: window.state && window.state.logDate,
      href: location.pathname + location.search
    }))()`);
    ok(Number.isFinite(Number(dayState?.day)) && dayState?.logDate, "Today has a selected plan day for the synced-cardio smoke", JSON.stringify(dayState));
    await addSmokeCardioToPlanDay(base, Number(dayState.day), label);

    await evaluate(cdp, `(() => {
      if (typeof swrInvalidate === "function") swrInvalidate("plan");
      if (window.state) window.state.plan = [];
      // Prepare a fresh snapshot after the plan mutation; the prior smoke's
      // accepted composition remains immutable on its own date.
      if (typeof openSession !== "function") throw new Error("missing openSession");
      openSession(${JSON.stringify(smokeDate)}, {
        source: "manual_plan",
        dayNumber: Number(${JSON.stringify(dayState.day)}),
        replace: true,
        provenance: { entry: "browser_smoke_synced_cardio" }
      });
      return true;
    })()`);

    await waitForCondition(cdp, "Session destination renders a planned synced-cardio candidate", `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      return {
        ok: Boolean(card && card.querySelector(".ex-skip[data-skip]")),
        found: Boolean(card),
        href: location.pathname + location.search
      };
    })()`);

    await evaluate(cdp, `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const skip = card?.querySelector(".ex-skip[data-skip]");
      if (!card || !skip) throw new Error("missing planned synced-cardio skip button");
      skip.click();
      return true;
    })()`);

    await waitForCondition(cdp, "Today initially skips the synced-cardio candidate", `(() => {
      const label = ${labelJson};
      const unskip = [...document.querySelectorAll("#skipLine [data-unskip]")]
        .find((button) => decodeURIComponent(button.dataset.unskip || "") === label);
      return { ok: Boolean(unskip), hasUnskip: Boolean(unskip) };
    })()`);

    await apiJson(base, "/activities", {
      method: "POST",
      body: JSON.stringify({
        date: smokeDate,
        type: "run",
        text: label,
        duration_min: 31,
        distance_km: 5.1,
        source: "garmin",
        external_id: `browser-smoke-${Date.now()}`,
        enrichment_status: "done",
      }),
    });

    await evaluate(cdp, `(() => {
      if (typeof swrInvalidate === "function") {
        swrInvalidate("today:session:" + window.state.logDate);
        swrInvalidate("plan");
      }
      if (window.state) {
        window.state.day = Number(${JSON.stringify(dayState.day)});
        window.state.dayPicked = true;
      }
      // Already inside the Session destination — re-render it, not the Brief.
      if (typeof renderSession !== "function") throw new Error("missing renderSession");
      return Promise.resolve(renderSession({ soft: true }));
    })()`);

    await waitForCondition(cdp, "Synced cardio overrides the skipped planned card", `(async () => {
      const label = ${labelJson};
      const date = ${JSON.stringify(smokeDate)};
      let apiCardio = null;
      try { apiCardio = await fetch("/api/cardio?date=" + encodeURIComponent(date)).then((r) => r.json()); } catch (error) { apiCardio = { error: String(error) }; }
      const done = [...document.querySelectorAll(".ex-cardio-done")]
        .find((el) => el.textContent.includes(label));
      const unskip = [...document.querySelectorAll("#skipLine [data-unskip]")]
        .find((button) => decodeURIComponent(button.dataset.unskip || "") === label);
      const activePlanDay = ((window.state && Array.isArray(window.state.plan)) ? window.state.plan : [])
        .find((day) => Number(day.day_number) === Number(window.state && window.state.day));
      return {
        ok: Boolean(done && done.querySelector(".garmin-tag") && !unskip && location.pathname === "/app/session"),
        done: Boolean(done),
        hasGarminTag: Boolean(done?.querySelector(".garmin-tag")),
        hasUnskip: Boolean(unskip),
        href: location.pathname + location.search,
        stateDay: window.state && window.state.day,
        stateDayPicked: window.state && window.state.dayPicked,
        activePlanLabels: (activePlanDay?.items || []).map((item) => item.note || item.exercise || item.kind),
        apiCardio,
        doneTexts: [...document.querySelectorAll(".ex-cardio-done")].map((el) => el.textContent.trim()),
        skipTexts: [...document.querySelectorAll("#skipLine [data-unskip]")].map((button) => decodeURIComponent(button.dataset.unskip || ""))
      };
    })()`);
    ok(failures.length === 0, "Session destination synced-cardio override workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeChatAttachmentFocus(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/chat", "chat");
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
    ok(failures.length === 0, "/app/chat attachment workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeChatSendStreamReconnect(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const message = `Smoke stream check ${Date.now()}`;
  const messageJson = JSON.stringify(message);
  try {
    await navigateAndHydrate(cdp, base, "/app/chat", "chat");
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
        ok: Boolean(userBubble && location.pathname === "/app/chat" && window.state?.tab === "chat"),
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
          location.pathname === "/app/chat" &&
          window.state?.tab === "chat"
        ),
        final: final || "",
        liveCount: live.length,
        turns: Array.isArray(turns) ? turns.map((turn) => ({ id: turn.id, status: turn.status, phase: turn.phase })) : turns,
        href: location.pathname + location.search,
        tab: window.state && window.state.tab
      };
    })()`, 30000);
    ok(failures.length === 0, "/app/chat send/stream/reconnect workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeSettingsDataControls(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/settings/data", "settings");
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
      ok: location.pathname === "/app/settings/data" && window.state?.tab === "settings" && window.state?.setSeg === "data",
      href: location.pathname + location.search,
      tab: window.state && window.state.tab,
      setSeg: window.state && window.state.setSeg
    }))()`);
    ok(finalState?.ok === true, "Settings Data controls preserve the routed Data slice", JSON.stringify(finalState));
    ok(failures.length === 0, "/app/settings/data workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeProgressSegmentNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/progress/energy", "progress");
    await assertGlobals(cdp);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-proggroup="performance"], .segbtn[data-seg="program"]');
      if (!btn) throw new Error("missing Progress Program segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Progress segment click routes to Program", `(() => {
      const active = document.querySelector('.segbtn.active[data-proggroup="performance"], .segbtn.active[data-seg="program"]');
      const view = document.querySelector("#view");
      return {
        ok: Boolean(
          active &&
          window.state?.tab === "progress" &&
          window.state?.progressSeg === "program" &&
          location.pathname === "/app/progress/program" &&
          view &&
          view.textContent.trim().length > 0
        ),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg,
        active: active ? active.textContent.trim() : ""
      };
    })()`);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-proggroup="fuel"]');
      if (!btn) throw new Error("missing Progress Fuel segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Progress Fuel click opens Intake", `(() => {
      const activeGroup = document.querySelector('.segbtn.active[data-proggroup="fuel"]');
      const activeLeaf = document.querySelector('.segbtn.active[data-seg="intake"]');
      return {
        ok: Boolean(activeGroup && activeLeaf && window.state?.progressSeg === "intake" && location.pathname === "/app/progress/intake"),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg,
        activeGroup: activeGroup ? activeGroup.textContent.trim() : "",
        activeLeaf: activeLeaf ? activeLeaf.textContent.trim() : ""
      };
    })()`);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-seg="energy"]');
      if (!btn) throw new Error("missing Progress Energy leaf segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Progress Energy leaf click opens Energy", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="energy"]');
      return {
        ok: Boolean(active && window.state?.progressSeg === "energy" && location.pathname === "/app/progress/energy" && document.querySelector("#energyCard")),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg,
        active: active ? active.textContent.trim() : "",
        hasEnergyCard: Boolean(document.querySelector("#energyCard"))
      };
    })()`);
    ok(failures.length === 0, "/app/progress segment workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokePlanSegmentNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/plan/food", "plan");
    await assertGlobals(cdp);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-seg="meals"]');
      if (!btn) throw new Error("missing Plan Meals segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Plan segment click routes to Meals", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="meals"]');
      const view = document.querySelector("#view");
      return {
        ok: Boolean(
          active &&
          window.state?.tab === "plan" &&
          window.state?.planSeg === "meals" &&
          location.pathname === "/app/plan/meals" &&
          view &&
          view.textContent.trim().length > 0
        ),
        href: location.pathname,
        planSeg: window.state && window.state.planSeg,
        active: active ? active.textContent.trim() : ""
      };
    })()`);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.segbtn[data-seg="food"]');
      if (!btn) throw new Error("missing Plan Food segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Plan segment click returns to Food journal", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="food"]');
      return {
        ok: Boolean(active && window.state?.planSeg === "food" && location.pathname === "/app/plan/food" && document.querySelector("#dayFuelSlot") && document.querySelector("#energyCard")),
        href: location.pathname,
        planSeg: window.state && window.state.planSeg,
        hasDayFuel: Boolean(document.querySelector("#dayFuelSlot")),
        hasEnergyCard: Boolean(document.querySelector("#energyCard"))
      };
    })()`);
    ok(failures.length === 0, "/app/plan segment workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeHealthInnerNavigation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/stand", "stand");
    await assertGlobals(cdp);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector("[data-allmarkers]");
      if (!btn) throw new Error("missing Stand all-markers control");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Stand marker control routes to Markers", `(() => {
      const content = document.querySelector("#standResults");
      return {
        ok: Boolean(
          window.state?.tab === "stand" &&
          window.state?.standSeg === "markers" &&
          location.pathname === "/app/stand/markers" &&
          content &&
          content.textContent.trim().length > 0
        ),
        href: location.pathname,
        standSeg: window.state && window.state.standSeg,
        contentLength: content ? content.textContent.trim().length : 0
      };
    })()`);

    await navigateAndHydrate(cdp, base, "/app/stand/records", "stand");
    await waitForCondition(cdp, "Stand records route renders upload", `(() => {
      return {
        ok: Boolean(window.state?.standSeg === "records" && location.pathname === "/app/stand/records" && document.querySelector("#hUploadBox") && document.querySelector("#hUpload")),
        href: location.pathname,
        standSeg: window.state && window.state.standSeg,
        hasUploadBox: Boolean(document.querySelector("#hUploadBox")),
        hasUploadButton: Boolean(document.querySelector("#hUpload"))
      };
    })()`);
    ok(failures.length === 0, "/app/stand health-tool navigation workflow has no browser runtime/load errors", failures.join("\n"));
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
    await navigateAndHydrate(cdp, base, "/app/me/family", "me");
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

    ok(failures.length === 0, "/app/me/family workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokePlanEditorSaveAndMealRecipe(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const NEW_WEIGHT = "199";
  const newWeightJson = JSON.stringify(NEW_WEIGHT);
  try {
    await navigateAndHydrate(cdp, base, "/app/plan/edit", "plan");
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
    await navigateAndHydrate(cdp, base, "/app/stand/records", "stand");
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

    await waitForCondition(cdp, "Health Records saves the edited result date", `(() => {
      const id = ${firstIdJson};
      const row = [...document.querySelectorAll("#hlist .hdoc[data-hdoc]")].find((el) => el.dataset.hdoc === id);
      const val = row ? row.querySelector(".hdoc-date-val") : null;
      const text = val ? val.textContent.trim() : null;
      return { ok: text === ${newDateJson}, text };
    })()`);

    const savedDoc = await apiJson(base, `/health-docs/${first.id}`);
    ok(savedDoc?.doc_date === newDate, "API reflects the edited result date", JSON.stringify(savedDoc?.doc_date));

    ok(failures.length === 0, "/app/stand/records workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeSettingsAgentsSourcesAutomation(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  try {
    await navigateAndHydrate(cdp, base, "/app/settings/agents", "settings");
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
          location.pathname === "/app/settings/sources" &&
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
          location.pathname === "/app/settings/automation" &&
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

    ok(failures.length === 0, "/app/settings agents/sources/automation workflow has no browser runtime/load errors", failures.join("\n"));
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
    await smokeTodayAddExercise(cdp, ctx.base);
    await smokeTodayCardioSkip(cdp, ctx.base);
    await smokeTodaySyncedCardioOverridesSkip(cdp, ctx.base);
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
