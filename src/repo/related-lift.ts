// ============================================================================
// related-lift.ts — "you haven't done this one, but you've been driving that
// one, so it probably starts about here."
//
// When a movement is rotated into the plan with no logged history of its own,
// the honest floor is "start light, log what you lift". But the athlete is not
// starting from nothing: a first incline bench when the flat bench has been
// moving 95 lb every week has a sensible starting IDEA, and saying nothing is
// the coach withholding what it plainly knows.
//
// This is that idea, and nothing more. Rules that keep it honest:
//   • DETERMINISTIC. A small hand-written map of high-confidence movement pairs.
//     Never an agent guess, never fitted from this athlete's data.
//   • ONE DIRECTION. Every ratio is ≤ 1 and points from the harder anchor to the
//     lighter derivative. We never extrapolate upward from a lighter lift — the
//     estimate that lands too heavy is the one that hurts.
//   • A STRICT ALLOWLIST. An unrecognized word in the name ("Paused", "Close
//     Grip", "Smith", "Machine", "Sumo") disqualifies the lift outright: a
//     machine's numbers are not a barbell's, and a variant we can't name is a
//     variant we can't anchor.
//   • ROUNDED DOWN to a practical plate/dumbbell increment, and surfaced as a
//     starting idea the athlete overwrites by logging — never a settled target.
//   • LOAD ONLY. A timed hold is never derived from a sibling movement (a
//     dead-hang duration belongs to its exact grip — see recentWorkingSeconds).
//   • NEVER PERSISTED. This number must not reach plan_items.target_weight. The
//     progression engine grounds each step at the HARDER of the plan target and
//     real logged weight, so a stored estimate becomes a floor the athlete cannot
//     log their way below — an overshooting guess would outlive every honest
//     session that contradicts it. It belongs in the live prescription, where the
//     first logged set replaces it. Callers: read it, show it, don't save it.
// ============================================================================
import { db } from "../db.js";
import { normalizeExerciseName, normalizedExerciseKey } from "./exercise-canon.js";
import { recentWorkingWeight } from "./exercises.js";

// The movements this map can name. Anything else resolves to null and falls back
// to the baseline-establishing behavior.
export type LiftSlot =
  | "bench_flat_barbell"
  | "bench_incline_barbell"
  | "bench_flat_dumbbell"
  | "bench_incline_dumbbell"
  | "press_overhead_barbell"
  | "press_overhead_dumbbell"
  | "squat_back_barbell"
  | "squat_front_barbell"
  | "hinge_deadlift_barbell"
  | "hinge_rdl_barbell"
  | "row_bentover_barbell"
  | "row_dumbbell";

// Every word a name may contain and still be classifiable. The allowlist (rather
// than a blocklist of odd variants) is what makes this conservative by default:
// a movement nobody wrote down here simply doesn't get an anchor.
const CLASSIFIABLE_TOKENS = new Set([
  "barbell",
  "bb",
  "dumbbell",
  "dumbbells",
  "db",
  "bench",
  "press",
  "squat",
  "row",
  "deadlift",
  "deadlifts",
  "rdl",
  "incline",
  "flat",
  "back",
  "front",
  "romanian",
  "conventional",
  "overhead",
  "military",
  "ohp",
  "shoulder",
  "bent",
  "over",
  "pendlay",
  "standing",
  "seated",
  "chest",
]);

// The movement identity behind a name, or null when it can't be named with
// confidence. Pure over the string — exported for direct unit testing.
export function classifyLiftSlot(name: string): LiftSlot | null {
  const tokens = normalizeExerciseName(name).split(" ").filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.some((t) => !CLASSIFIABLE_TOKENS.has(t))) return null;
  const has = (t: string) => tokens.includes(t);
  const dumbbell = has("dumbbell") || has("dumbbells") || has("db");
  const barbell = has("barbell") || has("bb");
  if (dumbbell && barbell) return null; // an incoherent name, not a movement

  // Hinge. A dumbbell/kettlebell hinge loads so differently that it gets no edge.
  if (has("deadlift") || has("deadlifts") || has("rdl")) {
    if (dumbbell) return null;
    if (has("romanian") || has("rdl")) return "hinge_rdl_barbell";
    if (has("front") || has("back") || has("incline") || has("flat")) return null;
    return "hinge_deadlift_barbell";
  }
  // Squat. Bare "Squat" and "Barbell Squat" both read as the back squat.
  if (has("squat")) {
    if (dumbbell) return null;
    if (has("front")) return "squat_front_barbell";
    if (has("back") || barbell || tokens.length === 1) return "squat_back_barbell";
    return null;
  }
  // Row. A bare "Seated Row" is a machine — it needs an implement or a named
  // barbell pattern to be comparable.
  if (has("row")) {
    if (dumbbell) return "row_dumbbell";
    if (barbell || has("bent") || has("pendlay")) return "row_bentover_barbell";
    return null;
  }
  // Vertical press.
  if (has("overhead") || has("military") || has("ohp") || (has("shoulder") && has("press"))) {
    if (has("bench")) return null;
    if (dumbbell) return "press_overhead_dumbbell";
    if (barbell || has("military") || has("ohp") || has("overhead")) return "press_overhead_barbell";
    return null; // a bare "Shoulder Press" is most likely a machine
  }
  // Horizontal press. "Chest Press" with no implement is a machine, so it needs
  // the word "bench" or a named implement before it anchors anything.
  if (has("press") && (has("bench") || has("chest"))) {
    if (!has("bench") && !barbell && !dumbbell) return null;
    if (has("incline")) return dumbbell ? "bench_incline_dumbbell" : "bench_incline_barbell";
    return dumbbell ? "bench_flat_dumbbell" : "bench_flat_barbell";
  }
  // "Incline Dumbbell Press" / "Incline Barbell Press" — a chest press that never
  // says "bench". Still needs the implement (a bare "Incline Press" is a machine).
  if (has("press") && has("incline") && (barbell || dumbbell))
    return dumbbell ? "bench_incline_dumbbell" : "bench_incline_barbell";
  return null;
}

export interface RelatedLiftRatio {
  to: LiftSlot;
  from: LiftSlot;
  ratio: number;
  // Why this pair is trustworthy, in the athlete's own terms. Not currently
  // rendered; it is here so the map documents its own reasoning at the ratio.
  basis: string;
}

// The map. SMALL on purpose: only pairs where the relationship is a well-worn
// training convention rather than a per-athlete accident, and every ratio sits at
// the CONSERVATIVE end of the usual range. Dumbbell figures are PER HAND, which
// is how Cairn logs them. Order matters — the first edge with real history wins.
export const RELATED_LIFT_RATIOS: readonly RelatedLiftRatio[] = [
  {
    to: "bench_incline_barbell",
    from: "bench_flat_barbell",
    ratio: 0.8,
    basis: "an incline bench sits a little under a flat bench",
  },
  {
    to: "bench_flat_dumbbell",
    from: "bench_flat_barbell",
    ratio: 0.4,
    basis: "each dumbbell carries about a third of a barbell bench, a touch more with the stabilizing cost",
  },
  {
    to: "bench_incline_dumbbell",
    from: "bench_flat_dumbbell",
    ratio: 0.85,
    basis: "an incline dumbbell press sits under the flat version",
  },
  {
    to: "bench_incline_dumbbell",
    from: "bench_flat_barbell",
    ratio: 0.35,
    basis: "an incline dumbbell press off a flat barbell bench, both steps taken conservatively",
  },
  {
    to: "press_overhead_dumbbell",
    from: "press_overhead_barbell",
    ratio: 0.4,
    basis: "each dumbbell carries about a third of a barbell overhead press",
  },
  {
    to: "squat_front_barbell",
    from: "squat_back_barbell",
    ratio: 0.75,
    basis: "a front squat sits well under a back squat",
  },
  {
    to: "hinge_rdl_barbell",
    from: "hinge_deadlift_barbell",
    ratio: 0.6,
    basis: "a Romanian deadlift is a partial-range hinge, trained lighter than a full pull",
  },
  {
    to: "row_dumbbell",
    from: "row_bentover_barbell",
    ratio: 0.4,
    basis: "each dumbbell carries about a third of a barbell row",
  },
];

// A starting idea rounds DOWN to a plate/dumbbell increment you can actually load,
// and anything that lands below a real working load is no idea at all.
const ROUND_DOWN_LB = 5;
const MIN_START_LB = 10;

export interface RelatedLiftStart {
  slot: LiftSlot;
  source_exercise: string; // the stored display name whose history anchored this
  source_slot: LiftSlot;
  source_weight: number; // that lift's real recent working weight
  ratio: number;
  weight: number; // the conservative starting idea, rounded down
}

// Every stored exercise that can be named, bucketed by movement identity.
function storedNamesBySlot(): Map<LiftSlot, string[]> {
  const out = new Map<LiftSlot, string[]>();
  let rows: Array<{ name?: string }> = [];
  try {
    rows = db.prepare(`SELECT name FROM exercises`).all() as any[];
  } catch {
    return out;
  }
  for (const row of rows) {
    const name = String(row?.name ?? "");
    const slot = classifyLiftSlot(name);
    if (!slot) continue;
    const list = out.get(slot);
    if (list) list.push(name);
    else out.set(slot, [name]);
  }
  return out;
}

// The conservative starting load for `name` inferred from a RELATED lift the
// athlete actually trains, or null when nothing in the map anchors it. Never
// consults `name`'s own history — the caller prefers direct history and only
// falls through to here. Assisted (negative) and bodyweight anchors are skipped:
// an assist number describes a different regime entirely.
export function relatedLiftStart(name: string): RelatedLiftStart | null {
  const slot = classifyLiftSlot(name);
  if (!slot) return null;
  const edges = RELATED_LIFT_RATIOS.filter((edge) => edge.to === slot);
  if (!edges.length) return null;
  const bySlot = storedNamesBySlot();
  const self = normalizedExerciseKey(name);
  for (const edge of edges) {
    // When two stored names key to the same movement ("Bench Press" and "Barbell
    // Bench Press"), the LOWER working weight wins — the conservative read.
    let sourceName: string | null = null;
    let sourceWeight: number | null = null;
    for (const candidate of bySlot.get(edge.from) ?? []) {
      if (normalizedExerciseKey(candidate) === self) continue;
      const working = recentWorkingWeight(candidate);
      if (working == null || working <= 0) continue;
      if (sourceWeight == null || working < sourceWeight) {
        sourceWeight = working;
        sourceName = candidate;
      }
    }
    if (sourceName == null || sourceWeight == null) continue;
    const weight = Math.floor((sourceWeight * edge.ratio) / ROUND_DOWN_LB) * ROUND_DOWN_LB;
    if (weight < MIN_START_LB) continue;
    return {
      slot,
      source_exercise: sourceName,
      source_slot: edge.from,
      source_weight: sourceWeight,
      ratio: edge.ratio,
      weight,
    };
  }
  return null;
}
