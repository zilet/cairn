// A lift the athlete's plan lost FOR PAIN is never offered back by coverage: bringing it back
// is the pain-adaptation restore's call. The evidence is the ledger of what landed (an applied
// plan proposal whose change removed or swapped the lift out, with a pain tie on it); a lift
// removed for any other reason stays eligible, a lift still in the plan is a set bump and
// unaffected, and an unreadable ledger row fails closed.
// Synthetic fixtures only. Deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { closePlanCoverageGap } from "../dist/domain/brain/coverage-change.js";
import { COVERAGE_AGENT, coverageRemedy, readPlanCoverage } from "../dist/repo/plan-coverage.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const STRENGTH = { training_intent: { priorities: ["strength", "longevity"], endurance_role: "none" } };
const today = () => localDateISO();

// A week that clears every floor but trunk work: the gap is "pattern:trunk", and with no
// core lift in the plan the only remedy is ONE known lift added.
function noTrunkWeek({ withCrunch = false } = {}) {
  const week = [
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
      ],
    },
  ];
  if (withCrunch) week[2].items.push({ exercise: "Cable Crunch", muscle_group: "core", sets: 3, rep_low: 10, rep_high: 15 });
  return week;
}

function seedKnown(exercise, dates) {
  repo.upsertExercise({ name: exercise, muscle_group: "core" });
  for (const daysAgo of dates) {
    for (let i = 0; i < 3; i++) repo.logSetByName({ exercise, weight: 40, reps: 12, date: addDaysISO(today(), -daysAgo) });
  }
}

// The plan loses Cable Crunch through the ordinary applied-proposal path, for `reason`.
function dropCableCrunch(reason, extra = {}) {
  repo.replacePlan(noTrunkWeek({ withCrunch: true }));
  const proposal = repo.createProposal("claude", "auto: weekly review", "", {
    summary: "Take Cable Crunch out of the Pull day.",
    changes: [{ day_number: 3, exercise: "Cable Crunch", remove: true, reason, ...extra }],
  });
  const applied = repo.applyProposal(Number(proposal.id));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.ok(
    !repo.getPlan().some((d) => d.items.some((i) => i.exercise === "Cable Crunch")),
    "precondition: the lift is out of the plan"
  );
  assert.deepEqual(readPlanCoverage().askable.map((e) => e.key), ["pattern:trunk"], "precondition: trunk is the gap");
}

function setup() {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile(STRENGTH);
}

const coverageRows = () => db.prepare(`SELECT id FROM plan_proposals WHERE agent = ?`).all(COVERAGE_AGENT);
const remedyNames = () => coverageRemedy(readPlanCoverage().askable)?.changes.map((c) => c.exercise) ?? [];

test("a lift dropped for pain is skipped and the next known lift for the group is chosen", () => {
  setup();
  // Cable Crunch is the athlete's most-trained core lift; Ab Wheel Rollout is the next.
  seedKnown("Cable Crunch", [10, 17, 24]);
  seedKnown("Ab Wheel Rollout", [10, 17]);
  dropCableCrunch("Low back pain on crunches, taking it out");
  assert.deepEqual(remedyNames(), ["Ab Wheel Rollout"]);
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "changed");
  const names = repo.getPlan().flatMap((d) => d.items.map((i) => i.exercise));
  assert.equal(out.tier, "announce", "an added lift is announced");
  assert.match(out.summary, /add Ab Wheel Rollout/);
  assert.ok(!names.includes("Cable Crunch"), "the pain-dropped lift never comes back through coverage");
});

test("a lift dropped for pain, as the only candidate, means no change at all", () => {
  setup();
  seedKnown("Cable Crunch", [10, 17, 24]);
  dropCableCrunch("Low back pain on crunches, taking it out");
  assert.deepEqual(remedyNames(), []);
  const before = JSON.stringify(repo.getPlan());
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "none");
  assert.equal(coverageRows().length, 0, "no proposal");
  assert.equal(JSON.stringify(repo.getPlan()), before, "no plan change");
});

test("a pain tie on the change's provenance, with no pain word in its reason, counts", () => {
  setup();
  seedKnown("Cable Crunch", [10, 17, 24]);
  dropCableCrunch("Taking it out of the Pull day", {
    reason_provenance: {
      reason_code: "training_symptom_active",
      evidence_date: addDaysISO(today(), -30),
      as_of_date: today(),
      source_ref_type: "training_symptom",
      source_ref_key: "1",
    },
  });
  assert.deepEqual(remedyNames(), []);
  assert.equal(closePlanCoverageGap({ act: true }).status, "none");
});

test("a lift removed for a non-pain reason is still eligible", () => {
  setup();
  seedKnown("Cable Crunch", [10, 17, 24]);
  seedKnown("Ab Wheel Rollout", [10, 17]);
  dropCableCrunch("Rotating the trunk work to keep the week fresh");
  assert.deepEqual(remedyNames(), ["Cable Crunch"], "the most-trained known lift is offered again");
});

test("an unreadable applied row that names the lift keeps it off the plan (fail closed)", () => {
  setup();
  seedKnown("Cable Crunch", [10, 17, 24]);
  seedKnown("Ab Wheel Rollout", [10, 17]);
  dropCableCrunch("Rotating the trunk work to keep the week fresh");
  db.prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status) VALUES ('claude', 'x', '', ?, 'applied')`).run(
    '{"changes":[{"day_number":3,"exercise":"Cable Crunch","remove":true,"reason":"low back pa'
  );
  assert.deepEqual(remedyNames(), ["Ab Wheel Rollout"]);
});

test("a set bump on a lift still in the plan is unaffected by a lift dropped for pain", () => {
  setup();
  // Chest is short, and both chest lifts carry a four-set habit: a bump, no add.
  for (const exercise of ["Barbell Bench Press", "Incline Dumbbell Press"]) {
    for (const daysAgo of [10, 17]) {
      for (let i = 0; i < 4; i++) repo.logSetByName({ exercise, weight: 100, reps: 8, date: addDaysISO(today(), -daysAgo) });
    }
  }
  const shortChest = noTrunkWeek({ withCrunch: true }).map((d) =>
    d.day_number === 1
      ? {
          ...d,
          items: d.items.map((i) => (i.muscle_group === "chest" ? { ...i, sets: 3 } : i)),
        }
      : d
  );
  // A chest lift was dropped for pain earlier, and the athlete has history with it.
  repo.replacePlan(shortChest.map((d) => (d.day_number === 1 ? { ...d, items: [...d.items, { exercise: "Dip", muscle_group: "chest", sets: 3, rep_low: 8, rep_high: 12 }] } : d)));
  const proposal = repo.createProposal("claude", "auto: weekly review", "", {
    summary: "Take dips out.",
    changes: [{ day_number: 1, exercise: "Dip", remove: true, reason: "Shoulder pain on dips" }],
  });
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  for (const daysAgo of [10, 17]) {
    for (let i = 0; i < 3; i++) repo.logSetByName({ exercise: "Dip", weight: 0, reps: 10, date: addDaysISO(today(), -daysAgo) });
  }
  const out = closePlanCoverageGap({ act: true });
  assert.equal(out.status, "changed");
  assert.deepEqual(out.gaps, ["group:chest"]);
  assert.match(out.summary, /more sets? of/, "a set bump on lifts already in the plan");
  assert.doesNotMatch(out.summary, /Dip/);
});
