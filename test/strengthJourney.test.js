import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo } from "./_seed.js";
import {
  applyChatActions,
  hasExplicitStrengthObjectiveIntent,
  reconcileStrengthObjectiveReply,
} from "../dist/chatTurns.js";
import { localDateISO } from "../dist/repo/shared.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const back = (n) => new Date(new Date(`${localDateISO()}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);
const log = (exercise, weight, reps, daysAgo, rir = 2) =>
  repo.logSetByName({ exercise, weight, reps, rir, date: back(daysAgo) });

test("return-to-best snaps the exact target and does not move it after a new best", () => {
  log("Barbell Bench Press", 185, 5, 60);
  const objective = repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "return_to_personal_best",
  });
  assert.equal(objective.target_est_1rm, 215.8);
  assert.equal(objective.baseline_est_1rm, 215.8);

  log("Barbell Bench Press", 205, 5, 0);
  const stored = repo.getStrengthObjective(objective.id);
  assert.equal(stored.id, objective.id);
  assert.equal(stored.target_est_1rm, 215.8, "the snapped finish line is immutable");
  assert.equal(stored.status, "completed", "a later verified exact-lift log closes the objective");
  assert.equal(stored.achieved_est_1rm, 239.2);
  assert.equal(repo.getActiveStrengthObjective(), null, "completion never creates a replacement goal");
  assert.equal(repo.getStrengthJourney().current.est_1rm, 239.2);
});

test("setting a new objective leaves exactly one active and preserves the old row", () => {
  const first = repo.setStrengthObjective({
    exercise: "Back Squat",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 300,
  });
  const second = repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 225,
  });
  assert.equal(repo.getActiveStrengthObjective().id, second.id);
  const rows = repo.listStrengthObjectives();
  assert.equal(rows.filter((row) => row.status === "active").length, 1);
  assert.equal(rows.find((row) => row.id === first.id).status, "superseded");
  assert.equal(rows.find((row) => row.id === first.id).target_est_1rm, 300);
  assert.deepEqual(
    repo.exportAll().strength_objectives.map((row) => row.id),
    [second.id, first.id],
    "JSON backup keeps the active and superseded immutable snapshots"
  );
});

test("exact-lift history never merges dumbbell and barbell incline presses", () => {
  log("Incline DB Press", 70, 10, 14);
  log("Incline Bench Press", 125, 5, 7);
  log("Incline Bench Press", 135, 5, 0);
  const objective = repo.setStrengthObjective({
    exercise: "Incline Bench Press",
    target_kind: "return_to_personal_best",
  });
  assert.equal(objective.target_est_1rm, 157.5, "only the barbell history sets the target");
  const history = repo.strengthObjectiveHistory("Incline Bench Press");
  assert.deepEqual(
    history.map((point) => point.top_weight),
    [125, 135]
  );
  assert.equal(repo.strengthObjectiveHistory("Incline DB Press").length, 1);
});

test("journey math is exact and only emits a wide projection after the evidence gate", () => {
  [
    [28, 100],
    [21, 105],
    [14, 110],
    [0, 115],
  ].forEach(([days, weight]) => log("Barbell Bench Press", weight, 5, days));
  repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 150,
  });
  const journey = repo.getStrengthJourney();
  assert.equal(journey.current.est_1rm, 134.2);
  assert.equal(journey.best.est_1rm, 134.2);
  assert.equal(journey.baseline.est_1rm, 134.2);
  assert.equal(journey.gap_lb, 15.8);
  assert.equal(journey.trend.exposures, 4);
  assert.equal(journey.trend.span_days, 28);
  assert.equal(journey.trend.direction, "rising");
  assert.equal(journey.trend.est_1rm_lb_per_week, 4.3);
  assert.ok(journey.projection, "positive stable trend unlocks a range");
  assert.ok(journey.projection.latest_weeks > journey.projection.earliest_weeks, "projection is a range, not a date");
});

test("projection stays withheld for thin history, stalls, constraints, and recent pain", () => {
  [14, 7, 0].forEach((days, index) => log("Barbell Bench Press", 100 + index * 5, 5, days));
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 200 });
  let journey = repo.getStrengthJourney();
  assert.equal(journey.projection, null);
  assert.match(journey.projection_withheld_reason, /four exact-lift exposures across 21 days/i);

  const bench = repo.listExercises().find((exercise) => exercise.name === "Barbell Bench Press");
  repo.updateExercise(bench.id, { constraint_note: "Sharp shoulder pain — keep it light" });
  journey = repo.getStrengthJourney();
  assert.equal(journey.projection, null);
  assert.equal(journey.safety.load_constraint, true);

  repo.updateExercise(bench.id, { constraint_note: null });
  repo.setSessionFeedback(localDateISO(), { joint_pain: "right elbow" });
  journey = repo.getStrengthJourney();
  assert.equal(journey.projection, null);
  assert.equal(journey.safety.recent_joint_pain, "right elbow");
  assert.equal(journey.phase, "protecting");
  assert.equal(journey.next_prescription, null, "protecting never presents an overload prescription");
  assert.deepEqual(journey.planned_support, [], "relevant upper-joint pain suppresses planned support");
});

test("fresh pain dominates a reached milestone and removes the next prescription", () => {
  log("Barbell Bench Press", 185, 5, 0);
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 200 });
  repo.setSessionFeedback(localDateISO(), { joint_pain: "shoulder and elbow discomfort" });
  const journey = repo.getStrengthJourney();
  assert.equal(journey.gap_lb, 0, "the snapped milestone was reached mathematically");
  assert.equal(journey.phase, "protecting", "safety dominates reached");
  assert.equal(journey.next_prescription, null);
  assert.deepEqual(journey.planned_support, []);
});

test("anchor safety is body-area relevant: knee does not protect bench, elbow and shoulder do", () => {
  log("Barbell Bench Press", 135, 5, 7);
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 200 });

  repo.setSessionFeedback(localDateISO(), { joint_pain: "right knee" });
  let journey = repo.getStrengthJourney();
  assert.equal(journey.safety.recent_joint_pain, "right knee");
  assert.equal(journey.safety.relevant_joint_pain, null);
  assert.notEqual(journey.phase, "protecting", "unrelated knee feedback does not freeze a bench anchor");

  repo.setSessionFeedback(localDateISO(), { joint_pain: "right elbow" });
  journey = repo.getStrengthJourney();
  assert.equal(journey.safety.relevant_joint_pain, "right elbow");
  assert.equal(journey.phase, "protecting");
  assert.equal(journey.next_prescription, null);
});

test("only an active injury that loads the exact anchor protects it", () => {
  log("Barbell Bench Press", 135, 5, 7);
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 200 });
  repo.addContextEvent({
    kind: "injury",
    title: "Sore right knee",
    start_date: localDateISO(),
    meta: { area: "knee" },
  });
  let journey = repo.getStrengthJourney();
  assert.deepEqual(journey.safety.relevant_active_injuries, []);
  assert.notEqual(journey.phase, "protecting");

  repo.addContextEvent({
    kind: "injury",
    title: "Shoulder strain",
    start_date: localDateISO(),
    meta: { area: "shoulder" },
  });
  journey = repo.getStrengthJourney();
  assert.equal(journey.phase, "protecting");
  assert.match(journey.safety.relevant_active_injuries.join(" "), /shoulder/i);
});

test("a light technique exposure stays latest without erasing demonstrated capacity", () => {
  log("Barbell Bench Press", 100, 5, 21);
  log("Barbell Bench Press", 110, 5, 14);
  log("Barbell Bench Press", 120, 5, 7);
  log("Barbell Bench Press", 80, 5, 0, 6);
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 180 });
  const journey = repo.getStrengthJourney();
  assert.equal(journey.latest.est_1rm, 93.3, "latest exposure remains transparent");
  assert.equal(journey.latest.date, back(0));
  assert.equal(journey.current.est_1rm, 140, "the conservative recent envelope retains demonstrated capacity");
  assert.equal(journey.current.date, back(7));
  assert.notEqual(journey.trend.direction, "falling");
  assert.match(journey.capacity_basis, /latest three exposures/i);
});

test("completion is durable after a later weak set and never invents a next objective", () => {
  log("Back Squat", 100, 5, 42);
  const objective = repo.setStrengthObjective({
    exercise: "Back Squat",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 130,
  });
  log("Back Squat", 115, 5, 35);
  log("Back Squat", 80, 5, 0, 6);
  const stored = repo.getStrengthObjective(objective.id);
  const journey = repo.getStrengthJourney();
  assert.equal(stored.status, "completed");
  assert.equal(stored.achieved_est_1rm, 134.2);
  assert.equal(stored.achieved_date, back(35));
  assert.equal(journey.objective.id, objective.id);
  assert.equal(journey.objective.status, "completed");
  assert.equal(journey.gap_lb, 0);
  assert.equal(journey.current.est_1rm, 134.2, "the later weak exposure cannot erase the verified milestone");
  assert.equal(journey.latest.est_1rm, 93.3, "the later light exposure remains visible separately");
  assert.equal(journey.next_prescription, null, "completed journeys do not prescribe toward an automatic next goal");
  assert.equal(repo.getActiveStrengthObjective(), null);
  assert.equal(repo.listStrengthObjectives().length, 1);
});

test("set corrections complete or reopen the current exact objective from durable evidence", () => {
  const set = log("Barbell Bench Press", 100, 5, 0);
  const objective = repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 130,
  });
  assert.equal(objective.status, "active");

  repo.updateSet(set.id, { weight: 120 });
  let stored = repo.getStrengthObjective(objective.id);
  assert.equal(stored.status, "completed", "an upward correction past the target closes the objective");
  assert.equal(stored.achieved_est_1rm, 140);

  repo.updateSet(set.id, { weight: 100 });
  stored = repo.getStrengthObjective(objective.id);
  assert.equal(stored.status, "active", "removing the only supporting achievement reopens the objective");
  assert.equal(stored.completed_at, null);
  assert.equal(stored.achieved_est_1rm, null);
  assert.equal(stored.achieved_date, null);
});

test("return-to-best ignores the old PB as completion evidence after sub-target comeback work", () => {
  log("Barbell Bench Press", 185, 5, 60);
  const objective = repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "return_to_personal_best",
  });
  assert.equal(objective.status, "active");
  assert.equal(objective.target_est_1rm, 215.8);

  const comebackSet = log("Barbell Bench Press", 150, 5, 0);
  assert.equal(
    repo.getStrengthObjective(objective.id).status,
    "active",
    "a new sub-target exposure cannot recycle the old PB as fresh completion proof"
  );

  repo.updateSet(comebackSet.id, { weight: 170 });
  assert.equal(
    repo.getStrengthObjective(objective.id).status,
    "active",
    "a corrected but still sub-target exposure keeps the comeback objective active"
  );
});

test("explicit target ignores stale above-target history after sub-target objective-period work", () => {
  log("Barbell Bench Press", 185, 5, 60);
  const objective = repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 200,
  });
  assert.equal(objective.status, "active", "stale capacity does not complete a new explicit objective");

  const currentSet = log("Barbell Bench Press", 150, 5, 0);
  assert.equal(
    repo.getStrengthObjective(objective.id).status,
    "active",
    "new sub-target work cannot recycle stale above-target history"
  );

  repo.updateSet(currentSet.id, { weight: 165 });
  assert.equal(
    repo.getStrengthObjective(objective.id).status,
    "active",
    "a corrected but still sub-target set keeps the explicit objective active"
  );
});

test("set correction preserves alternate evidence and never rewrites superseded or archived objectives", () => {
  const firstHit = log("Back Squat", 120, 5, 7);
  const objective = repo.setStrengthObjective({
    exercise: "Back Squat",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 130,
  });
  assert.equal(objective.status, "completed");
  const secondHit = log("Back Squat", 125, 5, 0);
  repo.updateSet(firstHit.id, { weight: 100 });
  const stored = repo.getStrengthObjective(objective.id);
  assert.equal(stored.status, "completed", "another exact supporting set keeps the objective complete");
  assert.equal(stored.achieved_est_1rm, 145.8);
  assert.equal(stored.achieved_date, back(0));

  const superseded = repo.setStrengthObjective({
    exercise: "Barbell Bench Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 200,
  });
  const current = repo.setStrengthObjective({
    exercise: "Deadlift",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 300,
  });
  repo.setStrengthObjectiveStatus(current.id, "archived");
  repo.updateSet(secondHit.id, { weight: 130 });
  assert.equal(repo.getStrengthObjective(superseded.id).status, "superseded");
  assert.equal(repo.getStrengthObjective(current.id).status, "archived");
});

test("finished anchor session reports bounded capacity movement only when capacity moved", () => {
  log("Barbell Bench Press", 100, 5, 14);
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 180 });
  const moved = log("Barbell Bench Press", 120, 5, 0);
  const finished = repo.finishSession(moved.session_id);
  assert.deepEqual(finished.strength_journey_movement, {
    exercise: "Barbell Bench Press",
    current_est_1rm: 140,
    current_date: back(0),
    capacity_delta_lb: 23.3,
    gap_closed_lb: 23.3,
  });
});

test("known equipment constraints remove unavailable work from planned support", () => {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10 },
    { exercise: "Triceps Rope Pushdown", sets: 2, rep_low: 10, rep_high: 12 },
  ]);
  repo.savePlanDay(2, "Pull", "Back", [{ exercise: "Seated Cable Row", sets: 2, rep_low: 8, rep_high: 12 }]);
  repo.setEquipmentProfile("barbell and dumbbell only");
  repo.setStrengthObjective({ exercise: "Incline DB Press", target_kind: "explicit_est_1rm", target_est_1rm: 100 });
  assert.deepEqual(
    repo.getStrengthJourney().planned_support,
    [],
    "cable/machine plan items are not presented as usable support"
  );
});

test("old exact-lift history cannot unlock a current projection", () => {
  [70, 63, 56, 42].forEach((days, index) => log("Barbell Bench Press", 100 + index * 5, 5, days));
  repo.setStrengthObjective({ exercise: "Barbell Bench Press", target_kind: "explicit_est_1rm", target_est_1rm: 180 });
  const journey = repo.getStrengthJourney();
  assert.equal(journey.trend.exposures, 4);
  assert.equal(journey.trend.direction, "rising");
  assert.equal(journey.projection, null);
  assert.match(journey.projection_withheld_reason, /more than 28 days old/i);
});

test("horizontal-press support is capped at three roles and never adds another press", () => {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10 },
    { exercise: "Triceps Rope Pushdown", sets: 2, rep_low: 10, rep_high: 12 },
  ]);
  repo.savePlanDay(2, "Pull", "Back", [{ exercise: "Seated Cable Row", sets: 2, rep_low: 8, rep_high: 12 }]);
  repo.setStrengthObjective({ exercise: "Incline DB Press", target_kind: "explicit_est_1rm", target_est_1rm: 100 });
  const support = repo.getStrengthJourney().planned_support;
  assert.deepEqual(
    support.map((item) => item.role),
    ["upper back", "triceps"],
    "only exact candidates already in the plan are called planned support"
  );
  assert.ok(support.length <= 3);
  assert.ok(support.every((item) => !/bench|chest press|incline press|dumbbell press|db press/i.test(item.exercise)));
  assert.ok(support.every((item) => item.plan_day_number > 0 && item.plan_day_name && item.why));
  assert.deepEqual(repo.getStrengthJourney().support_suggestions, []);
});

test("chat writes the objective only from explicit goal intent and verifies server readback", () => {
  const exploratory = "What should my bench target be while I get back into lifting?";
  assert.equal(hasExplicitStrengthObjectiveIntent(exploratory), false);
  const skipped = applyChatActions(
    {
      actions: [
        {
          type: "set_strength_objective",
          exercise: "Barbell Bench Press",
          target_kind: "explicit_est_1rm",
          target_est_1rm: 225,
        },
      ],
    },
    { agent: "stub", message: exploratory }
  );
  assert.equal(skipped.applied.length, 0);
  assert.equal(repo.getActiveStrengthObjective(), null);

  const explicit = "I want to get my Barbell Bench Press back to my personal best.";
  assert.equal(hasExplicitStrengthObjectiveIntent(explicit), true);
  log("Barbell Bench Press", 185, 5, 0);
  const applied = applyChatActions(
    {
      actions: [
        {
          type: "set_strength_objective",
          exercise: "Barbell Bench Press",
          target_kind: "return_to_personal_best",
        },
      ],
    },
    { agent: "stub", message: explicit }
  );
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].type, "set_strength_objective");
  assert.equal(applied.applied[0].result.ok, true);
  assert.equal(applied.applied[0].result.verified, true);
  assert.equal(
    applied.applied[0].result.objective.id,
    repo.getStrengthObjective(applied.applied[0].result.objective.id).id,
    "readback verifies the exact row whether creation leaves it active or already completed"
  );
  const reply = reconcileStrengthObjectiveReply("Got it — we'll build back deliberately.", explicit, applied.applied);
  assert.match(reply, /saved and verified: Barbell Bench Press to 215\.8 lb estimated 1RM/i);
});

test("natural lift-goal commands are explicit and false success prose is removed when no write persisted", () => {
  const message = "Set my bench goal to 225.";
  assert.equal(hasExplicitStrengthObjectiveIntent(message), true);
  const reconciled = reconcileStrengthObjectiveReply("I've saved your new bench goal.", message, []);
  assert.equal(
    reconciled,
    "I didn't save a strength objective from that response, so your existing objective is unchanged."
  );
  assert.doesNotMatch(reconciled, /I've saved/i);
});

test("timed exercises cannot become estimated-1RM strength objectives", () => {
  repo.upsertExercise({ name: "Objective Dead Hang", muscle_group: "back", mode: "timed" });
  assert.throws(
    () =>
      repo.setStrengthObjective({
        exercise: "Objective Dead Hang",
        target_kind: "explicit_est_1rm",
        target_est_1rm: 90,
      }),
    /reps-based exercise with estimated-1RM history/i
  );
  assert.equal(repo.getActiveStrengthObjective(), null);
});

test("objective creation closes an already-reached target and journey GET remains read-only", () => {
  log("Barbell Bench Press", 185, 5, 0);
  const message = "Set my bench goal to 200.";
  const applied = applyChatActions(
    {
      actions: [
        {
          type: "set_strength_objective",
          exercise: "Barbell Bench Press",
          target_kind: "explicit_est_1rm",
          target_est_1rm: 200,
        },
      ],
    },
    { agent: "stub", message }
  );
  const result = applied.applied[0].result;
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(
    result.objective.status,
    "completed",
    "the objective-create transaction closes an already-reached target"
  );
  assert.equal(repo.getActiveStrengthObjective(), null);
  assert.equal(result.journey.objective.id, result.objective.id);
  assert.equal(result.journey.objective.status, "completed");

  const before = JSON.stringify(repo.listStrengthObjectives());
  const first = repo.getStrengthJourney();
  const second = repo.getStrengthJourney();
  assert.equal(first.phase, "reached");
  assert.deepEqual(second, first);
  assert.equal(
    JSON.stringify(repo.listStrengthObjectives()),
    before,
    "GET/read computation never mutates objective rows"
  );
});

test("coach context carries the journey and output has no score or outcome guarantee language", () => {
  log("Back Squat", 225, 5, 0);
  repo.setStrengthObjective({ exercise: "Back Squat", target_kind: "explicit_est_1rm", target_est_1rm: 315 });
  const journey = repo.getStrengthJourney();
  assert.equal(repo.getCoachContext().strength_journey.objective.id, journey.objective.id);
  assert.doesNotMatch(JSON.stringify(journey), /\b(?:score|guarantee|guaranteed|prognosis|completion percentage)\b/i);
});

test("REST and MCP expose mirrored get/set strength-journey surfaces", () => {
  const rest = readFileSync(join(root, "src/routes/training-log.ts"), "utf8");
  const mcp = readFileSync(join(root, "src/surfaces/mcp/training-log.ts"), "utf8");
  assert.match(rest, /get\("\/strength-journey"/);
  assert.match(rest, /put\("\/strength-journey"/);
  assert.match(mcp, /"get_strength_journey"/);
  assert.match(mcp, /"set_strength_objective"/);
  assert.match(rest, /getStrengthJourney/);
  assert.match(mcp, /getStrengthJourney/);
});

test("Progress card stays bounded and renders no score or completion percentage", () => {
  const client = readFileSync(join(root, "src/client/progress-program-controller.ts"), "utf8");
  assert.match(client, /strengthJourneyCardHtml/);
  assert.match(client, /Strength around it/);
  assert.match(client, /Planning range/);
  assert.doesNotMatch(client, /progress\s*(?:bar|meter)|completion percentage/i);
});
