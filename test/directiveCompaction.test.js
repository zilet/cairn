// Migration 86 — collapsing the resolved-directive pile the pre-reconcile propagation
// engine left behind. The migration is pure data repair, so these drive its statement
// directly against hand-built rows rather than through a schema-version replay.
//
// What is being protected is not the deletion but the THREE guards around it: user
// feedback, non-identical duplicates, and anything an audit chain still points at.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, resetTables } from "./_seed.js";
import { MIGRATIONS } from "../dist/migrate.js";

const compact = () => MIGRATIONS.find((m) => m.version === 86).up(db);

beforeEach(() => {
  resetTables("health_directives");
});

function addRow(overrides = {}) {
  const row = {
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive_key: "apob:nutrition:lower-saturated-fat",
    directive: "Lower saturated fat and add soluble fiber.",
    status: "resolved",
    status_at: null,
    trigger_value: 120,
    trigger_side: "high",
    trigger_date: "2025-12-01",
    resurfaced_from_id: null,
    created_at: "2025-12-01 08:00:00",
    ...overrides,
  };
  const info = db
    .prepare(
      `INSERT INTO health_directives
         (source, domain, marker, directive_key, directive, status, status_at,
          trigger_value, trigger_side, trigger_date, resurfaced_from_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.source,
      row.domain,
      row.marker,
      row.directive_key,
      row.directive,
      row.status,
      row.status_at,
      row.trigger_value,
      row.trigger_side,
      row.trigger_date,
      row.resurfaced_from_id,
      row.created_at
    );
  return Number(info.lastInsertRowid);
}

const ids = () => db.prepare(`SELECT id FROM health_directives ORDER BY id`).all().map((r) => r.id);

test("exact-duplicate machine soft-resolves collapse to the EARLIEST row", () => {
  const keeper = addRow({ created_at: "2025-12-01 08:00:00" });
  addRow({ created_at: "2025-12-02 08:00:00" });
  addRow({ created_at: "2025-12-03 08:00:00" });
  addRow({ created_at: "2025-12-04 08:00:00" });
  assert.equal(ids().length, 4);

  compact();
  assert.deepEqual(ids(), [keeper], "one row survives, and it is the one that has been there longest");
});

test("compaction is idempotent — a second and third run change nothing", () => {
  addRow({ created_at: "2025-12-01 08:00:00" });
  addRow({ created_at: "2025-12-02 08:00:00" });
  compact();
  const after = ids();
  compact();
  compact();
  assert.deepEqual(ids(), after, "re-running finds one row per group and matches nothing");
});

test("USER feedback is never collapsed, however duplicated", () => {
  // status_at NOT NULL is a Done or a Dismiss. It suppresses resurfacing and dates an
  // intervention, and every consumer of a non-active row filters on exactly this.
  const a = addRow({ status_at: "2025-12-02T10:00:00.000Z", created_at: "2025-12-01 08:00:00" });
  const b = addRow({ status_at: "2025-12-03T10:00:00.000Z", created_at: "2025-12-02 08:00:00" });
  const c = addRow({ status: "dismissed", status_at: "2025-12-04T10:00:00.000Z", created_at: "2025-12-03 08:00:00" });
  compact();
  assert.deepEqual(ids(), [a, b, c].sort((x, y) => x - y), "all user feedback survives untouched");
});

test("a DIFFERENT trigger snapshot is a different fact and survives", () => {
  const first = addRow({ trigger_value: 120, created_at: "2025-12-01 08:00:00" });
  const worse = addRow({ trigger_value: 155, created_at: "2026-03-01 08:00:00" });
  const otherDate = addRow({ trigger_date: "2026-06-01", created_at: "2026-06-01 08:00:00" });
  compact();
  assert.deepEqual(ids(), [first, worse, otherDate], "only byte-identical rows collapse");
});

test("a row an audit chain still points at is never deleted", () => {
  const keeper = addRow({ created_at: "2025-12-01 08:00:00" });
  const referenced = addRow({ created_at: "2025-12-02 08:00:00" });
  const plainDuplicate = addRow({ created_at: "2025-12-03 08:00:00" });
  // Something resurfaced FROM the duplicate — a dangling link is worse than a dup.
  addRow({
    status: "active",
    status_at: null,
    resurfaced_from_id: referenced,
    created_at: "2026-01-01 08:00:00",
    directive_key: "apob:nutrition:resurfaced",
  });

  compact();
  const surviving = ids();
  assert.ok(surviving.includes(keeper), "the earliest duplicate is kept as always");
  assert.ok(surviving.includes(referenced), "the referenced duplicate is spared");
  assert.ok(!surviving.includes(plainDuplicate), "the unreferenced duplicate still collapses");
});

test("health_review rows are left entirely alone", () => {
  const a = addRow({ source: "health_review", created_at: "2025-12-01 08:00:00" });
  const b = addRow({ source: "health_review", created_at: "2025-12-02 08:00:00" });
  compact();
  assert.deepEqual(ids(), [a, b], "the agent-authored source owns its own history");
});

test("ACTIVE rows are never touched", () => {
  const a = addRow({ status: "active", created_at: "2025-12-01 08:00:00" });
  const b = addRow({ status: "active", created_at: "2025-12-02 08:00:00" });
  compact();
  assert.deepEqual(ids(), [a, b]);
});

test("distinct directive families do not collapse into each other", () => {
  const nutrition = addRow({ domain: "nutrition", directive_key: "apob:nutrition:x", created_at: "2025-12-01 08:00:00" });
  const watch = addRow({ domain: "watch", directive_key: "apob:watch:x", created_at: "2025-12-01 08:00:00" });
  const otherMarker = addRow({ marker: "Ferritin", directive_key: "ferritin:nutrition:x", created_at: "2025-12-01 08:00:00" });
  compact();
  assert.deepEqual(ids(), [nutrition, watch, otherMarker]);
});
