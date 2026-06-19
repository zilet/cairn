import { db } from "../db.js";
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

export function getArtStats() {
  const s = getSettings();
  const assets = db.prepare(`SELECT COUNT(*) AS n FROM art_assets`).get() as any;
  const aliases = db.prepare(`SELECT COUNT(*) AS n FROM art_aliases`).get() as any;
  return {
    art_enabled: s.art_enabled,
    gemini_configured: !!getGeminiApiKey(),
    enabled_at: s.art_enabled_at,
    since_enabled: artUsageTotals(s.art_enabled_at),
    all_time: artUsageTotals(),
    cached_assets: Number(assets?.n ?? 0),
    aliases: Number(aliases?.n ?? 0),
  };
}
