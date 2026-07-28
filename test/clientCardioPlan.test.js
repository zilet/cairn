import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCardioPlan() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    RegExp,
    String,
    fmtKm: (km) => Number(km).toFixed(1),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/cardio-plan-client.js"), "utf8"), context);
  return context.CairnCardioPlan;
}

test("planned cardio helpers normalize structured intervals", () => {
  const cardio = loadCardioPlan();
  const interval = [{ reps: 6, on: "800m", off: "90s", zone: "Z5" }];

  assert.equal(cardio.cardioIntervalNote(interval), "6 × 800m");
  assert.equal(cardio.cardioIntervalStructure(interval, "Z5 (165-175 bpm)"), "6 × 800m @ Z5 (165-175 bpm), 90s jog");
  assert.equal(cardio.cardioIntervalNote({ note: "3 mi steady" }), "3 mi steady");
  assert.equal(cardio.cardioIntervalNote(" 30 min easy "), "30 min easy");
});

test("planned cardio helpers separate short labels from coach prose", () => {
  const cardio = loadCardioPlan();

  assert.equal(cardio.isCardioItem({ kind: "cardio" }), true);
  assert.equal(cardio.isCardioItem({ kind: "strength" }), false);
  assert.equal(cardio.cardioLabel({ note: "Long run" }), "Long run");
  assert.equal(
    cardio.cardioLabel({ note: "Nasal-breathing pace. Watch the third kilometer dip.", target_zone: "Z2" }),
    "Easy run"
  );
  assert.equal(
    cardio.cardioDescription({ note: "Nasal-breathing pace. Watch the third kilometer dip." }),
    "Nasal-breathing pace. Watch the third kilometer dip."
  );
  assert.equal(cardio.cardioArtPhrase({ note: "" }), "run");
});

test("running strides do not collide with the ride sport token", () => {
  const cardio = loadCardioPlan();
  const tempo = {
    kind: "cardio",
    exercise: "Tempo run",
    note: "Continuous tempo at Z3; finish with relaxed strides.",
    target_zone: "Z3",
  };

  assert.equal(cardio.cardioSport(tempo), "run");
  assert.equal(cardio.cardioLabel(tempo), "Tempo run");
});

test("exercise-only generated cardio preserves its label, art phrase, and modality", () => {
  const cardio = loadCardioPlan();

  for (const [exercise, sport] of [
    ["Easy ride", "ride"],
    ["Tempo run", "run"],
    ["Pool swim", "swim"],
    ["Erg row", "row"],
    ["Trail hike", "hike"],
  ]) {
    assert.equal(cardio.cardioLabel({ kind: "cardio", exercise }), exercise);
    assert.equal(cardio.cardioArtPhrase({ kind: "cardio", exercise }), exercise);
    assert.equal(cardio.cardioSport({ kind: "cardio", exercise }), sport);
  }
});

test("planned cardio prescription prefers concrete distance, zone, and intervals", () => {
  const cardio = loadCardioPlan();

  assert.equal(
    cardio.cardioPrescription({
      target_distance_km: 12.25,
      target_zone: "Z2",
      interval: [{ reps: 4, on: "1 km", off: "2 min", zone: "Z4" }],
    }),
    "12.3 km · 4 × 1 km @ Z4, 2 min jog"
  );
  assert.equal(
    cardio.cardioPrescription({ target_duration_min: 45, target_zone: "Z3", interval_note: "steady" }),
    "45 min · Z3 · steady"
  );
});
