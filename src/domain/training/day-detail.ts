// THE DAY DETAIL — one calendar day of the training week, rich enough to open.
//
// Horizon's tap-a-day view and Today's "what's ahead" strip ask one question of a day:
// what is it for, what is in it, and where should the athlete pay attention. The
// answer is composed here from the reads that already own each fact — nothing is
// re-derived:
//   - the calendar: planWeek, the plan strip's own week. The week holding today is read
//     AS OF today and a later week as of its own Monday (lookAheadWeekAsOf, the rule
//     the look-ahead and the day record already share), so a tapped day opens on the
//     words its row showed. A past week is read as of its Sunday, its runs all closed.
//   - the lift: the plan day's own items in plan order; the load for a day still ahead
//     is the progression engine's next prescription (planDayProgression), a day already
//     lived keeps the plan's stored target, and a guess is never shown as a load. The
//     anchor is the day's first primary-tier compound (the weekly dose ledger's read).
//   - the run: the rolling agenda's intent dated on the day (planWeek's own matcher)
//     and the weekly run plan's prescription of that kind for the structure (warm-up,
//     the work, cool-down — the engine's own reps and distances), the athlete's zones
//     (runZones) and, with a dated race, the race build's pace bands.
//   - where to look: the training-symptom watches the day's movements load, the
//     movement's constraint note, a best set in the last seven days, the progression's
//     step on the anchor; and a heavy-leg day beside a quality or long run.
//   - why the day: the race build's rung for the week and the block's phase as the week
//     actually runs it (block-phase.ts).
//   - what was done: the day record (the session log and the activity feed).
//
// Changes nothing. Words, prescriptions and kilometres; no score, no gate. Every
// sentence that would repeat day after day rotates through pickDayVariant.
import type {
  DayDetail,
  DayDetailDone,
  DayDetailExercise,
  DayDetailLift,
  DayDetailLoad,
  DayDetailNeighbour,
  DayDetailRun,
  DayDetailRunDone,
  DayDetailRunSegment,
  DayDetailStack,
  DayDetailStatedQuality,
  DayDetailStatus,
  DayDetailWatch,
  DayDetailWeek,
  DayDetailZoneKey,
} from "../../contracts/day-detail.js";
import { addDaysISO, mondayOf } from "../../lib/dates.js";
import { round1 } from "../../lib/numbers.js";
import { activeBlockContext } from "../../repo/program-blocks.js";
import { resolvedBlockPhase } from "../../repo/block-phase.js";
import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import { flexibleTrainingAgenda, type FlexibleRunIntent } from "../../repo/flexible-training-agenda.js";
import { listContextEvents } from "../../repo/health.js";
import { getHrModel } from "../../repo/hr-model.js";
import { getPlan } from "../../repo/plan.js";
import { isoDow, WEEKDAY_NAMES } from "../../repo/profile.js";
import { planDayProgression, type Prescription } from "../../repo/progression.js";
import { paceKeyForQuality, raceBuild, type PaceBand, type RaceBuild } from "../../repo/race-build.js";
import { RUN_KIND_LABELS } from "../../repo/run-edit.js";
import { runZones, weeklyRunPlan, type RunPlanPrescription, type RunZones } from "../../repo/run-progression.js";
import { weekWins } from "../../repo/sessions.js";
import { getSettings } from "../../repo/settings.js";
import { localDateISO } from "../../repo/shared.js";
import { planDayStrengthGroups } from "../../repo/training-read.js";
import { trainingSymptomsForMovements } from "../../repo/training-symptoms.js";
import { dayRecord, dayRecordDate } from "../today/day-record.js";
import { isPrepPlanItem, PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "./plan-item-order.js";
import { lookAheadWeekAsOf } from "./plan-look-ahead.js";
import { planWeek, type PlanWeek, type PlanWeekDay } from "./plan-week.js";

export type { DayDetail } from "../../contracts/day-detail.js";

/** A valid YYYY-MM-DD, or null (the route answers 400 on null). */
export const dayDetailDate = dayRecordDate;

const KM_PER_MI = 1.609344;
/** The most attention notes a day carries; past that they stop being read. */
const MAX_WATCH = 5;

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function text(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveKm(value: unknown): number | null {
  const n = num(value);
  return n != null && n > 0 ? round1(n) : null;
}

function miOf(km: number | null): number | null {
  return km == null ? null : round1(km / KM_PER_MI);
}

function fmtKm(km: number): string {
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lower(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function shortWeekday(date: string): string {
  return (WEEKDAY_NAMES[isoDow(date)] ?? "").slice(0, 3);
}

function longWeekday(date: string): string {
  return WEEKDAY_NAMES[isoDow(date)] ?? date;
}

function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The as-of day a calendar day's week is read from. The week holding today reads as of
 * today and a later week as of its Monday (lookAheadWeekAsOf — the look-ahead's and the
 * day record's rule); a week already over reads as of its Sunday, every run closed.
 */
export function dayDetailWeekAsOf(date: string, today: string): string {
  const monday = mondayOf(date);
  if (monday < mondayOf(today)) return addDaysISO(monday, 6) ?? date;
  return lookAheadWeekAsOf(date, today);
}

/** The last day a detail is read for: the end of next week. Past it, nothing is forecast. */
export function dayDetailHorizon(today: string): string {
  return addDaysISO(mondayOf(today), 13) ?? today;
}

// ---------------------------------------------------------------------------
// Reading the calendar
// ---------------------------------------------------------------------------

type DayContext = {
  today: string;
  weeks: Map<string, PlanWeek | null>;
  heavyLower: Set<number>;
};

function weekFor(ctx: DayContext, date: string): PlanWeek | null {
  const asOf = dayDetailWeekAsOf(date, ctx.today);
  if (!ctx.weeks.has(asOf))
    ctx.weeks.set(
      asOf,
      safe(() => planWeek(asOf), null)
    );
  return ctx.weeks.get(asOf) ?? null;
}

function cellFor(ctx: DayContext, date: string): PlanWeekDay | null {
  return weekFor(ctx, date)?.days.find((d) => d.date === date) ?? null;
}

/** The strength plan day on a cell, or null (a run cell, a rest cell, an unplaced session). */
function strengthOf(cell: PlanWeekDay | null): NonNullable<PlanWeekDay["plan_day"]> | null {
  const plan = cell?.plan_day;
  return plan && plan.role === "strength" && plan.day_type !== "rest" ? plan : null;
}

/** A cell's run as the day's own: never a covered run that landed elsewhere, never a rested one. */
function ownRun(cell: PlanWeekDay | null): NonNullable<PlanWeekDay["run"]> | null {
  const run = cell?.run;
  if (!run || !cell?.date) return null;
  if (run.status === "completed" && run.completion_date && run.completion_date !== cell.date) return null;
  if (run.rested) return null;
  return run;
}

function keyRunKind(cell: PlanWeekDay | null): "quality" | "long" | null {
  const run = ownRun(cell);
  return run?.kind === "quality" || run?.kind === "long" ? run.kind : null;
}

// ---------------------------------------------------------------------------
// The lift
// ---------------------------------------------------------------------------

type PlanItem = Record<string, any>;

function planItemsFor(dayNumber: number): PlanItem[] {
  const day = safe(() => (getPlan() as any[]).find((d) => Number(d?.day_number) === dayNumber), null);
  return Array.isArray(day?.items) ? (day.items as PlanItem[]).filter((i) => i && i.kind !== "cardio") : [];
}

function isDrill(item: PlanItem): boolean {
  return String(item?.mode ?? "") === "mobility" || isPrepPlanItem(item);
}

/** The day's anchor: its first primary-tier compound (the weekly dose ledger's read). */
function anchorIndex(items: PlanItem[]): number {
  return items.findIndex((item) => !isDrill(item) && planItemEffectTier(item) === PLAN_ITEM_EFFECT_TIER.primary);
}

function loadText(weight: number | null): string {
  if (weight == null) return "bodyweight";
  const w = Math.abs(weight);
  const n = Number.isInteger(w) ? String(w) : w.toFixed(1);
  return weight < 0 ? `${n} lb assist` : `${n} lb`;
}

function prescriptionText(
  mode: DayDetailExercise["mode"],
  sets: number | null,
  repLow: number | null,
  repHigh: number | null,
  seconds: number | null
): string {
  const s = sets != null && sets > 0 ? `${sets} × ` : "";
  if (mode === "timed" || (seconds != null && repLow == null && repHigh == null)) {
    return seconds != null ? `${s}${seconds} s` : sets != null ? `${sets} sets` : "";
  }
  if (repLow != null && repHigh != null && repHigh !== repLow) return `${s}${repLow}–${repHigh}`;
  const reps = repLow ?? repHigh;
  if (reps != null) return `${s}${reps}`;
  return sets != null ? `${sets} sets` : "";
}

/**
 * The load a slot carries. A day still ahead reads the progression engine's next
 * prescription; a guess borrowed from a related lift (`starting_idea`) is never shown
 * as a load. A day already lived (or no progression row) keeps the plan's target.
 */
function loadOf(item: PlanItem, p: Prescription | undefined, mode: DayDetailExercise["mode"]): DayDetailLoad | null {
  if (mode === "mobility") return null;
  if (p && !p.starting_idea && p.suggested && "weight" in p.suggested && p.suggested.weight !== undefined) {
    const weight = num(p.suggested.weight);
    // A timed hold with no load is a hold, not a "bodyweight" load to print.
    if (weight == null && mode === "timed") return null;
    return {
      weight,
      text: loadText(weight),
      source: "progression",
      change: text(p.delta_text) || null,
      action: p.action ?? null,
    };
  }
  const planned = num(item.target_weight);
  if (planned == null) return null;
  return { weight: planned, text: loadText(planned), source: "plan", change: null, action: null };
}

function exerciseOf(item: PlanItem, p: Prescription | undefined, anchor: boolean): DayDetailExercise {
  const mode: DayDetailExercise["mode"] = isDrill(item)
    ? "mobility"
    : String(item.mode ?? "") === "timed" || (num(item.target_seconds) != null && num(item.rep_low) == null)
      ? "timed"
      : "reps";
  const s = p?.suggested;
  const sets = num(s?.sets) ?? num(item.sets);
  const repLow = mode === "timed" ? null : (num(s?.rep_low) ?? num(item.rep_low));
  const repHigh = mode === "timed" ? null : (num(s?.rep_high) ?? num(item.rep_high));
  const seconds = mode === "reps" ? null : (num(s?.seconds) ?? num(item.target_seconds));
  return {
    name: text(item.exercise),
    muscle_group: text(item.muscle_group) || null,
    mode,
    sets,
    rep_low: repLow,
    rep_high: repHigh,
    target_seconds: seconds,
    prescription: prescriptionText(mode, sets, repLow, repHigh, seconds),
    load: loadOf(item, p, mode),
    anchor,
    note: text(item.note) || text(item.constraint_note) || null,
  };
}

const LIFT_INTENT_LEAD: readonly ((anchor: string, rest: string) => string)[] = [
  (anchor, rest) => `${anchor} leads${rest ? `, then ${rest}` : ""}.`,
  (anchor, rest) => `Built around ${anchor}${rest ? `, with ${rest} after it` : ""}.`,
  (anchor, rest) => `${anchor} first, while you are freshest${rest ? `; ${rest} follow` : ""}.`,
];

function liftIntent(date: string, exercises: DayDetailExercise[], anchor: DayDetailExercise | null): string {
  const work = exercises.filter((e) => e.mode !== "mobility");
  if (!work.length) return "Mobility and prep work only.";
  const lead = anchor ?? work[0];
  const leadWords = `${lead.name} (${[
    lead.prescription,
    lead.load && lead.load.weight != null ? `at ${lead.load.text}` : "",
  ]
    .filter(Boolean)
    .join(" ")})`;
  const others = work.filter((e) => e !== lead).map((e) => e.name);
  const named = others.slice(0, 2);
  const more = others.length - named.length;
  const rest = named.length ? `${listWords(named)}${more > 0 ? ` and ${more} more` : ""}` : "";
  return pickDayVariant(LIFT_INTENT_LEAD, date, "day-detail:lift-intent")(leadWords, rest);
}

const POINT_OVERLOAD: readonly ((anchor: string, step: string) => string)[] = [
  (anchor, step) => `Take ${anchor} up a step (${step}) and keep the rest of the day where it is.`,
  (anchor, step) => `The step is on ${anchor} (${step}); everything else holds its numbers.`,
  (anchor, step) => `${anchor} moves on (${step}) — earn it with clean reps, the rest stays steady.`,
];
const POINT_HOLD: readonly ((anchor: string, load: string) => string)[] = [
  (anchor, load) => `Own ${anchor}${load ? ` at ${load}` : ""} — clean, repeatable reps before the next step.`,
  (anchor, load) => `${anchor} holds${load ? ` at ${load}` : ""}: make the reps look the same from first set to last.`,
  (anchor, load) =>
    `Consolidate ${anchor}${load ? ` at ${load}` : ""}; the next step comes once these sets feel settled.`,
];
const POINT_DELOAD: readonly ((anchor: string) => string)[] = [
  (anchor) => `A lighter ${anchor} on purpose — let the last weeks of work settle in.`,
  (anchor) => `${anchor} eases back this time, so the next build starts fresh.`,
];
const POINT_PHASE: Record<string, readonly string[]> = {
  accumulation: [
    "Volume is the job this block: quality sets, a rep or two in the tank.",
    "This block builds work capacity — steady sets, nothing ground out.",
  ],
  intensification: [
    "The block is sharpening: heavier, fewer, every rep crisp.",
    "Intensity is the job this block — fewer reps, more intent behind each.",
  ],
  deload: [
    "A lighter week by design: move well and leave fresher than you came.",
    "The block's easy week — lighter loads, same movements, no grinding.",
  ],
  realization: [
    "The block's top end: show what the weeks built, then stop.",
    "Realization week — a few heavy, clean sets that show the work.",
  ],
};
const POINT_PLAIN: readonly ((what: string) => string)[] = [
  (what) => `${cap(what)} work — steady sets, form first.`,
  (what) => `Keep ${lower(what)} moving forward: good reps, nothing ground out.`,
];

function liftPoint(
  date: string,
  anchor: DayDetailExercise | null,
  p: Prescription | undefined,
  phase: string | null,
  what: string
): string {
  const parts: string[] = [];
  if (anchor && p && !p.starting_idea) {
    if (p.action === "overload" && text(p.delta_text))
      parts.push(pickDayVariant(POINT_OVERLOAD, date, "day-detail:point:overload")(anchor.name, text(p.delta_text)));
    else if (p.action === "deload")
      parts.push(pickDayVariant(POINT_DELOAD, date, "day-detail:point:deload")(anchor.name));
    else if (p.action === "hold" || p.action === "overload")
      parts.push(
        pickDayVariant(
          POINT_HOLD,
          date,
          "day-detail:point:hold"
        )(anchor.name, anchor.load && anchor.load.weight != null ? anchor.load.text : "")
      );
  }
  const phaseLines = phase ? POINT_PHASE[phase] : null;
  if (phaseLines) parts.push(pickDayVariant(phaseLines, date, `day-detail:point:phase:${phase}`));
  if (!parts.length) parts.push(pickDayVariant(POINT_PLAIN, date, "day-detail:point:plain")(what));
  return parts.join(" ");
}

function liftWatch(
  date: string,
  readOn: string,
  exercises: DayDetailExercise[],
  byName: Map<string, Prescription>,
  constraints: Map<string, string>
): DayDetailWatch[] {
  const out: DayDetailWatch[] = [];
  const names = exercises.filter((e) => e.mode !== "mobility").map((e) => e.name);
  // A training-symptom watch the day's movements load — the athlete's own words, never re-diagnosed.
  const symptoms = safe(() => trainingSymptomsForMovements(date, names, { seed_legacy: false }), []);
  for (const s of symptoms) {
    const moves = s.relevant_movements ?? [];
    const area = text(s.area_text);
    if (!area || !moves.length) continue;
    out.push({
      kind: "symptom",
      exercise: moves[0] ?? null,
      text: `${cap(area)} is still on watch — ${listWords(moves.slice(0, 3))} ${moves.length === 1 ? "loads" : "load"} it. Let pain-free range set the depth and the load.`,
    });
  }
  // The movement's own constraint note (the injury note the exercise already carries).
  for (const e of exercises) {
    const note = constraints.get(e.name.toLowerCase());
    if (note) out.push({ kind: "constraint", exercise: e.name, text: `${e.name}: ${note}` });
  }
  // A best set in the last seven days on one of the day's lifts: build on it, don't chase it.
  // Two at most, the anchor's first: a wall of bests stops being something to look at.
  const anchorName = exercises.find((e) => e.anchor)?.name.toLowerCase() ?? null;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const prs = safe(() => weekWins(readOn).prs, [] as { exercise: string; label: string }[])
    .filter((pr) => wanted.has(String(pr.exercise).toLowerCase()))
    .sort(
      (a, b) =>
        Number(String(b.exercise).toLowerCase() === anchorName) -
        Number(String(a.exercise).toLowerCase() === anchorName)
    )
    .slice(0, 2);
  for (const pr of prs) {
    out.push({
      kind: "recent_best",
      exercise: pr.exercise,
      text: `${pr.exercise}: ${text(pr.label).replace(/\s*—\s*new best$/i, "")} was a new best this past week — build on it rather than chasing it again.`,
    });
  }
  // The progression's own words where a slot changes shape or is new.
  for (const e of exercises) {
    const p = byName.get(e.name.toLowerCase());
    if (!p) continue;
    if (p.untested) {
      out.push({
        kind: "untested",
        exercise: e.name,
        text: `${e.name}'s prescription is new — the first session at it sets the baseline, so stop with a rep or two in hand.`,
      });
    } else if (p.action === "deload" || p.action === "vary" || p.set_step || p.escalated) {
      const why = text(p.why);
      if (why) out.push({ kind: "progression", exercise: e.name, text: `${e.name}: ${why}` });
    }
  }
  return out;
}

function buildLift(
  date: string,
  status: DayDetailStatus,
  cell: PlanWeekDay | null,
  ctx: DayContext,
  done: DayDetailDone | null,
  phase: string | null,
  todayLine: PlanWeek["strength_line"] | null
): { lift: DayDetailLift; watch: DayDetailWatch[] } | null {
  const plan = strengthOf(cell);
  const session = done?.session ?? null;
  const title = text(plan?.name) || text(session?.title);
  if (!title) return null;

  const items = plan ? planItemsFor(plan.day_number) : [];
  // The engine's next prescription is a day AHEAD's load; a day already lived keeps the
  // plan's stored target (the progression has already moved on to the next exposure).
  const ahead = status === "today" || status === "upcoming";
  const progression =
    plan && ahead ? safe(() => planDayProgression(plan.day_number, { readDate: date }), [] as Prescription[]) : [];
  const byItem = new Map<number, Prescription>();
  const byName = new Map<string, Prescription>();
  for (const p of progression) {
    if (p.plan_item_id != null) byItem.set(Number(p.plan_item_id), p);
    byName.set(String(p.exercise).toLowerCase(), p);
  }
  const anchorAt = anchorIndex(items);
  const exercises = items
    .map((item, i) =>
      exerciseOf(item, byItem.get(Number(item.id)) ?? byName.get(text(item.exercise).toLowerCase()), i === anchorAt)
    )
    .filter((e) => e.name);
  const anchor = exercises.find((e) => e.anchor) ?? null;
  const anchorP = anchor ? byName.get(anchor.name.toLowerCase()) : undefined;
  const totalSets = exercises.filter((e) => e.mode !== "mobility").reduce((n, e) => n + (e.sets ?? 0), 0);
  const what = text(plan?.focus) || title;

  const isToday = date === ctx.today;
  const suggestion =
    isToday && cell?.suggestion
      ? { kind: cell.suggestion.kind, label: cell.suggestion.label, caveat: cell.suggestion.caveat }
      : null;

  const lift: DayDetailLift = {
    day_number: plan?.day_number ?? null,
    title,
    focus: text(plan?.focus) || null,
    intent: plan ? liftIntent(date, exercises, anchor) : "A session off the plan — what was lifted is below.",
    point: plan ? liftPoint(date, anchor, anchorP, phase, what) : "The log is the record of this one.",
    anchor: anchor?.name ?? null,
    exercises,
    total_sets: totalSets,
    heavy_lower: plan ? ctx.heavyLower.has(plan.day_number) : false,
    today_line: isToday ? text(todayLine?.text) || null : null,
    suggestion,
  };
  const constraints = new Map<string, string>();
  for (const item of items) {
    const note = text(item.constraint_note);
    if (note && text(item.exercise)) constraints.set(text(item.exercise).toLowerCase(), note);
  }
  // Attention belongs to a day still to come; a lived day's record speaks for itself.
  const watch =
    plan && (status === "today" || status === "upcoming")
      ? liftWatch(date, date <= ctx.today ? date : ctx.today, exercises, byName, constraints)
      : [];
  return { lift, watch };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type QualityType = "tempo" | "threshold" | "vo2" | "hills";

function qualityTypeOf(label: string): QualityType | null {
  if (/hill/i.test(label)) return "hills";
  const key = paceKeyForQuality(label);
  if (key === "threshold") return "threshold";
  if (key === "vo2") return "vo2";
  if (key === "tempo") return "tempo";
  return null;
}

const QUALITY_ZONE: Record<QualityType, DayDetailZoneKey> = { tempo: "Z3", threshold: "Z4", vo2: "Z5", hills: "Z4" };
const QUALITY_MAIN_LABEL: Record<QualityType, string> = {
  tempo: "Tempo",
  threshold: "Threshold",
  vo2: "VO2 intervals",
  hills: "Hill repeats",
};
const QUALITY_EFFORT_WORD: Record<QualityType, string> = {
  tempo: "tempo",
  threshold: "threshold",
  vo2: "a hard, controlled effort",
  hills: "a hard uphill effort",
};

function zoneKeyOf(value: unknown): DayDetailZoneKey | null {
  const m = String(value ?? "").match(/\bZ([1-5])\b/i);
  return m ? (`Z${m[1]}` as DayDetailZoneKey) : null;
}

/** "1km" → 1, "800m" → 0.8; a timed or uphill rep has no distance. */
function repKm(on: string): number | null {
  const m = String(on).match(/^\s*(\d+(?:\.\d+)?)\s*(km|k|m)\b\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === "m" ? n / 1000 : n;
}

/** The engine's rep words with a space before the unit: "1km" → "1 km", "45s uphill" → "45 s uphill". */
function spaced(words: string): string {
  return text(words).replace(/^(\d+(?:\.\d+)?)(km|m|s|min)\b/i, "$1 $2");
}

function hrBand(zones: RunZones | null, key: DayDetailZoneKey | null): { low_bpm: number; high_bpm: number } | null {
  if (!zones?.available || !key) return null;
  const z = zones.zones.find((b) => b.zone === key);
  return z ? { low_bpm: z.low_bpm, high_bpm: z.high_bpm } : null;
}

function paceOf(band: PaceBand | null | undefined): DayDetailRunSegment["pace"] {
  return band
    ? { text: band.text, slow_sec_per_km: band.slow_sec_per_km, fast_sec_per_km: band.fast_sec_per_km }
    : null;
}

function segment(
  part: DayDetailRunSegment["part"],
  label: string,
  line: string,
  km: number | null,
  zone: DayDetailZoneKey | null,
  zones: RunZones | null,
  band: PaceBand | null | undefined,
  rep: { reps: number | null; on: string | null; off: string | null } = { reps: null, on: null, off: null }
): DayDetailRunSegment {
  return {
    part,
    label,
    text: line,
    km,
    mi: miOf(km),
    reps: rep.reps,
    on: rep.on,
    off: rep.off,
    zone,
    hr: hrBand(zones, zone),
    pace: paceOf(band),
  };
}

/**
 * The run's parts. Quality work reads warm-up → the work → cool-down, sized from the
 * engine's own numbers: the work is its reps × rep distance, and whatever the run's
 * distance holds beyond it splits either side. A run the engine does not size beyond
 * its total (a tempo, a timed rep) keeps the parts in words with no invented km.
 */
export function dayDetailRunStructure(
  kind: DayDetailRun["kind"],
  km: number | null,
  rx: RunPlanPrescription | null,
  label: string,
  race: boolean,
  short: boolean,
  zones: RunZones | null,
  bands: PaceBand[]
): DayDetailRunSegment[] {
  const band = (key: string) => bands.find((b) => b.key === key) ?? null;
  const easyBand = band("easy");
  if (race) {
    return [
      segment("main", "Race", km != null ? `${fmtKm(km)} km at race pace` : "Race pace", km, null, zones, band("race")),
    ];
  }
  if (kind === "easy") {
    return [
      segment(
        "main",
        "Easy",
        km != null ? `${fmtKm(km)} km easy and conversational` : "Easy and conversational",
        km,
        "Z2",
        zones,
        easyBand
      ),
    ];
  }
  if (kind === "long") {
    return [
      segment(
        "main",
        "Long run",
        km != null ? `${fmtKm(km)} km steady and easy throughout` : "Steady and easy throughout",
        km,
        "Z2",
        zones,
        band("long")
      ),
    ];
  }
  // The athlete's STATED session carries its own parts in km (run-progression.ts
  // statedQualitySession): warm-up → the work → cool-down, never re-derived here.
  const sq = rx?.stated_quality ?? null;
  if (sq) {
    const statedType = sq.type as QualityType;
    const statedZone = (zoneKeyOf(rx?.interval?.[0]?.zone) ?? QUALITY_ZONE[statedType]) as DayDetailZoneKey;
    const statedBand = statedType === "hills" ? null : band(statedType === "vo2" ? "vo2" : statedType);
    const siv = Array.isArray(rx?.interval) ? rx.interval[0] : null;
    const reps = siv && Number(siv.reps) > 0 ? Number(siv.reps) : null;
    const effort = QUALITY_EFFORT_WORD[statedType];
    const mainLine =
      sq.form === "continuous"
        ? `${fmtKm(sq.work_km)} km continuous at ${effort}`
        : reps && siv
          ? `${reps} × ${spaced(siv.on)} at ${effort}${text(siv.off) ? `, ${spaced(text(siv.off))} between` : ""}${
              statedType === "hills" ? ` (about ${fmtKm(sq.work_km)} km with the jogs)` : ` (${fmtKm(sq.work_km)} km of work)`
            }`
          : `${fmtKm(sq.work_km)} km at ${effort}`;
    return [
      segment("warm_up", "Warm-up", `${fmtKm(sq.warm_up_km)} km easy`, sq.warm_up_km, "Z2", zones, easyBand),
      segment(
        "main",
        QUALITY_MAIN_LABEL[statedType],
        mainLine,
        sq.work_km,
        statedZone,
        zones,
        statedBand,
        reps && siv ? { reps, on: text(siv.on), off: text(siv.off) || null } : undefined
      ),
      segment("cool_down", "Cool-down", `${fmtKm(sq.cool_down_km)} km easy`, sq.cool_down_km, "Z2", zones, easyBand),
    ];
  }
  const type = qualityTypeOf(rx?.label ?? label) ?? "tempo";
  const iv = Array.isArray(rx?.interval) ? rx.interval[0] : null;
  const zone = (zoneKeyOf(iv?.zone) ?? QUALITY_ZONE[type]) as DayDetailZoneKey;
  const workBand = type === "hills" ? null : band(type === "vo2" ? "vo2" : type);
  if (iv && Number(iv.reps) > 0) {
    const reps = Number(iv.reps);
    const per = repKm(iv.on);
    const workKm = per != null ? round1(reps * per) : null;
    const around = km != null && workKm != null ? round1((km - workKm) / 2) : null;
    const aroundKm = around != null && around >= 0.5 ? around : null;
    const off = text(iv.off);
    const main = `${reps} × ${spaced(iv.on)} at ${QUALITY_EFFORT_WORD[type]}${off ? `, ${spaced(off)} between` : ""}${
      workKm != null && reps > 1 ? ` (${fmtKm(workKm)} km of ${type === "threshold" ? "threshold" : "hard"} work)` : ""
    }`;
    return [
      segment(
        "warm_up",
        "Warm-up",
        aroundKm != null ? `${fmtKm(aroundKm)} km easy` : "Easy running until loose",
        aroundKm,
        "Z2",
        zones,
        easyBand
      ),
      segment("main", QUALITY_MAIN_LABEL[type], main, workKm, zone, zones, workBand, {
        reps,
        on: text(iv.on),
        off: off || null,
      }),
      segment(
        "cool_down",
        "Cool-down",
        aroundKm != null ? `${fmtKm(aroundKm)} km easy` : "Easy running to finish",
        aroundKm,
        "Z2",
        zones,
        easyBand
      ),
    ];
  }
  // A continuous tempo: the engine sizes the run, not the block inside it.
  return [
    segment("warm_up", "Warm-up", "Easy running until loose", null, "Z2", zones, easyBand),
    segment(
      "main",
      QUALITY_MAIN_LABEL[type],
      short ? "About 10 minutes at tempo" : "A continuous block at tempo, comfortably hard",
      null,
      zone,
      zones,
      workBand
    ),
    segment("cool_down", "Cool-down", "Easy running to finish", null, "Z2", zones, easyBand),
  ];
}

const RUN_POINT: Record<string, readonly string[]> = {
  easy: [
    "Aerobic volume and nothing more — conversational the whole way.",
    "Easy miles build the engine; if you can't talk in full sentences, slow down.",
    "Time at an easy pace is the work here — keep it relaxed.",
  ],
  long: [
    "Time on feet: even, easy and patient — the distance is the work.",
    "The long run builds durability; start slower than feels necessary and stay there.",
    "Steady and easy throughout — finish feeling you could have gone on.",
  ],
  threshold: [
    "Raise the pace you can hold: threshold is controlled-hard, never a race.",
    "Threshold work lifts what you can sustain — even reps, the last one like the first.",
  ],
  tempo: [
    "Comfortably hard and sustained — the pace you could hold for about an hour.",
    "Tempo teaches the body to hold a strong pace calmly; settle in, don't surge.",
  ],
  vo2: [
    "Top-end work: short hard reps with full recoveries — quality over quantity.",
    "VO2 reps stretch the ceiling; run them hard but even, never all-out.",
  ],
  hills: [
    "Strength and economy uphill — effort, not pace, and easy on the way down.",
    "Hill reps build power without the pounding; drive the arms, jog back down.",
  ],
  race: ["The run this whole build was for — settle in early and run your own race."],
};
const SHORT_QUALITY_TAIL = "A short set inside a lighter week — that morning decides whether it runs.";

function runPoint(date: string, kind: DayDetailRun["kind"], label: string, race: boolean, short: boolean): string {
  const key = race ? "race" : kind === "quality" ? (qualityTypeOf(label) ?? "tempo") : kind;
  const line = pickDayVariant(RUN_POINT[key] ?? RUN_POINT.easy, date, `day-detail:run-point:${key}`);
  return short ? `${line} ${SHORT_QUALITY_TAIL}` : line;
}

/** The agenda intent dated on the day — planWeek's own matcher: a completion, else an open suggestion. */
function intentOn(intents: FlexibleRunIntent[], date: string): FlexibleRunIntent | null {
  return (
    intents.find((i) => i.completion?.date && String(i.completion.date) === date) ??
    intents.find((i) => i.status === "open" && i.suggested_date && String(i.suggested_date) === date) ??
    null
  );
}

function prescriptionFor(plan: ReturnType<typeof weeklyRunPlan> | null, kind: string): RunPlanPrescription | null {
  const runs = Array.isArray(plan?.runs) ? plan.runs : [];
  return runs.find((r) => r.kind_label === kind) ?? null;
}

const STATED_POINT_TAIL: readonly string[] = [
  "It's the session you chose for this day.",
  "Your own quality session, as you set it.",
  "The session is yours — the engine only sized it to the week.",
];

/** The run's point, with the stated session named and a hold below it said. */
function statedPoint(date: string, kind: DayDetailRun["kind"], rx: RunPlanPrescription | null, point: string): string {
  const sq = kind === "quality" ? rx?.stated_quality : null;
  if (!sq) return point;
  const tail = sq.held?.line ?? pickDayVariant(STATED_POINT_TAIL, date, "day-detail:run-point:stated");
  return `${point} ${tail}`;
}

/** The athlete's stated session as the day carries it (contract: DayDetailStatedQuality). */
function statedOf(rx: RunPlanPrescription | null): DayDetailStatedQuality | null {
  const sq = rx?.stated_quality;
  if (!sq) return null;
  return {
    source: "stated",
    type: sq.type,
    form: sq.form,
    warm_up_km: sq.warm_up_km,
    work_km: sq.work_km,
    cool_down_km: sq.cool_down_km,
    total_km: sq.total_km,
    stated_work_km: sq.stated_work_km,
    warm_cool_default: sq.warm_cool_default,
    dose: sq.dose,
    held: sq.held?.line ?? null,
  };
}

function buildRun(
  date: string,
  cell: PlanWeekDay | null,
  asOf: string,
  runUnits: "km" | "mi",
  build: RaceBuild | null
): DayDetailRun | null {
  const cellRun = ownRun(cell);
  if (!cellRun || cellRun.kind === "logged") return null;
  const agenda = safe(() => flexibleTrainingAgenda(asOf), null);
  const intent = agenda?.available ? intentOn(agenda.intents ?? [], date) : null;
  const kind = (intent?.kind ?? cellRun.kind) as DayDetailRun["kind"];
  if (kind !== "easy" && kind !== "quality" && kind !== "long") return null;
  const plan = safe(() => weeklyRunPlan(asOf), null);
  const rx = prescriptionFor(plan, kind);
  const race = !!(kind === "long" && rx?.race);
  const short = kind === "quality" && rx?.dose === "short";
  const completedEv = intent?.status === "completed" ? intent.completion : null;
  const label = text(intent?.label) || text(cellRun.label) || RUN_KIND_LABELS[kind] || "Run";
  const km = completedEv ? positiveKm(completedEv.distance_km) : positiveKm(intent?.target_distance_km ?? cellRun.km);
  const plannedKm = positiveKm(intent?.target_distance_km) ?? positiveKm(rx?.target_distance_km) ?? km;

  // The model the week's plan read (getHrModel at the week's as-of day), so a band here
  // is the band in the engine's own zone tag — never two bpm ranges for one "easy".
  const zones = safe(() => runZones({ model: safe(() => getHrModel(asOf), null) }), null);
  const zoneKey: DayDetailZoneKey | null = race
    ? null
    : kind === "quality"
      ? (zoneKeyOf(Array.isArray(rx?.interval) ? rx.interval[0]?.zone : null) ??
        QUALITY_ZONE[qualityTypeOf(rx?.label ?? label) ?? "tempo"])
      : "Z2";
  const z = zones?.available && zoneKey ? zones.zones.find((b) => b.zone === zoneKey) : null;
  const zoneText = text(intent?.target_zone ?? rx?.target_zone) || null;
  const bands = build?.paces?.bands ?? [];
  const paceKey = race
    ? "race"
    : kind === "easy"
      ? "easy"
      : kind === "long"
        ? "long"
        : paceKeyForQuality(rx?.label ?? label);
  const band = paceKey ? (bands.find((b) => b.key === paceKey) ?? null) : null;

  const completed: DayDetailRunDone | null = completedEv
    ? {
        km: positiveKm(completedEv.distance_km),
        mi: miOf(positiveKm(completedEv.distance_km)),
        duration_min: num(completedEv.duration_min),
        pace_sec_per_km: num(completedEv.pace_sec_per_km),
        avg_hr: num(completedEv.avg_hr),
        effort: completedEv.intensity_word ?? null,
        title: text(completedEv.title) || null,
      }
    : null;

  return {
    kind,
    label,
    status: completedEv ? "completed" : "open",
    km,
    mi: miOf(km),
    run_units: runUnits,
    zone:
      zoneKey || zoneText
        ? {
            key: zoneKey,
            label: z?.label ?? null,
            low_bpm: z?.low_bpm ?? null,
            high_bpm: z?.high_bpm ?? null,
            feel: z?.feel ?? null,
            text: zoneText,
          }
        : null,
    pace: band
      ? {
          key: band.key,
          label: band.label,
          text: band.text,
          slow_sec_per_km: band.slow_sec_per_km,
          fast_sec_per_km: band.fast_sec_per_km,
        }
      : null,
    hr_ceiling_bpm: kind === "quality" ? null : (num(band?.hr_ceiling_bpm) ?? null),
    structure: dayDetailRunStructure(kind, plannedKm, rx, label, race, short, zones, bands),
    stated: kind === "quality" ? statedOf(rx) : null,
    session: text(rx?.note) || null,
    short,
    race,
    adjusted: intent?.adjustment?.changed ? text(intent.adjustment.why) || null : null,
    point: statedPoint(date, kind, rx, runPoint(date, kind, rx?.label ?? label, race, short && !rx?.stated_quality?.held)),
    completed,
  };
}

// ---------------------------------------------------------------------------
// The week, the stack, the day's words
// ---------------------------------------------------------------------------

const RACE_WEEK_WORD: Record<string, string> = {
  build: "Build week",
  down: "Lighter week",
  peak: "Peak week",
  taper: "Taper week",
  race: "Race week",
};

const PHASE_WORD: Record<string, string> = {
  accumulation: "a loading week",
  intensification: "a sharpening week",
  deload: "the lighter week",
  realization: "the top-end week",
};

function weekOf(date: string, today: string, build: RaceBuild | null): DayDetailWeek {
  const weekStart = mondayOf(date);
  const rung = build?.available ? (build.weeks ?? []).find((w) => w.week_start === weekStart) : null;
  const race =
    rung && RACE_WEEK_WORD[rung.kind]
      ? {
          event: build?.race?.event ?? null,
          kind: rung.kind,
          word: RACE_WEEK_WORD[rung.kind],
          focus: text(rung.focus),
          weeks_to_race: rung.weeks_to_race,
        }
      : null;
  // The block's week as the week actually runs it. A later week is the block's next
  // week, read only while the block still has one.
  const ctx = safe(() => activeBlockContext(today), null);
  const offset = Math.round(
    (Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${mondayOf(today)}T00:00:00Z`)) / (7 * 864e5)
  );
  let block: DayDetailWeek["block"] = null;
  if (ctx && offset === 0) {
    const phase = safe(() => resolvedBlockPhase(date), null) ?? ctx.phase;
    block = { phase, focus: ctx.focus, week_index: ctx.week_index, total_weeks: ctx.total_weeks };
  } else if (ctx && offset > 0 && ctx.week_index + offset <= ctx.total_weeks) {
    const phase = safe(() => resolvedBlockPhase(date), null);
    if (phase) block = { phase, focus: ctx.focus, week_index: ctx.week_index + offset, total_weeks: ctx.total_weeks };
  }
  return { week_start: weekStart, race, block };
}

const WHY_RUN_RACE: readonly ((
  word: string,
  focus: string,
  toGo: string,
  event: string,
  weeks: number,
  raceWeek: boolean
) => string)[] = [
  (word, focus, toGo) => `${word}${toGo}. ${focus}`,
  (word, focus, _toGo, event, weeks, raceWeek) =>
    raceWeek
      ? `${focus} ${cap(event)} is this week.`
      : `${focus} ${cap(event)} is ${weeks} ${weeks === 1 ? "week" : "weeks"} out — ${lower(word)}.`,
];

const ORDINAL_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"];
const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven"];
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function whyLine(
  date: string,
  asOf: string,
  week: DayDetailWeek,
  lift: DayDetailLift | null,
  run: DayDetailRun | null,
  covered: string | null,
  build: RaceBuild | null,
  liftSlot: { index: number; of: number } | null
): string | null {
  const parts: string[] = [];
  const race = week.race;
  if (race && (run || lift)) {
    const event = race.event || "the race";
    const toGo =
      race.kind === "race"
        ? race.event
          ? `, ${race.event}`
          : ""
        : ` · ${race.weeks_to_race} ${race.weeks_to_race === 1 ? "week" : "weeks"} to ${event}`;
    if (run && race.focus) {
      parts.push(
        pickDayVariant(WHY_RUN_RACE, date, "day-detail:why:race")(
          race.word,
          race.focus,
          toGo,
          event,
          race.weeks_to_race,
          race.kind === "race"
        )
      );
    } else if (lift) {
      // The rung's lifting sentence only when it is about THIS day (it names the weekday or the lift).
      const rung = build?.weeks?.find((w) => w.week_start === week.week_start);
      const withLifting = text(rung?.with_lifting);
      const aboutToday = withLifting && (withLifting.includes(longWeekday(date)) || withLifting.includes(lift.title));
      parts.push(aboutToday ? `${race.word}${toGo}. ${withLifting}` : `${race.word}${toGo}.`);
    }
  }
  if (lift && week.block) {
    const b = week.block;
    parts.push(
      `Week ${b.week_index} of ${b.total_weeks} of the ${b.focus.replace(/-/g, " ")} block — ${PHASE_WORD[b.phase] ?? "the block's week"}.`
    );
  } else if (lift && !race && liftSlot && liftSlot.of > 1) {
    // No block and no race to tie it to: where the day sits in the lifting week.
    parts.push(
      `The ${ORDINAL_WORDS[liftSlot.index] ?? `${liftSlot.index + 1}th`} of ${countWord(liftSlot.of)} lifting days this week.`
    );
  }
  if (run && !race) {
    // The run engine's own headline for the week ("~20 km this week: 3 easy + 1 long").
    const sentence = text(safe(() => weeklyRunPlan(asOf)?.why, ""));
    if (sentence) parts.push(sentence);
  }
  if (covered) parts.push(covered);
  return parts.length ? parts.join(" ") : null;
}

const STACK_NEXT_DAY: readonly ((run: string, day: string) => string)[] = [
  (run, day) =>
    `${day} brings the ${runNoun(run)}; keep today's leg work a rep or two shy of a grind so the legs arrive fresh.`,
  (run, day) => `With the ${runNoun(run)} on ${day}, leave the last leg sets with reps in hand.`,
];
const STACK_DAY_AFTER: readonly ((run: string, day: string) => string)[] = [
  (run, day) =>
    `${day}'s ${runNoun(run)} may still be in the legs — let the first working set tell you how heavy to go.`,
  (run, day) =>
    `The legs come off ${day}'s ${runNoun(run)}; warm up a little longer and let the load follow how they feel.`,
];
const STACK_SAME_DAY: readonly ((lift: string, run: string) => string)[] = [
  (lift, run) =>
    `${lift} and the ${runNoun(run)} share the day — put as much space between them as you can, and run first if the run matters more.`,
  (lift, run) => `The legs carry both ${lift} and the ${runNoun(run)} today; split them across the day if you can.`,
];
const STACK_RUN_AFTER_LIFT: readonly ((lift: string, day: string) => string)[] = [
  (lift, day) =>
    `The legs come off ${day}'s ${lift} — if they feel heavy in the warm-up, settle into the effort rather than forcing the pace.`,
  (lift, day) => `${day}'s ${lift} will still be in the legs; run by feel early and let the pace come to you.`,
];
const STACK_RUN_BEFORE_LIFT: readonly ((lift: string, day: string) => string)[] = [
  (lift, day) => `${day}'s ${lift} follows — finish this run with something left.`,
  (lift, day) => `${lift} comes ${day}; keep this one controlled so the legs have something for it.`,
];

function stackOf(
  date: string,
  ctx: DayContext,
  cell: PlanWeekDay | null,
  lift: DayDetailLift | null,
  run: DayDetailRun | null
): DayDetailStack | null {
  const prevDate = addDaysISO(date, -1);
  const nextDate = addDaysISO(date, 1);
  const prev = prevDate ? cellFor(ctx, prevDate) : null;
  const next = nextDate ? cellFor(ctx, nextDate) : null;
  const heavy = (c: PlanWeekDay | null) => {
    const plan = strengthOf(c);
    return plan && ctx.heavyLower.has(plan.day_number) ? plan : null;
  };
  const runWords = (c: PlanWeekDay | null) => {
    const r = ownRun(c);
    return r ? text(r.label) || RUN_KIND_LABELS[r.kind] || "Run" : "Run";
  };
  const neighbour = (c: PlanWeekDay, what: string, kind: DayDetailNeighbour["kind"]): DayDetailNeighbour => ({
    date: String(c.date),
    weekday: shortWeekday(String(c.date)),
    what,
    kind,
  });

  const key = keyRunKind(cell);
  const keyRun = run && (run.kind === "quality" || run.kind === "long") ? run : null;
  if (lift?.heavy_lower && keyRun && key) {
    return {
      text: pickDayVariant(STACK_SAME_DAY, date, "day-detail:stack:same")(lift.title, keyRun.label),
      neighbours: [],
    };
  }
  if (lift?.heavy_lower) {
    const nextKey = keyRunKind(next);
    if (next && nextKey) {
      const words = runWords(next);
      return {
        text: pickDayVariant(STACK_NEXT_DAY, date, "day-detail:stack:next")(words, longWeekday(String(next.date))),
        neighbours: [neighbour(next, words, nextKey === "quality" ? "quality_run" : "long_run")],
      };
    }
    const prevKey = keyRunKind(prev);
    if (prev && prevKey) {
      const words = runWords(prev);
      return {
        text: pickDayVariant(STACK_DAY_AFTER, date, "day-detail:stack:after")(words, longWeekday(String(prev.date))),
        neighbours: [neighbour(prev, words, prevKey === "quality" ? "quality_run" : "long_run")],
      };
    }
  }
  if (keyRun) {
    const before = heavy(prev);
    if (prev && before) {
      return {
        text: pickDayVariant(
          STACK_RUN_AFTER_LIFT,
          date,
          "day-detail:stack:run-after"
        )(before.name, longWeekday(String(prev.date))),
        neighbours: [neighbour(prev, before.name, "heavy_lower")],
      };
    }
    const after = heavy(next);
    if (next && after) {
      return {
        text: pickDayVariant(
          STACK_RUN_BEFORE_LIFT,
          date,
          "day-detail:stack:run-before"
        )(after.name, longWeekday(String(next.date))),
        neighbours: [neighbour(next, after.name, "heavy_lower")],
      };
    }
  }
  return null;
}

function focusLine(lift: DayDetailLift | null, run: DayDetailRun | null, status: DayDetailStatus): string {
  const parts = [lift?.title, run?.label].filter((s): s is string => !!s);
  if (parts.length) return parts.join(" · ");
  return status === "done" ? "Logged" : "Rest";
}

/** A run label inside a sentence: a leading acronym keeps its case ("VO2 intervals"). */
function runNoun(label: string): string {
  return /^[A-Z0-9]{2,}/.test(label) ? label : lower(label);
}

/** The run as a sentence names it: "an easy run", "the long run", "the quality session (VO2 intervals)". */
function runPhrase(run: DayDetailRun): string {
  if (run.race) return run.label;
  if (run.kind === "easy") return "an easy run";
  if (run.kind === "long") return "the long run";
  return `the quality session (${runNoun(run.label)})`;
}

function headlineOf(
  status: DayDetailStatus,
  lift: DayDetailLift | null,
  run: DayDetailRun | null,
  done: DayDetailDone | null,
  past: boolean
): string {
  const runWords = run ? runPhrase(run) : "";
  if (status === "done") {
    const runsDone = done?.runs.length ?? 0;
    const lifted = done?.session ? done.session.title : null;
    const ran =
      run?.status === "completed" ? runWords : runsDone ? (runsDone === 1 ? "a run" : `${runsDone} runs`) : "";
    if (lifted && ran) return `${lifted}, and ${ran} — done.`;
    if (lifted) return `${lifted} — done.`;
    if (ran) return `${cap(ran)} — done.`;
    return "Logged.";
  }
  if (lift && run) return `${cap(withArticle(lift.title))} day, then ${runWords}.`;
  if (lift) return `${cap(withArticle(lift.title))} day.`;
  if (run) return `${cap(runWords)}.`;
  if (status === "open") return "Nothing was logged this day.";
  return past ? "A rest day." : "A rest day. Nothing is planned.";
}

function caveatsOf(date: string): string[] {
  const events = safe(() => listContextEvents({ activeOnly: true, on: date }) as any[], []);
  const out: string[] = [];
  for (const e of events) {
    const title = text(e?.title);
    if (title && !out.includes(title)) out.push(title);
  }
  return out.slice(0, 4);
}

function doneOf(date: string, today: string): DayDetailDone | null {
  if (date > today) return null;
  const record = safe(() => dayRecord(date, { today }), null);
  if (!record) return null;
  return {
    session: record.session,
    runs: record.activities.filter((a) => a.run),
    other: record.activities.filter((a) => !a.run),
  };
}

function statusOf(
  date: string,
  today: string,
  cell: PlanWeekDay | null,
  hasLift: boolean,
  hasRun: boolean,
  done: DayDetailDone | null
): DayDetailStatus {
  const logged = !!(done && (done.session || done.runs.length || done.other.length));
  const planned = hasLift || hasRun;
  if (date < today) {
    if (cell?.status === "done") return "done";
    if (logged) return cell?.status === "open" && hasLift && !done?.session ? "open" : "done";
    return planned ? "open" : "rest";
  }
  if (date === today) {
    // A finished lift with the day's run still open is still today's work.
    if (cell?.status === "done" && !(hasRun && ownRun(cell)?.status === "open")) return "done";
    if (!planned && !logged) return "rest";
    return "today";
  }
  return planned ? "upcoming" : "rest";
}

/**
 * One calendar day of the training week, opened. `today` defaults to the server's
 * local date. Null when the date is past the end of next week — the run engine and
 * the lifting week forecast no further than that.
 */
export function dayDetail(date: string, opts: { today?: string } = {}): DayDetail | null {
  const day = dayDetailDate(date);
  if (!day) return null;
  const today = dayDetailDate(opts.today) ?? localDateISO();
  if (day > dayDetailHorizon(today)) return null;

  const heavyLower = new Set<number>();
  for (const g of safe(() => planDayStrengthGroups(), [])) if (g.heavy_lower) heavyLower.add(g.day_number);
  const ctx: DayContext = { today, weeks: new Map(), heavyLower };
  const asOf = dayDetailWeekAsOf(day, today);
  const week = weekFor(ctx, day);
  const cell = week?.days.find((d) => d.date === day) ?? null;
  const placed = !!week?.days.some((d) => d.date);
  const runUnits: "km" | "mi" = safe(() => (getSettings().run_units === "mi" ? "mi" : "km"), "km");
  const build = safe(() => raceBuild(today), null);
  const done = doneOf(day, today);
  const weekRead = weekOf(day, today, build);

  // A stated run weekday whose run already landed earlier in the week is covered, not ahead.
  const coveredRun =
    cell?.run && cell.run.status === "completed" && cell.run.completion_date && cell.run.completion_date !== day
      ? cell.run
      : null;
  const covered = coveredRun
    ? `This week's ${lower(text(coveredRun.label) || RUN_KIND_LABELS[coveredRun.kind] || "run")} already landed ${longWeekday(String(coveredRun.completion_date))}.`
    : null;

  const hasLift = !!strengthOf(cell) || !!done?.session;
  const hasRun = !!ownRun(cell) && ownRun(cell)?.kind !== "logged";
  const status = statusOf(day, today, cell, hasLift, hasRun, done);

  const liftRead = buildLift(day, status, cell, ctx, done, weekRead.block?.phase ?? null, week?.strength_line ?? null);
  const lift = liftRead?.lift ?? null;
  const run = buildRun(day, cell, asOf, runUnits, build);
  const watch = (liftRead?.watch ?? []).slice(0, MAX_WATCH);
  const stack = status === "done" || status === "open" ? null : stackOf(day, ctx, cell, lift, run);
  const liftDates = (week?.days ?? []).filter((d) => d.date && strengthOf(d)).map((d) => String(d.date));
  const liftSlot = liftDates.includes(day) ? { index: liftDates.indexOf(day), of: liftDates.length } : null;

  return {
    date: day,
    weekday: shortWeekday(day),
    today,
    status,
    placed,
    focus: focusLine(lift, run, status),
    headline: headlineOf(status, lift, run, done, day < today),
    why: whyLine(day, asOf, weekRead, lift, run, covered, build, liftSlot),
    week: weekRead,
    lift,
    run,
    watch,
    stack,
    done,
    caveats: caveatsOf(day),
    run_units: runUnits,
  };
}
