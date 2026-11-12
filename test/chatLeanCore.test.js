// Chat's lean core (src/prompt/context-projection.ts "chat_core", settings.chat_context):
// the coach always knows who the athlete is, today and this week, and READS the rest.
// These pin (1) what the core carries and what it leaves out, (2) its size on the demo
// seed, (3) that "full" is the previous block and wording exactly, and (4) the contract
// that every key the core leaves out maps to a catalog read that actually returns it —
// so adding a key to the chat site forces a decision. Deterministic + offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import * as repo from "../dist/repo.js";
import { buildChatPrompt } from "../dist/prompt.js";
import {
  CHAT_CORE_MOVED_KEYS,
  CHAT_CORE_PARTIAL_KEYS,
  PROMPT_CONTEXT_SITES,
} from "../dist/prompt/context-projection.js";
import { COACH_READ_TOOL_NAMES } from "../dist/brain/read-tools.js";
import { executeCoachReadTool } from "../dist/brain/read-tool-runtime.js";
import { chatReadPromptSuffix, newChatReadState } from "../dist/chatTurns.js";
import { chatNativeReadContract } from "../dist/chat-reads.js";

function dataOf(prompt) {
  const at = prompt.lastIndexOf("\nDATA:\n");
  assert.ok(at >= 0);
  const text = prompt.slice(at + "\nDATA:\n".length);
  return { text, parsed: JSON.parse(text) };
}

const CORE_REQUIRED = [
  "profile",
  "memory",
  "context_events",
  "goal",
  "journey",
  "training_intent",
  "training_drive",
  "movement_considerations",
  "day_read",
  "signal_state",
  "coaching_focus",
  "day_intake",
  "recent_activities",
  "recent_sessions",
  "plan",
  "dated_week",
  "run_plan",
  "flexible_training_agenda",
  "week_training_load",
  "recent_decisions",
  "supplements",
];

test("the lean core keeps who they are, today and this week, and leaves history to the reads", () => {
  seedDemo();
  const { parsed } = dataOf(buildChatPrompt([], "What did I burn today?", undefined, { lane: "coach" }));
  for (const key of CORE_REQUIRED) assert.ok(Object.hasOwn(parsed, key), `core keeps ${key}`);
  for (const key of Object.keys(CHAT_CORE_MOVED_KEYS)) assert.ok(!Object.hasOwn(parsed, key), `core leaves ${key} to a read`);
  // Today's sets and the session before them, whole; the rest of the log is a read.
  assert.ok(parsed.recent_sessions.length <= 2);
  assert.ok(parsed.recent_sessions.every((s) => Array.isArray(s.sets)));
  // What the Brief said, not its signals blob.
  if (parsed.day_read && typeof parsed.day_read === "object") {
    assert.ok(!Object.hasOwn(parsed.day_read, "signals"));
    assert.ok(Object.hasOwn(parsed.day_read, "kind"));
  }
  // Every plan day keeps the names a plan_update needs.
  assert.ok(parsed.plan.every((day) => Number.isInteger(day.day_number) && day.items.every((i) => i.exercise)));
  // Only decisions still pending or undoable (revert_decision names its id from here).
  assert.ok(parsed.recent_decisions.every((d) => d.reversible === true || ["pending", "announced", "review"].includes(d.status)));
  // Memory ids survive (update_memory / supersede_memory name them).
  assert.ok(parsed.memory.every((m) => Number.isInteger(m.id) && m.content));
});

test("the lean DATA block stays under 30 KB on the demo seed", () => {
  seedDemo();
  const lean = dataOf(buildChatPrompt([], "How has my squat moved?", undefined, { lane: "coach" }));
  const full = dataOf(buildChatPrompt([], "How has my squat moved?", undefined, { lane: "coach", context: "full" }));
  const leanBytes = Buffer.byteLength(lean.text, "utf8");
  const fullBytes = Buffer.byteLength(full.text, "utf8");
  assert.ok(leanBytes <= 30 * 1024, `lean DATA is ${leanBytes} bytes`);
  assert.ok(leanBytes * 3 < fullBytes, `lean (${leanBytes}) is a fraction of full (${fullBytes})`);
});

test("chat_context 'full' reproduces the previous key set and the original wording", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  const prompt = buildChatPrompt([], "how did my week go?", undefined, { context: "full" });
  const { parsed } = dataOf(prompt);
  const expected = [...PROMPT_CONTEXT_SITES.chat.keys.filter((key) => Object.hasOwn(ctx, key)), "dated_week"];
  assert.deepEqual(Object.keys(parsed).sort(), [...new Set(expected)].sort());
  assert.match(prompt, /You can SEE all their data \(DATA section\)/);
  assert.match(prompt, /look for it — the blocks below and DATA\. When it is there/);
  assert.match(prompt, /DATA\.day_intake \/ DATA\.meal_plan/);
  // And the original read contract, word for word.
  const suffix = chatReadPromptSuffix(newChatReadState(), false, "full");
  assert.match(suffix, /The DATA above is your authoritative baseline/);
  assert.match(suffix, /Do not fish/);

  const lean = buildChatPrompt([], "how did my week go?");
  assert.doesNotMatch(lean, /You can SEE all their data/);
  assert.match(lean, /the COACH READS reach the rest/);
});

test("the lean contracts say to look it up — and never to call data missing without reading", () => {
  const loop = chatReadPromptSuffix(newChatReadState(), false, "lean");
  const native = chatNativeReadContract();
  for (const text of [loop, native]) {
    assert.match(text, /LOOK IT UP before you answer/);
    assert.match(text, /Never say something is missing, "not visible" or "hasn't synced" without having read for it first/);
    assert.match(text, /Do not read for what the core or the blocks (?:above|below) already answer/);
    assert.doesNotMatch(text, /authoritative baseline|Do not fish/);
  }
  // The prompt loop keeps its bare-JSON protocol; the native contract is plain tool use.
  assert.match(loop, /\{"kind":"coach_read","requests":/);
  assert.doesNotMatch(native, /"kind":"coach_read"/);
  assert.match(native, /the reply marker, then prose/);
  // Positions: the loop's contract follows DATA; the native one sits ahead of it.
  assert.match(loop, /DATA above is the core/);
  assert.match(native, /DATA below is the core/);
  // The native contract NAMES the tools: their descriptions and argument schemas reach
  // the CLI over MCP, so the prompt does not repeat them.
  for (const name of COACH_READ_TOOL_NAMES) assert.match(native, new RegExp(`\\b${name}\\b`), `native names ${name}`);
  assert.doesNotMatch(native, /- read_[a-z_]+: /, "no per-tool description lines");
  assert.match(native, /At most \d+ reads for this reply/);
});

test("every coach/deep prompt carries the never-claim-missing rule exactly once, reads open or spent", () => {
  seedDemo();
  const RULE = /never say something is missing|never claim data is missing/gi;
  const count = (text) => (text.match(RULE) ?? []).length;
  const full = buildChatPrompt([], "did my run sync?", undefined, { context: "full" });
  const lean = buildChatPrompt([], "did my run sync?");
  const spent = { ...newChatReadState(), calls: 6 };
  const exhaustedLean = chatReadPromptSuffix(spent, true, "lean");
  const prompts = {
    "full, reads open": full + chatReadPromptSuffix(newChatReadState(), false, "full"),
    "full, reads spent": full + chatReadPromptSuffix(spent, true, "full"),
    "lean prompt loop, reads open": lean + chatReadPromptSuffix(newChatReadState(), false, "lean"),
    "lean prompt loop, reads spent": lean + exhaustedLean,
    "lean native": lean + chatNativeReadContract(),
  };
  for (const [name, prompt] of Object.entries(prompts)) assert.equal(count(prompt), 1, name);
  // Spent, the rule never asks for a read the model can no longer make.
  assert.match(
    exhaustedLean,
    /Never say something is missing, "not visible" or "hasn't synced" without it being absent from DATA and the blocks in this prompt/
  );
  assert.doesNotMatch(exhaustedLean, /read for it|LOOK IT UP|"kind":"coach_read"/);
});

// Where in a read's result a moved key lives (the context-slice reads return it at the
// top level; the window reads carry today's reads beside their rows).
function readCarries(result, key) {
  const data = result.data ?? {};
  return [data, data.current, data.summary].some((obj) => obj && typeof obj === "object" && Object.hasOwn(obj, key));
}

const ARGS = {
  read_nutrition_window: { end_date: null, days: 7 },
  read_recovery_window: { end_date: null, days: 14 },
  read_body_composition_history: { limit: 20 },
  read_training_window: { end_date: null, weeks: 2 },
  read_decision_history: { kind: null, subject_key: null, limit: 10 },
  read_current_plan_detail: { scope: "training", day_number: 1 },
};

test("every key the core drops maps to a catalog read that returns it", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  const chatKeys = PROMPT_CONTEXT_SITES.chat.keys;
  const coreKeys = new Set(PROMPT_CONTEXT_SITES.chat_core.keys);
  // The map is whole: each full-site key is either kept or mapped, never neither.
  for (const key of chatKeys) {
    assert.ok(coreKeys.has(key) || Object.hasOwn(CHAT_CORE_MOVED_KEYS, key), `${key} is kept or has a read`);
    assert.ok(!(coreKeys.has(key) && Object.hasOwn(CHAT_CORE_MOVED_KEYS, key)), `${key} is not both kept and moved`);
  }
  for (const [key, tool] of [...Object.entries(CHAT_CORE_MOVED_KEYS), ...Object.entries(CHAT_CORE_PARTIAL_KEYS)]) {
    assert.ok(COACH_READ_TOOL_NAMES.includes(tool), `${key} → ${tool} is a catalog read`);
  }
  for (const key of Object.keys(CHAT_CORE_PARTIAL_KEYS)) assert.ok(coreKeys.has(key), `partial ${key} is in the core`);

  // And the read really returns the block (the seed carries most of them).
  const results = new Map();
  const run = (tool) => {
    if (!results.has(tool)) {
      results.set(tool, executeCoachReadTool({ tool, args: ARGS[tool] ?? {} }, { run_id: "lean-core-map", op: "chat" }));
    }
    return results.get(tool);
  };
  // Printed whole above DATA rather than returned by key: the run block's own lines.
  const RENDERED = new Set(["recent_cardio"]);
  for (const [key, tool] of Object.entries(CHAT_CORE_MOVED_KEYS)) {
    if (RENDERED.has(key) || !Object.hasOwn(ctx, key)) continue;
    assert.ok(readCarries(run(tool), key), `${tool} carries ${key}`);
  }
});

test("the new reads are bounded, read-only and within their byte budgets", () => {
  seedDemo();
  for (const tool of ["read_run_week", "read_health_summary", "read_strength_progress", "read_goal_progress"]) {
    const result = executeCoachReadTool({ tool, args: { anything: "ignored" } }, { run_id: "new-reads", op: "chat" });
    assert.equal(result.tool, tool);
    assert.equal(typeof result.data.as_of, "string");
    assert.ok(!Object.hasOwn(result.data, "anything"), "no argument is ever echoed");
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes > 100, `${tool} returns something (${bytes} bytes)`);
  }
  const health = executeCoachReadTool({ tool: "read_health_summary" }, { run_id: "new-reads", op: "chat" });
  assert.ok(Object.hasOwn(health.data, "health_focus") && Object.hasOwn(health.data, "directives"));
  const strength = executeCoachReadTool({ tool: "read_strength_progress", args: {} }, { run_id: "new-reads", op: "chat" });
  assert.ok(Object.hasOwn(strength.data, "program_state") && Object.hasOwn(strength.data, "progression"));
  // The recent decision ledger: neither filter is now a valid read.
  const recent = executeCoachReadTool(
    { tool: "read_decision_history", args: { kind: null, subject_key: null, limit: 5 } },
    { run_id: "new-reads", op: "chat" }
  );
  assert.ok(recent.data.decisions.length > 0 && recent.data.decisions.length <= 5);
  // The context the slices are cut from is never mutated by a read's byte trimming.
  const before = JSON.stringify(repo.getCoachContext().program_state);
  executeCoachReadTool({ tool: "read_strength_progress", args: {} }, { run_id: "new-reads", op: "chat" });
  assert.equal(JSON.stringify(repo.getCoachContext().program_state), before);
});

test("the safety reads stay inline: underfueling's verdict, the review's watchlist, a directive's citation", () => {
  seedDemo();
  const { parsed } = dataOf(buildChatPrompt([], "Should I eat more?", undefined, { lane: "coach" }));
  // FUEL_CLAIM_RULE permits the protective claim only from DATA.underfueling.state.
  assert.equal(typeof parsed.underfueling.state, "string");
  assert.ok(!Object.hasOwn(parsed.underfueling, "channels"), "the per-channel evidence is read_nutrition_window's");
  // The review's focus and watchlist actions, capped; the rest is read_health_summary.
  assert.ok(parsed.health_review.watchlist.length > 0 && parsed.health_review.watchlist.length <= 6);
  assert.ok(parsed.health_review.watchlist.every((w) => w.marker && w.action));
  assert.ok(!Object.hasOwn(parsed.health_review, "followups"));
  // Whether a directive is cited is what makes it a firm rule or a softer nudge.
  assert.ok(parsed.directives.length > 0);
  assert.ok(parsed.directives.every((d) => typeof d.cited === "boolean"));
  assert.ok(parsed.directives.some((d) => d.cited === true));
});

test("plan items keep their note and warm-ups, so a restructure written from the core cannot drop them", () => {
  seedDemo();
  const ctx = repo.getCoachContext();
  const { parsed } = dataOf(buildChatPrompt([], "Restructure my week", undefined, { lane: "coach" }));
  const notes = ctx.plan.flatMap((d) => d.items).filter((i) => i.note).length;
  assert.ok(notes > 0);
  assert.equal(parsed.plan.flatMap((d) => d.items).filter((i) => i.note).length, notes);
});

// Every key the lean prompt's own words point at must be in lean DATA — unless the
// sentence names the read that returns it. Scans the BUILT prompt (chat text, the shared
// guardrails, the action prose), so a fragment edited anywhere is held here.
test("lean prompt text never names a DATA key the lean core does not carry (unless it names its read)", () => {
  seedDemo();
  const prompt = buildChatPrompt([], "How did my week go?", undefined, { lane: "coach" });
  const at = prompt.lastIndexOf("\nDATA:\n");
  const text = prompt.slice(0, at);
  const data = JSON.parse(prompt.slice(at + "\nDATA:\n".length));
  const contextKeys = new Set([...PROMPT_CONTEXT_SITES.chat.keys, "dated_week"]);
  const missing = [];
  for (const line of text.split("\n")) {
    if (/\bread_[a-z_]+/.test(line)) continue; // the sentence names its read
    for (const m of line.matchAll(/DATA\.([a-z_]+)/g)) if (!Object.hasOwn(data, m[1])) missing.push(`DATA.${m[1]}: ${line.trim().slice(0, 100)}`);
    if (/\bDATA\b|\bdata\b|\barray\b/.test(line)) {
      for (const m of line.matchAll(/"([a-z_]+)"/g)) {
        if (contextKeys.has(m[1]) && !Object.hasOwn(data, m[1])) missing.push(`"${m[1]}": ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(missing, []);
  // The full context keeps the original guardrail text, word for word.
  const full = buildChatPrompt([], "How did my week go?", undefined, { lane: "coach", context: "full" });
  assert.match(full, /PERSONAL-CONTEXT GUARDRAILS \(use the "context_events" and "health" data\):/);
  assert.match(full, /lacking a citation is a softer nudge/);
  assert.match(prompt, /with "cited": false is a softer nudge/);
  assert.match(prompt, /IMAGING: not in DATA — read_health_summary returns the "imaging" array/);
});

test("a context slice sheds a large non-array block before trimming its rows", async () => {
  const { finalizeCoachRead } = await import("../dist/brain/read-tool-runtime.js");
  const { COACH_READ_TOOL_CATALOG } = await import("../dist/brain/read-tools.js");
  const rows = Array.from({ length: 40 }, (_, i) => ({ n: i, label: "a small row" }));
  const raw = {
    data: { as_of: "2026-11-11", journey: { blob: "x".repeat(90_000) }, insights: rows },
    row_arrays: [rows],
    droppable_keys: ["journey", "insights"],
  };
  const result = finalizeCoachRead("read_goal_progress", raw);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= COACH_READ_TOOL_CATALOG.read_goal_progress.max_response_bytes);
  assert.deepEqual(result.data.omitted, ["journey"], "the oversized block went, named");
  assert.equal(result.data.insights.length, 40, "every row survived");
  assert.equal(result.rows_returned, 40);
  assert.equal(result.truncated, true);
});

test("a restructure that omits a lift's note or warm-ups keeps the stored ones", async () => {
  const { carryForwardPlanItemFields } = await import("../dist/chatTurns.js");
  const current = [
    { day_number: 1, items: [{ exercise: "Back Squat", note: "Top of range x3 before +5", warmup_sets: 2 }] },
    { day_number: 2, items: [{ exercise: "Bench Press", note: "Pause the first rep", warmup_sets: 1 }] },
  ];
  const incoming = [
    { day_number: 1, items: [{ exercise: "Back Squat", sets: 4 }, { exercise: "bench press", sets: 3, note: null }] },
    { day_number: 3, items: [{ exercise: "Deadlift", sets: 3 }] },
  ];
  const out = carryForwardPlanItemFields(incoming, current);
  assert.deepEqual(out[0].items[0], { exercise: "Back Squat", sets: 4, note: "Top of range x3 before +5", warmup_sets: 2 });
  // Moved to another day it is still the same lift; an explicit null is the athlete's clearing.
  assert.deepEqual(out[0].items[1], { exercise: "bench press", sets: 3, note: null, warmup_sets: 1 });
  assert.deepEqual(out[1].items[0], { exercise: "Deadlift", sets: 3 }, "a new lift gets nothing invented");
  assert.deepEqual(incoming[0].items[0], { exercise: "Back Squat", sets: 4 }, "the input is not mutated");
});
