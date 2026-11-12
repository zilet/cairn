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
import type { CoachReadToolName } from "../brain/read-tools.js";

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
  // Stated lasting conditions — person-level and tiny; every site that sees the
  // profile should see what the athlete said about how their body moves.
  "movement_considerations",
  "location",
  "discipline",
  "training_intent",
  // The athlete's own push / steady stance — tiny, and every prompt that sees the
  // priorities should see how hard they asked to be pushed and until when.
  "training_drive",
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
// + the deterministic program read (per-lift trend/stalls, mesocycle position), and the
// athlete's stated LIFTING weekdays — the calendar the plan's days are laid onto. That
// last one rides at exactly the sites its run-day sibling rides at (the ENDURANCE bundle
// below), because the two answer one question between them: which weekday carries what.
const TRAINING_CORE = [...TRAINING_LOG, "program_block", "program_state", "strength_schedule"] as const;
// + capacity, balance, adaptations due and the long arc — the full plan-shaping set.
// `week_training_load` is THE whole-week picture (every sport plus the lifting, key-run
// spacing, the cross-training day, the next 48 hours) and replaces the two-day
// `recent_load` list here: that list overlapped `acute_gates` and named one recency
// fact per group, so it stays in getCoachContext for routes and MCP but no longer rides
// into a prompt. `recent_cardio` (ENDURANCE) stays the per-run detail beside it.
const TRAINING_FULL = [
  ...TRAINING_CORE,
  "program_balance",
  "program_adjustments",
  "week_training_load",
  "acute_gates",
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
  "endurance_schedule",
  "run_compliance",
  "run_zones",
  "run_plan",
  // The race-build layer (estimate + trend, pace bands, the ladder, the leg map).
  // {available:false} for anyone without a dated race, so it costs a pure strength
  // athlete a few bytes and gives a racer the numbers every running prompt should
  // be shooting at.
  "race_build",
  "flexible_training_agenda",
  "run_variety",
  "endurance_tests",
  // The last week of runs read the way a coach reads one (src/repo/recent-cardio.ts):
  // display units, pace, heart rate off the watch row, stated effort, the personal
  // model's read. A few hundred bytes a run, empty rows for a strength-only athlete —
  // and the one place every running prompt can find TODAY's run with its numbers
  // without digging it out of the raw `recent_activities` storage rows.
  "recent_cardio",
] as const;

// Fuel: today's real intake, the planned food, and the deterministic nutrition reads.
const FUEL = [
  "day_intake",
  "meal_plan",
  "fueling",
  "underfueling",
  "cut_quality",
  "energy_deficiency",
  "journey",
] as const;

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
  "road_ahead",
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
  // The protein anchor + the observed intake band. Not in FUEL on purpose: it is the
  // read for SIZING food (chat's "what should I eat", the meal-idea site), and the
  // Brief — which carries FUEL under a byte ceiling — decides the day, not a plate.
  "intake_band",
] as const;

// ---------- chat's lean core ----------
// Chat used to inline the whole ~79-key snapshot on every message (~140-175 KB of DATA
// on the demo seed, `recent_sessions` alone ~40-50 KB) and still went looking for what it
// needed inside one single-line JSON. The lean core keeps what the coach ALWAYS needs —
// who the athlete is, today, this week's shape, and anything a chat action must name an
// id from — and leaves the rest to the closed coach-read catalog, which it now reads for
// the specific question (src/brain/read-transport.ts). `chat_context: "full"` in settings
// restores the full block and the old contract wording, untouched.
//
// KEPT, by reason:
//   who they are     — PERSON (profile + about_me, memory, learnings, context events,
//                      family, check-ins, felt/learned signals), goal (compacted: the
//                      targets the fuel guardrail names), journey (compacted), the
//                      endurance goal, supplements (DATA.supplements is named in the
//                      prompt), the energy-deficiency watch and symptom links (both
//                      safety reads, tiny), typical_training_hour.
//   today            — day_read (compacted: what the Brief said, not its signals blob),
//                      signal_state + coaching_focus, acute_gates, day_intake,
//                      recent_activities (activity ids), the last two sessions, active
//                      directives (compacted — they must still shape advice). The week's
//                      runs ride as the RECENT RUNS & CARDIO prose block above DATA
//                      (renderRecentCardio reads the full context), so `recent_cardio`
//                      is not repeated inside DATA.
//   this week        — dated_week, plan (compacted: every day's lifts and targets, the
//                      names a plan_update uses), strength/endurance schedules, run_plan
//                      (compacted kinds per day), the agenda (compacted intents + today's
//                      adjustment), week_training_load (the Brief's compaction).
//   action ids       — memory ids, day_intake entry ids, activity ids, context-event ids,
//                      recent_decisions cut to the ones still pending or undoable.
const CHAT_CORE_SESSIONS = 2;
const CHAT_CORE_KEYS = [
  ...PERSON, // carries goal + goal_mode, compacted below
  "journey",
  "endurance_goal",
  "endurance_schedule",
  "strength_schedule",
  "supplements",
  "energy_deficiency",
  // FUEL_CLAIM_RULE permits the protective "eating under the target" claim ONLY from
  // DATA.underfueling.state, so the read rides inline (compacted to its verdict).
  "underfueling",
  // The latest health review's focus and watchlist actions (compacted): CONTEXT_GUARDRAILS
  // asks food and training answers to fold them in. The review itself, imaging and the
  // records are read_health_summary.
  "health_review",
  "symptom_links",
  "typical_training_hour",
  "day_read",
  "signal_state",
  "coaching_focus",
  "acute_gates",
  "day_intake",
  "recent_activities",
  "recent_sessions",
  "directives",
  "dated_week",
  "plan",
  "run_plan",
  "flexible_training_agenda",
  "week_training_load",
  "recent_decisions",
] as const satisfies readonly PromptContextKey[];

/**
 * Every key the FULL chat site carries that the lean core does not, and the coach read
 * that returns it (or its detail). A contract test holds the map whole: a key added to
 * the chat site has to be either kept in the core or given a read here.
 */
export const CHAT_CORE_MOVED_KEYS: Readonly<Partial<Record<PromptContextKey, CoachReadToolName>>> = Object.freeze({
  // Printed whole above DATA as RECENT RUNS & CARDIO; older runs are read_training_window.
  recent_cardio: "read_training_window",
  training_signals: "read_strength_progress",
  progression: "read_strength_progress",
  program_block: "read_strength_progress",
  program_state: "read_strength_progress",
  program_balance: "read_strength_progress",
  program_adjustments: "read_strength_progress",
  strength_journey: "read_strength_progress",
  groups_trajectory: "read_strength_progress",
  test_week: "read_strength_progress",
  performance: "read_strength_progress",
  trajectory: "read_goal_progress",
  road_ahead: "read_goal_progress",
  whole_person_trajectory: "read_goal_progress",
  next_step: "read_goal_progress",
  insights: "read_goal_progress",
  endurance_capacity: "read_run_week",
  run_compliance: "read_run_week",
  run_zones: "read_run_week",
  race_build: "read_run_week",
  run_variety: "read_run_week",
  endurance_tests: "read_run_week",
  meal_plan: "read_nutrition_window",
  fueling: "read_nutrition_window",
  cut_quality: "read_nutrition_window",
  intake_band: "read_nutrition_window",
  health: "read_health_summary",
  imaging: "read_health_summary",
  health_synthesis: "read_health_summary",
  health_focus: "read_health_summary",
  directive_feedback: "read_health_summary",
  body_composition: "read_body_composition_history",
  body_metrics: "read_body_composition_history",
  dexa_targeting: "read_body_composition_history",
  recovery: "read_recovery_window",
  garmin: "read_recovery_window",
});

/**
 * Keys the core keeps only IN PART, and the read that has the rest. Asserted with the
 * map above: nothing the full block carried is out of reach.
 */
export const CHAT_CORE_PARTIAL_KEYS: Readonly<Partial<Record<PromptContextKey, CoachReadToolName>>> = Object.freeze({
  recent_sessions: "read_training_window", // and read_exercise_history for one lift
  recent_decisions: "read_decision_history",
  day_read: "read_decision_history", // the stored read's signals; signal_state is inline
  goal: "read_nutrition_window",
  journey: "read_goal_progress",
  plan: "read_current_plan_detail",
  run_plan: "read_run_week",
  flexible_training_agenda: "read_run_week",
  week_training_load: "read_run_week",
  directives: "read_health_summary",
  coaching_focus: "read_goal_progress",
  underfueling: "read_nutrition_window", // its channels and evidence
  health_review: "read_health_summary", // its headline and follow-ups
});

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
    // The advisory session constraints (short sleep downgrades injury-exposed work;
    // a sustained stressful stretch trims sets and holds intensity). Earned under
    // rule 1: renderTrainingConstraints ships at every site that carries this key,
    // and it names the key as the thing the constraint comes from.
    "training_constraints",
    // The weekly per-group set floor the draft is held to (volume-floor.ts). Earned
    // under rule 1: the prompt names DATA.weekly_set_targets as the check to run on
    // its own week, and the server's redraw precheck holds the draft to the same
    // numbers afterwards.
    "weekly_set_targets",
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
  //
  // …and `road_ahead`: an evolution is the place the next milestone per goal, in the
  // block's own priority order, becomes next week's plan.
  program_evolution: { ...PLAN_SITE, keys: [...PLAN_SITE.keys, "week_layout", "road_ahead"] },

  // The FIRST week, composed from nothing. Plan-shaping like its two siblings above,
  // but the thing it is shaping does not exist yet, so the read layer that exists to
  // describe a RUNNING program is mostly empty here and is not carried:
  //   DROPPED vs the plan site — the volume/capacity read a history produces
  //   (program_balance, program_adjustments, week_training_load, strength_journey,
  //   groups_trajectory, test_week, performance), the whole FUEL bundle (this composes
  //   training, not food), and `garmin` (no text here rules on it; run history arrives
  //   through recent_activities and the endurance bundle, which is what a blank-slate
  //   athlete with a watch actually has).
  //   NOT ADDED — `week_layout`, the one key program_evolution adds on top of that
  //   site. It reads whether an EXISTING week already collides; there is no week to
  //   collide yet, so the ring rules ship as prose here instead.
  //   KEPT — who they are and what they've said (PERSON carries memory + about_me,
  //   which is where stated training frequency lives), the log itself plus the
  //   program-state read for whatever history DOES exist, the full endurance bundle
  //   (a first week prescribes runs to a zone), the full health set that
  //   CONTEXT_GUARDRAILS and buildEliteGuardrails read by name, recovery, body comp,
  //   and the conductor's lead.
  week_compose: {
    keys: [
      ...PERSON,
      ...TRAINING_CORE,
      ...ENDURANCE,
      ...HEALTH_FULL,
      ...RECOVERY,
      "trajectory",
      "coaching_focus",
      "signal_state",
      "training_constraints",
      // The per-group weekly set window a first week should land inside — the prose
      // names it ("KEEP THE FIRST DOSE MODEST" is bounded below by it, not by zero).
      "weekly_set_targets",
    ],
    sessions: SESSIONS_RECENT,
  },

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
      // What tomorrow already holds. The Brief is the ONE site that gets it: this is a
      // read of TODAY made against the next day, and every other site either plans a
      // whole week (where one day's commitment is noise) or answers a question with
      // nothing to do with the calendar. `context_events` in PERSON carries the same
      // rows here already — this is the resolved question beside them, so the model and
      // the deterministic rule that re-times a discretionary rest see ONE answer rather
      // than each deciding for itself what counts as tomorrow being spoken for. Null on
      // an ordinary morning, so the payload is unchanged when nothing is on.
      "tomorrow_holds",
      // The road this day sits on (src/repo/today-path.ts, compacted): the race
      // estimate, the weight and the anchor lift with their trends, the next few
      // milestones and the week's one lever — so the Brief can credit what is done and
      // point forward once. The Brief is the ONE site: only it reads a single day
      // against the road. Added by buildDayReadPrompt itself, never by getCoachContext.
      "today_path",
      // The advisory session constraints. The Brief does not prescribe the session,
      // but it DOES say what shape today has — and a caveat about easing off the
      // exposed work has to match the constraint the session prompt will be handed,
      // or the two surfaces disagree about the same morning.
      "training_constraints",
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
      // THE site rule 4 is written for: this prompt prescribes the actual session,
      // so it is where "keep the session, downgrade the exposed elements" has to land.
      "training_constraints",
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
    keys: [
      ...PERSON,
      ...TRAINING_LOG,
      "directives",
      "health",
      "health_review",
      "imaging",
      "supplements",
      // The one read-layer key this site earns: the constraints are about session
      // COMPOSITION (which elements to downgrade, which sets to trim), which is
      // precisely and only what this prompt decides.
      "training_constraints",
      // The week the session sits inside: yesterday's ride, tomorrow's long run, which
      // regions the week's lifting already loaded. The envelope decides the muscles;
      // this is what lets the composition pick sensibly inside them (a lighter hinge the
      // day before a key run) instead of reading the session as if it had no week.
      "week_training_load",
    ],
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
  // week_training_load/strength_journey/groups_trajectory/test_week).
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
      // Protein anchor first, then the energy range the athlete's own complete days and
      // weigh-ins showed — the observed bound meals are sized within, never a target.
      "intake_band",
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

  // The meal-plan SAFETY CHECKER (a bounded second pass over a drafted week). Its
  // arithmetic — the lean-safe kcal floor, the protein target, fiber — is computed
  // by the server before the prompt exists (src/repo/verify-floors.ts), so the ONLY
  // thing left to it is the judgement no number can make: does a meal violate an
  // allergy, a dietary restriction, a hard diet or a stated preference, and does the
  // meal-slot timing contradict the schedule the athlete described. That judgement is
  // unmakeable without the declarations, so this site carries every source one can
  // come from: `profile` (allergies + dietary_restrictions), `family` (a shared meal's
  // hard exclusions), `memory` and `learnings` (food likes/dislikes in their own
  // words), `context_events` / `context_today` (travel, illness, a fast), and the
  // condensed health reads whose directives can touch food. DROPPED: the whole
  // training/endurance/fuel set and `recent_sessions` — it re-judges no programming
  // and re-derives no target; the week's numbers already arrived as findings.
  // `sessions: 0` because `recent_sessions` is not in the key set at all — this
  // site reads no logged training, so it carries no session window either.
  meal_plan_verify: {
    keys: [...PERSON, ...HEALTH_CORE],
    sessions: 0,
  },

  // The plan-draft VOLUME repair (a bounded second pass over a redraw / evolution whose
  // week the server found starving a priority group). The breach arrives already
  // computed (verify-floors.ts planDraftFloorPrecheck), so the repair needs only what
  // a sound fix reads: the athlete's intent and the per-group targets, the current
  // plan and what they actually log (to prescribe added sets they can do), the stated
  // lifting week (so a fix never adds a day), and every injury/constraint source (so
  // a fix never loads an injured area). DROPPED: fuel, recovery, endurance, the brain
  // reads — it re-judges no programming beyond the named groups.
  plan_verify: {
    keys: [
      ...PERSON,
      ...TRAINING_CORE,
      "program_balance",
      "weekly_set_targets",
      "week_layout",
      ...HEALTH_CORE,
    ],
    sessions: SESSIONS_MINIMAL,
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
      "recent_context_tags",
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
      // The forward half: the prompt asks for one step toward the nearest milestone.
      "road_ahead",
      "insights",
      "next_step",
    ],
    sessions: SESSIONS_RECENT,
  },

  // Chat is the free-form surface: the user can ask about ANY part of their picture,
  // so nothing is dropped here on purpose. It still benefits from the shared
  // per-set field projection below (~20 KB). The narrow capture lane has its own
  // purpose-built slice in prompt/chat.ts and never reaches this path.
  //
  // `typical_training_hour` is added on top of ALL_KEYS rather than folded into a
  // shared bundle: only chat's PROGRESSIVE UNDERSTANDING text names it (the thing
  // it must consult before asking when the athlete trains), so no other site earns
  // it under this file's own allowlist rule.
  //
  // `dated_week` likewise: which session lands on which DATE (today through next
  // Sunday). Without it the agent read the plan's day_numbers as weekdays and edited
  // the wrong day (2026-10-19). The chat builder computes it itself (the `today_path`
  // precedent), so getCoachContext never pays for it; compact keys, no prose.
  chat: { keys: [...ALL_KEYS, "typical_training_hour", "dated_week"], sessions: SESSIONS_FULL },

  // Chat's LEAN core (settings.chat_context = "lean", the default): what the coach always
  // knows, with everything else one coach read away (CHAT_CORE_MOVED_KEYS below names the
  // read for every key this drops). See CHAT_CORE_KEYS for what stays and why. The two
  // last sessions ride whole (today's sets, and the one before it to compare against);
  // older history is read_training_window / read_exercise_history.
  chat_core: { keys: CHAT_CORE_KEYS, sessions: CHAT_CORE_SESSIONS },

  // The lab review. Leads with its own PRIORITY MARKERS + MARKER HISTORY blocks, and
  // reasons across labs, body composition, training, nutrition, goals and life context.
  // DROPPED: the plan-shaping read layer it never renders (performance, balance,
  // adjustments, week_training_load, strength_journey, groups_trajectory, test_week,
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
    keys: [...PERSON, ...TRAINING_FULL, ...ENDURANCE, ...HEALTH_CORE, ...RECOVERY, "coaching_focus", "road_ahead"],
    sessions: SESSIONS_RECENT,
  },

  // The multidisciplinary case conference — the SPECIALISTS' and conductor's shared
  // snapshot (createImmutableBrainSnapshot bounds it to 50 keys, which the whole
  // ~75-key context silently overran, dropping signal_state, health_focus and the
  // directives). `road_ahead` leads so every specialist names its next step toward the
  // same milestones in the same priority order; the rest is the whole person in the
  // condensed form: who they are, the training and endurance reads, fuel, the condensed
  // health reads, recovery and the brain's own arbitration.
  case_conference: {
    keys: [
      "road_ahead",
      ...PERSON,
      ...TRAINING_CORE,
      "strength_journey",
      "trajectory",
      "endurance_goal",
      "endurance_schedule",
      "race_build",
      "run_plan",
      "day_intake",
      "fueling",
      "underfueling",
      "cut_quality",
      ...HEALTH_CORE,
      ...RECOVERY,
      "coaching_focus",
      "signal_state",
      "recent_decisions",
      "whole_person_trajectory",
    ],
    // Full set rows: the strength coach proposes loads off the working sets.
    sessions: SESSIONS_MINIMAL,
  },

  // The what-if (src/prompt/whatif.ts): ONE proposed change and its ripple across the
  // six stones — Strength, Endurance, Fuel, Recovery, Body, Heart — so it carries the
  // read layer behind each stone: the plan it may name edits against (TRAINING_CORE),
  // the run engine and race build (ENDURANCE), fuel, the condensed health reads (Heart),
  // recovery, and the brain's own arbitration (signal_state) plus the milestones a goal
  // question is measured against (road_ahead). DROPPED: garmin (recovery already merges
  // it), the raw health records, day_read, recent_decisions and insights — a
  // hypothetical is reasoned from the picture, not from what was already said about it.
  what_if: {
    keys: [
      ...PERSON,
      ...TRAINING_CORE,
      ...ENDURANCE,
      ...FUEL,
      ...HEALTH_CORE,
      ...RECOVERY,
      "coaching_focus",
      "signal_state",
      "road_ahead",
    ],
    sessions: SESSIONS_RECENT,
  },

  // The finished-goal look-back (src/prompt/goal-review.ts, "Behind you"). The goal's
  // own deterministic FACTS are the payload and lead the prompt; DATA is only who the
  // athlete is and what they are aiming at now, for tone and for "what carries
  // forward": the person (PERSON), the live goals the carry-forward speaks toward
  // (endurance goal and stated run days, the strength journey, the weight journey).
  // DROPPED: every training/fuel/health/recovery read — the review is about a goal
  // that is DONE, and today's state would only pull the story off its facts.
  goal_review: {
    keys: [...PERSON, "endurance_goal", "endurance_schedule", "strength_journey", "journey"],
    sessions: 0,
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
// what separates two bodyweight sets. Timed movements rank on `duration_sec`; a loaded
// carry/hold also carries its heaviest load as `top_weight`.
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
      const load = Number(set.weight);
      if (set.weight != null && Number.isFinite(load) && load !== 0 && (row.top_weight == null || load > Number(row.top_weight)))
        row.top_weight = load;
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

// The session's `garmin` blob is physiology the model reads (heart rate, zones, the
// watch's own summary) PLUS write-back bookkeeping it must never see: `export`
// (Garmin activity ids, the payload fingerprint, the shells we still owe a delete)
// and `reconciled_at`. Those are the plumbing's own record of what it sent, not
// evidence about the athlete's body — handing them over spends tokens on ids and
// invites a model to narrate our sync state as if it were training news.
const NON_EVIDENCE_GARMIN_KEYS = ["export", "reconciled_at"] as const;

function compactGarminSessionBlob(garmin: unknown): unknown {
  if (!garmin || typeof garmin !== "object" || Array.isArray(garmin)) return garmin;
  const row = garmin as Record<string, unknown>;
  if (!NON_EVIDENCE_GARMIN_KEYS.some((key) => Object.hasOwn(row, key))) return garmin;
  const out: Record<string, unknown> = { ...row };
  for (const key of NON_EVIDENCE_GARMIN_KEYS) delete out[key];
  return out;
}

// Cap the window and right-size each session for the site. At "full" detail the
// session-level fields (date, title, soreness/performance/joint_pain, notes, skips,
// garmin) are all read by prompts and stay untouched, and only each SET — and the
// Garmin blob's write-back bookkeeping — is projected.
function compactSessions(sessions: unknown, limit: number, detail: "full" | "summary" = "full"): unknown {
  if (!Array.isArray(sessions)) return sessions;
  const window = sessions.slice(0, limit);
  if (detail === "summary") return window.map(summarizeSession);
  return window.map((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return session;
    const row = session as Record<string, unknown>;
    const garmin = compactGarminSessionBlob(row.garmin);
    const trimmed = garmin === row.garmin ? row : { ...row, garmin };
    if (!Array.isArray(row.sets)) return trimmed;
    return { ...trimmed, sets: row.sets.map(projectSet) };
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
function neverRecorded(metric: unknown): boolean {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) return false;
  const row = metric as Record<string, unknown>;
  return row.freshness === "missing" && row.latest_value == null && !Number(row.sample_count);
}

function compactRecovery(view: unknown): unknown {
  if (!view || typeof view !== "object" || Array.isArray(view)) return view;
  const row = view as Record<string, unknown>;
  if (!Object.hasOwn(row, "quality")) return row;
  const { coverage: _coverage, provenance: _provenance, ...rest } = row;
  if (rest.quality && typeof rest.quality === "object" && !Array.isArray(rest.quality)) {
    const { min_hr: _minHr, ...qualityRest } = rest.quality as Record<string, unknown>;
    // A metric the athlete's devices have never reported in the window is a fixed-shape
    // "missing" stub — thirty of them on a typical setup, ~4 KB that says nothing a
    // missing key does not. Dropped here only; a STALE reading (it has a value) stays,
    // because how old a reading is is evidence (sensor-freshness).
    rest.quality = Object.fromEntries(Object.entries(qualityRest).filter(([, metric]) => !neverRecorded(metric)));
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
  // `day_state.line` is the same Brief sentence a posture item carried in `why`: the
  // posture, title and move ship; the phrasing does not.
  if (row.day_state && typeof row.day_state === "object" && !Array.isArray(row.day_state)) {
    const { line: _line, ...dayState } = row.day_state as Record<string, unknown>;
    out.day_state = dayState;
  }
  return out;
}

// The signal state, minus the posture ladder's own plumbing. Every dimension carries a
// `deciding` pair — the same status/confidence recomputed without the advisory brakes
// (src/repo/signal-state.ts) — because the arbitration index and the seconded-watch
// count must read past a one-lane informational finding. That is a fact about HOW the
// server decided, not evidence about the athlete, and shipping it would put a second,
// unexplained status beside the real one on all five dimensions: a model reading
// "watch" next to "unknown" for one dimension on one morning can only guess which of
// them it is meant to reason from. The prompt gets `status`/`confidence` — the pair
// every prompt has always read — and the evidence they were computed from.
export function compactSignalState(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const row = state as Record<string, unknown>;
  const dimensions = row.dimensions;
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) return row;
  return {
    ...row,
    dimensions: Object.fromEntries(
      Object.entries(dimensions as Record<string, unknown>).map(([key, dimension]) => {
        if (!dimension || typeof dimension !== "object" || Array.isArray(dimension)) return [key, dimension];
        const { deciding: _deciding, ...rest } = dimension as Record<string, unknown>;
        return [key, rest];
      })
    ),
  };
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

// The connected brain's directives, with the wearable recovery reads reframed. An HRV /
// resting-HR directive (role "recovery_context", src/repo/propagation.ts directivesForCoach)
// is a multi-night trend the day read ALREADY weighs night by night against the athlete's
// own baseline (signal_state). Shipped under `directive`, a Brief agent read "favor easy
// aerobic work" as an order and eased days the deterministic state only watched. So its
// text rides as `context_note` — the same words, keyed as what they are — and every lab
// directive passes through otherwise whole. Structure, never string surgery.
// Every row also sheds two storage fields at the prompt boundary: `directive_key` is a
// slug of the directive's own text (the identity the server dedupes and diffs on, never
// something a model reads or echoes back), and `created_at` is the row's write stamp
// (`trigger_date` is the reading's date, which is the one that means something). Over a
// typical connected brain that was ~2.5 KB riding every Brief.
function compactDirectives(directives: unknown): unknown {
  if (!Array.isArray(directives)) return directives;
  return directives.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const { directive_key: _key, created_at: _written, ...row } = item as Record<string, unknown>;
    if (row.role !== "recovery_context") return row;
    const { directive, ...rest } = row;
    return { ...rest, context_note: directive ?? null };
  });
}

// The race build's per-week athlete-register prose — the week's coaching sentence, its
// short form, and the "with your lifting" line — is written for the race page, not a
// model: the prompts read the engine's own quality_hint / strength_hint and the leg map
// instead, and the lifting line repeats nearly verbatim on every rung. Dropped at the
// prompt boundary only; the route, MCP tool and coach context keep all of it.
function compactRaceBuild(build: unknown): unknown {
  if (!build || typeof build !== "object" || Array.isArray(build)) return build;
  const row = build as Record<string, unknown>;
  if (!Array.isArray(row.weeks)) return row;
  return {
    ...row,
    weeks: row.weeks.map((week) => {
      if (!week || typeof week !== "object" || Array.isArray(week)) return week;
      const { focus: _focus, focus_short: _short, with_lifting: _lifting, ...rest } = week as Record<string, unknown>;
      return rest;
    }),
  };
}

// The whole-week load read, cut for the Brief (which ships every morning under a byte
// ceiling). The Brief reads the SHAPE of the week, not its rows — it already carries the
// per-run detail (`recent_cardio`) and the week's intentions (`flexible_training_agenda`)
// in their own keys, so here each day keeps its date, its load, and only what it actually
// held: runs (distance, effort, the intention closed), cross-training (what, family,
// time, load band) and the lifting split; a day with nothing logged is left out. Row ids,
// the grading basis, run minutes, null fields, empty lists, the window bounds (`as_of`
// and the dates carry them) and the week's `intents` (the agenda's own list) go, and every run title is dropped except a
// key run's ("Hill Sprints" is how the athlete names the session that closed quality).
// The back-to-back list keeps its dates (the days say what was on them). The week
// totals, key-run spacing, the cross-training day and `next_48h` pass whole. Structure,
// never string surgery.
const BRIEF_RUN_FIELDS = ["km", "effort_word"] as const;
const BRIEF_CROSS_FIELDS = ["label", "family", "minutes", "load"] as const;

function pickPresent(entry: unknown, fields: readonly string[]): Record<string, unknown> | unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const row = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (row[field] != null) out[field] = row[field];
  return out;
}

function compactWeekTrainingLoad(read: unknown): unknown {
  if (!read || typeof read !== "object" || Array.isArray(read)) return read;
  const row = read as Record<string, unknown>;
  if (!Array.isArray(row.days)) return row;
  const { window_start: _start, window_end: _end, ...rest } = row;
  const spacing = rest.spacing as Record<string, unknown> | undefined;
  const week = rest.week as Record<string, unknown> | undefined;
  return {
    ...rest,
    ...(week && typeof week === "object" && !Array.isArray(week)
      ? {
          week: (({ intents: _intents, cross_minutes_by_family: cross, ...totals }) =>
            cross && typeof cross === "object" && Object.keys(cross).length
              ? { ...totals, cross_minutes_by_family: cross }
              : totals)(week),
        }
      : {}),
    // A date with nothing logged is absent; the window is `as_of` and the six days before.
    days: row.days
      .filter((day) => {
        const d = day as Record<string, unknown> | null;
        return (
          !d ||
          typeof d !== "object" ||
          d.day_load !== "none" ||
          (Array.isArray(d.runs) && d.runs.length > 0) ||
          (Array.isArray(d.cross) && d.cross.length > 0) ||
          d.strength != null
        );
      })
      .map((day) => {
        if (!day || typeof day !== "object" || Array.isArray(day)) return day;
        const d = day as Record<string, unknown>;
        const out: Record<string, unknown> = { date: d.date, day_load: d.day_load };
        if (Array.isArray(d.runs) && d.runs.length)
          out.runs = d.runs.map((run) => {
            const r = run as Record<string, unknown> | null;
            const picked = {
              ...(pickPresent(r, BRIEF_RUN_FIELDS) as Record<string, unknown>),
              closed: r?.closed ?? null,
            };
            const key = r?.closed === "quality" || r?.closed === "long";
            return key && r?.title != null ? { ...picked, title: r.title } : picked;
          });
        if (Array.isArray(d.cross) && d.cross.length)
          out.cross = d.cross.map((c) => pickPresent(c, BRIEF_CROSS_FIELDS));
        if (d.strength) out.strength = d.strength;
        return out;
      }),
    ...(spacing && Array.isArray(spacing.hard_back_to_back)
      ? {
          spacing: {
            ...spacing,
            hard_back_to_back: spacing.hard_back_to_back.map((pair) => {
              if (!pair || typeof pair !== "object" || Array.isArray(pair)) return pair;
              const { what: _what, ...dates } = pair as Record<string, unknown>;
              return dates;
            }),
          },
        }
      : {}),
  };
}

// ---------- chat-core compactions (site "chat_core" only) ----------
// Structure, never string surgery, and each one keeps the fields the chat prompt names
// or an action needs; the detail it sheds is the matching read's (CHAT_CORE_PARTIAL_KEYS).

function pickFields(entry: unknown, fields: readonly string[]): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const row = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (Object.hasOwn(row, field)) out[field] = row[field];
  return out;
}

// What the Brief said today — kind, headline, why, focus — so chat never contradicts the
// screen the athlete just read. The `signals` blob (~11 KB) is the deterministic layer's
// working; signal_state carries the same evidence in the shape the prompt reads.
const CHAT_DAY_READ_FIELDS = ["kind", "headline", "why", "focus", "est_minutes", "source", "decision"] as const;

// Each dimension's status, confidence and reason, with its evidence as {field, date,
// direction, summary}: the machine-register facts. Coverage maps, provenance lists and
// the voice keys are the arbitration's bookkeeping.
const CHAT_SIGNAL_EVIDENCE_FIELDS = ["field", "date", "direction", "summary"] as const;
function compactChatSignalState(state: unknown): unknown {
  const row = compactSignalState(state);
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const { provenance: _provenance, ...rest } = row as Record<string, unknown>;
  const dimensions = rest.dimensions;
  if (dimensions && typeof dimensions === "object" && !Array.isArray(dimensions)) {
    rest.dimensions = Object.fromEntries(
      Object.entries(dimensions as Record<string, unknown>).map(([key, dimension]) => {
        if (!dimension || typeof dimension !== "object" || Array.isArray(dimension)) return [key, dimension];
        const d = dimension as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const field of ["status", "confidence", "latest_date", "reason"]) if (Object.hasOwn(d, field)) out[field] = d[field];
        if (Array.isArray(d.conflicts) && d.conflicts.length) out.conflicts = d.conflicts;
        // A neutral, context-only row moves no dimension; the rows that support or brake
        // (and any safety override) are the evidence. The full list is in the full context.
        if (Array.isArray(d.evidence))
          out.evidence = d.evidence
            .filter((ev) => {
              const row = ev as Record<string, unknown> | null;
              return row?.safety_override === true || (row?.direction !== "neutral" && row?.context_only !== true);
            })
            .map((ev) => {
            const picked = pickFields(ev, CHAT_SIGNAL_EVIDENCE_FIELDS) as Record<string, unknown>;
            // A safety override is the one evidence flag that changes how a row reads.
            if ((ev as Record<string, unknown> | null)?.safety_override === true) picked.safety_override = true;
            return picked;
          });
        return [key, out];
      })
    );
  }
  if (rest.action && typeof rest.action === "object" && !Array.isArray(rest.action)) {
    const { voice: _voice, reasons: _reasons, ...action } = rest.action as Record<string, unknown>;
    rest.action = action;
  }
  return rest;
}

// The targets the fuel guardrail names (effective_target, then recommended) and the
// energy read in one line each. The expenditure anchors, BMR arithmetic and coverage
// are read_nutrition_window's.
const CHAT_GOAL_FIELDS = [
  "goal_mode",
  "tdee",
  "tdee_confidence",
  "effective_target",
  "recommended",
  "requested",
  "message",
  "safe_max_rate_lb",
  "trend_lb_wk",
  "projected_goal_date",
  "projection_text",
] as const;

// The body journey as the coach states it: the goal, the body-fat estimate, the stage,
// the pace and the current move. The rest (proposed phases, the leanness arithmetic, the
// recomposition evidence keys, the nested underfueling read) is read_goal_progress.
function compactChatJourney(journey: unknown): unknown {
  if (!journey || typeof journey !== "object" || Array.isArray(journey)) return journey;
  const row = journey as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of ["profile", "body_fat", "active_phase"]) if (Object.hasOwn(row, field)) out[field] = row[field];
  const recomposition = row.recomposition as Record<string, unknown> | null | undefined;
  if (recomposition && typeof recomposition === "object" && !Array.isArray(recomposition)) {
    const stage = recomposition.stage as Record<string, unknown> | undefined;
    const progress = recomposition.progress as Record<string, unknown> | undefined;
    out.recomposition = {
      stage: stage && typeof stage === "object" ? (stage.label ?? stage.kind ?? null) : null,
      ...(progress && typeof progress === "object"
        ? { progress: pickFields(progress, ["current_weight_lb", "goal_weight_lb", "remaining_lb", "robust_trend_lb_wk", "timeline"]) }
        : {}),
      line: recomposition.line ?? null,
    };
  }
  return out;
}

// Every plan day's lifts with their targets — the exercise names and day numbers a
// plan_update names. Row ids, notes and the run-era columns are dropped; a day's full
// stored prescription is read_current_plan_detail.
const CHAT_PLAN_ITEM_FIELDS = [
  "exercise",
  // note and warmup_sets ride because a plan_restructure authored from this core writes
  // the days back: a field the model was never shown must not be erasable by omission
  // (the server also carries them forward, src/chatTurns.ts carryForwardPlanItemFields).
  "note",
  "warmup_sets",
  "sets",
  "rep_low",
  "rep_high",
  "target_weight",
  "target_seconds",
  "mode",
  "unit",
  "constraint_note",
  "superset_group",
] as const;
function compactChatPlan(plan: unknown): unknown {
  if (!Array.isArray(plan)) return plan;
  return plan.map((day) => {
    if (!day || typeof day !== "object" || Array.isArray(day)) return day;
    const d = day as Record<string, unknown>;
    const out: Record<string, unknown> = { day_number: d.day_number, name: d.name, focus: d.focus ?? null };
    if (Array.isArray(d.items))
      out.items = d.items.map((item) => {
        const picked = pickFields(item, CHAT_PLAN_ITEM_FIELDS) as Record<string, unknown>;
        // null is a fact for target_weight (bodyweight); for the rest it is noise, and
        // "reps" is every item's mode unless it is timed.
        for (const field of ["target_seconds", "constraint_note", "superset_group", "note", "warmup_sets"])
          if (picked[field] == null || picked[field] === "") delete picked[field];
        if (picked.mode === "reps") delete picked.mode;
        return picked;
      });
    return out;
  });
}

// The week's run kinds per day (and any adjustment), not the prose around them.
const CHAT_RUN_FIELDS = ["day_number", "label", "kind_label", "target_distance_km", "target_duration_min", "target_zone", "interval"] as const;
function compactChatRunPlan(plan: unknown): unknown {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const row = plan as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of ["available", "week_start", "mix_summary", "today_adjustment", "adapt", "quality_focus"])
    if (Object.hasOwn(row, field)) out[field] = row[field];
  if (Array.isArray(row.runs)) out.runs = row.runs.map((run) => pickFields(run, CHAT_RUN_FIELDS));
  return out;
}

// The week's run intentions: what each is, whether it is done, where it sits, and the
// adjustment's own reason. Windows, provisional numbers and the generic rationale go.
const CHAT_INTENT_FIELDS = ["kind", "label", "status", "suggested_date", "target_distance_km", "target_zone", "planned_label"] as const;
function compactChatAgenda(agenda: unknown): unknown {
  if (!agenda || typeof agenda !== "object" || Array.isArray(agenda)) return agenda;
  const row = agenda as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of ["available", "week_start", "week_end", "next", "today_guidance", "why", "today_adjustment"])
    if (Object.hasOwn(row, field)) out[field] = row[field];
  if (Array.isArray(row.intents))
    out.intents = row.intents.map((intent) => {
      const i = intent as Record<string, unknown> | null;
      const picked = pickFields(i, CHAT_INTENT_FIELDS) as Record<string, unknown>;
      if (picked.planned_label === picked.label) delete picked.planned_label;
      const completion = i?.completion as Record<string, unknown> | null | undefined;
      if (completion && typeof completion === "object") picked.completion = pickFields(completion, ["activity_id", "date"]);
      const adjustment = i?.adjustment as Record<string, unknown> | null | undefined;
      if (adjustment && typeof adjustment === "object") picked.adjustment = pickFields(adjustment, ["date", "kind", "dose", "why"]);
      return picked;
    });
  return out;
}

// What can still be acted on: a decision waiting on the athlete or announced, and any
// reversible one (revert_decision names its id from here). The ledger's history is
// read_decision_history.
function compactChatDecisions(decisions: unknown): unknown {
  if (!Array.isArray(decisions)) return decisions;
  return decisions.filter((decision) => {
    const d = decision as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return false;
    return d.reversible === true || ["pending", "announced", "review"].includes(String(d.status));
  });
}

// Active directives, as the instruction and the reading behind it. The rationale,
// citation and storage stamps are read_health_summary's.
const CHAT_DIRECTIVE_FIELDS = ["domain", "marker", "directive", "context_note", "role", "uncertain", "trigger_date", "stale_measurement"] as const;
function compactChatDirectives(directives: unknown): unknown {
  const rows = compactDirectives(directives);
  if (!Array.isArray(rows)) return rows;
  return rows
    .filter((row) => {
      const status = (row as Record<string, unknown> | null)?.status;
      return status == null || status === "active" || status === "acknowledged";
    })
    .map((row) => {
      const picked = pickFields(row, CHAT_DIRECTIVE_FIELDS) as Record<string, unknown>;
      // The citation text is read_health_summary's; whether there IS one is what the
      // guardrail turns on ("uncertain or uncited is a softer nudge").
      const citation = (row as Record<string, unknown> | null)?.citation;
      picked.cited = typeof citation === "string" ? citation.trim().length > 0 : citation != null;
      for (const field of ["context_note", "role", "uncertain", "stale_measurement"])
        if (picked[field] == null || picked[field] === false) delete picked[field];
      return picked;
    });
}

// The activity rows chat names by id (set_activity_effort) and reads as a log; storage
// bookkeeping (external ids, enrichment status, write stamps) goes.
const CHAT_ACTIVITY_FIELDS = ["id", "date", "type", "raw_text", "duration_min", "distance_km", "pace", "rpe", "notes"] as const;

// Which muscle groups are still recovering, and from what. The gate's own load ratio is
// its arithmetic; the band is its answer.
const CHAT_ACUTE_GATE_FIELDS = ["group", "band", "saturated", "deep", "last_date", "days_ago", "source", "activity", "detail"] as const;

// Life-context events with the id resolve_context_event names and what makes one bind
// today (its dates, whether it is resolved, how it constrains); write stamps go.
const CHAT_CONTEXT_EVENT_FIELDS = [
  "id",
  "kind",
  "title",
  "detail",
  "start_date",
  "end_date",
  "expected_recovery_days",
  "meta",
  "resolved",
  "likely_resolved",
  "needs_recheck",
  "constraint_level",
] as const;

// Check-ins as the day they describe: the row id and write stamp go.
const CHAT_CHECKIN_FIELDS = ["date", "mood", "energy", "sleep_feel", "soreness", "note"] as const;

// A logged session minus its row ids and write stamp (its `date` says when); empty
// garmin / composition blobs go. Sets are already projected by compactSessions.
function compactChatSessions(sessions: unknown): unknown {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.map((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return session;
    const { id: _id, plan_day_id: _planDay, created_at: _created, ...rest } = session as Record<string, unknown>;
    if (rest.garmin == null) delete rest.garmin;
    if (rest.daily_session == null) delete rest.daily_session;
    // A reps set's empty duration and note, and its default mode, say nothing; `weight:
    // null` (bodyweight) and a timed set's fields always stay.
    if (Array.isArray(rest.sets))
      rest.sets = rest.sets.map((set) => {
        if (!set || typeof set !== "object" || Array.isArray(set)) return set;
        const row = { ...(set as Record<string, unknown>) };
        if (row.mode === "reps") {
          delete row.mode;
          if (row.duration_sec == null) delete row.duration_sec;
        }
        if (row.note == null) delete row.note;
        return row;
      });
    return rest;
  });
}

// Memory rows as the coach reads them, with the id every memory action names.
const CHAT_MEMORY_FIELDS = ["id", "kind", "content"] as const;

// The profile minus its storage: the row id and write stamp, and the raw *_json columns
// whose parsed reads ride as their own keys (training_intent, endurance_schedule, …).
// An unset field is dropped rather than shipped as null — for a profile they say the
// same thing ("not stated").
function compactChatProfile(profile: unknown): unknown {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile as Record<string, unknown>)) {
    if (key === "id" || key === "updated_at" || key.endsWith("_json") || value == null || value === "") continue;
    out[key] = value;
  }
  return out;
}

// The conductor's lead and parallel focus, today's state and what changed — the rest
// (the evidence tiles, the later queue, the retest list) is read_goal_progress's. Its
// day-posture prose is already stripped by compactCoachingFocus.
const CHAT_FOCUS_FIELDS = ["available", "headline", "acts", "lead", "parallel", "day_state", "changed_since", "caveat", "caveat_cause", "block_line", "block"] as const;

// The fuel read's verdict and what it rests on: state, confidence, the window, the
// intake comparison and the correction in force. Its per-channel evidence is
// read_nutrition_window's.
const CHAT_UNDERFUELING_FIELDS = ["as_of", "state", "confidence", "intake", "rationale", "action"] as const;

// The latest health review as the guardrail uses it: its focus areas and watchlist
// actions, capped. The headline, follow-ups and history are read_health_summary's.
const CHAT_HEALTH_REVIEW_FOCUS = 4;
const CHAT_HEALTH_REVIEW_WATCH = 6;
function compactChatHealthReview(review: unknown): unknown {
  if (!review || typeof review !== "object" || Array.isArray(review)) return review;
  const row = review as Record<string, unknown>;
  return {
    ...(row.created_at != null ? { as_of: String(row.created_at).slice(0, 10) } : {}),
    focus: (Array.isArray(row.focus) ? row.focus : [])
      .slice(0, CHAT_HEALTH_REVIEW_FOCUS)
      .map((item) => pickFields(item, ["title", "action"])),
    watchlist: (Array.isArray(row.watchlist) ? row.watchlist : [])
      .slice(0, CHAT_HEALTH_REVIEW_WATCH)
      .map((item) => pickFields(item, ["marker", "status", "action"])),
  };
}

function compactChatCore(key: string, value: unknown): unknown {
  switch (key) {
    case "underfueling":
      return pickFields(value, CHAT_UNDERFUELING_FIELDS);
    case "health_review":
      return compactChatHealthReview(value);
    case "day_read":
      return pickFields(value, CHAT_DAY_READ_FIELDS);
    case "signal_state":
      return compactChatSignalState(value);
    case "goal":
      return pickFields(value, CHAT_GOAL_FIELDS);
    case "journey":
      return compactChatJourney(value);
    case "plan":
      return compactChatPlan(value);
    case "run_plan":
      return compactChatRunPlan(value);
    case "flexible_training_agenda":
      return compactChatAgenda(value);
    case "recent_decisions":
      return compactChatDecisions(value);
    case "directives":
      return compactChatDirectives(value);
    case "recent_activities":
      return Array.isArray(value) ? value.map((row) => pickFields(row, CHAT_ACTIVITY_FIELDS)) : value;
    case "memory":
      return Array.isArray(value) ? value.map((row) => pickFields(row, CHAT_MEMORY_FIELDS)) : value;
    case "acute_gates":
      return Array.isArray(value) ? value.map((row) => pickFields(row, CHAT_ACUTE_GATE_FIELDS)) : value;
    case "context_events":
      return Array.isArray(value) ? value.map((row) => pickFields(row, CHAT_CONTEXT_EVENT_FIELDS)) : value;
    case "checkins":
      return Array.isArray(value) ? value.map((row) => pickFields(row, CHAT_CHECKIN_FIELDS)) : value;
    case "profile":
      return compactChatProfile(value);
    case "coaching_focus": {
      // The parallel items' `based_on` grounds are the conductor's working; their title,
      // why and move are what the coach speaks to.
      const focus = pickFields(compactCoachingFocus(value), CHAT_FOCUS_FIELDS) as Record<string, unknown>;
      if (Array.isArray(focus?.parallel))
        focus.parallel = focus.parallel.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item;
          const { based_on: _grounds, ...rest } = item as Record<string, unknown>;
          return rest;
        });
      return focus;
    }
    case "training_drive": {
      // The stance and any open offer; the static never-overrides list is prose the
      // drive line already renders.
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const { never_overrides: _never, ...drive } = value as Record<string, unknown>;
      return drive;
    }
    case "week_training_load": {
      // The next 48 hours' planned days are dated_week's rows; its read (legs, the
      // implication and its line) stays.
      const load = compactWeekTrainingLoad(value) as Record<string, unknown> | unknown;
      if (!load || typeof load !== "object" || Array.isArray(load)) return load;
      const row = load as Record<string, unknown>;
      const next = row.next_48h as Record<string, unknown> | undefined;
      if (!next || typeof next !== "object" || Array.isArray(next)) return row;
      const { planned: _planned, ...rest } = next;
      return { ...row, next_48h: rest };
    }
    default:
      return undefined;
  }
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
    if (site === "chat_core") {
      const compacted =
        key === "recent_sessions"
          ? compactChatSessions(compactSessions(value, spec.sessions, "full"))
          : compactChatCore(key, value);
      if (compacted !== undefined) {
        out[key] = compacted;
        continue;
      }
    }
    out[key] =
      key === "recent_sessions"
        ? compactSessions(value, spec.sessions, spec.session_detail ?? "full")
        : key === "recovery" || key === "garmin"
          ? compactRecovery(value)
          : key === "coaching_focus"
            ? compactCoachingFocus(value)
            : key === "read_adherence"
              ? compactReadAdherence(value)
              : key === "signal_state"
                ? compactSignalState(value)
                : key === "directives"
                  ? compactDirectives(value)
                  : key === "race_build"
                    ? compactRaceBuild(value)
                    : key === "week_training_load" && site === "day_read"
                      ? compactWeekTrainingLoad(value)
                      : value;
  }
  return out as PartialCoachContext;
}

/**
 * The named keys of the coach context, right-sized the way every prompt site sizes them
 * (the recovery/garmin quality-map dedupe, the directive reframing, the signal-state and
 * coaching-focus plumbing, the race build's page prose). The coach reads that return a
 * slice of the context (src/brain/read-tool-runtime.ts) go through this, so a block a
 * read hands back is the same block the full chat DATA carried. Absent keys stay absent.
 */
export function projectCoachContextKeys(
  ctx: PartialCoachContext,
  keys: readonly PromptContextKey[]
): Record<string, unknown> {
  const source = (ctx ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    out[key] =
      key === "recovery" || key === "garmin"
        ? compactRecovery(value)
        : key === "coaching_focus"
          ? compactCoachingFocus(value)
          : key === "signal_state"
            ? compactSignalState(value)
            : key === "directives"
              ? compactDirectives(value)
              : key === "race_build"
                ? compactRaceBuild(value)
                : key === "recent_sessions"
                  ? compactSessions(value, SESSIONS_FULL)
                  : value;
  }
  return out;
}

/**
 * The serialized `DATA:` payload for a prompt site — the ONLY thing a prompt builder
 * should interpolate into its DATA block. Always emits well-formed JSON (the payload
 * is shrunk by projecting structure, never by truncating a string).
 */
export function promptData(ctx: PartialCoachContext, site: PromptSite): string {
  return JSON.stringify(projectCoachContext(ctx, site));
}
