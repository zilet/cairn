// Saturated-group substitution — the composition default on a day the athlete's
// own endurance work already did the lower-body session.
//
// The deterministic envelope (`daily-decision.ts`) has always said two things on
// such a morning: which groups are SATURATED (the shared `acuteGate`, plus the
// lower-body groups `endurance_lower_conflict` marks after recent heavy cardio),
// and which groups are ALLOWED. Composition only ever read the first half — a
// saturated item was held and lightened, so a leg day picked on a run morning
// still served legs, merely lighter. The athlete's read of that was exact:
// "there should be no leg exercises today when I had a run session."
//
// So when a PLAN-SOURCED composition's items sit on saturated groups and the
// envelope names allowed groups, each such item is REPLACED by a movement the
// athlete already programmed for an allowed group — carrying that movement's own
// logged working weight or its own plan target, never an invented load — and the
// card says why in the athlete's own words.
//
// This is a composition DEFAULT, never a block (VISION §2.1: the wheel is always
// theirs). The athlete can still ask chat for any lift they want, and the day
// they picked is still the day they get — it is the slots inside it that move.
//
// Deliberately thin on policy: it decides nothing about safety. Saturation and
// the allowed set are both read straight off the envelope, the substitute pool is
// the athlete's own weekly template, and every item it hands back still passes
// through `normalizeComposedSession`'s exclusion, equipment and cap gates.
import { pickDayVariant } from "./brain/day-read-rules.js";
import type { DailyDecisionEnvelope } from "./daily-decision.js";
import {
  bodyRegion,
  canonicalGroup,
  ISOLATION_GROUPS,
  type MuscleGroup,
  normalizedExerciseKey,
  plainGroupWords,
} from "./exercise-canon.js";
import { equipmentCompatibility, inferExerciseEquipment, parseEquipmentCapability } from "./equipment-capability.js";
import { findExercise, recentWorkingSeconds, recentWorkingWeight } from "./exercises.js";
import { type AcuteGateReading, acuteGates, RUN_PRIME_GROUPS } from "./hybrid-load.js";
import { getPlan } from "./plan.js";
import { occupiedPressSlots, pressSlotKey } from "./plan-quality.js";
import { finite } from "../lib/numbers.js";

// Athlete-facing, and rotated like every other read sentence in Cairn: a stable
// input fires the same rule every morning, so one literal would print verbatim
// for as long as the athlete keeps running on lifting days (CLAUDE.md, "day-read
// prose is a variant set"). `{area}` is filled with the substitute's own group in
// plain words — never a column value, never a score.
export const ENDURANCE_SUBSTITUTION_REASONS: readonly [string, ...string[]] = [
  "Legs already did the work this morning — this slot goes to {area} instead.",
  "The run covered the lower body, so {area} takes this slot today.",
  "Your legs had their session outside. This one moves to {area}.",
  "Running already loaded this area, so the slot goes to {area} while it comes back.",
  "The lower body is still working through the run — {area} gets this slot instead.",
];

export const SATURATED_SUBSTITUTION_REASONS: readonly [string, ...string[]] = [
  "This area is still carrying recent work, so the slot goes to {area} instead.",
  "Swapped to {area} — what this slot usually trains hasn't come back yet.",
  "Giving this area the rest it's still using; {area} takes the slot today.",
  "{area} is the fresher choice today, so it stands in here.",
  "This one waits while the area recovers — {area} picks up the slot.",
];

// The session's own `why` when at least one slot moved. Replaces the plan-pick
// phrasing ("Switched by you, not the usual order.") only on a day that actually
// substituted: naming a cause that did not happen would be its own kind of lie.
export const ENDURANCE_SUBSTITUTED_SESSION_WHY: readonly [string, ...string[]] = [
  "Your run shaped this one: the leg work waits, and the rest of the body takes the session.",
  "This morning's running already loaded the legs, so today's lifting leans on what's fresh.",
  "The legs had their session outside. What's left here works the parts that are ready.",
  "Running covered the lower body today, so the session moves above the waist.",
];

export const SATURATED_SUBSTITUTED_SESSION_WHY: readonly [string, ...string[]] = [
  "Some areas are still carrying recent work, so today's session leans on what's fresh.",
  "Today's lifting moves toward the parts that have had a break.",
  "What you trained recently sits this one out, and the fresher work takes its place.",
  "The session shifts to the areas that are ready today.",
];

// Said once, on the session, when a saturated slot had nowhere to go: the
// athlete's own week holds nothing for an allowed group, so the old behaviour
// (hold the load, lighten the day) stands and says so.
export const SUBSTITUTION_UNAVAILABLE_NOTES: readonly [string, ...string[]] = [
  "Nothing else in your week fits the fresher areas today, so this work stays in — kept light.",
  "Your plan has no movement for the areas that are ready, so these stay on the card, lighter than usual.",
  "There was nowhere fresher to send this work in your own week, so it stays and stays easy.",
  "No other day of your plan covers what's fresh today, so this work holds — lightly.",
];

export interface SaturatedSubstitution {
  /** The template movement this slot used to hold. */
  replaced: string;
  /** The athlete's own movement standing in for it. */
  exercise: string;
  muscle_group: MuscleGroup;
  /** The athlete-facing sentence, already rotated for this date. */
  reason: string;
  /**
   * Where the stand-in's load came from: `"logged"` when it carries the movement's
   * own recent WORKING weight/seconds — proven, so a hold day may exempt it from
   * the hold clamp — or `"plan_target"` when nothing has been logged and it fell
   * back to the athlete's plan prescription, a number nobody has proven yet and
   * which must still go through the normal hold clamp like any other item.
   */
  load_basis: "logged" | "plan_target";
}

export interface SaturatedSubstitutionOutcome {
  /** The payload to compose from. Identity (the same object) when nothing moved. */
  raw: unknown;
  substitutions: SaturatedSubstitution[];
  /** Saturated movements that stayed because the plan held no allowed-group stand-in. */
  unresolved: string[];
  /** The replacement session `why`, or null when nothing moved. */
  why: string | null;
  /** The one-line session note for `unresolved`, or null when everything resolved. */
  unresolved_note: string | null;
}

const NONE: Omit<SaturatedSubstitutionOutcome, "raw"> = {
  substitutions: [],
  unresolved: [],
  why: null,
  unresolved_note: null,
};

interface PoolEntry {
  exercise: string;
  group: MuscleGroup;
  due: boolean;
  allowed_index: number;
  day_number: number;
  position: number;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
  warmup_sets: number | null;
  mode: "reps" | "timed";
  note: string | null;
}

function groupList(raw: unknown): MuscleGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: MuscleGroup[] = [];
  for (const entry of raw) {
    const group = canonicalGroup(entry == null ? null : String(entry));
    if (group && group !== "mobility" && !out.includes(group)) out.push(group);
  }
  return out;
}

function isCardio(item: unknown): boolean {
  return String((item as { kind?: unknown })?.kind ?? "").toLowerCase() === "cardio";
}

// The group a composed item loads. The canonical catalog is authoritative — a
// composed item has already lost its plan row's `muscle_group` column by the time
// it reaches here — and an unknown movement resolves to nothing rather than to a
// guess, because a guess would move work the envelope never flagged.
function itemGroup(item: unknown): MuscleGroup | null {
  if (isCardio(item)) return null;
  const name = String((item as { exercise?: unknown })?.exercise ?? "").trim();
  if (!name) return null;
  const stored = findExercise(name);
  return canonicalGroup(stored?.muscle_group ?? (item as { muscle_group?: unknown })?.muscle_group ?? null);
}

function enduranceConflictFired(envelope: DailyDecisionEnvelope): boolean {
  if (Array.isArray(envelope.precedence) && envelope.precedence.includes("endurance_lower_conflict")) return true;
  return (
    Array.isArray(envelope.soft_preferences) &&
    envelope.soft_preferences.some((entry) => entry?.code === "endurance_lower_conflict")
  );
}

/**
 * The groups whose work moves today. Two sources, both the envelope's own:
 *  - `muscles.saturated` — the shared acuteGate's answer to "is this muscle still
 *    recovering", whatever put the work there.
 *  - the lower-body half of `muscles.reduced` when `endurance_lower_conflict`
 *    fired — recent heavy cardio marks the legs REDUCED rather than saturated, and
 *    a run morning is exactly the case this whole module exists for.
 *
 * Deliberately not scoped to `endurance_lower_conflict` mornings: `muscles.saturated`
 * is read whatever put the work there, so a group loaded by yesterday's LIFTING
 * (no run in sight) substitutes exactly the same as one loaded by this morning's
 * run. `acuteGate` (`hybrid-load.ts`) is the one "is this muscle recovering"
 * question in Cairn — it does not ask what loaded the muscle, so neither does
 * this law. Ruling, not an oversight.
 */
function substitutionGroups(
  envelope: DailyDecisionEnvelope,
  gates: Map<MuscleGroup, AcuteGateReading>
): Set<MuscleGroup> {
  // A group the gate reads saturated but NOT deep, from work on an EARLIER day, is only
  // just over its own bar: its slot stays on the card and holds load (the envelope's
  // `muscle_saturated` hold) rather than moving to another area. Moving it emptied a
  // lower day of every lower lift on the ordinary hybrid morning after a weekend of
  // running. Work done TODAY still moves whatever its depth — the run-morning law.
  // The week's last lower day, still without a full leg session, holds its leg slots
  // even over a DEEP earlier-day residual (`muscles.week_held`, the weekly lower
  // guarantee): moving them would leave the week with no leg session at all.
  const weekHeld = new Set<MuscleGroup>(groupList(envelope.muscles?.week_held));
  const holdsInPlace = (group: MuscleGroup) => {
    const gate = gates.get(group);
    if (gate?.saturated !== true || (gate.days_ago ?? 0) < 1) return false;
    return !gate.deep || weekHeld.has(group);
  };
  const groups = new Set<MuscleGroup>(groupList(envelope.muscles?.saturated).filter((g) => !holdsInPlace(g)));
  if (enduranceConflictFired(envelope)) {
    for (const group of groupList(envelope.muscles?.reduced)) {
      if ((RUN_PRIME_GROUPS as readonly string[]).includes(group) && !holdsInPlace(group)) groups.add(group);
    }
  }
  return groups;
}

function rankBefore(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function planItemMode(item: any, stored: any): "reps" | "timed" {
  return (stored?.mode ?? item?.mode) === "timed" ? "timed" : "reps";
}

function joinNote(reason: string, existing: unknown): string {
  const tail = String(existing ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!tail) return reason;
  if (tail.toLowerCase().includes(reason.toLowerCase())) return tail;
  return `${reason} ${tail}`.slice(0, 500);
}

/**
 * Replace saturated-group items in a plan-sourced payload with the athlete's own
 * allowed-group work. Returns the payload untouched (identity) whenever the law
 * does not apply, so an ordinary morning composes byte-for-byte as it always has.
 */
export function substituteSaturatedPlanItems(
  raw: unknown,
  envelope: DailyDecisionEnvelope
): SaturatedSubstitutionOutcome {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw, ...NONE };
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items) || !items.length) return { raw, ...NONE };

  const allowed = groupList(envelope.muscles?.allowed);
  if (!allowed.length) return { raw, ...NONE };
  // "Allowed" is not "fresh": a group in the gate's LOADED band is still carrying
  // work — the same correction the day picker makes. Such a stand-in is a last
  // resort, which is what keeps a bench press off the Pull card the morning after Push.
  let gates: Map<MuscleGroup, AcuteGateReading>;
  try {
    gates = acuteGates(envelope.date);
  } catch {
    gates = new Map();
  }
  const saturated = substitutionGroups(envelope, gates);
  if (!saturated.size) return { raw, ...NONE };
  // An allowed group is never also a group we are moving work away from. The
  // envelope already guarantees this (`allowed` subtracts `reduced`, which
  // contains `saturated`); belt and braces, because the whole point is that the
  // stand-in is fresh.
  const allowedFresh = allowed.filter((group) => !saturated.has(group));
  if (!allowedFresh.length) return { raw, ...NONE };

  const targets: Array<{ index: number; exercise: string; group: MuscleGroup }> = [];
  items.forEach((item, index) => {
    const group = itemGroup(item);
    if (!group || !saturated.has(group)) return;
    const exercise = String((item as { exercise?: unknown }).exercise ?? "").trim();
    if (!exercise) return;
    targets.push({ index, exercise, group });
  });
  if (!targets.length) return { raw, ...NONE };

  const excluded = new Set(groupList(envelope.muscles?.excluded));
  // `allowed` is built as dedupe([...required, ...due]) — required first — so a
  // group in it that today's template does NOT already require is the volume
  // signal: an area the week has under-trained. Those lead the pool.
  const required = new Set(groupList(envelope.muscles?.required));
  const equipment = parseEquipmentCapability(envelope.request?.equipment);
  const present = new Set<string>();
  for (const item of items) {
    const key = normalizedExerciseKey(String((item as { exercise?: unknown })?.exercise ?? ""));
    if (key) present.add(key);
  }

  // Every programmed day is fair game, including the one the envelope points at:
  // a manual pick composes day 4 against an envelope whose template is day 2, so
  // excluding "today's" day would throw away exactly the stand-ins the athlete
  // most obviously programmed for themselves. What must not repeat is an exercise
  // already on this card, and `present` is what guarantees that.
  const pool: PoolEntry[] = [];
  const seen = new Set<string>();
  let plan: any[] = [];
  try {
    plan = getPlan() as any[];
  } catch {
    plan = [];
  }
  for (const day of plan) {
    const dayNumber = Number(day?.day_number);
    if (!Number.isFinite(dayNumber)) continue;
    if (String(day?.day_type ?? "training").toLowerCase() === "rest") continue;
    const dayItems = Array.isArray(day?.items) ? day.items : [];
    for (let position = 0; position < dayItems.length; position++) {
      const item = dayItems[position];
      if (isCardio(item)) continue;
      const exercise = String(item?.exercise ?? "").trim();
      if (!exercise) continue;
      const key = normalizedExerciseKey(exercise);
      if (!key || present.has(key) || seen.has(key)) continue;
      const stored = findExercise(exercise);
      const group = canonicalGroup(stored?.muscle_group ?? item?.muscle_group ?? null);
      if (!group || excluded.has(group) || saturated.has(group)) continue;
      const allowedIndex = allowedFresh.indexOf(group);
      if (allowedIndex < 0) continue;
      if (
        equipment.recognized &&
        equipment.restricted &&
        equipmentCompatibility(equipment, inferExerciseEquipment(exercise, stored?.equipment)) !== "compatible"
      ) {
        continue;
      }
      seen.add(key);
      const mode = planItemMode(item, stored);
      pool.push({
        exercise,
        group,
        due: !required.has(group),
        allowed_index: allowedIndex,
        day_number: dayNumber,
        position,
        sets: finite(item?.sets),
        rep_low: mode === "timed" ? null : finite(item?.rep_low),
        rep_high: mode === "timed" ? null : finite(item?.rep_high),
        target_weight: mode === "timed" ? null : finite(item?.target_weight),
        target_seconds: mode === "timed" ? finite(item?.target_seconds) : null,
        warmup_sets: finite(item?.warmup_sets),
        mode,
        note: item?.note == null ? null : String(item.note),
      });
    }
  }
  if (!pool.length) {
    return {
      raw,
      substitutions: [],
      unresolved: targets.map((target) => target.exercise),
      why: null,
      unresolved_note: pickDayVariant(
        SUBSTITUTION_UNAVAILABLE_NOTES,
        envelope.date,
        "saturated-substitution:unavailable"
      ),
    };
  }

  // Deterministic: under-trained groups first, then the envelope's own allowed
  // order, then the athlete's own week in order. Same DB state, same session.
  pool.sort(
    (a, b) =>
      Number(b.due) - Number(a.due) ||
      a.allowed_index - b.allowed_index ||
      a.day_number - b.day_number ||
      a.position - b.position ||
      a.exercise.localeCompare(b.exercise)
  );

  const stillCarrying = (group: MuscleGroup): boolean => (gates.get(group)?.band ?? "fresh") !== "fresh";

  const usedGroups = new Set<MuscleGroup>();
  const usedExercises = new Set<string>();
  const occupiedPresses = occupiedPressSlots(
    items.map((item) => String((item as { exercise?: unknown })?.exercise ?? ""))
  );
  const takeEntry = (targetGroup: MuscleGroup): PoolEntry | null => {
    const usable = (entry: PoolEntry) => {
      if (usedExercises.has(entry.exercise)) return false;
      const slot = pressSlotKey(entry.exercise);
      return !(slot && occupiedPresses.has(slot));
    };
    // The stand-in fills the slot it replaces: fresh work first, then the same body
    // region, then the same role (isolation for isolation, compound for compound).
    // Without it a triceps extension became a back squat. Once every fresh group
    // has one stand-in on the card, a second slot may return to a group already
    // used — the day is still the athlete's own work, just re-pointed. Volume
    // stays bounded by the envelope's caps downstream. A same-angle press already
    // on the card is never that second slot: two flat benches is piling, not
    // complementary work.
    const rank = (entry: PoolEntry): number[] => [
      Number(stillCarrying(entry.group)),
      Number(bodyRegion(entry.group) !== bodyRegion(targetGroup)),
      Number(ISOLATION_GROUPS.has(entry.group) !== ISOLATION_GROUPS.has(targetGroup)),
      Number(usedGroups.has(entry.group)),
    ];
    // First best by rank; ties keep the pool's own deterministic order.
    let entry: PoolEntry | null = null;
    let best: number[] = [];
    for (const candidate of pool) {
      if (!usable(candidate)) continue;
      const r = rank(candidate);
      if (!entry || rankBefore(r, best)) {
        entry = candidate;
        best = r;
      }
    }
    if (!entry) return null;
    usedExercises.add(entry.exercise);
    usedGroups.add(entry.group);
    const slot = pressSlotKey(entry.exercise);
    if (slot) occupiedPresses.add(slot);
    return entry;
  };

  const endurance = enduranceConflictFired(envelope);
  const nextItems = [...items];
  const substitutions: SaturatedSubstitution[] = [];
  const unresolved: string[] = [];
  let enduranceCause = false;
  for (const target of targets) {
    const entry = takeEntry(target.group);
    if (!entry) {
      unresolved.push(target.exercise);
      continue;
    }
    const fromRun = endurance && (RUN_PRIME_GROUPS as readonly string[]).includes(target.group);
    if (fromRun) enduranceCause = true;
    const reason = pickDayVariant(
      fromRun ? ENDURANCE_SUBSTITUTION_REASONS : SATURATED_SUBSTITUTION_REASONS,
      envelope.date,
      `saturated-substitution:${normalizedExerciseKey(target.exercise)}`
    ).replace("{area}", plainGroupWords([entry.group]) ?? entry.group);
    const original = items[target.index] as Record<string, unknown>;
    // The load is the SUBSTITUTE's own: what it was last worked at, or what the
    // athlete's own plan prescribes for it. Never the replaced movement's target,
    // and never a number this module made up. `recentWorkingWeight` already
    // carries the assist sign (negative = assisted), and the plan target carries
    // whatever sign the athlete stored — so neither path can flip an assisted
    // lift into a loaded one.
    const loggedWeight = entry.mode === "timed" ? null : recentWorkingWeight(entry.exercise);
    const loggedSeconds = entry.mode === "timed" ? recentWorkingSeconds(entry.exercise) : null;
    const weight = entry.mode === "timed" ? null : (loggedWeight ?? entry.target_weight);
    const seconds = entry.mode === "timed" ? (loggedSeconds ?? entry.target_seconds) : null;
    // Only a LOGGED number is proven. A plan-target fallback is a number this
    // module read off the athlete's own prescription for a movement they have
    // never worked, which is exactly what the hold clamp exists to catch.
    const loadBasis: SaturatedSubstitution["load_basis"] =
      (entry.mode === "timed" ? loggedSeconds : loggedWeight) != null ? "logged" : "plan_target";
    nextItems[target.index] = {
      kind: "strength",
      exercise: entry.exercise,
      sets: entry.sets ?? finite(original?.sets) ?? 3,
      rep_low: entry.rep_low,
      rep_high: entry.rep_high,
      target_weight: weight,
      target_seconds: seconds,
      mode: entry.mode,
      warmup_sets: entry.warmup_sets,
      note: joinNote(reason, entry.note),
      substitution_for: target.exercise,
      brain_change_reason: reason,
    };
    substitutions.push({
      replaced: target.exercise,
      exercise: entry.exercise,
      muscle_group: entry.group,
      reason,
      load_basis: loadBasis,
    });
  }

  if (!substitutions.length) {
    return {
      raw,
      substitutions: [],
      unresolved,
      why: null,
      unresolved_note: unresolved.length
        ? pickDayVariant(SUBSTITUTION_UNAVAILABLE_NOTES, envelope.date, "saturated-substitution:unavailable")
        : null,
    };
  }

  return {
    raw: { ...(raw as Record<string, unknown>), items: nextItems },
    substitutions,
    unresolved,
    why: pickDayVariant(
      enduranceCause ? ENDURANCE_SUBSTITUTED_SESSION_WHY : SATURATED_SUBSTITUTED_SESSION_WHY,
      envelope.date,
      "saturated-substitution:why"
    ),
    unresolved_note: unresolved.length
      ? pickDayVariant(SUBSTITUTION_UNAVAILABLE_NOTES, envelope.date, "saturated-substitution:unavailable")
      : null,
  };
}
