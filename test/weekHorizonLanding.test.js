// The redesigned Horizon Week landing, server half (src/domain/training/week-read.ts,
// src/repo/week-stage.ts, contract src/contracts/week-read.ts):
//   - the frame: the week's PURPOSE leads when the race is far (> FRAME_COUNTDOWN_LEAD_DAYS),
//     the countdown leads inside it exactly as before, and the other is said once in `sub`;
//   - ONE weeks count to a race on every surface (display-words.ts weeksAway): the race
//     build's "25 wks out" and the trail's "in 25 weeks" for the same 181 days;
//   - a goal's track on one axis, a thread behind its start drawing left of it;
//   - proof: a race just run leads while RACE_PROOF_DAYS last, found by its logged effort
//     even after a new goal replaced it; the weight journey only when no weight goal row
//     draws it; up to two lifts that rose, the anchor first;
//   - two or more lift goals are ONE strength row listing every lift;
//   - every milestone has its page and a detail never cut mid-word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo, seedWeight } from "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import {
  goalTrack,
  liftCountWords,
  milestoneHref,
  proofOf,
  proofSeries,
  RACE_PROOF_DAYS,
  weekCountSentence,
  weekRead,
  WEEK_HREFS,
} from "../dist/domain/training/week-read.js";
import { FRAME_COUNTDOWN_LEAD_DAYS, weekFrameLine, weekPurpose } from "../dist/repo/week-stage.js";
import { raceCountdown } from "../dist/repo/race-build.js";
import { awayWords, weeksAway } from "../dist/repo/display-words.js";
import { clipDetail, liveStrengthJourneys, todayPath } from "../dist/repo/today-path.js";
import { athleteUnits } from "../dist/repo/settings.js";
import { createBlock } from "../dist/repo/program-blocks.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { addDaysISO, daysBetweenISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";

const NOW = new Date("2026-09-22T12:00:00");
const ISO = /\b\d{4}-\d{2}-\d{2}\b/;
const NO_SCORE = /"(?:score|grade|percent|percentile|impact_score)"/i;

function seedRace(date, extra = {}) {
  seedDemo();
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date, distance_km: 21.1, target: "sub-1:45", ...extra },
  });
}

test("a far race: the week's purpose leads; the countdown is said once, quietly, in sub", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const today = localDateISO();
  const raceDate = addDaysISO(today, 181);
  seedRace(raceDate, { event: "5K time trial", distance_km: 5, target: "sub-20:00" });
  const read = weekRead();
  const f = read.frame;
  assert.ok(f.countdown, "the race is dated");
  assert.ok(f.countdown.days > FRAME_COUNTDOWN_LEAD_DAYS);
  assert.ok(f.stage, "the build names the week");
  assert.equal(typeof f.purpose, "string");
  assert.equal(f.lead, "purpose");
  assert.equal(f.headline, f.purpose, "the purpose IS the hero");
  assert.equal(violatesReadingGrammar(f.purpose), null, f.purpose);
  assert.doesNotMatch(f.purpose, /\bmust\b|\d/, "no gate words, no numbers in the purpose");
  // The far countdown: the ONE weeks count, said once in the quiet line.
  assert.equal(f.countdown.far_words, `5K time trial in ${weeksAway(f.countdown.days)} weeks`);
  assert.ok(f.sub?.endsWith(`${f.countdown.far_words}.`), f.sub);
  assert.doesNotMatch(f.sub, ISO);
  // Today's glance keeps its countdown form.
  assert.match(f.glance, /^\d+ days to 5K time trial/);
  assert.doesNotMatch(JSON.stringify(read), NO_SCORE);
});

test("a race inside eight weeks: the countdown leads exactly as before, the purpose is the sub", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedRace("2026-10-18");
  const f = weekRead().frame;
  assert.ok(f.countdown.days <= FRAME_COUNTDOWN_LEAD_DAYS);
  assert.equal(f.lead, "countdown");
  assert.equal(f.headline, f.countdown.words);
  assert.equal(f.headline, `${f.countdown.days} days to Riverside Half`);
  assert.equal(f.sub, f.purpose);
  assert.match(f.glance, /^\d+ days to Riverside · /);
});

test("ONE weeks count to a race: the race build, the far countdown and the trail agree", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const today = localDateISO();
  const raceDate = addDaysISO(today, 181);
  // The live disagreement: 181 days read "in 26 weeks" on the trail and "25 wks out" on the race page.
  assert.equal(raceCountdown(today, raceDate).words, "25 wks out");
  assert.equal(awayWords(181), "in 25 weeks");
  assert.equal(weeksAway(181), 25);
  assert.equal(awayWords(13), "in 13 days");
  assert.equal(awayWords(14), "in 2 weeks");
  assert.equal(raceCountdown(today, addDaysISO(today, 14)).words, "2 wks out");
  seedRace(raceDate, { event: "5K time trial", distance_km: 5, target: "sub-20:00" });
  const read = weekRead();
  const mark = read.journey?.marks.find((m) => m.kind === "race");
  assert.ok(mark, "the race is on the trail");
  assert.equal(mark.days_words, "in 25 weeks");
  assert.equal(read.frame.countdown.far_words, "5K time trial in 25 weeks");
  assert.doesNotMatch(read.journey.line, /26 weeks/);
});

test("the block ribbon may end at the race only when race day is in the block's last week", () => {
  const purpose = weekPurpose(
    { key: "base", word: "Base", week_word: "Base week", phrase: "a base week", source: "race" },
    {
      date: "2026-11-16",
      lift: "the bench",
    }
  );
  assert.match(purpose, /the bench/);
  assert.equal(violatesReadingGrammar(purpose), null);
  // A lighter week never carries the lift push.
  const down = weekPurpose(
    { key: "down", word: "Lighter week", week_word: "Lighter week", phrase: "a lighter week", source: "block" },
    {
      date: "2026-11-16",
      lift: "the bench",
    }
  );
  assert.doesNotMatch(down, /bench/);
  assert.equal(weekPurpose(null, { date: "2026-11-16" }), null, "no stage, no purpose");
  // A block that ends long before a far race does not end at it; one whose last week
  // holds race day does.
  repo.setProfile({ age: 40 });
  createBlock({ goal: "Build", focus: "strength", total_weeks: 6, week_index: 5, started_at: "2026-10-12" });
  const build = (date) => ({
    available: true,
    race: { event: "5K time trial", date, distance_km: 5, phase: "base", days_to_race: 0 },
    weeks: [],
  });
  const far = weekFrameLine("2026-11-16", { build: build("2027-05-16") });
  assert.ok(far.block, "the fixture's block is active");
  assert.equal(far.block.ends_at_race, false);
  const near = weekFrameLine("2026-11-16", { build: build("2026-11-28") });
  assert.equal(near.block.ends_at_race, true, "block week 6 is Nov 23 – 29");
});

test("every variant of every purpose passes the reading grammar", () => {
  const keys = ["base", "build", "sharpen", "down", "peak", "taper", "race"];
  for (const key of keys) {
    for (const source of ["race", "block"]) {
      for (let d = 0; d < 6; d++) {
        const date = addDaysISO("2026-11-16", d);
        for (const lift of [null, "the press"]) {
          const p = weekPurpose({ key, word: key, week_word: key, phrase: key, source }, { date, lift });
          assert.ok(p, `${key}:${source}`);
          assert.equal(violatesReadingGrammar(p), null, p);
          assert.doesNotMatch(p, /\bmust\b|\d|%/, p);
        }
        const rec = weekPurpose({ key, word: key, week_word: key, phrase: key, source }, { date, recovering: true });
        assert.match(rec, /settle|Recover/);
      }
    }
  }
});

test("a goal track is one axis: a thread behind its start draws LEFT of the start mark", () => {
  // The live overhead press: started at 100, now 88.7, four weeks ago 91.5, goal 105.
  const tr = goalTrack(100, 88.7, 105, 91.5, "Oct 19");
  assert.ok(tr.start > 0 && tr.start < tr.goal, `start ${tr.start}`);
  assert.ok(tr.now < tr.start, "now behind the start");
  assert.ok(tr.now > 0, "with a margin, now is inside the track");
  assert.ok(tr.ago > tr.now && tr.ago < tr.start);
  assert.equal(tr.goal, 1);
  assert.equal(tr.ago_words, "Oct 19");
  // The usual case: start at 0, goal at 1, now between.
  const usual = goalTrack(183, 153.9, 148, 156.8, "Oct 19");
  assert.equal(usual.start, 0);
  assert.equal(usual.goal, 1);
  assert.ok(usual.now > usual.ago && usual.now < 1);
  // A race time (lower is better) reads the same way.
  const race = goalTrack(1413, 1370, 1200, 1413, "Oct 19");
  assert.equal(race.start, 0);
  assert.ok(race.now > 0 && race.now < 1);
  assert.equal(goalTrack(null, 1, 2), null);
  assert.equal(goalTrack(5, 5, 5), null);
});

test("a strength goal behind its start: the week row draws it, says the journey's own call, opens Program", () => {
  const today = localDateISO();
  const day = (n) => addDaysISO(today, n);
  repo.upsertExercise({ name: "Barbell Overhead Press", muscle_group: "shoulders", mode: "reps" });
  repo.logSetByName({ exercise: "Barbell Overhead Press", weight: 75, reps: 10, date: day(-70) });
  repo.setStrengthObjective({
    exercise: "Barbell Overhead Press",
    target_kind: "explicit_est_1rm",
    target_est_1rm: 105,
  });
  for (const n of [-40, -33, -26, -19, -12, -5]) {
    repo.logSetByName({ exercise: "Barbell Overhead Press", weight: 70, reps: 8, date: day(n) });
  }
  const read = weekRead();
  const goal = read.goals.find((g) => g.key === "strength");
  assert.ok(goal, "the lift is a goal row");
  assert.equal(goal.id, "strength:barbell overhead press");
  assert.equal(goal.now_text, "89 lb", "the journey's own now");
  assert.ok(goal.track, "a track to draw");
  assert.ok(goal.track.now < goal.track.start, "now draws left of the start");
  assert.equal(goal.track.goal, 1);
  assert.equal(goal.href, WEEK_HREFS.program);
  assert.ok(["holding", "back", "toward"].includes(goal.direction), goal.direction);
  assert.ok(goal.direction_words);
  assert.match(goal.start_text, /^100 lb · /);
  assert.equal(goal.goal_words, "105 lb");
  assert.doesNotMatch(JSON.stringify(goal), ISO);
  // One lift goal: that lift's own row, exactly as before; no list.
  assert.equal(goal.label, "Barbell Overhead Press");
  assert.equal(goal.lifts, undefined);
  assert.equal(read.goals.filter((g) => g.key === "strength").length, 1);
});

/** A lift with a start set ten weeks back, its objective, then one set a week (the last a week ago). */
function seedLift(name, group, loads, target = 400) {
  const today = localDateISO();
  repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  repo.logSetByName({ exercise: name, weight: loads[0], reps: 5, date: addDaysISO(today, -63) });
  repo.setStrengthObjective({ exercise: name, target_kind: "explicit_est_1rm", target_est_1rm: target });
  loads.slice(1).forEach((weight, i) => {
    repo.logSetByName({ exercise: name, weight, reps: 5, date: addDaysISO(today, -56 + 7 * i) });
  });
}
const RISING = [100, 105, 110, 115, 120, 125, 130, 135, 140];
const FLAT = [100, 100, 100, 100, 100, 100, 100, 100, 100];
const FALLING = [...RISING].reverse();

test("the lift goals counted in words, in a fixed order, a group of none left out", () => {
  assert.equal(liftCountWords(["toward", "back", "toward", "holding", "back"]), "Two rising, one holding, two drifting back");
  assert.equal(liftCountWords(["toward", "toward", "toward", "toward", "toward"]), "All five rising");
  assert.equal(liftCountWords(["holding", "holding"]), "Both holding");
  assert.equal(liftCountWords(["reached", "toward", "toward"]), "Two rising, one reached");
  assert.equal(liftCountWords(["toward", null, "toward"]), "Two rising", "a lift with no call yet is in no group");
  assert.equal(liftCountWords([null, null]), null);
});

test("three lift goals: ONE strength row lists every lift, in the board's order, each its own thread", () => {
  seedLift("Barbell Back Squat", "quads", RISING);
  seedLift("Barbell Bench Press", "chest", FLAT);
  seedLift("Barbell Overhead Press", "shoulders", FALLING);
  const today = localDateISO();
  const read = weekRead();
  const rows = read.goals.filter((g) => g.key === "strength");
  assert.equal(rows.length, 1, "one strength row, never an arbitrary pick");
  const goal = rows[0];
  assert.equal(goal.label, "Strength");
  assert.equal(goal.id, "strength");
  assert.equal(goal.now_text, "3 lifts");
  assert.equal(goal.goal_text, null);
  assert.equal(goal.progress, null);
  assert.equal(goal.track, null);
  assert.equal(goal.direction, null);
  assert.equal(goal.direction_words, null);
  assert.equal(goal.href, WEEK_HREFS.program);
  // Every lift, in the board's own order.
  const board = todayPath(today).board.filter((r) => r.key === "strength");
  assert.deepEqual(
    goal.lifts.map((l) => l.id),
    board.map((r) => r.id)
  );
  assert.deepEqual(
    goal.lifts.map((l) => l.now_text),
    board.map((r) => r.now_text)
  );
  const by = Object.fromEntries(goal.lifts.map((l) => [l.label, l]));
  assert.equal(by["Barbell Back Squat"].direction, "toward");
  assert.equal(by["Barbell Back Squat"].direction_words, "Moving toward");
  assert.equal(by["Barbell Bench Press"].direction, "holding");
  assert.equal(by["Barbell Bench Press"].move_words, "level");
  assert.equal(by["Barbell Overhead Press"].direction, "back");
  assert.equal(by["Barbell Overhead Press"].direction_words, "Drifting back");
  for (const lift of goal.lifts) {
    assert.ok(lift.track, `${lift.label} draws a track`);
    assert.equal(lift.goal_text, "400 lb");
  }
  assert.equal(goal.move_words, "One rising, one holding, one drifting back");
  assert.equal(goal.line, "Three lift goals: one rising, one holding, one drifting back.");
  assert.doesNotMatch(JSON.stringify(goal), ISO);
  assert.doesNotMatch(JSON.stringify(read), NO_SCORE);
  // Only the rising lift's working load rose: one strength proof row.
  assert.deepEqual(
    read.proof.filter((p) => p.key === "strength").map((p) => p.label),
    ["Barbell Back Squat"]
  );
});

test("proof: two lifts whose working load rose, the anchor lift first; never past three rows", () => {
  seedLift("Barbell Back Squat", "quads", RISING);
  seedLift("Barbell Bench Press", "chest", RISING.map((w) => w - 20));
  seedLift("Barbell Overhead Press", "shoulders", RISING.map((w) => w - 40));
  const today = localDateISO();
  const read = weekRead();
  const lifts = read.proof.filter((p) => p.key === "strength");
  assert.equal(lifts.length, 2, "two strength rows at most");
  const anchor = todayPath(today).anchor;
  assert.ok(anchor);
  assert.equal(lifts[0].label, anchor.exercise, "the anchor lift leads");
  assert.notEqual(lifts[1].label, lifts[0].label);
  for (const p of lifts) {
    assert.equal(p.stone, "strength");
    assert.equal(p.series_kind, "steps");
    assert.match(p.before_text, / × 5$/);
  }
  assert.ok(read.proof.length <= 3);
  const goal = read.goals.find((g) => g.key === "strength");
  assert.equal(goal.move_words, "All three rising");
  assert.equal(goal.line, "Three lift goals, all rising.");
});

test("the weight goal speaks its ONE verdict and the read's own rate", (t) => {
  const today = localDateISO();
  repo.setProfile({
    goal_mode: "lose",
    goal_weight_lb: 150,
    goal_date: addDaysISO(today, 90),
    start_weight_lb: 183,
    start_date: addDaysISO(today, -160),
  });
  for (let d = 42; d >= 0; d -= 2) seedWeight(addDaysISO(today, -d), Math.round((156 + d * 0.06) * 10) / 10);
  const read = weekRead();
  const goal = read.goals.find((g) => g.key === "weight");
  assert.ok(goal);
  const trend = read.weight_trend;
  if (trend.verdict_words)
    assert.equal(goal.direction_words, trend.verdict_words[0].toUpperCase() + trend.verdict_words.slice(1));
  if (trend.rate_words)
    assert.ok(goal.move_words.startsWith(trend.rate_words.replace(/^[−+-]/, "").replace("/wk", " a week")));
  assert.match(goal.start_text, /^183 lb · /);
  assert.equal(goal.href, WEEK_HREFS.goal);
  assert.equal(goal.track.start, 0);
  assert.ok(goal.track.ago != null, "four weeks back has a weigh-in");
  // Proof: the goal row above already draws start, now and goal, so the proof does not repeat it.
  assert.ok(goal.track);
  assert.equal(
    read.proof.find((p) => p.key === "weight"),
    undefined
  );
  // With no weight goal row to carry it, the journey from its start is proof: a line to draw.
  const proof = proofOf(todayPath(today), liveStrengthJourneys(), today, athleteUnits(), []).find(
    (p) => p.key === "weight"
  );
  assert.ok(proof);
  assert.equal(proof.before_text, "183 lb");
  assert.equal(proof.series_kind, "line");
  assert.ok(proof.series.every((v) => v >= 0 && v <= 1));
  assert.match(proof.since_words, /^since /);
  void t;
});

test("proof: a race run 15 days ago leads even after a new goal replaced it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T12:00:00") });
  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Riverside Half",
      date: "2026-11-01",
      distance_km: 21.1,
      target: "sub-2:00",
    },
  });
  for (let wk = 1; wk <= 4; wk++) {
    const mon = addDaysISO("2026-10-26", -7 * wk);
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7, date: addDaysISO(mon, 1) });
    repo.addActivity({ type: "run", duration_min: 95, distance_km: 15, date: addDaysISO(mon, 5) });
  }
  repo.addActivity({ type: "run", duration_min: 130.3, distance_km: 21.1, date: "2026-11-01" });
  // The morning after, the next race goes in.
  repo.setProfile({
    endurance_goal: { mode: "race", event: "5K time trial", date: "2027-05-16", distance_km: 5, target: "sub-20:00" },
  });
  t.mock.timers.setTime(Date.parse("2026-11-16T12:00:00"));
  const today = localDateISO();
  assert.equal(today, "2026-11-16");
  assert.ok((daysBetweenISO(today, "2026-11-01") ?? 0) <= RACE_PROOF_DAYS);
  const read = weekRead();
  const first = read.proof[0];
  assert.ok(first, "proof carries the race");
  assert.equal(first.key, "race_done");
  assert.equal(first.stone, "endurance");
  assert.equal(first.after_text, "Riverside Half · 2:10:18");
  assert.equal(first.before_text, null);
  assert.equal(first.series_kind, "columns");
  assert.ok(first.series.length === 0 || first.series.length >= 2);
  assert.ok(read.proof.length <= 3);
  // Past the window, the race no longer leads.
  t.mock.timers.setTime(Date.parse("2026-12-05T12:00:00"));
  assert.equal(
    weekRead().proof.find((p) => p.key === "race_done"),
    undefined
  );
});

test("milestones open their page; a long detail ends at a sentence, never mid-word", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  assert.equal(milestoneHref("race", "2027-05-16"), "/app/horizon/race");
  assert.equal(milestoneHref("checkup", "2026-12-22"), "/app/you/checkup");
  assert.equal(milestoneHref("goal", "2027-02-14"), "/app/horizon/goal");
  assert.equal(milestoneHref("checkpoint", "2026-11-30"), "/app/train/program");
  assert.equal(milestoneHref("long_run", "2026-11-22"), "/app/day/2026-11-22");
  assert.equal(milestoneHref("peak_week", "2026-12-07"), "/app/horizon/race");
  // The live checkup reason, which rendered "…The repeat DE…".
  const why =
    "One morning draw between Dec 22 and Dec 26 covers all five rechecks that are open or opening. The three already open fold into the same visit rather than each needing a trip of its own. The repeat DEXA rides along with the draw so the scan and the labs read the same week.";
  const cut = clipDetail(why);
  assert.ok(cut.length <= 200);
  assert.ok(cut.endsWith("own."), cut);
  assert.doesNotMatch(cut, /DE…|\w…$/);
  const clause = clipDetail(
    "A long clause without any full stop that keeps on going for quite a while, and then another clause that runs well past the budget of two hundred characters so the cut has to land somewhere sensible, never in the middle of a word like this"
  );
  const long =
    "A long clause without any full stop that keeps on going for quite a while, and then another clause that runs well past the budget of two hundred characters so the cut has to land somewhere sensible, never in the middle of a word like this";
  assert.match(clause, /…$/);
  const kept = clause.slice(0, -1);
  assert.ok(long.startsWith(kept), "a prefix of the sentence");
  assert.equal(long.slice(kept.length, kept.length + 2), ", ", "cut at a clause boundary");
  seedRace("2026-10-18");
  const read = weekRead();
  for (const m of [...read.next_milestones, ...(read.journey?.marks ?? [])]) {
    assert.ok("href" in m, `${m.kind} carries an href`);
    if (m.href) assert.match(m.href, /^\/app\//);
  }
});

test("proof pictures are drawing values, 0..1; counts said in words", () => {
  assert.deepEqual(proofSeries([115, 125, 145], "steps"), [0, 0.333, 1]);
  assert.deepEqual(proofSeries([10, 20], "columns"), [0.5, 1]);
  assert.deepEqual(proofSeries([5], "line"), []);
  assert.equal(
    weekCountSentence({ lift_days_done: 1, lift_days_planned: 5 }, 2, "this"),
    "One lift in of five, two key runs ahead."
  );
  assert.equal(
    weekCountSentence({ lift_days_done: 0, lift_days_planned: 4 }, 1, "this"),
    "Four lifting days and one key run ahead."
  );
  assert.equal(weekCountSentence({ lift_days_done: 5, lift_days_planned: 5 }, 0, "this"), "All five lifts in.");
  assert.equal(weekCountSentence({ lift_days_done: 0, lift_days_planned: null }, 0, "this"), null);
});
