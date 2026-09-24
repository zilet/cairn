import { finite } from "../lib/numbers.js";
import { isPrepPlanItem } from "../domain/training/plan-item-order.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import type { DailyDecisionCandidate, DailyDecisionEnvelope } from "./daily-decision.js";
import { CARD_NOTE_BUDGET } from "./composition-pairing.js";
import { canonicalGroup, normalizedExerciseKey } from "./exercise-canon.js";
import { WEEKLY_DOSE_STRENGTH_REP_LOW } from "./weekly-dose-ledger.js";

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
//
// Idempotent by construction: a fill lands only on an item still carrying exactly the
// plan's own set count (`fill.sets`), so a card normalized twice — an agent's composed
// session accepted later against the same envelope — never takes a second set, and an
// agent that already wrote more sets than the plan has already done the fill's work.

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

// What one working set costs on the clock, rest included. The same figure prices the
// card's own work when the session's estimate is only the cap echoed back.
export const WEEKLY_DOSE_MINUTES_PER_SET = 2.5;

// The fill's own line on the card. Calm, no numbers, no score, never a gate; rotated by
// day and exercise so two filled lifts on one screen do not print the same sentence and
// one lift reads the same all day. Each takes the group the set is for.
const groupVerb = (group: string): string => (/s$/.test(group) ? "are" : "is");
export const DOSE_FILL_NOTES: readonly [(group: string) => string, ...Array<(group: string) => string>] = [
  (group) => `One extra set here — your ${group} ${groupVerb(group)} a little behind for the week.`,
  (group) => `An added set on this one keeps the week's ${group} work where it needs to be.`,
  () => "Your week has been light on this area, so it gets one more set today.",
  () => "One more set here rounds out what this muscle gets this week.",
];

export function doseFillNote(group: string, date: string, exercise: string): string {
  const pick = pickDayVariant(DOSE_FILL_NOTES, date, `composition:dose:${normalizedExerciseKey(exercise)}`);
  return pick(group);
}

// Same rule composition uses for its own sentences: the athlete's note is never
// truncated (their safety cues sit at the end of it); the server's line yields. The
// budget is the card's own (CARD_NOTE_BUDGET, the length past which Today stops
// printing a note at all), so a line that would push the athlete's cue past it — and
// hide the cue with it — is dropped; the set still lands.
function withDoseNote(note: unknown, text: string): string {
  const existing = String(note ?? "").trim();
  if (!existing) return text.length > CARD_NOTE_BUDGET ? "" : text;
  if (existing.toLowerCase().includes(text.toLowerCase())) return existing;
  const lead = `${text.replace(/[.]+$/, "")}. `;
  if (lead.length + existing.length > CARD_NOTE_BUDGET) return existing;
  return `${lead}${existing}`;
}

function isCardio(item: any): boolean {
  return String(item?.kind ?? "").toLowerCase() === "cardio";
}

// The card's own work on the clock: every strength set (warm-ups included) at the
// per-set figure, plus any cardio's stated minutes.
function cardWorkMinutes(items: readonly any[]): number {
  let minutes = 0;
  for (const item of items) {
    if (isCardio(item)) {
      minutes += Math.max(0, finite(item?.target_duration_min) ?? 0);
      continue;
    }
    const sets = Math.max(0, finite(item?.sets) ?? 0) + Math.max(0, finite(item?.warmup_sets) ?? 0);
    minutes += sets * WEEKLY_DOSE_MINUTES_PER_SET;
  }
  return minutes;
}

/**
 * Land the envelope's dose fills on today's card: +1 set on each authorized item that
 * still carries the plan's own count, within the remaining set budget, the per-item
 * cap and the day's duration cap. Identity when the envelope authorizes nothing.
 */
export function applyWeeklyDose(items: any[], ctx: WeeklyDoseComposeContext): WeeklyDoseComposeResult {
  const fills = Array.isArray(ctx.envelope?.dose?.fills) ? ctx.envelope.dose.fills : [];
  if (!fills.length || !Array.isArray(items) || !items.length) return { items, changed: false, estAddMin: 0 };
  let remaining = Math.max(0, Math.floor(ctx.budget.remainingSets));
  if (remaining < 1) return { items, changed: false, estAddMin: 0 };

  // Lifts carrying a heavy single or the day's reach are not the fill's to touch — the
  // challenge keeps its budget and its card exactly as composed.
  const challenged = new Set<string>();
  const seenNames = new Map<string, number>();
  for (const item of items) {
    const key = normalizedExerciseKey(String(item?.exercise ?? ""));
    seenNames.set(key, (seenNames.get(key) ?? 0) + 1);
    if (item?.reach) challenged.add(key);
    if (item?.top_set_of) challenged.add(normalizedExerciseKey(String(item.top_set_of)));
  }
  for (const [key, count] of seenNames) if (count > 1) challenged.add(key);

  // The clock the fill must fit under: the card's own work, or the session's estimate
  // when it is a real one below the cap (a deterministic card echoes the cap back).
  const minutesCap = finite(ctx.budget.minutesCap);
  const est = finite(ctx.budget.estMinutes);
  let clock = cardWorkMinutes(items);
  if (minutesCap != null && est != null && est < minutesCap) clock = Math.max(clock, est);

  const out = items.slice();
  let added = 0;
  const done = new Set<string>();
  for (const fill of fills) {
    if (remaining < 1) break;
    const fillKey = normalizedExerciseKey(String(fill?.exercise ?? ""));
    if (!fillKey || done.has(fillKey) || challenged.has(fillKey)) continue;
    const index = out.findIndex(
      (item) => !isCardio(item) && normalizedExerciseKey(String(item?.exercise ?? "")) === fillKey
    );
    if (index < 0) continue;
    const item = out[index];
    const name = String(item.exercise ?? "");
    const group = canonicalGroup(String(fill.group ?? "")) ?? String(fill.group ?? "").toLowerCase();
    if (!group || ctx.saturatedGroups.has(group) || ctx.excludedGroups.has(group)) continue;
    if (ctx.reducedExercises.has(name.toLowerCase())) continue;
    if (String(item.mode ?? "reps").toLowerCase() === "timed" || item.target_seconds != null) continue;
    if (isPrepPlanItem(item)) continue;
    // Strength-range work never takes the added set (weekly-dose-ledger.ts), whatever
    // an agent's card wrote for it.
    const repLow = finite(item.rep_low);
    if (repLow != null && repLow <= WEEKLY_DOSE_STRENGTH_REP_LOW) continue;
    const candidate = ctx.candidates.get(name.toLowerCase());
    if (candidate?.action === "exclude" || candidate?.top_set) continue;
    const sets = finite(item.sets);
    const planned = finite(fill.sets);
    if (sets == null || planned == null || sets !== planned) continue;
    if (sets + 1 > ctx.budget.itemSetCap) continue;
    if (minutesCap != null && clock + WEEKLY_DOSE_MINUTES_PER_SET > minutesCap) continue;
    // A new object, so the caller's list keeps its own; every other field — the load,
    // the reps, the seconds — is carried over untouched.
    out[index] = { ...item, sets: sets + 1, note: withDoseNote(item.note, doseFillNote(group, ctx.date, name)) };
    remaining -= 1;
    added += 1;
    clock += WEEKLY_DOSE_MINUTES_PER_SET;
    done.add(fillKey);
  }
  if (!added) return { items, changed: false, estAddMin: 0 };
  return { items: out, changed: true, estAddMin: added * WEEKLY_DOSE_MINUTES_PER_SET };
}
