import { db } from "../db.js";
import {
  activeRecoveryWeekLedger,
  completedRecoveryWeekLedger,
  RECOVERY_WEEK_ACTIVE_DAYS,
} from "./recovery-week-ledger.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { easedLoad } from "./load-grid.js";
import { afterSqliteCommit } from "./sqlite-savepoint.js";
import { bumpTrainingDataVersion } from "./training-cache.js";

// A cycle opening, starting, ending or being undone changes what the program read says
// (the mesocycle reads a running recovery week as `deload`), so every write moves the
// training-data version the memoized reads key on.
function cycleWritten(): void {
  afterSqliteCommit(bumpTrainingDataVersion);
}

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
  "arm",
] as const;

// The recovery week as a DOSE: about half the working sets for a week, intensity kept
// largely intact. A deload that cuts volume roughly in half while holding the load near
// where it was keeps the strength the block built (the taper/deload literature); in a
// calorie deficit intensity is also what tells the body to keep its muscle, so the load
// eases by a tenth, not more. Every recovery week reads these numbers — the
// server-authored one, the fuel package's and an older agent-written one alike.
export const RECOVERY_WORKING_SET_FRACTION = 0.5;
export const RECOVERY_INTENSITY_FACTOR = 0.9;
// Assisted work takes a tenth more assistance — the same tenth, in the easier direction.
export const RECOVERY_ASSIST_FACTOR = 1.1;

// Why the overlay exists. `scheduled` is the block's own deload week made lighter, so the
// block keeps its calendar through it (program-blocks.ts advanceBlockWeek); every other
// arm is a week inserted into the block, which pauses while it runs.
export const RECOVERY_OVERLAY_ARMS = ["streak", "fatigue", "scheduled", "asked"] as const;
export type RecoveryOverlayArm = (typeof RECOVERY_OVERLAY_ARMS)[number];

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
  const fractionInput =
    input.working_set_fraction == null ? RECOVERY_WORKING_SET_FRACTION : Number(input.working_set_fraction);
  if (!Number.isFinite(fractionInput)) throw new Error("working_set_fraction must be numeric");
  const effort = input.effort == null ? "easy" : String(input.effort);
  if (effort !== "easy" && effort !== "deload") throw new Error("recovery overlay effort must be easy or deload");
  const arm = input.arm == null ? null : String(input.arm);
  if (arm != null && !(RECOVERY_OVERLAY_ARMS as readonly string[]).includes(arm))
    throw new Error("recovery overlay arm is not recognized");
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
    // Omitted when absent, so an overlay written before arms existed reads the same.
    ...(arm ? { arm } : {}),
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
  cycleWritten();
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
  cycleWritten();
  return getRecoveryCycle(id, activationOn);
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
  cycleWritten();
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
  cycleWritten();
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

/**
 * The latest recovery OVERLAY week that finished on or before `on` (not canceled): its
 * calendar exit has passed, whether or not anything has marked it completed yet. The
 * program read (program-state.ts mesocycle) counts it as the reset exactly as it counts
 * the legacy ledger's completed week, so the loaded-weeks streak restarts after it however
 * heavy the lighter week turned out. Null when none; a read problem is "none".
 */
export function completedRecoveryCycleBefore(
  on = localDateISO()
): { effective_on: string; exit_on: string; days_since_completion: number; weeks_since_completion: number; source_proposal_id: number | null } | null {
  try {
    const readOn = date(on, "on");
    const row = db
      .prepare(
        `SELECT * FROM recovery_cycles
          WHERE legacy_flag = 0 AND exit_on <= ? AND status != 'canceled'
          ORDER BY exit_on DESC, id DESC LIMIT 1`
      )
      .get(readOn) as any;
    if (!row) return null;
    const daysSince = daysBetweenISO(readOn, String(row.exit_on));
    if (daysSince == null || daysSince < 0) return null;
    const source = Number(parseObject(row.overlay_json).source_proposal_id);
    return {
      effective_on: String(row.effective_on),
      exit_on: String(row.exit_on),
      days_since_completion: daysSince,
      weeks_since_completion: Math.floor(daysSince / 7),
      source_proposal_id: Number.isInteger(source) && source > 0 ? source : null,
    };
  } catch {
    return null;
  }
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

// Known positive load eases by a tenth and assisted load takes a tenth more assistance,
// both onto the lift's own load grid (load-grid.ts) — a 225 squat reads 200, never 202.5.
function recoveryLoad(value: unknown, item: { exercise?: unknown; muscle_group?: unknown }): number | null {
  if (value == null || value === "") return null;
  const load = Number(value);
  if (!Number.isFinite(load)) return null;
  const group = item.muscle_group == null ? null : String(item.muscle_group);
  return easedLoad(load, RECOVERY_INTENSITY_FACTOR, item.exercise, group, { assistFactor: RECOVERY_ASSIST_FACTOR });
}

// A timed hold's seconds are its intensity, the way a load is a lift's: the set count
// carries the volume cut, and the hold eases by the same tenth (a short hold keeps its length
// down to ten seconds, never less).
function recoverySeconds(value: unknown): number | null {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  if (seconds <= 0) return seconds;
  return Math.max(Math.min(seconds, 10), Math.round(seconds * RECOVERY_INTENSITY_FACTOR));
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
        item.target_seconds = recoverySeconds(item.target_seconds);
      }
      // Volume comes off the set count; intensity eases by a tenth, so even a one-set
      // prescription that cannot lose a set is lighter. Negative assisted encoding
      // becomes more assisted, never harder; bodyweight/null remains athlete-selected.
      item.target_weight = recoveryLoad(item.target_weight, item);
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
      ...(overlay.arm ? { arm: overlay.arm } : {}),
    },
  };
}
