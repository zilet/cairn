import assert from "node:assert/strict";
import test from "node:test";
import { enqueueAgentJob, onJobEvent } from "../dist/agentJobs.js";
import { suggestSession } from "../dist/coachOps.js";
import { repo } from "./_seed.js";

function cacheKey(opts) {
  const read = repo.dayRead(opts.date);
  return repo.fingerprint({
    minutes: opts.minutes ?? null,
    equipment: (opts.equipment ?? "").trim().toLowerCase(),
    focus: (opts.focus ?? "").trim().toLowerCase(),
    constraints: (opts.constraints ?? "").trim().toLowerCase(),
    date: opts.date,
    dayContext: `${read.kind}|${read.focus ?? ""}`,
  });
}

function waitForJob(id) {
  return new Promise((resolve, reject) => {
    const off = onJobEvent(id, (event) => {
      if (event.type === "done") {
        off();
        resolve(event.job);
      } else if (event.type === "error" || event.type === "canceled") {
        off();
        reject(new Error(`job ended as ${event.type}`));
      }
    });
    enqueueAgentJob(id);
  });
}

test("cached and completed session suggestions normalize once and prepare without preview drift", async () => {
  const date = "2032-03-07";
  repo.savePlanDay(1, "Normalization anchors", "Contract fixtures", [
    { exercise: "Contract Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 200 },
    { exercise: "Contract Timer", mode: "timed", sets: 2, target_seconds: 60 },
  ]);
  const raw = {
    name: "N".repeat(500),
    focus: "F".repeat(500),
    why: "W".repeat(1000),
    est_minutes: 99_999,
    notes: "Preview-only notes are not part of the durable composition.",
    items: [
      {
        exercise: "Contract Squat",
        sets: 999,
        rep_low: 999,
        rep_high: 999,
        target_weight: 1e12,
        note: "C".repeat(800),
      },
      { exercise: "Contract Timer", sets: 999, target_seconds: 999_999 },
      { exercise: "Very Long Exercise ".repeat(20), sets: 2, rep_low: 8 },
    ],
  };
  const opts = { date, minutes: 45, focus: "normalization" };
  repo.saveAiCache("session_suggest", cacheKey(opts), {
    result: { ok: true, session: raw, agent: "cached", tried: [], agent_status: "ok" },
    chosen_agent: "cached",
    freshForMs: 60_000,
  });

  const cached = await suggestSession("stub", opts);
  assert.equal(cached.ok, true);
  assert.equal(cached.session.name.length, 120);
  assert.equal(cached.session.focus.length, 160);
  assert.equal(cached.session.why.length, 600);
  assert.equal(cached.session.est_minutes, 360);
  assert.equal(Object.hasOwn(cached.session, "notes"), false);
  assert.deepEqual(
    cached.session.items.map(({ exercise, sets, rep_low, rep_high, target_weight, target_seconds, note }) => ({
      exercise,
      sets,
      rep_low,
      rep_high,
      target_weight,
      target_seconds,
      note,
    })),
    [
      {
        exercise: "Contract Squat",
        sets: 20,
        rep_low: 100,
        rep_high: 100,
        target_weight: 220,
        target_seconds: null,
        note: "C".repeat(500),
      },
      {
        exercise: "Contract Timer",
        sets: 20,
        rep_low: null,
        rep_high: null,
        target_weight: null,
        target_seconds: 70,
        note: null,
      },
      {
        exercise: "Very Long Exercise ".repeat(20).replace(/\s+/g, " ").trim().slice(0, 120),
        sets: 2,
        rep_low: 8,
        rep_high: null,
        target_weight: null,
        target_seconds: null,
        note: null,
      },
    ]
  );

  const queued = repo.createAgentJob({ kind: "session_suggest", input: opts, agent: "stub" });
  const done = await waitForJob(queued.id);
  assert.deepEqual(done.result.session, cached.session, "canonical result_json stores the normalized preview");
  assert.equal(done.result.session_normalization, "daily_session_v1");

  // A post-preview training datum changes the current safety baseline. The
  // server-owned normalization marker prevents a second clamp from silently
  // rewriting the already-reviewed canonical session at prepare time.
  repo.logSetByName({
    date: "2032-03-01",
    exercise: "Contract Squat",
    weight: 100,
    reps: 5,
    day_number: null,
  });

  const prepared = repo.prepareDailySession({ date, source: "agent_suggest", agent_job_id: queued.id });
  assert.equal(prepared.daily_session.title, done.result.session.name);
  assert.equal(prepared.daily_session.focus, done.result.session.focus);
  assert.equal(prepared.daily_session.why, done.result.session.why);
  assert.equal(prepared.daily_session.est_minutes, done.result.session.est_minutes);
  assert.deepEqual(
    prepared.daily_session.items,
    done.result.session.items,
    "prepare revalidation is idempotent and does not rewrite the actionable preview"
  );
});
