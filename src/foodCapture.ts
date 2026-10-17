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

import type { JsonSchema } from "./json-schema.js";

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

// ---- the ENFORCED twins of the three fragments above -------------------------
// The same shape, expressed as JSON Schema so a CLI that supports structured output
// CONSTRAINS the payload instead of merely being asked for it. Declared here, beside
// the prose fragments and off the same vocabulary constants, because the whole point
// of this module is that the food shape exists once — a schema authored over in
// agent-contracts.ts would be the fourth copy this file was written to prevent.
// Every field coerceFoodIngredients / coerceNutritionPattern / normalizeFoodCaptureParsed
// READS is named: constrained decoding drops what a schema does not mention.
export const FOOD_INGREDIENT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    item: { type: "string" },
    // coerceFoodIngredients reads `item ?? name ?? food` and
    // `amount ?? qty ?? quantity ?? portion`. The canonical spelling leads and is what
    // the prose asks for; the aliases are named so a model that reaches for one lands
    // in a slot the decoder keeps rather than losing the row's quantity.
    name: { type: ["string", "null"] },
    food: { type: ["string", "null"] },
    amount: { type: ["string", "null"] },
    qty: { type: ["string", "null"] },
    quantity: { type: ["string", "null"] },
    portion: { type: ["string", "null"] },
    kcal: { type: ["number", "null"] },
    protein_g: { type: ["number", "null"] },
    carbs_g: { type: ["number", "null"] },
    fat_g: { type: ["number", "null"] },
    fiber_g: { type: ["number", "null"] },
    basis: { type: ["string", "null"] },
  },
};

export const FOOD_NUTRITION_PATTERN_JSON_SCHEMA: JsonSchema = {
  type: ["object", "null"],
  additionalProperties: true,
  properties: {
    sodium: { type: ["string", "null"] },
    potassium: { type: ["string", "null"] },
    calcium: { type: ["string", "null"] },
    iron: { type: ["string", "null"] },
    saturated_fat: { type: ["string", "null"] },
    added_sugar: { type: ["string", "null"] },
    saturated_fat_g: { type: ["number", "null"] },
    unsaturated_fat_g: { type: ["number", "null"] },
    omega_3_source: { type: ["boolean", "null"] },
    alcohol_servings: { type: ["number", "null"] },
    caffeine_mg: { type: ["number", "null"] },
    caffeine_time: { type: ["string", "null"] },
    food_quality: { type: ["string", "null"] },
    confidence: { type: ["string", "null"] },
    basis: { type: ["string", "null"] },
  },
};

// The meal estimate itself, shared by the text enricher's `structured` node, the
// photo read's flat top level, and anything else that stores a food capture.
export const FOOD_ESTIMATE_PROPERTIES: Record<string, JsonSchema> = {
  summary: { type: ["string", "null"] },
  items: { type: "array", items: { type: "string" } },
  ingredients: { type: "array", items: FOOD_INGREDIENT_JSON_SCHEMA },
  kcal: { type: ["number", "null"] },
  protein_g: { type: ["number", "null"] },
  carbs_g: { type: ["number", "null"] },
  fat_g: { type: ["number", "null"] },
  fiber_g: { type: ["number", "null"] },
  nutrition_pattern: FOOD_NUTRITION_PATTERN_JSON_SCHEMA,
  notes: { type: ["string", "null"] },
  confidence: { type: ["string", "null"] },
  basis: { type: ["string", "null"] },
};

// Entry-level provenance. Every capture path emits it.
export const FOOD_PROVENANCE_SCHEMA = `"confidence": "${FOOD_CONFIDENCE_SCHEMA}", "basis": "${FOOD_BASIS_SCHEMA}"`;

// The guardrails that belong to the SHAPE rather than to one surface. Each prompt
// keeps its own surface-specific prose (a photo can't show hidden oil; a text note
// may name a cooking method) and adds these.
export const FOOD_CAPTURE_GUARDRAILS = [
  `Break the meal into ingredient ROWS and put the quantity in "amount" as its own field — "205 g" belongs in amount, never folded into the item name. Estimate each row's macros INCLUDING fiber_g so the meal total is built up from its parts instead of guessed from the top down; null any row value you genuinely cannot estimate rather than inventing one.`,
  `Read everyday portion words in context: "a block", "a square", or "a piece" of a chocolate bar means ONE single square/piece broken off the bar (~10 g, ~50–55 kcal), never the whole 100 g bar, unless the athlete says "whole bar/block" or states the bar's full weight.`,
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

// ---- a person's ingredient-row edit ------------------------------------------
//
// The meal card lets the athlete fix a logged meal in place: change a row's grams,
// add a row, remove a row. The note's totals then follow from the rows with NO agent
// turn — the arithmetic below is the whole of it, and it lives here beside the row
// shape it edits so the capture contract stays the one place the shape is known.
//
// THE RULES (each one deterministic):
//   1. A row's macros SCALE with its quantity, from the row's OWN estimate. The
//      reference estimate is the stored twin (matched by item name AND amount first,
//      then by item name alone — first unused stored row either way, so reordering
//      two same-named rows never swaps their estimates), else the edited row's own
//      macros at its own amount. "205 g" → "250 g" multiplies every macro by
//      250/205; "2 eggs" → "3 eggs" by 3/2. Units must agree after normalization
//      (g/kg/oz/lb → g, ml/l → ml, a count word → itself); a quantity that cannot be compared keeps the old macros and the row
//      reads low confidence, because its numbers no longer describe its amount.
//   2. Macros a person TYPES win: an edited row whose macros differ from its stored
//      twin's is taken as stated (a label read, say) and never re-scaled.
//   3. A row the person ADDED or CHANGED that has no nutrition — typically a row they
//      just typed in — stays on the meal flagged `confidence: "low"` and contributes
//      nothing, so the totals are still the sum of what is known. There is no food
//      table in Cairn to look an unknown food up in, and inventing a number here would
//      be exactly the estimate-dressed-as-measurement foodCapture exists to prevent. A
//      row the person did not touch (the agent's "salt, a pinch" left at null on
//      purpose) is not re-judged by an unrelated edit.
//   4. The meal total is the rows plus whatever the stored total carried BEYOND the
//      stored rows (the "unitemized" part — cooking oil an agent counted at meal
//      level, or a whole meal-level estimate on a note whose rows carry no macros).
//      That remainder is never negative: when the stored rows already summed past the
//      stored total, the rows are the finer truth. A macro neither the rows nor the
//      stored total ever carried stays null, never 0.
//   5. The remainder belongs to the stored rows that carry no estimate of their own
//      for that macro — all of it to a lone such row, else split by amount when every
//      one of them states a comparable amount (all grams, say). A share that can be
//      placed follows its row: it scales with the row's quantity, leaves with the row,
//      and leaves when the person types that row's own number (so it is never counted
//      twice). A share that cannot be placed stays in the remainder, and a quantity
//      change it could not follow is reported (`unfollowed`) and reads low confidence.
//   6. An EMPTY replacement list clears the breakdown only: the rows go, the meal
//      totals stay exactly as stored. Deleting the note is how "nothing was eaten" is
//      said.

export interface FoodIngredientRow extends FoodIngredient {
  // Set only by a person's edit, and only to "low": the row has no nutrition, or
  // its quantity changed in a way its old estimate cannot be scaled to.
  confidence?: FoodConfidence;
}

export interface FoodQuantity {
  value: number;
  unit: string;
}

// Exported for the client-parity test (test/foodQuantityParity.test.js), which
// reads every key so the client copy in meal-card-model.ts cannot drift.
export const MASS_TO_G: Record<string, number> = {
  g: 1,
  gr: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};
export const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  millilitre: 1,
  millilitres: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  litre: 1000,
  litres: 1000,
};

// Read a free-text amount into a comparable quantity. PURE. Mass normalizes to
// grams, volume to millilitres, anything else to its first word as a count unit
// ("2 eggs" → {2, "egg"}). Null when the amount does not start with a number.
export function parseFoodQuantity(amount: unknown): FoodQuantity | null {
  const s = String(amount ?? "")
    .trim()
    .toLowerCase()
    .replace(/^(~|about|approx\.?|approximately|around)\s*/, "");
  const m = s.match(/^(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?\s*([a-z]+)?/);
  if (!m) return null;
  let value = Number(m[1].replace(",", "."));
  if (m[2]) value = value / Number(m[2]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const word = m[3] ?? "";
  if (word in MASS_TO_G) return { value: value * MASS_TO_G[word], unit: "g" };
  if (word in VOLUME_TO_ML) return { value: value * VOLUME_TO_ML[word], unit: "ml" };
  // A count word: fold a plain plural so "1 egg" and "3 eggs" compare.
  const unit = word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
  return { value, unit: unit || "unit" };
}

function formatGrams(g: number): string {
  return `${Math.round(g * 10) / 10} g`;
}

function rowMacros(row: Record<string, unknown> | null | undefined): Partial<Record<FoodMacroKey, number>> {
  const out: Partial<Record<FoodMacroKey, number>> = {};
  if (!row) return out;
  for (const key of FOOD_MACRO_KEYS) {
    const n = asNum(row[key]);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

function itemKey(item: unknown): string {
  return String(item ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface FoodIngredientRecompute {
  ingredients: FoodIngredientRow[];
  // Only the macros the meal carries: a key absent here stays whatever it was
  // (null), never becomes 0.
  totals: Partial<Record<FoodMacroKey, number>>;
  // Rows the person added or changed that carry no kcal estimate (rule 3) — the note
  // reads low confidence while any remain. Untouched rows never count.
  unestimated: number;
  // Rows whose macros were scaled to a new quantity (rule 1).
  scaled: number;
  // Rows whose quantity changed but whose kcal the total could not follow: no estimate
  // of their own, and no remainder share that could be placed on them (rule 5).
  unfollowed: number;
  // The edit removed every row: the meal totals are the stored ones, unchanged (rule 6).
  cleared: boolean;
}

function amountKey(amount: unknown): string {
  return String(amount ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// A parenthesized weight or volume at the end of an amount ("1 bar (100 g)",
// "1 square (~10 g)", "1 handful (~30 g)"). Kept separate from parseFoodQuantity so
// the meal card's grams field (which only opens on a bare mass amount) and its parity
// test stay unchanged, while server-side scaling can compare "1 bar (100 g)" against
// "1 square (10 g)" or "40 g".
function bracketedFoodQuantity(amount: unknown): FoodQuantity | null {
  const m = String(amount ?? "").match(
    /\(\s*((?:~|about|approx\.?|approximately|around|≈)?\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?\s*[a-z]+)\s*\)\s*$/i
  );
  if (!m) return null;
  const q = parseFoodQuantity(m[1]);
  return q && (q.unit === "g" || q.unit === "ml") ? q : null;
}

// Whether two free-text amounts describe the same quantity ("200 g" and "200g" do,
// while "1 square (100 g)" and "1 square (10 g)" do not).
function sameAmount(a: unknown, b: unknown): boolean {
  const ba = bracketedFoodQuantity(a);
  const bb = bracketedFoodQuantity(b);
  if (ba || bb) {
    if (!ba || !bb || ba.unit !== bb.unit || Math.abs(ba.value - bb.value) > 1e-6) return false;
  }
  const qa = parseFoodQuantity(a);
  const qb = parseFoodQuantity(b);
  if (qa && qb) return qa.unit === qb.unit && Math.abs(qa.value - qb.value) <= 1e-6;
  return amountKey(a) === amountKey(b);
}

// "block" is deliberately not a piece unit: "a block of chocolate" is a whole bar as often as a cut-out
// square, so a change TO "1 block" is never scaled by guess (the model states the macros).
const BAR_PIECE_UNITS = new Set(["square", "piece", "strip", "bite"]);
const BAR_WHOLE_UNITS = new Set(["bar", "block", "package", "pack", "tablet", "slab"]);
const CHOCOLATE_BAR_ITEM_RE = /\b(?:chocolate|lindt|cacao|ghirardelli|ritter|toblerone|cadbury|milka|godiva|bark)\b/i;
// A chocolate-NAMED item that is not a bar ("chocolate croissant", "chocolate chip cookie"):
// its "1 piece" can honestly carry 250+ kcal, so the bar rules never touch it.
const NOT_A_BAR_ITEM_RE =
  /\b(?:croissants?|cookies?|cake|brownies?|muffins?|donuts?|doughnuts?|milk|ice\s+cream|cereal|bread|pudding|mousse|latte|mocha|shake|protein|granola|chips?|covered|dipped|truffles?|pie|tart|waffles?|pancakes?)\b/i;
// Units that can never honestly carry a bar's worth of calories: a stored "1 square" at
// 250+ kcal is a mis-estimate even when the amendment restates the same amount.
const SMALL_PIECE_UNITS = new Set(["square", "strip", "bite"]);

// When a chocolate bar row was logged at whole-bar calories (~500+ kcal for ~100 g,
// whether labeled "1 bar", "1 block", "100 g", or even mis-labeled "1 square" with
// the full bar's macros) and is amended to 1–4 squares/pieces (~10 g each), scale
// to the single-piece share of the bar.
function barPieceScaleRatio(
  item: unknown,
  fromAmount: unknown,
  toAmount: unknown,
  refMacros?: Partial<Record<FoodMacroKey, number>>
): number | null {
  const itemText = String(item ?? "");
  if (!CHOCOLATE_BAR_ITEM_RE.test(itemText) || NOT_A_BAR_ITEM_RE.test(itemText)) return null;
  if (bracketedFoodQuantity(toAmount)) return null;
  const toQty = parseFoodQuantity(toAmount);
  if (!toQty || !BAR_PIECE_UNITS.has(toQty.unit) || toQty.value <= 0 || toQty.value > 4) return null;
  // The same amount restated is NOT an amendment: a carried-over row ("add a coffee" resends
  // every stored row) must keep its numbers. Only an implausible small-piece estimate heals.
  if (sameAmount(fromAmount, toAmount)) {
    const kcal = refMacros?.kcal;
    return SMALL_PIECE_UNITS.has(toQty.unit) && kcal !== undefined && kcal >= 250 * toQty.value
      ? (toQty.value * 10) / 100
      : null;
  }
  const pieceGrams = toQty.value * 10;
  const fromBracket = bracketedFoodQuantity(fromAmount);
  if (fromBracket && fromBracket.unit === "g" && fromBracket.value >= 40) {
    return pieceGrams / fromBracket.value;
  }
  const fromQty = parseFoodQuantity(fromAmount);
  if (fromQty && fromQty.unit === "g" && fromQty.value >= 40) {
    return pieceGrams / fromQty.value;
  }
  const refKcal = refMacros?.kcal;
  if (fromQty && BAR_WHOLE_UNITS.has(fromQty.unit) && (refKcal === undefined || refKcal >= 200)) {
    return pieceGrams / (fromQty.value * 100);
  }
  // Stored row already said "1 square" / "1 piece" / "1 block" (or had no unit)
  // while carrying whole-bar calories (>= 250 kcal per single piece).
  if (refKcal !== undefined && refKcal >= 250 * toQty.value) {
    return pieceGrams / 100;
  }
  return null;
}

// Ratio new/old when both amounts parse to the same unit (or share a comparable
// mass/volume via bracketed weight, or scale a whole chocolate bar down to squares);
// null when they cannot be compared.
function quantityRatio(
  from: unknown,
  to: unknown,
  item?: unknown,
  refMacros?: Partial<Record<FoodMacroKey, number>>
): number | null {
  const qa = parseFoodQuantity(from);
  const qb = parseFoodQuantity(to);
  const ba = bracketedFoodQuantity(from);
  const bb = bracketedFoodQuantity(to);
  const ma = ba ?? (qa && (qa.unit === "g" || qa.unit === "ml") ? qa : null);
  const mb = bb ?? (qb && (qb.unit === "g" || qb.unit === "ml") ? qb : null);
  if (ma && mb && ma.unit === mb.unit) return mb.value / ma.value;
  if (qa && qb && qa.unit === qb.unit && Math.abs(qb.value - qa.value) > 1e-6) return qb.value / qa.value;
  const barRatio = barPieceScaleRatio(item, from, to, refMacros);
  if (barRatio != null) return barRatio;
  if (qa && qb && qa.unit === qb.unit) return qb.value / qa.value;
  return null;
}

/**
 * Apply a person's replacement ingredient list over the stored meal (rules above).
 * PURE. `previous` is the stored parsed blob (its `ingredients` + meal totals);
 * `edits` is the full new row list — send every row that should remain, in order.
 * Each edit row is the stored row shape plus an optional numeric `grams`, which
 * sets the amount to "<grams> g".
 */
export function recomputeFoodIngredients(
  previous: { ingredients?: unknown } & Partial<Record<FoodMacroKey, unknown>>,
  edits: unknown
): FoodIngredientRecompute {
  // Coerce the stored rows ONE AT A TIME, so a raw row the coercion drops cannot shift
  // an earlier edit's "low" (which coerceFoodIngredients does not read — agents never
  // send one) onto its neighbour.
  const rawStored = Array.isArray(previous?.ingredients)
    ? (previous.ingredients as unknown[]).slice(0, MAX_INGREDIENTS)
    : [];
  const stored: FoodIngredientRow[] = [];
  for (const raw of rawStored) {
    const row = coerceFoodIngredients([raw])?.[0] as FoodIngredientRow | undefined;
    if (!row) continue;
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).confidence === "low") row.confidence = "low";
    stored.push(row);
  }

  // Rule 4/5: the unitemized remainder per macro, and each stored row's placeable share of it.
  const storedTotal: Partial<Record<FoodMacroKey, number>> = {};
  const remainder: Partial<Record<FoodMacroKey, number>> = {};
  const shareOf: Partial<Record<FoodMacroKey, Map<number, number>>> = {};
  for (const key of FOOD_MACRO_KEYS) {
    const total = asNum(previous?.[key]);
    if (total !== undefined) storedTotal[key] = total;
    const prevSum = stored.reduce((sum, row) => sum + (row[key] ?? 0), 0);
    const r = total === undefined ? 0 : Math.max(0, total - prevSum);
    remainder[key] = r;
    const without = stored.map((row, i) => ({ row, i })).filter(({ row }) => row[key] === undefined);
    const shares = new Map<number, number>();
    if (r > 0 && without.length === 1) shares.set(without[0].i, 1);
    else if (r > 0 && without.length > 1) {
      const qty = without.map(({ row }) => parseFoodQuantity(row.amount));
      const unit = qty[0]?.unit;
      if (qty.every((q) => q && q.unit === unit)) {
        const sum = qty.reduce((acc, q) => acc + (q as FoodQuantity).value, 0);
        if (sum > 0) without.forEach(({ i }, j) => shares.set(i, (qty[j] as FoodQuantity).value / sum));
      }
    }
    shareOf[key] = shares;
  }

  const used = new Set<number>();
  const rawEdits = Array.isArray(edits) ? edits.slice(0, MAX_INGREDIENTS) : [];
  const rows: FoodIngredientRow[] = [];
  const delta: Partial<Record<FoodMacroKey, number>> = {};
  const addDelta = (key: FoodMacroKey, n: number) => {
    delta[key] = (delta[key] ?? 0) + n;
  };
  let unestimated = 0;
  let scaled = 0;
  let unfollowed = 0;

  for (const raw of rawEdits) {
    const base = coerceFoodIngredients([raw])?.[0];
    if (!base) continue;
    const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    // The stored twin: same item AND same amount first, then same item alone.
    const sameItem = (row: FoodIngredientRow, i: number) => !used.has(i) && itemKey(row.item) === itemKey(base.item);
    let twinIndex =
      base.amount !== undefined
        ? stored.findIndex((row, i) => sameItem(row, i) && amountKey(row.amount) === amountKey(base.amount))
        : -1;
    if (twinIndex < 0) twinIndex = stored.findIndex(sameItem);
    const twin = twinIndex >= 0 ? stored[twinIndex] : null;
    if (twinIndex >= 0) used.add(twinIndex);

    const grams = asNum(src.grams);
    const amount =
      grams !== undefined && grams > 0 ? formatGrams(Math.min(grams, 5000)) : (base.amount ?? twin?.amount);
    const editMacros = rowMacros(base as unknown as Record<string, unknown>);
    const twinMacros = rowMacros(twin as unknown as Record<string, unknown>);
    const hasEditMacros = Object.keys(editMacros).length > 0;
    const hasTwinMacros = Object.keys(twinMacros).length > 0;
    const statedByPerson =
      !!twin &&
      hasEditMacros &&
      FOOD_MACRO_KEYS.some((key) => editMacros[key] !== undefined && editMacros[key] !== twinMacros[key]);
    const amountChanged = !!twin && !sameAmount(twin.amount, amount);

    // The estimate a quantity change scales FROM.
    const ref = statedByPerson
      ? null
      : hasTwinMacros
        ? { amount: twin?.amount, macros: twinMacros, basis: twin?.basis }
        : hasEditMacros
          ? { amount: base.amount, macros: editMacros, basis: base.basis }
          : null;
    // A brand-new row that states its macros but no amount of its own describes the
    // grams it was given; there is nothing to scale from.
    const ownUnstatedRef = !!ref && !hasTwinMacros && !String(base.amount ?? "").trim();
    const oversizedBarRatio =
      ref && !ownUnstatedRef ? barPieceScaleRatio(base.item, ref.amount, amount, ref.macros) : null;
    const quantityChanged =
      !!ref && !ownUnstatedRef && (!sameAmount(ref.amount, amount) || oversizedBarRatio != null);

    const row: FoodIngredientRow = { item: base.item };
    if (amount) row.amount = amount;
    let macros: Partial<Record<FoodMacroKey, number>>;
    let basis: FoodBasis | undefined;
    let low = false;
    if (statedByPerson) {
      macros = editMacros;
      basis = base.basis ?? "user_report";
    } else if (ref && quantityChanged) {
      const ratio = quantityRatio(ref.amount, amount, base.item, ref.macros);
      if (ratio != null && Number.isFinite(ratio) && ratio > 0) {
        macros = {};
        for (const key of FOOD_MACRO_KEYS) {
          const n = ref.macros[key];
          if (n !== undefined) macros[key] = clampIngredientMacro(key, n * ratio);
        }
        scaled++;
      } else {
        macros = ref.macros;
        low = true; // the old estimate no longer describes this amount
      }
      basis = "user_report"; // the quantity is now the person's own
    } else {
      macros = hasEditMacros ? editMacros : twinMacros;
      basis = amountChanged ? "user_report" : (base.basis ?? twin?.basis);
      // Nothing re-estimated this row, so an earlier "low" still describes it.
      if (twin?.confidence === "low") low = true;
    }
    for (const key of FOOD_MACRO_KEYS) if (macros[key] !== undefined) row[key] = macros[key];

    // Rule 5: the remainder share this stored row carried, for each macro it has no
    // number of its own for, follows the edit.
    let kcalFollowed = false;
    if (twin) {
      const ratio = amountChanged ? quantityRatio(twin.amount, amount, base.item, twinMacros) : 1;
      for (const key of FOOD_MACRO_KEYS) {
        if (twinMacros[key] !== undefined) continue;
        const share = shareOf[key]?.get(twinIndex);
        const r = remainder[key] ?? 0;
        if (share === undefined || !(r > 0)) continue;
        if (row[key] !== undefined)
          addDelta(key, -r * share); // now itemized: counted once
        else if (ratio != null) {
          addDelta(key, r * share * (ratio - 1));
          if (key === "kcal") kcalFollowed = true;
        }
      }
    }

    if (row.kcal === undefined && !kcalFollowed && (!twin || amountChanged)) {
      unestimated++;
      low = true;
      if (twin && amountChanged) unfollowed++;
    }
    if (basis) row.basis = basis;
    if (low) row.confidence = "low";
    rows.push(row);
  }

  // Rule 6: every row removed clears the breakdown, never the meal.
  if (!rows.length) {
    return { ingredients: [], totals: { ...storedTotal }, unestimated: 0, scaled: 0, unfollowed: 0, cleared: true };
  }

  // Rule 5: a stored row the edit removed takes its placeable share with it.
  stored.forEach((_row, i) => {
    if (used.has(i)) return;
    for (const key of FOOD_MACRO_KEYS) {
      const share = shareOf[key]?.get(i);
      if (share !== undefined) addDelta(key, -(remainder[key] ?? 0) * share);
    }
  });

  const totals: Partial<Record<FoodMacroKey, number>> = {};
  for (const key of FOOD_MACRO_KEYS) {
    const carried = rows.filter((row) => row[key] !== undefined);
    if (!carried.length && storedTotal[key] === undefined) continue;
    const unitemized = Math.max(0, (remainder[key] ?? 0) + (delta[key] ?? 0));
    totals[key] = unitemized + carried.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  }
  return { ingredients: rows, totals, unestimated, scaled, unfollowed, cleared: false };
}

// ---- a correction in words, over a meal already logged -----------------------
//
// Approximate logging is corrected by talking, not by typing grams: "oh and 40 g of
// avocado on the plate", "actually it was two slices", "no cheese on it". Chat names
// only what CHANGES — the rows that join or move, and the items that go — never the
// whole meal again. This turns that into the FULL replacement list
// recomputeFoodIngredients takes, so a correction lands on the SAME note through the
// same arithmetic as the meal card's grams edit:
//   - every stored row stays, in order, exactly as stored, unless it is named;
//   - a named row (same item, case/space-insensitive) keeps the stored row's item and
//     takes the new amount; its macros are the ones the correction states, or else
//     the stored ones — so an amount-only change ("two slices") scales from the
//     stored estimate (rule 1) instead of reading as macros a person typed;
//   - an unnamed item joins at the end with its own estimate;
//   - `remove` drops the named stored rows (their share leaves the total, rule 5).
// PURE. Stored rows the coercion cannot read are dropped the way recompute drops them.

const ITEM_STOP_WORDS = new Set(["with", "and", "the", "for", "from", "into", "over", "under"]);

function itemTokens(item: unknown): string[] {
  return itemKey(item)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ITEM_STOP_WORDS.has(w));
}

function itemsMatchLoosely(storedItem: unknown, candidateItem: unknown): boolean {
  const a = itemKey(storedItem);
  const b = itemKey(candidateItem);
  if (!a || !b) return false;
  if (a === b) return true;
  // Never by substring: "butter" is not "peanut butter", "cheese" is not "cream cheese". A typo or a
  // shortened name shares most of its WORDS, and both names must have at least two of them.
  const ta = itemTokens(a);
  const tb = itemTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  return shared >= 2 && shared / Math.min(ta.length, tb.length) >= 0.6;
}

// The ONE stored name a typo'd or shortened name refers to; null when none or when it is ambiguous.
function uniqueLooseMatch(keys: Set<string>, candidate: string): string | null {
  const hits = [...keys].filter((k) => itemsMatchLoosely(k, candidate));
  return hits.length === 1 ? hits[0] : null;
}

function removalKeys(remove: unknown): Set<string> {
  const list = Array.isArray(remove) ? remove : remove == null ? [] : [remove];
  return new Set(
    list
      .map((entry) =>
        itemKey(entry && typeof entry === "object" ? (entry as Record<string, unknown>).item : entry)
      )
      .filter(Boolean)
  );
}

export function amendFoodIngredients(
  previous: { ingredients?: unknown } | null | undefined,
  changes: unknown,
  remove?: unknown
): FoodIngredientRow[] {
  const drop = removalKeys(remove);
  const out: FoodIngredientRow[] = [];
  const at = new Map<string, number>();
  const stored = Array.isArray(previous?.ingredients) ? (previous.ingredients as unknown[]).slice(0, MAX_INGREDIENTS) : [];
  const storedKeys = new Set<string>();
  for (const raw of stored) {
    const row = coerceFoodIngredients([raw])?.[0] as FoodIngredientRow | undefined;
    if (row) storedKeys.add(itemKey(row.item));
  }
  for (const raw of stored) {
    const row = coerceFoodIngredients([raw])?.[0] as FoodIngredientRow | undefined;
    if (!row) continue;
    const key = itemKey(row.item);
    if (drop.has(key) || [...drop].some((d) => !storedKeys.has(d) && uniqueLooseMatch(storedKeys, d) === key)) continue;
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).confidence === "low") row.confidence = "low";
    if (!at.has(key)) at.set(key, out.length);
    out.push(row);
  }
  for (const raw of Array.isArray(changes) ? changes.slice(0, MAX_INGREDIENTS) : []) {
    const edit = coerceFoodIngredients([raw])?.[0];
    if (!edit) continue;
    const key = itemKey(edit.item);
    let index = at.get(key);
    if (index === undefined) {
      const looseKey = uniqueLooseMatch(new Set(out.map((r) => itemKey(r.item))), key);
      if (looseKey !== null) index = out.findIndex((r) => itemKey(r.item) === looseKey);
    }
    if (index === undefined) {
      if (out.length >= MAX_INGREDIENTS) continue;
      at.set(key, out.length);
      out.push(edit);
      continue;
    }
    const was = out[index];
    const stated = rowMacros(edit as unknown as Record<string, unknown>);
    const macros = Object.keys(stated).length ? stated : rowMacros(was as unknown as Record<string, unknown>);
    const merged: FoodIngredientRow = { item: was.item };
    const amount = edit.amount ?? was.amount;
    if (amount) merged.amount = amount;
    for (const k of FOOD_MACRO_KEYS) if (macros[k] !== undefined) merged[k] = macros[k];
    const basis = edit.basis ?? was.basis;
    if (basis) merged.basis = basis;
    // A row whose estimate nothing restated keeps what a person's edit said of it.
    if (!Object.keys(stated).length && was.confidence === "low") merged.confidence = "low";
    out[index] = merged;
  }
  return out;
}

// ---- the athlete's own lines, before (or without) any estimate ----------------
//
// A pasted meal of six lines is six things eaten, whether or not an agent ever reads
// it. When no estimate exists yet — enrichment off, no agent reachable, or simply not
// run yet — the words are split deterministically into rows so the meal card shows
// what was eaten at once:
//   - each non-empty line (a leading bullet or "1." dropped) is one row; a single line
//     is split on commas/semicolons instead ("oats 60 g, milk 250 ml, a banana"), but
//     never inside a number ("1,5 kg");
//   - a line that is only a meal heading ("Breakfast:") is not a row, and a short
//     lead-in before a colon ("Log lunch: …", "I had: …") is not part of the first one —
//     nor is a meal label leading the words without one ("breakfast 30g oats …",
//     "Lunch - rice …"; see mealLabelLead);
//   - a run of written quantities with no punctuation between them ("30g oats 15g chia
//     180g skyr 20 grapes") is one row per quantity, but only when the words START with
//     a quantity, so "oats 60 g" keeps its trailing amount;
//   - a quantity the athlete wrote — leading ("60 g oats", "2 eggs") or trailing
//     ("oats 60g", "rice - 150 g", "chicken (205 g)", "toast x2") — goes into `amount`
//     as they wrote it; the rest of their words is the item;
//   - NO macros are invented. The rows carry no numbers; the meal reads
//     `confidence: "low"`, `basis: "user_report"` (the items and amounts are the
//     athlete's own words). A later agent estimate replaces the rows and fills the
//     numbers — unless a person has edited the meal, which locks it (repo/nutrition.ts).

// Units a written quantity may carry: parseFoodQuantity's mass and volume words, plus
// the household measures people actually type.
const FOOD_UNIT_WORDS = [
  ...Object.keys(MASS_TO_G),
  ...Object.keys(VOLUME_TO_ML),
  "cup",
  "cups",
  "tbsp",
  "tsp",
  "tablespoon",
  "tablespoons",
  "teaspoon",
  "teaspoons",
  "slice",
  "slices",
  "scoop",
  "scoops",
  "piece",
  "pieces",
  "pc",
  "pcs",
  "square",
  "squares",
  "block",
  "blocks",
  "strip",
  "strips",
  "serving",
  "servings",
  "handful",
  "handfuls",
  "can",
  "cans",
  "bowl",
  "bowls",
  "glass",
  "glasses",
  "bar",
  "bars",
];
const UNIT_RE = `(?:${FOOD_UNIT_WORDS.join("|")})`;
// "~30 g", "about 150 g", "around 2": the approximation stays part of the amount the
// athlete wrote (parseFoodQuantity reads past it).
const NUM_RE = String.raw`(?:(?:~|about|around|approx\.?)\s*)?\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?`;
const LEADING_UNIT = new RegExp(String.raw`^(${NUM_RE}\s*${UNIT_RE})\.?(?:\s+of)?\s+(.+)$`, "i");
const LEADING_ARTICLE_UNIT = new RegExp(String.raw`^(?:a|an|one)\s+(?:small\s+)?(?:cut[- ]?out\s+)?(${UNIT_RE})\s+of\s+(.+)$`, "i");
const LEADING_COUNT = new RegExp(String.raw`^(${NUM_RE}|½|¼|¾)\s+(.+)$`, "i");
const TRAILING_UNIT = new RegExp(String.raw`^(.+?)[\s,:\-–—(]+(${NUM_RE}\s*${UNIT_RE})\.?\)?$`, "i");
const TRAILING_TIMES = /^(.+?)\s*[x×]\s*(\d+)$/i;
const BULLET_RE = /^\s*(?:[-*•·–—]+|\d+[.)])\s+/;
const CONTINUATION_CONJ_RE = /^(?:and|\+)\s+/i;
const TRAILING_CONJ_RE = /\s+(?:and|with|plus|in|on|over|\+|&)$/i;
const MEAL_HEADING_RE =
  /^(?:breakfast|brunch|lunch|dinner|supper|snacks?|meal|pre-?workout|post-?workout)\s*[:\-–—]?\s*$/i;
// Where a written quantity starts: a number with a food unit ("30g", "180 ml", "2
// slices") or a bare count before a word ("2 eggs"). "2% milk" is not one (the number
// is part of the food's name).
const QUANTITY_START = String.raw`(?:${NUM_RE}\s*${UNIT_RE}\b|${NUM_RE}\s+(?=[a-z])|[½¼¾]\s+(?=[a-z]))`;
const QUANTITY_START_RE = new RegExp(String.raw`^${QUANTITY_START}`, "i");
// Where a run is CUT is narrower than where a quantity may start. Inside a run only a
// number with a measurement unit ("… 15g chia"), or a bare count before a food that is
// counted ("… 20 grapes", "… 2 eggs"), opens a new row — never a number inside a food's
// name ("2 percent milk", "12 grain bread", "3 bean chili", "5 spice") and never one
// that follows "of", an article or an approximation ("3 slices of 12 grain bread",
// "about 150 g").
const COUNTED_FOOD = String.raw`(?:eggs?|egg\s+whites?|bananas?|apples?|oranges?|clementines?|mandarins?|tangerines?|pears?|peach(?:es)?|plums?|nectarines?|kiwis?|grapes|strawberr(?:y|ies)|raspberr(?:y|ies)|blueberr(?:y|ies)|cherr(?:y|ies)|dates|figs|prunes|apricots?|olives|almonds|walnuts|cashews|pecans|peanuts|pistachios|crackers?|cookies?|biscuits?|rice\s+cakes?|tortillas?|wraps?|pancakes?|waffles?|muffins?|bagels?|croissants?|dumplings|meatballs|sausages?|nuggets|wings|shrimps?|prawns|tacos?)`;
// An approximation travels with the count it qualifies ("… skyr around 20 grapes"), so
// the cut falls BEFORE it, exactly as for "about 150 g".
const RUN_CUT = String.raw`(?:${NUM_RE}\s*${UNIT_RE}\b|${NUM_RE}\s+${COUNTED_FOOD}\b|[½¼¾]\s+${COUNTED_FOOD}\b)`;
const QUANTITY_BOUNDARY_RE = new RegExp(
  String.raw`(?<!~|\b(?:about|around|approx\.?|of|a|an|the))\s+(?=${RUN_CUT})`,
  "gi"
);

// A meal label leading the athlete's words, with or without punctuation after it:
// "breakfast 30g oats", "Lunch - rice", "afternoon snack: apple", "dinner was salmon".
// Without a colon or dash the label counts only when a quantity follows it, so a food
// whose NAME starts with a meal word ("breakfast burrito", "snack bar 40g") keeps it.
const MEAL_LABEL_LEAD_RE =
  /^\s*(?:(?:my|for)\s+)?(?:(?:morning|afternoon|evening|late|light|quick|small|second|2nd)\s+)?(breakfast|brunch|lunch|dinner|supper|snacks?)(?:\s+(?:was|is))?(?:\s*[:–—]\s*|\s+-\s*|\s+(?=(?:(?:~|about|around|approx\.?)\s*)?\d|[½¼¾]))/i;

/**
 * The meal label that leads `text` and the words after it ("breakfast 30g oats" →
 * breakfast / "30g oats"), or null when the words do not open on a meal label. PURE.
 * Chat routing reads the same shape (chatRouting.ts readsAsMealList), so the router
 * and the row splitter can never disagree about what a label lead is.
 */
export function mealLabelLead(text: unknown): { label: string; rest: string } | null {
  const raw = String(text ?? "");
  const m = raw.match(MEAL_LABEL_LEAD_RE);
  if (!m) return null;
  const rest = raw.slice(m[0].length).trim();
  return rest ? { label: m[1].toLowerCase().replace(/^snacks$/, "snack"), rest } : null;
}

/** Does `text` open on a written quantity ("30g oats", "2 eggs", "½ avocado")? PURE. */
export function startsWithFoodQuantity(text: unknown): boolean {
  return QUANTITY_START_RE.test(String(text ?? "").trim());
}

// The trailing form of a run: "rice 150g chicken 120g" → ["rice 150g", "chicken 120g"]. It
// splits only when the words are ENTIRELY <food words> <amount with a unit> pairs — two or
// more, each food part with letters and no number of its own, and nothing after the last
// amount; anything else is returned whole, exactly as before.
const UNIT_AMOUNT_RE = new RegExp(String.raw`${NUM_RE}\s*${UNIT_RE}\b\.?\)?`, "gi");
const PAIR_LEAD_CONJ_RE = /^(?:and|with|plus|\+|&)\s+/i;

function splitTrailingPairs(segment: string): string[] {
  const text = segment.replace(/\s+/g, " ").trim();
  const pieces: string[] = [];
  let last = 0;
  for (const m of text.matchAll(UNIT_AMOUNT_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    pieces.push(text.slice(last, end).trim().replace(PAIR_LEAD_CONJ_RE, ""));
    last = end;
  }
  if (pieces.length < 2 || text.slice(last).trim()) return [segment];
  const foodPart = (piece: string) => piece.replace(new RegExp(UNIT_AMOUNT_RE.source, "i"), "");
  const pairs = pieces.every(
    (piece) => TRAILING_UNIT.test(piece) && /[a-z]{2,}/i.test(foodPart(piece)) && !/\d/.test(foodPart(piece))
  );
  return pairs ? pieces : [segment];
}

// "30g oats 15g chia 20 grapes" → ["30g oats", "15g chia", "20 grapes"]. Only a segment
// that opens on a quantity and carries a second one is split this way (a trailing-form
// run goes through splitTrailingPairs); anything else is returned whole, exactly as before.
function splitQuantityRun(segment: string): string[] {
  if (!QUANTITY_START_RE.test(segment)) return splitTrailingPairs(segment);
  const parts = segment
    .replace(/\s+/g, " ")
    .split(QUANTITY_BOUNDARY_RE)
    .map((part) => part.replace(TRAILING_CONJ_RE, "").trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [segment];
}
const LEAD_IN_RE = /^[^:\d\n]{1,40}:\s*(?=\S)/;
const SPOKEN_LEAD_RE =
  /^(?:i\s+)?(?:just\s+)?(?:had|ate|eaten|drank|log(?:ged)?)\b(?:\s+(?:for\s+)?(?:breakfast|brunch|lunch|dinner|supper|a\s+snack|snack))?\s*:?\s*/i;

function foodRowFromWords(words: string): FoodIngredient | null {
  const text = words.replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();
  if (!text || MEAL_HEADING_RE.test(text)) return null;
  const row = (item: string, amount?: string): FoodIngredient | null => {
    const it = item.replace(/^[\s,:\-–—]+|[\s,:\-–—.]+$/g, "").slice(0, TEXT_CAP);
    if (!it) return amount ? { item: amount.slice(0, TEXT_CAP) } : null;
    return amount ? { item: it, amount: amount.trim().slice(0, TEXT_CAP) } : { item: it };
  };
  let m = text.match(LEADING_UNIT);
  if (m) return row(m[2], m[1]);
  m = text.match(LEADING_ARTICLE_UNIT);
  if (m) return row(m[2], `1 ${m[1].toLowerCase()}`);
  m = text.match(TRAILING_UNIT);
  if (m) return row(m[1], m[2]);
  m = text.match(TRAILING_TIMES);
  if (m) return row(m[1], m[2]);
  m = text.match(LEADING_COUNT);
  if (m) return row(m[2], m[1]);
  return row(text);
}

/**
 * Split an athlete's own meal words into ingredient rows — one per line, bullet or
 * (on a single line) comma-list item — with the quantity they wrote as `amount`.
 * PURE, deterministic, no macros. Rules above. Empty when there is nothing to split.
 */
export function foodRowsFromWords(text: unknown): FoodIngredient[] {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  let lines = raw
    .split("\n")
    .map((line) => line.replace(BULLET_RE, "").trim())
    .filter((line) => line && !MEAL_HEADING_RE.test(line));
  if (!lines.length) return [];
  // A short lead-in on the first line ("Log lunch: …", "I had: …", "breakfast 30g …") is
  // not something eaten.
  const first = lines[0].replace(LEAD_IN_RE, "").replace(MEAL_LABEL_LEAD_RE, "").replace(SPOKEN_LEAD_RE, "").trim();
  lines = (first ? [first, ...lines.slice(1)] : lines.slice(1)).map((line, idx) =>
    idx > 0 ? line.replace(CONTINUATION_CONJ_RE, "").trim() : line
  );
  const segments =
    lines.length === 1
      ? lines[0]
          .split(/[;,](?!\d)/)
          .map((part) => part.trim())
          .filter(Boolean)
      : lines;
  return segments
    .flatMap(splitQuantityRun)
    .map(foodRowFromWords)
    .filter((row): row is FoodIngredient => !!row)
    .slice(0, MAX_INGREDIENTS);
}

// ---- meal-slot intelligence (snack / pre-breakfast vs main meal) --------------
//
// The clock's meal windows (05–11 breakfast, 11–15 lunch, 17–22 dinner) are a sensible
// default when someone logs an actual meal without naming the slot. They are NOT a rule
// that everything eaten at 5:48 AM is "breakfast": a square/block of dark chocolate with
// a pour-over coffee, a morning espresso, a piece of fruit, or a pre-workout bite is a
// snack (or pre-breakfast bite), and calling it "breakfast" both mis-speaks the receipt
// and marks the morning's breakfast window as already eaten.

const EXPLICIT_SNACK_SLOT_RE =
  /\b(?:snacks?|pre[- ]?breakfast|before\s+breakfast|after\s+dinner|before\s+bed|mid[- ]?morning|mid[- ]?afternoon|late\s+bite|quick\s+bite|small\s+bite|little\s+bite|light\s+bite)\b/i;

const NEGATED_MEAL_RE =
  /\b(?:skipp(?:ed|ing)|skip|missed|no|without|nothing\s+for|didn'?t\s+(?:have|eat)|did\s+not\s+(?:have|eat))\s+(?:my\s+|the\s+|any\s+)?(?:breakfast|lunch|dinner)\b/gi;

// Around a workout the cue only makes a SNACK when the food itself is snack-shaped.
const AROUND_WORKOUT_RE = /\b(?:pre|post)[- ]?workout\b/i;

const MAIN_MEAL_FOOD_RE =
  /\b(?:eggs?|omelet(?:te)?s?|scrambl(?:e|ed)|frittata|oatmeal|oats|porridge|pancakes?|waffles?|french\s+toast|bagels?|toast|cereal|granola|hash|bacon|sausages?|burritos?|tacos?|quesadillas?|sandwich(?:es)?|subs?|paninis?|wraps?|burgers?|pizzas?|pasta|spaghetti|noodles?|ramen|pho|rice|risotto|quinoa|couscous|chicken|turkey|steak|beef|brisket|pork|ham|lamb|salmon|tuna|cod|halibut|fish|shrimp|prawns|tofu|tempeh|seitan|lentils?|beans|chili|curry|stir[- ]?fry|stew|soup|chowder|salads?|bowls?|plates?|platters?|entr[eé]es?|casseroles?|lasagna|sushi|poke|avocado\s+toast|overnight\s+oats|chia\s+pudding|english\s+muffins?|croissants?|yogurt|skyr|cottage\s+cheese|smoothies?|shakes?|potato(?:es)?|sweet\s+potato(?:es)?)\b/i;

const OBVIOUS_SNACK_FOOD_RE =
  /\b(?:coffee|pour[- ]?over|espresso|americano|macchiato|cortado|cappuccino|latte|flat\s+white|cold\s+brew|iced\s+coffee|mocha|tea|matcha|chai|herbal\s+tea|green\s+tea|black\s+tea|hot\s+chocolate|cocoa|electrolytes?|kombucha|chocolates?|lindt|cacao|cand(?:y|ies)|gumm(?:y|ies)|mints?|cookies?|biscuits?|crackers?|pretzels?|chips|crisps|popcorn|rice\s+cakes?|nuts?|almonds?|walnuts?|cashews?|pecans?|peanuts?|pistachios?|macadamias?|trail\s+mix|dried\s+fruit|raisins?|dates?|figs?|apricots?|apples?|bananas?|oranges?|clementines?|mandarins?|tangerines?|pears?|peach(?:es)?|plums?|nectarines?|berries|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|blackberr(?:y|ies)|cherries|grapes?|kiwis?|mangos?|mangoes|melon|watermelon|pineapple|grapefruit|protein\s+bars?|energy\s+bars?|granola\s+bars?|snack\s+bars?|quest\s+bars?|rxbars?|clif\s+bars?|gels?|chews?|popsicles?|ice\s+cream|sorbet|gelato|brownies?|donuts?|doughnuts?|macarons?)\b|\b(?:(?:a|an|one|1|two|2|few|couple(?:\s+of)?|small)\s+(?:small\s+)?(?:cut[- ]?out\s+)?(?:blocks?|squares?|pieces?|bites?|strips?|handfuls?)\b)/i;

/**
 * The meal slot the athlete explicitly stated in `text`, or null when none was named.
 * Pre-meal / between-meal qualifiers ("pre-breakfast", "before breakfast", "after dinner",
 * "pre-workout", "late bite") resolve to "snack" before the bare main-meal words are checked.
 */
export function explicitFoodMealLabel(text: unknown): "breakfast" | "lunch" | "dinner" | "snack" | null {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  // "skipped breakfast", "no lunch", "didn't have dinner" name a meal that did NOT happen.
  const s = raw.replace(NEGATED_MEAL_RE, " ");
  // A named main meal beats a snack cue ("had lunch after a pre-workout shake" is lunch).
  for (const meal of ["breakfast", "lunch", "dinner"] as const) {
    if (new RegExp(`(?<!pre[- ]|before\\s+|after\\s+)\\b${meal}\\b`, "i").test(s)) return meal;
  }
  if (EXPLICIT_SNACK_SLOT_RE.test(s)) return "snack";
  return null;
}

/**
 * True when an unlabeled food note or capture message is manifestly a small snack,
 * beverage/coffee, or pre-meal bite rather than a main meal (breakfast/lunch/dinner).
 */
export function isObviouslySnackCapture(text: unknown): boolean {
  const s = String(text ?? "").trim();
  if (!s) return false;
  const explicit = explicitFoodMealLabel(s);
  if (explicit === "snack") return true;
  if (explicit === "breakfast" || explicit === "lunch" || explicit === "dinner") return false;
  const cleaned = s.replace(LEAD_IN_RE, "").replace(SPOKEN_LEAD_RE, "").trim();
  if (!cleaned) return false;
  if (MAIN_MEAL_FOOD_RE.test(cleaned)) return false;
  return OBVIOUS_SNACK_FOOD_RE.test(cleaned) || AROUND_WORKOUT_RE.test(cleaned);
}

/** True when a stored blob carries no estimate at all: no rows, no items, no numbers. */
export function foodParsedHasNoEstimate(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return true;
  const row = parsed as Record<string, unknown>;
  if (Array.isArray(row.ingredients) && row.ingredients.length) return false;
  if (Array.isArray(row.items) && row.items.length) return false;
  return FOOD_MACRO_KEYS.every((key) => asNum(row[key]) === undefined);
}

/**
 * The words-only capture: when `parsed` carries no estimate, the athlete's own text
 * becomes rows (foodRowsFromWords) with no macros, `confidence: "low"` and
 * `basis: "user_report"`. Anything already in `parsed` (a summary) is kept. Returns
 * `parsed` untouched when it already carries an estimate or the text has no rows.
 */
export function withWordRows<T extends Record<string, unknown> | null | undefined>(
  parsed: T,
  text: unknown
): T | Record<string, unknown> {
  if (!foodParsedHasNoEstimate(parsed)) return parsed;
  const rows = foodRowsFromWords(text);
  if (!rows.length) return parsed;
  return {
    ...(parsed ?? {}),
    ingredients: rows,
    confidence: "low",
    basis: "user_report",
  };
}
