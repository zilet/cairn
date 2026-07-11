import { z } from "zod";
import { draftCoachProposal, evolveProgram } from "../../coachOps.js";
import { localToday } from "../../dayread.js";
import {
  applyProposalWithAutonomy,
  buildProgressionWithAutonomy,
  buildRunPlanWithAutonomy,
  getCachedDayRead,
} from "../../domain/brain/index.js";
import { dexaTargeting } from "../../domain/health/index.js";
import {
  advanceBlockWeek,
  applyProposal,
  applySwapSmart,
  buildSwapProposal,
  createBlock,
  ensureActiveBlock,
  getActiveBlock,
  getEquipmentProfile,
  getPlan,
  getProgramState,
  listBlocks,
  listProposals,
  muscleGroupTrajectory,
  performanceStanding,
  planDayProgression,
  programAdjustments,
  programBalance,
  recentMuscleLoad,
  runZones,
  setEquipmentProfile,
  setProposalStatus,
  testWeekDue,
  trainingPlaybook,
  updateBlock,
  weeklyRunPlan,
} from "../../domain/training/index.js";
import { asText, type McpToolRegistrar } from "./shared.js";

export function registerProgramTools(server: McpToolRegistrar) {
  server.tool(
    "get_program_state",
    "Adaptive program state — the deterministic read of how the training program is evolving: per-lift est-1RM trend + plateau/stall detection, volume landmarks per muscle, mesocycle position (weeks since deload, ACWR), and endurance trends. Informational (plain words, no score); the basis for proposing plan evolutions.",
    { date: z.string().optional() },
    async ({ date }) => asText(getProgramState(date))
  );

  server.tool(
    "get_performance",
    "The TRAINING-INTELLIGENCE / performance read — where the user actually STANDS, benchmarked like a coach would: each benchmark lift's CAPACITY as a sex- and age-adjusted percentile/level (beginner→elite) against proven strength standards, VO2max-for-age, the strength IMBALANCES (press vs pull, lower vs upper) to address, the single highest-leverage LEVER, lifts worth RE-TESTING (a heavy low-rep test to re-measure true capacity), a VARIETY nudge (don't run the identical rotation forever), motivational momentum, and a holistic balance line. Percentile/level are recognized reference reads, never a 0-100 score. The athletic counterpart to get_health_standing.",
    { date: z.string().optional() },
    async ({ date }) => asText(performanceStanding(date))
  );

  server.tool(
    "draft_plan_update",
    "Run a coaching agent over recent logs and route the plan update through Cairn's autonomy policy. In Lead mode bounded reversible changes land now or at a natural boundary and structural changes announce first; review posture keeps a draft. Returns the proposal and autonomy outcome.",
    {
      agent: z
        .string()
        .optional()
        .describe("agent name from list_agents; omit or 'auto' to use the configured rotation"),
      instruction: z.string().optional().describe("optional extra guidance"),
    },
    async ({ agent, instruction }) => {
      const result = await draftCoachProposal(agent, instruction);
      return asText({
        proposal: result.proposal,
        autonomy: result.autonomy,
        ok: result.ok,
        agent: result.agent,
        tried: result.tried,
      });
    }
  );

  server.tool(
    "evolve_program",
    "Read the deterministic program-state (per-lift trend + plateau/stall) and draft a plan EVOLUTION — progress what's working, deload/rotate what's stalled, introduce novelty, periodize — then route it through the autonomy layer. Under lead_mode='lead' a bounded, reversible evolution quiet-applies at its natural boundary and a structural restructure announces first (with one-tap Undo); under 'review_everything' it stays a DRAFT to review then apply_proposal. Returns the proposal + the program-state snapshot + the autonomy outcome.",
    {
      agent: z
        .string()
        .optional()
        .describe("agent name from list_agents; omit or 'auto' to use the configured rotation"),
      instruction: z.string().optional().describe("optional extra guidance (e.g. 'focus on my bench plateau')"),
    },
    async ({ agent, instruction }) => {
      const result = await evolveProgram(agent, instruction);
      return asText({
        proposal: result.proposal,
        state: result.state,
        // The autonomy outcome (quiet-applied / announced / left as a reviewable draft under
        // the active lead_mode) — mirrors the REST /program/evolve body so MCP ⊆ REST holds.
        autonomy: result.autonomy,
        ok: result.ok,
        agent: result.agent,
        tried: result.tried,
      });
    }
  );

  server.tool(
    "get_active_block",
    "The active periodization block (goal / focus / phase / week N of M), or null. The mesocycle the coach periodizes toward.",
    {},
    async () => asText(getActiveBlock())
  );

  server.tool(
    "list_blocks",
    "List periodization blocks (newest first) with status (active/completed/abandoned).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listBlocks(limit ?? 20))
  );

  server.tool(
    "ensure_active_block",
    "Ensure ONE active periodization block exists — auto-creates a sensible default aligned to the user's goal (strength base, or an endurance-base/peak block sized to an approaching race) when none is running. Idempotent: returns the existing active block untouched if the user is mid-block. Keeps periodization live.",
    {},
    async () => asText(ensureActiveBlock())
  );

  server.tool(
    "create_block",
    "Start a periodization block (a mesocycle with a goal, focus, phase, and week count) so progression is structured rather than random.",
    {
      goal: z.string().optional(),
      focus: z.string().optional().describe("strength | hypertrophy | endurance-base | peak"),
      total_weeks: z.number().int().optional(),
      phase: z.string().optional(),
      week_index: z.number().int().optional(),
    },
    async (block) => asText(createBlock(block))
  );

  server.tool(
    "update_block",
    "Update a periodization block's fields (goal/focus/phase/week_index/total_weeks/status).",
    {
      id: z.number().int(),
      goal: z.string().optional(),
      focus: z.string().optional(),
      phase: z.string().optional(),
      week_index: z.number().int().optional(),
      total_weeks: z.number().int().optional(),
      status: z.string().optional(),
    },
    async ({ id, ...fields }) => asText(updateBlock(id, fields) ?? { error: "not found", id })
  );

  server.tool(
    "advance_block_week",
    "Advance a block to its next week — bumps week_index, transitions the phase per the deload schedule, and auto-completes past the last week. Omit id to advance the active block.",
    { id: z.number().int().optional() },
    async ({ id }) => asText(advanceBlockWeek(id) ?? { error: "no block", id: id ?? null })
  );

  server.tool(
    "get_equipment",
    "The user's persisted equipment/preference profile (free text) + the parsed equipment types. Variation/swap suggestions rank by what they can actually load.",
    {},
    async () => asText(getEquipmentProfile())
  );

  server.tool(
    "set_equipment",
    "Set the user's available equipment / training-preference free text (e.g. 'full gym', 'dumbbells + pull-up bar at home'). Variation suggestions rank by it. Pass empty to clear.",
    { equipment: z.string().nullable().optional() },
    async ({ equipment }) => asText(setEquipmentProfile(equipment ?? null))
  );

  server.tool(
    "get_program_balance",
    "Working-set volume per canonical muscle group over the last 2 weeks, banded against productive-range landmarks (low/productive/high) with a plain-language adherence-skew summary. Tells which groups are due and which are over — no numeric scores, no grades.",
    {},
    async () => asText(programBalance())
  );

  server.tool(
    "get_progression",
    "Per-lift next-session prescription for every STRENGTH item on a plan day: the auto-progression engine reads the latest logged top set + RIR + the lift's trend and proposes the NEXT session's target (overload/hold/deload/vary/introduce) with a one-line plain-words delta and a why. Pass day to specify a day number; omit to default to the plan day today's read points at.",
    { day: z.number().int().optional().describe("plan day number (1–N); omit to default to today's suggested day") },
    async ({ day }) => {
      let dayNumber = day;
      if (dayNumber == null) {
        const cached = getCachedDayRead(localToday());
        const focus = cached?.focus ? String(cached.focus).toLowerCase().trim() : null;
        const days = getPlan();
        const strengthDays = (days as any[]).filter(
          (d: any) => Array.isArray(d.items) && d.items.some((item: any) => item.kind !== "cardio" && item.exercise)
        );
        if (strengthDays.length) {
          const matched = focus
            ? strengthDays.find((d: any) => {
                const f = String(d.focus || d.name || "")
                  .toLowerCase()
                  .trim();
                return f && (f === focus || f.includes(focus) || focus.includes(f));
              })
            : null;
          dayNumber = (matched ?? strengthDays[0]).day_number;
        }
      }
      if (dayNumber == null) return asText([]);
      return asText(planDayProgression(dayNumber));
    }
  );

  server.tool(
    "get_program_adjustments",
    "The handful of concrete adaptations due right now — lifts to push/hold/deload, groups that are due, missing core/grip/mobility gaps — as a plain-language digest. Most-actionable first. Pull-never-push: the user reviews these; nothing auto-applies.",
    {},
    async () => asText(programAdjustments())
  );

  server.tool(
    "apply_progression",
    "Build a DRAFT plan proposal from the current day's per-lift prescriptions (planDayProgression), then route it through the autonomy layer (shared with REST so the two never drift). Under lead_mode='lead' a bounded target nudge quiet-applies at its natural boundary with a decision + one-tap Undo; under 'review_everything' it stays a plain reviewable draft. A stalled lift's 'vary' becomes a real swap change; an autoregulation-braked hold is dropped. Returns { ok:true, proposal, autonomy } or { ok:false, error } at 200 (the designed failure signal when there's nothing to propose).",
    { day: z.number().int().describe("the plan day number to build prescriptions for") },
    async ({ day }) => asText(buildProgressionWithAutonomy(day))
  );

  server.tool(
    "swap_exercise",
    "Draft a single-exercise SWAP — rotate `from` out for a same-pattern `to` IN PLACE on a plan day — as a DRAFT proposal via the propose→apply path. Never auto-applies (review then apply_proposal). Returns { ok:true, proposal } or { ok:false, error } at 200.",
    {
      day: z.number().int().describe("the plan day number"),
      from: z.string().describe("the exact current exercise to rotate out"),
      to: z.string().describe("the same-pattern movement to rotate in"),
    },
    async ({ day, from, to }) => asText(buildSwapProposal(day, from, to))
  );

  server.tool(
    "swap_exercise_now",
    "Swap `from` out for a same-pattern `to` IN PLACE on a plan day AND APPLY it immediately (no review gate) — the in-session 'rotate one in' intent, so the new movement is ready to log against right away and the plan adapts as the athlete goes. `day` is optional — when omitted the slot resolves through a tiered ladder (exact name → conservative key → movement family, so 'Barbell Bench Press' finds the plan's 'DB Bench Press' slot), and when `from` isn't on the plan at all, `to` is ADDED to the day already training that muscle group instead of erroring. Returns { ok:true, mode:'swapped'|'added', message } or { ok:false, error } at 200.",
    {
      day: z.number().int().optional().describe("the plan day number; omit to resolve it from `from`'s plan placement"),
      from: z.string().describe("the current exercise to rotate out (the athlete's logged spelling is fine)"),
      to: z.string().describe("the same-pattern movement to rotate in"),
    },
    // Mirror of REST /program/swap/apply (MCP ⊆ REST) — one shared smart apply.
    async ({ day, from, to }) => asText(applySwapSmart(from, to, day != null && Number.isFinite(day) ? day : null))
  );

  server.tool(
    "get_run_plan",
    "The RUNNING brain — this week's deterministic, periodized run mix (N easy Z2 + 1 long Z2 + 1 rotated quality session: tempo/threshold/VO2/hills), each with a bpm-bearing zone, distance/duration, and (for interval sessions) the interval structure. Conservative ~10%/wk build, down weeks, recovery-aware, race-week taper. The endurance counterpart to get_performance and the FLOOR the coach refines. {available:false} for a non-runner.",
    { date: z.string().optional() },
    async ({ date }) => asText(weeklyRunPlan(date))
  );

  server.tool(
    "get_run_zones",
    "The user's HR-zone bpm bands (Z1–Z5), grounded in real physiology — max-HR (explicit → age-estimated → Garmin-observed → Garmin's own zone boundaries) and resting HR (Karvonen %HRR when known). Plain words + concrete bpm, never a score. {available:false} with no age and no Garmin HR.",
    {},
    async () => asText(runZones())
  );

  server.tool(
    "apply_run_plan",
    "Build this week's deterministic run mix (weeklyRunPlan) and route it through Cairn's autonomy policy. Lead mode lands the bounded update at a natural boundary with Undo; review posture keeps a draft. setWeeklyRuns preserves strength work and interval structure. Returns { ok:true, proposal, autonomy } or { ok:false, error }.",
    { date: z.string().optional() },
    async ({ date }) => asText(buildRunPlanWithAutonomy(date))
  );

  server.tool(
    "get_muscle_load",
    "Acute per-muscle freshness over the last ~2 days — recent strength sets AND endurance sessions folded onto the regions they fatigue (a long ride loads the legs). heavy:true means a real dose (the muscle wants a day). Plain words, no scores.",
    { days: z.number().int().min(1).max(7).optional().describe("window in days (default 2)") },
    async ({ days }) => asText({ days: days ?? 2, groups: [...recentMuscleLoad(days ?? 2).values()] })
  );

  server.tool(
    "get_muscle_trajectory",
    "Per-canonical-muscle-group ADVANCING vs STALLING read (the user's own mental model) — folds each group's member-lift statuses + its volume band/trend into one plain verdict (advancing/stalling/building/maintaining), and for a stalling group names the lead stalled lift + a MENU of same-pattern variations to rotate in. Plain words, no scores. {available:false} when nothing's logged.",
    { date: z.string().optional() },
    async ({ date }) => asText(muscleGroupTrajectory(date))
  );

  server.tool(
    "get_test_week",
    "The cadenced strength TEST-WEEK read — whether a re-test is due (the active block's realization phase, or ~7 weeks since the last test week) and the benchmark lifts worth re-testing to re-anchor true capacity. Read-only (never stamps the cadence). due:false for a new user (never nags).",
    { date: z.string().optional() },
    async ({ date }) => asText(testWeekDue(date))
  );

  server.tool(
    "get_training_playbook",
    "The deterministic TRAINING PLAYBOOK — the plateau-type plays (strength plateau, endurance plateau, mono-stimulus, hybrid interference) and an adherence-fit restructure read the evolve-program loop can focus a proposal on. Each play carries a plain-language why + a short menu of adaptations, grounded in the program-state. Suggestion only: never mutates the plan, never a score; quiet ('no signal strong enough to change the plan') at steady state.",
    {
      date: z.string().optional(),
      window: z.number().int().positive().optional().describe("adherence lookback window in days (default 28, min 14)"),
    },
    async ({ date, window }) => asText(trainingPlaybook(date, window !== undefined ? { windowDays: window } : {}))
  );

  server.tool(
    "get_dexa_targeting",
    "DEXA-driven targeting — maps the body scan's regional read (lean asymmetry, low ALMI/FFMI, low BMD, visceral/central fat) to concrete TRAINING + one NUTRITION target, each with a plain 'path to your next scan'. T/Z-scores + ALMI are recognized reference reads (never a score); BMD/visceral stay informational (clinician-framed). {available:false} with no DEXA.",
    {},
    async () => asText(dexaTargeting())
  );

  server.tool(
    "list_proposals",
    "List recent plan-update proposals and their status (draft/applied/discarded).",
    { limit: z.number().int().optional() },
    async ({ limit }) => asText(listProposals(limit ?? 20))
  );

  server.tool(
    "apply_proposal",
    "Apply a draft proposal's target changes to the plan.",
    { id: z.number().int() },
    async ({ id }) => {
      try {
        return asText(applyProposal(id));
      } catch (error: any) {
        return asText({ error: error.message });
      }
    }
  );

  server.tool(
    "apply_proposal_with_autonomy",
    "Route a proposal through Cairn's server autonomy policy. It may quiet-apply, announce for a natural boundary, or hold for review; clinical and user-locked changes never auto-apply.",
    {
      id: z.number().int(),
      requested_tier: z.enum(["observe", "quiet_apply", "announce", "ask", "clinician"]).optional(),
      safety_response: z.boolean().optional(),
      user_locked: z.boolean().optional(),
      clamp_refused: z.boolean().optional(),
    },
    async ({ id, requested_tier, safety_response, user_locked, clamp_refused }) =>
      asText(applyProposalWithAutonomy(id, { requested_tier, safety_response, user_locked, clamp_refused }))
  );

  server.tool(
    "discard_proposal",
    "Discard a draft proposal without applying it.",
    { id: z.number().int() },
    async ({ id }) => asText(setProposalStatus(id, "discarded"))
  );
}
