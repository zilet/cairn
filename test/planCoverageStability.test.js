// The coverage change does not flicker with the week. The gap is judged on the plan AS
// WRITTEN; what varies week to week is a HOLD — nothing new is changed under it, and a
// draft already open is never withdrawn for it (plan-coverage.ts readPlanCoverage,
// coverage-change.ts). Covered here:
//   - a recovery week, a deload block, an affirmed cut and a trip each hold: no ask is
//     raised while they last, an open one stays exactly as it was, and when the window
//     passes the same ask is still the one standing (or is raised then, if none was);
//   - an open ask the plan itself closed during a hold is still withdrawn;
//   - an injury opened under an open ask that would load it withdraws it, and no pressing
//     is re-offered onto the sore shoulder;
//   - a "no" is never pushed out of the lookup by however many withdrawn asks pile up;
//   - the standing gap reaches the plan-shaping prompts as DATA.coverage_gaps, with a
//     declined gap marked, and the precheck and the compiler read the same definition.
// The hold mechanics are read under review_everything, the lead mode in which a coverage
// change is held as an open draft (under lead the same change lands at once and closes the
// gap — test/planCoverageChange.test.js); the open-draft rules are the same either way.
// Synthetic fixtures only. Deterministic and offline.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import { closePlanCoverageGap } from "../dist/domain/brain/coverage-change.js";
import {
  COVERAGE_AGENT,
  COVERAGE_INSTRUCTION,
  coverageChangeRows,
  coverageGapFacts,
  readPlanCoverage,
} from "../dist/repo/plan-coverage.js";
import { validateTrainingPlan, weeklyFloorShortfalls } from "../dist/repo/plan-quality.js";
import { planVolumeFloorViolations } from "../dist/repo/verify-floors.js";
import { scheduleRecoveryCycle } from "../dist/repo/recovery-cycles.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { cutReaffirmation } from "../dist/repo/cut-target.js";
import * as blocks from "../dist/repo/program-blocks.js";
import { promptData } from "../dist/prompt/context-projection.js";
import { getCoachContext } from "../dist/repo/coach.js";

// Both chest lifts carry an established four-set habit (two sessions in recent weeks), so
// the bounded remedy has room to step them (VOLUME_BOUNDS: no habit, no raise).
beforeEach(() => {
  repo.setSettings({ lead_mode: "review_everything" });
  for (const exercise of ["Barbell Bench Press", "Incline Dumbbell Press"]) {
    for (const daysAgo of [10, 17]) {
      for (let i = 0; i < 4; i++) repo.logSetByName({ exercise, weight: 100, reps: 8, date: addDaysISO(localDateISO(), -daysAgo) });
    }
  }
});

const STRENGTH = { training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" } };

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
const shortChestUpper = () => fedWeek()[0].items.map((item) => (item.muscle_group === "chest" ? { ...item, sets: 2 } : item));
const shortWeek = () => fedWeek().map((day, i) => (i === 0 ? { ...day, items: shortChestUpper() } : day));

const coverageRows = () =>
  db.prepare(`SELECT id, status FROM plan_proposals WHERE agent = ? ORDER BY id`).all(COVERAGE_AGENT);
const openRows = () => coverageRows().filter((row) => row.status === "draft");

function raisedShortChest() {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  const raised = closePlanCoverageGap({ act: true });
  assert.equal(raised.status, "asked");
  return raised.proposal_id;
}

// A hold opens, the daily pass runs under it, the hold closes: the one ask never moved.
function holdsSteady(label, open, close) {
  const id = raisedShortChest();
  open();
  const during = closePlanCoverageGap({ act: true });
  assert.equal(during.status, "held", `${label}: the week is held`);
  assert.equal(during.proposal_id, id, `${label}: the open ask stands`);
  assert.deepEqual(during.withdrawn, [], `${label}: nothing withdrawn for a varying week`);
  assert.deepEqual(
    openRows().map((row) => row.id),
    [id],
    `${label}: still exactly the one ask`
  );
  close();
  const after = closePlanCoverageGap({ act: true });
  assert.equal(after.status, "standing", `${label}: after the window, the same ask stands`);
  assert.equal(after.proposal_id, id);
  assert.equal(coverageRows().length, 1, `${label}: no second draft was ever written`);
}

test("a recovery week holds the ask: never withdrawn, never re-raised", () => {
  holdsSteady(
    "recovery week",
    () => scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 1), reason: "a planned light week" }),
    () => db.prepare(`DELETE FROM recovery_cycles`).run()
  );
});

test("a deload block holds the ask", () => {
  holdsSteady(
    "deload",
    () => blocks.createBlock({ goal: "Ease off", focus: "strength", total_weeks: 6, week_index: 6, phase: "deload" }),
    () => db.prepare(`DELETE FROM program_blocks`).run()
  );
});

test("a realization (peaking) week holds the ask", () => {
  holdsSteady(
    "realization",
    () => blocks.createBlock({ goal: "Peak", focus: "strength", total_weeks: 8, week_index: 3, phase: "realization" }),
    () => db.prepare(`DELETE FROM program_blocks`).run()
  );
});

test("an affirmed cut holds the ask", () => {
  holdsSteady(
    "affirmed cut",
    () => {
      repo.setProfile({ goal_mode: "lose", weight_lb: 200, goal_weight_lb: 180 });
      assert.equal(cutReaffirmation().reaffirmed, true, "precondition: an affirmed cut");
    },
    () => repo.setProfile({ goal_mode: "maintain" })
  );
});

test("a trip holds the ask", () => {
  let tripId = null;
  holdsSteady(
    "trip",
    () => {
      tripId = repo.addContextEvent({
        kind: "trip",
        title: "Work trip",
        start_date: localDateISO(),
        end_date: addDaysISO(localDateISO(), 4),
      })?.id;
      assert.ok(tripId, "precondition: a trip");
    },
    () => db.prepare(`DELETE FROM context_events WHERE kind = 'trip'`).run()
  );
});

test("nothing is raised during a held week; the ask comes when it passes", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 1), reason: "a planned light week" });
  const held = closePlanCoverageGap({ act: true });
  assert.equal(held.status, "held");
  assert.equal(held.hold, "recovery_week");
  assert.equal(coverageRows().length, 0, "no draft written under the hold");
  db.prepare(`DELETE FROM recovery_cycles`).run();
  assert.equal(closePlanCoverageGap({ act: true }).status, "asked");
});

test("an ask the plan itself closed is withdrawn even during a held week", () => {
  const id = raisedShortChest();
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 1), reason: "a planned light week" });
  const fixed = savePlanDayByPerson(1, "Upper", null, fedWeek()[0].items);
  assert.deepEqual(fixed.coverage.withdrawn, [id]);
  assert.equal(repo.getProposal(id).status, "superseded");
  assert.equal(openRows().length, 0);
});

test("an injury opened under an open ask withdraws an offer that would load it", () => {
  const id = raisedShortChest();
  const before = repo.getProposal(id).parsed.changes;
  assert.ok(before.some((c) => /press/i.test(c.exercise)), "precondition: the offer presses");
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: localDateISO() });
  const out = closePlanCoverageGap({ act: true });
  assert.ok(out.withdrawn.includes(id), "the pressing offer is withdrawn");
  const open = openRows();
  for (const row of open) {
    const changes = repo.getProposal(row.id).parsed.changes;
    assert.ok(
      changes.every((c) => !/bench|press|fly|push-?up|dip/i.test(c.exercise)),
      `no pressing onto a sore shoulder: ${changes.map((c) => c.exercise).join(", ")}`
    );
  }
});

test("a week with no pressing at all is not asked to add pressing while a shoulder injury is open", () => {
  repo.setProfile(STRENGTH);
  const noPress = fedWeek().map((day, i) =>
    i === 0 ? { ...day, items: day.items.filter((item) => item.muscle_group !== "chest") } : day
  );
  repo.replacePlan(noPress);
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: localDateISO() });
  const read = readPlanCoverage();
  assert.ok(read.standing.some((el) => el.key === "pattern:horizontal-push"), "precondition: the family is missing");
  closePlanCoverageGap({ act: true });
  for (const row of openRows()) {
    const changes = repo.getProposal(row.id).parsed.changes;
    assert.ok(
      changes.every((c) => !/bench|press|fly|push-?up|dip/i.test(c.exercise)),
      `nothing pressing is offered: ${changes.map((c) => c.exercise).join(", ")}`
    );
    assert.ok(
      !repo.getProposal(row.id).parsed.coverage_gap.elements.some((el) => el.key === "pattern:horizontal-push"),
      "the pressing gap is not asked about"
    );
  }
});

test("a no is never pushed out of the lookup by withdrawn asks piling up", () => {
  const id = raisedShortChest();
  repo.setProposalStatus(id, "discarded");
  const insert = db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status) VALUES (?, ?, '', ?, 'superseded')`
  );
  const parsed = JSON.stringify({ changes: [], coverage_gap: { version: 2, elements: [{ key: "group:back", fingerprint: "x" }] } });
  for (let i = 0; i < 260; i++) insert.run(COVERAGE_AGENT, COVERAGE_INSTRUCTION, parsed);
  const rows = coverageChangeRows();
  assert.ok(rows.some((row) => row.id === id && row.status === "discarded"), "the answer is read");
  assert.ok(rows.every((row) => row.status !== "superseded"), "withdrawn rows are not read at all");
  assert.equal(closePlanCoverageGap({ act: true }).status, "declined");
});

test("the standing gap is the plan as written: a light week hides nothing from it", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 1), reason: "a planned light week" });
  const read = readPlanCoverage();
  assert.equal(read.hold, "recovery_week");
  assert.deepEqual(read.standing.map((el) => el.key), ["group:chest"]);
  assert.deepEqual(read.askable, []);
});

test("the plan-shaping prompts carry the standing gaps: open ones to close, a declined one marked", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  const facts = coverageGapFacts();
  assert.deepEqual(facts.map((f) => f.gap), ["chest"]);
  assert.equal(facts[0].held, undefined, "an ordinary week holds nothing: the draft should close it");
  assert.equal(facts[0].declined, undefined);
  const data = JSON.parse(promptData(getCoachContext(), "program_evolution"));
  assert.ok(Array.isArray(data.coverage_gaps) && data.coverage_gaps.some((f) => f.gap === "chest"), "evolution sees it");
  const coach = JSON.parse(promptData(getCoachContext(), "coach"));
  assert.ok(Array.isArray(coach.coverage_gaps), "the coach site carries it too");

  const raised = closePlanCoverageGap({ act: true });
  repo.setProposalStatus(raised.proposal_id, "discarded");
  assert.equal(coverageGapFacts()[0].declined, true, "a gap the athlete kept is said so");
});

test("the bounded declined read pages past newer answers about other gaps", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  const raised = closePlanCoverageGap({ act: true });
  repo.setProposalStatus(raised.proposal_id, "discarded");
  const insert = db.prepare(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status) VALUES (?, ?, '', ?, 'applied')`
  );
  for (let i = 0; i < 45; i++) {
    const parsed = JSON.stringify({ changes: [], coverage_gap: { version: 2, elements: [{ key: "group:back", fingerprint: `other-${i}` }] } });
    insert.run(COVERAGE_AGENT, COVERAGE_INSTRUCTION, parsed);
  }
  assert.equal(coverageGapFacts()[0].declined, true, "the older no is still found");
});

test("a light week marks every gap held, agreeing with the floor's own applies:false", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  scheduleRecoveryCycle({ effective_on: addDaysISO(localDateISO(), 1), reason: "a planned light week" });
  const ctx = getCoachContext();
  assert.equal(ctx.weekly_set_targets.applies, false, "precondition: the floor stands aside this week");
  assert.ok(ctx.coverage_gaps.length > 0);
  for (const fact of ctx.coverage_gaps) assert.match(fact.held ?? "", /recovery week/, JSON.stringify(fact));
});

// A week whose legs are short: quads and hamstrings under their floors.
const shortLegs = () =>
  fedWeek().map((day) =>
    day.day_number === 2
      ? { ...day, items: day.items.map((item) => ({ ...item, sets: item.muscle_group === "glutes" ? item.sets : 1 })) }
      : day
  );

test("a runner's legs carried by running are held, never 'close the gap'", () => {
  repo.setProfile(STRENGTH);
  const base = { strength_priority: true, muscle_priority: false, endurance_carried: ["quads", "hamstrings"], exempt: null };
  const facts = coverageGapFacts(localDateISO(), { plan: shortLegs(), context: base });
  const quads = facts.find((f) => f.gap === "quads");
  const hams = facts.find((f) => f.gap === "hamstrings");
  assert.ok(quads && hams, `precondition: both groups short as written: ${JSON.stringify(facts)}`);
  assert.match(quads.held ?? "", /endurance training already carries/);
  assert.match(hams.held ?? "", /endurance training already carries/);
});

test("the race taper holds the gaps: whole week for an endurance-led taper, the legs for a strength-led one", () => {
  repo.setProfile(STRENGTH);
  const base = { strength_priority: true, muscle_priority: false, endurance_carried: [], exempt: null };
  const exempt = coverageGapFacts(localDateISO(), { plan: shortLegs(), context: { ...base, exempt: "race_taper" } });
  assert.ok(exempt.length > 0);
  for (const fact of exempt) assert.match(fact.held ?? "", /race taper or race week/);

  const week = shortLegs().map((day) => (day.day_number === 1 ? { ...day, items: shortChestUpper() } : day));
  const trimmed = coverageGapFacts(localDateISO(), {
    plan: week,
    context: { ...base, race_trimmed: ["quads", "hamstrings", "glutes", "calves"] },
  });
  assert.match(trimmed.find((f) => f.gap === "quads")?.held ?? "", /taper trims the legs/);
  assert.equal(trimmed.find((f) => f.gap === "chest")?.held, undefined, "the upper body keeps its floor through the taper");
});

test("a gap an open injury loads is held", () => {
  repo.setProfile(STRENGTH);
  repo.replacePlan(shortWeek());
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: localDateISO() });
  const chest = coverageGapFacts().find((f) => f.gap === "chest");
  assert.match(chest?.held ?? "", /open injury/);
});

test("a read that failed raises nothing and withdraws nothing", () => {
  const id = raisedShortChest();
  assert.equal(readPlanCoverage(localDateISO(), { context: null }).status, "unavailable");
  db.exec("ALTER TABLE plan_days RENAME TO plan_days_unreadable");
  let out;
  try {
    out = closePlanCoverageGap({ act: true });
  } finally {
    db.exec("ALTER TABLE plan_days_unreadable RENAME TO plan_days");
  }
  assert.equal(out.status, "unavailable");
  assert.deepEqual(out.withdrawn, []);
  assert.deepEqual(openRows().map((row) => row.id), [id], "the open ask stands");
  assert.equal(closePlanCoverageGap({ act: true }).status, "standing", "and is still the one once the read works again");
});

test("the compiler, the precheck and the coverage read share one floor definition", () => {
  const ctx = { strength_priority: true, muscle_priority: false, endurance_carried: [], exempt: null };
  const week = shortWeek();
  const short = weeklyFloorShortfalls(week, ctx).map((s) => s.group);
  const warned = validateTrainingPlan(week, { volumeFloor: ctx })
    .warnings.filter((w) => w.code === "muscle_density_low")
    .map((w) => w.muscle_group);
  assert.deepEqual(warned, short);
  const flagged = planVolumeFloorViolations(week, fedWeek(), ctx).map((v) => v.message.split(" ")[0]);
  assert.deepEqual(flagged, short);
  repo.setProfile(STRENGTH);
  assert.deepEqual(
    readPlanCoverage(localDateISO(), { plan: week, context: ctx }).standing.filter((el) => el.kind === "group").map((el) => el.group),
    short
  );
});
