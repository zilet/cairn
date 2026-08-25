import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";
import { agentErrorClass, telemetryIdentifier, telemetryModelName } from "../telemetry-privacy.js";
import {
  CHAT_LANES,
  CHAT_REASONING_LEVELS,
  CHAT_ROUTING_POLICY_VERSION,
  CHAT_ROUTING_REASON_CODES,
  type ChatLane,
} from "../chatRouting.js";

const AGENT_RUN_RETENTION_DAYS = 30;
const AGENT_RUN_ROW_CAP = 20_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const WRITES_PER_CAP_CHECK = 250;
let nextPruneAt = 0;
let writesUntilCapCheck = WRITES_PER_CAP_CHECK;
let capPressure = false;

export function pruneAgentRuns(now = Date.now(), force = false): void {
  if (!force && now < nextPruneAt) return;
  try {
    db.prepare(`DELETE FROM agent_runs WHERE created_at < datetime('now', ?)`).run(`-${AGENT_RUN_RETENTION_DAYS} days`);
    const capped = db
      .prepare(`DELETE FROM agent_runs WHERE id NOT IN (SELECT id FROM agent_runs ORDER BY id DESC LIMIT ?)`)
      .run(AGENT_RUN_ROW_CAP);
    if (Number(capped.changes) > 0) capPressure = true;
    else if (capPressure)
      capPressure =
        Number((db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as any)?.n ?? 0) >= AGENT_RUN_ROW_CAP;
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
  lane?: string | null;
  policy_version?: string | null;
  reason_codes?: string[] | null;
  requested_model?: string | null;
  requested_reasoning?: string | null;
  effective_reasoning?: string | null;
  streaming?: boolean | null;
  ttft_ms?: number | null;
  chat_turn_id?: number | null;
  attempt_index?: number | null;
  escalation_source?: string | null;
}) {
  try {
    const status = telemetryIdentifier(r.status || (r.ok ? "ok" : "error"), 60, r.ok ? "ok" : "error");
    const classifiedError = r.ok ? null : agentErrorClass(status, r.error_class);
    const exitCode = r.exit_code == null ? null : Number(r.exit_code);
    const inputTokens = r.input_tokens == null ? null : Number(r.input_tokens);
    const outputTokens = r.output_tokens == null ? null : Number(r.output_tokens);
    const lane = CHAT_LANES.includes(r.lane as ChatLane) ? r.lane : null;
    const reasons = Array.isArray(r.reason_codes)
      ? CHAT_ROUTING_REASON_CODES.filter((reason) => r.reason_codes?.includes(reason))
      : [];
    const reasoning = (value: unknown) => (CHAT_REASONING_LEVELS.includes(value as any) ? String(value) : null);
    const boundedInt = (value: unknown) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };
    (
      db.prepare(
        `INSERT INTO agent_runs (
         build_id, op, agent, ok, parsed, latency_ms, tried_json,
         status, error_class, error_message, exit_code, model, input_tokens, output_tokens,
         lane, policy_version, reason_codes_json, requested_model, requested_reasoning,
         effective_reasoning, streaming, ttft_ms, chat_turn_id, attempt_index, escalation_source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ) as any
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
      exitCode != null && Number.isFinite(exitCode) ? Math.round(exitCode) : null,
      telemetryModelName(r.model),
      inputTokens != null && Number.isFinite(inputTokens) ? Math.round(inputTokens) : null,
      outputTokens != null && Number.isFinite(outputTokens) ? Math.round(outputTokens) : null,
      lane,
      r.policy_version === CHAT_ROUTING_POLICY_VERSION ? CHAT_ROUTING_POLICY_VERSION : null,
      reasons.length ? JSON.stringify(reasons) : null,
      telemetryModelName(r.requested_model),
      reasoning(r.requested_reasoning),
      reasoning(r.effective_reasoning),
      r.streaming == null ? null : r.streaming ? 1 : 0,
      boundedInt(r.ttft_ms),
      boundedInt(r.chat_turn_id),
      boundedInt(r.attempt_index),
      CHAT_LANES.includes(r.escalation_source as ChatLane) ? r.escalation_source : null
    );
  } catch {
    /* telemetry is best-effort — never break the loop on a write error */
  } finally {
    writesUntilCapCheck--;
    if (capPressure) pruneAgentRuns(Date.now(), true);
    else if (writesUntilCapCheck <= 0) {
      writesUntilCapCheck = WRITES_PER_CAP_CHECK;
      pruneAgentRuns(Date.now(), true);
    } else pruneAgentRuns();
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

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(ok), 0) AS ok FROM agent_runs ${where}`)
    .get(...bind) as any;
  const runs = Number(totalRow?.runs ?? 0);
  const okCount = Number(totalRow?.ok ?? 0);
  // Nearest-rank keeps an operator-facing p95 conservative even for a small
  // sample: [100, 10000] must report 10000, not the median-ish 100.
  const percentile = (values: number[], p: number): number | null => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  };
  const latencyRows = db
    .prepare(`SELECT lane, ok, latency_ms, ttft_ms, chat_turn_id, escalation_source FROM agent_runs ${where}`)
    .all(...bind) as any[];
  const latencySummary = (rows: any[]) => {
    const latency = rows
      .filter((row) => row.latency_ms != null)
      .map((row) => Number(row.latency_ms))
      .filter(Number.isFinite);
    const ttft = rows
      .filter((row) => row.ttft_ms != null)
      .map((row) => Number(row.ttft_ms))
      .filter(Number.isFinite);
    return {
      p50_ms: percentile(latency, 0.5),
      p95_ms: percentile(latency, 0.95),
      p50_ttft_ms: percentile(ttft, 0.5),
      p95_ttft_ms: percentile(ttft, 0.95),
    };
  };

  const perAgent = db
    .prepare(
      `SELECT agent,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS fail,
            COALESCE(SUM(CASE WHEN status = 'auth_required' OR error_class = 'auth_required' THEN 1 ELSE 0 END), 0) AS auth_required,
            COALESCE(SUM(CASE WHEN status = 'quota_exhausted' OR error_class = 'quota_exhausted' THEN 1 ELSE 0 END), 0) AS quota_exhausted,
            COALESCE(SUM(CASE WHEN status = 'rate_limited' OR error_class = 'rate_limited' THEN 1 ELSE 0 END), 0) AS rate_limited,
            COALESCE(SUM(CASE WHEN status = 'payment_required' OR error_class = 'payment_required' THEN 1 ELSE 0 END), 0) AS payment_required,
            COALESCE(SUM(CASE WHEN status = 'permission_denied' OR error_class = 'permission_denied' THEN 1 ELSE 0 END), 0) AS permission_denied,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COUNT(*) AS n
       FROM agent_runs ${where}
      GROUP BY agent
      ORDER BY n DESC`
    )
    .all(...bind) as any[];

  const by_agent = perAgent.map((a) => {
    const lats = (
      db
        .prepare(
          `SELECT latency_ms FROM agent_runs ${where ? where + " AND" : "WHERE"} agent = ? AND latency_ms IS NOT NULL ORDER BY latency_ms`
        )
        .all(...bind, a.agent) as any[]
    ).map((r) => Number(r.latency_ms));
    const p50 = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
    return {
      agent: a.agent,
      ok: Number(a.ok),
      fail: Number(a.fail),
      auth_required: Number(a.auth_required),
      quota_exhausted: Number(a.quota_exhausted),
      rate_limited: Number(a.rate_limited),
      payment_required: Number(a.payment_required),
      permission_denied: Number(a.permission_denied),
      p50_ms: p50,
      input_tokens: Number(a.input_tokens) || null,
      output_tokens: Number(a.output_tokens) || null,
    };
  });

  const by_op = db
    .prepare(
      `SELECT op,
            COUNT(*) AS runs,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS fail
       FROM agent_runs ${where}
      GROUP BY op
      ORDER BY runs DESC`
    )
    .all(...bind)
    .map((r: any) => ({
      op: r.op,
      runs: Number(r.runs),
      ok: Number(r.ok),
      fail: Number(r.fail),
    }));

  // `agent_runs` describe provider attempts; a single visible chat turn can
  // have several attempts, no attempt (instant capture), or be canceled before
  // one starts. The lane card must therefore be driven by the durable turn
  // ledger, with attempts used only for TTFT/provider diagnostics.
  const turnWhere = `WHERE build_id = ? AND routing_json IS NOT NULL${days ? ` AND created_at >= datetime('now', ?)` : ""}`;
  const turnBind: any[] = days ? [buildId, `-${days} days`] : [buildId];
  const turnRows = db
    .prepare(
      `SELECT id, created_at, finished_at, status, routing_json, capture_food_note_id, idempotent_replays
         FROM chat_turns ${turnWhere}`
    )
    .all(...turnBind) as any[];
  const sqliteTimestampMs = (value: unknown): number | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const iso = value.includes("T") ? value : value.replace(" ", "T");
    const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const turns = turnRows.flatMap((row) => {
    try {
      const routing = JSON.parse(String(row.routing_json));
      if (
        routing?.policy_version !== CHAT_ROUTING_POLICY_VERSION ||
        !CHAT_LANES.includes(routing?.lane as ChatLane) ||
        !Array.isArray(routing?.reason_codes)
      ) {
        return [];
      }
      const created = sqliteTimestampMs(row.created_at);
      const finished = sqliteTimestampMs(row.finished_at);
      const elapsed = created != null && finished != null && finished >= created ? finished - created : null;
      return [
        {
          id: Number(row.id),
          lane: routing.lane as ChatLane,
          status: String(row.status),
          elapsed_ms: elapsed,
          instant_capture: row.capture_food_note_id != null,
          idempotent_replays: Math.max(0, Number(row.idempotent_replays) || 0),
          capture_correction: routing.reason_codes.includes("capture_correction"),
        },
      ];
    } catch {
      return [];
    }
  });
  const turnIds = new Set(turns.map((turn) => turn.id));
  const attemptRows = latencyRows.filter((row) => turnIds.has(Number((row as any).chat_turn_id)));
  const attemptsByTurn = new Map<number, any[]>();
  for (const row of attemptRows) {
    const id = Number((row as any).chat_turn_id);
    const existing = attemptsByTurn.get(id) ?? [];
    existing.push(row);
    attemptsByTurn.set(id, existing);
  }
  const laneSummary = (laneTurns: typeof turns) => {
    const terminal = laneTurns.filter((turn) => ["done", "error", "canceled"].includes(turn.status));
    const turnAttempts = laneTurns.flatMap((turn) => attemptsByTurn.get(turn.id) ?? []);
    const endToEnd = terminal.map((turn) => turn.elapsed_ms).filter((value): value is number => value != null);
    const ttft = turnAttempts.map((attempt) => Number(attempt.ttft_ms)).filter(Number.isFinite);
    const escalated = laneTurns.filter((turn) =>
      (attemptsByTurn.get(turn.id) ?? []).some((attempt) => attempt.escalation_source != null)
    ).length;
    return {
      runs: laneTurns.length,
      turns: laneTurns.length,
      ok: laneTurns.filter((turn) => turn.status === "done").length,
      fail: laneTurns.filter((turn) => turn.status === "error" || turn.status === "canceled").length,
      done: laneTurns.filter((turn) => turn.status === "done").length,
      error: laneTurns.filter((turn) => turn.status === "error").length,
      canceled: laneTurns.filter((turn) => turn.status === "canceled").length,
      active: laneTurns.filter((turn) => turn.status === "queued" || turn.status === "running").length,
      instant_captures: laneTurns.filter((turn) => turn.instant_capture).length,
      idempotent_replays: laneTurns.reduce((sum, turn) => sum + turn.idempotent_replays, 0),
      capture_corrections: laneTurns.filter((turn) => turn.capture_correction).length,
      escalated,
      agent_attempts: turnAttempts.length,
      p50_ms: percentile(endToEnd, 0.5),
      p95_ms: percentile(endToEnd, 0.95),
      p50_ttft_ms: percentile(ttft, 0.5),
      p95_ttft_ms: percentile(ttft, 0.95),
    };
  };
  const by_lane = CHAT_LANES.map((lane) => {
    const laneTurns = turns.filter((turn) => turn.lane === lane);
    return laneTurns.length ? { lane, ...laneSummary(laneTurns) } : null;
  }).filter(Boolean);
  const chat_turns = laneSummary(turns);

  const recent = db
    .prepare(
      `SELECT build_id, op, agent, ok, parsed, latency_ms, tried_json, status, error_class,
            error_message, exit_code, model, input_tokens, output_tokens, lane, policy_version,
            reason_codes_json, requested_model, requested_reasoning, effective_reasoning,
            streaming, ttft_ms, chat_turn_id, attempt_index, escalation_source, created_at
       FROM agent_runs ${where} ORDER BY id DESC LIMIT ?`
    )
    .all(...bind, recentN)
    .map((r: any) => ({
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
      lane: r.lane ?? null,
      policy_version: r.policy_version ?? null,
      reason_codes: (() => {
        try {
          return r.reason_codes_json ? JSON.parse(r.reason_codes_json) : [];
        } catch {
          return [];
        }
      })(),
      requested_model: r.requested_model ?? null,
      requested_reasoning: r.requested_reasoning ?? null,
      effective_reasoning: r.effective_reasoning ?? null,
      streaming: r.streaming == null ? null : !!r.streaming,
      ttft_ms: r.ttft_ms == null ? null : Number(r.ttft_ms),
      chat_turn_id: r.chat_turn_id == null ? null : Number(r.chat_turn_id),
      attempt_index: r.attempt_index == null ? null : Number(r.attempt_index),
      escalation_source: r.escalation_source ?? null,
      created_at: r.created_at,
    }));

  return {
    build_id: buildId,
    runs,
    ok_rate: runs ? Number((okCount / runs).toFixed(3)) : null,
    by_agent,
    by_op,
    by_lane,
    chat_turns,
    ...latencySummary(latencyRows),
    recent,
  };
}

export const AGENT_RUN_LIMITS = { retention_days: AGENT_RUN_RETENTION_DAYS, row_cap: AGENT_RUN_ROW_CAP };
