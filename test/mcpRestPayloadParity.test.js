// MCP ⊆ REST is not just "the same tool exists" — the two surfaces must hand back the
// SAME payload. Two tools had quietly drifted to a thinner one than their route:
// finish_session returned the bare repo result (no rotated "done" headline) while
// POST /sessions/:id/finish returned finishSessionWithHeadline, and get_plan returned
// getPlan() while GET /plan returned getPlanWithPurpose(). Both are invisible in a
// source-text parity check (surfaceParity.test.js) because the tool names match.
//
// These cases call the MCP handler and the REST handler for real and compare.
import test from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { dayReadHeadline } from "../dist/repo/day-read.js";
import { planExercisesRouter } from "../dist/routes/plan-exercises.js";
import { trainingLogRouter } from "../dist/routes/training-log.js";
import { registerPlanExerciseTools } from "../dist/surfaces/mcp/plan-exercises.js";
import { registerTrainingLogTools } from "../dist/surfaces/mcp/training-log.js";

function mcpHandlers(register) {
  const handlers = new Map();
  register({
    tool(name, ...args) {
      handlers.set(name, args.at(-1));
    },
  });
  return handlers;
}

const mcpBody = async (handler, args = {}) => JSON.parse((await handler(args)).content[0].text);

function callRoute(router, method, path, { body = {}, params = {} } = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
  assert.ok(layer, `missing ${method.toUpperCase()} ${path}`);
  let status = 200;
  let payload;
  const res = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  layer.route.stack.at(-1).handle({ body, params }, res);
  return { status, payload };
}

test("MCP get_plan returns the same purpose-carrying plan as GET /plan", async () => {
  repo.replacePlanChecked([
    {
      day_number: 1,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
    },
  ]);

  const rest = callRoute(planExercisesRouter, "get", "/plan").payload;
  const tool = await mcpBody(mcpHandlers(registerPlanExerciseTools).get("get_plan"));

  assert.ok(rest.length >= 1, "fixture plan should have at least one day");
  assert.deepEqual(tool, rest);
  for (const day of tool) {
    assert.ok("purpose" in day, `MCP get_plan day ${day.day_number} must carry the grounded purpose line`);
  }
});

test("MCP finish_session returns the same headline-carrying summary as POST /sessions/:id/finish", async () => {
  const date = "2032-04-11";
  repo.logSetByName({ date, exercise: "Parity Squat", weight: 135, reps: 5, day_number: null });
  const session = repo.getSessionByDate(date);
  assert.ok(session?.id, "logging a set creates that date's session");

  const tool = await mcpBody(mcpHandlers(registerTrainingLogTools).get("finish_session"), { id: session.id });
  assert.equal(tool.headline, dayReadHeadline({ kind: "done" }, date));
  assert.ok(typeof tool.headline === "string" && tool.headline.trim().length > 0);

  // The route's normalization too: a whitespace-only note is no note, so it can never
  // overwrite a saved one (finishSession COALESCEs — only NULL preserves).
  repo.updateSessionNotes(session.id, "felt strong");
  repo.reopenSession(session.id);
  const blank = await mcpBody(mcpHandlers(registerTrainingLogTools).get("finish_session"), {
    id: session.id,
    notes: "   ",
  });
  assert.equal(blank.notes ?? repo.getSessionDetail(session.id).notes, "felt strong");

  repo.reopenSession(session.id);
  const rest = callRoute(trainingLogRouter, "post", "/sessions/:id/finish", {
    body: {},
    params: { id: String(session.id) },
  }).payload;
  assert.equal(rest.headline, tool.headline, "both surfaces speak the same rotated done headline");
});
