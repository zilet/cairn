// The guided recovery menu: a rest/easy Brief must never read as a void (the
// owner's ruling — "rest" must never feel like "do nothing"). This builds a
// short, optional menu of low-key ways to move, grounded in recent training
// load and steered clear of anything currently flagged. A suggestion, never a
// gate: the athlete is never told to do any of it, and resting stays a
// perfectly good answer every single option sits beside.
//
// Deliberately reads only from its own repo module (training-symptoms.ts),
// hybrid-load.ts for the "what's been loaded lately" grounding, and
// reaction-model.ts for the learned recovery bias below — never
// dayread.ts/repo/day-read.ts/repo/coach.ts/repo/signal-state.ts, which other
// tracks are editing in parallel worktrees.
import type { CoachPersonalModifier } from "../brain/coach-context-contract.js";
import { recentMuscleLoad } from "./hybrid-load.js";
import { listTrainingSymptoms } from "./training-symptoms.js";
import { personalResponseModifierFor } from "./reaction-model.js";
import { pickDayVariant } from "./brain/day-read-rules.js";

export interface RecoveryMenuOption {
  label: string;
  detail: string;
  minutes: number | null;
}

export interface RecoveryMenu {
  line: string;
  options: RecoveryMenuOption[];
}

// The grounding sentence: several phrasings of the same idea (VISION.md
// Amendment 2 — a stable input should not print the same literal every day),
// rotated by pickDayVariant so a stable "rest" read doesn't repeat verbatim.
const OPEN_LINES: readonly string[] = [
  "If you feel like moving, any of these counts — none of them is required.",
  "None of this is an assignment; pick one only if you feel like it.",
  "A quiet day can still hold a little movement, but only if you want it.",
  "Take all of it or none of it — resting is just as good an answer today.",
];

// Same idea, worded so it never contradicts a caveat sitting right above it
// about something the athlete is working around.
const GUARDED_LINES: readonly string[] = [
  "If you feel like moving, either of these counts — and resting is just as good.",
  "Only if you feel like it, and only staying comfortable the whole time.",
  "Nothing here is required; keep it easy enough that it never nags.",
];

const SPIN_DETAIL = "Zone 1 pace, 20–30 minutes — nothing that raises your breathing.";
const WALK_DETAIL = "15–20 minutes, just to move.";
const GUARDED_WALK_DETAIL = "10–15 minutes, whatever feels easy.";
const CORE_DETAIL = "10 minutes, nothing heavy.";

function mobilityDetail(words: string | null): string {
  return words ? `10–15 minutes for your ${words}.` : "10–15 minutes for whatever feels tight.";
}

// Steer explicitly around the flagged area, never naming a weight-bearing
// option instead — several phrasings, same reason as OPEN_LINES/GUARDED_LINES.
const GUARDED_MOBILITY_TEMPLATES: readonly ((area: string) => string)[] = [
  (a) => `10–15 minutes, gentle mobility that stays comfortable around the ${a}.`,
  (a) => `10 minutes, easy movement that stays well clear of the ${a}.`,
  (a) => `A short mobility pass, nothing that asks anything of the ${a}.`,
];

// One flat pool of every literal/templated string this module can produce, for
// the grammar-vocabulary test to enumerate wholesale — placeholder words stand
// in for the parts filled from live data (the grammar rules judge SHAPE, not
// the specific muscle/area named, so one concrete example proves the family).
export function recoveryMenuGrammarPool(): string[] {
  return [
    ...OPEN_LINES,
    ...GUARDED_LINES,
    "Easy spin",
    "Short walk",
    "Mobility",
    "Easy core",
    "Gentle mobility",
    SPIN_DETAIL,
    WALK_DETAIL,
    GUARDED_WALK_DETAIL,
    CORE_DETAIL,
    mobilityDetail(null),
    mobilityDetail("hips and hamstrings"),
    ...GUARDED_MOBILITY_TEMPLATES.map((t) => t("knee")),
  ];
}

// The most-loaded recent muscle groups, in plain words ("hips and hamstrings"),
// or null when nothing recent qualifies. Fail-soft: a read query problem never
// blocks the Brief.
function plainMuscleWords(date: string): string | null {
  try {
    const load = recentMuscleLoad(3, date);
    const groups = Array.from(load.values())
      .filter((g) => g.group !== "mobility")
      .sort((a, b) => {
        if (a.heavy !== b.heavy) return a.heavy ? -1 : 1;
        return a.days_ago - b.days_ago;
      })
      .slice(0, 2)
      .map((g) => g.group);
    if (!groups.length) return null;
    return groups.length === 1 ? groups[0] : `${groups[0]} and ${groups[1]}`;
  } catch {
    return null;
  }
}

// The currently flagged area to steer around, or null when nothing is active.
// A legacy-imported row is absence of evidence (see training-symptoms.ts —
// dailyDecisionSnapshot and the movement-relevance reads exclude it the same
// way) and never counts here. Fail-soft: any read problem reads as "nothing
// flagged" rather than blocking the menu.
function flaggedArea(date: string): string | null {
  try {
    const active = listTrainingSymptoms({ on: date, include_resolved: false, seed_legacy: false }).filter(
      (event) => !event.legacy_unconfirmed
    );
    if (!active.length) return null;
    const area = active[0].area_text.trim().toLowerCase();
    return area || null;
  } catch {
    return null;
  }
}

type PoolKey = "spin" | "walk" | "mobility" | "core";

// `gentle` picks the quieter rendering of the SAME option, never a new one: the
// walk collapses to its already-registered shorter wording and the mobility pass
// sits at the bottom of the range its own detail already names. No literal here
// is new, so recoveryMenuGrammarPool() still enumerates everything this module
// can say.
function poolOption(key: PoolKey, date: string, gentle = false): RecoveryMenuOption {
  switch (key) {
    case "spin":
      return { label: "Easy spin", detail: SPIN_DETAIL, minutes: 25 };
    case "walk":
      return gentle
        ? { label: "Short walk", detail: GUARDED_WALK_DETAIL, minutes: 12 }
        : { label: "Short walk", detail: WALK_DETAIL, minutes: 18 };
    case "core":
      return { label: "Easy core", detail: CORE_DETAIL, minutes: 10 };
    case "mobility":
      return { label: "Mobility", detail: mobilityDetail(plainMuscleWords(date)), minutes: gentle ? 10 : 12 };
  }
}

// Which 3-of-4 pool items appear today. pickDayVariant advances by one per
// calendar day, so consecutive days always land on a different combo while a
// fixed date always reads the same.
const COMBOS: readonly PoolKey[][] = [
  ["spin", "walk", "mobility"],
  ["walk", "mobility", "core"],
  ["spin", "mobility", "core"],
  ["spin", "walk", "core"],
];

// A LEARNED bias, not a new signal. `recovery_adjustment` is the personal-response
// target the recovery evidence stream actually earns: reaction-model raises it
// ABOVE 1 — "a slightly larger recovery adjustment is the earned default" — when
// the HRV / resting-HR / sleep deltas that followed recent changes kept coming in
// short of what was expected. This module reads it in exactly ONE direction. Above
// 1 it offers the quieter half of the same menu; at or below 1 nothing changes at
// all, so a scale that ever drifted under 1 could never talk the menu into offering
// MORE than the standard day. That asymmetry is deliberate and mirrors how the
// ease-only bounds elsewhere were drawn: a learned default may add caution, never
// remove it.
//
// Wearable-absence neutrality falls out of the same path rather than being special-
// cased: with no HRV/resting-HR/sleep nights there is no recovery delta to observe,
// so no expectation resolves, so no modifier exists, so the menu is identical to
// the one this module produced before the modifier had any consumer at all.
function gentlerMenuEarned(modifier: CoachPersonalModifier | null | undefined): boolean {
  const scale = modifier?.scale;
  return Number.isFinite(scale) && (scale as number) > 1;
}

// Same day-rotated combo, minus the one option that raises breathing and runs
// longest. Every combo keeps at least two options; the explicit floor is a belt-
// and-braces guard so a future COMBOS edit can never strand the menu at one item.
function gentleKeys(combo: readonly PoolKey[]): PoolKey[] {
  const kept = combo.filter((key) => key !== "spin");
  return kept.length >= 2 ? kept : ["walk", "mobility"];
}

function guardedMobilityOption(date: string, area: string): RecoveryMenuOption {
  const detail = pickDayVariant(GUARDED_MOBILITY_TEMPLATES, date, "recovery_menu_guarded_mobility")(area);
  return { label: "Gentle mobility", detail, minutes: 12 };
}

// null for any kind other than rest/easy — a train/done day never gets this
// menu at all. Never persisted (see attachDayReadContext): derived fresh on
// every response, the same as forward/arc.
// `responseModifier` is injectable for tests; left undefined it is read from the
// learned model fail-soft, because a query problem in the learning layer must never
// cost the athlete their menu.
export function buildRecoveryMenu(
  date: string,
  kind: string,
  opts: { responseModifier?: CoachPersonalModifier | null } = {}
): RecoveryMenu | null {
  if (kind !== "rest" && kind !== "easy") return null;

  const area = flaggedArea(date);
  if (area) {
    // Already the gentlest thing this module builds — two short options steering
    // around the flagged area. A learned recovery bias has nothing left to soften
    // here, so this branch deliberately never reads the modifier.
    return {
      line: pickDayVariant(GUARDED_LINES, date, "recovery_menu_line"),
      options: [{ label: "Short walk", detail: GUARDED_WALK_DETAIL, minutes: 12 }, guardedMobilityOption(date, area)],
    };
  }

  const modifier =
    opts.responseModifier === undefined
      ? (() => {
          try {
            return personalResponseModifierFor("recovery_adjustment");
          } catch {
            return null;
          }
        })()
      : opts.responseModifier;
  const gentle = gentlerMenuEarned(modifier);
  const combo = pickDayVariant(COMBOS, date, "recovery_menu_combo");
  return {
    line: pickDayVariant(OPEN_LINES, date, "recovery_menu_line"),
    options: (gentle ? gentleKeys(combo) : combo).map((key) => poolOption(key, date, gentle)),
  };
}
