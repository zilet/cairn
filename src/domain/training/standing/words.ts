// The standing read's shared wording: ONE direction vocabulary, the count words, and the
// small date and number phrasings every area builder speaks with. A direction is never a
// grade: it says which way an area moved over its own window, and `better` always means
// better FOR THE ATHLETE (a lower resting heart rate, a quicker race estimate).
import type {
  WeekReadStandingDirection,
  WeekReadStandingLine,
  WeekReadStandingRow,
} from "../../../contracts/week-read.js";
import { daysBetweenISO } from "../../../lib/dates.js";
import { dateWords } from "../../../repo/display-words.js";

/** Which register a row speaks in: what you can DO (capacity) or how a reading sits (health). */
export type StandingRegister = "capacity" | "health";

/**
 * THE vocabulary table. Capacity rows (strength, endurance, mobility) build, hold or slip;
 * health rows (body, blood, pressure, recovery) improve, hold steady or drift. Nothing
 * else names a direction.
 */
export const STANDING_DIRECTION_WORDS: Record<StandingRegister, Record<WeekReadStandingDirection, string>> = {
  capacity: { better: "Building", holding: "Holding", worse: "Slipping" },
  health: { better: "Improving", holding: "Steady", worse: "Drifting" },
};

export function directionWords(register: StandingRegister, d: WeekReadStandingDirection | null): string | null {
  return d ? STANDING_DIRECTION_WORDS[register][d] : null;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "four" for 4, "12" past ten. */
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "a and b", "a, b and c". */
export function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one way lines add up to a row's direction: the most common direction wins; a tie
 * between better and worse reads as holding; a tie between holding and a move reads as
 * the move (a change beside level lines is the news). Null when no line calls one.
 */
export function combineDirections(
  dirs: ReadonlyArray<WeekReadStandingDirection | null>
): WeekReadStandingDirection | null {
  const n = { better: 0, holding: 0, worse: 0 };
  for (const d of dirs) if (d) n[d]++;
  if (!n.better && !n.holding && !n.worse) return null;
  const top = Math.max(n.better, n.holding, n.worse);
  const leaders = (["better", "worse", "holding"] as const).filter((d) => n[d] === top);
  if (leaders.length === 1) return leaders[0];
  if (leaders.includes("better") && leaders.includes("worse")) return "holding";
  return leaders.find((d) => d !== "holding") ?? "holding";
}

/** "43 s", "1 min 12 s", "2 min". */
export function secondsWords(sec: number): string {
  const s = Math.round(Math.abs(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** "7 h 10 min", "45 min". */
export function sleepWords(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** A dated reading's age: "drawn this week", "drawn three weeks ago", "drawn in June", "drawn Jun 3, 2025". */
export function ageWords(verb: string, iso: string, today: string): string {
  const days = daysBetweenISO(today, iso);
  if (days == null || days < 0) return `${verb} ${dateWords(iso, today)}`;
  if (days < 7) return `${verb} this week`;
  const weeks = Math.round(days / 7);
  if (weeks <= 8) return `${verb} ${numberWord(weeks)} ${weeks === 1 ? "week" : "weeks"} ago`;
  const months = Math.round(days / 30.4);
  if (months <= 11) return `${verb} ${numberWord(months)} months ago`;
  return `${verb} ${dateWords(iso, today)}`;
}

/** "Dec 22–26", "Dec 30 – Jan 3", "Dec 22". */
export function compactRangeWords(start: string, end: string | null, today: string): string {
  const a = dateWords(start, today);
  if (!end || end <= start) return a;
  const b = dateWords(end, today);
  const [am, ad] = a.split(" ");
  const [bm, bd] = b.split(" ");
  if (am === bm && ad && bd && !a.includes(",") && !b.includes(",")) return `${am} ${ad}–${bd}`;
  return `${a} – ${b}`;
}

/** A line with the register's direction words filled from its direction. */
export function standingLine(
  register: StandingRegister,
  line: Omit<WeekReadStandingLine, "direction_words">
): WeekReadStandingLine {
  return { ...line, direction_words: directionWords(register, line.direction) };
}

/** A row with its direction and direction words read from its lines (unless one is given). */
export function standingRow(
  register: StandingRegister,
  row: Omit<WeekReadStandingRow, "direction" | "direction_words"> & { direction?: WeekReadStandingDirection | null }
): WeekReadStandingRow {
  const direction = row.direction !== undefined ? row.direction : combineDirections(row.lines.map((l) => l.direction));
  return {
    key: row.key,
    stone: row.stone,
    label: row.label,
    direction,
    direction_words: directionWords(register, direction),
    words: row.words,
    since_words: direction ? row.since_words : null,
    lines: row.lines,
    invite: row.invite,
    href: row.href,
  };
}

/** The most common value of a list (first seen wins a tie), or null. */
export function mostCommon<T>(values: ReadonlyArray<T | null | undefined>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}
