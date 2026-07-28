import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionSuggestCacheKey,
  suggestSession,
  weekAheadCacheKey,
  weekAheadRead,
} from "../dist/coachOps.js";
import { localDateISO } from "../dist/repo/shared.js";
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
