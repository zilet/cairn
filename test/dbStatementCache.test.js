// The prepared-statement cache on the one SQLite connection.
//
// `db.prepare()` is called INLINE at ~630 sites, most of them inside per-row loops and
// per-request builders, and every call re-parsed and re-compiled a SQL literal that
// never varies. One cold getCoachContext on the seeded demo DB issues 3,862 prepare()
// calls across 317 distinct SQL texts — so 3,545 of those compiles bought nothing, on
// a host (a Pi 5) where they are the expensive part.
//
// Memoizing by SQL text is only safe because of two properties of this codebase, and
// the last test here is the fence that keeps them true. Everything else pins the
// cache's own behaviour: one compile per text, a shared handle that stays correct
// under re-entrant use, and a bounded map that evicts rather than grows.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, prepareUncached, resetStatementCache, statementCacheStats } from "../dist/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "src");

test("the same SQL text compiles once and is handed back on every later call", () => {
  resetStatementCache();
  const sql = "SELECT 1 AS one";
  const first = db.prepare(sql);
  const second = db.prepare(sql);
  const third = db.prepare(sql);

  assert.equal(first, second, "the same SQL must hand back the same statement");
  assert.equal(second, third);
  const stats = statementCacheStats();
  assert.equal(stats.compiles, 1, "one compile for one SQL text");
  assert.equal(stats.hits, 2, "the other two calls were served from the memo");
  assert.equal(first.get().one, 1, "and the shared statement still answers");
});

test("distinct SQL texts still get their own statements", () => {
  resetStatementCache();
  db.prepare("SELECT 1 AS one");
  db.prepare("SELECT 2 AS two");
  db.prepare("SELECT 1 AS one");
  const stats = statementCacheStats();
  assert.equal(stats.compiles, 2);
  assert.equal(stats.hits, 1);
});

test("a shared statement is correct when the same SQL is re-entered inside its own row loop", () => {
  // The hazard the cache has to survive: a caller looping over `.all()` rows and
  // re-preparing the SAME text inside the loop now gets the statement it is already
  // "using". run/get/all each bind, step to completion and reset before returning, so
  // there is no half-stepped state to corrupt — this is the assertion that says so.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS stmt_cache_probe (n INTEGER)");
  db.prepare("DELETE FROM stmt_cache_probe").run();
  const insert = "INSERT INTO stmt_cache_probe (n) VALUES (?)";
  for (const n of [1, 2, 3, 4, 5]) db.prepare(insert).run(n);

  const listSql = "SELECT n FROM stmt_cache_probe ORDER BY n";
  const rows = db.prepare(listSql).all();
  assert.deepEqual(
    rows.map((r) => Number(r.n)),
    [1, 2, 3, 4, 5]
  );

  const seen = [];
  for (const row of rows) {
    // Same SQL text, same cached handle, called from inside the loop over its own rows.
    const again = db.prepare(listSql).all();
    assert.equal(again.length, 5, "the shared statement re-steps cleanly every time");
    seen.push(Number(row.n));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5], "the outer rows were materialized, not invalidated");

  const countSql = "SELECT COUNT(*) AS c FROM stmt_cache_probe WHERE n > ?";
  assert.equal(Number(db.prepare(countSql).get(2).c), 3);
  assert.equal(Number(db.prepare(countSql).get(4).c), 1, "bindings do not leak between calls");
  db.exec("DROP TABLE IF EXISTS stmt_cache_probe");
});

test("a statement that fails to compile caches nothing", () => {
  resetStatementCache();
  assert.throws(() => db.prepare("SELECT FROM WHERE nonsense"));
  assert.equal(statementCacheStats().size, 0);
  assert.equal(statementCacheStats().compiles, 0);
});

test("the cache is bounded — a caller minting unique SQL evicts instead of growing", () => {
  resetStatementCache();
  const { max } = statementCacheStats();
  for (let i = 0; i < max + 50; i++) db.prepare(`SELECT ${i} AS n`);
  const stats = statementCacheStats();
  assert.equal(stats.size, max, "the map never exceeds its bound");
  assert.equal(stats.evictions, 50);
  assert.equal(stats.compiles, max + 50);
  resetStatementCache();
});

test("prepareUncached is still a fresh compile, for anything that needs its own handle", () => {
  resetStatementCache();
  const a = prepareUncached("SELECT 7 AS seven");
  const b = prepareUncached("SELECT 7 AS seven");
  assert.notEqual(a, b);
  assert.equal(statementCacheStats().compiles, 0, "the raw path bypasses the memo entirely");
  assert.equal(a.get().seven, 7);
});

test("nothing in src/ holds a half-stepped statement or reconfigures one", () => {
  // The two properties the cache's safety rests on, as a fence rather than a claim.
  //
  //   iterate() hands back a statement that is stepped LAZILY, so two callers sharing
  //   one handle would reset each other mid-walk. The mode setters (bigint reads, bare
  //   named parameters, array rows) are per-statement configuration, so one caller's
  //   setting would silently become every other caller's.
  //
  // If this fails, the new call site is not necessarily wrong — it must take its
  // statement from `prepareUncached` instead of `db.prepare`. Comments count too; that
  // is deliberate, because a mention is a good moment to re-read the cache's contract.
  // src/db.ts itself is exempt: it is the file that documents these four names.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // db.ts is where the contract is WRITTEN — it names all four on purpose.
      if (!entry.name.endsWith(".ts") || full === path.join(srcDir, "db.ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const pattern of [".iterate(", "setReadBigInts", "setAllowBareNamedParameters", "setReturnArrays"]) {
        if (text.includes(pattern)) offenders.push(`${path.relative(srcDir, full)}: ${pattern}`);
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], "statement-cache safety property broken — see src/db.ts");
});
