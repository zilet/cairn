// The server's own resource limits — a full disk, a memory kill — are first-class,
// human-headline failures wherever a provider CLI runs, and the login probes read the
// CURRENT CLIs' signed-out words (grok 1.0.46, agy 1.3.1; captured 2026-10-07).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./_seed.js";
import {
  availabilityHolds,
  availabilityReason,
  classifyAgentFailure,
  resourceFailure,
  resourceFailureHeadline,
} from "../dist/agentAvailability.js";
import { parseStatusOutput, readStatusProbe } from "../dist/agents.js";
import { verifyFailureFrom } from "../dist/coachOps/welcome.js";
import { parseInstallFailure } from "../dist/agentCliUpdates.js";
import { diskSpaceMb, serverDiskRead, SMALL_DISK_MB } from "../dist/hosting.js";
import { loginExitDetail, scrubLoginLogLine } from "../dist/agentLogin.js";

process.env.AGENTS_CONFIG = path.join(import.meta.dirname, "..", "agents.json");

test("a full disk is classified ahead of every provider reading, and held", () => {
  const f = classifyAgentFailure("claude", {
    code: 1,
    raw: "",
    stderr: "npm error code ENOSPC\nnpm error syscall write\nnpm error nospc ENOSPC: no space left on device, write",
  });
  assert.equal(f.state, "disk_full");
  assert.equal(availabilityHolds("disk_full"), true);
  assert.equal(availabilityReason(f), "the server's disk is full");
  // Even when the same output ALSO looks like a sign-in failure.
  assert.equal(
    classifyAgentFailure("grok", { code: 1, raw: "", stderr: "not logged in\nNo space left on device" }).state,
    "disk_full"
  );
});

test("a SIGKILL Cairn did not send, or exit 137, is the memory killer — not held", () => {
  assert.equal(classifyAgentFailure("codex", { code: null, signal: "SIGKILL", raw: "", stderr: "" }).state, "out_of_memory");
  assert.equal(classifyAgentFailure("codex", { code: 137, raw: "", stderr: "" }).state, "out_of_memory");
  assert.equal(
    classifyAgentFailure("claude", { code: 134, raw: "", stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" }).state,
    "out_of_memory"
  );
  assert.equal(availabilityHolds("out_of_memory"), false);
  // An ordinary failure is untouched.
  assert.equal(resourceFailure({ code: 1, raw: "", stderr: "something else" }), null);
  assert.equal(classifyAgentFailure("codex", { code: 1, raw: "", stderr: "boom" }).state, "process_error");
});

test("the headline says what happened and what to do, for every surface", () => {
  assert.equal(
    resourceFailureHeadline("disk_full", "Claude"),
    "Your server's disk is full, so Claude couldn't work. Use a bigger volume or remove a provider you don't use."
  );
  assert.equal(
    resourceFailureHeadline("out_of_memory", "Google"),
    "Your server ran out of memory while Google was working. A bigger plan or one provider at a time helps."
  );
  assert.equal(resourceFailureHeadline("auth_required", "Claude"), null);
  // The welcome hello carries the reason code and the same headline.
  const v = verifyFailureFrom("claude", { failure: { state: "disk_full", window: null, resets_at: null, detail: "" } });
  assert.equal(v.reason, "disk_full");
  assert.match(v.message, /^Your server's disk is full, so Claude couldn't work\./);
  assert.equal(verifyFailureFrom("grok", { failure: { state: "out_of_memory", resets_at: null, detail: "" } }).reason, "out_of_memory");
});

test("grok 1.0.46 signed out is a definite no, even though it still lists models", () => {
  const signedOut = "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";
  assert.equal(parseStatusOutput("grok", signedOut), false);
  assert.equal(parseStatusOutput("grok", "You are not authenticated.\n\nDefault model: grok-4.6"), false);
  assert.equal(parseStatusOutput("grok", "Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)"), true);
});

test("a timed-out agy probe that already said 'Authentication required' reads as signed out", () => {
  const agy131SignedOut =
    "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?client_id=x&state=y\n\nWaiting for authentication (timeout 60s)...\nOr, paste the authorization code here and press Enter:\n";
  const timedOut = Object.assign(new Error("spawnSync agy ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.equal(readStatusProbe("antigravity", { error: timedOut, stdout: agy131SignedOut, stderr: "" }), false);
  // A cut-off run never says yes, and silence says nothing.
  assert.equal(readStatusProbe("grok", { error: timedOut, stdout: "Available models:\n  * grok-4.6", stderr: "" }), null);
  assert.equal(readStatusProbe("antigravity", { error: timedOut, stdout: "", stderr: "" }), null);
  // agy 1.3.1 `agy models` signed out (the old probe) is a no as well.
  assert.equal(
    parseStatusOutput("antigravity", "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in."),
    false
  );
});

test("the installer's classified failure line is read back as reason + headline", () => {
  const stderr = [
    "npm warn something",
    'CAIRN_INSTALL_FAILURE {"agent":"claude","reason":"disk_full","message":"Your server\'s disk is nearly full (61 MB free; Claude needs about 260 MB). Use a bigger volume or remove a provider you don\'t use.","free_mb":61,"need_mb":260}',
    "agent CLI install failed: Your server's disk is nearly full (61 MB free; Claude needs about 260 MB).",
  ].join("\n");
  const f = parseInstallFailure(stderr);
  assert.equal(f.reason, "disk_full");
  assert.equal(f.agent, "claude");
  assert.equal(f.free_mb, 61);
  assert.equal(f.need_mb, 260);
  assert.match(f.message, /^Your server's disk is nearly full \(61 MB free; Claude needs about 260 MB\)/);
  assert.equal(parseInstallFailure("agent CLI install failed: boom"), null);
  assert.equal(parseInstallFailure('CAIRN_INSTALL_FAILURE {"reason":"weird","message":"x"}').reason, "failed");
});

test("the server disk read: small only on Railway under the threshold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-disk-"));
  try {
    const space = diskSpaceMb(path.join(dir, "not", "yet", "there"));
    assert.ok(space && space.total_mb > 0 && space.free_mb >= 0);
    const env = { CAIRN_CLI_ROOT: path.join(dir, ".cairn-tools") };
    assert.equal(serverDiskRead(env).platform === "railway", false);
    assert.equal(serverDiskRead(env).small, false);
    const railway = serverDiskRead({ ...env, CAIRN_PLATFORM: "railway" });
    assert.equal(railway.small, railway.total_mb < SMALL_DISK_MB);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("login lines are scrubbed before they reach the server log", () => {
  assert.equal(
    scrubLoginLogLine("open https://accounts.x.ai/oauth2/device?user_code=CA5S-J2KP then confirm CA5S-J2KP"),
    "open [link] then confirm [code]"
  );
  assert.equal(scrubLoginLogLine("token sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAA expired"), "token [redacted] expired");
  assert.equal(scrubLoginLogLine(null), null);
  assert.equal(loginExitDetail("Error: no space left on device"), "Error: no space left on device");
});

test("a running install's phase is the installer's newest CAIRN_PHASE line, never a guess", async () => {
  const { parseInstallPhase } = await import("../dist/agentCliUpdates.js");
  assert.equal(parseInstallPhase(""), "starting");
  assert.equal(parseInstallPhase("CAIRN_PHASE checking_disk\ninstalling Claude (claude); 900 MB free\n"), "checking_disk");
  assert.equal(parseInstallPhase("CAIRN_PHASE checking_disk\nCAIRN_PHASE downloading\nrunning npm install\n"), "downloading");
  assert.equal(parseInstallPhase("CAIRN_PHASE downloading\nCAIRN_PHASE verifying\n"), "verifying");
  assert.equal(parseInstallPhase("CAIRN_PHASE removing\n"), "removing");
  assert.equal(parseInstallPhase("CAIRN_PHASE nonsense\n"), "starting");
});
