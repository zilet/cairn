import type { DailyDecisionEnvelope } from "./daily-decision.js";
import { pressSlotKey } from "./plan-quality.js";
import { finite } from "../lib/numbers.js";

// The card's SHAPE after its content is settled: one loaded movement per region, and
// antagonist pairs done as supersets. Both run inside normalizeComposedSession
// (daily-composition.ts), after every safety clamp has already decided what is on the
// card and at what load.
//
// What this module may change: which of two same-region items stays (a drop, reported
// as a rejection), an item's `superset_group`, the relative order of items WITHIN one
// effect tier (to seat partners next to each other), and a short pairing hint in `note`.
// What it must NEVER change: target_weight, target_seconds, sets, rep_low/rep_high,
// reach/top_set items, an item's effect tier (prep → primary → secondary → isolation →
// core → cardio stays the order), or anything persisted to the plan — a pairing is a
// property of today's card only.

function preferPressItem(a: any, b: any, candidateNames: Set<string>): any {
  const aName = String(a?.exercise ?? "").toLowerCase();
  const bName = String(b?.exercise ?? "").toLowerCase();
  const aCand = candidateNames.has(aName);
  const bCand = candidateNames.has(bName);
  if (aCand !== bCand) return aCand ? a : b;
  const aSets = finite(a?.sets) ?? 0;
  const bSets = finite(b?.sets) ?? 0;
  if (aSets !== bSets) return aSets > bSets ? a : b;
  const aLoad = Math.abs(finite(a?.target_weight) ?? 0);
  const bLoad = Math.abs(finite(b?.target_weight) ?? 0);
  if (aLoad !== bLoad) return aLoad > bLoad ? a : b;
  return a;
}

function dropDuplicatePressAngles(
  items: any[],
  candidateNames: Set<string>
): { items: any[]; rejected: Array<{ exercise: string; reason: string }> } {
  const rejected: Array<{ exercise: string; reason: string }> = [];
  const keep = items.map(() => true);
  const keeper = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const slot = pressSlotKey(String(items[i]?.exercise ?? ""));
    if (!slot) continue;
    const prev = keeper.get(slot);
    if (prev == null) {
      keeper.set(slot, i);
      continue;
    }
    const winner = preferPressItem(items[prev], items[i], candidateNames) === items[i] ? i : prev;
    const loser = winner === i ? prev : i;
    keep[loser] = false;
    keeper.set(slot, winner);
    rejected.push({ exercise: String(items[loser]?.exercise ?? ""), reason: "duplicate_press_angle" });
  }
  if (!rejected.length) return { items, rejected };
  return { items: items.filter((_, i) => keep[i]), rejected };
}

/**
 * One loaded movement per region on a composed card. The weekly plan already refuses
 * a second flat press at write time, but a composed session can still pile two (agent
 * output, or a saturated-group stand-in stealing another day's bench). The loser is
 * dropped and reported; the keeper prefers today's own template (a candidate), then
 * more sets, then the heavier load. Identity (the same array back) when nothing
 * collapses. Today: the horizontal-press angles only (`pressSlotKey`).
 */
export function collapseRegionDuplicates(
  items: any[],
  candidateNames: Set<string>
): { items: any[]; rejected: Array<{ exercise: string; reason: string }> } {
  return dropDuplicatePressAngles(items, candidateNames);
}

export interface PairingContext {
  envelope: DailyDecisionEnvelope;
  // The read day — the key every pairing hint rotates on (pickDayVariant).
  date: string;
  // `manual_plan`: the athlete's own snapshotted day. Carried so the package can decide
  // whether a pairing hint belongs on a card the athlete wrote themselves.
  planSnapshot: boolean;
}

export interface PairingResult {
  items: any[];
  changed: boolean;
}

/**
 * Seat antagonist pairs as supersets on today's card. Runs on the FINAL list, after
 * `orderPlanItemsForEffect`; when `changed` is true the caller re-numbers positions.
 * Identity for now: the same array back, `changed: false`.
 */
export function pairForSession(items: any[], _ctx: PairingContext): PairingResult {
  return { items, changed: false };
}
