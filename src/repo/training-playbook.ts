// Deterministic training playbook: plateau type + adherence-fit reads.
//
// This is a suggestion layer only. It never mutates the plan and never emits a
// numeric grade. The agentic evolution loop can use it to focus a proposal, but
// the athlete still chooses whether anything changes.
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { unverifiedRegressionHold } from "./calibration.js";
import { appliedProgressionDeloads } from "./plan.js";
import { getProfile } from "./profile.js";
import { getProgramState, type ProgramState } from "./program-state.js";
import { addDaysISO, localDateISO } from "./shared.js";

export type PlateauPlayKind =
  | "strength_plateau"
  | "endurance_plateau"
  | "mono_stimulus"
  | "hybrid_interference";

export interface PlateauPlay {
  kind: PlateauPlayKind;
  title: string;
  why: string;
  adaptations: string[];
  based_on: string[];
  exercise?: string;
  group?: string | null;
}

export interface AdherenceRestructureRead {
  status: "clear" | "watch" | "restructure";
  window_days: number;
  planned_sessions: number;
  completed_sessions: number;
  missed_planned_sessions: number;
  skipped_exercises: number;
  pattern: string;
  adaptations: string[];
}

export interface TrainingPlaybookRead {
  generated_for: string;
  plateau_plays: PlateauPlay[];
  adherence: AdherenceRestructureRead | null;
  adaptations: string[];
  headline: string;
}

interface TrainingPlaybookOpts {
  programState?: ProgramState | any;
  windowDays?: number;
}

const MAX_PLAYS = 4;
const MAX_ACTIONS = 3;

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function weekDayNumber(iso: string): number {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 ? 7 : day;
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  for (let guard = 0; guard < 370 && cur <= end; guard++) {
    out.push(cur);
    cur = addDaysISO(cur, 1) ?? cur;
    if (out[out.length - 1] === cur) break;
  }
  return out;
}

function effectiveGoalMode(): string | null {
  try {
    const p = getProfile() as any;
    if (p?.goal_mode) return String(p.goal_mode);
    const weight = Number(p?.weight_lb);
    const goal = Number(p?.goal_weight_lb);
    if (Number.isFinite(weight) && Number.isFinite(goal)) {
      if (goal < weight - 1) return "lose";
      if (goal > weight + 1) return "gain";
      return "maintain";
    }
  } catch { /* profile is optional */ }
  return null;
}

function uniqueActions(actions: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of actions) {
    const clean = String(a || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

// A lift that has ALREADY been backed off recently is not a candidate for another
// light deload — the first one is the evidence that a small load cut is not what it
// needs. The per-session engine escalates the prescription itself (a lower rep
// window, or the movement rotating out; see repo/progression.ts); the playbook has
// to tell the same story, or the coaching layer keeps recommending the move the
// engine has already stopped making. Phrasings rotate per day and per lift.
const DELOAD_REPEAT_WINDOW_DAYS = 56;

const ESCALATION_ACTIONS: readonly ((name: string) => string)[] = [
  (name) =>
    `${name} has already been backed off once recently — change the shape rather than the number: run a lower, heavier rep window for a few weeks, or rotate to a close variation and re-test the original.`,
  (name) =>
    `A second light deload for ${name} would repeat what did not work; drop into a heavier rep bracket for a stretch, or swap in a near variation and come back to it.`,
  (name) =>
    `${name} was eased recently and is still stuck, so the lever is the scheme or the movement — a lower rep window for a block, or a close variation before returning to it.`,
];

// The OTHER arm the engine can take on a regressing lift: when the slip is read
// off an estimate nothing heavy has confirmed, and the lift is one the calibration
// ladder will actually offer a test for, the engine HOLDS and asks for a heavy set
// rather than deloading. The playbook has to tell that story too — recommending a
// deload for a lift the engine is deliberately holding is the coaching layer and
// the engine giving the athlete two different answers about the same lift.
//
// The engine's own predicate is reused (unverifiedRegressionHold), never a second
// copy of the conditions: a diverging copy is exactly how the two would drift.
const VERIFY_FIRST_ACTIONS: readonly ((name: string) => string)[] = [
  (name) =>
    `Before backing ${name} off, put one genuinely heavy set on it — the dip may be the estimate drifting rather than the lift, and a top single or triple settles which.`,
  (name) =>
    `Hold ${name} where it is and open a session with one heavy top set; nothing recent has confirmed where this lift actually sits, so that set is what tells you whether there is anything to fix.`,
  (name) =>
    `Keep the load on ${name} and let a heavy set answer it first — a slip measured off an unconfirmed number is worth checking before it is worth cutting.`,
];

function recentlyDeloaded(name: string, date: string): boolean {
  const since = addDaysISO(date, -DELOAD_REPEAT_WINDOW_DAYS);
  if (!since) return false;
  try {
    return appliedProgressionDeloads(name, since, date) > 0;
  } catch {
    return false;
  }
}

function strengthPlateauPlays(ps: any, date: string): PlateauPlay[] {
  const lifts = Array.isArray(ps?.lifts) ? ps.lifts : [];
  const mode = effectiveGoalMode();
  return lifts
    .filter((l: any) => l && (l.status === "plateaued" || l.status === "regressing"))
    .map((l: any): PlateauPlay => {
      const name = String(l.exercise || "this lift");
      const grinding = Array.isArray(l.stall_signals) && l.stall_signals.some((s: any) => /grind|rir|same top/i.test(String(s)));
      const weeks = Number(l.weeks_static);
      const repeatDeload = recentlyDeloaded(name, date);
      // Only a REGRESSING lift can be in the engine's verify-first hold; a plateau
      // grind deloads on its own evidence, whatever the estimate is worth.
      const verifyFirst =
        l.status === "regressing" &&
        (() => {
          try {
            return unverifiedRegressionHold(name, date).holds;
          } catch {
            return false;
          }
        })();
      const actions: string[] = [];
      if (repeatDeload) {
        actions.push(pickDayVariant(ESCALATION_ACTIONS, date, `deload_escalation:${name.toLowerCase()}`)(name));
      } else if (verifyFirst) {
        actions.push(pickDayVariant(VERIFY_FIRST_ACTIONS, date, `verify_first:${name.toLowerCase()}`)(name));
      } else if (l.status === "regressing" || l.suggested_action === "deload" || grinding) {
        actions.push(`Run a light deload for ${name}, then rebuild from clean reps.`);
      }
      if (Number.isFinite(weeks) && weeks >= 3 || l.suggested_action === "vary") {
        actions.push(`Rotate to a close variation for ${name} for one block, then re-test the original pattern.`);
      }
      actions.push(`Hold the load and win by adding one clean rep or tightening technique before chasing weight.`);
      if (mode === "lose") actions.push("If the cut is deep, treat holding strength as a win; do not chase a risky load jump just to force progress.");
      const why = repeatDeload
        ? `${name} has already had a step back inside the last couple of months and is still not moving, so the next lever is a different shape of work, not a smaller number.`
        : verifyFirst
          ? `${name} reads as slipping, but the number it is measured against has not been confirmed by a heavy set in a while — so the first lever is a test, not a load cut.`
          : l.status === "regressing"
            ? `${name} is slipping rather than climbing, so the first lever is recovery and a cleaner rebuild.`
            : `${name} is flat${Number.isFinite(weeks) && weeks > 0 ? ` ~${weeks} wk` : ""}; the lever is a planned variation or technique reset, not forcing load.`;
      return {
        kind: "strength_plateau",
        title: `Strength plateau: ${name}`,
        why,
        adaptations: uniqueActions(actions),
        based_on: Array.isArray(l.stall_signals) && l.stall_signals.length ? l.stall_signals.map(String).slice(0, 3) : [String(l.why || "lift trajectory is flat")],
        exercise: name,
        group: l.muscle_group ?? null,
      };
    });
}

function endurancePlateauPlays(ps: any): PlateauPlay[] {
  const e = ps?.endurance;
  if (!e) return [];
  const out: PlateauPlay[] = [];
  if (e.pace_trend === "declining" || e.status === "detraining") {
    out.push({
      kind: "endurance_plateau",
      title: "Endurance plateau: pace is not responding",
      why: e.pace_trend === "declining"
        ? "Recent pace is drifting the wrong way, so this is a recovery/programming read before it is a fitness verdict."
        : "The endurance base has tapered enough that the next move is a gentle rebuild.",
      adaptations: uniqueActions([
        "Hold total volume steady for a week and make the easy days genuinely easy.",
        "Rebuild with one repeatable benchmark route before adding more distance.",
        "Protect sleep and fueling around the quality day before judging the block.",
      ]),
      based_on: [String(e.why || "endurance trend is not improving")],
    });
  }
  if (e.suggested_action === "add-quality" || e.has_quality === false) {
    out.push({
      kind: "mono_stimulus",
      title: "Mono-stimulus: too much of the same run",
      why: "The base is present, but the stimulus is mostly one pace; repeating it harder is less useful than adding one distinct input.",
      adaptations: uniqueActions([
        "Swap one steady run for short intervals, tempo, or hills.",
        "Keep the other endurance work easy so the quality day is the only hard signal.",
        "Use the same route or workout for a few weeks so progress is readable.",
      ]),
      based_on: [String(e.why || "endurance work is mostly one stimulus")],
    });
  }
  return out;
}

function hybridInterferencePlay(ps: any): PlateauPlay | null {
  const h = ps?.hybrid;
  if (!h) return null;
  const conflict = h.next_strength;
  const meaningfulConflict = conflict?.advice === "swap-or-upper" || conflict?.advice === "hold-load" || h.status === "fuel-protect";
  if (!meaningfulConflict) return null;
  const day = conflict?.day_name ? String(conflict.day_name) : "the next strength day";
  const actions = h.status === "fuel-protect"
    ? [
        "Do not stack more lower-body volume until fueling and recovery are protected.",
        "Put carbs around the long or hard endurance session and keep the deficit lean-safe.",
        "Hold strength loads steady for the overlapping lower-body work this week.",
      ]
    : [
        `Move heavy lower-body work away from ${day}, or make that day upper/core.`,
        "Hold load or trim sets on overlapping leg work until the endurance dose absorbs.",
        "Keep easy endurance easy; let only one modality be hard on the same 24-48h window.",
      ];
  return {
    kind: "hybrid_interference",
    title: "Hybrid interference: endurance is colliding with strength",
    why: conflict?.why || h.headline || "Endurance load and strength work are competing this week.",
    adaptations: uniqueActions(actions),
    based_on: [h.headline || conflict?.why || "hybrid conflict"],
  };
}

function plateauPlays(ps: any, date: string): PlateauPlay[] {
  const out: PlateauPlay[] = [];
  out.push(...strengthPlateauPlays(ps, date));
  out.push(...endurancePlateauPlays(ps));
  const hybrid = hybridInterferencePlay(ps);
  if (hybrid) out.push(hybrid);
  const rank: Record<PlateauPlayKind, number> = {
    strength_plateau: 1,
    hybrid_interference: 2,
    endurance_plateau: 3,
    mono_stimulus: 4,
  };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.title.localeCompare(b.title)).slice(0, MAX_PLAYS);
}

function plannedDays(): Array<{ id: number; day_number: number; name: string }> {
  try {
    return (db.prepare(`SELECT id, day_number, name FROM plan_days ORDER BY day_number`).all() as any[])
      .map((r) => ({ id: Number(r.id), day_number: Number(r.day_number), name: String(r.name || `Day ${r.day_number}`) }))
      .filter((r) => Number.isFinite(r.id) && Number.isFinite(r.day_number) && r.day_number >= 1 && r.day_number <= 7);
  } catch {
    return [];
  }
}

function completedTrainingDates(start: string, end: string): Set<string> {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT s.date AS date
         FROM sessions s
         JOIN logged_sets ls ON ls.session_id = s.id
        WHERE s.date >= ? AND s.date <= ?`
    ).all(start, end) as any[];
    return new Set(rows.map((r) => String(r.date).slice(0, 10)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function skipRows(start: string, end: string): Array<{ date: string; exercise: string }> {
  try {
    return (db.prepare(
      `SELECT s.date AS date, ss.exercise AS exercise
         FROM session_skips ss
         JOIN sessions s ON s.id = ss.session_id
        WHERE s.date >= ? AND s.date <= ?
        ORDER BY s.date, ss.exercise`
    ).all(start, end) as any[]).map((r) => ({ date: String(r.date).slice(0, 10), exercise: String(r.exercise || "") }));
  } catch {
    return [];
  }
}

function adherenceRead(date: string, windowDays: number): AdherenceRestructureRead | null {
  const days = plannedDays();
  if (!days.length) return null;
  const end = date;
  const start = addDaysISO(end, -(Math.max(14, windowDays) - 1)) ?? end;
  const dayByNumber = new Map(days.map((d) => [d.day_number, d]));
  const expected = eachDate(start, end)
    .map((d) => ({ date: d, plan: dayByNumber.get(weekDayNumber(d)) }))
    .filter((x): x is { date: string; plan: { id: number; day_number: number; name: string } } => !!x.plan);
  if (expected.length < 4) return null;

  const completed = completedTrainingDates(start, end);
  const skipped = skipRows(start, end);
  const missed = expected.filter((x) => !completed.has(x.date));
  const missedByDay = new Map<number, number>();
  for (const m of missed) missedByDay.set(m.plan.day_number, (missedByDay.get(m.plan.day_number) ?? 0) + 1);
  const worst = [...missedByDay.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const worstPlan = worst ? dayByNumber.get(worst[0]) : null;

  const completedCount = expected.filter((x) => completed.has(x.date)).length;
  const missedCount = missed.length;
  const skippedCount = skipped.length;
  const missedHeavy = missedCount >= 3 && missedCount >= Math.ceil(expected.length * 0.35);
  const skipHeavy = skippedCount >= 4;
  const weekdayPattern = worst && worst[1] >= 2 && worstPlan;
  const status: AdherenceRestructureRead["status"] = missedHeavy || skipHeavy ? "restructure" : weekdayPattern ? "watch" : "clear";
  if (status === "clear") return null;

  const actions: string[] = [];
  if (missedHeavy) actions.push("Reduce the next block by one training day and keep the removed day as optional recovery/accessory work.");
  if (skipHeavy) actions.push("Shorten the main sessions: keep the first 3-4 highest-leverage movements, then make accessories optional finishers.");
  if (weekdayPattern && worstPlan) actions.push(`Move or split ${worstPlan.name}; a recurring missed day wants a better slot or a 20-30 minute version.`);
  if (!actions.length) actions.push("Keep the template, but prepare one shorter fallback version for busy weeks.");

  const pattern = weekdayPattern && worstPlan
    ? `${worstPlan.name} is the session most often not landing.`
    : missedHeavy
      ? "Planned training days are recurring more often than they are landing cleanly."
      : "Exercises are being skipped often enough that the session shape is probably too long.";

  return {
    status,
    window_days: Math.max(14, windowDays),
    planned_sessions: expected.length,
    completed_sessions: completedCount,
    missed_planned_sessions: missedCount,
    skipped_exercises: skippedCount,
    pattern,
    adaptations: uniqueActions(actions),
  };
}

export function trainingPlaybook(date?: string, opts: TrainingPlaybookOpts = {}): TrainingPlaybookRead {
  const d = String(date || localDateISO()).slice(0, 10);
  const ps = opts.programState === undefined ? getProgramState(d) : opts.programState;
  const plays = plateauPlays(ps, d);
  const adherence = adherenceRead(d, opts.windowDays ?? 28);
  const adaptations = uniqueActions([
    ...plays.flatMap((p) => p.adaptations.slice(0, 1)),
    ...(adherence?.adaptations ?? []),
  ]);
  const labels = plays.map((p) => p.kind.replace(/_/g, " "));
  const headline = labels.length || adherence
    ? `${[...labels, adherence ? "adherence fit" : ""].filter(Boolean).map(cap).join("; ")} needs a plan suggestion, not an automatic change.`
    : "No plateau or adherence restructure signal is strong enough to change the plan right now.";
  return { generated_for: d, plateau_plays: plays, adherence, adaptations, headline };
}
