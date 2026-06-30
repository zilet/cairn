// @ts-check
// Pure recipe rendering for the Plan -> Meals bottom sheet.

type MealRecipeIngredient = {
  item?: unknown;
  qty?: unknown;
};

type MealRecipe = {
  summary?: unknown;
  time_min?: unknown;
  servings?: unknown;
  ingredients?: unknown;
  steps?: unknown;
  tips?: unknown;
};

(() => {
function recipeRecord(value: unknown): MealRecipe | null {
  return value && typeof value === "object" ? value as MealRecipe : null;
}

function recipeIngredientItem(value: unknown): string {
  if (value && typeof value === "object") return String((value as MealRecipeIngredient).item ?? "");
  return String(value ?? "");
}

function recipeIngredientQty(value: unknown): string {
  return value && typeof value === "object" ? String((value as MealRecipeIngredient).qty ?? "") : "";
}

function mealRecipeCtaHtml(): string {
  return `<div class="sheet-section sheet-section-c">
      <div class="lbl">Recipe</div>
      <button class="pillbtn pill-accent sheet-recipe-cta" data-getrecipe>Get the recipe from the coach</button>
      <div class="sheet-recipe-note">Written for this exact meal &mdash; can take 15&ndash;120s.</div>
    </div>`;
}

// recipe = { summary, time_min, servings, ingredients:[{item,qty}], steps:[], tips:[] }
function mealRecipeHtml(recipe: unknown): string {
  const r = recipeRecord(recipe);
  if (!r) return "";
  const chips = [
    r.time_min ? CairnUi.sheetChipHtml({ value: r.time_min, label: "min" }) : "",
    r.servings ? CairnUi.sheetChipHtml({ label: `serves ${r.servings}` }) : "",
  ].join("");
  const ingredients = Array.isArray(r.ingredients) && r.ingredients.length
    ? `<div class="sheet-section"><div class="lbl">Ingredients</div>
        <div class="recipe-ings">${r.ingredients.map((ingredient) => `
          <div class="recipe-ing"><span class="recipe-ing-item">${escHtml(recipeIngredientItem(ingredient))}</span><span class="recipe-ing-qty">${escHtml(recipeIngredientQty(ingredient))}</span></div>`).join("")}</div></div>`
    : "";
  const steps = Array.isArray(r.steps) && r.steps.length
    ? `<div class="sheet-section"><div class="lbl">Method</div>
        <ol class="recipe-steps">${r.steps.map((step) => `<li>${escHtml(String(step))}</li>`).join("")}</ol></div>`
    : "";
  const tips = Array.isArray(r.tips) && r.tips.length
    ? `<div class="sheet-section"><div class="lbl">Tips</div>
        <div class="recipe-tips">${r.tips.map((tip) => `<div class="recipe-tip">${escHtml(String(tip))}</div>`).join("")}</div></div>`
    : "";
  return `${r.summary ? `<div class="recipe-lede">${escHtml(r.summary)}</div>` : ""}
    ${chips ? `<div class="recipe-meta">${chips}</div>` : ""}
    ${ingredients}${steps}${tips}`;
}

// A calm recipe-loading state inside the [data-recipe] wrapper - the .job-cap
// carries the evolving "writing the recipe" caption; the host gets the filament.
function mealRecipeLoadingHtml(): string {
  return `<div class="sheet-section sheet-section-c sheet-recipe-loading">
      <span class="aspin aspin-sm" aria-hidden="true"></span>
      ${CairnUi.jobCaptionHtml({ tag: "div", className: "sheet-recipe-load-line job-cap" })}
    </div>`;
}

const CAIRN_MEAL_RECIPE = {
  ctaHtml: mealRecipeCtaHtml,
  recipeHtml: mealRecipeHtml,
  loadingHtml: mealRecipeLoadingHtml,
};

Object.assign(globalThis, { CairnMealRecipe: CAIRN_MEAL_RECIPE });

if (typeof window !== "undefined") {
  window.CairnMealRecipe = CAIRN_MEAL_RECIPE;
}
})();
