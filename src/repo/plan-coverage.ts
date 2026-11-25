// ============================================================================
// plan-coverage.ts — does the plan AS WRITTEN leave a group or a movement family out,
// and what is the smallest change that would cover it?
//
// The plan compiler (plan-quality.ts) already knows both answers and says them as
// WARNINGS: `muscle_density_low` (a floored group under its weekly floor, volume-floor.ts)
// and `movement_pattern_gap` (a broad week with no squat, hinge, press, pull or trunk
// work). The only place either was ever acted on was the redraw precheck, so a group
// missing from a hand-written plan stayed missing, silently. This module reads the SAME
// two warnings off the plan of record — no new threshold, every existing exemption kept
// (intent and light weeks through volumeFloorApplies, endurance-carried groups and the
// race taper's leg trim through weeklySetTargets, an affirmed cut below) — and builds the
// concrete remedy the server can compute on its own: a set more on a lift the plan
// already has for the group, else a lift the athlete already knows (or a curated one)
// placed on the lightest day.
//
// It decides nothing and writes nothing. The ask itself — a held draft through the
// ordinary propose → apply path — is domain/brain/coverage-ask.ts.
//
// Each gap carries a FINGERPRINT: the gap, the athlete's intent, and the plan lifts that
// bear on it. An ask the athlete answered (applied or set aside) is never raised again
// for the same fingerprint, so a "no" holds until the plan or the intent changes in a
// way that touches that gap.
// ============================================================================
import crypto from "node:crypto";
import { db } from "../db.js";
import { normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { classifyPattern, examplesForGroup, inferEquipment } from "./exercise-variations.js";
import { availableEquipment } from "./equipment.js";
import { injuryAffectsExercise, listContextEvents } from "./health.js";
import { isCountedShare, muscleCreditsShared, primaryMuscleGroup } from "./muscle-credit.js";
import { getPlan } from "./plan.js";
import {
  MOVEMENT_PATTERN_FAMILIES,
  type MovementPatternFamily,
  type PlanQualityDay,
  occupiedPressSlots,
  plannedWeeklyGroupSets,
  pressSlotKey,
  validateTrainingPlan,
} from "./plan-quality.js";
import { joinList, localDateISO } from "./shared.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { readVolumeFloorContext } from "./volume-floor-context.js";
import { type VolumeFloorContext, volumeFloorApplies, weeklySetTargets } from "./volume-floor.js";
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

/**
 * The coverage gaps in the plan of record for `date`, as the plan compiler reads them.
 * Empty whenever no floor applies (no muscle/strength priority, a light week, the
 * taper), during an affirmed cut (the set count holds there), or when the plan is too
 * small to be read as a week. Fail-soft to empty.
 */
export function planCoverageGap(
  date = localDateISO(),
  opts: { plan?: PlanQualityDay[]; context?: VolumeFloorContext | null } = {}
): PlanCoverageGap {
  const today = String(date || localDateISO()).slice(0, 10);
  const none: PlanCoverageGap = { date: today, elements: [] };
  try {
    // A caller already holding the live context may hand it in; otherwise it is read.
    const ctx = opts.context !== undefined ? opts.context : readVolumeFloorContext(today);
    if (!volumeFloorApplies(ctx)) return none;
    if (affirmedCutHoldsSetCount(today)) return none;
    const days = (opts.plan ?? (getPlan() as PlanQualityDay[])) as any[];
    const report = validateTrainingPlan(days, { volumeFloor: ctx });
    const planned = plannedWeeklyGroupSets(days);
    const lows = new Map(weeklySetTargets(ctx).map((target) => [target.group, target.low]));
    const intent = `strength:${ctx.strength_priority ? 1 : 0}|muscle:${ctx.muscle_priority ? 1 : 0}`;
    const legsTrimmed = (ctx.race_trimmed ?? []).length > 0;
    const lifting = strengthDays(days);
    const elements: CoverageGapElement[] = [];
    for (const warning of report.warnings) {
      if (warning.code === "muscle_density_low" && warning.muscle_group) {
        const group = warning.muscle_group;
        const low = lows.get(group);
        if (low == null) continue;
        // The lifts that bear on this group: a change among THEM is what makes a "no"
        // to this gap worth asking again; an unrelated edit elsewhere in the week is not.
        const bearing = new Set<string>();
        for (const day of lifting)
          for (const item of strengthItems(day)) {
            const credits = muscleCreditsShared(String(item.exercise), storedGroup(item));
            if (credits.some((c) => c.group === group && (c.role === "primary" || isCountedShare(c.share))))
              bearing.add(liftIdentity(String(item.exercise)));
          }
        elements.push({
          key: `group:${group}`,
          kind: "group",
          group,
          planned: Math.round((planned.get(group as any) ?? 0) * 10) / 10,
          low,
          fingerprint: fingerprint(["group", group, intent, ...[...bearing].sort()]),
        });
      } else if (warning.code === "movement_pattern_gap" && warning.pattern) {
        if (legsTrimmed && LEG_FAMILIES.has(warning.pattern)) continue;
        // Nothing on the plan is a lift of the missing family, so its "no" re-opens on a
        // new shape of week (a different number of lifting days), never on an edit.
        elements.push({
          key: `pattern:${warning.pattern}`,
          kind: "pattern",
          pattern: warning.pattern,
          fingerprint: fingerprint(["pattern", warning.pattern, intent, `days:${lifting.length}`]),
        });
      }
    }
    return { date: today, elements };
  } catch {
    return none;
  }
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
  let injuries: any[] = [];
  try {
    injuries = (listContextEvents({ activeOnly: true, on: date }) as any[]).filter((e) => e?.kind === "injury");
  } catch {
    injuries = [];
  }
  const injuryLoads = (name: string, group: string | null): boolean =>
    injuries.some((injury) => injuryAffectsExercise(injury, { name, muscle_group: group }));

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
  };
}

export interface CoverageAskRow {
  id: number;
  status: string;
  fingerprints: string[];
}

/** Every coverage draft ever written, newest first, with the gap fingerprints it asked about. */
export function coverageAskRows(limit = 200): CoverageAskRow[] {
  try {
    return (
      db
        .prepare(`SELECT id, status, parsed_json FROM plan_proposals WHERE agent = ? ORDER BY id DESC LIMIT ?`)
        .all(COVERAGE_ASK_AGENT, Math.max(1, Math.trunc(limit))) as any[]
    ).map((row) => {
      let parsed: any = null;
      try {
        parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
      } catch {
        parsed = null;
      }
      const elements = Array.isArray(parsed?.coverage_gap?.elements) ? parsed.coverage_gap.elements : [];
      return {
        id: Number(row.id),
        status: String(row.status ?? ""),
        fingerprints: elements.map((el: any) => String(el?.fingerprint ?? "")).filter(Boolean),
      };
    });
  } catch {
    return [];
  }
}

/** Is this hydrated proposal a coverage ask? */
export function isCoverageAsk(proposal: unknown): boolean {
  const row = proposal as any;
  return String(row?.agent ?? "") === COVERAGE_ASK_AGENT && String(row?.instruction ?? "") === COVERAGE_ASK_INSTRUCTION;
}
