// Which logged sessions count as a comparable strength exposure
// (src/repo/lift-comparability.ts). The answer is derived from the sets logged
// against a reduced recovery prescription, so it MOVES as the athlete keeps
// logging: a session that read compliant at set four reads overdose at set
// seven, and the trajectory read must see the newer answer. The eligibility memo
// therefore keys on the training-data version every production write bumps —
// without that, the first read of the day pinned the classification for the life
// of the process.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2026-04-15";

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises",
    "plan_proposals",
    "app_state",
    "recovery_cycles"
  );
});

function startRecoveryWeek(appliedOn) {
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: repo.getPlan(),
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));
  db.prepare(`UPDATE app_state SET updated_at = ? WHERE key = 'recovery_week_applied'`).run(`${appliedOn} 00:00:00`);
  return proposal;
}

function logSets(count) {
  for (let i = 0; i < count; i++) {
    repo.logSetByName({ exercise: "Bench Press", weight: 135, reps: 6, rir: 4, date: DATE, day_number: 1 });
  }
}

test("a session's comparable-exposure answer is re-derived once more sets are logged", () => {
  repo.savePlanDay(1, "Push", "Reduced recovery dose", [{ exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8 }]);
  startRecoveryWeek(DATE);

  // Four sets against a four-set recovery prescription: a compliant reduced dose,
  // which is deliberately NOT a comparable strength exposure.
  logSets(4);
  const session = repo.getOrCreateSession(DATE, repo.getPlanDay(1).id);
  assert.equal(repo.recoverySessionDose(session.id).classification, "compliant");
  assert.equal(repo.comparableLiftDates("Bench Press", DATE).has(DATE), false);

  // Three more sets take the same session past the dose. The classification the
  // memo answered with is now wrong, and the training-data version has moved.
  logSets(3);
  assert.equal(repo.recoverySessionDose(session.id).classification, "overdose");
  assert.equal(repo.comparableLiftDates("Bench Press", DATE).has(DATE), true);
});

test("a rest-day train-anyway session with no recovery week still counts as exposure", () => {
  repo.savePlanDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 4, rep_low: 5, rep_high: 8 }]);
  logSets(4);
  const session = repo.getOrCreateSession(DATE, repo.getPlanDay(1).id);
  assert.equal(repo.activeRecoveryWeek(DATE), null);
  assert.equal(repo.recoveryCycleAt(DATE), null);
  assert.equal(repo.comparableLiftDates("Bench Press", DATE).has(DATE), true);
  assert.equal(repo.recoverySessionDose(session.id).classification, "unknown");
});
