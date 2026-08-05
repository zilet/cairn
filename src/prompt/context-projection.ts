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
  "location",
  "discipline",
  "training_intent",
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
//
// `run_zones` here is the RESOLVED zone view, not a second opinion: whenever the
// personal HR model can speak, its bands ARE these numbers (resolveRunZones, in
// src/repo/run-progression.ts). So the sites that carry both this and `hr_model`
// — day_read and session — are carrying one answer described two ways, never two
// answers to the same question.
const ENDURANCE = [
  "endurance_capacity",
  "endurance_goal",
  "run_compliance",
  "run_zones",
  "run_plan",
  "flexible_training_agenda",
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

// Everything the bundles above cover, for the one site that carries the lot (chat).
// `fuel_demand` is deliberately absent: it is a narrow periodization read wired to the
// three sites that plan or read a day's food (meal_plan, day_read, and the check-in's
// rendered block), and chat already sees the same training week through `plan`,
// `run_plan` and `flexible_training_agenda`.
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
  /**
   * How much of each session this site's DATA carries.
   *
   * "full" (the default, and every plan-shaping site) is the whole row with each set
   * projected to SET_FIELDS — a site that PRESCRIBES the next session has to see the
   * working sets it is progressing from.
   *
   * "summary" is for a site that reads the RHYTHM of recent training and nothing
   * finer: the date, the kind, what the athlete said about it, and a per-exercise
   * roll-up — with the raw set rows, the Garmin blob and the daily-composition blob
   * dropped (see summarizeSession).
   */
  session_detail?: "full" | "summary";
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
  // The one site that RESTRUCTURES the week rather than adjusting next week's targets,
  // so it is the only one handed `week_layout` — the deterministic read of whether the
  // heaviest lower day already collides with the long/quality run. The placement rule
  // has lived in the prose bullet alone (HOW TO EVOLVE), which gave the model something
  // to remember and nothing to check itself against; this gives it the actual week.
  // Deliberately NOT on the coach site: that prompt nudges loads inside a fixed shape.
  program_evolution: { ...PLAN_SITE, keys: [...PLAN_SITE.keys, "week_layout"] },

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
      // Which of the coming days carry the biggest work. The Brief speaks about
      // TODAY's fuel, and "today is the long-run day" is the one fact that changes
      // what a calm word about food should be — the day's shape, not a new target.
      "fuel_demand",
      // The personal HR model + the calibration ladder. The Brief is where a run
      // gets prescribed to a pulse ("easy today" has to mean a bpm this athlete
      // actually holds), and where a stale threshold or an unverified 1RM finds
      // its natural opening. Deliberately NOT at the plan-shaping sites yet: the
      // model steers today's prescription, not next quarter's split.
      "hr_model",
      "calibration",
      // How often each read is actually FOLLOWED. The one site that gets it: the Brief
      // is the read being measured, so this is the only prompt where the divergence
      // pattern is about the very decision it is being asked to make. Compacted hard
      // (see compactReadAdherence) because it ships every morning.
      "read_adherence",
    ],
    sessions: SESSIONS_RECENT,
    // The Brief READS the day; it does not prescribe the session. Every set-level
    // decision it could touch has already been made deterministically and arrives
    // pre-digested (training_signals, program_state, progression, signal_state), and
    // the builder renders its own session + rhythm lines off the FULL context — so
    // the raw set rows, the Garmin payload and the daily-composition blob on each
    // session were pure weight in the one prompt that ships every single morning.
    session_detail: "summary",
  },

  // On-demand session. Same plan-shaping needs as the coach minus the weekly framing:
  // DROPPED `garmin`, `signal_state` (not rendered here), day_read, recent_decisions,
  // insights, whole_person_trajectory.
  session: {
    keys: [
      ...PERSON,
      ...TRAINING_FULL,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_FULL,
      ...RECOVERY,
      "coaching_focus",
      // A suggested session prescribes effort, and effort here is a heart rate:
      // the derived bands are the only honest place to point a "keep it easy"
      // at. `calibration` rides along because a suggested session is exactly the
      // opening a due test folds into (a quality slot, a first heavy set).
      "hr_model",
      "calibration",
    ],
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
      // The week's demand map — which days carry the long run, the quality session,
      // the heavy lower work or a double. This is the one site that plans SEVEN days
      // of food at once, so it is the site where "time more carbs around training"
      // stops being generic advice and names the actual days.
      "fuel_demand",
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

// ---------- the SUMMARY session (session_detail: "summary") ----------
//
// A site that reads the rhythm of recent training needs to know WHEN they trained,
// what kind of day it was, what they said about it, and roughly what the work was.
// It does not need every set row, and it certainly does not need the raw Garmin
// payload or the daily-composition blob hanging off each session — on a deployed DB
// those two are the bulk of `recent_sessions` (a session with zero sets still costs
// several KB of them), and nothing in the day-read prompt names or renders either.
//
// Session-level fields kept verbatim. `finished_at` stays because "logged but never
// finished" is a real distinction; the internal row ids, `created_at` (the session's
// own `date` covers it) and `plan_day_id` go.
const SUMMARY_SESSION_FIELDS = [
  "date",
  "kind",
  "title",
  "day_name",
  "duration_min",
  "finished_at",
  "notes",
  "soreness",
  "performance",
  "joint_pain",
  "skips",
] as const;

interface ExerciseRollup {
  exercise: unknown;
  mode?: unknown;
  sets: number;
  // The CROSS-SET total, named as one. It sat next to the per-set `top_reps` under the
  // bare name `reps`, which is also the per-set field name everywhere else in the
  // payload — so a rollup of five sets of eight read as a set of forty.
  total_reps?: number;
  top_weight?: unknown;
  top_reps?: unknown;
  top_rir?: unknown;
  top_duration_sec?: unknown;
}

// One row per exercise: how much of it there was, and the single best set.
//
// "Best" is the highest EFFECTIVE load, on the scale the weight encoding already
// defines (CLAUDE.md): a positive number is load, `null` is bodyweight, and a negative
// number is assistance — so -30 is thirty pounds of the athlete's own weight taken
// away, which is easier than bodyweight, and -10 is harder than -30. Bodyweight
// therefore sits at zero on that scale rather than below every number that exists.
// Ranking any set carrying a number above every bodyweight set got this backwards in
// exactly one place, but the place that matters: a machine-assisted pull-up outranked
// a true one and shipped as the day's best set. Ties fall through to reps, which is
// what separates two bodyweight sets. Timed movements rank on `duration_sec` and carry
// no load at all.
function summarizeSets(sets: readonly unknown[]): ExerciseRollup[] {
  const byExercise = new Map<string, ExerciseRollup>();
  for (const raw of sets) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const set = raw as Record<string, unknown>;
    const key = String(set.exercise ?? "");
    let row = byExercise.get(key);
    if (!row) {
      row = { exercise: set.exercise, sets: 0 };
      if (set.mode != null) row.mode = set.mode;
      byExercise.set(key, row);
    }
    row.sets += 1;
    const reps = Number(set.reps);
    if (Number.isFinite(reps)) row.total_reps = (row.total_reps ?? 0) + reps;

    if (set.mode === "timed") {
      const seconds = Number(set.duration_sec);
      const best = Number(row.top_duration_sec);
      if (Number.isFinite(seconds) && (!Number.isFinite(best) || seconds > best)) row.top_duration_sec = seconds;
      continue;
    }
    const weight = Number(set.weight);
    const bestWeight = Number(row.top_weight);
    const carriesLoad = set.weight != null && Number.isFinite(weight);
    const hasTop = "top_weight" in row;
    // Bodyweight is zero on the encoding's own scale: above every assisted set,
    // below every loaded one.
    const effort = carriesLoad ? weight : 0;
    const bestEffort = row.top_weight == null ? 0 : bestWeight;
    // The heavier effective load wins; equal load falls through to reps, which is
    // what separates two bodyweight sets (and two sets at the same weight).
    let wins: boolean;
    if (!hasTop) wins = true;
    else if (effort !== bestEffort) wins = effort > bestEffort;
    else wins = Number(set.reps) > Number(row.top_reps);
    if (!wins) continue;
    row.top_weight = carriesLoad ? weight : null;
    row.top_reps = set.reps ?? null;
    row.top_rir = set.rir ?? null;
  }
  return [...byExercise.values()];
}

function summarizeSession(session: unknown): unknown {
  if (!session || typeof session !== "object" || Array.isArray(session)) return session;
  const row = session as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of SUMMARY_SESSION_FIELDS) if (Object.hasOwn(row, field)) out[field] = row[field];
  if (Array.isArray(row.sets)) out.sets = summarizeSets(row.sets);
  return out;
}

// Cap the window and right-size each session for the site. At "full" detail the
// session-level fields (date, title, soreness/performance/joint_pain, notes, skips,
// garmin) are all read by prompts and stay untouched, and only each SET is projected.
function compactSessions(sessions: unknown, limit: number, detail: "full" | "summary" = "full"): unknown {
  if (!Array.isArray(sessions)) return sessions;
  const window = sessions.slice(0, limit);
  if (detail === "summary") return window.map(summarizeSession);
  return window.map((session) => {
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
//
// Two more things are dropped here, both for the same reason — they are the
// deterministic layer's WORKING, not the model's evidence:
//
//   • `verified.{hrv_ms,resting_hr}.readings` — up to 90 raw {date, value} pairs per
//     metric (~6 KB), the series the excursion test walks. Handing it over is worse
//     than expensive: the classification above it (`latest_trust`, and the date a
//     claim is entitled to) exists precisely so a provisional or aged-out reading
//     cannot become a finding, and a raw series invites the model to re-derive the
//     claims the deterministic layer deliberately nulled. The classification fields
//     stay — they are the answer; the readings were the arithmetic.
//   • `quality.min_hr` — corroboration plumbing. `min_hr` rides in the field list
//     only so a resting-HR row can be checked against its own floor (READING_TRUST,
//     src/repo/coach.ts) and is never surfaced on its own; its quality entry is a
//     coverage map for a signal no prompt may speak about.
function compactRecovery(view: unknown): unknown {
  if (!view || typeof view !== "object" || Array.isArray(view)) return view;
  const row = view as Record<string, unknown>;
  if (!Object.hasOwn(row, "quality")) return row;
  const { coverage: _coverage, provenance: _provenance, ...rest } = row;
  if (rest.quality && typeof rest.quality === "object" && !Array.isArray(rest.quality)) {
    const { min_hr: _minHr, ...qualityRest } = rest.quality as Record<string, unknown>;
    rest.quality = qualityRest;
  }
  if (rest.verified && typeof rest.verified === "object" && !Array.isArray(rest.verified)) {
    rest.verified = Object.fromEntries(
      Object.entries(rest.verified as Record<string, unknown>).map(([metric, trust]) => {
        if (!trust || typeof trust !== "object" || Array.isArray(trust)) return [metric, trust];
        const { readings: _readings, ...classification } = trust as Record<string, unknown>;
        return [metric, classification];
      })
    );
  }
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

// The read-adherence model, cut to what a prompt can act on. The full model carries a
// 42-day window and up to fourteen recent days; the Brief needs the standing counts
// (which read kind gets followed, and the plain-words test behind each count — the
// `measures` string must survive, or a followed `train` day reads as a hard one) plus
// enough recent days to see whether a divergence run is CURRENT. Seven is a week: long
// enough to show a pattern, short enough that this stays a few hundred bytes on a
// payload that ships every morning. The window bookkeeping (`window_days`,
// `days_observed`, `as_of`) is operator diagnostics and is dropped.
const RECENT_ADHERENCE_DAYS = 7;

function compactReadAdherence(model: unknown): unknown {
  if (!model || typeof model !== "object" || Array.isArray(model)) return model;
  const row = model as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(row.by_read)) out.by_read = row.by_read;
  if (Array.isArray(row.recent)) out.recent = row.recent.slice(-RECENT_ADHERENCE_DAYS);
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
  // Annotated: the `as const satisfies` above keeps each site's literal type, and a
  // union member that simply omits the optional `session_detail` has no such property
  // to read. The interface is the contract every member satisfies.
  const spec: PromptSiteSpec = PROMPT_CONTEXT_SITES[site];
  const source = (ctx ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of spec.keys) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    out[key] =
      key === "recent_sessions"
        ? compactSessions(value, spec.sessions, spec.session_detail ?? "full")
        : key === "recovery" || key === "garmin"
          ? compactRecovery(value)
          : key === "coaching_focus"
            ? compactCoachingFocus(value)
            : key === "read_adherence"
              ? compactReadAdherence(value)
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
