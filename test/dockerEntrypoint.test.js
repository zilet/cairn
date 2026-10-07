// scripts/docker-entrypoint.sh, single-volume mode (CAIRN_SINGLE_VOLUME=1): a hosting
// platform gives a service ONE persistent volume at /data, so the home state that
// normally lives on the /home/app volumes (provider logins, installed CLIs, the compile
// cache) moves to $DATA_DIR/home and every image variable aimed at /home/app follows it.
// This drives the script's unprivileged branch (the one a platform that runs the image
// as a fixed non-root uid takes) with the image's own env and reads back what the app
// would see. The root branch only differs by chown + su, which a test cannot run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(root, "scripts", "docker-entrypoint.sh");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const IMAGE_PATH = [
  "/home/app/.cairn-tools/bin",
  "/home/app/.local/bin",
  "/home/app/.grok/bin",
  "/home/app/.antigravity-ide/antigravity-ide/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
// What the Dockerfile's ENV sets for the runtime stage.
const IMAGE_ENV = {
  PATH: IMAGE_PATH,
  HOME: "/home/app",
  CAIRN_CLI_ROOT: "/home/app/.cairn-tools",
  NPM_CONFIG_PREFIX: "/home/app/.cairn-tools",
  NPM_CONFIG_CACHE: "/home/app/.cairn-tools/.npm-cache",
  NODE_COMPILE_CACHE: "/home/app/.cache/node-compile-cache",
};

function runEntrypoint(env) {
  const result = spawnSync("sh", [entrypoint, "env"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
}

test("single-volume mode moves every home path under $DATA_DIR/home", {
  skip: isRoot && "runs the su branch as root",
}, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ep-"));
  try {
    const home = path.join(dataDir, "home");
    const env = runEntrypoint({ ...IMAGE_ENV, DATA_DIR: dataDir, CAIRN_SINGLE_VOLUME: "1", OTHER: "/home/applesauce" });
    assert.equal(env.HOME, home);
    assert.equal(env.CAIRN_CLI_ROOT, `${home}/.cairn-tools`);
    assert.equal(env.NPM_CONFIG_PREFIX, `${home}/.cairn-tools`);
    assert.equal(env.NPM_CONFIG_CACHE, `${home}/.cairn-tools/.npm-cache`);
    assert.equal(env.NODE_COMPILE_CACHE, `${home}/.cache/node-compile-cache`);
    assert.equal(env.PATH, IMAGE_PATH.replaceAll("/home/app", home));
    assert.ok(!env.PATH.includes("/home/app"), "no PATH entry still points at the image home");
    assert.equal(env.OTHER, "/home/applesauce", "only /home/app itself is rewritten, not a lookalike prefix");
    assert.ok(
      fs.statSync(path.join(home, ".cairn-tools", "bin")).isDirectory(),
      "the CLI bin dir exists on the volume"
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("without the flag the image's home layout is untouched", { skip: isRoot && "runs the su branch as root" }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ep-"));
  try {
    const env = runEntrypoint({ ...IMAGE_ENV, DATA_DIR: dataDir });
    for (const [key, value] of Object.entries(IMAGE_ENV)) assert.equal(env[key], value, key);
    assert.equal(fs.existsSync(path.join(dataDir, "home")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the root branch carries HOME and PATH through su explicitly", () => {
  // su without --login resets HOME to the passwd entry; the rewritten values must be
  // handed to the app on the far side of it, not left to su.
  const source = fs.readFileSync(entrypoint, "utf8");
  assert.match(source, /exec su -s \/bin\/sh -c/);
  assert.match(source, /HOME="\$CAIRN_ENTRY_HOME" PATH="\$CAIRN_ENTRY_PATH" "\$@"/);
});
