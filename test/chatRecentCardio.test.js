// Chat can see this morning's run, with its numbers.
//
// The live case (2026-09-29): the athlete asked the chat coach how his morning run
// went. The synced row was there — 9.68 km, 53.9 min, 5:34/km, avg HR 157 on the
// linked Garmin row, "Boston Running" — and the coach answered that "the specific
// Garmin metrics (distance, pace, and heart rate) for this morning's run aren't
// visible in my data right now", then on a follow-up that the "heart rate graph,
// splits, and exact pace" had not "pulled through". The only run evidence it had was
// the raw `recent_activities` storage rows buried in a several-hundred-KB single-line
// DATA JSON, km-only, with the heart rate packed into a free-text notes string.
//
//   • DATA.recent_cardio carries today's run the way a coach reads one — when, title,
//     distance and pace in the athlete's unit, duration, avg/max HR, stated effort, the
//     personal model's read — at every site that carries the endurance bundle;
//   • the chat prompt renders it as a plain block above DATA, with the rule that a
//     listed run is never "missing", that laps are one read away (read_activity_detail)
//     and that HR streams / GPS tracks are not stored;
//   • Garmin's training-effect number never rides as a verdict;
//   • the bounded read tool returns the heart rate as a field, not only in notes.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { recentCardioRead } from "../dist/repo/recent-cardio.js";
import { buildChatPrompt, buildChatPromptParts, buildWeeklyReadPrompt } from "../dist/prompt.js";
import { chatReadPromptSuffix, composeChatAttemptPrompt, newChatReadState } from "../dist/chatTurns.js";
import { projectCoachContext, PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";
import { executeCoachReadTool } from "../dist/brain/read-tool-runtime.js";
import { resetCoachContextMemo } from "../dist/repo/coach.js";
import { recordCalibrationEvent } from "../dist/repo/calibration.js";

beforeEach(() => {
  resetTables("activities", "garmin_activities", "garmin_sources", "hr_model_state", "calibration_events", "app_state");
  repo.setSettings({ run_units: "km" });
  resetCoachContextMemo();
});

const shiftDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

let seq = 0;
function watchRun({ date, km = 9.68, minutes = 53.9, avgHr = 157, maxHr = 170, name = "Boston Running" }) {
  seq += 1;
  repo.upsertGarminActivity({
    external_id: `cardio-${seq}`,
    date,
    start_time: `${date} 06:34:55`,
    type: "running",
    name,
    duration_min: minutes,
    moving_min: minutes,
    distance_km: km,
    avg_hr: avgHr,
    max_hr: maxHr,
    aerobic_te: 4.5,
    training_effect: 4.5,
    training_load: 219,
  });
  return Number(
    db
      .prepare(`SELECT a.id FROM activities a JOIN garmin_activities g ON g.activity_id = a.id WHERE g.external_id = ?`)
      .get(`cardio-${seq}`).id
  );
}

const chatData = (prompt) => JSON.parse(prompt.slice(prompt.indexOf("\nDATA:\n") + "\nDATA:\n".length));
const cardioBlock = (prompt) => {
  const start = prompt.indexOf("RECENT RUNS & CARDIO");
  assert.ok(start >= 0, "the prompt renders a RECENT RUNS & CARDIO block");
  return prompt.slice(start, prompt.indexOf("\n\n", start));
};

test("chat DATA carries this morning's watch run with its numbers", () => {
  const today = localDateISO();
  const id = watchRun({ date: today });
  repo.setSettings({ run_units: "mi" });
  resetCoachContextMemo();

  const prompt = buildChatPrompt([], "How was my run this morning?", undefined, { lane: "coach" });
  // The full context carries the read inside DATA; the lean core (the default) prints it
  // whole as the block above DATA instead of repeating it in the JSON.
  const data = chatData(buildChatPrompt([], "How was my run this morning?", undefined, { lane: "coach", context: "full" }));
  assert.ok(!Object.hasOwn(chatData(prompt), "recent_cardio"), "the lean core does not repeat the block in DATA");
  assert.ok(data.recent_cardio, "chat DATA carries recent_cardio");
  const row = data.recent_cardio.rows[0];
  assert.equal(row.activity_id, id);
  assert.equal(row.date, today);
  assert.equal(row.when, "today");
  assert.equal(row.started, "6:34 AM");
  assert.equal(row.title, "Boston Running");
  assert.equal(row.distance_km, 9.68);
  assert.equal(row.distance, "6.01 mi");
  assert.equal(row.duration_min, 53.9);
  assert.equal(row.pace, "8:58/mi");
  assert.equal(row.avg_hr, 157);
  assert.equal(row.max_hr, 170);
  assert.equal(data.recent_cardio.units, "mi");
  // The synced row's auto-summary (Garmin load + training effect) is not carried.
  assert.equal(row.note, null);
  assert.ok(!JSON.stringify(data.recent_cardio).includes("effect"), "no training-effect number in the read");

  const block = cardioBlock(prompt);
  assert.match(block, new RegExp(`- today ${today}, started 6:34 AM — run`));
  assert.match(block, /"Boston Running" \[activity_id \d+\]: 6\.01 mi · 53\.9 min · 8:58\/mi · avg HR 157, max 170/);
  assert.match(block, /Never say a run listed here is missing/);
  // Laps are one read away; only streams and the GPS track are not kept.
  assert.match(block, /read_activity_detail with its activity_id/);
  assert.match(block, /no second-by-second heart-rate graph or GPS track/);
  assert.ok(!/effect 4\.5/.test(block), "Garmin's training effect never rides in the block");
  // The block sits ABOVE the DATA dump, where a reader meets it before the JSON.
  assert.ok(prompt.indexOf("RECENT RUNS & CARDIO") < prompt.indexOf("\nDATA:\n"));
  // And the general rule: never claim data is missing when it is here — exactly once in
  // every coach/deep prompt an attempt is actually sent. The lean prompt carries it in its
  // read contract (native, or the prompt loop's), and in its no-reads form once the reads
  // are spent or dropped (a stop round, a malformed request, a native budget used up, a
  // later prompt-loop agent); the full context keeps its own guardrail.
  const RULE = /never say something is missing|never claim data is missing/gi;
  const once = (text, name) => assert.equal((text.match(RULE) ?? []).length, 1, name);
  const spent = { ...newChatReadState(), calls: 6 };
  for (const lane of ["coach", "deep"]) {
    const lean = buildChatPromptParts([], "How was my run this morning?", undefined, { lane });
    const full = buildChatPromptParts([], "How was my run this morning?", undefined, { lane, context: "full" });
    once(composeChatAttemptPrompt(lean, true, ""), `${lane}: lean native`);
    once(
      composeChatAttemptPrompt(lean, false, chatReadPromptSuffix(newChatReadState(), false, "lean")),
      `${lane}: lean loop, reads open`
    );
    once(
      composeChatAttemptPrompt(lean, false, chatReadPromptSuffix(spent, true, "lean")),
      `${lane}: lean loop, reads spent`
    );
    once(
      composeChatAttemptPrompt(full, false, chatReadPromptSuffix(newChatReadState(), false, "full")),
      `${lane}: full, reads open`
    );
    once(
      composeChatAttemptPrompt(full, false, chatReadPromptSuffix(spent, true, "full")),
      `${lane}: full, reads spent`
    );
  }
});

test("the athlete's stated effort rides beside the run, and km keeps the stored pace", () => {
  const today = localDateISO();
  const id = watchRun({ date: today });
  db.prepare(`UPDATE activities SET rpe = 3 WHERE id = ?`).run(id);
  resetCoachContextMemo();

  const read = recentCardioRead(today);
  const row = read.rows.find((r) => r.activity_id === id);
  assert.equal(read.units, "km");
  assert.equal(row.stated_rpe, 3);
  assert.equal(row.stated_easy, true);
  assert.equal(row.distance, "9.68 km");
  assert.equal(row.pace, "5:34/km");

  const block = cardioBlock(buildChatPrompt([], "How was my run?", undefined, { lane: "coach" }));
  assert.match(block, /their stated effort rpe 3 \(easy, in their words\)/);
});

test("the window is a week, newest first, and yesterday reads as yesterday", () => {
  const today = localDateISO();
  watchRun({ date: shiftDays(today, -8), name: "Too Old" });
  watchRun({ date: shiftDays(today, -1), name: "Yesterday Run" });
  repo.addActivity({ type: "run", duration_min: 30, distance_km: 5, date: shiftDays(today, -3), notes: "felt light" });
  const read = recentCardioRead(today);
  assert.equal(read.window_days, 7);
  assert.equal(read.rows.length, 2);
  assert.equal(read.rows[0].title, "Yesterday Run");
  assert.equal(read.rows[0].when, "yesterday");
  assert.equal(read.rows[1].date, shiftDays(today, -3));
  assert.ok(!read.rows.some((r) => r.title === "Too Old"));
  // A hand log's own words ride along.
  assert.equal(read.rows[1].note, "felt light");
});

test("no cardio in the week says so plainly in chat, and quietly nowhere else", () => {
  const prompt = buildChatPrompt([], "How was my run?", undefined, { lane: "coach" });
  assert.match(prompt, /RECENT RUNS & CARDIO \(last 7 days\): nothing logged or synced/);
  assert.ok(!buildWeeklyReadPrompt().includes("RECENT RUNS & CARDIO"));
});

test("every site that carries the endurance bundle carries recent_cardio; the weekly read renders it", () => {
  const today = localDateISO();
  watchRun({ date: today });
  resetCoachContextMemo();
  for (const site of ["chat", "day_read", "weekly_read", "coach", "session", "insight", "week_ahead"]) {
    assert.ok(PROMPT_CONTEXT_SITES[site].keys.includes("recent_cardio"), `${site} allowlists recent_cardio`);
  }
  assert.deepEqual(Object.keys(projectCoachContext({ recent_cardio: { rows: [] } }, "chat")), ["recent_cardio"]);
  const weekly = buildWeeklyReadPrompt();
  assert.match(weekly, /RECENT RUNS & CARDIO/);
  assert.match(weekly, /"Boston Running"/);
});

test("the bounded read tool returns a run's heart rate as a field", () => {
  const today = localDateISO();
  const id = watchRun({ date: today });
  const result = executeCoachReadTool(
    { tool: "read_training_window", args: { end_date: today, weeks: 1 } },
    { run_id: "chat-cardio", op: "chat", today }
  );
  const events = result.data?.events ?? result.result?.events ?? [];
  const run = events.find((e) => e.event === "activity" && e.id === id);
  assert.ok(run, "today's run is in the window");
  assert.equal(run.avg_hr, 157);
  assert.equal(run.max_hr, 170);
  assert.equal(run.distance_km, 9.68);
});

test("the personal HR model reads the run, and the stated effort rides beside it", () => {
  const today = localDateISO();
  // The owner's model: a field-tested threshold of 167, so an easy line near 149.
  for (const days of [60, 70, 80, 90])
    watchRun({ date: shiftDays(today, -days), km: 6, minutes: 36, avgHr: 145, maxHr: 182 });
  recordCalibrationEvent({
    kind: "lthr_tt",
    date: shiftDays(today, -30),
    target_key: "lthr",
    result: { lthr: 167 },
    source: "stated",
  });
  const id = watchRun({ date: today });
  db.prepare(`UPDATE activities SET rpe = 3 WHERE id = ?`).run(id);
  resetCoachContextMemo();

  const row = recentCardioRead(today).rows.find((r) => r.activity_id === id);
  assert.equal(row.personal_effort, "steady", "157 bpm for 54 min sits in his steady band");
  assert.equal(row.stated_easy, true);
  const block = cardioBlock(buildChatPrompt([], "How was my run?", undefined, { lane: "coach" }));
  assert.match(block, /their stated effort rpe 3 \(easy, in their words\) · their own HR model reads it steady/);
  assert.match(block, /Their stated effort outranks the watch and the model/);
});

test("today's energy off the watch is a plain line, and each effort carries its own estimate", () => {
  const today = localDateISO();
  const id = watchRun({ date: today });
  db.prepare(`UPDATE garmin_activities SET calories = 527 WHERE activity_id = ?`).run(id);
  repo.upsertGarminDailyMetric({ date: today, steps: 8172, active_calories: 1418, total_calories: 2659 });
  resetCoachContextMemo();
  const prompt = buildChatPrompt([], "What did I burn today?", undefined, { lane: "coach" });
  assert.match(cardioBlock(prompt), /watch estimate 527 kcal/);
  assert.match(prompt, /TODAY'S ENERGY \(their watch's running total so far today[^\n]*: active 1418 kcal · total 2659 kcal/);
  assert.ok(prompt.indexOf("TODAY'S ENERGY") < prompt.indexOf("\nDATA:\n"));

  // Yesterday's total is not today's: no line rather than a wrong one.
  resetTables("garmin_daily_metrics");
  repo.upsertGarminDailyMetric({ date: shiftDays(today, -1), active_calories: 900, total_calories: 2800 });
  resetCoachContextMemo();
  assert.ok(!buildChatPrompt([], "What did I burn today?", undefined, { lane: "coach" }).includes("TODAY'S ENERGY"));
});
