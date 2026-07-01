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
    },
    ...overrides,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-markers-controller.js"), "utf8"), context);
  return { controller: context.CairnHealthMarkersController, orderCalls, lipidNotes, wiredCharts };
}

function fakeButton(item = fakeMarkerItem()) {
  const listeners = new Map();
  return {
    attrs: {},
    addEventListener: (type, fn) => { listeners.set(type, fn); },
    click: () => listeners.get("click")?.({ currentTarget: this }),
    closest: () => item,
    setAttribute(name, value) { this.attrs[name] = value; },
  };
}

function fakeMarkerItem() {
  let open = false;
  return {
    classList: {
      toggle: (name) => {
        assert.equal(name, "open");
        open = !open;
        return open;
      },
    },
  };
}

function fakeWrap() {
  const buttons = [fakeButton(), fakeButton()];
  const charts = [{ id: "chart-a" }, { id: "chart-b" }];
  return {
    html: "",
    isConnected: true,
    buttons,
    charts,
    set innerHTML(value) { this.html = value; },
    get innerHTML() { return this.html; },
    querySelectorAll(selector) {
      if (selector === ".hmk-x .hmk-row") return buttons;
      if (selector === "svg.hchart") return charts;
      return [];
    },
  };
}

function controllerDeps(wrap, options = {}) {
  const refreshing = [];
  const switched = [];
  const cta = {
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    click() { this.listeners.get("click")?.(); },
  };
  const deps = {
    root: {
      querySelector: (selector) => {
        if (selector === "#hMarkers") return wrap;
        if (selector === "#hMkToRecords" && wrap.innerHTML.includes("hMkToRecords")) return cta;
        return null;
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

test("health markers controller renders grouped markers and wires rows/charts", async () => {
  const wrap = fakeWrap();
  const payload = {
    groups: [{ key: "lipids", label: "Lipids" }],
    markers: [
      { name: "LDL-C", group: "lipids" },
      { name: "ApoB", group: "lipids" },
    ],
  };
  const { controller, orderCalls, lipidNotes, wiredCharts } = loadController();
  const { deps } = controllerDeps(wrap, {
    cachedApi: (_path, options) => {
      options.onUpgrade(payload, { changed: true });
      return Promise.resolve(payload);
    },
  });

  controller.load(deps, 11);
  await Promise.resolve();

  assert.match(wrap.innerHTML, /hmk-groups/);
  assert.match(wrap.innerHTML, /Lipids/);
  assert.match(wrap.innerHTML, /LDL family/);
  assert.match(wrap.innerHTML, /0:ApoB/);
  assert.match(wrap.innerHTML, /1:LDL-C/);
  assert.equal(orderCalls.length, 1);
  assert.equal(JSON.stringify(orderCalls[0]), JSON.stringify(["lipids", ["LDL-C", "ApoB"]]));
  assert.equal(lipidNotes[0], `<div class="lipid-note">age:2026-06-01 ApoB|LDL-C</div>`);
  assert.deepEqual(wiredCharts.map((chart) => chart.id), ["chart-a", "chart-b"]);

  wrap.buttons[0].click();
  assert.equal(wrap.buttons[0].attrs["aria-expanded"], "true");
});

test("health markers controller falls back to derived groups and stale-cache refresh cleanup", async () => {
  const wrap = fakeWrap();
  const cached = { markers: [{ name: "Vitamin D", group: "nutrients", group_label: "Nutrients" }] };
  const { controller } = loadController();
  const { deps, refreshing } = controllerDeps(wrap, {
    peekCached: () => ({ data: cached, fresh: false }),
    cachedApi: (_path, options) => {
      options.onUpgrade(cached, { changed: false });
      return Promise.resolve(cached);
    },
  });

  controller.load(deps, 11);
  await Promise.resolve();

  assert.match(wrap.innerHTML, /Nutrients/);
  assert.match(wrap.innerHTML, /0:Vitamin D/);
  assert.deepEqual(refreshing, [true, false]);
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
  cta.click();
  assert.equal(JSON.stringify(switched), JSON.stringify([["records", { openPicker: true }]]));
});
