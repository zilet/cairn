// The viewport probe (app/viewport-probe.ts): REPORT-ONLY evidence for the blank Session
// screen / adrift rest bar on an installed iPhone PWA. The decision is pure; the sampler
// only reads and reports through the client diagnostics pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDocument, createFakeTimers, createHost, fire, loadClientModule } from "./_dom.mjs";
import { parseClientDiagnosticBatch } from "../dist/repo/diagnostics.js";

const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const { viewportAnomalies, createAnomalyLimiter } = loadClientModule("app-viewport-probe").CairnViewportProbe;

// A healthy phone, keyboard down, Session on screen, rest bar parked at the bottom.
const healthy = (over = {}) => ({
  visible: true,
  softKeyboard: true,
  textFocused: false,
  msSinceFocusout: null,
  scale: 1,
  offsetTop: 0,
  visTop: 0,
  vvb: 0,
  standalone: true,
  vvHeight: 844,
  vvMax: 844,
  threshold: 127,
  kbUp: false,
  sessionSurface: true,
  centerBlank: false,
  quarterBlank: false,
  sessInBand: true,
  restShown: true,
  rest: { top: 730, bottom: 790 },
  band: { top: 0, bottom: 844 },
  ...over,
});

test("a healthy keyboard-down state reports nothing", () => {
  same(viewportAnomalies(healthy()), []);
});

test("a healthy keyboard-up state reports nothing (the rest bar steps away, the viewport is shorter)", () => {
  same(
    viewportAnomalies(
      healthy({ textFocused: true, kbUp: true, vvHeight: 500, offsetTop: 300, visTop: 0, restShown: false, rest: null, band: { top: 0, bottom: 500 } }),
    ),
    [],
  );
});

test("a pinch-zoomed page and a desktop are never flagged", () => {
  // Zoom shrinks the visual viewport exactly like a keyboard; scale says so.
  same(viewportAnomalies(healthy({ scale: 2.4, vvHeight: 400, offsetTop: 120, visTop: 120, restShown: false, rest: null, band: { top: 120, bottom: 520 } })), []);
  same(viewportAnomalies(healthy({ softKeyboard: false, offsetTop: 300, sessInBand: false, kbUp: true })), []);
  same(viewportAnomalies(healthy({ visible: false, offsetTop: 300, sessInBand: false })), []);
});

test("blank_surface: the Session exists but nothing of it is on screen", () => {
  same(viewportAnomalies(healthy({ centerBlank: true, quarterBlank: true })), ["blank_surface"]);
  same(viewportAnomalies(healthy({ sessInBand: false })), ["blank_surface"]);
  // One blank point alone is a gap between cards, not a blank screen.
  same(viewportAnomalies(healthy({ centerBlank: true })), []);
  // No Session surface: nothing to be blank.
  same(viewportAnomalies(healthy({ sessionSurface: false, centerBlank: true, quarterBlank: true, sessInBand: true })), []);
});

test("viewport_stuck: no field, keyboard had time to go, yet the viewport is still displaced or short", () => {
  same(viewportAnomalies(healthy({ offsetTop: 268 })), ["viewport_stuck"]);
  same(viewportAnomalies(healthy({ visTop: 268 })), ["viewport_stuck"]);
  same(viewportAnomalies(healthy({ vvb: 60 })), ["viewport_stuck"]);
  same(viewportAnomalies(healthy({ vvb: 60, standalone: false })), [], "a Safari toolbar legitimately lifts --vvb");
  same(viewportAnomalies(healthy({ vvHeight: 560, band: { top: 0, bottom: 560 }, rest: { top: 450, bottom: 510 } })), ["viewport_stuck"]);
  // The keyboard is still on its way down: not yet.
  same(viewportAnomalies(healthy({ offsetTop: 268, msSinceFocusout: 400 })), []);
  same(viewportAnomalies(healthy({ offsetTop: 268, msSinceFocusout: 1200 })), ["viewport_stuck"]);
  // With a field focused the viewport is SUPPOSED to be displaced.
  same(viewportAnomalies(healthy({ offsetTop: 268, textFocused: true })), []);
});

test("rest_bar_adrift: shown, yet not pinned in the bottom third of the visible band", () => {
  same(viewportAnomalies(healthy({ rest: { top: 120, bottom: 180 } })), ["rest_bar_adrift"]);
  same(viewportAnomalies(healthy({ rest: { top: 800, bottom: 900 } })), ["rest_bar_adrift"], "hangs below the band");
  same(viewportAnomalies(healthy({ rest: { top: -90, bottom: -30 } })), ["rest_bar_adrift"], "wholly above it");
  // Not shown (hidden by kb-up, or not running): never adrift.
  same(viewportAnomalies(healthy({ restShown: false, rest: { top: 120, bottom: 180 } })), []);
});

test("kb_up_stale: html.kb-up with no text field focused", () => {
  same(viewportAnomalies(healthy({ kbUp: true })), ["kb_up_stale"]);
  same(viewportAnomalies(healthy({ kbUp: true, msSinceFocusout: 300 })), [], "still settling");
  same(viewportAnomalies(healthy({ kbUp: true, textFocused: true })), []);
});

test("the limiter admits a code once a minute and six reports a page life", () => {
  const limiter = createAnomalyLimiter();
  same(limiter.admit(["viewport_stuck", "kb_up_stale"], 0), ["viewport_stuck", "kb_up_stale"]);
  same(limiter.admit(["viewport_stuck"], 30_000), [], "same code inside a minute");
  same(limiter.admit(["viewport_stuck", "blank_surface"], 30_001), ["blank_surface"], "only the new code");
  same(limiter.admit(["viewport_stuck"], 60_000), ["viewport_stuck"], "a minute later it may speak again");
  const flood = createAnomalyLimiter();
  let sent = 0;
  for (let i = 0; i < 40; i++) if (flood.admit(["viewport_stuck"], i * 61_000).length) sent += 1;
  assert.equal(sent, 6);
});

test("the sampler reports a blank Session once, with metadata only, and writes nothing", () => {
  const timers = createFakeTimers();
  const document = createDocument();
  const host = createHost(document, { html: '<div class="sess-dest"><input class="setfield" type="number" value="secret-77"></div>' });
  const reports = [];
  const sess = host.querySelector(".sess-dest");
  sess.getBoundingClientRect = () => ({ top: -900, bottom: -100, left: 0, right: 390, width: 390, height: 800 });
  document.elementFromPoint = () => null;
  document.visibilityState = "visible";
  const win = loadClientModule(["app-viewport-probe", "app-mobile-viewport"], {
    document,
    globals: {
      ...timers,
      innerHeight: 844,
      scrollY: 0,
      navigator: {},
      matchMedia: () => ({ matches: false }),
      getComputedStyle: () => ({ display: "block", visibility: "visible", position: "static", overflowY: "visible" }),
      visualViewport: { width: 390, height: 844, offsetTop: 0, pageTop: 0, scale: 1, addEventListener() {} },
      state: { tab: "session" },
      CairnClientDiagnostics: { report: (r) => (reports.push(r), true) },
    },
  });
  win.installMobileViewportGuards();
  fire(win, "pageshow");
  timers.tick(1100);
  assert.equal(reports.length, 1, "one report");
  const r = reports[0];
  assert.equal(r.kind, "viewport_anomaly");
  assert.equal(r.level, "warning");
  assert.match(r.viewport.codes, /blank_surface/);
  assert.match(r.viewport.vv, /^390 844 0 0 100$/);
  assert.doesNotMatch(JSON.stringify(r), /secret-77/, "no field value ever travels");
  assert.equal(document.documentElement.classList.contains("kb-up"), false, "no class written");
  fire(win, "pageshow");
  timers.tick(1100);
  assert.equal(reports.length, 1, "the same code is not reported again inside a minute");
});

test("the probe's sampler reads only: no class, style, scroll or focus write", () => {
  const src = readFileSync(new URL("../src/client/app/viewport-probe.ts", import.meta.url), "utf8");
  const start = src.indexOf("function installViewportProbe");
  const end = src.indexOf("Object.assign(globalThis");
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /classList\.(add|remove|toggle|replace)|\.style\.(setProperty|removeProperty)|\.style\.\w+\s*=|scroll(By|To|IntoView)\b|\.focus\(|\.blur\(|innerHTML|setAttribute|\.remove\(/);
});

// ---------- the pipeline ----------

test("the diagnostics pipeline carries the viewport payload and the server keeps only allowlisted scalars", () => {
  const { createClientDiagnosticReporter } = loadClientModule("client-diagnostics", { globals: { setTimeout: () => 0 } }).CairnClientDiagnosticsCore;
  const store = new Map();
  const reporter = createClientDiagnosticReporter({
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    fetch: async () => ({ status: 204 }),
    schedule: () => 0,
    tab: () => "session",
  });
  const viewport = { codes: "viewport_stuck", vv: "w390 h560 ot268 pt268 s1.00", standalone: true, ignored: "x", hit: "html" };
  assert.equal(reporter.report({ kind: "viewport_anomaly", level: "warning", message: "viewport anomaly viewport_stuck", viewport }), true);
  const [queued] = reporter.pending();
  assert.equal(queued.kind, "viewport_anomaly");
  const parsed = parseClientDiagnosticBatch({ events: [queued] });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].level, "warning");
  assert.equal(parsed[0].viewport.ignored, undefined, "the server holds the key allowlist");
  assert.equal(parsed[0].viewport.codes, "viewport_stuck");
  assert.equal(parsed[0].fingerprint, "client:viewport_anomaly:viewport_stuck");
});

test("the server drops a viewport event with no known code or with free text in a field", () => {
  const ev = (viewport) => ({ kind: "viewport_anomaly", level: "warning", message: "x", fingerprint: "f", viewport });
  assert.equal(parseClientDiagnosticBatch({ events: [ev({ codes: "made_up" })] }).length, 0);
  assert.equal(parseClientDiagnosticBatch({ events: [ev(null)] }).length, 0);
  const [kept] = parseClientDiagnosticBatch({ events: [ev({ codes: "kb_up_stale", hit: "<script>alert(1)</script>", flags: "kb-up" })] });
  assert.equal(kept.viewport.hit, undefined);
  assert.equal(kept.viewport.flags, "kb-up");
});
