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
import { INTERACTIVE_TIMEOUT_MS } from "./agents.js";
import { runChosen } from "./runChosen.js";
import {
  buildMealPlanPrompt,
  buildMealSwapPrompt,
  buildRecipePrompt,
  buildHealthReviewPrompt,
  buildSessionPrompt,
  buildSessionVerifyPrompt,
  buildPlanVerifyPrompt,
  buildNutritionCheckinPrompt,
  buildInsightPrompt,
  buildWeeklyReadPrompt,
  buildMemoryConsolidationPrompt,
  buildAboutMeGrowthPrompt,
} from "./prompt.js";
import { researchEnabled, gatherReviewGrounding, researchEvidence } from "./research.js";

// runChosen is the shared agent-dispatch helper (see ./runChosen.ts). It's
// re-exported here because api.ts / mcp.ts import it from coachOps as the
// single agentic-ops entry point.
export { runChosen };

// ---------- self-critique verify pass (Trust build V1) ----------
// Run ONE bounded follow-up agent turn that checks a just-produced high-stakes
// draft against its HARD floors/constraints and applies a returned fix. The
// contract is { ok, violations:[], fixed_draft? }. FAIL-OPEN by design: any
// failure (agent down, unparseable, wrong shape) returns the ORIGINAL draft
// unchanged with `verified:null` — exactly today's behavior, never load-bearing.
// `validate` re-checks a fixed_draft so a broken "fix" can't replace a good draft.
// Always-on, cheap, fully try/catch-wrapped (no setting, no schema).
export interface VerifyOutcome<T> {
  draft: T;
  verified: { checked: true; adjustments: string[] } | null;
}
async function runVerify<T>(
  agent: string | undefined,
  draft: T,
  buildPrompt: (d: T) => string,
  validate: (fixed: any) => boolean,
  op: string
): Promise<VerifyOutcome<T>> {
  try {
    const { result } = await runChosen(agent, buildPrompt(draft), { op, timeoutMs: INTERACTIVE_TIMEOUT_MS });
    const v: any = result.parsed;
    if (!v || typeof v !== "object") return { draft, verified: null };
    const violations: string[] = Array.isArray(v.violations)
      ? v.violations.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 240))
      : [];
    // A real fix that re-validates against the schema → adopt it.
    if (v.ok === false && v.fixed_draft && typeof v.fixed_draft === "object" && validate(v.fixed_draft)) {
      return { draft: v.fixed_draft as T, verified: { checked: true, adjustments: violations.length ? violations : ["adjusted to honor your floors"] } };
    }
    // Clean pass (or an unusable "fix" we decline to adopt) → the draft stands, but
    // we still mark it CHECKED so the surface can show "checked against your floors".
    return { draft, verified: { checked: true, adjustments: [] } };
  } catch {
    // Verify unavailable → ship the draft unverified (graceful degrade).
    return { draft, verified: null };
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
  // Self-critique: check the suggestion against the athlete's HARD constraints
  // (injury, time budget, equipment, encoding) and adopt a fix if one is returned.
  // Fail-open — verify down/garbage ⇒ the draft ships exactly as before.
  const sessionSane = (s: any) => s && typeof s === "object" && Array.isArray(s.items) && s.items.length > 0;
  const { draft: session, verified } = await runVerify(
    agent, p, (d) => buildSessionVerifyPrompt(d, opts), sessionSane, "session_verify"
  );
  // Outcome learning: record what was suggested so a later pass can compare it to
  // what the athlete actually trained. Best-effort; never blocks the response.
  repo.recordSuggestion("session_suggest", opts.date ?? null, {
    minutes: opts.minutes ?? null, focus: opts.focus ?? null,
    est_minutes: Number(session.est_minutes) || null, item_count: session.items.length,
  });
  return { ok: true as const, session, agent: chosen, tried, ...(verified ? { verified } : {}) };
}

// Draft a goal-aware weekly meal plan, then run a bounded self-critique verify
// pass against the lean-safe / longevity floors before persisting. ok:false on a
// non-JSON result mirrors the other agentic ops. The persisted plan is the
// VERIFIED draft (a fix is adopted only when it re-validates); `verified` carries
// the "checked against your floors" signal. Verify fails open (no agent / garbage
// ⇒ the original draft is persisted unverified — exactly today's behavior).
export async function draftMealPlan(agent: string | undefined, instruction?: string) {
  const prompt = buildMealPlanPrompt(instruction);
  const { agent: chosen, result, tried } = await runChosen(agent, prompt, { op: "meal_plan" });
  const p = result.parsed;
  const planSane = (m: any) => !!m && typeof m === "object" && Array.isArray(m.days);
  // Only a genuinely plan-shaped draft gets the verify pass; anything else
  // (e.g. unparsed output) is persisted as-is. Preserve today's contract:
  // ok mirrors !!result.parsed (createMealPlan tolerates a null parsed).
  if (!planSane(p)) {
    const plan = repo.createMealPlan(chosen, result.raw, p);
    return { ok: !!p as boolean, plan, agent: chosen, tried };
  }
  // Self-critique: check the plan against the lean-safe / longevity floors and
  // adopt a returned fix when it re-validates. Fail-open (verify down/garbage ⇒
  // the original draft is persisted, exactly today's behavior).
  const { draft: verifiedParsed, verified } = await runVerify(
    agent, p, buildPlanVerifyPrompt, planSane, "meal_plan_verify"
  );
  const plan = repo.createMealPlan(chosen, result.raw, verifiedParsed);
  return { ok: true as const, plan, agent: chosen, tried, ...(verified ? { verified } : {}) };
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
