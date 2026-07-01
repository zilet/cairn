// Dependency-free browser smoke for the generated PWA app shell.
//
// This intentionally stays outside `npm run verify`: it needs a local Chrome
// binary and loopback CDP, so it is a release/manual gate rather than a fast
// deterministic unit gate. It catches the runtime class that static checks
// cannot: syntax errors, broken script order, missing globals, and route boot
// failures in a real browser.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { root, serverEntry, sleep, withServer } from "./smoke-server.mjs";

const SMOKE_NAME = "browser";
const DEBUG_PORT_MIN = 25000;
const DEBUG_PORT_SPAN = 5000;
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 600;

const routes = [
  { path: "/", tab: "today" },
  { path: "/app/today", tab: "today" },
  { path: "/app/plan/food", tab: "plan" },
  { path: "/app/plan/meals", tab: "plan" },
  { path: "/app/progress/energy", tab: "progress" },
  { path: "/app/me/standing", tab: "me" },
  { path: "/app/me/health/read", tab: "me" },
  { path: "/app/me/health/records", tab: "me" },
  { path: "/app/chat", tab: "chat" },
  { path: "/app/settings/data", tab: "settings" },
  { path: "/app/settings/agents", tab: "settings" },
];

const requiredGlobals = {
  startAppShell: "function",
  activateTab: "function",
  switchTab: "function",
  teardownJobs: "function",
  registerJobReconnector: "function",
  registerAppJobReconnectors: "function",
  jobReconnect: "function",
  CairnRoutes: "object",
  "CairnRoutes.parseRoute": "function",
  CairnChatClient: "object",
  CairnChatAttachment: "object",
  CairnMealRecipeController: "object",
  CairnDayFuelController: "object",
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

function tail(log) {
  return String(log || "").split("\n").slice(-20).join("\n");
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = debugPort() + attempt;
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
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
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

function collectFailures(cdp, base) {
  const failures = [];
  const allowedTypes = new Set(["Document", "Script", "Stylesheet", "Fetch", "XHR"]);
  const off = cdp.on((msg) => {
    const params = msg.params || {};
    if (msg.method === "Runtime.exceptionThrown") {
      const detail = params.exceptionDetails;
      failures.push(`runtime exception: ${detail?.text || detail?.exception?.description || "unknown"}`);
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
    const url = `${base}${route.path}`;
    const loaded = cdp.waitFor("Page.loadEventFired");
    const nav = await cdp.command("Page.navigate", { url });
    ok(!nav.errorText, `navigate ${route.path}`, nav.errorText || "");
    await loaded;
    await waitForHydration(cdp, route.tab);
    await sleep(SETTLE_MS);
    await assertGlobals(cdp);
    const state = await evaluate(cdp, `(() => {
      const view = document.querySelector("#view");
      return {
        href: location.pathname + location.search,
        tab: window.state && window.state.tab,
        planSeg: window.state && window.state.planSeg,
        healthSeg: window.healthSeg,
        settingsSeg: window.settingsSeg,
        viewTextLength: view ? view.textContent.trim().length : 0,
        scripts: document.scripts.length
      };
    })()`);
    ok(state.tab === route.tab, `${route.path} active tab is ${route.tab}`, JSON.stringify(state));
    ok(state.viewTextLength > 0, `${route.path} hydrated non-empty view`, JSON.stringify(state));
    ok(failures.length === 0, `${route.path} has no browser runtime/load errors`, failures.join("\n"));
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
try {
  chrome = await launchChrome();
  console.log(`Cairn browser smoke: using ${chrome.bin}`);
  cdp = await newPage(chrome);
  await withServer({ label: SMOKE_NAME, authToken: "", portOffset: 2 }, async (ctx) => {
    for (const route of routes) await smokeRoute(cdp, ctx.base, route);
  });
  console.log(`\nBrowser smoke OK - ${routes.length} route(s) loaded without runtime errors.`);
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
  if (cdp) cdp.close();
  await stopChrome(chrome);
}

process.exit(exitCode);
