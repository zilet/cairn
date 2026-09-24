// The weekly volume floor and the log-driven set count. Invariants under test:
//   1. the plan compiler warns `muscle_density_low` for a priority group under its
//      low landmark — only for a muscle/strength intent, never for a group endurance
//      already carries, never in a deliberate light week, never with no context;
//   2. a redraw/evolution draft that starves a priority group is a server-computed
//      breach the verify turn must repair; an unrepaired one stays `unresolved` and
//      the draft waits for the athlete instead of landing quietly;
//   3. the plan's set count catches up (+1 per step, capped) when the last two
//      exposures each logged more good working sets than prescribed;
//   4. timed-work guards — RIR is accepted 0–10 at the log chokepoint and read only
//      in range, a carry logged as reps holds with a "log it as time" reason, and a
//      new carry/hold is created timed.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, repo } from "./_seed.js";
import { validateTrainingPlan, plannedWeeklyGroupSets } from "../dist/repo/plan-quality.js";
import { weeklySetTargets } from "../dist/repo/volume-floor.js";
import { readVolumeFloorContext, weeklySetTargetsRead } from "../dist/repo/volume-floor-context.js";
import { draftPlanWeek, planDraftFloorPrecheck, planVolumeFloorViolations } from "../dist/repo/verify-floors.js";
import { athleteAskedForLess } from "../dist/repo/volume-floor.js";
import { scheduleRecoveryCycle } from "../dist/repo/recovery-cycles.js";
import { addDaysISO } from "../dist/repo/shared.js";
import { buildProgressionProposal, planDayProgression } from "../dist/repo/progression.js";
import { setEffortWeight } from "../dist/repo/exercise-variations.js";
import { plausibleRir } from "../dist/lib/numbers.js";
import * as blocks from "../dist/repo/program-blocks.js";
import { localDateISO } from "../dist/repo/shared.js";
import { evolveProgram } from "../dist/coachOps.js";
import { savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import { buildPlanDraftVerifyPrompt, buildProgramEvolutionPrompt } from "../dist/prompt.js";

const HYPERTROPHY = { strength_priority: true, muscle_priority: true, endurance_carried: [], exempt: null };
const STRENGTH_ONLY = { strength_priority: true, muscle_priority: false, endurance_carried: [], exempt: null };

// A week that clears every major-group floor (chest 10, back 10, shoulders 8, quads 8,
// hamstrings 6, glutes 6 in effective sets) — groups are named so nothing rides on
// name classification.
function fedWeek() {
  return [
    {
      day_number: 1,
      name: "Upper",
      items: [
        { exercise: "Barbell Bench Press", muscle_group: "chest", sets: 5, rep_low: 6, rep_high: 8 },
        { exercise: "Incline Dumbbell Press", muscle_group: "chest", sets: 5, rep_low: 8, rep_high: 10 },
        { exercise: "Barbell Overhead Press", muscle_group: "shoulders", sets: 4, rep_low: 6, rep_high: 8 },
        { exercise: "Biceps Curl", muscle_group: "biceps", sets: 3, rep_low: 10, rep_high: 12 },
        { exercise: "Triceps Pushdown", muscle_group: "triceps", sets: 3, rep_low: 10, rep_high: 12 },
      ],
    },
    {
      day_number: 2,
      name: "Lower",
      items: [
        { exercise: "Back Squat", muscle_group: "quads", sets: 4, rep_low: 5, rep_high: 8 },
        { exercise: "Bulgarian Split Squat", muscle_group: "quads", sets: 4, rep_low: 8, rep_high: 10 },
        { exercise: "Romanian Deadlift", muscle_group: "hamstrings", sets: 4, rep_low: 8, rep_high: 10 },
        { exercise: "Lying Leg Curl", muscle_group: "hamstrings", sets: 2, rep_low: 10, rep_high: 12 },
        { exercise: "Standing Calf Raise", muscle_group: "calves", sets: 6, rep_low: 12, rep_high: 15 },
      ],
    },
    {
      day_number: 3,
      name: "Pull",
      items: [
        { exercise: "Seated Cable Row", muscle_group: "back", sets: 5, rep_low: 8, rep_high: 12 },
        { exercise: "Lat Pulldown", muscle_group: "back", sets: 5, rep_low: 8, rep_high: 12 },
      ],
    },
  ];
}

// The observed failure shape: most movements at one or two working sets.
function thinWeek() {
  return fedWeek().map((day) => ({
    ...day,
    items: day.items.map((item) => ({ ...item, sets: item.sets >= 5 ? 2 : 1 })),
  }));
}

const lowGroups = (report) =>
  report.warnings
    .filter((w) => w.code === "muscle_density_low")
    .map((w) => w.muscle_group)
    .sort();

function resetTraining() {
  for (const t of [
    "daily_session_outcomes",
    "daily_session_compositions",
    "logged_sets",
    "plan_items",
    "plan_days",
    "sessions",
    "exercises",
    "program_blocks",
    "plan_proposals",
    "activities",
    "brain_decisions",
    "recovery_cycles",
  ]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
}

beforeEach(() => resetTraining());

// ------------------------------------------------ 1. under-dose in plan quality

test("a thin week under a muscle/strength intent warns muscle_density_low per starved group", () => {
  const report = validateTrainingPlan(thinWeek(), { volumeFloor: HYPERTROPHY });
  assert.equal(report.ok, true, "under-dosing is a warning, never an error");
  assert.deepEqual(lowGroups(report), [
    "back",
    "biceps",
    "calves",
    "chest",
    "glutes",
    "hamstrings",
    "quads",
    "shoulders",
    "triceps",
  ]);
  const chest = report.warnings.find((w) => w.muscle_group === "chest");
  assert.match(chest.message, /below the low weekly landmark/);
});

test("a fed week reads clean, and the same thin week with no context reads clean too", () => {
  assert.deepEqual(lowGroups(validateTrainingPlan(fedWeek(), { volumeFloor: HYPERTROPHY })), []);
  assert.deepEqual(lowGroups(validateTrainingPlan(thinWeek())), [], "no context → no floor, as before");
});

test("the floor is contextual: light weeks, endurance-led intent and endurance-carried groups are exempt", () => {
  const thin = thinWeek();
  for (const exempt of ["recovery_week", "deload_phase"])
    assert.deepEqual(lowGroups(validateTrainingPlan(thin, { volumeFloor: { ...HYPERTROPHY, exempt } })), []);
  assert.deepEqual(
    lowGroups(
      validateTrainingPlan(thin, { volumeFloor: { ...HYPERTROPHY, strength_priority: false, muscle_priority: false } })
    ),
    []
  );
  // A runner's calves: carried by the running, never called under-dosed. The legs'
  // lifting prime movers are never on the carried list (that rule lives in progression).
  const noCalves = fedWeek().map((day) => ({ ...day, items: day.items.filter((i) => i.muscle_group !== "calves") }));
  assert.deepEqual(lowGroups(validateTrainingPlan(noCalves, { volumeFloor: HYPERTROPHY })), ["calves"]);
  assert.deepEqual(
    lowGroups(validateTrainingPlan(noCalves, { volumeFloor: { ...HYPERTROPHY, endurance_carried: ["calves"] } })),
    []
  );
});

test("arms and calves are held to the floor only when muscle itself is a priority", () => {
  const groups = weeklySetTargets(STRENGTH_ONLY).map((t) => t.group);
  assert.deepEqual(groups, ["chest", "back", "shoulders", "quads", "hamstrings", "glutes"]);
  assert.ok(!lowGroups(validateTrainingPlan(thinWeek(), { volumeFloor: STRENGTH_ONLY })).includes("biceps"));
  assert.ok(weeklySetTargets(HYPERTROPHY).some((t) => t.group === "biceps"));
});

test("a one-day fragment is not measured as a week", () => {
  assert.deepEqual(lowGroups(validateTrainingPlan([thinWeek()[0]], { volumeFloor: HYPERTROPHY })), []);
});

test("the live context reads the athlete's intent and the plan quality tool carries the warning", () => {
  repo.setProfile({
    training_intent: { priorities: ["muscle", "strength", "longevity"], endurance_role: "supporting" },
  });
  const ctx = readVolumeFloorContext();
  assert.equal(ctx.muscle_priority, true);
  assert.equal(ctx.exempt, null);
  repo.replacePlan(thinWeek());
  const quality = repo.getPlanQuality();
  assert.ok(quality.warnings.some((w) => w.code === "muscle_density_low" && w.muscle_group === "chest"));
  const read = weeklySetTargetsRead();
  assert.equal(read.applies, true);
  const chest = read.targets.find((t) => t.group === "chest");
  assert.equal(chest.low, 10);
  assert.equal(chest.planned, plannedWeeklyGroupSets(repo.getPlan()).get("chest"));

  repo.setProfile({
    training_intent: { priorities: ["endurance", "longevity", "strength"], endurance_role: "primary" },
  });
  assert.ok(!repo.getPlanQuality().warnings.some((w) => w.code === "muscle_density_low"), "endurance-led: no floor");

  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  blocks.createBlock({ goal: "Ease off", focus: "hypertrophy", total_weeks: 6, week_index: 6, phase: "deload" });
  assert.equal(readVolumeFloorContext().exempt, "deload_phase");
  assert.ok(!repo.getPlanQuality().warnings.some((w) => w.code === "muscle_density_low"), "a deload week is exempt");
});

// ------------------------------------------ 2. the redraw volume precheck

test("a draft that drops a fed group under its floor is a breach; an old shortfall is grandfathered", () => {
  const breaches = planVolumeFloorViolations(thinWeek(), fedWeek(), HYPERTROPHY);
  assert.ok(breaches.length > 0);
  assert.ok(breaches.every((b) => b.code === "plan_group_below_volume_floor"));
  const chest = breaches.find((b) => /^chest\b/.test(b.message));
  assert.equal(chest.floor, 10);
  assert.equal(chest.observed, plannedWeeklyGroupSets(thinWeek()).get("chest"));

  // The current plan was already thin: the same week is not a new breach…
  assert.deepEqual(planVolumeFloorViolations(thinWeek(), thinWeek(), HYPERTROPHY), []);
  // …but taking an already-short group lower still is.
  const thinner = thinWeek().map((day) => ({
    ...day,
    items: day.items.filter((i) => i.exercise !== "Incline Dumbbell Press"),
  }));
  const deeper = planVolumeFloorViolations(thinner, thinWeek(), HYPERTROPHY);
  assert.ok(
    deeper.some((b) => /^chest would drop/.test(b.message)),
    "a deeper shortfall is flagged"
  );
  // No priority → nothing to check.
  assert.deepEqual(planVolumeFloorViolations(thinWeek(), fedWeek(), null), []);
});

test("a changes[] draft is measured on the week it would leave behind", () => {
  const current = fedWeek();
  const draft = {
    summary: "trim",
    changes: [
      { day_number: 1, exercise: "Incline Dumbbell Press", remove: true, reason: "rotate out" },
      { day_number: 1, exercise: "Barbell Bench Press", sets: 2, reason: "less" },
      { day_number: 3, swap: { from: "Lat Pulldown", to: "Chin-Up" }, sets: 4, reason: "variety" },
      { day_number: 2, exercise: "Walking Lunge", sets: 3, reason: "add" },
    ],
  };
  const week = draftPlanWeek(draft, current);
  const day1 = week.find((d) => d.day_number === 1).items.map((i) => [i.exercise, i.sets]);
  assert.ok(!day1.some(([name]) => name === "Incline Dumbbell Press"));
  assert.deepEqual(
    day1.find(([name]) => name === "Barbell Bench Press"),
    ["Barbell Bench Press", 4],
    "5 → 2 lands as apply would land it: one step, to 4"
  );
  assert.deepEqual(
    week.find((d) => d.day_number === 3).items.find((i) => i.exercise === "Chin-Up").sets,
    4,
    "a swap renames the slot and carries its sets"
  );
  assert.ok(week.find((d) => d.day_number === 2).items.some((i) => i.exercise === "Walking Lunge"));
  assert.equal(current[0].items.length, 5, "the current plan is never mutated");
  const breaches = planVolumeFloorViolations(week, current, HYPERTROPHY);
  assert.ok(
    breaches.some((b) => /^chest\b/.test(b.message)),
    "chest fell from 10 to 4"
  );
});

test("a recovery-week draft is exempt from the precheck", () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(fedWeek());
  assert.ok(planDraftFloorPrecheck({ summary: "thin", days: thinWeek() }).violations.length > 0);
  const recovery = planDraftFloorPrecheck(
    { summary: "thin", days: thinWeek() },
    { instruction: "Reshape next week into a RECOVERY week" }
  );
  assert.deepEqual(recovery.violations, []);
  assert.equal(recovery.judgment_applies, false, "a plan draft carries no judgement-only turn");
});

test("the plan-shaping prompts carry the targets and the repair prompt carries the breach", () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(thinWeek());
  const evolution = buildProgramEvolutionPrompt("evolve");
  assert.match(evolution, /WEEKLY VOLUME FLOOR/);
  const data = JSON.parse(evolution.split("\n").at(-1));
  assert.equal(data.weekly_set_targets.applies, true);
  assert.ok(data.weekly_set_targets.targets.some((t) => t.group === "chest" && t.low === 10));

  const breaches = planVolumeFloorViolations(thinWeek(), fedWeek(), HYPERTROPHY);
  const repair = buildPlanDraftVerifyPrompt({ summary: "thin", days: thinWeek() }, breaches);
  assert.match(repair, /plan_group_below_volume_floor/);
  assert.match(repair, /Never\s+add a lifting day/);
});

// A one-off agents.json whose single agent answers with `body` for any prompt.
function withAgent(name, body, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-volume-agent-"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      [name]: {
        command: "sh",
        args: ["-c", `printf '%s' ${JSON.stringify(body)}`],
        input: "arg",
        description: "test double",
        env_required: [],
        capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      },
    })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = file;
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
  });
}

test("an evolution that starves a fed group is never shipped as clean: unresolved, and it waits", async () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(fedWeek());
  const draft = { summary: "A leaner week.", days: thinWeek() };
  // The same double answers the verify turn with the draft again — not a verify
  // verdict — so the repair never happens and the server's findings must survive.
  const out = await withAgent("thin-drafter", JSON.stringify(draft), () =>
    evolveProgram("thin-drafter", "evolve program")
  );
  assert.equal(out.ok, true);
  assert.ok(out.verified?.unresolved?.length, "the breach is surfaced on the outcome");
  assert.match(out.verified.unresolved.join(" "), /chest/);
  assert.ok(out.proposal.parsed.volume_floor_unresolved?.length, "…and on the stored draft");
  assert.equal(out.autonomy?.tier, "ask", `held for the athlete, got ${JSON.stringify(out.autonomy)}`);
  assert.equal(plannedWeeklyGroupSets(repo.getPlan()).get("chest"), 10, "the fed plan is untouched");
});

// ------------------------------------------------ 3. the log is truth for set count

function isoDaysAgo(n) {
  return localDateISO(new Date(Date.now() - n * 864e5));
}

// A slot authored before any of the fixture's logs (a pre-v111 row reads as settled),
// so only what a test adds on top — a redraw, a person's save — moves the window.
function settle() {
  db.prepare(`UPDATE plan_items SET prescribed_at = NULL`).run();
}

function logSets(name, date, sets) {
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(date, null);
  sets.forEach(([weight, reps], i) => {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(session.id, ex.id, i + 1, weight, reps);
  });
}

function seedCurl({
  planned = 2,
  sessions = [
    [
      [40, 11],
      [40, 11],
      [40, 11],
    ],
    [
      [40, 11],
      [40, 11],
      [40, 11],
    ],
  ],
} = {}) {
  repo.upsertExercise({ name: "Dumbbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.savePlanDay(1, "Arms", null, [
    { exercise: "Dumbbell Curl", sets: planned, rep_low: 10, rep_high: 12, target_weight: 40 },
  ]);
  settle();
  sessions.forEach((sets, i) => logSets("Dumbbell Curl", isoDaysAgo(9 - i * 4), sets));
}

const curlOf = (day = 1) =>
  planDayProgression(day, { forNextSession: true }).find((p) => p.exercise === "Dumbbell Curl");

test("two exposures each logging more good sets than prescribed raise the plan one set", () => {
  seedCurl();
  const p = curlOf();
  assert.deepEqual(p.set_step, { from: 2, to: 3 });
  assert.equal(p.suggested.sets, 3);
  assert.match(p.why, /3/);
  const built = buildProgressionProposal(1, { forNextSession: true });
  assert.equal(built.ok, true, "a set catch-up is a real plan change even on a hold");
  const change = built.proposal.parsed.changes.find((c) => c.exercise === "Dumbbell Curl");
  assert.equal(change.sets, 3);
  assert.equal(repo.applyProposal(built.proposal.id).ok, true);
  assert.equal(repo.getPlanDay(1).items[0].sets, 3, "the plan now says what the log said");
});

test("one step at a time, never past what was logged, never past four", () => {
  seedCurl({ planned: 1, sessions: [Array(6).fill([40, 11]), Array(6).fill([40, 11])] });
  assert.deepEqual(curlOf().set_step, { from: 1, to: 2 }, "+1 per step even when six were logged");
  resetTraining();
  seedCurl({ planned: 4, sessions: [Array(6).fill([40, 11]), Array(6).fill([40, 11])] });
  assert.equal(curlOf().set_step, undefined, "four is the cap");
});

test("warm-ups, short sets and a single exposure do not raise the plan", () => {
  // The third set is a ramp-up warm-up (under 55% of the top load) both days.
  seedCurl({
    sessions: [
      [
        [15, 12],
        [40, 11],
        [40, 11],
      ],
      [
        [15, 12],
        [40, 11],
        [40, 11],
      ],
    ],
  });
  assert.equal(curlOf().set_step, undefined, "a warm-up is not a working set");
  resetTraining();
  // The extra set fell well short of the rep floor both days.
  seedCurl({
    sessions: [
      [
        [40, 11],
        [40, 11],
        [40, 4],
      ],
      [
        [40, 11],
        [40, 11],
        [40, 3],
      ],
    ],
  });
  assert.equal(curlOf().set_step, undefined, "a failed extra set is not the log vouching for more");
  resetTraining();
  seedCurl({
    sessions: [
      [
        [40, 11],
        [40, 11],
        [40, 11],
      ],
    ],
  });
  assert.equal(curlOf().set_step, undefined, "one exposure is not a pattern");
});

test("a deload phase never adds sets", () => {
  blocks.createBlock({ goal: "Ease off", focus: "hypertrophy", total_weeks: 6, week_index: 6, phase: "deload" });
  seedCurl();
  assert.equal(curlOf().set_step, undefined);
});

// ---------------------------------------- review fixes: light weeks and the clamp

test("only an explicit request for a lighter or smaller week reads as asking for less", () => {
  for (const words of [
    "make it easy this week",
    "make next week lighter",
    "a lighter week please",
    "deload next week",
    "fewer sets this week",
    "fewer training days for now",
    "less volume for a bit",
    "cut back on volume",
    "scale it back this week",
    "I'm short on time",
    "I'm travelling this week",
    "away next week, keep it simple",
  ])
    assert.equal(athleteAskedForLess(words), true, words);
  for (const words of [
    "less cardio, more lifting",
    "I'm sore in my knee",
    "I'm sick of lunges, swap them",
    "drop the leg extension and add incline press",
    "move my rest day to Wednesday",
    "I want to lift 3 days a week instead of 2",
    "shorter rest times between sets please",
    "back from my trip, ramp me up",
    "at minimum 4 sets of chest",
    "fewer machines, more free weights",
    "I want to recover my bench strength",
    "no pain anymore, push me",
    "don't make it lighter",
    "move heavy legs to Thursday",
    "",
  ])
    assert.equal(athleteAskedForLess(words), false, words);
});

test("the athlete's words never switch off the precheck or the prompt's targets", () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(fedWeek());
  const thin = { summary: "thin", days: thinWeek() };
  assert.ok(planDraftFloorPrecheck(thin, { instruction: "make next week lighter" }).violations.length > 0);
  const data = JSON.parse(buildProgramEvolutionPrompt("make next week lighter").split("\n").at(-1));
  assert.equal(data.weekly_set_targets.applies, true, "wording alone never flips applies:false");
  const repair = buildPlanDraftVerifyPrompt(thin, planVolumeFloorViolations(thinWeek(), fedWeek(), HYPERTROPHY), {
    athlete_request: "make next week lighter",
  });
  assert.match(repair, /make next week lighter/, "the repair turn is handed their words");
});

test("an athlete-asked lighter redraw still gets checked, but is never held against them", async () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(fedWeek());
  const draft = { summary: "A lighter week, as asked.", days: thinWeek() };
  const out = await withAgent("light-drafter", JSON.stringify(draft), () =>
    evolveProgram("light-drafter", "restructure the week as the athlete asked — make it lighter this week")
  );
  assert.equal(out.ok, true);
  assert.ok(out.verified?.unresolved?.length, "the server's findings still ride on the outcome");
  assert.notEqual(out.autonomy?.tier, "ask", `not held, got ${JSON.stringify(out.autonomy)}`);
  const held = repo.getProposal(Number(out.proposal.id));
  assert.notEqual(held.autonomy?.review_reason_code, "safety_floor");
});

test("a held draft names the groups it would leave under their floor", async () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(fedWeek());
  const draft = { summary: "A leaner week.", days: thinWeek() };
  const out = await withAgent("thin-drafter", JSON.stringify(draft), () => evolveProgram("thin-drafter", "evolve program"));
  const held = repo.getProposal(Number(out.proposal.id));
  assert.equal(held.autonomy?.review_reason_code, "safety_floor");
  const reason = held.autonomy.reasons.join(" ");
  assert.match(reason, /chest/);
  assert.match(reason, /under their weekly set floor/);
  assert.doesNotMatch(reason, /\d/, "the hold speaks groups, not set arithmetic");
});

test("light weeks the context reads exempt the floor: a scheduled recovery week and a deload next week", () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(thinWeek());
  assert.equal(readVolumeFloorContext().exempt, null);
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 3), reason: "a planned light week" });
  assert.equal(readVolumeFloorContext().exempt, "recovery_week", "scheduled within the landing week");
  assert.equal(weeklySetTargetsRead().applies, false, "the prompt reads applies:false then");
  assert.ok(!repo.getPlanQuality().warnings.some((w) => w.code === "muscle_density_low"));
  resetTraining();
  repo.replacePlan(thinWeek());
  blocks.createBlock({ goal: "Build", focus: "hypertrophy", total_weeks: 6, week_index: 5 });
  assert.equal(readVolumeFloorContext().exempt, "deload_phase", "the block's next week is its deload");
});

test("a changes[] draft is measured with apply's one-step set reduction, and a swap re-resolves its group", () => {
  const current = fedWeek();
  const week = draftPlanWeek(
    {
      summary: "trim",
      changes: [
        { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "less" },
        { day_number: 1, exercise: "Barbell Bench Press", sets: 1, reason: "again" },
        { day_number: 3, swap: { from: "Lat Pulldown", to: "Leg Press" }, reason: "odd swap" },
      ],
    },
    current
  );
  const bench = week.find((d) => d.day_number === 1).items.find((i) => i.exercise === "Barbell Bench Press");
  assert.equal(bench.sets, 4, "5 → 1 lands as 4, the one step apply would take, however often it is named");
  const swapped = week.find((d) => d.day_number === 3).items.find((i) => i.exercise === "Leg Press");
  assert.notEqual(swapped.muscle_group, "back", "the swapped slot no longer carries the old group");
  assert.ok((plannedWeeklyGroupSets(week).get("back") ?? 0) < 10, "back lost the swapped slot's sets");
});

test("back-off sets, a warm-up ramp and sets under the plan's load are not good working sets", () => {
  // Two top sets and a lighter back-off, both days.
  seedCurl({ sessions: [[[40, 11], [40, 11], [30, 12]], [[40, 11], [40, 11], [30, 12]]] });
  assert.equal(curlOf().set_step, undefined, "a back-off is not a working set");
  resetTraining();
  // A ramp that stops just short of the top load: 35 is under 90% of 40.
  seedCurl({ sessions: [[[35, 11], [40, 11], [40, 11]], [[35, 11], [40, 11], [40, 11]]] });
  assert.equal(curlOf().set_step, undefined, "a warm-up ramp is not a working set");
  resetTraining();
  // Every set is at one load, but under the plan's target of 40.
  seedCurl({ sessions: [[[35, 11], [35, 11], [35, 11]], [[35, 11], [35, 11], [35, 11]]] });
  assert.equal(curlOf().set_step, undefined, "sets under the prescribed load do not vouch for more");
});

test("an overload day takes the load step alone — never a set step on top", () => {
  // Every set capped the range: an earned load step.
  seedCurl({ sessions: [[[40, 12], [40, 12], [40, 12]], [[40, 12], [40, 12], [40, 12]]] });
  const p = curlOf();
  assert.equal(p.action, "overload");
  assert.ok(!p.rep_step);
  assert.equal(p.set_step, undefined, "one change at a time");
  assert.equal(p.suggested.sets, 2);
});

test("assisted work is compared signed: less assist is the harder set", () => {
  repo.upsertExercise({ name: "Assisted Dip", muscle_group: "triceps", mode: "reps" });
  repo.savePlanDay(1, "Push", null, [{ exercise: "Assisted Dip", sets: 2, rep_low: 8, rep_high: 12, target_weight: -30 }]);
  settle();
  for (const d of [9, 5]) logSets("Assisted Dip", isoDaysAgo(d), [[-30, 9], [-30, 9], [-30, 9]]);
  const p = planDayProgression(1, { forNextSession: true }).find((x) => x.exercise === "Assisted Dip");
  assert.ok(p.action === "hold" || p.rep_step, `a hold or rep step, got ${p.action}`);
  assert.deepEqual(p.set_step, { from: 2, to: 3 }, "assisted sets at the plan's assist count as working sets");
  resetTraining();
  repo.upsertExercise({ name: "Assisted Dip", muscle_group: "triceps", mode: "reps" });
  repo.savePlanDay(1, "Push", null, [{ exercise: "Assisted Dip", sets: 2, rep_low: 8, rep_high: 12, target_weight: -30 }]);
  settle();
  // The third set took far more assist: a back-off, not working volume.
  for (const d of [9, 5]) logSets("Assisted Dip", isoDaysAgo(d), [[-30, 9], [-30, 9], [-60, 9]]);
  const q = planDayProgression(1, { forNextSession: true }).find((x) => x.exercise === "Assisted Dip");
  assert.equal(q.set_step, undefined, "an extra set with much more assist is a back-off");
});

test("a redraw's set count stands until exposures after it argue with it", () => {
  // Three sets logged twice against a written three; the redraw then cuts it to two.
  seedCurl({ planned: 3, sessions: [Array(4).fill([40, 11]), Array(4).fill([40, 11])] });
  assert.deepEqual(curlOf().set_step, { from: 3, to: 4 }, "the fixture would step without the redraw");
  // A drafted week authors its set count on purpose: the slot is re-stamped today.
  repo.replacePlan(
    [{ day_number: 1, name: "Arms", items: [{ exercise: "Dumbbell Curl", sets: 2, rep_low: 10, rep_high: 12, target_weight: 40 }] }],
    { by: "restructure" }
  );
  assert.equal(curlOf().set_step, undefined, "older logs never walk a redraw's cut back");
  // …while a brain's own in-place set step is volume, not a new prescription.
  seedCurl();
  repo.applyPlanChange({ day_number: 1, exercise: "Dumbbell Curl", sets: 3 }, { clamp: true });
  assert.equal(
    db.prepare(`SELECT prescribed_at FROM plan_items`).get().prescribed_at,
    null,
    "a set step keeps the slot's stamp"
  );
});

test("a scheduled recovery week never adds sets", () => {
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 2), reason: "a planned light week" });
  seedCurl();
  assert.equal(curlOf().set_step, undefined);
});

test("a person's set cut in the editor is never walked back by older logs", () => {
  seedCurl({ planned: 3, sessions: [Array(4).fill([40, 11]), Array(4).fill([40, 11])] });
  assert.deepEqual(curlOf().set_step, { from: 3, to: 4 }, "the fixture would step without the save");
  savePlanDayByPerson(1, "Arms", null, [
    { exercise: "Dumbbell Curl", sets: 2, rep_low: 10, rep_high: 12, target_weight: 40 },
  ]);
  assert.equal(repo.getPlanDay(1).items[0].sets, 2);
  assert.equal(curlOf().set_step, undefined, "their 2 stands until new sessions argue with it");
  assert.equal(buildProgressionProposal(1, { forNextSession: true }).ok, false, "nothing proposes 2 → 3");
});

test("a person save that leaves sets alone keeps the slot's old stamp", () => {
  seedCurl();
  savePlanDayByPerson(1, "Arms (renamed)", null, [
    { exercise: "Dumbbell Curl", sets: 2, rep_low: 10, rep_high: 12, target_weight: 40 },
  ]);
  assert.deepEqual(curlOf().set_step, { from: 2, to: 3 }, "an untouched set count still catches up");
});

test("only a block whose own phase plan puts a deload next week is exempted, and never a two-week block", () => {
  repo.setProfile({ training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" } });
  repo.replacePlan(thinWeek());
  blocks.createBlock({ goal: "Short", focus: "hypertrophy", total_weeks: 2, week_index: 1 });
  assert.equal(readVolumeFloorContext().exempt, null, "a two-week block's first week is its only build week");
  blocks.createBlock({ goal: "Peak", focus: "peak", total_weeks: 4, week_index: 3 });
  assert.equal(readVolumeFloorContext().exempt, null, "a peak block ends in realization, not a deload");
  blocks.createBlock({ goal: "Build", focus: "hypertrophy", total_weeks: 6, week_index: 4 });
  assert.equal(readVolumeFloorContext().exempt, null, "two weeks out is still a building week");
});

// --------------------------------------------------------- 4. timed-work guards

test("RIR is accepted 0-10 at the log chokepoint; anything else is stored absent, the set kept", () => {
  const junk = repo.logSetByName({ exercise: "Goblet Squat", weight: 50, reps: 10, rir: 38 });
  assert.equal(junk.rir, null);
  assert.equal(junk.rir_ignored, true);
  assert.equal(db.prepare(`SELECT rir FROM logged_sets WHERE id = ?`).get(junk.id).rir, null);
  assert.equal(db.prepare(`SELECT reps FROM logged_sets WHERE id = ?`).get(junk.id).reps, 10, "the set itself stands");
  const good = repo.logSetByName({ exercise: "Goblet Squat", weight: 50, reps: 10, rir: 2 });
  assert.equal(good.rir, 2);
  assert.equal(good.rir_ignored, undefined);
  repo.updateSet(Number(good.id), { rir: 20 });
  assert.equal(
    db.prepare(`SELECT rir FROM logged_sets WHERE id = ?`).get(good.id).rir,
    null,
    "a correction is held to the same bound"
  );
  assert.equal(plausibleRir(10), 10);
  assert.equal(plausibleRir(-1), null);
  assert.equal(setEffortWeight(30), 1, "an out-of-range RIR does not halve a set's volume");
});

test("a carry logged as reps holds and asks for time instead of stepping on seconds", () => {
  repo.upsertExercise({ name: "Farmer's Carry", muscle_group: "forearms", mode: "reps" });
  repo.savePlanDay(1, "Grip", null, [
    { exercise: "Farmer's Carry", sets: 2, rep_low: 8, rep_high: 12, target_weight: 50 },
  ]);
  const ex = repo.findExercise("Farmer's Carry");
  for (const daysAgo of [9, 5]) {
    const session = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
    for (let s = 1; s <= 3; s++)
      db.prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, 50, 60, 30)`
      ).run(session.id, ex.id, s);
  }
  const p = planDayProgression(1, { forNextSession: true }).find((x) => x.exercise === "Farmer's Carry");
  assert.equal(p.action, "hold");
  assert.match(p.why, /timed/);
  assert.equal(p.set_step, undefined, "its set count waits with it");
  assert.equal(buildProgressionProposal(1, { forNextSession: true }).ok, false, "nothing is proposed on it");
});

test("a new carry or hold is created timed; a lift is created reps", () => {
  assert.equal(repo.findOrCreateExercise("Suitcase Carry").mode, "timed");
  assert.equal(repo.findOrCreateExercise("Copenhagen Plank").mode, "timed");
  assert.equal(repo.findOrCreateExercise("Cable Fly").mode, "reps");
});
