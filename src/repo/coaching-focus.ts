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

import { type FocusCandidate, type FocusDomain, focusScore } from "./focus-candidate.js";

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

interface RecoveryInput {
  delta?: RecoveryDeltaInput | null;
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
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
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

function recoveryCandidate(inp: CoachingFocusInput): Candidate | null {
  const meso = inp.programState?.mesocycle;
  const phase = lc(meso?.phase);
  const deloadDue = phase.includes("deload");
  const hrv = num(inp.recovery?.delta?.hrv);
  const rhr = num(inp.recovery?.delta?.rhr);
  const recoveringDown = hrv != null && hrv < 0 && rhr != null && rhr > 2;
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
  const leads = lc(inp.leadMode) === "lead";
  // The recovery lead's next-step line adapts to posture. Under LEAD mode the coach
  // sets the recovery week up itself at the week boundary, so the line speaks STATE
  // — never a one-tap ask — and names the weekday when an upcoming recovery/structure
  // decision is already scheduled. Off lead mode, the athlete drives it: a waiting
  // draft points at the review, an un-drafted one leaves the button to the surface.
  let move: string | undefined;
  if (leads) {
    if (draftPending) {
      move = "Recovery week is queued — it lands automatically. Undo any time from Plan.";
    } else {
      const soon = inputArray<UpcomingDecisionInput>(inp.upcoming).find(
        (d) => lc(d?.kind) === "training_structure" || lc(d?.domain) === "recovery"
      );
      const weekday = soon ? weekdayOf(soon.effective_date) : null;
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
        "Mesocycle says deload is due",
        recoveringDown ? "HRV and resting HR are drifting down together" : "Recent training load has accumulated",
      ],
    },
  };
}

function trainingCandidate(inp: CoachingFocusInput): Candidate | null {
  const flagged = flaggedContext(inp);
  // Under LEAD mode the coach rotates at the boundary itself, so the conductor emits
  // no one-tap swap payload (`acts` false). Otherwise the athlete drives the swap.
  const acts = lc(inp.leadMode) !== "lead";
  const plannedNames = inputArray<unknown>(inp.plannedNames)
    .map((n) => lc(n))
    .filter(Boolean);
  const rotations = inputArray<AppliedRotationInput>(inp.recentRotations);
  // A genuinely STALLED canonical group with a concrete swap menu is the most
  // coach-like training lead (the athlete's own "which groups stall" framing).
  const groups = inputArray<MuscleGroupTrajectoryInput>(inp.groupsTrajectory?.groups);
  const stalled = groups.find((g) => lc(g?.verdict) === "stalling" && (g?.lead_lift || g?.label));
  if (stalled) {
    const leadLift = String(stalled.lead_lift ?? "").trim();
    const leadLiftLc = lc(leadLift);
    const label = lc(stalled.label || stalled.group);
    // Has the brain already HANDLED this plateau? A matching applied rotation means
    // the stalled lift was rotated out — speak to the new stimulus (a calm alongside
    // note), never re-offer the swap that just happened (or the lift just removed).
    const rotation = leadLiftLc ? rotations.find((r) => lc(r?.from) === leadLiftLc) : undefined;
    if (rotation) {
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
    // The stalled lift is off every plan day with no rotation record on file — the
    // plateau read is stale (it can't be rotated out; it isn't there). Fall through
    // to the capacity laggard rather than offering to rotate a lift that's gone.
    const unprogrammed = plannedNames.length > 0 && leadLiftLc !== "" && !plannedNames.includes(leadLiftLc);
    if (!unprogrammed) {
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
          move: opts.length ? `Rotate in ${opts.join(" or ")} for a few weeks.` : undefined,
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
  // Else the capacity laggard (the one lift furthest behind for the athlete's age).
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

function runningCandidate(inp: CoachingFocusInput): Candidate | null {
  const goal = inp.enduranceGoal;
  const end = inp.performance?.endurance;
  const phase = lc(goal?.phase);
  // A dated race in build/sharpen is time-bound — high leverage, lead-eligible.
  // (getEnduranceGoal discriminates on `is_race`/`mode`, never a `kind` field.)
  if (goal?.is_race && (phase === "build" || phase === "sharpen")) {
    return {
      key: "running-race",
      leverage: 4.0,
      slot: "lead",
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
    return {
      key: "running-aerobic",
      leverage: 3.6,
      slot: "lead",
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
  if (inp.runPlan?.available && inp.runPlan?.quality_focus) {
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
  if (inp.runVariety?.note) {
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
  const dueAttention = inputArray<DueAttentionInput>(inp.dueAttention);
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

// ---- the conductor ----------------------------------------------------------

export function coachingFocus(input: CoachingFocusInput = {}): CoachingFocus {
  const candidates: Candidate[] = [
    recoveryCandidate(input),
    trainingCandidate(input),
    runningCandidate(input),
    healthCandidate(input),
    dexaCandidate(input),
    bodyCandidate(input),
    // External producers (K3) — same shared arbitration, one voice.
    riskCandidate(input),
    journeyCandidate(input),
    benchmarkCandidate(input),
    ...laterCandidates(input),
  ].filter((c): c is Candidate => c != null);

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
      : null;

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
    // Lead mode owns the actions server-side: under 'lead' the coach applies bounded
    // changes itself, so the surface offers no one-tap swap/draft ask.
    acts: lc(input.leadMode) !== "lead",
    lead: leadItem,
    parallel: parallelItems,
    later,
    connections,
    retest,
    horizon_weeks,
    caveat: caveat ? clip(caveat, 220) : null,
    block_line: blockPlacementLine(input.programBlock),
  };
}
