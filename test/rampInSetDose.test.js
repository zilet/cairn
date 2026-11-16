// A RAMP-IN OPENING IS A WORKING SET, NOT A SHORTFALL (live athlete, training_drive =
// push). Barbell Bench Press, card 3 × 5–8 @ 140: the session logged 135 × 10 @ RIR 1,
// 140 × 8, 140 × 6. The stored verdict read `under_prescribed` (the 135 opener is under
// the card's load), so progression's linked dose went ineligible and the push engine held
// a load the athlete had plainly earned. The opener is as hard as the card's floor set
// (Epley), sits one plate step under the card and ends within two reps of the range — it
// is the third working set. A lighter set taken AFTER the load was reached (a back-off),
// two sets under the card, every set light, reps under the range, a true warm-up, or a
// pump set far past the range all stay short.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, isoDaysAgo, repo } from "./_seed.js";
import { reconcileDailySession } from "../dist/repo/daily-reconciliation.js";
import { nextPrescription } from "../dist/repo/progression.js";
import {
  doseChallengeVerdict,
  rampInCredit,
  rampInSetCarriesDose,
  readStoredDose,
  WARMUP_LOAD_FRACTION,
} from "../dist/repo/outcome-comparability.js";
import { effectiveVolumeByGroup } from "../dist/repo/exercise-variations.js";

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

function planSlot(item, { stampDaysAgo = 120 } = {}) {
  const day = repo.savePlanDay(1, item.focus ?? "Day", item.focus ?? null, [item]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ? WHERE plan_day_id = ?`).run(isoDaysAgo(stampDaysAgo), day.id);
}

function logSets(name, daysAgo, sets) {
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(isoDaysAgo(daysAgo), null);
  sets.forEach(([weight, reps, rir], i) =>
    db
      .prepare(
        `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, ex.id, i + 1, weight, reps, rir ?? null)
  );
  return session.id;
}

// The day's composed card for one lift, the logged sets under it, the session finished
// and reconciled through the real write path.
function composedSession(name, daysAgo, card, sets, { feedback = null } = {}) {
  const sessionId = logSets(name, daysAgo, sets);
  if (feedback) repo.setSessionFeedback(isoDaysAgo(daysAgo), feedback);
  const date = isoDaysAgo(daysAgo);
  const items = [{ position: 0, kind: "strength", exercise: name, mode: "reps", ...card }];
  db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'adaptive_plan', 'active', 'Ramp fixture', ?, ?)`
  ).run(sessionId, date, JSON.stringify(items), `ramp-${sessionId}-${Math.random()}`);
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(sessionId);
  const outcome = reconcileDailySession(sessionId);
  assert.ok(outcome, "the session reconciles against its card");
  return outcome.facts.dose_evidence.find((d) => d.exercise === name);
}

const NO_BRAKES = { autoreg: null, acute: null };
// The 10-30 sets at the card's load were rated RIR 1. The step is read off the top set AT
// the working load (140 × 8, working-load.ts), so it is strong under a dated push stance
// (the bar drops to one rep in hand) — never by borrowing the 135 × 10 opener's reps.
const PUSH_STANCE = { ...NO_BRAKES, pushStance: true };
const BENCH = "Barbell Bench Press";
const CARD = { sets: 3, rep_low: 5, rep_high: 8, target_weight: 140, target_seconds: null };

const achieved = (rows) => ({
  sets: rows.length,
  top_weight: Math.max(...rows.map((r) => r[0])),
  top_reps: Math.max(...rows.map((r) => r[1])),
  top_seconds: null,
  sets_detail: rows.map(([weight, reps]) => ({ weight, reps, duration_sec: null })),
});
const verdict = (rows, card = CARD) => doseChallengeVerdict(card, achieved(rows));

function benchHistory() {
  repo.upsertExercise({ name: BENCH, muscle_group: "chest", mode: "reps" });
  planSlot({ exercise: BENCH, sets: 3, rep_low: 5, rep_high: 8, target_weight: 140, focus: "Upper A" });
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

test("pure: the 2026-10-30 bench — a 135 × 10 opener before 140 × 8, 140 × 6 is the third working set", () => {
  const rows = [
    [135, 10],
    [140, 8],
    [140, 6],
  ];
  assert.equal(rampInSetCarriesDose({ weight: 135, reps: 10, duration_sec: null }, CARD), true);
  assert.equal(rampInCredit(CARD, achieved(rows).sets_detail), 1);
  // Met, not exceeded: the opener's ten reps were not reps past the ceiling AT the card's load.
  assert.equal(verdict(rows), "met");
});

test("pure: the 2026-11-16 bench — later sets above the card never read short", () => {
  const rows = [
    [140, 8],
    [145, 6],
    [145, 5],
  ];
  assert.equal(verdict(rows), "exceeded", "against the 140 card: every set meets it and two went heavier");
  const card145 = { ...CARD, target_weight: 145 };
  assert.equal(verdict(rows, card145), "met", "against a 145 card the 140 × 8 opener is the ramp-in");
});

test("pure: the ramp-in fills a missing set and nothing else", () => {
  assert.equal(
    verdict([
      [135, 10],
      [135, 10],
      [140, 8],
    ]),
    "under_prescribed",
    "two of three under the card: only one opener can count"
  );
  assert.equal(
    verdict([
      [135, 10],
      [135, 10],
      [135, 10],
    ]),
    "under_prescribed",
    "every set lighter: there is no card-load work for an opener to ramp into"
  );
  assert.equal(
    verdict([
      [135, 10],
      [140, 8],
      [140, 4],
    ]),
    "under_prescribed",
    "a card-load set under the range stays short"
  );
  assert.equal(
    verdict([
      [140, 8],
      [140, 6],
      [135, 10],
    ]),
    "under_prescribed",
    "a lighter set AFTER the load was reached is a back-off, not a ramp-in"
  );
  assert.equal(
    verdict([
      [120, 8],
      [140, 8],
      [140, 6],
    ]),
    "under_prescribed",
    "an opener under the card floor's estimated single is a warm-up, not the third set"
  );
  assert.equal(
    verdict([
      [125, 14],
      [140, 8],
      [140, 6],
    ]),
    "under_prescribed",
    "a lighter set taken far past the range is a pump set, whatever Epley says"
  );
  assert.equal(
    verdict(
      [
        [135, 10],
        [140, 8],
      ],
      { ...CARD, sets: 1 }
    ),
    "met",
    "a one-set card is met by its own set; the opener adds nothing"
  );
  assert.equal(
    rampInCredit(
      { ...CARD, sets: 1 },
      achieved([
        [135, 10],
        [140, 4],
      ]).sets_detail
    ),
    0
  );
  assert.equal(
    verdict([
      [135, 10],
      [140, 8],
      [140, 8],
      [140, 8],
    ]),
    "met",
    "a full card at the load is met — an opener never makes it exceeded"
  );
  assert.equal(
    verdict([
      [95, 12],
      [140, 8],
      [140, 8],
      [140, 8],
    ]),
    "met",
    "a warm-up's reps are not reps past the ceiling at the card's load"
  );
  assert.equal(
    verdict([
      [140, 9],
      [140, 8],
      [140, 8],
    ]),
    "exceeded",
    "reps past the ceiling AT the load still exceed"
  );
  // Timed and assisted cards never take a ramp-in.
  assert.equal(
    rampInSetCarriesDose({ weight: -35, reps: 10, duration_sec: null }, { ...CARD, target_weight: -30 }),
    false
  );
  assert.equal(
    rampInSetCarriesDose({ weight: 135, reps: 10, duration_sec: 40 }, { ...CARD, target_seconds: 30 }),
    false
  );
});

test("pure: the warm-up line is one definition, shared with the volume model", () => {
  assert.equal(WARMUP_LOAD_FRACTION, 0.55);
  const volume = effectiveVolumeByGroup([
    { date: "2026-10-30", exercise: BENCH, muscle_group: "chest", weight: 70, reps: 10 },
    { date: "2026-10-30", exercise: BENCH, muscle_group: "chest", weight: 135, reps: 10 },
    { date: "2026-10-30", exercise: BENCH, muscle_group: "chest", weight: 140, reps: 8 },
  ]);
  assert.equal(volume.get("chest").sets, 2, "70 is under 55% of 140 (a warm-up); 135 is a working set");
});

test("live: the 10-30 shape under push no longer holds on under_prescribed — the load steps to 145", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(BENCH, 4, CARD, [
    [135, 10, 1],
    [140, 8, 1],
    [140, 6, 1],
  ]);
  assert.equal(dose.challenge_verdict, "met");
  assert.equal(readStoredDose(dose).verdict, "met");
  const p = nextPrescription(BENCH, undefined, PUSH_STANCE);
  assert.equal(p.dose_eligibility.reason, "full_comparable");
  assert.equal(p.action, "overload", p.why);
  assert.equal(p.suggested.weight, 145);
});

test("live: a dose stored as under_prescribed under the old rule is re-read under the new one", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  composedSession(BENCH, 4, CARD, [
    [135, 10, 1],
    [140, 8, 1],
    [140, 6, 1],
  ]);
  // Rewrite the stored verdict the way the old rule wrote it.
  const row = db.prepare(`SELECT id, facts_json FROM daily_session_outcomes ORDER BY id DESC LIMIT 1`).get();
  const facts = JSON.parse(row.facts_json);
  for (const dose of facts.dose_evidence) dose.challenge_verdict = "under_prescribed";
  db.prepare(`UPDATE daily_session_outcomes SET facts_json = ? WHERE id = ?`).run(JSON.stringify(facts), row.id);
  const p = nextPrescription(BENCH, undefined, PUSH_STANCE);
  assert.notEqual(p.dose_eligibility.reason, "under_prescribed");
  assert.equal(p.action, "overload", p.why);
});

test("live: two of three sets under the card still holds on under_prescribed", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(BENCH, 4, CARD, [
    [135, 10, 1],
    [135, 10, 1],
    [140, 8, 1],
  ]);
  assert.equal(dose.challenge_verdict, "under_prescribed");
  const p = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(p.dose_eligibility.reason, "under_prescribed");
  assert.equal(p.action, "hold");
  assert.equal(p.suggested.weight, 140);
});

test("live: card-load reps under the range still hold", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(BENCH, 4, CARD, [
    [135, 10, 1],
    [140, 8, 1],
    [140, 4, 0],
  ]);
  assert.equal(dose.challenge_verdict, "under_prescribed");
  const p = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(p.dose_eligibility.reason, "under_prescribed");
  assert.notEqual(p.action, "overload");
});

test("live: the 11-16 shape exceeds the 140 card; push catches the plan up to the 145 the athlete worked at", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(BENCH, 1, CARD, [
    [140, 8, 2],
    [145, 6, 2],
    [145, 5, 2],
  ]);
  assert.equal(dose.challenge_verdict, "exceeded");
  const p = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(p.dose_eligibility.reason, "full_comparable");
  // The working load is 145 (two sets there) and its top set is 145 × 6 — short of the
  // ceiling. So it is a catch-up HOLD at 145, never a step: not off the 140 × 8 opener,
  // and never a second step to 150 (working-load.ts).
  assert.equal(p.action, "hold", p.why);
  assert.equal(p.reground, true);
  assert.equal(p.suggested.weight, 145);
});

test("live: the ramp-in loosens nothing else — a slot rewritten after the session stays untested", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  composedSession(BENCH, 4, CARD, [
    [135, 10, 1],
    [140, 8, 1],
    [140, 6, 1],
  ]);
  // A plan written onto 150 after that session: nothing was done at it, so it stands as written.
  db.prepare(`UPDATE plan_items SET target_weight = 150, prescribed_at = ?`).run(isoDaysAgo(2));
  const fresh = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(fresh.untested, true);
  assert.equal(fresh.action, "hold");
  assert.equal(fresh.suggested.weight, 150);
});

test("live: shoulder pain logged on the session still holds the lift out, ramp-in or not", () => {
  repo.setSettings({ training_drive: "push" });
  benchHistory();
  const dose = composedSession(
    BENCH,
    4,
    CARD,
    [
      [135, 10, 1],
      [140, 8, 1],
      [140, 6, 1],
    ],
    { feedback: { joint_pain: "right shoulder" } }
  );
  assert.equal(dose.challenge_verdict, "met");
  assert.equal(dose.relevant_symptom, true);
  const p = nextPrescription(BENCH, undefined, NO_BRAKES);
  assert.equal(p.dose_eligibility.eligible, false);
  assert.notEqual(p.action, "overload");
});
