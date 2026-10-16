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
  type ContextExclusion,
} from "../../brain/evaluators.js";
import { INCONCLUSIVE_REASON_TEXT } from "../../brain/inconclusive-reasons.js";
import { isoDate } from "../../brain/contract-utils.js";
import { getBrainDecision, getBrainExpectation, setBrainExpectationStatus } from "../../repo/brain-decisions.js";
import {
  dayReadExpectationAwaitingMorning,
  dayReadExpectationOutcomeLocked,
  dayReadExpectationRole,
  dayReadExpectationSurvivesSupersession,
} from "../../repo/brain/read-adherence.js";
import { addDaysISO, localDateISO } from "../../repo/shared.js";
import { withSymptomClosures } from "../../repo/injury-symptom-link.js";
import { insertBrainEvaluation, latestBrainEvaluation } from "../../repo/brain-evaluations.js";
import { RETIRED_EXPECTATION_STATUSES } from "../../repo/brain/expectation-arbitration.js";
import { contextTagLabel, isContextTagKey } from "../../contextTags.js";

const TERMINAL_DECISION_STATUSES = new Set(["rejected", "reverted", "superseded", "canceled"]);
const DISRUPTIVE_CONTEXT = /\b(trip|travel|injur|ill|sick|stress|medicat|supplement|surgery|hospital|bereave|grief)\b/i;

// HOW LONG AN UNCLOSED EVENT IS STILL ALLOWED TO SPEAK.
//
// `context_events.end_date` is nullable — "ongoing / open-ended" — and the overlap
// test used to read a null end as "still running", which in SQL terms means it
// overlaps every window from its start date to the end of time. Nobody closes these
// rows: a live audit found two injuries opened in late July with a null end_date,
// silently confounding every long-window evaluation opened afterwards, forever. Any
// confounder forces `inconclusive`, so the whole learning loop went quiet and the
// cause was invisible.
//
// So an event with no explicit end participates in overlap only for a bounded
// staleness horizon after it STARTED. The bound is the event's own recorded
// expectation where it has one — `expected_recovery_days`, the healing window logged
// with the injury — and otherwise 14 days: about one training block, long enough to
// cover the acute phase of the injuries and illnesses this regex matches, short
// enough that a row nobody ever closed stops standing in the way of every future
// verdict. An explicitly closed event (`end_date`, or `resolved_at` for one marked
// healed) keeps its exact dates and is untouched by any of this.
//
// Aging past the horizon is not silent: `staleOpenEndedContextEvents()` publishes
// every such row on the operator diagnostics card.
const OPEN_ENDED_CONTEXT_HORIZON_DAYS = 14;
// An `expected_recovery_days` far past the acute phase would restore the same
// unbounded silence by another name, so the event's own number is honored only up to
// a season.
const OPEN_ENDED_CONTEXT_HORIZON_MAX_DAYS = 120;

interface ContextEventRow {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  detail?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  resolved_at?: unknown;
  expected_recovery_days?: unknown;
  meta_json?: unknown;
}

// The last date an event is treated as running. `null` means it can never be bounded
// (no end, no resolution and no start date), and an unbounded, undated row is not
// evidence that anything overlapped anything — it is a row with no dates on it.
function contextEventEffectiveEnd(row: ContextEventRow): string | null {
  const explicit = isoDate(row.end_date) ?? isoDate(row.resolved_at);
  if (explicit) return explicit;
  const start = isoDate(row.start_date);
  if (!start) return null;
  const recovery = Number(row.expected_recovery_days);
  const horizon =
    Number.isFinite(recovery) && recovery > 0
      ? Math.min(OPEN_ENDED_CONTEXT_HORIZON_MAX_DAYS, Math.trunc(recovery))
      : OPEN_ENDED_CONTEXT_HORIZON_DAYS;
  return addDaysISO(start, horizon) ?? start;
}

export interface StaleOpenEndedContextEvent {
  id: number;
  kind: string;
  title: string;
  start_date: string;
  horizon_end: string;
  days_past_horizon: number;
}

/**
 * Open-ended context events that have aged past the horizon above and therefore no
 * longer confound anything. Surfaced on the operator diagnostics card so an event
 * that is genuinely still running gets closed or extended deliberately, rather than
 * quietly ceasing to be considered.
 */
export function staleOpenEndedContextEvents(asOf = localDateISO()): StaleOpenEndedContextEvent[] {
  const today = isoDate(asOf) ?? localDateISO();
  let rows: ContextEventRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, kind, title, start_date, end_date, resolved_at, expected_recovery_days
           FROM context_events
          WHERE end_date IS NULL AND resolved_at IS NULL AND COALESCE(archived, 0) = 0
            AND start_date IS NOT NULL
          ORDER BY start_date, id LIMIT 100`
      )
      .all() as ContextEventRow[];
    // An injury closed through its twin training symptom is closed, not open-ended.
    rows = withSymptomClosures(rows as any[], today).filter((row: any) => !row.resolved_at) as ContextEventRow[];
  } catch {
    return [];
  }
  const out: StaleOpenEndedContextEvent[] = [];
  for (const row of rows) {
    const start = isoDate(row.start_date);
    const end = contextEventEffectiveEnd(row);
    if (!start || !end || end >= today) continue;
    out.push({
      id: Number(row.id),
      kind: String(row.kind ?? ""),
      title: String(row.title ?? "").slice(0, 100),
      start_date: start,
      horizon_end: end,
      days_past_horizon: Math.max(
        0,
        Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / 864e5)
      ),
    });
  }
  return out;
}

export interface EvaluationRunSummary {
  as_of: string;
  scanned: number;
  evaluated: number;
  skipped_unchanged: number;
  skipped_not_ready: number;
  errors: number;
  /** Expectations whose evaluator threw this pass, and why — never a silent count. */
  failures: Array<{ expectation_id: number; error: string }>;
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
  // A morning read closed out only by that same day's `done` acknowledgement, or by a
  // later recompute that reached the SAME call, was never replaced by a competing
  // prediction — so it still has a day to answer for. The invariant itself lives in
  // read-adherence.ts beside the writer that must not create the state in the first
  // place; this call is what heals the rows written before that writer was fixed.
  if (dayReadExpectationSurvivesSupersession(decision)) return false;
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

interface MaterialContextEvent {
  label: string;
  start: string;
  end: string;
}

function materialContextEvents(expectation: BrainExpectation): MaterialContextEvent[] {
  if (expectation.confounder_policy === "none") return [];
  const rows = db
    .prepare(
      `SELECT id, kind, title, detail, start_date, end_date, resolved_at, expected_recovery_days, meta_json
       FROM context_events
      WHERE COALESCE(start_date, ?) <= ?
        AND COALESCE(end_date, ?) >= ?
      ORDER BY COALESCE(start_date, ''), id LIMIT 100`
    )
    .all(expectation.window_start, expectation.window_end, expectation.window_end, expectation.window_start) as Array<
    Record<string, unknown>
  >;
  // An injury closed through its twin training symptom ends on that symptom's date.
  const closedRows = withSymptomClosures(rows, localDateISO());
  const overlapping = closedRows.filter((row) => {
    // The SQL above lets every unclosed row through (a null end coalesces to the
    // window's own end); the horizon is what decides whether it is still running.
    const end = contextEventEffectiveEnd(row);
    return end != null && end >= expectation.window_start;
  });
  const material = overlapping.filter((row) => {
    const kind = String(row.kind ?? "");
    // Tags are athlete-VOLUNTEERED confounder candidates by design (the whole point of
    // tapping "travel" is that it becomes exculpatory evidence on an overlapping
    // window) — registered explicitly rather than left to the text regex below, which
    // several vocabulary keys (alcohol, work_crunch, poor_sleep_env) wouldn't match.
    if (kind === "trip" || kind === "injury" || kind === "tag") return true;
    let meta = "";
    try {
      meta = JSON.stringify(row.meta_json ? JSON.parse(String(row.meta_json)) : {});
    } catch {
      meta = "";
    }
    return DISRUPTIVE_CONTEXT.test(`${kind} ${String(row.title ?? "")} ${String(row.detail ?? "")} ${meta}`);
  });
  return material.map((row) => {
    const kind = String(row.kind ?? "");
    const label =
      kind === "tag" && isContextTagKey(row.title)
        ? contextTagLabel(String(row.title))
        : String(row.title ?? row.kind ?? "context event").trim();
    // An event with no start date has been running since before anyone wrote it down,
    // so it covers the window from its first day.
    return {
      label: label.slice(0, 100),
      start: isoDate(row.start_date) ?? expectation.window_start,
      end: contextEventEffectiveEnd(row) ?? expectation.window_end,
    };
  });
}

function contextEventConfounders(expectation: BrainExpectation): string[] {
  return materialContextEvents(expectation).map(
    (event) => `Context event '${event.label}' overlapped the evaluation window.`
  );
}

// METRICS WHOSE EVIDENCE IS A SET OF DATED EXPOSURES, so a context event confounds
// the EXPOSURES it covered — not the whole window.
//
// The window-level rule is right for a trend: a trip through the middle of a weight
// window bends the line every point sits on. It is wrong for a lift. A live audit found
// every matured exercise expectation of a quarter inconclusive, every one of them
// silenced by an overlapping event — a four-day camping weekend, a one-day work-crunch
// tag, a mild flank niggle — while sessions before and after the event were perfectly
// clean evidence of whether the change landed. The brain kept changing training with
// no evidence it worked.
//
// So for these metrics an exposure dated inside a material event is SET ASIDE (and
// counted on the verdict), and every other exposure still counts toward the
// expectation's own minimum. Nothing is fabricated: an exposure inside a trip is never
// read as a pass or a miss, and a window left without enough clean exposures stays
// inconclusive under its own minimum-data rule.
const EXPOSURE_SCOPED_CONTEXT_METRICS: ReadonlySet<string> = new Set([
  "exercise_target_completion",
  "exercise_est_1rm_trend",
  "session_performance_feedback",
  "joint_pain_or_soreness",
]);

function contextExclusions(expectation: BrainExpectation): ContextExclusion[] {
  return materialContextEvents(expectation).map((event) => ({
    label: event.label,
    start: event.start < expectation.window_start ? expectation.window_start : event.start,
    end: event.end,
  }));
}

const NOT_THE_GIVEN_READ = "Another read of this day was the one given before training, so only that read is judged.";
// Every read of the day came after training had started — commentary on work already
// done, never the morning's call — so the day has no read to judge (2026-10-16).
const NO_MORNING_READ =
  "Every read of this day came after training had started, so there was no morning read to judge.";

function canceledEvaluation(
  expectation: BrainExpectation,
  decision: BrainDecision,
  override?: string
): Omit<BrainEvaluation, "id" | "evaluated_at"> {
  const reason =
    override ??
    (decision.status === "superseded" || decision.superseded_by != null
      ? "The decision was superseded before its outcome could be interpreted."
      : "The decision was canceled or reversed before its outcome could be interpreted.");
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
  // A superseded read whose outcome the DAY has already decided is judged anyway: the
  // replacement retired the read, but it cannot un-log the training that answered it.
  // The rule of what "already decided" means belongs to read-adherence.ts, which
  // answers false for every other metric — so this stays one condition, not a branch.
  //
  // ONE READ PER DAY IS JUDGED — the one the athlete was given (dayReadExpectationRole).
  // Asked only once the window has closed, because until the day is over a later read
  // can still become the given one. The given read is judged whatever superseded it
  // afterwards; every other read of the date closes as canceled, so a date never carries
  // two verdicts. `null` (any other metric, or a legacy day) keeps the rule above as is.
  const role = date >= expectation.window_end ? dayReadExpectationRole(expectation, decision.id) : null;
  if (role === "not_morning") return canceledEvaluation(expectation, decision, NOT_THE_GIVEN_READ);
  if (role === "commentary_only") return canceledEvaluation(expectation, decision, NO_MORNING_READ);
  if (role !== "morning" && decisionCanceled(decision) && !dayReadExpectationOutcomeLocked(expectation)) {
    return canceledEvaluation(expectation, decision);
  }
  if (date < expectation.window_end) return null;
  // A quiet read the day went past is judged by the harm test, which needs the morning
  // after — wait for it to close rather than read an unsynced morning as "no harm".
  if (dayReadExpectationAwaitingMorning(expectation, date)) return null;

  const exposureScoped = EXPOSURE_SCOPED_CONTEXT_METRICS.has(expectation.metric_key);
  const observation = observeExpectation({
    expectation,
    decision,
    as_of: date,
    ...(exposureScoped ? { context_exclusions: contextExclusions(expectation) } : {}),
  });
  const confounders = [
    ...overlappingDecisionConfounders(expectation),
    ...(exposureScoped ? [] : contextEventConfounders(expectation)),
  ];
  // Honor the stored policy: a require_exposure expectation must not reach a
  // decisive verdict from a window in which the subject never appeared at all. A
  // window whose exposures were all set aside for context already says so in its own
  // words (context_excluded_all) — it was exposed, just never cleanly.
  if (expectation.confounder_policy === "require_exposure") {
    const exposure = observation.counts.exposures ?? observation.counts.sessions ?? observation.counts.data_points ?? 0;
    if (!exposure && !observation.counts.context_excluded_exposures)
      confounders.push("The expectation requires exposure and none was observed in the window.");
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
        -- A canceled row that already carries its canceled verdict has given its final
        -- answer: the decision behind it was undone, and the only path that revives
        -- one (a reopened stance) puts the row back to 'pending' first. Re-asking it
        -- nightly only grew a backlog that sorted AHEAD of genuinely new maturations
        -- and could starve them out of the bounded budget below, forever.
        AND NOT (expectation.status = 'canceled' AND COALESCE(latest.verdict, '') = 'canceled')
      -- Never let a backlog of old rechecks starve a newly matured expectation. A row
      -- that has NEVER been evaluated goes first, oldest window first, so an overdue
      -- one cannot be skipped indefinitely; other pending/mature/canceled work is
      -- next; inconclusive late-data probes use the remaining bounded capacity.
      ORDER BY CASE WHEN latest.id IS NULL THEN 0 WHEN expectation.status = 'evaluated' THEN 2 ELSE 1 END,
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
  asOf = localDateISO(),
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
    failures: [],
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
      let next: Omit<BrainEvaluation, "id" | "evaluated_at"> | null;
      try {
        next = evaluateExpectation(expectation, decision, date);
      } catch (error) {
        // An evaluator that throws used to be one more anonymous `errors++`, and the row
        // stayed matured-unevaluated forever — the recovery evaluator read a column
        // garmin_daily_metrics never had, and every HRV/RHR/sleep expectation sat overdue
        // for two months with nothing anywhere saying why. The failure is now RECORDED
        // as an inconclusive verdict that names it: honest (nothing was concluded),
        // visible on the diagnostics card under `evaluator_error`, and re-probed on the
        // next pass like any other inconclusive row, so a fixed evaluator reaches it.
        const message = String((error as Error)?.message ?? error).slice(0, 120);
        summary.errors++;
        summary.failures.push({ expectation_id: id, error: message });
        next = {
          expectation_id: id,
          verdict: "inconclusive",
          actual: null,
          evidence_keys: [],
          confounders: [`${INCONCLUSIVE_REASON_TEXT.evaluator_error}: ${message}`],
          explanation: "The evaluator could not read this window, so nothing was concluded.",
          evaluator_version:
            EVALUATOR_REGISTRY[expectation.metric_key]?.version ?? `${MATURITY_EVALUATOR_VERSION}/error`,
        };
      }
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
    } catch (error) {
      // A malformed historical row or one evaluator must not stop the nightly pass.
      summary.errors++;
      summary.failures.push({ expectation_id: id, error: String((error as Error)?.message ?? error).slice(0, 120) });
    }
  }
  return summary;
}
