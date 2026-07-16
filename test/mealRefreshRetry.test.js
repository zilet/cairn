import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";

const request = () => localDateISO();

beforeEach(() => {
  repo.setAppState(repo.MEAL_REFRESH_REQUEST_KEY, request());
  repo.setAppState(repo.MEAL_REFRESH_INSTRUCTION_KEY, "reshape the week without changing the target");
});

test("ok:false remains owned and retries after bounded backoff until success", async () => {
  const first = await repo.runOwnedMealRefreshAttempt(request(), async () => ({ ok: false, error: "agent unavailable" }));
  assert.equal(first.attempted, true);
  assert.equal(first.ok, false);
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY), request(), "failure never clears the owner request");
  const failed = repo.getMealRefreshAttemptState();
  assert.equal(failed.count, 1);
  assert.match(failed.last_error, /agent unavailable/i);
  assert.ok(failed.next_attempt_at);
  assert.equal(repo.mealRefreshRetryDue(request(), new Date(Date.parse(failed.next_attempt_at) - 1)), false);

  const second = await repo.runOwnedMealRefreshAttempt(
    request(),
    async () => ({ ok: true, proposal: { id: 42 } }),
    { now: new Date(Date.parse(failed.next_attempt_at) + 1), today: request() },
  );
  assert.equal(second.ok, true);
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY), "");
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_INSTRUCTION_KEY), "");
  assert.equal(repo.getMealRefreshAttemptState().count, 2);
  assert.equal(repo.getMealRefreshAttemptState().last_error, null);
  const success = JSON.parse(repo.getAppState(repo.MEAL_REFRESH_SUCCESS_KEY));
  assert.equal(success.request, request());
  assert.equal(success.attempts, 2);
});

test("a thrown attempt remains retryable and a later success clears it", async () => {
  const first = await repo.runOwnedMealRefreshAttempt(request(), async () => {
    throw new Error("cli crashed");
  });
  assert.equal(first.ok, false);
  const failed = repo.getMealRefreshAttemptState();
  assert.match(failed.last_error, /cli crashed/i);
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY), request());

  const retried = await repo.runOwnedMealRefreshAttempt(
    request(),
    async () => ({ ok: true }),
    { now: new Date(Date.parse(failed.next_attempt_at) + 1), today: request() },
  );
  assert.equal(retried.ok, true);
  assert.equal(repo.getAppState(repo.MEAL_REFRESH_REQUEST_KEY), "");
});

test("the persisted lease prevents duplicate simultaneous agent jobs", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = repo.runOwnedMealRefreshAttempt(request(), async () => {
    calls++;
    await gate;
    return { ok: true };
  });
  await Promise.resolve();
  const duplicate = await repo.runOwnedMealRefreshAttempt(request(), async () => {
    calls++;
    return { ok: true };
  });
  assert.equal(duplicate.attempted, false);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).ok, true);
});
