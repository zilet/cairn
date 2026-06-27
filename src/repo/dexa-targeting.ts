// DEXA-driven exercise targeting — maps the rich DEXA regional read
// (src/repo/standing.ts `healthStanding().body_comp.regional`) to concrete TRAINING
// (and one NUTRITION) decisions, so the coach focuses the right work with a plain
// "path to move it by the next checkup".
//
// This is the strength-targeting counterpart to performance.ts (which benchmarks
// where the athlete STANDS): performance reads logged lifts; this reads the body scan
// and says where to point the volume. It is a PURE read over the already-computed
// `regional` object — no DB writes, no agent calls, no migration.
//
// Constitution: T/Z-scores, ALMI and FFMI are RECOGNIZED clinical/reference reads
// (the same class as VO2max-for-age in standing.ts / performance.ts) — they are kept
// as reference reads, NEVER a Cairn-invented 0-100 score. Bone-density / visceral-fat
// signals are framed as INFORMATIONAL ("worth discussing with your clinician"),
// mirroring src/repo/symptom-links.ts — never alarmist, never a diagnosis. Every read
// is null-safe and quiet by default: no DEXA → `{ available: false }`.

import { MUSCLE_LANDMARKS } from "./exercise-canon.js";
import { examplesForGroup } from "./exercise-variations.js";
import { getProfile } from "./profile.js";
import { healthStanding } from "./standing.js";

// ── public shape ─────────────────────────────────────────────────────────────

export interface DexaTarget {
  // The plain-language area this target speaks to ("legs", "bone density", …).
  area: string;
  // What the scan actually shows, in plain words (no score).
  signal: string;
  // The bias to apply — what to do more (or less) of.
  bias: string;
  // Concrete movements to reach for (training) or actions (nutrition).
  moves: string[];
  domain: "training" | "nutrition";
  // The plain-language "what moves this by your next DEXA".
  path: string;
  // Canonical muscle groups to bias UP (training targets) — for progression.ts /
  // programBalance to consume; empty for nutrition targets.
  groups: string[];
  // BMD / visceral signals are informational ("worth raising with your clinician").
  informational: boolean;
}

export interface DexaTargeting {
  available: boolean;
  targets: DexaTarget[];
  // The single highest-leverage target (or null when nothing to say).
  lead: DexaTarget | null;
  // A short, plain-language "between now and your next scan" focus line.
  next_dexa_focus: string | null;
}

// The `regional` object as produced by standing.ts `dexaRegional`.
export interface DexaRegional {
  visceral_fat_lbs: number | null;
  almi: number | null;
  ffmi: number | null;
  bmd_total: number | null;
  t_score: number | null;
  z_score: number | null;
  android_gynoid: number | null;
  fat: { trunk: number | null; arms: number | null; legs: number | null };
  lean: { trunk: number | null; arms: number | null; legs: number | null };
  notes?: any[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fin(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

// Concrete movements for a canonical muscle group, de-duped and capped. Falls back
// to a safe label if the curated library has nothing (it always does for these).
function movesFor(groups: string[], n = 3): string[] {
  const out: string[] = [];
  for (const g of groups) {
    let ex: string[] = [];
    try {
      ex = examplesForGroup(g, n);
    } catch {
      ex = [];
    }
    for (const name of ex) if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, n);
}

// Is the muscle group a real, set-counting strength group (so a "bias volume up"
// target makes sense)? Mobility is non-counting (null landmark).
function countingGroup(g: string): boolean {
  return MUSCLE_LANDMARKS[g] !== null && MUSCLE_LANDMARKS[g] !== undefined;
}

function isRunner(profile: any): boolean {
  const disc = String(profile?.primary_discipline ?? "").toLowerCase();
  return disc === "endurance" || disc === "hybrid" || !!profile?.endurance_sport;
}

// Sex-aware lean-mass floors. ALMI (appendicular lean mass index) and FFMI are
// recognized reference reads; below the floor reads "lean is light for you" — an
// orientation, not a clinical sarcopenia call.
function leanFloor(sex: string, kind: "almi" | "ffmi"): number {
  const female = String(sex).toLowerCase() === "female";
  if (kind === "almi") return female ? 6.0 : 7.5;
  return female ? 15.0 : 19.0; // ffmi
}

// Resolve the regional read: prefer an explicitly injected one (so a single
// getCoachContext build never recomputes healthStanding), else read it live.
function loadRegional(opts?: { regional?: DexaRegional | null }): DexaRegional | null {
  if (opts && Object.hasOwn(opts, "regional")) {
    return opts.regional ?? null;
  }
  try {
    return (healthStanding() as any)?.body_comp?.regional ?? null;
  } catch {
    return null;
  }
}

// ── the engine ───────────────────────────────────────────────────────────────

export function dexaTargeting(
  opts?: { regional?: DexaRegional | null; profile?: any }
): DexaTargeting {
  const regional = loadRegional(opts);
  if (!regional) return { available: false, targets: [], lead: null, next_dexa_focus: null };

  const profile = opts?.profile ?? (() => { try { return getProfile() ?? {}; } catch { return {}; } })();
  const sex = String(profile?.sex ?? "male").toLowerCase();
  const runner = isRunner(profile);

  const almi = fin(regional.almi);
  const ffmi = fin(regional.ffmi);
  const tScore = fin(regional.t_score);
  const zScore = fin(regional.z_score);
  const visceral = fin(regional.visceral_fat_lbs);
  const ag = fin(regional.android_gynoid);
  const fat = regional.fat ?? { trunk: null, arms: null, legs: null };
  const lean = regional.lean ?? { trunk: null, arms: null, legs: null };

  // priority is INTERNAL ordering only (never surfaced — like marker impact_score).
  const ranked: Array<{ priority: number; target: DexaTarget }> = [];

  // ── 1. Low BMD (T/Z-score) → loaded + impact work (informational) ───────────
  // Osteoporosis-range (T ≤ -2.5) outranks everything; osteopenia (-2.5 < T ≤ -1)
  // or a low-for-age Z (≤ -2) is a softer, still-worth-it nudge.
  if (tScore != null || zScore != null) {
    const osteoporotic = tScore != null && tScore <= -2.5;
    const osteopenic = tScore != null && tScore > -2.5 && tScore <= -1;
    const lowForAge = zScore != null && zScore <= -2;
    if (osteoporotic || osteopenic || lowForAge) {
      const boneMoves = movesFor(["quads", "hamstrings", "forearms"], 3); // squat + hinge + loaded carry
      const sevTxt = osteoporotic
        ? `Bone density reads below the typical range (T-score ${fmt(tScore!)})`
        : lowForAge
          ? `Bone density reads below what's expected for your age (Z-score ${fmt(zScore!)})`
          : `Bone density is a little below average (T-score ${fmt(tScore!)})`;
      ranked.push({
        priority: osteoporotic ? 5 : lowForAge ? 4 : 2.5,
        target: {
          area: "bone density",
          signal: `${sevTxt} — worth discussing with your clinician.`,
          bias: "favour heavy, loaded and impact work — the osteogenic stimulus bone responds to",
          moves: runner ? [...boneMoves, "Easy impact running (itself osteogenic)"].slice(0, 3) : boneMoves,
          domain: "training",
          path:
            "Bone adapts slowly — 6-12 months of progressive heavy loading, loaded carries" +
            (runner ? " and regular impact running" : "") +
            " is the window where a re-scan can show movement. Informational, not a diagnosis — raise it with your clinician.",
          groups: ["quads", "hamstrings", "glutes"],
          informational: true,
        },
      });
    }
  }

  // ── 2. Low ALMI / FFMI (lean is light for you) → bias appendicular volume up ─
  const almiLow = almi != null && almi < leanFloor(sex, "almi");
  const ffmiLow = almi == null && ffmi != null && ffmi < leanFloor(sex, "ffmi");
  if (almiLow || ffmiLow) {
    const idxTxt = almiLow ? `ALMI ${fmt(almi!)}` : `FFMI ${fmt(ffmi!)}`;
    ranked.push({
      priority: 4,
      target: {
        area: "lean mass",
        signal: `Lean-mass index reads light for you (${idxTxt}) — there's room to build appendicular muscle.`,
        bias: "bias hard sets toward legs and back; anchor protein at ~0.8 g/lb",
        moves: movesFor(["quads", "hamstrings", "back"], 3),
        domain: "training",
        path:
          "8-12 weeks of 10-16 hard sets/week across legs and back with protein around 0.8 g/lb " +
          "typically adds measurable lean mass a re-scan can pick up.",
        groups: ["quads", "hamstrings", "glutes", "back"],
        informational: false,
      },
    });
  }

  // ── 3. Regional lean asymmetry (legs vs arms development) ────────────────────
  // Typical appendicular lean splits ~2.4-3.0× more in the legs than the arms.
  // A markedly low ratio reads "legs are under-developed vs the upper body"; a high
  // one reads the reverse. Orientation only — not a left/right asymmetry diagnosis.
  if (lean.legs != null && lean.arms != null && lean.arms > 0) {
    const ratio = lean.legs / lean.arms;
    if (ratio < 2.2) {
      ranked.push({
        priority: 1.5,
        target: {
          area: "legs (vs upper body)",
          signal: `Leg lean (${fmt(lean.legs)} lb) is light relative to your arms (${fmt(lean.arms)} lb) — the lower body has room to catch up.`,
          bias: "bias volume toward the lower body; add a unilateral leg movement to even out side-to-side",
          moves: movesFor(["quads", "hamstrings", "glutes"], 3),
          domain: "training",
          path:
            "A block weighted toward legs (and a single-leg movement for symmetry) typically narrows the gap " +
            "by the next scan — lower-body lean is among the most responsive to focused volume.",
          groups: ["quads", "hamstrings", "glutes"],
          informational: false,
        },
      });
    } else if (ratio > 3.2) {
      ranked.push({
        priority: 1,
        target: {
          area: "upper body (vs legs)",
          signal: `Arm/upper lean (${fmt(lean.arms)} lb) is light relative to your legs (${fmt(lean.legs)} lb) — the upper body has room to catch up.`,
          bias: "add pulling and pressing volume for the upper body",
          moves: movesFor(["back", "biceps", "shoulders"], 3),
          domain: "training",
          path:
            "8-12 weeks weighted toward upper-body pulling and pressing typically evens the split a re-scan can read.",
          groups: ["back", "biceps", "shoulders", "chest"],
          informational: false,
        },
      });
    }
  }

  // ── 4. High visceral / android (trunk) fat → Z2 + lean-safe deficit (nutrition)
  const viscHigh = visceral != null && visceral > 4;
  // Android/gynoid above the central-fat band, when visceral isn't measured directly.
  const agHigh = visceral == null && ag != null && ag > (sex === "female" ? 0.9 : 1.0);
  const trunkDominant =
    fat.trunk != null && fat.legs != null && fat.arms != null &&
    fat.trunk >= 25 && fat.trunk - Math.min(fat.legs, fat.arms) >= 4;
  if (viscHigh || agHigh || trunkDominant) {
    const sig = viscHigh
      ? `Visceral fat reads elevated (${fmt(visceral!)} lb) — the metabolically active kind.`
      : agHigh
        ? `Fat is centrally distributed (android/gynoid ${fmt(ag!)}) — the metabolic pattern.`
        : `Fat sits mostly in the trunk (${fmt(fat.trunk!)}% vs ${fmt(fat.legs!)}% legs) — the metabolic pattern.`;
    ranked.push({
      priority: viscHigh ? 3 : 2,
      target: {
        area: "visceral / central fat",
        signal: `${sig} It moves first and fast with the right routine — worth keeping an eye on, not a hard rule.`,
        bias: "pair regular zone-2 cardio with a modest, lean-safe calorie deficit",
        moves: [
          runner ? "Zone-2 easy runs (3-4×/wk)" : "Zone-2 cardio (easy runs, bike or incline walk, 3-4×/wk)",
          "A modest, lean-safe deficit (protein held high)",
        ],
        domain: "nutrition",
        path:
          "Visceral fat is the first compartment to move — 8-12 weeks of regular zone-2 plus a modest deficit " +
          "typically shows a measurable drop on a re-scan while strength and lean mass hold.",
        groups: [],
        informational: true,
      },
    });
  }

  // Order by internal priority (desc), then drop the priority key from the surface.
  ranked.sort((a, b) => b.priority - a.priority);
  const targets = ranked
    .map((r) => r.target)
    // Keep training targets honest: only bias counting groups (mobility is non-set).
    .map((t) => ({ ...t, groups: t.groups.filter(countingGroup) }));

  const lead = targets[0] ?? null;
  const next_dexa_focus = lead
    ? `Between now and your next DEXA, the highest-leverage focus is your ${lead.area}: ${lead.bias}.`
    : null;

  return { available: true, targets, lead, next_dexa_focus };
}
