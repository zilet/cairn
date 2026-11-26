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
import { type KeyRunRelation, keyRunRelation } from "../../repo/key-run-proximity.js";
import { heavyLowerDayLoads, planDayStrengthGroups, type HeavyLowerDayLoad } from "../../repo/training-read.js";

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
  /**
   * The plan day_numbers involved. Ascending for an adjacency collision. For a stack
   * they are in TEMPLATE order, which may wrap past Sunday (e.g. [6, 7, 1]) — the week
   * is a ring, so a hard stretch can straddle the Sunday/Monday seam.
   */
  days: number[];
  /** Plain words for what collided — athlete register, never a score. */
  detail: string;
}

export interface WeekLayoutRead {
  clean: boolean;
  /**
   * Which axis every day number below is on. "template": plan day_numbers on the
   * repeating Mon=Day1 ring (the only honest read when no lifting week is known).
   * "calendar": weekday indexes 1=Mon…7=Sun, the week as the athlete's stated lifting
   * week actually lays the ring onto it — the same map the Plan tab's strip draws from.
   */
  space: "template" | "calendar";
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
  /** The heaviest lower day(s) — they lead the adjacency read (keyLowerDays). Ties are kept. */
  heaviest_lower_days: number[];
  /** Every genuine heavy-lower (squat/hinge) day, the axis the 3-in-a-row read uses. */
  heavy_lower_days: number[];
  long_run_day: number | null;
  quality_run_day: number | null;
  /**
   * The athlete's lifting weekdays, as names in weekday order (Monday first). [] when
   * nothing is known. Carried here so a restructure can check its proposed ring against
   * the real week instead of remembering a prose rule.
   */
  lift_days: string[];
  /**
   * How `lift_days` is known: "stated" is the athlete's own words, "observed" is the
   * 3-of-6-weeks pattern read off their log. null when the list is empty. A restructure
   * may argue with an observed week; it may not argue with a stated one.
   */
  lift_days_source: "stated" | "observed" | null;
  /** The athlete's STATED run weekdays, as names in weekday order. [] when unstated. */
  run_days: string[];
  /**
   * Where the run placement was read from. "none" = nothing to compose against. Runs are
   * never plan items (migration 110), so the engine's week leads and the agenda follows.
   */
  source: "run_plan" | "agenda" | "none";
  /**
   * "Hard days hard": where the week's heaviest lower lift day sits against its key
   * runs — a READ, never an action (lowerLiftPlacement). null when the week has no
   * heavy lower day or no quality/long run to read it against.
   */
  lower_lift_placement: LowerLiftPlacement | null;
}

/**
 * Where the week's heaviest lower lift day sits against the quality and long runs, read
 * by the SAME rule the live week map uses to place it (key-run-proximity.ts, shared with
 * plan-selection.ts `keyRunAwarePlacement`), so the read never calls preferred a day the
 * placement would trade away:
 *  - `eve_of_key_run`: the day before either (worst — the legs go into the run worked);
 *  - `on_key_run`: a quality or long run's own day (the legs carry both on one day);
 *  - `after_key_run`: the day after either (the legs are still carrying the run);
 *  - `neutral`: clear of both by at least a day — the only `preferred` placement, and the
 *    slot the placement trades a heavy lower day onto when one is free.
 * `note` is one plain sentence. Evidence (concurrent-training scheduling: lower-body
 * lifting kept out of the 24 h around a quality or long run) is moderate and partly
 * practice-based, so this stays a read: it moves no day and asks nothing.
 */
export interface LowerLiftPlacement {
  state: "eve_of_key_run" | "on_key_run" | "after_key_run" | "neutral";
  preferred: boolean;
  note: string;
}

/**
 * dow (0 = Sunday) -> weekday NAMES in weekday order, Monday first. Invalid entries and
 * duplicates are dropped silently, exactly as an off-ring day_number is above: this read
 * is a quiet suggestion, not a place to raise an error over a malformed schedule.
 */
export function statedWeekdayNames(dows: readonly number[] | null | undefined): string[] {
  const seen = new Set<number>();
  for (const raw of dows ?? []) {
    const dow = Number(raw);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    seen.add(dow);
  }
  // (dow + 6) % 7 puts Monday at 0 and Sunday at 6 — the order the athlete says their
  // week in, and the order the plan ring is laid onto.
  return [...seen].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((dow) => WEEKDAYS[(dow + 6) % 7]);
}

const CLEAN = (
  heaviest: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  source: WeekLayoutRead["source"],
  stated: { lift_days: string[]; lift_days_source: WeekLayoutRead["lift_days_source"]; run_days: string[] },
  space: WeekLayoutRead["space"] = "template",
  lowerPlacement: LowerLiftPlacement | null = null
): WeekLayoutRead => ({
  clean: true,
  space,
  collisions: [],
  suggestion: null,
  suggested_move: null,
  heaviest_lower_days: heaviest,
  heavy_lower_days: heavy,
  long_run_day: long,
  quality_run_day: quality,
  lift_days: stated.lift_days,
  lift_days_source: stated.lift_days_source,
  run_days: stated.run_days,
  source,
  lower_lift_placement: lowerPlacement,
});

// day_number is a Mon–Sun template (weeklyRunPlan anchors slot 1 on mondayOf), so the
// weekday is a pure function of the number and needs no date.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const weekday = (dayNumber: number): string => WEEKDAYS[dayNumber - 1] ?? `day ${dayNumber}`;

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Adjacency is CYCLIC, because day_number is a Mon–Sun TEMPLATE that repeats every
// week — day 7 and day 1 are neighbours in the athlete's actual life, not a seam.
// A Sunday long run IS followed by Monday's heavy lower session, every single week;
// reading the week as a line hid exactly one collision (7↔1) and hid it forever,
// since a template that repeats never stops producing it. The run engine judges the
// week on this same ring (src/repo/run-progression.ts): its long-run placement PREFERS
// a slot with no lower day on either side of it and falls back to a merely-free slot
// only when the week has none. So the two halves agree about which weeks are separable
// — this read never flags a placement the engine could have avoided — but on a week
// that genuinely cannot be separated it still reports the collision rather than going
// quiet about it. Agreement is about the week, not about always reading clean.
const adjacent = (a: number, b: number): boolean => Math.abs(a - b) === 1 || Math.abs(a - b) === 6;

// Cyclic neighbours of a day_number in the repeating template.
const nextDay = (d: number): number => (d === 7 ? 1 : d + 1);
const prevDay = (d: number): number => (d === 1 ? 7 : d - 1);

// The ring has exactly seven positions, and every piece of arithmetic above assumes
// it. `replacePlan` puts no cap on day_number, so a hand-authored or agent-authored
// plan can carry an 8 — and on a line that reads as adjacent to 7, inventing a
// collision between a day that exists and one that doesn't. Days off the ring are
// dropped SILENTLY at the boundary: the read is a quiet suggestion, and a plan the
// athlete can see on their own screen is not a place to raise an error.
const onRing = (d: unknown): d is number => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7;

// What to call the strength day in a sentence. The plan day's own name is what the
// athlete sees everywhere else, so use it when there is one.
function strengthDayLabel(day: HeavyLowerDayLoad | undefined, dayNumber: number): string {
  // A stored NAME keeps its own casing ("Lower A", not "lower a"); only a focus
  // sentence used as a stand-in is lowercased into the prose.
  const name = (day?.name || "").trim();
  const raw = name || (day?.focus || "").trim().toLowerCase();
  if (!raw) return `${weekday(dayNumber)}'s heavy lower-body day`;
  return /\bday\b/i.test(raw) ? `${weekday(dayNumber)}'s ${raw}` : `${weekday(dayNumber)}'s ${raw} day`;
}

// ---- variant sets (never one literal — a stable week fires the same branch every
// morning, and one sentence printed verbatim for a fortnight reads as a broken app) ----

// Two sets, by which side the lift sits on. A lift the day BEFORE the run sends the
// run out on worked legs; a lift the day AFTER asks worked legs to squat. Read live,
// the before-set fired for Monday's squats after Sunday's long run — "so Sunday's long
// run isn't running on worked legs" — a sentence that is backwards on the calendar.
const MOVE_VARIANTS: ReadonlyArray<(lift: string, to: string, runDay: string, run: string) => string> = [
  (lift, to, runDay, run) => `Moving ${lift} to ${to} gives ${runDay}'s ${run} a clean runway.`,
  (lift, to, runDay, run) => `${cap(lift)} would sit better on ${to} — that way ${runDay}'s ${run} gets fresher legs.`,
  (lift, to, runDay, run) =>
    `Shifting ${lift} to ${to} is the one move that unstacks the legs before ${runDay}'s ${run}.`,
  (lift, to, runDay, run) => `Try ${lift} on ${to} instead, so ${runDay}'s ${run} isn't running on worked legs.`,
];

// Calendar space, where the target weekday already lifts: the move is a SWAP of two
// strength days, and the sentence names both so the athlete knows what trades.
const SWAP_VARIANTS: ReadonlyArray<(lift: string, other: string, to: string, runDay: string, run: string) => string> = [
  (lift, other, to, runDay, run) => `Swap ${lift} with ${to}'s ${other}, so ${runDay}'s ${run} isn't running on worked legs.`,
  (lift, other, to, runDay, run) =>
    `${cap(lift)} and ${to}'s ${other} would trade places well — that way ${runDay}'s ${run} gets fresher legs.`,
  (lift, other, to, runDay, run) =>
    `Trading ${lift} for ${to}'s ${other} is the one move that unstacks the legs before ${runDay}'s ${run}.`,
  (lift, other, to, runDay, run) => `Try ${lift} on ${to} and ${other} in its place; ${runDay}'s ${run} then starts on fresh legs.`,
];

const STACK_SWAP_VARIANTS: ReadonlyArray<(lift: string, other: string, to: string, span: string) => string> = [
  (lift, other, to, span) => `The hard days run ${span} without a break — swapping ${lift} with ${to}'s ${other} opens a gap.`,
  (lift, other, to, span) => `${cap(span)} are all hard as it stands; trading ${lift} for ${to}'s ${other} gives that stretch some air.`,
  (lift, other, to, span) => `Swapping ${lift} with ${to}'s ${other} breaks up a hard stretch that currently runs ${span}.`,
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

// The week has no clean slot left for the lift, but the key run itself has an open day
// after it: nudging the run one day later is the lightest fix left, and it is said as a
// suggestion about the RUN, never as a move nobody can make any more.
const RUN_LATER_VARIANTS: ReadonlyArray<(lift: string, runDay: string, run: string, later: string) => string> = [
  (lift, runDay, run, later) =>
    `${runDay}'s ${run} could slide to ${later} this week, which gives ${lift} a day of room before it.`,
  (lift, runDay, run, later) =>
    `Nudging the ${run} from ${runDay} to ${later} is the lightest fix left this week: ${lift} then has a day to settle first.`,
  (lift, runDay, run, later) =>
    `With the rest of the week already set, taking ${runDay}'s ${run} on ${later} instead gives ${lift} its room more simply than moving a lift.`,
];

// The last lift move left: trade the leg day onto the QUALITY run's own day, where an
// upper-body session sits. The legs and the run then share one day (the run first, the
// lift hours later) and the day before the run is free. Only ever offered when no open
// day clears the week and the run cannot slide later; never onto a long-run day.
const SAME_DAY_SWAP_VARIANTS: ReadonlyArray<(lift: string, other: string, to: string, run: string) => string> = [
  (lift, other, to, run) =>
    `Trading ${lift} for ${to}'s ${other} puts the legs on the ${run}'s own day — run first, lift hours later — and keeps the day before it fresh.`,
  (lift, other, to, run) =>
    `${cap(lift)} could swap with ${to}'s ${other}: the ${run} and the leg work then share ${to}, hours apart, with fresh legs going into the run.`,
];

const UNMOVABLE_STACK_VARIANTS: ReadonlyArray<(span: string) => string> = [
  (span) => `The hard days run ${span} and the week has nowhere else to put them — keep the middle one modest.`,
  (span) => `${cap(span)} are hard back to back with no clean gap available; ease one of them rather than all three.`,
];

// ---- run placement ----

export interface RunPlacement {
  long: number | null;
  quality: number | null;
  source: WeekLayoutRead["source"];
}

// Where the week's demanding runs sit. Runs are never plan items (migration 110): the
// run engine's week (weeklyRunPlan, laid on the athlete's stated run days) is the
// stable answer and leads; the flexible agenda is a rolling reconciliation that moves
// day to day — a fine last resort, a poor basis for a line that would otherwise
// flicker on and off through the week.
// Exported so the stress budget (src/repo/stress-budget.ts) reads the same placement.
export function runPlacement(opts?: { runPlan?: WeeklyRunPlan | null; agenda?: FlexibleTrainingAgenda | null }): RunPlacement {
  const pick = (rows: { day_number: number; kind: string }[], kind: string): number | null => {
    const hit = rows
      .filter((r) => r.kind === kind && onRing(r.day_number))
      .sort((a, b) => a.day_number - b.day_number)[0];
    return hit ? hit.day_number : null;
  };

  const runPlan = opts?.runPlan;
  if (runPlan?.available && Array.isArray(runPlan.runs) && runPlan.runs.length) {
    // The kind the WEEK put on each day — a morning that turns today's quality easy does
    // not move where the week's demanding runs sit.
    const rows = runPlan.runs.map((r) => ({
      day_number: Number(r.day_number),
      kind: String(r.planned_kind_label ?? r.kind_label),
    }));
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

// Every weekday this week already gives a run, of any kind — the run engine's own
// slots, else the agenda's provisional ones. A run is never slid onto one of them.
function weekRunDays(opts?: { runPlan?: WeeklyRunPlan | null; agenda?: FlexibleTrainingAgenda | null }): Set<number> {
  const days = new Set<number>();
  const runPlan = opts?.runPlan;
  if (runPlan?.available && Array.isArray(runPlan.runs))
    for (const r of runPlan.runs) if (onRing(Number(r.day_number))) days.add(Number(r.day_number));
  const agenda = opts?.agenda;
  if (!days.size && agenda?.available && Array.isArray(agenda.intents))
    for (const i of agenda.intents)
      if (onRing(Number(i.provisional_day_number))) days.add(Number(i.provisional_day_number));
  return days;
}

// ---- collisions ----

// Maximal runs of ≥3 consecutive HARD days, where hard = any genuine heavy-lower day
// plus the long and quality runs. Deliberately the full heavy-lower set rather than
// just the heaviest: three real leg-or-run days in a row is a week-shape problem
// whichever of them happens to be the biggest.
//
// Consecutive is read on the same ring `adjacent` uses: Saturday-Sunday-Monday is
// three hard days back to back in a repeating template, and scanning 1→7 in a line
// would report it as two unrelated stretches of one and two days.
function hardStacks(heavy: number[], long: number | null, quality: number | null): number[][] {
  const hard = [
    ...new Set([...heavy, ...(long == null ? [] : [long]), ...(quality == null ? [] : [quality])].filter(onRing)),
  ].sort((a, b) => a - b);
  if (!hard.length) return [];
  // Every day hard: the ring has no boundary to start the scan at, and the stretch is
  // simply the whole week. (Also the guard that keeps the rotation below well-defined.)
  // Counted as DISTINCT ring days — a length test alone would trip on a duplicate or an
  // off-ring number and hand back a whole-week stack the athlete doesn't have.
  if (new Set(hard).size >= 7) return [[1, 2, 3, 4, 5, 6, 7]];
  // Rotate the scan to begin at a day whose cyclic predecessor is NOT hard, so a
  // stretch that straddles the Sunday/Monday seam is seen whole rather than split at
  // the array's edges. With a gap somewhere in the week such a day always exists.
  const set = new Set(hard);
  const firstIdx = hard.findIndex((d) => !set.has(prevDay(d)));
  const startIdx = firstIdx < 0 ? 0 : firstIdx;
  const ordered = [...hard.slice(startIdx), ...hard.slice(0, startIdx)];
  const runs: number[][] = [];
  for (const day of ordered) {
    const current = runs[runs.length - 1];
    if (current && day === nextDay(current[current.length - 1])) current.push(day);
    else runs.push([day]);
  }
  return runs.filter((r) => r.length >= 3);
}

// The adjacency axis: the heaviest lower day plus every other lower day that carries
// real squat/hinge work. Judged on the heaviest alone, Friday's Lower B before a
// Saturday long run never collided because Wednesday's Lower A out-tonnaged it — and
// Friday's squats still send the legs into Saturday worked. An accessory-only lower
// day (a leg curl) still never collides. Heaviest first, so it leads when both do.
function keyLowerDays(heaviest: number[], loads: HeavyLowerDayLoad[]): number[] {
  return [...new Set([...heaviest, ...loads.filter((l) => l.compound_sets > 0).map((l) => l.day_number)])];
}

function detectCollisions(
  keyLower: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  loads: HeavyLowerDayLoad[]
): WeekLayoutCollision[] {
  const out: WeekLayoutCollision[] = [];
  const byDay = new Map(loads.map((l) => [l.day_number, l]));
  const runLabel = (kind: "long" | "quality") => (kind === "long" ? "long run" : "quality run");
  for (const h of keyLower) {
    for (const [kind, day] of [
      ["long", long],
      ["quality", quality],
    ] as const) {
      if (day == null || !adjacent(h, day)) continue;
      // Which side the lift sits on, read on the ring. Across the Sunday/Monday seam
      // the order inverts: day 1 FOLLOWS day 7 (Monday's session is what Sunday's long
      // run runs into, next week and every week), so comparing the raw numbers there
      // would print "Monday sits right before Sunday's long run" — a sentence that is
      // both false and obviously nonsense to the person reading it.
      const wrapped = Math.abs(h - day) === 6;
      const liftIsBefore = wrapped ? h > day : h < day;
      // ONLY the day BEFORE collides. Heavy legs the morning after a long or quality
      // run is the hybrid stacking the race build's own strength hint prescribes
      // ("squats land after the quality run or the day after the long run"): the two
      // hard leg stresses sit together and the recovery that follows is whole. Read
      // live, this read flagged exactly that layout while the hint beside it asked for
      // it — two signals on one screen, disagreeing. Sending worked legs INTO a key run
      // is the collision; the stack read below still catches three hard days in a row.
      if (!liftIsBefore) continue;
      out.push({
        kind: kind === "long" ? "heavy_lower_adjacent_long_run" : "heavy_lower_adjacent_quality",
        days: [h, day].sort((a, b) => a - b),
        detail: `${cap(strengthDayLabel(byDay.get(h), h))} sits right ${liftIsBefore ? "before" : "after"} ${weekday(day)}'s ${runLabel(kind)}.`,
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

// ---- what is already behind the athlete ----

// A collision is only something to fix while it is still AHEAD. An adjacency whose lift
// day or run day is already closed (past, or today with the lift logged) happened; a
// stack none of whose heavy days is still open has nothing left in it to move. The
// read never asks the athlete to move a day they have already trained.
function liveCollisions(
  collisions: WeekLayoutCollision[],
  heavy: number[],
  closed: ReadonlySet<number>
): WeekLayoutCollision[] {
  if (!closed.size) return collisions;
  return collisions.filter((c) =>
    c.kind === "double_day_stack"
      ? c.days.some((d) => heavy.includes(d) && !closed.has(d))
      : !c.days.some((d) => closed.has(d))
  );
}

// ---- the smallest move that clears it ----

// Where this heavy day could go instead: the NEAREST free slot whose move leaves the
// week with no collisions at all. Candidates are restricted to day_numbers the plan
// actually has — a 4-day plan must never be told to move a lift onto day 5, 6 or 7,
// a day that doesn't exist for this athlete. Earlier is preferred at equal distance —
// pulling a leg day forward costs the athlete less than pushing it into the weekend,
// where the long run already lives. null when the week has nowhere clean to put it.
//
// LEGALITY is judged on the ring: the candidate is accepted only if re-running
// detectCollisions over the moved week comes back empty, and that now includes the
// 7↔1 wrap — so a lift can never be proposed onto the day cyclically beside the long
// run. The ORDERING above stays linear on purpose: it is a preference about the week
// the athlete lives through Monday to Sunday, not a claim about physiology, and
// ranking by ring distance would start recommending Sunday as the "nearest" slot to
// a Monday lift.
function clearingSlot(
  move: number,
  keyLower: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  loads: HeavyLowerDayLoad[],
  planDays: ReadonlySet<number>,
  closed: ReadonlySet<number> = new Set()
): number | null {
  // A closed day is never a slot: the athlete cannot lift a leg day into a day that has
  // already been trained or has already gone by.
  const candidates = [...planDays]
    .filter((t) => t !== move && t !== long && t !== quality && !heavy.includes(t) && !closed.has(t))
    .sort((a, b) => Math.abs(a - move) - Math.abs(b - move) || a - b);
  for (const to of candidates) {
    const swap = (days: number[]) => days.map((d) => (d === move ? to : d));
    const moved = swap(heavy);
    if (!liveCollisions(detectCollisions(swap(keyLower), moved, long, quality, loads), moved, closed).length) return to;
  }
  return null;
}

// The quality run's own day, when it holds a lighter strength session that the leg day
// can trade with and that trade clears every live collision. Calendar space only (the
// swap partner has to be a named session on that weekday). null otherwise.
function sameDaySwapSlot(
  move: number,
  keyLower: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  loads: HeavyLowerDayLoad[],
  strengthAt: ReadonlyMap<number, string>,
  closed: ReadonlySet<number>
): number | null {
  if (quality == null || quality === long || closed.has(quality) || heavy.includes(quality) || !strengthAt.has(quality))
    return null;
  const swap = (days: number[]) => days.map((d) => (d === move ? quality : d));
  const moved = swap(heavy);
  return liveCollisions(detectCollisions(swap(keyLower), moved, long, quality, loads), moved, closed).length
    ? null
    : quality;
}

// When no lift slot is left, the lightest remaining fix may be the RUN: one day later,
// onto an open day that is not a heavy leg day, not the other key run, and inside this
// week (a run is never pushed past Sunday into a week it does not belong to), and only
// when that clears every live collision. null when it does not.
//
// The athlete's stated run days are the run engine's calendar (CLAUDE.md "stated run
// days"): with a stated schedule the run only slides onto another STATED run weekday,
// and never onto a day that already holds a run of any kind. `runnable` answers both.
function laterRunSlot(
  kind: "long" | "quality",
  keyLower: number[],
  heavy: number[],
  long: number | null,
  quality: number | null,
  loads: HeavyLowerDayLoad[],
  closed: ReadonlySet<number>,
  runnable: (day: number) => boolean
): number | null {
  const day = kind === "long" ? long : quality;
  if (day == null || day >= 7) return null;
  const later = day + 1;
  if (closed.has(later) || heavy.includes(later) || later === (kind === "long" ? quality : long)) return null;
  if (!runnable(later)) return null;
  const nextLong = kind === "long" ? later : long;
  const nextQuality = kind === "quality" ? later : quality;
  return liveCollisions(detectCollisions(keyLower, heavy, nextLong, nextQuality, loads), heavy, closed).length
    ? null
    : later;
}

// ---- "hard days hard": where the heaviest lower lift day sits ----

const PLACEMENT_EVE_VARIANTS: ReadonlyArray<(lift: string, runDay: string, run: string) => string> = [
  (lift, runDay, run) => `${cap(lift)} sits the day before ${runDay}'s ${run}, so the legs go into that run already worked.`,
  (lift, runDay, run) => `The heaviest leg day this week, ${lift}, lands on the eve of ${runDay}'s ${run}.`,
  (lift, runDay, run) => `${runDay}'s ${run} follows straight on from ${lift}, so the run starts on tired legs.`,
];

const PLACEMENT_SAME_DAY_VARIANTS: ReadonlyArray<(lift: string, runDay: string, run: string) => string> = [
  (lift, runDay, run) => `${cap(lift)} shares ${runDay} with the ${run}, so the legs carry both on one day.`,
  (_lift, runDay, run) => `The heavy legs and the ${run} both land on ${runDay}, a lot to ask of the legs in one day.`,
  (lift, runDay, run) => `${runDay} carries both the ${run} and ${lift}, so that one day asks the legs for two hard efforts.`,
];

const PLACEMENT_DAY_AFTER_VARIANTS: ReadonlyArray<(lift: string, runDay: string, run: string) => string> = [
  (lift, runDay, run) => `${cap(lift)} comes the day after ${runDay}'s ${run}, while the legs are still carrying the run.`,
  (_lift, runDay, run) => `The heavy legs follow ${runDay}'s ${run}, so they start that session still carrying the run.`,
  (lift, runDay, run) => `${cap(lift)} lands right after ${runDay}'s ${run}, when the legs are still carrying it.`,
];

const PLACEMENT_NEUTRAL_VARIANTS: ReadonlyArray<(lift: string) => string> = [
  (lift) => `${cap(lift)} sits clear of the quality and long runs.`,
  (lift) => `The heaviest leg day, ${lift}, keeps its distance from the key runs this week.`,
  (lift) => `${cap(lift)} sits away from the key runs, neither right before one nor paired with one.`,
];

// A ring day (1 = Monday … 7 = Sunday) as a JS weekday (0 = Sunday), the key-run rule's own.
const ringDow = (day: number): number => day % 7;

const PLACEMENT_RANK: Readonly<Record<KeyRunRelation, number>> = { eve: 0, on: 1, after: 2 };

/**
 * Where the week's heaviest lower lift day sits against its quality and long run. Pure,
 * on the same ring the collision read uses, judged by the ONE proximity rule the live
 * placement trades on (key-run-proximity.ts `keyRunRelation`). Ties among the heaviest read
 * the worst placement first (an eve anywhere is the eve, then a run's own day, then the
 * day after one); on a tie between the runs the quality run speaks. null when there is no
 * heavy lower day or no key run.
 */
export function lowerLiftPlacement(
  heaviest: readonly number[],
  long: number | null,
  quality: number | null,
  date: string,
  loads: readonly HeavyLowerDayLoad[] = []
): LowerLiftPlacement | null {
  const days = heaviest.filter(onRing);
  const longDay = long != null && onRing(long) ? long : null;
  const qualityDay = quality != null && onRing(quality) ? quality : null;
  if (!days.length || (longDay == null && qualityDay == null)) return null;
  const byDay = new Map(loads.map((l) => [l.day_number, l]));
  const label = (day: number) => strengthDayLabel(byDay.get(day), day);
  const keyRunDows = [qualityDay, longDay].filter((d): d is number => d != null).map(ringDow);
  // The worst relation wins; between equals, the one against the quality run (the session
  // the heavy legs cost most), then the earlier day.
  let worst: { day: number; relation: KeyRunRelation; runDay: number; rank: number } | null = null;
  for (const h of days) {
    const relation = keyRunRelation(ringDow(h), keyRunDows);
    if (!relation) continue;
    const runAt = relation === "eve" ? nextDay(h) : relation === "on" ? h : prevDay(h);
    const runDay = runAt === qualityDay ? qualityDay : (longDay as number);
    const rank = PLACEMENT_RANK[relation] * 2 + (runDay === qualityDay ? 0 : 1);
    if (!worst || rank < worst.rank) worst = { day: h, relation, runDay, rank };
  }
  if (!worst) {
    return {
      state: "neutral",
      preferred: true,
      note: pickDayVariant(PLACEMENT_NEUTRAL_VARIANTS, date, "week-layout:lower-placement:neutral")(label(days[0])),
    };
  }
  const h = worst.day;
  const runDay = worst.runDay;
  const run = runDay === qualityDay ? "quality run" : "long run";
  if (worst.relation === "eve")
    return {
      state: "eve_of_key_run",
      preferred: false,
      note: pickDayVariant(PLACEMENT_EVE_VARIANTS, date, "week-layout:lower-placement:eve")(label(h), weekday(runDay), run),
    };
  if (worst.relation === "on")
    return {
      state: "on_key_run",
      preferred: false,
      note: pickDayVariant(PLACEMENT_SAME_DAY_VARIANTS, date, "week-layout:lower-placement:same-day")(
        label(h),
        weekday(runDay),
        run
      ),
    };
  return {
    state: "after_key_run",
    preferred: false,
    note: pickDayVariant(PLACEMENT_DAY_AFTER_VARIANTS, date, "week-layout:lower-placement:day-after")(
      label(h),
      weekday(runDay),
      run
    ),
  };
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
  opts?: {
    runPlan?: WeeklyRunPlan | null;
    agenda?: FlexibleTrainingAgenda | null;
    /**
     * The athlete's stated lifting / run weekdays as dow numbers (0 = Sunday). INJECTED
     * rather than read, for the same reason runPlan and agenda are: this module is a
     * leaf on purpose, and `src/repo/profile.ts` sits above it in the import graph
     * (profile -> intelligence -> day-read -> coach -> here), so reading them directly
     * would close a cycle. Every caller already imports profile; absence is neutral.
     */
    strengthDows?: readonly number[] | null;
    /** How `strengthDows` is known — the athlete's words, or their log. */
    liftDaysSource?: "stated" | "observed" | null;
    enduranceDows?: readonly number[] | null;
    /**
     * This week's weekday → plan day_number map (dow 0 = Sunday), from
     * `thisWeekPlanDayMap` — injected for the same leaf reason as the schedules.
     * Present and non-empty, the read judges the week on the CALENDAR: a plan whose
     * strength pool cycles across five stated lifting weekdays puts template day 1
     * on Friday some weeks, and "is the heavy day beside the long run" is a question
     * about Friday and Saturday, not about day 1 and day 6.
     */
    weekdayMap?: ReadonlyMap<number, number> | null;
    /**
     * What of THIS week is already behind the athlete (`weekLayoutClosed`,
     * src/repo/week-layout-closed.ts — injected for the same leaf reason). `days` are
     * weekday slots (Mon = 1 … Sun = 7): every weekday before the read day, plus the
     * read day once its lift is logged. They are honoured in CALENDAR space only — a
     * template ring has no dated week to close. No suggestion ever names one of them
     * (not the day to move, not where to, not a swap partner), and a collision on one
     * is history. `runs_done` marks a key run already completed this week, on whatever
     * day it was run: its collision is spent, in either space.
     */
    closed?: {
      days?: readonly number[] | null;
      runs_done?: { long?: boolean; quality?: boolean } | null;
    } | null;
  }
): WeekLayoutRead {
  const d = date || localDateISO();
  const lift_days = statedWeekdayNames(opts?.strengthDows);
  const stated = {
    lift_days,
    lift_days_source: lift_days.length ? (opts?.liftDaysSource ?? "stated") : null,
    run_days: statedWeekdayNames(opts?.enduranceDows),
  };

  let loads: HeavyLowerDayLoad[] = [];
  try {
    loads = heavyLowerDayLoads();
  } catch {
    loads = [];
  }
  // Filter the LOADS rather than the derived day list, so `heavy`, `heaviest` and the
  // label lookup all see the same week (see `onRing` above).
  loads = loads.filter((l) => onRing(l.day_number));
  let planDays: ReadonlySet<number> = new Set();
  try {
    planDays = new Set(
      planDayStrengthGroups()
        .map((d) => d.day_number)
        .filter(onRing)
    );
  } catch {
    planDays = new Set();
  }

  const placement = runPlacement(opts);
  const source = placement.source;

  // ---- calendar space ----
  // With a lifting week laid onto the weekdays, every template number becomes the
  // weekday(s) it lands on this week. A strength day the ring reaches twice (a
  // three-day pool across five lifting days) is heavy on BOTH weekdays. The engine's
  // run slots and the agenda's provisional numbers are already weekday-numbered
  // (Mon = 1), so the runs need no translating.
  const weekMap = opts?.weekdayMap && opts.weekdayMap.size ? opts.weekdayMap : null;
  const space: WeekLayoutRead["space"] = weekMap ? "calendar" : "template";
  // Calendar only: the strength day each weekday holds, by its stored name, so a move
  // onto a weekday that already lifts can be spoken as the swap it is.
  const strengthAt = new Map<number, string>();
  if (weekMap) {
    let groups: ReturnType<typeof planDayStrengthGroups> = [];
    try {
      groups = planDayStrengthGroups();
    } catch {
      groups = [];
    }
    const byNumber = new Map(groups.map((g) => [g.day_number, g]));
    for (let w = 1; w <= 7; w++) {
      const dn = weekMap.get(w === 7 ? 0 : w);
      const g = dn == null ? undefined : byNumber.get(dn);
      if (g && g.groups.length) strengthAt.set(w, (g.name || g.focus || "strength").trim());
    }
    const landings = new Map<number, number[]>();
    for (let w = 1; w <= 7; w++) {
      const dn = weekMap.get(w === 7 ? 0 : w);
      if (dn == null) continue;
      const list = landings.get(dn) ?? [];
      list.push(w);
      landings.set(dn, list);
    }
    loads = loads.flatMap((l) => (landings.get(l.day_number) ?? []).map((w) => ({ ...l, day_number: w })));
    planDays = new Set([...planDays].flatMap((dn) => landings.get(dn) ?? []));
  }
  // What is already behind the athlete this week. Days close only on the calendar; a
  // completed key run is spent in either space, and so is a run placed on a closed day
  // (it was run, or it went by — either way it is not ahead to protect).
  const closed = new Set<number>(weekMap ? (opts?.closed?.days ?? []).filter(onRing) : []);
  const runsDone = opts?.closed?.runs_done ?? null;
  const openRun = (day: number | null, done: boolean | undefined): number | null =>
    day == null || done || closed.has(day) ? null : day;
  // Where a run may slide to (laterRunSlot): a stated run weekday when the athlete has
  // a run schedule, and in every case a day the week has not already given a run.
  const statedRunDays = new Set(
    (opts?.enduranceDows ?? []).map((dow) => (Number(dow) === 0 ? 7 : Number(dow))).filter(onRing)
  );
  const occupiedRunDays = weekRunDays(opts);
  const runnableDay = (day: number): boolean =>
    !occupiedRunDays.has(day) && (!statedRunDays.size || statedRunDays.has(day));
  const long = openRun(placement.long, runsDone?.long);
  const quality = openRun(placement.quality, runsDone?.quality);
  const heavy = loads.map((l) => l.day_number);
  const top = loads[0];
  // Ties are kept whole: two lower days carrying identical work are genuinely both the
  // week's heaviest, and picking one by day number would hide a real collision on the other.
  const heaviest = top
    ? loads
        .filter((l) => l.tonnage === top.tonnage && l.compound_sets === top.compound_sets && l.sets === top.sets)
        .map((l) => l.day_number)
    : [];
  // The run days the read reports stay where the week placed them; only the collision
  // test reads past a run that is already done.
  // The week's SHAPE, read off the run placement as planned (a run already done still
  // tells where the hard days sit), never off the open-run filter below.
  const lowerPlacement = lowerLiftPlacement(heaviest, placement.long, placement.quality, d, loads);
  if (!heavy.length || (long == null && quality == null))
    return CLEAN(heaviest, heavy, placement.long, placement.quality, source, stated, space, lowerPlacement);

  // A heavy day already trained is history: it never leads an adjacency. (It still
  // counts as a hard day in a stack, where it is real fatigue beside what is ahead.)
  const keyLower = keyLowerDays(heaviest, loads).filter((day) => !closed.has(day));
  const collisions = liveCollisions(detectCollisions(keyLower, heavy, long, quality, loads), heavy, closed);
  if (!collisions.length)
    return CLEAN(heaviest, heavy, placement.long, placement.quality, source, stated, space, lowerPlacement);

  // The lead: an adjacency collision names a concrete move, so it speaks ahead of the
  // stack (which is usually the same problem seen wider).
  const lead = collisions.find((c) => c.kind !== "double_day_stack") ?? collisions[0];
  const byDay = new Map(loads.map((l) => [l.day_number, l]));

  let suggestion: string | null = null;
  let suggested_move: WeekLayoutRead["suggested_move"] = null;
  if (lead.kind === "double_day_stack") {
    // Move a heavy day out of the stack — the heaviest one in it when there is one,
    // otherwise the last, which is the one carrying the most accumulated fatigue.
    const inStack = lead.days.filter((day) => heavy.includes(day) && !closed.has(day));
    const move = inStack.find((day) => heaviest.includes(day)) ?? inStack[inStack.length - 1];
    const span = `${weekday(lead.days[0])} to ${weekday(lead.days[lead.days.length - 1])}`;
    const to = move == null ? null : clearingSlot(move, keyLower, heavy, long, quality, loads, planDays, closed);
    if (move != null && to != null) suggested_move = { from: move, to };
    const other = to == null ? null : (strengthAt.get(to) ?? null);
    suggestion =
      move != null && to != null
        ? other
          ? pickDayVariant(STACK_SWAP_VARIANTS, d, "week-layout:stack")(
              strengthDayLabel(byDay.get(move), move),
              other,
              weekday(to),
              span
            )
          : pickDayVariant(STACK_MOVE_VARIANTS, d, "week-layout:stack")(
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
    const to = clearingSlot(move, keyLower, heavy, long, quality, loads, planDays, closed);
    if (to != null) suggested_move = { from: move, to };
    const other = to == null ? null : (strengthAt.get(to) ?? null);
    const runKind = lead.kind === "heavy_lower_adjacent_long_run" ? "long" : "quality";
    const later =
      to == null ? laterRunSlot(runKind, keyLower, heavy, long, quality, loads, closed, runnableDay) : null;
    const sameDay =
      to == null && later == null
        ? sameDaySwapSlot(move, keyLower, heavy, long, quality, loads, strengthAt, closed)
        : null;
    if (sameDay != null) suggested_move = { from: move, to: sameDay };
    suggestion =
      to == null && later != null
        ? pickDayVariant(RUN_LATER_VARIANTS, d, `week-layout:${lead.kind}:run-later`)(
            lift,
            weekday(runDay as number),
            runWord,
            weekday(later)
          )
        : sameDay != null
          ? pickDayVariant(SAME_DAY_SWAP_VARIANTS, d, `week-layout:${lead.kind}:same-day`)(
              lift,
              strengthAt.get(sameDay) as string,
              weekday(sameDay),
              "quality run"
            )
          : to != null && other
            ? pickDayVariant(SWAP_VARIANTS, d, `week-layout:${lead.kind}`)(
                lift,
                other,
                weekday(to),
                weekday(runDay as number),
                runWord
              )
            : to != null
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
    space,
    collisions,
    suggestion,
    suggested_move,
    heaviest_lower_days: heaviest,
    heavy_lower_days: heavy,
    long_run_day: placement.long,
    quality_run_day: placement.quality,
    lift_days: stated.lift_days,
    lift_days_source: stated.lift_days_source,
    run_days: stated.run_days,
    source,
    lower_lift_placement: lowerPlacement,
  };
}
