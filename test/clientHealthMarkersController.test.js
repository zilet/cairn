import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadController(overrides = {}) {
  const orderCalls = [];
  const lipidNotes = [];
  const wiredCharts = [];
  const context = {
    console,
    Object,
    Set,
    Map,
    Array,
    String,
    Number,
    Promise,
    window: null,
    CairnHealthClient: {
      HEALTH_HERO_ART: "<art>",
      markersEmptyHtml: () => `<button id="hMkToRecords" type="button">Add a document</button>`,
      markerSubgroup: (group, name) => group === "lipids" && String(name).includes("LDL") ? "LDL family" : "",
      orderMarkersForDisplay: (group, list) => {
        orderCalls.push([group, list.map((marker) => marker.name)]);
        return group === "lipids" ? [...list].reverse() : list;
      },
      lipidGroupNoteHtml: (list, options) => {
        const note = `<div class="lipid-note">${options.relAge("2026-06-01")} ${list.map((marker) => marker.name).join("|")}</div>`;
        lipidNotes.push(note);
        return note;
      },
    },
    CairnHealthMarkers: {
      hmkRowHtml: (marker, index) => `<div class="hmk hmk-x" data-row="${marker.name}"><button class="hmk-row" aria-expanded="false">${index}:${marker.name}</button><svg class="hchart"></svg></div>`,
      wireMarkerChart: (svg) => { wiredCharts.push(svg); },
      markerOutOfRange: (marker) => {
        const flag = String((marker.latest || {}).flag || "").toLowerCase();
        return flag === "low" || flag === "high" || flag === "abnormal" || flag === "critical" || marker.in_optimal === false;
      },
    },
    ...overrides,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-markers-controller.js"), "utf8"), context);
  return { controller: context.CairnHealthMarkersController, orderCalls, lipidNotes, wiredCharts };
}

// A minimal DOM node fake modeling only what the controller touches: an
// innerHTML string, id-scoped querySelector, the two class-selector queries
// wireMarkerCatalog uses, classList, attributes, value, and events.
function fakeEl() {
  const listeners = new Map();
  const classes = new Set();
  const attrs = {};
  let html = "";
  let children = {};
  const rowButtons = [];
  const charts = [];
  const el = {
    isConnected: true,
    value: "",
    _focused: false,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = String(v);
      children = {};
      for (const m of html.matchAll(/id="([^"]+)"/g)) children[m[1]] = fakeEl();
      rowButtons.length = 0;
      charts.length = 0;
      if (html.includes("hmk-x")) rowButtons.push(fakeEl(), fakeEl());
      if (html.includes("hchart")) charts.push(fakeEl(), fakeEl());
    },
    classList: {
      toggle: (n, force) => { const has = classes.has(n); const next = force === undefined ? !has : !!force; next ? classes.add(n) : classes.delete(n); return next; },
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    dispatch: (t, ev) => { (listeners.get(t) || []).forEach((fn) => fn(ev || {})); },
    focus() { el._focused = true; },
    closest: () => fakeMarkerItem(),
    querySelector: (sel) => (sel.startsWith("#") ? (children[sel.slice(1)] || descend(children, sel.slice(1))) : null),
    querySelectorAll: (sel) => {
      if (sel === ".hmk-x .hmk-row") return rowButtons;
      if (sel === "svg.hchart") return charts;
      return [];
    },
    // test helpers
    type(v) { el.value = v; el.dispatch("input"); },
    click() { el.dispatch("click"); },
  };
  return el;
}

function descend(children, id) {
  for (const key of Object.keys(children)) {
    const found = children[key].querySelector(`#${id}`);
    if (found) return found;
  }
  return null;
}

function fakeMarkerItem() {
  let open = false;
  return { classList: { toggle: () => (open = !open) } };
}

function fakeWrap() {
  return fakeEl();
}

function controllerDeps(wrap, options = {}) {
  const refreshing = [];
  const switched = [];
  const cta = fakeEl();
  const deps = {
    root: {
      querySelector: (selector) => {
        if (selector === "#hMarkers") return wrap;
        if (selector === "#hMkToRecords" && wrap.innerHTML.includes("hMkToRecords")) return cta;
        return wrap.querySelector(selector);
      },
    },
    cachedApi: options.cachedApi || (() => Promise.resolve(null)),
    peekCached: options.peekCached || (() => null),
    markRefreshing: (on) => { refreshing.push(Boolean(on)); },
    pollToken: () => options.pollToken ?? 11,
    relAge: (iso) => `age:${iso}`,
    select: () => null,
    stagger: (index) => `--i:${index}`,
    switchHealthSeg: (seg, opts) => { switched.push([seg, opts]); },
    escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
  };
  return { deps, refreshing, switched, cta };
}

function loadWith(payload, overrides) {
  const wrap = fakeWrap();
  const { controller, orderCalls, lipidNotes, wiredCharts } = loadController(overrides);
  const { deps, refreshing, switched, cta } = controllerDeps(wrap, {
    cachedApi: (_path, opts) => { opts.onUpgrade(payload, { changed: true }); return Promise.resolve(payload); },
  });
  controller.load(deps, 11);
  return { wrap, orderCalls, lipidNotes, wiredCharts, refreshing, switched, cta };
}

const results = (wrap) => wrap.querySelector("#hMkResults").innerHTML;

test("health markers controller renders grouped markers and wires rows/charts", async () => {
  const payload = {
    groups: [{ key: "lipids", label: "Lipids" }],
    markers: [
      { name: "LDL-C", group: "lipids", latest: { flag: "high" } },
      { name: "ApoB", group: "lipids", latest: { flag: null } },
    ],
  };
  const { wrap, orderCalls, lipidNotes, wiredCharts } = loadWith(payload);
  await Promise.resolve();

  assert.match(results(wrap), /hmk-groups/);
  assert.match(results(wrap), /Lipids/);
  assert.match(results(wrap), /LDL family/);
  assert.match(results(wrap), /0:ApoB/);
  assert.match(results(wrap), /1:LDL-C/);
  assert.equal(orderCalls.length, 1);
  assert.equal(JSON.stringify(orderCalls[0]), JSON.stringify(["lipids", ["LDL-C", "ApoB"]]));
  assert.equal(lipidNotes[0], `<div class="lipid-note">age:2026-06-01 ApoB|LDL-C</div>`);
  assert.equal(wiredCharts.length, 2);
});

test("group heads carry an out-of-range count badge", async () => {
  const payload = {
    groups: [{ key: "lipids", label: "Lipids" }, { key: "vitamins", label: "Vitamins" }],
    markers: [
      { name: "ApoB", group: "lipids", latest: { flag: "high" } },
      { name: "LDL-C", group: "lipids", latest: { flag: null }, in_optimal: false },
      { name: "Folate", group: "vitamins", latest: { flag: "normal" }, in_optimal: true },
    ],
  };
  const { wrap } = loadWith(payload);
  await Promise.resolve();
  // Lipids has two off; the badge reflects that. Vitamins (all in range) has none.
  assert.match(results(wrap), /Lipids<span class="hmk-headcount">2 off<\/span>/);
  assert.doesNotMatch(results(wrap), /Vitamins<span class="hmk-headcount">/);
});

test("search narrows the catalog by marker name and keeps the field", async () => {
  const payload = {
    groups: [{ key: "lipids", label: "Lipids" }, { key: "vitamins", label: "Vitamins" }],
    markers: [
      { name: "ApoB", group: "lipids", latest: { flag: "high" } },
      { name: "LDL-C", group: "lipids", latest: { flag: null } },
      { name: "Folate", group: "vitamins", latest: { flag: null } },
    ],
  };
  const { wrap } = loadWith(payload);
  await Promise.resolve();

  wrap.querySelector("#hMkSearch").type("apo");
  assert.match(results(wrap), /ApoB/);
  assert.doesNotMatch(results(wrap), /Folate/);
  assert.doesNotMatch(results(wrap), /LDL-C/);
  assert.match(results(wrap), /1 of 3 markers/);

  wrap.querySelector("#hMkSearch").type("");
  assert.match(results(wrap), /Folate/);
  assert.match(results(wrap), /ApoB/);
});

test("an empty search shows a clear affordance that restores the catalog", async () => {
  const payload = {
    groups: [{ key: "lipids", label: "Lipids" }],
    markers: [{ name: "ApoB", group: "lipids", latest: { flag: "high" } }],
  };
  const { wrap } = loadWith(payload);
  await Promise.resolve();

  wrap.querySelector("#hMkSearch").type("zzz");
  assert.match(results(wrap), /No markers match/);
  const clear = wrap.querySelector("#hMkResults").querySelector("#hMkClear");
  assert.ok(clear, "clear button present");
  clear.click();
  assert.match(results(wrap), /ApoB/);
  assert.equal(wrap.querySelector("#hMkSearch")._focused, true);
});

test("the out-of-range toggle narrows and restores, composing with search", async () => {
  const payload = {
    groups: [{ key: "lipids", label: "Lipids" }, { key: "vitamins", label: "Vitamins" }],
    markers: [
      { name: "ApoB", group: "lipids", latest: { flag: "high" } },
      { name: "LDL-C", group: "lipids", latest: { flag: null }, in_optimal: false },
      { name: "Folate", group: "vitamins", latest: { flag: null }, in_optimal: true },
    ],
  };
  const { wrap } = loadWith(payload);
  await Promise.resolve();

  assert.match(wrap.innerHTML, /Out of range · 2/);
  const toggle = wrap.querySelector("#hMkOutToggle");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.classList.contains("on"), true);
  assert.match(results(wrap), /ApoB/);
  assert.match(results(wrap), /LDL-C/);
  assert.doesNotMatch(results(wrap), /Folate/);
  assert.doesNotMatch(results(wrap), /Vitamins/);

  toggle.click();
  assert.match(results(wrap), /Folate/);
});

test("the out-of-range toggle is absent when everything is in range", async () => {
  const payload = {
    groups: [{ key: "vitamins", label: "Vitamins" }],
    markers: [{ name: "Folate", group: "vitamins", latest: { flag: "normal" }, in_optimal: true }],
  };
  const { wrap } = loadWith(payload);
  await Promise.resolve();
  assert.doesNotMatch(wrap.innerHTML, /hMkOutToggle/);
  assert.match(results(wrap), /Folate/);
});

test("health markers controller clears failed cold loads to empty records CTA", async () => {
  const wrap = fakeWrap();
  const { controller } = loadController();
  const { deps, switched, cta } = controllerDeps(wrap, {
    cachedApi: () => Promise.reject(new Error("offline")),
  });

  controller.load(deps, 11);
  await Promise.resolve();
  await Promise.resolve();

  assert.match(wrap.innerHTML, /hMkToRecords/);
  cta.dispatch("click");
  assert.equal(JSON.stringify(switched), JSON.stringify([["records", { openPicker: true }]]));
});
