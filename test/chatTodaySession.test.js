// Today's session from chat (src/domain/training/chat-today-session.ts): a session the
// athlete asks for TODAY lands as today's own athlete_override composition — never a
// write to the weekly plan — and "let's start today's session" opens what Today serves.
// Both answer with where to go next (`open`), a refused day is said honestly, a replaced
// session is one Undo away, the router keeps "open my training day" off the food lane,
// and a reply that claims a session it did not build is held to what landed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, repo } from "./_seed.js";
import { applyChatActions, chatActionGates } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { TODAY_SESSION_LOCKED_ERROR } from "../dist/domain/training/chat-today-session.js";
import { decideChatRouting } from "../dist/chatRouting.js";
import { frameFoodCaptureMessage, hasExplicitTodaySessionIntent } from "../dist/chat-intent.js";
import {
  groundReply,
  PLAN_CLAIM_UNGROUNDED_VARIANTS,
  SESSION_CLAIM_UNGROUNDED_VARIANTS,
  SESSION_STATE_NONE_VARIANTS,
} from "../dist/chatGrounding.js";
import { chatChangeReceipts, reconcileChatPlanReply } from "../dist/chat-reconcile.js";
import { refreshChangeReceipts } from "../dist/repo/change-receipt.js";
import { executeCoachReadTool } from "../dist/brain/read-tool-runtime.js";
import { localDateISO } from "../dist/repo/shared.js";

const BUILD_ASK =
  "Combine the exercise plan from yesterday and today. Make it into a full upper body session combining pull and push. I have time for a lengthier session today.";
const START_ASK = "And let's start today's session";

const UPPER = {
  type: "today_session",
  title: "Upper — push + pull",
  why: "Two days in one, paired push with pull.",
  est_minutes: 80,
  items: [
    // Each pair holds at most one fixed station: dumbbells beside a machine or a cable row.
    { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, superset_group: 1 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10, target_weight: 70, superset_group: 1 },
    { exercise: "Dumbbell Shoulder Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 50, superset_group: 2 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60, superset_group: 2 },
    { exercise: "Plank", sets: 3, target_seconds: 45, mode: "timed" },
  ],
};

// The session the owner could not run: four pairs that each need two stations at once,
// beside four pairs a shared gym can run (one of them written as a group of three), all
// typed the way a coach would type them.
const FOUR_STATION_PAIRS = {
  type: "today_session",
  title: "Upper — everything paired",
  why: "Push and pull, paired.",
  est_minutes: 90,
  items: [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, superset_group: 1 },
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10, target_weight: 70, superset_group: 1 },
    { exercise: "Machine Shoulder Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60, superset_group: 2 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60, superset_group: 2 },
    { exercise: "Machine Chest Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 90, superset_group: 3 },
    { exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -40, superset_group: 3 },
    { exercise: "Leg Extension", sets: 3, rep_low: 10, rep_high: 12, target_weight: 100, superset_group: 4 },
    { exercise: "Lying Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 80, superset_group: 4 },
    { exercise: "Dumbbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60, superset_group: 5 },
    { exercise: "Push-Up", sets: 3, rep_low: 10, rep_high: 15, superset_group: 5 },
    { exercise: "Cable Fly", sets: 3, rep_low: 10, rep_high: 12, target_weight: 20, superset_group: 6 },
    { exercise: "Cable Face Pull", sets: 3, rep_low: 12, rep_high: 15, target_weight: 30, superset_group: 6 },
    { exercise: "Dumbbell Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 25, superset_group: 7 },
    { exercise: "Rope Pushdown", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50, superset_group: 7 },
    { exercise: "Dumbbell Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 15, superset_group: 7 },
    { exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60, superset_group: 8 },
    { exercise: "Dumbbell Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60, superset_group: 8 },
  ],
};

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest and shoulders", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 50 },
  ]);
  repo.savePlanDay(2, "Pull", "Back and arms", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10, target_weight: 70 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 60 },
  ]);
}

const planSnapshot = () =>
  db
    .prepare(
      `SELECT pd.day_number, pd.name, pi.exercise_id, pi.sets, pi.rep_low, pi.rep_high, pi.target_weight
         FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id ORDER BY pd.day_number, pi.position, pi.id`
    )
    .all();
const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
const active = (date = localDateISO()) =>
  db.prepare(`SELECT * FROM daily_session_compositions WHERE date = ? AND status = 'active'`).get(date);

function apply(actions, message, extra = {}) {
  return applyChatActions(
    { actions },
    {
      agent: "stub",
      message,
      priorAssistant: { message: "" },
      recentAthleteMessages: [],
      enqueueJob: () => {},
      ...extra,
    }
  );
}

const entry = (out, type) => out.applied.find((e) => e.type === type);

test("today_session lands as today's athlete_override, pairs kept, the weekly plan untouched", () => {
  seedPlan();
  const plan = planSnapshot();
  const proposals = count("plan_proposals");
  const out = apply([UPPER], BUILD_ASK, { userMessageId: 41 });
  const result = entry(out, "today_session").result;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.date, localDateISO());
  assert.equal(result.started, false);
  assert.deepEqual(result.open, { kind: "session", date: localDateISO(), label: "Start Upper — push + pull" });

  const row = active();
  assert.equal(row.id, result.daily_session_id);
  assert.equal(row.source, "athlete_override");
  const items = JSON.parse(row.items_json);
  assert.deepEqual(
    items.map((item) => [item.exercise, item.superset_group]),
    [
      ["Dumbbell Bench Press", 1],
      ["Lat Pulldown", 1],
      ["Dumbbell Shoulder Press", 2],
      ["Seated Cable Row", 2],
      ["Plank", null],
    ]
  );
  assert.equal(JSON.parse(row.provenance_json).entry, "chat_request");
  assert.equal(JSON.parse(row.provenance_json).chat_message_id, 41);
  // The ring's plan day is still the one the day credits.
  const ring = repo.selectedPlanDayForDate(localDateISO());
  if (ring?.plan_day_id) assert.equal(row.plan_day_id, ring.plan_day_id);
  // Nothing on the template moved and no plan proposal was written.
  assert.deepEqual(planSnapshot(), plan);
  assert.equal(count("plan_proposals"), proposals);
});

test("a chat session of two-station pairs comes back with the pairs a gym can run, and says which ran straight and why", () => {
  seedPlan();
  const out = apply([FOUR_STATION_PAIRS], BUILD_ASK);
  const result = entry(out, "today_session").result;
  assert.equal(result.ok, true, JSON.stringify(result));
  const items = JSON.parse(active().items_json);
  assert.equal(items.length, FOUR_STATION_PAIRS.items.length, "every lift stays on the card");
  const groupOf = (name) => items.find((item) => item.exercise === name).superset_group;
  // The realistic subset: three pairs, each holding one fixed station at most.
  assert.equal(groupOf("Dumbbell Row"), 5);
  assert.equal(groupOf("Push-Up"), 5);
  assert.equal(groupOf("Cable Fly"), 6, "two movements on one cable stack still pair");
  assert.equal(groupOf("Cable Face Pull"), 6);
  assert.equal(groupOf("Goblet Squat"), 8);
  assert.equal(groupOf("Dumbbell Romanian Deadlift"), 8);
  assert.equal(new Set(items.map((item) => item.superset_group).filter((g) => g != null)).size, 3);
  for (const name of [
    "Barbell Bench Press",
    "Lat Pulldown",
    "Machine Shoulder Press",
    "Seated Cable Row",
    "Machine Chest Press",
    "Assisted Pull-Up",
    "Leg Extension",
    "Lying Leg Curl",
    "Dumbbell Curl",
    "Rope Pushdown",
    "Dumbbell Lateral Raise",
  ]) {
    assert.equal(groupOf(name), null, `${name} runs straight`);
  }
  // Prescriptions are untouched by the unpairing.
  assert.equal(items.find((item) => item.exercise === "Lat Pulldown").sets, 3);
  // What was taken apart, and why, rides on the applied result for the reply to say.
  assert.deepEqual(result.unpaired, [
    { exercises: ["Barbell Bench Press", "Lat Pulldown"], reason: "two_stations" },
    { exercises: ["Machine Shoulder Press", "Seated Cable Row"], reason: "two_stations" },
    { exercises: ["Machine Chest Press", "Assisted Pull-Up"], reason: "two_stations" },
    { exercises: ["Leg Extension", "Lying Leg Curl"], reason: "two_stations" },
    { exercises: ["Dumbbell Lateral Raise"], reason: "group_over_two" },
    // Four doable pairs remain; the one the effect-tier order ranks last runs straight.
    { exercises: ["Dumbbell Curl", "Rope Pushdown"], reason: "pair_limit" },
  ]);
});

test("a chat session whose pairs a gym can run carries no unpaired record", () => {
  seedPlan();
  const result = entry(apply([UPPER], BUILD_ASK), "today_session").result;
  assert.equal(result.ok, true);
  assert.equal(result.unpaired, undefined);
});

test("the receipt leads with the session and its Start button; the reply names today's session, not a plan day", () => {
  seedPlan();
  const out = apply([UPPER], BUILD_ASK);
  const result = entry(out, "today_session").result;
  const receipts = chatChangeReceipts(out.applied, []);
  assert.equal(receipts[0].key, `session:${result.daily_session_id}`);
  assert.deepEqual(receipts[0].open, result.open);
  assert.equal(receipts[0].status, "applied");
  // Nothing was replaced, so the Undo is the plan's own session coming back.
  assert.deepEqual(receipts[0].undo, { kind: "brain_decision", id: result.decision_id });
  // A stored receipt re-read keeps the button and the Undo while they still stand.
  const [again] = refreshChangeReceipts(JSON.parse(JSON.stringify(receipts)));
  assert.deepEqual(again.open, result.open);
  assert.deepEqual(again.undo, receipts[0].undo);

  const reply = reconcileChatPlanReply("Here's your combined upper day.", BUILD_ASK, out.applied, [], true);
  assert.doesNotMatch(reply, /Saved and verified plan day/);
  assert.doesNotMatch(reply, /No plan change was saved/);
  assert.match(reply, /Upper — push \+ pull/);
});

test("a started day refuses today_session honestly and points at the session underway", () => {
  seedPlan();
  apply([{ type: "start_session" }], START_ASK);
  repo.logSetByName({ exercise: "Barbell Bench Press", weight: 100, reps: 8, date: localDateISO() });
  const before = active();
  const out = apply([UPPER], BUILD_ASK);
  const result = entry(out, "today_session").result;
  assert.equal(result.ok, false);
  assert.equal(result.code, "daily_session_locked");
  assert.equal(result.error, TODAY_SESSION_LOCKED_ERROR);
  assert.equal(result.started, true);
  assert.match(result.open.label, /^Continue /);
  assert.equal(active().id, before.id, "the day's session is untouched");
  assert.deepEqual(chatChangeReceipts(out.applied, []), []);

  // The reply says so, and a claim that it was built does not survive beside it.
  const proposed = "I've built your combined upper session for today.";
  const reconciled = reconcileChatPlanReply(proposed, BUILD_ASK, out.applied, [], true);
  assert.ok(reconciled.includes(TODAY_SESSION_LOCKED_ERROR), reconciled);
  const grounded = groundReply({
    reply: reconciled,
    applied: out.applied,
    ctx: { message: BUILD_ASK, proposedReply: proposed },
  });
  assert.doesNotMatch(grounded.reply, /I've built/);
  assert.ok(grounded.reply.includes(TODAY_SESSION_LOCKED_ERROR));
});

test("start_session prepares the plan's day when nothing is composed, and reuses what is", () => {
  seedPlan();
  const first = entry(apply([{ type: "start_session" }], START_ASK), "start_session").result;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.reused, false);
  assert.equal(active().source, "adaptive_plan");
  assert.equal(first.open.kind, "session");
  assert.match(first.open.label, /^Start /);

  const versions = count("daily_session_compositions");
  const again = entry(apply([{ type: "start_session" }], START_ASK), "start_session").result;
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(again.daily_session_id, first.daily_session_id);
  assert.equal(count("daily_session_compositions"), versions, "the assertion path rewrites nothing");

  // An athlete_override already owning the day is what start_session opens.
  const built = entry(apply([UPPER], BUILD_ASK), "today_session").result;
  const opened = entry(apply([{ type: "start_session" }], START_ASK), "start_session").result;
  assert.equal(opened.daily_session_id, built.daily_session_id);
  assert.equal(opened.title, "Upper — push + pull");
  assert.equal(active().source, "athlete_override");
});

test("Undo of a today_session puts the session it replaced back, while nothing is logged", () => {
  seedPlan();
  const plan = entry(apply([{ type: "start_session" }], START_ASK), "start_session").result;
  const built = entry(apply([UPPER], BUILD_ASK), "today_session").result;
  assert.equal(built.replaced_composition_id, plan.daily_session_id);
  assert.ok(built.decision_id > 0);
  const decision = repo.getBrainDecision(built.decision_id);
  assert.equal(decision.kind, "session_suggestion");
  assert.equal(decision.autonomy_tier, "observe");
  assert.equal(decision.reversible, true);

  // Through the chat door the athlete uses: "undo that".
  const out = apply([{ type: "revert_decision", id: built.decision_id }], "undo that");
  assert.equal(entry(out, "revert_decision").result.ok, true, JSON.stringify(out.applied));
  assert.equal(active().id, plan.daily_session_id, "the earlier session owns the day again");
  assert.equal(
    db.prepare(`SELECT status FROM daily_session_compositions WHERE id = ?`).get(built.daily_session_id).status,
    "superseded"
  );
  assert.equal(repo.getBrainDecision(built.decision_id).status, "reverted");
  const [receipt] = refreshChangeReceipts([
    {
      key: `session:${built.daily_session_id}`,
      what: "Today's session: Upper",
      status: "applied",
      undo: { kind: "brain_decision", id: built.decision_id },
    },
  ]);
  assert.equal(receipt.status, "undone");
  assert.equal(receipt.status_words, "Put back");
  assert.equal(receipt.open, null);
  assert.equal(receipt.undo, null);
});

// The one "started" test (session-started.ts), not a set count alone: notes, a rating and
// a finish each make the chat-built session the record of the day, and Undo leaves it.
const LIVED_ON = {
  "a logged set": () =>
    repo.logSetByName({ exercise: "Barbell Bench Press", weight: 100, reps: 8, date: localDateISO() }),
  "notes only": (sessionId) => repo.updateSessionNotes(sessionId, "Felt strong on the first pair."),
  "feedback only": () => repo.setSessionFeedback(localDateISO(), { performance: 4 }),
  "finished with nothing logged": (sessionId) => repo.finishSession(sessionId),
};
for (const [name, liveOn] of Object.entries(LIVED_ON)) {
  test(`Undo refuses once today's session is lived on: ${name}`, () => {
    seedPlan();
    apply([{ type: "start_session" }], START_ASK);
    const built = entry(apply([UPPER], BUILD_ASK), "today_session").result;
    liveOn(built.session_id);
    const undone = revertDecision(built.decision_id, "user veto");
    assert.equal(undone.ok, false, JSON.stringify(undone));
    assert.match(undone.error, /^Today's session|^You've finished/, undone.error);
    assert.doesNotMatch(undone.error, /_|\bid\b|\d/, undone.error);
    assert.equal(active().id, built.daily_session_id, "the session the record is about stands");
    assert.equal(repo.getBrainDecision(built.decision_id).status, "applied");
  });
}

test("the actions are offered only on the athlete's ask, and refused without it", () => {
  for (const message of [BUILD_ASK, START_ASK, "open my today's training day", "Give me a shorter workout today"]) {
    assert.equal(chatActionGates({ message, priorAssistant: { message: "" } }).todaySession, true, message);
  }
  for (const message of [
    "How did today's session go?",
    "Should I train today?",
    "I had eggs for breakfast",
    "How was my week?",
  ]) {
    assert.equal(chatActionGates({ message, priorAssistant: { message: "" } }).todaySession, false, message);
  }
  // The polite-question form of a build is the ask itself; an information question is not.
  assert.equal(hasExplicitTodaySessionIntent("Can you build me a longer session today?"), true, "a polite ask");
  assert.equal(hasExplicitTodaySessionIntent("What is today's session?"), false, "a question");
  // The coach's own offer, then a plain go-ahead.
  const offer = { message: "That fits your week. Want me to set that up as today's session?" };
  assert.equal(chatActionGates({ message: "yes, set it up", priorAssistant: offer }).todaySession, true);
  assert.equal(
    chatActionGates({ message: "yes, set it up", priorAssistant: { message: "Nice work." } }).todaySession,
    false
  );

  seedPlan();
  const out = apply([UPPER, { type: "start_session" }], "How was my week?");
  assert.deepEqual(out.applied, []);
  assert.equal(count("daily_session_compositions"), 0);
});

test("the normalizer keeps only prescription fields and needs an item", () => {
  const action = normalizeChatAction({
    type: "today_session",
    title: "  Upper  ",
    items: [{ exercise: "Bench", sets: 3, superset_group: 2, brain_decision_id: 9, junk: true }, { sets: 3 }],
  });
  assert.deepEqual(action, {
    type: "today_session",
    title: "Upper",
    why: null,
    est_minutes: null,
    items: [{ exercise: "Bench", sets: 3, superset_group: 2 }],
  });
  assert.equal(normalizeChatAction({ type: "today_session", title: "x", items: [] }), null);
  assert.deepEqual(normalizeChatAction({ type: "start_session", date: "2020-01-01" }), { type: "start_session" });
});

test("'open my today's training day' typed into the food box routes to the coach, unframed", () => {
  for (const words of ["open my today's training day", "Open my today’s training day", "let's start today's session"]) {
    const framed = frameFoodCaptureMessage(words, false);
    assert.equal(framed, words.trim(), "never framed as a food log");
    for (const message of [framed, `Log food: ${words}`]) {
      const routing = decideChatRouting({ message });
      assert.equal(routing.lane, "coach", `${message}: ${JSON.stringify(routing)}`);
      assert.ok(!routing.reason_codes.includes("explicit_food_log"), message);
    }
  }
  // A real meal typed into the same box is still a food log.
  assert.equal(decideChatRouting({ message: frameFoodCaptureMessage("2 eggs and toast", false) }).lane, "capture");
});

test("a claim that today's session is built needs a landed today_session", () => {
  const today = localDateISO();
  const claim = "I've built a full upper-body session for today.";
  const overPlan = groundReply({
    reply: claim,
    applied: [{ type: "plan_update", result: { ok: true, verified: true } }],
    ctx: { message: BUILD_ASK, today },
  });
  assert.ok(SESSION_CLAIM_UNGROUNDED_VARIANTS.includes(overPlan.reply), overPlan.reply);
  assert.equal(overPlan.notes[0].class, "session");
  // "Ready" is a statement about Today's state: with nothing open, the correction says so
  // (chatTodaySessionWords.test.js holds the state rules).
  const ready = groundReply({
    reply: "Your session is ready on Today.",
    applied: [],
    ctx: { message: START_ASK, today },
  });
  assert.ok(SESSION_STATE_NONE_VARIANTS.includes(ready.reply), ready.reply);
  assert.equal(ready.notes[0].class, "session_state");

  const landed = [{ type: "today_session", result: { ok: true, daily_session_id: 1 } }];
  assert.equal(groundReply({ reply: claim, applied: landed, ctx: { message: BUILD_ASK, today } }).reply, claim);
  const opened = [{ type: "start_session", result: { ok: true, daily_session_id: 1 } }];
  assert.equal(
    groundReply({ reply: "Your session is ready on Today.", applied: opened, ctx: { message: START_ASK, today } })
      .reply,
    "Your session is ready on Today."
  );
});

test("a refused plan_update no longer grounds a plan claim", () => {
  const today = localDateISO();
  const claim = "I've updated your plan so today's bench is lighter.";
  const refused = [{ type: "plan_update", result: { ok: false, persisted: false, error: "no lift on that date" } }];
  const out = groundReply({ reply: claim, applied: refused, ctx: { message: "make today's bench lighter", today } });
  assert.ok(PLAN_CLAIM_UNGROUNDED_VARIANTS.includes(out.reply), out.reply);
  const landed = [{ type: "plan_update", result: { ok: true, verified: true } }];
  assert.equal(groundReply({ reply: claim, applied: landed, ctx: { today } }).reply, claim);
  // A landed today_session grounds a plan claim about TODAY, never one about another day.
  const session = [{ type: "today_session", result: { ok: true, daily_session_id: 1 } }];
  const todayClaim = "I've swapped today's split for one upper day.";
  assert.equal(groundReply({ reply: todayClaim, applied: session, ctx: { today } }).reply, todayClaim);
  const otherDay = groundReply({
    reply: "I've moved your squat session to Thursday.",
    applied: session,
    ctx: { today },
  });
  assert.ok(PLAN_CLAIM_UNGROUNDED_VARIANTS.includes(otherDay.reply), otherDay.reply);
});

test("an undated change scoped to today ends today, unless their words make it lasting", () => {
  seedPlan();
  const today = localDateISO();
  const ring = repo.selectedPlanDayForDate(today);
  assert.ok(ring, "today carries a plan day");
  const change = { day_number: 2, exercise: "Barbell Bench Press", sets: 2, reason: "short on time" };
  const scoped = entry(
    apply(
      [{ type: "plan_update", summary: "lighter today", changes: [change] }],
      "Make today's session lighter, 2 sets of bench"
    ),
    "plan_update"
  ).result;
  const proposal = repo.getProposal(scoped.proposal_id);
  assert.equal(proposal.parsed.changes[0].until, today);
  assert.equal(proposal.parsed.changes[0].day_number, ring.day_number);

  const lasting = entry(
    apply(
      [{ type: "plan_update", summary: "lighter", changes: [change] }],
      "Make today's session lighter from now on, 2 sets of bench"
    ),
    "plan_update"
  ).result;
  assert.equal(repo.getProposal(lasting.proposal_id).parsed.changes[0].until, undefined);
});

const SIDE_EDIT = {
  type: "plan_update",
  summary: "lighter bench",
  changes: [{ day_number: 2, exercise: "Barbell Bench Press", sets: 2, reason: "short on time" }],
};

test("a today-scoped plan_update beside a today_session is skipped and recorded, the session lands", () => {
  seedPlan();
  const plan = planSnapshot();
  const proposals = count("plan_proposals");
  for (const actions of [
    [UPPER, SIDE_EDIT],
    [SIDE_EDIT, UPPER],
  ]) {
    const out = apply(actions, BUILD_ASK);
    assert.equal(entry(out, "today_session").result.ok, true);
    const skipped = entry(out, "plan_update").result;
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.skip_reason, "today_session_in_turn");
    assert.equal(skipped.persisted, false);
  }
  assert.deepEqual(planSnapshot(), plan, "the plan day was not edited");
  assert.equal(count("plan_proposals"), proposals, "no proposal was written");
});

test("a lasting plan change beside a today_session still applies", () => {
  seedPlan();
  const out = apply([UPPER, SIDE_EDIT], `${BUILD_ASK} And keep bench at 2 sets from now on.`);
  assert.equal(entry(out, "today_session").result.ok, true);
  const edit = entry(out, "plan_update").result;
  assert.notEqual(edit.skipped, true);
  assert.ok(edit.proposal_id, "the lasting change went through the proposal path");
});

test("a refused today_session does not let its plan_update through in its place", () => {
  seedPlan();
  apply([{ type: "start_session" }], START_ASK);
  repo.logSetByName({ exercise: "Barbell Bench Press", weight: 100, reps: 8, date: localDateISO() });
  const plan = planSnapshot();
  const out = apply([UPPER, SIDE_EDIT], BUILD_ASK);
  assert.equal(entry(out, "today_session").result.code, "daily_session_locked");
  assert.equal(entry(out, "plan_update").result.skip_reason, "today_session_in_turn");
  assert.deepEqual(planSnapshot(), plan);
});

test("read_today_session returns what Today serves and whether it is started", () => {
  seedPlan();
  const empty = executeCoachReadTool({ tool: "read_today_session", args: {} }, { run_id: "t" });
  assert.equal(empty.data.found, false);
  apply([UPPER], BUILD_ASK);
  const read = executeCoachReadTool({ tool: "read_today_session", args: { date: null } }, { run_id: "t" });
  assert.equal(read.data.found, true);
  assert.equal(read.data.started, false);
  assert.equal(read.data.session.source, "athlete_override");
  assert.equal(read.data.session.items.length, 5);
  assert.equal(read.data.session.items[1].superset_group, 1);
  assert.equal(read.rows_returned, 5);
  assert.throws(() =>
    executeCoachReadTool({ tool: "read_today_session", args: { date: "not-a-date" } }, { run_id: "t" })
  );
});
