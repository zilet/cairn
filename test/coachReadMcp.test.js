import { test } from "node:test";
import assert from "node:assert/strict";
import { COACH_READ_TOOL_NAMES } from "../dist/brain/read-tools.js";
import { coachReadMcpConfigArgs, registerCoachReadTools, startCoachReadMcpListener } from "../dist/coachReadMcp.js";

test("capability MCP registers exactly the closed read catalog", () => {
  const names = [];
  const fake = {
    tool(name, _description, _schema, _handler) {
      names.push(name);
    },
  };
  registerCoachReadTools(fake, { run_id: "test" });
  assert.deepEqual(names.sort(), [...COACH_READ_TOOL_NAMES].sort());
  assert.ok(names.every((name) => /^read_/.test(name)));
  assert.ok(!names.some((name) => /set|update|delete|log|apply|sync|draft|generate|agent/i.test(name)));
});

test("Claude MCP args use one strict per-run loopback config", () => {
  const args = coachReadMcpConfigArgs({ url: "http://127.0.0.1:43210/mcp/one-time-token" });
  assert.equal(args[0], "--mcp-config");
  assert.equal(args[2], "--strict-mcp-config");
  const config = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(config.mcpServers), ["cairn-coach-read"]);
  assert.equal(config.mcpServers["cairn-coach-read"].url, "http://127.0.0.1:43210/mcp/one-time-token");
});

test("capability listener binds loopback with an unguessable per-run path", async () => {
  let listener;
  try {
    listener = await startCoachReadMcpListener({ run_id: "test", ttlMs: 5_000 });
  } catch (error) {
    // Some deterministic test sandboxes deny every listen(2), including loopback.
    // The registration/authorization surface is still covered above; release smoke
    // runs this branch where local sockets are permitted.
    if (error?.code === "EPERM" || error?.code === "EACCES") return;
    throw error;
  }
  try {
    const url = new URL(listener.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(url.pathname.endsWith(listener.token));
    assert.ok(listener.token.length >= 30);
    const denied = await fetch(`http://127.0.0.1:${url.port}/mcp/wrong-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 404);
  } finally {
    await listener.close();
  }
});
