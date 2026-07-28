import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { registerPersonTools } from "../dist/surfaces/mcp/person.js";
import { personRouter } from "../dist/routes/person.js";
import { localDateISO } from "../dist/repo/shared.js";

function personTools() {
  const tools = new Map();
  registerPersonTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  return tools;
}

async function callTool(name, args = {}) {
  const handler = personTools().get(name);
  assert.ok(handler, `${name} is registered`);
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

function callTrainingIntentRoute(body) {
  const layer = personRouter.stack.find(
    (entry) => entry.route?.path === "/training-intent" && entry.route?.methods?.put
  );
  const handler = layer?.route?.stack[0]?.handle;
  assert.ok(handler, "PUT /training-intent is registered");
  let status = 200;
  let payload;
  handler(
    { body },
    {
      status(code) {
        status = code;
        return this;
      },
      json(value) {
        payload = value;
        return this;
      },
    }
  );
  return { status, payload };
}

beforeEach(() => {
  resetTables("profile", "activities", "brain_events");
});

test("MCP keeps durable priorities and MTB capability separate from a temporary race", async () => {
  repo.setProfile({
    age: 44,
    primary_discipline: "hybrid",
    endurance_sport: "running, MTB",
    endurance_goal: {
      mode: "race",
      event: "Cambridge Half Marathon",
      date: "2026-11-01",
      distance_km: 21.1,
    },
  });
  db.prepare(
    `INSERT INTO activities (date, type, raw_text, duration_min, distance_km, source)
     VALUES (?, 'ride', 'MTB ride in the Fells', 151, 30.4, 'manual')`
  ).run(localDateISO());

  const saved = await callTool("set_training_intent", {
    priorities: ["longevity", "muscle", "leanness", "endurance"],
    endurance_role: "supporting",
    endurance_capacity: {
      sport: "mountain biking",
      target_duration_min: 120,
      context: "long rides in the Fells",
    },
  });

  assert.deepEqual(saved.intent.priorities, ["longevity", "muscle", "leanness", "endurance"]);
  assert.equal(saved.intent.endurance_role, "supporting");
  assert.equal(saved.endurance_capacity.status, "ready");
  assert.equal(repo.getEnduranceGoal("2026-08-01").event, "Cambridge Half Marathon");

  const read = await callTool("get_training_intent");
  assert.equal(read.intent.source, "explicit");
  assert.equal(read.endurance_capacity.evidence.duration_min, 151);
});

test("set_training_intent requires a complete identity and clear restores legacy derivation", async () => {
  repo.setProfile({ primary_discipline: "strength", goal_mode: "gain" });
  const rejected = await callTool("set_training_intent", {
    priorities: ["muscle", "strength"],
  });
  assert.equal(rejected.ok, false);
  assert.equal(repo.getProfile().training_intent_json, null);

  await callTool("set_training_intent", {
    priorities: ["longevity", "muscle"],
    endurance_role: "none",
  });
  const cleared = await callTool("set_training_intent", { clear: true });
  assert.equal(cleared.intent.source, "derived");
  assert.equal(cleared.endurance_capacity, null);
  assert.equal(repo.getProfile().training_intent_json, null);
  assert.equal(repo.getTrainingIntent().source, "derived");
  assert.equal(repo.getTrainingIntent().endurance_role, "none");
});

test("an impossible race date cannot erase the valid event already on file", () => {
  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Cambridge Half Marathon",
      date: "2026-11-01",
    },
  });
  repo.setProfile({
    endurance_goal: {
      mode: "race",
      event: "Impossible race",
      date: "2026-02-30",
    },
  });
  const goal = repo.getEnduranceGoal("2026-08-01");
  assert.equal(goal.event, "Cambridge Half Marathon");
  assert.equal(goal.date, "2026-11-01");
});

test("REST accepts both wrapped null and bare null to clear explicit intent", () => {
  repo.setProfile({
    training_intent: {
      priorities: ["longevity", "muscle"],
      endurance_role: "none",
    },
  });
  const wrapped = callTrainingIntentRoute({ training_intent: null });
  assert.equal(wrapped.status, 200);
  assert.equal(wrapped.payload.intent.source, "derived");

  repo.setProfile({
    training_intent: {
      priorities: ["endurance", "longevity"],
      endurance_role: "primary",
    },
  });
  const bare = callTrainingIntentRoute(null);
  assert.equal(bare.status, 200);
  assert.equal(bare.payload.intent.source, "derived");
});
