// The program-balance read as both surfaces serve it (GET /api/program/balance and the
// get_program_balance MCP tool): the balance itself (progression.ts programBalance) plus
// the lifts it could not count.
//
// A lift with no usable group (no stored group the taxonomy reads, and a name the
// classifier cannot place) earns no volume in any group: effectiveVolumeByGroup skips it,
// as it must, since there is no group to credit. Skipped silently, the balance would read
// as if that work never happened. So it is NAMED here instead: the lift, how many sets were
// logged in the same window, and one plain sentence. Informational only: nothing is graded,
// nothing is held back, and the balance numbers themselves are exactly what they were.
// Mobility is a group of its own that deliberately never counts, so it is never listed.
import { db } from "../db.js";
import { isPlaceholderExerciseName, resolveGroup } from "./exercise-canon.js";
import { type ProgramBalance, programBalance } from "./progression.js";
import { addDaysISO, localDateISO } from "./shared.js";

export interface UngroupedLift {
  exercise: string;
  /** Sets logged in the balance window. */
  sets: number;
  last_date: string;
}

export interface ProgramBalanceRead extends ProgramBalance {
  /** Lifts with logged work in the window that no muscle group could count, most sets first. */
  ungrouped: UngroupedLift[];
  /** One plain sentence naming them, or null when every lift was counted. */
  ungrouped_note: string | null;
}

// Logged work in the window [date - weeks*7 + 1, date] (programBalance's own window) on a
// lift whose group cannot be resolved.
export function ungroupedLoggedWork(weeks = 2, date = localDateISO()): UngroupedLift[] {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(weeks * 7 - 1)) ?? today;
  const rows = db
    .prepare(
      `SELECT e.name AS exercise, e.muscle_group AS muscle_group, COUNT(ls.id) AS sets, MAX(s.date) AS last_date
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
         JOIN sessions s ON s.id = ls.session_id
        WHERE s.date >= ? AND s.date <= ?
        GROUP BY e.id`
    )
    .all(since, today) as Array<{ exercise: string; muscle_group: string | null; sets: number; last_date: string }>;
  const out: UngroupedLift[] = [];
  for (const row of rows) {
    const name = String(row.exercise ?? "");
    if (!name || isPlaceholderExerciseName(name)) continue;
    if (resolveGroup(name, row.muscle_group) != null) continue;
    out.push({ exercise: name, sets: Number(row.sets) || 0, last_date: String(row.last_date) });
  }
  return out.sort((a, b) => b.sets - a.sets || a.exercise.localeCompare(b.exercise));
}

// The note names this many lifts, then "and N more"; `ungrouped` carries them all.
const UNGROUPED_NAMED_MAX = 3;

const setWord = (n: number) => `${n} ${n === 1 ? "set" : "sets"}`;

export function ungroupedNote(lifts: UngroupedLift[]): string | null {
  if (!lifts.length) return null;
  if (lifts.length === 1) {
    const [one] = lifts;
    return `${one.exercise} (${setWord(one.sets)}) isn't filed under a muscle group yet, so its work isn't in the counts above.`;
  }
  const named = lifts.slice(0, UNGROUPED_NAMED_MAX).map((l) => `${l.exercise} (${setWord(l.sets)})`);
  const more = lifts.length - named.length;
  const list = more > 0 ? `${named.join(", ")}, and ${more} more` : named.join(", ");
  return `Not filed under a muscle group yet, so not in the counts above: ${list}.`;
}

export function programBalanceRead(weeks = 2, date = localDateISO()): ProgramBalanceRead {
  const balance = programBalance(weeks, date);
  const ungrouped = ungroupedLoggedWork(weeks, date);
  return { ...balance, ungrouped, ungrouped_note: ungroupedNote(ungrouped) };
}
