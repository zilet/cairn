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
  const back = repo.setDirectiveStatusByUser(row.id, "resolved");
  assert.equal(back.status, "active", "the tap returns the row as it now stands");
  assert.equal(back.acknowledged, true, "a Done on a standing reading is an acknowledgement");
  const acknowledged = () => hrvDirectives().filter((d) => d.acknowledged);
  assert.deepEqual(acknowledged().map((d) => d.id), [row.id], "kept in effect, never re-created as new");
  // A new morning, still below the band but no worse.
  repo.upsertGarminDailyMetric({ date: localDaysAgo(0), hrv_ms: 41 });
  repo.deriveDirectives();
  assert.deepEqual(hrvDirectives().map((d) => [d.id, d.acknowledged]), [[row.id, true]], "a new daily reading is not news");
  // One bad morning is not news either: the directive reads the WEEK's average.
  repo.upsertGarminDailyMetric({ date: localDaysAgo(0), hrv_ms: 25 });
  repo.deriveDirectives();
  assert.deepEqual(
    hrvDirectives().map((d) => [d.id, d.acknowledged]),
    [[row.id, true]],
    "a single night never resurfaces a wearable directive"
  );
  // A materially worse WEEK is.
  for (let i = 2; i >= 1; i--) repo.upsertGarminDailyMetric({ date: localDaysAgo(i), hrv_ms: 25 });
  repo.deriveDirectives();
  const now = hrvDirectives();
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, row.id, "news is a new row");
  assert.equal(now[0].acknowledged, false, "…in front of the athlete again");
  assert.equal(now[0].resurfaced_from_id, row.id);
});
