// Cheap engineering-practice contracts for seams that used to drift:
// background job kind strings, Settings route metadata, route docs, and launch docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_JOB_KINDS } from "../dist/agentJobKinds.js";
import { listRoutableTasks, ROUTABLE_TASKS } from "../dist/repo/settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

function stringMatches(src, re) {
  return [...src.matchAll(re)].map((m) => m[1]);
}

test("background job kind contract covers API enqueue sites and worker handlers", () => {
  const api = read("src/api.ts");
  const jobs = read("src/agentJobs.ts");
  const apiKinds = new Set(stringMatches(api, /backgroundOp\(res,\s*"([^"]+)"/g));
  stringMatches(api, /createAgentJob\(\{\s*kind:\s*"([^"]+)"/g).forEach((kind) => apiKinds.add(kind));
  // /insights/generate chooses between these two with a local `kind` variable.
  apiKinds.add("insight");
  apiKinds.add("weekly_read");

  const handled = new Set(stringMatches(jobs, /case\s+"([^"]+)"/g));
  const canonical = new Set(AGENT_JOB_KINDS);
  assert.deepEqual([...canonical].sort(), AGENT_JOB_KINDS.slice().sort(), "AGENT_JOB_KINDS must not contain duplicates");
  for (const kind of apiKinds) assert.ok(canonical.has(kind), `${kind} is enqueued by API but missing from AGENT_JOB_KINDS`);
  for (const kind of handled) assert.ok(canonical.has(kind), `${kind} is handled by agentJobs but missing from AGENT_JOB_KINDS`);
  for (const kind of canonical) assert.ok(handled.has(kind), `${kind} is listed in AGENT_JOB_KINDS but not handled by agentJobs`);
});

test("route task metadata covers every routable task exactly once", () => {
  const tasks = [...ROUTABLE_TASKS];
  const labels = listRoutableTasks();
  assert.deepEqual(labels.map((r) => r.key).sort(), tasks.sort());
  for (const row of labels) {
    assert.equal(typeof row.label, "string");
    assert.ok(row.label.trim().length > 0, `${row.key} needs a Settings label`);
  }
});

test("MCP Settings exposes route metadata and derives task lists from contracts", () => {
  const mcp = read("src/mcp.ts");
  assert.match(mcp, /ROUTABLE_TASK_LIST\s*=\s*repo\.ROUTABLE_TASKS\.join/);
  assert.match(mcp, /AGENT_JOB_KIND_LIST\s*=\s*AGENT_JOB_KINDS\.join/);
  assert.match(mcp, /get_settings[\s\S]*route_tasks:\s*repo\.listRoutableTasks\(\)/);
  assert.match(mcp, /set_settings[\s\S]*route_tasks:\s*repo\.listRoutableTasks\(\)/);
});

test("generated API docs include mounted route modules", () => {
  const genDocs = read("scripts/gen-docs.mjs");
  const api = read("src/api.ts");
  assert.match(api, /api\.use\("\/health-docs",\s*healthDocsRouter\)/);
  assert.match(genDocs, /src\/routes\/health-docs\.ts/);
  assert.match(genDocs, /receiver:\s*"healthDocsRouter",\s*prefix:\s*"\/health-docs"/);
});

test("Settings route helper exposes stale-route pruning", () => {
  const helper = read("public/js/settings-routes.js");
  const boot = read("public/js/10-boot.js");
  const index = read("public/index.html");
  assert.match(helper, /function\s+settingsPruneRoutes/);
  assert.doesNotMatch(helper, /\bescHtml\b|\bescAttr\b/);
  assert.match(boot, /settingsPruneRoutes\(wm\.routes,\s*routeTasks,\s*enabledAgents\)/);
  assert.ok(
    index.indexOf('/js/settings-routes.js') > -1 &&
      index.indexOf('/js/settings-routes.js') < index.indexOf('/js/10-boot.js'),
    "settings-routes.js must load before 10-boot.js",
  );
});

test("app shell privacy contract avoids remote fonts and blanket inline scripts", () => {
  const index = read("public/index.html");
  const styles = read("public/styles.css");
  const server = read("src/server.ts");
  const design = read("docs/DESIGN.md");
  const publicJs = ["public/js/02-ui.js", "public/js/09-plan-chat.js"].map(read).join("\n");
  const scriptSources = server.match(/const scriptSources = \[([^\]]+)\]/)?.[1] || "";

  assert.doesNotMatch(`${index}\n${server}`, /fonts\.(?:googleapis|gstatic)\.com/);
  assert.doesNotMatch(index, /\sonload\s*=/i, "app shell must not need an inline font-loader handler");
  assert.doesNotMatch(publicJs, /\son(?:load|error)\s*=/i, "dynamic image templates must use delegated listeners");
  assert.doesNotMatch(styles, /Fraunces|Schibsted Grotesk/, "main CSS must not depend on Google font family names");
  assert.match(design, /does not load third-party fonts/i);
  assert.match(server, /"font-src 'self'; "/);
  assert.doesNotMatch(server, /unsafe-hashes/, "app shell should not need inline handler hashes");
  assert.doesNotMatch(scriptSources, /unsafe-inline/, "script-src sources must not allow every inline script");
  assert.match(server, /reportScriptCspHash\(\)/, "report inline script must be allowed by its exact hash");
});

test("service worker caches core assets strictly and optional assets best-effort", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /const\s+CORE_ASSETS\s*=/);
  assert.match(sw, /const\s+OPTIONAL_ASSETS\s*=/);
  assert.match(sw, /addAll\(CORE_ASSETS\)/);
  assert.match(sw, /OPTIONAL_ASSETS\.map[\s\S]*catch\(\(\)\s*=>\s*null\)/);
});

test("public docker run quickstarts bind loopback by default", () => {
  const blocks = ["README.md", "docs/QUICKSTART.md", "docs/SHARING.md"].flatMap((file) =>
    [...read(file).matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => ({ file, text: m[1] }))
  );
  const unsafe = blocks.filter((b) =>
    /\bdocker\s+run\b/.test(b.text) &&
    /(^|\s)-p\s+8787:8787(\s|\\|$)/.test(b.text) &&
    !/(^|\s)-p\s+127\.0\.0\.1:8787:8787(\s|\\|$)/.test(b.text)
  );
  assert.deepEqual(unsafe, []);
});

test("GitHub Actions workflows pin external actions to commit SHAs", () => {
  const pkg = JSON.parse(read("package.json"));
  const checker = read("scripts/check-action-pins.mjs");
  assert.match(pkg.scripts.verify, /npm run actions:check/);
  assert.match(checker, /--remote/);
  for (const file of [".github/workflows/ci.yml", ".github/workflows/release-image.yml"]) {
    assert.match(read(file), /npm run actions:check -- --remote/, `${file} must verify action tag drift in CI`);
    const refs = [...read(file).matchAll(/uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/g)];
    assert.ok(refs.length > 0, `${file} should use at least one external action`);
    for (const [, action, ref] of refs) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${file} must pin ${action} to a full commit SHA, not ${ref}`);
    }
  }
});
