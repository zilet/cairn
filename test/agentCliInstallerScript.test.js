import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "update-agent-clis.sh");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agent-cli-script-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function runUpdater(binDir, env) {
  return spawnSync("sh", [script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
      ...env,
    },
    encoding: "utf8",
  });
}

test("agent CLI install script uses pinned npm package versions by default", () => withTempDir((dir) => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const npmLog = path.join(dir, "npm.log");
  writeExecutable(path.join(bin, "npm"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_LOG\"\n");
  writeExecutable(path.join(bin, "claude"), "#!/bin/sh\necho claude fake\n");
  writeExecutable(path.join(bin, "codex"), "#!/bin/sh\necho codex fake\n");

  const res = runUpdater(bin, {
    NPM_LOG: npmLog,
    UPDATE_ANTIGRAVITY: "0",
    UPDATE_GROK: "0",
  });

  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  const npmCalls = fs.readFileSync(npmLog, "utf8");
  assert.match(npmCalls, /i -g @anthropic-ai\/claude-code@2\.1\.195/);
  assert.match(npmCalls, /i -g @openai\/codex@0\.142\.3 --include=optional/);
}));

test("agent CLI install script refuses moving npm tags unless explicitly allowed", () => withTempDir((dir) => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const npmLog = path.join(dir, "npm.log");
  writeExecutable(path.join(bin, "npm"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_LOG\"\n");

  const refused = runUpdater(bin, {
    NPM_LOG: npmLog,
    UPDATE_CODEX: "0",
    UPDATE_ANTIGRAVITY: "0",
    UPDATE_GROK: "0",
    CLAUDE_CODE_VERSION: "latest",
  });

  assert.equal(refused.status, 0, `${refused.stdout}\n${refused.stderr}`);
  assert.match(refused.stdout, /refusing moving npm tag for claude/);
  assert.equal(readIfExists(npmLog), "");

  const allowed = runUpdater(bin, {
    NPM_LOG: npmLog,
    UPDATE_CODEX: "0",
    UPDATE_ANTIGRAVITY: "0",
    UPDATE_GROK: "0",
    CLAUDE_CODE_VERSION: "latest",
    AGENT_CLI_ALLOW_MOVING_TAGS: "1",
  });

  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  assert.match(fs.readFileSync(npmLog, "utf8"), /@anthropic-ai\/claude-code@latest/);
}));

test("agent CLI install script gates shell installers on checksum or explicit opt-in", () => withTempDir((dir) => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const curlLog = path.join(dir, "curl.log");
  const bashLog = path.join(dir, "bash.log");
  writeExecutable(path.join(bin, "curl"), [
    "#!/bin/sh",
    "out=",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    -o) out=\"$2\"; shift 2 ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    "printf '%s\\n' \"curl\" >> \"$CURL_LOG\"",
    "printf '%s\\n' '#!/bin/sh' 'echo installer' > \"$out\"",
  ].join("\n"));
  writeExecutable(path.join(bin, "bash"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BASH_LOG\"\n");
  writeExecutable(path.join(bin, "sha256sum"), "#!/bin/sh\nprintf '%s  %s\\n' \"$FAKE_SHA256\" \"$1\"\n");
  writeExecutable(path.join(bin, "timeout"), "#!/bin/sh\nshift\nexec \"$@\"\n");
  writeExecutable(path.join(bin, "find"), "#!/bin/sh\nexit 0\n");

  const skipped = runUpdater(bin, {
    CURL_LOG: curlLog,
    BASH_LOG: bashLog,
    UPDATE_CLAUDE: "0",
    UPDATE_CODEX: "0",
    UPDATE_ANTIGRAVITY: "1",
    UPDATE_GROK: "0",
  });

  assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
  assert.match(skipped.stdout, /skipping agy installer without a matching \*_INSTALL_SHA256/);
  assert.equal(readIfExists(curlLog), "");
  assert.equal(readIfExists(bashLog), "");

  const verified = runUpdater(bin, {
    CURL_LOG: curlLog,
    BASH_LOG: bashLog,
    FAKE_SHA256: "abc123",
    UPDATE_CLAUDE: "0",
    UPDATE_CODEX: "0",
    UPDATE_ANTIGRAVITY: "1",
    UPDATE_GROK: "0",
    ANTIGRAVITY_INSTALL_SHA256: "abc123",
  });

  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  assert.match(readIfExists(curlLog), /curl/);
  assert.match(readIfExists(bashLog), /cairn-agy-installer/);
}));
