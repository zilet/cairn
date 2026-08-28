// DIRECTIVE CHURN — the row-level half of "re-deriving is idempotent".
//
// deriveDirectives.test.js already asserts the active COUNT is stable across repeated
// derives, which a clear-all + reinsert engine passes just as happily as a diff-based
// one: same count, entirely new rows. On live data that difference is 1220 stored rows
// for a handful of live findings, because every pass soft-resolved its own output and
// wrote it again.
//
// So these assert the thing the count cannot see: the SAME PHYSICAL ROWS survive. Stable
// ids also keep `resurfaced_from_id` chains and the ledger's directive_row_id pointing at
// something real, and stop the history table growing without bound.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives", "app_state", "brain_decisions");
});

const allRows = () =>
  repo.listDirectives({ all: true }).map((d) => ({ id: d.id, status: d.status, key: d.directive_key }));

const snapshot = () =>
  repo
    .listActiveDirectives()
    .map((d) => `${d.id}:${d.directive_key}:${d.directive}`)
    .sort();

test("re-deriving an unchanged marker snapshot churns ZERO rows (ids and history stable)", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 120, { unit: "mg/dL", flag: "high" }),
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const firstActive = snapshot();
  const firstAll = allRows();
  assert.ok(firstActive.length > 0, "the seeded panel produced directives");

  for (let pass = 0; pass < 4; pass++) repo.deriveDirectives();

  assert.deepEqual(snapshot(), firstActive, "the same physical rows are still the active set");
  assert.deepEqual(
    allRows(),
    firstAll,
    "no extra rows were written and none were soft-resolved — the whole table is untouched"
  );
});

test("re-deriving after the short-circuit is bypassed still churns zero rows", () => {
  // A cheap app_state signature short-circuits an unchanged pass before any row work.
  // That is a real optimization, but it would also HIDE a churning reconcile — so clear
  // it between passes and prove the reconcile itself is what keeps the rows still.
  seedHealthDoc("2025-12-01", [marker("HbA1c", 6.0, { unit: "%", flag: "high" })]);
  repo.deriveDirectives();
  const firstAll = allRows();
  assert.ok(firstAll.length > 0);

  for (let pass = 0; pass < 3; pass++) {
    repo.setAppState("directive_derive_sig", "");
    repo.deriveDirectives();
  }
  assert.deepEqual(allRows(), firstAll, "the diff-based reconcile, not the signature, is what stops the churn");
});

test("a CHANGED marker updates the row in place rather than resolving and re-inserting", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const before = repo.listActiveDirectives().filter((d) => (d.marker || "") === "ApoB");
  assert.ok(before.length > 0);
  const beforeIds = before.map((d) => d.id).sort();

  // A fresh draw that moved, but not MATERIALLY worse: same directives, new trigger
  // snapshot. (A materially worse draw is news and resurfaces instead — see below.)
  seedHealthDoc("2026-03-01", [marker("ApoB", 123, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();

  const after = repo.listActiveDirectives().filter((d) => (d.marker || "") === "ApoB");
  assert.deepEqual(after.map((d) => d.id).sort(), beforeIds, "the same rows carried the update");
  assert.ok(
    after.every((d) => d.trigger_value === 123),
    "the new trigger snapshot landed on the existing rows"
  );
  assert.equal(
    repo.listDirectives({ all: true }).filter((d) => d.status === "resolved").length,
    0,
    "updating content resolves nothing"
  );
});

// The one change that is NOT absorbed in place: a reading that came back materially
// FURTHER off-optimal is news, and news gets a row of its own (owner ruling R1).
// Silently overwriting it is what let a rising LDL read as nothing had happened.
test("a MATERIALLY WORSE draw resurfaces its rows instead of being absorbed in place", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const beforeIds = repo
    .listActiveDirectives()
    .filter((d) => (d.marker || "") === "ApoB")
    .map((d) => d.id)
    .sort();
  assert.ok(beforeIds.length > 0);

  seedHealthDoc("2026-03-01", [marker("ApoB", 155, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();

  const after = repo.listActiveDirectives().filter((d) => (d.marker || "") === "ApoB");
  assert.ok(after.length > 0);
  assert.ok(
    after.every((d) => !beforeIds.includes(d.id)),
    "every worsened directive is a new row, so it resurfaces"
  );
  assert.ok(after.every((d) => d.trigger_value === 155 && beforeIds.includes(d.resurfaced_from_id)));
  const resolved = repo.listDirectives({ all: true }).filter((d) => d.status === "resolved");
  assert.deepEqual(resolved.map((d) => d.id).sort(), beforeIds, "the superseded rows are soft-resolved");
  assert.ok(resolved.every((d) => d.status_at == null), "a machine resolve is never user feedback");
});

test("a marker that comes back INTO range soft-resolves its rows without stamping user feedback", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 120, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const ids = repo
    .listActiveDirectives()
    .filter((d) => (d.marker || "") === "ApoB")
    .map((d) => d.id);
  assert.ok(ids.length > 0);

  seedHealthDoc("2026-03-01", [marker("ApoB", 65, { unit: "mg/dL", flag: "normal" })]);
  repo.deriveDirectives();

  const resolved = repo.listDirectives({ all: true }).filter((d) => ids.includes(d.id));
  assert.ok(resolved.length > 0, "the rows are still there — soft-resolved, not deleted");
  for (const row of resolved) {
    assert.equal(row.status, "resolved");
    assert.equal(row.status_at, null, "a MACHINE resolve never stamps status_at (that is user feedback only)");
  }
});
