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
import { mayProposeEaseFromCut } from "./cut-target.js";
import { recompositionRead } from "./recomposition.js";
import type { ExpenditureEstimate } from "./expenditure.js";
import type { ProgramState } from "./program-state.js";
import type { WholePersonTrajectory } from "./whole-person-trajectory.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";

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

export type JourneyMilestoneKind = "weight_loss" | "goal_progress" | "goal_reached" | "bodyfat_band" | "bodyfat_goal";

export interface JourneyMilestone {
  id: string;
  kind: JourneyMilestoneKind;
  label: string;
  detail: string | null;
  achieved_date: string | null;
  achieved_at: string | null;
  value: number | null;
  priority: number;
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
  const s = String(v || "")
    .trim()
    .toLowerCase();
  if (KINDS.has(s as JourneyPhaseKind)) return s as JourneyPhaseKind;
  throw new Error("journey phase kind must be cut, maintenance, diet_break, reverse, or gain");
}

function normStatus(v: unknown): JourneyPhaseStatus {
  const s = String(v || "proposed")
    .trim()
    .toLowerCase();
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
    ? db
        .prepare(
          `SELECT * FROM journey_phases WHERE status = ? ORDER BY COALESCE(start_date, created_at) DESC, id DESC`
        )
        .all(s)
    : db.prepare(`SELECT * FROM journey_phases ORDER BY COALESCE(start_date, created_at) DESC, id DESC`).all();
  return (rows as any[]).map(hydratePhase);
}

export function getJourneyPhase(id: number) {
  return hydratePhase(db.prepare(`SELECT * FROM journey_phases WHERE id = ?`).get(id));
}

export function activeJourneyPhase() {
  return hydratePhase(
    db
      .prepare(
        `SELECT * FROM journey_phases WHERE status = 'active' ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`
      )
      .get()
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
        ? ((goal as any)?.recommended?.weekly_rate_lb ?? null)
        : kind === "gain"
          ? leanGainRate(Number(profile.weight_lb) || 0)
          : 0;
  const info = db
    .prepare(
      `INSERT INTO journey_phases
       (kind, start_date, end_date, start_weight_lb, target_weight_lb, start_bodyfat_pct, target_bodyfat_pct, planned_rate_lb_wk, status, reason, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      iso(input.start_date) ?? localDateISO(),
      iso(input.end_date),
      input.start_weight_lb !== undefined ? num(input.start_weight_lb, 50, 700) : num(profile.weight_lb, 50, 700),
      input.target_weight_lb !== undefined
        ? num(input.target_weight_lb, 50, 700)
        : num(profile.goal_weight_lb, 50, 700),
      input.start_bodyfat_pct !== undefined ? num(input.start_bodyfat_pct, 3, 70) : (bodyFat?.body_fat_pct ?? null),
      input.target_bodyfat_pct !== undefined
        ? num(input.target_bodyfat_pct, 3, 70)
        : num(profile.goal_bodyfat_pct, 3, 70),
      planned,
      status,
      input.reason == null ? null : String(input.reason).trim().slice(0, 400) || null,
      input.source == null ? "manual" : String(input.source).trim().slice(0, 80) || "manual"
    );
  return getJourneyPhase(Number(info.lastInsertRowid));
}

export function activateJourneyPhase(id: number) {
  const row = getJourneyPhase(id);
  if (!row) throw new Error(`No journey phase ${id}`);
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE journey_phases SET status = 'completed', end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE status = 'active' AND id != ?`
    ).run(row.start_date ?? localDateISO(), id);
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

function daysAfterISO(date: string, days: number): string | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 864e5).toISOString().slice(0, 10);
}

function firstWeightAtOrBelow(targetWeight: number, startDate?: string | null): any {
  if (!Number.isFinite(targetWeight)) return null;
  const since = iso(startDate);
  if (since) {
    return (
      db
        .prepare(
          `SELECT date, weight_lb, created_at FROM bodyweight_log
            WHERE date >= ? AND weight_lb <= ?
            ORDER BY date ASC, id ASC LIMIT 1`
        )
        .get(since, targetWeight) || null
    );
  }
  return (
    db
      .prepare(
        `SELECT date, weight_lb, created_at FROM bodyweight_log
          WHERE weight_lb <= ?
          ORDER BY date ASC, id ASC LIMIT 1`
      )
      .get(targetWeight) || null
  );
}

function latestWeightPoint(): any {
  return (
    db.prepare(`SELECT date, weight_lb, created_at FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() ||
    null
  );
}

function measurementCreatedAt(date?: string | null): string | null {
  const d = iso(date);
  if (!d) return null;
  const row = db
    .prepare(`SELECT created_at FROM body_measurements WHERE date = ? ORDER BY id DESC LIMIT 1`)
    .get(d) as any;
  return row?.created_at ?? null;
}

function addMilestone(out: JourneyMilestone[], milestone: JourneyMilestone) {
  if (!milestone.label.trim()) return;
  if (out.some((m) => m.id === milestone.id)) return;
  out.push(milestone);
}

export function journeyMilestones(today = localDateISO()): JourneyMilestone[] {
  const p = getProfile();
  if (!p) return [];

  const phase = activeJourneyPhase();
  const latestWeight = latestWeightPoint();
  const currentWeight = Number(latestWeight?.weight_lb ?? p.weight_lb);
  const startWeight = Number(p.start_weight_lb ?? phase?.start_weight_lb);
  const goalWeight = Number(p.goal_weight_lb ?? phase?.target_weight_lb);
  const startDate = iso(p.start_date) ?? iso(phase?.start_date);
  const bodyFat = currentBodyFatEstimate(p);
  const startBf = Number(phase?.start_bodyfat_pct);
  const targetBf = Number(p.goal_bodyfat_pct ?? phase?.target_bodyfat_pct);
  const out: JourneyMilestone[] = [];

  if (Number.isFinite(startWeight) && Number.isFinite(currentWeight) && currentWeight < startWeight) {
    const lost = Math.round((startWeight - currentWeight) * 10) / 10;
    const fiveLb = Math.floor(lost / 5) * 5;
    if (fiveLb >= 5) {
      const target = startWeight - fiveLb;
      const hit = firstWeightAtOrBelow(target, startDate) ?? latestWeight;
      addMilestone(out, {
        id: `weight-loss-${fiveLb}`,
        kind: "weight_loss",
        label: `${fiveLb} lb down`,
        detail: `From ${Math.round(startWeight * 10) / 10} lb to ${Math.round(currentWeight * 10) / 10} lb.`,
        achieved_date: iso(hit?.date) ?? iso(latestWeight?.date) ?? today,
        achieved_at: hit?.created_at ?? latestWeight?.created_at ?? null,
        value: fiveLb,
        priority: Math.min(84, 54 + Math.floor(fiveLb / 5) * 4),
      });
    }
  }

  if (
    Number.isFinite(startWeight) &&
    Number.isFinite(currentWeight) &&
    Number.isFinite(goalWeight) &&
    goalWeight < startWeight
  ) {
    const total = startWeight - goalWeight;
    const progress = Math.max(0, Math.min(1, (startWeight - currentWeight) / total));
    for (const pct of [75, 50, 25]) {
      if (progress < pct / 100) continue;
      const target = startWeight - total * (pct / 100);
      const hit = firstWeightAtOrBelow(target, startDate) ?? latestWeight;
      addMilestone(out, {
        id: `goal-progress-${pct}`,
        kind: "goal_progress",
        label: `${pct}% of the way to goal weight`,
        detail: `${Math.round((startWeight - currentWeight) * 10) / 10} of ${Math.round(total * 10) / 10} lb is off.`,
        achieved_date: iso(hit?.date) ?? iso(latestWeight?.date) ?? today,
        achieved_at: hit?.created_at ?? latestWeight?.created_at ?? null,
        value: pct,
        priority: 58 + Math.round(pct / 5),
      });
    }
    if (currentWeight <= goalWeight + 0.5) {
      const hit = firstWeightAtOrBelow(goalWeight + 0.5, startDate) ?? latestWeight;
      addMilestone(out, {
        id: "goal-weight-reached",
        kind: "goal_reached",
        label: "Goal weight reached",
        detail: "Arrival now becomes a maintenance phase to stabilize.",
        achieved_date: iso(hit?.date) ?? iso(latestWeight?.date) ?? today,
        achieved_at: hit?.created_at ?? latestWeight?.created_at ?? null,
        value: Math.round(currentWeight * 10) / 10,
        priority: 96,
      });
    }
  }

  if (bodyFat && Number.isFinite(startBf) && bodyFat.body_fat_pct < startBf) {
    const band = [35, 30, 25, 20, 15].find((x) => startBf > x && bodyFat.body_fat_pct <= x);
    if (band != null) {
      addMilestone(out, {
        id: `bodyfat-band-${band}`,
        kind: "bodyfat_band",
        label: `Under ${band}% body-fat estimate`,
        detail: `${bodyFat.source} estimate: ${bodyFat.body_fat_pct}%.`,
        achieved_date: bodyFat.date ?? today,
        achieved_at: bodyFat.source === "tape" ? measurementCreatedAt(bodyFat.date) : null,
        value: band,
        priority: 72,
      });
    }
  }

  if (bodyFat && Number.isFinite(targetBf) && targetBf > 0 && bodyFat.body_fat_pct <= targetBf + 0.3) {
    addMilestone(out, {
      id: "bodyfat-goal-reached",
      kind: "bodyfat_goal",
      label: "Target body-fat estimate reached",
      detail: `${bodyFat.source} estimate: ${bodyFat.body_fat_pct}%.`,
      achieved_date: bodyFat.date ?? today,
      achieved_at: bodyFat.source === "tape" ? measurementCreatedAt(bodyFat.date) : null,
      value: bodyFat.body_fat_pct,
      priority: 94,
    });
  }

  if (phase?.status === "active") {
    const age = phaseAgeDays(phase, today);
    if (age != null && age >= 28) {
      const weeks = Math.floor(age / 7);
      const milestoneWeeks = Math.floor(weeks / 4) * 4;
      if (milestoneWeeks >= 4) {
        addMilestone(out, {
          id: `phase-${phase.kind}-${milestoneWeeks}w`,
          kind: "goal_progress",
          label: `${milestoneWeeks} weeks into this ${String(phase.kind).replace(/_/g, " ")} phase`,
          detail: "The phase is established enough to read its trend calmly.",
          achieved_date: daysAfterISO(phase.start_date, milestoneWeeks * 7),
          achieved_at: null,
          value: milestoneWeeks,
          priority: Math.min(62, 42 + milestoneWeeks),
        });
      }
    }
  }

  return out
    .sort(
      (a, b) => b.priority - a.priority || String(b.achieved_date ?? "").localeCompare(String(a.achieved_date ?? ""))
    )
    .slice(0, 8);
}

export function latestJourneyMilestoneSince(stampSql: string): JourneyMilestone | null {
  const stamp = String(stampSql || "").trim();
  if (!stamp) return null;
  return journeyMilestones().find((m) => m.achieved_at != null && String(m.achieved_at) > stamp) ?? null;
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

  const reachedWeight =
    Number.isFinite(weight) && Number.isFinite(goalWeight) && goalWeight > 0 && weight <= goalWeight + 0.5;
  const reachedBf =
    bodyFat?.body_fat_pct != null &&
    Number.isFinite(targetBf) &&
    targetBf > 0 &&
    bodyFat.body_fat_pct <= targetBf + 0.3;
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

  // A DIET BREAK IS NOT A DEFAULT LANE. While the athlete is in a cut they have
  // affirmed, the system does not volunteer maintenance on a calendar — a phase
  // that reads to the athlete as "start eating back up" has to be earned by
  // logged evidence, not by the cut having simply run a while. `mayProposeEaseFromCut`
  // is false exactly while that cut stands (src/repo/cut-target.ts); it opens as
  // soon as the goal check-in is asking whether the goal still holds and the
  // question is unanswered, which is the moment the athlete IS reconsidering.
  //
  // This gates only what the SYSTEM proposes on its own. The athlete asking for a
  // break, and `createJourneyPhase` being called directly, are untouched — and the
  // grounded ease of the DEFICIT (cut-target.ts's derivation) is a different lever
  // that keeps working throughout.
  if (mode === "lose" && (phase == null || phase.kind === "cut") && mayProposeEaseFromCut(today)) {
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

export function journeyRead(
  today = localDateISO(),
  opts: {
    // `null` means the caller already attempted the estimate and it was
    // unavailable; do not silently perform the expensive read again.
    expenditure?: ExpenditureEstimate | null;
    programState?: ProgramState;
    wholePerson?: WholePersonTrajectory;
  } = {}
) {
  const p = getProfile();
  const bodyFat = currentBodyFatEstimate(p);
  const goal = p ? computeGoalCheck(p, { expenditure: opts.expenditure }) : null;
  const activePhase = activeJourneyPhase();
  const underfueling = currentUnderfuelingRead(today, {
    expenditure: opts.expenditure,
    goal,
    programState: opts.programState,
    wholePerson: opts.wholePerson,
  });
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
    active_phase: activePhase,
    proposed_phases: listJourneyPhases("proposed"),
    transition_suggestion: journeyTransitionSuggestion(today),
    milestones: journeyMilestones(today),
    leanness_rate: (goal as any)?.leanness_rate ?? null,
    recomposition: recompositionRead(today, {
      activePhase,
      expenditure: opts.expenditure,
      programState: opts.programState,
      wholePerson: opts.wholePerson,
      underfueling,
    }),
    underfueling,
  };
}
