// Re-running the installer's Railway target never overrides a variable you emptied or
// set to off. Split from installScriptRailwayRerun.test.js. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withTempDir, run, railwayRig } from "./_installer.mjs";

test("fake railway: a re-run never overrides a variable you emptied or set to off", () =>
  withTempDir((dir) => {
    const rig = railwayRig(dir);
    assert.equal(run(["--target=railway", "--yes"], { env: rig.env }).code, 0);
    for (const value of ["", "off"]) {
      const vars = rig.read("vars").replace(/^CAIRN_FEEDBACK_URL=.*$/gm, "");
      fs.writeFileSync(path.join(rig.state, "vars"), `${vars.replace(/\n+/g, "\n")}CAIRN_FEEDBACK_URL=${value}\n`);
      const before = rig.read("rlog").length;
      const r = run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(r.code, 0, r.all);
      assert.doesNotMatch(rig.read("rlog").slice(before), /CAIRN_FEEDBACK_URL/, `kept "${value}"`);
    }
  }));
