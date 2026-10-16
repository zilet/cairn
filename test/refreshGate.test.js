// The material-change gate for the background week-ahead sketch and the quiet insight
// (src/repo/refresh-gate.ts). Live agent_runs showed week_ahead running 7-12 times a
// day and the insight generator 3-9 times a day — mostly after a Garmin sync, a food
// log, a chat turn or a restart that changed nothing either read turns on (fifty
// insight runs, two stored insights, in fourteen days). This file proves the contract
// that replaced it, end to end through the real reads with a counting fake CLI:
//   • unchanged inputs never spawn the agent (a sync rewrite, a restart, a food note
//     for the week-ahead, a counter bump);
//   • every MATERIAL change spawns it exactly once, immediately;
//   • a DRIFT-only change waits for the minimum interval, then spawns it once;
//   • a failed run never turns into a retry storm.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureWeekAheadJob, executeBrainReviewAction } from "../dist/agentJobs.js";
import { generateInsight, weekAheadCacheKey, weekAheadRead, weekAheadServe } from "../dist/coachOps.js";
import {
  INSIGHT_DRIFT_MIN_MS,
  INSIGHT_FAILURE_BACKOFF_MS,
  WEEK_AHEAD_DRIFT_MIN_MS,
  refreshGateStats,
  refreshVerdict,
  resetRefreshGateStats,
} from "../dist/repo/refresh-gate.js";
import { getAgentStats } from "../dist/repo/agent-telemetry.js";
import { localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion, resetTrainingDataCache } from "../dist/repo/training-cache.js";
import { weekAheadWarmAwaitsNight } from "../dist/scheduler.js";
import { db, repo } from "./_seed.js";

// ---------------------------------------------------------------- the counting fake CLI

const WEEK_JSON = JSON.stringify({
  days: [
    { day: "Mon", kind: "lift", label: "Lower body" },
    { day: "Tue", kind: "run", label: "Easy 5k" },
    { day: "Wed", kind: "rest", label: "Rest" },
  ],
  summary: "Two lifts, an easy run, and a rest day.",
});
const QUIET_INSIGHT_JSON = JSON.stringify({ kind: "connection", found: false, text: null });

let agentSeq = 0;

/** An agents.json whose one agent counts every spawn into a file, then answers `body` (or fails). */
function countingAgent(body, { fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-refresh-gate-"));
  const counter = path.join(dir, "spawns");
  fs.writeFileSync(counter, "");
  const name = `gatefake${++agentSeq}`;
  const answer = fail ? "exit 1" : `printf '%s' ${JSON.stringify(body)}`;
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      [name]: {
        command: "sh",
        args: ["-c", `echo x >> '${counter}'; ${answer}`],
        input: "arg",
        description: "refresh-gate test double",
        env_required: [],
        capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      },
    })
  );
  return {
    name,
    file,
    spawns: () => fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length,
  };
}

async function withAgent(agent, run) {
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = agent.file;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
  }
}

const today = () => localDateISO();

// Production always has the profile and settings rows; a wiped test DB creates them
// lazily on the first write that needs them, which would read as a (real) change.
test.beforeEach(() => {
  // Background enrichment (a new exercise, a food note) would spawn the same fake CLI
  // and be miscounted as the read under test.
  repo.setSettings({ enrich_enabled: false });
  repo.getSettings();
  repo.setProfile({ name: "Gate athlete" });
});

/** Run `change`, then ask twice: the first ask may spawn, the second must not. */
async function spawnsAfter(agent, ask, change) {
  const before = agent.spawns();
  change();
  await ask();
  await ask();
  return agent.spawns() - before;
}

// ---------------------------------------------------------------- the rule itself

test("refreshVerdict: material always refreshes, drift waits its interval, identical inputs never re-ask", () => {
  const prev = { material: "m1", drift: "d1", at: 1_000_000, outcome: "answered" };
  const opts = { driftMinMs: 1000, failureBackoffMs: 500, now: 1_000_100 };
  assert.deepEqual(refreshVerdict(null, { material: "m1", drift: "d1" }, opts), { refresh: true, reason: "first" });
  assert.deepEqual(refreshVerdict(prev, { material: "m1", drift: "d1" }, opts), {
    refresh: false,
    reason: "unchanged",
  });
  assert.deepEqual(refreshVerdict(prev, { material: "m2", drift: "d1" }, opts), { refresh: true, reason: "material" });
  assert.deepEqual(refreshVerdict(prev, { material: "m1", drift: "d2" }, opts), {
    refresh: false,
    reason: "drift_deferred",
  });
  assert.deepEqual(refreshVerdict(prev, { material: "m1", drift: "d2" }, { ...opts, now: 1_001_000 }), {
    refresh: true,
    reason: "drift",
  });
  // A material move is never debounced, not even by a fresh answer or a failure backoff.
  const failed = { ...prev, outcome: "failed" };
  assert.deepEqual(refreshVerdict(failed, { material: "m1", drift: "d1" }, opts), {
    refresh: false,
    reason: "failure_backoff",
  });
  assert.deepEqual(refreshVerdict(failed, { material: "m1", drift: "d1" }, { ...opts, now: 1_000_600 }), {
    refresh: true,
    reason: "retry",
  });
  assert.deepEqual(refreshVerdict(failed, { material: "m9", drift: "d1" }, opts), {
    refresh: true,
    reason: "material",
  });
});

// ---------------------------------------------------------------- the week-ahead key

test("the week-ahead key survives a restart, counter bumps, and a Garmin sync that rewrites the same night", () => {
  const d = today();
  repo.upsertGarminDailyMetric({ date: d, sleep_min: 430, hrv_ms: 48, resting_hr: 52, steps: 900 });
  const key = weekAheadCacheKey(repo.weekAheadPlan(d), d);

  resetTrainingDataCache(); // a restart: the in-process counters start over at zero
  assert.equal(weekAheadCacheKey(repo.weekAheadPlan(d), d), key);
  bumpTrainingDataVersion();
  bumpTrainingDataVersion(); // every Garmin pass bumps it, whether or not a value moved
  assert.equal(weekAheadCacheKey(repo.weekAheadPlan(d), d), key);

  // The same night re-synced, plus the day's telemetry ticking along.
  repo.upsertGarminDailyMetric({ date: d, sleep_min: 430, hrv_ms: 48, resting_hr: 55, steps: 6400, stress_avg: 31 });
  assert.equal(
    weekAheadCacheKey(repo.weekAheadPlan(d), d),
    key,
    "steps, stress and today's RHR revision are telemetry"
  );

  // A food note is not a week-ahead input at all.
  repo.addFoodNote("lunch", "chicken and rice", null);
  assert.equal(weekAheadCacheKey(repo.weekAheadPlan(d), d), key);

  // A night that genuinely differs is news.
  repo.upsertGarminDailyMetric({ date: d, sleep_min: 300 });
  assert.notEqual(weekAheadCacheKey(repo.weekAheadPlan(d), d), key);
});

test("week-ahead: unchanged inputs spawn nothing; each material change spawns exactly one run", async () => {
  const agent = countingAgent(WEEK_JSON);
  const ask = () => weekAheadRead(agent.name);
  await withAgent(agent, async () => {
    const d = today();
    assert.equal(await spawnsAfter(agent, ask, () => {}), 1, "the first read asks the coach once");
    const first = await ask();
    assert.equal(first.cached, true);
    assert.equal(first.days[0].label, "Lower body");

    // Nothing material: a restart, counter bumps, a same-night re-sync, a food log.
    assert.equal(
      await spawnsAfter(agent, ask, () => {
        resetTrainingDataCache();
        bumpTrainingDataVersion();
        repo.upsertGarminDailyMetric({ date: d, steps: 4000, stress_avg: 22 });
        repo.addFoodNote("snack", "an apple", null);
      }),
      0
    );

    // A session in progress is drift (deferred); finishing it is material.
    let sessionId = null;
    assert.equal(
      await spawnsAfter(agent, ask, () => {
        repo.logSetByName({ date: d, exercise: "Gate Squat", weight: 135, reps: 5 });
        repo.logSetByName({ date: d, exercise: "Gate Squat", weight: 135, reps: 5 });
        sessionId = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(d)?.id ?? null;
      }),
      0,
      "logging sets mid-session never re-sketches the week"
    );
    assert.ok(sessionId, "fixture: the set opened a session");

    const material = [
      ["a logged run", () => repo.addActivity({ date: d, type: "run", duration_min: 30, distance_km: 5 })],
      ["a new night of sleep", () => repo.upsertGarminDailyMetric({ date: d, sleep_min: 410, hrv_ms: 51 })],
      ["a check-in", () => repo.addCheckin(d, { energy: 2, sleep_feel: 2 })],
      ["a symptom", () => repo.reportTrainingSymptom({ area_text: "left knee", onset_on: d })],
      ["an injury", () => repo.addContextEvent({ kind: "injury", title: "Ankle", start_date: d })],
      ["a goal change", () => repo.setProfile({ goal_weight_lb: 171 })],
      [
        "a plan/target change",
        () =>
          repo.savePlanDay(1, "Lower", "Lower body", [
            { exercise: "Gate Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 140 },
          ]),
      ],
      [
        "a stated run calendar",
        () =>
          repo.setProfile({
            endurance_schedule: {
              days: [
                { dow: 2, kind: "easy" },
                { dow: 6, kind: "long" },
              ],
            },
          }),
      ],
    ];
    for (const [label, change] of material) {
      assert.equal(await spawnsAfter(agent, ask, change), 1, `${label} refreshes the sketch exactly once`);
    }
  });
});

test("week-ahead: a drift-only change waits for the minimum interval, then refreshes once", async () => {
  const agent = countingAgent(WEEK_JSON);
  const ask = () => weekAheadRead(agent.name);
  await withAgent(agent, async () => {
    await ask();
    const d = today();
    assert.equal(await spawnsAfter(agent, ask, () => repo.logWeight(180.4, d)), 0, "a weigh-in is drift — deferred");
    const key = weekAheadCacheKey(repo.weekAheadPlan(d), d);
    const ageHours = Math.ceil(WEEK_AHEAD_DRIFT_MIN_MS / 3_600_000) + 1;
    db.prepare(`UPDATE ai_cache SET computed_at = datetime('now', ?) WHERE kind = 'week_ahead' AND cache_key = ?`).run(
      `-${ageHours} hours`,
      key
    );
    assert.equal(await spawnsAfter(agent, ask, () => {}), 1, "past the interval the drift is picked up, once");
  });
});

test("week-ahead serve: a fresh answer needs no refresh across non-material writes; a material one floors and kicks", async () => {
  resetRefreshGateStats();
  const agent = countingAgent(WEEK_JSON);
  await withAgent(agent, () => weekAheadRead(agent.name));
  const d = today();

  const fresh = weekAheadServe(d);
  assert.equal(fresh.needsRefresh, false);
  assert.equal(fresh.response.source, "agent");

  bumpTrainingDataVersion(); // what used to mint a new key on every Garmin pass
  repo.upsertGarminDailyMetric({ date: d, steps: 1200 });
  const stillFresh = weekAheadServe(d);
  assert.equal(stillFresh.needsRefresh, false, "a sync pass no longer costs a run");
  assert.equal(stillFresh.cacheKey, fresh.cacheKey);
  assert.ok(refreshGateStats().week_ahead.skipped_unchanged >= 1, "the run it no longer spends is counted");
  assert.equal(getAgentStats().skipped_unchanged.week_ahead, refreshGateStats().week_ahead.skipped_unchanged);

  repo.addActivity({ date: d, type: "ride", duration_min: 60, distance_km: 25 });
  const moved = weekAheadServe(d);
  assert.equal(moved.needsRefresh, true);
  assert.notEqual(moved.cacheKey, fresh.cacheKey);
  assert.equal(
    moved.response.source,
    "deterministic",
    "after a material change the athlete reads the floor, never the old sketch"
  );
  assert.equal(moved.response.computing, true);
});

test("week-ahead: a failed run is marked, and the job backoff holds the door instead of re-enqueueing on every open", async () => {
  const broken = countingAgent(null, { fail: true });
  const result = await withAgent(broken, () => weekAheadRead(broken.name));
  assert.equal(result.refresh_failed, true, "no usable answer is flagged on the job's result");
  assert.equal(result.source, "deterministic");

  const { cacheKey } = weekAheadServe();
  const { job } = ensureWeekAheadJob(undefined, cacheKey);
  repo.finishAgentJob(job.id, { result });
  const again = ensureWeekAheadJob(undefined, cacheKey);
  assert.equal(again.created, false, "a done-but-failed run backs off like an errored one");
  assert.equal(again.job.id, job.id);

  db.prepare(`UPDATE agent_jobs SET finished_at = datetime('now', '-45 minutes') WHERE id = ?`).run(job.id);
  assert.equal(ensureWeekAheadJob(undefined, cacheKey).created, true, "the backoff is a pause, not a refusal");

  // A clean answer is never a backoff match.
  const { job: okJob } = ensureWeekAheadJob(undefined, `${cacheKey}-ok`);
  repo.finishAgentJob(okJob.id, { result: { ok: true, days: [], summary: "", source: "agent" } });
  assert.equal(ensureWeekAheadJob(undefined, `${cacheKey}-ok`).created, true);
});

// ---------------------------------------------------------------- the insight gate

test("insight: an unchanged picture is never re-asked; drift waits; material asks at once", async () => {
  resetRefreshGateStats();
  const agent = countingAgent(QUIET_INSIGHT_JSON);
  const ask = () => generateInsight(agent.name, "connection");
  await withAgent(agent, async () => {
    const d = today();
    const first = await ask();
    assert.equal(first.ok, false);
    assert.equal(first.agent_status, "ok", "found:false is the calm answer");
    assert.equal(agent.spawns(), 1);

    const repeat = await ask();
    assert.equal(repeat.skipped, "unchanged");
    assert.equal(repeat.agent_status, "ok");
    assert.equal(agent.spawns(), 1, "the same picture is not read twice");

    assert.equal(await spawnsAfter(agent, ask, () => repo.addFoodNote("dinner", "salmon and potatoes", null)), 0);
    assert.equal(await spawnsAfter(agent, ask, () => repo.logWeight(179.8, d)), 0, "a weigh-in is drift");
    assert.equal(refreshGateStats().insight.drift_deferred >= 2, true);

    const state = JSON.parse(repo.getAppState("insight_refresh_gate"));
    repo.setAppState(
      "insight_refresh_gate",
      JSON.stringify({ ...state, at: state.at - INSIGHT_DRIFT_MIN_MS - 60_000 })
    );
    assert.equal(await spawnsAfter(agent, ask, () => {}), 1, "past the interval the drift is read, once");

    for (const [label, change] of [
      ["a logged run", () => repo.addActivity({ date: d, type: "run", duration_min: 40, distance_km: 7 })],
      ["a check-in", () => repo.addCheckin(d, { energy: 4 })],
      ["a nutrition target", () => repo.setNutritionTarget({ target_kcal: 2300, protein_g: 180 })],
    ]) {
      assert.equal(await spawnsAfter(agent, ask, change), 1, `${label} is read at once, exactly once`);
    }

    // An explicit ask (the PWA button / MCP) always runs — the athlete drives.
    const before = agent.spawns();
    await generateInsight(agent.name, "connection", undefined, { gate: false });
    assert.equal(agent.spawns(), before + 1);
    assert.equal((await ask()).skipped, "unchanged", "and is recorded, so the next automatic ask knows");
  });
  assert.ok(refreshGateStats().insight.skipped_unchanged >= 2);
  assert.equal(getAgentStats().skipped_unchanged.insight, refreshGateStats().insight.skipped_unchanged);
});

test("insight: two signals landing together spend one run, not two", async () => {
  const agent = countingAgent(QUIET_INSIGHT_JSON);
  await withAgent(agent, async () => {
    const [a, b] = await Promise.all([
      generateInsight(agent.name, "connection"),
      generateInsight(agent.name, "connection"),
    ]);
    assert.equal(agent.spawns(), 1, "the second ask waits for the first answer, then reads the gate");
    assert.equal([a, b].filter((r) => r.skipped === "unchanged").length, 1);
  });
});

test("insight: a brain-signal review over an unchanged picture spends no agent", async () => {
  const agent = countingAgent(QUIET_INSIGHT_JSON);
  await withAgent(agent, async () => {
    await generateInsight(agent.name, "connection");
    const before = agent.spawns();
    const review = await executeBrainReviewAction(
      {
        event: {
          kind: "recovery_metrics_changed",
          domain: "recovery",
          date: today(),
          reason: "training status changed from PEAKING_1 to RECOVERY_1",
        },
      },
      agent.name
    );
    assert.equal(review.ok, false);
    assert.equal(review.skipped, "unchanged");
    assert.equal(agent.spawns(), before);
  });
});

test("insight: a failed ask backs off on the same inputs, retries after, and never blocks a material change", async () => {
  const broken = countingAgent(null, { fail: true });
  const ask = () => generateInsight(broken.name, "connection");
  await withAgent(broken, async () => {
    const failed = await ask();
    assert.equal(failed.ok, false);
    assert.notEqual(failed.agent_status, "ok", "a dead CLI is not a calm answer");
    const afterFirst = broken.spawns();
    assert.ok(afterFirst >= 1);

    const held = await ask();
    assert.equal(held.skipped, "failure_backoff");
    assert.equal(broken.spawns(), afterFirst, "no retry storm on the next signal");

    const state = JSON.parse(repo.getAppState("insight_refresh_gate"));
    assert.equal(state.outcome, "failed");
    repo.setAppState(
      "insight_refresh_gate",
      JSON.stringify({ ...state, at: state.at - INSIGHT_FAILURE_BACKOFF_MS - 1000 })
    );
    await ask();
    const afterRetry = broken.spawns();
    assert.ok(afterRetry > afterFirst, "after the backoff the same inputs may be tried again");

    repo.addActivity({ date: today(), type: "run", duration_min: 20, distance_km: 3 });
    await ask();
    assert.ok(broken.spawns() > afterRetry, "a material change is never held behind a failure");
  });
});

// ---------------------------------------------------------------- the morning warm

test("the week-ahead warm waits for last night only when a night is expected, and only until the cutoff", () => {
  const d = "2026-10-16";
  const morning = new Date(2026, 9, 16, 6, 0, 0);
  const afternoon = new Date(2026, 9, 16, 13, 0, 0);
  const nights = (dates) => (date) => dates.includes(date);
  assert.equal(weekAheadWarmAwaitsNight(d, morning, nights(["2026-10-15"])), true, "watch wearer, night not synced");
  assert.equal(weekAheadWarmAwaitsNight(d, morning, nights(["2026-10-15", d])), false, "the night is in");
  assert.equal(weekAheadWarmAwaitsNight(d, morning, nights([])), false, "no wearable: never wait");
  assert.equal(weekAheadWarmAwaitsNight(d, afternoon, nights(["2026-10-15"])), false, "past the cutoff: warm anyway");
});
