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
import { activeRecoveryWeek, getEnduranceGoal } from "./profile.js";
import { recoveryCycleAt } from "./recovery-cycles.js";
import { recordTestWeek } from "./muscle-trajectory.js";
import { bumpTrainingDataVersion } from "./training-cache.js";
import { recordDecision } from "./brain-decisions.js";
import { buildAerobicTrendExpectation } from "./brain/change-expectations.js";
import { localDateISO } from "./shared.js";

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

function clampWeekIndex(v: unknown, totalWeeks?: number): number {
  const n = Number(v);
  const wk = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  // Don't let a block start already past its last week (it'd auto-complete on the
  // first advance). Cap at total_weeks when known.
  return totalWeeks && Number.isFinite(totalWeeks) ? Math.min(wk, totalWeeks) : wk;
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
 *  - Last week of a PEAK block → realization (peak / express the block's work — a
 *    natural test week; this is the ONLY path that yields 'realization')
 *  - Last week of any other multi-week block → deload (earned recovery)
 *  - First half-ish → accumulation (build volume)
 *  - Second half-ish → intensification (push intensity)
 *  - Single-week blocks → accumulation
 *
 * This drives the auto-complete path in advanceBlockWeek AND the default phase of a
 * freshly-created block. A user-created block can still set any phase, overriding it.
 */
function derivePhase(weekIndex: number, totalWeeks: number, focus?: Focus): Phase {
  if (totalWeeks <= 1) return "accumulation";
  // A peaking block's last week is REALIZATION (test/express what the block built),
  // not a deload — this is what makes testWeekDue's realization branch reachable.
  if (weekIndex >= totalWeeks) return focus === "peak" ? "realization" : "deload";
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
  const week_index = clampWeekIndex(input.week_index, total_weeks);
  const phase = clampEnum(input.phase, VALID_PHASE, derivePhase(week_index, total_weeks, focus));
  const started_at = typeof input.started_at === "string" && input.started_at
    ? input.started_at
    : new Date().toISOString();

  // Supersede any active block — only one runs at a time.
  db.prepare("UPDATE program_blocks SET status = 'completed' WHERE status = 'active'").run();

  const res = db.prepare(`
    INSERT INTO program_blocks (goal, focus, phase, week_index, total_weeks, started_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(goal, focus, phase, week_index, total_weeks, started_at);

  bumpTrainingDataVersion(); // the active periodization block is part of the training picture
  const block = hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(res.lastInsertRowid)
  )!;
  recordBlockDecision(block);
  return block;
}

/**
 * Record the ledger decision for a newly structured block, and hang the LONG-HORIZON
 * aerobic expectation off it.
 *
 * Why here and nowhere else. `vo2max_trend` needs a window measured in months — its
 * evaluator refuses to read a slope off fewer than 4 readings spanning 21 days — and
 * every other decision that could host one is remade too often. A weekly run-plan apply
 * would either write overlapping windows that confound each other into silence, or
 * attribute two months of aerobic drift to one week's prescription. A block is the only
 * training structure in the app with a declared multi-week lifetime, and it is created
 * rarely: by hand, or once by ensureActiveBlock when none is running.
 *
 * The decision itself claims nothing beyond what happened — a block was structured,
 * which is true, dated and reversible only by the athlete abandoning it. The expectation
 * is attached ONLY when buildAerobicTrendExpectation permits it (the watch is actually
 * reporting VO2max, and no aerobic window is already standing), so a second block
 * started mid-window records the structural fact without opening a duplicate window.
 * A 56-day window can outlive a short block; nothing transitions this decision when the
 * block completes, so the expectation still matures honestly.
 *
 * FAIL-SOFT: the block row is already committed by the time this runs, and periodization
 * must not fail because the ledger is unavailable. Recording is audit, not the mutation.
 */
function recordBlockDecision(block: ProgramBlock): void {
  try {
    const startedOn = localDateISO(new Date(block.started_at)) || localDateISO();
    const aerobic = buildAerobicTrendExpectation(startedOn);
    recordDecision(
      {
        effective_date: startedOn,
        kind: "training_structure",
        domain: "training",
        summary: `A ${block.total_weeks}-week ${block.focus} block is running.`,
        rationale: aerobic
          ? "A block is long enough to ask whether aerobic fitness holds across it — the shortest horizon that read is honest over."
          : "Recorded so the block's shape is part of the training history.",
        source: "program_block",
        // BRAIN_SOURCE_REF_TYPES has no block member, and a ref key without a ref type
        // is rejected, so the block id travels in `action` instead — where it also
        // keeps each block's decision fingerprint distinct.
        source_ref_type: null,
        source_ref_key: null,
        status: "applied",
        // Cairn recorded this; it did not decide it. The block comes from the athlete
        // or from ensureActiveBlock's default, so claiming any acting tier here would
        // overstate what the system did.
        autonomy_tier: "observe",
        risk_class: "low",
        // No rollback snapshot: a block is ended by abandoning it, not by a
        // server-owned Undo, and only decisions with a real reversal path claim one.
        reversible: false,
        input_fingerprint: null,
        context: {
          block_id: block.id,
          focus: block.focus,
          phase: block.phase,
          week_index: block.week_index,
          total_weeks: block.total_weeks,
        },
        action: { block_id: block.id, focus: block.focus, total_weeks: block.total_weeks },
        specialist: null,
        applied_at: new Date().toISOString(),
        reverted_at: null,
        superseded_by: null,
        evaluator_version: aerobic?.evaluator_version ?? null,
      },
      aerobic ? [aerobic] : []
    );
  } catch {
    // The block is authoritative; its audit trail is best effort.
  }
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
 * Ensure ONE active periodization block exists, auto-creating a sensible default
 * aligned to the athlete's endurance goal when none is running. IDEMPOTENT —
 * returns the existing active block untouched if there is one (it never resets a
 * block the athlete is mid-way through). Does NOT auto-advance weeks (that stays
 * manual / the scheduler's job).
 *
 * The default is STRENGTH-FIRST today (the athlete's primary discipline), but it
 * biases the focus + length toward an approaching race so the program periodizes
 * sensibly without the athlete having to set up a block by hand:
 *  - a race in the BUILD window (~5–10 wk out) → an "endurance-base" block sized
 *    to the time-to-race so lifting stays supportive of the running build;
 *  - a race in the SHARPEN/TAPER window (≤4 wk) → a short "peak" block;
 *  - otherwise (no race, or far out) → a strength accumulation block.
 *
 * Constitution: a suggestion the athlete drives — they can edit/abandon it any
 * time. No scores; the block is plain descriptive periodization.
 */
export function ensureActiveBlock(): ProgramBlock {
  const existing = getActiveBlock();
  if (existing) return existing;

  const goal = getEnduranceGoal();
  let focus: Focus = "strength";
  let total_weeks = 6;
  let blockGoal = "Strength base — build the main lifts";

  if (goal?.is_race) {
    const phase = goal.phase ?? null;
    const wk = goal.weeks_to_race ?? null;
    const event = goal.event ? String(goal.event).slice(0, 80) : "your race";
    if (phase === "taper" || phase === "sharpen" || (wk != null && wk <= 4)) {
      // Close to the race — a short peaking block; keep lifting minimal/supportive.
      focus = "peak";
      total_weeks = wk != null && wk > 0 ? Math.min(4, Math.max(2, wk)) : 3;
      blockGoal = `Sharpen for ${event} — arrive fresh`;
    } else if (phase === "build" || (wk != null && wk <= 10)) {
      // In the build — center the aerobic base; strength is supportive/durability.
      focus = "endurance-base";
      total_weeks = wk != null && wk > 0 ? Math.min(8, Math.max(4, wk - 2)) : 6;
      blockGoal = `Build toward ${event} — aerobic base + supportive strength`;
    } else if (String(goal.target ?? "").trim() && wk != null && wk <= 16) {
      // A TIME on the race changes what "far out" means. Sixteen weeks is where a
      // half or a marathon build actually starts, and defaulting an athlete with a
      // time to chase into an off-season strength block spent the runway they needed
      // on the wrong stimulus. Still supportive strength — the block's focus is where
      // the aerobic work sits, not a claim that lifting stops.
      focus = "endurance-base";
      total_weeks = Math.min(8, Math.max(4, wk - 2));
      blockGoal = `Build toward ${event} — aerobic base + supportive strength`;
    } else {
      // Race exists but far out (base phase) — strength-first, build durability.
      focus = "strength";
      total_weeks = 6;
      blockGoal = `Off-season strength — base for ${event}`;
    }
  } else if (goal && !goal.is_race) {
    // A standing endurance goal (no date) — strength-first, with running kept as a
    // steady supportive base; no peak to chase.
    focus = "strength";
    total_weeks = 6;
    blockGoal = "Strength base — steady running on the side";
  }

  // createBlock supersedes any active block (there's none here) and derives the
  // phase from week 1. Always returns the row.
  return createBlock({ goal: blockGoal, focus, total_weeks, week_index: 1 });
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
    ? clampWeekIndex(fields.week_index, total_weeks)
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

  bumpTrainingDataVersion();
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
  const recovery = recoveryCycleAt();
  if (recovery && (recovery.effective_status === "active" || recovery.effective_status === "recheck")) {
    // The structural block stays put while a temporary overlay is active. No
    // training log is required to end the overlay; its calendar exit remains
    // authoritative, so this pause cannot become an inactivity feedback loop.
    return block;
  }

  const next_week = block.week_index + 1;
  const auto_phase = derivePhase(next_week, block.total_weeks, block.focus);
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
  bumpTrainingDataVersion();

  // Auto-completing a PEAK block lands it in the realization phase — the test week
  // the block was built toward. Close the cadence loop on that completion (the
  // stamp is monotonic, so it's a no-op if a later test week is already recorded).
  if (is_complete && auto_phase === "realization") recordTestWeek();

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
  bumpTrainingDataVersion();
  const block = hydrateBlock(
    db.prepare("SELECT * FROM program_blocks WHERE id = ?").get(id)
  );
  // A block finished in its realization phase IS a test week — that phase's whole
  // point is expressing/peaking the block's work on the main lifts. Close the
  // cadence loop (monotonic; a no-op if a later test week is already stamped). A
  // block completed early, before realization, did no test work → no stamp.
  if (block?.phase === "realization") recordTestWeek();
  return block;
}

/**
 * Mark a block abandoned (the athlete is pivoting before finishing).
 */
export function abandonBlock(id: number): ProgramBlock | null {
  db.prepare(
    "UPDATE program_blocks SET status = 'abandoned' WHERE id = ?"
  ).run(id);
  bumpTrainingDataVersion();
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
export function blockForCoach(date?: string): BlockCoachSummary | null {
  const block = getActiveBlock();
  if (!block) return null;
  const recoveryWeek = activeRecoveryWeek(date);
  return {
    goal: block.goal,
    focus: block.focus,
    // The stored block remains the long-running structural program. During an
    // applied recovery window, its effective coaching phase is deload so prompts
    // never receive "accumulation/build volume" beside "recovery week active".
    phase: recoveryWeek ? "deload" : block.phase,
    week_of: `week ${block.week_index} of ${block.total_weeks}`,
  };
}
