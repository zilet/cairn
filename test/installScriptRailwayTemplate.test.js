// The installer's railway-template mode: the template spec, building a draft in a
// scratch project, publishing, and never leaking a secret. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  root,
  withTempDir,
  run,
  assertSequence,
  spec,
  SECRET_FN,
  TPL_ID,
  specSecrets,
  specPlain,
  shellConst,
  templateResponse,
  templateRig,
  assertNoSecretValues,
} from "./_installer.mjs";

test("railway template spec: install.sh carries exactly the values in deploy/railway/template.json", () => {
  assert.equal(shellConst("RW_PLAIN_VARS"), specPlain.map(([k, v]) => `${k}=${v.value}`).join(" "));
  assert.equal(shellConst("RW_SECRET_VARS"), specSecrets.join(" "));
  assert.deepEqual(specSecrets, ["CAIRN_AUTH_TOKEN", "CAIRN_SETTINGS_SECRET_KEY"]);
  for (const k of specSecrets) assert.equal(spec.variables[k].value, SECRET_FN, `${k} must be the function`);
  assert.equal(shellConst("RW_SECRET_FN"), SECRET_FN);
  assert.equal(shellConst("RW_TPL_NAME"), spec.name);
  assert.equal(shellConst("RW_TPL_CATEGORY"), spec.category);
  assert.equal(shellConst("RW_TPL_DESCRIPTION"), spec.description);
  assert.equal(shellConst("DEFAULT_IMAGE"), spec.service.image);
  assert.equal(shellConst("RW_TPL_SERVICE"), spec.service.name);
  assert.equal(shellConst("RW_TPL_MOUNT"), spec.service.volumeMountPath);
  assert.equal(shellConst("RW_TPL_HEALTHCHECK"), spec.service.healthcheckPath);
  assert.equal(Number(shellConst("RW_TPL_PORT")), spec.service.port);
  assert.equal(String(spec.service.port), spec.variables.PORT.value);
  const { schedule } = spec.service.autoUpdates;
  assert.deepEqual(
    schedule.map((w) => w.day),
    [0, 1, 2, 3, 4, 5, 6]
  );
  for (const w of schedule) {
    assert.equal(w.startHour, Number(shellConst("RW_TPL_UPDATE_START")));
    assert.equal(w.endHour, Number(shellConst("RW_TPL_UPDATE_END")));
  }
  for (const [k, v] of Object.entries(spec.variables)) assert.ok(v.description, `${k} needs a description`);
  assert.ok(fs.statSync(path.join(root, "deploy", "railway", spec.overview)).size > 0);
});

test("railway-template --dry-run prints the plan and CLI sequence, runs nothing, shows only the secret function", () =>
  withTempDir((dir) => {
    const rig = templateRig(dir);
    const r = rig.go(["--dry-run", "--publish"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /scratch project 'Cairn' \(deleted again at the end, also on failure\)/);
    assert.ok(r.out.includes(`CAIRN_AUTH_TOKEN=${SECRET_FN}`));
    assert.ok(r.out.includes(`CAIRN_SETTINGS_SECRET_KEY=${SECRET_FN}`));
    assert.match(r.out, /railway templates create --project <scratch project id> --environment production --json/);
    assert.match(r.out, /railway delete --project <scratch project id> --yes --json/);
    assert.match(r.out, /railway templates publish <template id> --category AI\/ML --description/);
    assertNoSecretValues(r.all);
    assert.equal(rig.read("rlog"), "", "a dry run calls no railway command");
    // It is its own command: this-machine options and a foreign --target are refused.
    assert.notEqual(rig.go(["--dry-run", "--lan"]).code, 0);
    assert.notEqual(rig.go(["--dry-run", "--target=local"]).code, 0);
    assert.notEqual(run(["--target=railway", "--dry-run", "--publish"], { env: rig.env }).code, 0);
  }));

test("railway-template --template on an already published template says it is published, not a draft", () =>
  withTempDir((dir) => {
    const rig = templateRig(dir);
    const ok = templateResponse({ descriptions: true, autoUpdates: true, status: "PUBLISHED" });
    fs.writeFileSync(path.join(rig.state, "template_response"), ok);
    const r = rig.go(["--template=AbC123"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Template AbC123 is published and matches deploy\/railway\/template\.json/);
    assert.doesNotMatch(r.out.split("Signed in")[1], /draft|once published/i); // the plan header precedes the lookup
    assert.match(r.out, /https:\/\/railway\.com\/deploy\/AbC123/);

    // Published but drifted from the spec: still published, with the differences listed.
    fs.writeFileSync(path.join(rig.state, "template_response"), templateResponse({ status: "PUBLISHED" }));
    const drift = rig.go(["--template=AbC123"]);
    assert.equal(drift.code, 0, drift.all);
    assert.match(drift.out, /Template AbC123 is published, but differs from deploy\/railway\/template\.json/);
    assert.match(drift.out, /Variable descriptions \(9 missing\)/);
    assert.doesNotMatch(drift.out.split("Signed in")[1], /draft|once published/i);
  }));

test("railway-template builds the draft from the spec in a scratch project, then deletes the project", () =>
  withTempDir((dir) => {
    const rig = templateRig(dir);
    const r = rig.go(["--yes", "--workspace=Someone's Projects"]);
    assert.equal(r.code, 0, r.all);
    assertSequence(rig.log(), [
      "railway whoami",
      "railway list --json",
      "railway init --name Cairn --workspace Someone's Projects --json",
      "railway list --json",
      "railway link --project proj-1 --environment production",
      "railway add --service cairn --json",
      "railway service link cairn",
      "railway volume add --mount-path /data --json",
      "railway domain --port 8787 --service cairn --json",
      "railway environment list --json",
      "railway api mutation(",
      "railway templates create --project proj-1 --environment production --json",
      "railway api query(",
      "railway delete --project proj-1 --yes --json",
    ]);
    assert.ok(!rig.log().some((l) => l.startsWith("railway templates publish")), "never publishes without --publish");
    assert.ok(!rig.log().some((l) => l.startsWith("railway templates delete")), "a checked draft is kept");
    assert.ok(!rig.log().some((l) => /^railway (add --image|redeploy|variable set)/.test(l)), "nothing deploys");
    assert.match(rig.read("api_vars"), new RegExp(`^id=${TPL_ID}$`, "m"));

    // The patch: secrets are the per-deployer function, plain values carry themselves as the
    // generator (what makes Railway's generate keep them), plus image, health check, updates.
    const patch = JSON.parse(rig.read("patch.json"));
    assert.equal(patch.env, "env-1");
    const svc = patch.patch.services["svc-1"];
    assert.equal(svc.source.image, spec.service.image);
    assert.equal(svc.deploy.healthcheckPath, spec.service.healthcheckPath);
    assert.deepEqual(svc.source.autoUpdates, {
      type: spec.service.autoUpdates.type,
      schedule: spec.service.autoUpdates.schedule,
    });
    assert.deepEqual(Object.keys(svc.variables), [...specSecrets, ...specPlain.map(([k]) => k)]);
    for (const k of specSecrets) assert.deepEqual(svc.variables[k], { value: SECRET_FN });
    for (const [k, v] of specPlain) assert.deepEqual(svc.variables[k], { value: v.value, generator: v.value });

    assert.match(r.out, /Code: {5}AbC123/);
    assert.ok(r.out.includes(`https://railway.com/workspace/templates/${TPL_ID}`));
    assert.match(r.out, /https:\/\/railway\.com\/deploy\/AbC123/);
    assert.match(r.out, /Variable descriptions \(9 missing\)/);
    assert.match(r.out, /Auto Updates: on, maintenance window Night/);
    assertNoSecretValues(r.all + rig.read("rlog") + rig.read("patch.json"));
    assert.equal(rig.has("secret_in_argv"), false);
    assert.equal(rig.has("stdin_not_closed"), false);
    const cwds = [...new Set(rig.read("rcwd").trim().split("\n"))];
    assert.equal(cwds.length, 1);
    assert.match(cwds[0], /cairn-railway-template\./);
    assert.deepEqual(rig.leftovers(), [], "the temporary directory is removed");
    assert.equal(fs.existsSync(path.join(dir, ".cairn")), false, "no install state is written");
  }));

test("railway-template never deletes a project it did not create, and cleans up its own on any failure", () =>
  withTempDir((dir) => {
    const rig = templateRig(dir);
    fs.writeFileSync(path.join(rig.state, "existing_project"), "Cairn");
    fs.writeFileSync(path.join(rig.state, "fail_templates_create"), "");
    const r = rig.go(["--yes"]);
    assert.notEqual(r.code, 0, r.all);
    assert.match(r.err, /templates create failed \(fake\)/);
    assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m, "the scratch project is deleted");
    assert.doesNotMatch(rig.read("rlog"), /delete --project proj-0/, "the existing project is untouched");
    assert.match(r.out, /Deleted the scratch project 'Cairn' \(proj-1\)/);
    assert.deepEqual(rig.leftovers(), []);
  }));

test("railway-template refuses and deletes a draft that carries a fixed secret", () =>
  withTempDir((dir) => {
    const leaked = "k3".repeat(24);
    const rig = templateRig(dir, templateResponse({ fixed: { CAIRN_AUTH_TOKEN: leaked } }));
    const r = rig.go(["--yes", "--publish"]);
    assert.notEqual(r.code, 0, r.all);
    assert.match(r.err, /fixed value for: CAIRN_AUTH_TOKEN/);
    assert.match(rig.read("rlog"), new RegExp(`^railway templates delete ${TPL_ID} --yes --json$`, "m"));
    assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m);
    assert.equal(rig.has("published"), false);
    assert.ok(!r.all.includes(leaked), "the value is never printed");

    // A missing secret is an editor step, not a leak.
    fs.mkdirSync(path.join(dir, "two"));
    const rig2 = templateRig(path.join(dir, "two"), templateResponse({ drop: ["CAIRN_SETTINGS_SECRET_KEY"] }));
    const r2 = rig2.go(["--yes"]);
    assert.equal(r2.code, 0, r2.all);
    assert.ok(r2.out.includes(`Variable CAIRN_SETTINGS_SECRET_KEY: set it to ${SECRET_FN}`));
    assert.equal(rig2.has("template_deleted"), false);
  }));

test("railway-template --publish: never with editor steps left (unless --force), and only after a yes", () =>
  withTempDir((dir) => {
    // Generate leaves descriptions and auto updates to the editor: --publish stops and says how.
    const rig = templateRig(dir);
    const r = rig.go(["--yes", "--publish"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(rig.has("published"), false);
    assert.match(r.out, /railway-template --publish --template=AbC123/);

    // A checked existing draft with everything in place: no terminal and no --yes means no.
    const done = templateResponse({ descriptions: true, autoUpdates: true });
    fs.writeFileSync(path.join(rig.state, "template_response"), done);
    const builtLines = rig.log().length;
    const asked = rig.go(["--publish", "--template=AbC123"]);
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

    const yes = rig.go(["--publish", "--template=AbC123", "--yes"]);
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
    const forced = rig.go(["--publish", "--template=AbC123", "--yes", "--force"]);
    assert.equal(forced.code, 0, forced.all);
    assert.equal(rig.has("published"), true);
    assertNoSecretValues(yes.all + forced.all + rig.read("rlog"));
  }));

test("railway-template --publish in the same run as the build publishes after deleting the scratch project", () =>
  withTempDir((dir) => {
    // From a file: the overview next to the script.
    const rig = templateRig(dir);
    const r = rig.go(["--yes", "--publish", "--force"]);
    assert.equal(r.code, 0, r.all);
    assert.equal(rig.has("published"), true);
    assertSequence(rig.log(), [
      "railway templates create",
      "railway delete --project proj-1",
      "railway templates publish",
    ]);
    assert.deepEqual(rig.leftovers(), []);

    // As `curl | sh`: the overview is fetched into the run's own temporary directory.
    fs.mkdirSync(path.join(dir, "pipe"));
    const pipe = templateRig(path.join(dir, "pipe"));
    const p = run(["railway-template", "--yes", "--publish", "--force"], { env: pipe.env, viaStdin: true });
    assert.equal(p.code, 0, p.all);
    assert.equal(pipe.has("published"), true);
    const publish = pipe.log().find((l) => l.startsWith("railway templates publish"));
    assert.match(publish, /--readme-file \S*\/cairn-railway-template\.[^/ ]+\/overview\.md --json$/);
    assert.deepEqual(pipe.leftovers(), []);

    // Editor steps left: the hint is the one-liner, not a file that does not exist.
    fs.mkdirSync(path.join(dir, "held"));
    const heldRig = templateRig(path.join(dir, "held"));
    const held = run(["railway-template", "--yes", "--publish"], { env: heldRig.env, viaStdin: true });
    assert.equal(held.code, 0, held.all);
    assert.match(
      held.out,
      /^ {2}curl -fsSL https:\/\/cairn\.fit\/install \| sh -s -- railway-template --publish --template=AbC123$/m
    );
  }));

test("railway-template: a failed project list after init still deletes the scratch project, or says it may exist", () =>
  withTempDir((dir) => {
    const rig = templateRig(dir);
    fs.writeFileSync(path.join(rig.state, "fail_list_after_init"), "");
    const r = rig.go(["--yes"]);
    assert.notEqual(r.code, 0, r.all);
    assert.match(r.err, /could not list your projects/);
    assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m, "the id init gave is deleted");
    assert.deepEqual(rig.leftovers(), []);

    // init answered no id: nothing to delete by id, so it says what may be left behind.
    fs.mkdirSync(path.join(dir, "quiet"));
    const quiet = templateRig(path.join(dir, "quiet"));
    fs.writeFileSync(path.join(quiet.state, "fail_list_after_init"), "");
    fs.writeFileSync(path.join(quiet.state, "init_quiet"), "");
    const q = quiet.go(["--yes"]);
    assert.notEqual(q.code, 0, q.all);
    assert.match(q.err, /A scratch project named 'Cairn' may now exist in Railway/);
    assert.doesNotMatch(quiet.read("rlog"), /^railway delete/m);
  }));
