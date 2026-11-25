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
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-checkin-client.js"), "utf8"), context);
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
  // Dated to the morning asked, so a replay never lands on another day.
  assert.deepEqual(JSON.parse(calls[0][1].body), { date: "2026-08-24", energy: 4 });
  assert.deepEqual(JSON.parse(calls[2][1].body), { date: "2026-08-24", energy: 4, sleep_feel: 5, soreness: 2 });
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
    api: async (_path, opts) => {
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
  assert.deepEqual(posts[2], { date: "2026-08-24", energy: 4, sleep_feel: 5, soreness: 2 });
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

// ---------- the check-in answers in the same frame and never rebuilds Today ----------

test("check-in taps never rebuild Today: no reshapeToday, the Brief is reconciled in place once", async () => {
  const dots = [
    elementStub({ dataset: { feel: "energy", val: "4" } }),
    elementStub({ dataset: { feel: "sleep_feel", val: "2" } }),
    elementStub({ dataset: { feel: "soreness", val: "1" } }),
  ];
  const slot = checkinSlotStub(dots);
  const posts = [];
  let reshapes = 0;
  const refreshes = [];
  const timers = [];
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    toast: () => {},
    reshapeToday: async () => { reshapes += 1; },
    refreshTodayBrief: async () => { refreshes.push(true); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    api: async (_path, opts) => {
      if (!opts) return null;
      posts.push(JSON.parse(opts.body));
      return { ...JSON.parse(opts.body), error: false };
    },
  });
  await capture.loadCheckin();
  // Three taps in the same moment, none awaited — the athlete's thumb, not a test loop.
  const saves = dots.map((dot) => dot._listeners.click());
  assert.match(slot.innerHTML, /feeling good · slept rough · nothing sore/, "folds into the sentence at once");
  await Promise.all(saves);

  assert.equal(reshapes, 0, "a tap never rebuilds Today");
  assert.ok(posts.length <= 2, "taps landing while a save is out fold into the next save");
  assert.deepEqual(
    posts.at(-1),
    { date: "2026-08-24", energy: 4, sleep_feel: 2, soreness: 1 },
    "the last save carries the whole answer, dated to the day it was asked"
  );
  const refresh = timers.find((t) => t.ms < 1000);
  assert.ok(refresh, "the Brief refresh is scheduled a beat after the answer settles");
  refresh.fn();
  assert.equal(refreshes.length, 1, "and it is the in-place Brief refresh");
});

test("a check-in on a dead connection queues in the outbox; a refusal puts the marks back", async () => {
  const dots = [elementStub({ dataset: { feel: "energy", val: "2" } })];
  const slot = checkinSlotStub(dots);
  const queued = [];
  const toasts = [];
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    toast: (m) => toasts.push(m),
    CairnApiCache: { isTransientApiFailure: (e) => e && e.kind === "network" },
    outboxEnqueue: async (kind, path, body) => { queued.push({ kind, path, body }); return { id: "q1" }; },
    api: async (_path, opts) => {
      if (!opts) return null;
      throw { kind: "network" };
    },
  });
  await capture.loadCheckin();
  await dots[0]._listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(queued)), [{ kind: "checkin", path: "/checkins", body: { date: "2026-08-24", energy: 2 } }]);
  assert.match(slot.innerHTML, /low energy/, "the answer stands on screen — it syncs on reconnect");
  assert.deepEqual(toasts, []);

  const refusedDots = [elementStub({ dataset: { feel: "energy", val: "5" } })];
  const refusedSlot = checkinSlotStub(refusedDots);
  const refused = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? refusedSlot : null) },
    toast: (m) => toasts.push(m),
    CairnApiCache: { isTransientApiFailure: () => false },
    api: async (_path, opts) => {
      if (!opts) return null;
      throw { kind: "http", status: 400 };
    },
  });
  await refused.loadCheckin();
  await refusedDots[0]._listeners.click();
  assert.deepEqual(toasts, ["Couldn't save that — try again."]);
  assert.doesNotMatch(refusedSlot.innerHTML, /feeling strong/, "the unsaved word is taken back");
});

test("the check-in line paints in the Brief's own frame from what this device last knew today", async () => {
  const slot = checkinSlotStub([]);
  const store = new Map([["cairn.checkin.paint.v1", JSON.stringify({ iso: "2026-08-24", answered: { energy: 4, sleep_feel: 4, soreness: 1 } })]]);
  let answer;
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    api: () => new Promise((resolve) => { answer = resolve; }),
  });
  const loading = capture.loadCheckin();
  assert.match(slot.innerHTML, /feeling good · slept well · nothing sore/, "painted before the read returns — no pop-in below the Brief");
  answer({ energy: 4, sleep_feel: 4, soreness: 1 });
  await loading;
  assert.match(slot.innerHTML, /feeling good · slept well · nothing sore/);

  // Yesterday's memo never paints on today's Brief.
  const stale = checkinSlotStub([]);
  const old = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? stale : null) },
    localStorage: { getItem: () => JSON.stringify({ iso: "2026-08-23", answered: { energy: 1 } }), setItem: () => {} },
    api: () => new Promise(() => {}),
  });
  void old.loadCheckin();
  assert.equal(stale.innerHTML, "");
});

test("a context tag chip flips in the same frame; the server settles it, a failure flips it back", async () => {
  const names = new Set();
  const attrs = {};
  const chip = {
    dataset: { tag: "travel" },
    classList: {
      contains: (n) => names.has(n),
      toggle: (n, on) => (on ? names.add(n) : names.delete(n)),
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener(_type, handler) { this.onclick = handler; },
  };
  // Today shows ONE quiet line; the tags (each with what it changes) live in a sheet.
  const opener = { addEventListener(_type, handler) { this.onclick = handler; } };
  const slot = elementStub({ querySelector: (sel) => (sel === "[data-ctx-open]" ? opener : null) });
  const sheets = [];
  let answer;
  const toasts = [];
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#tagsSlot" ? slot : null) },
    toast: (m) => toasts.push(m),
    CairnUiSheet: {
      open(options) {
        sheets.push(options);
        return { sheet: { querySelectorAll: (sel) => (sel === "[data-tag]" ? [chip] : []) } };
      },
    },
    api: (path) =>
      path === "/context-tags/vocab"
        ? Promise.resolve([{ key: "travel", label: "travel", effect: "Food targets <hold>." }])
        : path.startsWith("/context-tags?")
          ? Promise.resolve([])
          : new Promise((resolve, reject) => { answer = { resolve, reject }; }),
  });
  await capture.loadTagChips();
  assert.match(slot.innerHTML, /Something going on today\?/);
  assert.match(slot.innerHTML, /Tell the team/);
  assert.doesNotMatch(slot.innerHTML, /data-tag=/, "no chip row on Today's face");
  opener.onclick();
  assert.equal(sheets.length, 1);
  // Each tag says what it changes, escaped; the toggle is the same chip as before.
  assert.match(sheets[0].html, /data-tag="travel"/);
  assert.match(sheets[0].html, /Food targets &lt;hold&gt;\./);
  const pending = chip.onclick();
  assert.equal(names.has("tag-chip-on"), true, "on at once, before the network answers");
  assert.equal(attrs["aria-pressed"], "true");
  answer.resolve({ on: true });
  await pending;
  assert.equal(names.has("tag-chip-on"), true);

  const again = chip.onclick();
  assert.equal(names.has("tag-chip-on"), false, "off at once");
  answer.reject(new Error("offline"));
  await again;
  assert.equal(names.has("tag-chip-on"), true, "a failed toggle flips back");
  assert.deepEqual(toasts, ["Couldn't save that — try again."]);
});

test("a quiet check-in slot (the watch already measured last night) pushes nothing but stays reachable", async () => {
  let opened = null;
  const slot = elementStub({
    dataset: { quiet: "1" },
    querySelector: (sel) =>
      sel === "#checkinOpen" ? { addEventListener: (_t, h) => { opened = h; } } : null,
  });
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => null,
  });

  await capture.loadCheckin();

  assert.doesNotMatch(slot.innerHTML, /data-feel/, "no scales are pushed");
  assert.match(slot.innerHTML, /id="checkinOpen"/, "one small optional entry remains");
  assert.equal(typeof opened, "function");
  opened();
  assert.match(slot.innerHTML, /data-feel="energy"/, "tapping it opens the check-in");
});

test("a quiet check-in slot still speaks an answer already given", async () => {
  const slot = elementStub({ dataset: { quiet: "1" } });
  const capture = loadCapture({
    view: { querySelector: (sel) => (sel === "#checkinSlot" ? slot : null) },
    api: async () => ({ energy: 5, sleep_feel: 4, soreness: 2 }),
  });
  await capture.loadCheckin();
  assert.match(slot.innerHTML, /feeling strong/);
});
