// The gym swap (src/repo/unit-substitution.ts, read by daily-reconciliation.ts): a lift
// logged in place of a planned one in the SAME movement unit satisfies that slot.
// Invariants:
//   1. the slot reads completed, never skipped; the logged lift is not an extra;
//   2. the exact match always wins; one logged lift satisfies at most one slot;
//   3. a lift from another unit substitutes for nothing;
//   4. the satisfied slot's dose credits the sets but is never comparable load evidence,
//      and carries no load comparison across the two variants;
//   5. the plan itself is never changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getDailySessionOutcome, UNIT_SUBSTITUTE } from "../dist/repo/daily-reconciliation.js";
import { matchUnitSubstitutions } from "../dist/repo/unit-substitution.js";
import { sessionCarriedPlannedVolume, doseContradictionTally } from "../dist/repo/session-dose-log.js";
import { repo } from "./_seed.js";

const DATE = "2031-08-05";

function seedPlan() {
  repo.savePlanDay(1, "Pull", "Back", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 110 },
  ]);
}

function acceptComposition(items, date = DATE) {
  const session = { name: "Pull", focus: "Back", why: "Fits the plan today.", est_minutes: 45, items };
  const job = repo.createAgentJob({ kind: "session_compose", input: { date } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
  return repo.prepareDailySession({ date, source: "agent_suggest", agent_job_id: job.id });
}

const CARD = [
  { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 110 },
];

function log(exercise, weight, reps, n = 3) {
  for (let i = 0; i < n; i++) repo.logSetByName({ date: DATE, exercise, weight, reps, day_number: null });
}

test("pure: slots pair with logged lifts by unit, one each, in card and log order", () => {
  const out = matchUnitSubstitutions(
    [
      { key: "a", exercise: "Lat Pulldown", group: "back" },
      { key: "b", exercise: "Pull-Up", group: "back" },
      { key: "c", exercise: "Barbell Curl", group: "biceps" },
    ],
    [
      { key: "x", exercise: "Machine Lat Pulldown", group: "back" },
      { key: "y", exercise: "Leg Extension", group: "quads" },
    ]
  );
  assert.equal(out.length, 1, "one logged lift fills one slot");
  assert.equal(out[0].slot_key, "a", "the first slot of the unit, in card order");
  assert.equal(out[0].logged_key, "x");
  assert.equal(out[0].unit, "vertical-pull");
  assert.deepEqual(matchUnitSubstitutions([{ key: "c", exercise: "Barbell Curl", group: "biceps" }], []), []);
});

test("a same-unit lift logged in place of the planned one satisfies its slot", () => {
  seedPlan();
  const prepared = acceptComposition(CARD);
  log("Pull-Up", null, 10);
  log("Seated Cable Row", 110, 10);
  repo.finishSession(prepared.session_id, null);
  const before = JSON.stringify(repo.getPlan());

  const outcome = getDailySessionOutcome(DATE);
  assert.ok(outcome);
  const facts = outcome.facts;
  assert.deepEqual(facts.completed.sort(), ["Lat Pulldown", "Seated Cable Row"]);
  assert.deepEqual(facts.skipped, [], "the planned pulldown is not missed");
  assert.deepEqual(facts.substituted, [], "the pull-up filled a slot, it is not an extra");
  assert.deepEqual(facts.unit_substitutions, [
    { planned: "Lat Pulldown", logged: "Pull-Up", unit: "vertical-pull", kind: "like_for_like" },
  ]);
  assert.ok(facts.reason_codes.includes("unit_substituted"));
  assert.ok(facts.reason_codes.includes("completed_as_suggested"));
  assert.equal(facts.dose_context.partial, false);

  const dose = facts.dose_evidence.find((d) => d.exercise === "Lat Pulldown");
  assert.equal(dose.substituted_by, "Pull-Up");
  assert.equal(dose.achieved.sets, 3, "its sets are credited to the slot");
  assert.equal(dose.prescribed.target_weight, null, "the slot's load belongs to another variant");
  assert.equal(dose.full_load_reference, null);
  assert.equal(dose.comparable, false);
  assert.ok(dose.non_comparable_reasons.includes(UNIT_SUBSTITUTE));

  const tally = doseContradictionTally(prepared.session_id);
  assert.equal(tally.short, 0, "no lift reads short");
  assert.notEqual(sessionCarriedPlannedVolume(prepared.session_id), false, "the swap never vetoes the plan's volume");
  assert.equal(JSON.stringify(repo.getPlan()), before, "the plan is never changed");
});

test("the exact match wins: a planned lift logged as written is never a substitute's slot", () => {
  seedPlan();
  const prepared = acceptComposition(CARD);
  log("Lat Pulldown", 120, 10);
  log("Pull-Up", null, 10);
  log("Seated Cable Row", 110, 10);
  repo.finishSession(prepared.session_id, null);
  const facts = getDailySessionOutcome(DATE).facts;
  assert.equal(facts.unit_substitutions, undefined, "no swap when the planned lift was done");
  assert.deepEqual(facts.substituted, ["Pull-Up"], "the extra stays an extra");
  const dose = facts.dose_evidence.find((d) => d.exercise === "Lat Pulldown");
  assert.equal(dose.substituted_by, undefined);
  assert.equal(dose.prescribed.target_weight, 120);
});

test("a lift from another unit substitutes for nothing", () => {
  seedPlan();
  const prepared = acceptComposition(CARD);
  log("Barbell Curl", 70, 10);
  log("Seated Cable Row", 110, 10);
  repo.finishSession(prepared.session_id, null);
  const facts = getDailySessionOutcome(DATE).facts;
  assert.deepEqual(facts.skipped, ["Lat Pulldown"]);
  assert.deepEqual(facts.substituted, ["Barbell Curl"]);
  assert.equal(facts.unit_substitutions, undefined);
});

test("a short substitute still reads short for the slot", () => {
  seedPlan();
  const prepared = acceptComposition(CARD);
  log("Pull-Up", null, 10, 1);
  log("Seated Cable Row", 110, 10);
  repo.finishSession(prepared.session_id, null);
  const facts = getDailySessionOutcome(DATE).facts;
  assert.deepEqual(facts.skipped, []);
  assert.equal(facts.dose_context.partial, true, "one set of three is still a partial slot");
  assert.equal(doseContradictionTally(prepared.session_id).short, 1);
});
