// Dismissals as evidence (W3.2) — src/repo/surface-dismissals.ts + migration 93.
// A single dismissal must teach nothing (the round's own audit risk); every
// consumer gates on REPETITION — at least DISMISSAL_REPEAT_THRESHOLD distinct
// days for the same (surface, item_key). This tests the seam module directly:
// record/count/threshold, the same-day collapse, and migration idempotence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { MIGRATIONS, runMigrations } from "../dist/migrate.js";

test("migration 93 (surface-dismissals) is idempotent on a second pass", () => {
  const before = db.prepare("PRAGMA user_version").get().user_version;
  const result = runMigrations(db);
  const after = db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(before, after, "user_version does not move on a second pass");
  assert.equal(result.applied, 0, "no migration re-applies once at the max version");
  const maxVersion = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  assert.equal(after, maxVersion);
  // The table + its unique index survive a second CREATE TABLE/INDEX IF NOT
  // EXISTS pass without throwing.
  assert.doesNotThrow(() => db.prepare("SELECT 1 FROM surface_dismissals LIMIT 1").get());
});

test("recordDismissal collapses repeat taps the same day into one row", () => {
  assert.equal(repo.recordDismissal("today_agenda", "health-focus", "2026-08-20"), true);
  assert.equal(
    repo.recordDismissal("today_agenda", "health-focus", "2026-08-20"),
    false,
    "a second tap the same day writes nothing new"
  );
  assert.equal(repo.dismissalDayCount("today_agenda", "health-focus"), 1);
});

test("one dismissal never suppresses; a second DISTINCT day does", () => {
  repo.recordDismissal("insight", "nutrition.protein~sleep.quality:*", "2026-08-18");
  assert.equal(
    repo.isRepeatedlyDismissed("insight", "nutrition.protein~sleep.quality:*"),
    false,
    "one idle dismissal teaches nothing"
  );

  repo.recordDismissal("insight", "nutrition.protein~sleep.quality:*", "2026-08-19");
  assert.equal(repo.dismissalDayCount("insight", "nutrition.protein~sleep.quality:*"), 2);
  assert.equal(repo.isRepeatedlyDismissed("insight", "nutrition.protein~sleep.quality:*"), true);
});

test("repeatedlyDismissedKeys only returns item_keys past the threshold, per surface", () => {
  repo.recordDismissal("insight", "labs.iron~recovery.readiness:*", "2026-08-01");
  repo.recordDismissal("insight", "labs.iron~recovery.readiness:*", "2026-08-05");
  repo.recordDismissal("insight", "sleep.quality~life.stress:*", "2026-08-01"); // only once — below threshold
  repo.recordDismissal("today_agenda", "labs.iron~recovery.readiness:*", "2026-08-01");
  repo.recordDismissal("today_agenda", "labs.iron~recovery.readiness:*", "2026-08-02");

  assert.deepEqual(repo.repeatedlyDismissedKeys("insight"), ["labs.iron~recovery.readiness:*"]);
  assert.deepEqual(repo.repeatedlyDismissedKeys("today_agenda"), ["labs.iron~recovery.readiness:*"]);
});

test("recordDismissal ignores an empty item key and an unknown surface", () => {
  assert.equal(repo.recordDismissal("today_agenda", "  "), false);
  assert.equal(repo.recordDismissal("bogus_surface", "x"), false);
});
