// The version source + the tiny SemVer comparator (src/version.ts). These back
// the in-app "is there a newer Cairn release?" check, so the comparison must be
// correct AND conservative — a garbage tag or an unknown running version must
// NEVER read as "update available" (no false nag). Pure, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, compareVersions, isNewer, getVersion } from "../dist/version.js";

test("parseVersion handles v-prefix, plain, pre-release, and garbage", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion("1.2.3-rc.1"), { major: 1, minor: 2, patch: 3, pre: ["rc", "1"] });
  assert.equal(parseVersion("main"), null);   // a branch name baked into CAIRN_VERSION
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test("compareVersions orders core versions", () => {
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0); // v-prefix is normalized
});

test("a release outranks a pre-release of the same core (SemVer §11)", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1); // shorter pre-release set is lower
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-beta"), -1);  // numeric < alphanumeric at the differing field
});

test("isNewer is strict and never nags on garbage", () => {
  assert.equal(isNewer("0.7.0", "0.6.1"), true);
  assert.equal(isNewer("0.6.1", "0.6.1"), false);
  assert.equal(isNewer("0.6.0", "0.6.1"), false);
  assert.equal(isNewer("0.6.1-rc.1", "0.6.1"), false); // a pre-release is not newer than the release
  assert.equal(isNewer("garbage", "0.6.1"), false);    // unparseable latest → never an update
  assert.equal(isNewer("0.7.0", "unknown"), false);    // unparseable current → never an update
});

test("getVersion returns a parseable version string", () => {
  const v = getVersion();
  assert.ok(parseVersion(v), `getVersion() => ${v} should parse as a version`);
  assert.ok(!/^v/i.test(v), "getVersion() is normalized (no leading v)");
});
