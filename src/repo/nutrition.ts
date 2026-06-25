import { db, todayISO } from "../db.js";
import { computeGoalCheck } from "./profile.js";
import { getSettings } from "./settings.js";
import { localDateISO, chatHistoryTimeLabel } from "./shared.js";

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
  // Stamp the LOCAL calendar day (device-zone aware) the meal belongs to, so an
  // evening log counts toward the right day; created_at stays the UTC instant.
  const info = db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, image_path, enrichment_status) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(localDateISO(), meal || "meal", raw || "", parsed ? JSON.stringify(parsed) : null, imagePath ?? null, status);
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

// ---------- daily intake review (v41) ----------
// A calm review of ONE day's logged food: the entries (each editable/deletable),
// the running totals, and — only when a real target exists (a loss/gain goal, or
// the maintenance anchor) — a gentle "remaining". Never a score; "remaining",
// never "consumed". The day boundary is the stamped LOCAL calendar day; the
// created_at fallback only keeps legacy rows readable.
export function getDayIntake(date?: string) {
  const d = date || localDateISO();
  // Key by the stamped LOCAL day; COALESCE to the legacy UTC-date-of-created_at
  // guards any pre-migration row that somehow lacks a stamped date.
  const rows = (db.prepare(
    `SELECT * FROM food_notes WHERE COALESCE(date, substr(created_at,1,10)) = ? ORDER BY id ASC`
  ).all(d) as any[]).map(hydrate);

  const totals = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const entries = rows.map((r) => {
    const p = r.parsed || {};
    totals.kcal += num(p.kcal);
    totals.protein_g += num(p.protein_g);
    totals.carbs_g += num(p.carbs_g);
    totals.fat_g += num(p.fat_g);
    totals.fiber_g += num(p.fiber_g);
    return {
      id: r.id,
      meal: r.meal,
      summary: String(p.summary ?? r.raw_output ?? "").trim() || "Food",
      kcal: p.kcal ?? null,
      protein_g: p.protein_g ?? null,
      carbs_g: p.carbs_g ?? null,
      fat_g: p.fat_g ?? null,
      fiber_g: p.fiber_g ?? null,
      enrichment_status: r.enrichment_status ?? null,
      created_at: r.created_at,
      logged_at: chatHistoryTimeLabel(r.created_at), // local "1:15 PM" so the coach can reference WHEN it was eaten
    };
  });
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = Math.round(totals[k]);

  // Target framing: a gentle target/remaining ONLY when the profile is complete
  // enough to derive one. Incomplete profile → descriptive-only (target null).
  let target: { kcal: number; protein_g: number; mode: string } | null = null;
  let remaining: { kcal: number; protein_g: number } | null = null;
  try {
    const goal: any = computeGoalCheck();
    const tk = Number(goal?.recommended?.target_intake_kcal);
    if (goal?.ok && Number.isFinite(tk)) {
      target = {
        kcal: Math.round(tk),
        protein_g: Math.round(Number(goal.recommended?.protein_g) || 0),
        mode: String(goal.goal_mode || "maintain"),
      };
      remaining = { kcal: target.kcal - totals.kcal, protein_g: target.protein_g - totals.protein_g };
    }
  } catch { /* profile incomplete → descriptive-only */ }

  return { date: d, totals, entries, count: entries.length, target, remaining };
}

// Manual correction of a logged food note (fix a macro, rename it, change the meal
// slot, or just "I changed my mind"). Coerced/clamped at the trust boundary like
// coerceMeal, merged over the existing parsed blob. STAMPS enrichment_status
// terminal ('done') so a still-queued background enricher can't later clobber the
// correction — a manual edit is authoritative (mirrors updateTarget's manual path).
// Returns the hydrated row, or null on unknown id.
export function updateFoodNote(id: number, fields: any) {
  const row = getFoodNote(id);
  if (!row) return null;
  const f = fields && typeof fields === "object" ? fields : {};
  const parsed: any = { ...(row.parsed && typeof row.parsed === "object" ? row.parsed : {}) };

  const numField = (key: string, max: number) => {
    if (f[key] === undefined) return;
    if (f[key] === null || f[key] === "") { parsed[key] = null; return; }
    const n = Number(f[key]);
    parsed[key] = Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : null;
  };
  if (f.summary !== undefined) parsed.summary = capStr(f.summary, 200);
  if (f.items !== undefined) {
    parsed.items = Array.isArray(f.items)
      ? f.items.slice(0, 30).map((s: any) => capStr(s, 80)).filter(Boolean)
      : capStr(f.items, 300);
  }
  if (f.notes !== undefined) parsed.notes = f.notes == null ? null : capStr(f.notes, 500);
  numField("kcal", 5000);
  numField("protein_g", 500);
  numField("carbs_g", 1000);
  numField("fat_g", 500);
  numField("fiber_g", 200);

  db.prepare(`UPDATE food_notes SET parsed_json = ?, enrichment_status = 'done' WHERE id = ?`)
    .run(JSON.stringify(parsed), id);
  if (f.meal !== undefined && f.meal !== null && String(f.meal).trim()) {
    db.prepare(`UPDATE food_notes SET meal = ? WHERE id = ?`).run(String(f.meal).trim().slice(0, 40), id);
  }
  return getFoodNote(id);
}

export function hydrate(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}
