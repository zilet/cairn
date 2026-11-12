// The installer's Railway target against a fake Railway CLI: an end-to-end install,
// failure paths, and the consent rules for third-party install scripts. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  script,
  SH,
  withTempDir,
  run,
  execAsync,
  railwayRig,
  assertSequence,
  scriptConsentRig,
  autoUpdatesSpec,
  hermetic,
} from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptRailway", { concurrency: true }, () => {
  test("fake railway: --target=railway installs end to end, secrets only on stdin, signs in with #pair=", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(r.code, 0, r.all);

      const log = rig.read("rlog").trim().split("\n");
      assertSequence(log, [
        "railway whoami",
        "railway list --json",
        "railway init --name cairn --json",
        "railway list --json",
        "railway link --project proj-1 --environment production",
        "railway service list --json",
        "railway add --image ghcr.io/zilet/cairn:latest --service cairn --variables CAIRN_SINGLE_VOLUME=1 --variables CAIRN_REQUIRE_AUTH=1 --variables CAIRN_BLANK_PROFILE=1 --variables CAIRN_PLATFORM=railway --variables CAIRN_MAX_AGENT_PROCS=1 --variables PORT=8787 --variables CAIRN_FEEDBACK_URL=https://feedback.cairn.fit --json",
        "railway service link cairn",
        "railway volume list --json",
        "railway volume add --mount-path /data --json",
        "railway variable list --service cairn --environment production --kv",
        "railway variable set CAIRN_AUTH_TOKEN --stdin --service cairn --environment production --skip-deploys",
        "railway variable set CAIRN_SETTINGS_SECRET_KEY --stdin --service cairn --environment production --skip-deploys",
        "railway service list --json",
        "railway environment list --json",
        "railway environment config --environment production --json",
        "railway api mutation(",
        "railway environment config --environment production --json",
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
      // Image auto updates: switched on with the template's window, read back, remembered.
      const au = JSON.parse(rig.read("patch.json"));
      assert.deepEqual(au, {
        env: "env-1",
        patch: { services: { "svc-1": { source: { autoUpdates: autoUpdatesSpec() } } } },
      });
      assert.match(r.out, /Automatic updates: on, in the Night, 02:00-06:00 UTC window/);
      assert.match(r.out, /Automatic: Railway installs each new release in the Night, 02:00-06:00 UTC window/);
      assert.doesNotMatch(r.out, /Turn on automatic updates once/);

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
      assert.match(st, /^RW_AUTOUPDATES_SET=1$/m);
      assert.match(st, /^RW_SERVICE=cairn$/m);
      assert.match(st, /^RW_DOMAIN=cairn-production-a1b2\.up\.railway\.app$/m);
      assert.doesNotMatch(st, /[0-9a-f]{64}/);
      assert.equal(fs.statSync(path.join(rig.stateDir, "railway.state")).mode & 0o777, 0o600);
      assert.equal(fs.statSync(rig.stateDir).mode & 0o777, 0o700);
      assert.equal(fs.readFileSync(path.join(rig.stateDir, "cairn.sh"), "utf8"), fs.readFileSync(script, "utf8"));

      // Re-running reuses everything and never regenerates the token or the key.
      const before = rig.read("rlog").split("\n").length;
      const again = await run(["--target=railway", "--yes"], { env: rig.env });
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
        "railway api mutation",
      ]) {
        assert.ok(!second.some((line) => line.startsWith(never)), `re-run should not run "${never}"`);
      }
      assert.deepEqual(rig.secrets(), { token, key });
      assert.equal(rig.read("vars").match(/^CAIRN_AUTH_TOKEN=/gm).length, 1);

      // cairn.sh dispatches to Railway on its own.
      const status = await rig.cairnSh(["status"]);
      assert.equal(status.code, 0, status.all);
      assert.match(status.out, /Deployment: SUCCESS \(dep-\d+\)/);
      assert.match(status.out, /healthy, v2\.1\.0/);
      assert.match(status.out, /Updates: {4}automatic \(patch, Railway Auto Updates\)/);
      assert.doesNotMatch(status.all, new RegExp(token));

      const open = await rig.cairnSh(["open"]);
      assert.equal(open.code, 0, open.all);
      assert.equal(
        rig.read("opened").trim().split("\n").length,
        3,
        "install, re-run and open each signed a browser in"
      );
      assert.doesNotMatch(open.all, new RegExp(token));

      const deploysBefore = (rig.read("rlog").match(/^railway redeploy .*--from-source/gm) || []).length;
      const update = await rig.cairnSh(["update"]);
      assert.equal(update.code, 0, update.all);
      assert.equal((rig.read("rlog").match(/^railway redeploy .*--from-source/gm) || []).length, deploysBefore + 1);
      assert.match(update.out, /is running at https:\/\/cairn-production-a1b2\.up\.railway\.app/);

      const logs = await rig.cairnSh(["logs"]);
      assert.equal(logs.code, 0, logs.all);
      assert.match(logs.out, /Starting Container/);
      assert.doesNotMatch(logs.all, new RegExp(token), "logs drop lines carrying the token");

      // Uninstall deletes the project only with the typed name.
      const refuse = await rig.cairnSh(["uninstall", "--yes"]);
      assert.notEqual(refuse.code, 0);
      assert.match(refuse.err, /--confirm-purge=cairn/);
      assert.equal(fs.existsSync(path.join(rig.state, "deleted")), false);
      const del = await rig.cairnSh(["uninstall", "--confirm-purge=cairn"]);
      assert.equal(del.code, 0, del.all);
      assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m);
      assert.equal(fs.existsSync(rig.stateDir), false);
      assert.equal(fs.existsSync(path.join(rig.state, "secret_in_argv")), false);
    }));

  test("fake railway: not signed in and no terminal stops with the login hint", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "logged_out"), "");
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.notEqual(r.code, 0);
      assert.match(r.err, /railway login/);
      assert.doesNotMatch(rig.read("rlog"), /^railway (init|add)/m);
    }));

  test("docker: --yes alone prints the command and never runs get.docker.com; --install-docker does", () =>
    withTempDir(async (dir) => {
      const rig = scriptConsentRig(dir);
      const base = ["--target=local", `--dir=${dir}/c`, "--no-updater", "--yes"];
      const refused = await run(base, { env: rig.env });
      assert.notEqual(refused.code, 0, refused.all);
      assert.match(refused.all, /curl -fsSL https:\/\/get\.docker\.com \| sh/);
      assert.match(refused.all, /--install-docker/);
      assert.equal(rig.ran(), false, "the Docker install script must not run on --yes alone");

      const allowed = await run([...base, "--install-docker"], { env: rig.env });
      assert.equal(rig.ran(), true, allowed.all);
      assert.match(allowed.all, /Running Docker's install script/);
    }));

  test("railway CLI: --yes alone prints the command and never runs railway.com/install.sh; --install-railway-cli does", () =>
    withTempDir(async (dir) => {
      const rig = scriptConsentRig(dir, { railway: true });
      // The installer appends the usual Homebrew/system dirs to PATH, which would find a real
      // `railway` on a dev machine; run a copy without that line so the CLI is truly absent.
      const copy = path.join(dir, "install-copy.sh");
      const text = fs.readFileSync(script, "utf8");
      const patched = text.replace(/^PATH="\$\{PATH:-\/usr\/bin:\/bin\}:[^\n]*\n/m, "");
      assert.notEqual(patched, text, "PATH line to strip not found");
      fs.writeFileSync(copy, patched);
      const go = async (extra) => {
        const res = await execAsync(SH, [copy, "--target=railway", "--yes", ...extra], {
          env: hermetic({
            CAIRN_NO_TTY: "1",
            CAIRN_INSTALL_OS: "Linux",
            CAIRN_INSTALL_ARCH: "x86_64",
            CAIRN_INSTALL_LONG_BIT: "64",
            CAIRN_NO_TELEMETRY: "1",
            ...rig.env,
          }),
        });
        return { code: res.status, all: `${res.stdout}\n${res.stderr}` };
      };
      const refused = await go([]);
      assert.notEqual(refused.code, 0, refused.all);
      assert.match(refused.all, /curl -fsSL https:\/\/railway\.com\/install\.sh \| sh/);
      assert.match(refused.all, /--install-railway-cli/);
      assert.equal(rig.ran(), false, "the Railway install script must not run on --yes alone");

      const allowed = await go(["--install-railway-cli"]);
      assert.equal(rig.ran(), true, allowed.all);
      assert.match(allowed.all, /Installed the Railway CLI/);
    }));
});
