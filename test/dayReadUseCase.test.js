import assert from "node:assert/strict";
import test from "node:test";
import { readToday, recordDayReadSuggestion } from "../dist/domain/brain/day-read-use-case.js";
import { configureDayReadRefresh } from "../dist/dayread-refresh.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const countDayReads = (date) =>
  db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind='day_read' AND date=?`).get(date).n;

test("readToday serves cached canonical Brief with context and records it once", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Train today.",
    why: "You're recovered and due.",
    focus: "Lower body",
    est_minutes: 60,
    signals: { readiness: "steady" },
    source: "deterministic",
    override: null,
  });

  const first = await readToday({ date, recordOutcome: true });
  const second = await readToday({ date, recordOutcome: true });

  assert.equal(first.cached, true);
  assert.equal(first.kind, "train");
  assert.equal(first.forward, null);
  assert.ok(first.arc === null || typeof first.arc === "string");
  assert.equal(typeof first.agent_status, "string");
  assert.deepEqual(second.signals, { readiness: "steady" });
  assert.equal(countDayReads(date), 1);
});

test("a cached deterministic Brief arms one self-healing re-warm without extending it on every read", async () => {
  resetTables("day_reads", "suggestions", "plan_days", "plan_items", "sessions", "logged_sets");
  const date = localDaysAgo(0);
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  repo.saveDayRead(date, {
    kind: "rest",
    headline: "Rest today.",
    why: "The safe recovery floor.",
    focus: null,
    est_minutes: null,
    signals: {},
    source: "deterministic",
    override: null,
  });

  const first = await readToday({ date });
  const second = await readToday({ date });

  assert.equal(first.cached, true);
  assert.equal(second.cached, true);
  assert.equal(armed, 1, "screen re-renders must not keep pushing the recovery retry farther away");
});

test("recordDayReadSuggestion dedupes canonical reads but keeps override reads distinct", () => {
  resetTables("suggestions");
  const date = localDaysAgo(0);

  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  recordDayReadSuggestion(date, { kind: "train", focus: "Lower body", est_minutes: 60 }, null);
  assert.equal(countDayReads(date), 1);

  recordDayReadSuggestion(date, { kind: "easy", focus: null, est_minutes: 25 }, "rough night");
  recordDayReadSuggestion(date, { kind: "easy", focus: null, est_minutes: 25 }, "short on time");
  assert.equal(countDayReads(date), 3);
});

test("a live completed run overrides stale cached prospective copy immediately", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Easy long run.",
    why: "A conversational run fits today.",
    focus: "Long",
    est_minutes: 25,
    signals: { logged_today: { sets: 0, activities: [] } },
    source: "agent",
    override: null,
  });
  // Simulate a late provider write racing an older warm: the row exists while the
  // prospective cache is still present. readToday must let the activity fact win.
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);

  const read = await readToday({ date, recordOutcome: true });

  assert.equal(read.kind, "done");
  assert.equal(read.headline, "You're done for today.");
  assert.equal(read.focus, null);
  assert.equal(read.est_minutes, null);
  assert.equal(read.cached, undefined);
  assert.match(read.why, /already got a solid run/i);
});

test("the factual race-fix save arms a background agentic re-warm (never pins floor prose)", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  let armed = 0;
  configureDayReadRefresh({
    today: () => date,
    setTimer: () => {
      armed += 1;
      return 0;
    },
    clearTimer: () => {},
  });
  repo.saveDayRead(date, {
    kind: "train",
    headline: "Easy long run.",
    why: "A conversational run fits today.",
    focus: "Long",
    est_minutes: 25,
    signals: { logged_today: { sets: 0, activities: [] } },
    source: "agent",
    override: null,
  });
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);

  const read = await readToday({ date });

  assert.equal(read.kind, "done");
  assert.equal(read.source, "deterministic");
  assert.ok(armed >= 1, "the debounced background re-warm must be armed so the warm DONE debrief still arrives");
});

test("an unchanged Garmin re-sync leaves the cached day read alone; a material change retires it", () => {
  resetTables("day_reads", "suggestions", "activities", "garmin_activities", "garmin_sources");
  const date = localDaysAgo(0);
  const input = { external_id: "act-1", date, type: "running", name: "Morning run", duration_min: 40, distance_km: 8 };

  repo.upsertGarminActivity(input); // first sight — a new fact, invalidation is correct
  repo.saveDayRead(date, {
    kind: "done",
    headline: "You're done for today.",
    why: "Solid run in — recover well.",
    focus: null,
    est_minutes: null,
    signals: { logged_today: { sets: 0, activities: ["run"] } },
    source: "agent",
    override: null,
  });

  repo.upsertGarminActivity(input); // the 6-hour auto-sync re-upserting the same effort
  assert.ok(repo.getCachedDayRead(date), "an unchanged re-sync must not clear the cached Brief");

  repo.upsertGarminActivity({ ...input, duration_min: 55 }); // provider enriched the effort
  assert.equal(repo.getCachedDayRead(date), null, "a materially changed effort must retire the cached read");
});

test("a done read still carries the day-ahead forward line (the so-what after the work)", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "activities",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "profile"
  );
  const date = localDaysAgo(0);
  repo.setProfile({ primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Push", "Chest", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 }]);
  repo.savePlanDay(2, "Pull", "Back", [{ exercise: "Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 135 }]);
  db.prepare(
    `INSERT INTO activities (date, type, duration_min, distance_km, source) VALUES (?, 'run', 30, 5, 'garmin')`
  ).run(date);

  const read = await readToday({ date });

  assert.equal(read.kind, "done");
  assert.equal(read.focus, null, "done never carries a same-day prescription");
  assert.match(String(read.forward || ""), /Next: /, "the forward line names tomorrow's lean");
});
