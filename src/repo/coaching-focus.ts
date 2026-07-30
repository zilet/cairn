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

import { pickDayVariant } from "./brain/day-read-rules.js";
import { movementKey } from "./exercise-canon.js";
import { type FocusCandidate, type FocusDomain, focusScore } from "./focus-candidate.js";
import { clipText } from "./shared.js";
import {
  lifeCapacityIsCommitment,
  spokenSignalVoice,
  SIGNAL_VOICE_KEYS,
  type SignalDimension,
  type SignalPosture,
  type UnifiedSignalState,
} from "./signal-state.js";

// Re-exported so existing importers keep resolving `FocusDomain` from the conductor.
export type { FocusCandidate, FocusDomain } from "./focus-candidate.js";

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
  focus: string[]; // the batched things to re-test (lifts + a run test), not piecemeal
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
  later: { domain: FocusDomain; title: string }[]; // explicitly deferred — the sequence
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
  // Null when no block is active.
  block_line: string | null;
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
}

interface ProgramStateInput {
  mesocycle?: ProgramMesocycleInput | null;
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
}

interface HealthFocusInput {
  headline?: unknown;
  lead?: HealthFocusLeadInput | null;
}

interface PerformanceLeverInput {
  headline?: unknown;
  why?: unknown;
  target?: unknown;
}

interface PerformanceEnduranceInput {
  tone?: unknown;
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
}

interface Candidate {
  item: FocusItem;
  leverage: number; // INTERNAL ordering only — never surfaced
  slot: "lead" | "parallel" | "later";
  key: string;
  // Set when this (training) lever loads a flagged/injured/sore area — the conductor
  // prefers a non-conflicting lead and, if it keeps this one, surfaces the caveat.
  caveat?: string;
  // The display label of the dimension that produced `caveat`, carried with it so
  // coachingFocus() can publish the cause without re-deriving it.
  caveat_cause?: string;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

// A recent-vs-baseline delta is fit to lead only when BOTH constituent wearable
// series are current and have enough coverage to be a trend rather than a stray
// night. The canonical summary puts all fields in `quality`; `provenance` plus
// `coverage` is the equivalent fallback when an older caller omitted that block.
function recoverySignalIsDecisionGrade(recovery: RecoveryInput | null | undefined, signal: string): boolean {
  const quality = recovery?.quality?.[signal];
  const provenance = recovery?.provenance?.[signal];
  const coverage = recovery?.coverage?.[signal];
  const latestDate = String(quality?.latest_date ?? provenance?.latest_date ?? "");
  const freshness = lc(quality?.freshness ?? provenance?.freshness);
  const samples = num(quality?.sample_count ?? coverage?.sample_count);
  const expected = num(
    quality?.expected_days ?? quality?.window_days ?? coverage?.expected_days ?? coverage?.window_days
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latestDate) || !["fresh", "recent"].includes(freshness)) return false;
  if (samples == null || samples < 0) return false;
  // Half of the available window, capped at a week, with a three-night floor.
  // When the caller omits its expected window, five nights is the conservative
  // minimum for treating a recent-vs-baseline delta as a coaching lead.
  const requiredSamples = expected != null && expected > 0 ? Math.max(3, Math.ceil(Math.min(expected, 14) / 2)) : 5;
  return samples >= requiredSamples;
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

function recoveryCandidate(inp: CoachingFocusInput): Candidate | null {
  const meso = inp.programState?.mesocycle;
  const phase = lc(meso?.phase);
  const deloadDue = phase.includes("deload");
  const hrv = num(inp.recovery?.delta?.hrv);
  const rhr = num(inp.recovery?.delta?.rhr);
  const recoveryEvidenceIsDecisionGrade =
    recoverySignalIsDecisionGrade(inp.recovery, "hrv_ms") && recoverySignalIsDecisionGrade(inp.recovery, "resting_hr");
  const recoveringDown = recoveryEvidenceIsDecisionGrade && hrv != null && hrv < 0 && rhr != null && rhr > 2;
  // The applied recovery week RUNNING is its own lead — a calm confirmation, no
  // action (the plan already is the lighter week), regardless of whether the
  // original trigger signals still read due.
  const active = inp.recoveryWeekActive === true;
  if (active) {
    return {
      key: "recovery-deload",
      leverage: 5,
      slot: "lead",
      item: {
        domain: "recovery",
        title: "Recovery week — absorb the work",
        why: "This week is deliberately lighter: about half the working volume, same movements, crisp easy efforts. The adaptation you've been training for lands now — don't chase PRs, sleep big.",
        recovery_active: true,
        based_on: ["You applied the recovery week", "Back to building when the week is done"],
      },
    };
  }
  if (!deloadDue && !recoveringDown) return null;
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
    item: {
      domain: "recovery",
      title: "Take an earned recovery week",
      why:
        (meso?.note ? String(meso.note) : "") ||
        "Your recent load and recovery signals say a lighter week now pays off — back volume off ~40%, keep the intensity crisp, and you'll come back stronger. This is the performance-building choice, not a step back.",
      // draft_pending drives the review LINK (navigation) on every posture; the move
      // copy above is what changes between lead mode and the athlete-driven surfaces.
      ...(draftPending ? { draft_pending: true } : {}),
      ...(move ? { move } : {}),
      based_on: [
        ...(deloadDue ? ["Mesocycle says deload is due"] : []),
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
    return {
      key: "training-lever",
      leverage: 3.8,
      slot: "lead",
      caveat,
      item: {
        domain: "training",
        title: String(lever.headline),
        why: `${String(lever.why || "Focused volume on your furthest-behind lift is where the easiest, most motivating progress is.")}${caveat ? ` (${caveat})` : ""}`,
        move: lever.target ? String(lever.target) : undefined,
        based_on: ["Performance standing lever", lever.why ? String(lever.why) : "Capacity comparison across lifts"],
      },
    };
  }
  return null;
}

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
  const phase = lc(goal?.phase);
  const role = enduranceRole(inp);
  const raceActive = activeRace(inp);
  // A dated race in build/sharpen is time-bound — high leverage, lead-eligible.
  // (getEnduranceGoal discriminates on `is_race`/`mode`, never a `kind` field.)
  if (goal?.is_race && (phase === "build" || phase === "sharpen")) {
    const legacyRaceLead = role === "none" && lc(inp.trainingIntent?.source) !== "explicit";
    const leadEligible = role === "primary" || role === "co_primary" || legacyRaceLead;
    return {
      key: "running-race",
      leverage: leadEligible ? 4.0 : role === "supporting" ? 3.2 : 3.0,
      slot: leadEligible ? "lead" : "parallel",
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
    leverage: role === "primary" ? 3.7 : role === "co_primary" ? 3.5 : 2.3,
    slot: role === "primary" || role === "co_primary" ? "lead" : "parallel",
    item: {
      domain: "running",
      title,
      why: clip(
        capacity?.summary ||
          (target ? `The durable target is an outing around ${Math.round(target)} minutes.` : "The durable capability needs a calm next exposure."),
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
  const move = moves.nutrition || moves.training || moves.watch;
  const viaNutrition = !!moves.nutrition;
  return {
    key: "health-lead",
    leverage: actNow ? 4.0 : 2.6,
    // Health is usually addressed through diet/lifestyle, so it runs PARALLEL to
    // training rather than displacing it — but a true act_now with no training lead
    // can be promoted to lead by the selector below.
    slot: "parallel",
    item: {
      domain: viaNutrition ? "nutrition" : "health",
      title: `Move your ${lc(lead.group)}`,
      why: clip(lead.why || (inp.healthFocus?.headline ?? ""), 220),
      move: move ? clip(move, 240) : undefined,
      based_on: [`Health lead: ${lead.group}`, lead.tier ? `Tier: ${lead.tier}` : "Connected-brain health focus"],
    },
  };
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
  return {
    key: "body-deficit",
    leverage: 2.0,
    slot: "parallel",
    item: {
      domain: "nutrition",
      title: "Hold a lean-safe deficit",
      why: "Keep the deficit modest and protein high so the weight that comes off is fat, not the muscle you're working to build.",
      based_on: ["Goal mode is fat loss", "Nutrition target is lean-safe"],
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
  return lift(fc, leverage, slot, "risk-cardiovascular");
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
  return lift(fc, 2.0, "parallel", "journey-milestone");
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
  return lift(fc, 2.0, "parallel", "benchmark-milestone");
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
// A due-attention entry (listDueAttention / K5) → a short, readable checkpoint label.
// A lab/DEXA re-check and a lift re-test batch into the SAME calm checkpoint.
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
  const dueAttention = inputArray<DueAttentionInput>(inp.dueAttention).filter(
    (e) => !String(e?.signal_key ?? "").includes(":change-check:")
  );
  if (dueAttention.length) {
    dueNow = true; // something is already due
    for (const e of dueAttention) {
      const label = attentionLabel(e);
      if (label) focus.push(label);
    }
  }
  const dedup = [...new Set(focus.map((f) => f.trim()).filter(Boolean))].slice(0, 5);
  if (!dedup.length) return null;
  return {
    in_weeks: dueNow ? 0 : 1,
    focus: dedup,
    why: "Batch these into one check-in window so labs, scans and lift re-tests land together every ~6–8 weeks — enough to see real change, not so often it interrupts the work.",
  };
}

// ---- temporal placement: the block's calendar truth, plain words -------------
// "This block" without WHERE in the block reads like a sticky note. One line:
// week N of M plus what the phase means for effort — descriptive, never a gate.
function blockPlacementLine(b: ProgramBlockSummaryInput | null | undefined): string | null {
  const weekOf = String(b?.week_of ?? "").trim();
  if (!weekOf) return null;
  const wk = weekOf.charAt(0).toUpperCase() + weekOf.slice(1);
  const phase = lc(b?.phase);
  const tail =
    phase === "deload"
      ? "a deload week: absorb the work you've put in"
      : phase === "realization"
        ? "test week: express what the block built"
        : phase === "intensification"
          ? "pushing intensity; the deload is in sight"
          : phase === "accumulation"
            ? "building volume"
            : "";
  return tail ? `${wk} — ${tail}.` : `${wk}.`;
}

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
    const rank = CAVEAT_STATUS_SEVERITY[lc(state?.dimensions?.[dimension]?.status)] ?? 0;
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
function joinCaveat(why: unknown, caveat: string): string {
  const head = String(why ?? "").trim();
  if (!caveat) return head;
  if (!head) return caveat;
  return `${clip(head, Math.max(WHY_MIN_WITH_CAVEAT, WHY_WITH_CAVEAT_MAX - caveat.length - 1))} ${caveat}`;
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
  const spoken = (voice: Parameters<typeof spokenSignalVoice>[0], key?: string) =>
    spokenSignalVoice(voice, String(state?.date ?? ""), key);

  if (action.posture === "rest" || action.posture === "easy" || action.posture === "done") {
    const posture = action.posture;
    out.push({
      key: "signal-daily-posture",
      leverage: 6,
      slot: "lead",
      item: {
        domain: "recovery",
        title:
          posture === "rest"
            ? "Protect recovery today"
            : posture === "easy"
              ? "Keep today easy"
              : "Today's work is complete",
        why: clip(spoken(action.voice, SIGNAL_VOICE_KEYS.protect), 220),
        move:
          posture === "rest"
            ? "Keep today restorative and let the work absorb."
            : posture === "easy"
              ? "Keep movement genuinely easy; leave hard loading for the next ready day."
              : "Let today's work absorb before adding another hard effort.",
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
  const protectsDay = action.posture === "rest" || action.posture === "easy" || action.posture === "done";

  // A canonical recovery/complete posture owns the day. Training ideas remain in
  // Later for block continuity, but cannot appear as an actionable lead/parallel
  // beside a rest/easy Brief.
  if (protectsDay) {
    for (const candidate of candidates) {
      if (trainingFamily(candidate)) candidate.slot = "later";
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
  // LATER: the explicit deferral — what we are NOT doing yet, in priority order.
  const later = candidates
    .filter((c) => !used.has(c.key))
    .sort(byScore)
    .slice(0, 3)
    .map((c) => ({ domain: c.item.domain, title: c.item.title }));

  const leadItem = cleanFocusItem(lead?.item ?? null);
  const parallelItems = parallel.map((c) => cleanFocusItem(c.item)).filter((item): item is FocusItem => item != null);
  const connections = leadItem ? buildConnections(leadItem, parallelItems, input) : [];
  const retest = buildRetest(input);
  const horizon_weeks = num(input.trajectory?.horizon_weeks) ?? num(input.enduranceGoal?.weeks_to_race) ?? null;

  // HEADLINE: where you are (reuse performance's honest one-liner) + the through-line.
  const where = clip(input.performance?.hero?.headline || "", 110);
  let headline: string;
  if (!leadItem) {
    headline = where || "Log a few sessions and Cairn will set your focus for the block.";
  } else {
    const tail = parallelItems.length
      ? ` — with ${parallelItems
          .map((p) => lc(p.domain))
          .filter((d, i, a) => a.indexOf(d) === i)
          .join(" + ")} handled alongside`
      : "";
    // Colon form, title case preserved: lead titles are often imperative phrases
    // ("Take an earned recovery week"), and "This block, take an earned recovery
    // week leads" reads broken. "This block: <title> — with X handled alongside."
    // reads right for imperative and noun titles alike.
    const stem = `This block: ${leadItem.title}${tail}.`;
    headline = where ? `${where}. ${stem}` : stem;
  }

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
      ? (lead?.caveat ? lead.caveat_cause : conflictedLever?.caveat_cause) ??
        CAVEAT_CAUSE_LABEL.health_constraints
      : null,
    block_line: blockPlacementLine(input.programBlock),
  };
}
