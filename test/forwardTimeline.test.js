import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, marker, repo, resetTables, seedHealthDoc } from "./_seed.js";
import { localDateISO, addDaysISO } from "../dist/repo/shared.js";

const today = localDateISO();
const back = (n) => localDaysAgo(n);
const ahead = (n) => addDaysISO(today, n);

// A logged set on an exact date, feeding both program-state and exact-lift reads.
function logLift(exercise, weight, reps, daysAgo, muscle = "chest") {
  const ex = repo.upsertExercise({ name: exercise, muscle_group: muscle });
  const sess = repo.getOrCreateSession(back(daysAgo), null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir)
     VALUES (?, ?, 1, ?, ?, 2)`
  ).run(sess.id, ex.id, weight, reps);
}

function seedFullPicture() {
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 196,
    start_weight_lb: 210,
    start_date: back(60),
    goal_mode: "lose",
    goal_weight_lb: 180,
    goal_date: ahead(60),
  });
  // An active cut phase so recomposition reads a real cut projection.
  repo.createJourneyPhase({
    kind: "cut",
    start_date: back(60),
    start_weight_lb: 210,
    target_weight_lb: 180,
    status: "active",
  });
  // A DEXA baseline ~10 days ago → a re-scan window ~12-16 weeks out.
  seedHealthDoc(back(10), [marker("Body Fat %", 33, { unit: "%" })], "dexa");
  // A flagged lipid marker → a scheduled lab re-check via the doctor loop.
  seedHealthDoc(back(10), [marker("ApoB", 110, { unit: "mg/dL", flag: "high" })], "bloodwork");
  repo.refreshDoctorLoopAttention();
  // A plateaued main lift → an active strength re-test; a separately progressing
  // lift → a nearest-standard milestone (undated horizon).
  for (const d of [40, 33, 26, 19, 12, 5]) logLift("Barbell Bench Press", 185, 5, d);
  for (let i = 0; i < 6; i++) logLift("Back Squat", 205 + i * 10, 5, 40 - i * 7, "legs");
  repo.refreshTrainingBenchmarkAttention();
  // An active program block boundary.
  repo.createBlock({ goal: "get stronger", focus: "hypertrophy", total_weeks: 6, week_index: 1, started_at: back(7) });
}

beforeEach(seedFullPicture);

test("composes an ordered forward timeline of dated, window and horizon entries", () => {
  const timeline = repo.forwardTimeline();
  assert.ok(Array.isArray(timeline) && timeline.length > 0, "a seeded athlete has a road ahead");

  const kinds = new Set(timeline.map((e) => e.kind));
  assert.ok(kinds.has("goal"), "the declared goal date is on the timeline");
  assert.ok(kinds.has("phase"), "the phase projection window is on the timeline");
  assert.ok(kinds.has("rescan"), "a DEXA re-scan window is on the timeline");
  assert.ok(kinds.has("recheck"), "a scheduled lab re-check is on the timeline");
  assert.ok(kinds.has("retest"), "a scheduled strength re-test is on the timeline");
  assert.ok(kinds.has("block"), "the program block boundary is on the timeline");
  assert.ok(kinds.has("milestone"), "a nearest-standard milestone rides in the horizon tail");

  // No entry ever carries both an exact date and a soft window, and every entry
  // states its confidence in words.
  for (const e of timeline) {
    const hasDate = e.when.date != null;
    const hasWindow = e.when.window != null;
    assert.ok(!(hasDate && hasWindow), `${e.id} must not claim both a date and a window`);
    assert.ok(typeof e.basis === "string" && e.basis.length > 0, `${e.id} carries a plain-language basis`);
  }

  // Horizon (undated) entries are all at the tail; nothing dated follows them.
  const firstHorizon = timeline.findIndex((e) => e.when.date == null && e.when.window == null);
  if (firstHorizon >= 0) {
    for (let i = firstHorizon; i < timeline.length; i++) {
      assert.equal(timeline[i].when.date ?? null, null, "horizon entries carry no fabricated date");
      assert.equal(timeline[i].when.window ?? null, null, "horizon entries carry no window");
    }
  }

  // Dated + window entries are in ascending chronological order.
  const dated = timeline.filter((e) => e.when.date != null || e.when.window != null);
  const keys = dated.map((e) => e.when.date ?? e.when.window.start);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted, "dated/window entries ascend by date/window-start");
});

test("dates are drawn from real data, never fabricated", () => {
  const timeline = repo.forwardTimeline();

  const goal = timeline.find((e) => e.kind === "goal");
  assert.equal(goal.when.date, ahead(60), "goal entry uses the declared goal date");

  const block = timeline.find((e) => e.kind === "block");
  assert.equal(block.when.date, addDaysISO(back(7), 42), "block boundary is started_at + total_weeks");

  const rescan = timeline.find((e) => e.kind === "rescan");
  assert.equal(rescan.when.window.start, addDaysISO(back(10), 84), "re-scan window opens ~12 weeks after the scan");
  assert.equal(rescan.when.window.end, addDaysISO(back(10), 112), "re-scan window closes ~16 weeks after the scan");

  const recheck = timeline.find((e) => e.kind === "recheck");
  assert.match(recheck.label, /ApoB/, "a lab re-check names the real marker");
  assert.match(String(recheck.when.date), /^\d{4}-\d{2}-\d{2}$/, "a re-check carries a real due date");

  const milestone = timeline.find((e) => e.kind === "milestone");
  assert.equal(milestone.when.date ?? null, null, "a standards milestone is undated");
  assert.ok(milestone.label.length > 0, "a standards milestone reads as a direction of travel");
});

test("an empty database yields an empty timeline", () => {
  resetTables(
    "profile",
    "journey_phases",
    "health_documents",
    "attention_schedule",
    "sessions",
    "logged_sets",
    "exercises",
    "program_blocks",
    "bodyweight_log"
  );
  assert.deepEqual(repo.forwardTimeline(), []);
});
