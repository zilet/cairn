// The BLANK-SLATE week composer (composeWeek / buildWeekComposePrompt).
//
// Every other producer in this system refines a week that already exists and degrades
// to a calm no-op without one — buildProgressionProposal, buildRunPlanProposal and the
// scheduler's weekly evolution all return early with no plan. composeWeek is the one op
// that writes the first week, both lanes at once, and it does it through the SAME
// propose→apply seam as an evolution: a draft `days` payload that the autonomy layer
// classifies as structural.
//
// These lock the parts that are deterministic and offline: the prompt's own text and
// its DATA projection, the first-week-only guard, the athlete-facing sentence that
// guard says, and the autonomy tier the composed draft lands on. The agentic call
// itself needs a CLI, so it runs in an isolated subprocess against a canned agent
// (the AGENTS_CONFIG pattern from test/nutritionCheckinProtectiveGuard.test.js) —
// the built-in `stub` agent replies with `changes`, which is precisely NOT a week.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repo, resetTables } from "./_seed.js";
import { buildWeekComposePrompt } from "../dist/prompt.js";
import { projectCoachContext, PROMPT_CONTEXT_SITES } from "../dist/prompt/context-projection.js";
import { composeWeek, COMPOSE_WEEK_INSTRUCTION, WEEK_ALREADY_BUILT_VARIANTS } from "../dist/coachOps.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { pickDayVariant } from "../dist/repo/brain/day-read-rules.js";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
} from "../dist/domain/brain/autonomy-service.js";
import { programRouter } from "../dist/routes/program.js";
import { onJobEvent } from "../dist/agentJobs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

beforeEach(() => {
  resetTables("logged_sets", "sessions", "activities", "plan_items", "plan_days", "program_blocks", "plan_proposals");
});

// ---------- the prompt ----------

test("the first-week prompt states the ring, the placement rules, and a days-only contract", () => {
  const prompt = buildWeekComposePrompt();
  assert.match(prompt, /FIRST training week/, "says what it is composing");
  assert.match(prompt, /THE WEEK IS A RING/, "the template repeats — Sunday sits next to Monday");
  assert.match(prompt, /Day 7 sits right next to Day 1/, "spells the seam out rather than implying it");
  assert.match(prompt, /NO TWO HARD DAYS BACK TO BACK/, "carries the adjacency rule");
  assert.match(prompt, /LONG RUN GOES LATE/, "long run late in the week");
  assert.match(prompt, /QUALITY sits MID-WEEK/, "quality mid-week");
  assert.match(prompt, /"days"/, "emits the days restructure contract");
  assert.match(prompt, /"kind": "cardio"/, "the week can carry endurance prescriptions");
  assert.match(prompt, /Emit "days" only/, "a first week has nothing to edit, so no changes/cardio arrays");
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(prompt), "no 0-100 score leaks into the prompt");
});

test("with no endurance sport on record the prompt forbids inventing running", () => {
  assert.match(
    buildWeekComposePrompt(),
    /do NOT\s*\n?\s*invent running/,
    "a strength-only athlete gets the lifting week alone"
  );
});

test("a caller instruction becomes the TASK line; without one there is a calm default", () => {
  assert.match(buildWeekComposePrompt("I can only train 3 days"), /TASK: I can only train 3 days/);
  assert.match(buildWeekComposePrompt(), /TASK: Compose their first training week/);
});

test("the prompt builds cleanly on a genuinely blank slate (degrades, never throws)", () => {
  const prompt = buildWeekComposePrompt();
  assert.ok(prompt.length > 500);
  assert.match(prompt, /NO EQUIPMENT PROFILE ON RECORD/, "no equipment → the bodyweight-friendly fallback");
  assert.ok(!/undefined|\[object Object\]|NaN/.test(prompt), "nothing leaks a raw JS artifact");
});

// ---------- the DATA projection ----------

// The payload a prompt hands the agent: the line after its final `DATA…:` marker.
function dataBlock(prompt) {
  const lines = prompt.split("\n");
  const at = lines.findLastIndex((line) => /^DATA\b.*:$/.test(line));
  assert.ok(at >= 0 && at + 1 < lines.length, "the prompt carries a labelled DATA block");
  return lines[at + 1];
}

test("the week_compose site exists and serializes exactly its allowlisted keys", () => {
  const spec = PROMPT_CONTEXT_SITES.week_compose;
  assert.ok(spec, "the composer registered a site rather than dumping the whole context");
  const full = repo.getCoachContext();
  const parsed = JSON.parse(dataBlock(buildWeekComposePrompt()));
  const expected = spec.keys.filter((key) => Object.hasOwn(full, key));
  assert.deepEqual(Object.keys(parsed).sort(), [...new Set(expected)].sort());

  // Kept: what the prompt text or one of its render helpers genuinely reads.
  for (const key of ["profile", "memory", "goal", "discipline", "training_intent", "plan", "recent_sessions", "program_state", "endurance_goal", "run_zones", "directives", "health", "recovery", "signal_state"]) {
    assert.ok(Object.hasOwn(parsed, key), `week_compose keeps ${key}`);
  }
  // Dropped: the read layer a RUNNING program produces, and the lanes this prompt
  // never speaks about. A blank slate has no volume history to balance, no week to
  // collide, and this op composes training rather than food.
  for (const key of ["week_layout", "program_balance", "program_adjustments", "strength_journey", "performance", "test_week", "garmin", "day_intake", "meal_plan", "day_read", "recent_decisions", "insights"]) {
    assert.ok(!Object.hasOwn(parsed, key), `week_compose drops ${key}`);
  }
});

test("the projection never materializes an absent key and never mutates its input", () => {
  const ctx = { profile: { about_me: "new here" }, plan: [] };
  const projected = projectCoachContext(ctx, "week_compose");
  assert.deepEqual(Object.keys(projected).sort(), ["plan", "profile"]);
  assert.deepEqual(ctx, { profile: { about_me: "new here" }, plan: [] });
});

// ---------- the guard ----------

test("a week already on the plan → the designed ok:false, no proposal row written", async () => {
  repo.savePlanDay(1, "Full", "Full", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
  const before = repo.listProposals(50).length;

  const out = await composeWeek("stub", undefined);
  assert.equal(out.ok, false);
  assert.match(out.error, /evolv/i, "the error points at the path that CAN change a running week");
  assert.equal(out.proposal, null);
  assert.equal(out.autonomy, null);
  assert.deepEqual(out.tried, []);
  assert.equal(repo.listProposals(50).length, before, "the guard writes nothing at all");
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 135, "and touches no plan item");
});

test("an EMPTY shell plan day is not a week — the composer still runs", async () => {
  // savePlanDay with no items leaves a day row with nothing on it. Treating that as
  // "you already have a plan" would trap the athlete: every other producer no-ops on
  // it too, so nothing could ever write the first week. Same predicate the scheduler
  // uses for "no plan to evolve yet" — a day CARRYING items.
  repo.savePlanDay(1, "Placeholder", "Placeholder", []);
  const out = await composeWeek("stub", undefined);
  assert.notEqual(out.ok, false, "the guard did not fire on an empty shell day");
});

// The guard's inputs are deterministic — the same athlete walking into it on ten
// different days would read the identical sentence from a single literal, which is
// the exact failure the day read's variant sets exist to prevent. Every PHRASING in
// the set is held to the reading grammar, not just the one today happens to pick.
test("the already-built sentence is a variant set: it rotates, and every phrasing holds the grammar", () => {
  assert.ok(WEEK_ALREADY_BUILT_VARIANTS.length >= 3, "one literal would print forever");
  for (const phrasing of WEEK_ALREADY_BUILT_VARIANTS) {
    assert.equal(violatesReadingGrammar(phrasing), null, `"${phrasing}" breaks the reading grammar`);
    assert.match(phrasing, /evolv/i, "every phrasing names the path that CAN change a running week");
  }
  const seen = new Set();
  for (let day = 1; day <= 28; day++) {
    seen.add(pickDayVariant(WEEK_ALREADY_BUILT_VARIANTS, `2026-03-${String(day).padStart(2, "0")}`, "compose-week-already-built"));
  }
  assert.equal(seen.size, WEEK_ALREADY_BUILT_VARIANTS.length, "a month of dates reaches every phrasing");
});

// ---------- the autonomy seam ----------

test("a composed week routes as a STRUCTURAL change: it announces first, then lands at the boundary", () => {
  repo.setSettings({ lead_mode: "lead" });
  // Exactly the payload composeWeek persists: a whole-week `days` restructure carrying
  // BOTH lanes. Built here rather than through the agent so the tier assertion is about
  // the autonomy layer, not about a CLI's reply (mirrors brainAutonomyPlanPaths).
  const proposal = repo.createProposal("auto", "compose the first training week", "", {
    summary: "A first week: three lifting days with the long run late.",
    days: [
      {
        day_number: 1,
        name: "Lower",
        focus: "lower",
        items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: null, note: "NEW — start light, log actual" }],
      },
      {
        day_number: 3,
        name: "Upper",
        focus: "upper",
        items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: null }],
      },
      {
        day_number: 6,
        name: "Long run",
        focus: "endurance",
        items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 8, target_zone: "Z2" }],
      },
    ],
  });

  const out = applyProposalWithAutonomy(proposal.id);
  assert.equal(out.announced, true, "a whole-week restructure announces first, even in lead mode");
  assert.equal(out.tier, "announce");
  assert.equal(repo.getPlan().length, 0, "nothing is written until the boundary");

  const due = applyDueAnnouncedDecisions(out.effective_date);
  assert.deepEqual(due.applied, [out.decision.id]);
  const plan = repo.getPlan();
  assert.equal(plan.length, 3, "the boundary pass wrote the composed week");
  const items = plan.flatMap((day) => day.items ?? []);
  assert.ok(items.some((item) => String(item.kind ?? "strength") !== "cardio"), "the week carries strength work");
  assert.ok(items.some((item) => String(item.kind) === "cardio"), "and endurance work, in the same week");
});

// ---------- routing ----------

test("compose_week shares the proposal task class with the coach draft and the evolution", () => {
  // Writing the whole week is the most consequential of the three plan-shaping ops,
  // so it inherits `proposal`'s deep/xhigh profile rather than declaring a thinner one.
  assert.equal(repo.taskForOp("compose_week"), "proposal");
  assert.equal(repo.taskForOp("evolve_program"), "proposal");
  assert.deepEqual(repo.TASK_EXECUTION_PROFILES.proposal, { model_class: "deep", reasoning: "xhigh" });
  assert.deepEqual(
    repo.resolveTaskExecutionProfile(repo.taskForOp("compose_week"), "claude"),
    repo.resolveTaskExecutionProfile(repo.taskForOp("evolve_program"), "claude"),
    "the composer resolves to the same model + effort as the evolution on a real provider"
  );
  // The interactive leash scales with that effort rather than a flat cap.
  assert.equal(repo.interactiveTimeoutForOp("compose_week"), repo.interactiveTimeoutForOp("evolve_program"));
});

// ---------- the agentic path (isolated subprocess, canned agent) ----------

// dist/repo.js runs the migration ladder at import time and logs each applied step
// to stdout ahead of our payload, so a sentinel anchors the parse.
const RESULT_SENTINEL = "===CAIRN_TEST_RESULT===";

test("blank slate + a week-shaped agent reply → a draft carrying BOTH lanes, and the compose itself changes no plan day", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-week-compose-"));
  try {
    const configPath = path.join(dataDir, "agents.json");
    // A canned agent that replies with a real WEEK. The built-in `stub` cannot stand in
    // here: its reply is a `changes` array, which is an edit to a plan that does not
    // exist yet.
    const reply = JSON.stringify({
      summary: "A calm first week: two lifting days and an easy long run.",
      days: [
        {
          day_number: 1,
          name: "Lower",
          focus: "lower",
          items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: null, note: "NEW — start light, log actual" }],
        },
        {
          day_number: 4,
          name: "Upper",
          focus: "upper",
          items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: null }],
        },
        {
          day_number: 6,
          name: "Long run",
          focus: "endurance",
          items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 8, target_zone: "Z2" }],
        },
      ],
    });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        "week-stub": {
          command: "sh",
          // Single-quoted for sh; the payload carries no single quotes.
          args: ["-c", `printf '%s' '${reply}'`],
          input: "arg",
          env_required: [],
        },
      })
    );

    const distRepoUrl = pathToFileURL(path.join(root, "dist", "repo.js")).href;
    const distCoachOpsUrl = pathToFileURL(path.join(root, "dist", "coachOps.js")).href;
    const runner = [
      `import * as repo from ${JSON.stringify(distRepoUrl)};`,
      `import { composeWeek } from ${JSON.stringify(distCoachOpsUrl)};`,
      // Review posture, so the draft parks instead of announcing — this case is about
      // what the OP produces, and the autonomy tier is pinned separately above.
      `repo.setSettings({ lead_mode: "review_everything" });`,
      `const result = await composeWeek("week-stub", "I can only train 3 days");`,
      `const out = { ok: result.ok, days: result.days, parsed: result.proposal?.parsed ?? null, status: result.proposal?.status ?? null, instruction: result.proposal?.instruction ?? null, planDays: repo.getPlan().length };`,
      `process.stdout.write(${JSON.stringify(RESULT_SENTINEL)});`,
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n");

    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: {
        ...process.env,
        AGENTS_CONFIG: configPath,
        DATA_DIR: dataDir,
        DB_PATH: path.join(dataDir, "cairn.db"),
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const idx = res.stdout.lastIndexOf(RESULT_SENTINEL);
    assert.notEqual(idx, -1, `result sentinel not found in subprocess stdout:\n${res.stdout}`);
    const out = JSON.parse(res.stdout.slice(idx + RESULT_SENTINEL.length).trim());

    assert.equal(out.ok, true);
    assert.equal(out.days, 3, "the draft carries the whole week");
    assert.equal(out.status, "draft", "a composed week is a DRAFT — the agent never applies its own change");
    const items = out.parsed.days.flatMap((day) => day.items ?? []);
    assert.ok(items.some((item) => String(item.kind ?? "strength") !== "cardio"), "a strength item is in the week");
    assert.ok(items.some((item) => String(item.kind) === "cardio"), "and a cardio item is too");
    assert.equal(out.planDays, 0, "composing changed no plan day — only the propose→apply seam can");
    assert.ok(
      out.instruction.startsWith(COMPOSE_WEEK_INSTRUCTION),
      `a composed week stays recognizable by its marker prefix even with an athlete instruction: ${out.instruction}`
    );
    assert.ok(out.instruction.includes("3 days"), "and the athlete's own words ride along after it");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- the passthrough: POST body → route → background job runner ----------
//
// composeWeek() itself is proven above to fold an instruction into the stored
// proposal. What nothing pinned before this test is the two hops that carry an
// athlete's typed words to that call in production: the REST handler reading
// `req.body.instruction` (src/routes/program.ts) and the background job runner
// forwarding `input.instruction` out of the persisted job into composeWeek()
// (src/agentJobs.ts, the "compose_week" case). The built-in `stub` agent is fine
// here — its `changes`-shaped reply is not a week, so composeWeek stores the
// proposal and returns without ever reaching the apply step, which is all this
// needs to prove the words survived the trip.
test("POST /program/compose-week carries the athlete's instruction through the route and the background job runner into the stored proposal", async () => {
  const layer = programRouter.stack.find((entry) => entry.route?.path === "/program/compose-week");
  assert.ok(layer, "REST compose-week route is registered");
  const handler = layer.route.stack[0].handle;

  let responded;
  const req = { body: { agent: "stub", instruction: "I can only train 3 days" } };
  const res = {
    json: (body) => {
      responded = body;
    },
  };
  await handler(req, res);

  assert.ok(responded?.ok, "the route enqueues a durable job and answers immediately");
  const jobId = responded.job?.id;
  assert.ok(jobId, "the response carries the queued job");

  const job = await new Promise((resolve, reject) => {
    const off = onJobEvent(jobId, (event) => {
      if (event.type === "done") {
        off();
        resolve(event.job);
      } else if (event.type === "error" || event.type === "canceled") {
        off();
        reject(new Error(`job ended as ${event.type}`));
      }
    });
  });

  assert.equal(job.result?.ok, true, "the stub agent's reply parses, so the op reports ok");
  const proposalId = job.result?.proposal?.id;
  assert.ok(proposalId, "compose_week persists a plan_proposals row");
  const proposal = repo.getProposal(Number(proposalId));
  assert.ok(proposal, "the proposal the job created is readable back out");
  assert.ok(
    proposal.instruction.startsWith(COMPOSE_WEEK_INSTRUCTION),
    `keeps its marker prefix: ${proposal.instruction}`
  );
  assert.ok(
    proposal.instruction.includes("I can only train 3 days"),
    "the athlete's own words made it from req.body.instruction, through the route, through the " +
      "background job runner's input.instruction forwarding, into the stored proposal"
  );
});

// ---------- the bound on what an instruction may be ----------
//
// The instruction is unvalidated free text off an HTTP body that goes TWO places:
// into the prompt the agent reads, and into the proposal instruction the athlete
// reads back. composeWeek is the one choke point REST and MCP share, so the bound
// lives there rather than being remembered separately by each surface.

// Drive the REST route the way the passthrough test above does, and return the
// stored proposal the background job produced.
async function composeViaRoute(body) {
  const layer = programRouter.stack.find((entry) => entry.route?.path === "/program/compose-week");
  const handler = layer.route.stack[0].handle;
  let responded;
  await handler({ body }, { json: (payload) => (responded = payload) });
  const job = await new Promise((resolve, reject) => {
    const off = onJobEvent(responded.job.id, (event) => {
      if (event.type === "done") {
        off();
        resolve(event.job);
      } else if (event.type === "error" || event.type === "canceled") {
        off();
        reject(new Error(`job ended as ${event.type}`));
      }
    });
  });
  return repo.getProposal(Number(job.result.proposal.id));
}

test("a pasted essay is clamped to the length the field accepts, prefix intact", async () => {
  const essay = "z".repeat(2000);
  const proposal = await composeViaRoute({ agent: "stub", instruction: essay });
  const prefix = `${COMPOSE_WEEK_INSTRUCTION} — `;
  assert.ok(proposal.instruction.startsWith(prefix), `keeps its marker prefix: ${proposal.instruction}`);
  const athlete = proposal.instruction.slice(prefix.length);
  assert.equal(athlete.length, 240, "the athlete text is bounded at what the PWA field accepts");
  assert.equal(athlete, "z".repeat(240));
});

test("the clamp never splits an emoji — a lone surrogate must not reach the prompt or the proposal", async () => {
  // 239 plain chars, then an emoji: slice(0, 240) keeps only the emoji's lead
  // surrogate, which node:sqlite would store as U+FFFD and the prompt would carry
  // as mojibake. The clamp drops the orphan half instead.
  const boundary = `${"z".repeat(239)}🏃`;
  const proposal = await composeViaRoute({ agent: "stub", instruction: boundary });
  const prefix = `${COMPOSE_WEEK_INSTRUCTION} — `;
  const athlete = proposal.instruction.slice(prefix.length);
  assert.equal(athlete, "z".repeat(239), "the split emoji is dropped whole, not stored as half");
  assert.ok(athlete.isWellFormed(), "what is stored is well-formed text");
});

test("an instruction that is not words at all is treated as absent, never as '[object Object]'", async () => {
  const proposal = await composeViaRoute({ agent: "stub", instruction: { evil: true } });
  assert.equal(
    proposal.instruction,
    COMPOSE_WEEK_INSTRUCTION,
    "a junk shape leaves the bare marker rather than being stringified into the athlete's words"
  );
  assert.ok(!proposal.instruction.includes("[object Object]"));
});
