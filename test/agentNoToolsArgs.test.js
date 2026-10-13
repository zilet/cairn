// A run that opted into no tools starts claude lean: no tool schemas, no user MCP
// servers, no skills, no saved session. Measured on a one-line reply, that took the
// request from ~34K prompt tokens to ~3K and a second or more off the start. The flags
// ride only where the preamble already says "no tools" — a run handed files, MCP servers
// or provider tools (research) keeps the CLI's full toolset.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NO_TOOLS_PREAMBLE, applyToolPolicy, buildAgentLaunch } from "../dist/agents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
const claude = shipped.claude;
const LEAN = claude.no_tools_args;

function hasLean(args) {
  const at = args.indexOf("--tools");
  return (
    at >= 0 && args[at + 1] === "" && args.includes("--strict-mcp-config") && args.includes("--no-session-persistence")
  );
}

test('claude ships lean flags, and --tools "" is closed by a flag (it takes a list)', () => {
  assert.ok(Array.isArray(LEAN) && LEAN.length > 0);
  const at = LEAN.indexOf("--tools");
  assert.equal(LEAN[at + 1], "");
  assert.ok(String(LEAN[at + 2]).startsWith("--"), "the next arg is a flag, so the variadic list ends");
  for (const args of [claude.args, claude.stream.args]) assert.ok(args.includes("{no_tools_args}"));
});

test("a no-tools run gets the lean flags, one-shot and streaming alike", () => {
  const prompt = applyToolPolicy("Say hello.", "none");
  assert.ok(prompt.startsWith(NO_TOOLS_PREAMBLE));
  assert.ok(hasLean(buildAgentLaunch(claude, claude.args, prompt).args));
  assert.ok(hasLean(buildAgentLaunch(claude, claude.stream.args, prompt).args));
  // An oversized prompt goes over stdin and keeps them.
  const huge = applyToolPolicy(`${"x".repeat(200 * 1024)}`, "none");
  const launch = buildAgentLaunch(claude, claude.args, huge);
  assert.equal(launch.via, "stdin");
  assert.ok(hasLean(launch.args));
});

test("provider tools, MCP servers or uploaded files keep the full toolset", () => {
  const research = applyToolPolicy("Find the latest evidence.", "provider");
  assert.equal(hasLean(buildAgentLaunch(claude, claude.args, research).args), false);

  const plain = applyToolPolicy("Say hello.", "none");
  const withMcp = buildAgentLaunch(claude, claude.args, plain, { mcpConfigArgs: ["--mcp-config", "{}"] });
  assert.equal(withMcp.args.includes("--tools"), false);

  const dataDir = path.resolve(process.env.DATA_DIR || "data");
  const withFile = applyToolPolicy(`Read ${path.join(dataDir, "uploads", "lab.pdf")} and summarize.`, "none");
  const launch = buildAgentLaunch(claude, claude.args, withFile);
  assert.equal(launch.args.includes("--tools"), false);
  assert.ok(launch.args.includes("--add-dir"));
});

test("an agent without lean flags is unchanged by the slot", () => {
  const def = { ...claude, no_tools_args: undefined };
  const args = buildAgentLaunch(def, def.args, applyToolPolicy("Say hello.", "none")).args;
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("{no_tools_args}"), false);
});
