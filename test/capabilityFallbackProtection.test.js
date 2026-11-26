// Protection read by movements must never be narrower than the lift rules it replaced, and a
// capability read that cannot be had must never switch it off.
//   1. A thrown/failed capability read on a FINISHED program state: the deload's fatigue
//      arm, the under-fuelling stall arm and the under-fuelling performance channel fall back
//      to the lift rules over the lifts he is doing (never a resting one).
//   2. The under-fuelling stall arm and performance channel, read over units, fire in every
//      scenario the pre-unit lift rules fired in (the rules as of e296db29, restated here as
//      the oracle), once the same lifts are grouped into movements. A resting lift never
//      counts on either side.
//   3. The day read's performance shortfall (morning-dose) asks the same fatigue question
//      on the state's own summary, so it follows both.
// Synthetic fixtures; deterministic and offline.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { liftStallUnitRead } from "../dist/repo/capability-consumers.js";
import { energyDeficiencyArms } from "../dist/repo/energy-deficiency.js";
import { logConfirmedFatigue } from "../dist/repo/program-state.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";
import { strengthDeclineIsMeaningful } from "../dist/repo/whole-person-trajectory.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const REF = "2026-04-20";
const back = (n) => addDaysISO(REF, -n);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "activities",
    "garmin_activities",
    "plan_items",
    "plan_days",
    "program_blocks",
    "plan_proposals",
    "daily_metrics",
    "checkins",
    "app_state",
    "daily_session_outcomes",
    "daily_session_compositions"
  );
});

// Make the capability read's own log query fail (strength-capability.ts readRows is
// deliberately unwrapped: a failed query is a failed read), for the duration of `fn`.
function withFailedCapabilityRead(fn) {
  const original = db.prepare;
  db.prepare = function (sql, ...rest) {
    if (/e\.input_profile AS input_profile/.test(String(sql)) && /ls\.rir AS rir/.test(String(sql)))
      throw new Error("capability read unavailable (fixture)");
    return original.call(this, sql, ...rest);
  };
  try {
    return fn();
  } finally {
    db.prepare = original;
  }
}

const drifting = {
  delta: { hrv: -6, rhr: 4 },
  quality: {
    hrv_ms: { latest_date: REF, freshness: "fresh", sample_count: 8, expected_days: 14 },
    resting_hr: { latest_date: REF, freshness: "fresh", sample_count: 8, expected_days: 14 },
  },
};

// Four loaded weeks with two independent lifts sliding across them (wk=1 is the lightest).
function fourLoadedWeeksSliding() {
  repo.setProfile({ primary_discipline: "strength" });
  const lifts = [
    ["Back Squat", [225, 235, 245, 255]],
    ["Bench Press", [155, 165, 175, 185]],
  ];
  [1, 2, 3, 4].forEach((wk, i) => {
    for (const off of [1, 3])
      for (let s = 1; s <= 4; s++)
        for (const [exercise, weights] of lifts)
          repo.logSetByName({ exercise, weight: weights[i], reps: 5, rir: 2, date: back(wk * 7 + off) });
  });
}

// ---- 1. a failed read never switches protection off -------------------------------------

test("a failed capability read: the deload's fatigue arm answers by the lifts he is doing", () => {
  fourLoadedWeeksSliding();
  const st = withFailedCapabilityRead(() => repo.getProgramState(REF, drifting));
  assert.equal(st.capability?.available, false, "precondition: the read failed on a finished state");
  const status = Object.fromEntries(st.lifts.map((l) => [l.exercise, l.status]));
  assert.equal(status["Back Squat"], "regressing", "precondition");
  assert.equal(status["Bench Press"], "regressing", "precondition");
  assert.equal(st.mesocycle.phase, "deload-due", st.mesocycle.note);
  assert.equal(st.mesocycle.deload_basis?.arm, "fatigue");
  assert.match(st.mesocycle.note, /lifts are drifting down/);
  // The day read's morning shortfall asks the same question on the state's own summary.
  assert.equal(logConfirmedFatigue(REF, st.lifts, st.capability).high, true);
});

test("a failed capability read: the under-fuelling stall arm falls back to the lift rule", () => {
  fourLoadedWeeksSliding();
  const arm = withFailedCapabilityRead(() => energyDeficiencyArms(REF).find((a) => a.key === "lift_stall"));
  assert.equal(arm.verdict, "met", JSON.stringify(arm));
  assert.ok(arm.evidence_keys.some((k) => /^program_state\.lifts:/.test(k)), arm.evidence_keys.join(","));
});

test("a failed capability read: the performance channel answers by the lift tally", () => {
  const lifts = [
    { exercise: "Back Squat", status: "regressing", last_trained: back(2) },
    { exercise: "Bench Press", status: "regressing", last_trained: back(3) },
  ];
  const channel = (programState) =>
    underfuelingRead(REF, { expenditure: null, goal: null, programState, wholePerson: null }).channels.find(
      (c) => c.key === "performance"
    );
  const failed = { available: false, overall: null, units: [], muscles: [] };
  assert.equal(channel({ lifts, capability: failed }).direction, "strain");
  assert.equal(channel({ lifts }).direction, "strain");
});

// ---- 2. the unit rules fire wherever the lift rules fired --------------------------------

// The pre-unit rules, verbatim in substance (git show e296db29:src/repo/energy-deficiency.ts
// liftStallArm, and :src/repo/underfueling.ts performanceChannel's lift tally).
function oldStallMet(lifts) {
  const graded = lifts.filter((lift) => lift?.status && lift.status !== "new" && lift.resting !== true);
  if (!graded.length) return false;
  return graded.filter((lift) => ["regressing", "plateaued"].includes(String(lift.status))).length >= 2;
}

const VERDICT = { progressing: "climbing", plateaued: "holding", maintaining: "holding", regressing: "slipping" };

// One scenario, seen both ways. Each lift is its own movement (the table is "the same lifts
// grouped into units"). A lift not trained inside the current window reads `new` to the lift
// rules (liftStates: a resting lift, or an on-plan lift awaiting its next exposure) and has
// no current lift in its unit.
function scenario(specs) {
  const lifts = specs.map((s, i) => {
    const current = s.current !== false;
    const inPlan = s.in_plan !== false;
    return {
      exercise: `Lift ${i}`,
      status: current ? s.status : "new",
      resting: !inPlan && !current,
      last_trained: current ? back(3) : back(40),
    };
  });
  const units = specs.map((s, i) => {
    const current = s.current !== false;
    const inPlan = s.in_plan !== false;
    return {
      key: `unit-${i}`,
      label: `Unit ${i}`,
      compound: s.compound !== false,
      in_plan: inPlan,
      verdict: VERDICT[s.status] ?? "not_enough",
      qualifiers: s.qualifiers ?? [],
      line: "",
      lifts: [{ exercise: `Lift ${i}`, exercise_id: 100 + i, in_plan: inPlan, resting: !inPlan && !current, current }],
      plan_lift: inPlan ? `Lift ${i}` : null,
      exposures: 6,
    };
  });
  return { lifts, capability: { available: true, overall: null, units, muscles: [] } };
}

const flat = (extra = {}) => ({ status: "plateaued", ...extra });
const slip = (extra = {}) => ({ status: "regressing", ...extra });
const climb = (extra = {}) => ({ status: "progressing", ...extra });

const SCENARIOS = {
  "two compound movements flat on the plan": [flat(), flat()],
  "four flat, none slipping, two climbing (a deficit's flat strength)": [flat(), flat(), flat(), flat(), climb(), climb()],
  "one slipping, one flat, three climbing": [slip(), flat(), climb(), climb(), climb()],
  "two slipping": [slip(), slip()],
  "two flat isolation movements beside a climbing compound": [flat({ compound: false }), flat({ compound: false }), climb()],
  "one flat off the plan but trained lately, one flat on it": [flat({ in_plan: false }), flat()],
  "two flat through the cut": [flat({ qualifiers: ["cut"] }), flat({ qualifiers: ["cut"] })],
  "two flat through a run build": [flat({ qualifiers: ["run_build"] }), slip({ qualifiers: ["run_build"] })],
  "two flat in a lighter week": [flat({ qualifiers: ["recovery"] }), flat({ qualifiers: ["recovery"] })],
  "one flat beside two resting slides": [flat(), slip({ in_plan: false, current: false }), slip({ in_plan: false, current: false })],
  "one flat beside an on-plan lift untrained for weeks": [flat(), flat({ current: false })],
  "one flat": [flat(), climb()],
};

test("the stall arm over units fires in every scenario the lift rule fired in, and never on a resting lift", () => {
  let fired = 0;
  for (const [name, specs] of Object.entries(SCENARIOS)) {
    const { lifts, capability } = scenario(specs);
    const before = oldStallMet(lifts);
    const after = liftStallUnitRead(capability).verdict === "met";
    if (before) {
      fired++;
      assert.equal(after, true, `${name}: the lift rule fired, so must the unit rule`);
    } else {
      assert.equal(after, false, `${name}: the unit rule is never more protective than the lift rule here`);
    }
  }
  assert.ok(fired >= 8, "the table exercises the firing scenarios");
});

test("the performance channel over units reads strain in every scenario the lift tally did", () => {
  const extra = {
    "one movement slipping, nothing else graded": [slip()],
    "two slipping, one climbing": [slip(), slip(), climb()],
    "one slipping among flats": [slip(), flat(), flat()],
    "two slipping beside a resting climb": [slip(), slip(), climb({ in_plan: false, current: false })],
  };
  let fired = 0;
  for (const [name, specs] of Object.entries({ ...SCENARIOS, ...extra })) {
    const { lifts, capability } = scenario(specs);
    const read = (programState) =>
      underfuelingRead(REF, { expenditure: null, goal: null, programState, wholePerson: null }).channels.find(
        (c) => c.key === "performance"
      ).direction === "strain";
    const before = read({ lifts });
    // The oracle the lift tally is, restated: progressing vs regressing vs flat, current lifts only.
    const recent = lifts.filter((l) => l.last_trained >= back(28));
    assert.equal(
      before,
      strengthDeclineIsMeaningful({
        improving: lifts.filter((l) => l.status === "progressing").length,
        declining: recent.filter((l) => l.status === "regressing").length,
        steady: recent.filter((l) => l.status === "plateaued" || l.status === "maintaining").length,
      }),
      `${name}: precondition, the legacy tally is the old rule`
    );
    const after = read({ lifts, capability });
    if (before) {
      fired++;
      assert.equal(after, true, `${name}: the lift tally read strain, so must the unit tally`);
    }
  }
  assert.ok(fired >= 4, "the table exercises the strain scenarios");
});

test("the day the read is live: the stall arm counts a deficit's flat movements as met", () => {
  // The read the day read and the energy-deficiency watch see, end to end: two flat
  // compound movements on the plan, trained lately, no slide anywhere.
  const today = localDateISO();
  const days = [29, 22, 15, 8, 1].map((d) => addDaysISO(today, -d));
  for (const date of days) {
    repo.logSetByName({ exercise: "Back Squat", weight: 275, reps: 5, rir: 2, date });
    repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 5, rir: 2, date });
  }
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 275 },
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const st = repo.getProgramState(today);
  const verdicts = st.capability.units.filter((u) => u.in_plan).map((u) => u.verdict);
  assert.deepEqual(verdicts.sort(), ["holding", "holding"], "precondition: both movements hold");
  const arm = energyDeficiencyArms(today).find((a) => a.key === "lift_stall");
  assert.equal(arm.verdict, "met", JSON.stringify(arm));
});
