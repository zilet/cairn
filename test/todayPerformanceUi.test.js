import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = readFileSync(path.join(root, "public/js/03-today.js"), "utf8");

function functionBody(name) {
  const start = today.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = today.indexOf("\nfunction ", start + 1);
  return today.slice(start, next === -1 ? undefined : next);
}

test("Today starts non-dependent summary reads before later render work", () => {
  assert.match(today, /const\s+statsPromise\s*=/);
  assert.match(today, /const\s+profilePromise\s*=/);
  assert.match(today, /const\s+exercisesPromise\s*=/);
  assert.match(today, /Promise\.all\(\[statsPromise,\s*profilePromise,\s*exercisesPromise\]\)/);
});

test("Today SWR-caches progression and invalidates it when set truth changes", () => {
  assert.match(today, /cachedApi\("\/program\/progression\?day="/);
  assert.match(today, /key:\s*`program:progression:\$\{state\.day\}`/);
  assert.match(today, /function\s+invalidateTodayProgression/);
  assert.match(today, /swrInvalidate\("program:progression:"\s*\+\s*state\.day\)/);
  assert.ok((today.match(/invalidateTodayProgression\(\);/g) || []).length >= 2, "set create/delete paths invalidate progression");
});

test("Today set logging only mutates the card after a successful POST", () => {
  const body = functionBody("wireLogRow");
  const apiCall = body.indexOf('api("/sets"');
  const errorGuard = body.indexOf("!res || res.ok === false || res.error || res.id == null");
  const chipAppend = body.indexOf("loggedWrap.appendChild(chipEl)");
  assert.ok(apiCall > -1, "wireLogRow posts the set through the API helper");
  assert.ok(errorGuard > apiCall, "wireLogRow checks the parsed error response after the POST");
  assert.ok(chipAppend > errorGuard, "wireLogRow appends the chip only after the error guard");
  assert.match(body, /if\s*\(logBtn\.disabled\)\s*return;/);
  assert.match(body, /logBtn\.disabled\s*=\s*true;/);
  assert.match(body, /catch\s*\{\s*logBtn\.disabled\s*=\s*false;\s*toast\("Couldn't log that set/);
});
