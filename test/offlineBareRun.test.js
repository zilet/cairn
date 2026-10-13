// A test process the runner did not start (`node --test file`, or `--import
// test/_isolate.mjs` alone) must still be offline: real agent CLIs unreachable, and the
// real data/cairn.db never opened. Each case is a child process with the harness's env
// scrubbed, reporting what it resolved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const probe = path.join(here, "_offlineProbe.mjs");
const isolate = path.join(here, "_isolate.mjs");
const realData = path.join(root, "data");

function runProbe({ args = [], env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cairn-bare-probe-"));
  const out = path.join(dir, "out.json");
  const clean = { ...process.env, PROBE_OUT: out, ...env };
  // NODE_TEST_CONTEXT would make the nested `node --test` believe it is already a child.
  delete clean.NODE_TEST_CONTEXT;
  for (const key of ["AGENTS_CONFIG", "DB_PATH", "DATA_DIR"]) if (!(key in env)) delete clean[key];
  const child = spawnSync(process.execPath, [...args, "--test", probe], { cwd: root, env: clean, encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(readFileSync(out, "utf8"));
}

function assertThrowawayDb(seen) {
  assert.ok(!path.resolve(seen.dbFile).startsWith(realData + path.sep), `opened the real data dir: ${seen.dbFile}`);
  // Uploads, guides (and art / the Garmin token, same resolution) never land in data/ either.
  for (const dir of seen.files ?? []) {
    assert.ok(!path.resolve(dir).startsWith(realData + path.sep), `wrote under the real data dir: ${dir}`);
  }
  assert.ok((seen.files ?? []).length > 0, "the probe reports where files would land");
}

function assertOffline(seen) {
  const real = Object.entries(seen.agents).filter(([name]) => name !== "stub");
  assert.ok(real.length > 0, "the offline table keeps the real agents' names");
  for (const [name, command] of real) assert.equal(command, `cairn-test-offline-${name}`);
  assertThrowawayDb(seen);
}

test("--import _isolate alone, no env: offline agents and a throwaway DB", () => {
  assertOffline(runProbe({ args: ["--import", isolate] }));
});

test("bare node --test through the shared seed helper is offline too", () => {
  assertOffline(runProbe({ env: { PROBE_SEED: "1" } }));
});

test("bare node --test with no helper at all never reaches a real CLI or the real DB", () => {
  const seen = runProbe();
  assert.deepEqual(seen.agents, {}, "no AGENTS_CONFIG under node:test reads as no agents");
  assertThrowawayDb(seen);
});

test("a test's own AGENTS_CONFIG is left alone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cairn-bare-own-"));
  const own = path.join(dir, "own.json");
  writeFileSync(own, JSON.stringify({ mine: { command: "my-cli" } }));
  const seen = runProbe({ args: ["--import", isolate], env: { AGENTS_CONFIG: own } });
  assert.deepEqual(seen.agents, { mine: "my-cli" });
});
