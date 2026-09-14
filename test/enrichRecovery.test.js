// Crash recovery for the enrichment kinds that carry NO status column.
//
// recoverPendingEnrich() re-enqueued the five kinds whose rows record their own
// state, which meant a restart silently dropped `garmin_strength` (the day's
// one-line read, never written) and `review` (the whole-picture refresh the new
// labs were owed). Neither has a row to mark, so each is recovered from the work
// it still owes instead, inside a bounded window.
//
// Offline: every agent is disabled, so the drain these enqueues start degrades to
// a no-op before any CLI is spawned.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker, localDaysAgo } from "./_seed.js";
import { healthReviewOwed, noteHealthReviewCovered, recoverPendingEnrich } from "../dist/enrich.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  repo.setSettings({ disabled_agents: ["claude", "codex", "antigravity", "grok", "stub"], enrich_enabled: true });
  // Let any drain a previous case started finish, so the review latch is free.
  await sleep(10);
});

/** A Garmin strength activity reconciled onto a Cairn session, as sync leaves it. */
function seedStrengthActivity(date, { summary = null } = {}) {
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin', 'unofficial', ?) RETURNING id`)
    .get(`recovery-${Math.random().toString(36).slice(2)}`);
  const session = repo.getOrCreateSession(date, null);
  if (summary) {
    db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(JSON.stringify({ summary }), session.id);
  }
  const act = db
    .prepare(
      `INSERT INTO garmin_activities (source_id, external_id, date, type, name, session_id)
       VALUES (?, ?, ?, 'strength_training', 'Strength', ?) RETURNING id`
    )
    .get(source.id, `ext-${Math.random().toString(36).slice(2)}`, date, session.id);
  return { activityId: Number(act.id), sessionId: Number(session.id) };
}

test("a strength activity whose narrative never landed is recovered", () => {
  seedStrengthActivity(localDaysAgo(1));
  const recovered = recoverPendingEnrich();
  assert.equal(recovered.garmin_strength, 1, "the interrupted reconcile is queued again");
});

test("a strength activity that already has its narrative is left alone", () => {
  seedStrengthActivity(localDaysAgo(1), { summary: "Solid pushing session; the body took it well." });
  assert.equal(recoverPendingEnrich().garmin_strength, 0, "finished work is not redone on every boot");
});

test("strength recovery is bounded to the recent window, not the archive", () => {
  seedStrengthActivity(localDaysAgo(60));
  assert.equal(recoverPendingEnrich().garmin_strength, 0, "a restart re-checks the last week, never the archive");
});

test("a health document that finished after the newest review re-queues the refresh", () => {
  db.prepare(`DELETE FROM health_reviews`).run();
  seedHealthDoc(localDaysAgo(1), [marker("LDL", 120, { unit: "mg/dL" })]);
  const recovered = recoverPendingEnrich();
  assert.equal(recovered.health, 0, "the document itself is already done — nothing to re-ingest");
  assert.equal(recovered.reviews, 1, "but the whole-picture refresh it owed is queued again");
});

test("a review that already landed is not re-asked on every boot", () => {
  seedHealthDoc(localDaysAgo(1), [marker("LDL", 120, { unit: "mg/dL" })]);
  db.prepare(`INSERT INTO health_reviews (parsed_json) VALUES ('{"headline":"steady"}')`).run();
  assert.equal(recoverPendingEnrich().reviews, 0, "the stored review is newer than the document");
});

// ---- what was READ, not what was uploaded ------------------------------------
// health_documents.created_at is the UPLOAD time. Two panels from one upload share
// it, so when the first one's review landed and the second's was interrupted, the
// stored review was NEWER than both documents and the second looked reviewed
// forever. The watermark records the newest document a review actually covered.

test("a second panel from the same upload is still owed when only the first was reviewed", () => {
  db.prepare(`DELETE FROM health_reviews`).run();
  const first = seedHealthDoc(localDaysAgo(1), [marker("LDL", 120, { unit: "mg/dL" })]);
  const second = seedHealthDoc(localDaysAgo(1), [marker("ApoB", 95, { unit: "mg/dL" })]);
  assert.ok(Number(second.id) > Number(first.id), "fixture check: the second panel is the newer row");

  // The review over the first panel landed; the second's never ran.
  db.prepare(`INSERT INTO health_reviews (parsed_json) VALUES ('{"headline":"steady"}')`).run();
  noteHealthReviewCovered(Number(first.id));

  assert.equal(healthReviewOwed(), true, "the panel nobody read is still owed");
  assert.equal(recoverPendingEnrich().reviews, 1, "and a restart queues the refresh it never got");
});

test("a review that covered the newest panel is not re-asked", () => {
  db.prepare(`DELETE FROM health_reviews`).run();
  seedHealthDoc(localDaysAgo(1), [marker("LDL", 120, { unit: "mg/dL" })]);
  const second = seedHealthDoc(localDaysAgo(1), [marker("ApoB", 95, { unit: "mg/dL" })]);
  db.prepare(`INSERT INTO health_reviews (parsed_json) VALUES ('{"headline":"steady"}')`).run();
  noteHealthReviewCovered(Number(second.id));

  assert.equal(healthReviewOwed(), false, "everything on file has been read");
  assert.equal(recoverPendingEnrich().reviews, 0, "so boot asks for nothing");
});

test("a watermark from an older upload does not hold back a new panel", () => {
  const old = seedHealthDoc(localDaysAgo(3), [marker("LDL", 120, { unit: "mg/dL" })]);
  noteHealthReviewCovered(Number(old.id));
  db.prepare(`INSERT INTO health_reviews (parsed_json) VALUES ('{"headline":"steady"}')`).run();
  assert.equal(healthReviewOwed(), false, "fixture check: nothing owed before the new draw");

  seedHealthDoc(localDaysAgo(0), [marker("ApoB", 95, { unit: "mg/dL" })]);
  assert.equal(healthReviewOwed(), true, "the new panel is owed a read");
});

test("an install that has never stamped a watermark keeps the old ordering", () => {
  // Nothing has written the key, which is every database from before it existed.
  db.prepare(`DELETE FROM app_state WHERE key = 'health_review_covered_doc_id'`).run();
  db.prepare(`DELETE FROM health_reviews`).run();
  seedHealthDoc(localDaysAgo(1), [marker("LDL", 120, { unit: "mg/dL" })]);
  assert.equal(healthReviewOwed(), true, "a document with no review at all is owed one");

  db.prepare(`INSERT INTO health_reviews (parsed_json) VALUES ('{"headline":"steady"}')`).run();
  assert.equal(healthReviewOwed(), false, "and a review stored after it still answers, watermark or not");
});

test("an old document with no review does not re-ask forever", () => {
  db.prepare(`DELETE FROM health_reviews`).run();
  const doc = seedHealthDoc(localDaysAgo(60), [marker("LDL", 120, { unit: "mg/dL" })]);
  db.prepare(`UPDATE health_documents SET created_at = datetime('now', '-60 days') WHERE id = ?`).run(doc.id);
  assert.equal(recoverPendingEnrich().reviews, 0, "outside the window an unanswered ingest stops asking");
});
