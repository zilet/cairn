import { db } from "../db.js";
import { listAgents } from "../agents.js";

// ---------- settings & agent selection ----------
export interface Settings {
  agent_strategy: "round_robin" | "random" | "priority";
  agent_order: string[];
  disabled_agents: string[];
  rr_cursor: string | null;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  onboarded: boolean;
  enrich_enabled: boolean;
  proactive_enabled: boolean;           // nightly quiet insight + weekly read/nutrition-checkin precompute (pull-never-push)
  art_enabled: boolean;
  art_enabled_at: string | null;
  meal_prefs: string;
  garmin_username: string;
  garmin_password_configured: boolean;
  garmin_credentials_source: "settings" | "env" | "mixed" | "none";
  garmin_last_sync_at: string | null;   // UTC ISO of the last completed sync (ok or failed)
  garmin_last_sync_status: string;      // short result line: "ok: 12 activities · 14 daily" | "failed: …"
  gemini_api_key_configured: boolean;
  gemini_api_key_source: "settings" | "env" | "none";
  research_enabled: boolean;            // host-side evidence research (default OFF; off ⇒ deterministic, no network)
  bg_ops_enabled: boolean;              // run the 7 agentic ops as durable background jobs (off ⇒ legacy inline blocking)
  agent_routes: Record<string, string>; // optional per-task agent routing { task -> agent }; {} = no routing (Auto = today's rotation)
  updated_at?: string;
}

// The agentic tasks a user can pin to a specific agent. These mirror the `op`
// labels threaded through runChosen / the chat loop, so a route keyed by one of
// these names is honored for that op when the caller passes "auto"/blank. Any
// other key is dropped on save (forward-compatible: an unknown task just no-ops).
export const ROUTABLE_TASKS = [
  "chat", "meal_plan", "meal_swap", "recipe", "session_suggest",
  "nutrition_checkin", "health_review", "insight", "weekly_read", "day_read",
] as const;
export type RoutableTask = (typeof ROUTABLE_TASKS)[number];
const ROUTABLE_TASK_SET = new Set<string>(ROUTABLE_TASKS);

const SETTINGS_COLUMN_REPAIRS: [string, string][] = [
  ["agent_strategy", "TEXT DEFAULT 'round_robin'"],
  ["agent_order", "TEXT"],
  ["disabled_agents", "TEXT"],
  ["rr_cursor", "TEXT"],
  ["coach_enabled", "INTEGER DEFAULT 0"],
  ["coach_day", "INTEGER DEFAULT 0"],
  ["coach_hour", "INTEGER DEFAULT 20"],
  ["updated_at", "TEXT"],
  ["onboarded", "INTEGER DEFAULT 0"],
  ["enrich_enabled", "INTEGER DEFAULT 1"],
  ["proactive_enabled", "INTEGER DEFAULT 1"],
  ["art_enabled", "INTEGER DEFAULT 1"],
  ["art_enabled_at", "TEXT DEFAULT ''"],
  ["meal_prefs", "TEXT DEFAULT ''"],
  ["garmin_username", "TEXT DEFAULT ''"],
  ["garmin_password", "TEXT DEFAULT ''"],
  ["gemini_api_key", "TEXT DEFAULT ''"],
  ["garmin_last_sync_at", "TEXT DEFAULT ''"],
  ["garmin_last_sync_status", "TEXT DEFAULT ''"],
  ["research_enabled", "INTEGER DEFAULT 0"],
  ["bg_ops_enabled", "INTEGER DEFAULT 1"],
  ["agent_routes", "TEXT DEFAULT ''"],
];
let settingsSchemaChecked = false;

function ensureSettingsSchema() {
  if (settingsSchemaChecked) return;
  const cols = new Set((db.prepare(`PRAGMA table_info(settings)`).all() as any[]).map((r) => String(r.name)));
  for (const [name, def] of SETTINGS_COLUMN_REPAIRS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${name} ${def}`);
  }
  settingsSchemaChecked = true;
}

function defaultSettings(): Settings {
  // Seed from env on first run so existing COACH_* deployments keep working.
  return {
    agent_strategy: "round_robin",
    agent_order: [],
    disabled_agents: ["stub"], // stub returns a fake proposal; off by default
    rr_cursor: null,
    coach_enabled: !!process.env.COACH_AGENT,
    coach_day: Number(process.env.COACH_DAY ?? 0),
    coach_hour: Number(process.env.COACH_HOUR ?? 20),
    onboarded: false,
    enrich_enabled: true, // background enrichment on by default
    proactive_enabled: true, // calm precompute (quiet insight / weekly read / nutrition check-in) on by default
    art_enabled: true,    // generated artwork on by default (no-op without GEMINI_API_KEY)
    art_enabled_at: null, // unset → spend telemetry shows all-time
    meal_prefs: "",       // free-text meal/schedule preferences embedded in meal prompts
    garmin_username: process.env.GARMIN_USERNAME || "",
    garmin_password_configured: !!process.env.GARMIN_PASSWORD,
    garmin_credentials_source: process.env.GARMIN_USERNAME || process.env.GARMIN_PASSWORD ? "env" : "none",
    garmin_last_sync_at: null,
    garmin_last_sync_status: "",
    gemini_api_key_configured: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY),
    gemini_api_key_source: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY ? "env" : "none",
    research_enabled: false, // host-side research off by default — opt-in, deterministic when off
    bg_ops_enabled: true, // durable background jobs on by default (the calm, fast path)
    agent_routes: {}, // no per-task routing by default — "auto" rotates as before
  };
}

// Parse the stored agent_routes JSON map. Keeps only known tasks mapped to a
// non-empty agent name (string); silently drops anything else, so a malformed or
// stale value can never break agent selection — it just means "no routing".
function parseRoutes(s: any): Record<string, string> {
  try {
    const v = typeof s === "string" ? JSON.parse(s) : s;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!ROUTABLE_TASK_SET.has(k)) continue;
      const agent = String(val ?? "").trim();
      if (agent) out[k] = agent;
    }
    return out;
  } catch {
    return {};
  }
}

function parseArr(s: any): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToSettings(row: any): Settings {
  const rowGarminUser = String(row.garmin_username ?? "").trim();
  const rowGarminPass = String(row.garmin_password ?? "").trim();
  const envGarminUser = process.env.GARMIN_USERNAME || "";
  const envGarminPass = process.env.GARMIN_PASSWORD || "";
  const hasSettingsGarmin = !!(rowGarminUser || rowGarminPass);
  const hasEnvGarmin = !!(envGarminUser || envGarminPass);
  const garminSource =
    rowGarminUser && rowGarminPass ? "settings" :
    hasSettingsGarmin && hasEnvGarmin ? "mixed" :
    hasSettingsGarmin ? "settings" :
    hasEnvGarmin ? "env" : "none";
  const rowGemini = String(row.gemini_api_key ?? "").trim();
  const envGemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || "";
  return {
    agent_strategy: row.agent_strategy || "round_robin",
    agent_order: parseArr(row.agent_order),
    disabled_agents: parseArr(row.disabled_agents),
    rr_cursor: row.rr_cursor ?? null,
    coach_enabled: !!row.coach_enabled,
    coach_day: row.coach_day ?? 0,
    coach_hour: row.coach_hour ?? 20,
    onboarded: !!row.onboarded,
    // NULL on old rows (column added by migration) defaults to enabled.
    enrich_enabled: row.enrich_enabled == null ? true : !!row.enrich_enabled,
    proactive_enabled: row.proactive_enabled == null ? true : !!row.proactive_enabled,
    art_enabled: row.art_enabled == null ? true : !!row.art_enabled,
    art_enabled_at: String(row.art_enabled_at ?? "").trim() || null,
    meal_prefs: row.meal_prefs == null ? "" : String(row.meal_prefs),
    garmin_username: rowGarminUser || envGarminUser,
    garmin_password_configured: !!(rowGarminPass || envGarminPass),
    garmin_credentials_source: garminSource,
    garmin_last_sync_at: String(row.garmin_last_sync_at ?? "").trim() || null,
    garmin_last_sync_status: row.garmin_last_sync_status == null ? "" : String(row.garmin_last_sync_status),
    gemini_api_key_configured: !!(rowGemini || envGemini),
    gemini_api_key_source: rowGemini ? "settings" : envGemini ? "env" : "none",
    // NULL on old rows (column added by migration v28) defaults to OFF.
    research_enabled: row.research_enabled == null ? false : !!row.research_enabled,
    // NULL on old rows (column added by migration v32) defaults to ON.
    bg_ops_enabled: row.bg_ops_enabled == null ? true : !!row.bg_ops_enabled,
    // NULL/'' on old rows (column added by migration v34) parses to {} — no routing.
    agent_routes: parseRoutes(row.agent_routes),
    updated_at: row.updated_at,
  };
}

export function getSettings(): Settings {
  ensureSettingsSchema();
  const row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
  if (row) return rowToSettings(row);
  const d = defaultSettings();
  db.prepare(
    `INSERT INTO settings (id, agent_strategy, agent_order, disabled_agents, rr_cursor, coach_enabled, coach_day, coach_hour, enrich_enabled, proactive_enabled, art_enabled, meal_prefs)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(d.agent_strategy, JSON.stringify(d.agent_order), JSON.stringify(d.disabled_agents), d.rr_cursor, d.coach_enabled ? 1 : 0, d.coach_day, d.coach_hour, d.enrich_enabled ? 1 : 0, d.proactive_enabled ? 1 : 0, d.art_enabled ? 1 : 0, d.meal_prefs);
  return d;
}

export function setSettings(patch: any): Settings {
  ensureSettingsSchema();
  const cur = getSettings();
  const raw = db.prepare(`SELECT garmin_username, garmin_password, gemini_api_key FROM settings WHERE id = 1`).get() as any;
  const incomingGarminPassword = patch.garmin_password !== undefined ? String(patch.garmin_password).trim() : undefined;
  const incomingGeminiKey = patch.gemini_api_key !== undefined ? String(patch.gemini_api_key).trim() : undefined;
  const garminPassword =
    incomingGarminPassword === undefined ? (raw?.garmin_password ?? "") :
    incomingGarminPassword ? incomingGarminPassword :
    (patch.clear_garmin_password ? "" : (raw?.garmin_password ?? ""));
  const geminiApiKey =
    incomingGeminiKey === undefined ? (raw?.gemini_api_key ?? "") :
    incomingGeminiKey ? incomingGeminiKey :
    (patch.clear_gemini_api_key ? "" : (raw?.gemini_api_key ?? ""));
  const merged: Settings = {
    agent_strategy: patch.agent_strategy ?? cur.agent_strategy,
    agent_order: patch.agent_order ?? cur.agent_order,
    disabled_agents: patch.disabled_agents ?? cur.disabled_agents,
    rr_cursor: patch.rr_cursor !== undefined ? patch.rr_cursor : cur.rr_cursor,
    coach_enabled: patch.coach_enabled ?? cur.coach_enabled,
    coach_day: patch.coach_day ?? cur.coach_day,
    coach_hour: patch.coach_hour ?? cur.coach_hour,
    onboarded: patch.onboarded !== undefined ? !!patch.onboarded : cur.onboarded,
    enrich_enabled: patch.enrich_enabled !== undefined ? !!patch.enrich_enabled : cur.enrich_enabled,
    proactive_enabled: patch.proactive_enabled !== undefined ? !!patch.proactive_enabled : cur.proactive_enabled,
    art_enabled: patch.art_enabled !== undefined ? !!patch.art_enabled : cur.art_enabled,
    // Stamp the moment art flips off→on; spend telemetry reports from here.
    // Stored as UTC "YYYY-MM-DD HH:MM:SS" so it compares with datetime('now').
    art_enabled_at:
      patch.art_enabled !== undefined && patch.art_enabled && !cur.art_enabled
        ? new Date().toISOString().slice(0, 19).replace("T", " ")
        : cur.art_enabled_at,
    meal_prefs: String(patch.meal_prefs ?? cur.meal_prefs).trim().slice(0, 2000),
    garmin_username: patch.garmin_username !== undefined ? String(patch.garmin_username).trim().slice(0, 320) : String(raw?.garmin_username ?? ""),
    garmin_password_configured: !!garminPassword || cur.garmin_password_configured,
    garmin_credentials_source: cur.garmin_credentials_source,
    // Sync status is read-only here — recorded by setGarminSyncStatus() and not
    // part of the UPDATE below, so a settings save never clobbers it.
    garmin_last_sync_at: cur.garmin_last_sync_at,
    garmin_last_sync_status: cur.garmin_last_sync_status,
    gemini_api_key_configured: !!geminiApiKey || cur.gemini_api_key_configured,
    gemini_api_key_source: cur.gemini_api_key_source,
    research_enabled: patch.research_enabled !== undefined ? !!patch.research_enabled : cur.research_enabled,
    bg_ops_enabled: patch.bg_ops_enabled !== undefined ? !!patch.bg_ops_enabled : cur.bg_ops_enabled,
    // Per-task routing: validated below (known task + known agent only).
    agent_routes: patch.agent_routes !== undefined ? parseRoutes(patch.agent_routes) : cur.agent_routes,
  };
  if (!["round_robin", "random", "priority"].includes(merged.agent_strategy)) merged.agent_strategy = "round_robin";
  // Drop any route pointing at an agent that doesn't exist (agents.json is the
  // source of truth). parseRoutes already filtered task keys + empty values; an
  // empty/"auto" value would never survive that, so this only prunes typos/stale.
  if (patch.agent_routes !== undefined) {
    const known = new Set(listAgents().map((a: any) => a.name));
    merged.agent_routes = Object.fromEntries(
      Object.entries(merged.agent_routes).filter(([, agent]) => known.has(agent))
    );
  }
  db.prepare(
    `UPDATE settings SET agent_strategy=?, agent_order=?, disabled_agents=?, rr_cursor=?,
       coach_enabled=?, coach_day=?, coach_hour=?, onboarded=?, enrich_enabled=?, proactive_enabled=?, art_enabled=?, art_enabled_at=?, meal_prefs=?,
       garmin_username=?, garmin_password=?, gemini_api_key=?, research_enabled=?, bg_ops_enabled=?, agent_routes=?, updated_at=datetime('now') WHERE id = 1`
  ).run(
    merged.agent_strategy, JSON.stringify(merged.agent_order), JSON.stringify(merged.disabled_agents),
    merged.rr_cursor, merged.coach_enabled ? 1 : 0, merged.coach_day, merged.coach_hour,
    merged.onboarded ? 1 : 0, merged.enrich_enabled ? 1 : 0, merged.proactive_enabled ? 1 : 0, merged.art_enabled ? 1 : 0, merged.art_enabled_at ?? "", merged.meal_prefs,
    merged.garmin_username, garminPassword, geminiApiKey, merged.research_enabled ? 1 : 0, merged.bg_ops_enabled ? 1 : 0, JSON.stringify(merged.agent_routes)
  );
  return getSettings();
}

export function getGarminCredentials() {
  ensureSettingsSchema();
  const row = db.prepare(`SELECT garmin_username, garmin_password FROM settings WHERE id = 1`).get() as any;
  const username = String(row?.garmin_username ?? "").trim() || process.env.GARMIN_USERNAME || "";
  const password = String(row?.garmin_password ?? "").trim() || process.env.GARMIN_PASSWORD || "";
  return { username, password, configured: !!(username && password) };
}

// Recorded by syncGarmin() (src/garmin.ts) wherever a sync completes — the
// scheduler's auto-sync, manual POST /api/garmin/sync, MCP sync_garmin and the
// CLI entry point all funnel through it. Surfaced read-only in Settings.
export function setGarminSyncStatus(status: string) {
  getSettings(); // lazily creates the singleton row
  db.prepare(`UPDATE settings SET garmin_last_sync_at = ?, garmin_last_sync_status = ? WHERE id = 1`).run(
    new Date().toISOString(),
    String(status ?? "").trim().slice(0, 200)
  );
}

export function getGeminiApiKey() {
  ensureSettingsSchema();
  const row = db.prepare(`SELECT gemini_api_key FROM settings WHERE id = 1`).get() as any;
  return String(row?.gemini_api_key ?? "").trim() || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || "";
}

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

// Spend telemetry for the Settings UI / MCP: money since art was last enabled
// (falls back to all-time when the toggle predates the telemetry column),
// plus all-time totals and cache size. Costs are estimates from fixed rates.
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

// ---------- agent-run telemetry (see src/agents.ts) ----------
// One row per agent ATTEMPT, written from the runChosen / runAgentWithFallback /
// day-read paths. Makes the agentic loop observable. Mirrors the art_usage
// telemetry shape: a cheap insert + a stats roll-up. recordAgentRun NEVER throws
// into the coaching loop (callers wrap it in try/catch; we also guard here).
export function recordAgentRun(r: {
  op: string;
  agent: string;
  ok: boolean;
  parsed: boolean;
  latency_ms: number;
  tried_json: boolean;
}) {
  try {
    db.prepare(
      `INSERT INTO agent_runs (op, agent, ok, parsed, latency_ms, tried_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      String(r.op ?? "").slice(0, 60),
      String(r.agent ?? "").slice(0, 60),
      r.ok ? 1 : 0,
      r.parsed ? 1 : 0,
      Number.isFinite(r.latency_ms) ? Math.round(r.latency_ms) : null,
      r.tried_json ? 1 : 0
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
            COUNT(*) AS n
       FROM agent_runs ${where}
      GROUP BY agent
      ORDER BY n DESC`
  ).all(...bind) as any[];

  const by_agent = perAgent.map((a) => {
    // Median latency for this agent over the window (SQLite has no percentile fn).
    const lats = (db.prepare(
      `SELECT latency_ms FROM agent_runs ${where ? where + " AND" : "WHERE"} agent = ? AND latency_ms IS NOT NULL ORDER BY latency_ms`
    ).all(...bind, a.agent) as any[]).map((r) => Number(r.latency_ms));
    const p50 = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
    return { agent: a.agent, ok: Number(a.ok), fail: Number(a.fail), p50_ms: p50 };
  });

  const recent = db.prepare(
    `SELECT op, agent, ok, parsed, latency_ms, tried_json, created_at
       FROM agent_runs ${where} ORDER BY id DESC LIMIT ?`
  ).all(...bind, recentN).map((r: any) => ({
    op: r.op,
    agent: r.agent,
    ok: !!r.ok,
    parsed: !!r.parsed,
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    tried_json: !!r.tried_json,
    created_at: r.created_at,
  }));

  return {
    runs,
    ok_rate: runs ? Number((okCount / runs).toFixed(3)) : null,
    by_agent,
    recent,
  };
}

// ---------- app_state: tiny KV scratchpad for scheduler bookkeeping ----------
// Used by the proactive scheduler to persist last-run stamps so a missed slot
// still fires once after a restart. Best-effort; failure-safe.
export function getAppState(key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  } catch { return null; }
}

export function setAppState(key: string, value: string) {
  try {
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(key, String(value ?? ""));
  } catch { /* best-effort */ }
}

// agents.json merged with settings: effective order + enabled/usable flags.
// `present` reports whether the agent's CLI binary is actually installed (cached
// probe in agents.ts); `usable` rolls up the three things a run needs — enabled
// by the user, the binary present, and any required env var set.
export function getAgentConfig() {
  const s = getSettings();
  const all = listAgents() as any[];
  const byName = new Map(all.map((a) => [a.name, a]));
  const ordered: string[] = [];
  for (const n of s.agent_order) if (byName.has(n) && !ordered.includes(n)) ordered.push(n);
  for (const a of all) if (!ordered.includes(a.name)) ordered.push(a.name);
  const disabled = new Set(s.disabled_agents);
  return ordered.map((name) => {
    const a = byName.get(name);
    const enabled = !disabled.has(name);
    const present = !!a.present;
    const env_ok = !!a.env_ok;
    return { name, description: a.description, env_ok, present, enabled, usable: enabled && present && env_ok };
  });
}

// Per-task routing resolution (pure, no side effects — safe to unit-test).
// When a caller leaves the agent as "auto"/blank for a known task AND the user
// pinned that task to a specific agent that is currently ENABLED, return that
// agent name; otherwise return `requested` unchanged so the existing rotation
// (or an explicit agent the caller named) is honored exactly as before.
//   - explicit agent ("claude") wins — a named agent always overrides a route
//   - no route, or a route to a disabled/unknown agent → fall through to rotation
// The `cfg` arg lets tests inject settings + enabled set without touching the DB.
export function resolveAgentForTask(
  task: string | undefined,
  requested: string | undefined,
  cfg?: { routes?: Record<string, string>; enabled?: string[] },
): string | undefined {
  // An explicitly named agent (anything that isn't blank/"auto") is honored as-is.
  if (requested && requested !== "auto") return requested;
  if (!task) return requested;
  const routes = cfg?.routes ?? getSettings().agent_routes;
  const pinned = routes[task];
  if (!pinned) return requested;
  // Honor the route only if that agent is USABLE (enabled + binary present + env
  // ok). A disabled/missing pin silently falls back to the rotation so the
  // deterministic base always stands. Tests inject `cfg.enabled` directly; in
  // production we use the usable set (CLI presence included).
  const enabled = cfg?.enabled ?? getAgentConfig().filter((a) => a.usable).map((a) => a.name);
  return enabled.includes(pinned) ? pinned : requested;
}

// The order in which to try agents for an "auto" run, per the configured strategy.
// Round-robin advances a persisted cursor so usage rotates across drafts.
//
// Only agents that are USABLE (enabled by the user AND whose CLI binary is present
// AND whose required env is set) are returned — an agent that can't spawn would
// otherwise look like a failed run rather than "not configured". With no coaching
// CLI installed this returns [], which callers treat as "unconfigured" (the agent
// loop throws a calm "No agents enabled — turn one on in Settings", surfaced as the
// designed ok:false / graceful-degradation path, NEVER fake coaching).
export function pickAgentOrder(): string[] {
  const s = getSettings();
  const enabled = getAgentConfig().filter((a) => a.usable).map((a) => a.name);
  if (enabled.length <= 1) return enabled;
  if (s.agent_strategy === "priority") return enabled;
  if (s.agent_strategy === "random") {
    const a = [...enabled];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // round_robin
  const idx = s.rr_cursor ? enabled.indexOf(s.rr_cursor) : -1;
  const start = (idx + 1) % enabled.length;
  const rotated = [...enabled.slice(start), ...enabled.slice(0, start)];
  setSettings({ rr_cursor: rotated[0] });
  return rotated;
}
