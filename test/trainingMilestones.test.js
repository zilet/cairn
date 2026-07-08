import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

const REF = "2026-06-01";

const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/"score"/.test(json), `${label}: no bare score field`);
};

beforeEach(() => {
  resetTables("attention_schedule");
});

test("strengthBenchmarkMilestones turns standard next-rungs into concrete suggestions, not gates", () => {
  const out = repo.strengthBenchmarkMilestones([
    {
      key: "bench",
      label: "Bench press",
      exercise: "Bench Press",
      est_1rm: 205,
      level: "intermediate",
      to_next: { level: "advanced", lb: 20 },
    },
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Bench press to advanced");
  assert.equal(out[0].target, "225 lb estimated 1RM");
  assert.match(out[0].why, /direction of travel, not a gate/i);
  assert.equal(out[0].suggested_test, "Heavy triple or clean top set on Bench Press");
  NO_SCORE(out, "strengthBenchmarkMilestones");
});

test("benchmarkMilestoneCandidates includes endurance benchmarks alongside strength rungs", () => {
  const out = repo.benchmarkMilestoneCandidates({
    capacities: [
      {
        key: "squat",
        label: "Squat",
        exercise: "Back Squat",
        est_1rm: 285,
        level: "novice",
        to_next: { level: "intermediate", lb: 35 },
      },
    ],
    endurance: { vo2max: 38, percentile: 35, tone: "watch", headline: "VO2max 38" },
    enduranceTests: [{ exercise: "1-mile or 5k time-trial", why: "Stale hard effort." }],
  });

  assert.ok(out.find((m) => m.kind === "strength-standard" && /Squat/.test(m.title)));
  assert.ok(out.find((m) => m.kind === "endurance-benchmark" && /time-trial/i.test(m.title)));
  assert.ok(out.find((m) => m.kind === "endurance-benchmark" && /VO2max/.test(m.title)));
  NO_SCORE(out, "benchmarkMilestoneCandidates");
});

test("refreshTrainingBenchmarkAttention activates on plateau, then confirms, surveils, and releases on clean progress", () => {
  const active = repo.refreshTrainingBenchmarkAttention(REF, {
    programState: {
      generated_for: REF,
      discipline: "strength",
      lifts: [
        {
          exercise: "Bench Press",
          muscle_group: "chest",
          mode: "reps",
          sessions: 6,
          est_1rm: 205,
          best_seconds: null,
          trend_per_wk: 0,
          status: "plateaued",
          stall_signals: ["same top load 4 sessions running"],
          weeks_static: 4,
          suggested_action: "vary",
          why: "Flat.",
        },
      ],
      volume: [],
      mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" },
      endurance: null,
      hybrid: null,
      headline: "",
      adaptations_due: [],
    },
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [],
  });
  const benchActive = active.find((e) => e.signal_key === "training:strength:bench-press");
  assert.equal(benchActive?.tier, "active");
  assert.equal(benchActive?.next_due, "2026-06-15");
  assert.match(benchActive?.reason ?? "", /plateaued/i);
  assert.ok(benchActive?.release_condition);

  const cleanLift = {
    ...activeProgramLift("Bench Press"),
    status: "progressing",
    suggested_action: "overload",
  };
  const confirming = repo.refreshTrainingBenchmarkAttention("2026-06-15", {
    programState: programStateWithLift(cleanLift),
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [],
  }).find((e) => e.signal_key === "training:strength:bench-press");
  assert.equal(confirming?.tier, "confirming");
  assert.equal(confirming?.next_due, "2026-07-06");

  const surveillance = repo.refreshTrainingBenchmarkAttention("2026-07-06", {
    programState: programStateWithLift(cleanLift),
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [],
  }).find((e) => e.signal_key === "training:strength:bench-press");
  assert.equal(surveillance?.tier, "surveillance");

  const released = repo.refreshTrainingBenchmarkAttention("2026-08-17", {
    programState: programStateWithLift(cleanLift),
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [],
  }).find((e) => e.signal_key === "training:strength:bench-press");
  assert.equal(released?.tier, "released");
  assert.equal(released?.next_due, null);
  assert.match(released?.reason ?? "", /progressing cleanly|fixed re-test cadence/i);
});

test("clean progress with no previous benchmark attention releases instead of scheduling a fixed test", () => {
  const entries = repo.refreshTrainingBenchmarkAttention(REF, {
    programState: programStateWithLift(activeProgramLift("Back Squat")),
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [],
  });
  const squat = entries.find((e) => e.signal_key === "training:strength:back-squat");
  assert.equal(squat?.tier, "released");
  assert.equal(squat?.next_due, null);
  assert.match(squat?.release_condition ?? "", /no fixed 1RM cadence/i);
});

test("endurance benchmark attention activates when a test is due and confirms after clean running", () => {
  const active = repo.refreshTrainingBenchmarkAttention(REF, {
    programState: { ...programStateWithLift(activeProgramLift("Back Squat")), endurance: { status: "maintaining", suggested_action: "hold", pace_trend: "stable" } },
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [{ exercise: "1-mile or 5k time-trial", kind: "endurance", why: "Stale hard effort." }],
  }).find((e) => e.signal_key === "training:endurance:benchmark");
  assert.equal(active?.tier, "active");
  assert.equal(active?.next_due, "2026-06-22");
  assert.match(active?.reason ?? "", /endurance benchmark is due/i);

  const confirming = repo.refreshTrainingBenchmarkAttention("2026-06-22", {
    programState: { ...programStateWithLift(activeProgramLift("Back Squat")), endurance: { status: "building", suggested_action: "build", pace_trend: "stable" } },
    testWeek: { due: false, why: "", key_lifts: [], cadence_weeks: 0, last_test_week: null },
    enduranceTests: [],
  }).find((e) => e.signal_key === "training:endurance:benchmark");
  assert.equal(confirming?.tier, "confirming");
  assert.equal(confirming?.next_due, "2026-07-20");
});

function activeProgramLift(exercise) {
  return {
    exercise,
    muscle_group: "legs",
    mode: "reps",
    sessions: 6,
    est_1rm: 250,
    best_seconds: null,
    trend_per_wk: 3,
    status: "progressing",
    stall_signals: [],
    weeks_static: null,
    suggested_action: "overload",
    why: "Climbing.",
  };
}

function programStateWithLift(lift) {
  return {
    generated_for: REF,
    discipline: "strength",
    lifts: [lift],
    volume: [],
    mesocycle: { weeks_since_deload: null, phase: null, acute_chronic_ratio: null, note: "" },
    endurance: null,
    hybrid: null,
    headline: "",
    adaptations_due: [],
  };
}
