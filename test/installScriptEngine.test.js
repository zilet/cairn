// The installer end to end against a stand-in container engine (fake docker + curl):
// install, update, roll back, hold back, the Update-now trigger, uninstall, and the
// one-time pairing link a local install ends on. Split from installScript.test.js so
// the two longest scenarios run beside the plan checks. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { SH, withTempDir, run, execAsync, hermetic, FAKE_DOCKER, FAKE_CURL, installFakes } from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptEngine", { concurrency: true }, () => {
  test("fake engine: install, update, roll back, hold back, Update-now trigger, uninstall", () =>
    withTempDir(async (dir) => {
      const bin = path.join(dir, "bin");
      const state = path.join(dir, "state");
      const target = path.join(dir, "cairn");
      fs.mkdirSync(bin);
      fs.mkdirSync(state);
      installFakes(bin, [
        ["docker", FAKE_DOCKER],
        ["curl", FAKE_CURL],
        ["sleep", "#!/bin/sh\nexit 0\n"],
      ]);
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
      const cairnSh = async (args) => {
        const res = await execAsync(SH, [path.join(target, "cairn.sh"), ...args], {
          env: hermetic({
            ...env,
            CAIRN_NO_TTY: "1",
            TZ: "UTC",
            CAIRN_INSTALL_OS: "Linux",
            CAIRN_INSTALL_ARCH: "x86_64",
            CAIRN_INSTALL_LONG_BIT: "64",
          }),
        });
        return { code: res.status, all: `${res.stdout}\n${res.stderr}` };
      };

      remote(ids.a, "2.0.0");
      const install = await run(["--yes", `--dir=${target}`, "--no-updater"], { env });
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
      let r = await cairnSh(["update"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(status().last_result, "current");

      // A healthy new release: snapshot first, then switch, keep the old one for rollback.
      remote(ids.b, "2.0.1");
      r = await cairnSh(["update"]);
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
      r = await cairnSh(["update"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(running(), ids.b);
      assert.equal(status().last_result, "rolled_back");
      r = await cairnSh(["update"]);
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
      r = await cairnSh(["update", "--if-requested"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(running(), ids.b);
      assert.ok(status().last_check);
      fs.writeFileSync(path.join(state, "trigger"), '{"requested_at":"2026-01-01T00:00:00Z"}');
      r = await cairnSh(["update", "--if-requested"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(running(), ids.d);
      assert.equal(status().last_result, "updated");
      assert.equal(status().trigger, "requested");
      assert.equal(fs.existsSync(path.join(state, "trigger")), false, "the trigger file is consumed");

      // A pull failure is reported, not hidden.
      fs.writeFileSync(path.join(state, "pull_fails"), "");
      r = await cairnSh(["update", "--nightly"]);
      assert.notEqual(r.code, 0);
      assert.equal(status().last_result, "failed");
      fs.rmSync(path.join(state, "pull_fails"));

      r = await cairnSh(["status"]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.all, /running, healthy, v2\.0\.2/);
      assert.doesNotMatch(r.all, new RegExp(token));

      // A container someone stopped on purpose is not revived by the nightly timer.
      fs.rmSync(path.join(state, "running"));
      remote("e".repeat(12), "2.0.3");
      r = await cairnSh(["update", "--nightly"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(fs.existsSync(path.join(state, "running")), false);
      const hostStatus = JSON.parse(fs.readFileSync(path.join(target, "updater-status.json"), "utf8"));
      assert.equal(hostStatus.last_result, "current");
      assert.match(hostStatus.detail, /stopped/);

      r = await cairnSh(["uninstall", "--yes"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(fs.existsSync(path.join(state, "running")), false);
      assert.equal(fs.existsSync(path.join(state, "volumes_removed")), false, "data volumes are kept");
      assert.equal(fs.existsSync(path.join(target, "docker-compose.yml")), false);
      assert.ok(fs.existsSync(path.join(target, ".env")), ".env (token + settings key) is kept");

      // The purge the uninstall message points to still works with only .env left.
      const purge = await run(["uninstall", "--purge", "--yes", "--confirm-purge=cairn", `--dir=${target}`], { env });
      assert.equal(purge.code, 0, purge.all);
      assert.ok(fs.existsSync(path.join(state, "volumes_removed")), "purge removes the data volumes");
      assert.equal(fs.existsSync(target), false);
    }));

  test("fake engine: a local install ends signed in through a one-time pairing link", () =>
    withTempDir(async (dir) => {
      const bin = path.join(dir, "bin");
      const state = path.join(dir, "state");
      const target = path.join(dir, "cairn");
      fs.mkdirSync(bin);
      fs.mkdirSync(state);
      installFakes(bin, [
        ["docker", FAKE_DOCKER],
        ["curl", FAKE_CURL],
        ["sleep", "#!/bin/sh\nexit 0\n"],
        ["xdg-open", '#!/bin/sh\necho "$1" >>"$FAKE_STATE/opened"\n'],
      ]);
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
      const r = await run(["--target=local", "--yes", `--dir=${target}`, "--no-updater"], { env });
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
      const open = await execAsync(SH, [path.join(target, "cairn.sh"), "open"], {
        env: hermetic({
          ...env,
          CAIRN_NO_TTY: "1",
          CAIRN_INSTALL_OS: "Linux",
          CAIRN_INSTALL_ARCH: "x86_64",
          CAIRN_INSTALL_LONG_BIT: "64",
        }),
      });
      assert.equal(open.status, 0, open.stdout + open.stderr);
      assert.equal(fs.readFileSync(path.join(state, "opened"), "utf8").trim().split("\n").length, 2);
    }));

  // ----------------------------------------------------------------------------- Railway
});
