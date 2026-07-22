import { db, todayISO } from "../db.js";

export type AttentionDomain = "training" | "running" | "nutrition" | "health" | "recovery" | "body" | "journey";
export type AttentionTier = "active" | "confirming" | "surveillance" | "released";
export type AttentionSignalStatus = "flagged" | "active" | "clean" | "stable" | "normal" | "optimal" | "anomalous";
export type AttentionEvent =
  | "measurement"
  | "symptom"
  | "question"
  | "struggle"
  | "goal_change"
  | "intervention_started"
  | "intervention_changed"
  | "phase_change"
  | "anomaly";

export interface CadencePolicy {
  signal_class: string;
  domain: AttentionDomain;
  source?: string;
  active_days?: number;
  confirming_days?: number;
  surveillance_initial_days?: number;
  surveillance_multiplier?: number;
  surveillance_max_days?: number;
  surveillance_checks_before_release?: number;
  reason?: string;
  release_condition?: string;
}

export interface AttentionObservation {
  checked_at?: string;
  status: AttentionSignalStatus;
  event?: AttentionEvent;
  source?: string;
  reason?: string;
  release_condition?: string;
}

export interface AttentionStateMeta {
  clean_checks: number;
  confirming_checks: number;
  surveillance_checks: number;
  surveillance_interval_days: number;
  last_event?: AttentionEvent;
}

export interface AttentionScheduleEntry {
  signal_key: string;
  domain: AttentionDomain;
  tier: AttentionTier;
  next_due: string | null;
  last_checked: string;
  reason: string;
  release_condition: string;
  source: string;
  state: AttentionStateMeta;
  updated_at?: string;
}

interface AttentionRow {
  signal_key: string;
  domain: string;
  tier: string;
  next_due: string | null;
  last_checked: string;
  reason: string;
  release_condition: string;
  source: string | null;
  state_json: string | null;
  updated_at: string | null;
}

interface NormalizedPolicy {
  signal_class: string;
  domain: AttentionDomain;
  source: string;
  active_days: number;
  confirming_days: number;
  surveillance_initial_days: number;
  surveillance_multiplier: number;
  surveillance_max_days: number;
  surveillance_checks_before_release: number;
  reason: string;
  release_condition: string;
}

const REACTIVATING_EVENTS = new Set<AttentionEvent>([
  "symptom",
  "question",
  "struggle",
  "goal_change",
  "intervention_started",
  "intervention_changed",
  "phase_change",
  "anomaly",
]);

function clip(value: unknown, max = 320): string {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}...` : text;
}

function count(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function days(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = raw ? new Date(raw) : null;
  if (parsed && Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return todayISO();
}

function addDays(date: string, offset: number): string {
  const parsed = new Date(`${normalizeDate(date)}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Math.max(0, Math.round(offset)));
  return parsed.toISOString().slice(0, 10);
}

function normalizePolicy(policy: CadencePolicy): NormalizedPolicy {
  const surveillanceInitialDays = days(policy.surveillance_initial_days, 90);
  return {
    signal_class: clip(policy.signal_class, 100) || "signal",
    domain: policy.domain,
    source: clip(policy.source || policy.signal_class || "attention", 80),
    active_days: days(policy.active_days, 84),
    confirming_days: days(policy.confirming_days, 56),
    surveillance_initial_days: surveillanceInitialDays,
    surveillance_multiplier: Math.max(1.1, Number(policy.surveillance_multiplier) || 1.75),
    surveillance_max_days: Math.max(surveillanceInitialDays, days(policy.surveillance_max_days, 365)),
    surveillance_checks_before_release: days(policy.surveillance_checks_before_release, 2),
    reason: clip(policy.reason) || "This signal has a live lever or recent change worth checking at the right response window.",
    release_condition:
      clip(policy.release_condition) ||
      "Cleanly stable with no active intervention or goal relevance; it will resurface only on new data, a related symptom, a question, or a goal change.",
  };
}

function cleanStatus(status: AttentionSignalStatus): boolean {
  return status === "clean" || status === "stable" || status === "normal" || status === "optimal";
}

function activeStatus(status: AttentionSignalStatus): boolean {
  return status === "flagged" || status === "active" || status === "anomalous";
}

function emptyState(policy: NormalizedPolicy, event?: AttentionEvent): AttentionStateMeta {
  return {
    clean_checks: 0,
    confirming_checks: 0,
    surveillance_checks: 0,
    surveillance_interval_days: policy.surveillance_initial_days,
    last_event: event,
  };
}

function normalizeState(state: Partial<AttentionStateMeta> | null | undefined, policy: NormalizedPolicy, event?: AttentionEvent): AttentionStateMeta {
  return {
    clean_checks: count(state?.clean_checks),
    confirming_checks: count(state?.confirming_checks),
    surveillance_checks: count(state?.surveillance_checks),
    surveillance_interval_days: days(state?.surveillance_interval_days, policy.surveillance_initial_days),
    last_event: event ?? state?.last_event,
  };
}

function reasonFor(tier: AttentionTier, policy: NormalizedPolicy, observation: AttentionObservation): string {
  if (observation.reason) return clip(observation.reason);
  if (tier === "active") {
    if (observation.event === "symptom") return "A related symptom was reported, so this signal re-enters active follow-up.";
    if (observation.event === "question" || observation.event === "struggle") return "The athlete brought this signal back up, so it re-enters active follow-up.";
    if (observation.event === "goal_change" || observation.event === "phase_change") return "The goal context changed, so this signal is worth active follow-up again.";
    if (observation.event === "anomaly" || observation.status === "anomalous") return "A new anomalous reading reactivated this signal.";
    return policy.reason;
  }
  if (tier === "confirming") return "The result is clean now; confirm it holds before stretching the interval.";
  if (tier === "surveillance") return "The clean result held, so the next check can stretch instead of staying on a fixed cadence.";
  return "This signal is stable and clean with no active lever, so it goes quiet until new data or symptoms bring it back.";
}

function makeEntry(args: {
  signalKey: string;
  policy: NormalizedPolicy;
  observation: AttentionObservation;
  tier: AttentionTier;
  state: AttentionStateMeta;
  intervalDays: number | null;
}): AttentionScheduleEntry {
  const lastChecked = normalizeDate(args.observation.checked_at);
  return {
    signal_key: clip(args.signalKey, 160),
    domain: args.policy.domain,
    tier: args.tier,
    next_due: args.intervalDays == null ? null : addDays(lastChecked, args.intervalDays),
    last_checked: lastChecked,
    reason: reasonFor(args.tier, args.policy, args.observation),
    release_condition: clip(args.observation.release_condition || args.policy.release_condition),
    source: clip(args.observation.source || args.policy.source, 80),
    state: normalizeState(args.state, args.policy, args.observation.event),
  };
}

export function advanceAttentionState(args: {
  signal_key: string;
  policy: CadencePolicy;
  observation: AttentionObservation;
  previous?: AttentionScheduleEntry | null;
}): AttentionScheduleEntry {
  const policy = normalizePolicy(args.policy);
  const previous = args.previous ?? null;
  const observation = args.observation;
  const reactivated = !!observation.event && REACTIVATING_EVENTS.has(observation.event);

  if (reactivated || activeStatus(observation.status)) {
    return makeEntry({
      signalKey: args.signal_key,
      policy,
      observation,
      tier: "active",
      state: emptyState(policy, observation.event),
      intervalDays: policy.active_days,
    });
  }

  if (!cleanStatus(observation.status)) {
    return makeEntry({
      signalKey: args.signal_key,
      policy,
      observation,
      tier: previous?.tier ?? "active",
      state: normalizeState(previous?.state, policy, observation.event),
      intervalDays: policy.active_days,
    });
  }

  if (!previous || previous.tier === "released") {
    return makeEntry({
      signalKey: args.signal_key,
      policy,
      observation,
      tier: "released",
      state: { ...emptyState(policy, observation.event), clean_checks: 1 },
      intervalDays: null,
    });
  }

  if (previous.tier === "active") {
    const state = normalizeState(previous.state, policy, observation.event);
    state.clean_checks += 1;
    state.confirming_checks += 1;
    return makeEntry({ signalKey: args.signal_key, policy, observation, tier: "confirming", state, intervalDays: policy.confirming_days });
  }

  if (previous.tier === "confirming") {
    const state = normalizeState(previous.state, policy, observation.event);
    state.clean_checks += 1;
    state.confirming_checks += 1;
    state.surveillance_checks = 0;
    state.surveillance_interval_days = policy.surveillance_initial_days;
    return makeEntry({ signalKey: args.signal_key, policy, observation, tier: "surveillance", state, intervalDays: policy.surveillance_initial_days });
  }

  const state = normalizeState(previous.state, policy, observation.event);
  state.clean_checks += 1;
  state.surveillance_checks += 1;
  state.surveillance_interval_days = Math.min(
    policy.surveillance_max_days,
    Math.max(policy.surveillance_initial_days, Math.round(state.surveillance_interval_days * policy.surveillance_multiplier)),
  );
  if (state.surveillance_checks >= policy.surveillance_checks_before_release) {
    return makeEntry({ signalKey: args.signal_key, policy, observation, tier: "released", state, intervalDays: null });
  }
  return makeEntry({ signalKey: args.signal_key, policy, observation, tier: "surveillance", state, intervalDays: state.surveillance_interval_days });
}

function parseState(raw: string | null, fallbackPolicy?: NormalizedPolicy): AttentionStateMeta {
  const policy =
    fallbackPolicy ??
    normalizePolicy({
      signal_class: "attention",
      domain: "health",
    });
  if (!raw) return emptyState(policy);
  try {
    const parsed = JSON.parse(raw) as Partial<AttentionStateMeta>;
    return normalizeState(parsed, policy, parsed.last_event);
  } catch {
    return emptyState(policy);
  }
}

function hydrate(row: AttentionRow | undefined): AttentionScheduleEntry | null {
  if (!row) return null;
  return {
    signal_key: String(row.signal_key),
    domain: row.domain as AttentionDomain,
    tier: row.tier as AttentionTier,
    next_due: row.next_due == null ? null : String(row.next_due),
    last_checked: String(row.last_checked || ""),
    reason: String(row.reason || ""),
    release_condition: String(row.release_condition || ""),
    source: String(row.source || "attention"),
    state: parseState(row.state_json),
    updated_at: row.updated_at == null ? undefined : String(row.updated_at),
  };
}

export function getAttentionSchedule(signalKey: string): AttentionScheduleEntry | null {
  return hydrate(db.prepare("SELECT * FROM attention_schedule WHERE signal_key = ?").get(signalKey) as AttentionRow | undefined);
}

export function listAttentionSchedule(opts: { domain?: AttentionDomain; includeReleased?: boolean; limit?: number } = {}): AttentionScheduleEntry[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.domain) {
    where.push("domain = ?");
    params.push(opts.domain);
  }
  if (!opts.includeReleased) where.push("tier != 'released'");
  const limit = Math.min(500, Math.max(1, Math.round(Number(opts.limit) || 100)));
  const rows = db
    .prepare(`SELECT * FROM attention_schedule ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY (next_due IS NULL), next_due ASC, signal_key ASC LIMIT ?`)
    .all(...params, limit) as unknown as AttentionRow[];
  return rows.map((row) => hydrate(row)).filter((entry): entry is AttentionScheduleEntry => entry != null);
}

// Every schedule row filed under one `source` (e.g. "directive-recheck"), so a
// composition layer that owns a source can advance/read its own entries without
// scanning by domain. Excludes released rows unless asked (they carry no next_due).
export function listAttentionBySource(
  source: string,
  opts: { includeReleased?: boolean; limit?: number } = {}
): AttentionScheduleEntry[] {
  const where = ["source = ?"];
  const params: string[] = [String(source)];
  if (!opts.includeReleased) where.push("tier != 'released'");
  const limit = Math.min(500, Math.max(1, Math.round(Number(opts.limit) || 200)));
  const rows = db
    .prepare(`SELECT * FROM attention_schedule WHERE ${where.join(" AND ")} ORDER BY (next_due IS NULL), next_due ASC, signal_key ASC LIMIT ?`)
    .all(...params, limit) as unknown as AttentionRow[];
  return rows.map((row) => hydrate(row)).filter((entry): entry is AttentionScheduleEntry => entry != null);
}

export function listDueAttention(asOf: string = todayISO(), opts: { domain?: AttentionDomain; limit?: number } = {}): AttentionScheduleEntry[] {
  const where = ["next_due IS NOT NULL", "next_due <= ?", "tier != 'released'"];
  const params: string[] = [normalizeDate(asOf)];
  if (opts.domain) {
    where.push("domain = ?");
    params.push(opts.domain);
  }
  const limit = Math.min(500, Math.max(1, Math.round(Number(opts.limit) || 100)));
  const rows = db
    .prepare(`SELECT * FROM attention_schedule WHERE ${where.join(" AND ")} ORDER BY next_due ASC, signal_key ASC LIMIT ?`)
    .all(...params, limit) as unknown as AttentionRow[];
  return rows.map((row) => hydrate(row)).filter((entry): entry is AttentionScheduleEntry => entry != null);
}

export function upsertAttentionSchedule(entry: AttentionScheduleEntry): AttentionScheduleEntry {
  db.prepare(
    `INSERT INTO attention_schedule
      (signal_key, domain, tier, next_due, last_checked, reason, release_condition, source, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(signal_key) DO UPDATE SET
      domain = excluded.domain,
      tier = excluded.tier,
      next_due = excluded.next_due,
      last_checked = excluded.last_checked,
      reason = excluded.reason,
      release_condition = excluded.release_condition,
      source = excluded.source,
      state_json = excluded.state_json,
      updated_at = datetime('now')`,
  ).run(
    entry.signal_key,
    entry.domain,
    entry.tier,
    entry.next_due,
    entry.last_checked,
    entry.reason,
    entry.release_condition,
    entry.source,
    JSON.stringify(entry.state),
  );
  return getAttentionSchedule(entry.signal_key) ?? entry;
}

export function applyAttentionObservation(args: {
  signal_key: string;
  policy: CadencePolicy;
  observation: AttentionObservation;
}): AttentionScheduleEntry {
  const previous = getAttentionSchedule(args.signal_key);
  const next = advanceAttentionState({ ...args, previous });
  return upsertAttentionSchedule(next);
}
