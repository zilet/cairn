// Mid-workout remarks had nowhere to land: logged_sets.note was empty across the
// log, and chat almost never applied log_set. add_session_note appends one dated
// line onto the session that already exists. It does not open a session, and a
// question, a pain report, or a plan change stays on its own door.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { CHAT_ACTION_PROMPT_SPECS } from "../dist/chatActions.js";
import { localDateISO } from "../dist/repo/shared.js";

beforeEach(() => {
  for (const t of ["symptom_reports", "training_symptom_events", "logged_sets", "sessions"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist yet in a partial schema */
    }
  }
});

function sessionCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
}

function symptomCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM symptom_reports`).get().n;
}

function openSession(date, exercise = "Bench Press") {
  repo.logSetByName({ exercise, weight: 100, reps: 5, date });
  return repo.getSessionByDate(date);
}

test("a remark appends one dated line and a repeat does not add another", () => {
  const date = localDateISO();
  const session = openSession(date);
  assert.equal(session.notes, null);

  const first = repo.appendSessionRemark("bench felt smooth", { date });
  assert.equal(first.ok, true);
  assert.equal(first.appended, true);
  assert.equal(first.session_id, session.id);
  assert.match(first.notes, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — bench felt smooth$/);

  const again = repo.appendSessionRemark("bench   felt smooth", { date });
  assert.equal(again.ok, true);
  assert.equal(again.appended, false);
  assert.equal(again.reason, "duplicate");
  const stored = repo.getSessionByDate(date);
  assert.equal(stored.notes, first.notes);
  assert.equal(stored.notes.split("\n").length, 1);

  const second = repo.appendSessionRemark("closer grip felt better", { date });
  assert.equal(second.appended, true);
  assert.equal(second.notes.split("\n").length, 2);
  assert.equal(second.notes.split("\n")[0], first.notes);
  assert.match(second.notes.split("\n")[1], / — closer grip felt better$/);
});

test("no session is a calm no-op and does not create one", () => {
  const before = sessionCount();
  const result = repo.appendSessionRemark("bench felt smooth");
  assert.equal(result.ok, true);
  assert.equal(result.appended, false);
  assert.equal(result.reason, "no_session");
  assert.equal(sessionCount(), before);
  assert.equal(repo.getSessionByDate(localDateISO()), null);
});

test("a finished session from another day stays closed; today's finished session still takes a remark", () => {
  const past = openSession("2031-03-01");
  repo.finishSession(past.id, "wrapped");
  const closed = repo.appendSessionRemark("bench felt smooth", { date: "2031-03-01" });
  assert.equal(closed.ok, true);
  assert.equal(closed.appended, false);
  assert.equal(closed.reason, "session_closed");
  assert.equal(repo.getSessionByDate("2031-03-01").notes, "wrapped");

  const today = localDateISO();
  const live = openSession(today, "Incline Press");
  repo.finishSession(live.id, null);
  const appended = repo.appendSessionRemark("last set felt smooth", { date: today });
  assert.equal(appended.appended, true);
  assert.match(repo.getSessionByDate(today).notes, / — last set felt smooth$/);
});

test("chat files an ordinary remark and drops a question, a symptom, and a plan change", () => {
  const date = localDateISO();
  openSession(date);
  const beforeSymptoms = symptomCount();

  const filed = applyChatActions(
    { actions: [{ type: "add_session_note", text: "bench felt smooth", date }] },
    { agent: "stub", message: "bench felt smooth" }
  );
  assert.equal(filed.applied.length, 1);
  assert.equal(filed.applied[0].type, "add_session_note");
  assert.equal(filed.applied[0].result.appended, true);
  assert.match(filed.applied[0].result.notes, / — bench felt smooth$/);

  const tight = applyChatActions(
    { actions: [{ type: "add_session_note", text: "left shoulder felt tight", date }] },
    { agent: "stub", message: "left shoulder felt tight" }
  );
  assert.equal(tight.applied.length, 1);
  assert.equal(tight.applied[0].result.appended, true);
  assert.equal(symptomCount(), beforeSymptoms, "a body remark is not a symptom report");

  const grip = applyChatActions(
    { actions: [{ type: "add_session_note", text: "closer grip felt better", date }] },
    { agent: "stub", message: "closer grip felt better" }
  );
  assert.equal(grip.applied.length, 1);
  assert.equal(grip.applied[0].result.appended, true);

  const notesBeforeBlocks = repo.getSessionByDate(date).notes;
  const blocked = [
    ["Should I drop the weight on bench?", "bench felt smooth"],
    ["my knee hurts on squats", "my knee hurts on squats"],
    ["swap bench for incline press", "swap bench for incline press"],
  ];
  for (const [message, text] of blocked) {
    const turn = applyChatActions({ actions: [{ type: "add_session_note", text, date }] }, { agent: "stub", message });
    assert.equal(turn.applied.length, 0, `"${message}" is not a session remark`);
  }
  assert.equal(repo.getSessionByDate(date).notes, notesBeforeBlocks);
  assert.equal(symptomCount(), beforeSymptoms);
});

test("a missing session still returns the calm result, and the prompt says when not to use the action", () => {
  const turn = applyChatActions(
    { actions: [{ type: "add_session_note", text: "bench felt smooth" }] },
    { agent: "stub", message: "bench felt smooth" }
  );
  assert.equal(turn.applied.length, 1);
  assert.equal(turn.applied[0].result.ok, true);
  assert.equal(turn.applied[0].result.appended, false);
  assert.equal(turn.applied[0].result.reason, "no_session");
  assert.equal(sessionCount(), 0);

  const guidance = CHAT_ACTION_PROMPT_SPECS.add_session_note.guidance.join("\n");
  assert.match(guidance, /question/i);
  assert.match(guidance, /report_training_symptom/);
  assert.match(guidance, /plan_update/);
  assert.match(guidance, /add_session_note/);
});

test("a long note the athlete typed is never shifted out to fit an aside", () => {
  const date = localDateISO();
  openSession(date);
  const mine = "My own reflection. ".repeat(50).trim(); // ~950 chars, under the 1000 cap
  db.prepare(`UPDATE sessions SET notes = ? WHERE date = ?`).run(mine, date);
  const r = repo.appendSessionRemark("bench felt smooth and the closer grip helped a lot today", { date });
  assert.equal(r.appended, false);
  assert.equal(r.reason, "notes_full");
  assert.equal(repo.getSessionByDate(date).notes, mine);
});

test("an older REMARK line is retired to make room, the athlete's own line stays", () => {
  const date = localDateISO();
  openSession(date);
  const mine = "My own line.";
  db.prepare(`UPDATE sessions SET notes = ? WHERE date = ?`).run(mine, date);
  for (let i = 0; i < 12; i++) repo.appendSessionRemark(`remark number ${i} ${"x".repeat(100)}`, { date });
  const notes = repo.getSessionByDate(date).notes;
  assert.ok(notes.startsWith(mine), "the athlete's line survives");
  assert.ok(notes.length <= 1000);
  assert.match(notes, /remark number 11/);
});

test("a question elsewhere in the message does not void a remark the model extracted", () => {
  const date = localDateISO();
  openSession(date);
  const turn = applyChatActions(
    { actions: [{ type: "add_session_note", text: "squats moved well, closer grip helped", date }] },
    { agent: "stub", message: "Squats moved well, closer grip helped. Should I add weight next week?" }
  );
  assert.equal(turn.applied.length, 1);
  assert.equal(turn.applied[0].result.appended, true);
});
