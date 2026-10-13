// Re-running the installer's Railway target: refusals under another project name,
// recognising the recorded project by id, and re-run hints that round-trip their
// arguments. Rig: test/_installer.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withTempDir, run, railwayRig, hintArgv, recordedRig } from "./_installer.mjs";

test("fake railway: uninstall/status under another --railway-project-name refuse; never act on the recorded project", () =>
  withTempDir((dir) => {
    const rig = recordedRig(dir);
    const u = run(["--target=railway", "uninstall", "--railway-project-name=cairn-2", "--confirm-purge=cairn-2"], {
      env: rig.env,
    });
    assert.notEqual(u.code, 0, u.all);
    assert.match(u.err, /already manages the Railway project 'cairn'\. Another install is picked with --name=<other>/);
    assert.match(u.err, /--name=cairn-2 --railway-project-name=cairn-2$/m);
    assert.doesNotMatch(rig.read("rlog"), /^railway delete/m, "the recorded project is never deleted");
    assert.ok(fs.existsSync(path.join(rig.stateDir, "railway.state")));
    for (const cmd of ["status", "open", "update", "logs"]) {
      const r = run(["--target=railway", cmd, "--railway-project-name=other"], { env: rig.env });
      assert.notEqual(r.code, 0, `${cmd}: ${r.all}`);
      assert.match(r.err, /already manages the Railway project 'cairn'/, cmd);
    }
    assert.equal(rig.read("rlog"), "", "nothing ran against Railway");
  }));

test("fake railway: the recorded project is recognised by id, also after a rename in the dashboard", () =>
  withTempDir((dir) => {
    const rig = recordedRig(dir, { name: "cairn-old", liveName: "cairn" });
    const r = run(["--target=railway", "--yes"], { env: rig.env });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(rig.read("rlog"), /^railway init/m);
    assert.doesNotMatch(r.all, /is gone/);
    assert.match(r.out, /The Railway project 'cairn-old' is now named 'cairn' \(same project\)/);
    assert.match(rig.read("rlog"), /^railway link --project proj-1 /m);
    assert.match(fs.readFileSync(path.join(rig.stateDir, "railway.state"), "utf8"), /^RW_PROJECT_NAME=cairn$/m);

    // Naming the project by its new name is the same install, not a second one.
    const same = run(["--target=railway", "--yes", "--railway-project-name=cairn"], { env: rig.env });
    assert.equal(same.code, 0, same.all);
  }));

test("fake railway: re-run hints are quoted words that give back the same arguments", () =>
  withTempDir((dir) => {
    // A taken name: the hint keeps --target and the other arguments and swaps in a free name.
    const ws = "Ana Novak's Projects";
    const rig = railwayRig(dir);
    // Two live projects named cairn: the name is taken, not one to pick.
    fs.writeFileSync(path.join(rig.state, "existing_project"), "cairn");
    fs.writeFileSync(path.join(rig.state, "project"), "cairn");
    const r = run(["--target=railway", "--yes", `--railway-workspace=${ws}`], { env: rig.env });
    assert.notEqual(r.code, 0, r.all);
    assert.deepEqual(hintArgv(r.err), [
      "--target=railway",
      "--yes",
      `--railway-workspace=${ws}`,
      "--railway-project-name=cairn-2",
    ]);

    // railway-template with no terminal: the --yes hint gives back the workspace word for word.
    fs.mkdirSync(path.join(dir, "t"));
    const tpl = run(["railway-template", "--workspace", ws], { env: railwayRig(path.join(dir, "t")).env });
    assert.notEqual(tpl.code, 0, tpl.all);
    assert.deepEqual(hintArgv(tpl.err), ["railway-template", "--workspace", ws, "--yes"]);

    // A long taken name: the suggested <name>-2 still fits --railway-project-name.
    const long = `c${"x".repeat(62)}`;
    fs.writeFileSync(path.join(rig.state, "existing_project"), long);
    fs.writeFileSync(path.join(rig.state, "project"), long);
    const l = run(["--target=railway", "--yes", `--railway-project-name=${long}`], { env: rig.env });
    assert.notEqual(l.code, 0, l.all);
    const suggested = hintArgv(l.err).at(-1).replace("--railway-project-name=", "");
    assert.match(suggested, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}-2$/);
    assert.equal(suggested.length, 63);
  }));

test("fake railway: a second install's hint names a valid --name, or asks for one", () =>
  withTempDir((dir) => {
    const rig = recordedRig(dir);
    const r = run(["--target=railway", "--yes", "--railway-project-name=My.Cairn_V2"], { env: rig.env });
    assert.notEqual(r.code, 0, r.all);
    assert.match(r.err, /which still exists\. For a second install add --name=<other>/);
    const argv = hintArgv(r.err);
    assert.deepEqual(argv, ["--target=railway", "--yes", "--name=my-cairn_v2", "--railway-project-name=My.Cairn_V2"]);
    assert.match(argv[2].slice("--name=".length), /^[a-z0-9][a-z0-9_-]{0,40}$/);

    // No name of its own to derive (it would be this install's): say to pick one.
    const same = run(["--target=railway", "--yes", "--railway-project-name=Cairn"], { env: rig.env });
    assert.notEqual(same.code, 0, same.all);
    assert.match(same.err, /pick a --name \(lowercase letters, digits, '-' or '_'\)/);
    assert.doesNotMatch(rig.read("rlog"), /^railway init/m);
  }));

test("--target must name a provider exactly (no pattern matching)", () => {
  const r = run(["--target=.*", "--dry-run"]);
  assert.notEqual(r.code, 0, r.all);
  assert.match(r.err, /--target must be one of: railway local \(got '\.\*'\)/);
  assert.doesNotMatch(r.all, /not found/);
});

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
