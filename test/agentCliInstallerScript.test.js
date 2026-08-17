import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installAgentCli, readAgentInstall, validateInstallSpec } from "../scripts/install-agent-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "agents.json");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agent-cli-install-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function envFor(dir, bin) {
  return {
    ...process.env,
    HOME: path.join(dir, "home"),
    CAIRN_CLI_ROOT: path.join(dir, "home", ".cairn-tools"),
    PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
  };
}

test("bundled agent manifest pins every supported lazy installer", () => {
  const claude = readAgentInstall(manifest, "claude");
  const codex = readAgentInstall(manifest, "codex");
  const antigravity = readAgentInstall(manifest, "antigravity");
  const grok = readAgentInstall(manifest, "grok");
  assert.deepEqual(claude.spec, { method: "npm", package: "@anthropic-ai/claude-code", version: "2.1.233", args: [] });
  assert.deepEqual(codex.spec, {
    method: "npm",
    package: "@openai/codex",
    version: "0.147.0",
    args: ["--include=optional"],
  });
  assert.match(antigravity.spec.sha256, /^[a-f0-9]{64}$/);
  assert.match(grok.spec.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => readAgentInstall(manifest, "stub"), /not installable/);
  assert.throws(() => validateInstallSpec("x", { method: "npm", package: "x", version: "latest" }), /exact semver/);
  assert.throws(
    () => validateInstallSpec("x", { method: "script", url: "http://example.com/x", sha256: "a".repeat(64) }),
    /HTTPS/
  );
});

test("npm CLI installs into the persistent Cairn tools root", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "npm.log");
    executable(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" > "$NPM_LOG"',
        'printf \'token=%s\\n\' "${' + 'CAIRN_AUTH_TOKEN:-}" >> "$NPM_LOG"',
        'mkdir -p "$CAIRN_CLI_ROOT/bin"',
        "printf '%s\\n' '#!/bin/sh' 'echo 2.1.233' > \"$CAIRN_CLI_ROOT/bin/claude\"",
        'chmod +x "$CAIRN_CLI_ROOT/bin/claude"',
      ].join("\n")
    );
    const env = { ...envFor(dir, bin), NPM_LOG: log, CAIRN_AUTH_TOKEN: "must-not-reach-installer" };
    installAgentCli("claude", { manifestPath: manifest, env });
    assert.match(fs.readFileSync(log, "utf8"), /install --global --prefix .*@anthropic-ai\/claude-code@2\.1\.233/);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /must-not-reach-installer/);
    assert.ok(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "bin", "claude")));
  }));

test("installed vendor CLI uses its first-party updater and is persisted", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "agy.log");
    executable(path.join(bin, "agy"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$UPDATE_LOG"\necho 1.1.1\n');
    executable(path.join(bin, "curl"), "#!/bin/sh\nexit 99\n");
    const env = { ...envFor(dir, bin), UPDATE_LOG: log };
    installAgentCli("antigravity", { manifestPath: manifest, env });
    assert.match(fs.readFileSync(log, "utf8"), /^update$/m);
    assert.ok(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "bin", "agy")));
  }));

test("vendor installer is checksum-verified before execution", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const installer =
      "#!/bin/sh\nmkdir -p \"$HOME/.local/bin\"\nprintf '%s\\n' '#!/bin/sh' 'echo 9.9.9' > \"$HOME/.local/bin/agy\"\nchmod +x \"$HOME/.local/bin/agy\"\n";
    const sha256 = createHash("sha256").update(installer).digest("hex");
    const customManifest = path.join(dir, "agents.json");
    fs.writeFileSync(
      customManifest,
      JSON.stringify({
        antigravity: { command: "agy", install: { method: "script", url: "https://example.test/install.sh", sha256 } },
      })
    );
    executable(
      path.join(bin, "curl"),
      [
        "#!/bin/sh",
        'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; *) shift;; esac; done',
        'printf \'%s\' "$FAKE_INSTALLER" > "$out"',
      ].join("\n")
    );
    const env = { ...envFor(dir, bin), FAKE_INSTALLER: installer };
    installAgentCli("antigravity", { manifestPath: customManifest, env });
    assert.ok(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "bin", "agy")));

    fs.writeFileSync(
      customManifest,
      JSON.stringify({
        antigravity: {
          command: "agy",
          install: { method: "script", url: "https://example.test/install.sh", sha256: "0".repeat(64) },
        },
      })
    );
    fs.rmSync(path.join(env.CAIRN_CLI_ROOT, "bin", "agy"), { force: true });
    assert.throws(() => installAgentCli("antigravity", { manifestPath: customManifest, env }), /checksum mismatch/);
  }));

test("Docker image ships the installer but no provider CLI layer", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(root, "scripts", "docker-entrypoint.sh"), "utf8");
  assert.match(dockerfile, /COPY scripts\/install-agent-cli\.mjs \/usr\/local\/lib\/cairn/);
  assert.match(dockerfile, /CAIRN_CLI_ROOT=\/home\/app\/\.cairn-tools/);
  assert.doesNotMatch(dockerfile, /ARG INSTALL_CLAUDE|ARG INSTALL_CODEX|UPDATE_CLAUDE=|CLAUDE_CODE_VERSION=/);
  assert.match(entrypoint, /mkdir -p \/data \/home\/app\/\.cairn-tools\/bin/);
  assert.doesNotMatch(entrypoint, /link_home_cli|ln -sfn/);
});

test("stable shell wrapper delegates only to the bundled manager", () => {
  const wrapper = fs.readFileSync(path.join(root, "scripts", "update-agent-clis.sh"), "utf8");
  assert.match(wrapper, /install-agent-cli\.mjs/);
  assert.match(wrapper, /exec node "\$manager" "\$@"/);
  const result = spawnSync("sh", [path.join(root, "scripts", "update-agent-clis.sh")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/);
});
