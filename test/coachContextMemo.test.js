// The process-wide getCoachContext memo (src/repo/coach.ts).
//
// The whole coach assembly — ~50 producers over the training, nutrition, health
// and brain tables — used to be rebuilt from scratch for every consumer, because
// the brainSignal memo inside it is REQUEST-scoped. The coaching-focus GET, the
// chat prompt, the day/nutrition/coach prompt builders and the MCP read tools all
// want a piece of the same build, and Today asks for several of them at once on
// one SQLite thread.
//
// What makes sharing one build safe is the KEY, and that is what these tests pin:
// a write to anything the coach READS invalidates it — inserts and deletes via row
// counts and high-water marks, in-place EDITS via a temp update odometer SQLite keeps
// for us, plus the profile/settings rows by value, so no write path has to remember to
// bump a counter — while bookkeeping traffic does NOT, the local date/hour cover the
// time-of-day framing, and a short TTL is the last backstop under all of it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { getCoachContext, getCoachingFocus, resetCoachContextMemo } from "../dist/repo/coach.js";
import { recordDiagnosticEvent } from "../dist/repo/diagnostics.js";
import { recordRequestMetric } from "../dist/repo/request-metrics.js";
import { db } from "../dist/db.js";

// A fixed instant well inside its own hour in every UTC offset (including the
// :30 and :45 ones), so a test that ticks a minute stays inside one hour.
const MID_HOUR_INSTANT = Date.parse("2026-08-25T14:10:00Z");

test("the same build is shared while nothing has changed", () => {
  resetCoachContextMemo();
  const first = getCoachContext();
  const second = getCoachContext();
  assert.equal(second, first, "one build, shared by reference — not rebuilt per consumer");

  // And the standalone conductor read comes out of that same build, so the
  // interface and the prompts can never be looking at two different days.
  assert.equal(getCoachingFocus(), first.coaching_focus);
});

test("any write rebuilds it, including writes no version counter tracks", () => {
  resetCoachContextMemo();
  const before = getCoachContext();
  assert.equal(getCoachContext(), before);

  // A TRAINING write — covered by the hand-kept counters too.
  repo.logSetByName({ date: "2032-05-04", exercise: "Memo Squat", weight: 135, reps: 5, day_number: null });
  const afterTraining = getCoachContext();
  assert.notEqual(afterTraining, before, "a logged set rebuilds the context");

  // A SETTINGS write — covered by NO training/marker/food counter. The old
  // coaching-focus key had to name lead_mode and proactive_enabled by hand; the
  // backstop compares the whole settings row, so it catches every column.
  repo.setSettings({ lead_mode: "ask" });
  const afterSettings = getCoachContext();
  assert.notEqual(afterSettings, afterTraining, "a settings write rebuilds the context");

  // A CHECK-IN write — a table outside every hand-kept counter.
  repo.addCheckin("2032-05-04", { sleep_hours: 5, stress: 4, soreness: 3, energy: 2 });
  assert.notEqual(getCoachContext(), afterSettings, "a check-in rebuilds the context");
});

test("an UPDATE rebuilds it too — the case a row count and a high-water mark cannot see", () => {
  // COUNT catches deletes and MAX(rowid) catches inserts, but this context is full
  // of in-place edits: a symptom resolved, a memory superseded, a family member
  // corrected. Each of those left the key identical, so the coach kept reading the
  // pre-edit picture for the rest of the TTL.
  resetCoachContextMemo();

  const symptom = repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2032-05-04" });
  const beforeResolve = getCoachContext();
  assert.equal(getCoachContext(), beforeResolve);
  repo.resolveTrainingSymptom(symptom.id, "2032-05-05");
  assert.notEqual(getCoachContext(), beforeResolve, "resolving a symptom rebuilds the context");

  const note = repo.addMemory("prefers morning sessions", "preference", "user");
  const beforeMemoryEdit = getCoachContext();
  repo.updateMemory(note.id, { content: "prefers evening sessions" });
  assert.notEqual(getCoachContext(), beforeMemoryEdit, "editing a memory rebuilds the context");

  // family_members was read by the context (coach.ts `family: listFamily()`) and was
  // not in the covered-table list at all — an added member was invisible too.
  const member = repo.addFamily({ name: "Ana", relationship: "daughter" });
  const beforeFamilyEdit = getCoachContext();
  assert.notEqual(beforeFamilyEdit, beforeMemoryEdit, "adding a family member rebuilds the context");
  repo.updateFamily(member.id, { allergies: "peanuts" });
  assert.notEqual(getCoachContext(), beforeFamilyEdit, "editing a family member rebuilds the context");
});

test("bookkeeping writes do NOT invalidate it — the memo has to survive ordinary traffic", () => {
  // This is the property that makes the whole memo worth having, and the one a
  // future change can silently destroy. The first attempt keyed on SQLite's own
  // row-change odometer, which looked airtight until it was measured: the request
  // -metric histogram and the diagnostic sink write on EVERY request, so the key
  // moved between any two reads and the memo never hit once. The key must track
  // what the COACH READS, not every row the process happens to write.
  resetCoachContextMemo();
  const first = getCoachContext();

  recordRequestMetric({
    protocol: "api",
    method: "GET",
    route: "/api/coaching-focus",
    status: 200,
    duration_ms: 12,
    scope: "product",
  });
  recordDiagnosticEvent({
    source: "api",
    kind: "http_error",
    level: "info",
    operation: "GET",
    route: "/api/unknown",
    status: 404,
    fingerprint: "api:http_error:GET:/api/unknown:404",
    message: "HTTP 404 /api/nope",
  });

  assert.equal(getCoachContext(), first, "telemetry traffic must not rebuild the coach context");
});

test("the TTL rebuilds it even when nothing observable changed", () => {
  resetCoachContextMemo();
  // Pinned mid-hour on purpose: the memo key carries the local HOUR, so a clock
  // started at the ambient `Date.now()` crosses an hour boundary on ~1.7% of runs
  // and the "still shared inside the window" assert fails for a reason that has
  // nothing to do with the TTL under test.
  mock.timers.enable({ apis: ["Date"], now: MID_HOUR_INSTANT });
  try {
    const first = getCoachContext();
    // Well past the minute the TTL used to be: an idle open must not pay for a rebuild
    // the key says nothing has earned.
    mock.timers.tick(5 * 60_000);
    assert.equal(getCoachContext(), first, "still shared minutes later — the key invalidates, not the clock");
    mock.timers.tick(11 * 60_000); // past the 15-minute backstop
    assert.notEqual(getCoachContext(), first, "rebuilt once the backstop expires");
  } finally {
    mock.timers.reset();
  }
});

test("the shared build stays a well-formed coach context", () => {
  resetCoachContextMemo();
  const fresh = getCoachContext();
  const shared = getCoachContext();
  assert.equal(shared, fresh);
  assert.ok(shared.now && typeof shared.now.date === "string");
  assert.deepEqual(Object.keys(shared).sort(), Object.keys(fresh).sort());
});

// The rotation cursor is bookkeeping, not coach input: pickAgentOrder() persists it on
// `settings` every time a round-robin order is handed out, and the whole settings row is
// in the memo key by value. Reading agent STATUS on a GET (the Brief asks on every open)
// used to go through that same rotation, so the Brief expired the very build it was
// about to read. The cursor is excluded from the key, and the status read no longer
// rotates — see agentStatusFor (src/coachOps.ts), which asks getAgentConfig directly.
test("the agent rotation cursor is not part of the key, but the rest of settings is", () => {
  repo.setSettings({ rr_cursor: "claude" }); // materialize the row before it is keyed on
  resetCoachContextMemo();
  const first = getCoachContext();
  repo.setSettings({ rr_cursor: "codex" });
  assert.equal(getCoachContext(), first, "a cursor write must not expire the shared build");
  repo.setSettings({ rr_cursor: "grok" });
  assert.equal(getCoachContext(), first, "…however many times the rotation moves it");

  repo.setSettings({ coach_hour: (repo.getSettings().coach_hour + 1) % 24 });
  assert.notEqual(getCoachContext(), first, "a real settings change still rebuilds");
});

test("a rollback that eats the odometer's seed row does not end memoization for good", () => {
  resetCoachContextMemo();
  // The TEMP counter table and its seed row are created on the FIRST signature call. If
  // that call lands inside a transaction the caller later rolls back, both go with it —
  // and a cached prepared statement over a table that no longer holds a row returns an
  // empty read forever, i.e. a never-matching key and a memo that silently never hits
  // again. Force exactly that shape.
  getCoachContext(); // installs and seeds the counter, whenever in this process that happens
  db.exec("SAVEPOINT odometer_probe");
  db.exec("DELETE FROM _cairn_coach_ctx_updates"); // what a rollback of the seeding call leaves
  db.exec("RELEASE odometer_probe");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM _cairn_coach_ctx_updates").get().c,
    0,
    "the counter really has no row to read"
  );

  resetCoachContextMemo();
  const first = getCoachContext();
  assert.equal(getCoachContext(), first, "the odometer was reinstalled and the memo hits again");
});
