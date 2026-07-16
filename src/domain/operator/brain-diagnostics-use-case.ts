import { db } from "../../db.js";
import { listBrainDecisions, listBrainExpectations } from "../../repo/brain-decisions.js";
import { latestBrainEvaluation, listBrainToolCalls } from "../../repo/brain-evaluations.js";
import { normalizeStrictCaseConferenceDecision } from "../../brain/case-conference-contract.js";

const METRIC_WINDOW_DAYS = 90;
const MATERIAL_KINDS = new Set([
  "training_target",
  "training_structure",
  "exercise_rotation",
  "nutrition_target",
  "meal_plan",
  "recovery_adjustment",
  "health_directive",
  "lifestyle_adjustment",
  "goal_change",
  "case_conference",
]);

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 10 : null;
}

function countBy(rows: any[], key: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row?.[key] ?? "unknown");
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function parsed(value: unknown): any {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function brainAggregateMetrics() {
  const modifier = `-${METRIC_WINDOW_DAYS} days`;
  const decisions = db
    .prepare(
      `SELECT id, kind, domain, status, autonomy_tier, created_at
       FROM brain_decisions WHERE created_at >= datetime('now', ?)`
    )
    .all(modifier) as any[];
  const expectations = db
    .prepare(
      `SELECT e.id, e.decision_id, e.window_end, e.status, e.evaluator_version, d.domain
       FROM brain_expectations e JOIN brain_decisions d ON d.id = e.decision_id
       WHERE d.created_at >= datetime('now', ?)`
    )
    .all(modifier) as any[];
  const latestEvaluations = db
    .prepare(
      `SELECT v.expectation_id, v.verdict, v.evaluator_version
       FROM brain_evaluations v
       JOIN (SELECT expectation_id, MAX(id) AS id FROM brain_evaluations GROUP BY expectation_id) latest
         ON latest.id = v.id`
    )
    .all() as any[];
  const latestByExpectation = new Map(latestEvaluations.map((row) => [Number(row.expectation_id), row]));
  const expectationDecisionIds = new Set(expectations.map((row) => Number(row.decision_id)));
  const activeMaterial = decisions.filter(
    (row) =>
      MATERIAL_KINDS.has(String(row.kind)) && !["rejected", "canceled", "superseded"].includes(String(row.status))
  );
  const materialWithExpectations = activeMaterial.filter((row) => expectationDecisionIds.has(Number(row.id))).length;
  const today = new Date().toISOString().slice(0, 10);
  const matured = expectations.filter((row) => String(row.window_end) <= today && String(row.status) !== "canceled");
  const evaluatedMatured = matured.filter((row) => latestByExpectation.has(Number(row.id)));
  const reverted = decisions.filter((row) => row.status === "reverted").length;
  const resolved = decisions.filter((row) => ["applied", "reverted"].includes(String(row.status))).length;
  const autonomous = decisions.filter(
    (row) =>
      ["quiet_apply", "announce"].includes(String(row.autonomy_tier)) &&
      ["applied", "reverted", "announced", "pending"].includes(String(row.status))
  );
  const autonomousResolved = autonomous.filter((row) => ["applied", "reverted"].includes(String(row.status)));
  const autonomousReverted = autonomousResolved.filter((row) => row.status === "reverted").length;
  const byDomain = [...new Set(decisions.map((row) => String(row.domain)))].sort().map((domain) => {
    const domainRows = decisions.filter((row) => row.domain === domain);
    const domainMaterial = activeMaterial.filter((row) => row.domain === domain);
    const withExpectations = domainMaterial.filter((row) => expectationDecisionIds.has(Number(row.id))).length;
    const autonomousResolvedRows = domainRows.filter(
      (row) =>
        ["quiet_apply", "announce"].includes(String(row.autonomy_tier)) &&
        ["applied", "reverted"].includes(String(row.status))
    );
    const domainReverted = autonomousResolvedRows.filter((row) => row.status === "reverted").length;
    return {
      domain,
      decisions: domainRows.length,
      material_decisions: domainMaterial.length,
      with_expectations: withExpectations,
      expectation_coverage_pct: pct(withExpectations, domainMaterial.length),
      autonomous_resolved: autonomousResolvedRows.length,
      autonomous_reverted: domainReverted,
      autonomy_demoted:
        autonomousResolvedRows.length >= 3 &&
        domainReverted >= 2 &&
        domainReverted / autonomousResolvedRows.length >= 0.5,
    };
  });

  const toolCalls = db
    .prepare(
      `SELECT run_id, status, latency_ms FROM brain_tool_calls
       WHERE created_at >= datetime('now', ?)`
    )
    .all(modifier) as any[];
  const latencies = toolCalls
    .map((row) => Number(row.latency_ms))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const toolFailures = toolCalls.filter((row) => row.status && row.status !== "ok").length;
  const budgetExhausted = toolCalls.filter((row) => /budget|limit|exhaust/i.test(String(row.status ?? ""))).length;

  const conferenceRows = db
    .prepare(
      `SELECT status, result_json, error FROM agent_jobs
       WHERE kind = 'case_conference' AND created_at >= datetime('now', ?)`
    )
    .all(modifier) as any[];
  const specialistAgentRuns = db
    .prepare(
      `SELECT ok, parsed, status, error_class FROM agent_runs
       WHERE op LIKE 'conference\\_%' ESCAPE '\\'
         AND created_at >= datetime('now', ?)`
    )
    .all(modifier) as any[];
  let conferenceSuccessful = 0;
  let conferenceCompleteSuccessful = 0;
  let conferenceUsefulDegradedOrIncomplete = 0;
  let conferenceDegraded = 0;
  let conferenceIncomplete = 0;
  let conferenceBudgetExhausted = 0;
  let conflictsDetected = 0;
  let conflictsUnresolved = 0;
  let specialistsRequested = 0;
  let specialistsAvailable = 0;
  let conferenceDoneUnsuccessful = 0;
  for (const row of conferenceRows) {
    const result = parsed(row.result_json);
    if (result?.ok === true) {
      conferenceSuccessful += 1;
      const complete =
        result.degraded !== true &&
        normalizeStrictCaseConferenceDecision(result.decision) !== null &&
        Array.isArray(result.unavailable) &&
        result.unavailable.length === 0 &&
        Array.isArray(result.unresolved_conflicts) &&
        result.unresolved_conflicts.length === 0;
      if (complete) conferenceCompleteSuccessful += 1;
      else {
        conferenceUsefulDegradedOrIncomplete += 1;
        if (result.degraded === true) conferenceDegraded += 1;
        else conferenceIncomplete += 1;
      }
    } else if (row.status === "done") conferenceDoneUnsuccessful += 1;
    if (/budget exhausted/i.test(String(result?.error ?? row.error ?? ""))) conferenceBudgetExhausted += 1;
    const opinions = Array.isArray(result?.opinions) ? result.opinions.length : 0;
    const unavailable = Array.isArray(result?.unavailable) ? result.unavailable.length : 0;
    specialistsAvailable += opinions;
    specialistsRequested += opinions + unavailable;
    conflictsDetected += Array.isArray(result?.conflicts) ? result.conflicts.length : 0;
    conflictsUnresolved += Array.isArray(result?.unresolved_conflicts) ? result.unresolved_conflicts.length : 0;
  }
  const specialistContractFailures = specialistAgentRuns.filter((row) => row.error_class === "invalid_contract").length;
  const specialistParseFailures = specialistAgentRuns.filter((row) => row.error_class === "invalid_json").length;
  const specialistProviderProcessFailures = specialistAgentRuns.filter((row) =>
    ["auth_required", "timeout", "process_error", "agent_unavailable"].includes(
      String(row.error_class ?? row.status ?? "")
    )
  ).length;
  const specialistKnownFailures =
    specialistContractFailures + specialistParseFailures + specialistProviderProcessFailures;
  const specialistOtherFailures = specialistAgentRuns.filter((row) => !row.ok).length - specialistKnownFailures;

  const latestVerdicts = evaluatedMatured.map((row) => latestByExpectation.get(Number(row.id))).filter(Boolean);
  // The *_pct fields below are OPERATOR TELEMETRY (system coverage/revert rates),
  // shown only on the operator diagnostics card as counts today. They are not
  // person-scores — but never surface them in an athlete-facing view; the
  // constitution bans graded numbers about the person.
  return {
    window_days: METRIC_WINDOW_DAYS,
    decisions: {
      total: decisions.length,
      material: activeMaterial.length,
      with_expectations: materialWithExpectations,
      expectation_coverage_pct: pct(materialWithExpectations, activeMaterial.length),
      applied_or_reverted: resolved,
      reverted,
      revert_rate_pct: pct(reverted, resolved),
      by_status: countBy(decisions, "status"),
      by_domain: countBy(decisions, "domain"),
    },
    expectations: {
      total: expectations.length,
      matured: matured.length,
      matured_evaluated: evaluatedMatured.length,
      matured_evaluation_coverage_pct: pct(evaluatedMatured.length, matured.length),
      latest_verdicts: countBy(latestVerdicts, "verdict"),
      by_evaluator_version: countBy(expectations, "evaluator_version"),
    },
    autonomy: {
      active_or_resolved: autonomous.length,
      resolved: autonomousResolved.length,
      reverted: autonomousReverted,
      revert_rate_pct: pct(autonomousReverted, autonomousResolved.length),
      demoted_domains: byDomain.filter((row) => row.autonomy_demoted).map((row) => row.domain),
    },
    outcome_learning_by_domain: byDomain,
    tools: {
      calls: toolCalls.length,
      runs: new Set(toolCalls.map((row) => row.run_id)).size,
      failed: toolFailures,
      budget_exhausted: budgetExhausted,
      average_latency_ms: latencies.length
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null,
      p95_latency_ms: latencies.length
        ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
        : null,
    },
    conferences: {
      jobs: conferenceRows.length,
      successful: conferenceSuccessful,
      complete_successful: conferenceCompleteSuccessful,
      useful_degraded_or_incomplete: conferenceUsefulDegradedOrIncomplete,
      degraded: conferenceDegraded,
      incomplete: conferenceIncomplete,
      failed_or_canceled:
        conferenceDoneUnsuccessful +
        conferenceRows.filter((row) => ["error", "canceled"].includes(String(row.status))).length,
      active: conferenceRows.filter((row) => ["queued", "running"].includes(String(row.status))).length,
      budget_exhausted: conferenceBudgetExhausted,
      conflicts_detected: conflictsDetected,
      conflicts_unresolved: conflictsUnresolved,
      specialists_requested: specialistsRequested,
      specialist_valid_opinions: specialistsAvailable,
      specialist_valid_opinion_yield_pct: pct(specialistsAvailable, specialistsRequested),
      specialist_agent_attempts: specialistAgentRuns.length,
      specialist_agent_accepted_turns: specialistAgentRuns.filter((row) => !!row.ok).length,
      specialist_contract_failures: specialistContractFailures,
      specialist_parse_failures: specialistParseFailures,
      specialist_provider_process_failures: specialistProviderProcessFailures,
      specialist_other_failures: Math.max(0, specialistOtherFailures),
      // Deprecated compatibility aliases. These measure valid-opinion yield,
      // never raw provider availability; keep them until installed clients move.
      specialists_available: specialistsAvailable,
      specialist_availability_pct: pct(specialistsAvailable, specialistsRequested),
    },
  };
}

export function getBrainDiagnostics(limit?: number) {
  const n = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 25)));
  const decisions = listBrainDecisions({ limit: n }).map((decision) => {
    const evaluations = listBrainExpectations({ decisionId: decision.id!, limit: 20 })
      .map((expectation) => latestBrainEvaluation(expectation.id!))
      .filter(Boolean);
    return {
      id: decision.id,
      created_at: decision.created_at,
      effective_date: decision.effective_date,
      kind: decision.kind,
      domain: decision.domain,
      summary: decision.summary,
      status: decision.status,
      autonomy_tier: decision.autonomy_tier,
      reversible: decision.reversible,
      latest_verdict:
        evaluations.sort((a: any, b: any) => String(b.evaluated_at).localeCompare(String(a.evaluated_at)))[0]
          ?.verdict ?? null,
    };
  });
  return { metrics: brainAggregateMetrics(), decisions, tool_calls: listBrainToolCalls(n) };
}
