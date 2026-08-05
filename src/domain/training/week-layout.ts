// THE WEEK-LAYOUT READ — does the lifting week and the running week compose?
//
// The run engine has always placed runs AROUND the lifting: weeklyRunPlan reads the
// plan's heavy-lower days and keeps the long/quality run off them, now fatigue-aware
// on top of that. The strength side had no counterpart. The agentic program evolution
// places lifting days with a prose bullet for company ("never place the heaviest
// lower-body day adjacent to the long/quality run") and nothing that can check it —
// so a restructure can quietly undo a placement the run engine worked to earn, and
// nothing in the system ever notices.
//
// This is the missing half, done Cairn's way: a deterministic READ that notices the
// collision and says ONE quiet sentence about the smallest move that clears it. It
// changes no plan, gates nothing, and scores nothing. It reaches the athlete through
// the same adaptations_due channel the per-lane guards use, and reaches the evolution
// prompt as structured data beside the prose rule, so a proposed restructure can be
// checked against the real week rather than against an instruction.
//
// A blank-slate week composer is deliberately NOT what this is. The athlete owns the
// shape of their week; this only points at the one place two big leg days collided.

import { pickDayVariant } from "../../repo/brain/day-read-rules.js";
import type { FlexibleTrainingAgenda } from "../../repo/flexible-training-agenda.js";
import type { WeeklyRunPlan } from "../../repo/run-progression.js";
import { localDateISO } from "../../repo/shared.js";
import { heavyLowerDayLoads, planDayStrengthGroups, planRunItems, type HeavyLowerDayLoad } from "../../repo/training-read.js";

// Type-only imports above on purpose: run-progression and flexible-training-agenda
// both sit UNDER program-state, which is where this read is surfaced. Taking them as
// injected values rather than importing the builders keeps this module a leaf and the
// import graph acyclic — and it means the read costs nothing when nobody has one to hand.

export type WeekLayoutCollisionKind =
  | "heavy_lower_adjacent_long_run"
  | "heavy_lower_adjacent_quality"
  | "double_day_stack";

export interface WeekLayoutCollision {
  kind: WeekLayoutCollisionKind;
  /** The plan day_numbers involved, ascending. */
  days: number[];
  /** Plain words for what collided — athlete register, never a score. */
  detail: string;
}

export interface WeekLayoutRead {
  clean: boolean;
  collisions: WeekLayoutCollision[];
  /** ONE sentence naming the smallest move that clears it, or null on a clean week. */
  suggestion: string | null;
  /**
   * The move that sentence describes, as day_numbers — the STRENGTH day to shift and
   * where to. null on a clean week, and null when the week is full enough that no slot
   * clears it (the sentence then names the trade instead). The evolution prompt reads
   * this; nothing applies it, and the athlete is free to ignore it.
   */
  suggested_move: { from: number; to: number } | null;
  /** The heaviest lower day(s) — the axis adjacency is judged on. Ties are kept. */
  heaviest_lower_days: number[];
  /** Every genuine heavy-lower (squat/hinge) day, the axis the 3-in-a-row read uses. */
  heavy_lower_days: number[];
  long_run_day: number | null;
  quality_run_day: number | null;
  /** Where the run placement was read from. "none" = nothing to compose against. */
  source: "plan" | "run_plan" | "agenda" | "none";
}

const CLEAN = (
  heaviest: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  source: WeekLayoutRead["source"]
): WeekLayoutRead => ({
  clean: true,
  collisions: [],
  suggestion: null,
  suggested_move: null,
  heaviest_lower_days: heaviest,
  heavy_lower_days: heavy,
  long_run_day: long,
  quality_run_day: quality,
  source,
});

// day_number is a Mon–Sun template (weeklyRunPlan anchors slot 1 on mondayOf), so the
// weekday is a pure function of the number and needs no date.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const weekday = (dayNumber: number): string => WEEKDAYS[dayNumber - 1] ?? `day ${dayNumber}`;

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Adjacency is LINEAR (Sunday and the following Monday are not treated as neighbours),
// matching the run engine's own model — `dayAfterLower` there stops at 7. Reading the
// week as a ring here would flag placements weeklyRunPlan considers legal and put the
// two halves of the composition at odds with each other.
const adjacent = (a: number, b: number): boolean => Math.abs(a - b) === 1;

// What to call the strength day in a sentence. The plan day's own name is what the
// athlete sees everywhere else, so use it when there is one.
function strengthDayLabel(day: HeavyLowerDayLoad | undefined, dayNumber: number): string {
  const raw = (day?.name || day?.focus || "").trim().toLowerCase();
  if (!raw) return `${weekday(dayNumber)}'s heavy lower-body day`;
  return /\bday\b/.test(raw) ? `${weekday(dayNumber)}'s ${raw}` : `${weekday(dayNumber)}'s ${raw} day`;
}

// ---- variant sets (never one literal — a stable week fires the same branch every
// morning, and one sentence printed verbatim for a fortnight reads as a broken app) ----

const MOVE_VARIANTS: ReadonlyArray<(lift: string, to: string, runDay: string, run: string) => string> = [
  (lift, to, runDay, run) => `Moving ${lift} to ${to} gives ${runDay}'s ${run} a clean runway.`,
  (lift, to, runDay, run) => `${cap(lift)} would sit better on ${to} — that way ${runDay}'s ${run} gets fresher legs.`,
  (lift, to, runDay, run) =>
    `Shifting ${lift} to ${to} is the one move that unstacks the legs before ${runDay}'s ${run}.`,
  (lift, to, runDay, run) => `Try ${lift} on ${to} instead, so ${runDay}'s ${run} isn't running on worked legs.`,
];

const STACK_MOVE_VARIANTS: ReadonlyArray<(lift: string, to: string, span: string) => string> = [
  (lift, to, span) => `The hard days run ${span} without a break — ${lift} on ${to} instead opens a gap.`,
  (lift, to, span) => `${cap(span)} are all hard as it stands; moving ${lift} to ${to} gives that stretch some air.`,
  (lift, to, span) => `Shifting ${lift} to ${to} breaks up a hard stretch that currently runs ${span}.`,
];

const UNMOVABLE_VARIANTS: ReadonlyArray<(lift: string, runDay: string, run: string) => string> = [
  (lift, runDay, run) =>
    `The week is full enough that ${lift} lands right beside ${runDay}'s ${run} — worth going lighter on whichever matters less this week.`,
  (lift, runDay, run) =>
    `There's nowhere clean to move ${lift} this week, so it sits next to ${runDay}'s ${run}: trade a little off one of them.`,
  (lift, runDay, run) =>
    `${cap(lift)} and ${runDay}'s ${run} can't be separated this week — keep one of the two honest and easy.`,
];

const UNMOVABLE_STACK_VARIANTS: ReadonlyArray<(span: string) => string> = [
  (span) => `The hard days run ${span} and the week has nowhere else to put them — keep the middle one modest.`,
  (span) => `${cap(span)} are hard back to back with no clean gap available; ease one of them rather than all three.`,
];

// ---- run placement ----

interface RunPlacement {
  long: number | null;
  quality: number | null;
  source: WeekLayoutRead["source"];
}

// Where the week's demanding runs sit. Read in order of how STABLE the answer is, not
// how fresh it is: the stored plan is the week the athlete actually has (and the week
// an evolution proposal rewrites), so it leads. weeklyRunPlan is what Cairn WOULD run
// and only speaks when the plan carries no runs yet. The flexible agenda is a rolling
// reconciliation that moves day to day — a fine last resort, a poor basis for a line
// that would otherwise flicker on and off through the week.
function runPlacement(opts?: { runPlan?: WeeklyRunPlan | null; agenda?: FlexibleTrainingAgenda | null }): RunPlacement {
  let items: { day_number: number; kind: string }[] = [];
  try {
    items = planRunItems();
  } catch {
    items = [];
  }
  const pick = (rows: { day_number: number; kind: string }[], kind: string): number | null => {
    const hit = rows
      .filter((r) => r.kind === kind && Number.isFinite(r.day_number))
      .sort((a, b) => a.day_number - b.day_number)[0];
    return hit ? hit.day_number : null;
  };
  const planned = { long: pick(items, "long"), quality: pick(items, "quality") };
  if (planned.long != null || planned.quality != null) return { ...planned, source: "plan" };

  const runPlan = opts?.runPlan;
  if (runPlan?.available && Array.isArray(runPlan.runs) && runPlan.runs.length) {
    const rows = runPlan.runs.map((r) => ({ day_number: Number(r.day_number), kind: String(r.kind_label) }));
    const fromPlan = { long: pick(rows, "long"), quality: pick(rows, "quality") };
    if (fromPlan.long != null || fromPlan.quality != null) return { ...fromPlan, source: "run_plan" };
  }

  const agenda = opts?.agenda;
  if (agenda?.available && Array.isArray(agenda.intents) && agenda.intents.length) {
    const rows = agenda.intents
      .filter((i) => i.status !== "completed")
      .map((i) => ({ day_number: Number(i.provisional_day_number), kind: String(i.kind) }));
    const fromAgenda = { long: pick(rows, "long"), quality: pick(rows, "quality") };
    if (fromAgenda.long != null || fromAgenda.quality != null) return { ...fromAgenda, source: "agenda" };
  }

  return { long: null, quality: null, source: "none" };
}

// ---- collisions ----

// Maximal runs of ≥3 consecutive HARD days, where hard = any genuine heavy-lower day
// plus the long and quality runs. Deliberately the full heavy-lower set rather than
// just the heaviest: three real leg-or-run days in a row is a week-shape problem
// whichever of them happens to be the biggest.
function hardStacks(heavy: number[], long: number | null, quality: number | null): number[][] {
  const hard = [...new Set([...heavy, ...(long == null ? [] : [long]), ...(quality == null ? [] : [quality])])].sort(
    (a, b) => a - b
  );
  const runs: number[][] = [];
  for (const day of hard) {
    const current = runs[runs.length - 1];
    if (current && day === current[current.length - 1] + 1) current.push(day);
    else runs.push([day]);
  }
  return runs.filter((r) => r.length >= 3);
}

function detectCollisions(
  heaviest: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  loads: HeavyLowerDayLoad[]
): WeekLayoutCollision[] {
  const out: WeekLayoutCollision[] = [];
  const byDay = new Map(loads.map((l) => [l.day_number, l]));
  const runLabel = (kind: "long" | "quality") => (kind === "long" ? "long run" : "quality run");
  for (const h of heaviest) {
    for (const [kind, day] of [
      ["long", long],
      ["quality", quality],
    ] as const) {
      if (day == null || !adjacent(h, day)) continue;
      out.push({
        kind: kind === "long" ? "heavy_lower_adjacent_long_run" : "heavy_lower_adjacent_quality",
        days: [h, day].sort((a, b) => a - b),
        detail: `${cap(strengthDayLabel(byDay.get(h), h))} sits right ${h < day ? "before" : "after"} ${weekday(day)}'s ${runLabel(kind)}.`,
      });
    }
  }
  for (const stack of hardStacks(heavy, long, quality)) {
    out.push({
      kind: "double_day_stack",
      days: stack,
      detail: `${weekday(stack[0])} to ${weekday(stack[stack.length - 1])} are hard days back to back.`,
    });
  }
  return out;
}

// ---- the smallest move that clears it ----

// Where this heavy day could go instead: the NEAREST free slot whose move leaves the
// week with no collisions at all. Candidates are restricted to day_numbers the plan
// actually has — a 4-day plan must never be told to move a lift onto day 5, 6 or 7,
// a day that doesn't exist for this athlete. Earlier is preferred at equal distance —
// pulling a leg day forward costs the athlete less than pushing it into the weekend,
// where the long run already lives. null when the week has nowhere clean to put it.
function clearingSlot(
  move: number,
  heaviest: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  loads: HeavyLowerDayLoad[],
  planDays: ReadonlySet<number>
): number | null {
  const candidates = [...planDays]
    .filter((t) => t !== move && t !== long && t !== quality && !heavy.includes(t))
    .sort((a, b) => Math.abs(a - move) - Math.abs(b - move) || a - b);
  for (const to of candidates) {
    const swap = (days: number[]) => days.map((d) => (d === move ? to : d));
    if (!detectCollisions(swap(heaviest), swap(heavy), long, quality, loads).length) return to;
  }
  return null;
}

/**
 * Does this week's lifting compose with this week's running?
 *
 * Deterministic and offline. Absence is neutral in every direction: no plan, no heavy
 * lower day, or no long/quality run all read CLEAN — a week with nothing to stack
 * cannot be stacked wrong. Nothing here changes a plan, and the suggestion is exactly
 * one sentence, only ever about moving the STRENGTH day (the run engine already placed
 * its runs around the statics; moving them back would just restart the argument).
 */
export function weekLayoutRead(
  date?: string,
  opts?: { runPlan?: WeeklyRunPlan | null; agenda?: FlexibleTrainingAgenda | null }
): WeekLayoutRead {
  const d = date || localDateISO();

  let loads: HeavyLowerDayLoad[] = [];
  try {
    loads = heavyLowerDayLoads();
  } catch {
    loads = [];
  }
  const heavy = loads.map((l) => l.day_number);
  let planDays: ReadonlySet<number> = new Set();
  try {
    planDays = new Set(planDayStrengthGroups().map((d) => d.day_number));
  } catch {
    planDays = new Set();
  }
  const top = loads[0];
  // Ties are kept whole: two lower days carrying identical work are genuinely both the
  // week's heaviest, and picking one by day number would hide a real collision on the other.
  const heaviest = top
    ? loads
        .filter((l) => l.tonnage === top.tonnage && l.compound_sets === top.compound_sets && l.sets === top.sets)
        .map((l) => l.day_number)
    : [];

  const { long, quality, source } = runPlacement(opts);
  if (!heavy.length || (long == null && quality == null)) return CLEAN(heaviest, heavy, long, quality, source);

  const collisions = detectCollisions(heaviest, heavy, long, quality, loads);
  if (!collisions.length) return CLEAN(heaviest, heavy, long, quality, source);

  // The lead: an adjacency collision names a concrete move, so it speaks ahead of the
  // stack (which is usually the same problem seen wider).
  const lead = collisions.find((c) => c.kind !== "double_day_stack") ?? collisions[0];
  const byDay = new Map(loads.map((l) => [l.day_number, l]));

  let suggestion: string | null = null;
  let suggested_move: WeekLayoutRead["suggested_move"] = null;
  if (lead.kind === "double_day_stack") {
    // Move a heavy day out of the stack — the heaviest one in it when there is one,
    // otherwise the last, which is the one carrying the most accumulated fatigue.
    const inStack = lead.days.filter((day) => heavy.includes(day));
    const move = inStack.find((day) => heaviest.includes(day)) ?? inStack[inStack.length - 1];
    const span = `${weekday(lead.days[0])} to ${weekday(lead.days[lead.days.length - 1])}`;
    const to = move == null ? null : clearingSlot(move, heaviest, heavy, long, quality, loads, planDays);
    if (move != null && to != null) suggested_move = { from: move, to };
    suggestion =
      move != null && to != null
        ? pickDayVariant(STACK_MOVE_VARIANTS, d, "week-layout:stack")(
            strengthDayLabel(byDay.get(move), move),
            weekday(to),
            span
          )
        : pickDayVariant(UNMOVABLE_STACK_VARIANTS, d, "week-layout:stack-held")(span);
  } else {
    const runDay = lead.kind === "heavy_lower_adjacent_long_run" ? long : quality;
    const runWord = lead.kind === "heavy_lower_adjacent_long_run" ? "long run" : "quality run";
    const move = lead.days.find((day) => day !== runDay) as number;
    const lift = strengthDayLabel(byDay.get(move), move);
    const to = clearingSlot(move, heaviest, heavy, long, quality, loads, planDays);
    if (to != null) suggested_move = { from: move, to };
    suggestion =
      to != null
        ? pickDayVariant(MOVE_VARIANTS, d, `week-layout:${lead.kind}`)(
            lift,
            weekday(to),
            weekday(runDay as number),
            runWord
          )
        : pickDayVariant(UNMOVABLE_VARIANTS, d, `week-layout:${lead.kind}:held`)(
            lift,
            weekday(runDay as number),
            runWord
          );
  }

  return {
    clean: false,
    collisions,
    suggestion,
    suggested_move,
    heaviest_lower_days: heaviest,
    heavy_lower_days: heavy,
    long_run_day: long,
    quality_run_day: quality,
    source,
  };
}
