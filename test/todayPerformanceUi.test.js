import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const today = readFileSync(path.join(root, "public/js/03-today.js"), "utf8");

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
