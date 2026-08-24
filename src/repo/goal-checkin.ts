import { todayISO } from "../db.js";
import { type CadencePolicy, applyAttentionObservation, getAttentionSchedule } from "./attention.js";
import { type GoalMode, effectiveGoalMode, getProfile } from "./profile.js";
import { robustWeightEvidence } from "./weight-evidence.js";
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
// TRIGGER (round W2.2): the check-in fires on OBSERVED DIVERGENCE, not a fixed
// timer. It only surfaces once the measured bodyweight trend and the declared
// goal mode visibly disagree over a sustained window (`detectDivergence` below)
// — e.g. goal 'lose' but the trend hasn't cleared a real downward floor for
// ~4 weeks, or 'maintain' but the weight has drifted past a calm band. Thin
// weigh-in coverage reads as ABSENT, never as divergence — this never nags
// about missing logs. A long-horizon BACKSTOP (`BACKSTOP_DAYS`, ~6 months
// since the last check) still fires independent of weight evidence, so a
// genuine silent change of heart is caught even with a bare scale. Once shown,
// confirmed, or dismissed, a short cooldown (`MIN_RECHECK_DAYS`) holds it quiet
// so it never re-asks the next day. The check-in's prose and one-question shape
// are unchanged — only WHEN it fires.
//
// The shared K5 attention engine still records `last_checked` / a goal_change
// reactivation for this signal (bookkeeping other journey signals also use),
// but its tier ladder and `next_due` no longer gate firing — divergence and the
// backstop do.
// ----------------------------------------------------------------------------

const SIGNAL_KEY = "journey:goal-checkin";

const GOAL_POLICY: CadencePolicy = {
  signal_class: "journey:goal",
  domain: "journey",
  source: "goal-checkin",
  reason: "The measured trend and the declared goal have visibly disagreed for a while — a gentle check that it still fits.",
  release_condition:
    "The goal is stable and confirmed; it goes quiet until you change it, bring it up, or the trend diverges again.",
};

// How long the measured trend and the declared goal must have disagreed before
// the check-in is willing to speak up (mirrors the "sustained window" language
// in the spec — roughly a month, since a week or two of noise is normal).
const DIVERGENCE_WINDOW_DAYS = 28;
// Coverage floor for treating that window's weight evidence as real rather than
// absent (never infer divergence — or agreement — from a mostly-unlogged span).
const DIVERGENCE_MIN_WEIGH_INS = 6;
const DIVERGENCE_MIN_SPAN_DAYS = 21;
// A 'lose'/'gain' trend must clear this floor (lb/wk) to count as genuinely
// moving that direction — mirrors cut-quality's LOSS_TREND_FLOOR_LB_WK.
const LOSE_STALL_FLOOR_LB_WK = -0.25;
const GAIN_STALL_FLOOR_LB_WK = 0.25;
// A 'maintain' goal diverges once the window's net drift clears this band.
const MAINTAIN_DRIFT_BAND_LB = 3;
// After the card is shown, confirmed, or dismissed, hold it quiet at least this
// long even if the divergence persists — a calm cadence, never a daily nag.
const MIN_RECHECK_DAYS = 14;
// The long-horizon backstop: fires regardless of weight evidence so a genuine,
// silent change of heart is still caught (~6 months).
const BACKSTOP_DAYS = 180;

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// True when the measured bodyweight trend over the last DIVERGENCE_WINDOW_DAYS
// visibly disagrees with the declared goal mode. Thin coverage (few weigh-ins,
// short span) reads as absent evidence, not disagreement — never nags about
// missing logs.
function detectDivergence(mode: GoalMode, asOf: string): boolean {
  const since = addDaysISO(asOf, -DIVERGENCE_WINDOW_DAYS);
  const evidence = robustWeightEvidence(since, asOf);
  const adequate = evidence.weigh_ins >= DIVERGENCE_MIN_WEIGH_INS && evidence.span_days >= DIVERGENCE_MIN_SPAN_DAYS;
  if (!adequate || evidence.trend_lb_wk == null) return false;
  const trend = evidence.trend_lb_wk;
  if (mode === "lose") return trend > LOSE_STALL_FLOOR_LB_WK; // flat or trending up while trying to lose
  if (mode === "gain") return trend < GAIN_STALL_FLOOR_LB_WK; // flat or trending down while trying to gain
  // maintain: net drift over the window past the calm band, either direction.
  const netDriftLb = trend * (DIVERGENCE_WINDOW_DAYS / 7);
  return Math.abs(netDriftLb) > MAINTAIN_DRIFT_BAND_LB;
}

// ---------- public stamping helpers ----------

// Stamp that the user has confirmed their goal ("still my goal") — restamps
// last_checked, which resets the MIN_RECHECK_DAYS cooldown so the card won't
// re-ask tomorrow even if the trend is still technically diverging.
export function confirmGoalCheckin(): void {
  const prev = getAttentionSchedule(SIGNAL_KEY);
  const status = prev ? "clean" : "active";
  applyAttentionObservation({
    signal_key: SIGNAL_KEY,
    policy: GOAL_POLICY,
    observation: { checked_at: todayISO(), status },
  });
}

// A real goal CHANGE — restamp last_checked so the cooldown starts fresh under
// the new goal rather than immediately re-evaluating divergence against it.
// goal_change is a reactivating event in the attention engine (bookkeeping).
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
//   • No attention entry yet → seed it (never nag a fresh user on day one).
//   • Within MIN_RECHECK_DAYS of the last show/confirm/dismiss → null (calm
//     cadence, never a daily nag even while diverging).
//   • Otherwise fires when the trend diverges from the goal (adequate weigh-in
//     coverage required) OR the long-horizon backstop has elapsed.
export function goalCheckinCandidate(asOf: string = todayISO()): TodayAgendaCandidate | null {
  const prof = getProfile();
  if (!prof) return null; // no profile yet — nothing to check in on

  const entry = getAttentionSchedule(SIGNAL_KEY);

  // First-ever observation: seed the record (never nag a fresh user), then stay
  // quiet — there hasn't been time to observe a sustained divergence yet.
  if (!entry) {
    applyAttentionObservation({
      signal_key: SIGNAL_KEY,
      policy: GOAL_POLICY,
      observation: { checked_at: asOf, status: "active" },
    });
    return null;
  }

  const daysSinceChecked = daysBetween(entry.last_checked || asOf, asOf);
  if (daysSinceChecked < MIN_RECHECK_DAYS) return null; // recently shown/confirmed/dismissed — stay quiet

  const mode = effectiveGoalMode(prof);
  const diverging = detectDivergence(mode, asOf);
  const backstopDue = daysSinceChecked >= BACKSTOP_DAYS;
  if (!diverging && !backstopDue) return null; // stable goal, thin/agreeing evidence, backstop not due — quiet

  const monthsStable = Math.max(1, Math.round(daysSinceChecked / 30));
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
