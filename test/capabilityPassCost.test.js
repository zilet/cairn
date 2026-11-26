// The capability pass, held to its cost and its isolation:
//   - a bare capabilityRead computes the read ONCE (program state's pass computes it, and
//     the bare read is served that one), and it is the very read program state carries;
//   - the read asks "lighter on purpose?" through one batched reader, and every exposure it
//     sets aside is exactly the one the single read (`exposureLighterOnPurpose`) sets aside;
//   - a plan-day progression pass outside a request reads the plateau ladder at most once,
//     never once per lift;
//   - a partial program state (read while a pass is in flight) is never shared, through the
//     request's brain-snapshot signal, with a finished reader in the same request;
//   - the recovery calendar the read asks once answers exactly as activeRecoveryWeek for
//     every date, with two ledger weeks in the window.
// Synthetic fixtures; deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, repo, resetTables } from "./_seed.js";
import { capabilityRead, recoveryWeekReader } from "../dist/repo/strength-capability.js";
import {
  finishedCapabilityRead,
  getProgramState,
  programStateSignalKey,
  withinCapabilityPassForTest,
} from "../dist/repo/program-state.js";
import { summarizeCapability } from "../dist/repo/capability-consumers.js";
import { exposureLighterOnPurpose } from "../dist/repo/whole-person-trajectory.js";
import { nextPrescription, planDayProgression } from "../dist/repo/progression.js";
import { activeRecoveryWeek } from "../dist/repo/recovery-week.js";
import { RECOVERY_WEEK_INSTRUCTION_PREFIX, stampRecoveryWeekApplied } from "../dist/repo/recovery-week-ledger.js";
import { brainSignal, runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);

// Count db.prepare calls whose SQL matches `pattern` while `fn` runs.
function countPrepares(pattern, fn) {
  const original = db.prepare;
  let count = 0;
  db.prepare = function (sql, ...rest) {
    if (pattern.test(String(sql))) count += 1;
    return original.call(this, sql, ...rest);
  };
  try {
    return { value: fn(), count };
  } finally {
    db.prepare = original;
  }
}

// strength-capability.ts readRows: the one query every computation of the read runs first.
const READ_ROWS = /e\.input_profile AS input_profile[\s\S]*ls\.rir AS rir/;
// unit-plateau.ts ladderChangeRows: the one query every computation of the ladder runs.
const LADDER_ROWS = /FROM plan_proposals p[\s\S]*held_by_user/;

function flatLog(exercise, group, weight, reps = 8, rir = 2) {
  repo.upsertExercise({ name: exercise, muscle_group: group, mode: "reps" });
  for (const d of [42, 35, 28, 21, 14, 7, 3])
    for (let n = 1; n <= 3; n++) repo.logSetByName({ exercise, weight, reps, rir, date: day(-d), set_number: n });
}

test("a bare capability read computes the read once, and it is the read program state carries", () => {
  flatLog("Back Squat", "quads", 275, 5);
  flatLog("Bench Press", "chest", 185, 5);
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 275 },
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const { value: read, count } = countPrepares(READ_ROWS, () => capabilityRead(today()));
  assert.equal(read.available, true);
  assert.equal(count, 1, `the read's log query ran ${count} times for one bare read`);
  // Served from the pass: identical to what program state was finished with.
  assert.deepEqual(read, finishedCapabilityRead(today()));
  assert.deepEqual(summarizeCapability(read), getProgramState(today()).capability);
});

function carded(sessionId, date, exercise, { card, prior, top, verdict = "met" }) {
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Card fixture', '[]', ?)`
    )
    .run(sessionId, date, `card-${sessionId}-${Math.random()}`);
  const facts = {
    schema_version: 4,
    skipped: [],
    dose_context: { comparable: true, non_comparable_reasons: [] },
    dose_evidence: [
      {
        movement_key: `exercise:${exercise.id}`,
        exercise: exercise.name,
        mode: "reps",
        prescribed: { sets: 3, rep_low: 5, rep_high: 5, target_weight: card, target_seconds: null },
        achieved: { sets: 3, top_weight: top, top_reps: 5, top_seconds: null },
        full_load_reference: {
          sets: null,
          target_weight: null,
          target_seconds: null,
          rep_low: null,
          recent_working_weight: prior,
          recent_working_seconds: null,
        },
        performed_at_full_load: false,
        challenge_verdict: verdict,
        comparable: true,
        non_comparable_reasons: [],
      },
    ],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, sessionId, date, JSON.stringify(facts));
  bumpTrainingDataVersion();
}

test("the read's batched lighter-on-purpose reader sets aside exactly the exposures the single read does", () => {
  const squat = repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  const bench = repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const plan = [
    [49, 245, 185],
    [42, 250, 185],
    [35, 255, 190],
    [28, 215, 190], // the squat card asked for less, met: set aside
    [21, 255, 190],
    [14, 225, 195], // the squat card asked for less, fell short: still counts
    [7, 260, 195],
    [3, 215, 195], // both cards asked for less, met
  ];
  const sessions = [];
  for (const [d, sq, bp] of plan) {
    for (let n = 1; n <= 3; n++) {
      repo.logSetByName({ exercise: "Back Squat", weight: sq, reps: 5, rir: 2, date: day(-d), set_number: n });
      repo.logSetByName({ exercise: "Bench Press", weight: bp, reps: 5, rir: 2, date: day(-d), set_number: n });
    }
    sessions.push({ d, id: repo.getOrCreateSession(day(-d), null).id });
  }
  const sessionOn = (d) => sessions.find((s) => s.d === d).id;
  carded(sessionOn(28), day(-28), squat, { card: 215, prior: 255, top: 215 });
  carded(sessionOn(14), day(-14), squat, { card: 225, prior: 255, top: 215, verdict: "under_prescribed" });
  carded(sessionOn(3), day(-3), squat, { card: 215, prior: 260, top: 215 });
  const read = capabilityRead(today());
  assert.equal(read.available, true);
  for (const [name, unitKey] of [
    ["Back Squat", "squat"],
    ["Bench Press", "horizontal-push:flat"],
  ]) {
    const contributor = read.units.find((u) => u.key === unitKey)?.contributors.find((c) => c.exercise === name);
    assert.ok(contributor, `${name} is read`);
    const honest = sessions.filter((s) => !exposureLighterOnPurpose(s.id, name)).length;
    assert.equal(contributor.exposures, honest, `${name}: honest exposures match the single read, session by session`);
  }
  // The fixture really sets something aside.
  assert.equal(exposureLighterOnPurpose(sessionOn(28), "Back Squat"), true);
  assert.equal(exposureLighterOnPurpose(sessionOn(14), "Back Squat"), false);
  assert.ok(bench.id > 0);
});

test("a plan-day pass outside a request reads the plateau ladder at most once, never once per lift", () => {
  const lifts = [
    ["Triceps Rope Pushdown", "triceps", 50, 12],
    ["Dumbbell Lateral Raise", "shoulders", 20, 12],
    ["Barbell Curl", "biceps", 65, 10],
  ];
  repo.savePlanDay(
    4,
    "Arms",
    "Arms",
    lifts.map(([exercise, , weight, reps]) => ({ exercise, sets: 3, rep_low: reps, rep_high: reps + 3, target_weight: weight }))
  );
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(day(-90));
  bumpTrainingDataVersion();
  for (const [exercise, group, weight, reps] of lifts) {
    repo.upsertExercise({ name: exercise, muscle_group: group, mode: "reps" });
    for (const d of [42, 35, 28, 21, 14, 7, 2]) repo.logSetByName({ exercise, weight, reps, rir: 2, date: day(-d) });
  }
  getProgramState(today()); // the state (and its own pass ladder) is in hand, as on any read
  // Precondition: the engine's own read asks for a rotation on more than one lift, so a
  // per-lift ladder read would run more than once.
  const asking = lifts.filter(([exercise]) =>
    ["vary", "introduce"].includes(nextPrescription(exercise, undefined, { ladder: null })?.action)
  );
  assert.ok(asking.length >= 2, `precondition: ${asking.length} lifts ask for a rotation`);
  const { value, count } = countPrepares(LADDER_ROWS, () => planDayProgression(4));
  assert.equal(value.length, 3);
  assert.equal(count, 1, `the ladder was computed ${count} times for one pass`);
});

test("a partial program state is never served to a finished reader through the request's signal", () => {
  flatLog("Back Squat", "quads", 275, 5);
  repo.savePlanDay(1, "Legs", "Legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 275 }]);
  const d = today();
  runWithBrainSnapshot(() => {
    const partial = withinCapabilityPassForTest(() => brainSignal(programStateSignalKey(d), () => getProgramState(d)));
    assert.equal(partial.capability, undefined, "precondition: inside a pass the state is the partial one");
    const finished = brainSignal(programStateSignalKey(d), () => getProgramState(d));
    assert.equal(finished.capability?.available, true, "a finished reader gets the finished state");
  });
  assert.equal(programStateSignalKey(d), "program_state");
  assert.equal(programStateSignalKey("2020-01-01"), "program_state:2020-01-01");
  assert.equal(withinCapabilityPassForTest(() => programStateSignalKey(d)), "program_state:partial");
  // Every request-wide program-state signal goes through the key (never a bare literal).
  for (const file of ["src/repo/coach.ts", "src/repo/day-read.ts"]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /brainSignal\([^)]*["`]program_state/, `${file} keys program state through programStateSignalKey`);
  }
});

test("the read's recovery calendar answers as activeRecoveryWeek for every date, with two ledger weeks in the window", () => {
  resetTables("app_state", "plan_proposals", "recovery_cycles");
  const from = day(-112);
  const dates = [];
  for (let d = from; d <= today(); d = addDaysISO(d, 1)) dates.push(d);
  const agrees = (label) => {
    const reader = recoveryWeekReader(from, today());
    let days = 0;
    for (const date of dates) {
      const truth = activeRecoveryWeek(date) != null;
      if (truth) days++;
      assert.equal(reader(date), truth, `${label}: ${date}`);
    }
    return days;
  };
  const applied = (on) => {
    const proposal = db
      .prepare(
        `INSERT INTO plan_proposals (agent, instruction, parsed_json, status) VALUES ('recovery-week', ?, '{}', 'applied')`
      )
      .run(`${RECOVERY_WEEK_INSTRUCTION_PREFIX} fixture ${on}`);
    stampRecoveryWeekApplied(Number(proposal.lastInsertRowid), on);
    bumpTrainingDataVersion();
  };
  // An older ledger week, then a newer one inside the same window.
  applied(day(-90));
  assert.equal(agrees("the older ledger week"), 7);
  applied(day(-40));
  const days = agrees("two ledger weeks");
  assert.ok(days > 0, "the window carries a recovery week");
  // And a stored cycle after both (past the newer week's cooldown).
  repo.scheduleRecoveryCycle({ effective_on: day(-10), exit_on: day(-3), reason: "Reader fixture" });
  agrees("two ledger weeks and a later cycle");
  resetTables("app_state", "plan_proposals", "recovery_cycles");
});
