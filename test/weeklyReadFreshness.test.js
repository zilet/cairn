// Weekly-read staleness (src/repo/coach.ts): the weekly read persists for its slot,
// so mid-week it must not keep asserting last slot's "one change" once the picture
// has moved. A coarse freshness signature is stamped at generation and compared at
// serve; a moved picture flips `stale` and DEFANGS the one change. Pull-only — the
// re-read is a quiet tap, never a nag. Legacy rows (no signature) never read stale.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedWeight, seedTrainingDay, localDaysAgo } from "./_seed.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { runWithTimeZone } from "../dist/tz.js";

beforeEach(() => {
  // The isolate import wipes the whole DB before each test; this is belt-and-braces
  // for the tables this suite reads/writes.
  repo.resetTables?.("insights", "sessions", "bodyweight_log", "context_events", "health_directives", "health_documents");
});

function addWeekly(overrides = {}) {
  return repo.addInsight({
    kind: "weekly_read",
    text: "Solid week — training held while the cut kept moving.",
    next_step: "Add one easy aerobic day.",
    status: "new",
    ...overrides,
  });
}

function servedWeekly() {
  const list = repo.listVisibleInsights();
  return (Array.isArray(list) ? list : []).find((i) => i && i.kind === "weekly_read") || null;
}

test("a stamped weekly read reads FRESH when nothing has moved", () => {
  const ins = addWeekly();
  repo.stampWeeklyReadFreshness(ins.id);
  const weekly = servedWeekly();
  assert.ok(weekly, "the weekly read is served");
  assert.notEqual(weekly.stale, true);
  // The one change is intact (not defanged) while fresh.
  assert.equal(weekly.next_step, "Add one easy aerobic day.");
});

test("a NEW training session this week flips the read stale and defangs the one change", () => {
  const ins = addWeekly();
  repo.stampWeeklyReadFreshness(ins.id); // stamp at 0 sessions this week
  seedTrainingDay(localDaysAgo(0)); // one logged session this week
  const weekly = servedWeekly();
  assert.equal(weekly.stale, true);
  assert.equal(weekly.next_step, null, "the stale one change is nulled (defanged)");
  assert.match(String(weekly.stale_note || ""), /moved/i);
});

test("a materially moved weigh-in flips the read stale", () => {
  seedWeight(localDaysAgo(1), 180);
  const ins = addWeekly();
  repo.stampWeeklyReadFreshness(ins.id); // bucket = 180
  seedWeight(localDaysAgo(0), 200); // bucket = 200
  assert.equal(servedWeekly().stale, true);
});

test("a new context event (trip/injury) flips the read stale", () => {
  const ins = addWeekly();
  repo.stampWeeklyReadFreshness(ins.id);
  db.prepare(`INSERT INTO context_events (kind, title, start_date, archived) VALUES ('trip', 'Work trip', ?, 0)`).run(
    localDaysAgo(0)
  );
  assert.equal(servedWeekly().stale, true);
});

test("no-churn: an unchanged week does NOT read stale", () => {
  seedTrainingDay(localDaysAgo(2));
  seedWeight(localDaysAgo(1), 178);
  const ins = addWeekly();
  repo.stampWeeklyReadFreshness(ins.id);
  // Nothing changes between stamp and serve.
  assert.notEqual(servedWeekly().stale, true);
});

test("a legacy weekly read with NO stored signature never reads stale", () => {
  addWeekly(); // never stamped
  seedTrainingDay(localDaysAgo(0)); // the picture moves, but there's no baseline
  const weekly = servedWeekly();
  assert.notEqual(weekly.stale, true);
  assert.equal(weekly.next_step, "Add one easy aerobic day.");
});

test("an id mismatch (a newer, unstamped weekly read) reads fresh — the signature belongs to another row", () => {
  const older = addWeekly({ text: "Older week." });
  repo.stampWeeklyReadFreshness(older.id);
  addWeekly({ text: "This week." }); // newer row, higher id, not stamped
  const weekly = servedWeekly(); // listVisibleInsights returns the newest first
  assert.equal(weekly.text, "This week.");
  assert.notEqual(weekly.stale, true);
});

test("weeklyReadFreshness verdict helper is null-safe and only judges weekly_read rows", () => {
  assert.deepEqual(repo.weeklyReadFreshness(null), { stale: false, as_of: null });
  assert.equal(repo.weeklyReadFreshness({ kind: "connection", id: 1 }).stale, false);
});

// `created_at` is a UTC instant; `as_of` is the day the athlete is told the read was
// written. Sliced, a read generated on a Sunday evening was shown as Monday's.
test("as_of is the local day the read was written, not the next UTC one", () => {
  const zone = "Pacific/Midway"; // UTC-11
  const ins = addWeekly();
  const localDay = localDateISO(new Date(), zone);
  // 05:00 UTC on the following day is 18:00 on `localDay` in that zone.
  db.prepare(`UPDATE insights SET created_at = ? WHERE id = ?`).run(
    `${addDaysISO(localDay, 1)} 05:00:00`,
    Number(ins.id),
  );

  const row = db.prepare(`SELECT * FROM insights WHERE id = ?`).get(Number(ins.id));
  const freshness = runWithTimeZone(zone, () => repo.weeklyReadFreshness(row));
  assert.equal(freshness.as_of, localDay);
});
