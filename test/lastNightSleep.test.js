// Sleep/HRV → Brief copy (E2) — latestSleep() reads the most recent SINGLE night
// (Garmin architecture preferred, daily_metrics fallback) into plain numbers + a
// calm one-line summary, and dayRead surfaces it so the Brief can name last night.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, isoDaysAgo } from "./_seed.js";
import { LAST_NIGHT_MAX_AGE_DAYS, SENSOR_MAX_AGE_DAYS } from "../dist/repo/sensor-freshness.js";
import * as prompt from "../dist/prompt.js";

beforeEach(() => {
  db.prepare("DELETE FROM daily_metrics").run();
  db.prepare("DELETE FROM garmin_daily_metrics").run();
});

test("latestSleep is null when there is no sleep data anywhere", () => {
  assert.equal(repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep), null);
});

test("summarizes the most recent night from daily_metrics (Apple/Oura/Whoop)", () => {
  repo.recordDailyMetrics("apple", isoDaysAgo(2), { sleep_min: 430, hrv_ms: 60, resting_hr: 52 });
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 432, hrv_ms: 61 });
  const ls = repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep);
  assert.ok(ls);
  assert.equal(ls.date, isoDaysAgo(1), "the most recent night");
  assert.equal(ls.source, "apple");
  assert.equal(ls.total_min, 432);
  assert.match(ls.text, /7h12m sleep/, "432 min reads as 7h12m");
  assert.match(ls.text, /HRV 61ms/);
});

test("prefers Garmin architecture (deep/REM) and flags HRV vs the athlete's own norm", () => {
  // garmin_daily_metrics rows need a source_id (FK → garmin_sources).
  const src = db.prepare(`INSERT OR IGNORE INTO garmin_sources (provider, label) VALUES ('garmin', 'test')`).run();
  const sid = Number(
    src.lastInsertRowid || db.prepare(`SELECT id FROM garmin_sources WHERE provider='garmin' AND label='test'`).get().id
  );
  // 30-day baseline HRV ~ 65 from prior nights.
  for (let i = 5; i <= 20; i++) {
    db.prepare(
      `INSERT INTO garmin_daily_metrics (source_id, date, sleep_min, hrv_ms, resting_hr) VALUES (?, ?, 440, 65, 50)`
    ).run(sid, isoDaysAgo(i));
  }
  // Last night: HRV well below the norm, with architecture present.
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, sleep_min, hrv_ms, resting_hr, deep_sleep_min, rem_sleep_min, light_sleep_min)
     VALUES (?, ?, 400, 48, 54, 80, 95, 210)`
  ).run(sid, isoDaysAgo(1));
  const ls = repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep);
  assert.equal(ls.source, "garmin");
  assert.equal(ls.deep_min, 80);
  assert.match(ls.text, /1h20m deep/);
  assert.match(ls.text, /1h35m REM/);
  assert.match(ls.text, /below your norm/, "HRV well under baseline is named, not scored");
});

test("dayRead signals carry last_night and the Brief prompt names it in plain words", () => {
  // Sleep is dated by its WAKE day, so the night just ended is dated TODAY.
  repo.recordDailyMetrics("apple", isoDaysAgo(0), { sleep_min: 450, hrv_ms: 70 });
  const r = repo.dayRead();
  assert.ok(r.signals.last_night, "last_night present in dayRead signals");
  assert.equal(r.signals.last_night.total_min, 450);

  const p = prompt.buildDayReadPrompt();
  assert.match(p, /LAST NIGHT:/);
  assert.match(p, /7h30m sleep/);
});

// The prompt guards BOTH sleep overclaims, and they are a matched pair: inventing
// sleep the athlete never synced, and narrating ONE night as a run of them. The
// second is the case where the deterministic trend flag and a "lately" sentence
// disagree — four short nights can still sit under a >6h average with low_sleep
// false — so the guardrail names the three fields that actually license a trend.
test("a single short night is fenced off from being narrated as a pattern", () => {
  // Four 290-min nights on top of ten normal ones: the average stays over 6h.
  // Wake-day dating — the run of short nights has to START on the read date for the
  // newest of them to be last night at all.
  for (let n = 0; n <= 3; n++) repo.recordDailyMetrics("apple", isoDaysAgo(n), { sleep_min: 290, hrv_ms: 52 });
  for (let n = 4; n <= 14; n++) repo.recordDailyMetrics("apple", isoDaysAgo(n), { sleep_min: 430, hrv_ms: 60 });

  const r = repo.dayRead();
  // The exact contradiction the guardrail exists for, and the three field paths
  // it names — pinned here so a signals-shape change cannot silently orphan them.
  assert.equal(r.signals.low_sleep, false, "the multi-night flag is NOT set");
  assert.ok(r.signals.avg_sleep_min > 360, "because the average is still over 6h");
  assert.equal(r.signals.last_night.total_min, 290, "while last night really was short");
  assert.equal(typeof r.signals.fatigue.sleep_vs_norm, "number");

  const p = prompt.buildDayReadPrompt();
  assert.match(p, /ONE NIGHT IS NOT A TREND/);
  assert.match(p, /`low_sleep`/);
  assert.match(p, /`avg_sleep_min`/);
  assert.match(p, /`fatigue\.sleep_vs_norm`/);
});

test("the one-night guardrail is absent when there is no night to overclaim about", () => {
  const p = prompt.buildDayReadPrompt();
  assert.match(p, /no recent sleep or HRV data has synced/, "the absent-data branch speaks instead");
  assert.ok(!/ONE NIGHT IS NOT A TREND/.test(p), "and its pair stays silent — there is no night to misread");
});

// ---- "last night" is a DATE, not a tolerance -------------------------------
//
// Sleep rows are dated by the WAKE day, so the night the athlete has just woken
// from is dated the read day itself and a row dated d-1 is the night BEFORE last.
// The window's two-day tolerance (SENSOR_MAX_AGE_DAYS.sleep) is right for a trend
// and wrong for a one-night claim: on 2026-09-02 an unworn watch still produced
// "you had a solid night of sleep" off the night that ended the previous morning.

test("a night dated the day BEFORE the read is not last night", () => {
  repo.recordDailyMetrics("apple", isoDaysAgo(1), { sleep_min: 496, hrv_ms: 49, resting_hr: 53 });

  assert.equal(repo.latestSleep(LAST_NIGHT_MAX_AGE_DAYS), null, "the one-night bound refuses it");
  assert.ok(repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep), "while the window bound still sees it");

  const r = repo.dayRead();
  assert.equal(r.signals.last_night, null, "so the read carries no last night");

  // ...and nothing downstream words one either.
  const evidence = JSON.stringify(r.decision?.evidence ?? []);
  assert.ok(!/Last night's sleep/.test(evidence), "no last-night evidence row");
  const sleepObs = (r.signals.signal_state?.dimensions?.recovery_capacity?.evidence ?? []).filter(
    (e) => e.field === "sleep"
  );
  assert.equal(sleepObs.length, 0, "and no one-night sleep observation");

  const p = prompt.buildDayReadPrompt();
  assert.match(p, /no recent sleep or HRV data has synced/, "the prompt speaks the absent branch");
  assert.ok(!/LAST NIGHT:/.test(p), "and never opens a LAST NIGHT line");
});

test("a night dated the read day is voiced exactly as before", () => {
  repo.recordDailyMetrics("apple", isoDaysAgo(0), { sleep_min: 496, hrv_ms: 49, resting_hr: 53 });

  const r = repo.dayRead();
  assert.ok(r.signals.last_night, "last_night present");
  assert.equal(r.signals.last_night.total_min, 496);
  assert.equal(r.signals.last_night.date, isoDaysAgo(0));

  const evidence = JSON.stringify(r.decision?.evidence ?? []);
  assert.match(evidence, /Last night's sleep/, "the evidence row is back");
  const sleepObs = (r.signals.signal_state?.dimensions?.recovery_capacity?.evidence ?? []).filter(
    (e) => e.field === "sleep"
  );
  assert.equal(sleepObs.length, 1, "and the one-night observation is voiced");
});

test("the night before last still feeds the multi-night trend", () => {
  // Nothing on the read day; a short window ending yesterday. The chronic read is a
  // WINDOW claim, so it keeps the two-day anchor and still describes recent sleep.
  for (let n = 1; n <= 14; n++) repo.recordDailyMetrics("apple", isoDaysAgo(n), { sleep_min: 300, hrv_ms: 55 });

  const r = repo.dayRead();
  assert.equal(r.signals.last_night, null, "no one-night claim");
  assert.equal(r.signals.low_sleep, true, "but the <6h average is still on the board");
  assert.ok(r.signals.avg_sleep_min > 0 && r.signals.avg_sleep_min < 360);

  const trend = (r.signals.signal_state?.dimensions?.recovery_capacity?.evidence ?? []).filter(
    (e) => e.field === "sleep_trend"
  );
  assert.equal(trend.length, 1, "the trend observation survives the tightened one-night bound");
});
