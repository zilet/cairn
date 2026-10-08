import { db } from "../db.js";
import {
  listAgents,
  agentVersion,
  interactiveTimeoutFor,
  loadAgents,
  resolveAgentProfileForClass,
  agentModelChoices,
  cachedAgentModels,
  normalizedAgentCapabilities,
  MODEL_CLASSES,
  type ModelClass,
  type AbstractExecutionProfile,
  type AgentProfileResolver,
  type AgentDef,
  type ReasoningLevel,
} from "../agents.js";
import crypto from "node:crypto";
import { normalizeUnit, unitsFrom, validUnit, UNIT_REGISTRY, type AthleteUnits } from "./display-words.js";
import { LAB_UNIT_SYSTEMS, type LabUnitSystem } from "./lab-units.js";
import { reportedLabSystem } from "./lab-reported-system.js";
import { getAgentAvailability } from "./agent-availability.js";
import { recordedClientTimeZone } from "./client-tz.js";
import { getAppState, setAppState } from "./app-state.js";
import { detectUnits, type UnitHint } from "./unit-system.js";
import {
  normalizeChatProfileBindings,
  normalizeProfileBindings,
  type ChatProfileBindings,
  type ProfileBindings,
} from "../chatRouting.js";

// ---------- settings & agent selection ----------
export interface Settings {
  agent_strategy: "round_robin" | "random" | "priority";
  agent_order: string[];
  disabled_agents: string[];
  rr_cursor: string | null;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  time_zone: string | null; // last valid IANA zone reported by the PWA; scheduler clock source
  onboarded: boolean;
  coach_welcomed: boolean; // the first-run welcome exchange with the coach happened (src/coachOps/welcome.ts)
  enrich_enabled: boolean;
  proactive_enabled: boolean; // nightly quiet insight + weekly read/nutrition-checkin precompute (pull-never-push)
  meal_plan_auto_draft: boolean; // weekly + protective meal-plan drafts without being asked (default OFF; meal plans are drafted on request)
  art_enabled: boolean;
  art_enabled_at: string | null;
  meal_prefs: string;
  garmin_username: string;
  garmin_password_configured: boolean;
  garmin_credentials_source: "settings" | "env" | "mixed" | "none";
  garmin_last_sync_at: string | null; // UTC ISO of the last completed sync (ok or failed)
  garmin_last_sync_status: string; // short result line: "ok: 12 activities · 14 daily" | "failed: …"
  garmin_export_strength: boolean; // send finished Cairn strength sessions back to Garmin (default ON; Garmin stays the input for runs/recovery)
  run_units: "km" | "mi"; // athlete-facing run distance and pace; the engine stays in km
  weight_units: "lb" | "kg"; // athlete-facing bodyweight and loads; stored data stays lb
  lab_units: LabUnitSystem | null; // the athlete's explicit lab-value system; null = automatic (labUnitSystem())
  lab_units_effective: LabUnitSystem; // the system lab values are shown in right now (explicit, else the system the athlete's own labs are printed in)
  garmin_last_export_attempt_at: string | null; // UTC ISO of the last write-back ATTEMPT (landed or not)
  garmin_last_export_status: string; // short result line: "ok: 8 of 14 sets" | "failed: …"
  gemini_api_key_configured: boolean;
  gemini_api_key_source: "settings" | "env" | "none";
  research_enabled: boolean; // host-side evidence research (default ON; off ⇒ deterministic, no network)
  bg_ops_enabled: boolean; // legacy compatibility flag; user-facing agentic ops always stay durable/non-blocking
  agent_routes: Record<string, string>; // optional per-task agent routing { task -> agent }; {} = no routing (Auto = today's rotation)
  chat_routing_mode: "adaptive" | "single"; // adaptive lane policy; single preserves the legacy one-profile path
  chat_profile_bindings: ChatProfileBindings; // provider -> capture|coach|deep -> optional model/reasoning
  agent_profile_bindings: AgentProfileBindings; // provider -> task -> optional model/reasoning override of TASK_EXECUTION_PROFILES
  model_class_bindings: ModelClassBindings; // provider -> fast|deep -> model the person chose; {} = every CLI runs its own default model
  update_check_enabled: boolean; // quiet daily check for a newer Cairn release (pull-never-push; off ⇒ no outbound check)
  usage_ping_enabled: boolean; // opt-in weekly anonymous usage ping (install id, version, platform, arch, Node); default OFF
  lead_mode: "lead" | "announce_first" | "review_everything"; // how much Cairn leads within server policy
  training_drive: "steady" | "push"; // how the athlete wants a stacked-days rest read: 'push' asks for targeted training when the evidence is green
  updated_at?: string;
}

// The agentic tasks a user can pin to a specific agent. These mirror the `op`
// labels threaded through runChosen / the chat loop, so a route keyed by one of
// these names is honored for that op when the caller passes "auto"/blank. Any
// other key is dropped on save (forward-compatible: an unknown task just no-ops).
export const ROUTABLE_TASKS = [
  "chat",
  "meal_plan",
  "meal_swap",
  "recipe",
  "session_suggest",
  "nutrition_checkin",
  "health_review",
  "health_synthesis",
  "insight",
  "weekly_read",
  "day_read",
  // Generalizes the health-ingestion routing pattern (originally hardcoded as
  // pickHealthAgentOrder's Claude-first default) to every agentic task class:
  //   - health: raw lab/scan transcription + food-photo vision reads — accuracy-
  //     critical, so a pin here also backs pickHealthAgentOrder's own default
  //     `agent_routes.health` lookup used by direct (non-runChosen) callers.
  //   - brain_review: the case-conference conductor + its per-domain specialist
  //     calls (see runChosen.ts taskForOp) — accuracy-critical multi-agent review.
  //   - enrich: the background activity/food/garmin-strength/exercise queue —
  //     high-volume, rotation by default.
  //   - proposal: a coaching-cadence draft, a program-evolution draft, or a
  //     blank-slate first-week composition (see taskForOp) — all shape a plan
  //     change, rotation by default.
  "health",
  "brain_review",
  "enrich",
  "proposal",
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
  health: "Lab & document ingestion",
  brain_review: "Case conference (brain review)",
  enrich: "Background enrichment",
  proposal: "Plan proposals & evolution",
};

export function listRoutableTasks() {
  return ROUTABLE_TASKS.map((key) => ({ key, label: ROUTABLE_TASK_LABELS[key] }));
}

// Default routing POLICY per task class. "accuracy" tasks deterministically prefer
// the strongest faithful transcriber/reasoner FIRST (Claude, then Codex, then the
// rest — no round-robin cursor side effect), because a curated/plausible-but-wrong
// result is costly (medical transcription, multi-specialist case review). "rotation"
// tasks spread load across enabled agents exactly like the base pickAgentOrder() —
// both interactive replies (chat/day_read/session_suggest/…) and high-volume
// background work (enrich/insight/weekly_read/proposal), where availability matters
// more than a fixed preference. Unlisted/unknown tasks fall through to "rotation" in
// pickAgentOrderForTask, which is the same as "no policy = the global rotation".
export const TASK_POLICY: Record<RoutableTask, "accuracy" | "rotation"> = {
  chat: "rotation",
  day_read: "rotation",
  session_suggest: "rotation",
  nutrition_checkin: "rotation",
  meal_plan: "rotation",
  meal_swap: "rotation",
  recipe: "rotation",
  insight: "rotation",
  weekly_read: "rotation",
  enrich: "rotation",
  proposal: "rotation",
  health: "accuracy",
  health_review: "accuracy",
  health_synthesis: "accuracy",
  brain_review: "accuracy",
};

// Folds a runChosen `op` label down to its routable task class. Most ops ARE their
// own class (the common case — pass-through), so this only needs entries where
// several ops deliberately share one pin/default:
//   - the case-conference conductor (`case_conference`) and its per-domain
//     specialist calls (`conference_<domain>`, one per specialist) both route as
//     the single "brain_review" task.
//   - a program-evolution draft (`evolve_program`) and a blank-slate first-week
//     composition (`compose_week`) share the "proposal" task with the ordinary
//     coach-draft op (`proposal`) — all three shape a plan change, and the composer
//     is the most consequential of them (it writes the whole week), so it inherits
//     the same deep/xhigh execution profile rather than declaring a thinner one.
//     (The welcome's first week runs as its own op, `welcome_week`, with its own
//     thinner profile — see TASK_EXECUTION_PROFILES.)
//   - marker reconciliation (`marker_reconcile`) shares the "health" task — it's
//     the same accuracy-critical lab-data domain as document ingestion.
// Extending this table is the only thing needed when a future op should share an
// existing class instead of inventing a new one.
export function taskForOp(op: string): string {
  if (op === "case_conference" || op.startsWith("conference_")) return "brain_review";
  if (op === "evolve_program" || op === "compose_week") return "proposal";
  if (op === "marker_reconcile") return "health";
  return op;
}

// THE op→execution-profile table: how much model, and how much thinking, each class
// of coaching work is worth. Keyed by the SAME task class as TASK_POLICY (which picks
// WHICH agent runs) — this picks HOW that agent runs, so the two policies read
// side by side and share taskForOp as their one classifier.
//
// Why this exists: with nothing pinned, effort is inherited from whatever the CLI's
// home settings happen to say, so the same op ran at a different depth on a dev box
// than on the deployed host. Every class below is decided HERE, server-side.
//
// Model classes are provider-neutral: "fast" is the everyday read, "deep" the one worth
// paying for. A class names NO model by default — every CLI runs whatever model its
// account's plan gives it, and only the effort below is server policy. A model reaches
// the CLI only when the person binds the class for that provider in Settings -> Agents
// (`model_class_bindings`, "Everyday" / "Deep work"). Reasoning tops out at xhigh by
// default; "max" exists for a user override.
//
// `chat` is deliberately ABSENT: the adaptive chat router already assigns a
// per-message lane profile (src/chatRouting.ts). An op with no entry here inherits
// nothing and behaves exactly as it did before this table existed.
export const TASK_EXECUTION_PROFILES: Record<string, AbstractExecutionProfile> = {
  // Daily reads — high-frequency, prose over an already-deterministic core.
  // day_read is the app's front door and runs under the shortest leash, so it stays
  // at the cheapest setting that still writes a good sentence.
  day_read: { model_class: "fast", reasoning: "low" },
  insight: { model_class: "fast", reasoning: "medium" },
  weekly_read: { model_class: "fast", reasoning: "medium" },
  nutrition_checkin: { model_class: "fast", reasoning: "medium" },
  week_ahead: { model_class: "fast", reasoning: "medium" },
  // The what-if (Ask): one proposed change and its ripple, read and never applied.
  what_if: { model_class: "fast", reasoning: "medium" },
  reaction_narrative: { model_class: "fast", reasoning: "medium" },
  exercise_explanation: { model_class: "fast", reasoning: "low" },
  chat_distill: { model_class: "fast", reasoning: "low" },
  // Nightly memory passes — non-interactive, small structured payloads. Named here so
  // they stop inheriting the CLI's home effort and stop landing in telemetry as "auto".
  memory_consolidation: { model_class: "fast", reasoning: "low" },
  about_me_growth: { model_class: "fast", reasoning: "medium" },
  // Background structuring — high volume, tight contracts, nothing to reason about.
  enrich: { model_class: "fast", reasoning: "low" },
  research: { model_class: "fast", reasoning: "medium" },
  // The deep pass: a flagged (outside-reference) lab finding is researched here from
  // the start, and any question whose fast pass yields no verified claim escalates
  // here once (src/research.ts) — a clinical-adjacent citation is worth the depth.
  research_deep: { model_class: "deep", reasoning: "high" },
  // Composition — a real plan the athlete will follow; worth the deeper model.
  session_suggest: { model_class: "deep", reasoning: "medium" },
  session_compose: { model_class: "deep", reasoning: "medium" },
  meal_plan: { model_class: "deep", reasoning: "medium" },
  meal_swap: { model_class: "deep", reasoning: "medium" },
  recipe: { model_class: "deep", reasoning: "medium" },
  onboard: { model_class: "deep", reasoning: "medium" },
  // The connect step's "say hello": a one-line round-trip that proves the CLI answers.
  agent_hello: { model_class: "fast", reasoning: "low" },
  // The welcome's first week (src/coachOps/welcome.ts → composeWeek, op "welcome_week").
  // Deliberately thinner than `proposal`, which the Plan tab's / MCP compose keeps: this
  // is a STARTING week the evolution loop refines from what the person actually logs,
  // and the person is sitting in front of the screen waiting for it (the deep/xhigh run
  // measured ~4 minutes live). It still travels the same contract parse and autonomy path.
  welcome_week: { model_class: "fast", reasoning: "medium" },
  exercise_reconcile: { model_class: "deep", reasoning: "medium" },
  // Self-critique passes. The NUMERIC half of each verify is no longer a model
  // call at all: `src/repo/verify-floors.ts` computes the kcal / protein / fiber
  // floors and the session time budget deterministically before the prompt exists,
  // and the pre-check outranks the model's verdict. So a cheap or truncated verify
  // can no longer degrade into no arithmetic check — that part now survives the
  // agent being down entirely.
  // What is left IS the reason for the pin: reading a free-text injury or dietary
  // constraint against a concrete plan, and repairing a draft without corrupting
  // its mechanics encoding. That is judgement, it fails OPEN (a dead verify ships
  // the draft with those checks unmade), and a weak model does it badly while
  // still returning well-formed JSON. Effort matches the composition op each one
  // guards rather than exceeding it: both run inline inside a user-facing request,
  // and a verify with a longer leash than the draft it checks would make the slow
  // path the checking, not the work.
  session_verify: { model_class: "deep", reasoning: "medium" },
  meal_plan_verify: { model_class: "deep", reasoning: "medium" },
  plan_verify: { model_class: "deep", reasoning: "medium" },
  // Clinical-adjacent reading — a curated or plausible-but-wrong result is costly.
  health: { model_class: "deep", reasoning: "high" },
  health_review: { model_class: "deep", reasoning: "high" },
  health_synthesis: { model_class: "deep", reasoning: "high" },
  // Structural change and multi-specialist review — the most consequential work.
  proposal: { model_class: "deep", reasoning: "xhigh" },
  coach_draft: { model_class: "deep", reasoning: "xhigh" },
  brain_review: { model_class: "deep", reasoning: "xhigh" },
};

// The closed key set for a user override (same shape as chat_profile_bindings).
export const PROFILE_TASKS: readonly string[] = Object.freeze(Object.keys(TASK_EXECUTION_PROFILES));

export type AgentProfileBindings = ProfileBindings<string>;

export function normalizeAgentProfileBindings(value: unknown): AgentProfileBindings {
  return normalizeProfileBindings(value, PROFILE_TASKS);
}

// ---------- the person's model choice per provider and class ----------
// settings.model_class_bindings = { provider: { fast?: model, deep?: model } }. Absent or
// empty is the default and means "the CLI's own default model" — Cairn passes no --model.
export type ModelClassBindings = Record<string, Partial<Record<ModelClass, string>>>;

// What the dropdown's free-text "Other…" accepts: a short model id or alias, no spaces.
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;
const MODEL_CLASS_SET = new Set<string>(MODEL_CLASSES);

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  let raw: unknown = value;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * Shape-only read of a stored binding map: a provider -> class -> non-empty string with
 * no control characters. Read-time on purpose: a value accepted on write from a live
 * catalog (which a restart forgets) must never vanish on the next read.
 */
function modelClassBindingsShape(value: unknown): ModelClassBindings {
  const raw = parseJsonObject(value);
  if (!raw) return {};
  const out: ModelClassBindings = {};
  for (const [providerRaw, classesRaw] of Object.entries(raw)) {
    const provider = providerRaw.trim().slice(0, 80);
    const classes = parseJsonObject(classesRaw);
    if (!provider || !classes) continue;
    const bound: Partial<Record<ModelClass, string>> = {};
    for (const cls of MODEL_CLASSES) {
      const v = typeof classes[cls] === "string" ? (classes[cls] as string).trim() : "";
      if (v && v.length <= 160 && ![...v].some((ch) => ch.charCodeAt(0) < 32)) bound[cls] = v;
    }
    if (Object.keys(bound).length) out[provider] = bound;
  }
  return out;
}

/** The models offered for `agent`'s class bindings: its live catalog (when read) first, then curated aliases. */
export function modelChoicesFor(agent: string, defs: Record<string, AgentDef> = loadAgents()): string[] {
  const def = defs[agent];
  const out: string[] = [];
  for (const m of [...(cachedAgentModels(agent) ?? []), ...agentModelChoices(def)]) if (!out.includes(m)) out.push(m);
  return out;
}

/** Whether `agent` can take a model at all (a model flag, and not the profile-ignoring stub). */
export function agentTakesModel(def: AgentDef | undefined): boolean {
  if (!def) return false;
  const caps = normalizedAgentCapabilities(def);
  return caps.model && !caps.execution_profile_noop && Array.isArray(def.model_flag);
}

/**
 * Validate a model_class_bindings write: the provider must be a known agent that takes a
 * model, the class must be fast|deep, and the model must be one it offers (its live
 * catalog or curated aliases) or a well-formed free-text id (MODEL_ID_PATTERN). Anything
 * else is dropped — an unavailable choice still runs, falling back to the CLI default
 * at spawn (runWithModelAccessFallback). A blank or "default" value clears the class.
 */
export function normalizeModelClassBindings(
  value: unknown,
  opts: { defs?: Record<string, AgentDef>; catalog?: (agent: string) => string[] | null } = {}
): ModelClassBindings {
  const defs = opts.defs ?? loadAgents();
  const catalog = opts.catalog ?? cachedAgentModels;
  const raw = parseJsonObject(value);
  if (!raw) return {};
  const out: ModelClassBindings = {};
  for (const [providerRaw, classesRaw] of Object.entries(raw)) {
    const provider = providerRaw.trim();
    const def = defs[provider];
    const classes = parseJsonObject(classesRaw);
    if (!agentTakesModel(def) || !classes) continue;
    const offered = new Set([...(catalog(provider) ?? []), ...agentModelChoices(def)]);
    const bound: Partial<Record<ModelClass, string>> = {};
    for (const [cls, modelRaw] of Object.entries(classes)) {
      if (!MODEL_CLASS_SET.has(cls) || typeof modelRaw !== "string") continue;
      const model = modelRaw.trim();
      if (!model || model === "default") continue;
      if (offered.has(model) || MODEL_ID_PATTERN.test(model)) bound[cls as ModelClass] = model;
    }
    if (Object.keys(bound).length) out[provider] = bound;
  }
  return out;
}

/**
 * Resolve ONE task's execution profile for ONE agent — the ONE place an op's model is
 * decided. The declarative class above, then any `agent_profile_bindings[agent][task]`
 * override, then the person's class choice (`model_class_bindings[agent][class]`) for
 * the model, then clamped to what that CLI actually declares (an effort above its
 * ceiling maps down). With no choice anywhere the result carries NO model: the CLI runs
 * its own default. Pure given `cfg`, so it unit-tests offline.
 */
export function resolveTaskExecutionProfile(
  task: string,
  agent: string,
  cfg?: {
    defs?: Record<string, AgentDef>;
    bindings?: unknown;
    classBindings?: unknown;
    profiles?: Record<string, AbstractExecutionProfile>;
  }
): { model?: string; reasoning?: ReasoningLevel } {
  const want = (cfg?.profiles ?? TASK_EXECUTION_PROFILES)[task];
  const settings = cfg?.bindings === undefined || cfg?.classBindings === undefined ? getSettings() : null;
  const bindings = normalizeAgentProfileBindings(
    cfg?.bindings !== undefined ? cfg.bindings : settings?.agent_profile_bindings
  );
  const bound = bindings[agent]?.[task];
  if (!want && !bound) return {};
  const classBindings = modelClassBindingsShape(
    cfg?.classBindings !== undefined ? cfg.classBindings : settings?.model_class_bindings
  );
  return resolveAgentProfileForClass(
    (cfg?.defs ?? loadAgents())[agent],
    { ...want, ...(bound ?? {}) },
    classBindings[agent]
  );
}

/** The per-agent resolver runChosen/enrich/scheduler hand to the agent layer. */
export function executionProfileForTask(task: string): AgentProfileResolver {
  return (agent: string) => resolveTaskExecutionProfile(task, agent);
}

export function executionProfileForOp(op: string): AgentProfileResolver {
  return executionProfileForTask(taskForOp(op));
}

/**
 * The interactive leash for an op, scaled by the effort THIS table asked for. A 90s
 * cap on a low-effort op is right; on a high-effort one it silently kills the run
 * mid-think and the rotation reads it as a failed agent. Based on the declarative
 * class (not a per-provider override), so it is stable and side-effect free.
 */
export function interactiveTimeoutForOp(op: string): number {
  return interactiveTimeoutFor(TASK_EXECUTION_PROFILES[taskForOp(op)]?.reasoning);
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
  ["meal_plan_auto_draft", "INTEGER DEFAULT 0"],
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
  ["research_enabled", "INTEGER DEFAULT 1"],
  ["bg_ops_enabled", "INTEGER DEFAULT 1"],
  ["agent_routes", "TEXT DEFAULT ''"],
  ["chat_routing_mode", "TEXT DEFAULT 'adaptive'"],
  ["chat_profile_bindings", "TEXT DEFAULT ''"],
  ["agent_profile_bindings", "TEXT DEFAULT ''"],
  ["model_class_bindings", "TEXT DEFAULT ''"],
  ["update_check_enabled", "INTEGER DEFAULT 1"],
  ["lead_mode", "TEXT DEFAULT 'lead'"],
  ["training_drive", "TEXT DEFAULT 'steady'"],
  ["garmin_export_strength", "INTEGER DEFAULT 1"],
  ["garmin_last_export_attempt_at", "TEXT DEFAULT ''"],
  ["garmin_last_export_status", "TEXT DEFAULT ''"],
  ["run_units", "TEXT DEFAULT 'km'"],
  ["weight_units", "TEXT DEFAULT 'lb'"],
  ["lab_units", "TEXT DEFAULT ''"],
  ["usage_ping_enabled", "INTEGER DEFAULT 0"],
  ["coach_welcomed", "INTEGER DEFAULT 0"],
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
    return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()])
      .toString("utf8")
      .trim();
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
    time_zone: recordedClientTimeZone() ?? null,
    onboarded: false,
    coach_welcomed: false,
    enrich_enabled: true, // background enrichment on by default
    proactive_enabled: true, // calm precompute (quiet insight / weekly read / nutrition check-in) on by default
    meal_plan_auto_draft: false, // meal plans are ideas drafted on request; automatic drafts are an opt-in
    art_enabled: true, // generated artwork on by default (no-op without GEMINI_API_KEY)
    art_enabled_at: null, // unset → spend telemetry shows all-time
    meal_prefs: "", // free-text meal/schedule preferences embedded in meal prompts
    garmin_username: process.env.GARMIN_USERNAME || "",
    garmin_password_configured: !!process.env.GARMIN_PASSWORD,
    garmin_credentials_source: process.env.GARMIN_USERNAME || process.env.GARMIN_PASSWORD ? "env" : "none",
    garmin_last_sync_at: null,
    garmin_last_sync_status: "",
    garmin_export_strength: true, // a finished Cairn strength session goes back to the watch by default
    run_units: UNIT_REGISTRY.distance.default, // prescriptions display in km / min/km until the athlete picks miles
    weight_units: UNIT_REGISTRY.weight.default, // bodyweight and loads in lb until the athlete picks kg
    lab_units: null, // automatic: lab values read as the athlete's own labs print them until a system is picked
    lab_units_effective: "us",
    garmin_last_export_attempt_at: null,
    garmin_last_export_status: "",
    gemini_api_key_configured: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY),
    gemini_api_key_source: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY ? "env" : "none",
    research_enabled: true, // host-side research on by default — the team grounds its findings; off ⇒ deterministic, offline
    bg_ops_enabled: true, // retained for imported settings; durable jobs are now always on for user-facing ops
    agent_routes: {}, // no per-task routing by default — "auto" rotates as before
    chat_routing_mode: "adaptive",
    chat_profile_bindings: {}, // empty means every provider keeps its own model defaults
    agent_profile_bindings: {}, // empty means every op uses the TASK_EXECUTION_PROFILES default
    model_class_bindings: {}, // empty means every CLI runs its own default model (no --model)
    update_check_enabled: true, // quiet daily update check on by default (one toggle disables the outbound call)
    usage_ping_enabled: false, // the anonymous weekly usage ping is opt-in only
    lead_mode: "lead", // bounded background coaching is the default relationship
    training_drive: "steady", // the safety floor's own rhythm until the athlete asks otherwise
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
    rowGarminUser && rowGarminPass
      ? "settings"
      : hasSettingsGarmin && hasEnvGarmin
        ? "mixed"
        : hasSettingsGarmin
          ? "settings"
          : hasEnvGarmin
            ? "env"
            : "none";
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
    time_zone: recordedClientTimeZone() ?? null,
    onboarded: !!row.onboarded,
    coach_welcomed: !!row.coach_welcomed,
    // NULL on old rows (column added by migration) defaults to enabled.
    enrich_enabled: row.enrich_enabled == null ? true : !!row.enrich_enabled,
    proactive_enabled: row.proactive_enabled == null ? true : !!row.proactive_enabled,
    // NULL on old rows (column added by migration v114) reads as OFF — the same default as a fresh install.
    meal_plan_auto_draft: row.meal_plan_auto_draft == null ? false : !!row.meal_plan_auto_draft,
    art_enabled: row.art_enabled == null ? true : !!row.art_enabled,
    art_enabled_at: String(row.art_enabled_at ?? "").trim() || null,
    meal_prefs: row.meal_prefs == null ? "" : String(row.meal_prefs),
    garmin_username: rowGarminUser || envGarminUser,
    garmin_password_configured: !!(rowGarminPass || envGarminPass),
    garmin_credentials_source: garminSource,
    garmin_last_sync_at: String(row.garmin_last_sync_at ?? "").trim() || null,
    garmin_last_sync_status: row.garmin_last_sync_status == null ? "" : String(row.garmin_last_sync_status),
    // NULL on old rows (column added by the settings column repair) defaults to ON.
    garmin_export_strength: row.garmin_export_strength == null ? true : !!row.garmin_export_strength,
    run_units: normalizeUnit("distance", row.run_units),
    weight_units: normalizeUnit("weight", row.weight_units),
    lab_units: validLabUnitSystem(row.lab_units),
    lab_units_effective: validLabUnitSystem(row.lab_units) ?? derivedLabUnitSystem(),
    garmin_last_export_attempt_at: String(row.garmin_last_export_attempt_at ?? "").trim() || null,
    garmin_last_export_status:
      row.garmin_last_export_status == null ? "" : String(row.garmin_last_export_status),
    gemini_api_key_configured: !!(rowGemini || envGemini),
    gemini_api_key_source: rowGemini ? "settings" : envGemini ? "env" : "none",
    // NULL on old rows (column added by migration v28) defaults to ON.
    research_enabled: row.research_enabled == null ? true : !!row.research_enabled,
    // NULL on old rows (column added by migration v32) defaults to ON.
    bg_ops_enabled: row.bg_ops_enabled == null ? true : !!row.bg_ops_enabled,
    // NULL/'' on old rows (column added by migration v34) parses to {} — no routing.
    agent_routes: parseRoutes(row.agent_routes),
    chat_routing_mode: row.chat_routing_mode === "single" ? "single" : "adaptive",
    chat_profile_bindings: normalizeChatProfileBindings(row.chat_profile_bindings),
    agent_profile_bindings: normalizeAgentProfileBindings(row.agent_profile_bindings),
    model_class_bindings: modelClassBindingsShape(row.model_class_bindings),
    // NULL on old rows (column added by migration v47) defaults to ON.
    update_check_enabled: row.update_check_enabled == null ? true : !!row.update_check_enabled,
    // NULL on old rows (column added by migration v120) stays OFF: the ping is opt-in only.
    usage_ping_enabled: row.usage_ping_enabled == null ? false : !!row.usage_ping_enabled,
    lead_mode: ["lead", "announce_first", "review_everything"].includes(String(row.lead_mode)) ? row.lead_mode : "lead",
    // NULL on old rows (column added by migration v89) reads as the steady rhythm.
    training_drive: String(row.training_drive) === "push" ? "push" : "steady",
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
  ).run(
    d.agent_strategy,
    JSON.stringify(d.agent_order),
    JSON.stringify(d.disabled_agents),
    d.rr_cursor,
    d.coach_enabled ? 1 : 0,
    d.coach_day,
    d.coach_hour,
    d.enrich_enabled ? 1 : 0,
    d.proactive_enabled ? 1 : 0,
    d.art_enabled ? 1 : 0,
    d.meal_prefs
  );
  return d;
}

// `keepStances` is the push-stance service's own door (src/domain/training/training-drive.ts):
// it flips the standing drive as part of setting or ending a dated stance and owns that
// stance's lifecycle itself. Every other caller is the Settings toggle, and a toggle that
// actually CHANGES the drive ends any open stance — the athlete's newest word wins.
/**
 * The athlete's display units, one field per kind in the units registry
 * (display-words.ts). Every prose builder reads THIS, never `run_units` by hand, and
 * hands it to the one formatter. Settings is the only writer; an unreadable settings
 * row speaks in the defaults (km, lb), never throws.
 */
export function athleteUnits(): AthleteUnits {
  try {
    return unitsFrom(getSettings() as unknown as Record<string, unknown>);
  } catch {
    return unitsFrom(null);
  }
}

// Where the athlete's units came from (app_state, so no settings column): "explicit" once a
// person saved a unit (Settings PUT, an MCP settings call), "detected" when a fresh install
// took its first-run guess from the device (unit-system.ts), absent before either.
const UNITS_SOURCE_KEY = "units_source";
export type UnitsSource = "explicit" | "detected";

/** How the athlete's units were set, or null while they are still the registry defaults untouched. */
export function unitsSource(): UnitsSource | null {
  const raw = getAppState(UNITS_SOURCE_KEY);
  if (raw === "explicit") return "explicit";
  if (raw?.startsWith("detected")) return "detected";
  return null;
}

// Tables a fresh install leaves empty (seedIfEmpty's blank seed writes only the exercise
// catalog) and that only the owner's use fills.
const OWNER_DATA_TABLES = [
  "bodyweight_log",
  "sessions",
  "logged_sets",
  "plan_days",
  "health_documents",
  "food_notes",
  "activities",
  "checkins",
  "chat_messages",
  "memory",
  "garmin_daily_metrics",
] as const;

/**
 * True once an install holds anything its owner put there: a weigh-in, a session or logged
 * set, a plan, a health record, a meal note, an activity, a check-in, a chat, a memory,
 * synced watch days, or a profile with anything filled in.
 * The first-run unit guess only ever suits a truly empty install — "Re-run first-time
 * setup" flips `onboarded` back to false on a long-used one, and its units are then
 * already the ones it has been reading in (a US user on default lb must not flip to kg).
 */
export function installHasData(): boolean {
  for (const table of OWNER_DATA_TABLES) {
    try {
      if ((db.prepare(`SELECT EXISTS (SELECT 1 FROM ${table}) AS x`).get() as { x?: number } | undefined)?.x) return true;
    } catch {
      // A table an old schema lacks holds nothing.
    }
  }
  try {
    const p = db
      .prepare(
        `SELECT name, age, height_cm, height_in, weight_lb, start_weight_lb, goal_weight_lb, goal_date, about_me, notes
         FROM profile WHERE id = 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (p && Object.values(p).some((v) => v != null && String(v).trim() !== "")) return true;
  } catch {}
  return false;
}

/**
 * The first-run unit guess. A fresh install — never onboarded, units still the registry
 * defaults, and no unit ever chosen or detected — adopts the units the device's locale
 * and zone point at, once. Anything else is a no-op: an explicit choice is never
 * overridden, a detection never re-runs, and an install that onboarded before this
 * existed, or holds any data of its own (installHasData), keeps the units it has been
 * reading in — "Re-run first-time setup" included. A hint with no usable signal leaves
 * everything as it is, so a later boot can still try. Returns the units in effect and
 * whether this call changed them.
 */
export function applyDetectedUnits(hint: UnitHint): {
  applied: boolean;
  units: AthleteUnits;
  source: UnitsSource | null;
} {
  const cur = getSettings();
  const now = (applied: boolean) => ({ applied, units: athleteUnits(), source: unitsSource() });
  if (unitsSource() != null || cur.onboarded || installHasData()) return now(false);
  if (cur.run_units !== UNIT_REGISTRY.distance.default || cur.weight_units !== UNIT_REGISTRY.weight.default) {
    return now(false);
  }
  const detected = detectUnits(hint);
  if (!detected) return now(false);
  db.prepare(`UPDATE settings SET run_units = ?, weight_units = ?, updated_at = datetime('now') WHERE id = 1`).run(
    detected.distance,
    detected.weight
  );
  const why = [hint.locale, hint.timeZone]
    .map((v) => String(v ?? "").trim().slice(0, 64))
    .filter(Boolean)
    .join(" ");
  setAppState(UNITS_SOURCE_KEY, why ? `detected:${why}` : "detected");
  return now(true);
}

/** A stored/sent lab-unit system when it is one, else null ('' / 'auto' / junk = automatic). */
export function validLabUnitSystem(value: unknown): LabUnitSystem | null {
  const v = String(value ?? "").trim().toLowerCase();
  return (LAB_UNIT_SYSTEMS as readonly string[]).includes(v) ? (v as LabUnitSystem) : null;
}

/**
 * The automatic lab system: the one most of the athlete's own lab readings from the last
 * twelve months were printed in, else their most recent draw's (lab-reported-system.ts);
 * a tie or no labs reads conventional (US). Never derived from the weight unit —
 * plenty of kilogram countries print mg/dL, and an install on kg must not change how its
 * labs read on upgrade.
 */
export function derivedLabUnitSystem(): LabUnitSystem {
  return reportedLabSystem() ?? "us";
}

/**
 * The unit system lab values are SHOWN in (src/repo/lab-display.ts): the athlete's
 * explicit choice, else the system their own labs are printed in (derivedLabUnitSystem).
 * Display only — every comparison runs in the canonical unit. An unreadable settings row reads US conventional, never throws.
 * One settings read (`lab_units_effective` is that same resolution, made in
 * rowToSettings); a per-marker loop still resolves it ONCE and passes it down.
 */
export function labUnitSystem(): LabUnitSystem {
  try {
    return validLabUnitSystem(getSettings().lab_units_effective) ?? "us";
  } catch {
    return "us";
  }
}

export function setSettings(patch: any, opts: { keepStances?: boolean } = {}): Settings {
  ensureSettingsSchema();
  const cur = getSettings();
  // Re-running first-time setup re-arms nothing: the units a long-used install has been
  // reading in are its own, whether or not anyone ever "chose" them. Stamp them before
  // `onboarded` drops, so no later first-run guess can move them.
  if (patch.onboarded === false && unitsSource() == null && installHasData()) setAppState(UNITS_SOURCE_KEY, "explicit");
  const raw = db
    .prepare(
      `SELECT garmin_username, garmin_password, garmin_password_encrypted, gemini_api_key, gemini_api_key_encrypted FROM settings WHERE id = 1`
    )
    .get() as any;
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
    time_zone: recordedClientTimeZone() ?? null,
    onboarded: patch.onboarded !== undefined ? !!patch.onboarded : cur.onboarded,
    coach_welcomed: patch.coach_welcomed !== undefined ? !!patch.coach_welcomed : cur.coach_welcomed,
    enrich_enabled: patch.enrich_enabled !== undefined ? !!patch.enrich_enabled : cur.enrich_enabled,
    proactive_enabled: patch.proactive_enabled !== undefined ? !!patch.proactive_enabled : cur.proactive_enabled,
    meal_plan_auto_draft:
      patch.meal_plan_auto_draft !== undefined ? !!patch.meal_plan_auto_draft : cur.meal_plan_auto_draft,
    art_enabled: patch.art_enabled !== undefined ? !!patch.art_enabled : cur.art_enabled,
    // Stamp the moment art flips off→on; spend telemetry reports from here.
    // Stored as UTC "YYYY-MM-DD HH:MM:SS" so it compares with datetime('now').
    art_enabled_at:
      patch.art_enabled !== undefined && patch.art_enabled && !cur.art_enabled
        ? new Date().toISOString().slice(0, 19).replace("T", " ")
        : cur.art_enabled_at,
    meal_prefs: String(patch.meal_prefs ?? cur.meal_prefs)
      .trim()
      .slice(0, 2000),
    garmin_username:
      patch.garmin_username !== undefined
        ? String(patch.garmin_username).trim().slice(0, 320)
        : String(raw?.garmin_username ?? ""),
    garmin_password_configured: !!garminPasswordForStatus || cur.garmin_password_configured,
    garmin_credentials_source: cur.garmin_credentials_source,
    // Sync status is read-only here — recorded by setGarminSyncStatus() and not
    // part of the UPDATE below, so a settings save never clobbers it.
    garmin_last_sync_at: cur.garmin_last_sync_at,
    garmin_last_sync_status: cur.garmin_last_sync_status,
    garmin_export_strength:
      patch.garmin_export_strength !== undefined ? !!patch.garmin_export_strength : cur.garmin_export_strength,
    // Units: a valid option replaces, anything else KEEPS what is stored (the registry
    // in display-words.ts is the one list of options).
    run_units: validUnit("distance", patch.run_units) ?? cur.run_units,
    weight_units: validUnit("weight", patch.weight_units) ?? cur.weight_units,
    // Lab units are written by their own UPDATE below (validLabUnitSystem); the returned
    // settings are re-read, so these placeholders never reach the caller.
    lab_units: cur.lab_units,
    lab_units_effective: cur.lab_units_effective,
    // Write-back status is read-only here too — recorded by setGarminExportStatus().
    garmin_last_export_attempt_at: cur.garmin_last_export_attempt_at,
    garmin_last_export_status: cur.garmin_last_export_status,
    gemini_api_key_configured: !!geminiApiKeyForStatus || cur.gemini_api_key_configured,
    gemini_api_key_source: cur.gemini_api_key_source,
    research_enabled: patch.research_enabled !== undefined ? !!patch.research_enabled : cur.research_enabled,
    bg_ops_enabled: patch.bg_ops_enabled !== undefined ? !!patch.bg_ops_enabled : cur.bg_ops_enabled,
    // Per-task routing: validated below (known task + known agent only).
    agent_routes: patch.agent_routes !== undefined ? parseRoutes(patch.agent_routes) : cur.agent_routes,
    chat_routing_mode: ["adaptive", "single"].includes(String(patch.chat_routing_mode))
      ? patch.chat_routing_mode
      : cur.chat_routing_mode,
    chat_profile_bindings:
      patch.chat_profile_bindings !== undefined
        ? normalizeChatProfileBindings(patch.chat_profile_bindings)
        : cur.chat_profile_bindings,
    agent_profile_bindings:
      patch.agent_profile_bindings !== undefined
        ? normalizeAgentProfileBindings(patch.agent_profile_bindings)
        : cur.agent_profile_bindings,
    // Validated against each provider's offered models (or a well-formed free-text id);
    // unknown providers/classes and malformed ids are dropped.
    model_class_bindings:
      patch.model_class_bindings !== undefined
        ? normalizeModelClassBindings(patch.model_class_bindings)
        : cur.model_class_bindings,
    update_check_enabled:
      patch.update_check_enabled !== undefined ? !!patch.update_check_enabled : cur.update_check_enabled,
    usage_ping_enabled:
      patch.usage_ping_enabled !== undefined ? !!patch.usage_ping_enabled : cur.usage_ping_enabled,
    lead_mode: ["lead", "announce_first", "review_everything"].includes(String(patch.lead_mode))
      ? patch.lead_mode
      : cur.lead_mode,
    // Same shape as lead_mode: an unrecognized value KEEPS what is stored rather than
    // resetting it, so a client that omits the field (or sends junk) can never silently
    // switch the athlete's standing posture.
    training_drive: ["steady", "push"].includes(String(patch.training_drive))
      ? patch.training_drive
      : cur.training_drive,
  };
  if (!["round_robin", "random", "priority"].includes(merged.agent_strategy)) merged.agent_strategy = "round_robin";
  merged.coach_day = Number.isInteger(Number(merged.coach_day))
    ? Math.max(0, Math.min(6, Number(merged.coach_day)))
    : 0;
  merged.coach_hour = Number.isInteger(Number(merged.coach_hour))
    ? Math.max(0, Math.min(23, Number(merged.coach_hour)))
    : 20;
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
       research_enabled=?, bg_ops_enabled=?, agent_routes=?, chat_routing_mode=?, chat_profile_bindings=?, agent_profile_bindings=?, model_class_bindings=?, update_check_enabled=?, lead_mode=?, training_drive=?, garmin_export_strength=?, run_units=?, weight_units=?, meal_plan_auto_draft=?, usage_ping_enabled=?, coach_welcomed=?, updated_at=datetime('now') WHERE id = 1`
  ).run(
    merged.agent_strategy,
    JSON.stringify(merged.agent_order),
    JSON.stringify(merged.disabled_agents),
    merged.rr_cursor,
    merged.coach_enabled ? 1 : 0,
    merged.coach_day,
    merged.coach_hour,
    merged.onboarded ? 1 : 0,
    merged.enrich_enabled ? 1 : 0,
    merged.proactive_enabled ? 1 : 0,
    merged.art_enabled ? 1 : 0,
    merged.art_enabled_at ?? "",
    merged.meal_prefs,
    merged.garmin_username,
    garminPasswordStorage.legacy,
    garminPasswordStorage.encrypted,
    geminiApiKeyStorage.legacy,
    geminiApiKeyStorage.encrypted,
    merged.research_enabled ? 1 : 0,
    merged.bg_ops_enabled ? 1 : 0,
    JSON.stringify(merged.agent_routes),
    merged.chat_routing_mode,
    JSON.stringify(merged.chat_profile_bindings),
    JSON.stringify(merged.agent_profile_bindings),
    JSON.stringify(merged.model_class_bindings),
    merged.update_check_enabled ? 1 : 0,
    merged.lead_mode,
    merged.training_drive,
    merged.garmin_export_strength ? 1 : 0,
    merged.run_units,
    merged.weight_units,
    merged.meal_plan_auto_draft ? 1 : 0,
    merged.usage_ping_enabled ? 1 : 0,
    merged.coach_welcomed ? 1 : 0
  );
  // A person saving a unit makes it theirs: the first-run detection never runs over it.
  // The Settings screen re-sends every field on any save, so once units were DETECTED an
  // unchanged unit is not a new choice — only a changed one is (the region note stays true).
  const runSent = validUnit("distance", patch.run_units);
  const weightSent = validUnit("weight", patch.weight_units);
  const changed = (runSent != null && runSent !== cur.run_units) || (weightSent != null && weightSent !== cur.weight_units);
  if (changed || ((runSent != null || weightSent != null) && unitsSource() == null)) {
    if (getAppState(UNITS_SOURCE_KEY) !== "explicit") setAppState(UNITS_SOURCE_KEY, "explicit");
  }
  // The lab-value system: 'us' | 'si' sets it; 'auto' / '' / null hands it back to the
  // automatic default; an absent field (or junk) keeps what is stored.
  if (patch.lab_units !== undefined) {
    const lab = validLabUnitSystem(patch.lab_units);
    const clear = patch.lab_units === null || ["", "auto"].includes(String(patch.lab_units).trim().toLowerCase());
    if (lab || clear) db.prepare(`UPDATE settings SET lab_units = ? WHERE id = 1`).run(lab ?? "");
  }
  if (!opts.keepStances && merged.training_drive !== cur.training_drive) {
    try {
      db.prepare(
        `UPDATE training_stances SET ended_at = datetime('now'), ended_reason = 'settings_toggle' WHERE ended_at IS NULL`
      ).run();
    } catch {
      // A DB without the stance table has nothing to end.
    }
  }
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
    String(status ?? "")
      .trim()
      .slice(0, 200)
  );
}

/**
 * Recorded by the `garmin_export` queue job (src/enrich.ts) on every write-back that
 * was actually attempted. The sibling of setGarminSyncStatus, and for the same reason:
 * without it a PUT that has been failing for two days is invisible — the Cairn log
 * looks complete, Garmin quietly holds nothing, and the only trace is a log line
 * nobody reads. Routine no-ops (the toggle off, no credentials) never write here.
 */
export function setGarminExportStatus(status: string) {
  getSettings(); // lazily creates the singleton row
  db.prepare(`UPDATE settings SET garmin_last_export_attempt_at = ?, garmin_last_export_status = ? WHERE id = 1`).run(
    new Date().toISOString(),
    String(status ?? "")
      .trim()
      .slice(0, 200)
  );
}

export function getGeminiApiKey() {
  ensureSettingsSchema();
  let row = db.prepare(`SELECT * FROM settings WHERE id = 1`).get() as any;
  if (row) row = sealLegacySettingsSecrets(row);
  return readStoredSecret(row, "gemini_api_key") || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || "";
}

// The live hold for one agent, shaped for the client contract. Failure-safe: a
// telemetry table problem must never take down Settings.
function availabilityFor(name: string, now: Date) {
  try {
    const row = getAgentAvailability(name, now);
    if (!row) return null;
    return {
      state: row.state,
      detail: row.detail,
      resets_at: row.resets_at,
      hold_until: row.hold_until,
      window: row.window,
    };
  } catch {
    return null;
  }
}

// agents.json merged with settings: effective order + enabled/usable flags.
// `present` reports whether the agent's CLI binary is actually installed (cached
// probe in agents.ts); `configured` is the tri-state login probe (true logged-in /
// false logged-out / null undetectable); `usable` rolls up the four things a run
// needs — enabled by the user, the binary present, any required env var set, AND
// the agent not KNOWN logged-out. Only `configured === false` excludes (never
// `null` — an undetectable agent stays in the rotation). `version`/`can_login`/
// `models_list` and `capabilities` are read-only visibility fields (computed here,
// never persisted). `listAgents()` already normalizes capabilities to the small
// public contract, so do not expose the underlying CLI definition or argv here.
export function getAgentConfig() {
  const s = getSettings();
  const now = new Date();
  const all = listAgents() as any[];
  const byName = new Map(all.map((a) => [a.name, a]));
  const ordered: string[] = [];
  for (const n of s.agent_order) if (byName.has(n) && !ordered.includes(n)) ordered.push(n);
  for (const a of all) if (!ordered.includes(a.name)) ordered.push(a.name);
  const disabled = new Set(s.disabled_agents);
  return ordered.map((name) => {
    const a = byName.get(name);
    const present = !!a.present;
    // An absent optional CLI is not an enabled provider. Besides matching runtime
    // reality (`usable` already required `present`), this keeps a fresh lean install
    // visually Off until the person deliberately installs and enables the tool.
    const enabled = present && !disabled.has(name);
    const env_ok = !!a.env_ok;
    const configured: boolean | null = a.configured ?? null;
    return {
      name,
      description: a.description,
      // First-run provider tile copy (agents.json `label` / `plan`); null for the stub.
      label: a.label ?? null,
      plan: a.plan ?? null,
      env_ok,
      present,
      enabled,
      configured,
      // installed CLI version (cached --version probe; null when absent/unreadable)
      version: present ? agentVersion(name) : null,
      can_login: !!a.can_login,
      models_list: !!a.models_list,
      // Curated aliases offered for Everyday / Deep work (the live catalog is fetched lazily).
      model_choices: Array.isArray(a.model_choices) ? a.model_choices : [],
      installable: !!a.installable,
      install_method: a.install_method ?? null,
      install_version: a.install_version ?? null,
      web_access: !!a.web_access,
      capabilities: a.capabilities,
      // Why this provider is sitting out right now (out of quota / credit /
      // throttled / signed out) and until when — null when it is available.
      // A hold never changes `usable`: it is a prediction the rotation prefers
      // around, not an exclusion (see src/agentAvailability.ts).
      availability: availabilityFor(name, now),
      usable: enabled && present && env_ok && configured !== false,
      // POSITIVELY signed in: the login probe (or a real answered round trip) said
      // yes. `usable` keeps an undetectable (null) login in the rotation so a working
      // agent is never false-negatived out; the first-run welcome and the coach line
      // must never call that "connected", so they read this instead.
      signed_in: present && env_ok && configured === true,
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
  cfg?: { routes?: Record<string, string>; enabled?: string[] }
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
  const enabled =
    cfg?.enabled ??
    getAgentConfig()
      .filter((a) => a.usable)
      .map((a) => a.name);
  return enabled.includes(pinned) ? pinned : requested;
}

// Whether a background estimate (the food/photo enrichment pass) can run at all right
// now: enrichment switched on AND at least one usable agent. Side-effect free — it never
// advances the rotation cursor — so copy can decide whether to promise a background
// estimate without spending a pick. The reason says which of the two is missing.
export function backgroundEstimateAvailability(): { ok: true } | { ok: false; reason: "enrichment_off" | "no_agent" } {
  if (!getSettings().enrich_enabled) return { ok: false, reason: "enrichment_off" };
  return getAgentConfig().some((a) => a.usable) ? { ok: true } : { ok: false, reason: "no_agent" };
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
  const enabled = getAgentConfig()
    .filter((a) => a.usable)
    .map((a) => a.name);
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
  cfg?: { enabled?: string[]; route?: string }
): string[] {
  const enabled =
    cfg?.enabled ??
    getAgentConfig()
      .filter((a) => a.usable)
      .map((a) => a.name);
  if (enabled.length <= 1) return enabled;
  const routed = cfg?.route ?? getSettings().agent_routes?.health;
  const head: string[] = [];
  if (routed && enabled.includes(routed)) head.push(routed);
  for (const p of prefer) if (enabled.includes(p) && !head.includes(p)) head.push(p);
  return [...head, ...enabled.filter((n) => !head.includes(n))];
}

// Agent order for LIVE web research — a web-capable CLI (declares `web_access: true`
// in agents.json, surfaced through getAgentConfig) must run FIRST, since the whole
// point is browsing to ground a claim; a non-browsing agent can only hallucinate a
// citation (which the research firewall then discards). Mirrors pickHealthAgentOrder:
// NO round-robin cursor side effect, [] when nothing is usable. `research` isn't a
// per-task route key, so an explicit pin is honored upstream (runChosen) instead.
// `cfg` injects the usable set + web flags so the ordering is unit-testable offline.
export function pickResearchAgentOrder(cfg?: { agents?: { name: string; web_access?: boolean }[] }): string[] {
  const all =
    cfg?.agents ??
    getAgentConfig()
      .filter((a) => a.usable)
      .map((a) => ({ name: a.name, web_access: !!a.web_access }));
  const enabled = all.map((a) => a.name);
  if (enabled.length <= 1) return enabled;
  const web = all.filter((a) => a.web_access).map((a) => a.name);
  return [...web, ...enabled.filter((n) => !web.includes(n))];
}

// THE generalized task-based order resolver — the "right model for the job" layer.
// Resolution order: (1) an explicit, usable `agent_routes.<task>` pin WINS — for a
// ROTATION-policy task as a one-element order (exclusive-pin semantics mirroring
// resolveAgentForTask everywhere else: a pin means "only this agent"), but for an
// ACCURACY-policy task as pin-FIRST WITH a fallthrough tail (the accuracy paths must not
// hard-fail on a dead pinned CLI — a downgraded-but-faithful transcriber beats none); else
// (2) the task class's default POLICY order (TASK_POLICY: strongest-first for
// "accuracy", the ordinary rotation for "rotation"/unknown); there is no separate
// "(3) global rotation" step because the rotation policy already IS pickAgentOrder().
//
// This is the single source of truth consulted by BOTH runChosen (op-labeled calls,
// via taskForOp) and callers that bypass runChosen entirely (the background
// enrichment queue, the legacy scheduled coach-draft) — so a pin/policy behaves
// identically no matter which path reaches an agent. `cfg` lets tests inject the
// usable set + routes without touching the DB or the round-robin cursor.
export function pickAgentOrderForTask(
  task: string,
  cfg?: { enabled?: string[]; routes?: Record<string, string> }
): string[] {
  const enabled = cfg?.enabled ?? getAgentConfig().filter((a) => a.usable).map((a) => a.name);
  const routed = resolveAgentForTask(task, "auto", { routes: cfg?.routes ?? getSettings().agent_routes, enabled });
  const accuracy = TASK_POLICY[task as RoutableTask] === "accuracy";
  if (routed && routed !== "auto") {
    // Asymmetric pin semantics by policy. A ROTATION-policy pin is exclusive ("only this
    // agent"), matching resolveAgentForTask everywhere else. But an ACCURACY-critical pin
    // (health / health_review / health_synthesis / brain_review) is pin-FIRST WITH a
    // fallthrough tail — these paths must never hard-fail on a dead pinned CLI, because an
    // un-transcribed lab is worse than a downgraded-but-faithful transcriber. The tail is
    // the same accuracy default order (Claude→Codex→rest), minus the pin itself.
    if (accuracy) {
      const tail = pickHealthAgentOrder(["claude", "codex"], { enabled, route: "" }).filter((n) => n !== routed);
      return [routed, ...tail];
    }
    return [routed];
  }
  if (accuracy) {
    // route:"" suppresses pickHealthAgentOrder's OWN internal `agent_routes.health`
    // lookup — the pin check above already resolved (or didn't find) a route for
    // THIS task, and pickHealthAgentOrder must not fall back to a DIFFERENT task's
    // (health's) pin for e.g. brain_review or health_review.
    return pickHealthAgentOrder(["claude", "codex"], { enabled, route: "" });
  }
  if (enabled.length <= 1) return enabled;
  // rotation policy, no pin: cfg-injected calls (tests) get the given set as-is —
  // there's no live settings/cursor to rotate in a test double. Real callers get
  // the ordinary rotation (round-robin/random/priority + cursor advance).
  return cfg ? enabled : pickAgentOrder();
}
