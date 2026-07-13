import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The veto cooldown (src/coachOps.ts nutritionCheckin + repo.hasRecentDecisionVeto):
// after the athlete rejects a nutrition_target decision, an AUTOMATIC re-check
// (scheduler cadence, brain signal boundary) must respect that "no" for a bounded
// window instead of re-proposing a near-identical target at the next weigh-in.
// A manual check-in (Energy Balance button, REST, MCP) still runs because the
// athlete explicitly asked.
//
// Mirrors test/nutritionCheckinProtectiveGuard.test.js: an isolated subprocess
// with its own throwaway AGENTS_CONFIG/DATA_DIR drives a canned agent so we can
// assert the exact result shape AND — via a marker file the canned agent touches
// only when it actually runs — that the gate short-circuits before any agent spawn.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distDbUrl = pathToFileURL(path.join(root, "dist", "db.js")).href;
const distRepoUrl = pathToFileURL(path.join(root, "dist", "repo.js")).href;
const distSharedUrl = pathToFileURL(path.join(root, "dist", "repo", "shared.js")).href;
const distCoachOpsUrl = pathToFileURL(path.join(root, "dist", "coachOps.js")).href;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-nutrition-veto-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// dist/repo.js pulls in dist/db.js, which logs each applied migration to stdout
// ahead of our payload. A sentinel printed immediately before the JSON keeps the
// parse anchored to our result regardless of boot logging.
const RESULT_SENTINEL = "===CAIRN_TEST_RESULT===";
function parseSentineledResult(stdout) {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  assert.notEqual(idx, -1, `result sentinel not found in subprocess stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(idx + RESULT_SENTINEL.length).trim());
}

// Run one nutrition check-in against a fresh DB. `veto` seeds a rejected
// nutrition_target decision (optionally backdated so it falls outside the window),
// `initiated` mirrors the caller's intent. Returns { result, agentRan } — agentRan
// is proven by the marker file the canned agent touches only when it is spawned.
function runCheckin({ veto = null, initiated } = {}) {
  return withTempDir((dataDir) => {
    const marker = path.join(dataDir, "agent_ran");
    const configPath = path.join(dataDir, "agents.json");
    // The canned reply is nutrition_checkin shaped (change:true) so that whenever
    // the veto gate does NOT fire the run reaches the agent and the marker appears.
    const script =
      `touch ${JSON.stringify(marker)}; ` +
      `printf '%s' '{"change":true,"summary":"test check-in","nutrition":{"target_kcal":2400,"protein_g":150}}'`;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        "checkin-stub": { command: "sh", args: ["-c", script], input: "arg", env_required: [] },
      })
    );

    const lines = [
      `import { db } from ${JSON.stringify(distDbUrl)};`,
      `import * as repo from ${JSON.stringify(distRepoUrl)};`,
      `import { localDateISO } from ${JSON.stringify(distSharedUrl)};`,
      `import { nutritionCheckin } from ${JSON.stringify(distCoachOpsUrl)};`,
      // Two low-performance sessions open the protective low-confidence fuel path,
      // so a run that clears the veto gate proceeds far enough to invoke the agent
      // (mirrors the sibling protective-guard test's setup).
      "repo.setSessionFeedback(localDateISO(), { performance: 2 });",
      "repo.setSessionFeedback(localDateISO(new Date(Date.now() - 86400000)), { performance: 2 });",
    ];
    if (veto) {
      lines.push(
        `const rec = repo.recordDecision({ kind: "nutrition_target", domain: "nutrition", summary: "prior target the athlete declined", autonomy_tier: "ask", risk_class: "moderate", reversible: true, status: "rejected" });`
      );
      if (veto.ageDays) {
        // Backdate created_at so the decision falls outside the 5-day window.
        lines.push(
          `db.prepare("UPDATE brain_decisions SET created_at = datetime('now', ?) WHERE id = ?").run(${JSON.stringify(`-${veto.ageDays} days`)}, rec.decision.id);`
        );
      }
    }
    const optsArg = initiated ? `, { initiated: ${JSON.stringify(initiated)} }` : "";
    lines.push(`const result = await nutritionCheckin("checkin-stub", 21, undefined${optsArg});`);
    lines.push(`process.stdout.write(${JSON.stringify(RESULT_SENTINEL)});`);
    lines.push("process.stdout.write(JSON.stringify(result));");

    const res = spawnSync(process.execPath, ["--input-type=module", "-e", lines.join("\n")], {
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
    return { result: parseSentineledResult(res.stdout), agentRan: fs.existsSync(marker) };
  });
}

test("an automatic check-in holds after a recent nutrition-target veto, without invoking an agent", () => {
  const { result, agentRan } = runCheckin({ veto: {}, initiated: "auto" });
  assert.equal(result.ok, true);
  assert.equal(result.change, false);
  assert.equal(result.reason, "recent_veto");
  assert.equal(result.proposal, null);
  assert.equal(agentRan, false, "the gate short-circuits before any agent is spawned");
});

test("a user-initiated check-in proceeds past the veto gate even with a recent veto", () => {
  // Default initiation (no opts.initiated) is the manual path — the athlete asked,
  // so the veto never suppresses it. It runs the agent and reaches the protective
  // raise-only guard (no baseline target), never the veto reason.
  const { result, agentRan } = runCheckin({ veto: {} });
  assert.equal(result.ok, true);
  assert.notEqual(result.reason, "recent_veto", "an explicit request is never suppressed by a veto");
  assert.equal(agentRan, true, "the manual path runs the agent");
});

test("an automatic check-in resumes once the veto is older than the window", () => {
  // A 10-day-old rejection is outside the 5-day cooldown, so the automatic path
  // runs again (reaching the agent + protective guard), not the veto hold.
  const { result, agentRan } = runCheckin({ veto: { ageDays: 10 }, initiated: "auto" });
  assert.equal(result.ok, true);
  assert.notEqual(result.reason, "recent_veto", "a stale veto no longer gates automatic rechecks");
  assert.equal(agentRan, true, "the automatic path runs the agent once the veto ages out");
});
