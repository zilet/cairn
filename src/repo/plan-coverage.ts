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
// one bounded step the server can compute on its own for ONE gap (coverageRemedy): a set
// on lifts the plan already has with an established habit to grow into, else ONE lift the
// athlete has real history with, placed on the lightest day — or nothing.
//
// TWO READS, so a change never flickers with the week. The STANDING gap is judged on the
// plan as written against the athlete's intent alone — nothing that varies week to week
// (a light window, the race taper, the endurance carried lately, a trip, a cut) enters
// it. What varies is a HOLD: while one applies nothing new is changed, and nothing already
// open is withdrawn for it either (coverage-change.ts). Holds: every light window the
// floor stands aside for (a recovery week, a deload now or next, a deload-due read, the
// race taper/race week), a block's realization week, the post-race window, a trip, an
// affirmed cut, and every protective reduction still in force (protectiveHold: fuel
// protection, cut pressure, a volume restore owed, a plan adaptation); per element, a group
// the endurance work carries (over two OR six weeks) and the legs a strength-led taper
// trims. Every hold read FAILS CLOSED (unavailable), never "no hold".
//
// It decides no tier. The change itself — a server-computed draft routed through the
// ORDINARY autonomy path, so server policy picks quiet/announce/ask — is
// domain/brain/coverage-change.ts. This module also owns the reads that keep it calm:
//   - the athlete's NO for a gap (coverageAnswers / declinedCoverage): a held draft they
//     set aside, an announced change they held, an applied one they undid, or a gap
//     their own plan save created (recordPersonKeptCoverage);
//   - the stacking gate (coverageSettlingKeys): a landed change whose lifts have not been
//     trained since holds its gap's group until the log says they were done or missed;
//   - the premise of a routed change (coverageChangeStillFits), which the autonomy layer
//     checks instead of the generic evidence fingerprint: a coverage change depends on
//     the plan rows it edits, not on yesterday's logged sets.
//
// Each gap carries a FINGERPRINT: the gap and the athlete's intent. A no holds for that
// fingerprint until the gap materially worsens — COVERAGE_REASK_WORSE_BY fewer counted
// weekly sets than when it was given — or the intent changes; swapping one lift for
// another at the same volume is not news.
// ============================================================================
import crypto from "node:crypto";
import { db } from "../db.js";
import { normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { classifyPattern, examplesForGroup } from "./exercise-variations.js";
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
import { cutReaffirmation } from "./cut-target.js";
import { painBandForMovement } from "./pain-band.js";
import { activePlanAdaptations } from "./plan-adaptations.js";
import { slotAuthorship } from "./prescription-authorship.js";
import {
  cutPressureRefusesSetIncrease,
  enduranceCarriedGroups,
  fuelReadLeavesTrainingAlone,
  habitualWorkingSetCountBefore,
  readCutPressureStrict,
} from "./progression.js";
import { inRaceRecovery } from "./race-recovery.js";
import { joinList, localDateISO } from "./shared.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { activeRelevantTrainingSymptoms } from "./training-symptoms.js";
import { tripEventOn } from "./travel-days.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import { readVolumeFloorContext } from "./volume-floor-context.js";
import { type VolumeFloorContext, type VolumeFloorExemption, volumeFloorApplies } from "./volume-floor.js";
import { openVolumeRestoreTargets } from "./volume-guard.js";
import { perLiftSetCeiling, weeklyGroupHasRoom } from "./volume-tolerance.js";

/** The source every coverage draft is written under (plan_proposals.agent; stored rows key on it). */
export const COVERAGE_AGENT = "coverage-check";
/** The single instruction those drafts carry. Never `auto:`/`chat:` — no orphan sweep adopts it. */
export const COVERAGE_INSTRUCTION = "coverage: the plan as written leaves a gap";

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

/** Why nothing new is changed this week (coverage-change.ts), or null. */
export type CoverageHoldReason =
  | VolumeFloorExemption
  | "realization_phase"
  | "post_race"
  | "trip"
  | "affirmed_cut"
  // A protective reduction still in force (protectiveHold): never refilled.
  | "fuel_protection"
  | "cut_pressure"
  | "volume_restore"
  | "plan_adaptation";

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
  /** What the change does and on which day, in plain words. */
  summary: string;
  /** Why it was made, for the athlete: the gap, the change, and that Undo puts it back. */
  explanation: string;
  /** The same gap in the asking register, for the case where server policy holds it for a yes. */
  ask_explanation: string;
  /** True when the remedy adds a lift the plan does not have (a structural change: it announces). */
  adds_lift: boolean;
  /** True when the change is a first step that does not close the whole gap. */
  partial: boolean;
  /** The ONE gap element this remedy covers. */
  covered: CoverageGapElement[];
  /** The plan slots the offer was computed against (coverageOfferStillFits). */
  basis: CoverageBasisEntry[];
}

// A held position or a carry is prescribed in seconds, and the remedy has no honest
// number of seconds to offer; it only proposes rep work. A stored timed lift is skipped by
// its mode; a hold- or carry-shaped name by this.
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

// A gap that exists because the SERVER cut the work on purpose, for a reason that still
// stands, is not a gap: the coverage change never refills it. These are the conditions
// under which the set-count catch-up (progression.ts setCatchUp) refuses to add a set,
// read through the SAME predicates:
//   - the fuel read is protecting training (fuelReadLeavesTrainingAlone — the line
//     applyFuelProtection itself opens with);
//   - cut pressure refuses a set increase (cutPressureRefusesSetIncrease), or the cut's
//     anchors are sliding;
//   - a volume restore is still owed back (openVolumeRestoreTargets — setCatchUp's
//     restoreKeys; held for the whole week, so no slot with an open restore is bumped and
//     volume-guard never reads a refill as "the athlete moved it");
//   - a plan adaptation is in force (a race, trip or pain adaptation, plan-adaptations.ts).
// A light week, a deload, the taper's trims and an affirmed cut are the holds below.
function protectiveHold(today: string): CoverageHoldReason | null {
  if (!fuelReadLeavesTrainingAlone(currentUnderfuelingRead(today))) return "fuel_protection";
  const cut = readCutPressureStrict(today);
  if (cutPressureRefusesSetIncrease(cut) || cut.sliding) return "cut_pressure";
  if (openVolumeRestoreTargets().length > 0) return "volume_restore";
  if (activePlanAdaptations(today).length > 0) return "plan_adaptation";
  return null;
}

// A hold on the whole week: every light window the floor stands aside for, then the
// windows the floor context does not carry — the days after a race, a trip, an affirmed
// cut (where the set count holds) — and every protective reduction still in force. Each
// read FAILS CLOSED: a read that throws throws, and readPlanCoverage answers
// "unavailable", so nothing changes on a safety input nobody could read.
function weekHold(today: string, ctx: VolumeFloorContext): CoverageHoldReason | null {
  if (ctx.exempt) return ctx.exempt;
  // A block's realization (peaking/test) week deliberately trims volume; the floor itself
  // does not stand aside for it, but an ask to ADD work that week is the wrong moment.
  if (resolvedBlockPhase(today) === "realization") return "realization_phase";
  if (cutReaffirmation(today).reaffirmed === true) return "affirmed_cut";
  if (inRaceRecovery(today)) return "post_race";
  if (tripEventOn(today) != null) return "trip";
  return protectiveHold(today);
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
    // Six weeks of endurance, so one quiet fortnight never reopens a carried group. A
    // failed read is not "nothing carried": the whole read is unavailable (catch below).
    if (opts.context === undefined) {
      for (const group of enduranceCarriedGroups(6, today)) carried.add(String(group).toLowerCase());
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
  fuel_protection: "fuelling is protecting their training right now",
  cut_pressure: "the cut is asking for no extra sets right now",
  volume_restore: "sets cut to protect them are still being given back",
  plan_adaptation: "an adaptation to the plan is still in force",
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
  // An injury read that failed hands the prompts no gaps at all, rather than gaps that
  // read as safe to close.
  let loads: (name: string, group: string | null) => boolean;
  try {
    loads = openInjuryLoads(read.date);
  } catch {
    return [];
  }
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

// The only lifts the coverage change may ADD: ones the athlete has REAL logged history
// with (at least two sessions), most-trained first, whose stored row carries no
// constraint note. A catalog name they have never done is never offered — a coach does
// not put a stranger's lift into someone's week on its own. A read that fails throws
// (the pass is then unavailable).
const KNOWN_LIFT_MIN_SESSIONS = 2;

function knownLifts(): Array<Candidate & { mode: string | null }> {
  return (
    db
      .prepare(
        `SELECT e.name AS name, e.muscle_group AS muscle_group, e.mode AS mode,
                COUNT(DISTINCT ls.session_id) AS sessions
           FROM exercises e JOIN logged_sets ls ON ls.exercise_id = e.id
          WHERE e.constraint_note IS NULL OR TRIM(e.constraint_note) = ''
          GROUP BY e.id
         HAVING sessions >= ?
          ORDER BY sessions DESC, e.id ASC
          LIMIT 200`
      )
      .all(KNOWN_LIFT_MIN_SESSIONS) as any[]
  ).map((row) => ({
    name: String(row.name),
    group: row.muscle_group == null ? null : String(row.muscle_group),
    mode: row.mode == null ? null : String(row.mode),
  }));
}

function storedExerciseRow(name: string): any | null {
  const id = resolveExerciseName(name).exercise_id;
  return id == null ? null : (db.prepare(`SELECT id, muscle_group, mode, constraint_note FROM exercises WHERE id = ?`).get(id) as any);
}

// The athlete's pain, REPORTED IN WORDS (training-symptoms.ts: an active, area-scoped
// symptom watch whose area loads the lift) and as stated pain on the lift itself inside
// the pain band's window (pain-band.ts painBandForMovement, stated exposures only) — the
// reads progression and the session primer keep a painful lift off a card with. A lift
// either touches is never bumped or added. Throws when a read fails (fail closed).
function painTouches(date: string): (name: string, group: string | null) => boolean {
  return (name, group) => {
    if (activeRelevantTrainingSymptoms(date, { name, muscle_group: group }, { seed_legacy: false }).length > 0) return true;
    const row = storedExerciseRow(name);
    return painBandForMovement({ id: row?.id ?? null, name, muscle_group: group ?? row?.muscle_group ?? null }, date) != null;
  };
}

// A lift the athlete's plan lost FOR PAIN or an injury is never offered back by coverage:
// returning it is the pain-adaptation restore path's job (autonomy-service.ts
// returnPainAdaptations: back by itself once that pain settles, kept as adapted while it
// is open or untied, asked only on the clinician floor). The one source is the
// ledger of what LANDED: an applied plan proposal whose change removed the lift (`remove`,
// or the `from` of a swap) with a pain tie on it - the change's own reason_provenance
// pointing at a symptom/pain/injury, pain words in its reason (or in the proposal's own
// summary/rationale), the proposal's server-stamped clinical_provenance, or a clinical hold
// on its decision - plus a scoped plan adaptation (any state but undone) whose reason says
// pain. (The same tests plan-adaptations.ts adaptationRestoreNeedsAsk applies.) No removal
// carries a symptom-event link, so the symptom table alone cannot say WHY a lift left; a
// resolved symptom in the area proves nothing about a lift dropped for another reason.
// Fails closed: a read that throws throws (the pass is unavailable), and an applied row
// whose JSON cannot be parsed counts against any lift whose name its raw text carries.
const PAIN_PROVENANCE = /symptom|pain|injur/i;
const PAIN_WORDS = /\b(pain|painful|hurts?|hurting|injur(?:y|ed|ies))\b/i;

function changeTiedToPain(change: any): boolean {
  const p = change?.reason_provenance;
  if (p && typeof p === "object" && (PAIN_PROVENANCE.test(String(p.source_ref_type ?? "")) || PAIN_PROVENANCE.test(String(p.reason_code ?? "")))) {
    return true;
  }
  return PAIN_WORDS.test(String(change?.reason ?? ""));
}

function decisionClinical(proposalId: number): boolean {
  const rows = db
    .prepare(`SELECT risk_class, autonomy_tier, context_json FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ?`)
    .all(String(proposalId)) as any[];
  return rows.some((row) => {
    if (row.risk_class === "clinical" || row.autonomy_tier === "clinician") return true;
    if (!row.context_json) return false;
    const context = JSON.parse(String(row.context_json)) ?? {};
    return context.clinical === true || context.review_reason_code === "clinical_ceiling";
  });
}

function droppedForPainReader(): (name: string) => boolean {
  const named = new Set<string>();
  const raw: string[] = [];
  const candidates = (
    db.prepare(`SELECT id, parsed_json FROM plan_proposals WHERE status = 'applied' AND parsed_json IS NOT NULL`).all() as any[]
  ).filter((row) => /remove|swap/.test(String(row.parsed_json)));
  for (const row of candidates) {
    let parsed: any;
    try {
      parsed = JSON.parse(String(row.parsed_json));
    } catch {
      raw.push(String(row.parsed_json).toLowerCase());
      continue;
    }
    const changes = (Array.isArray(parsed?.changes) ? parsed.changes : []).filter(
      (c: any) => c && (c.remove === true || (c.swap && typeof c.swap === "object" && c.swap.from))
    );
    let proposalPain: boolean | null = null;
    for (const change of changes) {
      if (!changeTiedToPain(change)) {
        proposalPain ??=
          (parsed?.clinical_provenance != null && typeof parsed.clinical_provenance === "object") ||
          PAIN_WORDS.test(String(parsed?.summary ?? "")) ||
          PAIN_WORDS.test(String(parsed?.rationale ?? "")) ||
          decisionClinical(Number(row.id));
        if (!proposalPain) continue;
      }
      const dropped = change.remove === true ? change.exercise : change.swap?.from;
      if (dropped) named.add(liftIdentity(String(dropped)));
    }
  }
  for (const row of db
    .prepare(`SELECT exercise, reason FROM plan_adaptations WHERE status != 'cancelled' AND kind IN ('removed','swapped')`)
    .all() as any[]) {
    if (PAIN_WORDS.test(String(row.reason ?? ""))) named.add(liftIdentity(String(row.exercise)));
  }
  return (name: string) => {
    if (named.has(liftIdentity(name))) return true;
    const lower = name.toLowerCase();
    return raw.some((text) => text.includes(lower));
  };
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

// The asking register: only when server policy holds the change for a yes (a lead mode
// that reviews everything). Full cover, then a first step.
const OFFERS: readonly string[] = [
  "The change here is the smallest one that covers it, and it is yours to take or leave.",
  "Here is the smallest change that would cover it, if you want it.",
  "One small change would cover it; it is your call.",
];
const OFFERS_PARTIAL: readonly string[] = [
  "Here is a first step toward it, if you want it.",
  "A first step toward it is ready, and it is your call.",
  "This is a first step toward it; it is yours to take or leave.",
];

// The acting register: the change is made, and Undo is the athlete's no.
const ACTS: readonly string[] = [
  "The smallest change that covers it goes into your plan, and Undo puts the week back as you had it.",
  "So your plan takes the smallest change that covers it; Undo puts it back as it was.",
  "One small change covers it and goes into your plan; Undo takes it back out.",
];
const ACTS_PARTIAL: readonly string[] = [
  "A first step toward it goes into your plan; Undo puts the week back as you had it.",
  "Your plan takes a first step toward it, and more comes only once you have trained this; Undo puts it back as it was.",
  "One small first step goes into your plan; Undo takes it back out.",
];

/**
 * The athlete-facing WHY for a coverage change: which group or family the week as written
 * leaves short, and — in the acting register — that the change is made and Undo is the way
 * back. It names no amount: the only numbers a person reads are the applied ones, in the
 * summary. `partial` says "a first step" when the change does not close the whole gap.
 * Rotates by day.
 */
export function coverageExplanation(
  covered: readonly CoverageGapElement[],
  date = localDateISO(),
  register: "act" | "ask" = "act",
  partial = false
): string {
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
  const close = register === "act" ? (partial ? ACTS_PARTIAL : ACTS) : partial ? OFFERS_PARTIAL : OFFERS;
  return `${pickDayVariant(OPENERS, date, `coverage_open:${key}`)(clause)} ${pickDayVariant(close, date, `coverage_${register}:${key}`)}`;
}

// The per-pass bound: ONE gap, at most this many added sets in all (a set on each of two
// lifts, or two on one), or — only when no lift already in the plan has room — ONE added
// lift at its minimum effective dose. The settling rule (coverageSettlingKeys) paces the
// rest: nothing more for that gap until these sets were trained.
export const COVERAGE_PASS_SET_CAP = 2;
const ADDED_SETS = 2;
const ADDED_REP_LOW = 8;
const ADDED_REP_HIGH = 12;
// Never more than this many working sets of one lift, whatever the habit says.
const LIFT_SET_CEILING = 5;

/**
 * Which gap a pass takes first. A movement family the week leaves out entirely is the most
 * consequential (the whole pattern is missing); then floored groups by how far under their
 * floor they sit RELATIVE to it ((low - planned) / low); ties keep the floor's own order
 * (weeklySetTargets, then MOVEMENT_PATTERN_FAMILIES). Pure.
 */
export function rankCoverageGaps(elements: readonly CoverageGapElement[]): CoverageGapElement[] {
  const weight = (el: CoverageGapElement) =>
    el.kind === "pattern" ? 2 : el.low && el.low > 0 ? Math.max(0, (el.low - (el.planned ?? 0)) / el.low) : 0;
  return elements
    .map((el, i) => ({ el, i }))
    .sort((a, b) => weight(b.el) - weight(a.el) || a.i - b.i)
    .map((x) => x.el);
}

/**
 * The one bounded change the server would make for the first gap (rankCoverageGaps) it can
 * honestly close a step of, or null when it can offer nothing safe. Never more than one gap,
 * never more than COVERAGE_PASS_SET_CAP added sets on lifts already in the plan — only a
 * lift with an established habit, and never past ~1.2× it (VOLUME_BOUNDS) or the group's
 * weekly bound — else ONE lift the athlete has real history with, at its minimum dose. It
 * never reduces a slot, never changes a rep range, never touches a lift an injury, a pain
 * report or a constraint note covers, and never "adds" a lift the plan already has (an
 * existing lift is a bump candidate). Throws when a safety read fails (fail closed).
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
  const injuryLoads = openInjuryLoads(date);
  const pain = painTouches(date);
  const untouchable = (name: string, group: string | null) => injuryLoads(name, group) || pain(name, group);
  // VOLUME_BOUNDS (volume-tolerance.ts), the bound every set increase honours — the SAME
  // rule the set-count catch-up uses: no habit, no raise above what is written; a habit,
  // at most ~1.2× it.
  const ceilings = new Map<string, number>();
  const ceilingFor = (exercise: string, written: number): number => {
    const key = liftIdentity(exercise);
    if (!ceilings.has(key)) {
      const habitual = habitualWorkingSetCountBefore(exercise, date);
      ceilings.set(key, habitual == null ? 0 : Math.min(LIFT_SET_CEILING, perLiftSetCeiling(habitual)));
    }
    return Math.max(written, ceilings.get(key) ?? 0);
  };
  // Every lift on the plan, by the resolver AND by its key, so a candidate the create
  // chokepoint would land on an existing slot is never proposed as an add.
  const onPlan = new Set<string>();
  for (const day of days) {
    for (const item of strengthItems(day)) {
      onPlan.add(liftIdentity(String(item.exercise)));
      onPlan.add(`key:${normalizedExerciseKey(String(item.exercise))}`);
    }
  }
  const isOnPlan = (name: string) => onPlan.has(liftIdentity(name)) || onPlan.has(`key:${normalizedExerciseKey(name)}`);
  const daySets = new Map<number, number>(
    days.map((day) => [Number(day.day_number), strengthItems(day).reduce((s: number, i: any) => s + (Number(i.sets) || 0), 0)])
  );
  const dayName = (n: number) => {
    const day = days.find((d) => Number(d.day_number) === n);
    return String(day?.name ?? "").trim() || `day ${n}`;
  };
  let known: ReturnType<typeof knownLifts> | null = null;
  let droppedForPain: ((name: string) => boolean) | null = null;

  // ONE new lift for this gap, on the lightest day whose press angle is free.
  const placeOne = (fits: (c: Candidate) => boolean, reason: string): CoverageChange | null => {
    known ??= knownLifts().filter((lift) => lift.mode !== "timed" && !TIMED_NAME.test(lift.name));
    const painDropped = (droppedForPain ??= droppedForPainReader());
    const order = days
      .map((day) => Number(day.day_number))
      .sort((a, b) => (daySets.get(a) ?? 0) - (daySets.get(b) ?? 0) || a - b);
    for (const candidate of known) {
      if (isOnPlan(candidate.name) || !fits(candidate) || untouchable(candidate.name, candidate.group)) continue;
      // Dropped for pain: coming back is the pain-adaptation restore's call, never coverage's.
      if (painDropped(candidate.name)) continue;
      const slot = pressSlotKey(candidate.name);
      const day = order.find((n) => {
        const names = strengthItems(days.find((d) => Number(d.day_number) === n)).map((i: any) => String(i.exercise));
        return !slot || !occupiedPressSlots(names).has(slot);
      });
      if (day == null) continue;
      return {
        day_number: day,
        exercise: candidate.name,
        sets: ADDED_SETS,
        rep_low: ADDED_REP_LOW,
        rep_high: ADDED_REP_HIGH,
        reason,
      };
    }
    return null;
  };

  for (const element of rankCoverageGaps(elements)) {
    if (element.kind === "group" && element.group && element.low != null) {
      const group = element.group;
      const planned = element.planned ?? 0;
      const short = element.low - planned;
      if (short <= 0) continue;
      const reason = `Covers your ${group} across the week.`;
      // 1. A set more on a lift already in the plan for the group, one set per lift per
      //    round, within the pass cap, the lift's own ceiling and the group's weekly bound.
      const target = Math.min(COVERAGE_PASS_SET_CAP, Math.ceil(short - 1e-9));
      const primaries = days.flatMap((day) =>
        strengthItems(day)
          .filter((item: any) => Number.isInteger(Number(item.sets)) && Number(item.sets) > 0)
          .filter((item: any) => primaryMuscleGroup(String(item.exercise), storedGroup(item)) === group)
          .filter((item: any) => !String(item.constraint_note ?? "").trim())
          .filter((item: any) => !untouchable(String(item.exercise), storedGroup(item)))
          .map((item: any) => ({ day_number: Number(day.day_number), exercise: String(item.exercise), from: Number(item.sets) }))
          .filter((item) => ceilingFor(item.exercise, item.from) > item.from)
      );
      const bumps = new Map<string, { day_number: number; exercise: string; from: number; to: number }>();
      let added = 0;
      for (let round = 0; round < COVERAGE_PASS_SET_CAP && added < target; round++) {
        for (const item of primaries) {
          if (added >= target || !weeklyGroupHasRoom(planned + added, 1)) break;
          const key = `${item.day_number}|${item.exercise}`;
          const bump = bumps.get(key) ?? { ...item, to: item.from };
          if (bump.to >= ceilingFor(item.exercise, item.from)) continue;
          bump.to += 1;
          bumps.set(key, bump);
          added += 1;
        }
      }
      if (bumps.size) {
        const list = [...bumps.values()];
        return finish(element, date, {
          changes: list.map((b) => ({ day_number: b.day_number, exercise: b.exercise, sets: b.to, reason })),
          basis: list.map((b) => ({ day_number: b.day_number, identity: liftIdentity(b.exercise), sets: b.from })),
          bumps: list,
          adds: [],
          partial: added < short - 1e-9,
          dayName,
        });
      }
      // 2. No lift already there has room: ONE lift the athlete knows, at its minimum dose.
      if (!weeklyGroupHasRoom(planned, ADDED_SETS)) continue;
      const add = placeOne((c) => primaryMuscleGroup(c.name, c.group) === group, reason);
      if (!add) continue;
      return finish(element, date, {
        changes: [add],
        basis: [{ day_number: add.day_number, identity: liftIdentity(add.exercise), sets: null }],
        bumps: [],
        adds: [add],
        partial: ADDED_SETS < short - 1e-9,
        dayName,
      });
    }
    if (element.kind === "pattern" && element.pattern) {
      const family = element.pattern;
      const add = placeOne((c) => familyOf(c.name, c.group) === family, `Brings ${FAMILY_NOUNS[family]} into the week.`);
      if (!add) continue;
      return finish(element, date, {
        changes: [add],
        basis: [{ day_number: add.day_number, identity: liftIdentity(add.exercise), sets: null }],
        bumps: [],
        adds: [add],
        partial: false,
        dayName,
      });
    }
  }
  return null;
}

// The remedy's words, built from exactly what it changes: one sentence per plan day ("On
// Upper, one more set of A and B." / "On Pull, add C, two sets."), the numbers the applied
// deltas themselves, and the why in the acting and asking registers.
function finish(
  element: CoverageGapElement,
  date: string,
  parts: {
    changes: CoverageChange[];
    basis: CoverageBasisEntry[];
    bumps: Array<{ day_number: number; exercise: string; from: number; to: number }>;
    adds: CoverageChange[];
    partial: boolean;
    dayName: (n: number) => string;
  }
): CoverageRemedy {
  const dayOrder = [...new Set([...parts.bumps.map((b) => b.day_number), ...parts.adds.map((a) => a.day_number)])].sort(
    (a, b) => a - b
  );
  const sentences: string[] = [];
  for (const day of dayOrder) {
    const pieces: string[] = [];
    const byStep = new Map<number, string[]>();
    for (const bump of parts.bumps) {
      if (bump.day_number !== day) continue;
      const step = bump.to - bump.from;
      byStep.set(step, [...new Set([...(byStep.get(step) ?? []), bump.exercise])]);
    }
    const steps = [...byStep.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, names]) => `${numberWord(step)} more ${step === 1 ? "set" : "sets"} of ${joinList(names)}`);
    if (steps.length) pieces.push(steps.join(", plus "));
    for (const add of parts.adds.filter((a) => a.day_number === day)) {
      pieces.push(`add ${add.exercise}, ${numberWord(add.sets)} sets`);
    }
    sentences.push(`On ${parts.dayName(day)}, ${pieces.join(", and ")}.`);
  }
  return {
    changes: parts.changes,
    summary: capitalize(sentences.join(" ")),
    explanation: coverageExplanation([element], date, "act", parts.partial),
    ask_explanation: coverageExplanation([element], date, "ask", parts.partial),
    adds_lift: parts.adds.length > 0,
    partial: parts.partial,
    covered: [element],
    basis: parts.basis,
  };
}

// The open injuries on `date`, as one predicate: does this lift load any of them? A read
// that fails THROWS — never "no injuries" (fail closed).
function openInjuryLoads(date: string): (name: string, group: string | null) => boolean {
  const injuries = (listContextEvents({ activeOnly: true, on: date }) as any[]).filter((e) => e?.kind === "injury");
  return (name: string, group: string | null) =>
    injuries.some((injury) => injuryAffectsExercise(injury, { name, muscle_group: group }));
}

/**
 * Does a standing offer still say what it said when it was made? Every slot it bumps is
 * still on that day at the set count it was offered against (an absolute count written
 * over a slot the athlete has since edited would land yesterday's numbers) and the change
 * only RAISES it, no lift it adds is on the plan yet (by the resolver or its key), its day
 * still lifts, nothing it touches carries a constraint note (on the slot or the stored
 * lift), and no injury or pain report since covers any lift it names. Null when a read
 * failed — never evidence either way.
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
    const list = Array.isArray(changes) ? changes : [];
    const allItems = days.flatMap((day) => strengthItems(day));
    for (const entry of basis) {
      const day = days.find((d) => Number(d.day_number) === Number(entry.day_number));
      if (!day) return false;
      const change = list.find(
        (c) => Number(c?.day_number) === Number(entry.day_number) && liftIdentity(String(c?.exercise ?? "")) === String(entry.identity)
      );
      if (!change) return false;
      if (entry.sets == null) {
        const name = String(change.exercise);
        const present = allItems.some(
          (i: any) =>
            liftIdentity(String(i.exercise)) === String(entry.identity) ||
            normalizedExerciseKey(String(i.exercise)) === normalizedExerciseKey(name)
        );
        if (present) return false;
        if (String(storedExerciseRow(name)?.constraint_note ?? "").trim()) return false;
        continue;
      }
      const item = strengthItems(day).find((i: any) => liftIdentity(String(i.exercise)) === String(entry.identity));
      if (!item || Number(item.sets) !== Number(entry.sets) || String(item.constraint_note ?? "").trim()) return false;
      // The coverage path only ever RAISES a set count, and never carries a rep range onto
      // a slot that already has one.
      if (!(Number(change.sets) > Number(item.sets)) || change.rep_low != null || change.rep_high != null) return false;
    }
    const injuryLoads = openInjuryLoads(date);
    const pain = painTouches(date);
    return !list.some((change) => {
      const name = String(change?.exercise ?? "");
      const row = storedExerciseRow(name);
      const group = row?.muscle_group == null ? null : String(row.muscle_group);
      return injuryLoads(name, group) || pain(name, group);
    });
  } catch {
    return null; // unknown: a read failed, which is never evidence the offer went stale
  }
}


/**
 * The proposal payload a coverage change is written as: the remedy's changes, its
 * athlete-facing summary (what, on which day) and rationale (why, and that Undo is the
 * way back), and the gap it covers with the basis its premise is checked against.
 */
export function coverageProposalPayload(remedy: CoverageRemedy, date: string): Record<string, unknown> {
  return {
    summary: remedy.summary,
    rationale: remedy.explanation,
    changes: remedy.changes,
    coverage_gap: {
      version: 3,
      as_of: date,
      elements: remedy.covered.map((element) => ({
        key: element.key,
        kind: element.kind,
        fingerprint: element.fingerprint,
        ...(element.group ? { group: element.group } : {}),
        ...(element.pattern ? { pattern: element.pattern } : {}),
        // What the plan gave the group when the change was made: a later "no" is held against it.
        ...(element.planned != null ? { planned: element.planned } : {}),
        ...(element.low != null ? { low: element.low } : {}),
      })),
      // The asking register, read only when server policy holds the change for a yes
      // (autonomy-service.ts volumeFloorHoldReason).
      explanation: remedy.ask_explanation,
      adds_lift: remedy.adds_lift,
      partial: remedy.partial,
      // The offer exactly as derived (the stored `changes` are annotated on write), and
      // the plan slots it was computed against.
      offer: JSON.stringify(remedy.changes ?? null),
      basis: remedy.basis,
    },
  };
}

/** Does this stored coverage payload add a lift? (The structural shape: it announces.) */
export function coverageAddsLift(parsed: any): boolean {
  const gap = parsed?.coverage_gap;
  if (typeof gap?.adds_lift === "boolean") return gap.adds_lift;
  // A draft from before the flag: an added lift is a basis entry with no prior set count.
  return Array.isArray(gap?.basis) && gap.basis.some((entry: any) => entry && entry.sets == null);
}

/** What a routed coverage change stands on now (coverageChangeStillFits). */
export type CoveragePremise = "fits" | "gone" | "held" | "unknown";

/**
 * Does a routed coverage change still stand on what it was made for? `fits`: every gap it
 * covers still stands in the plan as written, none is held this week (a week hold, a
 * per-gap hold, or a protective reduction in force), and its offer still fits the plan
 * (coverageOfferStillFits). `gone`: a gap closed or the offer went stale. `held`: it
 * stands but this is no week to land it. `unknown`: a read failed, or the payload is too
 * old to carry its basis. This is the premise the autonomy layer checks for a coverage
 * change in place of the generic evidence fingerprint: the change edits plan rows and
 * nothing else, so a set logged since it was made says nothing about it.
 */
export function coverageChangeStillFits(parsed: any, date = localDateISO()): CoveragePremise {
  const gap = parsed?.coverage_gap;
  const fingerprints: string[] = (Array.isArray(gap?.elements) ? gap.elements : [])
    .map((el: any) => String(el?.fingerprint ?? ""))
    .filter(Boolean);
  if (!fingerprints.length || !Array.isArray(gap?.basis) || !gap.basis.length) return "unknown";
  const read = readPlanCoverage(date);
  if (read.status !== "ok") return "unknown";
  const standing = new Set(read.standing.map((el) => el.fingerprint));
  if (!fingerprints.every((fp) => standing.has(fp))) return "gone";
  if (read.hold || fingerprints.some((fp) => read.element_holds[fp])) return "held";
  const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
  const fits = coverageOfferStillFits(changes, gap.basis, { date });
  return fits === true ? "fits" : fits === false ? "gone" : "unknown";
}

// ---- the athlete's answers -------------------------------------------------------

export interface CoverageElementRow {
  key: string;
  fingerprint: string;
  planned: number | null;
}

export interface CoverageChangeRow {
  id: number;
  status: string;
  /** open: still a draft; yes: it landed and stands; no: the athlete said no to it. */
  answer: "open" | "yes" | "no";
  elements: CoverageElementRow[];
  fingerprints: string[];
}

// Every way the athlete says no to a coverage change: a held draft they set aside
// (discarded/rejected), an announced change they held before it landed (the decision is
// canceled with `held_by_user`, the draft superseded — revertDecision), and a landed
// change they undid (the decision is reverted; the draft stays `applied`). A draft the
// SERVER withdrew is superseded with no held_by_user mark and is never read here, so
// however many of those pile up, no answer is pushed out of the window.
const LINKED_DECISION = `d.source_ref_type = 'plan_proposal' AND d.source_ref_key = CAST(p.id AS TEXT)`;
const HELD_BY_USER = `EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION}
  AND d.status = 'canceled' AND json_extract(d.context_json, '$.held_by_user') = 1)`;
const UNDONE = `EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION} AND d.status = 'reverted')`;
const ANSWER_COLUMNS = `p.id AS id, p.status AS status, p.parsed_json AS parsed_json,
  ${HELD_BY_USER} AS held_by_user, ${UNDONE} AS undone`;
const ANSWERED = `(p.status IN ('applied', 'discarded', 'rejected') OR (p.status = 'superseded' AND ${HELD_BY_USER}))`;

function changeRow(row: {
  id: unknown;
  status: unknown;
  parsed_json: unknown;
  held_by_user: unknown;
  undone: unknown;
}): CoverageChangeRow {
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
  } catch {
    parsed = null;
  }
  const elements: CoverageElementRow[] = (Array.isArray(parsed?.coverage_gap?.elements) ? parsed.coverage_gap.elements : [])
    .map((el: any) => ({
      key: String(el?.key ?? ""),
      fingerprint: String(el?.fingerprint ?? ""),
      planned: el?.planned == null || !Number.isFinite(Number(el.planned)) ? null : Number(el.planned),
    }))
    .filter((el: CoverageElementRow) => el.fingerprint);
  const status = String(row.status ?? "");
  const answer: CoverageChangeRow["answer"] =
    status === "draft"
      ? "open"
      : status === "discarded" || status === "rejected" || Number(row.held_by_user) === 1 || Number(row.undone) === 1
        ? "no"
        : "yes";
  return { id: Number(row.id), status, answer, elements, fingerprints: elements.map((el) => el.fingerprint) };
}

/**
 * The coverage drafts the daily pass needs, newest first: the open ones and every one the
 * athlete answered (see ANSWERED). Null when the read FAILED — then nothing is known, and
 * the pass changes nothing (an unreadable "no" must never read as no answer).
 */
export function coverageChangeRows(): CoverageChangeRow[] | null {
  try {
    return (
      db
        .prepare(
          `SELECT ${ANSWER_COLUMNS} FROM plan_proposals p
            WHERE p.agent = ? AND (p.status = 'draft' OR ${ANSWERED})
            ORDER BY p.id DESC`
        )
        .all(COVERAGE_AGENT) as any[]
    ).map(changeRow);
  } catch {
    return null;
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

// ---- a gap the athlete's own plan save made ------------------------------------
//
// A person who saves their plan with fewer chest sets has decided something about chest.
// So a gap their own save CREATED (or deepened) is read as theirs: kept, not acted on, and
// marked declined in the prompt facts — exactly like a no. Kept beside the plan as one small
// map (fingerprint → the planned count they left it at); an entry ends when its gap closes
// (whoever closes it), and a later coverage change for the same gap supersedes it.
const PERSON_KEPT_KEY = "coverage_person_kept_v1";

type PersonKept = Record<string, { planned: number | null }>;

function readPersonKept(): PersonKept | null {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(PERSON_KEPT_KEY) as any;
    if (!row?.value) return {};
    const parsed = JSON.parse(String(row.value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PersonKept) : {};
  } catch {
    return null;
  }
}

function writePersonKept(kept: PersonKept): void {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(PERSON_KEPT_KEY, JSON.stringify(kept));
}

/**
 * After a PERSON's plan save: record each gap the save created or deepened (in `after`,
 * and absent from `before` or with fewer planned sets than before) as the person's own
 * choice. Returns the gap keys recorded. A gap that was already there and the save did not
 * deepen is not theirs, and keeps whatever answer it had.
 */
export function recordPersonKeptCoverage(
  before: readonly CoverageGapElement[],
  after: readonly CoverageGapElement[]
): string[] {
  const prior = new Map(before.map((el) => [el.fingerprint, el]));
  const made = after.filter((el) => {
    const was = prior.get(el.fingerprint);
    if (!was) return true;
    return el.kind === "group" && el.planned != null && was.planned != null && el.planned < was.planned;
  });
  if (!made.length) return [];
  const kept = readPersonKept();
  if (!kept) return [];
  for (const el of made) kept[el.fingerprint] = { planned: el.planned ?? null };
  writePersonKept(kept);
  return made.map((el) => el.key);
}

/**
 * THE chokepoint for a person's own DIRECT plan write — their editor save, a day they
 * delete, a lift they swap, a named-slot edit they asked for in chat. Reads the standing
 * gaps just before the write and just after, and records any gap the write created or
 * deepened as theirs (recordPersonKeptCoverage). Never for an agent's, a redraw's or an
 * autonomy write. The write itself is untouched and its errors propagate; the coverage
 * reads are fail-soft (a failed read attributes nothing).
 */
export function withPersonAuthoredCoverage<T>(
  write: () => T,
  date: string = localDateISO()
): { result: T; kept_by_person: string[] } {
  const before = readPlanCoverage(date);
  const result = write();
  let kept: string[] = [];
  if (before.status === "ok") {
    const after = readPlanCoverage(date);
    if (after.status === "ok") {
      try {
        kept = recordPersonKeptCoverage(before.standing, after.standing);
      } catch {
        kept = [];
      }
    }
  }
  return { result, kept_by_person: kept };
}

/**
 * Drop the person-kept entries whose gap no longer stands (`standing`, when given) and
 * any fingerprint the caller names in `drop`.
 */
export function settlePersonKeptCoverage(
  standing: readonly CoverageGapElement[] | null,
  drop: readonly string[] = []
): void {
  const kept = readPersonKept();
  if (!kept || !Object.keys(kept).length) return;
  const live = standing ? new Set(standing.map((el) => el.fingerprint)) : null;
  const gone = new Set(drop);
  let changed = false;
  for (const fp of Object.keys(kept)) {
    if ((live && !live.has(fp)) || gone.has(fp)) {
      delete kept[fp];
      changed = true;
    }
  }
  if (changed) writePersonKept(kept);
}

/**
 * What the athlete already said about each gap, keyed by fingerprint (the gap and the
 * intent, so a changed intent is a new gap). Only a NO holds a gap: the newest answer
 * wins, and a gap a person's own save made counts as a no. A no stands while the gap is
 * not materially worse than when it was given (COVERAGE_REASK_WORSE_BY). A yes — a change
 * that landed and stands — holds nothing: if the plan later loses it again, that is a new
 * gap the stacking gate (coverageSettlingKeys) paces. Null when a read failed.
 */
export function coverageAnswers(rows: readonly CoverageChangeRow[]): {
  declined: (element: CoverageGapElement) => boolean;
} | null {
  const personKept = readPersonKept();
  if (!personKept) return null;
  const newest = new Map<string, { no: boolean; planned: number | null }>();
  for (const row of rows) {
    if (row.answer === "open") continue;
    for (const el of row.elements) {
      if (!newest.has(el.fingerprint)) newest.set(el.fingerprint, { no: row.answer === "no", planned: el.planned });
    }
  }
  return {
    declined: (element) => {
      const kept = personKept[element.fingerprint];
      if (kept && !worseThan(element, kept.planned)) return true;
      const answer = newest.get(element.fingerprint);
      return !!answer && answer.no && !worseThan(element, answer.planned);
    },
  };
}

/**
 * The fingerprints among `elements` whose newest answer is a "no" that still holds — the
 * bounded read the coach context makes (prompt facts mark them `declined:true`). Only
 * answered rows are read, newest first, a page at a time, and the scan stops as soon as
 * every element has met its newest answer (or the oldest row is reached), so no request
 * pays for the whole history. A gap the person's own save made counts as a no.
 */
const DECLINED_PAGE = 20;

export function declinedCoverage(elements: readonly CoverageGapElement[]): Set<string> {
  const out = new Set<string>();
  const pending = new Map(elements.map((el) => [el.fingerprint, el]));
  if (!pending.size) return out;
  const personKept = readPersonKept() ?? {};
  for (const [fp, element] of [...pending]) {
    const kept = personKept[fp];
    if (kept && !worseThan(element, kept.planned)) {
      out.add(fp);
      pending.delete(fp);
    }
  }
  try {
    // Keyset pages (the shared statement cache forbids a half-stepped iterator, src/db.ts).
    const page = db.prepare(
      `SELECT ${ANSWER_COLUMNS} FROM plan_proposals p
        WHERE p.agent = ? AND ${ANSWERED} AND p.id < ?
        ORDER BY p.id DESC LIMIT ${DECLINED_PAGE}`
    );
    let before = Number.MAX_SAFE_INTEGER;
    while (pending.size) {
      const rows = page.all(COVERAGE_AGENT, before) as any[];
      if (!rows.length) break;
      for (const raw of rows) {
        const row = changeRow(raw);
        for (const el of row.elements) {
          const element = pending.get(el.fingerprint);
          if (!element) continue;
          pending.delete(el.fingerprint);
          if (row.answer === "no" && !worseThan(element, el.planned)) out.add(el.fingerprint);
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

// ---- the stacking gate -----------------------------------------------------------
//
// One coverage change at a time per gap, and never day after day: once a change for a gap
// has landed, nothing more is changed for that gap until the log says its lifts were done
// or missed. Done is the prescription-authorship rule (prescription-authorship.ts
// slotAuthorship): a lift logged on or after the day the change landed is TESTED; one not
// logged since is untested. Missed is the change's own falsifiable expectation closing:
// every landed plan change carries an `exercise_target_completion` expectation per lift
// it touched (proposals.ts recordAppliedProposalDecision), and once that window has ended
// the change has been judged either way. No timer of its own.
const SETTLE_LOOKBACK = 12;

function lastExposure(exercise: string): { date: string; first_at: string | null } | null {
  const id = resolveExerciseName(exercise).exercise_id;
  if (id == null) return null;
  const row = db
    .prepare(
      `SELECT s.date AS date, MIN(ls.created_at) AS first_at
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id = ?
        GROUP BY s.id ORDER BY s.date DESC, s.id DESC LIMIT 1`
    )
    .get(id) as any;
  return row?.date ? { date: String(row.date), first_at: row.first_at == null ? null : String(row.first_at) } : null;
}

/**
 * The gap keys ("group:chest", "pattern:trunk") a landed, standing coverage change is
 * still settling: at least one lift it touched has not been logged since it landed, and
 * its completion expectation has not closed. Null when a read failed (the caller then
 * changes nothing).
 */
export function coverageSettlingKeys(date = localDateISO()): Set<string> | null {
  const today = String(date || localDateISO()).slice(0, 10);
  try {
    const rows = db
      .prepare(
        `SELECT d.id AS decision_id, d.effective_date AS effective_date, d.created_at AS created_at,
                p.parsed_json AS parsed_json
           FROM plan_proposals p
           JOIN brain_decisions d ON ${LINKED_DECISION}
          WHERE p.agent = ? AND p.status = 'applied' AND d.status = 'applied'
          ORDER BY d.id DESC LIMIT ${SETTLE_LOOKBACK}`
      )
      .all(COVERAGE_AGENT) as any[];
    const windowEnd = db.prepare(
      `SELECT MAX(window_end) AS window_end FROM brain_expectations
        WHERE decision_id = ? AND metric_key = 'exercise_target_completion'`
    );
    const settling = new Set<string>();
    for (const row of rows) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(String(row.parsed_json ?? "null"));
      } catch {
        parsed = null;
      }
      const keys: string[] = (Array.isArray(parsed?.coverage_gap?.elements) ? parsed.coverage_gap.elements : [])
        .map((el: any) => String(el?.key ?? ""))
        .filter(Boolean);
      if (!keys.length || keys.every((key) => settling.has(key))) continue;
      const ended = (windowEnd.get(row.decision_id) as any)?.window_end;
      if (ended && String(ended).slice(0, 10) < today) continue; // judged: done or missed
      const landed = String(row.effective_date ?? row.created_at ?? "").slice(0, 10);
      const lifts: string[] = (Array.isArray(parsed?.changes) ? parsed.changes : [])
        .map((change: any) => String(change?.exercise ?? "").trim())
        .filter(Boolean);
      const untested = lifts.some((lift) => {
        const exposure = lastExposure(lift);
        return exposure == null || slotAuthorship(landed, exposure, today).untested;
      });
      if (untested) for (const key of keys) settling.add(key);
    }
    return settling;
  } catch {
    return null;
  }
}

