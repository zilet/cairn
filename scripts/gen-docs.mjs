#!/usr/bin/env node
// Generate the API + MCP reference indexes straight from the source so they never
// drift. Run with `npm run docs:index`. Outputs docs/API.md and docs/MCP-TOOLS.md.
//
// This is a deliberately simple text scraper (no TS parser dependency): it reads
// src/api.ts / src/routes/* route registrations and src/mcp.ts server.tool()
// definitions. If a route/tool stops showing up, the registration shape changed
// — re-check here.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// `--check` (CI): regenerate in-memory and compare to what's committed instead of
// writing. Fails loudly if a contributor changed REST or MCP source without
// running `npm run docs:index`, so the reference indexes can't silently drift.
const CHECK = process.argv.includes("--check");
const stale = [];
function emit(relPath, content) {
  if (CHECK) {
    let current = "";
    try {
      current = readFileSync(join(root, relPath), "utf8");
    } catch {
      /* missing file counts as stale */
    }
    if (current !== content) stale.push(relPath);
    return;
  }
  writeFileSync(join(root, relPath), content);
}

// ---- API routes (src/api.ts + mounted route modules) ----
// Line-by-line so we can attach the immediately-preceding // comment block as a
// one-line description. Routes are `<router>.<method>("/path", …)`.
function parseApiRoutes(src, { receiver = "api", prefix = "" } = {}) {
  const lines = src.split("\n");
  const routeRe = new RegExp(`\\b${receiver}\\.(get|post|put|delete|patch)\\(\\s*["'\`]([^"'\`]+)["'\`]`);
  const out = [];
  let comment = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("//")) {
      const c = t.replace(/^\/\/\s?/, "");
      if (!/^[-=]{2,}/.test(c)) comment.push(c); // drop "---- section ----" dividers
      continue;
    }
    const m = routeRe.exec(line);
    if (m) {
      out.push({ method: m[1].toUpperCase(), path: `${prefix}${m[2] === "/" ? "" : m[2]}`, desc: comment.join(" ").trim() });
      comment = [];
      continue;
    }
    if (t === "") continue; // blank lines don't break a comment→route association
    comment = [];           // any other code line resets the pending comment
  }
  return out;
}

// ---- MCP tools (src/mcp.ts) ----
// server.tool("name", "description", …) — name + description are the first two
// double-quoted string args (descriptions may contain apostrophes / escaped quotes).
function parseMcpTools(src) {
  const re = /server\.tool\(\s*"([a-z0-9_]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/gi;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    out.push({ name: m[1], desc: m[2].replace(/\\"/g, '"').replace(/\s+/g, " ").trim() });
  }
  return out;
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");

// ---- API.md ----
const routes = [
  ...parseApiRoutes(read("src/api.ts")),
  ...parseApiRoutes(read("src/routes/health-docs.ts"), { receiver: "healthDocsRouter", prefix: "/health-docs" }),
];
const groups = new Map();
for (const r of routes) {
  const seg = r.path.split("/").filter(Boolean)[0] || "(root)";
  // Fold the .ics export under its base segment; otherwise keep the real name.
  const key = seg.replace(/\.ics$/, "");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const sortedKeys = [...groups.keys()].sort();
let api = `# Cairn REST API index

> Generated from \`src/api.ts\` and \`src/routes/*\` by \`scripts/gen-docs.mjs\` — run \`npm run docs:index\` to refresh. Do not edit by hand.

All routes are mounted under **\`/api\`** (e.g. \`GET /api/plan\`). When \`CAIRN_AUTH_TOKEN\`
is set, every route except \`GET /api/health\` requires the token (\`Authorization: Bearer …\`,
\`X-Cairn-Token: …\`, or \`?token=…\`). See [DEPLOYMENT.md](DEPLOYMENT.md) and [SANDBOX.md](SANDBOX.md).

**${routes.length} routes** across ${sortedKeys.length} groups.

`;
for (const k of sortedKeys) {
  const rs = groups.get(k).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  api += `## \`/${k}\`\n\n| Method | Path | Notes |\n|---|---|---|\n`;
  for (const r of rs) api += `| ${r.method} | \`/api${r.path}\` | ${esc(r.desc)} |\n`;
  api += `\n`;
}
api += `---\n\n*The MCP surface mirrors most of these operations — see [MCP-TOOLS.md](MCP-TOOLS.md).*\n`;
emit("docs/API.md", api);

// ---- MCP-TOOLS.md ----
const tools = parseMcpTools(read("src/mcp.ts")).sort((a, b) => a.name.localeCompare(b.name));
let mcp = `# Cairn MCP tool index

> Generated from \`src/mcp.ts\` by \`scripts/gen-docs.mjs\` — run \`npm run docs:index\` to refresh. Do not edit by hand.

Cairn serves an MCP server at **\`/mcp\`** (Streamable HTTP). These tools are thin
wrappers over the same \`src/repo.ts\` layer the REST API uses. When \`CAIRN_AUTH_TOKEN\`
is set, \`/mcp\` requires the token (\`Authorization: Bearer …\`).

**${tools.length} tools.**

| Tool | Description |
|---|---|
`;
for (const t of tools) mcp += `| \`${t.name}\` | ${esc(t.desc)} |\n`;
mcp += `\n---\n\n*The REST surface mirrors most of these — see [API.md](API.md).*\n`;
emit("docs/MCP-TOOLS.md", mcp);

if (CHECK) {
  if (stale.length) {
    console.error(`✗ generated docs are stale: ${stale.join(", ")}`);
    console.error("  REST or MCP source changed — run `npm run docs:index` and commit the result.");
    process.exit(1);
  }
  console.log(`✓ generated docs in sync (${routes.length} routes, ${tools.length} tools)`);
} else {
  console.log(`docs/API.md: ${routes.length} routes in ${sortedKeys.length} groups`);
  console.log(`docs/MCP-TOOLS.md: ${tools.length} tools`);
}
