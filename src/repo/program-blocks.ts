/**
 * program-blocks.ts — periodization / training-block model
 *
 * A lightweight mesocycle abstraction so progression can be structured
 * (accumulation → intensification → deload) rather than random. One block
 * is active at a time; it carries a goal, a phase, and a week counter.
 *
 * Constitution invariants:
 *  - NO 0-100 scores
 *  - All returned shapes are suggestions, never gates
 *  - blockForCoach() is plain language, never a metric wall
 */

import { db } from "../db.js";

// ---- allowed enum values ----
const VALID_FOCUS = ["strength", "hypertrophy", "endurance-base", "peak"] as const;
const VALID_PHASE = ["accumulation", "intensification", "deload", "realization"] as const;
const VALID_STATUS = ["active", "completed", "abandoned"] as const;

type Focus = (typeof VALID_FOCUS)[number];
type Phase = (typeof VALID_PHASE)[number];
type Status = (typeof VALID_STATUS)[number];

// ---- public types ----
export interface ProgramBlock {
  id: number;
  goal: string;
  focus: Focus;
  phase: Phase;
  week_index: number;   // 1-based current week within the block
  total_weeks: number;  // 2–12
  started_at: string;   // UTC ISO string
  status: Status;
  created_at: string;
}

export interface BlockCoachSummary {
  goal: string;
  focus: Focus;
  phase: Phase;
  week_of: string;      // e.g. "week 3 of 5"
}

export interface CreateBlockInput {
  goal?: string;
  focus?: string;
  phase?: string;
  week_index?: number;
  total_weeks?: number;
  started_at?: string;
}

export interface UpdateBlockInput {
  goal?: string;
  focus?: string;
  phase?: string;
  week_index?: number;
  total_weeks?: number;
  started_at?: string;
  status?: string;
}

// ---- validation helpers ----
function clampStr(v: unknown, max: number, fallback: string): string {
  if (typeof v !== "string" || !v.trim()) return fallback;
  return v.trim().slice(0, max);
}

function clampEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v))
    return v as T;
  return fallback;
}

function clampWeekIndex(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

function clampTotalWeeks(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(12, Math.max(2, Math.floor(n))) : 6;
}

function hydrateBlock(row: any): ProgramBlock | null {
  if (!row) return null;
  return {
    id: row.id,
    goal: row.goal ?? "",
    focus: row.focus as Focus,
    phase: row.phase as Phase,
    week_index: Number(row.week_index),
    total_weeks: Number(row.total_weeks),
    started_at: row.started_at,
    status: row.status as Status,
    created_at: row.created_at,
  };
}

/**
 * Determine the phase for a given week within a block.
 *
 * Deterministic schedule (always a suggestion, never a gate):
 *  - Last week of a multi-week block → deload (earned recovery)
 *  - First half-ish → accumulation (build volume)
 *  - Second half-ish → intensification (push intensity)
 *  - Single-week blocks → accumulation
 *
 * This ONLY drives the auto-complete path in advanceBlockWeek. A user-created
 * block can have any phase they set, overriding this default.
 */
function derivePhase(weekIndex: number, totalWeeks: number): Phase {
  if (totalWeeks <= 1) return "accumulation";
  if (weekIndex >= totalWeeks) return "deload";
  if (weekIndex > Math.ceil(totalWeeks / 2)) return "intensification";
  return "accumulation";
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create a new training block. AT MOST ONE block is active at a time — starting a
 * new one supersedes any currently-active block (marked 'completed', mirroring how
 * accepting a meal plan retires the open draft), so getActiveBlock()/blockForCoach()
 * are never ambiguous. To pause without starting a replacement, complete/abandon
 * the active block directly.
 */
export function createBlock(input: CreateBlockInput = {}): ProgramBlock {
  const goal = clampStr(input.goal, 200, "Training block");
  const focus = clampEnum(input.focus, VALID_FOCUS, "strength");
  const total_weeks = clampTotalWeeks(input.total_weeks);
  const week_index = clampWeekIndex(input.week_index);
  const phase = clampEnum(input.phase, VALID_PHASE, derivePhase(week_index, total_weeks));
  const started_at = typeof input.started_at === "string" && input.started_at
    ? input.started_at
    : new Date().toISOString();

  // Supersede any active block — only one runs at a time.
  db.prepare("UPDATE program_blocks SET status = 'completed' WHERE status = 'active'").run();

  const res = db.prepare(`
    INSERT INTO program_blocks (goal, focus, phase, week_index, total_weeks, started_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(goal, focus, phase, week_index, total_weeks, started_at);

  return hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(res.lastInsertRowid)
  )!;
}

/**
 * Return the single active block, or null when no block is in progress.
 */
export function getActiveBlock(): ProgramBlock | null {
  return hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE status = 'active' ORDER BY id DESC LIMIT 1").get()
  );
}

/**
 * List blocks, newest first.
 */
export function listBlocks(limit = 20): ProgramBlock[] {
  const rows = db.prepare(
    "SELECT * FROM program_blocks ORDER BY id DESC LIMIT ?"
  ).all(Math.min(100, Math.max(1, limit))) as any[];
  return rows.map(hydrateBlock).filter(Boolean) as ProgramBlock[];
}

/**
 * Update mutable fields on a block. Only the fields present in `fields`
 * are changed; others are left intact.
 *
 * Returns null when the block id is not found.
 */
export function updateBlock(id: number, fields: UpdateBlockInput): ProgramBlock | null {
  const existing = hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(id)
  );
  if (!existing) return null;

  const goal = "goal" in fields ? clampStr(fields.goal, 200, existing.goal) : existing.goal;
  const focus = "focus" in fields
    ? clampEnum(fields.focus, VALID_FOCUS, existing.focus)
    : existing.focus;
  const total_weeks = "total_weeks" in fields
    ? clampTotalWeeks(fields.total_weeks)
    : existing.total_weeks;
  const week_index = "week_index" in fields
    ? clampWeekIndex(fields.week_index)
    : existing.week_index;
  const phase = "phase" in fields
    ? clampEnum(fields.phase, VALID_PHASE, existing.phase)
    : existing.phase;
  const status = "status" in fields
    ? clampEnum(fields.status, VALID_STATUS, existing.status)
    : existing.status;
  const started_at = typeof fields.started_at === "string" && fields.started_at
    ? fields.started_at
    : existing.started_at;

  db.prepare(`
    UPDATE program_blocks
    SET goal = ?, focus = ?, phase = ?, week_index = ?, total_weeks = ?,
        started_at = ?, status = ?
    WHERE id = ?
  `).run(goal, focus, phase, week_index, total_weeks, started_at, status, id);

  return hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(id)
  );
}

/**
 * Advance the current week by 1. Auto-transitions:
 *  - Updates `phase` according to the deterministic schedule (unless the new
 *    week is already at the phase the schedule prescribes — no unnecessary churn).
 *  - When week_index exceeds total_weeks, flips status → 'completed' and leaves
 *    week_index at total_weeks + 1 as a record of the overshoot.
 *
 * Pass `id` to target a specific block; omit to advance the active block.
 * Returns null when the target block is not found.
 */
export function advanceBlockWeek(id?: number): ProgramBlock | null {
  const block = id !== undefined
    ? hydrateBlock(db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(id))
    : getActiveBlock();

  if (!block) return null;
  if (block.status !== "active") return block; // nothing to advance

  const next_week = block.week_index + 1;
  const auto_phase = derivePhase(next_week, block.total_weeks);
  const is_complete = next_week > block.total_weeks;

  db.prepare(`
    UPDATE program_blocks
    SET week_index = ?, phase = ?, status = ?
    WHERE id = ?
  `).run(
    next_week,
    auto_phase,
    is_complete ? "completed" : "active",
    block.id,
  );

  return hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(block.id)
  );
}

/**
 * Mark a block completed (the athlete finished the planned weeks).
 */
export function completeBlock(id: number): ProgramBlock | null {
  db.prepare(
    "UPDATE program_blocks SET status = 'completed' WHERE id = ?"
  ).run(id);
  return hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(id)
  );
}

/**
 * Mark a block abandoned (the athlete is pivoting before finishing).
 */
export function abandonBlock(id: number): ProgramBlock | null {
  db.prepare(
    "UPDATE program_blocks SET status = 'abandoned' WHERE id = ?"
  ).run(id);
  return hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(id)
  );
}

/**
 * Return a compact plain-language summary for coaching prompts, or null
 * when no block is active. No scores, no grades — purely descriptive.
 *
 * Example: { goal: "Build squat + base", focus: "strength",
 *             phase: "accumulation", week_of: "week 2 of 5" }
 */
export function blockForCoach(): BlockCoachSummary | null {
  const block = getActiveBlock();
  if (!block) return null;
  return {
    goal: block.goal,
    focus: block.focus,
    phase: block.phase,
    week_of: `week ${block.week_index} of ${block.total_weeks}`,
  };
}
