// @ts-check
// Food-note parsing and rendering shared by Me notes and the food detail sheet.

type FoodIngredientRow = {
  item?: unknown;
  name?: unknown;
  amount?: unknown;
  qty?: unknown;
  quantity?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
};

type FoodParsedNote = {
  summary?: unknown;
  items?: unknown;
  ingredients?: unknown;
  notes?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
};

type FoodNoteRow = {
  id?: unknown;
  meal?: unknown;
  raw?: unknown;
  raw_text?: unknown;
  raw_output?: unknown;
  parsed?: unknown;
  parsed_json?: unknown;
  created_at?: unknown;
  enrichment_status?: unknown;
};

type FoodMacroOptions = {
  kcal?: boolean;
  short?: boolean;
};

(() => {
function foodIngredients(value: unknown): FoodIngredientRow[] {
  const parsed = value && typeof value === "object" ? value as FoodParsedNote : null;
  if (!parsed) return [];
  if (Array.isArray(parsed.ingredients)) {
    return parsed.ingredients
      .map((item): FoodIngredientRow | null => {
        if (typeof item === "string") return { item };
        if (!item || typeof item !== "object") return null;
        const row = item as FoodIngredientRow;
        const name = String(row.item || row.name || "").trim();
        if (!name) return null;
        return {
          item: name,
          amount: row.amount || row.qty || row.quantity || "",
          kcal: foodNum(row.kcal),
          protein_g: foodNum(row.protein_g),
          carbs_g: foodNum(row.carbs_g),
          fat_g: foodNum(row.fat_g),
        };
      })
      .filter((item): item is FoodIngredientRow => Boolean(item));
  }
  if (Array.isArray(parsed.items)) {
    return parsed.items
      .map((item): FoodIngredientRow | null => {
        if (typeof item === "string") return { item };
        if (!item || typeof item !== "object") return null;
        const row = item as FoodIngredientRow;
        const name = String(row.item || row.name || "").trim();
        return name ? { item: name, amount: row.amount || row.qty || row.quantity || "" } : null;
      })
      .filter((item): item is FoodIngredientRow => Boolean(item));
  }
  return [];
}

function ingredientLabel(ingredient: FoodIngredientRow | null | undefined): string {
  const amount = String(ingredient?.amount || "").trim();
  const item = String(ingredient?.item || "").trim();
  if (!amount) return item;
  if (item.toLowerCase().startsWith(amount.toLowerCase())) return item;
  return `${amount} ${item}`;
}

function foodItemsText(value: unknown): string {
  const parsed = value && typeof value === "object" ? value as FoodParsedNote : null;
  if (!parsed) return "";
  if (Array.isArray(parsed.items)) {
    return parsed.items
      .map((item) => typeof item === "string" ? item : ((item as FoodIngredientRow | null)?.item || (item as FoodIngredientRow | null)?.name || ""))
      .filter(Boolean)
      .join(", ");
  }
  return String(parsed.items || "");
}

function foodTitleFromIngredients(value: unknown): string {
  const items = foodIngredients(value).map((item) => item.item).filter(Boolean);
  if (!items.length) return "";
  return items.slice(0, 3).join(", ") + (items.length > 3 ? "..." : "");
}

function foodMacroText(value: unknown, opts: FoodMacroOptions = {}): string {
  const parsed = value && typeof value === "object" ? value as FoodParsedNote : null;
  if (!parsed) return "";
  const parts: string[] = [];
  if (opts.kcal !== false && foodNum(parsed.kcal) !== null) parts.push(`${formatFoodNum(parsed.kcal)} kcal`);
  const labels = opts.short
    ? [["P", "protein_g"], ["C", "carbs_g"], ["F", "fat_g"], ["Fiber", "fiber_g"]]
    : [["protein", "protein_g"], ["carbs", "carbs_g"], ["fat", "fat_g"], ["fiber", "fiber_g"]];
  for (const [label, key] of labels) {
    const raw = parsed[key as keyof FoodParsedNote];
    if (foodNum(raw) !== null) parts.push(`${formatFoodNum(raw)}g ${label}`);
  }
  return parts.join(" · ");
}

function parsedNote(note: FoodNoteRow | null | undefined): FoodParsedNote | null {
  let parsed = note?.parsed && typeof note.parsed === "object" ? note.parsed : note?.parsed_json;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  return parsed && typeof parsed === "object" ? parsed as FoodParsedNote : null;
}

function noteEntryInner(note: FoodNoteRow): string {
  const parsed = parsedNote(note);
  const date = String(note.created_at || "").slice(0, 10);
  const text = note.raw || note.raw_output || "";
  let detail = "";
  if (parsed) {
    const macros = foodMacroText(parsed, { kcal: true, short: true });
    const ingredients = foodIngredients(parsed);
    const items = ingredients.length ? ingredients.map(ingredientLabel).join(", ") : foodItemsText(parsed);
    const title = parsed.summary || foodTitleFromIngredients(parsed) || text;
    detail = `<div class="meal-name">${escHtml(title)}</div>` +
      (items ? `<div class="meal-items">${escHtml(items)}</div>` : "") +
      (macros ? `<span class="fn-macros">${escHtml(macros)}</span>` : "") +
      (parsed.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.notes)}</div>` : "");
  } else {
    detail = `<div class="meal-name">${escHtml(text)}</div>`;
  }
  const query = note.raw_text || note.raw || note.raw_output || (parsed && (parsed.summary || parsed.items)) || "";
  const tile = artImg("food", String(query), "artile-sm meal-art", art("food", String(query)));
  const body = tile
    ? `<div class="meal-row">${tile}<div class="meal-main">${detail}</div></div>`
    : detail;
  return `<div class="sess-head"><span class="sess-date" style="font-size:.9rem">${escHtml(note.meal || "")} · ${escHtml(date)}</span><span class="fnent-badge">${enrichBadge(note.enrichment_status)}</span></div>${body}`;
}

function noteEntryHtml(note: FoodNoteRow, index?: number): string {
  const reveal = typeof index === "number";
  return `<div class="sess fnent tappable${reveal ? " reveal" : ""}" data-noteid="${escAttr(note.id)}"${reveal ? ` style="${stagger(index)}"` : ""}>${noteEntryInner(note)}</div>`;
}

const CAIRN_FOOD_NOTE = {
  foodIngredients,
  ingredientLabel,
  foodItemsText,
  foodTitleFromIngredients,
  foodMacroText,
  parsedNote,
  noteEntryInner,
  noteEntryHtml,
};

Object.assign(globalThis, {
  CairnFoodNote: CAIRN_FOOD_NOTE,
  foodIngredients,
  ingredientLabel,
  foodItemsText,
  foodTitleFromIngredients,
  foodMacroText,
  parsedNote,
  noteEntryInner,
  noteEntryHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnFoodNote: CAIRN_FOOD_NOTE,
    foodIngredients,
    ingredientLabel,
    foodItemsText,
    foodTitleFromIngredients,
    foodMacroText,
    parsedNote,
    noteEntryInner,
    noteEntryHtml,
  });
}
})();
