import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeClassList {
  constructor(names = "") {
    this.items = new Set(String(names).split(/\s+/).filter(Boolean));
  }

  add(...names) {
    names.forEach((name) => this.items.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.items.delete(name));
  }

  contains(name) {
    return this.items.has(name);
  }

  toggle(name, force) {
    const next = force == null ? !this.items.has(name) : Boolean(force);
    if (next) this.items.add(name);
    else this.items.delete(name);
    return next;
  }
}

class FakeElement {
  constructor(tag = "div", owner = null) {
    this.tag = tag;
    this.owner = owner;
    this.children = [];
    this.dataset = {};
    this.parentElement = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
    this.style = { removeProperty: (name) => { delete this.style[name]; } };
    this.classList = new FakeClassList();
    this._innerHTML = "";
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }

  get className() {
    return [...this.classList.items].join(" ");
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this.tag !== "template-host") {
      const child = new FakeElement("section", this.owner);
      child.className = "mealday reveal";
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  replaceWith(next) {
    if (this.owner) this.owner.replaced = next;
  }

  querySelector(selector) {
    if (selector.startsWith(".meal-row")) {
      const row = new FakeElement("div", this.owner);
      row.className = "meal-row";
      return row;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  insertAdjacentHTML(_where, html) {
    this._innerHTML += html;
  }
}

class FakeView {
  constructor() {
    this.section = new FakeElement("section", this);
    this.section.className = "mealday";
    this.replaced = null;
  }

  querySelector(selector) {
    if (selector.startsWith(".mealday")) return this.section;
    return null;
  }
}

function loadMealSwapController(overrides = {}) {
  const view = new FakeView();
  const renderedDays = [];
  const invalidations = [];
  const toasts = [];
  const countUps = [];
  const requests = [];
  const context = {
    Array,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    Set,
    Element: FakeElement,
    Event,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeElement,
    HTMLInputElement: FakeElement,
    window: null,
    globalThis: null,
    document: {
      createElement: () => new FakeElement("div", view),
    },
    view,
    MEALS_KEY: "meals:plans",
    pollToken: 7,
    CairnUi: {
      jobCaptionHtml: ({ className = "job-cap" } = {}) => `<span class="${className}">thinking</span>`,
    },
    CairnMealPlan: {
      mealDayHtml: (day, dayIndex, ctx) => {
        renderedDays.push({ day, dayIndex, ctx });
        return `<section class="mealday reveal" data-mday="${dayIndex}"></section>`;
      },
      mealSlotFor: (name) => String(name || "meal").toLowerCase(),
      mealsCtxFor: () => ({ weekOf: "2026-06-29", targetKcal: 2400, todayName: "mon" }),
    },
    CairnMealRecipeController: {
      openMealSheet: () => {},
    },
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (overrides.api) return overrides.api(path, opts);
      return { ok: true };
    },
    btnBusy: () => () => {},
    peekCached: () => overrides.cached || null,
    reducedMotion: () => true,
    runCountUps: (node) => countUps.push(node),
    runOp: () => Promise.resolve(null),
    swrInvalidate: (key) => invalidations.push(key),
    thinkingCaption: () => () => {},
    toast: (message) => toasts.push(message),
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-swap-data-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-swap-controller.js"), "utf8"), context);
  return { context, view, renderedDays, invalidations, toasts, countUps, requests };
}

function runClientSource(context, file) {
  const source = readFileSync(join(root, file), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
  vm.runInNewContext(`(() => {\n${output.trimEnd()}\n})();`, context);
}

class RowActionElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.parentElement = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.matchesBySelector = new Map();
    this.hidden = false;
    this.disabled = false;
    this.focused = false;
    this.textContent = "";
    this.value = "";
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }

  get className() {
    return [...this.classList.items].join(" ");
  }

  addEventListener(type, handler) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(handler);
    this.listeners.set(type, listeners);
  }

  async fire(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    const evt = {
      target: this,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...event,
    };
    for (const handler of listeners) await handler(evt);
    return evt;
  }

  click() {
    return this.fire("click");
  }

  focus() {
    this.focused = true;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const trimmed = part.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith(".")) return this.classList.contains(trimmed.slice(1));
      return this.tag === trimmed;
    });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this.matchesBySelector.get(selector) || [];
  }

  setQuery(selector, elements) {
    this.matchesBySelector.set(selector, elements);
    elements.forEach((element) => {
      if (!element.parentElement) element.parentElement = this;
    });
  }
}

function loadMealSwapRowActionsController(overrides = {}) {
  const fuelLineCalls = [];
  const context = {
    Array,
    Boolean,
    JSON,
    Number,
    Object,
    Promise,
    String,
    Element: RowActionElement,
    HTMLElement: RowActionElement,
    HTMLButtonElement: RowActionElement,
    window: null,
    globalThis: null,
    CairnMealFuelContext: {
      remainingFuelKcal: async () => (overrides.remainingKcal === undefined ? null : overrides.remainingKcal),
      mealFuelFitLine: (itemKcal, remaining) => {
        if (remaining == null) return "";
        const ik = Number(itemKcal);
        if (!Number.isFinite(ik) || ik <= 0) return `today's remaining ~${remaining} kcal`;
        return ik <= remaining ? `fits today's remaining ~${remaining} kcal` : `runs past today's remaining ~${remaining} kcal`;
      },
      loadMealFuelLine: (scope, itemKcal) => {
        fuelLineCalls.push({ scope, itemKcal });
        return Promise.resolve();
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  runClientSource(context, "src/client/meal-swap-row-actions-controller.ts");
  context._fuelLineCalls = fuelLineCalls;
  return context;
}

test("meal swap controller applies swap result in-place and rerenders the day", () => {
  const harness = loadMealSwapController();
  const current = {
    id: 42,
    parsed: {
      days: [{ day: "Monday", meals: [{ name: "Old lunch", kcal: 500 }] }],
    },
  };

  const options = harness.context.CairnMealSwapController.mealSwapOpOpts(current, { targetKcal: 2400 }, 0, 0);
  options.render({ ok: true, meal: { name: "New lunch", kcal: 520 } });

  assert.equal(current.parsed.days[0].meals[0].name, "New lunch");
  assert.equal(harness.renderedDays[0].day, current.parsed.days[0]);
  assert.deepEqual(harness.renderedDays[0].ctx, { targetKcal: 2400 });
  assert.equal(harness.view.replaced.classList.contains("reveal"), false);
  assert.equal(harness.countUps[0], harness.view.replaced);
  assert.deepEqual(harness.invalidations, ["meals:plans"]);
  assert.equal(harness.toasts.at(-1), "Meal swapped");
});

test("meal swap controller persists optimistic meal reordering", async () => {
  const harness = loadMealSwapController();
  const current = {
    id: "plan-1",
    parsed: {
      days: [{
        day: "Tuesday",
        meals: [{ name: "Breakfast" }, { name: "Lunch" }, { name: "Dinner" }],
      }],
    },
  };

  await harness.context.CairnMealSwapController.moveMealRow(current, null, 0, 0, 1);

  assert.deepEqual(current.parsed.days[0].meals.map((meal) => meal.name), ["Lunch", "Breakfast", "Dinner"]);
  assert.equal(harness.requests[0].path, "/meal-plans/plan-1/days");
  assert.equal(harness.requests[0].opts.method, "PUT");
  assert.deepEqual(JSON.parse(harness.requests[0].opts.body).days[0].meals.map((meal) => meal.name), ["Lunch", "Breakfast", "Dinner"]);
  assert.deepEqual(harness.invalidations, ["meals:plans"]);
  assert.equal(harness.countUps.length, 1);
});

test("meal swap row actions wire log, swap, hint, move, and sheet events", async () => {
  const context = loadMealSwapRowActionsController();
  const current = { id: "plan-1" };
  const ctx = { targetKcal: 2400 };
  const apiCalls = [];
  const toasts = [];
  const submittedSwaps = [];
  const movedRows = [];
  const openedSheets = [];

  const scope = new RowActionElement("section");
  const logButton = new RowActionElement("button");
  logButton.dataset.mlog = JSON.stringify({
    name: "Lunch",
    i: 1,
    items: "Rice bowl",
    kcal: 520,
    protein_g: 36,
    carbs_g: 62,
    fat_g: 14,
  });
  const row = new RowActionElement("div");
  row.className = "meal-row";
  row.dataset.di = "0";
  row.dataset.mi = "1";
  const panel = new RowActionElement("div");
  panel.className = "meal-swap";
  panel.hidden = true;
  panel.dataset.di = "0";
  panel.dataset.mi = "1";
  row.nextElementSibling = panel;
  panel.previousElementSibling = row;

  const swapButton = new RowActionElement("button");
  swapButton.dataset.mswap = "1";
  swapButton.parentElement = row;
  const moveButton = new RowActionElement("button");
  moveButton.className = "meal-mv";
  moveButton.dataset.mv = "-1";
  moveButton.parentElement = row;
  const hintInput = new RowActionElement("input");
  hintInput.className = "meal-swap-hint";
  const swapGo = new RowActionElement("button");
  swapGo.className = "meal-swap-go";
  const cancelButton = new RowActionElement("button");
  cancelButton.className = "meal-swap-cancel";
  const hintChip = new RowActionElement("button");
  hintChip.className = "hintchip";
  hintChip.dataset.hint = "more protein";
  panel.setQuery(".meal-swap-hint", [hintInput]);
  panel.setQuery(".meal-swap-go", [swapGo]);
  panel.setQuery(".hintchip", [hintChip]);

  scope.setQuery("[data-mlog]", [logButton]);
  scope.setQuery("[data-mswap]", [swapButton]);
  scope.setQuery(".meal-swap-cancel", [cancelButton]);
  scope.setQuery(".hintchip", [hintChip]);
  scope.setQuery(".meal-swap-hint", [hintInput]);
  scope.setQuery(".meal-swap-go", [swapGo]);
  scope.setQuery(".meal-mv", [moveButton]);
  scope.setQuery(".meal-row[data-di]", [row]);

  context.CairnMealSwapRowActionsController.wireMealRows(scope, current, ctx, {
    data: { record: (value) => value },
    mealPlan: { mealSlotFor: (name, index) => `${String(name).toLowerCase()}:${index}` },
    recipeController: { openMealSheet: (...args) => openedSheets.push(args) },
    api: async (path, opts) => {
      apiCalls.push({ path, opts });
      return { ok: true };
    },
    toast: (message) => toasts.push(message),
    submitMealSwap: (...args) => {
      submittedSwaps.push(args);
      return Promise.resolve();
    },
    moveMealRow: (...args) => {
      movedRows.push(args);
      return Promise.resolve();
    },
  });

  await logButton.click();
  assert.equal(apiCalls[0].path, "/food-notes");
  assert.equal(JSON.parse(apiCalls[0].opts.body).meal, "lunch:1");
  assert.equal(logButton.textContent, "✓ Logged");
  assert.equal(logButton.classList.contains("meal-log-done"), true);
  assert.equal(toasts.at(-1), "Lunch logged");

  await swapButton.click();
  assert.equal(panel.hidden, false);
  assert.equal(hintInput.focused, true);
  // Opening the swap panel loads the quiet "today's remaining ~X kcal" context line.
  assert.equal(context._fuelLineCalls.length, 1);
  assert.equal(context._fuelLineCalls[0].scope, panel);

  await hintChip.click();
  assert.equal(hintInput.value, "more protein");
  assert.equal(hintChip.classList.contains("on"), true);
  await hintChip.click();
  assert.equal(hintInput.value, "");
  assert.equal(hintChip.classList.contains("on"), false);

  const enterEvent = await hintInput.fire("keydown", { key: "Enter" });
  assert.equal(enterEvent.defaultPrevented, true);
  assert.deepEqual(submittedSwaps[0], [current, ctx, 0, 1, panel]);

  await moveButton.click();
  assert.deepEqual(movedRows[0], [current, ctx, 0, 1, -1]);

  await row.click();
  assert.deepEqual(openedSheets[0], [current, 0, 1]);
});

test("meal swap row actions '+ Log it' toast names whether the meal fits today's remaining kcal", async () => {
  const context = loadMealSwapRowActionsController({ remainingKcal: 400 });
  const scope = new RowActionElement("section");
  const logButton = new RowActionElement("button");
  logButton.dataset.mlog = JSON.stringify({ name: "Dinner", i: 2, items: "Salmon", kcal: 620 });
  scope.setQuery("[data-mlog]", [logButton]);
  scope.setQuery("[data-mswap]", []);
  scope.setQuery(".meal-swap-cancel", []);
  scope.setQuery(".hintchip", []);
  scope.setQuery(".meal-swap-hint", []);
  scope.setQuery(".meal-swap-go", []);
  scope.setQuery(".meal-mv", []);
  scope.setQuery(".meal-row[data-di]", []);
  const toasts = [];

  context.CairnMealSwapRowActionsController.wireMealRows(scope, { id: "plan-1" }, {}, {
    data: { record: (value) => value },
    mealPlan: { mealSlotFor: (name, index) => `${String(name).toLowerCase()}:${index}` },
    recipeController: { openMealSheet: () => {} },
    api: async () => ({ ok: true }),
    toast: (message) => toasts.push(message),
    submitMealSwap: () => Promise.resolve(),
    moveMealRow: () => Promise.resolve(),
  });

  await logButton.click();
  // 620 kcal against 400 remaining: over budget, named plainly, not silently.
  assert.equal(toasts.at(-1), "Dinner logged — runs past today's remaining ~400 kcal");
});

test("meal swap controller keeps compatibility shim while row handlers live in row-actions module", () => {
  const controller = readFileSync(join(root, "src/client/meal-swap-controller.ts"), "utf8");
  const rowActions = readFileSync(join(root, "src/client/meal-swap-row-actions-controller.ts"), "utf8");

  assert.match(controller, /function wireMealRows\(scope: ParentNode, current: MealSwapControllerPlan, ctx: MealSwapControllerContext\): void/);
  assert.match(controller, /CairnMealSwapRowActionsController/);
  assert.match(controller, /submitMealSwap/);
  assert.match(controller, /moveMealRow/);
  assert.doesNotMatch(controller, /querySelectorAll<HTMLElement>\("\[data-mlog\]"\)/);
  assert.match(rowActions, /function mealSwapRowActionsWireMealRows\(/);
  assert.match(rowActions, /\[data-mlog\]/);
  assert.match(rowActions, /\[data-mswap\]/);
  assert.match(rowActions, /CairnMealSwapRowActionsController/);
});
