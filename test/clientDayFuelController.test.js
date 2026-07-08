import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function decodeAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.parentElement = null;
    this._innerHTML = "";
    this.id = attrs.id || "";
    this.value = attrs.value || "";
    this.className = attrs.className || "";
    if (attrs.dataset) this.dataset = { ...attrs.dataset };
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    const foodMatches = [...this._innerHTML.matchAll(/data-fooditem="([^"]*)"/g)];
    for (const match of foodMatches) {
      const row = new FakeElement("button", { dataset: { fooditem: decodeAttr(match[1]) } });
      row.parentElement = this;
      this.children.push(row);
    }
    if (this._innerHTML.includes('id="dayFuelAsk"')) {
      const ask = new FakeElement("button", { id: "dayFuelAsk" });
      ask.parentElement = this;
      this.children.push(ask);
    }
    for (const match of this._innerHTML.matchAll(/<input id="([^"]+)"[^>]*value="([^"]*)"/g)) {
      const input = new FakeElement("input", { id: match[1], value: decodeAttr(match[2]) });
      input.parentElement = this;
      this.children.push(input);
    }
    const selectMatch = this._innerHTML.match(/<select id="fedMeal">([\s\S]*?)<\/select>/);
    if (selectMatch) {
      const selected = selectMatch[1].match(/<option value="([^"]+)" selected>/)?.[1] || "meal";
      const select = new FakeElement("select", { id: "fedMeal", value: selected });
      select.parentElement = this;
      this.children.push(select);
    }
    for (const id of ["fedSave", "fedDel"]) {
      if (this._innerHTML.includes(`id="${id}"`)) {
        const button = new FakeElement("button", { id });
        button.parentElement = this;
        this.children.push(button);
      }
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  click() {
    const handler = this.listeners.get("click");
    return handler ? handler({ target: this, currentTarget: this }) : undefined;
  }

  querySelector(selector) {
    if (selector.startsWith("#")) return this.findById(selector.slice(1));
    if (selector === "[data-fooditem]") return this.findFoodRows()[0] || null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-fooditem]") return this.findFoodRows();
    return [];
  }

  findById(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.findById(id);
      if (found) return found;
    }
    return null;
  }

  findFoodRows() {
    const rows = [];
    if (this.dataset.fooditem != null) rows.push(this);
    for (const child of this.children) rows.push(...child.findFoodRows());
    return rows;
  }
}

function loadController(overrides = {}) {
  const rootEl = new FakeElement("section");
  const slot = new FakeElement("div", { id: "dayFuelSlot" });
  slot.innerHTML = "loading";
  slot.parentElement = rootEl;
  rootEl.children.push(slot);
  const requests = [];
  const invalidations = [];
  const toasts = [];
  const countUps = [];
  let mountedDetail = null;
  let closed = 0;
  let wiredDetail = 0;
  const context = {
    Array,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
    window: null,
    view: rootEl,
    state: { logDate: overrides.logDate || "", _dayFuel: null },
    art: () => "<svg></svg>",
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (overrides.api) return overrides.api(path, opts);
      return overrides.day ?? {
        date: "2026-06-30",
        count: 1,
        totals: { kcal: 400, protein_g: 35 },
        entries: [{ id: 5, meal: "lunch", summary: "Eggs & oats", kcal: 400, protein_g: 35, carbs_g: 20, fat_g: 10 }],
      };
    },
    runCountUps: (el) => countUps.push(el),
    gotoChatWith: (message) => { context.chatMessage = message; },
    openDetailFrom: (_fromEl, build) => build(),
    mountDetail: (html) => {
      mountedDetail = new FakeElement("div");
      mountedDetail.innerHTML = html;
      return mountedDetail;
    },
    wireDetailCommon: () => { wiredDetail += 1; },
    armDelete: (_button, onConfirm) => onConfirm(),
    swrInvalidate: (key) => invalidations.push(key),
    closeDetail: () => { closed += 1; },
    toast: (message) => toasts.push(message),
  };
  const swr = new Map();
  context.peekCached = (key) => swr.has(key) ? { data: swr.get(key), fresh: true } : null;
  context.swrSet = (key, data) => swr.set(key, data);
  context.cachedApi = async (path, options = {}) => {
    const data = await context.api(path);
    if (options.key) swr.set(options.key, data);
    if (options.onUpgrade) options.onUpgrade(data, { changed: true });
    return data;
  };
  context.paintSWR = async (options = {}) => {
    const peek = options.peek !== undefined ? options.peek : context.peekCached(options.key);
    if (peek && options.render) options.render(peek.data, { warm: true });
    const data = await context.cachedApi(options.path, {
      key: options.key,
      onUpgrade: (fresh) => {
        if (options.render) options.render(fresh, { warm: false });
      },
    });
    return data;
  };
  context.optimisticMutation = async (options) => {
    const previous = swr.has(options.key) ? swr.get(options.key) : null;
    const optimistic = options.apply(previous);
    swr.set(options.key, optimistic);
    if (options.onChange) options.onChange(optimistic, { phase: "optimistic" });
    try {
      const result = await options.request();
      const committed = options.commit ? options.commit(optimistic, result) : undefined;
      if (committed !== undefined && committed !== null) {
        swr.set(options.key, committed);
        if (options.onChange) options.onChange(committed, { phase: "commit" });
      }
      return result;
    } catch (error) {
      if (previous === null) swr.delete(options.key);
      else {
        swr.set(options.key, previous);
        if (options.onChange) options.onChange(previous, { phase: "rollback" });
      }
      throw error;
    }
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/day-fuel-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/day-fuel-controller.js"), "utf8"), context);
  return {
    context,
    rootEl,
    slot,
    requests,
    invalidations,
    toasts,
    countUps,
    get mountedDetail() { return mountedDetail; },
    get closed() { return closed; },
    get wiredDetail() { return wiredDetail; },
  };
}

test("day fuel controller loads the selected day and wires editable rows", async () => {
  const harness = loadController({
    logDate: "2026-06-30",
    day: {
      date: "2026-06-30",
      count: 1,
      totals: { kcal: 620, protein_g: 45 },
      target: { kcal: 2200, protein_g: 150, mode: "maintain" },
      remaining: { kcal: 1200, protein_g: 70 },
      entries: [{ id: 7, meal: "breakfast", summary: "Eggs & oats", kcal: 620, protein_g: 45, carbs_g: 55, fat_g: 20 }],
    },
  });

  await harness.context.CairnDayFuelController.loadDayFuel(3, {
    root: harness.rootEl,
    isCurrent: (token) => token === 3,
  });

  assert.equal(harness.requests[0].path, "/nutrition/day?date=2026-06-30");
  assert.equal(harness.context.state._dayFuel.entries[0].id, 7);
  assert.match(harness.slot.innerHTML, /Eggs &amp; oats/);
  assert.equal(harness.countUps[0], harness.slot);

  harness.slot.querySelector("[data-fooditem]").click();
  assert.match(harness.mountedDetail.innerHTML, /Edit this meal/);
  assert.equal(harness.wiredDetail, 1);
});

test("day fuel controller wires empty-state chat action", async () => {
  const harness = loadController({ day: { date: "2026-06-30", count: 0, totals: {}, entries: [] } });
  let asked = 0;

  await harness.context.CairnDayFuelController.loadDayFuel(4, {
    root: harness.rootEl,
    isCurrent: (token) => token === 4,
    onAsk: () => { asked += 1; },
  });

  harness.slot.querySelector("#dayFuelAsk").click();
  assert.equal(asked, 1);
});

test("day fuel controller does not paint a stale response", async () => {
  const harness = loadController();

  await harness.context.CairnDayFuelController.loadDayFuel(1, {
    root: harness.rootEl,
    isCurrent: () => false,
  });

  assert.equal(harness.context.state._dayFuel, null);
  assert.equal(harness.slot.innerHTML, "loading");
});

test("day fuel controller saves corrected macros and invalidates energy", async () => {
  const harness = loadController();
  let rerenders = 0;
  harness.context.state._dayFuel = {
    date: "2026-06-30",
    count: 1,
    totals: { kcal: 100, protein_g: 20 },
    entries: [{ id: 5, meal: "lunch", summary: "Old <meal>", kcal: 100, protein_g: 20, carbs_g: 10, fat_g: 3 }],
  };

  harness.context.CairnDayFuelController.openFoodEdit(5, new FakeElement("button"), {
    onRerender: () => { rerenders += 1; },
  });
  harness.mountedDetail.querySelector("#fedSummary").value = "Greek yogurt";
  harness.mountedDetail.querySelector("#fedMeal").value = "snack";
  harness.mountedDetail.querySelector("#fedKcal").value = "250";
  harness.mountedDetail.querySelector("#fedProtein").value = "";
  harness.mountedDetail.querySelector("#fedCarbs").value = "30";
  harness.mountedDetail.querySelector("#fedFat").value = "bad";

  await harness.mountedDetail.querySelector("#fedSave").click();

  assert.equal(harness.requests[0].path, "/food-notes/5");
  assert.equal(harness.requests[0].opts.method, "PUT");
  assert.deepEqual(JSON.parse(harness.requests[0].opts.body), {
    summary: "Greek yogurt",
    meal: "snack",
    kcal: 250,
    protein_g: null,
    carbs_g: 30,
    fat_g: null,
  });
  assert.deepEqual(harness.toasts, ["Updated"]);
  assert.deepEqual(harness.invalidations, ["progress:energy"]);
  assert.equal(harness.closed, 1);
  assert.equal(rerenders, 0);
  assert.equal(harness.context.state._dayFuel.entries[0].summary, "Greek yogurt");
  assert.match(harness.slot.innerHTML, /Greek yogurt/);
});

test("day fuel controller deletes a note through the guarded delete path", async () => {
  const harness = loadController();
  let rerenders = 0;
  harness.context.state._dayFuel = {
    date: "2026-06-30",
    count: 1,
    totals: { kcal: 100, protein_g: 20 },
    entries: [{ id: 9, meal: "dinner", summary: "Dinner", kcal: 100, protein_g: 20, carbs_g: 10, fat_g: 3 }],
  };

  harness.context.CairnDayFuelController.openFoodEdit(9, new FakeElement("button"), {
    onRerender: () => { rerenders += 1; },
  });
  await harness.mountedDetail.querySelector("#fedDel").click();

  assert.equal(harness.requests[0].path, "/food-notes/9");
  assert.equal(harness.requests[0].opts.method, "DELETE");
  assert.deepEqual(harness.toasts, ["Removed"]);
  assert.deepEqual(harness.invalidations, ["progress:energy"]);
  assert.equal(harness.closed, 1);
  assert.equal(rerenders, 0);
  assert.equal(harness.context.state._dayFuel.count, 0);
});
