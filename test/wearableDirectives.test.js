// WEARABLE DIRECTIVES — a daily sensor is not a lab draw.
//
// A lab's "Done" holds until the next draw, because a new panel is news. A wearable
// series "draws" every morning, so that rule re-created the HRV directive the same
// second the athlete marked it Done. And judged against a population floor, an athlete
// whose own balanced HRV band sits below it could never clear it. These pin both:
// the athlete's own band frames the reading, and a Done holds until a reading is
// materially worse than the one they marked. Synthetic values only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("garmin_daily_metrics", "daily_metrics", "health_documents", "health_directives", "app_state", "brain_decisions");
});

const band = (lo, hi) => ({ hrv: { hrvSummary: { lastNightAvg: null, baseline: { balancedLow: lo, balancedUpper: hi } } } });
const hrvDirectives = () => repo.listActiveDirectives().filter((d) => d.marker === "HRV");

test("HRV is judged against the athlete's own balanced band when the watch supplies one", () => {
  // 40 ms is below the population floor but inside this athlete's own band.
  for (let i = 3; i >= 0; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 40, raw: band(36, 48) });
  const hrv = repo.prioritizeMarkers().markers.find((m) => m.name === "HRV");
  assert.deepEqual(hrv.optimal && [hrv.optimal.low, hrv.optimal.high], [36, 48]);
  assert.equal(hrv.in_optimal, true);
  repo.deriveDirectives();
  assert.equal(hrvDirectives().length, 0, "an in-band reading raises no HRV directive");
});

test("with no personal band the population zone still stands", () => {
  for (let i = 3; i >= 0; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 40 });
  repo.deriveDirectives();
  assert.ok(hrvDirectives().length > 0);
});

test("a Done on the HRV directive holds through new below-band mornings", () => {
  for (let i = 3; i >= 1; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 40 });
  repo.deriveDirectives();
  const [row] = hrvDirectives();
  assert.ok(row, "the below-band series raised a directive");
  repo.setDirectiveStatusByUser(row.id, "resolved");
  assert.equal(hrvDirectives().length, 0, "not re-created the same second");
  // A new morning, still below the band but no worse.
  repo.upsertGarminDailyMetric({ date: localDaysAgo(0), hrv_ms: 41 });
  repo.deriveDirectives();
  assert.equal(hrvDirectives().length, 0, "a new daily reading is not news");
  // A materially worse morning is.
  repo.upsertGarminDailyMetric({ date: localDaysAgo(0), hrv_ms: 25 });
  repo.deriveDirectives();
  assert.equal(hrvDirectives().length, 1);
});
