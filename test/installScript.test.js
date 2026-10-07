// The one-line installer (deploy/install.sh) is POSIX sh that runs as `curl | sh` on
// machines we never see, so it is checked here without a container engine: syntax,
// shellcheck when present, and its pure planning via --dry-run / --no-start (which
// print or write the compose file, .env and updater units and never touch Docker).
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "deploy", "install.sh");
// `sh` is dash on Debian/Ubuntu CI and bash-as-sh on macOS; set CAIRN_INSTALLER_TEST_SH
// (e.g. /bin/dash, busybox sh) to run the whole file under another POSIX shell.
const SH = process.env.CAIRN_INSTALLER_TEST_SH || "sh";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-installer-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Run the installer with no terminal (CAIRN_NO_TTY) and a throwaway HOME. Linux is
// forced so the plan does not depend on the machine running the suite.
function run(args, { env = {}, input, viaStdin = false } = {}) {
  const argv = viaStdin ? ["-s", "--", ...args] : [script, ...args];
  const res = spawnSync(SH, argv, {
    encoding: "utf8",
    input: viaStdin ? fs.readFileSync(script, "utf8") : input,
    env: {
      PATH: process.env.PATH,
      HOME: env.HOME || os.tmpdir(),
      TZ: "Europe/Berlin",
      CAIRN_NO_TTY: "1",
      CAIRN_INSTALL_OS: "Linux",
      CAIRN_INSTALL_ARCH: "x86_64",
      CAIRN_INSTALL_LONG_BIT: "64",
      ...env,
    },
  });
  return { code: res.status, out: res.stdout, err: res.stderr, all: `${res.stdout}\n${res.stderr}` };
}

function section(out, name) {
  const start = out.indexOf(`----- ${name}`);
  assert.notEqual(start, -1, `missing section ${name}\n${out}`);
  const body = out.slice(out.indexOf("\n", start) + 1);
  return body.slice(0, body.indexOf("----- end -----"));
}

function envKeys(text) {
  return new Set([...text.matchAll(/^\s+- ([A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

test("installer parses as POSIX sh and stays shellcheck-clean when shellcheck exists", (t) => {
  const syntax = spawnSync(SH, ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(fs.statSync(script).mode & 0o111, 0o111, "deploy/install.sh must be executable");
  const head = fs.readFileSync(script, "utf8");
  assert.match(head, /^#!\/bin\/sh\n/);
  // A truncated `curl | sh` download must run nothing: main is the very last line.
  assert.match(head, /\nmain "\$@"\n$/);
  const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("shellcheck not installed");
    return;
  }
  const sc = spawnSync("shellcheck", ["-s", "sh", script], { encoding: "utf8" });
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);
});

test("default dry run: loopback, a required token, the app's updater contract, nothing printed secret", () =>
  withTempDir((dir) => {
    const r = run(["--dry-run", `--dir=${dir}/cairn`, "--updater=systemd"]);
    assert.equal(r.code, 0, r.all);
    const env = section(r.out, `${dir}/cairn/.env`);
    assert.match(env, /^CAIRN_BIND_HOST=127\.0\.0\.1$/m);
    assert.match(env, /^CAIRN_REQUIRE_AUTH=1$/m);
    assert.match(env, /^CAIRN_PLATFORM=installer$/m);
    assert.match(env, /^CAIRN_UPDATE_METHOD=trigger-file$/m);
    assert.match(env, /^CAIRN_BLANK_PROFILE=1$/m);
    assert.match(env, /^TZ=Europe\/Berlin$/m);
    assert.match(env, /^CAIRN_AUTH_TOKEN=<generated/m);
    assert.doesNotMatch(r.all, /[0-9a-f]{64}/, "a dry run must never print a real secret");
    const compose = section(r.out, `${dir}/cairn/docker-compose.yml`);
    assert.match(compose, /"\$\{CAIRN_BIND_HOST:-127\.0\.0\.1\}:\$\{CAIRN_HOST_PORT:-8787\}:8787"/);
    assert.doesNotMatch(compose, /caddy/);
    // Nightly between 03:00 and 04:59, plus the 5-minute "Update now" check.
    const nightly = section(r.out, "$HOME/.config/systemd/user/cairn-update.timer");
    assert.match(nightly, /^OnCalendar=\*-\*-\* 0[34]:[0-5][0-9]:00$/m);
    const check = section(r.out, "$HOME/.config/systemd/user/cairn-update-check.timer");
    assert.match(check, /^OnCalendar=\*:0\/5$/m);
    const checkService = section(r.out, "$HOME/.config/systemd/user/cairn-update-check.service");
    assert.match(checkService, /cairn\.sh update --if-requested --dir=/);
    assert.equal(fs.existsSync(path.join(dir, "cairn")), false, "a dry run writes nothing");
  }));

test("dry run works as `curl | sh` (script on stdin, args after -s --)", () =>
  withTempDir((dir) => {
    const r = run(["--dry-run", `--dir=${dir}/c`, "--no-updater"], { viaStdin: true });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Dry run: nothing was changed/);
  }));

test("--https=caddy needs a domain, adds Caddy on 80/443 and keeps the app port on loopback", () =>
  withTempDir((dir) => {
    const missing = run(["--dry-run", `--dir=${dir}/c`, "--https=caddy"]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /--domain/);

    const r = run(["--dry-run", `--dir=${dir}/c`, "--https=caddy", "--domain=cairn.example.com", "--no-updater"]);
    assert.equal(r.code, 0, r.all);
    const env = section(r.out, `${dir}/c/.env`);
    assert.match(env, /^CAIRN_BIND_HOST=127\.0\.0\.1$/m);
    assert.match(env, /^CAIRN_REQUIRE_AUTH=1$/m);
    assert.match(env, /^CAIRN_DOMAIN=cairn\.example\.com$/m);
    const compose = section(r.out, `${dir}/c/docker-compose.yml`);
    assert.match(compose, /\n {2}caddy:\n/);
    assert.match(compose, /- "443:443"/);
    assert.match(compose, /- "80:80"/);
    assert.match(compose, /caddy-data:/);
    const caddyfile = section(r.out, `${dir}/c/Caddyfile`);
    assert.match(caddyfile, /^cairn\.example\.com \{$/m);
    assert.match(caddyfile, /reverse_proxy cairn:8787/);
  }));

test("--lan binds every interface and still requires the token; exposure flags are exclusive", () =>
  withTempDir((dir) => {
    const r = run(["--dry-run", `--dir=${dir}/c`, "--lan", "--no-updater"]);
    assert.equal(r.code, 0, r.all);
    const env = section(r.out, `${dir}/c/.env`);
    assert.match(env, /^CAIRN_BIND_HOST=0\.0\.0\.0$/m);
    assert.match(env, /^CAIRN_REQUIRE_AUTH=1$/m);
    const both = run(["--dry-run", `--dir=${dir}/c`, "--lan", "--https=tailscale"]);
    assert.notEqual(both.code, 0);
  }));

test("refuses 32-bit systems and unsupported operating systems with a clear reason", () => {
  for (const env of [
    { CAIRN_INSTALL_ARCH: "armv7l" },
    { CAIRN_INSTALL_ARCH: "i686" },
    { CAIRN_INSTALL_ARCH: "aarch64", CAIRN_INSTALL_LONG_BIT: "32" },
  ]) {
    const r = run(["--dry-run", "--no-updater"], { env });
    assert.notEqual(r.code, 0, JSON.stringify(env));
    assert.match(r.err, /64-bit/);
  }
  const bsd = run(["--dry-run"], { env: { CAIRN_INSTALL_OS: "FreeBSD" } });
  assert.notEqual(bsd.code, 0);
  assert.match(bsd.err, /Unsupported OS/);
  const arm64 = run(["--dry-run", "--no-updater", "--dir=/tmp/cairn-arm64-plan"], {
    env: { CAIRN_INSTALL_ARCH: "aarch64" },
  });
  assert.equal(arm64.code, 0, arm64.all);
});

test("rejects unsafe or malformed option values", () => {
  for (const args of [
    ["--port=99999"],
    ["--port=80a"],
    ["--https=caddy", "--domain=not a domain"],
    ["--https=funnel"],
    ["--name=Bad Name"],
    ["--dir=/tmp/has space/cairn"],
    ["--tz=Europe/Berlin;rm"],
    ["--bogus"],
  ]) {
    const r = run(["--dry-run", "--no-updater", ...args]);
    assert.notEqual(r.code, 0, `should reject ${args.join(" ")}`);
  }
});

test("cron and launchd updater plans carry both schedules", () =>
  withTempDir((dir) => {
    const cron = run(["--dry-run", `--dir=${dir}/c`, "--updater=cron"]);
    assert.equal(cron.code, 0, cron.all);
    const lines = section(cron.out, "crontab entries").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{1,2} [34] \* \* \* \/bin\/sh .*cairn\.sh update --nightly .*# cairn-updater:cairn$/);
    assert.match(lines[1], /^\*\/5 \* \* \* \* \/bin\/sh .*cairn\.sh update --if-requested .*# cairn-updater:cairn$/);

    const mac = run(["--dry-run", `--dir=${dir}/c`], {
      env: { CAIRN_INSTALL_OS: "Darwin", CAIRN_INSTALL_ARCH: "arm64" },
    });
    assert.equal(mac.code, 0, mac.all);
    const check = section(mac.out, "$HOME/Library/LaunchAgents/local.cairn.cairn.update-check.plist");
    assert.match(check, /<key>StartInterval<\/key><integer>300<\/integer>/);
    const nightly = section(mac.out, "$HOME/Library/LaunchAgents/local.cairn.cairn.update.plist");
    assert.match(nightly, /<key>Hour<\/key><integer>[34]<\/integer>/);
  }));

test("the installer's compose passes through every setting the release compose does", () =>
  withTempDir((dir) => {
    const release = fs.readFileSync(path.join(root, "deploy", "docker-compose.release.yml"), "utf8");
    const r = run(["--dry-run", `--dir=${dir}/c`, "--no-updater"]);
    assert.equal(r.code, 0, r.all);
    const compose = section(r.out, `${dir}/c/docker-compose.yml`);
    const ours = envKeys(compose);
    for (const key of envKeys(release)) assert.ok(ours.has(key), `installer compose drops ${key}`);
    assert.match(release, /image: ghcr\.io\/zilet\/cairn:latest/);
    assert.match(compose, /image: \$\{CAIRN_IMAGE:-ghcr\.io\/zilet\/cairn:latest\}/);
    for (const volume of ["cairn-data:/data", "cairn-home:/home/app", "cairn-tools:/home/app/.cairn-tools"]) {
      assert.ok(release.includes(volume) && compose.includes(volume), volume);
    }
  }));

test("--no-start writes private config once; re-running keeps the token, key and user lines", () =>
  withTempDir((dir) => {
    const target = path.join(dir, "cairn");
    const refuse = run(["--no-start", `--dir=${target}`, "--no-updater"]);
    assert.notEqual(refuse.code, 0, "no terminal and no --yes must not install");
    assert.match(refuse.err, /--yes/);
    assert.equal(fs.existsSync(path.join(target, ".env")), false);

    const first = run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"]);
    assert.equal(first.code, 0, first.all);
    const envPath = path.join(target, ".env");
    const env1 = fs.readFileSync(envPath, "utf8");
    const token = /^CAIRN_AUTH_TOKEN=([0-9a-f]{64})$/m.exec(env1)?.[1];
    const key = /^CAIRN_SETTINGS_SECRET_KEY=([0-9a-f]{64})$/m.exec(env1)?.[1];
    assert.ok(token && key, env1);
    assert.notEqual(token, key);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.match(env1, /^CAIRN_BLANK_PROFILE=1$/m);
    assert.match(fs.readFileSync(path.join(target, "docker-compose.yml"), "utf8"), /CAIRN_ONE_LINE_INSTALLER/);
    const copy = path.join(target, "cairn.sh");
    assert.equal(fs.readFileSync(copy, "utf8"), fs.readFileSync(script, "utf8"));
    assert.equal(fs.statSync(copy).mode & 0o100, 0o100);

    // The user adds their own settings and drops the blank-profile line.
    fs.writeFileSync(
      envPath,
      `${env1.replace(/^CAIRN_BLANK_PROFILE=1\n/m, "")}GEMINI_API_KEY=user-art-key\n# my note\n`
    );
    // A data volume that does not exist yet: the missing key defaults to blank again.
    const fakebin = path.join(dir, "bin");
    fs.mkdirSync(fakebin);
    const fakeTool = (exitCode) => {
      fs.writeFileSync(path.join(fakebin, "voltool"), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
      return { PATH: `${fakebin}:${process.env.PATH}`, CAIRN_CONTAINER_TOOL: "voltool" };
    };
    const fresh = run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"], { env: fakeTool(1) });
    assert.equal(fresh.code, 0, fresh.all);
    assert.match(fs.readFileSync(envPath, "utf8"), /^CAIRN_BLANK_PROFILE=1$/m, "no data volume yet: blank");
    fs.writeFileSync(envPath, fs.readFileSync(envPath, "utf8").replace(/^CAIRN_BLANK_PROFILE=1\n/m, ""));
    // The volume exists: an install that already has data is not flipped.
    const second = run(["--no-start", "--yes", `--dir=${target}`, "--lan", "--port=8790", "--no-updater"], {
      env: fakeTool(0),
    });
    assert.equal(second.code, 0, second.all);
    const env2 = fs.readFileSync(envPath, "utf8");
    assert.match(env2, new RegExp(`^CAIRN_AUTH_TOKEN=${token}$`, "m"));
    assert.match(env2, new RegExp(`^CAIRN_SETTINGS_SECRET_KEY=${key}$`, "m"));
    assert.match(env2, /^GEMINI_API_KEY=user-art-key$/m);
    assert.match(env2, /^# my note$/m);
    assert.doesNotMatch(env2, /^CAIRN_BLANK_PROFILE=/m, "blank profile is a first-install default only");
    assert.match(env2, /^CAIRN_BIND_HOST=0\.0\.0\.0$/m);
    assert.match(env2, /^CAIRN_HOST_PORT=8790$/m);
    assert.equal(env2.match(/^CAIRN_AUTH_TOKEN=/gm).length, 1);
    assert.equal(env2.match(/^## Cairn instance settings/gm).length, 1);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);

    // A re-run without flags keeps the chosen exposure and port.
    const third = run(["--dry-run", `--dir=${target}`, "--no-updater"]);
    assert.equal(third.code, 0, third.all);
    assert.match(third.out, /^CAIRN_BIND_HOST=0\.0\.0\.0$/m);
    assert.match(third.out, /^CAIRN_AUTH_TOKEN=<kept/m);
    assert.match(third.out, /^GEMINI_API_KEY=<kept>$/m);
    assert.doesNotMatch(third.all, /user-art-key|[0-9a-f]{64}/);

    // Another instance name cannot silently take over this directory's volumes.
    const clash = run(["--dry-run", `--dir=${target}`, "--name=other", "--no-updater"]);
    assert.notEqual(clash.code, 0);
    assert.match(clash.err, /already holds the Cairn instance 'cairn'/);
  }));

test("purge needs an explicit confirmation even with --yes", () =>
  withTempDir((dir) => {
    const target = path.join(dir, "cairn");
    assert.equal(run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"]).code, 0);
    const r = run(["uninstall", "--purge", "--yes", `--dir=${target}`]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--confirm-purge=cairn/);
    const wrong = run(["uninstall", "--purge", "--yes", "--confirm-purge=nope", `--dir=${target}`]);
    assert.notEqual(wrong.code, 0);
    const plan = run(["uninstall", "--dry-run", `--dir=${target}`]);
    assert.equal(plan.code, 0, plan.all);
    assert.match(plan.out, /keep the data volumes/);
    assert.ok(fs.existsSync(path.join(target, ".env")), "nothing was removed");
  }));

test("a fetched self-copy must come over https", () =>
  withTempDir((dir) => {
    const r = run(["--no-start", "--yes", `--dir=${dir}/c`, "--no-updater"], {
      viaStdin: true,
      env: { CAIRN_INSTALL_SCRIPT_URL: "http://example.invalid/install.sh" },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /https/);
  }));

test("the updater speaks the app's trigger-file contract", () => {
  const text = fs.readFileSync(script, "utf8");
  assert.match(text, /TRIGGER_FILE="\/data\/\.cairn-update-requested"/);
  assert.match(text, /STATUS_FILE="\/data\/\.cairn-updater\.json"/);
  for (const result of ["updated", "current", "rolled_back", "failed"]) {
    assert.ok(text.includes(`UPDATE_RESULT="${result}"`), `updater never reports ${result}`);
  }
  // Nothing is ever piped from curl into a shell; Docker's script (the one download
  // that is executed, after consent) is saved to a file first and run from there.
  // (The usage text shows the installer's own one-liner; that is help, not code.)
  const piped = text.split("\n").filter((line) => /^\s*curl\b.*\|\s*(sudo\s+)?(ba)?sh\b/.test(line));
  assert.deepEqual(
    piped.filter((line) => !/\/install\.sh \| sh/.test(line)),
    []
  );
  assert.match(text, /curl -fsSL --proto '=https' --tlsv1\.2 https:\/\/get\.docker\.com -o "\$docker_tmp"/);
  assert.match(text, /consent_script "Install Docker now[^\n]*"\$OPT_INSTALL_DOCKER" "--install-docker"/);
});

// A stand-in container engine: `docker` and `curl` shims backed by files in a state
// dir, so install -> update (current / updated / rolled back / held back) ->
// "Update now" trigger -> uninstall run end to end with no real engine or network.
const FAKE_DOCKER = String.raw`#!/bin/sh
S="$FAKE_STATE"
echo "docker $*" >>"$S/log"
key() { printf 'tag_%s' "$(printf '%s' "$1" | tr '/:@' '___')"; }
tagid() { cat "$S/$(key "$1")" 2>/dev/null; }
img() { sed -n 's/^CAIRN_IMAGE=//p' .env; }
case "$1" in
  info) exit 0 ;;
  compose)
    shift
    if [ "$1" = version ]; then echo "Docker Compose version v2"; exit 0; fi
    [ "$1" = -p ] && shift 2
    sub="$1"; shift
    case "$sub" in
      pull) [ -f "$S/pull_fails" ] && exit 1; cp "$S/remote_id" "$S/$(key "$(img)")" ;;
      up)
        [ -f "$S/$(key "$(img)")" ] || cp "$S/remote_id" "$S/$(key "$(img)")"
        tagid "$(img)" >"$S/running_id"; touch "$S/running" "$S/exists" ;;
      down)
        rm -f "$S/running" "$S/exists"
        case "$*" in *--volumes*) touch "$S/volumes_removed" ;; esac ;;
    esac
    exit 0 ;;
  container)
    shift; [ "$1" = inspect ] && shift
    fmt=""; if [ "$1" = -f ]; then fmt="$2"; shift 2; fi
    [ -f "$S/exists" ] || exit 1
    case "$fmt" in
      "") ;;
      *State.Running*) if [ -f "$S/running" ]; then echo true; else echo false; fi ;;
      *Labels*com.docker.compose.project*) echo "$FAKE_PROJECT" ;;
      *Image*) echo "sha256:$(cat "$S/running_id")" ;;
      *) echo "<no value>" ;;
    esac
    exit 0 ;;
  image)
    shift; [ "$1" = inspect ] && shift; [ "$1" = -f ] && shift 2
    id=$(tagid "$1"); [ -n "$id" ] || exit 1; echo "sha256:$id" ;;
  tag)
    case "$2" in *[!0-9a-f]*) id=$(tagid "$2") ;; *) id="$2" ;; esac
    [ -n "$id" ] || exit 1; printf '%s\n' "$id" >"$S/$(key "$3")" ;;
  exec)
    shift
    while :; do case "$1" in -i) shift ;; -u) shift 2 ;; *) break ;; esac; done
    shift
    case "$1" in
      test) [ -f "$S/trigger" ] ;;
      rm) rm -f "$S/trigger" ;;
      sh) cat >"$S/status.json" ;;
    esac ;;
  rmi) exit 0 ;;
  rm) rm -f "$S/running" "$S/exists" ;;
  volume) [ "$2" = rm ] && touch "$S/volumes_removed" ;;
esac
`;

const FAKE_CURL = `#!/bin/sh
S="$FAKE_STATE"
echo "curl $*" >>"$S/log"
out=""; url=""; wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    --max-time | -X | -H | -d) shift 2 ;;
    -K) cat >>"$S/curl_config"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -f "$S/running" ] || exit 7
id=$(cat "$S/running_id")
case "$url" in
  */api/health) [ -f "$S/healthy_$id" ] || exit 22; printf '{"ok":true,"auth_required":true,"version":"%s"}' "$(cat "$S/healthy_$id")" ;;
  */api/export/db) printf 'SQLite format 3' >"$out" ;;
  */api/auth/pairing-codes)
    [ -f "$S/pairing_ok" ] || exit 6
    printf '{"code":"LOCL-0001","expires_at":"2026-01-01T00:10:00Z"}' >"$out"
    [ -z "$wfmt" ] || printf '200' ;;
  *) exit 6 ;;
esac
`;

test("fake engine: install, update, roll back, hold back, Update-now trigger, uninstall", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const state = path.join(dir, "state");
    const target = path.join(dir, "cairn");
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
    const ids = { a: "a".repeat(12), b: "b".repeat(12), c: "c".repeat(12), d: "d".repeat(12) };
    const remote = (id, version) => {
      fs.writeFileSync(path.join(state, "remote_id"), `${id}\n`);
      if (version) fs.writeFileSync(path.join(state, `healthy_${id}`), version);
    };
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      FAKE_STATE: state,
      FAKE_PROJECT: "cairn",
      CAIRN_CONTAINER_TOOL: "docker",
      CAIRN_HEALTH_TIMEOUT: "9",
    };
    const status = () => JSON.parse(fs.readFileSync(path.join(state, "status.json"), "utf8"));
    const running = () => fs.readFileSync(path.join(state, "running_id"), "utf8").trim();
    const cairnSh = (args) => {
      const res = spawnSync(SH, [path.join(target, "cairn.sh"), ...args], {
        encoding: "utf8",
        env: {
          ...env,
          CAIRN_NO_TTY: "1",
          TZ: "UTC",
          CAIRN_INSTALL_OS: "Linux",
          CAIRN_INSTALL_ARCH: "x86_64",
          CAIRN_INSTALL_LONG_BIT: "64",
        },
      });
      return { code: res.status, all: `${res.stdout}\n${res.stderr}` };
    };

    remote(ids.a, "2.0.0");
    const install = run(["--yes", `--dir=${target}`, "--no-updater"], { env });
    assert.equal(install.code, 0, install.all);
    assert.match(install.out, /Cairn is running \(v2\.0\.0\)/);
    assert.match(install.out, /not printed: this output is not a terminal/);
    const envText = fs.readFileSync(path.join(target, ".env"), "utf8");
    const token = /^CAIRN_AUTH_TOKEN=([0-9a-f]{64})$/m.exec(envText)[1];
    assert.doesNotMatch(install.all, new RegExp(token), "a non-terminal install never prints the token");
    assert.match(envText, /^CAIRN_ENGINE=docker$/m);
    assert.equal(status().installed, true);
    assert.equal(status().last_result, "current");

    // Nothing new published.
    let r = cairnSh(["update"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(status().last_result, "current");

    // A healthy new release: snapshot first, then switch, keep the old one for rollback.
    remote(ids.b, "2.0.1");
    r = cairnSh(["update"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(running(), ids.b);
    assert.equal(status().last_result, "updated");
    assert.equal(status().version, "2.0.1");
    assert.equal(status().previous_version, "2.0.0");
    const snapshots = fs.readdirSync(path.join(target, "backups")).filter((f) => f.startsWith("pre-update-"));
    assert.equal(snapshots.length, 1);
    assert.ok(fs.readFileSync(path.join(state, "curl_config"), "utf8").includes(token), "token travels on stdin");
    assert.doesNotMatch(fs.readFileSync(path.join(state, "log"), "utf8"), new RegExp(token), "token never in argv");

    // An unhealthy release rolls back to the previous image and is then held back.
    remote(ids.c);
    r = cairnSh(["update"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(running(), ids.b);
    assert.equal(status().last_result, "rolled_back");
    r = cairnSh(["update"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(status().last_result, "current");
    assert.match(status().detail, /held back/);
    assert.equal(running(), ids.b);
    assert.equal(
      fs.readFileSync(path.join(state, "tag_ghcr.io_zilet_cairn_latest"), "utf8").trim(),
      ids.b,
      "the local tag points back at the running image after a hold"
    );

    // The 5-minute tick: no request -> heartbeat only; a request -> update + clear it.
    remote(ids.d, "2.0.2");
    r = cairnSh(["update", "--if-requested"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(running(), ids.b);
    assert.ok(status().last_check);
    fs.writeFileSync(path.join(state, "trigger"), '{"requested_at":"2026-01-01T00:00:00Z"}');
    r = cairnSh(["update", "--if-requested"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(running(), ids.d);
    assert.equal(status().last_result, "updated");
    assert.equal(status().trigger, "requested");
    assert.equal(fs.existsSync(path.join(state, "trigger")), false, "the trigger file is consumed");

    // A pull failure is reported, not hidden.
    fs.writeFileSync(path.join(state, "pull_fails"), "");
    r = cairnSh(["update", "--nightly"]);
    assert.notEqual(r.code, 0);
    assert.equal(status().last_result, "failed");
    fs.rmSync(path.join(state, "pull_fails"));

    r = cairnSh(["status"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /running, healthy, v2\.0\.2/);
    assert.doesNotMatch(r.all, new RegExp(token));

    // A container someone stopped on purpose is not revived by the nightly timer.
    fs.rmSync(path.join(state, "running"));
    remote("e".repeat(12), "2.0.3");
    r = cairnSh(["update", "--nightly"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.existsSync(path.join(state, "running")), false);
    const hostStatus = JSON.parse(fs.readFileSync(path.join(target, "updater-status.json"), "utf8"));
    assert.equal(hostStatus.last_result, "current");
    assert.match(hostStatus.detail, /stopped/);

    r = cairnSh(["uninstall", "--yes"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.existsSync(path.join(state, "running")), false);
    assert.equal(fs.existsSync(path.join(state, "volumes_removed")), false, "data volumes are kept");
    assert.equal(fs.existsSync(path.join(target, "docker-compose.yml")), false);
    assert.ok(fs.existsSync(path.join(target, ".env")), ".env (token + settings key) is kept");

    // The purge the uninstall message points to still works with only .env left.
    const purge = run(["uninstall", "--purge", "--yes", "--confirm-purge=cairn", `--dir=${target}`], { env });
    assert.equal(purge.code, 0, purge.all);
    assert.ok(fs.existsSync(path.join(state, "volumes_removed")), "purge removes the data volumes");
    assert.equal(fs.existsSync(target), false);
  }));

test("fake engine: a local install ends signed in through a one-time pairing link", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    const state = path.join(dir, "state");
    const target = path.join(dir, "cairn");
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    for (const [name, body] of [
      ["docker", FAKE_DOCKER],
      ["curl", FAKE_CURL],
      ["sleep", "#!/bin/sh\nexit 0\n"],
      ["xdg-open", '#!/bin/sh\necho "$1" >>"$FAKE_STATE/opened"\n'],
    ]) {
      fs.writeFileSync(path.join(bin, name), body);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    const id = "f".repeat(12);
    fs.writeFileSync(path.join(state, "remote_id"), `${id}\n`);
    fs.writeFileSync(path.join(state, `healthy_${id}`), "2.1.0");
    fs.writeFileSync(path.join(state, "pairing_ok"), "");
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      FAKE_STATE: state,
      FAKE_PROJECT: "cairn",
      CAIRN_CONTAINER_TOOL: "docker",
      CAIRN_HEALTH_TIMEOUT: "9",
      DISPLAY: ":0",
    };
    const r = run(["--target=local", "--yes", `--dir=${target}`, "--no-updater"], { env });
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.readFileSync(path.join(state, "opened"), "utf8").trim(), "http://127.0.0.1:8787/#pair=LOCL-0001");
    assert.match(r.out, /Opened Cairn in your browser, already signed in/);
    assert.match(r.out, /Pair your phone: Settings -> Devices -> Pair a device/);
    assert.match(r.out, /Your recovery key/);
    const token = /^CAIRN_AUTH_TOKEN=([0-9a-f]{64})$/m.exec(fs.readFileSync(path.join(target, ".env"), "utf8"))[1];
    assert.doesNotMatch(r.all, new RegExp(token));
    assert.ok(fs.readFileSync(path.join(state, "curl_config"), "utf8").includes(token), "pairing token on stdin");
    assert.doesNotMatch(fs.readFileSync(path.join(state, "log"), "utf8"), new RegExp(token), "token never in argv");

    // `cairn.sh open` mints a fresh code later.
    const open = spawnSync(SH, [path.join(target, "cairn.sh"), "open"], {
      encoding: "utf8",
      env: {
        ...env,
        CAIRN_NO_TTY: "1",
        CAIRN_INSTALL_OS: "Linux",
        CAIRN_INSTALL_ARCH: "x86_64",
        CAIRN_INSTALL_LONG_BIT: "64",
      },
    });
    assert.equal(open.status, 0, open.stdout + open.stderr);
    assert.equal(fs.readFileSync(path.join(state, "opened"), "utf8").trim().split("\n").length, 2);
  }));

// ----------------------------------------------------------------------------- Railway

test("with no --target and no terminal it explains the one choice and exits non-zero", () =>
  withTempDir((dir) => {
    for (const args of [[], ["--yes"], ["--dry-run"]]) {
      const r = run(args, { env: { HOME: dir } });
      assert.notEqual(r.code, 0, args.join(" "));
      assert.match(r.err, /Where should Cairn live\?/);
      assert.match(r.err, /1\) In the cloud on Railway/);
      assert.match(r.err, /2\) On this computer or server/);
      assert.match(r.err, /sh -s -- --target=railway --yes/);
      assert.match(r.err, /sh -s -- --target=local --yes/);
    }
    // This-machine flags imply the local target, as before.
    const local = run(["--dry-run", `--dir=${dir}/c`, "--no-updater"], { env: { HOME: dir } });
    assert.equal(local.code, 0, local.all);
    // And they do not mix with Railway.
    const mixed = run(["--target=railway", "--dry-run", "--lan"], { env: { HOME: dir } });
    assert.notEqual(mixed.code, 0);
    assert.match(mixed.err, /does not take this-machine options/);
    const bad = run(["--target=heroku"], { env: { HOME: dir } });
    assert.notEqual(bad.code, 0);
  }));

test("--target=railway --dry-run prints the plan and the CLI sequence, no secrets", () =>
  withTempDir((dir) => {
    const r = run(["--target=railway", "--dry-run", "--railway-project-name=my-cairn"], { env: { HOME: dir } });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /railway init --name my-cairn --json/);
    assert.match(
      r.out,
      /railway add --image ghcr\.io\/zilet\/cairn:latest --service cairn --variables CAIRN_SINGLE_VOLUME=1/
    );
    assert.match(r.out, /railway variable set CAIRN_AUTH_TOKEN --stdin/);
    assert.match(r.out, /#pair=<one-time code>/);
    assert.doesNotMatch(r.all, /[0-9a-f]{64}/);
    assert.equal(fs.existsSync(path.join(dir, ".cairn")), false, "a dry run writes nothing");
  }));

// A stand-in Railway CLI: records argv (and the directory it ran in), refuses to run
// when any argument looks like a generated secret, and answers from files in a state
// dir. Deployments: every redeploy creates dep-N whose status walks $S/statuses.
const FAKE_RAILWAY = String.raw`#!/bin/sh
S="$FAKE_STATE"
{ printf 'railway'; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >>"$S/rlog"
pwd >>"$S/rcwd"
for a in "$@"; do
  if printf '%s' "$a" | grep -Eq '[0-9a-f]{64}'; then touch "$S/secret_in_argv"; exit 99; fi
done
case "$*" in *--help*) echo "  --stdin   --from-source"; exit 0 ;; esac
stdin_value=""
case " $* " in
  *" --stdin "*) stdin_value=$(cat) ;;
  *) if [ ! -t 0 ] && [ -n "$(cat)" ]; then touch "$S/stdin_not_closed"; fi ;;
esac
DOMAIN="cairn-production-a1b2.up.railway.app"
cmd="$1"; shift
case "$cmd" in
  whoami) [ -f "$S/logged_out" ] && { echo "Unauthorized. Please login" >&2; exit 1; }; echo "Logged in as Test User" ;;
  list)
    if [ -f "$S/project" ]; then
      printf '[\n  {\n    "id": "proj-1",\n    "name": "%s",\n    "environments": {"edges": [{"node": {"id": "env-1", "name": "production"}}]},\n    "services": {"edges": [{"node": {"id": "svc-9", "name": "other"}}]}\n  }\n]\n' "$(cat "$S/project")"
    else echo "[]"; fi ;;
  init)
    while [ $# -gt 0 ]; do [ "$1" = --name ] && printf '%s' "$2" >"$S/project"; shift; done
    echo '{"id":"proj-1"}' ;;
  link | unlink) ;;
  service)
    case "$1" in
      list) if [ -f "$S/service" ]; then echo '[{"id":"svc-1","name":"cairn"}]'; else echo '[]'; fi ;;
    esac ;;
  add)
    touch "$S/service"
    while [ $# -gt 0 ]; do [ "$1" = --variables ] && printf '%s\n' "$2" >>"$S/vars"; shift; done
    echo '{"id":"svc-1","name":"cairn"}' ;;
  volume)
    case "$1" in
      list) if [ -f "$S/volume" ]; then echo '[{"id":"vol-1","mountPath":"/data"}]'; else echo '[]'; fi ;;
      add) touch "$S/volume"; echo '{"id":"vol-1","mountPath":"/data"}' ;;
    esac ;;
  variable)
    sub="$1"; shift
    case "$sub" in
      list) cat "$S/vars" 2>/dev/null ;;
      set)
        if [ -n "$stdin_value" ]; then printf '%s=%s\n' "$1" "$stdin_value" >>"$S/vars"
        else while [ $# -gt 0 ]; do case "$1" in *=*) printf '%s\n' "$1" >>"$S/vars" ;; esac; shift; done; fi ;;
    esac ;;
  domain)
    if [ "$1" = list ]; then
      if [ -f "$S/domain" ]; then echo "{\"domains\":[{\"domain\":\"$DOMAIN\"}]}"; else echo '{"domains":[]}'; fi
    else touch "$S/domain"; echo "{\"domain\":\"$DOMAIN\",\"port\":8787}"; fi ;;
  redeploy)
    n=$(( $(cat "$S/deploy_n" 2>/dev/null || echo 1) + 1 ))
    echo "$n" >"$S/deploy_n"
    cp "$S/statuses" "$S/queue"
    echo "{\"id\":\"dep-$n\",\"status\":\"INITIALIZING\"}" ;;
  deployment)
    n=$(cat "$S/deploy_n" 2>/dev/null || echo 1)
    if [ "$n" -gt 1 ]; then
      st=$(head -n 1 "$S/queue")
      if [ "$(wc -l <"$S/queue")" -gt 1 ]; then tail -n +2 "$S/queue" >"$S/queue.next"; mv "$S/queue.next" "$S/queue"; fi
      printf '[{"id":"dep-%s","status":"%s","meta":{"image":"x"}},{"id":"dep-1","status":"CRASHED"}]\n' "$n" "$st"
    else
      echo '[{"id":"dep-1","status":"CRASHED"}]'
    fi ;;
  logs)
    echo "Starting Container"
    grep '^CAIRN_AUTH_TOKEN=' "$S/vars" 2>/dev/null
    echo "Error: listen EADDRINUSE (fake failure)" ;;
  delete) touch "$S/deleted"; echo '{"ok":true}' ;;
  *) echo "fake railway: unhandled $cmd" >&2; exit 64 ;;
esac
`;

const FAKE_CURL_RAILWAY = String.raw`#!/bin/sh
S="$FAKE_STATE"
echo "curl $*" >>"$S/clog"
out=""; url=""; wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    -K) cat >>"$S/curl_config"; shift 2 ;;
    -X | -H | -d | --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://*/api/health) printf '{"ok":true,"auth_required":true,"version":"2.1.0"}' ;;
  https://*/api/auth/pairing-codes)
    if [ -f "$S/pair_404" ]; then code=404; printf '{"error":"not_found"}' >"$out"
    else code=200; printf '{\n  "code": "ABCD-EF12",\n  "expires_at": "2026-10-07T12:10:00Z"\n}\n' >"$out"; fi
    [ -z "$wfmt" ] || printf '%s' "$code" ;;
  *) exit 6 ;;
esac
`;

function railwayRig(dir) {
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  for (const [name, body] of [
    ["railway", FAKE_RAILWAY],
    ["curl", FAKE_CURL_RAILWAY],
    ["sleep", "#!/bin/sh\nexit 0\n"],
    ["xdg-open", '#!/bin/sh\necho "$1" >>"$FAKE_STATE/opened"\n'],
  ]) {
    fs.writeFileSync(path.join(bin, name), body);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.writeFileSync(path.join(state, "statuses"), "BUILDING\nDEPLOYING\nSUCCESS\n");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: dir,
    FAKE_STATE: state,
    CAIRN_HEALTH_TIMEOUT: "9",
    DISPLAY: ":0",
  };
  const stateDir = path.join(dir, ".cairn", "railway", "cairn");
  const read = (name) => (fs.existsSync(path.join(state, name)) ? fs.readFileSync(path.join(state, name), "utf8") : "");
  const cairnSh = (args) => {
    const res = spawnSync(SH, [path.join(stateDir, "cairn.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...env,
        CAIRN_NO_TTY: "1",
        CAIRN_INSTALL_OS: "Linux",
        CAIRN_INSTALL_ARCH: "x86_64",
        CAIRN_INSTALL_LONG_BIT: "64",
      },
    });
    return { code: res.status, out: res.stdout, err: res.stderr, all: `${res.stdout}\n${res.stderr}` };
  };
  const secrets = () => {
    const vars = read("vars");
    return {
      token: /^CAIRN_AUTH_TOKEN=([0-9a-f]{64})$/m.exec(vars)?.[1],
      key: /^CAIRN_SETTINGS_SECRET_KEY=([0-9a-f]{64})$/m.exec(vars)?.[1],
    };
  };
  return { state, env, stateDir, read, cairnSh, secrets };
}

// Assert that `wanted` appear in `lines` in this order (other lines may sit between).
function assertSequence(lines, wanted) {
  let at = 0;
  for (const want of wanted) {
    const found = lines.findIndex((line, i) => i >= at && line.startsWith(want));
    assert.notEqual(found, -1, `missing (in order) "${want}" in:\n${lines.join("\n")}`);
    at = found + 1;
  }
}

test("fake railway: --target=railway installs end to end, secrets only on stdin, signs in with #pair=", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(r.code, 0, r.all);

    const log = rig.read("rlog").trim().split("\n");
    assertSequence(log, [
      "railway whoami",
      "railway list --json",
      "railway init --name cairn --json",
      "railway list --json",
      "railway link --project proj-1 --environment production",
      "railway service list --json",
      "railway add --image ghcr.io/zilet/cairn:latest --service cairn --variables CAIRN_SINGLE_VOLUME=1 --variables CAIRN_REQUIRE_AUTH=1 --variables CAIRN_BLANK_PROFILE=1 --variables CAIRN_PLATFORM=railway --variables CAIRN_MAX_AGENT_PROCS=1 --variables PORT=8787 --json",
      "railway service link cairn",
      "railway volume list --json",
      "railway volume add --mount-path /data --json",
      "railway variable list --service cairn --environment production --kv",
      "railway variable set CAIRN_AUTH_TOKEN --stdin --service cairn --environment production --skip-deploys",
      "railway variable set CAIRN_SETTINGS_SECRET_KEY --stdin --service cairn --environment production --skip-deploys",
      "railway domain list --service cairn",
      "railway domain --port 8787 --service cairn",
      "railway deployment list --service cairn",
      "railway redeploy --service cairn --environment production --from-source --yes --json",
      "railway deployment list --service cairn",
    ]);
    assert.equal(fs.existsSync(path.join(rig.state, "secret_in_argv")), false, "a secret reached railway's argv");
    assert.equal(fs.existsSync(path.join(rig.state, "stdin_not_closed")), false, "railway got a readable stdin");
    assert.deepEqual(
      [...new Set(rig.read("rcwd").trim().split("\n"))],
      [rig.stateDir],
      "every railway call runs in the state dir"
    );

    const { token, key } = rig.secrets();
    assert.ok(token && key && token !== key, rig.read("vars"));
    assert.doesNotMatch(r.all, new RegExp(token), "a non-terminal run never prints the token");
    assert.doesNotMatch(r.all, new RegExp(key));
    assert.match(r.out, /not printed: this output is not a terminal/);
    assert.match(r.out, /Deployment: BUILDING/);
    assert.match(r.out, /Cairn is running on Railway \(v2\.1\.0\)/);
    assert.match(r.out, /Auto Updates/);

    // Signed in: a one-time code over stdin, opened as <origin>/#pair=<code>.
    const url = "https://cairn-production-a1b2.up.railway.app/#pair=ABCD-EF12";
    assert.equal(rig.read("opened").trim(), url);
    assert.ok(r.out.includes(url));
    assert.match(r.out, /Pair your phone: Settings -> Devices -> Pair a device/);
    assert.ok(rig.read("curl_config").includes(token), "the token reaches curl on stdin");
    assert.doesNotMatch(rig.read("clog"), new RegExp(token), "the token never sits in curl's argv");

    // Local state: no secrets, private, and a working cairn.sh beside it.
    const st = fs.readFileSync(path.join(rig.stateDir, "railway.state"), "utf8");
    assert.match(st, /^RW_PROJECT_ID=proj-1$/m);
    assert.match(st, /^RW_SERVICE=cairn$/m);
    assert.match(st, /^RW_DOMAIN=cairn-production-a1b2\.up\.railway\.app$/m);
    assert.doesNotMatch(st, /[0-9a-f]{64}/);
    assert.equal(fs.statSync(path.join(rig.stateDir, "railway.state")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(rig.stateDir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(rig.stateDir, "cairn.sh"), "utf8"), fs.readFileSync(script, "utf8"));

    // Re-running reuses everything and never regenerates the token or the key.
    const before = rig.read("rlog").split("\n").length;
    const again = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(again.code, 0, again.all);
    const second = rig
      .read("rlog")
      .trim()
      .split("\n")
      .slice(before - 1)
      .filter((line) => !line.endsWith(" --help"));
    for (const never of [
      "railway init",
      "railway add",
      "railway volume add",
      "railway variable set",
      "railway domain --port",
    ]) {
      assert.ok(!second.some((line) => line.startsWith(never)), `re-run should not run "${never}"`);
    }
    assert.deepEqual(rig.secrets(), { token, key });
    assert.equal(rig.read("vars").match(/^CAIRN_AUTH_TOKEN=/gm).length, 1);

    // cairn.sh dispatches to Railway on its own.
    const status = rig.cairnSh(["status"]);
    assert.equal(status.code, 0, status.all);
    assert.match(status.out, /Deployment: SUCCESS \(dep-\d+\)/);
    assert.match(status.out, /healthy, v2\.1\.0/);
    assert.doesNotMatch(status.all, new RegExp(token));

    const open = rig.cairnSh(["open"]);
    assert.equal(open.code, 0, open.all);
    assert.equal(rig.read("opened").trim().split("\n").length, 3, "install, re-run and open each signed a browser in");
    assert.doesNotMatch(open.all, new RegExp(token));

    const deploysBefore = (rig.read("rlog").match(/^railway redeploy .*--from-source/gm) || []).length;
    const update = rig.cairnSh(["update"]);
    assert.equal(update.code, 0, update.all);
    assert.equal((rig.read("rlog").match(/^railway redeploy .*--from-source/gm) || []).length, deploysBefore + 1);
    assert.match(update.out, /is running at https:\/\/cairn-production-a1b2\.up\.railway\.app/);

    const logs = rig.cairnSh(["logs"]);
    assert.equal(logs.code, 0, logs.all);
    assert.match(logs.out, /Starting Container/);
    assert.doesNotMatch(logs.all, new RegExp(token), "logs drop lines carrying the token");

    // Uninstall deletes the project only with the typed name.
    const refuse = rig.cairnSh(["uninstall", "--yes"]);
    assert.notEqual(refuse.code, 0);
    assert.match(refuse.err, /--confirm-purge=cairn/);
    assert.equal(fs.existsSync(path.join(rig.state, "deleted")), false);
    const del = rig.cairnSh(["uninstall", "--confirm-purge=cairn"]);
    assert.equal(del.code, 0, del.all);
    assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m);
    assert.equal(fs.existsSync(rig.stateDir), false);
    assert.equal(fs.existsSync(path.join(rig.state, "secret_in_argv")), false);
  }));

test("fake railway: a failed deployment shows the last log lines without the token", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "statuses"), "BUILDING\nFAILED\n");
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.notEqual(r.code, 0);
    const { token } = rig.secrets();
    assert.ok(token);
    assert.match(r.err, /deployment FAILED/);
    assert.match(r.err, /EADDRINUSE \(fake failure\)/);
    assert.match(rig.read("rlog"), /^railway logs --service cairn --environment production --build --lines 30 dep-2$/m);
    assert.doesNotMatch(r.all, new RegExp(token), "the token is filtered out of the printed logs");
    assert.equal(fs.existsSync(path.join(rig.state, "opened")), false);
  }));

test("fake railway: an image without pairing codes (404) falls back to the access token", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "pair_404"), "");
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.existsSync(path.join(rig.state, "opened")), false, "nothing to open without a code");
    assert.match(r.out, /Open: https:\/\/cairn-production-a1b2\.up\.railway\.app/);
    assert.match(r.out, /no one-time sign-in link yet/);
    assert.match(r.out, /Sign in with your access token: \(not printed: this output is not a terminal\)/);
    // The terminal decision is made once, outside $(...): a forced terminal prints the token.
    const tty = run(["--target=railway", "--yes"], { env: { ...rig.env, CAIRN_INSTALL_FORCE_TTY: "1" } });
    assert.equal(tty.code, 0, tty.all);
    assert.match(tty.out, new RegExp(`Sign in with your access token: ${rig.secrets().token}`));
    assert.match(r.out, /Railway \(project cairn -> service cairn -> Variables -> CAIRN_AUTH_TOKEN\)/);
    assert.match(r.out, /The access token shown above/);
    assert.doesNotMatch(r.all, new RegExp(rig.secrets().token));
  }));

test("fake railway: not signed in and no terminal stops with the login hint", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "logged_out"), "");
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /railway login/);
    assert.doesNotMatch(rig.read("rlog"), /^railway (init|add)/m);
  }));

// --yes answers prompts but is never consent to run a downloaded third-party install script
// (get.docker.com, railway.com/install.sh). Only --install-docker / --install-railway-cli, or an
// interactive yes, is. The rig fakes curl so the "downloaded script" only drops a marker file.
function scriptConsentRig(dir, { railway = false } = {}) {
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  const installBody = railway
    ? '#!/bin/sh\ntouch "$FAKE_STATE/ran"\nmkdir -p "$HOME/.railway/bin"\nprintf "#!/bin/sh\\nexit 1\\n" >"$HOME/.railway/bin/railway"\nchmod +x "$HOME/.railway/bin/railway"\n'
    : '#!/bin/sh\ntouch "$FAKE_STATE/ran"\n';
  fs.writeFileSync(path.join(state, "installbody"), installBody);
  const files = {
    curl: `#!/bin/sh
echo "curl $*" >>"$FAKE_STATE/clog"
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
cat "$FAKE_STATE/installbody" >"$out"
`,
    // Never really escalate or touch the host: run only the downloaded script.
    sudo: '#!/bin/sh\nif [ "$1" = "sh" ]; then exec "$@"; fi\nexit 0\n',
    usermod: "#!/bin/sh\nexit 0\n",
    npm: "#!/bin/sh\nexit 1\n",
    sleep: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(bin, name), body);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: dir,
    FAKE_STATE: state,
    TMPDIR: dir,
    CAIRN_CONTAINER_TOOL: "no-such-engine",
  };
  return { env, ran: () => fs.existsSync(path.join(state, "ran")) };
}

test("docker: --yes alone prints the command and never runs get.docker.com; --install-docker does", () =>
  withTempDir((dir) => {
    const rig = scriptConsentRig(dir);
    const base = ["--target=local", `--dir=${dir}/c`, "--no-updater", "--yes"];
    const refused = run(base, { env: rig.env });
    assert.notEqual(refused.code, 0, refused.all);
    assert.match(refused.all, /curl -fsSL https:\/\/get\.docker\.com \| sh/);
    assert.match(refused.all, /--install-docker/);
    assert.equal(rig.ran(), false, "the Docker install script must not run on --yes alone");

    const allowed = run([...base, "--install-docker"], { env: rig.env });
    assert.equal(rig.ran(), true, allowed.all);
    assert.match(allowed.all, /Running Docker's install script/);
  }));

test("railway CLI: --yes alone prints the command and never runs railway.com/install.sh; --install-railway-cli does", () =>
  withTempDir((dir) => {
    const rig = scriptConsentRig(dir, { railway: true });
    // The installer appends the usual Homebrew/system dirs to PATH, which would find a real
    // `railway` on a dev machine; run a copy without that line so the CLI is truly absent.
    const copy = path.join(dir, "install-copy.sh");
    const text = fs.readFileSync(script, "utf8");
    const patched = text.replace(/^PATH="\$\{PATH:-\/usr\/bin:\/bin\}:[^\n]*\n/m, "");
    assert.notEqual(patched, text, "PATH line to strip not found");
    fs.writeFileSync(copy, patched);
    const go = (extra) => {
      const res = spawnSync(SH, [copy, "--target=railway", "--yes", ...extra], {
        encoding: "utf8",
        env: {
          CAIRN_NO_TTY: "1",
          CAIRN_INSTALL_OS: "Linux",
          CAIRN_INSTALL_ARCH: "x86_64",
          CAIRN_INSTALL_LONG_BIT: "64",
          ...rig.env,
        },
      });
      return { code: res.status, all: `${res.stdout}\n${res.stderr}` };
    };
    const refused = go([]);
    assert.notEqual(refused.code, 0, refused.all);
    assert.match(refused.all, /curl -fsSL https:\/\/railway\.com\/install\.sh \| sh/);
    assert.match(refused.all, /--install-railway-cli/);
    assert.equal(rig.ran(), false, "the Railway install script must not run on --yes alone");

    const allowed = go(["--install-railway-cli"]);
    assert.equal(rig.ran(), true, allowed.all);
    assert.match(allowed.all, /Installed the Railway CLI/);
  }));
