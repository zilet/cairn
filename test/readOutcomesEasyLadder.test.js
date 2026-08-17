import assert from "node:assert/strict";
import test from "node:test";
import { buildDayReadPrompt } from "../dist/prompt.js";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

// The day-read prompt's "HOW YOUR READS HAVE ACTUALLY LANDED" block used to narrate the
// REST ladder only (rest → easy), and returned "" outright when the rest divergences were
// under two. So on a morning the EASY ladder had already opened — easy → train, because the
// athlete had repeatedly gone above easy without paying for it — the agent was told nothing
// about that history and was free to write the day quietly back down to easy, re-arguing the
// exact read the deterministic floor had just retired. This checks both patterns reach it.

const EASY_STAT = { read: "easy", measures: "training stayed at or under easy", days: 5, followed: 1, diverged: 4 };
const REST_STAT = { read: "rest", measures: "no training was logged", days: 5, followed: 1, diverged: 4 };

function contextWith(byRead) {
  return { ...repo.getCoachContext(), read_adherence: { by_read: byRead, recent: [] } };
}

const EASY_EVIDENCE = { active: true, window_days: 10, overridden_and_fine: ["a", "b", "c"], last_honored_easy: null };
const REST_EVIDENCE = { active: true, window_days: 10, overridden_and_fine: ["a", "b", "c"], last_honored_rest: null };

function promptWith({ byRead, kind, signals }) {
  const date = localDaysAgo(0);
  const live = repo.dayRead(date);
  return buildDayReadPrompt(contextWith(byRead), {
    date,
    baseline: { ...live, kind, signals: { ...live.signals, ...signals } },
  });
}

test("an easy-read divergence pattern reaches the agent on its own", () => {
  resetTables("day_reads", "plan_days", "plan_items", "sessions", "logged_sets", "daily_metrics", "profile");
  const prompt = promptWith({
    byRead: [EASY_STAT],
    kind: "easy",
    signals: { easy_outcome_feedback: { ...EASY_EVIDENCE, applied: false } },
  });
  assert.match(prompt, /HOW YOUR READS HAVE ACTUALLY LANDED/, "a rest pattern is no longer the price of entry");
  assert.match(prompt, /5 easy reads[\s\S]*went above easy on\s*4/);
  assert.ok(!/Of the \d+ rest read/.test(prompt), "no rest pattern was there to narrate");
});

test("the prompt says today was already opened only when the easy ladder actually acted", () => {
  resetTables("day_reads", "plan_days", "plan_items", "sessions", "logged_sets", "daily_metrics", "profile");
  const untouched = promptWith({
    byRead: [EASY_STAT],
    kind: "easy",
    signals: { easy_outcome_feedback: { ...EASY_EVIDENCE, applied: false } },
  });
  assert.ok(!/ALREADY been opened/.test(untouched), "the pattern exists, but nothing was opened this morning");

  const opened = promptWith({
    byRead: [EASY_STAT],
    kind: "train",
    signals: { easy_outcome_feedback: { ...EASY_EVIDENCE, applied: true } },
  });
  assert.match(opened, /ALREADY been opened from easy to a training day/);
  assert.match(opened, /do NOT quietly walk it back/, "the agent is told not to undo the floor's own step");
});

test("both ladders are narrated together when both patterns are there", () => {
  resetTables("day_reads", "plan_days", "plan_items", "sessions", "logged_sets", "daily_metrics", "profile");
  const prompt = promptWith({
    byRead: [EASY_STAT, REST_STAT],
    kind: "train",
    signals: {
      outcome_feedback: { ...REST_EVIDENCE, applied: false },
      easy_outcome_feedback: { ...EASY_EVIDENCE, applied: true },
    },
  });
  assert.match(prompt, /5 rest reads/);
  assert.match(prompt, /5 easy reads/);
  assert.match(prompt, /ALREADY been opened from easy/);
  assert.ok(!/ALREADY been eased/.test(prompt), "the rest ladder did not act today, so it claims nothing");
});

test("an athlete who follows their reads carries no block at all", () => {
  resetTables("day_reads", "plan_days", "plan_items", "sessions", "logged_sets", "daily_metrics", "profile");
  const prompt = promptWith({
    byRead: [
      { ...EASY_STAT, followed: 5, diverged: 0 },
      { ...REST_STAT, followed: 5, diverged: 0 },
    ],
    kind: "easy",
    signals: {},
  });
  assert.ok(!/HOW YOUR READS HAVE ACTUALLY LANDED/.test(prompt));
});
