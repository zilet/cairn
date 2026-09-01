// The deterministic Cairn-name → Garmin FIT mapper. Pure and offline: no DB rows, no
// network, no agent. What it must never do is invent an enum — Garmin rejects the whole
// payload for one unknown member — so validity is asserted as hard as the matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandExerciseTokens,
  garminCandidatesForPrompt,
  garminWeightGrams,
  isValidGarminRef,
  mapExerciseToGarmin,
  sameExerciseIdentity,
} from "../dist/repo/garmin-exercise-map.js";
import { buildGarminExerciseSetsPayload } from "../dist/garminExport.js";

test("a plain barbell lift maps onto its own FIT category", () => {
  const hit = mapExerciseToGarmin("Bench Press");
  assert.equal(hit.category, "BENCH_PRESS");
  assert.ok(isValidGarminRef(hit));
});

test("Romanian Deadlift maps to the deadlift family's own sub-exercise", () => {
  const hit = mapExerciseToGarmin("Romanian Deadlift");
  assert.equal(hit.category, "DEADLIFT");
  assert.equal(hit.exercise, "ROMANIAN_DEADLIFT");
  assert.ok(isValidGarminRef(hit));
});

test("an abbreviated name reaches the same mapping as its spelled-out twin", () => {
  // "RDL" is what actually gets typed at the rack.
  assert.deepEqual(expandExerciseTokens("RDL").sort(), ["deadlift", "romanian"]);
  const short = mapExerciseToGarmin("RDL");
  const long = mapExerciseToGarmin("Romanian Deadlift");
  assert.equal(short.category, long.category);
  assert.equal(short.exercise, long.exercise);
});

test("identity is about the lift, not the label", () => {
  // Same lift, two ways the same athlete writes it on different days.
  assert.equal(sameExerciseIdentity("Db Incline Press", "Incline Dumbbell Press"), true);
  assert.equal(sameExerciseIdentity("incline db press", "Incline Dumbbell Press"), true);
  // A different implement is a different lift — this is the guard that protects a
  // logged history from being relabelled onto another movement.
  assert.equal(sameExerciseIdentity("Barbell Bench Press", "Dumbbell Bench Press"), false);
  // And so is a different angle.
  assert.equal(sameExerciseIdentity("Incline Dumbbell Press", "Dumbbell Bench Press"), false);
});

test("a chest press is never filed as shoulder work", () => {
  // The category vote scores implement-blind, so "Seated Barbell Shoulder Press" used
  // to win on {seated, press} overlap while the catalog's chest-press rows — all
  // heavily qualified ("Alternating Dumbbell Chest Press") — scored lower. A wrong
  // mapping is worse than none: it writes false history to Garmin AND is sticky.
  const hit = mapExerciseToGarmin("Seated machine chest press", { muscle_group: "chest" });
  assert.equal(hit.category, "BENCH_PRESS");
  assert.ok(isValidGarminRef(hit));
  // Same guard, a second real mapping it fixes: this one used to land on CORE's
  // "Cable Core Press".
  assert.equal(mapExerciseToGarmin("Cable Chest Press").category, "BENCH_PRESS");
});

test("two names that claim different body regions are never the same lift", () => {
  // Both sides must NAME a region for the guard to fire — most catalog rows name none,
  // and those must keep matching exactly as before.
  assert.equal(mapExerciseToGarmin("Machine chest press").category, "BENCH_PRESS");
  assert.equal(mapExerciseToGarmin("Seated shoulder press machine").category, "SHOULDER_PRESS");
  // A region word on one side only leaves the match untouched.
  assert.equal(mapExerciseToGarmin("Bench Press").category, "BENCH_PRESS");
});

test("the live lift names on the athlete's plan keep their mappings", () => {
  // The mapping is sticky — a row the deterministic pass places is never revisited by
  // the agentic lane — so these are asserted as a set, not one at a time.
  const expected = [
    ["Back Squat", "SQUAT", null],
    ["Barbell Bench Press", "BENCH_PRESS", "BARBELL_BENCH_PRESS"],
    ["Barbell Overhead Press", "SHOULDER_PRESS", "OVERHEAD_BARBELL_PRESS"],
    ["Lat Pulldown", "PULL_UP", "LAT_PULLDOWN"],
    ["Seated DB Overhead Press", "SHOULDER_PRESS", null],
    ["Incline DB Press", "BENCH_PRESS", "INCLINE_DUMBBELL_BENCH_PRESS"],
    ["Cable Overhead Tricep Extension", "TRICEPS_EXTENSION", "CABLE_OVERHEAD_TRICEPS_EXTENSION"],
    ["Dumbbell Row", "ROW", "DUMBBELL_ROW"],
    ["Standing Dumbbell Calf Raise", "CALF_RAISE", "STANDING_DUMBBELL_CALF_RAISE"],
    // FIT's only "Leg Extensions" slot really does sit under CRUNCH. "leg" is
    // deliberately NOT a region word — the catalog uses it as a limb qualifier, and
    // treating it as a region would fight FIT's own filing here and on "Leg Press".
    ["Leg Extension", "CRUNCH", "LEG_EXTENSIONS"],
  ];
  for (const [name, category, exercise] of expected) {
    const hit = mapExerciseToGarmin(name);
    assert.equal(hit.category, category, `${name} → ${hit.category}`);
    // A category-only answer is legal wherever a sub-exercise was expected; the
    // reverse — a sub-exercise under the wrong family — is what must never happen.
    if (exercise) assert.ok(hit.exercise === exercise || hit.exercise === null, `${name} → ${hit.exercise}`);
    assert.ok(isValidGarminRef(hit));
  }
});

test("a movement the catalog does not know comes back unmapped, with candidates to choose from", () => {
  const hit = mapExerciseToGarmin("ZTest Knee Wibble");
  assert.equal(hit.confidence, "none");
  assert.equal(hit.category, "");
  assert.ok(Array.isArray(hit.candidates));
  // Nothing is written for an unmapped lift; the ranked shortlist exists so the
  // agentic layer (or a person) can decide, and it may legitimately be empty.
  assert.ok(!isValidGarminRef(hit));
});

test("an invented enum is rejected however plausible it looks", () => {
  assert.equal(isValidGarminRef({ category: "BENCH_PRESS", exercise: "BARBELL_BENCH_PRESS" }), true);
  // Category-only is always legal on a PUT.
  assert.equal(isValidGarminRef({ category: "BENCH_PRESS", exercise: null }), true);
  assert.equal(isValidGarminRef({ category: "KNEE_WIBBLE", exercise: null }), false);
  assert.equal(isValidGarminRef({ category: "BENCH_PRESS", exercise: "TOTALLY_MADE_UP_PRESS" }), false);
  // A real sub-exercise filed under the wrong parent is still invalid.
  assert.equal(isValidGarminRef({ category: "BENCH_PRESS", exercise: "ROMANIAN_DEADLIFT" }), false);
  assert.equal(isValidGarminRef(null), false);
  assert.equal(isValidGarminRef({ category: "", exercise: null }), false);
});

test("the agent's shortlist only ever contains real catalog rows", () => {
  const candidates = garminCandidatesForPrompt("Incline DB Press", 12);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.length <= 12);
  for (const candidate of candidates) assert.ok(isValidGarminRef(candidate), `invalid candidate ${candidate.display}`);
  // No internal score leaks into what the model (or a person) is shown.
  for (const candidate of candidates) assert.equal("score" in candidate, false);
});

test("pounds become grams; assist and bodyweight become no load at all", () => {
  assert.equal(garminWeightGrams(100), 45359);
  assert.equal(garminWeightGrams(null), null);
  // -30 is 30 lb of ASSISTANCE. Writing 30 lb would claim added load.
  assert.equal(garminWeightGrams(-30), null);
  assert.equal(garminWeightGrams(0), null);
});

test("the payload builder carries the Cairn encodings through untouched", () => {
  const payload = buildGarminExerciseSetsPayload({
    sets: [
      {
        exercise: "Barbell Bench Press",
        set_number: 1,
        weight: 100,
        reps: 8,
        duration_sec: null,
        mode: "reps",
        garmin_category: "BENCH_PRESS",
        garmin_exercise: "BARBELL_BENCH_PRESS",
      },
      {
        exercise: "Assisted Pull-Up",
        set_number: 1,
        weight: -30,
        reps: 10,
        duration_sec: null,
        mode: "reps",
        garmin_category: "PULL_UP",
        garmin_exercise: null,
      },
      {
        exercise: "Plank",
        set_number: 1,
        weight: null,
        reps: null,
        duration_sec: 75,
        mode: "timed",
        garmin_category: "PLANK",
        garmin_exercise: null,
      },
    ],
    sessionStartIso: "2026-09-01 12:00:00",
    durationMin: 30,
  });

  assert.equal(payload.mode, "replace");
  assert.equal(payload.written, 3);
  const [bench, assisted, plank] = payload.body.exerciseSets;
  assert.equal(bench.weight, 45359);
  assert.equal(bench.repetitionCount, 8);
  assert.deepEqual(bench.exercises, [{ category: "BENCH_PRESS", name: "BARBELL_BENCH_PRESS", probability: 100 }]);
  assert.equal(assisted.weight, null);
  assert.equal(assisted.repetitionCount, 10);
  // A category-only mapping writes a null sub-name, which Garmin always accepts.
  assert.deepEqual(assisted.exercises, [{ category: "PULL_UP", name: null, probability: 100 }]);
  // A timed hold is seconds, never load or reps.
  assert.equal(plank.duration, 75);
  assert.equal(plank.reps, undefined);
  assert.equal(plank.repetitionCount, null);
  assert.equal(plank.weight, null);
});

test("a lift with no FIT mapping is left out rather than guessed at", () => {
  const payload = buildGarminExerciseSetsPayload({
    sets: [
      {
        exercise: "ZTest Knee Wibble",
        set_number: 1,
        weight: 20,
        reps: 10,
        duration_sec: null,
        mode: "reps",
        garmin_category: null,
        garmin_exercise: null,
      },
      {
        exercise: "Back Squat",
        set_number: 1,
        weight: 185,
        reps: 5,
        duration_sec: null,
        mode: "reps",
        garmin_category: "SQUAT",
        garmin_exercise: null,
      },
    ],
    sessionStartIso: "2026-09-01 12:00:00",
    durationMin: 30,
  });
  assert.equal(payload.written, 1);
  assert.equal(payload.body.exerciseSets.length, 1);
  assert.equal(payload.body.exerciseSets[0].exercises[0].category, "SQUAT");
});

test("FILL only when the watch's ACTIVE slot count matches Cairn's sets", () => {
  const squat = (n) => ({
    exercise: "Back Squat",
    set_number: n,
    weight: 185,
    reps: 5,
    duration_sec: null,
    mode: "reps",
    garmin_category: "SQUAT",
    garmin_exercise: null,
  });
  const active = (i) => ({
    setType: "ACTIVE",
    messageIndex: i,
    startTime: `2026-09-01T07:3${i}:00.0`,
    duration: 40,
    repetitionCount: null,
    weight: null,
    exercises: [{ category: "UNKNOWN", name: null, probability: 100 }],
  });
  const rest = (i) => ({ setType: "REST", messageIndex: i, duration: 90, exercises: null });
  const sets = [squat(1), squat(2), squat(3)];

  const exact = buildGarminExerciseSetsPayload({
    sets,
    existing: { exerciseSets: [active(0), rest(1), active(2), rest(3), active(4)] },
  });
  assert.equal(exact.mode, "fill");
  assert.equal(exact.body.exerciseSets.length, 5);
  assert.equal(exact.body.exerciseSets.filter((s) => s.setType === "REST").length, 2);

  const extra = buildGarminExerciseSetsPayload({
    sets,
    existing: { exerciseSets: [active(0), rest(1), active(2), rest(3), active(4), rest(5), active(6)] },
  });
  assert.equal(extra.mode, "replace");
  assert.equal(extra.body.exerciseSets.length, 3);
});

test("FILL overlays a timed hold's duration, not the watch's slot length", () => {
  const payload = buildGarminExerciseSetsPayload({
    sets: [
      {
        exercise: "Plank",
        set_number: 1,
        weight: null,
        reps: null,
        duration_sec: 75,
        mode: "timed",
        garmin_category: "PLANK",
        garmin_exercise: null,
      },
    ],
    existing: {
      exerciseSets: [
        {
          setType: "ACTIVE",
          startTime: "2026-09-01T07:30:00.0",
          duration: 40,
          repetitionCount: null,
          weight: null,
          exercises: [{ category: "UNKNOWN", name: null, probability: 100 }],
        },
      ],
    },
  });
  assert.equal(payload.mode, "fill");
  assert.equal(payload.body.exerciseSets[0].duration, 75);
  assert.equal(payload.body.exerciseSets[0].startTime, "2026-09-01T07:30:00.0");
});
