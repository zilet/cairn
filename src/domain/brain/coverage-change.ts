// ============================================================================
// coverage-change.ts — a standing coverage gap is CLOSED by the coach, and said.
//
// It edits a real person's plan by itself, so when in doubt it does nothing.
//
// When the plan of record, as written, leaves a floored group under its weekly floor or a
// movement family out of a broad week (plan-coverage.ts reads both off the plan
// compiler's one definition), the server computes ONE bounded step for ONE gap
// (plan-coverage.ts coverageRemedy / rankCoverageGaps): at most COVERAGE_PASS_SET_CAP sets
// on lifts already in the plan that have an established habit with room under ~1.2× it,
// else ONE lift the athlete has real history with, at its minimum dose; a step short of
// the whole gap says "a first step". It routes through the ORDINARY autonomy path
// (applyProposalWithAutonomy, no refused-floor clamp). Server policy picks the tier from
// the change's shape and `settings.lead_mode`:
//   - sets on lifts already in the plan are a bounded, reversible `training_target`:
//     quiet_apply under lead (announce when the domain is demoted), announce under
//     announce_first, ask under review_everything;
//   - a remedy that ADDS a lift is structural: it asks to be announced (the autonomy layer
//     reads that off the draft, coverageAddsLift), so lead and announce_first announce it,
//     and review_everything asks.
// A gap that exists because the server cut the work on purpose (a fuel or cut protection,
// a volume restore still owed, a plan adaptation, a deload or light week, the taper's
// trims) is a HOLD, never refilled; pain reported in words, an open injury and constraint
// notes keep a lift untouched; and every safety read fails closed.
// Whatever lands carries the server-owned Undo and the decision's falsifiable expectation
// (each touched lift completed, proposals.ts). Only when policy itself says ask is there a
// held draft — and then exactly one. In-app only: nothing here notifies or pushes.
//
// The landing waits for a natural boundary: never into a session already started
// (autonomy-service.ts quietApplyMustWait) or already composed on a day the change
// touches; the standing template changes for the sessions ahead.
//
// Calm, and it does not flicker with the week:
//   - the gap is judged on the plan AS WRITTEN against the athlete's intent; what varies
//     week to week (a light or race window, a trip, a cut, the endurance carried lately)
//     is a HOLD — nothing new is changed under it, and nothing already open is withdrawn;
//   - an open draft (held for a yes, or a change waiting for its boundary) stays while its
//     gap stands and its offer still fits the plan; one whose gap the plan itself closed,
//     or whose offer went stale, is withdrawn quietly;
//   - the athlete's NO holds the gap (plan-coverage.ts coverageAnswers): a held draft set
//     aside, an announced change held, a landed change undone, or a gap their own plan
//     save made — until the plan gives it materially less (COVERAGE_REASK_WORSE_BY) or the
//     intent changes;
//   - one change at a time: a gap whose last landed change has not been trained yet is
//     SETTLING (coverageSettlingKeys), and an open change in flight means nothing new;
//   - a read that failed changes nothing.
// Two callers: the daily scheduler pass (the only one that acts) and a person's plan save
// (domain/training/plan-save-use-case.ts), which never edits the plan back — it records a
// gap the save itself made as the person's own choice and withdraws what the save closed.
// ============================================================================
import { getPlan } from "../../repo/plan.js";
import type { PlanQualityDay } from "../../repo/plan-quality.js";
import { createProposal, getProposal, setProposalStatus } from "../../repo/proposals.js";
import {
  COVERAGE_AGENT,
  COVERAGE_INSTRUCTION,
  type CoverageChange,
  type CoverageHoldReason,
  type CoverageRemedy,
  coverageAnswers,
  coverageChangeRows,
  coverageOfferStillFits,
  coverageProposalPayload,
  coverageRemedy,
  coverageSettlingKeys,
  readPlanCoverage,
  settlePersonKeptCoverage,
} from "../../repo/plan-coverage.js";
import { localDateISO } from "../../repo/shared.js";
import { applyProposalWithAutonomy } from "./autonomy-service.js";

export interface CoverageChangeOutcome {
  /**
   * none: no gap, or nothing concrete to offer; declined: every gap is one the athlete said
   * no to (or made themselves); settling: the last change for the gap has not been trained
   * yet; standing: an open draft (a change waiting for its boundary, or one held for a yes)
   * already covers it; changed: a new change was routed and policy let it act (quiet or
   * announced); asked: policy held the new change for the athlete's yes; held: a week hold
   * — nothing new, and what is open stays; deferred: a person's save — the gap is left for
   * the daily pass; unavailable: a read failed — nothing changed, nothing withdrawn;
   * would_change: a dry run (previewPlanCoverageChange) — what an acting pass would route.
   */
  status:
    | "none"
    | "declined"
    | "settling"
    | "standing"
    | "changed"
    | "asked"
    | "held"
    | "deferred"
    | "unavailable"
    | "would_change";
  /** A dry run's changes, exactly as they would be written. */
  changes?: CoverageChange[];
  /** True when the change is a first step that does not close the whole gap. */
  partial?: boolean;
  /** The autonomy tier of the open or new draft (quiet_apply | announce | ask), when there is one. */
  tier: string | null;
  proposal_id: number | null;
  decision_id: number | null;
  /** When a routed change lands (its natural boundary), when known. */
  effective_date: string | null;
  /** What the change does, for the athlete. */
  summary: string | null;
  /** Why, for the athlete. */
  explanation: string | null;
  /** Gap keys the open draft covers ("group:chest", "pattern:hinge"). */
  gaps: string[];
  /** Open drafts withdrawn quietly because the plan closed their gap or moved under them. */
  withdrawn: number[];
  /** Gap keys a person's save just made, recorded as their own choice. */
  kept_by_person?: string[];
  /** Why nothing new was changed this week, when status is "held". */
  hold?: CoverageHoldReason;
}

type OpenDraft = { id: number; fingerprints: string[]; inflight: boolean };

function outcome(
  status: CoverageChangeOutcome["status"],
  withdrawn: number[],
  extra: Partial<CoverageChangeOutcome> = {}
): CoverageChangeOutcome {
  return {
    status,
    tier: null,
    proposal_id: null,
    decision_id: null,
    effective_date: null,
    summary: null,
    explanation: null,
    gaps: [],
    withdrawn,
    ...extra,
  };
}

function draftOutcome(
  status: CoverageChangeOutcome["status"],
  proposalId: number,
  withdrawn: number[],
  extra: Partial<CoverageChangeOutcome> = {}
): CoverageChangeOutcome {
  const proposal = getProposal(proposalId) as any;
  const gap = proposal?.parsed?.coverage_gap;
  const autonomy = proposal?.autonomy ?? null;
  const asked = autonomy?.status === "review";
  return outcome(status, withdrawn, {
    tier: autonomy?.tier ?? null,
    proposal_id: proposalId,
    decision_id: autonomy?.id ?? null,
    effective_date: autonomy?.effective_date ?? null,
    summary: typeof proposal?.parsed?.summary === "string" ? proposal.parsed.summary : null,
    explanation: asked
      ? typeof gap?.explanation === "string"
        ? gap.explanation
        : null
      : typeof proposal?.parsed?.rationale === "string"
        ? proposal.parsed.rationale
        : null,
    gaps: Array.isArray(gap?.elements) ? gap.elements.map((el: any) => String(el?.key ?? "")).filter(Boolean) : [],
    ...(typeof gap?.partial === "boolean" ? { partial: gap.partial } : {}),
    ...extra,
  });
}

// The refused-floor hold the first version of this feature parked every coverage draft
// on (`clamp_refused` → review code `safety_floor`): an ask at every lead mode. Such a
// leftover is not the person's open question under today's policy, so the acting pass
// withdraws it quietly and routes the gap afresh, where policy decides.
function legacyFloorHold(proposal: any): boolean {
  return proposal?.autonomy?.status === "review" && proposal?.autonomy?.review_reason_code === "safety_floor";
}

// Does this open draft still stand? Its gaps all still stand in the plan as written, and
// its offer still fits the plan (coverageOfferStillFits). A draft from before the offer
// carried its basis cannot be checked, so it is re-derived once. A draft with no live
// autonomy row (a routing that never finished) is not open.
function draftStillStands(proposal: any, standing: ReadonlySet<string>, date: string, plan: PlanQualityDay[]): boolean {
  const gap = proposal?.parsed?.coverage_gap;
  const fingerprints: string[] = (Array.isArray(gap?.elements) ? gap.elements : [])
    .map((el: any) => String(el?.fingerprint ?? ""))
    .filter(Boolean);
  if (!fingerprints.length || !fingerprints.every((fp) => standing.has(fp))) return false;
  if (!["review", "pending", "announced"].includes(String(proposal?.autonomy?.status ?? ""))) return false;
  if (!Array.isArray(gap?.basis)) return false;
  const changes = Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : [];
  return coverageOfferStillFits(changes, gap.basis, { date, plan }) !== false;
}

function withdraw(id: number, withdrawn: number[]): void {
  // Quietly: the athlete did not answer it, so it is not a "no", and a receipt in the
  // Changes feed would be news about nothing they did. A waiting decision on it is canceled.
  setProposalStatus(id, "superseded", { recordDecision: false });
  withdrawn.push(id);
}

function route(remedy: CoverageRemedy, date: string, withdrawn: number[]): CoverageChangeOutcome {
  const proposal = createProposal(COVERAGE_AGENT, COVERAGE_INSTRUCTION, "", coverageProposalPayload(remedy, date)) as any;
  const id = Number(proposal?.id);
  if (!Number.isFinite(id) || id <= 0) return outcome("none", withdrawn);
  // The ordinary path: no clamp, no requested tier from here. Server policy reads the
  // change's shape (and that an added lift asks to be announced) and the lead mode.
  const routed = applyProposalWithAutonomy(id, {});
  if (routed?.review_required === true) return draftOutcome("asked", id, withdrawn);
  // Acted: landed now (quiet), waiting for its boundary (quiet, pending), or announced.
  if (routed?.ok === true && routed?.superseded !== true && routed?.decision?.id != null) {
    // A change made for these gaps supersedes any older "the person kept it" entry.
    settlePersonKeptCoverage(
      null,
      remedy.covered.map((el) => el.fingerprint)
    );
    return draftOutcome("changed", id, withdrawn, {
      tier: String(routed.tier ?? routed?.decision?.autonomy_tier ?? "") || null,
      effective_date: routed.effective_date ?? routed?.decision?.effective_date ?? null,
    });
  }
  // A routing that neither acted nor held (its premise went in the same breath, an apply
  // the plan refused) leaves nothing behind.
  if ((getProposal(id) as any)?.status === "draft") setProposalStatus(id, "superseded", { recordDecision: false });
  return outcome("none", withdrawn);
}

/**
 * Read the plan of record for a coverage gap and close ONE step of it: route the bounded
 * change coverageRemedy computes (one gap, rankCoverageGaps' first that can honestly be
 * stepped) through the ordinary autonomy path — or nothing, when there is no gap, the
 * athlete said no, the last change has not been trained yet, the week is held (a protective
 * reduction included), a draft is already open, or the server has nothing safe to offer.
 * `act:false` (a person's write) never routes a change. `dry:true` writes nothing at all and
 * reports what the pass WOULD do (status `would_change` with the changes) — the read the
 * owner checks a live plan with before the scheduler acts. Idempotent. Never throws for a
 * read problem: every safety read fails CLOSED to "unavailable" (nothing changed, nothing
 * withdrawn).
 */
export function closePlanCoverageGap(opts: { date?: string; act?: boolean; dry?: boolean } = {}): CoverageChangeOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const dry = opts.dry === true;
  const act = opts.act !== false;
  // A read that failed is not an empty plan: nothing is changed or withdrawn on it.
  let plan: PlanQualityDay[];
  try {
    plan = getPlan() as PlanQualityDay[];
  } catch {
    return outcome("unavailable", []);
  }
  const read = readPlanCoverage(date, { plan });
  if (read.status !== "ok") return outcome("unavailable", []);
  const rows = coverageChangeRows();
  const answers = rows ? coverageAnswers(rows) : null;
  if (!rows || !answers) return outcome("unavailable", []);
  // A person's "I keep it" ends when its gap closes, whoever closed it.
  if (!dry) settlePersonKeptCoverage(read.standing);
  const standing = new Set(read.standing.map((element) => element.fingerprint));
  const retire = (id: number, withdrawn: number[]) => (dry ? withdrawn.push(id) : withdraw(id, withdrawn));

  // 1. Open drafts: the first that still stands is kept; every other one is moot.
  const withdrawn: number[] = [];
  let open: OpenDraft | null = null;
  for (const row of rows) {
    if (row.status !== "draft") continue;
    const proposal = getProposal(row.id) as any;
    if (!open && draftStillStands(proposal, standing, date, plan)) {
      // The old refused-floor hold is re-decided by today's policy on an acting pass.
      if (act && legacyFloorHold(proposal)) {
        retire(row.id, withdrawn);
        continue;
      }
      open = { id: row.id, fingerprints: row.fingerprints, inflight: proposal?.autonomy?.status !== "review" };
      continue;
    }
    retire(row.id, withdrawn);
  }
  const openOutcome = (status: CoverageChangeOutcome["status"], extra: Partial<CoverageChangeOutcome> = {}) =>
    open ? draftOutcome(status, open.id, withdrawn, extra) : outcome(status, withdrawn, extra);

  // 2. A held week changes nothing new; what is already open stays exactly as it is.
  if (read.hold) return openOutcome("held", { hold: read.hold });

  // 3. A gap the open draft does not already cover, the athlete has not said no to, and no
  //    landed change is still settling.
  const settling = coverageSettlingKeys(date);
  if (!settling) return openOutcome("unavailable");
  const covered = new Set(open?.fingerprints ?? []);
  const fresh = read.askable.filter((element) => !covered.has(element.fingerprint));
  const pending = fresh.filter((element) => !answers.declined(element) && !settling.has(element.key));
  if (!pending.length) {
    if (open) return openOutcome("standing");
    if (fresh.some((element) => settling.has(element.key) && !answers.declined(element))) return outcome("settling", withdrawn);
    return outcome(fresh.length ? "declined" : "none", withdrawn);
  }
  // One draft at a time: a change on its way to its boundary, or one held for a yes, comes
  // first; a further gap waits for it.
  if (open) return openOutcome("standing");
  if (!act) return outcome("deferred", withdrawn);
  // The bounded step. A safety read inside it that fails (an injury, a pain report, a set
  // habit) makes the whole pass unavailable — never a change made without it.
  let remedy: CoverageRemedy | null;
  try {
    remedy = coverageRemedy(pending, { date, plan });
  } catch {
    return outcome("unavailable", withdrawn);
  }
  if (!remedy) return outcome("none", withdrawn);
  if (dry) {
    return outcome("would_change", withdrawn, {
      summary: remedy.summary,
      explanation: remedy.explanation,
      gaps: remedy.covered.map((element) => element.key),
      changes: remedy.changes,
      partial: remedy.partial,
    });
  }
  return route(remedy, date, withdrawn);
}

/**
 * What the next acting pass WOULD do to the plan, without writing anything: no draft, no
 * withdrawal, no decision. Read-only (REST GET /plan/coverage-preview, MCP
 * get_plan_coverage_preview).
 */
export function previewPlanCoverageChange(opts: { date?: string } = {}): CoverageChangeOutcome {
  return closePlanCoverageGap({ date: opts.date, act: true, dry: true });
}

/**
 * After a PERSON's direct plan write (their save, a day deleted, a lift swapped). Never
 * edits the plan back. The write already ran inside withPersonAuthoredCoverage
 * (plan-coverage.ts), which recorded any gap it made as theirs — `kept_by_person` is what
 * it recorded; those are left alone and declined in the prompt facts. Here an open draft
 * the write closed or moved under is withdrawn, and any other gap is left for the daily
 * pass.
 */
export function settlePlanCoverageAfterSave(opts: { date?: string; kept_by_person?: string[] }): CoverageChangeOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const kept = opts.kept_by_person ?? [];
  const settled = closePlanCoverageGap({ date, act: false });
  return kept.length ? { ...settled, kept_by_person: kept } : settled;
}
