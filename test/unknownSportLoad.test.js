// Any sport gets a read (decision 5, 2026-10-04). Garmin logs sports Cairn has no
// modality for — kayaking_v2, stand_up_paddleboarding_v2, fishing_v2, padel_v2,
// whatever comes next — and every one of them used to fall through
// matchEnduranceModality as null: dose 0, as if nothing happened. The load family
// (endurance-sports.activityLoadFamily) guesses from the type key instead:
//   - paddle → back, shoulders, arms, trunk (and \bkayak\b no longer misses "kayaking")
//   - court/ball → legs + trunk; snow/skate → legs + trunk
//   - anything else → a LIGHT whole-body exposure, never heavy on length alone
//   - a strength activity is a Cairn session and is never dosed as endurance
// Deterministic, offline, temp DB (see test/run.mjs).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, resetTables } from "./_seed.js";
import { activityLoadFamily } from "../dist/repo/endurance-sports.js";
import { matchEnduranceModality } from "../dist/repo/heavy-load.js";
import { enduranceDose, muscleResidual, recentEnduranceImpacts } from "../dist/repo/hybrid-load.js";
import { cardioEffort, hardCardioDay } from "../dist/repo/training-read.js";
import { shadowModality, withoutShadowActivities } from "../dist/repo/activity-shadow.js";

const REF = "2026-05-15";

beforeEach(() => {
  resetTables("logged_sets", "sessions", "exercises", "activities", "garmin_activities", "garmin_sources");
});

function addRow({ type, minutes = null, km = null, text = null, rpe = null, date = REF }) {
  const info = db
    .prepare(`INSERT INTO activities (date, type, raw_text, duration_min, distance_km, rpe) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(date, type, text, minutes, km, rpe);
  return Number(info.lastInsertRowid);
}

function impactsOf(type) {
  return recentEnduranceImpacts(1, REF).filter((i) => i.type === type);
}

test("the load family guesses from the type key, Garmin _v2 suffixes stripped", () => {
  assert.equal(activityLoadFamily("kayaking_v2").family, "paddle");
  assert.equal(activityLoadFamily("stand_up_paddleboarding_v2").family, "paddle");
  assert.equal(activityLoadFamily("canoeing").family, "paddle");
  assert.equal(activityLoadFamily("indoor_rowing").family, "row");
  assert.equal(activityLoadFamily("padel_v2").family, "court");
  assert.equal(activityLoadFamily("tennis").family, "court");
  assert.equal(activityLoadFamily("snowboarding").family, "snow");
  assert.equal(activityLoadFamily("inline_skating").family, "snow");
  assert.equal(activityLoadFamily("skate_skiing").family, "ski", "a known ski family keeps its mapping");
  assert.equal(activityLoadFamily("ride").family, "ride");
  assert.equal(activityLoadFamily("hike").family, "walk");
  assert.equal(activityLoadFamily("run").family, "run");
  for (const unknown of ["fishing_v2", "bouldering", "indoor_climbing", "yoga", "some_future_sport_v3"]) {
    const read = activityLoadFamily(unknown);
    assert.equal(read.family, "whole_body", unknown);
    assert.equal(read.known, false, unknown);
  }
  assert.deepEqual(activityLoadFamily("strength_training"), {
    family: "whole_body",
    label: "Strength Training",
    known: false,
  });
  assert.equal(activityLoadFamily("kayaking_v2").known, true);
  assert.equal(activityLoadFamily("kayaking_v2").label, "Kayaking");
});

// 2026-11-07 (live): "10 min bag punching session with MMA gloves and wraps" was filed
// as type "other" and read as nothing in particular. Combat sports are their own family.
test("combat sports read as their own family: shoulders, arms and trunk", () => {
  for (const type of ["boxing", "kickboxing", "martial_arts", "mma", "muay_thai", "bjj", "wrestling"]) {
    assert.equal(activityLoadFamily(type).family, "combat", type);
    assert.equal(activityLoadFamily(type).known, true, type);
  }
  assert.equal(activityLoadFamily("other", "10 min bag punching session with MMA gloves").family, "combat");
  assert.notEqual(activityLoadFamily("other", "box jumps and burpees 20 min").family, "combat", "box jumps are legs");
  assert.notEqual(activityLoadFamily("other", "punchy hill reps").family, "combat");
  const modality = matchEnduranceModality("boxing", "");
  assert.equal(modality.family, "combat");
  assert.ok(modality.regions.includes("shoulders"));
  assert.ok(!modality.regions.includes("quads"), "bag work is never a leg day");
});

test("ten minutes on the bag is a light touch, never heavy", () => {
  addRow({ type: "boxing", minutes: 10, text: "bag work" });
  const [impact] = impactsOf("boxing");
  assert.equal(impact.family, "combat");
  assert.equal(impact.load, "light");
});

test("an hour of combat on length alone stays below heavy without session effort", () => {
  addRow({ type: "boxing", minutes: 75, text: "boxing class" });
  const [impact] = impactsOf("boxing");
  assert.notEqual(impact.load, "heavy");
});

test("the structured type outranks incidental prose; text is read only when the type places nothing", () => {
  assert.equal(activityLoadFamily("kayaking_v2", "lake run").family, "paddle");
  assert.equal(activityLoadFamily("other", "padel with friends").family, "court");
  assert.equal(matchEnduranceModality("kayaking_v2", "lake run").family, "paddle");
});

test("only empty input and a strength activity match no modality", () => {
  assert.equal(matchEnduranceModality("", ""), null);
  assert.equal(matchEnduranceModality("strength_training", "Garmin strength"), null);
  assert.equal(matchEnduranceModality("other", "weights at the gym"), null, "a generic row that names lifting");
  assert.equal(matchEnduranceModality("fishing_v2", "").label, "activity");
  assert.equal(matchEnduranceModality("bouldering", "").label, "activity");
  assert.equal(matchEnduranceModality("kayaking", "").label, "paddle");
  assert.equal(matchEnduranceModality("row", "").label, "row");
  assert.equal(matchEnduranceModality("other", "rowing machine").label, "row", "the row regex reads rowing");
});

for (const type of ["kayaking_v2", "stand_up_paddleboarding_v2"]) {
  test(`${type}: 60 min with no Garmin effect is a paddle dose on the back and shoulders`, () => {
    addRow({ type, minutes: 60 });
    const [impact] = impactsOf(type);
    assert.ok(impact, "the paddle outing is an impact, not dropped");
    assert.equal(impact.family, "paddle");
    assert.equal(impact.known_sport, true);
    for (const region of ["back", "shoulders", "core"]) assert.ok(impact.regions.includes(region), region);
    assert.ok(["light", "moderate", "heavy"].includes(impact.load));
    assert.notEqual(impact.intensity, "hard", "no watch evidence, so never hard");
    assert.ok(enduranceDose(impact) > 0);
    const residual = muscleResidual(7, REF);
    assert.ok((residual.get("back")?.endurance ?? 0) > 0, "back carries endurance residual");
    assert.ok((residual.get("shoulders")?.endurance ?? 0) > 0, "shoulders carry endurance residual");
  });
}

test("fishing (180 min) and bouldering (60 min) are a light whole-body read, never nothing", () => {
  addRow({ type: "fishing_v2", minutes: 180 });
  addRow({ type: "bouldering", minutes: 60 });
  for (const type of ["fishing_v2", "bouldering"]) {
    const [impact] = impactsOf(type);
    assert.ok(impact, `${type} is an impact`);
    assert.equal(impact.family, "whole_body");
    assert.equal(impact.known_sport, false);
    assert.equal(impact.load, "light", `${type}: length alone never makes a generic activity more than light`);
    assert.equal(impact.intensity, "easy");
    assert.ok(enduranceDose(impact) > 0, `${type} lays down a small dose`);
  }
  const quads = muscleResidual(7, REF).get("quads");
  assert.ok(quads && quads.endurance > 0, "a nonzero residual");
  assert.equal(quads.band, "fresh", "…far below anything that would hold a lift");
});

test("a generic activity with real watch effort reads moderate, then heavy only when long", () => {
  const id = addRow({ type: "bouldering", minutes: 150 });
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','test')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, aerobic_te)
     VALUES (?, 'ga-b', ?, ?, 'bouldering', 'Bouldering', 2.4)`
  ).run(src.lastInsertRowid, id, REF);
  const [impact] = impactsOf("bouldering");
  assert.equal(impact.intensity, "moderate");
  assert.equal(impact.load, "heavy");
});

test("cardioEffort: fishing for three hours is not hard; an unknown sport takes the walk bars", () => {
  assert.equal(cardioEffort({ type: "fishing_v2", duration_min: 180 }), "moderate");
  assert.equal(cardioEffort({ type: "fishing_v2", duration_min: 60 }), "easy");
  assert.equal(
    cardioEffort({ type: "bouldering", duration_min: 60, aerobic_te: 4.2 }),
    "hard",
    "the watch still speaks"
  );
  assert.equal(cardioEffort({ type: "padel_v2", duration_min: 60 }), "hard", "a court sport takes the generic bars");
  assert.equal(cardioEffort({ type: "kayaking_v2", duration_min: 30 }), "moderate");
});

function attachWatch(activityId, { aerobic_te = null } = {}) {
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','test')`).run();
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, name, aerobic_te)
     VALUES (?, ?, ?, ?, 'kayaking_v2', 'Kayak', ?)`
  ).run(src.lastInsertRowid, `ga-${activityId}`, activityId, REF, aerobic_te);
}

function wipeActivities() {
  resetTables("activities", "garmin_activities", "garmin_sources");
}

test("hardCardioDay: paddle needs effort for the short bar; an unknown sport is never hard on length", () => {
  addRow({ type: "kayaking_v2", minutes: 45 });
  assert.equal(hardCardioDay(REF, null), false, "45 min of paddling with no effort is not a loading day");
  wipeActivities();
  addRow({ type: "kayaking_v2", minutes: 95 });
  assert.equal(hardCardioDay(REF, null), true, "a long paddle still loads at the walk bar");
  wipeActivities();
  const withTe = addRow({ type: "kayaking_v2", minutes: 45 });
  attachWatch(withTe, { aerobic_te: 2 });
  assert.equal(hardCardioDay(REF, null), true, "aerobic effect at 2 brings the short bar");
  wipeActivities();
  addRow({ type: "kayaking_v2", minutes: 45, rpe: 6 });
  assert.equal(hardCardioDay(REF, null), true, "a non-easy stated effort brings the short bar");
  wipeActivities();
  addRow({ type: "kayaking_v2", minutes: 45, rpe: 3 });
  assert.equal(hardCardioDay(REF, null), false, "an easy stated effort keeps the walk bar");
  wipeActivities();
  addRow({ type: "fishing_v2", minutes: 60 });
  assert.equal(hardCardioDay(REF, null), false, "an hour of fishing is not");
  wipeActivities();
  addRow({ type: "fishing_v2", minutes: 180 });
  assert.equal(hardCardioDay(REF, null), false, "three hours of fishing is still not hard on length");
});

test("golf is a walk, and a paddle is heavy only when the session showed effort", () => {
  assert.equal(activityLoadFamily("golf").family, "walk");
  assert.equal(activityLoadFamily("golfing").family, "walk");
  const golf = matchEnduranceModality("golf", "");
  assert.equal(golf.family, "walk");
  assert.equal(golf.loadCharacter, "aerobic");
  assert.equal(cardioEffort({ type: "golf", duration_min: 240 }), "moderate");

  addRow({ type: "golf", minutes: 80 });
  assert.notEqual(impactsOf("golf")[0].load, "heavy", "an ordinary round stays under the walk bar");
  wipeActivities();

  addRow({ type: "kayaking_v2", minutes: 70 });
  assert.equal(impactsOf("kayaking_v2")[0].load, "moderate", "length alone is not a heavy paddle");
  wipeActivities();
  addRow({ type: "kayaking_v2", minutes: 70, rpe: 6 });
  assert.equal(impactsOf("kayaking_v2")[0].load, "heavy", "a non-easy stated effort makes the long paddle heavy");
  wipeActivities();
  const withTe = addRow({ type: "kayaking_v2", minutes: 70 });
  attachWatch(withTe, { aerobic_te: 2.1 });
  assert.equal(impactsOf("kayaking_v2")[0].load, "heavy", "aerobic effect at 2 makes the long paddle heavy");
});

test("a strength activities row yields no endurance impact", () => {
  addRow({ type: "strength_training", minutes: 60 });
  assert.equal(recentEnduranceImpacts(1, REF).length, 0);
});

test("court and snow guesses each get a nonzero leg dose", () => {
  addRow({ type: "padel_v2", minutes: 60 });
  addRow({ type: "snowboarding", minutes: 120 });
  const padel = impactsOf("padel_v2")[0];
  const snow = impactsOf("snowboarding")[0];
  assert.equal(padel.family, "court");
  assert.equal(snow.family, "snow");
  for (const impact of [padel, snow]) {
    assert.ok(impact.regions.includes("quads") && impact.regions.includes("core"), impact.type);
    assert.ok(enduranceDose(impact) > 0, impact.type);
  }
  assert.ok((muscleResidual(7, REF).get("quads")?.endurance ?? 0) > 0);
});

test("a hand-typed kayak shadows the watch's kayaking_v2", () => {
  assert.equal(shadowModality("kayaking_v2"), "paddle");
  assert.equal(shadowModality("kayak"), "paddle");
  assert.equal(shadowModality("fishing_v2"), "fishing_v2", "unknowns keep their own key");
  const rows = [
    { id: 1, date: REF, type: "kayaking_v2", source: "garmin", external_id: "x", duration_min: 60 },
    { id: 2, date: REF, type: "kayak", source: null, external_id: null, duration_min: 60 },
  ];
  assert.deepEqual(
    withoutShadowActivities(rows).map((r) => r.id),
    [1]
  );
});
