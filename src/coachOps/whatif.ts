// The what-if (v2 wave 5, "Ask"): the athlete asks a hypothetical in their own words,
// and the team answers with ONE proposed change and its ripple across the six stones.
//
// Two ops, deliberately separate:
//
//   whatIf()   — a READ. It runs one agent turn over the projected coach context (the
//                `what_if` prompt site) under an enforced schema, and returns
//                {ok, change, ripple[]}. It NEVER writes: no proposal, no ledger row, no
//                cache entry. A dead rotation is the designed {ok:false, error, tried}.
//   whatIfDo() — the "Do it" hand-off. It takes the what-if JOB's id and reads the
//                question and the change from the server's own stored answer (a client
//                never supplies the change, so it can never drop the clinical mark),
//                re-validates it, writes it as a DRAFT plan proposal, and routes that
//                draft through the ONE autonomy policy
//                (applyProposalWithAutonomy → decideAutonomyTier). It never applies on
//                its own authority: the policy decides the tier, and
//                  - anything clinical is held clinician-directed (the chat detector, now
//                    shared, reads the athlete's words and the change itself);
//                  - a calorie/protein target always waits on the athlete — the what-if
//                    did not run the check-in's protective caps, so the team never lands
//                    that number on its own (a half-target is completed from the active
//                    target, so the draft is always one the athlete can approve);
//                  - a training edit read against a plan that has moved since is
//                    requested at `ask`, never landed quietly: the policy then holds it
//                    (or, under lead mode, announces it with the one-tap Undo);
//                  - a goal (or anything without a concrete edit) is never drafted at
//                    all — a goal is the athlete's to name, in their own words.
//
// The `stub` agent is the offline smoke path, as it is for propose/apply: its canned
// reply is proposal-shaped, so asking it for a what-if answers from a small authored
// table instead (whatIfFloor), deterministically and with no spawn.
import { isWhatIfResult, WHAT_IF_SCHEMA } from "../agent-contracts.js";
import {
  WHAT_IF_CHANGE_KINDS,
  WHAT_IF_CONFIDENCE,
  WHAT_IF_DIRECTIONS,
  WHAT_IF_HINT_AREAS,
  type WhatIfChange,
  type WhatIfChangeKind,
  type WhatIfConfidence,
  type WhatIfDirection,
  type WhatIfHint,
  type WhatIfPlanChange,
  type WhatIfDoResult,
  type WhatIfDoState,
  type WhatIfResult,
  type WhatIfRippleEffect,
} from "../contracts/what-if.js";
import type { TodayStone, TodayStoneKey, TodayStoneTone } from "../contracts/today-stones.js";
import { applyProposalWithAutonomy } from "../domain/brain/autonomy-service.js";
import { clinicalPlanProvenance } from "../domain/brain/clinical-provenance.js";
import { TODAY_STONE_LABELS, TODAY_STONE_ORDER, todayStones } from "../domain/today/today-stones.js";
import { buildWhatIfPrompt } from "../prompt/whatif.js";
import { violatesReadingGrammar } from "../repo/day-read-grammar.js";
import { clampNutritionFloors } from "../repo/nutrition-safety.js";
import { getAgentJob, linkAgentJobRef } from "../repo/chat.js";
import { getActiveNutritionTarget } from "../repo/nutrition.js";
import { computeGoalCheck } from "../repo/profile.js";
import { captureProposalEvidence } from "../repo/proposal-truth.js";
import { createProposal, getProposal } from "../repo/proposals.js";
import { interactiveTimeoutForOp } from "../repo/settings.js";
import { localDateISO } from "../repo/shared.js";
import { runChosen } from "../runChosen.js";
import { agentFailure, agentStatusFor, type OpHooks } from "./shared.js";

export const WHAT_IF_OP = "what_if";
/** The proposal row's author: a draft the athlete handed over from a what-if. */
export const WHAT_IF_PROPOSAL_AGENT = "what-if";
export const WHAT_IF_INSTRUCTION_PREFIX = "what-if:";

const QUESTION_MAX = 1000;
const SUMMARY_MAX = 240;
const WHY_MAX = 200;
const CHANGES_MAX = 12;

// The what-if always reads TODAY: its prompt is today's coach context, so the stones
// it hands the model (and prints as `before`) are today's too — one picture, never two.
export interface WhatIfInput {
  text?: unknown;
  hint?: unknown;
}

/** Test seam: the one agent call, injectable so the agentic path runs offline. */
export interface WhatIfDeps {
  run?: typeof runChosen;
}

type Failure = {
  ok: false;
  error: string;
  tried: { agent: string; error: string }[];
  agent?: string | null;
  agent_busy?: true;
  agent_status?: "ok" | "unconfigured" | "all_failed";
};

// ---------- input normalization ----------

function cleanText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeHint(value: unknown): WhatIfHint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const area = (WHAT_IF_HINT_AREAS as readonly string[]).includes(String(raw.area))
    ? (raw.area as WhatIfHint["area"])
    : undefined;
  const direction = raw.direction === "more" || raw.direction === "less" ? raw.direction : undefined;
  return area || direction ? { ...(area ? { area } : {}), ...(direction ? { direction } : {}) } : null;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A positive whole count, or nothing. null, a fraction, a negative or a non-number
// never reaches the plan: the applier reads sets:0 as REMOVE, and Number(null) === 0,
// so a model writing null to mean "unchanged" would otherwise delete the lift.
function positiveIntOrUndefined(value: unknown): number | undefined {
  if (value == null || value === "" || typeof value === "boolean") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

// A run is never a plan item (migration 110): runs follow the stated run days and the
// run engine. Left among the strength edits, an un-kinded run would be applied as a
// fabricated lifting movement, so it is dropped here, before anything can draft it.
const RUN_WORDS = /\b(?:run|runs|running|jog|jogging|tempo|intervals?|long run|strides|fartlek)\b/i;
const RUN_FIELDS = ["target_distance_km", "target_duration_min", "target_zone", "interval"];

function normalizePlanChange(raw: unknown): WhatIfPlanChange | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const day = Number(c.day_number);
  if (!Number.isInteger(day) || day < 1) return null;
  if (RUN_FIELDS.some((field) => c[field] != null)) return null;
  const exercise = cleanText(c.exercise, 120);
  const swapRaw = c.swap && typeof c.swap === "object" ? (c.swap as Record<string, unknown>) : null;
  const swap = swapRaw ? { from: cleanText(swapRaw.from, 120), to: cleanText(swapRaw.to, 120) } : null;
  const validSwap = swap && swap.from && swap.to ? swap : null;
  if (!exercise && !validSwap) return null;
  if (RUN_WORDS.test(exercise) || (validSwap && (RUN_WORDS.test(validSwap.from) || RUN_WORDS.test(validSwap.to))))
    return null;
  const out: WhatIfPlanChange = { day_number: day };
  if (exercise) out.exercise = exercise;
  if (validSwap) out.swap = validSwap;
  // Only an explicit remove, or an explicit integer zero sets, removes a lift.
  const explicitZeroSets = c.sets === 0 || c.sets === "0";
  if (c.remove === true || explicitZeroSets) {
    out.remove = true;
  } else {
    for (const field of ["sets", "rep_low", "rep_high"] as const) {
      const n = positiveIntOrUndefined(c[field]);
      if (n !== undefined) out[field] = n;
    }
    // target_weight null is meaningful (bodyweight) and the applier reads it as
    // "unchanged", so it may ride; a hold's seconds must be a positive number.
    if (Object.hasOwn(c, "target_weight")) out.target_weight = finiteOrNull(c.target_weight);
    const seconds = finiteOrNull(c.target_seconds);
    if (seconds != null && seconds > 0) out.target_seconds = seconds;
  }
  const reason = cleanText(c.reason, 200);
  if (reason) out.reason = reason;
  return out;
}

function normalizeNutrition(raw: unknown): { target_kcal: number | null; protein_g: number | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  const kcal = finiteOrNull(n.target_kcal);
  const protein = finiteOrNull(n.protein_g);
  const target_kcal = kcal != null && kcal > 0 ? Math.round(kcal) : null;
  const protein_g = protein != null && protein > 0 ? Math.round(protein) : null;
  return target_kcal == null && protein_g == null ? null : { target_kcal, protein_g };
}

// A half-target ("more protein") is completed from the athlete's active target, so the
// draft names both numbers and can always be approved; with no active target to fill
// from, only a full target is doable.
function completeNutrition(
  n: { target_kcal: number | null; protein_g: number | null } | null
): { target_kcal: number; protein_g: number } | null {
  if (!n) return null;
  let active: { target_kcal: number | null; protein_g: number | null } | null = null;
  if (n.target_kcal == null || n.protein_g == null) {
    try {
      active = getActiveNutritionTarget();
    } catch {
      active = null;
    }
  }
  const kcal = n.target_kcal ?? (Number(active?.target_kcal) > 0 ? Math.round(Number(active?.target_kcal)) : null);
  const protein = n.protein_g ?? (Number(active?.protein_g) > 0 ? Math.round(Number(active?.protein_g)) : null);
  return kcal != null && protein != null ? { target_kcal: kcal, protein_g: protein } : null;
}

function clinicalFor(question: string, change: { summary: string; changes?: unknown; nutrition?: unknown }): boolean {
  return (
    clinicalPlanProvenance({
      message: question,
      action: change,
      imageAloneIsClinical: false,
      source: "what_if_clinical_detection",
    }) !== null
  );
}

/**
 * The change, re-read on the server. Used on the agent's answer AND again on the stored
 * answer at "Do it" — only a concrete strength edit or a complete positive nutrition
 * target is ever doable, and the clinical mark is the server's.
 */
export function normalizeWhatIfChange(raw: unknown, question = ""): WhatIfChange | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const summary = cleanText(c.summary, SUMMARY_MAX);
  if (!summary || violatesReadingGrammar(summary)) return null;
  const kind: WhatIfChangeKind = (WHAT_IF_CHANGE_KINDS as readonly string[]).includes(String(c.kind))
    ? (c.kind as WhatIfChangeKind)
    : "other";
  const change: WhatIfChange = { kind, summary, doable: false, clinical: false };
  if (kind === "training") {
    const changes = (Array.isArray(c.changes) ? c.changes : [])
      .slice(0, CHANGES_MAX)
      .map(normalizePlanChange)
      .filter((x): x is WhatIfPlanChange => x !== null);
    change.changes = changes;
    change.doable = changes.length > 0;
  } else if (kind === "nutrition") {
    const asked = normalizeNutrition(c.nutrition);
    const nutrition = completeNutrition(asked);
    if (nutrition ?? asked) change.nutrition = nutrition ?? asked ?? undefined;
    change.doable = nutrition !== null;
  }
  change.clinical = clinicalFor(question, change);
  return change;
}

// ---------- the ripple ----------

// A stone the answer does not touch reads steady, and says so plainly — never "costs".
const UNTOUCHED_WHY = "Nothing here should move much from this.";

function stoneBefore(stones: readonly TodayStone[], key: TodayStoneKey): TodayStone | null {
  return stones.find((s) => s.key === key) ?? null;
}

// Where a stone would likely sit, in the server's words — the renderer never works an
// "after" out itself. Steady keeps where it stands; an unsure move keeps a quiet tone.
const AFTER_WORDS: Record<Exclude<WhatIfDirection, "steady">, { word: string; tone: TodayStoneTone }> = {
  helps: { word: "better", tone: "ok" },
  costs: { word: "asks more", tone: "watch" },
  mixed: { word: "mixed", tone: "watch" },
};

function stoneAfter(
  before: { word: string; tone: TodayStoneTone },
  direction: WhatIfDirection,
  confidence: WhatIfConfidence
): { word: string; tone: TodayStoneTone } {
  if (direction === "steady") return { ...before };
  const after = AFTER_WORDS[direction];
  return confidence === "unsure" ? { word: after.word, tone: "quiet" } : { ...after };
}

function normalizeRipple(raw: unknown, stones: readonly TodayStone[]): WhatIfRippleEffect[] {
  const named = new Map<TodayStoneKey, { direction: WhatIfDirection; why: string; confidence: WhatIfConfidence }>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const key = String(e.stone ?? "").toLowerCase() as TodayStoneKey;
    if (!TODAY_STONE_ORDER.includes(key) || named.has(key)) continue;
    const direction = (WHAT_IF_DIRECTIONS as readonly string[]).includes(String(e.direction))
      ? (e.direction as WhatIfDirection)
      : "steady";
    const confidence = (WHAT_IF_CONFIDENCE as readonly string[]).includes(String(e.confidence))
      ? (e.confidence as WhatIfConfidence)
      : "unsure";
    const why = cleanText(e.why, WHY_MAX);
    if (!why || violatesReadingGrammar(why)) continue;
    named.set(key, { direction, why, confidence });
  }
  return TODAY_STONE_ORDER.map((key) => {
    const stone = stoneBefore(stones, key);
    const effect = named.get(key) ?? {
      direction: "steady" as const,
      why: UNTOUCHED_WHY,
      confidence: "unsure" as const,
    };
    const before = { word: stone?.word ?? "quiet", tone: stone?.tone ?? ("quiet" as const) };
    return {
      stone: key,
      label: stone?.label ?? TODAY_STONE_LABELS[key],
      ...effect,
      before,
      after: stoneAfter(before, effect.direction, effect.confidence),
    };
  });
}

// ---------- the offline floor (the `stub` agent) ----------

type FloorRow = [TodayStoneKey, WhatIfDirection, WhatIfConfidence, string];

// Authored, calm, one line each; every line passes the reading grammar (tested).
export const WHAT_IF_FLOOR_TABLE: Record<string, readonly FloorRow[]> = {
  "training:more": [
    ["strength", "helps", "likely", "More lifting gives your strength more to build on."],
    ["recovery", "costs", "possible", "More work asks more of your recovery between sessions."],
    ["fuel", "costs", "possible", "Extra sessions raise what your days need to eat."],
  ],
  "training:less": [
    ["strength", "costs", "possible", "Less lifting gives your strength less to build on."],
    ["recovery", "helps", "likely", "Fewer sessions leave more room to recover."],
  ],
  "endurance:more": [
    ["endurance", "helps", "likely", "More running builds more aerobic base."],
    ["recovery", "costs", "possible", "More running asks more of your legs and sleep."],
    ["fuel", "costs", "possible", "More running raises what your days need to eat."],
    ["heart", "helps", "possible", "Steady aerobic work tends to be kind to your heart."],
  ],
  "endurance:less": [
    ["endurance", "costs", "possible", "Less running gives your aerobic base less to build on."],
    ["recovery", "helps", "likely", "Less running leaves your legs fresher."],
  ],
  "fuel:more": [
    ["fuel", "helps", "likely", "More food covers more of what your training asks."],
    ["recovery", "helps", "possible", "Better-fueled days usually recover better."],
    ["body", "mixed", "possible", "Your weight trend may slow or turn, depending on where you're heading."],
  ],
  "fuel:less": [
    ["fuel", "costs", "likely", "Less food covers less of what your training asks."],
    ["recovery", "costs", "possible", "Leaner days can make recovery slower."],
    ["body", "mixed", "possible", "Your weight trend may move faster, depending on where you're heading."],
  ],
  "recovery:more": [
    ["recovery", "helps", "likely", "More rest gives your body more room to recover."],
    ["strength", "helps", "possible", "Fresher sessions tend to lift better."],
  ],
  "recovery:less": [
    ["recovery", "costs", "likely", "Less rest leaves less room to recover."],
    ["strength", "costs", "possible", "Tired sessions tend to lift less well."],
  ],
  "body:more": [["body", "mixed", "unsure", "How your body responds depends on what drives the change."]],
  "body:less": [["body", "mixed", "unsure", "How your body responds depends on what drives the change."]],
};

const FLOOR_KIND: Record<string, WhatIfChangeKind> = {
  training: "training",
  endurance: "other",
  fuel: "nutrition",
  recovery: "other",
  body: "goal",
};

export function whatIfFloor(question: string, hint: WhatIfHint | null, stones: readonly TodayStone[]) {
  const key = hint?.area && hint.direction ? `${hint.area}:${hint.direction}` : "";
  const rows = WHAT_IF_FLOOR_TABLE[key] ?? [];
  const kind: WhatIfChangeKind = hint?.area ? FLOOR_KIND[hint.area] : "other";
  // The floor never invents a concrete edit or a number: its change is the athlete's own
  // question, held as words, so "Do it" has nothing to draft from it.
  const change = normalizeWhatIfChange({ kind, summary: question }, question) ?? {
    kind: "other" as const,
    summary: "Your question, as asked.",
    doable: false,
    clinical: false,
  };
  change.doable = false;
  delete change.changes;
  delete change.nutrition;
  const ripple = normalizeRipple(
    rows.map(([stone, direction, confidence, why]) => ({ stone, direction, confidence, why })),
    stones
  );
  return { change, ripple };
}

// ---------- whatIf: the read ----------

function readStones(): { date: string; stones: TodayStone[] } {
  try {
    const read = todayStones();
    return { date: read.date, stones: read.stones };
  } catch {
    return { date: localDateISO(), stones: [] };
  }
}

// The plan this answer read, stamped so "Do it" can tell when it has moved since.
function planBasis(): string | null {
  try {
    return captureProposalEvidence().plan_fingerprint || null;
  } catch {
    return null;
  }
}

/**
 * Answer a what-if. NEVER writes. `{ok:false, error, tried}` is the designed failure —
 * no question, or no agent returned a usable answer.
 */
export async function whatIf(
  agent: string | undefined | null,
  input: WhatIfInput,
  hooks?: OpHooks,
  deps: WhatIfDeps = {}
): Promise<WhatIfResult | Failure> {
  const question = cleanText(input?.text, QUESTION_MAX);
  if (!question) return { ok: false, error: "a what-if needs a question in words", tried: [] };
  const hint = normalizeHint(input?.hint);
  const { date, stones } = readStones();

  if (agent === "stub") {
    const floor = whatIfFloor(question, hint, stones);
    return {
      ok: true,
      date,
      question,
      ...floor,
      plan_basis: null,
      source: "deterministic",
      agent: "stub",
      tried: [],
    };
  }

  hooks?.onPhase?.("talking it through with the team");
  const run = deps.run ?? runChosen;
  let chosen: string | null = null;
  let parsed: unknown = null;
  let tried: { agent: string; error: string }[] = [];
  try {
    const prompt = buildWhatIfPrompt(question, { stones, hint });
    const out = await run(agent ?? undefined, prompt, {
      op: WHAT_IF_OP,
      timeoutMs: interactiveTimeoutForOp(WHAT_IF_OP),
      signal: hooks?.signal,
      acceptParsed: isWhatIfResult,
      schema: WHAT_IF_SCHEMA,
    });
    chosen = out.agent;
    parsed = out.result?.parsed;
    tried = out.tried ?? [];
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false,
      error: "the team couldn't read this what-if right now",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const change = normalizeWhatIfChange(p?.change, question);
  if (!p || !change) {
    return {
      ok: false,
      error: "the team couldn't read this what-if right now",
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  return {
    ok: true,
    date,
    question,
    change,
    ripple: normalizeRipple(p.ripple, stones),
    plan_basis: change.kind === "training" && change.doable ? planBasis() : null,
    source: "agent",
    agent: chosen,
    tried,
  };
}

// ---------- whatIfDo: "Do it" ----------

export interface WhatIfDoInput {
  /** The what_if agent job whose stored answer is handed over. */
  job_id?: unknown;
  /**
   * True only when the caller IS the athlete's own explicit act in the app (the "Do it"
   * tap, routes/day-coach.ts). It is what makes the change their request
   * (`explicit_user_request`, which also keeps its sets as a same-day request); an MCP
   * client or any other caller never sets it, and its draft routes as the team's.
   */
  athlete_act?: boolean;
}

function doResult(
  state: WhatIfDoState,
  fields: Partial<Omit<WhatIfDoResult, "ok" | "state" | "tried">> = {}
): WhatIfDoResult {
  return {
    ok: state !== "refused",
    state,
    proposal_id: null,
    proposal_status: null,
    decision_id: null,
    tier: null,
    effective_date: null,
    plan_moved: false,
    change: null,
    ...fields,
    tried: [],
  };
}

const nothing = (error: string, extra: Partial<WhatIfDoResult> = {}): WhatIfDoResult =>
  doResult("refused", { ...extra, error });

/**
 * The autonomy policy's routed result, read into the what-if's own state. The policy
 * decided; this only names which of its outcomes it was.
 */
function routedState(routed: any): WhatIfDoState {
  if (routed?.ok === false) return "refused";
  const tier = routed?.tier ?? routed?.decision?.autonomy_tier ?? null;
  if (tier === "clinician") return "clinician";
  // The immediate-apply path carries applyProposal's `applied` ARRAY of what landed.
  if (Array.isArray(routed?.applied) || routed?.applied === true) return "landed";
  if (routed?.announced === true || routed?.pending === true) return "lands";
  return "waiting";
}

/**
 * Hand a what-if's change to the team as a DRAFT, routed by the autonomy policy.
 * The question and the change come from the server's own stored answer (the done
 * `what_if` job), never from a client echo. Never applies on its own authority;
 * `{ok:false, error, tried:[]}` when there is nothing concrete to draft. A second tap
 * on the same answer returns the first draft rather than writing another.
 */
export function whatIfDo(input: WhatIfDoInput): WhatIfDoResult {
  const jobId = Number(input?.job_id);
  if (!Number.isInteger(jobId) || jobId < 1) return nothing("a what-if answer is needed to hand over");
  const job = getAgentJob(jobId) as any;
  if (!job || job.kind !== WHAT_IF_OP) return nothing("there's no what-if answer here to hand over");
  if (job.status !== "done" || job.result?.ok !== true)
    return nothing("this what-if hasn't been answered yet", { job_status: job.status ?? null });
  const answer = job.result as WhatIfResult;
  const question = cleanText(answer.question ?? job.input?.text, QUESTION_MAX);
  const change = normalizeWhatIfChange(answer.change, question);
  if (!change) return nothing("there's no change here to hand over");
  if (job.ref_table === "plan_proposals" && Number(job.ref_id) > 0) {
    const existing = getProposal(Number(job.ref_id)) as any;
    if (existing) {
      return doResult("already", {
        proposal_id: Number(existing.id),
        proposal_status: existing.status ?? null,
        change,
      });
    }
  }
  if (!change.doable) {
    return nothing(
      change.kind === "goal"
        ? "a goal is yours to name — say it in chat and the team will take it from there"
        : change.kind === "nutrition"
          ? "this needs both a calorie and a protein number — ask the team in chat"
          : "this one is talked through rather than drafted — ask the team in chat",
      { kind: change.kind }
    );
  }
  const provenance = clinicalPlanProvenance({
    message: question,
    action: change,
    imageAloneIsClinical: false,
    source: "what_if_clinical_detection",
  });
  // The stored answer's own clinical mark is the server's; it can only tighten.
  const clinical = provenance !== null || answer.change?.clinical === true;
  // A training answer read against a plan that has since moved: the premise may be
  // gone (the applier upserts, so a lift removed since would silently return). It is
  // requested at `ask`, so it never lands quietly; the policy decides the rest.
  const planMoved = change.kind === "training" && (!answer.plan_basis || answer.plan_basis !== planBasis());
  const instruction = `${WHAT_IF_INSTRUCTION_PREFIX} ${change.summary}`.slice(0, 500);
  let payload: Record<string, unknown>;
  if (change.kind === "nutrition" && change.nutrition) {
    const bounded = clampNutritionFloors(
      { ...change.nutrition },
      { kcal: "target_kcal", protein: "protein_g" },
      safeGoalCheck()
    );
    payload = { kind: "nutrition_target", summary: change.summary, nutrition: bounded };
  } else {
    payload = { summary: change.summary, changes: change.changes ?? [] };
  }
  if (provenance) payload.clinical_provenance = provenance;
  const proposal = createProposal(WHAT_IF_PROPOSAL_AGENT, instruction, "", payload) as any;
  linkAgentJobRef(jobId, "plan_proposals", Number(proposal.id));
  const holdForAthlete = change.kind === "nutrition" || planMoved;
  const routed = applyProposalWithAutonomy(Number(proposal.id), {
    // The athlete asked for this change and tapped "Do it" in the app: their decision,
    // not a coach surprise. Only their own act carries the mark — an MCP client or any
    // other caller hands the change over as the team's. Every floor still applies on top.
    ...(input?.athlete_act === true ? { explicit_user_request: true } : {}),
    // A calorie target from a what-if always waits on the athlete: the check-in's
    // protective caps did not produce it, so the team never lands it on its own. A
    // training answer whose plan has moved since is requested at ask too.
    ...(holdForAthlete ? { requested_tier: "ask" as const } : {}),
    clinical,
    clinical_provenance: provenance ?? undefined,
  }) as any;
  const stored = getProposal(Number(proposal.id)) as any;
  const state = routedState(routed);
  const decisionId = Number(routed?.decision?.id);
  return doResult(state, {
    proposal_id: Number(proposal.id),
    proposal_status: stored?.status ?? null,
    decision_id: Number.isInteger(decisionId) && decisionId > 0 ? decisionId : null,
    tier: routed?.tier ?? routed?.decision?.autonomy_tier ?? null,
    effective_date: typeof routed?.effective_date === "string" ? routed.effective_date : null,
    plan_moved: planMoved,
    change,
    ...(state === "refused" ? { error: String(routed?.error ?? "the team couldn't take this change") } : {}),
  });
}

function safeGoalCheck(): unknown {
  try {
    return computeGoalCheck();
  } catch {
    return undefined;
  }
}
