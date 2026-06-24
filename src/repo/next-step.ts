import { db, todayISO } from "../db.js";
import { getHealthSynthesis, healthFocus, isAcuteMarker } from "./propagation.js";
import { programBalance } from "./progression.js";
import { dayRead } from "./intelligence.js";
import { computeGoalCheck } from "./profile.js";
import { getAppState, setAppState } from "./app-state.js";

// ============================================================================
// THE ONE NEXT-BEST-STEP — a pure, deterministic, cross-domain producer.
//
// Cairn's surfaces each shout their own thing (a due muscle group, a protein
// gap, an earned rest, a lab to recheck). This module reads ALL of them with the
// SAME repo data the rest of the app uses, scores them INTERNALLY (leverage +
// actionability + freshness − a snooze cooldown), and returns the SINGLE highest
// next step — or NULL on a quiet day. The integration owner maps this onto the
// today-agenda candidate and handles the done/snooze taps.
//
// Constitution (binding): NO numeric scores cross the public boundary. `leverage`
// and the internal score are kept like marker `impact_score` — they shape the
// ranking but NEVER reach the athlete. We surface only plain words (title/why)
// and the coarse `domain`. Suggestion-not-a-gate. Pull-never-push. Calm + bounded.
//
// CYCLE NOTE: this module is imported by the higher today-agenda layer, so it
// must NOT import ./today-agenda.js. It only reaches DOWN to low-level repo
// modules (propagation/progression/intelligence/profile/app-state) + the DB.
// ============================================================================

export interface NextStep {
  domain: "train" | "fuel" | "recover" | "recheck" | "life";
  /** Stable + COARSE key, e.g. "train:gap:quads" — drives snooze/done dedup. */
  step_key: string;
  title: string;
  why: string;
  /** 0..3 — INTERNAL leverage weight. Never surfaced. */
  leverage: number;
}

// A producer returns a candidate with everything the scorer needs. `actionable`
// is whether there's something concrete to do TODAY (vs a passive "watch"), and
// `fresh` is whether this just changed (a brand-new signal nudges slightly above
// a long-standing one). Both are coarse booleans — no numbers leak.
interface Candidate extends NextStep {
  actionable: boolean;
  fresh: boolean;
}

// Internal scoring coefficients — same spirit as marker impact_score: they live
// here, never on the wire.
const LEVERAGE_WEIGHT = 10; // leverage dominates; a 3-leverage lever clears a 0-leverage one
const ACTIONABLE_BONUS = 2;
const FRESH_BONUS = 1;

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
function produceTrain(read: ReturnType<typeof dayRead>): Candidate | null {
  let bal: ReturnType<typeof programBalance> | null = null;
  try { bal = programBalance(); } catch { bal = null; }
  const due = bal?.due ?? [];
  if (due.length) {
    const group = String(due[0]).toLowerCase();
    return {
      domain: "train",
      step_key: `train:gap:${group}`,
      title: `Give ${due[0]} some work`,
      why: bal!.summary || `${due[0]} is running light lately — a little focused volume evens it out.`,
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
  // Today's logged food (this era keys the day off created_at's date prefix).
  const rows = db.prepare(
    `SELECT parsed_json FROM food_notes WHERE substr(created_at, 1, 10) = ?`
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
  const synth = getHealthSynthesis();
  const oneChange = synth?.one_change ? String(synth.one_change).trim() : "";
  if (oneChange) {
    return {
      domain: "recheck",
      step_key: "recheck:synthesis-one-change",
      title: "Your highest-leverage health move",
      why: oneChange,
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
    leverage: kind === "injury" ? 2 : 1,
    actionable: true,
    fresh: false,
  };
}

// ---------- the arbiter ------------------------------------------------------

function scoreOf(c: Candidate, now: number): number {
  return (
    c.leverage * LEVERAGE_WEIGHT +
    (c.actionable ? ACTIONABLE_BONUS : 0) +
    (c.fresh ? FRESH_BONUS : 0) -
    cooldownPenalty(c.step_key, now)
  );
}

// Run every cross-domain producer, score them internally, and return the single
// winner (or NULL on a quiet day). Never throws; missing data → a producer just
// returns null and is skipped.
export function nextBestStep(date?: string): NextStep | null {
  const d = date || todayISO();
  const now = Date.now();

  // The day-read is shared by the train + recover producers (one fetch).
  let read: ReturnType<typeof dayRead>;
  try { read = dayRead(d); } catch { read = { kind: "easy", focus: null, why: "", est_minutes: null, signals: {} }; }

  const candidates: Candidate[] = [];
  const push = (c: Candidate | null) => { if (c) candidates.push(c); };
  try { push(produceRecheck()); } catch { /* skip */ }
  try { push(produceRecover(read)); } catch { /* skip */ }
  try { push(produceTrain(read)); } catch { /* skip */ }
  try { push(produceFuel(d)); } catch { /* skip */ }
  try { push(produceLife(d)); } catch { /* skip */ }

  if (!candidates.length) return null;

  // Score; drop anything still inside a snooze/done cooldown, AND drop a pure
  // ambient signal — a leverage-0, non-actionable, non-fresh candidate (e.g. the
  // recovery-data gap). It's true context, but it's never worth being the SINGLE
  // thing the athlete sees today; surfacing it daily would nag (pull-never-push),
  // so a quiet day with only ambient state stays genuinely quiet.
  let best: { c: Candidate; score: number } | null = null;
  for (const c of candidates) {
    if (c.leverage <= 0 && !c.actionable && !c.fresh) continue;
    const score = scoreOf(c, now);
    if (score < 0) continue; // suppressed by cooldown (penalty dwarfs the base)
    if (!best || score > best.score) best = { c, score };
  }
  if (!best) return null;

  const { domain, step_key, title, why, leverage } = best.c;
  // INTERNAL fields (actionable/fresh/score) never cross the boundary.
  return { domain, step_key, title, why, leverage };
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
