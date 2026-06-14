// Shared coaching orchestration: the "run agent → validate parsed JSON shape →
// persist as draft/insight/review → return ok/ok:false" logic that src/api.ts
// (REST) and src/mcp.ts (MCP) both adapt. Per the project's architecture rule,
// this business logic lives in ONE place; the two protocol surfaces are thin
// wrappers that only translate the returned OBJECT into an HTTP response or an
// MCP asText payload. Each function here returns the plain result object — the
// designed { ok:true, ... } / { ok:false, error, tried } shape — never an HTTP
// response and never an MCP wrapper.

import * as repo from "./repo.js";
import { todayISO } from "./db.js";
import { runAgent, runAgentWithFallback } from "./agents.js";
import {
  buildMealSwapPrompt,
  buildRecipePrompt,
  buildHealthReviewPrompt,
  buildSessionPrompt,
  buildNutritionCheckinPrompt,
  buildInsightPrompt,
  buildWeeklyReadPrompt,
  buildMemoryConsolidationPrompt,
  buildAboutMeGrowthPrompt,
} from "./prompt.js";

// Run a prompt with an explicit agent, or "auto"/blank to use the configured
// rotation (round-robin / random / priority) with fallthrough on failure.
export async function runChosen(agent: string | undefined, prompt: string) {
  if (!agent || agent === "auto") {
    const fb = await runAgentWithFallback(repo.pickAgentOrder(), prompt);
    return { agent: fb.agent, result: fb.result, tried: fb.tried };
  }
  return { agent, result: await runAgent(agent, prompt), tried: [] as any[] };
}

// Build ONE session on demand. ok:false is the designed failure signal when the
// agent returns nothing usable. Inputs are the already-typed prompt options.
export async function suggestSession(
  agent: string | undefined,
  opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string }
) {
  const prompt = buildSessionPrompt(undefined, opts);
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p = result.parsed;
  const sane = p && typeof p === "object" && Array.isArray(p.items) && p.items.length > 0;
  if (!sane) return { ok: false as const, error: "agent returned no usable session", agent: chosen, tried };
  // Outcome learning: record what was suggested so a later pass can compare it to
  // what the athlete actually trained. Best-effort; never blocks the response.
  repo.recordSuggestion("session_suggest", opts.date ?? null, {
    minutes: opts.minutes ?? null, focus: opts.focus ?? null,
    est_minutes: Number(p.est_minutes) || null, item_count: p.items.length,
  });
  return { ok: true as const, session: p, agent: chosen, tried };
}

// Quiet adaptive-nutrition check-in. Drafts a nutrition_target proposal only on
// meaningful drift; change:false is the calm, common answer. ok:false is the
// designed failure signal. windowDays is passed verbatim to both the expenditure
// estimate (with a finite guard) and the prompt, mirroring the REST behavior.
export async function nutritionCheckin(agent: string | undefined, windowDays?: number) {
  const expenditure = repo.estimateExpenditure(Number.isFinite(windowDays as number) ? (windowDays as number) : 21);
  const prompt = buildNutritionCheckinPrompt(undefined, { windowDays });
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p = result.parsed;
  if (!p || typeof p !== "object") {
    return { ok: false as const, error: "agent returned no usable check-in", agent: chosen, tried, expenditure };
  }
  // No meaningful drift → no proposal. The calm, common answer.
  if (!p.change || !p.nutrition || !Number.isFinite(Number(p.nutrition.target_kcal))) {
    return { ok: true as const, change: false, summary: typeof p.summary === "string" ? p.summary : "", agent: chosen, tried, expenditure };
  }
  // Store the target change as a DRAFT proposal (status 'draft', never applied).
  const proposal = repo.createProposal(chosen, "nutrition: adaptive check-in", result.raw, {
    kind: "nutrition_target",
    summary: typeof p.summary === "string" ? p.summary : "",
    nutrition: p.nutrition,
    notes: typeof p.notes === "string" ? p.notes : "",
    expenditure,
  });
  // Outcome learning: record the proposed target + implied direction so a later
  // pass can check whether the bodyweight trend actually followed. Best-effort.
  const targetKcal = Number(p.nutrition.target_kcal);
  const tdee = Number((expenditure as any)?.tdee);
  repo.recordSuggestion("nutrition_checkin", todayISO(), {
    target_kcal: Number.isFinite(targetKcal) ? targetKcal : null,
    tdee: Number.isFinite(tdee) ? tdee : null,
    direction: Number.isFinite(targetKcal) && Number.isFinite(tdee) ? (targetKcal < tdee ? "down" : targetKcal > tdee ? "up" : "hold") : null,
  });
  return { ok: true as const, change: true, proposal, summary: typeof p.summary === "string" ? p.summary : "", agent: chosen, tried, expenditure };
}

// Agentically swap ONE meal in a drafted plan, honoring an optional free-text
// hint. The caller must have already resolved the plan (404 on unknown id lives
// in the adapter); this runs the agent + validation + persistence. ok:false at
// the protocol layer's 200 is the designed failure signal.
export async function swapMealAgentic(
  agent: string | undefined,
  args: { plan: any; id: number; day: string; mealIndex: number; hint?: string }
) {
  const { plan, id, day, mealIndex, hint } = args;
  const prompt = buildMealSwapPrompt({ plan, day, mealIndex, hint });
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p = result.parsed;
  const saneMeal = p && typeof p === "object" && typeof p.name === "string" && p.name.trim() && Number.isFinite(Number(p.kcal));
  if (!saneMeal) return { ok: false as const, error: "agent returned no usable meal", agent: chosen, tried };
  const swapped = repo.swapMealInPlan(id, day, mealIndex, p);
  if (!swapped) return { ok: false as const, error: "day or meal_index not found in plan", agent: chosen, tried };
  return { ok: true as const, plan: swapped.plan, meal: swapped.meal, agent: chosen, tried };
}

// Agentic recipe for ONE planned meal, cached on the meal inside parsed_json.
// The caller has already resolved the plan + checked for a cached recipe (the
// instant cached:true path lives in the adapter). ok:false at 200 is the
// designed failure signal.
export async function generateRecipe(
  agent: string | undefined,
  args: { plan: any; id: number; day: string; mealIndex: number }
) {
  const { plan, id, day, mealIndex } = args;
  const prompt = buildRecipePrompt({ plan, day, mealIndex });
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p = result.parsed;
  const saved = p && typeof p === "object" ? repo.setMealRecipe(id, day, mealIndex, p) : null;
  if (!saved) return { ok: false as const, error: "agent returned no usable recipe", agent: chosen, tried };
  return { ok: true as const, recipe: saved.recipe, plan: saved.plan, agent: chosen, tried };
}

// Run a fresh whole-picture health review via the shared agent rotation.
// ok:false at 200 is the designed failure signal when addHealthReview rejects
// the shape (the agent returned garbage).
export async function runHealthReview(agent: string | undefined) {
  const prompt = buildHealthReviewPrompt();
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const review = result.parsed && typeof result.parsed === "object"
    ? repo.addHealthReview(result.parsed, chosen, result.raw)
    : null;
  if (!review) return { ok: false as const, error: "agent returned no usable review", agent: chosen, tried };
  return { ok: true as const, review, agent: chosen, tried };
}

// Run ONE agentic pass over the whole picture for a single genuine cross-domain
// connection (or a weekly read), dedupe against what's already been said, and
// store it. ok:false is the designed failure signal — found:false, no text, a
// near-repeat, or an unusable shape. NO push notification ever fires.
export async function generateInsight(agent: string | undefined, kind?: string) {
  const k = kind === "weekly_read" ? "weekly_read" : "connection";
  const recent = repo.recentInsightTexts(12);
  const prompt = k === "weekly_read" ? buildWeeklyReadPrompt() : buildInsightPrompt(undefined, recent);
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p: any = result.parsed;
  const text = p && typeof p === "object" ? String(p.text ?? "").trim() : "";
  if (!p || typeof p !== "object" || p.found === false || !text || repo.isDuplicateInsight(text, recent)) {
    return { ok: false as const, error: "no genuine new insight", agent: chosen, tried };
  }
  const insight = repo.addInsight({ kind: k, text, rationale: p.rationale ?? null, next_step: p.next_step ?? null, status: "new" });
  return { ok: true as const, insight, agent: chosen, tried };
}

// ---------- self-updating memory ops (Stream 2) ----------

// Quiet memory consolidation: ask an agent to propose merges / supersessions /
// promotions over the live store, then apply them through the repo functions
// (which MARK, never hard-delete). Calm by default — an empty result is a clean
// no-op. Scheduled nightly; also callable on demand. NEVER notifies.
export async function consolidateMemory(agent: string | undefined) {
  const prompt = buildMemoryConsolidationPrompt();
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p: any = result.parsed;
  if (!p || typeof p !== "object") return { ok: false as const, error: "agent returned no usable plan", agent: chosen, tried };

  const idSet = new Set((repo.listMemory(200, { includeSuperseded: true }) as any[]).map((m: any) => Number(m.id)));
  let merged = 0, superseded = 0, promoted = 0;

  // MERGES: fold every other id into the first, with one combined sentence.
  for (const m of Array.isArray(p.merges) ? p.merges : []) {
    const ids = (Array.isArray(m?.ids) ? m.ids : []).map(Number).filter((n: number) => idSet.has(n));
    if (ids.length < 2 || !m?.content) continue;
    const [keep, ...rest] = ids;
    try {
      repo.updateMemory(keep, { content: String(m.content), kind: m.kind });
      for (const dup of rest) { repo.supersedeMemory(dup, { replacementId: keep, reason: "merged duplicate" }); merged++; }
    } catch { /* skip a bad row, keep going */ }
  }
  // SUPERSEDES: a later fact contradicts an older one.
  for (const s of Array.isArray(p.supersedes) ? p.supersedes : []) {
    const id = Number(s?.id);
    if (!idSet.has(id)) continue;
    try { repo.supersedeMemory(id, { content: s?.replacement, reason: s?.reason || "superseded" }); superseded++; } catch {}
  }
  // PROMOTIONS: a recurring observation has become a stable trait.
  for (const pr of Array.isArray(p.promotions) ? p.promotions : []) {
    const id = Number(pr?.id);
    if (!idSet.has(id) || !pr?.kind) continue;
    try { repo.updateMemory(id, { content: pr?.content, kind: String(pr.kind) }); promoted++; } catch {}
  }
  return { ok: true as const, merged, superseded, promoted, agent: chosen, tried };
}

// Grow profile.about_me into a coherent person-model from typed memory + family +
// check-ins. AUGMENTS, never overwrites blindly — the prompt preserves existing
// (user-authored) content, and we only write when the agent reports a real change.
export async function growAboutMe(agent: string | undefined) {
  const prompt = buildAboutMeGrowthPrompt();
  const { agent: chosen, result, tried } = await runChosen(agent, prompt);
  const p: any = result.parsed;
  const text = p && typeof p === "object" ? String(p.about_me ?? "").trim() : "";
  if (!p || typeof p !== "object" || p.changed === false || !text) {
    return { ok: true as const, changed: false, agent: chosen, tried };
  }
  const before = String((repo.getProfile() || {}).about_me ?? "").trim();
  if (text === before) return { ok: true as const, changed: false, agent: chosen, tried };
  const profile = repo.setProfile({ about_me: text });
  return { ok: true as const, changed: true, profile, agent: chosen, tried };
}

// Reconcile passed suggestions to actuals and write durable learnings. Pure repo
// math — no agent needed (calm, deterministic). Returns the counts.
export function reconcileOutcomes(opts?: { maxPerPass?: number }) {
  const r = repo.reconcileSuggestions(opts);
  return { ok: true as const, ...r };
}
