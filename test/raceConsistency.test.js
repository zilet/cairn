// Screens that agree, asks that close (wave 2, stream K), on the 2026-10-20 live shape:
// a half marathon Sun 2026-11-01, a Clearwater trip from Fri 10-23, the week's Lower on
// Friday in the race build's taper week.
//   1. The race countdown has ONE source (raceCountdown, src/repo/race-build.ts): counted
//      in days, so twelve days out never reads "1 wk out".
//   2. A plan day's focus follows the race build's leg trim (plan-day-focus.ts words it,
//      plan-day-trim.ts reads it — the stress budget's own code, never re-derived).
//   4. The trip-eve question: the evening before a lift day inside a trip, once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { raceBuild, raceCountdown } from "../dist/repo/race-build.js";
import { raceDays } from "../dist/domain/training/race-days.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { legTrimFocus, legTrimNote, legTrimPhrase } from "../dist/repo/plan-day-focus.js";
import { planDayLegTrimOn } from "../dist/repo/plan-day-trim.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import {
  answerBriefAsk,
  bodyweightTwin,
  briefAsks,
  easierTripChanges,
  easierTripMessage,
} from "../dist/domain/today/brief-asks.js";
import { tripEventOn } from "../dist/repo/travel-days.js";
import { expirePlanAdaptations, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { activePlanAdaptations, adaptationDecisionWords } from "../dist/repo/plan-adaptations.js";
import { receiptFromPlanAdaptation } from "../dist/repo/change-receipt.js";
import { runWithTimeZone } from "../dist/tz.js";
import { todayRouter } from "../dist/routes/today.js";
import { registerDayCoachTools } from "../dist/surfaces/mcp/day-coach.js";

const TUESDAY = "2026-10-20";
const THURSDAY = "2026-10-22";
const FRIDAY = "2026-10-23";
const SATURDAY = "2026-10-24";
const RACE_DAY = "2026-11-01";
const SCORE = /"(?:score|grade|percent|percentile|impact_score)"/i;
const ENGINE_WORDS = /\b(?:stress budget|envelope|rule_code|race_taper_legs|key_run_eve|snapshot)\b/i;

const LOWER = [
  { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 },
  { exercise: "Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 90 },
];

function seedRuns(asOf) {
  const before = (n) => new Date(Date.parse(`${asOf}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  for (let wk = 0; wk < 8; wk++) {
    for (const off of [2, 4, 6])
      repo.addActivity({ type: "run", duration_min: 50, distance_km: 8, date: before(wk * 7 + off) });
  }
}

/** The live shape: Lower is the week's only lift, stated for Friday; the race is Nov 1. */
function seedRaceWeek(t, now, { trip = true } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  repo.savePlanDay(1, "Lower", "Squat-led lower body.", LOWER);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Clearwater Half", date: RACE_DAY, distance_km: 21.1, target: "sub-1:50" },
    strength_schedule: { days: [{ dow: 5 }], source: "athlete", updated_at: "2026-10-01" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
      updated_at: "2026-10-01",
    },
  });
  seedRuns("2026-10-19");
  if (trip) repo.addContextEvent({ kind: "trip", title: "Clearwater", start_date: FRIDAY, end_date: "2026-11-02" });
}

// ---------- 1. one countdown ----------

test("the countdown counts days from the read date: twelve days out is never '1 wk out'", () => {
  const c = raceCountdown(TUESDAY, RACE_DAY);
  assert.deepEqual(
    { days: c.days, words: c.words, span: c.span, race_week: c.race_week },
    { days: 12, words: "12 days out", span: "12 days", race_week: false }
  );
  assert.equal(raceCountdown("2026-10-26", RACE_DAY).words, "Race week", "the race's own Mon–Sun week");
  assert.equal(raceCountdown("2026-10-31", RACE_DAY).words, "Tomorrow");
  assert.equal(raceCountdown(RACE_DAY, RACE_DAY).words, "Race day");
  assert.equal(raceCountdown(RACE_DAY, RACE_DAY).span, null);
  assert.equal(raceCountdown("2026-10-19", RACE_DAY).words, "13 days out");
  assert.equal(raceCountdown("2026-10-18", RACE_DAY).words, "2 wks out", "two weeks and more speak in whole weeks");
  assert.equal(raceCountdown("2026-10-11", RACE_DAY).span, "3 weeks");
  assert.equal(raceCountdown("2026-11-02", RACE_DAY).words, "Race run");
  // A row a day tells race week's days apart.
  assert.equal(raceCountdown("2026-10-27", RACE_DAY, { byDay: true }).words, "5 days out");
  assert.equal(raceCountdown("2026-10-12", RACE_DAY, { byDay: true }).words, "20 days out");
  assert.equal(raceCountdown(TUESDAY, null), null);
});

test("the race build, its ladder rows and the day-by-day countdown all print the one countdown", (t) => {
  seedRaceWeek(t, `${TUESDAY}T09:00:00`);
  const build = raceBuild(TUESDAY);
  assert.equal(build.available, true, build.reason);
  assert.equal(build.race.countdown.words, "12 days out");
  assert.equal(build.race.countdown.span, "12 days");
  const current = build.weeks.find((w) => w.current);
  assert.equal(current.kind, "taper", "the kind still follows the engine's calendar-week count");
  assert.equal(current.weeks_to_race, 1);
  assert.equal(current.countdown_words, "12 days out", "the row says days, not '1 wk out'");
  const raceWeek = build.weeks.find((w) => w.kind === "race");
  assert.equal(raceWeek.countdown_words, "Race week");
  assert.doesNotMatch(build.why, /\b1 weeks?\b/, "the build's sentence counts the same way");
  assert.match(build.why, /12 days/);

  const days = raceDays({ today: TUESDAY });
  assert.equal(days.available, true, days.reason);
  assert.equal(days.race.countdown.words, "12 days out");
  const rows = days.weeks.flatMap((w) => w.days);
  assert.equal(rows[0].out_words, "12 days out");
  assert.equal(rows.find((d) => d.date === "2026-10-31").out_words, "Tomorrow");
  assert.equal(rows.find((d) => d.date === RACE_DAY).out_words, "Race day");
  assert.equal(rows.find((d) => d.date === "2026-10-27").out_words, "5 days out", "a row a day counts its own days");

  // The day page's context speaks the same span for its own date.
  const friday = dayDetail(FRIDAY, { today: TUESDAY });
  assert.equal(friday.week.race.countdown.span, "9 days");
  assert.doesNotMatch(String(friday.why ?? ""), /\b1 week to\b/);
});

// ---------- 2. the focus follows the trim ----------

test("leg-trim words: appended beside the focus, never doubled, rotated by date, no engine words", () => {
  assert.equal(
    legTrimFocus("Squat-led lower body.", null, FRIDAY),
    "Squat-led lower body.",
    "no trim: exactly as stored"
  );
  assert.equal(legTrimFocus(null, null, FRIDAY), null);
  const taper = legTrimFocus("Squat-led lower body", "race_taper_legs", FRIDAY);
  assert.match(taper, /^Squat-led lower body\. /);
  assert.match(taper, /taper/i);
  assert.equal(legTrimFocus("Lighter legs for the taper.", "race_taper_legs", FRIDAY), "Lighter legs for the taper.");
  assert.match(legTrimFocus(null, "race_week_legs", FRIDAY), /race week/i);
  assert.match(legTrimFocus("Lower.", "key_run_eve", FRIDAY), /key run/i);
  assert.match(
    legTrimNote("Lower", "race_taper_legs", FRIDAY),
    /^Lower(, lighter — taper week\.| stays on, lighter for the taper\.)$/
  );
  assert.equal(legTrimNote("", "race_taper_legs", FRIDAY), null);
  assert.equal(legTrimPhrase("nonsense", FRIDAY), null);
  const seen = new Set();
  for (let d = 1; d <= 20; d++) seen.add(legTrimPhrase("race_taper_legs", `2026-10-${String(d).padStart(2, "0")}`));
  assert.ok(seen.size >= 2, "a variant set, not one literal");
  for (const line of seen) assert.doesNotMatch(line, ENGINE_WORDS);
});

test("Friday's Lower in taper week: its focus says the legs go lighter, its title stays the plan day's name", (t) => {
  seedRaceWeek(t, `${TUESDAY}T09:00:00`, { trip: false });
  assert.equal(
    planDayLegTrimOn(FRIDAY, 1, { today: TUESDAY }),
    "race_taper_legs",
    "the stress budget's own calendar trim"
  );
  assert.equal(planDayLegTrimOn("2026-10-16", 1, { today: TUESDAY }), null, "a day already lived carries no trim");
  const friday = dayDetail(FRIDAY, { today: TUESDAY });
  assert.equal(friday.lift?.title, "Lower");
  assert.equal(friday.lift.trim, "race_taper_legs");
  assert.match(friday.lift.focus, /^Squat-led lower body\./);
  assert.match(friday.lift.focus, /taper|lighter/i);
  assert.doesNotMatch(JSON.stringify(friday.lift), SCORE);
});

test("today's strength line carries the trim in its focus on the trimmed day, never in its title", (t) => {
  seedRaceWeek(t, `${FRIDAY}T08:00:00`, { trip: false });
  const line = todayStrengthLine(FRIDAY);
  assert.equal(line.title, "Lower");
  assert.equal(line.trim, "race_taper_legs");
  assert.match(line.focus, /taper|lighter/i);
  assert.doesNotMatch(line.text, /taper/i, "the one line keeps its own words");
});

// ---------- 4. the trip-eve question ----------

test("the evening before a lift day inside a trip, the Brief asks once — never in the morning, never without a trip", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const evening = briefAsks({ date: THURSDAY, now: new Date(`${THURSDAY}T18:30:00`) });
  assert.equal(evening.asks.length, 1);
  const [ask] = evening.asks;
  assert.equal(ask.kind, "trip_lift");
  assert.equal(ask.key, `trip_lift:${FRIDAY}`);
  assert.equal(ask.question, "Lifting on the trip?");
  assert.match(ask.detail, /Lower/);
  assert.match(ask.detail, /Clearwater/);
  assert.deepEqual(
    ask.answers.map((a) => a.key),
    ["yes", "easier", "skip"]
  );
  assert.doesNotMatch(JSON.stringify(evening), SCORE);
  assert.equal(
    briefAsks({ date: THURSDAY, now: new Date(`${THURSDAY}T09:00:00`) }).asks.length,
    0,
    "the evening's question"
  );
  assert.equal(
    briefAsks({ date: TUESDAY, now: new Date(`${TUESDAY}T19:00:00`) }).asks.length,
    0,
    "Wednesday is no lift day"
  );

  const yes = answerBriefAsk({ key: ask.key, answer: "yes", date: THURSDAY });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(tripEventOn(FRIDAY).lift_answers[FRIDAY], "yes", "remembered on the trip");
  assert.equal(briefAsks({ date: THURSDAY, now: new Date(`${THURSDAY}T20:00:00`) }).asks.length, 0, "asked once");
  assert.equal(
    answerBriefAsk({ key: ask.key, answer: "skip", date: THURSDAY }).ok,
    false,
    "an answered day stays answered"
  );
  assert.deepEqual(
    repo.getPlanDay(1).items.map((i) => i.exercise),
    LOWER.map((i) => i.exercise),
    "yes changes nothing"
  );
});

test("no trip on the day: no question", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`, { trip: false });
  assert.equal(briefAsks({ date: THURSDAY, now: new Date(`${THURSDAY}T18:30:00`) }).asks.length, 0);
});

test("'skip it' holds the trip day as rest through the calendar's own claim; the ring is untouched", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const result = answerBriefAsk({ key: `trip_lift:${FRIDAY}`, answer: "skip", date: THURSDAY });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.event_id > 0);
  const event = repo.listContextEvents({}).find((e) => Number(e.id) === result.event_id);
  assert.equal(event.start_date, FRIDAY);
  assert.equal(event.end_date, FRIDAY);
  assert.equal(event.meta.claims_day, true);
  assert.notEqual(event.meta.rest_trade, true, "not a rest trade: it never blocks one");
  assert.doesNotMatch(result.message, /\byou must\b|\bmissed\b/i, "never a gate, never a debt");
  assert.equal(tripEventOn(FRIDAY).lift_answers[FRIDAY], "skip");
  assert.equal(briefAsks({ date: THURSDAY, now: new Date(`${THURSDAY}T21:00:00`) }).asks.length, 0);
  assert.deepEqual(
    repo.getPlanDay(1).items.map((i) => i.exercise),
    LOWER.map((i) => i.exercise),
    "the plan is untouched"
  );
});

test("'easier' lands a one-day bodyweight adaptation that goes back to the regular plan the day after", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const changes = easierTripChanges(1, FRIDAY);
  assert.ok(
    changes.every((c) => c.until === FRIDAY),
    "every change is scoped to the one day"
  );
  const result = answerBriefAsk({ key: `trip_lift:${FRIDAY}`, answer: "easier", date: THURSDAY });
  assert.equal(result.ok, true, JSON.stringify(result));
  const names = repo.getPlanDay(1).items.map((i) => i.exercise);
  assert.ok(names.includes("Bodyweight Squat"), names.join(", "));
  assert.equal(names.includes("Back Squat"), false);
  const rows = db.prepare(`SELECT status, until_date FROM plan_adaptations`).all();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.status === "active" && r.until_date === FRIDAY));
  assert.equal(tripEventOn(FRIDAY).lift_answers[FRIDAY], "easier");

  const back = expirePlanAdaptations(SATURDAY);
  assert.ok(back.restored.length >= 2, JSON.stringify(back));
  assert.deepEqual(
    repo.getPlanDay(1).items.map((i) => [i.exercise, i.sets]),
    LOWER.map((i) => [i.exercise, i.sets]),
    "the regular plan is back the day after"
  );
});

test("the route and the MCP mirror read and answer the same questions", async (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const route = (method, path) =>
    todayRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods[method])?.route.stack[0].handle;
  const call = (handler, req) =>
    new Promise((resolve) => {
      handler(
        { query: {}, body: {}, ...req },
        { json: (body) => resolve(body), status: () => ({ json: (body) => resolve(body) }) }
      );
    });
  const read = await call(route("get", "/today-asks"), { query: { date: THURSDAY } });
  assert.equal(read.date, THURSDAY);
  assert.equal(read.asks[0]?.key, `trip_lift:${FRIDAY}`);
  const tools = new Map();
  registerDayCoachTools({ tool: (name, _d, _s, fn) => tools.set(name, fn) });
  assert.ok(tools.has("get_today_asks"));
  const viaMcp = JSON.parse((await tools.get("get_today_asks")({ date: THURSDAY })).content[0].text);
  assert.deepEqual(
    viaMcp.asks.map((a) => a.key),
    read.asks.map((a) => a.key)
  );
  const answered = await call(route("post", "/today-asks/answer"), {
    body: { key: `trip_lift:${FRIDAY}`, answer: "yes", date: THURSDAY },
  });
  assert.equal(answered.ok, true);
  const again = JSON.parse(
    (await tools.get("answer_today_ask")({ key: `trip_lift:${FRIDAY}`, answer: "yes", date: THURSDAY })).content[0].text
  );
  assert.equal(again.ok, false, "answered once");
  assert.match(again.error, /already/);
});

// ---------- review fixes (wave 2) ----------

test("the trip-eve hour is the athlete's device zone, never the host clock", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const LA = "America/Los_Angeles";
  // 18:30 Thursday in Los Angeles is 01:30 Friday UTC.
  const evening = runWithTimeZone(LA, () => briefAsks({ date: THURSDAY, now: new Date("2026-10-23T01:30:00Z") }));
  assert.equal(evening.asks.length, 1, "their evening asks");
  // 16:30 UTC is 09:30 in Los Angeles: their morning, so no question.
  const morning = runWithTimeZone(LA, () => briefAsks({ date: THURSDAY, now: new Date("2026-10-22T16:30:00Z") }));
  assert.equal(morning.asks.length, 0, "their morning stays quiet");
});

function lowerSlots() {
  return repo.getPlanDay(1).items.map((i) => [i.exercise, i.sets, i.rep_low, i.rep_high, i.target_weight]);
}

/** The race build's own adaptation of Back Squat, in force until `until`. */
function raceAdaptSquat(until) {
  const proposal = repo.createProposal("stub", "background: race taper", "", {
    summary: "Lighter squat for the race",
    rationale: "Taper: lighter squat.",
    changes: [{ day_number: 1, exercise: "Back Squat", sets: 2, target_weight: 155, until, reason: "Taper: lighter squat" }],
  });
  const applied = repo.applyProposal(Number(proposal.id));
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const row = db.prepare(`SELECT * FROM plan_adaptations WHERE proposal_id = ?`).get(Number(proposal.id));
  assert.ok(row, "the race adaptation is remembered");
  const squat = lowerSlots()[0];
  assert.equal(squat[0], "Back Squat");
  assert.equal(squat[1], 2, "the race version: lighter");
  assert.ok(squat[4] < 185);
  return { raceId: row.id, raceSquat: squat };
}

const raceRow = (id) => ({ ...db.prepare(`SELECT status, until_date, layer FROM plan_adaptations WHERE id = ?`).get(id) });

test("'easier' on a trip lies OVER a race adaptation: the trip ends back on the race version, the race row in force", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const { raceId, raceSquat } = raceAdaptSquat(RACE_DAY);

  const result = answerBriefAsk({ key: `trip_lift:${FRIDAY}`, answer: "easier", date: THURSDAY });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(lowerSlots()[0][0], "Bodyweight Squat");
  assert.deepEqual(raceRow(raceId), { status: "active", until_date: RACE_DAY, layer: null }, "never re-scoped by the trip");
  const tripRows = db.prepare(`SELECT layer, until_date FROM plan_adaptations WHERE proposal_id = ?`).all(result.proposal_id);
  assert.ok(tripRows.length >= 3 && tripRows.every((r) => r.layer === "trip" && r.until_date === FRIDAY));

  const back = expirePlanAdaptations(SATURDAY);
  assert.ok(back.restored.length >= 3, JSON.stringify(back));
  assert.deepEqual(lowerSlots()[0], raceSquat, "back to the race version, never the heavy plan");
  assert.match(back.decision.summary, /after the trip/);
  assert.doesNotMatch(back.decision.summary, /regular plan/);
  assert.deepEqual(raceRow(raceId), { status: "active", until_date: RACE_DAY, layer: null }, "still in force until race day");
  assert.ok(activePlanAdaptations(SATURDAY).some((a) => a.exercise === "Back Squat" && a.until === RACE_DAY));

  // And after the race, the race row's own restore brings the regular plan back.
  const after = expirePlanAdaptations("2026-11-02");
  assert.ok(after.restored.some((row) => row.id === raceId));
  assert.deepEqual(lowerSlots()[0], ["Back Squat", 3, 5, 8, 185]);
});

test("Undo of the trip's easier day leaves the race adaptation in force and the race version on the plan", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const { raceId, raceSquat } = raceAdaptSquat(RACE_DAY);
  const result = answerBriefAsk({ key: `trip_lift:${FRIDAY}`, answer: "easier", date: THURSDAY });
  assert.equal(result.ok, true, JSON.stringify(result));
  const decision = repo
    .listBrainDecisions({ limit: 50 })
    .find((row) => row.source_ref_type === "plan_proposal" && row.source_ref_key === String(result.proposal_id));
  assert.ok(decision, "the trip day has its ledger row");
  const undone = revertDecision(Number(decision.id), "user undo");
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual(lowerSlots()[0], raceSquat);
  assert.deepEqual(raceRow(raceId), { status: "active", until_date: RACE_DAY, layer: null });
  const trip = db.prepare(`SELECT status FROM plan_adaptations WHERE proposal_id = ?`).all(result.proposal_id);
  assert.ok(trip.every((r) => r.status === "cancelled"));
});

test("a race row that ends while a trip version covers its slot waits for the trip, then both unwind", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const { raceId } = raceAdaptSquat(THURSDAY);
  const result = answerBriefAsk({ key: `trip_lift:${FRIDAY}`, answer: "easier", date: THURSDAY });
  assert.equal(result.ok, true, JSON.stringify(result));

  // Friday: the race row is due, but the trip version still lies over the squat.
  const friday = expirePlanAdaptations(FRIDAY);
  assert.equal(friday.restored.length, 0);
  assert.equal(lowerSlots()[0][0], "Bodyweight Squat", "nothing written under the trip version");
  assert.deepEqual(raceRow(raceId), { status: "active", until_date: FRIDAY, layer: null }, "it ends with the trip");

  // Saturday: the trip version unwinds first, then the race row — the regular plan.
  const saturday = expirePlanAdaptations(SATURDAY);
  assert.ok(saturday.restored.some((row) => row.id === raceId));
  assert.deepEqual(lowerSlots()[0], ["Back Squat", 3, 5, 8, 185]);
});

test("a trip version is never 'adapted for the race', even in the race's own week", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  const near = "2026-10-29"; // three days before the race
  assert.equal(adaptationDecisionWords({ until: near, exercises: ["Push-Up"], reasons: [] }).for_race, true);
  const trip = adaptationDecisionWords({ until: near, exercises: ["Push-Up"], reasons: [], layered: true });
  assert.equal(trip.for_race, false);
  assert.doesNotMatch(`${trip.summary} ${trip.rationale}`, /race|regular plan/i);
  const id = Number(
    db
      .prepare(
        `INSERT INTO plan_adaptations (day_number, exercise, kind, until_date, status, layer) VALUES (1, 'Push-Up', 'swapped', ?, 'active', 'trip')`
      )
      .run(near).lastInsertRowid
  );
  const receipt = receiptFromPlanAdaptation(id);
  assert.doesNotMatch(`${receipt.what} ${receipt.until_words}`, /race/);
});

test("the bodyweight twin: most specific pattern first, isolation lifts keep their slot, bodyweight reps", () => {
  assert.equal(bodyweightTwin("Overhead Triceps Extension"), null);
  assert.equal(bodyweightTwin("Upright Row"), null);
  assert.equal(bodyweightTwin("Dumbbell Curl"), null);
  assert.equal(bodyweightTwin("Farmer Carry"), null);
  assert.equal(bodyweightTwin("Leg Press Calf Raise").name, "Single-Leg Calf Raise");
  assert.equal(bodyweightTwin("Overhead Press").name, "Pike Push-Up");
  assert.equal(bodyweightTwin("Bulgarian Split Squat").name, "Reverse Lunge");
  assert.equal(bodyweightTwin("Assisted Chin-Up").name, "Inverted Row");
  const squat = bodyweightTwin("Back Squat");
  assert.equal(squat.name, "Bodyweight Squat");
  assert.ok(squat.rep_low >= 10, "never the loaded lift's 3-5");
});

test("'easier' swaps assisted and bodyweight lifts that have a twin, keeps the rest, and the answer says which", (t) => {
  seedRaceWeek(t, `${THURSDAY}T18:30:00`);
  repo.savePlanDay(1, "Pull", "Back and arms.", [
    { exercise: "Assisted Chin-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 },
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 3, rep_high: 5, target_weight: 185 },
    { exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30 },
  ]);
  const changes = easierTripChanges(1, FRIDAY);
  const chin = changes.find((c) => c.swap?.from === "Assisted Chin-Up");
  assert.equal(chin?.swap.to, "Inverted Row", "an assisted lift needs its machine too");
  const bench = changes.find((c) => c.swap?.from === "Barbell Bench Press");
  assert.equal(bench?.swap.to, "Push-Up");
  assert.ok(bench.rep_low >= 8, "bodyweight reps, not the bench's 3-5");
  const curl = changes.find((c) => c.exercise === "Dumbbell Curl");
  assert.ok(curl && !curl.swap, "an isolation stays");
  assert.ok(changes.every((c) => c.layer === "trip" && c.until === FRIDAY));

  const message = easierTripMessage("Friday", changes);
  assert.match(message, /Assisted Chin-Up and Barbell Bench Press go bodyweight/);
  assert.match(message, /Dumbbell Curl stays, a set lighter/);
  assert.doesNotMatch(message, /Pull goes bodyweight/, "never a whole-day claim the day does not keep");
  assert.equal(
    easierTripMessage("Friday", [{ exercise: "Dumbbell Curl", sets: null }]),
    "Friday: Dumbbell Curl stays, as written. Your plan is back the day after."
  );
});

test("the day page and the week strip read the same leg trim: today's envelope before the calendar", (t) => {
  seedRaceWeek(t, `${FRIDAY}T08:00:00`, { trip: false });
  db.prepare(
    `INSERT INTO daily_session_decisions (date, composition_id, policy_version, input_fingerprint, kind, envelope_json)
     VALUES (?, NULL, 'daily_decision_v7', 'fp-test', 'train', ?)`
  ).run(
    FRIDAY,
    JSON.stringify({ date: FRIDAY, kind: "train", template: { day_number: 1 }, stress: { code: "key_run_eve", groups: ["hamstrings"] } })
  );
  const strip = planDayLegTrimOn(FRIDAY, 1, { today: FRIDAY });
  assert.equal(strip, "key_run_eve", "the morning's own decision leads");
  assert.equal(dayDetail(FRIDAY, { today: FRIDAY }).lift?.trim, strip);
});
