// statedRevertGaps.test.js — the two Undo gaps on the athlete's own word.
//   • revertStatedRunWeek owns the week's WORDS as well as its structure: a note changed
//     since the statement is a newer word and the Undo refuses; a clean Undo moves today's
//     Brief, so the day read is invalidated like the statement's own write invalidated it.
//   • undoing a push stance that REPLACED an earlier one reopens the earlier stance AND its
//     ledger row (back to applied, superseded_by cleared, its expectations resumed), so the
//     reopened push has its own one-tap Undo again.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { recordStatedRunWeek } from "../dist/domain/training/stated-input.js";
import { setTrainingDrive } from "../dist/domain/training/training-drive.js";
import { revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { getBrainDecision, getBrainRollback, listBrainExpectations } from "../dist/repo/brain-decisions.js";
import { getCachedDayRead } from "../dist/repo/day-read-cache.js";
import { trainingDriveState } from "../dist/repo/training-drive.js";

const today = () => localDateISO();

beforeEach(() => {
  resetTables(
    "training_stances",
    "brain_decisions",
    "brain_expectations",
    "brain_evaluations",
    "brain_rollbacks",
    "app_state",
    "profile",
    "day_reads"
  );
});

function cacheTodaysRead() {
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, signals, source) VALUES (?, 'train', 'Good to train.', 'x', NULL, '{}', 'deterministic')`
  ).run(today());
  assert.ok(getCachedDayRead(today()), "the precondition: a warm read for today");
}

function stateRunWeek(note) {
  const before = repo.getEnduranceSchedule();
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
      quality: { type: "threshold", work_km: 5 },
      ...(note ? { note } : {}),
      source: "athlete",
    },
  });
  return recordStatedRunWeek({ before, words: "Thursday is a hard threshold 5k", via: "mcp" });
}

test("the run-week Undo snapshots the words it wrote", () => {
  const id = stateRunWeek("Saturday optional MTB");
  const rollback = getBrainRollback(id);
  assert.deepEqual(rollback.payload.applied_words, { note: "Saturday optional MTB", quality_note: null });
});

test("a note changed since the statement is a newer word: the Undo refuses and the note stands", () => {
  const id = stateRunWeek("Saturday optional MTB");
  repo.setProfile({
    endurance_schedule: { ...repo.getEnduranceSchedule(), note: "Saturday is now a swim", source: "athlete" },
  });
  assert.equal(repo.getEnduranceSchedule().note, "Saturday is now a swim");
  const refused = revertDecision(id);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /note has changed since/);
  assert.equal(repo.getEnduranceSchedule().note, "Saturday is now a swim", "never overwritten");
  assert.equal(repo.getEnduranceSchedule().quality.type, "threshold");
  assert.equal(getBrainDecision(id).status, "applied", "the statement still stands, Undo still offered");
});

test("a clean Undo restores the week before it and invalidates today's read", () => {
  const id = stateRunWeek(null);
  cacheTodaysRead();
  const undone = revertDecision(id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(repo.getEnduranceSchedule(), null, "no week stood before");
  assert.equal(getCachedDayRead(today()), null, "the Brief re-reads the restored week");
});

test("an Undo snapshot written before the words were owned keeps the structure-only check", () => {
  const id = stateRunWeek("old note");
  const row = db.prepare(`SELECT payload_json FROM brain_rollbacks WHERE decision_id = ?`).get(id);
  const payload = JSON.parse(row.payload_json);
  delete payload.applied_words;
  db.prepare(`UPDATE brain_rollbacks SET payload_json = ? WHERE decision_id = ?`).run(JSON.stringify(payload), id);
  repo.setProfile({ endurance_schedule: { ...repo.getEnduranceSchedule(), note: "newer", source: "athlete" } });
  assert.equal(revertDecision(id).ok, true, "legacy rows behave exactly as before");
});

test("undoing a stance that replaced another reopens the earlier one WITH its ledger row and its Undo", () => {
  const first = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 12), words: "push me" });
  assert.equal(first.ok, true, first.error);
  const second = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 20), words: "push me longer" });
  assert.equal(second.ok, true, second.error);
  assert.equal(getBrainDecision(first.decision_id).status, "superseded");
  assert.equal(getBrainDecision(first.decision_id).superseded_by, second.decision_id);
  const canceled = listBrainExpectations({ decisionId: first.decision_id });

  const undone = revertDecision(second.decision_id);
  assert.equal(undone.ok, true, undone.error);
  const state = trainingDriveState(today());
  assert.equal(state.stance?.until, addDaysISO(today(), 12), "the earlier stance is in force again");
  const reopened = getBrainDecision(first.decision_id);
  assert.equal(reopened.status, "applied", "its row is in force too");
  assert.equal(reopened.superseded_by, null);
  for (const e of listBrainExpectations({ decisionId: first.decision_id })) {
    if (String(e.window_end) >= today()) assert.equal(e.status, "pending", `expectation ${e.id} resumes`);
  }
  assert.equal(canceled.length, listBrainExpectations({ decisionId: first.decision_id }).length);

  // …so the reopened push has its own one-tap Undo.
  const again = revertDecision(first.decision_id);
  assert.equal(again.ok, true, again.error);
  assert.equal(trainingDriveState(today()).stance, null);
});

test("a row some OTHER decision superseded is left alone", () => {
  const first = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 12) });
  const second = setTrainingDrive({ drive: "push", until: addDaysISO(today(), 20) });
  // Some other row moved it (any id but the one being undone).
  db.prepare(`UPDATE brain_decisions SET superseded_by = id WHERE id = ?`).run(first.decision_id);
  assert.equal(revertDecision(second.decision_id).ok, true);
  assert.equal(getBrainDecision(first.decision_id).status, "superseded");
});
