// STATED INPUT, end to end: what the athlete SAYS is first-class evidence the brain acts on
// — captured in chat as structured, attributed state (src/chat-intent.ts, chatTurns.ts),
// recorded in the ledger and shown in the Changes feed as "You said X → the brain changed
// Y" (src/domain/brain/changes-feed.ts, src/domain/training/stated-input.ts), said
// honestly when the evidence holds against it (training-drive-read.ts stanceHeldBy, the
// conference's stated_push conflict, the conductor's lead), and — when he says nothing but
// the log shows he is carrying more than the program asks — PROPOSED as an ask-tier offer
// he can accept in one tap or dismiss for good (src/repo/push-offer.ts,
// src/domain/training/push-offer.ts).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import {
  carriesDriveAffirmation,
  coachOfferedPush,
  hasExplicitTrainingDriveIntent,
  hasExplicitTrainingDriveIntentInContext,
} from "../dist/chat-intent.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { reconcileTrainingDriveReply } from "../dist/chat-reconcile.js";
import { setTrainingDrive } from "../dist/domain/training/training-drive.js";
import { acceptPushOffer, dismissPushOffer, offerPushStanceIfEarned } from "../dist/domain/training/push-offer.js";
import { recordStatedRunWeek } from "../dist/domain/training/stated-input.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { brainChangesRead } from "../dist/domain/brain/changes-feed.js";
import { conflictsFromInputs, conferenceConflictInputs } from "../dist/domain/brain/conference-conflicts.js";
import { getBrainDecision, listBrainExpectations, rollbackEvidenceByKind } from "../dist/repo/brain-decisions.js";
import { buildReactionModel } from "../dist/repo/reaction-model.js";
import {
  OFFER_DISMISS_COOLDOWN_DAYS,
  OFFER_STANCE_DAYS,
  openPushOfferDecision,
  pushOfferRead,
  pushOfferVerdict,
} from "../dist/repo/push-offer.js";
import { stanceHeldBy, trainingDriveForCoach, trainingDriveRead } from "../dist/repo/training-drive-read.js";
import { pushStanceActive, trainingDriveState } from "../dist/repo/training-drive.js";
import { reportTrainingSymptom } from "../dist/repo/training-symptoms.js";
import { renderStatedInputLine, renderTrainingDriveLine } from "../dist/prompt/shared.js";
import { stanceOnLead } from "../dist/repo/coach.js";
import { WEEKLY_DOSE_STANCE_MAX_FILLS, weeklyDoseDecision } from "../dist/repo/weekly-dose-ledger.js";

const today = () => localDateISO();

beforeEach(() => {
  resetTables("training_stances", "brain_decisions", "brain_expectations", "brain_rollbacks", "app_state");
});

const allChanges = () => brainChangesRead({ asOf: today() }).days.flatMap((d) => d.changes);

// ---------- 1. capture: the athlete's own sentence, in their words ----------

test("capture: every way of saying 'push' is the athlete's word; a question or narration is not", () => {
  for (const yes of [
    "I can push harder",
    "I want to push this block",
    "Let's push this week",
    "I feel I'm ready for more",
    "I'm ready for heavier",
    "I'm not doing the deload",
    "skip the deload this week",
    "I'm going to push it this week",
    "open the throttle",
    "give me more work",
    "don't push me so hard, back to steady",
  ])
    assert.equal(hasExplicitTrainingDriveIntent(yes), true, yes);
  for (const no of [
    "should I push harder?",
    "am I ready for more?",
    "felt easy, could have done way more",
    "I pushed the sled today",
    "give me more protein ideas for lunch",
    "Thursday is a hard threshold 5k with a few km around it",
  ])
    assert.equal(hasExplicitTrainingDriveIntent(no), false, no);
});

test("capture: a bare 'yes' counts only right after the coach ASKED whether to push", () => {
  const coachAsked = "You're carrying this well — want to open the throttle for the next two weeks?";
  assert.equal(carriesDriveAffirmation("yes, let's do it"), true);
  assert.equal(hasExplicitTrainingDriveIntentInContext("yes, let's do it", { priorCoachMessage: coachAsked }), true);
  assert.equal(
    hasExplicitTrainingDriveIntentInContext("yes, let's do it", { priorCoachMessage: "Want me to log that run?" }),
    false,
    "a yes to something else never sets the drive"
  );
  assert.equal(hasExplicitTrainingDriveIntentInContext("yes", {}), false);
  assert.equal(
    hasExplicitTrainingDriveIntentInContext("not yet, maybe later", { priorCoachMessage: coachAsked }),
    false,
    "a reversal is not consent"
  );
});

test("capture: a 'yes' to a plan day called Push, or to moving a session, never sets the drive", () => {
  for (const offer of [
    "You're carrying this well — want to open the throttle for the next two weeks?",
    "The program looks light for you right now: three lifts keep stepping up. Want me to push you for the next two weeks?",
    "You've been handling more than the plan asks. Open it up for two weeks?",
    "Want me to push you harder through the end of the block?",
  ])
    assert.equal(coachOfferedPush(offer), true, offer);
  for (const notOffer of [
    "Push is still open — want to do it after work?",
    "Your Push day is up next. Ready?",
    "Want to push it to Thursday instead?",
    "Should we push the long run back a day?",
    "Want to add step ups to Push?",
  ]) {
    assert.equal(coachOfferedPush(notOffer), false, notOffer);
    assert.equal(
      hasExplicitTrainingDriveIntentInContext("yes, let's do it", { priorCoachMessage: notOffer }),
      false,
      notOffer
    );
  }
});

// ---------- 2. transcript: a stated push lands, attributed, with an honest receipt ----------

test("transcript: 'I want to push this block' sets a dated stance in his own words and says so", () => {
  const message = "I want to push this block — the program feels light.";
  const { applied } = applyChatActions(
    { actions: [{ type: "set_training_drive", drive: "push", until: addDaysISO(today(), 20), words: "paraphrase" }] },
    { agent: "stub", message, recentAthleteMessages: [], priorAssistant: { message: "", drafted: false } }
  );
  const entry = applied.find((a) => a.type === "set_training_drive");
  assert.ok(entry?.result?.ok, JSON.stringify(entry));
  const state = trainingDriveState(today());
  assert.equal(state.drive, "push");
  assert.equal(state.stance.words, message, "the stance keeps HIS sentence, never the model's paraphrase");
  const decision = getBrainDecision(entry.result.decision_id);
  assert.equal(decision.context.stated_by_athlete, true);
  assert.equal(decision.autonomy_tier, "observe", "his word, recorded — not a tier the team acted at");

  const reply = reconcileTrainingDriveReply("Got it — let's lean in.", applied);
  assert.match(reply, /Got it — let's lean in\./);
  assert.match(reply, /Undo/, "the receipt names the one-tap Undo");
});

test("transcript: a question never sets the drive, and a reply that claims it did is corrected", () => {
  const { applied } = applyChatActions(
    { actions: [{ type: "set_training_drive", drive: "push" }] },
    { agent: "stub", message: "should I push harder?", recentAthleteMessages: [], priorAssistant: { message: "" } }
  );
  assert.equal(pushStanceActive(today()), false);
  assert.match(applied[0].error, /your own words/);
  const reply = reconcileTrainingDriveReply("I've set you to push for four weeks.", applied);
  assert.doesNotMatch(reply, /I've set you to push/);
  assert.match(reply, /did not change|unchanged/);
});

test("transcript: 'yes' after the coach's push question sets it, kept as an answer to the offer", () => {
  const { applied } = applyChatActions(
    { actions: [{ type: "set_training_drive", drive: "push", until: addDaysISO(today(), 13) }] },
    {
      agent: "stub",
      message: "yes, let's do it",
      recentAthleteMessages: [],
      priorAssistant: { message: "You're handling more than the plan asks. Want to open the throttle for two weeks?" },
    }
  );
  assert.ok(applied[0].result?.ok, JSON.stringify(applied[0]));
  assert.match(trainingDriveState(today()).stance.words, /coach's offer/);
});

// ---------- 3. stated threshold session → ledger, feed, Undo ----------

test("transcript: 'Thursday is a hard threshold 5k' is recorded as his, shown as 'You said X → Y', and undoable", () => {
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      source: "athlete",
    },
  });
  const message = "Thursday is a hard threshold 5k with a few km around it";
  applyChatActions(
    { actions: [{ type: "set_endurance_schedule", quality: { type: "threshold", work_km: 5 } }] },
    { agent: "stub", message, recentAthleteMessages: [], priorAssistant: { message: "" } }
  );
  assert.equal(repo.getEnduranceSchedule().quality.type, "threshold");
  assert.equal(repo.getEnduranceSchedule().quality.work_km, 5);

  const row = allChanges().find((c) => c.said);
  assert.ok(row, "the stated session is a row in the Changes feed");
  assert.equal(row.said, message);
  assert.match(row.title, /Thursday's quality run is now a threshold 5 km/);
  assert.match(row.why, /^You said “Thursday is a hard threshold 5k/);
  assert.equal(row.new, false, "his own word is in the feed, but it is not news to him");
  assert.equal(row.undo.available, true);
  assert.equal(row.undo.label, "Go back to your previous run week");

  const undone = revertDecision(row.id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(repo.getEnduranceSchedule().quality ?? null, null, "Undo puts the week back as it stood");
  assert.equal(repo.getEnduranceSchedule().days.length, 3, "the run days were never touched");
});

test("a stated run week: nothing changed records nothing; a newer statement wins over an older Undo", () => {
  const before = repo.getEnduranceSchedule();
  assert.equal(recordStatedRunWeek({ before, via: "mcp" }), null, "no change, no row");
  repo.setProfile({
    endurance_schedule: { days: [{ dow: 4, kind: "quality" }], quality: { type: "tempo" }, source: "athlete" },
  });
  const first = recordStatedRunWeek({ before, words: "tempo on Thursday", via: "mcp" });
  const mid = repo.getEnduranceSchedule();
  repo.setProfile({ endurance_schedule: { quality: { type: "hills" } } });
  recordStatedRunWeek({ before: mid, words: "make it hills", via: "mcp" });
  const refused = revertDecision(first);
  assert.equal(refused.ok, false, "the older statement's Undo refuses once a newer one stands");
  assert.equal(repo.getEnduranceSchedule().quality.type, "hills");
});

test("undoing his own run-week statements twice is never 'you've undone a training structure change'", () => {
  for (const type of ["tempo", "hills"]) {
    const before = repo.getEnduranceSchedule();
    repo.setProfile({
      endurance_schedule: { days: [{ dow: 4, kind: "quality" }], quality: { type }, source: "athlete" },
    });
    const id = recordStatedRunWeek({ before, words: `${type} on Thursday`, via: "mcp" });
    assert.ok(id, "the statement is recorded");
    assert.equal(revertDecision(id).ok, true);
  }
  assert.ok(!rollbackEvidenceByKind().some((g) => g.kind === "training_structure"));
  assert.ok(!buildReactionModel().patterns.some((p) => p.kind === "rollback_evidence"));
});

// ---------- 4. the Changes feed shows the stated push ----------

test("feed: a stated push reads 'You said X → the brain changed Y' with Undo", () => {
  const res = setTrainingDrive({
    drive: "push",
    until: addDaysISO(today(), 13),
    words: "I can push way harder than this",
  });
  const row = allChanges().find((c) => c.id === res.decision_id);
  assert.ok(row, "the stance is a row of the feed (it was invisible at observe tier)");
  assert.equal(row.title, "Pushing harder for the next two weeks");
  assert.equal(row.said, "I can push way harder than this");
  assert.match(row.why, /^You said “I can push way harder than this”\. On clean days the room widens/);
  assert.equal(row.undo.label, "Go back to your previous drive");
  assert.equal(row.new, false);
});

// ---------- 5. conflict honesty: his word stands, and the floors are said ----------

test("conflict: an open symptom holds against a push — said to every prompt and on the conductor's lead", () => {
  setTrainingDrive({ drive: "push", until: addDaysISO(today(), 13), words: "push me" });
  assert.deepEqual(stanceHeldBy(today()), [], "nothing holds on a clean day");
  reportTrainingSymptom({ area_text: "left knee", onset_on: today(), report_text: "my left knee aches on stairs" });
  const held = stanceHeldBy(today());
  assert.ok(
    held.some((h) => /symptom/.test(h)),
    JSON.stringify(held)
  );

  const coach = trainingDriveForCoach(today());
  assert.deepEqual(coach.held_by, held);
  const line = renderTrainingDriveLine({ training_drive: coach });
  assert.match(line, /THEIR OWN STANCE — PUSH/);
  assert.match(line, /RIGHT NOW THE FLOORS HOLD AGAINST IT: .*symptom/);
  assert.match(line, /never quietly obey the push over it, never quietly override the push/);

  const lead = { domain: "training", title: "Bench Press leads", why: "It is moving." };
  const read = trainingDriveRead(today(), { withToday: false });
  const heldLead = stanceOnLead(lead, read, held);
  assert.match(heldLead.why, /^It is moving\. .*(holds it back|gives way)/);
  assert.ok(heldLead.based_on[0].startsWith("your push stance"));
  const cleanLead = stanceOnLead(lead, read, []);
  assert.match(cleanLead.why, /push/);
  const recoveryLead = { domain: "recovery", title: "Ease the week", why: "Recovery is low." };
  assert.equal(stanceOnLead(recoveryLead, read, held), recoveryLead, "a protective lead is never rewritten");
});

test("conflict: the conference names a stated push meeting recovery strain, injury or an act-now training lever", () => {
  const base = {
    training_drive: { drive: "push", stance: { since: today(), until: addDaysISO(today(), 13) } },
    signal_state: { dimensions: { recovery_capacity: { status: "watch" } }, action: {} },
  };
  assert.ok(conflictsFromInputs(conferenceConflictInputs(base)).includes("stated_push"));
  const steady = { ...base, training_drive: { drive: "steady", stance: null } };
  assert.ok(!conflictsFromInputs(conferenceConflictInputs(steady)).includes("stated_push"));
  const clean = { ...base, signal_state: { dimensions: { recovery_capacity: { status: "supportive" } }, action: {} } };
  assert.ok(
    !conflictsFromInputs(conferenceConflictInputs(clean)).includes("stated_push"),
    "a clean push is no conflict"
  );
  const absent = { signal_state: base.signal_state };
  assert.ok(!conflictsFromInputs(conferenceConflictInputs(absent)).includes("stated_push"), "absence never fires");
  const injured = {
    ...clean,
    context_events: [{ kind: "injury", title: "tweaked shoulder" }],
  };
  assert.ok(conflictsFromInputs(conferenceConflictInputs(injured)).includes("stated_push"));
});

test("the conference seats are told his word: the stance and the stated quality session", () => {
  const line = renderStatedInputLine({
    training_drive: {
      drive: "push",
      stance: { since: today(), until: addDaysISO(today(), 13), words: "push me" },
      licenses: [],
      never_overrides: [],
    },
    endurance_schedule: { days: [{ dow: 4, kind: "quality" }], quality: { type: "threshold", work_km: 5 } },
  });
  assert.match(line, /THE ATHLETE'S OWN WORD/);
  assert.match(line, /PUSH, through/);
  assert.match(line, /STATED QUALITY SESSION: threshold \(5 km of work\) on Thursday/);
  assert.equal(renderStatedInputLine({ training_drive: { drive: "steady" } }), "");
});

// ---------- 6. a stated push changes what the week carries ----------

test("an open stance lets the week's dose take one more fill — still one set per item, load unchanged", () => {
  const eligible = ["Cable Row", "Lateral Raise", "Leg Curl", "Triceps Pushdown"].map((exercise, i) => ({
    exercise,
    group: ["back", "shoulders", "hamstrings", "triceps"][i],
    sets: 3,
  }));
  const snapshot = { gaps: eligible.map((e) => ({ group: e.group, short: 2 })), eligible };
  const ctx = (stanceOpen) => ({
    date: today(),
    kind: "train",
    dayType: "training",
    runDay: false,
    trainAnyway: false,
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: [], deep: [] },
    candidates: eligible.map((e) => ({ exercise: e.exercise, action: "carry", reason_code: null })),
    recoveryWeek: false,
    mesocyclePhase: "accumulation",
    stanceOpen,
    snapshot: { day_read: {}, muscle_load: [] },
  });
  assert.equal(weeklyDoseDecision(snapshot, ctx(false)).dose.fills.length, 2);
  const pushed = weeklyDoseDecision(snapshot, ctx(true)).dose.fills;
  assert.equal(pushed.length, WEEKLY_DOSE_STANCE_MAX_FILLS);
  assert.ok(pushed.every((f) => f.add_sets === 1));
});

// ---------- 7. inference with consent: the push offer ----------

const facts = (over = {}) => ({
  date: "2031-05-10",
  pushing: false,
  lifts_carried: ["Bench Press", "Back Squat"],
  lifts_struggling: [],
  sessions: 7,
  strong_sessions: 3,
  poor_sessions: 0,
  rir_reserve_sets: 4,
  recovery_supportive: false,
  harm_dates: [],
  brakes: [],
  open_symptoms: 0,
  clinical_training_hold: false,
  recovery_week: false,
  deload: false,
  dismissed_on: null,
  stance_ended_on: null,
  ...over,
});

test("offer verdict: carried lifts plus a witness earn the question; every floor closes it", () => {
  const ok = pushOfferVerdict(facts());
  assert.equal(ok.eligible, true, JSON.stringify(ok));
  assert.match(ok.evidence[0], /Bench Press and Back Squat keep stepping up/);
  assert.ok(
    ok.evidence.every((e) => !/\d+%|score/i.test(e)),
    "plain words, never a score"
  );
  const blocked = {
    already_pushing: { pushing: true },
    harm: { harm_dates: ["2031-05-08"] },
    brake: { brakes: ["hrv"] },
    symptom: { open_symptoms: 1 },
    clinical: { clinical_training_hold: true },
    recovery_week: { recovery_week: true },
    deload: { deload: true },
    dismissed: { dismissed_on: "2031-05-01" },
    stance_recent: { stance_ended_on: "2031-05-05" },
    thin_log: { sessions: 2 },
    not_carried: { lifts_struggling: ["Overhead Press"] },
  };
  for (const [key, over] of Object.entries(blocked)) {
    const v = pushOfferVerdict(facts(over));
    assert.equal(v.eligible, false, key);
    assert.ok(v.blockers.includes(key), `${key}: ${v.blockers}`);
  }
  assert.equal(
    pushOfferVerdict(facts({ dismissed_on: addDaysISO("2031-05-10", -OFFER_DISMISS_COOLDOWN_DAYS) })).eligible,
    true,
    "a 'not now' holds for the cooldown, then the question may come back"
  );
  assert.equal(
    pushOfferVerdict(facts({ strong_sessions: 0, rir_reserve_sets: 0 })).eligible,
    false,
    "carried lifts alone are not enough — one more witness is needed"
  );
});

test("offer evaluator reads the real log: climbing compounds, strong ratings and reps in reserve", () => {
  resetTables("logged_sets", "sessions", "exercises", "plan_items", "plan_days");
  const t = today();
  [19, 15, 11, 7, 3].forEach((d, i) => {
    const date = addDaysISO(t, -d);
    repo.logSetByName({ exercise: "Bench Press", weight: 135 + i * 5, reps: 5, rir: 2, date });
    repo.logSetByName({ exercise: "Back Squat", weight: 185 + i * 10, reps: 5, rir: 2, date });
    db.prepare(`UPDATE sessions SET performance = 4 WHERE date = ?`).run(date);
  });
  const read = pushOfferRead(t);
  assert.deepEqual(read.facts.lifts_carried.sort(), ["Back Squat", "Bench Press"], JSON.stringify(read.facts));
  assert.equal(read.facts.sessions, 5);
  assert.ok(read.facts.rir_reserve_sets >= 3);
  assert.equal(read.eligible, true, JSON.stringify(read.blockers));
});

const earned = () => ({ ...pushOfferVerdict(facts({ date: today() })), facts: facts({ date: today() }) });

test("offer → accept: an ask-tier ledger row with expectations; one tap opens the SAME two-week stance", () => {
  const filed = offerPushStanceIfEarned(today(), { read: earned });
  assert.equal(filed.filed, true, JSON.stringify(filed));
  const offer = getBrainDecision(filed.decision_id);
  assert.equal(offer.autonomy_tier, "ask");
  assert.equal(offer.status, "observed", "a question waiting, never a parked change the thaw could land");
  assert.equal(offer.context.push_offer, true);
  assert.equal(pushStanceActive(today()), false, "the offer itself changes nothing");
  assert.equal(offerPushStanceIfEarned(today(), { read: earned }).reason, "open_offer", "one open offer at a time");

  const read = trainingDriveRead(today());
  assert.ok(read.offer, "the offer waits on the read (and so the Brief and the conductor)");
  assert.match(read.offer.line, /two weeks\?$/);
  assert.equal(read.offer.decision_id, filed.decision_id);
  assert.match(
    renderTrainingDriveLine({ training_drive: trainingDriveForCoach(today()) }),
    /OPEN QUESTION FROM THE COACH/
  );

  const accepted = acceptPushOffer({ decision_id: filed.decision_id });
  assert.equal(accepted.ok, true, accepted.error);
  const state = trainingDriveState(today());
  assert.equal(state.stance.until, addDaysISO(today(), OFFER_STANCE_DAYS - 1));
  assert.equal(getBrainDecision(filed.decision_id).status, "superseded");
  assert.equal(getBrainDecision(filed.decision_id).superseded_by, accepted.decision_id);
  assert.equal(getBrainDecision(accepted.decision_id).context.accepted_offer_id, filed.decision_id);
  assert.equal(openPushOfferDecision(today()), null);
  assert.equal(trainingDriveRead(today()).offer, null);
  // The accepted push is his, with the same Undo as saying it.
  assert.equal(revertDecision(accepted.decision_id).ok, true);
  assert.equal(pushStanceActive(today()), false);
});

test("offer → dismiss: remembered, never re-asked inside the cooldown, and its claim stays checkable", () => {
  const filed = offerPushStanceIfEarned(today(), { read: earned });
  const res = dismissPushOffer({ decision_id: filed.decision_id });
  assert.equal(res.ok, true, res.error);
  const row = getBrainDecision(filed.decision_id);
  assert.equal(row.status, "rejected");
  assert.equal(row.context.dismissed_on, today());
  assert.equal(trainingDriveRead(today()).offer, null);
  assert.equal(pushStanceActive(today()), false, "'not now' changes nothing");
  // The live evaluator now reads the dismissal and holds the question shut.
  const again = pushOfferRead(today());
  assert.equal(again.facts.dismissed_on, today());
  assert.ok(again.blockers.includes("dismissed"));
  // Expectations, when the log could carry any, are not canceled by the dismissal.
  for (const e of listBrainExpectations({ decisionId: filed.decision_id })) assert.notEqual(e.status, "canceled");
  assert.equal(dismissPushOffer({}).ok, false, "nothing left to answer");
  assert.equal(acceptPushOffer({}).ok, false);
});

test("a push said in chat while an offer is open answers the offer too", () => {
  const filed = offerPushStanceIfEarned(today(), { read: earned });
  setTrainingDrive({ drive: "push", scope: "date", words: "I'm ready for more" });
  assert.equal(getBrainDecision(filed.decision_id).status, "superseded");
});
