// Round W2.2 — chat stops asking what the context already carries. Session
// timestamps already tell us when the athlete usually trains, so
// typicalTrainingHour() derives it (src/repo/sessions.ts), it's projected into
// the chat prompt site only (src/prompt/context-projection.ts), and chat's
// PROGRESSIVE UNDERSTANDING instruction now points at it instead of asking blind.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { buildChatPrompt, buildCoachPrompt } from "../dist/prompt.js";

beforeEach(() => resetTables("sessions", "logged_sets", "profile"));

function seedSessionAt(date, hour) {
  db.prepare(`INSERT INTO sessions (date, created_at) VALUES (?, ?)`).run(
    date,
    `${date} ${String(hour).padStart(2, "0")}:00:00`
  );
}

test("thin history reads as absent — never a guess", () => {
  seedSessionAt("2026-08-01", 18);
  seedSessionAt("2026-08-03", 19);
  assert.equal(repo.typicalTrainingHour(), null, "fewer than the floor stays null");
});

test("the most common hour wins, with a plain part-of-day label", () => {
  for (const [date, hour] of [
    ["2026-08-01", 18],
    ["2026-08-03", 18],
    ["2026-08-05", 18],
    ["2026-08-07", 7],
    ["2026-08-08", 18],
    ["2026-08-10", 12],
  ]) {
    seedSessionAt(date, hour);
  }
  const result = repo.typicalTrainingHour();
  assert.ok(result);
  assert.equal(result.hour, 18);
  assert.equal(result.label, "evening");
  assert.equal(result.sessions, 6);
});

test("the chat prompt carries typical_training_hour and instructs the model to consult DATA before asking", () => {
  for (const [date, hour] of [
    ["2026-08-01", 6],
    ["2026-08-03", 6],
    ["2026-08-05", 6],
    ["2026-08-07", 6],
    ["2026-08-09", 6],
  ]) {
    seedSessionAt(date, hour);
  }
  const prompt = buildChatPrompt([], "what's my plan today?");
  assert.match(prompt, /"typical_training_hour"/, "the derived field lands in DATA");
  assert.match(prompt, /"hour":6/, "with the actual derived hour");
  assert.match(prompt, /NEVER re-ask a fact already present anywhere in DATA/i);
  assert.match(prompt, /DATA\.typical_training_hour/, "the instruction names the key it must consult");
});

test("typical_training_hour is chat-only — the coach/plan prompt does not carry it", () => {
  for (const [date, hour] of [
    ["2026-08-01", 6],
    ["2026-08-03", 6],
    ["2026-08-05", 6],
    ["2026-08-07", 6],
    ["2026-08-09", 6],
  ]) {
    seedSessionAt(date, hour);
  }
  const prompt = buildCoachPrompt();
  assert.doesNotMatch(prompt, /"typical_training_hour"/, "no other prompt site earns a key only chat's text reads");
});
