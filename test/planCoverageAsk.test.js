// A standing coverage gap is SAID, once, as a calm ask. Invariants under test:
//   1. a person's save that leaves a floored group under its weekly floor still saves
//      exactly as before, and records exactly ONE held draft (the smallest change that
//      covers the group), waiting for the athlete's yes on "Waiting on you";
//   2. saving again unchanged, or the daily pass after a save, never adds a second ask;
//   3. an ask the athlete set aside stays quiet until the lifts bearing on that gap
//      change, and then it is asked afresh;
//   4. every existing exemption yields no ask (intent, light weeks, an affirmed cut,
//      endurance-carried groups, the race taper's leg trim);
//   5. a gap that arose without a save (an intent change) is said by the daily pass;
//   6. a broad week with no trunk work gets the same ask for the missing family;
//   7. the wording keeps the reading grammar: no score, no gate, no internals.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import { raisePlanCoverageAsk } from "../dist/domain/brain/coverage-ask.js";
import { COVERAGE_ASK_AGENT, coverageExplanation, planCoverageGap } from "../dist/repo/plan-coverage.js";
import { awaitingBrainDecisions } from "../dist/repo/brain-decisions.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { scheduleRecoveryCycle } from "../dist/repo/recovery-cycles.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { cutReaffirmation } from "../dist/repo/cut-target.js";
import * as blocks from "../dist/repo/program-blocks.js";

const STRENGTH = { training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" } };

// A week that clears every major-group floor for a strength priority and touches every
// movement family. Groups are named so nothing rides on name classification.
function fedWeek() {
  return [
    {
      day_number: 1,
      name: "Upper",
      items: [
        { exercise: "Barbell Bench Press", muscle_group: "chest", sets: 5, rep_low: 6, rep_high: 8 },
        { exercise: "Incline Dumbbell Press", muscle_group: "chest", sets: 5, rep_low: 8, rep_high: 10 },
        { exercise: "Barbell Overhead Press", muscle_group: "shoulders", sets: 4, rep_low: 6, rep_high: 8 },
        { exercise: "Dumbbell Lateral Raise", muscle_group: "shoulders", sets: 4, rep_low: 12, rep_high: 15 },
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
        { exercise: "Hip Thrust", muscle_group: "glutes", sets: 4, rep_low: 8, rep_high: 12 },
      ],
    },
    {
      day_number: 3,
      name: "Pull",
      items: [
        { exercise: "Seated Cable Row", muscle_group: "back", sets: 5, rep_low: 8, rep_high: 12 },
        { exercise: "Lat Pulldown", muscle_group: "back", sets: 5, rep_low: 8, rep_high: 12 },
        { exercise: "Hanging Leg Raise", muscle_group: "core", sets: 3, rep_low: 8, rep_high: 12 },
      ],
    },
  ];
}

// Day 1 with chest at two sets a lift: chest falls under its floor, nothing else moves.
function shortChestUpper() {
  return fedWeek()[0].items.map((item) => (item.muscle_group === "chest" ? { ...item, sets: 2 } : item));
}

const coverageRows = () =>
  db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ? ORDER BY id`).all(COVERAGE_ASK_AGENT);
const openRows = () => coverageRows().filter((row) => row.status === "draft");
const liveHolds = (proposalId) =>
  db
    .prepare(`SELECT id FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'review'`)
    .all(String(proposalId));

function setUpShortChest() {
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek());
  assert.deepEqual(planCoverageGap().elements, [], "the fed week has no gap");
  return savePlanDayByPerson(1, "Upper", null, shortChestUpper());
}

test("a hand save that leaves chest short still saves, and records exactly one calm ask", () => {
  const saved = setUpShortChest();
  assert.equal(saved.ok, true);
  const chest = saved.day.items.filter((item) => /Press$/.test(item.exercise) && !/Overhead/.test(item.exercise));
  assert.deepEqual(
    chest.map((item) => item.sets),
    [2, 2],
    "the save landed exactly as written"
  );
  assert.equal(saved.coverage_ask.status, "raised");
  assert.deepEqual(saved.coverage_ask.gaps, ["group:chest"]);
  assert.equal(openRows().length, 1, "exactly one ask");

  const proposal = repo.getProposal(saved.coverage_ask.proposal_id);
  assert.equal(proposal.status, "draft", "nothing applied on the athlete's behalf");
  assert.equal(proposal.autonomy.status, "review");
  assert.equal(proposal.autonomy.tier, "ask");
  assert.equal(liveHolds(proposal.id).length, 1);
  // The remedy: a set more on the chest lifts the plan already has, then a chest lift.
  const changes = proposal.parsed.changes;
  const bench = changes.find((c) => c.exercise === "Barbell Bench Press");
  assert.ok(bench && bench.sets > 2 && bench.sets <= 4, "an existing chest lift gets at most two more sets");
  assert.ok(changes.every((c) => c.sets <= 5));
  assert.equal(repo.getPlan()[0].items.find((i) => i.exercise === "Barbell Bench Press").sets, 2, "the plan is untouched");

  // "Waiting on you" carries the ask's own sentence, naming the group in plain words.
  const waiting = awaitingBrainDecisions().find((row) => row.id === proposal.autonomy.id);
  assert.ok(waiting, "the ask reaches the waiting surface");
  assert.match(waiting.explanation, /\bchest\b/);
  assert.doesNotMatch(waiting.explanation, /\d/, "groups in words, never set arithmetic");
  for (const text of [waiting.explanation, proposal.parsed.summary, ...changes.map((c) => c.reason)]) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.doesNotMatch(text, /\bmust\b|\bshould\b|\bscore\b/i, text);
  }
});

test("saving again unchanged, and the daily pass after it, never add a second ask", () => {
  const first = setUpShortChest();
  const again = savePlanDayByPerson(1, "Upper", null, shortChestUpper());
  assert.equal(again.coverage_ask.status, "standing");
  assert.equal(again.coverage_ask.proposal_id, first.coverage_ask.proposal_id);
  const nightly = raisePlanCoverageAsk();
  assert.equal(nightly.status, "standing");
  assert.equal(nightly.proposal_id, first.coverage_ask.proposal_id);
  assert.equal(coverageRows().length, 1, "no second draft was ever written");
  assert.equal(liveHolds(first.coverage_ask.proposal_id).length, 1, "and no second hold on the one draft");
});

test("the daily pass raises the ask once, and a later save never duplicates it", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek().map((day, i) => (i === 0 ? { ...day, items: shortChestUpper() } : day)));
  const nightly = raisePlanCoverageAsk();
  assert.equal(nightly.status, "raised");
  assert.equal(raisePlanCoverageAsk().status, "standing");
  const saved = savePlanDayByPerson(1, "Upper", null, shortChestUpper());
  assert.equal(saved.coverage_ask.status, "standing");
  assert.equal(saved.coverage_ask.proposal_id, nightly.proposal_id);
  assert.equal(coverageRows().length, 1);
});

test("a gap that arose without a save — an intent change — is said by the daily pass", () => {
  repo.setProfile({ training_intent: { priorities: ["endurance", "strength"], endurance_role: "primary" } });
  repo.replacePlan(fedWeek().map((day, i) => (i === 0 ? { ...day, items: shortChestUpper() } : day)));
  assert.equal(raisePlanCoverageAsk().status, "none", "endurance-led: no floor, no ask");
  repo.setProfile(STRENGTH);
  const raised = raisePlanCoverageAsk();
  assert.equal(raised.status, "raised");
  assert.deepEqual(raised.gaps, ["group:chest"]);
});

test("a declined ask stays quiet until the lifts bearing on that gap change", () => {
  const first = setUpShortChest();
  repo.setProposalStatus(first.coverage_ask.proposal_id, "discarded");
  assert.equal(liveHolds(first.coverage_ask.proposal_id).length, 0, "the answer closes the hold");

  const resave = savePlanDayByPerson(1, "Upper", null, shortChestUpper());
  assert.equal(resave.coverage_ask.status, "answered");
  assert.equal(raisePlanCoverageAsk().status, "answered", "the daily pass respects the answer too");
  // An edit that does not touch chest is not a reason to ask again.
  savePlanDayByPerson(
    3,
    "Pull",
    null,
    fedWeek()[2].items.map((item) => (item.exercise === "Lat Pulldown" ? { ...item, sets: 6 } : item))
  );
  assert.equal(openRows().length, 0);

  // A changed chest lift is a different gap: asked once, afresh.
  const changed = savePlanDayByPerson(
    1,
    "Upper",
    null,
    shortChestUpper().map((item) => (item.exercise === "Incline Dumbbell Press" ? { ...item, exercise: "Cable Chest Press" } : item))
  );
  assert.equal(changed.coverage_ask.status, "raised");
  assert.notEqual(changed.coverage_ask.proposal_id, first.coverage_ask.proposal_id);
  assert.equal(openRows().length, 1);
});

test("an open ask whose gap closed is withdrawn quietly, never left standing", () => {
  const first = setUpShortChest();
  const fixed = savePlanDayByPerson(1, "Upper", null, fedWeek()[0].items);
  assert.equal(fixed.coverage_ask.status, "none");
  assert.deepEqual(fixed.coverage_ask.withdrawn, [first.coverage_ask.proposal_id]);
  assert.equal(repo.getProposal(first.coverage_ask.proposal_id).status, "superseded");
  assert.equal(liveHolds(first.coverage_ask.proposal_id).length, 0);
  // Withdrawn is not answered: the same gap coming back is asked again.
  assert.equal(savePlanDayByPerson(1, "Upper", null, shortChestUpper()).coverage_ask.status, "raised");
});

test("every existing exemption yields no ask", () => {
  const shortWeek = fedWeek().map((day, i) => (i === 0 ? { ...day, items: shortChestUpper() } : day));
  const noAsk = (label) => {
    const out = raisePlanCoverageAsk();
    assert.notEqual(out.status, "raised", label);
    assert.equal(openRows().length, 0, label);
  };
  repo.replacePlan(shortWeek);

  repo.setProfile({ training_intent: { priorities: ["longevity", "endurance"], endurance_role: "supporting" } });
  noAsk("no muscle or strength priority");
  repo.setProfile({ training_intent: { priorities: ["strength"], endurance_role: "primary" } });
  noAsk("endurance-led");

  repo.setProfile(STRENGTH);
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 2), reason: "a planned light week" });
  noAsk("a recovery week");
  db.prepare(`DELETE FROM recovery_cycles`).run();

  blocks.createBlock({ goal: "Ease off", focus: "strength", total_weeks: 6, week_index: 6, phase: "deload" });
  noAsk("a deload week");
  db.prepare(`DELETE FROM program_blocks`).run();

  repo.setProfile({ goal_mode: "lose", weight_lb: 200, goal_weight_lb: 180 });
  assert.equal(cutReaffirmation().reaffirmed, true, "precondition: an affirmed cut");
  noAsk("an affirmed cut holds the set count");
  repo.setProfile({ goal_mode: "maintain" });

  // Sanity: with nothing exempting it, the same week is asked about.
  assert.equal(raisePlanCoverageAsk().status, "raised");

  // The context-borne exemptions, read off the floor context the plan compiler uses.
  const base = { strength_priority: true, muscle_priority: false, endurance_carried: [], exempt: null };
  const plan = shortWeek;
  assert.deepEqual(
    planCoverageGap(localDateISO(), { plan, context: base }).elements.map((e) => e.key),
    ["group:chest"]
  );
  assert.deepEqual(planCoverageGap(localDateISO(), { plan, context: { ...base, exempt: "race_taper" } }).elements, []);
  assert.deepEqual(planCoverageGap(localDateISO(), { plan, context: { ...base, exempt: "deload_due" } }).elements, []);
  assert.deepEqual(
    planCoverageGap(localDateISO(), { plan, context: { ...base, endurance_carried: ["chest"] } }).elements,
    [],
    "a group the endurance work carries is never asked about"
  );
  // A strength-led athlete's taper trims the legs only: a missing leg family is not asked.
  const noLegs = fedWeek().map((day) => (day.day_number === 2 ? { ...day, items: [day.items[4]] } : day));
  const trimmed = planCoverageGap(localDateISO(), {
    plan: noLegs,
    context: { ...base, race_trimmed: ["quads", "hamstrings", "glutes", "calves"] },
  });
  assert.ok(!trimmed.elements.some((e) => e.key === "pattern:knee-dominant" || e.key === "pattern:hinge"));
  assert.ok(!trimmed.elements.some((e) => e.group === "quads" || e.group === "hamstrings"));
});

test("a broad week with no trunk work gets one ask for the missing family", () => {
  repo.setProfile(STRENGTH);
  const week = fedWeek();
  repo.replacePlan(week);
  const saved = savePlanDayByPerson(
    3,
    "Pull",
    null,
    week[2].items.filter((item) => item.muscle_group !== "core")
  );
  assert.equal(saved.coverage_ask.status, "raised");
  assert.deepEqual(saved.coverage_ask.gaps, ["pattern:trunk"]);
  const proposal = repo.getProposal(saved.coverage_ask.proposal_id);
  assert.equal(proposal.parsed.changes.length, 1);
  const [add] = proposal.parsed.changes;
  assert.ok(!/plank|carry|walk/i.test(add.exercise), "only rep work is offered");
  assert.match(saved.coverage_ask.explanation, /trunk work/);
  assert.equal(violatesReadingGrammar(saved.coverage_ask.explanation), null);
  // Applying it is the ordinary apply: the family is then covered and nothing is re-asked.
  repo.applyProposal(proposal.id);
  assert.deepEqual(planCoverageGap().elements, []);
  assert.equal(raisePlanCoverageAsk().status, "none");
});

test("every phrasing of the ask keeps the reading grammar", () => {
  const els = [
    { key: "group:chest", kind: "group", group: "chest" },
    { key: "group:back", kind: "group", group: "back" },
    { key: "pattern:hinge", kind: "pattern", pattern: "hinge" },
    { key: "pattern:trunk", kind: "pattern", pattern: "trunk" },
  ];
  const sets = [[els[0]], [els[0], els[1]], [els[2]], [els[0], els[3]], els];
  for (let day = 0; day < 9; day++) {
    const date = addDaysISO("2026-01-01", day);
    for (const covered of sets) {
      const text = coverageExplanation(covered, date);
      assert.equal(violatesReadingGrammar(text), null, text);
      assert.doesNotMatch(text, /\bmust\b|\bshould\b|\d/, text);
    }
  }
});

test("an open ask is rewritten when the athlete edits the lifts it would change, never applied stale", () => {
  const first = setUpShortChest();
  const before = repo.getProposal(first.coverage_ask.proposal_id).parsed.changes;
  // Bench goes from two sets to three by hand: chest is still short, but the old draft's
  // absolute counts no longer describe "a set more" from where the plan now stands.
  const edited = shortChestUpper().map((item) => (item.exercise === "Barbell Bench Press" ? { ...item, sets: 3 } : item));
  const again = savePlanDayByPerson(1, "Upper", null, edited);
  assert.equal(again.coverage_ask.status, "raised");
  assert.notEqual(again.coverage_ask.proposal_id, first.coverage_ask.proposal_id);
  assert.equal(openRows().length, 1, "still exactly one ask");
  const after = repo.getProposal(again.coverage_ask.proposal_id).parsed.changes;
  assert.notDeepEqual(after, before);
  const bench = after.find((c) => c.exercise === "Barbell Bench Press");
  assert.ok(!bench || bench.sets > 3, "the offer never lowers a count the athlete set");
});

test("an open injury keeps the remedy off the lifts it loads", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek());
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: localDateISO() });
  const saved = savePlanDayByPerson(1, "Upper", null, shortChestUpper());
  assert.equal(saved.ok, true);
  const id = saved.coverage_ask?.proposal_id;
  const changes = id ? repo.getProposal(id).parsed.changes : [];
  assert.ok(
    changes.every((c) => !/bench|press|fly|push-?up|dip/i.test(c.exercise)),
    `no pressing work is offered onto a sore shoulder: ${changes.map((c) => c.exercise).join(", ")}`
  );
});
