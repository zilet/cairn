// The return of a change made around pain (autonomy-service.ts returnPainAdaptations).
// A race adaptation that rested a lift for a sore knee is the knee's, not the date's:
//   - while that pain is open, nothing changes and nothing is asked;
//   - once it has settled, the return lands through the ordinary autonomy path with its
//     Undo — exactly what "Bring it back" applied, never past it — at today's lead mode;
//   - the Undo (or a Hold, or a discard) is "keep it", remembered: never offered again;
//   - a read that fails changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTATION_RETURN_AGENT,
  applyDueAnnouncedDecisions,
  expirePlanAdaptations,
  revertDecision,
  settleAdaptationReturns,
} from "../dist/domain/brain/autonomy-service.js";
import { briefAsks } from "../dist/domain/today/brief-asks.js";
import { awaitingBrainDecisions } from "../dist/repo/brain-decisions.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { db, localDaysAgo, repo, savePlanDaySettled } from "./_seed.js";

const UNTIL = localDaysAgo(-3);
const DAY_AFTER = localDaysAgo(-4);
const TODAY = localDaysAgo(0);
const MORNING = new Date(`${DAY_AFTER}T09:00:00`);

const LOWER = [
  { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 155 },
  { exercise: "Lying Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 70 },
];

/** A knee reported two days ago, and the squat rested around it until UNTIL. */
function seedKneeAdaptation(mode = "lead") {
  repo.setSettings({ lead_mode: mode });
  savePlanDaySettled(1, "Push A", "Chest and shoulders", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  savePlanDaySettled(2, "Lower", "The week's one leg day", LOWER);
  const knee = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: localDaysAgo(2) });
  const proposal = repo.createProposal("stub", "background: chat signal", "", {
    summary: "Rest the squat for the race",
    rationale: "Knee pain on deep squats.",
    changes: [
      {
        day_number: 2,
        exercise: "Back Squat",
        remove: true,
        until: UNTIL,
        reason: "Knee pain on deep squats; resting it for the race",
      },
    ],
  });
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const rowId = db.prepare(`SELECT id FROM plan_adaptations`).get().id;
  return { knee, rowId };
}

const row = (id) =>
  db.prepare(`SELECT status, resolution_note, restore_decision_id FROM plan_adaptations WHERE id = ?`).get(id);
const squatOnDay = () => (repo.getPlanDay(2)?.items ?? []).find((item) => item.exercise === "Back Squat") ?? null;
const returnDrafts = () => repo.listProposals(50).filter((p) => p.agent === ADAPTATION_RETURN_AGENT);
const liveHolds = () => repo.listBrainDecisions({ status: "review", limit: 50 });

test("while the pain is open the return waits: nothing changes, nothing is asked, every morning", () => {
  const { rowId } = seedKneeAdaptation();
  for (const day of [DAY_AFTER, localDaysAgo(-5), localDaysAgo(-12)]) {
    const outcome = expirePlanAdaptations(day);
    assert.deepEqual(outcome.returned?.waiting, [rowId], day);
    assert.equal(outcome.ask ?? null, null);
    assert.equal(row(rowId).status, "active", "still in force");
    assert.equal(squatOnDay(), null, "the squat stays rested");
    assert.equal(returnDrafts().length, 0, "nothing drafted");
    assert.equal(liveHolds().length, 0, "nothing waits on the athlete");
    assert.equal(briefAsks({ date: day, now: MORNING }).asks.length, 0);
  }
});

test("an open pain elsewhere that loads the lift holds the return too", () => {
  const { knee, rowId } = seedKneeAdaptation();
  repo.resolveTrainingSymptom(knee.id, TODAY);
  repo.reportTrainingSymptom({ area_text: "lower back", onset_on: TODAY });
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.deepEqual(outcome.returned?.waiting, [rowId]);
  assert.equal(squatOnDay(), null);
});

test("once the pain settles the return lands through autonomy with Undo (lead), at the old prescription", () => {
  const { knee, rowId } = seedKneeAdaptation("lead");
  repo.resolveTrainingSymptom(knee.id, TODAY);
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.deepEqual(outcome.returned?.routed, [rowId], JSON.stringify(outcome.returned));
  assert.equal(outcome.returned.tier, "quiet_apply");
  const squat = squatOnDay();
  assert.ok(squat, "the squat is back on the day");
  assert.deepEqual([squat.sets, squat.rep_low, squat.rep_high], [3, 5, 8], "the pre-adaptation prescription");
  assert.ok(!(Number(squat.target_weight) > 155), "never past what 'Bring it back' would have applied");
  const settled = row(rowId);
  assert.equal(settled.status, "restored");
  const decision = repo.getBrainDecision(settled.restore_decision_id);
  assert.equal(decision.status, "applied");
  assert.equal(decision.reversible, true, "server-owned Undo");
  assert.ok(repo.getBrainRollback(decision.id), "a rollback snapshot rides it");
  assert.ok(repo.listBrainExpectations({ decisionId: decision.id }).length >= 1, "a falsifiable expectation");
  assert.equal(liveHolds().length, 0, "nothing asked");
  assert.equal(briefAsks({ date: DAY_AFTER, now: MORNING }).asks.length, 0);
  const [draft] = returnDrafts();
  for (const text of [draft.parsed.summary, draft.parsed.rationale]) {
    assert.ok(!violatesReadingGrammar(text), text);
    assert.doesNotMatch(text, /\byou must\b|\bshould\b|remov|dropp/i);
  }
  assert.match(draft.parsed.rationale, /knee/i, "says which pain settled");

  // Undo is "keep it", remembered: the squat rests again and it is never offered again.
  const undone = revertDecision(decision.id, "user undo");
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(squatOnDay(), null);
  assert.equal(row(rowId).status, "kept");
  const later = expirePlanAdaptations(localDaysAgo(-6));
  assert.equal(later.returned ?? null, null);
  assert.equal(returnDrafts().length, 1, "no second return drafted");
});

test("announce_first announces the return; a Hold is 'keep it' and is never re-offered", () => {
  const { knee, rowId } = seedKneeAdaptation("announce_first");
  repo.resolveTrainingSymptom(knee.id, TODAY);
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.returned.tier, "announce");
  assert.equal(row(rowId).status, "returning", "one change in flight for the subject");
  const decision = repo.getBrainDecision(row(rowId).restore_decision_id);
  assert.equal(decision.status, "announced");
  // A second pass before it lands drafts nothing new.
  expirePlanAdaptations(localDaysAgo(-5));
  assert.equal(returnDrafts().length, 1, "never stacked");
  const held = revertDecision(decision.id, "user hold");
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.equal(row(rowId).status, "kept");
  expirePlanAdaptations(localDaysAgo(-6));
  assert.equal(returnDrafts().length, 1);
  assert.equal(squatOnDay(), null);
});

test("review_everything holds the return once, in the review queue only; a discard is 'keep it'", () => {
  const { knee, rowId } = seedKneeAdaptation("review_everything");
  repo.resolveTrainingSymptom(knee.id, TODAY);
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.returned.tier, "ask");
  const holds = liveHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].context.review_reason_code, "review_posture", "their own posture, never adaptation_return_ask");
  assert.equal(briefAsks({ date: DAY_AFTER, now: MORNING }).asks.length, 0, "never a second ask on the Brief");
  assert.equal(awaitingBrainDecisions().filter((d) => /Back Squat/.test(String(d.summary ?? ""))).length <= 1, true);
  assert.equal(row(rowId).status, "returning");
  repo.setProposalStatus(outcome.returned.proposal_id, "discarded");
  settleAdaptationReturns();
  assert.equal(row(rowId).status, "kept");
  expirePlanAdaptations(localDaysAgo(-6));
  assert.equal(returnDrafts().length, 1);
});

test("pain that reopens between the announcement and its boundary: the lift stays rested, the rows back in force", () => {
  const { knee, rowId } = seedKneeAdaptation("announce_first");
  repo.resolveTrainingSymptom(knee.id, TODAY);
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.returned.tier, "announce");
  const decision = repo.getBrainDecision(row(rowId).restore_decision_id);
  // The knee flares again before the return lands.
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: TODAY });
  const due = applyDueAnnouncedDecisions(decision.effective_date);
  assert.equal(due.applied.length, 0, "never lands over an open pain");
  assert.equal(squatOnDay(), null);
  assert.equal(repo.getProposal(outcome.returned.proposal_id).status, "superseded");
  assert.equal(row(rowId).status, "active", "back in force: read again tomorrow");
  assert.equal(liveHolds().length, 0, "nothing asked");
  const next = expirePlanAdaptations(localDaysAgo(-6));
  assert.deepEqual(next.returned?.waiting, [rowId]);
});

test("a same-place pain that had already settled before the change was written is another episode", () => {
  repo.setSettings({ lead_mode: "lead" });
  savePlanDaySettled(2, "Lower", "The week's one leg day", LOWER);
  const earlier = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: localDaysAgo(12) });
  repo.resolveTrainingSymptom(earlier.id, localDaysAgo(6));
  const proposal = repo.createProposal("stub", "background: chat signal", "", {
    summary: "Rest the squat for the race",
    rationale: "Knee pain on deep squats.",
    changes: [
      { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Knee pain on deep squats; resting it for the race" },
    ],
  });
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const rowId = db.prepare(`SELECT id FROM plan_adaptations`).get().id;
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.returned.routed.length, 0, "an earlier episode never vouches for this one");
  assert.deepEqual(outcome.returned.kept, [rowId]);
  assert.equal(squatOnDay(), null);
});

test("no settled report to tie the pain to: kept as adapted, said once, nothing asked", () => {
  repo.setSettings({ lead_mode: "lead" });
  savePlanDaySettled(2, "Lower", "The week's one leg day", LOWER);
  const proposal = repo.createProposal("stub", "background: chat signal", "", {
    summary: "Rest the squat for the race",
    rationale: "Knee pain on deep squats.",
    changes: [
      { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Knee pain on deep squats; resting it for the race" },
    ],
  });
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const rowId = db.prepare(`SELECT id FROM plan_adaptations`).get().id;
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.deepEqual(outcome.returned.kept, [rowId]);
  assert.equal(row(rowId).status, "kept");
  assert.equal(liveHolds().length, 0);
  assert.equal(briefAsks({ date: DAY_AFTER, now: MORNING }).asks.length, 0);
  assert.equal(returnDrafts().length, 0);
  const note = repo.listBrainDecisions({ status: "observed", limit: 20 }).find((d) => d.context?.pain_untied === true);
  assert.ok(note, "said once, as an observed note");
  assert.equal(expirePlanAdaptations(localDaysAgo(-6)).returned ?? null, null, "never again");
});

test("a symptom read that fails changes nothing and asks nothing", () => {
  const { knee, rowId } = seedKneeAdaptation();
  repo.resolveTrainingSymptom(knee.id, TODAY);
  db.exec(`ALTER TABLE training_symptom_events RENAME TO training_symptom_events_away`);
  let outcome;
  try {
    outcome = expirePlanAdaptations(DAY_AFTER);
  } finally {
    db.exec(`ALTER TABLE training_symptom_events_away RENAME TO training_symptom_events`);
  }
  assert.deepEqual(outcome.returned?.unavailable, [rowId]);
  assert.equal(row(rowId).status, "active");
  assert.equal(returnDrafts().length, 0);
  assert.equal(liveHolds().length, 0);
  assert.equal(squatOnDay(), null);
  // Readable again the next morning: it returns.
  const next = expirePlanAdaptations(localDaysAgo(-5));
  assert.deepEqual(next.returned?.routed, [rowId]);
});
