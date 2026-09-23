// The run build respects demonstrated capacity and tapers like a half-marathon build.
//
// The case these lock down (a Sunday half about six weeks out, read on the Wednesday of
// the ramp's own reset week, which follows a capacity week that included a
// well-absorbed new longest run): the ladder stepped off the reset itself, re-climbed
// the long run for three weeks to a distance already run, and put the peak volume the
// week immediately before race week.
//
//   • a reset is recovery, not lost ground: the week after it steps off the level the
//     reset paused (engine and ladder alike), provided the reset was run as a lighter
//     week and not as an absence;
//   • a long run taken WELL (harmEvidenceOnDay clears its day) is capacity: a reset
//     holds it and a build never plans back up to it; one the body paid for is not;
//   • the arrival is counted in calendar weeks to race week: peak two weeks before
//     race week, the week before race week tapers, race week tapers further — and the
//     taper belongs to the week, so the peak week's own Sunday never flips to a taper;
//   • run intensity is untouched — an "easy" run the watch grades as quality moves no
//     volume or long-run number.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { demonstratedLongKm, projectRaceBuildWeeks } from "../dist/repo/race-build.js";
import { peakWeeklyKm, raceRamp } from "../dist/repo/run-ramp.js";

const RACE = "2031-11-02"; // a Sunday
const HALF = 21.1;
const goal = { is_race: true, date: RACE, distance_km: HALF, target: "1:55" };
const STATED = {
  days: [
    { dow: 0, kind: "long" },
    { dow: 2, kind: "easy" },
    { dow: 4, kind: "quality" },
  ],
  source: "athlete",
};

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "sessions",
    "plan_items",
    "plan_days",
    "program_blocks",
    "app_state",
    "profile"
  );
});

const totalKm = (plan) => Math.round(plan.runs.reduce((s, r) => s + (Number(r.target_distance_km) || 0), 0) * 10) / 10;
const longRun = (plan) => plan.runs.find((r) => r.kind_label === "long");
const run = (date, km) => repo.addActivity({ type: "run", duration_min: Math.round(km * 6), distance_km: km, date });

function seedHalfRunner() {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "City Half", date: RACE, distance_km: HALF, target: "1:55" },
    endurance_schedule: STATED,
  });
  // Four steady base weeks, then the capacity week: Tue easy, Thu quality, Sun 17.6.
  for (const [tue, thu, sun] of [
    ["2031-08-19", "2031-08-21", "2031-08-24"],
    ["2031-08-26", "2031-08-28", "2031-08-31"],
    ["2031-09-02", "2031-09-04", "2031-09-07"],
    ["2031-09-09", "2031-09-11", "2031-09-14"],
  ]) {
    run(tue, 7);
    run(thu, 8);
    run(sun, 13);
  }
  run("2031-09-16", 6.3);
  run("2031-09-18", 8.5);
  run("2031-09-21", 17.6);
}

// ── the ladder (pure) ──────────────────────────────────────────────────────────

test("the ladder: a reset after a capacity week does not reset the ramp, and never plans back up to a long run already run", () => {
  // The shape: this week is the ramp's reset (25.9 km, long 14.1 held by the
  // spike brake), last week was 32.4 km, and 17.6 km was run well on 9/21.
  const weeks = projectRaceBuildWeeks(goal, "2031-09-24", 25.9, 14.1, { km: 25.9, long_km: 14.1 }, null, {
    priorWeekKm: 32.4,
    demonstratedLongKm: 17.6,
  });
  assert.deepEqual(
    weeks.map((w) => w.kind),
    ["down", "build", "build", "peak", "taper", "race"]
  );
  // The week after the reset steps off the 32.4 km it paused, not off 25.9.
  assert.equal(weeks[1].km, raceRamp(goal, "2031-09-29", 32.4, 17.6).required_km);
  assert.ok(weeks[1].km > 32.4, `the build resumes above the paused level (got ${weeks[1].km})`);
  // Every build/peak rung holds at least what was already run well.
  for (const w of weeks.filter((x) => x.kind === "build" || x.kind === "peak")) {
    assert.ok(w.long_km >= 17.6, `${w.week_start} long ${w.long_km} sits under the demonstrated 17.6`);
  }
});

test("the ladder: a reset run as an absence keeps the ordinary step off what was actually run", () => {
  // 8 km in a reset week after 32.4 is not a reset, it is a gap — the build steps off it.
  const weeks = projectRaceBuildWeeks(goal, "2031-09-24", 8, 8, { km: 8, long_km: 8 }, null, { priorWeekKm: 32.4 });
  assert.equal(weeks[1].km, raceRamp(goal, "2031-09-29", 8, 8).required_km);
});

test("the ladder: a Sunday half peaks two weeks before race week and tapers the week before it", () => {
  const weeks = projectRaceBuildWeeks(goal, "2031-09-24", 25.9, 14.1, { km: 25.9, long_km: 14.1 }, null, {
    priorWeekKm: 32.4,
    demonstratedLongKm: 17.6,
  });
  const peak = weeks.find((w) => w.kind === "peak");
  const taper = weeks.find((w) => w.kind === "taper");
  const race = weeks.at(-1);
  assert.equal(peak.week_start, "2031-10-13", "the peak week's long run lands two weeks before race day");
  assert.equal(taper.week_start, "2031-10-20");
  assert.equal(race.week_start, "2031-10-27");
  assert.ok(
    weeks.every((w) => w.km <= peak.km + 1e-9),
    "the peak is the ladder's high point"
  );
  assert.ok(taper.km < peak.km && race.km < taper.km, "volume steps down twice into the race");
  assert.ok(taper.long_km < peak.long_km, "the long run comes down in the taper");
});

test("raceRamp: the arrival counts calendar weeks to race week; the reset cadence does not move", () => {
  const peakKm = peakWeeklyKm(HALF);
  // The Monday before race week of a Sunday race: ceil(days/7) is 2, but it is the
  // final taper week — never the peak.
  const finalTaper = raceRamp(goal, "2031-10-20", 40, 17.6);
  assert.equal(finalTaper.weeks_to_race, 2);
  assert.equal(finalTaper.weeks_to_race_week, 1);
  assert.equal(finalTaper.taper_week, true);
  assert.ok(finalTaper.ideal_required_km < peakKm, "the week before race week is not the peak");
  assert.equal(finalTaper.required_km, 28, "about 0.7 of the week before");
  const peakWeek = raceRamp(goal, "2031-10-13", 38, 17.6);
  assert.equal(peakWeek.weeks_to_race_week, 2);
  assert.equal(peakWeek.taper_week, false);
  assert.equal(peakWeek.ideal_required_km, peakKm);
  assert.equal(raceRamp(goal, "2031-10-27", 28, 10).weeks_to_race_week, 0);
  // The reset cadence keeps its count: the scheduled reset week is still the reset.
  assert.equal(raceRamp(goal, "2031-09-22", 32.4, 17.6).down_week, true);
  assert.equal(raceRamp(goal, "2031-09-29", 32.4, 17.6).down_week, false);
});

// ── the engine ────────────────────────────────────────────────────────────────

test("weeklyRunPlan: the week after the ramp's reset picks up from the level the reset paused", () => {
  seedHalfRunner();
  // The reset week, run as a lighter week (24.1 of the paused 32.4).
  run("2031-09-23", 4.3);
  run("2031-09-25", 5.7);
  run("2031-09-28", 14.1);
  const plan = repo.weeklyRunPlan("2031-09-29");
  assert.equal(plan.available, true);
  assert.ok(
    plan.rationale.some((l) => /Picking the build back up/.test(l)),
    plan.rationale.join(" | ")
  );
  assert.ok(
    longRun(plan).target_distance_km >= 17.6,
    `long ${longRun(plan).target_distance_km} sits under 17.6 already run`
  );
  assert.equal(
    plan.goal_feasibility.week_km,
    raceRamp(goal, "2031-09-29", 32.4, 17.6).required_km,
    "the ramp steps off 32.4, not 24.1"
  );
});

test("weeklyRunPlan: a reset week that was an absence keeps the ordinary reactive anchor", () => {
  seedHalfRunner();
  run("2031-09-23", 4.3);
  const plan = repo.weeklyRunPlan("2031-09-29");
  assert.ok(!plan.rationale.some((l) => /Picking the build back up/.test(l)));
});

test("weeklyRunPlan: a reset week holds a long run taken well — and steps under one the body paid for", () => {
  seedHalfRunner();
  const held = repo.weeklyRunPlan("2031-09-22");
  assert.ok(
    held.rationale.some((l) => /Scheduled down week/.test(l)),
    held.rationale.join(" | ")
  );
  assert.ok(
    longRun(held).target_distance_km >= 17.6 - 0.05,
    `a reset holds the 17.6 taken well (got ${longRun(held).target_distance_km})`
  );
  assert.ok(longRun(held).target_distance_km <= 17.6 + 0.05, "and never steps past it");
  assert.ok(totalKm(held) < 32.4, "the reset still reads lighter than the week it follows");

  // The same long run, followed by a morning whose HRV status reads low: harm, so
  // the reset steps a clear margin under it, as it always did.
  repo.upsertGarminDailyMetric({ date: "2031-09-22", hrv_status: "LOW" });
  const paid = repo.weeklyRunPlan("2031-09-22");
  assert.ok(longRun(paid).target_distance_km <= 17.6 * 0.85 + 0.05, `long ${longRun(paid).target_distance_km}`);
  assert.equal(
    demonstratedLongKm("2031-09-24", [
      { date: "2031-09-21", km: 17.6 },
      { date: "2031-09-14", km: 13 },
    ]),
    13
  );
});

// Injected inputs, as runRamp.test.js drives the engine, so the taper is read off the
// calendar alone.
const planOpts = (anchorDate, actualKm, over = {}) => ({
  goal: {
    mode: "race",
    is_race: true,
    event: "City Half",
    date: RACE,
    distance_km: HALF,
    target: "1:55",
    phase: "taper",
    weeks_to_race: 2,
    weekly_km: null,
    weekly_sessions: null,
  },
  compliance: { actual_km: actualKm, prescribed_km: actualKm },
  volumeAnchorDate: anchorDate,
  programState: {
    endurance: { sport: "run", longest_km_4wk: 17.6, has_quality: true, status: "building", ...over.endurance },
    mesocycle: { phase: "accumulation" },
    recovery_week: { state: "none" },
  },
  recovery: {},
  block: { week_index: 1 },
  zones: { available: false, zones: [] },
  directives: [],
  responseModifier: null,
  trainingIntent: { endurance_role: "primary", source: "explicit" },
});

test("weeklyRunPlan: the taper belongs to the week — the peak week's Sunday is not a taper, the week before race week is", () => {
  const TAPER_LINE = /week before race week|Race week/;
  // Sunday 2031-10-19 is the peak week's long-run day; ceil(days/7) already reads 2
  // ("taper") there, and the long run was capped at 0.6 of the longest on its own day.
  const peakSunday = repo.weeklyRunPlan("2031-10-19", planOpts("2031-10-12", 38));
  assert.ok(!peakSunday.rationale.some((l) => TAPER_LINE.test(l)), peakSunday.rationale.join(" | "));
  assert.ok(
    longRun(peakSunday).target_distance_km > 17.6 * 0.6 + 0.1,
    `peak long ${longRun(peakSunday).target_distance_km}`
  );

  const finalTaper = repo.weeklyRunPlan("2031-10-20", planOpts("2031-10-19", 40));
  assert.ok(
    finalTaper.rationale.some((l) => /week before race week/.test(l)),
    finalTaper.rationale.join(" | ")
  );
  assert.ok(
    totalKm(finalTaper) <= 40 * 0.7 + 0.3 && totalKm(finalTaper) >= 40 * 0.55,
    `final taper ${totalKm(finalTaper)} km`
  );
  assert.ok(longRun(finalTaper).target_distance_km <= 17.6 * 0.6 + 0.05);

  const raceWeek = repo.weeklyRunPlan("2031-10-27", planOpts("2031-10-26", 28));
  assert.ok(
    raceWeek.rationale.some((l) => /^Race week/.test(l)),
    raceWeek.rationale.join(" | ")
  );
  // Race day IS race week's long run (its distance is the race's), so the taper is read
  // off the TRAINING runs around it: lighter than the week before.
  const race = raceWeek.runs.find((r) => r.race === true);
  assert.ok(race, "race week carries the race as its long run");
  const trainingKm = raceWeek.runs
    .filter((r) => r.race !== true)
    .reduce((sum, r) => sum + Number(r.target_distance_km || 0), 0);
  const taperTrainingKm = totalKm(finalTaper) - longRun(finalTaper).target_distance_km;
  assert.ok(trainingKm < taperTrainingKm, `race week's runs around the race are lighter (${trainingKm} vs ${taperTrainingKm})`);
});

test("weeklyRunPlan: an easy run the watch grades as quality moves no volume and no long run", () => {
  const graded = repo.weeklyRunPlan("2031-10-01", planOpts("2031-09-28", 30, { endurance: { has_quality: true } }));
  const plain = repo.weeklyRunPlan("2031-10-01", planOpts("2031-09-28", 30, { endurance: { has_quality: false } }));
  assert.equal(totalKm(graded), totalKm(plain));
  assert.equal(longRun(graded).target_distance_km, longRun(plain).target_distance_km);
});
