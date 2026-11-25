// An EARNED recovery week is set up by the coach, and said (recovery-week-change.ts).
// Invariants:
//   1. lead: an earned week (mesocycle deload-due) announces for next Monday and LANDS
//      there despite sessions logged in between — its premise is its own read, never the
//      evidence fingerprint — with no agent spawned, the server-owned Undo, and
//      expectations whose windows open at the week's exit;
//   2. announce_first announces; review_everything holds exactly one draft;
//   3. each hold prevents a new week, and withdraws an open one quietly (no refusal);
//   4. a read that fails is `unknown`: the pass changes nothing, and the boundary waits a
//      day — and a Monday that passes withdraws it, never a mid-week landing;
//   5. a Hold before Monday and an Undo after it lands are the athlete's "no" for the
//      block, reopened only by something safety-grade;
//   6. never two recovery weeks: the fuel package's week, or any open one, holds;
//   7. the block's scheduled deload week is made lighter for a steady athlete (and the
//      block keeps its calendar through it); a push athlete with no loaded-weeks evidence
//      gets nothing;
//   8. the overlay dose: sets halved, load ×0.9, assisted and timed proportionate;
//   9. every sentence holds the reading grammar.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo, repo } from "./_seed.js";
import { previewEarnedRecoveryWeek, settleEarnedRecoveryWeek } from "../dist/domain/brain/recovery-week-change.js";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import { evolveProgram } from "../dist/coachOps/training.js";
import { getBrainDecision, listBrainExpectations } from "../dist/repo/brain-decisions.js";
import { createProposal, getProposal } from "../dist/repo/proposals.js";
import {
  RECOVERY_WEEK_AGENT,
  RECOVERY_WEEK_INSTRUCTION,
  RECOVERY_WEEK_INSTRUCTION_PREFIX,
  recoveryWeekPlanDays,
  recoveryWeekStatus,
} from "../dist/repo/recovery-week.js";
import {
  fuelRecoveryWeekStillStands,
  isFuelRecoveryWeek,
  recoveryWeekHold,
  recoveryWeekPhrasings,
  recoveryWeekStillEarned,
  UNDERFUEL_TRAINING_READ_KEY,
} from "../dist/repo/recovery-week-earned.js";
import { recoveryWeekMayBeAnnounced } from "../dist/repo/recovery-refusal.js";
import { UNDERFUEL_BRAIN_AGENT } from "../dist/repo/protective-fuel-draft.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { createBlock } from "../dist/repo/program-blocks.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { nextNaturalBoundary } from "../dist/brain/autonomy.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const today = () => localDateISO();
const landing = () => nextNaturalBoundary("training_structure", today());

function logSet(name, date, weight, reps, setNum) {
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(date, null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(session.id, ex.id, setNum, weight, reps, 2);
}

// `weeks` weeks of the same bench work, one session a week, the newest five days ago.
function seedLoadedWeeks(weeks) {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 185 },
  ]);
  db.prepare(`UPDATE plan_items SET prescribed_at = ?`).run(isoDaysAgo(120));
  for (let w = weeks; w >= 1; w--) for (let s = 1; s <= 3; s++) logSet("Bench Press", isoDaysAgo(w * 7 - 2), 185, 8, s);
  bumpTrainingDataVersion();
}

// The earned fixture: eight loaded weeks in a row, no block, steady drive.
function earned(leadMode = "lead") {
  repo.setSettings({ lead_mode: leadMode, training_drive: "steady", coach_day: 0 });
  seedLoadedWeeks(8);
  const meso = getProgramState(today()).mesocycle;
  assert.equal(meso.phase, "deload-due", meso.note);
  return meso;
}

function recoveryDrafts() {
  return db
    .prepare(`SELECT id, agent, status FROM plan_proposals WHERE status = 'draft' AND instruction LIKE ?`)
    .all(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`);
}

function agentRuns() {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get().n);
}

function assertHouseVoice(...texts) {
  for (const text of texts) {
    assert.equal(violatesReadingGrammar(text), null, `reading grammar: ${text}`);
    assert.doesNotMatch(String(text), /\d/, `numbers are spelled: ${text}`);
    assert.doesNotMatch(String(text), /\b(must|should)\b/i, `no gate language: ${text}`);
    // proposal-truth.ts re-dates these words in a stored draft's prose.
    assert.doesNotMatch(
      String(text),
      /\b(today|yesterday|this week|last week|recent|previous|prior|last session|last workout)\b/i,
      `no relative-time words: ${text}`
    );
  }
}

test("lead: an earned week announces for Monday, lands there despite sessions logged in between, and no agent is spawned", () => {
  earned("lead");
  const runsBefore = agentRuns();
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed", JSON.stringify(out));
  assert.equal(out.tier, "announce");
  assert.equal(out.effective_date, landing());
  assert.equal(out.lands_on, landing());
  assert.equal(out.arm, "streak");
  assert.ok(out.loaded_weeks >= 6, `loaded weeks counted: ${out.loaded_weeks}`);
  assertHouseVoice(out.summary, out.explanation);
  assert.match(out.explanation, /Undo/);
  const proposal = getProposal(out.proposal_id);
  assert.equal(proposal.agent, RECOVERY_WEEK_AGENT);
  assert.ok(proposal.instruction.startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX));
  assert.equal(proposal.raw_output, "", "no agent wrote it");
  assert.equal(agentRuns(), runsBefore, "no agent was spawned");
  assert.equal(recoveryWeekStatus(today()).state, "upcoming", "the Plan banner reads it as coming");

  // A second pass the same week changes nothing: one change at a time.
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).status, "standing");
  assert.equal(recoveryDrafts().length, 1);

  // The athlete trains before Monday — the move that used to park it as a stale ask.
  repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 8, date: today() });
  const pass = applyDueAnnouncedDecisions(landing());
  assert.deepEqual(pass.applied, [out.decision_id], JSON.stringify(pass));
  assert.equal(getProposal(out.proposal_id).status, "applied");
  const decision = getBrainDecision(out.decision_id);
  assert.equal(decision.status, "applied");
  assert.equal(decision.reversible, true, "the server-owned Undo");
  const cycle = repo.recoveryCycleAt(landing());
  assert.ok(cycle, "the recovery overlay is scheduled from Monday");
  assert.equal(cycle.effective_on, landing());
  assert.equal(cycle.overlay.arm, "streak");
  assert.equal(Number(cycle.overlay.source_proposal_id), out.proposal_id);

  // Its predictions are about what comes AFTER the lighter week.
  const exit = cycle.exit_on;
  const expectations = listBrainExpectations({ decisionId: out.decision_id });
  assert.ok(expectations.length > 0, "the week is accountable");
  for (const expectation of expectations) assert.equal(expectation.window_start, exit, expectation.metric_key);
  assert.ok(
    expectations.some((e) => e.metric_key === "exercise_est_1rm_trend" && e.subject_key === "Bench Press"),
    "the anchor lift comes back at least as strong"
  );
});

test("a session inside the landed week grades as a compliant recovery dose (not a comparable strength exposure)", () => {
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [out.decision_id]);
  // The snapshot the server wrote is the plan day at the overlay's dose: four sets → two.
  assert.equal(getProposal(out.proposal_id).parsed.days[0].items[0].sets, 2);
  for (let i = 0; i < 2; i++)
    repo.logSetByName({ exercise: "Bench Press", weight: 165, reps: 8, rir: 4, date: landing(), day_number: 1 });
  const session = repo.getOrCreateSession(landing(), repo.getPlanDay(1).id);
  assert.equal(Number(session.plan_day_id), Number(repo.getPlanDay(1).id));
  const dose = repo.recoverySessionDose(session.id);
  assert.equal(dose.planned_working_sets, 2, JSON.stringify(dose));
  assert.equal(dose.classification, "compliant", dose.reason);
  assert.equal(repo.comparableLiftDates("Bench Press", landing()).has(landing()), false);
});

test("PROOF of the old defect, now closed: a recovery week no longer parks as a stale ask at its Monday", () => {
  // Before this module, an announced recovery week carried only the generic evidence
  // fingerprint, so one logged set before Monday parked it as `stale_snapshot` (review)
  // at the boundary, and the auto-draft never fired again because a draft existed.
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed");
  repo.logSetByName({ exercise: "Bench Press", weight: 190, reps: 6, date: today() });
  const pass = applyDueAnnouncedDecisions(landing());
  assert.deepEqual(pass.failed, [], JSON.stringify(pass.failed_outcomes));
  assert.notEqual(getBrainDecision(out.decision_id).context?.review_reason_code, "stale_snapshot");
});

test("announce_first announces; review_everything holds exactly one draft", () => {
  earned("announce_first");
  const first = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(first.status, "changed");
  assert.equal(first.tier, "announce");
  assert.equal(first.effective_date, landing());

  db.exec(`DELETE FROM plan_proposals; DELETE FROM brain_decisions;`);
  repo.setSettings({ lead_mode: "review_everything" });
  const held = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(held.status, "asked", JSON.stringify(held));
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).status, "standing");
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).status, "standing");
  assert.equal(recoveryDrafts().length, 1, "exactly one held draft");
  const reviews = db
    .prepare(`SELECT COUNT(*) AS n FROM brain_decisions WHERE status = 'review' AND source_ref_key = ?`)
    .get(String(held.proposal_id));
  assert.equal(Number(reviews.n), 1);
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [], "nothing lands without the yes");
});

test("nothing earned: no week, nothing written", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  seedLoadedWeeks(2);
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "none");
  assert.equal(recoveryDrafts().length, 0);
});

test("a dry run says what the pass would do, and writes nothing", () => {
  earned("lead");
  const preview = previewEarnedRecoveryWeek({ date: today() });
  assert.equal(preview.status, "would_change");
  assert.equal(preview.arm, "streak");
  assert.equal(preview.days[0].items[0].sets, 2);
  assert.equal(preview.days[0].items[0].target_weight, 165);
  assertHouseVoice(preview.summary, preview.explanation);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
});

test("holds: a race window, a trip of three days or more, an open cycle and the cooldown prevent a new week", () => {
  earned("lead");
  // A race in the landing week.
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Winter 10K", date: addDaysISO(landing(), 2), distance_km: 10 },
  });
  let out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "race");
  repo.setProfile({ endurance_goal: null });

  // A two-day trip is not a light week; a four-day one is.
  repo.addContextEvent({ kind: "trip", title: "Porto", start_date: landing(), end_date: addDaysISO(landing(), 1) });
  assert.equal(previewEarnedRecoveryWeek({ date: today() }).status, "would_change");
  repo.addContextEvent({
    kind: "trip",
    title: "Lisbon",
    start_date: addDaysISO(landing(), 2),
    end_date: addDaysISO(landing(), 5),
  });
  out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "trip");
  db.exec(`DELETE FROM context_events`);

  // A recovery week already running: nothing is earned while it runs.
  const running = repo.scheduleRecoveryCycle({ effective_on: today(), exit_on: addDaysISO(landing(), 2) });
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).status, "none");
  repo.cancelRecoveryCycle(running.id, today());
  // One scheduled to start before Monday and run into the landing week holds it.
  const coming = repo.scheduleRecoveryCycle({
    effective_on: addDaysISO(today(), 1),
    exit_on: addDaysISO(landing(), 3),
  });
  out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "open");
  repo.cancelRecoveryCycle(coming.id, today());

  // The 21-day cooldown after a finished one. The finished week also resets the loaded
  // weeks, so nothing is earned at all; the cooldown is the second line behind that.
  const done = repo.scheduleRecoveryCycle({ effective_on: isoDaysAgo(12), exit_on: isoDaysAgo(5) });
  repo.completeRecoveryCycle(done.id, isoDaysAgo(5));
  assert.equal(recoveryWeekHold(today(), landing()).reason, "cooldown");
  out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "none");
  assert.equal(recoveryDrafts().length, 0, "nothing was drafted under any hold");
});

test("a hold that arrives withdraws the open week quietly — at the daily pass and at the boundary — and is no refusal", () => {
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed");
  repo.addContextEvent({
    kind: "trip",
    title: "Lisbon",
    start_date: landing(),
    end_date: addDaysISO(landing(), 4),
  });
  const next = settleEarnedRecoveryWeek({ date: today() });
  assert.deepEqual(next.withdrawn, [out.proposal_id]);
  assert.equal(next.status, "held");
  assert.equal(getProposal(out.proposal_id).status, "superseded");
  const decision = getBrainDecision(out.decision_id);
  assert.equal(decision.status, "canceled");
  assert.notEqual(decision.context?.held_by_user, true, "a server withdrawal is not the athlete's no");
  assert.equal(recoveryWeekMayBeAnnounced(today()).allowed, true);

  // At the boundary: the same hold cancels it there.
  db.exec(`DELETE FROM context_events; DELETE FROM plan_proposals; DELETE FROM brain_decisions;`);
  const again = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(again.status, "changed");
  repo.addContextEvent({ kind: "trip", title: "Lisbon", start_date: landing(), end_date: addDaysISO(landing(), 4) });
  const pass = applyDueAnnouncedDecisions(landing());
  assert.deepEqual(pass.applied, []);
  assert.deepEqual(pass.failed_outcomes.map((o) => o.class), ["canceled_moot"]);
  assert.equal(repo.recoveryCycleAt(landing()), null, "nothing lands");
});

test("the evidence going (a light week breaks the streak) withdraws the open week quietly", () => {
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed");
  // The last two weeks are untrained after all.
  db.prepare(
    `DELETE FROM logged_sets WHERE session_id IN (SELECT id FROM sessions WHERE date >= ?)`
  ).run(isoDaysAgo(13));
  bumpTrainingDataVersion();
  assert.equal(recoveryWeekStillEarned(getProposal(out.proposal_id).parsed, today(), out.proposal_id), "gone");
  const next = settleEarnedRecoveryWeek({ date: today() });
  assert.deepEqual(next.withdrawn, [out.proposal_id]);
  assert.equal(getBrainDecision(out.decision_id).status, "canceled");
});

test("unknown: a read that fails changes nothing; the boundary waits a day, and a Monday that passed withdraws it", () => {
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed");
  // Make the trip read fail (the table is briefly unreadable).
  db.exec(`ALTER TABLE context_events RENAME TO context_events_hidden`);
  try {
    const pass = settleEarnedRecoveryWeek({ date: today() });
    assert.equal(pass.status, "unavailable");
    assert.deepEqual(pass.withdrawn, [], "nothing withdrawn on a failed read");
    assert.equal(getProposal(out.proposal_id).status, "draft");
    const boundary = applyDueAnnouncedDecisions(landing());
    assert.deepEqual(boundary.applied, []);
    assert.deepEqual(boundary.delayed, [out.decision_id], JSON.stringify(boundary));
    assert.equal(getBrainDecision(out.decision_id).effective_date, addDaysISO(landing(), 1));
  } finally {
    db.exec(`ALTER TABLE context_events_hidden RENAME TO context_events`);
  }
  // The read is back, but its Monday has passed: never a mid-week landing.
  const late = applyDueAnnouncedDecisions(addDaysISO(landing(), 1));
  assert.deepEqual(late.applied, []);
  assert.equal(getBrainDecision(out.decision_id).status, "canceled");
  assert.equal(repo.recoveryCycleAt(addDaysISO(landing(), 1)), null);
});

test("a Hold before Monday is the athlete's no for the block; something safety-grade reopens it", () => {
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(revertDecision(out.decision_id).ok, true, "Hold this");
  assert.equal(getProposal(out.proposal_id).status, "superseded");
  const after = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(after.status, "declined");
  assert.equal(after.hold, "refused");
  assert.equal(recoveryDrafts().length, 0, "not re-minted");
  // A symptom reported after the Hold is news the refusal did not answer.
  db.prepare(`UPDATE brain_decisions SET context_json = json_set(context_json, '$.held_by_user_on', ?) WHERE id = ?`).run(
    isoDaysAgo(3),
    out.decision_id
  );
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, onset_on, last_reported_on) VALUES ('chat', 'left knee', 'active', ?, ?)`
  ).run(isoDaysAgo(1), isoDaysAgo(1));
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).status, "changed");
});

test("an Undo after the week lands is the athlete's no for the block too", () => {
  earned("lead");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [out.decision_id]);
  const undone = revertDecision(out.decision_id);
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(getBrainDecision(out.decision_id).status, "reverted");
  assert.equal(repo.recoveryCycleCooldown(landing()).allowed, true, "a canceled cycle starts no cooldown");
  assert.equal(recoveryWeekMayBeAnnounced(today()).allowed, false, "the Undo is remembered");
  const after = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(after.status, "declined");
  assert.equal(recoveryDrafts().length, 0, "not re-minted for the block");
});

test("never two: an open fuel-package week holds the earned one, and an earned week is what the fuel package would link", () => {
  earned("lead");
  fuelWeek();
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "held");
  assert.equal(out.hold, "fuel");
  assert.equal(recoveryDrafts().length, 1);

  db.exec(`DELETE FROM plan_proposals; DELETE FROM brain_decisions;`);
  const earnedWeek = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(earnedWeek.status, "changed");
  // The fuel package reads this state and links the week already coming instead of
  // drafting another (underfueling-service.ts recoveryDecisionForStatus).
  const status = recoveryWeekStatus(today());
  assert.equal(status.state, "upcoming");
  assert.equal(status.decision_id, earnedWeek.decision_id);
});

test("the one-tap 'plan me a lighter week' is deterministic, marked as asked, and lands despite logged sessions", async () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  seedLoadedWeeks(2);
  const runsBefore = agentRuns();
  const r = await evolveProgram("auto", RECOVERY_WEEK_INSTRUCTION);
  assert.equal(r.ok, true);
  assert.equal(agentRuns(), runsBefore, "no agent was spawned");
  assert.equal(r.proposal.agent, RECOVERY_WEEK_AGENT);
  assert.equal(r.proposal.parsed.recovery_week.arm, "asked");
  assert.equal(r.autonomy.announced, true, JSON.stringify(r.autonomy));
  repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 8, date: today() });
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [r.autonomy.decision.id]);
  // The daily pass never settles the person's own week.
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).withdrawn.length, 0);
});

test("scheduled arm: a steady athlete's block deload week is made lighter, and the block keeps its calendar", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady", coach_day: 0 });
  seedLoadedWeeks(2);
  createBlock({ goal: "Strength", focus: "strength", total_weeks: 6, week_index: 5, started_at: isoDaysAgo(30) });
  assert.notEqual(getProgramState(today()).mesocycle.phase, "deload-due");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed", JSON.stringify(out));
  assert.equal(out.arm, "scheduled");
  assertHouseVoice(out.summary, out.explanation);
  // The block moves into its deload week on its Sunday slot; the week lands on Monday.
  repo.advanceBlockWeek();
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [out.decision_id]);
  assert.equal(repo.recoveryCycleAt(landing()).overlay.arm, "scheduled");
});

test("scheduled arm: a block that never moves into its deload week withdraws the week at Monday", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady", coach_day: 0 });
  seedLoadedWeeks(2);
  createBlock({ goal: "Strength", focus: "strength", total_weeks: 6, week_index: 5, started_at: isoDaysAgo(30) });
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed");
  // No Sunday advance happened: Monday is still week five, not the deload.
  const pass = applyDueAnnouncedDecisions(landing());
  assert.deepEqual(pass.applied, []);
  assert.equal(getBrainDecision(out.decision_id).status, "canceled");
});

test("scheduled arm: a push athlete with no loaded-weeks evidence gets nothing lighter", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "push", coach_day: 0 });
  seedLoadedWeeks(2);
  createBlock({ goal: "Strength", focus: "strength", total_weeks: 6, week_index: 5, started_at: isoDaysAgo(30) });
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "none");
  assert.equal(recoveryDrafts().length, 0);
});

test("the block keeps its calendar through its own (scheduled) deload overlay, and pauses for an inserted one", () => {
  const block = createBlock({ goal: "Build", week_index: 5, total_weeks: 6 });
  const scheduled = repo.scheduleRecoveryCycle({
    effective_on: today(),
    exit_on: addDaysISO(today(), 7),
    overlay: { arm: "scheduled" },
  });
  repo.activateRecoveryCycle(scheduled.id, today());
  assert.equal(repo.advanceBlockWeek(block.id).week_index, 6, "the block's own deload week advances");
  repo.cancelRecoveryCycle(scheduled.id, today());

  const other = createBlock({ goal: "Build 2", week_index: 2, total_weeks: 6 });
  const inserted = repo.scheduleRecoveryCycle({
    effective_on: today(),
    exit_on: addDaysISO(today(), 7),
    overlay: { arm: "streak" },
  });
  repo.activateRecoveryCycle(inserted.id, today());
  assert.equal(repo.advanceBlockWeek(other.id).week_index, 2, "an earned week inserted into the block pauses it");
});

test("the recovery dose: sets halved, load eased by a tenth, assisted and timed proportionate", () => {
  const adapted = repo.adaptBasePlanDayForRecovery({
    id: 1,
    day_number: 1,
    items: [
      { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 5, target_weight: 225 },
      { exercise: "Barbell Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 185 },
      { exercise: "Assisted Pull-up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 },
      { exercise: "Plank", mode: "timed", sets: 2, target_seconds: 60 },
    ],
  });
  assert.deepEqual(
    adapted.items.map((item) => [item.sets, item.target_weight ?? null, item.target_seconds ?? null]),
    [
      [2, 200, null],
      [2, 165, null],
      [2, -35, null],
      [1, null, 54],
    ]
  );
  assert.ok(adapted.items.every((item) => item.rep_low == null || item.rep_low >= 5), "reps are untouched");
  // The shared builder is the overlay: the snapshot a draft carries is what the week prescribes.
  const snapshot = recoveryWeekPlanDays([{ day_number: 1, name: "Lower", items: [{ exercise: "Back Squat", sets: 4, target_weight: 225 }] }]);
  assert.deepEqual([snapshot[0].items[0].sets, snapshot[0].items[0].target_weight], [2, 200]);
  assert.equal(snapshot[0].items[0].recovery_overlay, undefined, "overlay bookkeeping stays on the overlay");
});

test("every sentence the recovery week can say holds the reading grammar and spells its numbers", () => {
  const phrasings = recoveryWeekPhrasings();
  assert.ok(phrasings.length >= 12);
  assertHouseVoice(...phrasings);
});

// ---- fix round: the block's deload week, the reset, the fuel week, the preview, the tap ----

function activeBlockRow() {
  return db.prepare(`SELECT * FROM program_blocks WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get();
}

test("an earned week landing ON the block's deload week is that week: stamped scheduled, the block advances, no second lighter week", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady", coach_day: 0 });
  seedLoadedWeeks(8);
  const block = createBlock({ goal: "Strength", focus: "strength", total_weeks: 6, week_index: 5, started_at: isoDaysAgo(30) });
  assert.equal(getProgramState(today()).mesocycle.phase, "deload-due");
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed", JSON.stringify(out));
  assert.equal(out.arm, "scheduled", "the overlay is the block's own deload week");
  assert.equal(getProposal(out.proposal_id).parsed.recovery_week.basis, "streak", "the loaded weeks stay its reason");
  assert.match(out.explanation, /loaded weeks/);
  assertHouseVoice(out.summary, out.explanation);
  // The block's Sunday advance moves it into its deload week; on Monday the overlay lands on it.
  repo.advanceBlockWeek(block.id);
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [out.decision_id]);
  const cycle = repo.recoveryCycleAt(landing());
  assert.equal(cycle.overlay.arm, "scheduled", "the block keeps its calendar through it (no pause)");
  // While it runs, and once it is over, nothing mints a second lighter week.
  assert.notEqual(settleEarnedRecoveryWeek({ date: today() }).status, "changed");
  assert.notEqual(settleEarnedRecoveryWeek({ date: cycle.exit_on }).status, "changed");
  assert.equal(recoveryDrafts().length, 0);
});

test("an earned week landing on a new block's first week is inserted: one lighter week, the block starts after it", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady", coach_day: 0 });
  seedLoadedWeeks(8); // the last block completed; none is running
  const out = settleEarnedRecoveryWeek({ date: today() });
  assert.equal(out.status, "changed");
  assert.equal(out.arm, "streak");
  // The Sunday slot opens a fresh block before Monday.
  createBlock({ goal: "Strength 2", focus: "strength", total_weeks: 6, week_index: 1 });
  assert.deepEqual(applyDueAnnouncedDecisions(landing()).applied, [out.decision_id], "its premise still stands");
  const cycle = repo.recoveryCycleAt(landing());
  assert.equal(cycle.overlay.arm, "streak", "an inserted week: the block pauses through it");
  assert.equal(activeBlockRow().week_index, 1, "the new block is not advanced, stuck or doubled");
  assert.notEqual(settleEarnedRecoveryWeek({ date: cycle.exit_on }).status, "changed", "no second lighter week");
  assert.equal(recoveryDrafts().length, 0);
});

test("a finished overlay week resets the loaded-weeks count, however heavy it ran", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  seedLoadedWeeks(14); // full-tonnage sessions every week, the lighter week included
  assert.equal(getProgramState(today()).mesocycle.phase, "deload-due");
  const just = repo.scheduleRecoveryCycle({ effective_on: isoDaysAgo(9), exit_on: isoDaysAgo(2) });
  repo.completeRecoveryCycle(just.id, isoDaysAgo(2));
  let meso = getProgramState(today()).mesocycle;
  assert.notEqual(meso.phase, "deload-due", meso.note);
  assert.equal(meso.deload_evidence, undefined, "the streak restarted after the lighter week");
  assert.equal(settleEarnedRecoveryWeek({ date: today() }).status, "none");

  // Four loaded weeks since: still not earned.
  db.exec(`DELETE FROM recovery_cycles`);
  const month = repo.scheduleRecoveryCycle({ effective_on: isoDaysAgo(37), exit_on: isoDaysAgo(30) });
  repo.completeRecoveryCycle(month.id, isoDaysAgo(30));
  meso = getProgramState(today()).mesocycle;
  assert.notEqual(meso.phase, "deload-due", meso.note);

  // Seven weeks since, every one of them loaded: earned again.
  db.exec(`DELETE FROM recovery_cycles`);
  const long = repo.scheduleRecoveryCycle({ effective_on: isoDaysAgo(57), exit_on: isoDaysAgo(50) });
  repo.completeRecoveryCycle(long.id, isoDaysAgo(50));
  meso = getProgramState(today()).mesocycle;
  assert.equal(meso.phase, "deload-due", meso.note);
});

// What the under-fuelling loop's latest pass read (runUnderfuelingControlLoop remembers it).
function loopRead(date, training) {
  repo.setAppState(UNDERFUEL_TRAINING_READ_KEY, JSON.stringify({ date, training }));
}

function fuelWeek() {
  loopRead(today(), "reduce"); // the pass that mints it reads `reduce`
  const proposal = createProposal(UNDERFUEL_BRAIN_AGENT, `${RECOVERY_WEEK_INSTRUCTION} Coordinated key: k.`, "", {
    summary: "A coordinated recovery week.",
    rationale: "Fuel.",
    days: recoveryWeekPlanDays(repo.getPlan()),
  });
  const routed = applyProposalWithAutonomy(Number(proposal.id), {
    requested_tier: "announce",
    safety_response: true,
    coordinated_update: true,
    coordination_key: "k",
  });
  return { proposal, routed };
}

test("the fuel package's week has its own premise: the read that minted it, its Monday, a cycle, the athlete's no", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  seedLoadedWeeks(2);
  const { proposal, routed } = fuelWeek();
  assert.equal(routed.announced, true, JSON.stringify(routed));
  assert.equal(routed.effective_date, landing());
  const fresh = () => getProposal(proposal.id);
  assert.equal(isFuelRecoveryWeek(fresh()), true);
  // The loop's own remembered read answers first…
  loopRead(landing(), "reduce");
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "proceed"), "fits", "the loop's read wins");
  loopRead(landing(), "hold_aggression");
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "reduce"), "gone");
  // …and when the loop has not read for days, the fuel read itself is asked.
  loopRead(addDaysISO(landing(), -6), "reduce");
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "reduce"), "fits");
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "hold_aggression"), "gone");
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "proceed"), "gone");
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => null), "unknown");
  const throwing = () => {
    throw new Error("read failed");
  };
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), throwing), "unknown");
  // Its Monday passed (the decision is due on a Tuesday): never mid-week.
  assert.equal(fuelRecoveryWeekStillStands(fresh(), addDaysISO(landing(), 1), () => "reduce"), "gone");
  // Another cycle open over its Monday.
  const other = repo.scheduleRecoveryCycle({ effective_on: addDaysISO(landing(), -1), exit_on: addDaysISO(landing(), 5) });
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "reduce"), "gone");
  repo.cancelRecoveryCycle(other.id, today());
  // The athlete's no.
  const refusedOn = isoDaysAgo(1);
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, context_json, created_at)
     VALUES (?, 'training_structure', 'recovery', 'Recovery week', 'canceled', 'announce', 'structural', ?, ?)`
  ).run(refusedOn, JSON.stringify({ held_by_user: true, held_by_user_on: refusedOn }), `${refusedOn} 08:00:00`);
  assert.equal(fuelRecoveryWeekStillStands(fresh(), landing(), () => "reduce"), "held");
});

test("the fuel week lands despite a set logged before Monday while its read stands, and goes quietly when it does not — the calorie step untouched", () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  seedLoadedWeeks(2);
  // The package's calorie step: a separate decision the recovery week's premise never reads.
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, context_json, created_at)
     VALUES (?, 'nutrition_target', 'nutrition', 'Fuel step', 'announced', 'announce', 'low', ?, datetime('now'))`
  ).run(addDaysISO(today(), 1), JSON.stringify({ coordination_key: "k" }));
  const calorie = db.prepare(`SELECT id FROM brain_decisions WHERE kind = 'nutrition_target'`).get();
  const calorieStatus = () => db.prepare(`SELECT status FROM brain_decisions WHERE id = ?`).get(calorie.id).status;

  const { proposal, routed } = fuelWeek();
  repo.logSetByName({ exercise: "Bench Press", weight: 185, reps: 8, date: today() });
  // The loop's pass on Monday still asks for less.
  loopRead(landing(), "reduce");
  const pass = applyDueAnnouncedDecisions(landing());
  assert.ok(pass.applied.includes(routed.decision.id), JSON.stringify(pass));
  assert.equal(Number(repo.recoveryCycleAt(landing()).overlay.source_proposal_id), Number(proposal.id));
  assert.equal(calorieStatus(), "announced");

  // A package whose read no longer asks for less: withdrawn quietly at its Monday.
  db.exec(`DELETE FROM recovery_cycles; DELETE FROM brain_decisions WHERE kind = 'training_structure';`);
  db.exec(`UPDATE plan_proposals SET status = 'superseded' WHERE agent = 'underfuel-brain';`);
  const second = fuelWeek();
  assert.equal(second.routed.announced, true);
  // By Monday the loop's read has moved off `reduce`.
  loopRead(landing(), "hold_aggression");
  const quiet = applyDueAnnouncedDecisions(landing());
  assert.ok(!quiet.applied.includes(second.routed.decision.id));
  const withdrawn = getBrainDecision(second.routed.decision.id);
  assert.equal(withdrawn.status, "canceled");
  assert.notEqual(withdrawn.context?.held_by_user, true, "a quiet withdrawal, not the athlete's no");
  assert.equal(getProposal(second.proposal.id).status, "superseded");
  assert.equal(calorieStatus(), "announced", "the calorie step is left exactly as it was");
});

test("the preview reads a draft the acting pass would withdraw as withdrawn", () => {
  earned("lead");
  // A server draft whose Monday has passed, still announced.
  const stale = createProposal(RECOVERY_WEEK_AGENT, RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "A lighter week.",
    rationale: "Earned.",
    days: recoveryWeekPlanDays(repo.getPlan()),
    recovery_week: { arm: "streak", loaded_weeks: 8, lands_on: isoDaysAgo(2), signature: "old" },
  });
  db.prepare(
    `INSERT INTO brain_decisions (effective_date, kind, domain, summary, status, autonomy_tier, risk_class, source, source_ref_type, source_ref_key, context_json, action_json)
     VALUES (?, 'training_structure', 'recovery', 'A lighter week.', 'announced', 'announce', 'moderate', 'recovery-week', 'plan_proposal', ?, '{}', ?)`
  ).run(landing(), String(stale.id), JSON.stringify({ proposal_id: stale.id }));
  const preview = previewEarnedRecoveryWeek({ date: today() });
  assert.equal(preview.status, "would_change", JSON.stringify(preview));
  assert.deepEqual(preview.withdrawn, [stale.id]);
  assert.equal(getProposal(stale.id).status, "draft", "a dry run writes nothing");
});

test("the one-tap lighter week is refused at the tap, in words, when it could never land", async () => {
  repo.setSettings({ lead_mode: "lead", training_drive: "steady" });
  seedLoadedWeeks(2);
  const running = repo.scheduleRecoveryCycle({ effective_on: today(), exit_on: addDaysISO(landing(), 2) });
  let r = await evolveProgram("auto", RECOVERY_WEEK_INSTRUCTION);
  assert.equal(r.ok, false);
  assert.equal(r.proposal, null);
  assert.match(r.error, /already running or on its way/);
  assert.equal(recoveryDrafts().length, 0);
  repo.cancelRecoveryCycle(running.id, today());
  const done = repo.scheduleRecoveryCycle({ effective_on: isoDaysAgo(12), exit_on: isoDaysAgo(5) });
  repo.completeRecoveryCycle(done.id, isoDaysAgo(5));
  r = await evolveProgram("auto", RECOVERY_WEEK_INSTRUCTION);
  assert.equal(r.ok, false);
  assert.match(r.error, /too soon/);
  assertHouseVoice(r.error);
});
