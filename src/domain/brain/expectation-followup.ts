import type { BrainEvaluation } from "../../brain/evaluation-contract.js";
import type { BrainMetricKey } from "../../brain/expectation-contract.js";
import { getBrainDecision, getBrainExpectation } from "../../repo/brain-decisions.js";
import {
  type AttentionDomain,
  type AttentionScheduleEntry,
  EXPECTATION_FOLLOWUP_SOURCE,
  getAttentionSchedule,
  listAttentionBySource,
  upsertAttentionSchedule,
} from "../../repo/attention.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { addDaysISO, clipText, localDateISO } from "../../repo/shared.js";

// A change that demonstrably missed its prediction used to stay applied forever
// with nobody told. This turns that one fact into ONE quiet in-app note, filed on
// the attention schedule the rest of the app already reads.
//
// Deliberately narrow:
//   • Nothing is reverted. Autonomy is server policy, and a missed prediction is
//     information, not a mandate — the athlete drives.
//   • Nothing is pushed. The note waits in-app exactly like every other insight.
//   • One note per CHANGE, not per prediction. A decision whose several
//     expectations all miss is still one story, and the signal key is the dedupe:
//     once written (even after it goes quiet) that decision never speaks again.
//   • It goes quiet on its own. Standing follow-ups are released after
//     FOLLOWUP_STANDING_DAYS, or the moment the change behind them is no longer
//     the one in force, so a note can never become a permanent resident.

// How long one note is allowed to stand before it goes quiet by itself.
const FOLLOWUP_STANDING_DAYS = 21;

// The metrics that describe the EFFECT of a change the coach made. day_read_adherence
// is deliberately absent: it is the daily heartbeat of whether a morning read was
// followed, and a diverged day is the athlete's call, never a failed change.
const CHANGE_EFFECT_METRICS = new Set<BrainMetricKey>([
  "weight_trend_lb_wk",
  "intake_to_weight_response",
  "exercise_target_completion",
  "exercise_est_1rm_trend",
  "session_performance_feedback",
  "joint_pain_or_soreness",
  "plan_day_adherence",
  "run_volume_adherence",
  "vo2max_trend",
]);

const FOLLOWUP_DOMAINS = new Set(["training", "recovery", "nutrition"]);

const RUNNING_METRICS = new Set<BrainMetricKey>(["run_volume_adherence", "vo2max_trend"]);

// One phrasing per rule printed verbatim for weeks is what makes an app feel
// robotic, so this is a variant set rotated by date + decision, never a literal.
// Every line is a suggestion in the athlete's own register: no score, no verdict,
// no "you must".
const MISS_VARIANTS = [
  "that change hasn't done what we hoped — worth a look when you have a minute",
  "that adjustment hasn't landed the way we expected; worth revisiting together",
  "what we changed hasn't shown up the way we thought it would — it might be worth another look",
  "that one hasn't played out the way we expected. No rush, but it's worth a second look",
  "we expected more from that change than what's turned up so far — worth talking through",
] as const;

const RELEASE_CONDITION =
  "It goes quiet on its own once it has had its say, or as soon as the change behind it is no longer the one in force.";

function attentionDomain(domain: string, metricKey: BrainMetricKey): AttentionDomain {
  if (RUNNING_METRICS.has(metricKey)) return "running";
  if (domain === "nutrition") return "nutrition";
  if (domain === "recovery") return "recovery";
  return "training";
}

function followupSignalKey(domain: AttentionDomain, decisionId: number): string {
  return `${domain}:change-check:d${decisionId}`;
}

/**
 * Turn this run's `not_aligned` verdicts into calm in-app notes. Returns the
 * entries actually written — an already-noted change, a still-aligned one, and a
 * health/lab metric all return nothing.
 */
export function surfaceExpectationMisses(
  evaluations: readonly BrainEvaluation[],
  asOf = localDateISO()
): AttentionScheduleEntry[] {
  const written: AttentionScheduleEntry[] = [];
  const handled = new Set<string>();
  for (const evaluation of evaluations) {
    if (evaluation.verdict !== "not_aligned") continue;
    try {
      const expectation = getBrainExpectation(Number(evaluation.expectation_id));
      if (!expectation || !CHANGE_EFFECT_METRICS.has(expectation.metric_key)) continue;
      const decision = getBrainDecision(expectation.decision_id);
      if (!decision?.id || !FOLLOWUP_DOMAINS.has(decision.domain)) continue;
      // Only a change that actually LANDED can have missed. A held or advisory
      // record has nothing in force to look at.
      if (decision.status !== "applied" && decision.status !== "announced") continue;
      const domain = attentionDomain(decision.domain, expectation.metric_key);
      const signalKey = followupSignalKey(domain, decision.id);
      // The dedupe that makes this nag exactly once: an existing row — active or
      // long since released — means this change has already had its note.
      if (handled.has(signalKey) || getAttentionSchedule(signalKey)) continue;
      handled.add(signalKey);
      const variant = pickDayVariant(MISS_VARIANTS, asOf, `change-check:${decision.id}`);
      const summary = clipText(decision.summary, 90, { ellipsis: "..." });
      written.push(
        upsertAttentionSchedule({
          signal_key: signalKey,
          domain,
          tier: "active",
          // Due at the END of its standing window, not the day it is written. The one
          // athlete-facing reader (team-week's `watching`) shows an entry whose
          // `next_due` falls between today and three weeks out, so a due date of `asOf`
          // was readable for exactly one day — and the signal-key dedupe then silenced
          // that change forever. Dated forward, the note stands for the whole window and
          // expires exactly when releaseStaleExpectationFollowups retires it below.
          // The trade: a forward due date keeps it out of listDueAttention's due-NOW
          // coach feed for the same 21 days, which costs nothing — the conductor already
          // filters these follow-ups out of that feed, and the athlete is the audience.
          next_due: addDaysISO(asOf, FOLLOWUP_STANDING_DAYS) ?? asOf,
          last_checked: asOf,
          reason: summary ? `${summary} — ${variant}.` : `${variant.charAt(0).toUpperCase()}${variant.slice(1)}.`,
          release_condition: RELEASE_CONDITION,
          source: EXPECTATION_FOLLOWUP_SOURCE,
          state: {
            clean_checks: 0,
            confirming_checks: 0,
            surveillance_checks: 0,
            surveillance_interval_days: FOLLOWUP_STANDING_DAYS,
            last_event: "intervention_changed",
          },
        })
      );
    } catch {
      // One malformed historical row must never stop the nightly pass.
    }
  }
  return written;
}

/**
 * Retire standing follow-up notes. A note goes quiet after it has stood for
 * FOLLOWUP_STANDING_DAYS, and immediately if the change it is about has since
 * been undone or replaced — there is nothing left to look at either way. The row
 * itself is kept (released, so no surface reads it) because it is also the
 * dedupe record that stops the same change speaking twice.
 */
export function releaseStaleExpectationFollowups(asOf = localDateISO()): number {
  const cutoff = addDaysISO(asOf, -FOLLOWUP_STANDING_DAYS) ?? asOf;
  let released = 0;
  for (const entry of listAttentionBySource(EXPECTATION_FOLLOWUP_SOURCE, { limit: 200 })) {
    try {
      const decisionId = Number(entry.signal_key.split(":d").pop());
      const decision = Number.isInteger(decisionId) && decisionId > 0 ? getBrainDecision(decisionId) : null;
      const changeGone = !decision || (decision.status !== "applied" && decision.status !== "announced");
      if (!changeGone && entry.last_checked > cutoff) continue;
      upsertAttentionSchedule({ ...entry, tier: "released", next_due: null });
      released++;
    } catch {
      // Retirement is bookkeeping; it must never sink the pass.
    }
  }
  return released;
}
