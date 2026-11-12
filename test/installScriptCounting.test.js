// The installer's anonymous install counting (opt-out, what each outcome sends and
// never sends) against a fake curl. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  withTempDir,
  run,
  FAKE_DOCKER,
  installFakes,
  FAKE_CURL,
  railwayRig,
  scriptConsentRig,
  COUNTING,
  eventLines,
  eventQuery,
} from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptCounting", { concurrency: true }, () => {
  test("counting: --help names the opt-out; the plan discloses it and says when it is off", () =>
    withTempDir(async (dir) => {
      const plan = (args, env = {}) =>
        run(["--dry-run", `--dir=${dir}/c`, "--no-updater", ...args], { env: { HOME: dir, ...COUNTING, ...env } });
      const offCases = [
        [["--no-telemetry"], {}],
        [[], { DO_NOT_TRACK: "1" }],
        [[], { DO_NOT_TRACK: "true" }],
        [[], { CAIRN_NO_TELEMETRY: "1" }],
        [[], { CAIRN_INSTALL_EVENT_URL: "" }],
        [[], { CAIRN_INSTALL_EVENT_URL: "http://events.example.test/e" }],
      ];
      // Every run here is independent (a dry run writes nothing): start them all, assert in order.
      const [help, on, notOptOut, rw, ...offs] = await Promise.all([
        run(["--help"]),
        plan([]),
        plan([], { DO_NOT_TRACK: "0" }),
        run(["--target=railway", "--dry-run"], { env: { HOME: dir, ...COUNTING } }),
        ...offCases.map(([args, env]) => plan(args, env)),
      ]);
      assert.equal(help.code, 0, help.all);
      assert.match(help.out, /--no-telemetry/);
      assert.match(help.out, /DO_NOT_TRACK=1/);

      assert.equal(on.code, 0, on.all);
      assert.match(on.out, /Counting: {4}two anonymous events to cairn\.fit/);
      assert.match(on.out, /--no-telemetry skips them/);
      offCases.forEach(([args, env], i) => {
        assert.equal(offs[i].code, 0, offs[i].all);
        assert.match(offs[i].out, /Counting: {4}off/, JSON.stringify({ args, env }));
      });
      assert.match(notOptOut.out, /Counting: {4}two anonymous/, "DO_NOT_TRACK=0 is not an opt-out");
      assert.match(rw.out, /Counting: {4}two anonymous events/);
    }));

  test("counting: a cancelled or never-started run sends nothing", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "logged_out"), "");
      // No terminal and no --yes: the plan cannot be accepted, so nothing was chosen.
      const r = await run(["--target=railway"], { env: { ...rig.env, ...COUNTING } });
      assert.notEqual(r.code, 0);
      assert.deepEqual(eventLines(rig.read("clog")), []);
      // Signed out of Railway after accepting: chose, then failed at the CLI step.
      const out = await run(["--target=railway", "--yes"], { env: { ...rig.env, ...COUNTING } });
      assert.notEqual(out.code, 0);
      assert.deepEqual(
        eventLines(rig.read("clog")).map((line) => eventQuery(line).s),
        ["none", "railway_cli"]
      );
    }));

  test("counting: a local install sends chose then done; a dead health check fails at health", () =>
    withTempDir(async (dir) => {
      const bin = path.join(dir, "bin");
      const state = path.join(dir, "state");
      fs.mkdirSync(bin);
      fs.mkdirSync(state);
      installFakes(bin, [
        ["docker", FAKE_DOCKER],
        ["curl", FAKE_CURL],
        ["sleep", "#!/bin/sh\nexit 0\n"],
      ]);
      const id = "e".repeat(12);
      fs.writeFileSync(path.join(state, "remote_id"), `${id}\n`);
      fs.writeFileSync(path.join(state, `healthy_${id}`), "2.1.0");
      const env = {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        FAKE_STATE: state,
        FAKE_PROJECT: "cairn",
        CAIRN_CONTAINER_TOOL: "docker",
        CAIRN_HEALTH_TIMEOUT: "6",
        ...COUNTING,
      };
      const log = () => fs.readFileSync(path.join(state, "log"), "utf8");
      const ok = await run(["--target=local", "--yes", `--dir=${dir}/one`, "--no-updater"], { env });
      assert.equal(ok.code, 0, ok.all);
      assert.deepEqual(eventLines(log()).map(eventQuery), [
        { e: "chose", t: "local", s: "none", v: "1" },
        { e: "done", t: "local", s: "none", v: "1" },
      ]);
      assert.doesNotMatch(eventLines(log()).join("\n"), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      fs.rmSync(path.join(state, `healthy_${id}`));
      fs.rmSync(path.join(state, "running"), { force: true });
      fs.rmSync(path.join(state, "exists"), { force: true });
      const before = eventLines(log()).length;
      const bad = await run(
        ["--target=local", "--yes", `--dir=${dir}/two`, "--name=two", "--port=8788", "--no-updater"],
        {
          env: { ...env, FAKE_PROJECT: "two" },
        }
      );
      assert.notEqual(bad.code, 0, bad.all);
      assert.deepEqual(
        eventLines(log())
          .slice(before)
          .map((line) => [eventQuery(line).e, eventQuery(line).s]),
        [
          ["chose", "none"],
          ["failed", "health"],
        ]
      );
    }));

  test("counting: no container engine counts as failed at the engine step", () =>
    withTempDir(async (dir) => {
      const rig = scriptConsentRig(dir);
      const r = await run(["--target=local", `--dir=${dir}/c`, "--no-updater", "--yes"], {
        env: { ...rig.env, ...COUNTING },
      });
      assert.notEqual(r.code, 0, r.all);
      const clog = fs.readFileSync(path.join(rig.env.FAKE_STATE, "clog"), "utf8");
      assert.deepEqual(eventLines(clog).map(eventQuery), [{ e: "failed", t: "local", s: "engine", v: "1" }]);
    }));
});
