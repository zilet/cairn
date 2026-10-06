// ============================================================================
// coaching-focus.ts — THE CONDUCTOR. The whole-athlete analog of healthFocus().
//
// Cairn holds the whole picture (training capacity, running, DEXA body comp, labs,
// recovery, nutrition, the long game) and each domain read is excellent — but until
// now nothing arbitrated ACROSS them. Health had healthFocus() (act_now/track tiers,
// one lead); training/running/DEXA/nutrition/recovery never did, so every plan prompt
// concatenated ~14 self-asserting "lead with me" blocks with no conductor.
//
// An elite coach does the opposite of a dashboard: holds everything, ACTS on 1-3
// SEQUENCED priorities, CONNECTS the domains, and says out loud what's DEFERRED
// ("we'll retest the squat at week 8"). This module is that conductor: a pure,
// deterministic pass over the already-computed domain reads that emits ONE lead lever,
// 1-2 things handled in parallel (usually through a different lever, e.g. diet), an
// explicit "later" sequence, the cross-domain connections, and ONE batched retest
// checkpoint — so the brain and the interface can both LEAD with the same focus.
//
// Constitution: leverage is INTERNAL ordering only (never surfaced — like marker
// impact_score). Plain words, no 0-100 score. Suggestion, never a gate. Everything
// is consumed via opts (the reads getCoachContext already built once) so this never
// recomputes a heavy view, and every field is read null-safe so it degrades to
// {available:false} on a thin athlete.
// ============================================================================

import { followupLabel, labRecheckLabel } from "./attention-labels.js";
import {
  type CapacityInput,
  type CutQualityInput,
  type FocusBlockRead,
  type FocusChange,
  type FocusDayState,
  type FocusEvidence,
  type GoalPaceInput,
  type HealthPriorityInput,
  type HealthReadingInput,
  type LiftInput,
  type RaceBuildInput,
  type RaceRead,
  type WeekWinsInput,
  blockRead,
  flaggedReadings,
  focusChanges,
  focusEvidence,
  joinAnd,
  leverFacts,
  leverLift,
  paceRelation,
  phaseMoveFor,
  raceItem,
  raceName,
  raceRead,
  raceShapesTheWeek,
  readingPhrase,
  unitsOfInput,
  weightRead,
} from "./coaching-focus-read.js";
import { shortDate } from "./dexa-window.js";
import { weightRateWords, weightWords } from "./display-words.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { isDoctorLoopSignal } from "./doctor-loop-items.js";
import { movementKey } from "./exercise-canon.js";
import { type FocusCandidate, type FocusDomain, focusScore } from "./focus-candidate.js";
import { recoverySignalIsDecisionGrade } from "./sensor-cadence.js";
import { clipText } from "./shared.js";
import {
  lifeCapacityIsCommitment,
  spokenSignalVoice,
  SIGNAL_VOICE_KEYS,
  type SignalDimension,
  type SignalPosture,
  type UnifiedSignalState,
} from "./signal-state.js";
import { coerceFinite as num } from "../lib/numbers.js";

// Re-exported so existing importers keep resolving `FocusDomain` from the conductor.
export type { FocusCandidate, FocusDomain } from "./focus-candidate.js";
export type {
  FocusBlockRead,
  FocusChange,
  FocusChangeKind,
  FocusDayState,
  FocusDeloadDecision,
  FocusDirection,
  FocusEvidence,
} from "./coaching-focus-read.js";

export interface FocusItem {
  domain: FocusDomain;
  title: string;
  why: string;
  move?: string;
  /** Plain-language inputs that caused this lever to surface. Bounded, no scores. */
  based_on?: string[];
  // One-tap rotation for a stalled lead lift: rotate `from` out for one of the `to`
  // variations (same movement pattern). Mirrors ClientCoachingFocusItem.swap — the
  // surface resolves the plan day and wires the apply; the conductor stays PURE (no DB).
  swap?: { from: string; to: string[] };
  // A recovery lead whose one-tap draft already landed: the surface renders a review
  // link into Coach instead of the (now-stale) draft button. State in, state out —
  // the conductor never queries; the assembler passes recoveryDraftPending.
  draft_pending?: boolean;
  // A recovery week currently RUNNING (applied and inside its window): the surface
  // renders no action at all — the lead is a confirmation, not an ask.
  recovery_active?: boolean;
  // A canonical day posture supplied by UnifiedSignalState. This distinguishes a
  // daily rest/easy/done confirmation from a program-level recovery-week action.
  day_posture?: Extract<SignalPosture, "rest" | "easy" | "done">;
}

export interface CoachingRetest {
  in_weeks: number | null; // 0 = a check-in week is due now
  focus: string[]; // the batched TRAINING re-tests (lifts + a run test), never a lab
  // The labs / scans due in the same window, by their canonical display names
  // ("hs-CRP", "DEXA scan"). Their own list, never mixed into `focus`: a marker read
  // inside a list of lifts reads as one more lift.
  labs: string[];
  why: string;
}

export interface CoachingFocus {
  available: boolean;
  headline: string; // where you are + the through-line, one sentence
  // Whether the surface should offer one-tap ACTIONS (the swap / draft-recovery
  // buttons). False under lead mode — the coach applies bounded changes itself at
  // natural boundaries, so the card speaks STATE, not an ask. Absent is treated as
  // true (the legacy navigate-and-act behavior on the non-lead surfaces).
  acts?: boolean;
  lead: FocusItem | null; // THE single highest-leverage lever this block
  parallel: FocusItem[]; // 1-2 handled simultaneously, usually via a different lever
  // Explicitly deferred — the sequence. `why` says why it waits (on pace, after race
  // day, rides with the lead…), so a deferral reads as a decision, not an omission.
  later: { domain: FocusDomain; title: string; why?: string }[];
  connections: string[]; // 1-2 plain cross-domain ties
  retest: CoachingRetest | null; // ONE batched check-in, not four nag feeds
  horizon_weeks: number | null;
  // A life/soreness CAVEAT: when a training lever would load an active injury / sore
  // joint / reduce-load window, the conductor either demotes it or annotates it. Plain
  // words, never a gate — "work the leg plateau AROUND your knee, pain-free only".
  caveat: string | null;
  // WHICH dimension produced `caveat`, as its display label. Carried alongside the
  // text because the cause is otherwise module-private: the prompt layer labelled
  // every caveat "EASE AROUND (injury/soreness)" while the conductor selects it by
  // cause, announcing four of five causes to the model as an injury that did not
  // exist. Scraping it back out of `based_on` would misattribute, since two of the
  // three paths that produce `caveat` carry no such line. Null when `caveat` is.
  caveat_cause: string | null;
  // Temporal placement inside the active program block, plain words — "Week 3 of
  // 5 — building volume." Descriptive calendar truth, never a score or a gate.
  // Read through block-phase.ts's ONE resolution, so a scheduled deload a push athlete
  // runs as intensification is SAID to be set aside, never "in sight". Null when no
  // block is active.
  block_line: string | null;
  // The same block read, structured: week N of M, the phase the week runs as, and what
  // the deload / peak decision actually is this week. Null when no block is active.
  block: FocusBlockRead | null;
  // TODAY's posture (rest / easy / complete) — a day state, said apart from the week's
  // lever. A finished day no longer takes the lead: the week's lever does.
  day_state: FocusDayState | null;
  // Value-and-direction bullets behind the read, ordered by the card's own domains.
  // Values and directions only — no score, no percentile, never an impact_score.
  evidence: FocusEvidence[];
  // What moved, each measured against a stated date (a new best, the race estimate,
  // the weight average, a fresh lab, last week's running).
  changed_since: FocusChange[];
}

interface CoachingDisciplineInput {
  primary?: unknown;
  endurance_sport?: unknown;
}

interface EnduranceGoalInput {
  is_race?: unknown;
  phase?: unknown;
  weeks_to_race?: unknown;
}

interface TrainingIntentInput {
  priorities?: unknown;
  endurance_role?: unknown;
  source?: unknown;
}

interface EnduranceCapacityInput {
  status?: unknown;
  sport?: unknown;
  target_duration_min?: unknown;
  summary?: unknown;
  next_step?: unknown;
}

interface ProgramMesocycleInput {
  phase?: unknown;
  note?: unknown;
  deload_evidence?: unknown;
}

interface ProgramStateInput {
  mesocycle?: ProgramMesocycleInput | null;
  lifts?: LiftInput[] | null;
}

interface RecoveryDeltaInput {
  hrv?: unknown;
  rhr?: unknown;
}

interface RecoverySignalEvidenceInput {
  latest_date?: unknown;
  sample_count?: unknown;
  expected_days?: unknown;
  window_days?: unknown;
  freshness?: unknown;
}

interface RecoveryInput {
  delta?: RecoveryDeltaInput | null;
  quality?: Record<string, RecoverySignalEvidenceInput> | null;
  coverage?: Record<string, RecoverySignalEvidenceInput> | null;
  provenance?: Record<string, RecoverySignalEvidenceInput> | null;
}

interface HealthFocusMovesInput {
  nutrition?: unknown;
  training?: unknown;
  watch?: unknown;
}

interface HealthFocusLeadInput {
  group?: unknown;
  why?: unknown;
  tier?: unknown;
  moves?: HealthFocusMovesInput | null;
  readings?: HealthReadingInput[] | null;
}

interface HealthFocusInput {
  headline?: unknown;
  lead?: HealthFocusLeadInput | null;
  priorities?: HealthPriorityInput[] | null;
}

interface PerformanceLeverInput {
  headline?: unknown;
  why?: unknown;
  target?: unknown;
}

interface PerformanceEnduranceInput {
  tone?: unknown;
  vo2max?: unknown;
  trend?: unknown;
}

interface PerformanceHeroInput {
  headline?: unknown;
}

interface PerformanceImbalanceInput {
  title?: unknown;
  why?: unknown;
}

interface PerformanceTestDueInput {
  exercise?: unknown;
  kind?: unknown;
}

interface PerformanceInput {
  hero?: PerformanceHeroInput | null;
  lever?: PerformanceLeverInput | null;
  endurance?: PerformanceEnduranceInput | null;
  imbalances?: unknown;
  tests_due?: unknown;
  // The benchmark capacities (est-1RM, level, the next standard) — read for the
  // lever lift's values; the level is a supporting fact only when strength leads.
  capacities?: CapacityInput[] | null;
  momentum?: { chips?: unknown } | null;
}

interface ProgramAdjustmentInput {
  kind?: unknown;
  title?: unknown;
  why?: unknown;
}

interface RunPlanInput {
  available?: unknown;
  quality_focus?: unknown;
  why?: unknown;
  mix_summary?: unknown;
}

interface RunVarietyInput {
  note?: unknown;
}

interface DexaLeadInput {
  area?: unknown;
  signal?: unknown;
  bias?: unknown;
  domain?: unknown;
  path?: unknown;
}

interface DexaInput {
  available?: unknown;
  lead?: DexaLeadInput | null;
}

interface MuscleGroupTrajectoryInput {
  verdict?: unknown;
  label?: unknown;
  group?: unknown;
  lead_lift?: unknown;
  stalled_signal?: unknown;
  vary_options?: unknown;
}

interface GroupsTrajectoryInput {
  groups?: unknown;
}

interface TrajectoryInput {
  horizon_weeks?: unknown;
}

interface TestWeekInput {
  due?: unknown;
  key_lifts?: unknown;
}

interface EnduranceTestInput {
  exercise?: unknown;
}

// An active injury the conductor must plan around (from context_events).
interface InjuryInput {
  title?: unknown;
  area?: unknown;
  detail?: unknown;
  likely_resolved?: unknown;
}

// The 1-tap autoregulation rollup (soreness/joint pain) — a soft signal, never a gate.
interface AutoregInput {
  note?: unknown;
  joint_pain?: unknown;
  soreness?: unknown;
}

// The active life-context effect (activeContextEffect) — reduce-load window etc.
interface ContextTodayInput {
  reduce_load?: unknown;
  any?: unknown;
}

export interface CoachingFocusInput {
  discipline?: CoachingDisciplineInput | null;
  trainingIntent?: TrainingIntentInput | null;
  enduranceCapacity?: EnduranceCapacityInput | null;
  enduranceGoal?: EnduranceGoalInput | null;
  goalMode?: string;
  programState?: ProgramStateInput | null;
  recovery?: RecoveryInput | null;
  healthFocus?: HealthFocusInput | null;
  performance?: PerformanceInput | null;
  programAdjustments?: unknown;
  runPlan?: RunPlanInput | null;
  runVariety?: RunVarietyInput | null;
  dexa?: DexaInput | null;
  groupsTrajectory?: GroupsTrajectoryInput | null;
  trajectory?: TrajectoryInput | null;
  testWeek?: TestWeekInput | null;
  enduranceTests?: unknown;
  // Life/soreness awareness: the conductor must not lead with a training lever that
  // loads an active injury or a sore joint (it demotes or caveats it instead).
  injuries?: InjuryInput[] | null;
  autoregulation?: AutoregInput | null;
  contextToday?: ContextTodayInput | null;
  // ---- external producers the conductor arbitrates (K3) ---------------------
  // Each is a plain read the orchestrator supplies (coach.ts), so this stays a PURE
  // function. Adapted into FocusCandidates + folded into the one ranking below.
  journeyMilestones?: unknown; // JourneyMilestone[] — calm body-composition moments
  benchmarkMilestones?: unknown; // TrainingMilestoneCandidate[] — near a strength/endurance standard
  dueAttention?: unknown; // AttentionScheduleEntry[] — K5 re-checks due (labs/DEXA/lifts)
  cardioRisk?: unknown; // cardiovascularRiskRead() — the PREVENT clinical risk read
  // The active program block's calendar summary (repo/program-blocks blockForCoach()),
  // so "This block" can say WHERE in the block the athlete is. Null when no block.
  programBlock?: ProgramBlockSummaryInput | null;
  // Whether a one-tap recovery-week draft is already waiting in Coach — the recovery
  // lead then speaks STATE ("drafted — review and apply it") instead of re-offering
  // the action, and the Program surface renders a review link, not the draft button.
  recoveryDraftPending?: unknown;
  // Whether the applied recovery week is RUNNING right now — the lead becomes a calm
  // confirmation ("recovery week is on, absorb the work") with no action at all.
  recoveryWeekActive?: unknown;
  // ---- autonomy-awareness (lead-by-default) ---------------------------------
  // The server lead posture ('lead' | 'announce_first' | 'review_everything').
  // Under 'lead' the coach applies bounded plan changes itself at natural
  // boundaries, so the conductor drops its one-tap asks and speaks state instead.
  leadMode?: unknown;
  // Whether background coaching (the scheduler's proactive tick) is on. The
  // auto-draft/auto-rotate mechanisms live there — with it OFF, lead mode cannot
  // actually act unattended, so the conductor must keep the athlete-driven asks
  // rather than promise background work that will never run.
  proactiveEnabled?: unknown;
  // The already-computed canonical daily state. The conductor adapts this into
  // ordinary candidates/constraints and sends them through its existing ranker;
  // it never computes a second readiness score.
  signalState?: UnifiedSignalState | null;
  // Exercise rotations the brain (or the athlete) already applied — a stalled lead
  // whose lift was rotated out is ALREADY HANDLED, so the conductor speaks to the
  // new stimulus instead of re-offering the same swap. [{ from, to, date }].
  recentRotations?: unknown;
  // Every exercise name currently on a plan day — a stalled lift no longer here has
  // been rotated out; the stale plateau read is dropped rather than offering to
  // rotate out a lift that isn't there. string[].
  plannedNames?: unknown;
  // Announced / quiet-pending brain decisions landing soon (upcomingBrainDecisions)
  // — lets a recovery lead name the weekday its auto-set recovery week arrives.
  upcoming?: unknown;
  // ---- the week read (coaching-focus-read.ts) ---------------------------------
  // The read's own date (YYYY-MM-DD). Falls back to the signal state's date.
  date?: unknown;
  // raceBuild() — the dated race build: estimate, fit, this week and next, the ride.
  raceBuild?: RaceBuildInput | null;
  // goalPace(21) — canonical weigh-ins, the trend and the line to the goal.
  goalPace?: GoalPaceInput | null;
  // weekWins() — the new bests set in the trailing seven days.
  weekWins?: WeekWinsInput | null;
  // cutQualityRead() — whether the lifts are holding as the weight comes down.
  cutQuality?: CutQualityInput | null;
  // athleteUnits() — the units every sentence here says its numbers in (km|mi, lb|kg).
  units?: { distance?: unknown; weight?: unknown } | null;
  // weekStage(date) (week-stage.ts) — the week's ONE stage word, leading the block line.
  weekStage?: { word?: unknown; week_word?: unknown } | null;
  // weightTrendRead(date) (weight-trend.ts) — the ONE weight rate, ask and week change.
  weightTrend?: {
    rate_lb_wk?: number | null;
    needed_lb_wk?: number | null;
    verdict?: "on_pace" | "ahead" | "behind" | "steady" | null;
    week_change?: { avg_lb: number; delta_lb: number; since: string; words: string } | null;
  } | null;
}

// An applied exercise rotation the brain/athlete already made (recentAppliedRotations).
interface AppliedRotationInput {
  from?: unknown;
  to?: unknown;
  date?: unknown;
}

// A brain decision landing soon (upcomingBrainDecisions) — the conductor reads its
// weekday to name when an auto-set recovery week arrives.
interface UpcomingDecisionInput {
  kind?: unknown;
  domain?: unknown;
  summary?: unknown;
  effective_date?: unknown;
}

interface ProgramBlockSummaryInput {
  goal?: unknown;
  focus?: unknown;
  phase?: unknown;
  week_of?: unknown;
  // coachBlockSummary (block-phase.ts): a push athlete's scheduled deload is running
  // as intensification because the loaded weeks did not earn it.
  scheduled_deload_skipped?: unknown;
  // nextWeekScheduledDeloadRuns (block-phase.ts): whether next week's scheduled deload
  // will actually run. Absent = unknown.
  next_week_deload_runs?: unknown;
}

interface Candidate {
  item: FocusItem;
  leverage: number; // INTERNAL ordering only — never surfaced
  slot: "lead" | "parallel" | "later";
  key: string;
  // The lever as a short noun phrase for the headline ("your overhead press", "the
  // half marathon build"). Internal; only the headline speaks it.
  noun?: string;
  // Why this waits, when it lands in `later` ("on pace — nothing to change").
  defer?: string;
  // Set when this (training) lever loads a flagged/injured/sore area — the conductor
  // prefers a non-conflicting lead and, if it keeps this one, surfaces the caveat.
  caveat?: string;
  // The display label of the dimension that produced `caveat`, carried with it so
  // coachingFocus() can publish the cause without re-deriving it.
  caveat_cause?: string;
}

function lc(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}
function clip(s: unknown, n: number): string {
  return clipText(s, n, { ellipsis: "…" });
}
function inputArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
// The conductor ranks its internal candidates through the SAME scalar formula the
// shared arbiter (focus-candidate.ts) uses for nextBestStep — so "leverage" means the
// same thing on every "what's next" surface. Every conductor candidate is an actionable
// lever, so this reduces to leverage ordering while staying the one shared primitive.
function candScore(c: Candidate): number {
  return focusScore(c.leverage, { actionable: true });
}
function byScore(a: Candidate, b: Candidate): number {
  return candScore(b) - candScore(a);
}

function enduranceRole(inp: CoachingFocusInput): "none" | "supporting" | "co_primary" | "primary" {
  const explicit = lc(inp.trainingIntent?.endurance_role);
  if (explicit === "supporting" || explicit === "co_primary" || explicit === "primary") return explicit;
  return "none";
}

function activeRace(inp: CoachingFocusInput): boolean {
  const phase = lc(inp.enduranceGoal?.phase);
  return !!inp.enduranceGoal?.is_race && phase !== "past";
}

// A deliberately small internal tie-break from the athlete's ordered durable
// intent. It can bias the conductor, never create a candidate or leak a rank.
function applyIntentBias(candidate: Candidate, inp: CoachingFocusInput): Candidate {
  const priorities = inputArray<unknown>(inp.trainingIntent?.priorities).map(lc);
  const matches = (priority: string): boolean => {
    if (priority === "muscle" || priority === "strength") return candidate.item.domain === "training";
    if (priority === "leanness") return candidate.item.domain === "body" || candidate.item.domain === "nutrition";
    if (priority === "endurance") return candidate.item.domain === "running";
    if (priority === "longevity") return candidate.item.domain === "health" || candidate.item.domain === "recovery";
    return false;
  };
  const at = priorities.findIndex(matches);
  if (at < 0) return candidate;
  return { ...candidate, leverage: candidate.leverage + Math.max(0.04, 0.2 - at * 0.04) };
}
function cleanEvidence(lines: unknown): string[] | undefined {
  const out = inputArray<unknown>(lines)
    .map((line) => clip(line, 110))
    .filter(Boolean)
    .slice(0, 3);
  return out.length ? out : undefined;
}
// Sanitize the one-tap swap payload: `from` a trimmed non-empty string, `to` up to
// two trimmed non-empty strings. Anything short of that (no from, no options) omits
// swap entirely rather than emitting a half-formed action.
function cleanSwap(swap: FocusItem["swap"]): FocusItem["swap"] | undefined {
  const from = String(swap?.from ?? "").trim();
  const to = inputArray<unknown>(swap?.to)
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 2);
  return from && to.length ? { from, to } : undefined;
}
function cleanFocusItem(item: FocusItem | null): FocusItem | null {
  if (!item) return null;
  const based_on = cleanEvidence(item.based_on);
  const out: FocusItem = based_on ? { ...item, based_on } : { ...item };
  // Whitelist the swap payload through the clamp (or drop it if half-formed).
  const swap = cleanSwap(item.swap);
  if (swap) out.swap = swap;
  else delete out.swap;
  // draft_pending / recovery_active are strict boolean flags — anything else drops.
  if (out.draft_pending !== true) delete out.draft_pending;
  if (out.recovery_active !== true) delete out.recovery_active;
  if (!out.day_posture || !["rest", "easy", "done"].includes(out.day_posture)) delete out.day_posture;
  return out;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// The weekday an ISO date falls on, plain words ("Monday") — null when unparseable.
// Noon UTC so a date-only string never slips a day under a negative timezone.
function weekdayOf(iso: unknown): string | null {
  const t = Date.parse(`${String(iso ?? "").slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(t) ? WEEKDAY_NAMES[new Date(t).getUTCDay()] : null;
}

function varyOptionName(option: unknown): string | null {
  const raw = option && typeof option === "object" && "name" in option ? option.name : option;
  return raw ? String(raw) : null;
}

// ---- life/soreness awareness: don't lead with a lever that loads a flagged area ----
// A canonical muscle-group label → the injury/joint words that mean training that
// group would aggravate an active problem. Small, conservative, plain words (mirrors
// the BODY_AREAS spirit in health.ts, kept local so the conductor stays self-contained).
const GROUP_BODY_WORDS: Record<string, string[]> = {
  legs: [
    "knee",
    "quad",
    "hamstring",
    "hip",
    "glute",
    "ankle",
    "calf",
    "leg",
    "squat",
    "lunge",
    "shin",
    "patell",
    "acl",
    "mcl",
    "meniscus",
    "groin",
    "adductor",
  ],
  quads: ["knee", "quad", "leg", "squat", "patell"],
  hamstrings: ["hamstring", "knee", "hip", "leg", "posterior"],
  glutes: ["glute", "hip", "leg", "groin"],
  hips: ["hip", "glute", "groin", "adductor"],
  calves: ["calf", "calves", "ankle", "achilles", "shin"],
  back: ["back", "lumbar", "spine", "disc", "lat", "deadlift", "row", "hinge", "sciatic"],
  chest: ["chest", "pec", "sternum", "rib", "bench"],
  shoulders: ["shoulder", "delt", "rotator", "cuff", "press", "overhead", "labrum", "impingement", "ac joint"],
  arms: ["elbow", "wrist", "bicep", "tricep", "forearm", "tendon", "cubital", "tennis elbow", "golfer"],
  biceps: ["elbow", "bicep", "forearm"],
  triceps: ["elbow", "tricep"],
  core: ["back", "spine", "abdominal", "oblique", "hernia"],
};

interface FlaggedContext {
  words: string[]; // lowercased injury/sore-joint texts to match against a lever
  phrase: string; // the human name of the flagged area for the caveat line
  reduceLoad: boolean; // an active reduce-load window is on
  any: boolean;
}

// Collect the flagged/injured/sore areas the conductor must plan around: active
// (not likely-resolved) injuries + a flagged joint-pain autoregulation signal + a
// reduce-load window. Returns "" phrase and any:false when there's nothing to flag.
function flaggedContext(inp: CoachingFocusInput): FlaggedContext {
  const words: string[] = [];
  const phrases: string[] = [];
  for (const inj of inputArray<InjuryInput>(inp.injuries)) {
    if (inj?.likely_resolved) continue; // a healed injury no longer caveats
    const txt = `${lc(inj?.title)} ${lc(inj?.area)} ${lc(inj?.detail)}`.trim();
    if (txt) {
      words.push(txt);
      phrases.push(String(inj?.title || inj?.area || "an injury").trim());
    }
  }
  const jp = lc(inp.autoregulation?.joint_pain);
  if (jp) {
    words.push(jp);
    phrases.push(`${jp} (a joint you flagged)`);
  }
  const reduceLoad = !!inp.contextToday?.reduce_load;
  return { words, phrase: phrases[0] ?? "", reduceLoad, any: words.length > 0 };
}

// Does a training lever on `groupLabel` (with an optional lead lift) load one of the
// flagged areas? Matches the group's body-words against each injury text, and the
// lead-lift name directly against the injury text.
function leverLoadsFlagged(groupLabel: string, leadLift: string, flagged: FlaggedContext): boolean {
  if (!flagged.any) return false;
  const label = lc(groupLabel);
  const lift = lc(leadLift);
  const bodyWords = GROUP_BODY_WORDS[label] ?? [label].filter(Boolean);
  for (const injTxt of flagged.words) {
    if (bodyWords.some((w) => w && injTxt.includes(w))) return true;
    if (label && injTxt.includes(label)) return true;
    if (lift && injTxt.split(/\s+/).some((tok) => tok.length > 3 && lift.includes(tok))) return true;
  }
  return false;
}

// ---- candidate generation: one read per domain, each scored for internal ranking ----

const RECOVERY_WEEK_LEAD_TITLES = [
  "Take an earned recovery week",
  "A lighter week has been earned",
  "Time for a lighter recovery week",
  "An earned lighter recovery week would pay off now",
] as const;

const RECOVERY_WEEK_LEAD_WHYS = [
  "Your recent load and recovery signals say a lighter week now pays off — back volume off, keep the intensity crisp, and you'll come back stronger. This is the performance-building choice, not a step back.",
  "A lighter week now lets the work you've stacked absorb — keep the movements, ease the volume, and you'll come back ready to build.",
  "The recent stretch of loading says a reset week would pay off — keep efforts easy and crisp, and come back stronger.",
  "You've earned a lighter week. Keep the same movements, drop the working volume, and let the adaptation land.",
] as const;

const RECOVERY_WEEK_ACTIVE_TITLES = [
  "Recovery week — absorb the work",
  "Recovery week is on — let it land",
  "This is the lighter week — absorb it",
  "Recovery week — don't chase a top set",
] as const;

const RECOVERY_WEEK_ACTIVE_WHYS = [
  "This week is deliberately lighter: about half the working volume, same movements, crisp easy efforts. The adaptation you've been training for lands now — don't chase PRs, sleep big.",
  "The plan is already the lighter week — same movements, reduced working volume, easy crisp efforts. Let the work absorb.",
  "This recovery week is the lighter week you earned. Keep showing up, keep it light, and give the adaptation room.",
  "A lighter week is running: keep the frequency, cut the working volume, and sleep big so the work lands.",
] as const;

const RECOVERY_DRIFT_TITLES = [
  "Recovery is sliding",
  "Give recovery some room",
  "Recovery is asking for an easier touch",
  "Recovery has been drifting",
] as const;

const RECOVERY_DRIFT_WHYS = [
  "HRV is down while resting heart rate is up — keep the dose conservative and let recovery catch up, without rewriting the week.",
  "Recovery has been sliding. Hold the loading where it is rather than piling on, and give the next nights a chance to settle.",
  "The recovery picture is softer than it was. Keep today's work honest rather than adding more.",
  "HRV down and resting heart rate up is a nudge to stay conservative, not a rewrite of the week.",
] as const;

function recoveryCandidate(inp: CoachingFocusInput): Candidate | null {
  const meso = inp.programState?.mesocycle;
  const phase = lc(meso?.phase);
  const deloadDue = phase === "deload-due";
  const hrv = num(inp.recovery?.delta?.hrv);
  const rhr = num(inp.recovery?.delta?.rhr);
  const recoveryEvidenceIsDecisionGrade =
    recoverySignalIsDecisionGrade(inp.recovery, "hrv_ms") && recoverySignalIsDecisionGrade(inp.recovery, "resting_hr");
  const recoveringDown = recoveryEvidenceIsDecisionGrade && hrv != null && hrv < 0 && rhr != null && rhr > 2;
  const date = String(inp.signalState?.date ?? "");
  // The applied recovery week RUNNING is its own lead — a calm confirmation, no
  // action (the plan already is the lighter week), regardless of whether the
  // original trigger signals still read due.
  const active = inp.recoveryWeekActive === true;
  if (active) {
    return {
      key: "recovery-deload",
      leverage: 5,
      slot: "lead",
      noun: "the recovery week",
      item: {
        domain: "recovery",
        title: pickDayVariant(RECOVERY_WEEK_ACTIVE_TITLES, date, "cfocus:recovery-active:title"),
        why: pickDayVariant(RECOVERY_WEEK_ACTIVE_WHYS, date, "cfocus:recovery-active:why"),
        recovery_active: true,
        based_on: ["You applied the recovery week", "Back to building when the week is done"],
      },
    };
  }
  if (!deloadDue && !recoveringDown) return null;
  // recoveringDown alone no longer proposes an earned recovery week — that ask
  // needs deload-due. Without it, a quiet parallel card at most (the day-read
  // still has its own recovery voice).
  if (!deloadDue && recoveringDown) {
    return {
      key: "recovery-drift",
      leverage: 3.2,
      slot: "parallel",
      noun: "recovery",
      item: {
        domain: "recovery",
        title: pickDayVariant(RECOVERY_DRIFT_TITLES, date, "cfocus:recovery-drift:title"),
        why: pickDayVariant(RECOVERY_DRIFT_WHYS, date, "cfocus:recovery-drift:why"),
        based_on: ["HRV is down while resting HR is up"],
      },
    };
  }
  const draftPending = inp.recoveryDraftPending === true;
  const leads = coachLeads(inp);
  // The recovery lead's next-step line adapts to posture. Under LEAD mode the coach
  // sets the recovery week up itself at the week boundary, so the line speaks STATE
  // — never a one-tap ask — and names the weekday when an upcoming recovery/structure
  // decision is already scheduled. Off lead mode, the athlete drives it: a waiting
  // draft points at the review, an un-drafted one leaves the button to the surface.
  let move: string | undefined;
  if (leads) {
    // Only a decision STRUCTURALLY marked recovery may claim "lands Monday" — the
    // domain is stamped at write time (proposalShape recognizes the canonical
    // recovery-week instruction), never inferred from agent prose, so an unrelated
    // restructure whose summary happens to say "lighter" can't trip it.
    const soon = inputArray<UpcomingDecisionInput>(inp.upcoming).find((d) => lc(d?.domain) === "recovery");
    const weekday = soon ? weekdayOf(soon.effective_date) : null;
    if (draftPending) {
      move = weekday
        ? `Recovery week is queued — it lands ${weekday}. Undo any time from Plan.`
        : "Recovery week is queued — it lands automatically. Undo any time from Plan.";
    } else {
      // The scheduler's recovery auto-draft (lead mode + background coaching on,
      // ≤1×/day) is what makes the undrafted copy honest — the coach genuinely
      // will set this up on its own.
      move = weekday
        ? `A lighter recovery week lands ${weekday} — your coach set it up; undo any time from Plan.`
        : "Your coach sets this up automatically at the week boundary.";
    }
  } else if (draftPending) {
    // Off lead mode, once the one-tap draft has landed the lead speaks STATE
    // ("drafted, review it") instead of re-offering the same action.
    move = "Your recovery week is drafted — review and apply it when you're ready.";
  }
  return {
    key: "recovery-deload",
    leverage: 5,
    slot: "lead",
    noun: "an earned lighter week",
    item: {
      domain: "recovery",
      title: pickDayVariant(RECOVERY_WEEK_LEAD_TITLES, date, "cfocus:recovery-lead:title"),
      why:
        (meso?.note ? String(meso.note) : "") ||
        pickDayVariant(RECOVERY_WEEK_LEAD_WHYS, date, "cfocus:recovery-lead:why"),
      // draft_pending drives the review LINK (navigation) on every posture; the move
      // copy above is what changes between lead mode and the athlete-driven surfaces.
      ...(draftPending ? { draft_pending: true } : {}),
      ...(move ? { move } : {}),
      based_on: [
        "Mesocycle says deload is due",
        recoveringDown ? "HRV is down while resting HR is up" : "Recent training load has accumulated",
      ],
    },
  };
}

// The coach owns the actions only when it can genuinely act unattended: lead
// posture AND background coaching on. Proactive off means no scheduler ticks —
// promising "your coach sets this up automatically" would be a lie, so the
// athlete-driven asks come back.
function coachLeads(inp: CoachingFocusInput): boolean {
  return lc(inp.leadMode) === "lead" && inp.proactiveEnabled !== false;
}

function trainingCandidate(inp: CoachingFocusInput): Candidate | null {
  const flagged = flaggedContext(inp);
  // When the coach leads it rotates at the boundary itself, so the conductor emits
  // no one-tap swap payload (`acts` false). Otherwise the athlete drives the swap.
  const acts = !coachLeads(inp);
  // Membership is judged by movement SLOT (movementKey strips implement tokens),
  // the same ladder applyPlanSwap resolves with — a lift still on the plan under a
  // different implement spelling ("DB Bench Press" vs a logged "Dumbbell Bench
  // Press") must read as programmed, or a live plateau lead silently vanishes.
  const plannedKeys = new Set(
    inputArray<unknown>(inp.plannedNames)
      .map((n) => movementKey(String(n ?? "")))
      .filter(Boolean)
  );
  const rotations = inputArray<AppliedRotationInput>(inp.recentRotations);
  // A genuinely STALLED canonical group with a concrete swap menu is the most
  // coach-like training lead (the athlete's own "which groups stall" framing).
  const groups = inputArray<MuscleGroupTrajectoryInput>(inp.groupsTrajectory?.groups);
  const stalled = groups.find((g) => lc(g?.verdict) === "stalling" && (g?.lead_lift || g?.label));
  if (stalled) {
    const leadLift = String(stalled.lead_lift ?? "").trim();
    const leadLiftLc = lc(leadLift);
    const label = lc(stalled.label || stalled.group);
    // A plateau the brain already HANDLED (a matching applied rotation) or a stalled
    // lift that's off every plan day is not a live lead — fall through to the
    // capacity laggard so training can still lead on something real. The handled
    // rotation speaks separately via rotationHandledCandidate (a calm parallel note),
    // so this producer never re-offers the swap that just happened.
    const rotation = leadLiftLc ? rotations.find((r) => lc(r?.from) === leadLiftLc) : undefined;
    const unprogrammed = plannedKeys.size > 0 && leadLift !== "" && !plannedKeys.has(movementKey(leadLift));
    if (!rotation && !unprogrammed) {
      // vary_options are {name, why} objects — pull the movement NAME (a bare
      // String(o) renders "[object Object]"). Tolerate a plain-string option too.
      const opts = inputArray<unknown>(stalled.vary_options)
        .slice(0, 2)
        .map(varyOptionName)
        .filter((name): name is string => name != null);
      const conflicts = leverLoadsFlagged(label, leadLift, flagged);
      const caveat = conflicts
        ? `Ease this AROUND the ${flagged.phrase || "flagged area"} — work the plateau with pain-free variations only, don't push loaded reps through it.`
        : undefined;
      return {
        key: "training-stall",
        leverage: 4.2,
        slot: "lead",
        noun: `the ${label} plateau`,
        caveat,
        item: {
          domain: "training",
          title: `Break the plateau on your ${label}`,
          why: `${leadLift || label} has stalled${stalled.stalled_signal ? ` (${lc(stalled.stalled_signal)})` : ""} — change the stimulus rather than grinding the same load.${caveat ? ` (${caveat})` : ""}`,
          // The move line matches who acts: the athlete-directed "Rotate in X" only
          // rides with real buttons; when the coach leads, it speaks STATE (the
          // data-triggered evolution drafts the rotation and it lands via autonomy).
          move: acts
            ? opts.length
              ? `Rotate in ${opts.join(" or ")} for a few weeks.`
              : undefined
            : "Your coach will rotate a fresh variation in at the next natural boundary.",
          based_on: [
            `${leadLift || label} is marked stalling`,
            stalled.stalled_signal ? `Stall signal: ${stalled.stalled_signal}` : "Muscle-group trajectory is flat",
          ],
          // Actionable payload: a concrete lift to rotate out + same-pattern options to
          // rotate in. Only when actions are offered (non-lead mode), we know WHICH lift
          // stalled, and have real options — the surface resolves the plan day (the
          // conductor never touches the DB).
          swap: acts && leadLift && opts.length ? { from: leadLift, to: opts } : undefined,
        },
      };
    }
  }
  // The capacity laggard (the one lift furthest behind for the athlete's age).
  const lever = inp.performance?.lever;
  if (lever?.headline) {
    const conflicts = leverLoadsFlagged(String(lever.headline), String(lever.target ?? ""), flagged);
    const caveat = conflicts
      ? `Ease this AROUND the ${flagged.phrase || "flagged area"} — pain-free work only until it settles.`
      : undefined;
    // The lever in values: the lift's est-1RM, its distance to the next standard and
    // its logged trend — so the card moves when the lift does, rather than restating
    // the same standing every week.
    const lifted = leverLift(inp);
    const facts = lifted ? leverFacts(lifted, unitsOfInput(inp)) : "";
    const baseWhy = String(
      lever.why || "Focused volume on your furthest-behind lift is where the easiest, most motivating progress is."
    );
    const why = facts ? wholeSentences(`${facts} ${baseWhy}`, LEVER_WHY_MAX) : baseWhy;
    // What the block's phase asks of this lift THIS week (the progression policy, in
    // words), then the standing target.
    const block = blockRead(inp)?.read ?? null;
    const phaseMove = phaseMoveFor(block?.phase ?? null, lifted?.label ?? "", block?.deload === "set_aside");
    const target = lever.target ? `Target: ${String(lever.target).replace(/\.$/, "")}.` : "";
    const move = [phaseMove, target].filter(Boolean).join(" ");
    const hero = String(inp.performance?.hero?.headline ?? "").trim();
    return {
      key: "training-lever",
      leverage: 3.8,
      slot: "lead",
      noun: String(lever.headline)
        .replace(/^bring up\s+/i, "")
        .trim()
        .replace(/^./, (c) => c.toLowerCase()),
      defer: "Waits behind this week's lead; the lift keeps its normal progression meanwhile.",
      caveat,
      item: {
        domain: "training",
        title: String(lever.headline),
        why: `${why}${caveat ? ` (${caveat})` : ""}`,
        move: move || undefined,
        // The strength-standing line is a SUPPORTING fact here, where strength is the
        // lever — never the card's headline.
        based_on: [
          "Performance standing lever",
          hero || (lever.why ? String(lever.why) : "Capacity comparison across lifts"),
        ],
      },
    };
  }
  return null;
}
const LEVER_WHY_MAX = 260;

// A plateau the brain already rotated a variation in for — its own producer so the
// calm "new stimulus" note rides ALONGSIDE whatever training lead is live (the
// capacity laggard, a later stall) instead of silently replacing it.
function rotationHandledCandidate(inp: CoachingFocusInput): Candidate | null {
  const rotations = inputArray<AppliedRotationInput>(inp.recentRotations);
  if (!rotations.length) return null;
  const groups = inputArray<MuscleGroupTrajectoryInput>(inp.groupsTrajectory?.groups);
  for (const group of groups) {
    if (lc(group?.verdict) !== "stalling") continue;
    const leadLift = String(group?.lead_lift ?? "").trim();
    const leadLiftLc = lc(leadLift);
    if (!leadLiftLc) continue;
    const rotation = rotations.find((r) => lc(r?.from) === leadLiftLc);
    if (!rotation) continue;
    const label = lc(group.label || group.group);
    const to = String(rotation.to ?? "").trim();
    const on = String(rotation.date ?? "").slice(0, 10);
    return {
      key: "training-stall-handled",
      leverage: 2.2,
      slot: "parallel",
      noun: `the new ${label} stimulus`,
      defer: "Give the new variation a few weeks to read before judging it.",
      item: {
        domain: "training",
        title: `New stimulus in for your ${label}`,
        why: `${leadLift || "Your main lift"} stalled, so ${to || "a fresh variation"} rotated in — give it a few weeks to read before judging it.`,
        based_on: [
          `${leadLift || label} was rotated out`,
          on ? `Rotated in on ${on}` : `${to || "A variation"} is the new stimulus`,
        ],
      },
    };
  }
  return null;
}

function runningCandidate(inp: CoachingFocusInput): Candidate | null {
  const goal = inp.enduranceGoal;
  const end = inp.performance?.endurance;
  const race = raceRead(inp);
  const phase = lc(goal?.phase) || (race?.phase ?? "");
  const role = enduranceRole(inp);
  const raceActive = activeRace(inp) || race != null;
  // A dated race in build/sharpen/taper is time-bound — high leverage, lead-eligible.
  // (getEnduranceGoal discriminates on `is_race`/`mode`, never a `kind` field.)
  if ((goal?.is_race || race != null) && (phase === "build" || phase === "sharpen" || phase === "taper")) {
    const legacyRaceLead = role === "none" && lc(inp.trainingIntent?.source) !== "explicit";
    const leadEligible = role === "primary" || role === "co_primary" || legacyRaceLead;
    // The peak, taper and race weeks are SHAPED by the race — the stress budget trims
    // the legs and the week is built around the key runs — so for those weeks even a
    // supporting race is the week's lever. Earlier, it rides alongside.
    const shapesWeek = raceShapesTheWeek(race) && (role !== "none" || legacyRaceLead);
    // Inside the final six weeks a supporting race outranks the generic parallels.
    const closing = race?.daysTo != null && race.daysTo <= 42;
    const leverage = shapesWeek ? 4.3 : leadEligible ? 4.0 : role === "supporting" ? (closing ? 3.7 : 3.2) : 3.0;
    const slot: Candidate["slot"] = shapesWeek || leadEligible ? "lead" : "parallel";
    if (race) {
      const said = raceItem(race);
      return {
        key: "running-race",
        leverage,
        slot,
        noun: said.noun,
        defer: `The runs keep their days this week; ${said.noun} takes the lead from the peak week.`,
        item: {
          domain: "running",
          title: clip(said.title, 90),
          why: clip(said.why || inp.runPlan?.why || "", 260),
          move: said.move ? clip(said.move, 240) : undefined,
          based_on: [
            `Race goal is in ${phase} phase`,
            race.current?.focus_short
              ? `Race build this week: ${String(race.current.focus_short)}`
              : "Race build is available",
          ],
        },
      };
    }
    return {
      key: "running-race",
      leverage,
      slot,
      noun: "the race build",
      item: {
        domain: "running",
        title: phase === "sharpen" ? "Sharpen for your race" : "Build toward your race",
        why:
          (inp.runPlan?.why ? String(inp.runPlan.why) : "") ||
          `You're in the ${phase} phase — this week's mix matters: the quality session drives fitness, the long run builds durability, the easy runs protect recovery.`,
        move: inp.runPlan?.quality_focus ? `This week's quality focus: ${lc(inp.runPlan.quality_focus)}.` : undefined,
        based_on: [
          `Race goal is in ${phase} phase`,
          inp.runPlan?.quality_focus
            ? `Run plan quality focus: ${inp.runPlan.quality_focus}`
            : "Weekly run plan is available",
        ],
      },
    };
  }
  // A low aerobic base is the single biggest endurance + longevity lever.
  if (lc(end?.tone) === "watch") {
    if (role === "none") return null;
    return {
      key: "running-aerobic",
      noun: "your aerobic base",
      leverage: 3.6,
      slot: role === "primary" || role === "co_primary" ? "lead" : "parallel",
      item: {
        domain: "running",
        title: "Lift your aerobic base",
        why: "VO2max is the biggest single lever you have for both endurance and longevity — one weekly quality session moves it while the easy runs build the engine underneath.",
        move: inp.runPlan?.quality_focus ? `Start with ${lc(inp.runPlan.quality_focus)} this week.` : undefined,
        based_on: [
          "Performance endurance read is watch-level",
          inp.runPlan?.quality_focus
            ? `Run plan quality focus: ${inp.runPlan.quality_focus}`
            : "Aerobic base is the limiting lever",
        ],
      },
    };
  }
  // Otherwise the week's quality run rides alongside whatever leads (a parallel item).
  if ((role !== "none" || raceActive) && inp.runPlan?.available && inp.runPlan?.quality_focus) {
    return {
      key: "running-quality",
      noun: "the week's quality run",
      leverage: 2.4,
      slot: "parallel",
      item: {
        domain: "running",
        title: `This week's quality run: ${lc(inp.runPlan.quality_focus)}`,
        why: clip(
          inp.runPlan.why || inp.runPlan.mix_summary || "Keep the easy runs easy so the one quality session lands.",
          200
        ),
        based_on: ["Weekly run plan is available", `Quality focus: ${inp.runPlan.quality_focus}`],
      },
    };
  }
  return null;
}

function capacityCandidate(inp: CoachingFocusInput): Candidate | null {
  const capacity = inp.enduranceCapacity;
  const role = enduranceRole(inp);
  const status = lc(capacity?.status);
  if (role === "none" || !["building", "rebuilding", "no_data"].includes(status)) return null;
  const sport = String(capacity?.sport ?? "endurance").trim();
  const target = num(capacity?.target_duration_min);
  const title =
    status === "rebuilding"
      ? `Rebuild your ${sport} capacity`
      : status === "no_data"
        ? `Establish your ${sport} capacity`
        : `Build your ${sport} capacity`;
  return {
    key: "endurance-capacity",
    noun: `your ${sport} capacity`,
    leverage: role === "primary" ? 3.7 : role === "co_primary" ? 3.5 : 2.3,
    slot: role === "primary" || role === "co_primary" ? "lead" : "parallel",
    item: {
      domain: "running",
      title,
      why: clip(
        capacity?.summary ||
          (target
            ? `The durable target is an outing around ${Math.round(target)} minutes.`
            : "The durable capability needs a calm next exposure."),
        220
      ),
      move: capacity?.next_step ? clip(capacity.next_step, 240) : undefined,
      based_on: [
        `Endurance role: ${role.replace("_", " ")}`,
        target ? `Durable capability: ${Math.round(target)} minutes of ${sport}` : "Durable endurance capability",
      ],
    },
  };
}

function healthCandidate(inp: CoachingFocusInput): Candidate | null {
  const lead = inp.healthFocus?.lead;
  if (!lead?.group) return null;
  const actNow = lc(lead.tier) === "act_now";
  const moves: HealthFocusMovesInput = lead.moves ?? {};
  const viaNutrition = !!moves.nutrition;
  // The finding in the lab's own values and directions (never an impact_score), then
  // the health engine's own sentence about why they belong together.
  const readings = flaggedReadings(lead, 2);
  const valuesLine = readings.length
    ? `${joinAnd(readings.map(readingPhrase))} sit${readings.length === 1 ? "s" : ""} outside the optimal band.`
    : "";
  const engineWhy = String(lead.why || inp.healthFocus?.headline || "").trim();
  const why = [valuesLine, engineWhy ? `${engineWhy.replace(/[.\s]+$/, "")}.` : ""].filter(Boolean).join(" ");
  // The engine's own move when it has one; otherwise the group's everyday lever, so the
  // card never names a finding without saying what is in the athlete's hands.
  const engineMove = moves.nutrition || moves.training || moves.watch;
  const move = engineMove ? String(engineMove) : healthFallbackMove(lc(lead.group));
  const group = lc(lead.group);
  return {
    key: "health-lead",
    leverage: actNow ? 4.0 : 2.6,
    noun: `your ${group.split(/\s*&\s*|\s+and\s+/)[0] || group}`,
    defer: "Tracked; the next panel shows its direction.",
    // Health is usually addressed through diet/lifestyle, so it runs PARALLEL to
    // training rather than displacing it — but a true act_now with no training lead
    // can be promoted to lead by the selector below.
    slot: "parallel",
    item: {
      domain: viaNutrition ? "nutrition" : "health",
      title: `Move your ${group}`,
      why: clip(why, 260),
      move: move ? clip(`${move.replace(/[.\s]+$/, "")}. Informational, not medical advice.`, 260) : undefined,
      based_on: [`Health lead: ${lead.group}`, lead.tier ? `Tier: ${lead.tier}` : "Connected-brain health focus"],
    },
  };
}

// The everyday lever per health group, for a finding the health engine named without a
// move. Food and training habits only — never a drug, a dose or a supplement; the
// clinical call stays with the athlete and their clinician.
function healthFallbackMove(group: string): string {
  if (/lipid|cholesterol|cardio/.test(group))
    return "The food lever is yours: soluble fiber and oily fish most days, fewer saturated fats — the next lipid panel shows whether it's landing";
  if (/inflamm/.test(group))
    return "Sleep, keeping easy days easy and oily fish are the everyday levers; a recheck shows the direction";
  if (/glucose|metabolic/.test(group))
    return "Fiber first at meals and a walk after the biggest one are the everyday levers; the next panel shows the direction";
  return "Worth raising at your next clinician visit; the next panel shows the direction";
}

function dexaCandidate(inp: CoachingFocusInput): Candidate | null {
  const d = inp.dexa;
  if (!d?.available || !d.lead) return null;
  // If the performance lever already promoted THIS DEXA signal to the training lead
  // (a training-domain bone/lean target), don't also surface it as a parallel item —
  // the conductor's whole job is to dedupe a finding across domains, not echo it.
  if (lc(inp.performance?.lever?.headline).startsWith("from your dexa")) return null;
  const t = d.lead;
  const sig = lc(t.signal);
  const bone = /bmd|bone|osteo|t-?score|z-?score/.test(sig) || /bone|bmd/.test(lc(t.area));
  const visceral = /visceral|android|trunk|central/.test(sig) || lc(t.domain) === "nutrition";
  const domain: FocusDomain = visceral ? "nutrition" : bone ? "health" : "training";
  return {
    key: "dexa-lead",
    noun: "your DEXA target",
    leverage: bone ? 3.4 : visceral ? 2.8 : 2.6,
    slot: "parallel",
    item: {
      domain,
      title: `From your DEXA: ${clip(t.area, 60)}`,
      why: clip(t.bias || t.signal || "", 220),
      move: t.path ? clip(t.path, 240) : undefined,
      based_on: ["Latest DEXA targeting read", t.signal ? `Signal: ${t.signal}` : `Area: ${t.area}`],
    },
  };
}

function bodyCandidate(inp: CoachingFocusInput): Candidate | null {
  if (lc(inp.goalMode) !== "lose") return null;
  const lean =
    "Keep the deficit modest and protein high so the weight that comes off is fat, not the muscle you're working to build.";
  const w = weightRead(inp);
  if (!w) {
    return {
      key: "body-deficit",
      leverage: 2.0,
      slot: "parallel",
      noun: "the cut",
      item: {
        domain: "nutrition",
        title: "Hold a lean-safe deficit",
        why: lean,
        based_on: ["Goal mode is fat loss", "Nutrition target is lean-safe"],
      },
    };
  }
  // The cut in values against the line to the goal — information, never a verdict.
  const relation = paceRelation(w);
  // In the athlete's weight unit, with the one weight-trend read's figures.
  const units = unitsOfInput(inp);
  const trendWords = w.trend != null ? `, trending ${weightRateWords(w.trend, units.weight)}` : "";
  const lineWords =
    w.goalLb != null && w.goalDate && w.needed != null
      ? ` Reaching ${weightWords(w.goalLb, units.weight)} by ${shortDate(w.goalDate)} asks about ${weightRateWords(w.needed, units.weight)}${
          relation === "on"
            ? " — the trend is on that line."
            : relation === "ahead"
              ? " — the trend is running ahead of that line."
              : relation === "behind"
                ? " — the trend runs a little slower than that line."
                : "."
        }`
      : "";
  const cq = inp.cutQuality;
  const considered = num(cq?.strength?.considered);
  const holding = num(cq?.strength?.holding);
  const liftsWords =
    cq?.active === true && considered != null && considered >= 3 && holding != null
      ? ` ${holding} of ${considered} main lifts are holding or climbing as it comes down.`
      : "";
  // Long runs ahead change WHERE the deficit sits, not whether it exists.
  const race = raceRead(inp);
  const longRunsAhead = race?.maxLongKmAhead != null && race.maxLongKmAhead >= 14;
  const move = longRunsAhead
    ? "Fuel the long runs and the day after; let the deficit sit on the lighter days."
    : relation === "on"
      ? "Nothing to change — the trend, not one weigh-in, decides any adjustment."
      : "Keep the deficit modest; the two-week trend, not one weigh-in, decides any change.";
  return {
    key: "body-deficit",
    leverage: relation === "on" ? 2.2 : 2.8,
    slot: "parallel",
    noun: "the cut",
    defer:
      relation === "on"
        ? "On pace — nothing to change this week."
        : "Rides with the lead; the trend decides any change, not one weigh-in.",
    item: {
      domain: "nutrition",
      title: relation === "on" ? "The cut is on pace — hold it" : "Hold a lean-safe deficit",
      why: clip(
        `${weightWords(w.latest, units.weight)} now${trendWords}.${lineWords}${liftsWords} ${lean}`.replace(/\s+/g, " ").trim(),
        300
      ),
      move,
      based_on: [
        "Goal mode is fat loss",
        w.trend != null ? `Weight trend ${weightRateWords(w.trend, units.weight)}` : "Weigh-ins logged",
      ],
    },
  };
}

// ---- external producers (K3): adapt each read to the shared FocusCandidate ----
// The 4 producers named by the v1 plan flow through the SAME arbitration as the
// domain candidates above. They emit the plain `FocusCandidate` contract; `lift`
// is the SOLE place a leverage/slot is assigned to them (a producer never scores
// itself). Their source modules are untouched — the orchestrator (coach.ts) supplies
// the reads via input so this stays a pure function.

// Lift a plain FocusCandidate into the conductor's internal, rankable Candidate.
function lift(fc: FocusCandidate, leverage: number, slot: Candidate["slot"], key?: string): Candidate {
  const based_on = cleanEvidence(fc.priority_inputs);
  return {
    key: key ?? fc.kind,
    leverage,
    slot,
    item: {
      domain: fc.domain,
      title: clip(fc.headline, 90),
      why: clip(fc.why, 240),
      move: fc.move ? clip(fc.move, 240) : undefined,
      based_on,
    },
  };
}

interface RiskEnhancerInput {
  key?: unknown;
  label?: unknown;
  lever?: unknown;
}
// The cardiovascular risk read (cardiovascularRiskRead) → one health/nutrition lever.
// A clinical risk % is allowed (it's an evidence-defined, patient-facing number, NOT a
// banned internal 0-100 grade); always framed informational-not-medical-advice with the
// modifiable lever named. Elevated + computed → lead-eligible; else a parallel nudge.
function riskCandidate(inp: CoachingFocusInput): Candidate | null {
  const risk = inp.cardioRisk as any;
  if (!risk || typeof risk !== "object") return null;
  const est = risk.prevent?.estimates ?? null;
  const ascvd10 = num(est?.ascvd?.ten_year);
  const totalCvd10 = num(est?.total_cvd?.ten_year);
  const primary10 = ascvd10 ?? totalCvd10;
  const enhancers = inputArray<RiskEnhancerInput>(risk.enhancers);
  // Nothing computable AND no modifiable enhancer to name → stay silent.
  if (primary10 == null && !enhancers.length) return null;
  const topEnh = enhancers[0] ?? null;
  const enhKey = lc(topEnh?.key);
  const domain: FocusDomain = enhKey === "body_fat" ? "nutrition" : enhKey === "vo2max" ? "running" : "health";
  const vascular = num(risk.prevent?.vascular_age);
  const elevated = primary10 != null && primary10 >= 7.5;
  const leverage = elevated ? 3.7 : primary10 != null ? 2.8 : 2.4;
  const slot: Candidate["slot"] = elevated ? "lead" : "parallel";
  const whyBits: string[] = [];
  if (primary10 != null) {
    whyBits.push(
      `AHA PREVENT puts your 10-year ${ascvd10 != null ? "ASCVD" : "cardiovascular"} risk around ${primary10}%${vascular != null ? ` (heart age ~${vascular})` : ""}`
    );
  }
  if (topEnh?.label) whyBits.push(`${lc(topEnh.label)} is the main modifiable lever`);
  const why = `${clip(whyBits.join(" — ") || "Your cardiovascular levers are worth a look.", 200)} Informational, not medical advice.`;
  const fc: FocusCandidate = {
    domain,
    kind: "risk-cardiovascular",
    headline: elevated ? "Lower your cardiovascular risk" : "Keep your cardiovascular risk low",
    why,
    move: topEnh?.lever ? String(topEnh.lever) : undefined,
    priority_inputs: [
      "AHA PREVENT 2023 risk read",
      ...enhancers
        .slice(0, 2)
        .map((e) => String(e?.label ?? ""))
        .filter(Boolean),
    ],
    action: { kind: "open_health", label: "Open cardiovascular risk" },
  };
  return {
    ...lift(fc, leverage, slot, "risk-cardiovascular"),
    noun: "cardiovascular risk",
    defer: "Moves with the lipid and aerobic work already on the card.",
  };
}

interface JourneyMilestoneInput {
  label?: unknown;
  detail?: unknown;
  kind?: unknown;
  priority?: unknown;
}
// A body-composition journey milestone (journeyMilestones) → a calm parallel note.
// Celebrations stay quiet, one at a time (constitution); low leverage so it never
// crowds a real lever, but it's arbitrated through the one conductor like everything else.
function journeyCandidate(inp: CoachingFocusInput): Candidate | null {
  const ms = inputArray<JourneyMilestoneInput>(inp.journeyMilestones);
  if (!ms.length) return null;
  const top = [...ms].sort((a, b) => (num(b.priority) ?? 0) - (num(a.priority) ?? 0))[0];
  if (!top?.label) return null;
  const domain: FocusDomain = lc(top.kind).includes("bodyfat") ? "body" : "nutrition";
  const fc: FocusCandidate = {
    domain,
    kind: "journey-milestone",
    headline: String(top.label),
    why: top.detail
      ? String(top.detail)
      : "A milestone on your journey worth a quiet nod — keep the approach that got you here.",
    priority_inputs: ["Body-composition journey milestone"],
    action: { kind: "open_progress", label: "See your journey" },
  };
  return { ...lift(fc, 2.0, "parallel", "journey-milestone"), noun: "a body-composition milestone" };
}

interface BenchmarkMilestoneInput {
  title?: unknown;
  why?: unknown;
  suggested_test?: unknown;
  target?: unknown;
  priority?: unknown;
}
// A strength/endurance benchmark milestone (benchmarkMilestones) → a training lever
// within reach of a recognized standard. A motivating near-term target, arbitrated as
// a parallel item (it rides alongside whatever leads).
function benchmarkCandidate(inp: CoachingFocusInput): Candidate | null {
  const ms = inputArray<BenchmarkMilestoneInput>(inp.benchmarkMilestones);
  if (!ms.length) return null;
  const top = [...ms].sort((a, b) => (num(b.priority) ?? 0) - (num(a.priority) ?? 0))[0];
  if (!top?.title) return null;
  const move = top.suggested_test
    ? String(top.suggested_test)
    : top.target
      ? `Target: ${clip(top.target, 120)}`
      : undefined;
  const fc: FocusCandidate = {
    domain: "training",
    kind: "benchmark-milestone",
    headline: String(top.title),
    why: top.why ? String(top.why) : "You're within reach of a recognized standard — a motivating near-term target.",
    move,
    priority_inputs: ["Strength/endurance benchmark read"],
    action: { kind: "open_progress", label: "See your benchmarks" },
  };
  return {
    ...lift(fc, 2.0, "parallel", "benchmark-milestone"),
    noun: lc(top.title),
    defer: "Within reach on the normal progression — no test needed to get there.",
  };
}

function laterCandidates(inp: CoachingFocusInput): Candidate[] {
  const out: Candidate[] = [];
  // Mono-stimulus running → add variety, but only once the lead/parallel is set.
  if ((enduranceRole(inp) !== "none" || activeRace(inp)) && inp.runVariety?.note) {
    out.push({
      key: "later-run-variety",
      leverage: 1.6,
      slot: "later",
      item: {
        domain: "running",
        title: "Add variety to your runs",
        why: clip(inp.runVariety.note, 180),
        based_on: ["Run variety read"],
      },
    });
  }
  // A second stalled/building group beyond the lead.
  const groups = inputArray<MuscleGroupTrajectoryInput>(inp.groupsTrajectory?.groups);
  const stalledOthers = groups.filter((g) => lc(g?.verdict) === "stalling");
  if (stalledOthers.length > 1) {
    const g = stalledOthers[1];
    out.push({
      key: "later-group",
      leverage: 1.5,
      slot: "later",
      item: {
        domain: "training",
        title: `Then revisit your ${lc(g.label || g.group)}`,
        why: "Address it after the lead lift is moving again — one plateau at a time.",
        based_on: ["Another muscle group is stalling"],
      },
    });
  }
  // The widest strength imbalance (rounding-out work, deferred).
  const imb = inputArray<PerformanceImbalanceInput>(inp.performance?.imbalances)[0] ?? null;
  if (imb?.title) {
    out.push({
      key: "later-imbalance",
      leverage: 1.4,
      slot: "later",
      item: {
        domain: "training",
        title: clip(imb.title, 60),
        why: clip(imb.why || "", 180),
        based_on: ["Performance imbalance read"],
      },
    });
  }
  // A "due" muscle group from the balance digest.
  const dueAdj = inputArray<ProgramAdjustmentInput>(inp.programAdjustments).find(
    (a) => a?.kind === "balance" && /due/i.test(String(a?.title || ""))
  );
  if (dueAdj) {
    out.push({
      key: "later-due",
      leverage: 1.3,
      slot: "later",
      item: {
        domain: "training",
        title: clip(dueAdj.title, 60),
        why: clip(dueAdj.why || "", 180),
        based_on: ["Program adjustment digest"],
      },
    });
  }
  return out;
}

// ---- the cross-domain connections: how an elite coach ties the levers together ----

function buildConnections(lead: FocusItem | null, parallel: FocusItem[], inp: CoachingFocusInput): string[] {
  const out: string[] = [];
  const all = [lead, ...parallel].filter(Boolean) as FocusItem[];
  const has = (d: FocusDomain) => all.some((x) => x.domain === d);
  const titles = all.map((x) => lc(x.title)).join(" ");
  const race = raceRead(inp);

  // The strength lever against the race build: an upper-body lever keeps progressing
  // straight through the peak and taper (the race trims only the legs —
  // race-strength.ts); a lower-body one holds in the taper and resumes after race day.
  if (lead?.domain === "training" && race && lc(lead.title) === lc(inp.performance?.lever?.headline)) {
    const lever = leverLift(inp);
    const taperAhead = blockRead(inp)?.read.race_taper_from ?? null;
    if (lever && (taperAhead || raceShapesTheWeek(race))) {
      const name = lc(lever.label);
      out.push(
        lever.upper
          ? `The ${name} is upper-body work, so it keeps progressing through the peak and taper — the ${race.distanceName} only trims the legs.`
          : `The ${name} loads the legs the ${race.distanceName} needs: it holds lighter through the taper and race week, then picks back up after race day.`
      );
    }
  }
  // The race leads: how the lifting fits THIS race week, in the race build's own words.
  if (lead?.domain === "running" && race?.current?.with_lifting) {
    out.push(String(race.current.with_lifting));
  }
  // A habitual hard ride the day before the long run is the athlete's week, not a
  // conflict — the race build already wrote the one sentence about it.
  if (
    race?.ride?.placement &&
    race.longRunDay != null &&
    race.ride.dayNumber != null &&
    race.ride.dayNumber + 1 === race.longRunDay
  ) {
    out.push(race.ride.placement);
  }

  // Lipids/metabolic via diet, while a deficit is also running → one change, two wins.
  if (
    has("nutrition") &&
    /lipid|cholesterol|apob|glucose|hba1c|triglyceride|metabolic/.test(
      `${titles} ${lc(inp.healthFocus?.lead?.group)}`
    ) &&
    lc(inp.goalMode) === "lose"
  ) {
    out.push(
      "The higher-fiber, oily-fish eating that runs your deficit is the same lever that moves your lipids — one change, two wins."
    );
  }
  // Aerobic work doubles as the biggest longevity lever.
  if (has("running")) {
    out.push(
      "Your aerobic work is doing double duty here — it's race/endurance fitness AND the single biggest longevity lever you have."
    );
  }
  // DEXA-flagged low lean ↔ the leg/strength work that's leading.
  if (has("training") && inp.dexa?.available && /lean/.test(lc(inp.dexa?.lead?.signal))) {
    out.push(
      "The strength work leading this block also rebuilds the lean mass your DEXA flagged — same effort, two payoffs."
    );
  }
  // Strength leads, running rides alongside as easy volume.
  if (lead?.domain === "training" && has("running") && out.length < 2) {
    out.push(
      "Strength leads this block; the running sits alongside as mostly-easy aerobic volume so it builds you without stealing recovery from the lifts."
    );
  }
  return out.slice(0, 2);
}

// ---- the unified retest checkpoint (batched, not four separate nag feeds) ----

interface DueAttentionInput {
  signal_key?: unknown;
  domain?: unknown;
  reason?: unknown;
}
// A due TRAINING re-test entry (listDueAttention / K5) → a short, readable lift label.
// Lab / DEXA rows never come through here: they read by their marker's own canonical
// name (labRecheckLabel), so "marker:hs-crp" is "hs-CRP", never "Hs Crp".
function attentionLabel(e: DueAttentionInput): string | null {
  const tail =
    String(e?.signal_key ?? "")
      .split(":")
      .pop() ?? "";
  const label = tail.replace(/[-_]+/g, " ").trim();
  if (!label) return null;
  return label.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildRetest(inp: CoachingFocusInput): CoachingRetest | null {
  const focus: string[] = [];
  let dueNow = !!inp.testWeek?.due;
  if (inp.testWeek?.due) {
    for (const l of inputArray<unknown>(inp.testWeek.key_lifts)) focus.push(String(l));
  }
  for (const t of inputArray<EnduranceTestInput>(inp.enduranceTests)) {
    if (t?.exercise) focus.push(String(t.exercise));
  }
  for (const t of inputArray<PerformanceTestDueInput>(inp.performance?.tests_due)) {
    if (t?.exercise && t.kind !== "endurance") focus.push(String(t.exercise));
  }
  // K5: the due labs / DEXA / lift re-checks that the adaptive attention engine
  // surfaces batch into this SAME checkpoint, so it's one calm draw + re-test window
  // rather than four separate nag feeds ("worth one visit: ferritin, lipids, squat").
  // A "that change hasn't landed" follow-up shares the attention schedule but is
  // not something to re-test, and it must not be what makes the checkpoint read
  // as due. It has its own calm line elsewhere.
  // The sensor baseline-recheck offer (repo/sensor-recheck.ts) rides the same
  // schedule but is NOT a test to book: it is an optional "one night would sharpen
  // this" that already has its own quiet card, and `attentionLabel` would render
  // its key as the words "Sensor Recheck" — machinery, at the athlete. It is
  // written with a forward due date and so should never reach here; excluding it
  // by key makes that a stated rule rather than a coincidence of another module.
  // The labs and the lifts are two lists in that one window: a lab is a draw to
  // book, a lift is a set to work up to, and a marker named inside a run of lift
  // names reads as one more lift. Only the doctor loop's own rows (marker cadence,
  // directive recheck, review follow-up, DEXA) are labs; only training / running rows
  // are re-tests. Anything else on the schedule (a goal check-in, a measurement
  // nudge) has its own quiet card and is not a test to book, so it neither lists
  // here nor makes the window read as due.
  const labs: string[] = [];
  const dueAttention = inputArray<DueAttentionInput>(inp.dueAttention).filter(
    (e) =>
      !String(e?.signal_key ?? "").includes(":change-check:") &&
      !String(e?.signal_key ?? "").startsWith("recovery:sensor-recheck")
  );
  for (const e of dueAttention) {
    if (isDoctorLoopSignal(e?.signal_key)) {
      const label = labRecheckLabel(e?.signal_key) ?? followupLabel(e?.reason);
      if (!label) continue;
      dueNow = true; // something is already due
      labs.push(label);
    } else if (e?.domain === "training" || e?.domain === "running") {
      const label = attentionLabel(e);
      if (!label) continue;
      dueNow = true;
      focus.push(label);
    }
  }
  const distinct = (list: string[], max: number): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const item = raw.trim();
      if (!item || seen.has(item.toLowerCase())) continue;
      seen.add(item.toLowerCase());
      out.push(item);
    }
    return out.slice(0, max);
  };
  const dedup = distinct(focus, 5);
  const dedupLabs = distinct(labs, 4);
  if (!dedup.length && !dedupLabs.length) return null;
  // Inside a race's final four weeks a max-effort lift test competes with the key runs:
  // the lifts wait for race day, the labs can book any time.
  const race = raceRead(inp);
  const raceClose = race?.raceDate && race.daysTo != null && race.daysTo <= 28 && dedup.length > 0;
  return {
    in_weeks: dueNow ? 0 : 1,
    focus: dedup,
    labs: dedupLabs,
    why: raceClose
      ? `Hold the heavy lift re-tests until after race day (${shortDate(String(race?.raceDate))}) so a max effort never lands near a key run${dedupLabs.length ? "; the labs and scans can book any time in the same window" : ""}.`
      : "Batch these into one check-in window so labs, scans and lift re-tests land together every ~6–8 weeks — enough to see real change, not so often it interrupts the work.",
  };
}

// ---- temporal placement: the block's calendar truth, plain words -------------
// "This block" without WHERE in the block reads like a sticky note. The line and the
// structured read (week N of M, the phase the week runs as, the deload decision) come
// from blockRead() in coaching-focus-read.ts — descriptive, never a gate.

// ---- canonical daily-state adapters ----------------------------------------
// Athlete-facing prose here is a VARIANT SET, never one literal: a stable input fires
// the same branch every morning, so a single sentence would print verbatim for weeks
// (the day-read rule, CLAUDE.md). Every set below rotates through pickDayVariant on the
// signal state's own date, keyed so two sets that can co-render never land in step.

// A life-capacity squeeze whose cause is a dated COMMITMENT (school pickup, a fixed
// appointment) — the clock is the constraint, not recovery room. Same rotation
// discipline as its schedule_pressure sibling below: a stable commitment fires this
// branch every time schedule compresses, so a single literal would print verbatim.
const COMMITMENT_PRESSURE_TITLES = [
  "Keep today's work inside the available window",
  "Fit today's session inside the available window",
  "Work within today's available window",
] as const;
const COMMITMENT_PRESSURE_MOVES = [
  "Prioritize the main work and defer optional volume; this is a timing constraint, not a recovery verdict.",
  "Lead with the main work and let the optional volume go; this is a timing constraint, not a recovery verdict.",
  "Get the main work in first and drop the extras; this is a timing constraint, not a recovery verdict.",
] as const;

// A life-capacity squeeze whose cause is RECOVERY, not the calendar — a stressful
// stretch or an expected bad night. Holds intensity; says nothing about a time window.
const LIFE_PRESSURE_TITLES = [
  "Keep today's ask modest through this stretch",
  "Hold today's intensity while things are busy",
  "Take the lighter version of today's work",
] as const;
const LIFE_PRESSURE_MOVES = [
  "Hold the intensity where it is and let the optional volume go — the squeeze here is recovery, not the clock.",
  "Take the shorter, easier version and finish with something left; a busy stretch costs recovery before it costs minutes.",
  "Keep the effort conversational and drop the extras rather than racing through the full session.",
] as const;
// The same read, appended to whatever OTHER training lever wins the day.
const LIFE_PRESSURE_TIMING = [
  "Today, keep the ask modest: hold the intensity and let the optional volume go.",
  "Today, take the lighter end of it — hold intensity where it is and drop the extras.",
  "Today, keep the effort honest rather than hard, and leave the optional volume out.",
] as const;

// ---- the work-around caveat: chosen by CAUSE, never by posture ---------------
// `modify` is reached from unrelated causes — an active health constraint, an
// underfueling prescription, and the mixed-signal arbitration tie-break — so keying the
// caveat off the posture produced injury-shaped prose ("work around IT with pain-free
// substitutions") on fuel, HRV and sleep days, where "it" named nothing at all. These
// dimension statuses are what actionState/planningDirectives themselves arbitrate on, so
// reading them back names the dimension that really drove the day.
const CAVEAT_CAUSE_ORDER: readonly SignalDimension[] = [
  "health_constraints",
  "energy_fueling",
  "recovery_capacity",
  "training_load_tolerance",
  "life_capacity",
];
const CAVEAT_STATUS_SEVERITY: Record<string, number> = { constrained: 2, watch: 1 };
// The instruction that follows the cause's own spoken sentence. Plain words, a
// suggestion never a gate, and each one has to make sense with NOTHING to substitute
// around — only the health cause may talk about substitutions.
const CAVEAT_INSTRUCTIONS: Record<SignalDimension, readonly [string, ...string[]]> = {
  health_constraints: [
    "Use pain-free substitutions and keep the load conservative.",
    "Swap anything that provokes it for a pain-free version and keep the load light.",
    "Pick movements that stay comfortable and leave the heavy loading for another day.",
  ],
  energy_fueling: [
    "Eat around the work first and keep today's dose modest until fuel catches up.",
    "Get the fuel in before you add load, and keep today's session on the shorter side.",
    "Fuel the work properly and hold the volume where it is rather than adding to it.",
  ],
  recovery_capacity: [
    "Keep the load conservative today and leave the hard sets for a fresher day.",
    "Hold the loading where it is rather than climbing, and finish with something left.",
    "Take the conservative end of the range today and let recovery catch up.",
  ],
  training_load_tolerance: [
    "Keep today's dose conservative and let the work you've already stacked up absorb.",
    "Hold the volume where it is rather than adding to what's already accumulated.",
    "Take the lighter end of today's work and give the recent load room to settle.",
  ],
  life_capacity: [
    "Keep today's ask modest and take the shorter version of the session.",
    "Trim the session to what genuinely fits and leave the optional volume out.",
    "Keep the ask small today rather than forcing the full session in.",
  ],
};
// Plain provenance label per cause — `based_on` is the machine/provenance register.
const CAVEAT_CAUSE_LABEL: Record<SignalDimension, string> = {
  health_constraints: "health constraints",
  energy_fueling: "fueling",
  recovery_capacity: "recovery capacity",
  training_load_tolerance: "training load",
  life_capacity: "life capacity",
};
// The caveat's own rotation key. Deliberately NOT one of SIGNAL_VOICE_KEYS: the fuel
// and schedule cards can co-render with a caveat drawn from the same dimension, and a
// shared key would print the identical sentence twice on one screen.
const CAVEAT_VOICE_KEY = "coaching_focus:caveat";

// The dimension that actually produced a modify / work-around day: most severe status
// first, ties broken in the same precedence order actionState walks. Falls back to
// recovery capacity (a conservative-load caveat) when nothing is flagged at all.
function caveatCause(state: UnifiedSignalState | null | undefined): SignalDimension {
  let cause: SignalDimension = "recovery_capacity";
  let severity = 0;
  for (const dimension of CAVEAT_CAUSE_ORDER) {
    // Deciding status only. Naming the cause of a modify day is the same claim
    // `action.evidence` makes (src/repo/signal-state.ts) — an advisory brake did not
    // produce the day and may not be named as what it is about, even though it stays
    // visible in the dimension's own evidence and in the prompt.
    const source = state?.dimensions?.[dimension];
    const rank = CAVEAT_STATUS_SEVERITY[lc(source?.deciding?.status ?? source?.status)] ?? 0;
    if (rank > severity) {
      severity = rank;
      cause = dimension;
    }
  }
  return cause;
}

// The caveat is the one string on the card that must not be lossy — it carries the
// safety instruction. So the producer's `why` is budgeted around it and the caveat is
// appended WHOLE. Clipping the joined string instead ate the instruction off the end
// every time, because every lead-eligible producer already clips its own `why` to
// 200–240 and `item.why` (not `focus.caveat`, which no client renders) is what shows.
const CAVEAT_MAX = 220;
const WHY_WITH_CAVEAT_MAX = 240;
const WHY_MIN_WITH_CAVEAT = 90;
// The head is budgeted by WHOLE sentences, never characters: a character clip left
// "…focused volume here is where the…" on the card, cut mid-thought. As many whole
// sentences as fit the budget are kept, and the first always is, even when it runs
// long — a complete sentence over budget beats a broken one inside it.
// A sentence ends only at terminal punctuation (plus any closing quote/bracket) that is
// followed by whitespace or the end of the text — so "187.5 lb" and "1.2 lb a week" never
// split — and never after a known mid-sentence abbreviation ("e.g. ", "vs. ").
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
const NON_TERMINAL_ABBREVIATION = /(?:^|[^A-Za-z.])(?:e\.g|i\.e|vs|approx|incl|cf)\.$/i;
export function splitWholeSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    const candidate = text.slice(start, end);
    if (match[0] === "." && NON_TERMINAL_ABBREVIATION.test(candidate)) continue;
    const sentence = candidate.trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export function wholeSentences(text: string, budget: number): string {
  const found = splitWholeSentences(text);
  const sentences = found.length ? found : [text];
  let out = "";
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (out && next.length > budget) break;
    out = next;
  }
  return out || text;
}

function joinCaveat(why: unknown, caveat: string): string {
  const head = String(why ?? "").trim();
  if (!caveat) return head;
  if (!head) return caveat;
  return `${wholeSentences(head, Math.max(WHY_MIN_WITH_CAVEAT, WHY_WITH_CAVEAT_MAX - caveat.length - 1))} ${caveat}`;
}

// UnifiedSignalState has already resolved source collisions, freshness and the
// safety posture. The conductor does not rescore those facts. It translates them
// into its existing candidate/constraint vocabulary, then uses the same shared
// focus ranker as every other producer.
function signalStateCandidates(input: CoachingFocusInput): Candidate[] {
  const state = input.signalState;
  const action = state?.action;
  if (!action) return [];
  const out: Candidate[] = [];
  const reasons = inputArray<unknown>(action.reasons)
    .map((reason) => String(reason ?? "").trim())
    .filter(Boolean);
  const evidence = (fallback: string) =>
    cleanEvidence([`Unified planning posture: ${action.posture}`, ...reasons]) ?? [fallback];
  // `reason` and `reasons` are the MACHINE register — evidence summaries written about
  // the athlete in the third person, kept verbatim in `based_on` where the model and the
  // provenance trail read them. Every string below that a PERSON reads speaks the voice
  // instead, rotated on the state's own date, and on the same key the Brief uses — the
  // conductor's lead and the Brief are one tap apart, so one signal must read as one
  // observation rather than two differently-worded notes about the same morning.
  // The posture rides along so a MISSING voice falls back by direction rather than
  // always to protective words (see POSTURE_FALLBACK_VOICE) — a green day whose voice
  // went missing was being handed a brake it had no evidence for.
  const spoken = (voice: Parameters<typeof spokenSignalVoice>[0], key?: string) =>
    spokenSignalVoice(voice, String(state?.date ?? ""), key, action.posture);

  // A protective day (rest / easy) still owns the card: it is a safety posture and the
  // week's levers wait in Later for the next ready day. A COMPLETED day is not a
  // lever at all — it is a day state (`day_state`), and the week's lever leads.
  if (action.posture === "rest" || action.posture === "easy") {
    const posture = action.posture;
    out.push({
      key: "signal-daily-posture",
      leverage: 6,
      slot: "lead",
      noun: "recovery",
      item: {
        domain: "recovery",
        title: DAY_STATE_TITLES[posture],
        why: clip(spoken(action.voice, SIGNAL_VOICE_KEYS.protect), 220),
        move: DAY_STATE_MOVES[posture],
        based_on: evidence("Unified daily planning state"),
        day_posture: posture,
      },
    });
  }

  if (action.directives?.fueling === "protect") {
    out.push({
      key: "signal-fuel-protect",
      leverage: 3.6,
      slot: "parallel",
      noun: "fueling",
      defer:
        action.posture === "done" || action.posture === "rest" || action.posture === "easy"
          ? "Rides with today's state: eat to recover around the work."
          : "A today note: hold or raise fuel around the work rather than deepening the deficit.",
      item: {
        domain: "nutrition",
        title: "Protect fuel around today's work",
        why: clip(spoken(state.dimensions?.energy_fueling?.voice, SIGNAL_VOICE_KEYS.fueling), 220),
        move: "Hold or raise fuel around the work; do not deepen the deficit today.",
        based_on: evidence("Unified fueling directive: protect"),
      },
    });
  }

  if (
    action.directives?.schedule === "compress" &&
    action.posture !== "rest" &&
    action.posture !== "easy" &&
    action.posture !== "done"
  ) {
    // `compress` says life capacity is at watch — it does NOT say WHY, and the two
    // causes want opposite cards. A dated commitment squeezes the CLOCK (fit the work
    // in the window). A stressful stretch / expected worse sleep squeezes RECOVERY,
    // and the calendar framing then contradicted the very sentence above it: the
    // schedule_pressure voice says "there's enough going on to squeeze your recovery"
    // while the move insisted "this is a timing constraint, not a recovery verdict".
    const commitment = lifeCapacityIsCommitment(state);
    const date = String(state?.date ?? "");
    out.push({
      key: "signal-schedule-compress",
      leverage: 3.5,
      slot: "parallel",
      noun: "today's tight window",
      item: {
        domain: "training",
        title: commitment
          ? pickDayVariant(COMMITMENT_PRESSURE_TITLES, date, "cfocus:commitment_pressure:title")
          : pickDayVariant(LIFE_PRESSURE_TITLES, date, "cfocus:life_pressure:title"),
        why: clip(spoken(state.dimensions?.life_capacity?.voice, SIGNAL_VOICE_KEYS.schedule), 220),
        move: commitment
          ? pickDayVariant(COMMITMENT_PRESSURE_MOVES, date, "cfocus:commitment_pressure:move")
          : pickDayVariant(LIFE_PRESSURE_MOVES, date, "cfocus:life_pressure:move"),
        based_on: evidence("Unified schedule directive: compress"),
      },
    });
  }
  return out;
}

const DAY_STATE_TITLES: Record<FocusDayState["posture"], string> = {
  rest: "Protect recovery today",
  easy: "Keep today easy",
  done: "Today's work is complete",
};
const DAY_STATE_MOVES: Record<FocusDayState["posture"], string> = {
  rest: "Keep today restorative and let the work absorb.",
  easy: "Keep movement genuinely easy; leave hard loading for the next ready day.",
  done: "Let today's work absorb before adding another hard effort.",
};

// TODAY's posture as a day state, apart from the week's lever. The line is the Brief's
// own sentence (same voice, key and date), so one signal reads as one observation; a
// fuel-protect directive rides on the move so a finished day still says "eat to recover".
function dayState(input: CoachingFocusInput): FocusDayState | null {
  const state = input.signalState;
  const action = state?.action;
  const posture = action?.posture;
  if (posture !== "rest" && posture !== "easy" && posture !== "done") return null;
  const line = clip(
    spokenSignalVoice(action?.voice, String(state?.date ?? ""), SIGNAL_VOICE_KEYS.protect, posture),
    220
  );
  const fuel =
    action?.directives?.fueling === "protect"
      ? " Eat to recover: hold or raise fuel around the work rather than deepening the deficit today."
      : "";
  return { posture, title: DAY_STATE_TITLES[posture], line, move: `${DAY_STATE_MOVES[posture]}${fuel}` };
}

function activeInjuryWorkaround(input: CoachingFocusInput): string | null {
  const injury = input.signalState?.dimensions?.health_constraints?.evidence?.find(
    (item) => item.field === "active_injury" && item.freshness !== "stale"
  );
  if (!injury) return null;
  // The SAME sentence the Brief splices onto a protective read (same voice, same key,
  // same date), followed by the substitution instruction this caveat exists to carry.
  // It used to lead with a fixed literal and then append the evidence summary, so the
  // athlete got the injury named twice — once in their register, once in the classifier's
  // ("…work around the active injury. Achilles tendinopathy: an active injury is worth
  // easing or working around.") — and the lead-in read as a gate ("must"), not a
  // suggestion.
  const named = spokenSignalVoice(
    injury.voice ?? { key: "active_injury" },
    String(input.signalState?.date ?? ""),
    SIGNAL_VOICE_KEYS.injury
  );
  return clip(`${named} Use pain-free substitutions and keep the load conservative.`, 220);
}

function applySignalStateConstraints(candidates: Candidate[], input: CoachingFocusInput): Candidate[] {
  const state = input.signalState;
  const action = state?.action;
  if (!action) return candidates;
  const trainingFamily = (candidate: Candidate) =>
    candidate.item.domain === "training" || candidate.item.domain === "running";
  // A COMPLETED day protects nothing further: the work is in, and the week's lever is
  // what the card is for (the day itself rides on `day_state`).
  const protectsDay = action.posture === "rest" || action.posture === "easy";

  // A canonical recovery posture owns the day. Training ideas remain in Later for
  // block continuity, but cannot appear as an actionable lead/parallel beside a
  // rest/easy Brief.
  if (protectsDay) {
    for (const candidate of candidates) {
      if (trainingFamily(candidate)) {
        candidate.slot = "later";
        candidate.defer = "Waits for the next ready day — today belongs to recovery.";
      }
    }
  }

  // Modify does not masquerade as rest. It keeps a useful training lever, but the
  // work-around must be explicit wherever that lever lands — and it must describe the
  // thing that actually constrained the day, in words that work with no injury present.
  const injuryCaveat = activeInjuryWorkaround(input);
  if (action.posture === "modify" || injuryCaveat) {
    const date = String(state?.date ?? "");
    const cause = caveatCause(state);
    const caveat = clip(
      injuryCaveat ||
        `${spokenSignalVoice(state?.dimensions?.[cause]?.voice ?? action.voice, date, CAVEAT_VOICE_KEY)} ${pickDayVariant(CAVEAT_INSTRUCTIONS[cause], date, `${CAVEAT_VOICE_KEY}:${cause}`)}`,
      CAVEAT_MAX
    );
    // The truthful provenance line: the directive's REAL value plus the dimension it
    // came from. The old line asserted "modify" whatever `directives.training` said —
    // printing the posture under a "directive" label on every hold_aggression day.
    const directive = String(action.directives?.training ?? action.posture);
    for (const candidate of candidates) {
      if (!trainingFamily(candidate)) continue;
      candidate.caveat = caveat;
      // Travels with the text: the cause is otherwise module-private, and the two
      // downstream paths that re-wrap this caveat carry no line to scrape it from.
      candidate.caveat_cause = CAVEAT_CAUSE_LABEL[cause];
      candidate.item.why = joinCaveat(candidate.item.why, caveat);
      candidate.item.based_on = cleanEvidence([
        ...(candidate.item.based_on ?? []),
        `Unified training directive: ${directive} (from ${CAVEAT_CAUSE_LABEL[cause]})`,
      ]);
    }
  }

  // Compression constrains time OR recovery room — never both, and the two read
  // oppositely (see lifeCapacityIsCommitment). Preserve whichever training/run lever
  // wins and make its concrete move fit whichever squeeze is actually on.
  if (action.directives?.schedule === "compress" && !protectsDay) {
    const timing = lifeCapacityIsCommitment(state)
      ? "Today, keep it inside the compressed window: main work first, optional volume deferred."
      : pickDayVariant(LIFE_PRESSURE_TIMING, String(state?.date ?? ""), "cfocus:life_pressure:constraint");
    for (const candidate of candidates) {
      if (!trainingFamily(candidate) || candidate.key === "signal-schedule-compress") continue;
      candidate.item.move = clip([candidate.item.move, timing].filter(Boolean).join(" "), 240);
      candidate.item.based_on = cleanEvidence([
        ...(candidate.item.based_on ?? []),
        "Unified schedule directive: compress",
      ]);
    }
  }

  // Fuel protection must remain visible even when another nutrition producer (for
  // example an ApoB food-pattern lever) outranks the dedicated fuel candidate.
  if (action.directives?.fueling === "protect") {
    const fuelMove = "Protect calories, carbohydrate and protein around the work; do not deepen the deficit today.";
    for (const candidate of candidates) {
      if (candidate.item.domain !== "nutrition" || candidate.key === "signal-fuel-protect") continue;
      candidate.item.move = clip([candidate.item.move, fuelMove].filter(Boolean).join(" "), 240);
      candidate.item.based_on = cleanEvidence([
        ...(candidate.item.based_on ?? []),
        "Unified fueling directive: protect",
      ]);
    }
  }
  return candidates;
}

// ---- the conductor ----------------------------------------------------------

export function coachingFocus(input: CoachingFocusInput = {}): CoachingFocus {
  const candidates = applySignalStateConstraints(
    [
      ...signalStateCandidates(input),
      recoveryCandidate(input),
      trainingCandidate(input),
      rotationHandledCandidate(input),
      runningCandidate(input),
      capacityCandidate(input),
      healthCandidate(input),
      dexaCandidate(input),
      bodyCandidate(input),
      // External producers (K3) — same shared arbitration, one voice.
      riskCandidate(input),
      journeyCandidate(input),
      benchmarkCandidate(input),
      ...laterCandidates(input),
    ]
      .filter((c): c is Candidate => c != null)
      .map((candidate) => applyIntentBias(candidate, input)),
    input
  );

  // LEAD: the single highest-leverage lead-eligible candidate. Tie-break order is
  // baked into the leverage scores (recovery-deload > training stall > running >
  // health act_now). If nothing is lead-eligible but a strong parallel exists
  // (e.g. a health act_now on an otherwise-steady athlete), promote it.
  const leadEligible = candidates.filter((c) => c.slot === "lead").sort(byScore);
  // Prefer a lead that does NOT conflict with an active injury / sore joint. A training
  // lever loading a flagged area is DEMOTED so a clean lever leads (the demoted one
  // still rides in parallel/later carrying its caveat). Only when there's no clean
  // alternative does the conflicted lever lead — then its caveat is surfaced.
  const cleanLeadEligible = leadEligible.filter((c) => !c.caveat);
  let lead = cleanLeadEligible[0] ?? null;
  if (!lead) {
    const strongClean = candidates.filter((c) => !c.caveat && c.leverage >= 3.5 && c.slot !== "later").sort(byScore)[0];
    lead = strongClean ?? leadEligible[0] ?? null;
  }
  const leadKey = lead?.key;
  const leadDomain = lead?.item.domain;

  // The conductor's life/soreness caveat: if the lead kept a conflicted training lever
  // (nothing cleaner existed) surface its caveat; if a training lever was DEMOTED for
  // an injury/sore area, note that we deliberately held off leading with it.
  const conflictedLever = candidates.find((c) => c.caveat);
  const caveat = lead?.caveat
    ? lead.caveat
    : conflictedLever && conflictedLever.key !== leadKey
      ? `Held off leading with "${conflictedLever.item.title}" this block — ${conflictedLever.caveat}`
      : activeInjuryWorkaround(input);

  // PARALLEL: up to 2 of the rest, on a DIFFERENT lever than the lead (so they can
  // genuinely be worked simultaneously — e.g. diet handles lipids while you train).
  const parallel = candidates
    .filter((c) => c.key !== leadKey && c.slot !== "later" && c.item.domain !== leadDomain && c.leverage >= 2.0)
    .sort(byScore)
    .slice(0, 2);

  const used = new Set<string>([leadKey, ...parallel.map((c) => c.key)].filter(Boolean) as string[]);
  // LATER: the explicit deferral — what we are NOT doing yet, in priority order, each
  // with why it waits.
  const deferred = candidates
    .filter((c) => !used.has(c.key))
    .sort(byScore)
    .slice(0, 3);
  const later = deferred.map((c) => {
    const why = clip(c.defer || c.item.why || "", 140);
    return why ? { domain: c.item.domain, title: c.item.title, why } : { domain: c.item.domain, title: c.item.title };
  });

  const leadItem = cleanFocusItem(lead?.item ?? null);
  const parallelItems = parallel.map((c) => cleanFocusItem(c.item)).filter((item): item is FocusItem => item != null);
  const connections = leadItem ? buildConnections(leadItem, parallelItems, input) : [];
  const retest = buildRetest(input);
  const horizon_weeks = num(input.trajectory?.horizon_weeks) ?? num(input.enduranceGoal?.weeks_to_race) ?? null;

  // The week read around the choice: the block, today's state, the evidence and what moved.
  const block = blockRead(input);
  const race = raceRead(input);
  const day_state = dayState(input);
  const changed_since = focusChanges(input, race);
  const domainOrder = [lead, ...parallel].filter((c): c is Candidate => c != null).map((c) => c.item.domain);
  const evidence = leadItem
    ? focusEvidence(input, domainOrder, { leverIsLead: lead?.key === "training-lever", race })
    : [];

  const headline = composeHeadline({
    lead,
    parallel,
    deferred,
    block: block?.read ?? null,
    race,
  });

  return {
    available: leadItem != null,
    headline: clip(headline, 240),
    // The coach owns the actions server-side only when it can genuinely act
    // unattended (lead posture + background coaching on) — then the surface offers
    // no one-tap swap/draft ask. Otherwise the athlete keeps the buttons.
    acts: !coachLeads(input),
    lead: leadItem,
    parallel: parallelItems,
    later,
    connections,
    retest,
    horizon_weeks,
    caveat: caveat ? clip(caveat, 220) : null,
    // Whichever of the three paths above produced `caveat` names its own cause. The
    // last one IS the injury work-around by construction, so it labels itself rather
    // than reporting no cause at all.
    caveat_cause: caveat
      ? ((lead?.caveat ? lead.caveat_cause : conflictedLever?.caveat_cause) ?? CAVEAT_CAUSE_LABEL.health_constraints)
      : null,
    block_line: block?.line ?? null,
    block: block?.read ?? null,
    day_state,
    evidence,
    changed_since,
  };
}

// ---- the headline: the week's through-line, never a standing slogan ------------
// "<where in the block / days to the race>: <lead> leads, with <a> and <b> alongside."
// It names the levers by noun (the lead block below it carries the title), so the card
// never says the same sentence twice — and for the same reason it never carries a
// change: `changed_since` is the "What moved" strip's to say, right under it. The strength
// standing ("an intermediate lifter overall") is NOT a headline: it is a supporting
// fact on the lead when — and only when — strength is the lever.
function composeHeadline(args: {
  lead: Candidate | null;
  parallel: Candidate[];
  deferred: Candidate[];
  block: FocusBlockRead | null;
  race: RaceRead | null;
}): string {
  const { lead, parallel, deferred, block, race } = args;
  if (!lead) return "Log a few sessions and Cairn will set your focus for the block.";
  const anchorParts: string[] = [];
  if (block?.week != null && block.of != null) anchorParts.push(`Week ${block.week} of ${block.of}`);
  if (race?.daysTo != null && race.daysTo >= 0 && race.daysTo <= 112) {
    anchorParts.push(
      race.daysTo === 0
        ? `race day for ${raceName(race)}`
        : `${race.daysTo} day${race.daysTo === 1 ? "" : "s"} to ${raceName(race)}`
    );
  }
  const anchor = anchorParts.join(", ");
  const nounOf = (c: Candidate) => c.noun || lc(c.item.title);
  let through: string;
  if (lead.item.day_posture) {
    const waiting = deferred.find((c) => c.item.domain === "training" || c.item.domain === "running");
    through = `today belongs to recovery${waiting ? `; ${nounOf(waiting)} picks back up on the next ready day` : ""}`;
  } else {
    const along = parallel.map(nounOf).filter((n, i, a) => n && a.indexOf(n) === i);
    through = `${nounOf(lead)} leads this week${along.length ? `, with ${joinAnd(along)} alongside` : ""}`;
  }
  const raw = anchor ? `${anchor}: ${through}.` : `${through}.`;
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
}
