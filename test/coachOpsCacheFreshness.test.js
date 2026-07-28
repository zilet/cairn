import assert from "node:assert/strict";
import test from "node:test";
import {
  coachingCacheFreshnessFingerprint,
  sessionSuggestCacheKey,
  suggestSession,
  weekAheadCacheKey,
  weekAheadRead,
} from "../dist/coachOps.js";
import { localDateISO } from "../dist/repo/shared.js";
import { resetTrainingDataCache } from "../dist/repo/training-cache.js";
import { repo } from "./_seed.js";

const cachedSession = {
  ok: true,
  session: {
    name: "Cached training reality",
    focus: "cache fixture",
    why: "This should only survive while the material training picture is unchanged.",
    est_minutes: 30,
    items: [{ exercise: "Cache Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 100 }],
  },
  agent: "cached",
  tried: [],
  agent_status: "ok",
};

const cachedWeek = {
  ok: true,
  days: [{ day: "Today", kind: "lift", label: "Cached week fixture" }],
  summary: "This should only survive while the material training picture is unchanged.",
  source: "agent",
  cached: false,
  agent: "cached",
};

function seedSessionCache(opts) {
  repo.saveAiCache("session_suggest", sessionSuggestCacheKey(opts), {
    result: cachedSession,
    chosen_agent: "cached",
    freshForMs: 3 * 60 * 60 * 1000,
  });
}

function seedWeekCache() {
  repo.saveAiCache("week_ahead", weekAheadCacheKey(repo.weekAheadPlan()), {
    result: cachedWeek,
    chosen_agent: "cached",
    freshForMs: 18 * 60 * 60 * 1000,
  });
}

function restartEquivalentFingerprint(date) {
  resetTrainingDataCache();
  return coachingCacheFreshnessFingerprint(date);
}

test("explicit ordered training-intent and endurance-goal changes invalidate a same-day session suggestion", async () => {
  const date = localDateISO();
  const opts = { date, minutes: 30, focus: "cache freshness intent" };
  repo.setProfile({
    primary_discipline: "hybrid",
    training_intent: {
      priorities: ["longevity", "muscle", "endurance"],
      endurance_role: "supporting",
    },
  });
  seedSessionCache(opts);
  assert.equal((await suggestSession("stub", opts)).session.name, cachedSession.session.name);

  repo.setProfile({
    training_intent: {
      priorities: ["endurance", "longevity", "muscle"],
      endurance_role: "co_primary",
    },
  });

  const afterIntent = await suggestSession("stub", opts);
  assert.equal(afterIntent.ok, false);
  assert.equal(afterIntent.error, "agent returned no usable session");

  seedSessionCache(opts);
  repo.setProfile({
    endurance_goal: {
      mode: "standing",
      label: "Keep a relaxed two-hour ride available",
      weekly_sessions: 3,
    },
  });
  const afterGoal = await suggestSession("stub", opts);
  assert.equal(afterGoal.ok, false);
  assert.equal(afterGoal.error, "agent returned no usable session");
});

test("logged strength/activity and an active injury invalidate the same-day session suggestion", async () => {
  const date = localDateISO();
  const opts = { date, minutes: 35, focus: "cache freshness training" };
  seedSessionCache(opts);
  assert.equal((await suggestSession("stub", opts)).session.name, cachedSession.session.name);

  repo.logSetByName({ date, exercise: "Cache Squat", weight: 105, reps: 5 });
  assert.equal((await suggestSession("stub", opts)).ok, false);

  seedSessionCache(opts);
  repo.addActivity({ date, type: "ride", duration_min: 40, distance_km: 12 });
  assert.equal((await suggestSession("stub", opts)).ok, false);

  seedSessionCache(opts);
  repo.addContextEvent({ kind: "injury", title: "Fresh ankle issue", start_date: date });
  assert.equal((await suggestSession("stub", opts)).ok, false);
});

test("logged training and active symptom state invalidate the week-ahead cache", async () => {
  const date = localDateISO();
  seedWeekCache();
  const cached = await weekAheadRead("stub");
  assert.equal(cached.cached, true);
  assert.equal(cached.days[0].label, cachedWeek.days[0].label);

  repo.addActivity({ date, type: "run", duration_min: 28, distance_km: 4.5 });
  const afterActivity = await weekAheadRead("stub");
  assert.equal(afterActivity.cached, false);
  assert.notEqual(afterActivity.days[0]?.label, cachedWeek.days[0].label);

  seedWeekCache();
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: date });
  const afterSymptom = await weekAheadRead("stub");
  assert.equal(afterSymptom.cached, false);
  assert.notEqual(afterSymptom.days[0]?.label, cachedWeek.days[0].label);
});

test("persisted session and week-ahead caches survive a restart but not a home-location change", async () => {
  const date = localDateISO();
  const opts = { date, minutes: 30, focus: "cache freshness location" };
  repo.setProfile({ home_location: "Boston, MA" });
  // Model a process that has already restarted before creating the persisted
  // cache, then restart again before reading it: both processes begin with the
  // in-memory counter at zero and must agree from durable state alone.
  resetTrainingDataCache();
  seedSessionCache(opts);
  seedWeekCache();

  resetTrainingDataCache();
  assert.equal((await suggestSession("stub", opts)).session.name, cachedSession.session.name);
  assert.equal((await weekAheadRead("stub")).days[0].label, cachedWeek.days[0].label);

  repo.setProfile({ home_location: "New York, NY" });
  resetTrainingDataCache();
  assert.equal((await suggestSession("stub", opts)).ok, false);
  const weekAfterMove = await weekAheadRead("stub");
  assert.equal(weekAfterMove.cached, false);
  assert.notEqual(weekAfterMove.days[0]?.label, cachedWeek.days[0].label);
});

test("active-trip add, location edit, resolution, and end transitions change restart-stable identity", () => {
  const date = "2026-08-10";
  repo.setProfile({ home_location: "Boston, MA" });
  const atHome = restartEquivalentFingerprint(date);

  const trip = repo.addContextEvent({
    kind: "trip",
    title: "Riding week",
    start_date: "2026-08-01",
    end_date: "2026-08-20",
    meta: { location: "Burlington, VT" },
  });
  const afterAdd = restartEquivalentFingerprint(date);
  assert.notEqual(afterAdd, atHome);

  repo.updateContextEvent(trip.id, { meta: { location: "Stowe, VT" } });
  const afterLocationEdit = restartEquivalentFingerprint(date);
  assert.notEqual(afterLocationEdit, afterAdd);

  repo.updateContextEvent(trip.id, { resolved_at: date });
  const afterResolve = restartEquivalentFingerprint(date);
  assert.notEqual(afterResolve, afterLocationEdit);

  repo.updateContextEvent(trip.id, { resolved_at: null, end_date: "2026-08-20" });
  const activeAgain = restartEquivalentFingerprint(date);
  repo.updateContextEvent(trip.id, { end_date: "2026-08-09" });
  const afterEnd = restartEquivalentFingerprint(date);
  assert.notEqual(afterEnd, activeAgain);
});

test("editing future and past trip locations does not make them effective after restart", () => {
  const date = "2026-08-10";
  repo.setProfile({ home_location: "Boston, MA" });
  const future = repo.addContextEvent({
    kind: "trip",
    title: "Future trip",
    start_date: "2026-09-01",
    end_date: "2026-09-10",
    meta: { location: "Tokyo" },
  });
  const past = repo.addContextEvent({
    kind: "trip",
    title: "Past trip",
    start_date: "2026-06-01",
    end_date: "2026-06-10",
    meta: { location: "Lisbon" },
  });
  const homeIdentity = restartEquivalentFingerprint(date);

  repo.updateContextEvent(future.id, { meta: { location: "Kyoto" } });
  assert.equal(restartEquivalentFingerprint(date), homeIdentity);

  repo.updateContextEvent(past.id, { meta: { location: "Porto" } });
  assert.equal(restartEquivalentFingerprint(date), homeIdentity);
  assert.deepEqual(repo.getLocationContext({ on: date }), {
    home: "Boston, MA",
    effective: "Boston, MA",
    source: "home",
    trip_id: null,
    trip_title: null,
    weather_available: false,
    planning_role: "context_only",
  });
});
