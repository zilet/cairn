// The ONE resolution of Cairn's data directory, shared by every module that writes under
// it (the DB, uploads, generated art, the Garmin token, exercise guides).
//
// Under node:test (NODE_TEST_CONTEXT is set only in its child processes) with no DATA_DIR,
// a run that skipped test/run.mjs must never touch the real data/ — the DB, an upload, a
// generated image or a token alike — so it gets one throwaway directory, published back to
// DATA_DIR so the modules that read the environment at call time (agentDataDir) agree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.NODE_TEST_CONTEXT) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-test-"));
    process.env.DATA_DIR = dir;
    return dir;
  }
  return path.join(__dirname, "..", "data");
}

export const DATA_DIR = resolveDataDir();
