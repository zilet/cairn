// The coach listening while the athlete logs: one calm line after a set that carries
// a real signal, silence otherwise (src/repo/set-reaction.ts).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SET_REACTION_VARIANTS, setReaction, withSetReaction } from "../dist/repo/set-reaction.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2026-11-16";
const BENCH_CARD = { sets: 3, rep_low: 5, rep_high: 8, target_weight: 140, target_seconds: null };

function set(weight, reps, rir = null, duration_sec = null) {
  return { weight, reps, rir, duration_sec };
}

// Replays a session set by set, the way POST /sets answers each one.
function replay(sets, { prescription = BENCH_CARD, mode = "reps", group = "chest", best = [], date = DATE, step } = {}) {
  return sets.map((_, index) =>
    setReaction({
      date,
      exercise: "Barbell Bench Press",
      mode,
      group,
      sets: sets.slice(0, index + 1),
      prescription,
      best_ever: best.includes(index),
      engine_step: step,
    })
  );
}

test("the live bench evidence: top of the range, then the heavier load, then the card done", () => {
  const [first, second, third] = replay([set(140, 8, 2), set(145, 6), set(145, 5)]);
  assert.equal(first.code, "top_of_range");
  assert.match(first.line, /140/);
  assert.match(first.line, /reps in hand/);
  // One set of the dose: no number is named, the engine steps on the whole dose.
  assert.doesNotMatch(first.line, /next step/);
  assert.equal(second.code, "above_card");
  assert.match(second.line, /145/);
  assert.match(second.line, /working weight/);
  // 145 again is the same signal already answered; the card closing is the news.
  assert.equal(third.code, "card_complete");
  assert.match(third.line, /all 3 sets|Every set the card asked for/);
});

test("every set capped at the load clears the range once; an unrated set never claims reserve", () => {
  const reactions = replay([set(140, 8), set(140, 8), set(140, 8), set(140, 8)], { step: () => "5" });
  assert.equal(reactions[0].code, "top_of_range");
  assert.doesNotMatch(reactions[0].line, /in hand/);
  assert.equal(reactions[1], null, "the same top-of-range signal is not said twice");
  assert.equal(reactions[2].code, "range_cleared");
  assert.match(reactions[2].line, /next step is 5/);
  const held = replay([set(140, 8), set(140, 8), set(140, 8)])[2];
  assert.equal(held.code, "range_cleared");
  assert.doesNotMatch(held.line, /next step/, "no engine step, no number");
  assert.equal(reactions[3], null, "a fourth set at the same dose adds nothing new");
});

test("a grind at the top of the range is not the reserve the hold asked for", () => {
  const [grind] = replay([set(140, 8, 1)]);
  assert.equal(grind, null);
  const [short] = replay([set(140, 6, 3)]);
  assert.equal(short, null, "a set inside the range at the card's load is just work — silence");
});

test("a lighter load or reps under the range never reads as above the card", () => {
  assert.equal(replay([set(135, 8, 2)])[0], null);
  assert.equal(replay([set(150, 3)])[0], null);
});

test("assistance: less assist is harder, more assist is not the top of the range", () => {
  const card = { sets: 3, rep_low: 6, rep_high: 10, target_weight: -30, target_seconds: null };
  const [less] = replay([set(-25, 10, 2)], { prescription: card, group: "back" });
  assert.equal(less.code, "top_of_range");
  assert.match(less.line, /an assist of 25/i);
  assert.doesNotMatch(less.line, /next step/);
  const [more] = replay([set(-35, 10, 2)], { prescription: card, group: "back" });
  assert.equal(more, null);
  const [above] = replay([set(-25, 7)], { prescription: card, group: "back" });
  assert.equal(above.code, "above_card");
  assert.match(above.line, /assist of 25/i);
});

test("bodyweight: the top of the range names no invented load step", () => {
  const card = { sets: 3, rep_low: 8, rep_high: 12, target_weight: null, target_seconds: null };
  const [top] = replay([set(null, 12)], { prescription: card, group: "back" });
  assert.equal(top.code, "top_of_range");
  assert.match(top.line, /bodyweight/);
  assert.doesNotMatch(top.line, /next step/);
});

test("timed: a best hold speaks in holds, and the card completes on seconds", () => {
  const card = { sets: 2, rep_low: null, rep_high: null, target_weight: null, target_seconds: 45 };
  const reactions = replay([set(null, null, null, 50), set(null, null, null, 30), set(null, null, null, 45)], {
    prescription: card,
    mode: "timed",
    group: "core",
    best: [0],
  });
  assert.equal(reactions[0].code, "best_ever");
  assert.match(reactions[0].line, /hold/);
  assert.equal(reactions[1], null, "a short hold under the card is silence, never a judgement");
  assert.equal(reactions[2].code, "card_complete");
});

test("a best-ever ranks under the heavier load but over the card closing", () => {
  const [, above] = replay([set(140, 6), set(150, 6)], { best: [1] });
  assert.equal(above.code, "above_card");
  const sets = [set(140, 6), set(140, 6), set(140, 7)];
  const [, , last] = replay(sets, { best: [2] });
  assert.equal(last.code, "best_ever");
});

test("no card for the lift: only a best-ever can speak", () => {
  const [plain] = replay([set(140, 8, 2)], { prescription: null });
  assert.equal(plain, null);
  const [best] = replay([set(140, 8, 2)], { prescription: null, best: [0] });
  assert.equal(best.code, "best_ever");
});

test("every phrasing holds the reading grammar: no score, no gate, no cheerleading", () => {
  const parts = [
    { load: "140", reps: "8", high: "8", next: "145", reserve: " with reps in hand", setsWord: "all 3 sets" },
    { load: "an assist of 25", reps: "10", high: "10", next: "bodyweight", reserve: "", setsWord: "the one set" },
    { load: "bodyweight", reps: "12", high: "12", next: null, reserve: "", setsWord: "all 4 sets" },
  ];
  let count = 0;
  for (const [variant, templates] of Object.entries(SET_REACTION_VARIANTS)) {
    assert.ok(templates.length >= 3, `${variant} rotates through a variant set`);
    for (const template of templates) {
      for (const p of parts) {
        if (!variant.endsWith("no_step") && /range_cleared$|top_of_range$/.test(variant) && p.next == null) continue;
        const line = template(p);
        count++;
        assert.equal(violatesReadingGrammar(line), null, line);
        assert.doesNotMatch(line, /!|you must|\bundefined\b|\bnull\b/i, line);
        assert.ok(line.length <= 140, `one short line: ${line}`);
      }
    }
  }
  assert.ok(count > 20);
});

test("the wording rotates by day while one day reads the same", () => {
  const lines = new Set();
  for (const date of ["2026-11-16", "2026-11-17", "2026-11-18"]) {
    lines.add(replay([set(140, 8, 2)], { date })[0].line);
  }
  assert.equal(lines.size, 3);
  assert.equal(replay([set(140, 8, 2)])[0].line, replay([set(140, 8, 2)])[0].line);
});

// ---- the store path: what POST /api/sets and log_set answer ----

beforeEach(() => resetTables("daily_session_compositions", "logged_sets", "sessions", "exercises"));

function seedCard(date, items) {
  const sessionId = Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(date).lastInsertRowid);
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, title, items_json, constraints_json, provenance_json, request_fingerprint)
     VALUES (1, ?, ?, 'manual_plan', 'active', 'Push', ?, '{}', '{}', ?)`
  ).run(sessionId, date, JSON.stringify(items), "f".repeat(64));
  return sessionId;
}

function logged(input) {
  return withSetReaction(repo.logSetByName(input, { enrich: false }));
}

test("a logged set answers with its reaction against today's card", () => {
  repo.logSetByName({ exercise: "Barbell Bench Press", weight: 135, reps: 8, rir: 2, date: "2026-11-09" });
  seedCard(DATE, [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 140, mode: "reps" },
  ]);
  const first = logged({ exercise: "Barbell Bench Press", weight: 140, reps: 8, rir: 2, date: DATE });
  assert.equal(first.reaction?.code, "top_of_range", JSON.stringify(first.reaction));
  const second = logged({ exercise: "Barbell Bench Press", weight: 145, reps: 6, date: DATE });
  assert.equal(second.reaction?.code, "above_card");
  const third = logged({ exercise: "Barbell Bench Press", weight: 145, reps: 5, date: DATE });
  assert.equal(third.reaction?.code, "card_complete");
  // The write itself is untouched.
  assert.equal(third.weight, 145);
  assert.equal(third.reps, 5);
});

test("a first-ever session never hears best-ever, and a silent set carries no field", () => {
  const first = logged({ exercise: "Cable Fly", weight: 40, reps: 12, date: DATE });
  assert.equal(first.pr, true, "the set write still calls it a PR");
  assert.equal(first.reaction, undefined);
  const later = logged({ exercise: "Cable Fly", weight: 50, reps: 12, date: "2026-11-20" });
  assert.equal(later.reaction?.code, "best_ever");
  const flat = logged({ exercise: "Cable Fly", weight: 30, reps: 12, date: "2026-11-20" });
  assert.equal("reaction" in flat, false);
});

test("one lift on two cards has no single dose to judge, so only a best-ever could speak", () => {
  seedCard(DATE, [
    { exercise: "Back Squat", sets: 1, rep_low: 2, rep_high: 3, target_weight: 250, mode: "reps" },
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6, target_weight: 215, mode: "reps" },
  ]);
  const top = logged({ exercise: "Back Squat", weight: 250, reps: 3, rir: 2, date: DATE });
  assert.equal(top.reaction, undefined);
});

// ---- the session read keeps the line across a repaint ----

const BENCH = "Barbell Bench Press";
const benchCard = () =>
  seedCard(DATE, [{ exercise: BENCH, sets: 3, rep_low: 5, rep_high: 8, target_weight: 140, mode: "reps" }]);

test("the session read hangs the very line POST answered on the lift's last set", () => {
  repo.logSetByName({ exercise: BENCH, weight: 135, reps: 8, rir: 2, date: "2026-11-09" });
  benchCard();
  const first = logged({ exercise: BENCH, weight: 140, reps: 8, rir: 2, date: DATE });
  let sets = repo.getSessionByDate(DATE).sets;
  assert.deepEqual(sets[0].reaction, first.reaction);
  const second = logged({ exercise: BENCH, weight: 145, reps: 6, date: DATE });
  sets = repo.getSessionByDate(DATE).sets;
  assert.equal(sets[0].reaction, undefined, "only the last set carries it");
  assert.deepEqual(sets[1].reaction, second.reaction);
  // A silent set leaves the standing line, exactly as the card does.
  const silent = logged({ exercise: BENCH, weight: 100, reps: 3, date: DATE });
  assert.equal(silent.reaction, undefined);
  sets = repo.getSessionByDate(DATE).sets;
  assert.deepEqual(sets[2].reaction, second.reaction);
  // Finishing the session keeps it.
  repo.finishSession(sets[0].session_id, null);
  assert.deepEqual(repo.getSessionByDate(DATE).sets[2].reaction, second.reaction);
});

test("a deleted set stops yielding its line; nothing to say leaves the field absent", () => {
  repo.logSetByName({ exercise: BENCH, weight: 135, reps: 8, rir: 2, date: "2026-11-09" });
  benchCard();
  const only = logged({ exercise: BENCH, weight: 140, reps: 8, rir: 2, date: DATE });
  assert.ok(only.reaction);
  repo.deleteSet(Number(only.id));
  assert.equal(repo.getSessionByDate(DATE)?.sets?.length ?? 0, 0);
  const quiet = logged({ exercise: BENCH, weight: 100, reps: 3, date: DATE });
  assert.equal(quiet.reaction, undefined);
  const row = repo.getSessionByDate(DATE).sets[0];
  assert.equal("reaction" in row, false);
});

test("a range cleared names the step the progression engine would take, or none", () => {
  for (const date of ["2026-11-02", "2026-11-09"]) {
    for (let i = 0; i < 3; i++) repo.logSetByName({ exercise: BENCH, weight: 140, reps: 8, rir: 2, date });
  }
  benchCard();
  logged({ exercise: BENCH, weight: 140, reps: 8, rir: 2, date: DATE });
  logged({ exercise: BENCH, weight: 140, reps: 8, rir: 2, date: DATE });
  const started = process.hrtime.bigint();
  const third = logged({ exercise: BENCH, weight: 140, reps: 8, rir: 2, date: DATE });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(third.reaction?.code, "range_cleared");
  const rx = repo.nextPrescription(BENCH, undefined, { date: DATE, autoreg: null, acute: null });
  const to = rx?.action === "overload" ? rx.suggested?.weight : null;
  if (to != null && to > 140) assert.match(third.reaction.line, new RegExp(`next step is ${to - 140}\\b`));
  else assert.doesNotMatch(third.reaction.line, /next step/);
  assert.ok(ms < 250, `the engine read stays cheap on the set write (${ms.toFixed(1)} ms)`);
});
