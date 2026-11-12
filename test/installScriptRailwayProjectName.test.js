// Re-running the installer's Railway target under a project name: moving on from a
// recorded project once it is gone, a taken name, and a project Railway is still
// deleting. Split from installScriptRailwayRecorded.test.js. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { withTempDir, run, railwayRig, templateRig } from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptRailwayProjectName", { concurrency: true }, () => {
  test("fake railway: --railway-project-name moves on from a recorded project only once it is gone", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      const state = path.join(rig.stateDir, "railway.state");
      fs.mkdirSync(rig.stateDir, { recursive: true });
      fs.writeFileSync(
        state,
        "RW_PROJECT_ID=proj-old\nRW_PROJECT_NAME=cairn\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\n"
      );

      // The recorded project still exists: never swapped out from under it.
      fs.mkdirSync(path.join(dir, "b"));
      const live = railwayRig(path.join(dir, "b"));
      fs.writeFileSync(path.join(live.state, "project"), "cairn");
      fs.mkdirSync(live.stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(live.stateDir, "railway.state"),
        "RW_PROJECT_ID=proj-1\nRW_PROJECT_NAME=cairn\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\n"
      );
      // Two independent rigs: run both installs at once.
      const [r, l] = await Promise.all([
        run(["--target=railway", "--yes", "--railway-project-name=cairn-v2"], { env: rig.env }),
        run(["--target=railway", "--yes", "--railway-project-name=cairn-v2"], { env: live.env }),
      ]);
      assert.equal(r.code, 0, r.all);
      assert.match(rig.read("rlog"), /^railway init --name cairn-v2 --json$/m);
      assert.match(fs.readFileSync(state, "utf8"), /^RW_PROJECT_NAME=cairn-v2$/m);
      assert.notEqual(l.code, 0, l.all);
      assert.match(l.err, /already manages the Railway project 'cairn', which still exists/);
      assert.match(l.err, /--name=cairn-v2 --railway-project-name=cairn-v2/);
      assert.doesNotMatch(live.read("rlog"), /^railway init/m);
    }));

  test("fake railway: a taken project name with no terminal says how to pick another", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "existing_project"), "cairn");
      fs.writeFileSync(path.join(rig.state, "deleted_project"), "cairn");
      // Two live projects named cairn: never guessed between, and no terminal to ask for a name.
      fs.writeFileSync(path.join(rig.state, "project"), "cairn");
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.notEqual(r.code, 0, r.all);
      assert.match(r.err, /You have 2 Railway projects named 'cairn'/);
      assert.match(r.err, /sh -s -- --target=railway --yes --railway-project-name=cairn-2$/m);
      assert.doesNotMatch(rig.read("rlog"), /^railway init/m);
    }));

  test("fake railway: a project Railway is still deleting (deletedAt) is never reused or counted", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "deleted_project"), "cairn");
      // The template build's before/after diff ignores it too (a second, independent rig).
      fs.mkdirSync(path.join(dir, "t"));
      const trig = templateRig(path.join(dir, "t"));
      fs.writeFileSync(path.join(trig.state, "deleted_project"), "Cairn");
      const [r, t] = await Promise.all([run(["--target=railway", "--yes"], { env: rig.env }), trig.go(["--yes"])]);
      assert.equal(r.code, 0, r.all);
      assert.match(rig.read("rlog"), /^railway init --name cairn --json$/m, "a new project, not the deleted one");
      assert.doesNotMatch(rig.read("rlog"), /proj-gone/);
      assert.doesNotMatch(r.all, /already exists/);

      assert.equal(t.code, 0, t.all);
      assert.match(trig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m);
      assert.doesNotMatch(trig.read("rlog"), /proj-gone/);
    }));
});
