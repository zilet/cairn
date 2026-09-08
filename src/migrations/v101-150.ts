// Migrations v101–v150. Empty until the next schema change lands.
//
// To add one, append an entry here with the next integer version (the ladder is
// dense and append-only — never renumber, never edit a shipped entry, and there
// are no down-migrations). Then do the schema two-step: the matching column must
// ALSO appear in that table's `CREATE TABLE IF NOT EXISTS` in `src/db.ts`, or a
// fresh database never gets it. `npm run schema:check` enforces both halves.
//
//   {
//     version: 101,
//     name: "short-kebab-name",
//     up: (db) => addColumn(db, TABLE, "COLUMN TYPE"),
//   },
//
// (written as placeholders on purpose: scripts/check-schema-two-step.mjs parses
// these files for real addColumn calls and would otherwise read the example as one)
//
// A data-repair migration must call a FROZEN snapshot under `./frozen/`, never a
// live repo module — see the header of `v051-100.ts`.

import type { Migration } from "./helpers.js";

export const MIGRATIONS_101_150: Migration[] = [];
