// The case conference convenes its seats under the host's spawn cap.
//
// Live (90 days to 2026-10-16) only 55 of 95 requested specialist opinions reached the
// conductor, and 39 of the 40 missing were the conference's own scheduling: all seats
// fanned out at once against a cap of two permits with one 300 s deadline that started
// at the fan-out, so seats three to five spent it in the permit queue — 29 finished a
// valid opinion after being written off (still holding a permit), 10 never spawned.
// These pin the fix: a bounded pool, a seat clock that starts when the seat starts,
// agent_busy as a bounded deferral (never a failed seat), a reason code for every
// missing seat, and a deadline that kills what it abandons.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFERENCE_SPECIALIST_BUDGET_MS,
  CONFERENCE_SPECIALIST_TURN_MS,
  conferenceQuorum,
  runCaseConference,
} from "../dist/domain/brain/case-conference.js";
import { getBrainDecision } from "../dist/repo/brain-decisions.js";
import { AgentFallbackError, agentSlotStats, runAgent } from "../dist/agents.js";
import { AGENT_BUSY_MAX_DEFERRALS, AgentBusyError, isAgentBusyError } from "../dist/agent-busy.js";
import { runChosenWithCoachReads } from "../dist/runChosen.js";
import { applyCaseConferenceSchedulerSuccess } from "../dist/agentJobs.js";
import { db, repo } from "./_seed.js";

const opinion = (domain, overrides = {}) => ({
  domain,
  recommendation: "Keep the change bounded.",
  rationale: "The shared snapshot supports a cautious next step.",
  evidence_keys: [`${domain}:evidence`],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "ask",
  ...overrides,
});

const decision = (overrides = {}) => ({
  kind: "case_conference",
  domain: "cross_domain",
  summary: "Keep the next change bounded.",
  rationale: "The shared snapshot supports one reversible step.",
  risk_class: "low",
  reversible: true,
  autonomy_tier: "announce",
  parallel_actions: [],
  resolved_conflicts: [],
  deferred: [],
  expectations: [],
  review_window: "Review in two weeks.",
  user_explanation: "I am keeping the next step bounded.",
  revision: null,
  ...overrides,
});

// A healthy athlete: nothing fires a conflict, so a full conference is COMPLETE.
const context = () => ({
  goal_mode: "gain",
  goal: { ok: true, goal_mode: "gain", tdee: 2_800, effective_target: { target_kcal: 3_050 } },
  cut_quality: { active: false },
  signal_state: {
    dimensions: { recovery_capacity: { status: "supportive", reason: "Sleep and HRV both read normal." } },
    action: { readiness: "ready", directives: { training: "proceed", fueling: "normal", schedule: "normal" } },
  },
  context_events: [],
  training_signals: { progression: [], autoregulation: null },
  progression: [],
  health: [],
  supplements: [],
  directives: [],
  health_focus: { priorities: [], surfaced: [], lead: null, act_now: 0, track: 0 },
  profile: { allergies: null },
  family: [],
  meal_plan: null,
  day_intake: { count: 0 },
  endurance_goal: null,
  training_intent: { priorities: ["muscle", "strength"], endurance_role: "none" },
  discipline: { primary: "strength", endurance_sport: null },
});

const base = (overrides = {}) => ({
  context,
  symptomAreas: () => [],
  busyRestMs: 0,
  conductorRun: async () => decision(),
  ...overrides,
});

const outcomeFor = (result, domain) => result.specialist_outcomes.find((o) => o.domain === domain);

test("the seat leash: two turns of the background ceiling, so congestion surfaces before the deadline", () => {
  assert.equal(CONFERENCE_SPECIALIST_TURN_MS, 300_000);
  assert.equal(CONFERENCE_SPECIALIST_BUDGET_MS, 600_000);
  assert.equal(conferenceQuorum(5), 3);
  assert.equal(conferenceQuorum(2), 1);
  assert.equal(conferenceQuorum(1), 1);
});

test("all seats healthy: a complete conference with an ok outcome for every requested seat", async () => {
  const leashes = [];
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      specialistRun: async (_agent, _prompt, domain, _snapshot, _calls, leash) => {
        leashes.push(leash);
        return opinion(domain);
      },
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.degraded, undefined);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.unavailable_reasons, {});
  assert.deepEqual(
    result.specialist_outcomes.map((o) => [o.domain, o.reason, o.attempts, o.busy_deferrals]),
    [
      ["training", "ok", 1, 0],
      ["nutrition", "ok", 1, 0],
      ["recovery", "ok", 1, 0],
    ]
  );
  assert.deepEqual(result.conductor_outcome, { reason: "ok", detail: null, busy_deferrals: 0 });
  // Each seat is handed its own budget and per-turn leash — not one fan-out-wide clock.
  for (const leash of leashes) assert.deepEqual(leash, { timeoutMs: 600_000, turnTimeoutMs: 300_000 });
  // …and the scheduler counts it complete.
  const slot = "e".repeat(64);
  const claim = repo.claimSchedulerOperation("brain_revision_conference", slot, {
    maxAttempts: 3,
    leaseMs: 6 * 60 * 60_000,
  });
  assert.equal(
    applyCaseConferenceSchedulerSuccess(
      {
        domains: ["training", "nutrition", "recovery"],
        scheduler_success: { brain_revision_last_month: "2026-07" },
        scheduler_operation: {
          operation: claim.operation,
          slot_stamp: claim.slot_stamp,
          claim_token: claim.claim_token,
          attempts: claim.attempts,
        },
      },
      result
    ),
    true
  );
});

test("agent_busy defers and retries the seat — it never fails it", async () => {
  const calls = { training: 0, nutrition: 0, recovery: 0 };
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      specialistRun: async (_agent, _prompt, domain) => {
        calls[domain] += 1;
        if (domain === "recovery" && calls.recovery <= 2) throw new AgentBusyError("claude", 300_000);
        return opinion(domain);
      },
    })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.unavailable, [], "the congested seat still delivered");
  const recovery = outcomeFor(result, "recovery");
  assert.equal(recovery.reason, "ok");
  assert.equal(recovery.busy_deferrals, 2);
  assert.equal(recovery.attempts, 3);
  assert.equal(calls.training, 1, "a busy seat never re-runs its neighbours");
});

test("persistent congestion is bounded: the seat is recorded host_busy, the others complete", async () => {
  let recoveryCalls = 0;
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      specialistRun: async (_agent, _prompt, domain) => {
        if (domain === "recovery") {
          recoveryCalls += 1;
          throw new AgentBusyError("claude", 300_000);
        }
        return opinion(domain);
      },
    })
  );
  assert.equal(recoveryCalls, AGENT_BUSY_MAX_DEFERRALS + 1, "bounded: one try plus the deferrals");
  assert.equal(result.ok, true);
  assert.deepEqual(result.unavailable, ["recovery"]);
  assert.deepEqual(result.unavailable_reasons, { recovery: "host_busy" });
  const recorded = getBrainDecision(result.recorded_decision_id);
  assert.deepEqual(recorded.context.unavailable_reasons, { recovery: "host_busy" });
});

test("every seat congested is a non-event for the job: it throws agent_busy so the runner defers", async () => {
  await assert.rejects(
    runCaseConference(
      "stub",
      { question: "Review the plan.", domains: ["training", "nutrition"] },
      base({
        specialistRun: async () => {
          throw new AgentBusyError("claude", 300_000);
        },
      })
    ),
    (error) => isAgentBusyError(error)
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
});

test("one seat timing out degrades with its reason; the others complete and the decision says why", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      specialistRun: async (_agent, _prompt, domain) => {
        if (domain === "recovery") throw new Error("coach read run timed out");
        return opinion(domain);
      },
      conductorRun: async () => ({ malformed: true }),
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.unavailable_reasons, { recovery: "deadline" });
  assert.equal(result.conductor_outcome.reason, "invalid_decision");
  assert.ok(
    result.decision.deferred.includes("recovery specialist unavailable (deadline)"),
    "the advice-only fallback names the missing seat and why"
  );
  // The scheduler's retry is recorded under the REAL cause, seat by seat.
  const slot = "d".repeat(64);
  const claim = repo.claimSchedulerOperation("brain_revision_conference", slot, {
    maxAttempts: 3,
    leaseMs: 6 * 60 * 60_000,
  });
  assert.ok(claim);
  assert.equal(
    applyCaseConferenceSchedulerSuccess(
      {
        domains: ["training", "nutrition", "recovery"],
        scheduler_success: { brain_revision_last_month: "2026-07" },
        scheduler_operation: {
          operation: claim.operation,
          slot_stamp: claim.slot_stamp,
          claim_token: claim.claim_token,
          attempts: claim.attempts,
        },
      },
      { ...result, degraded: false, decision: decision(), unresolved_conflicts: [] }
    ),
    false
  );
  assert.match(
    repo.getSchedulerOperation("brain_revision_conference", slot).last_error,
    /unavailable: recovery\(deadline\)/
  );
});

test("a rotation that exhausted every provider is recorded with what the providers said", async () => {
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      specialistRun: async (_agent, _prompt, domain) => {
        if (domain === "nutrition")
          throw new AgentFallbackError(
            ["claude", "codex"],
            [
              {
                agent: "claude",
                error: "weekly limit",
                availability: { state: "quota_exhausted", resets_at: null, hold_until: null, detail: null },
              },
              {
                agent: "codex",
                error: "weekly limit",
                availability: { state: "quota_exhausted", resets_at: null, hold_until: null, detail: null },
              },
            ]
          );
        if (domain === "recovery")
          throw new AgentFallbackError(
            ["claude"],
            [{ agent: "claude", error: 'agent "claude" timed out after 300000ms' }]
          );
        return opinion(domain);
      },
    })
  );
  assert.equal(outcomeFor(result, "nutrition").reason, "providers_exhausted");
  assert.equal(outcomeFor(result, "nutrition").detail, "quota_exhausted");
  assert.equal(outcomeFor(result, "recovery").detail, "timeout");
});

test("below quorum the conductor is not convened and the deterministic floors hold", async () => {
  let conductorCalled = false;
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      specialistRun: async (_agent, _prompt, domain) => {
        if (domain !== "training") throw new Error("coach read run timed out");
        return opinion(domain);
      },
      conductorRun: async () => {
        conductorCalled = true;
        return decision();
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(conductorCalled, false, "one seat of three is not a case conference");
  assert.equal(result.quorum, 2);
  assert.match(result.error, /quorum not met \(1 of 3 specialists\)/);
  assert.equal(result.conductor_outcome.detail, "below_quorum");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM brain_decisions`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM plan_proposals`).get().n, 0);
});

test("bounded: never more seats in flight than the pool, and a seat that would overrun the phase is not convened", async () => {
  let live = 0;
  let peak = 0;
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "health", "recovery", "lifestyle"] },
    base({
      concurrency: 2,
      specialistRun: async (_agent, _prompt, domain) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 15));
        live -= 1;
        return opinion(domain);
      },
    })
  );
  assert.equal(peak, 2, "five seats on a pool of two never run three at once");
  assert.equal(result.opinions.length, 5);

  // A fake clock: every seat takes two whole budgets of wall time. The phase holds
  // ceil(3/1) budgets plus one congestion allowance, so the third seat no longer fits.
  let now = 0;
  let runs = 0;
  const bounded = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
    base({
      concurrency: 1,
      specialistBudgetMs: 1_000,
      clock: () => now,
      specialistRun: async (_agent, _prompt, domain) => {
        runs += 1;
        now += 2_000;
        return opinion(domain);
      },
    })
  );
  assert.equal(runs, 2);
  assert.deepEqual(bounded.unavailable_reasons, { recovery: "not_convened" });
  assert.equal(outcomeFor(bounded, "recovery").attempts, 0, "never started late");
});

test("a congested conductor is deferred, not degraded", async () => {
  let conductorCalls = 0;
  const result = await runCaseConference(
    "stub",
    { question: "Review the plan.", domains: ["training", "nutrition"] },
    base({
      specialistRun: async (_agent, _prompt, domain) => opinion(domain),
      conductorRun: async () => {
        conductorCalls += 1;
        if (conductorCalls === 1) throw new AgentBusyError("claude", 300_000);
        return decision();
      },
    })
  );
  assert.equal(result.degraded, undefined);
  assert.deepEqual(result.conductor_outcome, { reason: "ok", detail: null, busy_deferrals: 1 });
});

test("the bounded-read deadline aborts the turn it abandons instead of orphaning it", async () => {
  let seenSignal = null;
  await assert.rejects(
    runChosenWithCoachReads(
      "auto",
      "BASE",
      { timeoutMs: 40, turnTimeoutMs: 30 },
      {},
      {
        run: (_agent, _prompt, opts) => {
          seenSignal = opts.signal;
          assert.equal(opts.timeoutMs, 30, "one turn's leash is capped by turnTimeoutMs");
          return new Promise(() => {});
        },
        createRunId: () => "run-orphan",
      }
    ),
    /timed out/
  );
  assert.equal(seenSignal.aborted, true, "the abandoned turn's CLI is killed and its permit released");
});

// ---------- against real subprocesses ----------

function fixtureAgents(logPath, sleeps) {
  const cases = Object.entries(sleeps)
    .map(([key, sec]) => `${key}) sleep ${sec};;`)
    .join(" ");
  const script =
    `p=$(cat); d=none; case "$p" in *HOLD_THE_PERMIT*) d=hold;; esac; ` +
    `for x in training nutrition recovery health lifestyle endurance; do case "$p" in *"exactly \\"$x\\""*) d=$x;; esac; done; ` +
    `printf 'start %s\\n' "$d" >> '${logPath}'; case "$d" in ${cases} *) sleep 0.2;; esac; ` +
    `printf 'end %s\\n' "$d" >> '${logPath}'; ` +
    `printf '{"domain":"%s","recommendation":"Keep it bounded.","rationale":"The snapshot supports a cautious step.",` +
    `"evidence_keys":["%s:evidence"],"risks":[],"contraindications":[],"uncertainties":[],"expected_outcomes":[],` +
    `"autonomy_ceiling":"ask"}' "$d" "$d"`;
  return {
    fixture: {
      command: "sh",
      args: ["-c", script],
      input: "stdin",
      description: "Fake specialist CLI for the conference reliability test.",
      env_required: [],
      login: null,
      status_check: null,
      auth_state: null,
      models_list: null,
      model_flag: ["--model", "{model}"],
      capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      reasoning_flag: null,
    },
  };
}

function readLog(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  let live = 0;
  let peak = 0;
  for (const line of lines) {
    const [event, name] = line.split(" ");
    if (name === "hold") continue;
    live += event === "start" ? 1 : -1;
    peak = Math.max(peak, live);
  }
  return { lines, peak };
}

async function withFakeCli(sleeps, limit, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-conference-"));
  const logPath = path.join(dir, "spawns.log");
  fs.writeFileSync(logPath, "");
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(fixtureAgents(logPath, sleeps), null, 2));
  const priorConfig = process.env.AGENTS_CONFIG;
  const priorLimit = process.env.CAIRN_MAX_AGENT_PROCS;
  process.env.AGENTS_CONFIG = configPath;
  process.env.CAIRN_MAX_AGENT_PROCS = String(limit);
  try {
    return await fn({ read: () => readLog(logPath) });
  } finally {
    if (priorConfig === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = priorConfig;
    if (priorLimit === undefined) delete process.env.CAIRN_MAX_AGENT_PROCS;
    else process.env.CAIRN_MAX_AGENT_PROCS = priorLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function settledSlots() {
  for (let i = 0; i < 40 && agentSlotStats().active > 0; i++) await new Promise((r) => setTimeout(r, 25));
  return agentSlotStats().active;
}

test("fake CLI: a wedged seat is killed at its leash and recorded; the pool holds the cap; the rest complete", async () => {
  await withFakeCli({ recovery: 30 }, 2, async ({ read }) => {
    const started = Date.now();
    const result = await runCaseConference(
      "fixture",
      { question: "Review the plan.", domains: ["training", "nutrition", "recovery"] },
      base({ specialistBudgetMs: 1_600 })
    );
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.opinions.map((o) => o.domain),
      ["training", "nutrition"]
    );
    assert.equal(outcomeFor(result, "recovery").reason, "providers_exhausted");
    assert.equal(outcomeFor(result, "recovery").detail, "timeout", "killed at its 800 ms turn leash, not left running");
    assert.ok(elapsed < 10_000, `bounded by the seat budget, not the wedged CLI (${elapsed} ms)`);
    const { lines, peak } = read();
    assert.ok(peak <= 2, `never more than the cap of specialist CLIs alive together (saw ${peak})`);
    assert.ok(!lines.includes("end recovery"), "the wedged CLI never ran to completion");
    assert.equal(await settledSlots(), 0, "every permit is back: nothing orphaned");
  });
});

test("fake CLI: a seat queued behind another lane's permit defers on agent_busy and still delivers", async () => {
  await withFakeCli({ hold: 1.2 }, 1, async () => {
    // Another lane (say, the day-read precompute) holds the host's only permit.
    const holder = runAgent("fixture", "HOLD_THE_PERMIT", { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await runCaseConference(
      "fixture",
      { question: "Review the plan.", domains: ["training", "nutrition"] },
      base({ specialistBudgetMs: 800, busyRestMs: 50 })
    );
    await holder;
    assert.equal(result.ok, true);
    assert.deepEqual(result.unavailable, [], "congestion cost time, never a seat");
    const training = outcomeFor(result, "training");
    assert.equal(training.reason, "ok");
    assert.ok(training.busy_deferrals >= 1, `the queued seat deferred (saw ${training.busy_deferrals})`);
    assert.equal(await settledSlots(), 0);
  });
});
