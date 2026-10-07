// A restore point taken on boot, just before a pending migration touches the file.
//
// WHY. There are no down-migrations, and a hosted install updates itself (a platform
// pulls a new image in a maintenance window, or the athlete taps "Update now"), so
// "back up before deploying a schema change" is advice nobody is there to follow.
// This makes it automatic: when the ladder is about to move an EXISTING database
// forward, `VACUUM INTO` writes one consistent, WAL-checkpointed copy of it first.
//
// WHEN. Only when there is something to protect and something about to change:
// a file-backed database (never `:memory:`), a `user_version` above zero (a brand-new
// or test database starts at 0 and has nothing worth keeping), and a version below the
// ladder's top. On an unchanged boot this is one PRAGMA read and nothing else.
//
// WHERE. `${DATA_DIR}/backups/pre-migration-v<from>-to-v<to>-<timestamp>.db`. Only the
// newest few files with that prefix are kept; nothing else in the directory is
// touched, so an operator's own backups there are safe.
//
// FAILURE. A snapshot that cannot be written (a full disk, a read-only mount) logs a
// warning and boot continues — a missing restore point must not take the app down —
// unless CAIRN_REQUIRE_MIGRATION_SNAPSHOT=1, which turns it into a refusal to migrate.
//
// BOOT ORDER. `src/db.ts` calls this BEFORE its schema exec and `runMigrations`, so the
// copy is the database exactly as the previous release left it. Like `migrate.ts`, it
// must never import the database back.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.js";
import { MIGRATIONS } from "./migrate.js";

export const PRE_MIGRATION_PREFIX = "pre-migration-";
export const PRE_MIGRATION_KEEP = 3;
const PARTIAL_SUFFIX = ".partial";

export type PreMigrationSnapshotResult =
  | { status: "skipped"; reason: "in_memory" | "fresh_database" | "up_to_date" }
  | { status: "written"; file: string; from: number; to: number; pruned: string[] }
  | { status: "failed"; from: number; to: number; error: string };

export interface PreMigrationSnapshotOptions {
  /** The file the connection was opened on (DB_PATH). */
  dbPath: string;
  /** Snapshots land in `${dataDir}/backups`. */
  dataDir: string;
  /** Throw instead of warning when the snapshot cannot be written. */
  required?: boolean;
  /** Clock override for tests. */
  now?: Date;
  /** Ladder top override for tests; defaults to the highest MIGRATIONS version. */
  targetVersion?: number;
  /** How many pre-migration files to keep; defaults to PRE_MIGRATION_KEEP. */
  keep?: number;
}

export function migrationSnapshotRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.CAIRN_REQUIRE_MIGRATION_SNAPSHOT ?? "").trim());
}

function isInMemoryPath(dbPath: string): boolean {
  const p = String(dbPath ?? "").trim();
  return !p || p === ":memory:" || /^file::memory:/i.test(p) || /[?&]mode=memory\b/i.test(p);
}

function snapshotStamp(now: Date): string {
  // 2026-01-31T04-05-06-789Z — sortable, and free of characters a filesystem dislikes.
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Remove everything but the newest `keep` pre-migration snapshots, plus stale partials. */
export function prunePreMigrationSnapshots(dir: string, keep = PRE_MIGRATION_KEEP): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  const snapshots: { name: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(PRE_MIGRATION_PREFIX)) continue;
    const full = path.join(dir, name);
    if (name.endsWith(`.db${PARTIAL_SUFFIX}`)) {
      // A crash mid-VACUUM leaves one of these; it is never a usable restore point.
      try {
        fs.rmSync(full, { force: true });
        removed.push(name);
      } catch {
        // best effort
      }
      continue;
    }
    if (!name.endsWith(".db")) continue;
    try {
      snapshots.push({ name, mtime: fs.statSync(full).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  snapshots.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  for (const old of snapshots.slice(Math.max(0, keep))) {
    try {
      fs.rmSync(path.join(dir, old.name), { force: true });
      removed.push(old.name);
    } catch {
      // best effort — a file we cannot delete is not a reason to stop booting
    }
  }
  return removed;
}

export function snapshotBeforeMigrations(
  db: DatabaseSync,
  opts: PreMigrationSnapshotOptions
): PreMigrationSnapshotResult {
  if (isInMemoryPath(opts.dbPath)) return { status: "skipped", reason: "in_memory" };
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const from = Number(row?.user_version ?? 0);
  if (!(from > 0)) return { status: "skipped", reason: "fresh_database" };
  const to = opts.targetVersion ?? MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  if (from >= to) return { status: "skipped", reason: "up_to_date" };

  const dir = path.join(opts.dataDir, "backups");
  const name = `${PRE_MIGRATION_PREFIX}v${from}-to-v${to}-${snapshotStamp(opts.now ?? new Date())}.db`;
  const file = path.join(dir, name);
  const partial = `${file}${PARTIAL_SUFFIX}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(partial, { force: true });
    // VACUUM INTO reads one consistent snapshot (WAL included) and refuses an existing
    // target, so it writes a scratch name that is renamed only once it is complete.
    db.prepare("VACUUM INTO ?").run(partial);
    fs.renameSync(partial, file);
  } catch (e: any) {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      // best effort
    }
    const error = String(e?.code || e?.name || "Error");
    if (opts.required) {
      log.error("[migrate] pre-migration snapshot failed; refusing to migrate", { from, to, error });
      throw new Error(
        `CAIRN_REQUIRE_MIGRATION_SNAPSHOT is set and the pre-migration snapshot (v${from} -> v${to}) ` +
          `could not be written to ${dir} (${error}). Free space or fix permissions, or unset the flag.`
      );
    }
    log.warn("[migrate] pre-migration snapshot failed; migrating without one", { from, to, error });
    return { status: "failed", from, to, error };
  }
  const pruned = prunePreMigrationSnapshots(dir, opts.keep ?? PRE_MIGRATION_KEEP);
  log.info(`[migrate] snapshot before v${from} -> v${to}: backups/${name}`, { pruned: pruned.length });
  return { status: "written", file, from, to, pruned };
}
