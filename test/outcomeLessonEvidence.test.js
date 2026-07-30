// What a reconciled outcome is allowed to LEARN, and from which evidence.
//
// Three bugs are pinned here:
//   1. the nutrition check-in lesson was derived from getWeeklyStats' trailing
//      ≤21-day slope, read the day after the check-in — a window that predates the
//      intervention almost entirely, so the lesson scored the check-in against the
//      very trend it was made to change;
//   2. session_suggest outcomes were stored and then hardcoded `lesson: null`;
//   3. last_referenced_at was stamped and never read, and the librarian saw no dates
//      at all, so a preference stated once in June ranked like one confirmed
//      yesterday.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildMemoryConsolidationPrompt } from "../dist/prompt/chat.js";
import { buildSessionPrompt } from "../dist/prompt/day.js";
import { db, repo, localDaysAgo, resetTables, seedTrainingDay } from "./_seed.js";

const weighIn = (date, lb) => db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`).run(date, lb);

const suggestionRow = (id) => db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(id);
const outcomeOf = (id) => JSON.parse(suggestionRow(id).outcome_json ?? "null");
const learningRows = () => repo.listMemory(50).filter((m) => m.kind === "learning");

beforeEach(() => {
  resetTables("suggestions", "memory", "bodyweight_log", "sessions", "logged_sets", "exercises");
});

// ── the post-intervention slope ──────────────────────────────────────────────

test("the slope reads only weigh-ins on or after the intervention date", () => {
  // A steep drop BEFORE the check-in, a clear rise after. A window that swept in the
  // pre-intervention days would read this as falling; only the post-intervention
  // slice can see the rise.
  weighIn(localDaysAgo(20), 212);
  weighIn(localDaysAgo(17), 208);
  weighIn(localDaysAgo(14), 204);
  weighIn(localDaysAgo(11), 200);
  weighIn(localDaysAgo(10), 200);
  weighIn(localDaysAgo(6), 201.5);
  weighIn(localDaysAgo(2), 203);

  const trend = repo.postInterventionWeightTrend(localDaysAgo(10));
  assert.equal(trend.sufficient, true);
  assert.equal(trend.weigh_ins, 3, "the four pre-intervention weigh-ins are excluded");
  assert.equal(trend.first_date, localDaysAgo(10));
  assert.ok(trend.lb_wk > 0, `post-intervention weight is rising, got ${trend.lb_wk}`);

  // The same series read from the earlier date is falling — which is precisely the
  // answer the old lesson was drawing its conclusion from.
  const fromBefore = repo.postInterventionWeightTrend(localDaysAgo(20));
  assert.ok(fromBefore.lb_wk < 0, `the pre-intervention span falls, got ${fromBefore.lb_wk}`);
});

test("a thin evidential base yields no slope at all rather than a guess", () => {
  weighIn(localDaysAgo(10), 200);
  weighIn(localDaysAgo(4), 202);
  const tooFew = repo.postInterventionWeightTrend(localDaysAgo(10));
  assert.equal(tooFew.sufficient, false, "two weigh-ins cannot draw a line");
  assert.equal(tooFew.lb_wk, null);

  resetTables("bodyweight_log");
  weighIn(localDaysAgo(10), 200);
  weighIn(localDaysAgo(9), 201);
  weighIn(localDaysAgo(8), 202);
  const tooShort = repo.postInterventionWeightTrend(localDaysAgo(10));
  assert.equal(tooShort.weigh_ins, 3);
  assert.equal(tooShort.span_days, 2);
  assert.equal(tooShort.sufficient, false, "a two-day span cannot be quoted per week");
  assert.equal(tooShort.lb_wk, null);
});

// ── deferral ─────────────────────────────────────────────────────────────────

test("a check-in younger than its minimum evidence span is not even selected", () => {
  const row = repo.recordSuggestion("nutrition_checkin", localDaysAgo(3), {
    target_kcal: 2_000,
    tdee: 2_600,
    direction: "down",
  });
  const result = repo.reconcileSuggestions();
  assert.equal(result.deferred, 0, "it never occupied the pass budget");
  assert.equal(suggestionRow(row.id).reconciled_at, null, "and it stays eligible for a later pass");
});

test("an eligible check-in with too few post-intervention weigh-ins defers, silently and idempotently", () => {
  const row = repo.recordSuggestion("nutrition_checkin", localDaysAgo(10), {
    target_kcal: 2_000,
    tdee: 2_600,
    direction: "down",
  });
  weighIn(localDaysAgo(9), 201); // one lonely weigh-in

  const first = repo.reconcileSuggestions();
  assert.equal(first.deferred, 1);
  assert.equal(first.reconciled, 0);
  assert.equal(first.learnings, 0, "a deferred lesson is silent, not an error");
  assert.equal(suggestionRow(row.id).reconciled_at, null);
  assert.equal(outcomeOf(row.id).evidence, "pending", "the partial state is recorded, not lost");

  const second = repo.reconcileSuggestions();
  assert.equal(second.deferred, 1, "re-running defers again rather than concluding");
  assert.equal(second.learnings, 0);
  assert.equal(learningRows().length, 0, "deferral never appends memory rows");
  assert.equal(suggestionRow(row.id).reconciled_at, null);
});

test("once the base exists the deferred row concludes and the lesson lands", () => {
  const row = repo.recordSuggestion("nutrition_checkin", localDaysAgo(12), {
    target_kcal: 2_000,
    tdee: 2_600,
    direction: "down",
  });
  assert.equal(repo.reconcileSuggestions().deferred, 1, "nothing to read yet");

  // A deficit check-in whose bodyweight then trended UP — the one case that teaches
  // something about the expenditure estimate.
  weighIn(localDaysAgo(12), 200);
  weighIn(localDaysAgo(8), 201);
  weighIn(localDaysAgo(4), 202.5);

  const result = repo.reconcileSuggestions();
  assert.equal(result.deferred, 0);
  assert.equal(result.reconciled, 1);
  assert.equal(result.learnings, 1);
  assert.ok(suggestionRow(row.id).reconciled_at, "the row is now closed");
  assert.equal(outcomeOf(row.id).evidence, "sufficient");
  assert.ok(outcomeOf(row.id).post_intervention_trend_lb_wk > 0);
  assert.match(learningRows()[0].content, /higher TDEE/i);
});

test("deferral terminates: past its deadline a check-in closes honestly with no lesson", () => {
  const row = repo.recordSuggestion("nutrition_checkin", localDaysAgo(40), {
    target_kcal: 2_000,
    tdee: 2_600,
    direction: "down",
  });
  const result = repo.reconcileSuggestions();
  assert.equal(result.deferred, 0, "an unanswerable row cannot requeue forever");
  assert.equal(result.reconciled, 1);
  assert.equal(result.learnings, 0);
  assert.ok(suggestionRow(row.id).reconciled_at);
  assert.equal(outcomeOf(row.id).evidence, "insufficient");
});

test("a check-in whose weight moved the expected way teaches nothing — the calm answer", () => {
  repo.recordSuggestion("nutrition_checkin", localDaysAgo(12), {
    target_kcal: 2_000,
    tdee: 2_600,
    direction: "down",
  });
  weighIn(localDaysAgo(12), 202.5);
  weighIn(localDaysAgo(8), 201);
  weighIn(localDaysAgo(4), 200);

  const result = repo.reconcileSuggestions();
  assert.equal(result.reconciled, 1);
  assert.equal(result.learnings, 0);
  assert.equal(learningRows().length, 0);
});

// ── the minutes-drift lesson ────────────────────────────────────────────────

// A reconciled session_suggest outcome needs a suggested time, a session that
// actually happened, and a logged duration to compare against.
function suggestedDay(daysAgo, suggestedMinutes, actualMinutes) {
  const date = localDaysAgo(daysAgo);
  repo.recordSuggestion("session_suggest", date, { est_minutes: suggestedMinutes, item_count: 4 });
  const session = seedTrainingDay(date);
  db.prepare(`UPDATE sessions SET duration_min = ? WHERE id = ?`).run(actualMinutes, session.id);
  return date;
}

test("three sessions drifting the same way become one calm, durable lesson", () => {
  suggestedDay(4, 60, 32);
  suggestedDay(3, 60, 35);
  suggestedDay(2, 60, 30);

  const result = repo.reconcileSuggestions();
  assert.equal(result.reconciled, 3);
  assert.ok(result.learnings >= 1);
  const rows = learningRows();
  assert.equal(rows.length, 1, "repeated evidence reinforces one row instead of appending noise");
  assert.match(rows[0].content, /finishing well under the suggested time/i);
  assert.doesNotMatch(rows[0].content, /\d+\s*%/, "no numeric score reaches the lesson");
  assert.doesNotMatch(rows[0].content, /\byou must\b/i, "a lesson seasons the coach, it never gates");
});

test("sessions consistently overrunning teach the opposite lesson", () => {
  suggestedDay(4, 45, 75);
  suggestedDay(3, 45, 70);
  suggestedDay(2, 45, 80);

  repo.reconcileSuggestions();
  const rows = learningRows();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /running past the suggested time/i);
});

test("drift in both directions says nothing", () => {
  suggestedDay(4, 60, 30);
  suggestedDay(3, 60, 32);
  suggestedDay(2, 60, 95);

  const result = repo.reconcileSuggestions();
  assert.equal(result.reconciled, 3);
  assert.equal(result.learnings, 0, "a mixed window is not a tendency");
  assert.equal(learningRows().length, 0);
});

test("two drifting days are a pair of anecdotes, not a pattern", () => {
  suggestedDay(3, 60, 30);
  suggestedDay(2, 60, 31);

  assert.equal(repo.reconcileSuggestions().learnings, 0);
  assert.equal(learningRows().length, 0);
});

test("sessions finishing near the suggested time are agreement, not drift", () => {
  suggestedDay(4, 60, 55);
  suggestedDay(3, 60, 62);
  suggestedDay(2, 60, 58);

  assert.equal(repo.reconcileSuggestions().learnings, 0);
});

test("a skipped day is not a shorter session", () => {
  for (const daysAgo of [4, 3, 2]) {
    repo.recordSuggestion("session_suggest", localDaysAgo(daysAgo), { est_minutes: 60, item_count: 4 });
  }
  const result = repo.reconcileSuggestions();
  assert.equal(result.reconciled, 3);
  assert.equal(result.learnings, 0, "days with no training carry no minutes evidence");
});

test("a flip in direction retires the contradicting lesson instead of leaving both live", () => {
  suggestedDay(9, 60, 30);
  suggestedDay(8, 60, 32);
  suggestedDay(7, 60, 31);
  repo.reconcileSuggestions();
  assert.match(learningRows()[0].content, /finishing well under/i);

  // A later stretch that runs long. The short-drift days have aged out of nothing —
  // they are still in the lookback — so first clear the ledger the way a genuine
  // change of tendency would over time, then reconcile the new run.
  db.prepare(`DELETE FROM suggestions WHERE kind = 'session_suggest'`).run();
  suggestedDay(4, 45, 75);
  suggestedDay(3, 45, 72);
  suggestedDay(2, 45, 80);
  repo.reconcileSuggestions();

  const live = learningRows();
  assert.equal(live.length, 1, "the contradicting lesson was retired, not left standing beside its opposite");
  assert.match(live[0].content, /running past the suggested time/i);
  const retired = repo.listMemory(50, { includeSuperseded: true }).filter((m) => m.kind === "learning");
  assert.equal(retired.length, 2, "supersession MARKS the old lesson; it is never destroyed");
});

// ── the lesson actually reaches the prompt that needs it ────────────────────

test("the minutes-drift lesson reaches the session-suggest prompt", () => {
  suggestedDay(4, 60, 30);
  suggestedDay(3, 60, 33);
  suggestedDay(2, 60, 31);
  repo.reconcileSuggestions();
  const lesson = learningRows()[0].content;

  const prompt = buildSessionPrompt(undefined, {});
  assert.ok(
    prompt.includes(lesson),
    "a lesson nothing reads is the disease this cures — it must ride the `learnings` key into DATA"
  );
});

// ── memory ages ─────────────────────────────────────────────────────────────

test("equally-confident memories tie-break on when they were last live, not last edited", () => {
  const quiet = repo.addMemory("Trains best mid-morning", "preference", "user");
  const stale = repo.addMemory("Keeps a spare kettlebell at the office", "preference", "user");
  // `stale` was REWRITTEN most recently but has not been surfaced in months;
  // `quiet` was written first and surfaced yesterday. Ordering on updated_at alone
  // put the forgotten one first.
  db.prepare(`UPDATE memory SET updated_at = '2026-01-01 00:00:00', last_referenced_at = ? WHERE id = ?`).run(
    `${localDaysAgo(1)} 08:00:00`,
    quiet.id
  );
  db.prepare(`UPDATE memory SET updated_at = '2026-06-01 00:00:00', last_referenced_at = '2026-01-05 00:00:00' WHERE id = ?`).run(
    stale.id
  );

  const ids = repo.memoryForCoach(10).map((m) => m.id);
  assert.ok(ids.indexOf(quiet.id) < ids.indexOf(stale.id), "recency of REFERENCE breaks the tie");
});

test("confidence still outranks recency — a restated fact is not demoted for being old", () => {
  const restated = repo.addMemory("Cannot train Thursdays", "constraint", "user");
  repo.addMemory("Cannot train Thursdays", "constraint", "user"); // an exact repeat reinforces
  const fresh = repo.addMemory("Bought new running shoes", "preference", "user");
  db.prepare(`UPDATE memory SET updated_at = '2026-01-01 00:00:00', last_referenced_at = '2026-01-01 00:00:00' WHERE id = ?`).run(
    restated.id
  );

  const ids = repo.memoryForCoach(10).map((m) => m.id);
  assert.ok(ids.indexOf(restated.id) < ids.indexOf(fresh.id), "confidence stays primary");
});

test("the consolidation prompt shows the librarian dates and who said it", () => {
  const stated = repo.addMemory("Wants to squat 315 by spring", "goal", "user");
  const inferred = repo.addMemory("Tends to skip breakfast on travel days", "observation", "agent");
  db.prepare(`UPDATE memory SET created_at = '2026-03-04 09:00:00', last_referenced_at = '2026-03-09 09:00:00' WHERE id = ?`).run(
    stated.id
  );

  const prompt = buildMemoryConsolidationPrompt();
  assert.match(prompt, /recorded 2026-03-04/, "the recorded date is visible");
  assert.match(prompt, /last surfaced 2026-03-09/, "so is the reference stamp nothing used to read");
  assert.match(prompt, /user-stated/, "a fact the athlete stated is marked as theirs");
  assert.ok(prompt.includes(`[id ${inferred.id}] (observation, source agent`), "an inferred fact names its source");
  assert.match(prompt, /AGE ALONE IS NEVER A REASON TO SUPERSEDE/, "durable identity facts are protected by rule");
  assert.match(prompt, /never surfaced/, "a memory that has never been surfaced says so rather than showing nothing");
});
