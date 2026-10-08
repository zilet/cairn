#!/usr/bin/env node
// Per-route load budget for the PWA (v2 Wave 6 "Performance"), measured in a real
// browser on a mid-phone profile: 390px viewport, CPU 4x, slow 4G (150 ms RTT,
// 1.6 Mbps down, 750 kbps up), reduced motion.
//
// It boots the BUILT server (run `npm run build` first) on a throwaway DATA_DIR seeded
// with the demo persona plus its goal race, with an OFFLINE agents table (no CLI ever
// spawns), drives headless Chrome over CDP, and opens every home and leaf route in a
// fresh browser context twice: COLD (empty HTTP cache, no service worker) and WARM
// (the second visit, once the service worker controls the page and the SWR cache is
// filled, every SWR row aged past its freshness window so the visit paints from cache
// and revalidates the same way on any machine). Each route is measured `--runs` times
// (default 3).
//
// GATE — deterministic measures only, against the checked-in scripts/perf-budget.json:
//   - api      /api calls per load (art images, telemetry and event streams excluded)
//   - dupes    duplicate GET URLs the page asks for within one load — 0, except a URL a
//              route's budget records under `knownDupes` (listed as a miss every run)
//   - rounds   serial /api request rounds: a call's round is 1 + the deepest round of
//              any call that FINISHED before it started (the dependency depth read from
//              start/end order, never from a time threshold)
//   - cls      cumulative layout shift
//   - js / css bytes transferred on the cold load (the route's eager + lazy bundles)
//   - skeleton no visible skeleton left once the route reads "ready"
// The gate reads the MEDIAN run per measure, so one noisy run does not fail it.
//
// REPORT-ONLY — FCP, first content and ready (median of the runs), printed beside the
// proposed targets and flagged (never failed) past a wide margin. "Ready" is: the
// route's tab is showing, no visible skeleton, no /api fetch in flight, and the view
// has been stable for 600 ms.
//
// Budgets are what v2 achieves plus headroom: js and css bytes are the measured median +
// max(4 KB, 5%) rounded up to a whole KB (cold and warm), CLS the measured worst run (floor
// 0.01), api / rounds / dupes exact, so a small legitimate change never fails the gate;
// `targets` holds the proposed
// per-group targets, and a route whose budget sits over its target is listed as a
// miss every run, so a loosened budget is never silent. Raise a budget deliberately:
// `node scripts/check-perf.mjs --update` re-measures and rewrites the route budgets, and
// `--update-bytes` rewrites only the js / css ceilings (api, rounds, cls and dupes stay as
// they are) — a budget diff is a review signal, like scripts/bundle-budget.json.
//
// Not part of `npm test`; `npm run verify` runs it only with CAIRN_PERF=1, since it
// needs Chrome (CHROME_BIN overrides discovery, CAIRN_CHROME_NO_SANDBOX=1 for CI
// containers).
//
// Usage: node scripts/check-perf.mjs [--runs 3] [--only today,ask] [--update | --update-bytes]
//                                    [--json <file>] [--no-throttle]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = path.join(here, "perf-budget.json");

// ---------- arguments ----------
function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out.flags.add(key);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const RUNS = Math.max(1, Math.floor(Number(args.runs) || 3));
const ONLY = String(args.only || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BYTES_ONLY = args.flags.has("update-bytes");
const UPDATE = args.flags.has("update") || BYTES_ONLY;
const JSON_OUT = args.json ? path.resolve(args.json) : null;
const THROTTLE = args.flags.has("no-throttle")
  ? null
  : { cpu: 4, latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 };
const READY_TIMEOUT_MS = 30000;
const SETTLE_MS = 1200;
/** Headroom when a budget is (re)set: bytes + max(4 KB, 5%) rounded up to a whole KB, CLS floor 0.01. */
const BYTES_MARGIN = 0.05;
const BYTES_FLOOR = 4 * 1024;
/** Timings are flagged (never failed) past target × this. */
const TIMING_WARN_FACTOR = 1.3;

const { seedDemoRace, sleep, startBuiltServer, stopServer, writeOfflineAgentsConfig } = await import("./smoke-server.mjs");
const { Cdp, launchChrome, stopChrome, tail } = await import("./cdp-chrome.mjs");

// ---------- the routes ----------
// Every home and leaf route. `tab` is the view it must hydrate as (window.state.tab);
// `group` picks the proposed target row.
const ROUTES = [
  { name: "today", path: "/app/today", tab: "today", group: "today" },
  { name: "today-session", path: "/app/today/session", tab: "session", group: "focus" },
  { name: "today-fuel", path: "/app/today/fuel", tab: "plan", group: "focus" },
  { name: "ask", path: "/app/ask", tab: "chat", group: "focus" },
  { name: "ask-changes", path: "/app/ask/changes", tab: "plan", group: "leaf" },
  { name: "train", path: "/app/train", tab: "progress", group: "leaf" },
  { name: "train-trend", path: "/app/train/trend", tab: "progress", group: "leaf" },
  { name: "train-volume", path: "/app/train/volume", tab: "progress", group: "leaf" },
  { name: "train-program", path: "/app/train/program", tab: "progress", group: "leaf" },
  { name: "train-sessions", path: "/app/train/sessions", tab: "progress", group: "leaf" },
  { name: "train-energy", path: "/app/train/energy", tab: "progress", group: "leaf" },
  { name: "train-intake", path: "/app/train/intake", tab: "progress", group: "leaf" },
  { name: "train-endurance", path: "/app/train/endurance", tab: "progress", group: "leaf" },
  { name: "train-weight", path: "/app/train/weight", tab: "progress", group: "leaf" },
  { name: "train-plan", path: "/app/train/plan", tab: "plan", group: "leaf" },
  { name: "horizon", path: "/app/horizon", tab: "horizon", group: "leaf" },
  { name: "horizon-race", path: "/app/horizon/race", tab: "plan", group: "leaf" },
  { name: "horizon-goal", path: "/app/horizon/goal", tab: "horizon", group: "leaf" },
  { name: "you", path: "/app/you", tab: "you", group: "leaf" },
  { name: "you-stone", path: "/app/you/stone?id=heart", tab: "you", group: "leaf" },
  { name: "you-health", path: "/app/you/health", tab: "stand", group: "leaf" },
  { name: "you-records", path: "/app/you/records", tab: "stand", group: "leaf" },
  { name: "you-markers", path: "/app/you/markers", tab: "stand", group: "leaf" },
  { name: "you-share", path: "/app/you/share", tab: "stand", group: "leaf" },
  { name: "you-settings", path: "/app/you/settings", tab: "settings", group: "leaf" },
  { name: "you-life", path: "/app/you/life", tab: "me", group: "leaf" },
  { name: "you-family", path: "/app/you/family", tab: "me", group: "leaf" },
];

/** Requests that are not part of a screen's data load: art images, telemetry, streams. */
const UNTRACKED_API = /^\/api\/(art\?|telemetry|events|chat\/stream|chat\/turns\/[^/]+\/stream)/;
const SKELETON_SELECTOR = '[class*="skel"], .hshimmer, .skeleton, [aria-busy="true"]';

// ---------- in-page instrumentation ----------
// Installed before any page script: paint / layout-shift observers, an /api fetch
// in-flight counter, and the "ready" detector. A skeleton counts only while it is
// VISIBLE (a hidden panel's placeholder rows are not on screen).
const INSTRUMENT = `(() => {
  const P = window.__perf = { cls: 0, shifts: [], paints: {}, inflight: 0, lastViewMutation: 0, ready: null, firstView: null };
  const untracked = ${UNTRACKED_API.toString()};
  const visibleSkel = (root) => [...root.querySelectorAll(${JSON.stringify(SKELETON_SELECTOR)})].filter((el) => el.getClientRects().length > 0);
  window.__perfVisibleSkel = visibleSkel;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { P.cls += e.value; P.shifts.push([Math.round(e.startTime), +e.value.toFixed(4)]); } }).observe({ type: "layout-shift", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.paints[e.name] = Math.round(e.startTime); }).observe({ type: "paint", buffered: true }); } catch {}
  const of = window.fetch;
  window.fetch = function (input, init) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    let p0 = raw; try { p0 = new URL(raw, location.href).pathname + new URL(raw, location.href).search; } catch {}
    const track = p0.startsWith("/api/") && !untracked.test(p0);
    if (track) P.inflight++;
    const p = of.apply(this, arguments);
    if (track) p.then((r) => r.clone().text().catch(() => null), () => null).finally(() => { P.inflight--; });
    return p;
  };
  const start = () => {
    const view = document.querySelector("#view");
    if (!view) return setTimeout(start, 10);
    new MutationObserver(() => { P.lastViewMutation = performance.now(); }).observe(view, { childList: true, subtree: true, characterData: true });
    let stableSince = null;
    const tick = () => {
      const s = window.state; const tabOk = s && s.tab === window.__wantTab;
      const text = view.textContent.trim().length;
      if (tabOk && text > 0 && P.firstView == null) P.firstView = Math.round(performance.now());
      const ok = tabOk && text > 40 && visibleSkel(view).length === 0 && P.inflight === 0;
      const now = performance.now();
      if (ok) {
        if (stableSince == null) stableSince = Math.max(now, P.lastViewMutation || 0);
        const since = Math.max(stableSince, P.lastViewMutation);
        if (now - since >= 600 && P.ready == null) P.ready = Math.round(since);
      } else stableSince = null;
      if (P.ready == null) setTimeout(tick, 40);
    };
    tick();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();`;

// ---------- browser plumbing ----------
async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

/** A page in its own fresh browser context: empty HTTP cache, storage and service workers. */
async function openContextPage(cdp) {
  const { browserContextId } = await cdp.command("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.command("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.command("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.command(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable", { maxTotalBufferSize: 50e6 });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  return { send, sessionId, browserContextId };
}

async function setThrottle(send, on) {
  if (!THROTTLE) return;
  await send("Emulation.setCPUThrottlingRate", { rate: on ? THROTTLE.cpu : 1 });
  await send(
    "Network.emulateNetworkConditions",
    on
      ? { offline: false, latency: THROTTLE.latency, downloadThroughput: THROTTLE.down, uploadThroughput: THROTTLE.up }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
  );
}

/** Wait (unthrottled, unmeasured) until the service worker controls the page and has precached. */
async function waitForServiceWorker(send) {
  return evaluate(
    send,
    `navigator.serviceWorker ? navigator.serviceWorker.ready.then(() => new Promise((r) => { const t = setInterval(async () => { const ks = await caches.keys(); if (ks.some((k) => k.startsWith("cairn-")) && navigator.serviceWorker.controller) { clearInterval(t); r(true); } }, 150); setTimeout(() => { clearInterval(t); r(false); }, 60000); })) : false`
  ).catch(() => false);
}

/**
 * Age every SWR row past its freshness window before the warm visit. How long the
 * service-worker wait took decides whether a row is still inside a `freshFor` window
 * (15 s, 60 s, …) when the warm load starts, so without this the warm api count moved
 * with the machine's speed and the gate flaked. Aged, the warm visit is always the
 * same load — a later open, painting from cache and revalidating every row.
 */
const SWR_AGE_MS = 10 * 60 * 1000;
async function ageSwrCache(send) {
  return evaluate(
    send,
    `(() => { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k || !k.startsWith("cairn.swr.v1.")) continue; try { const o = JSON.parse(localStorage.getItem(k)); if (o && typeof o.ts === "number") { o.ts -= ${SWR_AGE_MS}; localStorage.setItem(k, JSON.stringify(o)); n++; } } catch {} } return n; })()`
  ).catch(() => 0);
}

// ---------- one load ----------
/** Serial /api rounds: each call's round is 1 + the deepest round of a call that ended before it began. */
export function serialRounds(calls) {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  const round = new Map();
  for (const q of sorted) {
    let r = 1;
    for (const p of sorted) {
      if (p === q || !round.has(p) || p.end == null) continue;
      if (p.end <= q.start) r = Math.max(r, round.get(p) + 1);
    }
    round.set(q, r);
  }
  return Math.max(0, ...round.values());
}

async function measureLoad(cdp, page, base, route) {
  const { send, sessionId } = page;
  const reqs = new Map();
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    if (msg.method === "Network.requestWillBeSent") {
      reqs.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, t0: p.timestamp });
    } else if (msg.method === "Network.loadingFinished") {
      const r = reqs.get(p.requestId);
      if (r) Object.assign(r, { bytes: p.encodedDataLength, t1: p.timestamp });
    } else if (msg.method === "Network.loadingFailed") {
      const r = reqs.get(p.requestId);
      if (r) Object.assign(r, { failed: p.errorText, t1: p.timestamp });
    }
  });
  try {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__wantTab = ${JSON.stringify(route.tab)};` });
    await send("Page.navigate", { url: base + route.path });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let perf = null;
    while (Date.now() < deadline) {
      await sleep(200);
      perf = await evaluate(send, `window.__perf ? { ready: window.__perf.ready } : null`).catch(() => null);
      if (perf?.ready != null) break;
    }
    await sleep(SETTLE_MS); // let trailing requests and shifts land
    perf = await evaluate(
      send,
      `(() => { const P = window.__perf || {}; const v = document.querySelector("#view"); return { cls: P.cls || 0, shifts: P.shifts || [], fcp: (P.paints || {})["first-contentful-paint"] ?? null, firstView: P.firstView ?? null, ready: P.ready ?? null, tab: window.state && window.state.tab, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller), skeleton: v && window.__perfVisibleSkel ? window.__perfVisibleSkel(v).map((e) => (e.className && typeof e.className === "string" ? e.className.split(" ")[0] : e.nodeName)).slice(0, 3) : [] }; })()`
    );
    const docStart = [...reqs.values()].find((r) => r.type === "Document")?.t0 ?? 0;
    const origin = new URL(base).origin;
    const requests = [...reqs.values()]
      .filter((r) => r.url.startsWith(origin))
      .map((r) => ({
        url: r.url.slice(origin.length),
        method: r.method,
        type: r.type,
        bytes: r.bytes ?? 0,
        failed: r.failed || null,
        start: Math.round((r.t0 - docStart) * 1000),
        end: r.t1 ? Math.round((r.t1 - docStart) * 1000) : null,
      }));
    const api = requests.filter((r) => r.url.startsWith("/api/") && !UNTRACKED_API.test(r.url));
    const counts = new Map();
    // What the PAGE asked for twice. The browser's own favicon probe (type "Other")
    // re-reads the <link rel=icon> file from memory and is not the page's request.
    for (const r of requests) {
      if (r.method === "GET" && r.type !== "Document" && r.type !== "Other") counts.set(r.url, (counts.get(r.url) || 0) + 1);
    }
    const dupeUrls = [...counts].filter(([, n]) => n > 1).map(([url]) => url);
    const dupes = dupeUrls.map((url) => `${url} ×${counts.get(url)}`);
    const bytesOf = (type) => requests.filter((r) => r.type === type).reduce((sum, r) => sum + r.bytes, 0);
    return {
      api: api.length,
      dupes,
      dupeUrls,
      rounds: serialRounds(api),
      cls: +perf.cls.toFixed(4),
      js: bytesOf("Script"),
      css: bytesOf("Stylesheet"),
      skeleton: perf.ready == null ? ["never ready", ...perf.skeleton] : perf.skeleton,
      tabOk: perf.tab === route.tab,
      fcp: perf.fcp,
      firstContent: perf.firstView,
      ready: perf.ready,
      sw: perf.sw,
      requests,
    };
  } finally {
    off();
  }
}

async function measureRoute(cdp, base, route) {
  const page = await openContextPage(cdp);
  try {
    await setThrottle(page.send, true);
    const cold = await measureLoad(cdp, page, base, route);
    await setThrottle(page.send, false);
    const swReady = await waitForServiceWorker(page.send);
    await ageSwrCache(page.send);
    await setThrottle(page.send, true);
    const warm = await measureLoad(cdp, page, base, route);
    warm.swReady = swReady;
    return { cold, warm };
  } finally {
    await cdp.command("Target.disposeBrowserContext", { browserContextId: page.browserContextId }).catch(() => {});
  }
}

// ---------- aggregation, budget, report ----------
const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const maxOf = (xs) => Math.max(...xs.filter((x) => x != null));

function aggregate(runs) {
  const pick = (k) => runs.map((r) => r[k]);
  // The median run for each gated measure; dupes / skeleton take the median run's
  // count and keep the example URLs of whichever run had them.
  const dupesN = median(runs.map((r) => r.dupes.length));
  const skelN = median(runs.map((r) => r.skeleton.length));
  return {
    api: median(pick("api")),
    apiMax: maxOf(pick("api")),
    rounds: median(pick("rounds")),
    roundsMax: maxOf(pick("rounds")),
    cls: median(pick("cls")),
    clsMax: maxOf(pick("cls")),
    js: median(pick("js")),
    css: median(pick("css")),
    dupes: dupesN > 0 ? runs.find((r) => r.dupes.length > 0).dupes : [],
    dupeUrls: dupesN > 0 ? runs.find((r) => r.dupes.length > 0).dupeUrls : [],
    skeleton: skelN > 0 ? runs.find((r) => r.skeleton.length > 0).skeleton : [],
    tabOk: runs.every((r) => r.tabOk),
    fcp: median(pick("fcp")),
    firstContent: median(pick("firstContent")),
    ready: median(pick("ready")),
  };
}

const roundUpKiB = (n) => Math.ceil((n + Math.max(BYTES_FLOOR, n * BYTES_MARGIN)) / 1024) * 1024;
const clsBudget = (v) => Math.max(Math.ceil(v * 1000) / 1000, 0.01);

function budgetFor(agg, mode, previous) {
  const b = { api: agg.apiMax, rounds: agg.roundsMax, cls: clsBudget(agg.clsMax) };
  // A known duplicate is a recorded exception, carried across --update only while it
  // still happens; it is listed as a miss on every run until it is fixed.
  const known = (previous?.knownDupes || []).filter((url) => agg.dupeUrls.includes(url));
  if (known.length) b.knownDupes = known;
  Object.assign(b, { js: roundUpKiB(agg.js ?? 0), css: roundUpKiB(agg.css ?? 0) });
  return b;
}

/** Gate one mode of one route: returns failure strings. */
function gate(name, mode, agg, budget) {
  const fails = [];
  if (!budget) return [`${name} ${mode}: no budget in scripts/perf-budget.json (run with --update)`];
  if (!agg.tabOk) fails.push(`${name} ${mode}: did not hydrate as its tab`);
  for (const key of ["api", "rounds", "cls", "js", "css"]) {
    if (budget[key] == null || agg[key] == null) continue;
    if (agg[key] > budget[key]) fails.push(`${name} ${mode}: ${key} ${fmt(key, agg[key])} over budget ${fmt(key, budget[key])}`);
  }
  const known = new Set(budget.knownDupes || []);
  const dupes = agg.dupes.filter((_, i) => !known.has(agg.dupeUrls[i]));
  if (dupes.length) fails.push(`${name} ${mode}: duplicate GET ${dupes.join(", ")}`);
  if (agg.skeleton.length) fails.push(`${name} ${mode}: skeleton left after ready (${agg.skeleton.join(", ")})`);
  return fails;
}

function fmt(key, v) {
  if (v == null) return "-";
  if (key === "cls") return v.toFixed(3);
  if (key === "js" || key === "css") return `${(v / 1024).toFixed(1)}K`;
  return String(Math.round(v));
}

/** Where a route's measure sits against the proposed group target (report, not gate). */
function targetMisses(name, route, res, targets, budget) {
  const misses = [];
  for (const mode of ["cold", "warm"]) {
    for (const url of budget?.[mode]?.knownDupes || []) {
      if (res[mode].dupeUrls.includes(url)) misses.push(`${name}: ${mode} duplicate GET ${url} (known exception, target 0)`);
    }
  }
  const t = targets[route.group];
  if (!t) return misses;
  const over = (label, v, limit) => {
    if (v != null && limit != null && v > limit) misses.push(`${name}: ${label} ${label.includes("cls") ? v.toFixed(3) : Math.round(v)} > target ${limit}`);
  };
  over("warm api", res.warm.api, t.api);
  over("cold api", res.cold.api, t.api);
  over("warm cls", res.warm.cls, t.cls);
  over("cold cls", res.cold.cls, t.cls);
  return misses;
}

function timingWarnings(name, route, res, targets) {
  const t = targets[route.group];
  if (!t) return [];
  const warns = [];
  const check = (label, v, limit) => {
    if (v == null) return;
    if (limit != null && v > limit * TIMING_WARN_FACTOR) warns.push(`${name}: ${label} ${Math.round(v)} ms > ${Math.round(limit * TIMING_WARN_FACTOR)} (target ${limit} +30%)`);
  };
  check("cold FCP", res.cold.fcp, t.coldFcp);
  check("cold ready", res.cold.ready, t.coldReady);
  check("warm first content", res.warm.firstContent, t.warmFirstContent);
  check("warm ready", res.warm.ready, t.warmReady);
  return warns;
}

function printTable(rows) {
  const head = [
    "route",
    "api c/w",
    "rounds c/w",
    "cls c/w",
    "js KB",
    "css KB",
    "cold fcp/ready",
    "warm first/ready",
    "gate",
  ];
  const lines = rows.map(({ name, res, fails }) => [
    name,
    `${res.cold.api}/${res.warm.api}`,
    `${res.cold.rounds}/${res.warm.rounds}`,
    `${res.cold.cls.toFixed(3)}/${res.warm.cls.toFixed(3)}`,
    (res.cold.js / 1024).toFixed(0),
    (res.cold.css / 1024).toFixed(0),
    `${fmt("t", res.cold.fcp)}/${fmt("t", res.cold.ready)}`,
    `${fmt("t", res.warm.firstContent)}/${fmt("t", res.warm.ready)}`,
    fails.length ? "FAIL" : "ok",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const row = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(row(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const l of lines) console.log(row(l));
}

// ---------- main ----------
async function main() {
  const budgetDoc = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
  const targets = budgetDoc.targets || {};
  const routes = ROUTES.filter((r) => !ONLY.length || ONLY.includes(r.name));
  if (!routes.length) throw new Error(`no route matches --only ${ONLY.join(",")}`);

  const agentsDir = mkdtempSync(path.join(tmpdir(), "cairn-perf-agents-"));
  let server = null;
  let chrome = null;
  let cdp = null;
  const results = [];
  try {
    server = await startBuiltServer({
      label: "perf",
      extraEnv: { AGENTS_CONFIG: writeOfflineAgentsConfig(agentsDir, "cairn-perf-offline"), CAIRN_SEED_DEMO: "1" },
    });
    if (!(await seedDemoRace(server.base))) console.warn("  ! could not set the demo race");
    chrome = await launchChrome({ windowSize: "390,844", profilePrefix: "cairn-perf-" });
    const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
    cdp = new Cdp(version.webSocketDebuggerUrl);
    console.log(
      `Cairn perf: ${routes.length} routes × ${RUNS} run${RUNS === 1 ? "" : "s"}, ${THROTTLE ? "CPU 4x + slow 4G" : "unthrottled"}, 390px (${server.base})`
    );

    // Warm the server's own caches once (unmeasured), as a running athlete's server is.
    {
      const page = await openContextPage(cdp);
      try {
        await measureLoad(cdp, page, server.base, ROUTES[0]);
      } finally {
        await cdp.command("Target.disposeBrowserContext", { browserContextId: page.browserContextId }).catch(() => {});
      }
    }

    for (const route of routes) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await measureRoute(cdp, server.base, route));
      const res = { cold: aggregate(runs.map((r) => r.cold)), warm: aggregate(runs.map((r) => r.warm)) };
      results.push({ route, res, runs });
      process.stdout.write(`  · ${route.name}\n`);
    }
  } catch (error) {
    if (server) error.serverLog = server.serverLog();
    if (chrome) error.chromeLog = chrome.log();
    throw error;
  } finally {
    cdp?.close();
    if (chrome) await stopChrome(chrome);
    if (server) await stopServer(server);
    rmSync(agentsDir, { recursive: true, force: true });
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(results.map(({ route, res, runs }) => ({ route: route.name, res, runs })), null, 1));
    console.log(`raw measurements: ${JSON_OUT}`);
  }

  if (UPDATE) {
    const next = { ...budgetDoc, routes: { ...(budgetDoc.routes || {}) } };
    for (const { route, res } of results) {
      const prev = budgetDoc.routes?.[route.name];
      const fresh = { cold: budgetFor(res.cold, "cold", prev?.cold), warm: budgetFor(res.warm, "warm", prev?.warm) };
      // --update-bytes keeps every non-byte budget exactly as it is.
      next.routes[route.name] =
        BYTES_ONLY && prev
          ? {
              cold: { ...prev.cold, js: fresh.cold.js, css: fresh.cold.css },
              warm: { ...prev.warm, js: fresh.warm.js, css: fresh.warm.css },
            }
          : fresh;
    }
    writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`updated ${path.relative(process.cwd(), BUDGET_FILE)} (${results.length} routes)`);
  }

  const budgets = UPDATE ? JSON.parse(readFileSync(BUDGET_FILE, "utf8")).routes : budgetDoc.routes || {};
  const rows = [];
  const failures = [];
  const misses = [];
  const warnings = [];
  for (const { route, res } of results) {
    const b = budgets[route.name];
    const fails = [...gate(route.name, "cold", res.cold, b?.cold), ...gate(route.name, "warm", res.warm, b?.warm)];
    failures.push(...fails);
    misses.push(...targetMisses(route.name, route, res, targets, b));
    warnings.push(...timingWarnings(route.name, route, res, targets));
    rows.push({ name: route.name, res, fails });
  }
  const stale = Object.keys(budgets).filter((name) => !ROUTES.some((r) => r.name === name));
  for (const name of stale) failures.push(`${name}: budget names a route the gate no longer measures`);

  console.log("");
  printTable(rows);
  console.log("\nTimings are the median of the runs (ms) and report-only; the gate reads api, rounds, cls, bytes, dupes, skeleton.");
  if (misses.length) {
    console.log(`\nOver the proposed target (budgeted at today's level, see scripts/perf-budget.json "targets"):`);
    for (const m of misses) console.log(`  - ${m}`);
  }
  if (warnings.length) {
    console.log("\nTiming warnings (not failures):");
    for (const w of warnings) console.log(`  ~ ${w}`);
  }
  if (failures.length) {
    console.error(`\nPerf budget: ${failures.length} failure${failures.length === 1 ? "" : "s"}`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\nPerf budget: ${results.length} routes within budget.`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || String(error));
  if (error?.serverLog) console.error(`--- server output (tail) ---\n${tail(error.serverLog)}`);
  if (error?.chromeLog) console.error(`--- chrome output (tail) ---\n${tail(error.chromeLog)}`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
