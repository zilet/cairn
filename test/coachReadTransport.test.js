// The coach-read transports (src/brain/read-transport.ts): which CLI calls the reads
// natively and which keeps the prompt loop is agents.json config, verified live on
// 2026-11-11. These tests pin the shipped declarations and the argv each produces —
// the claude attach must be exactly the confined command that was proven — plus the
// third tool policy ("coach_reads") and agy's explicit shell deny. Pure/offline: no
// CLI spawn, no socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./_seed.js";
import {
  COACH_READS_PREAMBLE,
  NO_TOOLS_PREAMBLE,
  applyToolPolicy,
  buildAgentLaunch,
} from "../dist/agents.js";
import {
  agentReadsNatively,
  coachReadAllowedTools,
  coachReadLaunchExtras,
  expandCoachReadAttachArgs,
  isLoopbackCoachReadUrl,
  resolveCoachReadTransport,
} from "../dist/brain/read-transport.js";
import { COACH_READ_TOOL_NAMES } from "../dist/brain/read-tools.js";
import { agentDataDir } from "../dist/agentExecution.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
const URL_ = "http://127.0.0.1:43210/mcp/abcdefghijklmnopqrstuvwxyz012345";
const AGY_DENY = ["--settings", '{"permissions":{"deny":["command(*)"]}}'];

function indexOfSequence(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((value, j) => haystack[i + j] === value)) return i;
  }
  return -1;
}

test("transport resolution reads agents.json read_tools; everything else is the prompt loop", () => {
  assert.equal(resolveCoachReadTransport("claude", shipped).transport, "native_mcp");
  assert.equal(resolveCoachReadTransport("codex", shipped).transport, "native_mcp");
  // grok and agy are verified and declared, but stay on the prompt loop this phase.
  assert.equal(resolveCoachReadTransport("grok", shipped).transport, "prompt_loop");
  assert.equal(resolveCoachReadTransport("antigravity", shipped).transport, "prompt_loop");
  assert.equal(resolveCoachReadTransport("stub", shipped).transport, "prompt_loop");
  assert.equal(resolveCoachReadTransport("nope", shipped).transport, "prompt_loop");
  // An incomplete native declaration is not honoured: nothing to attach is no transport.
  assert.equal(resolveCoachReadTransport("x", { x: { read_tools: { transport: "native_mcp" } } }).transport, "prompt_loop");
  assert.equal(
    resolveCoachReadTransport("x", { x: { read_tools: { transport: "native_mcp", attach_args: ["--flag"] } } }).transport,
    "prompt_loop",
    "an attach that never names the listener URL is refused"
  );
  assert.equal(agentReadsNatively("claude", shipped), true);
  assert.equal(agentReadsNatively("grok", shipped), false);
  for (const name of ["claude", "codex", "grok", "antigravity"]) {
    assert.match(String(shipped[name].read_tools.verified), /2026-11-11/, `${name} records when it was verified`);
  }
});

test("claude's attach argv is exactly the verified, confined command — sessions never persisted", () => {
  const spec = resolveCoachReadTransport("claude", shipped).spec;
  const tools = ["read_training_window", "read_marker_history"];
  assert.deepEqual(expandCoachReadAttachArgs(spec, { url: URL_, tools }), [
    "--mcp-config",
    JSON.stringify({ mcpServers: { "cairn-coach-read": { type: "http", url: URL_ } } }),
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    "mcp__cairn-coach-read__read_training_window,mcp__cairn-coach-read__read_marker_history",
    "--setting-sources",
    "",
    // Repeated from no_tools_args (which never expands beside MCP args): without
    // --no-session-persistence every native turn would leave a session JSONL holding the
    // prompt and every health read under ~/.claude/projects.
    "--disable-slash-commands",
    "--no-session-persistence",
  ]);
  // Default: the whole closed catalog, each named the way claude names an MCP tool.
  const all = coachReadAllowedTools(spec).split(",");
  assert.deepEqual(all, COACH_READ_TOOL_NAMES.map((name) => `mcp__cairn-coach-read__${name}`));
});

test("the native launch carries the attach, never the no-tools flags, and keeps the empty values", () => {
  const claude = shipped.claude;
  const resolved = resolveCoachReadTransport("claude", shipped);
  const extras = coachReadLaunchExtras(resolved, { url: URL_ });
  assert.equal(extras.tools, "coach_reads");
  const prompt = applyToolPolicy("DATA: {}\n\nOUTPUT CONTRACT: …", extras.tools);
  for (const template of [claude.args, claude.stream.args]) {
    const { args } = buildAgentLaunch(claude, template, prompt, { mcpConfigArgs: extras.mcpConfigArgs });
    assert.ok(indexOfSequence(args, extras.mcpConfigArgs) >= 0, "the attach lands contiguous, empty strings kept");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args.filter((arg) => arg === "--tools").length, 1, "one --tools, the attach's own");
    assert.equal(args[args.indexOf("--tools") + 1], "", 'claude says "no built-in tools" as --tools ""');
    // {no_tools_args} stays unexpanded beside MCP args; the attach carries the two
    // session flags itself, exactly once each.
    assert.equal(args.filter((arg) => arg === "--no-session-persistence").length, 1, "no session is persisted");
    assert.equal(args.filter((arg) => arg === "--disable-slash-commands").length, 1);
    assert.equal(args.filter((arg) => arg === "--strict-mcp-config").length, 1);
    assert.ok(!args.includes("--add-dir"), "no file access on a native read run");
  }
  // The prompt loop on the same CLI is unchanged: the lean no-tools flags, no attach.
  const plain = buildAgentLaunch(claude, claude.args, applyToolPolicy("DATA: {}", "none")).args;
  assert.ok(plain.includes("--disable-slash-commands"));
  assert.ok(!plain.includes("--mcp-config"));
});

test("codex's attach lands before the prompt, disables the shell, and adds no --json", () => {
  const codex = shipped.codex;
  const extras = coachReadLaunchExtras(resolveCoachReadTransport("codex", shipped), { url: URL_ });
  const prompt = applyToolPolicy("DATA: {}", extras.tools);
  const { args } = buildAgentLaunch(codex, codex.args, prompt, { mcpConfigArgs: extras.mcpConfigArgs });
  const at = args.indexOf(`mcp_servers.cairn_coach_read.url="${URL_}"`);
  assert.ok(at > 0 && args[at - 1] === "-c");
  assert.ok(args.includes('mcp_servers.cairn_coach_read.default_tools_approval_mode="approve"'));
  assert.ok(indexOfSequence(args, ["--disable", "shell_tool"]) >= 0, "the shell must be off");
  assert.ok(args.includes("--ignore-user-config"), "no ambient MCP server from config.toml");
  assert.ok(indexOfSequence(args, ["--sandbox", "read-only"]) >= 0, "sandboxed confinement holds");
  assert.ok(!args.includes("--json"), "stdout stays the final message the parse path expects");
  assert.ok(args.indexOf(prompt) > at, "every flag precedes the prompt");
});

test("a URL that is not this process's loopback listener is refused before any argv", () => {
  const spec = resolveCoachReadTransport("claude", shipped).spec;
  assert.equal(isLoopbackCoachReadUrl(URL_), true);
  for (const bad of [
    "http://example.com:43210/mcp/abcdefghijklmnopqrstuvwxyz012345",
    'http://127.0.0.1:43210/mcp/abc"},"x":{"url":"evil',
    "https://127.0.0.1:43210/mcp/abcdefghijklmnopqrstuvwxyz012345",
  ]) {
    assert.throws(() => expandCoachReadAttachArgs(spec, { url: bad }), /non-loopback/);
  }
  assert.deepEqual(coachReadLaunchExtras({ transport: "prompt_loop", spec: null }), {}, "the prompt loop adds nothing");
});

test("agy carries the explicit shell deny in both arg lists, beside file access", () => {
  const agy = shipped.antigravity;
  assert.deepEqual(agy.args.slice(0, 2), AGY_DENY);
  assert.deepEqual(agy.stream.args.slice(0, 2), AGY_DENY);
  assert.deepEqual(JSON.parse(agy.args[1]), { permissions: { deny: ["command(*)"] } });
  const upload = path.join(path.resolve(agentDataDir(process.env)), "uploads", "panel.pdf");
  const { args } = buildAgentLaunch(agy, agy.args, `Read the panel at ${upload}.`);
  assert.deepEqual(args.slice(0, 2), AGY_DENY, "the deny survives a file-handing run");
  assert.ok(args.includes("--add-dir"), "and composes with {file_access_args}");
});

test("tools:'coach_reads' leads with its own preamble, never NO_TOOLS_PREAMBLE, never both", () => {
  const out = applyToolPolicy("DATA: {}\n\nOUTPUT CONTRACT: …", "coach_reads");
  assert.ok(out.startsWith(`${COACH_READS_PREAMBLE}\n\n`));
  assert.ok(!out.includes(NO_TOOLS_PREAMBLE));
  assert.equal(applyToolPolicy(out, "coach_reads"), out, "idempotent");
  // A prompt that already led with the no-tools sentence gets it swapped, not stacked.
  const swapped = applyToolPolicy(applyToolPolicy("DATA: {}", "none"), "coach_reads");
  assert.ok(swapped.startsWith(COACH_READS_PREAMBLE));
  assert.ok(!swapped.includes(NO_TOOLS_PREAMBLE));
  // The sentence closes every other family and names the one it opens.
  assert.match(COACH_READS_PREAMBLE, /read-only coach reads/);
  assert.match(COACH_READS_PREAMBLE, /no shell, no files and no web/);
  // And the no-tools policy itself is untouched.
  assert.ok(applyToolPolicy("x", "none").startsWith(NO_TOOLS_PREAMBLE));
  assert.ok(!applyToolPolicy("x", "none").includes(COACH_READS_PREAMBLE));
});
