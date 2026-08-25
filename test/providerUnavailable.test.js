// PROVIDER EXHAUSTION IS AVAILABILITY, NOT A CODE DEFECT.
//
// Live shape: claude at its weekly limit, codex at its usage limit, grok out of credit.
// Three nightly jobs reported `scheduler:task_failure:<slot>:Error` — the class was lost
// at four separate hand-offs between `runAgentWithFallback` and telemetry — and the
// retry ladder went back for more fifteen minutes later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { recordProviderUnavailable, recordSchedulerFailure } from "../dist/diagnostics.js";
import {
  dominantAvailabilityState,
  isProviderUnavailable,
  PROVIDER_UNAVAILABLE_MIN_BACKOFF_MS,
  ProviderUnavailableError,
  providerRetryAfterMs,
  schedulerTaskError,
} from "../dist/provider-unavailable.js";

const at = (iso) => new Date(iso);

test("the dominant availability state prefers the agent layer's own class", () => {
  const tried = [
    { agent: "claude", error: "process_exit", availability: { state: "usage_limit", resets_at: null } },
    { agent: "codex", error: "process_exit", availability: { state: "usage_limit" } },
    { agent: "grok", error: "timeout" },
  ];
  assert.equal(dominantAvailabilityState(tried), "usage_limit");
});

test("with no availability class it falls back to the agent error taxonomy, never to raw text", () => {
  const tried = [
    { agent: "claude", error: "auth_required" },
    { agent: "codex", error: "the CLI said something long and specific about /Users/someone" },
  ];
  const state = dominantAvailabilityState(tried);
  // Ties break alphabetically so the fingerprint is stable run to run.
  assert.equal(state, "auth_required");
  assert.doesNotMatch(state, /Users|specific/);
});

test("an unconfigured pool and an empty attempt list each name themselves", () => {
  assert.equal(dominantAvailabilityState([], "unconfigured"), "unconfigured");
  assert.equal(dominantAvailabilityState(null), "no_agent");
  assert.equal(isProviderUnavailable({ agent_status: "all_failed" }), true);
  assert.equal(isProviderUnavailable({ agent_status: "unconfigured" }), true);
  assert.equal(isProviderUnavailable({ agent_status: "ok" }), false);
  assert.equal(isProviderUnavailable(null), false);
});

test("a reset stamp in the past or the future is read carefully", () => {
  const now = Date.parse("2026-08-25T10:00:00Z");
  assert.equal(providerRetryAfterMs([{ availability: { resets_at: "2026-08-25T09:00:00Z" } }], now), null);
  assert.equal(providerRetryAfterMs([{ availability: { resets_at: "not a date" } }], now), null);
  assert.equal(
    providerRetryAfterMs(
      [
        { availability: { resets_at: "2026-08-26T10:00:00Z" } },
        { availability: { hold_until: "2026-08-25T12:00:00Z" } },
      ],
      now
    ),
    2 * 60 * 60 * 1000,
    "the earliest provider back on its feet sets the wait"
  );
});

test("the typed error carries taxonomy only, never the op's free-text error", () => {
  const error = schedulerTaskError(
    "insight_last_date",
    {
      ok: false,
      error: "claude: 429 weekly limit reached for /Users/someone; codex: usage limit",
      agent_status: "all_failed",
      tried: [{ agent: "claude", error: "process_exit", availability: { state: "usage_limit" } }],
    },
    "insight provider unavailable"
  );
  assert.ok(error instanceof ProviderUnavailableError);
  assert.equal(error.name, "ProviderUnavailableError");
  assert.equal(error.dominantState, "usage_limit");
  assert.doesNotMatch(error.message, /429|Users|weekly limit/);
});

test("a failure that is NOT about availability keeps the ordinary error", () => {
  const error = schedulerTaskError(
    "insight_last_date",
    { ok: false, error: "no genuine insight", agent_status: "ok" },
    "x"
  );
  assert.equal(error instanceof ProviderUnavailableError, false);
  assert.equal(error.name, "Error");
});

test("provider exhaustion is recorded as availability, with its class in the fingerprint", () => {
  const events = [];
  const error = new ProviderUnavailableError("weekly_read_last_slot", {
    agent_status: "all_failed",
    tried: [{ agent: "claude", error: "process_exit", availability: { state: "usage_limit" } }],
  });
  recordProviderUnavailable("weekly_read_last_slot", error, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "provider_unavailable");
  assert.equal(events[0].level, "warning", "an outage is not a defect an operator can fix in code");
  assert.equal(events[0].fingerprint, "scheduler:provider_unavailable:weekly_read_last_slot:usage_limit");

  // The contrast: a real bug still lands as an error with its class named.
  const failures = [];
  recordSchedulerFailure("weekly_read_last_slot", new TypeError("x is not a function"), (event) =>
    failures.push(event)
  );
  assert.equal(failures[0].level, "error");
  assert.equal(failures[0].fingerprint, "scheduler:task_failure:weekly_read_last_slot:TypeError");
});

// ---------- the durable ladder ----------

test("the run result hands back the thrown error itself, not only the sanitized line", async () => {
  const result = await repo.runSchedulerOperation(
    "insight_last_date",
    "2026-08-25",
    async () => {
      throw new ProviderUnavailableError("insight_last_date", {
        agent_status: "all_failed",
        tried: [{ agent: "claude", error: "process_exit", availability: { state: "usage_limit" } }],
      });
    },
    { now: at("2026-08-25T04:00:00Z") }
  );
  assert.equal(result.status, "retry_wait");
  assert.ok(result.cause instanceof ProviderUnavailableError, "the class survives to the caller that reports it");
  assert.equal(result.cause.dominantState, "usage_limit");
});

test("a provider outage waits hours for the next attempt instead of retrying within the hour", async () => {
  const now = at("2026-08-25T04:00:00Z");
  const result = await repo.runSchedulerOperation(
    "weekly_read_last_slot",
    "2026-08-24",
    async () => {
      throw new ProviderUnavailableError("weekly_read_last_slot", {
        agent_status: "all_failed",
        tried: [{ agent: "claude", error: "process_exit", availability: { state: "usage_limit" } }],
      });
    },
    { now }
  );
  const waitMs = Date.parse(result.operation.next_retry_at) - now.getTime();
  assert.ok(
    waitMs >= PROVIDER_UNAVAILABLE_MIN_BACKOFF_MS,
    `expected at least the provider floor, waited ${Math.round(waitMs / 60000)} min`
  );
});

test("a provider that says when it resets is waited out until then", async () => {
  const now = at("2026-08-25T04:00:00Z");
  const resetsAt = "2026-08-25T20:00:00Z"; // 16 h out, past the 4 h floor
  const result = await repo.runSchedulerOperation(
    "meal_plan_refresh_last_slot",
    "2026-08-24",
    async () => {
      throw new ProviderUnavailableError(
        "meal_plan_refresh_last_slot",
        {
          agent_status: "all_failed",
          tried: [
            { agent: "claude", error: "process_exit", availability: { state: "usage_limit", resets_at: resetsAt } },
          ],
        },
        now.getTime()
      );
    },
    { now }
  );
  assert.equal(Date.parse(result.operation.next_retry_at), Date.parse(resetsAt));
});

test("an ordinary failure keeps the ordinary ladder, and an explicit schedule always wins", async () => {
  const now = at("2026-08-25T04:00:00Z");
  const ordinary = await repo.runSchedulerOperation(
    "program_evolution_last_slot",
    "2026-08-24",
    async () => {
      throw new Error("the draft was unusable");
    },
    { now }
  );
  const ordinaryWait = Date.parse(ordinary.operation.next_retry_at) - now.getTime();
  assert.equal(ordinaryWait, 15 * 60 * 1000, "a transient fault still retries in fifteen minutes");

  const pinned = await repo.runSchedulerOperation(
    "recovery_auto_draft_date",
    "2026-08-25",
    async () => {
      throw new ProviderUnavailableError("recovery_auto_draft_date", { agent_status: "unconfigured", tried: [] });
    },
    { now, backoffMs: [1_000] }
  );
  assert.equal(Date.parse(pinned.operation.next_retry_at) - now.getTime(), 1_000, "a caller's own schedule is kept");
});
