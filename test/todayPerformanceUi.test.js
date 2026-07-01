import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = readFileSync(path.join(root, "src/client/today-screen.ts"), "utf8");
const todayPlanSessionPreparation = readFileSync(path.join(root, "src/client/today-plan-session-preparation.ts"), "utf8");
const todayProgressionController = readFileSync(path.join(root, "src/client/today-progression-controller.ts"), "utf8");
const todaySessionController = readFileSync(path.join(root, "src/client/today-session-controller.ts"), "utf8");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("Today starts non-dependent summary reads before later render work", () => {
  assert.match(today, /const\s+statsPromise\s*=/);
  assert.match(today, /const\s+profilePromise\s*=/);
  assert.match(today, /const\s+exercisesPromise\s*=/);
  assert.match(today, /Promise\.all\(\[statsPromise,\s*profilePromise,\s*exercisesPromise\]\)/);
});

test("Today SWR-caches progression and invalidates it when set truth changes", () => {
  assert.match(todayPlanSessionPreparation, /deps\.cachedApi\("\/program\/progression\?day="/);
  assert.match(todayPlanSessionPreparation, /key:\s*`program:progression:\$\{day\}`/);
  assert.match(today, /todayPlanSessionPreparation\.preparePlanSession/);
  assert.match(today, /function\s+invalidateTodayProgression/);
  assert.match(today, /CairnTodayProgressionController\.invalidateTodayProgression\(todayProgressionDeps\(\)\)/);
  assert.match(todayProgressionController, /function progressionKey\(day: string \| number\): string/);
  assert.match(todayProgressionController, /deps\.invalidate\(progressionKey\(deps\.state\.day\)\)/);
  assert.ok((todaySessionController.match(/deps\.invalidateTodayProgression\(\);/g) || []).length >= 2, "set create/delete paths invalidate progression");
});

test("Today set logging only mutates the card after a successful POST", () => {
  const body = functionBody(todaySessionController, "wireLogRow");
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
