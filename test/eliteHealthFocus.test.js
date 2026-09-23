// DISPLAY SURFACES must judge HRV / Resting HR the SAME way the directive engine
// (propagation.ts, round 1) does: the mean of the athlete's last week of nights against
// their own band — never a single night's number. Before this package, healthFocus() and
// the /markers/priority catalog read judged these two wearable markers off `latest.value`
// (the single most-recent night), so the Health surface could say "HRV below optimal" on a
// morning the directive engine correctly said nothing about, or vice versa. Synthetic values.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("garmin_daily_metrics", "daily_metrics", "health_documents", "health_directives", "app_state", "brain_decisions");
});

const band = (lo, hi) => ({ hrv: { hrvSummary: { baseline: { balancedLow: lo, balancedUpper: hi } } } });
// nights[i] is the reading i days ago (null = no night).
const garminWeek = (nights, raw = band(44, 54)) => {
  nights.forEach((v, i) => {
    if (v != null) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: v, raw });
  });
};

function hrvMarker() {
  const { markers } = repo.prioritizeMarkers();
  return markers.find((m) => m.name === "HRV");
}

test("wearableWeeklyMarkerRead re-judges HRV on the week's mean, not the latest night", () => {
  // Last night is a real dip (33, well below the own band 44-54) but the week is normal (~46).
  garminWeek([33, 48, 49, 48, 47, 49, 48]);
  const raw = hrvMarker();
  assert.equal(raw.latest.value, 33, "the single most-recent night is still on the row");
  assert.equal(raw.in_optimal, false, "BEFORE the fix, prioritizeMarkers() judges the single night");

  const after = repo.wearableWeeklyMarkerRead(raw);
  assert.equal(after.latest.value, 33, "the latest reading is untouched — shown, never judged");
  assert.equal(after.in_optimal, true, "AFTER: the week's own-band mean is what earns the status");
  assert.equal(after.status_basis, "week");
  assert.match(after.status_note, /this week's average/);
  assert.doesNotMatch(after.status_note, /\d+\.\d/, "plain words, never a number-as-grade");
});

test("a genuinely low week still reads off — the mean, not any one night, drives the status", () => {
  garminWeek([41, 40, 39, 42, 40, 38, 41]); // week averages ~40, own band 44-54
  const after = repo.wearableWeeklyMarkerRead(hrvMarker());
  assert.equal(after.in_optimal, false);
  assert.ok(after.distance > 0);
  assert.equal(after.status_basis, "week");
});

test("too few nights this week earns NO status — the latest reading shows, never a verdict off one night", () => {
  garminWeek([30, null, null, null, null, 31, null]); // < 3 nights in the window
  const raw = hrvMarker();
  assert.equal(raw.trend_window, null, "prioritizeMarkers agrees there's no trend");
  const after = repo.wearableWeeklyMarkerRead(raw);
  assert.equal(after.in_optimal, null, "no status — never invented off a single night");
  assert.equal(after.status_basis, "single");
  assert.equal(after.status_note, null);
  assert.equal(after.latest.value, 30, "the latest reading is still shown");
});

test("healthFocus() excludes an HRV card built from a single stray night, and includes a real weekly dip", () => {
  // A single very-low night inside an otherwise normal week must not surface a priority.
  garminWeek([33, 48, 49, 48, 47, 49, 48]);
  const single = repo.healthFocus();
  const hrvCard = single.priorities.find((p) => p.markers.includes("HRV"));
  assert.equal(hrvCard, undefined, "one stray low night is not a Health-surface priority");

  // A genuinely low week does surface, worded through the normal readings shape.
  resetTables("garmin_daily_metrics");
  garminWeek([41, 40, 39, 42, 40, 38, 41]);
  const weekly = repo.healthFocus();
  const card = weekly.priorities.find((p) => p.markers.includes("HRV"));
  assert.ok(card, "a real weekly dip surfaces");
  const reading = card.readings.find((r) => r.name === "HRV");
  assert.ok(reading, "carries the HRV reading");
  assert.equal(reading.status_basis, "week");
  assert.match(reading.status_note, /this week's average/);
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(JSON.stringify(weekly)), "no 0-100 score anywhere (constitution)");
});

test("resting HR gets the same weekly law as HRV", () => {
  const rhr = (vals) => vals.forEach((v, i) => repo.upsertGarminDailyMetric({ date: localDaysAgo(i), resting_hr: v }));
  // One high morning (72) inside an otherwise normal week (own band defaults to a wide zone
  // absent a learned RHR band, so this asserts the mechanism, not a specific threshold).
  rhr([72, 54, 55, 53, 54, 55, 54]);
  const { markers } = repo.prioritizeMarkers();
  const raw = markers.find((m) => m.name === "Resting HR");
  const after = repo.wearableWeeklyMarkerRead(raw);
  assert.equal(after.latest.value, 72, "the latest morning still shows");
  assert.equal(after.status_basis, "week");
  assert.match(after.status_note, /this week's average/);
});

test("a non-wearable marker (a lab reading) is untouched — 'single' basis, no re-judgement", () => {
  const { markers } = repo.prioritizeMarkers();
  // No markers seeded here — exercise the pass-through path directly on a lab-shaped object.
  const lab = { name: "ApoB", source: "lab", latest: { value: 130, flag: "high" }, optimal: { low: 0, high: 90, dir: "high" }, in_optimal: false, distance: 0.5 };
  const after = repo.wearableWeeklyMarkerRead(lab);
  assert.equal(after.status_basis, "single");
  assert.equal(after.status_note, null);
  assert.equal(after.in_optimal, false, "a lab marker's own in_optimal is left exactly as prioritizeMarkers computed it");
  assert.equal(after.distance, 0.5);
  assert.equal(markers.length, 0, "sanity: no wearable rows seeded polluted the lab-only assertion above");
});
