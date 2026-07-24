import crypto from "node:crypto";
import { normalizePrescriptionItem, SESSION_PRESCRIPTION_LIMITS } from "../contracts/session-prescription.js";
import { decideDailySession, recordDailySessionDecision } from "./daily-decision.js";
import { db } from "../db.js";
import { getAgentJob } from "./chat.js";
import { findExercise, recentWorkingSeconds, recentWorkingWeight } from "./exercises.js";
import { getPlanDay } from "./plan.js";
import { selectedPlanDayForDate } from "./plan-selection.js";
import { getOrCreateSessionRow } from "./session-core.js";
import { localDateISO } from "./shared.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";

export const DAILY_SESSION_SOURCES = ["adaptive_plan", "agent_suggest", "manual_plan", "athlete_override"] as const;
export const DAILY_SESSION_SUGGESTION_NORMALIZATION = "daily_session_v1";

export type DailySessionSource = (typeof DAILY_SESSION_SOURCES)[number];

export interface PrepareDailySessionInput {
  date?: string;
  expected_active_id?: number | null;
  day_number?: number | null;
  source?: DailySessionSource | string;
  agent_job_id?: number | null;
  session?: unknown;
  constraints?: unknown;
  provenance?: unknown;
  replace?: boolean;
}

export class DailySessionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DailySessionError";
  }
}

function fail(code: string, message: string): never {
  throw new DailySessionError(code, message);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_SOURCES = new Set<DailySessionSource>(["adaptive_plan", "manual_plan"]);

function boundedText(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): number | null {
  const n = finite(value);
  if (n == null) return null;
  const bounded = Math.max(min, Math.min(max, n));
  return integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}

function normalizeJsonValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => normalizeJsonValue(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    for (const [rawKey, entry] of entries.slice(0, 40)) {
      const key = rawKey.trim().slice(0, 80);
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      if (key) out[key] = normalizeJsonValue(entry, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeOptionalJson(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const json = JSON.stringify(normalizeJsonValue(value));
  if (json.length > 12_000) throw new Error("constraints/provenance is too large");
  return json;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function requestFingerprint(input: {
  date: string;
  source: DailySessionSource;
  plan_day_id: number | null;
  payload: ReturnType<typeof normalizeSessionPayload>;
  constraints_json: string | null;
  canonical_agent_job_id: number | null;
}): string {
  const planSource = PLAN_SOURCES.has(input.source);
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        date: input.date,
        source: input.source,
        plan_day_id: input.plan_day_id,
        title: input.payload.title,
        focus: input.payload.focus,
        // Plan-selection rationale is contextual and can change after the session
        // row is linked; the actual plan snapshot defines plan-source identity.
        why: planSource ? null : input.payload.why,
        est_minutes: input.payload.est_minutes,
        items: input.payload.items,
        constraints: parseJson(input.constraints_json),
        // Only server-verified agent identity belongs in request identity.
        // Athlete/client provenance stays metadata and cannot force versions.
        canonical_agent_job_id: input.source === "agent_suggest" ? input.canonical_agent_job_id : null,
      })
    )
    .digest("hex");
}

function validateDate(value: unknown): string {
  const date = String(value || localDateISO()).trim();
  if (!DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be a valid calendar date");
  }
  return date;
}

function sourceOf(value: unknown): DailySessionSource {
  const source = String(value || "adaptive_plan") as DailySessionSource;
  if (!DAILY_SESSION_SOURCES.includes(source)) throw new Error("unsupported daily-session source");
  return source;
}

function plannedTarget(exercise: string, field: "target_weight" | "target_seconds"): number | null {
  const row = db
    .prepare(
      `SELECT pi.${field} AS value
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
        WHERE e.name = ? COLLATE NOCASE AND pi.${field} IS NOT NULL
        ORDER BY pi.id DESC LIMIT 1`
    )
    .get(exercise) as any;
  return finite(row?.value);
}

function safeAgentWeight(exercise: string, requested: unknown): number | null {
  const value = boundedNumber(requested, -1000, 5000);
  if (value == null || value === 0) return null;
  if (boundedText(findExercise(exercise)?.constraint_note, 500)) return null;
  const recent = recentWorkingWeight(exercise);
  const baseline = recent ?? plannedTarget(exercise, "target_weight");
  // A new/thin lift has no trustworthy load anchor. Keep the prescription useful
  // (sets/reps/cues) but let the athlete choose the first load in the logger.
  if (baseline == null || baseline === 0) return null;
  const maxStep = Math.max(10, Math.abs(baseline) * 0.1);
  return Math.min(value, baseline + maxStep);
}

function safeAgentSeconds(exercise: string, requested: unknown): number | null {
  const value = boundedNumber(requested, 1, 3600, true);
  if (value == null) return null;
  const recent = recentWorkingSeconds(exercise);
  const baseline = recent ?? plannedTarget(exercise, "target_seconds");
  if (baseline == null || baseline <= 0) return value;
  if (boundedText(findExercise(exercise)?.constraint_note, 500)) return Math.min(value, Math.round(baseline));
  return Math.min(value, Math.round(baseline + Math.max(10, baseline * 0.1)));
}

function normalizeInterval(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return normalizeJsonValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return normalizeJsonValue(value);
}

function normalizeItem(
  raw: unknown,
  position: number,
  agentSource: boolean,
  athleteSource: boolean,
  trustedAgentNormalized = false
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`item ${position + 1} must be an object`);
  const item = raw as Record<string, unknown>;
  const exerciseInput = boundedText(item.exercise ?? (item.kind === "cardio" ? item.note : null), 120);
  const storedMode = exerciseInput ? findExercise(exerciseInput)?.mode : null;
  const core = normalizePrescriptionItem(raw, position, {
    storedMode,
    clampBounds: true,
    strictShape: agentSource,
  });
  const { exercise, kind } = core;
  if (kind === "cardio") {
    return {
      position,
      kind,
      exercise,
      sets: null,
      rep_low: null,
      rep_high: null,
      target_weight: null,
      target_seconds: null,
      warmup_sets: null,
      mode: null,
      note: boundedText(item.note, 500),
      target_distance_km: core.target_distance_km,
      target_duration_min: core.target_duration_min,
      target_zone: boundedText(item.target_zone, 80),
      interval: normalizeInterval(item.interval ?? item.interval_json),
      superset_group: null,
    };
  }

  const mode = core.mode as "reps" | "timed";
  const targetSeconds =
    mode === "timed" && core.target_seconds != null
      ? agentSource
        ? trustedAgentNormalized
          ? core.target_seconds
          : safeAgentSeconds(exercise, core.target_seconds)
        : core.target_seconds
      : null;
  return {
    position,
    kind,
    exercise,
    sets: core.sets,
    rep_low: core.rep_low,
    rep_high: core.rep_high,
    target_weight:
      mode === "timed"
        ? null
        : agentSource
          ? trustedAgentNormalized
            ? boundedNumber(item.target_weight, -1000, 5000)
            : safeAgentWeight(exercise, item.target_weight)
          : athleteSource
            ? boundedNumber(item.target_weight, -1000, 5000)
            : finite(item.target_weight),
    target_seconds: targetSeconds,
    warmup_sets: boundedNumber(item.warmup_sets, 0, 10, true),
    mode,
    note: boundedText(item.note, 500),
    target_distance_km: null,
    target_duration_min: null,
    target_zone: null,
    interval: null,
    superset_group: boundedNumber(item.superset_group, 1, 50, true),
  };
}

function normalizeSessionPayload(
  raw: unknown,
  agentSource: boolean,
  requireSummary = false,
  allowEmpty = false,
  athleteSource = false,
  trustedAgentNormalized = false
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("session payload is required");
  const session = raw as Record<string, unknown>;
  if (!Array.isArray(session.items) || (!allowEmpty && !session.items.length)) {
    throw new Error("session items are required");
  }
  if (session.items.length > 24) throw new Error("session may contain at most 24 items");
  const items = session.items.map((item, index) =>
    normalizeItem(item, index, agentSource, athleteSource, trustedAgentNormalized)
  );
  const title = boundedText(session.title ?? session.name, 120) ?? (allowEmpty ? "Open session" : null);
  const why = boundedText(session.why, 600);
  if (requireSummary && (!title || !why)) throw new Error("agent session name and why are required");
  return {
    title,
    focus: boundedText(session.focus, 160),
    why,
    est_minutes: (() => {
      if (session.est_minutes != null) {
        const value = finite(session.est_minutes);
        if (value == null || value <= 0) throw new Error("est_minutes must be positive");
      }
      return boundedNumber(session.est_minutes, 1, SESSION_PRESCRIPTION_LIMITS.minutes, true);
    })(),
    items,
  };
}

// Canonical suggestion boundary used before a result is rendered, cached, or
// written to an agent job. This is intentionally the same agent-source path that
// prepareDailySession re-runs later, making normalization idempotent: the preview
// items are byte-for-byte the items that durable preparation will snapshot.
export function normalizeSessionSuggestionResult(raw: unknown) {
  try {
    const payload = normalizeSessionPayload(raw, true, true);
    return {
      name: payload.title,
      focus: payload.focus,
      why: payload.why,
      est_minutes: payload.est_minutes,
      items: payload.items,
    };
  } catch {
    return null;
  }
}

function planSnapshot(date: string, dayNumber?: number | null) {
  const selected = dayNumber != null ? null : selectedPlanDayForDate(date);
  const requested = dayNumber != null ? Number(dayNumber) : selected?.day_number;
  if (!Number.isInteger(requested) || Number(requested) <= 0) throw new Error("no plan day is available");
  const day = getPlanDay(Number(requested));
  if (!day) throw new Error(`plan day ${requested} not found`);
  return {
    plan_day_id: Number(day.id),
    payload: normalizeSessionPayload(
      {
        title: day.name,
        focus: day.focus,
        why:
          dayNumber != null
            ? `Explicit plan-day override: Day ${requested}.`
            : boundedText(selected?.selection?.reason, 600) || `Adaptive plan selection for ${date}.`,
        items: day.items,
      },
      false
    ),
  };
}

function canonicalAgentSuggestion(jobIdRaw: unknown, date: string) {
  const jobId = Number(jobIdRaw);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    fail(
      "agent_job_required",
      "agent_suggest requires a completed session-suggest agent_job_id; use athlete_override for a user-authored session"
    );
  }
  const job = getAgentJob(jobId) as any;
  // A Stage-3 bounded composition (session_compose) accepts the same way as a
  // session_suggest — both produce a normalized `result.session` the athlete can
  // durably accept without mutating the weekly plan.
  if (!job || (job.kind !== "session_suggest" && job.kind !== "session_compose")) {
    fail("agent_job_invalid", "agent_job_id must reference a session-suggest or session-compose job");
  }
  if (job.status !== "done" || job.result?.ok !== true || !job.result?.session) {
    fail("agent_job_not_ready", "agent_job_id must reference a completed, successful session suggestion");
  }
  const jobDate = String(job.input?.date ?? "").trim();
  if (jobDate !== date) {
    fail("agent_job_date_mismatch", "agent_job_id does not belong to the requested daily-session date");
  }
  const canonicalConstraints: Record<string, unknown> = {};
  for (const key of ["minutes", "equipment", "focus", "constraints"] as const) {
    if (job.input?.[key] != null && job.input[key] !== "") canonicalConstraints[key] = job.input[key];
  }
  return {
    session: job.result.session,
    normalized: job.result.session_normalization === DAILY_SESSION_SUGGESTION_NORMALIZATION,
    constraints: canonicalConstraints,
    provenance: {
      verification: "verified_agent_job",
      operation: job.kind,
      agent_job_id: jobId,
      agent: job.chosen_agent ?? job.result.agent ?? null,
      verified: job.result.verified ?? null,
      tried: Array.isArray(job.result.tried) ? job.result.tried : [],
    },
  };
}

function sessionRowsForDate(date: string): any[] {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM logged_sets ls WHERE ls.session_id = s.id) AS set_count,
              (SELECT COUNT(*) FROM session_skips ss WHERE ss.session_id = s.id) AS skip_count
         FROM sessions s WHERE s.date = ? ORDER BY s.id`
    )
    .all(date) as any[];
}

function meaningfulSessionReasons(session: any): string[] {
  const reasons: string[] = [];
  if (Number(session?.set_count ?? 0) > 0) reasons.push("logged sets");
  if (Number(session?.skip_count ?? 0) > 0) reasons.push("session skips");
  if (session?.finished_at) reasons.push("finished session");
  if (session?.duration_min != null) reasons.push("recorded duration");
  if (boundedText(session?.notes, 1000)) reasons.push("session notes");
  if (session?.soreness != null || session?.performance != null || boundedText(session?.joint_pain, 300)) {
    reasons.push("session feedback");
  }
  if (boundedText(session?.garmin_json, 12_000)) reasons.push("linked strength activity");
  return reasons;
}

function sportKey(value: unknown): string | null {
  const text = String(value ?? "").toLowerCase();
  if (/\b(run|running|jog|jogging)\b/.test(text)) return "run";
  if (/\b(ride|riding|bike|biking|cycle|cycling)\b/.test(text)) return "ride";
  if (/\b(row|rowing|erg)\b/.test(text)) return "row";
  if (/\b(swim|swimming)\b/.test(text)) return "swim";
  if (/\b(hike|hiking)\b/.test(text)) return "hike";
  if (/\b(walk|walking)\b/.test(text)) return "walk";
  return null;
}

function matchingCardioEvidence(date: string, items: unknown): boolean {
  const cardioItems = (Array.isArray(items) ? items : []).filter((item: any) => item?.kind === "cardio");
  if (!cardioItems.length) return false;
  const activities = db
    .prepare(`SELECT type, raw_text, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id`)
    .all(date) as any[];
  return cardioItems.some((item: any) => {
    const plannedSport = sportKey(item.exercise);
    if (!plannedSport) return false;
    return activities.some((activity) => {
      const actualSport = sportKey(`${activity.type ?? ""} ${activity.raw_text ?? ""}`);
      if (actualSport !== plannedSport) return false;
      const comparisons: boolean[] = [];
      const plannedDuration = finite(item.target_duration_min);
      const actualDuration = finite(activity.duration_min);
      if (plannedDuration && actualDuration)
        comparisons.push(Math.abs(actualDuration - plannedDuration) / plannedDuration <= 0.35);
      const plannedDistance = finite(item.target_distance_km);
      const actualDistance = finite(activity.distance_km);
      if (plannedDistance && actualDistance)
        comparisons.push(Math.abs(actualDistance - plannedDistance) / plannedDistance <= 0.35);
      // Date + sport alone is intentionally insufficient: an unrelated earlier
      // run must not lock a strength/mixed session unless its prescription agrees.
      return comparisons.some(Boolean);
    });
  });
}

function assertSessionsUnstarted(date: string, sessions: any[], compositionItems: unknown): void {
  for (const session of sessions) {
    const reasons = meaningfulSessionReasons(session);
    if (reasons.length) {
      fail(
        "daily_session_locked",
        `daily session cannot be changed because session ${session.id} already has ${reasons.join(", ")}`
      );
    }
  }
  if (matchingCardioEvidence(date, compositionItems)) {
    fail("daily_session_locked", "daily session cannot be changed because its matching cardio work is already logged");
  }
}

function activeCompositionRow(date: string): any {
  return db
    .prepare(
      `SELECT * FROM daily_session_compositions
        WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
    )
    .get(date);
}

function hydrate(row: any) {
  if (!row) return null;
  const { items_json, constraints_json, provenance_json, request_fingerprint: _requestFingerprint, ...rest } = row;
  return {
    ...rest,
    items: parseJson(items_json) ?? [],
    constraints: parseJson(constraints_json),
    provenance: parseJson(provenance_json),
  };
}

export function getActiveDailySession(date?: string) {
  const validDate = validateDate(date);
  return hydrate(
    db
      .prepare(
        `SELECT * FROM daily_session_compositions WHERE date = ? AND status = 'active' ORDER BY version DESC LIMIT 1`
      )
      .get(validDate)
  );
}

export function getActiveDailySessionForSession(sessionId: number) {
  if (!Number.isInteger(Number(sessionId)) || Number(sessionId) <= 0) return null;
  return hydrate(
    db
      .prepare(`SELECT * FROM daily_session_compositions WHERE session_id = ? AND status = 'active' LIMIT 1`)
      .get(Number(sessionId))
  );
}

export function prepareDailySession(input: PrepareDailySessionInput = {}) {
  const date = validateDate(input.date);
  if (input.expected_active_id !== undefined) {
    const expectedId = Number(input.expected_active_id);
    if (!Number.isInteger(expectedId) || expectedId <= 0) {
      fail("daily_session_changed", "expected_active_id must identify the cached active daily session");
    }
    const active = activeCompositionRow(date);
    if (!active) fail("daily_session_missing", "no active daily session exists for the requested date");
    if (Number(active.id) !== expectedId) {
      fail("daily_session_changed", "the active daily session changed after the cached copy was read");
    }
    return { ok: true as const, daily_session: hydrate(active), session_id: active.session_id, reused: true };
  }
  const source = sourceOf(input.source);
  const existingRow = activeCompositionRow(date);
  if (existingRow && !input.replace) {
    return { ok: true as const, daily_session: hydrate(existingRow), session_id: existingRow.session_id, reused: true };
  }

  const isPlan = PLAN_SOURCES.has(source);
  const canonicalAgent = source === "agent_suggest" ? canonicalAgentSuggestion(input.agent_job_id, date) : null;
  const prepared = isPlan
    ? planSnapshot(date, input.day_number)
    : {
        plan_day_id: null,
        payload: normalizeSessionPayload(
          canonicalAgent?.session ?? input.session,
          source === "agent_suggest",
          source === "agent_suggest",
          source === "athlete_override",
          source === "athlete_override",
          canonicalAgent?.normalized === true
        ),
      };
  const constraintsJson = normalizeOptionalJson(canonicalAgent?.constraints ?? input.constraints);
  const provenanceJson = normalizeOptionalJson(canonicalAgent?.provenance ?? input.provenance);
  const fingerprint = requestFingerprint({
    date,
    source,
    plan_day_id: prepared.plan_day_id,
    payload: prepared.payload,
    constraints_json: constraintsJson,
    canonical_agent_job_id: canonicalAgent ? Number(canonicalAgent.provenance.agent_job_id) : null,
  });
  if (existingRow?.request_fingerprint === fingerprint) {
    return { ok: true as const, daily_session: hydrate(existingRow), session_id: existingRow.session_id, reused: true };
  }

  return withSqliteSavepoint("prepare_daily_session", () => {
    const current = activeCompositionRow(date);
    if (current?.request_fingerprint === fingerprint) {
      return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
    }
    if (current && !input.replace) {
      return { ok: true as const, daily_session: hydrate(current), session_id: current.session_id, reused: true };
    }
    const sameDateSessions = sessionRowsForDate(date);
    const lockItems = current ? parseJson(current.items_json) : prepared.payload.items;
    assertSessionsUnstarted(date, sameDateSessions, lockItems);
    let session: any;
    if (current) {
      session = sameDateSessions.find((candidate) => Number(candidate.id) === Number(current.session_id));
      if (!session) fail("daily_session_session_missing", "the active daily session is missing its workout session");
    } else {
      session = sameDateSessions[0] ?? getOrCreateSessionRow(date, null);
    }

    if (current) {
      db.prepare(
        `UPDATE daily_session_compositions
            SET status = 'superseded', superseded_at = datetime('now')
          WHERE id = ? AND status = 'active'`
      ).run(current.id);
    }
    // A plan snapshot binds the existing session to that plan day. A custom
    // suggestion owns no weekly-template provenance, so clear any stale link.
    db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE id = ?`).run(prepared.plan_day_id, session.id);
    const nextVersion = Number(
      (
        db
          .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM daily_session_compositions WHERE date = ?`)
          .get(date) as any
      )?.v ?? 1
    );
    const info = db
      .prepare(
        `INSERT INTO daily_session_compositions
          (version, session_id, date, source, status, plan_day_id, title, focus, why, est_minutes,
           items_json, constraints_json, provenance_json, request_fingerprint)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nextVersion,
        session.id,
        date,
        source,
        prepared.plan_day_id,
        prepared.payload.title,
        prepared.payload.focus,
        prepared.payload.why,
        prepared.payload.est_minutes,
        JSON.stringify(prepared.payload.items),
        constraintsJson,
        provenanceJson,
        fingerprint
      );
    const dailySession = hydrate(
      db.prepare(`SELECT * FROM daily_session_compositions WHERE id = ?`).get(info.lastInsertRowid)
    );
    // Stage 2: persist the deterministic decision metadata that explains a
    // plan-source acceptance (docs §4). Best-effort — a decision-record failure
    // must never fail the accept. Skipped for agent/override sources whose
    // selection the deterministic envelope did not drive.
    if (isPlan) {
      try {
        const { envelope } = decideDailySession(date);
        recordDailySessionDecision(envelope, { composition_id: Number(info.lastInsertRowid) });
      } catch {
        /* observability write never blocks preparation */
      }
    }
    return { ok: true as const, daily_session: dailySession, session_id: session.id, reused: false };
  });
}

export function listDailySessionCompositions() {
  return (db.prepare(`SELECT * FROM daily_session_compositions ORDER BY date DESC, version DESC`).all() as any[]).map(
    hydrate
  );
}
