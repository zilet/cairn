// Re-running the installer's Railway target: auto updates, and a recorded project that
// is gone, renamed, taken or still deleting. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { withTempDir, run, railwayRig } from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptRailwayRecorded", { concurrency: true }, () => {
  test("fake railway: auto updates are switched on once, never over a setting that exists or that you turned off", () =>
    withTempDir(async (dir) => {
      // Already configured in Railway (e.g. a minor-version policy): kept, nothing patched.
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "au_type"), "minor");
      const kept = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(kept.code, 0, kept.all);
      assert.doesNotMatch(rig.read("rlog"), /^railway api mutation/m);
      assert.match(kept.out, /Automatic updates: on \(minor, as set in Railway\)/);
      assert.match(fs.readFileSync(path.join(rig.stateDir, "railway.state"), "utf8"), /^RW_AUTOUPDATES_SET=$/m);

      // Switched on by the installer, then turned off by the person: a re-run leaves it off.
      fs.rmSync(path.join(rig.state, "au_type"));
      const on = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(on.code, 0, on.all);
      assert.equal(rig.read("au_type").trim(), "patch");
      fs.writeFileSync(path.join(rig.state, "au_type"), "disabled");
      const apis = (rig.read("rlog").match(/^railway api mutation/gm) || []).length;
      const off = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(off.code, 0, off.all);
      assert.equal(
        (rig.read("rlog").match(/^railway api mutation/gm) || []).length,
        apis,
        "no patch over the person's choice"
      );
      assert.match(off.out, /Automatic updates: off in Railway, as you set them/);
      assert.match(off.out, /Automatic updates are off in Railway, as you set them/);
    }));

  test("fake railway: a refused auto-update patch never fails the install; it says how by hand", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "fail_api_mutation"), "");
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(r.code, 0, r.all);
      assert.match(r.err, /Railway did not accept the automatic-update setting \(Error: Not Authorized \(fake\)\)/);
      assert.match(
        r.out,
        /Turn on automatic updates once in Railway: service cairn -> Settings -> Source -> Auto Updates/
      );
      assert.match(fs.readFileSync(path.join(rig.stateDir, "railway.state"), "utf8"), /^RW_AUTOUPDATES_SET=$/m);
      assert.match(r.out, /Cairn is running on Railway/);
    }));

  test("fake railway: a recorded project that is gone starts over on the release image, not the old one", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.mkdirSync(rig.stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(rig.stateDir, "railway.state"),
        "RW_PROJECT_ID=proj-old\nRW_PROJECT_NAME=cairn\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\nRW_IMAGE=ghcr.io/zilet/cairn:edge\n"
      );
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(r.code, 0, r.all);
      assert.match(r.all, /is gone; creating a new one/);
      assert.match(
        r.all,
        /Using ghcr\.io\/zilet\/cairn:latest \(the recorded ghcr\.io\/zilet\/cairn:edge went with the old project/
      );
      assert.match(rig.read("rlog"), /railway add --image ghcr\.io\/zilet\/cairn:latest /);
    }));
});
