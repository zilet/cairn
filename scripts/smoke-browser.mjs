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
const WORKFLOW_COUNT = 8;

const routes = [
  { path: "/", tab: "today" },
  { path: "/app/today", tab: "today" },
  { path: "/app/plan/food", tab: "plan", expectedState: { planSeg: "food" } },
  { path: "/app/plan/meals", tab: "plan", expectedState: { planSeg: "meals" } },
  { path: "/app/progress/energy", tab: "progress", expectedState: { progressSeg: "energy" } },
  { path: "/app/me/standing", tab: "me", expectedState: { meSeg: "standing" } },
  { path: "/app/me/health/read", tab: "me", expectedState: { meSeg: "health", healthSeg: "read" } },
  { path: "/app/me/health/records", tab: "me", expectedState: { meSeg: "health", healthSeg: "records" } },
  { path: "/app/me/memory", tab: "me", expectedState: { meSeg: "memory" } },
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
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
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
    .filter((item) => String(item.note || item.exercise || "") !== label)
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
        meSeg: window.state && window.state.meSeg,
        healthSeg: window.state && window.state.healthSeg,
        setSeg: window.state && window.state.setSeg,
        viewTextLength: view ? view.textContent.trim().length : 0,
        scripts: document.scripts.length
      };
    })()`);
    ok(state.href === route.path, `${route.path} preserves path URL after hydration`, JSON.stringify(state));
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
    ok(failures.length === 0, "/app/today add-exercise workflow has no browser runtime/load errors", failures.join("\n"));
  } finally {
    off();
  }
}

async function smokeTodayCardioSkip(cdp, base) {
  const { failures, off } = collectFailures(cdp, base);
  const label = `Smoke easy run ${Date.now()}`;
  const labelJson = JSON.stringify(label);
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
      if (window.state) window.state.plan = [];
      if (typeof renderToday !== "function") throw new Error("missing renderToday");
      return Promise.resolve(renderToday());
    })()`);
    await waitForCondition(cdp, "Today renders a planned cardio card", `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const skip = card?.querySelector(".ex-skip[data-skip]");
      const log = card?.querySelector("[data-cardio-log]");
      return {
        ok: Boolean(card && skip && log && location.pathname === "/app/today"),
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
    await waitForCondition(cdp, "Today restores a skipped planned cardio card", `(() => {
      const label = ${labelJson};
      const card = [...document.querySelectorAll(".ex-cardio")]
        .find((el) => el.querySelector(".cardio-name-txt")?.textContent?.trim() === label);
      const unskip = [...document.querySelectorAll("#skipLine [data-unskip]")]
        .find((button) => decodeURIComponent(button.dataset.unskip || "") === label);
      return {
        ok: Boolean(card && !unskip && location.pathname === "/app/today" && window.state?.tab === "today"),
        cardPresent: Boolean(card),
        hasUnskip: Boolean(unskip),
        href: location.pathname + location.search,
        tab: window.state && window.state.tab
      };
    })()`);
    ok(failures.length === 0, "/app/today planned-cardio skip workflow has no browser runtime/load errors", failures.join("\n"));
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
      const btn = document.querySelector('.segbtn[data-seg="program"]');
      if (!btn) throw new Error("missing Progress Program segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Progress segment click routes to Program", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="program"]');
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
      const btn = document.querySelector('.segbtn[data-seg="energy"]');
      if (!btn) throw new Error("missing Progress Energy segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Progress segment click returns to Energy", `(() => {
      const active = document.querySelector('.segbtn.active[data-seg="energy"]');
      return {
        ok: Boolean(active && window.state?.progressSeg === "energy" && location.pathname === "/app/progress/energy" && document.querySelector("#energyCard")),
        href: location.pathname,
        progressSeg: window.state && window.state.progressSeg,
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
    await navigateAndHydrate(cdp, base, "/app/me/health/read", "me");
    await assertGlobals(cdp);
    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.hseg .segbtn[data-hseg="markers"]');
      if (!btn) throw new Error("missing Health Markers segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Health inner segment click routes to Markers", `(() => {
      const active = document.querySelector('.hseg .segbtn.active[data-hseg="markers"]');
      const content = document.querySelector("#hContent");
      return {
        ok: Boolean(
          active &&
          window.state?.tab === "me" &&
          window.state?.meSeg === "health" &&
          window.state?.healthSeg === "markers" &&
          location.pathname === "/app/me/health/markers" &&
          content &&
          content.textContent.trim().length > 0
        ),
        href: location.pathname,
        healthSeg: window.state && window.state.healthSeg,
        active: active ? active.textContent.trim() : ""
      };
    })()`);

    await evaluate(cdp, `(() => {
      const btn = document.querySelector('.hseg .segbtn[data-hseg="records"]');
      if (!btn) throw new Error("missing Health Records segment");
      btn.click();
      return true;
    })()`);
    await waitForCondition(cdp, "Health inner segment click routes to Records upload", `(() => {
      const active = document.querySelector('.hseg .segbtn.active[data-hseg="records"]');
      return {
        ok: Boolean(active && window.state?.healthSeg === "records" && location.pathname === "/app/me/health/records" && document.querySelector("#hUploadBox") && document.querySelector("#hUpload")),
        href: location.pathname,
        healthSeg: window.state && window.state.healthSeg,
        hasUploadBox: Boolean(document.querySelector("#hUploadBox")),
        hasUploadButton: Boolean(document.querySelector("#hUpload"))
      };
    })()`);
    ok(failures.length === 0, "/app/me/health inner navigation workflow has no browser runtime/load errors", failures.join("\n"));
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
  await withServer({ label: SMOKE_NAME, authToken: "", portOffset: 2, extraEnv: { AGENTS_CONFIG: smokeAgents.file } }, async (ctx) => {
    for (const route of routes) await smokeRoute(cdp, ctx.base, route);
    await smokeTodayAddExercise(cdp, ctx.base);
    await smokeTodayCardioSkip(cdp, ctx.base);
    await smokeChatAttachmentFocus(cdp, ctx.base);
    await smokeChatSendStreamReconnect(cdp, ctx.base);
    await smokeSettingsDataControls(cdp, ctx.base);
    await smokeProgressSegmentNavigation(cdp, ctx.base);
    await smokePlanSegmentNavigation(cdp, ctx.base);
    await smokeHealthInnerNavigation(cdp, ctx.base);
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
