// The installer must never turn off a Tailscale Serve mapping it did not create.
//
// Regression (2026-10-17): a plain `npm test` on a Pi that already served Cairn over HTTPS
// (https://<host>/ -> 127.0.0.1:8787, set by hand) ran the installer's uninstall tests with the
// machine's REAL `tailscale` on PATH; uninstall called `teardown_tailscale`, which sees "Serve
// points at 127.0.0.1:8787" and ran `tailscale serve --https=443 off`. Production HTTPS vanished
// every time the suite ran. Two guards: uninstall only tears down what THIS instance's .env says it
// set up (CAIRN_EXPOSURE=tailscale), and every installer spawn in the suite gets a stand-in
// `tailscale` first on PATH (test/_installer.mjs hermetic()).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { run, withTempDir, hermetic, FAKE_TAILSCALE } from "./_installer.mjs";

const serveOff = (log) =>
  fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => /^serve\b/.test(l) && /\boff\b|\breset\b/.test(l));

// A machine whose Serve already points at 8787, as the Pi does. PATH carries a recording fake.
function ownerServesHandRolled(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "tailscale"), FAKE_TAILSCALE, { mode: 0o755 });
  const log = path.join(dir, "ts.log");
  fs.writeFileSync(log, "");
  return { env: { PATH: `${bin}:${process.env.PATH}`, CAIRN_TEST_TS_LOG: log, CAIRN_TEST_TS_SERVES: "8787" }, log };
}

test("uninstalling an instance that never used Tailscale exposure leaves a hand-made Serve mapping alone", () =>
  withTempDir((dir) => {
    const target = path.join(dir, "cairn");
    const { env, log } = ownerServesHandRolled(dir);
    assert.equal(run(["--no-start", "--yes", `--dir=${target}`, "--no-updater"], { env }).code, 0);
    assert.match(fs.readFileSync(path.join(target, ".env"), "utf8"), /^CAIRN_EXPOSURE=local$/m);
    const r = run(["uninstall", "--purge", "--yes", "--confirm-purge=cairn", `--dir=${target}`], { env });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(serveOff(log), [], "uninstall switched off a Serve mapping this install never made");
  }));

test("uninstalling an instance the installer exposed over Tailscale still turns its Serve off", () =>
  withTempDir((dir) => {
    const target = path.join(dir, "cairn");
    const { env, log } = ownerServesHandRolled(dir);
    const install = run(["--no-start", "--yes", `--dir=${target}`, "--no-updater", "--https=tailscale"], { env });
    assert.equal(install.code, 0, install.all);
    assert.match(fs.readFileSync(path.join(target, ".env"), "utf8"), /^CAIRN_EXPOSURE=tailscale$/m);
    const r = run(["uninstall", "--purge", "--yes", "--confirm-purge=cairn", `--dir=${target}`], { env });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(serveOff(log), ["serve --https=443 off"]);
  }));

test("every installer spawn is hermetic: the real tailscale is never first on PATH", () => {
  const env = hermetic({ PATH: "/usr/bin:/bin" });
  const first = env.PATH.split(":")[0];
  assert.ok(fs.existsSync(path.join(first, "tailscale")), "a stand-in tailscale leads PATH");
  assert.equal(fs.readFileSync(path.join(first, "tailscale"), "utf8"), FAKE_TAILSCALE);
  // Without a scenario the stand-in behaves like a CI box that has Tailscale installed but not connected.
  const r = run(["--dry-run", `--dir=${path.join(first, "x")}`, "--no-updater", "--https=tailscale"]);
  assert.equal(r.code, 0, r.all);
});

// The incident's other half: a purge uninstall with a real engine on PATH ran `compose down --volumes`
// for the project "cairn" and destroyed a live stack's container and data volumes. No installer test
// may reach a real engine: a stand-in refuses everything except a fake living under the temp dir.
test("a real container engine on PATH is refused; a fake under the temp dir still works", () =>
  withTempDir((dir) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho fake-engine\n", { mode: 0o755 });
    const probe = (envPath) =>
      spawnSync("sh", ["-c", "docker info"], { encoding: "utf8", env: hermetic({ PATH: envPath }) });
    // /usr/bin and /bin may hold a real docker (it does on a Docker host): refused, nothing runs.
    const refused = probe("/usr/bin:/bin");
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /refused: the installer tests never touch a real container engine/);
    // A fake the test itself wrote under the temp dir is honored.
    const fake = probe(`${bin}:/usr/bin:/bin`);
    assert.equal(fake.status, 0, fake.stderr);
    assert.equal(fake.stdout.trim(), "fake-engine");
  }));
