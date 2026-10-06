/**
 * Whether a dated push stance may WIDEN anything on a day — the one source the day
 * read, the daily decision, the weekly dose ledger (via the daily decision's
 * `stanceOpen`) and the progression engine's strong-top-set reserve all ask.
 *
 * A stance covering the day is the athlete's word (src/repo/training-drive.ts); it
 * widens a license only while the last three days are harm-free (`harmEvidenceOnDay`
 * returns nothing for each). Fail closed: a day whose harm read throws is not
 * evidence the work was free. Kept out of training-drive.ts so that leaf module never
 * imports the read-adherence graph.
 */
import { addDaysISO } from "../lib/dates.js";
import { harmEvidenceOnDay } from "./brain/read-adherence.js";
import { trainingDriveState } from "./training-drive.js";

/** Days before `date` that must be clean for a stance to widen anything. */
export const PUSH_STANCE_HARM_FREE_DAYS = 3;

/** No harm evidence on any of the three days before `date`. */
export function pushStanceHarmFree(date: string): boolean {
  for (let back = 1; back <= PUSH_STANCE_HARM_FREE_DAYS; back++) {
    const iso = addDaysISO(date, -back);
    if (!iso) continue;
    try {
      if (harmEvidenceOnDay(iso) != null) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * A dated push stance covers `date` (with the drive in force at push) AND the last
 * three days were clean. The daily decision layers its own day-only conditions on
 * top (no deciding brake, under the stacked-days ceiling); this is the part every
 * consumer shares.
 */
export function pushStanceInForce(date: string): boolean {
  try {
    const state = trainingDriveState(date);
    if (state.drive !== "push" || state.stance == null) return false;
    return pushStanceHarmFree(state.date);
  } catch {
    return false;
  }
}
