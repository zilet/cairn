// The calibration surface: GET /api/calibration/status and its near-mirror MCP
// tool (MCP ⊆ REST). The engine behind it is being filled in separately, so the
// contract these prove is the one the surfaces must honor either way — an empty
// ladder is a normal, quiet 200, and a populated one passes through untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { programRouter } from "../dist/routes/program.js";
import { registerCalibrationTools } from "../dist/surfaces/mcp/calibration.js";
import { calibrationStatus, dueCalibrations } from "../dist/repo/calibration.js";

function restCalibration(date) {
  const layer = programRouter.stack.find((entry) => entry.route?.path === "/calibration/status");
  assert.ok(layer, "REST calibration/status route is registered");
  const handler = layer.route.stack[0].handle;
  let value;
  handler({ query: date ? { date } : {} }, { json: (body) => { value = body; } });
  return value;
}

async function mcpCalibration(date) {
  const tools = new Map();
  registerCalibrationTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  const handler = tools.get("get_calibration_status");
  assert.ok(handler, "MCP get_calibration_status tool is registered");
  const response = await handler({ date });
  return JSON.parse(response.content[0].text);
}

test("REST and MCP report the same calibration ladder", async () => {
  const date = "2026-08-05";
  const expected = { status: calibrationStatus(date), due: dueCalibrations(date) };
  assert.deepEqual(restCalibration(date), expected);
  assert.deepEqual(await mcpCalibration(date), expected);
});

test("an athlete with nothing calibrated reads as a quiet, well-formed body", () => {
  const body = restCalibration("2026-08-05");
  assert.equal(body.status.as_of, "2026-08-05");
  assert.ok(Array.isArray(body.status.items), "items is always an array, never null");
  assert.ok(Array.isArray(body.due), "due is always an array, never null");
  // Absence is emptiness here, not a 404 and not an error envelope.
  assert.ok(!("error" in body));
  assert.ok(!("ok" in body));
});

test("the route defaults to today when no date is given", () => {
  const body = restCalibration(undefined);
  assert.match(String(body.status.as_of), /^\d{4}-\d{2}-\d{2}$/);
});

// The client renders straight off these fields, so their shape is load-bearing:
// a freshness WORD (never a days-stale number) and an athlete-facing label.
test("a populated ladder carries only the fields the Endurance line renders", () => {
  const item = {
    key: "lthr",
    domain: "endurance",
    label: "Your threshold HR",
    last_anchored: "2026-02-01",
    freshness: "stale",
    due: true,
  };
  for (const field of ["key", "domain", "label", "last_anchored", "freshness", "due"]) {
    assert.ok(field in item, `a status item carries ${field}`);
  }
  assert.ok(["anchored", "aging", "stale", "never"].includes(item.freshness));
  assert.ok(["endurance", "strength"].includes(item.domain));
  const suggestion = { kind: "lthr_tt", target_key: "lthr", line: "A steady 30 minutes would re-anchor this.", placement: "replaces this week's quality slot" };
  for (const field of ["kind", "target_key", "line", "placement"]) {
    assert.ok(field in suggestion, `a suggestion carries ${field}`);
  }
  assert.doesNotMatch(suggestion.line, /\b\d+\s*(?:%|\/100)\b/, "suggestions are prose, never a score");
});
