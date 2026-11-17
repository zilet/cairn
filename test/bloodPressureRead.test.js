// A blood-pressure reading is read with the whole picture, and one reading is a snapshot:
//   - one occasion says "one reading", repeated occasions say so, and neither is spoken
//     as a standing condition until a home series settles the level;
//   - weight loss and aerobic training are named as the expected cause of a lower reading,
//     and a low reading that repeats, agrees and is explained that way is the person's
//     level: no watch note at all;
//   - the person's own symptom words (never a "no dizziness" note) make it worth raising;
//   - a single HIGH reading earns the repeat-it note, not the lifestyle levers;
//   - a phase's start body fat and a lift's "now" each read their one definition.
// Every fixture is synthetic: invented dates and values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo } from "./_seed.js";
import { bloodPressureRead, namesLowPressureSymptom } from "../dist/repo/blood-pressure-read.js";

const bp = (ago, systolic, diastolic) =>
  repo.addBloodPressureReading({ measured_at: localDaysAgo(ago), systolic, diastolic });
const weigh = (ago, lb) => db.prepare("INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)").run(localDaysAgo(ago), lb);
const bpDirectives = () =>
  repo.listActiveDirectives().filter((d) => /Diastolic|Systolic/.test(String(d.marker || "")));

test("one low reading is a snapshot: said as one reading, with how to repeat it", () => {
  bp(120, 122, 76);
  bp(5, 101, 55);
  const dia = repo.prioritizeMarkers().markers.find((m) => m.name === "Diastolic BP");
  assert.equal(dia.reading_note, "one reading so far");
  repo.deriveDirectives();
  const rows = bpDirectives();
  assert.equal(rows.length, 1, "one note, no lever");
  assert.match(rows[0].directive, /101\/55/);
  assert.match(rows[0].directive, /One reading is a snapshot, not your level/);
  assert.match(rows[0].directive, /two a minute apart, morning and evening, for three to seven days/);
  assert.match(rows[0].directive, /no reason to cut salt or add cardio/);
});

test("two low readings a month apart with nothing to explain them suggest a level without settling it", () => {
  bp(140, 125, 75);
  bp(35, 99, 58);
  bp(6, 101, 55);
  const dia = repo.prioritizeMarkers().markers.find((m) => m.name === "Diastolic BP");
  assert.equal(dia.reading_note, "two single readings so far");
  assert.equal(dia.reading_expected, undefined);
  repo.deriveDirectives();
  const row = bpDirectives().find((d) => d.domain === "watch");
  assert.match(row.directive, /99\/58 and 101\/55/);
  assert.match(row.directive, /they do not settle it/);
  assert.match(row.directive, /three to seven days/);
  assert.doesNotMatch(row.directive, /worth raising with your doctor/);
});

test("low readings that repeat, agree and fit weight loss are the person's level: no watch note, a calm marker row", () => {
  bp(140, 125, 75);
  weigh(140, 200);
  weigh(1, 186);
  bp(35, 99, 58);
  bp(6, 101, 55);
  const dia = repo.prioritizeMarkers().markers.find((m) => m.name === "Diastolic BP");
  assert.equal(dia.reading_expected, true);
  assert.equal(dia.reading_note, "expected while losing weight");
  repo.deriveDirectives();
  assert.equal(bpDirectives().length, 0, "nothing to watch, repeat or change");
});

test("a trained picture explains a repeated low reading, and says so in the read", () => {
  const ctx = {
    weight_change_lb: null,
    aerobic_sessions_28d: 10,
    in_cut: false,
    symptoms: [],
    blood: [],
    medication: null,
    resting_hr: 52,
  };
  const input = {
    component: "diastolic",
    band: [60, 80],
    today: "2026-03-20",
    points: [
      { date: "2026-03-02", value: 55 },
      { date: "2026-03-18", value: 56 },
    ],
    pair: [
      { date: "2026-03-02", value: 101 },
      { date: "2026-03-18", value: 101 },
    ],
  };
  const read = bloodPressureRead({ ...input, context: () => ctx });
  assert.equal(read.expected, true);
  assert.equal(read.note, "expected with your training");
  assert.match(read.line, /101\/55 and 101\/56/);
  assert.match(read.line, /regular aerobic training and a resting heart rate near 52/);
  assert.match(read.line, /Nothing to treat, repeat or change/);
  assert.doesNotMatch(read.line, /three to seven days/);

  // A low resting heart rate beside some aerobic work counts as trained too.
  assert.equal(bloodPressureRead({ ...input, context: () => ({ ...ctx, aerobic_sessions_28d: 5 }) }).expected, true);
  // Anything arguing against it keeps the ordinary read.
  const not = (over, points = input.points, pair = input.pair) =>
    bloodPressureRead({ ...input, points, pair, context: () => ({ ...ctx, ...over }) });
  assert.equal(not({ symptoms: [{ date: "2026-03-17", text: "dizzy on standing" }] }).expected, false);
  assert.equal(not({ blood: ["Hemoglobin"] }).expected, false);
  assert.equal(not({ medication: "a blood-pressure medication" }).expected, false);
  assert.equal(not({ aerobic_sessions_28d: 0, resting_hr: null }).expected, false, "nothing explains it");
  assert.equal(not({}, [input.points[1]]).expected, false, "one reading is still a snapshot");
  assert.match(not({}, [input.points[1]]).line, /One more reading on another day is enough/);
  assert.equal(
    not({}, [{ date: "2026-03-02", value: 58 }, { date: "2026-03-18", value: 46 }]).expected,
    false,
    "under the floor, and still falling"
  );
  assert.equal(
    not({}, input.points, [{ date: "2026-03-02", value: 86 }, { date: "2026-03-18", value: 86 }]).expected,
    false,
    "a systolic under 90 is never called expected"
  );
});

test("the person's own symptom words make a low reading worth raising; a denial does not", () => {
  assert.equal(namesLowPressureSymptom("felt dizzy standing up after squats"), true);
  assert.equal(namesLowPressureSymptom("no dizziness, felt fine"), false);
  bp(4, 96, 54);
  repo.addCheckin(localDaysAgo(2), { energy: 3, note: "lightheaded when I stood up this morning" });
  repo.deriveDirectives();
  const row = bpDirectives().find((d) => d.domain === "watch");
  assert.match(row.directive, /you noted "lightheaded when I stood up this morning"/);
  assert.match(row.directive, /worth raising with your doctor/);
  assert.doesNotMatch(row.directive, /usually nothing to treat/);
});

test("a single high reading earns the repeat-it note, never the lifestyle levers", () => {
  bp(200, 118, 76);
  bp(3, 142, 88);
  repo.deriveDirectives();
  const rows = bpDirectives();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((d) => d.domain === "watch"), "no DASH or cardio lever off one reading");
  assert.match(rows[0].directive, /One reading is a snapshot/);
});

test("repeated high readings keep the levers", () => {
  bp(40, 138, 86);
  bp(3, 142, 88);
  repo.deriveDirectives();
  assert.ok(bpDirectives().some((d) => d.domain === "nutrition" && /DASH/.test(d.directive)));
});

test("a home series settles the level: no protocol line, no 'one reading'", () => {
  const read = bloodPressureRead({
    component: "diastolic",
    band: [60, 80],
    today: "2026-03-20",
    points: [
      { date: "2026-03-14", value: 56 },
      { date: "2026-03-16", value: 57 },
      { date: "2026-03-18", value: 55 },
    ],
    pair: [{ date: "2026-03-18", value: 102 }],
  });
  assert.equal(read.settled, true);
  assert.equal(read.basis, "repeated");
  assert.match(read.line, /Your recent readings sit on the low side \(latest 102\/55\)/);
  assert.doesNotMatch(read.line, /To settle it/);
  assert.equal(
    bloodPressureRead({ component: "diastolic", band: [60, 80], points: [{ date: "2026-03-18", value: 70 }] }),
    null,
    "inside the band there is nothing to say"
  );
});

test("a phase's start body fat is the estimate as of its start date, with the stored value kept for the record", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 176 });
  weigh(62, 195);
  weigh(1, 176);
  repo.addBodyMeasurement(localDaysAgo(62), { waist_in: 40, neck_in: 16 }, null, "test");
  repo.createJourneyPhase({ kind: "cut", start_date: localDaysAgo(60), start_bodyfat_pct: 15.8, status: "active" });
  const phase = repo.listJourneyPhases("active")[0];
  assert.equal(phase.start_bodyfat_stored_pct, 15.8);
  assert.ok(phase.start_bodyfat_pct > 20, `the tape-era estimate, not the stored 15.8 (${phase.start_bodyfat_pct})`);
  assert.ok(phase.start_bodyfat.low <= phase.start_bodyfat_pct && phase.start_bodyfat_pct <= phase.start_bodyfat.high);
  assert.equal(phase.start_bodyfat.measured, true);
});

test("with nothing measured, the start is still estimated from height, weight and age", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 190 });
  weigh(30, 190);
  repo.createJourneyPhase({ kind: "cut", start_date: localDaysAgo(20), start_bodyfat_pct: null, status: "active" });
  const phase = repo.listJourneyPhases("active")[0];
  assert.equal(phase.start_bodyfat_stored_pct, null);
  assert.ok(Number.isFinite(phase.start_bodyfat_pct), "an estimate, not a blank");
  assert.equal(phase.start_bodyfat.measured, false);
});

test("a lift's capacity reads the best of its latest three sessions, so a light day is not lost capacity", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  const log = (ago, weight, reps) =>
    repo.logSetByName({ exercise: "Barbell Bench Press", weight, reps, rir: 2, date: localDaysAgo(ago) });
  log(12, 185, 6);
  log(8, 195, 6);
  log(2, 135, 8); // a deliberate light technique day, the latest session
  const bench = repo.currentLiftCapacities().find((c) => /bench/i.test(c.exercise));
  assert.ok(bench, "the bench is benchmarked");
  const heavy = Math.round(195 * (1 + 6 / 30));
  assert.ok(Math.abs(bench.est_1rm - heavy) <= 1, `reads the 195 x 6 day (${bench.est_1rm}), not the light day`);
});
