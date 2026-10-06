// The day detail (src/domain/training/day-detail.ts): one calendar day of the training
// week opened — the focus, the lift's exercises with sets × reps and the progression
// engine's loads, the run's distance / zone / pace band and its quality structure, why
// the day sits where it does, where to pay attention (a heavy-leg day beside a key run),
// and what was done. GET /api/plan/day-detail and get_plan_day_detail answer the same body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { dayDetail, dayDetailRunStructure, dayDetailWeekAsOf } from "../dist/domain/training/day-detail.js";
import { planDayProgression } from "../dist/repo/progression.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { planExercisesRouter } from "../dist/routes/plan-exercises.js";
import { registerPlanExerciseTools } from "../dist/surfaces/mcp/plan-exercises.js";

// Tuesday 2026-04-21. This week: Mon Push, Tue easy run, Wed Lower A, Thu quality run,
// Fri Pull, Sat rest, Sun long run. A half marathon ten weeks out gives pace bands.
const NOW = new Date("2026-04-21T12:00:00");
const MONDAY = "2026-04-20";
const TUESDAY = "2026-04-21";
const WEDNESDAY = "2026-04-22";
const THURSDAY = "2026-04-23";
const SATURDAY = "2026-04-25";
const SUNDAY = "2026-04-26";

function seedRunner({ weeks = 10, km = 9 } = {}) {
  const before = (n) => new Date(Date.parse(`${MONDAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < weeks; wk++) {
    for (const off of [1, 3, 5]) {
      repo.addActivity({ type: "run", duration_min: Math.round(km * 6), distance_km: km, date: before(wk * 7 + off) });
    }
  }
}

function seedHybridWeek(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  repo.savePlanDay(1, "Push", "Chest, shoulders & triceps", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    { exercise: "Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 85 },
    { exercise: "Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 },
  ]);
  repo.savePlanDay(2, "Lower A", "Squat and hinge", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 90 },
  ]);
  repo.savePlanDay(3, "Pull", "Back and biceps", [
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 120 },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: {
      mode: "race",
      event: "Riverside Half",
      date: "2026-06-28",
      distance_km: 21.1,
      target: "sub-1:50",
    },
    strength_schedule: { days: [{ dow: 1 }, { dow: 3 }, { dow: 5 }], source: "athlete", updated_at: MONDAY },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
      updated_at: MONDAY,
    },
  });
  seedRunner();
}

function assertNoScore(read) {
  assert.doesNotMatch(JSON.stringify(read), /"(?:score|grade|percent|percentile|impact_score)"/i);
}

test("a lift day carries its exercises, the anchor, the progression's loads and a day-specific intent", (t) => {
  seedHybridWeek(t);
  const read = dayDetail(WEDNESDAY);
  assert.ok(read);
  assert.equal(read.status, "upcoming");
  assert.equal(read.placed, true);
  assert.equal(read.lift.title, "Lower A");
  assert.equal(read.lift.focus, "Squat and hinge");
  assert.deepEqual(
    read.lift.exercises.map((e) => e.name),
    ["Back Squat", "Romanian Deadlift", "Leg Curl"],
    "the plan's own order"
  );
  assert.equal(read.lift.anchor, "Back Squat", "the first primary-tier compound anchors the day");
  assert.equal(read.lift.exercises.filter((e) => e.anchor).length, 1);
  assert.equal(read.lift.heavy_lower, true);
  assert.equal(read.lift.exercises[0].prescription, "3 × 5–8");
  assert.equal(read.lift.total_sets, 9);
  // Loads come from the progression engine for a day ahead — never invented.
  const progression = planDayProgression(read.lift.day_number, { readDate: WEDNESDAY });
  for (const e of read.lift.exercises) {
    const p = progression.find((row) => row.exercise.toLowerCase() === e.name.toLowerCase());
    assert.ok(p, `${e.name} has a progression row`);
    assert.equal(e.load?.source, "progression");
    assert.equal(e.load?.weight, p.suggested.weight ?? null, `${e.name}: the engine's load`);
  }
  assert.match(read.lift.intent, /Back Squat/);
  assert.ok(read.lift.point.length > 10);
  assert.ok(read.why, "the race build grounds the day");
  assert.match(read.why, /Riverside Half/);
  assert.equal(read.run, null);
  assert.equal(read.done, null, "a day ahead carries no log");
  assertNoScore(read);
});

test("a quality day expresses warm-up, the work at its zone and pace, and a cool-down — the engine's own numbers", (t) => {
  seedHybridWeek(t);
  for (const date of [THURSDAY, "2026-04-30"]) {
    const read = dayDetail(date);
    assert.ok(read?.run, `${date}: a run`);
    const run = read.run;
    assert.equal(run.kind, "quality", date);
    assert.equal(run.status, "open");
    assert.ok(run.km > 0);
    assert.equal(run.mi, Math.round((run.km / 1.609344) * 10) / 10, "a miles twin");
    assert.deepEqual(
      run.structure.map((s) => s.part),
      ["warm_up", "main", "cool_down"],
      `${date}: quality reads in three parts`
    );
    const main = run.structure[1];
    assert.ok(main.reps > 0, "the engine's reps");
    assert.ok(["Z3", "Z4", "Z5"].includes(main.zone), main.zone);
    assert.ok(main.hr && main.hr.low_bpm < main.hr.high_bpm, "the zone's bpm band");
    assert.ok(run.zone?.key && run.zone.text, "the engine's zone tag rides along");
    assert.ok(run.zone.text.includes(`${run.zone.low_bpm}`), "one bpm band for the zone, never two");
    // Sized parts add up to the engine's distance; an unsized part never invents a km.
    const sized = run.structure.filter((s) => s.km != null);
    if (sized.length === 3) {
      const sum = sized.reduce((n, s) => n + s.km, 0);
      assert.ok(Math.abs(sum - run.km) < 0.15, `${date}: ${sum} vs ${run.km}`);
    }
    for (const s of run.structure.filter((s) => s.part !== "main")) assert.equal(s.zone, "Z2");
    assert.ok(run.pace?.text, "the race build's pace band");
    assert.ok(run.session, "the engine's own session sentence");
    assert.ok(run.point.length > 10);
    assertNoScore(read);
  }
});

test("a threshold 5 km block keeps the engine's reps and splits the rest of the run either side", () => {
  const rx = {
    day_number: 4,
    label: "Threshold intervals",
    kind_label: "quality",
    target_distance_km: 8,
    target_zone: "Z4 (150–162 bpm)",
    interval: [{ reps: 5, on: "1km", off: "60s jog", zone: "Z4" }],
  };
  const parts = dayDetailRunStructure("quality", 8, rx, rx.label, false, false, null, []);
  assert.deepEqual(
    parts.map((p) => [p.part, p.label, p.km]),
    [
      ["warm_up", "Warm-up", 1.5],
      ["main", "Threshold", 5],
      ["cool_down", "Cool-down", 1.5],
    ]
  );
  assert.equal(parts[1].text, "5 × 1 km at threshold, 60 s jog between (5 km of threshold work)");
  assert.equal(parts[1].reps, 5);
  assert.equal(parts[1].on, "1km");
  assert.equal(parts[1].zone, "Z4");
  // The engine sized only the work: the warm-up and cool-down are said, never given a km.
  const bare = dayDetailRunStructure("quality", 5, rx, rx.label, false, false, null, []);
  assert.equal(bare[0].km, null);
  assert.equal(bare[2].km, null);
  assert.equal(bare[1].km, 5);
});

test("a long run day: one steady segment at the engine's distance, easy zone, the long-run pace band", (t) => {
  seedHybridWeek(t);
  const read = dayDetail(SUNDAY);
  assert.equal(read.status, "upcoming");
  assert.equal(read.lift, null);
  assert.equal(read.run.kind, "long");
  assert.equal(read.run.structure.length, 1);
  assert.equal(read.run.structure[0].km, read.run.km);
  assert.equal(read.run.zone.key, "Z2");
  assert.equal(read.run.pace?.key, "long");
  assert.match(read.headline, /long run/i);
  assert.match(read.focus, /Long run/);
  assertNoScore(read);
});

test("a rest day holds nothing and says so plainly", (t) => {
  seedHybridWeek(t);
  const read = dayDetail(SATURDAY);
  assert.equal(read.status, "rest");
  assert.equal(read.lift, null);
  assert.equal(read.run, null);
  assert.equal(read.stack, null);
  assert.deepEqual(read.watch, []);
  assert.equal(read.focus, "Rest");
  assert.equal(read.headline, "A rest day. Nothing is planned.");
});

test("a done day carries what was actually done; its loads are the plan's, not the next exposure's", (t) => {
  seedHybridWeek(t);
  for (let i = 0; i < 3; i++)
    repo.logSetByName({ exercise: "Bench Press", weight: 155, reps: 8, rir: 2, date: MONDAY });
  for (let i = 0; i < 3; i++)
    repo.logSetByName({ exercise: "Overhead Press", weight: 85, reps: 10, rir: 2, date: MONDAY });
  repo.finishSession(repo.getOrCreateSession(MONDAY).id);
  const monday = dayDetail(MONDAY);
  assert.equal(monday.status, "done");
  assert.ok(monday.done?.session, "the logged session");
  assert.ok(monday.done.session.finished);
  assert.ok(monday.done.session.movements.some((m) => /Bench Press/.test(m.name)));
  assert.equal(monday.lift.title, "Push");
  for (const e of monday.lift.exercises)
    assert.equal(e.load?.source ?? "plan", "plan", `${e.name}: a lived day keeps the plan`);
  assert.deepEqual(monday.watch, [], "attention belongs to a day still to come");
  assert.equal(monday.stack, null);
  assert.match(monday.headline, /done/);

  // Today's easy run, run: the day is done and the run reads what was run.
  repo.addActivity({ type: "run", date: TUESDAY, duration_min: 33, distance_km: 5.2 });
  const tuesday = dayDetail(TUESDAY);
  assert.equal(tuesday.done.runs.length, 1);
  assert.equal(tuesday.run?.status, "completed");
  assert.equal(tuesday.run.completed.km, 5.2);
  assert.equal(tuesday.status, "done");
  assertNoScore(monday);
  assertNoScore(tuesday);
});

test("heavy legs beside a quality run: a quiet stack note on both days, naming the neighbour", (t) => {
  seedHybridWeek(t);
  const wed = dayDetail(WEDNESDAY);
  assert.ok(wed.stack, "the heavy-lower day knows tomorrow's key run");
  assert.equal(wed.stack.neighbours[0].date, THURSDAY);
  assert.equal(wed.stack.neighbours[0].kind, "quality_run");
  assert.match(wed.stack.text, /Thursday/);
  const thu = dayDetail(THURSDAY);
  assert.ok(thu.stack, "the key run knows yesterday's heavy legs");
  assert.equal(thu.stack.neighbours[0].kind, "heavy_lower");
  assert.equal(thu.stack.neighbours[0].what, "Lower A");
  assert.match(thu.stack.text, /Wednesday/);
  // Suggestion, never a gate.
  for (const line of [wed.stack.text, thu.stack.text])
    assert.doesNotMatch(line, /\byou must\b|\bdon't\b|\bnot allowed\b/i);
  // A light day beside an easy run carries no note.
  assert.equal(dayDetail(TUESDAY).stack, null);
});

test("a lift and a key run on the same day share one note", (t) => {
  seedHybridWeek(t);
  // Thursday also lifts: legs and the quality session share the day.
  repo.setProfile({
    strength_schedule: { days: [{ dow: 1 }, { dow: 4 }, { dow: 5 }], source: "athlete", updated_at: MONDAY },
  });
  const thuCell = planWeek(TUESDAY).days.find((d) => d.date === THURSDAY);
  assert.equal(thuCell?.plan_day?.name, "Lower A", "the second lifting weekday takes the second plan day");
  const read = dayDetail(THURSDAY);
  assert.equal(read.lift?.title, "Lower A");
  assert.equal(read.lift.heavy_lower, true);
  assert.equal(read.run?.kind, "quality");
  assert.ok(read.stack, "one note for the shared day");
  assert.deepEqual(read.stack.neighbours, [], "the same day, no neighbour");
  assert.match(read.stack.text, /Lower A/);
  assert.match(read.headline, /^A Lower A day, then the quality session \(/);
  assert.equal(read.focus, `Lower A · ${read.run.label}`);
});

test("the week a day is read from: today's week as of today, a later week as of its Monday, a past week as of its Sunday", () => {
  assert.equal(dayDetailWeekAsOf(THURSDAY, TUESDAY), TUESDAY);
  assert.equal(dayDetailWeekAsOf("2026-04-30", TUESDAY), "2026-04-27");
  assert.equal(dayDetailWeekAsOf("2026-04-15", TUESDAY), "2026-04-19");
});

test("past the end of next week nothing is forecast: null, never an invented day", (t) => {
  seedHybridWeek(t);
  assert.ok(dayDetail("2026-05-03"), "next Sunday is the last day read");
  assert.equal(dayDetail("2026-05-04"), null);
  assert.equal(dayDetail("not-a-date"), null);
});

test("GET /api/plan/day-detail and get_plan_day_detail answer the same read", async (t) => {
  seedHybridWeek(t);
  const paths = planExercisesRouter.stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.ok(paths.includes("/plan/day-detail"), "routed");
  assert.ok(paths.indexOf("/plan/day-detail") < paths.indexOf("/plan/:day"), "ahead of /plan/:day");
  const layer = planExercisesRouter.stack.find((l) => l.route?.path === "/plan/day-detail" && l.route.methods.get);
  const call = (query) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ status: this.statusCode, body });
        },
      };
      layer.route.stack.at(-1).handle({ query }, res);
    });
  const rest = await call({ date: THURSDAY });
  assert.equal(rest.status, 200);
  const tools = new Map();
  registerPlanExerciseTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const mcp = JSON.parse((await tools.get("get_plan_day_detail")({ date: THURSDAY })).content[0].text);
  assert.deepEqual(mcp, JSON.parse(JSON.stringify(rest.body)));
  assert.equal((await call({ date: "nope" })).status, 400);
  const far = await call({ date: "2026-06-01" });
  assert.equal(far.status, 200);
  assert.equal(far.body, null, "single-row absent: 200 + null");
});
