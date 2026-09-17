// Migrations v101–v150. See `src/migrate.ts` for the ladder's rules (append-only,
// dense integer versions, no down-migrations) and the runner that applies them.
//
// To add one, append an entry here with the next integer version. Then do the
// schema two-step: the matching column must ALSO appear in that table's
// `CREATE TABLE IF NOT EXISTS` in `src/db.ts`, or a fresh database never gets it.
// `npm run schema:check` enforces both halves.
//
// A data-repair migration must call a FROZEN snapshot under `./frozen/`, never a
// live repo module — see the header of `v051-100.ts`.

import { addColumn, type Migration } from "./helpers.js";
import { repairExerciseIdentity } from "./frozen/v103-exercise-identity-repair.js";

export const MIGRATIONS_101_150: Migration[] = [
  {
    version: 101,
    name: "profile-endurance-schedule",
    up: (db) => addColumn(db, "profile", "endurance_schedule_json TEXT"),
  },
  {
    // The athlete's stated LIFTING weekdays — the strength counterpart to v101's run
    // days. {days:[{dow}], note?, source, updated_at}; no `kind`, because a lifting day
    // is named by the plan's own rotation, not by the schedule. NULL keeps every
    // existing DB on the purely positional ring it has today.
    version: 102,
    name: "profile-strength-schedule",
    up: (db) => addColumn(db, "profile", "strength_schedule_json TEXT"),
  },
  {
    version: 103,
    name: "exercise-identity-repair",
    // Pure data repair — no schema change, so no db.ts counterpart.
    //
    // THE ROWS THIS EXISTS FOR. Exercise aliases were being WRITTEN and never READ,
    // so the catalog accumulated the same movement under several names while the
    // alias rows that already joined them went unused: one chest-press station typed
    // three ways, a rope hammer curl duplicated with a "Cable" prefix, a single-arm
    // row aliased but never folded, an alias pointing at a canonical that does not
    // exist, a pull-up stored as a TIMED movement, and two muscle groups naming the
    // wrong region (a chest-supported row filed under "chest", a neutral-grip pull-up
    // under "forearms"). Each split lift is its own progress line and its own share
    // of per-muscle volume, so the coaching read was working from a divided history.
    //
    // WHAT IT CHANGES. Repoints broken aliases at the row their canonical keys to;
    // folds the named clusters and then every remaining pair that shares one
    // expandedExerciseKey into the member with the most logged sets; puts "Pull Up"
    // back on reps; corrects the two muscle groups and the leg press's Garmin FIT
    // category (SQUAT/LEG_PRESS, from the checked-in catalog — never an invented
    // enum). Logged numbers are never touched: a merge only moves which exercise a
    // set belongs to. Idempotent — a second pass finds no broken alias, no named
    // `from` row and no multi-member cluster. The transform is the frozen
    // repairExerciseIdentity so this migration cannot drift with the live module;
    // POST /api/exercises/dedupe re-runs the live equivalent whenever it is needed.
    up: (db) => {
      repairExerciseIdentity(db);
    },
  },
];
