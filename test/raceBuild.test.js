// The race-build layer (src/repo/race-build.ts): target parsing, pace bands, the
// week-by-week ladder, the estimate + its trend, the leg map with the habitual ride
// and the heavy-lower day — plus the plan-writer half of the "startable empty Easy
// day" fix (an undeclared empty day is a rest day, never a startable training day).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import {
  fmtClock,
  paceBandsFor,
  paceKeyForQuality,
  parseRaceTarget,
  phaseForWeeks,
  projectRaceBuildWeeks,
  raceBuild,
  raceFit,
  riegel,
} from "../dist/repo/race-build.js";
import { raceRamp } from "../dist/repo/run-ramp.js";

// Sunday 2026-09-13 is the as-of; Cambridge Half is Sunday 2026-11-01 (7 weeks out).
const TODAY = "2026-09-13";
const RACE = "2026-11-01";
const HALF = 21.1;

function resetAll() {
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "exercises",
    "plan_items",
    "plan_days",
    "daily_metrics",
    "program_blocks",
    "plan_proposals",
    "app_state",
    "profile"
  );
}

const daysBefore = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - n * 864e5).toISOString().slice(0, 10);

// Six weeks of running: Tue / Thu / Sat, the Saturday long, plus a Sunday MTB ride
// most weeks. Dates are counted back from the as-of Sunday so the weekdays hold.
function seedHybridRunner({ weeks = 6, rideWeeks = [0, 1, 2, 4] } = {}) {
  for (let wk = 0; wk < weeks; wk++) {
    const sunday = daysBefore(TODAY, wk * 7); // the as-of Sunday and the Sundays before it
    repo.addActivity({ type: "run", duration_min: 48, distance_km: 8, date: daysBefore(sunday, 5) }); // Tue
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7.5, date: daysBefore(sunday, 3) }); // Thu
    repo.addActivity({ type: "run", duration_min: 84, distance_km: 13, date: daysBefore(sunday, 1) }); // Sat long
    if (rideWeeks.includes(wk)) {
      repo.addActivity({ type: "ride", raw_text: "MTB trail ride", duration_min: 95, distance_km: 22, date: sunday });
    }
  }
}

function seedRaceProfile(target = "sub-1:45") {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Cambridge Half", date: RACE, distance_km: HALF, target },
  });
}

function seedLiftingPlan() {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Lower · squat",
      items: [{ exercise: "Barbell Back Squat", sets: 4, rep_low: 4, rep_high: 6, target_weight: 225 }],
    },
    {
      day_number: 3,
      name: "Upper · push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
    },
    {
      day_number: 5,
      name: "Upper · pull",
      items: [{ exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 80 }],
    },
  ]);
}

beforeEach(resetAll);

// ---------------------------------------------------------------------------
// pure pieces
// ---------------------------------------------------------------------------

test("parseRaceTarget reads finish times, hours, paces and minutes — and rejects noise", () => {
  const sub = parseRaceTarget("sub-1:45", HALF);
  assert.equal(sub.sec, 105 * 60);
  assert.equal(sub.kind, "time");
  assert.ok(Math.abs(sub.pace_sec_per_km - (105 * 60) / HALF) < 0.01);
  assert.equal(parseRaceTarget("under 1:50:30", HALF).sec, 3600 + 50 * 60 + 30);
  assert.equal(parseRaceTarget("1h45", HALF).sec, 105 * 60);
  assert.equal(parseRaceTarget("22:30", 5).sec, 22 * 60 + 30, "a 5k target is minutes, not hours");
  assert.equal(parseRaceTarget("105 min", HALF).sec, 105 * 60);
  const pace = parseRaceTarget("4:55/km", HALF);
  assert.equal(pace.kind, "pace");
  assert.equal(pace.pace_sec_per_km, 295);
  assert.equal(pace.sec, Math.round(295 * HALF));
  const mile = parseRaceTarget("8:00 /mi", 10);
  assert.ok(Math.abs(mile.pace_sec_per_km - 480 / 1.609344) < 0.01);
  assert.equal(parseRaceTarget("finish strong", HALF), null);
  assert.equal(parseRaceTarget("0:30", HALF), null, "a 1:25 /km 'half' is a typo, not a target");
  assert.equal(parseRaceTarget(null, HALF), null);
});

test("paceBandsFor a half puts tempo at race pace, threshold and VO2 faster, easy and long slower", () => {
  const rp = 298; // ~4:58 /km, a 1:45 half
  const bands = Object.fromEntries(paceBandsFor(rp, HALF).map((b) => [b.key, b]));
  assert.equal(bands.race.fast_sec_per_km, rp);
  assert.equal(bands.tempo.fast_sec_per_km, rp);
  assert.ok(bands.threshold.fast_sec_per_km < rp && bands.threshold.slow_sec_per_km < rp);
  assert.ok(bands.vo2.fast_sec_per_km < bands.threshold.fast_sec_per_km);
  assert.ok(bands.easy.fast_sec_per_km > rp + 45);
  assert.ok(bands.long.fast_sec_per_km > rp && bands.long.fast_sec_per_km < bands.easy.fast_sec_per_km);
  assert.match(bands.threshold.text, /^\d:\d\d–\d:\d\d \/km$/);
  // Shorter races: the race itself is the hard pace, so tempo sits slower than race pace.
  const fiveK = Object.fromEntries(paceBandsFor(240, 5).map((b) => [b.key, b]));
  assert.ok(fiveK.tempo.fast_sec_per_km > 240);
  assert.equal(fiveK.vo2.fast_sec_per_km, 240);
});

test("paceKeyForQuality maps the engine's labels; hills are effort, not pace", () => {
  assert.equal(paceKeyForQuality("Threshold intervals"), "threshold");
  assert.equal(paceKeyForQuality("Tempo run"), "tempo");
  assert.equal(paceKeyForQuality("VO2 intervals"), "vo2");
  assert.equal(paceKeyForQuality("Hill repeats"), null);
  assert.equal(paceKeyForQuality(null), null);
});

test("riegel, raceFit, fmtClock and phaseForWeeks behave", () => {
  assert.ok(Math.abs(riegel(50 * 60, 10, HALF) - 50 * 60 * (HALF / 10) ** 1.06) < 1e-6);
  assert.equal(raceFit(6300, 6300), "fits");
  assert.equal(raceFit(6350, 6300), "fits", "within 1.5% reads as inside the target");
  assert.equal(raceFit(6700, 6300), "stretch");
  assert.equal(raceFit(7200, 6300), "beyond_horizon");
  assert.equal(fmtClock(6300), "1:45:00");
  assert.equal(fmtClock(298), "4:58");
  assert.equal(phaseForWeeks(7, HALF), "build");
  assert.equal(phaseForWeeks(4, HALF), "sharpen");
  assert.equal(phaseForWeeks(2, HALF), "taper");
  assert.equal(phaseForWeeks(4, 10), "sharpen");
  assert.equal(phaseForWeeks(16, HALF), "base");
});

test("projectRaceBuildWeeks walks every Monday to race week: build → peak → taper → race", () => {
  const goal = { is_race: true, date: RACE, distance_km: HALF, target: "sub-1:45" };
  const weeks = projectRaceBuildWeeks(goal, TODAY, 28, 13);
  assert.ok(weeks.length >= 7, `expected a ladder to race week, got ${weeks.length}`);
  assert.equal(weeks[0].current, true);
  assert.equal(weeks.filter((w) => w.current).length, 1);
  assert.equal(weeks.at(-1).kind, "race");
  assert.equal(weeks.at(-1).weeks_to_race, 0);
  // A Sunday race: the engine's peak is the week before race week and its taper IS
  // race week (its count is ceil(days/7) from the Monday), so the ladder reads
  // build … → peak → race, with no separate taper week to invent.
  assert.equal(weeks.at(-2).kind, "peak");
  assert.equal(weeks.at(-2).weeks_to_race, 1);
  assert.ok(weeks.slice(0, -2).every((w) => w.kind === "build" || w.kind === "down"));
  // Every week is the engine's own next safe step: the build never jumps more than
  // the sustainable factor, and the peak is the ladder's high point.
  for (let i = 1; i < weeks.length; i++) {
    assert.ok(weeks[i].km <= weeks[i - 1].km * 1.12 + 0.11, `week ${i} stepped too far`);
  }
  const peak = weeks.find((w) => w.kind === "peak");
  assert.ok(weeks.every((w) => w.km <= peak.km + 1e-9));
  assert.ok(weeks.at(-1).km < peak.km, "race week steps down from the peak");
  // A Monday race gets the full shape: peak, taper, then race week.
  const mondayRace = projectRaceBuildWeeks({ ...goal, date: "2026-11-02" }, TODAY, 28, 13);
  assert.deepEqual(mondayRace.slice(-3).map((w) => w.kind), ["peak", "taper", "race"]);
  assert.ok(weeks.every((w) => w.quality_hint && w.strength_hint));
  assert.equal(weeks.at(-1).strength_hint, "Legs off. A mobility session at most.");
});

test("the live week is a rung, not a patch — the walk steps off it, never off a step above it", () => {
  const goal = { is_race: true, date: RACE, distance_km: HALF, target: "sub-1:45" };
  // With no live prescription the current week is projected off the anchor, as before.
  const projected = projectRaceBuildWeeks(goal, TODAY, 28, 13);
  assert.equal(projected[0].km, raceRamp(goal, projected[0].week_start, 28, 13).required_km);

  // Handed the engine's own week, the ladder REPORTS it — and walks on from it.
  // raceRamp reads its anchor as the week BEFORE, so a walk that carried its own
  // projected step forward put week two a full ramp above where the ladder says it
  // starts, and every week after it inherited the gap.
  const walked = projectRaceBuildWeeks(goal, TODAY, 28, 13, { km: 30, long_km: 14 });
  assert.equal(walked[0].km, 30);
  assert.equal(walked[0].long_km, 14);
  assert.equal(walked[0].current, true);
  const step = raceRamp(goal, walked[1].week_start, 30, 14);
  assert.equal(walked[1].km, step.required_km, "week two is one step off week one, never two");

  // Handed the engine's NEXT week as well (a recovery week it already knows about),
  // the ladder reports that rung too and steps off it — one engine, one number.
  const known = projectRaceBuildWeeks(goal, TODAY, 28, 13, { km: 30, long_km: 14 }, { km: 21, long_km: 10 });
  assert.equal(known[1].km, 21);
  assert.equal(known[1].long_km, 10);
  assert.equal(known[1].current, false);
  const third = raceRamp(goal, known[2].week_start, 21, 10);
  assert.equal(known[2].km, third.required_km, "week three steps off the engine's week two");
  assert.equal(walked[1].long_km, step.required_long_km);
  assert.ok(walked[1].km < projected[1].km, `${walked[1].km} should sit below the double-stepped ${projected[1].km}`);
  // And the rest of the ladder still walks itself, rung by rung.
  for (let i = 2; i < walked.length; i++) {
    const rung = raceRamp(goal, walked[i].week_start, walked[i - 1].km, walked[i - 1].long_km);
    assert.equal(walked[i].km, rung.required_km, `week ${i} is the engine's own next step`);
  }
});

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

test("raceBuild is quiet without a dated race", () => {
  repo.setProfile({ primary_discipline: "hybrid", endurance_sport: "running", endurance_goal: null });
  const out = raceBuild(TODAY);
  assert.equal(out.available, false);
  assert.match(out.reason, /No dated race/);
  assert.deepEqual(out.weeks, []);
  assert.deepEqual(out.leg_map, []);
});

test("raceBuild is quiet for a race without a distance, and after the race", () => {
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Mystery", date: RACE },
  });
  assert.match(raceBuild(TODAY).reason, /no distance/);
  seedRaceProfile();
  assert.match(raceBuild("2026-11-05").reason, /behind you/);
});

test("raceBuild lays out the half: estimate from the watch, fit against the target, paces, ladder, leg map, ride", () => {
  seedRaceProfile("sub-1:45");
  seedHybridRunner();
  seedLiftingPlan();
  // The watch's half predictor, moving faster over the last month.
  repo.upsertGarminDailyMetric({ date: daysBefore(TODAY, 30), race_predict_half_sec: 6720 });
  repo.upsertGarminDailyMetric({ date: daysBefore(TODAY, 2), race_predict_half_sec: 6540 });

  const out = raceBuild(TODAY);
  assert.equal(out.available, true, out.reason);
  assert.equal(out.race.event, "Cambridge Half");
  assert.equal(out.race.weeks_to_race, 7);
  assert.equal(out.race.phase, "build");
  assert.equal(out.race.target.sec, 6300);

  // prediction: the watch's number, Riegel-adjusted to 21.1 km, with a trend and a fit.
  const p = out.prediction;
  assert.equal(p.basis, "watch_predictor");
  assert.ok(Math.abs(p.estimate_sec - 6540) < 5, `expected ~6540, got ${p.estimate_sec}`);
  assert.equal(p.trend.word, "faster");
  assert.ok(p.trend.delta_sec < -120);
  assert.equal(p.fit, "stretch");
  assert.ok(p.gap_sec > 200 && p.gap_sec < 260);

  // training paces anchored on current fitness (the estimate is slower than the
  // target); the race band alone keeps the target, as the race-pace touch.
  assert.equal(out.paces.anchored_on, "estimate");
  assert.equal(out.paces.race_pace_sec_per_km, Math.round(6300 / HALF));
  assert.equal(out.paces.bands.find((b) => b.key === "race").fast_sec_per_km, Math.round(6300 / HALF));
  assert.ok(out.paces.bands.some((b) => b.key === "threshold"));
  assert.ok(out.this_week, "the live engine prescribed a week");
  assert.ok(out.this_week.km > 0);

  // the ladder ends on race week and starts on this week's own prescription.
  assert.equal(out.weeks[0].current, true);
  assert.equal(out.weeks[0].km, out.this_week.km);
  assert.equal(out.weeks.at(-1).kind, "race");

  // the ring: seven days, the squat day flagged heavy-lower, the Sunday ride seen.
  assert.equal(out.leg_map.length, 7);
  const monday = out.leg_map.find((d) => d.day_number === 1);
  assert.equal(monday.strength.heavy_lower, true);
  assert.equal(monday.hard, true);
  assert.deepEqual(out.strength.heavy_lower_days, ["Monday"]);
  assert.match(out.strength.principle, /Heavy lower once a week/);
  assert.ok(out.ride, "four Sunday rides in six weeks is a habit");
  assert.equal(out.ride.weekday, "Sunday");
  assert.match(out.ride.label, /ride|MTB/i);
  assert.equal(out.ride.weeks_seen, 4);
  assert.ok(out.leg_map.find((d) => d.day_number === 7).ride);
  assert.ok(out.ride.placement.length > 20);

  // the review: closed weeks only, volume words, longest recent run.
  assert.equal(out.review.weeks.length, 4);
  assert.ok(out.review.weeks.every((w) => w.km > 0));
  assert.equal(out.review.longest_recent_km, 13);
  assert.match(out.why, /Cambridge Half/);
  assert.match(out.why, /1:45:00/);
  // No score, no verdict vocabulary anywhere the athlete reads.
  for (const s of [out.why, out.strength.principle, out.ride.placement]) {
    assert.doesNotMatch(s, /\b(score|grade|must|failing)\b/i);
  }
});

test("the ladder walks on from the live engine's week, not from a step above it", () => {
  seedRaceProfile("sub-1:45");
  seedHybridRunner();
  const out = raceBuild(TODAY);
  assert.equal(out.available, true, out.reason);
  assert.ok(out.this_week, "the live engine prescribed a week");
  assert.equal(out.weeks[0].km, out.this_week.km, "this week is the engine's own prescription");
  assert.equal(out.weeks[0].long_km, out.this_week.long_km);
  const goal = { is_race: true, date: RACE, distance_km: HALF, target: "sub-1:45" };
  // This week's log (28.5 km) sits short of its prescription, so the week is not yet
  // in the bank: week two is one ramp step off the prescription, not the engine's
  // next week (which would anchor on the partial log).
  assert.ok(out.this_week.km > 28.5, `fixture assumption: prescription ${out.this_week.km} exceeds the log`);
  const next = raceRamp(goal, out.weeks[1].week_start, out.weeks[0].km, out.weeks[0].long_km);
  assert.equal(out.weeks[1].km, next.required_km, "week two is one ramp step off the week the athlete is running");
  const third = raceRamp(goal, out.weeks[2].week_start, out.weeks[1].km, out.weeks[1].long_km);
  assert.equal(out.weeks[2].km, third.required_km, "week three is one ramp step off week two");

  // Once the log reaches the prescription the week is banked, and week two is the
  // engine's OWN next-week prescription (a recovery week it already knows about lands
  // on the ladder as the number the run list will show).
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: TODAY });
  const banked = raceBuild(TODAY);
  const nextPlan = repo.weeklyRunPlan(banked.weeks[1].week_start);
  const nextKm = Math.round(nextPlan.runs.reduce((s, r) => s + (Number(r.target_distance_km) || 0), 0) * 10) / 10;
  assert.ok(nextKm > 0);
  assert.equal(banked.weeks[1].km, nextKm, "week two is the engine's next-week prescription");
});

test("mid-week, the ladder never collapses to the partial log: Tuesday with one short run", () => {
  // The engine sizes a week off the Mon–Sun before it, so asked about next Monday on
  // a Tuesday it anchors on the one short run so far. The ladder used to walk from
  // that rung (9 km after a 32 km week); it steps off this week's prescription.
  seedRaceProfile("sub-1:45");
  seedHybridRunner();
  const tuesday = "2026-09-15";
  repo.addActivity({ type: "run", duration_min: 25, distance_km: 4, date: tuesday });
  const out = raceBuild(tuesday);
  assert.equal(out.available, true, out.reason);
  assert.ok(out.weeks[0].km > 20, `this week is the prescription, got ${out.weeks[0].km}`);
  assert.ok(
    // Next week may be the ramp's own down week (0.75×), rounded to one decimal.
    out.weeks[1].km >= Math.floor(0.75 * out.weeks[0].km * 10) / 10,
    `rung two ${out.weeks[1].km} collapsed below this week's ${out.weeks[0].km}`
  );
});

test("training paces follow current fitness when the target is beyond it; the target stays the race band", () => {
  seedRaceProfile("1:30"); // far beyond a ~1:49 estimate
  seedHybridRunner({ rideWeeks: [] });
  repo.upsertGarminDailyMetric({ date: daysBefore(TODAY, 2), race_predict_half_sec: 6540 });
  const out = raceBuild(TODAY);
  assert.equal(out.prediction.fit, "beyond_horizon");
  assert.equal(out.paces.anchored_on, "estimate");
  const fromEstimate = paceBandsFor(out.prediction.estimate_pace_sec_per_km, HALF);
  const threshold = out.paces.bands.find((b) => b.key === "threshold");
  assert.equal(threshold.text, fromEstimate.find((b) => b.key === "threshold").text);
  assert.equal(out.paces.bands.find((b) => b.key === "race").fast_sec_per_km, Math.round(5400 / HALF));
  assert.doesNotMatch(out.why, /distance itself/);

  // An estimate already faster than the target never speeds training past the goal.
  resetAll();
  seedRaceProfile("2:10");
  seedHybridRunner({ rideWeeks: [] });
  repo.upsertGarminDailyMetric({ date: daysBefore(TODAY, 2), race_predict_half_sec: 6540 });
  const easy = raceBuild(TODAY);
  assert.equal(easy.paces.anchored_on, "target");
  const fromTarget = paceBandsFor(easy.paces.race_pace_sec_per_km, HALF);
  assert.equal(easy.paces.bands.find((b) => b.key === "threshold").text, fromTarget.find((b) => b.key === "threshold").text);
});

test("raceBuild falls back to a conservative Riegel off the best recent run when the watch has no predictor", () => {
  seedRaceProfile("1:50");
  seedHybridRunner({ rideWeeks: [] });
  const out = raceBuild(TODAY);
  assert.equal(out.available, true);
  assert.equal(out.prediction.basis, "recent_run_riegel");
  // The best recent run is the 7.5 km at 5:36 /km → Riegel to 21.1 km.
  const expected = 42 * 60 * (HALF / 7.5) ** 1.06;
  assert.ok(Math.abs(out.prediction.estimate_sec - expected) < 2);
  assert.equal(out.prediction.trend, null);
  assert.match(out.prediction.basis_detail, /conservative/);
  assert.equal(out.ride, null, "no rides logged, no ride pattern invented");
});

test("a stale watch predictor is not a current one — the build reads off the runs instead", () => {
  seedRaceProfile("sub-1:45");
  seedHybridRunner({ rideWeeks: [] });
  repo.upsertGarminDailyMetric({ date: daysBefore(TODAY, 40), race_predict_half_sec: 6000 });
  const out = raceBuild(TODAY);
  assert.equal(out.prediction.basis, "recent_run_riegel");
});

test("the ride pattern reads the rides that load the legs, not the light commutes", () => {
  seedRaceProfile("sub-1:45");
  seedHybridRunner({ rideWeeks: [] });
  // Four short e-bike commutes on Wednesdays outnumber three Saturday trail rides.
  for (const wk of [0, 1, 2, 3]) {
    repo.addActivity({ type: "ride", raw_text: "e-bike commute", duration_min: 20, distance_km: 6, date: daysBefore(TODAY, wk * 7 + 4) });
  }
  for (const wk of [0, 1, 3]) {
    repo.addActivity({ type: "ride", raw_text: "MTB trail ride", duration_min: 110, distance_km: 25, date: daysBefore(TODAY, wk * 7 + 1) });
  }
  const out = raceBuild(TODAY);
  assert.ok(out.ride, "three trail rides in six weeks is a habit");
  assert.equal(out.ride.weekday, "Saturday");
  assert.notEqual(out.ride.typical_load, "light");
});

test("a ride the day before the long run gets the easy-spinning sentence", () => {
  seedRaceProfile("sub-1:45");
  seedHybridRunner({ rideWeeks: [] });
  // Rides on Fridays for four of six weeks; the engine's long run lands on Saturday.
  for (const wk of [0, 1, 2, 4]) {
    repo.addActivity({ type: "ride", raw_text: "MTB trail ride", duration_min: 90, distance_km: 20, date: daysBefore(TODAY, wk * 7 + 2) });
  }
  const out = raceBuild(TODAY);
  assert.equal(out.ride.weekday, "Friday");
  const longDay = out.leg_map.find((d) => d.run?.kind === "long")?.day_number;
  if (longDay === 6) assert.match(out.ride.placement, /day before the long run/);
  else assert.ok(out.ride.placement.length > 0);
});

test("the surfaces carry the read: REST route registered, MCP tool present, coach context key projected", async () => {
  const { PROMPT_CONTEXT_SITES } = await import("../dist/prompt/context-projection.js");
  assert.ok(PROMPT_CONTEXT_SITES.coach.keys.includes("race_build"), "the plan-shaping site sees the build");
  assert.ok(PROMPT_CONTEXT_SITES.week_compose.keys.includes("race_build"));
  const { renderRunPlan } = await import("../dist/prompt/shared.js");
  seedRaceProfile("sub-1:45");
  seedHybridRunner({ rideWeeks: [] });
  const build = raceBuild(TODAY);
  const text = renderRunPlan({ race_build: build, run_plan: null });
  assert.match(text, /RACE BUILD \(Cambridge Half/);
  assert.match(text, /Target: 1:45:00/);
  assert.match(text, /Pace bands/);
  assert.match(text, /Ladder:/);
});

// ---------------------------------------------------------------------------
// the empty "Easy" plan day
// ---------------------------------------------------------------------------

test("a restructure's undeclared empty day is stored as rest, never as a startable training day", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185 }],
    },
    { day_number: 2, name: "Easy", focus: "Easy day", items: [] },
    { day_number: 3, name: "Scaffold", day_type: "training", items: [] },
  ]);
  assert.equal(repo.getPlanDay(1).day_type, "training");
  assert.equal(repo.getPlanDay(2).day_type, "rest", "an empty day nobody called training is a rest day");
  assert.equal(repo.getPlanDay(2).items.length, 0);
  assert.equal(repo.getPlanDay(3).day_type, "training", "an explicit training scaffold is left as the athlete said");
});
