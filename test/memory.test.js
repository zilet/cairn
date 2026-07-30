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

// ---- the floor under the nightly librarian --------------------------------
// The consolidation prompt is TOLD that a goal or constraint the user stated
// themselves is theirs until they say otherwise. An instruction is not an
// enforcement: one hallucinated id on an unattended nightly pass would quietly
// retire the athlete's own words in favour of something Cairn merely inferred.

test("the librarian cannot supersede a goal the user stated themselves", async () => {
  const { applyMemoryConsolidation } = await import("../dist/coachOps.js");
  const goal = repo.addMemory("Get to 170 lb by the spring", "goal", "user");
  const constraint = repo.addMemory("No overhead pressing until the shoulder settles", "constraint", "user");
  const inferred = repo.addMemory("Tends to skip breakfast on travel days", "observation", "enrichment");

  const applied = applyMemoryConsolidation({
    supersedes: [
      { id: goal.id, replacement: "Weight goal looks abandoned", reason: "no progress lately" },
      { id: constraint.id, reason: "looks old" },
      { id: inferred.id, replacement: "Eats breakfast on travel days now", reason: "a later note says otherwise" },
    ],
  });

  assert.equal(repo.getMemory(goal.id).superseded_by, null, "the athlete's own goal survives");
  assert.equal(repo.getMemory(constraint.id).superseded_by, null, "so does their own constraint");
  assert.ok(repo.getMemory(inferred.id).superseded_by, "an INFERRED fact is still the librarian's to tidy");
  assert.equal(applied.superseded, 1, "the refusal is a quiet skip — the rest of the pass still applies");
});

test("a merge that would fold a user goal into an inferred row is refused too", async () => {
  const { applyMemoryConsolidation } = await import("../dist/coachOps.js");
  const inferred = repo.addMemory("Seems to be aiming for a leaner spring", "observation", "enrichment");
  const goal = repo.addMemory("Get to 170 lb by the spring", "goal", "user");

  // A supersede wearing a merge's clothes: the surviving row is the inferred one.
  const applied = applyMemoryConsolidation({
    merges: [{ ids: [inferred.id, goal.id], content: "Aiming to lean out by spring", kind: "goal" }],
  });
  assert.equal(repo.getMemory(goal.id).superseded_by, null);
  assert.equal(applied.merged, 0);
});

test("a user correcting their own goal still lands", async () => {
  const { applyMemoryConsolidation } = await import("../dist/coachOps.js");
  const older = repo.addMemory("Get to 175 lb by the spring", "goal", "user");
  // Deliberately far enough apart in wording that addMemory's near-duplicate fold
  // leaves two rows — the merge under test has to have two ids to work with.
  const newer = repo.addMemory("Compete at 170 lb in April", "goal", "user");
  assert.notEqual(newer.id, older.id);

  const applied = applyMemoryConsolidation({
    merges: [{ ids: [newer.id, older.id], content: "Compete at 170 lb in April", kind: "goal" }],
  });
  assert.equal(applied.merged, 1, "user-stated to user-stated is the athlete's own correction, not a takeover");
  assert.equal(repo.getMemory(older.id).superseded_by, newer.id);
});

test("promotions are untouched by the floor — nothing is retired by promoting it", async () => {
  const { applyMemoryConsolidation } = await import("../dist/coachOps.js");
  const observation = repo.addMemory("Skips breakfast most mornings", "observation", "enrichment");
  const applied = applyMemoryConsolidation({
    promotions: [{ id: observation.id, kind: "preference", content: "Prefers fasted mornings" }],
  });
  assert.equal(applied.promoted, 1);
  assert.equal(repo.getMemory(observation.id).kind, "preference");
});
