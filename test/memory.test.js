// Coach memory (src/repo.ts addMemory + CRUD). addMemory is the real guard
// against the background enricher re-surfacing the same fact: an EXACT
// (case-insensitive) repeat folds in place and returns the existing row, so the
// memory table never accumulates duplicate noise. These cases pin that contract
// and the CRUD round-trip the curate-able Memory tab relies on.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM memory").get().n);

beforeEach(() => {
  resetTables("memory");
});

test("addMemory inserts a new fact and returns the row", () => {
  const row = repo.addMemory("Trains fasted most mornings", "preference", "user");
  assert.ok(row.id);
  assert.equal(row.content, "Trains fasted most mornings");
  assert.equal(row.kind, "preference");
  assert.equal(count(), 1);
});

test("an EXACT repeat folds in place — count does not grow", () => {
  const a = repo.addMemory("Allergic to shellfish");
  const b = repo.addMemory("Allergic to shellfish");
  assert.equal(a.id, b.id, "the same row is returned");
  assert.equal(count(), 1);
});

test("dedup is case-insensitive and whitespace-trimmed", () => {
  const a = repo.addMemory("Loves oats for breakfast");
  const b = repo.addMemory("  loves OATS for breakfast  ");
  assert.equal(a.id, b.id);
  assert.equal(count(), 1);
});

test("genuinely different facts both persist", () => {
  repo.addMemory("Knee rehab in progress");
  repo.addMemory("Prefers evening training on weekends");
  assert.equal(count(), 2);
});

test("updateMemory edits content/kind and is readable back", () => {
  const row = repo.addMemory("old fact", "observation");
  const updated = repo.updateMemory(row.id, { content: "new fact", kind: "preference" });
  assert.equal(updated.content, "new fact");
  assert.equal(updated.kind, "preference");
  assert.equal(repo.getMemory(row.id).content, "new fact");
});

test("deleteMemory removes the row", () => {
  const row = repo.addMemory("ephemeral");
  const res = repo.deleteMemory(row.id);
  assert.equal(res.deleted, 1);
  assert.equal(repo.getMemory(row.id), null);
  assert.equal(count(), 0);
});

test("listMemory returns newest-first and respects the limit", () => {
  repo.addMemory("first");
  repo.addMemory("second");
  repo.addMemory("third");
  const rows = repo.listMemory(2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, "third", "newest first");
});
