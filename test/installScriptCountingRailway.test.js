// The installer's anonymous install counting on its Railway target (what a finished and a
// failed deployment send, and every opt-out) against a fake curl. Split from
// installScriptCounting.test.js. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { withTempDir, run, railwayRig, COUNTING, eventLines, eventQuery } from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptCountingRailway", { concurrency: true }, () => {
  test("counting: a Railway install sends chose then done, and nothing about the person", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      const r = await run(["--target=railway", "--yes"], { env: { ...rig.env, ...COUNTING } });
      assert.equal(r.code, 0, r.all);
      const events = eventLines(rig.read("clog"));
      assert.equal(events.length, 2, rig.read("clog"));
      assert.deepEqual(eventQuery(events[0]), { e: "chose", t: "railway", s: "none", v: "1" });
      assert.deepEqual(eventQuery(events[1]), { e: "done", t: "railway", s: "none", v: "1" });
      const { token } = rig.secrets();
      for (const line of events) {
        assert.match(line, /--max-time 3/);
        assert.doesNotMatch(line, new RegExp(token));
        assert.doesNotMatch(line, /railway\.app|proj-1|cairn-production|\/home|\/tmp/);
      }
      assert.doesNotMatch(r.all, /events\.example\.test/, "counting prints nothing");

      // Opted out three ways: no event at all.
      for (const [args, env] of [
        [["--no-telemetry"], {}],
        [[], { DO_NOT_TRACK: "1" }],
        [[], { CAIRN_INSTALL_EVENT_URL: "" }],
      ]) {
        const before = eventLines(rig.read("clog")).length;
        const again = await run(["--target=railway", "--yes", ...args], { env: { ...rig.env, ...COUNTING, ...env } });
        assert.equal(again.code, 0, again.all);
        assert.equal(eventLines(rig.read("clog")).length, before, JSON.stringify({ args, env }));
      }
      // update / status never count.
      const before = eventLines(rig.read("clog")).length;
      assert.equal((await rig.cairnSh(["status"])).code, 0);
      assert.equal(eventLines(rig.read("clog")).length, before);
    }));

  test("counting: a failed Railway deployment reports the step code, once", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "statuses"), "BUILDING\nFAILED\n");
      const r = await run(["--target=railway", "--yes"], { env: { ...rig.env, ...COUNTING } });
      assert.notEqual(r.code, 0);
      const events = eventLines(rig.read("clog")).map(eventQuery);
      assert.deepEqual(events, [
        { e: "chose", t: "railway", s: "none", v: "1" },
        { e: "failed", t: "railway", s: "railway_deploy", v: "1" },
      ]);
    }));
});
