#!/usr/bin/env node
// Promo recorder: the README / release clips, recorded from the DEMO SEED only.
//
//   npm run promo -- [--out media] [--only today,fuel] [--scheme light|dark] [--port 8820]
//   npm run promo -- --probe /app/today      # print the route's tappable controls, record nothing
//   npm run promo -- --social                # only the 1280×640 social card, from the demo's own numbers
//
// It boots the BUILT server (run `npm run build` first) on a throwaway DATA_DIR seeded
// with the fictional demo persona and an OFFLINE agents table — the same isolation the
// screenshot harness uses — so no agent CLI ever spawns and no real data is ever read.
// Each clip drives headless Chrome at a phone viewport and records Page.startScreencast
// frames in real time (motion ON: the point is to show it), with a soft ripple drawn
// where a tap lands. ffmpeg turns every clip into an MP4 and a GIF; the hero cut joins
// the clips between title cards rendered in the app's own type, and a 16:9 trailer
// sets the phone beside its captions.
//
// Not part of `npm test` or `npm run verify`: it needs Chrome and ffmpeg.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
const PORT = Number(args.port) || 8820;
const WIDTH = 390;
const HEIGHT = 844;
const DPR = 2;
const SCHEME = args.scheme === "dark" ? "dark" : "light";
const ONLY = String(args.only || "").split(",").map((s) => s.trim()).filter(Boolean);

process.env.SMOKE_PORT = String(PORT);
const { root, seedDemoRace, serverEntry, sleep, startBuiltServer, stopServer, writeOfflineAgentsConfig } = await import(
  "./smoke-server.mjs"
);
const { Cdp, launchChrome, stopChrome, tail } = await import("./cdp-chrome.mjs");
const OUT = path.resolve(args.out || path.join(root, "media"));

// ---------- the clips ----------
// A step is one of:
//   { go: "/app/x", tab }                    navigate and wait for the view to hydrate
//   { hold: ms }                             let it breathe
//   { scroll: px, ms }                       eased scroll of the page's scroller
//   { scrollTo: "selector", ms }             eased scroll until the element sits near the top
//   { tap: "selector" | {text, within} }     ripple + click
//   { run: "js" }                            arbitrary page script (returns nothing)
const CLIPS = [
  {
    name: "brief",
    title: "It reads your day.",
    sub: "Rest, easy or train — a suggestion, with the reasoning shown.",
    steps: [
      { go: "/app/today", tab: "today" },
      { hold: 2600 },
      { scroll: 520, ms: 2200 },
      { hold: 1500 },
      { scroll: 620, ms: 2400 },
      { hold: 1500 },
      { scroll: -1140, ms: 1800 },
      { hold: 900 },
    ],
  },
  {
    name: "cairn",
    title: "Six stones. One picture.",
    sub: "Sleep, heart, strength, run, fuel and labs — read together.",
    steps: [
      { go: "/app/you", tab: "you" },
      { hold: 2400 },
      { tap: 'a[data-cairn-stack-go="heart"]' },
      { hold: 2600 },
      { scroll: 520, ms: 2000 },
      { hold: 1400 },
    ],
  },
  {
    name: "changes",
    title: "The team decides. You can Undo.",
    sub: "Bounded changes land with their why. Clinical ones still ask.",
    steps: [
      { go: "/app/ask/changes", tab: "plan" },
      { hold: 3200 },
      { tap: "[data-chfeed-undo]" },
      { hold: 2400 },
    ],
  },
  {
    name: "fuel",
    title: "Food, in your words.",
    sub: "Type it like you'd say it. Every meal comes back editable.",
    steps: [
      { go: "/app/today/fuel", tab: "plan" },
      { hold: 2400 },
      { scroll: 420, ms: 1800 },
      { hold: 1400 },
      { tap: "[data-fuel-meals-toggle]" },
      { hold: 1800 },
      { tap: { text: "Edit" } },
      { hold: 2600 },
      { scroll: 420, ms: 1800 },
      { hold: 1600 },
    ],
  },
  {
    name: "race",
    title: "A race build sized to you.",
    sub: "Your demonstrated weeks set the floor. The peak is a new high.",
    steps: [
      { go: "/app/horizon/race", tab: "plan" },
      { hold: 2600 },
      { scroll: 560, ms: 2400 },
      { hold: 1500 },
      { scroll: 640, ms: 2400 },
      { hold: 1500 },
    ],
  },
  {
    name: "horizon",
    title: "One line of time.",
    sub: "Race, goal and labs on the same horizon.",
    steps: [
      { go: "/app/horizon", tab: "horizon" },
      { hold: 2400 },
      { tap: '[data-horizon-seg="week"]' },
      { hold: 2200 },
      { tap: '[data-horizon-seg="season"]' },
      { hold: 2400 },
    ],
  },
  {
    name: "records",
    title: "Labs that travel.",
    sub: "A flagged marker reaches your meals and your training.",
    steps: [
      { go: "/app/you/health", tab: "stand" },
      { hold: 2600 },
      { scroll: 600, ms: 2400 },
      { hold: 1600 },
      { scroll: 600, ms: 2400 },
      { hold: 1400 },
      { go: "/app/you/share", tab: "stand" },
      { hold: 2200 },
      { scroll: 520, ms: 2200 },
      { hold: 1600 },
    ],
  },
  {
    name: "ask",
    title: "Ask what if.",
    sub: "See the ripple across every stone before anything moves.",
    steps: [
      { go: "/app/ask", tab: "chat" },
      { hold: 2000 },
      {
        run: `(() => { if (typeof openChatWhatIf === "function") openChatWhatIf("What if I move the long run to Saturday?"); })()`,
      },
      { hold: 3200 },
      { scroll: 420, ms: 1800 },
      { hold: 1600 },
    ],
  },
];

// The hero cut's order, and how much of each clip it keeps (seconds from the start).
const HERO = [
  ["brief", 9],
  ["changes", 7],
  ["fuel", 8],
  ["race", 8],
  ["records", 8],
  ["cairn", 7],
  ["horizon", 8],
];
const HERO_GIF = ["brief", "changes", "fuel"];

// ---------- a little more demo than the seed carries ----------
/**
 * A change the team decided overnight, so the Changes feed has something to show. It is
 * made the way the app makes one — a draft proposal routed through the real autonomy
 * service — in a child process pointed at the throwaway database (the seed itself stays
 * agent-free and decision-free).
 */
function seedTeamChange(serverDir) {
  const script = `
    const repo = await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "repo.js")).href)});
    const { applyProposalWithAutonomy } = await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "domain", "brain", "autonomy-service.js")).href)});
    const day = repo.getPlan().find((d) => d.items.some((i) => Number(i.target_weight) > 20));
    const item = day.items.find((i) => Number(i.target_weight) > 20);
    const next = Number(item.target_weight) + 2.5;
    const draft = repo.createProposal("stub", "auto: earned step", "", {
      summary: item.exercise + " takes its next step",
      rationale: "Every working set reached the top of the range two sessions running, with reps to spare.",
      changes: [{ day_number: day.day_number, exercise: item.exercise, target_weight: next, reason: "top of the range, twice" }],
    });
    const out = applyProposalWithAutonomy(Number(draft.id ?? draft), {});
    console.log(JSON.stringify({ exercise: item.exercise, status: out?.decision?.status, tier: out?.decision?.autonomy_tier }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: serverDir, DB_PATH: path.join(serverDir, "cairn-smoke.db"), AGENTS_CONFIG: path.join(serverDir, "..", "agents", "agents.offline.json") },
  });
  if (result.status !== 0) console.warn(`  ! team change not seeded: ${(result.stderr || "").split("\n").slice(-4).join(" ")}`);
  else console.log(`  team change: ${result.stdout.trim().split("\n").pop()}`);
}

/** Lunch, logged in the athlete's words and already read, so Fuel shows a meal card. */
function seedLunch(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const food = {
      meal: "lunch", summary: "Salmon rice bowl", kcal: 640, protein_g: 42, carbs_g: 68, fat_g: 20, fiber_g: 7,
      confidence: "medium", basis: "your words",
      ingredients: [
        { item: "Baked salmon", amount: "one fillet (140 g)", kcal: 290 },
        { item: "Jasmine rice", amount: "a cup", kcal: 230 },
        { item: "Cucumber and edamame", amount: "a side", kcal: 120 },
      ],
      ingredient_count: 3,
    };
    db.prepare(
      `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, eaten_at)
       VALUES (date('now','localtime'), 'lunch', ?, ?, 'done', '12:40')`
    ).run("salmon rice bowl for lunch, about 140 g of fish", JSON.stringify(food));
  } finally {
    db.close();
  }
}

// ---------- page helpers ----------
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

async function setup(cdp, { width = WIDTH, height = HEIGHT, dpr = DPR, mobile = true, scheme = SCHEME } = {}) {
  await cdp.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
  await cdp.command("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: "no-preference" },
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
  while (Date.now() < deadline) {
    const v = await evaluate(
      cdp,
      `(() => { const v = document.querySelector("#view"); return { tab: window.state && window.state.tab, text: v ? v.textContent.trim().length : 0 }; })()`
    ).catch(() => null);
    if (v && (!tab || v.tab === tab) && v.text > 0) return true;
    await sleep(120);
  }
  console.warn(`  ! ${tab} did not hydrate in time`);
  return false;
}

// Installed once per document: an eased scroller over whichever element actually scrolls,
// and a soft dawn ripple for taps (so a viewer sees where the finger went).
const PAGE_KIT = `(() => {
  if (window.__promo) return true;
  const scroller = () => {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > innerHeight + 4) return se;
    let best = null, area = 0;
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 4) continue;
      const a = el.clientWidth * el.clientHeight;
      if (a > area) { best = el; area = a; }
    }
    return best || se;
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const style = document.createElement("style");
  style.textContent = ".promo-tap{position:fixed;z-index:2147483647;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;pointer-events:none;background:rgba(152,75,14,.28);box-shadow:0 0 0 2px rgba(152,75,14,.45);animation:promo-tap .7s cubic-bezier(.2,.7,.2,1) forwards}@keyframes promo-tap{0%{transform:scale(.4);opacity:1}100%{transform:scale(1.5);opacity:0}}";
  document.head.appendChild(style);
  window.__promo = {
    scrollBy(dy, ms) {
      const el = scroller();
      const from = el.scrollTop, to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + dy));
      return new Promise((done) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          el.scrollTop = from + (to - from) * ease(t);
          t < 1 ? requestAnimationFrame(step) : done(true);
        };
        requestAnimationFrame(step);
      });
    },
    find(sel) {
      if (typeof sel === "string") {
        for (const part of sel.split(",")) {
          const el = [...document.querySelectorAll(part.trim())].find((n) => n.getClientRects().length);
          if (el) return el;
        }
        return null;
      }
      const scope = sel.within ? document.querySelector(sel.within) || document : document;
      const want = sel.text.toLowerCase();
      return [...scope.querySelectorAll("button, a, [role=button], [data-action]")]
        .filter((n) => n.getClientRects().length)
        .find((n) => n.textContent.trim().toLowerCase().startsWith(want)) || null;
    },
    async tap(sel) {
      const el = this.find(sel);
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      await new Promise((r) => setTimeout(r, 650));
      const r = el.getBoundingClientRect();
      const dot = document.createElement("div");
      dot.className = "promo-tap";
      dot.style.left = r.left + r.width / 2 + "px";
      dot.style.top = r.top + r.height / 2 + "px";
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 800);
      await new Promise((r) => setTimeout(r, 180));
      if (typeof el.click === "function") el.click();
      else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    },
  };
  return true;
})()`;

const kit = (cdp) => evaluate(cdp, PAGE_KIT);

async function playStep(cdp, base, step) {
  if (step.go) {
    await navigate(cdp, `${base}${step.go}`);
    await waitForView(cdp, step.tab);
    await kit(cdp);
    await sleep(500);
  } else if (step.hold) {
    await sleep(step.hold);
  } else if (step.scroll) {
    await kit(cdp);
    await evaluate(cdp, `window.__promo.scrollBy(${Number(step.scroll)}, ${Number(step.ms) || 1600})`);
  } else if (step.tap) {
    await kit(cdp);
    const ok = await evaluate(cdp, `window.__promo.tap(${JSON.stringify(step.tap)})`);
    if (!ok) console.warn(`  ! tap target not found: ${JSON.stringify(step.tap)}`);
  } else if (step.run) {
    await evaluate(cdp, step.run).catch((e) => console.warn(`  ! run: ${e.message}`));
  }
}

// ---------- recording ----------
async function recordClip(cdp, base, clip, workDir) {
  const frames = [];
  const off = cdp.on((msg) => {
    if (msg.method !== "Page.screencastFrame") return;
    const { data, metadata, sessionId } = msg.params;
    frames.push({ data, ts: metadata.timestamp });
    cdp.command("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  // Land on the first route before the camera rolls, so the clip opens on a painted screen.
  const [first, ...rest] = clip.steps;
  await playStep(cdp, base, first);
  await sleep(600);
  await cdp.command("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  const t0 = Date.now();
  for (const step of rest) await playStep(cdp, base, step);
  await cdp.command("Page.stopScreencast");
  off();
  const wall = (Date.now() - t0) / 1000;
  if (frames.length < 2) throw new Error(`${clip.name}: only ${frames.length} frame(s) captured`);
  const dir = path.join(workDir, clip.name);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `f${String(i).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    const next = frames[i + 1];
    const dur = next ? Math.max(0.001, next.ts - f.ts) : Math.max(0.5, wall - (f.ts - frames[0].ts));
    lines.push(`file '${file}'`, `duration ${dur.toFixed(4)}`);
  });
  lines.push(`file '${path.join(dir, `f${String(frames.length - 1).padStart(5, "0")}.jpg`)}'`);
  const list = path.join(dir, "frames.txt");
  writeFileSync(list, `${lines.join("\n")}\n`);
  const fps = (frames.length / wall).toFixed(1);
  console.log(`  ${clip.name.padEnd(9)} ${frames.length} frames over ${wall.toFixed(1)}s (~${fps} fps)`);
  return list;
}

function ffmpeg(argv, label) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`ffmpeg (${label}) failed: ${result.stderr || result.stdout}`);
}

// Frames → a constant-30fps phone MP4 (the master every other output is cut from).
function encodeClip(list, target) {
  ffmpeg(
    ["-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=30,scale=${WIDTH * DPR}:-2:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", target],
    path.basename(target)
  );
}

// A small, README-friendly GIF: 15 fps, 320 px wide, one palette per clip.
function encodeGif(source, target, { width = 270, fps = 10, maxSeconds = 0 } = {}) {
  const trim = maxSeconds ? ["-t", String(maxSeconds)] : [];
  ffmpeg(
    [...trim, "-i", source, "-filter_complex",
      `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      target],
    path.basename(target)
  );
}

// ---------- title cards + trailer backgrounds (rendered by Chrome, in the app's type) ----------
const FONTS = path.join(root, "public", "fonts");
const PALETTE = SCHEME === "dark"
  ? { ground: "#121619", ink: "#ece6da", ink2: "#b0b3ad", dawn: "#f0aa62" }
  : { ground: "#ebe7de", ink: "#191d20", ink2: "#454b50", dawn: "#984b0e" };
const fontFace = `
@font-face{font-family:"Young Serif";src:url("${pathToFileURL(path.join(FONTS, "young-serif-latin-400.woff2")).href}") format("woff2")}
@font-face{font-family:"Hanken Grotesk";font-weight:100 900;src:url("${pathToFileURL(path.join(FONTS, "hanken-grotesk-latin-wght.woff2")).href}") format("woff2")}
@font-face{font-family:"Martian Mono";src:url("${pathToFileURL(path.join(FONTS, "martian-mono-latin-400.woff2")).href}") format("woff2")}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// The cairn mark: three stacked stones, drawn here so a card needs no asset.
const MARK = (size, color) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
  <ellipse cx="32" cy="50" rx="22" ry="8.5" fill="${color}" opacity=".95"/>
  <ellipse cx="31" cy="35.5" rx="15.5" ry="7" fill="${color}" opacity=".8"/>
  <ellipse cx="33" cy="23" rx="10" ry="5.6" fill="${color}" opacity=".65"/>
  <ellipse cx="32" cy="13" rx="5.5" ry="3.6" fill="${PALETTE.dawn}"/></svg>`;

function cardHtml({ kicker = "", title, sub = "", width, height, align = "center", mark = false }) {
  const u = Math.min(width, height * 1.2); // a wide card sizes its type by its height
  return `<!doctype html><meta charset="utf-8"><style>${fontFace}
  html,body{margin:0;width:${width}px;height:${height}px;background:${PALETTE.ground};color:${PALETTE.ink};overflow:hidden}
  body{display:flex;flex-direction:column;justify-content:center;align-items:${align === "center" ? "center" : "flex-start"};
       text-align:${align};padding:0 ${Math.round(width * 0.09)}px;box-sizing:border-box;
       background-image:radial-gradient(ellipse at 50% 120%, ${PALETTE.dawn}22, transparent 60%)}
  .k{font:500 ${Math.round(u * 0.028)}px/1.2 "Martian Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:${PALETTE.dawn};margin-bottom:${Math.round(u * 0.04)}px}
  h1{font:400 ${Math.round(u * 0.085)}px/1.08 "Young Serif",serif;margin:0;letter-spacing:-.01em}
  p{font:400 ${Math.round(u * 0.042)}px/1.4 "Hanken Grotesk",sans-serif;color:${PALETTE.ink2};margin:${Math.round(u * 0.045)}px 0 0;max-width:22em}
  .m{margin-bottom:${Math.round(u * 0.05)}px}</style>
  ${mark ? `<div class="m">${MARK(Math.round(u * 0.16), PALETTE.ink)}</div>` : ""}
  ${kicker ? `<div class="k">${esc(kicker)}</div>` : ""}<h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}`;
}

// A 16:9 trailer frame: captions on the left, a phone-shaped hole on the right that the
// clip is overlaid into (the rounded mask is a second render of the same geometry).
const TRAILER = { w: 1920, h: 1080, phoneH: 940 };
TRAILER.phoneW = Math.round((TRAILER.phoneH * WIDTH) / HEIGHT);
TRAILER.phoneX = 1920 - 220 - TRAILER.phoneW;
TRAILER.phoneY = Math.round((1080 - TRAILER.phoneH) / 2);

function trailerHtml({ kicker, title, sub }) {
  const { w, h, phoneW, phoneH, phoneX, phoneY } = TRAILER;
  return `<!doctype html><meta charset="utf-8"><style>${fontFace}
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${PALETTE.ground};color:${PALETTE.ink}}
  body{background-image:radial-gradient(ellipse at 78% 110%, ${PALETTE.dawn}26, transparent 55%)}
  .copy{position:absolute;left:180px;top:0;bottom:0;width:${phoneX - 300}px;display:flex;flex-direction:column;justify-content:center}
  .k{font:500 22px/1.2 "Martian Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:${PALETTE.dawn};margin-bottom:34px}
  h1{font:400 92px/1.04 "Young Serif",serif;margin:0;letter-spacing:-.012em}
  p{font:400 34px/1.45 "Hanken Grotesk",sans-serif;color:${PALETTE.ink2};margin:36px 0 0}
  .brand{position:absolute;left:180px;bottom:72px;display:flex;align-items:center;gap:16px;font:400 30px "Young Serif",serif}
  .phone{position:absolute;left:${phoneX - 14}px;top:${phoneY - 14}px;width:${phoneW + 28}px;height:${phoneH + 28}px;border-radius:64px;
         background:${PALETTE.ink};box-shadow:0 40px 90px rgba(0,0,0,.28),0 8px 24px rgba(0,0,0,.18)}</style>
  <div class="copy"><div class="k">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
  <div class="brand">${MARK(44, PALETTE.ink)}Cairn</div><div class="phone"></div>`;
}

function phoneMaskHtml() {
  const { w, h, phoneW, phoneH, phoneX, phoneY } = TRAILER;
  return `<!doctype html><style>html,body{margin:0;width:${w}px;height:${h}px;background:#000}
  div{position:absolute;left:${phoneX}px;top:${phoneY}px;width:${phoneW}px;height:${phoneH}px;border-radius:52px;background:#fff}</style><div></div>`;
}

async function renderHtml(cdp, html, file, { width, height }) {
  const htmlFile = path.join(process.env.TMPDIR || tmpdir(), `cairn-promo-${path.basename(file)}.html`);
  writeFileSync(htmlFile, html);
  await setup(cdp, { width, height, dpr: 1, mobile: false });
  await navigate(cdp, pathToFileURL(htmlFile).href);
  await evaluate(cdp, `document.fonts.ready.then(() => true)`);
  await sleep(200);
  const shot = await cdp.command("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  rmSync(htmlFile, { force: true });
}

// ---------- the social card (GitHub's 1280×640) ----------
// An outcome, not a tagline: the demo persona's own squat line, bodyweight and race ladder,
// read from the API at render time beside a live Today screen. Nothing on it is typed in.
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const wordFor = (n) => NUMBER_WORDS[n] ?? String(n);
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

async function socialData(base) {
  const get = async (route) => (await fetch(`${base}${route}`)).json();
  const [squat, weights, race] = await Promise.all([get("/api/progress/Back%20Squat"), get("/api/bodyweight"), get("/api/race-build")]);
  // The heavy day's top set: each new high, minus a lighter day superseded within three days.
  const highs = [];
  for (const p of squat.points || []) if (!highs.length || p.topWeight > highs.at(-1).topWeight) highs.push(p);
  const steps = highs.filter((p, i) => {
    const next = highs[i + 1];
    return !next || (Date.parse(next.date) - Date.parse(p.date)) / 864e5 > 3;
  });
  const capacity = race.capacity || {};
  const ladder = [];
  if (capacity.best_week_km) ladder.push({ km: capacity.best_week_km, kind: "logged", week_start: capacity.floor_week_start });
  for (const w of race.weeks || []) ladder.push({ km: w.km, kind: w.kind, week_start: w.week_start, current: w.current });
  return {
    unit: squat.unit || "lb",
    reps: steps.at(-1)?.topReps,
    steps,
    weight: { from: weights[0]?.weight_lb, to: weights.at(-1)?.weight_lb, weeks: Math.round((Date.parse(weights.at(-1)?.date) - Date.parse(weights[0]?.date)) / (7 * 864e5)) },
    race: { event: race.race?.event, date: race.race?.date, weeks: race.race?.weeks_to_race, km: race.race?.distance_km },
    floorKm: capacity.best_week_km,
    ladder,
  };
}

function squatSvg(steps, w, h) {
  const pad = { l: 10, r: 18, t: 16, b: 14 };
  const ys = steps.map((p) => p.topWeight);
  const lo = Math.min(...ys) - 4;
  const hi = Math.max(...ys) + 2;
  const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, steps.length - 1);
  const y = (v) => pad.t + ((hi - v) * (h - pad.t - pad.b)) / (hi - lo);
  const line = steps.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.topWeight).toFixed(1)}`).join(" ");
  const area = `${line} L${x(steps.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  const dots = steps
    .map((p, i) => {
      const last = i === steps.length - 1;
      return `<circle cx="${x(i)}" cy="${y(p.topWeight)}" r="${last ? 8 : 5.5}" fill="${last ? PALETTE.dawn : PALETTE.ground}" stroke="${last ? PALETTE.dawn : PALETTE.ink}" stroke-width="3"/>`;
    })
    .join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="sq" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${PALETTE.dawn}" stop-opacity=".22"/><stop offset="1" stop-color="${PALETTE.dawn}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#sq)"/><path d="${line}" fill="none" stroke="${PALETTE.ink}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

function ladderSvg(ladder, floorKm, w, h) {
  const top = Math.max(...ladder.map((l) => l.km)) * 1.12;
  const gap = 10;
  const bw = (w - gap * (ladder.length - 1)) / ladder.length;
  const y = (km) => h - (km * h) / top;
  const bars = ladder
    .map((l, i) => {
      const bx = i * (bw + gap);
      const fill = l.kind === "logged" ? PALETTE.ink : l.kind === "peak" ? PALETTE.dawn : l.kind === "race" ? "none" : `${PALETTE.ink}2e`;
      const stroke = l.kind === "race" ? `stroke="${PALETTE.dawn}" stroke-width="3" stroke-dasharray="5 4"` : "";
      return `<rect x="${bx}" y="${y(l.km)}" width="${bw}" height="${h - y(l.km)}" rx="5" fill="${fill}" ${stroke}/>`;
    })
    .join("");
  const fy = y(floorKm);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible">${bars}
    <line x1="-6" x2="${w + 6}" y1="${fy}" y2="${fy}" stroke="${PALETTE.ink}" stroke-width="2" stroke-dasharray="3 5" opacity=".55"/>
    <text x="0" y="${fy - 8}" text-anchor="start" font-family="Martian Mono" font-size="11" letter-spacing=".06em" fill="${PALETTE.ink2}">BEST WEEK ${floorKm} KM</text></svg>`;
}

function socialHtml(d, phonePng) {
  const first = d.steps[0];
  const last = d.steps.at(-1);
  const lost = Math.round((d.weight.from - d.weight.to) * 10) / 10;
  return `<!doctype html><meta charset="utf-8"><style>${fontFace}
  html,body{margin:0;width:1280px;height:640px;overflow:hidden;background:${PALETTE.ground};color:${PALETTE.ink};font-family:"Hanken Grotesk",sans-serif}
  body{position:relative;background-image:radial-gradient(ellipse at 88% 115%, ${PALETTE.dawn}30, transparent 55%),radial-gradient(ellipse at 0% 0%, #ffffff55, transparent 50%)}
  .mono{font:500 15px/1.2 "Martian Mono",monospace;letter-spacing:.12em;text-transform:uppercase}
  .copy{position:absolute;left:72px;top:64px;width:470px}
  .k{color:${PALETTE.dawn};margin-bottom:26px}
  h1{font:400 60px/1.04 "Young Serif",serif;letter-spacing:-.015em;margin:0}
  h1 em{font-style:normal;color:${PALETTE.dawn}}
  .sub{font-size:23px;line-height:1.42;color:${PALETTE.ink2};margin:26px 0 0}
  .brand{position:absolute;left:72px;bottom:54px;display:flex;align-items:center;gap:14px;font:400 30px "Young Serif",serif}
  .brand .mono{font-size:14px;color:${PALETTE.ink2};margin-left:10px;letter-spacing:.08em;text-transform:none}
  .card{position:absolute;background:#fbf9f4;border-radius:22px;box-shadow:0 22px 50px rgba(25,29,32,.14),0 3px 10px rgba(25,29,32,.07);padding:20px 24px;box-sizing:border-box}
  .card .mono{font-size:12.5px;color:${PALETTE.ink2}}
  .big{font:400 40px/1.05 "Young Serif",serif;margin:8px 0 4px;letter-spacing:-.01em}
  .big small{font-size:22px;color:${PALETTE.ink2}}
  .note{font-size:16px;color:${PALETTE.ink2}}
  .note b{color:${PALETTE.ink};font-weight:600}
  .squat{left:576px;top:52px;width:392px;height:262px}
  .race{left:576px;top:334px;width:430px;height:256px}
  .legend{display:flex;gap:16px;font-size:14px;color:${PALETTE.ink2};margin-top:12px}
  .legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
  .phone{position:absolute;right:56px;top:40px;width:262px;height:566px;border-radius:40px;background:${PALETTE.ink};padding:9px;box-sizing:border-box;
         box-shadow:0 34px 70px rgba(25,29,32,.28),0 6px 18px rgba(25,29,32,.16);transform:rotate(3deg)}
  .phone img{width:100%;height:100%;object-fit:cover;object-position:top;border-radius:32px;display:block}
  .undo{position:absolute;left:870px;top:274px;z-index:3;display:flex;align-items:center;gap:12px;background:${PALETTE.ink};color:${PALETTE.ground};
        border-radius:999px;padding:11px 12px 11px 20px;font-size:16px;box-shadow:0 14px 30px rgba(25,29,32,.25)}
  .undo span{background:${PALETTE.ground};color:${PALETTE.ink};border-radius:999px;padding:6px 14px;font-weight:600}
  .demo{position:absolute;right:58px;bottom:14px;font-size:12px;color:${PALETTE.ink2};opacity:.8}</style>
  <div class="copy">
    <div class="mono k">Cairn 2.0 · self-hosted wellness OS</div>
    <h1>Stronger, lighter, and <em>${wordFor(d.race.weeks)} weeks</em> from race day.</h1>
    <p class="sub">Lifts, runs, food, sleep and labs read as one picture. A coaching team makes the next call. You keep Undo.</p>
  </div>
  <div class="brand">${MARK(46, PALETTE.ink)}Cairn<span class="mono">github.com/zilet/cairn</span></div>
  <div class="phone"><img src="${pathToFileURL(phonePng).href}"></div>
  <div class="card squat">
    <div class="mono">Back squat · top set × ${d.reps}</div>
    <div class="big">${first.topWeight} → ${last.topWeight} <small>${esc(d.unit)}</small></div>
    ${squatSvg(d.steps, 344, 108)}
    <div class="note"><b>${wordFor(d.steps.length - 1)} earned steps</b> while bodyweight came down ${lost} ${esc(d.unit)}</div>
  </div>
  <div class="undo">Team: Back Squat ${d.steps.at(-2)?.topWeight} → ${last.topWeight} ${esc(d.unit)}<span>↺ Undo</span></div>
  <div class="card race">
    <div class="mono">${esc(d.race.event || "Race")} · ${shortDate(d.race.date)}</div>
    <div class="big" style="font-size:30px;margin-bottom:26px">Sized to what you've run</div>
    ${ladderSvg(d.ladder, d.floorKm, 382, 104)}
    <div class="legend"><span><i style="background:${PALETTE.ink}"></i>run</span><span><i style="background:${PALETTE.ink}2e"></i>planned</span><span><i style="background:${PALETTE.dawn}"></i>peak ${d.ladder.find((l) => l.kind === "peak")?.km} km</span><span><i style="border:2px dashed ${PALETTE.dawn};box-sizing:border-box"></i>race week</span></div>
  </div>
  <div class="demo">Fictional demo persona · no real health data</div>`;
}

async function renderSocial(cdp, base, work) {
  await setup(cdp);
  await navigate(cdp, `${base}/app/today`);
  await waitForView(cdp, "today");
  await sleep(2200);
  const phonePng = path.join(work, "social-phone.png");
  writeFileSync(phonePng, Buffer.from((await cdp.command("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const data = await socialData(base);
  const target = path.join(OUT, "social-preview.png");
  await renderHtml(cdp, socialHtml(data, phonePng), target, { width: 1280, height: 640 });
  console.log(`✓ social: ${path.relative(root, target)}`);
}

// ---------- probe mode ----------
async function probe(cdp, base, route) {
  await navigate(cdp, `${base}${route}`);
  await waitForView(cdp, null);
  await sleep(1500);
  const controls = await evaluate(
    cdp,
    `[...document.querySelectorAll("button, a, [role=button], [data-action], [data-stone-id], [data-stone]")]
      .filter((n) => n.getClientRects().length)
      .map((n) => [n.tagName.toLowerCase(), n.className && String(n.className).slice(0, 60), [...n.attributes].filter((a) => a.name.startsWith("data-")).map((a) => a.name + "=" + a.value).join(" ").slice(0, 90), n.textContent.trim().replace(/\\s+/g, " ").slice(0, 50)].join(" | "))`
  );
  const scroll = await evaluate(cdp, `(() => { const se = document.scrollingElement; return { doc: se.scrollHeight, inner: innerHeight, tab: window.state && window.state.tab }; })()`);
  console.log(JSON.stringify(scroll));
  if (args.api) console.log((await (await fetch(`${base}${args.api}`)).text()).slice(0, 1500));
  for (const c of controls || []) console.log("  " + c);
}

// ---------- main ----------
async function main() {
  if (!existsSync(serverEntry)) throw new Error(`${serverEntry} is missing: run \`npm run build\` first`);
  for (const bin of ["ffmpeg"]) {
    if (spawnSync(bin, ["-version"]).status !== 0) throw new Error(`${bin} not found`);
  }
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "cairn-promo-"));
  const agentsDir = path.join(work, "agents");
  mkdirSync(agentsDir);
  let server = null;
  let chrome = null;
  let cdp = null;
  try {
    server = await startBuiltServer({
      label: "promo",
      extraEnv: { AGENTS_CONFIG: writeOfflineAgentsConfig(agentsDir, "cairn-promo-offline"), CAIRN_SEED_DEMO: "1" },
    });
    console.log(`Cairn promo: server on ${server.base} (demo seed, offline agents)`);
    if (!(await seedDemoRace(server.base))) console.warn("  ! could not set the demo race");
    seedTeamChange(server.dir);
    seedLunch(path.join(server.dir, "cairn-smoke.db"));
    chrome = await launchChrome({ windowSize: `${WIDTH},${HEIGHT}`, profilePrefix: "cairn-promo-" });
    cdp = await openPage(chrome);
    await setup(cdp);

    if (args.probe) {
      await probe(cdp, server.base, args.probe);
      return;
    }
    if (args.flags.has("social")) {
      await renderSocial(cdp, server.base, work);
      return;
    }

    const clips = ONLY.length ? CLIPS.filter((c) => ONLY.includes(c.name)) : CLIPS;
    const clipDir = path.join(OUT, "clips");
    mkdirSync(clipDir, { recursive: true });
    const masters = {};
    for (const clip of clips) {
      await setup(cdp);
      const list = await recordClip(cdp, server.base, clip, work);
      const mp4 = path.join(work, `${clip.name}.mp4`);
      encodeClip(list, mp4);
      masters[clip.name] = mp4;
      encodeGif(mp4, path.join(clipDir, `${clip.name}.gif`));
      ffmpeg(["-i", mp4, "-c", "copy", path.join(clipDir, `${clip.name}.mp4`)], `${clip.name} copy`);
    }

    if (ONLY.length) return;

    // Title cards, phone-sized, then the hero cut: open card → (card, clip)… → close card.
    const cardFor = async (name, spec) => {
      const png = path.join(work, `card-${name}.png`);
      await renderHtml(cdp, cardHtml({ ...spec, width: WIDTH * DPR, height: HEIGHT * DPR }), png, { width: WIDTH * DPR, height: HEIGHT * DPR });
      const mp4 = path.join(work, `card-${name}.mp4`);
      ffmpeg(["-loop", "1", "-t", String(spec.seconds || 2.2), "-i", png, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", mp4], `card ${name}`);
      return mp4;
    };
    const open = await cardFor("open", { mark: true, title: "Cairn 2.0", sub: "A coach that has already read your whole day.", seconds: 2.6 });
    const close = await cardFor("close", { mark: true, title: "Your data. Your hardware. Your call.", sub: "Self-hosted · MIT · github.com/zilet/cairn", seconds: 3 });
    const beatsFor = {};
    for (const [name, seconds] of HERO) {
      const clip = CLIPS.find((c) => c.name === name);
      if (!masters[name]) continue;
      const cut = path.join(work, `cut-${name}.mp4`);
      ffmpeg(["-t", String(seconds), "-i", masters[name], "-c:v", "libx264", "-crf", "20", "-vf", "fps=30,format=yuv420p", cut], `cut ${name}`);
      beatsFor[name] = [await cardFor(name, { title: clip.title, sub: clip.sub, seconds: 2 }), cut];
    }
    const heroMp4 = path.join(OUT, "cairn-hero.mp4");
    xfadeJoin([open, ...HERO.flatMap(([name]) => beatsFor[name] || []), close], heroMp4);
    // The README GIF is the short cut: three beats keep it light enough to load inline.
    const gifCut = path.join(work, "hero-short.mp4");
    xfadeJoin([open, ...HERO_GIF.flatMap((name) => beatsFor[name] || []), close], gifCut);
    encodeGif(gifCut, path.join(OUT, "cairn-hero.gif"), { width: 270, fps: 10 });
    console.log(`✓ hero: ${path.relative(root, heroMp4)}`);

    // The 16:9 trailer: each hero beat as captions + the phone playing the clip.
    const mask = path.join(work, "phone-mask.png");
    await renderHtml(cdp, phoneMaskHtml(), mask, { width: TRAILER.w, height: TRAILER.h });
    const beats = [];
    const total = HERO.length;
    for (const [index, [name, seconds]] of HERO.entries()) {
      const clip = CLIPS.find((c) => c.name === name);
      if (!masters[name]) continue;
      const bg = path.join(work, `trailer-${name}.png`);
      await renderHtml(cdp, trailerHtml({ kicker: `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, title: clip.title, sub: clip.sub }), bg, { width: TRAILER.w, height: TRAILER.h });
      const beat = path.join(work, `beat-${name}.mp4`);
      ffmpeg(
        ["-loop", "1", "-i", bg, "-t", String(seconds), "-i", masters[name], "-loop", "1", "-i", mask, "-filter_complex",
          `[1:v]scale=${TRAILER.phoneW}:${TRAILER.phoneH},pad=${TRAILER.w}:${TRAILER.h}:${TRAILER.phoneX}:${TRAILER.phoneY}:black[ph];` +
          `[2:v]format=gray[m];[ph][m]alphamerge[pm];[0:v][pm]overlay=0:0:shortest=1,fps=30,format=yuv420p`,
          "-t", String(seconds), "-c:v", "libx264", "-crf", "20", beat],
        `beat ${name}`
      );
      beats.push(beat);
    }
    const tOpen = path.join(work, "trailer-open.png");
    await renderHtml(cdp, cardHtml({ mark: true, kicker: "Self-hosted wellness OS", title: "Cairn 2.0", sub: "A coach that has already read your whole day — and has one honest thing to say.", width: TRAILER.w, height: TRAILER.h }), tOpen, { width: TRAILER.w, height: TRAILER.h });
    const tClose = path.join(work, "trailer-close.png");
    await renderHtml(cdp, cardHtml({ mark: true, kicker: "MIT · runs on a Raspberry Pi", title: "Your data. Your hardware. Your call.", sub: "github.com/zilet/cairn", width: TRAILER.w, height: TRAILER.h }), tClose, { width: TRAILER.w, height: TRAILER.h });
    const still = (png, seconds, name) => {
      const mp4 = path.join(work, `${name}.mp4`);
      ffmpeg(["-loop", "1", "-t", String(seconds), "-i", png, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", mp4], name);
      return mp4;
    };
    const trailer = path.join(OUT, "cairn-v2-trailer.mp4");
    xfadeJoin([still(tOpen, 3.2, "t-open"), ...beats, still(tClose, 3.6, "t-close")], trailer);
    await renderSocial(cdp, server.base, work);
    console.log(`✓ trailer: ${path.relative(root, trailer)}`);
  } catch (error) {
    if (server) error.serverLog = server.serverLog();
    throw error;
  } finally {
    if (cdp) cdp.close();
    await stopChrome(chrome);
    if (server) await stopServer(server);
    if (!args.flags.has("keep")) rmSync(work, { recursive: true, force: true });
    else console.log(`(work kept: ${work})`);
  }
}

/** Join same-sized 30fps segments with a short crossfade between each. */
function xfadeJoin(segments, target, fade = 0.45) {
  const durations = segments.map((file) => {
    const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
    return Number(r.stdout.trim()) || 0;
  });
  if (segments.length === 1) {
    ffmpeg(["-i", segments[0], "-c", "copy", target], "single");
    return;
  }
  const inputs = segments.flatMap((file) => ["-i", file]);
  let chain = "";
  let prev = "[0:v]";
  let offset = 0;
  for (let i = 1; i < segments.length; i++) {
    offset += durations[i - 1] - fade;
    const out = i === segments.length - 1 ? "[v]" : `[x${i}]`;
    chain += `${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${out};`;
    prev = out;
  }
  ffmpeg([...inputs, "-filter_complex", chain.replace(/;$/, ""), "-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "21",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", target], path.basename(target));
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`x promo failed: ${error.message}`);
  if (error.serverLog) console.error(tail(error.serverLog));
  exitCode = 1;
}
process.exit(exitCode);
