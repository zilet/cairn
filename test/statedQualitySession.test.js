// The STATED quality session (`endurance_schedule.quality`): the athlete says what the
// quality day is ("hard threshold 5k, plus a few km around it") and the run engine runs
// that type instead of its phase rotation — warm-up + work + cool-down, inside the week
// and the athlete's demonstrated running, held below the stated work (and saying so) when
// the week cannot carry it yet. Every protective rule still decides WHETHER quality runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { statedQualitySession, weeklyRunPlan } from "../dist/repo/run-progression.js";
import { flexibleTrainingAgenda } from "../dist/repo/flexible-training-agenda.js";
import { registerTrainingStatusTools } from "../dist/surfaces/mcp/training-status.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";

const MONDAY = "2026-04-20";
const THURSDAY = "2026-04-23";
const RACE = "2026-05-17";

// Milos's own run week: Sunday long, Tuesday easy, Thursday quality, Saturday MTB.
const DAYS = [
  { dow: 0, kind: "long" },
  { dow: 2, kind: "easy" },
  { dow: 4, kind: "quality" },
];
const CROSS = [{ dow: 6, sport: "ride" }];
const NOTE =
  "Tuesday easy, Thursday hills/quality, Sunday long run. Saturday optional (MTB or other) — never a planned run.";
const THRESHOLD_5K = { type: "threshold", work_km: 5 };

const before = (n) => new Date(Date.parse(`${MONDAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

// The watch reading a run as threshold work — the agenda's own quality grading.
function gradeQuality(activityId, date) {
  const source = db
    .prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin', ?)`)
    .run(`sq-${activityId}`);
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, te_label, aerobic_te)
     VALUES (?, ?, ?, ?, 'running', 'LACTATE_THRESHOLD', 3.6)`
  ).run(source.lastInsertRowid, `sq-run-${activityId}`, activityId, date);
}

// Ten steady weeks: a long run, an easy run and a mid-week run. `qualityKm` makes the
// mid-week run a quality-graded session of that length.
function seedRunner({ qualityKm = null, longKm = 13.5, easyKm = 9 } = {}) {
  for (let wk = 0; wk < 10; wk++) {
    repo.addActivity({
      type: "run",
      duration_min: Math.round(longKm * 6),
      distance_km: longKm,
      date: before(wk * 7 + 1),
    });
    repo.addActivity({
      type: "run",
      duration_min: Math.round(easyKm * 6),
      distance_km: easyKm,
      date: before(wk * 7 + 5),
    });
    const date = before(wk * 7 + 3);
    const km = qualityKm ?? 9;
    const created = repo.addActivity({ type: "run", duration_min: Math.round(km * 5.5), distance_km: km, date });
    const id = Number(created?.id ?? created?.lastInsertRowid ?? created);
    if (qualityKm != null && Number.isFinite(id)) gradeQuality(id, date);
  }
}

function milos(quality = THRESHOLD_5K) {
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
      days: DAYS,
      cross_training: CROSS,
      ...(quality ? { quality } : {}),
      note: NOTE,
      source: "athlete",
    },
  });
}

const qualityRun = (plan) => plan.runs.find((r) => r.kind_label === "quality");

// ---------------------------------------------------------------------------
// The preference itself
// ---------------------------------------------------------------------------

test("normalization keeps a stated session, reads close words, clamps km and drops garbage", () => {
  assert.deepEqual(repo.normalizeStatedQuality({ type: "threshold", work_km: 5 }), { type: "threshold", work_km: 5 });
  assert.equal(repo.normalizeStatedQuality("cruise intervals").type, "threshold");
  assert.equal(repo.normalizeStatedQuality({ type: "Hills" }).type, "hills");
  assert.equal(repo.normalizeStatedQuality({ type: "800s" }).type, "vo2");
  assert.deepEqual(
    repo.normalizeStatedQuality({ type: "tempo", work_km: 40, warm_up_km: 9, cool_down_km: -1 }),
    { type: "tempo", work_km: 15, warm_up_km: 5 },
    "work clamps to 15, warm-up to 5, a negative cool-down is dropped"
  );
  assert.deepEqual(
    repo.normalizeStatedQuality({ type: "threshold", work_km: "lots", warm_up_km: 0 }),
    { type: "threshold", warm_up_km: 0 },
    "an unreadable work_km is dropped, an explicit 0 km warm-up is kept"
  );
  assert.equal(repo.normalizeStatedQuality({ type: "fartlek-ish" }), null, "an unknown type is no preference");
  assert.equal(repo.normalizeStatedQuality(null), null);

  // Inside the schedule: a garbage preference never voids the run days beside it.
  const schedule = repo.normalizeEnduranceSchedule({ days: DAYS, quality: { type: "zzz" } });
  assert.equal(schedule.days.length, 3);
  assert.equal(schedule.quality, undefined);
  const kept = repo.normalizeEnduranceSchedule({ days: DAYS, quality: THRESHOLD_5K });
  assert.deepEqual(kept.quality, THRESHOLD_5K);
});

test("a run-day-only update keeps the stated session; quality: null clears it; a quality-only update keeps the week", () => {
  milos();
  assert.deepEqual(repo.getEnduranceSchedule().quality, THRESHOLD_5K);

  // Restating the run week (no quality key) keeps it — the same law as cross_training.
  repo.setProfile({ endurance_schedule: { days: DAYS, source: "athlete" } });
  assert.deepEqual(repo.getEnduranceSchedule().quality, THRESHOLD_5K, "run days restated: the session stays");
  assert.deepEqual(repo.getEnduranceSchedule().cross_training, [{ dow: 6, sport: "ride", optional: true }]);

  // An unreadable quality beside the days: the days land, the stored session stands.
  repo.setProfile({ endurance_schedule: { days: DAYS, quality: { type: "zzz" }, source: "athlete" } });
  assert.deepEqual(repo.getEnduranceSchedule().quality, THRESHOLD_5K);

  // A quality-only update changes the session alone.
  repo.setProfile({ endurance_schedule: { quality: { type: "tempo", work_km: 6, warm_up_km: 1.5 } } });
  const patched = repo.getEnduranceSchedule();
  assert.deepEqual(patched.quality, { type: "tempo", work_km: 6, warm_up_km: 1.5 });
  assert.deepEqual(
    patched.days,
    DAYS.slice().sort((a, b) => a.dow - b.dow),
    "the run week stands"
  );
  assert.equal(patched.cross_training.length, 1, "the cross-training day stands");

  // Garbage quality-only: nothing changes.
  repo.setProfile({ endurance_schedule: { quality: "not a session" } });
  assert.equal(repo.getEnduranceSchedule().quality.type, "tempo");

  // The explicit clear.
  repo.setProfile({ endurance_schedule: { quality: null } });
  const cleared = repo.getEnduranceSchedule();
  assert.equal(cleared.quality, undefined);
  assert.equal(cleared.days.length, 3, "clearing the session never clears the run week");
});

test("set_endurance_schedule and get_endurance_schedule carry the session; days omitted with quality changes only it", async () => {
  const tools = new Map();
  registerTrainingStatusTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const call = async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);

  await call("set_endurance_schedule", { days: DAYS, cross_training: CROSS, note: NOTE, quality: THRESHOLD_5K });
  let read = await call("get_endurance_schedule", {});
  assert.deepEqual(read.quality, THRESHOLD_5K);
  assert.equal(read.note, NOTE);

  // Run days resent without quality: kept.
  await call("set_endurance_schedule", { days: DAYS, note: NOTE });
  read = await call("get_endurance_schedule", {});
  assert.deepEqual(read.quality, THRESHOLD_5K);

  // Quality alone (no days): the run week, cross days and note stand.
  await call("set_endurance_schedule", {
    quality: { type: "threshold", work_km: 6, warm_up_km: 2.5, cool_down_km: 1.5 },
  });
  read = await call("get_endurance_schedule", {});
  assert.equal(read.quality.work_km, 6);
  assert.equal(read.days.length, 3);
  assert.equal(read.cross_training.length, 1);
  assert.equal(read.note, NOTE);

  const refused = await call("set_endurance_schedule", { quality: { type: "zzz" } });
  assert.equal(refused.ok, false);
  assert.equal((await call("get_endurance_schedule", {})).quality.work_km, 6, "a refused session changes nothing");

  await call("set_endurance_schedule", { quality: null });
  read = await call("get_endurance_schedule", {});
  assert.equal(read.quality, undefined);
  assert.equal(read.days.length, 3);
});

test("chat can state the session alone, beside the days, or clear it", () => {
  milos(null);
  assert.equal(repo.getEnduranceSchedule().quality, undefined);

  const action = normalizeChatAction({ type: "set_endurance_schedule", quality: { type: "threshold", work_km: 5 } });
  assert.deepEqual(action, { type: "set_endurance_schedule", quality: { type: "threshold", work_km: 5 } });
  const applied = applyChatActions(
    { actions: [action] },
    { agent: "stub", message: "I already agreed and put in the plan hard threshold 5k for Thursday as quality" }
  );
  assert.equal(applied.applied[0]?.error, undefined);
  const stored = repo.getEnduranceSchedule();
  assert.deepEqual(stored.quality, THRESHOLD_5K);
  assert.equal(stored.days.length, 3, "the stated run week stands");
  assert.equal(stored.cross_training.length, 1);

  // Days without quality: the session stays.
  applyChatActions(
    { actions: [{ type: "set_endurance_schedule", days: DAYS }] },
    { agent: "stub", message: "Tue easy, Thu quality, Sun long" }
  );
  assert.deepEqual(repo.getEnduranceSchedule().quality, THRESHOLD_5K);

  // A garbage-only quality action is no action.
  assert.equal(normalizeChatAction({ type: "set_endurance_schedule", quality: { type: "??" } }), null);

  applyChatActions(
    { actions: [{ type: "set_endurance_schedule", quality: null }] },
    { agent: "stub", message: "let the coach pick" }
  );
  assert.equal(repo.getEnduranceSchedule().quality, undefined);
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

test("the stated threshold 5 km replaces the phase rotation: warm-up + 5 km + cool-down, the total as the distance", () => {
  milos();
  seedRunner({ qualityKm: 9 });
  const plan = weeklyRunPlan(MONDAY, { adjustToday: false });
  const q = qualityRun(plan);
  assert.ok(q, "the week carries its quality session");
  assert.equal(q.day_number, 4, "on the stated Thursday");
  assert.equal(q.label, "Threshold run");
  assert.ok(q.stated_quality, "the run is the athlete's stated session");
  const sq = q.stated_quality;
  assert.equal(sq.type, "threshold");
  assert.equal(sq.form, "continuous", "5 km of threshold runs continuous");
  assert.equal(sq.stated_work_km, 5);
  assert.equal(sq.work_km, 5, "the full stated work fits this week");
  assert.equal(sq.warm_up_km, 2);
  assert.equal(sq.cool_down_km, 2);
  assert.equal(sq.total_km, 9);
  assert.equal(q.target_distance_km, 9, "the run's distance is the whole session");
  assert.equal(sq.held, null);
  assert.equal(sq.warm_cool_default, true);
  assert.match(q.note, /2 km easy, then 5 km continuous at .*threshold effort.*2 km easy — 9 km in all/);
  assert.match(plan.mix_summary, /1 threshold/);
  const why = plan.rationale.join(" ");
  assert.match(why, /5 km of threshold with 2 km easy either side \(9 km in all\)/);
  assert.match(why, /2 km easy either side|2 km each side/, "the default warm-up/cool-down is said");
  assert.doesNotMatch(why, /Rotating in/, "no rotation sentence");
  // The quality km sit inside the week like any quality session.
  const total = plan.runs.reduce((s, r) => s + (r.target_distance_km ?? 0), 0);
  assert.ok(total <= Number(plan.why.match(/~(\d+) km/)[1]) + 1, "the prescribed week is the week's own total");
});

test("stated warm-up and cool-down are used as said", () => {
  milos({ type: "threshold", work_km: 5, warm_up_km: 3, cool_down_km: 1 });
  seedRunner({ qualityKm: 9 });
  const sq = qualityRun(weeklyRunPlan(MONDAY, { adjustToday: false })).stated_quality;
  assert.equal(sq.warm_up_km, 3);
  assert.equal(sq.cool_down_km, 1);
  assert.equal(sq.total_km, 9);
  assert.equal(sq.warm_cool_default, false);
});

test("no hard session on record: the stated work opens below it and the plan says so", () => {
  milos();
  seedRunner(); // no quality-graded runs at all
  const plan = weeklyRunPlan(MONDAY, { adjustToday: false });
  const sq = qualityRun(plan).stated_quality;
  assert.equal(sq.type, "threshold", "the stated type still runs");
  assert.ok(sq.work_km < 5, `held below the stated 5 km, got ${sq.work_km}`);
  assert.equal(sq.held?.reason, "first");
  assert.match(sq.held.line, /5 km/);
  assert.match(sq.held.line, new RegExp(`${sq.work_km} km`));
  assert.ok(plan.rationale.includes(sq.held.line), "the hold is said in the week's rationale");
});

test("past one step beyond the longest hard session on record, the work is held and the reason named", () => {
  milos({ type: "threshold", work_km: 8 });
  seedRunner({ qualityKm: 7 });
  const plan = weeklyRunPlan(MONDAY, { adjustToday: false });
  const sq = qualityRun(plan).stated_quality;
  assert.ok(sq.total_km <= 7 * 1.15 + 0.05, `total ${sq.total_km} stays within a step of the 7 km shown`);
  assert.ok(sq.work_km < 8);
  assert.equal(sq.held?.reason, "capacity");
  assert.match(sq.held.line, /8 km/);
});

test("a week too small for the whole session holds the work so it fits inside the week, and says so", () => {
  milos();
  seedRunner({ qualityKm: 9, longKm: 4, easyKm: 4 });
  const plan = weeklyRunPlan(MONDAY, { adjustToday: false });
  const q = qualityRun(plan);
  assert.ok(q, "a quality session still runs");
  const sq = q.stated_quality;
  assert.ok(sq.work_km < 5, `held below 5 km, got ${sq.work_km}`);
  assert.equal(sq.held?.reason, "room");
  assert.match(sq.held.line, /5 km/);
  const weekKm = Number(plan.why.match(/~(\d+) km/)[1]);
  assert.ok(
    sq.total_km <= weekKm * 0.4 + 0.05,
    `the session (${sq.total_km}) stays within its share of the ~${weekKm} km week`
  );
});

test("past 6 km of threshold work the session becomes cruise intervals", () => {
  milos({ type: "threshold", work_km: 8, warm_up_km: 1, cool_down_km: 1 });
  seedRunner({ qualityKm: 12 });
  const q = qualityRun(weeklyRunPlan(MONDAY, { adjustToday: false }));
  const sq = q.stated_quality;
  assert.equal(sq.work_km, 8, "the week carries the full 8 km");
  assert.equal(sq.form, "intervals");
  assert.equal(q.label, "Threshold intervals");
  assert.deepEqual(q.interval, [{ reps: 4, on: "2km", off: "90s jog", zone: "Z4" }]);
  assert.equal(sq.total_km, 10);
});

// The spike brake (a trimmed week), injected the way the run engine's own tests do.
const SPIKE = {
  programState: { endurance: { sport: "run", longest_km_4wk: 13.5, has_quality: true, status: "spiking" } },
  recovery: { delta: {}, baseline: {}, recovery: {}, quality: {} },
  adjustToday: false,
};

test("a trimmed week keeps the stated TYPE as the short set — never the rotation — and says so", () => {
  milos();
  seedRunner({ qualityKm: 9 });
  const plan = weeklyRunPlan(MONDAY, SPIKE);
  const q = qualityRun(plan);
  assert.ok(q, "the trimmed week keeps a quality day");
  assert.equal(q.dose, "short");
  assert.equal(q.label, "Short threshold", "the stated type, not the phase rotation's intervals");
  assert.equal(q.stated_quality.dose, "short");
  assert.ok(q.stated_quality.work_km < 5);
  assert.equal(q.stated_quality.held?.reason, "short");
  assert.match(q.stated_quality.held.line, /morning/);
  assert.match(plan.mix_summary, /1 short threshold/);
});

test("a recovery week still drops quality, stated session or not", () => {
  milos();
  seedRunner({ qualityKm: 9 });
  const plan = weeklyRunPlan(MONDAY, {
    programState: {
      endurance: { sport: "run", longest_km_4wk: 13.5, has_quality: true, status: "maintaining" },
      mesocycle: { phase: "deload" },
      recovery_week: { state: "applied" },
    },
    recovery: { delta: {}, baseline: {}, recovery: {}, quality: {} },
    adjustToday: false,
  });
  assert.equal(qualityRun(plan), undefined);
  assert.ok(!plan.runs.some((r) => r.stated_quality));
});

test("race week keeps the engine's own touch; the stated session is training", () => {
  milos();
  seedRunner({ qualityKm: 9 });
  const plan = weeklyRunPlan("2026-05-11", { adjustToday: false });
  assert.ok(!plan.runs.some((r) => r.stated_quality), "no stated session in race week");
});

test("without a stated session the engine keeps its rotation", () => {
  milos(null);
  seedRunner({ qualityKm: 9 });
  const q = qualityRun(weeklyRunPlan(MONDAY, { adjustToday: false }));
  assert.ok(q);
  assert.equal(q.stated_quality, undefined);
});

test("the rolling agenda and the day detail carry the same session, its parts in km", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-21T12:00:00") });
  milos();
  seedRunner({ qualityKm: 9 });
  const agenda = flexibleTrainingAgenda("2026-04-21");
  const intent = agenda.intents.find((i) => i.kind === "quality");
  assert.ok(intent);
  assert.equal(intent.label, "Threshold run");
  assert.equal(intent.target_distance_km, 9);

  const read = dayDetail(THURSDAY);
  assert.ok(read?.run, "Thursday holds the quality run");
  const run = read.run;
  assert.equal(run.kind, "quality");
  assert.ok(run.stated, "the day says it is the athlete's stated session");
  assert.equal(run.stated.source, "stated");
  assert.equal(run.stated.type, "threshold");
  assert.equal(run.stated.total_km, 9);
  assert.equal(run.stated.held, null);
  assert.deepEqual(
    run.structure.map((s) => [s.part, s.km]),
    [
      ["warm_up", 2],
      ["main", 5],
      ["cool_down", 2],
    ]
  );
  const main = run.structure[1];
  assert.equal(main.label, "Threshold");
  assert.equal(main.zone, "Z4");
  assert.match(main.text, /5 km continuous at threshold/);
  assert.equal(run.km, 9);
  assert.equal(run.pace?.key ?? "threshold", "threshold", "a pace band, when there is one, is the threshold band");
  assert.match(run.point, /session you chose|as you set it|The session is yours/);
});

test("the day detail carries the hold-below sentence when the week holds the work", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-21T12:00:00") });
  milos();
  seedRunner(); // nothing hard on record
  const read = dayDetail(THURSDAY);
  assert.ok(read?.run?.stated);
  assert.ok(read.run.stated.held, "the hold is carried");
  assert.match(read.run.stated.held, /5 km/);
  assert.ok(read.run.point.includes(read.run.stated.held));
  assert.equal(read.run.structure[1].km, read.run.stated.work_km);
});

// ---------------------------------------------------------------------------
// Review fixes (2026-10-06)
// ---------------------------------------------------------------------------

const NO_ZONES = { available: false, zones: [] };
const sized = (stated, over = {}) =>
  statedQualitySession({
    stated,
    phase: "build",
    dose: "full",
    zones: NO_ZONES,
    hrModel: null,
    ceilingKm: null,
    capacityKm: null,
    firstInAWhile: false,
    date: THURSDAY,
    ...over,
  });

test("when even the floor (2 km work, 1 km easy either side) runs past a ceiling, no stated session runs", () => {
  const room = sized(THRESHOLD_5K, { ceilingKm: 3 });
  assert.equal(room.unfit, true);
  assert.equal(room.reason, "room");
  assert.ok(room.line && /threshold/.test(room.line), room.line);
  const capacity = sized(THRESHOLD_5K, { capacityKm: 3.5, ceilingKm: 20 });
  assert.equal(capacity.unfit, true);
  assert.equal(capacity.reason, "capacity");
  // A floor that just fits still runs, held.
  const fits = sized(THRESHOLD_5K, { ceilingKm: 4 });
  assert.ok(!fits.unfit);
  assert.ok(fits.stated.total_km <= 4.05, `total ${fits.stated.total_km}`);
});

test("VO2's three-rep minimum is part of the floor, so rounding never adds work past the ceiling", () => {
  // Three 800s are 2.4 km: with 1 km easy either side the floor is 4.4 km.
  const tight = sized({ type: "vo2", work_km: 4 }, { ceilingKm: 4 });
  assert.equal(tight.unfit, true, JSON.stringify(tight.stated ?? tight));
  assert.equal(tight.reason, "room");
  for (const [stated, ceilingKm] of [
    [{ type: "vo2", work_km: 4 }, 4.6],
    [{ type: "vo2", work_km: 2 }, 4.4],
    [{ type: "vo2" }, 5.3],
  ]) {
    const fit = sized(stated, { ceilingKm });
    assert.ok(!fit.unfit, `${JSON.stringify(stated)} in ${ceilingKm}`);
    assert.ok(fit.stated.total_km <= ceilingKm + 0.05, `total ${fit.stated.total_km} within ${ceilingKm}`);
    assert.ok(fit.interval[0].reps >= 3);
    assert.equal(fit.stated.work_km, Math.round(fit.interval[0].reps * 0.8 * 10) / 10);
  }
});

test("when even the floor is past the hard running on record, the engine's own quality session runs and says so", () => {
  milos();
  // Quality-graded runs of 3 km: one step past them (3.45 km) cannot hold even the
  // stated floor of 2 km work with 1 km easy either side.
  seedRunner({ qualityKm: 3 });
  const plan = weeklyRunPlan(MONDAY, { adjustToday: false });
  const q = qualityRun(plan);
  assert.ok(q, "the week still has its quality day");
  assert.equal(q.stated_quality ?? null, null, "never a stated session past what the legs have shown");
  assert.ok(
    plan.rationale.some((line) => /threshold/.test(line) && /(step past|hard running on record)/.test(line)),
    plan.rationale.join(" | ")
  );
});

test("MCP set_endurance_schedule: cross_training or a note without days never clears the run week", async () => {
  const tools = new Map();
  registerTrainingStatusTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  const call = async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);
  await call("set_endurance_schedule", { days: DAYS, cross_training: CROSS, note: NOTE, quality: THRESHOLD_5K });

  await call("set_endurance_schedule", { cross_training: [{ dow: 3, sport: "swim" }] });
  let read = await call("get_endurance_schedule", {});
  assert.equal(read.days.length, 3, "the run week stands");
  assert.deepEqual(
    read.cross_training.map((c) => [c.dow, c.sport]),
    [[3, "swim"]]
  );
  assert.deepEqual(read.quality, THRESHOLD_5K);
  assert.equal(read.note, NOTE);

  await call("set_endurance_schedule", { note: "Thursday is hills now" });
  read = await call("get_endurance_schedule", {});
  assert.equal(read.days.length, 3);
  assert.equal(read.note, "Thursday is hills now");
  assert.equal(read.cross_training.length, 1);

  await call("set_endurance_schedule", { cross_training: [], quality: { type: "tempo" } });
  read = await call("get_endurance_schedule", {});
  assert.equal(read.days.length, 3);
  assert.equal(read.cross_training?.length ?? 0, 0, "[] clears the cross-training days only");
  assert.equal(read.quality.type, "tempo");

  // Only a call that states nothing (or days: null) clears it.
  await call("set_endurance_schedule", {});
  assert.equal(await call("get_endurance_schedule", {}), null);
  await call("set_endurance_schedule", { days: DAYS });
  await call("set_endurance_schedule", { days: null, note: "x" });
  assert.equal(await call("get_endurance_schedule", {}), null);
});

test("chat and REST already keep the schedule when no days are said", () => {
  milos();
  const { applied } = applyChatActions(
    { actions: [{ type: "set_endurance_schedule", note: "just a note" }] },
    { agent: "stub", message: "just a note", recentAthleteMessages: [], priorAssistant: { message: "" } }
  );
  assert.ok(applied.every((a) => !a.result || a.result.endurance_schedule !== null));
  assert.equal(repo.getEnduranceSchedule().days.length, 3, "chat: a note alone is not a clear");
  repo.setProfile({ endurance_schedule: { note: "only a note" } });
  assert.equal(repo.getEnduranceSchedule().days.length, 3, "REST/profile: an unusable shape keeps what is stored");
});
