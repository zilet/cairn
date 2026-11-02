// The race you just ran, said back (Horizon's race lane, the Week trail's "Behind you").
//
// For RACE_FINISHED_SHOWN_DAYS after a race whose effort is LOGGED (race-recovery.ts's
// matched effort — never the provisional goal date while the run is still syncing), the
// surfaces that hold the race say three things once, calmly:
//   - the result: the logged run's distance, time and pace in the athlete's units — a
//     measure, never a grade, and never held against the target the goal carried;
//   - the recovery: the window race-recovery.ts already applies (it does not open a
//     second one), said from race day itself, then "back to full" once it has passed;
//   - what is next: the live dated race the caller hands in (race-build.ts), as a
//     forward line toward its target. No next race → no line; the surface offers to set one.
// Pull, never push: this waits on the surfaces that already show the race.
import type { DistanceUnit } from "./display-words.js";
import { clockWords, dateWords, distanceWords, paceWords, raceDistanceName } from "./display-words.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { latestFinishedRace } from "./race-recovery.js";
import { raceRunActivity } from "./race-results.js";
import { localDateISO } from "./shared.js";

export interface RaceFinished {
  event: string | null;
  /** The day the race was run (the logged effort's). */
  date: string;
  /** Days since the race: 0 on race day. */
  days_since: number;
  /** The logged run's distance (km), time and pace; time/pace null when the log has no duration. */
  run_km: number;
  finish_sec: number | null;
  pace_sec_per_km: number | null;
  /** "Cambridge Half Marathon, done." */
  headline: string;
  /** "13.2 mi in 2:10:18 · 9:54 /mi · Sun, Nov 1" */
  result_line: string;
  /** True while the post-race window (or race day itself) is still open. */
  recovering: boolean;
  /** The recovery said once: the easy days left and the day full training is back; after, that it is. */
  recovery_line: string | null;
  /** The next dated race, toward its target ("Next: 5K time trial, May 16 · 23:06 now, 20:00 the target."); null with none. */
  next_line: string | null;
}

/** The next dated race as the build reads it — handed in, never re-read here. */
export interface NextRaceRef {
  event: string | null;
  date: string;
  distance_km: number;
  target_sec: number | null;
  estimate_sec: number | null;
  /** The build's fit word for the estimate against the target. */
  fit: "fits" | "stretch" | "beyond_horizon" | null;
}

const HEADLINES = [
  (race: string) => `${race}, done.`,
  (race: string) => `${race}, in the books.`,
] as const;

const RECOVERING_LINES = [
  (through: string, back: string) =>
    `Recovery: easy days through ${through} — short easy runs, lighter legs, fewer sets. Full training again ${back}.`,
  (through: string, back: string) =>
    `Easy days through ${through} let the race settle — short runs, lighter legs. Back to full ${back}.`,
] as const;

const LAST_EASY_DAY_LINES = [
  (back: string) => `Last easy day after the race — full training again ${back}.`,
  (back: string) => `Today closes the recovery days; back to full ${back}.`,
] as const;

const RECOVERED_LINES = [
  (back: string) => `Recovered — full training again since ${back}.`,
  (back: string) => `The recovery days are done; full training since ${back}.`,
] as const;

function nextLine(next: NextRaceRef | null, asOf: string, units: DistanceUnit): string | null {
  if (!next?.date || !(next.distance_km > 0)) return null;
  const name = next.event?.trim() || raceDistanceName(next.distance_km, units);
  const when = dateWords(next.date, asOf);
  const head = `Next: ${name}, ${when}`;
  if (next.target_sec == null) return `${head}.`;
  const target = clockWords(next.target_sec);
  if (next.estimate_sec == null) return `${head} · ${target} the target.`;
  const now = clockWords(next.estimate_sec);
  if (next.fit === "fits") return `${head} · ${now} now, already inside ${target}.`;
  const gap = clockWords(Math.abs(next.estimate_sec - next.target_sec));
  return `${head} · ${now} now, ${gap} to find for ${target}.`;
}

/**
 * The race just run, as of `asOf`, or null (no logged race in the last
 * RACE_FINISHED_SHOWN_DAYS days). `next` is the live dated race, when there is one.
 */
export function raceFinishedRead(
  asOf: string = localDateISO(),
  opts: { units?: DistanceUnit; next?: NextRaceRef | null } = {}
): RaceFinished | null {
  const d = String(asOf).slice(0, 10);
  const units: DistanceUnit = opts.units ?? "km";
  const race = latestFinishedRace(d);
  if (!race) return null;
  // The next race is a DIFFERENT one: the goal still pointing at the race just run is not "next".
  const next = opts.next && opts.next.date > race.run_date ? opts.next : null;

  const run = raceRunActivity(race.activity_id);
  const km = run?.km ?? race.run_km ?? race.distance_km;
  const finishSec = run?.duration_min != null ? Math.round(run.duration_min * 60) : null;
  const paceSec = finishSec != null && km > 0 ? finishSec / km : null;
  const name = race.event?.trim() || raceDistanceName(race.distance_km, units);

  const result = [
    finishSec != null ? `${distanceWords(km, units)} in ${clockWords(finishSec)}` : distanceWords(km, units),
    paceSec != null ? paceWords(paceSec, units, { spaced: true }) : "",
    dateWords(race.run_date, d, "weekday"),
  ]
    .filter(Boolean)
    .join(" · ");

  let recovering = false;
  let recoveryLine: string | null = null;
  const rec = race.recovery;
  if (rec) {
    const back = dateWords(rec.back_on, d, "relative");
    if (d < rec.to) {
      recovering = true;
      recoveryLine = pickDayVariant(RECOVERING_LINES, d, "race-finished:recovering")(
        dateWords(rec.to, d, "relative"),
        back
      );
    } else if (d === rec.to) {
      recovering = true;
      recoveryLine = pickDayVariant(LAST_EASY_DAY_LINES, d, "race-finished:last")(back);
    } else {
      recoveryLine = pickDayVariant(RECOVERED_LINES, d, "race-finished:recovered")(dateWords(rec.back_on, d, "relative"));
    }
  }

  return {
    event: race.event,
    date: race.run_date,
    days_since: race.days_since,
    run_km: km,
    finish_sec: finishSec,
    pace_sec_per_km: paceSec != null ? Math.round(paceSec) : null,
    headline: pickDayVariant(HEADLINES, d, "race-finished:headline")(name),
    result_line: result,
    recovering,
    recovery_line: recoveryLine,
    next_line: nextLine(next, d, units),
  };
}
