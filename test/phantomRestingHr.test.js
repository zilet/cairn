// A resting HR the day's own floor contradicts is not a reading — in the harm arms
// either (2026-10-06 diagnosis).
//
// On a day the watch was not worn overnight (no sleep, no HRV) Garmin posts a
// provisional daytime resting HR that can sit BELOW the same row's `min_hr` — live:
// 10-06 resting 60 beside a min 62, 10-02 58 vs 64, 10-03 59 vs 60. The recovery
// summary (coach.ts READING_TRUST) already withheld those as `contradicted`, so the run
// plan said resting HR was not up, while the harm ladder (read-adherence.ts) read the
// raw column and charged a resting-HR `physiology_brake` — which closed the push stance
// and kept Thursday's stated 5 km threshold short. The same phantom readings also
// inflated the band the athlete was compared against.
//
// One coherence test now serves both: `restingHrContradictedByFloor`
// (overnight-band.ts). Synthetic fixtures mirroring the live shapes; no real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import { harmEvidenceOnDay, nextMorningClean } from "../dist/repo/brain/read-adherence.js";
import { personalBand, restingHrContradictedByFloor } from "../dist/repo/overnight-band.js";
import { weeklyRunPlan } from "../dist/repo/run-progression.js";
import { insertStance } from "../dist/repo/training-drive.js";

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const RHR = [50, 51, 52, 53, 54]; // the athlete's ordinary worn nights, bpm
const HRV = [38, 41, 43, 45, 48]; // ms

// A worn night: a real sleep, HRV, and a resting HR just above the day's own floor.
const worn = (date, over = {}) => {
  const resting = over.resting_hr ?? 52;
  return { date, sleep_min: 420, hrv_ms: 43, resting_hr: resting, min_hr: resting - 2, ...over };
};
// The unworn day's provisional daytime estimate: no sleep, no HRV, a resting HR below
// the same row's own floor.
const phantom = (date, resting = 62, minHr = resting + 2) => ({ date, resting_hr: resting, min_hr: minHr });

// `n` coherent worn nights before `morning`, skipping any date in `skip`.
function ownNights(morning, n, skip = []) {
  const rows = [];
  for (let back = 1; back <= n; back++) {
    const date = addDays(morning, -back);
    if (skip.includes(date)) continue;
    rows.push(worn(date, { resting_hr: RHR[back % RHR.length], hrv_ms: HRV[back % HRV.length] }));
  }
  return rows;
}

const seed = (rows) => repo.upsertGarminDailyMetrics(rows);

// ── the pure rule ───────────────────────────────────────────────────────────────

test("the one coherence rule: below the floor or past max(5, 10%) above it contradicts; a missing floor cannot", () => {
  assert.equal(restingHrContradictedByFloor(60, 62), true, "live 10-06: below the day's own minimum");
  assert.equal(restingHrContradictedByFloor(58, 64), true, "live 10-02");
  assert.equal(restingHrContradictedByFloor(59, 60), true, "live 10-03");
  assert.equal(restingHrContradictedByFloor(68, 50), true, "live 08-03: eighteen above the floor");
  assert.equal(restingHrContradictedByFloor(52, 50), false, "the coherent signature");
  assert.equal(restingHrContradictedByFloor(50, 50), false, "at the floor is possible");
  assert.equal(restingHrContradictedByFloor(55, 50), false, "five above a floor of 50 is the edge");
  assert.equal(restingHrContradictedByFloor(56, 50), true);
  assert.equal(restingHrContradictedByFloor(77, 70), false, "the tolerance is relative: 10% of a 70 floor");
  assert.equal(restingHrContradictedByFloor(60, null), false, "no floor: nothing to argue with");
  assert.equal(restingHrContradictedByFloor(null, 62), false, "no reading: nothing to contradict");
  assert.equal(restingHrContradictedByFloor(Number.NaN, 62), false);
});

// ── the harm arm ────────────────────────────────────────────────────────────────

test("(a) an unworn morning's resting HR below its own min_hr is not a brake", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  seed([...ownNights(morning, 24), phantom(morning, 62, 64)]);
  const band = personalBand(RHR.concat(RHR, RHR, RHR), "resting_hr");
  assert.ok(62 > band.meaningful_line, "the phantom figure sits meaningfully past the athlete's own band");
  assert.equal(harmEvidenceOnDay(day), null, "a contradicted reading is not last night");
  assert.equal(nextMorningClean(day), false, "nor does it speak for the morning: silence never vouches");
});

test("(a') the same figure with no same-row floor is not contradicted, and still brakes", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  seed([...ownNights(morning, 24), { date: morning, resting_hr: 62 }]);
  const harm = harmEvidenceOnDay(day);
  assert.equal(harm?.kind, "physiology_brake", "a missing min_hr cannot contradict anything");
  assert.match(harm.detail, /^resting hr 62 above own band/);
});

test("(b) a coherent worn night with resting HR past the band still brakes", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  seed([...ownNights(morning, 24), worn(morning, { resting_hr: 60, min_hr: 58, sleep_min: 400, hrv_ms: null })]);
  const harm = harmEvidenceOnDay(day);
  assert.equal(harm?.kind, "physiology_brake");
  assert.match(harm.detail, /^resting hr 60 above own band/);
  assert.equal(harm.date, day);
});

test("(c) phantom readings never inflate the band a worn night is judged against", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  // Four unworn days mid-window at 66 beside a floor of 68.
  const phantomDates = [8, 9, 12, 13].map((n) => addDays(morning, -n));
  seed([
    ...ownNights(morning, 24, phantomDates),
    ...phantomDates.map((date) => phantom(date, 66, 68)),
    worn(morning, { resting_hr: 58, min_hr: 56, hrv_ms: null }),
  ]);
  const clean = db
    .prepare(
      `SELECT resting_hr FROM garmin_daily_metrics
        WHERE date < ? AND date >= ? AND sleep_min IS NOT NULL AND resting_hr IS NOT NULL`
    )
    .all(morning, addDays(morning, -31))
    .map((r) => Number(r.resting_hr));
  const withPhantoms = clean.concat(phantomDates.map(() => 66));
  const cleanBand = personalBand(clean, "resting_hr");
  const inflated = personalBand(withPhantoms, "resting_hr");
  assert.ok(58 > cleanBand.meaningful_line, `58 is a meaningful miss of the clean band (${cleanBand.meaningful_line})`);
  assert.ok(inflated.line > 58, `the phantom-inflated band (${inflated.line}) would have hidden it`);
  const harm = harmEvidenceOnDay(day);
  assert.equal(harm?.kind, "physiology_brake", "judged against the athlete's real nights only");
  assert.match(harm.detail, new RegExp(`above own band ${cleanBand.line.toFixed(1)} `));
});

// ── the live week ───────────────────────────────────────────────────────────────

const MONDAY = "2026-04-20";
const TUESDAY = "2026-04-21";
const RACE = "2026-05-17";
const before = (n) => addDays(MONDAY, -n);
const THRESHOLD_5K = { type: "threshold", work_km: 5 };

function ownerWeek() {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    endurance_goal: { mode: "race", event: "City Half", date: RACE, distance_km: 21.1, target: "1:55" },
    endurance_schedule: {
      days: [
        { dow: 0, kind: "long" },
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
      ],
      cross_training: [{ dow: 6, sport: "ride" }],
      quality: THRESHOLD_5K,
      source: "athlete",
    },
  });
}

function seedRunner() {
  for (let wk = 0; wk < 10; wk++) {
    repo.addActivity({ type: "run", duration_min: 81, distance_km: 13.5, date: before(wk * 7 + 1) });
    repo.addActivity({ type: "run", duration_min: 54, distance_km: 9, date: before(wk * 7 + 5) });
    repo.addActivity({ type: "run", duration_min: 50, distance_km: 9, date: before(wk * 7 + 3) });
  }
}

function openStance() {
  repo.setSettings({ training_drive: "push" });
  insertStance({
    since: before(10),
    until: "2026-05-15",
    scope: "date",
    words: "push through the block",
    previous_drive: "steady",
    set_via: "athlete",
  });
}

// The closed week spiked, so the volume is held and nothing hard is on record: only an
// open, harm-free stance runs the stated session whole.
const LIVE = {
  programState: { endurance: { sport: "run", longest_km_4wk: 15, has_quality: false, status: "spiking" } },
  recovery: { delta: {}, baseline: {}, recovery: {}, quality: {} },
  adjustToday: false,
};

// The live shape: unworn Friday and Saturday, a real HRV dip Sunday morning (charged to
// Saturday — outside Thursday's own window), a worn Monday, and an unworn Tuesday whose
// provisional resting HR sits below its own floor (it would be charged to Monday).
function liveNights({ floors = true } = {}) {
  const fri = before(3);
  const sat = before(2);
  const sun = before(1);
  const tue = TUESDAY;
  const unworn = [fri, sat, tue];
  const row = (date, resting, minHr) => (floors ? phantom(date, resting, minHr) : { date, resting_hr: resting });
  seed([
    ...ownNights(fri, 28, unworn),
    row(fri, 58, 64),
    row(sat, 59, 60),
    worn(sun, { hrv_ms: 30 }),
    worn(MONDAY, { hrv_ms: 45 }),
    row(tue, 62, 64),
  ]);
}

const qualityRun = (plan) => plan.runs.find((r) => r.kind_label === "quality");

test("(d) the live week: phantom resting HR on an unworn Tuesday leaves Thursday's stated 5 km whole", () => {
  ownerWeek();
  seedRunner();
  openStance();
  liveNights();
  const saturday = harmEvidenceOnDay(before(2));
  assert.equal(saturday?.kind, "physiology_brake", "Sunday morning's HRV dip is real harm, charged to Saturday");
  assert.match(saturday.detail, /^hrv /);
  assert.equal(harmEvidenceOnDay(MONDAY), null, "Tuesday's phantom resting HR charges nothing to Monday");
  const q = qualityRun(weeklyRunPlan(TUESDAY, LIVE));
  assert.ok(q?.stated_quality, "the stated session runs");
  const sq = q.stated_quality;
  assert.equal(sq.authoritative, true, "the stance is harm-free in Thursday's own window");
  assert.equal(sq.work_km, 5, `the full 5 km of threshold (${JSON.stringify(sq)})`);
  assert.equal(sq.held, null);
  assert.equal(sq.total_km, 9);
  assert.equal(q.dose, undefined, "not a short set");
});

test("(d') the same week with no same-row floors: the Tuesday reading stands and holds Thursday", () => {
  // The counterfactual that shows the floor test is what decides it: absent min_hr the
  // reading cannot be contradicted, so it brakes, as it did before the fix.
  ownerWeek();
  seedRunner();
  openStance();
  liveNights({ floors: false });
  assert.equal(harmEvidenceOnDay(MONDAY)?.kind, "physiology_brake");
  const sq = qualityRun(weeklyRunPlan(TUESDAY, LIVE)).stated_quality;
  assert.ok(!sq.authoritative, "harm in Thursday's own window closes the stance's authority");
  assert.ok(sq.work_km < 5, `held, got ${sq.work_km}`);
});
