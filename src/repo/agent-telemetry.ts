import { db } from "../db.js";

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
    const status = r.status || (r.ok ? "ok" : "error");
    const exitCode = Number(r.exit_code);
    const inputTokens = Number(r.input_tokens);
    const outputTokens = Number(r.output_tokens);
    db.prepare(
      `INSERT INTO agent_runs (
         op, agent, ok, parsed, latency_ms, tried_json,
         status, error_class, error_message, exit_code, model, input_tokens, output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(r.op ?? "").slice(0, 60),
      String(r.agent ?? "").slice(0, 60),
      r.ok ? 1 : 0,
      r.parsed ? 1 : 0,
      Number.isFinite(r.latency_ms) ? Math.round(r.latency_ms) : null,
      r.tried_json ? 1 : 0,
      String(status).slice(0, 60),
      r.error_class ? String(r.error_class).slice(0, 80) : null,
      r.error_message ? String(r.error_message).replace(/\s+/g, " ").trim().slice(0, 280) : null,
      Number.isFinite(exitCode) ? Math.round(exitCode) : null,
      r.model ? String(r.model).slice(0, 120) : null,
      Number.isFinite(inputTokens) ? Math.round(inputTokens) : null,
      Number.isFinite(outputTokens) ? Math.round(outputTokens) : null
    );
  } catch {
    /* telemetry is best-effort — never break the loop on a write error */
  }
}

// Roll-up for the Settings "agent health" card / MCP get_agent_stats. ok_rate is
// a plain reliability fraction over the window (NOT a user-facing grade — this is
// an operator/health view, never surfaced as a score against the athlete). p50_ms
// is the per-agent median latency. `recent` carries the last N raw attempts.
export function getAgentStats(opts: { recent?: number; days?: number } = {}) {
  const recentN = Math.min(Math.max(Number(opts.recent) || 25, 1), 200);
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? (opts.days as number) : null;
  const where = days ? `WHERE created_at >= datetime('now', ?)` : ``;
  const bind: any[] = days ? [`-${days} days`] : [];

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
    `SELECT op, agent, ok, parsed, latency_ms, tried_json, status, error_class,
            error_message, exit_code, model, input_tokens, output_tokens, created_at
       FROM agent_runs ${where} ORDER BY id DESC LIMIT ?`
  ).all(...bind, recentN).map((r: any) => ({
    op: r.op,
    agent: r.agent,
    ok: !!r.ok,
    parsed: !!r.parsed,
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    tried_json: !!r.tried_json,
    status: r.status || (r.ok ? "ok" : "error"),
    error_class: r.error_class ?? null,
    error_message: r.error_message ?? null,
    exit_code: r.exit_code == null ? null : Number(r.exit_code),
    model: r.model ?? null,
    input_tokens: r.input_tokens == null ? null : Number(r.input_tokens),
    output_tokens: r.output_tokens == null ? null : Number(r.output_tokens),
    created_at: r.created_at,
  }));

  return {
    runs,
    ok_rate: runs ? Number((okCount / runs).toFixed(3)) : null,
    by_agent,
    by_op,
    recent,
  };
}
