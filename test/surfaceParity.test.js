// Surface parity — the two protocol surfaces (src/api.ts REST + src/mcp.ts MCP) are
// both thin adapters over the same src/repo.ts. The most common drift in this design
// is adding a capability to one surface and forgetting the other.
//
// docs:check already locks BOTH generated indexes (docs/API.md, docs/MCP-TOOLS.md) to
// source, so an asymmetry shows up in a PR diff. This test adds the one ENFORCEABLE,
// low-maintenance invariant on top: every MCP tool must correspond to a REST resource
// (MCP ⊆ REST). The reverse isn't asserted — REST legitimately has more (file streams,
// SSE, export, health, binary art), and pinning that would need a large, brittle
// exceptions list. So we gate the clean direction and just REPORT the rest.
//
// Pure/offline: parses the two source files as text (same shapes as scripts/gen-docs.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// Normalize a path segment / noun to a comparable token: drop separators, lowercase,
// and singularize (activities→activity, meal-plans→mealplan, bodies→body).
function norm(s) {
  const t = s.replace(/[-_]/g, "").toLowerCase();
  if (t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.endsWith("sses")) return t.slice(0, -2); // addresses→address (n/a today, future-proof)
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

// Every non-:param segment of every REST route, normalized — the resource vocabulary.
function restResourceTokens() {
  const src = read("src/api.ts");
  const re = /\bapi\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;
  const tokens = new Set();
  let m;
  while ((m = re.exec(src))) {
    for (const seg of m[2].split("/")) {
      if (seg && !seg.startsWith(":")) tokens.add(norm(seg.replace(/\.ics$/, "")));
    }
  }
  return tokens;
}

function mcpToolNames() {
  const src = read("src/mcp.ts");
  const re = /server\.tool\(\s*"([a-z0-9_]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// Leading verbs a tool name carries that aren't part of the resource noun.
const VERBS = new Set([
  "get", "list", "add", "set", "update", "delete", "log", "draft", "reconcile", "consolidate",
  "grow", "reset", "record", "swap", "derive", "generate", "onboard", "suggest", "clear",
  "archive", "supersede", "understand", "upsert", "skip", "finish", "reopen",
]);

// Candidate resource tokens for a tool — generous on purpose (we only want to catch a
// tool whose resource is ENTIRELY ABSENT from REST, not police exact naming): every
// single token, every prefix-join, and the full join — both with and without a leading
// verb stripped — all normalized.
function toolCandidates(tool) {
  const all = tool.split("_");
  const stripped = VERBS.has(all[0]) ? all.slice(1) : all;
  const cands = new Set();
  for (const list of [all, stripped]) {
    if (!list.length) continue;
    cands.add(norm(list.join("")));
    for (const tok of list) cands.add(norm(tok));
    for (let k = 1; k <= list.length; k++) cands.add(norm(list.slice(0, k).join("")));
  }
  return [...cands];
}

// The only MCP noun that legitimately differs from its REST route segment.
const ALIAS = { weight: "bodyweight" }; // log_weight / list_weight ↔ /bodyweight

test("every MCP tool maps to a REST resource (MCP ⊆ REST — surfaces stay in sync)", () => {
  const routeTokens = restResourceTokens();
  const tools = mcpToolNames();
  assert.ok(tools.length > 100, `expected the full MCP tool set, got ${tools.length}`);

  const orphans = [];
  for (const tool of tools) {
    const cands = toolCandidates(tool);
    const aliased = cands.some((c) => ALIAS[c] && routeTokens.has(norm(ALIAS[c])));
    const matched = aliased || cands.some((c) => routeTokens.has(c));
    if (!matched) orphans.push(tool);
  }

  assert.deepEqual(
    orphans,
    [],
    `MCP tool(s) with no REST counterpart — wire the REST route in src/api.ts, or if the ` +
      `tool's resource is named differently from its route add an ALIAS in test/surfaceParity.test.js:\n  ` +
      orphans.join("\n  "),
  );
});

test("the ALIAS map has no dead entries (every alias target is a real REST resource)", () => {
  const routeTokens = restResourceTokens();
  for (const [from, to] of Object.entries(ALIAS)) {
    assert.ok(routeTokens.has(norm(to)), `ALIAS ${from}→${to}: "${to}" is not a REST resource anymore — prune it`);
  }
});
