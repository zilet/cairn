// A push stance that has RUN OUT, then the athlete chooses Push again.
//
// Past its last day a stance stops reading (read-time, no write): the drive in force
// falls back to what stood before it, while the standing Settings value still says
// "push". Settings used to show that standing Push, and re-selecting Push sent nothing
// (push → push is not a toggle), so a lapsed stance could never be restarted from there.
// The fix: Settings shows the drive IN FORCE and writes through the stance door
// (PUT /api/training-drive → setTrainingDrive), which replaces an expired open stance
// with a fresh dated one. A same-value generic settings write still never ends a LIVE
// stance (pushStanceSettingsSave.test.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, repo } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { localDateISO } from "../dist/repo/shared.js";
import { setTrainingDrive } from "../dist/domain/training/training-drive.js";
import { latestOpenStance, pushStanceActive, trainingDriveState } from "../dist/repo/training-drive.js";
import { trainingDriveRead } from "../dist/repo/training-drive-read.js";

const today = () => localDateISO();

function stanceRows() {
  return db.prepare(`SELECT id, since, until, ended_reason, previous_drive FROM training_stances ORDER BY id`).all();
}

test("a lapsed stance reads steady in force while the standing value still says push", () => {
  const T = today();
  const said = setTrainingDrive({ drive: "push", until: addDaysISO(T, -3), today: addDaysISO(T, -10) });
  assert.equal(said.ok, true, said.error);
  const read = trainingDriveRead(T, { withToday: false });
  assert.equal(read.drive, "steady", "the drive in force fell back");
  assert.equal(read.standing, "push", "the standing value is not rewritten by a read");
  assert.equal(read.stance, null);
  assert.equal(read.ended?.until, addDaysISO(T, -3), "the end is said");
  assert.ok(Array.isArray(read.push_opens) && read.push_opens.length >= 6, "what Push would open is always present");
  assert.deepEqual(read.licenses, [], "nothing is open while steady");
});

test("choosing Push over a lapsed stance opens a NEW dated stance and ends the old one", () => {
  const T = today();
  const first = setTrainingDrive({ drive: "push", until: addDaysISO(T, -3), today: addDaysISO(T, -10) });
  const res = setTrainingDrive({ drive: "push", until: addDaysISO(T, 13), words: "again, two weeks" });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.decision_id, "a new ledger row with its own Undo");
  assert.notEqual(res.decision_id, first.decision_id);
  assert.equal(res.read.drive, "push");
  assert.equal(res.read.stance?.since, T);
  assert.equal(res.read.stance?.until, addDaysISO(T, 13));
  assert.equal(res.read.stance?.words, "again, two weeks");
  assert.equal(pushStanceActive(T), true);
  const rows = stanceRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ended_reason, "replaced", "the lapsed row is closed, not left open behind the new one");
  assert.equal(rows[1].ended_reason, null);
  // The new stance falls back to what stood under the OLD one (steady), never to push.
  assert.equal(rows[1].previous_drive, "steady");
  assert.equal(trainingDriveState(addDaysISO(T, 14)).drive, "steady");
  assert.equal(repo.getSettings().training_drive, "push");
});

test("a stance lapsed past the week it is said is still replaced by a new push", () => {
  const T = today();
  setTrainingDrive({ drive: "push", until: addDaysISO(T, -20), today: addDaysISO(T, -30) });
  const before = trainingDriveRead(T, { withToday: false });
  assert.equal(before.drive, "steady");
  assert.equal(before.ended, null, "no longer news");
  assert.equal(before.standing, "push");
  const res = setTrainingDrive({ drive: "push", scope: "block" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.read.drive, "push");
  assert.equal(res.read.stance?.since, T);
  assert.equal(latestOpenStance()?.since, T);
});

test("stepping back to steady over a lapsed stance tidies it with no ledger row", () => {
  const T = today();
  setTrainingDrive({ drive: "push", until: addDaysISO(T, -3), today: addDaysISO(T, -10) });
  const decisionsBefore = db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n;
  const res = setTrainingDrive({ drive: "steady" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.decision_id, null, "nothing the athlete trains under changed — no Undo to offer");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, decisionsBefore);
  assert.equal(res.read.drive, "steady");
  assert.equal(res.read.standing, "steady", "Settings and the read now agree");
  assert.equal(latestOpenStance(), null);
});

test("a generic settings write of the same value still never ends a LIVE stance", () => {
  const T = today();
  setTrainingDrive({ drive: "push", until: addDaysISO(T, 9) });
  repo.setSettings({ training_drive: "push" });
  assert.equal(pushStanceActive(T), true);
  // ...and choosing Push again through the stance door re-states it (a new end date).
  const res = setTrainingDrive({ drive: "push", until: addDaysISO(T, 20) });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.read.stance?.until, addDaysISO(T, 20));
});
