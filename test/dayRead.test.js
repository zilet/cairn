// dayRead (src/repo.ts) is the deterministic floor under the Brief. The
// constitution says it SUGGESTS, never gates — these cases pin the three reads
// and the two protect-recovery triggers (earned rest, clearly-low recovery).
// dayRead(date, recovery) takes an explicit recovery object, letting us drive the
// low-sleep branch without coupling to wall-clock "now".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedTrainingDay, seedRecoveryDay, isoDaysAgo } from "./_seed.js";

// A reference date well clear of the recovery window so an empty recovery fetch
// can't accidentally flip the read.
const REF = "2026-03-15";
const dayBefore = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "session_skips",
    "plan_items",
    "plan_days",
    "checkins",
    "daily_metrics",
    "activities",
    "context_events"
  );
});

test("REST on >=3 consecutive training days ending the day before", () => {
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.match(r.why, /several days running/i);
});

test("does NOT force rest on only 2 consecutive training days", () => {
  for (let i = 1; i <= 2; i++) seedTrainingDay(dayBefore(REF, i));
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 2);
});

test("an active dated obligation compresses a train day without changing its posture", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "family_event",
    title: "School pickup and evening event",
    start_date: REF,
    end_date: REF,
  });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.est_minutes, 40);
  assert.equal(r.signals.signal_state.action.posture, "train");
  assert.equal(r.signals.signal_state.action.directives.schedule, "compress");
  assert.deepEqual(r.signals.schedule, {
    directive: "compress",
    compressed: true,
    original_est_minutes: 60,
    est_minutes: 40,
    reason: "School pickup and evening event adds schedule pressure today.",
  });
  assert.match(r.why, /dated commitment compresses today's training window/i);
});

test("poor recovery owns an injury-overlap day while the movement work-around survives", () => {
  repo.savePlanDay(1, "Upper", "Upper body", [{ exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "injury",
    title: "Shoulder strain",
    detail: "Overhead loading aggravates it",
    start_date: REF,
  });

  const r = repo.dayRead(REF, {
    has_data: true,
    recovery: { training_readiness: 20, avg_training_readiness: 50 },
    quality: {
      training_readiness: { latest_date: REF, source: "garmin", freshness: "fresh", sample_count: 1 },
    },
  });
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.signal_state.action.posture, "easy");
  assert.equal(r.signals.signal_state.action.directives.training, "recover");
  assert.equal(r.signals.health_workaround.field, "active_injury");
  assert.match(r.why, /pain-free around the active injury/i);
  assert.match(r.why, /shoulder/i);
});

test("REST on clearly-low recovery (short average sleep) even when due", () => {
  // A plan day exists and there's no consecutive-training streak — but low sleep
  // overrides into rest. Pass recovery explicitly so the branch is deterministic.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 300 } }); // 5h
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.low_sleep, true);
  assert.match(r.why, /sleep/i);
});

test("low subjective check-in (low energy) forces REST", () => {
  // checkin is read by date inside dayRead (getCheckinByDate(d)); seed it on REF.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  repo.addCheckin(REF, { energy: 1, sleep_feel: 2, mood: 2, soreness: 4 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.match(r.why, /run-down|rest is the smart call/i);
});

test("TRAIN when recovered, due, and a plan day exists", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
  assert.equal(typeof r.est_minutes, "number");
});

test("EASY when nothing is programmed and recovery is unremarkable", () => {
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.match(r.why, /nothing programmed/i);
});

test("EASY after a LIGHT activity is already logged today", () => {
  // A short easy outing (a 25-min stroll — below the hard-cardio bar) reads as
  // 'covered', not a fresh session, but stays easy: it isn't real loading work.
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.match(r.why, /already/i);
});

// ── PART 2: a genuinely HARD cardio day counts REGARDLESS of discipline ──────────
test("a HARD cardio day (40+ min run) reads DONE for a strength-primary athlete", () => {
  // A strength-primary lifter's genuinely hard run is real work: it reads DONE (a
  // solid run in, recover the rest of the day), not a fresh session and not merely
  // "keep it easy". Cardio is no longer invisible just because the discipline is strength.
  repo.setProfile({ primary_discipline: "strength" });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 48, 9)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
  assert.equal(r.signals.today_load !== "none" && r.signals.today_load !== "easy", true, "hard cardio grades as loading");
});

test("hard cardio stacks toward earned rest REGARDLESS of discipline", () => {
  // Three straight 45-min runs make a strength-primary athlete's Brief suggest rest,
  // exactly as three straight lifting days would — the streak counts hard cardio.
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 45, 8)`).run(dayBefore(REF, i));
  }
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
});

test("an easy stroll never counts toward the loading streak (negative case)", () => {
  // Short 25-min walks are below every hard-cardio bar, so they break (never build)
  // the loading streak — no forced rest off strolls, no false 'done'.
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(dayBefore(REF, i));
  }
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 0);
});

test("a ~43-min easy hike today does NOT flip a planned-lift day to DONE", () => {
  // Fix round: an easy hike (no wearable data) must not grade as loading — it reads as
  // "covered but easy", never DONE/recover, so it never suppresses the planned session.
  repo.setProfile({ primary_discipline: "strength" });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'hike', 43, 4)`).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "done");
  assert.notEqual(r.kind, "rest");
});

test("prior ~43-min easy hikes do NOT stack toward earned rest (planned lift still suggested)", () => {
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'hike', 43, 4)`).run(dayBefore(REF, i));
  }
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 0, "easy hikes never stack loading days");
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
});

test("DONE (not EASY) when a real loading session is already logged today", () => {
  // A hard session today is a FACT — the read must acknowledge it as DONE, never
  // mislabel it "easy". (This is the bug: a hard push session read "EASY DAY".)
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /recovery/i);
  assert.equal(r.signals.trained_today, true);
});

test("DONE preempts REST: a hard session today wins over 3 prior hard days", () => {
  // The user's exact case — trained hard for days AND already trained again today. A
  // "Rest today" read would contradict the work already in (and the session sitting
  // below it). The day must read DONE (debrief), never tell them to rest after they've
  // already loaded. This is the done-before-earned-rest ordering.
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
});

test("DONE 'why' names the session (not the run) when both land today", () => {
  // A lift + a run on the same day must not let the run's label erase the strength work
  // in the deterministic floor's why-line.
  seedTrainingDay(REF);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 40, 6)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /solid session/i);
});

test("stale sleep is NOT treated as last night (no fabricated sleep read)", () => {
  // A wearable can stop syncing sleep for weeks; a ~month-old night is NOT last night.
  // dayRead must surface it as ABSENT so the Brief never asserts "you slept fine".
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 25));
  const stale = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(stale.signals.last_night, null);
  // A recent night (yesterday) IS surfaced as last night.
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 1));
  const fresh = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.ok(fresh.signals.last_night && fresh.signals.last_night.total_min === 440);
});

test("EASY (not DONE) when today's logged work was only light", () => {
  // A short mobility/recovery session graded 'easy' is NOT a completed training
  // day — keep it 'easy' (they may still want their real work), never 'done'.
  seedRecoveryDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
});

test("forwardLook points to the NEXT session's focus (the day-ahead heads-up)", () => {
  repo.savePlanDay(1, "Push", "Chest & shoulders", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  repo.savePlanDay(2, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 225 },
  ]);
  // Trained Push (plan day 1) the day before REF → the forward look is plan day 2.
  const ex = repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  const day1Id = repo.getPlanDay(1).id; // the real plan_days row id (autoincrement varies in the shared DB)
  const sess = repo.getOrCreateSession(dayBefore(REF, 1), day1Id);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 135, 6, 2)`
  ).run(sess.id, ex.id);
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, "Lower body");
  assert.match(fl.text, /Lower body/);
});

test("forwardLook is null-safe with no plan (degrades, never throws)", () => {
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, null);
  assert.equal(fl.text, null);
});

test("absent signals never throw and never force rest (graceful degradation)", () => {
  // No recovery, no check-in, no sessions, no plan — must return a calm 'easy'.
  const r = repo.dayRead(isoDaysAgo(0));
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.consecutive_training_days, 0);
});

test("enforceCompletionContract clamps completion facts in BOTH directions", async () => {
  const { enforceCompletionContract } = await import("../dist/dayread.js");

  // Agent claims "done" on a day the server says is not done → deterministic floor.
  const trainBaseline = { kind: "train", focus: "Lower body", why: "Recovered and due.", est_minutes: 60, signals: {} };
  const falseDone = enforceCompletionContract(
    {
      kind: "done",
      headline: "You're done.",
      why: "Great work!",
      focus: null,
      est_minutes: null,
      source: "agent",
      agent: "claude",
    },
    trainBaseline
  );
  assert.equal(falseDone.kind, "train", "an agent can never mark an untrained day done");
  assert.equal(falseDone.source, "deterministic");
  assert.equal(falseDone.agent, "claude", "provenance survives the clamp");

  // Agent downgrades a genuinely-done day → forced back to done, prospective residue stripped.
  const doneBaseline = { kind: "done", focus: null, why: "Solid run in.", est_minutes: null, signals: {} };
  const downgraded = enforceCompletionContract(
    { kind: "easy", headline: "Take it easy.", why: "Light day.", focus: "Easy", est_minutes: 30, source: "agent" },
    doneBaseline
  );
  assert.equal(downgraded.kind, "done");
  assert.equal(downgraded.focus, null);
  assert.equal(downgraded.est_minutes, null);

  // Agent voices done correctly → its warm prose survives, residue still nulled.
  const voiced = enforceCompletionContract(
    {
      kind: "done",
      headline: "Strong push session.",
      why: "The work is in — refuel well.",
      focus: "Push",
      est_minutes: 60,
      source: "agent",
    },
    doneBaseline
  );
  assert.equal(voiced.kind, "done");
  assert.equal(voiced.headline, "Strong push session.");
  assert.equal(voiced.focus, null);
  assert.equal(voiced.est_minutes, null);
});

test("agentic day-read posture cannot become more aggressive without an athlete override", async () => {
  const { enforceDayReadSafetyPosture, enforceCompletionContract } = await import("../dist/dayread.js");
  const restBaseline = {
    kind: "rest",
    focus: null,
    why: "Recovery signals say rest is the smart call.",
    est_minutes: null,
    signals: { low_sleep: true },
  };
  const aggressive = {
    kind: "train",
    headline: "Push hard today.",
    why: "The plan says legs.",
    focus: "Lower body",
    est_minutes: 60,
    signals: restBaseline.signals,
    source: "agent",
    agent: "claude",
    tried: ["claude"],
  };
  const clamped = enforceDayReadSafetyPosture(aggressive, restBaseline, false);
  assert.equal(clamped.kind, "rest");
  assert.equal(clamped.headline, "Rest today.");
  assert.equal(clamped.why, restBaseline.why, "clamped prose must match the deterministic posture");
  assert.equal(clamped.focus, null);
  assert.equal(clamped.est_minutes, null);
  assert.equal(clamped.source, "deterministic");
  assert.equal(clamped.agent, "claude", "agent provenance survives the policy clamp");

  const easyBaseline = {
    kind: "easy",
    focus: "Easy movement",
    why: "Nothing programmed today.",
    est_minutes: 30,
    signals: {},
  };
  assert.equal(enforceDayReadSafetyPosture(aggressive, easyBaseline, false).kind, "easy");

  const conservative = { ...aggressive, kind: "rest", headline: "Rest today.", why: "Take the recovery." };
  assert.equal(
    enforceDayReadSafetyPosture(conservative, { ...easyBaseline, kind: "train" }, false),
    conservative,
    "the agent may always become more conservative"
  );

  assert.equal(
    enforceDayReadSafetyPosture(aggressive, restBaseline, true),
    aggressive,
    "an explicit athlete override preserves the bounded agent recommendation"
  );
  const falseDone = { ...aggressive, kind: "done", headline: "All done." };
  const overrideStillNotDone = enforceCompletionContract(
    enforceDayReadSafetyPosture(falseDone, restBaseline, true),
    restBaseline
  );
  assert.equal(overrideStillNotDone.kind, "rest", "completion remains non-negotiable under an override");
});

test("Today agent-result validation rejects parseable off-contract JSON", async () => {
  const { isValidDayReadAgentResult } = await import("../dist/dayread.js");

  assert.equal(isValidDayReadAgentResult({ kind: "rest", why: "Three loading days in a row." }), true);
  assert.equal(isValidDayReadAgentResult({ summary: "Rest today" }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "rest", why: "" }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "pause", why: "Take it easy." }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "easy", why: "Keep it light.", est_minutes: "soon" }), false);
  assert.equal(
    isValidDayReadAgentResult({ kind: "done", why: "Your walk is in." }, { kind: "rest" }),
    false,
    "an easy activity cannot be promoted to completed training by the prose layer"
  );
  assert.equal(
    isValidDayReadAgentResult({ kind: "rest", why: "Recover." }, { kind: "done" }),
    false,
    "a completed training fact cannot be downgraded by the prose layer"
  );
  assert.equal(isValidDayReadAgentResult({ kind: "done", why: "Session logged." }, { kind: "done" }), true);
});

test("completed-load prose consistency rejects understatement but permits future easy advice", async () => {
  const { dayReadProseConsistencyIssue, isValidDayReadAgentResult } = await import("../dist/dayread.js");
  const baseline = {
    kind: "done",
    signals: { trained_today: true, today_load: "moderate" },
  };
  const contradiction = {
    kind: "done",
    headline: "Run complete.",
    why: "That run keeps your easy rhythm ticking along.",
  };
  const futureEasy = {
    kind: "done",
    headline: "Tempo work complete.",
    why: "That run was a solid moderate effort. Keep tomorrow's run easy so it can settle.",
  };

  assert.deepEqual(dayReadProseConsistencyIssue(contradiction, baseline.signals), {
    code: "completed_load_understated",
    classified_load: "moderate",
    evidence: contradiction.why,
  });
  assert.equal(isValidDayReadAgentResult(contradiction, baseline), false);
  assert.equal(dayReadProseConsistencyIssue(futureEasy, baseline.signals), null);
  assert.equal(isValidDayReadAgentResult(futureEasy, baseline), true);
});
