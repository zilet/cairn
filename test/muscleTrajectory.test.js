// Per-muscle-group advance/stall trajectory + the strength test-week cadence
// (src/repo/muscle-trajectory.ts) — the strength brain lifted to the athlete's
// mental model. These lock the reads it must get right: a climbing group reads
// 'advancing', a stuck-and-grinding group reads 'stalling' with a MENU of
// same-pattern variations to rotate in; the test-week cadence fires off a stale
// stamp and names the benchmark key lifts; and — constitution — nothing leaks a
// 0-100 score.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/"score"/.test(json), `${label}: no bare score field`);
};

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "exercises",
    "activities",
    "garmin_activities",
    "garmin_sources",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "checkins",
    "context_events",
    "program_blocks",
    "app_state",
    "profile"
  );
  repo.setProfile({ primary_discipline: "strength", age: 40, sex: "male", weight_lb: 180 });
});

// ── muscleGroupTrajectory ─────────────────────────────────────────────────────

test("muscleGroupTrajectory yields per-group verdicts — a climbing group advances, a stuck one stalls", () => {
  // Quads climbing (Back Squat est-1RM rising) → advancing.
  const sq = [225, 235, 245, 255, 265];
  [28, 21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: sq[i], reps: 5, rir: 2, date: back(d) }));
  // Chest stuck and grinding (Bench Press flat at RIR 0-1) → plateaued → stalling.
  [28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));

  const t = repo.muscleGroupTrajectory(REF);
  assert.equal(t.available, true);
  assert.ok(typeof t.headline === "string" && t.headline.length > 0, "a plain-words headline");

  const quads = t.groups.find((g) => g.group === "quads");
  assert.ok(quads, "quads are read");
  assert.equal(quads.verdict, "advancing");
  assert.equal(quads.lead_lift, "Back Squat");

  const chest = t.groups.find((g) => g.group === "chest");
  assert.ok(chest, "chest is read");
  assert.equal(chest.verdict, "stalling");
  assert.equal(chest.lead_lift, "Bench Press");
  assert.ok(chest.stalled_signal && chest.stalled_signal.length > 0, "names the stall tell");

  NO_SCORE(t, "muscleGroupTrajectory");
});

test("a stalled group offers a MENU of same-pattern vary options to break the plateau", () => {
  [35, 28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  const chest = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.ok(chest, "chest is read");
  assert.equal(chest.verdict, "stalling");
  assert.ok(chest.vary_options.length >= 2, "a menu (not one forced swap) of same-pattern options");
  assert.ok(chest.vary_options.every((o) => o.name && o.why), "each option names a movement + why it helps");
});

test("vary options never offer a movement already on the plan — variety means something NEW", () => {
  [35, 28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  // Baseline: the menu includes DB Bench Press for a stalled bench.
  const before = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.ok(before.vary_options.some((o) => /db bench press/i.test(o.name)), "DB Bench Press is a natural option when un-programmed");
  // Program it → it must drop out of the menu ("rotate in what you already have" is a dead suggestion).
  repo.savePlanDay(2, "Push", "Push", [{ exercise: "DB Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 70 }]);
  const after = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.equal(after.verdict, "stalling");
  assert.ok(!after.vary_options.some((o) => /db bench press/i.test(o.name)), "an already-programmed movement is excluded");
});

test("vary options also exclude a lift the brain just rotated OUT — never offer it straight back", () => {
  [35, 28, 21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 1, date: back(d) }));
  // Baseline (no rotations): DB Bench Press is a natural same-pattern option.
  const baseline = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  assert.ok(baseline.vary_options.some((o) => /db bench press/i.test(o.name)), "DB Bench Press is a natural option");
  // Inject a recent rotation OUT of DB Bench Press — it must drop from the menu
  // (offering it back would undo the rotation the coach just made).
  const injected = repo
    .muscleGroupTrajectory(REF, { recentRotations: [{ from: "DB Bench Press" }] })
    .groups.find((g) => g.group === "chest");
  assert.equal(injected.verdict, "stalling");
  assert.ok(!injected.vary_options.some((o) => /db bench press/i.test(o.name)), "a just-rotated-out lift is excluded");
});

test("muscleGroupTrajectory is quiet when nothing is logged", () => {
  const t = repo.muscleGroupTrajectory(REF);
  assert.equal(t.available, false);
  assert.deepEqual(t.groups, []);
});

// ── testWeekDue ───────────────────────────────────────────────────────────────

test("testWeekDue fires due off a stale last-test-week stamp and names the benchmark key lifts", () => {
  // Two benchmark compounds with real history (≥3 sessions, an est-1RM each) but
  // FLAT recent loads — no new PRs, so the logged data reads as NO de-facto test
  // week and the stale cadence stamp is what drives the read (not the self-heal).
  [21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Back Squat", weight: 315, reps: 3, rir: 2, date: back(d) }));
  [21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Deadlift", weight: 405, reps: 3, rir: 2, date: back(d) }));
  // Last test week ~9 weeks ago → past the ~7-week cadence.
  repo.setAppState("last_test_week", back(63));

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, true, "a test week is due past the cadence");
  assert.ok(/weeks/i.test(tw.why), "the why frames the cadence in plain words");
  assert.ok(tw.key_lifts.length > 0, "names the benchmark lifts worth re-testing");
  assert.ok(tw.key_lifts.some((l) => /squat|deadlift/i.test(l)), "leads with benchmark compounds");
  assert.equal(tw.last_test_week, back(63), "carries the read-only last-test-week stamp");
  NO_SCORE(tw, "testWeekDue");
});

test("testWeekDue is NOT due shortly after a test week", () => {
  [21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  repo.setAppState("last_test_week", back(7)); // a week ago → well inside the cadence
  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, false, "not nagged a week after the last test");
});

test("testWeekDue stays quiet for an athlete with no benchmark history", () => {
  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, false);
  assert.deepEqual(tw.key_lifts, []);
});

// ── K5 cadence: testWeekDue DEFERS to the attention engine (rule 2a) ───────────
// The recurring re-test is no longer a fixed 49-day interval. Once the K5 benchmark-
// attention pass runs, testWeekDue reads the tier machine: a cleanly-progressing
// athlete's test-week signal RELEASES → no scheduled test even when the old fixed
// cadence would fire; a plateau keeps it active and it fires when the window arrives.

test("a cleanly-progressing athlete converges to NO scheduled test week — a released K5 entry overrides the fixed cadence", () => {
  // Real benchmark history so key_lifts is non-empty (reaches the cadence branch).
  [21, 14, 7, 0].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 315 + i * 5, reps: 3, rir: 2, date: back(d) }));
  // A stale stamp that the OLD fixed cadence would treat as due (~9 weeks).
  repo.setAppState("last_test_week", back(63));

  // The benchmark-attention pass on a clean, progressing lift releases the test-week signal.
  repo.refreshTrainingBenchmarkAttention(REF, {
    programState: {
      generated_for: REF, discipline: "strength",
      lifts: [{ exercise: "Back Squat", muscle_group: "legs", mode: "reps", sessions: 6, est_1rm: 335, best_seconds: null, trend_per_wk: 4, status: "progressing", stall_signals: [], weeks_static: null, suggested_action: "overload", why: "Climbing." }],
      volume: [], mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" }, endurance: null, hybrid: null, headline: "", adaptations_due: [],
    },
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: back(63) },
    enduranceTests: [],
  });
  const attn = repo.getAttentionSchedule("training:strength:test-week");
  assert.equal(attn?.tier, "released", "clean progress releases the test-week signal");

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.due, false, "a released K5 entry overrides the fixed 49-day cadence — no forced test");
});

test("a plateau keeps the test week scheduled through K5 — due when the response window arrives", () => {
  [21, 14, 7, 0].forEach((d) => repo.logSetByName({ exercise: "Bench Press", weight: 205, reps: 3, rir: 1, date: back(d) }));
  repo.setAppState("last_test_week", back(30)); // inside the old fixed cadence — the fixed path would NOT fire

  const plateaued = {
    generated_for: REF, discipline: "strength",
    lifts: [{ exercise: "Bench Press", muscle_group: "chest", mode: "reps", sessions: 6, est_1rm: 205, best_seconds: null, trend_per_wk: 0, status: "plateaued", stall_signals: ["same top load"], weeks_static: 4, suggested_action: "vary", why: "Flat." }],
    volume: [], mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" }, endurance: null, hybrid: null, headline: "", adaptations_due: [],
  };
  repo.refreshTrainingBenchmarkAttention(REF, { programState: plateaued, testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: back(30) }, enduranceTests: [] });
  const attn = repo.getAttentionSchedule("training:strength:test-week");
  assert.equal(attn?.tier, "active", "a plateau activates the test-week signal");

  // Before the response window → not yet due (a scheduled, not fixed, check).
  assert.equal(repo.testWeekDue(REF, { programState: plateaued }).due, false, "scheduled, not immediate");
  // Once next_due arrives → due.
  const arrived = new Date(new Date(attn.next_due + "T00:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
  assert.equal(repo.testWeekDue(arrived, { programState: plateaued }).due, true, "fires when the scheduled window arrives");
});

// ── recordTestWeek (the writer that closes the loop) ──────────────────────────

test("recordTestWeek stamps the cadence date and is MONOTONIC — it never moves backwards", () => {
  const today = localDateISO();

  assert.equal(repo.recordTestWeek(back(60)), back(60), "returns the effective stamp");
  assert.equal(repo.getAppState("last_test_week"), back(60), "the stamp is written");

  // An OLDER date is ignored — the loop can't rewind onto a stale test week.
  assert.equal(repo.recordTestWeek(back(90)), back(60), "an older date is a no-op");
  assert.equal(repo.getAppState("last_test_week"), back(60));

  // A NEWER date advances the stamp.
  assert.equal(repo.recordTestWeek(back(10)), back(10), "a newer date advances");
  assert.equal(repo.getAppState("last_test_week"), back(10));

  // No arg stamps today (today > back(10)), and today's stamp holds.
  assert.equal(repo.recordTestWeek(), today, "no-arg stamps today");
  assert.equal(repo.getAppState("last_test_week"), today);
});

// ── testWeekDue read-time self-heal (data-driven de-facto test week) ───────────

test("testWeekDue self-heals the stamp from a de-facto test week — PRs on ≥2 key lifts inside a week close the loop", () => {
  // A stale (or missing) stamp would normally read "due"...
  repo.setAppState("last_test_week", back(63));
  // ...but the logged history shows new est-1RM maxes landing on TWO benchmark
  // lifts within the same week (Back Squat back(2), Deadlift back(0)) — a de-facto
  // test week. Each lift has ≥3 sessions with a rising top set.
  [30, 16, 2].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  [30, 14, 0].forEach((d, i) => repo.logSetByName({ exercise: "Deadlift", weight: 400 + i * 10, reps: 3, rir: 2, date: back(d) }));

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.last_test_week, back(0), "the stamp self-heals to the window's most recent PR date");
  assert.equal(repo.getAppState("last_test_week"), back(0), "and it's persisted");
  assert.equal(tw.due, false, "no nag right after a de-facto test week");
});

test("testWeekDue does NOT self-heal off a SINGLE lift PRing — a de-facto test week needs ≥2 lifts", () => {
  repo.setAppState("last_test_week", back(63));
  // Only Back Squat sets new maxes; Deadlift is flat (a real key lift, but no PRs).
  [30, 16, 2].forEach((d, i) => repo.logSetByName({ exercise: "Back Squat", weight: 300 + i * 10, reps: 3, rir: 2, date: back(d) }));
  [21, 14, 0].forEach((d) => repo.logSetByName({ exercise: "Deadlift", weight: 405, reps: 3, rir: 2, date: back(d) }));

  const tw = repo.testWeekDue(REF);
  assert.equal(tw.last_test_week, back(63), "one lift climbing is normal overload, not a test week");
  assert.equal(repo.getAppState("last_test_week"), back(63), "the stale stamp is untouched");
  assert.equal(tw.due, true, "the cadence is still due off the stale stamp");
});
