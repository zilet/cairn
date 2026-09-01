import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANTIGRAVITY_READ_URL_ALLOW,
  antigravitySettingsPath,
  ensureAntigravityHeadlessPermissions,
} from "../dist/antigravityPermissions.js";

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agy-perms-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ensureAntigravityHeadlessPermissions creates settings.json with read_url(*)", () =>
  withTempHome((home) => {
    assert.equal(ensureAntigravityHeadlessPermissions(home), true);
    const file = antigravitySettingsPath(home);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(parsed.permissions.allow, [ANTIGRAVITY_READ_URL_ALLOW]);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }));

test("ensureAntigravityHeadlessPermissions merges without clobbering existing allow rules", () =>
  withTempHome((home) => {
    const file = antigravitySettingsPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ permissions: { allow: ["command(git)"], deny: ["command(sudo)"] }, agentMode: "accept-edits" }),
      "utf8"
    );
    assert.equal(ensureAntigravityHeadlessPermissions(home), true);
    assert.equal(ensureAntigravityHeadlessPermissions(home), true, "idempotent");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(parsed.permissions.allow, ["command(git)", ANTIGRAVITY_READ_URL_ALLOW]);
    assert.deepEqual(parsed.permissions.deny, ["command(sudo)"]);
    assert.equal(parsed.agentMode, "accept-edits");
  }));

test("ensureAntigravityHeadlessPermissions leaves malformed settings.json untouched", () =>
  withTempHome((home) => {
    const file = antigravitySettingsPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json", "utf8");
    assert.equal(ensureAntigravityHeadlessPermissions(home), false);
    assert.equal(fs.readFileSync(file, "utf8"), "{not json");
  }));
