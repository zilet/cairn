// The real safety property of the per-turn action gates, end to end: a whole stored turn
// driven through runQueuedChatTurn (the worker the PWA's POST /api/chat enqueues for),
// with a fake agent that answers with the gated action. When the athlete says yes to the
// coach's own offer, the prompt the agent was sent OFFERED the action's shape AND the
// server applied it; with no intent the prompt neither offers the shape nor does the
// server apply what the agent emitted anyway. Offline: the fake agent never spawns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { runQueuedChatTurn } from "../dist/chatTurns.js";

const SAMPLE = {
  set_training_drive: { type: "set_training_drive", drive: "push", scope: "block" },
  set_nutrition_target: { type: "set_nutrition_target", target_kcal: 2100 },
  plan_restructure: {
    type: "plan_restructure",
    summary: "Two-day split",
    days: [
      {
        day_number: 1,
        name: "Upper",
        focus: "Upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
      },
    ],
  },
  flag_training_structure: { type: "flag_training_structure", request: "Track all six lifts", summary: "Six anchors" },
};

// [athlete's opener, the coach's offer, the athlete's yes, the gated action]
const YES = [
  [
    "Should I push harder through this block?",
    "Your log says you're carrying this with room to spare — want me to open the throttle for the next few weeks?",
    "yes do it",
    "set_training_drive",
  ],
  ["should I eat more?", "Want me to set your daily target to 2,100 kcal?", "yes, do it", "set_nutrition_target"],
  [
    "my week feels crowded",
    "Want me to move you to a two-day upper/lower split? Want me to set it up?",
    "yes, do it",
    "plan_restructure",
  ],
  ["I want to train all six anchors", "Want me to flag that for you?", "yes please", "flag_training_structure"],
];

async function driveTurn(history, message, action) {
  repo.savePlanDay(1, "Full Body", "strength", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  repo.setSettings({ chat_context: "lean" });
  for (const [role, content] of history) repo.addChatMessage(role, content, role === "assistant" ? "stub" : undefined);
  const userMessage = repo.addChatMessage("user", message);
  const turn = repo.createChatTurn({ message, user_message_id: userMessage.id, agent: "stub" });
  const prompts = [];
  const raw = `===CAIRN_REPLY===\nOk.\n===CAIRN_ACTIONS===\n${JSON.stringify({ actions: [action] })}`;
  const fake = async (_name, prompt, opts) => {
    prompts.push(prompt);
    opts?.onDelta?.(raw);
    return { code: 0, raw, stderr: "", usage: {} };
  };
  await runQueuedChatTurn(turn.id, {
    runAgent: fake,
    runAgentStreaming: fake,
    supportsStream: () => false,
    resolveReadTransport: () => ({ transport: "prompt_loop" }),
  });
  const done = repo.getChatTurn(turn.id);
  assert.equal(done?.status, "done", `the turn finished: ${done?.status}`);
  const reply = done.assistant_message_id ? repo.getChatMessage(done.assistant_message_id) : null;
  return { prompts, applied: reply?.meta?.applied ?? [] };
}

const offers = (prompts, type) => prompts.length > 0 && prompts.every((p) => p.includes(`"type": "${type}"`));
const lands = (applied, type) =>
  applied.some((entry) => entry.type === type && !entry.error && entry.result?.ok !== false);

for (const [opener, offer, yes, type] of YES) {
  test(`a yes to the coach's offer: ${type} is offered in the prompt and applied by the server`, async () => {
    const { prompts, applied } = await driveTurn(
      [
        ["user", opener],
        ["assistant", offer],
      ],
      yes,
      SAMPLE[type]
    );
    assert.ok(offers(prompts, type), `${type}: the prompt carried its shape`);
    assert.ok(lands(applied, type), `${type}: the server applied it — ${JSON.stringify(applied).slice(0, 300)}`);
  });

  test(`no intent: ${type} is neither offered nor applied`, async () => {
    const { prompts, applied } = await driveTurn(
      [
        ["user", "How did my week go?"],
        ["assistant", "Solid week — three sessions and a long run."],
      ],
      "What should I focus on next week?",
      SAMPLE[type]
    );
    assert.ok(prompts.length > 0);
    assert.ok(!prompts.some((p) => p.includes(`"type": "${type}"`)), `${type}: no shape on offer`);
    assert.ok(
      prompts.every((p) => p.includes(`- ${type}:`)),
      `${type}: its NOT ON OFFER line stands in for the shape`
    );
    assert.ok(!lands(applied, type), `${type}: the server refused what the agent emitted anyway`);
  });
}
