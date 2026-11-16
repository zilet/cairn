// THE WORKING LOAD IS WHERE THE WORK WAS (double progression).
// A session's working weight is the heaviest load at which a set reached the rep floor —
// one such set is enough (working-load.ts) — and the step is read off the reps and RIR
// taken AT that load.
// The Epley-best set is a different question (est-1RM, trends, records) and no longer
// picks the load: Barbell Bench Press, card 3 × 5–8 @ 140, logged 140 × 8, 145 × 6,
// 145 × 5 (all RIR 2). Epley names 140 × 8, and the engine stepped off "8 reps at the
// top" — but at 145, the weight actually worked, he got 6 and 5. The plan catches up to
// 145 and holds there; it never steps to 150 off reps done at 140.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, isoDaysAgo, repo } from "./_seed.js";
import { reconcileDailySession } from "../dist/repo/daily-reconciliation.js";
import { recentWorkingWeight } from "../dist/repo/exercises.js";
import { latestWorkingSets } from "../dist/repo/prescription-authorship.js";
import { nextPrescription } from "../dist/repo/progression.js";
import * as progressionVoice from "../dist/repo/progression-voice.js";
import { MIN_WORKING_REPS, UNDER_FLOOR_SETS, sessionWorkingLoad } from "../dist/repo/working-load.js";

function reset() {
  for (const t of [
    "daily_session_outcomes",
    "daily_session_compositions",
    "logged_sets",
    "plan_items",
    "plan_days",
    "sessions",
    "exercises",
    "program_blocks",
    "plan_proposals",
  ]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
}
beforeEach(reset);

const NO_BRAKES = { autoreg: null, acute: null };
const BENCH = "Barbell Bench Press";
const card = (weight) => ({ sets: 3, rep_low: 5, rep_high: 8, target_weight: weight, target_seconds: null });

function planSlot(item, { stampDaysAgo = 120 } = {}) {
  const day = repo.savePlanDay(1, item.focus ?? "Day", item.focus ?? null, [item]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(isoDaysAgo(stampDaysAgo), day.id);
}

// Each set is [weight, reps, rir, duration_sec].
function logSets(name, daysAgo, sets) {
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
  sets.forEach(([weight, reps, rir, duration], i) =>
    db
      .prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir, duration_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, ex.id, i + 1, weight, reps, rir ?? null, duration ?? null)
  );
  return session.id;
}

// The day's composed card for one lift, the logged sets under it, the session finished and
// reconciled through the real write path (so the dose verdict is the stored one).
function composedSession(name, daysAgo, cardItem, sets) {
  const sessionId = logSets(name, daysAgo, sets);
  const items = [{ position: 0, kind: "strength", exercise: name, mode: "reps", ...cardItem }];
  db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Working-load fixture', ?, ?)`
  ).run(sessionId, isoDaysAgo(daysAgo), JSON.stringify(items), `wl-${sessionId}-${Math.random()}`);
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(sessionId);
  const outcome = reconcileDailySession(sessionId);
  assert.ok(outcome, "the session reconciles against its card");
  return outcome.facts.dose_evidence.find((d) => d.exercise === name);
}

function benchHistory(planWeight = 140) {
  repo.upsertExercise({ name: BENCH, muscle_group: "chest", mode: "reps" });
  planSlot({ exercise: BENCH, sets: 3, rep_low: 5, rep_high: 8, target_weight: planWeight, focus: "Upper A" });
  logSets(BENCH, 20, [
    [135, 8, 2],
    [135, 8, 2],
    [135, 7, 1],
  ]);
  logSets(BENCH, 13, [
    [140, 7, 1],
    [140, 6, 1],
    [140, 6, 1],
  ]);
}

const set = (weight, reps) => ({ weight, reps, duration_sec: null });

// ---- the definition, pure ----

test("pure: the working load is the heaviest load at which a set reached the rep floor", () => {
  assert.equal(MIN_WORKING_REPS, 3);
  assert.equal(UNDER_FLOOR_SETS, 2);
  // Bench, 5–8 @ 140: 145, not the Epley-best 140 × 8.
  assert.equal(sessionWorkingLoad([set(140, 8), set(145, 6), set(145, 5)], 5), 145);
  assert.equal(sessionWorkingLoad([set(140, 8), set(145, 6), set(145, 5)]), 145, "same with no range known");
  // The 135 opener is not the load.
  assert.equal(sessionWorkingLoad([set(135, 10), set(140, 8), set(140, 6)], 5), 140);
  // Straight sets read their one load.
  assert.equal(sessionWorkingLoad([set(140, 8), set(140, 8), set(140, 7)], 5), 140);
  // A heavier feeler under the floor is not the work.
  assert.equal(sessionWorkingLoad([set(140, 8), set(140, 8), set(140, 7), set(155, 1)], 5), 140);
  assert.equal(sessionWorkingLoad([set(140, 8), set(140, 8), set(140, 7), set(155, 1)]), 140);
  assert.equal(sessionWorkingLoad([set(140, 8), set(140, 8), set(160, 1), set(160, 1)]), 140, "two singles too");
  assert.equal(sessionWorkingLoad([set(140, 8), set(155, 1)], 5), 140);
  // One set that reached the floor at the heaviest load IS the work.
  assert.equal(sessionWorkingLoad([set(140, 8), set(140, 8), set(150, 6)], 5), 150);
  assert.equal(sessionWorkingLoad([set(145, 8), set(135, 10), set(135, 10)], 5), 145, "top set over back-offs");
  // Climbing set to set: the last, heaviest set inside the range is the load.
  assert.equal(sessionWorkingLoad([set(57.5, 12), set(60, 12)], 10), 60, "pushdown ladder, 10–15");
  assert.equal(sessionWorkingLoad([set(150, 10), set(190, 12), set(210, 12)]), 210, "leg-press ramp");
  assert.equal(sessionWorkingLoad([set(115, 10), set(105, 10)], 8), 115, "a lighter set after is a back-off");
  assert.equal(sessionWorkingLoad([set(100, 10), set(105, 10)]), 105);
  assert.equal(sessionWorkingLoad([set(50, 9), set(45, 9), set(40, 10)], 8), 50);
  assert.equal(sessionWorkingLoad([set(135, 10), set(185, 10), set(205, 10)], 5), 205);
  // OHP 6–8: 75 × 4 is under the floor, 60 × 9 is not the work — 70 × 6 is.
  assert.equal(sessionWorkingLoad([set(75, 4), set(70, 6), set(60, 9)], 6), 70, "OHP");
  // Warm-ups never count.
  assert.equal(sessionWorkingLoad([set(70, 10), set(140, 8)], 5), 140);
  assert.equal(sessionWorkingLoad([set(45, 10), set(140, 8), set(140, 6)], 5), 140);
  // A day where every set fell short of the floor still reads the load he was working at —
  // and a lone under-floor feeler over under-floor work is still not it.
  assert.equal(sessionWorkingLoad([set(140, 4), set(140, 4), set(140, 3)], 5), 140);
  assert.equal(sessionWorkingLoad([set(140, 4), set(140, 4), set(155, 1)], 5), 140);
  assert.equal(sessionWorkingLoad([set(185, 2), set(185, 2), set(185, 2)]), 185);
  assert.equal(sessionWorkingLoad([set(140, 4)], 5), 140, "one set logged: it is the load");
  // The prescription's rep floor decides which sets are working sets.
  assert.equal(sessionWorkingLoad([set(150, 4), set(150, 4), set(130, 8), set(130, 8)], 5), 130);
  assert.equal(sessionWorkingLoad([set(150, 4), set(150, 4), set(130, 8), set(130, 8)]), 150);
});

test("pure: assisted, bodyweight and timed work have no working load of this kind", () => {
  assert.equal(sessionWorkingLoad([set(-30, 8), set(-30, 8), set(-20, 2)]), null);
  assert.equal(sessionWorkingLoad([set(null, 10), set(null, 8)]), null);
  assert.equal(sessionWorkingLoad([{ weight: 60, reps: null, duration_sec: 40 }]), null);
  // Bodyweight sets beside loaded ones are warm-ups; the loaded sets carry the load.
  assert.equal(sessionWorkingLoad([set(null, 10), set(25, 6), set(25, 6)]), 25);
});

// ---- 1. the 2026-11-16 bench: catch up to 145, never step to 150 ----

test("live: 140 × 8, 145 × 6, 145 × 5 on a 140 card under push catches the plan up to 145 and holds", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(BENCH, 1, card(140), [
    [140, 8, 2],
    [145, 6, 2],
    [145, 5, 2],
  ]);
  assert.equal(dose.challenge_verdict, "exceeded");
  // Both reads name the load he worked at.
  assert.equal(recentWorkingWeight(BENCH), 145);
  assert.equal(recentWorkingWeight(BENCH, 3, undefined, 5), 145);
  assert.deepEqual(
    latestWorkingSets(BENCH, 5).map((s) => [s.weight, s.reps]),
    [
      [145, 6],
      [145, 5],
    ]
  );
  for (const pushStance of [false, true]) {
    const p = nextPrescription(BENCH, undefined, { ...NO_BRAKES, pushStance });
    assert.equal(p.dose_eligibility.reason, "full_comparable");
    assert.equal(p.action, "hold", p.why);
    assert.equal(p.reground, true, "the plan sat under the real working weight");
    assert.equal(p.suggested.weight, 145, "catch up to 145 — never 150 off reps done at 140");
    assert.match(p.why, /145 lb/);
    assert.match(p.why, /rep/, "the hold asks for reps at 145, the load he worked at");
  }
});

// ---- 2. the next session at 145 earns the step on the existing rules ----

test("live: 145 × 8, 145 × 8, 145 × 7 on a 145 card earns the step under push; steady holds for the last set", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory(145);
  composedSession(BENCH, 8, card(140), [
    [140, 8, 2],
    [145, 6, 2],
    [145, 5, 2],
  ]);
  composedSession(BENCH, 1, card(145), [
    [145, 8, 2],
    [145, 8, 2],
    [145, 7, 2],
  ]);
  assert.equal(recentWorkingWeight(BENCH), 145);
  const push = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(push.action, "overload", push.why);
  assert.equal(push.suggested.weight, 150);
  assert.ok(!push.reground, "the plan already sits at the working weight");

  repo.setSettings({ training_drive: "steady" });
  const steady = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(steady.action, "hold", "steady double progression waits for every set at the top");
  assert.equal(steady.suggested.weight, 145);
});

// ---- 3. the 2026-10-30 bench: the step is earned at 140, not by the 135 opener ----

test("live: 135 × 10, 140 × 8, 140 × 6 reads the load at 140 and its top set 140 × 8", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(BENCH, 4, card(140), [
    [135, 10, 1],
    [140, 8, 1],
    [140, 6, 1],
  ]);
  assert.equal(dose.challenge_verdict, "met", "the ramp-in credit fills the third set");
  assert.equal(recentWorkingWeight(BENCH), 140);
  assert.deepEqual(
    latestWorkingSets(BENCH, 5).map((s) => [s.weight, s.reps]),
    [
      [140, 8],
      [140, 6],
    ]
  );
  // A dated push stance takes a set at the ceiling with a rep in hand as strong: the
  // 140 × 8 at RIR 1 earns the step on its own.
  const stance = nextPrescription(BENCH, undefined, { ...NO_BRAKES, pushStance: true });
  assert.equal(stance.dose_eligibility.reason, "full_comparable");
  assert.equal(stance.action, "overload", stance.why);
  assert.equal(stance.suggested.weight, 145);
  // Without the stance the bar is two reps in reserve, and the set at the load was rated
  // RIR 1. The old read stepped here only because it took the 135 × 10 opener as the top
  // set (its two reps past the ceiling counted as reserve) — evidence the load never saw.
  const plain = nextPrescription(BENCH, undefined, { ...NO_BRAKES, pushStance: false });
  assert.equal(plain.action, "hold", plain.why);
  assert.equal(plain.suggested.weight, 140);
  // …and the card says the real reason: the rating, not "not every set got there".
  assert.ok(progressionVoice.GRIND_HOLD.includes(plain.why), `the grind voice (${plain.why})`);
});

test("live: the same 140 work without the opener earns the same step — the opener was never the evidence", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  composedSession(BENCH, 4, card(140), [
    [140, 8, 1],
    [140, 6, 1],
    [140, 6, 1],
  ]);
  const p = nextPrescription(BENCH, undefined, { ...NO_BRAKES, pushStance: true });
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145);
});

// ---- 4. a single heavy feeler is not the working weight ----

test("live: 140 × 8, 140 × 8, 140 × 7, 155 × 1 works at 140 — the feeler never re-grounds the plan", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  composedSession(BENCH, 1, card(140), [
    [140, 8, 2],
    [140, 8, 2],
    [140, 7, 2],
    [155, 1, 2],
  ]);
  assert.equal(recentWorkingWeight(BENCH), 140);
  assert.equal(latestWorkingSets(BENCH, 5).length, 3, "the working sets are the three at 140");
  const p = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.ok(!p.reground, "155 is not a working weight the plan sits under");
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145, "one step off 140 × 8 — never a step off the 155 single");
});

// ---- 5. straight sets are unchanged ----

test("live: straight sets read exactly as before", () => {
  repo.setSettings({ training_drive: "steady" });
  benchHistory();
  composedSession(BENCH, 1, card(140), [
    [140, 8, 2],
    [140, 8, 2],
    [140, 8, 2],
  ]);
  assert.equal(recentWorkingWeight(BENCH), 140);
  const p = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145);
});

// ---- assisted and timed work keep their own reads ----

test("live: assisted work keeps its (less assist, more reps) read", () => {
  const PULL = "Assisted Pull-Up";
  repo.upsertExercise({ name: PULL, muscle_group: "back", mode: "reps" });
  logSets(PULL, 3, [
    [-40, 8],
    [-30, 6],
    [-30, 5],
  ]);
  assert.equal(recentWorkingWeight(PULL), -30, "less assist is the harder, larger signed load");
  logSets(PULL, 1, [
    [-30, 8],
    [-30, 8],
    [-20, 2],
  ]);
  assert.equal(recentWorkingWeight(PULL), -20, "the assisted ranking is unchanged: the least assist handled");
  // Bodyweight beside an assisted finisher: the bodyweight sets are the work.
  logSets(PULL, 0, [
    [null, 6],
    [null, 5],
    [-20, 8],
  ]);
  assert.deepEqual(
    latestWorkingSets(PULL).map((s) => s.weight),
    [null, null]
  );
});

test("live: a loaded carry (seconds, no reps) reads its heaviest load", () => {
  const CARRY = "Farmer Carry";
  repo.upsertExercise({ name: CARRY, muscle_group: "forearms", mode: "timed" });
  logSets(CARRY, 1, [
    [50, null, null, 40],
    [60, null, null, 30],
    [60, null, null, 30],
  ]);
  assert.equal(recentWorkingWeight(CARRY), 60);
});
