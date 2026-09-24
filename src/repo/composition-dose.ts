import type { DailyDecisionCandidate, DailyDecisionEnvelope } from "./daily-decision.js";

// Composition's half of the weekly dose (weekly-dose-ledger.ts): the envelope's
// `dose.fills` land on today's card as ONE extra working set on an item, inside the
// day's own budget. Runs in normalizeComposedSession after every clamp and after the
// top-set/reach insertion (so a reach always keeps its budget first), and before the
// card is put into effect order. Never runs on a plan snapshot (the caller skips it).
//
// What it may change: an item's `sets` (+1 at most, never past the per-item cap, the
// remaining working-set budget, or the day's duration cap) and a short note in `note`
// (pickDayVariant over a variant set). What it must NEVER change: target_weight,
// target_seconds, rep_low/rep_high, the item list itself (no item added or dropped),
// the order, a top set or reach item, a reduced-area item, or anything persisted to
// the plan. `brain_change_reason` is not its to write.

export interface WeeklyDoseBudget {
  // Working sets still unspent under the day's working-set cap after the caps loop and
  // the top-set insertion.
  remainingSets: number;
  // The day's per-item set cap (a reduced-area item is capped lower still — see
  // `reducedExercises`).
  itemSetCap: number;
  // The day's item-count cap.
  cap: number;
  // envelope.caps.duration_min — a fill that would push the estimate past it is skipped.
  minutesCap: number | null;
  // The composition's own estimate before the dose (the session's est_minutes).
  estMinutes: number | null;
}

export interface WeeklyDoseComposeContext {
  envelope: DailyDecisionEnvelope;
  date: string;
  budget: WeeklyDoseBudget;
  // Lowercased exercise names whose group the envelope reduced (2-set cap, eased load).
  reducedExercises: ReadonlySet<string>;
  // Canonical groups the envelope reads saturated / excluded.
  saturatedGroups: ReadonlySet<string>;
  excludedGroups: ReadonlySet<string>;
  // Today's candidates by lowercased exercise name.
  candidates: ReadonlyMap<string, DailyDecisionCandidate>;
}

export interface WeeklyDoseComposeResult {
  items: any[];
  changed: boolean;
  // Minutes the added sets cost; the caller adds them to est_minutes BEFORE the
  // existing duration clamp.
  estAddMin: number;
}

/** Identity for now: the same array back, nothing changed, no minutes added. */
export function applyWeeklyDose(items: any[], _ctx: WeeklyDoseComposeContext): WeeklyDoseComposeResult {
  return { items, changed: false, estAddMin: 0 };
}
