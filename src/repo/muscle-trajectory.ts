// ============================================================================
// Muscle-group trajectory + strength test-week cadence — the STRENGTH brain
// lifted to the athlete's mental model.
//
// The per-LIFT progression engine already exists (program-state.ts grades each
// lift progressing | plateaued | regressing | maintaining | new; progression.ts
// prescribes the next step + a single same-pattern swap). But the athlete thinks
// in MUSCLE GROUPS — "which are advancing, which are stalling, and how do I push
// through a plateau" — and the program needs a cadenced moment to actually
// re-TEST capacity. This module does exactly two deterministic, additive things:
//
//   1) muscleGroupTrajectory() folds the status of EVERY trained lift crediting a
//      canonical group (muscle-credit.ts shares, compounds weighted above
//      accessories) + the group's volume band/trend into ONE plain verdict
//      (advancing | stalling | building | maintaining). A group is led by its
//      heaviest-credited compound and stalls only when that compound does or the
//      weighted majority does; when it stalls it names the stalled lift plus a
//      MENU of 2-3 variations from that lift's own region (not one forced swap).
//
//   2) testWeekDue() is a strength test-week cadence — tied to the active
//      periodization block's 'realization' phase OR ~6-8 weeks since the last
//      test-week stamp — naming the benchmark lifts worth re-testing.
//
// Constitution: plain words only, NEVER a 0-100 score. Everything is a
// suggestion the athlete drives — the trajectory reads information, the test
// week is an invitation, neither gates anything. Degrades quietly to
// { available:false } / { due:false } when there's nothing logged to read.
//
// Pre-computed context: both reads accept an already-built ProgramState (and the
// active block) via opts, so a single getCoachContext build never recomputes
// the program state — mirroring performanceStanding(date, { programState, ... }).
// ============================================================================
import { db } from "../db.js";
import { daysBetweenISO, joinList, localDateISO } from "./shared.js";
import { getAppState, setAppState } from "./app-state.js";
import { getAttentionSchedule } from "./attention.js";
import {
  canonicalGroup,
  isMobility,
  MUSCLE_GROUPS,
  type MuscleGroup,
  normalizedExerciseKey,
} from "./exercise-canon.js";
import { liftAlternatives } from "./exercise-suggestions.js";
import { isPressRegion, movementRegionKey } from "./movement-region.js";
import { isCompoundLift, liftLeadTier } from "./movement-standing.js";
import { isCountedShare, type MuscleCredit, muscleCreditFor } from "./muscle-credit.js";
import { getActiveBlock, type ProgramBlock } from "./program-blocks.js";
import {
  getProgramState,
  liftTrainedRecently,
  type LiftState,
  type MuscleVolumeState,
  type ProgramState,
} from "./program-state.js";
import { listContextEvents } from "./health.js";
import { recentAppliedRotations } from "./brain-decisions.js";
import { getProgress } from "./sessions.js";

// ============================================================================
// 1) MUSCLE-GROUP TRAJECTORY
// ============================================================================

export type GroupVerdict = "advancing" | "stalling" | "building" | "maintaining";

export interface GroupVaryOption {
  name: string; // a concrete same-pattern movement to rotate in
  why: string;  // plain-language reason it helps unstick the plateau
}

export interface MuscleGroupRead {
  group: MuscleGroup;
  label: string;                 // display label ("Rear delts")
  verdict: GroupVerdict;
  lead_lift: string | null;      // the lift that drives the verdict (the stalled one when stalling)
  stalled_signal: string | null; // the plain tell ("same top load 4 sessions running")
  vary_options: GroupVaryOption[]; // a MENU (2-3) to break a plateau — only when stalling
  volume_band: MuscleVolumeState["band"] | null;
  trend: MuscleVolumeState["trend"];
  note: string;                  // one plain sentence
  /** Whether the lead lift is a compound or an accessory; null with no lead. */
  lead_role?: "compound" | "accessory" | null;
  /** How many trained lifts the verdict weighed (every lift crediting the group a counted share). */
  lifts_read?: number;
  /**
   * Whether any of those lifts trains the group as its prime mover. A group read only
   * through other groups' lifts (triceps off a bench press) is not named in the headline:
   * the lift's own group already speaks for it. Absent reads as direct.
   */
  direct?: boolean;
}

export interface MuscleGroupTrajectory {
  available: boolean;
  headline: string;
  groups: MuscleGroupRead[];
}

export interface MuscleTrajectoryOpts {
  programState?: ProgramState; // injected to avoid a recompute
  // Recently applied rotations (recentAppliedRotations) — their rotated-OUT lifts are
  // excluded from the vary menu too, so a lift the brain just rotated away from is
  // never offered straight back. Defaults to reading them live; injectable for tests.
  recentRotations?: { from: string }[];
  // Which groups a lift credits and at what share. Defaults to muscleCreditFor (the one
  // answer); injectable so a test can pin synergist shares.
  creditFor?: (exercise: string, storedGroup?: string | null) => MuscleCredit[];
}

// Active-injury free-text areas, so the variation MENU skips a movement that
// loads an injured area. Strings (raw + a hyphenated variant) match the curated
// risk tags in suggestAlternatives via its two-way substring test.
function activeInjuryAreas(): string[] {
  let rows: any[] = [];
  try {
    rows = listContextEvents({ activeOnly: true }) as any[];
  } catch {
    rows = [];
  }
  const out = new Set<string>();
  for (const ev of rows) {
    if (ev?.kind !== "injury") continue;
    const meta = ev?.meta && typeof ev.meta === "object" ? ev.meta : null;
    const parts = [ev?.title, ev?.detail, meta?.area]
      .filter(Boolean)
      .map((s: any) => String(s).toLowerCase().trim())
      .filter(Boolean);
    for (const p of parts) {
      out.add(p);
      const hy = p.replace(/\s+/g, "-");
      if (hy !== p) out.add(hy); // "lower back" → also "lower-back"
    }
  }
  return [...out].slice(0, 12);
}

// Every exercise name currently on a plan day — the exclusion list for vary_options
// (never suggest rotating in something already programmed). Null-safe, never throws.
export function planExerciseNames(): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT e.name AS name
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id`
      )
      .all() as any[];
    return rows.map((r) => String(r?.name ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- who trains a group, and how much ----------
//
// A group's verdict is read from EVERY trained lift that credits it (muscle-credit.ts:
// the primary at a full share, synergists at a part share), weighted by that share and
// by the lift's role. The group is led by its heaviest-credited trained COMPOUND, never
// by whichever accessory has been stuck longest: quads read off the squat before the leg
// extension, back off the rows and pulls before a pulldown variation.

// An accessory's vote counts half a compound's at the same credit share: a compound
// loads the group heavily across a whole movement and is where its strength is read;
// an isolation lift moves on coarse steps and stalls for reasons local to itself.
export const GROUP_ACCESSORY_WEIGHT = 0.5;

// A compound leads a group only when it trains the group at least this much. A
// synergist credited at a small share (a squat's calves) grazes the group; it does not
// speak for it, so the group is then read from its own lifts.
export const GROUP_LEAD_MIN_SHARE = 0.5;

type CreditFor = (exercise: string, storedGroup?: string | null) => MuscleCredit[];

interface GroupMember {
  lift: LiftState;
  share: number;
  /** The group is this lift's prime mover. */
  primary: boolean;
  compound: boolean;
  tier: number;
  weight: number;
}

const TITLE = (g: string) => (g ? g.charAt(0).toUpperCase() + g.slice(1) : g);

const isStalled = (l: LiftState) => l.status === "plateaued" || l.status === "regressing";

// A lift injected without a recency stamp (an older caller's ProgramState) counts as
// trained; a stamped one must sit inside the current window.
function trainedNow(l: LiftState, asOf: string): boolean {
  if (typeof l.last_trained !== "string") return l.last_trained === undefined;
  return liftTrainedRecently(l, asOf);
}

// Rank a stalled lift so the lead is the most-stuck one: longest weeks_static,
// then plateaued before regressing (a true plateau is the cleaner "rotate" case),
// then more stall signals.
function stallRank(l: LiftState): number {
  const wk = l.weeks_static ?? 0;
  const statusBonus = l.status === "plateaued" ? 100 : l.status === "regressing" ? 50 : 0;
  return wk * 10 + statusBonus + l.stall_signals.length;
}

const byWeight = (a: GroupMember, b: GroupMember) =>
  b.weight - a.weight || a.tier - b.tier || (b.lift.sessions ?? 0) - (a.lift.sessions ?? 0);

// ---------- the vary menu stays inside the stalled lift's own region ----------
//
// suggestAlternatives answers by swap family, and that table files a leg curl as a hinge,
// so a stalled leg curl used to be offered a deadlift. A rotation must load the same
// region: an isolation lift (or a dip) swaps only within its region family (a curl for a
// curl, a pushdown for another triceps extension), and a compound only for a compound of
// the same movement (never an isolation lift, never a fly).
const regionFamily = (region: string | null) => (region ? region.split(":")[0] : null);

export function sameVaryRegion(lift: string, candidate: string): boolean {
  const lr = movementRegionKey(lift);
  const cr = movementRegionKey(candidate);
  if (lr && !isPressRegion(lr)) return regionFamily(cr) === regionFamily(lr);
  if (cr && !isPressRegion(cr)) return false;
  if (lr && cr && regionFamily(lr) !== regionFamily(cr)) return false;
  return isCompoundLift(lift) === isCompoundLift(candidate);
}

function varyMenu(lift: string, injuryAreas: string[], excludeNames: string[]): GroupVaryOption[] {
  const own = normalizedExerciseKey(lift);
  return liftAlternatives(lift, { limit: 12, injuryAreas, excludeNames })
    .filter((v) => normalizedExerciseKey(v.name) !== own && sameVaryRegion(lift, v.name))
    .slice(0, 3)
    .map((v) => ({ name: v.name, why: v.why }));
}

// ---------- the headline names what leads, never a tally ----------

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

function namedGroups(list: MuscleGroupRead[]): string {
  return list.length <= 3 ? joinList(list.map((g) => g.label.toLowerCase())) : `${numberWord(list.length)} groups`;
}
// "Chest is flat", "quads are advancing": most group names are plural nouns.
const SINGULAR_GROUPS = new Set(["chest", "back", "core"]);
const isAre = (list: MuscleGroupRead[]) =>
  list.length === 1 && SINGULAR_GROUPS.has(String(list[0].group)) ? "is" : "are";

export function trajectoryHeadline(all: MuscleGroupRead[]): string {
  // Only groups with direct work of their own are named: three groups "flat" off one
  // stalled bench press would say the same thing three times.
  const direct = all.filter((g) => g.direct !== false);
  const groups = direct.length ? direct : all;
  const total = groups.length;
  const adv = groups.filter((g) => g.verdict === "advancing");
  const flat = groups.filter((g) => g.verdict === "stalling");
  const building = groups.filter((g) => g.verdict === "building");
  let lead: string;
  let flatSaid = false;
  if (adv.length === total) lead = total === 1 ? `${namedGroups(adv)} ${isAre(adv)} advancing` : "every group is advancing";
  else if (adv.length * 2 > total) lead = "most groups are advancing";
  else if (adv.length > 0) lead = `${namedGroups(adv)} ${isAre(adv)} advancing`;
  else if (flat.length * 2 > total) {
    lead = flat.length <= 3 ? `${namedGroups(flat)} ${isAre(flat)} flat` : "most groups are flat";
    flatSaid = true;
  } else if (building.length * 2 > total) lead = "most groups are building a base";
  else lead = "your groups are holding steady";
  const parts = [lead];
  if (flat.length && !flatSaid) parts.push(`${namedGroups(flat)} ${isAre(flat)} flat`);
  const sentence = parts.join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function muscleGroupTrajectory(
  date?: string,
  opts: MuscleTrajectoryOpts = {},
): MuscleGroupTrajectory {
  const d = date || localDateISO();
  const ps = opts.programState ?? getProgramState(d);
  const lifts = Array.isArray(ps.lifts) ? ps.lifts : [];
  const volume = Array.isArray(ps.volume) ? ps.volume : [];
  const creditFor: CreditFor = opts.creditFor ?? muscleCreditFor;

  // Index volume by canonical group, and every lift under each group it credits.
  const volByGroup = new Map<string, MuscleVolumeState>();
  for (const v of volume) {
    if (!v?.muscle_group || isMobility(v.muscle_group)) continue;
    volByGroup.set(v.muscle_group, v);
  }
  const membersByGroup = new Map<string, GroupMember[]>();
  for (const l of lifts) {
    if (!l?.exercise || isMobility(l.muscle_group)) continue;
    let credits: MuscleCredit[] = [];
    try {
      credits = creditFor(l.exercise, l.muscle_group);
    } catch {
      credits = [];
    }
    const compound = isCompoundLift(l.exercise, l.muscle_group);
    const tier = liftLeadTier(l.exercise, l.muscle_group);
    const seen = new Set<string>();
    for (const c of credits) {
      const group = canonicalGroup(c?.group ?? null);
      const share = Number(c?.share);
      if (!group || isMobility(group) || seen.has(group) || !(share > 0)) continue;
      // A touched (quarter) share grazes the group: it never makes the group appear,
      // never votes stalled or progressing, never leads. Only the primary and counted
      // shares are members (the same line the weekly-volume reads draw).
      const primary = c?.role === "primary";
      if (!primary && !isCountedShare(share)) continue;
      seen.add(group);
      const member: GroupMember = {
        lift: l,
        share,
        primary,
        compound,
        tier,
        weight: share * (compound ? 1 : GROUP_ACCESSORY_WEIGHT),
      };
      (membersByGroup.get(group) ?? membersByGroup.set(group, []).get(group)!).push(member);
    }
  }

  const injuryAreas = activeInjuryAreas();
  // Movements already programmed are never offered as a rotation — "rotate in DB
  // Bench Press" is a dead suggestion when DB Bench Press already sits on a plan
  // day (variety means something NEW). Plan-wide, not per-day: rotating in a lift
  // another day already runs would just double it.
  const plannedNames = planExerciseNames();
  // A lift the brain just rotated OUT is excluded from the menu too — offering it
  // straight back would undo the rotation the coach just made. Read live unless the
  // caller injects the reads (the conductor builds them once per context).
  const rotatedOut = (opts.recentRotations ?? recentAppliedRotations())
    .map((r) => String(r?.from ?? "").trim())
    .filter(Boolean);
  const excludeNames = [...plannedNames, ...rotatedOut];
  const groups: MuscleGroupRead[] = [];

  // Walk the canonical taxonomy order so the strip reads in a stable, sensible
  // order. Include a group only when there's something current to say: a lift
  // trained inside the current window, or volume.
  for (const group of MUSCLE_GROUPS) {
    if (group === "mobility") continue;
    const vol = volByGroup.get(group) ?? null;
    const members = (membersByGroup.get(group) ?? []).filter((m) => trainedNow(m.lift, d));
    if (members.length === 0 && !vol) continue;

    const label = TITLE(group);
    const singular = SINGULAR_GROUPS.has(group);
    const is = singular ? "is" : "are";
    const has = singular ? "has" : "have";
    const its = singular ? "its" : "their";
    const band = vol?.band ?? null;
    const trend = vol?.trend ?? null;
    const bandWord =
      band === "low" ? "on the light side"
      : band === "high" ? "high volume"
      : band === "productive" ? "in a productive volume range"
      : null;

    const leadCompound =
      [...members].filter((m) => m.compound && m.share >= GROUP_LEAD_MIN_SHARE).sort(byWeight)[0] ?? null;
    const stalled = members.filter((m) => isStalled(m.lift));
    const progressing = members.filter((m) => m.lift.status === "progressing");
    const fresh = members.filter((m) => m.lift.status === "new");
    const weightOf = (list: GroupMember[]) => list.reduce((sum, m) => sum + m.weight, 0);
    // Every trained lift is in the denominator, a lift still building its baseline too:
    // a brand-new squat beside one stuck leg extension is not a stalled group.
    const total = weightOf(members);
    const stalledWeight = weightOf(stalled);
    const progressingWeight = weightOf(progressing);
    const holdingWeight = weightOf(members.filter((m) => m.lift.status === "maintaining"));
    // A lead is contested when another compound trains the group at least as heavily and
    // moves the other way (a stalled row beside a climbing pull-up, both full back
    // shares; or both at a half biceps share). A tie in weight never lets one of them
    // speak for the group: the weighted majority decides instead.
    const leadContested =
      !!leadCompound &&
      members.some(
        (m) =>
          m !== leadCompound &&
          m.compound &&
          m.share >= GROUP_LEAD_MIN_SHARE &&
          m.weight >= leadCompound.weight - 1e-9 &&
          (isStalled(leadCompound.lift)
            ? m.lift.status === "progressing"
            : leadCompound.lift.status === "progressing" && isStalled(m.lift))
      );
    const leadStalled = !!leadCompound && !leadContested && isStalled(leadCompound.lift);
    const leadClimbing = !!leadCompound && !leadContested && leadCompound.lift.status === "progressing";
    // The group's prime movers: with none, it is read only through other groups' lifts.
    // A volume-only group (no current lift) keeps its old standing in the headline.
    const direct = members.length === 0 || members.some((m) => m.primary);

    let verdict: GroupVerdict;
    let lead: GroupMember | null = null;
    let stalled_signal: string | null = null;
    let vary_options: GroupVaryOption[] = [];
    let note: string;

    if (leadStalled || (total > 0 && stalledWeight * 2 > total)) {
      verdict = "stalling";
      lead = leadStalled
        ? leadCompound
        : [...stalled].sort((a, b) => b.weight - a.weight || stallRank(b.lift) - stallRank(a.lift))[0];
      const l = lead!.lift;
      stalled_signal = l.stall_signals[0] ?? l.why ?? null;
      const wk = l.weeks_static ? ` (flat about ${l.weeks_static} weeks)` : "";
      // A climbing compound beside the stall is said, never hidden by it.
      const stillClimbing = [...progressing].filter((m) => m.compound).sort(byWeight)[0];
      const climbingNote = stillClimbing ? ` ${stillClimbing.lift.exercise} is still climbing.` : "";
      if (!direct) {
        // Read only through another group's lift: that group's card carries the menu.
        const names = joinList([...new Set(stalled.map((m) => m.lift.exercise))]);
        const gets = singular ? "gets" : "get";
        const flatVerb = new Set(stalled.map((m) => m.lift.exercise)).size === 1 ? "is" : "are";
        note = `${label} ${gets} ${its} work from ${names}, which ${flatVerb} flat for now.${climbingNote}`;
      } else {
        vary_options = varyMenu(l.exercise, injuryAreas, excludeNames);
        const head = leadStalled
          ? `${label} ${has} gone flat: ${l.exercise}${wk} is not moving.`
          : `${label} ${has} gone flat: most of ${its} lifts are not moving, ${l.exercise}${wk} among them.`;
        note = vary_options.length
          ? `${head}${climbingNote} Rotating in one of these close variations could unstick it.`
          : `${head}${climbingNote} A close variation or a lighter week usually unsticks it.`;
      }
    } else if (leadClimbing || (progressingWeight > 0 && progressingWeight >= holdingWeight)) {
      verdict = "advancing";
      lead = leadClimbing ? leadCompound : [...progressing].sort(byWeight)[0];
      const others = progressing.filter((m) => m !== lead).length;
      const climbing = others > 0 ? `, with ${numberWord(others)} more climbing` : "";
      // A stalled accessory under an advancing group is named, never the verdict.
      const flatOne = [...stalled].sort(byWeight)[0];
      note = `${label} ${is} advancing: ${lead!.lift.exercise} is climbing${climbing}${bandWord ? `, ${bandWord}` : ""}.`;
      if (flatOne) note += ` ${flatOne.lift.exercise} is flat for now.`;
    } else if (fresh.length > 0 || trend === "rising") {
      verdict = "building";
      lead = leadCompound ?? [...fresh].sort(byWeight)[0] ?? [...members].sort(byWeight)[0] ?? null;
      note = fresh.length
        ? `${label} ${is} building a baseline. A couple more sessions and ${its} trend will read clearly.`
        : `${label} ${is} building: volume is ramping${band === "low" ? " up off a light base" : ""}. Keep it steady.`;
    } else {
      verdict = "maintaining";
      lead = leadCompound ?? [...members].sort(byWeight)[0] ?? null;
      note = members.length
        ? `${label} ${is} holding steady${bandWord ? `, ${bandWord}` : ""}. There is room for a deliberate push.`
        : `${label} ${is} ticking over${bandWord ? `, ${bandWord}` : ""}.`;
    }

    groups.push({
      group,
      label,
      verdict,
      lead_lift: lead?.lift.exercise ?? null,
      stalled_signal,
      vary_options,
      volume_band: band,
      trend,
      note,
      lead_role: lead ? (lead.compound ? "compound" : "accessory") : null,
      lifts_read: members.length,
      direct,
    });
  }

  if (groups.length === 0) {
    return {
      available: false,
      headline: "Not enough logged yet to read your muscle groups. Keep training and they will come into focus.",
      groups: [],
    };
  }

  return { available: true, headline: trajectoryHeadline(groups), groups };
}

// ============================================================================
// 2) STRENGTH TEST-WEEK CADENCE
// ============================================================================

// A program-wide cadence for re-anchoring true capacity — distinct from
// performance.ts's per-lift TEST_STALE_DAYS (42) staleness. ~7 weeks is the
// midpoint of the typical 6-8 week mesocycle, so a test week falls naturally at
// the end of a block. The cadence stamp is written by recordTestWeek() below —
// wired into realization-block completion (program-blocks.ts) and self-healed
// here from logged PRs — so the loop testWeekDue() reads actually closes.
export const TEST_WEEK_CADENCE_WEEKS = 7;
const TEST_WEEK_CADENCE_DAYS = TEST_WEEK_CADENCE_WEEKS * 7;
export const TEST_WEEK_STATE_KEY = "last_test_week";

// The span that folds a cluster of PRs into ONE de-facto test week: new maxes on
// ≥2 key lifts within a calendar week read as a single re-anchoring moment.
const DE_FACTO_TEST_WEEK_SPAN_DAYS = 7;

// Stamp the last strength test-week date. Idempotent + MONOTONIC — the stamp only
// ever moves FORWARD (an older date is ignored), so re-running block completion or
// the read-time self-heal never rewinds the cadence. This is the writer the module
// always referred to but that was never built; it's what lets testWeekDue() stop
// nagging once a test week has actually happened. Returns the effective stamp.
export function recordTestWeek(date?: string): string {
  const d = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : localDateISO();
  const prev = getAppState(TEST_WEEK_STATE_KEY);
  const prevISO = prev && /^\d{4}-\d{2}-\d{2}/.test(prev) ? prev.slice(0, 10) : null;
  if (prevISO && prevISO >= d) return prevISO; // ISO dates sort lexically — never go backwards
  setAppState(TEST_WEEK_STATE_KEY, d);
  return d;
}

export interface TestWeekDue {
  due: boolean;
  why: string;
  key_lifts: string[];     // the benchmark lifts worth re-testing first
  cadence_weeks: number;
  last_test_week: string | null; // ISO date of the last stamped test week (read-only)
}

export interface TestWeekOpts {
  programState?: ProgramState; // injected to avoid a recompute
  block?: ProgramBlock | null; // injected active block (else read live)
}

// Benchmark-ish compound names — these re-test capacity best. Used to LEAD the
// key-lift list before falling back to the strongest reps lifts overall.
const BENCHMARK_RE = /squat|bench|deadlift|\bpress\b|overhead|\brow\b|pull[\s-]?up|chin[\s-]?up|\bohp\b|\brdl\b/i;

// Choose the lifts worth re-testing: prefer benchmark compounds with real
// history, strongest first; fall back to the strongest reps lifts overall. Only
// reps lifts with an est-1RM and ≥3 sessions are eligible (don't re-test a
// barely-logged or timed-only lift). Capped at 3 — never a wall of tests.
function pickKeyLifts(lifts: LiftState[]): string[] {
  const eligible = lifts.filter(
    (l) => l.mode === "reps" && l.est_1rm != null && l.sessions >= 3,
  );
  if (!eligible.length) return [];
  const byStrength = [...eligible].sort((a, b) => (b.est_1rm ?? 0) - (a.est_1rm ?? 0));
  const benchmarks = byStrength.filter((l) => BENCHMARK_RE.test(l.exercise));
  const ordered = [...benchmarks, ...byStrength.filter((l) => !BENCHMARK_RE.test(l.exercise))];
  const out: string[] = [];
  for (const l of ordered) {
    if (out.includes(l.exercise)) continue;
    out.push(l.exercise);
    if (out.length >= 3) break;
  }
  return out;
}

// Detect a de-facto test week from logged reality: new est-1RM maxes ("PRs")
// landing on ≥2 of the key lifts within a ≤7-day span. An athlete who re-anchors
// multiple main lifts inside a week has tested capacity — whether or not a formal
// block framed it — so that window closes the loop just like a realization block.
// A PR requires a PRIOR session to beat, so a first-ever baseline entry doesn't
// count (that's what the "no test on record yet" read is for). Returns the most
// recent qualifying window's latest PR date (never after `onOrBefore`), else null.
function detectDeFactoTestWeek(keyLifts: string[], onOrBefore: string): string | null {
  if (keyLifts.length < 2) return null;

  // PR events per lift: a session date whose best est-1RM strictly beats every
  // earlier session's best for that lift.
  const events: { lift: string; date: string }[] = [];
  for (const lift of keyLifts) {
    const prog = getProgress(lift) as any;
    const pts = (Array.isArray(prog.points) ? prog.points : [])
      .filter((p: any) => p && p.best1rm != null && String(p.date).slice(0, 10) <= onOrBefore)
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
    let max = Number.NEGATIVE_INFINITY;
    let seen = false;
    for (const p of pts) {
      const v = Number(p.best1rm);
      if (!Number.isFinite(v)) continue;
      if (seen && v > max + 1e-9) events.push({ lift, date: String(p.date).slice(0, 10) });
      if (!seen || v > max) max = v;
      seen = true;
    }
  }
  if (events.length < 2) return null;

  // Newest PR first; anchor a ≤7-day look-back on each and return the most recent
  // anchor whose window carries PRs on ≥2 DISTINCT key lifts (the anchor is that
  // window's latest PR date).
  events.sort((a, b) => b.date.localeCompare(a.date));
  for (const anchor of events) {
    const inWindow = new Set<string>();
    for (const e of events) {
      const gap = daysBetweenISO(anchor.date, e.date);
      if (gap != null && gap >= 0 && gap <= DE_FACTO_TEST_WEEK_SPAN_DAYS) inWindow.add(e.lift);
    }
    if (inWindow.size >= 2) return anchor.date;
  }
  return null;
}

export function testWeekDue(date?: string, opts: TestWeekOpts = {}): TestWeekDue {
  const d = date || localDateISO();
  const ps = opts.programState ?? getProgramState(d);
  const lifts = Array.isArray(ps.lifts) ? ps.lifts : [];
  const key_lifts = pickKeyLifts(lifts);

  // Self-heal the cadence stamp before reading it: if the logged history shows a
  // de-facto test week (PRs on ≥2 key lifts inside a week) newer than the current
  // stamp, close the loop now so we don't nag an athlete who's actively
  // re-anchoring. recordTestWeek is monotonic — this only ever moves the stamp
  // forward, never rewinding a block-set stamp.
  if (key_lifts.length >= 2) {
    const deFacto = detectDeFactoTestWeek(key_lifts, d);
    if (deFacto) recordTestWeek(deFacto);
  }

  const last = getAppState(TEST_WEEK_STATE_KEY);
  const last_test_week = last && /^\d{4}-\d{2}-\d{2}/.test(last) ? last.slice(0, 10) : null;
  const sinceDays = last_test_week ? daysBetweenISO(d, last_test_week) : null;

  // The active periodization block reaching its 'realization' phase IS a test
  // week — that's the phase's whole point (peak / express the block's work).
  const block = opts.block !== undefined ? opts.block : getActiveBlock();
  const inRealization = block?.status === "active" && block?.phase === "realization";

  // No history at all → nothing to test yet (quiet, never nag a new athlete).
  if (key_lifts.length === 0) {
    return { due: false, why: "", key_lifts: [], cadence_weeks: TEST_WEEK_CADENCE_WEEKS, last_test_week };
  }

  let due = false;
  let why = "";
  if (inRealization) {
    // Block realization phase IS a test week — a direct, event-driven check.
    due = true;
    why = `You're in the realization phase of "${block!.goal}" — a good week to re-test your main lifts and see what the block built.`;
  } else if (last_test_week == null) {
    // Never tested — an event-driven "anchor where you stand" (never a nag, and
    // key_lifts.length === 0 already short-circuited above for a brand-new athlete).
    due = true;
    why = "No strength test on record yet — a heavy-ish test session on your main lifts would anchor where you actually stand.";
  } else {
    // The recurring re-test cadence NO LONGER runs on a fixed interval (rule 2a):
    // it DEFERS to the K5 benchmark-attention entry (refreshTrainingBenchmarkAttention).
    // A cleanly-progressing athlete's entry RELEASES → no scheduled test; a plateau
    // or block checkpoint keeps it active/scheduled. Falls back to the legacy fixed
    // cadence ONLY when the K5 entry hasn't been populated yet (before the scheduler's
    // first pass, or in a deterministic unit context), so prior behavior is preserved.
    const attn = getAttentionSchedule("training:strength:test-week");
    if (attn) {
      if (attn.tier === "released") {
        // Converged to no scheduled check — quiet, event-driven only from here.
      } else if (attn.next_due != null && attn.next_due <= d) {
        due = true;
        why = "Your main lifts are due a re-test — a heavy-ish test session re-reads your real ceilings before the next build.";
      } else if (attn.next_due != null) {
        const wk = Math.max(0, Math.round((daysBetweenISO(attn.next_due, d) ?? 0) / 7));
        why = wk > 0
          ? `Next strength test in about ${wk} week${wk === 1 ? "" : "s"}.`
          : "A test week is coming up soon.";
      }
    } else if (sinceDays != null && sinceDays >= TEST_WEEK_CADENCE_DAYS) {
      due = true;
      const wk = Math.round(sinceDays / 7);
      why = `It's been ~${wk} weeks since your last test week — re-testing your main lifts re-reads your real ceilings before the next build.`;
    } else if (sinceDays != null) {
      const wk = Math.max(0, TEST_WEEK_CADENCE_WEEKS - Math.round(sinceDays / 7));
      why = wk > 0
        ? `Last test week was ~${Math.round(sinceDays / 7)} weeks ago — next one in about ${wk} week${wk === 1 ? "" : "s"}.`
        : "A test week is coming up soon.";
    }
  }

  return { due, why, key_lifts, cadence_weeks: TEST_WEEK_CADENCE_WEEKS, last_test_week };
}
