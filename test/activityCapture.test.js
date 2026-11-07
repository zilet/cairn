// Chat capture routing: a weigh-in or a blood-pressure reading typed in chat lands
// in its own store, never as an activity row, and an activity that names no
// activity is dropped instead of being stored as junk.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { classifyActivityCapture, parseActivity } from "../dist/repo/activity-capture.js";
import {
  chatBloodPressureMeasuredAt,
  normalizeChatAction,
  renderChatActionPromptProse,
  renderChatActionSchema,
  rerouteMisfiledCaptures,
} from "../dist/chatActions.js";
import { ACTIVITY_NOT_LOGGED_VARIANTS, applyChatActions, reconcileMisfiledActivityReply } from "../dist/chatTurns.js";
import { buildChatPrompt } from "../dist/prompt.js";
import { localDateISO } from "../dist/repo/shared.js";

beforeEach(() => {
  resetTables("activities", "bodyweight_log", "blood_pressure_readings");
});

// ---------- the sport the text names ----------

test("parseActivity names the sport beyond run/ride/swim/hike", () => {
  const cases = {
    "10 min bag punching session with MMA gloves and wraps": "boxing",
    "boxing class 45 min": "boxing",
    "shadow boxing 3 rounds": "boxing",
    "bjj open mat 60 min": "martial_arts",
    "muay thai 1h": "martial_arts",
    "rowing machine 20 min": "row",
    "kayaked 40 min on the lake": "paddling",
    "padel with friends 90 min": "padel",
    "bouldering 1h": "climbing",
    "yoga 30 min": "yoga",
    "snowboarding all day": "snowboarding",
    "something 20 min": "other",
    // Leg work that says "box", and a punchy tempo: never boxing (review 2026-11-07).
    "box jumps 3x10 20 min": "other",
    "plyo box work 15 min": "other",
    "box squats 20 min": "other",
    "punchy session 30 min": "other",
  };
  for (const [text, type] of Object.entries(cases)) assert.equal(parseActivity(text).type, type, text);
  assert.equal(parseActivity("10 min bag punching session").duration_min, 10);
});

test("a finished combat session with no minutes is still a session; a future one is not", () => {
  for (const text of ["did some bag work", "sparred tonight", "heavy bag after work", "shadow boxing"]) {
    assert.deepEqual(classifyActivityCapture(text), { kind: "activity" }, text);
  }
  assert.deepEqual(classifyActivityCapture("I'll do bag work later"), { kind: "drop", reason: "intent_not_done" });
});

test("a generic structured type yields to the sport the text names", () => {
  const row = repo.addActivity({ text: "10 min bag punching session", type: "other" });
  assert.equal(row.type, "boxing");
  const kept = repo.addActivity({ text: "10 min bag punching session", type: "kickboxing" });
  assert.equal(kept.type, "kickboxing", "a specific stated type always wins");
});

// ---------- the pure classifier ----------

test("a genuine activity always stays an activity", () => {
  for (const text of [
    "ran 5k easy 28 min",
    "ran 50 min @ 5:30/km",
    "rode 1 hr 40 km",
    "walked the dog",
    "yoga class",
    "played tennis",
    "push day done",
    "swam 1500m",
    "stretching 20 min",
    "30 min elliptical at 150 bpm",
    "let's go for a run", // a type is named: never dropped by the guard
    "bench 185 lbs x 5", // a lift filed as an activity is still training, not a weigh-in
  ]) {
    assert.deepEqual(classifyActivityCapture(text), { kind: "activity" }, text);
  }
});

test("a blood-pressure reading is rerouted, with or without an explicit BP word", () => {
  assert.deepEqual(classifyActivityCapture("log blood pressure 125/75"), {
    kind: "blood_pressure",
    systolic: 125,
    diastolic: 75,
    pulse: null,
  });
  assert.deepEqual(classifyActivityCapture("BP 118 over 76, pulse 60"), {
    kind: "blood_pressure",
    systolic: 118,
    diastolic: 76,
    pulse: 60,
  });
  // "75 hr" must not read as a 75-hour session once BP is named.
  assert.deepEqual(classifyActivityCapture("bp 125/75 hr 62"), {
    kind: "blood_pressure",
    systolic: 125,
    diastolic: 75,
    pulse: 62,
  });
  assert.deepEqual(classifyActivityCapture("122/81"), {
    kind: "blood_pressure",
    systolic: 122,
    diastolic: 81,
    pulse: null,
  });
  assert.deepEqual(classifyActivityCapture("120/80/64"), {
    kind: "blood_pressure",
    systolic: 120,
    diastolic: 80,
    pulse: 64,
  });
});

test("a slash pair that is not a cuff reading is not rerouted to BP", () => {
  assert.notEqual(classifyActivityCapture("80/120").kind, "blood_pressure", "diastolic above systolic");
  assert.notEqual(classifyActivityCapture("9/25").kind, "blood_pressure", "a date");
  assert.notEqual(classifyActivityCapture("bp 120/80 then 118/76").kind, "blood_pressure", "two readings");
  assert.deepEqual(classifyActivityCapture("bp 125/75 after a 5k run"), { kind: "activity" });
  assert.deepEqual(classifyActivityCapture("rowed 20/10 intervals 30 min"), { kind: "activity" });
});

test("a weigh-in is rerouted to weight", () => {
  assert.deepEqual(classifyActivityCapture("176.5 lbs weight today"), { kind: "weight", weight_lb: 176.5 });
  assert.deepEqual(classifyActivityCapture("weighed in at 174 this morning"), { kind: "weight", weight_lb: 174 });
  assert.deepEqual(classifyActivityCapture("weight: 181.2"), { kind: "weight", weight_lb: 181.2 });
  assert.deepEqual(classifyActivityCapture("80 kg"), { kind: "weight", weight_lb: 176.4 });
  assert.deepEqual(classifyActivityCapture("scale says 175 at 7:15"), { kind: "weight", weight_lb: 175 });
  // A bare number: plausibly this athlete's weight.
  assert.deepEqual(classifyActivityCapture("173", { referenceWeightLb: 176 }), { kind: "weight", weight_lb: 173 });
  assert.deepEqual(classifyActivityCapture("173"), { kind: "weight", weight_lb: 173 });
});

test("a number that is not a weigh-in is never rerouted to weight", () => {
  assert.notEqual(
    classifyActivityCapture("173", { referenceWeightLb: 250 }).kind,
    "weight",
    "far from the stored weight"
  );
  assert.notEqual(classifyActivityCapture("weight 176 down from 178").kind, "weight", "two numbers is a story");
  assert.notEqual(classifyActivityCapture("weighed 176 then went to the store").kind, "weight", "other content");
  assert.notEqual(classifyActivityCapture("squat 225 lbs").kind, "weight", "a lift");
  assert.notEqual(classifyActivityCapture("rucked with a 45 lb pack").kind, "weight", "a load");
  assert.notEqual(classifyActivityCapture("25").kind, "weight", "below any bodyweight");
});

test("an activity that names no activity is dropped", () => {
  assert.deepEqual(classifyActivityCapture("Let's start a push training sessio"), {
    kind: "drop",
    reason: "intent_not_done",
  });
  assert.deepEqual(classifyActivityCapture("I'm going to do yoga later"), { kind: "drop", reason: "intent_not_done" });
  assert.deepEqual(classifyActivityCapture("hello?"), { kind: "drop", reason: "unintelligible" });
  assert.deepEqual(classifyActivityCapture("   "), { kind: "drop", reason: "unintelligible" });
  assert.deepEqual(classifyActivityCapture("12"), { kind: "drop", reason: "unintelligible" });
});

test("a bare clock time next to a named reading is when it was taken, not how long", () => {
  assert.deepEqual(classifyActivityCapture("bp 125/75 this morning 7:15"), {
    kind: "blood_pressure",
    systolic: 125,
    diastolic: 75,
    pulse: null,
  });
  assert.deepEqual(classifyActivityCapture("weight 176 at 6:40"), { kind: "weight", weight_lb: 176 });
  assert.deepEqual(classifyActivityCapture("weighed 176 home scale"), { kind: "weight", weight_lb: 176 });
  // A named reading beside a real session still stays an activity.
  assert.deepEqual(classifyActivityCapture("weighed 176 then ran 5:30/km"), { kind: "activity" });
});

test("a word starting with h after a number is never read as hours", () => {
  assert.equal(parseActivity("ran 5k with 2 hills in 25 min").duration_min, 25);
  assert.equal(parseActivity("176 home scale").duration_min, null);
  assert.equal(parseActivity("rode 1h30m").duration_min, 90);
  assert.equal(parseActivity("rode 1h 30 min").duration_min, 90);
  assert.equal(parseActivity("hiked 2 hours").duration_min, 120);
  assert.equal(parseActivity("rode 1.5hrs").duration_min, 90);
});

test("a request to log a real session is kept; a question or plan is not", () => {
  for (const text of [
    "Can we log my yoga class from this morning",
    "could you record the tennis match I played",
    "Zumba",
    "tai chi in the park",
    "treadmill",
    "Frisbee with friends",
    "Garmin strength",
    "Upper body",
    "Strength 60",
  ]) {
    assert.deepEqual(classifyActivityCapture(text), { kind: "activity" }, text);
  }
  assert.deepEqual(classifyActivityCapture("Should I do yoga today?"), { kind: "drop", reason: "intent_not_done" });
  assert.deepEqual(classifyActivityCapture("can you plan a push session"), { kind: "drop", reason: "intent_not_done" });
  assert.deepEqual(classifyActivityCapture("I'll do pilates tonight"), { kind: "drop", reason: "intent_not_done" });
});

test("parseActivity keeps its behavior after moving into the pure module", () => {
  assert.deepEqual(parseActivity("ran 5k easy 28 min"), { type: "run", duration_min: 28, distance_km: 5, pace: null });
  assert.deepEqual(parseActivity("ran 50 min @ 5:30/km"), {
    type: "run",
    duration_min: 50,
    distance_km: null,
    pace: "5:30/km",
  });
  assert.equal(repo.parseActivity, parseActivity, "the repo barrel re-exports the one parser");
});

// ---------- the chat action contract ----------

test("log_blood_pressure normalizes a stated reading and refuses a misread one", () => {
  assert.deepEqual(normalizeChatAction({ type: "log_blood_pressure", systolic: "125", diastolic: 75 }), {
    type: "log_blood_pressure",
    systolic: 125,
    diastolic: 75,
    pulse: null,
    measured_at: undefined,
  });
  assert.equal(normalizeChatAction({ type: "log_blood_pressure", systolic: 75, diastolic: 125 }), null);
  assert.equal(normalizeChatAction({ type: "log_blood_pressure", systolic: 400, diastolic: 80 }), null);
  assert.equal(normalizeChatAction({ type: "log_blood_pressure", systolic: 120 }), null);
  assert.equal(
    normalizeChatAction({ type: "log_blood_pressure", systolic: 120, diastolic: 80, pulse: 999 }).pulse,
    null
  );
});

test("a stated BP time must be a real, non-future date with an optional real clock", () => {
  const today = "2026-06-10";
  assert.equal(chatBloodPressureMeasuredAt("2026-06-10T07:10", today), "2026-06-10T07:10");
  assert.equal(chatBloodPressureMeasuredAt("2026-06-09", today), "2026-06-09");
  assert.equal(chatBloodPressureMeasuredAt("2026-06-11T07:10", today), undefined, "future");
  assert.equal(chatBloodPressureMeasuredAt("2026-06-10T25:10", today), undefined, "impossible clock");
  assert.equal(chatBloodPressureMeasuredAt("this morning", today), undefined);
});

test("rerouteMisfiledCaptures reroutes, dedupes against the turn's own readings, and drops junk", () => {
  const actions = [
    { type: "log_activity", text: "173" },
    { type: "log_activity", text: "log blood pressure 125/75" },
    { type: "log_activity", text: "Let's start a push training sessio" },
    { type: "log_activity", text: "ran 5k easy 28 min" },
  ].map(normalizeChatAction);
  const { actions: out, notes } = rerouteMisfiledCaptures(actions, { referenceWeightLb: 175 });
  assert.deepEqual(
    out.map((a) => a.type),
    ["log_weight", "log_blood_pressure", "log_activity"]
  );
  assert.equal(out[0].weight_lb, 173);
  assert.equal(out[1].systolic, 125);
  assert.equal(out[1].diastolic, 75);
  assert.equal(out[2].text, "ran 5k easy 28 min");
  assert.deepEqual(
    notes.map((n) => [n.outcome, n.reason]),
    [
      ["log_weight", "weight_reading"],
      ["log_blood_pressure", "blood_pressure_reading"],
      ["dropped", "intent_not_done"],
    ]
  );

  // The agent already emitted the right action alongside the misfiled one: one write, not two.
  const both = rerouteMisfiledCaptures(
    [
      normalizeChatAction({ type: "log_weight", weight_lb: 176.5 }),
      normalizeChatAction({ type: "log_activity", text: "176.5 lbs weight today" }),
    ],
    {}
  );
  assert.deepEqual(
    both.actions.map((a) => a.type),
    ["log_weight"]
  );
  assert.deepEqual(
    both.notes.map((n) => n.reason),
    ["duplicate"]
  );
});

test("a rerouted BP keeps a past date but leaves today's reading to be stamped now", () => {
  const today = "2026-06-10";
  const rerouted = (date) =>
    rerouteMisfiledCaptures([normalizeChatAction({ type: "log_activity", text: "bp 125/75", date })], { today })
      .actions[0];
  assert.equal(rerouted(today).measured_at, undefined, "a date-only today would be stored at noon");
  assert.equal(rerouted("2026-06-09").measured_at, "2026-06-09");
  assert.equal(rerouted(undefined).measured_at, undefined);
});

test("a reply claiming a dropped activity was logged gets an honest line under it", () => {
  const dropped = [{ text: "Let's start a push session", outcome: "dropped", reason: "intent_not_done" }];
  const claim = "Logged your push session — nice work.";
  const out = reconcileMisfiledActivityReply(claim, dropped, []);
  assert.ok(out.startsWith(claim));
  assert.ok(
    ACTIVITY_NOT_LOGGED_VARIANTS.some((line) => out.endsWith(line)),
    out
  );
  assert.match(out, /no activity was logged/i);
  // Untouched when the prose claims nothing, when nothing was dropped, when the drop was
  // only a duplicate, or when a real activity landed this turn.
  assert.equal(
    reconcileMisfiledActivityReply("Here's today's push session.", dropped, []),
    "Here's today's push session."
  );
  assert.equal(reconcileMisfiledActivityReply(claim, [], []), claim);
  assert.equal(
    reconcileMisfiledActivityReply(claim, [{ text: "176", outcome: "dropped", reason: "duplicate" }], []),
    claim
  );
  assert.equal(reconcileMisfiledActivityReply(claim, dropped, [{ type: "log_activity", result: { id: 1 } }]), claim);
  // A reroute is not a drop: the reading landed, and its pill says where.
  assert.equal(
    reconcileMisfiledActivityReply(claim, [{ text: "173", outcome: "log_weight", reason: "weight_reading" }], []),
    claim
  );
});

test("the prompt's action rules route weight and BP explicitly, in every lane", () => {
  const prose = renderChatActionPromptProse();
  assert.match(renderChatActionSchema(), /"type": "log_blood_pressure"/);
  assert.match(prose, /blood-pressure reading \("125\/75"\) is log_blood_pressure — never log_activity/);
  assert.match(prose, /bodyweight reading \("173", "176\.5 lbs this morning"\) is log_weight/);
  const capture = buildChatPrompt([], "log blood pressure 125/75", undefined, { lane: "capture" });
  assert.match(capture, /"type": "log_blood_pressure"/);
  assert.match(capture, /a cuff reading is log_blood_pressure — never log_activity/);
});

// ---------- the chokepoint, end to end ----------

function countRows(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test("applyChatActions stores chat BP in the blood-pressure history, not activities", () => {
  const { applied } = applyChatActions(
    {
      actions: [
        { type: "log_blood_pressure", systolic: 125, diastolic: 75, pulse: 61, measured_at: `${localDateISO()}T07:10` },
      ],
    },
    { agent: "stub", message: "log blood pressure 125/75 pulse 61 at 7:10" }
  );
  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "log_blood_pressure");
  assert.equal(applied[0].error, undefined);
  const [row] = repo.listBloodPressureReadings(5);
  assert.equal(row.systolic, 125);
  assert.equal(row.diastolic, 75);
  assert.equal(row.pulse, 61);
  assert.equal(row.source, "manual");
  assert.equal(row.measured_at, `${localDateISO()} 07:10:00`);
  assert.equal(countRows("activities"), 0);
});

test("applyChatActions reroutes misfiled log_activity readings and drops junk", () => {
  repo.setProfile({ weight_lb: 176 });
  const { applied, misfiledCaptures } = applyChatActions(
    {
      actions: [
        { type: "log_activity", text: "176.5 lbs weight today" },
        { type: "log_activity", text: "log blood pressure 125/75" },
        { type: "log_activity", text: "Let's start a push training sessio" },
        { type: "log_activity", text: "ran 5k easy 28 min" },
      ],
    },
    { agent: "stub", message: "176.5 lbs weight today, log blood pressure 125/75, ran 5k easy 28 min" }
  );
  assert.deepEqual(
    applied.map((a) => a.type),
    ["log_weight", "log_blood_pressure", "log_activity"]
  );
  assert.ok(applied.every((a) => a.error === undefined));
  const weights = repo.listWeight(5);
  assert.equal(weights.at(-1).weight_lb, 176.5);
  const [bp] = repo.listBloodPressureReadings(5);
  assert.equal(bp.systolic, 125);
  assert.equal(bp.diastolic, 75);
  const activities = db.prepare(`SELECT raw_text, type FROM activities`).all();
  assert.deepEqual(
    activities.map((a) => [a.raw_text, a.type]),
    [["ran 5k easy 28 min", "run"]]
  );
  assert.deepEqual(
    misfiledCaptures.map((n) => n.outcome),
    ["log_weight", "log_blood_pressure", "dropped"]
  );
});
