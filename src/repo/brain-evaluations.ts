import { db } from "../db.js";
import { type BrainEvaluation, normalizeBrainEvaluation } from "../brain/evaluation-contract.js";
import { getBrainExpectation, setBrainExpectationStatus } from "./brain-decisions.js";

function parsed(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

function hydrate(row: any): BrainEvaluation | null {
  if (!row) return null;
  const evidence = parsed(row.evidence_json);
  const confounders = parsed(row.confounders_json);
  return normalizeBrainEvaluation({
    ...row,
    actual: parsed(row.actual_json),
    evidence_keys: Array.isArray(evidence) ? evidence : [],
    confounders: Array.isArray(confounders) ? confounders : [],
    evaluated_at: isoTimestamp(row.evaluated_at),
  });
}

export function getBrainEvaluation(id: number): BrainEvaluation | null {
  return hydrate(db.prepare(`SELECT * FROM brain_evaluations WHERE id = ?`).get(id));
}

export function listBrainEvaluations(expectationId: number): BrainEvaluation[] {
  return (
    db
      .prepare(`SELECT * FROM brain_evaluations WHERE expectation_id = ? ORDER BY evaluated_at DESC, id DESC`)
      .all(expectationId) as any[]
  )
    .map(hydrate)
    .filter((row): row is BrainEvaluation => row != null);
}

export function latestBrainEvaluation(expectationId: number): BrainEvaluation | null {
  return hydrate(
    db
      .prepare(`SELECT * FROM brain_evaluations WHERE expectation_id = ? ORDER BY evaluated_at DESC, id DESC LIMIT 1`)
      .get(expectationId)
  );
}

export function insertBrainEvaluation(value: unknown): BrainEvaluation {
  const normalized = normalizeBrainEvaluation(value);
  if (!normalized) throw new Error("invalid brain evaluation");
  const expectation = getBrainExpectation(normalized.expectation_id);
  if (!expectation) throw new Error(`No brain expectation ${normalized.expectation_id}`);
  const info = db
    .prepare(
      `INSERT INTO brain_evaluations
      (expectation_id, verdict, actual_json, evidence_json, confounders_json, explanation, evaluator_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      normalized.expectation_id,
      normalized.verdict,
      normalized.actual == null ? null : JSON.stringify(normalized.actual),
      JSON.stringify(normalized.evidence_keys),
      JSON.stringify(normalized.confounders),
      normalized.explanation,
      normalized.evaluator_version
    );
  setBrainExpectationStatus(normalized.expectation_id, normalized.verdict === "canceled" ? "canceled" : "evaluated");
  const stored = getBrainEvaluation(Number(info.lastInsertRowid));
  if (!stored) throw new Error("brain evaluation was not stored");
  return stored;
}

export function recordBrainToolCall(input: {
  run_id: string;
  op: string;
  tool: string;
  args_summary?: string | null;
  rows_returned?: number | null;
  latency_ms?: number | null;
  status?: string | null;
}): void {
  try {
    const runId = String(input.run_id || "")
      .trim()
      .slice(0, 120);
    const op = String(input.op || "")
      .trim()
      .slice(0, 80);
    const tool = String(input.tool || "")
      .trim()
      .slice(0, 100);
    if (!runId || !op || !tool) return;
    db.prepare(
      `INSERT INTO brain_tool_calls (run_id, op, tool, args_summary, rows_returned, latency_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      op,
      tool,
      input.args_summary == null ? null : String(input.args_summary).slice(0, 500),
      input.rows_returned == null ? null : Math.max(0, Math.trunc(Number(input.rows_returned) || 0)),
      input.latency_ms == null ? null : Math.max(0, Math.trunc(Number(input.latency_ms) || 0)),
      input.status == null ? null : String(input.status).slice(0, 80)
    );
  } catch {
    // Telemetry is intentionally failure-safe and must never break a coach run.
  }
}

export function listBrainToolCalls(limit = 50): Array<{
  id: number;
  run_id: string;
  op: string;
  tool: string;
  args_summary: string | null;
  rows_returned: number | null;
  latency_ms: number | null;
  status: string | null;
  created_at: string;
}> {
  const n = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
  return db
    .prepare(
      `SELECT id, run_id, op, tool, args_summary, rows_returned, latency_ms, status, created_at
       FROM brain_tool_calls ORDER BY id DESC LIMIT ?`
    )
    .all(n) as any[];
}
