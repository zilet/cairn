import { db } from "../db.js";
import { artCircuitState, type ArtCircuitState } from "../artCircuit.js";
import { getGeminiApiKey, getSettings } from "./settings.js";

// ---------- generated-artwork bookkeeping (see src/art.ts) ----------
// art_assets: what each cached PNG depicts. art_aliases: normalized query →
// asset, so semantically-equivalent phrasings resolve to one image without
// re-asking the model. art_usage: the spend ledger behind getArtStats().

export function getArtAlias(kind: string, query: string): string | null {
  const row = db.prepare(`SELECT asset_key FROM art_aliases WHERE kind = ? AND query = ?`).get(kind, query) as any;
  return row?.asset_key ?? null;
}

export function setArtAlias(kind: string, query: string, assetKey: string) {
  db.prepare(
    `INSERT INTO art_aliases (kind, query, asset_key) VALUES (?, ?, ?)
     ON CONFLICT(kind, query) DO UPDATE SET asset_key = excluded.asset_key`
  ).run(kind, query, assetKey);
}

export function addArtAsset(key: string, kind: string, text: string) {
  db.prepare(
    `INSERT INTO art_assets (key, kind, text) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET text = excluded.text`
  ).run(key, kind, text);
}

export function listArtAssets(kind: string, limit = 150): { key: string; text: string }[] {
  return db.prepare(
    `SELECT key, text FROM art_assets WHERE kind = ? ORDER BY created_at DESC, key LIMIT ?`
  ).all(kind, limit) as any[];
}

export function recordArtUsage(u: {
  kind: string;
  query: string;
  asset_key?: string | null;
  action: "generate" | "canonicalize" | "reuse" | "fail";
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  est_cost_usd?: number;
  est_saved_usd?: number;
}) {
  db.prepare(
    `INSERT INTO art_usage (kind, query, asset_key, action, model, input_tokens, output_tokens, est_cost_usd, est_saved_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u.kind, String(u.query).slice(0, 200), u.asset_key ?? null, u.action, u.model ?? null,
    u.input_tokens ?? null, u.output_tokens ?? null,
    Number(u.est_cost_usd ?? 0) || 0, Number(u.est_saved_usd ?? 0) || 0
  );
}

export interface ArtUsageTotals {
  images_generated: number;
  canonicalize_calls: number;
  reused: number;
  failed: number;
  est_cost_usd: number;
  est_saved_usd: number;
}

function artUsageTotals(since?: string | null): ArtUsageTotals {
  const sql = `SELECT
      COALESCE(SUM(CASE WHEN action = 'generate' THEN 1 ELSE 0 END), 0) AS images_generated,
      COALESCE(SUM(CASE WHEN action = 'canonicalize' THEN 1 ELSE 0 END), 0) AS canonicalize_calls,
      COALESCE(SUM(CASE WHEN action = 'reuse' THEN 1 ELSE 0 END), 0) AS reused,
      COALESCE(SUM(CASE WHEN action = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(est_cost_usd), 0) AS est_cost_usd,
      COALESCE(SUM(est_saved_usd), 0) AS est_saved_usd
    FROM art_usage` + (since ? ` WHERE created_at >= ?` : ``);
  const row = (since ? db.prepare(sql).get(since) : db.prepare(sql).get()) as any;
  return {
    images_generated: Number(row?.images_generated ?? 0),
    canonicalize_calls: Number(row?.canonicalize_calls ?? 0),
    reused: Number(row?.reused ?? 0),
    failed: Number(row?.failed ?? 0),
    est_cost_usd: Number((Number(row?.est_cost_usd ?? 0)).toFixed(6)),
    est_saved_usd: Number((Number(row?.est_saved_usd ?? 0)).toFixed(6)),
  };
}

export interface ArtHealth {
  /** When art last actually rendered. Null means it has never succeeded. */
  last_success_at: string | null;
  last_failure_at: string | null;
  failures_7d: number;
  /** Short upstream error code from the diagnostic spine, e.g. "400:INVALID_ARGUMENT". */
  last_error_code: string | null;
  circuit: ArtCircuitState;
}

/**
 * Art-pipeline health, derived at read time — no schema of its own. The ledger
 * (art_usage) answers "did it work and when"; the diagnostic spine answers
 * "why not"; the in-process breaker answers "is it currently paused".
 */
export function getArtHealth(): ArtHealth {
  const lastSuccess = db
    .prepare(`SELECT MAX(created_at) AS at FROM art_usage WHERE action = 'generate'`)
    .get() as any;
  const lastFailure = db
    .prepare(`SELECT MAX(created_at) AS at FROM art_usage WHERE action = 'fail'`)
    .get() as any;
  const failures = db
    .prepare(`SELECT COUNT(*) AS n FROM art_usage WHERE action = 'fail' AND created_at >= datetime('now', '-7 days')`)
    .get() as any;
  let lastErrorCode: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT message FROM diagnostic_events
          WHERE source = 'worker' AND kind = 'art_upstream_error'
          ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get() as any;
    // geminiFailure() writes "<code>: <upstream message>".
    const code = String(row?.message ?? "").split(":").slice(0, 2).join(":").trim();
    lastErrorCode = code || null;
  } catch {
    /* health must never break on a telemetry read */
  }
  // Aggregate across every model the pipeline has used. This READ intentionally
  // advances the breaker: a cooldown that lapsed while nothing was generating is
  // closed here (and its close listeners fire), so health never reports a pause
  // that has already expired. Self-healing on read is the intended behavior.
  const circuit = artCircuitState();
  return {
    last_success_at: lastSuccess?.at ?? null,
    last_failure_at: lastFailure?.at ?? null,
    failures_7d: Number(failures?.n ?? 0),
    last_error_code: circuit.last_error_code ?? lastErrorCode,
    circuit,
  };
}

export function getArtStats() {
  const s = getSettings();
  const assets = db.prepare(`SELECT COUNT(*) AS n FROM art_assets`).get() as any;
  const aliases = db.prepare(`SELECT COUNT(*) AS n FROM art_aliases`).get() as any;
  return {
    health: getArtHealth(),
    art_enabled: s.art_enabled,
    gemini_configured: !!getGeminiApiKey(),
    enabled_at: s.art_enabled_at,
    since_enabled: artUsageTotals(s.art_enabled_at),
    all_time: artUsageTotals(),
    cached_assets: Number(assets?.n ?? 0),
    aliases: Number(aliases?.n ?? 0),
  };
}
