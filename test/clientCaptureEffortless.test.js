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
  const stub = {
    innerHTML: "",
    isConnected: true,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll: () => [],
    // The check-in's own dismiss button, captured so a test can tap it. Any other
    // lookup falls through to whatever the override supplies.
    querySelector: (sel) =>
      sel === "#checkinDismiss"
        ? { addEventListener: (_type, handler) => { stub._listeners_dismiss = handler; } }
        : null,
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    _listeners: listeners,
    ...overrides,
  };
  return stub;
}

test("capture.ts no longer exports the Today frequents surface (moved to the Chat composer)", () => {
  const capture = loadCapture();
  assert.equal(capture.loadFrequentFoods, undefined);
  assert.equal(capture.relogFrequent, undefined);
});

test("check-in slot asks the morning question in words, with three scales and no scores", async () => {
  const slot = elementStub();
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => null,
  });

  await capture.loadCheckin();

  assert.match(slot.innerHTML, /How's the body this morning\?|How are you landing today\?|How does today feel so far\?/);
  for (const field of ["energy", "sleep_feel", "soreness"]) {
    assert.match(slot.innerHTML, new RegExp(`data-feel="${field}"`), `${field} is collectable`);
  }
  // Every dot means a WORD — the number only ever rides as the stored value.
  assert.match(slot.innerHTML, /aria-label="energy: strong"/);
  assert.match(slot.innerHTML, /aria-label="sleep: barely slept"/);
  assert.match(slot.innerHTML, /aria-label="soreness: a little sore"/);
  assert.doesNotMatch(slot.innerHTML, /\/5/);
});

test("check-in slot speaks an answered day back in words, never as n/5", async () => {
  const slot = elementStub();
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => ({ energy: 5, sleep_feel: 4, soreness: 2 }),
  });

  await capture.loadCheckin();

  assert.match(slot.innerHTML, /feeling strong · slept well · a little sore/);
  assert.doesNotMatch(slot.innerHTML, /\/5/);
  assert.doesNotMatch(slot.innerHTML, /data-feel/, "an answered day stops asking");
});

test("check-in slot stays silent for the rest of a day it was waved off", async () => {
  const store = new Map();
  const slot = elementStub();
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => null,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
  });

  await capture.loadCheckin();
  const dismiss = slot._listeners_dismiss;
  assert.equal(typeof dismiss, "function");
  dismiss();
  assert.equal(slot.innerHTML, "");

  await capture.loadCheckin();
  assert.equal(slot.innerHTML, "", "and it does not come back the same morning");
});

test("tapping the word-scales writes energy, sleep and soreness through the existing /checkins endpoint", async () => {
  // Drive the real wiring: loadCheckin draws the row, then a tap on each scale.
  const dots = [
    elementStub({ dataset: { feel: "energy", val: "4" } }),
    elementStub({ dataset: { feel: "sleep_feel", val: "5" } }),
    elementStub({ dataset: { feel: "soreness", val: "2" } }),
  ];
  const slot = elementStub({ querySelectorAll: (sel) => (sel === ".feel-dot" ? dots : []) });
  const calls = [];
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    // loadCheckin's own GET lookup (no opts) must see nothing logged yet, so it
    // draws the scales; only the POST writes are recorded.
    api: async (path, opts) => {
      if (!opts) return null;
      calls.push([path, opts]);
      return { energy: 4, sleep_feel: 5, soreness: 2, error: false };
    },
  });

  await capture.loadCheckin();
  for (const dot of dots) await dot._listeners.click();

  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], "/checkins");
  assert.equal(calls[0][1].method, "POST");
  // Each tap sends everything answered so far; the last carries all three fields.
  assert.deepEqual(JSON.parse(calls[0][1].body), { energy: 4 });
  assert.deepEqual(JSON.parse(calls[2][1].body), { energy: 4, sleep_feel: 5, soreness: 2 });
});

// A slot whose innerHTML write really replaces its children: `.feel-dot` lookups
// only answer while the form markup is actually mounted. Without that, a test
// holding dot stubs outside the slot keeps tapping a row the code already tore
// down — which is exactly how the one-tap collapse hid for as long as it did.
function checkinSlotStub(dots) {
  let html = "";
  const stub = elementStub({
    querySelectorAll: (sel) => (sel === ".feel-dot" && /data-feel=/.test(html) ? dots : []),
    querySelector: (sel) => {
      if (sel === "#checkinDismiss") {
        return { addEventListener: (_type, handler) => { stub._listeners_dismiss = handler; } };
      }
      // The inline word echo the tap writes into the answered row. Standing in for
      // a real node means an in-place DOM write shows up in the slot's markup, the
      // way it does in a browser.
      const said = /^\[data-said="([^"]+)"\]$/.exec(sel);
      if (said && html.includes(`data-said="${said[1]}"`)) {
        return {
          set innerHTML(value) {
            html = html.replace(`data-said="${said[1]}"></span>`, `data-said="${said[1]}">${value}</span>`);
          },
        };
      }
      return null;
    },
  });
  Object.defineProperty(stub, "innerHTML", {
    get: () => html,
    set: (value) => { html = String(value ?? ""); },
    configurable: true,
  });
  return stub;
}

test("one tap does not collapse the check-in — the other scales stay askable", async () => {
  const dots = [
    elementStub({ dataset: { feel: "energy", val: "4" } }),
    elementStub({ dataset: { feel: "sleep_feel", val: "5" } }),
    elementStub({ dataset: { feel: "soreness", val: "2" } }),
  ];
  const slot = checkinSlotStub(dots);
  const posts = [];
  let row = null;
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    toast: () => {},
    api: async (path, opts) => {
      if (!opts) return row; // the GET lookup — answers with whatever is stored
      posts.push(JSON.parse(opts.body));
      row = { ...JSON.parse(opts.body), error: false };
      return row;
    },
  });

  await capture.loadCheckin();
  assert.match(slot.innerHTML, /data-feel="soreness"/);

  await dots[0]._listeners.click();
  assert.match(slot.innerHTML, /data-feel="sleep_feel"/, "the form node survives the first tap");
  assert.match(slot.innerHTML, /data-feel="soreness"/);
  assert.doesNotMatch(slot.innerHTML, /checkin-done/, "and it has not jumped to the answered line");
  // The answered scale says its word inline — never a number.
  assert.match(slot.innerHTML, /feeling good/);
  assert.doesNotMatch(slot.innerHTML, /\/5/);

  // A repaint mid-answer (reshapeToday -> loadCheckin) sees a row already
  // carrying energy, and must still re-ask the two scales that are open.
  await capture.loadCheckin();
  assert.match(slot.innerHTML, /data-feel="sleep_feel"/, "a repaint re-asks the unanswered scales");
  assert.doesNotMatch(slot.innerHTML, /checkin-done/);
  assert.match(slot.innerHTML, /feeling good/, "and remembers what was already said");

  // The second and third taps still land.
  await dots[1]._listeners.click();
  assert.match(slot.innerHTML, /data-feel="soreness"/);
  await dots[2]._listeners.click();

  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2], { energy: 4, sleep_feel: 5, soreness: 2 });
  assert.match(slot.innerHTML, /feeling good · slept deeply · a little sore/, "all three answered ends in the sentence");
  assert.doesNotMatch(slot.innerHTML, /data-feel/, "and only then does it stop asking");
});

test("waving off a half-answered check-in keeps what was already said", async () => {
  const dots = [elementStub({ dataset: { feel: "energy", val: "5" } })];
  const slot = checkinSlotStub(dots);
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    toast: () => {},
    api: async (_path, opts) => (opts ? { energy: 5, error: false } : null),
  });

  await capture.loadCheckin();
  await dots[0]._listeners.click();
  slot._listeners_dismiss();

  assert.match(slot.innerHTML, /feeling strong/);
  assert.doesNotMatch(slot.innerHTML, /data-feel/);
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

test("Today post-render wiring surfaces the check-in and tag chips (frequents live in Chat now)", () => {
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

  assert.deepEqual(calls, ["loadCheckin", "loadTagChips"]);
});
