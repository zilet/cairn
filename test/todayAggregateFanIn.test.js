// The Today fan-in: one /today read carries the payloads the PWA used to fetch
// one round trip at a time (last sets per plan exercise, that day's progression,
// the strength journey, the salience agenda, the conductor's focus). Each slice
// must equal what its own standalone route still answers — the aggregate is a
// request-count optimization, never a second source of truth.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { trainingLogRouter } from "../dist/routes/training-log.js";
import { todayAggregate, markTodayAgendaSeen } from "../dist/domain/today/index.js";
import { strengthJourneyRead } from "../dist/domain/training/index.js";
import { repo, resetTables, isoDaysAgo } from "./_seed.js";

const TODAY_LAST_SEEN_KEY = "today_last_seen_at";

beforeEach(() => {
  resetTables(
    "logged_sets", "sessions", "plan_items", "plan_days", "exercises",
    "bodyweight_log", "activities", "garmin_activities", "garmin_sources", "profile",
    "app_state", "day_reads",
  );
});

function seedLiftDay() {
  repo.setProfile({ name: "Milo", weight_lb: 188, primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Lift", "Strength", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 165 },
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
  ]);
  const past = isoDaysAgo(7);
  repo.logSetByName({ date: past, day_number: 1, exercise: "Back Squat", weight: 215, reps: 5, rir: 2 });
  repo.logSetByName({ date: past, day_number: 1, exercise: "Bench Press", weight: 155, reps: 5, rir: 2 });
}

test("the Today aggregate carries a last set for every plan-day exercise, equal to /last-set", () => {
  seedLiftDay();
  const date = isoDaysAgo(0);

  const aggregate = todayAggregate(date);

  const names = Object.keys(aggregate.last_sets);
  assert.ok(names.includes("Back Squat"), "plan-day exercises are covered");
  assert.ok(names.includes("Bench Press"));
  assert.ok(names.includes("Barbell Row"));
  for (const name of names) {
    assert.deepEqual(aggregate.last_sets[name], repo.getLastSet(name), name);
  }
  // An exercise that was never logged is a normal absence, carried as null (the
  // same 200 + null /last-set answers), never a missing key.
  assert.equal(aggregate.last_sets["Barbell Row"], null);
});

test("the aggregate's progression and strength journey mirror their own routes", () => {
  seedLiftDay();
  const date = isoDaysAgo(0);

  const aggregate = todayAggregate(date);

  assert.equal(aggregate.progression_day, 1);
  assert.deepEqual(aggregate.progression, repo.planDayProgression(1));
  assert.deepEqual(aggregate.strength_journey, strengthJourneyRead());
});

test("the aggregate's agenda equals GET /today-agenda for the same date", () => {
  seedLiftDay();
  const date = isoDaysAgo(0);

  const aggregate = todayAggregate(date);
  const standalone = repo.todayAgenda(date);

  assert.deepEqual(aggregate.agenda.primary, standalone.primary);
  assert.deepEqual(aggregate.agenda.more, standalone.more);
  assert.deepEqual(aggregate.coaching_focus, repo.getCoachingFocus());
});

test("one Today open marks the day seen exactly once, however many surfaces asked", () => {
  seedLiftDay();
  const date = isoDaysAgo(0);
  assert.equal(repo.getAppState(TODAY_LAST_SEEN_KEY), null);

  todayAggregate(date); // the aggregate computes the agenda, so it marks seen
  const first = repo.getAppState(TODAY_LAST_SEEN_KEY);
  assert.ok(first, "the first read advances the stamp");

  // The standalone /today-agenda handler's own call, plus another aggregate read:
  // markTodaySeen is debounced (~1h), so the window a returning athlete gets
  // summarized is not wiped by the second and third request of the same open.
  markTodayAgendaSeen(date);
  todayAggregate(date);
  assert.equal(repo.getAppState(TODAY_LAST_SEEN_KEY), first);
});

test("a date that is not today never marks Today seen", () => {
  seedLiftDay();

  todayAggregate(isoDaysAgo(3));

  assert.equal(repo.getAppState(TODAY_LAST_SEEN_KEY), null);
});

// ---- the batch remainder route (off-plan names the aggregate did not cover) ----

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", trainingLogRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test("GET /last-sets answers per name exactly as GET /last-set does", async () => {
  seedLiftDay();

  await withServer(async (base) => {
    const names = ["Back Squat", "Bench Press", "Barbell Row"];
    const batch = await (
      await fetch(`${base}/api/last-sets?exercises=${names.map(encodeURIComponent).join(",")}`)
    ).json();

    assert.deepEqual(Object.keys(batch), names);
    for (const name of names) {
      const single = await (await fetch(`${base}/api/last-set?exercise=${encodeURIComponent(name)}`)).json();
      assert.deepEqual(batch[name], single, name);
    }
    assert.equal(batch["Barbell Row"], null);

    const empty = await fetch(`${base}/api/last-sets?exercises=%20,`);
    assert.equal(empty.status, 400);
  });
});
