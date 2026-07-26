// The ONE food-capture contract.
//
// Three surfaces ask an agent to describe a meal — free-text enrichment
// (src/prompt/enrich.ts), the chat `log_food` action (src/chatActions.ts) and the
// plate-photo vision read (src/prompt/enrich.ts) — and each used to declare its own
// JSON shape. They drifted: chat never asked for nutrition_pattern at all, the photo
// path (where the portion is INFERRED and structure matters most) never asked for
// ingredient rows, none asked for ingredient-level fiber, and only the photo path
// carried any provenance. This module declares that shape ONCE, as prompt fragments
// plus the coercion every path runs a returned payload through, so a fourth copy
// cannot quietly appear.
//
// CAPTURE DEPTH ≫ DISPLAY DEPTH. Everything here exists to feed the brain and to let
// intake be correlated against bloodwork (sodium↔BP, saturated fat↔LDL, added
// sugar↔HbA1c, iron↔ferritin, omega-3↔inflammation). Nothing here decides what a
// surface renders.
//
// The one rule that makes the extra depth safe: an ESTIMATE MUST NEVER BECOME
// INDISTINGUISHABLE FROM A MEASUREMENT. Every entry carries `confidence` and
// `basis`, and every capture path supplies a conservative fallback basis describing
// how it actually obtained the numbers, so a stated 205 g and a guess off a picture
// never read the same downstream.

export const FOOD_CONFIDENCE_BANDS = ["low", "medium", "high"] as const;
export type FoodConfidence = (typeof FOOD_CONFIDENCE_BANDS)[number];

// How a number was obtained. Deliberately the SAME vocabulary the stored
// nutrition_pattern already uses (src/repo/nutrition-progress.ts counts these
// bands), so entry-level and pattern-level provenance are one register.
export const FOOD_BASIS_VALUES = ["label", "user_report", "estimated_from_foods", "photo"] as const;
export type FoodBasis = (typeof FOOD_BASIS_VALUES)[number];

export const FOOD_MACRO_KEYS = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const;
export type FoodMacroKey = (typeof FOOD_MACRO_KEYS)[number];

// Ceilings one meal cannot honestly exceed. Shared so the chat lane, the text
// enricher and the photo enricher clamp identically.
export const FOOD_MACRO_CEILINGS: Record<FoodMacroKey, number> = {
  kcal: 5000,
  protein_g: 500,
  carbs_g: 1000,
  fat_g: 500,
  fiber_g: 200,
};

const MAX_INGREDIENTS = 50;
const MAX_ITEMS = 50;
const TEXT_CAP = 200;

export const FOOD_CONFIDENCE_SCHEMA = FOOD_CONFIDENCE_BANDS.join("|");
export const FOOD_BASIS_SCHEMA = FOOD_BASIS_VALUES.join("|");

// ---- prompt fragments (declared once, interpolated by all three contracts) ----

// One ingredient row. The QUANTITY IS A FIELD, not prose folded into the name —
// that is the whole reason the photo path's old `items: ["scrambled eggs (~2 eggs)"]`
// could not be reasoned over.
export const FOOD_INGREDIENT_SCHEMA =
  `{ "item": "<ingredient>", "amount": "<quantity as its own field, e.g. '205 g' / '2 eggs' / '1 cup'>",
        "kcal": <number|null>, "protein_g": <number|null>, "carbs_g": <number|null>, "fat_g": <number|null>, "fiber_g": <number|null>,
        "basis": "${FOOD_BASIS_SCHEMA}|null" }`;

// Coarse pattern bands — the fields that correlate with a blood panel. Never
// invented micronutrient milligrams.
export const FOOD_NUTRITION_PATTERN_SCHEMA = `{
      "sodium": "low|moderate|high|unknown", "potassium": "low|moderate|high|unknown",
      "calcium": "low|moderate|high|unknown", "iron": "low|moderate|high|unknown",
      "saturated_fat": "low|moderate|high|unknown", "added_sugar": "low|moderate|high|unknown",
      "saturated_fat_g": <number|null>, "unsaturated_fat_g": <number|null>,
      "omega_3_source": <boolean|null>, "alcohol_servings": <number|null>,
      "caffeine_mg": <number|null>, "caffeine_time": <string|null>,
      "food_quality": "mostly_whole|mixed|mostly_ultra_processed|unknown",
      "confidence": "${FOOD_CONFIDENCE_SCHEMA}", "basis": "${FOOD_BASIS_SCHEMA}"
    }`;

// Entry-level provenance. Every capture path emits it.
export const FOOD_PROVENANCE_SCHEMA = `"confidence": "${FOOD_CONFIDENCE_SCHEMA}", "basis": "${FOOD_BASIS_SCHEMA}"`;

// The guardrails that belong to the SHAPE rather than to one surface. Each prompt
// keeps its own surface-specific prose (a photo can't show hidden oil; a text note
// may name a cooking method) and adds these.
export const FOOD_CAPTURE_GUARDRAILS = [
  `Break the meal into ingredient ROWS and put the quantity in "amount" as its own field — "205 g" belongs in amount, never folded into the item name. Estimate each row's macros INCLUDING fiber_g so the meal total is built up from its parts instead of guessed from the top down; null any row value you genuinely cannot estimate rather than inventing one.`,
  `"confidence" and "basis" record HOW the numbers were obtained and must be honest: "label" = read off a package or menu label, "user_report" = the athlete stated the quantity or the macros, "estimated_from_foods" = inferred from ordinary serving sizes, "photo" = inferred from the picture. A stated or weighed quantity is high confidence; anything you inferred is low or medium. An estimate must never be made to look like a measurement.`,
  `Give an ingredient row its own "basis" only when it differs from the meal's — a weighed chicken breast next to an eyeballed scoop of rice is exactly the case worth recording. Otherwise leave it null.`,
  `Use nutrition_pattern for COARSE bands, not invented micronutrient milligrams. Alcohol and caffeine stay null unless the meal actually identifies them.`,
] as const;

export function foodCaptureGuardrailLines(): string {
  return FOOD_CAPTURE_GUARDRAILS.map((line) => `- ${line}`).join("\n");
}

// ---- coercion (shared by every path that stores a food estimate) ----

const asNum = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const asStr = (v: unknown, cap = 1000): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, cap) : undefined;
};

// Clamp a meal total to a non-negative integer under its shared ceiling.
export function clampFoodMacro(key: FoodMacroKey, n: number): number {
  return Math.min(FOOD_MACRO_CEILINGS[key], Math.max(0, Math.round(n)));
}

// An ingredient row keeps one decimal — a 0.6 g fiber row is real, and the totals
// round at the meal level.
function clampIngredientMacro(key: FoodMacroKey, n: number): number {
  return Math.min(FOOD_MACRO_CEILINGS[key], Math.max(0, Math.round(n * 10) / 10));
}

export interface FoodIngredient {
  item: string;
  amount?: string;
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  fiber_g?: number;
  basis?: FoodBasis;
}

// Coerce an agent's ingredient array. A row with no readable item name is dropped;
// junk macros are dropped rather than stored as strings or negatives. Returns null
// when the payload carried no ingredients array at all, so a merge can tell
// "the agent said nothing" from "the agent said none".
export function coerceFoodIngredients(value: unknown): FoodIngredient[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value
    .slice(0, MAX_INGREDIENTS)
    .map((raw): FoodIngredient | null => {
      if (typeof raw === "string") {
        const item = asStr(raw, TEXT_CAP);
        return item ? { item } : null;
      }
      if (!raw || typeof raw !== "object") return null;
      const row = raw as Record<string, unknown>;
      const item = asStr(row.item ?? row.name ?? row.food, TEXT_CAP);
      if (!item) return null;
      const out: FoodIngredient = { item };
      const amount = asStr(row.amount ?? row.qty ?? row.quantity ?? row.portion, TEXT_CAP);
      if (amount !== undefined) out.amount = amount;
      for (const key of FOOD_MACRO_KEYS) {
        const n = asNum(row[key]);
        if (n !== undefined) out[key] = clampIngredientMacro(key, n);
      }
      const basis = String(row.basis ?? "").toLowerCase();
      if ((FOOD_BASIS_VALUES as readonly string[]).includes(basis)) out.basis = basis as FoodBasis;
      return out;
    })
    .filter((row): row is FoodIngredient => !!row);
  return rows;
}

// Label one component for DISPLAY. Objects collapse to "item (amount)" so a
// structured row still reads as a sentence on a surface that only shows `items`.
export function foodItemLabel(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "object") {
    const row = x as Record<string, unknown>;
    const item = asStr(row.item ?? row.name ?? row.summary ?? row.food, TEXT_CAP);
    const amount = asStr(row.amount ?? row.qty ?? row.quantity ?? row.portion, TEXT_CAP);
    if (!item) return null;
    return amount ? `${item} (${amount})`.slice(0, TEXT_CAP) : item;
  }
  const s = String(x).trim();
  return s ? s.slice(0, TEXT_CAP) : null;
}

export function coerceFoodItems(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map(foodItemLabel)
    .filter((x): x is string => !!x)
    .slice(0, MAX_ITEMS);
}

// Sum the macros the component rows actually carry. This is what lets fiber (and
// every other macro) be BUILT UP from the parts instead of guessed from the top
// down — used only as a fallback when the agent gave no meal total for that macro,
// so a stated total always wins.
export function foodMacroTotalsFrom(rows: unknown): Partial<Record<FoodMacroKey, number>> | null {
  if (!Array.isArray(rows)) return null;
  const totals: Partial<Record<FoodMacroKey, number>> = {};
  let saw = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of FOOD_MACRO_KEYS) {
      const n = asNum((row as Record<string, unknown>)[key]);
      if (n === undefined) continue;
      totals[key] = (totals[key] ?? 0) + n;
      saw = true;
    }
  }
  return saw ? totals : null;
}

export interface FoodProvenance {
  confidence: FoodConfidence;
  basis: FoodBasis;
}

// Entry-level provenance, always resolved. An absent or scored ("92%") confidence
// falls back to the honest FLOOR rather than being dropped — a missing band is
// exactly the ambiguity this field exists to remove — and an unrecognized basis
// falls back to how the calling path actually obtained the numbers.
export function coerceFoodProvenance(value: unknown, fallbackBasis: FoodBasis): FoodProvenance {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const confidence = String(row.confidence ?? "").toLowerCase();
  const basis = String(row.basis ?? "").toLowerCase();
  return {
    confidence: (FOOD_CONFIDENCE_BANDS as readonly string[]).includes(confidence)
      ? (confidence as FoodConfidence)
      : "low",
    basis: (FOOD_BASIS_VALUES as readonly string[]).includes(basis) ? (basis as FoodBasis) : fallbackBasis,
  };
}

// Coerce/clamp the coarse pattern block. Bands are enum-checked, the fat split is
// dropped when it materially exceeds total fat (no false precision), and provenance
// is always present. Returns null when the payload carried nothing but provenance.
export function coerceNutritionPattern(
  value: unknown,
  fallbackBasis: string = "estimated_from_foods",
  totalFat?: unknown
): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const out: Record<string, any> = {};
  const bands = new Set(["low", "moderate", "high", "unknown"]);
  for (const key of ["sodium", "potassium", "calcium", "iron", "saturated_fat", "added_sugar"]) {
    const band = String(row[key] ?? "").toLowerCase();
    if (bands.has(band)) out[key] = band;
  }
  for (const key of ["saturated_fat_g", "unsaturated_fat_g"] as const) {
    if (row[key] === null) {
      out[key] = null;
      continue;
    }
    const n = asNum(row[key]);
    if (n !== undefined) out[key] = Math.max(0, Math.min(300, Math.round(n * 10) / 10));
  }
  const totalFatG = asNum(totalFat);
  if (
    totalFatG !== undefined &&
    typeof out.saturated_fat_g === "number" &&
    typeof out.unsaturated_fat_g === "number" &&
    out.saturated_fat_g + out.unsaturated_fat_g > totalFatG * 1.15
  ) {
    out.saturated_fat_g = null;
    out.unsaturated_fat_g = null;
  }
  if (typeof row.omega_3_source === "boolean" || row.omega_3_source === null)
    out.omega_3_source = row.omega_3_source;
  for (const [key, max] of [
    ["alcohol_servings", 20],
    ["caffeine_mg", 2_000],
  ] as const) {
    const n = asNum(row[key]);
    if (n !== undefined) out[key] = Math.max(0, Math.min(max, Math.round(n * 10) / 10));
  }
  const caffeineTime = asStr(row.caffeine_time, 80);
  if (caffeineTime !== undefined) out.caffeine_time = caffeineTime;
  const quality = String(row.food_quality ?? "").toLowerCase();
  if (["mostly_whole", "mixed", "mostly_ultra_processed", "unknown"].includes(quality)) out.food_quality = quality;
  const provenance = coerceFoodProvenance(row, fallbackBasis as FoodBasis);
  out.confidence = provenance.confidence;
  out.basis = provenance.basis;
  // Provenance alone is not a pattern — only a block that carried at least one real
  // band or number is worth storing.
  return Object.keys(out).length > 2 ? out : null;
}

// ---- the stored blob -----------------------------------------------------------

export interface FoodCaptureInput {
  summary?: unknown;
  items?: unknown;
  ingredients?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
  nutrition_pattern?: unknown;
  confidence?: unknown;
  basis?: unknown;
  notes?: unknown;
}

// Build the parsed_json blob for a capture path that stores an agent estimate
// DIRECTLY (chat's log_food, and the photo seed a vision-capable chat agent
// produced) — as opposed to the background enrichers, which MERGE over an existing
// blob and so apply these same coercions field by field.
//
// `summary` is resolved by the caller (each lane has its own fallback chain).
// `fallbackBasis` is that lane's honest default for how it got the numbers.
export function normalizeFoodCaptureParsed(
  input: FoodCaptureInput,
  opts: { summary: string; fallbackBasis: FoodBasis }
): Record<string, unknown> {
  const items = coerceFoodItems(input.items);
  const ingredients = coerceFoodIngredients(input.ingredients);
  // Totals build up from the components when the agent gave no meal-level number,
  // so fiber is no longer a top-down guess. A stated total always wins.
  const inferred = foodMacroTotalsFrom(input.ingredients) ?? foodMacroTotalsFrom(input.items);
  const parsed: Record<string, unknown> = { summary: opts.summary };
  if (items?.length) parsed.items = items;
  if (ingredients?.length) parsed.ingredients = ingredients;
  for (const key of FOOD_MACRO_KEYS) {
    const n = asNum(input[key] ?? inferred?.[key]);
    parsed[key] = n === undefined ? null : clampFoodMacro(key, n);
  }
  const provenance = coerceFoodProvenance(input, opts.fallbackBasis);
  parsed.confidence = provenance.confidence;
  parsed.basis = provenance.basis;
  const pattern = coerceNutritionPattern(input.nutrition_pattern, provenance.basis, parsed.fat_g);
  if (pattern) parsed.nutrition_pattern = pattern;
  parsed.notes = asStr(input.notes) ?? null;
  return parsed;
}
