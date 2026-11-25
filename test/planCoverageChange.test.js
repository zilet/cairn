// A standing coverage gap is CLOSED by the coach — one bounded step at a time, through the
// ordinary autonomy path — and said. It edits a real person's plan by itself, so when in
// doubt it does nothing. Invariants:
//   1. lead: a set bump on lifts already in the plan quiet-applies with the server-owned
//      Undo and a falsifiable expectation; an added lift announces; announce_first
//      announces; review_everything holds exactly one draft;
//   2. one gap a pass, at most two added sets (or ONE known lift at its minimum dose), and
//      only on lifts with an established habit (VOLUME_BOUNDS: no habit, no raise); a
//      partial step says "a first step", and every number it states is the applied one;
//   3. Undo (or "Hold this") is the answer, remembered until the gap materially worsens;
//   4. no stacking: the next step waits until the last one was trained;
//   5. never into a session already composed; a protective reduction in force (an open
//      volume restore) holds the pass AND a change waiting at the boundary;
//   6. pain reported in words, an injury, or a constraint note keeps a lift untouched;
//   7. any safety read that fails changes nothing;
//   8. a person's own write is theirs; an agent's is not;
//   9. a leftover refused-floor ask from the first version is withdrawn quietly;
//  10. a dry run says what the next pass would do, and writes nothing.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { deletePlanDayByPerson, savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import { closePlanCoverageGap, previewPlanCoverageChange } from "../dist/domain/brain/coverage-change.js";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import {
  COVERAGE_AGENT,
  COVERAGE_INSTRUCTION,
  coverageExplanation,
  coverageGapFacts,
  coverageOfferStillFits,
  coverageProposalPayload,
  coverageRemedy,
  planCoverageGap,
  rankCoverageGaps,
  readPlanCoverage,
} from "../dist/repo/plan-coverage.js";
import { awaitingBrainDecisions, listBrainExpectations } from "../dist/repo/brain-decisions.js";
import { todayAgenda } from "../dist/repo/today-agenda.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

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

// Day 1 with chest at three sets a lift: chest falls a few sets under its floor.
const shortChestUpper = () => fedWeek()[0].items.map((item) => (item.muscle_group === "chest" ? { ...item, sets: 3 } : item));
const shortWeek = () => fedWeek().map((day, i) => (i === 0 ? { ...day, items: shortChestUpper() } : day));
const noTrunkWeek = () =>
  fedWeek().map((day) => (day.day_number === 3 ? { ...day, items: day.items.filter((i) => i.muscle_group !== "core") } : day));

const today = () => localDateISO();
const tomorrow = () => addDaysISO(today(), 1);
const coverageRows = () => db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ? ORDER BY id`).all(COVERAGE_AGENT);
const openRows = () => coverageRows().filter((row) => row.status === "draft");
const liveHolds = (proposalId) =>
  db
    .prepare(`SELECT id FROM brain_decisions WHERE source_ref_type = 'plan_proposal' AND source_ref_key = ? AND status = 'review'`)
    .all(String(proposalId));
const setsOf = (name, day = 1) => repo.getPlan().find((d) => d.day_number === day).items.find((i) => i.exercise === name)?.sets;
const benchSets = () => setsOf("Barbell Bench Press");
const agendaIds = () => {
  const agenda = todayAgenda(today());
  return [...agenda.primary, ...agenda.more].map((c) => String(c?.id ?? ""));
};

// An established habit: `sets` working sets a session on two sessions in the last weeks.
function seedHabit(exercise, sets, group) {
  if (group) repo.upsertExercise({ name: exercise, muscle_group: group });
  for (const daysAgo of [10, 17]) {
    for (let i = 0; i < sets; i++) {
      repo.logSetByName({ exercise, weight: 100, reps: 8, date: addDaysISO(today(), -daysAgo) });
    }
  }
}

// Chest short, and both chest lifts done at four sets a session (1.2 × 4 → room to four).
function shortChestPlan(leadMode = "lead", habit = 4) {
  repo.setSettings({ lead_mode: leadMode });
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  seedHabit("Barbell Bench Press", habit);
  seedHabit("Incline Dumbbell Press", habit);
  assert.deepEqual(planCoverageGap().elements.map((e) => e.key), ["group:chest"], "precondition: chest is short");
}

function assertHouseVoice(...texts) {
  for (const text of texts) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.doesNotMatch(text, /\bmust\b|\bshould\b|\bscore\b|\d/i, text);
  }
}

// Every "N more set(s) of A and B" the summary states equals what landed on each lift.
function assertSummaryIsTheAppliedDelta(summary, before) {
  const words = { one: 1, two: 2 };
  const said = new Map();
  for (const m of summary.matchAll(/(one|two) more sets? of ([^.,]+?)(?=, plus|, and add|\.)/g)) {
    for (const name of m[2].split(/, and | and |, /)) said.set(name.trim(), words[m[1]]);
  }
  assert.ok(said.size > 0, summary);
  for (const [name, delta] of said) assert.equal(setsOf(name) - before[name], delta, `${name}: ${summary}`);
}

test("lead: one bounded step quiet-applies, with Undo and an expectation, and says it is a first step", () => {
  shortChestPlan("lead");
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "changed");
  assert.equal(out.tier, "quiet_apply");
  assert.deepEqual(out.gaps, ["group:chest"]);
  assert.equal(benchSets(), 4, "one set on a lift with room under its habit");
  assert.equal(setsOf("Incline Dumbbell Press"), 4, "two added sets in all");
  assert.equal(out.partial, true, "four sets short, two added: a first step");
  assert.equal(out.summary, "On Upper, one more set of Barbell Bench Press and Incline Dumbbell Press.");
  assertSummaryIsTheAppliedDelta(out.summary, { "Barbell Bench Press": 3, "Incline Dumbbell Press": 3 });
  assert.match(out.explanation, /\bchest\b/);
  assert.match(out.explanation, /first step/);
  assert.match(out.explanation, /Undo/);
  assertHouseVoice(out.explanation);

  const proposal = repo.getProposal(out.proposal_id);
  assert.equal(proposal.status, "applied");
  const decision = db.prepare(`SELECT * FROM brain_decisions WHERE id = ?`).get(out.decision_id);
  assert.equal(decision.autonomy_tier, "quiet_apply");
  assert.equal(decision.reversible, 1, "the server-owned Undo rides along");
  assert.ok(db.prepare(`SELECT 1 FROM brain_rollbacks WHERE decision_id = ?`).get(out.decision_id), "with its snapshot");
  assert.ok(
    listBrainExpectations({ decisionId: out.decision_id }).some(
      (e) => e.metric_key === "exercise_target_completion" && e.subject_key === "Barbell Bench Press"
    ),
    "a falsifiable expectation: the bumped lift gets done"
  );
  assert.equal(awaitingBrainDecisions().length, 0, "nothing is waiting on the athlete");
  assert.ok(!agendaIds().includes("draft-proposals"), "no NEEDS YOUR DECISION card");
  // The rest of the gap waits until this step was trained.
  assert.equal(closePlanCoverageGap({ act: true }).status, "settling");
  assert.equal(coverageRows().length, 1);
});

test("no stacking: the next step comes only once the last one was trained", () => {
  shortChestPlan("lead", 5);
  assert.equal(closePlanCoverageGap({ act: true }).status, "changed");
  assert.equal(closePlanCoverageGap({ act: true }).status, "settling", "untrained: nothing stacks on it");
  for (const exercise of ["Barbell Bench Press", "Incline Dumbbell Press"]) {
    repo.logSetByName({ exercise, weight: 100, reps: 8, date: today() });
  }
  const next = closePlanCoverageGap({ act: true });
  assert.equal(next.status, "changed", "trained: the next bounded step");
  // Today's session has logged work, so the step waits for tomorrow's boundary.
  assert.equal(next.effective_date, tomorrow());
  assert.equal(benchSets(), 4, "never into a session under way");
  assert.deepEqual(applyDueAnnouncedDecisions(tomorrow()).applied, [next.decision_id]);
  assert.equal(benchSets(), 5);
  assert.equal(coverageRows().length, 2);
});

test("VOLUME_BOUNDS: no habit, no raise — and with no known lift to add, nothing at all", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "none", "nothing honest to do");
  assert.equal(coverageRows().length, 0);
  assert.equal(benchSets(), 3);
  assert.ok(coverageGapFacts().some((f) => f.gap === "chest" && !f.held), "the gap stays a fact for the next redraw");
  // A habit of three holds a lift at three (1.2 × 3 = 3): only the lift with room moves.
  seedHabit("Barbell Bench Press", 3);
  seedHabit("Incline Dumbbell Press", 4);
  const step = closePlanCoverageGap({ act: true });
  assert.equal(step.status, "changed");
  assert.equal(benchSets(), 3, "never past ~1.2x its habit");
  assert.equal(setsOf("Incline Dumbbell Press"), 4);
  assert.equal(step.summary, "On Upper, one more set of Incline Dumbbell Press.");
});

test("lead: when no lift in the plan has room, ONE known lift is added, announced, and lands at the boundary", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(noTrunkWeek());
  seedHabit("Cable Crunch", 3, "core");
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "changed");
  assert.equal(out.tier, "announce");
  assert.equal(out.effective_date, tomorrow());
  assert.deepEqual(out.gaps, ["pattern:trunk"]);
  assert.match(out.summary, /^On \w+, add Cable Crunch, two sets\.$/);
  assert.match(out.explanation, /trunk work/);
  assertHouseVoice(out.explanation);
  assert.equal(repo.getProposal(out.proposal_id).parsed.changes.length, 1, "one lift, nothing else");
  assert.ok(agendaIds().includes(`announced-decision-${out.decision_id}`), "the heads-up is the announce card");
  assert.ok(!agendaIds().includes("draft-proposals"), "never NEEDS YOUR DECISION");
  // A set logged before the boundary moves the training evidence, which says nothing
  // about a plan-coverage change: it still lands.
  repo.logSetByName({ exercise: "Back Squat", weight: 225, reps: 5, date: today() });
  const landed = applyDueAnnouncedDecisions(tomorrow());
  assert.deepEqual(landed.applied, [out.decision_id]);
  assert.deepEqual(planCoverageGap(tomorrow()).elements, [], "the family is in the week now");
});

test("a lift never done, or one carrying a constraint note, is never added", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(noTrunkWeek());
  repo.upsertExercise({ name: "Cable Crunch", muscle_group: "core" });
  assert.equal(closePlanCoverageGap({ act: true }).status, "none", "a stranger's lift is never offered");
  seedHabit("Cable Crunch", 3, "core");
  db.prepare(`UPDATE exercises SET constraint_note = 'neck strain under load' WHERE name = 'Cable Crunch'`).run();
  assert.equal(closePlanCoverageGap({ act: true }).status, "none");
  assert.equal(coverageRows().length, 0);
});

test("pain reported in words keeps every lift it loads untouched", () => {
  shortChestPlan("lead");
  repo.reportTrainingSymptom({ area_text: "left shoulder", onset_on: today(), report_text: "my left shoulder aches when I press" });
  const out = closePlanCoverageGap({ act: true });
  assert.notEqual(out.status, "changed");
  assert.equal(benchSets(), 3);
  assert.equal(setsOf("Incline Dumbbell Press"), 3);
});

test("an open injury keeps the remedy off the lifts it loads", () => {
  shortChestPlan("lead");
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: today() });
  closePlanCoverageGap({ act: true });
  assert.equal(benchSets(), 3);
  assert.equal(setsOf("Incline Dumbbell Press"), 3);
});

test("ranking: a missing movement family goes first, then the group furthest under its floor", () => {
  const els = [
    { key: "group:chest", kind: "group", group: "chest", planned: 8, low: 10, fingerprint: "a" },
    { key: "group:back", kind: "group", group: "back", planned: 4, low: 10, fingerprint: "b" },
    { key: "pattern:trunk", kind: "pattern", pattern: "trunk", fingerprint: "c" },
  ];
  assert.deepEqual(rankCoverageGaps(els).map((e) => e.key), ["pattern:trunk", "group:back", "group:chest"]);
});

test("announce_first announces a set bump; review_everything holds exactly one draft", () => {
  shortChestPlan("announce_first");
  const announced = closePlanCoverageGap({ act: true });
  assert.equal(announced.status, "changed");
  assert.equal(announced.tier, "announce");
  assert.equal(benchSets(), 3, "nothing lands before its boundary");
  assert.equal(closePlanCoverageGap({ act: true }).status, "standing", "the change in flight is not doubled");
  assert.equal(coverageRows().length, 1);

  db.prepare(`DELETE FROM brain_decisions`).run();
  db.prepare(`DELETE FROM plan_proposals`).run();
  repo.setSettings({ lead_mode: "review_everything" });
  const asked = closePlanCoverageGap({ act: true });
  assert.equal(asked.status, "asked");
  assert.equal(asked.tier, "ask");
  assert.equal(openRows().length, 1);
  assert.equal(liveHolds(asked.proposal_id).length, 1);
  const waiting = awaitingBrainDecisions().find((row) => row.id === asked.decision_id);
  assert.ok(waiting, "it waits where held changes wait");
  assert.match(waiting.explanation, /\bchest\b/);
  assertHouseVoice(waiting.explanation);
  const second = closePlanCoverageGap({ act: true });
  assert.equal(second.status, "standing");
  assert.equal(coverageRows().length, 1, "never a second draft");
});

test("Undo is the answer: the gap is left alone until it materially worsens", () => {
  shortChestPlan("lead");
  const out = closePlanCoverageGap({ act: true });
  assert.equal(revertDecision(out.decision_id).ok, true);
  assert.equal(benchSets(), 3, "Undo put the week back");
  assert.equal(closePlanCoverageGap({ act: true }).status, "declined", "a reverted change is not re-applied");
  assert.equal(coverageRows().length, 1);
  assert.equal(coverageGapFacts().find((f) => f.gap === "chest")?.declined, true, "the prompts read it as declined");
  // Chest taken two counted sets lower still (a redraw, not the person) is news.
  repo.replacePlan(
    fedWeek().map((day, i) =>
      i === 0 ? { ...day, items: shortChestUpper().map((item) => (item.exercise === "Incline Dumbbell Press" ? { ...item, sets: 1 } : item)) } : day
    )
  );
  assert.equal(closePlanCoverageGap({ act: true }).status, "changed");
});

test("'Hold this' on an announced change is the same answer", () => {
  shortChestPlan("announce_first");
  const out = closePlanCoverageGap({ act: true });
  assert.equal(revertDecision(out.decision_id).ok, true);
  assert.equal(closePlanCoverageGap({ act: true }).status, "declined");
  assert.equal(coverageGapFacts().find((f) => f.gap === "chest")?.declined, true);
  assert.equal(applyDueAnnouncedDecisions(tomorrow()).applied.length, 0, "nothing lands at the boundary");
});

test("a session already composed on a touched day is never rewritten: the change waits for the boundary", () => {
  shortChestPlan("lead");
  const session = repo.getOrCreateSession(today());
  const dayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 1`).get().id;
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, plan_day_id, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'manual_plan', 'active', ?, '[]', 'fixture')`
  ).run(session.id, today(), dayId);
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.tier, "quiet_apply");
  assert.equal(out.effective_date, tomorrow());
  assert.equal(benchSets(), 3, "today's composed Upper is untouched");
  repo.logSetByName({ exercise: "Barbell Overhead Press", weight: 95, reps: 8, date: today() });
  assert.deepEqual(applyDueAnnouncedDecisions(tomorrow()).applied, [out.decision_id], "it lands at the boundary");
  assert.equal(benchSets(), 4);
});

// What the fuel path writes when it cuts a slot and owes the sets back (volume-guard.ts).
function openRestore(exercise, applied, restoreTo) {
  db.prepare(
    `INSERT INTO brain_decisions (kind, domain, summary, source, status, autonomy_tier, risk_class, action_json)
     VALUES ('training_target', 'training', 'Fuel protection', 'auto-progression', 'applied', 'quiet_apply', 'low', ?)`
  ).run(JSON.stringify({ volume_restore: [{ day_number: 1, exercise, applied_sets: applied, restore_to: restoreTo, prior_sets: restoreTo, cause: "fuel" }] }));
}

test("a protective set cut still owed back is never refilled: the pass holds, and a waiting change is withdrawn", () => {
  shortChestPlan("lead");
  openRestore("Incline Dumbbell Press", 3, 5);
  const held = closePlanCoverageGap({ act: true });
  assert.equal(held.status, "held");
  assert.equal(held.hold, "volume_restore");
  assert.equal(coverageRows().length, 0);
  assert.equal(setsOf("Incline Dumbbell Press"), 3, "the restore keeps its own climb");
  assert.match(coverageGapFacts().find((f) => f.gap === "chest")?.held ?? "", /given back/);

  // At the boundary: a change announced before the cut is withdrawn quietly, not landed.
  db.prepare(`DELETE FROM brain_decisions`).run();
  repo.setSettings({ lead_mode: "announce_first" });
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.tier, "announce");
  openRestore("Incline Dumbbell Press", 3, 5);
  const boundary = applyDueAnnouncedDecisions(tomorrow());
  assert.deepEqual(boundary.applied, []);
  assert.equal(repo.getProposal(out.proposal_id).status, "superseded");
  assert.equal(db.prepare(`SELECT status FROM brain_decisions WHERE id = ?`).get(out.decision_id).status, "canceled");
  assert.equal(benchSets(), 3, "the plan is untouched");
  assert.equal(awaitingBrainDecisions().length, 0, "and nothing became a question");
});

test("a change whose premise is gone is withdrawn at the first gate and at the boundary, never applied stale", () => {
  shortChestPlan("lead");
  // First gate: the athlete edits a slot the offer bumps between the draft and its routing.
  const remedy = coverageRemedy(readPlanCoverage().askable);
  const draft = repo.createProposal(COVERAGE_AGENT, COVERAGE_INSTRUCTION, "", coverageProposalPayload(remedy, today()));
  repo.replacePlan(
    fedWeek().map((day, i) => (i === 0 ? { ...day, items: shortChestUpper().map((it) => (it.exercise === "Barbell Bench Press" ? { ...it, sets: 2 } : it)) } : day))
  );
  const routed = applyProposalWithAutonomy(draft.id, {});
  assert.equal(routed.superseded, true);
  assert.equal(repo.getProposal(draft.id).status, "superseded");
  assert.equal(benchSets(), 2, "nothing written over the athlete's count");

  // Boundary: an announced change whose gap the plan closed meanwhile.
  db.prepare(`DELETE FROM brain_decisions`).run();
  db.prepare(`DELETE FROM plan_proposals`).run();
  repo.replacePlan(shortWeek());
  repo.setSettings({ lead_mode: "announce_first" });
  const out = closePlanCoverageGap({ act: true });
  repo.replacePlan(fedWeek());
  assert.deepEqual(applyDueAnnouncedDecisions(tomorrow()).applied, []);
  assert.equal(repo.getProposal(out.proposal_id).status, "superseded");
  assert.equal(db.prepare(`SELECT status FROM brain_decisions WHERE id = ?`).get(out.decision_id).status, "canceled");
  assert.equal(benchSets(), 5);
});

test("the coverage path never lowers a slot or rewrites its rep range", () => {
  shortChestPlan("lead");
  const plan = repo.getPlan();
  const id = repo.resolveExerciseName("Barbell Bench Press").key;
  const lower = [{ day_number: 1, exercise: "Barbell Bench Press", sets: 2, reason: "x" }];
  assert.equal(coverageOfferStillFits(lower, [{ day_number: 1, identity: id, sets: 3 }], { plan }), false);
  const reps = [{ day_number: 1, exercise: "Barbell Bench Press", sets: 4, rep_low: 8, rep_high: 12, reason: "x" }];
  assert.equal(coverageOfferStillFits(reps, [{ day_number: 1, identity: id, sets: 3 }], { plan }), false);
  const raise = [{ day_number: 1, exercise: "Barbell Bench Press", sets: 4, reason: "x" }];
  assert.equal(coverageOfferStillFits(raise, [{ day_number: 1, identity: id, sets: 3 }], { plan }), true);
});

test("a safety read that fails changes nothing and withdraws nothing", () => {
  // Acting: the plan, the injury read (context events) and the habit read (logged sets)
  // each failing in turn makes the pass unavailable — no draft, no plan write.
  shortChestPlan("lead");
  for (const table of ["plan_days", "context_events", "logged_sets"]) {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_unreadable`);
    let out;
    try {
      out = closePlanCoverageGap({ act: true });
    } finally {
      db.exec(`ALTER TABLE ${table}_unreadable RENAME TO ${table}`);
    }
    assert.equal(out.status, "unavailable", `${table} unreadable`);
    assert.equal(coverageRows().length, 0, `${table}: no draft`);
    assert.equal(benchSets(), 3, `${table}: no plan write`);
  }
  // With a draft already open, a failed read never withdraws it.
  db.prepare(`DELETE FROM brain_decisions`).run();
  repo.setSettings({ lead_mode: "review_everything" });
  const asked = closePlanCoverageGap({ act: true });
  assert.equal(asked.status, "asked");
  db.exec(`ALTER TABLE context_events RENAME TO context_events_unreadable`);
  let out;
  try {
    out = closePlanCoverageGap({ act: true });
  } finally {
    db.exec(`ALTER TABLE context_events_unreadable RENAME TO context_events`);
  }
  assert.notEqual(out.status, "changed");
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(openRows().map((row) => row.id), [asked.proposal_id]);
});

test("the save path never edits the plan back; the daily pass closes a gap the save did not make", () => {
  shortChestPlan("lead");
  const saved = savePlanDayByPerson(
    3,
    "Pull",
    null,
    fedWeek()[2].items.map((item) => (item.exercise === "Lat Pulldown" ? { ...item, sets: 6 } : item))
  );
  assert.equal(saved.coverage.status, "deferred");
  assert.equal(coverageRows().length, 0, "no change was routed on the save");
  assert.equal(benchSets(), 3);
  assert.equal(closePlanCoverageGap({ act: true }).status, "changed", "the daily pass closes it");
});

test("a gap the person's own save made is theirs: left alone, and declined in the prompt facts", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek());
  seedHabit("Barbell Bench Press", 5);
  seedHabit("Incline Dumbbell Press", 5);
  const saved = savePlanDayByPerson(1, "Upper", null, shortChestUpper());
  assert.deepEqual(saved.coverage.kept_by_person, ["group:chest"]);
  assert.equal(saved.coverage.status, "declined");
  assert.equal(closePlanCoverageGap({ act: true }).status, "declined", "the daily pass leaves their choice alone");
  assert.equal(coverageRows().length, 0);
  assert.equal(coverageGapFacts().find((f) => f.gap === "chest")?.declined, true);
  // Their choice ends when the gap closes; a later cut that is not theirs is closed.
  savePlanDayByPerson(1, "Upper", null, fedWeek()[0].items);
  assert.equal(closePlanCoverageGap({ act: true }).status, "none");
  repo.replacePlan(shortWeek());
  assert.equal(closePlanCoverageGap({ act: true }).status, "changed");
});

// The chest cut as a named-slot edit: the payload a chat plan edit carries.
const chestCut = () => ({
  summary: "Bench and incline down to four sets.",
  changes: [
    { day_number: 1, exercise: "Barbell Bench Press", sets: 4, reason: "Asked for." },
    { day_number: 1, exercise: "Incline Dumbbell Press", sets: 4, reason: "Asked for." },
  ],
});

test("a gap the person ASKED for (an explicit-request edit) is theirs, exactly like a save", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek());
  seedHabit("Barbell Bench Press", 5);
  seedHabit("Incline Dumbbell Press", 5);
  const draft = repo.createProposal("claude", "chat: take chest down", "", chestCut());
  const routed = applyProposalWithAutonomy(draft.id, { explicit_user_request: true });
  assert.equal(routed.ok, true, JSON.stringify(routed));
  assert.equal(benchSets(), 4, "their edit landed");
  assert.deepEqual(readPlanCoverage().standing.map((e) => e.key), ["group:chest"]);
  assert.notEqual(closePlanCoverageGap({ act: true }).status, "changed", "the daily pass leaves it alone");
  assert.equal(coverageRows().length, 0);
  assert.equal(coverageGapFacts().find((f) => f.gap === "chest")?.declined, true, "recorded as their own choice");
});

test("the same cut by an agent, an orphan-adopted chat draft, or a restructure they asked for is not theirs", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek());
  seedHabit("Barbell Bench Press", 5);
  seedHabit("Incline Dumbbell Press", 5);
  // An agent's cut: not theirs — and the sets it owes back are the restore ledger's to
  // return, so coverage holds rather than refilling them on its own.
  repo.applyProposal(repo.createProposal("claude", "auto: weekly review", "", chestCut()).id);
  assert.equal(benchSets(), 4);
  assert.equal(coverageGapFacts().find((f) => f.gap === "chest")?.declined, undefined, "not recorded as theirs");
  const agentCut = closePlanCoverageGap({ act: true });
  assert.equal(agentCut.status, "held");
  assert.equal(agentCut.hold, "volume_restore");

  // An older chat turn's leftover the orphan sweep adopts is not a request made now.
  db.prepare(`DELETE FROM brain_decisions`).run();
  db.prepare(`DELETE FROM plan_proposals`).run();
  db.prepare(`DELETE FROM app_state WHERE key = 'coverage_person_kept_v1'`).run();
  repo.replacePlan(fedWeek());
  const orphan = repo.createProposal("claude", "chat: take chest down", "", chestCut());
  repo.applyProposal(orphan.id, {
    byPersonRequest: true,
    orphanSiblingCleanup: { intent_key: "k", eligible_before: new Date().toISOString(), provenance: "background_chat" },
  });
  assert.equal(benchSets(), 4);
  assert.equal(coverageGapFacts().find((f) => f.gap === "chest")?.declined, undefined, "an adopted orphan is not theirs");

  // A whole new week the person asked for is the agent's authorship of the week.
  db.prepare(`DELETE FROM brain_decisions`).run();
  db.prepare(`DELETE FROM plan_proposals`).run();
  repo.replacePlan(fedWeek());
  const redraw = repo.createProposal("claude", "chat: build me a new week", "", { summary: "A new week.", days: shortWeek() });
  repo.applyProposal(redraw.id, { byPersonRequest: true });
  assert.deepEqual(planCoverageGap().elements.map((e) => e.key), ["group:chest"]);
  assert.equal(closePlanCoverageGap({ act: true }).status, "changed");
});

test("a day the person deletes leaves gaps that are theirs", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
  repo.replacePlan(fedWeek());
  const out = deletePlanDayByPerson(3);
  assert.ok(out.coverage.kept_by_person.includes("group:back"), JSON.stringify(out.coverage));
  assert.equal(closePlanCoverageGap({ act: true }).status, "declined");
  assert.equal(coverageRows().length, 0);
});

test("a leftover refused-floor ask from the first version is withdrawn quietly and re-decided by policy", () => {
  shortChestPlan("lead");
  // Exactly what the first version wrote: a v2 coverage draft routed with clamp_refused.
  const remedy = coverageRemedy(readPlanCoverage().askable);
  const payload = coverageProposalPayload(remedy, today());
  payload.coverage_gap = { ...payload.coverage_gap, version: 2, explanation: remedy.ask_explanation };
  delete payload.coverage_gap.adds_lift;
  delete payload.coverage_gap.partial;
  const old = repo.createProposal(COVERAGE_AGENT, COVERAGE_INSTRUCTION, "", payload);
  const held = applyProposalWithAutonomy(old.id, { clamp_refused: true });
  assert.equal(held.review_required, true);
  assert.equal(repo.getProposal(old.id).autonomy.review_reason_code, "safety_floor");
  assert.ok(agendaIds().includes("draft-proposals"), "precondition: the old card");

  const out = closePlanCoverageGap({ act: true });
  assert.deepEqual(out.withdrawn, [old.id]);
  assert.equal(repo.getProposal(old.id).status, "superseded");
  assert.equal(liveHolds(old.id).length, 0, "its hold is gone");
  assert.equal(out.status, "changed");
  assert.equal(out.tier, "quiet_apply");
  assert.ok(!agendaIds().includes("draft-proposals"), "no NEEDS YOUR DECISION card any more");

  // Under a lead mode that asks, the leftover is replaced by ONE held draft.
  db.prepare(`DELETE FROM brain_decisions`).run();
  db.prepare(`DELETE FROM plan_proposals`).run();
  repo.replacePlan(shortWeek());
  const again = repo.createProposal(COVERAGE_AGENT, COVERAGE_INSTRUCTION, "", payload);
  applyProposalWithAutonomy(again.id, { clamp_refused: true });
  repo.setSettings({ lead_mode: "review_everything" });
  assert.equal(closePlanCoverageGap({ act: true }).status, "asked");
  assert.equal(openRows().length, 1, "still exactly one held draft");
});

test("a dry run says exactly what the next pass would change, and writes nothing", () => {
  shortChestPlan("lead");
  const preview = previewPlanCoverageChange();
  assert.equal(preview.status, "would_change");
  assert.equal(preview.partial, true);
  assert.equal(coverageRows().length, 0, "no draft");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0, "no decision");
  assert.equal(benchSets(), 3, "no plan write");
  const acted = closePlanCoverageGap({ act: true });
  assert.equal(acted.summary, preview.summary);
  assert.deepEqual(
    repo.getProposal(acted.proposal_id).parsed.changes.map((c) => [c.day_number, c.exercise, c.sets]),
    preview.changes.map((c) => [c.day_number, c.exercise, c.sets])
  );
});

test("every phrasing keeps the reading grammar, in both registers, full or a first step", () => {
  const els = [
    { key: "group:chest", kind: "group", group: "chest", planned: 4, low: 6 },
    { key: "group:back", kind: "group", group: "back" },
    { key: "pattern:hinge", kind: "pattern", pattern: "hinge" },
    { key: "pattern:trunk", kind: "pattern", pattern: "trunk" },
  ];
  const sets = [[els[0]], [els[0], els[1]], [els[2]], [els[0], els[3]], els];
  for (let day = 0; day < 9; day++) {
    const date = addDaysISO("2026-01-01", day);
    for (const covered of sets) {
      for (const register of ["act", "ask"]) {
        for (const partial of [false, true]) assertHouseVoice(coverageExplanation(covered, date, register, partial));
      }
    }
  }
});
