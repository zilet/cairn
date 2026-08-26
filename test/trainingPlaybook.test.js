// Training playbook: deterministic plateau/adherence suggestions only. These
// tests lock that the read distinguishes the plateau type, returns action
// ladders, and proposes a smaller template when the logged pattern says the
// current one is not landing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

const REF = "2026-04-20";
const back = (n) => new Date(new Date(REF + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables("logged_sets", "session_skips", "sessions", "activities", "plan_items", "plan_days", "exercises", "profile");
});

test("playbook distinguishes strength, endurance, mono-stimulus, and hybrid interference", () => {
  const read = repo.trainingPlaybook(REF, {
    programState: {
      lifts: [{
        exercise: "Overhead Press",
        muscle_group: "shoulders",
        status: "plateaued",
        suggested_action: "vary",
        sessions: 6,
        weeks_static: 4,
        stall_signals: ["same top load 5 sessions running"],
      }],
      endurance: {
        pace_trend: "declining",
        status: "maintaining",
        suggested_action: "add-quality",
        has_quality: false,
        why: "all easy pace and pace is drifting",
      },
      hybrid: {
        status: "shift-legs",
        headline: "A long run loaded the legs hard.",
        next_strength: { advice: "swap-or-upper", day_name: "Lower", why: "Quads overlap the long run." },
      },
    },
  });

  const kinds = read.plateau_plays.map((p) => p.kind);
  assert.deepEqual(kinds, ["strength_plateau", "hybrid_interference", "endurance_plateau", "mono_stimulus"]);
  assert.ok(read.plateau_plays.every((p) => p.adaptations.length >= 1 && p.adaptations.length <= 3));
  assert.match(read.plateau_plays.find((p) => p.kind === "strength_plateau").adaptations.join(" "), /variation|technique|load/i);
  assert.match(read.plateau_plays.find((p) => p.kind === "mono_stimulus").adaptations.join(" "), /intervals|tempo|hills/i);
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(JSON.stringify(read)), "no 0-100 score leaks");
});

test("adherence read proposes fewer or shorter sessions when planned days keep missing", () => {
  repo.savePlanDay(1, "Upper", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }]);
  repo.savePlanDay(3, "Pull", "Pull", [{ exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 90 }]);
  repo.savePlanDay(5, "Lower", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 }]);

  // Mondays land. Wednesdays land once. Fridays repeatedly become skip-only or
  // absent days, which should suggest restructuring rather than blaming effort.
  for (const d of [21, 14, 7, 0]) repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: back(d) });
  repo.logSetByName({ exercise: "Cable Row", weight: 90, reps: 10, date: back(12) });
  repo.skipExercise("Back Squat", back(17));
  repo.skipExercise("Back Squat", back(10));
  repo.skipExercise("Back Squat", back(3));
  repo.skipExercise("Cable Row", back(5));

  const read = repo.trainingPlaybook(REF);
  assert.ok(read.adherence, "expected adherence restructure read");
  assert.equal(read.adherence.status, "restructure");
  assert.match(read.adherence.pattern, /Lower|Planned training days|skipped/i);
  assert.match(read.adherence.adaptations.join(" "), /Reduce|Shorten|Move|split/i);
  assert.match(read.headline, /adherence fit/i);
});

test("adherence denominator ignores cardio-only plan days so a 4-lift week is not a restructure", () => {
  // Five lift days + two dedicated run days (kind:'cardio' plan_items — the
  // extra rows setWeeklyRuns writes). Runs logged as activities never create
  // a session, so counting those days as expected strength sessions made a
  // normal 4-session week read "restructure".
  repo.savePlanDay(1, "Upper", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }]);
  repo.savePlanDay(2, "Pull", "Pull", [{ exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 90 }]);
  repo.savePlanDay(3, "Lower", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 }]);
  repo.savePlanDay(4, "Push 2", "Push", [{ exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 95 }]);
  repo.savePlanDay(5, "Hinge", "Hinge", [{ exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 }]);
  repo.savePlanDay(6, "Easy run", "Endurance", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 8, target_zone: "Z2" }]);
  repo.savePlanDay(7, "Long run", "Endurance", [{ kind: "cardio", exercise: "Long run", target_distance_km: 14, target_zone: "Z2" }]);

  // Four lift days land each week (Mon–Thu). Friday and both run days are empty.
  // REF is a Monday; Tues/Wed/Thu of the same week sit AFTER that Monday, so the
  // in-window dates are the weekdays of the prior week (back(6) is the Tuesday
  // before REF, etc.).
  for (const monday of [21, 14, 7, 0]) {
    repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 5, date: back(monday) });
    repo.logSetByName({ exercise: "Cable Row", weight: 90, reps: 8, date: back(monday + 6) });
    repo.logSetByName({ exercise: "Back Squat", weight: 185, reps: 5, date: back(monday + 5) });
    repo.logSetByName({ exercise: "Overhead Press", weight: 95, reps: 5, date: back(monday + 4) });
  }

  const read = repo.trainingPlaybook(REF);
  assert.notEqual(read.adherence?.status, "restructure", "cardio-only days are not missed strength sessions");
});

test("a cardio-only plan still produces an adherence read", () => {
  repo.savePlanDay(1, "Easy run", "Endurance", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 8, target_zone: "Z2" }]);
  repo.savePlanDay(3, "Tempo", "Endurance", [{ kind: "cardio", exercise: "Tempo", target_distance_km: 6, target_zone: "Z3" }]);
  repo.savePlanDay(5, "Long run", "Endurance", [{ kind: "cardio", exercise: "Long run", target_distance_km: 14, target_zone: "Z2" }]);
  repo.savePlanDay(6, "Recovery spin", "Endurance", [{ kind: "cardio", exercise: "Easy spin", target_distance_km: 20, target_zone: "Z1" }]);

  const read = repo.trainingPlaybook(REF);
  assert.ok(read.adherence, "cardio-only planned days still produce an adherence read");
});

test("program evolution trigger includes playbook and adherence reasons without auto-applying", () => {
  const out = repo.programEvolutionTrigger(REF, {
    programState: { lifts: [] },
    balance: { due: [], over: [] },
    testWeek: { due: false },
    enduranceTests: [],
    trainingPlaybook: {
      generated_for: REF,
      plateau_plays: [{
        kind: "mono_stimulus",
        title: "Mono-stimulus: too much of the same run",
        why: "All one pace.",
        adaptations: ["Swap one steady run for short intervals, tempo, or hills."],
        based_on: ["no quality work"],
      }],
      adherence: {
        status: "restructure",
        window_days: 28,
        planned_sessions: 12,
        completed_sessions: 6,
        missed_planned_sessions: 4,
        skipped_exercises: 5,
        pattern: "Lower is the session most often not landing.",
        adaptations: ["Move or split Lower."],
      },
      adaptations: [],
      headline: "Suggestion only.",
    },
  });

  assert.equal(out.due, true);
  assert.match(out.reasons.join(" "), /Mono-stimulus/);
  assert.match(out.reasons.join(" "), /smaller|shorter template/i);
  assert.match(out.signature, /playbook:mono_stimulus/);
  assert.match(out.signature, /adherence:restructure:4:5/);
});
