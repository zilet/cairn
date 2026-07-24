import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { draftMealPlan, generateRecipe, nutritionCheckin, swapMealAgentic } from "../coachOps.js";
import {
  acceptMealPlan,
  addFoodNote,
  deleteFoodNote,
  estimateExpenditure,
  frequentFoods,
  getDayIntake,
  getFoodNote,
  getMealPlan,
  nutritionProgress,
  listFoodNotes,
  listMealPlans,
  setMealPlanStatus,
  updateFoodNote,
  updateMealPlanDays,
} from "../domain/nutrition/index.js";
import { goalPace } from "../repo/goal-pace.js";
import { fuelingFollowThroughDue, listFuelingFeedback, setFuelingFeedback } from "../repo/fueling.js";
import { ACCEPTED_MIME } from "../uploadMime.js";
import { UPLOADS_DIR } from "../uploadPaths.js";
import { backgroundOp } from "./background-op.js";
import { streamEnrichRow } from "./enrich-stream.js";
import { currentUnderfuelingRead } from "../domain/brain/underfueling-service.js";
import { cutQualityRead } from "../repo/cut-quality.js";

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

nutritionRouter.get("/mealplans/:id", (req, res) => {
  const plan = getMealPlan(Number(req.params.id));
  if (!plan) return res.status(404).json({ error: "not found" });
  res.json(plan);
});

// ---- adaptive nutrition (T3 / Phase 3A) ----
// Best-effort chosen expenditure with explicit outcome/prior anchors. Read-only;
// powers the calm "Energy Balance" view. ?window= is safely clamped by the domain.
nutritionRouter.get("/nutrition/expenditure", (req, res) => {
  const window = req.query.window ? Number(req.query.window) : undefined;
  const expenditure = estimateExpenditure(Number.isFinite(window as number) ? (window as number) : 21);
  res.json({
    ...expenditure,
    underfueling: currentUnderfuelingRead(undefined, { expenditure }),
    cut_quality: cutQualityRead(undefined, { expenditure }),
  });
});

// Goal-pace series behind the motivational weight-progress chart: the canonical
// weigh-in points, the recent-trend line (with a short forward projection), and
// the straight line to the goal. Read-only, null-safe; ?days= clamps to 14–365.
nutritionRouter.get("/nutrition/goal-pace", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(goalPace(Number.isFinite(days as number) ? (days as number) : 90));
});

// A calm review of ONE day's logged food: entries stay nullable while legacy
// totals/remaining stay numeric (missing values contribute zero); additive
// `known` flags tell newer clients which nutrient sums are complete. A real
// target adds the gentle "remaining". ?date=YYYY-MM-DD overrides today.
nutritionRouter.get("/nutrition/day", (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(getDayIntake(date));
});

// Meaning-first multi-week recorded-intake read. The domain clamps ?days= to
// 14–90, returns every local calendar day with honest unknowns, names record
// observation density (not full-day completeness), and conditions every target
// comparison/advice on the records reflecting most of the day.
nutritionRouter.get("/nutrition/progress", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(nutritionProgress(Number.isFinite(days as number) ? (days as number) : 35));
});

// Quiet adaptive-nutrition check-in: medium/high outcome confidence may support
// a bounded change; low confidence is hold-only except for a server-verified
// protective fuel raise from fresh hybrid/fatigue evidence. The agent proposes and
// the server autonomy policy either schedules it for the next food-day boundary or
// holds it under explicit review posture. Most weeks nothing has moved
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

// Fueling follow-through. After a nutrition-target change applies, Today quietly offers a
// one-tap "how's fueling feeling?" read on days the athlete logs food, only inside the
// change's 7-day window. Read-only due-check + recent reads; `due:false` is the calm
// common answer, returned at status 200 like the other nutrition reads (never a 404).
nutritionRouter.get("/nutrition/fueling-followup", (_req, res) => {
  res.json({ ...fuelingFollowThroughDue(), recent: listFuelingFeedback(14) });
});

// Save today's (or ?date=) one-tap fueling read. Adherence-neutral; energy/hunger are the
// 1-3 running-low/steady/plenty scale, coerced/clamped at the trust boundary. Returns the
// saved row. Body: { date?, energy, hunger?, note? }.
nutritionRouter.post("/nutrition/fueling-feedback", (req, res) => {
  const b = req.body ?? {};
  const date = typeof b.date === "string" && b.date.trim() ? b.date.trim() : "";
  res.json(setFuelingFeedback(date, { energy: b.energy, hunger: b.hunger, note: b.note }));
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
  if (
    backgroundOp(
      res,
      "meal_swap",
      { agent: b.agent ?? null, id, day: String(b.day ?? ""), meal_index: Number(b.meal_index), hint: b.hint },
      b.agent
    )
  )
    return;
  try {
    res.json(
      await swapMealAgentic(b.agent, {
        plan,
        id,
        day: String(b.day ?? ""),
        mealIndex: Number(b.meal_index),
        hint: b.hint,
      })
    );
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
    (d: any) =>
      String(d?.day ?? "")
        .trim()
        .toLowerCase() === day.trim().toLowerCase()
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
  res.json(
    s === "accept" ? acceptMealPlan(Number(req.params.id)) : setMealPlanStatus(Number(req.params.id), "discarded")
  );
});

// ---- food notes (vision happens in the Claude client; this stores the result) ----
nutritionRouter.get("/food-notes", (req, res) =>
  res.json(listFoodNotes(req.query.limit ? Number(req.query.limit) : 20))
);

// Single food note row, hydrated (poll fallback for watching enrichment_status).
nutritionRouter.get("/food-notes/:id", (req, res) => {
  const f = getFoodNote(Number(req.params.id));
  if (!f) return res.status(404).json({ error: "not found" });
  res.json(f);
});

// Live enrichment status for one food note (Server-Sent Events) — the SSE-first
// path the PWA uses instead of polling; snapshot then transitions, close on
// terminal. EventSource can't set headers, so the PWA reaches this with ?token=.
nutritionRouter.get("/food-notes/:id/stream", streamEnrichRow("food", getFoodNote));

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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif|heic|heif)$/i.test(name)) {
    return res.status(400).json({ error: "bad name" });
  }
  const p = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  const ext = name.split(".").pop()!.toLowerCase();
  const mime = Object.entries(ACCEPTED_MIME).find(([, e]) => e === ext)?.[0] || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(p)
    .on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "read failed" });
    })
    .pipe(res);
});
