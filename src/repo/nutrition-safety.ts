import {
  canonicalHardDietKeys,
  hardDietFreeRemainder,
  type HardDietKey,
  normalizeHardDietKeys,
} from "./dietary-constraints.js";

// Deterministic nutrition safety checks shared by every meal/target write path.
// Prompt instructions are useful guidance, but are not an authorization boundary.

const ABSOLUTE_KCAL_FLOOR = 1500;

// A weekly plan is an actionable prescription, so its headline target must be
// true in the meals themselves. Ten percent accommodates ordinary recipe and
// portion rounding without allowing a target to launder a materially underfed
// day. The absolute allowances keep small protein targets / round kcal labels
// from failing over single-digit noise. Both bounds are symmetric: large
// overages are also a mismatch that should be re-drafted, not hidden by metadata.
export const MEAL_PLAN_KCAL_TOLERANCE_FRACTION = 0.1;
export const MEAL_PLAN_PROTEIN_TOLERANCE_FRACTION = 0.1;
const MEAL_PLAN_MIN_KCAL_TOLERANCE = 100;
const MEAL_PLAN_MIN_PROTEIN_TOLERANCE = 10;

export interface MealPlanAdequacyDay {
  day: string;
  kcal: number;
  protein_g: number;
  // Null means at least one meal on the day has no fiber estimate. Missing
  // nutrition data is not the same thing as a measured zero.
  fiber_g: number | null;
}

export type MealPlanAdequacy =
  | { ok: true; checked: boolean; fiber_checked: boolean; days: MealPlanAdequacyDay[] }
  | { ok: false; checked: true; fiber_checked: boolean; error: string; days: MealPlanAdequacyDay[] };

export const MEAL_PLAN_FIBER_FLOOR_G = 30;
export const MEAL_PLAN_FIBER_MIN_DAY_FRACTION = 0.8;

function plannedDayTotals(parsed: any): MealPlanAdequacyDay[] {
  return (Array.isArray(parsed?.days) ? parsed.days : []).map((day: any, index: number) => {
    const meals = Array.isArray(day?.meals) ? day.meals : [];
    const fiberTracked =
      meals.length > 0 &&
      meals.every((meal: any) => {
        if (meal?.fiber_g == null || meal.fiber_g === "") return false;
        const value = Number(meal.fiber_g);
        return Number.isFinite(value) && value >= 0;
      });
    return {
      day:
        String(day?.day ?? "")
          .trim()
          .slice(0, 40) || `Day ${index + 1}`,
      kcal: Math.round(meals.reduce((sum: number, meal: any) => sum + (Number(meal?.kcal) || 0), 0)),
      protein_g: Math.round(meals.reduce((sum: number, meal: any) => sum + (Number(meal?.protein_g) || 0), 0)),
      fiber_g: fiberTracked
        ? Math.round(meals.reduce((sum: number, meal: any) => sum + Number(meal.fiber_g), 0))
        : null,
    };
  });
}

/**
 * Validate a complete weekly plan against its canonical headline targets.
 *
 * Partial historical/manual artifacts are left readable for backward
 * compatibility; the agent contract always requires 5-7 days, so every new
 * agent-produced weekly plan is checked before it can persist or enter autonomy.
 */
export function assessMealPlanAdequacy(parsed: any): MealPlanAdequacy {
  const days = plannedDayTotals(parsed);
  const fiberTracked = days.length > 0 && days.every((day) => day.fiber_g != null);
  const fiberWasVerified = parsed?.quality_validation?.fiber?.status === "verified";
  if (days.length < 5 || days.length > 7) return { ok: true, checked: false, fiber_checked: false, days };

  const targetKcal = Number(parsed?.daily_kcal);
  const targetProtein = Number(parsed?.daily_protein_g);
  if (!Number.isFinite(targetKcal) || targetKcal <= 0 || !Number.isFinite(targetProtein) || targetProtein <= 0) {
    return {
      ok: false,
      checked: true,
      fiber_checked: false,
      error: "Meal plan rejected: complete weeks require positive daily calorie and protein targets.",
      days,
    };
  }

  const kcalTolerance = Math.max(
    MEAL_PLAN_MIN_KCAL_TOLERANCE,
    Math.round(targetKcal * MEAL_PLAN_KCAL_TOLERANCE_FRACTION)
  );
  const proteinTolerance = Math.max(
    MEAL_PLAN_MIN_PROTEIN_TOLERANCE,
    Math.round(targetProtein * MEAL_PLAN_PROTEIN_TOLERANCE_FRACTION)
  );
  const mismatch = days.find(
    (day) =>
      Math.abs(day.kcal - targetKcal) > kcalTolerance || Math.abs(day.protein_g - targetProtein) > proteinTolerance
  );
  if (mismatch) {
    return {
      ok: false,
      checked: true,
      fiber_checked: false,
      error: `Meal plan rejected: ${mismatch.day} totals ${mismatch.kcal} kcal and ${mismatch.protein_g} g protein, outside the daily target tolerance around ${Math.round(targetKcal)} kcal and ${Math.round(targetProtein)} g protein.`,
      days,
    };
  }

  // Legacy plans without fiber estimates remain readable and explicitly marked
  // unverified by the persistence boundary. New agent-produced plans declare
  // daily_fiber_g and per-meal fiber_g, so they must satisfy BOTH a 30 g weekly
  // average and a 24 g minimum day. The small day-to-day allowance is practical
  // without letting one very high-fiber day launder six low-fiber ones.
  if (!fiberTracked) {
    if (fiberWasVerified) {
      return {
        ok: false,
        checked: true,
        fiber_checked: false,
        error:
          "Meal plan rejected: a previously fiber-verified week cannot omit a meal fiber estimate; supply the missing estimate or re-draft the plan.",
        days,
      };
    }
    return { ok: true, checked: true, fiber_checked: false, days };
  }
  const rawFiberTarget = Number(parsed?.daily_fiber_g);
  if (!Number.isFinite(rawFiberTarget) || rawFiberTarget <= 0) {
    return {
      ok: false,
      checked: true,
      fiber_checked: true,
      error: "Meal plan rejected: a fiber-tracked week requires a positive daily_fiber_g target.",
      days,
    };
  }
  const fiberTarget = Math.max(MEAL_PLAN_FIBER_FLOOR_G, Math.round(rawFiberTarget));
  const averageFiber = days.reduce((sum, day) => sum + Number(day.fiber_g), 0) / days.length;
  const minimumDay = Math.round(fiberTarget * MEAL_PLAN_FIBER_MIN_DAY_FRACTION);
  const lowDay = days.find((day) => Number(day.fiber_g) < minimumDay);
  if (averageFiber < fiberTarget || lowDay) {
    const detail = lowDay
      ? `${lowDay.day} totals ${lowDay.fiber_g} g fiber, below the ${minimumDay} g minimum day`
      : `the week averages ${Math.round(averageFiber * 10) / 10} g fiber/day`;
    return {
      ok: false,
      checked: true,
      fiber_checked: true,
      error: `Meal plan rejected: ${detail}; a fiber-tracked week must average at least ${fiberTarget} g/day with no day below ${minimumDay} g.`,
      days,
    };
  }
  return { ok: true, checked: true, fiber_checked: true, days };
}

export function clampNutritionFloors<T extends Record<string, any>>(
  value: T,
  keys: { kcal: string; protein: string },
  goal?: any
): T {
  const out: Record<string, any> = { ...value };
  const recommendedKcal = Number(goal?.ok ? goal.recommended?.target_intake_kcal : Number.NaN);
  const recommendedProtein = Number(goal?.ok ? goal.recommended?.protein_g : Number.NaN);
  const kcalFloor = Math.max(ABSOLUTE_KCAL_FLOOR, Number.isFinite(recommendedKcal) ? Math.round(recommendedKcal) : 0);
  const proteinFloor =
    Number.isFinite(recommendedProtein) && recommendedProtein > 0 ? Math.round(recommendedProtein) : null;

  const rawKcal = out[keys.kcal];
  const kcal = Number(rawKcal);
  if (rawKcal != null && rawKcal !== "" && Number.isFinite(kcal) && kcal < kcalFloor) out[keys.kcal] = kcalFloor;

  const rawProtein = out[keys.protein];
  const protein = Number(rawProtein);
  if (
    rawProtein != null &&
    rawProtein !== "" &&
    proteinFloor != null &&
    Number.isFinite(protein) &&
    protein < proteinFloor
  ) {
    out[keys.protein] = proteinFloor;
  }
  return out as T;
}

type AllergenRule = { label: string; ingredients: string[] };

export interface DietaryDeclarations {
  restrictions?: unknown;
  mealPrefs?: unknown;
  // Current-turn task/hint. Unlike durable profile restrictions, only an explicit
  // global instruction is promoted; negations and soft/occasional preferences stay soft.
  instruction?: unknown;
  hardDietKeys?: unknown;
}

type DietRule = {
  key: string;
  label: string;
  excluded: string[];
  warning?: string;
};

const ALLERGEN_GROUPS: Array<AllergenRule & { declarations: string[] }> = [
  {
    label: "peanut",
    declarations: ["peanut", "peanuts"],
    ingredients: ["peanut", "peanuts", "groundnut", "groundnuts"],
  },
  {
    label: "tree nuts",
    declarations: ["tree nut", "tree nuts", "nut", "nuts"],
    ingredients: [
      "almond",
      "almonds",
      "cashew",
      "cashews",
      "walnut",
      "walnuts",
      "pecan",
      "pecans",
      "pistachio",
      "pistachios",
      "hazelnut",
      "hazelnuts",
      "macadamia",
      "brazil nut",
      "brazil nuts",
    ],
  },
  {
    label: "shellfish",
    declarations: ["shellfish", "crustacean", "crustaceans"],
    ingredients: ["shrimp", "prawn", "prawns", "crab", "lobster", "crayfish", "crawfish"],
  },
  {
    label: "fish",
    declarations: ["fish"],
    ingredients: [
      "fish",
      "salmon",
      "tuna",
      "cod",
      "sardine",
      "sardines",
      "mackerel",
      "anchovy",
      "anchovies",
      "trout",
      "tilapia",
      "halibut",
    ],
  },
  {
    label: "milk/dairy",
    declarations: ["milk", "dairy", "lactose"],
    ingredients: ["milk", "cream", "butter", "cheese", "yogurt", "yoghurt", "whey", "casein", "ghee", "lactose"],
  },
  { label: "egg", declarations: ["egg", "eggs"], ingredients: ["egg", "eggs", "albumen", "mayonnaise", "mayo"] },
  {
    label: "wheat/gluten",
    declarations: ["wheat", "gluten"],
    ingredients: ["wheat", "gluten", "barley", "rye", "seitan"],
  },
  { label: "soy", declarations: ["soy", "soya"], ingredients: ["soy", "soya", "tofu", "tempeh", "edamame", "miso"] },
  { label: "sesame", declarations: ["sesame"], ingredients: ["sesame", "tahini"] },
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasPhrase(text: unknown, phrase: string): boolean {
  const haystack = ` ${normalize(text)} `;
  const needle = ` ${normalize(phrase)} `;
  return needle.length > 2 && haystack.includes(needle);
}

function phraseOccurrences(text: string, phrase: string): number[] {
  const haystack = ` ${normalize(text)} `;
  const needle = ` ${normalize(phrase)} `;
  const out: number[] = [];
  if (needle.length <= 2) return out;
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    // `haystack` and `needle` both have one leading boundary space, so the
    // needle's boundary index is already the phrase's index in normalized text.
    out.push(index);
    from = index + needle.length - 1;
  }
  return out;
}

function allergenMentionIsNegated(text: string, index: number): boolean {
  const prefix = normalize(text).slice(Math.max(0, index - 80), index).trimEnd();
  return (
    /\b(?:not|no)\s*(?:(?:known|active|food)\s+)*(?:(?:allergic|allergy|allergies)\s+(?:to\s*)?)?$/.test(prefix) ||
    /\b(?:do not|does not|dont|doesnt|isnt|arent)\s*(?:have\s+)?(?:(?:an|any|known|active|food)\s+)*(?:(?:allergic|allergy|allergies)\s+(?:to\s*)?)?$/.test(
      prefix
    )
  );
}

const MEAT_AND_POULTRY = [
  "beef",
  "steak",
  "veal",
  "pork",
  "bacon",
  "ham",
  "prosciutto",
  "sausage",
  "lamb",
  "mutton",
  "chicken",
  "turkey",
  "duck",
  "gelatin",
  "gelatine",
];
const FISH_AND_SEAFOOD = [
  "fish",
  "salmon",
  "tuna",
  "cod",
  "sardine",
  "sardines",
  "mackerel",
  "trout",
  "tilapia",
  "halibut",
  "anchovy",
  "anchovies",
  "shrimp",
  "prawn",
  "prawns",
  "crab",
  "lobster",
  "shellfish",
];
const DAIRY_AND_EGGS = [
  "milk",
  "cream",
  "butter",
  "cheese",
  "yogurt",
  "yoghurt",
  "whey",
  "casein",
  "ghee",
  "egg",
  "eggs",
  "mayonnaise",
  "mayo",
];

// Deliberately bounded to identities whose exclusions can be checked from a
// dish name / ingredient list. Religious sourcing and macro-pattern diets get
// partial checks plus an explicit warning instead of a false "verified" claim.
const DIET_RULES: DietRule[] = [
  {
    key: "vegan",
    label: "vegan",
    excluded: [...MEAT_AND_POULTRY, ...FISH_AND_SEAFOOD, ...DAIRY_AND_EGGS, "honey"],
  },
  {
    key: "vegetarian",
    label: "vegetarian",
    excluded: [...MEAT_AND_POULTRY, ...FISH_AND_SEAFOOD],
  },
  {
    key: "pescatarian",
    label: "pescatarian",
    excluded: MEAT_AND_POULTRY,
  },
  {
    key: "dairy_free",
    label: "dairy-free",
    excluded: DAIRY_AND_EGGS.slice(0, 9),
  },
  {
    key: "gluten_free",
    label: "gluten-free",
    excluded: ["wheat", "gluten", "barley", "rye", "seitan"],
  },
  {
    key: "halal",
    label: "halal",
    excluded: ["pork", "bacon", "ham", "prosciutto", "lard", "alcohol", "wine", "beer"],
    warning:
      "Halal ingredient sourcing and certification cannot be verified from meal labels alone; review the ingredient brands and preparation.",
  },
  {
    key: "kosher",
    label: "kosher",
    excluded: ["pork", "bacon", "ham", "prosciutto", "lard", "shellfish", "shrimp", "prawn", "crab", "lobster"],
    warning:
      "Kosher certification, kitchen separation, and meat/dairy preparation cannot be fully verified from meal labels alone; review preparation details.",
  },
];

const UNVERIFIABLE_DIETS = [{ label: "keto" }, { label: "paleo" }, { label: "carnivore" }];

export function explicitDietaryTaskDeclarations(value: unknown): string {
  return canonicalHardDietKeys(value, "instruction").join(" ");
}

function dietRulesFor(declared: DietaryDeclarations): DietRule[] {
  const keys = new Set<HardDietKey>([
    ...canonicalHardDietKeys(declared?.restrictions, "authoritative"),
    ...canonicalHardDietKeys(declared?.mealPrefs, "meal_prefs"),
    ...canonicalHardDietKeys(declared?.instruction, "instruction"),
    ...normalizeHardDietKeys(declared?.hardDietKeys),
  ]);
  return DIET_RULES.filter((rule) => keys.has(rule.key as HardDietKey));
}

function dietWarningsFor(declared: DietaryDeclarations, rules: DietRule[]): string[] {
  const warnings = rules.flatMap((rule) => (rule.warning ? [rule.warning] : []));
  const keys = new Set<HardDietKey>([
    ...canonicalHardDietKeys(declared?.restrictions, "authoritative"),
    ...canonicalHardDietKeys(declared?.mealPrefs, "meal_prefs"),
    ...canonicalHardDietKeys(declared?.instruction, "instruction"),
    ...normalizeHardDietKeys(declared?.hardDietKeys),
  ]);
  for (const diet of UNVERIFIABLE_DIETS) {
    if (keys.has(diet.label as HardDietKey)) {
      warnings.push(
        `${diet.label[0].toUpperCase()}${diet.label.slice(1)} compliance cannot be deterministically verified from meal labels and macro estimates; review the plan manually.`
      );
    }
  }
  const unverifiedRemainder = hardDietFreeRemainder(declared?.restrictions)
    .replace(/\b(?:dietary restriction)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (unverifiedRemainder) {
    warnings.push(
      `The declared dietary restriction "${unverifiedRemainder.slice(0, 120)}" was included in planning but cannot be deterministically verified from meal labels; review the plan manually.`
    );
  }
  return [...new Set(warnings)];
}

function dietIngredientAppears(text: unknown, ingredient: string): boolean {
  let candidate = normalize(text);
  const normalizedIngredient = normalize(ingredient);
  // Compliance labels describe the absence of gluten; they are not themselves
  // evidence that gluten is present. Remove only the label phrase. Any actual
  // wheat/barley/rye/seitan named alongside it remains visible and is rejected.
  candidate = ` ${candidate} `
    .replace(/\b(?:certified\s+)?gluten\s+free\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const prefix of ["vegan", "plant based", "meatless", "dairy free", "non dairy", "egg free"]) {
    const qualified = `${prefix} ${normalizedIngredient}`;
    candidate = ` ${candidate} `.replaceAll(` ${qualified} `, " ").trim();
  }
  return hasPhrase(candidate, normalizedIngredient);
}

function assertDietTextsSafe(texts: unknown[], location: string, rules: DietRule[]): void {
  for (const rule of rules) {
    for (const text of texts) {
      const found = rule.excluded.find((ingredient) => dietIngredientAppears(text, ingredient));
      if (found) throw new Error(`${location} rejected: violates declared ${rule.label} diet (${found})`);
    }
  }
}

function recipeTexts(recipe: any): unknown[] {
  const ingredients = Array.isArray(recipe?.ingredients)
    ? recipe.ingredients.map((ingredient: any) => ingredient?.item)
    : [];
  return [recipe?.summary, ...ingredients, ...(recipe?.steps ?? []), ...(recipe?.tips ?? [])];
}

export function assertMealDietarySafe(meal: any, declared: DietaryDeclarations, location: string): string[] {
  const rules = dietRulesFor(declared);
  assertDietTextsSafe([meal?.name, meal?.items], location, rules);
  if (meal?.recipe) assertDietTextsSafe(recipeTexts(meal.recipe), `${location} recipe`, rules);
  return dietWarningsFor(declared, rules);
}

export function assertRecipeDietarySafe(recipe: any, declared: DietaryDeclarations, location: string): string[] {
  const rules = dietRulesFor(declared);
  assertDietTextsSafe(recipeTexts(recipe), location, rules);
  return dietWarningsFor(declared, rules);
}

export function assertPlanDietarySafe(parsed: any, declared: DietaryDeclarations): string[] {
  const rules = dietRulesFor(declared);
  if (parsed && typeof parsed === "object") {
    for (const day of Array.isArray(parsed.days) ? parsed.days : []) {
      for (const [index, meal] of (Array.isArray(day?.meals) ? day.meals : []).entries()) {
        const location = `${
          String(day?.day ?? "")
            .trim()
            .slice(0, 40) || "meal plan"
        } meal ${index + 1}`;
        assertDietTextsSafe([meal?.name, meal?.items], location, rules);
        if (meal?.recipe) assertDietTextsSafe(recipeTexts(meal.recipe), `${location} recipe`, rules);
      }
    }
    assertDietTextsSafe(Array.isArray(parsed.shopping) ? parsed.shopping : [], "shopping list", rules);
  }
  return dietWarningsFor(declared, rules);
}

function rulesFor(declared: unknown): AllergenRule[] {
  const raw = String(declared ?? "");
  const text = normalize(raw);
  if (!text || /^(none|none known|no known (active )?(food )?allergies|nkda)$/.test(text)) return [];
  const rules: AllergenRule[] = [];
  const known = new Set<string>();
  for (const group of ALLERGEN_GROUPS) {
    let positive = false;
    for (const term of group.declarations) {
      const occurrences = phraseOccurrences(raw, term);
      if (occurrences.length) known.add(normalize(term));
      if (occurrences.some((index) => !allergenMentionIsNegated(raw, index))) positive = true;
    }
    if (positive) rules.push({ label: group.label, ingredients: group.ingredients });
  }
  // Preserve uncommon food allergies without pretending to interpret arbitrary
  // prose: short list clauses (for example "kiwi") become exact exclusions.
  for (const rawClause of raw.split(/[,;\n/]|\b(?:and|but)\b|&/i)) {
    const clause = normalize(rawClause);
    if (
      /\b(?:not|no)\s+(?:(?:known|active|food)\s+)*(?:(?:allergic|allergy|allergies)\s+(?:to\s+)?)?/.test(
        clause
      )
    )
      continue;
    const term = clause
      .replace(/\b(allergy|allergies|allergic|anaphylaxis|anaphylactic|severe|mild|to)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!term || term.length > 40 || known.has(term)) continue;
    if (ALLERGEN_GROUPS.some((group) => group.declarations.some((declaration) => hasPhrase(term, declaration))))
      continue;
    rules.push({ label: term, ingredients: [term] });
  }
  return rules;
}

// Stable, order-insensitive representation of the user-declared allergy rules.
// This deliberately reuses the exact parser that guards plan writes/recipes so
// freshness fingerprints cannot disagree with enforcement. It returns labels,
// never the original free text, which also keeps the stored provenance bounded.
export function canonicalAllergyKeys(declared: unknown): string[] {
  return [...new Set(rulesFor(declared).map((rule) => normalize(rule.label)).filter(Boolean))].sort();
}

function assertTextsSafe(texts: unknown[], location: string, rules: AllergenRule[]): void {
  for (const rule of rules) {
    for (const text of texts) {
      const found = rule.ingredients.find((ingredient) => hasPhrase(text, ingredient));
      if (found) throw new Error(`${location} rejected: contains declared allergen ${rule.label} (${found})`);
    }
  }
}

function assertRecipeSafe(recipe: any, location: string, rules: AllergenRule[]): void {
  const ingredients = Array.isArray(recipe?.ingredients)
    ? recipe.ingredients.map((ingredient: any) => ingredient?.item)
    : [];
  assertTextsSafe(
    [recipe?.summary, ...ingredients, ...(recipe?.steps ?? []), ...(recipe?.tips ?? [])],
    location,
    rules
  );
}

export function assertMealAllergenSafe(meal: any, declared: unknown, location: string): void {
  const rules = rulesFor(declared);
  if (!rules.length) return;
  assertTextsSafe([meal?.name, meal?.items], location, rules);
  if (meal?.recipe) assertRecipeSafe(meal.recipe, `${location} recipe`, rules);
}

export function assertRecipeAllergenSafe(recipe: any, declared: unknown, location: string): void {
  const rules = rulesFor(declared);
  if (rules.length) assertRecipeSafe(recipe, location, rules);
}

export function assertPlanAllergenSafe(parsed: any, declared: unknown): void {
  const rules = rulesFor(declared);
  if (!rules.length || !parsed || typeof parsed !== "object") return;
  for (const day of Array.isArray(parsed.days) ? parsed.days : []) {
    for (const [index, meal] of (Array.isArray(day?.meals) ? day.meals : []).entries()) {
      const location = `${
        String(day?.day ?? "")
          .trim()
          .slice(0, 40) || "meal plan"
      } meal ${index + 1}`;
      assertTextsSafe([meal?.name, meal?.items], location, rules);
      if (meal?.recipe) assertRecipeSafe(meal.recipe, `${location} recipe`, rules);
    }
  }
  assertTextsSafe(Array.isArray(parsed.shopping) ? parsed.shopping : [], "shopping list", rules);
}
