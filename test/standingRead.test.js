// Where you stand, whole person (src/domain/training/standing-read.ts and standing/*):
//   - rows in a coach's order, each omitted when it has nothing honest to say;
//   - an empty picture says nothing at all;
//   - the movement and mobility reads (their own streams) render through injection;
//   - endurance never reads a race taper or recovery days as decline: those weeks are not
//     compared, and the row's direction comes from its lines;
//   - lower-is-better measures (resting heart rate, blood pressure) say the real direction;
//   - blood speaks in panel counts, never a lab value;
//   - every string passes the reading grammar and carries no score, percentile or level word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoDaysAgo, marker, repo, seedHealthDoc, seedWeight } from "./_seed.js";
import { standingRead, STANDING_DIRECTION_WORDS, STANDING_ORDER } from "../dist/domain/training/standing-read.js";
import { combineDirections } from "../dist/domain/training/standing/words.js";
import { countWords, relativeMoveWords } from "../dist/domain/training/standing/capacity.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { localDateISO } from "../dist/repo/shared.js";
import { dateWords } from "../dist/repo/display-words.js";

const LB = { distance: "km", weight: "lb" };
const KG = { distance: "mi", weight: "kg" };
const ISO = /\b\d{4}-\d{2}-\d{2}\b/;
const BANNED =
  /percentile|\belite\b|\bintermediate\b|\badvanced\b|\bbeginner\b|\bnovice\b|\/\s*100\b|\bscore|\bgrade|biological age|\brisk\b|\byou must\b|\bshould\b/i;
const MACHINE = new Set(["id", "key", "stone", "href", "direction"]);

/** Every athlete-facing string in the rows. */
function strings(rows) {
  const out = [];
  const walk = (v, k) => {
    if (MACHINE.has(k)) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, ""));
    else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(rows, "");
  return out;
}

function assertClean(rows) {
  for (const s of strings(rows)) {
    assert.equal(violatesReadingGrammar(s), null, `grammar: ${s}`);
    assert.doesNotMatch(s, ISO, `machine date: ${s}`);
    assert.doesNotMatch(s, BANNED, `score, level or gate word: ${s}`);
    assert.doesNotMatch(s, /—/, `em dash aside: ${s}`);
  }
  for (const r of rows) {
    assert.ok(r.words && r.words.trim(), `${r.key} has its sentence`);
    assert.ok(STANDING_ORDER.includes(r.key));
    if (r.direction) assert.ok(r.direction_words, `${r.key} names its direction`);
    for (const l of r.lines) if (l.direction) assert.ok(l.direction_words, `${r.key}/${l.id} names its direction`);
  }
}

const MOVEMENT = {
  available: true,
  lines: [
    {
      key: "squat",
      label: "Squat",
      lead_lift: "Back Squat",
      now_lb: 234.4,
      now_reps: null,
      direction: "better",
      change: 0.031,
      since: "2026-10-25",
      lifts_compared: 2,
    },
    {
      key: "hinge",
      label: "Hinge",
      lead_lift: "Deadlift",
      now_lb: 315,
      now_reps: null,
      direction: "holding",
      change: 0.004,
      since: "2026-10-25",
      lifts_compared: 1,
    },
    {
      key: "push",
      label: "Push",
      lead_lift: "Bench Press",
      now_lb: 205,
      now_reps: null,
      direction: "holding",
      change: 0,
      since: "2026-10-25",
      lifts_compared: 2,
    },
    {
      key: "press",
      label: "Overhead press",
      lead_lift: "Overhead Press",
      now_lb: 125,
      now_reps: null,
      direction: "holding",
      change: -0.006,
      since: "2026-10-25",
      lifts_compared: 1,
    },
    {
      key: "row",
      label: "Row",
      lead_lift: "Barbell Row",
      now_lb: 185,
      now_reps: null,
      direction: "holding",
      change: 0.008,
      since: "2026-10-25",
      lifts_compared: 2,
    },
    {
      key: "pull",
      label: "Pull",
      lead_lift: "Pull-Up",
      now_lb: null,
      now_reps: 10,
      direction: "worse",
      change: -0.05,
      since: "2026-10-25",
      lifts_compared: 1,
    },
    // Not trained: no lead lift, so no line.
    {
      key: "lunge",
      label: "Lunge",
      lead_lift: null,
      now_lb: null,
      now_reps: null,
      direction: null,
      change: null,
      since: null,
      lifts_compared: 0,
    },
  ],
};

const MOBILITY = {
  available: true,
  checks: [
    {
      id: "ankle_knee_to_wall:left",
      label: "Ankle, left",
      now_text: "9 cm",
      date: isoDaysAgo(3),
      direction: "better",
      move_words: "2 cm more than Sep 3",
    },
  ],
  practice_days_4wk: 6,
  invite: null,
};

const NO_MOBILITY = {
  available: false,
  checks: [],
  practice_days_4wk: 0,
  invite: "Four two-minute checks would let this row speak.",
};

test("an empty picture says nothing at all", () => {
  // The movement and mobility reads are their own streams' (an empty mobility read may
  // carry its own invite); here both say nothing, and neither does anything else.
  const quiet = {
    movement: { available: false, lines: [] },
    mobility: { available: false, checks: [], practice_days_4wk: 0, invite: null },
  };
  assert.deepEqual(standingRead(localDateISO(), LB, quiet), []);
});

test("the injected movement and mobility reads render in words, in the athlete's units", () => {
  const today = localDateISO();
  const rows = standingRead(today, LB, { movement: MOVEMENT, mobility: MOBILITY });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["strength", "mobility"]
  );
  const s = rows[0];
  assert.equal(s.stone, "strength");
  assert.equal(s.href, "/app/train/program");
  assert.equal(s.lines.length, 6, "an untrained movement has no line");
  assert.equal(s.words, "Four movements holding, squat building, pull slipping.");
  assert.equal(s.direction, "holding", "what most movements say");
  assert.equal(s.direction_words, "Holding");
  assert.equal(s.since_words, `since ${dateWords("2026-10-25", today)}`);
  const squat = s.lines.find((l) => l.id === "movement:squat");
  assert.equal(squat.now_text, "234 lb");
  assert.equal(squat.note, "led by Back Squat");
  assert.equal(squat.direction_words, "Building");
  assert.equal(squat.move_words, `up since ${dateWords("2026-10-25", today)}`, "a blended move says its direction, never a percent");
  const hinge = s.lines.find((l) => l.id === "movement:hinge");
  assert.match(hinge.move_words, /^level since /, "a move under the read's own threshold is level");
  const pull = s.lines.find((l) => l.id === "movement:pull");
  assert.equal(pull.now_text, "10 reps", "a bodyweight lead reads in reps");
  assert.equal(pull.direction_words, "Slipping");
  assert.match(pull.move_words, /^down since /);
  for (const l of s.lines) assert.doesNotMatch(l.move_words ?? "", /percent|%/, `no figure in a movement's move: ${l.move_words}`);

  const m = rows[1];
  assert.equal(m.stone, "recovery");
  assert.equal(m.href, null);
  assert.equal(m.words, "One check building. Mobility work on six days in the last four weeks.");
  assert.equal(m.lines[0].now_text, "9 cm");
  assert.match(m.lines[0].note, /^measured /);
  assertClean(rows);

  // A kilograms athlete reads kilograms.
  const kg = standingRead(today, KG, { movement: MOVEMENT, mobility: MOBILITY });
  assert.equal(kg[0].lines.find((l) => l.id === "movement:squat").now_text, "106.5 kg");
  assert.doesNotMatch(JSON.stringify(kg), /\d lb\b/);
});

test("a weighted or assisted bodyweight lead reads its set in words, never a percent of the plates", () => {
  const today = localDateISO();
  const line = (over) => ({
    key: "pull",
    label: "Pull",
    lead_lift: "Weighted Pull-Up",
    now_lb: null,
    now_reps: null,
    now_added_lb: null,
    now_added_reps: null,
    direction: null,
    change: null,
    since: null,
    lifts_compared: 0,
    ...over,
  });
  const pullOf = (l, units = LB) =>
    standingRead(today, units, { movement: { available: true, lines: [l] }, mobility: null }).find((r) => r.key === "strength")
      .lines[0];

  const weighted = pullOf(line({ now_added_lb: 25, now_added_reps: 6, direction: "better", change: 0.079, since: "2026-10-25" }));
  assert.equal(weighted.now_text, "bodyweight + 25 lb for 6");
  assert.match(weighted.move_words, /^up since /, "the move is the effective load's, said as a direction");
  assert.equal(pullOf(line({ now_added_lb: 25, now_added_reps: 6 }), KG).now_text, "bodyweight + 11.5 kg for 6");

  // All assisted: the line still appears, the assist said in words.
  const assisted = pullOf(line({ lead_lift: "Assisted Pull-Up", now_added_lb: -25, now_added_reps: 8 }));
  assert.equal(assisted.now_text, "25 lb of assist for 8");
  assert.equal(assisted.note, "led by Assisted Pull-Up");
  assertClean(standingRead(today, LB, { movement: { available: true, lines: [line({ now_added_lb: -25, now_added_reps: 8 })] }, mobility: null }));
});

test("mobility with nothing measured still appears with its invite", () => {
  const rows = standingRead(localDateISO(), LB, { movement: { available: false, lines: [] }, mobility: NO_MOBILITY });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["mobility"]
  );
  assert.equal(rows[0].words, "Nothing measured yet.");
  assert.equal(rows[0].invite, NO_MOBILITY.invite);
  assert.deepEqual(rows[0].lines, []);
  assert.equal(rows[0].direction, null);
  assert.equal(rows[0].since_words, null);
});

test("count words, the direction rule and the vocabulary table", () => {
  const L = (label, direction) => ({ label, direction });
  const noun = { one: "movement", many: "movements" };
  assert.equal(countWords([L("Squat", "better")], noun, { name: true }), "Squat building.");
  assert.equal(countWords([L("A", "holding"), L("B", "holding")], noun), "Both movements holding.");
  assert.equal(
    countWords([L("A", "holding"), L("B", "holding"), L("C", "holding")], noun),
    "All three movements holding."
  );
  assert.equal(countWords([L("A", null)], noun), "One movement read so far, too soon to call a direction.");
  assert.equal(combineDirections(["better", "worse"]), "holding", "a tie between up and down holds");
  assert.equal(combineDirections(["better", "holding"]), "better", "a move beside a level line is the news");
  assert.equal(combineDirections(["holding", "holding", "worse"]), "holding");
  assert.equal(combineDirections([null, null]), null);
  assert.equal(relativeMoveWords(null, "2026-10-25", "2026-11-22"), null);
  assert.equal(relativeMoveWords(0.009, "2026-10-25", "2026-11-22"), "level since Oct 25");
  assert.equal(relativeMoveWords(0.04, "2026-10-25", "2026-11-22"), "up since Oct 25");
  assert.equal(relativeMoveWords(-0.04, "2026-10-25", "2026-11-22"), "down since Oct 25");
  assert.equal(relativeMoveWords(-0.012, "2026-10-25", "2026-11-22"), "level since Oct 25", "inside the read's slide threshold");
  for (const c of [0.011, 0.2, -0.5, -0.016]) assert.doesNotMatch(relativeMoveWords(c, "2026-10-25", "2026-11-22"), /percent|%/);
  assert.deepEqual(STANDING_DIRECTION_WORDS, {
    capacity: { better: "Building", holding: "Holding", worse: "Slipping" },
    health: { better: "Improving", holding: "Steady", worse: "Drifting" },
  });
});

/** A whole picture: runs, the watch's predictor and VO2max, nights, labs, blood pressure, a body. */
function seedPicture() {
  const today = localDateISO();
  repo.setProfile({
    sex: "male",
    age: 40,
    height_in: 70,
    weight_lb: 176,
    // A half far ahead: its distance is what the watch's predictor is read at.
    endurance_goal: {
      mode: "race",
      event: "Spring Half",
      date: isoDaysAgo(-120),
      distance_km: 21.1,
      target: "sub-1:50",
    },
  });
  for (const d of [12, 8, 4, 1]) seedWeight(isoDaysAgo(d), 176 - d * 0.05);
  // Running: steady weeks, a little more lately; no race anywhere near.
  for (let d = 35; d >= 1; d -= 2)
    repo.addActivity({ type: "run", date: isoDaysAgo(d), duration_min: 50, distance_km: d < 7 ? 10 : 8 });
  // Nights: HRV level, resting HR five beats under the usual month lately; predictor and VO2max.
  for (let d = 29; d >= 0; d--) {
    repo.upsertGarminDailyMetric({
      date: isoDaysAgo(d),
      sleep_min: 430,
      hrv_ms: 60,
      resting_hr: d < 7 ? 50 : 55,
      ...(d === 29 ? { vo2max: 50, race_predict_half_sec: 6700 } : {}),
      ...(d === 1 ? { vo2max: 52, race_predict_half_sec: 6580 } : {}),
    });
  }
  // Labs: LDL back in range on the second draw, ApoB still above its band.
  seedHealthDoc(isoDaysAgo(200), [
    marker("LDL-C", 140, { unit: "mg/dL", flag: "high" }),
    marker("ApoB", 110, { unit: "mg/dL", flag: "high" }),
    marker("HDL-C", 61, { unit: "mg/dL" }),
  ]);
  seedHealthDoc(isoDaysAgo(40), [
    marker("LDL-C", 95, { unit: "mg/dL" }),
    marker("ApoB", 97, { unit: "mg/dL" }),
    marker("HDL-C", 63, { unit: "mg/dL" }),
  ]);
  // Blood pressure: high earlier, lower (still a touch high) in the last fortnight.
  for (const d of [80, 75, 70])
    repo.addBloodPressureReading({ measured_at: `${isoDaysAgo(d)}T07:30`, systolic: 138, diastolic: 88 });
  for (const d of [9, 5, 2])
    repo.addBloodPressureReading({ measured_at: `${isoDaysAgo(d)}T07:30`, systolic: 126, diastolic: 78 });
  return today;
}

test("a whole picture: every row in a coach's order, each with honest words", () => {
  const today = seedPicture();
  const path = {
    milestones: [{ date: "2026-12-22", end_date: "2026-12-26", kind: "checkup", label: "Checkup week", detail: null }],
  };
  const rows = standingRead(today, LB, { movement: MOVEMENT, mobility: MOBILITY, path });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["strength", "endurance", "mobility", "body", "blood", "pressure", "recovery"]
  );
  assertClean(rows);
  const row = (k) => rows.find((r) => r.key === k);

  const e = row("endurance");
  const pace = e.lines.find((l) => l.id === "endurance:race_pace");
  assert.ok(pace, "the watch's predictor speaks for race pace");
  assert.equal(pace.direction, "better");
  assert.match(pace.move_words, /^2 min faster since /);
  assert.match(pace.note, /^half marathon in about /);
  const vol = e.lines.find((l) => l.id === "endurance:weekly_distance");
  assert.ok(vol.direction, "a week with no race near it is compared");
  const vo2 = e.lines.find((l) => l.id === "endurance:vo2max");
  assert.equal(vo2.now_text, "VO2max 52");
  assert.equal(vo2.direction, "better");
  assert.match(vo2.move_words, /^up 2 since /);
  assert.equal(e.direction, "better");
  assert.equal(e.direction_words, "Building");

  const b = row("body");
  assert.match(b.lines[0].now_text, /^about \d+% fat$/);
  assert.match(b.lines[0].note, /^likely \d+ to \d+, estimated from height and weight$/);
  assert.ok(b.invite, "a body estimated from height and weight offers what would sharpen it");

  const blood = row("blood");
  const lipids = blood.lines.find((l) => l.id === "blood:lipids");
  assert.equal(lipids.label, "Lipids");
  assert.equal(lipids.now_text, "One to tighten");
  assert.equal(lipids.direction, "better", "LDL came back in range since the last draw");
  assert.match(lipids.move_words, /^one back in range since /);
  assert.equal(lipids.note, "drawn six weeks ago");
  assert.match(blood.words, /lipids with markers to tighten\. Next draw Dec 22–26\.$/i);
  // Never a lab value.
  const bloodText = strings([blood]).join(" | ");
  assert.doesNotMatch(bloodText, /\b(140|110|95|97|61|63)\b/, bloodText);
  assert.doesNotMatch(JSON.stringify(blood), /impact|distance|eta_weeks/);

  const p = row("pressure");
  assert.equal(p.lines[0].now_text, "126/78 mmHg", "the athlete's own reading, like a weigh-in");
  assert.equal(p.lines[0].direction, "better", "lower is better from the high side");
  assert.equal(p.lines[0].direction_words, "Improving");
  assert.equal(p.lines[0].move_words, "12 mmHg lower than your earlier readings");
  assert.match(p.words, /high side/);

  const r = row("recovery");
  const rhr = r.lines.find((l) => l.id === "recovery:rhr");
  assert.equal(rhr.now_text, "50 bpm");
  assert.equal(rhr.direction, "better", "a lower resting heart rate is better for the athlete");
  assert.equal(rhr.move_words, "5 bpm lower than your usual");
  const hrv = r.lines.find((l) => l.id === "recovery:hrv");
  assert.equal(hrv.now_text, "60 ms");
  assert.equal(hrv.move_words, "level with your usual");
  assert.equal(hrv.direction_words, "Steady");
  assert.doesNotMatch(JSON.stringify(r), /readiness/i, "never the readiness number");
});

test("a half marathon run five days ago: its week is not compared for volume, and the row reads from its lines", () => {
  const today = localDateISO();
  const race = isoDaysAgo(5);
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date: race, distance_km: 21.1, target: "sub-1:55" },
  });
  // Four weeks ago: a bigger training week than this one will be.
  for (const d of [34, 32, 30, 28])
    repo.addActivity({ type: "run", date: isoDaysAgo(d), duration_min: 70, distance_km: 12 });
  // The taper, the race, one easy shake-out since.
  for (const d of [12, 9]) repo.addActivity({ type: "run", date: isoDaysAgo(d), duration_min: 40, distance_km: 7 });
  repo.addActivity({ type: "run", date: race, duration_min: 112, distance_km: 21.1 });
  repo.addActivity({ type: "run", date: isoDaysAgo(2), duration_min: 25, distance_km: 4 });
  repo.upsertGarminDailyMetric({ date: isoDaysAgo(30), race_predict_half_sec: 6750 });
  repo.upsertGarminDailyMetric({ date: isoDaysAgo(1), race_predict_half_sec: 6640 });
  const rows = standingRead(today, LB, { movement: { available: false, lines: [] }, mobility: null });
  const e = rows.find((r) => r.key === "endurance");
  assert.ok(e, "the endurance row speaks");
  const vol = e.lines.find((l) => l.id === "endurance:weekly_distance");
  assert.equal(vol.direction, null, "a race week is never read as decline");
  assert.equal(vol.move_words, null);
  assert.match(vol.note, /race/);
  assert.equal(e.lines.find((l) => l.id === "endurance:race_pace").direction, "better");
  assert.equal(e.direction, "better", "the row's direction comes from its lines, not a taper");
  assert.match(e.words, /weekly distance set aside around the race/);
  assertClean(rows);
});
