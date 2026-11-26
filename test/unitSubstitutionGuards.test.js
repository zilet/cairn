// The gym swap held to its evidence role (src/repo/unit-substitution.ts, read by
// daily-reconciliation.ts):
//   1. an explicit skip stands: a slot the athlete skipped is never satisfied by a same-unit lift;
//   2. a satisfied slot is "done by a same-movement lift", never an exposure of the PLANNED lift:
//      its dose is not keyed as that lift's movement, so the movement-response ledger the
//      progression engine reads never counts it, and the planned lift's own history is untouched;
//   3. an isolation lift never satisfies a compound slot (a leg extension is not a squat), and a
//      machine compound filling a free-weight compound slot (a leg press for the back squat)
//      reads as `substituted_slots`, never `completed` and never `skipped`.
// Synthetic fixtures only.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getDailySessionOutcome,
  UNIT_SUBSTITUTE,
  UNIT_SUBSTITUTE_KEY_PREFIX,
} from "../dist/repo/daily-reconciliation.js";
import { matchUnitSubstitutions } from "../dist/repo/unit-substitution.js";
import { recentMovementResponse } from "../dist/repo/training-response.js";
import { db, repo } from "./_seed.js";

const DATE = "2031-08-05";

function acceptComposition(name, items, date = DATE) {
  const session = { name, focus: name, why: "Fits the plan today.", est_minutes: 45, items };
  const job = repo.createAgentJob({ kind: "session_compose", input: { date } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
  return repo.prepareDailySession({ date, source: "agent_suggest", agent_job_id: job.id });
}

function log(exercise, weight, reps, n = 3, date = DATE) {
  for (let i = 0; i < n; i++) repo.logSetByName({ date, exercise, weight, reps, day_number: null });
}

const LOWER = [
  { exercise: "Back Squat", muscle_group: "quads", sets: 3, rep_low: 5, rep_high: 8, target_weight: 225 },
  { exercise: "Romanian Deadlift", muscle_group: "hamstrings", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
];
const PULL = [
  { exercise: "Lat Pulldown", muscle_group: "back", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  { exercise: "Seated Cable Row", muscle_group: "back", sets: 3, rep_low: 8, rep_high: 12, target_weight: 110 },
];

test("an explicit skip stands: a same-unit lift logged afterwards never fills the skipped slot", () => {
  repo.savePlanDay(1, "Lower", "Legs", LOWER);
  const prepared = acceptComposition("Lower", LOWER);
  repo.skipExercise("Back Squat", DATE);
  log("Leg Press", 300, 10);
  log("Romanian Deadlift", 185, 10);
  repo.finishSession(prepared.session_id, null);
  const facts = getDailySessionOutcome(DATE).facts;
  assert.ok(facts.skipped.includes("Back Squat"), JSON.stringify(facts));
  assert.ok(!facts.completed.includes("Back Squat"));
  assert.equal(facts.unit_substitutions, undefined, "the skip is his word about that slot");
  assert.deepEqual(facts.substituted, ["Leg Press"], "the leg press stays an extra");
  const dose = facts.dose_evidence.find((d) => d.exercise === "Back Squat");
  assert.equal(dose.substituted_by, undefined);
  assert.equal(dose.achieved.sets, 0);
});

test("a satisfied slot is never an exposure of the planned lift", () => {
  repo.savePlanDay(1, "Pull", "Back", PULL);
  const prepared = acceptComposition("Pull", PULL);
  log("Pull-Up", null, 10);
  log("Seated Cable Row", 110, 10);
  repo.finishSession(prepared.session_id, null);
  const facts = getDailySessionOutcome(DATE).facts;
  const dose = facts.dose_evidence.find((d) => d.exercise === "Lat Pulldown");
  assert.equal(dose.substituted_by, "Pull-Up");
  assert.equal(dose.comparable, false);
  assert.ok(dose.non_comparable_reasons.includes(UNIT_SUBSTITUTE));
  assert.ok(dose.movement_key.startsWith(UNIT_SUBSTITUTE_KEY_PREFIX), dose.movement_key);
  // The movement-response ledger (read by the progression engine per lift and rep range)
  // never takes the pull-up's work as a lat pulldown exposure.
  const response = recentMovementResponse("Lat Pulldown", { intent_key: "strength:reps:8-12" });
  assert.equal(response.considered_outcomes, 0, JSON.stringify(response));
  assert.equal(recentMovementResponse("Lat Pulldown").considered_outcomes, 0);
  // The row actually done keeps its own read.
  assert.equal(recentMovementResponse("Seated Cable Row").considered_outcomes, 1);
  // The planned lift's own history is untouched: no set was written under its name.
  const pulldown = repo.findExercise("Lat Pulldown");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE exercise_id = ?`).get(pulldown.id).n, 0);
});

test("a leg extension never satisfies a squat slot", () => {
  assert.deepEqual(
    matchUnitSubstitutions(
      [{ key: "s", exercise: "Back Squat", group: "quads" }],
      [{ key: "e", exercise: "Leg Extension", group: "quads" }]
    ),
    []
  );
});

test("a leg press filling a back squat slot is a substituted slot: neither completed nor skipped", () => {
  const out = matchUnitSubstitutions(
    [{ key: "s", exercise: "Back Squat", group: "quads" }],
    [{ key: "p", exercise: "Leg Press", group: "quads" }]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].unit, "squat");
  assert.equal(out[0].kind, "machine_for_free_weight");

  repo.savePlanDay(1, "Lower", "Legs", LOWER);
  const prepared = acceptComposition("Lower", LOWER);
  log("Leg Press", 300, 8);
  log("Romanian Deadlift", 185, 10);
  repo.finishSession(prepared.session_id, null);
  const facts = getDailySessionOutcome(DATE).facts;
  assert.deepEqual(facts.completed, ["Romanian Deadlift"]);
  assert.deepEqual(facts.substituted_slots, ["Back Squat"]);
  assert.deepEqual(facts.skipped, []);
  assert.deepEqual(facts.substituted, [], "the leg press filled a slot, it is not an extra");
  assert.deepEqual(facts.unit_substitutions, [
    { planned: "Back Squat", logged: "Leg Press", unit: "squat", kind: "machine_for_free_weight" },
  ]);
  assert.ok(!facts.reason_codes.includes("completed_as_suggested"), "the card's squat was not done as written");
  assert.ok(facts.reason_codes.includes("unit_substituted"));
  assert.ok(!facts.reason_codes.includes("partial_session"));
  const dose = facts.dose_evidence.find((d) => d.exercise === "Back Squat");
  assert.equal(dose.substituted_by, "Leg Press");
  assert.equal(dose.comparable, false);
});

test("a like-for-like swap still reads completed", () => {
  const out = matchUnitSubstitutions(
    [{ key: "a", exercise: "Lat Pulldown", group: "back" }],
    [{ key: "b", exercise: "Pull-Up", group: "back" }]
  );
  assert.equal(out[0].kind, "like_for_like");
});
