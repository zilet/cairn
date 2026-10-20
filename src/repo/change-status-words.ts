// ---------- where a coaching change stands, in the one set of words ----------
// The Changes feed's row status ("Lands Thursday", "Landed today", "Put back", "Held
// before it landed") and a change receipt's state (src/repo/change-receipt.ts) say the
// same thing about the same decision, so they are worded HERE, once. The day word is the
// feed's own: today / yesterday / tomorrow, a weekday within the week either side, else
// "Oct 23". Pure: every caller passes its own as-of day.
import type { ClientBrainChangeState } from "../contracts/brain-changes.js";
import { addDaysISO } from "../lib/dates.js";

export const CHANGE_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekday(day: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(ms) ? CHANGE_WEEKDAYS[new Date(ms).getUTCDay()] : day;
}

function monthDay(day: string): string {
  const ms = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** A day as the feed says it, relative to `asOf`. */
export function changeDayWord(day: string, asOf: string): string {
  if (day === asOf) return "today";
  if (day === addDaysISO(asOf, -1)) return "yesterday";
  if (day === addDaysISO(asOf, 1)) return "tomorrow";
  const nearPast = (addDaysISO(asOf, -6) ?? asOf) <= day && day < asOf;
  const nearFuture = asOf < day && day <= (addDaysISO(asOf, 6) ?? asOf);
  return nearPast || nearFuture ? weekday(day) : monthDay(day);
}

/** A change still to land: "Lands Thursday" on a known day, else "Lands soon". */
export function changeLandsWords(landsOn: string | null, asOf: string): string {
  return landsOn ? `Lands ${changeDayWord(landsOn, asOf)}` : "Lands soon";
}

/** The feed row's status line, by the row's state. */
export function changeStatusLine(
  state: ClientBrainChangeState,
  day: string,
  landsOn: string | null,
  asOf: string
): string {
  if (state === "announced") return changeLandsWords(landsOn, asOf);
  if (state === "reverted") return "Put back";
  if (state === "held") return "Held before it landed";
  return `Landed ${changeDayWord(day, asOf)}`;
}
