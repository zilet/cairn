// The installer's railway-template mode: the template spec, building a draft in a
// scratch project, publishing, and never leaking a secret. Rig: test/_installer.mjs.
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
  SECRET_FN,
  TPL_ID,
  specSecrets,
  specPlain,
  shellConst,
  templateResponse,
  templateRig,
  assertNoSecretValues,
} from "./_installer.mjs";

// Every case has its own temp dir, fake binaries and state, so they run side by side.
describe("installScriptRailwayTemplate", { concurrency: true }, () => {
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
    withTempDir(async (dir) => {
      const rig = templateRig(dir);
      // Dry runs and refusals write nothing: start every run together, assert in order.
      const [r, lan, local, foreign] = await Promise.all([
        rig.go(["--dry-run", "--publish"]),
        rig.go(["--dry-run", "--lan"]),
        rig.go(["--dry-run", "--target=local"]),
        run(["--target=railway", "--dry-run", "--publish"], { env: rig.env }),
      ]);
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
      assert.notEqual(lan.code, 0);
      assert.notEqual(local.code, 0);
      assert.notEqual(foreign.code, 0);
    }));

  test("railway-template --template on an already published template says it is published, not a draft", () =>
    withTempDir(async (dir) => {
      const rig = templateRig(dir);
      const ok = templateResponse({ descriptions: true, autoUpdates: true, status: "PUBLISHED" });
      fs.writeFileSync(path.join(rig.state, "template_response"), ok);
      const r = await rig.go(["--template=AbC123"]);
      assert.equal(r.code, 0, r.all);
      assert.match(r.out, /Template AbC123 is published and matches deploy\/railway\/template\.json/);
      assert.doesNotMatch(r.out.split("Signed in")[1], /draft|once published/i); // the plan header precedes the lookup
      assert.match(r.out, /https:\/\/railway\.com\/deploy\/AbC123/);

      // Published but drifted from the spec: still published, with the differences listed.
      fs.writeFileSync(path.join(rig.state, "template_response"), templateResponse({ status: "PUBLISHED" }));
      const drift = await rig.go(["--template=AbC123"]);
      assert.equal(drift.code, 0, drift.all);
      assert.match(drift.out, /Template AbC123 is published, but differs from deploy\/railway\/template\.json/);
      assert.match(drift.out, /Variable descriptions \(9 missing\)/);
      assert.doesNotMatch(drift.out.split("Signed in")[1], /draft|once published/i);
    }));

  test("railway-template builds the draft from the spec in a scratch project, then deletes the project", () =>
    withTempDir(async (dir) => {
      const rig = templateRig(dir);
      const r = await rig.go(["--yes", "--workspace=Someone's Projects"]);
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
    withTempDir(async (dir) => {
      const rig = templateRig(dir);
      fs.writeFileSync(path.join(rig.state, "existing_project"), "Cairn");
      fs.writeFileSync(path.join(rig.state, "fail_templates_create"), "");
      const r = await rig.go(["--yes"]);
      assert.notEqual(r.code, 0, r.all);
      assert.match(r.err, /templates create failed \(fake\)/);
      assert.match(
        rig.read("rlog"),
        /^railway delete --project proj-1 --yes --json$/m,
        "the scratch project is deleted"
      );
      assert.doesNotMatch(rig.read("rlog"), /delete --project proj-0/, "the existing project is untouched");
      assert.match(r.out, /Deleted the scratch project 'Cairn' \(proj-1\)/);
      assert.deepEqual(rig.leftovers(), []);
    }));

  test("railway-template refuses and deletes a draft that carries a fixed secret", () =>
    withTempDir(async (dir) => {
      const leaked = "k3".repeat(24);
      const rig = templateRig(dir, templateResponse({ fixed: { CAIRN_AUTH_TOKEN: leaked } }));
      fs.mkdirSync(path.join(dir, "two"));
      const rig2 = templateRig(path.join(dir, "two"), templateResponse({ drop: ["CAIRN_SETTINGS_SECRET_KEY"] }));
      const [r, r2] = await Promise.all([rig.go(["--yes", "--publish"]), rig2.go(["--yes"])]);
      assert.notEqual(r.code, 0, r.all);
      assert.match(r.err, /fixed value for: CAIRN_AUTH_TOKEN/);
      assert.match(rig.read("rlog"), new RegExp(`^railway templates delete ${TPL_ID} --yes --json$`, "m"));
      assert.match(rig.read("rlog"), /^railway delete --project proj-1 --yes --json$/m);
      assert.equal(rig.has("published"), false);
      assert.ok(!r.all.includes(leaked), "the value is never printed");

      // A missing secret is an editor step, not a leak.
      assert.equal(r2.code, 0, r2.all);
      assert.ok(r2.out.includes(`Variable CAIRN_SETTINGS_SECRET_KEY: set it to ${SECRET_FN}`));
      assert.equal(rig2.has("template_deleted"), false);
    }));
});
