import { db } from "../db.js";
import { listAgents, agentVersion } from "../agents.js";
import crypto from "node:crypto";

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
  bg_ops_enabled: boolean;              // run supported agentic ops as durable background jobs (off ⇒ legacy inline blocking)
  agent_routes: Record<string, string>; // optional per-task agent routing { task -> agent }; {} = no routing (Auto = today's rotation)
  update_check_enabled: boolean;        // quiet daily check for a newer Cairn release (pull-never-push; off ⇒ no outbound check)
  updated_at?: string;
}

// The agentic tasks a user can pin to a specific agent. These mirror the `op`
// labels threaded through runChosen / the chat loop, so a route keyed by one of
// these names is honored for that op when the caller passes "auto"/blank. Any
// other key is dropped on save (forward-compatible: an unknown task just no-ops).
export const ROUTABLE_TASKS = [
  "chat", "meal_plan", "meal_swap", "recipe", "session_suggest",
  "nutrition_checkin", "health_review", "health_synthesis", "insight", "weekly_read", "day_read",
] as const;
export type RoutableTask = (typeof ROUTABLE_TASKS)[number];
const ROUTABLE_TASK_SET = new Set<string>(ROUTABLE_TASKS);

export const ROUTABLE_TASK_LABELS: Record<RoutableTask, string> = {
  chat: "Chat",
  day_read: "Daily brief",
  session_suggest: "Build me a session",
  meal_plan: "Meal plan",
  meal_swap: "Meal swap",
  recipe: "Recipe",
  nutrition_checkin: "Nutrition check-in",
  insight: "Quiet insight",
  weekly_read: "Weekly read",
  health_review: "Health review",
  health_synthesis: "Health synthesis",
};

export function listRoutableTasks() {
  return ROUTABLE_TASKS.map((key) => ({ key, label: ROUTABLE_TASK_LABELS[key] }));
}

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
  ["garmin_password_encrypted", "TEXT DEFAULT ''"],
  ["gemini_api_key", "TEXT DEFAULT ''"],
  ["gemini_api_key_encrypted", "TEXT DEFAULT ''"],
  ["garmin_last_sync_at", "TEXT DEFAULT ''"],
  ["garmin_last_sync_status", "TEXT DEFAULT ''"],
  ["research_enabled", "INTEGER DEFAULT 0"],
  ["bg_ops_enabled", "INTEGER DEFAULT 1"],
  ["agent_routes", "TEXT DEFAULT ''"],
  ["update_check_enabled", "INTEGER DEFAULT 1"],
];
let settingsSchemaChecked = false;

type SettingsSecretField = "garmin_password" | "gemini_api_key";

const SECRET_ENV_KEY = "CAIRN_SETTINGS_SECRET_KEY";
const SECRET_STORAGE_PREFIX = "enc:v1";
const SECRET_ENCRYPTED_COLUMNS: Record<SettingsSecretField, string> = {
  garmin_password: "garmin_password_encrypted",
  gemini_api_key: "gemini_api_key_encrypted",
};

function settingsEncryptionKey(): Buffer | null {
  const raw = String(process.env[SECRET_ENV_KEY] ?? "").trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (raw.startsWith("base64:")) {
    try {
      const decoded = Buffer.from(raw.slice("base64:".length), "base64");
      if (decoded.length === 32) return decoded;
      if (decoded.length) return crypto.createHash("sha256").update(decoded).digest();
    } catch {
      // Fall through to hashing the raw value.
    }
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function aadForSecret(field: SettingsSecretField): Buffer {
  return Buffer.from(`cairn.settings.${field}.v1`, "utf8");
}

function encryptSettingSecret(field: SettingsSecretField, value: string): string | null {
  const key = settingsEncryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadForSecret(field));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_STORAGE_PREFIX}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptSettingSecret(field: SettingsSecretField, stored: string): string {
  const value = String(stored ?? "").trim();
  if (!value) return "";
  if (!value.startsWith(`${SECRET_STORAGE_PREFIX}:`)) return value;
  const key = settingsEncryptionKey();
  if (!key) return "";
  const [, version, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAAD(aadForSecret(field));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8").trim();
  } catch {
    return "";
  }
}

function readStoredSecret(row: any, field: SettingsSecretField): string {
  const encrypted = String(row?.[SECRET_ENCRYPTED_COLUMNS[field]] ?? "").trim();
  if (encrypted) {
    const decrypted = decryptSettingSecret(field, encrypted);
    if (decrypted) return decrypted;
  }
  return String(row?.[field] ?? "").trim();
}

function secretStorageFor(field: SettingsSecretField, value: string) {
  const clean = String(value ?? "").trim();
  if (!clean) return { legacy: "", encrypted: "" };
  const encrypted = encryptSettingSecret(field, clean);
  if (encrypted) return { legacy: "", encrypted };
  return { legacy: clean, encrypted: "" };
}

function preservedSecretStorage(row: any, field: SettingsSecretField) {
  return {
    legacy: String(row?.[field] ?? ""),
    encrypted: String(row?.[SECRET_ENCRYPTED_COLUMNS[field]] ?? ""),
  };
}

function ensureSettingsSchema() {
  if (settingsSchemaChecked) return;
  const cols = new Set((db.prepare(`PRAGMA table_info(settings)`).all() as any[]).map((r) => String(r.name)));
  for (const [name, def] of SETTINGS_COLUMN_REPAIRS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${name} ${def}`);
  }
  settingsSchemaChecked = true;
}

function sealLegacySettingsSecrets(row: any) {
  if (!settingsEncryptionKey()) return row;
  let changed = false;
  let garminPasswordEncrypted = String(row?.garmin_password_encrypted ?? "");
  let geminiApiKeyEncrypted = String(row?.gemini_api_key_encrypted ?? "");
  const legacyGarminPassword = String(row?.garmin_password ?? "").trim();
  const legacyGeminiApiKey = String(row?.gemini_api_key ?? "").trim();
  if (legacyGarminPassword) {
    const next = secretStorageFor("garmin_password", legacyGarminPassword);
    if (next.encrypted) {
      garminPasswordEncrypted = next.encrypted;
      changed = true;
    }
  }
  if (legacyGeminiApiKey) {
    const next = secretStorageFor("gemini_api_key", legacyGeminiApiKey);
    if (next.encrypted) {
      geminiApiKeyEncrypted = next.encrypted;
      changed = true;
    }
  }
  if (!changed) return row;
  db.prepare(
    `UPDATE settings
       SET garmin_password = '', garmin_password_encrypted = ?,
           gemini_api_key = '', gemini_api_key_encrypted = ?,
           updated_at = datetime('now')
       WHERE id = 1`
  ).run(garminPasswordEncrypted, geminiApiKeyEncrypted);
  return db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
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
    update_check_enabled: true, // quiet daily update check on by default (one toggle disables the outbound call)
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
  const rowGarminPass = readStoredSecret(row, "garmin_password");
  const envGarminUser = process.env.GARMIN_USERNAME || "";
  const envGarminPass = process.env.GARMIN_PASSWORD || "";
  const hasSettingsGarmin = !!(rowGarminUser || rowGarminPass);
  const hasEnvGarmin = !!(envGarminUser || envGarminPass);
  const garminSource =
    rowGarminUser && rowGarminPass ? "settings" :
    hasSettingsGarmin && hasEnvGarmin ? "mixed" :
    hasSettingsGarmin ? "settings" :
    hasEnvGarmin ? "env" : "none";
  const rowGemini = readStoredSecret(row, "gemini_api_key");
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
    // NULL on old rows (column added by migration v47) defaults to ON.
    update_check_enabled: row.update_check_enabled == null ? true : !!row.update_check_enabled,
    updated_at: row.updated_at,
  };
}

export function getSettings(): Settings {
  ensureSettingsSchema();
  let row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
  if (row) row = sealLegacySettingsSecrets(row);
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
  const raw = db.prepare(
    `SELECT garmin_username, garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1`
  ).get() as any;
  const incomingGarminPassword = patch.garmin_password !== undefined ? String(patch.garmin_password).trim() : undefined;
  const incomingGeminiKey = patch.gemini_api_key !== undefined ? String(patch.gemini_api_key).trim() : undefined;
  const existingGarminPassword = readStoredSecret(raw, "garmin_password");
  const existingGeminiApiKey = readStoredSecret(raw, "gemini_api_key");
  let garminPasswordForStatus = existingGarminPassword;
  let geminiApiKeyForStatus = existingGeminiApiKey;
  let garminPasswordStorage = preservedSecretStorage(raw, "garmin_password");
  let geminiApiKeyStorage = preservedSecretStorage(raw, "gemini_api_key");
  if (patch.clear_garmin_password) {
    garminPasswordForStatus = "";
    garminPasswordStorage = secretStorageFor("garmin_password", "");
  } else if (incomingGarminPassword !== undefined && incomingGarminPassword) {
    garminPasswordForStatus = incomingGarminPassword;
    garminPasswordStorage = secretStorageFor("garmin_password", incomingGarminPassword);
  }
  if (patch.clear_gemini_api_key) {
    geminiApiKeyForStatus = "";
    geminiApiKeyStorage = secretStorageFor("gemini_api_key", "");
  } else if (incomingGeminiKey !== undefined && incomingGeminiKey) {
    geminiApiKeyForStatus = incomingGeminiKey;
    geminiApiKeyStorage = secretStorageFor("gemini_api_key", incomingGeminiKey);
  }
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
    garmin_password_configured: !!garminPasswordForStatus || cur.garmin_password_configured,
    garmin_credentials_source: cur.garmin_credentials_source,
    // Sync status is read-only here — recorded by setGarminSyncStatus() and not
    // part of the UPDATE below, so a settings save never clobbers it.
    garmin_last_sync_at: cur.garmin_last_sync_at,
    garmin_last_sync_status: cur.garmin_last_sync_status,
    gemini_api_key_configured: !!geminiApiKeyForStatus || cur.gemini_api_key_configured,
    gemini_api_key_source: cur.gemini_api_key_source,
    research_enabled: patch.research_enabled !== undefined ? !!patch.research_enabled : cur.research_enabled,
    bg_ops_enabled: patch.bg_ops_enabled !== undefined ? !!patch.bg_ops_enabled : cur.bg_ops_enabled,
    // Per-task routing: validated below (known task + known agent only).
    agent_routes: patch.agent_routes !== undefined ? parseRoutes(patch.agent_routes) : cur.agent_routes,
    update_check_enabled: patch.update_check_enabled !== undefined ? !!patch.update_check_enabled : cur.update_check_enabled,
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
       garmin_username=?, garmin_password=?, garmin_password_encrypted=?, gemini_api_key=?, gemini_api_key_encrypted=?,
       research_enabled=?, bg_ops_enabled=?, agent_routes=?, update_check_enabled=?, updated_at=datetime('now') WHERE id = 1`
  ).run(
    merged.agent_strategy, JSON.stringify(merged.agent_order), JSON.stringify(merged.disabled_agents),
    merged.rr_cursor, merged.coach_enabled ? 1 : 0, merged.coach_day, merged.coach_hour,
    merged.onboarded ? 1 : 0, merged.enrich_enabled ? 1 : 0, merged.proactive_enabled ? 1 : 0, merged.art_enabled ? 1 : 0, merged.art_enabled_at ?? "", merged.meal_prefs,
    merged.garmin_username, garminPasswordStorage.legacy, garminPasswordStorage.encrypted, geminiApiKeyStorage.legacy, geminiApiKeyStorage.encrypted,
    merged.research_enabled ? 1 : 0, merged.bg_ops_enabled ? 1 : 0, JSON.stringify(merged.agent_routes), merged.update_check_enabled ? 1 : 0
  );
  return getSettings();
}

export function getGarminCredentials() {
  ensureSettingsSchema();
  let row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
  if (row) row = sealLegacySettingsSecrets(row);
  const username = String(row?.garmin_username ?? "").trim() || process.env.GARMIN_USERNAME || "";
  const password = readStoredSecret(row, "garmin_password") || process.env.GARMIN_PASSWORD || "";
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
  let row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
  if (row) row = sealLegacySettingsSecrets(row);
  return readStoredSecret(row, "gemini_api_key") || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || "";
}

// agents.json merged with settings: effective order + enabled/usable flags.
// `present` reports whether the agent's CLI binary is actually installed (cached
// probe in agents.ts); `configured` is the tri-state login probe (true logged-in /
// false logged-out / null undetectable); `usable` rolls up the four things a run
// needs — enabled by the user, the binary present, any required env var set, AND
// the agent not KNOWN logged-out. Only `configured === false` excludes (never
// `null` — an undetectable agent stays in the rotation). `version`/`can_login`/
// `models_list` are read-only visibility fields (computed here, never persisted).
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
    const configured: boolean | null = a.configured ?? null;
    return {
      name,
      description: a.description,
      env_ok,
      present,
      enabled,
      configured,
      // installed CLI version (cached --version probe; null when absent/unreadable)
      version: present ? agentVersion(name) : null,
      can_login: !!a.can_login,
      models_list: !!a.models_list,
      usable: enabled && present && env_ok && configured !== false,
    };
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

// Agent order for ACCURACY-CRITICAL, non-conversational extraction — health-record
// ingestion (a pasted/uploaded lab panel). Completeness matters far more than
// spreading load here: a weaker model curates a 111-marker panel down to "the
// interesting ones", so we deterministically prefer the strongest faithful
// transcriber (Claude, then Codex) first when it's usable, then fall through the
// rest of the enabled agents as a safety net. Differences from pickAgentOrder():
//   - NO round-robin cursor side effect (this isn't a rotated draft).
//   - An explicit `health` route still wins (user pinned a backend on purpose).
// Returns [] when no agent is usable (same "unconfigured" contract as the rotation).
// `cfg` lets tests inject the usable set + route without touching the DB.
export function pickHealthAgentOrder(
  prefer: string[] = ["claude", "codex"],
  cfg?: { enabled?: string[]; route?: string },
): string[] {
  const enabled = cfg?.enabled ?? getAgentConfig().filter((a) => a.usable).map((a) => a.name);
  if (enabled.length <= 1) return enabled;
  const routed = cfg?.route ?? getSettings().agent_routes?.health;
  const head: string[] = [];
  if (routed && enabled.includes(routed)) head.push(routed);
  for (const p of prefer) if (enabled.includes(p) && !head.includes(p)) head.push(p);
  return [...head, ...enabled.filter((n) => !head.includes(n))];
}
