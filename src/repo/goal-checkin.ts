import { todayISO } from "../db.js";
import { type CadencePolicy, applyAttentionObservation, getAttentionSchedule } from "./attention.js";
import { type GoalMode, effectiveGoalMode, getProfile } from "./profile.js";
import type { TodayAgendaCandidate } from "./today-agenda.js";

// ----------------------------------------------------------------------------
// A periodic, gentle "is this still your goal?" (VISION §12 item 5).
//
// Goals drift, and the goal modes (lose / maintain / gain) made that explicit.
// RARELY — and only as a quiet, pull-based card surfaced THROUGH the Today
// salience arbiter — the buddy checks in: "you've been maintaining a while;
// still the plan, or shifting?". It honors §2.7 (understands you, keeps
// understanding) WITHOUT nagging.
//
// Constitution (BINDING): far apart, never blocking, dismissible to silence,
// no nag, no score. Pull-never-push. You-drive: a "change" routes through the
// EXISTING profile goal flow (Me→Profile selector / setProfile) — nothing here
// auto-applies. Kind, never anxious.
//
// CADENCE (K5): the timing is NOT a fixed 90-day interval. It rides the shared
// attention engine as a `journey`-domain signal, so every "still my goal" (a
// clean check) STRETCHES the next ask via the tier machine — active → confirming
// → surveillance → released — and a boringly-stable goal converges to *no*
// scheduled check (event-driven only). A real goal change re-seeds it at active.
// ----------------------------------------------------------------------------

const SIGNAL_KEY = "journey:goal-checkin";

// The K5 cadence policy for the goal check-in. `active_days` is the FIRST gentle
// ask (~3 months after the goal is set); each clean confirm then stretches the
// interval (×surveillance_multiplier), and after a couple of clean surveillance
// checks it releases entirely (no scheduled check until the goal changes).
const GOAL_POLICY: CadencePolicy = {
  signal_class: "journey:goal",
  domain: "journey",
  source: "goal-checkin",
  active_days: 90, // ≈3 months from setting a goal to the first gentle check
  confirming_days: 90, // confirm it still holds before stretching further
  surveillance_initial_days: 150,
  surveillance_multiplier: 1.75,
  surveillance_max_days: 365,
  surveillance_checks_before_release: 2,
  reason: "It's been a while on this goal — a gentle check that it still fits.",
  release_condition:
    "The goal is stable and confirmed; it goes quiet until you change it, bring it up, or your journey phase shifts.",
};

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// ---------- public stamping helpers ----------

// Stamp that the user has confirmed their goal ("still my goal") — a CLEAN check
// that stretches the next gentle ask (and, repeated, releases it). The first ever
// confirm (no entry yet) starts the ~3-month clock rather than releasing. Called
// from the confirm path AND the existing profile goal-change flow.
export function confirmGoalCheckin(): void {
  const prev = getAttentionSchedule(SIGNAL_KEY);
  // A clean check with no prior entry would release immediately; instead treat the
  // very first confirm as starting the active clock (the first ask lands ~90 days
  // out, never on day one).
  const status = prev ? "clean" : "active";
  applyAttentionObservation({
    signal_key: SIGNAL_KEY,
    policy: GOAL_POLICY,
    observation: { checked_at: todayISO(), status },
  });
}

// A real goal CHANGE — re-seed at the active tier (a fresh goal deserves a fresh
// ~3-month clock, not the stretched cadence of the old one). goal_change is a
// reactivating event in the attention engine.
export function reactivateGoalCheckin(): void {
  applyAttentionObservation({
    signal_key: SIGNAL_KEY,
    policy: GOAL_POLICY,
    observation: { checked_at: todayISO(), status: "active", event: "goal_change" },
  });
}

// Stamp that the card was waved off — a clean check that quiets it (stretches the
// interval), never a nag. Dismissible to silence (constitution).
export function dismissGoalCheckin(): void {
  const prev = getAttentionSchedule(SIGNAL_KEY);
  const status = prev ? "clean" : "active";
  applyAttentionObservation({
    signal_key: SIGNAL_KEY,
    policy: GOAL_POLICY,
    observation: { checked_at: todayISO(), status },
  });
}

// ---------- the candidate producer ----------

// Compose the warm, plain-language line per goal mode. No score, no pressure —
// a question, offered, not a verdict. "~3 months" reads kinder than an exact
// day count, so we round the stable span to whole months.
function lineFor(mode: GoalMode, monthsStable: number): { kicker: string; title: string; body: string } {
  const span = monthsStable <= 1 ? "a while" : `about ${monthsStable} months`;
  if (mode === "maintain") {
    return {
      kicker: "A QUICK CHECK",
      title: `You've been holding steady for ${span} — still the plan, or shifting?`,
      body: "No rush — maintaining is a real goal. If you're thinking about leaning out or building, you can switch any time.",
    };
  }
  if (mode === "gain") {
    return {
      kicker: "A QUICK CHECK",
      title: `You've been building for ${span} — still the direction, or easing off?`,
      body: "If the goal's shifted toward holding or leaning out, it's a one-tap change. Otherwise, carry on.",
    };
  }
  // lose
  return {
    kicker: "A QUICK CHECK",
    title: `You've been leaning out for ${span} — still the goal, or settling in?`,
    body: "If you're ready to hold steady (or shift the goal), you can update it any time. No pressure either way.",
  };
}

// Decide whether to gently ask if the current goal still holds. Returns null
// when not due (the common answer). Deterministic + null-safe.
//
// Logic:
//   • No profile at all → null (nothing to ask about).
//   • No attention entry yet → seed it at the active tier (the first ask lands
//     ~active_days out) and return null, so a brand-new user is never nagged.
//   • Entry released or not yet due → null.
//   • Otherwise (next_due has arrived) → a modest-priority, dismissible candidate.
export function goalCheckinCandidate(asOf: string = todayISO()): TodayAgendaCandidate | null {
  const prof = getProfile();
  if (!prof) return null; // no profile yet — nothing to check in on

  const entry = getAttentionSchedule(SIGNAL_KEY);

  // First-ever observation: seed the active clock so the first prompt lands
  // ~active_days later (never nag a fresh user), then stay quiet.
  if (!entry) {
    applyAttentionObservation({
      signal_key: SIGNAL_KEY,
      policy: GOAL_POLICY,
      observation: { checked_at: asOf, status: "active" },
    });
    return null;
  }

  // Released (converged to no scheduled check) or not yet due → quiet.
  if (entry.tier === "released" || !entry.next_due || entry.next_due > asOf) return null;

  const mode = effectiveGoalMode(prof);
  const monthsStable = Math.max(1, Math.round(daysBetween(entry.last_checked || asOf, asOf) / 30));
  const { kicker, title, body } = lineFor(mode, monthsStable);

  return {
    id: "goal-checkin",
    kind: "goal",
    tier: "primary",
    // MODEST priority on purpose: this is gentle, not urgent — it should lose to
    // anything actionable (a session, a flagged lab, fuel). It only wins on a
    // genuinely quiet day, which is exactly when a calm check-in belongs.
    priority: 18,
    kicker,
    title,
    body,
    // You-drive: both paths route through the EXISTING profile goal flow on the
    // client. 'confirm' restamps the clock; 'change' opens Me→Profile's goal
    // selector. Nothing here auto-applies. The payload carries the current mode
    // so the client can pre-select it.
    action: {
      label: "Still my goal",
      kind: "goal_checkin_confirm",
      payload: { goal_mode: mode, change_label: "Change my goal" },
    },
    dismissible: true,
  };
}
