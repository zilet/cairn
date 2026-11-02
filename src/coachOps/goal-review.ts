// The finished-goal review ("Behind you"): ONE look-back per finished goal, in the
// coach's own words, frozen once written (src/repo/goal-reviews.ts owns the facts and
// the store). Modeled on the health synthesis (coachOps/health.ts), non-streaming.
//
//   reviewGoal(id)          — run the op for one pending/failed row. The `stub` agent
//                             writes a canned deterministic review (offline smoke and
//                             tests). On success the row is saved READY and FROZEN; for
//                             the latest recent race, the proposed build levers are then
//                             validated against the race's facts and the accepted ones
//                             adopted (one brain_decisions row, announce + one-tap Undo,
//                             src/repo/build-levers.ts). A lever failure never loses the
//                             review — it is recorded on review_json.levers_result.
//   runGoalReviewNightly()  — the scheduler's pass: detect/snapshot, settle waiting
//                             races, then review AT MOST ONE row a night (oldest first),
//                             gated on the rows themselves (an attempt already made
//                             today, or nothing due, is a calm no-op).
//
// Failure: status failed, attempts+1, last_error — retried on a later night, at most
// GOAL_REVIEW_MAX_ATTEMPTS times. Host congestion (AgentBusyError) is NOT a failure:
// nothing is recorded, the envelope carries agent_busy, and the caller defers.
import { GOAL_REVIEW_SCHEMA, isGoalReviewResult } from "../agent-contracts.js";
import {
  adoptBuildLevers,
  BUILD_LEVER_KEYS,
  validateBuildLevers,
  type BuildLeverKey,
  type BuildLeverValidation,
} from "../repo/build-levers.js";
import type { GoalReviewDetail } from "../contracts/goal-reviews.js";
import { clockWords, dateWords, distanceWords, loadWords, weightWords } from "../repo/display-words.js";
import { goalReviewTextViolation } from "../repo/goal-review-grammar.js";
import {
  detectGoalReviews,
  getGoalReview,
  goalReviewRecord,
  nextGoalReviewDue,
  raceLeversEligible,
  recordGoalReviewFailure,
  saveGoalReview,
  saveGoalReviewLeversResult,
  type GoalReviewDetection,
  type GoalReviewRecord,
  type StoredGoalReview,
} from "../repo/goal-reviews.js";
import { athleteUnits } from "../repo/settings.js";
import { localDateISO } from "../repo/shared.js";
import { buildGoalReviewPrompt } from "../prompt/goal-review.js";
import { runChosen } from "../runChosen.js";
import { agentFailure, agentStatusFor, type OpHooks } from "./shared.js";

export const GOAL_REVIEW_OP = "goal_review";

// Length caps (characters) — a headline is one line on a list row; the three bodies are
// a few sentences each. Sentence caps follow the contract: story/lessons 2–4,
// carry-forward 1–3. Over-long text is trimmed at a sentence, never mid-word.
export const GOAL_REVIEW_LIMITS = {
  headline: 160,
  story: 900,
  lessons: 900,
  carry_forward: 600,
  because: 240,
  levers: BUILD_LEVER_KEYS.length,
} as const;
const SENTENCE_CAPS = { story: 4, lessons: 4, carry_forward: 3 } as const;

export interface GoalReviewDeps {
  run?: typeof runChosen;
  validateLevers?: typeof validateBuildLevers;
  adoptLevers?: typeof adoptBuildLevers;
  today?: string;
  /** The op's clock: attempt stamps (the one-a-night gate reads them). Default: now. */
  now?: () => Date;
}

type Tried = { agent: string; error: string }[];

export type GoalReviewOpResult =
  | {
      ok: true;
      review: GoalReviewDetail | null;
      agent: string | null;
      tried: Tried;
      levers: StoredGoalReview["levers_result"];
    }
  | {
      ok: false;
      error: string;
      tried: Tried;
      agent?: string | null;
      agent_busy?: true;
      agent_status?: "ok" | "unconfigured" | "all_failed";
    };

function clean(v: unknown, max: number): string {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max / 3) return cut.slice(0, end + 1);
  const word = cut.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:]$/, "");
  return `${word || cut.slice(0, max - 1)}…`;
}

function capSentences(s: string, n: number): string {
  const parts = s.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g);
  if (!parts || parts.length <= n) return s;
  return parts.slice(0, n).join("").trim();
}

/**
 * The agent's payload as a storable review, or null when any athlete-facing text is
 * missing or breaks the grammar / no-grading rule. Levers are kept only for a race,
 * one per known key, each `because` held to the same rule (a bad one drops the lever).
 */
export function normalizeGoalReview(input: unknown, kind: GoalReviewRecord["kind"]): StoredGoalReview | null {
  const p = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!p) return null;
  const headline = clean(p.headline, GOAL_REVIEW_LIMITS.headline);
  const story = capSentences(clean(p.story, GOAL_REVIEW_LIMITS.story), SENTENCE_CAPS.story);
  const lessons = capSentences(clean(p.lessons, GOAL_REVIEW_LIMITS.lessons), SENTENCE_CAPS.lessons);
  const carry = capSentences(clean(p.carry_forward, GOAL_REVIEW_LIMITS.carry_forward), SENTENCE_CAPS.carry_forward);
  if (!headline || !story || !lessons || !carry) return null;
  if ([headline, story, lessons, carry].some((t) => goalReviewTextViolation(t))) return null;
  const levers: NonNullable<StoredGoalReview["levers"]> = [];
  if (kind === "race" && Array.isArray(p.levers)) {
    const seen = new Set<string>();
    for (const raw of p.levers) {
      const l = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const key = String(l?.key ?? "").trim();
      // Only a real number reaches the validator: Number() reads null, "", false and []
      // as 0, which the bounds would clamp up to the tightest setting nobody proposed.
      const rawValue = l?.value;
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim()
            ? Number(rawValue.trim())
            : Number.NaN;
      const because = clean(l?.because, GOAL_REVIEW_LIMITS.because);
      if (!(BUILD_LEVER_KEYS as readonly string[]).includes(key) || seen.has(key)) continue;
      if (!Number.isFinite(value) || value <= 0 || !because || goalReviewTextViolation(because)) continue;
      seen.add(key);
      levers.push({ key, value, because });
      if (levers.length >= GOAL_REVIEW_LIMITS.levers) break;
    }
  }
  return { headline, story, lessons, carry_forward: carry, levers, levers_result: null };
}

/** The canned review the `stub` agent writes: true to the facts, deterministic, no levers. */
export function stubGoalReview(row: GoalReviewRecord): StoredGoalReview {
  const units = athleteUnits();
  const f = row.facts;
  if (f.kind === "race") {
    const dist = distanceWords(f.result.km, units.distance);
    const time = f.result.finish_sec != null ? ` in ${clockWords(f.result.finish_sec)}` : "";
    const weeks = f.build.weeks.length;
    const longest = f.longest_run ? distanceWords(f.longest_run.km, units.distance) : null;
    return {
      headline: `${row.title}: ${dist}${time}.`,
      story: `You ran ${row.title} over ${dist}${time}. The build behind it ran ${weeks} ${weeks === 1 ? "week" : "weeks"}${
        longest ? `, with a longest run of ${longest}` : ""
      }.`,
      lessons: `This build showed how your running carries a steady climb. The weeks you ran well are the ground the next one starts from.`,
      carry_forward: `The recovery days come first, then the next build steps off what this one showed.`,
      levers: [],
      levers_result: null,
      source: "stub",
    };
  }
  if (f.kind === "strength_objective") {
    const reached = loadWords(f.achieved_est_1rm ?? f.target_est_1rm, units.weight);
    return {
      headline: `${f.exercise} reached an estimated max of ${reached}.`,
      story: `You set out for ${row.title} and reached it on ${dateWords(f.achieved_date)}. ${f.exposures} ${
        f.exposures === 1 ? "session" : "sessions"
      } with the lift carried you there.`,
      lessons: `Steady exposures moved this lift. The work you logged is what got it there.`,
      carry_forward: `The strength you built here is the floor for the next objective.`,
      levers: [],
      levers_result: null,
      source: "stub",
    };
  }
  const at = weightWords(f.achieved_lb ?? f.goal_lb, units.weight);
  return {
    headline: `You reached your goal weight: ${at}.`,
    story: `You reached ${at} on ${dateWords(f.achieved_date)}${f.weeks != null ? ` after ${f.weeks} weeks` : ""}. The trend got you there.`,
    lessons: `A steady pace held over weeks moved the scale. Your logging made the road readable.`,
    carry_forward: `Holding here comes next, calmly, at maintenance.`,
    levers: [],
    levers_result: null,
    source: "stub",
  };
}

/** Validate + adopt a race review's proposed levers; never throws (a failure is recorded). */
function settleLevers(
  row: GoalReviewRecord,
  stored: StoredGoalReview,
  deps: GoalReviewDeps,
  today: string
): StoredGoalReview["levers_result"] {
  if (row.facts.kind !== "race" || !raceLeversEligible(row, today)) return null;
  const proposals = stored.levers ?? [];
  if (!proposals.length) return { accepted: [], rejected: [], decision_id: null };
  let validation: BuildLeverValidation;
  try {
    validation = (deps.validateLevers ?? validateBuildLevers)(proposals, row.facts.build_lever_facts);
  } catch (error: any) {
    return { accepted: [], rejected: [], decision_id: null, error: String(error?.message ?? error).slice(0, 200) };
  }
  let decisionId: number | null = null;
  if (validation.accepted.length) {
    try {
      const adopted = (deps.adoptLevers ?? adoptBuildLevers)(row.id, validation.accepted, today);
      decisionId = adopted.decision_id;
      // Nothing landed (the athlete's posture is "review everything"): the levers held up
      // but were NOT kept, and the record never says they were.
      if (!(adopted.adopted > 0)) {
        return { accepted: [], rejected: validation.rejected, decision_id: null, parked: validation.accepted };
      }
    } catch (error: any) {
      return {
        accepted: [],
        rejected: [
          ...validation.rejected,
          ...validation.accepted.map((a) => ({ key: a.key, reason: "could not be adopted" })),
        ],
        decision_id: null,
        error: String(error?.message ?? error).slice(0, 200),
      };
    }
  }
  return { accepted: validation.accepted, rejected: validation.rejected, decision_id: decisionId };
}

/**
 * Review one finished goal. `{ok:false, error, tried}` is the designed failure: the row
 * is absent, already frozen, still waiting out its recovery days, or no agent wrote a
 * usable review (recorded as a failed attempt — unless the host was only busy).
 */
export async function reviewGoal(
  id: number,
  agent: string | undefined | null,
  hooks?: OpHooks,
  deps: GoalReviewDeps = {}
): Promise<GoalReviewOpResult> {
  const at = deps.now?.() ?? new Date();
  const today = deps.today ?? localDateISO(at);
  const row = goalReviewRecord(id);
  if (!row) return { ok: false, error: "no such finished goal", tried: [] };
  if (row.frozen_at) return { ok: false, error: "this goal has already been looked back on", tried: [] };
  if (row.status === "waiting")
    return { ok: false, error: "looked back on once the recovery days are done", tried: [] };

  let stored: StoredGoalReview | null;
  let chosen: string | null = null;
  let tried: Tried = [];
  if (agent === "stub") {
    stored = stubGoalReview(row);
    chosen = "stub";
  } else {
    hooks?.onPhase?.(`looking back on ${row.title}`);
    const leverKeys: readonly BuildLeverKey[] | null =
      row.facts.kind === "race" && raceLeversEligible(row, today) ? BUILD_LEVER_KEYS : null;
    let parsed: unknown = null;
    try {
      const prompt = buildGoalReviewPrompt(row, { units: athleteUnits(), leverKeys, today });
      const out = await (deps.run ?? runChosen)(agent ?? undefined, prompt, {
        op: GOAL_REVIEW_OP,
        signal: hooks?.signal,
        acceptParsed: isGoalReviewResult,
        schema: GOAL_REVIEW_SCHEMA,
      });
      chosen = out.agent ?? null;
      parsed = out.result?.parsed;
      tried = out.tried ?? [];
    } catch (error) {
      const failure = agentFailure(error, hooks);
      if (!failure.agent_busy) recordGoalReviewFailure(row.id, "no agent wrote a usable review", at);
      return {
        ok: false,
        error: "no agent wrote a usable review",
        ...failure,
        agent_status: agentStatusFor({ ok: false, ...failure }),
      };
    }
    stored = normalizeGoalReview(parsed, row.kind);
    if (stored) stored.source = "agent";
  }

  if (!stored) {
    recordGoalReviewFailure(row.id, "the review broke the reading rules or was incomplete", at);
    return {
      ok: false,
      error: "no agent wrote a usable review",
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }

  if (!saveGoalReview(row.id, stored, chosen, at)) {
    return { ok: false, error: "this goal has already been looked back on", agent: chosen, tried };
  }
  const leversResult = settleLevers(row, stored, deps, today);
  if (leversResult) saveGoalReviewLeversResult(row.id, leversResult);
  return { ok: true, review: getGoalReview(row.id, today), agent: chosen, tried, levers: leversResult };
}

export interface GoalReviewNightlyResult {
  detection: GoalReviewDetection;
  /** The row reviewed tonight (null: nothing due, or one was already attempted today). */
  reviewed: { id: number; ok: boolean; agent_busy?: boolean } | null;
  result: GoalReviewOpResult | null;
}

/**
 * The nightly pass: snapshot what finished, settle the races whose recovery days are
 * done, then look back on AT MOST ONE goal (the oldest due) — so a backfill of old
 * completed objectives trickles in a night at a time. Idempotent on the rows: run
 * twice in one night, the second finds today's attempt and reviews nothing.
 */
export async function runGoalReviewNightly(
  agent: string | undefined | null = "auto",
  deps: GoalReviewDeps & { review?: typeof reviewGoal } = {}
): Promise<GoalReviewNightlyResult> {
  const today = deps.today ?? localDateISO();
  const detection = detectGoalReviews(today);
  const due = nextGoalReviewDue(today);
  if (!due) return { detection, reviewed: null, result: null };
  const result = await (deps.review ?? reviewGoal)(due.id, agent, undefined, { ...deps, today });
  return {
    detection,
    reviewed: { id: due.id, ok: result.ok, ...(!result.ok && result.agent_busy ? { agent_busy: true } : {}) },
    result,
  };
}

/**
 * Why a review cannot be queued for this row, or null when it can: the surfaces (REST
 * POST /api/goal-reviews/:id/review, MCP review_goal) ask this before queueing the
 * durable job, so a frozen review is refused at once rather than inside a job.
 */
export function goalReviewQueueRefusal(id: number): string | null {
  const row = goalReviewRecord(id);
  if (!row) return "no such finished goal";
  if (row.frozen_at) return "this goal has already been looked back on";
  if (row.status === "waiting") return "looked back on once the recovery days are done";
  return null;
}
