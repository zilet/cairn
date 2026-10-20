// The whole-week load read (src/repo/week-training-load.ts, "week" stream 2026-10-04).
//
// The live week of 2026-09-28 (test/_liveWeekFixture.js) plus the lifting week — Mon
// Lower A, Tue Upper, Wed Lower B, Thu Push, Fri Pull — and a kayak on the Monday. One
// read has to hold the whole week: which run closed which intention (Friday's moved
// "Hill Sprints" is the quality run, Wednesday's social run an extra), the Saturday ride
// and the kayak with their load bands, each lift day's leg/upper split, the key-run
// spacing, the Saturday cross-training day, and the next 48 hours in one plain line.
// And it has to do that by ASKING the reads that own each answer, never re-deriving one.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repo } from "./_seed.js";
import { NEXT_48H_LINES, weekTrainingLoad } from "../dist/repo/week-training-load.js";
import { pickDayVariant } from "../dist/repo/brain/day-read-rules.js";
import {
  FRI,
  SAT,
  SUN,
  TUE,
  WED,
  WEEK,
  activity,
  resetLiveWeekTables,
  seedHistory,
  seedLiveWeek,
  seedProfile,
} from "./_liveWeekFixture.js";

const MON = WEEK;
const THU = "2026-10-01";

beforeEach(resetLiveWeekTables);

const LIFT_DAYS = [
  [
    MON,
    [
      ["Back Squat", "quads"],
      ["Romanian Deadlift", "hamstrings"],
    ],
  ],
  [
    TUE,
    [
      ["Bench Press", "chest"],
      ["Barbell Row", "back"],
    ],
  ],
  [
    WED,
    [
      ["Leg Press", "quads"],
      ["Hip Thrust", "glutes"],
    ],
  ],
  [
    THU,
    [
      ["Overhead Press", "shoulders"],
      ["Incline Dumbbell Press", "chest"],
    ],
  ],
  [
    FRI,
    [
      ["Pull-up", "back"],
      ["Biceps Curl", "biceps"],
    ],
  ],
];

function seedLifting() {
  for (const [date, lifts] of LIFT_DAYS) {
    for (const [name, group] of lifts) {
      repo.upsertExercise({ name, muscle_group: group });
      for (let set = 1; set <= 4; set++)
        repo.logSetByName({ date, exercise: name, weight: 135, reps: 8, rir: 2, set_number: set, day_number: null });
    }
  }
}

function seedWeek(opts) {
  seedProfile();
  seedHistory();
  const ids = seedLiveWeek(opts);
  seedLifting();
  const kayak = activity(MON, { type: "kayaking_v2", min: 60 });
  return { ...ids, kayak };
}

const day = (read, date) => read.days.find((d) => d.date === date);

test("the live week reads whole: runs by the intention they closed, every sport, the lifting split", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-04T20:00:00Z") });
  const ids = seedWeek();
  const read = weekTrainingLoad(SUN);

  assert.equal(read.window_start, MON);
  assert.equal(read.window_end, SUN);
  assert.equal(read.days.length, 7);

  // Runs: the moved quality session closed quality, the social run is an extra.
  assert.equal(day(read, FRI).runs[0].closed, "quality");
  assert.equal(day(read, FRI).runs[0].activity_id, ids.fri.id);
  assert.equal(day(read, FRI).runs[0].title, "Hill Sprints");
  assert.equal(day(read, SUN).runs[0].closed, "long");
  assert.equal(day(read, TUE).runs[0].closed, "easy");
  assert.equal(day(read, TUE).runs[0].basis, "stated_easy", "the agenda's own grading rides through");
  assert.equal(day(read, WED).runs[0].closed, null, "Wednesday's social run is an extra");

  // Cross-training: the Saturday ride and the Monday kayak, each with a real load.
  const satRide = day(read, SAT).cross.find((c) => c.family === "ride");
  assert.ok(satRide, "Saturday carries the ride");
  assert.ok(["moderate", "heavy"].includes(satRide.load), `ride load ${satRide.load}`);
  assert.equal(satRide.minutes, 142);
  const kayak = day(read, MON).cross.find((c) => c.family === "paddle");
  assert.ok(kayak, "the kayak is a paddle, not dropped");
  assert.ok(["light", "moderate", "heavy"].includes(kayak.load));
  assert.equal(kayak.minutes, 60);
  assert.ok(
    read.days.every((d) => d.cross.every((c) => c.family !== "run")),
    "runs never double as cross"
  );

  // The ISO week's totals.
  assert.ok(Math.abs(read.week.run_km - 35.8) < 0.05, `run_km ${read.week.run_km}`);
  assert.ok(read.week.cross_minutes_by_family.ride >= 142);
  assert.ok(read.week.cross_minutes_by_family.paddle >= 60);
  assert.equal(read.week.strength_sessions, 5);
  assert.ok(read.week.loading_days >= read.week.hard_days);
  assert.equal(read.week.extras_count, 1);
  assert.ok(read.week.intents.some((i) => i.kind === "quality" && i.status === "completed" && i.date === FRI));
  assert.equal(read.week.intents.find((i) => i.kind === "quality").planned_weekday, "Thursday");

  // The lifting: lower days load the legs, the upper days the upper body.
  for (const date of [MON, WED]) assert.notEqual(day(read, date).strength?.legs, "none", `${date} legs`);
  for (const date of [TUE, THU, FRI]) {
    assert.notEqual(day(read, date).strength?.upper, "none", `${date} upper`);
    assert.equal(day(read, date).strength?.legs, "none", `${date} leaves the legs alone`);
  }
  assert.equal(day(read, SAT).strength, null);
  assert.ok(["easy", "moderate", "hard"].includes(day(read, MON).strength.load));
  assert.notEqual(day(read, SAT).day_load, "none", "the ride is a training day");

  // Spacing, and the cross-training day.
  assert.deepEqual(read.spacing.key_runs, [
    { kind: "quality", date: FRI },
    { kind: "long", date: SUN },
  ]);
  assert.equal(read.spacing.min_gap_days, 2);
  assert.equal(read.cross_training_day?.weekday, "Saturday");
  assert.equal(read.cross_training_day?.sport_family, "ride");
});

// The Saturday read before the long run, seeded exactly as the live week: Tuesday's
// 9.68 km easy run on the stated easy weekday is the easy run, so the long slot is still
// open on Saturday evening (flexible-training-agenda heldForOwnDay).
function seedSaturday() {
  seedProfile();
  seedHistory();
  seedLiveWeek({ withSunday: false });
  seedLifting();
}

test("from Saturday, the next 48 hours name the long run the legs carry the ride into", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-03T20:00:00Z") });
  seedSaturday();
  const read = weekTrainingLoad(SAT);
  assert.deepEqual(read.next_48h.dates, [SUN, "2026-10-05"]);
  const sunday = read.next_48h.planned.find((p) => p.date === SUN);
  assert.equal(sunday.run_kind, "long", "the long run keeps Sunday");
  assert.notEqual(read.next_48h.implication_code, "clear");
  assert.notEqual(read.next_48h.legs, "fresh");

  // The line is one of its own variant set, filled in, with no numbers.
  const set = NEXT_48H_LINES[read.next_48h.implication_code];
  const escapeRe = (text) => text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  const pattern = (template) =>
    new RegExp(
      `^${template
        .split(/\{\w+\}/)
        .map(escapeRe)
        .join(".+?")}$`
    );
  assert.ok(
    set.some((template) => pattern(template).test(read.next_48h.line)),
    read.next_48h.line
  );
  assert.doesNotMatch(read.next_48h.line, /\d/);
  assert.match(read.next_48h.line, /Sunday/);
  // A variant set, rotated by day: two neighbouring dates speak differently.
  const a = pickDayVariant(set, SAT, `week_load:${read.next_48h.implication_code}`);
  const b = pickDayVariant(set, SUN, `week_load:${read.next_48h.implication_code}`);
  assert.notEqual(a, b);
  for (const lines of Object.values(NEXT_48H_LINES)) assert.ok(lines.length >= 3, "every code rotates");
});

// The next 48 hours never decide which run is still open: that is the agenda's answer,
// whatever it is, so the two can never disagree about Sunday.
test("the next 48 hours read the week's openings off the agenda, never a second matcher", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-03T20:00:00Z") });
  seedWeek({ withSunday: false });
  const read = weekTrainingLoad(SAT);
  const agenda = repo.flexibleTrainingAgenda(SAT);
  const openSunday = agenda.intents.find((i) => i.status === "open" && i.suggested_date === SUN)?.kind ?? null;
  assert.equal(openSunday, "long", "Tuesday's easy run never closes Sunday's long run early");
  assert.equal(read.next_48h.planned.find((p) => p.date === SUN).run_kind, openSunday);
  for (const intent of agenda.intents) {
    const mirrored = read.week.intents.find((i) => i.kind === intent.kind && i.status === intent.status);
    assert.ok(mirrored, `${intent.kind} mirrored`);
    assert.equal(mirrored.date, intent.completion?.date ?? intent.suggested_date ?? null);
  }
});

test("the read carries no scores and no internal magnitudes", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-04T20:00:00Z") });
  seedWeek();
  const text = JSON.stringify(weekTrainingLoad(SUN));
  assert.doesNotMatch(text, /"(?:score|residual|bar|heavy_ratio|deep|training_load|aerobic_te|anaerobic_te)"/);
});

test("an empty week reads empty, never throws", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-04T20:00:00Z") });
  const read = weekTrainingLoad(SUN);
  assert.equal(read.days.length, 7);
  assert.ok(read.days.every((d) => !d.runs.length && !d.cross.length && d.strength == null));
  assert.equal(read.week.run_km, 0);
  assert.equal(read.next_48h.implication_code, "clear");
  assert.equal(typeof read.next_48h.line, "string");
});

// No re-derivation: the read only ASKS the reads that own each answer.
test("week-training-load re-derives nothing: no SQL, no type regexes, no watch thresholds", () => {
  const src = readFileSync(new URL("../src/repo/week-training-load.ts", import.meta.url), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /from "\.\.\/db\.js"/, "no db import");
  assert.doesNotMatch(code, /\.prepare\(|\bSELECT\b/, "no SQL");
  assert.doesNotMatch(
    code,
    /te_label|aerobic_te|anaerobic_te|hr_zones|training_effect|\bZ[1-5]\b|avg_hr/,
    "no watch fields"
  );
  assert.doesNotMatch(code, /(?:kayak|paddl|ride|cycl|swim|hike|walk|ski)\w*\/[a-z]*\.test\(/i, "no type regexes");
  const imports = [...code.matchAll(/from "\.\/([\w./-]+)\.js"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, [
    "brain/day-read-rules",
    "cross-training-day",
    "endurance-sports",
    "exercise-canon",
    "exercises",
    "flexible-training-agenda",
    "hybrid-load",
    "plan-selection",
    "profile",
    "request-memo",
    "sessions",
    "shared",
    "training-read",
    "travel-days",
  ]);
});
