// The shared vocabulary of the migration ladder: the entry shape and the two
// DDL helpers every range file uses.
//
// This module deliberately imports NOTHING from the app. `src/db.ts` statically
// imports `src/migrate.ts`, which imports the range files, which import this —
// so anything reached from here that imported the database back would close a
// boot-order cycle. Keep it type-only plus `node:sqlite`.

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export function addColumn(db: DatabaseSync, table: string, colDef: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch {
    /* already exists on fresh DBs */
  }
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}
