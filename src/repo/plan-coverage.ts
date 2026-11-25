// ============================================================================
// plan-coverage.ts — does the plan AS WRITTEN leave a group or a movement family out,
// and what is the smallest change that would cover it?
//
// The plan compiler (plan-quality.ts) already knows both answers: a floored group under
// its weekly floor (weeklyFloorShortfalls — the one definition the `muscle_density_low`
// warning and the redraw precheck also read) and `movement_pattern_gap` (a broad week
// with no squat, hinge, press, pull or trunk work). The only place either was ever acted
// on was the redraw precheck, so a group missing from a hand-written plan stayed missing,
// silently. This module reads the same two answers off the plan of record and builds the
// concrete remedy the server can compute on its own: a set more on a lift the plan
// already has for the group, else a lift the athlete already knows (or a curated one)
// placed on the lightest day.
//
// TWO READS, so an ask never flickers with the week. The STANDING gap is judged on the
// plan as written against the athlete's intent alone — nothing that varies week to week
// (a light window, the race taper, the endurance carried lately, a trip, a cut) enters
// it. What varies is a HOLD: while one applies nothing new is asked, and nothing already
// asked is withdrawn for it either (coverage-ask.ts). Holds: every light window the
// floor stands aside for (a recovery week, a deload now or next, a deload-due read, the
// race taper/race week), a block's realization week, the post-race window, a trip, an
// affirmed cut; per element, a group the endurance work carries (over two OR six weeks)
// and the legs a strength-led taper trims.
//
// It decides nothing and writes nothing. The ask itself — a held draft through the
// ordinary propose → apply path — is domain/brain/coverage-ask.ts.
//
// Each gap carries a FINGERPRINT: the gap and the athlete's intent. An answered ask
// (applied or set aside) holds for that fingerprint until the gap materially worsens —
// COVERAGE_REASK_WORSE_BY fewer counted weekly sets than when it was answered — or the
// intent changes; swapping one lift for another at the same volume is not news.
// ============================================================================
import crypto from "node:crypto";
import { db } from "../db.js";
import { normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { classifyPattern, examplesForGroup, inferEquipment } from "./exercise-variations.js";
import { availableEquipment } from "./equipment.js";
import { injuryAffectsExercise, listContextEvents } from "./health.js";
import { primaryMuscleGroup } from "./muscle-credit.js";
import { getPlan } from "./plan.js";
import {
  MOVEMENT_PATTERN_FAMILIES,
  type MovementPatternFamily,
  type PlanQualityDay,
  occupiedPressSlots,
  planCoverageShortfalls,
  pressSlotKey,
} from "./plan-quality.js";
import { resolvedBlockPhase } from "./block-phase.js";
import { enduranceCarriedGroups } from "./progression.js";
import { inRaceRecovery } from "./race-recovery.js";
import { joinList, localDateISO } from "./shared.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { tripEventOn } from "./travel-days.js";
import { readVolumeFloorContext } from "./volume-floor-context.js";
import { type VolumeFloorContext, type VolumeFloorExemption, volumeFloorApplies } from "./volume-floor.js";
import { affirmedCutHoldsSetCount } from "./volume-tolerance.js";

/** The source every coverage draft is written under (plan_proposals.agent). */
export const COVERAGE_ASK_AGENT = "coverage-check";
/** The single instruction those drafts carry. Never `auto:`/`chat:` — no orphan sweep adopts it. */
export const COVERAGE_ASK_INSTRUCTION = "coverage: the plan as written leaves a gap";

export interface CoverageGapElement {
  /** "group:chest" or "pattern:hinge". */
  key: string;
  kind: "group" | "pattern";
  group?: string;
  pattern?: MovementPatternFamily;
  /** Counted weekly sets the plan gives the group, and its floor (group gaps only). */
  planned?: number;
  low?: number;
  fingerprint: string;
}

export interface PlanCoverageGap {
  date: string;
  elements: CoverageGapElement[];
}

/** Why nothing new is asked this week (coverage-ask.ts), or null. */
export type CoverageHoldReason = VolumeFloorExemption | "realization_phase" | "post_race" | "trip" | "affirmed_cut";

/** Why one gap is set aside this week while the rest of the week is not. */
export type CoverageElementHold = "endurance_carried" | "race_trimmed";

export interface PlanCoverageRead {
  date: string;
  /** ok, or unavailable when a read failed: then nothing is known, and nothing is raised or withdrawn. */
  status: "ok" | "unavailable";
  /** Every gap the plan as written leaves, judged against the athlete's intent alone. */
  standing: CoverageGapElement[];
  /** The standing gaps this week may raise: none under a week hold, minus per-element holds. */
  askable: CoverageGapElement[];
  /** A hold on the whole week (a light/race/trip/cut window), or null. */
  hold: CoverageHoldReason | null;
  /** fingerprint → why that one gap is held this week (endurance carries it, the taper trims it). */
  element_holds: Record<string, CoverageElementHold>;
}

/**
 * An answered gap is asked about again only once the plan gives it this many fewer counted
 * weekly sets than when it was answered: the gap got materially worse, which is news. A
 * lift swapped for another at the same volume, or a set moved between days, is not.
 */
export const COVERAGE_REASK_WORSE_BY = 2;

/** One slot a coverage offer depends on: a bumped slot's set count when it was offered, or an added lift. */
export interface CoverageBasisEntry {
  day_number: number;
  /** The lift's resolver identity (exercise:<id> or movement:<key>). */
  identity: string;
  /** The slot's sets when offered; null for a lift the offer ADDS. */
  sets: number | null;
}

export interface CoverageChange {
  day_number: number;
  exercise: string;
  sets: number;
  rep_low?: number;
  rep_high?: number;
  reason: string;
}

export interface CoverageRemedy {
  changes: CoverageChange[];
  /** One line saying what the change does, in plain words. */
  summary: string;
  /** Why it is offered, for the athlete: the gap and the offer. */
  explanation: string;
  /** The gap elements this remedy covers (only those are asked about). */
  covered: CoverageGapElement[];
  /** The plan slots the offer was computed against (coverageOfferStillFits). */
  basis: CoverageBasisEntry[];
}

// A remedy never asks for more than this many working sets of one lift, and never more
// than two extra on a lift the plan already has: the smallest change, not a rewrite.
const LIFT_SET_CEILING = 5;
const MAX_ADDED_PER_LIFT = 2;
// A group the plan barely touches gets at most this many new lifts, each on its own day.
const MAX_ADDITIONS_PER_GROUP = 3;
const ADDED_SETS_MIN = 2;
const ADDED_SETS_MAX = 4;
// A lift added only to bring a missing movement family into the week.
const PATTERN_ADDED_SETS = 2;
const ADDED_REP_LOW = 8;
const ADDED_REP_HIGH = 12;

// A held position or a carry is prescribed in seconds, and the remedy has no honest
// number of seconds to offer for a lift the athlete has never done; it only proposes
// rep work. A stored timed lift is skipped by its mode; a curated name by this.
const TIMED_NAME = /\b(plank|carry|walk|hold|hang)\b/i;

// What a family is called when the athlete reads it: what the week "leaves out", and
// what an added lift "brings into the week".
const FAMILY_WORDS: Record<MovementPatternFamily, string> = {
  "knee-dominant": "a squat or lunge",
  hinge: "a hinge, like a deadlift",
  "horizontal-push": "a chest press",
  "upper-pull": "a row or pulldown",
  trunk: "any trunk work",
};
const FAMILY_NOUNS: Record<MovementPatternFamily, string> = {
  "knee-dominant": "a squat or lunge",
  hinge: "a hinge",
  "horizontal-push": "a chest press",
  "upper-pull": "a row or pulldown",
  trunk: "trunk work",
};

// The group whose curated examples carry the family's movements.
const FAMILY_EXAMPLE_GROUPS: Record<MovementPatternFamily, string[]> = {
  "knee-dominant": ["quads"],
  hinge: ["hamstrings", "glutes"],
  "horizontal-push": ["chest"],
  "upper-pull": ["back"],
  trunk: ["core"],
};

// The families whose work a race taper's leg trim stands down.
const LEG_FAMILIES = new Set<MovementPatternFamily>(["knee-dominant", "hinge"]);

function fingerprint(parts: readonly string[]): string {
  return crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function strengthItems(day: any): any[] {
  return (Array.isArray(day?.items) ? day.items : []).filter(
    (item: any) =>
      item &&
      typeof item === "object" &&
      String(item.kind ?? "strength").toLowerCase() !== "cardio" &&
      String(item.exercise ?? "").trim()
  );
}

function strengthDays(plan: readonly any[]): any[] {
  return (Array.isArray(plan) ? plan : []).filter(
    (day) => String(day?.day_type ?? "training").toLowerCase() !== "rest" && strengthItems(day).length > 0
  );
}

// One lift's identity: the stored exercise it resolves to, else its conservative key.
function liftIdentity(name: string): string {
  try {
    const key = resolveExerciseName(name).key;
    if (key) return key;
  } catch {
    /* fall through to the conservative key */
  }
  return `movement:${normalizedExerciseKey(name)}`;
}

function storedGroup(item: any): string | null {
  return item?.muscle_group == null ? null : String(item.muscle_group);
}

function familyOf(name: string, group: string | null): MovementPatternFamily | null {
  const pattern = classifyPattern(name, group ?? undefined) ?? classifyPattern(name, primaryMuscleGroup(name, group) ?? undefined);
  if (!pattern) return null;
  return MOVEMENT_PATTERN_FAMILIES.find((family) => family.patterns.includes(pattern))?.key ?? null;
}

// The athlete's intent as the floor reads it — part of every fingerprint, so a changed
// priority is a different gap.
function intentKey(ctx: VolumeFloorContext): string {
  return `strength:${ctx.strength_priority ? 1 : 0}|muscle:${ctx.muscle_priority ? 1 : 0}`;
}

// The gaps in the plan AS WRITTEN: the floor context stripped of everything that varies
// week to week (a light window, the taper's trim, the endurance carried lately), so the
// answer moves only when the plan or the intent does. One arithmetic pass, no catalog reads.
function standingElements(days: any[], ctx: VolumeFloorContext): CoverageGapElement[] {
  const standingCtx: VolumeFloorContext = { ...ctx, exempt: null, endurance_carried: [], race_trimmed: undefined };
  if (!volumeFloorApplies(standingCtx)) return [];
  const intent = intentKey(standingCtx);
  const read = planCoverageShortfalls(days as PlanQualityDay[], standingCtx);
  const elements: CoverageGapElement[] = [];
  for (const short of read.groups) {
    elements.push({
      key: `group:${short.group}`,
      kind: "group",
      group: short.group,
      planned: Math.round(short.planned * 10) / 10,
      low: short.low,
      fingerprint: fingerprint(["group", short.group, intent]),
    });
  }
  for (const pattern of read.patterns) {
    elements.push({
      key: `pattern:${pattern}`,
      kind: "pattern",
      pattern,
      fingerprint: fingerprint(["pattern", pattern, intent]),
    });
  }
  return elements;
}

function attempt(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

// A hold on the whole week: every light window the floor stands aside for, then the
// windows the floor context does not carry — the days after a race, a trip, an affirmed
// cut (where the set count holds). Each read is fail-soft to "no hold".
function weekHold(today: string, ctx: VolumeFloorContext): CoverageHoldReason | null {
  if (ctx.exempt) return ctx.exempt;
  // A block's realization (peaking/test) week deliberately trims volume; the floor itself
  // does not stand aside for it, but an ask to ADD work that week is the wrong moment.
  if (attempt(() => resolvedBlockPhase(today) === "realization")) return "realization_phase";
  if (attempt(() => affirmedCutHoldsSetCount(today))) return "affirmed_cut";
  if (attempt(() => inRaceRecovery(today))) return "post_race";
  if (attempt(() => tripEventOn(today) != null)) return "trip";
  return null;
}

// Is this one element held this week, and why? A group the endurance work carries — read
// over two weeks (the floor's own window) OR, for the ask, six, so one quiet fortnight of
// running never reopens it — and, in a strength-led taper, the legs the stress budget trims.
function elementHold(
  element: CoverageGapElement,
  carried: ReadonlySet<string>,
  trimmed: ReadonlySet<string>
): CoverageElementHold | null {
  if (element.kind === "group") {
    const group = String(element.group ?? "").toLowerCase();
    if (trimmed.has(group)) return "race_trimmed";
    return carried.has(group) ? "endurance_carried" : null;
  }
  return trimmed.size > 0 && !!element.pattern && LEG_FAMILIES.has(element.pattern) ? "race_trimmed" : null;
}

/**
 * The plan of record's coverage for `date`: the STANDING gaps (the plan as written against
 * the athlete's intent), what of it may be asked this week, the week's hold and each held
 * element's own reason. A caller already holding the live floor context may hand it in
 * (then its two-week endurance-carried list is the only one read — exactly what the
 * redraw precheck enforces). A read that FAILED is `status:"unavailable"`, never an empty
 * answer: the ask raises nothing and withdraws nothing on it.
 */
export function readPlanCoverage(
  date = localDateISO(),
  opts: { plan?: PlanQualityDay[]; context?: VolumeFloorContext | null } = {}
): PlanCoverageRead {
  const today = String(date || localDateISO()).slice(0, 10);
  const unavailable: PlanCoverageRead = {
    date: today,
    status: "unavailable",
    standing: [],
    askable: [],
    hold: null,
    element_holds: {},
  };
  try {
    // readVolumeFloorContext answers null only when its own read failed.
    const ctx = opts.context !== undefined ? opts.context : readVolumeFloorContext(today);
    if (!ctx) return unavailable;
    const days = (opts.plan ?? (getPlan() as PlanQualityDay[])) as any[];
    const standing = standingElements(days, ctx);
    const base: PlanCoverageRead = { date: today, status: "ok", standing, askable: [], hold: null, element_holds: {} };
    if (!standing.length) return base;
    const carried = new Set<string>((ctx.endurance_carried ?? []).map((g) => String(g).toLowerCase()));
    if (opts.context === undefined) {
      try {
        for (const group of enduranceCarriedGroups(6, today)) carried.add(String(group).toLowerCase());
      } catch {
        /* the two-week read already in the context stands */
      }
    }
    const trimmed = new Set<string>((ctx.race_trimmed ?? []).map((g) => String(g).toLowerCase()));
    const element_holds: Record<string, CoverageElementHold> = {};
    for (const el of standing) {
      const held = elementHold(el, carried, trimmed);
      if (held) element_holds[el.fingerprint] = held;
    }
    const hold = weekHold(today, ctx);
    const askable = hold ? [] : standing.filter((el) => !element_holds[el.fingerprint]);
    return { ...base, askable, hold, element_holds };
  } catch {
    return unavailable;
  }
}

/**
 * The coverage gaps this week may raise (readPlanCoverage's `askable`): empty under a
 * week hold, and without a group the endurance work carries or a leg family a
 * strength-led taper trims. Fail-soft to empty.
 */
export function planCoverageGap(
  date = localDateISO(),
  opts: { plan?: PlanQualityDay[]; context?: VolumeFloorContext | null } = {}
): PlanCoverageGap {
  const read = readPlanCoverage(date, opts);
  return { date: read.date, elements: read.askable };
}

/** A compact, plain-words fact the plan-shaping prompts carry (coach context `coverage_gaps`). */
export interface CoverageGapFact {
  gap: string;
  missing: string;
  /** Why this gap is set aside THIS week, in plain words: leave it alone. */
  held?: string;
  /** The athlete already set this gap aside: leave it unless they ask. */
  declined?: true;
}

// Why a gap is set aside this week, as the prompt reads it.
const HOLD_WORDS: Record<CoverageHoldReason | CoverageElementHold | "injury", string> = {
  recovery_week: "a recovery week is in force or about to start",
  deload_phase: "the block is in, or about to enter, its deload",
  deload_due: "a deload is due",
  race_taper: "this is the race taper or race week",
  realization_phase: "this is the block's peaking week",
  post_race: "these are the recovery days after a race",
  trip: "the athlete is travelling",
  affirmed_cut: "an affirmed cut holds the set count",
  endurance_carried: "their endurance training already carries this group",
  race_trimmed: "the race taper trims the legs",
  injury: "an open injury loads this work",
};

// Does an open injury load the work a gap would add? A group gap by its group (and the
// curated lifts that train it), a missing family by the lifts that would bring it in.
function gapLoadsInjury(element: CoverageGapElement, loads: (name: string, group: string | null) => boolean): boolean {
  const groups = element.kind === "group" ? [String(element.group ?? "")] : FAMILY_EXAMPLE_GROUPS[element.pattern as MovementPatternFamily] ?? [];
  return groups.some((group) => {
    if (!group) return false;
    if (loads(group, group)) return true;
    const examples = examplesForGroup(group, 3).filter((name) => element.kind === "group" || familyOf(name, null) === element.pattern);
    return examples.length > 0 && examples.every((name) => loads(name, group));
  });
}

/**
 * The standing gaps as the plan-shaping prompts are handed them (DATA.coverage_gaps), so a
 * redraw or an evolution closes the hole instead of shipping a new program with it — and
 * agreeing with what the floor would enforce on that draft right now: a gap the week holds
 * (a light window, the taper, a trip, a cut), one the endurance work carries or the taper
 * trims, and one an open injury loads each carry `held` with the reason in plain words; one
 * the athlete declined carries `declined:true`. Callers holding the slice's floor context
 * and plan hand them in, so this adds no second context read. Empty when the read failed.
 */
export function coverageGapFacts(
  date = localDateISO(),
  opts: { plan?: PlanQualityDay[]; context?: VolumeFloorContext | null } = {}
): CoverageGapFact[] {
  const read = readPlanCoverage(date, opts);
  if (read.status !== "ok" || !read.standing.length) return [];
  const declined = declinedCoverage(read.standing);
  const loads = openInjuryLoads(read.date);
  return read.standing.map((el) => {
    const missing =
      el.kind === "group"
        ? `the week gives ${el.group} fewer working sets than its weekly floor`
        : `the week has no ${FAMILY_NOUNS[el.pattern as MovementPatternFamily]}`;
    const reason = read.hold ?? read.element_holds[el.fingerprint] ?? (gapLoadsInjury(el, loads) ? "injury" : null);
    return {
      gap: el.kind === "group" ? String(el.group) : FAMILY_NOUNS[el.pattern as MovementPatternFamily],
      missing,
      ...(reason ? { held: HOLD_WORDS[reason] } : {}),
      ...(declined.has(el.fingerprint) ? { declined: true as const } : {}),
    };
  });
}

interface Candidate {
  name: string;
  group: string | null;
}

// Lifts the athlete has logged, most-logged first — a lift they already know is a
// better offer than a catalog name — then the curated examples for the group.
function knownLifts(): Array<Candidate & { mode: string | null }> {
  try {
    return (
      db
        .prepare(
          `SELECT e.name AS name, e.muscle_group AS muscle_group, e.mode AS mode, COUNT(ls.id) AS n
             FROM exercises e JOIN logged_sets ls ON ls.exercise_id = e.id
            GROUP BY e.id
            ORDER BY n DESC, e.id ASC
            LIMIT 200`
        )
        .all() as any[]
    ).map((row) => ({
      name: String(row.name),
      group: row.muscle_group == null ? null : String(row.muscle_group),
      mode: row.mode == null ? null : String(row.mode),
    }));
  } catch {
    return [];
  }
}

function storedModeOf(name: string): string | null {
  try {
    const id = resolveExerciseName(name).exercise_id;
    if (id == null) return null;
    const row = db.prepare(`SELECT mode FROM exercises WHERE id = ?`).get(id) as any;
    return row?.mode == null ? null : String(row.mode);
  } catch {
    return null;
  }
}

function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five"][n] ?? String(n);
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

const OPENERS: ReadonlyArray<(clause: string) => string> = [
  (clause) => `As written, your week ${clause}.`,
  (clause) => `Looking at the whole week, your plan ${clause}.`,
  (clause) => `Your plan as it stands ${clause}.`,
];

const OFFERS: readonly string[] = [
  "The change here is the smallest one that covers it, and it is yours to take or leave.",
  "Here is the smallest change that would cover it, if you want it.",
  "One small change would cover it; it is your call.",
];

/** The athlete-facing sentence for a set of covered gaps. Rotates by day. */
export function coverageExplanation(covered: readonly CoverageGapElement[], date = localDateISO()): string {
  const groups = covered.filter((el) => el.kind === "group" && el.group).map((el) => String(el.group));
  const families = covered
    .filter((el) => el.kind === "pattern" && el.pattern)
    .map((el) => FAMILY_WORDS[el.pattern as MovementPatternFamily]);
  const clauses: string[] = [];
  if (groups.length)
    clauses.push(
      `gives your ${joinList(groups)} less work than ${groups.length === 1 ? "it needs" : "they need"} to keep building`
    );
  if (families.length) clauses.push(`leaves out ${joinList(families)}`);
  const clause = clauses.join(", and ");
  const key = covered.map((el) => el.key).join(",");
  return `${pickDayVariant(OPENERS, date, `coverage_open:${key}`)(clause)} ${pickDayVariant(OFFERS, date, `coverage_offer:${key}`)}`;
}

/**
 * The smallest change the server can compute that covers `elements` on `plan`, or null
 * when it can offer nothing concrete. Pure over its inputs plus catalog reads.
 */
export function coverageRemedy(
  elements: readonly CoverageGapElement[],
  opts: { date?: string; plan?: PlanQualityDay[] } = {}
): CoverageRemedy | null {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  const days = strengthDays((opts.plan ?? (getPlan() as PlanQualityDay[])) as any[]).sort(
    (a, b) => Number(a.day_number) - Number(b.day_number)
  );
  if (!days.length) return null;
  const dayName = new Map<number, string>(
    days.map((day) => [Number(day.day_number), String(day.name ?? "").trim() || `day ${Number(day.day_number)}`])
  );
  const daySets = new Map<number, number>(
    days.map((day) => [
      Number(day.day_number),
      strengthItems(day).reduce((sum: number, item: any) => sum + (Number(item.sets) || 0), 0),
    ])
  );
  const dayNames = new Map<number, string[]>(
    days.map((day) => [Number(day.day_number), strengthItems(day).map((item: any) => String(item.exercise))])
  );
  const onPlan = new Set<string>(days.flatMap((day) => strengthItems(day).map((i: any) => liftIdentity(String(i.exercise)))));
  const bumps = new Map<string, { day_number: number; exercise: string; from: number; to: number; reason: string }>();
  const adds: Array<CoverageChange & { family: MovementPatternFamily | null; slot: string | null }> = [];
  const covered: CoverageGapElement[] = [];

  // An open injury is the athlete's own reason for a gap: nothing here adds work to a
  // lift it loads, and a slot carrying a constraint note is never bumped. A gap that
  // leaves nothing safe to offer simply is not asked.
  const injuryLoads = openInjuryLoads(date);

  let known: ReturnType<typeof knownLifts> | null = null;
  let equipment: string[] | null = null;
  const candidatesFor = (groups: string[]): Candidate[] => {
    known ??= knownLifts();
    equipment ??= availableEquipment();
    const curated = groups
      .flatMap((group) => examplesForGroup(group, 9))
      .filter((name) => !TIMED_NAME.test(name))
      .filter((name) => {
        const kind = inferEquipment(name);
        return !equipment!.length || kind === "bodyweight" || equipment!.includes(kind);
      })
      .filter((name) => storedModeOf(name) !== "timed")
      .map((name) => ({ name, group: null }));
    return [...known.filter((lift) => lift.mode !== "timed"), ...curated];
  };

  // Place one new lift: the first candidate not already on the plan (or already added),
  // on the lightest day the element has not used yet whose press angle is free.
  const place = (
    fits: (candidate: Candidate) => boolean,
    groups: string[],
    sets: number,
    reason: string,
    usedDays: Set<number>
  ): (CoverageChange & { family: MovementPatternFamily | null; slot: string | null }) | null => {
    const order = [...days]
      .map((day) => Number(day.day_number))
      .filter((n) => !usedDays.has(n))
      .sort((a, b) => (daySets.get(a) ?? 0) - (daySets.get(b) ?? 0) || a - b);
    const addedSlots = new Set(adds.map((add) => add.slot).filter(Boolean));
    for (const candidate of candidatesFor(groups)) {
      const identity = liftIdentity(candidate.name);
      if (onPlan.has(identity) || !fits(candidate) || injuryLoads(candidate.name, candidate.group)) continue;
      const slot = pressSlotKey(candidate.name);
      if (slot && addedSlots.has(slot)) continue;
      const day = order.find((n) => !slot || !occupiedPressSlots(dayNames.get(n) ?? []).has(slot));
      if (day == null) continue;
      const add = {
        day_number: day,
        exercise: candidate.name,
        sets,
        rep_low: ADDED_REP_LOW,
        rep_high: ADDED_REP_HIGH,
        reason,
        family: familyOf(candidate.name, candidate.group),
        slot,
      };
      adds.push(add);
      onPlan.add(identity);
      dayNames.set(day, [...(dayNames.get(day) ?? []), candidate.name]);
      daySets.set(day, (daySets.get(day) ?? 0) + sets);
      usedDays.add(day);
      return add;
    }
    return null;
  };

  for (const element of elements) {
    if (element.kind !== "group" || !element.group || element.low == null) continue;
    const group = element.group;
    let short = element.low - (element.planned ?? 0);
    if (short <= 0) continue;
    const reason = `Covers your ${group} across the week.`;
    let changed = false;
    // 1. A set more on a lift the plan already has for the group, one pass at a time.
    const primaries = days.flatMap((day) =>
      strengthItems(day)
        .filter((item: any) => Number.isInteger(Number(item.sets)) && Number(item.sets) > 0)
        .filter((item: any) => primaryMuscleGroup(String(item.exercise), storedGroup(item)) === group)
        .filter((item: any) => !item.constraint_note && !injuryLoads(String(item.exercise), storedGroup(item)))
        .map((item: any) => ({ day_number: Number(day.day_number), exercise: String(item.exercise), sets: Number(item.sets) }))
    );
    for (let pass = 0; pass < MAX_ADDED_PER_LIFT && short > 0; pass++) {
      for (const item of primaries) {
        if (short <= 0) break;
        const slotKey = `${item.day_number}|${item.exercise}`;
        const bump = bumps.get(slotKey) ?? { ...item, from: item.sets, to: item.sets, reason };
        if (bump.to >= LIFT_SET_CEILING) continue;
        bump.to += 1;
        bumps.set(slotKey, bump);
        daySets.set(item.day_number, (daySets.get(item.day_number) ?? 0) + 1);
        short -= 1;
        changed = true;
      }
    }
    // 2. Still short: a lift for the group, on its own day each time.
    const usedDays = new Set<number>();
    for (let n = 0; n < MAX_ADDITIONS_PER_GROUP && short > 0; n++) {
      const sets = Math.min(ADDED_SETS_MAX, Math.max(ADDED_SETS_MIN, Math.ceil(short)));
      const add = place((c) => primaryMuscleGroup(c.name, c.group) === group, [group], sets, reason, usedDays);
      if (!add) break;
      short -= sets;
      changed = true;
    }
    if (changed) covered.push(element);
  }

  for (const element of elements) {
    if (element.kind !== "pattern" || !element.pattern) continue;
    const family = element.pattern;
    // A lift added for a group above may already be of this family.
    if (adds.some((add) => add.family === family)) {
      covered.push(element);
      continue;
    }
    const add = place(
      (c) => familyOf(c.name, c.group) === family,
      FAMILY_EXAMPLE_GROUPS[family],
      PATTERN_ADDED_SETS,
      `Brings ${FAMILY_NOUNS[family]} into the week.`,
      new Set<number>()
    );
    if (add) covered.push(element);
  }

  if (!covered.length) return null;
  const changes: CoverageChange[] = [
    ...[...bumps.values()].map((bump) => ({
      day_number: bump.day_number,
      exercise: bump.exercise,
      sets: bump.to,
      reason: bump.reason,
    })),
    ...adds.map(({ family: _family, slot: _slot, ...change }) => change),
  ];
  // What the change does, one short sentence per step: "Two more sets of A and B. On
  // Pull, add C and D, two sets each." Day NAMES, not numbers, so the lines read as the
  // athlete's own week.
  const byStep = new Map<number, string[]>();
  for (const bump of bumps.values()) {
    const step = bump.to - bump.from;
    byStep.set(step, [...new Set([...(byStep.get(step) ?? []), bump.exercise])]);
  }
  const sentences = [...byStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, names]) => `${capitalize(numberWord(step))} more ${step === 1 ? "set" : "sets"} of ${joinList(names)}.`);
  const addsByDay = new Map<number, typeof adds>();
  for (const add of adds) addsByDay.set(add.day_number, [...(addsByDay.get(add.day_number) ?? []), add]);
  for (const [day, dayAdds] of addsByDay) {
    const sameSets = dayAdds.every((add) => add.sets === dayAdds[0].sets);
    const lifts = sameSets
      ? `${joinList(dayAdds.map((add) => add.exercise))}, ${numberWord(dayAdds[0].sets)} sets${dayAdds.length > 1 ? " each" : ""}`
      : joinList(dayAdds.map((add) => `${add.exercise} for ${numberWord(add.sets)} sets`));
    sentences.push(`On ${dayName.get(day)}, add ${lifts}.`);
  }
  return {
    changes,
    summary: sentences.join(" "),
    explanation: coverageExplanation(covered, date),
    covered,
    basis: [
      ...[...bumps.values()].map((bump) => ({
        day_number: bump.day_number,
        identity: liftIdentity(bump.exercise),
        sets: bump.from,
      })),
      ...adds.map((add) => ({ day_number: add.day_number, identity: liftIdentity(add.exercise), sets: null })),
    ],
  };
}


// The open injuries on `date`, as one predicate: does this lift load any of them?
function openInjuryLoads(date: string): (name: string, group: string | null) => boolean {
  let injuries: any[] = [];
  try {
    injuries = (listContextEvents({ activeOnly: true, on: date }) as any[]).filter((e) => e?.kind === "injury");
  } catch {
    injuries = [];
  }
  return (name: string, group: string | null) =>
    injuries.some((injury) => injuryAffectsExercise(injury, { name, muscle_group: group }));
}

/**
 * Does a standing offer still say what it said when it was made? Every slot it bumps is
 * still on that day at the set count it was offered against (an absolute count written
 * over a slot the athlete has since edited would land yesterday's numbers), no lift it
 * adds is on the plan yet, its day still lifts, nothing it touches carries a constraint
 * note, and no injury opened since loads any lift it names. Null when a read failed.
 */
export function coverageOfferStillFits(
  changes: readonly CoverageChange[],
  basis: readonly CoverageBasisEntry[],
  opts: { date?: string; plan?: PlanQualityDay[] } = {}
): boolean | null {
  const date = String(opts.date || localDateISO()).slice(0, 10);
  try {
    const days = strengthDays((opts.plan ?? (getPlan() as PlanQualityDay[])) as any[]);
    if (!Array.isArray(basis) || !basis.length) return false;
    const onPlan = new Set<string>(days.flatMap((day) => strengthItems(day).map((i: any) => liftIdentity(String(i.exercise)))));
    for (const entry of basis) {
      const day = days.find((d) => Number(d.day_number) === Number(entry.day_number));
      if (!day) return false;
      if (entry.sets == null) {
        if (onPlan.has(String(entry.identity))) return false;
        continue;
      }
      const item = strengthItems(day).find((i: any) => liftIdentity(String(i.exercise)) === String(entry.identity));
      if (!item || Number(item.sets) !== Number(entry.sets) || item.constraint_note) return false;
    }
    const injuryLoads = openInjuryLoads(date);
    return !(Array.isArray(changes) ? changes : []).some((change) => {
      let group: string | null = null;
      try {
        const id = resolveExerciseName(String(change?.exercise ?? "")).exercise_id;
        const row = id == null ? null : (db.prepare(`SELECT muscle_group FROM exercises WHERE id = ?`).get(id) as any);
        group = row?.muscle_group == null ? null : String(row.muscle_group);
      } catch {
        group = null;
      }
      return injuryLoads(String(change?.exercise ?? ""), group);
    });
  } catch {
    return null; // unknown: a read failed, which is never evidence the offer went stale
  }
}

export interface CoverageAskElementRow {
  key: string;
  fingerprint: string;
  planned: number | null;
}

export interface CoverageAskRow {
  id: number;
  status: string;
  elements: CoverageAskElementRow[];
  fingerprints: string[];
}

// The statuses a PERSON gave an ask: applied is a yes; discarded/rejected are a no.
const ANSWER_YES = new Set(["applied"]);
const ANSWER_NO = new Set(["discarded", "rejected"]);

function askRow(row: { id: unknown; status: unknown; parsed_json: unknown }): CoverageAskRow {
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
  } catch {
    parsed = null;
  }
  const elements: CoverageAskElementRow[] = (Array.isArray(parsed?.coverage_gap?.elements) ? parsed.coverage_gap.elements : [])
    .map((el: any) => ({
      key: String(el?.key ?? ""),
      fingerprint: String(el?.fingerprint ?? ""),
      planned: el?.planned == null || !Number.isFinite(Number(el.planned)) ? null : Number(el.planned),
    }))
    .filter((el: CoverageAskElementRow) => el.fingerprint);
  return {
    id: Number(row.id),
    status: String(row.status ?? ""),
    elements,
    fingerprints: elements.map((el) => el.fingerprint),
  };
}

/**
 * The coverage asks the ASK itself needs, newest first: the open ones and every one a person
 * answered. Superseded rows (withdrawn by the server, never answered) are not read at all,
 * so however many of those pile up, no answer is ever pushed out of the window. Read by
 * raisePlanCoverageAsk only — on a person's plan save and the daily pass. The coach context
 * (and so Today's coaching focus) reads the bounded declinedCoverage below instead.
 */
export function coverageAskRows(): CoverageAskRow[] {
  try {
    return (
      db
        .prepare(
          `SELECT id, status, parsed_json FROM plan_proposals
            WHERE agent = ? AND status IN ('draft', 'applied', 'discarded', 'rejected')
            ORDER BY id DESC`
        )
        .all(COVERAGE_ASK_AGENT) as any[]
    ).map(askRow);
  } catch {
    return [];
  }
}

// Is this element materially worse than when it was answered (planned sets then)?
function worseThan(element: CoverageGapElement, plannedThen: number | null): boolean {
  return (
    element.kind === "group" &&
    plannedThen != null &&
    element.planned != null &&
    element.planned <= plannedThen - COVERAGE_REASK_WORSE_BY
  );
}

/**
 * What the athlete already said about each gap, from the asks they answered (newest answer
 * wins), keyed by fingerprint (the gap and the intent, so a changed intent is a new gap).
 * An element counts as answered while it is not materially worse than when they answered
 * (COVERAGE_REASK_WORSE_BY).
 */
export function answeredCoverage(rows: readonly CoverageAskRow[]): {
  answered: (element: CoverageGapElement) => boolean;
  declined: (element: CoverageGapElement) => boolean;
} {
  const byFingerprint = new Map<string, { no: boolean; planned: number | null }>();
  for (const row of rows) {
    const no = ANSWER_NO.has(row.status);
    if (!no && !ANSWER_YES.has(row.status)) continue;
    for (const el of row.elements) {
      if (!byFingerprint.has(el.fingerprint)) byFingerprint.set(el.fingerprint, { no, planned: el.planned });
    }
  }
  const lookup = (element: CoverageGapElement) => {
    const answer = byFingerprint.get(element.fingerprint) ?? null;
    return answer && !worseThan(element, answer.planned) ? answer : null;
  };
  return {
    answered: (element) => lookup(element) != null,
    declined: (element) => lookup(element)?.no === true,
  };
}

/**
 * The fingerprints among `elements` whose newest answer is a "no" that still holds — the
 * bounded read the coach context makes. Only answered rows are read, newest first, a page at a
 * time, and the scan stops as soon as every element has met its newest answer (or the
 * oldest row is reached), so no request pays for the whole history.
 */
const DECLINED_PAGE = 20;

export function declinedCoverage(elements: readonly CoverageGapElement[]): Set<string> {
  const out = new Set<string>();
  const pending = new Map(elements.map((el) => [el.fingerprint, el]));
  if (!pending.size) return out;
  try {
    // Keyset pages (the shared statement cache forbids a half-stepped iterator, src/db.ts).
    const page = db.prepare(
      `SELECT id, status, parsed_json FROM plan_proposals
        WHERE agent = ? AND status IN ('applied', 'discarded', 'rejected') AND id < ?
        ORDER BY id DESC LIMIT ${DECLINED_PAGE}`
    );
    let before = Number.MAX_SAFE_INTEGER;
    while (pending.size) {
      const rows = page.all(COVERAGE_ASK_AGENT, before) as any[];
      if (!rows.length) break;
      for (const raw of rows) {
        const row = askRow(raw);
        for (const el of row.elements) {
          const element = pending.get(el.fingerprint);
          if (!element) continue;
          pending.delete(el.fingerprint);
          if (ANSWER_NO.has(row.status) && !worseThan(element, el.planned)) out.add(el.fingerprint);
        }
        if (!pending.size) break;
      }
      before = Number(rows[rows.length - 1].id);
    }
  } catch {
    /* an unreadable history marks nothing declined */
  }
  return out;
}
