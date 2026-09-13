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

export const MIGRATIONS_101_150: Migration[] = [
  {
    version: 101,
    name: "profile-endurance-schedule",
    up: (db) => addColumn(db, "profile", "endurance_schedule_json TEXT"),
  },
];
