// ---------- the prompt-boundary context projection ----------
// Every plan-shaping prompt ends with a `DATA:` block, and for a long time that
// block was `JSON.stringify(getCoachContext())` — the WHOLE ~63-key snapshot,
// verbatim, at every site. On a demo seed that is ~196 KB per call (the bounded
// coach-read TOOLS deliberately cap at 64-98 KB for an entire query loop), and a
// real deployed DB is larger still. Most of it is dead weight at any given site:
// a meal/health prompt never reads the run-zone table; a composition prompt works
// strictly inside a decided envelope and never reads the recovery blob.
//
// This module is the ONE seam that fixes it: a declarative per-site key allowlist
// applied by a single shared helper. `getCoachContext()` itself is untouched — every
// non-prompt consumer (MCP tools, routes, agentJobs, the read-tool loop) keeps the
// full snapshot; the trim happens only where the snapshot is SERIALIZED INTO A PROMPT.
// The builders also keep reading the full ctx for their own prose blocks (the
// render* helpers in ./shared.ts), so no rendered guardrail changes.
//
// HOW A KEY EARNS ITS PLACE AT A SITE (the rule every list below follows):
//   1. the prompt's own text names the key or names its domain as ground truth, OR
//   2. a render* helper invoked at that site reads it, OR
//   3. the builder's own code reads it off the DATA the agent sees.
// Anything else is dropped. When in doubt, KEEP — a wrongly-dropped key silently
// degrades coaching, which is far worse than a large prompt.
//
// ADDING A PROMPT? Add a site here with the bundles it needs, point its `DATA:`
// block at `promptData(ctx, "<site>")`, and extend test/promptContextProjection.test.js.
// Never go back to a raw `JSON.stringify(ctx)` — and never trim by slicing a
// serialized string, which would hand the agent malformed JSON.
import type { CoachContextEnvelope, PartialCoachContext } from "../brain/coach-context-contract.js";

export type PromptContextKey = keyof CoachContextEnvelope;

// ---------- key bundles ----------
// Cohesive groups a site composes from, so a prompt author picks domains rather
// than curating 60 key names. They mirror the per-domain slices getCoachContext()
// is assembled from (person / nutrition / training / health / brain).

// WHO they are, WHEN it is, and the life they're training inside. Cheap in bytes,
// load-bearing in every prompt's guardrails (CONTEXT_GUARDRAILS reads context_events
// + family + profile.about_me; renderNow reads now; disciplineOf reads discipline).
// Carried at every site.
const PERSON = [
  "now",
  "profile",
  "discipline",
  "goal",
  "goal_mode",
  "memory",
  "learnings",
  "context_events",
  "context_today",
  "family",
  "checkins",
  "reaction_model",
  "felt_signals",
  "learned_models",
  "what_works_for_you",
] as const;

// What they actually LOGGED plus what's planned — the floor of any training read.
const TRAINING_LOG = ["plan", "recent_sessions", "recent_activities", "training_signals", "progression"] as const;
// + the deterministic program read (per-lift trend/stalls, mesocycle position).
const TRAINING_CORE = [...TRAINING_LOG, "program_block", "program_state"] as const;
// + capacity, balance, adaptations due and the long arc — the full plan-shaping set.
const TRAINING_FULL = [
  ...TRAINING_CORE,
  "program_balance",
  "program_adjustments",
  "recent_load",
  "strength_journey",
  "groups_trajectory",
  "test_week",
  "performance",
  "trajectory",
] as const;

// The endurance counterpart. Small (and empty for a pure strength user), so it
// rides along wherever runs could plausibly shape the answer.
const ENDURANCE = [
  "endurance_goal",
  "run_compliance",
  "run_zones",
  "run_plan",
  "run_variety",
  "endurance_tests",
] as const;

// Fuel: today's real intake, the planned food, and the deterministic nutrition reads.
const FUEL = ["day_intake", "meal_plan", "fueling", "underfueling", "cut_quality", "journey"] as const;

// The CONDENSED health reads — what the connected brain concluded, plus body
// composition. No raw records.
const HEALTH_CORE = [
  "directives",
  "health_focus",
  "body_composition",
  "body_metrics",
  "dexa_targeting",
  "supplements",
] as const;
// + the raw records themselves. Required wherever CONTEXT_GUARDRAILS ships (it names
// "health", "health_review" and "imaging" by field name) or the prompt reads labs.
const HEALTH_FULL = [
  ...HEALTH_CORE,
  "health",
  "imaging",
  "health_review",
  "health_synthesis",
  "symptom_links",
  "directive_feedback",
] as const;

// The unified recovery view. NOTE: `garmin` is deliberately NOT here — getRecoverySummary
// already merges the Garmin summary into `recovery` (the two blobs largely duplicate each
// other, ~13 KB), so `garmin` is added back only at the sites whose text names Garmin.
const RECOVERY = ["recovery"] as const;

// The singles no bundle owns: the brain's arbitration reads, the ledger, and the
// stored Brief. Spelled out here so chat's "carry everything" list stays a
// compile-time decision rather than a silent omission when a key is added.
const BRAIN = [
  "coaching_focus",
  "signal_state",
  "recent_decisions",
  "whole_person_trajectory",
  "insights",
  "day_read",
  "next_step",
] as const;

const ALL_KEYS = [
  ...PERSON,
  ...TRAINING_FULL,
  ...ENDURANCE,
  ...FUEL,
  ...HEALTH_FULL,
  ...RECOVERY,
  ...BRAIN,
  "garmin",
] as const;

// ---------- per-site specs ----------

export interface PromptSiteSpec {
  /** Context keys serialized into this site's DATA block. */
  keys: readonly PromptContextKey[];
  /** How many recent sessions this site's DATA carries (see compactSessions). */
  sessions: number;
}

// `recent_sessions` is 30% of the whole snapshot (58 KB / 20 items on the demo seed).
// Sites that reason over logged history carry the full window; sites that only need
// the recent rhythm carry ~3 weeks; the composition prompt works inside a decided
// envelope and needs only the last couple of weeks' working loads.
const SESSIONS_FULL = 20;
const SESSIONS_RECENT = 10;
const SESSIONS_MINIMAL = 6;

// The training-plan prompts (coach + program evolution) share one render chain and
// one data need. KEPT: everything plan-shaping. `garmin` is kept because the text
// rules on it explicitly ("Treat Garmin as a context source, not the plan authority").
// DROPPED: day_read (today's Brief is not next week's plan), recent_decisions,
// insights, whole_person_trajectory, next_step — none is rendered or named here.
const PLAN_SITE: PromptSiteSpec = {
  keys: [
    ...PERSON,
    ...TRAINING_FULL,
    ...ENDURANCE,
    ...FUEL,
    ...HEALTH_FULL,
    ...RECOVERY,
    "coaching_focus",
    "signal_state",
    "garmin",
  ],
  sessions: SESSIONS_FULL,
};

export const PROMPT_CONTEXT_SITES = {
  coach: PLAN_SITE,
  program_evolution: PLAN_SITE,

  // The Brief. Renders the conductor, signal state, the whole training + endurance
  // + connected-brain chain, body comp, felt/learned signals and today's fuel.
  // DROPPED: `garmin` (recovery already carries it), `day_read` (the builder computes
  // a FRESH deterministic baseline and renders the last few days' reads explicitly —
  // handing it today's stored read invites parroting), recent_decisions, insights,
  // whole_person_trajectory. Sessions: the builder renders its own rhythm line over
  // the full history, so DATA carries the recent window. NOTE the same floor prose used
  // to arrive anyway through `coaching_focus.lead.why` — see compactCoachingFocus below.
  day_read: {
    keys: [
      ...PERSON,
      ...TRAINING_FULL,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_FULL,
      ...RECOVERY,
      "coaching_focus",
      "signal_state",
      "next_step",
    ],
    sessions: SESSIONS_RECENT,
  },

  // On-demand session. Same plan-shaping needs as the coach minus the weekly framing:
  // DROPPED `garmin`, `signal_state` (not rendered here), day_read, recent_decisions,
  // insights, whole_person_trajectory.
  session: {
    keys: [...PERSON, ...TRAINING_FULL, ...ENDURANCE, ...FUEL, ...HEALTH_FULL, ...RECOVERY, "coaching_focus"],
    sessions: SESSIONS_RECENT,
  },

  // Bounded composition inside a decided envelope: the server has ALREADY chosen the
  // kind, the muscle allow/exclude lists, the caps and the candidate movements with
  // their progression actions. The only prose blocks are CONTEXT_GUARDRAILS,
  // ELITE_STRENGTH_GUARDRAILS, COACHING_STANCE and renderNow — so this site keeps the
  // guardrail keys plus what it needs to carry working loads over, and DROPS the whole
  // deterministic read layer (recovery, program_state, performance, signal_state,
  // coaching_focus, run plan, journey, day_read, …) that the envelope already encodes.
  daily_composition: {
    keys: [...PERSON, ...TRAINING_LOG, "directives", "health", "health_review", "imaging", "supplements"],
    sessions: SESSIONS_MINIMAL,
  },

  // The weekly meal plan. Plan-shaping and constitution-bound, so it keeps everything
  // its guardrails read: the longevity block + hard-diet scan (profile allergies /
  // dietary_restrictions), the household read (family), the nutrition strategy block
  // (recent_activities, context_events, goal, recovery, performance, program_state's
  // hybrid fuel, fueling), the connected brain's NUTRITION directives + prioritized
  // health focus, the training split (plan) and endurance fueling. `coaching_focus`
  // rides along beyond the strict rule — it is the one-focus spine the meals should
  // serve (buildMealPlanPrompt renders it via renderCoachingFocus(ctx, {brief:true}),
  // e.g. a caveat easing around an injury, or a fueling emphasis). DROPPED: garmin,
  // day_read, recent_decisions, insights, whole_person_trajectory, and the
  // strength-programming read layer meals never touch (balance/adjustments/
  // recent_load/strength_journey/groups_trajectory/test_week).
  meal_plan: {
    keys: [
      ...PERSON,
      ...TRAINING_CORE,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_FULL,
      ...RECOVERY,
      "performance",
      "trajectory",
      "signal_state",
      "coaching_focus",
    ],
    sessions: SESSIONS_RECENT,
  },

  // The session SAFETY CHECKER (a bounded second pass over a drafted session). It
  // enforces exactly three things: no loaded movement through an injured area, weight
  // encoding integrity, and the requested time/equipment budget — so it keeps every
  // source a contraindication can come from (context_events, memory, the full health
  // set incl. imaging and directives, the plan's constraint_notes) plus the logged
  // history and program state that make "conservative loading" checkable. DROPPED:
  // recovery/garmin (nothing in its enforcement list reads them), fuel, and the brain
  // reads — it is told NOT to re-judge programming, only to catch violations.
  session_verify: {
    keys: [...PERSON, ...TRAINING_CORE, ...ENDURANCE, ...HEALTH_FULL],
    sessions: SESSIONS_RECENT,
  },

  // The quiet cross-domain insight. Its text names its own ground truth: "recovery,
  // markers/directives, training, nutrition, life/family context". Keeps the long-arc
  // reads (whole_person_trajectory) and prior insights for dedup. DROPPED: garmin,
  // signal_state, coaching_focus, day_read, recent_decisions — a durable connection is
  // not made out of today's arbitration.
  insight: {
    keys: [
      ...PERSON,
      ...TRAINING_FULL,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_FULL,
      ...RECOVERY,
      "insights",
      "whole_person_trajectory",
    ],
    sessions: SESSIONS_FULL,
  },

  // The standing weekly read: "grounded in their ACTUAL recent data only (training,
  // recovery, nutrition, life context)" + DATA.recent_decisions for the one calm
  // accountability verdict. Health arrives as the CONDENSED reads (a directive can
  // legitimately shape "the one change"); the raw records/imaging/review are dropped
  // along with garmin, signal_state, coaching_focus and day_read.
  weekly_read: {
    keys: [
      ...PERSON,
      ...TRAINING_FULL,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_CORE,
      ...RECOVERY,
      "recent_decisions",
      "whole_person_trajectory",
      "insights",
      "next_step",
    ],
    sessions: SESSIONS_RECENT,
  },

  // Chat is the free-form surface: the user can ask about ANY part of their picture,
  // so nothing is dropped here on purpose. It still benefits from the shared
  // per-set field projection below (~20 KB). The narrow capture lane has its own
  // purpose-built slice in prompt/chat.ts and never reaches this path.
  chat: { keys: ALL_KEYS, sessions: SESSIONS_FULL },

  // The lab review. Leads with its own PRIORITY MARKERS + MARKER HISTORY blocks, and
  // reasons across labs, body composition, training, nutrition, goals and life context.
  // DROPPED: the plan-shaping read layer it never renders (performance, balance,
  // adjustments, recent_load, strength_journey, groups_trajectory, test_week,
  // coaching_focus, signal_state), plus garmin, day_read, recent_decisions, insights.
  health_review: {
    keys: [
      ...PERSON,
      ...TRAINING_CORE,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_FULL,
      ...RECOVERY,
      "trajectory",
      "whole_person_trajectory",
    ],
    sessions: SESSIONS_RECENT,
  },

  // The whole-picture synthesis — same data need as the review (labs + body + training
  // load + recovery + nutrition + supplements + life as ONE story), same drops.
  health_synthesis: {
    keys: [
      ...PERSON,
      ...TRAINING_CORE,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_FULL,
      ...RECOVERY,
      "trajectory",
      "whole_person_trajectory",
    ],
    sessions: SESSIONS_RECENT,
  },

  // The week-ahead sketch: plan days, goals, recovery, recent training, life context,
  // and it must OBEY a training health directive. So: the training + endurance read
  // layer it renders, plus the condensed health reads. DROPPED: the raw health records
  // (no CONTEXT_GUARDRAILS here), fuel detail (it sketches training shape, not meals),
  // garmin, signal_state, day_read, recent_decisions, insights.
  week_ahead: {
    keys: [...PERSON, ...TRAINING_FULL, ...ENDURANCE, ...HEALTH_CORE, ...RECOVERY, "coaching_focus"],
    sessions: SESSIONS_RECENT,
  },
} as const satisfies Record<string, PromptSiteSpec>;

export type PromptSite = keyof typeof PROMPT_CONTEXT_SITES;

// ---------- within-key right-sizing ----------

// Per-SET fields a coaching prompt actually reads: what was lifted, how heavy, for
// how many/how long, and how hard it felt. Everything else on a logged set is
// bookkeeping — `id`/`session_id`/`exercise_id` are internal row ids no prompt or
// chat action ever references, and `created_at` is a full timestamp per set that the
// session's own `date` already covers. On the demo seed those four cost ~20 KB of the
// 58 KB `recent_sessions` blob, with nothing coaching-relevant in them.
//
// Fields are PROJECTED, never null-stripped: `weight: null` means bodyweight and
// `weight: -30` means 30 lb of assist, so a missing key and a null key are different
// facts (see the weight-encoding gotcha in CLAUDE.md).
const SET_FIELDS = ["exercise", "mode", "set_number", "weight", "reps", "rir", "duration_sec", "note"] as const;

function projectSet(set: unknown): unknown {
  if (!set || typeof set !== "object" || Array.isArray(set)) return set;
  const row = set as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of SET_FIELDS) if (Object.hasOwn(row, field)) out[field] = row[field];
  return out;
}

// Cap the window and project each set's fields. Session-level fields (date, title,
// soreness/performance/joint_pain, notes, skips, garmin) are all read by prompts and
// stay untouched.
function compactSessions(sessions: unknown, limit: number): unknown {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.slice(0, limit).map((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return session;
    const row = session as Record<string, unknown>;
    if (!Array.isArray(row.sets)) return row;
    return { ...row, sets: row.sets.map(projectSet) };
  });
}

// The unified recovery view (and the Garmin summary it's merged from) carries the
// SAME per-metric quality map up to four times: as `quality`, again nested inside
// `recovery.quality`, and again as `coverage` + `provenance` — which
// getRecoverySummary builds as literal `Object.fromEntries(Object.entries(quality)…)`
// projections (src/repo/coach.ts). The prompt keeps ONE copy: the top-level `quality`
// map, a strict superset of the other three. ~11 KB per site, zero information lost.
// (The full object still goes to every non-prompt consumer — this is prompt-boundary
// only.) Anything without a top-level `quality` map is returned untouched.
function compactRecovery(view: unknown): unknown {
  if (!view || typeof view !== "object" || Array.isArray(view)) return view;
  const row = view as Record<string, unknown>;
  if (!Object.hasOwn(row, "quality")) return row;
  const { coverage: _coverage, provenance: _provenance, ...rest } = row;
  const inner = rest.recovery;
  if (inner && typeof inner === "object" && !Array.isArray(inner) && Object.hasOwn(inner, "quality")) {
    const { quality: _nested, ...innerRest } = inner as Record<string, unknown>;
    return { ...rest, recovery: innerRest };
  }
  return rest;
}

// The conductor's day-posture lead carries the BRIEF'S OWN SENTENCE in `why` — the same
// voice, key and date the Brief renders (src/repo/coaching-focus.ts), deliberately, so
// one signal reads as one observation on the athlete's screen. That makes it the
// deterministic floor's prose, which is precisely what `day_read` is dropped from every
// site to keep out ("handing it today's stored read invites parroting") — the sentence
// simply leaked back in through `coaching_focus`. So a day-posture item ships its title,
// move and `based_on` (the machine-register evidence) and NOT the phrasing. Nothing
// coaching-relevant is lost: `based_on` and `signal_state.action.reasons` carry the same
// facts, and the sentence appears nowhere else in the payload. A NON-posture item keeps
// its `why` — there it can carry the conductor's work-around caveat verbatim, which is a
// safety instruction and must not be dropped. Anything without a day-posture item is
// returned untouched.
function compactCoachingFocus(focus: unknown): unknown {
  if (!focus || typeof focus !== "object" || Array.isArray(focus)) return focus;
  const row = focus as Record<string, unknown>;
  const stripPostureProse = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const entry = item as Record<string, unknown>;
    if (!entry.day_posture) return entry;
    const { why: _why, ...rest } = entry;
    return rest;
  };
  const out: Record<string, unknown> = { ...row, lead: stripPostureProse(row.lead) };
  if (Array.isArray(row.parallel)) out.parallel = row.parallel.map(stripPostureProse);
  return out;
}

// ---------- the helper every prompt uses ----------

/**
 * The site's slice of the coach context. Copies only the allowlisted keys that are
 * actually PRESENT (a partial context stays partial — absent keys are never
 * materialized as null), and right-sizes `recent_sessions` for the site. Never
 * mutates the input.
 */
export function projectCoachContext(ctx: PartialCoachContext, site: PromptSite): PartialCoachContext {
  const spec = PROMPT_CONTEXT_SITES[site];
  const source = (ctx ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of spec.keys) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    out[key] =
      key === "recent_sessions"
        ? compactSessions(value, spec.sessions)
        : key === "recovery" || key === "garmin"
          ? compactRecovery(value)
          : key === "coaching_focus"
            ? compactCoachingFocus(value)
            : value;
  }
  return out as PartialCoachContext;
}

/**
 * The serialized `DATA:` payload for a prompt site — the ONLY thing a prompt builder
 * should interpolate into its DATA block. Always emits well-formed JSON (the payload
 * is shrunk by projecting structure, never by truncating a string).
 */
export function promptData(ctx: PartialCoachContext, site: PromptSite): string {
  return JSON.stringify(projectCoachContext(ctx, site));
}
