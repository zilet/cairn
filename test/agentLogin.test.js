// Agent Connect — the in-app CLI login bridge + model-listing parse helpers.
//
// The login bridge spawns an interactive CLI inside a real PTY and pipes it over a
// WebSocket. The one security-critical invariant is the ALLOWLIST: the login
// command is chosen server-side from agents.json — the client only names an agent.
// `resolveLoginArgv` is that gate, so it MUST reject an unknown agent and an agent
// with no declared login, and return the exact server-chosen argv otherwise.
//
// These are pure/offline (no CLI spawn, no network) — deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./_seed.js"; // ensures DATA_DIR/DB_PATH-backed db is initialized for the dist imports
import { resolveLoginArgv, buildPtyInvocation, ptyInvocationFor, loginSessionActive, buildLoginSpawnOptions } from "../dist/agentLogin.js";
import { AGENT_WORKSPACES_DIRNAME } from "../dist/agentExecution.js";
import {
  AGENT_ENV_DENYLIST,
  agentCliPath,
  parseModelsOutput,
  parseDefaultModel,
  parseTomlModel,
  invalidateAgentConfigured,
  loadAgents,
  sanitizeAgentEnv,
} from "../dist/agents.js";

test("resolveLoginArgv returns the server-chosen login argv per agent", () => {
  assert.deepEqual(resolveLoginArgv("claude"), ["claude", "auth", "login"]);
  assert.deepEqual(resolveLoginArgv("codex"), ["codex", "login"]);
  assert.deepEqual(resolveLoginArgv("grok"), ["grok", "login", "--device-auth"]);
  // antigravity logs in via the bare interactive CLI (login: []).
  assert.deepEqual(resolveLoginArgv("antigravity"), ["agy"]);
});

test("resolveLoginArgv REJECTS an unknown agent (allowlist gate)", () => {
  assert.throws(() => resolveLoginArgv("bogus"), /Unknown agent/i);
  assert.throws(() => resolveLoginArgv(""), /Unknown agent/i);
  assert.throws(() => resolveLoginArgv("../../bin/sh"), /Unknown agent/i);
});

test("resolveLoginArgv REJECTS an agent with no login flow (stub)", () => {
  // stub is the offline fixture — it declares no login, so it can never be driven
  // through the terminal bridge.
  assert.throws(() => resolveLoginArgv("stub"), /does not support an interactive login/i);
});

test("ptyInvocationFor builds EVERY platform's PTY wrapper from any host OS", () => {
  // The blind spot this closes: buildPtyInvocation branches on process.platform, so a
  // macOS dev box only ever exercised the darwin branch — a shell-quoting change to the
  // Linux/Docker branch (the path that actually ships) passed local `npm test` yet
  // failed the Linux CI build. ptyInvocationFor is platform-PARAMETERIZED + pure, so we
  // assert all three shapes in one run regardless of the host.
  const argv = ["claude", "auth", "login"];

  // Linux / Docker: util-linux `script -qfc "<shell-quoted cmd>" /dev/null`.
  const linux = ptyInvocationFor("linux", argv);
  assert.equal(linux.command, "script");
  assert.deepEqual(linux.args, ["-qfc", "'claude' 'auth' 'login'", "/dev/null"]);

  // macOS: python3 pty.spawn with the argv JSON-encoded into a Python list literal.
  const mac = ptyInvocationFor("darwin", argv);
  assert.equal(mac.command, "python3");
  assert.equal(mac.args[0], "-c");
  assert.match(mac.args[1], /pty\.spawn\(\["claude","auth","login"\]\)/);

  // Windows has no PTY bridge — it must throw, never silently mis-spawn.
  assert.throws(() => ptyInvocationFor("win32", argv), /unsupported on Windows/i);
});

test("ptyInvocationFor shell-quotes a token with a space/quote/metachar (Linux injection guard)", () => {
  // A future agents.json login token with a space or quote must stay ONE shell word
  // when wrapped by `script -qfc "<cmd>"` (run via /bin/sh) — never word-split or inject.
  const inv = ptyInvocationFor("linux", ["my agent", "log'in", "; rm -rf /"]);
  assert.equal(inv.command, "script");
  assert.deepEqual(inv.args, ["-qfc", "'my agent' 'log'\\''in' '; rm -rf /'", "/dev/null"]);
});

test("buildPtyInvocation wraps the login argv in a real PTY (no native module)", () => {
  const inv = buildPtyInvocation(["claude", "auth", "login"]);
  assert.equal(typeof inv.command, "string");
  assert.ok(Array.isArray(inv.args) && inv.args.length > 0);
  if (process.platform === "linux") {
    // util-linux `script -qfc "<cmd>" /dev/null` — the Docker path. Each token is
    // shell-quoted (the command runs via /bin/sh -c) so a future agents.json entry
    // with a space/metachar can't word-split or inject.
    assert.equal(inv.command, "script");
    assert.deepEqual(inv.args, ["-qfc", "'claude' 'auth' 'login'", "/dev/null"]);
  } else if (process.platform === "darwin") {
    // python3 pty.spawn — BSD `script` can't PTY with piped stdio.
    assert.equal(inv.command, "python3");
    assert.equal(inv.args[0], "-c");
    // the server-chosen argv is JSON-encoded into the python list literal
    assert.match(inv.args[1], /pty\.spawn\(\["claude","auth","login"\]\)/);
  }
});

test("sanitizeAgentEnv strips Cairn-owned secrets while preserving login-critical env", () => {
  const source = {
    CAIRN_AUTH_TOKEN: "server-token",
    GARMIN_PASSWORD: "garmin-secret",
    GARMIN_USERNAME: "garmin-user",
    GEMINI_API_KEY: "gemini-secret",
    GOOGLE_AI_KEY: "google-secret",
    DB_PATH: "/private/db.sqlite",
    DATA_DIR: "/private/data",
    GARMIN_TOKEN_DIR: "/private/garmin",
    HOME: "/home/app",
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    XAI_API_KEY: "agent-owned-key",
  };

  const env = sanitizeAgentEnv(source);
  for (const key of AGENT_ENV_DENYLIST) assert.equal(env[key], undefined, `${key} should be stripped`);
  assert.equal(env.HOME, "/home/app");
  assert.equal(env.PATH, agentCliPath(source));
  assert.ok(env.PATH.split(path.delimiter).includes("/home/app/.local/bin"));
  assert.ok(env.PATH.split(path.delimiter).includes("/home/app/.grok/bin"));
  assert.ok(env.PATH.split(path.delimiter).includes("/usr/bin"));
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.XAI_API_KEY, "agent-owned-key");

  const restored = sanitizeAgentEnv(source, ["GEMINI_API_KEY"]);
  assert.equal(restored.GEMINI_API_KEY, "gemini-secret");
});

test("login spawn options use sanitized env and an isolated workspace", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-login-cwd-"));
  try {
    const opts = buildLoginSpawnOptions({
      ...process.env,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "cairn.db"),
      CAIRN_AUTH_TOKEN: "server-token",
      GARMIN_PASSWORD: "garmin-secret",
      HOME: "/home/app",
      PATH: "/usr/bin",
    });

    assert.ok(opts.cwd, "login cwd should be set");
    assert.notEqual(fs.realpathSync(opts.cwd), fs.realpathSync(dataDir), "login should not run directly in DATA_DIR");
    assert.equal(fs.realpathSync(opts.cwd), fs.realpathSync(path.join(dataDir, AGENT_WORKSPACES_DIRNAME, "login")));
    assert.equal(opts.env.CAIRN_AUTH_TOKEN, undefined);
    assert.equal(opts.env.GARMIN_PASSWORD, undefined);
    assert.equal(opts.env.DB_PATH, undefined);
    assert.equal(opts.env.DATA_DIR, undefined);
    assert.equal(opts.env.HOME, "/home/app");
    assert.equal(opts.env.PATH, agentCliPath({
      ...process.env,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "cairn.db"),
      CAIRN_AUTH_TOKEN: "server-token",
      GARMIN_PASSWORD: "garmin-secret",
      HOME: "/home/app",
      PATH: "/usr/bin",
    }));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loginSessionActive starts false (no session until one is opened)", () => {
  assert.equal(loginSessionActive(), false);
});

test("parseDefaultModel pulls the free 'Default model' line (grok/agy) or null", () => {
  const grok = "Default model: grok-composer-2.5-fast\n\nAvailable models:\n  grok-build\n  grok-composer-2.5-fast";
  assert.equal(parseDefaultModel(grok), "grok-composer-2.5-fast");
  assert.equal(parseDefaultModel("Current model = some-model-v2"), "some-model-v2");
  assert.equal(parseDefaultModel("no default here\njust noise"), null);
  assert.equal(parseDefaultModel(""), null);
});

test("grok's in-app device-auth login is detectable via auth_state", () => {
  // grok has no status_check and the headless XAI_API_KEY may be unset, so the only
  // signal that a Connect (`grok login --device-auth`) login happened is the file it
  // writes. agents.json MUST declare that as grok's auth_state, or the card is stuck
  // on "Installed" forever after a successful in-app login. (The fix for that bug.)
  const grok = loadAgents().grok;
  assert.ok(Array.isArray(grok.auth_state) && grok.auth_state.includes(".grok/auth.json"));
});

test("parseTomlModel reads codex's root model and ignores decoys", () => {
  // codex has no `models` catalog — its current model comes from ~/.codex/config.toml.
  const cfg = `model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n[tui.model_availability_nux]\nmodel = "nested-should-not-win"`;
  assert.equal(parseTomlModel(cfg), "gpt-5.5");
  // model_reasoning_effort must NOT be mistaken for the model key
  assert.equal(parseTomlModel(`model_reasoning_effort = "high"`), null);
  // unquoted + inline comment
  assert.equal(parseTomlModel(`model = o3  # the default`), "o3");
  assert.equal(parseTomlModel(""), null);
  // a model declared only inside a sub-table is not the root model
  assert.equal(parseTomlModel(`[profiles.x]\nmodel = "x"`), null);
});

test("invalidateAgentConfigured is exported and never throws", () => {
  // Called after an in-app login exits so the next probe re-reads the (now-written)
  // auth state instead of the boot-time verdict.
  assert.equal(typeof invalidateAgentConfigured, "function");
  assert.doesNotThrow(() => invalidateAgentConfigured("grok"));
  assert.doesNotThrow(() => invalidateAgentConfigured()); // whole-cache clear
});

test("parseModelsOutput keeps model ids and drops banners/headers", () => {
  const grok = "Default model: grok-composer-2.5-fast\nAvailable models:\n- grok-build\n- grok-composer-2.5-fast";
  // the "Default model:" + "Available models:" lines are banners, not entries.
  assert.deepEqual(parseModelsOutput(grok), ["grok-build", "grok-composer-2.5-fast"]);
  assert.deepEqual(parseModelsOutput(""), []);
  // a prose sentence (interior spaces + trailing period) is a banner, not a model id
  assert.deepEqual(parseModelsOutput("You are logged in as x.\nmodel-a\nmodel-b"), ["model-a", "model-b"]);
});
