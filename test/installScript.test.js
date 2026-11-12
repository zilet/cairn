// The one-line installer (deploy/install.sh) is POSIX sh that runs as `curl | sh` on
// machines we never see, so it is checked here without a container engine: syntax,
// shellcheck when present, and its pure planning via --dry-run / --no-start (which
// print or write the compose file, .env and updater units and never touch Docker).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { root, script, SH, withTempDir, run, execAsync, section, envKeys } from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScript", { concurrency: true }, () => {
  test("installer parses as POSIX sh and stays shellcheck-clean when shellcheck exists", async (t) => {
    const syntax = await execAsync(SH, ["-n", script]);
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(fs.statSync(script).mode & 0o111, 0o111, "deploy/install.sh must be executable");
    const head = fs.readFileSync(script, "utf8");
    assert.match(head, /^#!\/bin\/sh\n/);
    // A truncated `curl | sh` download must run nothing: main is the very last line.
    assert.match(head, /\nmain "\$@"\n$/);
    const probe = await execAsync("shellcheck", ["--version"], { env: process.env }).catch(() => null);
    if (!probe || probe.status !== 0) {
      t.skip("shellcheck not installed");
      return;
    }
    const sc = await execAsync("shellcheck", ["-s", "sh", script], { env: process.env });
    assert.equal(sc.status, 0, sc.stdout + sc.stderr);
  });

  test("default dry run: loopback, a required token, the app's updater contract, nothing printed secret", () =>
    withTempDir(async (dir) => {
      const r = await run(["--dry-run", `--dir=${dir}/cairn`, "--updater=systemd"]);
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
    withTempDir(async (dir) => {
      const r = await run(["--dry-run", `--dir=${dir}/c`, "--no-updater"], { viaStdin: true });
      assert.equal(r.code, 0, r.all);
      assert.match(r.out, /Dry run: nothing was changed/);
    }));

  test("--https=caddy needs a domain, adds Caddy on 80/443 and keeps the app port on loopback", () =>
    withTempDir(async (dir) => {
      const missing = await run(["--dry-run", `--dir=${dir}/c`, "--https=caddy"]);
      assert.notEqual(missing.code, 0);
      assert.match(missing.err, /--domain/);

      const r = await run([
        "--dry-run",
        `--dir=${dir}/c`,
        "--https=caddy",
        "--domain=cairn.example.com",
        "--no-updater",
      ]);
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
    withTempDir(async (dir) => {
      const r = await run(["--dry-run", `--dir=${dir}/c`, "--lan", "--no-updater"]);
      assert.equal(r.code, 0, r.all);
      const env = section(r.out, `${dir}/c/.env`);
      assert.match(env, /^CAIRN_BIND_HOST=0\.0\.0\.0$/m);
      assert.match(env, /^CAIRN_REQUIRE_AUTH=1$/m);
      const both = await run(["--dry-run", `--dir=${dir}/c`, "--lan", "--https=tailscale"]);
      assert.notEqual(both.code, 0);
    }));

  test("refuses 32-bit systems and unsupported operating systems with a clear reason", async () => {
    const envs = [
      { CAIRN_INSTALL_ARCH: "armv7l" },
      { CAIRN_INSTALL_ARCH: "i686" },
      { CAIRN_INSTALL_ARCH: "aarch64", CAIRN_INSTALL_LONG_BIT: "32" },
    ];
    // Independent runs: start them all, then assert in order.
    const [bsd, arm64, ...refused] = await Promise.all([
      run(["--dry-run"], { env: { CAIRN_INSTALL_OS: "FreeBSD" } }),
      run(["--dry-run", "--no-updater", "--dir=/tmp/cairn-arm64-plan"], { env: { CAIRN_INSTALL_ARCH: "aarch64" } }),
      ...envs.map((env) => run(["--dry-run", "--no-updater"], { env })),
    ]);
    refused.forEach((r, i) => {
      assert.notEqual(r.code, 0, JSON.stringify(envs[i]));
      assert.match(r.err, /64-bit/);
    });
    assert.notEqual(bsd.code, 0);
    assert.match(bsd.err, /Unsupported OS/);
    assert.equal(arm64.code, 0, arm64.all);
  });

  test("rejects unsafe or malformed option values", async () => {
    const cases = [
      ["--port=99999"],
      ["--port=80a"],
      ["--https=caddy", "--domain=not a domain"],
      ["--https=funnel"],
      ["--name=Bad Name"],
      ["--dir=/tmp/has space/cairn"],
      ["--tz=Europe/Berlin;rm"],
      ["--bogus"],
    ];
    const results = await Promise.all(cases.map((args) => run(["--dry-run", "--no-updater", ...args])));
    results.forEach((r, i) => assert.notEqual(r.code, 0, `should reject ${cases[i].join(" ")}`));
  });

  test("cron and launchd updater plans carry both schedules", () =>
    withTempDir(async (dir) => {
      const cron = await run(["--dry-run", `--dir=${dir}/c`, "--updater=cron"]);
      assert.equal(cron.code, 0, cron.all);
      const lines = section(cron.out, "crontab entries").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^\d{1,2} [34] \* \* \* \/bin\/sh .*cairn\.sh update --nightly .*# cairn-updater:cairn$/);
      assert.match(lines[1], /^\*\/5 \* \* \* \* \/bin\/sh .*cairn\.sh update --if-requested .*# cairn-updater:cairn$/);

      const mac = await run(["--dry-run", `--dir=${dir}/c`], {
        env: { CAIRN_INSTALL_OS: "Darwin", CAIRN_INSTALL_ARCH: "arm64" },
      });
      assert.equal(mac.code, 0, mac.all);
      const check = section(mac.out, "$HOME/Library/LaunchAgents/local.cairn.cairn.update-check.plist");
      assert.match(check, /<key>StartInterval<\/key><integer>300<\/integer>/);
      const nightly = section(mac.out, "$HOME/Library/LaunchAgents/local.cairn.cairn.update.plist");
      assert.match(nightly, /<key>Hour<\/key><integer>[34]<\/integer>/);
    }));

  test("the installer's compose passes through every setting the release compose does", () =>
    withTempDir(async (dir) => {
      const release = fs.readFileSync(path.join(root, "deploy", "docker-compose.release.yml"), "utf8");
      const r = await run(["--dry-run", `--dir=${dir}/c`, "--no-updater"]);
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
    withTempDir(async (dir) => {
      const target = path.join(dir, "cairn");
      const refuse = await run(["--no-start", `--dir=${target}`, "--no-updater"]);
      assert.notEqual(refuse.code, 0, "no terminal and no --yes must not install");
      assert.match(refuse.err, /--yes/);
      assert.equal(fs.existsSync(path.join(target, ".env")), false);

      const first = await run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"]);
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
      const fresh = await run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"], { env: fakeTool(1) });
      assert.equal(fresh.code, 0, fresh.all);
      assert.match(fs.readFileSync(envPath, "utf8"), /^CAIRN_BLANK_PROFILE=1$/m, "no data volume yet: blank");
      fs.writeFileSync(envPath, fs.readFileSync(envPath, "utf8").replace(/^CAIRN_BLANK_PROFILE=1\n/m, ""));
      // The volume exists: an install that already has data is not flipped.
      const second = await run(["--no-start", "--yes", `--dir=${target}`, "--lan", "--port=8790", "--no-updater"], {
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
      // (Both dry runs write nothing: start them together.)
      const [third, clash] = await Promise.all([
        run(["--dry-run", `--dir=${target}`, "--no-updater"]),
        run(["--dry-run", `--dir=${target}`, "--name=other", "--no-updater"]),
      ]);
      assert.equal(third.code, 0, third.all);
      assert.match(third.out, /^CAIRN_BIND_HOST=0\.0\.0\.0$/m);
      assert.match(third.out, /^CAIRN_AUTH_TOKEN=<kept/m);
      assert.match(third.out, /^GEMINI_API_KEY=<kept>$/m);
      assert.doesNotMatch(third.all, /user-art-key|[0-9a-f]{64}/);

      // Another instance name cannot silently take over this directory's volumes.
      assert.notEqual(clash.code, 0);
      assert.match(clash.err, /already holds the Cairn instance 'cairn'/);
    }));

  test("purge needs an explicit confirmation even with --yes", () =>
    withTempDir(async (dir) => {
      const target = path.join(dir, "cairn");
      assert.equal((await run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"])).code, 0);
      // Refusals and a dry run change nothing: start the three together.
      const [r, wrong, plan] = await Promise.all([
        run(["uninstall", "--purge", "--yes", `--dir=${target}`]),
        run(["uninstall", "--purge", "--yes", "--confirm-purge=nope", `--dir=${target}`]),
        run(["uninstall", "--dry-run", `--dir=${target}`]),
      ]);
      assert.notEqual(r.code, 0);
      assert.match(r.err, /--confirm-purge=cairn/);
      assert.notEqual(wrong.code, 0);
      assert.equal(plan.code, 0, plan.all);
      assert.match(plan.out, /keep the data volumes/);
      assert.ok(fs.existsSync(path.join(target, ".env")), "nothing was removed");
    }));

  test("a fetched self-copy must come over https", () =>
    withTempDir(async (dir) => {
      const r = await run(["--no-start", "--yes", `--dir=${dir}/c`, "--no-updater"], {
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

  test("with no --target and no terminal it explains the one choice and exits non-zero", () =>
    withTempDir(async (dir) => {
      const argSets = [[], ["--yes"], ["--dry-run"]];
      const runs = await Promise.all(argSets.map((args) => run(args, { env: { HOME: dir } })));
      for (const [i, args] of argSets.entries()) {
        const r = runs[i];
        assert.notEqual(r.code, 0, args.join(" "));
        assert.match(r.err, /Where should Cairn live\?/);
        assert.match(r.err, /1\) In the cloud on Railway/);
        assert.match(r.err, /2\) On this computer or server/);
        assert.match(r.err, /sh -s -- --target=railway --yes/);
        assert.match(r.err, /sh -s -- --target=local --yes/);
      }
      // This-machine flags imply the local target, as before.
      const local = await run(["--dry-run", `--dir=${dir}/c`, "--no-updater"], { env: { HOME: dir } });
      assert.equal(local.code, 0, local.all);
      // And they do not mix with Railway.
      const mixed = await run(["--target=railway", "--dry-run", "--lan"], { env: { HOME: dir } });
      assert.notEqual(mixed.code, 0);
      assert.match(mixed.err, /does not take this-machine options/);
      const bad = await run(["--target=heroku"], { env: { HOME: dir } });
      assert.notEqual(bad.code, 0);
    }));

  test("hosting providers come from one table: each has a <target>_main and, if remote, a deploy/<target>/", () =>
    withTempDir(async (dir) => {
      const text = fs.readFileSync(script, "utf8");
      const table = /^PROVIDERS="([^"]*)"$/m.exec(text);
      assert.ok(table, "install.sh has no PROVIDERS table");
      const targets = table[1].split("\n").map((line) => line.split("|")[0]);
      assert.deepEqual(targets, ["railway", "local"]);
      for (const t of targets) {
        assert.match(text, new RegExp(`^${t}_main\\(\\) \\{$`, "m"), `${t}_main is missing`);
        if (t !== "local")
          assert.ok(fs.statSync(path.join(root, "deploy", t)).isDirectory(), `deploy/${t}/ is missing`);
      }
      const bad = await run(["--target=heroku"], { env: { HOME: dir } });
      assert.notEqual(bad.code, 0);
      assert.match(bad.err, /--target must be one of: railway local/);
    }));

  test("--target=railway --dry-run prints the plan and the CLI sequence, no secrets", () =>
    withTempDir(async (dir) => {
      const r = await run(["--target=railway", "--dry-run", "--railway-project-name=my-cairn"], { env: { HOME: dir } });
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
});
