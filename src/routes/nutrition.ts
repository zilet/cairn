import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  draftMealPlan,
  generateRecipe,
  nutritionCheckin,
  swapMealAgentic,
} from "../coachOps.js";
import {
  acceptMealPlan,
  addFoodNote,
  deleteFoodNote,
  estimateExpenditure,
  frequentFoods,
  getDayIntake,
  getFoodNote,
  getMealPlan,
  listFoodNotes,
  listMealPlans,
  setMealPlanStatus,
  updateFoodNote,
  updateMealPlanDays,
} from "../domain/nutrition/index.js";
import { ACCEPTED_MIME } from "../uploadMime.js";
import { UPLOADS_DIR } from "../uploadPaths.js";
import { backgroundOp } from "./background-op.js";

export const nutritionRouter = Router();

// ---- meal plans ----
// Draft a goal-aware weekly meal plan, then run a bounded self-critique verify
// pass against the lean-safe / longevity floors before persisting (see
// coachOps.draftMealPlan). The persisted plan is the verified draft; `verified`
// carries the "checked against your floors" signal. Verify fails open.
nutritionRouter.post("/coach/mealplan", async (req, res) => {
  const { agent, instruction } = req.body ?? {};
  if (backgroundOp(res, "meal_plan", { agent: agent ?? null, instruction }, agent)) return;
  try {
    res.json(await draftMealPlan(agent, instruction));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

nutritionRouter.get("/mealplans", (req, res) =>
  res.json(listMealPlans(req.query.limit ? Number(req.query.limit) : 10))
);

// ---- adaptive nutrition (T3 / Phase 3A) ----
// Derived real expenditure (MacroFactor-style), adherence-neutral. Read-only;
// powers the calm "Energy Balance" view. ?window= overrides the 21-day window.
nutritionRouter.get("/nutrition/expenditure", (req, res) => {
  const window = req.query.window ? Number(req.query.window) : undefined;
  res.json(estimateExpenditure(Number.isFinite(window as number) ? (window as number) : 21));
});

// A calm review of ONE day's logged food (v41): the entries (each editable),
// the running totals, and — only when a real target exists (a loss/gain goal, or
// the maintenance anchor) — a gentle "remaining". ?date=YYYY-MM-DD overrides today.
nutritionRouter.get("/nutrition/day", (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(getDayIntake(date));
});

// Quiet adaptive-nutrition check-in: when the derived expenditure has drifted
// meaningfully off the goal, the agent drafts a calorie/macro target CHANGE as a
// DRAFT proposal to review — never auto-applied. Most weeks nothing has moved
// (change:false) and no proposal is created. ok:false (status 200) is the
// designed failure signal, mirroring the swap/recipe endpoints.
nutritionRouter.post("/nutrition/checkin", async (req, res) => {
  const b = req.body ?? {};
  const window = b.window ? Number(b.window) : undefined;
  if (backgroundOp(res, "nutrition_checkin", { agent: b.agent ?? null, window }, b.agent)) return;
  try {
    res.json(await nutritionCheckin(b.agent, window));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Agentic swap of ONE meal in a drafted plan, honoring an optional free-text
// hint ("let's go with fish"). ok:false (status 200) is the designed failure
// signal when the agent returns garbage — the PWA api() helper reads the body
// regardless of status.
nutritionRouter.post("/meal-plans/:id/swap", async (req, res) => {
  const b = req.body ?? {};
  const id = Number(req.params.id);
  const plan = getMealPlan(id);
  if (!plan) return res.status(404).json({ error: "not found" });
  if (backgroundOp(res, "meal_swap", { agent: b.agent ?? null, id, day: String(b.day ?? ""), meal_index: Number(b.meal_index), hint: b.hint }, b.agent)) return;
  try {
    res.json(await swapMealAgentic(b.agent, { plan, id, day: String(b.day ?? ""), mealIndex: Number(b.meal_index), hint: b.hint }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Agentic recipe for ONE planned meal, cached on the meal inside parsed_json.
// Cached recipe → instant { ok, recipe, cached:true } unless force. Like the
// swap endpoint, ok:false at status 200 is the designed failure signal.
nutritionRouter.post("/meal-plans/:id/recipe", async (req, res) => {
  const b = req.body ?? {};
  const id = Number(req.params.id);
  const plan = getMealPlan(id);
  if (!plan) return res.status(404).json({ error: "not found" });
  const day = String(b.day ?? "");
  const mealIndex = Number(b.meal_index);
  const dayObj = (Array.isArray(plan.parsed?.days) ? plan.parsed.days : []).find(
    (d: any) => String(d?.day ?? "").trim().toLowerCase() === day.trim().toLowerCase()
  );
  const existing = Array.isArray(dayObj?.meals) ? dayObj.meals[mealIndex]?.recipe : undefined;
  if (existing && !b.force) return res.json({ ok: true, recipe: existing, cached: true });
  if (backgroundOp(res, "recipe", { agent: b.agent ?? null, id, day, meal_index: mealIndex }, b.agent)) return;
  try {
    res.json(await generateRecipe(b.agent, { plan, id, day, mealIndex }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Replace a plan's days array (manual meal reorder/edit). Preserves every other
// parsed_json key (daily_kcal, shopping, notes, ...).
nutritionRouter.put("/meal-plans/:id/days", (req, res) => {
  try {
    const updated = updateMealPlanDays(Number(req.params.id), (req.body ?? {}).days);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

nutritionRouter.post("/mealplans/:id/:status", (req, res) => {
  const s = req.params.status;
  if (!["accept", "discard"].includes(s)) return res.status(400).json({ error: "bad status" });
  res.json(s === "accept" ? acceptMealPlan(Number(req.params.id)) : setMealPlanStatus(Number(req.params.id), "discarded"));
});

// ---- food notes (vision happens in the Claude client; this stores the result) ----
nutritionRouter.get("/food-notes", (req, res) =>
  res.json(listFoodNotes(req.query.limit ? Number(req.query.limit) : 20))
);

// Single food note row, hydrated (frontend polls this to watch enrichment_status).
nutritionRouter.get("/food-notes/:id", (req, res) => {
  const f = getFoodNote(Number(req.params.id));
  if (!f) return res.status(404).json({ error: "not found" });
  res.json(f);
});

nutritionRouter.post("/food-notes", (req, res) => {
  const b = req.body ?? {};
  res.json(addFoodNote(b.meal, b.raw ?? b.text ?? "", b.parsed ?? null, b.image_path));
});

// Manual correction of a logged food note (fix a macro, rename it, change the meal
// slot, "I changed my mind"). Stamps enrichment terminal so it isn't re-clobbered.
// 404 on unknown id.
nutritionRouter.put("/food-notes/:id", (req, res) => {
  const updated = updateFoodNote(Number(req.params.id), req.body ?? {});
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

nutritionRouter.delete("/food-notes/:id", (req, res) => res.json(deleteFoodNote(Number(req.params.id))));

// One-tap "frequents": the foods most often logged near a time of day (±2h),
// most-frequent first (max 8), with macros carried from the latest occurrence
// when present. ?hour= overrides the server clock (the PWA passes the device
// hour so frequents match the user's local time-of-day, not UTC).
nutritionRouter.get("/frequent-foods", (req, res) => {
  const hour = req.query.hour != null ? Number(req.query.hour) : undefined;
  res.json(frequentFoods(Number.isFinite(hour) ? hour : undefined));
});

// Serve a chat-attached photo back to the PWA. Filename is locked to the
// UUID.ext shape we generate below, so no traversal / no serving arbitrary files.
nutritionRouter.get("/chat-images/:name", (req, res) => {
  const name = String(req.params.name);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif|heic|heif)$/i.test(name)
  ) {
    return res.status(400).json({ error: "bad name" });
  }
  const p = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  const ext = name.split(".").pop()!.toLowerCase();
  const mime = Object.entries(ACCEPTED_MIME).find(([, e]) => e === ext)?.[0] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(p).on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "read failed" });
  }).pipe(res);
});
