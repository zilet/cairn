// The what-if (v2 wave 5, "Ask"): src/coachOps/whatif.ts.
//
//   - the read NEVER writes: every table's row count is identical before and after,
//     on the agentic path (a canned agent through the injected runner) and on the
//     offline `stub` floor;
//   - the enforced schema names every field the op reads, with closed word vocabularies;
//   - a dead rotation is the designed {ok:false, error, tried};
//   - "Do it" takes the what_if job and reads the change from its stored answer, writes
//     a DRAFT and routes it by the autonomy tier: a bounded training edit follows lead
//     mode, a clinical one is held clinician-directed, a calorie target waits on the
//     athlete (and can always be approved), a moved plan waits too, a goal is never
//     drafted, and a null count never removes a lift;
//   - REST and MCP are mirrors: same job kind and input, same do-it answer.
//
// Synthetic fixtures only.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { WHAT_IF_FLOOR_TABLE, whatIf, whatIfDo, whatIfFloor, normalizeWhatIfChange } from "../dist/coachOps.js";
import { WHAT_IF_SCHEMA, isWhatIfResult } from "../dist/agent-contracts.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";
import { buildWhatIfPrompt } from "../dist/prompt.js";
import { TODAY_STONE_ORDER } from "../dist/domain/today/today-stones.js";
import { dayCoachRouter } from "../dist/routes/day-coach.js";
import { registerDayCoachTools } from "../dist/surfaces/mcp/day-coach.js";

const STONE_KEYS = [...TODAY_STONE_ORDER];

function tableCounts() {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((row) => row.name);
  const out = {};
  for (const t of tables) out[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
  return out;
}

function seedPlan() {
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
  ]);
}

// A canned agent reply through the injected runner: the agentic path, offline.
function cannedRun(parsed) {
  return async (_agent, _prompt, opts) => {
    assert.equal(opts.op, "what_if", "the run is labelled with the what_if op");
    assert.equal(opts.schema, WHAT_IF_SCHEMA, "the enforced schema rides the call");
    assert.equal(opts.acceptParsed(parsed), true, "the canned reply passes the acceptance predicate");
    return { agent: "canned", result: { parsed, raw: JSON.stringify(parsed) }, tried: [] };
  };
}

const AGENT_ANSWER = {
  change: {
    kind: "training",
    summary: "Add one set to the bench on your push day.",
    changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 4, reason: "a little more pressing volume" }],
  },
  ripple: [
    {
      stone: "strength",
      direction: "helps",
      why: "One more set gives your pressing more to build on.",
      confidence: "likely",
    },
    { stone: "recovery", direction: "costs", why: "A little more work to recover from.", confidence: "possible" },
    { stone: "moon", direction: "helps", why: "Not a stone.", confidence: "likely" },
  ],
};

beforeEach(() => {
  repo.setSettings({ lead_mode: "lead" });
});

test("the schema names every field the op reads, with word-only vocabularies", () => {
  const change = WHAT_IF_SCHEMA.properties.change.properties;
  for (const field of ["kind", "summary", "changes", "nutrition"]) assert.ok(change[field], `change.${field} is named`);
  assert.ok(change.nutrition.properties.target_kcal && change.nutrition.properties.protein_g);
  const item = change.changes.items.properties;
  for (const field of [
    "day_number",
    "exercise",
    "swap",
    "remove",
    "sets",
    "rep_low",
    "rep_high",
    "target_weight",
    "target_seconds",
    "reason",
  ])
    assert.ok(item[field], `changes[].${field} is named`);
  const ripple = WHAT_IF_SCHEMA.properties.ripple.items.properties;
  for (const field of ["stone", "direction", "why", "confidence"])
    assert.ok(ripple[field], `ripple[].${field} is named`);
  assert.deepEqual(ripple.direction.enum, ["helps", "costs", "steady", "mixed"]);
  assert.deepEqual(ripple.confidence.enum, ["likely", "possible", "unsure"]);
  assert.equal(isWhatIfResult({ change: { kind: "training", summary: "x" }, ripple: [] }), true);
  // A graded "why" is not an answer the team can show.
  assert.equal(
    isWhatIfResult({
      change: { kind: "other", summary: "Run more." },
      ripple: [{ stone: "endurance", direction: "helps", why: "Your endurance scores 80/100.", confidence: "likely" }],
    }),
    false
  );
  assert.equal(
    isWhatIfResult({ change: { kind: "other", summary: "You must rest." }, ripple: [] }),
    false,
    "gate language fails"
  );
});

test("the what_if prompt site carries the six stones' reads and drops what was already said", () => {
  const keys = PROMPT_CONTEXT_SITES.what_if.keys;
  for (const key of ["plan", "race_build", "day_intake", "recovery", "directives", "signal_state", "road_ahead"])
    assert.ok(keys.includes(key), `what_if carries ${key}`);
  for (const key of ["garmin", "day_read", "recent_decisions", "insights"])
    assert.ok(!keys.includes(key), `what_if drops ${key}`);
  const prompt = buildWhatIfPrompt("What if I lifted three days instead of four?", {
    stones: [{ key: "strength", label: "Strength", word: "steady", tone: "ok", line: null }],
    hint: { area: "training", direction: "less" },
  });
  assert.match(prompt, /Strength \(strength\): "steady"/);
  assert.match(prompt, /area: training, direction: less/);
  const lines = prompt.split("\n");
  const at = lines.lastIndexOf("DATA:");
  const data = JSON.parse(lines[at + 1]);
  assert.ok(!Object.hasOwn(data, "garmin"), "DATA is the projected site, well-formed");
});

test("the agentic read returns a change and all six stones, and writes nothing", async () => {
  seedPlan();
  const before = tableCounts();
  const out = await whatIf("auto", { text: "What if I added a bench set?" }, undefined, {
    run: cannedRun(AGENT_ANSWER),
  });
  assert.deepEqual(tableCounts(), before, "the what-if never writes a row");

  assert.equal(out.ok, true);
  assert.equal(out.source, "agent");
  assert.equal(out.change.kind, "training");
  assert.equal(out.change.doable, true);
  assert.equal(out.change.clinical, false);
  assert.equal(out.change.changes[0].sets, 4);
  assert.deepEqual(
    out.ripple.map((r) => r.stone),
    STONE_KEYS,
    "always all six, in stone order; an unknown stone is dropped"
  );
  const strength = out.ripple.find((r) => r.stone === "strength");
  assert.equal(strength.direction, "helps");
  assert.equal(strength.confidence, "likely");
  assert.equal(typeof strength.before.word, "string", "before is the stones projection's own word");
  assert.ok(["ok", "watch", "quiet"].includes(strength.before.tone));
  const heart = out.ripple.find((r) => r.stone === "heart");
  assert.equal(heart.direction, "steady", "an untouched stone reads steady, never costs");
  assert.equal(heart.confidence, "unsure");
  for (const r of out.ripple) {
    assert.equal(violatesReadingGrammar(r.why), null, `${r.stone} why holds the reading grammar`);
    assert.doesNotMatch(JSON.stringify(r), /"(score|percent|points)"/);
  }
  assert.equal(repo.getPlanDay(1).items[0].sets, 3, "the plan is untouched");
});

test("a run in changes[] is never drafted as a lift", async () => {
  const change = normalizeWhatIfChange({
    kind: "training",
    summary: "Swap a lift for an easy run.",
    changes: [
      { day_number: 2, exercise: "Easy run", sets: 1 },
      { day_number: 2, exercise: "Tempo intervals", target_distance_km: 6 },
    ],
  });
  assert.deepEqual(change.changes, []);
  assert.equal(change.doable, false);
});

test("the offline stub floor is deterministic, word-only, and writes nothing", async () => {
  for (const rows of Object.values(WHAT_IF_FLOOR_TABLE)) {
    for (const [stone, , , why] of rows) {
      assert.ok(STONE_KEYS.includes(stone));
      assert.equal(violatesReadingGrammar(why), null, `floor line holds the grammar: ${why}`);
    }
  }
  const before = tableCounts();
  const input = { text: "What if I ran more each week?", hint: { area: "endurance", direction: "more" } };
  const a = await whatIf("stub", input);
  const b = await whatIf("stub", input);
  assert.deepEqual(tableCounts(), before, "the floor never writes");
  assert.deepEqual(a, b, "same question, same answer");
  assert.equal(a.ok, true);
  assert.equal(a.source, "deterministic");
  assert.equal(a.change.doable, false, "the floor never invents a concrete edit");
  assert.equal(a.ripple.find((r) => r.stone === "endurance").direction, "helps");
  assert.deepEqual(
    a.ripple.map((r) => r.stone),
    STONE_KEYS
  );
  const bare = whatIfFloor("What if?", null, []);
  assert.ok(bare.ripple.every((r) => r.direction === "steady" && r.before.word === "quiet"));
});

test("no question and a dead rotation are the designed ok:false at 200", async () => {
  const empty = await whatIf("auto", { text: "   " });
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.tried, []);

  const before = tableCounts();
  const dead = await whatIf("auto", { text: "What if I slept more?" }, undefined, {
    run: async () => {
      const { AgentFallbackError } = await import("../dist/agents.js");
      throw new AgentFallbackError(["claude"], [{ agent: "claude", error: "timeout" }]);
    },
  });
  assert.equal(dead.ok, false);
  assert.equal(typeof dead.error, "string");
  assert.deepEqual(dead.tried, [{ agent: "claude", error: "timeout" }]);
  assert.deepEqual(tableCounts(), before);
});

// "Do it" takes a what_if JOB: the answer is the server's own stored one. Asked
// through the canned agent (the real read path), then stored as the worker would.
async function answeredJob(text, parsed) {
  const answer = await whatIf("auto", { text }, undefined, { run: cannedRun(parsed) });
  assert.equal(answer.ok, true, "the canned answer reads");
  const job = repo.createAgentJob({ kind: "what_if", input: { text, hint: null } });
  repo.finishAgentJob(job.id, { result: answer, chosen_agent: answer.agent });
  return job.id;
}

const decisionFor = (proposalId) =>
  repo.listBrainDecisions({ limit: 20 }).find((d) => d.source_ref_key === String(proposalId));

test("Do it drafts a bounded training edit and lead mode routes it through the autonomy policy", async () => {
  seedPlan();
  const jobId = await answeredJob("What if I added a bench set?", AGENT_ANSWER);
  const out = whatIfDo({ job_id: jobId });
  assert.equal(out.ok, true);
  const proposal = repo.getProposal(out.proposal_id);
  assert.equal(proposal.agent, "what-if");
  assert.match(proposal.instruction, /^what-if: /);
  const decisions = repo.listBrainDecisions({ limit: 20 }).filter((d) => d.source_ref_key === String(out.proposal_id));
  assert.equal(decisions.length, 1, "exactly one ledger row, owned by the autonomy policy");
  assert.ok(
    ["quiet_apply", "announce"].includes(decisions[0].autonomy_tier),
    `lead tier: ${decisions[0].autonomy_tier}`
  );
  assert.ok(["landed", "lands"].includes(out.state), `lead state: ${out.state}`);
  assert.equal(out.decision_id, decisions[0].id, "the ledger row the card links to");
  assert.deepEqual(out.tried, [], "tried rides every branch");
  assert.equal(out.plan_moved, false);
  const again = whatIfDo({ job_id: jobId });
  assert.equal(again.ok, true);
  assert.equal(again.state, "already", "a second tap finds the first draft");
  assert.deepEqual(again.tried, []);
  assert.equal(again.proposal_id, out.proposal_id);
});

test("a null sets means unchanged, never remove: Do it on a load nudge keeps the lift", async () => {
  seedPlan();
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 75 },
  ]);
  const nudge = {
    kind: "training",
    summary: "Nudge the bench up five pounds.",
    changes: [
      { day_number: 1, exercise: "Barbell Bench Press", sets: null, rep_low: null, rep_high: null, target_weight: 120 },
    ],
  };
  const normalized = normalizeWhatIfChange(nudge);
  assert.ok(!Object.hasOwn(normalized.changes[0], "sets"), "a null count is dropped, not kept");
  assert.ok(!normalized.changes[0].remove);
  for (const bad of [null, -1, 0.4, "x", true]) {
    const c = normalizeWhatIfChange({
      ...nudge,
      changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: bad }],
    });
    assert.ok(!c.changes[0].remove && !Object.hasOwn(c.changes[0], "sets"), `sets:${bad} never removes`);
  }
  const zero = normalizeWhatIfChange({ ...nudge, changes: [{ day_number: 1, exercise: "Overhead Press", sets: 0 }] });
  assert.equal(zero.changes[0].remove, true, "only an explicit zero (or remove:true) removes");

  const out = whatIfDo({
    job_id: await answeredJob("What if I pushed the bench a bit?", { ...AGENT_ANSWER, change: nudge }),
  });
  assert.equal(out.ok, true);
  const names = repo.getPlanDay(1).items.map((i) => i.exercise ?? i.name ?? i.ex_name);
  assert.equal(repo.getPlanDay(1).items.length, 2, `both lifts stay on the day: ${names}`);
});

test("Do it under review_everything holds the draft for the athlete", async () => {
  seedPlan();
  repo.setSettings({ lead_mode: "review_everything" });
  const out = whatIfDo({ job_id: await answeredJob("What if I added a bench set?", AGENT_ANSWER) });
  assert.equal(out.ok, true);
  assert.equal(repo.getProposal(out.proposal_id).status, "draft", "nothing applied");
  assert.equal(repo.getPlanDay(1).items[0].sets, 3);
  const decision = decisionFor(out.proposal_id);
  assert.equal(decision.autonomy_tier, "ask");
  assert.equal(decision.status, "review");
  assert.equal(out.state, "waiting");
  assert.equal(out.decision_id, decision.id);
});

test("Do it on anything clinical is held clinician-directed, whatever lead mode says", async () => {
  seedPlan();
  const text = "What if I added a bench set now that my doctor cleared the shoulder injury?";
  // The agent's summary carries no clinical word: the mark comes from the stored question.
  const out = whatIfDo({ job_id: await answeredJob(text, AGENT_ANSWER) });
  assert.equal(out.change.clinical, true);
  assert.equal(repo.getProposal(out.proposal_id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].sets, 3, "a clinical draft never lands on its own");
  assert.equal(decisionFor(out.proposal_id).autonomy_tier, "clinician");
  assert.equal(out.state, "clinician");
  const stored = repo.getProposal(out.proposal_id).parsed;
  assert.equal(stored.clinical_provenance.source, "what_if_clinical_detection");
});

test("Do it takes no client echo: a change without a job drafts nothing", () => {
  seedPlan();
  const before = tableCounts();
  const echo = whatIfDo({ change: { ...AGENT_ANSWER.change, clinical: false }, text: "" });
  assert.equal(echo.ok, false);
  assert.equal(echo.state, "refused");
  assert.deepEqual(echo.tried, []);
  const unknown = whatIfDo({ job_id: 99999 });
  assert.equal(unknown.ok, false);
  const queued = repo.createAgentJob({ kind: "what_if", input: { text: "What if?" } });
  const pending = whatIfDo({ job_id: queued.id });
  assert.equal(pending.ok, false, "an unanswered what-if has nothing to hand over");
  assert.equal(repo.listProposals(50).length, 0, "no proposal written");
  assert.equal(tableCounts().brain_decisions, before.brain_decisions, "no ledger row");
});

test("Do it on an answer whose plan has moved since waits on the athlete", async () => {
  seedPlan();
  const jobId = await answeredJob("What if I added a bench set?", AGENT_ANSWER);
  // The plan moves after the answer was read.
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 120 },
  ]);
  const out = whatIfDo({ job_id: jobId });
  assert.equal(out.ok, true);
  assert.equal(out.plan_moved, true);
  assert.notEqual(decisionFor(out.proposal_id).autonomy_tier, "quiet_apply", "never lands quietly");

  // Outside lead mode the policy keeps the requested ask: held for the athlete.
  repo.setSettings({ lead_mode: "announce_first" });
  const staleJob = await answeredJob("What if I added a bench set?", AGENT_ANSWER);
  repo.savePlanDay(1, "Push", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 125 },
  ]);
  const held = whatIfDo({ job_id: staleJob });
  assert.equal(held.ok, true);
  assert.equal(held.plan_moved, true);
  assert.equal(held.state, "waiting");
  assert.equal(repo.getProposal(held.proposal_id).status, "draft", "held, not applied");
  assert.equal(decisionFor(held.proposal_id).autonomy_tier, "ask");
  assert.equal(repo.getPlanDay(1).items[0].sets, 3);
});

test("Do it on a calorie target always waits on the athlete", async () => {
  const out = whatIfDo({
    job_id: await answeredJob("What if I ate more?", {
      change: {
        kind: "nutrition",
        summary: "Eat a little more on lifting days.",
        nutrition: { target_kcal: 2300, protein_g: 170 },
      },
      ripple: [],
    }),
  });
  assert.equal(out.ok, true);
  const proposal = repo.getProposal(out.proposal_id);
  assert.equal(proposal.parsed.kind, "nutrition_target");
  assert.equal(proposal.status, "draft");
  assert.equal(decisionFor(out.proposal_id).autonomy_tier, "ask");
});

test("a protein-only target is completed from the active target, and the athlete can approve it", async () => {
  repo.setNutritionTarget({ target_kcal: 2100, protein_g: 150, source: "manual" });
  const ask = {
    change: { kind: "nutrition", summary: "More protein each day.", nutrition: { protein_g: 180 } },
    ripple: [],
  };
  const out = whatIfDo({ job_id: await answeredJob("What if I ate more protein?", ask) });
  assert.equal(out.ok, true);
  assert.deepEqual(out.change.nutrition, { target_kcal: 2100, protein_g: 180 }, "calories carried at their target");
  const proposal = repo.getProposal(out.proposal_id);
  assert.equal(proposal.status, "draft");
  assert.equal(proposal.parsed.nutrition.target_kcal, 2100);
  repo.applyProposal(out.proposal_id);
  const active = repo.getActiveNutritionTarget();
  assert.equal(active.protein_g, 180);
  assert.equal(active.target_kcal, 2100);
});

test("a half-target with no active target to complete it is talked through, not drafted", async () => {
  const before = tableCounts();
  const ask = {
    change: { kind: "nutrition", summary: "More protein each day.", nutrition: { protein_g: 180 } },
    ripple: [],
  };
  const jobId = await answeredJob("What if I ate more protein?", ask);
  const out = whatIfDo({ job_id: jobId });
  assert.equal(out.ok, false);
  assert.deepEqual(out.tried, []);
  assert.equal(tableCounts().plan_proposals, before.plan_proposals);
});

test("Do it never drafts a goal or a words-only change", async () => {
  const goal = whatIfDo({
    job_id: await answeredJob("What if I aimed lower?", {
      change: { kind: "goal", summary: "Aim for a lower goal weight." },
      ripple: [],
    }),
  });
  const other = whatIfDo({
    job_id: await answeredJob("What if I ran on Sundays?", {
      change: { kind: "other", summary: "Run on Sundays instead." },
      ripple: [],
    }),
  });
  const forged = whatIfDo({
    job_id: await answeredJob("What if?", {
      change: { kind: "training", summary: "Lift more.", changes: [], doable: true },
      ripple: [],
    }),
  });
  assert.equal(goal.ok, false);
  assert.deepEqual(goal.tried, []);
  assert.match(goal.error, /goal/);
  assert.equal(other.ok, false);
  assert.equal(forged.ok, false, "a stored doable:true is never trusted");
  assert.equal(repo.listProposals(50).length, 0, "no proposal");
});

test("a refused apply keeps the designed {ok:false, error, tried} shape", async () => {
  seedPlan();
  const offPlan = {
    ...AGENT_ANSWER,
    change: {
      kind: "training",
      summary: "Add a set on day nine.",
      changes: [{ day_number: 9, exercise: "Barbell Bench Press", sets: 4 }],
    },
  };
  const out = whatIfDo({ job_id: await answeredJob("What if I added a day-nine set?", offPlan) });
  assert.equal(out.ok, false, "a day the plan does not have cannot be applied");
  assert.equal(out.state, "refused");
  assert.equal(typeof out.error, "string");
  assert.deepEqual(out.tried, []);
  assert.equal(repo.getProposal(out.proposal_id).status, "draft", "nothing landed");
});

test("the ripple carries the server's own before AND after, words and tones", async () => {
  seedPlan();
  const out = await whatIf("auto", { text: "What if I added a bench set?" }, undefined, {
    run: cannedRun(AGENT_ANSWER),
  });
  for (const r of out.ripple) {
    assert.equal(typeof r.after.word, "string");
    assert.ok(["ok", "watch", "quiet"].includes(r.after.tone));
    if (r.direction === "steady") assert.deepEqual(r.after, r.before, "steady keeps where it stands");
  }
  assert.deepEqual(out.ripple.find((r) => r.stone === "strength").after, { word: "better", tone: "ok" });
  assert.equal(out.ripple.find((r) => r.stone === "recovery").after.tone, "watch");
  assert.equal(typeof out.plan_basis, "string", "a training answer stamps the plan it read");
});

// ---- the two surfaces ----

function routeHandler(path) {
  const layer = dayCoachRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.post);
  assert.ok(layer, `POST ${path} is registered`);
  return layer.route.stack[0].handle;
}

function callRoute(path, body) {
  let status = 200;
  let payload;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  routeHandler(path)({ body }, res, (err) => {
    throw err;
  });
  return { status, payload };
}

function mcpTools() {
  const tools = new Map();
  registerDayCoachTools({
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  });
  return tools;
}

async function callTool(name, args) {
  const handler = mcpTools().get(name);
  assert.ok(handler, `${name} is registered`);
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

async function settled(id) {
  for (let i = 0; i < 200; i++) {
    const job = repo.getAgentJob(id);
    if (["done", "error", "canceled"].includes(job.status)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return repo.getAgentJob(id);
}

test("REST and MCP queue the same what_if job, and it answers from the offline floor", async () => {
  const input = { text: "What if I rested more?", hint: { area: "recovery", direction: "more" } };
  const rest = callRoute("/what-if", { ...input, agent: "stub" });
  assert.equal(rest.status, 200);
  assert.equal(rest.payload.ok, true);
  assert.equal(rest.payload.job.kind, "what_if");
  const mcp = await callTool("what_if", { ...input, agent: "stub" });
  assert.equal(mcp.ok, true);
  assert.equal(mcp.job.kind, "what_if");
  assert.deepEqual(mcp.job.input, rest.payload.job.input, "one input shape across both surfaces");

  const [a, b] = [await settled(rest.payload.job.id), await settled(mcp.job.id)];
  assert.equal(a.status, "done");
  assert.equal(b.status, "done");
  assert.deepEqual(a.result, b.result, "one op beneath both surfaces");
  assert.equal(a.result.ok, true);
  assert.equal(a.result.ripple.find((r) => r.stone === "recovery").direction, "helps");

  const missing = callRoute("/what-if", { text: "  " });
  assert.equal(missing.status, 400);
  assert.equal(missing.payload.ok, false);
});

test("only the athlete's own tap is their request: the app's Do it carries the mark, an MCP client's never does", async () => {
  seedPlan();
  const viaRest = callRoute("/what-if/do", { job_id: await answeredJob("What if I added a bench set?", AGENT_ANSWER) });
  const viaMcp = await callTool("what_if_do", {
    job_id: await answeredJob("What if I added a bench set?", AGENT_ANSWER),
  });
  const direct = whatIfDo({ job_id: await answeredJob("What if I added a bench set?", AGENT_ANSWER) });
  const context = (proposalId) => {
    const raw = decisionFor(proposalId)?.context;
    return typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
  };
  assert.equal(context(viaRest.payload.proposal_id).explicit_user_request, true, "the app's tap is the athlete's act");
  assert.notEqual(context(viaMcp.proposal_id).explicit_user_request, true, "an MCP caller is not the athlete");
  assert.notEqual(context(direct.proposal_id).explicit_user_request, true, "nor is any caller that does not say so");
});

test("REST and MCP Do it are mirrors", async () => {
  const goalJob = await answeredJob("What if I aimed lower?", {
    change: { kind: "goal", summary: "Aim for a lower goal weight." },
    ripple: [],
  });
  const rest = callRoute("/what-if/do", { job_id: goalJob });
  const mcp = await callTool("what_if_do", { job_id: goalJob });
  assert.deepEqual(mcp, rest.payload);
  assert.equal(rest.payload.ok, false);

  seedPlan();
  repo.setSettings({ lead_mode: "review_everything" });
  const viaRest = callRoute("/what-if/do", { job_id: await answeredJob("What if I added a bench set?", AGENT_ANSWER) });
  const viaMcp = await callTool("what_if_do", {
    job_id: await answeredJob("What if I added a bench set?", AGENT_ANSWER),
  });
  for (const out of [viaRest.payload, viaMcp]) {
    assert.equal(out.ok, true);
    assert.equal(repo.getProposal(out.proposal_id).status, "draft");
  }
  assert.notEqual(viaRest.payload.proposal_id, viaMcp.proposal_id);
});
