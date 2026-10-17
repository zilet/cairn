// The Brief's hot reads, COUNTED rather than timed (a wall clock is flaky on a shared Pi).
// A Today open asks the endurance-impact read for dozens of windows (each morning of the
// six-week cross-training pattern, each day of the harm ledger) and the early fetch fires
// /today-read, /daily-session/preview and /today together. These pin the two things that
// keep that cheap without changing an answer:
//   - inside one request each activity DAY is graded once, however many windows hold it;
//   - a request arriving seconds after another, with nothing written in between, takes the
//     reads the first one made instead of rebuilding them — and never across a write, a
//     clock that moved on, or one that went back.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./_seed.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { activeRequestMemoStats, copyFlat, requestMemo } from "../dist/repo/request-memo.js";
import { recentEnduranceImpacts } from "../dist/repo/hybrid-load.js";
import { crossTrainingDays } from "../dist/repo/cross-training-day.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { runDaySteerKey, withRunDaySteer } from "../dist/repo/run-day-steer.js";
import { SUN, resetLiveWeekTables, seedHistory, seedLiveWeek, seedProfile } from "./_liveWeekFixture.js";

const NOW = new Date("2026-10-04T19:00:00Z");

beforeEach(resetLiveWeekTables);

function seed() {
  seedProfile();
  seedHistory();
  seedLiveWeek();
}

const windows = () => {
  const out = [];
  for (const days of [1, 3, 7, 14, 42]) for (let back = 0; back < 30; back++) out.push([days, addDaysISO(SUN, -back)]);
  return out;
};

test("one request grades each activity day once, however many windows ask, and answers what a recompute does", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seed();
  const fresh = windows().map(([days, date]) => recentEnduranceImpacts(days, date));
  const activityDays = db.prepare(`SELECT COUNT(DISTINCT date) AS n FROM activities`).get().n;
  assert.ok(activityDays > 5, "the fixture logs a few weeks of efforts");

  const { scoped, stats } = runWithBrainSnapshot(() => {
    const scoped = windows().map(([days, date]) => recentEnduranceImpacts(days, date));
    crossTrainingDays(SUN);
    return { scoped, stats: activeRequestMemoStats() };
  });

  assert.deepEqual(scoped, fresh, "a window built from per-day grades is the window a recompute builds");
  assert.ok(stats.computes.recent_endurance_impacts >= 100, "the windows themselves are many");
  assert.ok(
    stats.computes.endurance_impacts_on <= activityDays,
    `each day graded once (${stats.computes.endurance_impacts_on} grades for ${activityDays} days)`
  );
  assert.equal(stats.stale, 0, "a read-only request never recomputes a read it already holds");
});

test("a request right after another takes its reads; a write, a later clock or an earlier one recompute", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seed();
  const read = () =>
    runWithBrainSnapshot(() => {
      const value = {
        state: getProgramState(),
        impacts: recentEnduranceImpacts(42, SUN),
        cross: crossTrainingDays(SUN),
      };
      return { value, computed: Object.values(activeRequestMemoStats().computes).reduce((a, b) => a + b, 0) };
    });

  const first = read();
  assert.ok(first.computed > 0);
  const second = read();
  assert.equal(second.computed, 0, "nothing written since: the second request recomputes nothing");
  assert.deepEqual(second.value, first.value);

  db.prepare(`INSERT INTO app_state (key, value) VALUES ('today_hot_reads', '1')`).run();
  assert.ok(read().computed > 0, "a write retires what the earlier request read");

  t.mock.timers.setTime(NOW.getTime() + 6_000);
  assert.ok(read().computed > 0, "seconds later the window has closed");
  const settled = read();
  assert.equal(settled.computed, 0);

  t.mock.timers.setTime(NOW.getTime() + 5_000);
  assert.ok(read().computed > 0, "a clock that went back never takes a later request's reads");
});

test("a steered Brief read neither takes the canonical reads nor leaves its own behind", () => {
  // The steer is heard through its own scope, not through any memo key — so a read that
  // listens for it must see the steer inside, and the canonical answer on either side.
  const probe = () => requestMemo("test:steer-probe", () => runDaySteerKey() || "canonical", copyFlat);
  assert.equal(runWithBrainSnapshot(probe), "canonical");
  assert.equal(
    withRunDaySteer(SUN, "tired today, go easy", () => runWithBrainSnapshot(probe)),
    `steer:${SUN}:tired today, go easy`
  );
  assert.equal(runWithBrainSnapshot(probe), "canonical");
});
