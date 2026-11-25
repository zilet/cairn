// How one variant's change can be read across a swap: "you have only just started the
// incline dumbbell press, but you have been pressing flat for months, so is the press
// moving?". The capability read (strength-capability.ts) asks here when a variant has no
// earlier window of its own.
//
// Strength is partly specific to the exercise, so each variant's estimate stays its own
// number: two histories are never merged, and a variant's load is never compared with a
// sibling's load. Only a RELATIVE change carries across, and only through a ratio this
// module can stand behind:
//
//   - LEARNED, from this athlete's own log. A bridge pair is the two variants trained
//     within BRIDGE_MAX_GAP_DAYS of each other at top-set reps within BRIDGE_MAX_REP_GAP,
//     each exposure used at most once (closest dates first). Each pair's ratio is the two
//     capacity envelopes as they stood on those days. With at least BRIDGE_MIN_PAIRS
//     pairs whose ratios agree within BRIDGE_AGREEMENT (the highest over the lowest), the
//     median is the ratio. Pairs that disagree are rejected: they say the two lifts did not move
//     together, so no learned ratio stands.
//   - TABLE, the existing conservative map (related-lift.ts RELATED_LIFT_RATIOS), and
//     only DOWNWARD: from the harder anchor to the lighter derivative, never upward. Its
//     ratios sit at the low end of the usual range, so an estimate built on them
//     understates the earlier value: the caller may let it confirm a hold or show a
//     slide, never manufacture a climb (strength-capability.ts clamps it).
//   - NONE. The variant contributes nothing yet; the unit carries on from its other
//     contributors.
//
// Pure: no db, no agent, nothing stored. A ratio is never printed or persisted.
import { median } from "../lib/numbers.js";
import { daysBetweenISO } from "./shared.js";
import { classifyLiftSlot, RELATED_LIFT_RATIOS } from "./related-lift.js";
import { capacityEnvelopeAsOf, type StrengthExposure } from "./strength-objectives.js";

/** Two exposures this close in time bridge the variants. */
export const BRIDGE_MAX_GAP_DAYS = 10;
/** ...and only when their top sets sit this close in reps (a 5RM is not a 12RM). */
export const BRIDGE_MAX_REP_GAP = 3;
/** One pair is an accident; two that agree are a relationship. */
export const BRIDGE_MIN_PAIRS = 2;
/** How far apart the highest and lowest pair ratios may sit before the pairs are said to disagree. */
export const BRIDGE_AGREEMENT = 0.05;

export interface BridgePair {
  variant_date: string;
  sibling_date: string;
  /** variant envelope / sibling envelope on those days. Internal; never printed. */
  ratio: number;
}

export type VariantTransfer =
  | { kind: "learned"; ratio: number; pairs: number }
  | { kind: "table"; ratio: number }
  | { kind: "none"; reason: "no_bridge" | "pairs_disagree" | "no_table_edge" };

const gapDays = (a: string, b: string): number => Math.abs(daysBetweenISO(a, b) ?? Number.POSITIVE_INFINITY);

/**
 * The bridge pairs between a variant and a sibling (both honest, comparable series, sorted
 * or not). Closest dates pair first and each exposure is used once.
 */
export function bridgePairs(variant: readonly StrengthExposure[], sibling: readonly StrengthExposure[]): BridgePair[] {
  const v = [...variant].sort((a, b) => a.date.localeCompare(b.date));
  const s = [...sibling].sort((a, b) => a.date.localeCompare(b.date));
  const candidates: Array<{ vi: number; si: number; gap: number }> = [];
  for (let vi = 0; vi < v.length; vi++) {
    for (let si = 0; si < s.length; si++) {
      const gap = gapDays(v[vi].date, s[si].date);
      if (gap > BRIDGE_MAX_GAP_DAYS) continue;
      if (Math.abs(Number(v[vi].top_reps) - Number(s[si].top_reps)) > BRIDGE_MAX_REP_GAP) continue;
      candidates.push({ vi, si, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap || a.vi - b.vi || a.si - b.si);
  const usedV = new Set<number>();
  const usedS = new Set<number>();
  const pairs: BridgePair[] = [];
  for (const c of candidates) {
    if (usedV.has(c.vi) || usedS.has(c.si)) continue;
    const ve = capacityEnvelopeAsOf(v, v[c.vi].date);
    const se = capacityEnvelopeAsOf(s, s[c.si].date);
    if (!ve || !se || !(ve.est_1rm > 0) || !(se.est_1rm > 0)) continue;
    usedV.add(c.vi);
    usedS.add(c.si);
    pairs.push({ variant_date: v[c.vi].date, sibling_date: s[c.si].date, ratio: ve.est_1rm / se.est_1rm });
  }
  return pairs.sort((a, b) => a.variant_date.localeCompare(b.variant_date));
}

/**
 * The ratio this athlete's own log shows between a variant and a sibling (variant ~=
 * sibling x ratio), or why there is none: too few bridge pairs, or pairs that disagree.
 */
export function learnedTransferRatio(
  variant: readonly StrengthExposure[],
  sibling: readonly StrengthExposure[]
): { ratio: number; pairs: number } | { ratio: null; reason: "no_bridge" | "pairs_disagree" } {
  const pairs = bridgePairs(variant, sibling).filter((p) => Number.isFinite(p.ratio) && p.ratio > 0);
  if (pairs.length < BRIDGE_MIN_PAIRS) return { ratio: null, reason: "no_bridge" };
  const ratios = pairs.map((p) => p.ratio);
  const mid = median(ratios);
  if (mid == null || !(mid > 0)) return { ratio: null, reason: "no_bridge" };
  // Agreement is the whole spread: the highest pair over the lowest, never each pair
  // against the median (two pairs ten percent apart each sit only five from their middle).
  if (Math.max(...ratios) / Math.min(...ratios) - 1 > BRIDGE_AGREEMENT + 1e-9)
    return { ratio: null, reason: "pairs_disagree" };
  return { ratio: mid, pairs: pairs.length };
}

/**
 * The conservative table's ratio for reading `variant` off `sibling` (variant ~= sibling x
 * ratio), only when the sibling is the harder anchor and the variant its lighter
 * derivative. Never upward: a lighter sibling never estimates a heavier variant.
 */
export function tableTransferRatio(variantName: string, siblingName: string): number | null {
  const to = classifyLiftSlot(variantName);
  const from = classifyLiftSlot(siblingName);
  if (!to || !from || to === from) return null;
  const edge = RELATED_LIFT_RATIOS.find((e) => e.to === to && e.from === from);
  return edge && edge.ratio > 0 && edge.ratio <= 1 ? edge.ratio : null;
}

/** How a variant can be read off a sibling: learned first, then the table, else none. */
export function variantTransfer(
  variant: { name: string; exposures: readonly StrengthExposure[] },
  sibling: { name: string; exposures: readonly StrengthExposure[] }
): VariantTransfer {
  const learned = learnedTransferRatio(variant.exposures, sibling.exposures);
  if (learned.ratio != null) return { kind: "learned", ratio: learned.ratio, pairs: learned.pairs };
  // No learned ratio (too few pairs, or pairs that disagree): the conservative table, which
  // the caller only ever lets hold or slide.
  const table = tableTransferRatio(variant.name, sibling.name);
  if (table != null) return { kind: "table", ratio: table };
  return { kind: "none", reason: learned.reason === "pairs_disagree" ? "pairs_disagree" : "no_table_edge" };
}
