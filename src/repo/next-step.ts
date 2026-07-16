import { db } from "../db.js";
import { getHealthSynthesisView, healthFocus, isAcuteMarker } from "./propagation.js";
import { programBalance } from "./progression.js";
import { dayRead } from "./intelligence.js";
import { computeGoalCheck } from "./profile.js";
import { getAppState, setAppState } from "./app-state.js";
import { localDateISO } from "./shared.js";
import {
  type FocusCandidate,
  type FocusDomain,
  type RankedFocus,
  rankFocus,
  scoreFocus,
} from "./focus-candidate.js";

// ============================================================================
// THE ONE NEXT-BEST-STEP — a pure, deterministic, cross-domain producer + VIEW.
//
// Cairn's surfaces each shout their own thing (a due muscle group, a protein
// gap, an earned rest, a lab to recheck). This module reads ALL of them with the
// SAME repo data the rest of the app uses and returns the SINGLE highest next
// step — or NULL on a quiet day. The integration owner maps this onto the
// today-agenda candidate and handles the done/snooze taps.
//
// K3 (v1 arch): this module NO LONGER owns a scoring engine. Its producers emit
// plain `FocusCandidate`s; the SINGLE shared arbiter (`scoreFocus`/`rankFocus` in
// focus-candidate.ts — the same primitive the conductor uses) does the one ranking.
// The only next-step-specific concern kept here is the snooze/done cooldown, folded
// in as a `penalty` on the shared score. So there is exactly one "what's next"
// scorer in the codebase, and this is a VIEW over it.
//
// Constitution (binding): NO numeric scores cross the public boundary. `leverage`
// and the internal score are kept like marker `impact_score` — they shape the
// ranking but NEVER reach the athlete. We surface only plain words (title/why)
// and the coarse `domain`. Suggestion-not-a-gate. Pull-never-push. Calm + bounded.
//
// CYCLE NOTE: this module is imported by the higher today-agenda layer, so it
// must NOT import ./today-agenda.js. It only reaches DOWN to low-level repo
// modules (propagation/progression/intelligence/profile/app-state/focus-candidate)
// + the DB.
// ============================================================================

export interface NextStep {
  domain: "train" | "fuel" | "recover" | "recheck" | "life";
  /** Stable + COARSE key, e.g. "train:gap:quads" — drives snooze/done dedup. */
  step_key: string;
  title: string;
  why: string;
  /** Plain-language evidence that caused this to surface. Bounded, no scores. */
  based_on?: string[];
  /** Suggested UI action. Still review-only; nothing auto-applies. */
  action?: {
    kind: "open_plan" | "open_food" | "open_health" | "open_recovery" | "open_life";
    label: string;
  };
  /** 0..3 — INTERNAL leverage weight. Never surfaced. */
  leverage: number;
}

// A producer returns a candidate with everything the shared arbiter needs.
// `actionable` is whether there's something concrete to do TODAY (vs a passive
// "watch"), and `fresh` is whether this just changed (a brand-new signal nudges
// slightly above a long-standing one). Both are coarse booleans — no numbers leak.
interface Candidate extends NextStep {
  actionable: boolean;
  fresh: boolean;
}

// The next-step `domain` vocabulary → the shared FocusDomain, so a next-step
// candidate can be ranked by the one arbiter alongside every other producer.
const NEXT_STEP_DOMAIN: Record<NextStep["domain"], FocusDomain> = {
  train: "training",
  fuel: "nutrition",
  recover: "recovery",
  recheck: "health",
  life: "recovery",
};

// Adapt one next-step candidate to the shared producer contract (plain words only).
// `kind` IS the stable step_key so the cooldown penalty keys off it downstream.
function toFocusCandidate(c: Candidate): FocusCandidate {
  return {
    domain: NEXT_STEP_DOMAIN[c.domain] ?? "training",
    kind: c.step_key,
    priority_inputs: Array.isArray(c.based_on) ? c.based_on.filter(Boolean).slice(0, 3) : [],
    headline: c.title,
    why: c.why,
    action: c.action ? { kind: c.action.kind, label: c.action.label } : null,
  };
}

// Snooze / done cooldown window. A skipped or handled step stays quiet for this
// many days so it doesn't return tomorrow. `done` uses a longer window than a
// soft snooze (a handled thing is settled; a snooze is just "not today").
const SNOOZE_DAYS = 3;
const DONE_DAYS = 14;

const snoozeKey = (stepKey: string) => `next_step:snooze:${stepKey}`;
const doneKey = (stepKey: string) => `next_step:done:${stepKey}`;

function daysSinceStamp(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 864e5;
}

// How much to SUBTRACT for an active snooze/done cooldown. A step inside its
// cooldown is pushed below any live candidate; once the window passes it's free
// to surface again. Returns a large penalty (effectively suppressing) while in
// window, 0 otherwise.
function cooldownPenalty(stepKey: string, now: number): number {
  const snoozed = daysSinceStamp(getAppState(snoozeKey(stepKey)), now);
  const done = daysSinceStamp(getAppState(doneKey(stepKey)), now);
  if (snoozed != null && snoozed < SNOOZE_DAYS) return 1e6;
  if (done != null && done < DONE_DAYS) return 1e6;
  return 0;
}

// ---- CRP / ESR acuteness guard ---------------------------------------------
// A high hs-CRP / ESR is very often training-induced (or a transient infection),
// NOT a chronic lever. The constitution + the live athlete's reality (CRP high &
// likely training-induced) demand it NEVER yields a training-cap step — at most a
// low-leverage "recheck when you've had a quiet week". Chronic cardiometabolic
// markers (ApoB/LDL/Lp(a)/HbA1c) are the real high-leverage levers. The acute test
// is the canonical isAcuteMarker (imported above) — it also guards a chronic CLUSTER
// name that merely mentions CRP, which the old narrow regex here misclassified.

// ---------- the cross-domain producers --------------------------------------

// TRAIN — a due/lagging group from the volume balance, or a reground/overload
// read from the day-read (rest is its own RECOVER producer; here we only speak to
// genuinely-training reads). A due group is the concrete, high-actionability move.
function produceTrain(read: ReturnType<typeof dayRead>, date: string): Candidate | null {
  let bal: ReturnType<typeof programBalance> | null = null;
  try { bal = programBalance(2, date); } catch { bal = null; }
  const due = bal?.due ?? [];
  if (due.length) {
    const group = String(due[0]).toLowerCase();
    return {
      domain: "train",
      step_key: `train:gap:${group}`,
      title: `Give ${due[0]} some work`,
      why: bal!.summary || `${due[0]} is running light lately — a little focused volume evens it out.`,
      based_on: [`Program balance says ${due[0]} is due`, "Today still has room for training"],
      action: { kind: "open_plan", label: "Open today's plan" },
      leverage: 1,
      actionable: true,
      fresh: false,
    };
  }
  // No volume gap — fall back to the day-read's training nudge (a due session),
  // a softer suggestion than a concrete gap.
  if (read.kind === "train" && read.focus) {
    return {
      domain: "train",
      step_key: `train:session:${String(read.focus).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      title: `Train: ${read.focus}`,
      why: read.why || "You're recovered and due — good to go.",
      based_on: ["Today's read says training fits", read.why ? "Recovery and recent-load checks support it" : "Plan and recovery context are available"],
      action: { kind: "open_plan", label: "Open today's session" },
      leverage: 1,
      actionable: true,
      fresh: false,
    };
  }
  return null;
}

// FUEL — a REAL protein gap from today's logged food vs the protein target. Only
// surfaces when there's food logged AND the day is materially short on protein
// (so it evaluates, never nudges capture). Adherence-neutral wording.
function produceFuel(date: string): Candidate | null {
  // Today's logged food, keyed by the stamped LOCAL day. The created_at fallback
  // keeps old pre-v42 rows readable without pulling evening travel logs into UTC
  // tomorrow.
  const rows = db.prepare(
    `SELECT parsed_json FROM food_notes WHERE COALESCE(date, substr(created_at, 1, 10)) = ?`
  ).all(date) as any[];
  if (!rows.length) return null; // nothing logged → never nudge

  let protein = 0;
  let haveAnyMacro = false;
  for (const r of rows) {
    let parsed: any = null;
    try { parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null; } catch { parsed = null; }
    const p = Number(parsed?.protein_g);
    if (Number.isFinite(p) && p > 0) { protein += p; haveAnyMacro = true; }
  }
  if (!haveAnyMacro) return null; // logged, but no macros to evaluate

  let goal: any = null;
  try { goal = computeGoalCheck(); } catch { goal = null; }
  const target = goal?.ok ? Number(goal?.recommended?.protein_g) : null;
  if (!target || !Number.isFinite(target) || target <= 0) return null;

  const gap = Math.round(target - protein);
  // Only a MATERIAL shortfall (>20 g under, and meaningfully short — guards a
  // near-miss). Plain words; never red, never a grade.
  if (gap < 20 || protein >= target * 0.85) return null;

  return {
    domain: "fuel",
    step_key: "fuel:protein-gap",
    title: "A little more protein today",
    why: `You're about ${gap} g under your protein anchor — an easy way to round out the day.`,
    based_on: [`Logged food has about ${Math.round(protein)} g protein`, `Protein anchor is about ${Math.round(target)} g`],
    action: { kind: "open_food", label: "Review today's fuel" },
    leverage: 1,
    actionable: true,
    fresh: false,
  };
}

// RECOVER — an EARNED rest (the day-read says rest), or a recovery-data gap (no
// wearable signal at all, so the read is flying blind). Rest is high-actionability
// (concrete: take it easy today); the data gap is a soft, low-leverage heads-up.
function produceRecover(read: ReturnType<typeof dayRead>): Candidate | null {
  const sig = read.signals || {};
  if (read.kind === "rest") {
    return {
      domain: "recover",
      step_key: "recover:earned-rest",
      title: "Take the rest you've earned",
      why: read.why || "You've stacked hard days — let today consolidate.",
      based_on: ["Today's read calls for rest", read.why ? "Recent training and recovery signals are part of the read" : "Recent load is enough to justify backing off"],
      action: { kind: "open_recovery", label: "Review recovery" },
      leverage: 2,
      actionable: true,
      fresh: false,
    };
  }
  // Soft anticipation — heading toward a reset but not there yet.
  if (sig?.fatigue?.anticipate_deload) {
    return {
      domain: "recover",
      step_key: "recover:building-fatigue",
      title: "Ease off if it's there",
      why: "Recovery's drifting below your norm while the hard days stack — a lighter day soon will pay off.",
      based_on: ["Recovery is drifting below your norm", "Recent training load is stacking"],
      action: { kind: "open_recovery", label: "Review recovery" },
      leverage: 1,
      actionable: false,
      fresh: true,
    };
  }
  // No recovery data at all — a calm, low-leverage nudge (NEVER a gate).
  if (sig.has_recovery_data === false) {
    return {
      domain: "recover",
      step_key: "recover:data-gap",
      title: "Recovery's flying a bit blind",
      why: "No recent sleep or HRV synced — connecting a wearable would let the daily read account for how recovered you actually are.",
      based_on: ["No recent sleep or HRV data is synced"],
      action: { kind: "open_recovery", label: "Review recovery data" },
      leverage: 0,
      actionable: false,
      fresh: false,
    };
  }
  return null;
}

// RECHECK — a lab worth attention. The HIGHEST-leverage lever is the agentic
// health synthesis's `one_change` (the elite-coach whole-picture move, leverage
// 3) — it beats any raw per-marker directive. Failing that, the lead off-optimal
// CHRONIC lab group (leverage 2). An acute/stale CRP/ESR yields at MOST a
// leverage-1 "recheck when you've had a quiet week" — NEVER a training cap.
function produceRecheck(): Candidate | null {
  const synthesisView = getHealthSynthesisView();
  const synth = synthesisView.stale ? null : synthesisView.synthesis;
  const oneChange = synth?.one_change ? String(synth.one_change).trim() : "";
  if (oneChange) {
    return {
      domain: "recheck",
      step_key: "recheck:synthesis-one-change",
      title: "Your highest-leverage health move",
      why: oneChange,
      based_on: ["Latest health synthesis", "Connected-brain marker review"],
      action: { kind: "open_health", label: "Open health read" },
      leverage: 3,
      actionable: true,
      fresh: false,
    };
  }

  let focus: ReturnType<typeof healthFocus> | null = null;
  try { focus = healthFocus(); } catch { focus = null; }
  const priorities = focus?.priorities ?? [];
  if (!priorities.length) return null;

  // The lead priority that is NOT purely an acute-inflammatory finding. An
  // acute/stale CRP/ESR group never drives a chronic lab step — it gets the soft
  // recheck path below.
  const chronic = priorities.find((p) => {
    const names = [...(p.markers || []), ...((p.readings || []).map((r) => r.name))];
    return !names.every((n) => isAcuteMarker(n));
  });
  if (chronic) {
    const move = chronic.moves?.nutrition || chronic.moves?.training || chronic.moves?.watch || null;
    return {
      domain: "recheck",
      step_key: `recheck:group:${chronic.group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      // A directive flagged uncertain is a softer nudge.
      title: chronic.uncertain ? `Worth a look: ${chronic.group}` : `Focus area: ${chronic.group}`,
      why: move || chronic.why || `${chronic.group} is outside its optimal band.`,
      based_on: [`Latest ${chronic.group} markers`, chronic.uncertain ? "Marker match is conservative" : "Trusted optimal-zone comparison"],
      action: { kind: "open_health", label: "Review markers" },
      leverage: 2,
      actionable: !!move,
      fresh: false,
    };
  }

  // Everything pressing is acute-inflammatory (e.g. a training-induced hs-CRP).
  // The MOST it earns is a calm leverage-1 recheck — never a training cap.
  return {
    domain: "recheck",
    step_key: "recheck:acute-inflammation",
    title: "Recheck inflammation when you've had a quiet week",
    why: "An inflammatory marker reads high — often just hard training or a passing bug. Recheck after an easy week before reading anything into it.",
    based_on: ["Acute inflammatory marker is high", "No chronic marker is leading this step"],
    action: { kind: "open_health", label: "Review marker trend" },
    leverage: 1,
    actionable: false,
    fresh: false,
  };
}

// LIFE — an active context effect (a trip / injury / life event that should bend
// today). Plain, calm, low-leverage (it's a "plan around this", not a directive).
function produceLife(date: string): Candidate | null {
  const row = db.prepare(
    `SELECT id, kind, title FROM context_events
      WHERE archived = 0
        AND (start_date IS NULL OR start_date <= ?)
        AND (end_date IS NULL OR end_date >= ?)
      ORDER BY (kind = 'injury') DESC, (start_date IS NULL), start_date DESC, id DESC
      LIMIT 1`
  ).get(date, date) as any;
  if (!row) return null;
  const kind = String(row.kind || "life_event");
  const label = row.title ? String(row.title) : kind === "injury" ? "an injury" : kind === "trip" ? "a trip" : "something going on";
  const why =
    kind === "injury"
      ? `${label} is active — keep load off it and lean on what doesn't aggravate it.`
      : kind === "trip"
        ? `${label} is on — a travel-friendly, lighter approach fits better than forcing the full plan.`
        : `${label} is in play — it's fine to dial things back around it.`;
  return {
    domain: "life",
    step_key: `life:${kind}:${row.id}`,
    title: kind === "injury" ? "Work around the injury" : "Plan around what's going on",
    why,
    based_on: [`Active ${kind.replace(/_/g, " ")} context`, label],
    action: { kind: "open_life", label: "Review life context" },
    leverage: kind === "injury" ? 2 : 1,
    actionable: true,
    fresh: false,
  };
}

// ---------- the producers, as one candidate set ------------------------------

// Run every cross-domain producer and return today's next-step candidates. Never
// throws; missing data → a producer just returns null and is skipped. This is the
// PRODUCER half — the shared arbiter (below / the conductor) does the ranking.
function nextStepCandidates(date?: string): Candidate[] {
  const d = date || localDateISO();
  // The day-read is shared by the train + recover producers (one fetch).
  let read: ReturnType<typeof dayRead>;
  try { read = dayRead(d); } catch { read = { kind: "easy", focus: null, why: "", est_minutes: null, signals: {} }; }

  const candidates: Candidate[] = [];
  const push = (c: Candidate | null) => { if (c) candidates.push(c); };
  try { push(produceRecheck()); } catch { /* skip */ }
  try { push(produceRecover(read)); } catch { /* skip */ }
  try { push(produceTrain(read, d)); } catch { /* skip */ }
  try { push(produceFuel(d)); } catch { /* skip */ }
  try { push(produceLife(d)); } catch { /* skip */ }
  return candidates;
}

// The next-step producers exposed as the SHARED producer contract, so the conductor
// (or any future surface) can fold today's cross-domain steps into the one arbitration
// without re-deriving them. Cooldown/ambient filtering stays a next-step-view concern.
export function nextStepFocusCandidates(date?: string): FocusCandidate[] {
  return nextStepCandidates(date).map(toFocusCandidate);
}

// ---------- the VIEW over the one shared arbiter -----------------------------

// Wrap a next-step candidate for the shared scorer: the conductor-style leverage the
// producer declared + the coarse tie-break facts + the snooze/done cooldown as a
// penalty (the only next-step-specific input to the single formula).
function toRanked(c: Candidate, now: number): RankedFocus & { source: Candidate } {
  return {
    candidate: toFocusCandidate(c),
    leverage: c.leverage,
    actionable: c.actionable,
    fresh: c.fresh,
    penalty: cooldownPenalty(c.step_key, now),
    source: c,
  };
}

// Return the single highest next step (or NULL on a quiet day) by delegating the
// RANKING to the shared arbiter (`scoreFocus`/`rankFocus`) — no bespoke scorer here.
export function nextBestStep(date?: string): NextStep | null {
  const now = Date.now();
  const candidates = nextStepCandidates(date);
  if (!candidates.length) return null;

  // Drop a pure ambient signal — a leverage-0, non-actionable, non-fresh candidate
  // (e.g. the recovery-data gap). It's true context, but never worth being the SINGLE
  // thing the athlete sees today; surfacing it daily would nag (pull-never-push), so a
  // quiet day with only ambient state stays genuinely quiet.
  const ranked = candidates
    .filter((c) => !(c.leverage <= 0 && !c.actionable && !c.fresh))
    .map((c) => toRanked(c, now))
    // Drop anything a cooldown suppresses (its penalty dwarfs the base score).
    .filter((r) => scoreFocus(r) >= 0);
  if (!ranked.length) return null;

  const best = rankFocus(ranked)[0].source;
  const { domain, step_key, title, why, leverage, based_on, action } = best;
  // INTERNAL fields (actionable/fresh/score) never cross the boundary.
  return {
    domain,
    step_key,
    title,
    why,
    leverage,
    based_on: Array.isArray(based_on) ? based_on.filter(Boolean).slice(0, 3) : undefined,
    action,
  };
}

// Stamp app_state so a SNOOZED step (skipped "not today") stays quiet for the
// short cooldown window.
export function snoozeNextStep(stepKey: string): void {
  if (!stepKey) return;
  setAppState(snoozeKey(String(stepKey)), new Date().toISOString());
}

// Stamp app_state so a DONE step (handled) stays quiet for the longer window.
export function nextStepDone(stepKey: string): void {
  if (!stepKey) return;
  setAppState(doneKey(String(stepKey)), new Date().toISOString());
}
