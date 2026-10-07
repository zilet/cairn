// The first run, server half (src/coachOps/welcome.ts, src/repo/first-run.ts).
//
//   - verifyAgent: ONE agent, the real spawn path, no rotation; a failure comes back as a
//     plain reason the PWA can branch on (busy is never a verdict);
//   - welcomeCoach: the coach's first conversation — the onboarding extraction applied
//     (goal, stated lifting weekdays), a first week composed and landed TODAY as the
//     person's own request, a starting fuel target through the floors, the exchange in
//     Ask history, and the install marked welcomed; no agent ⇒ the designed ok:false and
//     nothing marked done;
//   - day one reads as a beginning, not a rest day; the program digest does not critique
//     a program that does not exist; the monthly revision conference waits for a record.
//
// The agentic paths run in an isolated subprocess against a canned agent table (the
// AGENTS_CONFIG pattern from weekCompose.test.js) — never a real CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repo } from "./_seed.js";
import {
  WELCOME_REPLY_FALLBACKS,
  applyOnboardParsed,
  emptyOnboardApplied,
  verifyFailureFrom,
  welcomeReplyFrom,
  welcomeWeekFrom,
} from "../dist/coachOps.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import {
  DAY_READ_REQUIRED_CONCEPT,
  DAY_READ_STARTING_OUT_HEADLINE_VARIANTS,
  DAY_READ_WHY_VARIANTS,
  STARTING_OUT_WHY,
  THIN_SIGNAL_COVERAGE_WHY,
  dayReadHeadline,
} from "../dist/repo/day-read.js";
import { STARTING_OUT_DAY } from "../dist/repo/brain/day-read-rules.js";
import { hasLoggedHistory, hasPlannedTraining, isStartingOut } from "../dist/repo/first-run.js";
import { personContextRouter } from "../dist/routes/person-context.js";
import { operatorRouter } from "../dist/routes/operator.js";
import { localDateISO } from "../dist/repo/shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const RESULT_SENTINEL = "===CAIRN_TEST_RESULT===";

// ---------- an isolated subprocess against a canned agent table ----------

function runIsolated(agents, body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-welcome-"));
  try {
    const table = {};
    for (const [name, spec] of Object.entries(agents)) {
      let command = spec.command;
      if (spec.reply !== undefined) {
        const file = path.join(dataDir, `${name}.reply.json`);
        fs.writeFileSync(file, typeof spec.reply === "string" ? spec.reply : JSON.stringify(spec.reply));
        command = `cat '${file}'`;
      }
      table[name] = {
        command: spec.binary ?? "sh",
        args: spec.binary ? [] : ["-c", command],
        input: "arg",
        env_required: [],
        ...(spec.label ? { label: spec.label } : {}),
        ...(spec.status ? { status_check: ["-c", spec.status] } : {}),
      };
    }
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(configPath, JSON.stringify(table));
    const url = (rel) => JSON.stringify(pathToFileURL(path.join(root, "dist", rel)).href);
    const runner = [
      `import * as repo from ${url("repo.js")};`,
      `import * as ops from ${url("coachOps.js")};`,
      `import { localDateISO } from ${url("repo/shared.js")};`,
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

// One canned reply that answers BOTH turns of the welcome: the onboarding extraction
// (with the welcome's own fields) and the first-week composer's `days` restructure.
const WELCOME_REPLY = {
  about_me: "Wants to get stronger and leaner, lifts three days a week.",
  profile: {
    sex: "male",
    age: 38,
    height_cm: 180,
    weight_lb: 190,
    goal_weight_lb: 175,
    goal_date: null,
    days_per_week: 3,
  },
  goal: "lose",
  lift_days: [1, 3, 5],
  supplements: [],
  memories: [],
  context_events: [],
  movement_considerations: [],
  welcome_reply:
    "Thanks — that's a clear picture. You want to get stronger while leaning out, lifting Monday, Wednesday and Friday. I'm putting a first week and a starting food target in place, and you can change any of it by telling me.",
  fuel_start: {
    target_kcal: 2200,
    protein_g: 170,
    why: "A modest deficit from your stated weight, with protein near your bodyweight.",
  },
  summary: "A first week: three lifting days on the days you named.",
  days: [
    {
      day_number: 1,
      name: "Lower",
      focus: "lower",
      items: [
        {
          exercise: "Back Squat",
          sets: 3,
          rep_low: 5,
          rep_high: 8,
          target_weight: null,
          note: "NEW — start light, log actual",
        },
      ],
    },
    {
      day_number: 3,
      name: "Upper",
      focus: "upper",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: null }],
    },
    {
      day_number: 5,
      name: "Full body",
      focus: "full",
      items: [{ exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 10, target_weight: null }],
    },
  ],
};

const WELCOME_TEXT =
  "I'm 38, about 190 lb, want to get stronger and lose some fat. I lift Monday, Wednesday and Friday after work.";

// ---------- the welcome op ----------

test("welcome: understood, a first week landed today on the named weekdays, fuel set, exchange in Ask, install welcomed", () => {
  const out = runIsolated(
    { coach: { reply: WELCOME_REPLY, label: "Claude" } },
    `
      repo.setSettings({ lead_mode: "lead" });
      const result = await ops.welcomeCoach("coach", ${JSON.stringify(WELCOME_TEXT)});
      const plan = repo.getPlan();
      const profile = repo.getProfile();
      const settings = repo.getSettings();
      const chat = repo.listChatMessages(10).map((m) => ({ role: m.role, content: m.content, kind: m.meta?.kind ?? null }));
      const read = repo.dayRead(localDateISO());
      return { result, planDays: plan.map((d) => d.day_number), goal_mode: profile.goal_mode,
        lift_dows: repo.statedLiftDows(), settings: { onboarded: settings.onboarded, coach_welcomed: settings.coach_welcomed },
        chat, readCode: read.decision.rule_code, startingOut: !!read.signals?.starting_out };
    `
  );
  const r = out.result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent, "coach");
  assert.equal(r.reply, WELCOME_REPLY.welcome_reply, "a grammar-clean agent reply is the coach's first words");
  assert.equal(r.week_state, "applied", "the person asked for it, so it lands today rather than next Monday");
  assert.deepEqual(r.week, [
    { dow: 1, day_number: 1, name: "Lower" },
    { dow: 3, day_number: 3, name: "Upper" },
    { dow: 5, day_number: 5, name: "Full body" },
  ]);
  assert.deepEqual(out.planDays.sort(), [1, 3, 5], "the composed week is on the plan");
  assert.equal(r.fuel_state, "set");
  assert.ok(
    Number(r.fuel.protein_g) > 0 && Number(r.fuel.target_kcal) > 0,
    "a starting target landed through the floors"
  );
  assert.equal(out.goal_mode, "lose", "the stated goal sets the journey's shape");
  assert.deepEqual(out.lift_dows, [1, 3, 5], "the named lifting weekdays are the stated strength schedule");
  assert.equal(r.applied.goal, "lose");
  assert.deepEqual(r.applied.lift_days, [1, 3, 5]);
  assert.deepEqual(out.settings, { onboarded: true, coach_welcomed: true });
  const welcome = out.chat.filter((m) => m.kind === "welcome");
  assert.deepEqual(
    welcome.map((m) => m.role),
    ["user", "assistant"],
    "the exchange lands in Ask history, their words first"
  );
  assert.equal(welcome[0].content, WELCOME_TEXT);
  assert.equal(welcome[1].content, r.reply);
  assert.equal(out.startingOut, false, "with a week on the plan, day one's wording no longer applies");
});

test("welcome: a plan already in place is kept, and an existing food target is reported rather than replaced", () => {
  const out = runIsolated(
    { coach: { reply: WELCOME_REPLY } },
    `
      repo.savePlanDay(2, "Push", "Push", [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 }]);
      repo.setNutritionTarget({ target_kcal: 2500, protein_g: 160, source: "athlete" });
      const result = await ops.welcomeCoach("coach", "I lift and want to keep it simple.");
      return { result, proposals: repo.listProposals(50).length, targets: repo.getLatestNutritionTarget() };
    `
  );
  assert.equal(out.result.ok, true);
  assert.equal(out.result.week_state, "existing");
  // The one strength day cycles onto every weekday they named (weekdayPlanDayMap).
  assert.deepEqual(
    out.result.week,
    [1, 3, 5].map((dow) => ({ dow, day_number: 2, name: "Push" }))
  );
  assert.equal(out.proposals, 0, "no week was composed over the existing plan");
  assert.equal(out.result.fuel_state, "existing");
  assert.deepEqual(out.result.fuel, { target_kcal: 2500, protein_g: 160 });
});

test("welcome: no agent answered → the designed ok:false, nothing marked done, nothing said in Ask", () => {
  const out = runIsolated(
    { coach: { command: "echo 'something broke' >&2; exit 3", label: "Claude" } },
    `
      const result = await ops.welcomeCoach("coach", "I want to run a half marathon.");
      const s = repo.getSettings();
      return { result, onboarded: s.onboarded, welcomed: s.coach_welcomed, chat: repo.listChatMessages(10).length, plan: repo.getPlan().length };
    `
  );
  assert.equal(out.result.ok, false);
  assert.equal(out.result.agent, null);
  assert.ok(Array.isArray(out.result.tried) && out.result.tried.length === 1, "the one tried agent is reported");
  assert.match(out.result.error, /Claude/, "the failure names the provider in plain words");
  assert.doesNotMatch(out.result.error, /agents? enabled|CLI|exit/i, "never engineering vocabulary");
  assert.equal(out.welcomed, false, "the welcome can simply be tried again");
  assert.equal(out.onboarded, false);
  assert.equal(out.chat, 0);
  assert.equal(out.plan, 0);
});

// ---------- verify ----------

test("verify: one agent, the real spawn path — ok with a latency, or a plain reason", () => {
  const out = runIsolated(
    {
      good: { reply: { ok: true } },
      signedout: { command: "echo 'Not logged in · Please run /login' >&2; exit 1", label: "Claude" },
      slow: { command: "sleep 5; printf '{\"ok\":true}'" },
      missing: { binary: "cairn-test-no-such-binary-xyz", label: "Grok" },
      chatty: { reply: "Hello! Happy to help." },
    },
    `
      repo.setSettings({ disabled_agents: ["good"] });
      const good = await ops.verifyAgent("good");
      const enabledAfter = !repo.getSettings().disabled_agents.includes("good");
      return {
        good, enabledAfter,
        signedout: await ops.verifyAgent("signedout"),
        slow: await ops.verifyAgent("slow", { timeoutMs: 400 }),
        missing: await ops.verifyAgent("missing"),
        chatty: await ops.verifyAgent("chatty"),
        unknown: await ops.verifyAgent("nope"),
      };
    `
  );
  assert.equal(out.good.ok, true);
  assert.equal(out.good.agent, "good");
  assert.ok(Number.isFinite(out.good.ms) && out.good.ms >= 0);
  assert.equal(out.enabledAfter, true, "connecting a provider switches it back on");
  assert.deepEqual([out.signedout.ok, out.signedout.reason], [false, "not_signed_in"]);
  assert.match(out.signedout.message, /^Claude isn't signed in/);
  assert.deepEqual([out.slow.ok, out.slow.reason], [false, "timeout"]);
  assert.deepEqual([out.missing.ok, out.missing.reason], [false, "not_installed"]);
  assert.match(out.missing.message, /^Grok /);
  assert.deepEqual([out.chatty.ok, out.chatty.reason], [false, "failed"]);
  assert.deepEqual([out.unknown.ok, out.unknown.reason], [false, "failed"]);
  for (const r of [out.signedout, out.slow, out.missing, out.chatty, out.unknown]) {
    assert.doesNotMatch(r.message, /exit|stderr|CLI|JSON/i, `plain words only: ${r.message}`);
  }
});

test("verify: host congestion is reason busy — a retry, never a verdict", () => {
  const busy = verifyFailureFrom("claude", { busy: true });
  assert.equal(busy.reason, "busy");
  assert.equal(verifyFailureFrom("claude", { failure: { state: "auth_required" } }).reason, "not_signed_in");
  assert.equal(verifyFailureFrom("claude", { failure: { state: "quota_exhausted" } }).reason, "failed");
  assert.equal(verifyFailureFrom("claude", { timedOut: true }).reason, "timeout");
});

test("verify + welcome: an unrecognised failure from a signed-out provider still reads as signed out", () => {
  // The CLI's own words are nothing Cairn knows; its login probe, asked again, says no.
  const out = runIsolated(
    {
      lapsed: {
        command: "echo 'something unexpected happened' >&2; exit 1",
        status: "echo 'Not logged in'",
        label: "Claude",
      },
      broken: { command: "echo 'something unexpected happened' >&2; exit 1", status: "echo 'Logged in using ChatGPT'" },
    },
    `
      return {
        lapsed: await ops.verifyAgent("lapsed"),
        broken: await ops.verifyAgent("broken"),
        welcome: await ops.welcomeCoach("lapsed", "I want to run a half marathon."),
      };
    `
  );
  assert.deepEqual([out.lapsed.ok, out.lapsed.reason], [false, "not_signed_in"]);
  assert.match(out.lapsed.message, /^Claude isn't signed in/);
  assert.deepEqual([out.broken.ok, out.broken.reason], [false, "failed"], "a signed-in provider's failure stays a failure");
  assert.equal(out.welcome.ok, false);
  assert.equal(out.welcome.reason, "not_signed_in", "Meet offers the sign-in again");
  assert.equal(out.welcome.signin_agent, "lapsed");
  assert.match(out.welcome.error, /^Claude isn't signed in/);
});

// ---------- the pure pieces ----------

test("the welcome reply is the agent's own words only when they hold the reading grammar", () => {
  const date = "2026-10-07";
  assert.ok(WELCOME_REPLY_FALLBACKS.length >= 3, "the floor rotates");
  for (const line of WELCOME_REPLY_FALLBACKS) {
    assert.equal(violatesReadingGrammar(line), null, `"${line}" breaks the reading grammar`);
    assert.doesNotMatch(line, /!/, "no exclamation marks");
  }
  assert.ok(WELCOME_REPLY_FALLBACKS.includes(welcomeReplyFrom({}, date)), "missing → the calm floor");
  assert.ok(
    WELCOME_REPLY_FALLBACKS.includes(
      welcomeReplyFrom({ welcome_reply: "You must train six days a week from now on." }, date)
    ),
    "gate language → the calm floor"
  );
  assert.equal(
    welcomeReplyFrom({ welcome_reply: "Great to meet you! A first week is going in now." }, date),
    "Great to meet you. A first week is going in now.",
    "an exclamation is calmed, not kept"
  );
});

test("the reveal's week sits on the named weekdays, and never invents one when none were named", () => {
  const days = [
    { day_number: 1, name: "Lower", items: [{ exercise: "Back Squat" }] },
    { day_number: 2, name: "Upper", items: [{ exercise: "Bench Press" }] },
    { day_number: 4, name: "Easy run", items: [{ kind: "cardio", exercise: "Run" }] },
    { day_number: 6, name: "Empty", items: [] },
  ];
  assert.deepEqual(
    welcomeWeekFrom(days),
    [
      { dow: null, day_number: 1, name: "Lower" },
      { dow: null, day_number: 2, name: "Upper" },
    ],
    "no stated weekdays: plan order, no weekday, and no run or empty day"
  );
  repo.setProfile({ strength_schedule: { days: [{ dow: 2 }, { dow: 0 }] } });
  assert.deepEqual(
    welcomeWeekFrom(days),
    [
      { dow: 2, day_number: 1, name: "Lower" },
      { dow: 0, day_number: 2, name: "Upper" },
    ],
    "stated weekdays: Monday-first order, Sunday last"
  );
  assert.equal(welcomeWeekFrom([]), null);
});

test("onboarding applies the stated goal and the named lifting weekdays — recomp lands as maintain", () => {
  const applied = emptyOnboardApplied();
  applyOnboardParsed({ goal: "recomp", lift_days: [6, 2, 2, 9, "x"] }, applied);
  assert.equal(repo.getProfile().goal_mode, "maintain");
  assert.equal(applied.goal, "recomp");
  assert.deepEqual(applied.lift_days, [2, 6], "deduped, in range, sorted");
  assert.deepEqual(repo.statedLiftDows(), [2, 6]);
  assert.ok(
    repo.listMemory(20).some((m) => /recomposition/i.test(m.content)),
    "the recomp intent is remembered in words"
  );

  const again = emptyOnboardApplied();
  applyOnboardParsed({ goal: "bulk-ish", lift_days: [] }, again);
  assert.equal(repo.getProfile().goal_mode, "maintain", "an unrecognized goal word changes nothing");
  assert.equal(again.goal, null);
});

// ---------- day one ----------

test("day one reads as a beginning: its own rule, its own headline, no thin-week sentence", () => {
  assert.equal(isStartingOut(), true, "a wiped DB has no plan and no history");
  const date = localDateISO();
  const read = repo.dayRead(date);
  assert.equal(read.decision.rule_code, "starting_out_day");
  assert.equal(read.kind, "easy", "the safety ladder's kind is unchanged — only the words are day one's");
  assert.equal(read.signals.starting_out, true);
  assert.ok(STARTING_OUT_WHY.includes(read.why), `day one's own words, got ${JSON.stringify(read.why)}`);
  for (const thin of THIN_SIGNAL_COVERAGE_WHY) assert.ok(!read.why.includes(thin), "no thin-week sentence on day one");
  const headline = dayReadHeadline(read, date);
  assert.ok(DAY_READ_STARTING_OUT_HEADLINE_VARIANTS.includes(headline), `got ${headline}`);
  assert.doesNotMatch(headline, /easy|rest/i, "never reads as a rest day");
});

test("day one ends the moment there is a week or a record", () => {
  repo.savePlanDay(1, "Lower", "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  assert.equal(hasPlannedTraining(), true);
  assert.equal(isStartingOut(), false);
  assert.notEqual(repo.dayRead(localDateISO()).decision.rule_code, "starting_out_day");
});

test("logged history alone (no plan) is the unprogrammed floor, not day one", () => {
  repo.addFoodNote("lunch", "chicken and rice", { kcal: 600 });
  assert.equal(hasLoggedHistory(), true);
  const read = repo.dayRead(localDateISO());
  assert.notEqual(read.decision.rule_code, "starting_out_day");
  assert.notEqual(read.signals?.starting_out, true);
});

test("day one's vocabulary is registered and holds the reading grammar and its one idea", () => {
  assert.equal(DAY_READ_WHY_VARIANTS.starting_out_day, STARTING_OUT_WHY);
  const concept = DAY_READ_REQUIRED_CONCEPT.starting_out_day;
  assert.ok(concept, "day one declares its required idea");
  for (const text of [...STARTING_OUT_WHY, ...STARTING_OUT_DAY.reasons]) {
    assert.equal(violatesReadingGrammar(text), null, `"${text}" breaks the reading grammar`);
    assert.match(text, concept, `"${text}" lost the idea that this is the start`);
  }
  for (const text of DAY_READ_STARTING_OUT_HEADLINE_VARIANTS) {
    assert.equal(violatesReadingGrammar(text), null, `"${text}" breaks the reading grammar`);
  }
});

// ---------- the program digest ----------

test("with no plan and no history the program digest critiques nothing", () => {
  const adj = repo.programAdjustments();
  assert.deepEqual(
    adj.filter((a) => a.kind === "gap" || a.kind === "balance"),
    [],
    "no 'add core / grip / mobility' notes on a program that does not exist, no 'due' groups for someone who has not started"
  );
});

test("the mobility gap never calls a lifter a returning runner", () => {
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
  const mobility = repo.programAdjustments().find((a) => a.kind === "gap" && a.group === "mobility");
  assert.ok(mobility, "the gap floor still speaks once there is a program");
  assert.doesNotMatch(mobility.why, /runner|runs/i);
});

// ---------- the scheduler ----------

test("the monthly whole-person revision waits for a record: the tick checks history before claiming a slot", () => {
  const src = fs.readFileSync(path.join(root, "src/scheduler.ts"), "utf8");
  const tick = src.slice(src.indexOf("const revisionTick = () => {"));
  const guard = tick.indexOf("if (!hasLoggedHistory())");
  const claim = tick.indexOf('claimSchedulerOperationWithStatus("brain_revision_conference"');
  assert.ok(guard > 0, "the revision tick consults the logged history");
  assert.ok(claim > guard, "and it does so before any slot is claimed or job queued");
});

// ---------- the REST surface ----------

function routeHandler(router, method, routePath) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route?.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} is registered`);
  return layer.route.stack[0].handle;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
  return res;
}

test("POST /welcome queues a durable `welcome` job; a blank body is a 400 with the designed shape", () => {
  const handler = routeHandler(personContextRouter, "post", "/welcome");
  const blank = fakeRes();
  handler({ body: { text: "   " } }, blank, (err) => {
    throw err;
  });
  assert.equal(blank.statusCode, 400);
  assert.deepEqual(blank.payload, { ok: false, error: "text required", tried: [] });

  const queued = fakeRes();
  handler({ body: { text: "I want to get stronger.", agent: "nobody-installed" } }, queued, (err) => {
    throw err;
  });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.payload.ok, true);
  assert.equal(queued.payload.job.kind, "welcome");
  assert.equal(queued.payload.job.input.text, "I want to get stronger.");
});

test("POST /agents/:name/verify is registered on the operator router", () => {
  routeHandler(operatorRouter, "post", "/agents/:name/verify");
});

test("settings expose coach_welcomed (default off) and each agent's tile copy", () => {
  assert.equal(repo.getSettings().coach_welcomed, false);
  repo.setSettings({ coach_welcomed: true });
  assert.equal(repo.getSettings().coach_welcomed, true);
  const agents = repo.getAgentConfig();
  for (const a of agents) {
    assert.ok("label" in a && "plan" in a, `${a.name} carries label/plan`);
    for (const k of ["usable", "present", "installable", "can_login", "description"])
      assert.ok(k in a, `${a.name}.${k}`);
  }
  const claude = agents.find((a) => a.name === "claude");
  if (claude) assert.deepEqual([claude.label, claude.plan], ["Claude", "Claude Pro or Max"]);
  const stub = agents.find((a) => a.name === "stub");
  if (stub) assert.equal(stub.plan, null, "the offline stub is never a provider tile");
});

// ---------- the migration ----------

test("v122 adds coach_welcomed and marks an already-onboarded install welcomed (idempotently)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MIGRATIONS_101_150 } = await import("../dist/migrations/v101-150.js");
  const m = MIGRATIONS_101_150.find((x) => x.version === 122);
  assert.ok(m, "migration 122 exists");
  const onboarded = new DatabaseSync(":memory:");
  onboarded.exec(
    "CREATE TABLE settings (id INTEGER PRIMARY KEY, onboarded INTEGER DEFAULT 0); INSERT INTO settings (id, onboarded) VALUES (1, 1);"
  );
  m.up(onboarded);
  m.up(onboarded);
  assert.equal(
    onboarded.prepare("SELECT coach_welcomed FROM settings").get().coach_welcomed,
    1,
    "a long-standing install is never greeted again"
  );
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(
    "CREATE TABLE settings (id INTEGER PRIMARY KEY, onboarded INTEGER DEFAULT 0); INSERT INTO settings (id) VALUES (1);"
  );
  m.up(fresh);
  assert.equal(
    fresh.prepare("SELECT coach_welcomed FROM settings").get().coach_welcomed,
    0,
    "a fresh install still meets its coach"
  );
  m.up(new DatabaseSync(":memory:")); // no settings table yet: a no-op, never a throw
});
