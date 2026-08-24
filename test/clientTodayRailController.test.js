import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flushRailLoaders() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.attributes = { ...(attrs.attributes || {}) };
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.removed = false;
    this.isConnected = true;
    this.innerHTML = "";
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    for (const handler of this.listeners.get("click") || []) {
      handler({ target: this, currentTarget: this });
    }
  }

  getAttribute(name) {
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] ?? null;
    }
    return this.attributes[name] ?? null;
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.attributes.id === selector.slice(1);
    if (selector === "[data-agenda-act]") return Object.hasOwn(this.dataset, "agendaAct");
    if (selector === "[data-agenda-dismiss]") return Object.hasOwn(this.dataset, "agendaDismiss");
    if (selector === ".agenda-card") return this.className.split(/\s+/).includes("agenda-card");
    return false;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  remove() {
    this.removed = true;
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  querySelectorAll(selector) {
    const out = [];
    if (this.matches(selector)) out.push(this);
    for (const child of this.children) out.push(...child.querySelectorAll(selector));
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function loadController({ buckets } = {}) {
  const context = {
    Object,
    Promise,
    Set,
    String,
    Array,
    encodeURIComponent,
    window: null,
    globalThis: null,
    CairnTodayAgenda: {
      renderableBuckets: () => buckets || { primary: [], more: [] },
      railHtml: (agenda, pending) => {
        pending.push({ id: "generic", kind: "since-last", tier: "primary", priority: 1, title: "New signal" });
        return agenda ? `<aside>${agenda.primary.length}</aside>` : "";
      },
      fuelCardHtml: () => `<button id="fuelCard"></button>`,
    },
    CairnTodayWeekAhead: {
      cardHtml: () => `<div class="weekahead"></div>`,
    },
    CairnTodayProgramAdjustments: {
      extraCount: () => 0,
      bannerHtml: () => `<div class="adjust-card"></div>`,
    },
    CairnTodayLately: {
      rowHtml: () => `<div class="lately-row"></div>`,
    },
    CairnTodayGarminReconciliation: {
      load: async () => {},
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-rail-loaders-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-rail-controller.js"), "utf8"), context);
  return context.CairnTodayRailController;
}

function makeDeps(rootEl = new FakeElement("section")) {
  const calls = [];
  const deps = {
    root: rootEl,
    state: { logDate: "2026-07-01" },
    api: async (path) => {
      calls.push(["api", path]);
      if (String(path).startsWith("/nutrition/day")) {
        return { count: 1, totals: { kcal: 350, protein_g: 28 } };
      }
      if (path === "/recent-training?limit=6") {
        return [{ kind: "cardio", title: "Run", date: "2026-07-01" }];
      }
      if (path === "/today-agenda/ack") return { ok: true };
      return { hero: {}, primary: [], more: [], total: 0 };
    },
    activateTab: (tab) => calls.push(["tab", tab]),
    gotoChatWith: (text) => calls.push(["chat", text]),
    collapseEl: (el, done) => {
      calls.push(["collapse", el]);
      if (done) done();
    },
    loadTodayReads: () => calls.push(["reads"]),
    runCountUps: (el) => calls.push(["countups", el.attributes?.id || el.tag]),
    escapeHtml: (value) => String(value ?? ""),
    toast: (message) => calls.push(["toast", message]),
    invalidate: (key) => calls.push(["invalidate", key]),
    refreshToday: (options) => calls.push(["refresh", options]),
  };
  return { deps, calls };
}

test("Today rail controller fetches only valid agenda payloads", async () => {
  const controller = loadController();
  const { deps, calls } = makeDeps();

  assert.deepEqual(await controller.fetchTodayAgenda("2026-07-01", deps), {
    hero: {},
    primary: [],
    more: [],
    total: 0,
  });
  assert.deepEqual(calls, [["api", "/today-agenda?date=2026-07-01"]]);

  deps.api = async () => ({ primary: [] });
  assert.equal(await controller.fetchTodayAgenda("2026-07-02", deps), null);
});

test("Today rail controller dedupes shared agenda loaders and owns rail slot loaders", async () => {
  const controller = loadController({
    buckets: {
      primary: [
        { id: "weekly", client_card: "weekly-read" },
        { id: "insight", client_card: "connection-insight" },
        { id: "fuel", client_card: "fuel" },
      ],
      more: [
        { id: "late", client_card: "lately" },
        { id: "future", client_card: "unknown-card" },
      ],
    },
  });
  const rootEl = new FakeElement("section");
  rootEl.appendChild(new FakeElement("div", { attributes: { id: "fuelSlot" } }));
  rootEl.appendChild(new FakeElement("div", { attributes: { id: "qlRecent" } }));
  const { deps, calls } = makeDeps(rootEl);

  controller.runAgendaRail({ primary: [], more: [] }, [], deps);
  await flushRailLoaders();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["reads"],
    ["api", "/nutrition/day?date=2026-07-01"],
    ["api", "/recent-training?limit=6"],
    ["countups", "fuelSlot"],
  ]);
});

test("Today rail controller fallback rail omits fuel and runs non-fuel fallback loaders", async () => {
  const controller = loadController();
  const html = controller.fallbackRailHtml(true);
  assert.match(html, /weekAheadSlot/);
  assert.match(html, /adjustSlot/);
  assert.doesNotMatch(html, /fuelSlot/);

  const rootEl = new FakeElement("section");
  rootEl.appendChild(new FakeElement("div", { attributes: { id: "weekAheadSlot" } }));
  rootEl.appendChild(new FakeElement("div", { attributes: { id: "adjustSlot" } }));
  rootEl.appendChild(new FakeElement("div", { attributes: { id: "qlRecent" } }));
  const { deps, calls } = makeDeps(rootEl);

  controller.runFallbackRail(true, deps);
  await flushRailLoaders();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["api", "/recent-training?limit=6"],
    ["reads"],
    ["api", "/week-ahead"],
    ["api", "/program/adjustments"],
  ]);
});

test("Today rail controller wires generic agenda navigation and dismiss controls", () => {
  const rootEl = new FakeElement("section");
  const chatBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "chat", agendaId: "chat" },
  }));
  const coachBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "plan-coach", agendaId: "coach" },
  }));
  const standingBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "me-health-standing", agendaId: "standing" },
  }));
  const readBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "me-health-read", agendaId: "read" },
  }));
  // Another candidate (since-last) reuses the me-health-read kind but carries no
  // revision — it navigates to Stand and must NOT fire a bogus ack.
  const sinceBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "me-health-read", agendaId: "since" },
  }));
  const tabBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "tab:progress", agendaId: "tab" },
  }));
  const energyBtn = rootEl.appendChild(new FakeElement("button", {
    dataset: { agendaAct: "progress-energy", agendaId: "energy" },
  }));
  const card = rootEl.appendChild(new FakeElement("article", { className: "agenda-card" }));
  const dismissBtn = card.appendChild(new FakeElement("button", {
    dataset: { agendaDismiss: "", agendaId: "gone" },
  }));
  const { deps, calls } = makeDeps(rootEl);
  const controller = loadController();
  const pending = [
    { id: "chat", title: "Ask", action: { label: "Ask", kind: "chat", payload: "Explain this" } },
    { id: "coach", action: { label: "Plan", kind: "plan-coach" } },
    { id: "standing", action: { label: "Standing", kind: "me-health-standing" } },
    { id: "read", revision: "health-v1", action: { label: "Read", kind: "me-health-read" } },
    { id: "since", action: { label: "Read", kind: "me-health-read" } },
    { id: "tab", action: { label: "Progress", kind: "tab:progress" } },
    { id: "energy", action: { label: "Review the read", kind: "progress-energy" } },
  ];

  controller.wireGenericAgendaCards(pending, deps);
  chatBtn.click();
  coachBtn.click();
  standingBtn.click();
  readBtn.click();
  sinceBtn.click();
  tabBtn.click();
  energyBtn.click();
  dismissBtn.click();

  assert.deepEqual(calls, [
    ["chat", "Explain this"],
    ["tab", "plan"],
    ["tab", "stand"],
    ["api", "/today-agenda/ack"], // revision-carrying read acks
    ["tab", "stand"],
    ["tab", "stand"], // since-last (no revision) navigates but does NOT ack
    ["tab", "progress"],
    ["tab", "progress"],
    ["collapse", card],
  ]);
  assert.equal(deps.state.planJump, "coach");
  // The whole-picture read lives on the Stand overview now.
  assert.equal(deps.state.standSeg, null);
  assert.equal(deps.state.progressSeg, "energy");
  assert.equal(card.removed, true);
});

test("revision dismiss waits for durable acknowledgement and stays visible when it fails", async () => {
  const rootEl = new FakeElement("section");
  const card = rootEl.appendChild(
    new FakeElement("article", {
      className: "agenda-card",
      dataset: { agendaCard: "fast-loss-attention" },
    })
  );
  const dismissBtn = card.appendChild(
    new FakeElement("button", {
      dataset: { agendaDismiss: "fast-loss-attention" },
    })
  );
  const { deps, calls } = makeDeps(rootEl);
  deps.api = async (path) => {
    calls.push(["api", path]);
    return { ok: false };
  };
  const controller = loadController();
  controller.wireGenericAgendaCards([{ id: "fast-loss-attention", revision: "cut-v1", dismissible: true }], deps);

  dismissBtn.click();
  assert.equal(card.removed, false, "the UI does not claim durable dismissal before the request settles");
  await flushRailLoaders();
  assert.equal(card.removed, false, "a failed acknowledgement leaves the attention item available");
  // The surface-dismissal POST rides alongside as fire-and-forget: it is not awaited
  // and swallows its own rejection, so a failing dismiss (this api stub answers
  // {ok:false} to BOTH calls) leaves the durable ack path — and the card — untouched.
  assert.deepEqual(calls, [["api", "/today-agenda/dismiss"], ["api", "/today-agenda/ack"]]);

  deps.api = async (path) => {
    calls.push(["api", path]);
    return { ok: true };
  };
  dismissBtn.click();
  assert.equal(card.removed, false, "even success waits for the acknowledgement response");
  await flushRailLoaders();
  assert.equal(card.removed, true);
  assert.deepEqual(calls, [
    ["api", "/today-agenda/dismiss"],
    ["api", "/today-agenda/ack"],
    ["api", "/today-agenda/dismiss"],
    ["api", "/today-agenda/ack"],
    ["collapse", card],
  ]);
});
