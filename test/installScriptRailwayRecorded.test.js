// Re-running the installer's Railway target: auto updates, and a recorded project that
// is gone, renamed, taken or still deleting. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withTempDir, run, railwayRig, templateRig } from "./_installer.mjs";

test("fake railway: auto updates are switched on once, never over a setting that exists or that you turned off", () =>
  withTempDir((dir) => {
    // Already configured in Railway (e.g. a minor-version policy): kept, nothing patched.
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "au_type"), "minor");
    const kept = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(kept.code, 0, kept.all);
    assert.doesNotMatch(rig.read("rlog"), /^railway api mutation/m);
    assert.match(kept.out, /Automatic updates: on \(minor, as set in Railway\)/);
    assert.match(fs.readFileSync(path.join(rig.stateDir, "railway.state"), "utf8"), /^RW_AUTOUPDATES_SET=$/m);

    // Switched on by the installer, then turned off by the person: a re-run leaves it off.
    fs.rmSync(path.join(rig.state, "au_type"));
    const on = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(on.code, 0, on.all);
    assert.equal(rig.read("au_type").trim(), "patch");
    fs.writeFileSync(path.join(rig.state, "au_type"), "disabled");
    const apis = (rig.read("rlog").match(/^railway api mutation/gm) || []).length;
    const off = run(["--target=railway", "--yes"], { env: rig.env });
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
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "fail_api_mutation"), "");
    const r = run(["--target=railway", "--yes"], { env: rig.env });
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
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.mkdirSync(rig.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(rig.stateDir, "railway.state"),
      "RW_PROJECT_ID=proj-old\nRW_PROJECT_NAME=cairn\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\nRW_IMAGE=ghcr.io/zilet/cairn:edge\n"
    );
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /is gone; creating a new one/);
    assert.match(
      r.all,
      /Using ghcr\.io\/zilet\/cairn:latest \(the recorded ghcr\.io\/zilet\/cairn:edge went with the old project/
    );
    assert.match(rig.read("rlog"), /railway add --image ghcr\.io\/zilet\/cairn:latest /);
  }));

test("fake railway: --railway-project-name moves on from a recorded project only once it is gone", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    const state = path.join(rig.stateDir, "railway.state");
    fs.mkdirSync(rig.stateDir, { recursive: true });
    fs.writeFileSync(
      state,
      "RW_PROJECT_ID=proj-old\nRW_PROJECT_NAME=cairn\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\n"
    );
    const r = run(["--target=railway", "--yes", "--railway-project-name=cairn-v2"], { env: rig.env });
    assert.equal(r.code, 0, r.all);
    assert.match(rig.read("rlog"), /^railway init --name cairn-v2 --json$/m);
    assert.match(fs.readFileSync(state, "utf8"), /^RW_PROJECT_NAME=cairn-v2$/m);

    // The recorded project still exists: never swapped out from under it.
    fs.mkdirSync(path.join(dir, "b"));
    const live = railwayRig(path.join(dir, "b"));
    fs.writeFileSync(path.join(live.state, "project"), "cairn");
    fs.mkdirSync(live.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(live.stateDir, "railway.state"),
      "RW_PROJECT_ID=proj-1\nRW_PROJECT_NAME=cairn\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\n"
    );
    const l = run(["--target=railway", "--yes", "--railway-project-name=cairn-v2"], { env: live.env });
    assert.notEqual(l.code, 0, l.all);
    assert.match(l.err, /already manages the Railway project 'cairn', which still exists/);
    assert.match(l.err, /--name=cairn-v2 --railway-project-name=cairn-v2/);
    assert.doesNotMatch(live.read("rlog"), /^railway init/m);
  }));

test("fake railway: a taken project name with no terminal says how to pick another", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "existing_project"), "cairn");
    fs.writeFileSync(path.join(rig.state, "deleted_project"), "cairn");
    // Two live projects named cairn: never guessed between, and no terminal to ask for a name.
    fs.writeFileSync(path.join(rig.state, "project"), "cairn");
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.notEqual(r.code, 0, r.all);
    assert.match(r.err, /You have 2 Railway projects named 'cairn'/);
    assert.match(r.err, /sh -s -- --target=railway --yes --railway-project-name=cairn-2$/m);
    assert.doesNotMatch(rig.read("rlog"), /^railway init/m);
  }));

test("fake railway: a project Railway is still deleting (deletedAt) is never reused or counted", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    fs.writeFileSync(path.join(rig.state, "deleted_project"), "cairn");
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(r.code, 0, r.all);
    assert.match(rig.read("rlog"), /^railway init --name cairn --json$/m, "a new project, not the deleted one");
    assert.doesNotMatch(rig.read("rlog"), /proj-gone/);
    assert.doesNotMatch(r.all, /already exists/);

    // The template build's before/after diff ignores it too.
    fs.mkdirSync(path.join(dir, "t"));
    const trig = templateRig(path.join(dir, "t"));
    fs.writeFileSync(path.join(trig.state, "deleted_project"), "Cairn");
    const t = trig.go(["--yes"]);
    assert.equal(t.code, 0, t.all);
    assert.match(trig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m);
    assert.doesNotMatch(trig.read("rlog"), /proj-gone/);
  }));
