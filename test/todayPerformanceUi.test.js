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
  assert.match(todayDataLoader, /Promise\.all\(\[statsPromise,\s*profilePromise,\s*exercisesPromise\]\)/);
  assert.match(today, /todayDataLoader\.load/);
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

test("Today set logging only mutates the card after a successful POST", () => {
  const body = functionBody(todaySessionSetActions, "wireLogRow");
  const apiCall = body.indexOf('deps.api("/sets"');
  const errorGuard = body.indexOf("!result || result.ok === false || result.error || result.id == null");
  const chipAppend = body.indexOf("loggedWrap.appendChild(chipEl)");
  assert.ok(apiCall > -1, "wireLogRow posts the set through the API helper");
  assert.ok(errorGuard > apiCall, "wireLogRow checks the parsed error response after the POST");
  assert.ok(chipAppend > errorGuard, "wireLogRow appends the chip only after the error guard");
  assert.match(body, /if\s*\(logBtn\.disabled\)\s*return;/);
  assert.match(body, /logBtn\.disabled\s*=\s*true;/);
  assert.match(body, /catch\s*\{\s*logBtn\.disabled\s*=\s*false;\s*deps\.toast\("Couldn't log that set/);
});
