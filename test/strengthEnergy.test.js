// What a finished strength session plausibly cost — for Garmin's calendar only
// (repo/strength-energy.ts). Gross kcal = MET × kg × hours, MET from the 2024 Adult
// Compendium: 3.5 general (02054), 5.0 heavy squat/deadlift (02052), 5.8 circuit /
// supersets (02055).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CIRCUIT_MIN_SETS, estimateStrengthKcal, estimateStrengthSessionKcal } from "../dist/repo/strength-energy.js";
import { repo, isoDaysAgo } from "./_seed.js";

const KG = 80;

function sets(exercise, n, extra = {}) {
  return Array.from({ length: n }, () => ({ exercise, weight: 100, reps: 10, ...extra }));
}

// n sets spaced `gapSec` apart from a fixed UTC start — the created_at shape SQLite writes.
function timed(list, gapSec) {
  const start = Date.parse("2026-09-20T12:00:00Z");
  return list.map((set, i) => ({
    ...set,
    created_at: new Date(start + i * gapSec * 1000).toISOString().slice(0, 19).replace("T", " "),
  }));
}

test("a general multi-exercise session prices at Compendium 02054 (3.5 MET)", () => {
  const e = estimateStrengthKcal({
    sets: [...sets("Bench Press", 4), ...sets("Barbell Row", 4), ...sets("Bicep Curl", 4)],
    duration_min: 45,
    bodyweight_kg: KG,
  });
  assert.equal(e.basis, "general");
  assert.equal(e.met, 3.5);
  assert.equal(e.compendium_code, "02054");
  assert.equal(e.minutes, 45);
  assert.equal(e.kcal, Math.round(3.5 * KG * (45 / 60)));
});

test("loaded squat/hinge compounds dominating the working sets price at 02052 (5.0 MET)", () => {
  const e = estimateStrengthKcal({
    sets: [...sets("Back Squat", 5), ...sets("Romanian Deadlift", 3), ...sets("Leg Curl", 3), ...sets("Calf Raise", 3)],
    duration_min: 50,
    bodyweight_kg: KG,
  });
  assert.equal(e.basis, "heavy_compound");
  assert.equal(e.met, 5.0);
  assert.equal(e.kcal, Math.round(5 * KG * (50 / 60)));

  // A leg curl is a "hinge" in the swap table but isolation work by region; a
  // bodyweight squat is not heavy loaded work. Neither counts toward the share.
  const light = estimateStrengthKcal({
    sets: [...sets("Leg Curl", 6), ...sets("Air Squat", 4, { weight: null }), ...sets("Bench Press", 4)],
    duration_min: 40,
    bodyweight_kg: KG,
  });
  assert.equal(light.basis, "general");
});

test("sustained paired/circuit density prices at 02055 (5.8 MET); batch logging does not", () => {
  const list = [...sets("Bench Press", 6), ...sets("Barbell Row", 6)];
  // 12 sets over 22 minutes: 0.52 sets/min — supersets, not straight sets with rest.
  const circuit = estimateStrengthKcal({ sets: timed(list, 120), duration_min: 30, bodyweight_kg: KG });
  assert.equal(circuit.basis, "circuit");
  assert.equal(circuit.met, 5.8);

  // Straight sets with ~3 min rest: 12 sets over 33 minutes.
  const straight = estimateStrengthKcal({ sets: timed(list, 180), duration_min: 40, bodyweight_kg: KG });
  assert.equal(straight.basis, "general");

  // All twelve typed in at the end, 10 s apart: timestamps prove nothing.
  const batch = estimateStrengthKcal({ sets: timed(list, 10), duration_min: 40, bodyweight_kg: KG });
  assert.equal(batch.basis, "general");

  // Too few sets to call it sustained.
  const burst = estimateStrengthKcal({
    sets: timed(sets("Bench Press", CIRCUIT_MIN_SETS - 1), 120),
    duration_min: 30,
    bodyweight_kg: KG,
  });
  assert.equal(burst.basis, "general");
});

test("a session left open is capped at the working time its sets account for", () => {
  // The real case: 12 sets, session open 108 minutes. 12 × 3.5 + 8 = 50.
  const e = estimateStrengthKcal({
    sets: [...sets("Bench Press", 6), ...sets("Lat Pulldown", 6)],
    duration_min: 108,
    bodyweight_kg: KG,
  });
  assert.equal(e.minutes, 50);
  assert.equal(e.kcal, Math.round(3.5 * KG * (50 / 60)));

  // No duration at all: the set-derived time.
  const noDuration = estimateStrengthKcal({ sets: sets("Bench Press", 4), duration_min: null, bodyweight_kg: KG });
  assert.equal(noDuration.minutes, 4 * 3.5 + 8);

  // A duration shorter than the cap is the truth.
  const short = estimateStrengthKcal({ sets: sets("Bench Press", 12), duration_min: 32, bodyweight_kg: KG });
  assert.equal(short.minutes, 32);
});

test("no bodyweight or no working set is no estimate", () => {
  assert.equal(estimateStrengthKcal({ sets: sets("Bench Press", 4), duration_min: 30, bodyweight_kg: null }), null);
  assert.equal(estimateStrengthKcal({ sets: sets("Bench Press", 4), duration_min: 30, bodyweight_kg: 0 }), null);
  assert.equal(estimateStrengthKcal({ sets: [], duration_min: 30, bodyweight_kg: KG }), null);
  assert.equal(
    estimateStrengthKcal({ sets: sets("Bench Press", 3, { reps: 0 }), duration_min: 30, bodyweight_kg: KG }),
    null,
    "a set with no reps and no duration did no work"
  );
});

test("assisted and timed sets never break the estimate", () => {
  const e = estimateStrengthKcal({
    sets: [
      ...sets("Assisted Pull Up", 4, { weight: -40 }),
      ...sets("Plank", 3, { weight: null, reps: null, duration_sec: 60, mode: "timed" }),
      ...sets("Farmer's Walk", 2, { weight: 70, reps: null, duration_sec: 45, mode: "timed" }),
    ],
    duration_min: 30,
    bodyweight_kg: KG,
  });
  assert.equal(e.basis, "general");
  assert.equal(e.minutes, 30);
  assert.equal(e.kcal, Math.round(3.5 * KG * 0.5));
});

test("the stored session prices off the canonical bodyweight as of its own date", () => {
  const date = isoDaysAgo(2);
  for (let i = 0; i < 4; i++) repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 8, date });
  const session = repo.getSessionByDate(date);
  repo.finishSession(session.id);
  assert.equal(estimateStrengthSessionKcal(session.id), null, "no bodyweight anywhere → no estimate");

  repo.logWeight(176.4, isoDaysAgo(5)); // 80.0 kg
  const e = estimateStrengthSessionKcal(session.id);
  assert.equal(e.bodyweight_kg, 80);
  // A later weigh-in never re-prices an older session.
  repo.logWeight(220, isoDaysAgo(0));
  assert.equal(estimateStrengthSessionKcal(session.id).kcal, e.kcal);
});
