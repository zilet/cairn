// A lift he is not doing is not "stalled". The program-state read keeps every lift's
// row, but a lift that is neither on the plan nor trained inside the current window is
// RESTING: status "new", a hold, no stall tells, and nothing that counts lifts as
// evidence counts it — not the headline's tally, not adaptations_due, not the
// program-evolution trigger, not the under-fuelling stall arm, not the deload's fatigue
// arm, and not the coach / program-evolution prompts' act-on lists. A lift ON the plan
// but untrained awaits a fresh exposure instead. And near-variants of one movement are
// one fatigue witness, never two.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, savePlanDaySettled } from "./_seed.js";
import {
  AWAITING_EXPOSURE_WHY_VARIANTS,
  RESTING_LIFT_WHY_VARIANTS,
  NOTHING_CURRENT_HEADLINE_VARIANTS,
  liftRotation,
  logConfirmedFatigue,
  regressionWitnessCount,
} from "../dist/repo/program-state.js";
import { energyDeficiencyArms } from "../dist/repo/energy-deficiency.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { localDateISO } from "../dist/repo/shared.js";
import { buildCoachPrompt, buildProgramEvolutionPrompt } from "../dist/prompt.js";
import { renderProgramState } from "../dist/prompt/shared.js";

const REF = "2026-04-20";
const backFrom = (ref, n) => new Date(new Date(ref + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);
const back = (n) => backFrom(REF, n);

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

// Five sessions at one load, a week apart, ending `lastDaysAgo` before `ref`: a plain
// plateau (static load, flat estimate) when it is current.
function logFlat(exercise, lastDaysAgo, weight = 100, ref = REF) {
  for (let k = 4; k >= 0; k--) {
    repo.logSetByName({ exercise, weight, reps: 10, rir: 2, date: backFrom(ref, lastDaysAgo + k * 7) });
  }
}

// A clean climb, current: five sessions ending yesterday.
function logClimbing(exercise, ref = REF) {
  const w = [135, 140, 145, 152, 160];
  [29, 22, 15, 8, 1].forEach((d, i) => repo.logSetByName({ exercise, weight: w[i], reps: 5, rir: 2, date: backFrom(ref, d) }));
}

const planItem = (exercise, weight = 100) => ({ exercise, sets: 3, rep_low: 8, rep_high: 10, target_weight: weight });

test("a plateaued lift off the plan, last trained 60 days ago, is resting and makes no claim", () => {
  logFlat("Leg Extension", 60);
  logClimbing("Bench Press");
  savePlanDaySettled(1, "Push", "Push", [planItem("Bench Press", 160)]);

  const st = repo.getProgramState(REF);
  const ext = st.lifts.find((l) => l.exercise === "Leg Extension");
  assert.ok(ext, "the resting lift keeps its row");
  assert.equal(ext.in_plan, false);
  assert.equal(ext.resting, true);
  assert.equal(ext.status, "new");
  assert.equal(ext.suggested_action, "hold");
  assert.deepEqual(ext.stall_signals, []);
  assert.equal(ext.weeks_static, null);
  assert.ok(RESTING_LIFT_WHY_VARIANTS.includes(ext.why), "says plainly it is out of the rotation");

  const bench = st.lifts.find((l) => l.exercise === "Bench Press");
  assert.equal(bench.in_plan, true);
  assert.equal(bench.resting, false);
  assert.equal(bench.status, "progressing");

  // Not in the headline's tally, not in the adaptations list.
  assert.doesNotMatch(st.headline, /stalled|slipping/);
  assert.match(st.headline, /1 lift climbing/);
  assert.ok(!st.adaptations_due.some((a) => /Leg Extension/.test(a)), st.adaptations_due.join(" | "));

  // Not an evolution trigger.
  const trig = repo.programEvolutionTrigger(REF, { balance: { due: [], over: [] }, testWeek: { due: false }, enduranceTests: [] });
  assert.ok(!/Leg Extension/.test(trig.reasons.join(" ")), trig.reasons.join(" | "));
  assert.ok(!/Leg Extension/.test(trig.signature));

  // Not a fatigue witness.
  assert.equal(logConfirmedFatigue(REF, st.lifts).high, false);
});

test("resting lifts count in neither the numerator nor the denominator of the under-fuelling stall arm", () => {
  // Two plateaus out of the rotation would have read "2 of 3 stalled" — a trivial pass
  // on a protective read about how he is coping now.
  logFlat("Leg Extension", 60);
  logFlat("Seated Leg Curl", 62, 80);
  logClimbing("Bench Press");
  savePlanDaySettled(1, "Push", "Push", [planItem("Bench Press", 160)]);

  const arm = energyDeficiencyArms(REF).find((a) => a.key === "lift_stall");
  assert.ok(arm);
  assert.equal(arm.verdict, "not_met");
  assert.deepEqual(arm.evidence_keys, [`program_state.lifts:${REF}:stalled=0/1`]);
});

test("two resting slides never trip the deload's fatigue arm", () => {
  const slide = (exercise, startDaysAgo, top) => {
    const w = [top, top - 10, top - 20, top - 30, top - 40];
    [0, 7, 14, 21, 28].forEach((k, i) =>
      repo.logSetByName({ exercise, weight: w[i], reps: 8, rir: 2, date: back(startDaysAgo + 28 - k) })
    );
  };
  slide("Leg Extension", 60, 160);
  slide("Lateral Raise", 60, 60);
  const st = repo.getProgramState(REF);
  for (const name of ["Leg Extension", "Lateral Raise"]) {
    const lift = st.lifts.find((l) => l.exercise === name);
    assert.equal(lift.resting, true, name);
    assert.equal(lift.status, "new", name);
  }
  // Even when a stale row still says "regressing", a resting lift is no witness.
  const stamped = st.lifts.map((l) => ({ ...l, status: "regressing" }));
  assert.equal(logConfirmedFatigue(REF, stamped).high, false);
});

test("the same plateau ON the plan and trained last week is graded exactly as before", () => {
  logFlat("Leg Extension", 7);
  logClimbing("Bench Press");
  const offPlan = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Leg Extension");
  // Off the plan but trained lately is not resting either: he is doing it.
  assert.equal(offPlan.in_plan, false);
  assert.equal(offPlan.resting, false);

  savePlanDaySettled(1, "Legs", "Legs", [planItem("Leg Extension")]);
  const st = repo.getProgramState(REF);
  const ext = st.lifts.find((l) => l.exercise === "Leg Extension");
  assert.equal(ext.in_plan, true);
  assert.equal(ext.resting, false);
  assert.equal(ext.status, "plateaued");
  assert.equal(ext.suggested_action, "vary");
  assert.equal(ext.weeks_static, 4);
  assert.ok(ext.stall_signals.some((s) => /same top load/.test(s)));
  const graded = ({ status, suggested_action, weeks_static, stall_signals, why, trend_per_wk, est_1rm, sessions }) => ({
    status,
    suggested_action,
    weeks_static,
    stall_signals,
    why,
    trend_per_wk,
    est_1rm,
    sessions,
  });
  assert.deepEqual(graded(ext), graded(offPlan), "the plan read changes the rotation fields, never the grade");
  assert.match(st.headline, /1 stalled/);
  assert.ok(st.adaptations_due.some((a) => /Rotate a variation for Leg Extension/.test(a)));

  const trig = repo.programEvolutionTrigger(REF, { balance: { due: [], over: [] }, testWeek: { due: false }, enduranceTests: [] });
  assert.match(trig.signature, /vary:Leg Extension/, "a lift on the plan still arms the trigger");
});

test("a lift's family on the plan keeps a gym-floor variant in the rotation", () => {
  logFlat("Dumbbell Bench Press", 45);
  savePlanDaySettled(1, "Push", "Push", [planItem("Barbell Bench Press", 185)]);
  const lift = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Dumbbell Bench Press");
  assert.equal(lift.in_plan, true, "same movement key as a plan item");
  assert.equal(lift.resting, false);
});

test("an on-plan lift untrained for 40 days awaits a fresh exposure, never a stale plateau", () => {
  logFlat("Leg Extension", 40);
  savePlanDaySettled(1, "Legs", "Legs", [planItem("Leg Extension")]);
  const st = repo.getProgramState(REF);
  const ext = st.lifts.find((l) => l.exercise === "Leg Extension");
  assert.equal(ext.in_plan, true);
  assert.equal(ext.resting, false);
  assert.equal(ext.status, "new");
  assert.equal(ext.suggested_action, "hold");
  assert.deepEqual(ext.stall_signals, []);
  assert.equal(ext.weeks_static, null);
  assert.ok(AWAITING_EXPOSURE_WHY_VARIANTS.includes(ext.why), ext.why);
  assert.doesNotMatch(st.headline, /stalled|slipping|holding steady/);
  assert.ok(NOTHING_CURRENT_HEADLINE_VARIANTS.includes(st.headline), st.headline);
  assert.ok(!st.adaptations_due.some((a) => /Leg Extension/.test(a)));
});

test("an on-plan climb untrained for five weeks keeps its grade (only a stall or slide awaits)", () => {
  const w = [135, 140, 145, 152, 160];
  [63, 56, 49, 42, 35].forEach((d, i) => repo.logSetByName({ exercise: "Bench Press", weight: w[i], reps: 5, rir: 2, date: back(d) }));
  savePlanDaySettled(1, "Push", "Push", [planItem("Bench Press", 160)]);
  const bench = repo.getProgramState(REF).lifts.find((l) => l.exercise === "Bench Press");
  assert.equal(bench.resting, false);
  assert.equal(bench.status, "progressing");
});

test("a plan that cannot be read fails toward silence: a stale lift rests, a current one is graded", () => {
  const stale = back(40);
  const recent = back(7);
  assert.deepEqual(liftRotation(stale, null, REF), { in_plan: false, resting: true, stale: true });
  assert.deepEqual(liftRotation(recent, null, REF), { in_plan: false, resting: false, stale: false });
  assert.deepEqual(liftRotation(stale, true, REF), { in_plan: true, resting: false, stale: true });
  assert.deepEqual(liftRotation(stale, false, REF), { in_plan: false, resting: true, stale: true });
  assert.deepEqual(liftRotation(null, null, REF), { in_plan: false, resting: true, stale: true });
});

test("two regressing variants of one region are one fatigue witness; two regions are two", () => {
  const lift = (exercise, family_key) => ({ exercise, family_key, status: "regressing", resting: false, muscle_group: null });
  const pressdowns = [lift("Rope Triceps Pushdown", "rope triceps pushdown"), lift("Straight Bar Pushdown", "straight bar pushdown")];
  assert.equal(regressionWitnessCount(pressdowns), 1);
  assert.equal(logConfirmedFatigue(REF, pressdowns).high, false, "two noisy pressdowns are one slide");

  const family = [lift("Barbell Back Squat", "back squat"), lift("Back Squat (Belt)", "back squat")];
  assert.equal(regressionWitnessCount(family), 1, "one movement family is one witness");

  const distinct = [lift("Leg Extension", "leg extension"), lift("Lateral Raise", "lateral raise")];
  assert.equal(regressionWitnessCount(distinct), 2);
  const read = logConfirmedFatigue(REF, distinct);
  assert.equal(read.high, true);
  assert.ok(read.reasons.some((r) => /drifting down/.test(r)));

  // A resting one never counts toward the pair.
  assert.equal(logConfirmedFatigue(REF, [distinct[0], { ...distinct[1], resting: true }]).high, false);
});

test("every resting and awaiting phrasing holds the reading grammar", () => {
  for (const s of [...RESTING_LIFT_WHY_VARIANTS, ...AWAITING_EXPOSURE_WHY_VARIANTS, ...NOTHING_CURRENT_HEADLINE_VARIANTS]) {
    assert.equal(violatesReadingGrammar(s), null, s);
    assert.doesNotMatch(s, /\d/, `no number in "${s}"`);
  }
});

test("the coach and program-evolution prompts never name a resting lift in an act-on list", () => {
  const today = localDateISO();
  logFlat("Leg Extension", 60, 100, today);
  logFlat("Bench Press", 1, 185, today);
  savePlanDaySettled(1, "Push", "Push", [planItem("Bench Press", 185)]);

  const actOn = (prompt) => {
    const lines = prompt.split("\n");
    const needsAt = lines.findIndex((l) => /^LIFTS THAT NEED A CALL/.test(l));
    const needs = [];
    if (needsAt >= 0) for (let i = needsAt + 1; i < lines.length && /^\s+- /.test(lines[i]); i++) needs.push(lines[i]);
    const variations = lines.filter((l) => /^- .+ → /.test(l));
    const progressing = lines.filter((l) => /^PROGRESSING/.test(l));
    return { needs, variations, progressing };
  };
  for (const [site, build] of [
    ["coach", () => buildCoachPrompt()],
    ["program_evolution", () => buildProgramEvolutionPrompt()],
  ]) {
    const prompt = build();
    const { needs, variations, progressing } = actOn(prompt);
    for (const line of [...needs, ...variations, ...progressing]) {
      assert.doesNotMatch(line, /Leg Extension/, `${site}: ${line}`);
    }
    assert.doesNotMatch(prompt, /Rotate a variation for Leg Extension|Leg Extension has stalled/, site);
    assert.ok(needs.some((l) => /Bench Press \[plateaued\]/.test(l)), `${site} still names the current stall`);
  }
  const evo = buildProgramEvolutionPrompt();
  assert.match(evo, /Bench Press →/, "the current stall still gets its variation candidates");
});

test("the rendered program state drops a resting lift even if its row still carries a stall", () => {
  const text = renderProgramState({
    program_state: {
      headline: "1 stalled.",
      lifts: [
        { exercise: "Leg Extension", status: "plateaued", suggested_action: "vary", stall_signals: [], why: "", resting: true },
        { exercise: "Hack Squat", status: "progressing", suggested_action: "overload", stall_signals: [], why: "", resting: true },
        { exercise: "Bench Press", status: "plateaued", suggested_action: "vary", stall_signals: [], why: "Flat.", resting: false },
      ],
    },
  });
  assert.doesNotMatch(text, /Leg Extension|Hack Squat/);
  assert.match(text, /Bench Press \[plateaued\]/);
});

test("the trigger ignores a stall on a lift off the plan", () => {
  const out = repo.programEvolutionTrigger("2026-06-26", {
    programState: {
      lifts: [
        { exercise: "Leg Extension", status: "plateaued", suggested_action: "vary", sessions: 6, in_plan: false, resting: false },
        { exercise: "Hip Thrust", status: "regressing", suggested_action: "deload", sessions: 6, in_plan: true, resting: true },
      ],
    },
    balance: { due: [], over: [] },
    testWeek: { due: false },
    enduranceTests: [],
    trainingPlaybook: null,
  });
  assert.ok(!/vary:/.test(out.signature), out.signature);
  assert.ok(!/Leg Extension|Hip Thrust/.test(out.reasons.join(" ")));
});
