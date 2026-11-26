// The plateau ladder's effort lever reaches the LIVE Today card (today-set-quality.ts): the
// adaptive candidate (and the coachOps composition) hand composition the ladder's
// `set_quality` plan lifts, read once per date from what program state's capability pass
// already computed — never a ladder of its own — on train reads only, failing closed.
// Synthetic fixtures; deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { SET_QUALITY_NOTES } from "../dist/repo/composition-set-quality.js";
import { todaySetQualityLifts } from "../dist/repo/today-set-quality.js";
import { buildAdaptiveDailySessionCandidate } from "../dist/repo/adaptive-session.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { unitPlateauLadder } from "../dist/repo/unit-plateau.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

const today = () => localDateISO();
const day = (delta) => addDaysISO(today(), delta);
// Weekly sessions on today's weekday, the last a week ago: a matured plateau, today reads as
// his lifting day (the observed weekday), nothing is still recovering, and the loaded-weeks
// streak stays short of a deload (which would make today an easy read).
const WEEKS = [35, 28, 21, 14, 7];

function sql(statement, ...args) {
  db.prepare(statement).run(...args);
  bumpTrainingDataVersion();
}

// A pushdown stuck at 50 for 12, 11, 10, every set ending with three in reserve, its
// rep-range lever already spent inside the plateau: the ladder's next lever is effort.
function effortPlateau() {
  repo.upsertExercise({ name: "Rope Pushdown", muscle_group: "triceps", mode: "reps" });
  repo.replacePlan([
    {
      day_number: 1,
      name: "Arms",
      items: [{ exercise: "Rope Pushdown", muscle_group: "triceps", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 }],
    },
  ]);
  sql(`UPDATE plan_items SET prescribed_at = ?`, day(-200));
  for (const d of WEEKS)
    for (const reps of [12, 11, 10]) repo.logSetByName({ exercise: "Rope Pushdown", weight: 50, reps, rir: 3, date: day(-d) });
  const parsed = {
    changes: [{ day_number: 1, exercise: "Rope Pushdown", rep_low: 10, rep_high: 12, progression_escalation: "rep_range" }],
  };
  sql(
    `INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json, status, created_at)
     VALUES ('progression', 'x', '', ?, 'applied', datetime('now', '-70 days'))`,
    JSON.stringify(parsed)
  );
}

const pushdownOf = (candidate) => candidate.prepared.payload.items.find((i) => i.exercise === "Rope Pushdown");
const effortNote = (item) => SET_QUALITY_NOTES.some((text) => String(item?.note ?? "").includes(text));

test("the live adaptive candidate carries the ladder's effort note on the plan lift", () => {
  effortPlateau();
  const rung = unitPlateauLadder(today()).units.find((u) => u.unit_key === "triceps:pushdown");
  assert.equal(rung?.lever, "set_quality", `precondition: ${JSON.stringify(rung)}`);
  const candidate = runWithBrainSnapshot(() => buildAdaptiveDailySessionCandidate({ date: today() }));
  const env = candidate.decision.envelope;
  assert.equal(
    env.kind,
    "train",
    `precondition: a train read (${env.kind}): ${JSON.stringify({ rationale: env.rationale, hard: env.hard_constraints, soft: env.soft_preferences, template: env.template })}`
  );
  assert.equal(env.caps.intensity, "normal", "precondition: a plain training day");
  const item = pushdownOf(candidate);
  assert.ok(item, "the plan lift is on the card");
  assert.ok(effortNote(item), `the effort note rides the plan lift: ${item.note}`);
  // Never a load: the weight is the plan's (the next test holds the whole card to the
  // card composed without the note).
  assert.equal(item.target_weight, 50);
});

test("no note on an easy or rest read, and a ladder that cannot be read is no note with the card unchanged", () => {
  effortPlateau();
  assert.equal(todaySetQualityLifts(today(), { kind: "easy" }), null);
  assert.equal(todaySetQualityLifts(today(), { kind: "rest" }), null);
  assert.equal(todaySetQualityLifts("not-a-date", { kind: "train" }), null);
  assert.equal(todaySetQualityLifts(today(), { kind: "train" })?.size, 1, "a train read gets the pushdown");
  const withNote = runWithBrainSnapshot(() => buildAdaptiveDailySessionCandidate({ date: today() }));
  // The ladder's own query fails: program state's pass gets no ladder, so the card has no note.
  bumpTrainingDataVersion();
  const original = db.prepare;
  db.prepare = function (statement, ...rest) {
    if (/FROM plan_proposals p[\s\S]*held_by_user/.test(String(statement))) throw new Error("ladder unavailable (fixture)");
    return original.call(this, statement, ...rest);
  };
  let without;
  try {
    without = runWithBrainSnapshot(() => buildAdaptiveDailySessionCandidate({ date: today() }));
  } finally {
    db.prepare = original;
  }
  assert.ok(effortNote(pushdownOf(withNote)), "precondition: the note is there when the ladder reads");
  assert.ok(!effortNote(pushdownOf(without)), "a failed ladder: no note");
  const strip = (items) => items.map(({ note: _note, ...rest }) => rest);
  assert.deepEqual(strip(without.prepared.payload.items), strip(withNote.prepared.payload.items), "and nothing else moved");
});

test("the note's cost on Today: no ladder of its own once program state is in hand", (t) => {
  effortPlateau();
  const d = today();
  // For the record: what a ladder of its own would have cost on the same open.
  runWithBrainSnapshot(() => {
    getProgramState(d);
    const original = db.prepare;
    let statements = 0;
    db.prepare = function (...args) {
      statements += 1;
      return original.apply(this, args);
    };
    try {
      unitPlateauLadder(d);
    } finally {
      db.prepare = original;
    }
    t.diagnostic(`a bare ladder after program state: ${statements} statements`);
  });
  runWithBrainSnapshot(() => {
    getProgramState(d);
    const original = db.prepare;
    let statements = 0;
    let ladders = 0;
    db.prepare = function (statement, ...rest) {
      statements += 1;
      if (/FROM plan_proposals p[\s\S]*held_by_user/.test(String(statement))) ladders += 1;
      return original.call(this, statement, ...rest);
    };
    let lifts;
    try {
      lifts = todaySetQualityLifts(d, { kind: "train" });
    } finally {
      db.prepare = original;
    }
    t.diagnostic(`the note read after program state: ${statements} statements`);
    assert.ok(lifts?.size === 1, "the pushdown is on the effort rung");
    assert.equal(ladders, 0, "the ladder is never recomputed for the note");
    // Measured: the program-state memo hit and the cache key's reads (data version and
    // backstop signature), a handful of statements at most.
    assert.ok(statements <= 6, `the note read prepared ${statements} statements`);
  });
});
