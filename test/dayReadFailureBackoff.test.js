// The day-read self-heal's FAILURE BACKOFF (src/dayread-refresh.ts). An open of a floor
// row re-arms ensureDayReadRefresh, so a day whose agent keeps breaking its reply contract
// used to pay a two-spawn retry (reply + its one repair) on every open. After a failed
// agent attempt the self-heal for that date and call stays disarmed for 30 minutes.
// Pinned here, with the real offline `stub` CLI as the failing agent (it answers with a
// proposal, never a day read): the failure disarms the self-heal; a different identity,
// a signal-driven refresh and the expiry of the window all still arm; a success clears
// it; host congestion (AgentBusyError) never counts as a failure.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";
import { computeCanonicalDayRead, dayReadAgentAttemptFailed } from "../dist/dayread.js";
import { readToday } from "../dist/domain/brain/day-read-use-case.js";
import {
  clearDayReadAgentFailure,
  configureDayReadRefresh,
  DAY_READ_FAILURE_BACKOFF_MINUTES,
  dayReadSelfHealCoolingDown,
  ensureDayReadRefresh,
  noteDayReadAgentFailure,
  resetDayReadRefresh,
  scheduleDayReadRefresh,
} from "../dist/dayread-refresh.js";
import { AgentBusyError } from "../dist/agent-busy.js";
import { AgentFallbackError } from "../dist/agents.js";

// Fake timer + clock: a timer is only counted, never fired, so no recompute runs.
function install(date, state) {
  configureDayReadRefresh({
    today: () => date,
    now: () => state.clock,
    setTimer: () => {
      state.armed += 1;
      return state.armed;
    },
    clearTimer: () => {},
  });
}

function harness(date) {
  const state = { armed: 0, clock: Date.parse("2026-11-11T08:00:00Z"), identity: null };
  install(date, state);
  // Drop the pending timer the previous step armed so the next ensure is judged on its
  // own. resetDayReadRefresh also empties the failure ledger, so a failure still inside
  // its window is re-noted (every disarm below happens before the clock moves).
  state.disarm = () => {
    const cooling = dayReadSelfHealCoolingDown(date);
    resetDayReadRefresh();
    install(date, state);
    if (cooling) noteDayReadAgentFailure(date, state.identity);
  };
  return state;
}

beforeEach(() => {
  resetTables("day_reads", "suggestions", "brain_decisions", "agent_runs");
});

test("a failing agent attempt disarms the date's self-heal for the backoff window", async () => {
  const date = localDaysAgo(0);
  const state = harness(date);

  const read = await computeCanonicalDayRead({ date, agent: "stub" });
  assert.equal(read.source, "deterministic", "the stub never writes a day read, so the floor stands");
  state.identity = read.prose_identity;
  assert.equal(dayReadSelfHealCoolingDown(date, read.prose_identity), true, "the failure is on the ledger");

  // Every open of that floor row would have re-armed a two-spawn retry. Now: nothing.
  ensureDayReadRefresh(date, read.prose_identity);
  ensureDayReadRefresh(date);
  assert.equal(state.armed, 0, "no self-heal inside the window");

  // A genuinely different call (a new identity) is a new question and still arms.
  ensureDayReadRefresh(date, `${read.prose_identity}|other`);
  assert.equal(state.armed, 1, "an identity change is never held back");
  state.disarm();

  // A signal-driven refresh (an invalidation) is not the self-heal and still arms.
  scheduleDayReadRefresh(date);
  assert.equal(state.armed, 2, "a signal still reaches the agent");
  state.disarm();

  ensureDayReadRefresh(date, read.prose_identity);
  assert.equal(state.armed, 2, "still held after the disarm");

  // Past the window the self-heal arms again.
  state.clock += DAY_READ_FAILURE_BACKOFF_MINUTES * 60_000;
  ensureDayReadRefresh(date, read.prose_identity);
  assert.equal(state.armed, 3, "after 30 minutes the floor heals again");
});

test("the Brief's open of a floor row does not re-arm inside the window", async () => {
  const date = localDaysAgo(0);
  const state = harness(date);
  const read = await computeCanonicalDayRead({ date, agent: "stub" });
  assert.equal(read.source, "deterministic");
  assert.equal(repo.getCachedDayRead(date)?.source, "deterministic", "the floor row is cached");

  await readToday({ date });
  await readToday({ date });
  assert.equal(state.armed, 0, "two opens, zero retries");

  state.clock += DAY_READ_FAILURE_BACKOFF_MINUTES * 60_000 + 1;
  await readToday({ date });
  assert.equal(state.armed, 1, "the first open past the window arms one self-heal");
});

test("the window is per date, and a success clears it", () => {
  const date = localDaysAgo(0);
  const state = harness(date);
  noteDayReadAgentFailure(localDaysAgo(1), "x");
  ensureDayReadRefresh(date);
  assert.equal(state.armed, 1, "another date's failure never holds today's self-heal");

  noteDayReadAgentFailure(date, "x");
  assert.equal(dayReadSelfHealCoolingDown(date, "x"), true);
  clearDayReadAgentFailure(date);
  assert.equal(dayReadSelfHealCoolingDown(date, "x"), false, "a landed agent read clears the backoff");
});

test("host congestion and an empty rotation are not agent failures", () => {
  assert.equal(dayReadAgentAttemptFailed(new AgentBusyError("claude", 1000)), false, "busy keeps defer-and-retry");
  assert.equal(dayReadAgentAttemptFailed({ code: "agent_busy", message: "busy" }), false, "duck-typed busy too");
  assert.equal(
    dayReadAgentAttemptFailed(new AgentFallbackError([], [], "No agents enabled — turn one on in Settings.")),
    false,
    "no agent was asked"
  );
  assert.equal(
    dayReadAgentAttemptFailed(new AgentFallbackError(["claude"], [{ agent: "claude", error: "timed out" }])),
    true
  );
  assert.equal(dayReadAgentAttemptFailed(new Error("reply was outside the requested contract")), true);
});

test("a cancelled run and an all-held rotation are not agent failures", () => {
  // The precompute deadline's own abort (src/scheduler.ts) surfaces as a cancel.
  assert.equal(dayReadAgentAttemptFailed(new Error("canceled")), false, "the loop's own cancel");
  assert.equal(dayReadAgentAttemptFailed(new Error('agent "claude" canceled')), false, "a cancelled spawn");
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    dayReadAgentAttemptFailed(new Error("coach read run timed out"), aborted.signal),
    false,
    "whatever it threw, a run the caller aborted is no verdict on the agent"
  );
  assert.equal(
    dayReadAgentAttemptFailed(new Error("coach read run timed out"), new AbortController().signal),
    true,
    "the run's own deadline (the agent ran out of time) still counts"
  );
  const hold = { state: "rate_limited", resets_at: null, hold_until: "2026-11-11T09:00:00Z", detail: null };
  assert.equal(
    dayReadAgentAttemptFailed(
      new AgentFallbackError(
        ["claude", "codex"],
        [
          { agent: "claude", error: "claude is at its usage limit", availability: hold },
          { agent: "codex", error: "codex is out of credit", availability: { ...hold, state: "out_of_credit" } },
        ]
      )
    ),
    false,
    "every provider held: nothing spawned"
  );
  assert.equal(
    dayReadAgentAttemptFailed(
      new AgentFallbackError(
        ["claude", "codex"],
        [
          { agent: "claude", error: "claude is at its usage limit", availability: hold },
          { agent: "codex", error: "timed out" },
        ]
      )
    ),
    true,
    "one provider held, another really ran and failed"
  );
});

test("an aborted compute leaves the self-heal armed", async () => {
  const date = localDaysAgo(0);
  const state = harness(date);
  const bail = new AbortController();
  bail.abort();
  const read = await computeCanonicalDayRead({ date, agent: "stub", signal: bail.signal });
  assert.equal(read.source, "deterministic");
  assert.equal(dayReadSelfHealCoolingDown(date, read.prose_identity), false, "a cancel is not on the ledger");
  ensureDayReadRefresh(date, read.prose_identity);
  assert.equal(state.armed, 1, "the next open still heals");
});
