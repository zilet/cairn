// ============================================================================
// focus-candidate.ts — the SHARED producer contract + the ONE ranking primitive.
//
// Cairn used to hold THREE independent "what to do next" scoring engines over the
// same reads: the conductor (coaching-focus), nextBestStep (next-step), and the
// programAdjustments digest. That's the "two competing what's-next voices" problem
// the v1 plan (K3) set out to close.
//
// This module is the single shared floor under all of them:
//   - `FocusCandidate` is what a PRODUCER emits — plain words only (domain, a stable
//     `kind`, the plain-language `priority_inputs` that caused it, a headline, a why,
//     an optional move and a review-only action). It carries NO score, exactly like a
//     marker never carries its impact_score across the boundary.
//   - `scoreFocus` is the ONE ranking formula (leverage · weight + actionability +
//     freshness − a cooldown penalty). `rankFocus` is the ONE sort. The conductor is
//     the sole arbiter that assigns leverage (a producer never scores itself) and
//     calls these; nextBestStep is a VIEW that reuses the very same primitive.
//
// Constitution: leverage is INTERNAL ordering only, never surfaced (no 0-100 grade).
// Every field a producer emits is plain, athlete-safe language.
// ============================================================================

export type FocusDomain = "training" | "running" | "nutrition" | "health" | "recovery" | "body";

// Where an arbitrated candidate sits in the conductor's one sequenced focus.
export type FocusSlot = "lead" | "parallel" | "later";

// What a producer emits. No score, no leverage — plain words the athlete could read.
export interface FocusCandidate {
  domain: FocusDomain;
  /** Stable + coarse key, e.g. "training-stall", "risk-cvd", "journey-milestone". */
  kind: string;
  /** Plain-language evidence that caused this to surface. Bounded, never a number-as-grade. */
  priority_inputs: string[];
  headline: string;
  why: string;
  /** The concrete move, when there is one. */
  move?: string | null;
  /** Suggested UI action — still review-only; nothing auto-applies. */
  action?: { kind: string; label: string } | null;
}

// The INTERNAL wrapper the arbiter ranks: a candidate + the leverage the conductor
// assigned it + the coarse facts that break ties. `leverage`, `actionable`, `fresh`
// and `penalty` are the same spirit as marker impact_score — they shape the ranking
// but NEVER cross the public boundary.
export interface RankedFocus {
  candidate: FocusCandidate;
  leverage: number;
  slot?: FocusSlot;
  actionable?: boolean;
  fresh?: boolean;
  /** A cooldown / suppression penalty (snooze, done). Large ⇒ effectively hidden. */
  penalty?: number;
  /** Life/soreness annotation set by the conductor's guard (never a producer). */
  caveat?: string;
}

// The single scoring coefficients — moved here from next-step so exactly one module
// owns the formula. Leverage dominates; actionability and freshness only break ties.
export const LEVERAGE_WEIGHT = 10; // a 3-leverage lever clears a 0-leverage one
export const ACTIONABLE_BONUS = 2;
export const FRESH_BONUS = 1;

// THE ONE ranking formula, in scalar form — the conductor sorts its own internal
// candidates through this too, so leverage always means the same thing everywhere.
export function focusScore(
  leverage: number,
  opts: { actionable?: boolean; fresh?: boolean; penalty?: number } = {},
): number {
  return (
    leverage * LEVERAGE_WEIGHT +
    (opts.actionable ? ACTIONABLE_BONUS : 0) +
    (opts.fresh ? FRESH_BONUS : 0) -
    (opts.penalty ?? 0)
  );
}

// THE ONE ranking formula over a wrapped candidate. Every "what's next" surface
// scores through this (or its scalar sibling above).
export function scoreFocus(r: RankedFocus): number {
  return focusScore(r.leverage, { actionable: r.actionable, fresh: r.fresh, penalty: r.penalty });
}

// THE ONE sort — highest score first, stable on ties (input order preserved). The
// conductor and nextBestStep both call this; neither keeps its own scorer.
export function rankFocus<T extends RankedFocus>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const d = scoreFocus(b.item) - scoreFocus(a.item);
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.item);
}
