import { getAppState, setAppState } from "./app-state.js";
import { type GoalMode, effectiveGoalMode, getProfile } from "./profile.js";
import type { TodayAgendaCandidate } from "./today-agenda.js";

// ----------------------------------------------------------------------------
// A periodic, gentle "is this still your goal?" (VISION §12 item 5).
//
// Goals drift, and the goal modes (lose / maintain / gain) made that explicit.
// RARELY — and only as a quiet, pull-based card surfaced THROUGH the Today
// salience arbiter — the buddy checks in: "you've been maintaining ~3 months;
// still the plan, or shifting?". It honors §2.7 (understands you, keeps
// understanding) WITHOUT nagging.
//
// Constitution (BINDING): months apart, never blocking, dismissible to silence,
// no nag, no score. Pull-never-push. You-drive: a "change" routes through the
// EXISTING profile goal flow (Me→Profile selector / setProfile) — nothing here
// auto-applies. Kind, never anxious.
//
// State rides entirely in app_state (no migration):
//   goal_checkin_confirmed_at — last time the user confirmed OR changed their
//                               goal (an epoch-ms stamp). ALSO seeded to "now"
//                               the first time we ever observe a profile, so the
//                               first prompt comes ~90 days into use, never on
//                               day one (a brand-new user is never nagged).
//   goal_checkin_dismissed_at — last time the card was waved off; we then stay
//                               quiet for a long cooldown.
// ----------------------------------------------------------------------------

const CONFIRMED_KEY = "goal_checkin_confirmed_at";
const DISMISSED_KEY = "goal_checkin_dismissed_at";

const DAY_MS = 86_400_000;
// Surface only once the goal has been stable a long time, and stay quiet for a
// long cooldown after a dismiss — this is months-apart by design, never a nag.
const STABLE_DAYS = 90; // ≈3 months since the last confirm/change before we ask
const DISMISS_COOLDOWN_DAYS = 60; // stay silent at least this long after a dismiss

function now(): number {
  return Date.now();
}

// Read an epoch-ms stamp out of app_state; null when absent or unparseable.
function readStamp(key: string): number | null {
  const raw = getAppState(key);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function writeStamp(key: string, ms: number): void {
  setAppState(key, String(Math.trunc(ms)));
}

// ---------- public stamping helpers ----------

// Stamp that the user has confirmed (or changed) their goal — restarts the
// stable-period clock so the next gentle check is ~3 months out. Called from the
// confirm/change paths (the existing profile goal flow).
export function confirmGoalCheckin(): void {
  writeStamp(CONFIRMED_KEY, now());
}

// Stamp that the card was waved off — start the dismiss cooldown so it stays
// quiet for a long while. Dismissible to silence (constitution).
export function dismissGoalCheckin(): void {
  writeStamp(DISMISSED_KEY, now());
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
//   • First observation: seed goal_checkin_confirmed_at = now and return null,
//     so a brand-new user's first prompt is ~STABLE_DAYS out, not on day one.
//   • Recently dismissed (within the cooldown) → null.
//   • Goal stable < STABLE_DAYS → null.
//   • Otherwise → a modest-priority, dismissible 'primary' candidate.
export function goalCheckinCandidate(): TodayAgendaCandidate | null {
  const prof = getProfile();
  if (!prof) return null; // no profile yet — nothing to check in on

  const t = now();

  // First-ever observation: seed the confirm stamp so the clock starts NOW
  // (never nag a fresh user — their first prompt lands ~STABLE_DAYS later).
  const confirmedAt = readStamp(CONFIRMED_KEY);
  if (confirmedAt == null) {
    writeStamp(CONFIRMED_KEY, t);
    return null;
  }

  // Respect a long cooldown after a dismiss — quiet means quiet.
  const dismissedAt = readStamp(DISMISSED_KEY);
  if (dismissedAt != null && t - dismissedAt < DISMISS_COOLDOWN_DAYS * DAY_MS) return null;

  // Only ask once the goal has genuinely been stable a long time. If the user
  // changed their goal more recently than the last dismiss, the confirm clock
  // already restarted (confirmGoalCheckin), so this is the single gate.
  const sinceConfirmMs = t - confirmedAt;
  if (sinceConfirmMs < STABLE_DAYS * DAY_MS) return null;

  const mode = effectiveGoalMode(prof);
  const monthsStable = Math.round(sinceConfirmMs / (30 * DAY_MS));
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
