import type { DailyDecisionEnvelope } from "./daily-decision.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { violatesReadingGrammar } from "./day-read-grammar.js";
import { canonicalGroup, isMobility, normalizedExerciseKey } from "./exercise-canon.js";
import { findExercise } from "./exercises.js";
import { ANTAGONIST_OF, type AntagonistSide, antagonistSide, movementRegionKey } from "./movement-region.js";
import { finite } from "../lib/numbers.js";
import { isPrepPlanItem, PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "../domain/training/plan-item-order.js";

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
// property of today's card only. The tier is read through the movement region: a leg
// curl files as a hinge in the swap-family table, but on a card it is an accessory, so
// it may sit (and pair) beside the leg extension after the compounds.

function preferRegionItem(a: any, b: any, candidateNames: Set<string>): any {
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

function isCardioItem(item: any): boolean {
  return String(item?.kind ?? "").toLowerCase() === "cardio";
}

// The stored muscle group, canonical, when the exercise is known. A composed item does
// not carry its group, so this is the one lookup the pairing rules make.
function storedGroup(item: any): string | null {
  const stored = findExercise(String(item?.exercise ?? ""));
  const raw = stored?.muscle_group ?? item?.muscle_group;
  if (!raw) return null;
  const group = String(raw).toLowerCase();
  return canonicalGroup(group) ?? group;
}

// Prep work (a band pull-apart, an ankle rocker) is never working volume, so it never
// occupies a region and never pairs.
function isPrepItem(item: any, group: string | null): boolean {
  if (isCardioItem(item)) return false;
  return isPrepPlanItem(item) || isMobility(group);
}

/**
 * One loaded movement per region on a composed card. The weekly plan already refuses
 * a second flat press at write time, but a composed session can still pile two (agent
 * output, or a saturated-group stand-in stealing another day's bench), and nothing ever
 * stopped two pushdowns, two lateral raises or two standing calf raises. The loser is
 * dropped and reported; the keeper prefers today's own template (a candidate), then
 * more sets, then the heavier load. Regions come from `movementRegionKey`, so flat and
 * incline press, a straight- and a bent-knee calf raise, or a squat and a leg press all
 * stay. Identity (the same array back) when nothing collapses.
 *
 * A press-angle collision keeps its historical reason (`duplicate_press_angle`); every
 * other region reports `duplicate_region`.
 */
export function collapseRegionDuplicates(
  items: any[],
  candidateNames: Set<string>
): { items: any[]; rejected: Array<{ exercise: string; reason: string }> } {
  const rejected: Array<{ exercise: string; reason: string }> = [];
  const keep = items.map(() => true);
  const keeper = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isCardioItem(item)) continue;
    const name = String(item?.exercise ?? "");
    const region = movementRegionKey(name);
    if (!region) continue;
    // Only a region-keyed item pays for the group lookup (the prep check needs it).
    if (isPrepItem(item, storedGroup(item))) continue;
    const prev = keeper.get(region);
    if (prev == null) {
      keeper.set(region, i);
      continue;
    }
    const winner = preferRegionItem(items[prev], item, candidateNames) === item ? i : prev;
    const loser = winner === i ? prev : i;
    keep[loser] = false;
    keeper.set(region, winner);
    rejected.push({
      exercise: String(items[loser]?.exercise ?? ""),
      reason: region.startsWith("horizontal-press:") ? "duplicate_press_angle" : "duplicate_region",
    });
  }
  if (!rejected.length) return { items, rejected };
  return { items: items.filter((_, i) => keep[i]), rejected };
}

export interface PairingContext {
  envelope: DailyDecisionEnvelope;
  // The read day — the key every pairing hint rotates on (pickDayVariant).
  date: string;
  // `manual_plan`: the athlete's own snapshotted day. The day they chose is the day
  // they get, in the order they wrote it — nothing is paired or reseated on it.
  planSnapshot: boolean;
}

export interface PairingResult {
  items: any[];
  changed: boolean;
}

// The pairing hint, one per pair, on the pair's first item (the second when the first
// has no room). `{partner}` is the other item's name. Calm, procedural, no numbers — a superset is a way to use the rest, not
// a harder session.
export const PAIRING_NOTES: readonly [string, ...string[]] = [
  "Paired with {partner}: alternate sets, and rest after each round.",
  "Superset with {partner} — one set of each, then rest.",
  "Goes back to back with {partner}; one side rests while the other works.",
  "Alternate with {partner} to save time — each gets a breather while the other works.",
];

// A card prints its note as a per-movement cue only while it stays short (the Today
// card drops a cue past this length), so a hint that would push an existing note over
// it is not added there — it would hide the note it was appended to.
const NOTE_BUDGET = 220;

// A regional isolation lift is an accessory whatever the swap-family table says: a leg
// curl files as a hinge there, which would seat it among the compounds.
const ACCESSORY_REGION = /^(?:knee-extension|knee-flexion|calf:|curl:|triceps:|lateral-raise|rear-delt)/;

// The card's effect tier, read through the movement region. Prep, core and cardio keep
// their own tier; a regional accessory is an isolation lift.
function pairingTier(item: any): number {
  const tier = planItemEffectTier(item);
  if (tier === PLAN_ITEM_EFFECT_TIER.prep || tier >= PLAN_ITEM_EFFECT_TIER.core) return tier;
  const region = movementRegionKey(String(item?.exercise ?? ""));
  if (region && ACCESSORY_REGION.test(region)) return PLAN_ITEM_EFFECT_TIER.isolation;
  return tier;
}

// Heavy strength-range work (a bottom of five reps or fewer) gets its full rest.
const HEAVY_REP_LOW = 5;

interface ItemRead {
  item: any;
  index: number;
  key: string;
  tier: number;
  side: AntagonistSide | null;
  group: string | null;
  gap: boolean;
  // Never paired.
  locked: boolean;
  // Never moved by the gap-first reorder (the anchor, a top set and its block, warm-ups,
  // an existing grouping).
  fixed: boolean;
  // A top-set card is glued to the block right after it.
  topSet: boolean;
}

function hasTopSetShape(item: any): boolean {
  return Boolean(item?.reach || item?.top_set_of || item?.top_set);
}

function gapGroups(envelope: DailyDecisionEnvelope): Set<string> {
  const gaps = Array.isArray(envelope?.dose?.gaps) ? envelope.dose.gaps : [];
  const out = new Set<string>();
  for (const gap of gaps) {
    if (!gap || !(Number(gap.short) > 0)) continue;
    const group = String(gap.group ?? "").toLowerCase();
    if (group) out.add(canonicalGroup(group) ?? group);
  }
  return out;
}

function readItems(items: any[], envelope: DailyDecisionEnvelope): ItemRead[] {
  const gaps = gapGroups(envelope);
  const keyCounts = new Map<string, number>();
  for (const item of items) {
    const key = normalizedExerciseKey(String(item?.exercise ?? ""));
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const reads: ItemRead[] = items.map((item, index) => {
    const cardio = isCardioItem(item);
    const key = normalizedExerciseKey(String(item?.exercise ?? ""));
    const group = cardio ? null : storedGroup(item);
    const tier = cardio
      ? PLAN_ITEM_EFFECT_TIER.cardio
      : isPrepItem(item, group)
        ? PLAN_ITEM_EFFECT_TIER.prep
        : pairingTier(item);
    const existingGroup = item?.superset_group != null;
    const warmups = (finite(item?.warmup_sets) ?? 0) > 0;
    const topSet = hasTopSetShape(item);
    const locked =
      cardio ||
      tier === PLAN_ITEM_EFFECT_TIER.prep ||
      String(item?.mode ?? "").toLowerCase() === "timed" ||
      warmups ||
      topSet ||
      existingGroup ||
      // The same lift twice on a card is a top set or a back-off block, never a partner.
      (keyCounts.get(key) ?? 0) > 1;
    return {
      item,
      index,
      key,
      tier,
      side: cardio ? null : antagonistSide(String(item?.exercise ?? "")),
      group,
      gap: group != null && gaps.has(group),
      locked,
      fixed: warmups || topSet || existingGroup || (keyCounts.get(key) ?? 0) > 1,
      topSet,
    };
  });
  // The day's anchor: its first primary. Heavy strength-range work (or reps nobody
  // named) gets its full rest; a moderate-rep first press can still take a partner.
  // Either way the anchor keeps its seat at the head of the compounds.
  const anchor = reads.find((read) => read.tier === PLAN_ITEM_EFFECT_TIER.primary);
  if (anchor) {
    anchor.fixed = true;
    const repLow = finite(anchor.item?.rep_low);
    if (repLow == null || repLow <= HEAVY_REP_LOW) anchor.locked = true;
  }
  for (const read of reads) {
    const repLow = finite(read.item?.rep_low);
    if (repLow != null && repLow <= HEAVY_REP_LOW) read.locked = true;
  }
  return reads;
}

interface Unit {
  reads: ItemRead[];
  fixed: boolean;
  gap: boolean;
  pair: [ItemRead, ItemRead] | null;
}

// One effect tier's units: pairs seated together at the first member's seat, a top set
// glued to its block, everything else alone.
function tierUnits(segment: ItemRead[]): Unit[] {
  const partnerOf = new Map<ItemRead, ItemRead>();
  for (let i = 0; i < segment.length; i++) {
    const a = segment[i];
    if (a.locked || !a.side || partnerOf.has(a)) continue;
    const wanted = ANTAGONIST_OF[a.side];
    for (let j = i + 1; j < segment.length; j++) {
      const b = segment[j];
      if (b.locked || partnerOf.has(b) || b.side !== wanted) continue;
      partnerOf.set(a, b);
      partnerOf.set(b, a);
      break;
    }
  }
  const units: Unit[] = [];
  const seated = new Set<ItemRead>();
  for (let i = 0; i < segment.length; i++) {
    const read = segment[i];
    if (seated.has(read)) continue;
    const partner = partnerOf.get(read);
    if (partner) {
      // The group the week is behind on leads its pair while it is fresh — unless the
      // pair holds the day's anchor, which keeps its seat and its lead.
      const anchored = read.fixed || partner.fixed;
      const [lead, follow] = !anchored && partner.gap && !read.gap ? [partner, read] : [read, partner];
      seated.add(read);
      seated.add(partner);
      units.push({
        reads: [lead, follow],
        fixed: anchored,
        gap: read.gap || partner.gap,
        pair: [lead, follow],
      });
      continue;
    }
    const next = segment[i + 1];
    if (read.topSet && next && !seated.has(next) && next.key === read.key) {
      seated.add(read);
      seated.add(next);
      units.push({ reads: [read, next], fixed: true, gap: read.gap, pair: null });
      continue;
    }
    seated.add(read);
    units.push({ reads: [read], fixed: read.fixed, gap: read.gap, pair: null });
  }
  return units;
}

// Behind-for-the-week groups first within the tier; fixed units keep their seat.
function gapFirst(units: Unit[]): Unit[] {
  const movable = units.filter((unit) => !unit.fixed);
  if (!movable.some((unit) => unit.gap) || movable.every((unit) => unit.gap)) return units;
  const ordered = [...movable.filter((unit) => unit.gap), ...movable.filter((unit) => !unit.gap)];
  let next = 0;
  const result = units.map((unit) => (unit.fixed ? unit : ordered[next++]));
  return result.every((unit, index) => unit === units[index]) ? units : result;
}

function pairingNote(self: any, partner: any, date: string): string | null {
  const keys = [
    normalizedExerciseKey(String(self?.exercise ?? "")),
    normalizedExerciseKey(String(partner?.exercise ?? "")),
  ]
    .sort()
    .join("+");
  const template = pickDayVariant(PAIRING_NOTES, date, `composition:pair:${keys}`);
  const text = template.replace("{partner}", String(partner?.exercise ?? "").trim());
  return violatesReadingGrammar(text) ? null : text;
}

// The hint rides after whatever the card already says; the existing note is never cut
// to make room — the hint is what yields. Null when it does not fit.
function withPairingNote(existing: unknown, text: string): string | null {
  const current = String(existing ?? "").trim();
  if (!current) return text.length > NOTE_BUDGET ? null : text;
  if (current.toLowerCase().includes(text.toLowerCase())) return current;
  const joined = `${/[.!?]$/.test(current) ? current : `${current}.`} ${text}`;
  return joined.length > NOTE_BUDGET ? null : joined;
}

// One hint per pair: on the first item, naming the second; when the first item's note
// has no room, on the second, naming the first; otherwise none (the group still says it).
function placePairingNote(lead: any, follow: any, date: string): void {
  for (const [self, partner] of [
    [lead, follow],
    [follow, lead],
  ]) {
    const text = pairingNote(self, partner, date);
    if (!text) continue;
    const note = withPairingNote(self.note, text);
    if (note == null) continue;
    self.note = note;
    return;
  }
}

/**
 * Seat antagonist pairs as supersets on today's card. Runs on the FINAL list, after
 * `orderPlanItemsForEffect`; when `changed` is true the caller re-numbers positions.
 *
 * - Pairs: horizontal push with horizontal pull, vertical push with vertical pull, a
 *   curl with a triceps extension, a knee extension with a knee flexion — inside one
 *   effect tier only (read through the movement region, so a leg curl is an accessory
 *   beside the leg extension, not a hinge beside the deadlift).
 * - Never paired: prep, timed work, anything carrying warm-up sets, a top set or reach
 *   and the block it leads, the same lift twice, heavy strength-range work, an item an
 *   author already grouped (its grouping stands), and the day's first primary when it
 *   is heavy.
 * - A group the week is behind on (`envelope.dose.gaps`, short > 0) goes first within
 *   its tier, and leads its pair. Today's card only; the plan's order is untouched.
 * - Each new pair takes the lowest `superset_group` not already on the card, and its
 *   first item one calm hint in `note`.
 *
 * Identity (the same array, `changed: false`) on a plan snapshot, and whenever nothing
 * pairs and no behind group moves.
 */
export function pairForSession(items: any[], ctx: PairingContext): PairingResult {
  if (ctx.planSnapshot || !Array.isArray(items) || items.length < 2) return { items, changed: false };
  const reads = readItems(items, ctx.envelope);
  // Stable by tier: the card is already in effect order, except where the swap-family
  // table misfiles a regional accessory among the compounds.
  const sorted = [...reads].sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.index - b.index));
  const units: Unit[] = [];
  let reseated = false;
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end < sorted.length && sorted[end].tier === sorted[start].tier) end++;
    const segment = sorted.slice(start, end);
    const tier = segment[0].tier;
    if (tier === PLAN_ITEM_EFFECT_TIER.prep || tier === PLAN_ITEM_EFFECT_TIER.cardio) {
      for (const read of segment) units.push({ reads: [read], fixed: true, gap: false, pair: null });
    } else {
      const seated = tierUnits(segment);
      const ordered = gapFirst(seated);
      if (ordered !== seated) reseated = true;
      units.push(...ordered);
    }
    start = end;
  }
  const pairs = units.filter((unit) => unit.pair).map((unit) => unit.pair as [ItemRead, ItemRead]);
  // With nothing paired and no behind group reseated, the card stands exactly as it
  // came: the tier sort above is how pairs are found, not a change of its own.
  if (!pairs.length && !reseated) return { items, changed: false };
  const next = units.flatMap((unit) => unit.reads.map((read) => read.item));
  const used = new Set<number>(
    items.map((item) => finite(item?.superset_group)).filter((value): value is number => value != null)
  );
  let groupId = 1;
  for (const [lead, follow] of pairs) {
    while (used.has(groupId)) groupId++;
    used.add(groupId);
    lead.item.superset_group = groupId;
    follow.item.superset_group = groupId;
    placePairingNote(lead.item, follow.item, ctx.date);
  }
  return { items: next, changed: true };
}
