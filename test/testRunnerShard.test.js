// `test/run.mjs --shard=<i>/<n>` splits one selection into n disjoint, duration-balanced
// slices that together run every file exactly once — every shard derives the same
// partition from the same timings file (scripts/verify-split.mjs runs them on n machines).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "test/run.mjs");

function listShard(spec, timings) {
  const out = execFileSync(process.execPath, [runner, `--shard=${spec}`, "--list"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CAIRN_TEST_TIMINGS: timings, CAIRN_TEST_SHARD: "" },
  });
  return out.split("\n").filter((line) => line.startsWith("test/"));
}

test("shards are disjoint, cover the whole suite, and balance the recorded durations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-shard-"));
  try {
    const all = fs
      .readdirSync(path.join(root, "test"))
      .filter((f) => f.endsWith(".test.js"))
      .sort()
      .map((f) => `test/${f}`);
    // A skewed profile: one file far heavier than the rest, the others alike.
    const files = Object.fromEntries(all.map((f, i) => [f, { ms: i === 0 ? 30_000 : 100 + (i % 7), rssMb: 100 }]));
    const timings = path.join(dir, "timings.json");
    fs.writeFileSync(timings, JSON.stringify({ version: 2, files }));

    const shards = [1, 2, 3].map((i) => listShard(`${i}/3`, timings));
    const seen = shards.flat();
    assert.equal(seen.length, all.length, "every file lands in exactly one shard");
    assert.deepEqual(new Set(seen).size, all.length);
    assert.deepEqual([...seen].sort(), all);

    const load = (list) => list.reduce((sum, f) => sum + files[f].ms, 0);
    const loads = shards.map(load);
    // Longest-first: the heavy file goes first, the many light ones level the three out.
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 200, `shards balanced: ${loads.join(", ")}`);
    assert.ok(shards.some((list) => list.includes(all[0])));

    // Same inputs, same partition: a shard computed twice is the same list.
    assert.deepEqual(listShard("2/3", timings), shards[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed shard spec fails fast", () => {
  for (const spec of ["0/2", "3/2", "a/b", "2"]) {
    const result = spawnSync(process.execPath, [runner, `--shard=${spec}`, "--list"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2, spec);
    assert.match(result.stderr, /--shard must be <i>\/<n>/);
  }
});
