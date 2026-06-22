// Audit gaps in src/repo/coach.ts:
//   (1) getRecoverySummary blended ALL non-Garmin daily_metrics sources with a flat
//       AVG(). daily_metrics is UNIQUE(source,date), so piping BOTH Apple Health AND
//       Oura/Whoop gives one ROW PER SOURCE per night — and the flat AVG counted each
//       night once per source, over-doubling the recovery + acute/chronic averages.
//       The fix picks ONE row per date (most-recently-updated source) before averaging.
//   (2) listVisibleInsights had no recency window — a long-resolved CONNECTION insight
//       kept reading as "today's" for weeks. The fix ages a stale connection out of the
//       visible set (visibility only, never a delete), while keeping the weekly_read.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo, tsDaysAgo } from "./_seed.js";

// ---------------------------------------------------------------------------
// (1) Recovery: one source per night, no double-count
// ---------------------------------------------------------------------------

beforeEach(() => {
  db.prepare("DELETE FROM daily_metrics").run();
  db.prepare("DELETE FROM garmin_daily_metrics").run();
  db.prepare("DELETE FROM insights").run();
});

// A no-Garmin recovery summary so we isolate the non-Garmin `other` blend.
const noGarmin = { source: null, recovery: {}, activities: [], hard_sessions: [] };

test("recovery: a single source is averaged once (baseline behavior)", () => {
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 400, hrv_ms: 60, resting_hr: 50 });
  repo.recordDailyMetrics("apple", isoDaysAgo(2), { sleep_min: 420, hrv_ms: 62, resting_hr: 52 });
  const r = repo.getRecoverySummary(14, noGarmin);
  assert.equal(r.recovery.avg_sleep_min, 410, "(400+420)/2");
  assert.equal(r.recovery.avg_hrv_ms, 61, "(60+62)/2");
  assert.equal(r.recovery.avg_resting_hr, 51, "(50+52)/2");
});

test("recovery: TWO sources per night are NOT double-counted (one row per date)", () => {
  // Apple and Oura both report the SAME two nights. With the old flat AVG this still
  // averaged to the same MEAN by luck when values are identical — so make the sources
  // DISAGREE: the per-date winner must be exactly ONE source's value, never a blend
  // of both. Oura is written second, so it's the most-recently-updated → it wins.
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 400, hrv_ms: 60, resting_hr: 50 });
  repo.recordDailyMetrics("apple", isoDaysAgo(2), { sleep_min: 420, hrv_ms: 62, resting_hr: 52 });
  repo.recordDailyMetrics("oura", isoDaysAgo(1), { sleep_min: 300, hrv_ms: 90, resting_hr: 40 });
  repo.recordDailyMetrics("oura", isoDaysAgo(2), { sleep_min: 320, hrv_ms: 92, resting_hr: 42 });

  const r = repo.getRecoverySummary(14, noGarmin);
  // Oura wins both nights (written later → later updated_at): (300+320)/2 = 310,
  // NOT the 4-row blend (400+420+300+320)/4 = 360 the old double-count produced.
  assert.equal(r.recovery.avg_sleep_min, 310, "one row per date (Oura), not a 4-row blend");
  assert.equal(r.recovery.avg_hrv_ms, 91, "(90+92)/2");
  assert.equal(r.recovery.avg_resting_hr, 41, "(40+42)/2");
  // Sanity: the old buggy 4-row mean (360 / 91 / 46) must NOT be what we got.
  assert.notEqual(r.recovery.avg_sleep_min, 360, "the doubled blend is gone");
});

test("recovery: acute/chronic delta uses one row per date, not a doubled blend", () => {
  // Two sources every day for 30 days. recent=7d, baseline=30d. If a night were
  // counted twice the averages would still be a 2-source MEAN; force divergence so a
  // double-count would visibly skew the per-window average toward the 4-value blend.
  for (let i = 1; i <= 30; i++) {
    repo.recordDailyMetrics("apple", isoDaysAgo(i), { sleep_min: 480, hrv_ms: 70 });
    repo.recordDailyMetrics("oura", isoDaysAgo(i), { sleep_min: 360, hrv_ms: 50 });
  }
  const r = repo.getRecoverySummary(14, noGarmin);
  // Oura wins every night (written second). So BOTH 7d and 30d sleep averages are 360,
  // and the delta is 0 — not the doubled (480+360)/2 = 420 blend.
  assert.equal(r.recent.sleep, 360, "7d window = winning source only");
  assert.equal(r.baseline.sleep, 360, "30d window = winning source only");
  assert.equal(r.delta.sleep, 0, "recent vs baseline, both single-source");
  assert.equal(r.recent.hrv, 50);
  assert.equal(r.baseline.hrv, 50);
});

test("recovery: most-recently-updated source wins the date (apple re-synced last)", () => {
  // Oura first, then apple re-syncs the SAME night → apple is the latest update, so
  // apple's value is the one that counts. Proves the tie-break is updated_at, not source.
  repo.recordDailyMetrics("oura", isoDaysAgo(1), { sleep_min: 300 });
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 500 });
  const r = repo.getRecoverySummary(14, noGarmin);
  assert.equal(r.recovery.avg_sleep_min, 500, "apple updated last → apple wins");
});

// ---------------------------------------------------------------------------
// (2) Insights: connection insights age out, weekly_read persists
// ---------------------------------------------------------------------------

// Insert an insight with a chosen created_at (the column defaults to now()).
function seedInsight(kind, text, daysAgo, status = "new") {
  return db
    .prepare(`INSERT INTO insights (kind, text, status, created_at) VALUES (?, ?, ?, ?)`)
    .run(kind, text, status, tsDaysAgo(daysAgo)).lastInsertRowid;
}

test("insights: a FRESH connection is visible", () => {
  seedInsight("connection", "fresh link", 1);
  const rows = repo.listVisibleInsights(20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "fresh link");
});

test("insights: a STALE connection (>14d) ages out of the visible set", () => {
  seedInsight("connection", "old link", 30);
  const rows = repo.listVisibleInsights(20);
  assert.equal(rows.length, 0, "a 30-day-old connection no longer reads as today's");
});

test("insights: a stale connection is HIDDEN, not deleted (still in the DB)", () => {
  const id = seedInsight("connection", "old link", 30);
  assert.equal(repo.listVisibleInsights(20).length, 0, "hidden from the live card");
  // The row itself survives — visibility filter, never a delete.
  const still = db.prepare(`SELECT * FROM insights WHERE id = ?`).get(id);
  assert.ok(still, "the insight row is still in the DB");
  assert.equal(still.text, "old link");
});

test("insights: the weekly_read keystone is NEVER aged out", () => {
  seedInsight("weekly_read", "how the week went", 30); // well past the window
  const rows = repo.listVisibleInsights(20);
  assert.equal(rows.length, 1, "the weekly read persists past the connection window");
  assert.equal(rows[0].kind, "weekly_read");
});

test("insights: window keeps a fresh connection + an old weekly read, drops an old connection", () => {
  seedInsight("connection", "fresh link", 2);
  seedInsight("connection", "old link", 40);
  seedInsight("weekly_read", "old weekly", 40);
  const rows = repo.listVisibleInsights(20);
  const texts = rows.map((r) => r.text).sort();
  assert.deepEqual(texts, ["fresh link", "old weekly"], "old connection dropped; weekly kept");
});

test("insights: dismissed stays hidden regardless of age", () => {
  seedInsight("connection", "dismissed fresh", 1, "dismissed");
  const rows = repo.listVisibleInsights(20);
  assert.equal(rows.length, 0, "status filter still applies");
});
