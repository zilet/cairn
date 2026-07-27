import { db } from "../db.js";
import {
  activeRecoveryWeekLedger,
  completedRecoveryWeekLedger,
  RECOVERY_WEEK_ACTIVE_DAYS,
} from "./recovery-week-ledger.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";

export const RECOVERY_CYCLE_COOLDOWN_DAYS = 21;
export const RECOVERY_OVERLAY_MAX_BYTES = 1024;
export const RECOVERY_OVERLAY_KEYS = [
  "version",
  "base_plan_day_id",
  "base_day_number",
  "source_proposal_id",
  "source_decision_id",
  "working_set_fraction",
  "effort",
  "preserves_movements",
  "mutates_plan",
] as const;

export type RecoveryCycleStatus = "scheduled" | "active" | "recheck" | "exit_review" | "completed" | "canceled";

export interface RecoveryCycle {
  id: number | null;
  status: RecoveryCycleStatus;
  effective_status: RecoveryCycleStatus;
  effective_on: string;
  recheck_on: string;
  exit_on: string;
  overlay: Record<string, unknown>;
  reason: string | null;
  legacy: boolean;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
}

export interface RecoveryCycleSchedule {
  effective_on: string;
  recheck_on?: string;
  exit_on?: string;
  overlay?: Record<string, unknown>;
  reason?: string | null;
  legacy?: boolean;
}

export interface RecoveryCooldown {
  allowed: boolean;
  reason: "clear" | "cycle_open" | "cooldown";
  until: string | null;
  cycle_id: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function date(value: unknown, field: string): string {
  const result = String(value ?? "").slice(0, 10);
  if (!DATE_RE.test(result) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
  return result;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Invalid historical JSON degrades to an empty overlay.
    }
  }
  return {};
}

function effectiveStatus(
  stored: RecoveryCycleStatus,
  effectiveOn: string,
  recheckOn: string,
  exitOn: string,
  completedAt: string | null,
  canceledAt: string | null,
  on: string
): RecoveryCycleStatus {
  const completedOn = completedAt?.slice(0, 10) ?? null;
  const canceledOn = canceledAt?.slice(0, 10) ?? null;
  if (stored === "canceled" && (!canceledOn || on >= canceledOn)) return "canceled";
  if (stored === "completed" && (!completedOn || on >= completedOn)) return "completed";
  if (on < effectiveOn) return "scheduled";
  if (on >= exitOn) return "exit_review";
  if (on >= recheckOn) return "recheck";
  return "active";
}

function hydrate(row: any, on = localDateISO()): RecoveryCycle | null {
  if (!row) return null;
  const status = String(row.status) as RecoveryCycleStatus;
  return {
    id: Number(row.id),
    status,
    effective_status: effectiveStatus(
      status,
      String(row.effective_on),
      String(row.recheck_on),
      String(row.exit_on),
      row.completed_at == null ? null : String(row.completed_at),
      row.canceled_at == null ? null : String(row.canceled_at),
      on
    ),
    effective_on: String(row.effective_on),
    recheck_on: String(row.recheck_on),
    exit_on: String(row.exit_on),
    overlay: parseObject(row.overlay_json),
    reason: row.reason == null ? null : String(row.reason),
    legacy: Number(row.legacy_flag) === 1,
    created_at: row.created_at == null ? null : String(row.created_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    canceled_at: row.canceled_at == null ? null : String(row.canceled_at),
  };
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer`);
  return number;
}

export function normalizeRecoveryOverlay(value: unknown): Record<string, unknown> {
  if (value == null) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("recovery overlay must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set<string>(RECOVERY_OVERLAY_KEYS);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unsupported recovery overlay field: ${unknown[0]}`);
  if (input.version != null && Number(input.version) !== 1) {
    throw new Error("recovery overlay version must be 1");
  }
  if (input.preserves_movements != null && input.preserves_movements !== true) {
    throw new Error("recovery overlay must preserve movements");
  }
  if (input.mutates_plan != null && input.mutates_plan !== false) {
    throw new Error("recovery overlay cannot mutate the plan");
  }
  const fractionInput = input.working_set_fraction == null ? 0.5 : Number(input.working_set_fraction);
  if (!Number.isFinite(fractionInput)) throw new Error("working_set_fraction must be numeric");
  const effort = input.effort == null ? "easy" : String(input.effort);
  if (effort !== "easy" && effort !== "deload") throw new Error("recovery overlay effort must be easy or deload");
  const normalized: Record<string, unknown> = {
    version: 1,
    base_plan_day_id: optionalPositiveInteger(input.base_plan_day_id, "base_plan_day_id"),
    base_day_number: optionalPositiveInteger(input.base_day_number, "base_day_number"),
    source_proposal_id: optionalPositiveInteger(input.source_proposal_id, "source_proposal_id"),
    source_decision_id: optionalPositiveInteger(input.source_decision_id, "source_decision_id"),
    working_set_fraction: Math.round(Math.min(0.6, Math.max(0.4, fractionInput)) * 100) / 100,
    effort,
    preserves_movements: true,
    mutates_plan: false,
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > RECOVERY_OVERLAY_MAX_BYTES) {
    throw new Error("recovery overlay is too large");
  }
  return normalized;
}

function legacyCycle(on: string): RecoveryCycle | null {
  const active = activeRecoveryWeekLedger(on);
  if (active) {
    const recheckOn = addDaysISO(active.until, -1) ?? active.applied_on;
    return {
      id: null,
      status: "active",
      effective_status: on >= recheckOn ? "recheck" : "active",
      effective_on: active.applied_on,
      recheck_on: recheckOn,
      exit_on: active.until,
      overlay: {
        version: 1,
        legacy_proposal_id: active.proposal_id,
        parsed: active.parsed,
      },
      reason: "Legacy recovery-week prescription",
      legacy: true,
      created_at: active.stamped_at,
      updated_at: active.stamped_at,
      completed_at: null,
      canceled_at: null,
    };
  }
  const completed = completedRecoveryWeekLedger(on);
  if (!completed) return null;
  return {
    id: null,
    status: "completed",
    effective_status: "completed",
    effective_on: completed.applied_on,
    recheck_on: addDaysISO(completed.until, -1) ?? completed.applied_on,
    exit_on: completed.until,
    overlay: {
      version: 1,
      legacy_proposal_id: completed.proposal_id,
      parsed: completed.parsed,
    },
    reason: "Legacy recovery-week prescription",
    legacy: true,
    created_at: completed.stamped_at,
    updated_at: completed.stamped_at,
    completed_at: completed.until,
    canceled_at: null,
  };
}

export function scheduleRecoveryCycle(input: RecoveryCycleSchedule): RecoveryCycle {
  const effectiveOn = date(input.effective_on, "effective_on");
  const exitOn = date(input.exit_on ?? addDaysISO(effectiveOn, RECOVERY_WEEK_ACTIVE_DAYS), "exit_on");
  const recheckOn = date(input.recheck_on ?? addDaysISO(exitOn, -1), "recheck_on");
  if (recheckOn < effectiveOn || exitOn <= recheckOn) {
    throw new Error("recovery cycle dates must satisfy effective_on <= recheck_on < exit_on");
  }
  const cooldown = recoveryCycleCooldown(effectiveOn);
  if (!cooldown.allowed) throw new Error(`recovery cycle blocked: ${cooldown.reason}`);
  const overlay = normalizeRecoveryOverlay(input.overlay);
  const result = db
    .prepare(
      `INSERT INTO recovery_cycles
        (status, effective_on, recheck_on, exit_on, overlay_json, reason, legacy_flag)
       VALUES ('scheduled', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      effectiveOn,
      recheckOn,
      exitOn,
      JSON.stringify(overlay),
      input.reason == null ? null : String(input.reason).trim().slice(0, 500) || null,
      input.legacy ? 1 : 0
    );
  return getRecoveryCycle(Number(result.lastInsertRowid), effectiveOn)!;
}

export function getRecoveryCycle(id: number, on = localDateISO()): RecoveryCycle | null {
  return hydrate(db.prepare(`SELECT * FROM recovery_cycles WHERE id = ?`).get(Number(id)), date(on, "on"));
}

export function listRecoveryCycles(): RecoveryCycle[] {
  const on = localDateISO();
  return (db.prepare(`SELECT * FROM recovery_cycles ORDER BY effective_on DESC, id DESC`).all() as any[])
    .map((row) => hydrate(row, on))
    .filter((cycle): cycle is RecoveryCycle => cycle != null);
}

export function recoveryCycleAt(on = localDateISO()): RecoveryCycle | null {
  const readOn = date(on, "on");
  const row = db
    .prepare(
      `SELECT * FROM recovery_cycles
       WHERE effective_on <= ?
         AND (completed_at IS NULL OR completed_at > ?)
         AND (canceled_at IS NULL OR canceled_at > ?)
       ORDER BY effective_on DESC, id DESC LIMIT 1`
    )
    .get(readOn, readOn, readOn);
  const cycle = hydrate(row, readOn);
  if (cycle) return cycle;
  return legacyCycle(readOn);
}

export function activateRecoveryCycle(id: number, on = localDateISO()): RecoveryCycle | null {
  const activationOn = date(on, "on");
  const existing = getRecoveryCycle(id, activationOn);
  if (!existing || existing.status === "completed" || existing.status === "canceled") return existing;
  if (activationOn < existing.effective_on) throw new Error("cannot activate recovery before effective_on");
  if (activationOn >= existing.exit_on) throw new Error("cannot activate recovery on or after exit_on");
  db.prepare(`UPDATE recovery_cycles SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(Number(id));
  return getRecoveryCycle(id, activationOn);
}

export function markRecoveryCycleRecheck(id: number, on = localDateISO()): RecoveryCycle | null {
  const readOn = date(on, "on");
  const existing = getRecoveryCycle(id, readOn);
  if (!existing || existing.status === "completed" || existing.status === "canceled") return existing;
  if (readOn < existing.recheck_on || readOn >= existing.exit_on) {
    throw new Error("recheck transition must occur within the recheck window");
  }
  db.prepare(`UPDATE recovery_cycles SET status = 'recheck', updated_at = datetime('now') WHERE id = ?`).run(
    Number(id)
  );
  return getRecoveryCycle(id, readOn);
}

export function markRecoveryCycleExitReview(id: number, on = localDateISO()): RecoveryCycle | null {
  const readOn = date(on, "on");
  const existing = getRecoveryCycle(id, readOn);
  if (!existing || existing.status === "completed" || existing.status === "canceled") return existing;
  if (readOn < existing.exit_on) throw new Error("exit review cannot begin before exit_on");
  db.prepare(`UPDATE recovery_cycles SET status = 'exit_review', updated_at = datetime('now') WHERE id = ?`).run(
    Number(id)
  );
  return getRecoveryCycle(id, readOn);
}

export function completeRecoveryCycle(id: number, on = localDateISO()): RecoveryCycle | null {
  const completedOn = date(on, "on");
  const existing = getRecoveryCycle(id, completedOn);
  if (!existing || existing.status === "completed" || existing.status === "canceled") return existing;
  if (completedOn < existing.exit_on) throw new Error("recovery cycle cannot complete before exit_on");
  db.prepare(
    `UPDATE recovery_cycles
       SET status = 'completed', completed_at = ?, updated_at = datetime('now')
     WHERE id = ? AND status != 'canceled'`
  ).run(completedOn, Number(id));
  return getRecoveryCycle(id, completedOn);
}

export function cancelRecoveryCycle(id: number, on = localDateISO()): RecoveryCycle | null {
  const canceledOn = date(on, "on");
  const existing = getRecoveryCycle(id, canceledOn);
  if (!existing || existing.status === "completed" || existing.status === "canceled") return existing;
  db.prepare(
    `UPDATE recovery_cycles
       SET status = 'canceled', canceled_at = ?, updated_at = datetime('now')
     WHERE id = ? AND status != 'completed'`
  ).run(canceledOn, Number(id));
  return getRecoveryCycle(id, canceledOn);
}

export function cancelRecoveryCycleForProposal(proposalId: number, on = localDateISO()): RecoveryCycle | null {
  const owner = optionalPositiveInteger(proposalId, "proposal_id");
  if (owner == null) return null;
  const row = db
    .prepare(
      `SELECT id FROM recovery_cycles
       WHERE status NOT IN ('completed','canceled')
         AND json_extract(overlay_json, '$.source_proposal_id') = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(owner) as any;
  return row?.id != null ? cancelRecoveryCycle(Number(row.id), on) : null;
}

export function recoveryCycleCooldown(
  on = localDateISO(),
  cooldownDays = RECOVERY_CYCLE_COOLDOWN_DAYS
): RecoveryCooldown {
  const readOn = date(on, "on");
  const open = db
    .prepare(
      `SELECT * FROM recovery_cycles
       WHERE status NOT IN ('completed','canceled') AND exit_on > ?
       ORDER BY effective_on DESC, id DESC LIMIT 1`
    )
    .get(readOn) as any;
  if (open) {
    return { allowed: false, reason: "cycle_open", until: String(open.exit_on), cycle_id: Number(open.id) };
  }
  const latest = db
    .prepare(
      `SELECT * FROM recovery_cycles
       WHERE status != 'canceled' AND exit_on <= ?
       ORDER BY exit_on DESC, id DESC LIMIT 1`
    )
    .get(readOn) as any;
  if (latest) {
    const until = addDaysISO(String(latest.exit_on), Math.max(0, Math.floor(cooldownDays)));
    if (until && readOn < until) {
      return { allowed: false, reason: "cooldown", until, cycle_id: Number(latest.id) };
    }
  }
  const legacy = legacyCycle(readOn);
  if (legacy && legacy.effective_status !== "completed") {
    return { allowed: false, reason: "cycle_open", until: legacy.exit_on, cycle_id: null };
  }
  if (legacy?.effective_status === "completed") {
    const elapsed = daysBetweenISO(readOn, legacy.exit_on);
    if (elapsed != null && elapsed < cooldownDays) {
      return {
        allowed: false,
        reason: "cooldown",
        until: addDaysISO(legacy.exit_on, cooldownDays),
        cycle_id: null,
      };
    }
  }
  return { allowed: true, reason: "clear", until: null, cycle_id: null };
}

function reducedSets(value: unknown, fraction: number): number {
  const sets = Number(value);
  return Math.max(1, Math.round((Number.isFinite(sets) && sets > 0 ? sets : 1) * fraction));
}

function reducedPositive(value: unknown, fraction: number): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number <= 0) return number;
  return Math.max(1, Math.round(number * fraction));
}

function recoveryLoad(value: unknown): number | null {
  if (value == null || value === "") return null;
  const load = Number(value);
  if (!Number.isFinite(load)) return null;
  if (load > 0) return Math.max(0.5, Math.round(load * 0.85 * 2) / 2);
  if (load < 0) return Math.round(load * 1.1 * 2) / 2;
  return 0;
}

// Build a temporary prescription from a base plan-day snapshot. The input is
// never mutated and the result retains every original movement in the same order.
// Only dose/effort fields are reduced; no plan row is written.
export function adaptBasePlanDayForRecovery<T extends Record<string, any>>(
  baseDay: T,
  overlayInput: unknown = {}
): T & {
  recovery_overlay: Record<string, unknown>;
} {
  const overlay = normalizeRecoveryOverlay(overlayInput);
  const workingSetFraction = Number(overlay.working_set_fraction);
  const sourceItems = Array.isArray(baseDay?.items) ? baseDay.items : [];
  const items = sourceItems.map((raw: any) => {
    const item = { ...raw };
    if (item.kind === "cardio") {
      item.target_duration_min = reducedPositive(item.target_duration_min, workingSetFraction);
      item.target_distance_km = reducedPositive(item.target_distance_km, workingSetFraction);
      item.target_zone = "easy";
    } else {
      item.sets = reducedSets(item.sets, workingSetFraction);
      if (item.mode === "timed" || item.target_seconds != null) {
        item.target_seconds = reducedPositive(item.target_seconds, workingSetFraction);
      }
      // A one-set prescription cannot reduce volume further, so known positive
      // load eases by 15%. Negative assisted encoding becomes more assisted,
      // never harder; bodyweight/null remains athlete-selected.
      item.target_weight = recoveryLoad(item.target_weight);
    }
    item.effort = "easy";
    item.recovery_overlay = true;
    item.note = [item.note, "Recovery overlay: easy effort; stop well before strain"]
      .filter(Boolean)
      .join(". ")
      .slice(0, 500);
    return item;
  });
  return {
    ...baseDay,
    items,
    recovery_overlay: {
      version: 1,
      base_plan_day_id: baseDay?.id ?? null,
      base_day_number: baseDay?.day_number ?? null,
      working_set_fraction: workingSetFraction,
      effort: "easy",
      preserves_movements: true,
      mutates_plan: false,
    },
  };
}
