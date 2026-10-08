// The week read (src/domain/training/week-read.ts, contract src/contracts/week-read.ts):
// Horizon's Week page as ONE server read over the plan strip's own week — the frame from
// the one stage vocabulary, the week's summary sentence, totals in the athlete's units,
// a chip per day with its planned dose as a word and a relative height, what is still
// open, the next milestones and the goals. GET /api/week and get_week answer the same
// body; GET /api/plan/week keeps answering the strip's cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import { weekRead, weekReadStart } from "../dist/domain/training/week-read.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { weekStage } from "../dist/repo/week-stage.js";
import { addDaysISO, mondayOf } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { planExercisesRouter } from "../dist/routes/plan-exercises.js";
import { registerPlanExerciseTools } from "../dist/surfaces/mcp/plan-exercises.js";

// Tuesday 2026-09-22.
const NOW = new Date("2026-09-22T12:00:00");
const DOSES = new Set(["rest", "easy", "moderate", "hard", "big"]);
const ISO = /\b\d{4}-\d{2}-\d{2}\b/;

function seedRace() {
  seedDemo();
  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Riverside Half",
      date: "2026-10-18",
      distance_km: 21.1,
      target: "sub-1:45",
    },
  });
}

test("this week: frame, summary, totals, seven chips with a dose word and a height", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedRace();
  const today = localDateISO();
  const read = weekRead();
  assert.equal(read.today, today);
  assert.equal(read.this_week, true);
  assert.equal(read.week_start, mondayOf(today));
  assert.equal(read.week_end, addDaysISO(mondayOf(today), 6));
  assert.doesNotMatch(read.range_words, ISO);
  assert.deepEqual(read.units, { distance: "km", weight: "lb" });

  // The frame: the one stage word, the countdown with words.
  const stage = weekStage(today);
  assert.ok(read.frame.stage, "a dated race names the week");
  assert.equal(read.frame.stage.word, stage.word);
  assert.ok(read.frame.countdown);
  assert.equal(read.frame.countdown.words, `${read.frame.countdown.days} days to Riverside Half`);
  assert.equal(read.frame.headline, read.frame.countdown.words);
  assert.ok(read.frame.line.startsWith(stage.word), read.frame.line);
  assert.match(read.frame.glance, /^\d+ days to Riverside · /);

  // The chips: the strip's own cells, a dose word and a height for drawing.
  const strip = planWeek(today);
  assert.equal(read.days.length, 7);
  assert.deepEqual(
    read.days.map((d) => [d.date, d.status]),
    strip.days.map((d) => [d.date, d.status])
  );
  for (const chip of read.days) {
    assert.ok(DOSES.has(chip.load.dose), chip.load.dose);
    assert.ok(chip.load.height > 0 && chip.load.height <= 1, `${chip.date} height ${chip.load.height}`);
    assert.ok(chip.load.word && !/\d/.test(chip.load.word), "the dose is a word, never a number");
    assert.ok(chip.words, `${chip.date} names itself`);
    assert.doesNotMatch(chip.words, ISO);
    assert.doesNotMatch(chip.date_words, ISO);
    assert.equal(chip.href, `/app/day/${chip.date}`);
    assert.equal(chip.today, chip.date === today);
    if (chip.rest) assert.equal(chip.load.dose, "rest");
  }
  assert.equal(read.days.filter((d) => d.today).length, 1);
  const heights = read.days.map((d) => d.load.height);
  assert.ok(Math.max(...heights) > Math.min(...heights), "the week has a shape");

  // Totals in the athlete's units, and one summary sentence.
  assert.equal(read.totals.units, "km");
  if (read.totals.run_words) assert.match(read.totals.run_words, /\bkm\b/);
  assert.equal(typeof read.summary, "string");
  assert.match(read.summary, new RegExp(`^${read.frame.stage.week_word}: `));
  assert.ok(read.summary.endsWith("."));
  assert.doesNotMatch(read.summary, ISO);

  // Still open: two at most, dated today onward, said in words.
  assert.ok(read.still_open.length <= 2);
  for (const open of read.still_open) {
    assert.ok(open.date >= today);
    assert.doesNotMatch(open.words, ISO);
  }
  // The next milestones lie beyond the week; three at most, dates in words.
  assert.ok(read.next_milestones.length <= 3);
  for (const m of read.next_milestones) {
    assert.ok(m.date > read.week_end, `${m.label} beyond the week`);
    assert.doesNotMatch(m.date_words, ISO);
  }
  // The race goal carries its estimate WITH its time.
  const race = read.goals.find((g) => g.key === "race");
  if (race) {
    assert.match(race.now_text, /^\d+:\d{2}(:\d{2})?$/);
    assert.ok(race.line.includes(race.now_text), "the fit is said with the time");
  }
  assert.doesNotMatch(JSON.stringify(read), /"(?:score|grade|percent|percentile|impact_score)"/i);
});

test("next week reads as of its Monday, ahead, with nothing still open", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedRace();
  const today = localDateISO();
  const next = weekRead(addDaysISO(mondayOf(today), 9));
  assert.equal(next.this_week, false);
  assert.equal(next.week_start, addDaysISO(mondayOf(today), 7));
  assert.equal(next.as_of, next.week_start);
  assert.equal(next.days.filter((d) => d.today).length, 0);
  assert.ok(next.still_open.length <= 2);
  if (next.summary) assert.match(next.summary, / ahead: /);
});

test("a miles athlete's week speaks miles", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedRace();
  repo.setSettings({ run_units: "mi" });
  const read = weekRead();
  assert.equal(read.units.distance, "mi");
  for (const chip of read.days) if (chip.run?.distance_words) assert.match(chip.run.distance_words, / mi$/);
  if (read.totals.run_words) assert.match(read.totals.run_words, /\bmi\b/);
  assert.doesNotMatch(JSON.stringify(read.days.map((d) => d.words)), /\d km\b/);
});

test("GET /api/week and get_week answer one body; /plan/week stays the strip's cells", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedRace();
  const paths = planExercisesRouter.stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.ok(paths.includes("/week"), "routed");
  assert.ok(paths.includes("/plan/week"), "the strip's alias stays");
  const layer = planExercisesRouter.stack.find((l) => l.route?.path === "/week" && l.route.methods.get);
  const rest = await new Promise((resolve) => layer.route.stack.at(-1).handle({ query: {} }, { json: resolve }));
  const tools = new Map();
  registerPlanExerciseTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const mcp = JSON.parse((await tools.get("get_week")({})).content[0].text);
  assert.deepEqual(mcp, JSON.parse(JSON.stringify(rest)));
  // A malformed start is a 400, never a guess.
  let status = 200;
  let body = null;
  layer.route.stack.at(-1).handle(
    { query: { start: "next tuesday" } },
    {
      status(code) {
        status = code;
        return this;
      },
      json(value) {
        body = value;
      },
    }
  );
  assert.equal(status, 400);
  assert.match(body.error, /YYYY-MM-DD/);
  assert.equal(weekReadStart(undefined), localDateISO());
  assert.equal(weekReadStart("2026-09-24"), "2026-09-24");
  assert.equal(weekReadStart("Sept"), null);
});

test("the journey: every dated mark ahead to the summit, behind-you movement, one line; this week only", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedRace();
  const today = localDateISO();
  const read = weekRead();
  const j = read.journey;
  assert.ok(j, "a race ahead draws a road");
  assert.equal(j.today, today);
  assert.ok(j.start_date <= today);
  assert.ok(j.marks.length >= 1);
  assert.deepEqual(
    j.marks.map((m) => m.date),
    [...j.marks.map((m) => m.date)].sort(),
    "marks run in date order"
  );
  assert.ok(j.marks.every((m) => m.date >= today && m.short && m.days_words && !ISO.test(m.date_words)));
  assert.equal(j.marks.filter((m) => m.summit).length, 1, "one summit");
  const race = j.marks.find((m) => m.kind === "race");
  assert.ok(race, "the race is on the road");
  assert.equal(race.short, "Half");
  assert.ok(j.line && !ISO.test(j.line));
  assert.ok(Array.isArray(j.behind) && j.behind.length <= 3);
  assert.equal(weekRead(addDaysISO(today, 7)).journey, null, "another week draws no road");
});

test("the journey is null with nothing dated ahead", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  // A fresh install: no goal, no race, no plan — the client draws the starter instead.
  assert.equal(weekRead().journey, null);
});
