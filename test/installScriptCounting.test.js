// The installer's anonymous install counting (opt-out, what each outcome sends and
// never sends) against a fake curl. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  withTempDir,
  run,
  FAKE_DOCKER,
  FAKE_CURL,
  railwayRig,
  scriptConsentRig,
  COUNTING,
  eventLines,
  eventQuery,
} from "./_installer.mjs";

test("counting: --help names the opt-out; the plan discloses it and says when it is off", () =>
  withTempDir((dir) => {
    const help = run(["--help"]);
    assert.equal(help.code, 0, help.all);
    assert.match(help.out, /--no-telemetry/);
    assert.match(help.out, /DO_NOT_TRACK=1/);

    const plan = (args, env = {}) =>
      run(["--dry-run", `--dir=${dir}/c`, "--no-updater", ...args], { env: { HOME: dir, ...COUNTING, ...env } });
    const on = plan([]);
    assert.equal(on.code, 0, on.all);
    assert.match(on.out, /Counting: {4}two anonymous events to cairn\.fit/);
    assert.match(on.out, /--no-telemetry skips them/);
    for (const [args, env] of [
      [["--no-telemetry"], {}],
      [[], { DO_NOT_TRACK: "1" }],
      [[], { DO_NOT_TRACK: "true" }],
      [[], { CAIRN_NO_TELEMETRY: "1" }],
      [[], { CAIRN_INSTALL_EVENT_URL: "" }],
      [[], { CAIRN_INSTALL_EVENT_URL: "http://events.example.test/e" }],
    ]) {
      const off = plan(args, env);
      assert.equal(off.code, 0, off.all);
      assert.match(off.out, /Counting: {4}off/, JSON.stringify({ args, env }));
    }
    assert.match(plan([], { DO_NOT_TRACK: "0" }).out, /Counting: {4}two anonymous/, "DO_NOT_TRACK=0 is not an opt-out");
    const rw = run(["--target=railway", "--dry-run"], { env: { HOME: dir, ...COUNTING } });
    assert.match(rw.out, /Counting: {4}two anonymous events/);
  }));

test("counting: a Railway install sends chose then done, and nothing about the person", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    const r = run(["--target=railway", "--yes"], { env: { ...rig.env, ...COUNTING } });
    assert.equal(r.code, 0, r.all);
    const events = eventLines(rig.read("clog"));
    assert.equal(events.length, 2, rig.read("clog"));
    assert.deepEqual(eventQuery(events[0]), { e: "chose", t: "railway", s: "none", v: "1" });
    assert.deepEqual(eventQuery(events[1]), { e: "done", t: "railway", s: "none", v: "1" });
    const { token } = rig.secrets();
    for (const line of events) {
      assert.match(line, /--max-time 3/);
      assert.doesNotMatch(line, new RegExp(token));
      assert.doesNotMatch(line, /railway\.app|proj-1|cairn-production|\/home|\/tmp/);
    }
    assert.doesNotMatch(r.all, /events\.example\.test/, "counting prints nothing");

    // Opted out three ways: no event at all.
    for (const [args, env] of [
      [["--no-telemetry"], {}],
      [[], { DO_NOT_TRACK: "1" }],
      [[], { CAIRN_INSTALL_EVENT_URL: "" }],
    ]) {
      const before = eventLines(rig.read("clog")).length;
      const again = run(["--target=railway", "--yes", ...args], { env: { ...rig.env, ...COUNTING, ...env } });
      assert.equal(again.code, 0, again.all);
      assert.equal(eventLines(rig.read("clog")).length, before, JSON.stringify({ args, env }));
    }
    // update / status never count.
    const before = eventLines(rig.read("clog")).length;
    assert.equal(rig.cairnSh(["status"]).code, 0);
    assert.equal(eventLines(rig.read("clog")).length, before);
  }));

test("counting: a failed Railway deployment reports the step code, once", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "statuses"), "BUILDING\nFAILED\n");
    const r = run(["--target=railway", "--yes"], { env: { ...rig.env, ...COUNTING } });
    assert.notEqual(r.code, 0);
    const events = eventLines(rig.read("clog")).map(eventQuery);
    assert.deepEqual(events, [
      { e: "chose", t: "railway", s: "none", v: "1" },
      { e: "failed", t: "railway", s: "railway_deploy", v: "1" },
    ]);
  }));

test("counting: a cancelled or never-started run sends nothing", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "logged_out"), "");
    // No terminal and no --yes: the plan cannot be accepted, so nothing was chosen.
    const r = run(["--target=railway"], { env: { ...rig.env, ...COUNTING } });
    assert.notEqual(r.code, 0);
    assert.deepEqual(eventLines(rig.read("clog")), []);
    // Signed out of Railway after accepting: chose, then failed at the CLI step.
    const out = run(["--target=railway", "--yes"], { env: { ...rig.env, ...COUNTING } });
    assert.notEqual(out.code, 0);
    assert.deepEqual(
      eventLines(rig.read("clog")).map((line) => eventQuery(line).s),
      ["none", "railway_cli"]
    );
  }));

test("counting: a local install sends chose then done; a dead health check fails at health", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const state = path.join(dir, "state");
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    for (const [name, body] of [
      ["docker", FAKE_DOCKER],
      ["curl", FAKE_CURL],
      ["sleep", "#!/bin/sh\nexit 0\n"],
    ]) {
      fs.writeFileSync(path.join(bin, name), body);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
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
    const ok = run(["--target=local", "--yes", `--dir=${dir}/one`, "--no-updater"], { env });
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
    const bad = run(["--target=local", "--yes", `--dir=${dir}/two`, "--name=two", "--port=8788", "--no-updater"], {
      env: { ...env, FAKE_PROJECT: "two" },
    });
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
  withTempDir((dir) => {
    const rig = scriptConsentRig(dir);
    const r = run(["--target=local", `--dir=${dir}/c`, "--no-updater", "--yes"], { env: { ...rig.env, ...COUNTING } });
    assert.notEqual(r.code, 0, r.all);
    const clog = fs.readFileSync(path.join(rig.env.FAKE_STATE, "clog"), "utf8");
    assert.deepEqual(eventLines(clog).map(eventQuery), [{ e: "failed", t: "local", s: "engine", v: "1" }]);
  }));
