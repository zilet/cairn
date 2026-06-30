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
