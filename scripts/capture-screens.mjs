#!/usr/bin/env node
// Screenshot harness for design review (docs/DESIGN.md "Screenshot harness").
//
//   npm run screens -- [--port 8810] [--width 390] [--height 844] [--dpr 3]
//                      [--out <dir>] [--only today,ask] [--schemes light,dark] [--no-sheet]
//   npm run screens -- --reference <file.html> [--out <dir>]
//
// App mode boots the BUILT server (run `npm run build` first) on a throwaway DATA_DIR
// seeded with the demo persona (CAIRN_SEED_DEMO=1, plus its goal race as a structured
// goal so Horizon draws a build) and an OFFLINE agents table (every
// real CLI pointed at a command that does not exist, exactly as test/run.mjs does), so
// no agent CLI ever spawns and no real data is ever read. It then drives headless
// Chrome over CDP at a phone viewport, in light and dark (emulated
// prefers-color-scheme, reduced motion so no entrance is caught mid-flight), captures
// every named route full-page into --out, and builds contact-sheet.png (the first
// screen of each capture, light beside dark) with ImageMagick's `magick montage`.
//
// Reference mode renders a static design-reference page (phones laid out as `.phone`
// elements) at a 1260px board and saves each phone, light and dark, for side-by-side
// review. It needs no server.
//
// Not part of `npm test` or `npm run verify`: it needs Chrome and ImageMagick.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
const PORT = num(args.port, 8810);
const WIDTH = num(args.width, 390);
const HEIGHT = num(args.height, 844);
const DPR = num(args.dpr, 3);
const OUT = path.resolve(args.out || path.join(tmpdir(), "cairn-screens"));
const ONLY = String(args.only || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SCHEMES = String(args.schemes || "light,dark")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s === "light" || s === "dark");
const MAX_PAGE_HEIGHT = 9000;
const SETTLE_MS = num(args.settle, 1400);

// The SMOKE_PORT the shared server helper reads at import time pins our port.
process.env.SMOKE_PORT = String(PORT);
const { seedDemoRace, serverEntry, sleep, startBuiltServer, stopServer, writeOfflineAgentsConfig } = await import(
  "./smoke-server.mjs"
);
const { Cdp, launchChrome, stopChrome, tail } = await import("./cdp-chrome.mjs");

// ---------- the routes ----------
// `tab` is the view the route must hydrate as (window.state.tab). `prepare` runs in
// the page once it has hydrated, before the settle wait.
const ROUTES = [
  { name: "today", path: "/app/today", tab: "today" },
  {
    // Today's "What's ahead" strip with the next planned day opened inline.
    name: "today-ahead-open",
    path: "/app/today",
    tab: "today",
    // Waits past Today's first-paint snapshot (a copy whose controls are not wired yet).
    prepare: `new Promise((resolve) => { let n = 0; const tick = () => { const b = document.querySelector('.tstrip-day:not(.is-rest):not(.is-today):not(.is-past)'); if (b) { b.click(); setTimeout(() => { document.querySelector('#todayStripSlot')?.scrollIntoView(); resolve(true); }, 900); } else if (n++ < 60) setTimeout(tick, 100); else resolve(false); }; setTimeout(tick, 2500); })`,
  },
  { name: "today-session", path: "/app/today/session", tab: "session" },
  { name: "today-fuel", path: "/app/today/fuel", tab: "plan" },
  { name: "today-menu", path: "/app/today/menu", tab: "plan" },
  { name: "ask", path: "/app/ask", tab: "chat" },
  {
    name: "ask-whatif",
    path: "/app/ask",
    tab: "chat",
    prepare: `(() => { if (typeof openChatWhatIf === "function") openChatWhatIf("What if I move the long run to Saturday?"); return true; })()`,
  },
  { name: "ask-changes", path: "/app/ask/changes", tab: "plan" },
  { name: "train", path: "/app/train", tab: "progress" },
  { name: "train-trend", path: "/app/train/trend", tab: "progress" },
  { name: "train-volume", path: "/app/train/volume", tab: "progress" },
  { name: "train-program", path: "/app/train/program", tab: "progress" },
  { name: "train-sessions", path: "/app/train/sessions", tab: "progress" },
  { name: "train-energy", path: "/app/train/energy", tab: "progress" },
  { name: "train-intake", path: "/app/train/intake", tab: "progress" },
  { name: "train-endurance", path: "/app/train/endurance", tab: "progress" },
  { name: "train-weight", path: "/app/train/weight", tab: "progress" },
  { name: "train-plan", path: "/app/train/plan", tab: "plan" },
  { name: "horizon", path: "/app/horizon", tab: "horizon" },
  {
    name: "horizon-week",
    path: "/app/horizon",
    tab: "horizon",
    prepare: `(() => { document.querySelector('[data-horizon-seg="week"]')?.click(); return true; })()`,
  },
  {
    name: "horizon-season",
    path: "/app/horizon",
    tab: "horizon",
    prepare: `(() => { document.querySelector('[data-horizon-seg="season"]')?.click(); return true; })()`,
  },
  // A day opened from Horizon's week: two days ahead (a preview) and two days back (a record).
  { name: "horizon-day-next", path: () => `/app/day/${localDay(2)}`, tab: "day" },
  { name: "horizon-day-past", path: () => `/app/day/${localDay(-2)}`, tab: "day" },
  { name: "horizon-race", path: "/app/horizon/race", tab: "plan" },
  { name: "horizon-goal", path: "/app/horizon/goal", tab: "horizon" },
  { name: "you", path: "/app/you", tab: "you" },
  { name: "you-stone-heart", path: "/app/you/stone?id=heart", tab: "you" },
  { name: "you-health", path: "/app/you/health", tab: "stand" },
  { name: "you-records", path: "/app/you/records", tab: "stand" },
  { name: "you-markers", path: "/app/you/markers", tab: "stand" },
  { name: "you-share", path: "/app/you/share", tab: "stand" },
  { name: "you-settings", path: "/app/you/settings", tab: "settings" },
  { name: "you-life", path: "/app/you/life", tab: "me" },
  { name: "you-family", path: "/app/you/family", tab: "me" },
];

// ---------- helpers ----------
/** The local calendar day `offset` days from today, as the app's routes write it. */
function localDay(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A little more of the demo conversation than the seed carries: a meal logged in
 * chat (so the compact capture chip and its review render) — synthetic demo text,
 * written straight into the throwaway database.
 */
function seedAskThread(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const food = {
      meal: "lunch",
      summary: "Salmon rice bowl",
      kcal: 640,
      protein_g: 42,
      carbs_g: 68,
      fat_g: 20,
      fiber_g: 7,
      confidence: "medium",
      basis: "your words",
      ingredients: [
        { item: "Baked salmon", amount: "one fillet (140 g)", kcal: 290 },
        { item: "Jasmine rice", amount: "a cup", kcal: 230 },
        { item: "Cucumber and edamame", amount: "a side", kcal: 120 },
      ],
      ingredient_count: 3,
    };
    const note = db
      .prepare(
        `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, eaten_at)
         VALUES (date('now','localtime'), 'lunch', ?, ?, 'done', '12:40')`
      )
      .run("salmon rice bowl for lunch", JSON.stringify(food));
    const add = db.prepare(`INSERT INTO chat_messages (role, content, agent, meta) VALUES (?, ?, ?, ?)`);
    add.run("user", "had a salmon rice bowl for lunch, about 140 g of fish", null, null);
    add.run(
      "assistant",
      "Logged it as lunch. That keeps protein on pace for the day, and there is room for a normal dinner.",
      "stub",
      JSON.stringify({
        applied: [
          {
            type: "log_food",
            result: { id: Number(note.lastInsertRowid), meal: "lunch", enrichment_status: "done", food },
          },
        ],
      })
    );
  } finally {
    db.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function openPage(chrome) {
  const res = await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  if (!res.ok) throw new Error(`Chrome would not open a page (${res.status})`);
  const cdp = new Cdp((await res.json()).webSocketDebuggerUrl);
  await cdp.command("Page.enable");
  await cdp.command("Runtime.enable");
  return cdp;
}

async function setViewport(cdp, { width, height, dpr, mobile = true }) {
  await cdp.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
}

async function setScheme(cdp, scheme) {
  await cdp.command("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
}

async function navigate(cdp, url) {
  const loaded = cdp.waitFor("Page.loadEventFired", () => true, 30000).catch(() => null);
  await cdp.command("Page.navigate", { url });
  await loaded;
}

async function waitForView(cdp, tab, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(
      cdp,
      `(() => { const v = document.querySelector("#view"); return { tab: window.state && window.state.tab, text: v ? v.textContent.trim().length : 0 }; })()`
    ).catch(() => null);
    if (last && last.tab === tab && last.text > 0) return true;
    await sleep(120);
  }
  console.warn(`  ! ${tab} did not hydrate in time (last ${JSON.stringify(last)}); capturing anyway`);
  return false;
}

/** A full-page PNG: grow the viewport to the document, capture, shrink back. */
async function captureFullPage(cdp, file, { width, height, dpr }) {
  await evaluate(cdp, `document.fonts ? document.fonts.ready.then(() => true) : true`);
  const full = await evaluate(
    cdp,
    `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, ${height})`
  );
  const fullHeight = Math.ceil(Number(full) || height);
  const pageHeight = Math.min(MAX_PAGE_HEIGHT, fullHeight);
  if (fullHeight > pageHeight) {
    console.warn(`  ! ${path.basename(file)}: page is ${fullHeight}px, captured the first ${pageHeight}px`);
  }
  await setViewport(cdp, { width, height: pageHeight, dpr });
  await sleep(350);
  const shot = await cdp.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  await setViewport(cdp, { width, height, dpr });
  return pageHeight;
}

function montage(files, target, { cropW, cropH, tile }) {
  const magick = spawnSync("magick", ["-version"], { encoding: "utf8" });
  if (magick.status !== 0) {
    console.warn("  ! ImageMagick (`magick`) not found; skipping the contact sheet");
    return false;
  }
  const inputs = [];
  for (const file of files) inputs.push("-label", path.basename(file, ".png"), `${file}[${cropW}x${cropH}+0+0]`);
  const result = spawnSync(
    "magick",
    [
      "montage",
      ...inputs,
      "-tile",
      tile,
      "-geometry",
      "300x+14+14",
      "-background",
      "#d9d4c9",
      "-fill",
      "#191d20",
      "-pointsize",
      "15",
      target,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    console.warn(`  ! montage failed: ${result.stderr || result.stdout}`);
    return false;
  }
  return true;
}

// ---------- reference mode ----------
async function captureReference(file) {
  const source = path.resolve(file);
  if (!existsSync(source)) throw new Error(`reference not found: ${source}`);
  mkdirSync(OUT, { recursive: true });
  const chrome = await launchChrome({ windowSize: "1260,1000", profilePrefix: "cairn-screens-ref-" });
  let cdp = null;
  try {
    cdp = await openPage(chrome);
    const shots = [];
    for (const scheme of SCHEMES) {
      await setViewport(cdp, { width: 1260, height: 1000, dpr: 2, mobile: false });
      await setScheme(cdp, scheme);
      await navigate(cdp, pathToFileURL(source).href);
      await evaluate(cdp, `document.fonts ? document.fonts.ready.then(() => true) : true`);
      await sleep(800);
      const full = await evaluate(cdp, `document.documentElement.scrollHeight`);
      await setViewport(cdp, { width: 1260, height: Math.min(MAX_PAGE_HEIGHT, Number(full) || 1000), dpr: 2, mobile: false });
      await sleep(400);
      const phones = await evaluate(
        cdp,
        `[...document.querySelectorAll(".phone")].map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })`
      );
      const board = await cdp.command("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(OUT, `reference-board-${scheme}.png`), Buffer.from(board.data, "base64"));
      for (const [index, clip] of (phones || []).entries()) {
        const shot = await cdp.command("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
        const target = path.join(OUT, `reference-${String(index + 1).padStart(2, "0")}-${scheme}.png`);
        writeFileSync(target, Buffer.from(shot.data, "base64"));
        shots.push(target);
      }
      console.log(`  ${scheme}: ${phones?.length || 0} phone(s)`);
    }
    if (!args.flags.has("no-sheet") && shots.length) {
      const target = path.join(OUT, "reference-sheet.png");
      if (montage(shots.sort(), target, { cropW: 4000, cropH: 4000, tile: `${Math.min(6, SCHEMES.length * 3)}x` }))
        console.log(`✓ reference sheet: ${target}`);
    }
  } finally {
    if (cdp) cdp.close();
    await stopChrome(chrome);
  }
}

// ---------- app mode ----------
async function captureApp() {
  if (!existsSync(serverEntry)) throw new Error(`${serverEntry} is missing: run \`npm run build\` first`);
  mkdirSync(OUT, { recursive: true });
  const routes = ONLY.length ? ROUTES.filter((r) => ONLY.some((o) => r.name === o || r.name.startsWith(`${o}-`))) : ROUTES;
  if (!routes.length) throw new Error(`no route matches --only ${ONLY.join(",")}`);
  const agentsDir = mkdtempSync(path.join(tmpdir(), "cairn-screens-agents-"));
  let server = null;
  let chrome = null;
  let cdp = null;
  const files = [];
  try {
    server = await startBuiltServer({
      label: "screens",
      extraEnv: { AGENTS_CONFIG: writeOfflineAgentsConfig(agentsDir, "cairn-screens-offline"), CAIRN_SEED_DEMO: "1" },
    });
    console.log(`Cairn screens: server on ${server.base} (demo seed, offline agents, temp DB ${server.dir})`);
    seedAskThread(path.join(server.dir, "cairn-smoke.db"));
    if (!(await seedDemoRace(server.base))) console.warn("  ! could not set the demo race");
    chrome = await launchChrome({ windowSize: `${WIDTH},${HEIGHT}`, profilePrefix: "cairn-screens-" });
    cdp = await openPage(chrome);
    await setViewport(cdp, { width: WIDTH, height: HEIGHT, dpr: DPR });
    for (const scheme of SCHEMES) {
      await setScheme(cdp, scheme);
      for (const route of routes) {
        const routePath = typeof route.path === "function" ? route.path() : route.path;
        await navigate(cdp, `${server.base}${routePath}`);
        await waitForView(cdp, route.tab);
        if (route.prepare) await evaluate(cdp, route.prepare).catch((error) => console.warn(`  ! ${route.name}: ${error.message}`));
        await sleep(SETTLE_MS);
        const file = path.join(OUT, `${route.name}--${scheme}.png`);
        const h = await captureFullPage(cdp, file, { width: WIDTH, height: HEIGHT, dpr: DPR });
        files.push({ route: route.name, scheme, file });
        console.log(`  ${scheme.padEnd(5)} ${route.name.padEnd(18)} ${routePath} (${h}px)`);
      }
    }
    if (!args.flags.has("no-sheet")) {
      // Light beside dark for each route, three routes a row.
      const ordered = routes.flatMap((r) => SCHEMES.map((s) => files.find((f) => f.route === r.name && f.scheme === s)?.file)).filter(Boolean);
      const target = path.join(OUT, "contact-sheet.png");
      if (montage(ordered, target, { cropW: WIDTH * DPR, cropH: HEIGHT * DPR, tile: `${Math.max(1, SCHEMES.length * 3)}x` }))
        console.log(`✓ contact sheet: ${target}`);
    }
    console.log(`✓ ${files.length} capture(s) in ${OUT}`);
  } catch (error) {
    if (server) error.serverLog = server.serverLog();
    throw error;
  } finally {
    if (cdp) cdp.close();
    await stopChrome(chrome);
    if (server) await stopServer(server);
    rmSync(agentsDir, { recursive: true, force: true });
  }
}

let exitCode = 0;
try {
  if (args.reference) await captureReference(args.reference);
  else await captureApp();
} catch (error) {
  console.error(`x screens failed: ${error.message}`);
  if (error.serverLog) console.error(tail(error.serverLog));
  exitCode = 1;
}
process.exit(exitCode);
