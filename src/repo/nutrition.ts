import { db, todayISO } from "../db.js";
import { getSettings } from "./settings.js";

// ---------- meal plans ----------
export function createMealPlan(agent: string, raw: string, parsed: any) {
  const info = db.prepare(
    `INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json) VALUES (?, ?, ?, ?)`
  ).run(todayISO(), agent, raw || "", parsed ? JSON.stringify(parsed) : null);
  return hydrate(db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(info.lastInsertRowid));
}

export function listMealPlans(limit = 10) {
  return (db.prepare(`SELECT * FROM meal_plans ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrate);
}

export function setMealPlanStatus(id: number, status: string) {
  db.prepare(`UPDATE meal_plans SET status = ? WHERE id = ?`).run(status, id);
  return hydrate(db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id));
}

// Accepting a meal plan retires the OTHER open meal-plan drafts — they were
// alternative weeks, so once one is kept the rest are stale. Marked 'superseded'
// (the system retiring them), distinct from a user 'discarded'.
export function acceptMealPlan(id: number) {
  db.prepare(`UPDATE meal_plans SET status = 'superseded' WHERE status = 'draft' AND id != ?`).run(id);
  return setMealPlanStatus(id, "accepted");
}

export function getMealPlan(id: number) {
  const row = db.prepare(`SELECT * FROM meal_plans WHERE id = ?`).get(id);
  return row ? hydrate(row) : null;
}

// Agent (and PWA) supplied meal objects are coerced/clamped before write —
// numbers via Number() with sane ceilings, strings capped to keep parsed_json honest.
function clampNum(v: any, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n));
}

// Length guard for stored human-facing text. When it has to truncate it breaks on
// a word boundary and adds an ellipsis (never a mid-word cut like "…bloodwork pane"),
// and the result still fits within `max`.
export function capStr(v: any, max = 300): string {
  const s = String(v ?? "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  const head = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.!?-]+$/, "");
  return head + "…";
}

export function coerceMeal(m: any) {
  return {
    name: capStr(m?.name),
    items: capStr(m?.items),
    kcal: clampNum(m?.kcal, 3000),
    protein_g: clampNum(m?.protein_g, 500),
    carbs_g: clampNum(m?.carbs_g, 500),
    fat_g: clampNum(m?.fat_g, 500),
  };
}

// Replace the days array inside a meal plan's parsed_json — used for manual
// reordering/editing of meals. PRESERVES every other key the agent emitted
// (daily_kcal, shopping, notes, ...). Returns the hydrated updated row, or
// null on unknown id / invalid days.
export function updateMealPlanDays(id: number, days: any) {
  const plan = getMealPlan(id);
  if (!plan) return null;
  if (!Array.isArray(days)) throw new Error("days must be an array");
  const cleanDays = days.map((d: any) => ({
    ...(d && typeof d === "object" ? d : {}),
    day: capStr(d?.day, 40),
    ...(d?.note !== undefined && d?.note !== null ? { note: capStr(d.note) } : {}),
    // Carry a cached recipe through reorders/edits (re-clamped) — coerceMeal
    // alone would silently drop it. Swaps still drop it on purpose: a new
    // meal needs a new recipe.
    meals: (Array.isArray(d?.meals) ? d.meals : []).map((m: any) => {
      const recipe = m?.recipe ? coerceRecipe(m.recipe) : null;
      return recipe ? { ...coerceMeal(m), recipe } : coerceMeal(m);
    }),
  }));
  const parsed = { ...(plan.parsed && typeof plan.parsed === "object" ? plan.parsed : {}), days: cleanDays };
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(parsed), id);
  return getMealPlan(id);
}

// Swap one meal in place (agentic "swap this meal"). Returns { plan, meal }
// with the coerced/clamped meal actually written, or null when the plan/day/
// index can't be found.
export function swapMealInPlan(id: number, day: string, mealIndex: number, meal: any) {
  const plan = getMealPlan(id);
  if (!plan || !plan.parsed || !Array.isArray(plan.parsed.days)) return null;
  const dayKey = String(day ?? "").trim().toLowerCase();
  const target = plan.parsed.days.find((d: any) => String(d?.day ?? "").trim().toLowerCase() === dayKey);
  if (!target || !Array.isArray(target.meals)) return null;
  const idx = Number(mealIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= target.meals.length) return null;
  const clean = coerceMeal(meal);
  target.meals[idx] = clean;
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(plan.parsed), id);
  return { plan: getMealPlan(id), meal: clean };
}

// Agent-provided recipes are coerced/clamped before write, same discipline as
// coerceMeal. Returns null when nothing usable remains (no steps AND no
// ingredients after coercion).
export function coerceRecipe(r: any) {
  if (!r || typeof r !== "object") return null;
  const strList = (v: any, maxItems: number, maxLen: number): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((s: any) => typeof s === "string" && s.trim())
      .slice(0, maxItems)
      .map((s: string) => s.trim().slice(0, maxLen));
  const timeMin = Number(r.time_min);
  const servings = Number(r.servings);
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .filter((i: any) => i && typeof i === "object" && typeof i.item === "string" && i.item.trim())
    .slice(0, 20)
    .map((i: any) => ({ item: capStr(i.item, 120), qty: capStr(i.qty, 40) }));
  const steps = strList(r.steps, 15, 300);
  const tips = strList(r.tips, 6, 200);
  if (!steps.length && !ingredients.length) return null;
  return {
    summary: capStr(r.summary, 400),
    time_min: Number.isFinite(timeMin) ? Math.min(240, Math.max(0, Math.round(timeMin))) : 0,
    servings: Number.isFinite(servings) ? Math.min(8, Math.max(1, Math.round(servings))) : 1,
    ingredients,
    steps,
    tips,
  };
}

// Cache an agent-written recipe on one planned meal, under
// parsed.days[day].meals[mealIndex].recipe. Day matches case-insensitively
// like swapMealInPlan; every other parsed_json key is preserved. Returns
// { plan, recipe } or null when plan/day/meal is missing or the recipe is
// unusable after coercion.
export function setMealRecipe(planId: number, day: string, mealIndex: number, recipe: any) {
  const plan = getMealPlan(planId);
  if (!plan || !plan.parsed || !Array.isArray(plan.parsed.days)) return null;
  const dayKey = String(day ?? "").trim().toLowerCase();
  const target = plan.parsed.days.find((d: any) => String(d?.day ?? "").trim().toLowerCase() === dayKey);
  if (!target || !Array.isArray(target.meals)) return null;
  const idx = Number(mealIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= target.meals.length) return null;
  const clean = coerceRecipe(recipe);
  if (!clean) return null;
  target.meals[idx] = { ...(target.meals[idx] && typeof target.meals[idx] === "object" ? target.meals[idx] : {}), recipe: clean };
  db.prepare(`UPDATE meal_plans SET parsed_json = ? WHERE id = ?`).run(JSON.stringify(plan.parsed), planId);
  return { plan: getMealPlan(planId), recipe: clean };
}

// ---------- food notes ----------
export function addFoodNote(meal: string, raw: string, parsed: any, imagePath?: string) {
  // Free-text food notes (non-empty raw) get queued for background enrichment —
  // only when enabled, else recorded 'skipped' directly (see addActivity).
  const fromText = !!(raw && String(raw).trim());
  const status = fromText ? (getSettings().enrich_enabled ? "pending" : "skipped") : null;
  const info = db.prepare(
    `INSERT INTO food_notes (meal, raw_output, parsed_json, image_path, enrichment_status) VALUES (?, ?, ?, ?, ?)`
  ).run(meal || "meal", raw || "", parsed ? JSON.stringify(parsed) : null, imagePath ?? null, status);
  const row = hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(info.lastInsertRowid));
  // Lazy import to avoid a circular dependency (enrich.ts imports repo.ts).
  if (status === "pending") {
    import("../enrich.js").then((m) => m.enqueueEnrich("food", row.id)).catch(() => {});
  }
  return row;
}

export function listFoodNotes(limit = 20) {
  return (db.prepare(`SELECT * FROM food_notes ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrate);
}

export function getFoodNote(id: number) {
  return hydrate(db.prepare(`SELECT * FROM food_notes WHERE id = ?`).get(id));
}

export function deleteFoodNote(id: number) {
  const row = getFoodNote(id);
  if (!row) return { deleted: false, id };
  db.prepare(`DELETE FROM food_notes WHERE id = ?`).run(id);
  return { deleted: true, id };
}

// Overwrite the parsed_json blob with the enricher's structured estimate.
export function updateFoodNoteParsed(id: number, parsed: any) {
  db.prepare(`UPDATE food_notes SET parsed_json = ? WHERE id = ?`).run(
    parsed ? JSON.stringify(parsed) : null,
    id
  );
  return getFoodNote(id);
}

export function setFoodNoteEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE food_notes SET enrichment_status = ? WHERE id = ?`).run(status, id);
  return getFoodNote(id);
}

export function hydrate(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

