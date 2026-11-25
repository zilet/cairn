// ============================================================================
// recovery-week-change.ts — an EARNED recovery week is set up by the coach, and said.
//
// It lightens a real person's week by itself, so when in doubt it does nothing.
//
// Once a day (the scheduler's recovery slot) this reads whether the week that starts next
// Monday has earned a lighter one (repo/recovery-week-earned.ts):
//   - `streak` / `fatigue`: the mesocycle reads deload-due — six loaded weeks in a row, or
//     four plus a shortfall the log confirms plus physiology (program-state.ts);
//   - `scheduled`: the block's own deload week falls on that week and will really run
//     (block-phase.ts). A push athlete with no loaded-weeks evidence runs that week as
//     intensification, so for them nothing lightens. A week the loaded weeks earned that
//     lands ON the block's deload week is stamped `scheduled` too (its sentence keeps the
//     loaded-weeks reason): it is that week of the block, so the block advances through
//     it instead of pausing and running its deload a second time.
//   - Landing on a new block's first week (or on no block): it is an inserted week, the
//     block pauses through it and simply starts after it — one lighter week, never two.
// When it is earned and nothing holds it, it writes ONE recovery week — no agent: the plan
// as it stands at the recovery dose (recovery-week.ts recoveryWeekPlanDays, the overlay's
// own numbers: about half the working sets, the load eased by a tenth, every movement
// kept), under the canonical recovery-week instruction, so the existing state machine,
// the overlay apply and its Undo (revertRecoveryWeekIfOwned) carry it unchanged.
//
// Server policy picks the tier from the change's shape (a recovery `training_structure`)
// and `settings.lead_mode` (decideAutonomyTier, untouched): lead and announce_first
// announce it, and it lands at the next Monday with the server-owned Undo;
// review_everything holds exactly one draft for a yes.
//
// Its premise is its own read, never the generic evidence fingerprint (serverPremise in
// autonomy-service.ts → recoveryWeekStillEarned): sessions logged before Monday do not
// park it as a question. A light week that breaks the streak, or a cycle that opened,
// withdraws it quietly; a hold that arrives (a race window, a trip, the fuel package's
// own week, the athlete's "no") withdraws it quietly too; a read that fails waits a day,
// and a Monday that passes withdraws it — a recovery week never lands mid-week.
//
// Holds that stop a new week (and withdraw an open one): a race taper, race week or the
// days after a race touching the landing week; a bounded trip over three or more of its
// days; any recovery week already drafted, coming or running (the fuel package's
// included — never two); the 21-day cooldown after the last; the athlete's refusal in
// this block (a Hold before Monday, an Undo after it lands, or a held one set aside),
// unless something safety-grade has arrived since (recovery-refusal.ts). Pain, the cut
// and untested slots are NOT holds: a lighter week is the protective answer to all three.
//
// In-app only: nothing here notifies or pushes. Every read fails CLOSED to `unavailable`.
// ============================================================================
import { nextNaturalBoundary } from "../../brain/autonomy.js";
import { getPlan } from "../../repo/plan.js";
import { createProposal, getProposal, setProposalStatus } from "../../repo/proposals.js";
import {
  EARNED_RECOVERY_ARMS,
  earnedRecoveryWeek,
  type RecoveryWeekArm,
  type RecoveryWeekHoldReason,
  recoveryWeekHold,
  recoveryWeekMark,
  recoveryWeekProposalPayload,
  recoveryWeekStillEarned,
} from "../../repo/recovery-week-earned.js";
import { RECOVERY_WEEK_AGENT, RECOVERY_WEEK_INSTRUCTION } from "../../repo/recovery-week.js";
import { db } from "../../db.js";
import { getActiveBlock } from "../../repo/program-blocks.js";
import { localDateISO } from "../../repo/shared.js";
import { withSqliteSavepoint } from "../../repo/sqlite-savepoint.js";
import { applyProposalWithAutonomy } from "./autonomy-service.js";

export interface RecoveryWeekOutcome {
  /**
   * none: nothing is earned (or there is no lifting day to lighten); held: earned, but a
   * hold stands (`hold` says which) — nothing new, and an open draft it touches was
   * withdrawn; declined: earned, but the athlete said no in this block; standing: an open
   * draft (on its way to its Monday, or held for a yes) already covers it; changed: a new
   * week was routed and policy let it act (announced for its Monday); asked: policy held the
   * new week for the athlete's yes; deferred: `act:false` — nothing routed; unavailable: a
   * read failed — nothing changed, nothing withdrawn; would_change: a dry run — what an
   * acting pass would route.
   */
  status:
    | "none"
    | "held"
    | "declined"
    | "standing"
    | "changed"
    | "asked"
    | "deferred"
    | "unavailable"
    | "would_change";
  /** Why the week is earned: the loaded-weeks streak, the log-confirmed fatigue, or the block's deload. */
  arm: RecoveryWeekArm | null;
  /** The loaded weeks behind an earned week, when counted. */
  loaded_weeks: number | null;
  /** The Monday the week lands on (or would). */
  lands_on: string | null;
  /** The autonomy tier of the open or new draft (announce | ask), when there is one. */
  tier: string | null;
  proposal_id: number | null;
  decision_id: number | null;
  /** When the routed week lands, as the ledger has it. */
  effective_date: string | null;
  /** What the week is, for the athlete. */
  summary: string | null;
  /** Why, for the athlete. */
  explanation: string | null;
  /** Server-written recovery drafts withdrawn quietly on this pass. */
  withdrawn: number[];
  /** Why nothing new was set up, when status is "held" or "declined". */
  hold?: RecoveryWeekHoldReason;
  /** A dry run's plan snapshot at the recovery dose, exactly as it would be written. */
  days?: any[];
}

function outcome(
  status: RecoveryWeekOutcome["status"],
  withdrawn: number[],
  extra: Partial<RecoveryWeekOutcome> = {}
): RecoveryWeekOutcome {
  return {
    status,
    arm: null,
    loaded_weeks: null,
    lands_on: null,
    tier: null,
    proposal_id: null,
    decision_id: null,
    effective_date: null,
    summary: null,
    explanation: null,
    withdrawn,
    ...extra,
  };
}

function draftOutcome(
  status: RecoveryWeekOutcome["status"],
  proposalId: number,
  withdrawn: number[],
  extra: Partial<RecoveryWeekOutcome> = {}
): RecoveryWeekOutcome {
  const proposal = getProposal(proposalId) as any;
  const mark = recoveryWeekMark(proposal?.parsed);
  const autonomy = proposal?.autonomy ?? null;
  return outcome(status, withdrawn, {
    arm: mark?.arm ?? null,
    loaded_weeks: mark?.loaded_weeks ?? null,
    lands_on: mark?.lands_on ?? null,
    tier: autonomy?.tier ?? null,
    proposal_id: proposalId,
    decision_id: autonomy?.id ?? null,
    effective_date: autonomy?.effective_date ?? null,
    summary: typeof proposal?.parsed?.summary === "string" ? proposal.parsed.summary : null,
    explanation: typeof proposal?.parsed?.rationale === "string" ? proposal.parsed.rationale : null,
    ...extra,
  });
}

// The open server-written EARNED recovery drafts, newest first. The person's own tap
// (`asked`) is theirs and never settled here.
function openEarnedDrafts(): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM plan_proposals
        WHERE status = 'draft' AND agent = ? AND parsed_json IS NOT NULL
        ORDER BY id DESC LIMIT 20`
    )
    .all(RECOVERY_WEEK_AGENT) as Array<{ id: number }>;
  return rows
    .map((row) => Number(row.id))
    .filter((id) => EARNED_RECOVERY_ARMS.has(String(recoveryWeekMark((getProposal(id) as any)?.parsed)?.arm ?? "")));
}

function withdraw(id: number, withdrawn: number[]): void {
  // Quietly: the athlete did not answer it, so it is not a "no", and a receipt in the
  // Changes feed would be news about nothing they did. A waiting decision on it is canceled.
  setProposalStatus(id, "superseded", { recordDecision: false });
  withdrawn.push(id);
}

function route(payload: any, withdrawn: number[]): RecoveryWeekOutcome {
  let id = 0;
  try {
    return withSqliteSavepoint("earned_recovery_week", () => {
      const proposal = createProposal(RECOVERY_WEEK_AGENT, RECOVERY_WEEK_INSTRUCTION, "", payload) as any;
      id = Number(proposal?.id);
      if (!Number.isFinite(id) || id <= 0) return outcome("none", withdrawn);
      // The ordinary path: no requested tier. Server policy reads the change's shape and
      // the lead mode, and the premise above replaces the evidence fingerprint.
      const routed = applyProposalWithAutonomy(id, {});
      if (routed?.review_required === true) return draftOutcome("asked", id, withdrawn);
      if (routed?.ok === true && routed?.superseded !== true && routed?.decision?.id != null) {
        return draftOutcome("changed", id, withdrawn, {
          tier: String(routed.tier ?? routed?.decision?.autonomy_tier ?? "") || null,
          effective_date: routed.effective_date ?? routed?.decision?.effective_date ?? null,
        });
      }
      // A routing that neither acted nor held (its premise went in the same breath)
      // leaves nothing behind.
      if ((getProposal(id) as any)?.status === "draft") setProposalStatus(id, "superseded", { recordDecision: false });
      return outcome("none", withdrawn);
    });
  } catch {
    // The savepoint rolled the draft back with the routing: nothing was written.
    return outcome("unavailable", withdrawn);
  }
}

/**
 * Settle the earned recovery week for the week that starts next Monday: keep the open
 * draft whose premise stands, withdraw quietly the ones whose premise went, and — when
 * none is open, the week is earned, and nothing holds it — route ONE deterministic
 * recovery week through the ordinary autonomy path. `act:false` never routes. `dry:true`
 * writes nothing at all and reports what the pass WOULD do. Idempotent. Never throws:
 * every read fails CLOSED to "unavailable".
 */
export function settleEarnedRecoveryWeek(
  opts: { date?: string; act?: boolean; dry?: boolean } = {}
): RecoveryWeekOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const dry = opts.dry === true;
  const act = opts.act !== false;
  const withdrawn: number[] = [];
  try {
    const landsOn = nextNaturalBoundary("training_structure", date);
    const retire = (id: number) => (dry ? withdrawn.push(id) : withdraw(id, withdrawn));

    // 1. Open drafts: the first whose premise stands is kept; every other one is moot. A
    //    premise that cannot be read keeps its draft and changes nothing today.
    let open: number | null = null;
    for (const id of openEarnedDrafts()) {
      const proposal = getProposal(id) as any;
      const live = ["review", "pending", "announced"].includes(String(proposal?.autonomy?.status ?? ""));
      const premise = live ? recoveryWeekStillEarned(proposal?.parsed, date, id) : "gone";
      if (premise === "unknown") return outcome("unavailable", withdrawn, { lands_on: landsOn });
      if (open == null && premise === "fits") {
        open = id;
        continue;
      }
      retire(id);
    }
    if (open != null) return draftOutcome("standing", open, withdrawn);

    // 2. Earned?
    const earned = earnedRecoveryWeek(date, landsOn);
    if (earned.status === "unknown") return outcome("unavailable", withdrawn, { lands_on: landsOn });
    if (earned.status === "none") return outcome("none", withdrawn, { lands_on: landsOn });
    const basis = { arm: earned.arm, loaded_weeks: earned.loaded_weeks, lands_on: landsOn };

    // 3. Held? A dry run reads the drafts it would have withdrawn as withdrawn, so the
    //    preview says what the acting pass would do, not "held" by its own leftovers.
    const hold = recoveryWeekHold(date, landsOn, { exceptProposalIds: dry ? withdrawn : [] });
    if (hold.status === "unknown") return outcome("unavailable", withdrawn, basis);
    if (hold.status === "hold")
      return outcome(hold.reason === "refused" ? "declined" : "held", withdrawn, { ...basis, hold: hold.reason });

    if (!act) return outcome("deferred", withdrawn, basis);

    // 4. The week itself: the plan as it stands, at the recovery dose.
    let plan: any[];
    try {
      plan = getPlan() as any[];
    } catch {
      return outcome("unavailable", withdrawn, basis);
    }
    let blockId: number | null = null;
    try {
      blockId = getActiveBlock()?.id ?? null;
    } catch {
      blockId = null;
    }
    const payload = recoveryWeekProposalPayload({
      arm: earned.arm,
      loaded_weeks: earned.loaded_weeks,
      ...(earned.status === "earned" && earned.basis ? { basis: earned.basis } : {}),
      date,
      lands_on: landsOn,
      plan,
      signature: `${earned.arm}:${blockId ?? "no-block"}:${landsOn}`,
    });
    if (!payload) return outcome("none", withdrawn, basis);
    if (dry) {
      return outcome("would_change", withdrawn, {
        ...basis,
        summary: payload.summary,
        explanation: payload.rationale,
        days: payload.days,
      });
    }
    return route(payload, withdrawn);
  } catch {
    // Any read that threw is a read that failed: nothing changed past this point.
    return outcome("unavailable", withdrawn);
  }
}

/**
 * What the next acting pass WOULD do, without writing anything: no draft, no withdrawal,
 * no decision. Read-only (REST GET /plan/recovery-week-preview, MCP
 * get_recovery_week_preview).
 */
export function previewEarnedRecoveryWeek(opts: { date?: string } = {}): RecoveryWeekOutcome {
  return settleEarnedRecoveryWeek({ date: opts.date, act: true, dry: true });
}
