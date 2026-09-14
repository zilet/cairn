// Garmin daily-metric sync ECONOMY.
//
// A sync writes up to 14 days of daily metrics in a loop. Every single-row upsert used
// to end with the guarded day-read invalidation, and that invalidation RECOMPUTES the
// deterministic read to compare fingerprints — program state, training signals, the
// 14-day recovery window, the 21-day expenditure, all of it, synchronously. So a
// routine sync paid for fourteen full day-read rebuilds back to back on a Pi, and
// thirteen of them answered a question about a half-written picture and threw the
// answer away. They all ask about the SAME date, too: the guarded invalidation
// defaults to today whatever day the row is dated.
//
// `upsertGarminDailyMetrics` writes the pass as a pass: the invalidation is deferred
// per row and asked ONCE, after the last row lands. These pin that the count really is
// one — and that one is still enough, in both directions.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { activeBrainSnapshotStats, runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { repo, resetTables, localDaysAgo } from "./_seed.js";

const TODAY = () => localDaysAgo(0);

beforeEach(() =>
  resetTables(
    "garmin_daily_metrics",
    "garmin_sources",
    "day_reads",
    "sessions",
    "logged_sets",
    "exercises",
    "plan_items",
    "plan_days",
    "brain_decisions",
    "brain_expectations",
    "brain_evaluations",
    "profile"
  )
);

// The warm agentic read the athlete actually sees: cached, and matching the live
// deterministic decision, which is the only state in which the guarded invalidation
// recomputes anything at all (a cold cache short-circuits).
function warmAgenticRead() {
  const baseline = repo.dayRead(TODAY());
  repo.saveDayRead(TODAY(), {
    ...baseline,
    headline: "Warm read.",
    why: "A sentence the athlete's coach actually wrote.",
    source: "agent",
    agent: "claude",
    override: null,
  });
  const cached = repo.getCachedDayRead(TODAY());
  assert.equal(typeof cached?.input_fingerprint, "string", "precondition: a warm read is cached");
  return cached;
}

// Fourteen days of ordinary telemetry — the shape a real sync writes, and deliberately
// inert: a re-sync of numbers the read has already seen.
function fourteenDays() {
  return Array.from({ length: 14 }, (_, i) => ({
    date: localDaysAgo(13 - i),
    steps: 8000 + i,
    resting_hr: 52,
    hrv: 61,
    sleep_min: 448,
  }));
}

// Every fingerprint compare rebuilds the unified signal state for the date under
// question, and the brain snapshot counts that rebuild. So this IS the number of
// day-read recomputes the pass paid for.
function signalStateRebuilds(fn) {
  return runWithBrainSnapshot(() => {
    const key = `signal_state:${TODAY()}`;
    const before = activeBrainSnapshotStats().computes[key] ?? 0;
    fn();
    return (activeBrainSnapshotStats().computes[key] ?? 0) - before;
  });
}

test("a 14-day pass asks the day-read question ONCE, not once per day", () => {
  warmAgenticRead();
  const rebuilds = signalStateRebuilds(() => repo.upsertGarminDailyMetrics(fourteenDays()));
  assert.equal(rebuilds, 1, "one fingerprint compare for the whole pass");
});

test("the per-row path is what that replaced — it paid once per day", () => {
  // The control. Not a recommendation: this is the cost the batch removes, pinned so a
  // future caller that loops the single-row upsert can be seen doing it.
  warmAgenticRead();
  const rows = fourteenDays();
  const rebuilds = signalStateRebuilds(() => {
    for (const row of rows) repo.upsertGarminDailyMetric(row);
  });
  assert.equal(rebuilds, rows.length, "one fingerprint compare per row, the old shape");
});

test("every row of the batch is still written", () => {
  const rows = fourteenDays();
  const written = repo.upsertGarminDailyMetrics(rows);
  assert.equal(written.length, rows.length);
  const stored = new Map(repo.listGarminDailyMetrics(40).map((r) => [String(r.date), r]));
  assert.equal(stored.size, rows.length);
  for (const row of rows) {
    const got = stored.get(row.date);
    assert.ok(got, `row for ${row.date} landed`);
    assert.equal(Number(got.steps), row.steps);
    assert.equal(Number(got.resting_hr), 52);
    assert.equal(Number(got.sleep_min), 448);
  }
});

test("a pass that moves nothing preserves the warm Brief", () => {
  const before = warmAgenticRead();
  repo.upsertGarminDailyMetrics(fourteenDays());
  const after = repo.getCachedDayRead(TODAY());
  assert.ok(after, "ordinary telemetry must not cost the athlete their coach's sentence");
  assert.equal(after.source, "agent");
  assert.equal(after.why, before.why);
});

test("a pass carrying a genuinely short night still busts the Brief", () => {
  warmAgenticRead();
  // Wake-day dating: only a night dated today is last night, and last night is what the
  // acute rules branch on. Today's row leads the pass here, with thirteen older days
  // written after it — so this also says the one surviving compare reads the FINISHED
  // pass, not just whatever the last row happened to touch.
  const rows = fourteenDays().reverse();
  rows[0] = { date: TODAY(), sleep_min: 300 };
  repo.upsertGarminDailyMetrics(rows);
  assert.equal(repo.getCachedDayRead(TODAY()), null, "a decision-moving pass must still retire the read");
});

test("an empty pass touches nothing", () => {
  const before = warmAgenticRead();
  const rebuilds = signalStateRebuilds(() => repo.upsertGarminDailyMetrics([]));
  assert.equal(rebuilds, 0);
  assert.equal(repo.getCachedDayRead(TODAY())?.why, before.why);
});
