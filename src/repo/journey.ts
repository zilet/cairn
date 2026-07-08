import { db } from "../db.js";
import {
  computeGoalCheck,
  currentBodyFatEstimate,
  effectiveGoalMode,
  getProfile,
  leannessAwareLossRates,
  leanGainRate,
  projectGoalPace,
} from "./profile.js";
import { localDateISO } from "./shared.js";

export type JourneyPhaseKind = "cut" | "maintenance" | "diet_break" | "reverse" | "gain";
export type JourneyPhaseStatus = "proposed" | "active" | "completed" | "discarded";

export interface JourneyPhaseInput {
  kind: JourneyPhaseKind;
  start_date?: string | null;
  end_date?: string | null;
  start_weight_lb?: number | null;
  target_weight_lb?: number | null;
  start_bodyfat_pct?: number | null;
  target_bodyfat_pct?: number | null;
  planned_rate_lb_wk?: number | null;
  status?: JourneyPhaseStatus;
  reason?: string | null;
  source?: string | null;
}

export interface JourneyTransitionSuggestion {
  kind: JourneyPhaseKind;
  reason: string;
  start_date: string;
  target_weight_lb: number | null;
  target_bodyfat_pct: number | null;
  planned_rate_lb_wk: number | null;
}

const KINDS = new Set<JourneyPhaseKind>(["cut", "maintenance", "diet_break", "reverse", "gain"]);
const STATUSES = new Set<JourneyPhaseStatus>(["proposed", "active", "completed", "discarded"]);

function iso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function num(v: unknown, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) * 10) / 10;
}

function normKind(v: unknown): JourneyPhaseKind {
  const s = String(v || "").trim().toLowerCase();
  if (KINDS.has(s as JourneyPhaseKind)) return s as JourneyPhaseKind;
  throw new Error("journey phase kind must be cut, maintenance, diet_break, reverse, or gain");
}

function normStatus(v: unknown): JourneyPhaseStatus {
  const s = String(v || "proposed").trim().toLowerCase();
  return STATUSES.has(s as JourneyPhaseStatus) ? (s as JourneyPhaseStatus) : "proposed";
}

function hydratePhase(row: any) {
  if (!row) return null;
  return {
    ...row,
    planned_rate_lb_wk: row.planned_rate_lb_wk == null ? null : Number(row.planned_rate_lb_wk),
    start_weight_lb: row.start_weight_lb == null ? null : Number(row.start_weight_lb),
    target_weight_lb: row.target_weight_lb == null ? null : Number(row.target_weight_lb),
    start_bodyfat_pct: row.start_bodyfat_pct == null ? null : Number(row.start_bodyfat_pct),
    target_bodyfat_pct: row.target_bodyfat_pct == null ? null : Number(row.target_bodyfat_pct),
  };
}

export function listJourneyPhases(status?: JourneyPhaseStatus | "all") {
  const s = status && status !== "all" ? normStatus(status) : null;
  const rows = s
    ? db.prepare(`SELECT * FROM journey_phases WHERE status = ? ORDER BY COALESCE(start_date, created_at) DESC, id DESC`).all(s)
    : db.prepare(`SELECT * FROM journey_phases ORDER BY COALESCE(start_date, created_at) DESC, id DESC`).all();
  return (rows as any[]).map(hydratePhase);
}

export function getJourneyPhase(id: number) {
  return hydratePhase(db.prepare(`SELECT * FROM journey_phases WHERE id = ?`).get(id));
}

export function activeJourneyPhase() {
  return hydratePhase(
    db
      .prepare(`SELECT * FROM journey_phases WHERE status = 'active' ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`)
      .get(),
  );
}

export function createJourneyPhase(input: JourneyPhaseInput) {
  const kind = normKind(input.kind);
  const status = normStatus(input.status);
  const bodyFat = currentBodyFatEstimate();
  const profile = getProfile() || {};
  const goal = computeGoalCheck();
  const planned =
    input.planned_rate_lb_wk !== undefined
      ? num(input.planned_rate_lb_wk, -5, 5)
      : kind === "cut"
        ? (goal as any)?.recommended?.weekly_rate_lb ?? null
        : kind === "gain"
          ? leanGainRate(Number(profile.weight_lb) || 0)
          : 0;
  const info = db
    .prepare(
      `INSERT INTO journey_phases
       (kind, start_date, end_date, start_weight_lb, target_weight_lb, start_bodyfat_pct, target_bodyfat_pct, planned_rate_lb_wk, status, reason, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      iso(input.start_date) ?? localDateISO(),
      iso(input.end_date),
      input.start_weight_lb !== undefined ? num(input.start_weight_lb, 50, 700) : num(profile.weight_lb, 50, 700),
      input.target_weight_lb !== undefined ? num(input.target_weight_lb, 50, 700) : num(profile.goal_weight_lb, 50, 700),
      input.start_bodyfat_pct !== undefined ? num(input.start_bodyfat_pct, 3, 70) : (bodyFat?.body_fat_pct ?? null),
      input.target_bodyfat_pct !== undefined ? num(input.target_bodyfat_pct, 3, 70) : num(profile.goal_bodyfat_pct, 3, 70),
      planned,
      status,
      input.reason == null ? null : String(input.reason).trim().slice(0, 400) || null,
      input.source == null ? "manual" : String(input.source).trim().slice(0, 80) || "manual",
    );
  return getJourneyPhase(Number(info.lastInsertRowid));
}

export function activateJourneyPhase(id: number) {
  const row = getJourneyPhase(id);
  if (!row) throw new Error(`No journey phase ${id}`);
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE journey_phases SET status = 'completed', end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE status = 'active' AND id != ?`)
      .run(row.start_date ?? localDateISO(), id);
    db.prepare(`UPDATE journey_phases SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getJourneyPhase(id);
}

export function discardJourneyPhase(id: number) {
  db.prepare(`UPDATE journey_phases SET status = 'discarded', updated_at = datetime('now') WHERE id = ?`).run(id);
  return getJourneyPhase(id);
}

function phaseAgeDays(phase: any, today: string): number | null {
  const start = iso(phase?.start_date);
  if (!start) return null;
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 864e5)) : null;
}

export function journeyTransitionSuggestion(today = localDateISO()): JourneyTransitionSuggestion | null {
  const p = getProfile();
  if (!p) return null;
  const phase = activeJourneyPhase();
  const bodyFat = currentBodyFatEstimate(p);
  const mode = effectiveGoalMode(p);
  const weight = Number(p.weight_lb);
  const goalWeight = Number(p.goal_weight_lb);
  const targetBf = Number(p.goal_bodyfat_pct);

  const reachedWeight = Number.isFinite(weight) && Number.isFinite(goalWeight) && goalWeight > 0 && weight <= goalWeight + 0.5;
  const reachedBf =
    bodyFat?.body_fat_pct != null && Number.isFinite(targetBf) && targetBf > 0 && bodyFat.body_fat_pct <= targetBf + 0.3;
  if ((reachedWeight || reachedBf) && phase?.kind !== "maintenance") {
    return {
      kind: "maintenance",
      reason: "Goal reached — propose a structured maintenance phase so arrival becomes stable, not a rebound.",
      start_date: today,
      target_weight_lb: Number.isFinite(weight) ? Math.round(weight * 10) / 10 : null,
      target_bodyfat_pct: bodyFat?.body_fat_pct ?? (Number.isFinite(targetBf) ? targetBf : null),
      planned_rate_lb_wk: 0,
    };
  }

  if (mode === "lose" && (phase == null || phase.kind === "cut")) {
    const age = phaseAgeDays(phase, today);
    const pace = projectGoalPace(p, Number.isFinite(goalWeight) ? Math.max(0, weight - goalWeight) : 0);
    const stalled = pace.trend_lb_wk != null && pace.trend_lb_wk > -0.1;
    if ((age != null && age >= 56) || (age != null && age >= 21 && stalled)) {
      return {
        kind: "diet_break",
        reason: stalled
          ? "Cut has stalled after several weeks — propose 1-2 weeks at maintenance, then resume."
          : "Cut has run long enough to earn a planned maintenance break before pushing again.",
        start_date: today,
        target_weight_lb: Number.isFinite(weight) ? Math.round(weight * 10) / 10 : null,
        target_bodyfat_pct: bodyFat?.body_fat_pct ?? null,
        planned_rate_lb_wk: 0,
      };
    }
  }

  if (!phase && mode === "lose" && Number.isFinite(weight) && Number.isFinite(goalWeight) && goalWeight < weight) {
    const rate = leannessAwareLossRates(weight, bodyFat?.body_fat_pct ?? null);
    return {
      kind: "cut",
      reason: "A lean-safe cut phase matches the current goal.",
      start_date: today,
      target_weight_lb: goalWeight,
      target_bodyfat_pct: Number.isFinite(targetBf) ? targetBf : null,
      planned_rate_lb_wk: rate.lean_ideal_rate_lb,
    };
  }

  return null;
}

export function journeyRead(today = localDateISO()) {
  const p = getProfile();
  const bodyFat = currentBodyFatEstimate(p);
  const goal = p ? computeGoalCheck(p) : null;
  return {
    profile: p
      ? {
          start_weight_lb: p.start_weight_lb ?? null,
          start_date: p.start_date ?? null,
          goal_weight_lb: p.goal_weight_lb ?? null,
          goal_bodyfat_pct: p.goal_bodyfat_pct ?? null,
          goal_mode: effectiveGoalMode(p),
        }
      : null,
    body_fat: bodyFat,
    active_phase: activeJourneyPhase(),
    proposed_phases: listJourneyPhases("proposed"),
    transition_suggestion: journeyTransitionSuggestion(today),
    leanness_rate: (goal as any)?.leanness_rate ?? null,
  };
}
