// ONE GATE FOR A LOAD STEP (src/repo/progression.ts). The rule:
//   - A load step earned by EVERY working set capping the range at the card's load (full
//     double progression) is not a cut question: the work was done and the log is the
//     truth, so it steps under every cut shape, on both drives (the decision of 578ef427).
//   - Every step earned on LESS than that — the push top set alone, an intensification top
//     set, push's single met exposure, the repetition pair, a re-ground's catch-up plus step
//     where the sets were not all capped — passes the cut's veto (cutVetoesPromotion):
//     `sliding` always, `reduce` unless near goal. `hold` and `fast_loss` never veto.
//   - On EVERY path, full double progression included: no failed attempt at more in the
//     latest session (failedHeavierAttempt — a set above the load under the rep floor),
//     unless the card asked for that heavier set at those reps (the reach) or it was logged
//     with two or more reps in reserve (a feeler).
// Before the gate, push's top-set step ignored the cut (push + sliding stepped) and every
// step ignored a 145 × 4 miss. A rep advance inside the range is never vetoed.
// Deterministic, offline, temp DB (test/run.mjs wipes it before every test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo } from "./_seed.js";
import { nextPrescription } from "../dist/repo/progression.js";
import * as voice from "../dist/repo/progression-voice.js";
import * as blocks from "../dist/repo/program-blocks.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { setExerciseAlias } from "../dist/repo/exercise-canon.js";

const isoDaysAgo = (n) => localDaysAgo(n);
const LIFT = "Barbell Bench Press";

const cut = (over = {}) => {
  const c = { hold: false, reduce: false, sliding: false, fast_loss: false, near_goal: false, ...over };
  return { ...c, deep: c.sliding || c.fast_loss, any: c.hold || c.reduce || c.sliding || c.fast_loss };
};

// Each cut shape, and whether it vetoes a step earned on less than every set capped.
const CUTS = [
  ["no pressure", cut(), false],
  ["a soft fuel hold", cut({ hold: true }), false],
  ["reduce away from goal", cut({ reduce: true }), true],
  ["reduce near goal", cut({ reduce: true, near_goal: true }), false],
  ["fast loss", cut({ fast_loss: true }), false],
  ["fast loss + hold", cut({ fast_loss: true, hold: true }), false],
  ["a sliding cut", cut({ sliding: true }), true],
  ["a sliding cut near goal", cut({ sliding: true, near_goal: true }), true],
];

const read = (drive, pressure) =>
  nextPrescription(LIFT, undefined, { autoreg: null, acute: null, drive, pushStance: false, cut: pressure });

function wipe() {
  for (const t of ["daily_session_compositions", "logged_sets", "sessions", "plan_items", "plan_days", "program_blocks"])
    db.prepare(`DELETE FROM ${t}`).run();
}

// Bench 3 × 6–8, an established slot at `target`; `sessions` = [daysAgo, [[weight, reps], …]].
function bench(sessions, { target = 140, block = null } = {}) {
  repo.upsertExercise({ name: LIFT, muscle_group: "chest", mode: "reps" });
  const day = repo.savePlanDay(1, "Day 1", null, [
    { exercise: LIFT, sets: 3, rep_low: 6, rep_high: 8, target_weight: target },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(isoDaysAgo(90), day.id);
  const ex = repo.findExercise(LIFT);
  const ids = [];
  for (const [daysAgo, rows] of sessions) {
    const session = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
    rows.forEach(([weight, reps], i) =>
      db
        .prepare(
          `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(session.id, ex.id, i + 1, weight, reps, null)
    );
    ids.push(session.id);
  }
  if (block) blocks.createBlock(block);
  return ids;
}

const missSentences = voice.FAILED_HEAVIER_ATTEMPT_HOLD.map((fn) => fn("140 lb"));
const capped = [[140, 8], [140, 8], [140, 8]];
const topOnly = [[140, 8], [140, 7], [140, 6]];
const nearCapped = [[140, 8], [140, 8], [140, 7]];
const INTENSIFICATION = { goal: "Sharpen", focus: "strength", total_weeks: 6, week_index: 5 };

function assertStep(p, label) {
  assert.equal(p.action, "overload", `${label}: ${p.why}`);
  assert.equal(p.suggested.weight, 145, `${label}: one step off the 140 worked`);
  assert.equal(p.cut_held, undefined, label);
  assert.equal(violatesReadingGrammar(p.why), null, label);
}
function assertHeld(p, label, sentences) {
  assert.equal(p.action, "hold", `${label}: ${p.why}`);
  assert.equal(p.suggested.weight, 140, `${label}: the load stays`);
  if (sentences) assert.ok(sentences.includes(p.why), `${label}: ${p.why}`);
  assert.equal(p.earned_by, undefined, label);
  assert.equal(violatesReadingGrammar(p.why), null, label);
}

// ---- full double progression: not a cut question ---------------------------------------

for (const drive of ["steady", "push"]) {
  for (const [label, pressure] of CUTS) {
    test(`${drive}: every set capped steps under ${label}`, () => {
      bench([[4, capped]]);
      assertStep(read(drive, pressure), `${drive} / ${label}`);
    });
    test(`${drive}: a re-ground with every set capped catches up and steps under ${label}`, () => {
      bench([[4, capped]], { target: 120 });
      const p = read(drive, pressure);
      assert.equal(p.reground, true);
      assertStep(p, `${drive} / ${label}`);
    });
  }
}

// ---- every lesser step: the cut's veto ---------------------------------------------------

const LESSER = [
  ["push: the top set alone", "push", () => bench([[4, topOnly]])],
  ["push: the top set twice", "push", () => bench([[10, nearCapped], [4, nearCapped]])],
  ["steady: the repetition pair", "steady", () => bench([[10, nearCapped], [4, nearCapped]])],
  ["steady: an intensification top set", "steady", () => bench([[4, topOnly]], { block: INTENSIFICATION })],
];

// Every set capped is full work in any phase: an intensification block's capped card is
// not a cut question either.
for (const [label, pressure] of CUTS) {
  test(`steady: every set capped inside an intensification block steps under ${label}`, () => {
    bench([[4, capped]], { block: INTENSIFICATION });
    assertStep(read("steady", pressure), `intensification capped / ${label}`);
  });
}

for (const [path, drive, seed] of LESSER) {
  for (const [label, pressure, vetoes] of CUTS) {
    test(`${path} under ${label}: ${vetoes ? "holds" : "steps"}`, () => {
      seed();
      const p = read(drive, pressure);
      if (!vetoes) return assertStep(p, `${path} / ${label}`);
      assertHeld(p, `${path} / ${label}`, [...voice.CUT_HOLDING_WIN]);
      // The repetition pair never forms a step under a vetoing cut (it asks the cut first),
      // so its hold is the ordinary top-set hold; every other path is a step the gate held.
      if (path !== "steady: the repetition pair") assert.equal(p.cut_held, true, `${path} / ${label}`);
      else assert.equal(p.top_set_earned, undefined, "a cut veto never offers the heavier look");
    });
  }
}

test("a re-ground whose sets were NOT all capped: the cut holds the step, the catch-up still lands", () => {
  // 140 × 9, 7, 6 on a plan written at 120: the top set went past the ceiling, the rest did not.
  for (const [label, pressure, vetoes] of CUTS) {
    for (const drive of ["steady", "push"]) {
      wipe();
      bench([[4, [[140, 9], [140, 7], [140, 6]]]], { target: 120 });
      const p = read(drive, pressure);
      assert.equal(p.reground, true, label);
      if (!vetoes) {
        assertStep(p, `${drive} / ${label}`);
        continue;
      }
      assertHeld(p, `${drive} / ${label}`, voice.PLAN_BEHIND_HOLD.map((fn) => fn("140 lb")));
    }
  }
});

test("steady: the top set alone still holds on completeness under every cut shape", () => {
  for (const [label, pressure] of CUTS) {
    wipe();
    bench([[4, topOnly]]);
    assertHeld(read("steady", pressure), label);
  }
});

test("a feeler single logged with reps in hand is not a miss (live: 155 × 1 at RIR 2)", () => {
  bench([]);
  const ex = repo.findExercise(LIFT);
  const session = repo.getOrCreateSession(isoDaysAgo(2), null);
  [[140, 8, 2], [140, 8, 2], [140, 8, 2], [155, 1, 2]].forEach(([w, r, rir], i) =>
    db
      .prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, ex.id, i + 1, w, r, rir)
  );
  assertStep(read("push", cut()), "feeler at RIR 2");
  db.prepare(`UPDATE logged_sets SET rir = 0 WHERE weight = 155`).run();
  assertHeld(read("push", cut()), "the same single at RIR 0 was the limit", missSentences);
});

test("a failed attempt holds even a full double progression under a cut that would not veto it", () => {
  for (const drive of ["steady", "push"]) {
    for (const [label, pressure] of CUTS) {
      wipe();
      bench([[4, [...capped, [145, 4]]]]);
      const p = read(drive, pressure);
      assertHeld(p, `${drive} / ${label}`, missSentences);
      assert.equal(p.cut_held, undefined, "the miss, not the cut, is the reason");
    }
  }
});

// ---- the timed load step -------------------------------------------------------------------
// A loaded carry's load step is only ever earned by EVERY set owning the seconds ceiling at
// the load: full progression, so no cut shape vetoes it; a seconds step is never vetoed.
function carry(sets) {
  repo.upsertExercise({ name: "Farmer's Carry", muscle_group: "forearms", mode: "timed" });
  const day = repo.savePlanDay(1, "Carry", "Grip", [
    { exercise: "Farmer's Carry", sets: 3, target_seconds: sets.target, target_weight: 50 },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(isoDaysAgo(90), day.id);
  const ex = repo.findExercise("Farmer's Carry");
  const session = repo.getOrCreateSession(isoDaysAgo(3), null);
  sets.logged.forEach(([w, s], i) =>
    db
      .prepare(`INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, duration_sec) VALUES (?, ?, ?, ?, ?)`)
      .run(session.id, ex.id, i + 1, w, s)
  );
}
const readCarry = (pressure) =>
  nextPrescription("Farmer's Carry", undefined, { autoreg: null, acute: null, drive: "steady", pushStance: false, cut: pressure });

test("timed: the load step (every set owned the ceiling) and the seconds step stand under every cut shape", () => {
  for (const [label, pressure] of CUTS) {
    wipe();
    carry({ target: 60, logged: [[50, 60], [50, 62], [50, 61]] });
    const load = readCarry(pressure);
    assert.equal(load.action, "overload", `${label}: ${load.why}`);
    assert.ok(load.suggested.weight > 50, `${label}: the load steps`);
    wipe();
    carry({ target: 40, logged: [[50, 45], [50, 44], [50, 42]] });
    const seconds = readCarry(pressure);
    assert.equal(seconds.action, "overload", `${label}: ${seconds.why}`);
    assert.equal(seconds.suggested.weight, 50, `${label}: the load holds while the seconds climb`);
    assert.ok(seconds.suggested.seconds > 40, `${label}: the seconds step`);
  }
});

test("timed: a set short of the ceiling never steps the load, under any cut shape", () => {
  for (const [label, pressure] of CUTS) {
    wipe();
    carry({ target: 60, logged: [[50, 60], [50, 60], [50, 52]] });
    const p = readCarry(pressure);
    assert.equal(p.suggested.weight, 50, label);
  }
});

test("a rep advance inside the range is not a load step: no cut shape takes it", () => {
  for (const [label, pressure] of CUTS) {
    for (const drive of ["steady", "push"]) {
      db.prepare(`DELETE FROM logged_sets`).run();
      db.prepare(`DELETE FROM sessions`).run();
      db.prepare(`DELETE FROM plan_items`).run();
      db.prepare(`DELETE FROM plan_days`).run();
      bench([[4, [[140, 7], [140, 7], [140, 6]]]]);
      const p = read(drive, pressure);
      assert.equal(p.action, "overload", `${drive} / ${label}: ${p.why}`);
      assert.equal(p.rep_step, true, `${drive} / ${label}`);
      assert.equal(p.suggested.weight, 140, `${drive} / ${label}`);
    }
  }
});

// ---- a failed attempt at more ----------------------------------------------------------


for (const drive of ["steady", "push"]) {
  test(`${drive}: every set capped, then 145 × 4 under the floor — the load holds at 140`, () => {
    bench([[4, [...capped, [145, 4]]]]);
    const p = read(drive, cut());
    assertHeld(p, drive, missSentences);
    assert.equal(p.top_set_earned, undefined, "a miss at the heavier load is not a top set that earned it");
  });

  test(`${drive}: a 145 × 4 miss BEFORE the work at 140 holds the same way`, () => {
    bench([[4, [[145, 4], ...capped]]]);
    assertHeld(read(drive, cut()), drive, missSentences);
  });

  test(`${drive}: a heavier set that reached the floor is the working load, not a miss`, () => {
    bench([[4, [...capped, [145, 6]]]]);
    const p = read(drive, cut());
    assert.ok(!missSentences.includes(p.why), p.why);
  });

  test(`${drive}: a lighter set under the floor is a back-off, not a miss`, () => {
    bench([[4, [...capped, [120, 5]]]]);
    assertStep(read(drive, cut()), drive);
  });

  test(`${drive}: a miss in an OLDER session does not hold today's step`, () => {
    bench([[10, [...capped, [145, 4]]], [4, capped]]);
    assertStep(read(drive, cut()), drive);
  });
}

test("push: the top set alone with a 145 × 4 miss holds (the push step used to take it)", () => {
  bench([[4, [...topOnly, [145, 4]]]]);
  const p = read("push", cut());
  assertHeld(p, "push top set + miss", missSentences);
});

test("steady: the top-set-only hold with a miss beside it does not offer the heavier look", () => {
  bench([[4, [...topOnly, [145, 4]]]]);
  const p = read("steady", cut());
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.top_set_earned, undefined, "the top set has not earned a heavier look");
});

// The reach: the day's card asked for ONE heavier set at fewer reps than the floor. Done as
// written it is the card's work; done short of what it asked, it is a miss.
function composeReach(sessionId, daysAgo, reachReps) {
  const items = [
    { position: 0, kind: "strength", exercise: LIFT, mode: "reps", sets: 1, rep_low: reachReps, rep_high: reachReps, target_weight: 145, reach: { weight: 145, reps: reachReps } },
    { position: 1, kind: "strength", exercise: LIFT, mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 },
  ];
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'test')`
  ).run(sessionId, isoDaysAgo(daysAgo), JSON.stringify(items));
}

for (const drive of ["steady", "push"]) {
  test(`${drive}: a reach top set done as the card asked (145 × 5) is not a miss`, () => {
    const [sessionId] = bench([[4, [[145, 5], ...capped]]]);
    composeReach(sessionId, 4, 5);
    assertStep(read(drive, cut()), drive);
  });

  test(`${drive}: a reach top set short of what the card asked (145 × 4 of 5) is a miss`, () => {
    const [sessionId] = bench([[4, [[145, 4], ...capped]]]);
    composeReach(sessionId, 4, 5);
    assertHeld(read(drive, cut()), drive, missSentences);
  });
}

test("the repetition pair reads the same test: a reach done as asked does not break the pair", () => {
  const [, latest] = bench([
    [10, [[140, 8], [140, 8], [140, 7]]],
    [4, [[145, 5], [140, 8], [140, 8], [140, 7]]],
  ]);
  composeReach(latest, 4, 5);
  const p = read("steady", cut());
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.earned_by, "repeated_top_set");
  assert.equal(p.suggested.weight, 145);
});

test("the miss sentence is plain athlete language", () => {
  for (const line of missSentences) {
    assert.equal(violatesReadingGrammar(line), null, line);
    assert.doesNotMatch(line, /\b(dose|evidence|exposure|comparable|RIR|fail(ed)?)\b/i, line);
  }
});

// ---- fix round: an open-earned step (no rep range) at the gate ------------------------------
// With no range there is no cap to reach: a step whose exposure met its full prescribed dose
// is complete work and stands under every cut shape; one earned on a rating alone is lesser.
function openBench({ rir = null, linkFull = false } = {}) {
  repo.upsertExercise({ name: LIFT, muscle_group: "chest", mode: "reps" });
  const day = repo.savePlanDay(1, "Day 1", null, [{ exercise: LIFT, sets: 3, target_weight: 140 }]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(isoDaysAgo(90), day.id);
  const ex = repo.findExercise(LIFT);
  const date = isoDaysAgo(4);
  const session = repo.getOrCreateSession(date, null);
  for (let i = 0; i < 3; i++)
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(session.id, ex.id, i + 1, 140, 8, rir);
  if (!linkFull) return;
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(session.id);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint)
       VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'Open fixture', ?, ?)`
    )
    .run(session.id, date, day.id, JSON.stringify([{ exercise: LIFT, sets: 3, target_weight: 140 }]), `open-${ex.id}`);
  const facts = {
    schema_version: 2,
    confidence: "high",
    dose_context: { partial: false, comparable: true, non_comparable_reasons: [] },
    dose_evidence: [
      {
        movement_key: `exercise:${ex.id}`,
        exercise: LIFT,
        prescribed: { sets: 3 },
        achieved: { sets: 3 },
        challenge_verdict: "met",
      },
    ],
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, date, JSON.stringify(facts));
}

for (const [label, pressure] of CUTS) {
  test(`no rep range: an open step that met its full dose steps under ${label}`, () => {
    wipe();
    db.prepare(`DELETE FROM daily_session_outcomes`).run();
    openBench({ linkFull: true });
    const p = read("steady", pressure);
    assert.equal(p.dose_eligibility?.reason, "full_comparable", label);
    assert.equal(p.action, "overload", `${label}: ${p.why}`);
    assert.ok(p.suggested.weight > 140, `${label}: the load steps`);
    assert.equal(p.cut_held, undefined, label);
  });
}

for (const [label, pressure, vetoes] of CUTS) {
  test(`no rep range: an open step earned on a rating alone is lesser, so ${label} ${vetoes ? "holds" : "steps"}`, () => {
    wipe();
    db.prepare(`DELETE FROM daily_session_outcomes`).run();
    openBench({ rir: 2 });
    const p = read("steady", pressure);
    if (!vetoes) {
      assert.equal(p.action, "overload", `${label}: ${p.why}`);
      assert.ok(p.suggested.weight > 140, label);
      return;
    }
    assert.equal(p.action, "hold", `${label}: ${p.why}`);
    assert.equal(p.suggested.weight, 140, label);
    assert.equal(p.cut_held, true, label);
  });
}

// ---- fix round: what counts as a failed attempt ---------------------------------------------

test("a heavier set within half a load step of the card is rounding, not a miss (64 kg logged as 141)", () => {
  bench([[4, [...capped, [141, 4]]]]);
  assertStep(read("steady", cut()), "141 x 4 beside a 140 card");
  wipe();
  bench([[4, [...capped, [145, 4]]]]);
  assertHeld(read("steady", cut()), "a full step heavier is still a miss", missSentences);
});

test("a reach done a small plate off what the card asked is the card's work, not a miss", () => {
  const [sessionId] = bench([[4, [[147.5, 5], ...capped]]]);
  composeReach(sessionId, 4, 5);
  assertStep(read("steady", cut()), "147.5 x 5 on a 145 x 5 reach");
});

test("the card's reach is matched through the exercise resolver, not a raw name key", () => {
  setExerciseAlias("Flat Bench", LIFT, "test");
  const [sessionId] = bench([[4, [[145, 5], ...capped]]]);
  const items = [
    { position: 0, kind: "strength", exercise: "Flat Bench", mode: "reps", sets: 1, rep_low: 5, rep_high: 5, target_weight: 145, reach: { weight: 145, reps: 5 } },
    { position: 1, kind: "strength", exercise: LIFT, mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: 140 },
  ];
  db.prepare(
    `INSERT INTO daily_session_compositions (version, session_id, date, source, status, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', ?, 'test')`
  ).run(sessionId, isoDaysAgo(4), JSON.stringify(items));
  assertStep(read("steady", cut()), "a reach the card spelled by an alias");
});

test("a Garmin-owned day is never a failed attempt: the watch's rep count is not his word", () => {
  const [sessionId] = bench([[4, [...capped, [145, 4]]]]);
  db.prepare(`UPDATE sessions SET garmin_json = ? WHERE id = ?`).run(
    JSON.stringify({ cairn_sets_authoritative: false }),
    sessionId
  );
  const p = read("steady", cut());
  assert.ok(!missSentences.includes(p.why), p.why);
  assert.equal(p.action, "overload", p.why);
});
