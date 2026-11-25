// ============================================================================
// coverage-ask.ts — a standing coverage gap is SAID, once, as a calm ask.
//
// When the plan of record, as written, leaves a floored group under its weekly floor
// or leaves a movement family out of a broad week (plan-coverage.ts reads both off the
// plan compiler's one definition), the athlete gets ONE question: a server-computed
// draft — a set more here, a lift added there — held for their yes through the ordinary
// propose → apply path. Nothing lands on its own: the draft is routed with
// `clamp_refused`, the same refused-floor hold the redraw precheck uses for an
// unrepaired volume breach (coachOps/training.ts volumeFloorAutonomy), which is an ask
// at every lead mode and which no sweep re-offers on the athlete's behalf. The hold's
// sentence is the draft's own explanation (autonomy-service.ts volumeFloorHoldReason),
// so "Waiting on you" names the group in plain words. It is in-app only: nothing here
// notifies or pushes.
//
// Said once, and it does not flicker with the week:
//   - the gap is judged on the plan AS WRITTEN against the athlete's intent; what varies
//     week to week (a light or race window, a trip, a cut, the endurance carried lately)
//     is a HOLD — nothing new is raised under it, and nothing already open is withdrawn
//     for it;
//   - an open ask stays exactly as it stands while its gap stands in the plan and its
//     offer still fits the plan (the slots it bumps still hold the counts it was offered
//     against, no lift it adds is there yet, no injury opened since loads it). One whose
//     gap the plan itself closed, or whose offer went stale, is withdrawn quietly;
//   - an ask the athlete answered — applied, or set aside — holds for that gap (its
//     fingerprint: the gap and their intent) until the plan gives it materially less
//     (plan-coverage.ts COVERAGE_REASK_WORSE_BY) or a different gap opens.
// Two callers, one rule: a person's plan save (domain/training/plan-save-use-case.ts)
// and the daily scheduler pass, for a gap that arose without a save.
// ============================================================================
import { getPlan } from "../../repo/plan.js";
import type { PlanQualityDay } from "../../repo/plan-quality.js";
import { createProposal, getProposal, setProposalStatus } from "../../repo/proposals.js";
import {
  COVERAGE_ASK_AGENT,
  COVERAGE_ASK_INSTRUCTION,
  type CoverageHoldReason,
  type CoverageRemedy,
  answeredCoverage,
  coverageAskRows,
  coverageOfferStillFits,
  coverageRemedy,
  readPlanCoverage,
} from "../../repo/plan-coverage.js";
import { localDateISO } from "../../repo/shared.js";
import { applyProposalWithAutonomy } from "./autonomy-service.js";

export interface CoverageAskOutcome {
  /**
   * none: no gap (or nothing concrete to offer); answered: every gap was already
   * answered by the athlete; standing: the same ask is already open; raised: a new ask;
   * held: a week hold (a light, race, trip or cut window) — nothing new is asked, and an
   * ask already open stays as it is (proposal_id); unavailable: the plan or its floor
   * context could not be read, so nothing is known — nothing raised, nothing withdrawn.
   */
  status: "none" | "answered" | "standing" | "raised" | "held" | "unavailable";
  proposal_id: number | null;
  decision_id: number | null;
  /** The ask's sentence for the athlete, when one is open. */
  explanation: string | null;
  /** Gap keys the open ask covers ("group:chest", "pattern:hinge"). */
  gaps: string[];
  /** Open asks withdrawn because the plan closed their gap or moved under their offer. */
  withdrawn: number[];
  /** Why nothing new was asked this week, when status is "held". */
  hold?: CoverageHoldReason;
}

function openOutcome(
  proposalId: number,
  withdrawn: number[],
  status: "standing" | "raised" | "held",
  hold?: CoverageHoldReason
): CoverageAskOutcome {
  const proposal = getProposal(proposalId) as any;
  const gap = proposal?.parsed?.coverage_gap;
  return {
    status,
    proposal_id: proposalId,
    decision_id: proposal?.autonomy?.id ?? null,
    explanation: typeof gap?.explanation === "string" ? gap.explanation : null,
    gaps: Array.isArray(gap?.elements) ? gap.elements.map((el: any) => String(el?.key ?? "")).filter(Boolean) : [],
    withdrawn,
    ...(hold ? { hold } : {}),
  };
}

function emptyOutcome(
  status: "none" | "answered" | "held" | "unavailable",
  withdrawn: number[],
  hold?: CoverageHoldReason
): CoverageAskOutcome {
  return {
    status,
    proposal_id: null,
    decision_id: null,
    explanation: null,
    gaps: [],
    withdrawn,
    ...(hold ? { hold } : {}),
  };
}

// Does this open draft still stand? Its gaps all still stand in the plan as written, its
// hold is still live, and its offer still fits the plan (coverageOfferStillFits). A draft
// from before the offer carried its basis cannot be checked, so it is re-derived once.
function draftStillStands(proposal: any, standing: ReadonlySet<string>, date: string, plan: PlanQualityDay[]): boolean {
  const gap = proposal?.parsed?.coverage_gap;
  const fingerprints: string[] = (Array.isArray(gap?.elements) ? gap.elements : [])
    .map((el: any) => String(el?.fingerprint ?? ""))
    .filter(Boolean);
  if (!fingerprints.length || !fingerprints.every((fp) => standing.has(fp))) return false;
  if (proposal?.autonomy?.status !== "review") return false;
  if (!Array.isArray(gap?.basis)) return false;
  const changes = Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : [];
  return coverageOfferStillFits(changes, gap.basis, { date, plan }) !== false;
}

function raiseAsk(remedy: CoverageRemedy, date: string, withdrawn: number[]): CoverageAskOutcome {
  const proposal = createProposal(COVERAGE_ASK_AGENT, COVERAGE_ASK_INSTRUCTION, "", {
    summary: remedy.summary,
    rationale: remedy.explanation,
    changes: remedy.changes,
    coverage_gap: {
      version: 2,
      as_of: date,
      elements: remedy.covered.map((element) => ({
        key: element.key,
        kind: element.kind,
        fingerprint: element.fingerprint,
        ...(element.group ? { group: element.group } : {}),
        ...(element.pattern ? { pattern: element.pattern } : {}),
        // What the plan gave the group when asked: a later answer is held against it.
        ...(element.planned != null ? { planned: element.planned } : {}),
        ...(element.low != null ? { low: element.low } : {}),
      })),
      explanation: remedy.explanation,
      // The offer exactly as derived (the stored `changes` are annotated on write), and
      // the plan slots it was computed against.
      offer: JSON.stringify(remedy.changes ?? null),
      basis: remedy.basis,
    },
  }) as any;
  const id = Number(proposal?.id);
  if (!Number.isFinite(id) || id <= 0) return emptyOutcome("none", withdrawn);
  // The refused-floor hold: an ask at every lead mode, never adopted or thawed into a
  // landing by a sweep. A routing that did not hold (it cannot, short of an error)
  // retires the draft rather than leave a bare one behind.
  const routed = applyProposalWithAutonomy(id, { clamp_refused: true });
  if (routed?.review_required !== true) {
    setProposalStatus(id, "superseded", { recordDecision: false });
    return emptyOutcome("none", withdrawn);
  }
  return openOutcome(id, withdrawn, "raised");
}

/**
 * Read the plan of record for a coverage gap and make sure exactly one calm ask stands
 * for it — or none, when there is no gap, the athlete already answered it, the week is
 * held, or the server has nothing concrete to offer. Idempotent: calling it twice changes
 * nothing the second time. Never throws for a read problem (the gap read is fail-soft).
 */
export function raisePlanCoverageAsk(opts: { date?: string } = {}): CoverageAskOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  // A read that failed is not an empty plan: an open ask is never withdrawn on it.
  let plan: PlanQualityDay[];
  try {
    plan = getPlan() as PlanQualityDay[];
  } catch {
    return emptyOutcome("unavailable", []);
  }
  const read = readPlanCoverage(date, { plan });
  if (read.status !== "ok") return emptyOutcome("unavailable", []);
  const rows = coverageAskRows();
  const answers = answeredCoverage(rows);
  const standing = new Set(read.standing.map((element) => element.fingerprint));

  // 1. Open asks: the first that still stands is kept; every other one is moot. Withdrawn
  //    quietly — the athlete did not answer it, so it is not a "no", and a set-aside
  //    receipt in the Changes feed would be news about nothing they did.
  const withdrawn: number[] = [];
  let kept: { id: number; fingerprints: string[] } | null = null;
  for (const row of rows) {
    if (row.status !== "draft") continue;
    if (!kept && draftStillStands(getProposal(row.id), standing, date, plan)) {
      kept = { id: row.id, fingerprints: row.fingerprints };
      continue;
    }
    setProposalStatus(row.id, "superseded", { recordDecision: false });
    withdrawn.push(row.id);
  }

  // 2. A held week asks nothing new; what is already open stays exactly as it is.
  if (read.hold) return kept ? openOutcome(kept.id, withdrawn, "held", read.hold) : emptyOutcome("held", withdrawn, read.hold);

  // 3. A gap the open ask does not already cover, and the athlete has not answered.
  const covered = new Set(kept?.fingerprints ?? []);
  const pending = read.askable.filter((element) => !covered.has(element.fingerprint) && !answers.answered(element));
  if (!pending.length) {
    if (kept) return openOutcome(kept.id, withdrawn, "standing");
    return emptyOutcome(read.askable.length ? "answered" : "none", withdrawn);
  }
  // One ask covers every gap, so a new one folds the open ask's gaps in — unless one of
  // those is held this week on its own (endurance carrying it, the taper's leg trim): then
  // the open ask stands and the new gap waits for that hold to pass.
  const askable = new Set(read.askable.map((element) => element.fingerprint));
  if (kept && !kept.fingerprints.every((fp) => askable.has(fp))) return openOutcome(kept.id, withdrawn, "standing");
  const keptElements = read.askable.filter((element) => covered.has(element.fingerprint));
  const pendingKeys = new Set(pending.map((element) => element.fingerprint));
  const remedy = coverageRemedy([...pending, ...keptElements], { date, plan });
  // Nothing concrete to offer for the new gap (an injury rules out every lift for it, say):
  // the open ask stands as it is.
  if (!remedy || !remedy.covered.some((element) => pendingKeys.has(element.fingerprint))) {
    if (kept) return openOutcome(kept.id, withdrawn, "standing");
    return emptyOutcome("none", withdrawn);
  }
  if (kept) {
    setProposalStatus(kept.id, "superseded", { recordDecision: false });
    withdrawn.push(kept.id);
  }
  return raiseAsk(remedy, date, withdrawn);
}
