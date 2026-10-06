// The Program look-ahead (src/domain/training/plan-look-ahead.ts): today through the end
// of next week, a row a day, composed from the reads that own each fact — the plan
// strip's own week for the calendar (plan days hold strength only; runs and rest are
// the calendar's), the one strength line for today, the plan day's own items for its
// key movements, and the race build / recovery / block reads for the week's context.
// GET /api/plan/look-ahead and get_plan_look_ahead answer the same body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { planLookAhead, lookAheadWeekAsOf, LOOK_AHEAD_KEY_LIFTS, runOf } from "../dist/domain/training/plan-look-ahead.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { dayRecord } from "../dist/domain/today/day-record.js";
import { raceBuild } from "../dist/repo/race-build.js";
import { rungStage } from "../dist/repo/week-stage.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { seedDemo } from "../dist/demoSeed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { planExercisesRouter } from "../dist/routes/plan-exercises.js";
import { registerPlanExerciseTools } from "../dist/surfaces/mcp/plan-exercises.js";

// Tuesday 2026-09-22: five days left this week, then all of next week.
const NOW = new Date("2026-09-22T12:00:00");

function assertNoScore(read) {
  assert.doesNotMatch(JSON.stringify(read), /"(?:score|grade|percent|percentile|impact_score)"/i);
}

function planNames() {
  const out = new Map();
  for (const day of repo.getPlan())
    out.set(
      day.name,
      day.items.map((i) => i.exercise)
    );
  return out;
}

test("the look-ahead runs from today through next Sunday, a row a day", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const today = localDateISO();
  const read = planLookAhead();
  assert.equal(read.mode, "calendar");
  assert.equal(read.as_of, today);
  assert.deepEqual(
    read.weeks.map((w) => w.label),
    ["This week", "Next week"]
  );
  const days = read.weeks.flatMap((w) => w.days);
  assert.equal(days[0].date, today, "today leads");
  assert.equal(days[0].today, true);
  assert.equal(days.filter((d) => d.today).length, 1, "one today");
  assert.equal(read.weeks[0].days.length, 6, "Tuesday through Sunday");
  assert.equal(read.weeks[1].days.length, 7, "all of next week");
  assert.equal(days.at(-1).weekday, "Sun");
  for (let i = 1; i < days.length; i++) assert.ok(days[i].date > days[i - 1].date, "in date order");
  assertNoScore(read);
});

test("a lift day names its plan day and its first movements; a rest day holds nothing", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const read = planLookAhead();
  const plan = planNames();
  const days = read.weeks.flatMap((w) => w.days);
  const lifts = days.filter((d) => d.lift);
  assert.ok(lifts.length >= 3, "the demo plan lifts several days ahead");
  for (const day of lifts) {
    const items = plan.get(day.lift.title);
    assert.ok(items, `${day.date}: "${day.lift.title}" is a plan day`);
    assert.ok(day.lift.lifts.length <= LOOK_AHEAD_KEY_LIFTS);
    assert.deepEqual(day.lift.lifts, items.slice(0, day.lift.lifts.length), "the plan's own order");
    assert.equal(day.lift.lifts.length + day.lift.more, new Set(items).size, "the rest are counted");
  }
  for (const day of days.filter((d) => d.rest)) {
    assert.equal(day.lift, null);
    assert.equal(day.run, null);
  }
  for (const day of days.filter((d) => d.run)) {
    assert.ok(day.run.label, `${day.date}: a run carries its words`);
    assert.ok(day.run.km == null || day.run.km > 0);
  }
});

test("this week is the plan strip's own week, and today's lift is the one strength line", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const today = localDateISO();
  const read = planLookAhead();
  const strip = planWeek(today);
  for (const day of read.weeks[0].days) {
    const cell = strip.days.find((c) => c.date === day.date);
    const name = cell.plan_day?.role === "strength" ? cell.plan_day.name : null;
    assert.equal(day.lift?.title ?? null, name ?? (day.today ? (cell.session?.title ?? null) : null), day.date);
  }
  assert.deepEqual(read.strength_line, todayStrengthLine(today));
});

test("a tapped day previews exactly what its row said (next week is read as of its Monday)", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const today = localDateISO();
  assert.equal(lookAheadWeekAsOf("2026-09-25", today), today, "this week reads as of today");
  assert.equal(lookAheadWeekAsOf("2026-10-01", today), "2026-09-28", "a later week as of its Monday");
  const days = planLookAhead()
    .weeks.flatMap((w) => w.days)
    .filter((d) => !d.today);
  for (const day of days) {
    const preview = dayRecord(day.date);
    assert.equal(preview.relation, "future");
    assert.equal(preview.lift?.title ?? null, day.lift?.title ?? null, `${day.date}: the lift`);
    assert.equal(preview.run?.kind ?? null, day.run?.kind ?? null, `${day.date}: the run`);
    assert.equal(preview.run?.km ?? null, day.run?.km ?? null, `${day.date}: the distance`);
    assert.equal(preview.rest, day.rest, `${day.date}: rest`);
  }
  // Read as of each day, next week's agenda put its next open run on every single day.
  const nextRuns = days.filter((d) => d.date >= "2026-09-28" && d.run).length;
  assert.ok(nextRuns < 7, "next week's runs are placed once, not on every day");
});

test("a race build names each week's rung beside it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
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
  const today = localDateISO();
  const build = raceBuild(today);
  assert.equal(build.available, true);
  // The ONE stage vocabulary (stage-words.ts): a build rung speaks as its race phase,
  // every other rung as its own kind of week.
  const words = {
    base: "Base week",
    build: "Build week",
    sharpen: "Sharpen week",
    down: "Lighter week",
    peak: "Peak week",
    taper: "Taper week",
    race: "Race week",
  };
  for (const week of planLookAhead().weeks) {
    const rung = build.weeks.find((w) => w.week_start === week.week_start);
    const mark = week.markers.find((m) => m.kind === "race_build");
    assert.ok(rung && mark, `${week.label} carries its rung`);
    const key = rung.kind === "build" ? (rung.phase === "taper" ? "taper" : rung.phase) : rung.kind;
    assert.equal(mark.word, words[key]);
    assert.equal(mark.word, rungStage(rung).week_word);
    // The rung's own short words ride beside the tag, unless they only restate it.
    const restates = rung.kind === "down" && /^a lighter week\.?$/i.test(rung.focus_short || "");
    assert.equal(mark.note, restates ? null : rung.focus_short || null);
    assert.ok(!mark.note || mark.note.toLowerCase().replace(/^a\s+/, "") !== mark.word.toLowerCase(), "never the tag twice");
  }
});

test("no lifting weekdays known: the lifting days read in the order they come round", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  for (const table of ["logged_sets", "sessions", "activities", "garmin_activities"])
    db.prepare(`DELETE FROM ${table}`).run();
  repo.setProfile({ endurance_schedule_json: null, strength_schedule_json: null });
  const read = planLookAhead();
  assert.equal(read.mode, "order");
  assert.deepEqual(read.weeks, []);
  const names = repo.getPlan().map((d) => d.name);
  assert.deepEqual([...read.order.map((l) => l.title)].sort(), [...names].sort(), "every lifting day, once");
});

test("nothing planned reads as empty, never as a failure", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  for (const table of ["logged_sets", "sessions", "activities", "garmin_activities", "plan_items", "plan_days"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  repo.setProfile({ endurance_schedule_json: null, strength_schedule_json: null, endurance_goal: null });
  const read = planLookAhead();
  assert.equal(read.mode, "empty");
  assert.deepEqual(read.weeks, []);
  assert.deepEqual(read.order, []);
});

test("GET /api/plan/look-ahead and get_plan_look_ahead answer the same read", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  seedDemo();
  const paths = planExercisesRouter.stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.ok(paths.includes("/plan/look-ahead"), "routed");
  assert.ok(paths.indexOf("/plan/look-ahead") < paths.indexOf("/plan/:day"), "ahead of /plan/:day");
  const layer = planExercisesRouter.stack.find((l) => l.route?.path === "/plan/look-ahead" && l.route.methods.get);
  const rest = await new Promise((resolve) => layer.route.stack.at(-1).handle({ query: {} }, { json: resolve }));
  const tools = new Map();
  registerPlanExerciseTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const mcp = JSON.parse((await tools.get("get_plan_look_ahead")({})).content[0].text);
  assert.deepEqual(mcp, JSON.parse(JSON.stringify(rest)));
  assert.equal(rest.mode, "calendar");
});

test("today's run: a rested one is no run item, and one already run is named by its kind", () => {
  const day = (run) => ({ date: "2026-09-22", run });
  const open = { kind: "easy", label: "Easy 30 min", status: "open", suggested_date: "2026-09-22", completion_date: null, km: 5 };
  assert.deepEqual(runOf(day(open), true), { kind: "easy", label: "Easy 30 min", km: 5, done: false }, "an open run keeps the morning's word");
  const rested = { ...open, label: "Rest or an easy walk", km: null, rested: true };
  assert.equal(runOf(day(rested), true), null, "a rested run never prints as a run beside the lift");
  const ran = { ...open, label: "Rest or an easy walk", status: "completed", completion_date: "2026-09-22", km: 8 };
  assert.deepEqual(runOf(day(ran), true), { kind: "easy", label: "Easy run", km: 8, done: true }, "the run done is named by its kind");
  const logged = { kind: "logged", label: "Run", status: "completed", suggested_date: null, completion_date: "2026-09-22", km: 4 };
  assert.equal(runOf(day(logged), true).label, "Run");
});
