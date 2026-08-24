// The one ACTION the low-energy-availability watch is allowed to take.
//
// `src/repo/energy-deficiency.ts` decides whether the cluster is standing; this
// module turns a standing cluster into exactly two things, once, and never more
// than that:
//
//   1. ONE bounded protective raise of the calorie target, through the ordinary
//      propose → apply path and the autonomy ledger — so it carries a decision row,
//      a server-owned one-tap Undo, and the boundary re-validation every queued
//      target crosses. The size is already capped by `capProtectiveRaise` inside the
//      decision, which is why nothing here re-derives a ceiling of its own.
//   2. ONE calm explanation, in the insight register: what the pattern looks like,
//      in the athlete's own vocabulary. It WAITS in-app — no notification, no nag —
//      and it never uses clinical language or names a syndrome.
//
// Everything else this module does is refusal: a cooldown so a chronic condition
// cannot ratchet the target one bounded step per day (which is exactly how the
// under-fuelling escape once walked a cut past maintenance), and an early return on
// every state that is not a standing cluster.
//
// THE EXIT IS NOT CODED HERE ON PURPOSE. When the arms recover the watch stops
// finding a cluster, this loop no-ops, and the cut resumes through the ordinary cut
// derivation. A dedicated "resume the cut" path would be a second way to set the
// target, and two ways to set one number is how they come to disagree.

import { applyProposalWithAutonomy } from "./autonomy-service.js";
import { hasRecentDecisionVeto, insertBrainExpectation, listBrainDecisions } from "../../repo/brain-decisions.js";
import { addInsight } from "../../repo/coach.js";
import { getActiveNutritionTarget } from "../../repo/nutrition.js";
import { createProposal, getProposal } from "../../repo/profile.js";
import { db } from "../../db.js";
import {
  type EnergyDeficiencyRead,
  energyDeficiencyBody,
  hrvWatchTrend,
  SUSTAINED_DAYS,
} from "../../repo/energy-deficiency.js";
// The memoized read, so the scheduler pass and the coach prompt can never describe
// the same day differently.
import { currentEnergyDeficiencyRead } from "../../repo/energy-deficiency-snapshot.js";
import { buildTrainingFeedbackExpectations } from "../../repo/brain/change-expectations.js";
import type { ProposedExpectation } from "../../brain/expectation-contract.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "../../repo/shared.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";

// One protective move, then a fortnight before another can even be considered. The
// cluster this watch reads is a CHRONIC state, not an event: without this, every
// daily pass would find the same standing cluster and add another bounded step.
const ACTION_COOLDOWN_DAYS = 14;
const WATCH_AGENT = "energy-deficiency-brain";
const WATCH_INSTRUCTION = "auto: protective fuel raise, sustained deficit cost";
// The insight's territorial identity, so the same explanation is never told twice —
// including by a DIFFERENT generator that reaches the same connection. The key is
// `<facetA>~<facetB>:<polarity>` with the facets sorted and each one a real dotted
// facet from src/repo/insight-intent.ts; an invented pair ("fuel~recovery") parses to
// nothing, and cross-generator dedup then silently does not apply to this insight at all.
const INSIGHT_INTENT_KEY = "nutrition.calories~recovery.readiness:same";
const INSIGHT_KIND = "connection";
// How long the arms have to recover before the ledger asks whether this worked.
const EXPECTATION_WINDOW_DAYS = 21;

export interface EnergyDeficiencyWatchResult {
  ok: true;
  read: EnergyDeficiencyRead;
  action: "none" | "protective_raise_scheduled";
  nutrition: any | null;
  insight_id: number | null;
  expectations: number;
  reason: string;
}

/**
 * Has one of this watch's protective moves already been SETTLED inside the window —
 * either by landing, or by the athlete saying no?
 *
 * Read off the ledger rather than a stamp written at decision time, and that is the
 * whole point. A nutrition target never applies when it is decided — it waits for a
 * food-day boundary, which re-validates it against that day's evidence and may set it
 * aside. A stamp written at decision time therefore bought a fortnight of silence for
 * a change that might never happen: the watch slept while the cluster still stood and
 * the athlete's food had not moved. The ledger cannot lie about that, and it needs no
 * second write to stay true — the boundary that applies the decision IS the stamp.
 *
 * A DECLINE COUNTS THE SAME AS A LANDING, and it is a different thing from a
 * set-aside. When the boundary sets a raise aside, the EVIDENCE declined it and the
 * watch may legitimately come back tomorrow with a re-derived one. When the ATHLETE
 * declines it — rejected, reverted after applying, or held on the announcement — they
 * have answered the question, and asking again tomorrow is nagging. Counting only
 * `applied` here meant a declined raise was re-proposed every single day forever
 * (a discard also clears the in-flight guard, so nothing else stopped it). So every
 * terminal status of our own opens the same fortnight: the athlete's answer buys the
 * quiet that an applied change buys.
 */
const SETTLED_STATUSES = ["applied", "rejected", "reverted", "canceled"];

function settledWithinCooldown(today: string): boolean {
  try {
    return ourDecisions(SETTLED_STATUSES).some((decision) => {
      // Only an applied row carries `applied_at`; a decline is dated by when it was
      // decided. The effective date is the last resort, for a row carrying neither.
      const settled = String(
        (decision as any).applied_at ?? (decision as any).created_at ?? decision.effective_date ?? ""
      ).slice(0, 10);
      const age = /^\d{4}-\d{2}-\d{2}$/.test(settled) ? daysBetweenISO(today, settled) : null;
      return age != null && age >= 0 && age < ACTION_COOLDOWN_DAYS;
    });
  } catch {
    return false;
  }
}

/**
 * This watch's own decisions in the given statuses.
 *
 * Identity is `decision.source`, which the autonomy layer copies from the proposal's
 * agent and which SURVIVES apply. The proposal reference does not: applying a
 * nutrition target re-points `source_ref_type`/`source_ref_key` at the
 * `nutrition_targets` row it wrote, so a guard that reached back through the proposal
 * silently stopped recognising its own landed moves — and a settling window that
 * cannot see the change it is settling is not a settling window at all.
 */
function ourDecisions(statuses: string[]): any[] {
  return listBrainDecisions({ domain: "nutrition", kind: "nutrition_target", limit: 50 }).filter(
    (decision) => statuses.includes(String(decision.status)) && String(decision.source) === WATCH_AGENT
  );
}

function decisionIsOwned(decision: any): boolean {
  return !!decision && ["pending", "announced", "applied"].includes(String(decision.status));
}

/**
 * Is one of THIS watch's protective moves already decided and waiting to land?
 *
 * Matched by the proposal's agent + instruction, the same single-source identity the
 * under-fuelling controller keys its own dedup off, so a rename cannot silently break
 * it. Only the un-landed statuses count: an applied move is the cooldown's business.
 */
function moveAlreadyInFlight(): boolean {
  try {
    return ourDecisions(["pending", "announced", "review"]).some((decision) => {
      // Before it lands the decision still points at its draft, and the draft's
      // instruction is the second half of the identity.
      if (String(decision.source_ref_type) !== "plan_proposal") return true;
      const proposal = getProposal(Number(decision.source_ref_key)) as any;
      return !!proposal && proposal.status === "draft" && String(proposal.instruction) === WATCH_INSTRUCTION;
    });
  } catch {
    // Unreadable ledger: fall through to proposing. The boundary cap and the
    // maintenance ceiling still bound whatever this produces.
    return false;
  }
}

/**
 * The falsifiable half: the arms that fired are the arms that must come back.
 *
 * Written under the same rule every other expectation writer here obeys — a
 * prediction is only written when the evidence that could falsify it is ALREADY
 * being produced. No watch, no HRV expectation; no rated sessions, no feedback one.
 * An expectation that can never mature is ledger rot, and absence is never a miss.
 */
function armRecoveryExpectations(read: EnergyDeficiencyRead, today: string): ProposedExpectation[] {
  const out: ProposedExpectation[] = [];
  const windowEnd = addDaysISO(today, EXPECTATION_WINDOW_DAYS) ?? today;
  if (read.met_keys.includes("recovery_and_performance")) {
    const hrv = hrvWatchTrend(today);
    if (hrv.direction !== "absent" && hrv.baseline_avg != null) {
      out.push({
        metric_key: "recovery_hrv_delta",
        subject_key: null,
        direction: "at_least",
        baseline: { hrv_avg_ms: hrv.baseline_avg, recent_avg_ms: hrv.recent_avg, nights: hrv.samples },
        // The claim is "the drift stops", not "HRV climbs back to a number". The
        // evaluator compares this window's own two halves, so zero is exactly that.
        target: { value: 0 },
        window_start: today,
        window_end: windowEnd,
        minimum_data: { nights: 6 },
        confounder_policy: "exclude_context_events",
        confidence: "tentative",
        evaluator: "recovery_delta",
        evaluator_version: "energy-deficiency-hrv-recovery-v1",
      });
    }
    // The performance half rides the shared builder rather than a second copy of the
    // same baseline read; the joint-pain guard it also writes is not this change's
    // claim, so only the feedback expectation is kept.
    for (const expectation of buildTrainingFeedbackExpectations(today)) {
      if (expectation.metric_key === "session_performance_feedback") out.push(expectation);
    }
  }
  return out;
}

function protectiveProposal(read: EnergyDeficiencyRead, today: string): any | null {
  const target = Number(read.protection.target_kcal);
  const previous = Number(read.protection.from_kcal);
  if (!Number.isFinite(target) || !Number.isFinite(previous) || target <= previous) return null;
  const active = getActiveNutritionTarget(today) as any;
  const macro = (value: unknown): number | null => {
    const parsed = Number(value ?? Number.NaN);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };
  const delta = Math.round(target - previous);
  const protein = macro(active?.protein_g);
  const carbs = macro(active?.carbs_g);
  const fat = macro(active?.fat_g);
  return createProposal(WATCH_AGENT, WATCH_INSTRUCTION, "", {
    kind: "nutrition_target",
    summary: `Move fuel ${delta} kcal back toward maintenance while several recovery and training signals settle.`,
    rationale: read.reason,
    nutrition: {
      target_kcal: Math.round(target),
      prev_target_kcal: Math.round(previous),
      // Protein is carried forward untouched — this raise moves calories, and
      // trimming protein as a side effect of protecting a deficit would be absurd.
      protein_g: protein,
      carbs_g: carbs == null ? null : carbs + Math.round(delta / 4),
      fat_g: fat,
      delta_kcal: delta,
      reason: read.protection.reason,
      energy_deficiency_signature: read.signature,
    },
  });
}

/**
 * The one calm explanation, told once. Deduped on the intent key rather than on the
 * wording, so a re-worded variant of the same connection cannot slip past.
 */
function explainOnce(read: EnergyDeficiencyRead, today: string): number | null {
  try {
    const existing = db
      .prepare(
        `SELECT id FROM insights WHERE intent_key = ? AND status <> 'dismissed'
           AND date(COALESCE(created_at, ?)) >= date(?) ORDER BY id DESC LIMIT 1`
      )
      .get(INSIGHT_INTENT_KEY, today, addDaysISO(today, -60) ?? today) as any;
    if (existing) return null;
    const row = addInsight({
      kind: INSIGHT_KIND,
      text: energyDeficiencyBody(read, today),
      rationale:
        "Several signals that usually move on their own — overnight recovery, how sessions have felt, the pace of the scale — have been drifting together while the deficit ran. Nothing here is a medical read; it is a pattern worth easing rather than pushing through.",
      intent_key: INSIGHT_INTENT_KEY,
    }) as any;
    return row?.id == null ? null : Number(row.id);
  } catch {
    // The raise is the protection; the explanation is the courtesy. A failure to
    // write it must never cost the athlete the protective move.
    return null;
  }
}

/**
 * The deterministic watch pass. Most calls are a no-op, and the common answer is
 * "the deficit is not costing more than fat".
 */
export function runEnergyDeficiencyWatch(
  today = localDateISO(),
  opts: { read?: EnergyDeficiencyRead } = {}
): EnergyDeficiencyWatchResult {
  const read = opts.read ?? currentEnergyDeficiencyRead(today);
  const none = (reason: string): EnergyDeficiencyWatchResult => ({
    ok: true,
    read,
    action: "none",
    nutrition: null,
    insight_id: null,
    expectations: 0,
    reason,
  });

  if (read.state !== "sustained_cluster") return none(read.reason);
  if (settledWithinCooldown(today))
    return none(
      `A protective move has already been decided one way or the other inside the ${ACTION_COOLDOWN_DAYS}-day settling window.`
    );
  // …and a recent "no" to ANY calorie-target change is the athlete telling the whole
  // nutrition lane to leave their target alone. The same read the orphan-adoption path
  // consults, for the same reason: a veto is an answer, and re-asking around it is how
  // a bounded protective system turns into a nag.
  if (hasRecentDecisionVeto("nutrition_target", ACTION_COOLDOWN_DAYS))
    return none("You recently declined a change to your calorie target, so this one waits rather than asking again.");
  // A queued move has not stamped the cooldown (see below), so THIS is what stops a
  // daily pass minting a second proposal for the same standing cluster while the
  // first one waits for its food-day boundary.
  if (moveAlreadyInFlight()) return none("A protective move is already waiting for the next food-day boundary.");
  if (!read.protection.raise) return none(read.protection.reason);

  let scheduled: any = null;
  let insightId: number | null = null;
  let expectations = 0;
  try {
    scheduled = withSqliteSavepoint("energy_deficiency_protection", () => {
      const proposal = protectiveProposal(read, today);
      if (!proposal) return null;
      const result = applyProposalWithAutonomy(Number(proposal.id), {
        // Requested, never chosen: the tier itself is server policy, and a protective
        // bounded change is exactly what quiet_apply exists for. A stricter posture
        // (lead_mode, the clinician floor) still overrides this downward.
        requested_tier: "quiet_apply",
        safety_response: true,
      });
      if (!decisionIsOwned(result?.decision)) return result;
      for (const expectation of armRecoveryExpectations(read, today)) {
        try {
          insertBrainExpectation(Number(result.decision.id), expectation);
          expectations++;
        } catch {
          /* one unwritable prediction must not sink the protective move */
        }
      }
      insightId = explainOnce(read, today);
      // Nothing is stamped here. The settling window is measured off the ledger row
      // the boundary writes when the change actually lands (`landedWithinCooldown`),
      // and until then the in-flight guard above is what keeps a daily pass from
      // minting a second proposal for the same standing cluster.
      return result;
    });
  } catch {
    return none("The protective move could not be scheduled atomically; nothing was stamped, so Cairn can retry.");
  }

  if (!decisionIsOwned(scheduled?.decision)) {
    return none(
      scheduled?.review_required
        ? "The protective move is waiting for your decision under the configured posture; no cooldown was recorded."
        : "There is no accepted target for a protective move to lift."
    );
  }
  return {
    ok: true,
    read,
    action: "protective_raise_scheduled",
    nutrition: scheduled,
    insight_id: insightId,
    expectations,
    reason: `Two arms have held for ${SUSTAINED_DAYS} days, so one bounded step back toward measured maintenance is scheduled; the cooldown blocks a second.`,
  };
}
