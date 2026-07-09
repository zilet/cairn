// Adaptive plan-day selection — pick which programmed day today's "train" read
// should point at. Starts from the historical rotation, then lets logged content,
// volume balance, and acute muscle load adapt the pick when another programmed day
// is clearly smarter. Deterministic + null-safe; never mutates the plan.
//
// Split out of the former intelligence.ts monolith (K4). dayRead / forwardLook (in
// day-read.ts) consume selectAdaptivePlanDay + the helpers re-exported here.
import { db } from "../db.js";
import { canonicalGroup, classifyMuscleGroup, type MuscleGroup } from "./exercise-canon.js";
import { type RecentLoad, recentMuscleLoad } from "./hybrid-load.js";
import { programBalance } from "./progression.js";
import { daysBetweenISO } from "./shared.js";

export interface PlanDayCandidate {
  id: number;
  day_number: number;
  name: string;
  focus: string | null;
  names: string[];
  groups: MuscleGroup[];
}

export interface ResolvedSessionPlanDay {
  day_number: number;
  method: "linked" | "exercise-overlap" | "group-overlap";
}

interface SessionAnchor {
  id: number;
  date: string;
  days_ago: number | null;
  groups: MuscleGroup[];
  resolved: ResolvedSessionPlanDay | null;
}

interface PlanSelectionScore {
  day_number: number;
  focus: string | null;
  score: number;
  due: string[];
  fresh_due: string[];
  recovering: string[];
  repeated: string[];
  over: string[];
  reasons: string[];
}

function joinGroups(groups: string[]): string {
  if (groups.length <= 1) return groups[0] ?? "";
  return `${groups.slice(0, -1).join(", ")} and ${groups[groups.length - 1]}`;
}

export function planDayFocus(day: Pick<PlanDayCandidate, "name" | "focus" | "day_number">): string {
  return String(day.focus || day.name || `Day ${day.day_number}`).replace(/\s+/g, " ").trim();
}

export function planDayCandidates(): PlanDayCandidate[] {
  const rows = db.prepare(
    `SELECT pd.id AS id, pd.day_number AS day_number, pd.name AS day_name, pd.focus AS focus,
            pi.kind AS kind, e.name AS exercise, e.muscle_group AS muscle_group
       FROM plan_days pd
       LEFT JOIN plan_items pi ON pi.plan_day_id = pd.id
       LEFT JOIN exercises e ON e.id = pi.exercise_id
      ORDER BY pd.day_number, pi.position`
  ).all() as any[];
  const map = new Map<number, PlanDayCandidate>();
  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const cur = map.get(id) ?? {
      id,
      day_number: Number(r.day_number),
      name: String(r.day_name || `Day ${r.day_number}`),
      focus: r.focus == null ? null : String(r.focus),
      names: [],
      groups: [],
    };
    const exercise = r.exercise == null ? "" : String(r.exercise).trim();
    if (exercise && r.kind !== "cardio") {
      if (!cur.names.includes(exercise)) cur.names.push(exercise);
      const group = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(exercise);
      if (group && group !== "mobility" && !cur.groups.includes(group)) cur.groups.push(group);
    }
    map.set(id, cur);
  }
  return [...map.values()].sort((a, b) => a.day_number - b.day_number);
}

function sessionGroups(sessionId: number): MuscleGroup[] {
  const rows = db.prepare(
    `SELECT DISTINCT e.name AS exercise, e.muscle_group AS muscle_group
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
      WHERE ls.session_id = ?`
  ).all(sessionId) as any[];
  const groups: MuscleGroup[] = [];
  for (const r of rows) {
    const group = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(r.exercise);
    if (group && group !== "mobility" && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

export function resolveSessionPlanDay(
  sessionId: number,
  planDayId: number | null,
  candidates: PlanDayCandidate[],
): ResolvedSessionPlanDay | null {
  if (planDayId != null) {
    const linked = candidates.find((d) => d.id === Number(planDayId));
    if (linked) return { day_number: linked.day_number, method: "linked" };
  }

  const loggedNames = new Set(
    (db.prepare(
      `SELECT DISTINCT LOWER(e.name) AS name
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
        WHERE ls.session_id = ?`
    ).all(sessionId) as any[]).map((r) => String(r.name))
  );
  let exact: { day_number: number; hits: number } | null = null;
  for (const day of candidates) {
    let hits = 0;
    for (const name of day.names) if (loggedNames.has(name.toLowerCase())) hits++;
    if (hits && (!exact || hits > exact.hits)) exact = { day_number: day.day_number, hits };
  }
  if (exact) return { day_number: exact.day_number, method: "exercise-overlap" };

  const groups = sessionGroups(sessionId);
  if (!groups.length) return null;
  const loggedGroups = new Set(groups);
  let best: { day_number: number; hits: number; ratio: number } | null = null;
  for (const day of candidates) {
    if (!day.groups.length) continue;
    const hits = day.groups.filter((g) => loggedGroups.has(g)).length;
    if (!hits) continue;
    const ratio = hits / Math.max(1, Math.min(day.groups.length, loggedGroups.size));
    if (!best || hits > best.hits || (hits === best.hits && ratio > best.ratio)) {
      best = { day_number: day.day_number, hits, ratio };
    }
  }
  return best ? { day_number: best.day_number, method: "group-overlap" } : null;
}

function recentSessionAnchors(date: string, candidates: PlanDayCandidate[]): SessionAnchor[] {
  const rows = db.prepare(
    `SELECT s.id AS id, s.date AS date, s.plan_day_id AS plan_day_id
       FROM sessions s
      WHERE s.date < ?
        AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
      ORDER BY s.date DESC, s.id DESC LIMIT 20`
  ).all(date) as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    date: String(r.date),
    days_ago: daysBetweenISO(date, String(r.date)),
    groups: sessionGroups(Number(r.id)),
    resolved: resolveSessionPlanDay(Number(r.id), r.plan_day_id == null ? null : Number(r.plan_day_id), candidates),
  }));
}

export function nextCandidateAfter(candidates: PlanDayCandidate[], dayNumber: number): PlanDayCandidate {
  const idx = candidates.findIndex((d) => d.day_number === dayNumber);
  return candidates[idx >= 0 ? (idx + 1) % candidates.length : 0];
}

function weekdayCandidate(candidates: PlanDayCandidate[], date: string): PlanDayCandidate {
  const idx = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon=0
  return candidates[idx % candidates.length];
}

function scorePlanDay(params: {
  day: PlanDayCandidate;
  rotation: PlanDayCandidate;
  rotationIndex: number;
  candidates: PlanDayCandidate[];
  due: Set<string>;
  over: Set<string>;
  broadLow: boolean;
  recentLoad: Map<MuscleGroup, RecentLoad>;
  last: SessionAnchor | null;
}): PlanSelectionScore {
  const { day, rotation, rotationIndex, candidates, due, over, broadLow, recentLoad, last } = params;
  const dayIndex = candidates.findIndex((d) => d.day_number === day.day_number);
  const distance = dayIndex >= 0 && rotationIndex >= 0
    ? (dayIndex - rotationIndex + candidates.length) % candidates.length
    : 0;
  const lastGroups = new Set(last?.groups ?? []);
  const lastAge = last?.days_ago;
  const dueGroups = day.groups.filter((g) => due.has(g));
  const overGroups = day.groups.filter((g) => over.has(g));
  const recovering = day.groups.filter((g) => {
    const rl = recentLoad.get(g);
    return !!rl?.heavy && rl.days_ago <= 2;
  });
  const freshDue = dueGroups.filter((g) => !recovering.includes(g));
  const repeated = lastAge != null && lastAge <= 3
    ? day.groups.filter((g) => lastGroups.has(g))
    : [];

  let score = day.day_number === rotation.day_number ? 2 : 0;
  score -= distance * 0.25;
  if (!day.groups.length) score -= 0.5;
  score += dueGroups.length * (broadLow ? 1.2 : 3);
  if (freshDue.length >= 2) score += 0.75;
  score -= overGroups.length * 2;
  for (const group of recovering) {
    const rl = recentLoad.get(group);
    score -= rl && rl.days_ago <= 1 ? 5 : 3;
  }
  for (const group of repeated) {
    const rl = recentLoad.get(group);
    // A recent heavy load already carries the stronger recovering penalty.
    if (rl?.heavy && rl.days_ago <= 2) continue;
    score -= lastAge != null && lastAge <= 1 ? 2.5 : 1.5;
  }
  if (day.groups.length >= 3 && freshDue.length >= 2) score += 0.5; // full-body day that covers several fresh gaps

  const reasons: string[] = [];
  if (freshDue.length) reasons.push(`${joinGroups(freshDue)} due`);
  if (recovering.length) reasons.push(`${joinGroups(recovering)} recovering`);
  if (repeated.length) reasons.push(`${joinGroups(repeated)} just trained`);
  if (overGroups.length) reasons.push(`${joinGroups(overGroups)} running high`);
  if (!reasons.length && day.day_number === rotation.day_number) reasons.push("normal rotation");

  return {
    day_number: day.day_number,
    focus: planDayFocus(day),
    score: Math.round(score * 10) / 10,
    due: dueGroups,
    fresh_due: freshDue,
    recovering,
    repeated,
    over: overGroups,
    reasons,
  };
}

function selectionReason(selected: PlanSelectionScore, rotation: PlanSelectionScore): string | null {
  if (selected.day_number === rotation.day_number) return null;
  const lead = selected.fresh_due.length
    ? `${joinGroups(selected.fresh_due)} ${selected.fresh_due.length === 1 ? "is" : "are"} more due and fresh`
    : selected.reasons[0] || "it fits the recent history better";
  let avoid = "";
  if (rotation.recovering.length) avoid = `${rotation.focus} overlaps ${joinGroups(rotation.recovering)} still recovering`;
  else if (rotation.repeated.length) avoid = `${rotation.focus} repeats ${joinGroups(rotation.repeated)} from the last session`;
  else if (rotation.over.length) avoid = `${rotation.focus} leans into ${joinGroups(rotation.over)} already running high`;
  return avoid ? `${lead}, while ${avoid}` : lead;
}

export function selectAdaptivePlanDay(date: string): { day_number: number; focus: string | null; selection: Record<string, any> } | null {
  const candidates = planDayCandidates();
  if (!candidates.length) return null;
  const anchors = recentSessionAnchors(date, candidates);
  const anchor = anchors.find((a) => a.resolved) ?? null;
  const rotation = anchor?.resolved
    ? nextCandidateAfter(candidates, anchor.resolved.day_number)
    : weekdayCandidate(candidates, date);

  let balance: any = null;
  try { balance = programBalance(2, date); } catch { balance = null; }
  let load: Map<MuscleGroup, RecentLoad>;
  try { load = recentMuscleLoad(3, date); } catch { load = new Map(); }

  const due = new Set<string>(Array.isArray(balance?.due) ? balance.due : []);
  const over = new Set<string>(Array.isArray(balance?.over) ? balance.over : []);
  const rotationIndex = candidates.findIndex((d) => d.day_number === rotation.day_number);
  const scored = candidates.map((day) => scorePlanDay({
    day,
    rotation,
    rotationIndex,
    candidates,
    due,
    over,
    broadLow: !!balance?.broad_low,
    recentLoad: load,
    last: anchors[0] ?? null,
  }));
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.day_number - b.day_number);
  const rotationScore = scored.find((s) => s.day_number === rotation.day_number) ?? sorted[0];
  const best = sorted[0] ?? rotationScore;
  const materiallyBetter = best && rotationScore && best.day_number !== rotation.day_number && best.score >= rotationScore.score + 2.5;
  const selectedScore = materiallyBetter ? best : rotationScore;
  const selected = candidates.find((d) => d.day_number === selectedScore.day_number) ?? rotation;
  const reason = materiallyBetter ? selectionReason(selectedScore, rotationScore) : null;

  return {
    day_number: selected.day_number,
    focus: planDayFocus(selected),
    selection: {
      selected: { day_number: selected.day_number, focus: planDayFocus(selected) },
      rotation: { day_number: rotation.day_number, focus: planDayFocus(rotation) },
      adapted: !!materiallyBetter,
      reason,
      anchor: anchor
        ? {
            date: anchor.date,
            days_ago: anchor.days_ago,
            groups: anchor.groups,
            resolved_day_number: anchor.resolved?.day_number ?? null,
            method: anchor.resolved?.method ?? null,
          }
        : null,
      last_session: anchors[0]
        ? { date: anchors[0].date, days_ago: anchors[0].days_ago, groups: anchors[0].groups }
        : null,
      due: [...due].slice(0, 8),
      over: [...over].slice(0, 8),
      recent_load: [...load.values()].map((r) => ({
        group: r.group,
        days_ago: r.days_ago,
        heavy: r.heavy,
        source: r.source,
        activity: r.activity,
      })).slice(0, 8),
      scores: sorted.slice(0, 5),
    },
  };
}
