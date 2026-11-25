// One lift, one name, on every path a spelling can enter by. The real case: the stored
// lift is "Dumbbell Biceps Curl"; the variation table and an agent write "DB Bicep
// Curl"; the resolver knows they are one lift. Each path below once let the other
// spelling through as a second lift (a second card on Today, a self-swap that
// re-stamped the slot, a skip that missed the logged lift, a suggestion that offered the
// lift itself). Every case runs twice: with the persisted alias row the live catalog
// has, and without it (the abbreviation tier resolves "DB" → dumbbell on its own).
// Deterministic, offline; the root beforeEach wipes the DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { findExercise, findExerciseExact, findOrCreateExercise, deleteExercise } from "../dist/repo/exercises.js";
import { liftAlternatives, liftVariations } from "../dist/repo/exercise-suggestions.js";
import { suggestAlternatives } from "../dist/repo/exercise-variations.js";
import { sameLiftName } from "../dist/repo/exercise-canon.js";
import { buildReactionModel } from "../dist/repo/reaction-model.js";
import { applySwapSmart } from "../dist/repo/plan-swap.js";

const STORED = "Dumbbell Biceps Curl";
const ALIAS = "DB Bicep Curl";
const DATE = "2031-04-14";

function seedLift({ alias }) {
  repo.upsertExercise({ name: STORED, muscle_group: "biceps", mode: "reps" });
  if (alias) {
    db.prepare(`INSERT INTO exercise_aliases (alias, canonical, source) VALUES (?, ?, 'auto')`).run(
      "db bicep curl",
      STORED
    );
  }
  return findExerciseExact(STORED);
}

function planItemRow(dayNumber, exerciseId) {
  return db
    .prepare(
      `SELECT pi.* FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
        WHERE pd.day_number = ? AND pi.exercise_id = ?`
    )
    .get(dayNumber, exerciseId);
}

function seedArmsDay() {
  repo.savePlanDay(3, "Arms", "Arms", [
    { exercise: STORED, sets: 3, rep_low: 8, rep_high: 12, target_weight: 30, note: "Slow lowering" },
    { exercise: "Triceps Rope Pushdown", sets: 3, rep_low: 10, rep_high: 15, target_weight: 50 },
  ]);
  // An established slot: a stamp well behind today, so a fresh write would show.
  db.prepare(`UPDATE plan_items SET prescribed_at = '2026-01-05'`).run();
}

for (const alias of [true, false]) {
  const label = alias ? "with the alias row" : "without an alias row";

  // ── (2) findExercise falls back to the resolver; the writers keep exact ──────
  test(`findExercise resolves the other spelling to the stored row (${label})`, () => {
    const stored = seedLift({ alias });
    assert.equal(findExercise(ALIAS)?.id, stored.id, "an alias spelling finds the stored row");
    assert.equal(findExerciseExact(ALIAS), undefined, "the exact lookup still misses it");
    assert.equal(findExercise("Zercher Good Morning"), undefined, "a name that resolves to nothing is still a miss");

    // The create chokepoint reuses the stored row and never retitles it to the alias.
    assert.equal(findOrCreateExercise(ALIAS).id, stored.id);
    assert.equal(findExerciseExact(STORED)?.name, STORED);
    // A delete names one exact row; an alias spelling never deletes the stored lift.
    assert.equal(deleteExercise(ALIAS).ok, false);
    assert.ok(findExerciseExact(STORED), "the stored lift survives a delete by its other spelling");
  });

  // ── (1) a composed card carries the stored name ──────────────────────────────
  test(`a card item written in the other spelling carries the stored name (${label})`, () => {
    seedLift({ alias });
    const prepared = repo.prepareDailySession({
      date: DATE,
      source: "athlete_override",
      session: {
        name: "Arms",
        why: "Arms today.",
        items: [
          { exercise: ALIAS, sets: 3, rep_low: 8, rep_high: 12, target_weight: 30 },
          { exercise: "Zercher Good Morning", sets: 2, rep_low: 5, rep_high: 5 },
        ],
      },
    });
    assert.equal(prepared.ok, true);
    const names = prepared.daily_session.items.map((item) => item.exercise);
    assert.deepEqual(names, [STORED, "Zercher Good Morning"], "stored name for a known lift, as written for a new one");

    // A set logged from the card lands under the same name the card carries, so the
    // client's exact-name pairing finds ONE card.
    repo.logSetByName({ exercise: ALIAS, weight: 30, reps: 10, date: DATE });
    const session = repo.getSessionByDate(DATE);
    assert.deepEqual([...new Set(session.sets.map((set) => set.exercise))], [STORED]);
    assert.ok(session.daily_session.items.some((item) => item.exercise === session.sets[0].exercise));
  });

  test(`an agent suggestion and an already-stored card read back under the stored name (${label})`, () => {
    seedLift({ alias });
    const suggestion = repo.normalizeSessionSuggestionResult({
      name: "Arms",
      why: "Arms today.",
      items: [{ exercise: ALIAS, sets: 3, rep_low: 8, rep_high: 12, target_weight: 30 }],
    });
    assert.equal(suggestion.items[0].exercise, STORED);

    // A card written before the fix still holds the raw spelling; the read chokepoint
    // hands it back under the stored name.
    const prepared = repo.prepareDailySession({
      date: DATE,
      source: "athlete_override",
      session: { name: "Arms", why: "Arms today.", items: [{ exercise: STORED, sets: 3, rep_low: 8, rep_high: 12 }] },
    });
    const row = db.prepare(`SELECT id, items_json FROM daily_session_compositions WHERE id = ?`).get(prepared.daily_session.id);
    const items = JSON.parse(row.items_json);
    items[0].exercise = ALIAS;
    db.prepare(`UPDATE daily_session_compositions SET items_json = ? WHERE id = ?`).run(JSON.stringify(items), row.id);
    assert.equal(repo.getActiveDailySession(DATE).items[0].exercise, STORED);
  });

  // ── (4) a swap into the lift's own other spelling is a clean no-op ──────────
  test(`a self-swap leaves the slot untouched and reports nothing changed (${label})`, () => {
    const stored = seedLift({ alias });
    seedArmsDay();
    const before = planItemRow(3, stored.id);

    const result = repo.applyPlanChange({ day_number: 3, swap: { from: STORED, to: ALIAS } }, { clamp: true });
    assert.equal(result.action, "unchanged");
    assert.equal(result.unchanged, "same_lift");
    assert.equal(result.updated, 0);
    assert.deepEqual(planItemRow(3, stored.id), before, "note, targets and the authorship stamp all stand");

    // A lone self-swap proposal applies nothing and says so.
    const lone = repo.createProposal("exercise-swap", "swap", "", {
      summary: "Rotate",
      changes: [{ day_number: 3, swap: { from: STORED, to: ALIAS }, reason: "Rotate." }],
    });
    const loneResult = repo.applyProposal(lone.id);
    assert.equal(loneResult.ok, false);
    assert.match(loneResult.error, /Nothing to change/);
    assert.deepEqual(planItemRow(3, stored.id), before);

    // Inside a larger proposal it never fails the real change beside it.
    const mixed = repo.createProposal("coach", "mixed", "", {
      summary: "Two parts",
      changes: [
        { day_number: 3, swap: { from: STORED, to: ALIAS }, reason: "Rotate." },
        { day_number: 3, exercise: "Triceps Rope Pushdown", rep_low: 12, reason: "Earned." },
      ],
    });
    const mixedResult = repo.applyProposal(mixed.id);
    assert.equal(mixedResult.ok, true, JSON.stringify(mixedResult));
    assert.deepEqual(planItemRow(3, stored.id), before, "the curl slot is still exactly as it was");
    const pushdown = findExerciseExact("Triceps Rope Pushdown");
    assert.equal(planItemRow(3, pushdown.id).rep_low, 12);

    // The one-tap rotate is honest about it too.
    const smart = applySwapSmart(STORED, ALIAS, 3);
    assert.equal(smart.ok, false);
    assert.deepEqual(planItemRow(3, stored.id), before);
  });

  // ── (5) a skip in the other spelling hits the stored lift ───────────────────
  test(`a skip in the other spelling is the stored lift's skip (${label})`, () => {
    seedLift({ alias });
    const skipped = repo.skipExercise(ALIAS, DATE);
    assert.equal(skipped.ok, true);
    assert.equal(skipped.exercise, STORED);
    assert.deepEqual(skipped.skips, [STORED]);
    assert.equal(repo.unskipExercise(ALIAS, DATE).removed, 1, "un-skipping either spelling clears it");

    // Sets already logged under the stored name refuse a skip in the other spelling.
    repo.logSetByName({ exercise: STORED, weight: 30, reps: 10, date: DATE });
    const refused = repo.skipExercise(ALIAS, DATE);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /already has logged sets/);
  });

  test(`a skip stored in the other spelling reads back as the stored lift (${label})`, () => {
    seedLift({ alias });
    const session = repo.getOrCreateSession(DATE);
    db.prepare(`INSERT INTO session_skips (session_id, exercise) VALUES (?, ?)`).run(session.id, ALIAS);
    assert.deepEqual(repo.getSessionByDate(DATE).skips, [STORED]);
    assert.equal(repo.unskipExercise(STORED, DATE).removed, 1);
  });

  test(`the skip count reads one lift across both spellings (${label})`, () => {
    seedLift({ alias });
    // Four-plus weeks of history (the adherence gate), two skips in two spellings.
    const first = repo.getOrCreateSession("2031-03-01");
    const second = repo.getOrCreateSession("2031-04-10");
    db.prepare(`INSERT INTO session_skips (session_id, exercise) VALUES (?, ?)`).run(first.id, ALIAS);
    db.prepare(`INSERT INTO session_skips (session_id, exercise) VALUES (?, ?)`).run(second.id, STORED);
    const adherence = buildReactionModel().patterns.find((pattern) => pattern.id === "adherence");
    assert.ok(adherence, "two skips of one lift are a pattern");
    assert.match(adherence.statement, /Dumbbell Biceps Curl gets skipped the most/);
    assert.equal(adherence.params.top_skip_n, 2);
  });

  // ── (3) suggestion lists never offer a lift's own other spelling ────────────
  test(`suggestions drop the lift's own spelling and speak stored names (${label})`, () => {
    seedLift({ alias });
    assert.ok(
      suggestAlternatives(STORED, { limit: 20 }).some((v) => v.name === ALIAS),
      "the table itself still lists the alias as a different movement"
    );
    for (const list of [liftAlternatives(STORED, { limit: 20 }), liftVariations(STORED, { limit: 20 })]) {
      assert.ok(list.length > 0, "real alternatives are still offered");
      for (const v of list) assert.ok(!sameLiftName(v.name, STORED), `${v.name} is the same lift`);
    }
    assert.equal(liftVariations(STORED, { limit: 3 }).length, 3, "a dropped alias never shortens the list");

    // From another curl, the candidate is named by its stored spelling...
    const fromHammer = liftAlternatives("Hammer Curl", { limit: 20 }).map((v) => v.name);
    assert.ok(fromHammer.includes(STORED));
    assert.ok(!fromHammer.includes(ALIAS));
    // ...and an excluded lift is excluded in either spelling.
    const excluded = liftAlternatives("Hammer Curl", { limit: 20, excludeNames: [STORED] }).map((v) => v.name);
    assert.ok(!excluded.some((name) => sameLiftName(name, STORED)));
  });
}

test("suggestions for names that resolve to nothing are the table's own list", () => {
  for (const name of ["Barbell Bench Press", "Back Squat", "Hammer Curl"]) {
    assert.deepEqual(liftAlternatives(name, { limit: 5 }), suggestAlternatives(name, { limit: 5 }));
    assert.deepEqual(
      liftAlternatives(name, { limit: 4, preferCompound: true, excludeNames: ["Front Squat"] }),
      suggestAlternatives(name, { limit: 4, preferCompound: true, excludeNames: ["Front Squat"] })
    );
  }
});
