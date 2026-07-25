// Adaptive plan-day selection — pick which programmed day today's "train" read
// should point at. Starts from the historical rotation, then lets logged content,
// volume balance, and acute muscle load adapt the pick when another programmed day
// is clearly smarter. Deterministic + null-safe; never mutates the plan.
//
// Split out of the former intelligence.ts monolith (K4). dayRead / forwardLook (in
// day-read.ts) consume selectAdaptivePlanDay + the helpers re-exported here.
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { canonicalGroup, classifyMuscleGroup, type MuscleGroup } from "./exercise-canon.js";
import { type RecentLoad, recentMuscleLoad } from "./hybrid-load.js";
import { programBalance } from "./progression.js";
import { daysBetweenISO, joinList, localDateISO } from "./shared.js";

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

export interface SelectedPlanDay {
  date: string;
  plan_day_id: number;
  day_number: number;
  focus: string | null;
  selection: Record<string, any>;
  source: "existing-session" | "cached-day-read" | "adaptive";
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

export function planDayFocus(day: Pick<PlanDayCandidate, "name" | "focus" | "day_number">): string {
  return String(day.focus || day.name || `Day ${day.day_number}`)
    .replace(/\s+/g, " ")
    .trim();
}

export function planDayCandidates(): PlanDayCandidate[] {
  const rows = db
    .prepare(
      `SELECT pd.id AS id, pd.day_number AS day_number, pd.name AS day_name, pd.focus AS focus,
            pi.kind AS kind, e.name AS exercise, e.muscle_group AS muscle_group
       FROM plan_days pd
       LEFT JOIN plan_items pi ON pi.plan_day_id = pd.id
       LEFT JOIN exercises e ON e.id = pi.exercise_id
      ORDER BY pd.day_number, pi.position`
    )
    .all() as any[];
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
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name AS exercise, e.muscle_group AS muscle_group
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
      WHERE ls.session_id = ?`
    )
    .all(sessionId) as any[];
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
  candidates: PlanDayCandidate[]
): ResolvedSessionPlanDay | null {
  if (planDayId != null) {
    const linked = candidates.find((d) => d.id === Number(planDayId));
    if (linked) return { day_number: linked.day_number, method: "linked" };
  }

  const loggedNames = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT LOWER(e.name) AS name
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
        WHERE ls.session_id = ?`
        )
        .all(sessionId) as any[]
    ).map((r) => String(r.name))
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
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.date AS date, s.plan_day_id AS plan_day_id
       FROM sessions s
      WHERE s.date < ?
        AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
      ORDER BY s.date DESC, s.id DESC LIMIT 20`
    )
    .all(date) as any[];
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
  const distance =
    dayIndex >= 0 && rotationIndex >= 0 ? (dayIndex - rotationIndex + candidates.length) % candidates.length : 0;
  const lastGroups = new Set(last?.groups ?? []);
  const lastAge = last?.days_ago;
  const dueGroups = day.groups.filter((g) => due.has(g));
  const overGroups = day.groups.filter((g) => over.has(g));
  const recovering = day.groups.filter((g) => {
    const rl = recentLoad.get(g);
    return !!rl?.heavy && rl.days_ago <= 2;
  });
  const freshDue = dueGroups.filter((g) => !recovering.includes(g));
  const repeated = lastAge != null && lastAge <= 3 ? day.groups.filter((g) => lastGroups.has(g)) : [];

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
  if (freshDue.length) reasons.push(`${joinList(freshDue)} due`);
  if (recovering.length) reasons.push(`${joinList(recovering)} recovering`);
  if (repeated.length) reasons.push(`${joinList(repeated)} just trained`);
  if (overGroups.length) reasons.push(`${joinList(overGroups)} running high`);
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

// selectionReason() produces the ONE machine→athlete caveat day-read.ts splices
// into the Brief's `why` (`"<lead> — " + caveats.join("; and ")`), so every
// phrasing here is a second-person, lowercase-starting sentence fragment with NO
// terminal punctuation — never a bare noun phrase, and never a plan-day label
// capitalized mid-sentence (that label is always lowercased before it lands in a
// template below). Distinct reason shapes each get their own ≥3-phrasing variant
// set, rotated with pickDayVariant on the SAME day the rest of the Brief rotates
// on — a stable plan-selection state fires the same shape every morning, so one
// literal per shape would read as a stuck app within a week (CLAUDE.md).
const SELECTION_LEAD_FRESH_DUE = [
  "you're leaning into {groups} today — more due and fresher than usual",
  "you're catching {groups} at the better time, more due and still fresh",
  "you're picking up {groups} today, the more due and fresher option",
] as const;
const SELECTION_LEAD_RECOVERING = [
  "you're still touching {groups} a little early here, but the rest of today fits better",
  "you're working {groups} while it's mid-recovery, though everything else lines up better",
  "you're catching {groups} a touch sooner than ideal, but today still reads as the better fit",
] as const;
const SELECTION_LEAD_REPEATED = [
  "you're repeating {groups} from your last session, but the rest of today fits better",
  "you're touching {groups} again so soon, though everything else lines up better",
  "you're working {groups} a little sooner than usual, but today still reads as the better fit",
] as const;
const SELECTION_LEAD_OVER = [
  "you're still leaning into {groups}, already running high, but the rest of today fits better",
  "you're adding a bit more to {groups}, already well-loaded, though everything else lines up better",
  "you're working {groups} on the high side, but today still reads as the better fit",
] as const;
const SELECTION_LEAD_FALLBACK = [
  "it lines up better with what you've trained recently",
  "this shape simply fits your recent training history better",
  "it reads as the better match for how you've been training lately",
] as const;

const SELECTION_AVOID_RECOVERING = [
  "your usual {day} day would overlap {groups}, still recovering",
  "your regular {day} day would lean back into {groups}, not yet recovered",
  "sticking with {day} would touch {groups}, still on the mend",
] as const;
const SELECTION_AVOID_REPEATED = [
  "your usual {day} day repeats {groups} from your last session",
  "your regular {day} day would train {groups} again, too soon after last time",
  "sticking with {day} would touch {groups} you just worked",
] as const;
const SELECTION_AVOID_OVER = [
  "your usual {day} day leans into {groups}, already running high",
  "your regular {day} day would add to {groups}, already well-loaded",
  "sticking with {day} would pile onto {groups}, already running high",
] as const;

function lc(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function fillGroups(template: string, groups: string): string {
  return template.replace(/\{groups\}/g, groups);
}

function fillDayAndGroups(template: string, day: string, groups: string): string {
  return template.replace(/\{day\}/g, day).replace(/\{groups\}/g, groups);
}

// The lead clause: why the SELECTED day itself is the better pick, in the same
// priority order the original literal fallback (fresh-due > recovering > repeated
// > over > "fits better") checked — but authored, second person, and rotating.
function selectionLeadClause(selected: PlanSelectionScore, date: string): string {
  if (selected.fresh_due.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_FRESH_DUE, date, "plan-selection:lead:fresh_due"),
      joinList(selected.fresh_due)
    );
  }
  if (selected.recovering.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_RECOVERING, date, "plan-selection:lead:recovering"),
      joinList(selected.recovering)
    );
  }
  if (selected.repeated.length) {
    return fillGroups(
      pickDayVariant(SELECTION_LEAD_REPEATED, date, "plan-selection:lead:repeated"),
      joinList(selected.repeated)
    );
  }
  if (selected.over.length) {
    return fillGroups(pickDayVariant(SELECTION_LEAD_OVER, date, "plan-selection:lead:over"), joinList(selected.over));
  }
  return pickDayVariant(SELECTION_LEAD_FALLBACK, date, "plan-selection:lead:fallback");
}

// The avoid clause: what the athlete's USUAL (rotation) day would have cost —
// `rotation.focus` is a plan-day label ("Lower body", "Push") and is lowercased
// before it lands mid-sentence.
function selectionAvoidClause(rotation: PlanSelectionScore, date: string): string {
  const day = lc(rotation.focus) || "that";
  if (rotation.recovering.length) {
    return fillDayAndGroups(
      pickDayVariant(SELECTION_AVOID_RECOVERING, date, "plan-selection:avoid:recovering"),
      day,
      joinList(rotation.recovering)
    );
  }
  if (rotation.repeated.length) {
    return fillDayAndGroups(
      pickDayVariant(SELECTION_AVOID_REPEATED, date, "plan-selection:avoid:repeated"),
      day,
      joinList(rotation.repeated)
    );
  }
  if (rotation.over.length) {
    return fillDayAndGroups(
      pickDayVariant(SELECTION_AVOID_OVER, date, "plan-selection:avoid:over"),
      day,
      joinList(rotation.over)
    );
  }
  return "";
}

function selectionReason(selected: PlanSelectionScore, rotation: PlanSelectionScore, date: string): string | null {
  if (selected.day_number === rotation.day_number) return null;
  const lead = selectionLeadClause(selected, date);
  const avoid = selectionAvoidClause(rotation, date);
  return avoid ? `${lead}, while ${avoid}` : lead;
}

export function selectAdaptivePlanDay(
  date: string
): { day_number: number; focus: string | null; selection: Record<string, any> } | null {
  const candidates = planDayCandidates();
  if (!candidates.length) return null;
  const anchors = recentSessionAnchors(date, candidates);
  const anchor = anchors.find((a) => a.resolved) ?? null;
  const rotation = anchor?.resolved
    ? nextCandidateAfter(candidates, anchor.resolved.day_number)
    : weekdayCandidate(candidates, date);

  let balance: any = null;
  try {
    balance = programBalance(2, date);
  } catch {
    balance = null;
  }
  let load: Map<MuscleGroup, RecentLoad>;
  try {
    load = recentMuscleLoad(3, date);
  } catch {
    load = new Map();
  }

  const due = new Set<string>(Array.isArray(balance?.due) ? balance.due : []);
  const over = new Set<string>(Array.isArray(balance?.over) ? balance.over : []);
  const rotationIndex = candidates.findIndex((d) => d.day_number === rotation.day_number);
  const scored = candidates.map((day) =>
    scorePlanDay({
      day,
      rotation,
      rotationIndex,
      candidates,
      due,
      over,
      broadLow: !!balance?.broad_low,
      recentLoad: load,
      last: anchors[0] ?? null,
    })
  );
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.day_number - b.day_number);
  const rotationScore = scored.find((s) => s.day_number === rotation.day_number) ?? sorted[0];
  const best = sorted[0] ?? rotationScore;
  const materiallyBetter =
    best && rotationScore && best.day_number !== rotation.day_number && best.score >= rotationScore.score + 2.5;
  const selectedScore = materiallyBetter ? best : rotationScore;
  const selected = candidates.find((d) => d.day_number === selectedScore.day_number) ?? rotation;
  const reason = materiallyBetter ? selectionReason(selectedScore, rotationScore, date) : null;

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
      recent_load: [...load.values()]
        .map((r) => ({
          group: r.group,
          days_ago: r.days_ago,
          heavy: r.heavy,
          source: r.source,
          activity: r.activity,
        }))
        .slice(0, 8),
      scores: sorted.slice(0, 5),
    },
  };
}

// One server-owned answer to "which programmed day would I train on this date?".
// Reuse the Brief's persisted adaptive answer when available; otherwise derive it
// from the same selector. Validate the referenced day so a deleted plan day cannot
// survive through an old cache row.
export function selectedPlanDayForDate(date: string): SelectedPlanDay | null {
  const candidates = planDayCandidates();
  if (!candidates.length) return null;
  // Once the athlete has started or manually chosen a session, that concrete
  // session outranks the earlier Brief/cache. This keeps chat, REST, MCP, and the
  // Today surface on the same plan day without stealing an explicit selection.
  const session = db.prepare(`SELECT plan_day_id FROM sessions WHERE date = ?`).get(date) as any;
  const sessionDay =
    session?.plan_day_id == null ? null : candidates.find((candidate) => candidate.id === Number(session.plan_day_id));
  if (sessionDay) {
    return {
      date,
      plan_day_id: sessionDay.id,
      day_number: sessionDay.day_number,
      focus: planDayFocus(sessionDay),
      selection: { selected: { day_number: sessionDay.day_number, focus: planDayFocus(sessionDay) } },
      source: "existing-session",
    };
  }
  try {
    const row = db.prepare(`SELECT signals FROM day_reads WHERE date = ?`).get(date) as any;
    const signals = row?.signals ? JSON.parse(String(row.signals)) : null;
    const selection = signals?.plan_selection;
    const dayNumber = Number(selection?.selected?.day_number);
    const day = Number.isFinite(dayNumber) ? candidates.find((candidate) => candidate.day_number === dayNumber) : null;
    if (day)
      return {
        date,
        plan_day_id: day.id,
        day_number: day.day_number,
        focus: planDayFocus(day),
        selection,
        source: "cached-day-read",
      };
  } catch {
    // Missing/malformed cache is only a cache miss.
  }
  const selected = selectAdaptivePlanDay(date);
  if (!selected) return null;
  const day = candidates.find((candidate) => candidate.day_number === selected.day_number);
  if (!day) return null;
  return {
    date,
    plan_day_id: day.id,
    day_number: day.day_number,
    focus: planDayFocus(day),
    selection: selected.selection,
    source: "adaptive",
  };
}

// Shared trust-boundary normalizer for REST, MCP, and chat set logging. Omission
// means "use Today's canonical adaptive session"; an own day_number property —
// including null — is an explicit caller choice and is preserved.
export function resolveImplicitPlanDay<T extends object>(input: T): T & { day_number?: number | null } {
  if (Object.hasOwn(input, "day_number")) return input;
  const fields = input as { date?: unknown };
  const date = fields.date ? String(fields.date) : localDateISO();
  // A prepared custom session deliberately has no weekly-template link. Do not
  // let the ordinary implicit logger attach today's adaptive day behind its back.
  // (Explicit day_number remains an athlete-directed override, as before.)
  const custom = db
    .prepare(
      `SELECT id FROM daily_session_compositions
        WHERE date = ? AND status = 'active' AND source IN ('agent_suggest','athlete_override')
        LIMIT 1`
    )
    .get(date);
  if (custom) return { ...input, day_number: null };
  return { ...input, day_number: selectedPlanDayForDate(date)?.day_number };
}
