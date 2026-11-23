// The two capacity rows read straight off their own stream's read: strength by MOVEMENT
// (movement-standing.ts) and mobility by its self-checks (mobility-checks.ts). Both only
// re-word what those reads already decided; neither re-derives a direction.
import type {
  WeekReadStandingDirection,
  WeekReadStandingLine,
  WeekReadStandingRow,
} from "../../../contracts/week-read.js";
import { loadWords, sinceWords, dateWords, type AthleteUnits } from "../../../repo/display-words.js";
import {
  MOVEMENT_BETTER_CHANGE,
  MOVEMENT_WORSE_CHANGE,
  type MovementStanding,
} from "../../../repo/movement-standing.js";
import type { MobilityStanding } from "../../../repo/mobility-checks.js";
import { cap, mostCommon, numberWord, standingLine, standingRow } from "./words.js";

const COUNT_GROUPS: ReadonlyArray<[WeekReadStandingDirection, string]> = [
  ["better", "building"],
  ["holding", "holding"],
  ["worse", "slipping"],
];

/**
 * Lines counted by their own directions: "Four movements holding, squat slipping." A group
 * of one names its line when `name` is on; every line in one group reads "All five
 * movements holding" ("Both …" for two). Lines with no direction are in no group.
 */
export function countWords(
  lines: ReadonlyArray<Pick<WeekReadStandingLine, "label" | "direction">>,
  noun: { one: string; many: string },
  opts: { name?: boolean } = {}
): string {
  const directed = lines.filter((l) => l.direction);
  const total = lines.length;
  if (!directed.length) {
    return `${cap(numberWord(total))} ${total === 1 ? noun.one : noun.many} read so far, too soon to call a direction.`;
  }
  const groups = COUNT_GROUPS.map(([dir, word]) => ({ word, members: directed.filter((l) => l.direction === dir) }))
    .filter((g) => g.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length);
  if (groups.length === 1) {
    const g = groups[0];
    const n = g.members.length;
    if (n === 1) return `${opts.name ? g.members[0].label : `One ${noun.one}`} ${g.word}.`;
    if (n === total) return n === 2 ? `Both ${noun.many} ${g.word}.` : `All ${numberWord(n)} ${noun.many} ${g.word}.`;
    return `${cap(numberWord(n))} ${noun.many} ${g.word}.`;
  }
  const parts = groups.map((g) =>
    g.members.length === 1
      ? `${opts.name ? g.members[0].label.toLowerCase() : `one ${noun.one}`} ${g.word}`
      : `${numberWord(g.members.length)} ${noun.many} ${g.word}`
  );
  return `${cap(parts.join(", "))}.`;
}

/**
 * "up since Oct 25", "down since Oct 25", "level since Oct 25"; null when the move is not
 * comparable. A movement's change is a blend of every comparable lift of the pattern (a
 * relative figure, weighted by rank and sets), so no one load measures it honestly: the
 * line says the direction only, on the read's own thresholds — never a percent, which on
 * this surface reads as a grade.
 */
export function relativeMoveWords(change: number | null, since: string | null, today: string): string | null {
  if (change == null || !Number.isFinite(change) || !since) return null;
  const when = sinceWords(since, today);
  if (!when) return null;
  if (change >= MOVEMENT_BETTER_CHANGE) return `up ${when}`;
  if (change <= MOVEMENT_WORSE_CHANGE) return `down ${when}`;
  return `level ${when}`;
}

type MovementLine = MovementStanding["lines"][number];

/**
 * A movement's "now" in words: "245 lb" (a loaded lead's capacity), "bodyweight + 25 lb for 6"
 * (a weighted pull-up), "25 lb of assist for 8", "9 reps". Null when nothing is read.
 */
export function movementNowWords(l: MovementLine, units: AthleteUnits): string | null {
  if (l.now_lb != null) return loadWords(units.weight === "kg" ? l.now_lb : Math.round(l.now_lb), units.weight);
  const added = l.now_added_lb;
  if (added != null && added !== 0 && l.now_added_reps != null) {
    const reps = l.now_added_reps;
    return added > 0
      ? `bodyweight + ${loadWords(added, units.weight)} for ${reps}`
      : `${loadWords(-added, units.weight)} of assist for ${reps}`;
  }
  if (l.now_reps != null) return `${l.now_reps} ${l.now_reps === 1 ? "rep" : "reps"}`;
  return null;
}

/** Strength, one line per movement the athlete trains. Null when no movement is read. */
export function strengthRow(
  ms: MovementStanding | null,
  today: string,
  units: AthleteUnits
): WeekReadStandingRow | null {
  if (!ms?.available) return null;
  const read = (ms.lines ?? []).filter((l) => l.lead_lift && movementNowWords(l, units) != null);
  if (!read.length) return null;
  const lines = read.map((l) =>
    standingLine("capacity", {
      id: `movement:${l.key}`,
      label: l.label,
      now_text: movementNowWords(l, units) as string,
      direction: l.direction,
      move_words: relativeMoveWords(l.change, l.since, today),
      note: `led by ${l.lead_lift}`,
    })
  );
  const since = mostCommon(read.filter((l) => l.direction).map((l) => l.since));
  return standingRow("capacity", {
    key: "strength",
    stone: "strength",
    label: "Strength",
    words: countWords(lines, { one: "movement", many: "movements" }, { name: true }),
    since_words: since ? sinceWords(since, today) || null : null,
    lines,
    invite: null,
    href: "/app/train/program",
  });
}

/** Mobility, one line per self-check. With nothing measured, the row still offers its invite. */
export function mobilityRow(ms: MobilityStanding | null, today: string): WeekReadStandingRow | null {
  if (!ms) return null;
  const checks = ms.checks ?? [];
  if (!checks.length && !ms.invite) return null;
  const lines = checks.map((c) =>
    standingLine("capacity", {
      id: `mobility:${c.id}`,
      label: c.label,
      now_text: c.now_text,
      direction: c.direction,
      move_words: c.move_words,
      note: c.date ? `measured ${dateWords(c.date, today)}` : null,
    })
  );
  const practice =
    ms.practice_days_4wk > 0
      ? ` Mobility work on ${numberWord(ms.practice_days_4wk)} ${ms.practice_days_4wk === 1 ? "day" : "days"} in the last four weeks.`
      : "";
  const words = checks.length ? countWords(lines, { one: "check", many: "checks" }) : "Nothing measured yet.";
  return standingRow("capacity", {
    key: "mobility",
    stone: "recovery",
    label: "Mobility",
    words: `${words}${practice}`,
    since_words: null,
    lines,
    invite: ms.invite ?? null,
    href: null,
  });
}
