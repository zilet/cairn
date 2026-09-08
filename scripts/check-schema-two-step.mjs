#!/usr/bin/env node
// CI guard for the repo's schema two-step (CLAUDE.md, "The traps that actually bite").
//
// Adding a column to an EXISTING table takes two edits, not one:
//   1. src/migrations/v*.ts — a new MIGRATIONS entry doing the ALTER TABLE (so live DBs
//                              get it); src/migrate.ts itself only concatenates the ranges
//   2. src/db.ts      — the same column in that table's CREATE TABLE IF NOT EXISTS block
//                       (so a FRESH database gets it, since migrations only stamp forward)
//
// Miss (2) and nothing fails until someone boots a brand-new DB and hits a column
// that has never existed there. This script reads both files statically — no DB is
// opened, no migration is run — and fails when a migrated column is missing from the
// create block. It also asserts the MIGRATIONS version list is dense and unique, so
// two parallel branches cannot land the same version number.
//
// Usage: node scripts/check-schema-two-step.mjs
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

// The ladder lives in range files (src/migrations/v001-050.ts, …) with src/migrate.ts
// keeping the runner and the helpers, so every one of them is a place a migration can
// declare a column. Frozen snapshots (src/migrations/frozen/) are copied transforms,
// never DDL, and are deliberately out of scope.
const migrationFiles = [
  "src/migrate.ts",
  ...readdirSync(path.join(root, "src/migrations"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `src/migrations/${name}`),
];
const migrationSources = migrationFiles.map((file) => ({ file, src: read(file) }));
const dbSrc = read("src/db.ts");

// ---------- what the migrations add ----------

/** Column name out of a SQLite column definition ("weight_kg REAL DEFAULT 0" -> "weight_kg"). */
function columnName(def) {
  const match = /^\s*([A-Za-z_][\w$]*)/.exec(def);
  return match ? match[1] : null;
}

/** Every (table, column) pair a migration adds, with the source file+line for the report. */
function migratedColumns(src, file) {
  const pairs = [];
  const lineOf = (index) => src.slice(0, index).split("\n").length;

  // 1. for (const col of ["a TEXT", "b REAL"]) addColumn(db, "table", col);
  const loop = /for\s*\(\s*const\s+\w+\s+of\s*\[([\s\S]*?)\]\s*\)\s*addColumn\(\s*db\s*,\s*"(\w+)"\s*,/g;
  const loopRanges = [];
  for (const m of src.matchAll(loop)) {
    loopRanges.push([m.index, m.index + m[0].length]);
    for (const col of m[1].matchAll(/"([^"]+)"/g)) {
      const name = columnName(col[1]);
      if (name) pairs.push({ file, table: m[2], column: name, line: lineOf(m.index) });
    }
  }
  const insideLoop = (index) => loopRanges.some(([from, to]) => index >= from && index < to);

  // 2. addColumn(db, "table", "col TYPE …")
  for (const m of src.matchAll(/addColumn\(\s*db\s*,\s*"(\w+)"\s*,\s*"([^"]+)"/g)) {
    if (insideLoop(m.index)) continue;
    const name = columnName(m[2]);
    if (name) pairs.push({ file, table: m[1], column: name, line: lineOf(m.index) });
  }

  // 3. Raw SQL: ALTER TABLE table ADD COLUMN col TYPE
  for (const m of src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
    pairs.push({ file, table: m[1], column: m[2], line: lineOf(m.index) });
  }

  return pairs;
}

// ---------- what the create blocks declare ----------

const CONSTRAINT_KEYWORDS = new Set(["primary", "unique", "foreign", "check", "constraint"]);

/** CREATE TABLE IF NOT EXISTS blocks in a source file -> Map(table -> Set(column)). */
function createdTables(src) {
  const tables = new Map();
  const header = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/gi;
  for (const m of src.matchAll(header)) {
    const table = m[1];
    // Balance parentheses from the opening one so nested CHECK(...)/DEFAULT (...) survive.
    let depth = 0;
    let end = -1;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = src
      .slice(start + 1, end)
      .replace(/--[^\n]*/g, "") // line comments carry commas and words
      .replace(/\([^()]*\)/g, ""); // flatten one level so inner commas do not split rows
    const columns = tables.get(table) ?? new Set();
    for (const piece of body.split(",")) {
      const name = columnName(piece);
      if (name && !CONSTRAINT_KEYWORDS.has(name.toLowerCase())) columns.add(name);
    }
    tables.set(table, columns);
  }
  return tables;
}

// ---------- the migration list itself ----------

function migrationVersions(src) {
  return [...src.matchAll(/^\s*(?:\{\s*)?version:\s*(\d+)\s*,/gm)].map((m) => Number(m[1]));
}

// ---------- run ----------

const errors = [];
const notes = [];

const versions = migrationSources.flatMap(({ src }) => migrationVersions(src));
if (!versions.length) errors.push("no MIGRATIONS versions found in src/migrate.ts or src/migrations/*.ts — the parser found nothing to check");
const duplicateVersions = versions.filter((v, i) => versions.indexOf(v) !== i);
if (duplicateVersions.length) {
  errors.push(`duplicate migration version(s): ${[...new Set(duplicateVersions)].sort((a, b) => a - b).join(", ")}`);
}
const top = versions.length ? Math.max(...versions) : 0;
const missingVersions = [];
for (let v = 1; v <= top; v++) if (!versions.includes(v)) missingVersions.push(v);
if (missingVersions.length) errors.push(`migration versions are not dense 1..${top} — missing: ${missingVersions.join(", ")}`);

const dbTables = createdTables(dbSrc);
const migrateTables = new Map();
for (const { src } of migrationSources) {
  for (const [table, columns] of createdTables(src)) migrateTables.set(table, columns);
}
const pairs = migrationSources.flatMap(({ src, file }) => migratedColumns(src, file));

const migrationOwned = new Set();
for (const { file, table, column, line } of pairs) {
  const declared = dbTables.get(table);
  if (!declared) {
    // A table born inside a migration (or a temporary rebuild table) has no db.ts
    // block to keep in sync. Informational, never a failure.
    if (migrateTables.has(table) || /_new$|_old$|_tmp$/.test(table)) migrationOwned.add(table);
    else errors.push(`${file}:${line} adds ${table}.${column} but no CREATE TABLE IF NOT EXISTS ${table} exists in src/db.ts or the migration files`);
    continue;
  }
  if (!declared.has(column)) {
    errors.push(`${file}:${line} adds ${table}.${column}, but src/db.ts's CREATE TABLE IF NOT EXISTS ${table} does not declare it — a fresh DB would never get the column`);
  }
}

if (migrationOwned.size) {
  notes.push(`tables owned by migrations only (no src/db.ts create block): ${[...migrationOwned].sort().join(", ")}`);
}

for (const note of notes) console.log(`• ${note}`);

if (errors.length) {
  console.error("✗ schema two-step check failed:");
  for (const error of errors) console.error(`    ${error}`);
  console.error("\n  Adding a column to an existing table needs BOTH the migration-file ALTER and the");
  console.error("  matching column in src/db.ts's CREATE TABLE IF NOT EXISTS block (CLAUDE.md).");
  process.exit(1);
}

console.log(`✓ schema two-step holds (${pairs.length} migrated column(s) across ${dbTables.size} create block(s); top migration version ${top})`);
