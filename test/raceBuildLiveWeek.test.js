// raceBuildLiveWeek.test.js — the race build's leg map reads THIS week as placed
// (src/repo/race-build.ts liveWeekRing, src/repo/week-strength-placement.ts).
//
// Live (2026-10-20, taper week): a logged morning run made today's line swap Push B in
// for Tuesday's Lower, and the Plan strip traded Lower to Friday. The race build's leg
// map still laid the TEMPLATE ring — "Tuesday: Lower, heavy · Friday: Push B + an easy
// run" — and named Tuesday as the heavy-leg day, while the easy run was already done
// Tuesday. Horizon and Train told two different weeks. Now the current week's leg map,
// its heavy-lower days and this week's lifting line read the strip's own placement and
// the agenda's own run dates; later weeks keep the template ring.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { raceBuild } from "../dist/repo/race-build.js";
import { planDayStrengthGroups } from "../dist/repo/training-read.js";
import { dayReadComputeCounts } from "../dist/repo/day-read.js";
import { weekStrengthPlacement } from "../dist/repo/week-strength-placement.js";

beforeEach(() =>
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "plan_items",
    "plan_days",
    "app_state",
    "profile",
    "day_reads",
    "context_events",
    "daily_session_decisions",
    "daily_session_compositions",
    "exercises"
  )
);

const RACE = "2026-11-01"; // a Sunday: taper week 10-19, race week 10-26
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const slotOf = (iso) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

function seedRaceAthlete() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Pendlay Row", "back"],
    ["Back Squat", "quads"],
    ["Leg Curl", "hamstrings"],
    ["Dumbbell Bench Press", "chest"],
    ["Deadlift", "hamstrings"],
    ["Bulgarian Split Squat", "quads"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  const item = (exercise, target_weight) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight });
  repo.replacePlan([
    { day_number: 1, name: "Push", items: [item("Barbell Bench Press", 135)] },
    { day_number: 2, name: "Pull", items: [item("Pendlay Row", 150)] },
    { day_number: 3, name: "Lower A", items: [item("Back Squat", 185), item("Leg Curl", 120)] },
    { day_number: 4, name: "Upper", items: [item("Dumbbell Bench Press", 55)] },
    { day_number: 5, name: "Lower B", items: [item("Deadlift", 225), item("Bulgarian Split Squat", 60)] },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" },
  });
}

// A taper-week morning whose mapped day is a heavy Lower, with an upper day later on;
// today's selection hands the morning to that upper day and a run is logged before it.
function swapFixture() {
  const heavy = new Set(planDayStrengthGroups().filter((g) => g.heavy_lower).map((g) => g.day_number));
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
    const plain = planWeek(d);
    const today = plain.days.find((c) => c.date === d);
    if (!today?.plan_day || !heavy.has(today.plan_day.day_number)) continue;
    const later = plain.days.find(
      (c) => c.date > d && c.plan_day?.role === "strength" && !heavy.has(c.plan_day.day_number)
    );
    if (!later) continue;
    db.prepare(
      `INSERT INTO day_reads (date, kind, headline, why, focus, signals, source) VALUES (?, 'train', 'x', 'y', NULL, ?, 'deterministic')`
    ).run(d, JSON.stringify({ plan_selection: { selected: { day_number: later.plan_day.day_number }, adapted: true } }));
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 38, 6.6)`).run(d);
    return { today: d, heavy, lower: today.plan_day, laterDate: later.date, upper: later.plan_day };
  }
  return null;
}

// Today's line is read only for the real today: the clock is set to the fixture's morning.
const atNoon = (t, date) => t.mock.timers.enable({ apis: ["Date"], now: new Date(`${date}T12:00:00`) });

test("this week's leg map, heavy-leg days and runs read the week as the strip places it", (t) => {
  seedRaceAthlete();
  const fx = swapFixture();
  assert.ok(fx, "the taper week holds a heavy Lower with an upper day after it");
  atNoon(t, fx.today);
  const week = planWeek(fx.today);
  const build = raceBuild(fx.today);
  assert.ok(build.available);
  assert.equal(build.leg_map.length, 7);

  // The strip itself traded the two days.
  assert.equal(week.days.find((d) => d.date === fx.today).plan_day.day_number, fx.upper.day_number);
  assert.equal(week.days.find((d) => d.date === fx.laterDate).plan_day.day_number, fx.lower.day_number);

  // Strength: every weekday names the strip's plan day.
  for (const cell of week.days) {
    const leg = build.leg_map[slotOf(cell.date) - 1];
    const lift = cell.plan_day?.role === "strength" ? cell.plan_day : null;
    assert.equal(leg.strength?.name ?? null, lift?.name ?? null, `${cell.date}: leg map vs strip`);
    assert.equal(!!leg.strength?.heavy_lower, !!(lift && fx.heavy.has(lift.day_number)), cell.date);
  }

  // Heavy-leg days: the strip's, so Friday (where Lower now sits) — never today.
  const stripHeavy = week.days
    .filter((c) => c.plan_day?.role === "strength" && fx.heavy.has(c.plan_day.day_number))
    .map((c) => WEEKDAYS[slotOf(c.date) - 1]);
  assert.deepEqual(build.strength.heavy_lower_days, stripHeavy);
  assert.ok(!build.strength.heavy_lower_days.includes(WEEKDAYS[slotOf(fx.today) - 1]), "today's swapped-out Lower is not named");
  assert.ok(build.strength.heavy_lower_days.includes(WEEKDAYS[slotOf(fx.laterDate) - 1]));

  // Runs sit where the agenda dated them — the run logged this morning on today.
  const todayLeg = build.leg_map[slotOf(fx.today) - 1];
  assert.ok(todayLeg.run, "this morning's run is on today's slot");
  assert.equal(todayLeg.run.km, 6.6);
  for (const cell of week.days) {
    const own =
      cell.run &&
      ((cell.run.status === "completed" && cell.run.completion_date === cell.date) ||
        (cell.run.status === "open" && cell.run.suggested_date === cell.date));
    const leg = build.leg_map[slotOf(cell.date) - 1];
    assert.equal(!!leg.run, !!own, `${cell.date}: a run on the leg map iff the strip dates one there`);
  }
});

test("later rungs keep the template ring; with no swap the live map is the template", () => {
  seedRaceAthlete();
  const asOf = "2026-10-20";
  const plain = raceBuild(asOf);
  const week = planWeek(asOf);
  // No swap: strength reads the same weekday map either way.
  for (const cell of week.days) {
    const leg = plain.leg_map[slotOf(cell.date) - 1];
    const lift = cell.plan_day?.role === "strength" ? cell.plan_day : null;
    assert.equal(leg.strength?.name ?? null, lift?.name ?? null, cell.date);
  }
  // Every later rung still speaks: the race week's line is the ring's.
  const raceWeek = plain.weeks.find((w) => w.kind === "race");
  assert.ok(raceWeek && raceWeek.with_lifting, "race week keeps its lifting line");
});

test("an internal build (templateRing) lays the template ring and never reads today's line", () => {
  seedRaceAthlete();
  const fx = swapFixture();
  assert.ok(fx);
  const internal = raceBuild(fx.today, { templateRing: true });
  const leg = internal.leg_map[slotOf(fx.today) - 1];
  assert.equal(leg.strength?.name, fx.lower.name, "the template ring keeps the map's day");
});

test("a build read as of a later Monday lays the map's forecast and never computes a day read", (t) => {
  seedRaceAthlete();
  const fx = swapFixture();
  assert.ok(fx);
  atNoon(t, fx.today);
  const nextMonday = "2026-10-26";
  // The real today's placement trades; the same week read as of any other date is the map.
  assert.equal(weekStrengthPlacement(fx.today).on(fx.today).day_number, fx.upper.day_number);
  const before = dayReadComputeCounts();
  const later = raceBuild(nextMonday, { describeRunning: true });
  assert.ok(later.available);
  const after = dayReadComputeCounts();
  assert.equal(after[nextMonday] ?? 0, before[nextMonday] ?? 0, "no day read of a morning that has not happened");
  assert.deepEqual(
    Object.keys(after).filter((d) => d > fx.today && (after[d] ?? 0) !== (before[d] ?? 0)),
    [],
    "no future date pays for a day read"
  );
  // Read as of that Monday, the placement is the map's own forecast on every date.
  const ahead = weekStrengthPlacement(nextMonday);
  for (const d of ahead.days) assert.equal(d.day_number, d.mapped_day_number, d.date);
  assert.equal(ahead.moved_to, null);
});

test("a logged session titled as itself still marks its heavy-leg day on this week's leg map", (t) => {
  seedRaceAthlete();
  const heavy = new Set(planDayStrengthGroups().filter((g) => g.heavy_lower).map((g) => g.day_number));
  const asOf = "2026-10-23";
  atNoon(t, asOf);
  const plain = planWeek(asOf);
  const lower = plain.days.find((c) => c.date < asOf && c.plan_day && heavy.has(c.plan_day.day_number));
  assert.ok(lower, "a heavy Lower earlier this week");
  for (const [exercise, weight] of [
    ["Back Squat", 185],
    ["Leg Curl", 120],
  ])
    repo.logSetByName({ exercise, weight, reps: 6, rir: 2, date: lower.date, day_number: lower.plan_day.day_number });
  const sessionId = db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(lower.date).id;
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'athlete_override', 'active', 'Legs, short', ?, 'test')`
  ).run(sessionId, lower.date, JSON.stringify([{ exercise: "Back Squat" }, { exercise: "Leg Curl" }]));
  const placed = weekStrengthPlacement(asOf).on(lower.date);
  assert.equal(placed.logged, true);
  assert.equal(placed.day_number, null, "the session shows as itself");
  assert.equal(placed.placed_day_number, lower.plan_day.day_number);

  const build = raceBuild(asOf);
  const weekday = WEEKDAYS[slotOf(lower.date) - 1];
  assert.ok(build.strength.heavy_lower_days.includes(weekday), `${weekday} keeps its heavy-leg mark`);
  const leg = build.leg_map[slotOf(lower.date) - 1];
  assert.equal(leg.strength?.name, "Legs, short", "named as the strip names it");
  assert.equal(leg.strength?.heavy_lower, true);
});

// ---------- a LOGGED day in place of the map's day (live, 2026-10-20) ----------
//
// Push B logged on Tuesday's Lower: the placement stopped trading once the session landed,
// the strip lost Lower and race-build heavy_lower_days read []. One placement, both reads.

const LIVE_MON = "2026-10-19";
const LIVE_TUE = "2026-10-20";

function logDay(date, day_number, sets) {
  for (const [exercise, weight] of sets) repo.logSetByName({ date, exercise, weight, reps: 6, rir: 2, day_number });
  repo.finishSession(db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(date).id);
}

function seedLiveWeek() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Overhead Press", "shoulders"],
    ["Back Squat", "quads"],
    ["Romanian Deadlift", "hamstrings"],
    ["Pendlay Row", "back"],
    ["Barbell Curl", "biceps"],
    ["Lat Pulldown", "back"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  const item = (exercise, target_weight) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight });
  repo.replacePlan([
    { day_number: 1, name: "Push A", items: [item("Barbell Bench Press", 155)] },
    { day_number: 2, name: "Lower", items: [item("Back Squat", 185), item("Romanian Deadlift", 185)] },
    { day_number: 3, name: "Upper back & arms", items: [item("Pendlay Row", 150), item("Barbell Curl", 70)] },
    { day_number: 4, name: "Push B", items: [item("Overhead Press", 95)] },
    { day_number: 5, name: "Pull", items: [item("Lat Pulldown", 140)] },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" },
  });
  logDay("2026-10-16", 2, [["Back Squat", 185]]);
}

test("live: Push B logged on Tuesday's Lower — the leg map's heavy-leg day is Friday, as the strip places it", (t) => {
  seedLiveWeek();
  atNoon(t, LIVE_TUE);
  const before = planWeek(LIVE_MON)
    .days.filter((d) => d.dow >= 1 && d.dow <= 5)
    .map((d) => d.plan_day?.day_number);
  assert.deepEqual(before, [3, 2, 5, 1, 4], "the fixture's key-run-aware map");
  logDay(LIVE_MON, 3, [["Pendlay Row", 150]]);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 38, 6.6)`).run(
    LIVE_TUE
  );
  logDay(LIVE_TUE, 4, [["Overhead Press", 95]]);

  const placement = weekStrengthPlacement(LIVE_TUE);
  assert.equal(placement.moved_to, "2026-10-23");
  assert.equal(placement.unplaced_day_number, null);

  const build = raceBuild(LIVE_TUE);
  assert.ok(build.available);
  assert.deepEqual(build.strength.heavy_lower_days, ["Friday"]);
  const fri = build.leg_map[slotOf("2026-10-23") - 1];
  assert.equal(fri.strength?.name, "Lower");
  assert.equal(fri.strength?.heavy_lower, true);
  const week = planWeek(LIVE_TUE);
  for (const cell of week.days) {
    const leg = build.leg_map[slotOf(cell.date) - 1];
    const lift = cell.plan_day?.role === "strength" ? cell.plan_day : null;
    assert.equal(
      leg.strength?.name ?? null,
      lift?.name ?? cell.session?.title ?? null,
      `${cell.date}: leg map vs strip`
    );
  }
});
