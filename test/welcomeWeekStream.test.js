// The welcome's first week, fast and visible (src/coachOps/welcome.ts → composeWeek):
//
//   - it runs as its own op, `welcome_week`, on a thinner execution profile than the Plan
//     tab's / MCP compose (which keep `proposal`, deep/xhigh);
//   - where the agent can stream, each `days[i]` rides the welcome job's phase meta as
//     `days_so_far` the moment it is written — a preview; the applied week is the final
//     parse. An agent that cannot stream runs the ordinary single call;
//   - a welcome a restart cut short during its week is re-queued at boot to finish only
//     the week (every other interrupted job stays interrupted);
//   - the app's one-shot "first week" status: building → ready → said once.
//
// Agentic paths run in an isolated subprocess against a canned agent table — never a CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repo } from "./_seed.js";
import { recoverAgentJobs, interruptedJobResume, WELCOME_RESUME_LIMIT } from "../dist/agentJobs.js";
import { firstWeekStatus, markFirstWeekSeen, recordFirstWeekOutcome } from "../dist/repo/first-week.js";
import { personContextRouter } from "../dist/routes/person-context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const RESULT_SENTINEL = "===CAIRN_TEST_RESULT===";

const REPLY = {
  about_me: "Lifts three days a week.",
  profile: { days_per_week: 3 },
  goal: "maintain",
  lift_days: [1, 3, 5],
  supplements: [],
  memories: [],
  context_events: [],
  movement_considerations: [],
  welcome_reply:
    "Thanks — that's a clear picture. Three lifting days on the days you named, and a starting point for food you can change any time.",
  fuel_start: { target_kcal: 2300, protein_g: 160 },
  summary: "A first week: three lifting days.",
  days: [
    {
      day_number: 1,
      name: "Lower {A}",
      focus: "lower",
      items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }],
    },
    {
      day_number: 2,
      name: "Upper",
      focus: "upper",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8 }],
    },
    {
      day_number: 3,
      name: "Full body",
      focus: "full",
      items: [{ exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 10 }],
    },
  ],
};
const WORDS = "I lift Monday, Wednesday and Friday and want to stay strong.";

// The reply as a grok-format NDJSON stream, cut into small text deltas.
function ndjson(text, size = 23) {
  const lines = [];
  for (let i = 0; i < text.length; i += size)
    lines.push(JSON.stringify({ type: "text", data: text.slice(i, i + size) }));
  return `${lines.join("\n")}\n`;
}

function runIsolated({ stream }, body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-welcome-week-"));
  try {
    const replyFile = path.join(dataDir, "reply.json");
    fs.writeFileSync(replyFile, JSON.stringify(REPLY));
    const def = { command: "sh", args: ["-c", `cat '${replyFile}'`], input: "arg", env_required: [], label: "Claude" };
    if (stream) {
      const streamFile = path.join(dataDir, "reply.ndjson");
      fs.writeFileSync(streamFile, ndjson(JSON.stringify(REPLY, null, 1)));
      def.stream = { format: "grok", args: ["-c", `cat '${streamFile}'`] };
    }
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(configPath, JSON.stringify({ coach: def }));
    const url = (rel) => JSON.stringify(pathToFileURL(path.join(root, "dist", rel)).href);
    const runner = [
      `import * as repo from ${url("repo.js")};`,
      `import * as ops from ${url("coachOps.js")};`,
      `import { db } from ${url("db.js")};`,
      `import { setAgentRunSink } from ${url("agents.js")};`,
      // The server wires one-shot telemetry at boot (scheduler.ts); the streamed path writes its own.
      "setAgentRunSink((r) => repo.recordAgentRun(r));",
      "const out = await (async () => {",
      body,
      "})();",
      `process.stdout.write(${JSON.stringify(RESULT_SENTINEL)});`,
      "process.stdout.write(JSON.stringify(out));",
      "process.exit(0);",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: { ...process.env, AGENTS_CONFIG: configPath, DATA_DIR: dataDir, DB_PATH: path.join(dataDir, "cairn.db") },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(res.status, 0, res.stderr);
    const idx = res.stdout.lastIndexOf(RESULT_SENTINEL);
    assert.notEqual(idx, -1, `result sentinel not found:\n${res.stdout}\n${res.stderr}`);
    return JSON.parse(res.stdout.slice(idx + RESULT_SENTINEL.length).trim());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const WELCOME_RUN = `
  repo.setSettings({ lead_mode: "lead" });
  const phases = [];
  const hooks = { onPhase: (phase, meta) => phases.push(JSON.parse(JSON.stringify(meta ?? null))) };
  const result = await ops.welcomeCoach("coach", ${JSON.stringify(WORDS)}, hooks);
  const runs = db.prepare("SELECT op, ok FROM agent_runs ORDER BY id").all().map((r) => ({ ...r }));
  return { result, phases, runs, planDays: repo.getPlan().filter((d) => d.items?.length).length };
`;

test("the welcome's week is its own op on a thinner profile; the Plan tab's compose keeps the deep one", () => {
  assert.deepEqual(repo.TASK_EXECUTION_PROFILES.welcome_week, { model_class: "fast", reasoning: "medium" });
  assert.equal(repo.taskForOp("welcome_week"), "welcome_week", "its own class, not folded into proposal");
  assert.equal(repo.taskForOp("compose_week"), "proposal");
  assert.deepEqual(repo.TASK_EXECUTION_PROFILES.proposal, { model_class: "deep", reasoning: "xhigh" });
  const defs = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
  assert.deepEqual(repo.resolveTaskExecutionProfile("welcome_week", "claude", { defs, bindings: {} }), {
    model: "sonnet",
    reasoning: "medium",
  });
});

test("a streaming agent: each day rides the phase meta as it is written, and the final parse is what lands", () => {
  const out = runIsolated({ stream: true }, WELCOME_RUN);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.equal(out.result.week_state, "applied");
  assert.equal(out.planDays, 3, "the applied week is the whole parsed reply");
  const counts = out.phases.filter((m) => m?.step === "week" && m.days_so_far).map((m) => m.days_so_far.length);
  assert.deepEqual(counts, [1, 2, 3], "one phase per arriving day, in order");
  const last = out.phases.filter((m) => m?.days_so_far).at(-1);
  assert.deepEqual(
    last.days_so_far.map((d) => [d.dow, d.name]),
    [
      [1, "Lower {A}"],
      [3, "Upper"],
      [5, "Full body"],
    ],
    "the preview speaks the reveal's shape, on the named weekdays"
  );
  assert.ok(
    out.phases.filter((m) => m?.days_so_far).every((m) => m.reply === out.result.reply && m.detail),
    "the reply and the composer's words ride along with the days"
  );
  assert.ok(
    out.phases.every((m) => JSON.stringify(m).length < 2000),
    "phase payloads stay small"
  );
  assert.deepEqual(
    out.runs.map((r) => r.op),
    ["onboard", "welcome_week"],
    "the week ran as welcome_week"
  );
});

test("an agent that cannot stream runs the ordinary single call: no preview, same week", () => {
  const out = runIsolated({ stream: false }, WELCOME_RUN);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.equal(out.result.week_state, "applied");
  assert.equal(out.planDays, 3);
  assert.equal(out.phases.filter((m) => m?.days_so_far).length, 0);
  assert.ok(out.runs.some((r) => r.op === "welcome_week"));
});

test("a resumed welcome runs only the week: no second exchange, the reply it already said", () => {
  const out = runIsolated(
    { stream: false },
    `
      repo.setSettings({ lead_mode: "lead", onboarded: true, coach_welcomed: true });
      const result = await ops.welcomeCoach("coach", ${JSON.stringify(WORDS)}, undefined, {
        resume: { step: "week", reply: "What I said the first time." },
      });
      const runs = db.prepare("SELECT op FROM agent_runs ORDER BY id").all().map((r) => r.op);
      return { result, runs, chat: repo.listChatMessages(10).length, planDays: repo.getPlan().filter((d) => d.items?.length).length };
    `
  );
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.equal(out.result.reply, "What I said the first time.");
  assert.equal(out.result.week_state, "applied");
  assert.equal(out.planDays, 3);
  assert.deepEqual(out.runs, ["welcome_week"], "understanding is not redone");
  assert.equal(out.chat, 0, "the exchange is not written again");
});

test("boot: a welcome cut short during its week is re-queued to finish it; everything else stays interrupted", () => {
  const week = repo.createAgentJob({ kind: "welcome", agent: "coach", input: { text: WORDS } });
  repo.markAgentJobRunning(week.id);
  repo.setAgentJobPhase(week.id, "building your first week", { step: "week", reply: "Hi there.", days_so_far: [] });
  const early = repo.createAgentJob({ kind: "welcome", input: { text: WORDS } });
  repo.markAgentJobRunning(early.id);
  repo.setAgentJobPhase(early.id, "reading what you said", { step: "understand" });
  const other = repo.createAgentJob({ kind: "meal_plan" });
  repo.markAgentJobRunning(other.id);

  const raw = repo.recoverAgentJobs(interruptedJobResume);
  assert.deepEqual(raw.resumed, [week.id]);
  assert.equal(raw.interrupted, 2);
  assert.ok(raw.requeue.includes(week.id), "back with the runner");
  const resumed = repo.getAgentJob(week.id);
  assert.equal(resumed.status, "queued", "the SAME job: a client watching it sees it run again");
  assert.equal(resumed.input.resume_week, true);
  assert.equal(resumed.input.resume_count, 1);
  assert.equal(resumed.input.text, WORDS);
  assert.equal(resumed.meta.reply, "Hi there.", "what already landed stays on the row");
  assert.match(repo.getAgentJob(early.id).error, /interrupted/, "before the week, a retry is the person's to make");
  assert.match(repo.getAgentJob(other.id).error, /interrupted/);

  // Bounded: a week that keeps dying with the server is not resumed forever.
  assert.equal(
    interruptedJobResume({
      kind: "welcome",
      meta: { step: "week" },
      input: { text: WORDS, resume_count: WELCOME_RESUME_LIMIT },
    }),
    null
  );
  assert.equal(typeof recoverAgentJobs, "function");
});

test("the app's first-week status: building with the days so far, then ready once, then nothing owed", () => {
  repo.setSettings({ coach_welcomed: true });
  markFirstWeekSeen();
  const job = repo.createAgentJob({ kind: "welcome", input: { text: WORDS } });
  repo.markAgentJobRunning(job.id);
  const days = [
    { dow: 1, day_number: 1, name: "Lower" },
    { dow: 3, day_number: 2, name: "Upper" },
  ];
  repo.setAgentJobPhase(job.id, "building your first week", { step: "week", days_so_far: days });
  const building = firstWeekStatus();
  assert.equal(building.state, "building");
  assert.equal(building.job_id, job.id);
  assert.deepEqual(building.days, days);
  assert.equal(building.final, false);

  repo.finishAgentJob(job.id, { result: { ok: true } });
  recordFirstWeekOutcome(job.id, "applied", days);
  const ready = firstWeekStatus();
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.days, days);
  assert.equal(firstWeekStatus().state, "ready", "still owed until someone says it");

  const after = markFirstWeekSeen();
  assert.equal(after.state, "none");
  assert.equal(after.final, true, "nothing building, nothing owed: a client may stop asking");

  recordFirstWeekOutcome(job.id, "existing", days);
  assert.equal(firstWeekStatus().state, "none", "a plan that was already there owes no notice");
  recordFirstWeekOutcome(job.id, "queued", null);
  assert.equal(firstWeekStatus().state, "none", "a handed-off week is not an ending");
});

test("GET /welcome/first-week and POST …/seen are on the person-context router", () => {
  const routes = personContextRouter.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  assert.ok(routes.includes("get /welcome/first-week"));
  assert.ok(routes.includes("post /welcome/first-week/seen"));
});
