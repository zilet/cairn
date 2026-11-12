// The installer's Railway target when the deployment fails or the image has no pairing
// codes, against a fake Railway CLI. Split from installScriptRailway.test.js.
// Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { withTempDir, run, railwayRig } from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptRailwayFailures", { concurrency: true }, () => {
  test("fake railway: a failed deployment shows the last log lines without the token", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "statuses"), "BUILDING\nFAILED\n");
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.notEqual(r.code, 0);
      const { token } = rig.secrets();
      assert.ok(token);
      assert.match(r.err, /deployment FAILED/);
      assert.match(r.err, /EADDRINUSE \(fake failure\)/);
      assert.match(
        rig.read("rlog"),
        /^railway logs --service cairn --environment production --build --lines 30 dep-2$/m
      );
      assert.doesNotMatch(r.all, new RegExp(token), "the token is filtered out of the printed logs");
      assert.equal(fs.existsSync(path.join(rig.state, "opened")), false);
    }));

  test("fake railway: an image without pairing codes (404) falls back to the access token", () =>
    withTempDir(async (dir) => {
      const rig = railwayRig(dir);
      fs.writeFileSync(path.join(rig.state, "pair_404"), "");
      const r = await run(["--target=railway", "--yes"], { env: rig.env });
      assert.equal(r.code, 0, r.all);
      assert.equal(fs.existsSync(path.join(rig.state, "opened")), false, "nothing to open without a code");
      assert.match(r.out, /Open: https:\/\/cairn-production-a1b2\.up\.railway\.app/);
      assert.match(r.out, /no one-time sign-in link yet/);
      assert.match(r.out, /Sign in with your access token: \(not printed: this output is not a terminal\)/);
      // The terminal decision is made once, outside $(...): a forced terminal prints the token.
      const tty = await run(["--target=railway", "--yes"], { env: { ...rig.env, CAIRN_INSTALL_FORCE_TTY: "1" } });
      assert.equal(tty.code, 0, tty.all);
      assert.match(tty.out, new RegExp(`Sign in with your access token: ${rig.secrets().token}`));
      assert.match(r.out, /Railway \(project cairn -> service cairn -> Variables -> CAIRN_AUTH_TOKEN\)/);
      assert.match(r.out, /The access token shown above/);
      assert.doesNotMatch(r.all, new RegExp(rig.secrets().token));
    }));
});
