import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Loads capture.ts (04-capture.js) plus the voice module ahead of it, matching
// real bundle-03 load order, with the effortless-capture surfaces (frequents,
// check-in, voice) stubbed just enough to exercise their wiring.
function loadCapture(overrides = {}) {
  // CairnCaptureVoice is set up BY capture-voice-client.js itself, so a caller
  // wanting to stub it (to assert what setupVoiceCapture passes in) has to
  // apply that override AFTER that module runs — otherwise the real module
  // clobbers it right back, matching real bundle-03 load order.
  const { CairnCaptureVoice: captureVoiceOverride, ...rest } = overrides;
  const context = {
    Date,
    Number,
    String,
    Array,
    Math,
    isNaN,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
    art: (_kind, name) => `<span class="art">${escHtml(name)}</span>`,
    localISO: () => "2026-08-24",
    enrichmentActive: () => false,
    pollEnrichment: () => {},
    reshapeToday: async () => {},
    state: { tab: "today" },
    view: { querySelector: () => null },
    ...rest,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-voice-client.js"), "utf8"), context);
  if (captureVoiceOverride) {
    context.CairnCaptureVoice = captureVoiceOverride;
    context.window.CairnCaptureVoice = captureVoiceOverride;
  }
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-provenance-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-date-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-cards-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-jobs-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-reads-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/04-capture.js"), "utf8"), context);
  return context;
}

function elementStub(overrides = {}) {
  const listeners = {};
  return {
    innerHTML: "",
    isConnected: true,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    _listeners: listeners,
    ...overrides,
  };
}

test("loadFrequentFoods stays quiet when there are no frequents for this time of day", async () => {
  const wrap = elementStub();
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#freqFoods" ? wrap : null) },
    api: async () => [],
  });

  await capture.loadFrequentFoods();

  assert.equal(wrap.innerHTML, "");
});

test("loadFrequentFoods renders one-tap chips for foods logged near this time of day", async () => {
  const wrap = elementStub();
  const clicked = [];
  wrap.querySelectorAll = (sel) =>
    sel === "[data-freq]" ? [{ dataset: { freq: "oats and berries" }, addEventListener: (_t, h) => clicked.push(h) }] : [];
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#freqFoods" ? wrap : null) },
    api: async () => [{ summary: "oats and berries", kcal: 410 }],
  });

  await capture.loadFrequentFoods();

  assert.match(wrap.innerHTML, /Usual around now/);
  assert.match(wrap.innerHTML, /data-freq="oats and berries"/);
  assert.match(wrap.innerHTML, /410/);
});

test("check-in slot offers a one-tap ask when nothing is logged for today", async () => {
  const open = elementStub();
  const slot = elementStub({ querySelector: (sel) => (sel === "#checkinOpen" ? open : null) });
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => null,
  });

  await capture.loadCheckin();

  assert.match(slot.innerHTML, /how are you feeling\?/);
  assert.equal(typeof open._listeners.click, "function");
});

test("check-in slot shows the noted line once mood or energy is already logged today", async () => {
  const slot = elementStub();
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => ({ mood: 4, energy: 3 }),
  });

  await capture.loadCheckin();

  assert.match(slot.innerHTML, /mood 4\/5/);
  assert.match(slot.innerHTML, /energy 3\/5/);
});

test("tapping a feel-dot writes the check-in through the existing /checkins endpoint", async () => {
  // Drive the whole ambient flow through the exported entry points (loadCheckin
  // -> tap "how are you feeling?" -> tap a feel-dot) rather than reaching for
  // the unexported render helper directly, so this exercises the real wiring.
  const dot = elementStub({ dataset: { feel: "mood", val: "4" } });
  const open = elementStub();
  const slot = elementStub({
    querySelector: (sel) => (sel === "#checkinOpen" ? open : null),
  });
  const calls = [];
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    // loadCheckin's own GET lookup (no opts) must see nothing logged yet, so it
    // draws the ask rather than the "noted" line; only the POST write is recorded.
    api: async (path, opts) => {
      if (!opts) return null;
      calls.push([path, opts]);
      return { mood: 4, error: false };
    },
  });

  await capture.loadCheckin(); // draws the "how are you feeling?" ask, wires #checkinOpen
  // Once tapped, renderCheckinForm re-renders the slot and wires every .feel-dot
  // it drew — swap querySelectorAll to hand back our fake dot at that point.
  slot.querySelectorAll = (sel) => (sel === ".feel-dot" ? [dot] : []);
  await open._listeners.click();
  await dot._listeners.click();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/checkins");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { mood: 4 });
});

test("setupVoiceCapture mounts on the chat composer's mic/input pair, not Today's dead #qlMic/#qlInput", () => {
  const mic = { hidden: true };
  const input = {};
  const setupCalls = [];
  const capture = loadCapture({
    view: {
      querySelector: (sel) => {
        if (sel === "#chatMic") return mic;
        if (sel === "#chatInput") return input;
        return null;
      },
    },
    CairnCaptureVoice: { micGlyph: "<svg/>", setup: (deps) => setupCalls.push(deps) },
  });

  capture.setupVoiceCapture();

  assert.equal(setupCalls.length, 1);
  assert.equal(setupCalls[0].mic, mic);
  assert.equal(setupCalls[0].input, input);
});

test("setupVoiceCapture no-ops quietly on a surface that doesn't render #chatMic/#chatInput", () => {
  const setupCalls = [];
  const capture = loadCapture({
    view: { querySelector: () => null },
    CairnCaptureVoice: { micGlyph: "<svg/>", setup: (deps) => setupCalls.push(deps) },
  });

  assert.doesNotThrow(() => capture.setupVoiceCapture());
  assert.equal(setupCalls.length, 0);
});

test("Today post-render wiring surfaces frequents and check-in again (no longer dead wiring)", () => {
  const context = { Object, String, Number };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(
    readFileSync(join(root, "public/js/today-post-render-wiring.js"), "utf8"),
    context
  );

  const calls = [];
  const noopEl = { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const deps = {
    root: noopEl,
    state: {},
    read: null,
    isToday: true,
    showPlan: false,
    soft: false,
    conductorLeads: true,
    agenda: null,
    agendaGeneric: [],
    updateHeaderCondense() {},
    runCountUps() {},
    reducedMotion: () => false,
    wireCardioSync() {},
    renderToday() {},
    applyDayProgression() {},
    wireBrief() {},
    upgradeBriefInPlace() {},
    loadTrainingProvenance() {},
    loadTableHint() {},
    setupWeightChip() {},
    loadFrequentFoods: () => calls.push("loadFrequentFoods"),
    loadContextBanner() {},
    loadHealthFocusBanner() {},
    loadWearable() {},
    loadCheckin: () => calls.push("loadCheckin"),
    loadTagChips: () => calls.push("loadTagChips"),
    runAgendaRail() {},
    runFallbackRail() {},
    todayRailDeps: () => ({}),
    activateTab() {},
    withViewTransition: (fn) => fn(),
    viewEnter() {},
    localISO: () => "2026-08-24",
    toast() {},
  };

  context.CairnTodayPostRenderWiring.wirePostRender(deps);

  assert.deepEqual(calls, ["loadFrequentFoods", "loadCheckin", "loadTagChips"]);
});
