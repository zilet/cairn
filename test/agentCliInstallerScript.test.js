import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  failureLine,
  installAgentCli,
  platformKey,
  readAgentInstall,
  removeAgentCli,
  validateInstallSpec,
} from "../scripts/install-agent-cli.mjs";

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
  assert.deepEqual(claude.spec, {
    method: "npm",
    package: "@anthropic-ai/claude-code",
    version: "2.1.283",
    args: [],
    size_mb: 260,
    cleanup: [],
  });
  assert.deepEqual(codex.spec, {
    method: "npm",
    package: "@openai/codex",
    version: "0.157.1",
    args: ["--include=optional"],
    size_mb: 400,
    cleanup: [],
  });
  // Every installable provider declares its measured size, so a small disk fails early.
  for (const cli of [claude, codex, antigravity, grok]) assert.ok(cli.spec.size_mb > 100, cli.command);
  assert.deepEqual(grok.spec.cleanup, [".grok/downloads", ".grok/bin/grok", ".grok/bin/agent"]);
  // Vendor CLIs pin VERSIONED builds (a URL that never changes under its pin), never the
  // vendor's mutable install.sh, whose own hash went stale and bricked setup (agy,
  // 2026-10-07). The install.sh stays as the unpinned HTTPS fallback.
  for (const [cli, vendorHost] of [
    [antigravity, "https://antigravity.google/"],
    [grok, "https://x.ai/"],
  ]) {
    assert.equal(cli.spec.method, "binary");
    assert.match(cli.spec.version, /^\d+\.\d+\.\d+$/);
    assert.ok(cli.spec.script.startsWith(vendorHost), cli.spec.script);
    assert.deepEqual(cli.spec.update_args, ["update"]);
    for (const key of ["linux-x64", "linux-arm64"]) {
      const artifact = cli.spec.artifacts[key];
      assert.ok(artifact, `${cli.command} pins ${key} (the Docker image's platforms)`);
      assert.ok(artifact.url.startsWith("https://"));
      assert.ok(artifact.url.includes(cli.spec.version), `${key} URL is versioned`);
      assert.match(artifact.digest, artifact.algorithm === "sha512" ? /^[a-f0-9]{128}$/ : /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(antigravity.label, "Google");
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
        "printf '%s\\n' '#!/bin/sh' 'echo 2.1.283' > \"$CAIRN_CLI_ROOT/bin/claude\"",
        'chmod +x "$CAIRN_CLI_ROOT/bin/claude"',
      ].join("\n")
    );
    const env = { ...envFor(dir, bin), NPM_LOG: log, CAIRN_AUTH_TOKEN: "must-not-reach-installer" };
    installAgentCli("claude", { manifestPath: manifest, env });
    assert.match(fs.readFileSync(log, "utf8"), /install --global --prefix .*@anthropic-ai\/claude-code@2\.1\.283/);
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
    assert.throws(() => installAgentCli("antigravity", { manifestPath: customManifest, env }), /didn.t match the checksum Cairn ships with/);
  }));

// A fake curl that serves `$FAKE_SERVE/<last URL segment>` and fails like `curl -f` on
// a 404 when that file is absent; every URL it was asked for is logged.
function fakeCurl(bin) {
  executable(
    path.join(bin, "curl"),
    [
      "#!/bin/sh",
      'url=""; out=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; --proto|--proto-redir) shift 2;; -*) shift;; *) url=$1; shift;; esac; done',
      'printf \'%s\\n\' "$url" >> "$CURL_LOG"',
      'src="$FAKE_SERVE/$' + '{url##*/}"',
      '[ -f "$src" ] || exit 22',
      'cp "$src" "$out"',
    ].join("\n")
  );
}

function binaryManifest(dir, install) {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ grok: { command: "grok", label: "Grok", install } }));
  return file;
}

const FAKE_GROK = "#!/bin/sh\necho 'grok 1.0.46'\n";
const VENDOR_SCRIPT =
  "#!/bin/sh\nmkdir -p \"$HOME/.grok/bin\"\nprintf '%s\\n' '#!/bin/sh' 'echo grok-from-vendor-script' > \"$HOME/.grok/bin/grok\"\nchmod +x \"$HOME/.grok/bin/grok\"\n";

test("a pinned versioned build is verified, unpacked and placed on the tools PATH", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const serve = path.join(dir, "serve");
    fs.mkdirSync(serve, { recursive: true });
    fakeCurl(bin);
    const gz = zlib.gzipSync(Buffer.from(FAKE_GROK));
    fs.writeFileSync(path.join(serve, "grok-1.0.46-test.gz"), gz);
    fs.writeFileSync(path.join(serve, "install.sh"), VENDOR_SCRIPT);
    const sha256 = createHash("sha256").update(gz).digest("hex");
    const manifestFile = binaryManifest(dir, {
      method: "binary",
      version: "1.0.46",
      artifacts: { [platformKey()]: { url: "https://x.ai/cli/grok-1.0.46-test.gz", sha256, archive: "gz" } },
      script: "https://x.ai/cli/install.sh",
      update_args: ["update"],
    });
    const env = { ...envFor(dir, bin), FAKE_SERVE: serve, CURL_LOG: path.join(dir, "curl.log") };
    installAgentCli("grok", { manifestPath: manifestFile, env });
    const installed = path.join(env.CAIRN_CLI_ROOT, "bin", "grok");
    assert.equal(fs.readFileSync(installed, "utf8"), FAKE_GROK);
    assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
    // The vendor's mutable install.sh was never fetched.
    assert.doesNotMatch(fs.readFileSync(env.CURL_LOG, "utf8"), /install\.sh/);
  }));

test("a tar.gz build is extracted by its declared entry and checked by SHA-512", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const serve = path.join(dir, "serve");
    const pack = path.join(dir, "pack");
    fs.mkdirSync(serve, { recursive: true });
    executable(path.join(pack, "antigravity"), "#!/bin/sh\necho 1.3.1\n");
    const tarball = path.join(serve, "cli_test.tar.gz");
    const tar = spawnSync("tar", ["-czf", tarball, "-C", pack, "antigravity"]);
    assert.equal(tar.status, 0);
    fakeCurl(bin);
    const sha512 = createHash("sha512").update(fs.readFileSync(tarball)).digest("hex");
    const manifestFile = path.join(dir, "agents.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        antigravity: {
          command: "agy",
          label: "Google",
          install: {
            method: "binary",
            version: "1.3.1",
            artifacts: {
              [platformKey()]: {
                url: "https://storage.googleapis.com/antigravity-public/1.3.1/cli_test.tar.gz",
                sha512,
                archive: "tar.gz",
                entry: "antigravity",
              },
            },
          },
        },
      })
    );
    const env = { ...envFor(dir, bin), FAKE_SERVE: serve, CURL_LOG: path.join(dir, "curl.log") };
    installAgentCli("antigravity", { manifestPath: manifestFile, env });
    assert.match(fs.readFileSync(path.join(env.CAIRN_CLI_ROOT, "bin", "agy"), "utf8"), /echo 1\.3\.1/);
  }));

test("a checksum mismatch on a pinned build installs nothing and never falls back", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const serve = path.join(dir, "serve");
    fs.mkdirSync(serve, { recursive: true });
    fakeCurl(bin);
    fs.writeFileSync(path.join(serve, "grok-1.0.46-test.gz"), zlib.gzipSync(Buffer.from("tampered")));
    fs.writeFileSync(path.join(serve, "install.sh"), VENDOR_SCRIPT);
    const manifestFile = binaryManifest(dir, {
      method: "binary",
      version: "1.0.46",
      artifacts: { [platformKey()]: { url: "https://x.ai/cli/grok-1.0.46-test.gz", sha256: "0".repeat(64), archive: "gz" } },
      script: "https://x.ai/cli/install.sh",
    });
    const env = { ...envFor(dir, bin), FAKE_SERVE: serve, CURL_LOG: path.join(dir, "curl.log") };
    assert.throws(
      () => installAgentCli("grok", { manifestPath: manifestFile, env }),
      /^Error: Grok's download didn't match the checksum Cairn ships with, so nothing was installed\./
    );
    assert.equal(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "bin", "grok")), false);
    assert.doesNotMatch(fs.readFileSync(env.CURL_LOG, "utf8"), /install\.sh/);
  }));

test("a pruned pin (or a host with no pin) falls back to the vendor's own HTTPS installer", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const serve = path.join(dir, "serve");
    fs.mkdirSync(serve, { recursive: true });
    fakeCurl(bin);
    fs.writeFileSync(path.join(serve, "install.sh"), VENDOR_SCRIPT);
    const env = { ...envFor(dir, bin), FAKE_SERVE: serve, CURL_LOG: path.join(dir, "curl.log") };
    // The pinned build is gone (curl -f fails like a 404): the vendor script installs.
    const pruned = binaryManifest(dir, {
      method: "binary",
      version: "1.0.46",
      artifacts: { [platformKey()]: { url: "https://x.ai/cli/grok-1.0.46-gone.gz", sha256: "a".repeat(64), archive: "gz" } },
      script: "https://x.ai/cli/install.sh",
      cleanup: [".grok/bin/grok"],
    });
    installAgentCli("grok", { manifestPath: pruned, env });
    assert.match(fs.readFileSync(path.join(env.CAIRN_CLI_ROOT, "bin", "grok"), "utf8"), /grok-from-vendor-script/);
    // Cairn's copy runs, so the vendor's duplicate in HOME is cleared.
    assert.equal(fs.existsSync(path.join(env.HOME, ".grok", "bin", "grok")), false);
    assert.match(fs.readFileSync(env.CURL_LOG, "utf8"), /grok-1\.0\.46-gone\.gz\nhttps:\/\/x\.ai\/cli\/install\.sh/);

    // No pin for this host at all: straight to the vendor script.
    fs.rmSync(path.join(dir, "home"), { recursive: true, force: true });
    const unpinned = binaryManifest(dir, {
      method: "binary",
      version: "1.0.46",
      artifacts: { "plan9-mips": { url: "https://x.ai/cli/grok-1.0.46-plan9.gz", sha256: "a".repeat(64), archive: "gz" } },
      script: "https://x.ai/cli/install.sh",
    });
    installAgentCli("grok", { manifestPath: unpinned, env });
    assert.match(fs.readFileSync(path.join(env.CAIRN_CLI_ROOT, "bin", "grok"), "utf8"), /grok-from-vendor-script/);
  }));

test("binary install specs are validated before anything is fetched", () => {
  const ok = { url: "https://x.ai/cli/grok-1.0.46-linux-x86_64.gz", sha256: "a".repeat(64), archive: "gz" };
  const spec = (over) => ({ method: "binary", version: "1.0.46", artifacts: { "linux-x64": { ...ok, ...over } } });
  assert.equal(validateInstallSpec("grok", spec({})).artifacts["linux-x64"].algorithm, "sha256");
  assert.throws(() => validateInstallSpec("grok", spec({ url: "http://x.ai/cli/grok" })), /HTTPS/);
  assert.throws(() => validateInstallSpec("grok", spec({ url: "https://u:p@x.ai/cli/grok" })), /credentials/);
  assert.throws(() => validateInstallSpec("grok", spec({ sha256: undefined })), /sha256 or sha512 pin/);
  assert.throws(() => validateInstallSpec("grok", spec({ sha512: "b".repeat(64) })), /SHA-512 is invalid/);
  assert.throws(() => validateInstallSpec("grok", spec({ archive: "zip" })), /archive type/);
  assert.throws(() => validateInstallSpec("grok", spec({ archive: "tar.gz" })), /archive entry/);
  assert.throws(() => validateInstallSpec("grok", spec({ archive: "tar.gz", entry: "../agy" })), /archive entry/);
  assert.throws(() => validateInstallSpec("grok", { ...spec({}), version: "latest" }), /exact semver/);
  assert.throws(() => validateInstallSpec("grok", { ...spec({}), script: "http://x.ai/cli/install.sh" }), /HTTPS/);
  assert.throws(() => validateInstallSpec("grok", { method: "binary", version: "1.0.0", artifacts: {} }), /no artifact or vendor installer/);
  assert.equal(platformKey("linux", "x64", false), "linux-x64");
  assert.equal(platformKey("linux", "arm64", true), "linux-arm64-musl");
  assert.equal(platformKey("darwin", "arm64", false), "darwin-arm64");
});

test("an install that does not START is removed and fails as not_runnable", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    // npm "succeeds" but leaves only the launcher stub (what a full disk did on Railway).
    executable(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'mkdir -p "$CAIRN_CLI_ROOT/bin" "$CAIRN_CLI_ROOT/lib/node_modules/@anthropic-ai/claude-code"',
        "printf '%s\\n' '#!/bin/sh' 'echo \"Error: claude native binary not installed\" >&2' 'exit 1' > \"$CAIRN_CLI_ROOT/bin/claude\"",
        'chmod +x "$CAIRN_CLI_ROOT/bin/claude"',
      ].join("\n")
    );
    const env = envFor(dir, bin);
    let error = null;
    try {
      installAgentCli("claude", { manifestPath: manifest, env, freeMb: () => 50_000 });
    } catch (e) {
      error = e;
    }
    assert.ok(error, "a stub that cannot start must never read as installed");
    // Plenty of disk here, so the reason is the binary itself.
    assert.equal(error.reason, "not_runnable");
    assert.match(error.message, /^Claude was installed but doesn't start on this server, so Cairn removed it\./);
    assert.match(error.message, /claude native binary not installed/);
    assert.equal(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "bin", "claude")), false);
    assert.equal(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "lib", "node_modules", "@anthropic-ai", "claude-code")), false);
    const line = failureLine(error);
    assert.ok(line.startsWith("CAIRN_INSTALL_FAILURE {"));
    assert.equal(JSON.parse(line.slice("CAIRN_INSTALL_FAILURE ".length)).agent, "claude");
  }));

test("too little free disk fails before anything is downloaded, in plain words", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "npm.log");
    executable(path.join(bin, "npm"), '#!/bin/sh\necho called >> "$NPM_LOG"\n');
    const env = { ...envFor(dir, bin), NPM_LOG: log };
    assert.throws(
      () => installAgentCli("claude", { manifestPath: manifest, env, freeMb: () => 61 }),
      (e) =>
        e.reason === "disk_full" &&
        e.free_mb === 61 &&
        e.need_mb === 260 &&
        e.message ===
          "Your server's disk is nearly full (61 MB free; Claude needs about 260 MB). Use a bigger volume or remove a provider you don't use."
    );
    assert.equal(fs.existsSync(log), false, "npm never ran");
  }));

test("a stub left behind on a full disk is reported as the disk, not the provider", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    executable(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'mkdir -p "$CAIRN_CLI_ROOT/bin"',
        "printf '%s\\n' '#!/bin/sh' 'exit 1' > \"$CAIRN_CLI_ROOT/bin/claude\"",
        'chmod +x "$CAIRN_CLI_ROOT/bin/claude"',
      ].join("\n")
    );
    const env = envFor(dir, bin);
    let calls = 0;
    // Room at the start (the pre-check passes), 40 MB once npm has filled the disk.
    const freeMb = () => (calls++ === 0 ? 5_000 : 40);
    assert.throws(
      () => installAgentCli("claude", { manifestPath: manifest, env, freeMb }),
      (e) => e.reason === "disk_full" && /^Your server's disk is nearly full \(40 MB free; Claude needs about 260 MB\)/.test(e.message)
    );
    assert.equal(fs.existsSync(path.join(env.CAIRN_CLI_ROOT, "bin", "claude")), false);
  }));

test("remove takes a provider's tool off the volume and keeps its sign-in", () =>
  withTempDir((dir) => {
    const env = envFor(dir, path.join(dir, "bin"));
    const tools = env.CAIRN_CLI_ROOT;
    executable(path.join(tools, "bin", "grok"), "#!/bin/sh\necho grok\n");
    executable(path.join(env.HOME, ".grok", "downloads", "grok-linux-x86_64"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(env.HOME, ".grok", "auth.json"), "{}");
    removeAgentCli("grok", { manifestPath: manifest, env });
    assert.equal(fs.existsSync(path.join(tools, "bin", "grok")), false);
    assert.equal(fs.existsSync(path.join(env.HOME, ".grok", "downloads")), false);
    assert.equal(fs.existsSync(path.join(env.HOME, ".grok", "auth.json")), true, "the sign-in stays");
  }));

test("Docker image ships the installer but no provider CLI layer", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(root, "scripts", "docker-entrypoint.sh"), "utf8");
  assert.match(dockerfile, /COPY scripts\/install-agent-cli\.mjs \/usr\/local\/lib\/cairn/);
  assert.match(dockerfile, /CAIRN_CLI_ROOT=\/home\/app\/\.cairn-tools/);
  assert.doesNotMatch(dockerfile, /ARG INSTALL_CLAUDE|ARG INSTALL_CODEX|UPDATE_CLAUDE=|CLAUDE_CODE_VERSION=/);
  assert.match(entrypoint, /IMAGE_HOME=\/home\/app/);
  assert.match(entrypoint, /mkdir -p "\$DATA_ROOT" "\$APP_HOME\/\.cairn-tools\/bin"/);
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
