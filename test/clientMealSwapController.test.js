import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

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
