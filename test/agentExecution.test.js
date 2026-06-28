import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENT_WORKSPACES_DIRNAME,
  agentExecutionCwd,
  buildAgentSpawnOptions,
  promptReferencesDataDir,
} from "../dist/agentExecution.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distAgentsUrl = pathToFileURL(path.join(root, "dist", "agents.js")).href;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agent-exec-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertIsWorkspace(cwd, dataDir, kind) {
  assert.ok(cwd, "cwd should be set");
  assert.notEqual(fs.realpathSync(cwd), fs.realpathSync(dataDir), "cwd should not be DATA_DIR");
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(dataDir, AGENT_WORKSPACES_DIRNAME, kind)));
}

test("agent spawn options use an isolated workspace and sanitized env", () => withTempDir((dataDir) => {
  const sourceEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    DB_PATH: path.join(dataDir, "cairn.db"),
    CAIRN_AUTH_TOKEN: "server-token",
    GARMIN_PASSWORD: "garmin-secret",
    HOME: "/home/app",
    PATH: "/usr/bin",
  };

  const opts = buildAgentSpawnOptions({ kind: "login", sourceEnv });

  assertIsWorkspace(opts.cwd, dataDir, "login");
  assert.equal(opts.env.CAIRN_AUTH_TOKEN, undefined);
  assert.equal(opts.env.GARMIN_PASSWORD, undefined);
  assert.equal(opts.env.DB_PATH, undefined);
  assert.equal(opts.env.DATA_DIR, undefined);
  assert.equal(opts.env.HOME, "/home/app");
  assert.equal(opts.env.PATH, "/usr/bin");
}));

test("agent cwd falls back to DATA_DIR only when prompt references an uploaded data path", () => withTempDir((dataDir) => {
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const sourceEnv = { ...process.env, DATA_DIR: dataDir };
  const uploadPath = path.join(dataDir, "uploads", "labs.pdf");

  assert.equal(promptReferencesDataDir(`Read ${uploadPath}`, sourceEnv), true);
  assert.equal(agentExecutionCwd("agent", { prompt: `Read ${uploadPath}`, sourceEnv }), path.resolve(dataDir));

  const cwd = agentExecutionCwd("agent", { prompt: "Plain chat turn", sourceEnv });
  assertIsWorkspace(cwd, dataDir, "agent");
}));

test("one-shot chat agent subprocess receives sanitized env and safe cwd", () => withTempDir((dataDir) => {
  const configPath = path.join(dataDir, "agents.json");
  const childProbe = [
    "process.stdout.write(JSON.stringify({",
    "cwd: process.cwd(),",
    "token: process.env.CAIRN_AUTH_TOKEN || null,",
    "garmin: process.env.GARMIN_PASSWORD || null,",
    "dataDir: process.env.DATA_DIR || null,",
    "home: process.env.HOME || null",
    "}));",
  ].join("");
  fs.writeFileSync(configPath, JSON.stringify({
    cwdprobe: {
      command: process.execPath,
      args: ["-e", childProbe],
      input: "arg",
      env_required: [],
    },
  }));

  const runner = [
    `import { runAgent } from ${JSON.stringify(distAgentsUrl)};`,
    `const res = await runAgent("cwdprobe", "plain chat", { timeoutMs: 5000 });`,
    "process.stdout.write(JSON.stringify(res.parsed));",
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: root,
    env: {
      ...process.env,
      AGENTS_CONFIG: configPath,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "cairn.db"),
      CAIRN_AUTH_TOKEN: "server-token",
      GARMIN_PASSWORD: "garmin-secret",
      HOME: "/home/app",
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assertIsWorkspace(payload.cwd, dataDir, "agent");
  assert.equal(payload.token, null);
  assert.equal(payload.garmin, null);
  assert.equal(payload.dataDir, null);
  assert.equal(payload.home, "/home/app");
}));

test("uploaded-image prompts expand file access args and place image args after the prompt", () => withTempDir((dataDir) => {
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const imagePath = path.join(dataDir, "uploads", "plate.jpg");
  fs.writeFileSync(imagePath, "fake image");
  const configPath = path.join(dataDir, "agents.json");
  const childProbe = "process.stdout.write(JSON.stringify({argv: process.argv.slice(1), cwd: process.cwd()}));";
  fs.writeFileSync(configPath, JSON.stringify({
    argvprobe: {
      command: process.execPath,
      args: ["-e", childProbe, "--", "{file_access_args}", "{prompt}", "{image_args}"],
      input: "arg",
      env_required: [],
      file_access_args: ["--file-root", "{data_dir}"],
      image_args: ["--image", "{image}"],
    },
  }));

  const prompt = `Estimate this uploaded plate: ${imagePath}`;
  const runner = [
    `import { runAgent } from ${JSON.stringify(distAgentsUrl)};`,
    `const res = await runAgent("argvprobe", ${JSON.stringify(prompt)}, { timeoutMs: 5000 });`,
    "process.stdout.write(JSON.stringify(res.parsed));",
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: root,
    env: {
      ...process.env,
      AGENTS_CONFIG: configPath,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "cairn.db"),
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(fs.realpathSync(payload.cwd), fs.realpathSync(dataDir), "uploaded-file prompts run from DATA_DIR");
  const argv = payload.argv;
  assert.ok(argv.includes("--file-root"), "file access args were expanded");
  assert.equal(argv[argv.indexOf("--file-root") + 1], path.resolve(dataDir));
  assert.ok(argv.includes(prompt), "prompt was passed as an argv token");
  assert.ok(argv.includes("--image"), "image args were expanded");
  assert.ok(argv.indexOf(prompt) < argv.indexOf("--image"), "Codex-style variadic --image must come after the prompt");
  assert.equal(argv[argv.indexOf("--image") + 1], imagePath);
}));

test("streaming chat agent subprocess receives sanitized env and safe cwd", () => withTempDir((dataDir) => {
  const configPath = path.join(dataDir, "agents.json");
  const streamProbe = [
    "const payload = JSON.stringify({",
    "cwd: process.cwd(),",
    "token: process.env.CAIRN_AUTH_TOKEN || null,",
    "dataDir: process.env.DATA_DIR || null",
    "});",
    "process.stdout.write(JSON.stringify({ type: 'text', data: payload }) + '\\n');",
  ].join("");
  fs.writeFileSync(configPath, JSON.stringify({
    streamprobe: {
      command: process.execPath,
      args: ["-e", "process.stdout.write('{}')"],
      input: "arg",
      env_required: [],
      stream: { format: "grok", args: ["-e", streamProbe] },
    },
  }));

  const runner = [
    `import { runAgentStreaming } from ${JSON.stringify(distAgentsUrl)};`,
    `const res = await runAgentStreaming("streamprobe", "plain chat", { timeoutMs: 5000 });`,
    "process.stdout.write(JSON.stringify(res.parsed));",
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: root,
    env: {
      ...process.env,
      AGENTS_CONFIG: configPath,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, "cairn.db"),
      CAIRN_AUTH_TOKEN: "server-token",
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assertIsWorkspace(payload.cwd, dataDir, "chat");
  assert.equal(payload.token, null);
  assert.equal(payload.dataDir, null);
}));
