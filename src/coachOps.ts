// Shared coaching orchestration: the "run agent → validate parsed JSON shape →
// persist as draft/insight/review → return ok/ok:false" logic that src/api.ts
// (REST) and src/mcp.ts (MCP) both adapt. Per the project's architecture rule,
// this business logic lives in ONE place; the two protocol surfaces are thin
// wrappers that only translate the returned OBJECT into an HTTP response or an
// MCP asText payload. Each function here returns the plain result object — the
// designed { ok:true, ... } / { ok:false, error, tried } shape — never an HTTP
// response and never an MCP wrapper.

import * as repo from "./repo.js";
import { runAgent, runAgentWithFallback, INTERACTIVE_TIMEOUT_MS, type RunOpts } from "./agents.js";
import {
  buildMealSwapPrompt,
  buildRecipePrompt,
  buildHealthReviewPrompt,
  buildSessionPrompt,
  buildNutritionCheckinPrompt,
  buildInsightPrompt,
  buildWeeklyReadPrompt,
} from "./prompt.js";
import { researchEnabled, gatherReviewGrounding, researchEvidence } from "./research.js";

// Run a prompt with an explicit agent, or "auto"/blank to use the configured
// rotation (round-robin / random / priority) with fallthrough on failure.
// `opts.op` labels the run for agent-stats telemetry; `opts.timeoutMs` lets
// interactive callers (session-suggest) shorten the leash. The "auto" path
// records telemetry itself (inside runAgentWithFallback); the explicit-agent
// path records one row here, failure-safe (telemetry never breaks the loop).
export async function runChosen(
  agent: string | undefined,
  prompt: string,
  opts: RunOpts & { op?: string } = {}
) {
  const op = opts.op ?? "auto";
  if (!agent || agent === "auto") {
    const fb = await runAgentWithFallback(repo.pickAgentOrder(), prompt, opts);
    return { agent: fb.agent, result: fb.result, tried: fb.tried };
  }
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runAgent>> | null = null;
  try {
    result = await runAgent(agent, prompt, { timeoutMs: opts.timeoutMs });
    return { agent, result, tried: [] as any[] };
  } finally {
    try {
      repo.recordAgentRun({
        op, agent,
        ok: !!result?.parsed,
        parsed: !!result?.parsed,
        latency_ms: Date.now() - started,
        tried_json: false,
      });
    } catch { /* telemetry never breaks the loop */ }
  }
}

// Build ONE session on demand. ok:false is the designed failure signal when the
// agent returns nothing usable. Inputs are the already-typed prompt options.
export async function suggestSession(
  agent: string | undefined,
  opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string }
) {
  const prompt = buildSessionPrompt(undefined, opts);
  // Interactive: a user is waiting on the request path — short the leash.
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: "session_suggest", timeoutMs: INTERACTIVE_TIMEOUT_MS });
  const p = result.parsed;
  const sane = p && typeof p === "object" && Array.isArray(p.items) && p.items.length > 0;
  if (!sane) return { ok: false as const, error: "agent returned no usable session", agent: chosen, tried };
  return { ok: true as const, session: p, agent: chosen, tried };
}

// Quiet adaptive-nutrition check-in. Drafts a nutrition_target proposal only on
// meaningful drift; change:false is the calm, common answer. ok:false is the
// designed failure signal. windowDays is passed verbatim to both the expenditure
// estimate (with a finite guard) and the prompt, mirroring the REST behavior.
export async function nutritionCheckin(agent: string | undefined, windowDays?: number) {
  const expenditure = repo.estimateExpenditure(Number.isFinite(windowDays as number) ? (windowDays as number) : 21);
  const prompt = buildNutritionCheckinPrompt(undefined, { windowDays });
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: "nutrition_checkin" });
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
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: "meal_swap" });
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
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: "recipe" });
  const p = result.parsed;
  const saved = p && typeof p === "object" ? repo.setMealRecipe(id, day, mealIndex, p) : null;
  if (!saved) return { ok: false as const, error: "agent returned no usable recipe", agent: chosen, tried };
  return { ok: true as const, recipe: saved.recipe, plan: saved.plan, agent: chosen, tried };
}

// Run a fresh whole-picture health review via the shared agent rotation.
// ok:false at 200 is the designed failure signal when addHealthReview rejects
// the shape (the agent returned garbage).
//
// GROUNDING (Stream 4): when settings.research_enabled is on, a host-side research
// pass first gathers cited evidence for the top off-optimal markers and the review
// prompt is asked to cite it; the agent-emitted citations are then VERIFIED inside
// addHealthReview → applyReviewDirectives (repo.verifyCitation). Research off / a
// research failure → ungrounded review, exactly today's behavior (never blocks).
export async function runHealthReview(agent: string | undefined) {
  let grounding: { passages?: any[] } | undefined;
  if (researchEnabled()) {
    try {
      const passages = await gatherReviewGrounding(agent);
      if (passages.length) grounding = { passages };
    } catch {
      /* research failed → run ungrounded (graceful degrade) */
    }
  }
  const prompt = buildHealthReviewPrompt(grounding);
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: "health_review" });
  const review = result.parsed && typeof result.parsed === "object"
    ? repo.addHealthReview(result.parsed, chosen, result.raw)
    : null;
  if (!review) return { ok: false as const, error: "agent returned no usable review", agent: chosen, tried };
  return { ok: true as const, review, agent: chosen, tried, grounded: !!grounding };
}

// Run ONE agentic pass over the whole picture for a single genuine cross-domain
// connection (or a weekly read), dedupe against what's already been said, and
// store it. ok:false is the designed failure signal — found:false, no text, a
// near-repeat, or an unusable shape. NO push notification ever fires.
export async function generateInsight(agent: string | undefined, kind?: string) {
  const k = kind === "weekly_read" ? "weekly_read" : "connection";
  const recent = repo.recentInsightTexts(12);
  const prompt = k === "weekly_read" ? buildWeeklyReadPrompt() : buildInsightPrompt(undefined, recent);
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: k === "weekly_read" ? "weekly_read" : "insight" });
  const p: any = result.parsed;
  const text = p && typeof p === "object" ? String(p.text ?? "").trim() : "";
  if (!p || typeof p !== "object" || p.found === false || !text || repo.isDuplicateInsight(text, recent)) {
    return { ok: false as const, error: "no genuine new insight", agent: chosen, tried };
  }
  const insight = repo.addInsight({ kind: k, text, rationale: p.rationale ?? null, next_step: p.next_step ?? null, status: "new" });
  return { ok: true as const, insight, agent: chosen, tried };
}

// Host-side research for the optional POST /api/research + MCP `research` tool.
// Runs a cited, web-grounded evidence pass and returns the cached rows. Gated by
// settings.research_enabled — when off it serves only what's already cached and
// reports ok:false (never reaches the network). INFORMATIONAL, not medical advice.
export async function runResearch(
  question: string,
  opts: { markers?: string[]; agent?: string; force?: boolean } = {}
) {
  return researchEvidence(String(question ?? ""), opts.markers ?? [], { agent: opts.agent, force: opts.force });
}
