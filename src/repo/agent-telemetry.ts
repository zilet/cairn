import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";
import { agentErrorClass, telemetryIdentifier } from "../telemetry-privacy.js";

const AGENT_RUN_RETENTION_DAYS = 30;
const AGENT_RUN_ROW_CAP = 20_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
let nextPruneAt = 0;

export function pruneAgentRuns(now = Date.now()): void {
  if (now < nextPruneAt) return;
  try {
    db.prepare(`DELETE FROM agent_runs WHERE created_at < datetime('now', ?)`).run(`-${AGENT_RUN_RETENTION_DAYS} days`);
    db.prepare(`DELETE FROM agent_runs WHERE id NOT IN (SELECT id FROM agent_runs ORDER BY id DESC LIMIT ?)`).run(
      AGENT_RUN_ROW_CAP
    );
  } catch {
    /* telemetry maintenance is failure-safe */
  } finally {
    nextPruneAt = now + PRUNE_INTERVAL_MS;
  }
}

// ---------- agent-run telemetry (see src/agents.ts) ----------
// One row per agent ATTEMPT, written from the runChosen / runAgentWithFallback /
// day-read paths. Makes the agentic loop observable. Mirrors the art_usage
// telemetry shape: a cheap insert + a stats roll-up. recordAgentRun NEVER throws
// into the coaching loop.
export function recordAgentRun(r: {
  op: string;
  agent: string;
  ok: boolean;
  parsed: boolean;
  latency_ms: number;
  tried_json: boolean;
  status?: string | null;
  error_class?: string | null;
  error_message?: string | null;
  exit_code?: number | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}) {
  try {
    const status = telemetryIdentifier(r.status || (r.ok ? "ok" : "error"), 60, r.ok ? "ok" : "error");
    const classifiedError = r.ok ? null : agentErrorClass(status, r.error_class);
    const exitCode = Number(r.exit_code);
    const inputTokens = Number(r.input_tokens);
    const outputTokens = Number(r.output_tokens);
    db.prepare(
      `INSERT INTO agent_runs (
         build_id, op, agent, ok, parsed, latency_ms, tried_json,
         status, error_class, error_message, exit_code, model, input_tokens, output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      getBuildInfo().build_id,
      telemetryIdentifier(r.op, 60),
      telemetryIdentifier(r.agent, 60),
      r.ok ? 1 : 0,
      r.parsed ? 1 : 0,
      Number.isFinite(r.latency_ms) ? Math.round(r.latency_ms) : null,
      r.tried_json ? 1 : 0,
      String(status).slice(0, 60),
      classifiedError,
      classifiedError ? `${classifiedError}: agent attempt failed` : null,
      Number.isFinite(exitCode) ? Math.round(exitCode) : null,
      typeof r.model === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(r.model) ? r.model : null,
      Number.isFinite(inputTokens) ? Math.round(inputTokens) : null,
      Number.isFinite(outputTokens) ? Math.round(outputTokens) : null
    );
  } catch {
    /* telemetry is best-effort — never break the loop on a write error */
  } finally {
    pruneAgentRuns();
  }
}

// Roll-up for the Settings "agent health" card / MCP get_agent_stats. ok_rate is
// a plain reliability fraction over the window (NOT a user-facing grade — this is
// an operator/health view, never surfaced as a score against the athlete). p50_ms
// is the per-agent median latency. `recent` carries the last N raw attempts.
export function getAgentStats(opts: { recent?: number; days?: number } = {}) {
  const recentN = Math.min(Math.max(Number(opts.recent) || 25, 1), 200);
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? (opts.days as number) : null;
  const buildId = getBuildInfo().build_id;
  const where = `WHERE build_id = ?${days ? ` AND created_at >= datetime('now', ?)` : ""}`;
  const bind: any[] = days ? [buildId, `-${days} days`] : [buildId];

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(ok), 0) AS ok FROM agent_runs ${where}`
  ).get(...bind) as any;
  const runs = Number(totalRow?.runs ?? 0);
  const okCount = Number(totalRow?.ok ?? 0);

  const perAgent = db.prepare(
    `SELECT agent,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS fail,
            COALESCE(SUM(CASE WHEN status = 'auth_required' OR error_class = 'auth_required' THEN 1 ELSE 0 END), 0) AS auth_required,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COUNT(*) AS n
       FROM agent_runs ${where}
      GROUP BY agent
      ORDER BY n DESC`
  ).all(...bind) as any[];

  const by_agent = perAgent.map((a) => {
    const lats = (db.prepare(
      `SELECT latency_ms FROM agent_runs ${where ? where + " AND" : "WHERE"} agent = ? AND latency_ms IS NOT NULL ORDER BY latency_ms`
    ).all(...bind, a.agent) as any[]).map((r) => Number(r.latency_ms));
    const p50 = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
    return {
      agent: a.agent,
      ok: Number(a.ok),
      fail: Number(a.fail),
      auth_required: Number(a.auth_required),
      p50_ms: p50,
      input_tokens: Number(a.input_tokens) || null,
      output_tokens: Number(a.output_tokens) || null,
    };
  });

  const by_op = db.prepare(
    `SELECT op,
            COUNT(*) AS runs,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS fail
       FROM agent_runs ${where}
      GROUP BY op
      ORDER BY runs DESC`
  ).all(...bind).map((r: any) => ({
    op: r.op,
    runs: Number(r.runs),
    ok: Number(r.ok),
    fail: Number(r.fail),
  }));

  const recent = db.prepare(
    `SELECT build_id, op, agent, ok, parsed, latency_ms, tried_json, status, error_class,
            error_message, exit_code, model, input_tokens, output_tokens, created_at
       FROM agent_runs ${where} ORDER BY id DESC LIMIT ?`
  ).all(...bind, recentN).map((r: any) => ({
    build_id: r.build_id,
    op: r.op,
    agent: r.agent,
    ok: !!r.ok,
    parsed: !!r.parsed,
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    tried_json: !!r.tried_json,
    status: r.status || (r.ok ? "ok" : "error"),
    error_class: r.error_class ?? null,
    error_message: r.error_class ? `${r.error_class}: agent attempt failed` : null,
    exit_code: r.exit_code == null ? null : Number(r.exit_code),
    model: r.model ?? null,
    input_tokens: r.input_tokens == null ? null : Number(r.input_tokens),
    output_tokens: r.output_tokens == null ? null : Number(r.output_tokens),
    created_at: r.created_at,
  }));

  return {
    build_id: buildId,
    runs,
    ok_rate: runs ? Number((okCount / runs).toFixed(3)) : null,
    by_agent,
    by_op,
    recent,
  };
}

export const AGENT_RUN_LIMITS = { retention_days: AGENT_RUN_RETENTION_DAYS, row_cap: AGENT_RUN_ROW_CAP };
