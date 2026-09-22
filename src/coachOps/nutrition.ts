// Nutrition coaching ops: the meal-plan draft (and its pre-persistence floor),
// the adaptive nutrition check-in and its personalized target, goal-date
// adaptation, meal swap and recipe generation.
// Split out of the former single-file src/coachOps.ts — behavior-preserving.

import { hasRecentDecisionVeto, listBrainDecisions } from "../repo/brain-decisions.js";
import { capProtectiveRaise, cutReaffirmation, deriveCutTarget } from "../repo/cut-target.js";
import type { CutTargetDerivation } from "../repo/cut-target.js";
import { estimateExpenditure } from "../repo/expenditure.js";
import { recordSuggestion } from "../repo/memory.js";
import { createMealPlan, getActiveNutritionTarget, getMealPlan, setMealRecipe, swapMealInPlan, validateMealPlanForPersistence } from "../repo/nutrition.js";
import { computeGoalCheck, getProfile } from "../repo/profile.js";
import { getProgramState } from "../repo/program-state.js";
import { createProposal, getProposal } from "../repo/proposals.js";
import { getRecentSessions } from "../repo/sessions.js";
import { mealPlanFloorPrecheck } from "../repo/verify-floors.js";
import { addDaysISO, localDateISO } from "../repo/shared.js";
import { daysBetweenISO } from "../lib/dates.js";
import { sessionNoteSuggestsFatigue, sessionNoteSuggestsRapidFade } from "../repo/training-fatigue.js";
import type { FallbackResult } from "../agents.js";
import { runChosen, runChosenStreaming } from "../runChosen.js";
import { buildMealPlanPrompt, buildMealSwapPrompt, buildRecipePrompt, buildPlanVerifyPrompt, buildNutritionCheckinPrompt } from "../prompt.js";
import { clampNutritionFloors } from "../repo/nutrition-safety.js";
import { applyGoalDateAdaptationWithAutonomy, applyMealPlanWithAutonomy, applyProposalWithAutonomy } from "../domain/brain/autonomy-service.js";
import { personalizedNutritionStep } from "../domain/brain/underfueling-service.js";
import { MEAL_PLAN_STRUCTURE_SCHEMA, MEAL_SWAP_SCHEMA, NUTRITION_CHECKIN_SCHEMA, RECIPE_SCHEMA, isMealPlanStructureResult, isMealSwapResult, isNutritionCheckinResult, isRecipeResult } from "../agent-contracts.js";
import { agentFailure, agentStatusFor, runVerify } from "./shared.js";
import type { OpHooks } from "./shared.js";

// Exported for a focused deterministic boundary test. This is the same guard
// draftMealPlan runs immediately before persistence/autonomy; the verifier agent
// remains advisory and cannot authorize an inadequate plan.
export function validateMealPlanDraftForPersistence(parsed: any, dietaryInstruction?: string) {
  const check = validateMealPlanForPersistence(parsed, { dietary_instruction: dietaryInstruction });
  return check.ok
    ? { ok: true as const, parsed: check.parsed, adequacy_checked: check.adequacy_checked }
    : { ok: false as const, error: check.error };
}

// Turn an agent's adaptive-nutrition suggestion into the bounded target the
// proposal actually carries. The personal-response layer may tune the SIZE of
// the nudge, but the universal 250-kcal ceiling and lean-safe kcal/protein floors
// remain authoritative. Exported so the deterministic boundary is testable.
export function personalizeNutritionCheckinTarget(
  nutrition: any,
  goalInput?: any,
  opts: { cutAnchor?: CutTargetDerivation | null; protective?: boolean } = {}
): any {
  if (!nutrition || typeof nutrition !== "object") return nutrition;
  const goal = goalInput ?? computeGoalCheck();
  const rawTarget = Number(nutrition.target_kcal);
  if (!Number.isFinite(rawTarget)) return nutrition;
  const fallbackTarget = Number(goal?.effective_target?.target_kcal);
  let activeTarget = Number.NaN;
  if (!Number.isFinite(fallbackTarget)) {
    try {
      activeTarget = Number(getActiveNutritionTarget()?.target_kcal);
    } catch {
      activeTarget = Number.NaN;
    }
  }
  // Agent-supplied prev_target_kcal is display context, never authority. The
  // active/effective server target owns both the delta and the +/-250 boundary.
  const previous = Number.isFinite(fallbackTarget) ? fallbackTarget : activeTarget;
  let target = rawTarget;
  if (Number.isFinite(previous)) {
    const rawDelta = rawTarget - previous;
    const sign = rawDelta < 0 ? -1 : rawDelta > 0 ? 1 : 0;
    // Any requested change becomes the same phase-aware, canonical 100-250 kcal
    // step the deterministic underfuel controller uses. The model chooses the
    // direction; Cairn owns magnitude, 25-kcal rounding and safety authority.
    const standardStep = Math.min(250, Math.abs(rawDelta));
    const learnedStep = sign === 0 ? 0 : personalizedNutritionStep(standardStep, localDateISO(), 250);
    target = Math.round(previous + sign * learnedStep);
  }
  // THE GROUNDED CEILING. During a cut the athlete has affirmed, a RAISE toward
  // maintenance is not the model's to make on judgement: it has to be what the
  // athlete's own logged intake and weight trend imply. `cutAnchor` is that
  // derivation (repo/cut-target.ts) — maintenance measured from the record, minus
  // the bounded deficit — so a suggestion above it is a suggestion the evidence
  // does not support, and it is pulled back to the anchor.
  //
  // Three deliberate escapes, in order of who wins:
  //   - A CUT is never manufactured here. Clamping a raise can at most hold the
  //     target where it already was; it can never push it below the number in
  //     force, because that would turn "the raise isn't supported" into a cut
  //     nobody asked for.
  //   - PROTECTIVE evidence (fresh deterministic under-fuelling / fading
  //     performance) is exactly the grounded evidence the rule asks for, so it
  //     passes the grounded ceiling — but under a ceiling of its own, below.
  //   - The lean-safe kcal FLOOR still runs afterwards and still wins. A safety
  //     floor is never subordinate to a ceiling.
  //
  // PROTECTION BUYS MAINTENANCE, NEVER A SURPLUS. The protective escape used to be
  // unbounded, and the evidence that opens it — heavy endurance load during a cut —
  // is a CHRONIC state rather than an event, so every check-in found it open and
  // added another bounded step until the target had ratcheted past maintenance. A
  // protective raise now stops at the measured maintenance the anchor carries
  // (`capProtectiveRaise`, repo/cut-target.ts) — and only when that maintenance was
  // MEASURED off the record, since a formula prior is not headroom — and, like the
  // grounded clamp, can never land below the number already in force. `clamped` and
  // `protective_capped`
  // stay DISTINCT in the stamped payload: the first says the record did not support
  // the raise at all, the second that protection was allowed but only up to
  // maintenance.
  let anchorClamped = false;
  let protectiveCapped = false;
  const anchorTarget = Number(opts.cutAnchor?.target_kcal);
  if (opts.protective) {
    if (opts.cutAnchor && Number.isFinite(previous)) {
      const capped = capProtectiveRaise(target, previous, opts.cutAnchor.tdee_kcal, opts.cutAnchor.tdee_basis);
      target = capped.target_kcal;
      protectiveCapped = capped.capped;
    }
  } else if (Number.isFinite(anchorTarget) && Number.isFinite(previous) && target > previous && target > anchorTarget) {
    target = Math.round(Math.max(previous, anchorTarget));
    anchorClamped = true;
  }
  // THE DEEPENING WAITS FOR AN ORDINARY WEEK (rule 5, repo/cut-target.ts). The
  // anchor has already read the training week this target would be eaten in and
  // held its own number; the check-in must not step past that hold on the model's
  // judgement, or the derivation's answer would only bind the surfaces that read it
  // directly. The hold has teeth only DOWNWARD: a raise is the protective path
  // above. What it holds is the DEFICIT: the floor is the anchor's own held target,
  // which never sits above `tdee - CUT_DEFICIT_MIN_KCAL` — so a number protection had
  // lifted to maintenance is not "held" as a zero-deficit cut. The step comes at the
  // next normal week.
  let deepeningHeld = false;
  if (opts.cutAnchor?.deepening_held === true && Number.isFinite(previous) && target < previous) {
    const heldAt = Number(opts.cutAnchor.target_kcal);
    const floor = Number.isFinite(heldAt) ? Math.min(previous, heldAt) : previous;
    if (target < floor) {
      target = Math.round(floor);
      deepeningHeld = true;
    }
  }
  const bounded = clampNutritionFloors(
    {
      ...nutrition,
      target_kcal: target,
      prev_target_kcal: Number.isFinite(previous) ? Math.round(previous) : null,
      ...(opts.cutAnchor
        ? {
            cut_anchor: {
              target_kcal: opts.cutAnchor.target_kcal,
              tdee_kcal: opts.cutAnchor.tdee_kcal,
              tdee_basis: opts.cutAnchor.tdee_basis,
              confidence: opts.cutAnchor.confidence,
              deficit_kcal: opts.cutAnchor.deficit_kcal,
              clamped: anchorClamped,
              protective_capped: protectiveCapped,
              deepening_held: deepeningHeld,
            },
          }
        : {}),
    },
    { kcal: "target_kcal", protein: "protein_g" },
    goal
  );
  if (Number.isFinite(previous)) {
    const delta = Math.round(Number(bounded.target_kcal) - previous);
    if ("delta_kcal" in bounded) bounded.delta_kcal = delta;
    if ("change_kcal" in bounded) bounded.change_kcal = delta;
  }
  return bounded;
}

// A low-confidence outcome estimate may never justify a calorie cut. It may,
// however, support a bounded protective RAISE when fresh deterministic training
// evidence says the athlete is under-fueled or performance is fading. These are
// planning signals only; wearable burn is never added to the target here.
export function protectiveFuelEvidence(date = localDateISO()): string[] {
  const reasons: string[] = [];
  try {
    const program = getProgramState(date) as any;
    if (program?.hybrid?.fuel?.risk === "high") reasons.push("high hybrid fuel-risk from recent endurance load");
  } catch {
    /* no deterministic program read */
  }
  try {
    const since = addDaysISO(date, -13) ?? date;
    const sessions = (getRecentSessions(12) as any[]).filter(
      (session) => String(session?.date ?? "") >= since && String(session?.date ?? "") <= date
    );
    const lowPerformance = sessions.filter(
      (session) => session?.performance != null && Number(session.performance) <= 2
    ).length;
    const fatigueNotes = sessions.filter((session) => sessionNoteSuggestsFatigue(session?.notes));
    const rapidFade = fatigueNotes.some((session) => sessionNoteSuggestsRapidFade(session?.notes));
    if (lowPerformance >= 2) reasons.push("repeated low performance in recent session feedback");
    if (fatigueNotes.length >= 2 || rapidFade)
      reasons.push("fresh session notes describe under-fueling or performance fade");
  } catch {
    /* no recent session evidence */
  }
  return [...new Set(reasons)];
}
// ---- agent connect/visibility helpers (read-only; see src/agents.ts) ----
// The two protocol surfaces (api.ts / mcp.ts) read agent connect-state through
// coachOps so they stay thin adapters. These wrap the agents.ts probes and shape
// the designed { ok, ... } result — version/model visibility + the model catalog,
// neither of which makes a coaching/paid call.

// Draft a goal-aware weekly meal plan, then run a bounded self-critique verify
// pass against the lean-safe / longevity floors before persisting. ok:false on a
// non-JSON result mirrors the other agentic ops. The persisted plan is the
// VERIFIED draft (a fix is adopted only when it re-validates); `verified` carries
// the "checked against your floors" signal. Verify fails open (no agent / garbage
// ⇒ the original draft is persisted unverified — exactly today's behavior).
export async function draftMealPlan(
  agent: string | undefined,
  instruction?: string,
  hooks?: OpHooks,
  opts: { coordinated_update?: boolean } = {}
) {
  hooks?.onPhase?.("drafting your week of meals");
  const prompt = buildMealPlanPrompt(instruction);
  // Accept the useful weekly shape into the optional verifier pass, then make
  // actual meal totals authoritative at the deterministic server boundary below.
  const planSane = (m: any) => isMealPlanStructureResult(m);
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "meal_plan",
      signal: hooks?.signal,
      acceptParsed: planSane,
      // Structure only. Nutritional ADEQUACY stays a server-side judgement
      // (validateMealPlanDraftForPersistence) — a schema must never look like it
      // authorized a plan the safety gate would reject.
      schema: MEAL_PLAN_STRUCTURE_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "agent returned no usable meal plan",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
    };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  // Defensive only: the shared fallback already enforces this same predicate.
  // Never persist an off-contract object as a meal plan.
  if (!planSane(p)) {
    return {
      ok: false as const,
      error: "agent returned no usable meal plan",
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Self-critique: the server computes the lean-safe kcal / protein / fiber
  // breaches, then an agent turn repairs them and judges the dietary + timing fit.
  // Fail-open (verify down/garbage ⇒ the original draft is persisted, exactly
  // today's behavior); an unrepaired breach is still stopped by the persistence
  // gate below, which is the authoritative write boundary.
  hooks?.onPhase?.("checking it against your floors", { frac: { done: 1, total: 2 } });
  const { draft: verifiedParsed, verified } = await runVerify(
    agent,
    p,
    (d) => mealPlanFloorPrecheck(d, { dietary_instruction: instruction }),
    (d, violations) => buildPlanVerifyPrompt(d, violations, { dietary_instruction: instruction }),
    planSane,
    "meal_plan_verify",
    hooks,
    MEAL_PLAN_STRUCTURE_SCHEMA
  );
  const safety = validateMealPlanDraftForPersistence(verifiedParsed, instruction);
  if (!safety.ok) {
    return {
      ok: false as const,
      error: safety.error,
      agent: chosen,
      tried,
      agent_status: agentStatusFor({ ok: false, agent: chosen, tried }),
    };
  }
  // Defense in depth: createMealPlan repeats the same check for every non-agent
  // caller. No row exists yet, so a failure can never enter autonomy.
  const plan = createMealPlan(chosen, result.raw, safety.parsed, { dietary_instruction: instruction });
  let autonomy: any = null;
  try {
    // No requested tier: autonomy is SERVER policy, and `requested_tier` only ever
    // clamps toward the more restrictive answer. Asking for "announce" here meant a
    // routine refresh — same targets, same shape of week, rotated meals — could never
    // reach the quiet lane the policy now has for it, however bounded the diff was.
    autonomy = applyMealPlanWithAutonomy(Number(plan.id), {
      coordinated_update: opts.coordinated_update === true,
    });
  } catch {
    // The durable, safety-clamped plan is still useful in review mode. Autonomy
    // bookkeeping is fail-soft and never discards an otherwise valid week.
    autonomy = null;
  }
  return {
    ok: true as const,
    plan: getMealPlan(Number(plan.id)),
    autonomy,
    agent: chosen,
    tried,
    agent_status: "ok" as const,
    ...(verified ? { verified } : {}),
  };
}

// A goal date the lean-safe pace cannot reach is a DECISION, not a reading. The
// derivation computes it on every read (deriveCutTarget is read-only and runs behind
// several surfaces), so the ledger entry is made HERE, on the check-in cadence — the
// one pass that already re-reads the whole record and is entitled to change something.
// The policy, the heads-up and the undo all belong to applyGoalDateAdaptationWithAutonomy;
// this only decides that now is the moment to offer it.
//
// `from` is never taken on trust: the derivation read the profile's goal date moments
// ago, and the seam itself refuses an adaptation whose `from` no longer matches.
// Idempotent on FOUR fronts — the seam answers `changed:false` when the profile already
// holds `to`; a goal_change for the same date still waiting (announced, or parked for
// review) is left alone rather than re-announced every cadence; a projection that lands
// within a fortnight of the date already on file is not worth moving a goal for; and no
// second goal-date heads-up goes out within a fortnight of the last one, whatever it said.
//
// The last two exist because the derivation re-projects from TODAY on every read, so the
// arrival date drifts a little every week by construction. Without them, one applied
// adaptation is immediately followed by a fresh projection a few days later than the date
// it just wrote, and the athlete's goal identity gets renegotiated every single week,
// outward forever. The derivation in cut-target.ts stays pure; this is where the ratchet
// is refused.
const GOAL_DATE_MATERIAL_DAYS = 14;
const GOAL_DATE_COOLDOWN_DAYS = 14;

export function maybeAdaptGoalDateFromCut(cutAnchor: CutTargetDerivation | null): any {
  const adaptation = cutAnchor?.goal_date_adaptation ?? null;
  if (!adaptation?.to) return null;
  try {
    // Measured against the date actually ON THE PROFILE, not the derivation's own
    // `from`: if the athlete moved the date themselves, theirs is what a new arrival
    // has to beat.
    const onFile = String((getProfile() as any)?.goal_date ?? adaptation.from ?? "").slice(0, 10);
    const slip = onFile ? daysBetweenISO(String(adaptation.to), onFile) : null;
    if (slip != null && slip < GOAL_DATE_MATERIAL_DAYS) {
      return {
        ok: true,
        changed: false,
        immaterial: true,
        reasons: ["the arrival this pace reaches is close enough to the date already on file"],
      };
    }
    const decisions = listBrainDecisions({ kind: "goal_change", limit: 50 });
    const waiting = decisions.some(
      (decision: any) =>
        (decision?.status === "announced" || decision?.status === "review") &&
        String(decision?.action?.goal_date_adaptation?.to ?? "") === String(adaptation.to)
    );
    if (waiting) {
      return { ok: true, changed: false, deduped: true, reasons: ["that goal date is already waiting"] };
    }
    // ANY recent goal_change, applied ones included: what the cooldown rations is how
    // often the athlete is asked to think about their goal date at all, not how often
    // a particular date is proposed.
    const cooldownFrom = Date.now() - GOAL_DATE_COOLDOWN_DAYS * 86_400_000;
    const recent = decisions.some((decision: any) => {
      const at = Date.parse(String(decision?.created_at ?? ""));
      return Number.isFinite(at) && at >= cooldownFrom;
    });
    if (recent) {
      return {
        ok: true,
        changed: false,
        deduped: true,
        cooldown: true,
        reasons: ["the goal date was looked at recently, so this one waits"],
      };
    }
    return applyGoalDateAdaptationWithAutonomy(adaptation);
  } catch {
    // Ledger bookkeeping is fail-soft: a check-in still returns its reading.
    return null;
  }
}

// Quiet adaptive-nutrition check-in. Creates a nutrition_target proposal only on
// meaningful drift, then routes it through the server autonomy policy; change:false
// is the calm, common answer. ok:false is the
// designed failure signal. windowDays is passed verbatim to both the expenditure
// estimate (with a finite guard) and the prompt, mirroring the REST behavior.
export async function nutritionCheckin(
  agent: string | undefined,
  windowDays?: number,
  hooks?: OpHooks,
  opts: { initiated?: "user" | "auto" } = {}
) {
  hooks?.onPhase?.("reading your energy balance");
  const expenditure = estimateExpenditure(Number.isFinite(windowDays as number) ? (windowDays as number) : 21);
  // The athlete's veto is respected for a bounded window on AUTOMATIC paths only
  // (scheduler cadence, brain signal boundaries): one "no" to a target change must
  // not be re-asked at the next weigh-in. A manual check-in (Energy Balance button,
  // REST, MCP) still runs because the athlete explicitly asked. Deliberately scoped
  // to nutrition_target — a discarded meal-plan draft must NOT suppress target
  // rechecks. Placed before every other branch so it always wins.
  if (opts.initiated === "auto" && hasRecentDecisionVeto("nutrition_target", 5)) {
    return {
      ok: true as const,
      change: false as const,
      proposal: null,
      summary: "You recently passed on a similar nutrition change, so Cairn is holding the current target.",
      reason: "recent_veto" as const,
      expenditure,
    };
  }
  const outcomeReady = expenditure.confidence === "medium" || expenditure.confidence === "high";
  const protectiveEvidence = outcomeReady ? [] : protectiveFuelEvidence();
  if (!outcomeReady && !protectiveEvidence.length) {
    return {
      ok: true as const,
      change: false as const,
      proposal: null,
      summary: "The outcome trend is still settling, so Cairn is holding the current target.",
      reason: "insufficient_outcome_confidence" as const,
      expenditure,
    };
  }
  const prompt = buildNutritionCheckinPrompt(undefined, { windowDays });
  let run: FallbackResult;
  try {
    run = await runChosenStreaming(agent, prompt, {
      op: "nutrition_checkin",
      signal: hooks?.signal,
      onDelta: hooks?.onDelta,
      boundedReads: true,
      acceptParsed: isNutritionCheckinResult,
      schema: NUTRITION_CHECKIN_SCHEMA,
    });
  } catch (error) {
    const failure = agentFailure(error, hooks);
    return {
      ok: false as const,
      error: "agent returned no usable check-in",
      ...failure,
      agent_status: agentStatusFor({ ok: false, ...failure }),
      expenditure,
    };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  if (!p || typeof p !== "object") {
    return { ok: false as const, error: "agent returned no usable check-in", agent: chosen, tried, expenditure };
  }
  // The deterministic derivation off the athlete's own record. Shares the estimate
  // already read above, so this costs no second expenditure pass. Null whenever
  // there is no cut to derive for (at goal, gaining, holding) — in which case the
  // grounded ceiling simply does not apply.
  //
  // Read BEFORE the change:false branch on purpose: a date that the safe pace cannot
  // reach is exactly the case where the calorie target holds steady, so gating the
  // goal-date heads-up on a target change would silence it in the situation it exists for.
  let cutAnchor: CutTargetDerivation | null = null;
  try {
    cutAnchor = cutReaffirmation().reaffirmed ? deriveCutTarget(localDateISO(), { expenditure }) : null;
  } catch {
    cutAnchor = null;
  }
  const goalDate = maybeAdaptGoalDateFromCut(cutAnchor);
  // No meaningful drift → no proposal. The calm, common answer.
  if (!p.change || !p.nutrition || !Number.isFinite(Number(p.nutrition.target_kcal))) {
    return {
      ok: true as const,
      change: false,
      summary: typeof p.summary === "string" ? p.summary : "",
      agent: chosen,
      tried,
      expenditure,
      ...(goalDate ? { goal_date_adaptation: goalDate } : {}),
    };
  }
  const nutrition = personalizeNutritionCheckinTarget(p.nutrition, undefined, {
    cutAnchor,
    protective: protectiveEvidence.length > 0,
  });
  // The protective low-confidence exception is raise-only. A model cannot turn
  // wearable/load/fatigue evidence into a deficit cut, and the delta is already
  // measured from the server-owned active target by the boundary above.
  if (!outcomeReady) {
    const previous = Number(nutrition?.prev_target_kcal);
    const target = Number(nutrition?.target_kcal);
    // A raise-only exception is meaningless with no established target to raise
    // from — Number(null) is 0 (finite), so prev_target_kcal must be checked
    // explicitly rather than relying on Number.isFinite alone.
    if (
      nutrition?.prev_target_kcal == null ||
      !Number.isFinite(previous) ||
      !Number.isFinite(target) ||
      target <= previous
    ) {
      return {
        ok: true as const,
        change: false as const,
        proposal: null,
        summary: "The trend is still settling. Recent training supports protecting fuel, not lowering the target.",
        reason: "protective_raise_only" as const,
        protective_evidence: protectiveEvidence,
        agent: chosen,
        tried,
        expenditure,
        ...(goalDate ? { goal_date_adaptation: goalDate } : {}),
      };
    }
  }
  // Persist the target change, then route it through the shared autonomy policy.
  // Lead mode schedules it for the next un-lived food day with Undo; explicit
  // review posture keeps the same row as a reviewable draft.
  const proposal = createProposal(chosen, "nutrition: adaptive check-in", result.raw, {
    kind: "nutrition_target",
    summary: typeof p.summary === "string" ? p.summary : "",
    nutrition,
    notes: typeof p.notes === "string" ? p.notes : "",
    expenditure,
  });
  // Outcome learning: record the proposed target + implied direction so a later
  // pass can check whether the bodyweight trend actually followed. Best-effort.
  const targetKcal = Number(nutrition.target_kcal);
  const tdee = Number((expenditure as any)?.tdee);
  // Local day so the date matches reconcileSuggestions' local "today" cutoff
  // (date < today) — a UTC stamp could record tomorrow's date in an evening
  // western zone and never reconcile on time.
  recordSuggestion("nutrition_checkin", localDateISO(), {
    target_kcal: Number.isFinite(targetKcal) ? targetKcal : null,
    tdee: Number.isFinite(tdee) ? tdee : null,
    direction:
      Number.isFinite(targetKcal) && Number.isFinite(tdee)
        ? targetKcal < tdee
          ? "down"
          : targetKcal > tdee
            ? "up"
            : "hold"
        : null,
  });
  let autonomy: any = null;
  try {
    autonomy = applyProposalWithAutonomy(Number(proposal.id), { requested_tier: "quiet_apply" });
  } catch {
    autonomy = null;
  }
  return {
    ok: true as const,
    change: true,
    proposal: getProposal(Number(proposal.id)),
    autonomy,
    summary: typeof p.summary === "string" ? p.summary : "",
    agent: chosen,
    tried,
    expenditure,
    ...(cutAnchor ? { cut_target: cutAnchor } : {}),
    ...(goalDate ? { goal_date_adaptation: goalDate } : {}),
    ...(protectiveEvidence.length ? { protective_evidence: protectiveEvidence } : {}),
  };
}

// Agentically swap ONE meal in a drafted plan, honoring an optional free-text
// hint. The caller must have already resolved the plan (404 on unknown id lives
// in the adapter); this runs the agent + validation + persistence. ok:false at
// the protocol layer's 200 is the designed failure signal.
export async function swapMealAgentic(
  agent: string | undefined,
  args: { plan: any; id: number; day: string; mealIndex: number; hint?: string },
  hooks?: OpHooks
) {
  hooks?.onPhase?.("finding a swap");
  const { plan, id, day, mealIndex, hint } = args;
  const prompt = buildMealSwapPrompt({ plan, day, mealIndex, hint });
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "meal_swap",
      signal: hooks?.signal,
      acceptParsed: isMealSwapResult,
      schema: MEAL_SWAP_SCHEMA,
    });
  } catch (error) {
    return { ok: false as const, error: "agent returned no usable meal", ...agentFailure(error, hooks) };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  const saneMeal =
    p && typeof p === "object" && typeof p.name === "string" && p.name.trim() && Number.isFinite(Number(p.kcal));
  if (!saneMeal) return { ok: false as const, error: "agent returned no usable meal", agent: chosen, tried };
  const swapped = swapMealInPlan(id, day, mealIndex, p, { dietary_instruction: hint });
  if (!swapped) return { ok: false as const, error: "day or meal_index not found in plan", agent: chosen, tried };
  return { ok: true as const, plan: swapped.plan, meal: swapped.meal, agent: chosen, tried };
}

// Agentic recipe for ONE planned meal, cached on the meal inside parsed_json.
// The caller has already resolved the plan + checked for a cached recipe (the
// instant cached:true path lives in the adapter). ok:false at 200 is the
// designed failure signal.
export async function generateRecipe(
  agent: string | undefined,
  args: { plan: any; id: number; day: string; mealIndex: number },
  hooks?: OpHooks
) {
  hooks?.onPhase?.("writing the recipe");
  const { plan, id, day, mealIndex } = args;
  const livePlan = getMealPlan(id);
  const safety = validateMealPlanForPersistence(livePlan?.parsed);
  if (!safety.ok) {
    return { ok: false as const, error: safety.error, agent: null, tried: [] };
  }
  const prompt = buildRecipePrompt({ plan, day, mealIndex });
  let run: FallbackResult;
  try {
    run = await runChosen(agent, prompt, {
      op: "recipe",
      signal: hooks?.signal,
      acceptParsed: isRecipeResult,
      schema: RECIPE_SCHEMA,
    });
  } catch (error) {
    return { ok: false as const, error: "agent returned no usable recipe", ...agentFailure(error, hooks) };
  }
  const { agent: chosen, result, tried } = run;
  const p = result.parsed;
  let saved: any = null;
  try {
    saved = p && typeof p === "object" ? setMealRecipe(id, day, mealIndex, p) : null;
  } catch (error: any) {
    return { ok: false as const, error: error?.message ?? "meal plan is not safe to update", agent: chosen, tried };
  }
  if (!saved) return { ok: false as const, error: "agent returned no usable recipe", agent: chosen, tried };
  return { ok: true as const, recipe: saved.recipe, plan: saved.plan, agent: chosen, tried };
}
