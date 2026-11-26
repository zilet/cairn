// The plateau ladder wired through every surface that names a stalled movement's next
// step (src/repo/unit-plateau.ts is the one answer):
//   1. the capability read's surface carries each in-plan unit's `next` lever
//      (capabilityWithLadder), and Progress shows it as one quiet line, never for a wait;
//   2. program state's adaptations_due takes a holding movement's lever from the ladder, and
//      says nothing for a unit the ladder makes wait;
//   3. the progression engine's own vary / introduce defers to the ladder for a lift whose
//      movement the ladder covers, without moving the load;
//   4. the program-evolution trigger counts movements, not lifts;
//   5. the under-fuelling performance channel counts movements, not lifts;
//   6. the coach context and the plan / chat prompt sites carry the ladder;
//   7. the exercise enrichment prompt never carries the lift's constraint note.
// State is built from REAL rows through the repo's writers. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { db, repo } from "./_seed.js";
import { ladderRungForLift, unitPlateauLadder } from "../dist/repo/unit-plateau.js";
import { capabilityRead } from "../dist/repo/strength-capability.js";
import { capabilityWithLadder } from "../dist/repo/capability-ladder.js";
import { ladderCallLine } from "../dist/repo/program-state.js";
import { nextPrescription, programEvolutionTrigger } from "../dist/repo/progression.js";
import { underfuelingRead } from "../dist/repo/underfueling.js";
import { PROMPT_CONTEXT_SITES, projectCoachContext } from "../dist/prompt/context-projection.js";
import { PLATEAU_LADDER_RULE, renderProgramState } from "../dist/prompt/shared.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sql(statement, ...args) {
  db.prepare(statement).run(...args);
  bumpTrainingDataVersion();
}

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);
const WEEKS = [56, 49, 42, 35, 28, 21, 14, 7, 1];

function plan() {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Upper",
      items: [
        { exercise: "Barbell Bench Press", muscle_group: "chest", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
        { exercise: "Rope Pushdown", muscle_group: "triceps", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 },
      ],
    },
  ]);
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-200));
}

function session(exercise, daysAgo, weight, reps, rir = null) {
  for (const r of reps)
    repo.logSetByName({ exercise, weight, reps: r, date: day(-daysAgo), ...(rir == null ? {} : { rir }) });
}

// A pushdown stuck at 50 for 12, 11, 10 every week; a bench stuck at 135 for 8, 7, 6.
function stuck() {
  repo.upsertExercise({ name: "Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  for (const d of WEEKS) {
    session("Rope Pushdown", d, 50, [12, 11, 10]);
    session("Barbell Bench Press", d, 135, [8, 7, 6]);
  }
}

// ---- 1. the surface ------------------------------------------------------------------

test("the capability surface carries each in-plan unit's next lever; the bare read does not", () => {
  plan();
  stuck();
  const bare = capabilityRead(today());
  assert.ok(bare.units.every((u) => !("next" in u)), "capabilityRead itself never calls the ladder");
  const read = capabilityWithLadder(today());
  const pushdown = read.units.find((u) => u.key === "triceps:pushdown");
  assert.equal(pushdown.next?.lever, "rep_scheme", JSON.stringify(pushdown.next));
  assert.equal(pushdown.next.plan_lift, "Rope Pushdown");
  assert.deepEqual(pushdown.next.rep_range, { rep_low: 13, rep_high: 15 });
  assert.equal(pushdown.next.candidate, null);
  assert.equal(violatesReadingGrammar(pushdown.next.reason), null, pushdown.next.reason);
  // The ladder and the surface say the same thing.
  const rung = unitPlateauLadder(today()).units.find((u) => u.unit_key === "triceps:pushdown");
  assert.equal(pushdown.next.lever, rung.lever);
  assert.equal(pushdown.next.reason, rung.reason);
});

test("an off-plan unit carries no next lever, and a failed read is the bare read", () => {
  plan();
  stuck();
  for (const d of [21, 14, 7]) session("Leg Extension", d, 90, [12, 12, 12]);
  const read = capabilityWithLadder(today());
  for (const unit of read.units.filter((u) => !u.in_plan)) assert.equal(unit.next, undefined, unit.key);
  const nothing = capabilityWithLadder("not-a-date");
  assert.equal(typeof nothing.available, "boolean");
});

function loadClient() {
  const context = { Object, String, Number, Array, stagger: (i) => `--i:${i}` };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-capability-client.js"), "utf8"), context);
  return context.CairnProgressCapability;
}

const clientUnit = (over) => ({
  key: "triceps:pushdown",
  label: "Pushdown",
  kind: "region",
  compound: false,
  in_plan: true,
  verdict: "holding",
  qualifiers: [],
  hard_sets_trend: null,
  line: "Your pushdown strength is holding steady.",
  contributors: [],
  ...over,
});
const nextOf = (lever, over = {}) => ({ lever, reason: "r", plan_lift: "Rope Pushdown", candidate: null, ...over });

test("Progress shows the next lever as one quiet line, only when there is one to pull", () => {
  const cap = loadClient();
  assert.equal(cap.capNextLine(nextOf("rep_scheme")), "Next: a higher rep range at the same weight");
  assert.equal(cap.capNextLine(nextOf("set_quality")), "Next: take the sets a little closer to failure");
  assert.equal(cap.capNextLine(nextOf("volume")), "Next: one more set");
  assert.equal(cap.capNextLine(nextOf("variation", { candidate: "Overhead Extension" })), "Next: rotate in Overhead Extension");
  assert.equal(cap.capNextLine(nextOf("variation")), "Next: a close variation");
  assert.equal(cap.capNextLine(nextOf("wait")), "");
  assert.equal(cap.capNextLine(nextOf("none")), "");
  assert.equal(cap.capNextLine(undefined), "");
  const html = (units) => cap.capabilityHtml({ available: true, date: "2026-11-24", overall: null, units, muscles: [] });
  const shown = html([clientUnit({ next: nextOf("rep_scheme") })]);
  assert.equal((shown.match(/pcap-next/g) ?? []).length, 1);
  assert.match(shown, /Next: a higher rep range at the same weight/);
  assert.doesNotMatch(html([clientUnit({ next: nextOf("wait") })]), /pcap-next|Next:/);
  assert.doesNotMatch(html([clientUnit({})]), /pcap-next|Next:/);
  // An off-plan unit never shows one, whatever it carries.
  assert.doesNotMatch(html([clientUnit({ in_plan: false, next: nextOf("volume") })]), /pcap-next|Next:/);
  // Escaped like every other string.
  assert.match(cap.capabilityHtml({ available: true, date: "x", overall: null, units: [clientUnit({ next: nextOf("variation", { candidate: "<b>X</b>" }) })], muscles: [] }), /&lt;b&gt;X&lt;\/b&gt;/);
});

// ---- 2. adaptations_due --------------------------------------------------------------

test("a holding movement's adaptation is the ladder's lever, never a second opinion", () => {
  plan();
  stuck();
  const st = repo.getProgramState(today());
  const text = st.adaptations_due.join(" | ");
  assert.match(text, /Move your pushdown work up a rep range at the same weight — Rope Pushdown/, text);
  assert.doesNotMatch(text, /Unstick|Deload your|Rotate a variation for your pushdown/, text);
  for (const line of st.adaptations_due.filter((a) => /your .* work/.test(a))) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\d/, line);
  }
});

test("a movement the ladder makes wait says nothing in adaptations_due", () => {
  plan();
  stuck();
  // Written yesterday: a fresh prescription waits to settle before the ladder pulls a lever.
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-1));
  const rung = unitPlateauLadder(today()).units.find((u) => u.unit_key === "triceps:pushdown");
  assert.equal(rung.lever, "wait", JSON.stringify(rung));
  const st = repo.getProgramState(today());
  assert.ok(!st.adaptations_due.some((a) => /pushdown work/.test(a)), st.adaptations_due.join(" | "));
});

test("the adaptation line is worded per lever, plain and without numbers", () => {
  const rung = (lever, extra = {}) => ({ lever, plan_lift: { exercise: "Rope Pushdown" }, ...extra });
  assert.equal(ladderCallLine(null, "pushdown", "Rope Pushdown"), null);
  assert.equal(ladderCallLine(rung("wait"), "pushdown", "Rope Pushdown"), null);
  assert.equal(ladderCallLine(rung("none"), "pushdown", "Rope Pushdown"), null);
  for (const lever of ["rep_scheme", "set_quality", "volume", "variation"]) {
    const line = ladderCallLine(rung(lever, { candidate: { exercise: "Overhead Extension" } }), "pushdown", "X");
    assert.ok(line && /your pushdown/.test(line) && /Rope Pushdown/.test(line), line);
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\d/);
  }
  assert.match(ladderCallLine(rung("variation", { candidate: { exercise: "Overhead Extension" } }), "pushdown", "X"), /Overhead Extension in for Rope Pushdown/);
});

// ---- 3. the engine defers its rotation -----------------------------------------------

test("the engine's own rotation on a plateaued lift defers to the ladder's lever, at the same load", () => {
  repo.upsertExercise({ name: "Triceps Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  repo.savePlanDay(4, "Upper", "Upper", [
    { exercise: "Triceps Rope Pushdown", sets: 3, rep_low: 12, rep_high: 15, target_weight: 50 },
  ]);
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-90));
  // Flat for weeks at one load, RIR 2: the engine's own read is a rotation.
  for (const d of [35, 28, 21, 14, 7, 2])
    repo.logSetByName({ exercise: "Triceps Rope Pushdown", weight: 50, reps: 12, rir: 2, date: day(-d) });
  const rung = ladderRungForLift(unitPlateauLadder(today()), "Triceps Rope Pushdown", "triceps");
  assert.ok(rung, "the ladder covers the movement");
  const p = nextPrescription("Triceps Rope Pushdown");
  if (rung.lever === "variation") {
    assert.equal(p.action, "vary");
  } else {
    assert.equal(p.action, "hold", `the rotation waits for the ladder (${rung.lever}/${rung.code})`);
    assert.equal(p.why, rung.reason, "and the card says the ladder's own reason");
    assert.ok(!p.vary_to && !p.vary_options, "no menu rides along");
  }
  assert.equal(p.suggested.weight, 50, "the load never moves");
});

// ---- 4. the evolution trigger counts movements ---------------------------------------

const capOf = (units) => ({ available: true, overall: null, units, muscles: [] });
const capUnit = (key, verdict, lifts, extra = {}) => ({
  key,
  label: key,
  compound: true,
  in_plan: true,
  verdict,
  qualifiers: [],
  line: "",
  lifts: lifts.map((exercise, i) => ({ exercise, exercise_id: 100 + i, in_plan: true, resting: false })),
  plan_lift: lifts[0],
  exposures: 6,
  ...extra,
});
const triggerOpts = (programState) => ({
  programState,
  balance: { due: [], over: [] },
  testWeek: { due: false },
  enduranceTests: [],
});

test("the evolution trigger: a stalled variant inside a climbing movement is no reason; two variants of one movement are one", () => {
  const lifts = [
    { exercise: "Incline Dumbbell Press", suggested_action: "vary", status: "plateaued", in_plan: true },
    { exercise: "Incline Barbell Press", suggested_action: "vary", status: "plateaued", in_plan: true },
  ];
  const climbing = programEvolutionTrigger(today(), triggerOpts({ lifts, capability: capOf([capUnit("incline", "climbing", ["Incline Dumbbell Press", "Incline Barbell Press"])]) }));
  assert.doesNotMatch(climbing.signature, /vary:/, climbing.signature);
  const cut = programEvolutionTrigger(today(), triggerOpts({ lifts, capability: capOf([capUnit("incline", "holding", ["Incline Dumbbell Press", "Incline Barbell Press"], { qualifiers: ["cut"] })]) }));
  assert.doesNotMatch(cut.signature, /vary:/, "holding through the cut is the plan working");
  const holding = programEvolutionTrigger(today(), triggerOpts({ lifts, capability: capOf([capUnit("incline", "holding", ["Incline Dumbbell Press", "Incline Barbell Press"])]) }));
  assert.match(holding.signature, /vary:Incline Barbell Press(?!,)/, holding.signature);
  // With no capability read on the state, the lift calls stand as they always did.
  const legacy = programEvolutionTrigger(today(), triggerOpts({ lifts }));
  assert.match(legacy.signature, /vary:Incline Barbell Press,Incline Dumbbell Press/);
});

// ---- 5. the under-fuelling performance channel counts movements -----------------------

const goal = { leanness_rate: { lean_ideal_rate_lb: 0.6, safe_max_rate_lb: 0.85 } };
const performanceOf = (programState) =>
  underfuelingRead(today(), { expenditure: null, goal, programState, wholePerson: null }).channels.find(
    (c) => c.key === "performance"
  );

test("the under-fuelling performance channel reads strain over movements, not variants", () => {
  // Two regressing variants of ONE movement used to be two declining lifts.
  const lifts = [
    { exercise: "Bench Press", status: "regressing", last_trained: day(-2) },
    { exercise: "Dumbbell Bench Press", status: "regressing", last_trained: day(-3) },
    { exercise: "Back Squat", status: "progressing", last_trained: day(-2) },
  ];
  const legacy = performanceOf({ lifts });
  assert.equal(legacy.direction, "strain", "precondition: the lift tally reads strain");
  const oneMovement = performanceOf({
    lifts,
    capability: capOf([
      capUnit("flat", "slipping", ["Bench Press", "Dumbbell Bench Press"]),
      capUnit("squat", "climbing", ["Back Squat"]),
    ]),
  });
  assert.notEqual(oneMovement.direction, "strain", "one easing movement beside a climbing one is not strain");
  assert.ok(oneMovement.evidence_keys.some((k) => /^capability\.units:/.test(k)), oneMovement.evidence_keys.join(","));
  // Two independent movements easing, none climbing: strain.
  const two = performanceOf({
    lifts,
    capability: capOf([capUnit("flat", "slipping", ["Bench Press"]), capUnit("squat", "slipping", ["Back Squat"])]),
  });
  assert.equal(two.direction, "strain");
  // Nothing explains a unit away in the under-fuelling read (the lift tally it replaced
  // never exempted a run build or the cut): two movements easing is strain either way.
  const runBuild = performanceOf({
    lifts,
    capability: capOf([
      capUnit("flat", "slipping", ["Bench Press"]),
      capUnit("squat", "slipping", ["Back Squat"], { qualifiers: ["run_build"] }),
    ]),
  });
  assert.equal(runBuild.direction, "strain");
  // A resting movement (every lift out of the rotation) is never a witness.
  const resting = performanceOf({
    lifts,
    capability: capOf([
      capUnit("flat", "slipping", ["Bench Press"]),
      capUnit("squat", "climbing", ["Back Squat"]),
      {
        ...capUnit("hinge", "slipping", ["Romanian Deadlift"]),
        in_plan: false,
        lifts: [{ exercise: "Romanian Deadlift", exercise_id: 7, in_plan: false, resting: true, current: false }],
      },
    ]),
  });
  assert.notEqual(resting.direction, "strain");
});

test("on the lift tally a resting lift never counts", () => {
  const lifts = [
    { exercise: "Bench Press", status: "regressing", last_trained: day(-2), resting: true },
    { exercise: "Back Squat", status: "regressing", last_trained: day(-2), resting: true },
  ];
  assert.notEqual(performanceOf({ lifts }).direction, "strain");
});

// ---- 6. the prompts ------------------------------------------------------------------

test("the ladder rides the plan sites and both chat sites, and the plan prompts follow it", () => {
  for (const site of ["coach", "program_evolution", "chat", "chat_core"]) {
    assert.ok(PROMPT_CONTEXT_SITES[site].keys.includes("unit_plateau"), site);
  }
  for (const site of ["daily_composition", "week_compose", "health_review"]) {
    assert.ok(!PROMPT_CONTEXT_SITES[site].keys.includes("unit_plateau"), site);
  }
  const entry = { unit: "Flat press", compound: true, lever: "variation", lift: "Barbell Bench Press", since: "2026-10-01", reason: "r", candidate: "Dumbbell Bench Press" };
  assert.deepEqual(projectCoachContext({ unit_plateau: [entry], now: {} }, "program_evolution").unit_plateau, [entry]);
  assert.match(PLATEAU_LADDER_RULE, /DATA\.unit_plateau/);
  assert.match(PLATEAU_LADDER_RULE, /rather than inventing a different one/);
  assert.match(PLATEAU_LADDER_RULE, /at most ONE anchor per block/);
});

test("the movement list prints the ladder's lever when the ladder rides along", () => {
  const ctx = (unit_plateau) => ({
    program_state: { headline: "x", lifts: [{ exercise: "Bench Press", status: "plateaued", suggested_action: "vary", stall_signals: [], why: "", resting: false }] },
    capability: {
      overall: null,
      units: [
        { movement: "flat press", verdict: "holding", lifts: ["Bench Press"] },
        { movement: "pushdown", verdict: "holding", lifts: ["Rope Pushdown"] },
        { movement: "row", verdict: "slipping", lifts: ["Seated Row"] },
      ],
      muscles: [],
    },
    ...(unit_plateau ? { unit_plateau } : {}),
  });
  const text = renderProgramState(ctx([{ unit: "Flat press", compound: true, lever: "rep_scheme", lift: "Bench Press", since: null, reason: "r" }]));
  assert.match(text, /flat press \[holding\] \(Bench Press\) → next: a higher rep range at the same weight \(Bench Press\)/);
  assert.match(text, /pushdown \[holding\] \(Rope Pushdown\) → wait/);
  assert.match(text, /row \[slipping\] \(Seated Row\) → back off/);
  assert.doesNotMatch(text, /Bench Press vary/, "the lift's own tell is not printed beside the ladder");
  // A partial context with no ladder keeps the lift's own tell.
  assert.match(renderProgramState(ctx(null)), /flat press \[holding\] \(Bench Press\) → Bench Press vary/);
});

test("the coach context carries the ladder for a stalled plan", () => {
  plan();
  stuck();
  const ctx = repo.getCoachContext();
  assert.ok(Array.isArray(ctx.unit_plateau));
  const pushdown = ctx.unit_plateau.find((u) => u.lift === "Rope Pushdown");
  assert.equal(pushdown?.lever, "rep_scheme", JSON.stringify(ctx.unit_plateau));
  assert.equal(pushdown.compound, false);
});

// ---- 7. the enrichment prompt --------------------------------------------------------

test("the exercise enrichment prompt never carries the lift's constraint note", async () => {
  const { buildExerciseEnrichPrompt } = await import("../dist/prompt/program.js");
  const prompt = buildExerciseEnrichPrompt({
    name: "Rope Pushdown",
    muscle_group: "triceps",
    equipment: "a cable machine",
    constraint_note: "left elbow flares after the surgery",
  });
  assert.ok(!prompt.includes("flares"), "the note text is not sent");
  assert.ok(!prompt.includes("constraint_note"), "nor its key");
  assert.ok(prompt.includes("a cable machine") && prompt.includes("triceps"), "the lift's own facts still are");
});
