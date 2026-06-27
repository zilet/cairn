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
//   1) muscleGroupTrajectory() folds each canonical group's member lifts' status
//      + the group's volume band/trend into ONE plain verdict
//      (advancing | stalling | building | maintaining), and — when a group is
//      stalling — names the lead stalled lift plus a MENU of 2-3 concrete
//      same-pattern variations to rotate in (not one forced swap).
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
import { localDateISO } from "./shared.js";
import { getAppState } from "./app-state.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  isMobility,
  MUSCLE_GROUPS,
  type MuscleGroup,
} from "./exercise-canon.js";
import { suggestAlternatives } from "./exercise-variations.js";
import { getActiveBlock, type ProgramBlock } from "./program-blocks.js";
import {
  getProgramState,
  type LiftState,
  type MuscleVolumeState,
  type ProgramState,
} from "./program-state.js";
import { listContextEvents } from "./health.js";

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
}

export interface MuscleGroupTrajectory {
  available: boolean;
  headline: string;
  groups: MuscleGroupRead[];
}

export interface MuscleTrajectoryOpts {
  programState?: ProgramState; // injected to avoid a recompute
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

// Resolve a lift's canonical group (stored group wins, else classify by name).
function liftGroup(l: LiftState): MuscleGroup | null {
  return canonicalGroup(l.muscle_group) ?? classifyMuscleGroup(l.exercise);
}

const TITLE = (g: string) => (g ? g.charAt(0).toUpperCase() + g.slice(1) : g);

// Rank a stalled lift so the lead is the most-stuck one: longest weeks_static,
// then plateaued before regressing (a true plateau is the cleaner "rotate" case),
// then more stall signals.
function stallRank(l: LiftState): number {
  const wk = l.weeks_static ?? 0;
  const statusBonus = l.status === "plateaued" ? 100 : l.status === "regressing" ? 50 : 0;
  return wk * 10 + statusBonus + l.stall_signals.length;
}

export function muscleGroupTrajectory(
  date?: string,
  opts: MuscleTrajectoryOpts = {},
): MuscleGroupTrajectory {
  const d = date || localDateISO();
  const ps = opts.programState ?? getProgramState(d);
  const lifts = Array.isArray(ps.lifts) ? ps.lifts : [];
  const volume = Array.isArray(ps.volume) ? ps.volume : [];

  // Index volume by canonical group, and bucket member lifts by canonical group.
  const volByGroup = new Map<string, MuscleVolumeState>();
  for (const v of volume) {
    if (!v?.muscle_group || isMobility(v.muscle_group)) continue;
    volByGroup.set(v.muscle_group, v);
  }
  const liftsByGroup = new Map<string, LiftState[]>();
  for (const l of lifts) {
    const g = liftGroup(l);
    if (!g || isMobility(g)) continue;
    (liftsByGroup.get(g) ?? liftsByGroup.set(g, []).get(g)!).push(l);
  }

  const injuryAreas = activeInjuryAreas();
  const groups: MuscleGroupRead[] = [];

  // Walk the canonical taxonomy order so the strip reads in a stable, sensible
  // order. Include a group only when there's something to say (members or volume).
  for (const group of MUSCLE_GROUPS) {
    if (group === "mobility") continue;
    const members = liftsByGroup.get(group) ?? [];
    const vol = volByGroup.get(group) ?? null;
    if (members.length === 0 && !vol) continue;

    const stalled = members
      .filter((l) => l.status === "plateaued" || l.status === "regressing")
      .sort((a, b) => stallRank(b) - stallRank(a));
    const progressing = members.filter((l) => l.status === "progressing");
    const fresh = members.filter((l) => l.status === "new");

    let verdict: GroupVerdict;
    let lead_lift: string | null = null;
    let stalled_signal: string | null = null;
    let vary_options: GroupVaryOption[] = [];
    let note: string;

    const band = vol?.band ?? null;
    const trend = vol?.trend ?? null;
    const bandWord =
      band === "low" ? "on the light side"
      : band === "high" ? "high volume"
      : band === "productive" ? "in a productive volume range"
      : null;

    if (stalled.length > 0) {
      verdict = "stalling";
      const lead = stalled[0];
      lead_lift = lead.exercise;
      stalled_signal = lead.stall_signals[0] ?? lead.why ?? null;
      vary_options = suggestAlternatives(lead.exercise, { limit: 3, injuryAreas })
        .map((v) => ({ name: v.name, why: v.why }));
      const wk = lead.weeks_static ? ` (flat ~${lead.weeks_static} wk)` : "";
      note = vary_options.length
        ? `${TITLE(group)} has stalled — ${lead.exercise}${wk} isn't moving; rotate one of these same-pattern options in to unstick it.`
        : `${TITLE(group)} has stalled — ${lead.exercise}${wk} isn't moving; a close variation or a light deload usually unsticks it.`;
    } else if (progressing.length > 0) {
      verdict = "advancing";
      lead_lift = progressing[0].exercise;
      const others = progressing.length > 1 ? ` (+${progressing.length - 1} more climbing)` : "";
      note = `${TITLE(group)} is advancing — ${progressing[0].exercise} climbing${others}${bandWord ? `, ${bandWord}` : ""} — keep the progression going.`;
    } else if (fresh.length > 0 || (band === "low" && trend === "rising") || trend === "rising") {
      verdict = "building";
      lead_lift = (fresh[0] ?? members[0])?.exercise ?? null;
      note = fresh.length
        ? `${TITLE(group)} is building a baseline — a couple more sessions and its trend will read clearly.`
        : `${TITLE(group)} is building — volume's ramping${band === "low" ? " up off a light base" : ""}; keep it steady.`;
    } else {
      verdict = "maintaining";
      lead_lift = members[0]?.exercise ?? null;
      note = members.length
        ? `${TITLE(group)} is holding steady${bandWord ? `, ${bandWord}` : ""} — room for a deliberate push.`
        : `${TITLE(group)} is ticking over${bandWord ? ` (${bandWord})` : ""}.`;
    }

    groups.push({
      group,
      label: TITLE(group),
      verdict,
      lead_lift,
      stalled_signal,
      vary_options,
      volume_band: band,
      trend,
      note,
    });
  }

  if (groups.length === 0) {
    return {
      available: false,
      headline: "Not enough logged yet to read your muscle groups — keep training and they'll come into focus.",
      groups: [],
    };
  }

  const counts = {
    advancing: groups.filter((g) => g.verdict === "advancing").length,
    stalling: groups.filter((g) => g.verdict === "stalling").length,
    building: groups.filter((g) => g.verdict === "building").length,
    maintaining: groups.filter((g) => g.verdict === "maintaining").length,
  };
  const parts: string[] = [];
  if (counts.advancing) parts.push(`${counts.advancing} advancing`);
  if (counts.stalling) parts.push(`${counts.stalling} stalling`);
  if (counts.building) parts.push(`${counts.building} building`);
  if (counts.maintaining && !parts.length) parts.push(`${counts.maintaining} holding steady`);
  const headline = parts.length
    ? `Muscle groups: ${parts.join(", ")}.`
    : "Your muscle groups are all holding steady.";

  return { available: true, headline, groups };
}

// ============================================================================
// 2) STRENGTH TEST-WEEK CADENCE
// ============================================================================

// A program-wide cadence for re-anchoring true capacity — distinct from
// performance.ts's per-lift TEST_STALE_DAYS (42) staleness. ~7 weeks is the
// midpoint of the typical 6-8 week mesocycle, so a test week falls naturally at
// the end of a block. READ-ONLY here: this never stamps the cadence (the apply /
// scheduler path owns writing 'last_test_week').
export const TEST_WEEK_CADENCE_WEEKS = 7;
const TEST_WEEK_CADENCE_DAYS = TEST_WEEK_CADENCE_WEEKS * 7;
export const TEST_WEEK_STATE_KEY = "last_test_week";

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

function daysBetweenISO(fromISO: string, refISO: string): number | null {
  const a = Date.parse(String(fromISO) + "T00:00:00Z");
  const b = Date.parse(String(refISO) + "T00:00:00Z");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 864e5) : null;
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

export function testWeekDue(date?: string, opts: TestWeekOpts = {}): TestWeekDue {
  const d = date || localDateISO();
  const ps = opts.programState ?? getProgramState(d);
  const lifts = Array.isArray(ps.lifts) ? ps.lifts : [];
  const key_lifts = pickKeyLifts(lifts);

  const last = getAppState(TEST_WEEK_STATE_KEY);
  const last_test_week = last && /^\d{4}-\d{2}-\d{2}/.test(last) ? last.slice(0, 10) : null;
  const sinceDays = last_test_week ? daysBetweenISO(last_test_week, d) : null;

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
    due = true;
    why = `You're in the realization phase of "${block!.goal}" — a good week to re-test your main lifts and see what the block built.`;
  } else if (last_test_week == null) {
    due = true;
    why = "No strength test on record yet — a heavy-ish test session on your main lifts would anchor where you actually stand.";
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

  return { due, why, key_lifts, cadence_weeks: TEST_WEEK_CADENCE_WEEKS, last_test_week };
}
