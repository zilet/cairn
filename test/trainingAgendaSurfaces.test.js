import { test } from "node:test";
import assert from "node:assert/strict";
import { programRouter } from "../dist/routes/program.js";
import { registerProgramTools } from "../dist/surfaces/mcp/program.js";
import { flexibleTrainingAgenda } from "../dist/repo/flexible-training-agenda.js";

function restAgenda(date) {
  const layer = programRouter.stack.find((entry) => entry.route?.path === "/training-agenda");
  assert.ok(layer, "REST training-agenda route is registered");
  const handler = layer.route.stack[0].handle;
  let value;
  handler({ query: { date } }, { json: (body) => { value = body; } });
  return value;
}

async function mcpAgenda(date) {
  const tools = new Map();
  registerProgramTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  const handler = tools.get("get_training_agenda");
  assert.ok(handler, "MCP get_training_agenda tool is registered");
  const response = await handler({ date });
  return JSON.parse(response.content[0].text);
}

test("REST and MCP expose the same deterministic rolling training agenda", async () => {
  const date = "2026-07-28";
  const expected = flexibleTrainingAgenda(date);
  assert.deepEqual(restAgenda(date), expected);
  assert.deepEqual(await mcpAgenda(date), expected);
});
