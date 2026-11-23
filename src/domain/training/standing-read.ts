// Where you stand, whole person (Horizon landing): one row per area a coach looks at.
// A read OVER reads: every row is assembled from an existing engine read, never a second engine.
//
//   strength   movement-standing.ts (by movement, not by exact lift)
//   endurance  the race estimate's trend, weekly distance against four weeks ago (a race's
//              taper and recovery days are not compared), the longest run taken well, VO2max
//   mobility   mobility-checks.ts (self-checks), or its invite with nothing measured
//   body       the ONE body-fat estimate, plus lean mass and bone in words off a DEXA
//   blood      marker panels in counts ("In range", "Two to tighten"), never a lab value
//   pressure   the latest home reading and its band, read by blood-pressure-read.ts
//   recovery   sleep, HRV and resting heart rate against the athlete's usual month
//
// Words and directions only (the vocabulary is ONE table, standing/words.ts): no score, no
// percentile, no level word, no raw lab value, never a gate. Each row is read on its own,
// so one failing source drops only its row; a row with nothing honest to say is omitted.
import type { TodayPath } from "../../contracts/today-path.js";
import type { WeekReadStandingRow } from "../../contracts/week-read.js";
import type { AthleteUnits } from "../../repo/display-words.js";
import { mobilityStanding, type MobilityStanding } from "../../repo/mobility-checks.js";
import { movementStanding, type MovementStanding } from "../../repo/movement-standing.js";
import type { RaceBuild } from "../../repo/race-build.js";
import { bloodRow } from "./standing/blood.js";
import { bodyRow } from "./standing/body.js";
import { mobilityRow, strengthRow } from "./standing/capacity.js";
import { enduranceRow } from "./standing/endurance.js";
import { pressureRow } from "./standing/pressure.js";
import { recoveryRow } from "./standing/recovery.js";

export { STANDING_DIRECTION_WORDS } from "./standing/words.js";

/**
 * What a caller that already holds a read can share, so nothing is read twice (and a test
 * can hand in a movement or mobility read). Every field is optional: absent, the row reads
 * its own source — except the race build and Today's path, which are never re-read here
 * (both are heavy): without the build the race pace comes off the watch's own predictor,
 * and without the path the blood row names no next draw.
 */
export interface StandingDeps {
  movement?: MovementStanding | null;
  mobility?: MobilityStanding | null;
  build?: RaceBuild | null;
  path?: TodayPath | null;
}

/** The row order a coach reads a person in. */
export const STANDING_ORDER: ReadonlyArray<WeekReadStandingRow["key"]> = [
  "strength",
  "endurance",
  "mobility",
  "body",
  "blood",
  "pressure",
  "recovery",
];

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The standing rows for the week holding `today`. */
export function standingRead(today: string, units: AthleteUnits, deps: StandingDeps = {}): WeekReadStandingRow[] {
  const movement = deps.movement !== undefined ? deps.movement : attempt(() => movementStanding(today));
  const mobility = deps.mobility !== undefined ? deps.mobility : attempt(() => mobilityStanding(today));
  const rows: Array<WeekReadStandingRow | null> = [
    attempt(() => strengthRow(movement, today, units)),
    attempt(() => enduranceRow(today, units, deps.build)),
    attempt(() => mobilityRow(mobility, today)),
    attempt(() => bodyRow(today)),
    attempt(() => bloodRow(today, deps.path)),
    attempt(() => pressureRow(today)),
    attempt(() => recoveryRow(today)),
  ];
  return rows.filter((r): r is WeekReadStandingRow => r != null);
}
