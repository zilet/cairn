import { db } from "../../db.js";
import type { BrainDecision } from "../../brain/decision-contract.js";
import type { BrainEvaluation } from "../../brain/evaluation-contract.js";
import {
  TERMINAL_ONCE_EVALUATED_METRICS,
  isTerminalOnceEvaluated,
  type BrainExpectation,
} from "../../brain/expectation-contract.js";
import {
  EVALUATOR_REGISTRY,
  MATURITY_EVALUATOR_VERSION,
  evaluateMetricObservation,
  observeExpectation,
} from "../../brain/evaluators.js";
import { isoDate } from "../../brain/contract-utils.js";
import {
  getBrainDecision,
  getBrainExpectation,
  setBrainExpectationStatus,
} from "../../repo/brain-decisions.js";
import { insertBrainEvaluation, latestBrainEvaluation } from "../../repo/brain-evaluations.js";
import { RETIRED_EXPECTATION_STATUSES } from "../../repo/brain/expectation-arbitration.js";

const TERMINAL_DECISION_STATUSES = new Set(["rejected", "reverted", "superseded", "canceled"]);
const DISRUPTIVE_CONTEXT = /\b(trip|travel|injur|ill|sick|stress|medicat|supplement|surgery|hospital|bereave|grief)\b/i;

export interface EvaluationRunSummary {
  as_of: string;
  scanned: number;
  evaluated: number;
  skipped_unchanged: number;
  skipped_not_ready: number;
  errors: number;
  evaluations: BrainEvaluation[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameEvaluation(previous: BrainEvaluation | null, next: Omit<BrainEvaluation, "id" | "evaluated_at">): boolean {
  if (!previous) return false;
  return (
    stable({
      expectation_id: previous.expectation_id,
      verdict: previous.verdict,
      actual: previous.actual,
      evidence_keys: previous.evidence_keys,
      confounders: previous.confounders,
      explanation: previous.explanation,
      evaluator_version: previous.evaluator_version,
    }) === stable(next)
  );
}

function decisionCanceled(decision: BrainDecision): boolean {
  return TERMINAL_DECISION_STATUSES.has(decision.status) || decision.superseded_by != null;
}

// A window only confounds while it is still ASKING something. `retireSupersededExpectations`
// retires the older of two overlapping same-metric windows precisely so the survivor can reach a
// real verdict — leaving the retired row in this query would hand back the mutual silence the
// supersede exists to break. Canceled rows are out for the same reason: their decision was undone,
// so they no longer describe a change competing for this metric.
function overlappingDecisionConfounders(expectation: BrainExpectation): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT other.id AS expectation_id, other.decision_id
       FROM brain_expectations other
       JOIN brain_decisions decision ON decision.id = other.decision_id
      WHERE other.id <> ?
        AND other.decision_id <> ?
        AND other.metric_key = ?
        AND COALESCE(other.subject_key, '') = COALESCE(?, '')
        AND other.window_start <= ?
        AND other.window_end >= ?
        AND other.status NOT IN (${RETIRED_EXPECTATION_STATUSES.map(() => "?").join(", ")})
        AND decision.status IN ('applied', 'announced')
      ORDER BY other.id DESC LIMIT 20`
    )
    .all(
      expectation.id ?? 0,
      expectation.decision_id,
      expectation.metric_key,
      expectation.subject_key,
      expectation.window_end,
      expectation.window_start,
      ...RETIRED_EXPECTATION_STATUSES
    ) as Array<{ expectation_id: number; decision_id: number }>;
  return rows.map((row) => `Decision ${row.decision_id} also targeted this outcome during the evaluation window.`);
}

function contextEventConfounders(expectation: BrainExpectation): string[] {
  if (expectation.confounder_policy === "none") return [];
  const rows = db
    .prepare(
      `SELECT id, kind, title, detail, start_date, end_date, meta_json
       FROM context_events
      WHERE COALESCE(start_date, ?) <= ?
        AND COALESCE(end_date, ?) >= ?
      ORDER BY COALESCE(start_date, ''), id LIMIT 100`
    )
    .all(expectation.window_start, expectation.window_end, expectation.window_end, expectation.window_start) as Array<
    Record<string, unknown>
  >;
  const material = rows.filter((row) => {
    const kind = String(row.kind ?? "");
    if (kind === "trip" || kind === "injury") return true;
    let meta = "";
    try {
      meta = JSON.stringify(row.meta_json ? JSON.parse(String(row.meta_json)) : {});
    } catch {
      meta = "";
    }
    return DISRUPTIVE_CONTEXT.test(`${kind} ${String(row.title ?? "")} ${String(row.detail ?? "")} ${meta}`);
  });
  return material.map((row) => {
    const label = String(row.title ?? row.kind ?? "context event").trim();
    return `Context event '${label.slice(0, 100)}' overlapped the evaluation window.`;
  });
}

function canceledEvaluation(
  expectation: BrainExpectation,
  decision: BrainDecision
): Omit<BrainEvaluation, "id" | "evaluated_at"> {
  const reason =
    decision.status === "superseded" || decision.superseded_by != null
      ? "The decision was superseded before its outcome could be interpreted."
      : "The decision was canceled or reversed before its outcome could be interpreted.";
  return {
    expectation_id: expectation.id!,
    verdict: "canceled",
    actual: null,
    evidence_keys: [],
    confounders: [reason],
    explanation: reason,
    evaluator_version: `${MATURITY_EVALUATOR_VERSION}/canceled`,
  };
}

export function evaluateExpectation(
  expectation: BrainExpectation,
  decision: BrainDecision,
  asOf: string
): Omit<BrainEvaluation, "id" | "evaluated_at"> | null {
  const date = isoDate(asOf);
  if (!date) throw new Error("asOf must be a valid YYYY-MM-DD date");
  if (!expectation.id || !decision.id || expectation.decision_id !== decision.id) {
    throw new Error("evaluation requires a stored expectation and its decision");
  }
  if (decisionCanceled(decision)) return canceledEvaluation(expectation, decision);
  if (date < expectation.window_end) return null;

  const observation = observeExpectation({ expectation, decision, as_of: date });
  const confounders = [...overlappingDecisionConfounders(expectation), ...contextEventConfounders(expectation)];
  // Honor the stored policy: a require_exposure expectation must not reach a
  // decisive verdict from a window in which the subject never appeared at all.
  if (expectation.confounder_policy === "require_exposure") {
    const exposure =
      observation.counts.exposures ?? observation.counts.sessions ?? observation.counts.data_points ?? 0;
    if (!exposure) confounders.push("The expectation requires exposure and none was observed in the window.");
  }
  return evaluateMetricObservation(
    expectation,
    observation,
    confounders,
    EVALUATOR_REGISTRY[expectation.metric_key].version
  );
}

function candidateExpectationIds(asOf: string, limit: number): number[] {
  const terminalKeys = TERMINAL_ONCE_EVALUATED_METRICS as readonly string[];
  // Emptying the list must degrade to "nothing is terminal", not to `NOT IN ()`,
  // which is a SQL syntax error that would take the whole nightly pass down.
  //
  // A same-day expectation is skipped once it has ACTUALLY been evaluated and sits
  // in a closed status. Both halves matter: `latest.id IS NULL` keeps a never-yet-
  // evaluated row due even when it is already `canceled` (a superseded read still
  // earns its canceled verdict), and the status test is what lets
  // reopenDayReadAdherence put a row back to `pending` and have it re-judged after
  // work is logged retroactively — without reopening the door to the unbounded
  // nightly re-probing this clause exists to stop.
  const terminalClause = terminalKeys.length
    ? `AND (expectation.metric_key NOT IN (${terminalKeys.map(() => "?").join(", ")})
             OR latest.id IS NULL
             OR expectation.status IN ('pending', 'mature'))`
    : "";
  const rows = db
    .prepare(
      `SELECT expectation.id
       FROM brain_expectations expectation
       LEFT JOIN brain_evaluations latest
         ON latest.id = (
           SELECT evaluation.id FROM brain_evaluations evaluation
            WHERE evaluation.expectation_id = expectation.id
            ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC LIMIT 1
         )
      WHERE expectation.window_end <= ?
        AND (
          expectation.status IN ('pending', 'mature', 'canceled')
          OR (expectation.status = 'evaluated' AND latest.verdict = 'inconclusive')
        )
        -- A metric whose evidence CLOSED with its window has already given its final
        -- answer, whatever that answer was: an inconclusive same-day read stays
        -- inconclusive and a canceled one stays canceled, because the day it asks
        -- about is over. Without this they re-entered the candidate set every night
        -- forever — and a day-read expectation is written once a DAY, so that backlog
        -- grows linearly and eats the bounded budget below that genuinely new
        -- maturations need. Long-window metrics are deliberately untouched: they are
        -- precisely the ones late evidence still reaches.
        ${terminalClause}
      -- Never let a backlog of old inconclusive rechecks starve a newly matured
      -- expectation. Fresh pending/mature/canceled work is exhausted first;
      -- inconclusive late-data probes use the remaining bounded capacity.
      ORDER BY CASE WHEN expectation.status = 'evaluated' THEN 1 ELSE 0 END,
               expectation.window_end, expectation.id LIMIT ?`
    )
    .all(asOf, ...terminalKeys, limit) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * Cheap deterministic scheduler entrypoint. Only matured, unresolved expectations
 * and prior inconclusive verdicts are considered. Identical re-checks do not append
 * duplicate rows; changed evidence appends a new evaluation and preserves history.
 */
export function evaluateMatureExpectations(
  asOf = new Date().toISOString().slice(0, 10),
  options: { limit?: number } = {}
): EvaluationRunSummary {
  const date = isoDate(asOf);
  if (!date) throw new Error("asOf must be a valid YYYY-MM-DD date");
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(options.limit) || 200)));
  const ids = candidateExpectationIds(date, limit);
  const summary: EvaluationRunSummary = {
    as_of: date,
    scanned: ids.length,
    evaluated: 0,
    skipped_unchanged: 0,
    skipped_not_ready: 0,
    errors: 0,
    evaluations: [],
  };

  for (const id of ids) {
    try {
      const expectation = getBrainExpectation(id);
      const decision = expectation ? getBrainDecision(expectation.decision_id) : null;
      if (!expectation || !decision) {
        summary.errors++;
        continue;
      }
      const next = evaluateExpectation(expectation, decision, date);
      if (!next) {
        summary.skipped_not_ready++;
        continue;
      }
      const previous = latestBrainEvaluation(id);
      if (sameEvaluation(previous, next)) {
        // A RE-OPENED same-day expectation that came back with the identical answer
        // has finished again. Close it here rather than leaving it `pending`, or a
        // re-open that turned out to change nothing would become exactly the
        // standing nightly re-probe terminality exists to prevent. Belt and braces:
        // reopenDayReadAdherence already only fires when the day's facts moved.
        if (isTerminalOnceEvaluated(expectation.metric_key)) {
          const closed = previous?.verdict === "canceled" ? "canceled" : "evaluated";
          if (expectation.status !== closed) setBrainExpectationStatus(id, closed);
        }
        summary.skipped_unchanged++;
        continue;
      }
      const stored = insertBrainEvaluation(next);
      summary.evaluations.push(stored);
      summary.evaluated++;
    } catch {
      // A malformed historical row or one evaluator must not stop the nightly pass.
      summary.errors++;
    }
  }
  return summary;
}
