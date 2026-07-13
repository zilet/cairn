import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// nutritionCheckin's protective raise-only guard (src/coachOps.ts, inside the
// `!outcomeReady` branch) only opens a bounded RAISE when there's a real
// baseline target to raise from. With no accepted/active nutrition target and
// no computable goal (an incomplete profile), personalizeNutritionCheckinTarget
// leaves nutrition.prev_target_kcal null, and the guard must hold (change:false)
// rather than fabricate a raise off Number(null) === 0.
//
// The offline "stub" agent's canned reply is plan-proposal shaped, not
// nutrition_checkin shaped (see test/coachOpsFailures.test.js), so it can't
// exercise this branch. Instead this spawns an isolated subprocess with its own
// throwaway AGENTS_CONFIG/DATA_DIR — the same pattern test/agentExecution.test.js
// uses to control a canned agent reply without touching the real agents.json.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distRepoUrl = pathToFileURL(path.join(root, "dist", "repo.js")).href;
const distSharedUrl = pathToFileURL(path.join(root, "dist", "repo", "shared.js")).href;
const distCoachOpsUrl = pathToFileURL(path.join(root, "dist", "coachOps.js")).href;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-nutrition-guard-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// dist/repo.js pulls in dist/db.js, which runs the migration ladder at import
// time and logs each applied step to stdout ("[migrate] applied v… …") ahead of
// our JSON payload — unlike agentExecution.test.js's runners, which only import
// dist/agents.js and never touch the DB. A sentinel line printed immediately
// before the JSON keeps the parse anchored to our payload regardless of what
// boot logging lands on stdout first.
const RESULT_SENTINEL = "===CAIRN_TEST_RESULT===";
function parseSentineledResult(stdout) {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  assert.notEqual(idx, -1, `result sentinel not found in subprocess stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(idx + RESULT_SENTINEL.length).trim());
}

test("nutrition check-in holds with no baseline target instead of fabricating a protective raise", () =>
  withTempDir((dataDir) => {
    const configPath = path.join(dataDir, "agents.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        "checkin-stub": {
          command: "sh",
          args: [
            "-c",
            "printf '%s' '{\"change\":true,\"summary\":\"test check-in\",\"nutrition\":{\"target_kcal\":2400,\"protein_g\":150}}'",
          ],
          input: "arg",
          env_required: [],
        },
      })
    );

    const runner = [
      `import * as repo from ${JSON.stringify(distRepoUrl)};`,
      `import { localDateISO } from ${JSON.stringify(distSharedUrl)};`,
      `import { nutritionCheckin } from ${JSON.stringify(distCoachOpsUrl)};`,
      // Two recent sessions with genuinely low 1-tap performance feedback open
      // the protective low-confidence fuel path. This fresh DB has no logged
      // intake/weigh-ins, so expenditure confidence stays 'none' (outcomeReady
      // false) and there is neither an accepted nor an active nutrition target.
      "repo.setSessionFeedback(localDateISO(), { performance: 2 });",
      "repo.setSessionFeedback(localDateISO(new Date(Date.now() - 86400000)), { performance: 2 });",
      `const result = await nutritionCheckin("checkin-stub", 21);`,
      `process.stdout.write(${JSON.stringify(RESULT_SENTINEL)});`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");

    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: {
        ...process.env,
        AGENTS_CONFIG: configPath,
        DATA_DIR: dataDir,
        DB_PATH: path.join(dataDir, "cairn.db"),
      },
      encoding: "utf8",
    });

    assert.equal(res.status, 0, res.stderr);
    const result = parseSentineledResult(res.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.change, false);
    assert.equal(result.reason, "protective_raise_only");
    assert.equal(result.proposal, null);
  }));
