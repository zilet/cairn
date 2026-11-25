// ============================================================================
// coverage-ask.ts — a standing coverage gap is SAID, once, as a calm ask.
//
// When the plan of record, as written, leaves a floored group under its weekly floor
// or leaves a movement family out of a broad week (plan-coverage.ts reads both off the
// plan compiler's own warnings, exemptions and all), the athlete gets ONE question: a
// server-computed draft — a set more here, a lift added there — held for their yes
// through the ordinary propose → apply path. Nothing lands on its own: the draft is
// routed with `clamp_refused`, the same refused-floor hold the redraw precheck uses for
// an unrepaired volume breach (coachOps/training.ts volumeFloorAutonomy), which is an
// ask at every lead mode and which no sweep re-offers on the athlete's behalf. The
// hold's sentence is the draft's own explanation (autonomy-service.ts
// volumeFloorHoldReason), so "Waiting on you" names the group in plain words.
//
// Said once:
//   - an open ask for the same gaps is left exactly as it stands (a save that changes
//     nothing, or the nightly pass after a save, never adds a second one);
//   - an ask the athlete answered — applied, or set aside — is never raised again for
//     the same gap fingerprint (the gap, their intent, and the lifts that bear on it);
//   - an open ask whose gap moved or closed (the plan changed, a light week began) is
//     withdrawn quietly, and a changed gap is asked about afresh.
// Two callers, one rule: a person's plan save (domain/training/plan-save-use-case.ts)
// and the daily scheduler pass, for a gap that arose without a save.
// ============================================================================
import { createProposal, getProposal, setProposalStatus } from "../../repo/proposals.js";
import {
  COVERAGE_ASK_AGENT,
  COVERAGE_ASK_INSTRUCTION,
  coverageAskRows,
  coverageRemedy,
  planCoverageGap,
} from "../../repo/plan-coverage.js";
import { localDateISO } from "../../repo/shared.js";
import { applyProposalWithAutonomy } from "./autonomy-service.js";

export interface CoverageAskOutcome {
  /**
   * none: no gap (or nothing concrete to offer); answered: every gap was already
   * answered by the athlete; standing: the same ask is already open; raised: a new ask.
   */
  status: "none" | "answered" | "standing" | "raised";
  proposal_id: number | null;
  decision_id: number | null;
  /** The ask's sentence for the athlete, when one is open. */
  explanation: string | null;
  /** Gap keys the open ask covers ("group:chest", "pattern:hinge"). */
  gaps: string[];
  /** Open asks withdrawn because their gap moved or closed. */
  withdrawn: number[];
}

const ANSWERED = new Set(["applied", "discarded"]);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((value) => left.has(value));
}

const offerKey = (changes: unknown): string => JSON.stringify(changes ?? null);

function openOutcome(proposalId: number, withdrawn: number[], status: "standing" | "raised"): CoverageAskOutcome {
  const proposal = getProposal(proposalId) as any;
  const gap = proposal?.parsed?.coverage_gap;
  return {
    status,
    proposal_id: proposalId,
    decision_id: proposal?.autonomy?.id ?? null,
    explanation: typeof gap?.explanation === "string" ? gap.explanation : null,
    gaps: Array.isArray(gap?.elements) ? gap.elements.map((el: any) => String(el?.key ?? "")).filter(Boolean) : [],
    withdrawn,
  };
}

/**
 * Read the plan of record for a coverage gap and make sure exactly one calm ask stands
 * for it — or none, when there is no gap, the athlete already answered it, or the
 * server has nothing concrete to offer. Idempotent: calling it twice changes nothing
 * the second time. Never throws for a read problem (the gap read is fail-soft).
 */
export function raisePlanCoverageAsk(opts: { date?: string } = {}): CoverageAskOutcome {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const gap = planCoverageGap(date);
  const rows = coverageAskRows();
  const answered = new Set(rows.filter((row) => ANSWERED.has(row.status)).flatMap((row) => row.fingerprints));
  const pending = gap.elements.filter((element) => !answered.has(element.fingerprint));
  const remedy = pending.length ? coverageRemedy(pending, { date }) : null;
  const asking = (remedy?.covered ?? []).map((element) => element.fingerprint);

  // The open ask that already asks exactly this stays; every other open one is moot.
  const withdrawn: number[] = [];
  let standing: number | null = null;
  for (const row of rows) {
    if (row.status !== "draft") continue;
    const proposal = standing == null && asking.length && sameSet(row.fingerprints, asking) ? getProposal(row.id) : null;
    // The same gap is not the same offer: its set counts are absolute, so a draft written
    // before the athlete edited those lifts would land yesterday's numbers (a cut, under a
    // card that says "one more set"). Only a draft that still says what today's would stays.
    const sameOffer =
      !!proposal && (proposal as any).parsed?.coverage_gap?.offer === offerKey(remedy?.changes);
    if (proposal && sameOffer && (proposal as any).autonomy?.status === "review") {
      standing = row.id;
      continue;
    }
    // Withdrawn quietly: the athlete did not answer it, so it is not a "no", and a
    // set-aside receipt in the Changes feed would be news about nothing they did.
    setProposalStatus(row.id, "superseded", { recordDecision: false });
    withdrawn.push(row.id);
  }
  if (standing != null) return openOutcome(standing, withdrawn, "standing");
  if (!remedy || !asking.length) {
    return {
      status: gap.elements.length && !pending.length ? "answered" : "none",
      proposal_id: null,
      decision_id: null,
      explanation: null,
      gaps: [],
      withdrawn,
    };
  }

  const proposal = createProposal(COVERAGE_ASK_AGENT, COVERAGE_ASK_INSTRUCTION, "", {
    summary: remedy.summary,
    rationale: remedy.explanation,
    changes: remedy.changes,
    coverage_gap: {
      version: 1,
      as_of: date,
      elements: remedy.covered.map((element) => ({
        key: element.key,
        fingerprint: element.fingerprint,
        ...(element.group ? { group: element.group } : {}),
        ...(element.pattern ? { pattern: element.pattern } : {}),
      })),
      explanation: remedy.explanation,
      // The offer exactly as derived (the stored `changes` are annotated on write).
      offer: offerKey(remedy.changes),
    },
  }) as any;
  const id = Number(proposal?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return { status: "none", proposal_id: null, decision_id: null, explanation: null, gaps: [], withdrawn };
  }
  // The refused-floor hold: an ask at every lead mode, never adopted or thawed into a
  // landing by a sweep. A routing that did not hold (it cannot, short of an error)
  // retires the draft rather than leave a bare one behind.
  const routed = applyProposalWithAutonomy(id, { clamp_refused: true });
  if (routed?.review_required !== true) {
    setProposalStatus(id, "superseded", { recordDecision: false });
    return { status: "none", proposal_id: null, decision_id: null, explanation: null, gaps: [], withdrawn };
  }
  return openOutcome(id, withdrawn, "raised");
}
