// Cheap engineering-practice contracts for seams that used to drift:
// background job kind strings, Settings route metadata, route docs, and launch docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLES, CLIENT_OUTPUTS } from "../scripts/build-client.mjs";
import { AGENT_JOB_KINDS } from "../dist/agentJobKinds.js";
import {
  CHAT_ACTION_PROMPT_SPECS,
  CHAT_ACTION_TYPES,
  chatActionPromptSpecs,
  draftChatActionTypes,
  immediateChatActionTypes,
  renderChatActionPromptProse,
  renderChatActionSchema,
} from "../dist/chatActions.js";
import {
  CLIENT_API_BROAD_RESPONSE_WAIVERS,
  CLIENT_API_CONTRACT_PATHS,
  CLIENT_API_UNKNOWN_WAIVERS,
  CLIENT_ROUTE_DEFINITIONS,
} from "../dist/contracts/client.js";
import { listRoutableTasks, ROUTABLE_TASKS } from "../dist/repo/settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

// The canonical browser boot order, derived from the bundle manifest — the single
// source of truth now that index.html loads a handful of concatenated bundles
// instead of ~216 individual <script>s. Flattening every bundle's constituents in
// load order reproduces the exact pre-bundle <script> sequence, so load-order
// contracts assert positions here (bootPos) rather than scanning index.html.
const BOOT_ORDER = BUNDLES.flatMap((bundle) => bundle.inputs).map((file) => `/${file.replace(/^public\//, "")}`);
const bootPos = (assetUrl) => BOOT_ORDER.indexOf(assetUrl);

function stringMatches(src, re) {
  return [...src.matchAll(re)].map((m) => m[1]);
}

function escapeRegExp(src) {
  return src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contractPatternToRegExp(pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/:[A-Za-z0-9_]+/g, "[^/]+")}$`);
}

function segmentKeys(src, name) {
  const start = src.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} segment registry should be declared`);
  const end = src.indexOf("];", start);
  const block = end >= 0 ? src.slice(start, end + 2) : src.split("\n").find((row) => row.includes(`const ${name}`)) || "";
  return [...block.matchAll(/\["([^"]+)",\s*"[^"]+"\]/g)].map((m) => m[1]);
}

function objectKeys(src, name) {
  const start = src.indexOf(`const ${name}`);
  assert.ok(start >= 0, `${name} object registry should be declared`);
  const end = src.indexOf("};", start);
  const block = end >= 0 ? src.slice(start, end + 2) : src.split("\n").find((row) => row.includes(`const ${name}`)) || "";
  return [...block.matchAll(/\b([A-Za-z0-9_]+):\s*\(\)\s*=>/g)].map((m) => m[1]);
}

function assertSameMembers(actual, expected, message) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

function normalizeApiCallPath(raw) {
  const withoutTemplateExpressions = raw.replace(/\$\{[^}]*\}/g, ":param");
  const withoutQuery = withoutTemplateExpressions.split("?")[0].trim();
  if (!withoutQuery.startsWith("/")) return null;
  return withoutQuery.endsWith("/") ? `${withoutQuery}:param` : withoutQuery;
}

function sourceFilesUnder(dir, exts) {
  const abs = path.join(root, dir);
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFilesUnder(rel, exts);
    return exts.some((ext) => entry.name.endsWith(ext)) ? [rel] : [];
  });
}

function stripLineComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function apiCallPathsForFile(file) {
  const src = stripLineComments(read(file));
  const direct = [...src.matchAll(/\b(?:api|cachedApi|enqueueJob)\(\s*(["'`])([\s\S]*?)\1/g)]
    .map((match) => normalizeApiCallPath(match[2]));
  const staticPathOptions = [...src.matchAll(/\bpath:\s*(["'`])([\s\S]*?)\1/g)]
    .map((match) => normalizeApiCallPath(match[2]));
  return [...direct, ...staticPathOptions]
    .filter(Boolean)
    .map((apiPath) => ({ file, path: apiPath }));
}

function clientApiCallPaths() {
  const sourceFiles = sourceFilesUnder("src/client", [".ts"]);
  const publicFiles = sourceFilesUnder("public/js", [".js"]);
  return [...sourceFiles, ...publicFiles].flatMap(apiCallPathsForFile);
}

function broadExactApiResponses(contractSource) {
  const start = contractSource.indexOf("export interface ClientApiResponses {");
  const end = contractSource.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, "ClientApiResponses interface should be present");
  const body = contractSource.slice(start, end);
  return [...body.matchAll(/"\/api([^"]+)":\s*([^;]+);/g)]
    .map((match) => ({ pattern: match[1], response: match[2].trim() }))
    .filter((entry) => /\bClientJson(?:Object|Array)\b/.test(entry.response));
}

test("client build manifest owns generated browser outputs and cache wiring", () => {
  const index = read("public/index.html");
  const sw = read("public/sw.js");
  const manifestOutputs = new Set(CLIENT_OUTPUTS.map((item) => item.output));
  assert.equal(manifestOutputs.size, CLIENT_OUTPUTS.length, "CLIENT_OUTPUTS must not contain duplicate outputs");

  // The hand-written classic shim isn't a transpiled CLIENT_OUTPUT, but it is a
  // real constituent the bundles must carry.
  const handwrittenClassicScripts = new Set(["public/js/10-boot.js"]);
  // Generated CLASSIC scripts that live at the public root and load BEFORE the
  // bundles (the art/figure library pattern): direct <script> in index.html,
  // precached individually, never bundled.
  const rootClassicOutputs = new Set(["public/cairn-body-figure.js"]);
  const bundleOutputs = new Set(BUNDLES.map((bundle) => bundle.output));
  const publicScripts = readdirSync(path.join(root, "public/js"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => `public/js/${file}`);

  for (const item of CLIENT_OUTPUTS) {
    assert.ok(item.source.startsWith("src/client/"), `${item.source} should be a client TypeScript source`);
    assert.ok(item.source.endsWith(".ts"), `${item.source} should be a TypeScript source`);
    assert.ok(
      item.output.startsWith("public/js/") || rootClassicOutputs.has(item.output),
      `${item.output} should emit into public/js (or be a declared root classic script)`
    );
    assert.ok(item.output.endsWith(".js"), `${item.output} should be a served JavaScript output`);
    assert.ok(existsSync(path.join(root, item.source)), `${item.source} listed in CLIENT_OUTPUTS does not exist`);
    assert.ok(existsSync(path.join(root, item.output)), `${item.output} listed in CLIENT_OUTPUTS does not exist`);

    const generatedOutput = read(item.output);
    assert.ok(
      generatedOutput.startsWith("(() => {\n") && generatedOutput.endsWith("\n})();\n"),
      `${item.output} must be locally scoped so classic script reloads cannot redeclare top-level bindings`
    );

    // Individual modules are no longer loaded directly — they ship inside a bundle.
    const url = `/${item.output.replace(/^public\//, "")}`;
    // All script tags are `defer` (parse/first-paint isn't blocked on ~1.5MB of
    // JS) — defer preserves document-order execution across every deferred
    // script, root classics included, so this is still the exact same boot order.
    if (rootClassicOutputs.has(item.output)) {
      assert.ok(
        index.includes(`<script src="${url}" defer></script>`),
        `${url} is a root classic script — index.html must load it directly (deferred), before the bundles`
      );
    } else {
      assert.ok(
        !index.includes(`<script src="${url}" defer></script>`) && !index.includes(`<script src="${url}"></script>`),
        `${url} must not be <script>-loaded directly by index.html; it belongs to a bundle`
      );
    }
  }

  // Every constituent (each CLIENT_OUTPUT plus the hand-written shim) lands in
  // EXACTLY ONE bundle, and bundles introduce nothing else.
  const expectedConstituents = [...manifestOutputs, ...handwrittenClassicScripts]
    .filter((output) => !rootClassicOutputs.has(output))
    .sort();
  const allInputs = BUNDLES.flatMap((bundle) => bundle.inputs);
  assert.equal(new Set(allInputs).size, allInputs.length, "no module may appear in more than one bundle");
  assert.deepEqual(
    [...allInputs].sort(),
    expectedConstituents,
    "bundles must partition exactly the generated outputs plus the hand-written classic shim"
  );

  // The flattened bundle order reproduces the canonical boot order, and both the
  // index.html <script> graph and the sw precache load the bundles in manifest order.
  const bundleUrls = BUNDLES.map((bundle) => `/${bundle.output.replace(/^public\//, "")}`);
  const indexScripts = [...index.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  const indexBundleScripts = indexScripts.filter((src) => src.startsWith("/js/"));
  assert.deepEqual(indexBundleScripts, bundleUrls, "index.html must load every bundle in manifest order and nothing else under /js");
  const swBundleScripts = [...sw.matchAll(/"(\/js\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(swBundleScripts, bundleUrls, "sw.js CORE_ASSETS must precache every bundle in manifest order and nothing else under /js");
  for (const bundle of BUNDLES) {
    assert.ok(existsSync(path.join(root, bundle.output)), `${bundle.output} bundle must exist on disk`);
  }

  const unownedPublicScripts = publicScripts.filter(
    (file) => !manifestOutputs.has(file) && !handwrittenClassicScripts.has(file) && !bundleOutputs.has(file)
  );
  assert.deepEqual(unownedPublicScripts, [], "public/js scripts must be generated, bundled, or explicitly classified");
});

test("the 2D body figure is the one true Stand figure — no 3D remnants", () => {
  // A WebGL body experiment was retired in favor of the elite 2D figure —
  // nothing may quietly reintroduce a Three/WebGL body path.
  const bodyMetricsSource = read("src/client/body-metrics-client.ts");
  assert.match(bodyMetricsSource, /class="bm-figure-fallback"/, "2D body figure remains the Stand first paint");
  assert.doesNotMatch(bodyMetricsSource, /Body3D|body-3d|bm-body3d/, "no 3D promotion wiring in body metrics");
  const sources = BUNDLES.flatMap((bundle) => bundle.inputs);
  assert.ok(!sources.some((s) => s.includes("body-3d")), "no body-3d module in any bundle");
});

test("background job kind contract covers API enqueue sites and worker handlers", () => {
  const api = [
    "src/api.ts",
    "src/routes/connected-brain.ts",
    "src/routes/day-coach.ts",
    "src/routes/memory-learning.ts",
    "src/routes/nutrition.ts",
    "src/routes/program.ts",
  ]
    .map(read)
    .join("\n");
  const jobs = read("src/agentJobs.ts");
  const apiKinds = new Set(stringMatches(api, /backgroundOp\(res,\s*"([^"]+)"/g));
  stringMatches(api, /createAgentJob\(\{\s*kind:\s*"([^"]+)"/g).forEach((kind) => apiKinds.add(kind));
  // /insights/generate chooses between these two with a local `kind` variable.
  apiKinds.add("insight");
  apiKinds.add("weekly_read");

  const handled = new Set(stringMatches(jobs, /case\s+"([^"]+)"/g));
  const canonical = new Set(AGENT_JOB_KINDS);
  assert.deepEqual(
    [...canonical].sort(),
    AGENT_JOB_KINDS.slice().sort(),
    "AGENT_JOB_KINDS must not contain duplicates"
  );
  for (const kind of apiKinds)
    assert.ok(canonical.has(kind), `${kind} is enqueued by API but missing from AGENT_JOB_KINDS`);
  for (const kind of handled)
    assert.ok(canonical.has(kind), `${kind} is handled by agentJobs but missing from AGENT_JOB_KINDS`);
  for (const kind of canonical)
    assert.ok(handled.has(kind), `${kind} is listed in AGENT_JOB_KINDS but not handled by agentJobs`);
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
  const operatorTools = read("src/surfaces/mcp/operator.ts");
  assert.match(operatorTools, /ROUTABLE_TASKS[\s\S]*from "\.\.\/\.\.\/domain\/operator\/index\.js"/);
  assert.match(operatorTools, /ROUTABLE_TASK_LIST\s*=\s*ROUTABLE_TASKS\.join/);
  assert.match(operatorTools, /AGENT_JOB_KIND_LIST\s*=\s*AGENT_JOB_KINDS\.join/);
  assert.match(operatorTools, /get_settings[\s\S]*route_tasks:\s*listRoutableTasks\(\)/);
  assert.match(operatorTools, /set_settings[\s\S]*route_tasks:\s*listRoutableTasks\(\)/);
});

test("MCP modular tool sources are discovered without duplicate names", () => {
  const mcp = read("src/mcp.ts");
  const chatTools = read("src/surfaces/mcp/chat.ts");
  const connectedBrainTools = read("src/surfaces/mcp/connected-brain.ts");
  const dailyDriverTools = read("src/surfaces/mcp/daily-driver.ts");
  const dayCoachTools = read("src/surfaces/mcp/day-coach.ts");
  const garminTools = read("src/surfaces/mcp/garmin.ts");
  const healthMetricsTools = read("src/surfaces/mcp/health-metrics.ts");
  const healthRecordTools = read("src/surfaces/mcp/health-records.ts");
  const memoryLearningTools = read("src/surfaces/mcp/memory-learning.ts");
  const nutritionTools = read("src/surfaces/mcp/nutrition.ts");
  const operatorTools = read("src/surfaces/mcp/operator.ts");
  const personTools = read("src/surfaces/mcp/person.ts");
  const personContextTools = read("src/surfaces/mcp/person-context.ts");
  const planExerciseTools = read("src/surfaces/mcp/plan-exercises.ts");
  const programTools = read("src/surfaces/mcp/program.ts");
  const systemTools = read("src/surfaces/mcp/system.ts");
  const trainingLogTools = read("src/surfaces/mcp/training-log.ts");
  const trainingStatusTools = read("src/surfaces/mcp/training-status.ts");
  const genDocs = read("scripts/gen-docs.mjs");
  const parity = read("test/surfaceParity.test.js");
  const mcpSources = [
    mcp,
    chatTools,
    connectedBrainTools,
    dailyDriverTools,
    dayCoachTools,
    garminTools,
    healthMetricsTools,
    healthRecordTools,
    memoryLearningTools,
    nutritionTools,
    operatorTools,
    personTools,
    personContextTools,
    planExerciseTools,
    programTools,
    systemTools,
    trainingLogTools,
    trainingStatusTools,
  ];
  const tools = mcpSources.flatMap((src) => stringMatches(src, /server\.tool\(\s*"([a-z0-9_]+)"/g));

  assert.match(mcp, /registerSystemTools\(server\)/);
  assert.match(mcp, /registerChatTools\(server\)/);
  assert.match(mcp, /registerConnectedBrainTools\(server\)/);
  assert.match(mcp, /registerDailyDriverTools\(server\)/);
  assert.match(mcp, /registerDayCoachTools\(server\)/);
  assert.match(mcp, /registerGarminTools\(server\)/);
  assert.match(mcp, /registerHealthMetricsTools\(server\)/);
  assert.match(mcp, /registerHealthRecordTools\(server\)/);
  assert.match(mcp, /registerMemoryLearningTools\(server\)/);
  assert.match(mcp, /registerNutritionTools\(server\)/);
  assert.match(mcp, /registerOperatorTools\(server\)/);
  assert.match(mcp, /registerPersonTools\(server\)/);
  assert.match(mcp, /registerPersonContextTools\(server\)/);
  assert.match(mcp, /registerPlanExerciseTools\(server\)/);
  assert.match(mcp, /registerProgramTools\(server\)/);
  assert.match(mcp, /registerTrainingLogTools\(server\)/);
  assert.match(mcp, /registerTrainingStatusTools\(server\)/);
  assert.match(genDocs, /src\/surfaces\/mcp\/chat\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/chat\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/connected-brain\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/connected-brain\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/daily-driver\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/daily-driver\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/day-coach\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/day-coach\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/garmin\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/garmin\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/health-metrics\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/health-metrics\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/health-records\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/health-records\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/memory-learning\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/memory-learning\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/nutrition\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/nutrition\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/operator\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/operator\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/person\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/person\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/person-context\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/person-context\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/plan-exercises\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/plan-exercises\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/program\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/program\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/system\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/system\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/training-log\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/training-log\.ts/);
  assert.match(genDocs, /src\/surfaces\/mcp\/training-status\.ts/);
  assert.match(parity, /src\/surfaces\/mcp\/training-status\.ts/);
  assert.equal(tools.length, 197, "tool count should stay stable while modularizing MCP");
  assert.equal(new Set(tools).size, tools.length, "MCP tool names must be unique across modules");
  assert.doesNotMatch(mcp, /server\.tool\(/, "src/mcp.ts should stay a registry, not a tool-definition file");
  assert.doesNotMatch(mcp, /server\.tool\("get_chat_history"/);
  assert.doesNotMatch(mcp, /server\.tool\("reset_chat"/);
  assert.match(chatTools, /server\.tool\(\s*"get_chat_history"/);
  assert.match(chatTools, /server\.tool\(\s*"reset_chat"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_health_markers"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_cardiovascular_risk"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_doctor_loop"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_doctor_packet"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_health_outcomes"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_coaching_focus"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"research"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_outcome_learnings"/);
  assert.match(dailyDriverTools, /server\.tool\(\s*"get_today_agenda"/);
  assert.match(dailyDriverTools, /server\.tool\(\s*"get_guidelines"/);
  assert.match(dailyDriverTools, /server\.tool\(\s*"generate_insight"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_day_read"/);
  assert.doesNotMatch(mcp, /server\.tool\("suggest_session"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_week_ahead"/);
  assert.match(dayCoachTools, /server\.tool\(\s*"get_day_read"/);
  assert.match(dayCoachTools, /server\.tool\(\s*"suggest_session"/);
  assert.match(dayCoachTools, /server\.tool\(\s*"get_week_ahead"/);
  assert.doesNotMatch(mcp, /server\.tool\("sync_garmin"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_recovery"/);
  assert.match(garminTools, /server\.tool\(\s*"sync_garmin"/);
  assert.match(garminTools, /server\.tool\(\s*"reconcile_garmin_strength"/);
  assert.match(garminTools, /await import\("\.\.\/\.\.\/garmin\.js"\)/);
  assert.match(garminTools, /await import\("\.\.\/\.\.\/enrich\.js"\)/);
  assert.match(healthMetricsTools, /server\.tool\(\s*"get_recovery"/);
  assert.match(healthRecordTools, /server\.tool\(\s*"list_health_records"/);
  assert.match(healthRecordTools, /server\.tool\(\s*"add_health_record"/);
  assert.doesNotMatch(mcp, /server\.tool\("add_memory"/);
  assert.doesNotMatch(mcp, /server\.tool\("consolidate_memory"/);
  assert.doesNotMatch(mcp, /server\.tool\("reconcile_outcomes"/);
  assert.match(memoryLearningTools, /server\.tool\(\s*"add_memory"/);
  assert.match(memoryLearningTools, /server\.tool\(\s*"consolidate_memory"/);
  assert.match(memoryLearningTools, /server\.tool\(\s*"reconcile_outcomes"/);
  assert.doesNotMatch(mcp, /server\.tool\("draft_meal_plan"/);
  assert.doesNotMatch(mcp, /server\.tool\("nutrition_checkin"/);
  assert.doesNotMatch(mcp, /server\.tool\("update_food_note"/);
  assert.match(nutritionTools, /server\.tool\(\s*"draft_meal_plan"/);
  assert.match(nutritionTools, /server\.tool\(\s*"get_frequent_foods"/);
  assert.match(nutritionTools, /server\.tool\(\s*"nutrition_checkin"/);
  assert.match(nutritionTools, /server\.tool\(\s*"update_food_note"/);
  assert.doesNotMatch(mcp, /server\.tool\("list_agents"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_settings"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_agent_stats"/);
  assert.match(operatorTools, /server\.tool\(\s*"list_agents"/);
  assert.match(operatorTools, /server\.tool\(\s*"get_settings"/);
  assert.match(operatorTools, /server\.tool\(\s*"get_agent_stats"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_profile"/);
  assert.doesNotMatch(mcp, /server\.tool\("log_blood_pressure"/);
  assert.doesNotMatch(mcp, /server\.tool\("record_daily_metrics"/);
  assert.match(personTools, /server\.tool\(\s*"get_profile"/);
  assert.match(personTools, /server\.tool\(\s*"log_blood_pressure"/);
  assert.match(personTools, /server\.tool\(\s*"record_daily_metrics"/);
  assert.doesNotMatch(mcp, /server\.tool\("add_context_event"/);
  assert.doesNotMatch(mcp, /server\.tool\("list_family"/);
  assert.doesNotMatch(mcp, /server\.tool\("understand_supplements"/);
  assert.doesNotMatch(mcp, /server\.tool\("onboard"/);
  assert.match(personContextTools, /server\.tool\(\s*"add_context_event"/);
  assert.match(personContextTools, /server\.tool\(\s*"list_family"/);
  assert.match(personContextTools, /server\.tool\(\s*"understand_supplements"/);
  assert.match(personContextTools, /server\.tool\(\s*"onboard"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_update_status"/);
  assert.doesNotMatch(mcp, /server\.tool\("check_for_update"/);
  assert.match(systemTools, /server\.tool\("get_update_status"/);
  assert.match(systemTools, /server\.tool\("check_for_update"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_plan"/);
  assert.doesNotMatch(mcp, /server\.tool\("save_plan_day"/);
  assert.doesNotMatch(mcp, /server\.tool\("list_exercises"/);
  assert.doesNotMatch(mcp, /server\.tool\("reconcile_exercise_names"/);
  assert.match(planExerciseTools, /server\.tool\(\s*"get_plan"/);
  assert.match(planExerciseTools, /server\.tool\(\s*"save_plan_day"/);
  assert.match(planExerciseTools, /server\.tool\(\s*"list_exercises"/);
  assert.match(planExerciseTools, /server\.tool\(\s*"reconcile_exercise_names"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_program_state"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_progression"/);
  assert.doesNotMatch(mcp, /server\.tool\("apply_run_plan"/);
  assert.doesNotMatch(mcp, /server\.tool\("list_proposals"/);
  assert.match(programTools, /server\.tool\(\s*"get_program_state"/);
  assert.match(programTools, /server\.tool\(\s*"get_progression"/);
  assert.match(programTools, /server\.tool\(\s*"apply_run_plan"/);
  assert.match(programTools, /server\.tool\(\s*"list_proposals"/);
  assert.doesNotMatch(mcp, /server\.tool\("log_set"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_progress"/);
  assert.doesNotMatch(mcp, /server\.tool\("log_activity"/);
  assert.doesNotMatch(mcp, /server\.tool\("set_session_feedback"/);
  assert.match(trainingLogTools, /server\.tool\(\s*"log_set"/);
  assert.match(trainingLogTools, /server\.tool\(\s*"get_progress"/);
  assert.match(trainingLogTools, /server\.tool\(\s*"log_activity"/);
  assert.match(trainingLogTools, /server\.tool\(\s*"set_session_feedback"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_weekly_stats"/);
  assert.doesNotMatch(mcp, /server\.tool\("get_endurance_prs"/);
  assert.doesNotMatch(mcp, /server\.tool\("set_endurance_goal"/);
  assert.match(trainingStatusTools, /server\.tool\(\s*"get_weekly_stats"/);
  assert.match(trainingStatusTools, /server\.tool\(\s*"get_endurance_prs"/);
  assert.match(trainingStatusTools, /server\.tool\(\s*"set_endurance_goal"/);
});

test("generated API docs include mounted route modules", () => {
  const genDocs = read("scripts/gen-docs.mjs");
  const api = read("src/api.ts");
  const agentJobRoutes = read("src/routes/agent-jobs.ts");
  const artRoutes = read("src/routes/art.ts");
  const chatRoutes = read("src/routes/chat.ts");
  const connectedBrainRoutes = read("src/routes/connected-brain.ts");
  const dayCoachRoutes = read("src/routes/day-coach.ts");
  const dayReadUseCase = read("src/domain/brain/day-read-use-case.ts");
  const exportRoutes = read("src/routes/exports.ts");
  const garminRoutes = read("src/routes/garmin.ts");
  const healthMetricsRoutes = read("src/routes/health-metrics.ts");
  const memoryLearningRoutes = read("src/routes/memory-learning.ts");
  const nutritionRoutes = read("src/routes/nutrition.ts");
  const operatorRoutes = read("src/routes/operator.ts");
  const personContextRoutes = read("src/routes/person-context.ts");
  const personRoutes = read("src/routes/person.ts");
  const planExerciseRoutes = read("src/routes/plan-exercises.ts");
  const programRoutes = read("src/routes/program.ts");
  const systemRoutes = read("src/routes/system.ts");
  const trainingLogRoutes = read("src/routes/training-log.ts");
  const parity = read("test/surfaceParity.test.js");
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\(/, "src/api.ts should stay a mount-only registry");
  assert.match(api, /api\.use\("\/chat",\s*chatRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/chat(?:\/|")/);
  assert.match(chatRoutes, /chatRouter\.post\("\/"/);
  assert.match(chatRoutes, /chatRouter\.get\("\/turns"/);
  assert.match(api, /api\.use\("\/",\s*connectedBrainRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:health(?:\/|")|markers(?:\/|")|reaction-model"|trajectory"|context-effect"|next-step(?:\/|")|coaching-focus"|directives(?:\/|")|symptom-links"|research"|evidence(?:\/|")|insights(?:\/|"))/
  );
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.get\("\/health\/markers"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.post\("\/health\/review"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.post\("\/health\/synthesis"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.post\("\/markers\/reconcile"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.post\("\/directives\/derive"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.get\("\/research"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.post\("\/research"/);
  assert.match(connectedBrainRoutes, /connectedBrainRouter\.post\("\/insights\/generate"/);
  assert.match(connectedBrainRoutes, /backgroundOp\(res,\s*"health_review"/);
  assert.match(connectedBrainRoutes, /backgroundOp\(res,\s*"health_synthesis"/);
  assert.match(connectedBrainRoutes, /backgroundOp\(res,\s*kind/);
  assert.match(connectedBrainRoutes, /reconcileMarkers/);
  assert.match(connectedBrainRoutes, /getEvidence\(\{\s*topic,\s*marker\s*\}\)/);
  assert.match(connectedBrainRoutes, /runResearch/);
  assert.match(connectedBrainRoutes, /addMemory\(text,\s*"insight",\s*"insight-feedback"\)/);
  assert.match(api, /api\.use\("\/",\s*dayCoachRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/(?:today-read(?:\/|")|session-suggest"|week-ahead")/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.get\("\/today-read"/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.post\("\/today-read\/reshape"/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.post\("\/session-suggest"/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.get\("\/week-ahead"/);
  assert.match(dayCoachRoutes, /readToday\(\{\s*date,\s*override,\s*agent:\s*agentParam,\s*reset,\s*recordOutcome:\s*true\s*\}\)/);
  assert.match(dayReadUseCase, /recordDayReadSuggestion/);
  assert.match(dayReadUseCase, /getCachedDayRead/);
  assert.match(dayCoachRoutes, /backgroundOp\(res,\s*"session_suggest"/);
  assert.match(dayCoachRoutes, /createAgentJob\(\{\s*kind:\s*"day_read_override"/);
  assert.match(api, /api\.use\("\/agent-jobs",\s*agentJobsRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/agent-jobs(?:\/|")/);
  assert.match(agentJobRoutes, /agentJobsRouter\.get\("\/"/);
  assert.match(agentJobRoutes, /agentJobsRouter\.get\("\/:id\/stream"/);
  assert.match(api, /api\.use\("\/",\s*artRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/art(?:\/|")/);
  assert.match(artRoutes, /artRouter\.get\("\/art"/);
  assert.match(artRoutes, /artRouter\.post\("\/art\/warm"/);
  assert.match(artRoutes, /artRouter\.get\("\/art\/manifest"/);
  assert.match(api, /api\.use\("\/",\s*operatorRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:agents(?:\/|")|agent-clis\/update|settings"|agent-stats")/
  );
  assert.match(operatorRoutes, /operatorRouter\.get\("\/agents"/);
  assert.match(operatorRoutes, /operatorRouter\.put\("\/settings"/);
  assert.match(operatorRoutes, /operatorRouter\.get\("\/agent-stats"/);
  assert.match(api, /api\.use\("\/",\s*personContextRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:context-events(?:\/|")|injury-impacts"|family(?:\/|")|supplements(?:\/|")|onboard")/
  );
  assert.match(personContextRoutes, /personContextRouter\.get\("\/context-events"/);
  assert.match(personContextRoutes, /personContextRouter\.get\("\/injury-impacts"/);
  assert.match(personContextRoutes, /personContextRouter\.get\("\/family"/);
  assert.match(personContextRoutes, /personContextRouter\.post\("\/supplements\/understand"/);
  assert.match(personContextRoutes, /personContextRouter\.post\("\/onboard"/);
  assert.match(personContextRoutes, /onboardFromText/);
  assert.match(api, /api\.use\("\/",\s*garminRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/garmin(?:\/|")/);
  assert.match(garminRoutes, /garminRouter\.post\("\/garmin\/sync"/);
  assert.match(garminRoutes, /await import\("\.\.\/garmin\.js"\)/);
  assert.match(garminRoutes, /await import\("\.\.\/enrich\.js"\)/);
  assert.match(api, /api\.use\("\/",\s*exportsRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:export(?:\/|")|health-export"|health-report(?:\.txt)?")/
  );
  assert.match(exportRoutes, /exportsRouter\.get\("\/export"/);
  assert.match(exportRoutes, /exportsRouter\.get\("\/health-report\.txt"/);
  assert.match(exportRoutes, /fs\.rm\(tmp,\s*\{\s*force:\s*true\s*\}/);
  assert.match(api, /api\.use\("\/",\s*healthMetricsRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/(?:health-metrics|recovery)(?:\/|")/);
  assert.match(healthMetricsRoutes, /healthMetricsRouter\.post\("\/health-metrics"/);
  assert.match(healthMetricsRoutes, /\.slice\(0,\s*366\)/);
  assert.match(healthMetricsRoutes, /healthMetricsRouter\.get\("\/recovery"/);
  assert.match(api, /api\.use\("\/",\s*memoryLearningRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:memory(?:\/|")|profile\/grow-about-me"|suggestions(?:\/|")|learnings")/
  );
  assert.match(memoryLearningRoutes, /memoryLearningRouter\.get\("\/memory"/);
  assert.match(memoryLearningRoutes, /memoryLearningRouter\.post\("\/memory\/consolidate"/);
  assert.match(memoryLearningRoutes, /memoryLearningRouter\.post\("\/profile\/grow-about-me"/);
  assert.match(memoryLearningRoutes, /memoryLearningRouter\.post\("\/suggestions\/reconcile"/);
  assert.match(memoryLearningRoutes, /memoryLearningRouter\.get\("\/learnings"/);
  assert.match(memoryLearningRoutes, /consolidateMemory/);
  assert.match(memoryLearningRoutes, /reconcileOutcomes/);
  assert.match(api, /api\.use\("\/",\s*nutritionRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:coach\/mealplan|mealplans(?:\/|")|nutrition(?:\/|")|meal-plans(?:\/|")|food-notes(?:\/|")|frequent-foods"|chat-images(?:\/|"))/
  );
  assert.match(nutritionRoutes, /nutritionRouter\.post\("\/coach\/mealplan"/);
  assert.match(nutritionRoutes, /nutritionRouter\.get\("\/nutrition\/day"/);
  assert.match(nutritionRoutes, /nutritionRouter\.put\("\/food-notes\/:id"/);
  assert.match(nutritionRoutes, /nutritionRouter\.get\("\/chat-images\/:name"/);
  assert.match(nutritionRoutes, /backgroundOp\(res,\s*"nutrition_checkin"/);
  assert.match(api, /api\.use\("\/",\s*systemRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/(?:health|version|update-status|update-check)"/);
  assert.match(systemRoutes, /systemRouter\.get\("\/health"/);
  assert.match(systemRoutes, /systemRouter\.post\("\/update-check"/);
  assert.match(api, /api\.use\("\/",\s*personRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:profile"|goal"|bodyweight(?:\/|")|blood-pressure(?:\/|")|checkins(?:\/|"))/
  );
  assert.match(personRoutes, /personRouter\.get\("\/profile"/);
  assert.match(personRoutes, /personRouter\.post\("\/blood-pressure"/);
  assert.match(personRoutes, /personRouter\.get\("\/checkins"/);
  assert.match(api, /api\.use\("\/",\s*planExercisesRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:plan(?:\/|\.ics"|")|exercises(?:\/|")|exercise(?:\/|")|program\/variations")/
  );
  assert.match(planExerciseRoutes, /planExercisesRouter\.get\("\/plan"/);
  assert.ok(
    planExerciseRoutes.indexOf('planExercisesRouter.get("/plan.ics"') >
      planExerciseRoutes.indexOf('planExercisesRouter.get("/plan"') &&
      planExerciseRoutes.indexOf('planExercisesRouter.get("/plan.ics"') <
        planExerciseRoutes.indexOf('planExercisesRouter.get("/plan/:day"'),
    "plan.ics route must stay before /plan/:day"
  );
  assert.match(planExerciseRoutes, /planExercisesRouter\.post\("\/exercises\/reconcile-groups"/);
  assert.match(planExerciseRoutes, /planExercisesRouter\.get\("\/program\/variations"/);
  assert.match(planExerciseRoutes, /decodeURIComponent\(req\.params\.name\)/);
  assert.match(api, /api\.use\("\/",\s*programRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:agent\/run|program(?:\/|")|proposals(?:\/|")|program-state"|performance"|run-plan"|run-zones"|muscle-trajectory"|test-week"|dexa-targeting")/
  );
  assert.match(programRoutes, /programRouter\.post\("\/agent\/run"/);
  assert.match(programRoutes, /programRouter\.post\("\/program\/evolve"/);
  assert.match(programRoutes, /programRouter\.get\("\/program\/progression"/);
  assert.match(programRoutes, /programRouter\.post\("\/program\/progression\/apply"/);
  assert.match(programRoutes, /programRouter\.get\("\/proposals"/);
  assert.match(programRoutes, /programRouter\.post\("\/program\/run-plan\/apply"/);
  assert.match(programRoutes, /backgroundOp\(res,\s*"proposal"/);
  assert.match(programRoutes, /backgroundOp\(res,\s*"evolve_program"/);
  assert.match(programRoutes, /localToday\(\)/);
  // The auto-progression apply now routes through the shared buildProgressionProposal
  // (supersede + createProposal moved into it so REST + MCP can't drift).
  assert.match(programRoutes, /buildProgressionProposal/);
  assert.match(api, /api\.use\("\/",\s*trainingLogRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:sessions(?:\/|")|last-set"|sets(?:\/|")|progress(?:\/|")|activities(?:\/|")|recent-training"|stats"|endurance-prs"|run-compliance"|cardio"|endurance-goal"|volume"|calendar")/
  );
  assert.match(trainingLogRoutes, /trainingLogRouter\.get\("\/sessions"/);
  assert.match(trainingLogRoutes, /req\.query\.date[\s\S]*getSessionByDate/);
  assert.match(trainingLogRoutes, /trainingLogRouter\.delete\("\/sessions\/skip"/);
  assert.match(trainingLogRoutes, /req\.body\s*\?\?\s*\{\}[\s\S]*req\.query\.exercise/);
  assert.match(trainingLogRoutes, /trainingLogRouter\.get\("\/activities\/:id"/);
  assert.match(trainingLogRoutes, /trainingLogRouter\.get\("\/cardio"/);
  assert.match(trainingLogRoutes, /localToday\(\)/);
  assert.match(api, /api\.use\("\/health-docs",\s*healthDocsRouter\)/);
  assert.match(api, /api\.use\("\/",\s*todayRouter\)/);
  assert.match(genDocs, /src\/routes\/agent-jobs\.ts/);
  assert.match(genDocs, /receiver:\s*"agentJobsRouter",\s*prefix:\s*"\/agent-jobs"/);
  assert.match(parity, /src\/routes\/agent-jobs\.ts/);
  assert.match(parity, /"agentJobsRouter",\s*"\/agent-jobs"/);
  assert.match(genDocs, /src\/routes\/art\.ts/);
  assert.match(genDocs, /receiver:\s*"artRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/art\.ts/);
  assert.match(parity, /"artRouter"/);
  assert.match(genDocs, /src\/routes\/operator\.ts/);
  assert.match(genDocs, /receiver:\s*"operatorRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/operator\.ts/);
  assert.match(parity, /"operatorRouter"/);
  assert.match(genDocs, /src\/routes\/person-context\.ts/);
  assert.match(genDocs, /receiver:\s*"personContextRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/person-context\.ts/);
  assert.match(parity, /"personContextRouter"/);
  assert.match(genDocs, /src\/routes\/chat\.ts/);
  assert.match(genDocs, /receiver:\s*"chatRouter",\s*prefix:\s*"\/chat"/);
  assert.match(parity, /src\/routes\/chat\.ts/);
  assert.match(parity, /"chatRouter",\s*"\/chat"/);
  assert.match(genDocs, /src\/routes\/connected-brain\.ts/);
  assert.match(genDocs, /receiver:\s*"connectedBrainRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/connected-brain\.ts/);
  assert.match(parity, /"connectedBrainRouter"/);
  assert.match(genDocs, /src\/routes\/day-coach\.ts/);
  assert.match(genDocs, /receiver:\s*"dayCoachRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/day-coach\.ts/);
  assert.match(parity, /"dayCoachRouter"/);
  assert.match(genDocs, /src\/routes\/exports\.ts/);
  assert.match(genDocs, /receiver:\s*"exportsRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/exports\.ts/);
  assert.match(parity, /"exportsRouter"/);
  assert.match(genDocs, /src\/routes\/garmin\.ts/);
  assert.match(genDocs, /receiver:\s*"garminRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/garmin\.ts/);
  assert.match(parity, /"garminRouter"/);
  assert.match(genDocs, /src\/routes\/health-docs\.ts/);
  assert.match(genDocs, /receiver:\s*"healthDocsRouter",\s*prefix:\s*"\/health-docs"/);
  assert.match(genDocs, /src\/routes\/health-metrics\.ts/);
  assert.match(genDocs, /receiver:\s*"healthMetricsRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/health-metrics\.ts/);
  assert.match(parity, /"healthMetricsRouter"/);
  assert.match(genDocs, /src\/routes\/memory-learning\.ts/);
  assert.match(genDocs, /receiver:\s*"memoryLearningRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/memory-learning\.ts/);
  assert.match(parity, /"memoryLearningRouter"/);
  assert.match(genDocs, /src\/routes\/nutrition\.ts/);
  assert.match(genDocs, /receiver:\s*"nutritionRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/nutrition\.ts/);
  assert.match(parity, /"nutritionRouter"/);
  assert.match(genDocs, /src\/routes\/person\.ts/);
  assert.match(genDocs, /receiver:\s*"personRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/person\.ts/);
  assert.match(parity, /"personRouter"/);
  assert.match(genDocs, /src\/routes\/plan-exercises\.ts/);
  assert.match(genDocs, /receiver:\s*"planExercisesRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/plan-exercises\.ts/);
  assert.match(parity, /"planExercisesRouter"/);
  assert.match(genDocs, /src\/routes\/program\.ts/);
  assert.match(genDocs, /receiver:\s*"programRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/program\.ts/);
  assert.match(parity, /"programRouter"/);
  assert.match(genDocs, /src\/routes\/system\.ts/);
  assert.match(genDocs, /receiver:\s*"systemRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/system\.ts/);
  assert.match(parity, /"systemRouter"/);
  assert.match(genDocs, /src\/routes\/training-log\.ts/);
  assert.match(genDocs, /receiver:\s*"trainingLogRouter",\s*prefix:\s*""/);
  assert.match(parity, /src\/routes\/training-log\.ts/);
  assert.match(parity, /"trainingLogRouter"/);
  assert.match(genDocs, /src\/routes\/today\.ts/);
  assert.match(genDocs, /receiver:\s*"todayRouter",\s*prefix:\s*""/);
});

test("Settings route helper exposes stale-route pruning", () => {
  const helper = read("public/js/settings-routes.js");
  const source = read("src/client/settings-routes.ts");
  const settingsAgentsController = read("public/js/settings-agents-controller.js");
  const settingsSourcesAutomationController = read("public/js/settings-sources-automation-controller.js");
  assert.match(source, /function\s+settingsPruneRoutes/);
  assert.match(source, /type SettingsRouteTask = \[string, string\]/);
  assert.match(helper, /function\s+settingsPruneRoutes/);
  assert.doesNotMatch(helper, /\bescHtml\b|\bescAttr\b/);
  assert.match(settingsAgentsController, /deps\.pruneRoutes\(deps\.workingModel\.routes,\s*deps\.routeTasks,\s*enabledAgents\)/);
  assert.match(settingsSourcesAutomationController, /CairnSettingsSurface\.sourcesSliceHtml/);
  assert.ok(
    bootPos("/js/settings-routes.js") > -1 &&
      bootPos("/js/settings-routes.js") < bootPos("/js/settings-agents-controller.js") &&
      bootPos("/js/settings-surface-client.js") < bootPos("/js/settings-screen.js") &&
      bootPos("/js/settings-agents-controller.js") < bootPos("/js/settings-sources-automation-controller.js") &&
      bootPos("/js/settings-sources-automation-controller.js") < bootPos("/js/settings-screen.js"),
    "Settings route/surface helpers and slice controllers must load before the Settings screen"
  );
});

test("app shell privacy contract avoids remote fonts and blanket inline scripts", () => {
  const index = read("public/index.html");
  const styles = read("public/styles.css");
  const server = read("src/server.ts");
  const design = read("docs/DESIGN.md");
  const publicJs = [
    "public/js/02-ui.js",
    "public/js/agent-login-model-client.js",
    "public/js/agent-login-assets-client.js",
    "public/js/agent-login-modal-client.js",
    "public/js/agent-login-session-client.js",
    "public/js/agent-login-client.js",
    "public/js/save-bar.js",
    "public/js/09-plan-chat.js",
  ].map(read).join("\n");
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

test("view transition aborts degrade without console-level promise noise", () => {
  const uiViewTransitions = read("public/js/ui-view-transitions-client.js");
  assert.match(uiViewTransitions, /function\s+isViewTransitionAbort/);
  assert.match(uiViewTransitions, /name\s*===\s*"AbortError"/);
  assert.match(uiViewTransitions, /name\s*===\s*"InvalidStateError"[\s\S]*\/transition\/i\.test/);
  assert.match(uiViewTransitions, /\.catch\(\(error\)\s*=>\s*\{\s*if\s*\(!isViewTransitionAbort\(error\)\)\s*throw\s+error;\s*\}\)/);
  assert.match(uiViewTransitions, /\.finally\(\(\)\s*=>\s*\{\s*active\s*=\s*false;\s*\}\)/);
});

test("service worker caches core assets strictly and optional assets best-effort", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /const\s+CORE_ASSETS\s*=/);
  assert.match(sw, /const\s+OPTIONAL_ASSETS\s*=/);
  assert.match(sw, /addAll\(CORE_ASSETS\)/);
  assert.match(sw, /OPTIONAL_ASSETS\.map[\s\S]*catch\(\(\)\s*=>\s*null\)/);
  // The shell ships as a handful of concatenated bundles; CORE_ASSETS must precache
  // exactly those bundles (in manifest order) and no individual module file.
  const cachedJs = [...sw.matchAll(/"(\/js\/[^"]+)"/g)].map((m) => m[1]);
  const bundleUrls = BUNDLES.map((bundle) => `/${bundle.output.replace(/^public\//, "")}`);
  assert.deepEqual(cachedJs, bundleUrls, "CORE_ASSETS must precache exactly the bundles, in manifest order");
  assert.match(sw, /"\/art\.js"/);
  assert.match(sw, /"\/manifest\.json"/);
});

test("PWA deep links return the app shell without capturing API or MCP", () => {
  const server = read("src/server.ts");
  const sw = read("public/sw.js");
  assert.match(server, /app\.use\("\/api",\s*api\)/);
  assert.match(server, /app\.post\("\/mcp",\s*handleMcpPost\)/);
  assert.match(server, /app\.get\(\/\^\\\/app/);
  assert.match(server, /res\.sendFile\("index\.html",\s*\{\s*root:\s*PUBLIC_DIR,\s*dotfiles:\s*"deny"\s*\}\)/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api"\)\s*\|\|\s*url\.pathname\.startsWith\("\/mcp"\)/);
  assert.match(sw, /e\.request\.mode\s*===\s*"navigate"[\s\S]*caches\.match\("\/index\.html"\)/);
});

test("PWA route state is wired through boot, tabs, nested screens, and date-aware fuel", () => {
  const appStartup = read("public/js/app-startup.js");
  const appRouteSync = read("public/js/app-route-sync.js");
  const appRenderDispatch = read("public/js/app-render-dispatch.js");
  const appTabs = read("public/js/app-tabs.js");
  const appRouter = read("public/js/app-router.js");
  const ui = read("public/js/02-ui.js");
  const uiSegments = read("public/js/ui-segments-client.js");
  const meals = read("public/js/06-coach-meals.js");
  const healthTabs = read("public/js/me-health-tabs-controller.js");
  const healthComposition = read("public/js/me-health-screen-composition.js");
  const dayFuelController = read("public/js/day-fuel-controller.js");
  const health = read("public/js/07-me-health.js");
  const recordsHealthDocController = read("public/js/me-records-health-doc-controller.js");
  const chat = read("public/js/09-plan-chat.js");
  const chatHeader = read("public/js/chat-header-controller.js");
  const chatClient = read("public/js/chat-client.js");
  const chatHistoryClient = read("public/js/chat-history-client.js");
  assert.ok(
    bootPos("/js/route-state.js") > -1 && bootPos("/js/route-state.js") < bootPos("/js/10-boot.js"),
    "route-state.js must load before 10-boot.js"
  );
  assert.match(appRouteSync, /routeSyncApply/);
  assert.match(appRouteSync, /routeSyncFromState/);
  assert.match(appStartup, /parseRoute\(location\.href\)/);
  assert.match(appStartup, /window\.addEventListener\("popstate"/);
  assert.match(appRouter, /history\[mode === "replace" \? "replaceState" : "pushState"\]\(\{ cairn: true \},\s*"",\s*next\)/);
  assert.match(appRenderDispatch, /renderTab: renderAppTab/);
  assert.match(appTabs, /function\s+switchTab\(tab,\s*opts\s*=\s*\{\}\)/);
  assert.match(appTabs, /function\s+activateTab\(name,\s*opts\s*=\s*\{\}\)/);
  assert.match(uiSegments, /\["energy",\s*"Energy"\]/, "Progress Energy must remain a routable segment");
  assert.match(uiSegments, /energy:\s*\(\)\s*=>\s*deps\.renderEnergy\(\)/, "Progress Energy must have a segment handler");
  assert.match(uiSegments, /deps\.syncRouteFromState\(\)/, "shared UI events should notify route sync");
  assert.match(ui, /CairnUiSegments/, "UI shell should delegate segmented navigation to the typed segments module");
  assert.match(dayFuelController, /path:\s*"\/nutrition\/day"\s*\+\s*qs/, "Plan Food must fetch the routed local day");
  assert.match(meals, /CairnDayFuelController\.loadDayFuel/, "Plan Food must use the routed day-fuel controller");
  assert.match(healthTabs, /const next = normalizeHealthSeg\(b\.dataset\.hseg\)[\s\S]*setHealthSegActive\(next,\s*deps\)[\s\S]*deps\.syncRouteFromState\?\.\(\)/);
  assert.match(health, /ME_HEALTH_SCREEN\.renderHealth\(\)/);
  assert.match(healthComposition, /CairnMeHealthTabsController\.renderHealth\(screen\.meHealthTabsDeps\(\)\)/);
  assert.match(recordsHealthDocController, /state\.pendingHealthDocId[\s\S]*scrollIntoView/);
  assert.match(appRouter, /state\.pendingChatSession\s*=\s*route\.session\s*\|\|\s*null/);
  assert.match(chatClient, /session\.session_id\s*\|\|\s*session\.archived_at/);
  assert.match(chatClient, /hit\.session_id\s*\|\|\s*hit\.archived_at/);
  assert.match(chat, /openChatHistory/);
  assert.ok(
    bootPos("/js/chat-history-client.js") > -1 &&
      bootPos("/js/chat-history-client.js") < bootPos("/js/chat-header-controller.js") &&
      bootPos("/js/chat-header-controller.js") < bootPos("/js/09-plan-chat.js"),
    "chat-header-controller.js must load after chat history and before the Chat screen"
  );
  assert.match(chatHeader, /function ensureChatHeaderBtns/);
  assert.match(chatHeader, /function chatFreshStart/);
  assert.match(chat, /CairnChatHeaderController\.ensureChatHeaderBtns/);
  assert.match(chatHistoryClient, /function openChatHistory\(options/);
  assert.match(chatHistoryClient, /state\.pendingChatSession\s*=\s*sessionId[\s\S]*syncRouteFromState\(\)/);
  assert.match(chatHistoryClient, /api\("\/chat\/sessions\/"\s*\+\s*encodeURIComponent\(sessionId\)\)/);
});

test("PWA route literals stay aligned across parser, types, and segment registries", () => {
  const routeState = read("src/client/route-state.ts");
  const clientGlobals = read("src/contracts/client-globals.d.ts");
  const appRouter = read("src/client/app/router.ts");
  const appTabs = read("src/client/app/tabs.ts");
  const uiShell = read("src/client/ui-shell.ts");
  const uiSegments = read("src/client/ui-segments-client.ts");
  const meHealth = read("src/client/me-health-screen.ts");
  const meHealthComposition = read("src/client/me-health-screen-composition.ts");
  const meHealthTabs = read("src/client/me-health-tabs-controller.ts");
  const settingsScreen = read("src/client/settings-screen.ts");
  const settingsSurface = read("src/client/settings-surface-client.ts");

  const plan = CLIENT_ROUTE_DEFINITIONS.sections.plan;
  const progress = CLIENT_ROUTE_DEFINITIONS.sections.progress;
  const me = CLIENT_ROUTE_DEFINITIONS.sections.me;
  const health = CLIENT_ROUTE_DEFINITIONS.sections.health;
  const settings = CLIENT_ROUTE_DEFINITIONS.sections.settings;

  assert.match(routeState, /satisfies ClientRouteDefinitions/);
  assert.match(routeState, /routeDefinitions: CLIENT_ROUTE_DEFINITIONS/);
  assert.match(clientGlobals, /type ClientTabName = ContractClientTabName/);
  assert.match(clientGlobals, /type ClientPlanSection = ContractClientPlanSection/);
  assert.match(clientGlobals, /type ClientProgressSection = ContractClientProgressSection/);
  assert.match(clientGlobals, /type ClientMeSection = ContractClientMeSection/);
  assert.match(clientGlobals, /type ClientHealthSection = ContractClientHealthSection/);
  assert.match(clientGlobals, /type ClientSettingsSection = ContractClientSettingsSection/);

  assert.match(appRouter, /routeDefinitions\(\)\?\.tabs/);
  assert.match(appTabs, /window\.CairnAppRouter\?\.ROUTE_TABS/);
  assertSameMembers(objectKeys(uiSegments, "planHandlers"), plan, "Plan handlers must cover every plan route section");
  assertSameMembers(segmentKeys(uiSegments, "UI_PROGRESS_SEGMENTS"), progress, "Progress segments must cover every progress route section");
  assert.match(uiSegments, /routedToEndurance\s*=\s*deps\.state\.planSeg\s*===\s*"endurance"\s*\|\|\s*deps\.state\.planJump\s*===\s*"endurance"/);
  assert.match(uiShell, /const PROGRESS_SEG: readonly UiSegment\[\] = uiSegmentsApi\(\)\.PROGRESS_SEG/);
  // Me is the about-you home: standing/health stay parseable route sections (old
  // deep links redirect to the Stand tab) but are no longer Me seg-bar entries.
  const meBar = me.filter((section) => section !== "standing" && section !== "health");
  assertSameMembers(segmentKeys(meHealthComposition, "ME_HEALTH_SCREEN_SEGMENTS"), meBar, "Me segments must cover every about-you Me route section");
  assertSameMembers(objectKeys(meHealthComposition, "handlers"), me, "Me handlers must cover every Me route section");
  // Every Stand route section must be dispatched by the Stand screen.
  const standScreen = read("src/client/stand-screen.ts");
  for (const section of CLIENT_ROUTE_DEFINITIONS.sections.stand) {
    assert.match(standScreen, new RegExp(`"${section}"`), `stand-screen must handle the "${section}" route section`);
  }
  assertSameMembers(segmentKeys(meHealthTabs, "HEALTH_SEG"), health, "Health segments must cover every Health route section");
  assert.match(meHealth, /const HEALTH_SEG = ME_HEALTH_SCREEN\.HEALTH_SEG/);
  const settingsSegments = segmentKeys(settingsScreen, "SET_SEG");
  assertSameMembers(
    settingsSegments.length ? settingsSegments : segmentKeys(settingsSurface, "SETTINGS_SURFACE_SEGMENTS"),
    settings,
    "Settings segments must cover every Settings route section"
  );
});

test("Stand uses stale-while-revalidate with a sessionStorage snapshot and preserved scroll", () => {
  const standScreen = read("src/client/stand-screen.ts");
  // A request token discards a superseded background fetch instead of clobbering DATA.
  assert.match(standScreen, /reqToken/, "Stand must guard background loads with a request token");
  assert.match(standScreen, /if \(token !== reqToken\) return/, "a superseded fetch must not write DATA");
  // sessionStorage snapshot → instant cold paint; quota/parse safe.
  assert.match(standScreen, /sessionStorage\.setItem\(SNAP_KEY/, "Stand must persist a snapshot for instant cold paint");
  assert.match(standScreen, /sessionStorage\.getItem\(SNAP_KEY/, "Stand must hydrate from the snapshot on cold open");
  assert.match(standScreen, /function saveSnapshot/, "snapshot save must be wrapped safely");
  // Background revalidate: fetch, compare, repaint only on a real change.
  assert.match(standScreen, /function revalidateStand/, "Stand must have a background revalidate path");
  assert.match(standScreen, /function standDataEqual/, "revalidate must compare old vs new before repainting");
  assert.match(standScreen, /if \(prev && standDataEqual\(prev, next\)\) return/, "unchanged data must not repaint");
  // Quiet repaint preserves scroll and skips the view-enter animation.
  assert.match(standScreen, /const y = window\.scrollY/, "the background repaint must capture scroll");
  assert.match(standScreen, /window\.scrollTo\(0, y\)/, "the background repaint must restore scroll");
  assert.match(standScreen, /if \(quietPaint\) return/, "a background repaint must suppress the view-enter animation");
  // Self-contained tool views are never repainted out from under the user.
  assert.match(standScreen, /const SELF_CONTAINED: ReadonlySet<StandView>/, "self-contained tool views must be enumerated");
  assert.match(standScreen, /if \(curView !== "overview" && curView !== "recovery"\) return/, "quiet repaint must skip input-bearing views");
});

test("Stand restores the read's depth and reuses the rich recovery renderer", () => {
  const standScreen = read("src/client/stand-screen.ts");
  // The full story expander: story paragraph, deeper priorities, recheck badges, whole-picture ask.
  assert.match(standScreen, /function fullStoryHtml/, "Stand must render the progressive-disclosure full story");
  assert.match(standScreen, /syn\.story/, "the expander must render the synthesis story paragraph");
  assert.match(standScreen, /\(syn\?\.priorities \|\| \[\]\)\.slice\(3\)/, "the expander must show priorities beyond the visible three");
  assert.match(standScreen, /function recheckBadge/, "priorities must carry a recheck timing badge");
  assert.match(standScreen, /WHOLE_PICTURE_Q/, "the whole-picture ask deep-link must be present");
  assert.match(standScreen, /data-storytoggle/, "the full story must be collapsible");
  // Rich recovery reuses the shipped plain-language renderer, not the 4-card summary.
  assert.match(standScreen, /CairnHealthRead\.recoveryHtml/, "recovery detail must reuse the rich health-read renderer");
  assert.doesNotMatch(standScreen, /card\("Body battery"/, "the old 4-card recovery summary must be gone");
});

test("Stand's Recovery tile is freshness-gated; the detail dates itself", () => {
  // Recovery is time-sensitive: a window average with no reading from today or
  // yesterday must not sit on the overview presenting itself as a "now" read.
  const standScreen = read("src/client/stand-screen.ts");
  assert.match(standScreen, /function recoveryIsFresh/, "the tile must have a freshness check on recovery.last_date");
  assert.match(standScreen, /if \(!rec \|\| !recoveryIsFresh\(\)\) return ""/, "a stale/absent reading must drop the tile");
  // The detail always says when data last arrived (and flags a gone-quiet wearable).
  const healthRead = read("src/client/health-read-client.ts");
  assert.match(healthRead, /Last logged/, "the recovery detail must date its read");
  assert.match(healthRead, /hb-rlast-stale/, "a stale read must carry the stale marker class");
});

test("Stand SWR + depth land in the generated bundle", () => {
  const bundle = read("public/js/stand-screen.js");
  assert.match(bundle, /revalidateStand/, "generated stand-screen must carry the revalidate path");
  assert.match(bundle, /SNAP_KEY/, "generated stand-screen must carry the snapshot key");
  assert.match(bundle, /CairnHealthRead\.recoveryHtml/, "generated stand-screen must reuse rich recovery");
  assert.match(bundle, /stand-story/, "generated stand-screen must carry the full-story markup");
});

test("chat session index is created only after the v49 column migration", () => {
  const schema = read("src/db.ts");
  const migrations = read("src/migrate.ts");
  assert.doesNotMatch(
    schema,
    /CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages\(session_id\)/,
    "old DBs do not have chat_messages.session_id until migration v49 runs"
  );
  assert.match(migrations, /addColumn\(db,\s*"chat_messages",\s*"session_id TEXT"\)/);
  assert.match(migrations, /CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages\(session_id\)/);
});

test("PWA API calls are covered by shared client contracts or explicit waivers", () => {
  const contractSource = [
    "src/contracts/client.ts",
    "src/contracts/client-api.ts",
    "src/contracts/client-api-coverage.ts",
  ]
    .map(read)
    .join("\n");
  const contractPatterns = [...CLIENT_API_CONTRACT_PATHS];
  const waiverPatterns = CLIENT_API_UNKNOWN_WAIVERS.map((waiver) => waiver.pattern);
  const broadWaiverPatterns = CLIENT_API_BROAD_RESPONSE_WAIVERS.map((waiver) => waiver.pattern);
  const allPatterns = [...contractPatterns, ...waiverPatterns].map(contractPatternToRegExp);

  assert.deepEqual(new Set(contractPatterns).size, contractPatterns.length, "contract API patterns must be unique");
  assert.deepEqual(new Set(waiverPatterns).size, waiverPatterns.length, "contract waiver patterns must be unique");
  assert.deepEqual(new Set(broadWaiverPatterns).size, broadWaiverPatterns.length, "broad DTO waiver patterns must be unique");
  assert.ok(contractPatterns.includes("/learnings"), "/learnings should be covered by the typed memory contract");
  assert.ok(contractPatterns.includes("/memory/:id/supersede"), "/memory/:id/supersede should be covered by the typed memory contract");
  assert.ok(contractPatterns.includes("/volume"), "/volume should be covered for SWR Progress volume reads");
  assert.ok(contractPatterns.includes("/calendar"), "/calendar should be covered for SWR Progress calendar reads");
  assert.ok(contractPatterns.includes("/agent/run"), "/agent/run should be covered for durable proposal jobs");
  assert.ok(contractPatterns.includes("/coach/mealplan"), "/coach/mealplan should be covered for durable meal-plan jobs");
  assert.ok(contractPatterns.includes("/insights/generate"), "/insights/generate should be covered for durable insight jobs");
  assert.ok(!waiverPatterns.includes("/learnings"), "/learnings must not regress to a broad JSON waiver");
  assert.doesNotMatch(contractSource, /"\/api\/[^"]+":\s*unknown\b/, "exact API responses must not be bare unknown");

  for (const pattern of contractPatterns) {
    assert.match(pattern, /^\//, `${pattern} must be a client path without the /api prefix`);
    assert.doesNotMatch(pattern, /\?/, `${pattern} must not include query strings`);
    assert.doesNotMatch(pattern, /^\/api\//, `${pattern} must omit the /api prefix`);
    if (!pattern.includes(":")) {
      assert.match(
        contractSource,
        new RegExp(`"\\/api${escapeRegExp(pattern)}"`),
        `${pattern} needs a ClientApiResponses entry`
      );
    }
  }

  for (const waiver of CLIENT_API_UNKNOWN_WAIVERS) {
    assert.match(waiver.pattern, /^\//, `${waiver.pattern} must be a client path without the /api prefix`);
    assert.ok(waiver.owner.trim().length > 0, `${waiver.pattern} needs a migration owner`);
    assert.ok(waiver.reason.trim().length > 20, `${waiver.pattern} needs a concrete reason`);
  }

  for (const waiver of CLIENT_API_BROAD_RESPONSE_WAIVERS) {
    assert.match(waiver.pattern, /^\//, `${waiver.pattern} must be a client path without the /api prefix`);
    assert.ok(waiver.owner.trim().length > 0, `${waiver.pattern} needs a migration owner`);
    assert.ok(waiver.reason.trim().length > 20, `${waiver.pattern} needs a concrete reason`);
  }

  const broadExactResponses = broadExactApiResponses(contractSource);
  const unownedBroadResponses = broadExactResponses
    .filter((entry) => !broadWaiverPatterns.includes(entry.pattern))
    .map((entry) => `${entry.pattern}: ${entry.response}`)
    .sort();
  assert.deepEqual(unownedBroadResponses, [], "exact broad client response DTOs need an owner/reason waiver");
  const staleBroadWaivers = broadWaiverPatterns
    .filter((pattern) => !broadExactResponses.some((entry) => entry.pattern === pattern))
    .sort();
  assert.deepEqual(staleBroadWaivers, [], "remove broad DTO waivers once responses are narrowed");

  const uncovered = clientApiCallPaths()
    .filter((call) => !allPatterns.some((re) => re.test(call.path)))
    .map((call) => `${call.file}: ${call.path}`)
    .sort();
  assert.deepEqual(uncovered, []);
});

test("chat action write contract stays typed and prompt-aligned", () => {
  // prompt.ts is a barrel now; the chat prompt + parseChatReply live in the chat module.
  const prompt = read("src/prompt/chat.ts");
  const chatTurns = read("src/chatTurns.ts");
  const chatActions = read("src/chatActions.ts");
  const actionSchema = renderChatActionSchema();
  const actionProse = renderChatActionPromptProse();
  const draftActions = draftChatActionTypes();
  const immediateActions = immediateChatActionTypes();

  assert.match(prompt, /normalizeChatActions/);
  assert.match(prompt, /renderChatActionPromptProse/);
  assert.match(prompt, /renderChatActionSchema/);
  assert.doesNotMatch(prompt, /const CHAT_ACTIONS_SCHEMA/);
  assert.match(prompt, /actions: ChatAction\[\]/);
  assert.doesNotMatch(prompt, /actions:\s*any\[\]/);
  assert.match(chatTurns, /normalizeChatActions/);
  assert.doesNotMatch(chatTurns, /parsed:\s*any/);
  assert.match(chatActions, /CHAT_ACTION_PROMPT_SPECS/);
  assert.deepEqual(Object.keys(CHAT_ACTION_PROMPT_SPECS), [...CHAT_ACTION_TYPES]);
  assert.deepEqual(
    chatActionPromptSpecs().map((spec) => spec.type),
    [...CHAT_ACTION_TYPES]
  );
  assert.deepEqual(draftActions, ["plan_restructure"]);
  assert.equal(immediateActions.includes("plan_update"), true);
  assert.equal(immediateActions.includes("plan_restructure"), false);
  assert.match(actionProse, /APPLIED immediately/);
  assert.match(actionProse, /DRAFTS for the user to review and apply/);

  for (const actionType of CHAT_ACTION_TYPES) {
    assert.match(chatActions, new RegExp(`"${actionType}"`), `${actionType} should be owned by chatActions.ts`);
    assert.match(
      actionSchema,
      new RegExp(`"type": "${escapeRegExp(actionType)}"`),
      `${actionType} should be described in the generated prompt action schema`
    );
    assert.match(chatTurns, new RegExp(`case "${actionType}"`), `${actionType} should be handled by applyChatActions`);
  }
});

test("frontend TypeScript contract gate is dependency-light and backed by server payloads", () => {
  const pkg = JSON.parse(read("package.json"));
  const rootTsconfig = read("tsconfig.json");
  const clientTsconfig = read("tsconfig.client.json");
  const clientBuildTsconfig = read("tsconfig.client.build.json");
  const clientGlobals = read("src/contracts/client-globals.d.ts");
  const clientShellGlobals = read("src/contracts/client-shell-globals.d.ts");
  const clientState = read("src/contracts/client-state.ts");
  const contracts = read("src/contracts/client.ts");
  const apiContracts = read("src/contracts/client-api.ts");
  const apiCoverage = read("src/contracts/client-api-coverage.ts");
  const compat = read("src/contracts/client-compat.ts");
  const dateUtilsSource = read("src/client/date-utils.ts");
  const htmlUtilsSource = read("src/client/html-utils.ts");
  const markdownSource = read("src/client/markdown-client.ts");
  const uiComponentsSource = read("src/client/ui-components.ts");
  const uiFeedbackSource = read("src/client/ui-feedback-client.ts");
  const uiActionsSource = read("src/client/ui-actions-client.ts");
  const uiViewTransitionsSource = read("src/client/ui-view-transitions-client.ts");
  const detailOverlaySource = read("src/client/detail-overlay-client.ts");
  const uiMotionSource = read("src/client/ui-motion-client.ts");
  const exerciseDetailSource = read("src/client/exercise-detail-client.ts");
  const exerciseDetailDataSource = read("src/client/exercise-detail-data-client.ts");
  const exerciseDetailExplanationSource = read("src/client/exercise-detail-explanation-client.ts");
  const exerciseDetailRenderSource = read("src/client/exercise-detail-render-client.ts");
  const exerciseDetailActionsSource = read("src/client/exercise-detail-actions-client.ts");
  const exerciseDetailControllerSource = read("src/client/exercise-detail-controller.ts");
  const formatUtilsSource = read("src/client/format-utils.ts");
  const apiClientSource = read("src/client/api-client.ts");
  const appDownloadSource = read("src/client/app/download.ts");
  const appSwRecoverySource = read("src/client/app/sw-recovery.ts");
  const agentLoginModelSource = read("src/client/agent-login-model-client.ts");
  const agentLoginAssetsSource = read("src/client/agent-login-assets-client.ts");
  const agentLoginModalSource = read("src/client/agent-login-modal-client.ts");
  const agentLoginSessionSource = read("src/client/agent-login-session-client.ts");
  const agentLoginSource = read("src/client/agent-login-client.ts");
  const agentJobClientSource = read("src/client/agent-job-client.ts");
  const coreStateSource = read("src/client/app/state.ts");
  const artControllerSource = read("src/client/art-controller.ts");
  const uiSegmentsSource = read("src/client/ui-segments-client.ts");
  const uiShellSource = read("src/client/ui-shell.ts");
  const uiShellTypesSource = read("src/client/ui-shell-types.d.ts");
  const pwaInstallSource = read("src/client/pwa-install-coach.ts");
  const restTimerSource = read("src/client/rest-timer.ts");
  const coachingFocusSource = read("src/client/coaching-focus-client.ts");
  const todayActivitySource = read("src/client/today-activity-client.ts");
  const saveBarSource = read("src/client/save-bar.ts");
  const swrCacheSource = read("src/client/swr-cache.ts");
  const todayAgendaSource = read("src/client/today-agenda-client.ts");
  const todayRailLoadersSource = read("src/client/today-rail-loaders-client.ts");
  const todayRailControllerSource = read("src/client/today-rail-controller.ts");
  const todayPlanSelectionSource = read("src/client/today-plan-selection-client.ts");
  const todayTrainingSource = read("src/client/today-training-client.ts");
  const todayProgressionControllerSource = read("src/client/today-progression-controller.ts");
  const todayAddExerciseControllerSource = read("src/client/today-add-exercise-controller.ts");
  const todayBriefSource = read("src/client/today-brief-client.ts");
  const todayBriefOverrideSource = read("src/client/today-brief-override-client.ts");
  const todayBriefActionsSource = read("src/client/today-brief-actions-client.ts");
  const todayBriefControllerSource = read("src/client/today-brief-controller.ts");
  const cardioPlanSource = read("src/client/cardio-plan-client.ts");
  const cardioSyncSource = read("src/client/cardio-sync-client.ts");
  const todayLatelySource = read("src/client/today-lately-client.ts");
  const proposalSource = read("src/client/proposal-client.ts");
  const todaySessionSuggestSource = read("src/client/today-session-suggest-client.ts");
  const todaySessionSuggestControllerSource = read("src/client/today-session-suggest-controller.ts");
  const todaySessionStatusSource = read("src/client/today-session-status-client.ts");
  const todaySessionFeedbackSource = read("src/client/today-session-feedback-client.ts");
  const todaySessionSkipSource = read("src/client/today-session-skip-client.ts");
  const todaySessionSetModelSource = read("src/client/today-session-set-model.ts");
  const todaySessionSetActionsSource = read("src/client/today-session-set-actions.ts");
  const todaySessionControllerSource = read("src/client/today-session-controller.ts");
  const todayCardsSource = read("src/client/today-cards-client.ts");
  const todayProgramAdjustmentsSource = read("src/client/today-program-adjustments-client.ts");
  const todayWeekAheadSource = read("src/client/today-week-ahead-client.ts");
  const todayContextSource = read("src/client/today-context-client.ts");
  const todayCompassSource = read("src/client/today-compass-client.ts");
  const todayGarminReconciliationSource = read("src/client/today-garmin-reconciliation-client.ts");
  const todaySideLoadersSource = read("src/client/today-side-loaders.ts");
  const todayPlanSessionModelSource = read("src/client/today-plan-session-model.ts");
  const todayPlanSessionDataSource = read("src/client/today-plan-session-data-client.ts");
  const todayPlanSessionPreparationSource = read("src/client/today-plan-session-preparation.ts");
  const todayDataLoaderSource = read("src/client/today-data-loader.ts");
  const todayMainShellSource = read("src/client/today-main-shell-client.ts");
  const todayPlanSurfaceSource = read("src/client/today-plan-surface-client.ts");
  const todayPlanSurfaceRendererSource = read("src/client/today-plan-surface-renderer.ts");
  const todayRenderStateSource = read("src/client/today-render-state-client.ts");
  const todayPostRenderWiringSource = read("src/client/today-post-render-wiring.ts");
  const todayDependenciesSource = read("src/client/today-dependencies.ts");
  const todayCompatibilityBridgesSource = read("src/client/today-compatibility-bridges.ts");
  const todayScreenRuntimeDepsSource = read("src/client/today-screen-runtime-deps.ts");
  const todayScreenRuntimeSource = read("src/client/today-screen-runtime.ts");
  const todayScreenSource = read("src/client/today-screen.ts");
  const progressDataSource = read("src/client/progress-data-client.ts");
  const progressEnduranceSource = read("src/client/progress-endurance-client.ts");
  const progressComponentsSource = read("src/client/progress-components-client.ts");
  const progressLineChartModelSource = read("src/client/progress-line-chart-model.ts");
  const progressChartScrubSource = read("src/client/progress-chart-scrub-client.ts");
  const progressChartDrawingSource = read("src/client/progress-chart-drawing-client.ts");
  const progressChartSource = read("src/client/progress-chart-client.ts");
  const progressTrendWeightSource = read("src/client/progress-trend-weight-client.ts");
  const progressHistoryModelSource = read("src/client/progress-history-model-client.ts");
  const progressHistoryRenderSource = read("src/client/progress-history-render-client.ts");
  const progressHistorySource = read("src/client/progress-history-client.ts");
  const progressRunPlanSource = read("src/client/progress-run-plan-client.ts");
  const progressRouteDepsSource = read("src/client/progress-route-deps-client.ts");
  const progressEnduranceControllerSource = read("src/client/progress-endurance-controller.ts");
  const progressVolumeSource = read("src/client/progress-volume-client.ts");
  const progressEnergySource = read("src/client/progress-energy-client.ts");
  const progressEnergySurfaceSource = read("src/client/progress-energy-surface-client.ts");
  const progressCalendarSource = read("src/client/progress-calendar-client.ts");
  const progressMuscleTrajectorySource = read("src/client/progress-muscle-trajectory-client.ts");
  const progressDexaTargetingSource = read("src/client/progress-dexa-targeting-client.ts");
  const progressPerformanceSource = read("src/client/progress-performance-client.ts");
  const progressProgramAdjustmentsSource = read("src/client/progress-program-adjustments-client.ts");
  const progressTestWeekSource = read("src/client/progress-test-week-client.ts");
  const progressProgramSummarySource = read("src/client/progress-program-summary-client.ts");
  const progressProgramBlockSource = read("src/client/progress-program-block-client.ts");
  const progressProgramControllerSource = read("src/client/progress-program-controller.ts");
  const progressScreenSource = read("src/client/progress-screen.ts");
  const captureProvenanceSource = read("src/client/capture-provenance-client.ts");
  const captureReadDateSource = read("src/client/capture-read-date-client.ts");
  const captureReadCardsSource = read("src/client/capture-read-cards-client.ts");
  const captureReadJobsSource = read("src/client/capture-read-jobs-client.ts");
  const captureReadsSource = read("src/client/capture-reads-client.ts");
  const captureVoiceSource = read("src/client/capture-voice-client.ts");
  const captureTypesSource = read("src/client/capture-types.d.ts");
  const captureSource = read("src/client/capture.ts");
  const settingsRoutesSource = read("src/client/settings-routes.ts");
  const settingsClientSource = read("src/client/settings-client.ts");
  const settingsSurfaceSource = read("src/client/settings-surface-client.ts");
  const settingsDataSource = read("src/client/settings-data-client.ts");
  const settingsDataControllerSource = read("src/client/settings-data-controller.ts");
  const settingsAgentsSource = read("src/client/settings-agents-client.ts");
  const settingsAgentsControllerSource = read("src/client/settings-agents-controller.ts");
  const settingsSourcesAutomationControllerSource = read("src/client/settings-sources-automation-controller.ts");
  const settingsScreenSource = read("src/client/settings-screen.ts");
  const settingsScreenTypesSource = read("src/client/settings-screen-types.d.ts");
  const chatClientSource = read("src/client/chat-client.ts");
  const chatAttachmentSource = read("src/client/chat-attachment-client.ts");
  const chatComposerFocusSource = read("src/client/chat-composer-focus-client.ts");
  const chatComposerControllerSource = read("src/client/chat-composer-controller.ts");
  const chatMessageSource = read("src/client/chat-message-client.ts");
  const chatTurnRecordsSource = read("src/client/chat-turn-records-client.ts");
  const chatLayoutSource = read("src/client/chat-layout-client.ts");
  const chatTurnClientSource = read("src/client/chat-turn-client.ts");
  const chatHistoryClientSource = read("src/client/chat-history-client.ts");
  const chatHeaderControllerSource = read("src/client/chat-header-controller.ts");
  const chatStarterChipsSource = read("src/client/chat-starter-chips-client.ts");
  const chatFuelContextSource = read("src/client/chat-fuel-context-client.ts");
  const chatEarlierHistorySource = read("src/client/chat-earlier-history-client.ts");
  const chatScreenSource = read("src/client/chat-screen.ts");
  const planEnduranceModelSource = read("src/client/plan-endurance-model.ts");
  const planEnduranceSource = read("src/client/plan-endurance-client.ts");
  const planEditorSource = read("src/client/plan-editor-client.ts");
  const planEditorFormSource = read("src/client/plan-editor-form-client.ts");
  const planEditorControllerSource = read("src/client/plan-editor-controller.ts");
  const dayFuelSource = read("src/client/day-fuel-client.ts");
  const dayFuelControllerSource = read("src/client/day-fuel-controller.ts");
  const mealRowSource = read("src/client/meal-row-client.ts");
  const mealPlanSource = read("src/client/meal-plan-client.ts");
  const mealRecipeSource = read("src/client/meal-recipe-client.ts");
  const mealRecipeControllerSource = read("src/client/meal-recipe-controller.ts");
  const mealSwapDataSource = read("src/client/meal-swap-data-client.ts");
  const mealSwapRowActionsSource = read("src/client/meal-swap-row-actions-controller.ts");
  const mealSwapControllerSource = read("src/client/meal-swap-controller.ts");
  const mealPlannerJobsSource = read("src/client/meal-planner-jobs-client.ts");
  const mealPlannerActionsSource = read("src/client/meal-planner-actions-controller.ts");
  const mealPlannerControllerSource = read("src/client/meal-planner-controller.ts");
  const coachProposalControllerSource = read("src/client/coach-proposal-controller.ts");
  const coachMealsScreenSource = read("src/client/coach-meals-screen.ts");
  const foodNoteSource = read("src/client/food-note-client.ts");
  const foodDetailControllerSource = read("src/client/food-detail-controller.ts");
  const meProfileFormSource = read("src/client/me-profile-form-client.ts");
  const meProfileControllerSource = read("src/client/me-profile-controller.ts");
  const healthEvidenceSource = read("src/client/health-evidence-client.ts");
  const healthMarkerOrderSource = read("src/client/health-marker-order-client.ts");
  const healthClientSource = read("src/client/health-client.ts");
  const healthReadSource = read("src/client/health-read-client.ts");
  const healthStandingPrimitivesSource = read("src/client/health-standing-primitives-client.ts");
  const healthStandingSource = read("src/client/health-standing-client.ts");
  const healthStandingControllerSource = read("src/client/health-standing-controller.ts");
  const healthPictureSource = read("src/client/health-picture-client.ts");
  const healthPictureControllerSource = read("src/client/health-picture-controller.ts");
  const healthMarkersSource = read("src/client/health-markers-client.ts");
  const healthMarkersControllerSource = read("src/client/health-markers-controller.ts");
  const healthDirectivesSource = read("src/client/health-directives-client.ts");
  const healthDirectiveLoaderSource = read("src/client/health-directives-loader-client.ts");
  const healthReadSupplementsSource = read("src/client/health-read-supplements-client.ts");
  const healthReadControllerSource = read("src/client/health-read-controller.ts");
  const healthLearnedSource = read("src/client/health-learned-client.ts");
  const healthRecordsSource = read("src/client/health-records-client.ts");
  const healthDocUploadControllerSource = read("src/client/health-doc-upload-controller.ts");
  const healthDocDateActionsSource = read("src/client/health-doc-date-actions-client.ts");
  const healthDocLifecycleActionsSource = read("src/client/health-doc-lifecycle-actions-client.ts");
  const healthDocActionsControllerSource = read("src/client/health-doc-actions-controller.ts");
  const meRecordsHealthDocControllerSource = read("src/client/me-records-health-doc-controller.ts");
  const healthShareControllerSource = read("src/client/health-share-controller.ts");
  const meHealthControllerDepsSource = read("src/client/me-health-controller-deps.ts");
  const meHealthDependenciesSource = read("src/client/me-health-dependencies.ts");
  const memorySource = read("src/client/memory-client.ts");
  const meMemoryControllerSource = read("src/client/me-memory-controller.ts");
  const meHealthTabsControllerSource = read("src/client/me-health-tabs-controller.ts");
  const lifeSource = read("src/client/life-client.ts");
  const lifeFormHelpersSource = read("src/client/life-form-helpers.ts");
  const lifeTimelineActionsSource = read("src/client/life-timeline-actions.ts");
  const lifeControllerSource = read("src/client/life-controller.ts");
  const familySource = read("src/client/family-client.ts");
  const familyControllerSource = read("src/client/family-controller.ts");
  const meHealthScreenSource = read("src/client/me-health-screen.ts");
  const meHealthScreenCompositionSource = read("src/client/me-health-screen-composition.ts");
  const meRecordsScreenSource = read("src/client/me-records-screen.ts");
  const healthDocsSource = read("src/client/health-docs-client.ts");
  const routeStateSource = read("src/client/route-state.ts");
  const appRouterSource = read("src/client/app/router.ts");
  const appRouteSyncSource = read("src/client/app/route-sync.ts");
  const appRenderDispatchSource = read("src/client/app/render-dispatch.ts");
  const appTabsSource = read("src/client/app/tabs.ts");
  const appJobReconnectorsSource = read("src/client/app/job-reconnectors.ts");
  const appMobileViewportSource = read("src/client/app/mobile-viewport.ts");
  const appServiceWorkerSource = read("src/client/app/service-worker.ts");
  const appDisciplinePrimerSource = read("src/client/app/discipline-primer.ts");
  const appOnboardingSource = read("src/client/app/onboarding.ts");
  const appStartupSource = read("src/client/app/startup.ts");
  const routeState = read("public/js/route-state.js");
  const appRouter = read("public/js/app-router.js");
  const appRouteSync = read("public/js/app-route-sync.js");
  const appRenderDispatch = read("public/js/app-render-dispatch.js");
  const appTabs = read("public/js/app-tabs.js");
  const appJobReconnectors = read("public/js/app-job-reconnectors.js");
  const appMobileViewport = read("public/js/app-mobile-viewport.js");
  const appServiceWorker = read("public/js/app-service-worker.js");
  const appDisciplinePrimer = read("public/js/app-discipline-primer.js");
  const appOnboarding = read("public/js/app-onboarding.js");
  const appStartup = read("public/js/app-startup.js");
  const dateUtils = read("public/js/date-utils.js");
  const htmlUtils = read("public/js/html-utils.js");
  const markdownClient = read("public/js/markdown-client.js");
  const uiComponents = read("public/js/ui-components.js");
  const uiFeedback = read("public/js/ui-feedback-client.js");
  const uiActions = read("public/js/ui-actions-client.js");
  const uiViewTransitions = read("public/js/ui-view-transitions-client.js");
  const detailOverlayClient = read("public/js/detail-overlay-client.js");
  const uiMotionClient = read("public/js/ui-motion-client.js");
  const exerciseDetailClient = read("public/js/exercise-detail-client.js");
  const exerciseDetailController = read("public/js/exercise-detail-controller.js");
  const formatUtils = read("public/js/format-utils.js");
  const apiClient = read("public/js/api-client.js");
  const appDownload = read("public/js/app-download.js");
  const appSwRecovery = read("public/js/app-sw-recovery.js");
  const agentLoginModelClient = read("public/js/agent-login-model-client.js");
  const agentLoginAssetsClient = read("public/js/agent-login-assets-client.js");
  const agentLoginModalClient = read("public/js/agent-login-modal-client.js");
  const agentLoginSessionClient = read("public/js/agent-login-session-client.js");
  const agentLoginClient = read("public/js/agent-login-client.js");
  const agentJobClient = read("public/js/agent-job-client.js");
  const coreState = read("public/js/01-core.js");
  const artController = read("public/js/art-controller.js");
  const pwaInstall = read("public/js/pwa-install-coach.js");
  const uiHeader = read("public/js/ui-header-client.js");
  const restTimer = read("public/js/rest-timer.js");
  const coachingFocusClient = read("public/js/coaching-focus-client.js");
  const todayActivityClient = read("public/js/today-activity-client.js");
  const saveBar = read("public/js/save-bar.js");
  const swrCache = read("public/js/swr-cache.js");
  const todayAgendaClient = read("public/js/today-agenda-client.js");
  const todayRailLoaders = read("public/js/today-rail-loaders-client.js");
  const todayRailController = read("public/js/today-rail-controller.js");
  const todayPlanSelectionClient = read("public/js/today-plan-selection-client.js");
  const todayTrainingClient = read("public/js/today-training-client.js");
  const todayProgressionController = read("public/js/today-progression-controller.js");
  const todayAddExerciseController = read("public/js/today-add-exercise-controller.js");
  const todayBriefClient = read("public/js/today-brief-client.js");
  const todayBriefOverrideClient = read("public/js/today-brief-override-client.js");
  const todayBriefActionsClient = read("public/js/today-brief-actions-client.js");
  const todayBriefController = read("public/js/today-brief-controller.js");
  const cardioPlanClient = read("public/js/cardio-plan-client.js");
  const cardioSyncClient = read("public/js/cardio-sync-client.js");
  const todayLatelyClient = read("public/js/today-lately-client.js");
  const proposalClient = read("public/js/proposal-client.js");
  const todaySessionSuggestClient = read("public/js/today-session-suggest-client.js");
  const todaySessionSuggestController = read("public/js/today-session-suggest-controller.js");
  const todaySessionStatusClient = read("public/js/today-session-status-client.js");
  const todaySessionFeedbackClient = read("public/js/today-session-feedback-client.js");
  const todaySessionSkipClient = read("public/js/today-session-skip-client.js");
  const todaySessionController = read("public/js/today-session-controller.js");
  const todayProgramAdjustmentsClient = read("public/js/today-program-adjustments-client.js");
  const todayWeekAheadClient = read("public/js/today-week-ahead-client.js");
  const todayContextClient = read("public/js/today-context-client.js");
  const todayCompassClient = read("public/js/today-compass-client.js");
  const todayGarminReconciliationClient = read("public/js/today-garmin-reconciliation-client.js");
  const todaySideLoadersClient = read("public/js/today-side-loaders.js");
  const todayPlanSessionModelClient = read("public/js/today-plan-session-model.js");
  const todayPlanSessionDataClient = read("public/js/today-plan-session-data-client.js");
  const todayPlanSessionPreparationClient = read("public/js/today-plan-session-preparation.js");
  const todayDataLoaderClient = read("public/js/today-data-loader.js");
  const todayMainShellClient = read("public/js/today-main-shell-client.js");
  const todayPlanSurfaceClient = read("public/js/today-plan-surface-client.js");
  const todayPlanSurfaceRendererClient = read("public/js/today-plan-surface-renderer.js");
  const todayRenderStateClient = read("public/js/today-render-state-client.js");
  const todayPostRenderWiringClient = read("public/js/today-post-render-wiring.js");
  const todayDependenciesClient = read("public/js/today-dependencies.js");
  const todayScreenRuntimeDepsClient = read("public/js/today-screen-runtime-deps.js");
  const progressDataClient = read("public/js/progress-data-client.js");
  const progressEnduranceClient = read("public/js/progress-endurance-client.js");
  const progressComponentsClient = read("public/js/progress-components-client.js");
  const progressChartScrubClient = read("public/js/progress-chart-scrub-client.js");
  const progressChartDrawingClient = read("public/js/progress-chart-drawing-client.js");
  const progressChartClient = read("public/js/progress-chart-client.js");
  const progressTrendWeightClient = read("public/js/progress-trend-weight-client.js");
  const progressHistoryModelClient = read("public/js/progress-history-model-client.js");
  const progressHistoryRenderClient = read("public/js/progress-history-render-client.js");
  const progressHistoryClient = read("public/js/progress-history-client.js");
  const progressRunPlanClient = read("public/js/progress-run-plan-client.js");
  const progressRouteDepsClient = read("public/js/progress-route-deps-client.js");
  const progressEnduranceControllerClient = read("public/js/progress-endurance-controller.js");
  const progressVolumeClient = read("public/js/progress-volume-client.js");
  const progressEnergyClient = read("public/js/progress-energy-client.js");
  const progressEnergySurfaceClient = read("public/js/progress-energy-surface-client.js");
  const progressCalendarClient = read("public/js/progress-calendar-client.js");
  const progressMuscleTrajectoryClient = read("public/js/progress-muscle-trajectory-client.js");
  const progressDexaTargetingClient = read("public/js/progress-dexa-targeting-client.js");
  const progressPerformanceClient = read("public/js/progress-performance-client.js");
  const progressProgramAdjustmentsClient = read("public/js/progress-program-adjustments-client.js");
  const progressTestWeekClient = read("public/js/progress-test-week-client.js");
  const progressProgramSummaryClient = read("public/js/progress-program-summary-client.js");
  const progressProgramBlockClient = read("public/js/progress-program-block-client.js");
  const progressProgramControllerClient = read("public/js/progress-program-controller.js");
  const captureProvenance = read("public/js/capture-provenance-client.js");
  const captureReadDate = read("public/js/capture-read-date-client.js");
  const captureReadCards = read("public/js/capture-read-cards-client.js");
  const captureReadJobs = read("public/js/capture-read-jobs-client.js");
  const captureReads = read("public/js/capture-reads-client.js");
  const captureVoice = read("public/js/capture-voice-client.js");
  const capture = read("public/js/04-capture.js");
  const planEnduranceClient = read("public/js/plan-endurance-client.js");
  const planEditorClient = read("public/js/plan-editor-client.js");
  const planEditorFormClient = read("public/js/plan-editor-form-client.js");
  const planEditorController = read("public/js/plan-editor-controller.js");
  const dayFuelClient = read("public/js/day-fuel-client.js");
  const dayFuelController = read("public/js/day-fuel-controller.js");
  const mealRowClient = read("public/js/meal-row-client.js");
  const mealPlanClient = read("public/js/meal-plan-client.js");
  const mealRecipeClient = read("public/js/meal-recipe-client.js");
  const mealRecipeController = read("public/js/meal-recipe-controller.js");
  const mealSwapDataClient = read("public/js/meal-swap-data-client.js");
  const mealSwapRowActionsController = read("public/js/meal-swap-row-actions-controller.js");
  const mealSwapController = read("public/js/meal-swap-controller.js");
  const mealPlannerJobsClient = read("public/js/meal-planner-jobs-client.js");
  const mealPlannerActionsController = read("public/js/meal-planner-actions-controller.js");
  const mealPlannerController = read("public/js/meal-planner-controller.js");
  const coachProposalController = read("public/js/coach-proposal-controller.js");
  const foodNoteClient = read("public/js/food-note-client.js");
  const foodDetailController = read("public/js/food-detail-controller.js");
  const meProfileFormClient = read("public/js/me-profile-form-client.js");
  const meProfileController = read("public/js/me-profile-controller.js");
  const meHealthControllerDeps = read("public/js/me-health-controller-deps.js");
  const meHealthDependencies = read("public/js/me-health-dependencies.js");
  const meHealthTabsController = read("public/js/me-health-tabs-controller.js");
  const meHealthScreenComposition = read("public/js/me-health-screen-composition.js");
  const healthEvidenceClient = read("public/js/health-evidence-client.js");
  const healthMarkerOrderClient = read("public/js/health-marker-order-client.js");
  const healthClient = read("public/js/health-client.js");
  const healthReadClient = read("public/js/health-read-client.js");
  const healthStandingPrimitivesClient = read("public/js/health-standing-primitives-client.js");
  const healthStandingClient = read("public/js/health-standing-client.js");
  const healthStandingController = read("public/js/health-standing-controller.js");
  const healthPictureClient = read("public/js/health-picture-client.js");
  const healthPictureController = read("public/js/health-picture-controller.js");
  const healthMarkersClient = read("public/js/health-markers-client.js");
  const healthMarkersController = read("public/js/health-markers-controller.js");
  const healthDirectivesClient = read("public/js/health-directives-client.js");
  const healthDirectiveLoaderClient = read("public/js/health-directives-loader-client.js");
  const healthReadSupplementsClient = read("public/js/health-read-supplements-client.js");
  const healthReadController = read("public/js/health-read-controller.js");
  const healthLearnedClient = read("public/js/health-learned-client.js");
  const healthRecordsClient = read("public/js/health-records-client.js");
  const healthDocUploadController = read("public/js/health-doc-upload-controller.js");
  const meRecordsHealthDocController = read("public/js/me-records-health-doc-controller.js");
  const healthShareController = read("public/js/health-share-controller.js");
  const memoryClient = read("public/js/memory-client.js");
  const meMemoryController = read("public/js/me-memory-controller.js");
  const lifeClient = read("public/js/life-client.js");
  const lifeFormHelpers = read("public/js/life-form-helpers.js");
  const lifeTimelineActions = read("public/js/life-timeline-actions.js");
  const lifeController = read("public/js/life-controller.js");
  const familyClient = read("public/js/family-client.js");
  const familyControllerClient = read("public/js/family-controller.js");
  const healthDocsClient = read("public/js/health-docs-client.js");
  const chatClient = read("public/js/chat-client.js");
  const chatAttachmentClient = read("public/js/chat-attachment-client.js");
  const chatComposerFocusClient = read("public/js/chat-composer-focus-client.js");
  const chatComposerController = read("public/js/chat-composer-controller.js");
  const chatMessageClient = read("public/js/chat-message-client.js");
  const chatTurnRecordsClient = read("public/js/chat-turn-records-client.js");
  const chatLayoutClient = read("public/js/chat-layout-client.js");
  const chatTurnClient = read("public/js/chat-turn-client.js");
  const chatHistoryClient = read("public/js/chat-history-client.js");
  const chatHeaderController = read("public/js/chat-header-controller.js");
  const chatStarterChipsClient = read("public/js/chat-starter-chips-client.js");
  const chatFuelContextClient = read("public/js/chat-fuel-context-client.js");
  const chatEarlierHistoryClient = read("public/js/chat-earlier-history-client.js");
  const settingsClient = read("public/js/settings-client.js");
  const settingsSurface = read("public/js/settings-surface-client.js");
  const settingsData = read("public/js/settings-data-client.js");
  const settingsDataController = read("public/js/settings-data-controller.js");
  const settingsAgents = read("public/js/settings-agents-client.js");
  const settingsAgentsController = read("public/js/settings-agents-controller.js");
  const settingsSourcesAutomationController = read("public/js/settings-sources-automation-controller.js");
  const settingsScreen = read("public/js/settings-screen.js");
  const todayCardsClient = read("public/js/today-cards-client.js");
  const publicScriptCheck = read("scripts/check-public-scripts.mjs");
  const clientBuild = read("scripts/build-client.mjs");
  const clientBuildCheck = read("scripts/check-client-build-output.mjs");
  const verifyRunner = read("scripts/run-verify.mjs");
  const smokeBrowser = read("scripts/smoke-browser.mjs");
  const smokeServer = read("scripts/smoke-server.mjs");
  const smokeHttp = read("test/smoke.mjs");
  const ui = read("public/js/02-ui.js");
  const uiSegments = read("public/js/ui-segments-client.js");
  const today = read("public/js/03-today.js");
  const todayCompatibilityBridges = read("public/js/today-compatibility-bridges.js");
  const progress = read("public/js/05-progress.js");
  const meals = read("public/js/06-coach-meals.js");
  const health = read("public/js/07-me-health.js");
  const records = read("public/js/08-me-records.js");
  const chat = read("public/js/09-plan-chat.js");
  const boot = read("public/js/10-boot.js");
  const sw = read("public/sw.js");
  const dockerfile = read("Dockerfile");
  const gitignore = read(".gitignore");
  const dockerignore = read(".dockerignore");
  assert.match(today, /CairnTodayScreenRuntime\.create/);
  assert.match(todayCompatibilityBridges, /CairnTodayCompatibilityBridges/);
  assert.match(todayScreenRuntimeSource, /function deps\(\): ClientTodayDependenciesContext/);
  assert.match(todayScreenRuntimeSource, /depsCache = CairnTodayScreenRuntimeDeps\.create/);
  assert.match(todayScreenRuntimeDepsSource, /CairnTodayDependencies\.context/);
  assert.match(todayScreenRuntimeSource, /CairnTodayCompatibilityBridges\.create/);
  assert.doesNotMatch(today, /const todayDeps = CairnTodayDependencies\.context/);
  assert.equal(pkg.scripts.dev, "npm run client:build && tsx watch src/server.ts");
  assert.equal(pkg.scripts.build, "npm run client:check && npm run client:build && npm run tsc --");
  assert.equal(pkg.scripts.tsc, "node node_modules/typescript-7/bin/tsc");
  assert.equal(pkg.scripts["client:check"], "npm run tsc -- -p tsconfig.client.build.json --noEmit");
  assert.equal(pkg.scripts["client:build"], "node scripts/build-client.mjs");
  assert.match(pkg.scripts["typecheck:client"], /npm run tsc -- -p tsconfig\.client\.json && npm run client:check/);
  assert.equal(pkg.scripts["public:check"], "node scripts/check-public-scripts.mjs");
  assert.equal(pkg.scripts["presmoke:browser"], "npm run build");
  assert.equal(pkg.scripts["smoke:browser"], "node scripts/smoke-browser.mjs");
  assert.equal(pkg.scripts["smoke:browser:built"], "node scripts/smoke-browser.mjs");
  assert.equal(pkg.scripts["release:check"], "npm run verify && npm run smoke:built && npm run smoke:browser:built");
  assert.equal(pkg.scripts.verify, "node scripts/run-verify.mjs");
  assert.match(verifyRunner, /npm",\s*"run",\s*"typecheck:client"/);
  assert.match(verifyRunner, /node",\s*"scripts\/check-client-build-output\.mjs"/);
  assert.match(verifyRunner, /npm",\s*"run",\s*"public:check"/);
  assert.match(verifyRunner, /const buildJobs = \[/);
  assert.match(verifyRunner, /const postBuildJobs = \[/);
  assert.match(smokeHttp, /from "\.\.\/scripts\/smoke-server\.mjs"/);
  assert.match(smokeServer, /export async function startBuiltServer/);
  assert.match(smokeServer, /DATA_DIR: dir/);
  assert.match(smokeBrowser, /CHROME_BIN/);
  assert.match(smokeBrowser, /Runtime\.exceptionThrown/);
  assert.match(smokeBrowser, /Network\.responseReceived/);
  assert.match(smokeBrowser, /registerJobReconnector/);
  assert.match(smokeBrowser, /registerAppJobReconnectors/);
  assert.match(smokeBrowser, /installMobileViewportGuards/);
  assert.match(smokeBrowser, /CairnTodayAddExerciseController/);
  assert.match(smokeBrowser, /CairnDayFuelController/);
  assert.match(smokeBrowser, /CairnMeMemoryController/);
  assert.match(smokeBrowser, /freeDebugPort/);
  assert.match(smokeBrowser, /Page\.navigate/);
  assert.match(smokeBrowser, /expectedState/);
  assert.match(smokeBrowser, /\/app\/me\/memory/);
  assert.match(smokeBrowser, /meSeg: "memory"/);
  assert.match(smokeBrowser, /\/app\/me\/family/);
  assert.match(smokeBrowser, /meSeg: "family"/);
  assert.match(smokeBrowser, /progressSeg: "energy"/);
  assert.match(smokeBrowser, /setSeg: "data"/);
  assert.match(smokeBrowser, /async function smokeTodayAddExercise/);
  assert.match(smokeBrowser, /#addExBtn/);
  assert.match(smokeBrowser, /Today adds a custom off-plan card/);
  assert.match(smokeBrowser, /async function smokeChatAttachmentFocus/);
  assert.match(smokeBrowser, /async function smokeSettingsDataControls/);
  assert.match(smokeBrowser, /#updateCheckEnabled/);
  assert.match(smokeBrowser, /#phoneGenToken/);
  assert.match(smokeBrowser, /async function smokeProgressSegmentNavigation/);
  assert.match(smokeBrowser, /data-seg="program"/);
  assert.match(smokeBrowser, /async function smokePlanSegmentNavigation/);
  assert.match(smokeBrowser, /#dayFuelSlot/);
  assert.match(smokeBrowser, /async function smokeHealthInnerNavigation/);
  assert.match(smokeBrowser, /\[data-allmarkers\]/);
  assert.match(smokeBrowser, /\/app\/stand\/records/);
  assert.match(smokeBrowser, /resetFocusAfterNativePicker/);
  assert.match(smokeBrowser, /cairn:keyboard-settle/);
  assert.match(smokeBrowser, /kb-geometry-open/);
  assert.match(verifyRunner, /await runGroup\("build", buildJobs\);\nawait runGroup\("post-build", postBuildJobs\);/);
  assert.match(rootTsconfig, /"tsBuildInfoFile": "\.tsbuildcache\/server\.tsbuildinfo"/);
  assert.match(rootTsconfig, /"exclude": \["src\/client\/\*\*\/\*\.ts"\]/);
  assert.match(clientTsconfig, /"tsBuildInfoFile": "\.tsbuildcache\/client\.tsbuildinfo"/);
  assert.match(contracts, /export type ClientCoachingFocusDomain = "training" \| "running" \| "nutrition" \| "health" \| "recovery" \| "body"/);
  assert.doesNotMatch(contracts, /domain: ClientCoachingFocusDomain \| string/);
  assert.match(clientTsconfig, /"allowJs": true/);
  assert.match(clientTsconfig, /"checkJs": true/);
  assert.match(clientTsconfig, /"noEmit": true/);
  assert.match(clientTsconfig, /src\/contracts\/client-globals\.d\.ts/);
  assert.match(clientGlobals, /declare function fmtWeight\(weight: unknown\): string/);
  assert.match(clientGlobals, /declare function formatFoodNum\(value: unknown\): string/);
  assert.match(clientGlobals, /declare function fmtKm\(km: unknown\): string/);
  assert.match(clientShellGlobals, /declare global \{/);
  assert.match(clientShellGlobals, /declare let pollToken: number/);
  assert.match(clientShellGlobals, /declare const PROGRESS_SEG: readonly ClientSegment\[\]/);
  assert.match(clientShellGlobals, /declare const PROGRESS_HANDLERS: Record<string, \(\) => unknown>/);
  assert.match(clientShellGlobals, /declare const PLAN_HANDLERS: Record<string, \(\) => unknown>/);
  assert.match(clientShellGlobals, /declare const art: \(fn: string, \.\.\.args: unknown\[\]\) => string/);
  assert.match(clientShellGlobals, /declare const stagger: \(index\?: number \| null\) => string/);
  assert.match(clientShellGlobals, /declare const reducedMotion: \(\) => boolean/);
  assert.match(clientShellGlobals, /declare const fmtK: \(value: unknown\) => string/);
  assert.match(clientShellGlobals, /declare function withViewTransition\(fn: \(\) => unknown\): Promise<unknown>/);
  assert.match(clientGlobals, /declare function relAge\(iso: string\): string/);
  assert.match(clientGlobals, /declare function mdToHtml\(source: unknown\): string/);
  assert.match(clientGlobals, /CairnMarkdown/);
  assert.match(clientGlobals, /declare function cardioPrescription\(item: Record<string, unknown> \| null \| undefined\): string/);
  assert.match(clientGlobals, /CairnCardioPlan/);
  assert.match(clientGlobals, /declare function cardioSyncLine/);
  assert.match(clientGlobals, /CairnCardioSync/);
  assert.match(clientGlobals, /declare function enduranceBlockHtml/);
  assert.match(clientGlobals, /declare function paceTrendWord\(trend: unknown\): string/);
  assert.match(clientGlobals, /declare function zoneBarHtml\(zones: unknown\): string/);
  assert.match(clientGlobals, /ClientSportBests/);
  assert.match(clientGlobals, /declare function enduranceBestRows\(group: ClientSportBests \| null \| undefined\): Array<\{ label: string; val: string; date: string; type: string \}>/);
  assert.match(clientGlobals, /declare function enduranceSportCardHtml\(group: ClientSportBests \| null \| undefined, idx: number\): string/);
  assert.match(clientGlobals, /CairnProgressEndurance/);
  assert.match(clientGlobals, /type ClientProgressEnduranceControllerDeps = \{/);
  assert.match(clientGlobals, /CairnProgressEnduranceController/);
  assert.match(clientGlobals, /type ClientProgressRouteDeps = \{/);
  assert.match(clientGlobals, /CairnProgressRouteDeps/);
  assert.match(clientGlobals, /declare function withToken\(url: string\): string/);
  assert.match(clientGlobals, /declare function downloadFile\(href: string\): void/);
  assert.match(clientGlobals, /declare function api<Path extends string>/);
  assert.match(clientState, /export type ClientAppState = \{/);
  assert.match(clientState, /export type ClientBriefCache = \{/);
  assert.match(clientGlobals, /type ClientAppState = ContractClientAppState/);
  assert.match(clientGlobals, /type ClientBriefCache = ContractClientBriefCache/);
  assert.match(clientGlobals, /type ClientProgressSection = ContractClientProgressSection/);
  assert.match(clientGlobals, /type ClientAppRouterApi = \{/);
  assert.match(clientGlobals, /declare const state: ClientAppState/);
  assert.match(clientGlobals, /declare function \$<T extends Element = Element>/);
  assert.match(clientGlobals, /CairnProgressFocus/);
  assert.match(clientGlobals, /hasFocusCard\(\): boolean/);
  assert.match(clientGlobals, /declare function cachedApi<Path extends string>/);
  assert.match(clientGlobals, /declare function paintSWR<Path extends string>/);
  assert.match(clientGlobals, /declare function measureChatTop\(\): void/);
  assert.match(clientGlobals, /CairnChatClient/);
  assert.match(clientGlobals, /CairnChatAttachment/);
  assert.match(clientGlobals, /CairnChatComposerFocus/);
  assert.match(clientGlobals, /CairnChatLayout/);
  assert.match(clientGlobals, /shellHtml\(\): string/);
  assert.match(clientGlobals, /headerActionsHtml\(\): string/);
  assert.match(clientGlobals, /starterChipsHtml\(starters\?: readonly unknown\[\]\): string/);
  assert.match(clientGlobals, /dividerHtml\(iso: unknown, label: unknown\): string/);
  assert.match(clientGlobals, /CairnExerciseDetail/);
  assert.match(clientGlobals, /explanationHtml\(/);
  assert.match(clientGlobals, /validExplanationPayload\(payload:/);
  assert.match(clientGlobals, /CairnExerciseDetailController/);
  assert.match(clientGlobals, /declare function wireGuides\(scope\?: ParentNode \| null\): void/);
  assert.match(clientGlobals, /declare function replaceExerciseExplanation\(/);
  assert.match(clientGlobals, /installMobileViewportGuards\(\): void/);
  assert.match(clientGlobals, /registerServiceWorkerLifecycle\(\): void/);
  assert.match(clientGlobals, /primeDiscipline\(\): void/);
  assert.match(clientGlobals, /openOnboarding\(\): void/);
  assert.match(clientGlobals, /startAppShell\(\): void/);
  assert.match(clientGlobals, /declare function armDelete\(/);
  assert.match(clientGlobals, /declare function mountSaveBar/);
  assert.match(clientGlobals, /type ClientSaveBar = \{ markDirty\(\): void; save\(\): Promise<void> \}/);
  assert.match(clientGlobals, /declare function segBar\(active: string, items: readonly ClientSegment\[\]\): string/);
  assert.match(clientGlobals, /declare function renderPhoneCoachBanner\(container: Element \| null \| undefined\): void/);
  assert.match(clientGlobals, /CairnPwaInstall/);
  assert.match(clientGlobals, /declare function startRest\(seconds\?: number\): void/);
  assert.match(clientGlobals, /CairnRestTimer/);
  assert.match(clientGlobals, /declare function progressHero/);
  assert.match(clientGlobals, /CairnProgressComponents/);
  assert.match(clientGlobals, /CairnProgressLineChartModel/);
  assert.match(clientGlobals, /CairnProgressChartScrub/);
  assert.match(clientGlobals, /CairnProgressChartDrawing/);
  assert.match(clientGlobals, /declare function withAlpha\(hex: unknown, alpha: number\): string/);
  assert.match(clientGlobals, /declare function drawLineChart/);
  assert.match(clientGlobals, /CairnProgressChart/);
  assert.match(clientGlobals, /CairnProgressTrendWeight/);
  assert.match(clientGlobals, /CairnProgressHistoryModel/);
  assert.match(clientGlobals, /CairnProgressHistoryRender/);
  assert.match(clientGlobals, /declare function sessionCardHtml\(session: unknown, index: number\): string/);
  assert.match(clientGlobals, /declare function numOrNull\(value: unknown\): number \| null/);
  assert.match(clientGlobals, /declare function setsTonnage\(sets: unknown\): number/);
  assert.match(clientGlobals, /CairnTodaySessionStatus/);
  assert.match(clientGlobals, /setChipHtml\(set: Record<string, unknown> \| null \| undefined, index\?: number\): string/);
  assert.match(clientGlobals, /feedbackFormHtml\(session: Record<string, unknown> \| null \| undefined\): string/);
  assert.match(clientGlobals, /type ClientTodaySessionFeedbackDeps = Pick<ClientTodaySessionControllerDeps/);
  assert.match(clientGlobals, /CairnTodaySessionFeedback/);
  assert.match(clientGlobals, /type ClientTodaySessionSkipDeps = Pick<ClientTodaySessionControllerDeps/);
  assert.match(clientGlobals, /CairnTodaySessionSkip/);
  assert.match(clientGlobals, /type ClientTodaySessionSetModelApi = \{/);
  assert.match(clientGlobals, /type ClientTodaySessionSetActionsApi = \{/);
  assert.match(clientGlobals, /CairnTodaySessionSetModel/);
  assert.match(clientGlobals, /CairnTodaySessionSetActions/);
  assert.match(clientGlobals, /type ClientTodayBriefOverrideRunOptions = ClientAgentOpHandlers/);
  assert.match(clientGlobals, /CairnTodayBriefOverrideClient/);
  assert.match(clientGlobals, /type ClientTodaySessionControllerDeps = \{/);
  assert.match(clientGlobals, /CairnTodaySessionController/);
  assert.match(clientGlobals, /wireSessionSurface\(options: ClientTodaySessionSurfaceOptions, deps: ClientTodaySessionControllerDeps\): void/);
  assert.match(clientGlobals, /CairnTodayProgramAdjustments/);
  assert.match(clientGlobals, /bannerHtml\(rows: unknown\): string/);
  assert.match(clientGlobals, /planRequest\(adjustment: unknown\): string/);
  assert.match(clientGlobals, /CairnTodayWeekAhead/);
  assert.match(clientGlobals, /cardHtml\(read: unknown\): string/);
  assert.match(clientGlobals, /ClientWeekAheadDayKind/);
  assert.match(clientGlobals, /CairnTodayContext/);
  assert.match(clientGlobals, /contextBannerHtml\(events: unknown, todayISO\?: string\): string/);
  assert.match(clientGlobals, /goalLineHtml\(stats: unknown, currentWeight: unknown, isToday: unknown, todayISO\?: string\): string/);
  assert.match(clientGlobals, /healthFocusBannerHtml\(data: unknown\): string/);
  assert.match(clientGlobals, /CairnTodayCompass/);
  assert.match(clientGlobals, /paceOffer\(stats: unknown, currentWeight: unknown\): \{ status: string; line: string; ask: string \} \| null/);
  assert.match(clientGlobals, /cellsHtml: string/);
  assert.match(clientGlobals, /CairnTodayGarminReconciliation/);
  assert.match(clientGlobals, /root: ParentNode \| null \| undefined/);
  assert.match(clientGlobals, /refreshToday\(options: \{ soft: boolean \}\): unknown/);
  assert.match(clientGlobals, /CairnProgressHistory/);
  assert.match(clientGlobals, /declare function weeklyRunPlanCard\(plan: ClientWeeklyRunPlan \| null \| undefined\): string/);
  assert.match(clientGlobals, /CairnProgressRunPlan/);
  assert.match(clientGlobals, /declare function volBalanceHtml\(balance: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressVolume/);
  assert.match(clientGlobals, /declare function kcalFmt\(value: unknown\): string/);
  assert.match(clientGlobals, /declare function energyRead\(exp: unknown\)/);
  assert.match(clientGlobals, /CairnProgressEnergy/);
  assert.match(clientGlobals, /CairnProgressEnergySurface/);
  assert.match(clientGlobals, /reconnectNutritionCheckin\(\): ClientAgentOpHandlers \| null/);
  assert.match(clientGlobals, /energyBodyHtml\(exp: unknown\): \{ heroHtml: string; cardHtml: string \}/);
  assert.match(clientGlobals, /nutritionCheckinProposalHtml\(result: unknown\): string/);
  assert.match(clientGlobals, /declare function calMonthHtml\(ym: string, byDate: Map<string, unknown>, todayIso: string, idx: number\): string/);
  assert.match(clientGlobals, /CairnProgressCalendar/);
  assert.match(clientGlobals, /declare function loadMuscleTrajectory\(\): Promise<void>/);
  assert.match(clientGlobals, /declare function muscleTrajectoryHtml\(trajectory: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressMuscleTrajectory/);
  assert.match(clientGlobals, /declare function dexaTargetingHtml\(targeting: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressDexaTargeting/);
  assert.match(clientGlobals, /ClientPerformanceStanding/);
  assert.match(clientGlobals, /declare function performanceHtml\(performance: ClientPerformanceStanding \| null \| undefined, options\?: \{ suppressLever\?: boolean \}\): string/);
  assert.match(clientGlobals, /CairnProgressPerformance/);
  assert.match(clientGlobals, /declare function programAdjustmentsHtml\(rows: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressProgramAdjustments/);
  assert.match(clientGlobals, /declare function testWeekBannerHtml\(testWeek: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressTestWeek/);
  assert.match(clientGlobals, /ClientProgramState/);
  assert.match(clientGlobals, /declare function liftStatusWord\(lift: ClientProgramState\["lifts"\]\[number\] \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare function liftTrendFig\(lift: ClientProgramState\["lifts"\]\[number\] \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare function liftBestFig\(lift: ClientProgramState\["lifts"\]\[number\] \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare function sortLifts\(lifts: ClientProgramState\["lifts"\] \| null \| undefined\): ClientProgramState\["lifts"\]/);
  assert.match(clientGlobals, /declare function volBandWord\(band: unknown\): string/);
  assert.match(clientGlobals, /declare function volTrendGlyph\(trend: unknown\): string/);
  assert.match(clientGlobals, /declare function liftRowHtml\(lift: ClientProgramState\["lifts"\]\[number\] \| null \| undefined, index: number\): string/);
  assert.match(clientGlobals, /declare function volumeBlockHtml\(volume: ClientProgramState\["volume"\] \| null \| undefined, startIdx: number\): string/);
  assert.match(clientGlobals, /declare function mesoBlockHtml\(meso: ClientProgramState\["mesocycle"\] \| null \| undefined, index: number\): string/);
  assert.match(clientGlobals, /declare function adaptationsHtml\(adaptations: string\[\] \| null \| undefined, index: number\): string/);
  assert.match(clientGlobals, /CairnProgressProgramSummary/);
  assert.match(clientGlobals, /declare function phaseWord\(phase: unknown\): string/);
  assert.match(clientGlobals, /declare function blockFocusWord\(focus: unknown\): string/);
  assert.match(clientGlobals, /declare function activeBlockHtml\(block: ClientProgramBlock \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare function startBlockHtml\(\): string/);
  assert.match(clientGlobals, /declare function loadProgramBlock\(\): Promise<void>/);
  assert.match(clientGlobals, /declare function wireProgramBlock\(slot: Element\): void/);
  assert.match(clientGlobals, /CairnProgressProgramBlock/);
  assert.match(clientGlobals, /type ClientProgressProgramControllerDeps = \{/);
  assert.match(clientGlobals, /CairnProgressProgramController/);
  assert.match(clientGlobals, /declare function healthDocHtml\(doc: unknown, index\?: number\): string/);
  assert.match(clientGlobals, /CairnHealthDocs/);
  assert.match(clientGlobals, /CairnHealthEvidence/);
  assert.match(clientGlobals, /CairnHealthMarkerOrder/);
  assert.match(clientGlobals, /orderMarkersForDisplay<T extends \{ name\?: unknown; key\?: unknown \}>/);
  assert.match(clientGlobals, /H_FILE_PROMPT: string/);
  assert.match(clientGlobals, /guessUploadMime/);
  assert.match(clientGlobals, /directiveHtml/);
  assert.match(clientGlobals, /CairnHealthPicture/);
  assert.match(clientGlobals, /reviewHtml\(/);
  assert.match(clientGlobals, /ClientHealthPictureControllerDeps/);
  assert.match(clientGlobals, /CairnHealthPictureController/);
  assert.match(clientGlobals, /loadHealthPicture\(token: number, docsPromise: Promise<unknown>/);
  assert.match(clientGlobals, /CairnHealthMarkers/);
  assert.match(clientGlobals, /hmkRowHtml\(/);
  assert.match(clientGlobals, /ClientHealthMarkersControllerDeps/);
  assert.match(clientGlobals, /CairnHealthMarkersController/);
  assert.match(clientGlobals, /load\(deps: ClientHealthMarkersControllerDeps, token: number\): void/);
  assert.match(clientGlobals, /CairnHealthDirectives/);
  assert.match(clientGlobals, /directivesSectionHtml\(/);
  assert.match(clientGlobals, /CairnHealthDirectiveLoader/);
  assert.match(clientGlobals, /load\(token: number\): Promise<void>/);
  assert.match(clientGlobals, /CairnHealthStandingPrimitives/);
  assert.match(clientGlobals, /ClientHealthStandingPrimitivesApi/);
  assert.match(clientGlobals, /CairnHealthStanding/);
  assert.match(clientGlobals, /ClientHealthStanding/);
  assert.match(clientGlobals, /renderHealthStandingHtml\(data: ClientHealthStanding \| null \| undefined/);
  assert.match(clientGlobals, /ClientHealthStandingControllerDeps/);
  assert.match(clientGlobals, /CairnHealthStandingController/);
  assert.match(clientGlobals, /paintReview\(deps: ClientHealthStandingControllerDeps\): void/);
  assert.match(clientGlobals, /openBpSheet\(deps: ClientHealthStandingControllerDeps\): void/);
  assert.match(clientGlobals, /CairnHealthRead/);
  assert.match(clientGlobals, /priorityMarkersSectionHtml\(/);
  assert.match(clientGlobals, /CairnHealthRecords/);
  assert.match(clientGlobals, /recordsListHtml\(/);
  assert.match(clientGlobals, /CairnHealthDocUploadController/);
  assert.match(clientGlobals, /wireUpload\(deps: ClientHealthDocUploadControllerDeps\): void/);
  assert.match(clientGlobals, /CairnHealthRecordsController/);
  assert.match(clientGlobals, /render\(deps: ClientHealthRecordsControllerDeps\): Promise<ClientHealthDocument\[\]>/);
  assert.match(clientGlobals, /type ClientHealthShareControllerDeps = \{/);
  assert.match(clientGlobals, /CairnHealthShareController/);
  assert.match(clientGlobals, /render\(deps: ClientHealthShareControllerDeps\): void/);
  assert.match(clientGlobals, /CairnFoodNote/);
  assert.match(clientGlobals, /noteEntryHtml\(note: Record<string, unknown>, index\?: number\): string/);
  assert.match(clientGlobals, /CairnFoodDetailController/);
  assert.match(clientGlobals, /declare function openFoodDetail\(note: unknown, fromTile\?: Element \| null\): Promise<void>/);
  assert.match(clientGlobals, /CairnPlanEndurance/);
  assert.match(clientGlobals, /CairnPlanEditor/);
  assert.match(clientGlobals, /progDayHtml\(/);
  assert.match(clientGlobals, /CairnPlanEditorForm/);
  assert.match(clientGlobals, /syncModel\(/);
  assert.match(clientGlobals, /CairnPlanEditorController/);
  assert.match(clientGlobals, /serializeDays\(/);
  assert.match(clientGlobals, /CairnDayFuel/);
  assert.match(clientGlobals, /CairnDayFuelController/);
  assert.match(clientGlobals, /loadDayFuel\(\s*token: number,/);
  assert.match(clientGlobals, /declare function dayFuelHtml\(day: Record<string, unknown> \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare const MEAL_LABEL: Record<string, string>/);
  assert.match(clientGlobals, /CairnMealRows: ClientMealRowsApi/);
  assert.match(clientGlobals, /declare const mealRowHtml: Window\["mealRowHtml"\]/);
  assert.match(clientGlobals, /CairnMealPlan/);
  assert.match(clientGlobals, /MEAL_PREFS_PLACEHOLDER: string/);
  assert.match(clientGlobals, /currentMealPlan\(plans: unknown\): Record<string, unknown> \| null/);
  assert.match(clientGlobals, /mealPlannerBodyHtml\(current: unknown, mealPrefs: unknown/);
  assert.match(clientGlobals, /mealPlanListHtml\(plans: unknown\): string/);
  assert.match(clientGlobals, /mealDayHtml\(day: unknown, dayIndex: number/);
  assert.match(clientGlobals, /CairnMealPlannerController/);
  assert.match(clientGlobals, /renderMealPlans\(plans: unknown, selector\?: string/);
  assert.match(clientGlobals, /CairnMealSwapController/);
  assert.match(clientGlobals, /reconnectMealSwap\(job\?: unknown\): ClientAgentOpHandlers \| null/);
  assert.match(clientGlobals, /CairnMealRecipe/);
  assert.match(clientGlobals, /recipeHtml\(recipe: unknown\): string/);
  assert.match(clientGlobals, /loadingHtml\(\): string/);
  assert.match(clientGlobals, /CairnMealRecipeController/);
  assert.match(clientGlobals, /openMealSheet\(current: Record<string, unknown> & \{ id: string \| number \}, dayIndex: number, mealIndex: number\): void/);
  assert.match(clientGlobals, /CairnProposal/);
  assert.match(clientGlobals, /declare function applyResultMessage\(result: unknown\): \{ failed: boolean; message: string \}/);
  assert.match(clientGlobals, /declare function verifiedBadgeHtml\(verified: unknown\): string/);
  assert.match(clientGlobals, /declare function strengthChangeHtml\(change: unknown\): string/);
  assert.match(clientGlobals, /runTargetText\(run: Record<string, unknown>\): string/);
  assert.match(clientGlobals, /CairnCaptureProvenance/);
  assert.match(clientGlobals, /loadTrainingProvenance\(isToday\?: boolean\): Promise<void>/);
  assert.match(clientGlobals, /CairnCaptureReadDate: CaptureReadDateApi/);
  assert.match(clientGlobals, /CairnCaptureReadCards: CaptureReadCardsApi/);
  assert.match(clientGlobals, /CairnCaptureReadJobs: CaptureReadJobsApi/);
  assert.match(clientGlobals, /CairnCaptureReads: CaptureReadsRuntime/);
  assert.match(clientGlobals, /CairnTodaySessionSuggest/);
  assert.match(clientGlobals, /CairnTodaySessionSuggestController/);
  assert.match(clientGlobals, /suggestedSession\?: ClientSessionSuggestion \| null/);
  assert.match(clientGlobals, /cardHtml\(session: Partial<ClientSessionSuggestion>/);
  assert.match(clientGlobals, /askForSession\(/);
  assert.match(clientGlobals, /reconnectSessionSuggest\(job: unknown/);
  assert.match(clientGlobals, /declare function learnedTimelineHtml\(data: ClientLearnedTimeline \| null \| undefined\): string/);
  assert.match(clientGlobals, /CairnHealthLearned/);
  assert.match(clientGlobals, /CairnMemory/);
  assert.match(clientGlobals, /memoryRowHtml\(row: ClientMemory, index\?: number\): string/);
  assert.match(clientGlobals, /type ClientMeMemoryControllerDeps = \{/);
  assert.match(clientGlobals, /CairnMeMemoryController/);
  assert.match(clientGlobals, /render\(deps: ClientMeMemoryControllerDeps\): Promise<void>/);
  assert.match(clientGlobals, /type ClientMeHealthTabsControllerDeps = \{/);
  assert.match(clientGlobals, /CairnMeHealthTabsController/);
  assert.match(clientGlobals, /renderHealth\(deps: ClientMeHealthTabsControllerDeps\): Promise<void>/);
  assert.match(clientGlobals, /CairnMeHealthDependencies/);
  assert.match(clientGlobals, /CairnLife/);
  assert.match(clientGlobals, /lifeEventHtml/);
  assert.match(clientGlobals, /type ClientLifeControllerDeps = \{/);
  assert.match(clientGlobals, /CairnLifeController/);
  assert.match(clientGlobals, /render\(deps: ClientLifeControllerDeps\): Promise<void>/);
  assert.match(clientGlobals, /CairnFamily/);
  assert.match(clientGlobals, /familyCardHtml\(row: Record<string, unknown>, index\?: number\): string/);
  assert.match(clientGlobals, /type ClientFamilyControllerDeps = \{/);
  assert.match(clientGlobals, /CairnFamilyController/);
  assert.match(clientGlobals, /render\(deps: ClientFamilyControllerDeps\): Promise<void>/);
  assert.match(clientGlobals, /CairnMeProfileForm/);
  assert.match(clientGlobals, /html\(\s*deps: MeProfileControllerDeps,\s*profile: MeProfileProfile,\s*goal: MeProfileGoalCheck,\s*context: MeProfileFormContext,/);
  assert.match(clientGlobals, /CairnMeProfileController/);
  assert.match(clientGlobals, /renderProfile\(deps: MeProfileControllerDeps\): Promise<void>/);
  assert.match(clientGlobals, /declare function coachingFocusCardHtml\(/);
  assert.match(clientGlobals, /declare function coachingFocusCompactHtml\(focus: ClientCoachingFocus \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare function loadCoachingFocus\(slotSelector: string, root\?: ParentNode \| null\): Promise<void>/);
  assert.match(clientGlobals, /CairnCoachingFocus/);
  assert.match(clientGlobals, /declare function settingsRouteRowsHtml/);
  assert.match(clientGlobals, /declare function switchTab\(tab: unknown/);
  assert.match(clientGlobals, /declare function registerTabBarHandlers\(\): void/);
  assert.match(clientGlobals, /declare function routeApi\(\): ClientRoutesApi \| null/);
  assert.match(clientGlobals, /declare function currentRouteState\(\): Partial<ClientRoute>/);
  assert.match(clientGlobals, /CairnRoutes\?: ClientRoutesApi/);
  assert.match(clientGlobals, /declare function actEntryHtml\(activity: ClientActivity & Record<string, unknown>\): string/);
  assert.match(clientGlobals, /CairnTodayActivity/);
  assert.match(clientGlobals, /declare function reshapeToday\(\): Promise<void>/);
  assert.match(clientGlobals, /declare function renderToday\(\): unknown/);
  assert.match(clientGlobals, /declare function updateHeaderCondense\(\): void/);
  assert.match(clientGlobals, /CairnUiHeader/);
  assert.match(clientGlobals, /setTodayHeaderTitle\(deps: \{/);
  assert.match(clientGlobals, /declare function setDiscipline\(discipline: unknown\): string/);
  assert.match(clientGlobals, /CairnTodayRailController/);
  assert.match(clientGlobals, /CairnTodayRailLoaders/);
  assert.match(clientGlobals, /type ClientTodayRailControllerDeps = \{/);
  assert.match(clientGlobals, /CairnTodayPlanSelection/);
  assert.match(clientGlobals, /type ClientTodayPlanSelectionDeps = \{/);
  assert.match(clientGlobals, /CairnTodayProgressionController/);
  assert.match(clientGlobals, /refreshAdaptedRx\(deps: Parameters<Window\["CairnTodayProgressionController"\]\["scheduleRxRefresh"\]>\[0\]\): Promise<void>/);
  assert.match(clientGlobals, /CairnTodayAddExerciseController/);
  assert.match(clientGlobals, /appendOffPlanCard\(name: string, mode: string \| null \| undefined/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/date-utils\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/html-utils\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/markdown-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/ui-components\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/ui-feedback-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/ui-actions-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/ui-view-transitions-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/exercise-detail-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/exercise-detail-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/format-utils\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/api-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-download\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-sw-recovery\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/01-core\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/02-ui\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/pwa-install-coach\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/rest-timer\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/coaching-focus-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-activity-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/save-bar\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/swr-cache\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-agenda-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-rail-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-training-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-progression-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-add-exercise-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-brief-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-brief-override-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-brief-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/cardio-plan-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/cardio-sync-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/proposal-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-suggest-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-suggest-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-status-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-feedback-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-skip-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-set-model\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-set-actions\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-cards-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-program-adjustments-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-week-ahead-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-context-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-side-loaders\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-plan-session-model\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-plan-session-data-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-plan-session-preparation\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-data-loader\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-main-shell-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-plan-surface-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-plan-surface-renderer\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-render-state-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-post-render-wiring\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-data-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-endurance-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-components-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-line-chart-model\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-chart-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-trend-weight-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-history-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-run-plan-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-route-deps-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-endurance-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-volume-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-energy-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-energy-surface-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-calendar-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-muscle-trajectory-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-dexa-targeting-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-performance-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-adjustments-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-test-week-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-summary-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-block-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/04-capture\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-attachment-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-composer-focus-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-composer-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-message-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-turn-records-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-turn-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-history-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/plan-endurance-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/day-fuel-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/meal-row-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/meal-plan-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/meal-recipe-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/food-note-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/food-detail-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/me-profile-form-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/me-profile-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/me-health-tabs-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/health-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/health-learned-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/memory-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/me-memory-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/life-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/family-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/family-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/07-me-health\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/health-docs-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-surface-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-data-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-data-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-agents-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-agents-controller\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-screen\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/route-state\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-router\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-route-sync\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-render-dispatch\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-tabs\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/agent-job-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-job-reconnectors\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-mobile-viewport\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-service-worker\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-discipline-primer\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-onboarding\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-startup\.js/);
  assert.match(
    clientBuildTsconfig,
    /"include": \["src\/contracts\/client-globals\.d\.ts", "src\/client\/\*\*\/\*\.ts"\]/
  );
  assert.doesNotMatch(clientBuildTsconfig, /client-shell-globals/);
  assert.match(clientBuild, /src\/client\/date-utils\.ts/);
  assert.match(clientBuild, /public\/js\/date-utils\.js/);
  assert.match(clientBuild, /src\/client\/html-utils\.ts/);
  assert.match(clientBuild, /public\/js\/html-utils\.js/);
  assert.match(clientBuild, /src\/client\/markdown-client\.ts/);
  assert.match(clientBuild, /public\/js\/markdown-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-components\.ts/);
  assert.match(clientBuild, /public\/js\/ui-components\.js/);
  assert.match(clientBuild, /src\/client\/ui-feedback-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-feedback-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-actions-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-actions-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-view-transitions-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-view-transitions-client\.js/);
  assert.match(clientBuild, /src\/client\/exercise-detail-client\.ts/);
  assert.match(clientBuild, /public\/js\/exercise-detail-client\.js/);
  assert.match(clientBuild, /src\/client\/format-utils\.ts/);
  assert.match(clientBuild, /public\/js\/format-utils\.js/);
  assert.match(clientBuild, /src\/client\/api-client\.ts/);
  assert.match(clientBuild, /public\/js\/api-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/download\.ts/);
  assert.match(clientBuild, /public\/js\/app-download\.js/);
  assert.match(clientBuild, /src\/client\/app\/sw-recovery\.ts/);
  assert.match(clientBuild, /public\/js\/app-sw-recovery\.js/);
  assert.match(clientBuild, /src\/client\/app\/state\.ts/);
  assert.match(clientBuild, /public\/js\/01-core\.js/);
  assert.match(clientBuild, /src\/client\/art-controller\.ts/);
  assert.match(clientBuild, /public\/js\/art-controller\.js/);
  assert.match(clientBuild, /src\/client\/ui-header-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-header-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-shell\.ts/);
  assert.match(clientBuild, /public\/js\/02-ui\.js/);
  assert.match(clientBuild, /src\/client\/detail-overlay-client\.ts/);
  assert.match(clientBuild, /public\/js\/detail-overlay-client\.js/);
  assert.match(clientBuild, /src\/client\/exercise-detail-controller\.ts/);
  assert.match(clientBuild, /public\/js\/exercise-detail-controller\.js/);
  assert.match(clientBuild, /src\/client\/pwa-install-coach\.ts/);
  assert.match(clientBuild, /public\/js\/pwa-install-coach\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-model-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-model-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-assets-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-assets-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-modal-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-modal-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-session-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-session-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-client\.js/);
  assert.match(clientBuild, /src\/client\/rest-timer\.ts/);
  assert.match(clientBuild, /public\/js\/rest-timer\.js/);
  assert.match(clientBuild, /src\/client\/coaching-focus-client\.ts/);
  assert.match(clientBuild, /public\/js\/coaching-focus-client\.js/);
  assert.match(clientBuild, /src\/client\/today-activity-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-activity-client\.js/);
  assert.match(clientBuild, /src\/client\/save-bar\.ts/);
  assert.match(clientBuild, /public\/js\/save-bar\.js/);
  assert.match(clientBuild, /src\/client\/swr-cache\.ts/);
  assert.match(clientBuild, /public\/js\/swr-cache\.js/);
  assert.match(clientBuild, /src\/client\/today-agenda-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-agenda-client\.js/);
  assert.match(clientBuild, /src\/client\/today-rail-loaders-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-rail-loaders-client\.js/);
  assert.match(clientBuild, /src\/client\/today-rail-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-rail-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-selection-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-selection-client\.js/);
  assert.match(clientBuild, /src\/client\/today-training-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-training-client\.js/);
  assert.match(clientBuild, /src\/client\/today-progression-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-progression-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-add-exercise-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-add-exercise-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-override-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-override-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-actions-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-actions-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-controller\.js/);
  assert.match(clientBuild, /src\/client\/cardio-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/cardio-sync-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-sync-client\.js/);
  assert.match(clientBuild, /src\/client\/today-lately-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-lately-client\.js/);
  assert.match(clientBuild, /src\/client\/proposal-client\.ts/);
  assert.match(clientBuild, /public\/js\/proposal-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-suggest-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-suggest-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-suggest-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-suggest-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-session-status-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-status-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-feedback-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-feedback-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-skip-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-skip-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-set-model\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-set-model\.js/);
  assert.match(clientBuild, /src\/client\/today-session-set-actions\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-set-actions\.js/);
  assert.match(clientBuild, /src\/client\/today-session-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-cards-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-cards-client\.js/);
  assert.match(clientBuild, /src\/client\/today-program-adjustments-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-program-adjustments-client\.js/);
  assert.match(clientBuild, /src\/client\/today-week-ahead-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-week-ahead-client\.js/);
  assert.match(clientBuild, /src\/client\/today-context-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-context-client\.js/);
  assert.match(clientBuild, /src\/client\/today-side-loaders\.ts/);
  assert.match(clientBuild, /public\/js\/today-side-loaders\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-model\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-model\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-data-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-preparation\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-preparation\.js/);
  assert.match(clientBuild, /src\/client\/today-data-loader\.ts/);
  assert.match(clientBuild, /public\/js\/today-data-loader\.js/);
  assert.match(clientBuild, /src\/client\/today-main-shell-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-main-shell-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-surface-renderer\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-surface-renderer\.js/);
  assert.match(clientBuild, /src\/client\/today-render-state-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-render-state-client\.js/);
  assert.match(clientBuild, /src\/client\/today-post-render-wiring\.ts/);
  assert.match(clientBuild, /public\/js\/today-post-render-wiring\.js/);
  assert.match(clientBuild, /src\/client\/today-dependencies\.ts/);
  assert.match(clientBuild, /public\/js\/today-dependencies\.js/);
  assert.match(clientBuild, /src\/client\/today-screen\.ts/);
  assert.match(clientBuild, /public\/js\/03-today\.js/);
  assert.match(clientBuild, /src\/client\/capture-provenance-client\.ts/);
  assert.match(clientBuild, /public\/js\/capture-provenance-client\.js/);
  assert.match(clientBuild, /src\/client\/capture-reads-client\.ts/);
  assert.match(clientBuild, /public\/js\/capture-reads-client\.js/);
  assert.match(clientBuild, /src\/client\/capture-voice-client\.ts/);
  assert.match(clientBuild, /public\/js\/capture-voice-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-row-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-row-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-recipe-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-recipe-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-recipe-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-recipe-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-data-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-row-actions-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-row-actions-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-planner-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-planner-controller\.js/);
  assert.match(clientBuild, /src\/client\/coach-proposal-controller\.ts/);
  assert.match(clientBuild, /public\/js\/coach-proposal-controller\.js/);
  assert.match(clientBuild, /src\/client\/progress-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-data-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-components-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-components-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-line-chart-model\.ts/);
  assert.match(clientBuild, /public\/js\/progress-line-chart-model\.js/);
  assert.match(clientBuild, /src\/client\/progress-chart-scrub-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-chart-scrub-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-chart-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-chart-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-trend-weight-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-trend-weight-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-history-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-history-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-run-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-run-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-route-deps-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-route-deps-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-endurance-controller\.ts/);
  assert.match(clientBuild, /public\/js\/progress-endurance-controller\.js/);
  assert.match(clientBuild, /src\/client\/progress-volume-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-volume-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-energy-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-energy-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-energy-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-energy-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-calendar-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-calendar-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-muscle-trajectory-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-muscle-trajectory-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-dexa-targeting-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-dexa-targeting-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-performance-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-performance-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-adjustments-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-adjustments-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-test-week-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-test-week-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-summary-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-summary-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-block-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-block-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-controller\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-controller\.js/);
  assert.match(clientBuild, /src\/client\/capture-reads-client\.ts/);
  assert.match(clientBuild, /public\/js\/capture-reads-client\.js/);
  assert.match(clientBuild, /src\/client\/capture-voice-client\.ts/);
  assert.match(clientBuild, /public\/js\/capture-voice-client\.js/);
  assert.match(clientBuild, /src\/client\/capture\.ts/);
  assert.match(clientBuild, /public\/js\/04-capture\.js/);
  assert.match(clientBuild, /src\/client\/settings-routes\.ts/);
  assert.match(clientBuild, /public\/js\/settings-routes\.js/);
  assert.match(clientBuild, /src\/client\/settings-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-data-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-data-controller\.ts/);
  assert.match(clientBuild, /public\/js\/settings-data-controller\.js/);
  assert.match(clientBuild, /src\/client\/settings-agents-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-agents-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-agents-controller\.ts/);
  assert.match(clientBuild, /public\/js\/settings-agents-controller\.js/);
  assert.match(clientBuild, /src\/client\/settings-sources-automation-controller\.ts/);
  assert.match(clientBuild, /public\/js\/settings-sources-automation-controller\.js/);
  assert.match(clientBuild, /src\/client\/settings-screen\.ts/);
  assert.match(clientBuild, /public\/js\/settings-screen\.js/);
  assert.match(clientBuild, /src\/client\/chat-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-attachment-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-attachment-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-composer-focus-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-composer-focus-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-composer-controller\.ts/);
  assert.match(clientBuild, /public\/js\/chat-composer-controller\.js/);
  assert.match(clientBuild, /src\/client\/chat-message-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-message-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-turn-records-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-turn-records-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-layout-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-layout-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-turn-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-turn-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-history-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-history-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-endurance-model\.ts/);
  assert.match(clientBuild, /public\/js\/plan-endurance-model\.js/);
  assert.match(clientBuild, /src\/client\/plan-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-editor-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-editor-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-editor-form-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-editor-form-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-editor-controller\.ts/);
  assert.match(clientBuild, /public\/js\/plan-editor-controller\.js/);
  assert.match(clientBuild, /src\/client\/chat-screen\.ts/);
  assert.match(clientBuild, /public\/js\/09-plan-chat\.js/);
  assert.match(clientBuild, /src\/client\/day-fuel-client\.ts/);
  assert.match(clientBuild, /public\/js\/day-fuel-client\.js/);
  assert.match(clientBuild, /src\/client\/day-fuel-controller\.ts/);
  assert.match(clientBuild, /public\/js\/day-fuel-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-row-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-row-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-recipe-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-recipe-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-recipe-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-recipe-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-data-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-row-actions-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-row-actions-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-planner-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-planner-controller\.js/);
  assert.match(clientBuild, /src\/client\/coach-proposal-controller\.ts/);
  assert.match(clientBuild, /public\/js\/coach-proposal-controller\.js/);
  assert.match(clientBuild, /src\/client\/coach-meals-screen\.ts/);
  assert.match(clientBuild, /public\/js\/06-coach-meals\.js/);
  assert.match(clientBuild, /src\/client\/food-note-client\.ts/);
  assert.match(clientBuild, /public\/js\/food-note-client\.js/);
  assert.match(clientBuild, /src\/client\/food-detail-controller\.ts/);
  assert.match(clientBuild, /public\/js\/food-detail-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-profile-form-client\.ts/);
  assert.match(clientBuild, /public\/js\/me-profile-form-client\.js/);
  assert.match(clientBuild, /src\/client\/me-profile-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-profile-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-health-tabs-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-health-tabs-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-health-controller-deps\.ts/);
  assert.match(clientBuild, /public\/js\/me-health-controller-deps\.js/);
  assert.match(clientBuild, /src\/client\/me-health-dependencies\.ts/);
  assert.match(clientBuild, /public\/js\/me-health-dependencies\.js/);
  assert.match(clientBuild, /src\/client\/health-marker-order-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-marker-order-client\.js/);
  assert.match(clientBuild, /src\/client\/health-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-client\.js/);
  assert.match(clientBuild, /src\/client\/health-read-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-read-client\.js/);
  assert.match(clientBuild, /src\/client\/health-standing-primitives-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-standing-primitives-client\.js/);
  assert.match(clientBuild, /src\/client\/health-standing-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-standing-client\.js/);
  assert.match(clientBuild, /src\/client\/health-picture-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-picture-client\.js/);
  assert.match(clientBuild, /src\/client\/health-picture-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-picture-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-directives-loader-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-directives-loader-client\.js/);
  assert.match(clientBuild, /src\/client\/health-read-supplements-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-read-supplements-client\.js/);
  assert.match(clientBuild, /src\/client\/health-read-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-read-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-learned-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-learned-client\.js/);
  assert.match(clientBuild, /src\/client\/health-records-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-records-client\.js/);
  assert.match(clientBuild, /src\/client\/health-doc-upload-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-doc-upload-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-doc-actions-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-doc-actions-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-records-health-doc-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-records-health-doc-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-share-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-share-controller\.js/);
  assert.match(clientBuild, /src\/client\/memory-client\.ts/);
  assert.match(clientBuild, /public\/js\/memory-client\.js/);
  assert.match(clientBuild, /src\/client\/me-memory-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-memory-controller\.js/);
  assert.match(clientBuild, /src\/client\/life-client\.ts/);
  assert.match(clientBuild, /public\/js\/life-client\.js/);
  assert.match(clientBuild, /src\/client\/life-controller\.ts/);
  assert.match(clientBuild, /public\/js\/life-controller\.js/);
  assert.match(clientBuild, /src\/client\/family-client\.ts/);
  assert.match(clientBuild, /public\/js\/family-client\.js/);
  assert.match(clientBuild, /src\/client\/family-controller\.ts/);
  assert.match(clientBuild, /public\/js\/family-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-health-tabs-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-health-tabs-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-health-screen\.ts/);
  assert.match(clientBuild, /public\/js\/07-me-health\.js/);
  assert.match(clientBuild, /src\/client\/me-records-screen\.ts/);
  assert.match(clientBuild, /public\/js\/08-me-records\.js/);
  assert.match(clientBuild, /src\/client\/health-docs-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-docs-client\.js/);
  assert.match(clientBuild, /src\/client\/route-state\.ts/);
  assert.match(clientBuild, /public\/js\/route-state\.js/);
  assert.match(clientBuild, /src\/client\/app\/router\.ts/);
  assert.match(clientBuild, /public\/js\/app-router\.js/);
  assert.match(clientBuild, /src\/client\/app\/route-sync\.ts/);
  assert.match(clientBuild, /public\/js\/app-route-sync\.js/);
  assert.match(clientBuild, /src\/client\/app\/render-dispatch\.ts/);
  assert.match(clientBuild, /public\/js\/app-render-dispatch\.js/);
  assert.match(clientBuild, /src\/client\/app\/tabs\.ts/);
  assert.match(clientBuild, /public\/js\/app-tabs\.js/);
  assert.match(clientBuild, /src\/client\/agent-job-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-job-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/job-reconnectors\.ts/);
  assert.match(clientBuild, /public\/js\/app-job-reconnectors\.js/);
  assert.match(clientBuild, /src\/client\/app\/mobile-viewport\.ts/);
  assert.match(clientBuild, /public\/js\/app-mobile-viewport\.js/);
  assert.match(clientBuild, /src\/client\/app\/service-worker\.ts/);
  assert.match(clientBuild, /public\/js\/app-service-worker\.js/);
  assert.match(clientBuild, /src\/client\/app\/discipline-primer\.ts/);
  assert.match(clientBuild, /public\/js\/app-discipline-primer\.js/);
  assert.match(clientBuild, /src\/client\/today-garmin-reconciliation-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-garmin-reconciliation-client\.js/);
  assert.match(clientBuild, /src\/client\/today-side-loaders\.ts/);
  assert.match(clientBuild, /public\/js\/today-side-loaders\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-model\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-model\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-data-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-preparation\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-preparation\.js/);
  assert.match(clientBuild, /src\/client\/today-data-loader\.ts/);
  assert.match(clientBuild, /public\/js\/today-data-loader\.js/);
  assert.match(clientBuild, /src\/client\/today-main-shell-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-main-shell-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-surface-renderer\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-surface-renderer\.js/);
  assert.match(clientBuild, /src\/client\/today-render-state-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-render-state-client\.js/);
  assert.match(clientBuild, /src\/client\/today-post-render-wiring\.ts/);
  assert.match(clientBuild, /public\/js\/today-post-render-wiring\.js/);
  assert.match(clientBuild, /src\/client\/progress-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-data-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/onboarding\.ts/);
  assert.match(clientBuild, /public\/js\/app-onboarding\.js/);
  assert.match(clientBuild, /src\/client\/app\/startup\.ts/);
  assert.match(clientBuild, /public\/js\/app-startup\.js/);
  assert.match(clientBuild, /src\/client\/progress-screen\.ts/);
  assert.match(clientBuild, /public\/js\/05-progress\.js/);
  assert.ok(
    bootPos("/js/date-utils.js") > -1 && bootPos("/js/date-utils.js") < bootPos("/js/01-core.js"),
    "date-utils.js must load before 01-core.js"
  );
  assert.ok(
    bootPos("/js/date-utils.js") > -1 &&
      bootPos("/js/api-client.js") > bootPos("/js/date-utils.js") &&
      bootPos("/js/api-client.js") < bootPos("/js/app-download.js"),
    "api-client.js must load after date-utils.js and before app-download.js"
  );
  assert.ok(
    bootPos("/js/app-download.js") > bootPos("/js/api-client.js") &&
      bootPos("/js/app-download.js") < bootPos("/js/01-core.js"),
    "app-download.js must load after api-client.js and before 01-core.js"
  );
  assert.ok(
    bootPos("/js/app-sw-recovery.js") > bootPos("/js/app-download.js") &&
      bootPos("/js/app-sw-recovery.js") < bootPos("/js/01-core.js"),
    "app-sw-recovery.js must load before app state and fragile feature scripts"
  );
  assert.ok(
    bootPos("/js/art-controller.js") > bootPos("/js/01-core.js") &&
      bootPos("/js/art-controller.js") < bootPos("/js/02-ui.js"),
    "art-controller.js must load after app state/API helpers and before 02-ui.js"
  );
  assert.ok(
    bootPos("/js/pwa-install-coach.js") > bootPos("/js/01-core.js") &&
      bootPos("/js/pwa-install-coach.js") < bootPos("/js/02-ui.js"),
    "pwa-install-coach.js must load early, after app state and before feature consumers"
  );
  assert.ok(
    bootPos("/js/ui-header-client.js") > bootPos("/js/pwa-install-coach.js") &&
      bootPos("/js/ui-header-client.js") < bootPos("/js/02-ui.js"),
    "ui-header-client.js must load after app state helpers and before 02-ui.js"
  );
  assert.ok(
    bootPos("/js/agent-login-model-client.js") > bootPos("/js/exercise-detail-controller.js") &&
      bootPos("/js/agent-login-assets-client.js") > bootPos("/js/agent-login-model-client.js") &&
      bootPos("/js/agent-login-modal-client.js") > bootPos("/js/agent-login-assets-client.js") &&
      bootPos("/js/agent-login-session-client.js") > bootPos("/js/agent-login-modal-client.js") &&
      bootPos("/js/agent-login-client.js") > bootPos("/js/agent-login-session-client.js") &&
      bootPos("/js/agent-login-client.js") < bootPos("/js/agent-job-client.js") &&
      bootPos("/js/agent-login-client.js") < bootPos("/js/settings-screen.js"),
    "agent-login helpers must load in dependency order before Settings can launch agent login"
  );
  assert.ok(
    bootPos("/js/agent-job-client.js") > bootPos("/js/agent-login-client.js") &&
      bootPos("/js/agent-job-client.js") < bootPos("/js/rest-timer.js") &&
      bootPos("/js/agent-job-client.js") < bootPos("/js/03-today.js") &&
      bootPos("/js/agent-job-client.js") < bootPos("/js/09-plan-chat.js") &&
      bootPos("/js/agent-job-client.js") < bootPos("/js/app-job-reconnectors.js"),
    "agent-job-client.js must load after UI and agent-login helpers and before job consumers/reconnectors"
  );
  assert.ok(
    bootPos("/js/html-utils.js") > -1 && bootPos("/js/html-utils.js") < bootPos("/js/02-ui.js"),
    "html-utils.js must load before 02-ui.js and feature modules"
  );
  assert.ok(
    bootPos("/js/markdown-client.js") > bootPos("/js/html-utils.js") &&
      bootPos("/js/markdown-client.js") < bootPos("/js/09-plan-chat.js"),
    "markdown-client.js must load after escaping helpers and before chat markdown consumers"
  );
  assert.ok(
    bootPos("/js/ui-components.js") > bootPos("/js/html-utils.js") &&
      bootPos("/js/ui-components.js") < bootPos("/js/health-client.js"),
    "ui-components.js must load after escaping helpers and before component consumers"
  );
  assert.ok(
    bootPos("/js/ui-feedback-client.js") > bootPos("/js/ui-components.js") &&
      bootPos("/js/ui-feedback-client.js") < bootPos("/js/ui-actions-client.js"),
    "ui-feedback-client.js must load after shared UI components and before UI actions"
  );
  assert.ok(
    bootPos("/js/ui-actions-client.js") > bootPos("/js/ui-feedback-client.js") &&
      bootPos("/js/ui-actions-client.js") < bootPos("/js/ui-view-transitions-client.js"),
    "ui-actions-client.js must load after shared UI feedback and before view transitions"
  );
  assert.ok(
    bootPos("/js/ui-view-transitions-client.js") > bootPos("/js/ui-actions-client.js") &&
      bootPos("/js/ui-view-transitions-client.js") < bootPos("/js/02-ui.js"),
    "ui-view-transitions-client.js must load after shared UI actions and before the UI shell"
  );
  assert.ok(
    bootPos("/js/ui-components.js") > bootPos("/js/html-utils.js") &&
      bootPos("/js/ui-components.js") < bootPos("/js/today-training-client.js"),
    "ui-components.js must load before Today training component consumers"
  );
  assert.ok(
    bootPos("/js/exercise-detail-client.js") > bootPos("/js/ui-view-transitions-client.js") &&
      bootPos("/js/exercise-detail-client.js") < bootPos("/js/02-ui.js"),
    "exercise-detail-client.js must load after shared UI helpers and before 02-ui.js"
  );
  assert.ok(
    bootPos("/js/format-utils.js") > -1 && bootPos("/js/format-utils.js") < bootPos("/js/02-ui.js"),
    "format-utils.js must load before 02-ui.js and feature modules"
  );
  assert.ok(
    bootPos("/js/02-ui.js") > -1 &&
      bootPos("/js/detail-overlay-client.js") > bootPos("/js/02-ui.js") &&
      bootPos("/js/detail-overlay-client.js") < bootPos("/js/ui-motion-client.js"),
    "detail-overlay-client.js must load after UI shell and before feature consumers"
  );
  assert.ok(
    bootPos("/js/exercise-detail-controller.js") > bootPos("/js/ui-motion-client.js") &&
      bootPos("/js/exercise-detail-controller.js") < bootPos("/js/agent-login-client.js") &&
      bootPos("/js/exercise-detail-controller.js") < bootPos("/js/03-today.js"),
    "exercise-detail-controller.js must load after detail helpers and before exercise guide consumers"
  );
  assert.ok(
    bootPos("/js/02-ui.js") > -1 &&
      bootPos("/js/rest-timer.js") > bootPos("/js/02-ui.js") &&
      bootPos("/js/rest-timer.js") < bootPos("/js/03-today.js"),
    "rest-timer.js must load after toast/UI helpers and before Today set logging"
  );
  assert.ok(
    bootPos("/js/coaching-focus-client.js") > bootPos("/js/rest-timer.js") &&
      bootPos("/js/coaching-focus-client.js") < bootPos("/js/03-today.js"),
    "coaching-focus-client.js must load after legacy UI helpers and before focus consumers"
  );
  assert.ok(
    bootPos("/js/02-ui.js") > -1 &&
      bootPos("/js/today-activity-client.js") > bootPos("/js/02-ui.js") &&
      bootPos("/js/today-activity-client.js") < bootPos("/js/03-today.js"),
    "today-activity-client.js must load after legacy UI dependencies and before activity consumers"
  );
  assert.ok(
    bootPos("/js/02-ui.js") > -1 &&
      bootPos("/js/save-bar.js") > bootPos("/js/02-ui.js") &&
      bootPos("/js/save-bar.js") < bootPos("/js/swr-cache.js"),
    "save-bar.js must load after 02-ui.js and before feature modules"
  );
  assert.ok(
    bootPos("/js/save-bar.js") > -1 &&
      bootPos("/js/swr-cache.js") > bootPos("/js/save-bar.js") &&
      bootPos("/js/swr-cache.js") < bootPos("/js/03-today.js"),
    "swr-cache.js must load after save-bar.js and before feature modules"
  );
  assert.ok(
    bootPos("/js/today-agenda-client.js") > bootPos("/js/swr-cache.js") &&
      bootPos("/js/today-agenda-client.js") < bootPos("/js/03-today.js"),
    "today-agenda-client.js must load after swr-cache.js and before 03-today.js"
  );
  assert.ok(
    bootPos("/js/today-rail-loaders-client.js") > bootPos("/js/today-agenda-client.js") &&
      bootPos("/js/today-rail-loaders-client.js") < bootPos("/js/today-rail-controller.js") &&
      bootPos("/js/today-rail-controller.js") > bootPos("/js/today-agenda-client.js") &&
      bootPos("/js/today-rail-controller.js") < bootPos("/js/03-today.js"),
    "today-rail loaders/controller must load after agenda helpers and before Today"
  );
  assert.ok(
    bootPos("/js/today-plan-selection-client.js") > bootPos("/js/today-rail-controller.js") &&
      bootPos("/js/today-plan-selection-client.js") < bootPos("/js/03-today.js"),
    "today-plan-selection-client.js must load after Today rail controller and before Today"
  );
  assert.ok(
    bootPos("/js/today-garmin-reconciliation-client.js") > bootPos("/js/today-program-adjustments-client.js") &&
      bootPos("/js/today-garmin-reconciliation-client.js") < bootPos("/js/03-today.js"),
    "today-garmin-reconciliation-client.js must load after Today helper dependencies and before 03-today.js"
  );
  assert.ok(
    bootPos("/js/today-side-loaders.js") > bootPos("/js/today-garmin-reconciliation-client.js") &&
      bootPos("/js/today-side-loaders.js") < bootPos("/js/03-today.js"),
    "today-side-loaders.js must load after Today side-loader dependencies and before 03-today.js"
  );
  assert.ok(
    bootPos("/js/today-plan-session-preparation.js") > bootPos("/js/today-side-loaders.js") &&
      bootPos("/js/today-plan-session-preparation.js") < bootPos("/js/today-data-loader.js"),
    "today-plan-session-preparation.js must load after Today side loaders and before data loading"
  );
  assert.ok(
    bootPos("/js/today-plan-session-model.js") > bootPos("/js/today-side-loaders.js") &&
      bootPos("/js/today-plan-session-model.js") < bootPos("/js/today-plan-session-data-client.js"),
    "today-plan-session-model.js must load after Today side loaders and before plan/session data"
  );
  assert.ok(
    bootPos("/js/today-plan-session-data-client.js") > bootPos("/js/today-plan-session-model.js") &&
      bootPos("/js/today-plan-session-data-client.js") < bootPos("/js/today-plan-session-preparation.js"),
    "today-plan-session-data-client.js must load after Today plan/session model and before plan/session preparation"
  );
  assert.ok(
    bootPos("/js/today-data-loader.js") > bootPos("/js/today-plan-session-preparation.js") &&
      bootPos("/js/today-data-loader.js") < bootPos("/js/today-main-shell-client.js"),
    "today-data-loader.js must load after Today preparation and before main shell helpers"
  );
  assert.ok(
    bootPos("/js/today-main-shell-client.js") > bootPos("/js/today-data-loader.js") &&
      bootPos("/js/today-main-shell-client.js") < bootPos("/js/today-plan-surface-client.js"),
    "today-main-shell-client.js must load after Today data loading and before plan-surface helpers"
  );
  assert.ok(
    bootPos("/js/today-plan-surface-client.js") > bootPos("/js/today-main-shell-client.js") &&
      bootPos("/js/today-plan-surface-client.js") < bootPos("/js/today-plan-surface-renderer.js"),
    "today-plan-surface-client.js must load after Today main shell helpers and before plan-surface rendering"
  );
  assert.ok(
    bootPos("/js/today-plan-surface-renderer.js") > bootPos("/js/today-plan-surface-client.js") &&
      bootPos("/js/today-plan-surface-renderer.js") < bootPos("/js/today-render-state-client.js"),
    "today-plan-surface-renderer.js must load after Today plan-surface helpers and before render-state helpers"
  );
  assert.ok(
    bootPos("/js/today-render-state-client.js") > bootPos("/js/today-plan-surface-renderer.js") &&
      bootPos("/js/today-render-state-client.js") < bootPos("/js/today-post-render-wiring.js"),
    "today-render-state-client.js must load after Today plan-surface rendering and before post-render wiring"
  );
  assert.ok(
    bootPos("/js/today-post-render-wiring.js") > bootPos("/js/today-render-state-client.js") &&
      bootPos("/js/today-post-render-wiring.js") < bootPos("/js/03-today.js"),
    "today-post-render-wiring.js must load after Today render-state helpers and before 03-today.js"
  );
  assert.ok(
    bootPos("/js/today-training-client.js") > bootPos("/js/today-plan-selection-client.js") &&
      bootPos("/js/today-training-client.js") < bootPos("/js/03-today.js"),
    "today-training-client.js must load before 03-today.js"
  );
  assert.ok(
    bootPos("/js/today-progression-controller.js") > bootPos("/js/today-training-client.js") &&
      bootPos("/js/today-progression-controller.js") < bootPos("/js/03-today.js"),
    "today-progression-controller.js must load after training helpers and before Today"
  );
  assert.ok(
    bootPos("/js/today-add-exercise-controller.js") > bootPos("/js/today-progression-controller.js") &&
      bootPos("/js/today-add-exercise-controller.js") < bootPos("/js/03-today.js"),
    "today-add-exercise-controller.js must load after Today progression controller and before Today"
  );
  assert.ok(
    bootPos("/js/today-brief-client.js") > bootPos("/js/today-add-exercise-controller.js") &&
      bootPos("/js/today-brief-client.js") < bootPos("/js/today-brief-override-client.js"),
    "today-brief-client.js must load after Today add-exercise controller and before Today brief override helpers"
  );
  assert.ok(
    bootPos("/js/today-brief-override-client.js") > bootPos("/js/today-brief-client.js") &&
      bootPos("/js/today-brief-override-client.js") < bootPos("/js/today-brief-actions-client.js"),
    "today-brief-override-client.js must load after Today brief helpers and before Today brief actions"
  );
  assert.ok(
    bootPos("/js/today-brief-actions-client.js") > bootPos("/js/today-brief-override-client.js") &&
      bootPos("/js/today-brief-actions-client.js") < bootPos("/js/today-brief-controller.js"),
    "today-brief-actions-client.js must load after Today brief override helpers and before Today brief controller"
  );
  assert.ok(
    bootPos("/js/today-brief-controller.js") > bootPos("/js/today-brief-actions-client.js") &&
      bootPos("/js/today-brief-controller.js") < bootPos("/js/03-today.js"),
    "today-brief-controller.js must load after Today brief actions and before 03-today.js"
  );
  assert.ok(
    bootPos("/js/cardio-plan-client.js") > bootPos("/js/today-brief-controller.js") &&
      bootPos("/js/cardio-plan-client.js") < bootPos("/js/03-today.js"),
    "cardio-plan-client.js must load after Today brief controller and before screen consumers"
  );
  assert.ok(
    bootPos("/js/cardio-sync-client.js") > bootPos("/js/cardio-plan-client.js") &&
      bootPos("/js/cardio-sync-client.js") < bootPos("/js/03-today.js") &&
      bootPos("/js/cardio-sync-client.js") < bootPos("/js/05-progress.js") &&
      bootPos("/js/cardio-sync-client.js") < bootPos("/js/09-plan-chat.js"),
    "cardio-sync-client.js must load before Today, Progress, and Plan consumers"
  );
  assert.ok(
    bootPos("/js/today-lately-client.js") > bootPos("/js/cardio-sync-client.js") &&
      bootPos("/js/today-lately-client.js") < bootPos("/js/03-today.js"),
    "today-lately-client.js must load after cardio sync helpers and before Today"
  );
  assert.ok(
    bootPos("/js/proposal-client.js") > bootPos("/js/today-lately-client.js") &&
      bootPos("/js/proposal-client.js") < bootPos("/js/coach-proposal-controller.js") &&
      bootPos("/js/proposal-client.js") < bootPos("/js/03-today.js") &&
      bootPos("/js/proposal-client.js") < bootPos("/js/06-coach-meals.js") &&
      bootPos("/js/proposal-client.js") < bootPos("/js/09-plan-chat.js"),
    "proposal-client.js must load before Today, Coach proposal, Meals, and Chat proposal consumers"
  );
  assert.ok(
    bootPos("/js/today-session-suggest-client.js") > bootPos("/js/proposal-client.js") &&
      bootPos("/js/today-session-suggest-client.js") < bootPos("/js/03-today.js"),
    "today-session-suggest-client.js must load after proposal helpers and before Today consumers"
  );
  assert.ok(
    bootPos("/js/today-session-suggest-controller.js") > bootPos("/js/today-session-suggest-client.js") &&
      bootPos("/js/today-session-suggest-controller.js") < bootPos("/js/03-today.js"),
    "today-session-suggest-controller.js must load after markup helpers and before Today consumers"
  );
  assert.ok(
    bootPos("/js/today-session-status-client.js") > bootPos("/js/today-session-suggest-controller.js") &&
      bootPos("/js/today-session-status-client.js") < bootPos("/js/today-cards-client.js") &&
      bootPos("/js/today-session-status-client.js") < bootPos("/js/progress-history-client.js"),
    "today-session-status-client.js must load after session-suggest controller and before Today/History consumers"
  );
  assert.ok(
    bootPos("/js/today-session-feedback-client.js") > bootPos("/js/today-session-status-client.js") &&
      bootPos("/js/today-session-feedback-client.js") < bootPos("/js/today-session-skip-client.js"),
    "today-session-feedback-client.js must load after session-status helpers and before session controller"
  );
  assert.ok(
    bootPos("/js/today-session-skip-client.js") > bootPos("/js/today-session-feedback-client.js") &&
      bootPos("/js/today-session-skip-client.js") < bootPos("/js/today-session-set-model.js"),
    "today-session-skip-client.js must load after session-feedback helpers and before session set helpers"
  );
  assert.ok(
    bootPos("/js/today-session-set-model.js") > bootPos("/js/today-session-skip-client.js") &&
      bootPos("/js/today-session-set-model.js") < bootPos("/js/today-session-set-actions.js"),
    "today-session-set-model.js must load after session-skip helpers and before session set actions"
  );
  assert.ok(
    bootPos("/js/today-session-set-actions.js") > bootPos("/js/today-session-set-model.js") &&
      bootPos("/js/today-session-set-actions.js") < bootPos("/js/today-session-controller.js"),
    "today-session-set-actions.js must load after session set model and before session controller"
  );
  assert.ok(
    bootPos("/js/today-session-controller.js") > bootPos("/js/today-session-set-actions.js") &&
      bootPos("/js/today-session-controller.js") < bootPos("/js/03-today.js"),
    "today-session-controller.js must load after session set actions and before Today"
  );
  assert.ok(
    bootPos("/js/today-cards-client.js") > bootPos("/js/today-session-status-client.js") &&
      bootPos("/js/today-cards-client.js") < bootPos("/js/03-today.js"),
    "today-cards-client.js must load after session-status helpers and before Today"
  );
  assert.ok(
    bootPos("/js/today-program-adjustments-client.js") > bootPos("/js/today-cards-client.js") &&
      bootPos("/js/today-program-adjustments-client.js") < bootPos("/js/03-today.js"),
    "today-program-adjustments-client.js must load after Today card helpers and before Today consumers"
  );
  assert.ok(
    bootPos("/js/today-week-ahead-client.js") > bootPos("/js/today-program-adjustments-client.js") &&
      bootPos("/js/today-week-ahead-client.js") < bootPos("/js/03-today.js"),
    "today-week-ahead-client.js must load after Today rail helpers and before Today consumers"
  );
  assert.ok(
    bootPos("/js/today-context-client.js") > bootPos("/js/today-week-ahead-client.js") &&
      bootPos("/js/today-context-client.js") < bootPos("/js/03-today.js"),
    "today-context-client.js must load after Today week-ahead helpers and before Today consumers"
  );
  assert.ok(
    bootPos("/js/today-dependencies.js") > bootPos("/js/today-post-render-wiring.js") &&
      bootPos("/js/today-dependencies.js") < bootPos("/js/03-today.js"),
    "today-dependencies.js must load after Today wiring helpers and before Today screen"
  );
  assert.ok(
    bootPos("/js/progress-data-client.js") > bootPos("/js/today-post-render-wiring.js") &&
      bootPos("/js/progress-data-client.js") < bootPos("/js/05-progress.js"),
    "progress-data-client.js must load after Today helper wiring and before Progress consumers"
  );
  assert.ok(
    bootPos("/js/progress-endurance-client.js") > bootPos("/js/progress-data-client.js") &&
      bootPos("/js/progress-endurance-client.js") < bootPos("/js/05-progress.js"),
    "progress-endurance-client.js must load after Progress data helpers and before Progress consumers"
  );
  assert.ok(
    bootPos("/js/progress-components-client.js") > bootPos("/js/progress-endurance-client.js") &&
      bootPos("/js/progress-components-client.js") < bootPos("/js/05-progress.js"),
    "progress-components-client.js must load before Progress screen consumers"
  );
  assert.ok(
    bootPos("/js/progress-line-chart-model.js") > bootPos("/js/progress-components-client.js") &&
      bootPos("/js/progress-line-chart-model.js") < bootPos("/js/progress-chart-scrub-client.js"),
    "progress-line-chart-model.js must load after Progress components and before chart scrub helpers"
  );
  assert.ok(
    bootPos("/js/progress-chart-scrub-client.js") > bootPos("/js/progress-line-chart-model.js") &&
      bootPos("/js/progress-chart-scrub-client.js") < bootPos("/js/progress-chart-client.js"),
    "progress-chart-scrub-client.js must load after the chart model and before the chart renderer"
  );
  assert.ok(
    bootPos("/js/progress-chart-client.js") > bootPos("/js/progress-chart-scrub-client.js") &&
      bootPos("/js/progress-chart-client.js") < bootPos("/js/05-progress.js"),
    "progress-chart-client.js must load after chart scrub helpers and before Progress chart consumers"
  );
  assert.ok(
    bootPos("/js/progress-trend-weight-client.js") > bootPos("/js/progress-chart-client.js") &&
      bootPos("/js/progress-trend-weight-client.js") < bootPos("/js/05-progress.js"),
    "progress-trend-weight-client.js must load after chart helpers and before Progress route consumers"
  );
  assert.ok(
    bootPos("/js/progress-history-client.js") > bootPos("/js/progress-chart-client.js") &&
      bootPos("/js/progress-history-client.js") < bootPos("/js/05-progress.js"),
    "progress-history-client.js must load before Progress history consumers"
  );
  assert.ok(
    bootPos("/js/progress-run-plan-client.js") > bootPos("/js/progress-history-client.js") &&
      bootPos("/js/progress-run-plan-client.js") < bootPos("/js/progress-route-deps-client.js"),
    "progress-run-plan-client.js must load before Progress route deps"
  );
  assert.ok(
    bootPos("/js/progress-route-deps-client.js") > bootPos("/js/progress-run-plan-client.js") &&
      bootPos("/js/progress-route-deps-client.js") < bootPos("/js/progress-endurance-controller.js") &&
      bootPos("/js/progress-route-deps-client.js") < bootPos("/js/05-progress.js"),
    "progress-route-deps-client.js must load before Progress route consumers"
  );
  assert.ok(
    bootPos("/js/progress-endurance-controller.js") > bootPos("/js/progress-route-deps-client.js") &&
      bootPos("/js/progress-endurance-controller.js") < bootPos("/js/progress-volume-client.js"),
    "progress-endurance-controller.js must load after Progress Endurance helpers and before sibling Progress helpers"
  );
  assert.ok(
    bootPos("/js/progress-volume-client.js") > bootPos("/js/progress-endurance-controller.js") &&
      bootPos("/js/progress-volume-client.js") < bootPos("/js/05-progress.js"),
    "progress-volume-client.js must load before Progress Volume consumers"
  );
  assert.ok(
    bootPos("/js/progress-energy-client.js") > bootPos("/js/progress-volume-client.js") &&
      bootPos("/js/progress-energy-client.js") < bootPos("/js/05-progress.js"),
    "progress-energy-client.js must load before Progress Energy consumers"
  );
  assert.ok(
    bootPos("/js/progress-energy-surface-client.js") > bootPos("/js/progress-energy-client.js") &&
      bootPos("/js/progress-energy-surface-client.js") < bootPos("/js/05-progress.js") &&
      bootPos("/js/progress-energy-surface-client.js") < bootPos("/js/06-coach-meals.js"),
    "progress-energy-surface-client.js must load before Progress and Meals energy consumers"
  );
  assert.ok(
    bootPos("/js/progress-calendar-client.js") > bootPos("/js/progress-energy-surface-client.js") &&
      bootPos("/js/progress-calendar-client.js") < bootPos("/js/05-progress.js"),
    "progress-calendar-client.js must load before Progress Calendar consumers"
  );
  assert.ok(
    bootPos("/js/progress-muscle-trajectory-client.js") > bootPos("/js/progress-calendar-client.js") &&
      bootPos("/js/progress-muscle-trajectory-client.js") < bootPos("/js/05-progress.js"),
    "progress-muscle-trajectory-client.js must load before Progress muscle trajectory consumers"
  );
  assert.ok(
    bootPos("/js/progress-dexa-targeting-client.js") > bootPos("/js/progress-muscle-trajectory-client.js") &&
      bootPos("/js/progress-dexa-targeting-client.js") < bootPos("/js/05-progress.js"),
    "progress-dexa-targeting-client.js must load before Progress and Health DEXA consumers"
  );
  assert.ok(
    bootPos("/js/progress-performance-client.js") > bootPos("/js/progress-dexa-targeting-client.js") &&
      bootPos("/js/progress-performance-client.js") < bootPos("/js/05-progress.js"),
    "progress-performance-client.js must load before Progress performance consumers"
  );
  assert.ok(
    bootPos("/js/progress-program-adjustments-client.js") > bootPos("/js/progress-performance-client.js") &&
      bootPos("/js/progress-program-adjustments-client.js") < bootPos("/js/05-progress.js"),
    "progress-program-adjustments-client.js must load before Progress adjustment consumers"
  );
  assert.ok(
    bootPos("/js/progress-test-week-client.js") > bootPos("/js/progress-program-adjustments-client.js") &&
      bootPos("/js/progress-test-week-client.js") < bootPos("/js/05-progress.js"),
    "progress-test-week-client.js must load before Progress test-week consumers"
  );
  assert.ok(
    bootPos("/js/progress-program-summary-client.js") > bootPos("/js/progress-test-week-client.js") &&
      bootPos("/js/progress-program-summary-client.js") < bootPos("/js/05-progress.js"),
    "progress-program-summary-client.js must load before Progress program-summary consumers"
  );
  assert.ok(
    bootPos("/js/progress-program-block-client.js") > bootPos("/js/progress-program-summary-client.js") &&
      bootPos("/js/progress-program-block-client.js") < bootPos("/js/05-progress.js"),
    "progress-program-block-client.js must load before Progress program-block consumers"
  );
  assert.ok(
    bootPos("/js/progress-program-controller.js") > bootPos("/js/progress-program-block-client.js") &&
      bootPos("/js/progress-program-controller.js") < bootPos("/js/05-progress.js"),
    "progress-program-controller.js must load before Progress program controller consumers"
  );
  assert.ok(
    bootPos("/js/capture-provenance-client.js") > bootPos("/js/03-today.js") &&
      bootPos("/js/capture-provenance-client.js") < bootPos("/js/capture-read-date-client.js"),
    "capture-provenance-client.js must load after Today and before Capture read helpers"
  );
  assert.ok(
    bootPos("/js/capture-read-date-client.js") > bootPos("/js/capture-provenance-client.js") &&
      bootPos("/js/capture-read-date-client.js") < bootPos("/js/capture-read-cards-client.js"),
    "capture-read-date-client.js must load before Capture read card helpers"
  );
  assert.ok(
    bootPos("/js/capture-read-cards-client.js") > bootPos("/js/capture-read-date-client.js") &&
      bootPos("/js/capture-read-cards-client.js") < bootPos("/js/capture-read-jobs-client.js"),
    "capture-read-cards-client.js must load before Capture read job helpers"
  );
  assert.ok(
    bootPos("/js/capture-read-jobs-client.js") > bootPos("/js/capture-read-cards-client.js") &&
      bootPos("/js/capture-read-jobs-client.js") < bootPos("/js/capture-reads-client.js"),
    "capture-read-jobs-client.js must load before capture-reads-client.js"
  );
  assert.ok(
    bootPos("/js/capture-reads-client.js") > bootPos("/js/capture-read-jobs-client.js") &&
      bootPos("/js/capture-reads-client.js") < bootPos("/js/capture-voice-client.js"),
    "capture-reads-client.js must load after Capture read helpers and before Capture consumers"
  );
  assert.ok(
    bootPos("/js/capture-voice-client.js") > bootPos("/js/capture-reads-client.js") &&
      bootPos("/js/capture-voice-client.js") < bootPos("/js/04-capture.js"),
    "capture-voice-client.js must load after Capture reads and before Capture consumers"
  );
  assert.ok(
    bootPos("/js/04-capture.js") > bootPos("/js/capture-voice-client.js") &&
      bootPos("/js/04-capture.js") < bootPos("/js/05-progress.js"),
    "04-capture.js must load after Capture helpers and before downstream screens"
  );
  assert.ok(
    bootPos("/js/meal-row-client.js") > bootPos("/js/day-fuel-controller.js") &&
      bootPos("/js/meal-row-client.js") < bootPos("/js/meal-plan-client.js"),
    "meal-row-client.js must load after fuel helpers and before Meal Plan shell helpers"
  );
  assert.ok(
    bootPos("/js/meal-plan-client.js") > bootPos("/js/meal-row-client.js") &&
      bootPos("/js/meal-plan-client.js") < bootPos("/js/06-coach-meals.js"),
    "meal-plan-client.js must load after meal row helpers and before Meals screen consumers"
  );
  assert.ok(
    bootPos("/js/day-fuel-controller.js") > bootPos("/js/day-fuel-client.js") &&
      bootPos("/js/day-fuel-controller.js") < bootPos("/js/06-coach-meals.js"),
    "day-fuel-controller.js must load after fuel helpers and before Meals screen consumers"
  );
  assert.ok(
    bootPos("/js/meal-recipe-client.js") > bootPos("/js/meal-plan-client.js") &&
      bootPos("/js/meal-recipe-client.js") < bootPos("/js/meal-recipe-controller.js"),
    "meal-recipe-client.js must load before the Meal Recipe controller"
  );
  assert.ok(
    bootPos("/js/meal-recipe-controller.js") > bootPos("/js/meal-recipe-client.js") &&
      bootPos("/js/meal-recipe-controller.js") < bootPos("/js/meal-swap-data-client.js"),
    "meal-recipe-controller.js must load before Meal Swap data helpers"
  );
  assert.ok(
    bootPos("/js/meal-swap-data-client.js") > bootPos("/js/meal-recipe-controller.js") &&
      bootPos("/js/meal-swap-data-client.js") < bootPos("/js/meal-swap-row-actions-controller.js"),
    "meal-swap-data-client.js must load before Meal Swap row actions"
  );
  assert.ok(
    bootPos("/js/meal-swap-row-actions-controller.js") > bootPos("/js/meal-swap-data-client.js") &&
      bootPos("/js/meal-swap-row-actions-controller.js") < bootPos("/js/meal-swap-controller.js"),
    "meal-swap-row-actions-controller.js must load before Meal Swap controller"
  );
  assert.ok(
    bootPos("/js/meal-swap-controller.js") > bootPos("/js/meal-swap-row-actions-controller.js") &&
      bootPos("/js/meal-swap-controller.js") < bootPos("/js/meal-planner-controller.js"),
    "meal-swap-controller.js must load before Meal Planner controller"
  );
  assert.ok(
    bootPos("/js/meal-planner-controller.js") > bootPos("/js/meal-swap-controller.js") &&
      bootPos("/js/meal-planner-controller.js") < bootPos("/js/06-coach-meals.js"),
    "meal-planner-controller.js must load before Meals screen consumers"
  );
  assert.ok(
    bootPos("/js/coach-proposal-controller.js") > bootPos("/js/meal-planner-controller.js") &&
      bootPos("/js/coach-proposal-controller.js") < bootPos("/js/06-coach-meals.js"),
    "coach-proposal-controller.js must load after proposal/meal planner helpers and before Meals screen consumers"
  );
  assert.ok(
    bootPos("/js/health-docs-client.js") > bootPos("/js/06-coach-meals.js") &&
      bootPos("/js/health-docs-client.js") < bootPos("/js/07-me-health.js") &&
      bootPos("/js/health-docs-client.js") < bootPos("/js/08-me-records.js"),
    "health-docs-client.js must load before Health and Records document consumers"
  );
  assert.ok(
    bootPos("/js/health-marker-order-client.js") > bootPos("/js/health-evidence-client.js") &&
      bootPos("/js/health-marker-order-client.js") < bootPos("/js/health-client.js"),
    "health-marker-order-client.js must load after Health evidence helpers and before shared Health helpers"
  );
  assert.ok(
    bootPos("/js/health-client.js") > bootPos("/js/07-me-health.js") &&
      bootPos("/js/health-client.js") < bootPos("/js/08-me-records.js"),
    "health-client.js must load after Health view definitions and before Records view hydration"
  );
  assert.ok(
    bootPos("/js/health-read-client.js") > bootPos("/js/health-client.js") &&
      bootPos("/js/health-read-client.js") < bootPos("/js/08-me-records.js"),
    "health-read-client.js must load after shared Health helpers and before boot can render Health Read"
  );
  assert.ok(
    bootPos("/js/health-standing-primitives-client.js") > bootPos("/js/health-read-client.js") &&
      bootPos("/js/health-standing-primitives-client.js") < bootPos("/js/health-standing-client.js"),
    "health-standing-primitives-client.js must load after Health Read helpers and before Standing renderer"
  );
  assert.ok(
    bootPos("/js/health-standing-client.js") > bootPos("/js/health-standing-primitives-client.js") &&
      bootPos("/js/health-standing-client.js") < bootPos("/js/08-me-records.js"),
    "health-standing-client.js must load after Health Standing primitives and before boot can render Standing"
  );
  assert.ok(
    bootPos("/js/health-picture-client.js") > bootPos("/js/health-standing-client.js") &&
      bootPos("/js/health-picture-client.js") < bootPos("/js/08-me-records.js"),
    "health-picture-client.js must load after Health Standing helpers and before Records view hydration"
  );
  assert.ok(
    bootPos("/js/health-picture-controller.js") > bootPos("/js/health-picture-client.js") &&
      bootPos("/js/health-picture-controller.js") < bootPos("/js/08-me-records.js"),
    "health-picture-controller.js must load after Health Picture renderer and before Records view hydration"
  );
  assert.ok(
    bootPos("/js/health-markers-client.js") > bootPos("/js/health-picture-controller.js") &&
      bootPos("/js/health-markers-client.js") < bootPos("/js/08-me-records.js"),
    "health-markers-client.js must load after Health picture helpers and before Records view hydration"
  );
  assert.ok(
    bootPos("/js/health-directives-client.js") > bootPos("/js/health-markers-client.js") &&
      bootPos("/js/health-directives-client.js") < bootPos("/js/health-directives-loader-client.js"),
    "health-directives-client.js must load after Health marker helpers and before Records view hydration"
  );
  assert.ok(
    bootPos("/js/health-directives-loader-client.js") > bootPos("/js/health-directives-client.js") &&
      bootPos("/js/health-directives-loader-client.js") < bootPos("/js/health-read-supplements-client.js"),
    "health-directives-loader-client.js must load after directive render helpers and before boot can render Health Read"
  );
  assert.ok(
    bootPos("/js/health-read-supplements-client.js") > bootPos("/js/health-read-synthesis-client.js") &&
      bootPos("/js/health-read-supplements-client.js") < bootPos("/js/health-read-controller.js"),
    "health-read-supplements-client.js must load after Health Read synthesis helpers and before the Health Read controller"
  );
  assert.ok(
    bootPos("/js/health-read-controller.js") > bootPos("/js/health-read-supplements-client.js") &&
      bootPos("/js/health-read-controller.js") < bootPos("/js/08-me-records.js"),
    "health-read-controller.js must load after Health Read helpers and before boot can render Health Read"
  );
  assert.ok(
    bootPos("/js/health-learned-client.js") > bootPos("/js/health-read-controller.js") &&
      bootPos("/js/health-learned-client.js") < bootPos("/js/08-me-records.js"),
    "health-learned-client.js must load after Health directive helpers and before Records learned timeline consumers"
  );
  assert.ok(
    bootPos("/js/health-records-client.js") > bootPos("/js/health-learned-client.js") &&
      bootPos("/js/health-records-client.js") < bootPos("/js/health-doc-upload-controller.js"),
    "health-records-client.js must load after Health learned helpers and before Records upload hydration"
  );
  assert.ok(
    bootPos("/js/health-doc-upload-controller.js") > bootPos("/js/health-records-client.js") &&
      bootPos("/js/health-doc-upload-controller.js") < bootPos("/js/health-doc-actions-controller.js"),
    "health-doc-upload-controller.js must load after Records render helpers and before document row actions"
  );
  assert.ok(
    bootPos("/js/health-doc-actions-controller.js") > bootPos("/js/health-doc-upload-controller.js") &&
      bootPos("/js/health-doc-actions-controller.js") < bootPos("/js/me-records-health-doc-controller.js"),
    "health-doc-actions-controller.js must load after upload hydration and before the Records controller"
  );
  assert.ok(
    bootPos("/js/me-records-health-doc-controller.js") > bootPos("/js/health-doc-actions-controller.js") &&
      bootPos("/js/me-records-health-doc-controller.js") < bootPos("/js/08-me-records.js"),
    "me-records-health-doc-controller.js must load after document row actions and before the Records screen"
  );
  assert.ok(
    bootPos("/js/memory-client.js") > bootPos("/js/me-records-health-doc-controller.js") &&
      bootPos("/js/memory-client.js") < bootPos("/js/me-memory-controller.js"),
    "memory-client.js must load before the Me memory controller"
  );
  assert.ok(
    bootPos("/js/me-memory-controller.js") > bootPos("/js/memory-client.js") &&
      bootPos("/js/me-memory-controller.js") < bootPos("/js/10-boot.js"),
    "me-memory-controller.js must load after pure Memory helpers and before boot can render Me memory"
  );
  assert.ok(
    bootPos("/js/life-client.js") > bootPos("/js/me-memory-controller.js") &&
      bootPos("/js/life-client.js") < bootPos("/js/life-controller.js"),
    "life-client.js must load before the Life controller"
  );
  assert.ok(
    bootPos("/js/life-controller.js") > bootPos("/js/life-client.js") &&
      bootPos("/js/life-controller.js") < bootPos("/js/08-me-records.js"),
    "life-controller.js must load before Records life timeline consumers"
  );
  assert.ok(
    bootPos("/js/family-client.js") > bootPos("/js/life-controller.js") &&
      bootPos("/js/family-client.js") < bootPos("/js/family-controller.js"),
    "family-client.js must load before the Family controller"
  );
  assert.ok(
    bootPos("/js/family-controller.js") > bootPos("/js/family-client.js") &&
      bootPos("/js/family-controller.js") < bootPos("/js/08-me-records.js"),
    "family-controller.js must load before Records family consumers"
  );
  assert.ok(
    bootPos("/js/chat-client.js") > bootPos("/js/08-me-records.js") &&
      bootPos("/js/chat-client.js") < bootPos("/js/chat-attachment-client.js"),
    "chat-client.js must load before chat attachment helpers"
  );
  assert.ok(
    bootPos("/js/chat-attachment-client.js") > bootPos("/js/chat-client.js") &&
      bootPos("/js/chat-attachment-client.js") < bootPos("/js/chat-composer-focus-client.js"),
    "chat-attachment-client.js must load after chat helpers and before chat composer focus helpers"
  );
  assert.ok(
    bootPos("/js/chat-composer-focus-client.js") > bootPos("/js/chat-attachment-client.js") &&
      bootPos("/js/chat-composer-focus-client.js") < bootPos("/js/chat-composer-controller.js"),
    "chat-composer-focus-client.js must load after chat attachment helpers and before chat composer controller"
  );
  assert.ok(
    bootPos("/js/chat-composer-controller.js") > bootPos("/js/chat-composer-focus-client.js") &&
      bootPos("/js/chat-composer-controller.js") < bootPos("/js/chat-message-client.js"),
    "chat-composer-controller.js must load after chat focus helpers and before chat message helpers"
  );
  assert.ok(
    bootPos("/js/chat-message-client.js") > bootPos("/js/chat-composer-controller.js") &&
      bootPos("/js/chat-message-client.js") < bootPos("/js/chat-turn-records-client.js"),
    "chat-message-client.js must load after chat composer controller and before chat turn record helpers"
  );
  assert.ok(
    bootPos("/js/chat-turn-records-client.js") > bootPos("/js/chat-message-client.js") &&
      bootPos("/js/chat-turn-records-client.js") < bootPos("/js/chat-turn-stream-state-client.js"),
    "chat-turn-records-client.js must load after chat message helpers and before chat turn stream-state helpers"
  );
  assert.ok(
    bootPos("/js/chat-turn-stream-state-client.js") > bootPos("/js/chat-turn-records-client.js") &&
      bootPos("/js/chat-turn-stream-state-client.js") < bootPos("/js/chat-layout-client.js"),
    "chat-turn-stream-state-client.js must load after chat turn record helpers and before chat layout helpers"
  );
  assert.ok(
    bootPos("/js/chat-layout-client.js") > bootPos("/js/chat-turn-stream-state-client.js") &&
      bootPos("/js/chat-layout-client.js") < bootPos("/js/chat-turn-client.js"),
    "chat-layout-client.js must load after chat turn stream-state helpers and before chat turn helpers"
  );
  assert.ok(
    bootPos("/js/chat-turn-client.js") > bootPos("/js/chat-layout-client.js") &&
      bootPos("/js/chat-turn-client.js") < bootPos("/js/09-plan-chat.js"),
    "chat-turn-client.js must load after chat layout helpers and before 09-plan-chat.js"
  );
  assert.ok(
    bootPos("/js/chat-history-client.js") > bootPos("/js/chat-turn-client.js") &&
      bootPos("/js/chat-history-client.js") < bootPos("/js/09-plan-chat.js"),
    "chat-history-client.js must load after chat turn helpers and before 09-plan-chat.js"
  );
  assert.ok(
    bootPos("/js/plan-endurance-model.js") > bootPos("/js/chat-history-client.js") &&
      bootPos("/js/plan-endurance-model.js") < bootPos("/js/plan-endurance-client.js"),
    "plan-endurance-model.js must load before Plan endurance orchestration"
  );
  assert.ok(
    bootPos("/js/plan-endurance-client.js") > bootPos("/js/plan-endurance-model.js") &&
      bootPos("/js/plan-endurance-client.js") < bootPos("/js/09-plan-chat.js"),
    "plan-endurance-client.js must load before Plan endurance consumers"
  );
  assert.ok(
    bootPos("/js/plan-editor-client.js") > bootPos("/js/plan-endurance-client.js") &&
      bootPos("/js/plan-editor-client.js") < bootPos("/js/plan-editor-form-client.js"),
    "plan-editor-client.js must load after Plan endurance helpers and before Plan editor form helpers"
  );
  assert.ok(
    bootPos("/js/plan-editor-form-client.js") > bootPos("/js/plan-editor-client.js") &&
      bootPos("/js/plan-editor-form-client.js") < bootPos("/js/plan-editor-controller.js"),
    "plan-editor-form-client.js must load after Plan editor render helpers and before the Plan editor controller"
  );
  assert.ok(
    bootPos("/js/plan-editor-controller.js") > bootPos("/js/plan-editor-form-client.js") &&
      bootPos("/js/plan-editor-controller.js") < bootPos("/js/09-plan-chat.js"),
    "plan-editor-controller.js must load after Plan editor form helpers and before Plan editor consumers"
  );
  assert.ok(
    bootPos("/js/day-fuel-client.js") > bootPos("/js/05-progress.js") &&
      bootPos("/js/day-fuel-client.js") < bootPos("/js/06-coach-meals.js"),
    "day-fuel-client.js must load before Meals day-fuel consumers"
  );
  assert.ok(
    bootPos("/js/day-fuel-controller.js") > bootPos("/js/day-fuel-client.js") &&
      bootPos("/js/day-fuel-controller.js") < bootPos("/js/06-coach-meals.js"),
    "day-fuel-controller.js must load before Meals day-fuel controller consumers"
  );
  assert.ok(
    bootPos("/js/food-note-client.js") > bootPos("/js/06-coach-meals.js") &&
      bootPos("/js/food-note-client.js") < bootPos("/js/07-me-health.js"),
    "food-note-client.js must load before Me food-note consumers"
  );
  assert.ok(
    bootPos("/js/food-detail-controller.js") > bootPos("/js/food-note-client.js") &&
      bootPos("/js/food-detail-controller.js") < bootPos("/js/07-me-health.js"),
    "food-detail-controller.js must load after food-note helpers and before food detail consumers"
  );
  assert.ok(
    bootPos("/js/me-profile-form-client.js") > bootPos("/js/health-docs-client.js") &&
      bootPos("/js/me-profile-form-client.js") < bootPos("/js/me-profile-controller.js"),
    "me-profile-form-client.js must load after shared Health document helpers and before the Me Profile controller"
  );
  assert.ok(
    bootPos("/js/me-profile-controller.js") > bootPos("/js/me-profile-form-client.js") &&
      bootPos("/js/me-profile-controller.js") < bootPos("/js/07-me-health.js"),
    "me-profile-controller.js must load after Me Profile form helpers and before Me Profile consumers"
  );
  assert.ok(
    bootPos("/js/me-health-tabs-controller.js") > bootPos("/js/me-profile-controller.js") &&
      bootPos("/js/me-health-tabs-controller.js") < bootPos("/js/me-health-controller-deps.js"),
    "me-health-tabs-controller.js must load before Me Health dependency factories"
  );
  assert.ok(
    bootPos("/js/me-health-controller-deps.js") > bootPos("/js/me-health-tabs-controller.js") &&
      bootPos("/js/me-health-controller-deps.js") < bootPos("/js/me-health-dependencies.js"),
    "me-health-controller-deps.js must load before the public Me Health dependency namespace"
  );
  assert.ok(
    bootPos("/js/me-health-dependencies.js") > bootPos("/js/me-health-controller-deps.js") &&
      bootPos("/js/me-health-dependencies.js") < bootPos("/js/07-me-health.js"),
    "me-health-dependencies.js must load before Me Health screen consumers"
  );
  assert.ok(
    bootPos("/js/settings-client.js") > bootPos("/js/settings-routes.js") &&
      bootPos("/js/settings-client.js") < bootPos("/js/settings-surface-client.js"),
    "settings-client.js must load before Settings surface helpers"
  );
  assert.ok(
    bootPos("/js/settings-surface-client.js") > bootPos("/js/settings-client.js") &&
      bootPos("/js/settings-surface-client.js") < bootPos("/js/settings-data-client.js"),
    "settings-surface-client.js must load before Settings Data helpers"
  );
  assert.ok(
    bootPos("/js/settings-data-client.js") > bootPos("/js/settings-surface-client.js") &&
      bootPos("/js/settings-data-client.js") < bootPos("/js/settings-data-controller.js"),
    "settings-data-client.js must load before Settings Data controller"
  );
  assert.ok(
    bootPos("/js/settings-data-controller.js") > bootPos("/js/settings-data-client.js") &&
      bootPos("/js/settings-data-controller.js") < bootPos("/js/settings-agents-client.js"),
    "settings-data-controller.js must load before Settings Agents helpers"
  );
  assert.ok(
    bootPos("/js/settings-agents-client.js") > bootPos("/js/settings-data-controller.js") &&
      bootPos("/js/settings-agents-client.js") < bootPos("/js/settings-agents-controller.js"),
    "settings-agents-client.js must load before Settings Agents controller"
  );
  assert.ok(
    bootPos("/js/settings-agents-controller.js") > bootPos("/js/settings-agents-client.js") &&
      bootPos("/js/settings-agents-controller.js") < bootPos("/js/settings-sources-automation-controller.js"),
    "settings-agents-controller.js must load before Settings Sources/Automation controller"
  );
  assert.ok(
    bootPos("/js/settings-sources-automation-controller.js") > bootPos("/js/settings-agents-controller.js") &&
      bootPos("/js/settings-sources-automation-controller.js") < bootPos("/js/settings-screen.js"),
    "settings-sources-automation-controller.js must load before settings-screen.js"
  );
  assert.ok(
    bootPos("/js/settings-screen.js") > bootPos("/js/settings-sources-automation-controller.js") &&
      bootPos("/js/settings-screen.js") < bootPos("/js/route-state.js"),
    "settings-screen.js must load after Settings helpers and before route-state.js"
  );
  assert.ok(
    bootPos("/js/app-router.js") > bootPos("/js/route-state.js") &&
      bootPos("/js/app-router.js") < bootPos("/js/app-route-sync.js"),
    "app-router.js must load after route-state.js and before route sync wrappers"
  );
  assert.ok(
    bootPos("/js/app-route-sync.js") > bootPos("/js/app-router.js") &&
      bootPos("/js/app-route-sync.js") < bootPos("/js/app-render-dispatch.js"),
    "app-route-sync.js must load after router helpers and before render dispatch"
  );
  assert.ok(
    bootPos("/js/app-render-dispatch.js") > bootPos("/js/app-route-sync.js") &&
      bootPos("/js/app-render-dispatch.js") < bootPos("/js/app-tabs.js"),
    "app-render-dispatch.js must load after route sync wrappers and before tab shell controls"
  );
  assert.ok(
    bootPos("/js/app-tabs.js") > bootPos("/js/app-render-dispatch.js") &&
      bootPos("/js/app-tabs.js") < bootPos("/js/app-job-reconnectors.js"),
    "app-tabs.js must load after render dispatch and before boot-time reconnectors"
  );
  assert.ok(
    bootPos("/js/app-job-reconnectors.js") > bootPos("/js/app-tabs.js") &&
      bootPos("/js/app-job-reconnectors.js") < bootPos("/js/10-boot.js"),
    "app-job-reconnectors.js must load after tab shell controls and before 10-boot.js"
  );
  assert.ok(
    bootPos("/js/app-mobile-viewport.js") > bootPos("/js/app-job-reconnectors.js") &&
      bootPos("/js/app-mobile-viewport.js") < bootPos("/js/10-boot.js"),
    "app-mobile-viewport.js must load after boot-time reconnectors and before 10-boot.js"
  );
  assert.ok(
    bootPos("/js/app-service-worker.js") > bootPos("/js/app-mobile-viewport.js") &&
      bootPos("/js/app-service-worker.js") < bootPos("/js/10-boot.js"),
    "app-service-worker.js must load after app shell helpers and before 10-boot.js"
  );
  assert.ok(
    bootPos("/js/app-discipline-primer.js") > bootPos("/js/app-service-worker.js") &&
      bootPos("/js/app-discipline-primer.js") < bootPos("/js/app-onboarding.js"),
    "app-discipline-primer.js must load after app shell helpers and before 10-boot.js"
  );
  assert.ok(
    bootPos("/js/app-onboarding.js") > bootPos("/js/app-discipline-primer.js") &&
      bootPos("/js/app-onboarding.js") < bootPos("/js/app-startup.js"),
    "app-onboarding.js must load after discipline priming and before startup"
  );
  assert.ok(
    bootPos("/js/app-startup.js") > bootPos("/js/app-onboarding.js") &&
      bootPos("/js/app-startup.js") < bootPos("/js/10-boot.js"),
    "app-startup.js must load after app shell helpers and before 10-boot.js"
  );
  assert.match(dateUtils, /\/\/ @ts-check/);
  assert.match(htmlUtils, /\/\/ @ts-check/);
  assert.match(markdownClient, /\/\/ @ts-check/);
  assert.match(uiComponents, /\/\/ @ts-check/);
  assert.match(exerciseDetailClient, /\/\/ @ts-check/);
  assert.match(exerciseDetailController, /\/\/ @ts-check/);
  assert.match(formatUtils, /\/\/ @ts-check/);
  assert.match(apiClient, /\/\/ @ts-check/);
  assert.match(appDownload, /\/\/ @ts-check/);
  assert.match(appSwRecovery, /\/\/ @ts-check/);
  assert.match(artController, /\/\/ @ts-check/);
  assert.match(uiHeader, /\/\/ @ts-check/);
  assert.match(agentLoginModelClient, /\/\/ @ts-check/);
  assert.match(agentLoginAssetsClient, /\/\/ @ts-check/);
  assert.match(agentLoginModalClient, /\/\/ @ts-check/);
  assert.match(agentLoginSessionClient, /\/\/ @ts-check/);
  assert.match(agentJobClient, /\/\/ @ts-check/);
  assert.match(agentJobClientSource, /function\s+registerJobReconnector/);
  assert.match(agentJobClientSource, /async function\s+enqueueJob/);
  assert.match(agentJobClientSource, /function\s+openJobStream/);
  assert.match(agentJobClientSource, /async function\s+jobReconnect/);
  assert.match(agentJobClientSource, /function\s+teardownJobs/);
  assert.match(agentJobClientSource, /async function\s+runOp/);
  assert.match(agentJobClient, /Object\.assign\(globalThis,\s*\{/);
  assert.doesNotMatch(chat, /\bconst\s+jobStreams\b/);
  assert.doesNotMatch(chat, /\bfunction\s+registerJobReconnector\b/);
  assert.match(chat, /Durable agent job helpers live in \/js\/agent-job-client\.js/);
  assert.match(pwaInstall, /\/\/ @ts-check/);
  assert.match(agentLoginClient, /\/\/ @ts-check/);
  assert.match(restTimer, /\/\/ @ts-check/);
  assert.match(coachingFocusClient, /\/\/ @ts-check/);
  assert.match(todayActivityClient, /\/\/ @ts-check/);
  assert.match(swrCache, /\/\/ @ts-check/);
  assert.match(todayAgendaClient, /\/\/ @ts-check/);
  assert.match(todayTrainingClient, /\/\/ @ts-check/);
  assert.match(todayProgressionController, /\/\/ @ts-check/);
  assert.match(todayAddExerciseController, /\/\/ @ts-check/);
  assert.match(todayBriefClient, /\/\/ @ts-check/);
  assert.match(cardioPlanClient, /\/\/ @ts-check/);
  assert.match(todaySessionSuggestClient, /\/\/ @ts-check/);
  assert.match(todaySessionSuggestController, /\/\/ @ts-check/);
  assert.match(todaySessionStatusClient, /\/\/ @ts-check/);
  assert.match(todayProgramAdjustmentsClient, /\/\/ @ts-check/);
  assert.match(todayWeekAheadClient, /\/\/ @ts-check/);
  assert.match(todayContextClient, /\/\/ @ts-check/);
  assert.match(todayGarminReconciliationClient, /\/\/ @ts-check/);
  assert.match(todaySideLoadersClient, /\/\/ @ts-check/);
  assert.match(todayDependenciesClient, /\/\/ @ts-check/);
  assert.match(progressDataClient, /\/\/ @ts-check/);
  assert.match(progressEnduranceClient, /\/\/ @ts-check/);
  assert.match(progressComponentsClient, /\/\/ @ts-check/);
  assert.match(progressChartScrubClient, /\/\/ @ts-check/);
  assert.match(progressChartClient, /\/\/ @ts-check/);
  assert.match(progressTrendWeightClient, /\/\/ @ts-check/);
  assert.match(progressRunPlanClient, /\/\/ @ts-check/);
  assert.match(progressRouteDepsClient, /\/\/ @ts-check/);
  assert.match(progressVolumeClient, /\/\/ @ts-check/);
  assert.match(progressEnergyClient, /\/\/ @ts-check/);
  assert.match(progressEnergySurfaceClient, /\/\/ @ts-check/);
  assert.match(progressCalendarClient, /\/\/ @ts-check/);
  assert.match(progressMuscleTrajectoryClient, /\/\/ @ts-check/);
  assert.match(progressDexaTargetingClient, /\/\/ @ts-check/);
  assert.match(progressPerformanceClient, /\/\/ @ts-check/);
  assert.match(progressProgramAdjustmentsClient, /\/\/ @ts-check/);
  assert.match(progressTestWeekClient, /\/\/ @ts-check/);
  assert.match(captureReads, /\/\/ @ts-check/);
  assert.match(capture, /\/\/ @ts-check/);
  assert.match(mealRecipeClient, /\/\/ @ts-check/);
  assert.match(mealRecipeController, /\/\/ @ts-check/);
  assert.match(meProfileController, /\/\/ @ts-check/);
  assert.match(healthClient, /\/\/ @ts-check/);
  assert.match(healthDocsClient, /\/\/ @ts-check/);
  assert.match(chatClient, /\/\/ @ts-check/);
  assert.match(chatTurnRecordsClient, /\/\/ @ts-check/);
  assert.match(chatTurnClient, /\/\/ @ts-check/);
  assert.match(settingsClient, /\/\/ @ts-check/);
  assert.match(appRouter, /\/\/ @ts-check/);
  assert.match(appRouteSync, /\/\/ @ts-check/);
  assert.match(appRenderDispatch, /\/\/ @ts-check/);
  assert.match(appTabs, /\/\/ @ts-check/);
  assert.match(appJobReconnectors, /\/\/ @ts-check/);
  assert.match(appMobileViewport, /\/\/ @ts-check/);
  assert.match(appServiceWorker, /\/\/ @ts-check/);
  assert.match(appDisciplinePrimer, /\/\/ @ts-check/);
  assert.match(appOnboarding, /\/\/ @ts-check/);
  assert.match(appStartup, /\/\/ @ts-check/);
  assert.match(publicScriptCheck, /ts\.createSourceFile/);
  assert.match(publicScriptCheck, /topLevelBindings/);
  assert.match(publicScriptCheck, /prior\.lexical\s*\|\|\s*binding\.lexical/);
  assert.match(publicScriptCheck, /public app-shell script globals are safe/);
  assert.match(clientBuild, /export const CLIENT_OUTPUTS = \[/);
  assert.match(clientBuild, /src\/client\/date-utils\.ts/);
  assert.match(clientBuild, /public\/js\/date-utils\.js/);
  assert.match(clientBuild, /src\/client\/html-utils\.ts/);
  assert.match(clientBuild, /public\/js\/html-utils\.js/);
  assert.match(clientBuild, /src\/client\/markdown-client\.ts/);
  assert.match(clientBuild, /public\/js\/markdown-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-actions-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-actions-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-view-transitions-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-view-transitions-client\.js/);
  assert.match(clientBuild, /src\/client\/exercise-detail-client\.ts/);
  assert.match(clientBuild, /public\/js\/exercise-detail-client\.js/);
  assert.match(clientBuild, /src\/client\/format-utils\.ts/);
  assert.match(clientBuild, /public\/js\/format-utils\.js/);
  assert.match(clientBuild, /src\/client\/api-client\.ts/);
  assert.match(clientBuild, /public\/js\/api-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/download\.ts/);
  assert.match(clientBuild, /public\/js\/app-download\.js/);
  assert.match(clientBuild, /src\/client\/app\/sw-recovery\.ts/);
  assert.match(clientBuild, /public\/js\/app-sw-recovery\.js/);
  assert.match(clientBuild, /src\/client\/art-controller\.ts/);
  assert.match(clientBuild, /public\/js\/art-controller\.js/);
  assert.match(clientBuild, /src\/client\/ui-header-client\.ts/);
  assert.match(clientBuild, /public\/js\/ui-header-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-shell\.ts/);
  assert.match(clientBuild, /public\/js\/02-ui\.js/);
  assert.match(clientBuild, /src\/client\/detail-overlay-client\.ts/);
  assert.match(clientBuild, /public\/js\/detail-overlay-client\.js/);
  assert.match(clientBuild, /src\/client\/pwa-install-coach\.ts/);
  assert.match(clientBuild, /public\/js\/pwa-install-coach\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-model-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-model-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-assets-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-assets-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-modal-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-modal-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-session-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-session-client\.js/);
  assert.match(clientBuild, /src\/client\/agent-login-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-login-client\.js/);
  assert.match(clientBuild, /src\/client\/rest-timer\.ts/);
  assert.match(clientBuild, /public\/js\/rest-timer\.js/);
  assert.match(clientBuild, /src\/client\/coaching-focus-client\.ts/);
  assert.match(clientBuild, /public\/js\/coaching-focus-client\.js/);
  assert.match(clientBuild, /src\/client\/today-activity-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-activity-client\.js/);
  assert.match(clientBuild, /src\/client\/save-bar\.ts/);
  assert.match(clientBuild, /public\/js\/save-bar\.js/);
  assert.match(clientBuild, /src\/client\/swr-cache\.ts/);
  assert.match(clientBuild, /public\/js\/swr-cache\.js/);
  assert.match(clientBuild, /src\/client\/today-agenda-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-agenda-client\.js/);
  assert.match(clientBuild, /src\/client\/today-rail-loaders-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-rail-loaders-client\.js/);
  assert.match(clientBuild, /src\/client\/today-rail-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-rail-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-training-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-training-client\.js/);
  assert.match(clientBuild, /src\/client\/today-progression-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-progression-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-add-exercise-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-add-exercise-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-override-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-override-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-actions-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-actions-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-controller\.js/);
  assert.match(clientBuild, /src\/client\/cardio-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/cardio-sync-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-sync-client\.js/);
  assert.match(clientBuild, /src\/client\/today-lately-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-lately-client\.js/);
  assert.match(clientBuild, /src\/client\/proposal-client\.ts/);
  assert.match(clientBuild, /public\/js\/proposal-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-suggest-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-suggest-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-suggest-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-suggest-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-session-status-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-status-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-feedback-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-feedback-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-skip-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-skip-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-set-model\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-set-model\.js/);
  assert.match(clientBuild, /src\/client\/today-session-set-actions\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-set-actions\.js/);
  assert.match(clientBuild, /src\/client\/today-session-controller\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-controller\.js/);
  assert.match(clientBuild, /src\/client\/today-cards-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-cards-client\.js/);
  assert.match(clientBuild, /src\/client\/today-program-adjustments-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-program-adjustments-client\.js/);
  assert.match(clientBuild, /src\/client\/today-week-ahead-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-week-ahead-client\.js/);
  assert.match(clientBuild, /src\/client\/today-context-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-context-client\.js/);
  assert.match(clientBuild, /src\/client\/today-side-loaders\.ts/);
  assert.match(clientBuild, /public\/js\/today-side-loaders\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-model\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-model\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-data-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-session-preparation\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-session-preparation\.js/);
  assert.match(clientBuild, /src\/client\/today-data-loader\.ts/);
  assert.match(clientBuild, /public\/js\/today-data-loader\.js/);
  assert.match(clientBuild, /src\/client\/today-main-shell-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-main-shell-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/today-plan-surface-renderer\.ts/);
  assert.match(clientBuild, /public\/js\/today-plan-surface-renderer\.js/);
  assert.match(clientBuild, /src\/client\/today-render-state-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-render-state-client\.js/);
  assert.match(clientBuild, /src\/client\/today-post-render-wiring\.ts/);
  assert.match(clientBuild, /public\/js\/today-post-render-wiring\.js/);
  assert.match(clientBuild, /src\/client\/today-dependencies\.ts/);
  assert.match(clientBuild, /public\/js\/today-dependencies\.js/);
  assert.match(clientBuild, /src\/client\/today-screen\.ts/);
  assert.match(clientBuild, /public\/js\/03-today\.js/);
  assert.match(clientBuild, /src\/client\/progress-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-data-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-components-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-components-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-line-chart-model\.ts/);
  assert.match(clientBuild, /public\/js\/progress-line-chart-model\.js/);
  assert.match(clientBuild, /src\/client\/progress-chart-scrub-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-chart-scrub-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-chart-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-chart-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-history-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-history-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-run-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-run-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-route-deps-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-route-deps-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-endurance-controller\.ts/);
  assert.match(clientBuild, /public\/js\/progress-endurance-controller\.js/);
  assert.match(clientBuild, /src\/client\/progress-volume-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-volume-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-energy-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-energy-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-energy-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-energy-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-calendar-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-calendar-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-muscle-trajectory-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-muscle-trajectory-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-dexa-targeting-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-dexa-targeting-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-performance-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-performance-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-adjustments-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-adjustments-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-test-week-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-test-week-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-summary-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-summary-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-block-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-block-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-program-controller\.ts/);
  assert.match(clientBuild, /public\/js\/progress-program-controller\.js/);
  assert.match(clientBuild, /src\/client\/capture\.ts/);
  assert.match(clientBuild, /public\/js\/04-capture\.js/);
  assert.match(clientBuild, /src\/client\/settings-routes\.ts/);
  assert.match(clientBuild, /public\/js\/settings-routes\.js/);
  assert.match(clientBuild, /src\/client\/settings-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-surface-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-surface-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-data-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-data-controller\.ts/);
  assert.match(clientBuild, /public\/js\/settings-data-controller\.js/);
  assert.match(clientBuild, /src\/client\/settings-agents-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-agents-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-agents-controller\.ts/);
  assert.match(clientBuild, /public\/js\/settings-agents-controller\.js/);
  assert.match(clientBuild, /src\/client\/settings-sources-automation-controller\.ts/);
  assert.match(clientBuild, /public\/js\/settings-sources-automation-controller\.js/);
  assert.match(clientBuild, /src\/client\/settings-screen\.ts/);
  assert.match(clientBuild, /public\/js\/settings-screen\.js/);
  assert.match(clientBuild, /src\/client\/chat-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-attachment-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-attachment-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-composer-focus-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-composer-focus-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-composer-controller\.ts/);
  assert.match(clientBuild, /public\/js\/chat-composer-controller\.js/);
  assert.match(clientBuild, /src\/client\/chat-message-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-message-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-turn-records-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-turn-records-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-layout-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-layout-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-turn-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-turn-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-history-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-history-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-endurance-model\.ts/);
  assert.match(clientBuild, /public\/js\/plan-endurance-model\.js/);
  assert.match(clientBuild, /src\/client\/plan-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-editor-form-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-editor-form-client\.js/);
  assert.match(clientBuild, /src\/client\/chat-screen\.ts/);
  assert.match(clientBuild, /public\/js\/09-plan-chat\.js/);
  assert.match(clientBuild, /src\/client\/day-fuel-client\.ts/);
  assert.match(clientBuild, /public\/js\/day-fuel-client\.js/);
  assert.match(clientBuild, /src\/client\/day-fuel-controller\.ts/);
  assert.match(clientBuild, /public\/js\/day-fuel-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-row-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-row-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-recipe-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-recipe-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-recipe-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-recipe-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-data-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-data-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-row-actions-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-row-actions-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-swap-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-swap-controller\.js/);
  assert.match(clientBuild, /src\/client\/meal-planner-controller\.ts/);
  assert.match(clientBuild, /public\/js\/meal-planner-controller\.js/);
  assert.match(clientBuild, /src\/client\/coach-proposal-controller\.ts/);
  assert.match(clientBuild, /public\/js\/coach-proposal-controller\.js/);
  assert.match(clientBuild, /src\/client\/coach-meals-screen\.ts/);
  assert.match(clientBuild, /public\/js\/06-coach-meals\.js/);
  assert.match(clientBuild, /src\/client\/food-note-client\.ts/);
  assert.match(clientBuild, /public\/js\/food-note-client\.js/);
  assert.match(clientBuild, /src\/client\/health-marker-order-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-marker-order-client\.js/);
  assert.match(clientBuild, /src\/client\/health-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-client\.js/);
  assert.match(clientBuild, /src\/client\/health-directives-loader-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-directives-loader-client\.js/);
  assert.match(clientBuild, /src\/client\/health-read-supplements-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-read-supplements-client\.js/);
  assert.match(clientBuild, /src\/client\/health-read-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-read-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-learned-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-learned-client\.js/);
  assert.match(clientBuild, /src\/client\/memory-client\.ts/);
  assert.match(clientBuild, /public\/js\/memory-client\.js/);
  assert.match(clientBuild, /src\/client\/me-memory-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-memory-controller\.js/);
  assert.match(clientBuild, /src\/client\/life-client\.ts/);
  assert.match(clientBuild, /public\/js\/life-client\.js/);
  assert.match(clientBuild, /src\/client\/life-controller\.ts/);
  assert.match(clientBuild, /public\/js\/life-controller\.js/);
  assert.match(clientBuild, /src\/client\/family-client\.ts/);
  assert.match(clientBuild, /public\/js\/family-client\.js/);
  assert.match(clientBuild, /src\/client\/family-controller\.ts/);
  assert.match(clientBuild, /public\/js\/family-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-health-screen\.ts/);
  assert.match(clientBuild, /public\/js\/07-me-health\.js/);
  assert.match(clientBuild, /src\/client\/me-records-screen\.ts/);
  assert.match(clientBuild, /public\/js\/08-me-records\.js/);
  assert.match(clientBuild, /src\/client\/health-doc-upload-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-doc-upload-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-doc-actions-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-doc-actions-controller\.js/);
  assert.match(clientBuild, /src\/client\/me-records-health-doc-controller\.ts/);
  assert.match(clientBuild, /public\/js\/me-records-health-doc-controller\.js/);
  assert.match(clientBuild, /src\/client\/health-share-controller\.ts/);
  assert.match(clientBuild, /public\/js\/health-share-controller\.js/);
  assert.match(clientBuild, /src\/client\/app\/router\.ts/);
  assert.match(clientBuild, /public\/js\/app-router\.js/);
  assert.match(clientBuild, /src\/client\/app\/route-sync\.ts/);
  assert.match(clientBuild, /public\/js\/app-route-sync\.js/);
  assert.match(clientBuild, /src\/client\/app\/render-dispatch\.ts/);
  assert.match(clientBuild, /public\/js\/app-render-dispatch\.js/);
  assert.match(clientBuild, /src\/client\/app\/tabs\.ts/);
  assert.match(clientBuild, /public\/js\/app-tabs\.js/);
  assert.match(clientBuild, /src\/client\/agent-job-client\.ts/);
  assert.match(clientBuild, /public\/js\/agent-job-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/job-reconnectors\.ts/);
  assert.match(clientBuild, /public\/js\/app-job-reconnectors\.js/);
  assert.match(clientBuild, /src\/client\/app\/mobile-viewport\.ts/);
  assert.match(clientBuild, /public\/js\/app-mobile-viewport\.js/);
  assert.match(clientBuild, /src\/client\/app\/service-worker\.ts/);
  assert.match(clientBuild, /public\/js\/app-service-worker\.js/);
  assert.match(clientBuild, /src\/client\/app\/discipline-primer\.ts/);
  assert.match(clientBuild, /public\/js\/app-discipline-primer\.js/);
  assert.match(clientBuild, /src\/client\/app\/onboarding\.ts/);
  assert.match(clientBuild, /public\/js\/app-onboarding\.js/);
  assert.match(clientBuild, /src\/client\/app\/startup\.ts/);
  assert.match(clientBuild, /public\/js\/app-startup\.js/);
  assert.match(clientBuild, /src\/client\/route-state\.ts/);
  assert.match(clientBuild, /public\/js\/route-state\.js/);
  assert.match(clientBuild, /export function buildClient\(\)/);
  assert.match(clientBuild, /process\.argv\[1\]/);
  assert.match(clientBuildCheck, /from "\.\/build-client\.mjs"/);
  assert.match(clientBuildCheck, /CLIENT_OUTPUTS\.map/);
  assert.match(clientBuildCheck, /Generated\s+public\/js output is ignored by git/);
  assert.match(clientBuildCheck, /git",\s*\["ls-files",\s*"--",\s*"public\/js\/\*\.js"\]/);
  assert.match(clientBuildCheck, /public\/js\/10-boot\.js/);
  assert.match(clientBuildCheck, /generated client output is tracked by git/);
  assert.match(clientBuildCheck, /client build output generated from TypeScript/);
  assert.match(gitignore, /public\/js\/\*\.js/);
  assert.match(gitignore, /!public\/js\/10-boot\.js/);
  assert.match(dockerignore, /public\/js\/\*\.js/);
  assert.match(dockerignore, /!public\/js\/10-boot\.js/);
  assert.match(contracts, /export \* from "\.\/client-api\.js"/);
  assert.match(contracts, /export \* from "\.\/client-api-coverage\.js"/);
  assert.match(apiContracts, /export interface ClientApiResponses/);
  assert.match(apiContracts, /export type ClientAgentConfig = ClientAgentInfo\[\]/);
  assert.match(apiContracts, /"\/api\/agents": ClientAgentConfig/);
  assert.match(apiContracts, /"\/api\/today-agenda": ClientTodayAgenda/);
  assert.match(apiContracts, /"\/api\/coaching-focus": ClientCoachingFocus/);
  assert.match(apiContracts, /"\/api\/nutrition\/day": ClientDayIntake/);
  assert.match(apiContracts, /"\/api\/program\/progression": ClientPrescription\[\]/);
  assert.match(apiContracts, /export interface ClientGarminActivity/);
  assert.match(apiContracts, /export interface ClientGarminReconcileResponse extends ClientOkResponse/);
  assert.match(apiContracts, /"\/api\/garmin\/daily": ClientGarminDailyMetric\[\]/);
  assert.match(apiContracts, /"\/api\/garmin\/unreconciled": ClientGarminActivity\[\]/);
  assert.match(apiContracts, /"\/api\/garmin\/reconcile": ClientGarminReconcileResponse/);
  assert.match(apiContracts, /"\/api\/learned-timeline": ClientLearnedTimeline/);
  assert.match(apiContracts, /"\/api\/learnings": ClientOutcomeLearningsResponse/);
  assert.match(apiContracts, /"\/api\/memory": ClientMemory\[\] \| ClientMemory/);
  assert.match(apiContracts, /Path extends `\/memory\/\$\{string\}\/supersede` \? ClientMemorySupersedeResponse/);
  const memorySupersedePattern = "Path extends `/memory/$" + "{string}/supersede`";
  const memoryIdPattern = "Path extends `/memory/$" + "{string}`";
  const planTargetPattern = "Path extends `/plan/$" + "{string}/target`";
  const planIdPattern = "Path extends `/plan/$" + "{string}`";
  assert.ok(
    apiContracts.indexOf(memorySupersedePattern) < apiContracts.indexOf(memoryIdPattern),
    "specific memory supersede route must be typed before generic /memory/:id"
  );
  assert.ok(
    apiContracts.indexOf(planTargetPattern) < apiContracts.indexOf(planIdPattern),
    "specific plan target route must be typed before generic /plan/:id"
  );
  assert.match(apiContracts, /"\/api\/chat\/sessions": ClientChatSessionSummary\[\]/);
  assert.match(apiContracts, /"\/api\/session-suggest": ClientSessionSuggestResponse/);
  assert.match(apiContracts, /"\/api\/exercises\/reconcile-names": ClientExerciseNameReconcileResponse/);
  assert.match(apiContracts, /"\/api\/week-ahead": ClientWeekAheadResponse/);
  assert.match(apiContracts, /"\/api\/recent-training": ClientRecentTrainingFeedRow\[\]/);
  assert.match(apiContracts, /"\/api\/endurance-prs": ClientEndurancePRs/);
  assert.match(apiContracts, /"\/api\/run-compliance": ClientRunCompliance/);
  assert.match(apiContracts, /"\/api\/cardio": ClientCardioEffort\[\]/);
  assert.match(apiContracts, /"\/api\/endurance-goal": ClientEnduranceGoal \| null/);
  assert.match(apiContracts, /"\/api\/program-state": ClientProgramState/);
  assert.match(apiContracts, /"\/api\/performance": ClientPerformanceStanding/);
  assert.match(apiContracts, /"\/api\/health\/standing": ClientHealthStanding/);
  assert.match(apiContracts, /ClientAgentJobEnvelope/);
  assert.match(apiContracts, /"\/api\/chat\/sessions\/:sessionId": ClientChatMessage\[\]/);
  assert.match(apiContracts, /export type ClientApiResponse<Path extends string>/);
  assert.match(apiCoverage, /export const CLIENT_API_CONTRACT_PATHS/);
  assert.match(apiCoverage, /export const CLIENT_API_UNKNOWN_WAIVERS/);
  assert.doesNotMatch(apiCoverage, /pattern:\s*"\/garmin\/(?:daily|unreconciled|reconcile)"/);
  assert.match(compat, /AssertAssignable<TodayAgenda, ClientTodayAgenda>/);
  assert.match(compat, /AssertAssignable<CoachingFocus, ClientCoachingFocus>/);
  assert.match(compat, /ReturnType<typeof getDayIntake>/);
  assert.match(compat, /ReturnType<typeof planDayProgression>/);
  assert.match(compat, /ReturnType<typeof weekAheadRead>/);
  assert.match(compat, /ReturnType<typeof reconcileExercises>/);
  assert.match(compat, /AssertAssignable<ProgramState, ClientProgramState>/);
  assert.match(compat, /AssertAssignable<PerformanceStanding, ClientPerformanceStanding>/);
  assert.match(compat, /ReturnType<typeof healthStanding>/);
  assert.match(compat, /AssertAssignable<ProgramBlock, ClientProgramBlock>/);
  assert.match(compat, /AssertAssignable<GuidelineEntry, ClientGuidelineEntry>/);
  assert.match(compat, /ReturnType<typeof getInjuryImpacts>/);
  assert.match(compat, /AssertAssignable<FeedRow, ClientRecentTrainingFeedRow>/);
  assert.match(compat, /AssertAssignable<EndurancePRs, ClientEndurancePRs>/);
  assert.match(compat, /AssertAssignable<RunCompliance, ClientRunCompliance>/);
  assert.match(compat, /ReturnType<typeof getRunCompliance>/);
  assert.match(compat, /AssertAssignable<CardioEffort, ClientCardioEffort>/);
  assert.match(compat, /ReturnType<typeof getCardioForDate>/);
  assert.match(compat, /ReturnType<typeof getEnduranceGoal>/);
  assert.match(compat, /Awaited<ReturnType<typeof suggestSession>>/);
  assert.match(compat, /ReturnType<typeof learnedTimeline>/);
  assert.match(compat, /ReturnType<typeof getOutcomeLearnings>/);
  assert.match(compat, /ReturnType<typeof listMemory>\[number\]/);
  assert.match(compat, /AssertAssignable<ArchivedChatSession, ClientChatSessionSummary>/);
  assert.match(compat, /AssertAssignable<ChatSearchHit, ClientChatSearchHit>/);
  assert.match(dateUtilsSource, /function localISO\(d = new Date\(\)\): string/);
  assert.match(htmlUtilsSource, /function escHtml\(value: unknown\): string/);
  assert.match(markdownSource, /function mdToHtml\(source: unknown\): string/);
  assert.match(markdownSource, /Object\.assign\(globalThis, \{/);
  assert.match(markdownSource, /CairnMarkdown/);
  assert.match(uiComponentsSource, /function emptyStateHtml\(options: EmptyStateOptions\): string/);
  assert.match(uiComponentsSource, /function textChipHtml\(options: TextChipOptions\): string/);
  assert.match(uiComponentsSource, /function loadingStateHtml\(options: LoadingStateOptions\): string/);
  assert.match(uiComponentsSource, /function segmentedNavHtml\(options: SegmentedNavOptions\): string/);
  assert.match(uiComponentsSource, /function jobCaptionHtml\(options: JobCaptionOptions = \{\}\): string/);
  assert.match(uiComponentsSource, /function sheetChipHtml\(options: SheetChipOptions\): string/);
  assert.match(uiComponentsSource, /const CAIRN_UI = \{/);
  assert.match(detailOverlaySource, /function closeDetail\(instant\?: boolean\): void/);
  assert.match(detailOverlaySource, /function openDetailFrom\(tile: Element \| null \| undefined, build: \(\) => unknown\): void/);
  assert.match(detailOverlaySource, /function mountDetail\(inner: string, photoSrc\?: string \| null\): HTMLElement/);
  assert.match(detailOverlaySource, /const CAIRN_DETAIL_OVERLAY = \{/);
  assert.match(uiMotionSource, /function collapseEl\(input: Element \| null \| undefined/);
  assert.match(uiMotionSource, /function expandEl\(input: Element \| null \| undefined\): void/);
  assert.match(uiMotionSource, /const CAIRN_UI_MOTION = \{/);
  assert.match(uiMotionSource, /CairnUiMotion: CAIRN_UI_MOTION/);
  assert.match(exerciseDetailSource, /function exerciseDetailExplanation\(exercise: ExerciseDetailLike \| null \| undefined\): ExerciseExplanation/);
  assert.match(exerciseDetailSource, /function exerciseDetailExplanationHtml/);
  assert.match(exerciseDetailSource, /function validExerciseDetailExplanationPayload/);
  assert.match(exerciseDetailSource, /const CAIRN_EXERCISE_DETAIL = \{/);
  assert.match(exerciseDetailDataSource, /function exerciseDetailView\(row: ExerciseDetailDataRow, deps: ExerciseDetailDataDeps\): ExerciseDetailViewModel/);
  assert.match(exerciseDetailExplanationSource, /function hydrateExerciseExplanation\(el: ParentNode, row: ExerciseDetailExplanationClientRow, deps: ExerciseDetailExplanationDeps\): Promise<void>/);
  assert.match(exerciseDetailRenderSource, /function exerciseDetailModalHtml\(/);
  assert.match(exerciseDetailActionsSource, /function wireExerciseDetailActions\(/);
  assert.match(exerciseDetailControllerSource, /type ExerciseDetailControllerDeps = \{/);
  assert.match(exerciseDetailControllerSource, /function wireGuides\(scope: ParentNode \| null \| undefined, deps: ExerciseDetailControllerDeps\): void/);
  assert.match(exerciseDetailControllerSource, /async function openExerciseModal/);
  assert.match(exerciseDetailControllerSource, /CairnExerciseDetailData\.view/);
  assert.match(exerciseDetailControllerSource, /CairnExerciseDetailActions\.wireActions/);
  assert.doesNotMatch(exerciseDetailControllerSource, /const exerciseExplainMisses|function detailRows|function detailNumber/);
  assert.match(exerciseDetailControllerSource, /const CAIRN_EXERCISE_DETAIL_CONTROLLER = \{/);
  assert.match(uiShellSource, /CairnExerciseDetailController\.wireGuides/);
  assert.match(uiShellSource, /CairnExerciseDetailController\.exerciseExplanationHtml/);
  assert.doesNotMatch(uiShellSource, /async function openExerciseModal/);
  assert.doesNotMatch(uiShellSource, /function hydrateExerciseExplanation/);
  assert.match(uiActionsSource, /function showToast\(msg: unknown, opts: ToastOptions = \{\}\): void/);
  assert.match(uiActionsSource, /function armDestructiveAction\(btn: Element \| null \| undefined, onConfirm: \(\) => unknown/);
  assert.match(uiActionsSource, /const CAIRN_UI_ACTIONS = \{/);
  assert.match(uiViewTransitionsSource, /type UiViewTransitionDeps = \{/);
  assert.match(uiViewTransitionsSource, /function isViewTransitionAbort\(error: unknown\): boolean/);
  assert.match(uiViewTransitionsSource, /function create\(deps: UiViewTransitionDeps\): UiViewTransitionApi/);
  assert.match(uiViewTransitionsSource, /CairnUiViewTransitions: CAIRN_UI_VIEW_TRANSITIONS/);
  assert.match(uiShellSource, /CairnUiViewTransitions\.create\(\{ view, reducedMotion \}\)/);
  assert.doesNotMatch(uiShellSource, /function isViewTransitionAbort|document\.startViewTransition|_vtActive/);
  assert.match(formatUtilsSource, /function fmtWeight\(weight: unknown\): string/);
  assert.match(formatUtilsSource, /function formatFoodNum\(value: unknown\): string/);
  assert.match(apiClientSource, /function api<Path extends string>/);
  assert.match(apiClientSource, /type CairnApiResponse<Path extends string>/);
  assert.match(appSwRecoverySource, /function startServiceWorkerLifecycle\(\): void/);
  assert.match(appSwRecoverySource, /__cairnSwLifecycleStarted/);
  assert.match(appSwRecoverySource, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(appSwRecoverySource, /window\.registerServiceWorkerLifecycle = startServiceWorkerLifecycle/);
  assert.match(coreStateSource, /const query = <T extends Element = Element>/);
  assert.match(coreStateSource, /const appView = \(\(\) => \{/);
  assert.match(coreStateSource, /const appHeaderTitle = \(\(\) => \{/);
  assert.match(coreStateSource, /const appState: ClientAppState/);
  assert.match(coreStateSource, /Object\.assign\(globalThis, \{ \$: query, view: appView, headerTitle: appHeaderTitle, state: appState \}\)/);
  assert.match(artControllerSource, /function artImg\(kind: string, q: unknown/);
  assert.match(artControllerSource, /async function primeArtManifest\(\): Promise<void>/);
  assert.match(artControllerSource, /Object\.defineProperty\(globalThis, "artEnabled"/);
  assert.match(uiHeader, /CairnUiHeader/);
  assert.match(uiHeader, /function setTodayHeaderTitle/);
  assert.match(uiHeader, /function updateHeaderCondense/);
  assert.doesNotMatch(uiShellSource, /const ART_READY_LS|function artPhotoLoaded|function primeArtManifest/);
  assert.match(uiShellTypesSource, /type ToastOptions = \{ action\?: string; onAction\?: \(\) => void \}/);
  assert.match(uiShellTypesSource, /type UiRecord = Record<string, unknown>/);
  assert.match(uiShellSource, /function setTodayHeaderTitle\(\)/);
  assert.match(uiShellSource, /CairnUiHeader\.setTodayHeaderTitle/);
  assert.match(uiShellSource, /function toast\(msg: unknown, opts: ToastOptions = \{\}\): void/);
  assert.match(uiShellSource, /CairnUiActions\.toast/);
  assert.match(uiShellSource, /CairnUiActions\.armDelete/);
  assert.match(uiShellSource, /function wireGuides\(scope\?: ParentNode \| null\): void/);
  assert.match(uiSegmentsSource, /const UI_PROGRESS_SEGMENTS: readonly UiSegmentsSegment\[\]/);
  assert.match(uiSegmentsSource, /const progressHandlers: UiSegmentsHandlerMap = \{/);
  assert.match(uiSegmentsSource, /const planHandlers: UiSegmentsHandlerMap = \{/);
  assert.match(uiSegmentsSource, /Object\.defineProperty\(globalThis, "primaryDiscipline"/);
  assert.match(uiShellSource, /const PROGRESS_SEG: readonly UiSegment\[\] = uiSegmentsApi\(\)\.PROGRESS_SEG/);
  assert.match(uiShellSource, /const PROGRESS_HANDLERS: Record<string, \(\) => unknown> = uiSegments\(\)\.progressHandlers/);
  assert.match(uiShellSource, /function withViewTransition\(fn: \(\) => unknown\): Promise<unknown>/);
  assert.match(uiShellSource, /let pollToken: number = 0/);
  assert.match(uiShellSource, /async function pollEnrichment<T extends UiRecord = UiRecord>/);
  assert.doesNotMatch(uiShellSource, /openAgentLoginModal|xtermWindow|agent-login-ov/);
  assert.match(agentLoginModelSource, /function normalizeAgentLoginName\(value: unknown\): string/);
  assert.match(agentLoginModelSource, /function agentLoginProviderHintHtml\(name: string\): string/);
  assert.match(agentLoginModelSource, /function agentLoginStatus\(key: AgentLoginStatusKey\): string/);
  assert.match(agentLoginAssetsSource, /function agentLoginXtermWindow\(\): AgentLoginXtermGlobals/);
  assert.match(agentLoginAssetsSource, /function loadAgentLoginXtermAssets\(\): Promise<void>/);
  assert.match(agentLoginModalSource, /function ensureAgentLoginStyles\(\): void/);
  assert.match(agentLoginModalSource, /function closeAgentLoginModal\(overlay: AgentLoginOverlay \| null \| undefined\): void/);
  assert.match(agentLoginModalSource, /function createAgentLoginModal\(name: string, retryLogin: AgentLoginRetry\): AgentLoginModalHandle \| null/);
  assert.match(agentLoginSessionSource, /async function startAgentLoginSession\(name: string, modal: AgentLoginModalHandle\): Promise<void>/);
  assert.match(agentLoginSessionSource, /agentLoginWsUrl\(name\)/);
  assert.match(agentLoginSource, /async function openAgentLoginModal\(agentName: unknown\): Promise<void>/);
  assert.match(agentLoginSource, /session\.start\(name, handle\)/);
  assert.match(agentLoginSource, /Object\.assign\(globalThis, \{ openAgentLoginModal \}\)/);
  assert.match(pwaInstallSource, /function isStandalonePWA\(\): boolean/);
  assert.match(pwaInstallSource, /function renderPhoneCoachBanner\(container: Element \| null \| undefined\): void/);
  assert.match(pwaInstallSource, /Object\.assign\(globalThis, \{/);
  assert.match(pwaInstallSource, /CairnPwaInstall/);
  assert.match(restTimerSource, /function startRest\(seconds\?: number\): void/);
  assert.match(restTimerSource, /function stopRest\(\): void/);
  assert.match(restTimerSource, /Object\.assign\(globalThis, \{/);
  assert.match(restTimerSource, /CairnRestTimer/);
  assert.match(coachingFocusSource, /type ClientCoachingFocus = import\("\.\.\/contracts\/client\.js"\)\.ClientCoachingFocus/);
  assert.match(coachingFocusSource, /function coachingFocusCardHtml\(/);
  assert.match(coachingFocusSource, /async function loadCoachingFocus\(slotSelector: string, root\?: ParentNode \| null\): Promise<void>/);
  assert.match(coachingFocusSource, /function cfocusRoute\(go: unknown\): void/);
  assert.match(coachingFocusSource, /Object\.assign\(globalThis, \{/);
  assert.match(coachingFocusSource, /CairnCoachingFocus/);
  assert.match(todayActivitySource, /function actEntryHtml\(activity: ClientActivityLike\): string/);
  assert.match(todayActivitySource, /function updateActEntry\(el: Element, row: ClientActivityLike\): void/);
  assert.match(todayActivitySource, /Object\.assign\(globalThis, \{/);
  assert.match(todayActivitySource, /CairnTodayActivity/);
  assert.match(saveBarSource, /type SaveBarContext = \{/);
  assert.match(saveBarSource, /function mountSaveBar/);
  assert.match(saveBarSource, /Object\.assign\(globalThis, \{ hideSaveBar, mountSaveBar \}\)/);
  assert.match(swrCacheSource, /function cachedApi<Path extends string>/);
  assert.match(swrCacheSource, /function paintSWR<Path extends string>/);
  assert.match(
    todayAgendaSource,
    /type ClientTodayAgenda = import\("\.\.\/contracts\/client\.js"\)\.ClientTodayAgenda/
  );
  assert.match(todayAgendaSource, /function todayAgendaRailHtml/);
  assert.match(todayRailLoadersSource, /async function loadFuelToday\(date: string, deps: ClientTodayRailControllerDeps\): Promise<void>/);
  assert.match(todayRailLoadersSource, /async function loadProgramAdjustmentsBanner\(deps: ClientTodayRailControllerDeps\): Promise<void>/);
  assert.match(todayRailLoadersSource, /async function loadRecentActivities\(deps: ClientTodayRailControllerDeps\): Promise<void>/);
  assert.match(todayRailLoadersSource, /CairnTodayAgenda\.fuelCardHtml/);
  assert.match(todayRailLoadersSource, /CairnTodayGarminReconciliation\.load/);
  assert.match(todayRailControllerSource, /type TodayRailDeps = \{/);
  assert.match(todayRailControllerSource, /async function fetchTodayAgenda\(date: string, deps: TodayRailDeps\): Promise<TodayRailAgenda \| null>/);
  assert.match(todayRailControllerSource, /function runAgendaRail\(/);
  assert.match(todayRailControllerSource, /function wireGenericAgendaCards\(pending: TodayRailCandidate\[\], deps: TodayRailDeps\): void/);
  assert.match(todayRailControllerSource, /function railLoaders\(\): Window\["CairnTodayRailLoaders"\]/);
  assert.doesNotMatch(todayRailControllerSource, /async function loadFuelToday|async function loadRecentActivities|CairnTodayAgenda\.fuelCardHtml/);
  assert.match(todayRailControllerSource, /CairnTodayRailController/);
  assert.match(todayPlanSelectionSource, /type TodayPlanSelectionDeps = \{/);
  assert.match(todayPlanSelectionSource, /function planDayNumberForSession/);
  assert.match(todayPlanSelectionSource, /async function suggestedPlanDayNumber/);
  assert.match(todayPlanSelectionSource, /CairnTodayPlanSelection/);
  assert.match(
    todayTrainingSource,
    /type ClientPrescription = import\("\.\.\/contracts\/client\.js"\)\.ClientPrescription/
  );
  assert.match(todayTrainingSource, /const TODAY_RX_ACTION: Record<ClientProgressionAction, ClientProgressionMeta>/);
  assert.match(todayProgressionControllerSource, /type TodayProgressionDeps = \{/);
  assert.match(todayProgressionControllerSource, /function scheduleRxRefresh\(deps: TodayProgressionDeps\): void/);
  assert.match(todayProgressionControllerSource, /async function refreshAdaptedRx\(deps: TodayProgressionDeps\): Promise<void>/);
  assert.match(todayProgressionControllerSource, /CairnTodayProgressionController/);
  assert.match(todayAddExerciseControllerSource, /type TodayAddExerciseDeps = \{/);
  assert.match(todayAddExerciseControllerSource, /async function setupAddExercise\(deps: TodayAddExerciseDeps\): Promise<void>/);
  assert.match(todayAddExerciseControllerSource, /async function appendOffPlanCard\(name: string, mode: string \| null \| undefined, deps: TodayAddExerciseDeps\): Promise<void>/);
  assert.match(todayAddExerciseControllerSource, /CairnTodayAddExerciseController/);
  assert.match(todayBriefSource, /type ClientDayRead = import\("\.\.\/contracts\/client\.js"\)\.ClientDayRead/);
  assert.match(todayBriefSource, /function todayBriefHtml\(read: TodayBriefRead \| null \| undefined/);
  assert.match(todayBriefSource, /CairnTodayBrief/);
  assert.match(cardioPlanSource, /function cardioPrescription/);
  assert.match(cardioPlanSource, /Object\.assign\(globalThis, \{/);
  assert.match(cardioPlanSource, /CairnCardioPlan/);
  assert.match(cardioSyncSource, /function garminConfigured/);
  assert.match(cardioSyncSource, /function cardioSyncLine/);
  assert.match(cardioSyncSource, /function wireCardioSync/);
  assert.match(cardioSyncSource, /CairnCardioSync/);
  assert.match(todayLatelySource, /function garminSessionCard\(value: unknown\): string/);
  assert.match(todayLatelySource, /function latelyRow\(value: unknown\): string/);
  assert.match(todayLatelySource, /CairnTodayLately/);
  assert.match(proposalSource, /function applyResultMessage\(result: unknown\)/);
  assert.match(proposalSource, /function verifiedBadgeHtml\(verified: unknown\)/);
  assert.match(proposalSource, /function strengthChangeHtml\(change: unknown\)/);
  assert.match(todaySessionSuggestSource, /type ClientSessionSuggestion = import\("\.\.\/contracts\/client\.js"\)\.ClientSessionSuggestion/);
  assert.match(todaySessionSuggestSource, /function todaySuggestCardHtml\(session: SuggestedSessionLike/);
  assert.match(todaySessionSuggestSource, /function todaySuggestComposerHtml/);
  assert.match(todaySessionSuggestSource, /CairnTodaySessionSuggest/);
  assert.match(todaySessionSuggestControllerSource, /type TodaySessionSuggestDeps = \{/);
  assert.match(todaySessionSuggestControllerSource, /function sessionSuggestOpOpts\(deps: TodaySessionSuggestDeps\): TodaySessionSuggestRunOptions/);
  assert.match(todaySessionSuggestControllerSource, /function reconnectSessionSuggest\(_job: unknown, deps: TodaySessionSuggestDeps\)/);
  assert.match(todaySessionSuggestControllerSource, /CairnTodaySessionSuggestController/);
  assert.match(todaySessionStatusSource, /type ClientTrainingSession = import\("\.\.\/contracts\/client-api\.js"\)\.ClientTrainingSession/);
  assert.match(todaySessionStatusSource, /function todaySetsTonnage\(sets: unknown\): number/);
  assert.match(todaySessionStatusSource, /function todaySessionDoneCardHtml\(session: SessionLike/);
  assert.match(todaySessionStatusSource, /function todayFeedbackFormHtml\(session: SessionLike/);
  assert.match(todaySessionStatusSource, /CairnTodaySessionStatus/);
  assert.match(todaySessionFeedbackSource, /type TodaySessionFeedbackDeps = \{/);
  assert.match(todaySessionFeedbackSource, /function renderFeedback\(slot: Element \| null \| undefined, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps\): void/);
  assert.match(todaySessionFeedbackSource, /CairnTodaySessionFeedback/);
  assert.match(todaySessionSkipSource, /type TodaySessionSkipDeps = \{/);
  assert.match(todaySessionSkipSource, /function wireSkips\(deps: TodaySessionSkipDeps\): void/);
  assert.match(todaySessionSkipSource, /CairnTodaySessionSkip/);
  assert.match(todaySessionSetModelSource, /function logPayloadFromRow\(row: HTMLElement, deps: ClientTodaySessionControllerDeps\): TodaySessionSetPayloadResult/);
  assert.match(todaySessionSetModelSource, /function invalidateSetTruth\(deps: ClientTodaySessionControllerDeps\): void/);
  assert.match(todaySessionSetActionsSource, /function wireLogRow\(row: Element \| null \| undefined, deps: ClientTodaySessionControllerDeps\): void/);
  assert.match(todaySessionSetActionsSource, /CairnTodaySessionSetActions/);
  assert.match(todaySessionControllerSource, /type TodaySessionDeps = ClientTodaySessionControllerDeps/);
  assert.match(todaySessionControllerSource, /function wireSessionSurface\(options: TodaySessionSurfaceOptions, deps: TodaySessionDeps\): void/);
  assert.match(todaySessionControllerSource, /wireLogRow: CairnTodaySessionSetActions\.wireLogRow/);
  assert.doesNotMatch(todaySessionControllerSource, /function renderFeedbackForm/);
  assert.doesNotMatch(todaySessionControllerSource, /function skipFromCard/);
  assert.doesNotMatch(todaySessionControllerSource, /function wireLogRow|function wireDeletes|function bumpProgress/);
  assert.match(todaySessionControllerSource, /CairnTodaySessionController/);
  assert.match(todayProgramAdjustmentsSource, /function todayAdjustmentPlanRequest\(value: unknown\): string/);
  assert.match(todayProgramAdjustmentsSource, /function todayProgramAdjustmentsBannerHtml\(rows: unknown\): string/);
  assert.match(todayProgramAdjustmentsSource, /CairnTodayProgramAdjustments/);
  assert.match(todayWeekAheadSource, /type TodayWeekAheadResponse = import\("\.\.\/contracts\/client\.js"\)\.ClientWeekAheadResponse/);
  assert.match(todayWeekAheadSource, /function todayWeekAheadCardHtml\(value: unknown\): string/);
  assert.match(todayWeekAheadSource, /CairnTodayWeekAhead/);
  assert.match(todayContextSource, /function contextBannerHtml\(events: unknown, todayISO\?: string\): string/);
  assert.match(todayContextSource, /function goalLineHtml\(statsValue: unknown, currentWeight: unknown, isToday: unknown, todayISO\?: string\): string/);
  assert.match(todayContextSource, /function healthFocusBannerHtml\(value: unknown\): string/);
  assert.match(todayContextSource, /CairnTodayContext/);
  assert.match(todayCompassSource, /type TodayCompassBuild = \{/);
  assert.match(todayCompassSource, /function paceTileHtml\(statsValue: unknown, deps: TodayCompassDeps\): string/);
  assert.match(todayCompassSource, /function paceOffer\(statsValue: unknown, currentWeight: unknown\): TodayPaceOffer \| null/);
  assert.match(todayCompassSource, /function build\(statsValue: unknown, deps: TodayCompassDeps, options: TodayCompassOptions = \{\}\): TodayCompassBuild/);
  assert.match(todayCompassSource, /CairnTodayCompass/);
  assert.match(todayGarminReconciliationSource, /type TodayGarminReconcileOptions = \{/);
  assert.match(todayGarminReconciliationSource, /type ClientGarminReconcileResponse = import\("\.\.\/contracts\/client-api\.js"\)\.ClientGarminReconcileResponse/);
  assert.match(todayGarminReconciliationSource, /function reconcilePromptHtml\(count: number/);
  assert.match(todayGarminReconciliationSource, /async function load\(options: TodayGarminReconcileOptions\): Promise<void>/);
  assert.match(todayGarminReconciliationSource, /CairnTodayGarminReconciliation/);
  assert.match(todaySideLoadersSource, /type TodaySideLoaderDeps = \{/);
  assert.match(todaySideLoadersSource, /function garminSessionCard\(value: unknown\): string/);
  assert.match(todaySideLoadersSource, /async function loadWearable\(isToday: unknown, deps: TodaySideLoaderDeps\): Promise<void>/);
  assert.match(todaySideLoadersSource, /async function loadTableHint\(deps: TodaySideLoaderDeps\): Promise<void>/);
  assert.match(todaySideLoadersSource, /async function loadContextBanner\(deps: TodaySideLoaderDeps\): Promise<void>/);
  assert.match(todaySideLoadersSource, /async function loadDraftProposals\(deps: TodaySideLoaderDeps\): Promise<void>/);
  assert.match(todaySideLoadersSource, /async function loadHealthFocusBanner\(deps: TodaySideLoaderDeps\): Promise<void>/);
  assert.match(todaySideLoadersSource, /CairnTodaySideLoaders/);
  assert.match(todayPlanSessionModelSource, /type TodayPlanSessionModelApi = \{/);
  assert.match(todayPlanSessionModelSource, /function groupLoggedSets\(session: TodayPlanSessionModelSession \| null \| undefined\)/);
  assert.match(todayPlanSessionModelSource, /function matchCardioEfforts\(/);
  assert.match(todayPlanSessionModelSource, /function itemGroups\(params: \{/);
  assert.match(todayPlanSessionModelSource, /function prefillFor\(/);
  assert.match(todayPlanSessionModelSource, /CairnTodayPlanSessionModel/);
  assert.match(todayPlanSessionPreparationSource, /type TodayPlanSessionPrepDeps = \{/);
  assert.match(todayPlanSessionPreparationSource, /todayPlanSessionModel\.groupLoggedSets/);
  assert.match(todayPlanSessionPreparationSource, /todayPlanSessionModel\.matchCardioEfforts/);
  assert.match(todayPlanSessionPreparationSource, /async function preparePlanSession\(deps: TodayPlanSessionPrepDeps\): Promise<TodayPlanSessionPrepResult>/);
  assert.match(todayPlanSessionPreparationSource, /CairnTodayPlanSessionPreparation/);
  assert.match(todayDataLoaderSource, /type TodayDataLoadDeps = \{/);
  assert.match(todayDataLoaderSource, /async function loadInner\(/);
  assert.match(todayDataLoaderSource, /function scheduleSoftRepaint\(result: TodayDataLoadResult, deps: TodayDataRefreshDeps\): void/);
  assert.match(todayDataLoaderSource, /CairnTodayDataLoader/);
  assert.match(todayMainShellSource, /type TodayMainShellLeadOptions = \{/);
  assert.match(todayMainShellSource, /function leadHtml\(options: TodayMainShellLeadOptions, deps: TodayMainShellDeps\): string/);
  assert.match(todayMainShellSource, /function weekFoldHtml\(compass: TodayMainShellCompass/);
  assert.match(todayMainShellSource, /function wrapHtml\(content: string, options: \{ railHtml: string \}\): string/);
  assert.match(todayMainShellSource, /CairnTodayMainShell/);
  assert.match(todayPlanSurfaceSource, /type TodayPlanSurfaceDeps = \{/);
  assert.match(todayPlanSurfaceSource, /function sessionHeadHtml\(/);
  assert.match(todayPlanSurfaceSource, /function daySwitchHtml\(/);
  assert.match(todayPlanSurfaceSource, /function rxBannerHtml\(/);
  assert.match(todayPlanSurfaceSource, /function finishHtml\(/);
  assert.match(todayPlanSurfaceSource, /CairnTodayPlanSurface/);
  assert.match(todayPlanSurfaceRendererSource, /type TodayPlanSurfaceRendererOptions = \{/);
  assert.match(todayPlanSurfaceRendererSource, /function orderedSurfaceItems\(options: TodayPlanSurfaceRendererOptions/);
  assert.match(todayPlanSurfaceRendererSource, /function buildHtml\(options: TodayPlanSurfaceRendererOptions, deps: TodayPlanSurfaceRendererDeps\): string/);
  assert.match(todayPlanSurfaceRendererSource, /CairnTodayPlanSurfaceRenderer/);
  assert.match(todayRenderStateSource, /type TodayRenderStateInput = \{/);
  assert.match(todayRenderStateSource, /function derive\(input: TodayRenderStateInput\): TodayRenderStateResult/);
  assert.match(todayRenderStateSource, /CairnTodayRenderState/);
  assert.match(todayPostRenderWiringSource, /type TodayPostRenderWiringDeps = \{/);
  assert.match(todayPostRenderWiringSource, /function wirePostRender\(deps: TodayPostRenderWiringDeps\): void/);
  assert.match(todayPostRenderWiringSource, /CairnTodayPostRenderWiring/);
  assert.match(todayScreenSource, /todayPlanSessionPreparation\.preparePlanSession/);
  assert.match(todayScreenSource, /todayDataLoader\.load/);
  assert.match(todayScreenSource, /todayDataLoader\.scheduleSoftRepaint/);
  assert.match(todayScreenSource, /todayMainShell\.leadHtml/);
  assert.match(todayScreenSource, /todayMainShell\.weekFoldHtml/);
  assert.match(todayScreenSource, /todayMainShell\.wrapHtml/);
  assert.match(todayScreenSource, /todayPlanSurfaceRenderer\.buildHtml/);
  assert.match(todayScreenSource, /todayRenderState\.derive/);
  assert.doesNotMatch(todayScreenSource, /todayPlanSurface\.sessionHeadHtml|todayPlanSurface\.daySwitchHtml|todayPlanSurface\.rxBannerHtml|todayPlanSurface\.addExerciseFormHtml/);
  assert.match(todayScreenSource, /CairnTodayPostRenderWiring\.wirePostRender/);
  assert.doesNotMatch(todayScreenSource, /\/garmin\/daily\?limit=1|\/mealplans\?limit=6|\/context-events\?active=1|\/proposals\?limit=8|\/health\/synthesis/);
  assert.doesNotMatch(todayScreenSource, /function collapseEl\(/);
  assert.doesNotMatch(todayScreenSource, /function expandEl\(/);
  assert.match(
    todayScreenSource,
    /Object\.assign\(globalThis,\s*\{[\s\S]*postExerciseMode[\s\S]*reconnectDayReadOverride[\s\S]*reconnectSessionSuggest[\s\S]*renderToday[\s\S]*reshapeToday[\s\S]*\}\)/
  );
  assert.match(todayRailLoadersSource, /CairnTodayGarminReconciliation\.load/);
  assert.doesNotMatch(todayScreenSource, /CairnTodayGarminReconciliation\.load/);
  assert.match(todayCompatibilityBridgesSource, /CairnTodaySessionSuggestController\.reconnectSessionSuggest/);
  assert.match(todayCompatibilityBridgesSource, /CairnTodaySessionSuggestController\.revealSessionComposer/);
  assert.match(todayCompatibilityBridgesSource, /CairnTodaySessionSuggestController\.askForSession/);
  assert.match(todayScreenRuntimeSource, /CairnTodayCompatibilityBridges/);
  assert.doesNotMatch(todayScreenSource, /function sessionSuggestOpOpts|function wireSuggestCard|let sessionSuggestInFlight/);
  assert.match(todayCompatibilityBridgesSource, /CairnTodayAddExerciseController\.setupAddExercise/);
  assert.match(todayCompatibilityBridgesSource, /CairnTodayAddExerciseController\.appendOffPlanCard/);
  assert.doesNotMatch(todayScreenSource, /const datalist = todayView\.querySelector\("#exOptions"\)|function resetAddForm|const skippedBtn = \[\.\.\.todayView\.querySelectorAll\("#skipLine \[data-unskip\]"\)/);
  assert.match(todayScreenRuntimeSource, /type TodayScreenRuntimeApiResponse<Path extends string> = import\("\.\.\/contracts\/client\.js"\)\.ClientApiResponse<Path>/);
  assert.match(todayScreenSource, /type TodayState = Omit<typeof state/);
  assert.match(todayScreenSource, /pendingOffPlan\?: Record<string, Array<\{ name: string; mode\?: string \| null \}>>/);
  assert.match(todayScreenSource, /const todayState = state as TodayState/);
  assert.match(proposalSource, /function runTargetText\(run: unknown\): string/);
  assert.match(proposalSource, /function coachProposalCardHtml\(proposal: unknown, index: number, lastApplyClamp\?: unknown\): string/);
  assert.match(proposalSource, /function coachProposalListHtml\(proposals: unknown, lastApplyClamp\?: unknown\): string/);
  assert.match(proposalSource, /CairnProposal/);
  assert.match(progressDataSource, /function progressDataIsRecord\(value: unknown\): value is ProgressRecord/);
  assert.match(progressDataSource, /function progressDataRecord\(value: unknown\): ProgressRecord/);
  assert.match(progressDataSource, /function progressDataRows<T extends ProgressRecord = ProgressRecord>\(value: unknown\): T\[\]/);
  assert.match(progressDataSource, /function progressDataString\(value: unknown\): string/);
  assert.match(progressDataSource, /function progressDataNumber\(value: unknown, fallback = 0\): number/);
  assert.match(progressDataSource, /CairnProgressData: CAIRN_PROGRESS_DATA/);
  assert.doesNotMatch(progressScreenSource, /function isProgressRecord|function progressRecord|function progressRows|function progressString|function progressNumber/);
  assert.match(progressScreenSource, /CairnProgressData\.rows<ProgressExercise>/);
  assert.match(progressScreenSource, /CairnProgressData\.record\(profile\)/);
  assert.match(progressEnduranceSource, /function enduranceStatusWord\(status: unknown\): string/);
  assert.match(progressEnduranceSource, /function enduranceBlockHtml\(end: ProgramEnduranceBlock \| null \| undefined, idx: number\): string/);
  assert.match(progressEnduranceSource, /function paceTrendWord\(trend: unknown\): string/);
  assert.match(progressEnduranceSource, /function zoneBarHtml\(zones: unknown\): string/);
  assert.match(progressEnduranceSource, /type EnduranceSportGroup = import\("\.\.\/contracts\/client-api\.js"\)\.ClientSportBests/);
  assert.match(progressEnduranceSource, /function enduranceBestRows\(group: EnduranceSportGroup \| null \| undefined\): EnduranceBestPoint\[\]/);
  assert.match(progressEnduranceSource, /function enduranceSportCardHtml\(group: EnduranceSportGroup \| null \| undefined, idx: number\): string/);
  assert.match(progressEnduranceSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnduranceSource, /CairnProgressEndurance/);
  assert.match(progressComponentsSource, /function progressShortDate\(iso: unknown\): string/);
  assert.match(progressComponentsSource, /function progressHeroHtml\(title: unknown/);
  assert.match(progressComponentsSource, /function progressEmptyStateHtml\(svg: string \| null \| undefined, line: unknown\): string/);
  assert.match(progressComponentsSource, /fmtShortDate: progressShortDate/);
  assert.match(progressComponentsSource, /progressHero: progressHeroHtml/);
  assert.match(progressComponentsSource, /emptyStateHtml: progressEmptyStateHtml/);
  assert.match(progressComponentsSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressComponentsSource, /CairnProgressComponents/);
  assert.match(progressLineChartModelSource, /function buildProgressLineChartModel/);
  assert.match(progressLineChartModelSource, /function progressLineChartSlopes/);
  assert.match(progressLineChartModelSource, /function nearestProgressLineChartIndex/);
  assert.match(progressLineChartModelSource, /CairnProgressLineChartModel/);
  assert.match(progressChartScrubSource, /function progressChartIndexFromPointer/);
  assert.match(progressChartScrubSource, /function wireProgressChartScrub/);
  assert.match(progressChartScrubSource, /CairnProgressLineChartModel\.nearestIndex/);
  assert.match(progressChartScrubSource, /CairnProgressChartScrub/);
  assert.match(progressChartDrawingSource, /function withAlpha\(hex: unknown, alpha: number\): string/);
  assert.match(progressChartDrawingSource, /function chartColors\(\): ProgressChartPalette/);
  assert.match(progressChartDrawingSource, /function drawProgressChartBase/);
  assert.match(progressChartDrawingSource, /function drawProgressChartHighlight/);
  assert.match(progressChartDrawingSource, /CairnProgressChartDrawing/);
  assert.match(progressChartSource, /function drawLineChart/);
  assert.match(progressChartSource, /CairnProgressLineChartModel\.buildModel/);
  assert.match(progressChartSource, /CairnProgressChartDrawing\.drawBase/);
  assert.match(progressChartSource, /CairnProgressChartDrawing\.drawHighlight/);
  assert.match(progressChartSource, /CairnProgressChartScrub\.wire/);
  assert.match(progressChartSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressChartSource, /CairnProgressChart/);
  assert.match(progressTrendWeightSource, /function paintProgressBody\(exercises: ProgressExercise\[\]\): void/);
  assert.match(progressTrendWeightSource, /function paintWeightBody\(rows: ProgressWeightRow\[\], profile: ProgressRecord\): void/);
  assert.match(progressTrendWeightSource, /async function drawProgress\(name: string\): Promise<void>/);
  assert.match(progressTrendWeightSource, /CairnProgressTrendWeight/);
  assert.doesNotMatch(progressScreenSource, /function\s+paintProgressBody|function\s+paintWeightBody|async function\s+drawProgress/);
  assert.match(progressScreenSource, /CairnProgressTrendWeight\.paintProgressBody/);
  assert.match(progressScreenSource, /CairnProgressTrendWeight\.paintWeightBody/);
  assert.match(progressHistoryModelSource, /function progressHistoryRows<T extends ProgressHistoryRecord = ProgressHistoryRecord>\(value: unknown\): T\[\]/);
  assert.match(progressHistoryModelSource, /function progressHistorySummary\(sessions: HistorySession\[\], now: Date = new Date\(\)\): ProgressHistorySummary/);
  assert.match(progressHistoryModelSource, /CairnProgressHistoryModel/);
  assert.match(progressHistoryRenderSource, /function progressHistorySessionCardHtml\(session: unknown, index: number\): string/);
  assert.match(progressHistoryRenderSource, /function progressHistorySessionEditHtml\(session: HistorySession\): string/);
  assert.match(progressHistoryRenderSource, /CairnProgressHistoryRender/);
  assert.match(progressHistorySource, /function sessionCardHtml\(session: unknown, index: number\): string/);
  assert.match(progressHistorySource, /function numOrNull\(value: unknown\): number \| null/);
  assert.match(progressHistorySource, /async function renderHistory\(\)/);
  assert.match(progressHistorySource, /function paintHistoryBody\(sessions: HistorySession\[\]\)/);
  assert.match(progressHistorySource, /async function openSessionEdit\(sess: HistorySession, fromEl: Element\)/);
  assert.match(progressHistorySource, /CairnProgressHistoryModel\.summary/);
  assert.match(progressHistorySource, /CairnProgressHistoryRender\.sessionEditHtml/);
  assert.match(progressHistorySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressHistorySource, /CairnProgressHistory/);
  assert.match(progressRunPlanSource, /function weeklyRunPlanCard\(plan: WeeklyRunPlan \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /function enduranceGoalCard\(goal: EnduranceGoal \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /function runComplianceLine\(compliance: RunCompliance \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /function enduranceCoachLine\(plan: WeeklyRunPlan \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressRunPlanSource, /CairnProgressRunPlan/);
  assert.match(progressEnduranceControllerSource, /type ProgressEnduranceControllerDeps = \{/);
  assert.match(progressEnduranceControllerSource, /async function renderProgressEndurance\(deps: ProgressEnduranceControllerDeps\): Promise<void>/);
  assert.match(progressEnduranceControllerSource, /function paintProgressEnduranceBody\(/);
  assert.match(progressEnduranceControllerSource, /deps\.api\("\/endurance-prs"\)/);
  assert.match(progressEnduranceControllerSource, /CairnProgressEnduranceController/);
  assert.match(progressRouteDepsSource, /type ProgressRouteDepsApi = \{/);
  assert.match(progressRouteDepsSource, /function progressEnduranceRouteDeps\(renderSelf: ProgressRouteRenderSelf\): ClientProgressEnduranceControllerDeps/);
  assert.match(progressRouteDepsSource, /function progressProgramRouteDeps\(renderSelf: ProgressRouteRenderSelf\): ClientProgressProgramControllerDeps/);
  assert.match(progressRouteDepsSource, /nextToken: progressRouteNextToken/);
  assert.match(progressRouteDepsSource, /segmentHtml: progressRouteSegmentHtml/);
  assert.match(progressRouteDepsSource, /CairnProgressRouteDeps: CAIRN_PROGRESS_ROUTE_DEPS/);
  assert.match(progressVolumeSource, /function capWord\(input: unknown\): string/);
  assert.match(progressVolumeSource, /function volBalanceHtml\(balance: VolumeBalance \| null \| undefined\): string/);
  assert.match(progressVolumeSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressVolumeSource, /CairnProgressVolume/);
  assert.match(progressEnergySource, /function kcalFmt\(value: unknown\): string/);
  assert.match(progressEnergySource, /function energyRead\(exp: EnergyExpenditure \| null \| undefined\): EnergyRead/);
  assert.match(progressEnergySource, /function energyBodyHtml\(exp: EnergyExpenditure \| null \| undefined\): EnergyBodyHtml/);
  assert.match(progressEnergySource, /function nutritionCheckinLoadingHtml\(\): string/);
  assert.match(progressEnergySource, /function nutritionCheckinOkHtml\(result: NutritionCheckinResult \| null \| undefined\): string/);
  assert.match(progressEnergySource, /function nutritionCheckinFailHtml\(\): string/);
  assert.match(progressEnergySource, /function nutritionCheckinProposalHtml\(result: NutritionCheckinResult \| null \| undefined\): string/);
  assert.match(progressEnergySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnergySource, /CairnProgressEnergy/);
  assert.match(progressEnergySurfaceSource, /function paintEnergyBody\(exp: unknown\): void/);
  assert.match(progressEnergySurfaceSource, /function nutritionCheckinOpOpts\(restore: \(\(\) => void\) \| null\)/);
  assert.match(progressEnergySurfaceSource, /function reconnectNutritionCheckin\(\): ClientAgentOpHandlers \| null/);
  assert.match(progressEnergySurfaceSource, /function renderCheckinProposal\(out: Element, result: unknown\): void/);
  assert.match(progressEnergySurfaceSource, /CairnProgressEnergySurface/);
  assert.match(progressCalendarSource, /function calMonthHtml\(ym: string, byDate: Map<string, CalendarCell>, todayIso: string, idx: number\): string/);
  assert.match(progressCalendarSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressCalendarSource, /CairnProgressCalendar/);
  assert.match(progressMuscleTrajectorySource, /async function loadMuscleTrajectory\(\): Promise<void>/);
  assert.match(progressMuscleTrajectorySource, /function muscleTrajectoryHtml\(trajectory: MuscleTrajectory \| null \| undefined\): string/);
  assert.match(progressMuscleTrajectorySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressMuscleTrajectorySource, /CairnProgressMuscleTrajectory/);
  assert.match(progressDexaTargetingSource, /async function loadDexaTargeting\(slotId: string\): Promise<void>/);
  assert.match(progressDexaTargetingSource, /function dexaTargetingHtml\(targeting: DexaTargeting \| null \| undefined\): string/);
  assert.match(progressDexaTargetingSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressDexaTargetingSource, /CairnProgressDexaTargeting/);
  assert.match(progressPerformanceSource, /async function loadPerformance\(\): Promise<void>/);
  assert.match(progressPerformanceSource, /type PerformanceStanding = import\("\.\.\/contracts\/client-api\.js"\)\.ClientPerformanceStanding/);
  assert.match(progressPerformanceSource, /function pctClamp\(value: unknown\): number/);
  assert.match(progressPerformanceSource, /function capacityRowHtml\(capacity: PerformanceCapacity, sexWord: string\): string/);
  assert.match(progressPerformanceSource, /function performanceHtml\(performance: PerformanceStanding \| null \| undefined, options: PerformanceRenderOptions = \{\}\): string/);
  assert.match(progressPerformanceSource, /function progressFocusCardPresent\(\): boolean/);
  assert.doesNotMatch(progressPerformanceSource, /_progFocusCard/);
  assert.match(progressPerformanceSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressPerformanceSource, /CairnProgressPerformance/);
  assert.match(progressProgramAdjustmentsSource, /const PROGRAM_ADJUSTMENT_KIND: Record<string, AdjustmentMeta> = \{/);
  assert.match(progressProgramAdjustmentsSource, /async function loadProgramAdjustments\(\): Promise<void>/);
  assert.match(progressProgramAdjustmentsSource, /function programAdjustmentsHtml\(rows: unknown\): string/);
  assert.match(progressProgramAdjustmentsSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramAdjustmentsSource, /CairnProgressProgramAdjustments/);
  assert.match(progressTestWeekSource, /async function loadTestWeek\(\): Promise<void>/);
  assert.match(progressTestWeekSource, /function testWeekBannerHtml\(testWeek: TestWeekRead \| null \| undefined\): string/);
  assert.match(progressTestWeekSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressTestWeekSource, /CairnProgressTestWeek/);
  assert.match(progressProgramSummarySource, /type ProgramStateRead = import\("\.\.\/contracts\/client-api\.js"\)\.ClientProgramState/);
  assert.match(progressProgramSummarySource, /function liftStatusWord\(lift: ProgramLift \| null \| undefined\): string/);
  assert.match(progressProgramSummarySource, /function liftTrendFig\(lift: ProgramLift \| null \| undefined\): string/);
  assert.match(progressProgramSummarySource, /function liftBestFig\(lift: ProgramLift \| null \| undefined\): string/);
  assert.match(progressProgramSummarySource, /function sortLifts\(lifts: ProgramLift\[\] \| null \| undefined\): ProgramLift\[\]/);
  assert.match(progressProgramSummarySource, /function phaseWord\(phase: unknown\): string/);
  assert.match(progressProgramSummarySource, /function liftRowHtml\(lift: ProgramLift \| null \| undefined, index: number\): string/);
  assert.match(progressProgramSummarySource, /function volumeBlockHtml\(volume: ProgramVolumeRow\[\] \| null \| undefined, startIdx: number\): string/);
  assert.match(progressProgramSummarySource, /function mesoBlockHtml\(meso: ProgramMesocycle \| null \| undefined, index: number\): string/);
  assert.match(progressProgramSummarySource, /function adaptationsHtml\(adaptations: string\[\] \| null \| undefined, index: number\): string/);
  assert.match(progressProgramSummarySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramSummarySource, /CairnProgressProgramSummary/);
  assert.match(progressProgramBlockSource, /type ClientProgramBlock = import\("\.\.\/contracts\/client-api\.js"\)\.ClientProgramBlock/);
  assert.match(progressProgramBlockSource, /function blockFocusWord\(focus: ClientProgramBlockFocus \| unknown\): string/);
  assert.match(progressProgramBlockSource, /function activeBlockHtml\(block: ClientProgramBlock \| null \| undefined\): string/);
  assert.match(progressProgramBlockSource, /async function loadProgramBlock\(\): Promise<void>/);
  assert.match(progressProgramBlockSource, /function wireProgramBlock\(slot: Element\): void/);
  assert.match(progressProgramBlockSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramBlockSource, /CairnProgressProgramBlock/);
  assert.match(progressProgramControllerSource, /type ProgressProgramState = import\("\.\.\/contracts\/client-api\.js"\)\.ClientProgramState/);
  assert.match(progressProgramControllerSource, /type ProgressProgramStat = readonly \[unknown, unknown\]/);
  assert.match(progressProgramControllerSource, /var _progFocusCard: string \| undefined/);
  assert.match(progressProgramControllerSource, /async function renderProgressProgram\(deps: ClientProgressProgramControllerDeps\): Promise<unknown>/);
  assert.match(progressProgramControllerSource, /function paintProgressProgramBody\(data: ProgressProgramState, deps: ClientProgressProgramControllerDeps\): void/);
  assert.match(progressProgramControllerSource, /async function triggerProgramEvolve\(\n {2}btn: Element,\n {2}deps: ClientProgressProgramControllerDeps,/);
  assert.match(progressProgramControllerSource, /async function tidyExerciseNames\(btn: Element, deps: ClientProgressProgramControllerDeps\): Promise<void>/);
  assert.match(progressProgramControllerSource, /CairnProgressFocus: PROGRESS_FOCUS_STATE/);
  assert.match(progressProgramControllerSource, /CairnProgressProgramController/);
  assert.match(progressScreenSource, /function renderProgram\(\)/);
  assert.match(progressScreenSource, /CairnProgressRouteDeps\.endurance\(\(\) => renderEndurance\(\)\)/);
  assert.match(progressScreenSource, /CairnProgressRouteDeps\.program\(\(\) => renderProgram\(\)\)/);
  assert.match(progressScreenSource, /CairnProgressProgramController\.render\(CairnProgressRouteDeps\.program/);
  assert.match(progressScreenSource, /async function renderEnergy\(\)[\s\S]*state\.progressSeg = "energy"/);
  assert.doesNotMatch(progressScreenSource, /function renderHistory\(\)|function paintHistoryBody|function openSessionEdit/);
  assert.doesNotMatch(progressScreenSource, /function nutritionCheckinOpOpts|function reconnectNutritionCheckin|function renderCheckinProposal|function runNutritionCheckin/);
  assert.doesNotMatch(progressScreenSource, /function progressEnduranceDeps|function progressProgramDeps|nextToken: \(\) => \+\+pollToken|segmentHtml: \(active\) => segBar\(active, PROGRESS_SEG\)/);
  assert.doesNotMatch(progressScreenSource, /var _progFocusCard: string \| undefined|function paintProgramBody|function triggerProgramEvolve|function tidyExerciseNames/);
  assert.match(captureTypesSource, /type CaptureDirective = import\("\.\.\/contracts\/client\.js"\)\.ClientDirective/);
  assert.match(captureTypesSource, /type CaptureActivity = import\("\.\.\/contracts\/client\.js"\)\.ClientActivity/);
  assert.match(captureTypesSource, /type CaptureSpeechRecognitionCtor = new \(\) => CaptureSpeechRecognition/);
  assert.doesNotMatch(captureSource, /type CaptureDirective = import|type CaptureSpeechRecognitionCtor = new/);
  assert.match(captureProvenanceSource, /function provenanceLineHtml\(directive: CaptureDirective \| null \| undefined, label: string\): string \| null/);
  assert.match(captureProvenanceSource, /async function loadTrainingProvenance\(_isToday\?: boolean\): Promise<void>/);
  assert.match(captureProvenanceSource, /const CAIRN_CAPTURE_PROVENANCE = \{/);
  assert.match(captureProvenanceSource, /CairnCaptureProvenance/);
  assert.doesNotMatch(captureSource, /function provenanceLineHtml|function wireProvenance|function loadTrainingProvenance|function loadMealProvenance/);
  assert.match(captureReadDateSource, /function captureReadWeekRangeLabel\(iso: unknown\): string/);
  assert.match(captureReadDateSource, /CairnCaptureReadDate/);
  assert.match(captureReadCardsSource, /function captureReadRenderInsightInSlot\(target: HTMLElement, ins: CaptureInsight, deps: CaptureReadCardDeps\): void/);
  assert.match(captureReadCardsSource, /function captureReadRenderWeeklyInSlot\(target: HTMLElement, ins: CaptureInsight, deps: CaptureReadCardDeps\): void/);
  assert.match(captureReadCardsSource, /CairnCaptureReadCards/);
  assert.match(captureReadJobsSource, /function createCaptureReadJobsController\(deps: CaptureReadJobsDeps\): CaptureReadJobsController/);
  assert.match(captureReadJobsSource, /function reconnectInsight\(\): ClientAgentOpHandlers \| null/);
  assert.match(captureReadJobsSource, /CairnCaptureReadJobs/);
  assert.match(captureReadsSource, /function createCaptureReadsController\(deps: CaptureReadsDeps\): CaptureReadsController/);
  assert.match(captureReadsSource, /captureReadCardsApi\(\)/);
  assert.match(captureReadsSource, /captureReadJobsApi\(\)\.createController/);
  assert.match(captureReadsSource, /async function loadTodayReads\(\): Promise<void>/);
  assert.match(captureReadsSource, /CairnCaptureReads/);
  assert.doesNotMatch(captureSource, /function renderInsightCard|function renderWeeklyCard|function maybeGenerateInsight|function maybeGenerateWeekly/);
  assert.match(captureVoiceSource, /const CAPTURE_MIC_GLYPH =/);
  assert.match(captureVoiceSource, /function setupCaptureVoice\(deps: CaptureVoiceDeps\): void/);
  assert.match(captureVoiceSource, /CairnCaptureVoice/);
  assert.doesNotMatch(captureSource, /const SpeechRec|let _voiceRec|rec\.onresult|rec\.onerror|rec\.onend/);
  assert.match(captureSource, /function setupVoiceCapture\(\): void/);
  assert.match(captureSource, /function loadTodayReads\(\): Promise<void>/);
  assert.match(captureSource, /function reconnectInsight\(\): ClientAgentOpHandlers \| null/);
  assert.match(settingsRoutesSource, /function settingsRouteRowsHtml/);
  assert.match(settingsRoutesSource, /function settingsPruneRoutes/);
  assert.match(settingsClientSource, /type SettingsUpdateOptions = \{ updateCheckEnabled: boolean \}/);
  assert.match(settingsClientSource, /function updateCardHtml/);
  assert.match(settingsSurfaceSource, /function settingsData/);
  assert.match(settingsSurfaceSource, /function settingsWorkingModel/);
  assert.match(settingsSurfaceSource, /function settingsSourcesSliceHtml/);
  assert.match(settingsSurfaceSource, /function settingsAutomationSliceHtml/);
  assert.match(settingsSurfaceSource, /CairnSettingsSurface/);
  assert.match(settingsDataSource, /function phoneAccessCardHtml/);
  assert.match(settingsDataSource, /function wirePhoneAccessCard/);
  assert.match(settingsDataControllerSource, /type SettingsDataControllerDeps = \{/);
  assert.match(settingsDataControllerSource, /let updateStatusCache: Record<string, unknown> \| null = null/);
  assert.match(settingsDataControllerSource, /function renderSettingsData\(deps: SettingsDataControllerDeps\): void/);
  assert.match(settingsDataControllerSource, /CairnSettingsData\.phoneAccessCardHtml/);
  assert.match(settingsDataControllerSource, /CairnSettingsData\.wirePhoneAccessCard/);
  assert.match(settingsDataControllerSource, /CairnSettingsDataController/);
  assert.match(settingsAgentsSource, /function settingsAgentsSliceHtml/);
  assert.match(settingsAgentsSource, /function settingsAgentListHtml/);
  assert.match(settingsAgentsControllerSource, /function renderSettingsAgents\(deps: ClientSettingsAgentsControllerDeps\): void/);
  assert.match(settingsAgentsControllerSource, /function renderSettingsAgentList\(deps: ClientSettingsAgentsControllerDeps\): void/);
  assert.match(settingsAgentsControllerSource, /function wireSettingsCliUpdate\(deps: ClientSettingsAgentsControllerDeps\): void/);
  assert.match(settingsAgentsControllerSource, /CairnSettingsAgentsController/);
  assert.match(settingsSourcesAutomationControllerSource, /function renderSettingsSources\(deps: ClientSettingsSourcesAutomationControllerDeps\): void/);
  assert.match(settingsSourcesAutomationControllerSource, /function renderSettingsAutomation\(deps: ClientSettingsSourcesAutomationControllerDeps\): void/);
  assert.match(settingsSourcesAutomationControllerSource, /CairnSettingsSurface\.sourcesSliceHtml/);
  assert.match(settingsSourcesAutomationControllerSource, /CairnSettingsSurface\.automationSliceHtml/);
  assert.match(settingsSourcesAutomationControllerSource, /CairnSettingsSourcesAutomationController/);
  assert.match(settingsScreenTypesSource, /type SettingsScreenWorkingModel = \{/);
  assert.match(settingsScreenSource, /async function renderSettings\(\): Promise<void>/);
  assert.match(settingsScreenSource, /function settingsAgentsDeps\(\): ClientSettingsAgentsControllerDeps/);
  assert.match(settingsScreenSource, /CairnSettingsAgentsController\.render\(settingsAgentsDeps\(\)\)/);
  assert.match(settingsScreenSource, /function settingsSourcesAutomationDeps\(\): ClientSettingsSourcesAutomationControllerDeps/);
  assert.match(settingsScreenSource, /CairnSettingsSourcesAutomationController\.renderSources\(settingsSourcesAutomationDeps\(\)\)/);
  assert.match(settingsScreenSource, /CairnSettingsSourcesAutomationController\.renderAutomation\(settingsSourcesAutomationDeps\(\)\)/);
  assert.match(settingsScreenSource, /function settingsDataDeps\(\): ClientSettingsDataControllerDeps/);
  assert.match(settingsScreenSource, /CairnSettingsDataController\.render\(settingsDataDeps\(\)\)/);
  assert.doesNotMatch(settingsScreenSource, /CairnSettingsSurface\.sourcesSliceHtml/);
  assert.doesNotMatch(settingsScreenSource, /CairnSettingsSurface\.automationSliceHtml/);
  assert.doesNotMatch(settingsScreenSource, /CairnSettingsAgents\.agentsSliceHtml/);
  assert.doesNotMatch(settingsScreenSource, /CairnSettingsAgents\.agentListHtml/);
  assert.doesNotMatch(settingsScreenSource, /function settingsData\(|function settingsWorkingModel\(|function settingsSourcesSliceHtml\(|function settingsAutomationSliceHtml\(/);
  assert.doesNotMatch(settingsScreenSource, /function renderSettingsSources|function renderSettingsAutomation|garminSyncBtn|ahUrlCopy|geminiApiKey/);
  assert.doesNotMatch(settingsScreenSource, /function wireSettingsCliUpdate|function renderAgentList/);
  assert.doesNotMatch(settingsScreenSource, /function phoneAccessCardHtml/);
  assert.doesNotMatch(settingsScreenSource, /function wirePhoneAccessCard/);
  assert.doesNotMatch(settingsScreenSource, /id="updateCheckNow"|id="dlJson"|id="rerunSetup"/);
  assert.match(settingsScreenSource, /Object\.assign\(globalThis, \{/);
  assert.match(settingsScreenSource, /SET_SEG/);
  assert.match(
    chatClientSource,
    /type ChatImagePayload = \{ dataUrl: string; base64: string; mime: "image\/jpeg"; bytes: number \}/
  );
  assert.match(chatClientSource, /function chatWantsFuelSurface/);
  assert.match(chatClientSource, /function chatShellHtml\(\): string/);
  assert.match(chatClientSource, /function chatHeaderActionsHtml\(\): string/);
  assert.match(chatClientSource, /function chatStarterChipsHtml\(starters: readonly unknown\[\] = CHAT_STARTERS\): string/);
  assert.match(chatClientSource, /function chatDividerHtml\(iso: unknown, label: unknown\): string/);
  assert.match(chatClientSource, /function chatEarlierBarHtml\(\): string/);
  assert.match(chatClientSource, /const CAIRN_CHAT_CLIENT = \{/);
  assert.match(chatStarterChipsSource, /function drawChatStarterChips\(log: Element\): void/);
  assert.match(chatFuelContextSource, /function chatFuelWantsSurface\(messages: Partial<ChatScreenMessage>\[\] = chatFuelContextMessages\): boolean/);
  assert.match(chatEarlierHistorySource, /function expandChatEarlierHistory\(log: HTMLElement, bar: Element, block: HTMLElement\): void/);
  assert.match(chatAttachmentSource, /async function chatAttachmentCompressImage\(file: File\): Promise<ChatAttachmentImagePayload>/);
  assert.match(chatAttachmentSource, /function chatAttachmentResetFocusAfterNativePicker/);
  assert.doesNotMatch(chatAttachmentSource, /classList\.remove\("kb-(?:geometry-)?open"\)/);
  assert.match(chatAttachmentSource, /function chatAttachmentSettleAfterNativePicker/);
  assert.match(chatAttachmentSource, /nativePickerSuppressMs:\s*options\.nativePickerSuppressMs\s*\?\?\s*900/);
  assert.match(chatAttachmentSource, /Object\.assign\(globalThis,\s*\{ CairnChatAttachment: CAIRN_CHAT_ATTACHMENT \}\)/);
  assert.match(chatComposerFocusSource, /function chatComposerReleaseStaleInputFocus/);
  assert.match(chatComposerFocusSource, /function chatComposerRecoverInputFocusFromTap/);
  assert.match(chatComposerFocusSource, /function chatComposerWireFocus/);
  assert.match(chatComposerFocusSource, /Object\.assign\(globalThis,\s*\{ CairnChatComposerFocus: CAIRN_CHAT_COMPOSER_FOCUS \}\)/);
  assert.match(chatComposerControllerSource, /function wireChatComposer\(deps: ChatComposerControllerDeps\): ChatComposerControllerHandle/);
  assert.match(chatComposerControllerSource, /CairnChatAttachment\.resetFocusAfterNativePicker/);
  assert.match(chatComposerControllerSource, /CairnChatAttachment\.settleAfterNativePicker/);
  assert.match(chatComposerControllerSource, /CairnChatAttachment\.compressImage\(f\)/);
  assert.match(chatComposerControllerSource, /CairnChatAttachment\.previewImage/);
  assert.match(chatComposerControllerSource, /CairnChatComposerFocus\.wireFocus/);
  assert.match(chatComposerControllerSource, /fileInput\.addEventListener\("change"[\s\S]*resetChatFocusAfterNativePicker\(\)/);
  assert.match(chatComposerControllerSource, /classList\.contains\("kb-geometry-open"\)/);
  assert.match(chatComposerControllerSource, /Object\.assign\(globalThis,\s*\{ CairnChatComposerController: CAIRN_CHAT_COMPOSER_CONTROLLER \}\)/);
  assert.match(chatMessageSource, /function appendMsg\(/);
  assert.match(chatMessageSource, /function chatMessageDayISO\(ts: unknown\): string/);
  assert.match(chatMessageSource, /function chatDivider\(iso: string\): Element/);
  assert.match(chatMessageSource, /Object\.assign\(globalThis,\s*\{/);
  assert.match(chatTurnRecordsSource, /function\s+parseChatTurnEvent\(event: Event\): ChatTurnRecord \| null/);
  assert.match(chatTurnRecordsSource, /function\s+saveChatTurnDraft\(value: string\): void/);
  assert.match(chatTurnRecordsSource, /const CAIRN_CHAT_TURN_RECORDS: ChatTurnRecordsApi/);
  assert.match(chatLayoutSource, /function\s+wireChatJump\(log: HTMLElement \| null, jump: HTMLElement \| null\): void/);
  assert.match(chatLayoutSource, /function\s+autosizeChatInput\(el: HTMLTextAreaElement \| HTMLInputElement \| null\): void/);
  assert.match(chatLayoutSource, /function\s+measureChatTop\(\): void/);
  assert.match(chatLayoutSource, /const CAIRN_CHAT_LAYOUT: ChatLayoutApi/);
  assert.match(chatLayoutSource, /Object\.assign\(globalThis,\s*\{ CairnChatLayout: CAIRN_CHAT_LAYOUT \}\)/);
  assert.match(chatTurnClientSource, /function\s+saveChatDraft\(value: string\): void/);
  assert.match(chatTurnClientSource, /CairnChatTurnRecords/);
  assert.match(chatTurnClientSource, /CairnChatLayout/);
  assert.match(chatTurnClientSource, /async function\s+chatReconnect\(\): Promise<void>/);
  assert.match(chatTurnClientSource, /function\s+chatTeardownMonitor\(\): void/);
  assert.doesNotMatch(chatTurnClientSource, /function\s+measureChatTop\(\): void/);
  assert.match(chatTurnClientSource, /Object\.assign\(globalThis,\s*\{/);
  assert.match(chatHistoryClientSource, /function openChatHistory\(options: \{ session\?: string \| null \} = \{\}\): void/);
  assert.match(chatHistoryClientSource, /function histSessionRow/);
  assert.match(chatHistoryClientSource, /function histHitRow/);
  assert.match(chatHistoryClientSource, /Object\.assign\(globalThis,\s*\{ openChatHistory \}\)/);
  assert.match(chatScreenSource, /async function renderChat\(\): Promise<void>/);
  assert.doesNotMatch(chatScreenSource, /function appendMsg\(/);
  assert.doesNotMatch(chatScreenSource, /function chatDayISO\(ts: unknown\): string/);
  assert.doesNotMatch(chatScreenSource, /let chatFuelContext|function drawChatChips\([\s\S]*starterChipsHtml|function expandChatEarlier\([\s\S]*maxHeight/);
  assert.match(chatScreenSource, /CairnChatComposerController\.wire/);
  assert.doesNotMatch(chatScreenSource, /CairnChatAttachment\.resetFocusAfterNativePicker/);
  assert.doesNotMatch(chatScreenSource, /CairnChatAttachment\.settleAfterNativePicker/);
  assert.doesNotMatch(chatScreenSource, /CairnChatAttachment\.compressImage\(f\)/);
  assert.doesNotMatch(chatScreenSource, /CairnChatAttachment\.previewImage/);
  assert.doesNotMatch(chatScreenSource, /CairnChatComposerFocus\.wireFocus/);
  assert.doesNotMatch(chatScreenSource, /fileInput\.addEventListener\("change"[\s\S]*resetChatFocusAfterNativePicker\(\)/);
  assert.doesNotMatch(chatScreenSource, /classList\.contains\("kb-geometry-open"\)/);
  assert.doesNotMatch(chatScreenSource, /function\s+chatComposerReleaseStaleInputFocus|function\s+chatComposerRecoverInputFocusFromTap/);
  assert.match(chatScreenSource, /Plan editor orchestration lives in \/js\/plan-editor-controller\.js; Plan Endurance lives in \/js\/plan-endurance-client\.js/);
  assert.match(planEnduranceModelSource, /const PLAN_ENDURANCE_PHASES/);
  assert.match(planEnduranceModelSource, /function planEnduranceRampHtml\(goal: PlanEnduranceGoalRow/);
  assert.match(planEnduranceModelSource, /function planEndurancePresets\(goal: PlanEnduranceGoalRow/);
  assert.match(planEnduranceModelSource, /function planEnduranceDraftCardHtml\(proposal: PlanEnduranceProposal\): string/);
  assert.match(planEnduranceModelSource, /function planEnduranceRuns\(plan: unknown\): PlanEnduranceRunRow\[\]/);
  assert.match(planEnduranceModelSource, /CairnPlanEnduranceModel/);
  assert.match(planEnduranceSource, /type EnduranceGoalRow = import\("\.\.\/contracts\/client-api\.js"\)\.ClientEnduranceGoal/);
  assert.match(planEnduranceSource, /type EnduranceComplianceRow = import\("\.\.\/contracts\/client-api\.js"\)\.ClientRunCompliance/);
  assert.match(planEnduranceSource, /async function renderPlanEndurance\(\): Promise<void>/);
  assert.match(planEnduranceSource, /function paintPlanEndurance\(\s*goalValue: EnduranceGoalRow \| null,\s*compliance: EnduranceComplianceRow \| null,/);
  assert.match(planEnduranceSource, /function enduranceProposalOpOpts\(\): ClientAgentOpHandlers/);
  assert.match(planEnduranceSource, /CairnPlanEndurance/);
  assert.match(planEditorSource, /type PlanEditorItem = \{/);
  assert.match(planEditorSource, /function dayModelFromPlan\(day: PlanEditorDay \| PlanEditorApiDay\)/);
  assert.match(planEditorSource, /function progDayHtml\(day: PlanEditorDay, dayIndex: number\): string/);
  assert.match(planEditorSource, /function pitemHtml\(item: PlanEditorItem, dayIndex: number, itemIndex: number, lastIndex: number\): string/);
  assert.match(planEditorSource, /CairnPlanEditor/);
  assert.doesNotMatch(planEditorSource, /async function renderPlanEditor\(\): Promise<void>|mountSaveBar\(\{|api\("\/plan",\s*\{ method: "PUT"/);
  assert.match(planEditorFormSource, /function syncPlanModel\(model: PlanEditorFormModelDay\[\], root: ParentNode\): void/);
  assert.match(planEditorFormSource, /function serializePlanDays\(model: PlanEditorFormModelDay\[\]\): PlanEditorFormSaveDay\[\]/);
  assert.match(planEditorFormSource, /CairnPlanEditorForm/);
  assert.doesNotMatch(planEditorFormSource, /async function renderPlanEditor\(\): Promise<void>|mountSaveBar\(\{|api\("\/plan",\s*\{ method: "PUT"/);
  assert.match(planEditorControllerSource, /async function renderPlanEditor\(\): Promise<void>/);
  assert.match(planEditorControllerSource, /CairnPlanEditorForm/);
  assert.doesNotMatch(planEditorControllerSource, /function serializePlanDays\(model: PlanEditorControllerModelDay\[\]\)/);
  assert.match(planEditorControllerSource, /mountSaveBar\(\{/);
  assert.match(planEditorControllerSource, /api\("\/plan",\s*\{ method: "PUT"/);
  assert.match(planEditorControllerSource, /CairnPlanEditorController/);
  assert.match(dayFuelSource, /const MEAL_LABEL: Record<string, string>/);
  assert.match(dayFuelSource, /function dayFuelHtml\(day: DayFuelData \| null \| undefined\): string/);
  assert.match(dayFuelSource, /CairnDayFuel/);
  assert.match(dayFuelControllerSource, /function loadDayFuel\(token: number, options: DayFuelControllerOptions = \{\}\): Promise<void>/);
  assert.match(dayFuelControllerSource, /function openFoodEdit\(id: number, fromEl: Element, options: DayFuelControllerOptions = \{\}\): void/);
  assert.match(dayFuelControllerSource, /CairnDayFuelController/);
  assert.match(mealRowSource, /function mealSlotFor\(name: unknown, index: unknown\): string/);
  assert.match(mealRowSource, /function mealsCtxFor\(plan: unknown, now\?: unknown\): MealRowPlannerContext/);
  assert.match(mealRowSource, /function mealRowHtml\(meal: unknown, mealIndex\?: number, options\?: MealRowRenderOptions\): string/);
  assert.match(mealRowSource, /function mealDayHtml\(day: unknown, dayIndex: number, context: MealRowDayContext\): string/);
  assert.match(mealRowSource, /CairnMealRows/);
  assert.match(mealPlanSource, /const mealRows = CairnMealRows/);
  assert.match(mealPlanSource, /function currentMealPlan\(plans: unknown\): MealRecord \| null/);
  assert.match(mealPlanSource, /function mealPlanListHtml\(plans: unknown\): string/);
  assert.match(mealPlanSource, /function mealPrefsHtml\(prefs: unknown, index: number\): string/);
  assert.match(mealPlanSource, /function mealPlannerBodyHtml\(current: unknown, mealPrefs: unknown, options: MealPlannerOptions = \{\}\): MealPlannerPaint/);
  assert.match(mealPlanSource, /CairnMealPlan/);
  assert.match(mealRecipeSource, /function mealRecipeCtaHtml\(\): string/);
  assert.match(mealRecipeSource, /function mealRecipeHtml\(recipe: unknown\): string/);
  assert.match(mealRecipeSource, /function mealRecipeLoadingHtml\(\): string/);
  assert.match(mealRecipeSource, /CairnMealRecipe/);
  assert.match(mealRecipeControllerSource, /function openMealSheet\(current: MealRecipeControllerPlan, dayIndex: number, mealIndex: number\): void/);
  assert.match(mealRecipeControllerSource, /function recipeOpOpts\(/);
  assert.match(mealRecipeControllerSource, /function reconnectRecipe\(job\?: unknown\): ClientAgentOpHandlers \| null/);
  assert.match(mealRecipeControllerSource, /CairnMealRecipeController/);
  assert.match(mealSwapDataSource, /function mealSwapDataRecord\(value: unknown\): ClientMealSwapRecord/);
  assert.match(mealSwapDataSource, /function mealSwapDataDays\(plan: \{ parsed\?: unknown \}\): ClientMealSwapDay\[\]/);
  assert.match(mealSwapDataSource, /CairnMealSwapData/);
  assert.match(mealSwapControllerSource, /function submitMealSwap\(/);
  assert.match(mealSwapControllerSource, /function mealSwapOpOpts\(/);
  assert.match(mealSwapControllerSource, /function reconnectMealSwap\(job\?: unknown\): ClientAgentOpHandlers \| null/);
  assert.match(mealSwapControllerSource, /function moveMealRow\(/);
  assert.match(mealSwapControllerSource, /function wireMealRows\(/);
  assert.match(mealSwapRowActionsSource, /function mealSwapRowActionsWireMealRows\(/);
  assert.match(mealSwapRowActionsSource, /CairnMealRecipeController|recipeController\.openMealSheet/);
  assert.match(mealSwapControllerSource, /CairnMealSwapController/);
  assert.match(mealSwapControllerSource, /CairnMealSwapData\.days/);
  assert.match(mealPlannerJobsSource, /function mealPlannerJobRunCoachMealPlan\(agent: string, instruction: string\): void/);
  assert.match(mealPlannerJobsSource, /function mealPlannerJobReconnectMealPlan\(\): ClientAgentOpHandlers \| null/);
  assert.match(mealPlannerJobsSource, /CairnMealPlannerJobs/);
  assert.match(mealPlannerActionsSource, /function mealPlannerActionsRenderMealPlans\(plans: unknown, sel = "#meallist"/);
  assert.match(mealPlannerActionsSource, /function mealPlannerActionsWireMealPlannerBody/);
  assert.match(mealPlannerActionsSource, /CairnMealSwapController\.wireMealRows/);
  assert.match(mealPlannerActionsSource, /CairnMealPlannerActions/);
  assert.match(mealPlannerControllerSource, /function renderMealPlans\(plans: unknown, selector = "#meallist"/);
  assert.match(mealPlannerControllerSource, /function wireMealPlannerBody\(/);
  assert.match(mealPlannerControllerSource, /function reconnectMealPlan\(job\?: unknown\): ClientAgentOpHandlers \| null/);
  assert.match(mealPlannerControllerSource, /CairnMealPlannerJobs\.reconnectMealPlan/);
  assert.match(mealPlannerControllerSource, /CairnMealPlannerActions\.wireMealPlannerBody/);
  assert.doesNotMatch(mealPlannerControllerSource, /function submitMealSwap|function mealSwapOpOpts|function reconnectMealSwap|function moveMealRow|function wireMealRows|CairnMealRecipeController\.openMealSheet|CairnMealSwapController\.wireMealRows/);
  assert.match(coachProposalControllerSource, /function runCoachProposal\(agent: string, instruction: string\): void/);
  assert.match(coachProposalControllerSource, /async function applyProposalById\(id: string \| number \| undefined, btn\?: Element \| null\): Promise<unknown>/);
  assert.match(coachProposalControllerSource, /function renderProposals\(proposals: unknown\): void/);
  assert.match(coachProposalControllerSource, /function reconnectProposal\(\): ClientAgentOpHandlers \| null/);
  assert.match(coachProposalControllerSource, /CairnCoachProposalController/);
  assert.match(coachProposalControllerSource, /CairnProposal\.coachProposalListHtml\(proposals, lastApplyClamp\)/);
  assert.match(coachMealsScreenSource, /async function renderCoach\(\): Promise<void>/);
  assert.match(coachMealsScreenSource, /async function renderMeals\(\): Promise<unknown>/);
  assert.match(coachMealsScreenSource, /function renderFoodJournal\(\): void/);
  assert.match(coachMealsScreenSource, /CairnMealPlannerController\.wireMealPlannerBody/);
  assert.match(coachMealsScreenSource, /CairnCoachProposalController\.runCoachProposal/);
  assert.match(coachMealsScreenSource, /CairnCoachProposalController\.renderProposals/);
  assert.doesNotMatch(coachMealsScreenSource, /function openMealSheet|function recipeOpOpts|function reconnectRecipe|function reconnectMealPlan|function reconnectMealSwap|function wireMealRows|function draftWeeklyMeals|function runCoach|function coachProposalOpOpts|function renderProposals|async function applyProposalById|function reconnectProposal|lastApplyClamp/);
  assert.match(coachMealsScreenSource, /Object\.assign\(globalThis, \{/);
  assert.match(foodNoteSource, /type FoodNoteRow = \{/);
  assert.match(foodNoteSource, /function foodIngredients\(value: unknown\): FoodIngredientRow\[\]/);
  assert.match(foodNoteSource, /function noteEntryHtml\(note: FoodNoteRow, index\?: number\): string/);
  assert.match(foodNoteSource, /CairnFoodNote/);
  assert.match(foodDetailControllerSource, /type FoodDetailControllerDeps = \{/);
  assert.match(foodDetailControllerSource, /async function openFoodDetail/);
  assert.match(foodDetailControllerSource, /const CAIRN_FOOD_DETAIL_CONTROLLER = \{/);
  assert.match(uiShellSource, /CairnFoodDetailController\.openFoodDetail/);
  assert.doesNotMatch(uiShellSource, /detail-macros/);
  assert.match(healthEvidenceSource, /type HealthEvidenceRow = \{/);
  assert.match(healthEvidenceSource, /const DIRECTIVE_DOMAINS: Array<readonly \[string, string, string\]>/);
  assert.match(healthEvidenceSource, /function evidenceListHtml\(evidence: unknown\): string/);
  assert.match(healthEvidenceSource, /function evidenceCountMap\(summary: HealthEvidenceSummary/);
  assert.match(healthEvidenceSource, /function directiveHtml\(d: HealthDirectiveRow/);
  assert.match(healthEvidenceSource, /CairnHealthEvidence/);
  assert.match(healthClientSource, /const MAX_DOC_BYTES = 15 \* 1024 \* 1024/);
  assert.match(healthClientSource, /function guessUploadMime\(file: UploadFileLike/);
  assert.match(healthClientSource, /CairnHealthEvidence\.directiveHtml/);
  assert.doesNotMatch(healthClientSource, /function evidenceListHtml|function evidenceCountMap|function directiveHtml\(d: HealthDirectiveRow/);
  assert.match(healthClientSource, /function formatMarkerNumber\(value: unknown\): string/);
  assert.match(
    healthClientSource,
    /function markerTrendWord\(marker: HealthMarkerTrendRow \| null \| undefined\): string/
  );
  assert.match(healthMarkerOrderSource, /const HEALTH_MARKER_ORDER: Record<string, Array<\[number, RegExp\]>>/);
  assert.match(healthMarkerOrderSource, /function orderMarkersForDisplay<T extends HealthMarkerOrderRow>/);
  assert.match(healthMarkerOrderSource, /CairnHealthMarkerOrder/);
  assert.match(healthClientSource, /CairnHealthMarkerOrder\.orderMarkersForDisplay/);
  assert.doesNotMatch(healthClientSource, /const HEALTH_MARKER_ORDER|function orderMarkersForDisplay<T extends/);
  assert.match(healthPictureSource, /type HealthPictureReview = \{/);
  assert.match(healthPictureSource, /function parsedReview\(review: HealthPictureReview/);
  assert.match(healthPictureSource, /function reviewHtml\(review: HealthPictureReview/);
  assert.match(healthPictureSource, /CairnHealthPicture/);
  assert.match(healthPictureControllerSource, /type HealthPictureControllerDeps = \{/);
  assert.match(healthPictureControllerSource, /function getHealthPictureCache\(\): HealthPictureCache \| null/);
  assert.match(healthPictureControllerSource, /function paintHealthPicture\(deps: HealthPictureControllerDeps\): void/);
  assert.match(healthPictureControllerSource, /async function runHealthReview\(deps: HealthPictureControllerDeps\): Promise<void>/);
  assert.match(healthPictureControllerSource, /async function loadHealthPicture\(token: number, docsPromise: Promise<unknown>, deps: HealthPictureControllerDeps\): Promise<void>/);
  assert.match(healthPictureControllerSource, /CairnHealthPictureController/);
  assert.match(healthMarkersSource, /type HealthMarkersPoint = \{/);
  assert.match(healthMarkersSource, /function markerChartSvg\(marker: HealthMarkersRow/);
  assert.match(healthMarkersSource, /function wireMarkerChart\(svg: SVGElement/);
  assert.match(healthMarkersSource, /function hmkRowHtml\(marker: HealthMarkersRow/);
  assert.match(healthMarkersSource, /CairnHealthMarkers/);
  assert.match(healthMarkersControllerSource, /type HealthMarkersControllerGroup = \{/);
  assert.match(healthMarkersControllerSource, /function markerGroups\(data: HealthMarkersControllerResponse, markers: HealthMarkersControllerRow\[\]\): HealthMarkersControllerGroup\[\]/);
  assert.match(healthMarkersControllerSource, /function groupMarkers\(groups: HealthMarkersControllerGroup\[\], markers: HealthMarkersControllerRow\[\]\): Map<string, HealthMarkersControllerRow\[\]>/);
  assert.match(healthMarkersControllerSource, /CairnHealthClient\.orderMarkersForDisplay/);
  assert.match(healthMarkersControllerSource, /CairnHealthClient\.lipidGroupNoteHtml/);
  assert.match(healthMarkersControllerSource, /CairnHealthMarkers\.hmkRowHtml/);
  assert.match(healthMarkersControllerSource, /CairnHealthMarkers\.wireMarkerChart/);
  assert.match(healthMarkersControllerSource, /deps\.cachedApi\("\/markers\/priority"/);
  assert.match(healthMarkersControllerSource, /deps\.switchHealthSeg\("records", \{ openPicker: true \}\)/);
  assert.match(healthMarkersControllerSource, /CairnHealthMarkersController/);
  assert.match(healthDirectivesSource, /type HealthDirectivesRow = \{/);
  assert.match(healthDirectivesSource, /function directivesSectionHtml\(rows: unknown/);
  assert.match(healthDirectivesSource, /function directiveResearchNudgeHtml/);
  assert.match(healthDirectivesSource, /CairnHealthDirectives/);
  assert.match(healthDirectiveLoaderSource, /CairnHealthDirectiveLoader/);
  assert.match(healthDirectiveLoaderSource, /api\("\/directives"\)/);
  assert.match(healthDirectiveLoaderSource, /api\("\/evidence\/summary"\)/);
  assert.match(healthDirectiveLoaderSource, /api\("\/directives\/derive"/);
  assert.match(healthDirectiveLoaderSource, /CairnHealthDirectives\.directivesSectionHtml/);
  assert.match(healthReadSource, /type HealthReadRecovery = \{/);
  assert.match(healthReadSource, /function recoveryHtml\(summary: HealthReadRecovery/);
  assert.match(healthReadSource, /function priorityMarkersSectionHtml\(markersInput: unknown/);
  assert.match(healthReadSource, /function optimalPhrase\(marker: HealthReadMarker/);
  assert.match(healthReadSource, /CairnHealthRead/);
  assert.match(healthReadSupplementsSource, /function load\(deps: ClientHealthReadControllerDeps, token: number\): void/);
  assert.match(healthReadSupplementsSource, /function render\(list: unknown, deps: ClientHealthReadControllerDeps, token\?: number \| null\): void/);
  assert.match(healthReadSupplementsSource, /async function understandFromInput\(deps: ClientHealthReadControllerDeps\): Promise<void>/);
  assert.match(healthReadSupplementsSource, /async function remove\(id: number, deps: ClientHealthReadControllerDeps\): Promise<void>/);
  assert.match(healthReadSupplementsSource, /CairnHealthReadSupplements/);
  assert.match(healthReadControllerSource, /function paintHealthReadTab\(deps: ClientHealthReadControllerDeps\): void/);
  assert.match(healthReadControllerSource, /function loadRecoverySummary\(deps: ClientHealthReadControllerDeps, token: number, selector: string\): void/);
  assert.match(healthReadControllerSource, /function loadPriorityMarkers\(deps: ClientHealthReadControllerDeps, token: number\): void/);
  assert.match(healthReadControllerSource, /CairnHealthReadSupplements\.load/);
  assert.match(healthReadControllerSource, /CairnHealthReadSupplements\.render/);
  assert.match(healthReadControllerSource, /CairnHealthReadSupplements\.understandFromInput/);
  assert.match(healthReadControllerSource, /CairnHealthReadSupplements\.remove/);
  assert.match(healthReadControllerSource, /CairnHealthReadController/);
  assert.match(healthStandingPrimitivesSource, /type HealthStandingPrimitiveComparison = import\("\.\.\/contracts\/client-api\.js"\)\.ClientHealthStandingComparison/);
  assert.match(healthStandingPrimitivesSource, /function hstandCompHtml\(comparison: HealthStandingPrimitiveComparison/);
  assert.match(healthStandingPrimitivesSource, /function hstandBpCardHtml/);
  assert.match(healthStandingPrimitivesSource, /function hstandBodyCompHtml/);
  assert.match(healthStandingPrimitivesSource, /CairnHealthStandingPrimitives/);
  assert.match(healthStandingSource, /type HealthStandingRead = import\("\.\.\/contracts\/client-api\.js"\)\.ClientHealthStanding/);
  assert.match(healthStandingSource, /const \{\s*hstandDecade,/);
  assert.match(healthStandingSource, /function renderHealthStandingHtml\(data: HealthStandingRead/);
  assert.match(healthStandingSource, /\} = CairnHealthStandingPrimitives/);
  assert.match(healthStandingSource, /CairnHealthStanding/);
  assert.match(healthStandingControllerSource, /type HealthStandingControllerRead = import\("\.\.\/contracts\/client-api\.js"\)\.ClientHealthStanding/);
  assert.match(healthStandingControllerSource, /function render\(data: HealthStandingControllerRead \| null \| undefined, deps: ClientHealthStandingControllerDeps\): void/);
  assert.match(healthStandingControllerSource, /function openBpSheet\(deps: ClientHealthStandingControllerDeps\): void/);
  assert.match(healthStandingControllerSource, /function load\(deps: ClientHealthStandingControllerDeps, token: number, refAge\?: unknown\): void/);
  assert.match(healthStandingControllerSource, /function paintReview\(deps: ClientHealthStandingControllerDeps\): void/);
  assert.match(healthStandingControllerSource, /deps\.api\(`\/health\/standing\?reference_age=/);
  assert.match(healthStandingControllerSource, /deps\.api\("\/blood-pressure"/);
  assert.match(healthStandingControllerSource, /CairnHealthStandingController/);
  assert.match(healthDocsSource, /type HealthDocRow = \{/);
  assert.match(healthDocsSource, /function healthDocInner\(doc: HealthDocRow\): string/);
  assert.match(healthDocsSource, /function healthDocHtml\(doc: HealthDocRow, index\?: number\): string/);
  assert.match(healthDocsSource, /Object\.assign\(globalThis, \{/);
  assert.match(healthDocsSource, /CairnHealthDocs/);
  assert.match(healthLearnedSource, /const LEARNED_GROUPS/);
  assert.match(healthLearnedSource, /type ClientLearnedTimeline = import\("\.\.\/contracts\/client-api\.js"\)\.ClientLearnedTimeline/);
  assert.match(healthLearnedSource, /function learnedItemHtml\(item: Partial<ClientLearnedItem> \| null \| undefined, index: number\): string/);
  assert.match(healthLearnedSource, /function learnedTimelineHtml\(data: ClientLearnedTimeline \| null \| undefined\): string/);
  assert.match(healthLearnedSource, /CairnHealthLearned/);
  assert.match(healthRecordsSource, /type HealthRecordDocument = /);
  assert.match(healthRecordsSource, /function recordsUploadHtml\(filePrompt = CairnHealthClient\.H_FILE_PROMPT\): string/);
  assert.match(healthRecordsSource, /function recordsListHtml\(docsInput: unknown\): string/);
  assert.match(healthRecordsSource, /CairnHealthRecords/);
  assert.match(healthDocUploadControllerSource, /type HealthDocUploadDeps = \{/);
  assert.match(healthDocUploadControllerSource, /function wireHealthDocUpload\(deps: HealthDocUploadDeps\): void/);
  assert.match(healthDocUploadControllerSource, /function refreshPictureAfterHealthDocUpload\(doc: HealthDocUploadDocument, deps: HealthDocUploadDeps\): void/);
  assert.match(healthDocUploadControllerSource, /CairnHealthDocUploadController/);
  assert.match(healthDocDateActionsSource, /function openHealthDocDateEditor\(row: HTMLElement, editBtn: HTMLElement\): void/);
  assert.match(healthDocDateActionsSource, /async function saveHealthDocDate\(id: string \| number, deps: ClientHealthDocActionsControllerDeps\): Promise<void>/);
  assert.match(healthDocDateActionsSource, /CairnHealthDocDateActions/);
  assert.match(healthDocLifecycleActionsSource, /function pollLifecycleHealthDoc\(id: string \| number, deps: ClientHealthDocActionsControllerDeps\): void/);
  assert.match(healthDocLifecycleActionsSource, /async function reanalyzeHealthDoc\(id: string \| number, deps: ClientHealthDocActionsControllerDeps\): Promise<void>/);
  assert.match(healthDocLifecycleActionsSource, /CairnHealthDocLifecycleActions/);
  assert.match(healthDocActionsControllerSource, /type HealthDocActionsDeps = ClientHealthDocActionsControllerDeps/);
  assert.match(healthDocActionsControllerSource, /function wireHealthDocActions\(el: HTMLElement \| null, deps: HealthDocActionsDeps\): void/);
  assert.match(healthDocActionsControllerSource, /function hdocActionsPollDoc\(id: string \| number, deps: HealthDocActionsDeps\): void/);
  assert.match(healthDocActionsControllerSource, /CairnHealthDocDateActions\.saveDate/);
  assert.match(healthDocActionsControllerSource, /CairnHealthDocLifecycleActions\.reanalyze/);
  assert.doesNotMatch(healthDocActionsControllerSource, /async function saveHealthDocDate|async function reanalyzeHealthDoc|function startHealthDelete/);
  assert.match(healthDocActionsControllerSource, /CairnHealthDocActionsController/);
  assert.match(meRecordsHealthDocControllerSource, /type HealthRecordsControllerDeps = \{/);
  assert.match(meRecordsHealthDocControllerSource, /function healthDocUploadDeps\(deps: HealthRecordsControllerDeps\): ClientHealthDocUploadControllerDeps/);
  assert.match(meRecordsHealthDocControllerSource, /function healthDocActionsDeps\(deps: HealthRecordsControllerDeps\): ClientHealthDocActionsControllerDeps/);
  assert.match(meRecordsHealthDocControllerSource, /CairnHealthDocUploadController\.wireUpload\(healthDocUploadDeps\(deps\)\)/);
  assert.match(meRecordsHealthDocControllerSource, /CairnHealthDocActionsController\.wireDoc\(el, healthDocActionsDeps\(deps\)\)/);
  assert.doesNotMatch(meRecordsHealthDocControllerSource, /FileReader|readAsDataURL|MAX_DOC_BYTES|MAX_DOC_TEXT|guessUploadMime/);
  assert.match(meRecordsHealthDocControllerSource, /async function loadHealthDocs\(deps: HealthRecordsControllerDeps\): Promise<HealthDocument\[\]>/);
  assert.match(meRecordsHealthDocControllerSource, /function renderHealthRecords\(deps: HealthRecordsControllerDeps\): Promise<HealthDocument\[\]>/);
  assert.match(meRecordsHealthDocControllerSource, /CairnHealthRecordsController/);
  assert.match(healthShareControllerSource, /type HealthShareControllerResponse = \{/);
  assert.match(healthShareControllerSource, /function renderHealthShare\(deps: ClientHealthShareControllerDeps\): void/);
  assert.match(healthShareControllerSource, /deps\.cachedApi\("\/markers\/priority"/);
  assert.match(healthShareControllerSource, /deps\.switchHealthSeg\("records", \{ openPicker: true \}\)/);
  assert.match(healthShareControllerSource, /deps\.api\("\/markers\/reconcile"/);
  assert.match(healthShareControllerSource, /function openDoctorReportTab\(deps: ClientHealthShareControllerDeps\): void/);
  assert.match(healthShareControllerSource, /CairnHealthShareController/);
  assert.match(memorySource, /const MEM_KINDS/);
  assert.match(memorySource, /type ClientMemory = import\("\.\.\/contracts\/client-api\.js"\)\.ClientMemory/);
  assert.match(memorySource, /function memoryKindOptionsHtml\(selected: ClientMemoryKind \| null \| undefined = ""\): string/);
  assert.match(memorySource, /function memoryRowHtml\(row: ClientMemory, index\?: number\): string/);
  assert.match(memorySource, /CairnMemory/);
  assert.match(meMemoryControllerSource, /type MeMemoryControllerDeps = \{/);
  assert.match(meMemoryControllerSource, /async function render\(deps: MeMemoryControllerDeps\): Promise<void>/);
  assert.match(meMemoryControllerSource, /async function load\(deps: MeMemoryControllerDeps\): Promise<void>/);
  assert.match(meMemoryControllerSource, /function startEdit\(row: HTMLElement \| null, deps: MeMemoryControllerDeps\): void/);
  assert.match(meMemoryControllerSource, /function startDelete\(button: Element, deps: MeMemoryControllerDeps\): void/);
  assert.match(meHealthScreenCompositionSource, /meMemoryDeps: \(\) => CairnMeHealthDependencies\.memory\(context\(\)\)/);
  assert.match(meHealthTabsControllerSource, /const HEALTH_SEG: readonly \(readonly \[ClientHealthSection, string\]\)\[\]/);
  assert.match(meHealthTabsControllerSource, /function normalizeHealthSeg\(seg: unknown\): ClientHealthSection/);
  assert.match(meHealthTabsControllerSource, /async function renderHealth\(deps: ClientMeHealthTabsControllerDeps\): Promise<void>/);
  assert.match(meHealthTabsControllerSource, /function setHealthSegActive\(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps\): void/);
  assert.match(meHealthTabsControllerSource, /function switchHealthSeg\(seg: ClientHealthSection, deps: ClientMeHealthTabsControllerDeps, opts: \{ openPicker\?: boolean \} = \{\}\): void/);
  assert.match(meHealthTabsControllerSource, /function paintHealthTab\(deps: ClientMeHealthTabsControllerDeps\): void/);
  assert.match(meHealthTabsControllerSource, /CairnMeHealthTabsController/);
  assert.match(meHealthTabsController, /CairnMeHealthTabsController/);
  assert.match(lifeSource, /const LIFE_KINDS/);
  assert.match(lifeSource, /function lifeFieldsHtml\(kind: unknown\): string/);
  assert.match(lifeSource, /function lifeEventHtml\(event: LifeEventRow/);
  assert.match(lifeSource, /CairnLife/);
  assert.match(lifeFormHelpersSource, /function collectLifeForm\(\): LifeControllerForm/);
  assert.match(lifeFormHelpersSource, /async function submitLifeForm\(deps: ClientLifeControllerDeps\): Promise<void>/);
  assert.match(lifeTimelineActionsSource, /async function loadLifeTimeline\(deps: ClientLifeControllerDeps\): Promise<void>/);
  assert.match(lifeTimelineActionsSource, /function startLifeEdit\(card: HTMLElement \| null, deps: ClientLifeControllerDeps\): void/);
  assert.match(lifeTimelineActionsSource, /function startLifeDelete\(button: Element, deps: ClientLifeControllerDeps\): void/);
  assert.match(lifeControllerSource, /async function render\(deps: ClientLifeControllerDeps\): Promise<void>/);
  assert.match(lifeControllerSource, /lifeTimelineApi\(\)\.load\(deps\)/);
  assert.doesNotMatch(lifeControllerSource, /async function load\(deps: ClientLifeControllerDeps\)|function startEdit\(card: HTMLElement \| null, deps: ClientLifeControllerDeps\)|function startDelete\(button: Element, deps: ClientLifeControllerDeps\)/);
  assert.match(lifeControllerSource, /CairnLifeController/);
  assert.match(familySource, /const FAMILY_COLORS/);
  assert.match(familySource, /function familyCardHtml\(row: FamilyRow, index\?: number\): string/);
  assert.match(familySource, /function familySwatches\(selected: unknown\): string/);
  assert.match(familySource, /CairnFamily/);
  assert.match(familyControllerSource, /CairnFamilyController/);
  assert.match(familyControllerSource, /async function render\(deps: FamilyControllerDeps\): Promise<void>/);
  assert.match(familyControllerSource, /async function load\(deps: FamilyControllerDeps\): Promise<void>/);
  assert.match(familyControllerSource, /function startEdit\(card: HTMLElement \| null, deps: FamilyControllerDeps\): void/);
  assert.match(familyControllerSource, /function startDelete\(btn: Element, deps: FamilyControllerDeps\): void/);
  assert.match(meProfileFormSource, /type MeProfileControllerDeps = \{/);
  assert.match(meProfileFormSource, /function profileHtml\(/);
  assert.match(meProfileFormSource, /function profileGoalMode\(profile: MeProfileProfile, goal: MeProfileGoalCheck\): string/);
  assert.match(meProfileFormSource, /function profileEnduranceGoal\(profile: MeProfileProfile\): MeProfileEnduranceGoalDraft/);
  assert.match(meProfileFormSource, /CairnMeProfileForm/);
  assert.match(meProfileControllerSource, /function wireProfileForm\(/);
  assert.match(meProfileControllerSource, /async function renderProfile\(deps: MeProfileControllerDeps\): Promise<void>/);
  assert.match(meProfileControllerSource, /CairnMeProfileForm\.html/);
  assert.doesNotMatch(meProfileControllerSource, /function profileHtml\(|function profileGoalMode|function profileEnduranceGoal/);
  assert.match(meProfileFormClient, /CairnMeProfileForm/);
  assert.match(meProfileFormClient, /profileHtml/);
  assert.match(meProfileControllerSource, /CairnMeProfileController/);
  assert.match(meProfileController, /CairnMeProfileController/);
  assert.match(meProfileController, /renderProfile/);
  assert.match(meHealthScreenCompositionSource, /const ME_HEALTH_SCREEN_SEGMENTS: readonly ClientSegment\[\]/);
  assert.match(meHealthScreenSource, /async function renderMeProfile\(\)/);
  assert.match(meHealthScreenCompositionSource, /meProfileDeps: \(\) => CairnMeHealthDependencies\.profile\(context\(\)\)/);
  assert.match(meHealthDependenciesSource, /type ClientMeHealthDependenciesContext = \{/);
  assert.match(meHealthDependenciesSource, /function makeMeHealthDependenciesContext\(input: ClientMeHealthDependenciesContextInput\): ClientMeHealthDependenciesContext/);
  assert.match(meHealthControllerDepsSource, /function makeMeProfileDeps\(/);
  assert.match(meHealthControllerDepsSource, /function makeHealthReadDeps\(ctx: ClientMeHealthDependenciesContext\): ClientHealthReadControllerDeps/);
  assert.match(meHealthDependenciesSource, /CairnMeHealthControllerDeps\.profile/);
  assert.match(meHealthDependenciesSource, /CairnMeHealthDependencies/);
  assert.match(meHealthScreenCompositionSource, /CairnMeHealthDependencies\.context\(\{/);
  assert.match(meHealthScreenCompositionSource, /CairnMeProfileController\.renderProfile\(screen\.meProfileDeps\(\)\)/);
  assert.doesNotMatch(meHealthScreenSource, /id="profFields"/);
  assert.match(meHealthScreenSource, /function renderHealthSynthesis\(data: unknown, token\?: number \| null\): void/);
  assert.match(meHealthScreenCompositionSource, /meHealthTabsDeps: \(\) => CairnMeHealthDependencies\.tabs\(context\(\)\)/);
  assert.match(meHealthScreenCompositionSource, /CairnMeHealthTabsController\.renderHealth\(screen\.meHealthTabsDeps\(\)\)/);
  assert.match(meHealthScreenSource, /function switchHealthSeg\(seg: ClientHealthSection, opts: \{ openPicker\?: boolean \} = \{\}\): void/);
  assert.match(meHealthScreenCompositionSource, /CairnMeHealthTabsController\.switchHealthSeg\(seg, screen\.meHealthTabsDeps\(\), opts\)/);
  assert.match(meHealthScreenCompositionSource, /function healthPictureDeps\(\): ClientHealthPictureControllerDeps/);
  assert.match(meHealthScreenCompositionSource, /CairnHealthPictureController\.getHealthPictureCache/);
  assert.match(meHealthScreenCompositionSource, /CairnHealthPictureController\.setHealthPictureCache/);
  assert.match(meHealthScreenCompositionSource, /CairnHealthPictureController\.paintHealthPicture/);
  assert.match(meHealthScreenCompositionSource, /CairnHealthPictureController\.loadHealthPicture/);
  assert.doesNotMatch(meHealthScreenSource, /let\s+_hReviewRun|let\s+_hReviewErr|function\s+healthPictureCacheRoot/);
  assert.match(meRecordsScreenSource, /function healthRecordsDeps\(\)/);
  assert.match(meRecordsScreenSource, /function healthShareDeps\(\): ClientHealthShareControllerDeps/);
  assert.match(meRecordsScreenSource, /CairnHealthShareController\.render\(healthShareDeps\(\)\)/);
  assert.match(meRecordsScreenSource, /getHealthPictureCache/);
  assert.match(meRecordsScreenSource, /setHealthPictureCache/);
  assert.doesNotMatch(meRecordsScreenSource, /\b_hPic\b/);
  assert.match(meHealthScreenSource, /Object\.assign\(globalThis, \{/);
  assert.match(meRecordsScreenSource, /async function renderLife\(\)/);
  assert.match(meRecordsScreenSource, /async function renderFamily\(\)/);
  assert.doesNotMatch(meRecordsScreenSource, /function wireHealthUpload\(\)/);
  assert.doesNotMatch(meRecordsScreenSource, /function loadHealthDocs\(\): Promise<HealthDocument\[\]>/);
  assert.doesNotMatch(meRecordsScreenSource, /function openDoctorReportTab|api\("\/markers\/reconcile"|cachedApi\("\/markers\/priority"|downloadFile\(withToken\("\/api\/health-export"\)\)/);
  assert.match(meRecordsHealthDocControllerSource, /CairnHealthDocUploadController\.wireUpload\(healthDocUploadDeps\(deps\)\)/);
  assert.match(meRecordsHealthDocControllerSource, /async function loadHealthDocs\(deps: HealthRecordsControllerDeps\): Promise<HealthDocument\[\]>/);
  assert.match(meRecordsScreenSource, /Object\.assign\(globalThis, \{/);
  assert.match(routeStateSource, /type CairnRoute = import\("\.\.\/contracts\/client\.js"\)\.ClientRoute/);
  assert.match(routeStateSource, /function parseRoute\(input: string \| URL\): CairnRoute/);
  assert.match(appRouterSource, /function applyRouteState\(route: AppRoute \| null \| undefined/);
  assert.match(appRouterSource, /function currentRouteState\(options: CurrentRouteOptions\): Partial<AppRoute>/);
  assert.match(appRouterSource, /function syncRouteFromState\(options: SyncRouteOptions\): string \| null/);
  assert.match(appRouterSource, /\.CairnAppRouter = api/);
  assert.match(appRouteSyncSource, /function routeSyncApi\(\): RouteSyncRoutesApi \| null/);
  assert.match(appRouteSyncSource, /function routeSyncApply\(route: RouteSyncRoute \| null \| undefined\): ClientTabName/);
  assert.match(appRouteSyncSource, /function routeSyncCurrent\(\): Partial<RouteSyncRoute>/);
  assert.match(appRouteSyncSource, /function routeSyncFromState\(mode: RouteSyncMode = "push"\): void/);
  assert.match(appRouteSyncSource, /Object\.assign\(globalThis, \{/);
  assert.match(appRenderDispatchSource, /function renderAppTab\(tabName: unknown\): unknown/);
  assert.match(appRenderDispatchSource, /state\.planJump = null/);
  assert.match(appRenderDispatchSource, /PROGRESS_HANDLERS\[defaultProgressSeg\(\)\] \|\| renderHistory/);
  assert.match(appRenderDispatchSource, /window\.renderTab = renderAppTab/);
  assert.match(appTabsSource, /function defaultProgressSeg\(\): string/);
  assert.match(appTabsSource, /function switchTab\(tab: unknown, opts: TabSwitchOptions = \{\}\): void/);
  assert.match(appTabsSource, /function registerTabBarHandlers\(\): void/);
  assert.match(appTabsSource, /function activateTab\(name: unknown, opts: TabSwitchOptions = \{\}\): void/);
  assert.match(appTabsSource, /Promise\.resolve\(withViewTransition\(\(\) => paintTabSkeleton\(next\)\)\)\.finally/);
  assert.match(appJobReconnectorsSource, /const APP_JOB_RECONNECTORS: AppJobReconnectEntry\[\] = \[/);
  assert.match(appJobReconnectorsSource, /factoryName: "reconnectSessionSuggest"/);
  assert.match(appJobReconnectorsSource, /function registerAppJobReconnectors\(\): void/);
  assert.match(appMobileViewportSource, /function installMobileViewportGuards\(\): void/);
  assert.match(appMobileViewportSource, /measureChatTop/);
  assert.match(appMobileViewportSource, /window\.visualViewport/);
  assert.match(appMobileViewportSource, /classList\.toggle\("kb-geometry-open", geometryOpen\)/);
  // Recovery is refocus-only — the guard never blurs the composer by heuristic;
  // vvMax is re-baselined on resume only when no text input is focused (keyboard down).
  assert.doesNotMatch(appMobileViewportSource, /\.blur\(\)/);
  assert.match(appMobileViewportSource, /const reseedAndResync = \(\) => \{ if \(!focusedTextInput\(\)\) vvMax = vv\.height/);
  assert.match(appMobileViewportSource, /Math\.round\(Math\.max\(0, rawVvb\)\)/);
  assert.match(appMobileViewportSource, /document\.addEventListener\("cairn:keyboard-settle"/);
  assert.match(appMobileViewportSource, /Math\.min\(nativePickerSuppressMs, 1800\)/);
  assert.match(appServiceWorkerSource, /function registerServiceWorkerLifecycle\(\): void/);
  assert.match(appServiceWorkerSource, /__cairnSwLifecycleStarted/);
  assert.match(appServiceWorkerSource, /navigator\.serviceWorker\.addEventListener\("controllerchange"/);
  assert.match(appServiceWorkerSource, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(appDisciplinePrimerSource, /function primeDiscipline\(\): void/);
  assert.match(appDisciplinePrimerSource, /peekCached<\{ primary_discipline\?: unknown; endurance_goal_json\?: unknown \}>/);
  assert.match(appDisciplinePrimerSource, /renderTab\("progress"\)/);
  assert.match(appDisciplinePrimerSource, /renderTab\("plan"\)/);
  assert.match(appOnboardingSource, /async function maybeOnboard\(\): Promise<void>/);
  assert.match(appOnboardingSource, /function openOnboarding\(\): void/);
  assert.match(appOnboardingSource, /hideSaveBar\(\)/);
  assert.match(appOnboardingSource, /CairnUi\.jobCaptionHtml\(\)/);
  assert.match(appOnboardingSource, /thinkingCaption\(capEl, "onboard"\)/);
  assert.match(appStartupSource, /function startAppShell\(\): void/);
  assert.match(appStartupSource, /registerTabBarHandlers\(\)/);
  assert.match(appStartupSource, /activateTab\(landingTab \|\| "today"/);
  assert.match(appStartupSource, /window\.addEventListener\("popstate"/);
  assert.match(appStartupSource, /setTimeout\(\(\) => \{ jobReconnect\(\); \}, 0\)/);
  assert.match(routeState, /root\.CairnRoutes = \{/);
  assert.match(appRouter, /CairnAppRouter = api/);
  assert.match(appRouteSync, /Object\.assign\(globalThis, \{/);
  assert.match(appRouteSync, /applyRouteState: routeSyncApply/);
  assert.match(appRouteSync, /syncRouteFromState: routeSyncFromState/);
  assert.match(appRenderDispatch, /Object\.assign\(globalThis, \{ renderTab: renderAppTab \}\)/);
  assert.match(appRenderDispatch, /window\.renderTab = renderAppTab/);
  assert.match(appTabs, /Object\.assign\(globalThis, \{ activateTab, defaultProgressSeg, registerTabBarHandlers, switchTab \}\)/);
  assert.match(appTabs, /window\.activateTab = activateTab/);
  assert.match(appTabs, /window\.switchTab = switchTab/);
  assert.doesNotMatch(boot, /const ROUTE_TABS = CairnAppRouter\.ROUTE_TABS/);
  assert.doesNotMatch(boot, /function\s+applyRouteState/);
  assert.doesNotMatch(boot, /function\s+currentRouteState/);
  assert.doesNotMatch(boot, /function\s+syncRouteFromState/);
  assert.doesNotMatch(boot, /function\s+renderTab/);
  assert.match(apiClient, /Object\.assign\(globalThis, \{/);
  assert.match(apiClient, /withToken/);
  assert.match(apiClient, /api/);
  assert.doesNotMatch(apiClient, /@returns\s*\{Promise<any>\}/);
  assert.match(appDownloadSource, /function downloadFile\(href: string\): void/);
  assert.match(appDownload, /Object\.assign\(globalThis, \{ downloadFile \}\)/);
  assert.match(appDownload, /window\.downloadFile = downloadFile/);
  assert.match(appSwRecovery, /startServiceWorkerLifecycle\(\)/);
  assert.match(appSwRecovery, /registerServiceWorkerLifecycle/);
  assert.match(appSwRecovery, /__cairnSwLifecycleStarted/);
  assert.match(coreState, /\/\/ @ts-check/);
  assert.match(coreState, /Object\.assign\(globalThis, \{ \$: query, view: appView, headerTitle: appHeaderTitle, state: appState \}\)/);
  assert.match(pwaInstall, /Object\.assign\(globalThis, \{/);
  assert.match(pwaInstall, /CairnPwaInstall/);
  assert.doesNotMatch(pwaInstall, /^let\s+deferredInstallPrompt/m);
  assert.doesNotMatch(ui, /function\s+renderPhoneCoachBanner|function\s+refreshPhoneCoach|let\s+deferredInstallPrompt/);
  assert.match(restTimer, /Object\.assign\(globalThis, \{/);
  assert.match(restTimer, /CairnRestTimer/);
  assert.doesNotMatch(ui, /function\s+startRest|function\s+stopRest|const\s+rest\s*=/);
  assert.match(coachingFocusClient, /Object\.assign\(globalThis, \{/);
  assert.match(coachingFocusClient, /CairnCoachingFocus/);
  assert.match(coachingFocusClient, /document\.addEventListener\("click"/);
  assert.doesNotMatch(ui, /function\s+coachingFocusCardHtml|function\s+loadCoachingFocus|function\s+cfocusRoute|const\s+CFOCUS_DOMAIN_LABEL/);
  assert.match(todayActivityClient, /Object\.assign\(globalThis, \{/);
  assert.match(todayActivityClient, /CairnTodayActivity/);
  assert.doesNotMatch(todayActivityClient, /^const\s+ACT_ART_PHRASE/m);
  assert.doesNotMatch(today, /function\s+actEntryHtml|function\s+updateActEntry|const\s+ACT_ART_PHRASE/);
  assert.match(markdownClient, /Object\.assign\(globalThis, \{/);
  assert.match(markdownClient, /CairnMarkdown/);
  assert.doesNotMatch(ui, /function\s+mdToHtml|function\s+mdInline|function\s+mdSafeUrl/);
  assert.match(saveBar, /\/\/ @ts-check/);
  assert.match(saveBar, /Object\.assign\(globalThis, \{ hideSaveBar, mountSaveBar \}\)/);
  assert.match(saveBar, /Object\.assign\(window, \{ hideSaveBar, mountSaveBar \}\)/);
  assert.match(swrCache, /Object\.assign\(globalThis, \{/);
  assert.match(swrCache, /cachedApi/);
  assert.match(swrCache, /paintSWR/);
  assert.doesNotMatch(swrCache, /@returns\s*\{Promise<any>\}/);
  assert.match(uiComponents, /Object\.assign\(globalThis, \{ CairnUi: CAIRN_UI \}\)/);
  assert.match(uiComponents, /window\.CairnUi = CAIRN_UI/);
  assert.match(uiComponents, /loadingStateHtml/);
  assert.match(uiComponents, /segmentedNavHtml/);
  assert.match(uiComponents, /jobCaptionHtml/);
  assert.match(uiComponents, /sheetChipHtml/);
  assert.match(uiFeedbackSource, /const\s+CAIRN_UI_FEEDBACK/);
  assert.match(uiActionsSource, /const\s+CAIRN_UI_ACTIONS/);
  assert.match(uiFeedback, /CairnUiFeedback: CAIRN_UI_FEEDBACK/);
  assert.match(uiActions, /CairnUiActions: CAIRN_UI_ACTIONS/);
  assert.match(uiViewTransitions, /CairnUiViewTransitions: CAIRN_UI_VIEW_TRANSITIONS/);
  assert.match(uiViewTransitions, /create,/);
  assert.match(uiViewTransitions, /isViewTransitionAbort,/);
  assert.match(uiActions, /function\s+showToast\(msg, opts = \{\}\)/);
  assert.match(uiActions, /function\s+armDestructiveAction\(btn, onConfirm/);
  assert.match(uiFeedback, /loadingState\(label\)[\s\S]*CairnUi\.loadingStateHtml\(\{ label \}\)/);
  assert.match(uiFeedback, /function\s+btnBusy/);
  assert.match(uiFeedback, /function\s+thinkingCaption/);
  assert.doesNotMatch(ui, /let\s+toastTimer|let\s+_toastTimer|function\s+btnBusy|function\s+thinkingCaption|function\s+runCountUps|document\.startViewTransition|function\s+isViewTransitionAbort/);
  assert.match(detailOverlayClient, /CairnDetailOverlay: CAIRN_DETAIL_OVERLAY/);
  assert.match(detailOverlayClient, /closeDetail/);
  assert.match(detailOverlayClient, /openDetailFrom/);
  assert.match(detailOverlayClient, /mountDetail/);
  assert.match(uiMotionClient, /CairnUiMotion: CAIRN_UI_MOTION/);
  assert.match(uiMotionClient, /collapseEl/);
  assert.match(uiMotionClient, /expandEl/);
  assert.match(exerciseDetailClient, /Object\.assign\(globalThis, \{ CairnExerciseDetail: CAIRN_EXERCISE_DETAIL \}\)/);
  assert.match(exerciseDetailClient, /window\.CairnExerciseDetail = CAIRN_EXERCISE_DETAIL/);
  assert.match(exerciseDetailClient, /explanation: exerciseDetailExplanation/);
  assert.match(exerciseDetailClient, /explanationHtml: exerciseDetailExplanationHtml/);
  assert.match(exerciseDetailClient, /validExplanationPayload: validExerciseDetailExplanationPayload/);
  assert.doesNotMatch(exerciseDetailClient, /^function\s+exerciseExplanation|^function\s+exerciseExplanationHtml|^function\s+validExerciseExplanationPayload/m);
  assert.match(exerciseDetailController, /Object\.assign\(globalThis, \{ CairnExerciseDetailController: CAIRN_EXERCISE_DETAIL_CONTROLLER \}\)/);
  assert.match(exerciseDetailController, /window\.CairnExerciseDetailController = CAIRN_EXERCISE_DETAIL_CONTROLLER/);
  assert.match(exerciseDetailController, /openExerciseModal/);
  assert.match(exerciseDetailController, /wireGuides/);
  assert.match(todayAgendaClient, /Object\.assign\(globalThis, \{/);
  assert.match(todayAgendaClient, /CairnTodayAgenda/);
  assert.match(todayRailLoaders, /CairnTodayRailLoaders: CAIRN_TODAY_RAIL_LOADERS/);
  assert.match(todayRailLoaders, /loadFuelToday/);
  assert.match(todayRailLoaders, /loadRecentActivities/);
  assert.match(todayRailController, /CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER/);
  assert.match(todayRailController, /fetchTodayAgenda/);
  assert.match(todayRailController, /runAgendaRail/);
  assert.match(todayPlanSelectionClient, /CairnTodayPlanSelection: CAIRN_TODAY_PLAN_SELECTION/);
  assert.match(todayPlanSelectionClient, /planDayNumberForSession/);
  assert.match(todayPlanSelectionClient, /suggestedPlanDayNumber/);
  assert.match(todayTrainingClient, /Object\.assign\(globalThis, \{/);
  assert.match(todayTrainingClient, /CairnTodayTraining/);
  assert.match(todayTrainingClient, /CairnUi\.textChipHtml/);
  assert.match(todayProgressionController, /CairnTodayProgressionController: CAIRN_TODAY_PROGRESSION_CONTROLLER/);
  assert.match(todayProgressionController, /refreshAdaptedRx/);
  assert.match(todayProgressionController, /scheduleRxRefresh/);
  assert.match(todayAddExerciseController, /CairnTodayAddExerciseController: CAIRN_TODAY_ADD_EXERCISE_CONTROLLER/);
  assert.match(todayAddExerciseController, /appendOffPlanCard/);
  assert.match(todayAddExerciseController, /setupAddExercise/);
  assert.match(todayBriefClient, /Object\.assign\(globalThis, \{ CairnTodayBrief: CAIRN_TODAY_BRIEF \}\)/);
  assert.match(todayBriefClient, /window\.CairnTodayBrief = CAIRN_TODAY_BRIEF/);
  assert.match(todayBriefClient, /briefHtml: todayBriefHtml/);
  assert.doesNotMatch(todayBriefClient, /^const\s+BRIEF_KIND|^const\s+BRIEF_OVERRIDES|^function\s+todayBriefHtml/m);
  assert.match(cardioPlanClient, /Object\.assign\(globalThis, \{/);
  assert.match(cardioPlanClient, /CairnCardioPlan/);
  assert.match(cardioSyncClient, /Object\.assign\(globalThis, \{/);
  assert.match(cardioSyncClient, /CairnCardioSync/);
  assert.match(cardioSyncClient, /garminConfigured/);
  assert.match(cardioSyncClient, /cardioSyncLine/);
  assert.match(cardioSyncClient, /wireCardioSync/);
  assert.match(cardioSyncClient, /HR_ZONE_COLORS/);
  assert.doesNotMatch(cardioSyncClient, /^function\s+garminConfigured|^function\s+cardioSyncLine|^function\s+wireCardioSync/m);
  assert.doesNotMatch(today, /function\s+garminConfigured|function\s+cardioSyncLine|function\s+wireCardioSync/);
  assert.doesNotMatch(today, /const\s+HR_ZONE_COLORS/);
  assert.match(today, /cardio-sync-client\.js/);
  assert.match(todayLatelyClient, /CairnTodayLately/);
  assert.match(todayLatelyClient, /garminSessionCard/);
  assert.match(todayLatelyClient, /rowHtml: latelyRow/);
  assert.match(todaySideLoadersClient, /CairnTodayLately\.garminSessionCard/);
  assert.match(todayCompatibilityBridges, /CairnTodaySideLoaders\.garminSessionCard/);
  assert.match(todayRailLoadersSource, /CairnTodayLately\.rowHtml/);
  assert.doesNotMatch(today, /CairnTodayLately\.rowHtml/);
  assert.doesNotMatch(today, /function\s+garminSessionCard\(g\) \{[\s\S]*const\s+tiles\s*=\s*\[\]/);
  assert.doesNotMatch(today, /function\s+latelyRow\(row\) \{[\s\S]*const\s+isStrength\s*=\s*row\.kind/);
  assert.match(proposalClient, /Object\.assign\(globalThis, \{/);
  assert.match(proposalClient, /CairnProposal/);
  assert.match(proposalClient, /applyResultMessage/);
  assert.match(proposalClient, /verifiedBadgeHtml/);
  assert.match(proposalClient, /runTargetText/);
  assert.match(proposalClient, /coachProposalListHtml/);
  assert.doesNotMatch(
    proposalClient,
    /^function\s+applyResultMessage|^function\s+verifiedBadgeHtml|^function\s+strengthChangeHtml|^function\s+runTargetText|^function\s+isOpenProposal|^function\s+coachProposalCardHtml|^function\s+coachProposalListHtml/m
  );
  assert.match(coachProposalController, /CairnCoachProposalController: CAIRN_COACH_PROPOSAL_CONTROLLER/);
  assert.match(coachProposalController, /runCoachProposal,/);
  assert.match(coachProposalController, /applyProposalById,/);
  assert.match(coachProposalController, /reconnectProposal,/);
  assert.match(coachProposalController, /CairnProposal\.coachProposalListHtml\(proposals, lastApplyClamp\)/);
  assert.match(todaySessionSuggestClient, /Object\.assign\(globalThis, \{ CairnTodaySessionSuggest: CAIRN_TODAY_SESSION_SUGGEST \}\)/);
  assert.match(todaySessionSuggestClient, /window\.CairnTodaySessionSuggest = CAIRN_TODAY_SESSION_SUGGEST/);
  assert.match(todaySessionSuggestClient, /cardHtml: todaySuggestCardHtml/);
  assert.match(todaySessionSuggestClient, /loadingHtml: todaySuggestLoadingHtml/);
  assert.doesNotMatch(todaySessionSuggestClient, /^const\s+SESSION_VIBES|^function\s+todaySuggestCardHtml|^function\s+todaySuggestComposerHtml/m);
  assert.match(todaySessionSuggestController, /CairnTodaySessionSuggestController: CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER/);
  assert.match(todaySessionSuggestController, /askForSession/);
  assert.match(todaySessionSuggestController, /reconnectSessionSuggest/);
  assert.match(todaySessionSuggestController, /sessionSuggestOpOpts/);
  assert.match(todaySessionStatusClient, /CairnTodaySessionStatus: CAIRN_TODAY_SESSION_STATUS/);
  assert.match(todaySessionStatusClient, /setsTonnage: todaySetsTonnage/);
  assert.match(todaySessionStatusClient, /setChipHtml: todaySetChipHtml/);
  assert.match(todaySessionStatusClient, /sessionDoneCardHtml: todaySessionDoneCardHtml/);
  assert.match(todaySessionStatusClient, /feedbackFormHtml: todayFeedbackFormHtml/);
  assert.doesNotMatch(todaySessionStatusClient, /^function\s+setsTonnage|^function\s+setChip|^function\s+todaySessionDoneCardHtml|^function\s+todayFeedbackFormHtml|^const\s+TODAY_FEEL_FACES/m);
  assert.match(todaySessionFeedbackClient, /CairnTodaySessionFeedback: CAIRN_TODAY_SESSION_FEEDBACK/);
  assert.match(todaySessionFeedbackClient, /renderFeedback/);
  assert.match(todaySessionSkipClient, /CairnTodaySessionSkip: CAIRN_TODAY_SESSION_SKIP/);
  assert.match(todaySessionSkipClient, /wireSkips/);
  assert.match(todaySessionController, /CairnTodaySessionController: CAIRN_TODAY_SESSION_CONTROLLER/);
  assert.match(todaySessionController, /wireLogRow/);
  assert.match(todaySessionController, /wireSessionSurface/);
  assert.match(todaySessionController, /renderFeedback/);
  assert.match(todayProgramAdjustmentsClient, /Object\.assign\(globalThis, \{ CairnTodayProgramAdjustments: CAIRN_TODAY_PROGRAM_ADJUSTMENTS \}\)/);
  assert.match(todayProgramAdjustmentsClient, /window\.CairnTodayProgramAdjustments = CAIRN_TODAY_PROGRAM_ADJUSTMENTS/);
  assert.match(todayProgramAdjustmentsClient, /planRequest: todayAdjustmentPlanRequest/);
  assert.match(todayProgramAdjustmentsClient, /bannerHtml: todayProgramAdjustmentsBannerHtml/);
  assert.doesNotMatch(todayProgramAdjustmentsClient, /^const\s+TODAY_ADJUST_GLYPH|^function\s+todayAdjustmentPlanRequest|^function\s+todayProgramAdjustmentsBannerHtml/m);
  assert.match(todayWeekAheadClient, /Object\.assign\(globalThis, \{ CairnTodayWeekAhead: CAIRN_TODAY_WEEK_AHEAD \}\)/);
  assert.match(todayWeekAheadClient, /window\.CairnTodayWeekAhead = CAIRN_TODAY_WEEK_AHEAD/);
  assert.match(todayWeekAheadClient, /cardHtml: todayWeekAheadCardHtml/);
  assert.doesNotMatch(todayWeekAheadClient, /^const\s+TODAY_WEEK_AHEAD_GLYPH|^function\s+todayWeekAheadCardHtml|^function\s+todayWeekAheadRowHtml/m);
  assert.match(todayContextClient, /Object\.assign\(globalThis, \{ CairnTodayContext: CAIRN_TODAY_CONTEXT \}\)/);
  assert.match(todayContextClient, /window\.CairnTodayContext = CAIRN_TODAY_CONTEXT/);
  assert.match(todayContextClient, /contextBannerHtml,/);
  assert.match(todayContextClient, /goalLineHtml,/);
  assert.match(todayContextClient, /healthFocusBannerHtml,/);
  assert.doesNotMatch(todayContextClient, /^const\s+TODAY_CONTEXT_ICONS|^function\s+contextBannerHtml|^function\s+goalLineHtml|^function\s+healthFocusBannerHtml/m);
  assert.match(todayCompassClient, /Object\.assign\(globalThis, \{ CairnTodayCompass: CAIRN_TODAY_COMPASS \}\)/);
  assert.match(todayCompassClient, /window\.CairnTodayCompass = CAIRN_TODAY_COMPASS/);
  assert.match(todayCompassClient, /paceTileHtml,/);
  assert.match(todayCompassClient, /paceOfferHtml,/);
  assert.match(todayCompassClient, /build,/);
  assert.doesNotMatch(todayCompassClient, /^const\s+PACE_WORDS|^function\s+paceTileHtml|^function\s+build/m);
  assert.match(todayGarminReconciliationClient, /Object\.assign\(globalThis, \{ CairnTodayGarminReconciliation: CAIRN_TODAY_GARMIN_RECONCILIATION \}\)/);
  assert.match(todayGarminReconciliationClient, /window\.CairnTodayGarminReconciliation = CAIRN_TODAY_GARMIN_RECONCILIATION/);
  assert.match(todayGarminReconciliationClient, /load,/);
  assert.doesNotMatch(todayGarminReconciliationClient, /^function\s+reconcilePromptHtml|^function\s+reconciledToast|^async function\s+load/m);
  assert.match(todaySideLoadersClient, /Object\.assign\(globalThis, \{ CairnTodaySideLoaders: CAIRN_TODAY_SIDE_LOADERS \}\)/);
  assert.match(todaySideLoadersClient, /CairnTodaySideLoaders: CAIRN_TODAY_SIDE_LOADERS/);
  assert.match(todaySideLoadersClient, /loadWearable,/);
  assert.match(todaySideLoadersClient, /loadHealthFocusBanner,/);
  assert.match(todayPlanSessionModelSource, /CairnTodayPlanSessionModel/);
  assert.match(todayPlanSessionModelClient, /CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL/);
  assert.match(todayPlanSessionModelClient, /itemGroups,/);
  assert.match(todayPlanSessionModelClient, /prefillFor,/);
  assert.match(todayPlanSessionDataSource, /CairnTodayPlanSessionData/);
  assert.match(todayPlanSessionDataClient, /CairnTodayPlanSessionData: CAIRN_TODAY_PLAN_SESSION_DATA/);
  assert.match(todayPlanSessionDataClient, /loadLastSets,/);
  assert.match(todayPlanSessionDataClient, /loadPrescriptions,/);
  assert.match(todayPlanSessionPreparationClient, /CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION/);
  assert.match(todayPlanSessionPreparationClient, /preparePlanSession,/);
  assert.match(todayPlanSessionPreparationSource, /todayPlanSessionModel\.itemGroups/);
  assert.doesNotMatch(todayPlanSessionPreparationSource, /async function loadLastSets/);
  assert.match(todayDataLoaderClient, /CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER/);
  assert.match(todayDataLoaderClient, /scheduleSoftRepaint/);
  assert.match(todayMainShellClient, /CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL/);
  assert.match(todayMainShellClient, /leadHtml/);
  assert.match(todayMainShellClient, /weekFoldHtml/);
  assert.match(todayPlanSurfaceClient, /CairnTodayPlanSurface: CAIRN_TODAY_PLAN_SURFACE/);
  assert.match(todayPlanSurfaceClient, /sessionHeadHtml/);
  assert.match(todayPlanSurfaceClient, /addExerciseFormHtml/);
  assert.match(todayPlanSurfaceRendererClient, /CairnTodayPlanSurfaceRenderer: CAIRN_TODAY_PLAN_SURFACE_RENDERER/);
  assert.match(todayPlanSurfaceRendererClient, /buildHtml/);
  assert.match(todayPlanSurfaceRendererClient, /orderedSurfaceItems/);
  assert.match(todayRenderStateClient, /CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE/);
  assert.match(todayRenderStateClient, /derive/);
  assert.match(todayPostRenderWiringClient, /CairnTodayPostRenderWiring: CAIRN_TODAY_POST_RENDER_WIRING/);
  assert.match(todayPostRenderWiringClient, /wirePostRender/);
  assert.match(todayScreenRuntimeDepsClient, /CairnTodayScreenRuntimeDeps: CAIRN_TODAY_SCREEN_RUNTIME_DEPS/);
  assert.match(todayScreenRuntimeDepsClient, /CairnTodayDependencies\.context/);
  assert.match(agentLoginModelClient, /CairnAgentLoginModel: CAIRN_AGENT_LOGIN_MODEL/);
  assert.match(agentLoginAssetsClient, /CairnAgentLoginAssets: CAIRN_AGENT_LOGIN_ASSETS/);
  assert.match(agentLoginModalClient, /CairnAgentLoginModal: CAIRN_AGENT_LOGIN_MODAL/);
  assert.match(agentLoginSessionClient, /CairnAgentLoginSession: CAIRN_AGENT_LOGIN_SESSION/);
  assert.match(agentLoginClient, /Object\.assign\(globalThis, \{ openAgentLoginModal \}\)/);
  assert.match(agentLoginClient, /Object\.assign\(window, \{ openAgentLoginModal \}\)/);
  assert.doesNotMatch(agentLoginClient, /^function\s+xtermWindow|^function\s+loadXtermAssets|^async function\s+openAgentLoginModal/m);
  assert.doesNotMatch(ui, /openAgentLoginModal|xtermWindow|agent-login-ov/);
  assert.doesNotMatch(meals, /function\s+statusBadge|function\s+applyResultMessage|function\s+clampNoteHtml|function\s+verifiedBadgeHtml|function\s+strengthChangeHtml|function\s+runTargetText|function\s+isOpenProposal|const\s+proposalCardHtml/);
  assert.match(meals, /CairnCoachProposalController\.runCoachProposal/);
  assert.match(meals, /CairnCoachProposalController\.renderProposals/);
  assert.match(meals, /coach-proposal-controller\.js/);
  assert.doesNotMatch(meals, /lastApplyClamp|function\s+coachProposalOpOpts|function\s+renderProposals|async function\s+applyProposalById|function\s+reconnectProposal/);
  assert.doesNotMatch(ui, /function\s+cardioPrescription|function\s+cardioLabel|function\s+isCardioItem/);
  assert.match(progressDataClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressDataClient, /CairnProgressData/);
  assert.match(progress, /CairnProgressData\.rows/);
  assert.doesNotMatch(progress, /function\s+isProgressRecord|function\s+progressRows|function\s+progressNumber/);
  assert.match(progressEnduranceClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnduranceClient, /CairnProgressEndurance/);
  assert.match(progressEnduranceControllerClient, /CairnProgressEnduranceController/);
  assert.match(progressEnduranceControllerClient, /render: renderProgressEndurance/);
  assert.doesNotMatch(progress, /function\s+enduranceStatusWord|function\s+enduranceBlockHtml|function\s+paceTrendWord|function\s+zoneBarHtml|function\s+enduranceBestRows|function\s+enduranceSportCardHtml/);
  assert.match(progress, /CairnProgressEnduranceController\.render/);
  assert.match(progress, /CairnProgressEnduranceController\.paint/);
  assert.doesNotMatch(progress, /api\("\/endurance-prs"\)|function\s+paintProgressEnduranceBody/);
  assert.match(progressComponentsClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressComponentsClient, /CairnProgressComponents/);
  assert.doesNotMatch(progress, /function\s+progressHero|function\s+emptyStateHtml|const\s+fmtShortDate/);
  assert.match(progressChartScrubClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressChartScrubClient, /CairnProgressChartScrub/);
  assert.match(progressChartScrubClient, /wireProgressChartScrub/);
  assert.match(progressChartDrawingClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressChartDrawingClient, /CairnProgressChartDrawing/);
  assert.match(progressChartDrawingClient, /drawProgressChartBase/);
  assert.match(progressChartDrawingClient, /drawProgressChartHighlight/);
  assert.match(progressChartClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressChartClient, /CairnProgressChart/);
  assert.match(progressChartClient, /drawLineChart/);
  assert.doesNotMatch(progress, /function\s+withAlpha|function\s+chartColors|function\s+drawLineChart/);
  assert.match(progressTrendWeightClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressTrendWeightClient, /CairnProgressTrendWeight/);
  assert.match(progressTrendWeightClient, /paintProgressBody/);
  assert.match(progressTrendWeightClient, /paintWeightBody/);
  assert.doesNotMatch(progress, /function\s+paintProgressBody|function\s+paintWeightBody|async function\s+drawProgress/);
  assert.match(progressHistoryModelClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressHistoryModelClient, /CairnProgressHistoryModel/);
  assert.match(progressHistoryModelClient, /progressHistorySummary/);
  assert.match(progressHistoryRenderClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressHistoryRenderClient, /CairnProgressHistoryRender/);
  assert.match(progressHistoryRenderClient, /progressHistorySessionEditHtml/);
  assert.match(progressHistoryClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressHistoryClient, /CairnProgressHistory/);
  assert.doesNotMatch(progress, /function\s+sessionCardHtml|function\s+numOrNull/);
  assert.match(progressRunPlanClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressRunPlanClient, /CairnProgressRunPlan/);
  assert.doesNotMatch(progress, /function\s+runKindClass|function\s+weeklyRunPlanCard|function\s+enduranceGoalCard|function\s+runComplianceLine|function\s+enduranceCoachLine/);
  assert.match(progressRouteDepsClient, /Object\.assign\(globalThis, \{ CairnProgressRouteDeps: CAIRN_PROGRESS_ROUTE_DEPS \}\)/);
  assert.match(progressRouteDepsClient, /function progressEnduranceRouteDeps\(renderSelf\)/);
  assert.match(progressRouteDepsClient, /function progressProgramRouteDeps\(renderSelf\)/);
  assert.match(progressVolumeClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressVolumeClient, /CairnProgressVolume/);
  assert.doesNotMatch(progress, /const\s+PATTERN_WORD|function\s+volBalanceHtml|function\s+capWord/);
  assert.match(progressEnergyClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnergyClient, /CairnProgressEnergy/);
  assert.match(progressEnergyClient, /energyBodyHtml/);
  assert.match(progressEnergyClient, /nutritionCheckinLoadingHtml/);
  assert.match(progressEnergyClient, /nutritionCheckinProposalHtml/);
  assert.doesNotMatch(progressEnergyClient, /^const\s+ENERGY_CONF_WORD|^function\s+kcalFmt/m);
  assert.match(progressEnergySurfaceClient, /Object\.assign\(globalThis,\s*\{[\s\S]*CairnProgressEnergySurface: CAIRN_PROGRESS_ENERGY_SURFACE/);
  assert.match(progressEnergySurfaceClient, /paintEnergyBody,/);
  assert.match(progressEnergySurfaceClient, /reconnectNutritionCheckin,/);
  assert.match(progressEnergySurfaceClient, /runOp\("nutrition_checkin", \{ window: 21 \}, nutritionCheckinOpOpts\(restore\)\)/);
  assert.doesNotMatch(progress, /const\s+kcalFmt|function\s+energyRead|const\s+CONF_WORD|const\s+macroBits|prev_target_kcal|eb-checkin-ok settle-in|eb-checkin-quiet/);
  assert.match(progressEnergySurfaceClient, /CairnProgressEnergy\.energyBodyHtml\(exp\)/);
  assert.match(progress, /paintEnergyBody\(exp\)/);
  assert.match(meals, /paintEnergyBody\(exp\)/);
  assert.doesNotMatch(progress, /CairnProgressEnergy\.nutritionCheckinLoadingHtml\(\)|CairnProgressEnergy\.nutritionCheckinOkHtml|CairnProgressEnergy\.nutritionCheckinFailHtml|CairnProgressEnergy\.nutritionCheckinProposalHtml/);
  assert.match(progressCalendarClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressCalendarClient, /CairnProgressCalendar/);
  assert.doesNotMatch(progress, /function\s+calMonthHtml/);
  assert.match(progressMuscleTrajectoryClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressMuscleTrajectoryClient, /CairnProgressMuscleTrajectory/);
  assert.doesNotMatch(progress, /function\s+loadMuscleTrajectory|function\s+muscleVerdictTone|function\s+muscleVerdictWord|function\s+muscleTrendGlyph|function\s+muscleGroupRowHtml|function\s+muscleTrajectoryHtml/);
  assert.match(progressDexaTargetingClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressDexaTargetingClient, /CairnProgressDexaTargeting/);
  assert.doesNotMatch(progress, /function\s+loadDexaTargeting|function\s+dexaTargetToneCls|function\s+dexaTargetHtml|function\s+dexaTargetingHtml/);
  assert.match(progressPerformanceClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressPerformanceClient, /CairnProgressPerformance/);
  assert.match(progressPerformanceClient, /progressFocusCardPresent/);
  assert.doesNotMatch(progressPerformanceClient, /_progFocusCard/);
  assert.doesNotMatch(progress, /function\s+loadPerformance|function\s+pctClamp|function\s+capacityRowHtml|function\s+performanceHtml/);
  assert.match(progressProgramAdjustmentsClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramAdjustmentsClient, /CairnProgressProgramAdjustments/);
  assert.doesNotMatch(progress, /const\s+PADJ_KIND|function\s+loadProgramAdjustments|function\s+programAdjustmentsHtml/);
  assert.match(progressTestWeekClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressTestWeekClient, /CairnProgressTestWeek/);
  assert.doesNotMatch(progress, /function\s+loadTestWeek|function\s+testWeekBannerHtml/);
  assert.match(progressProgramSummaryClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramSummaryClient, /CairnProgressProgramSummary/);
  assert.doesNotMatch(progress, /function\s+liftStatusWord|function\s+liftTrendFig|function\s+liftBestFig|function\s+sortLifts|function\s+volBandWord|function\s+volTrendGlyph|function\s+phaseWord|function\s+liftRowHtml|function\s+volumeBlockHtml|function\s+mesoBlockHtml|function\s+adaptationsHtml/);
  assert.match(progressProgramBlockClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramBlockClient, /CairnProgressProgramBlock/);
  assert.match(progressProgramControllerClient, /CairnProgressProgramController/);
  assert.match(progressProgramControllerClient, /render: renderProgressProgram/);
  assert.match(progressProgramControllerClient, /paint: paintProgressProgramBody/);
  assert.match(progress, /CairnProgressRouteDeps\.endurance\(\(\) => renderEndurance\(\)\)/);
  assert.match(progress, /CairnProgressRouteDeps\.program\(\(\) => renderProgram\(\)\)/);
  assert.doesNotMatch(progress, /function progressEnduranceDeps|function progressProgramDeps|nextToken: \(\) => \+\+pollToken/);
  assert.doesNotMatch(progress, /function\s+blockFocusWord|function\s+activeBlockHtml|function\s+startBlockHtml|function\s+loadProgramBlock|function\s+wireProgramBlock/);
  assert.match(planEnduranceClient, /Object\.assign\(globalThis, \{ CairnPlanEndurance: CAIRN_PLAN_ENDURANCE \}\)/);
  assert.match(planEnduranceClient, /Object\.assign\(globalThis,\s*\{[\s\S]*renderPlanEndurance[\s\S]*enduranceProposalOpOpts[\s\S]*renderEnduranceDraftResult[\s\S]*\}\)/);
  assert.match(planEnduranceClient, /window\.CairnPlanEndurance = CAIRN_PLAN_ENDURANCE/);
  assert.doesNotMatch(planEnduranceClient, /^const\s+ENDURANCE_PHASES|^function\s+enduranceRampHtml|^function\s+endDraftCardHtml/m);
  assert.match(planEditorClient, /Object\.assign\(globalThis, \{ CairnPlanEditor: CAIRN_PLAN_EDITOR \}\)/);
  assert.match(planEditorClient, /window\.CairnPlanEditor = CAIRN_PLAN_EDITOR/);
  assert.match(planEditorClient, /dayModelFromPlan/);
  assert.match(planEditorClient, /progDayHtml/);
  assert.doesNotMatch(planEditorClient, /renderPlanEditor|mountSaveBar|api\("\/plan"/);
  assert.match(planEditorFormClient, /Object\.assign\(globalThis, \{ CairnPlanEditorForm: CAIRN_PLAN_EDITOR_FORM \}\)/);
  assert.match(planEditorFormClient, /window\.CairnPlanEditorForm = CAIRN_PLAN_EDITOR_FORM/);
  assert.match(planEditorFormClient, /serializePlanDays/);
  assert.match(planEditorFormClient, /syncPlanModel/);
  assert.doesNotMatch(planEditorFormClient, /renderPlanEditor|mountSaveBar|api\("\/plan"/);
  assert.match(planEditorController, /Object\.assign\(globalThis,\s*\{[\s\S]*CairnPlanEditorController[\s\S]*renderPlanEditor[\s\S]*\}\)/);
  assert.match(planEditorController, /window\.CairnPlanEditorController = CAIRN_PLAN_EDITOR_CONTROLLER/);
  assert.match(planEditorController, /window\.renderPlanEditor = renderPlanEditor/);
  assert.match(planEditorController, /mountSaveBar\(\{/);
  assert.match(planEditorController, /api\("\/plan"/);
  assert.doesNotMatch(planEditorClient, /^function\s+progDayHtml|^function\s+pitemHtml|^function\s+pdayHtml/m);
  assert.match(dayFuelClient, /Object\.assign\(globalThis, \{/);
  assert.match(dayFuelClient, /CairnDayFuel/);
  assert.match(dayFuelClient, /MEAL_LABEL/);
  assert.match(dayFuelClient, /dayFuelHtml/);
  assert.doesNotMatch(dayFuelClient, /^const\s+MEAL_LABEL|^function\s+dayFuelHtml/m);
  assert.match(dayFuelController, /Object\.assign\(globalThis, \{ CairnDayFuelController: CAIRN_DAY_FUEL_CONTROLLER \}\)/);
  assert.match(dayFuelController, /loadDayFuel/);
  assert.match(dayFuelController, /openFoodEdit/);
  assert.match(mealRowClient, /Object\.assign\(globalThis, \{/);
  assert.match(mealRowClient, /CairnMealRows/);
  assert.match(mealRowClient, /mealSlotFor/);
  assert.match(mealRowClient, /mealRowHtml/);
  assert.match(mealRowClient, /mealDayHtml/);
  assert.match(mealPlanClient, /Object\.assign\(globalThis, \{/);
  assert.match(mealPlanClient, /CairnMealPlan/);
  assert.match(mealPlanClient, /mealPlanListHtml/);
  assert.match(mealPlanClient, /mealPrefsHtml/);
  assert.match(mealPlanClient, /mealPlannerBodyHtml/);
  assert.match(mealPlanClient, /mealDayHtml/);
  assert.doesNotMatch(mealPlanClient, /^function\s+mealRowHtml|^function\s+mealPlanListHtml|^function\s+mealPrefsHtml|^function\s+mealPlannerBodyHtml|^function\s+mealDayHtml/m);
  assert.match(mealRecipeClient, /Object\.assign\(globalThis, \{ CairnMealRecipe: CAIRN_MEAL_RECIPE \}\)/);
  assert.match(mealRecipeClient, /window\.CairnMealRecipe = CAIRN_MEAL_RECIPE/);
  assert.match(mealRecipeClient, /ctaHtml: mealRecipeCtaHtml/);
  assert.match(mealRecipeClient, /recipeHtml: mealRecipeHtml/);
  assert.match(mealRecipeClient, /loadingHtml: mealRecipeLoadingHtml/);
  assert.doesNotMatch(mealRecipeClient, /^function\s+recipeCtaHtml|^function\s+recipeHtml|^function\s+recipeLoadingHtml/m);
  assert.match(mealRecipeController, /Object\.assign\(globalThis, \{/);
  assert.match(mealRecipeController, /CairnMealRecipeController/);
  assert.match(mealRecipeController, /closeMealSheet/);
  assert.match(mealRecipeController, /reconnectRecipe/);
  assert.match(mealSwapDataClient, /Object\.assign\(globalThis, \{ CairnMealSwapData: CAIRN_MEAL_SWAP_DATA \}\)/);
  assert.match(mealSwapDataClient, /window\.CairnMealSwapData = CAIRN_MEAL_SWAP_DATA/);
  assert.match(mealSwapDataClient, /record: mealSwapDataRecord/);
  assert.match(mealSwapDataClient, /days: mealSwapDataDays/);
  assert.match(mealSwapController, /Object\.assign\(globalThis, \{/);
  assert.match(mealSwapController, /CairnMealSwapController/);
  assert.match(mealSwapController, /function reconnectMealSwap\(job\)/);
  assert.match(mealSwapController, /function wireMealRows\(scope, current, ctx\)/);
  assert.match(mealSwapRowActionsController, /Object\.assign\(globalThis, \{ CairnMealSwapRowActionsController/);
  assert.match(mealSwapRowActionsController, /function mealSwapRowActionsWireMealRows/);
  assert.match(mealSwapController, /CairnMealSwapData\.days/);
  assert.match(mealPlannerJobsClient, /Object\.assign\(globalThis, \{/);
  assert.match(mealPlannerJobsClient, /CairnMealPlannerJobs/);
  assert.match(mealPlannerJobsClient, /function mealPlannerJobReconnectMealPlan\(\)/);
  assert.match(mealPlannerActionsController, /Object\.assign\(globalThis, \{/);
  assert.match(mealPlannerActionsController, /CairnMealPlannerActions/);
  assert.match(mealPlannerActionsController, /CairnMealPlan\.mealPlanListHtml\(plans\)/);
  assert.match(mealPlannerActionsController, /CairnMealSwapController\.wireMealRows/);
  assert.match(mealPlannerController, /Object\.assign\(globalThis, \{/);
  assert.match(mealPlannerController, /CairnMealPlannerController/);
  assert.match(mealPlannerController, /reconnectMealPlan/);
  assert.doesNotMatch(mealPlannerController, /function reconnectMealSwap|function wireMealRows|function mealSwapOpOpts|CairnMealPlan\.mealPlanListHtml|CairnMealSwapController\.wireMealRows/);
  assert.doesNotMatch(meals, /const\s+MEAL_LABEL|function\s+dayFuelHtml|function\s+loadDayFuel|function\s+openFoodEdit|const\s+MEAL_HINT_CHIPS|const\s+MEAL_PREFS_PLACEHOLDER|function\s+mealPrefsHtml|function\s+mealsCtxFor|function\s+mealRowHtml|function\s+mealSlotFor|function\s+mealDayHtml|const\s+mealCardHtml/);
  assert.doesNotMatch(meals, /function\s+mealRecipeCtaHtml|function\s+mealRecipeHtml|function\s+mealRecipeLoadingHtml|function\s+openMealSheet|function\s+recipeOpOpts|function\s+reconnectRecipe|function\s+reconnectMealPlan|function\s+reconnectMealSwap|function\s+wireMealRows|recipe-ings.*ingredients\.map/s);
  assert.match(dayFuelController, /CairnDayFuel/);
  assert.match(meals, /CairnDayFuelController\.loadDayFuel/);
  assert.match(meals, /meal-plan-client\.js/);
  assert.match(meals, /CairnMealPlannerController\.renderMealPlans/);
  assert.match(meals, /CairnMealPlan\.mealPlannerBodyHtml\(current, mealPrefs/);
  assert.match(mealSwapRowActionsController, /recipeController\.openMealSheet/);
  assert.match(mealSwapController, /CairnMealPlan\.mealDayHtml/);
  assert.match(foodNoteClient, /Object\.assign\(globalThis, \{/);
  assert.match(foodNoteClient, /CairnFoodNote/);
  assert.match(foodNoteClient, /foodIngredients/);
  assert.match(foodNoteClient, /noteEntryHtml/);
  assert.doesNotMatch(foodNoteClient, /^function\s+foodIngredients|^function\s+noteEntryHtml|^function\s+parsedNote/m);
  assert.match(foodDetailController, /Object\.assign\(globalThis, \{ CairnFoodDetailController: CAIRN_FOOD_DETAIL_CONTROLLER \}\)/);
  assert.match(foodDetailController, /window\.CairnFoodDetailController = CAIRN_FOOD_DETAIL_CONTROLLER/);
  assert.match(foodDetailController, /openFoodDetail/);
  assert.match(healthEvidenceClient, /Object\.assign\(globalThis, \{ CairnHealthEvidence: CAIRN_HEALTH_EVIDENCE \}\)/);
  assert.match(healthEvidenceClient, /window\.CairnHealthEvidence = CAIRN_HEALTH_EVIDENCE/);
  assert.match(healthEvidenceClient, /directiveHtml/);
  assert.doesNotMatch(healthEvidenceClient, /^const\s+DIRECTIVE_DOMAINS|^function\s+evidenceListHtml|^function\s+directiveHtml/m);
  assert.match(healthMarkerOrderClient, /Object\.assign\(globalThis, \{ CairnHealthMarkerOrder: CAIRN_HEALTH_MARKER_ORDER \}\)/);
  assert.match(healthMarkerOrderClient, /window\.CairnHealthMarkerOrder = CAIRN_HEALTH_MARKER_ORDER/);
  assert.match(healthMarkerOrderClient, /orderMarkersForDisplay/);
  assert.match(healthClient, /Object\.assign\(globalThis, \{ CairnHealthClient: CAIRN_HEALTH_CLIENT \}\)/);
  assert.match(healthClient, /window\.CairnHealthClient = CAIRN_HEALTH_CLIENT/);
  assert.match(healthClient, /CairnHealthEvidence\.directiveHtml/);
  assert.match(healthClient, /CairnHealthMarkerOrder\.orderMarkersForDisplay/);
  assert.doesNotMatch(healthClient, /^const\s+MAX_DOC_BYTES|^const\s+H_FILE_PROMPT|^const\s+DIRECTIVE_DOMAINS|^function\s+guessUploadMime|^function\s+evidenceListHtml|^function\s+directiveHtml/m);
  assert.match(healthPictureClient, /Object\.assign\(globalThis, \{ CairnHealthPicture: CAIRN_HEALTH_PICTURE \}\)/);
  assert.match(healthPictureClient, /window\.CairnHealthPicture = CAIRN_HEALTH_PICTURE/);
  assert.match(healthPictureClient, /reviewBusyHtml/);
  assert.match(healthPictureClient, /reviewHtml/);
  assert.doesNotMatch(healthPictureClient, /^function\s+parsedReview|^function\s+reviewHtml/m);
  assert.match(healthPictureController, /CairnHealthPictureController: CAIRN_HEALTH_PICTURE_CONTROLLER/);
  assert.match(healthPictureController, /getHealthPictureCache/);
  assert.match(healthPictureController, /loadHealthPicture/);
  assert.match(healthMarkersClient, /Object\.assign\(globalThis, \{ CairnHealthMarkers: CAIRN_HEALTH_MARKERS \}\)/);
  assert.match(healthMarkersClient, /window\.CairnHealthMarkers = CAIRN_HEALTH_MARKERS/);
  assert.match(healthMarkersClient, /markerChartSvg/);
  assert.match(healthMarkersClient, /wireMarkerChart/);
  assert.match(healthMarkersClient, /hmkRowHtml/);
  assert.doesNotMatch(healthMarkersClient, /^function\s+markerChartSvg|^function\s+hmkRowHtml/m);
  assert.match(healthMarkersController, /CairnHealthMarkersController: CAIRN_HEALTH_MARKERS_CONTROLLER/);
  assert.match(healthMarkersController, /window\.CairnHealthMarkersController = CAIRN_HEALTH_MARKERS_CONTROLLER/);
  assert.match(healthMarkersController, /CairnHealthClient\.orderMarkersForDisplay/);
  assert.match(healthMarkersController, /CairnHealthMarkers\.wireMarkerChart/);
  assert.match(healthDirectivesClient, /Object\.assign\(globalThis, \{ CairnHealthDirectives: CAIRN_HEALTH_DIRECTIVES \}\)/);
  assert.match(healthDirectivesClient, /window\.CairnHealthDirectives = CAIRN_HEALTH_DIRECTIVES/);
  assert.match(healthDirectivesClient, /directivesSectionHtml/);
  assert.match(healthDirectivesClient, /directiveResearchNudgeHtml/);
  assert.doesNotMatch(healthDirectivesClient, /^function\s+directivesSectionHtml|^function\s+directiveResearchNudgeHtml/m);
  assert.match(healthDirectiveLoaderClient, /Object\.assign\(globalThis, \{ CairnHealthDirectiveLoader: CAIRN_HEALTH_DIRECTIVE_LOADER \}\)/);
  assert.match(healthDirectiveLoaderClient, /window\.CairnHealthDirectiveLoader = CAIRN_HEALTH_DIRECTIVE_LOADER/);
  assert.match(healthDirectiveLoaderClient, /CairnHealthDirectives\.directivesSectionHtml/);
  assert.match(healthDirectiveLoaderClient, /api\("\/directives"\)/);
  assert.match(healthDirectiveLoaderClient, /api\("\/evidence\/summary"\)/);
  assert.match(healthDirectiveLoaderClient, /api\("\/directives\/derive"/);
  assert.match(healthReadClient, /Object\.assign\(globalThis, \{ CairnHealthRead: CAIRN_HEALTH_READ \}\)/);
  assert.match(healthReadClient, /window\.CairnHealthRead = CAIRN_HEALTH_READ/);
  assert.match(healthReadClient, /recoveryHtml/);
  assert.match(healthReadClient, /priorityMarkersSectionHtml/);
  assert.doesNotMatch(healthReadClient, /^function\s+recoveryHtml|^function\s+priorityMarkersSectionHtml|^function\s+optimalPhrase/m);
  assert.match(healthReadSupplementsClient, /Object\.assign\(globalThis, \{ CairnHealthReadSupplements: CAIRN_HEALTH_READ_SUPPLEMENTS \}\)/);
  assert.match(healthReadSupplementsClient, /window\.CairnHealthReadSupplements = CAIRN_HEALTH_READ_SUPPLEMENTS/);
  assert.match(healthReadSupplementsClient, /api\("\/supplements\/understand"/);
  assert.match(healthReadSupplementsClient, /api\(`\/supplements\/\$\{id\}`/);
  assert.match(healthReadController, /Object\.assign\(globalThis, \{ CairnHealthReadController: CAIRN_HEALTH_READ_CONTROLLER \}\)/);
  assert.match(healthReadController, /window\.CairnHealthReadController = CAIRN_HEALTH_READ_CONTROLLER/);
  assert.match(healthReadController, /CairnHealthRead\.recoveryNoDataHtml/);
  assert.match(healthReadController, /CairnHealthRead\.recoveryHtml/);
  assert.match(healthReadController, /CairnHealthRead\.priorityMarkersSectionHtml/);
  assert.match(healthReadController, /CairnHealthReadSupplements\.load/);
  assert.match(healthReadController, /CairnHealthReadSupplements\.render/);
  assert.match(healthStandingPrimitivesClient, /Object\.assign\(globalThis, \{ CairnHealthStandingPrimitives: CAIRN_HEALTH_STANDING_PRIMITIVES \}\)/);
  assert.match(healthStandingPrimitivesClient, /window\.CairnHealthStandingPrimitives = CAIRN_HEALTH_STANDING_PRIMITIVES/);
  assert.match(healthStandingPrimitivesClient, /function hstandBpCardHtml/);
  assert.match(healthStandingPrimitivesClient, /function hstandBodyCompHtml/);
  assert.match(healthStandingClient, /Object\.assign\(globalThis, \{ CairnHealthStanding: CAIRN_HEALTH_STANDING \}\)/);
  assert.match(healthStandingClient, /window\.CairnHealthStanding = CAIRN_HEALTH_STANDING/);
  assert.match(healthStandingClient, /renderHealthStandingHtml/);
  assert.match(healthStandingClient, /CairnHealthStandingPrimitives\.hstandBpCardHtml/);
  assert.match(healthStandingClient, /CairnHealthStandingPrimitives\.hstandBodyCompHtml/);
  assert.doesNotMatch(healthStandingClient, /^function\s+renderHealthStandingHtml|^function\s+hstandBpCardHtml|^function\s+hstandBodyCompHtml/m);
  assert.match(healthStandingController, /Object\.assign\(globalThis, \{ CairnHealthStandingController: CAIRN_HEALTH_STANDING_CONTROLLER \}\)/);
  assert.match(healthStandingController, /window\.CairnHealthStandingController = CAIRN_HEALTH_STANDING_CONTROLLER/);
  assert.match(healthStandingController, /CairnHealthStanding\.renderHealthStandingHtml/);
  assert.match(healthStandingController, /CairnHealthStanding\.localDateTimeInputValue/);
  assert.match(healthStandingController, /deps\.api\(`\/health\/standing\?reference_age=/);
  assert.match(healthStandingController, /deps\.api\("\/blood-pressure"/);
  assert.match(healthLearnedClient, /Object\.assign\(globalThis, \{/);
  assert.match(healthLearnedClient, /CairnHealthLearned/);
  assert.doesNotMatch(healthLearnedClient, /^const\s+LEARNED_GROUPS|^function\s+learnedItemHtml/m);
  assert.match(memoryClient, /Object\.assign\(globalThis, \{ CairnMemory: CAIRN_MEMORY \}\)/);
  assert.match(memoryClient, /window\.CairnMemory = CAIRN_MEMORY/);
  assert.doesNotMatch(memoryClient, /^const\s+MEM_KINDS|^function\s+memoryRowHtml/m);
  assert.match(meMemoryController, /Object\.assign\(globalThis, \{ CairnMeMemoryController: CAIRN_ME_MEMORY_CONTROLLER \}\)/);
  assert.match(meMemoryController, /window\.CairnMeMemoryController = CAIRN_ME_MEMORY_CONTROLLER/);
  assert.match(meMemoryController, /render/);
  assert.match(meMemoryController, /load/);
  assert.match(lifeClient, /Object\.assign\(globalThis, \{ CairnLife: CAIRN_LIFE \}\)/);
  assert.match(lifeClient, /window\.CairnLife = CAIRN_LIFE/);
  assert.doesNotMatch(lifeClient, /^const\s+LIFE_KINDS|^function\s+lifeEventHtml/m);
  assert.match(lifeFormHelpers, /Object\.assign\(globalThis, \{ CairnLifeFormHelpers: CAIRN_LIFE_FORM_HELPERS \}\)/);
  assert.match(lifeFormHelpers, /function collectLifeForm\(\)/);
  assert.match(lifeFormHelpers, /CairnLife\.lifeFieldsHtml/);
  assert.match(lifeTimelineActions, /Object\.assign\(globalThis, \{ CairnLifeTimelineActions: CAIRN_LIFE_TIMELINE_ACTIONS \}\)/);
  assert.match(lifeTimelineActions, /CairnLife\.lifeEventHtml/);
  assert.match(lifeController, /Object\.assign\(globalThis, \{ CairnLifeController: CAIRN_LIFE_CONTROLLER \}\)/);
  assert.match(lifeController, /window\.CairnLifeController = CAIRN_LIFE_CONTROLLER/);
  assert.match(lifeController, /CairnLifeTimelineActions/);
  assert.match(familyClient, /Object\.assign\(globalThis, \{ CairnFamily: CAIRN_FAMILY \}\)/);
  assert.match(familyClient, /window\.CairnFamily = CAIRN_FAMILY/);
  assert.doesNotMatch(familyClient, /^const\s+FAMILY_COLORS|^function\s+familyCardHtml/m);
  assert.match(familyControllerClient, /Object\.assign\(globalThis, \{ CairnFamilyController: CAIRN_FAMILY_CONTROLLER \}\)/);
  assert.match(familyControllerClient, /CairnFamilyController: CAIRN_FAMILY_CONTROLLER/);
  assert.match(familyControllerClient, /render,/);
  assert.match(familyControllerClient, /startEdit,/);
  assert.match(familyControllerClient, /CairnFamily\.familyCardHtml/);
  assert.match(healthDocsClient, /Object\.assign\(globalThis, \{/);
  assert.match(healthDocsClient, /CairnHealthDocs/);
  assert.match(healthRecordsClient, /Object\.assign\(globalThis, \{ CairnHealthRecords: CAIRN_HEALTH_RECORDS \}\)/);
  assert.match(healthRecordsClient, /window\.CairnHealthRecords = CAIRN_HEALTH_RECORDS/);
  assert.match(healthRecordsClient, /recordsTabHtml/);
  assert.match(healthRecordsClient, /recordsListHtml/);
  assert.doesNotMatch(healthRecordsClient, /^function\s+recordsUploadHtml|^function\s+recordsListHtml/m);
  assert.match(healthDocUploadController, /Object\.assign\(globalThis, \{ CairnHealthDocUploadController: CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER \}\)/);
  assert.match(healthDocUploadController, /window\.CairnHealthDocUploadController = CAIRN_HEALTH_DOC_UPLOAD_CONTROLLER/);
  assert.match(healthDocUploadController, /wireHealthDocUpload/);
  assert.match(healthDocUploadController, /refreshPictureAfterHealthDocUpload/);
  assert.match(meRecordsHealthDocController, /Object\.assign\(globalThis, \{ CairnHealthRecordsController: CAIRN_HEALTH_RECORDS_CONTROLLER \}\)/);
  assert.match(meRecordsHealthDocController, /window\.CairnHealthRecordsController = CAIRN_HEALTH_RECORDS_CONTROLLER/);
  assert.match(meRecordsHealthDocController, /CairnHealthDocUploadController\.wireUpload/);
  assert.match(meRecordsHealthDocController, /loadHealthDocs/);
  assert.match(healthShareController, /Object\.assign\(globalThis, \{ CairnHealthShareController: CAIRN_HEALTH_SHARE_CONTROLLER \}\)/);
  assert.match(healthShareController, /window\.CairnHealthShareController = CAIRN_HEALTH_SHARE_CONTROLLER/);
  assert.match(healthShareController, /deps\.api\("\/markers\/reconcile"/);
  assert.match(healthShareController, /deps\.cachedApi\("\/markers\/priority"/);
  assert.doesNotMatch(health, /const\s+HEALTH_KINDS|function\s+healthKindLabel|function\s+parsedDoc|function\s+markerFlagClass|function\s+markersTable|function\s+docCollapsible|function\s+healthDocInner|function\s+healthDocHtml/);
  assert.match(chatClient, /Object\.assign\(globalThis, \{ CairnChatClient: CAIRN_CHAT_CLIENT \}\)/);
  assert.match(chatClient, /window\.CairnChatClient = CAIRN_CHAT_CLIENT/);
  assert.match(chatClient, /shellHtml: chatShellHtml/);
  assert.match(chatClient, /headerActionsHtml: chatHeaderActionsHtml/);
  assert.match(chatClient, /starterChipsHtml: chatStarterChipsHtml/);
  assert.match(chatClient, /dividerHtml: chatDividerHtml/);
  assert.match(chatClient, /earlierBarHtml: chatEarlierBarHtml/);
  assert.match(chatAttachmentClient, /Object\.assign\(globalThis, \{ CairnChatAttachment: CAIRN_CHAT_ATTACHMENT \}\)/);
  assert.match(chatAttachmentClient, /compressImage: chatAttachmentCompressImage/);
  assert.match(chatAttachmentClient, /settleAfterNativePicker: chatAttachmentSettleAfterNativePicker/);
  assert.match(chatComposerFocusClient, /Object\.assign\(globalThis, \{ CairnChatComposerFocus: CAIRN_CHAT_COMPOSER_FOCUS \}\)/);
  assert.match(chatComposerFocusClient, /releaseStaleInputFocus: chatComposerReleaseStaleInputFocus/);
  assert.match(chatComposerFocusClient, /recoverInputFocusFromTap: chatComposerRecoverInputFocusFromTap/);
  assert.match(chatComposerFocusClient, /wireFocus: chatComposerWireFocus/);
  assert.match(chatComposerController, /Object\.assign\(globalThis, \{ CairnChatComposerController: CAIRN_CHAT_COMPOSER_CONTROLLER \}\)/);
  assert.match(chatComposerController, /wire: wireChatComposer/);
  assert.match(chatComposerController, /clearPasteHandler: clearChatComposerPasteHandler/);
  assert.match(chatTurnRecordsClient, /Object\.assign\(globalThis, \{ CairnChatTurnRecords: CAIRN_CHAT_TURN_RECORDS \}\)/);
  assert.match(chatTurnRecordsClient, /event: parseChatTurnEvent/);
  assert.match(chatTurnRecordsClient, /saveDraft: saveChatTurnDraft/);
  assert.match(chatLayoutClient, /Object\.assign\(globalThis, \{ CairnChatLayout: CAIRN_CHAT_LAYOUT \}\)/);
  assert.match(chatLayoutClient, /wireJump: wireChatJump/);
  assert.match(chatLayoutClient, /autosizeInput: autosizeChatInput/);
  assert.match(chatLayoutClient, /measureTop: measureChatTop/);
  assert.match(chatTurnClient, /saveChatDraft/);
  assert.match(chatTurnClient, /chatReconnect/);
  assert.match(chatTurnClient, /measureChatTop/);
  assert.match(chatHistoryClient, /function openChatHistory/);
  assert.match(chatHistoryClient, /historySessionRow/);
  assert.match(chatHistoryClient, /openChatHistory/);
  assert.match(chatHeaderControllerSource, /CairnChatClient\.headerActionsHtml\(\)/);
  assert.match(chatHeaderControllerSource, /function ensureChatHeaderBtns/);
  assert.match(chatHeaderControllerSource, /function chatFreshStart/);
  assert.match(chatHeaderControllerSource, /function settleFreshPill/);
  assert.match(settingsClient, /Object\.assign\(globalThis, \{/);
  assert.match(settingsClient, /CairnSettingsClient/);
  assert.match(settingsSurface, /\/\/ @ts-check/);
  assert.match(settingsSurface, /CairnSettingsSurface/);
  assert.match(settingsData, /\/\/ @ts-check/);
  assert.match(settingsData, /CairnSettingsData/);
  assert.match(settingsDataController, /\/\/ @ts-check/);
  assert.match(settingsDataController, /CairnSettingsDataController/);
  assert.match(settingsDataController, /render: renderSettingsData/);
  assert.match(settingsAgents, /\/\/ @ts-check/);
  assert.match(settingsAgents, /CairnSettingsAgents/);
  assert.match(settingsAgentsController, /\/\/ @ts-check/);
  assert.match(settingsAgentsController, /CairnSettingsAgentsController/);
  assert.match(settingsAgentsController, /render: renderSettingsAgents/);
  assert.match(settingsSourcesAutomationController, /\/\/ @ts-check/);
  assert.match(settingsSourcesAutomationController, /CairnSettingsSourcesAutomationController/);
  assert.match(settingsSourcesAutomationController, /renderSources: renderSettingsSources/);
  assert.match(settingsSourcesAutomationController, /renderAutomation: renderSettingsAutomation/);
  assert.match(todayCardsSource, /function exerciseCardHtml/);
  assert.match(todayCardsSource, /function cardioPlanCardHtml/);
  assert.match(todayCardsClient, /CairnTodayCards/);
  assert.match(todayScreenRuntimeSource, /CairnTodayCards\.exerciseCardHtml/);
  assert.match(todayScreenRuntimeSource, /CairnTodayCards\.cardioPlanCardHtml/);
  assert.doesNotMatch(today, /const\s+offPlan\s*=\s*!it\.fromPlan|class="ex ex-cardio-done/);
  assert.match(settingsScreen, /\/\/ @ts-check/);
  assert.match(settingsScreen, /Object\.assign\(globalThis, \{/);
  assert.match(settingsScreen, /SET_SEG/);
  assert.match(settingsScreen, /renderSettings/);
  assert.match(appJobReconnectors, /Object\.assign\(globalThis, \{ registerAppJobReconnectors \}\)/);
  assert.match(appJobReconnectors, /window\.registerAppJobReconnectors = registerAppJobReconnectors/);
  assert.doesNotMatch(appJobReconnectors, /^const\s+APP_JOB_RECONNECTORS|factory:\s*reconnect/m);
  assert.match(appMobileViewport, /Object\.assign\(globalThis, \{ installMobileViewportGuards \}\)/);
  assert.match(appMobileViewport, /window\.installMobileViewportGuards = installMobileViewportGuards/);
  assert.match(appMobileViewport, /installMobileViewportGuards/);
  assert.match(appServiceWorker, /Object\.assign\(globalThis, \{ registerServiceWorkerLifecycle \}\)/);
  assert.match(appServiceWorker, /window\.registerServiceWorkerLifecycle = registerServiceWorkerLifecycle/);
  assert.match(appDisciplinePrimer, /Object\.assign\(globalThis, \{ primeDiscipline \}\)/);
  assert.match(appDisciplinePrimer, /window\.primeDiscipline = primeDiscipline/);
  assert.match(appOnboarding, /Object\.assign\(globalThis, \{ maybeOnboard, openOnboarding \}\)/);
  assert.match(appOnboarding, /window\.maybeOnboard = maybeOnboard/);
  assert.match(appStartup, /Object\.assign\(globalThis, \{ startAppShell \}\)/);
  assert.match(appStartup, /window\.startAppShell = startAppShell/);
  assert.match(ui, /function segBar\(active, items\)[\s\S]*uiSegments\(\)\.segBar\(active, items\)/);
  assert.match(uiSegments, /function segBar\(active, items\)[\s\S]*deps\.segmentedNavHtml\(\{ active, items \}\)/);
  assert.doesNotMatch(ui, /function loadingState/);
  assert.match(uiSegments, /deps\.withViewTransition\(\(\) => Promise\.resolve\(handler\(\)\)\.then\(\(\) => \{[\s\S]*deps\.syncRouteFromState\(\)[\s\S]*return deps\.viewEnter\(\)/);
  assert.match(ui, /function exerciseExplanation\(d\)[\s\S]*CairnExerciseDetailController\.exerciseExplanation\(d, exerciseDetailDeps\(\)\)/);
  assert.match(ui, /function exerciseExplanationHtml\(d, explanation\)[\s\S]*CairnExerciseDetailController\.exerciseExplanationHtml\(d, explanation, exerciseDetailDeps\(\)\)/);
  assert.match(ui, /function replaceExerciseExplanation\(el, d, explanation\)[\s\S]*CairnExerciseDetailController\.replaceExerciseExplanation\(el, d, explanation, exerciseDetailDeps\(\)\)/);
  assert.doesNotMatch(ui, /function validExerciseExplanationPayload/);
  assert.doesNotMatch(ui, /function\s+closeDetail|function\s+openDetailFrom|function\s+mountDetail|function\s+wireDetailCommon|function\s+wireArtZoom/);
  assert.doesNotMatch(ui, /Front foot far enough forward|function\s+exerciseDetailLine|const\s+line\s*=\s*\(setup/);
  assert.doesNotMatch(ui, /let\s+saveCtx|function\s+mountSaveBar|function\s+hideSaveBar/);
  assert.match(today, /CairnTodayRailController\.fetchTodayAgenda/);
  assert.match(today, /CairnTodayRailController\.railHtml/);
  assert.match(todayDependenciesSource, /CairnTodayRailController\.runAgendaRail/);
  assert.match(today, /CairnTodayRailController\.fallbackRailHtml/);
  assert.match(todayDependenciesSource, /CairnTodayRailController\.runFallbackRail/);
  assert.match(todayRailLoadersSource, /CairnTodayAgenda\.fuelCardHtml/);
  assert.doesNotMatch(today, /window\.CairnTodayAgenda\.fuelCardHtml/);
  assert.doesNotMatch(today, /function\s+wireGenericAgendaCards|const\s+TODAY_RAIL_LOADERS|function\s+renderableAgendaBuckets/);
  assert.match(todayScreenRuntimeSource, /CairnTodayPlanSelection\.suggestedPlanDayNumber/);
  assert.doesNotMatch(today, /function\s+planDayNumberForSession|function\s+nextPlanDayNumber/);
  assert.match(today, /coachingFocusThreadHtml\(conductor\)/);
  assert.match(todayScreenRuntimeSource, /CairnTodayTraining\.exRxLineHtml/);
  assert.match(todayCompatibilityBridges, /CairnTodayProgressionController\.scheduleRxRefresh/);
  assert.match(todayCompatibilityBridges, /CairnTodayProgressionController\.invalidateTodayProgression/);
  assert.match(todayCompatibilityBridges, /CairnTodayProgressionController\.refreshAdaptedRx/);
  assert.match(todayCompatibilityBridges, /CairnTodayAddExerciseController\.setupAddExercise/);
  assert.match(todayCompatibilityBridges, /CairnTodayAddExerciseController\.appendOffPlanCard/);
  assert.doesNotMatch(today, /let _rxRefreshTimer/);
  assert.doesNotMatch(today, /function refreshAdaptedRx\(\)\s*\{[\s\S]*const rxByEx/);
  assert.doesNotMatch(today, /function resetAddForm|const datalist = todayView\.querySelector\("#exOptions"\)|const skippedBtn = \[\.\.\.todayView\.querySelectorAll/);
  assert.match(todayBriefControllerSource, /CairnTodayBrief\.briefHtml/);
  assert.match(todayBriefControllerSource, /CairnTodayBrief\.signalsText/);
  assert.match(todayBriefOverrideSource, /function dayReadOverrideOpOpts\(/);
  assert.match(todayBriefOverrideSource, /function reconnectDayReadOverride\(/);
  assert.match(todayBriefActionsSource, /function wireBriefActions\(/);
  assert.match(todayBriefActionsSource, /function handleBriefRedirect\(/);
  assert.match(todayBriefActionsSource, /function resetBriefRead\(/);
  assert.match(todayBriefControllerSource, /CairnTodayBriefOverrideClient\.dayReadOverrideOpOpts/);
  assert.match(todayBriefControllerSource, /CairnTodayBriefOverrideClient\.reconnectDayReadOverride/);
  assert.match(todayBriefControllerSource, /CairnTodayBriefActionsClient\.wireBriefActions/);
  assert.doesNotMatch(today, /const\s+BRIEF_KIND\s*=\s*\{|const\s+BRIEF_OVERRIDES\s*=\s*\[|function\s+briefRedirect|function\s+visibleBriefOverrides|function\s+agentOfflineNoticeHtml/);
  assert.match(todayBriefControllerSource, /function loadBrief\(/);
  assert.match(todayBriefControllerSource, /function upgradeBriefInPlace\(/);
  assert.match(todayBriefControllerSource, /function reshapeToday\(/);
  assert.match(todayBriefControllerSource, /function wireBrief\(/);
  assert.match(todayBriefControllerSource, /function reconnectDayReadOverride\(/);
  assert.match(todayBriefOverrideClient, /CairnTodayBriefOverrideClient: CAIRN_TODAY_BRIEF_OVERRIDE_CLIENT/);
  assert.match(todayBriefActionsClient, /CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT/);
  assert.match(todayBriefController, /CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER/);
  assert.match(todayBriefController, /loadBrief,/);
  assert.match(todayBriefController, /wireBrief,/);
  assert.match(todayBriefController, /reconnectDayReadOverride,/);
  assert.match(todayScreenRuntimeSource, /CairnTodayBriefController\.loadBrief/);
  assert.match(todayCompatibilityBridges, /CairnTodayBriefController\.wireBrief/);
  assert.match(todayCompatibilityBridges, /CairnTodayBriefController\.reconnectDayReadOverride/);
  assert.doesNotMatch(today, /function\s+paintBriefReshaping|function\s+dayReadOverrideOpOpts\([^)]*\)\s*\{[\s\S]*path:\s*"\/today-read\/reshape"|let\s+_agentOfflineDismissed/);
  assert.match(todayCompatibilityBridges, /CairnTodaySessionSuggestController\.reconnectSessionSuggest/);
  assert.match(todayCompatibilityBridges, /CairnTodaySessionSuggestController\.revealSessionComposer/);
  assert.match(todayCompatibilityBridges, /CairnTodaySessionSuggestController\.askForSession/);
  assert.doesNotMatch(today, /CairnTodaySessionSuggest\.cardHtml|CairnTodaySessionSuggest\.loadingHtml|CairnTodaySessionSuggest\.failureHtml|CairnTodaySessionSuggest\.composerHtml/);
  assert.doesNotMatch(today, /function\s+suggestItemHtml|function\s+suggestCardHtml|const\s+SESSION_VIBES|sug-card sug-loading|sug-card sug-fail|<div class="sug-composer/);
  assert.match(todayCompatibilityBridges, /CairnTodaySessionStatus\.sessionDoneCardHtml/);
  assert.match(todayDependenciesSource, /CairnTodaySessionStatus\.skipLineHtml/);
  assert.match(today, /CairnTodaySessionController\.wireSessionSurface/);
  assert.match(todayCompatibilityBridges, /CairnTodaySessionController\.wireLogRow/);
  assert.match(todayCompatibilityBridges, /CairnTodaySessionController\.wireSkips/);
  assert.doesNotMatch(today, /CairnTodaySessionStatus\.setChipHtml|CairnTodaySessionStatus\.feedbackOpenHtml|CairnTodaySessionStatus\.feedbackFormHtml|CairnTodaySessionStatus\.feedbackDoneHtml/);
  assert.doesNotMatch(today, /function\s+setsTonnage|function\s+feelScale|function\s+renderFeedback|function\s+wireDeletes|function\s+bumpProgress|function\s+refreshFinishStat|function\s+removeOffPlanCard|async function\s+skipFromCard|class="sessiondone reveal"|id="feedbackOpen"|id="feedbackDismiss"|class="skipline/);
  assert.match(todayRailLoadersSource, /CairnTodayProgramAdjustments\.extraCount/);
  assert.match(todayRailLoadersSource, /CairnTodayProgramAdjustments\.bannerHtml/);
  assert.doesNotMatch(today, /CairnTodayProgramAdjustments\.extraCount|CairnTodayProgramAdjustments\.bannerHtml/);
  assert.doesNotMatch(today, /const\s+ADJUST_GLYPH|function\s+adjustPlanRequest|class="adjust-card reveal"|class="adjust-sugs"|data-req="\$\{escAttr\(adjustPlanRequest/);
  assert.match(todayRailLoadersSource, /CairnTodayWeekAhead\.cardHtml/);
  assert.doesNotMatch(today, /CairnTodayWeekAhead\.cardHtml/);
  assert.doesNotMatch(today, /const\s+WEEK_AHEAD_GLYPH|class="weekahead reveal"|class="wa-row/);
  assert.match(today, /CairnTodayContext\.goalLineHtml/);
  assert.match(todaySideLoadersClient, /CairnTodayContext\.contextBannerHtml/);
  assert.match(todaySideLoadersClient, /CairnTodayContext\.healthFocusBannerHtml/);
  assert.match(today, /CairnTodayCompass\.build/);
  assert.doesNotMatch(today, /const\s+PACE_WORDS|const\s+fmtPace|class="stat stat-pace pace-\$\{stats\.pace_status/);
  assert.match(todayCompatibilityBridges, /CairnTodaySideLoaders\.loadContextBanner/);
  assert.match(todayCompatibilityBridges, /CairnTodaySideLoaders\.loadHealthFocusBanner/);
  assert.doesNotMatch(today, /const\s+CTX_ICONS|function\s+daysUntil|function\s+eventCountdown|function\s+isNearTermContext|function\s+ctxBannerLine|function\s+goalLineHtml/);
  assert.match(todayRailLoaders, /CairnTodayGarminReconciliation\.load/);
  assert.doesNotMatch(today, /CairnTodayGarminReconciliation\.load/);
  assert.doesNotMatch(today, /\/garmin\/unreconciled|\/garmin\/reconcile|garmin-reconcile chip-in|function\s+reconcilePromptHtml/);
  assert.match(captureProvenance, /Object\.assign\(globalThis, \{/);
  assert.match(captureProvenance, /CairnCaptureProvenance/);
  assert.match(captureProvenance, /function loadTrainingProvenance/);
  assert.match(captureReadDate, /Object\.assign\(globalThis, \{ CairnCaptureReadDate: CAIRN_CAPTURE_READ_DATE \}\)/);
  assert.match(captureReadDate, /function captureReadWeekRangeLabel/);
  assert.match(captureReadCards, /Object\.assign\(globalThis, \{ CairnCaptureReadCards: CAIRN_CAPTURE_READ_CARDS \}\)/);
  assert.match(captureReadCards, /function captureReadRenderInsightInSlot/);
  assert.match(captureReadJobs, /Object\.assign\(globalThis, \{ CairnCaptureReadJobs: CAIRN_CAPTURE_READ_JOBS \}\)/);
  assert.match(captureReadJobs, /function createCaptureReadJobsController/);
  assert.match(captureReads, /Object\.assign\(globalThis, \{/);
  assert.match(captureReads, /CairnCaptureReads/);
  assert.match(captureReads, /function createCaptureReadsController/);
  assert.match(captureVoice, /Object\.assign\(globalThis, \{/);
  assert.match(captureVoice, /CairnCaptureVoice/);
  assert.match(captureVoice, /function setupCaptureVoice/);
  assert.doesNotMatch(capture, /function loadTrainingProvenance|function provenanceLineHtml/);
  assert.doesNotMatch(capture, /function renderInsightCard|function renderWeeklyCard|function maybeGenerateInsight|function maybeGenerateWeekly/);
  assert.doesNotMatch(capture, /CAPTURE_SPEECH_REC|function setupCaptureVoice/);
  assert.match(capture, /function loadTodayReads/);
  assert.match(capture, /function reconnectInsight/);
  assert.match(progressEnergySource, /CairnUi\.jobCaptionHtml\(\{ text: "reading your trend/);
  assert.match(progressProgramControllerClient, /coachingFocusCardHtml\(focus[^)]*\{ blockLine: false, actions: true \}\)/);
  assert.doesNotMatch(progress, /coachingFocusCardHtml/);
  assert.match(meals, /function renderCoach\(\)/);
  assert.match(meals, /function renderMeals\(\)/);
  assert.match(meals, /function renderFoodJournal\(\)/);
  assert.match(mealPlannerJobsClient, /function mealPlannerJobReconnectMealPlan\(\)/);
  assert.match(mealPlannerController, /function reconnectMealPlan\(job\)/);
  assert.match(mealSwapController, /function reconnectMealSwap\(job\)/);
  assert.doesNotMatch(meals, /function reconnectRecipe\(job\)/);
  assert.match(mealRecipeController, /function reconnectRecipe\(job\)/);
  assert.match(meals, /Object\.assign\(globalThis, \{/);
  assert.match(mealSwapController, /CairnUi\.jobCaptionHtml\(\{ className: "meal-cap job-cap" \}\)/);
  assert.match(mealRecipeController, /CairnUi\.sheetChipHtml\(\{ label:/);
  assert.match(
    mealRecipeController,
    /CairnUi\.sheetChipHtml\(\{ className: "sheet-chip sheet-chip-kcal", value: meal\.kcal, label: "cal" \}\)/
  );
  assert.match(health, /ME_HEALTH_SCREEN\.renderMeStanding/);
  assert.match(meHealthScreenComposition, /loadCoachingFocus\("#cfocusStandingSlot", input\.root\)/);
  assert.match(meHealthScreenComposition, /healthMarkersDeps: \(\) => CairnMeHealthDependencies\.markers\(context\(\)\)/);
  assert.match(meHealthScreenComposition, /CairnHealthMarkersController\.load\(screen\.healthMarkersDeps\(\), token\)/);
  assert.doesNotMatch(health, /CairnHealthClient\.orderMarkersForDisplay|CairnHealthClient\.lipidGroupNoteHtml/);
  assert.doesNotMatch(health, /CairnHealthMarkers\.formatMarkerNumber|CairnHealthMarkers\.markerTrendWord|CairnHealthMarkers\.markerChartSvg|CairnHealthMarkers\.hmkRowHtml/);
  assert.match(meHealthScreenComposition, /CairnHealthPicture\.parsedReview/);
  assert.match(meHealthScreenComposition, /CairnHealthPicture\.healthHeroHtml/);
  assert.match(meHealthScreenComposition, /CairnHealthPicture\.reviewHtml/);
  assert.match(meHealthScreenComposition, /CairnHealthPictureController\.paintHealthPicture/);
  assert.match(meHealthScreenComposition, /CairnHealthPictureController\.runHealthReview/);
  assert.match(meHealthScreenComposition, /CairnHealthPictureController\.loadHealthPicture/);
  assert.match(meHealthScreenComposition, /function healthStandingDeps\(\)/);
  assert.match(meHealthScreenComposition, /CairnHealthStandingController\.render\(data, healthStandingDeps\(\)\)/);
  assert.match(meHealthScreenComposition, /CairnHealthStandingController\.openBpSheet\(healthStandingDeps\(\)\)/);
  assert.match(meHealthScreenComposition, /CairnHealthStandingController\.load\(healthStandingDeps\(\), token, refAge\)/);
  assert.match(meHealthScreenComposition, /CairnHealthStandingController\.paintReview\(healthStandingDeps\(\)\)/);
  assert.match(meHealthScreenComposition, /CairnHealthStandingController\.openRead\(healthStandingDeps\(\), opts\)/);
  assert.match(meHealthScreenComposition, /CairnHealthReadController\.paintTab\(healthReadDeps\(\)\)/);
  assert.match(meHealthScreenComposition, /CairnHealthReadController\.loadRecoverySummary\(healthReadDeps\(\), token, sel\)/);
  assert.match(meHealthScreenComposition, /CairnHealthReadController\.loadPriorityMarkers\(healthReadDeps\(\), token\)/);
  assert.match(healthReadController, /CairnHealthRead\.recoveryNoDataHtml/);
  assert.match(healthReadController, /CairnHealthRead\.recoveryHtml/);
  assert.match(healthReadController, /CairnHealthRead\.priorityMarkersSectionHtml/);
  assert.doesNotMatch(health, /Catmull-Rom|const W = 300|tipText\.textContent = pts|const rowInner = `<span class="hdot/);
  assert.doesNotMatch(health, /function\s+hstandDecade|function\s+hstandPct|function\s+hstandCompHtml|function\s+hstandRefSummaryHtml|function\s+hstandBodyCompHtml|function\s+hstandBpCardHtml/);
  assert.doesNotMatch(health, /CairnHealthStanding\.renderHealthStandingHtml|CairnHealthStanding\.localDateTimeInputValue|api\("\/blood-pressure"|api\(`\/health\/standing/);
  assert.doesNotMatch(health, /function\s+recoveryHtml|function\s+optimalPhrase|function\s+priorityMarkerHtml|hb-rline|hb-mkphrase/);
  assert.doesNotMatch(health, /const\s+H_FILE_PROMPT|const\s+HEALTH_HERO_ART|const\s+DIRECTIVE_DOMAINS|function\s+guessUploadMime|function\s+directiveHtml/);
  assert.match(healthReadController, /CairnHealthDirectiveLoader\.load\(deps\.pollToken\(\)\)/);
  assert.doesNotMatch(health, /loadDirectives\(pollToken\)/);
  assert.match(meHealthScreenComposition, /CairnMeMemoryController\.render\(screen\.meMemoryDeps\(\)\)/);
  assert.match(meHealthScreenComposition, /meMemoryDeps: \(\) => CairnMeHealthDependencies\.memory\(context\(\)\)/);
  assert.doesNotMatch(health, /CairnMemory\.memoryKindOptionsHtml|CairnMemory\.memoryRowHtml|function\s+loadMemory|function\s+startMemEdit|function\s+startMemDelete|api\("\/memory"\)|items\.map\(\(m, i\) => \{/);
  assert.match(meHealthControllerDeps, /CairnFoodNote\.noteEntryHtml/);
  assert.match(meHealthDependencies, /CairnMeHealthControllerDeps\.profile/);
  assert.match(meHealthDependencies, /CairnMeHealthDependencies/);
  assert.doesNotMatch(health, /function\s+foodIngredients|function\s+ingredientLabel|function\s+foodItemsText|function\s+foodTitleFromIngredients|function\s+foodMacroText|function\s+parsedNote|function\s+noteEntryHtml/);
  assert.match(healthClient, /CairnUi\.emptyStateHtml/);
  assert.match(records, /CairnHealthRecordsController\.render\(healthRecordsDeps\(\)\)/);
  assert.match(records, /function healthRecordsDeps\(\)/);
  assert.match(records, /CairnHealthShareController\.render\(healthShareDeps\(\)\)/);
  assert.match(records, /function healthShareDeps\(\)/);
  assert.doesNotMatch(records, /CairnHealthClient\.H_FILE_PROMPT|CairnHealthClient\.guessUploadMime/);
  assert.doesNotMatch(records, /CairnHealthRecords\.recordsTabHtml|CairnHealthRecords\.recordsListHtml|CairnHealthRecords\.recordsEmptyHtml/);
  assert.doesNotMatch(records, /CairnHealthDocs\.healthDocHtml|CairnHealthDocs\.healthDocInner/);
  assert.doesNotMatch(records, /function openDoctorReportTab|api\("\/markers\/reconcile"|cachedApi\("\/markers\/priority"|downloadFile\(withToken\("\/api\/health-export"\)\)/);
  assert.doesNotMatch(records, /<div class="hupload"|docs\.map\(\(d, i\) => healthDocHtml|(^|[^.])healthDocHtml\(|(^|[^.])healthDocInner\(/m);
  assert.doesNotMatch(records, /function\s+loadDirectives|function\s+deriveDirectives|api\("\/directives"\)|CairnHealthDirectives\.directivesSectionHtml/);
  assert.doesNotMatch(records, /const\s+H_FILE_PROMPT|const\s+HEALTH_HERO_ART|const\s+DIRECTIVE_DOMAINS|function\s+guessUploadMime|function\s+directiveHtml|CairnHealthClient\.directiveHtml|CairnHealthClient\.DIRECTIVE_DOMAINS/);
  assert.doesNotMatch(records, /let\s+dIdx|const\s+researchNudge|hb-research-nudge[\s\S]*turn on research in Settings/);
  assert.doesNotMatch(records, /const\s+LEARNED_GROUPS|function\s+learnedItemHtml/);
  assert.match(records, /learnedTimelineHtml\(data\)/);
  assert.doesNotMatch(records, /const\s+LIFE_KINDS|function\s+lifeEventHtml|function\s+lifeFieldsHtml|function\s+loadLifeEvents|function\s+startLifeEdit|CairnLife\.lifeEventHtml|CairnLife\.lifeFieldsHtml/);
  assert.match(records, /function lifeControllerDeps\(\)/);
  assert.match(records, /CairnLifeController\.render\(lifeControllerDeps\(\)\)/);
  assert.match(lifeFormHelpers, /CairnLife\.lifeFieldsHtml/);
  assert.match(lifeTimelineActions, /CairnLife\.lifeEventHtml/);
  assert.match(lifeFormHelpers, /api\("\/context-events"/);
  assert.match(lifeTimelineActions, /api\(`\/context-events\/\$\{id\}`/);
  assert.doesNotMatch(lifeController, /CairnLife\.lifeEventHtml|CairnLife\.lifeFieldsHtml|api\("\/context-events"|api\(`\/context-events\/\$\{id\}`/);
  assert.doesNotMatch(records, /const\s+FAMILY_COLORS|function\s+familyCardHtml|function\s+familySwatches|CairnFamily\.familyCardHtml|CairnFamily\.familySwatches/);
  assert.match(records, /function familyControllerDeps\(\)/);
  assert.match(records, /CairnFamilyController\.render\(familyControllerDeps\(\)\)/);
  assert.match(familyControllerSource, /CairnFamily\.familyCardHtml/);
  assert.match(familyControllerSource, /CairnFamily\.familySwatches/);
  assert.match(familyControllerClient, /CairnFamily\.familyCardHtml/);
  assert.match(familyControllerClient, /CairnFamily\.familySwatches/);
  assert.match(chatHistoryClient, /CairnChatClient\.historySessionRow/);
  assert.match(chatHistoryClient, /CairnChatClient\.historyHitRow/);
  assert.match(chatHeaderController, /CairnChatClient\.headerActionsHtml\(\)/);
  assert.match(chatHeaderController, /function ensureChatHeaderBtns/);
  assert.match(chatHeaderController, /function chatFreshStart/);
  assert.match(chatHeaderController, /function settleFreshPill/);
  assert.match(chat, /CairnChatClient\.shellHtml\(\)/);
  assert.match(chatStarterChipsClient, /CairnChatClient\.starterChipsHtml\(\)/);
  assert.match(chatEarlierHistoryClient, /function expandChatEarlierHistory\(log, bar, block\)/);
  assert.match(chat, /CairnChatStarterChips/);
  assert.match(chat, /CairnChatEarlierHistory/);
  assert.match(chatFuelContextClient, /CairnChatClient\.fuelHtml\(d\)/);
  assert.match(chatFuelContextClient, /CairnChatClient\.wantsFuelSurface/);
  assert.doesNotMatch(chat, /CairnChatClient\.starterChipsHtml\(\)|CairnChatClient\.fuelHtml\(d\)/);
  assert.match(chat, /CairnChatComposerController\.wire/);
  assert.match(chatComposerController, /CairnChatAttachment\.compressImage\(f\)/);
  assert.match(chatComposerController, /CairnChatAttachment\.resetFocusAfterNativePicker/);
  assert.match(chatComposerController, /CairnChatComposerFocus\.wireFocus/);
  assert.match(chatMessageClient, /function appendMsg\(/);
  assert.match(chatMessageClient, /function chatMessageDayISO\(ts\)/);
  assert.match(chatMessageClient, /function chatDivider\(iso\)/);
  assert.match(chatMessageClient, /CairnChatClient\.dividerHtml\(iso, dateLabel\(iso\)\)/);
  assert.match(chatMessageClient, /Object\.assign\(globalThis, \{/);
  assert.doesNotMatch(chat, /function\s+compressChatImage|CHAT_UPLOAD_IMAGE_MAX_BYTES|CHAT_UPLOAD_IMAGE_EDGE_STEPS|CHAT_UPLOAD_IMAGE_QUALITY_STEPS/);
  assert.doesNotMatch(chat, /const\s+CHAT_STARTERS|<div class="chatview"|id="hdrHistory"|id="chatJump"|class="chat-earlierbar"/);
  assert.doesNotMatch(chat, /\bfunction\s+appendMsg\b|\bconst\s+COPY_ICON\b|\bfunction\s+copyText\b/);
  assert.doesNotMatch(chat, /CairnChatAttachment\.resetFocusAfterNativePicker|CairnChatComposerFocus\.wireFocus/);
  assert.doesNotMatch(chat, /function\s+chatComposerReleaseStaleInputFocus|function\s+chatComposerRecoverInputFocusFromTap/);
  assert.match(chat, /Durable chat turn helpers live in \/js\/chat-turn-client\.js/);
  assert.match(chat, /Static chat message rendering lives in \/js\/chat-message-client\.js/);
  assert.match(chat, /Chat history\/search helpers live in \/js\/chat-history-client\.js/);
  assert.doesNotMatch(chat, /\bconst\s+CHAT_DRAFT_KEY\b|\blet\s+chatStream\b|\bconst\s+chatPendingBubbles\b/);
  assert.doesNotMatch(chat, /\bfunction\s+chatTeardownMonitor\b|\bfunction\s+chatReconnect\b|\bfunction\s+measureChatTop\b/);
  assert.doesNotMatch(chat, /\bfunction\s+histWhen\b|\bfunction\s+histSessionRow\b|\bfunction\s+histHitRow\b|\bfunction\s+openChatHistory\b/);
  assert.match(planEnduranceClient, /CairnUi\.jobCaptionHtml\(\)/);
  assert.match(chat, /Plan editor orchestration lives in \/js\/plan-editor-controller\.js; Plan Endurance lives in \/js\/plan-endurance-client\.js/);
  assert.doesNotMatch(chat, /CairnPlanEndurance\.rampHtml|CairnPlanEndurance\.presets|CairnPlanEndurance\.draftCardHtml/);
  assert.doesNotMatch(chat, /function\s+renderPlanEndurance|function\s+paintPlanEndurance|function\s+draftEnduranceRuns|function\s+enduranceProposalOpOpts|function\s+renderEnduranceDraftResult/);
  assert.doesNotMatch(chat, /const\s+ENDURANCE_PHASES|function\s+enduranceRampHtml|function\s+endurancePresets|function\s+endDraftCardHtml/);
  assert.doesNotMatch(chat, /CairnPlanEditor\.dayModelFromPlan|CairnPlanEditor\.calendarFooterHtml|CairnPlanEditor\.progDayHtml|CairnPlanEditor\.pdayHtml/);
  assert.doesNotMatch(chat, /function\s+renderPlanEditor|function\s+progDayHtml|function\s+pitemHtml|function\s+pdayHtml|const\s+blankStrength|const\s+blankCardio/);
  assert.match(settingsScreen, /CairnSettingsClient\.updateCardHtml/);
  assert.match(appOnboarding, /CairnUi\.jobCaptionHtml\(\)/);
  assert.match(boot, /startAppShell\(\)/);
  assert.doesNotMatch(boot, /function\s+renderSettings/);
  assert.doesNotMatch(boot, /CairnSettingsClient/);
  assert.doesNotMatch(boot, /registerJobReconnector\("session_suggest"/);
  assert.doesNotMatch(boot, /function\s+switchTab\(tab/);
  assert.doesNotMatch(boot, /function\s+activateTab\(name/);
  assert.doesNotMatch(boot, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.doesNotMatch(boot, /function\s+primeDiscipline/);
  assert.doesNotMatch(boot, /function\s+maybeOnboard/);
  assert.doesNotMatch(boot, /function\s+openOnboarding/);
  assert.doesNotMatch(boot, /function\s+downloadFile/);
  assert.doesNotMatch(boot, /window\.addEventListener\("popstate"/);
  // Every shipped bundle must be precached by the service worker (individual
  // modules are concatenated into these bundles; see the dedicated sw core-assets test).
  for (const bundle of BUNDLES) {
    const bundleUrl = `/${bundle.output.replace(/^public\//, "")}`;
    assert.ok(sw.includes(`"${bundleUrl}"`), `${bundleUrl} must be precached by public/sw.js`);
  }
  assert.match(dockerfile, /ENV NPM_CONFIG_AUDIT=false[\s\S]*NPM_CONFIG_UPDATE_NOTIFIER=false/);
  assert.match(dockerfile, /COPY package\*\.json tsconfig\.json tsconfig\.client\.build\.json \.\//);
  assert.match(dockerfile, /RUN --mount=type=cache,target=\/root\/\.npm,sharing=locked npm ci/);
  assert.match(dockerfile, /COPY scripts\/build-client\.mjs \.\/scripts\/build-client\.mjs/);
  // The builder deliberately runs `npm run build` WITHOUT a tsbuildcache mount:
  // a persisted .tsbuildinfo carried across builds desyncs from the fresh dist/
  // image layer and ships a PARTIAL dist/ (see commit f0838ee6). Lock that in.
  assert.match(dockerfile, /\nRUN npm run build\n/);
  assert.doesNotMatch(dockerfile, /--mount=type=cache,target=\/app\/\.tsbuildcache[^\n]*npm run build/);
  assert.match(dockerfile, /COPY --from=builder \/app\/public\/js \.\/public\/js/);
});

test("public docker run quickstarts bind loopback by default", () => {
  const blocks = ["README.md", "docs/QUICKSTART.md", "docs/SHARING.md"].flatMap((file) =>
    [...read(file).matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => ({ file, text: m[1] }))
  );
  const unsafe = blocks.filter(
    (b) =>
      /\bdocker\s+run\b/.test(b.text) &&
      /(^|\s)-p\s+8787:8787(\s|\\|$)/.test(b.text) &&
      !/(^|\s)-p\s+127\.0\.0\.1:8787:8787(\s|\\|$)/.test(b.text)
  );
  assert.deepEqual(unsafe, []);
});

test("GitHub Actions workflows pin external actions to commit SHAs", () => {
  const pkg = JSON.parse(read("package.json"));
  const checker = read("scripts/check-action-pins.mjs");
  const verifyRunner = read("scripts/run-verify.mjs");
  assert.equal(pkg.scripts.verify, "node scripts/run-verify.mjs");
  assert.match(verifyRunner, /npm",\s*"run",\s*"actions:check"/);
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

test("the recovery-week instruction prefix is one contract across client and server", () => {
  // The client sends the full instruction with /program/evolve; the server detects a
  // waiting draft (pendingRecoveryDraft) and retires stale ones by this PREFIX. If
  // either side rewords its literal, the button/review-link state machine silently
  // dies — pin them to each other.
  const server = read("src/repo/profile.ts");
  const client = read("src/client/progress-program-controller.ts");
  const m = server.match(/RECOVERY_WEEK_INSTRUCTION_PREFIX = "([^"]+)"/);
  assert.ok(m, "profile.ts exports RECOVERY_WEEK_INSTRUCTION_PREFIX");
  const prefix = m[1];
  const c = client.match(/const RECOVERY_WEEK_INSTRUCTION =\s*\n?\s*"([^"]+)"/);
  assert.ok(c, "the client declares RECOVERY_WEEK_INSTRUCTION");
  assert.ok(c[1].startsWith(prefix), `the client instruction must start with the server prefix ("${prefix}")`);
});
