import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = readFileSync(path.join(root, "src/client/today-screen.ts"), "utf8");
const todayBridges = readFileSync(path.join(root, "src/client/today-compatibility-bridges.ts"), "utf8");
const todayDataLoader = readFileSync(path.join(root, "src/client/today-data-loader.ts"), "utf8");
const todayPlanSessionData = readFileSync(path.join(root, "src/client/today-plan-session-data-client.ts"), "utf8");
const todayPlanSessionPreparation = readFileSync(path.join(root, "src/client/today-plan-session-preparation.ts"), "utf8");
const todayProgressionController = readFileSync(path.join(root, "src/client/today-progression-controller.ts"), "utf8");
const todaySessionSetActions = readFileSync(path.join(root, "src/client/today-session-set-actions.ts"), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("Today starts non-dependent summary reads before later render work", () => {
  assert.match(todayDataLoader, /const\s+statsPromise\s*=/);
  assert.match(todayDataLoader, /const\s+profilePromise\s*=/);
  assert.match(todayDataLoader, /const\s+exercisesPromise\s*=/);
  assert.match(todayDataLoader, /Promise\.all\(\[[\s\S]*statsPromise,[\s\S]*profilePromise,[\s\S]*exercisesPromise,[\s\S]*\]\)/);
  assert.match(today, /todayDataLoader\.load/);
});

test("Today starts plan and session requests together on the cold path", () => {
  assert.match(todayDataLoader, /deps\.cachedApi\("\/today\?date="/, "cold path tries the aggregate first");
  const planPromise = todayDataLoader.indexOf("const planPromise");
  const sessionPromise = todayDataLoader.indexOf("const sessionPromise");
  const awaitBoth = todayDataLoader.indexOf("const [plan, session, stats, profile, exercises] = await Promise.all");
  const assignPlan = todayDataLoader.indexOf("deps.state.plan = plan as unknown[]");
  assert.ok(planPromise > -1, "plan promise is started explicitly");
  assert.ok(sessionPromise > planPromise, "session promise starts immediately after plan promise");
  assert.ok(awaitBoth > sessionPromise, "plan and session are awaited together");
  assert.ok(assignPlan > awaitBoth, "plan state is assigned after both independent reads are in flight");
  assert.match(todayDataLoader, /if\s*\(!aggregate\)\s*\{[\s\S]*revalidate\("\/plan", "plan"\);[\s\S]*revalidate\("\/sessions\?date="/, "independent SWR revalidation stays as aggregate fallback");
});

test("Today SWR-caches progression and invalidates it when set truth changes", () => {
  assert.match(todayPlanSessionData, /deps\.cachedApi\("\/program\/progression\?day="/);
  assert.match(todayPlanSessionData, /key:\s*`program:progression:\$\{day\}`/);
  assert.match(todayPlanSessionPreparation, /todayPlanSessionData\.loadPrescriptions/);
  assert.match(today, /todayPlanSessionPreparation\.preparePlanSession/);
  assert.match(today, /invalidateTodayProgression/);
  assert.match(todayBridges, /invalidateTodayProgression\(\)/);
  assert.match(todayBridges, /CairnTodayProgressionController\.invalidateTodayProgression\(progressionDeps\(\)\)/);
  assert.match(todayProgressionController, /function progressionKey\(day: string \| number\): string/);
  assert.match(todayProgressionController, /deps\.invalidate\(progressionKey\(deps\.state\.day\)\)/);
  assert.ok((todaySessionSetActions.match(/invalidateSetTruth\(deps\)/g) || []).length >= 2, "set create/delete paths invalidate progression");
});

// The set is on the card before the write leaves the device — the athlete just did
// it, so it is not the set that's in doubt, it's the network. The contract this
// pins is the reconciliation: adopt the server row on success, roll the card back
// on a real failure, and KEEP a queued chip (the outbox holds it durably, and
// blanking it there is what read as "the app ate my set").
test("Today set logging mutates the card BEFORE the POST, and reconciles after", () => {
  const body = functionBody(todaySessionSetActions, "wireLogRow");
  const chipAppend = body.indexOf("appendPendingChip(card, payload.body, deps)");
  const mutation = body.indexOf("await runtime.runSessionMutation");
  const errorGuard = body.indexOf("!result || result.ok === false || result.error || result.id == null");
  assert.ok(chipAppend > -1, "wireLogRow paints the chip through the optimistic helper");
  assert.ok(mutation > chipAppend, "the chip is on the card before the write leaves the device");
  assert.ok(errorGuard > mutation, "the parsed error response is still checked after the write");
  assert.ok(
    body.indexOf("commitPendingChip(pending, result, deps)") > errorGuard,
    "the real set id is adopted only after the error guard"
  );
  // Rest, the stopwatch reset and the local stat repaint are part of the
  // optimistic pass — none of them wait on the network. The log button stays
  // disabled until the mutation resolves or a ~400ms re-arm window, so a
  // double-tap cannot allocate a second idempotency key.
  const optimisticPass = body.slice(chipAppend, mutation);
  for (const painted of [
    "stopwatch?.reset();",
    "deps.startRest();",
    "const finishSurfaceMissing = refreshFinishStat(deps, { repaint: false });",
  ]) {
    assert.ok(optimisticPass.includes(painted), `${painted} is part of the optimistic pass`);
  }
  assert.equal(optimisticPass.includes("logBtn.disabled = false;"), false, "the button is not re-armed in the same synchronous pass");
  assert.match(body, /if\s*\(logBtn\.disabled\s*\|\|\s*row\.dataset\.logging\s*===\s*"1"\)\s*return;/);
  assert.match(body, /logBtn\.disabled\s*=\s*true;/);
  assert.match(body, /row\.dataset\.logging\s*=\s*"1"/);
  assert.match(body, /setTimeout\(\s*rearmLog,\s*400\s*\)/);
  // The shared mutation runner still owns the direct request and any transient
  // outbox fallback under one lock, with the idempotency key allocated inside it,
  // ahead of the network.
  assert.match(body, /await\s+runtime\.runSessionMutation\s*\(\s*\{[\s\S]*?kind:\s*"set"[\s\S]*?path:\s*"\/sets"[\s\S]*?body:\s*payload\.body[\s\S]*?\},\s*\(idempotencyKey\)\s*=>\s*\{[\s\S]*?stampPendingMutationId\(pending,\s*idempotencyKey,\s*deps\)[\s\S]*?deps\.api\s*\(\s*"\/sets"/);
  assert.match(body, /if\s*\(mutation\.status\s*===\s*"queued"\)\s*stampPendingMutationId\(pending,\s*mutation\.item\?\.id,\s*deps\)/);
  assert.match(body, /"X-Idempotency-Key":\s*idempotencyKey/);
  assert.match(body, /if\s*\(mutation\.status\s*!==\s*"queued"\)\s*\{\s*rollbackPendingChip\(pending, deps\);\s*deps\.stopRest\(\);/);
  assert.match(body, /const\s+result\s*=\s*CairnTodaySessionSetModel\.responseRecord\(mutation\.value\)/);
  assert.match(body, /"Set saved — will sync/);
  assert.match(body, /Couldn’t save that set on this device/);
});
