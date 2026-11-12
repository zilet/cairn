// The installer's railway-template mode, publishing: never with editor steps left, only
// after a yes, after the scratch project is gone, and cleanup when a project list fails.
// Split from installScriptRailwayTemplate.test.js. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  root,
  withTempDir,
  run,
  assertSequence,
  spec,
  TPL_ID,
  templateResponse,
  templateRig,
  assertNoSecretValues,
} from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptRailwayTemplatePublish", { concurrency: true }, () => {
  test("railway-template --publish: never with editor steps left (unless --force), and only after a yes", () =>
    withTempDir(async (dir) => {
      // Generate leaves descriptions and auto updates to the editor: --publish stops and says how.
      const rig = templateRig(dir);
      const r = await rig.go(["--yes", "--publish"]);
      assert.equal(r.code, 0, r.all);
      assert.equal(rig.has("published"), false);
      assert.match(r.out, /railway-template --publish --template=AbC123/);

      // A checked existing draft with everything in place: no terminal and no --yes means no.
      const done = templateResponse({ descriptions: true, autoUpdates: true });
      fs.writeFileSync(path.join(rig.state, "template_response"), done);
      const builtLines = rig.log().length;
      const asked = await rig.go(["--publish", "--template=AbC123"]);
      assert.notEqual(asked.code, 0, asked.all);
      assert.match(asked.err, /No terminal to ask: "Publish this template/);
      // The re-run hint repeats this run's own arguments, not a plain install.
      assert.match(asked.err, /sh -s -- railway-template --publish --template=AbC123 --yes/);
      assert.equal(rig.has("published"), false);
      assert.match(asked.out, /Category: {4}AI\/ML/);
      assert.match(rig.read("api_vars"), /^code=AbC123$/m);
      assert.ok(
        !rig
          .log()
          .slice(builtLines)
          .some((l) => l.startsWith("railway init")),
        "--template builds nothing"
      );

      const yes = await rig.go(["--publish", "--template=AbC123", "--yes"]);
      assert.equal(yes.code, 0, yes.all);
      const overview = path.join(root, "deploy", "railway", "overview.md");
      assert.ok(
        rig
          .log()
          .includes(
            `railway templates publish ${TPL_ID} --category AI/ML --description ${spec.description} --readme-file ${overview} --json`
          ),
        rig.read("rlog")
      );
      // Publishing can rename the code (Railway gave ours "cairn"): the link follows the publish answer.
      assert.match(yes.out, /Published: https:\/\/railway\.com\/deploy\/cairn\n/);

      // --force publishes a draft whose only gaps are editor-only items.
      fs.rmSync(path.join(rig.state, "published"));
      fs.writeFileSync(path.join(rig.state, "template_response"), templateResponse());
      const forced = await rig.go(["--publish", "--template=AbC123", "--yes", "--force"]);
      assert.equal(forced.code, 0, forced.all);
      assert.equal(rig.has("published"), true);
      assertNoSecretValues(yes.all + forced.all + rig.read("rlog"));
    }));

  test("railway-template --publish in the same run as the build publishes after deleting the scratch project", () =>
    withTempDir(async (dir) => {
      // Three independent rigs, run together.
      const rig = templateRig(dir);
      fs.mkdirSync(path.join(dir, "pipe"));
      const pipe = templateRig(path.join(dir, "pipe"));
      fs.mkdirSync(path.join(dir, "held"));
      const heldRig = templateRig(path.join(dir, "held"));
      const [r, p, held] = await Promise.all([
        // From a file: the overview next to the script.
        rig.go(["--yes", "--publish", "--force"]),
        // As `curl | sh`: the overview is fetched into the run's own temporary directory.
        run(["railway-template", "--yes", "--publish", "--force"], { env: pipe.env, viaStdin: true }),
        // Editor steps left: the hint is the one-liner, not a file that does not exist.
        run(["railway-template", "--yes", "--publish"], { env: heldRig.env, viaStdin: true }),
      ]);
      assert.equal(r.code, 0, r.all);
      assert.equal(rig.has("published"), true);
      assertSequence(rig.log(), [
        "railway templates create",
        "railway delete --project proj-1",
        "railway templates publish",
      ]);
      assert.deepEqual(rig.leftovers(), []);

      assert.equal(p.code, 0, p.all);
      assert.equal(pipe.has("published"), true);
      const publish = pipe.log().find((l) => l.startsWith("railway templates publish"));
      assert.match(publish, /--readme-file \S*\/cairn-railway-template\.[^/ ]+\/overview\.md --json$/);
      assert.deepEqual(pipe.leftovers(), []);

      assert.equal(held.code, 0, held.all);
      assert.match(
        held.out,
        /^ {2}curl -fsSL https:\/\/cairn\.fit\/install \| sh -s -- railway-template --publish --template=AbC123$/m
      );
    }));

  test("railway-template: a failed project list after init still deletes the scratch project, or says it may exist", () =>
    withTempDir(async (dir) => {
      const rig = templateRig(dir);
      fs.writeFileSync(path.join(rig.state, "fail_list_after_init"), "");
      // init answered no id: nothing to delete by id, so it says what may be left behind (a second rig).
      fs.mkdirSync(path.join(dir, "quiet"));
      const quiet = templateRig(path.join(dir, "quiet"));
      fs.writeFileSync(path.join(quiet.state, "fail_list_after_init"), "");
      fs.writeFileSync(path.join(quiet.state, "init_quiet"), "");
      const [r, q] = await Promise.all([rig.go(["--yes"]), quiet.go(["--yes"])]);
      assert.notEqual(r.code, 0, r.all);
      assert.match(r.err, /could not list your projects/);
      assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m, "the id init gave is deleted");
      assert.deepEqual(rig.leftovers(), []);

      assert.notEqual(q.code, 0, q.all);
      assert.match(q.err, /A scratch project named 'Cairn' may now exist in Railway/);
      assert.doesNotMatch(quiet.read("rlog"), /^railway delete/m);
    }));
});
