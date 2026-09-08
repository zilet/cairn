// The migration ladder: what turns a database of any age into today's schema.
//
// THE SHAPE. `MIGRATIONS` is one dense, append-only list of integer versions. The
// entries themselves live in range files under `src/migrations/` — the list grew past
// two thousand lines as a single array, which made every append a merge conflict and
// every read a scroll. This file keeps the contract: the runner, the CLI entry point,
// and re-exports of the helpers (`Migration`, `addColumn`, `hasTable`) so nothing that
// imported them from here has to move.
//
// THE RULES. Versions are dense from 1 and never renumbered; a shipped entry is never
// edited; there are no down-migrations, so back up before deploying one. Adding a
// COLUMN to an existing table is a two-step (the ALTER in a range file AND the same
// column in `src/db.ts`'s `CREATE TABLE IF NOT EXISTS`) — `npm run schema:check`
// enforces it across `src/migrate.ts` and every `src/migrations/*.ts`.
//
// DATA-REPAIR MIGRATIONS IMPORT FROZEN SNAPSHOTS, NEVER LIVE CODE. A migration is a
// statement about what the ladder did on the day it shipped; pointing it at a live
// repo module means a fresh install replays it against today's semantics. The four
// repairs that need a real transform (v63, v87, v92, v97) call copies under
// `src/migrations/frozen/`.
//
// BOOT ORDER. `src/db.ts` statically imports this module and calls `runMigrations(db)`
// at the bottom of its own evaluation, so nothing reachable from here may import the
// database back. That is why the frozen snapshots and `./migrations/helpers.js` are
// db-free by construction.
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.js";
import type { Migration } from "./migrations/helpers.js";
import { MIGRATIONS_001_050 } from "./migrations/v001-050.js";
import { MIGRATIONS_051_100 } from "./migrations/v051-100.js";
import { MIGRATIONS_101_150 } from "./migrations/v101-150.js";

export { addColumn, hasTable } from "./migrations/helpers.js";
export type { Migration } from "./migrations/helpers.js";

export const MIGRATIONS: Migration[] = [...MIGRATIONS_001_050, ...MIGRATIONS_051_100, ...MIGRATIONS_101_150];

export function runMigrations(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as any;
  const cur = Number(row?.user_version ?? 0);
  const target = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  let applied = 0;
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= cur) continue;
    db.exec("BEGIN");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      applied++;
      log.info(`[migrate] applied v${m.version} ${m.name}`);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { from: cur, to: target, applied };
}

// CLI entry point: `tsx src/migrate.ts`
// NOTE: no top-level await here — db.ts statically imports this module, so a
// TLA on the dynamic import would deadlock the cycle (this module can't finish
// evaluating until db.js does, and db.js waits on this module). A floating
// .then lets this module finish first; db.ts runs the migrations on import.
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import("./db.js").then(({ db }) => {
    const vrow = db.prepare("PRAGMA user_version").get() as any;
    log.info(`[migrate] current user_version: ${vrow?.user_version ?? 0}`);
  });
}
