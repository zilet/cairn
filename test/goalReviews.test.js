// "Behind you" — the finished-goal reviews (src/repo/goal-reviews.ts,
// src/coachOps/goal-review.ts, src/routes/goal-reviews.ts, src/surfaces/mcp/goal-reviews.ts).
//
//   - detection per kind: a race is snapshotted as soon as its effort is matched,
//     WAITING through its recovery days then PENDING with its facts rebuilt; a completed
//     strength objective is snapshotted and a reopened one drops its UNFROZEN row (a
//     frozen one stays); a reached goal weight is snapshotted once and a regain keeps it;
//   - the race facts: Monday weeks from the run-up's start, the race's own km separate,
//     the longest training run (race excluded), the taper, the lever facts;
//   - the op: the stub writes a frozen review; an injected agent is held to the reading
//     grammar and the no-grading rule (a violation is a failed attempt); a busy host
//     records nothing; levers are validated + adopted through injected deps, and a lever
//     failure never loses the review;
//   - the nightly pass reviews at most ONE row a night, gated on the rows;
//   - REST and MCP are mirrors.
// Synthetic fixtures only; deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import {
  detectGoalReviews,
  buildRaceFacts,
  finishedRaces,
  getGoalReview,
  goalReviewRecord,
  listGoalReviews,
  nextGoalReviewDue,
  raceBuildStart,
  WAITING_LINE,
} from "../dist/repo/goal-reviews.js";
import { gradesAgainstTarget, goalReviewTextViolation } from "../dist/repo/goal-review-grammar.js";
import { normalizeGoalReview, reviewGoal, runGoalReviewNightly } from "../dist/coachOps.js";
import { GOAL_REVIEW_SCHEMA, isGoalReviewResult } from "../dist/agent-contracts.js";
import { PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";
import { buildGoalReviewPrompt } from "../dist/prompt.js";
import { athleteUnits } from "../dist/repo/settings.js";
import { goalReviewsRouter } from "../dist/routes/goal-reviews.js";
import { registerGoalReviewTools } from "../dist/surfaces/mcp/goal-reviews.js";
import { goalReviewTickDue, resetGoalReviewTick, runGoalReviewTick } from "../dist/scheduler.js";
import { activeBuildLevers } from "../dist/repo/build-levers.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";

const RACE = "2026-11-01"; // a Sunday half: recovery Mon 11-02 .. Thu 11-05, full again Fri 11-06
const SCORE = /score|\/\s*100|\d\s*%|percent|grade|rating/i;

function seedRace() {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Cambridge Half Marathon", date: RACE, distance_km: 21.1, target: "sub-2:00" },
  });
  // An old run, then two empty weeks: the run-up starts on Mon Aug 24.
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-08-04" });
  const longs = [10, 11, 12, 10, 13, 14, 12, 15, 17];
  let monday = "2026-08-24";
  for (const long of longs) {
    const day = (n) => new Date(Date.parse(`${monday}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
    repo.addActivity({ type: "run", duration_min: 36, distance_km: 6, date: day(1) });
    repo.addActivity({ type: "run", duration_min: 48, distance_km: 8, date: day(3) });
    repo.addActivity({ type: "run", duration_min: long * 6.6, distance_km: long, date: day(5) });
    monday = day(7);
  }
  // Race week (Oct 26): two short runs, then the race on Sunday.
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: "2026-10-27" });
  repo.addActivity({ type: "run", duration_min: 24, distance_km: 4, date: "2026-10-29" });
  repo.addActivity({ type: "run", duration_min: 130.3, distance_km: 21.18, date: RACE });
}

function seedObjective(status = "completed") {
  const info = db
    .prepare(
      `INSERT INTO strength_objectives (exercise, exercise_key, target_kind, target_est_1rm, baseline_est_1rm, baseline_date,
         source, status, created_at, completed_at, achieved_est_1rm, achieved_date)
       VALUES ('Back Squat', 'back squat', 'explicit_est_1rm', 315, 285, '2026-08-01', 'user', ?, '2026-08-01 12:00:00',
         '2026-10-20T12:00:00Z', 318, '2026-10-20')`
    )
    .run(status);
  return Number(info.lastInsertRowid);
}

const GOOD = {
  headline: "Your first half, 21.2 km run steady from the start.",
  story: "You ran 21.2 km in 2:10:18. The build climbed for ten weeks to a 17 km long run. Race week stayed light.",
  lessons: "Your long runs grew a kilometre or two at a time and you absorbed each one. A light race week left your legs fresh.",
  carry_forward: "The next build can start from the weeks you ran well here.",
};

const night = (day, extra = {}) => ({ today: day, now: () => new Date(`${day}T12:00:00`), ...extra });
const canned = (parsed) => async () => ({ agent: "terra", result: { code: 0, raw: JSON.stringify(parsed), parsed }, tried: [] });

// ---------- detection ----------

test("a race is snapshotted as soon as its effort is matched: waiting, then pending with its facts rebuilt", () => {
  seedRace();
  assert.equal(detectGoalReviews("2026-10-31").created, 0, "no race before the race");
  const first = detectGoalReviews(RACE);
  assert.equal(first.created, 1);
  const [row] = listGoalReviews(RACE).reviews;
  assert.equal(row.kind, "race");
  assert.equal(row.title, "Cambridge Half Marathon");
  assert.equal(row.achieved_on, RACE);
  assert.equal(row.status, "waiting");
  assert.equal(row.line, WAITING_LINE);
  assert.match(row.result_line, /^21\.2 km in 2:10:18 · 6:09 \/km$/);
  assert.equal(detectGoalReviews("2026-11-03").created, 0, "idempotent");
  assert.equal(nextGoalReviewDue("2026-11-03"), null, "a waiting race is not due");

  assert.equal(detectGoalReviews("2026-11-05").settled, 0, "the window's last day still waits");
  const settle = detectGoalReviews("2026-11-06");
  assert.equal(settle.settled, 1);
  const rec = goalReviewRecord(row.id);
  assert.equal(rec.status, "pending");
  assert.equal(rec.facts.recovery.settled, true);
  assert.equal(rec.facts.recovery.ends_on, "2026-11-05");
  assert.equal(rec.facts.recovery.back_on, "2026-11-06");
  assert.equal(rec.facts.build_lever_facts.expected_recovery_days, 4);
  assert.equal(nextGoalReviewDue("2026-11-06")?.id, row.id);
});

test("the race survives the goal changing the morning after: one row, never two", () => {
  seedRace();
  detectGoalReviews(RACE);
  repo.setProfile({ endurance_goal: { mode: "race", event: "Spring 5K", date: "2027-05-16", distance_km: 5 } });
  detectGoalReviews("2026-11-02");
  const races = finishedRaces("2026-11-02");
  assert.equal(races.length, 1);
  assert.equal(listGoalReviews("2026-11-02").reviews.length, 1);
});

test("the race facts: the run-up's weeks, the race separate, the longest training run, the taper", () => {
  seedRace();
  const [race] = finishedRaces("2026-11-06");
  const facts = buildRaceFacts(race, "2026-11-06");
  assert.equal(facts.build.start, "2026-08-24", "the run-up starts after the two empty weeks");
  assert.equal(facts.build.weeks.length, 10);
  const raceWeek = facts.build.weeks.at(-1);
  assert.equal(raceWeek.week_start, "2026-10-26");
  assert.equal(raceWeek.km, 9, "race week's training km, the race excluded");
  assert.equal(raceWeek.race_km, 21.2);
  assert.ok(facts.build.weeks.slice(0, -1).every((w) => w.race_km === 0));
  assert.equal(facts.build.weeks[0].km, 24);
  assert.equal(facts.longest_run.km, 17);
  assert.equal(facts.longest_run.date, "2026-10-24");
  assert.equal(typeof facts.longest_run.clean, "boolean");
  assert.equal(facts.capacity.best_week_km, 31);
  assert.equal(facts.capacity.best_week_start, "2026-10-19");
  assert.deepEqual(facts.taper, { race_week_km_before_race: 9, week_before_km: 31 });
  assert.equal(facts.result.finish_sec, 7818);
  assert.equal(facts.result.pace_sec_per_km, 369);
  assert.equal(facts.target_text, "sub-2:00");
  assert.equal(facts.lifting.sessions, 0);
  const lever = facts.build_lever_facts;
  assert.equal(lever.race_date, RACE);
  assert.equal(lever.longest_run_km, 17);
  assert.equal(lever.best_week_km, 31);
  assert.equal(lever.expected_recovery_days, 4);
  // Capped at sixteen weeks for a year-round runner.
  const runs = Array.from({ length: 45 }, (_, i) => ({
    date: new Date(Date.parse("2026-01-05T00:00:00Z") + i * 7 * 864e5).toISOString().slice(0, 10),
    km: 20,
  }));
  assert.equal(raceBuildStart(RACE, runs), "2026-07-13");
});

test("a completed objective is snapshotted; a reopened one drops its unfrozen row, a frozen one stays", async () => {
  const id = seedObjective();
  db.prepare(
    `INSERT INTO strength_objectives (exercise, exercise_key, target_kind, target_est_1rm, source, status)
     VALUES ('Bench Press', 'bench press', 'explicit_est_1rm', 225, 'user', 'superseded')`
  ).run();
  assert.equal(detectGoalReviews("2026-10-21").created, 1, "superseded never reviewed");
  const [row] = listGoalReviews("2026-10-21").reviews;
  assert.equal(row.kind, "strength_objective");
  assert.equal(row.status, "pending");
  assert.equal(row.achieved_on, "2026-10-20");
  assert.match(row.result_line, /^Estimated max 318 lb · from 285 lb$/);

  db.prepare(`UPDATE strength_objectives SET status = 'active' WHERE id = ?`).run(id);
  assert.equal(detectGoalReviews("2026-10-22").dropped, 1);
  assert.equal(listGoalReviews().reviews.length, 0);

  db.prepare(`UPDATE strength_objectives SET status = 'completed' WHERE id = ?`).run(id);
  detectGoalReviews("2026-10-23");
  const again = listGoalReviews().reviews[0];
  const done = await reviewGoal(again.id, "stub", undefined, { today: "2026-10-23" });
  assert.equal(done.ok, true);
  db.prepare(`UPDATE strength_objectives SET status = 'active' WHERE id = ?`).run(id);
  assert.equal(detectGoalReviews("2026-10-24").dropped, 0, "a frozen review stays");
  assert.equal(listGoalReviews().reviews[0].status, "ready");
});

test("a reached goal weight is snapshotted once, and a regain never erases it", () => {
  repo.setProfile({ age: 40, sex: "male", start_weight_lb: 200, start_date: "2026-03-02", goal_weight_lb: 180 });
  repo.logWeight(200, "2026-03-02");
  repo.logWeight(190, "2026-05-04");
  repo.logWeight(179.6, "2026-07-06");
  assert.equal(detectGoalReviews("2026-07-07").created, 1);
  const [row] = listGoalReviews("2026-07-07").reviews;
  assert.equal(row.kind, "weight_goal");
  assert.equal(row.achieved_on, "2026-07-06");
  assert.equal(row.title, "Goal weight 180 lb");
  assert.match(row.result_line, /^179\.6 lb · from 200 lb$/);
  const facts = goalReviewRecord(row.id).facts;
  assert.equal(facts.weeks, 18);
  assert.equal(facts.rate_lb_per_week, 1.1);

  repo.logWeight(186, "2026-08-10"); // a regain: the milestone no longer reads reached
  assert.equal(detectGoalReviews("2026-08-11").created, 0);
  assert.equal(listGoalReviews("2026-08-11").reviews.length, 1, "the finished goal stays behind you");
});

// ---------- the op ----------

test("the stub writes a frozen review; a frozen review is never rewritten", async () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  const out = await reviewGoal(row.id, "stub", undefined, { today: "2026-11-06" });
  assert.equal(out.ok, true);
  assert.equal(out.agent, "stub");
  assert.equal(out.review.status, "ready");
  assert.ok(out.review.review.headline.startsWith("Cambridge Half Marathon"));
  for (const t of Object.values(out.review.review)) assert.equal(goalReviewTextViolation(t), null, t);
  const rec = goalReviewRecord(row.id);
  assert.ok(rec.frozen_at && rec.reviewed_at);
  assert.equal(rec.attempts, 1);
  const again = await reviewGoal(row.id, "stub", undefined, { today: "2026-11-06" });
  assert.equal(again.ok, false);
  assert.deepEqual(again.tried, []);
  assert.equal(goalReviewRecord(row.id).reviewed_at, rec.reviewed_at);
});

test("a waiting race is refused; an absent row is the designed failure", async () => {
  seedRace();
  detectGoalReviews(RACE);
  const [row] = listGoalReviews(RACE).reviews;
  const out = await reviewGoal(row.id, "stub", undefined, { today: RACE });
  assert.equal(out.ok, false);
  assert.equal(goalReviewRecord(row.id).attempts, 0);
  assert.equal((await reviewGoal(9999, "stub")).ok, false);
  assert.equal(getGoalReview(9999), null);
});

test("an injected agent's review: grading or a score is a failed attempt; a clean one freezes", async () => {
  seedObjective();
  detectGoalReviews("2026-10-21");
  const [row] = listGoalReviews().reviews;
  const graded = await reviewGoal(row.id, "auto", undefined, {
    today: "2026-10-21",
    run: canned({ ...GOOD, story: "You missed your target by ten minutes. Still, the build held." }),
  });
  assert.equal(graded.ok, false);
  let rec = goalReviewRecord(row.id);
  assert.equal(rec.status, "failed");
  assert.equal(rec.attempts, 1);
  assert.ok(rec.last_error);

  const scored = await reviewGoal(row.id, "auto", undefined, {
    today: "2026-10-22",
    run: canned({ ...GOOD, headline: "A 92/100 squat block." }),
  });
  assert.equal(scored.ok, false);
  assert.equal(goalReviewRecord(row.id).attempts, 2);

  const ok = await reviewGoal(row.id, "auto", undefined, { today: "2026-10-23", run: canned(GOOD) });
  assert.equal(ok.ok, true);
  assert.equal(ok.agent, "terra");
  rec = goalReviewRecord(row.id);
  assert.equal(rec.status, "ready");
  assert.equal(rec.attempts, 3);
  assert.equal(rec.review.levers.length, 0, "levers only ever ride a race");
  assert.equal(rec.review.levers_result, null);
  const detail = getGoalReview(row.id);
  assert.equal(detail.line, GOOD.headline);
  assert.equal(detail.carried.text, GOOD.carry_forward);
  assert.equal(detail.build, null);
  assert.doesNotMatch(JSON.stringify(detail.fact_lines), SCORE);
});

test("a busy host records nothing: the row stays pending", async () => {
  seedObjective();
  detectGoalReviews("2026-10-21");
  const [row] = listGoalReviews().reviews;
  const busy = Object.assign(new Error("busy"), { code: "agent_busy" });
  const out = await reviewGoal(row.id, "auto", undefined, {
    today: "2026-10-21",
    run: async () => {
      throw busy;
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.agent_busy, true);
  const rec = goalReviewRecord(row.id);
  assert.equal(rec.status, "pending");
  assert.equal(rec.attempts, 0);
});

test("a race review's levers are validated and adopted; a lever failure never loses the review", async () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  const proposals = [
    { key: "long_run_ceiling_km", value: 18, because: "Your 17 km long run went well, so the next build can reach a little further." },
    { key: "not_a_key", value: 3, because: "Unknown keys never reach the validator." },
    { key: "taper_weeks", value: 2, because: "You missed your target pace, so taper longer." }, // grades: dropped
  ];
  const seen = {};
  const out = await reviewGoal(row.id, "auto", undefined, {
    today: "2026-11-06",
    run: canned({ ...GOOD, levers: proposals }),
    validateLevers: (p, facts) => {
      seen.proposals = p;
      seen.facts = facts;
      return { accepted: [{ key: "long_run_ceiling_km", value: 18, because: p[0].because }], rejected: [] };
    },
    adoptLevers: (reviewId, accepted, date) => {
      seen.adopt = { reviewId, accepted, date };
      return { decision_id: 77, adopted: accepted.length };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(
    seen.proposals.map((p) => p.key),
    ["long_run_ceiling_km"],
    "only known keys with a clean reason reach the validator"
  );
  assert.equal(seen.facts.race_date, RACE);
  assert.deepEqual(seen.adopt, { reviewId: row.id, accepted: [{ key: "long_run_ceiling_km", value: 18, because: proposals[0].because }], date: "2026-11-06" });
  const rec = goalReviewRecord(row.id);
  assert.equal(rec.review.levers_result.decision_id, 77);
  assert.equal(rec.review.levers_result.accepted.length, 1);
  assert.equal(getGoalReview(row.id).carried.decision_id, 77);

});

test("end to end: a race review's lesson becomes a live lever on the next build, and Undo takes it back", async () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  assert.equal(activeBuildLevers("2026-11-09").taper_weeks, 1, "no lesson yet: the engine's own taper");
  const out = await reviewGoal(row.id, "auto", undefined, {
    today: "2026-11-06",
    run: canned({
      ...GOOD,
      levers: [{ key: "taper_weeks", value: 2, because: "Your legs came into race week still heavy, so the next build eases off a week sooner." }],
    }),
  });
  assert.equal(out.ok, true);
  const rec = goalReviewRecord(row.id);
  assert.equal(rec.review.levers_result.accepted.length, 1);
  const decisionId = rec.review.levers_result.decision_id;
  assert.ok(decisionId > 0, "one announced, undoable decision");
  const lever = db.prepare("SELECT * FROM build_levers WHERE source_review_id = ?").get(row.id);
  assert.equal(lever.key, "taper_weeks");
  assert.equal(lever.status, "active");
  assert.equal(activeBuildLevers("2026-11-09").taper_weeks, 2, "the next build reads the lesson");

  const detail = getGoalReview(row.id, "2026-11-09");
  assert.equal(detail.carried.decision_id, decisionId);
  assert.equal(detail.carried.undoable, true);
  assert.ok(detail.carried.levers.some((l) => /eases off a week sooner/.test(l.because)));

  assert.equal(revertDecision(decisionId, "user undo").ok, true);
  assert.equal(activeBuildLevers("2026-11-09").taper_weeks, 1, "Undo hands the engine its own taper back");
  assert.equal(getGoalReview(row.id, "2026-11-09").carried.undoable, false);
});

test("a lever step that throws is recorded beside the review, never instead of it", async () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  const out = await reviewGoal(row.id, "auto", undefined, {
    today: "2026-11-06",
    run: canned({ ...GOOD, levers: [{ key: "build_step", value: 1.1, because: "Your ramp held, so it can stay gentle." }] }),
    validateLevers: () => {
      throw new Error("build-levers: not implemented");
    },
  });
  assert.equal(out.ok, true);
  const rec = goalReviewRecord(row.id);
  assert.equal(rec.status, "ready");
  assert.match(rec.review.levers_result.error, /not implemented/);
  assert.equal(rec.review.levers_result.decision_id, null);
});

test("an old race backfilled long after proposes no levers", async () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  let called = false;
  const out = await reviewGoal(row.id, "auto", undefined, {
    today: "2027-06-01",
    run: canned({ ...GOOD, levers: [{ key: "build_step", value: 1.1, because: "Your ramp held, so it can stay gentle." }] }),
    validateLevers: () => {
      called = true;
      return { accepted: [], rejected: [] };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(called, false);
  assert.equal(goalReviewRecord(row.id).review.levers_result, null);
});

// ---------- the nightly pass ----------

test("the nightly pass reviews at most one row a night, oldest first, gated on the rows", async () => {
  seedObjective();
  repo.setProfile({ age: 40, sex: "male", start_weight_lb: 200, start_date: "2026-03-02", goal_weight_lb: 180 });
  repo.logWeight(200, "2026-03-02");
  repo.logWeight(179.6, "2026-07-06");
  const night1 = await runGoalReviewNightly("stub", night("2026-10-21"));
  assert.equal(night1.detection.created, 2);
  assert.ok(night1.reviewed?.ok);
  assert.equal(goalReviewRecord(night1.reviewed.id).kind, "weight_goal", "the oldest achieved goes first");
  const again = await runGoalReviewNightly("stub", night("2026-10-21"));
  assert.equal(again.reviewed, null, "one a night, even when asked twice");
  const night2 = await runGoalReviewNightly("stub", night("2026-10-22"));
  assert.equal(goalReviewRecord(night2.reviewed.id).kind, "strength_objective");
  const night3 = await runGoalReviewNightly("stub", night("2026-10-23"));
  assert.equal(night3.reviewed, null, "nothing left");
});

test("a failed row is retried on later nights, at most three times", async () => {
  seedObjective();
  const bad = canned({ ...GOOD, story: "" });
  for (const day of ["2026-10-21", "2026-10-22", "2026-10-23"]) {
    const n = await runGoalReviewNightly("auto", night(day, { run: bad }));
    assert.equal(n.reviewed?.ok, false, day);
  }
  const rec = listGoalReviews().reviews[0];
  assert.equal(goalReviewRecord(rec.id).attempts, 3);
  assert.equal((await runGoalReviewNightly("auto", night("2026-10-24", { run: canned(GOOD) }))).reviewed, null);
});

test("the scheduler's tick asks only inside the night's window, once a night in-process", async () => {
  resetGoalReviewTick();
  const at = (h) => new Date(2026, 10, 6, h, 15);
  assert.equal(goalReviewTickDue(at(1), 2), false);
  assert.equal(goalReviewTickDue(at(12), 2), false);
  assert.equal(goalReviewTickDue(at(2), 2), true);
  let calls = 0;
  const run = async () => {
    calls++;
    return { detection: { created: 0, dropped: 0, settled: 0 }, reviewed: { id: 1, ok: false, agent_busy: true }, result: null };
  };
  await runGoalReviewTick(at(2), { hour: 2, run });
  await runGoalReviewTick(at(3), { hour: 2, run });
  assert.equal(calls, 2, "a busy host leaves the night open");
  const done = async () => {
    calls++;
    return { detection: { created: 0, dropped: 0, settled: 0 }, reviewed: null, result: null };
  };
  await runGoalReviewTick(at(3), { hour: 2, run: done });
  await runGoalReviewTick(at(4), { hour: 2, run: done });
  assert.equal(calls, 3, "a finished pass closes the night");
  resetGoalReviewTick();
});

// ---------- contract, prompt, surfaces ----------

test("the schema names every field the op reads; the predicate holds grammar and no-grading", () => {
  const props = GOAL_REVIEW_SCHEMA.properties;
  for (const key of ["headline", "story", "lessons", "carry_forward", "levers"]) assert.ok(props[key], key);
  for (const key of ["key", "value", "because"]) assert.ok(props.levers.items.properties[key], key);
  assert.equal(isGoalReviewResult(GOOD), true);
  assert.equal(isGoalReviewResult({ ...GOOD, lessons: "You must rest more." }), false);
  assert.equal(isGoalReviewResult({ ...GOOD, story: "You fell short of the goal time." }), false);
  assert.equal(isGoalReviewResult({ ...GOOD, headline: "" }), false);
  assert.equal(gradesAgainstTarget("You passed 10 km at 1:01 and ran the target pace you trained at."), false);
  assert.equal(gradesAgainstTarget("You beat your goal by a minute."), true);
  assert.equal(normalizeGoalReview({ ...GOOD, story: "One. Two. Three. Four. Five." }, "race").story, "One. Two. Three. Four.");
  assert.ok(normalizeGoalReview({ ...GOOD, headline: "x".repeat(400) }, "race").headline.length <= 160);
});

test("the prompt carries the facts and its own small context site", () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  const rec = goalReviewRecord(row.id);
  const ctx = { profile: { age: 40 }, recovery: { big: true }, endurance_goal: { mode: "race" } };
  const prompt = buildGoalReviewPrompt(rec, { units: athleteUnits(), leverKeys: ["build_step"], ctx, today: "2026-11-06" });
  assert.match(prompt, /"race_date":"2026-11-01"/);
  assert.match(prompt, /never hold the result against it/);
  assert.match(prompt, /build_step/);
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n{") + 1));
  assert.ok(data.profile && data.endurance_goal);
  assert.equal(data.recovery, undefined, "the site drops today's state");
  assert.ok(PROMPT_CONTEXT_SITES.goal_review.keys.includes("strength_journey"));
  const noLevers = buildGoalReviewPrompt(rec, { units: athleteUnits(), leverKeys: null, ctx, today: "2026-11-06" });
  assert.doesNotMatch(noLevers, /LEVERS FOR THE NEXT BUILD/);
});

function route(method, path) {
  const layer = goalReviewsRouter.stack.find((e) => e.route?.path === path && e.route?.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} is registered`);
  return layer.route.stack[0].handle;
}

function call(method, path, { params = {}, body = {} } = {}) {
  let payload;
  let status = 200;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  route(method, path)({ params, body, query: {} }, res, (err) => {
    throw err;
  });
  return { status, payload };
}

async function tool(name, args) {
  const tools = new Map();
  registerGoalReviewTools({ tool: (n, _d, _s, handler) => tools.set(n, handler) });
  const handler = tools.get(name);
  assert.ok(handler, `${name} is registered`);
  return JSON.parse((await handler(args)).content[0].text);
}

async function settled(id) {
  for (let i = 0; i < 400; i++) {
    const job = repo.getAgentJob(id);
    if (["done", "error", "canceled"].includes(job.status)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return repo.getAgentJob(id);
}

test("REST and MCP are mirrors: list, one review, null on absence, queue and refuse", async () => {
  seedObjective();
  detectGoalReviews("2026-10-21");
  const list = call("get", "/goal-reviews");
  assert.deepEqual(await tool("list_goal_reviews", {}), list.payload);
  const id = list.payload.reviews[0].id;
  assert.deepEqual(await tool("get_goal_review", { id }), call("get", "/goal-reviews/:id", { params: { id: String(id) } }).payload);
  assert.equal(call("get", "/goal-reviews/:id", { params: { id: "424242" } }).payload, null);
  assert.equal(await tool("get_goal_review", { id: 424242 }), null);

  const queued = call("post", "/goal-reviews/:id/review", { params: { id: String(id) }, body: { agent: "stub" } });
  assert.equal(queued.status, 200);
  assert.equal(queued.payload.ok, true);
  assert.equal(queued.payload.job.kind, "goal_review");
  const joined = await tool("review_goal", { id, agent: "stub" });
  // Still live: joined, never doubled. Already done: the frozen row refuses.
  if (joined.ok) assert.equal(joined.job.id, queued.payload.job.id, "a live job is joined, not doubled");
  const job = await settled(queued.payload.job.id);
  assert.equal(job.status, "done");
  assert.equal(job.result.ok, true);
  assert.equal(goalReviewRecord(id).status, "ready");

  const refused = call("post", "/goal-reviews/:id/review", { params: { id: String(id) }, body: {} });
  assert.deepEqual(refused.payload, { ok: false, error: "this goal has already been looked back on", tried: [] });
  assert.deepEqual(await tool("review_goal", { id }), refused.payload);
  const missing = call("post", "/goal-reviews/:id/review", { params: { id: "424242" }, body: {} });
  assert.equal(missing.status, 200);
  assert.equal(missing.payload.ok, false);
});

test("the race detail: the bars to scale in the athlete's units, the race stacked on race week", async () => {
  seedRace();
  repo.setSettings({ run_units: "mi" });
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  await reviewGoal(row.id, "stub", undefined, { today: "2026-11-06" });
  const detail = getGoalReview(row.id, "2026-11-06");
  const units = athleteUnits().distance;
  assert.equal(detail.build.units, units);
  const last = detail.build.weeks.at(-1);
  assert.equal(last.race_week, true);
  assert.ok(last.race_value > 0);
  assert.ok(detail.build.weeks.slice(0, -1).every((w) => !w.race_week && w.race_value === 0));
  assert.equal(detail.build.max_value, Math.max(...detail.build.weeks.map((w) => Math.round((w.value + w.race_value) * 10) / 10)));
  assert.match(last.words, / · race /);
  assert.ok(detail.fact_lines.length >= 3);
  assert.doesNotMatch(JSON.stringify(detail), SCORE);
  assert.equal(detail.carried.undoable, false);
});

// ---------- review fixes (2026-11-02) ----------

test("a long-run ceiling raise stands on a next morning that vouched — silence never does", () => {
  seedRace();
  // The build's longest run lands on its first Monday, before enough runs exist for it to
  // read as a new longest (that alone is harm, whatever the morning says).
  repo.addActivity({ type: "run", duration_min: 120, distance_km: 18, date: "2026-08-24" });
  const [race] = finishedRaces("2026-11-06");
  const silent = buildRaceFacts(race, "2026-11-06");
  assert.equal(silent.longest_run.date, "2026-08-24");
  assert.equal(silent.longest_run.clean, true, "no harm on the day…");
  assert.equal(silent.build_lever_facts.longest_run_clean, false, "…but no morning after it spoke: no vouch");
  repo.upsertGarminDailyMetric({ date: "2026-08-25", hrv_ms: 58, resting_hr: 50 });
  const vouched = buildRaceFacts(race, "2026-11-06");
  assert.equal(vouched.build_lever_facts.longest_run_clean, true, "a clean night after it vouches");
});

test("a lever with no real number never reaches the validator as 0", () => {
  const because = "Your long runs went well, so the next build can reach a little further.";
  const stored = normalizeGoalReview(
    {
      ...GOOD,
      levers: [
        { key: "taper_weeks", value: null, because },
        { key: "build_step", value: "", because },
        { key: "long_step", value: false, because },
        { key: "down_week_every", value: [], because },
        { key: "peak_week_cap_km", value: 0, because },
        { key: "long_run_ceiling_km", value: "16", because },
      ],
    },
    "race"
  );
  assert.deepEqual(
    stored.levers.map((l) => [l.key, l.value]),
    [["long_run_ceiling_km", 16]]
  );
});

test("the lever prompt never shows a 0 example and says the km caps are kilometres", () => {
  seedRace();
  detectGoalReviews("2026-11-06");
  const [row] = listGoalReviews("2026-11-06").reviews;
  const prompt = buildGoalReviewPrompt(goalReviewRecord(row.id), {
    units: { ...athleteUnits(), distance: "mi" },
    leverKeys: ["long_run_ceiling_km", "peak_week_cap_km", "taper_weeks"],
    today: "2026-11-06",
  });
  assert.doesNotMatch(prompt, /"value": 0\b/);
  assert.match(prompt, /KILOMETRES/);
});

test("under review-everything, levers that held up are parked and never shown as carried forward", async () => {
  repo.setSettings({ lead_mode: "review_everything" });
  try {
    seedRace();
    detectGoalReviews("2026-11-06");
    const [row] = listGoalReviews("2026-11-06").reviews;
    const out = await reviewGoal(row.id, "auto", undefined, {
      today: "2026-11-06",
      run: canned({
        ...GOOD,
        levers: [{ key: "taper_weeks", value: 2, because: "Your legs came into race week still heavy, so the next build eases off a week sooner." }],
      }),
    });
    assert.equal(out.ok, true);
    const result = goalReviewRecord(row.id).review.levers_result;
    assert.deepEqual(result.accepted, [], "nothing is said to be kept");
    assert.equal(result.parked.length, 1);
    assert.equal(result.decision_id, null);
    const detail = getGoalReview(row.id, "2026-11-09");
    assert.deepEqual(detail.carried.levers, []);
    assert.equal(detail.carried.undoable, false);
    assert.equal(activeBuildLevers("2026-11-09").taper_weeks, 1);
  } finally {
    repo.setSettings({ lead_mode: "lead" });
  }
});
