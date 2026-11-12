// The review of today's-session ownership (2026-11-12): the defects a second reader found
// in the chat today_session Undo, the chosen-card guards, discard, adoption of a session
// logged before any card, and the words a lock or a finished day is said in. Each test
// here failed before its fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import {
  applyChatStartSession,
  applyChatTodaySession,
  TODAY_SESSION_LOCKED_ERROR,
} from "../dist/domain/training/chat-today-session.js";
import { recordExerciseSymptomObservation } from "../dist/domain/training/exercise-symptom-use-case.js";
import { chatChangeReceipts, reconcileChatPlanReply } from "../dist/chat-reconcile.js";
import { openSessionOn } from "../dist/repo/open-session.js";
import { DATE, assertReadable, chosenCard, prepareRoute, routerRequest, seedPlan } from "./_dailySessionMatrix.mjs";
import { db, repo } from "./_seed.js";

const UPPER = {
  title: "Upper",
  why: "Push and pull together.",
  items: [
    { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 60 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10, target_weight: 70 },
  ],
};
const active = () =>
  db.prepare(`SELECT * FROM daily_session_compositions WHERE date = ? AND status = 'active'`).get(DATE);
const skipsOf = (sessionId) =>
  db
    .prepare(`SELECT exercise FROM session_skips WHERE session_id = ? ORDER BY exercise`)
    .all(sessionId)
    .map((row) => row.exercise);
const sessionRow = (id) => db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);

// ---- 1. Undo of a chat-built session ---------------------------------------------------

function mineThenChatUpper() {
  seedPlan();
  const mine = repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") });
  const built = applyChatTodaySession(UPPER, { date: DATE });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.replaced_composition_id, mine.daily_session.id);
  assert.ok(built.decision_id > 0);
  return { mine, built, sessionId: Number(built.session_id) };
}

const LIVED_ON_WITHOUT_SETS = {
  "notes only": (id) => repo.updateSessionNotes(id, "Shoulder felt fine on the first warm-up."),
  "feedback only": () => repo.setSessionFeedback(DATE, { performance: 4 }),
  "duration only": (id) => db.prepare(`UPDATE sessions SET duration_min = 35 WHERE id = ?`).run(id),
  "notes, duration and a rating": (id) => {
    repo.updateSessionNotes(id, "Good pump.");
    db.prepare(`UPDATE sessions SET duration_min = 50 WHERE id = ?`).run(id);
    repo.setSessionFeedback(DATE, { performance: 4 });
  },
  "finished with nothing logged": (id) => repo.finishSession(id),
};

for (const [name, liveOn] of Object.entries(LIVED_ON_WITHOUT_SETS)) {
  test(`Undo of a chat session refuses once it is lived on without a set: ${name}`, () => {
    const { mine, built, sessionId } = mineThenChatUpper();
    liveOn(sessionId);
    const undone = revertDecision(built.decision_id, "user veto");
    assert.equal(undone.ok, false, JSON.stringify(undone));
    assertReadable(String(undone.error ?? undone.message ?? ""), name);
    assert.equal(active().id, built.daily_session_id, "the session the record is about stands");
    assert.equal(
      db.prepare(`SELECT status FROM daily_session_compositions WHERE id = ?`).get(mine.daily_session.id).status,
      "superseded"
    );
    assert.equal(repo.getBrainDecision(built.decision_id).status, "applied");
  });
}

test("Undo of a chat session puts back the skips the replace cleared", () => {
  seedPlan();
  const mine = repo.prepareDailySession({
    date: DATE,
    source: "athlete_override",
    session: {
      name: "Mine",
      items: [
        { exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 12 },
        { exercise: "Face Pull", sets: 3, rep_low: 12, rep_high: 15 },
      ],
    },
  });
  const sessionId = Number(mine.session_id);
  repo.skipExercise("Face Pull", DATE);
  assert.deepEqual(skipsOf(sessionId), ["Face Pull"]);
  const built = applyChatTodaySession(UPPER, { date: DATE });
  assert.equal(built.ok, true);
  assert.deepEqual(skipsOf(sessionId), [], "the replace opens the new card clean");
  // A skip made on the chat card belongs to that card, not to the one coming back.
  repo.skipExercise("Lat Pulldown", DATE);
  const undone = revertDecision(built.decision_id, "user veto");
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(active().id, mine.daily_session.id);
  assert.deepEqual(skipsOf(sessionId), ["Face Pull"], "the earlier card comes back as the athlete left it");
});

// ---- 5. the receipt names the session a chat build replaced ------------------------------

test("a chat session over the athlete's own chosen card says which card it replaced, and Undo restores it", () => {
  const { mine, built } = mineThenChatUpper();
  assert.equal(built.replaced_title, "Mine");
  const applied = [{ type: "today_session", result: built }];
  const [receipt] = chatChangeReceipts(applied, []);
  assert.match(receipt.what, /Mine/, receipt.what);
  assert.match(receipt.what, /Upper/, receipt.what);
  const reply = reconcileChatPlanReply("Here's your upper day.", "make today upper body", applied, [], true);
  assert.match(reply, /in place of Mine/, reply);
  assert.equal(revertDecision(built.decision_id, "user veto").ok, true);
  assert.equal(active().id, mine.daily_session.id);
});

test("a chat session over the plan's own card names nothing as replaced", () => {
  seedPlan();
  repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  const built = applyChatTodaySession(UPPER, { date: DATE });
  assert.equal(built.ok, true);
  assert.equal(built.replaced_title ?? null, null);
  const reply = reconcileChatPlanReply(
    "Here's your upper day.",
    "make today upper body",
    [{ type: "today_session", result: built }],
    [],
    true
  );
  assert.doesNotMatch(reply, /in place of/, reply);
});

// ---- 7. one predicate for the athlete's chosen card -----------------------------------

test("an adaptive replace never silently takes an unstarted manual plan pick", async () => {
  seedPlan();
  const picked = repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 2 });
  const res = await prepareRoute({ date: DATE, source: "adaptive_plan", replace: true });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "daily_session_active_changed");
  assert.equal(res.body.owner.daily_session_id, picked.daily_session.id);
  assert.equal(active().id, picked.daily_session.id);
});

test("an empty override replace (the outbox retry) never supersedes an itemful chosen card", async () => {
  seedPlan();
  for (const setup of [
    () => repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") }),
    () => repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 }),
  ]) {
    const owner = setup();
    const res = await prepareRoute({
      date: DATE,
      source: "athlete_override",
      replace: true,
      session: { name: "Open session", items: [] },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "daily_session_active_changed");
    assert.equal(res.body.owner.daily_session_id, owner.daily_session.id);
    assert.equal(active().id, owner.daily_session.id);
    repo.discardDailySession({ date: DATE, expected_active_id: owner.daily_session.id });
  }
  // The athlete authoring a NEW session (items) still replaces their own card.
  const mine = repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") });
  const res = await prepareRoute({ date: DATE, source: "athlete_override", replace: true, session: chosenCard("New") });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(res.body.daily_session.id, mine.daily_session.id);
});

// ---- 8. discard --------------------------------------------------------------------------

test("a session the athlete answered pain questions on is lived on: never discarded, never replaced", async () => {
  seedPlan();
  const card = repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") });
  const sessionId = Number(card.session_id);
  db.prepare(`INSERT OR IGNORE INTO exercises (name) VALUES ('Chest-Supported Row')`).run();
  recordExerciseSymptomObservation({
    date: DATE,
    movement: "Chest-Supported Row",
    session_id: sessionId,
    area_text: "left shoulder",
    outcome: "pain_present",
  });
  const discard = await routerRequest("POST", "/daily-session/discard", {
    date: DATE,
    expected_active_id: card.daily_session.id,
  });
  assert.equal(discard.status, 409, JSON.stringify(discard.body));
  assert.equal(discard.body.code, "daily_session_locked");
  assert.equal(discard.body.owner.started, true);
  assert.ok(sessionRow(sessionId), "the answered session stays");
  const replace = await prepareRoute({
    date: DATE,
    source: "athlete_override",
    replace: true,
    session: chosenCard("New"),
  });
  assert.equal(replace.status, 409);
  assert.equal(replace.body.code, "daily_session_locked");
  assert.equal(openSessionOn(DATE)?.started, true, "Today reads it as Continue");
});

test("discard never trips the null-session observation index", async () => {
  seedPlan();
  const card = repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") });
  const sessionId = Number(card.session_id);
  db.prepare(`INSERT OR IGNORE INTO exercises (name) VALUES ('Chest-Supported Row')`).run();
  const exerciseId = Number(db.prepare(`SELECT id FROM exercises WHERE name = 'Chest-Supported Row'`).get().id);
  const symptom = Number(
    db
      .prepare(
        `INSERT INTO training_symptom_events (source_kind, area_text, onset_on, last_reported_on)
         VALUES ('exercise_card', 'left shoulder', ?, ?) RETURNING id`
      )
      .get(DATE, DATE).id
  );
  const insert = db.prepare(
    `INSERT INTO movement_tolerance_observations
       (symptom_event_id, session_id, exercise_id, movement_key, movement_name, observed_on, outcome, evidence, relevant)
     VALUES (?, ?, ?, ?, 'Chest-Supported Row', ?, 'pain_free', 'inferred', 1)`
  );
  // The same exposure already stands with no session (an earlier session was deleted), and
  // a stale inferred one (its sets since deleted) still points at this session.
  insert.run(symptom, null, exerciseId, `exercise:${exerciseId}`, DATE);
  insert.run(symptom, sessionId, exerciseId, `exercise:${exerciseId}`, DATE);
  const res = await routerRequest("POST", "/daily-session/discard", {
    date: DATE,
    expected_active_id: card.daily_session.id,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(sessionRow(sessionId), undefined);
  assert.equal(
    Number(
      db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations WHERE symptom_event_id = ?`).get(symptom).n
    ),
    1,
    "the exposure is still on record once"
  );
});

// ---- 9. the words of a lock and of a finished day ----------------------------------------

test("a lock by notes alone says notes, not logged sets", () => {
  seedPlan();
  const card = repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") });
  repo.updateSessionNotes(Number(card.session_id), "Warm-up felt heavy.");
  const result = applyChatTodaySession(UPPER, { date: DATE });
  assert.equal(result.ok, false);
  assert.equal(result.code, "daily_session_locked");
  assert.notEqual(result.error, TODAY_SESSION_LOCKED_ERROR);
  assert.doesNotMatch(result.error, /logged sets/);
  assert.match(result.error, /notes/);
  assertReadable(result.error, "notes lock");
});

test("start_session over a finished day shows it as done and offers to add to it, never a second session", () => {
  seedPlan();
  const card = repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 2 });
  const sessionId = Number(card.session_id);
  repo.logSetByName({ date: DATE, exercise: "Barbell Row", weight: 115, reps: 8 });
  repo.finishSession(sessionId);
  const result = applyChatStartSession({ date: DATE });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.finished, true);
  assert.equal(result.session_id, sessionId);
  assert.doesNotMatch(result.open.label, /^(Start|Continue) /, result.open.label);
  assert.match(result.open.label, /^Log more/);
  const reply = reconcileChatPlanReply(
    "Let's go.",
    "let's start today's session",
    [{ type: "start_session", result }],
    [],
    true
  );
  assert.doesNotMatch(reply, /ready|Start it/i, reply);
  assert.match(reply, /done|finished/i, reply);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE date = ?`).get(DATE).n), 1);
  assert.ok(sessionRow(sessionId).finished_at, "opening is not reopening");
});

// ---- 6. a card adopted after the work was logged is never graded against it -------------

test("work logged before an adopted card is not graded against it", () => {
  seedPlan();
  // Logged from chat / the watch before any card existed.
  const logged = repo.logSetByName({ date: DATE, exercise: "Hammer Curl", weight: 30, reps: 10 });
  const sessionId = Number(logged.session_id);
  // Today opens the day: the adaptive card binds to that row.
  const adopted = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  assert.equal(Number(adopted.session_id), sessionId);
  const provenance = adopted.daily_session.provenance ?? {};
  assert.equal(provenance.adopted_after_log, true, JSON.stringify(provenance));
  assert.equal(typeof provenance.adopted_at, "string");
  repo.finishSession(sessionId);
  const outcome = repo.getDailySessionOutcome(DATE);
  assert.ok(outcome, "the day still has an outcome row");
  const facts = outcome.facts;
  assert.deepEqual(facts.substituted, [], "earlier work is not a substitution of a card nobody saw");
  assert.deepEqual(facts.skipped, [], "a card served after the work is not skipped");
  assert.ok(!facts.reason_codes.includes("substituted_movements"), facts.reason_codes.join(","));
  assert.ok(!facts.reason_codes.includes("partial_session"), facts.reason_codes.join(","));
  assert.ok(!facts.reason_codes.includes("extended_session"), facts.reason_codes.join(","));
  assert.ok(facts.dose_context.non_comparable_reasons.includes("adopted_after_log"));
  for (const dose of facts.dose_evidence) {
    assert.equal(dose.comparable, false, `${dose.exercise}: not comparable to a card served after the work`);
    assert.ok(dose.non_comparable_reasons.includes("adopted_after_log"), dose.exercise);
  }
});

test("work logged after the adoption is graded against the card as usual", () => {
  seedPlan();
  repo.logSetByName({ date: DATE, exercise: "Hammer Curl", weight: 30, reps: 10 });
  const adopted = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  const sessionId = Number(adopted.session_id);
  const [first, ...rest] = adopted.daily_session.items.filter((item) => item.kind !== "cardio");
  assert.ok(first, "the card holds a lift");
  for (let set = 0; set < Number(first.sets ?? 1); set++) {
    repo.logSetByName({
      date: DATE,
      exercise: first.exercise,
      weight: first.target_weight ?? 100,
      reps: first.rep_high ?? 8,
    });
  }
  repo.finishSession(sessionId);
  const facts = repo.getDailySessionOutcome(DATE).facts;
  assert.ok(facts.completed.includes(first.exercise), JSON.stringify(facts.completed));
  assert.ok(!facts.substituted.includes("Hammer Curl"), "the earlier curl is still not a substitution");
  // The rest of the card, untouched after the athlete started on it, reads as skipped.
  for (const item of rest) assert.ok(facts.skipped.includes(item.exercise), item.exercise);
  const dose = facts.dose_evidence.find((entry) => entry.exercise === first.exercise);
  assert.ok(!dose.non_comparable_reasons.includes("adopted_after_log"), JSON.stringify(dose));
});
