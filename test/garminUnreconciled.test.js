// repo.listUnreconciledGarminStrength — the read behind Today's calm "Garmin logged
// a lift that isn't in Cairn yet — reconcile?" card. It returns synced Garmin
// STRENGTH activities whose session_id is still null (the watch logged a lift Cairn
// doesn't know about). These cases lock in:
//   - a synced strength activity with session_id null IS returned
//   - a strength activity already LINKED to a session (session_id set — what
//     reconcileGarminStrength does) is NOT returned
//   - a non-strength (cardio) unlinked activity is NOT returned (strength-only)
//   - reconcileGarminStrength clears it from the list (links the session)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";

const TODAY = isoDaysAgo(0);

beforeEach(() => {
  for (const t of ["logged_sets", "session_skips", "sessions", "activities", "garmin_activities", "garmin_sources"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

// Insert one garmin_activities row directly (mirrors what a sync produces), with an
// explicit type + optional session_id so we can model linked vs unlinked.
function seedGarminActivity({ extId, date = TODAY, type = "strength_training", session_id = null }) {
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`).run("test-" + extId);
  db.prepare(
    `INSERT INTO garmin_activities
       (source_id, external_id, date, start_time, type, name, duration_min, session_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(src.lastInsertRowid, extId, date, `${date}T07:12:00`, type, null, 42, session_id);
  return db.prepare(`SELECT * FROM garmin_activities WHERE external_id = ?`).get(extId);
}

test("an unlinked synced Garmin strength activity is returned", () => {
  seedGarminActivity({ extId: "ext-strength-1" });
  const rows = repo.listUnreconciledGarminStrength(30);
  assert.equal(rows.length, 1, "the unlinked strength lift surfaces");
  assert.equal(rows[0].external_id, "ext-strength-1");
  assert.equal(rows[0].session_id, null, "still unlinked");
});

test("a strength activity already linked to a session is NOT returned", () => {
  // Create a real session to link against.
  const sess = repo.getOrCreateSession(TODAY, null);
  seedGarminActivity({ extId: "ext-strength-linked", session_id: sess.id });
  const rows = repo.listUnreconciledGarminStrength(30);
  assert.equal(rows.length, 0, "a reconciled (session_id set) lift is excluded");
});

test("a non-strength (cardio) unlinked activity is NOT returned — strength only", () => {
  seedGarminActivity({ extId: "ext-run", type: "running" });
  const rows = repo.listUnreconciledGarminStrength(30);
  assert.equal(rows.length, 0, "cardio is reconciled differently — never offered here");
});

test("reconcileGarminStrength links the session and clears it from the list", () => {
  const row = seedGarminActivity({ extId: "ext-strength-reconcile" });
  assert.equal(repo.listUnreconciledGarminStrength(30).length, 1, "starts unlinked");

  const out = repo.reconcileGarminStrength(row.id);
  assert.ok(out && out.session, "reconcile returns the linked session");
  assert.equal(repo.listUnreconciledGarminStrength(30).length, 0, "no longer offered once linked");
});

test("only strength rows within the window are returned, newest-first", () => {
  seedGarminActivity({ extId: "ext-old", date: isoDaysAgo(40) }); // outside a 30d window
  seedGarminActivity({ extId: "ext-recent-a", date: isoDaysAgo(2) });
  seedGarminActivity({ extId: "ext-recent-b", date: isoDaysAgo(1) });

  const rows = repo.listUnreconciledGarminStrength(30);
  assert.equal(rows.length, 2, "the 40-day-old lift falls outside the window");
  assert.equal(rows[0].external_id, "ext-recent-b", "newest-first");
});
