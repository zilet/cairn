// Deterministic nutrition safety checks shared by every meal/target write path.
// Prompt instructions are useful guidance, but are not an authorization boundary.

const ABSOLUTE_KCAL_FLOOR = 1500;

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

function rulesFor(declared: unknown): AllergenRule[] {
  const text = normalize(declared);
  if (!text || /^(none|none known|no known (active )?(food )?allergies|nkda)$/.test(text)) return [];
  const rules: AllergenRule[] = [];
  const known = new Set<string>();
  for (const group of ALLERGEN_GROUPS) {
    if (!group.declarations.some((term) => hasPhrase(text, term))) continue;
    rules.push({ label: group.label, ingredients: group.ingredients });
    for (const term of group.declarations) known.add(normalize(term));
  }
  // Preserve uncommon food allergies without pretending to interpret arbitrary
  // prose: short list clauses (for example "kiwi") become exact exclusions.
  for (const raw of String(declared ?? "").split(/[,;\n/]|\band\b|&/i)) {
    const term = normalize(raw)
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
