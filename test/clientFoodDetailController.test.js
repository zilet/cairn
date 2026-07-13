import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.children = [];
    this.dataset = attrs.dataset ? { ...attrs.dataset } : {};
    this.listeners = new Map();
    this.parentElement = null;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes("data-remove")) this.appendChild(new FakeElement("button", { dataset: { remove: "" } }));
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    const result = [];
    for (const handler of this.listeners.get("click") || []) {
      result.push(handler({ target: this, currentTarget: this, preventDefault() {} }));
    }
    return result.at(-1);
  }

  matches(selector) {
    if (selector === "[data-remove]") return this.dataset.remove != null;
    if (selector === '.fnent[data-noteid="42"]') return this.className.split(/\s+/).includes("fnent") && this.dataset.noteid === "42";
    return false;
  }

  querySelector(selector) {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadController() {
  const document = new FakeDocument();
  const context = {
    Array,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    encodeURIComponent,
    window: null,
    globalThis: null,
    document,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/food-detail-controller.js"), "utf8"), context);
  return { context, document };
}

function foodDeps(overrides = {}) {
  const requests = [];
  const toasts = [];
  const countUps = [];
  let mounted = null;
  let closed = 0;
  let wired = 0;
  const deps = {
    state: { _goal: null },
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (overrides.api) return overrides.api(path, opts);
      if (path === "/goal") return { recommended: { target_intake_kcal: 2000 } };
      if (path === "/food-notes/42") return { ok: true };
      return {};
    },
    art: () => "<svg></svg>",
    artEnabled: () => true,
    artImg: (_kind, query) => `<img alt="${escapeHtml(query)}">`,
    closeDetail: () => { closed += 1; },
    escapeHtml,
    foodNote: {
      foodIngredients: (parsed) => parsed?.ingredients || [],
      ingredientLabel: (ingredient) => `${ingredient.amount || ""} ${ingredient.item || ""}`.trim(),
      foodItemsText: () => "",
      foodMacroText: (row) => `${row.kcal || 0} cal`,
      foodTitleFromIngredients: () => "Ingredient meal",
      parsedNote: (row) => row.parsed || null,
    },
    foodNum: (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
    formatFoodNum: (value) => String(value),
    mountDetail: (html, photoSrc) => {
      mounted = new FakeElement("div");
      mounted.photoSrc = photoSrc;
      mounted.innerHTML = html;
      return mounted;
    },
    openDetailFrom: (_fromEl, build) => build(),
    runCountUps: (el) => countUps.push(el),
    toast: (message) => toasts.push(message),
    wireDetailCommon: () => { wired += 1; },
    withToken: (path) => `/token${path}`,
  };
  return {
    deps,
    requests,
    toasts,
    countUps,
    get mounted() { return mounted; },
    get closed() { return closed; },
    get wired() { return wired; },
  };
}

test("food detail controller renders macros, goal context, and removes the note", async () => {
  const { context, document } = loadController();
  const row = new FakeElement("div", { className: "fnent", dataset: { noteid: "42" } });
  document.body.appendChild(row);
  const harness = foodDeps();

  await context.CairnFoodDetailController.openFoodDetail({
    id: 42,
    raw: "2 eggs <toast>",
    created_at: "2026-06-30T12:30:00Z",
    parsed: {
      summary: "Eggs <toast>",
      kcal: 500,
      protein_g: 32,
      carbs_g: 30,
      fat_g: 18,
      ingredients: [{ item: "Eggs <large>", amount: "2", kcal: 180 }],
      notes: "estimated <photo>",
    },
  }, null, harness.deps);

  assert.equal(harness.requests[0].path, "/goal");
  assert.match(harness.mounted.innerHTML, /Eggs &lt;toast&gt;/);
  assert.match(harness.mounted.innerHTML, /25% of the day/);
  assert.match(harness.mounted.innerHTML, /Eggs &lt;large&gt;/);
  assert.match(harness.mounted.photoSrc, /\/token\/api\/art\?kind=food/);
  assert.equal(harness.countUps[0], harness.mounted);
  assert.equal(harness.wired, 1);

  await harness.mounted.querySelector("[data-remove]").click();
  assert.equal(harness.requests.at(-1).path, "/food-notes/42");
  assert.equal(harness.requests.at(-1).opts.method, "DELETE");
  assert.equal(document.querySelector('.fnent[data-noteid="42"]'), null);
  assert.equal(harness.closed, 1);
  assert.equal(harness.toasts.at(-1), "Removed");
});

test("food detail macro bars are sized by energy contribution, not raw grams", async () => {
  const { context, document } = loadController();
  document.body.appendChild(new FakeElement("div", { className: "fnent", dataset: { noteid: "42" } }));
  const harness = foodDeps();

  // Fat 20g (180 kcal) outweighs carbs 30g (120 kcal) energy-wise despite fewer grams —
  // a gram-based bar would render carbs wider; an energy-based bar must render fat wider.
  await context.CairnFoodDetailController.openFoodDetail({
    id: 42,
    raw: "chicken and rice",
    created_at: "2026-06-30T12:30:00Z",
    parsed: { summary: "Chicken and rice", kcal: 500, protein_g: 25, carbs_g: 30, fat_g: 20, fiber_g: 5 },
  }, null, harness.deps);

  const html = harness.mounted.innerHTML;
  const bars = [...html.matchAll(/<span class="lbl">(\w+)<\/span><span class="macrobar-val">([^<]+)<\/span>[\s\S]*?width:(\d+)%/g)]
    .map((m) => ({ label: m[1], val: m[2], width: Number(m[3]) }));
  assert.deepEqual(bars.map((b) => b.label), ["Protein", "Carbs", "Fat", "Fiber"]);

  const carbs = bars.find((b) => b.label === "Carbs");
  const fat = bars.find((b) => b.label === "Fat");
  assert.equal(carbs.val, "30g");
  assert.equal(fat.val, "20g");
  assert.ok(fat.width > carbs.width, `expected fat bar (${fat.width}%) wider than carbs bar (${carbs.width}%)`);

  // Fat is the top energy contributor (180 kcal of protein 100 / carbs 120 / fat 180 / fiber 10), so it fills 100%.
  assert.equal(fat.width, 100);
  assert.equal(carbs.width, Math.round((120 / 180) * 100));
});
