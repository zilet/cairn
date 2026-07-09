// Shared canon base — the persisted `*_aliases` store both the marker canon and the
// exercise canon build on. Marker and exercise canonicalization are parallel
// normalize → alias → canonical pipelines; the one genuinely duplicated piece was the
// DB-backed alias table CRUD (get / set / list / clear over a `<thing>_aliases` upsert).
// This factors that skeleton once so the two stores can't drift, while each canon keeps
// its domain-specific normalizer + curated KB + resolution rules.
//
// The knobs preserve each store's exact behavior: exercise is defensively guarded (its
// table may not exist on an older DB), marker stamps `created_at` and bumps the marker
// data version on every mutation.
import { db } from "../db.js";

export interface AliasStore {
  // The selected value columns for a key, or null when absent. Not guarded against a
  // caller passing an empty key — callers keep their own presence checks.
  get(key: string): Record<string, string> | null;
  set(key: string, values: string[], source: string): void;
  list(): any[];
  clear(key: string): void;
}

export interface AliasStoreConfig {
  table: string;              // e.g. "marker_aliases"
  keyColumn: string;          // normalized lookup column, e.g. "raw_norm" | "alias"
  valueColumns: string[];     // canonical columns, e.g. ["canonical_key","canonical_name"] | ["canonical"]
  listOrderBy: string;        // ORDER BY clause for list(), e.g. "canonical_name, raw_norm"
  guarded?: boolean;          // wrap every statement in try/catch (table may be absent)
  stampCreatedAt?: boolean;   // INSERT a created_at = datetime('now') column
  onMutate?: () => void;      // side effect after a successful set()/clear()
}

export function createAliasStore(cfg: AliasStoreConfig): AliasStore {
  const { table, keyColumn, valueColumns, listOrderBy, guarded, stampCreatedAt, onMutate } = cfg;

  const getSql = `SELECT ${valueColumns.join(", ")} FROM ${table} WHERE ${keyColumn} = ?`;
  const insertCols = [keyColumn, ...valueColumns, "source", ...(stampCreatedAt ? ["created_at"] : [])];
  const insertVals = [...[keyColumn, ...valueColumns, "source"].map(() => "?"), ...(stampCreatedAt ? ["datetime('now')"] : [])];
  const conflictSet = [...valueColumns, "source"].map((c) => `${c} = excluded.${c}`).join(", ");
  const setSql =
    `INSERT INTO ${table} (${insertCols.join(", ")}) VALUES (${insertVals.join(", ")}) ` +
    `ON CONFLICT(${keyColumn}) DO UPDATE SET ${conflictSet}`;
  const listSql = `SELECT ${[keyColumn, ...valueColumns, "source"].join(", ")} FROM ${table} ORDER BY ${listOrderBy}`;
  const clearSql = `DELETE FROM ${table} WHERE ${keyColumn} = ?`;

  const run = <T>(fn: () => T, fallback: T): T => {
    if (!guarded) return fn();
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  return {
    get(key) {
      return run(() => (db.prepare(getSql).get(key) as any) ?? null, null);
    },
    set(key, values, source) {
      run(() => {
        db.prepare(setSql).run(key, ...values, source);
        onMutate?.();
      }, undefined);
    },
    list() {
      return run(() => db.prepare(listSql).all() as any[], []);
    },
    clear(key) {
      run(() => {
        db.prepare(clearSql).run(key);
        onMutate?.();
      }, undefined);
    },
  };
}
