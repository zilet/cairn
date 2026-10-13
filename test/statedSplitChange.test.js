// The SPLIT they named rides the stated lifting week, and it is the person's to change.
// Chat and MCP can set it, change it alone ("I'm moving to PPL") or clear it; clearing
// the lifting days clears it too. The check against it is a WARNING where plan quality
// is read (getPlanQuality, an applied proposal's `quality`), never a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { CHAT_ACTION_PROMPT_SPECS, normalizeChatAction, renderChatActionPromptProse } from "../dist/chatActions.js";
import { registerTrainingStatusTools } from "../dist/surfaces/mcp/training-status.js";
import { registerPersonTools } from "../dist/surfaces/mcp/person.js";
import { getStrengthSchedule, setProfile } from "../dist/repo/profile.js";

const LIFT_DAYS = [{ dow: 1 }, { dow: 2 }, { dow: 4 }, { dow: 5 }];
const plain = (value) => JSON.parse(JSON.stringify(value));

function tools(register) {
  const map = new Map();
  register({ tool: (name, _d, schema, handler) => map.set(name, { schema, handler }) });
  // Parse through the tool's own zod shape, as the MCP server does: a key the schema
  // does not name is stripped before the handler ever sees it.
  return async (name, args) => {
    const { schema, handler } = map.get(name);
    const parsed = z.object(schema).parse(args);
    return JSON.parse((await handler(parsed)).content[0].text);
  };
}

// ---------- the split ----------

test("chat can change the split in words, alone, and clear it; the weekdays stand", () => {
  setProfile({ strength_schedule: { days: LIFT_DAYS, split: "upper/lower", source: "chat" } });
  const action = normalizeChatAction({ type: "set_strength_schedule", split: "push/pull/legs" });
  assert.deepEqual(plain(action), { type: "set_strength_schedule", split: "push/pull/legs" });
  const moved = applyChatActions(
    { actions: [{ type: "set_strength_schedule", split: "push/pull/legs" }] },
    { agent: "stub", message: "I'm moving to PPL" }
  );
  assert.equal(moved.applied[0]?.error, undefined);
  assert.equal(getStrengthSchedule().split, "push/pull/legs");
  assert.deepEqual(
    getStrengthSchedule().days.map((d) => d.dow),
    [1, 2, 4, 5],
    "a split-only turn keeps the stated weekdays"
  );

  // Weekdays restated without a split keep it.
  applyChatActions(
    { actions: [{ type: "set_strength_schedule", days: [{ dow: 1 }, { dow: 3 }, { dow: 5 }] }] },
    { agent: "stub", message: "I lift Mon/Wed/Fri now" }
  );
  assert.equal(getStrengthSchedule().split, "push/pull/legs");

  // An explicit null clears it.
  applyChatActions(
    { actions: [{ type: "set_strength_schedule", split: null }] },
    { agent: "stub", message: "no set split any more, you pick" }
  );
  assert.equal(getStrengthSchedule().split, undefined);
  assert.deepEqual(
    getStrengthSchedule().days.map((d) => d.dow),
    [1, 3, 5]
  );
});

test("a split with no stated lifting weekdays is not stored by chat", () => {
  const out = applyChatActions(
    { actions: [{ type: "set_strength_schedule", split: "upper/lower" }] },
    { agent: "stub", message: "I do upper/lower" }
  );
  assert.match(String(out.applied[0]?.error ?? ""), /weekdays/);
  assert.equal(getStrengthSchedule(), null);
});

test("the chat contract describes the split, so a turn can carry it", () => {
  const entry = CHAT_ACTION_PROMPT_SPECS.set_strength_schedule;
  assert.match(entry.shape, /"split"/);
  assert.ok(entry.guidance.some((line) => /moving to PPL/.test(line)));
  assert.match(renderChatActionPromptProse(["set_strength_schedule"]), /moving to PPL/);
});

test("clearing the lifting days clears the split with them", () => {
  setProfile({ strength_schedule: { days: LIFT_DAYS, split: "upper/lower", source: "chat" } });
  applyChatActions(
    { actions: [{ type: "set_strength_schedule", days: [] }] },
    { agent: "stub", message: "forget my lifting days" }
  );
  const cleared = getStrengthSchedule();
  assert.equal(cleared.days.length, 0);
  assert.equal(cleared.split, undefined);
});

test("MCP set_strength_schedule and set_profile carry the split (set, change alone, clear)", async () => {
  const call = tools(registerTrainingStatusTools);
  await call("set_strength_schedule", { days: LIFT_DAYS, split: "upper/lower" });
  assert.equal(getStrengthSchedule().split, "upper/lower");
  await call("set_strength_schedule", { split: "full body" });
  assert.equal(getStrengthSchedule().split, "full body");
  assert.equal(getStrengthSchedule().days.length, 4, "a split-only call keeps the weekdays");
  await call("set_strength_schedule", { days: LIFT_DAYS });
  assert.equal(getStrengthSchedule().split, "full body", "omitted keeps it");
  await call("set_strength_schedule", { days: LIFT_DAYS, split: null });
  assert.equal(getStrengthSchedule().split, undefined);

  const profile = tools(registerPersonTools);
  await profile("set_profile", { strength_schedule: { days: LIFT_DAYS, split: "push/pull/legs" } });
  assert.equal(getStrengthSchedule().split, "push/pull/legs", "the set_profile schema no longer strips it");
  await profile("set_profile", { strength_schedule: { days: [] } });
  assert.equal(getStrengthSchedule().split, undefined, "days: [] clears the split too");
});

test("plan quality as read carries the stated split as a warning, never an error", () => {
  const day = (day_number, name, exercise) => ({
    day_number,
    name,
    focus: name.toLowerCase(),
    items: [{ exercise, sets: 3, rep_low: 6, rep_high: 10 }],
  });
  repo.replacePlan([
    day(1, "Upper A", "Barbell Bench Press"),
    day(2, "Upper B", "Pull-Up"),
    day(3, "Lower", "Back Squat"),
    day(4, "Upper C", "Overhead Press"),
  ]);
  assert.ok(!repo.getPlanQuality().warnings.some((w) => w.code === "stated_split"), "no split, no check");
  setProfile({ strength_schedule: { days: LIFT_DAYS, split: "upper/lower", source: "chat" } });
  const report = repo.getPlanQuality();
  assert.ok(report.warnings.some((w) => w.code === "stated_split"));
  assert.ok(!report.errors.some((e) => e.code === "stated_split"));
});
