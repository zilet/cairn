// The decisions that used to count single lifts now read MOVEMENT UNITS (the capability read,
// carried on program state and judged through src/repo/capability-consumers.ts): the deload's
// fatigue arm, the volume step's group condition, the under-fuelling stall arm, the program
// headline and adaptations, the plateau plays, the muscle trajectory and the prompts. These
// lock the rules an elite coach would insist on for an athlete who swaps variants freely: two
// variants of one movement are one witness, a stalled variant inside a climbing movement is a
// swap and not a plateau, holding through a cut or a run build is the plan working, a lift he
// is not doing never speaks, and more volume is never the answer to a slide.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, savePlanDaySettled } from "./_seed.js";
import { capabilityRead } from "../dist/repo/strength-capability.js";
import {
  capabilityPromptView,
  everyUnitOnPlan,
  fatigueWitnessUnits,
  liftCallStands,
  liftStallUnitRead,
  summarizeCapability,
  volumeStepUnitRead,
  VOLUME_STEP_MIN_UNIT_EXPOSURES,
} from "../dist/repo/capability-consumers.js";
import { trainingPlaybook } from "../dist/repo/training-playbook.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { PROMPT_CONTEXT_SITES, projectCoachContext } from "../dist/prompt/context-projection.js";
import { PROGRESS_BY_MOVEMENT_RULE, renderProgramState } from "../dist/prompt/shared.js";

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

const planItem = (exercise, weight = 100) => ({ exercise, sets: 3, rep_low: 5, rep_high: 8, target_weight: weight });
const DAYS = [29, 22, 15, 8, 1];
const flat = (exercise, weight, reps = 5) =>
  DAYS.forEach((d) => repo.logSetByName({ exercise, weight, reps, rir: 2, date: back(d) }));
const rising = (exercise, weights, reps = 5) =>
  DAYS.forEach((d, i) => repo.logSetByName({ exercise, weight: weights[i], reps, rir: 2, date: back(d) }));

// A synthetic summary, the shape program state carries.
const unit = (key, extra = {}) => ({
  key,
  label: key,
  compound: true,
  in_plan: true,
  verdict: "holding",
  qualifiers: [],
  line: "",
  lifts: [{ exercise: `${key} lift`, exercise_id: 1, in_plan: true, resting: false }],
  plan_lift: `${key} lift`,
  exposures: 6,
  ...extra,
});
const cap = (units, muscles = []) => ({ available: true, overall: null, units, muscles });

// ---- program state carries the read ---------------------------------------------------

test("program state carries the capability read for its date, the same read the bare call gives", () => {
  flat("Bench Press", 185);
  rising("Back Squat", [225, 235, 245, 255, 265]);
  savePlanDaySettled(1, "Full", "Full", [planItem("Bench Press", 185), planItem("Back Squat", 265)]);
  const st = repo.getProgramState(REF);
  assert.equal(st.capability?.available, true);
  const bare = summarizeCapability(capabilityRead(REF));
  const verdicts = (c) => c.units.map((u) => `${u.key}:${u.verdict}:${u.in_plan}`).sort();
  assert.deepEqual(verdicts(st.capability), verdicts(bare), "one read, whoever asks");
  // The headline: the overall line, then the units on the plan by verdict.
  assert.match(st.headline, /On the plan: 1 movement climbing, 1 holding\./, st.headline);
  assert.doesNotMatch(st.headline, /\d+ lifts? (climbing|stalled|slipping)/, "no lift tally");
});

// ---- 1. the deload's fatigue arm ----------------------------------------------------------

const drifting = {
  delta: { hrv: -6, rhr: 4 },
  quality: {
    hrv_ms: { latest_date: REF, freshness: "fresh", sample_count: 8, expected_days: 14 },
    resting_hr: { latest_date: REF, freshness: "fresh", sample_count: 8, expected_days: 14 },
  },
};

function fourLoadedWeeks(lifts) {
  // wk=1 is the most recent completed week, so it carries the lowest load.
  [1, 2, 3, 4].forEach((wk, i) => {
    for (const off of [1, 3]) {
      for (let s = 1; s <= 4; s++) {
        for (const [exercise, weights] of lifts)
          repo.logSetByName({ exercise, weight: weights[i], reps: 5, rir: 2, date: back(wk * 7 + off) });
      }
    }
  });
}

test("two MOVEMENTS slipping beside drifting recovery after four loaded weeks earn the deload", () => {
  repo.setProfile({ primary_discipline: "strength" });
  fourLoadedWeeks([
    ["Back Squat", [225, 235, 245, 255]],
    ["Bench Press", [155, 165, 175, 185]],
  ]);
  const st = repo.getProgramState(REF, drifting);
  assert.equal(st.mesocycle.phase, "deload-due", st.mesocycle.note);
  assert.equal(st.mesocycle.deload_basis.arm, "fatigue");
  assert.match(st.mesocycle.note, /main movements are drifting down/);
  assert.equal(fatigueWitnessUnits(st.capability).length, 2);
});

test("two variants of ONE movement slipping are one witness: no fatigue deload", () => {
  repo.setProfile({ primary_discipline: "strength" });
  fourLoadedWeeks([
    ["Back Squat", [225, 235, 245, 255]],
    ["Front Squat", [175, 185, 195, 205]],
    ["Bench Press", [185, 185, 185, 185]],
  ]);
  const st = repo.getProgramState(REF, drifting);
  const lifts = Object.fromEntries(st.lifts.map((l) => [l.exercise, l.status]));
  assert.equal(lifts["Back Squat"], "regressing", "precondition");
  assert.equal(lifts["Front Squat"], "regressing", "precondition");
  assert.ok(fatigueWitnessUnits(st.capability).length <= 1, JSON.stringify(st.capability.units.map((u) => [u.key, u.verdict])));
  assert.notEqual(st.mesocycle.deload_basis?.arm, "fatigue", st.mesocycle.note);
});

// ---- 4. adaptations per unit, never off-plan, never for a swap ----------------------------

test("adaptations are one per movement on the plan: a stalled variant inside a climbing movement is no plateau", () => {
  flat("Barbell Bench Press", 185);
  rising("Dumbbell Bench Press", [60, 65, 70, 75, 80]);
  flat("Leg Extension", 100, 10); // trained lately, but off the plan
  savePlanDaySettled(1, "Push", "Push", [planItem("Barbell Bench Press", 185)]);
  const st = repo.getProgramState(REF);
  const bb = st.lifts.find((l) => l.exercise === "Barbell Bench Press");
  assert.equal(bb.status, "plateaued", "precondition: the lift alone reads flat");
  const press = st.capability.units.find((u) => u.key === "horizontal-push:flat");
  assert.equal(press.verdict, "climbing", "precondition: the movement is climbing");
  const ext = st.capability.units.find((u) => u.lifts.some((l) => l.exercise === "Leg Extension"));
  assert.equal(ext?.in_plan, false, "precondition: the extension is off the plan");

  const text = st.adaptations_due.join(" | ");
  assert.doesNotMatch(text, /Rotate a variation|Unstick|Deload your/, text);
  assert.doesNotMatch(text, /Leg Extension|leg extension/, "an off-plan movement gets no call");
  assert.match(text, /Push the next load step on Barbell Bench Press/, "the climbing movement's plan lift pushes");
  assert.match(st.headline, /On the plan: 1 movement climbing\./, "off-plan units are not counted");

  // The playbook and the muscle trajectory tell the same story.
  const plays = trainingPlaybook(REF).plateau_plays.filter((p) => p.kind === "strength_plateau");
  assert.ok(!plays.some((p) => /Bench/.test(p.title)), JSON.stringify(plays.map((p) => p.title)));
  const chest = repo.muscleGroupTrajectory(REF).groups.find((g) => g.group === "chest");
  const muscle = st.capability.muscles.find((m) => m.group === "chest");
  assert.equal(muscle.verdict, "progressing");
  assert.equal(chest.verdict, "advancing", "the trajectory never disagrees with the capability read");
});

test("a holding movement on the plan names the unit and the plan's lift as evidence", () => {
  flat("Bench Press", 185);
  savePlanDaySettled(1, "Push", "Push", [planItem("Bench Press", 185)]);
  const st = repo.getProgramState(REF);
  const line = st.adaptations_due.find((a) => /flat press/.test(a));
  assert.ok(line, st.adaptations_due.join(" | "));
  assert.match(line, /your flat press work/);
  assert.match(line, /Bench Press/);
});

test("a unit holding through the cut or a run build gets no rotate call; a slip with no excuse is backed off", () => {
  const lifts = [{ exercise: "squat lift", status: "plateaued", suggested_action: "vary", resting: false, weeks_static: 4 }];
  // liftCallStands: the movement decides.
  assert.equal(liftCallStands(cap([unit("squat", { qualifiers: ["cut"] })]), "squat lift"), false);
  assert.equal(liftCallStands(cap([unit("squat", { qualifiers: ["run_build"] })]), "squat lift"), false);
  assert.equal(liftCallStands(cap([unit("squat", { verdict: "climbing" })]), "squat lift"), false);
  assert.equal(liftCallStands(cap([unit("squat", { in_plan: false })]), "squat lift"), false);
  assert.equal(liftCallStands(cap([unit("squat")]), "squat lift"), true);
  assert.equal(liftCallStands(null, "squat lift"), true, "no read: the lift-level call stands as it was");
  assert.ok(lifts.length);
});

// ---- 3. the under-fuelling stall arm, over units --------------------------------------------

test("lift_stall over units: two movements he is doing, holding or slipping, whatever else is graded", () => {
  assert.equal(liftStallUnitRead(null).verdict, "absent");
  assert.equal(liftStallUnitRead(cap([unit("squat", { verdict: "not_enough" })])).verdict, "absent");
  // Two holding through the deficit: met, as two flat lifts were (the arm watches the cut).
  const flatCut = liftStallUnitRead(cap([unit("squat", { qualifiers: ["cut"] }), unit("hinge", { qualifiers: ["cut"] })]));
  assert.equal(flatCut.verdict, "met");
  assert.equal(flatCut.slipping, 0);
  // Nothing explains a unit away here, a run build included.
  assert.equal(
    liftStallUnitRead(cap([unit("squat", { verdict: "slipping", qualifiers: ["run_build"] }), unit("hinge")])).verdict,
    "met"
  );
  // Two of five graded still meets: the lift rule asked for two, of any number.
  assert.equal(
    liftStallUnitRead(
      cap([
        unit("squat", { verdict: "slipping" }),
        unit("hinge"),
        unit("row", { verdict: "climbing" }),
        unit("vertical-pull", { verdict: "climbing" }),
        unit("vertical-push", { verdict: "climbing" }),
      ])
    ).verdict,
    "met"
  );
  // An off-plan movement trained lately and an isolation movement count, as their lifts did.
  const read = liftStallUnitRead(
    cap([unit("squat", { verdict: "slipping" }), unit("hinge", { in_plan: false }), unit("curl", { compound: false })])
  );
  assert.equal(read.graded, 3);
  assert.equal(read.verdict, "met");
  // A movement with no current lift (resting, or on the plan but untrained for weeks) is neither graded nor a witness.
  const stale = (key) =>
    unit(key, { lifts: [{ exercise: `${key} lift`, exercise_id: 2, in_plan: true, resting: false, current: false }] });
  const quiet = liftStallUnitRead(cap([unit("squat"), stale("hinge"), stale("row")]));
  assert.equal(quiet.graded, 1);
  assert.equal(quiet.verdict, "not_met");
});

// ---- 2. the volume step's group condition ----------------------------------------------------

test("volume step: a group earns a set only through a movement HOLDING on enough evidence with nothing explaining it", () => {
  const chest = (units) => cap(units, [{ group: "chest", verdict: "holding", band: "productive", units: units.map((u) => u.key), line: "" }]);
  assert.deepEqual(volumeStepUnitRead(chest([unit("horizontal-push:flat")]), "chest"), {
    block: null,
    earning: ["horizontal-push:flat"],
  });
  assert.equal(volumeStepUnitRead(chest([unit("horizontal-push:flat", { verdict: "climbing" })]), "chest").block, "unit_climbing");
  assert.equal(
    volumeStepUnitRead(chest([unit("horizontal-push:flat"), unit("horizontal-push:incline", { verdict: "slipping" })]), "chest").block,
    "unit_slipping",
    "a slide anywhere in the group: more volume is the wrong lever"
  );
  assert.equal(
    volumeStepUnitRead(chest([unit("horizontal-push:flat", { qualifiers: ["cut"] })]), "chest").block,
    "unit_explained"
  );
  assert.equal(
    volumeStepUnitRead(chest([unit("horizontal-push:flat", { exposures: VOLUME_STEP_MIN_UNIT_EXPOSURES - 1 })]), "chest").block,
    "unit_unread",
    "a hold read off too few sessions is a guess"
  );
  assert.equal(volumeStepUnitRead(chest([unit("horizontal-push:flat", { in_plan: false })]), "chest").block, "unit_unread");
  assert.equal(volumeStepUnitRead(null, "chest").block, "unit_unread", "no read: nothing earned");
  // A climbing unit beside a holding one: the holding one takes the set.
  assert.deepEqual(
    volumeStepUnitRead(chest([unit("horizontal-push:flat", { verdict: "climbing" }), unit("horizontal-push:incline")]), "chest").earning,
    ["horizontal-push:incline"]
  );
});

// ---- 6. the prompts ------------------------------------------------------------------------

test("the prompt key is compact words and names, never a resting lift; it rides the plan and chat sites", () => {
  const view = capabilityPromptView(
    cap([
      unit("squat", {
        qualifiers: ["run_build"],
        lifts: [
          { exercise: "Back Squat", exercise_id: 1, in_plan: true, resting: false },
          { exercise: "Box Squat", exercise_id: 2, in_plan: false, resting: true },
        ],
      }),
      unit("curl", { in_plan: false }),
    ])
  );
  assert.equal(view.units.length, 1, "in-plan units only");
  assert.deepEqual(view.units[0], { movement: "squat", verdict: "holding", because: "run_build", lifts: ["Back Squat"] });
  assert.equal(capabilityPromptView(null), null);
  assert.ok(JSON.stringify(view).length < 400);

  for (const site of ["coach", "program_evolution", "chat", "chat_core"]) {
    assert.ok(PROMPT_CONTEXT_SITES[site].keys.includes("capability"), site);
  }
  assert.ok(!PROMPT_CONTEXT_SITES.day_read.keys.includes("capability"), "the Brief's byte ceiling is untouched");
  const projected = projectCoachContext({ capability: view, now: {} }, "coach");
  assert.deepEqual(projected.capability, view);
});

test("the plan prompts judge per movement: the movement list replaces the per-lift stall list", () => {
  assert.match(PROGRESS_BY_MOVEMENT_RULE, /per movement and per muscle/);
  assert.match(PROGRESS_BY_MOVEMENT_RULE, /not a reset/);
  assert.match(PROGRESS_BY_MOVEMENT_RULE, /cut or a run build is the plan working/);
  assert.match(PROGRESS_BY_MOVEMENT_RULE, /resting, never stalled/);
  const text = renderProgramState({
    program_state: {
      headline: "On the plan: 1 holding.",
      lifts: [
        { exercise: "Bench Press", status: "plateaued", suggested_action: "vary", stall_signals: ["same top load"], why: "", resting: false },
        { exercise: "Back Squat", status: "plateaued", suggested_action: "vary", stall_signals: [], why: "", resting: false },
      ],
    },
    capability: {
      overall: "Overall, your strength is holding steady.",
      units: [
        { movement: "flat press", verdict: "holding", lifts: ["Bench Press"] },
        { movement: "squat", verdict: "holding", because: "cut", lifts: ["Back Squat"] },
        { movement: "row", verdict: "climbing", lifts: ["Seated Cable Row"] },
      ],
      muscles: [],
    },
  });
  assert.doesNotMatch(text, /LIFTS THAT NEED A CALL/);
  assert.match(text, /MOVEMENTS THAT NEED A CALL/);
  assert.match(text, /flat press \[holding\] \(Bench Press\) → Bench Press vary/);
  assert.match(text, /HOLDING AS PLANNED[^\n]*squat \(through the cut\)/);
  assert.doesNotMatch(text, /- squat \[holding\]/, "a unit held by the cut is not a call");
  assert.match(text, /PROGRESSING[^\n]*Seated Cable Row/);
});

// ---- the words -------------------------------------------------------------------------------

test("every unit-level sentence holds the reading grammar", () => {
  flat("Bench Press", 185);
  flat("Back Squat", 275);
  savePlanDaySettled(1, "Full", "Full", [planItem("Bench Press", 185), planItem("Back Squat", 275)]);
  const st = repo.getProgramState(REF);
  assert.ok(st.adaptations_due.length > 0);
  for (const line of [st.headline, ...st.adaptations_due.filter((a) => /your .* work/.test(a))]) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\bscore\b|\/100|%/, line);
  }
});

test("with no plan at all, every movement he trains is his program", () => {
  const summary = cap([unit("squat", { in_plan: false })]);
  assert.equal(everyUnitOnPlan(summary).units[0].in_plan, true);
  assert.equal(everyUnitOnPlan({ ...summary, available: false }).units[0].in_plan, false);
});
