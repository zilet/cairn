// A `trip` context event makes the plan week say he is away, and an OPTIONAL
// cross-training day inside it stands aside: no hard leg day on the ring, no "day before
// the long run" sentence, no projected cross day. Runs never move.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { raceBuild } from "../dist/repo/race-build.js";
import { travelDaysIn, travelOn } from "../dist/repo/travel-days.js";
import { weekTrainingLoad } from "../dist/repo/week-training-load.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { FRI, SAT, SUN, resetLiveWeekTables, seedHistory, seedLiveWeek, seedProfile } from "./_liveWeekFixture.js";

const SAT_RIDE = [{ dow: 6, sport: "ride", optional: true }];

beforeEach(resetLiveWeekTables);

function addTrip(start, end, { title = "Clearwater", location = "Clearwater, FL", archived = 0 } = {}) {
  db.prepare(
    `INSERT INTO context_events (kind, title, detail, start_date, end_date, meta_json, archived) VALUES ('trip', ?, '', ?, ?, ?, ?)`
  ).run(title, start, end, JSON.stringify({ location }), archived);
}

test("travelDaysIn names the dates inside a trip and ignores an archived one", () => {
  addTrip("2026-10-03", "2026-10-05");
  addTrip("2026-10-07", "2026-10-08", { title: "Old", archived: 1 });
  const days = travelDaysIn("2026-10-01", "2026-10-10");
  assert.deepEqual([...days.keys()], ["2026-10-03", "2026-10-04", "2026-10-05"]);
  assert.deepEqual(days.get("2026-10-04"), { title: "Clearwater", location: "Clearwater, FL" });
  assert.equal(travelOn("2026-10-06"), null);
  assert.equal(travelOn("2026-10-07"), null, "an archived trip is not a trip");
});

test("a stated optional Saturday ride inside a trip stands aside on the race build", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-04T20:00:00Z") });
  seedProfile({ crossTraining: SAT_RIDE });
  seedHistory();
  seedLiveWeek();
  const home = raceBuild(SUN);
  assert.equal(home.leg_map.find((d) => d.day_number === 6).ride, true, "baseline: the ride is on the ring");
  assert.match(home.ride.placement, /the day before the long run/);

  addTrip(SAT, SUN);
  const away = raceBuild(SUN);
  const saturday = away.leg_map.find((d) => d.day_number === 6);
  assert.equal(saturday.ride, false, "the ride does not reserve the date");
  assert.equal(saturday.hard, false, "and is not a hard leg day");
  assert.deepEqual(saturday.travel, { title: "Clearwater", location: "Clearwater, FL" });
  assert.deepEqual(away.ride.away, { title: "Clearwater", location: "Clearwater, FL" });
  assert.doesNotMatch(away.ride.placement, /day before the long run/);
  assert.match(away.ride.placement, /Clearwater/);
  // Runs stay on their stated days: the long run is still on Sunday, the trip day.
  const sunday = away.leg_map.find((d) => d.day_number === 7);
  assert.equal(sunday.run?.kind, home.leg_map.find((d) => d.day_number === 7).run?.kind);
  assert.deepEqual(sunday.travel, { title: "Clearwater", location: "Clearwater, FL" });
  assert.equal(away.leg_map.find((d) => d.day_number === 1).travel, null);
});

test("a trip on another weekday leaves the ride exactly as it was", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-04T20:00:00Z") });
  seedProfile({ crossTraining: SAT_RIDE });
  seedHistory();
  seedLiveWeek();
  const before = raceBuild(SUN);
  addTrip("2026-09-29", "2026-09-30");
  const after = raceBuild(SUN);
  assert.equal(after.ride.away, null);
  assert.equal(after.ride.placement, before.ride.placement);
  assert.equal(after.leg_map.find((d) => d.day_number === 6).ride, true);
});

test("the agenda drops the 'ride is in the legs' caveat when the optional day was a trip day", (t) => {
  // Read on Friday, before the optional Saturday ride: the agenda expects it to load the legs.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-02T07:00:00Z") });
  seedProfile({ crossTraining: SAT_RIDE });
  seedHistory();
  seedLiveWeek({ withSunday: false, withSaturday: false });
  const long = (agenda) => agenda.intents.find((i) => i.kind === "long");
  assert.match(long(repo.flexibleTrainingAgenda(FRI)).rationale, /in the legs/);

  addTrip(SAT, SUN);
  const away = long(repo.flexibleTrainingAgenda(FRI));
  assert.equal(away.suggested_date, SUN, "the long run keeps its stated day");
  assert.doesNotMatch(away.rationale, /in the legs/);
});

test("the next-48h projection does not lean on an optional day that falls in a trip", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-02T20:00:00Z") });
  seedProfile({ crossTraining: SAT_RIDE });
  seedHistory();
  seedLiveWeek();
  const sat = (load) => load.next_48h.planned.find((p) => p.date === SAT);
  assert.equal(sat(weekTrainingLoad(FRI)).cross_training, true, "baseline: Saturday is the ride day");
  addTrip(SAT, SUN);
  assert.equal(sat(weekTrainingLoad(FRI)).cross_training, false);
});

test("GET /plan/week cells carry travel for a date inside a trip, null otherwise", () => {
  const REF = "2026-04-20"; // a Monday
  repo.savePlanDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }], { day_type: "training" });
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }, { dow: 3 }, { dow: 5 }], source: "athlete", updated_at: REF } });
  addTrip("2026-04-22", "2026-04-23", { title: "Conference", location: "Austin" });
  const week = planWeek(REF);
  const byDate = Object.fromEntries(week.days.map((d) => [d.date, d.travel]));
  assert.deepEqual(byDate["2026-04-22"], { title: "Conference", location: "Austin" });
  assert.deepEqual(byDate["2026-04-23"], { title: "Conference", location: "Austin" });
  assert.equal(byDate["2026-04-21"], null);
  assert.equal(byDate["2026-04-24"], null);
});
