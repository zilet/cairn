// ============================================================================
// Support-work read — the elite-coach reasoning under a lagging COMPOUND lift.
// When a big lift stalls, rotating the movement isn't the only lever: the real
// unlock is often a CONTRIBUTING muscle that's simply under-trained (a stuck
// bench whose triceps never get direct work; a deadlift limited by grip). This
// deterministic read maps each plateaued/regressing compound to the muscle groups
// that drive it and, when a driver is running below its productive volume, emits
// one calm "build the weak link" suggestion the plan-evolution loop can act on.
//
// It reads ONLY the deterministic program-state (per-lift status + per-muscle
// volume bands) — no agent, no DB queries of its own. Constitution: plain words,
// a suggestion never a gate, never a 0-100 score.
// ============================================================================
import { movementKey, type MuscleGroup } from "./exercise-canon.js";
import { getProgramState, type LiftState, type MuscleVolumeState } from "./program-state.js";

// ---- the support map --------------------------------------------------------
// A curated compound-movement → contributing-muscle map. `pattern` is matched as a
// whole phrase against the lift's movementKey (implement words stripped, so
// "Barbell Bench Press" → "bench press"); the array is ordered MOST-SPECIFIC first
// and the first phrase match wins (so "romanian deadlift" is caught before the
// generic "deadlift"). `prime` are the movers the lift itself builds; `synergists`
// are the assisting groups whose neglect commonly stalls the lift. Groups use the
// canonical MuscleGroup taxonomy (front delts fold onto "shoulders", grip onto
// "forearms"). `exclude` skips a same-word false match (e.g. an upright row is
// delts, not the back "row").
interface SupportPattern {
  pattern: string;
  label: string; // plain movement name for the coaching sentence
  prime: MuscleGroup[];
  synergists: MuscleGroup[];
  exclude?: string[];
}

const SUPPORT_MAP: SupportPattern[] = [
  { pattern: "romanian deadlift", label: "Romanian deadlift", prime: ["hamstrings"], synergists: ["glutes", "back", "core"] },
  { pattern: "stiff leg deadlift", label: "stiff-leg deadlift", prime: ["hamstrings"], synergists: ["glutes", "back", "core"] },
  { pattern: "deadlift", label: "deadlift", prime: ["hamstrings", "glutes"], synergists: ["back", "forearms", "core"] },
  { pattern: "overhead press", label: "overhead press", prime: ["shoulders"], synergists: ["triceps", "core"] },
  { pattern: "shoulder press", label: "shoulder press", prime: ["shoulders"], synergists: ["triceps", "core"] },
  { pattern: "military press", label: "overhead press", prime: ["shoulders"], synergists: ["triceps", "core"] },
  { pattern: "bench press", label: "bench press", prime: ["chest"], synergists: ["triceps", "shoulders"] },
  { pattern: "incline press", label: "incline press", prime: ["chest"], synergists: ["triceps", "shoulders"] },
  { pattern: "chest press", label: "chest press", prime: ["chest"], synergists: ["triceps", "shoulders"] },
  { pattern: "front squat", label: "front squat", prime: ["quads"], synergists: ["glutes", "core"] },
  { pattern: "squat", label: "squat", prime: ["quads"], synergists: ["glutes", "core"] },
  { pattern: "leg press", label: "leg press", prime: ["quads"], synergists: ["glutes"] },
  { pattern: "pull up", label: "pull-up", prime: ["back"], synergists: ["biceps", "forearms"] },
  { pattern: "chin up", label: "chin-up", prime: ["back"], synergists: ["biceps", "forearms"] },
  { pattern: "pulldown", label: "lat pulldown", prime: ["back"], synergists: ["biceps", "forearms"] },
  { pattern: "row", label: "row", prime: ["back"], synergists: ["biceps", "forearms"], exclude: ["upright"] },
];

function matchSupport(name: string): SupportPattern | null {
  const key = movementKey(String(name ?? ""));
  if (!key) return null;
  const padded = ` ${key} `;
  for (const entry of SUPPORT_MAP) {
    if (entry.exclude?.some((x) => key.includes(x))) continue;
    if (padded.includes(` ${entry.pattern} `)) return entry;
  }
  return null;
}

// ---- weak-link predicates ---------------------------------------------------
// A synergist is a weak link ONLY when it's running BELOW its productive band (or,
// handled by the caller, entirely ABSENT from the volume picture). A productive- or
// high-band group is NEVER a weak link — not even when it's drifting down: as the
// 3-week volume window slides, a "productive & falling" test would flip falling↔
// stable at the edge on unchanged training, churning the entry signature and re-
// drafting the same evolution proposal every few days (breaking "drafts once"). A
// low group that is also falling may color the suggestion text, but the trend never
// decides membership or enters the signature. The prime guard mirrors this: only a
// clear below-band prime reads as "the lift is under-practiced".
function isWeakSynergist(v: MuscleVolumeState): boolean {
  return v.band === "low";
}
function isPrimeUnderTrained(v: MuscleVolumeState): boolean {
  return v.band === "low";
}

// ---- plain-language helpers -------------------------------------------------
const PLURAL_GROUP = new Set<string>([
  "triceps",
  "biceps",
  "shoulders",
  "rear delts",
  "glutes",
  "quads",
  "hamstrings",
  "calves",
  "forearms",
]);

function joinGroups(groups: string[]): string {
  const uniq = [...new Set(groups)];
  if (uniq.length <= 1) return uniq[0] ?? "";
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
  return `${uniq.slice(0, -1).join(", ")}, and ${uniq[uniq.length - 1]}`;
}
function pluralList(groups: string[]): boolean {
  return groups.length > 1 || groups.some((g) => PLURAL_GROUP.has(g));
}
function stallPhrase(l: LiftState): string {
  if (l.status === "regressing") return "has been slipping";
  const wk = Number(l.weeks_static);
  return Number.isFinite(wk) && wk > 0 ? `has stalled ~${wk} wk` : "has stalled";
}

function synergistSuggestion(l: LiftState, groups: MuscleGroup[]): string {
  const names = joinGroups(groups);
  const verb = pluralList(groups) ? "sit" : "sits";
  const poss = pluralList(groups) ? "their" : "its";
  return `${l.exercise} ${stallPhrase(l)} while ${names} ${verb} below ${poss} productive volume — direct ${names} work (2–4 quality sets/wk) is the likely unlock.`;
}

function primeSuggestion(l: LiftState, support: SupportPattern, groups: MuscleGroup[]): string {
  const names = joinGroups(groups);
  const verb = pluralList(groups) ? "are" : "is";
  return `${l.exercise} ${stallPhrase(l)}, but your ${names} volume itself ${verb} below the productive range — the ${support.label} may simply be under-practiced, so build ${names} volume back up before assuming it needs a variation.`;
}

// ---- the read ---------------------------------------------------------------
export interface SupportWeakLink {
  muscle_group: MuscleGroup;
  band: "low" | "productive" | "high";
  weekly_sets: number;
  trend: "rising" | "falling" | "stable" | null;
}

export interface SupportWorkEntry {
  lift: string; // the lagging compound
  status: "plateaued" | "regressing";
  prime_gap: boolean; // true → the prime mover itself is under-trained (under-practiced lift)
  weak_links: SupportWeakLink[];
  suggestion: string; // one calm coaching sentence
  signature: string; // stable {lift + weak-link groups} digest for once-per-shift dedup
}

function weakLinkOf(v: MuscleVolumeState): SupportWeakLink {
  return {
    muscle_group: v.muscle_group as MuscleGroup,
    band: v.band,
    weekly_sets: v.weekly_sets,
    trend: v.trend,
  };
}

// A stable per-entry digest: the movement family + the sorted weak-link groups (+
// a prime marker). The scheduler folds this into the evolution-trigger signature so
// a STANDING support-work condition proposes once and re-arms only when the picture
// changes (a new lift lags, or a different group becomes the weak link).
function signatureOf(lift: string, groups: MuscleGroup[], prime: boolean): string {
  const gs = [...new Set(groups.map((g) => String(g)))].sort().join(",");
  return `support:${movementKey(String(lift))}:${gs}${prime ? ":prime" : ""}`;
}

// For each lagging compound whose contributing muscles are under-trained, one
// targeted supporting-work suggestion. Reads the deterministic program-state (or an
// injected one, mirroring programEvolutionTrigger's testable opts). Returns [] when
// nothing lags or there's no volume picture yet. Never throws.
export function supportWorkRead(date?: string, opts: { programState?: any } = {}): SupportWorkEntry[] {
  let ps = opts.programState;
  if (ps === undefined) {
    try {
      ps = getProgramState(date);
    } catch {
      return [];
    }
  }
  const lifts: LiftState[] = Array.isArray(ps?.lifts) ? ps.lifts : [];
  const volume: MuscleVolumeState[] = Array.isArray(ps?.volume) ? ps.volume : [];
  // No volume picture (a brand-new/thin log, or a minimal injected state) → we
  // can't reason about weak links. Calm no-op.
  if (!volume.length) return [];

  const byGroup = new Map<string, MuscleVolumeState>();
  for (const v of volume) if (v?.muscle_group) byGroup.set(String(v.muscle_group), v);

  const out: SupportWorkEntry[] = [];
  for (const lift of lifts) {
    if (lift?.status !== "plateaued" && lift?.status !== "regressing") continue;
    const support = matchSupport(String(lift.exercise ?? ""));
    if (!support) continue;

    // Prime-mover guard FIRST: if the lift's own prime volume is below band, the
    // lift is likely just under-practiced — say that, don't blame the synergists.
    const primeWeak = support.prime
      .map((g) => byGroup.get(g))
      .filter((v): v is MuscleVolumeState => !!v && isPrimeUnderTrained(v));
    if (primeWeak.length) {
      const groups = primeWeak.map((v) => v.muscle_group as MuscleGroup);
      out.push({
        lift: lift.exercise,
        status: lift.status,
        prime_gap: true,
        weak_links: primeWeak.map(weakLinkOf),
        suggestion: primeSuggestion(lift, support, groups),
        signature: signatureOf(lift.exercise, groups, true),
      });
      continue;
    }

    // Otherwise: which synergists are the weak link? A tracked group BELOW its
    // band, or one entirely ABSENT from the volume picture (never trained lately —
    // the strongest gap, e.g. grip work that's never programmed).
    const weakStates: MuscleVolumeState[] = [];
    for (const g of support.synergists) {
      const v = byGroup.get(g);
      if (v) {
        if (isWeakSynergist(v)) weakStates.push(v);
      } else {
        weakStates.push({ muscle_group: g, weekly_sets: 0, band: "low", trend: null });
      }
    }
    if (!weakStates.length) continue;

    const groups = weakStates.map((v) => v.muscle_group as MuscleGroup);
    out.push({
      lift: lift.exercise,
      status: lift.status,
      prime_gap: false,
      weak_links: weakStates.map(weakLinkOf),
      suggestion: synergistSuggestion(lift, groups),
      signature: signatureOf(lift.exercise, groups, false),
    });
  }
  // Deterministic order: liftStates yields lifts by last-activity date with no
  // tiebreaker, so sort the entries by their stable signature before returning —
  // the trigger folds them in this order, keeping the composed evolution signature
  // order-independent of the input lift ordering.
  out.sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  return out;
}
