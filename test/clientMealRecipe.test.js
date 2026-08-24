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

const CairnUi = {
  sheetChipHtml({ value, label, className = "sheet-chip" }) {
    return `<span class="${className}">${value == null ? "" : `<span>${escHtml(value)}</span>`}<span>${escHtml(label)}</span></span>`;
  },
  jobCaptionHtml({ tag = "span", className = "job-cap" } = {}) {
    return `<${tag} class="${className}">thinking</${tag}>`;
  },
};

function loadMealRecipe() {
  const context = { Object, String, Array, CairnUi, escHtml };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-recipe-client.js"), "utf8"), context);
  return context.CairnMealRecipe;
}

function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

class FakeClassList {
  constructor() {
    this.items = new Set();
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

  setFromClassName(value) {
    this.items = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  toString() {
    return [...this.items].join(" ");
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.parentElement = null;
    this.style = { removeProperty: (name) => { delete this.style[name]; } };
    this.classList = new FakeClassList();
    this._innerHTML = "";
  }

  set className(value) {
    this._className = String(value || "");
    this.classList.setFromClassName(this._className);
  }

  get className() {
    return this.classList.toString();
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    if (this._innerHTML.includes("data-recipe")) {
      const recipe = new FakeElement("div");
      recipe.isRecipe = true;
      recipe.parentElement = this;
      recipe.innerHTML = this._innerHTML.includes("data-getrecipe") ? "<button data-getrecipe></button>" : "";
      this.children.push(recipe);
    }
    if (this._innerHTML.includes("sheet-x")) {
      const close = new FakeElement("button");
      close.isSheetClose = true;
      close.parentElement = this;
      this.children.push(close);
    }
    if (this._innerHTML.includes("data-getrecipe") && !this._innerHTML.includes("data-recipe")) {
      const button = new FakeElement("button");
      button.isGetRecipe = true;
      button.parentElement = this;
      this.children.push(button);
    }
    if (this._innerHTML.includes("job-cap")) {
      const caption = new FakeElement("span");
      caption.className = "job-cap";
      caption.parentElement = this;
      this.children.push(caption);
    }
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
    this.listeners.set(type, handler);
  }

  click() {
    const handler = this.listeners.get("click");
    if (handler) handler({ target: this, currentTarget: this });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (selector === ".sheet" && node.classList.contains("sheet")) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    if (selector === ".sheet-x") return this.children.find((child) => child.isSheetClose) || null;
    if (selector === "[data-getrecipe]") return this.children.find((child) => child.isGetRecipe) || this.children.map((child) => child.querySelector(selector)).find(Boolean) || null;
    if (selector === ".job-cap") return this.children.find((child) => child.classList.contains("job-cap")) || this.children.map((child) => child.querySelector(selector)).find(Boolean) || null;
    if (selector === "[data-recipe]") return this.children.find((child) => child.isRecipe) || this.children.map((child) => child.querySelector(selector)).find(Boolean) || null;
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  querySelector(selector) {
    if (selector === ".sheet") return this.body.children.find((child) => child.classList.contains("sheet")) || null;
    const sheetRecipe = selector.match(/^\.sheet\[data-key="([^"]+)"\] \[data-recipe\]$/);
    if (sheetRecipe) {
      const sheet = this.body.children.find((child) => child.classList.contains("sheet") && child.dataset.key === sheetRecipe[1]);
      return sheet?.querySelector("[data-recipe]") || null;
    }
    return null;
  }
}

function loadMealRecipeController(overrides = {}) {
  const document = overrides.document || new FakeDocument();
  const runOps = [];
  const invalidations = [];
  const toasts = [];
  const captions = [];
  const fuelLineCalls = [];
  const context = {
    Object,
    String,
    Array,
    Number,
    Set,
    document,
    HTMLElement: FakeElement,
    window: null,
    MEALS_KEY: "meals:plans",
    CairnUi,
    CairnMealFuelContext: {
      loadMealFuelLine: (scope, itemKcal) => {
        fuelLineCalls.push({ scope, itemKcal });
        return Promise.resolve();
      },
    },
    escHtml,
    escAttr,
    artImg(kind, query, className) {
      return `<img data-kind="${escAttr(kind)}" data-query="${escAttr(query)}" class="${escAttr(className)}">`;
    },
    art(kind, query) {
      return `${kind}:${query}`;
    },
    reducedMotion: () => overrides.reducedMotion ?? true,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => fn(),
    toast: (message) => toasts.push(message),
    runOp: (kind, body, options) => {
      runOps.push({ kind, body, options });
      return Promise.resolve(null);
    },
    swrInvalidate: (key) => invalidations.push(key),
    peekCached: () => overrides.cached || null,
    thinkingCaption: (el, op) => {
      captions.push({ el, op, stopped: false });
      return () => { captions[captions.length - 1].stopped = true; };
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-recipe-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-recipe-controller.js"), "utf8"), context);
  return { context, document, runOps, invalidations, toasts, captions, fuelLineCalls };
}

test("meal recipe CTA preserves coach request affordance", () => {
  const recipe = loadMealRecipe();
  const html = recipe.ctaHtml();

  assert.match(html, /data-getrecipe/);
  assert.match(html, /Get the recipe from the coach/);
  assert.match(html, /Written for this exact meal &mdash; can take 15&ndash;120s/);
});

test("meal recipe renderer escapes summary, ingredients, method, and tips", () => {
  const recipe = loadMealRecipe();
  const html = recipe.recipeHtml({
    summary: "Fast <protein> bowl",
    time_min: 25,
    servings: `2 "large"`,
    ingredients: [{ item: "Chicken <raw>", qty: "200g & sliced" }, "Rice <cooked>"],
    steps: ["Cook & rest", "Serve <warm>"],
    tips: ["Add lemon > salt"],
  });

  assert.match(html, /recipe-lede/);
  assert.match(html, /Fast &lt;protein&gt; bowl/);
  assert.match(html, /200g &amp; sliced/);
  assert.match(html, /Rice &lt;cooked&gt;/);
  assert.match(html, /Cook &amp; rest/);
  assert.match(html, /Serve &lt;warm&gt;/);
  assert.match(html, /Add lemon &gt; salt/);
  assert.doesNotMatch(html, /<protein>|<raw>|<cooked>|<warm>/);
});

test("meal recipe loading state carries reconnect caption class", () => {
  const recipe = loadMealRecipe();
  const html = recipe.loadingHtml();

  assert.match(html, /sheet-recipe-loading/);
  assert.match(html, /aspin aspin-sm/);
  assert.match(html, /sheet-recipe-load-line job-cap/);
});

test("meal recipe controller opens sheet and enqueues recipe job from CTA", () => {
  const { context, document, runOps, invalidations, fuelLineCalls } = loadMealRecipeController();
  const plan = {
    id: 42,
    parsed: {
      days: [{ day: "Monday", meals: [{ name: "Bowl <fast>", items: ["rice", "beans"], kcal: 550, protein_g: 40, carbs_g: 60, fat_g: 12 }] }],
    },
  };

  context.CairnMealRecipeController.openMealSheet(plan, 0, 0);

  const sheet = document.querySelector(".sheet");
  assert.equal(sheet.dataset.key, "42:0:0");
  assert.equal(document.body.classList.contains("sheet-open"), true);
  assert.match(sheet.innerHTML, /Bowl &lt;fast&gt;/);
  assert.match(sheet.innerHTML, /rice, beans/);
  // The remaining-fuel context line: a slot in the markup, filled async against
  // THIS meal's own kcal so the sheet can say "fits"/"runs past" once resolved.
  assert.match(sheet.innerHTML, /data-fuel-line/);
  assert.equal(fuelLineCalls.length, 1);
  assert.equal(fuelLineCalls[0].scope, sheet);
  assert.equal(fuelLineCalls[0].itemKcal, 550);

  sheet.querySelector("[data-recipe]").querySelector("[data-getrecipe]").click();
  assert.equal(runOps.length, 1);
  assert.equal(runOps[0].kind, "recipe");
  assert.equal(runOps[0].body.id, 42);
  assert.equal(runOps[0].body.day, "Monday");
  assert.equal(runOps[0].body.meal_index, 0);
  assert.match(document.querySelector('.sheet[data-key="42:0:0"] [data-recipe]').innerHTML, /sheet-recipe-loading/);

  runOps[0].options.render({ ok: true, recipe: { summary: "Done <now>" }, cached: false });
  assert.equal(plan.parsed.days[0].meals[0].recipe.summary, "Done <now>");
  assert.deepEqual(invalidations, ["meals:plans"]);
  const recipeWrap = document.querySelector('.sheet[data-key="42:0:0"] [data-recipe]');
  assert.match(recipeWrap.innerHTML, /Done &lt;now&gt;/);
  assert.equal(recipeWrap.classList.contains("meal-settled"), true);
});

test("meal recipe controller restores CTA on failure and closes the sheet", () => {
  const { context, document, runOps, toasts } = loadMealRecipeController();
  const plan = { id: 7, parsed: { days: [{ day: "Tuesday", meals: [{ meal: "Lunch", items: "salad" }] }] } };

  context.CairnMealRecipeController.openMealSheet(plan, 0, 0);
  document.querySelector(".sheet").querySelector("[data-recipe]").querySelector("[data-getrecipe]").click();
  runOps[0].options.onFail(null);

  const recipeWrap = document.querySelector('.sheet[data-key="7:0:0"] [data-recipe]');
  assert.match(recipeWrap.innerHTML, /data-getrecipe/);
  assert.deepEqual(toasts, ["Coach couldn't write the recipe — try again"]);
  recipeWrap.querySelector("[data-getrecipe]").click();
  assert.equal(runOps.length, 2);

  context.closeMealSheet(true);
  assert.equal(document.querySelector(".sheet"), null);
  assert.equal(document.body.classList.contains("sheet-open"), false);
});

test("meal recipe controller reconnects only when the matching sheet is open", () => {
  const plan = { id: 9, parsed: { days: [{ day: "Friday", meals: [{ meal: "Dinner" }] }] } };
  const cached = { data: [plan] };
  const { context, document, invalidations, captions } = loadMealRecipeController({ cached, reducedMotion: false });

  assert.equal(context.reconnectRecipe({ input: { id: 9, day: "Friday", meal_index: 0 } }), null);

  context.CairnMealRecipeController.openMealSheet(plan, 0, 0);
  const handlers = context.reconnectRecipe({ input: { id: 9, day: "Friday", meal_index: 0 } });

  assert.ok(handlers);
  const recipeWrap = document.querySelector('.sheet[data-key="9:0:0"] [data-recipe]');
  assert.match(recipeWrap.innerHTML, /sheet-recipe-loading/);
  assert.equal(recipeWrap.classList.contains("is-thinking"), true);

  handlers.onDone({ ok: true, recipe: { summary: "Cached recipe" }, cached: true });
  assert.equal(captions[0].stopped, true);
  assert.equal(recipeWrap.classList.contains("is-thinking"), false);
  assert.match(recipeWrap.innerHTML, /Cached recipe/);
  assert.deepEqual(invalidations, []);
});
