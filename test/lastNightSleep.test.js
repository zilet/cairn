// Sleep/HRV → Brief copy (E2) — latestSleep() reads the most recent SINGLE night
// (Garmin architecture preferred, daily_metrics fallback) into plain numbers + a
// calm one-line summary, and dayRead surfaces it so the Brief can name last night.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";
import * as prompt from "../dist/prompt.js";

beforeEach(() => {
  db.prepare("DELETE FROM daily_metrics").run();
  db.prepare("DELETE FROM garmin_daily_metrics").run();
});

test("latestSleep is null when there is no sleep data anywhere", () => {
  assert.equal(repo.latestSleep(), null);
});

test("summarizes the most recent night from daily_metrics (Apple/Oura/Whoop)", () => {
  repo.recordDailyMetrics("apple", isoDaysAgo(2), { sleep_min: 430, hrv_ms: 60, resting_hr: 52 });
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 432, hrv_ms: 61 });
  const ls = repo.latestSleep();
  assert.ok(ls);
  assert.equal(ls.date, isoDaysAgo(1), "the most recent night");
  assert.equal(ls.source, "apple");
  assert.equal(ls.total_min, 432);
  assert.match(ls.text, /7h12m sleep/, "432 min reads as 7h12m");
  assert.match(ls.text, /HRV 61ms/);
});

test("prefers Garmin architecture (deep/REM) and flags HRV vs the athlete's own norm", () => {
  // garmin_daily_metrics rows need a source_id (FK → garmin_sources).
  const src = db
    .prepare(`INSERT OR IGNORE INTO garmin_sources (provider, label) VALUES ('garmin', 'test')`)
    .run();
  const sid = Number(
    src.lastInsertRowid || db.prepare(`SELECT id FROM garmin_sources WHERE provider='garmin' AND label='test'`).get().id
  );
  // 30-day baseline HRV ~ 65 from prior nights.
  for (let i = 5; i <= 20; i++) {
    db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, sleep_min, hrv_ms, resting_hr) VALUES (?, ?, 440, 65, 50)`).run(sid, isoDaysAgo(i));
  }
  // Last night: HRV well below the norm, with architecture present.
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, sleep_min, hrv_ms, resting_hr, deep_sleep_min, rem_sleep_min, light_sleep_min)
     VALUES (?, ?, 400, 48, 54, 80, 95, 210)`
  ).run(sid, isoDaysAgo(1));
  const ls = repo.latestSleep();
  assert.equal(ls.source, "garmin");
  assert.equal(ls.deep_min, 80);
  assert.match(ls.text, /1h20m deep/);
  assert.match(ls.text, /1h35m REM/);
  assert.match(ls.text, /below your norm/, "HRV well under baseline is named, not scored");
});

test("dayRead signals carry last_night and the Brief prompt names it in plain words", () => {
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 450, hrv_ms: 70 });
  const r = repo.dayRead();
  assert.ok(r.signals.last_night, "last_night present in dayRead signals");
  assert.equal(r.signals.last_night.total_min, 450);

  const p = prompt.buildDayReadPrompt();
  assert.match(p, /LAST NIGHT:/);
  assert.match(p, /7h30m sleep/);
});
