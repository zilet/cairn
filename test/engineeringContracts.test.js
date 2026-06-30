// Cheap engineering-practice contracts for seams that used to drift:
// background job kind strings, Settings route metadata, route docs, and launch docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_JOB_KINDS } from "../dist/agentJobKinds.js";
import { CLIENT_API_CONTRACT_PATHS, CLIENT_API_UNKNOWN_WAIVERS } from "../dist/contracts/client.js";
import { listRoutableTasks, ROUTABLE_TASKS } from "../dist/repo/settings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

function stringMatches(src, re) {
  return [...src.matchAll(re)].map((m) => m[1]);
}

function escapeRegExp(src) {
  return src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contractPatternToRegExp(pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/:[A-Za-z0-9_]+/g, "[^/]+")}$`);
}

function normalizeApiCallPath(raw) {
  const withoutTemplateExpressions = raw.replace(/\$\{[^}]*\}/g, ":param");
  const withoutQuery = withoutTemplateExpressions.split("?")[0].trim();
  if (!withoutQuery.startsWith("/")) return null;
  return withoutQuery.endsWith("/") ? `${withoutQuery}:param` : withoutQuery;
}

function publicApiCallPaths() {
  return readdirSync(path.join(root, "public/js"))
    .filter((file) => file.endsWith(".js"))
    .flatMap((file) => {
      const src = read(`public/js/${file}`);
      return [...src.matchAll(/\bapi\(\s*(["'`])([\s\S]*?)\1/g)]
        .map((match) => normalizeApiCallPath(match[2]))
        .filter(Boolean)
        .map((apiPath) => ({ file, path: apiPath }));
    });
}

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
  assert.match(operatorTools, /ROUTABLE_TASK_LIST\s*=\s*repo\.ROUTABLE_TASKS\.join/);
  assert.match(operatorTools, /AGENT_JOB_KIND_LIST\s*=\s*AGENT_JOB_KINDS\.join/);
  assert.match(operatorTools, /get_settings[\s\S]*route_tasks:\s*repo\.listRoutableTasks\(\)/);
  assert.match(operatorTools, /set_settings[\s\S]*route_tasks:\s*repo\.listRoutableTasks\(\)/);
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
  assert.equal(tools.length, 176, "tool count should stay stable while modularizing MCP");
  assert.equal(new Set(tools).size, tools.length, "MCP tool names must be unique across modules");
  assert.doesNotMatch(mcp, /server\.tool\(/, "src/mcp.ts should stay a registry, not a tool-definition file");
  assert.doesNotMatch(mcp, /server\.tool\("get_chat_history"/);
  assert.doesNotMatch(mcp, /server\.tool\("reset_chat"/);
  assert.match(chatTools, /server\.tool\(\s*"get_chat_history"/);
  assert.match(chatTools, /server\.tool\(\s*"reset_chat"/);
  assert.match(connectedBrainTools, /server\.tool\(\s*"get_health_markers"/);
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
  assert.match(connectedBrainRoutes, /repo\.getEvidence\(\{\s*topic,\s*marker\s*\}\)/);
  assert.match(connectedBrainRoutes, /runResearch/);
  assert.match(connectedBrainRoutes, /addMemory\(text,\s*"insight",\s*"insight-feedback"\)/);
  assert.match(api, /api\.use\("\/",\s*dayCoachRouter\)/);
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/(?:today-read(?:\/|")|session-suggest"|week-ahead")/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.get\("\/today-read"/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.post\("\/today-read\/reshape"/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.post\("\/session-suggest"/);
  assert.match(dayCoachRoutes, /dayCoachRouter\.get\("\/week-ahead"/);
  assert.match(dayCoachRoutes, /recordDayReadSuggestion/);
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
  assert.match(programRoutes, /supersedeAutoProgressionDrafts/);
  assert.match(api, /api\.use\("\/",\s*trainingLogRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:sessions(?:\/|")|last-set"|sets(?:\/|")|progress(?:\/|")|activities(?:\/|")|recent-training"|stats"|endurance-prs"|run-compliance"|cardio"|endurance-goal"|volume"|calendar")/
  );
  assert.match(trainingLogRoutes, /trainingLogRouter\.get\("\/sessions"/);
  assert.match(trainingLogRoutes, /req\.query\.date[\s\S]*repo\.getSessionByDate/);
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
  const settingsScreen = read("public/js/settings-screen.js");
  const index = read("public/index.html");
  assert.match(source, /function\s+settingsPruneRoutes/);
  assert.match(source, /type SettingsRouteTask = \[string, string\]/);
  assert.match(helper, /function\s+settingsPruneRoutes/);
  assert.doesNotMatch(helper, /\bescHtml\b|\bescAttr\b/);
  assert.match(settingsScreen, /settingsPruneRoutes\(wm\.routes,\s*routeTasks,\s*enabledAgents\)/);
  assert.ok(
    index.indexOf("/js/settings-routes.js") > -1 &&
      index.indexOf("/js/settings-routes.js") < index.indexOf("/js/settings-screen.js"),
    "settings-routes.js must load before settings-screen.js"
  );
});

test("app shell privacy contract avoids remote fonts and blanket inline scripts", () => {
  const index = read("public/index.html");
  const styles = read("public/styles.css");
  const server = read("src/server.ts");
  const design = read("docs/DESIGN.md");
  const publicJs = ["public/js/02-ui.js", "public/js/save-bar.js", "public/js/09-plan-chat.js"].map(read).join("\n");
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
  const ui = read("public/js/02-ui.js");
  assert.match(ui, /function\s+isViewTransitionAbort/);
  assert.match(ui, /name\s*===\s*"AbortError"/);
  assert.match(ui, /name\s*===\s*"InvalidStateError"[\s\S]*\/transition\/i\.test/);
  assert.match(ui, /\.catch\(\(err\)\s*=>\s*\{\s*if\s*\(!isViewTransitionAbort\(err\)\)\s*throw\s+err;\s*\}\)/);
  assert.match(ui, /\.finally\(\(\)\s*=>\s*\{\s*_vtActive\s*=\s*false;\s*\}\)/);
});

test("service worker caches core assets strictly and optional assets best-effort", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /const\s+CORE_ASSETS\s*=/);
  assert.match(sw, /const\s+OPTIONAL_ASSETS\s*=/);
  assert.match(sw, /addAll\(CORE_ASSETS\)/);
  assert.match(sw, /OPTIONAL_ASSETS\.map[\s\S]*catch\(\(\)\s*=>\s*null\)/);
  assert.match(sw, /"\/js\/date-utils\.js"/);
  assert.match(sw, /"\/js\/html-utils\.js"/);
  assert.match(sw, /"\/js\/markdown-client\.js"/);
  assert.match(sw, /"\/js\/ui-components\.js"/);
  assert.match(sw, /"\/js\/format-utils\.js"/);
  assert.match(sw, /"\/js\/api-client\.js"/);
  assert.match(sw, /"\/js\/app-download\.js"/);
  assert.match(sw, /"\/js\/app-sw-recovery\.js"/);
  assert.match(sw, /"\/js\/pwa-install-coach\.js"/);
  assert.match(sw, /"\/js\/rest-timer\.js"/);
  assert.match(sw, /"\/js\/coaching-focus-client\.js"/);
  assert.match(sw, /"\/js\/today-activity-client\.js"/);
  assert.match(sw, /"\/js\/save-bar\.js"/);
  assert.match(sw, /"\/js\/swr-cache\.js"/);
  assert.match(sw, /"\/js\/today-agenda-client\.js"/);
  assert.match(sw, /"\/js\/today-training-client\.js"/);
  assert.match(sw, /"\/js\/today-brief-client\.js"/);
  assert.match(sw, /"\/js\/cardio-plan-client\.js"/);
  assert.match(sw, /"\/js\/cardio-sync-client\.js"/);
  assert.match(sw, /"\/js\/proposal-client\.js"/);
  assert.match(sw, /"\/js\/today-session-suggest-client\.js"/);
  assert.match(sw, /"\/js\/today-session-status-client\.js"/);
  assert.match(sw, /"\/js\/meal-plan-client\.js"/);
  assert.match(sw, /"\/js\/progress-endurance-client\.js"/);
  assert.match(sw, /"\/js\/progress-components-client\.js"/);
  assert.match(sw, /"\/js\/progress-chart-client\.js"/);
  assert.match(sw, /"\/js\/progress-history-client\.js"/);
  assert.match(sw, /"\/js\/progress-run-plan-client\.js"/);
  assert.match(sw, /"\/js\/progress-volume-client\.js"/);
  assert.match(sw, /"\/js\/progress-energy-client\.js"/);
  assert.match(sw, /"\/js\/progress-calendar-client\.js"/);
  assert.match(sw, /"\/js\/progress-muscle-trajectory-client\.js"/);
  assert.match(sw, /"\/js\/progress-dexa-targeting-client\.js"/);
  assert.match(sw, /"\/js\/progress-performance-client\.js"/);
  assert.match(sw, /"\/js\/progress-program-adjustments-client\.js"/);
  assert.match(sw, /"\/js\/progress-test-week-client\.js"/);
  assert.match(sw, /"\/js\/progress-program-summary-client\.js"/);
  assert.match(sw, /"\/js\/progress-program-block-client\.js"/);
  assert.match(sw, /"\/js\/health-docs-client\.js"/);
  assert.match(sw, /"\/js\/day-fuel-client\.js"/);
  assert.match(sw, /"\/js\/food-note-client\.js"/);
  assert.match(sw, /"\/js\/health-client\.js"/);
  assert.match(sw, /"\/js\/health-read-client\.js"/);
  assert.match(sw, /"\/js\/health-standing-client\.js"/);
  assert.match(sw, /"\/js\/health-learned-client\.js"/);
  assert.match(sw, /"\/js\/health-records-client\.js"/);
  assert.match(sw, /"\/js\/memory-client\.js"/);
  assert.match(sw, /"\/js\/life-client\.js"/);
  assert.match(sw, /"\/js\/family-client\.js"/);
  assert.match(sw, /"\/js\/chat-client\.js"/);
  assert.match(sw, /"\/js\/plan-endurance-client\.js"/);
  assert.match(sw, /"\/js\/plan-editor-client\.js"/);
  assert.match(sw, /"\/js\/day-fuel-client\.js"/);
  assert.match(sw, /"\/js\/settings-client\.js"/);
  assert.match(sw, /"\/js\/settings-screen\.js"/);
  assert.match(sw, /"\/js\/route-state\.js"/);
  assert.match(sw, /"\/js\/app-router\.js"/);
  assert.match(sw, /"\/js\/app-route-sync\.js"/);
  assert.match(sw, /"\/js\/app-render-dispatch\.js"/);
  assert.match(sw, /"\/js\/app-tabs\.js"/);
  assert.match(sw, /"\/js\/app-job-reconnectors\.js"/);
  assert.match(sw, /"\/js\/app-mobile-viewport\.js"/);
  assert.match(sw, /"\/js\/app-service-worker\.js"/);
  assert.match(sw, /"\/js\/app-discipline-primer\.js"/);
  assert.match(sw, /"\/js\/app-onboarding\.js"/);
  assert.match(sw, /"\/js\/app-startup\.js"/);
});

test("PWA deep links return the app shell without capturing API or MCP", () => {
  const server = read("src/server.ts");
  const sw = read("public/sw.js");
  assert.match(server, /app\.use\("\/api",\s*api\)/);
  assert.match(server, /app\.post\("\/mcp",\s*handleMcpPost\)/);
  assert.match(server, /app\.get\(\/\^\\\/app/);
  assert.match(server, /sendFile\(path\.join\(__dirname,\s*"\.\.",\s*"public",\s*"index\.html"\)\)/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api"\)\s*\|\|\s*url\.pathname\.startsWith\("\/mcp"\)/);
  assert.match(sw, /e\.request\.mode\s*===\s*"navigate"[\s\S]*caches\.match\("\/index\.html"\)/);
});

test("PWA route state is wired through boot, tabs, nested screens, and date-aware fuel", () => {
  const index = read("public/index.html");
  const appStartup = read("public/js/app-startup.js");
  const appRouteSync = read("public/js/app-route-sync.js");
  const appRenderDispatch = read("public/js/app-render-dispatch.js");
  const appTabs = read("public/js/app-tabs.js");
  const appRouter = read("public/js/app-router.js");
  const ui = read("public/js/02-ui.js");
  const meals = read("public/js/06-coach-meals.js");
  const health = read("public/js/07-me-health.js");
  const records = read("public/js/08-me-records.js");
  const chat = read("public/js/09-plan-chat.js");
  const chatClient = read("public/js/chat-client.js");
  assert.ok(
    index.indexOf("/js/route-state.js") > -1 && index.indexOf("/js/route-state.js") < index.indexOf("/js/10-boot.js"),
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
  assert.match(ui, /syncRouteFromState\(\)/, "shared UI events should notify route sync");
  assert.match(meals, /api\("\/nutrition\/day"\s*\+\s*qs\)/, "Plan Food must fetch the routed local day");
  assert.match(health, /setHealthSegActive\(b\.dataset\.hseg\)[\s\S]*syncRouteFromState\(\)/);
  assert.match(records, /state\.pendingHealthDocId[\s\S]*scrollIntoView/);
  assert.match(appRouter, /state\.pendingChatSession\s*=\s*route\.session\s*\|\|\s*null/);
  assert.match(chatClient, /session\.session_id\s*\|\|\s*session\.archived_at/);
  assert.match(chatClient, /hit\.session_id\s*\|\|\s*hit\.archived_at/);
  assert.match(chat, /openChatHistory\(opts\s*=\s*\{\}\)/);
  assert.match(chat, /state\.pendingChatSession\s*=\s*sessionId[\s\S]*syncRouteFromState\(\)/);
  assert.match(chat, /api\("\/chat\/sessions\/"\s*\+\s*encodeURIComponent\(sessionId\)\)/);
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
  const allPatterns = [...contractPatterns, ...waiverPatterns].map(contractPatternToRegExp);

  assert.deepEqual(new Set(contractPatterns).size, contractPatterns.length, "contract API patterns must be unique");
  assert.deepEqual(new Set(waiverPatterns).size, waiverPatterns.length, "contract waiver patterns must be unique");
  assert.ok(contractPatterns.includes("/learnings"), "/learnings should be covered by the typed memory contract");
  assert.ok(contractPatterns.includes("/memory/:id/supersede"), "/memory/:id/supersede should be covered by the typed memory contract");
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

  const uncovered = publicApiCallPaths()
    .filter((call) => !allPatterns.some((re) => re.test(call.path)))
    .map((call) => `${call.file}: ${call.path}`)
    .sort();
  assert.deepEqual(uncovered, []);
});

test("frontend TypeScript contract gate is dependency-light and backed by server payloads", () => {
  const pkg = JSON.parse(read("package.json"));
  const clientTsconfig = read("tsconfig.client.json");
  const clientBuildTsconfig = read("tsconfig.client.build.json");
  const clientGlobals = read("src/contracts/client-globals.d.ts");
  const contracts = read("src/contracts/client.ts");
  const apiContracts = read("src/contracts/client-api.ts");
  const apiCoverage = read("src/contracts/client-api-coverage.ts");
  const compat = read("src/contracts/client-compat.ts");
  const dateUtilsSource = read("src/client/date-utils.ts");
  const htmlUtilsSource = read("src/client/html-utils.ts");
  const markdownSource = read("src/client/markdown-client.ts");
  const uiComponentsSource = read("src/client/ui-components.ts");
  const formatUtilsSource = read("src/client/format-utils.ts");
  const apiClientSource = read("src/client/api-client.ts");
  const appDownloadSource = read("src/client/app/download.ts");
  const appSwRecoverySource = read("src/client/app/sw-recovery.ts");
  const coreStateSource = read("src/client/app/state.ts");
  const pwaInstallSource = read("src/client/pwa-install-coach.ts");
  const restTimerSource = read("src/client/rest-timer.ts");
  const coachingFocusSource = read("src/client/coaching-focus-client.ts");
  const todayActivitySource = read("src/client/today-activity-client.ts");
  const saveBarSource = read("src/client/save-bar.ts");
  const swrCacheSource = read("src/client/swr-cache.ts");
  const todayAgendaSource = read("src/client/today-agenda-client.ts");
  const todayTrainingSource = read("src/client/today-training-client.ts");
  const todayBriefSource = read("src/client/today-brief-client.ts");
  const cardioPlanSource = read("src/client/cardio-plan-client.ts");
  const cardioSyncSource = read("src/client/cardio-sync-client.ts");
  const proposalSource = read("src/client/proposal-client.ts");
  const todaySessionSuggestSource = read("src/client/today-session-suggest-client.ts");
  const todaySessionStatusSource = read("src/client/today-session-status-client.ts");
  const progressEnduranceSource = read("src/client/progress-endurance-client.ts");
  const progressComponentsSource = read("src/client/progress-components-client.ts");
  const progressChartSource = read("src/client/progress-chart-client.ts");
  const progressHistorySource = read("src/client/progress-history-client.ts");
  const progressRunPlanSource = read("src/client/progress-run-plan-client.ts");
  const progressVolumeSource = read("src/client/progress-volume-client.ts");
  const progressEnergySource = read("src/client/progress-energy-client.ts");
  const progressCalendarSource = read("src/client/progress-calendar-client.ts");
  const progressMuscleTrajectorySource = read("src/client/progress-muscle-trajectory-client.ts");
  const progressDexaTargetingSource = read("src/client/progress-dexa-targeting-client.ts");
  const progressPerformanceSource = read("src/client/progress-performance-client.ts");
  const progressProgramAdjustmentsSource = read("src/client/progress-program-adjustments-client.ts");
  const progressTestWeekSource = read("src/client/progress-test-week-client.ts");
  const progressProgramSummarySource = read("src/client/progress-program-summary-client.ts");
  const progressProgramBlockSource = read("src/client/progress-program-block-client.ts");
  const captureSource = read("src/client/capture.ts");
  const settingsRoutesSource = read("src/client/settings-routes.ts");
  const settingsClientSource = read("src/client/settings-client.ts");
  const settingsScreenSource = read("src/client/settings-screen.ts");
  const chatClientSource = read("src/client/chat-client.ts");
  const planEnduranceSource = read("src/client/plan-endurance-client.ts");
  const planEditorSource = read("src/client/plan-editor-client.ts");
  const dayFuelSource = read("src/client/day-fuel-client.ts");
  const mealPlanSource = read("src/client/meal-plan-client.ts");
  const foodNoteSource = read("src/client/food-note-client.ts");
  const healthClientSource = read("src/client/health-client.ts");
  const healthReadSource = read("src/client/health-read-client.ts");
  const healthStandingSource = read("src/client/health-standing-client.ts");
  const healthPictureSource = read("src/client/health-picture-client.ts");
  const healthMarkersSource = read("src/client/health-markers-client.ts");
  const healthDirectivesSource = read("src/client/health-directives-client.ts");
  const healthLearnedSource = read("src/client/health-learned-client.ts");
  const healthRecordsSource = read("src/client/health-records-client.ts");
  const memorySource = read("src/client/memory-client.ts");
  const lifeSource = read("src/client/life-client.ts");
  const familySource = read("src/client/family-client.ts");
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
  const formatUtils = read("public/js/format-utils.js");
  const apiClient = read("public/js/api-client.js");
  const appDownload = read("public/js/app-download.js");
  const appSwRecovery = read("public/js/app-sw-recovery.js");
  const coreState = read("public/js/01-core.js");
  const pwaInstall = read("public/js/pwa-install-coach.js");
  const restTimer = read("public/js/rest-timer.js");
  const coachingFocusClient = read("public/js/coaching-focus-client.js");
  const todayActivityClient = read("public/js/today-activity-client.js");
  const saveBar = read("public/js/save-bar.js");
  const swrCache = read("public/js/swr-cache.js");
  const todayAgendaClient = read("public/js/today-agenda-client.js");
  const todayTrainingClient = read("public/js/today-training-client.js");
  const todayBriefClient = read("public/js/today-brief-client.js");
  const cardioPlanClient = read("public/js/cardio-plan-client.js");
  const cardioSyncClient = read("public/js/cardio-sync-client.js");
  const proposalClient = read("public/js/proposal-client.js");
  const todaySessionSuggestClient = read("public/js/today-session-suggest-client.js");
  const todaySessionStatusClient = read("public/js/today-session-status-client.js");
  const progressEnduranceClient = read("public/js/progress-endurance-client.js");
  const progressComponentsClient = read("public/js/progress-components-client.js");
  const progressChartClient = read("public/js/progress-chart-client.js");
  const progressHistoryClient = read("public/js/progress-history-client.js");
  const progressRunPlanClient = read("public/js/progress-run-plan-client.js");
  const progressVolumeClient = read("public/js/progress-volume-client.js");
  const progressEnergyClient = read("public/js/progress-energy-client.js");
  const progressCalendarClient = read("public/js/progress-calendar-client.js");
  const progressMuscleTrajectoryClient = read("public/js/progress-muscle-trajectory-client.js");
  const progressDexaTargetingClient = read("public/js/progress-dexa-targeting-client.js");
  const progressPerformanceClient = read("public/js/progress-performance-client.js");
  const progressProgramAdjustmentsClient = read("public/js/progress-program-adjustments-client.js");
  const progressTestWeekClient = read("public/js/progress-test-week-client.js");
  const progressProgramSummaryClient = read("public/js/progress-program-summary-client.js");
  const progressProgramBlockClient = read("public/js/progress-program-block-client.js");
  const capture = read("public/js/04-capture.js");
  const planEnduranceClient = read("public/js/plan-endurance-client.js");
  const planEditorClient = read("public/js/plan-editor-client.js");
  const dayFuelClient = read("public/js/day-fuel-client.js");
  const mealPlanClient = read("public/js/meal-plan-client.js");
  const foodNoteClient = read("public/js/food-note-client.js");
  const healthClient = read("public/js/health-client.js");
  const healthReadClient = read("public/js/health-read-client.js");
  const healthStandingClient = read("public/js/health-standing-client.js");
  const healthPictureClient = read("public/js/health-picture-client.js");
  const healthMarkersClient = read("public/js/health-markers-client.js");
  const healthDirectivesClient = read("public/js/health-directives-client.js");
  const healthLearnedClient = read("public/js/health-learned-client.js");
  const healthRecordsClient = read("public/js/health-records-client.js");
  const memoryClient = read("public/js/memory-client.js");
  const lifeClient = read("public/js/life-client.js");
  const familyClient = read("public/js/family-client.js");
  const healthDocsClient = read("public/js/health-docs-client.js");
  const chatClient = read("public/js/chat-client.js");
  const settingsClient = read("public/js/settings-client.js");
  const settingsScreen = read("public/js/settings-screen.js");
  const publicScriptCheck = read("scripts/check-public-scripts.mjs");
  const clientBuild = read("scripts/build-client.mjs");
  const clientBuildCheck = read("scripts/check-client-build-output.mjs");
  const verifyRunner = read("scripts/run-verify.mjs");
  const ui = read("public/js/02-ui.js");
  const today = read("public/js/03-today.js");
  const progress = read("public/js/05-progress.js");
  const meals = read("public/js/06-coach-meals.js");
  const health = read("public/js/07-me-health.js");
  const records = read("public/js/08-me-records.js");
  const chat = read("public/js/09-plan-chat.js");
  const boot = read("public/js/10-boot.js");
  const sw = read("public/sw.js");
  const index = read("public/index.html");
  const dockerfile = read("Dockerfile");
  assert.equal(pkg.scripts.build, "npm run client:check && npm run client:build && tsc");
  assert.equal(pkg.scripts["client:check"], "tsc -p tsconfig.client.build.json --noEmit");
  assert.equal(pkg.scripts["client:build"], "node scripts/build-client.mjs");
  assert.match(pkg.scripts["typecheck:client"], /tsc -p tsconfig\.client\.json && npm run client:check/);
  assert.equal(pkg.scripts["public:check"], "node scripts/check-public-scripts.mjs");
  assert.equal(pkg.scripts.verify, "node scripts/run-verify.mjs");
  assert.match(verifyRunner, /npm",\s*"run",\s*"typecheck:client"/);
  assert.match(verifyRunner, /node",\s*"scripts\/check-client-build-output\.mjs"/);
  assert.match(verifyRunner, /npm",\s*"run",\s*"public:check"/);
  assert.match(verifyRunner, /const buildJobs = \[/);
  assert.match(verifyRunner, /const postBuildJobs = \[/);
  assert.match(verifyRunner, /await runGroup\("build", buildJobs\);\nawait runGroup\("post-build", postBuildJobs\);/);
  assert.match(clientTsconfig, /"allowJs": true/);
  assert.match(clientTsconfig, /"checkJs": true/);
  assert.match(clientTsconfig, /"noEmit": true/);
  assert.match(clientTsconfig, /src\/contracts\/client-globals\.d\.ts/);
  assert.match(clientGlobals, /declare function fmtWeight\(weight: unknown\): string/);
  assert.match(clientGlobals, /declare function formatFoodNum\(value: unknown\): string/);
  assert.match(clientGlobals, /declare function fmtKm\(km: unknown\): string/);
  assert.match(clientGlobals, /declare function relAge\(iso: string\): string/);
  assert.match(clientGlobals, /declare const fmtK: \(value: unknown\) => string/);
  assert.match(clientGlobals, /declare function mdToHtml\(source: unknown\): string/);
  assert.match(clientGlobals, /CairnMarkdown/);
  assert.match(clientGlobals, /declare function cardioPrescription\(item: Record<string, unknown> \| null \| undefined\): string/);
  assert.match(clientGlobals, /CairnCardioPlan/);
  assert.match(clientGlobals, /declare function cardioSyncLine/);
  assert.match(clientGlobals, /CairnCardioSync/);
  assert.match(clientGlobals, /declare function enduranceBlockHtml/);
  assert.match(clientGlobals, /declare function paceTrendWord\(trend: unknown\): string/);
  assert.match(clientGlobals, /declare function zoneBarHtml\(zones: unknown\): string/);
  assert.match(clientGlobals, /declare function enduranceBestRows\(group: unknown\): unknown\[\]/);
  assert.match(clientGlobals, /declare function enduranceSportCardHtml\(group: unknown, idx: number\): string/);
  assert.match(clientGlobals, /CairnProgressEndurance/);
  assert.match(clientGlobals, /declare function withToken\(url: string\): string/);
  assert.match(clientGlobals, /declare function downloadFile\(href: string\): void/);
  assert.match(clientGlobals, /declare function api<Path extends string>/);
  assert.match(clientGlobals, /type ClientAppState = \{/);
  assert.match(clientGlobals, /type ClientAppRouterApi = \{/);
  assert.match(clientGlobals, /declare const state: ClientAppState/);
  assert.match(clientGlobals, /declare function \$<T extends Element = Element>/);
  assert.match(clientGlobals, /declare let _progFocusCard: unknown/);
  assert.match(clientGlobals, /declare function cachedApi<Path extends string>/);
  assert.match(clientGlobals, /declare function paintSWR<Path extends string>/);
  assert.match(clientGlobals, /declare function measureChatTop\(\): void/);
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
  assert.match(clientGlobals, /declare function withAlpha\(hex: unknown, alpha: number\): string/);
  assert.match(clientGlobals, /declare function drawLineChart/);
  assert.match(clientGlobals, /CairnProgressChart/);
  assert.match(clientGlobals, /declare function sessionCardHtml\(session: unknown, index: number\): string/);
  assert.match(clientGlobals, /declare function numOrNull\(value: unknown\): number \| null/);
  assert.match(clientGlobals, /declare function setsTonnage\(sets: unknown\): number/);
  assert.match(clientGlobals, /CairnTodaySessionStatus/);
  assert.match(clientGlobals, /setChipHtml\(set: Record<string, unknown> \| null \| undefined, index\?: number\): string/);
  assert.match(clientGlobals, /feedbackFormHtml\(session: Record<string, unknown> \| null \| undefined\): string/);
  assert.match(clientGlobals, /CairnProgressHistory/);
  assert.match(clientGlobals, /declare function weeklyRunPlanCard\(plan: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressRunPlan/);
  assert.match(clientGlobals, /declare function volBalanceHtml\(balance: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressVolume/);
  assert.match(clientGlobals, /declare function kcalFmt\(value: unknown\): string/);
  assert.match(clientGlobals, /declare function energyRead\(exp: unknown\)/);
  assert.match(clientGlobals, /CairnProgressEnergy/);
  assert.match(clientGlobals, /declare function calMonthHtml\(ym: string, byDate: Map<string, unknown>, todayIso: string, idx: number\): string/);
  assert.match(clientGlobals, /CairnProgressCalendar/);
  assert.match(clientGlobals, /declare function loadMuscleTrajectory\(\): Promise<void>/);
  assert.match(clientGlobals, /declare function muscleTrajectoryHtml\(trajectory: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressMuscleTrajectory/);
  assert.match(clientGlobals, /declare function dexaTargetingHtml\(targeting: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressDexaTargeting/);
  assert.match(clientGlobals, /declare function performanceHtml\(performance: unknown, options\?: \{ suppressLever\?: boolean \}\): string/);
  assert.match(clientGlobals, /CairnProgressPerformance/);
  assert.match(clientGlobals, /declare function programAdjustmentsHtml\(rows: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressProgramAdjustments/);
  assert.match(clientGlobals, /declare function testWeekBannerHtml\(testWeek: unknown\): string/);
  assert.match(clientGlobals, /CairnProgressTestWeek/);
  assert.match(clientGlobals, /declare function liftStatusWord\(lift: unknown\): string/);
  assert.match(clientGlobals, /declare function liftTrendFig\(lift: unknown\): string/);
  assert.match(clientGlobals, /declare function liftBestFig\(lift: unknown\): string/);
  assert.match(clientGlobals, /declare function sortLifts\(lifts: unknown\): unknown\[\]/);
  assert.match(clientGlobals, /declare function volBandWord\(band: unknown\): string/);
  assert.match(clientGlobals, /declare function volTrendGlyph\(trend: unknown\): string/);
  assert.match(clientGlobals, /declare function liftRowHtml\(lift: unknown, index: number\): string/);
  assert.match(clientGlobals, /declare function volumeBlockHtml\(volume: unknown, startIdx: number\): string/);
  assert.match(clientGlobals, /declare function mesoBlockHtml\(meso: unknown, index: number\): string/);
  assert.match(clientGlobals, /declare function adaptationsHtml\(adaptations: unknown, index: number\): string/);
  assert.match(clientGlobals, /CairnProgressProgramSummary/);
  assert.match(clientGlobals, /declare function phaseWord\(phase: unknown\): string/);
  assert.match(clientGlobals, /declare function blockFocusWord\(focus: unknown\): string/);
  assert.match(clientGlobals, /declare function activeBlockHtml\(block: unknown\): string/);
  assert.match(clientGlobals, /declare function startBlockHtml\(\): string/);
  assert.match(clientGlobals, /declare function loadProgramBlock\(\): Promise<void>/);
  assert.match(clientGlobals, /declare function wireProgramBlock\(slot: Element\): void/);
  assert.match(clientGlobals, /CairnProgressProgramBlock/);
  assert.match(clientGlobals, /declare function healthDocHtml\(doc: unknown, index\?: number\): string/);
  assert.match(clientGlobals, /CairnHealthDocs/);
  assert.match(clientGlobals, /H_FILE_PROMPT: string/);
  assert.match(clientGlobals, /guessUploadMime/);
  assert.match(clientGlobals, /directiveHtml/);
  assert.match(clientGlobals, /CairnHealthPicture/);
  assert.match(clientGlobals, /reviewHtml\(/);
  assert.match(clientGlobals, /CairnHealthMarkers/);
  assert.match(clientGlobals, /hmkRowHtml\(/);
  assert.match(clientGlobals, /CairnHealthDirectives/);
  assert.match(clientGlobals, /directivesSectionHtml\(/);
  assert.match(clientGlobals, /CairnHealthStanding/);
  assert.match(clientGlobals, /renderHealthStandingHtml\(/);
  assert.match(clientGlobals, /CairnHealthRead/);
  assert.match(clientGlobals, /priorityMarkersSectionHtml\(/);
  assert.match(clientGlobals, /CairnHealthRecords/);
  assert.match(clientGlobals, /recordsListHtml\(/);
  assert.match(clientGlobals, /CairnFoodNote/);
  assert.match(clientGlobals, /noteEntryHtml\(note: Record<string, unknown>, index\?: number\): string/);
  assert.match(clientGlobals, /CairnPlanEndurance/);
  assert.match(clientGlobals, /CairnPlanEditor/);
  assert.match(clientGlobals, /progDayHtml\(/);
  assert.match(clientGlobals, /CairnDayFuel/);
  assert.match(clientGlobals, /declare function dayFuelHtml\(day: Record<string, unknown> \| null \| undefined\): string/);
  assert.match(clientGlobals, /declare const MEAL_LABEL: Record<string, string>/);
  assert.match(clientGlobals, /CairnMealPlan/);
  assert.match(clientGlobals, /MEAL_PREFS_PLACEHOLDER: string/);
  assert.match(clientGlobals, /currentMealPlan\(plans: unknown\): Record<string, unknown> \| null/);
  assert.match(clientGlobals, /mealPlannerBodyHtml\(current: unknown, mealPrefs: unknown/);
  assert.match(clientGlobals, /mealPlanListHtml\(plans: unknown\): string/);
  assert.match(clientGlobals, /mealDayHtml\(day: unknown, dayIndex: number/);
  assert.match(clientGlobals, /CairnProposal/);
  assert.match(clientGlobals, /declare function applyResultMessage\(result: unknown\): \{ failed: boolean; message: string \}/);
  assert.match(clientGlobals, /declare function verifiedBadgeHtml\(verified: unknown\): string/);
  assert.match(clientGlobals, /declare function strengthChangeHtml\(change: unknown\): string/);
  assert.match(clientGlobals, /runTargetText\(run: Record<string, unknown>\): string/);
  assert.match(clientGlobals, /CairnTodaySessionSuggest/);
  assert.match(clientGlobals, /suggestedSession\?: ClientSessionSuggestion \| null/);
  assert.match(clientGlobals, /cardHtml\(session: Partial<ClientSessionSuggestion>/);
  assert.match(clientGlobals, /declare function learnedTimelineHtml\(data: unknown\): string/);
  assert.match(clientGlobals, /CairnHealthLearned/);
  assert.match(clientGlobals, /CairnMemory/);
  assert.match(clientGlobals, /memoryRowHtml\(row: Record<string, unknown>, index\?: number\): string/);
  assert.match(clientGlobals, /CairnLife/);
  assert.match(clientGlobals, /lifeEventHtml/);
  assert.match(clientGlobals, /CairnFamily/);
  assert.match(clientGlobals, /familyCardHtml\(row: Record<string, unknown>, index\?: number\): string/);
  assert.match(clientGlobals, /declare function coachingFocusCardHtml\(focus: ClientCoachingFocus \| null \| undefined\): string/);
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
  assert.match(clientGlobals, /declare function renderToday\(\): unknown/);
  assert.match(clientGlobals, /declare function updateHeaderCondense\(\): void/);
  assert.match(clientGlobals, /declare function setDiscipline\(discipline: unknown\): string/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/date-utils\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/html-utils\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/markdown-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/ui-components\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/format-utils\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/api-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-download\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-sw-recovery\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/01-core\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/pwa-install-coach\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/rest-timer\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/coaching-focus-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-activity-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/save-bar\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/swr-cache\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-agenda-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-training-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-brief-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/cardio-plan-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/cardio-sync-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/proposal-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-suggest-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/today-session-status-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-endurance-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-components-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-chart-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-history-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-run-plan-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-volume-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-energy-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-calendar-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-muscle-trajectory-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-dexa-targeting-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-performance-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-adjustments-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-test-week-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-summary-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/progress-program-block-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/04-capture\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/chat-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/plan-endurance-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/day-fuel-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/meal-plan-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/food-note-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/health-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/health-learned-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/memory-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/life-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/family-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/health-docs-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-client\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/settings-screen\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/route-state\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-router\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-route-sync\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-render-dispatch\.js/);
  assert.doesNotMatch(clientTsconfig, /public\/js\/app-tabs\.js/);
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
  assert.match(clientBuild, /src\/client\/date-utils\.ts/);
  assert.match(clientBuild, /public\/js\/date-utils\.js/);
  assert.match(clientBuild, /src\/client\/html-utils\.ts/);
  assert.match(clientBuild, /public\/js\/html-utils\.js/);
  assert.match(clientBuild, /src\/client\/markdown-client\.ts/);
  assert.match(clientBuild, /public\/js\/markdown-client\.js/);
  assert.match(clientBuild, /src\/client\/ui-components\.ts/);
  assert.match(clientBuild, /public\/js\/ui-components\.js/);
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
  assert.match(clientBuild, /src\/client\/pwa-install-coach\.ts/);
  assert.match(clientBuild, /public\/js\/pwa-install-coach\.js/);
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
  assert.match(clientBuild, /src\/client\/today-training-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-training-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-client\.js/);
  assert.match(clientBuild, /src\/client\/cardio-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/cardio-sync-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-sync-client\.js/);
  assert.match(clientBuild, /src\/client\/proposal-client\.ts/);
  assert.match(clientBuild, /public\/js\/proposal-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-suggest-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-suggest-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-status-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-status-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-components-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-components-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-chart-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-chart-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-history-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-history-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-run-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-run-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-volume-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-volume-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-energy-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-energy-client\.js/);
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
  assert.match(clientBuild, /src\/client\/capture\.ts/);
  assert.match(clientBuild, /public\/js\/04-capture\.js/);
  assert.match(clientBuild, /src\/client\/settings-routes\.ts/);
  assert.match(clientBuild, /public\/js\/settings-routes\.js/);
  assert.match(clientBuild, /src\/client\/settings-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-screen\.ts/);
  assert.match(clientBuild, /public\/js\/settings-screen\.js/);
  assert.match(clientBuild, /src\/client\/chat-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-editor-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-editor-client\.js/);
  assert.match(clientBuild, /src\/client\/day-fuel-client\.ts/);
  assert.match(clientBuild, /public\/js\/day-fuel-client\.js/);
  assert.match(clientBuild, /src\/client\/meal-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/meal-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/food-note-client\.ts/);
  assert.match(clientBuild, /public\/js\/food-note-client\.js/);
  assert.match(clientBuild, /src\/client\/health-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-client\.js/);
  assert.match(clientBuild, /src\/client\/health-read-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-read-client\.js/);
  assert.match(clientBuild, /src\/client\/health-standing-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-standing-client\.js/);
  assert.match(clientBuild, /src\/client\/health-learned-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-learned-client\.js/);
  assert.match(clientBuild, /src\/client\/health-records-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-records-client\.js/);
  assert.match(clientBuild, /src\/client\/memory-client\.ts/);
  assert.match(clientBuild, /public\/js\/memory-client\.js/);
  assert.match(clientBuild, /src\/client\/life-client\.ts/);
  assert.match(clientBuild, /public\/js\/life-client\.js/);
  assert.match(clientBuild, /src\/client\/family-client\.ts/);
  assert.match(clientBuild, /public\/js\/family-client\.js/);
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
  assert.ok(
    index.indexOf("/js/date-utils.js") > -1 && index.indexOf("/js/date-utils.js") < index.indexOf("/js/01-core.js"),
    "date-utils.js must load before 01-core.js"
  );
  assert.ok(
    index.indexOf("/js/date-utils.js") > -1 &&
      index.indexOf("/js/api-client.js") > index.indexOf("/js/date-utils.js") &&
      index.indexOf("/js/api-client.js") < index.indexOf("/js/app-download.js"),
    "api-client.js must load after date-utils.js and before app-download.js"
  );
  assert.ok(
    index.indexOf("/js/app-download.js") > index.indexOf("/js/api-client.js") &&
      index.indexOf("/js/app-download.js") < index.indexOf("/js/01-core.js"),
    "app-download.js must load after api-client.js and before 01-core.js"
  );
  assert.ok(
    index.indexOf("/js/app-sw-recovery.js") > index.indexOf("/js/app-download.js") &&
      index.indexOf("/js/app-sw-recovery.js") < index.indexOf("/js/01-core.js"),
    "app-sw-recovery.js must load before app state and fragile feature scripts"
  );
  assert.ok(
    index.indexOf("/js/pwa-install-coach.js") > index.indexOf("/js/01-core.js") &&
      index.indexOf("/js/pwa-install-coach.js") < index.indexOf("/js/02-ui.js"),
    "pwa-install-coach.js must load early, after app state and before feature consumers"
  );
  assert.ok(
    index.indexOf("/js/html-utils.js") > -1 && index.indexOf("/js/html-utils.js") < index.indexOf("/js/02-ui.js"),
    "html-utils.js must load before 02-ui.js and feature modules"
  );
  assert.ok(
    index.indexOf("/js/markdown-client.js") > index.indexOf("/js/html-utils.js") &&
      index.indexOf("/js/markdown-client.js") < index.indexOf("/js/09-plan-chat.js"),
    "markdown-client.js must load after escaping helpers and before chat markdown consumers"
  );
  assert.ok(
    index.indexOf("/js/ui-components.js") > index.indexOf("/js/html-utils.js") &&
      index.indexOf("/js/ui-components.js") < index.indexOf("/js/health-client.js"),
    "ui-components.js must load after escaping helpers and before component consumers"
  );
  assert.ok(
    index.indexOf("/js/ui-components.js") > index.indexOf("/js/html-utils.js") &&
      index.indexOf("/js/ui-components.js") < index.indexOf("/js/today-training-client.js"),
    "ui-components.js must load before Today training component consumers"
  );
  assert.ok(
    index.indexOf("/js/format-utils.js") > -1 && index.indexOf("/js/format-utils.js") < index.indexOf("/js/02-ui.js"),
    "format-utils.js must load before 02-ui.js and feature modules"
  );
  assert.ok(
    index.indexOf("/js/02-ui.js") > -1 &&
      index.indexOf("/js/rest-timer.js") > index.indexOf("/js/02-ui.js") &&
      index.indexOf("/js/rest-timer.js") < index.indexOf("/js/03-today.js"),
    "rest-timer.js must load after toast/UI helpers and before Today set logging"
  );
  assert.ok(
    index.indexOf("/js/coaching-focus-client.js") > index.indexOf("/js/rest-timer.js") &&
      index.indexOf("/js/coaching-focus-client.js") < index.indexOf("/js/03-today.js"),
    "coaching-focus-client.js must load after legacy UI helpers and before focus consumers"
  );
  assert.ok(
    index.indexOf("/js/02-ui.js") > -1 &&
      index.indexOf("/js/today-activity-client.js") > index.indexOf("/js/02-ui.js") &&
      index.indexOf("/js/today-activity-client.js") < index.indexOf("/js/03-today.js"),
    "today-activity-client.js must load after legacy UI dependencies and before activity consumers"
  );
  assert.ok(
    index.indexOf("/js/02-ui.js") > -1 &&
      index.indexOf("/js/save-bar.js") > index.indexOf("/js/02-ui.js") &&
      index.indexOf("/js/save-bar.js") < index.indexOf("/js/swr-cache.js"),
    "save-bar.js must load after 02-ui.js and before feature modules"
  );
  assert.ok(
    index.indexOf("/js/save-bar.js") > -1 &&
      index.indexOf("/js/swr-cache.js") > index.indexOf("/js/save-bar.js") &&
      index.indexOf("/js/swr-cache.js") < index.indexOf("/js/03-today.js"),
    "swr-cache.js must load after save-bar.js and before feature modules"
  );
  assert.ok(
    index.indexOf("/js/today-agenda-client.js") > index.indexOf("/js/swr-cache.js") &&
      index.indexOf("/js/today-agenda-client.js") < index.indexOf("/js/03-today.js"),
    "today-agenda-client.js must load after swr-cache.js and before 03-today.js"
  );
  assert.ok(
    index.indexOf("/js/today-training-client.js") > index.indexOf("/js/today-agenda-client.js") &&
      index.indexOf("/js/today-training-client.js") < index.indexOf("/js/03-today.js"),
    "today-training-client.js must load before 03-today.js"
  );
  assert.ok(
    index.indexOf("/js/today-brief-client.js") > index.indexOf("/js/today-training-client.js") &&
      index.indexOf("/js/today-brief-client.js") < index.indexOf("/js/03-today.js"),
    "today-brief-client.js must load before 03-today.js"
  );
  assert.ok(
    index.indexOf("/js/cardio-plan-client.js") > index.indexOf("/js/today-brief-client.js") &&
      index.indexOf("/js/cardio-plan-client.js") < index.indexOf("/js/03-today.js"),
    "cardio-plan-client.js must load after Today brief helpers and before screen consumers"
  );
  assert.ok(
    index.indexOf("/js/cardio-sync-client.js") > index.indexOf("/js/cardio-plan-client.js") &&
      index.indexOf("/js/cardio-sync-client.js") < index.indexOf("/js/03-today.js") &&
      index.indexOf("/js/cardio-sync-client.js") < index.indexOf("/js/05-progress.js") &&
      index.indexOf("/js/cardio-sync-client.js") < index.indexOf("/js/09-plan-chat.js"),
    "cardio-sync-client.js must load before Today, Progress, and Plan consumers"
  );
  assert.ok(
    index.indexOf("/js/proposal-client.js") > index.indexOf("/js/cardio-sync-client.js") &&
      index.indexOf("/js/proposal-client.js") < index.indexOf("/js/03-today.js") &&
      index.indexOf("/js/proposal-client.js") < index.indexOf("/js/06-coach-meals.js") &&
      index.indexOf("/js/proposal-client.js") < index.indexOf("/js/09-plan-chat.js"),
    "proposal-client.js must load before Today, Meals, and Chat proposal consumers"
  );
  assert.ok(
    index.indexOf("/js/today-session-suggest-client.js") > index.indexOf("/js/proposal-client.js") &&
      index.indexOf("/js/today-session-suggest-client.js") < index.indexOf("/js/03-today.js"),
    "today-session-suggest-client.js must load after proposal helpers and before Today consumers"
  );
  assert.ok(
    index.indexOf("/js/today-session-status-client.js") > index.indexOf("/js/today-session-suggest-client.js") &&
      index.indexOf("/js/today-session-status-client.js") < index.indexOf("/js/03-today.js") &&
      index.indexOf("/js/today-session-status-client.js") < index.indexOf("/js/progress-history-client.js"),
    "today-session-status-client.js must load after session-suggest helpers and before Today/History consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-endurance-client.js") > index.indexOf("/js/today-session-status-client.js") &&
      index.indexOf("/js/progress-endurance-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-endurance-client.js must load after Today session-status helpers and before Progress consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-components-client.js") > index.indexOf("/js/progress-endurance-client.js") &&
      index.indexOf("/js/progress-components-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-components-client.js must load before Progress screen consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-chart-client.js") > index.indexOf("/js/progress-components-client.js") &&
      index.indexOf("/js/progress-chart-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-chart-client.js must load before Progress chart consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-history-client.js") > index.indexOf("/js/progress-chart-client.js") &&
      index.indexOf("/js/progress-history-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-history-client.js must load before Progress history consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-run-plan-client.js") > index.indexOf("/js/progress-history-client.js") &&
      index.indexOf("/js/progress-run-plan-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-run-plan-client.js must load before Progress Endurance consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-volume-client.js") > index.indexOf("/js/progress-run-plan-client.js") &&
      index.indexOf("/js/progress-volume-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-volume-client.js must load before Progress Volume consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-energy-client.js") > index.indexOf("/js/progress-volume-client.js") &&
      index.indexOf("/js/progress-energy-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-energy-client.js must load before Progress Energy consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-calendar-client.js") > index.indexOf("/js/progress-energy-client.js") &&
      index.indexOf("/js/progress-calendar-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-calendar-client.js must load before Progress Calendar consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-muscle-trajectory-client.js") > index.indexOf("/js/progress-calendar-client.js") &&
      index.indexOf("/js/progress-muscle-trajectory-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-muscle-trajectory-client.js must load before Progress muscle trajectory consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-dexa-targeting-client.js") > index.indexOf("/js/progress-muscle-trajectory-client.js") &&
      index.indexOf("/js/progress-dexa-targeting-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-dexa-targeting-client.js must load before Progress and Health DEXA consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-performance-client.js") > index.indexOf("/js/progress-dexa-targeting-client.js") &&
      index.indexOf("/js/progress-performance-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-performance-client.js must load before Progress performance consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-program-adjustments-client.js") > index.indexOf("/js/progress-performance-client.js") &&
      index.indexOf("/js/progress-program-adjustments-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-program-adjustments-client.js must load before Progress adjustment consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-test-week-client.js") > index.indexOf("/js/progress-program-adjustments-client.js") &&
      index.indexOf("/js/progress-test-week-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-test-week-client.js must load before Progress test-week consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-program-summary-client.js") > index.indexOf("/js/progress-test-week-client.js") &&
      index.indexOf("/js/progress-program-summary-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-program-summary-client.js must load before Progress program-summary consumers"
  );
  assert.ok(
    index.indexOf("/js/progress-program-block-client.js") > index.indexOf("/js/progress-program-summary-client.js") &&
      index.indexOf("/js/progress-program-block-client.js") < index.indexOf("/js/05-progress.js"),
    "progress-program-block-client.js must load before Progress program-block consumers"
  );
  assert.ok(
    index.indexOf("/js/04-capture.js") > index.indexOf("/js/03-today.js") &&
      index.indexOf("/js/04-capture.js") < index.indexOf("/js/05-progress.js"),
    "04-capture.js must load after Today and before downstream screens"
  );
  assert.ok(
    index.indexOf("/js/meal-plan-client.js") > index.indexOf("/js/day-fuel-client.js") &&
      index.indexOf("/js/meal-plan-client.js") < index.indexOf("/js/06-coach-meals.js"),
    "meal-plan-client.js must load after fuel helpers and before Meals screen consumers"
  );
  assert.ok(
    index.indexOf("/js/health-docs-client.js") > index.indexOf("/js/06-coach-meals.js") &&
      index.indexOf("/js/health-docs-client.js") < index.indexOf("/js/07-me-health.js") &&
      index.indexOf("/js/health-docs-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-docs-client.js must load before Health and Records document consumers"
  );
  assert.ok(
    index.indexOf("/js/health-client.js") > index.indexOf("/js/07-me-health.js") &&
      index.indexOf("/js/health-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-client.js must load after Health view definitions and before Records view hydration"
  );
  assert.ok(
    index.indexOf("/js/health-read-client.js") > index.indexOf("/js/health-client.js") &&
      index.indexOf("/js/health-read-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-read-client.js must load after shared Health helpers and before boot can render Health Read"
  );
  assert.ok(
    index.indexOf("/js/health-standing-client.js") > index.indexOf("/js/health-read-client.js") &&
      index.indexOf("/js/health-standing-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-standing-client.js must load after Health Read helpers and before boot can render Standing"
  );
  assert.ok(
    index.indexOf("/js/health-picture-client.js") > index.indexOf("/js/health-standing-client.js") &&
      index.indexOf("/js/health-picture-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-picture-client.js must load after Health Standing helpers and before Records view hydration"
  );
  assert.ok(
    index.indexOf("/js/health-markers-client.js") > index.indexOf("/js/health-picture-client.js") &&
      index.indexOf("/js/health-markers-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-markers-client.js must load after Health picture helpers and before Records view hydration"
  );
  assert.ok(
    index.indexOf("/js/health-directives-client.js") > index.indexOf("/js/health-markers-client.js") &&
      index.indexOf("/js/health-directives-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-directives-client.js must load after Health marker helpers and before Records view hydration"
  );
  assert.ok(
    index.indexOf("/js/health-learned-client.js") > index.indexOf("/js/health-directives-client.js") &&
      index.indexOf("/js/health-learned-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-learned-client.js must load after Health directive helpers and before Records learned timeline consumers"
  );
  assert.ok(
    index.indexOf("/js/health-records-client.js") > index.indexOf("/js/health-learned-client.js") &&
      index.indexOf("/js/health-records-client.js") < index.indexOf("/js/08-me-records.js"),
    "health-records-client.js must load after Health learned helpers and before Records tab hydration"
  );
  assert.ok(
    index.indexOf("/js/memory-client.js") > index.indexOf("/js/health-records-client.js") &&
      index.indexOf("/js/memory-client.js") < index.indexOf("/js/10-boot.js"),
    "memory-client.js must load before boot can render Me memory"
  );
  assert.ok(
    index.indexOf("/js/life-client.js") > index.indexOf("/js/memory-client.js") &&
      index.indexOf("/js/life-client.js") < index.indexOf("/js/08-me-records.js"),
    "life-client.js must load before Records life timeline consumers"
  );
  assert.ok(
    index.indexOf("/js/family-client.js") > index.indexOf("/js/life-client.js") &&
      index.indexOf("/js/family-client.js") < index.indexOf("/js/08-me-records.js"),
    "family-client.js must load before Records family consumers"
  );
  assert.ok(
    index.indexOf("/js/chat-client.js") > index.indexOf("/js/08-me-records.js") &&
      index.indexOf("/js/chat-client.js") < index.indexOf("/js/09-plan-chat.js"),
    "chat-client.js must load before 09-plan-chat.js"
  );
  assert.ok(
    index.indexOf("/js/plan-endurance-client.js") > index.indexOf("/js/chat-client.js") &&
      index.indexOf("/js/plan-endurance-client.js") < index.indexOf("/js/09-plan-chat.js"),
    "plan-endurance-client.js must load before Plan endurance consumers"
  );
  assert.ok(
    index.indexOf("/js/plan-editor-client.js") > index.indexOf("/js/plan-endurance-client.js") &&
      index.indexOf("/js/plan-editor-client.js") < index.indexOf("/js/09-plan-chat.js"),
    "plan-editor-client.js must load after Plan endurance helpers and before Plan editor consumers"
  );
  assert.ok(
    index.indexOf("/js/day-fuel-client.js") > index.indexOf("/js/05-progress.js") &&
      index.indexOf("/js/day-fuel-client.js") < index.indexOf("/js/06-coach-meals.js"),
    "day-fuel-client.js must load before Meals day-fuel consumers"
  );
  assert.ok(
    index.indexOf("/js/food-note-client.js") > index.indexOf("/js/06-coach-meals.js") &&
      index.indexOf("/js/food-note-client.js") < index.indexOf("/js/07-me-health.js"),
    "food-note-client.js must load before Me food-note consumers"
  );
  assert.ok(
    index.indexOf("/js/settings-client.js") > index.indexOf("/js/settings-routes.js") &&
      index.indexOf("/js/settings-client.js") < index.indexOf("/js/settings-screen.js"),
    "settings-client.js must load before settings-screen.js"
  );
  assert.ok(
    index.indexOf("/js/settings-screen.js") > index.indexOf("/js/settings-client.js") &&
      index.indexOf("/js/settings-screen.js") < index.indexOf("/js/route-state.js"),
    "settings-screen.js must load after Settings helpers and before route-state.js"
  );
  assert.ok(
    index.indexOf("/js/app-router.js") > index.indexOf("/js/route-state.js") &&
      index.indexOf("/js/app-router.js") < index.indexOf("/js/app-route-sync.js"),
    "app-router.js must load after route-state.js and before route sync wrappers"
  );
  assert.ok(
    index.indexOf("/js/app-route-sync.js") > index.indexOf("/js/app-router.js") &&
      index.indexOf("/js/app-route-sync.js") < index.indexOf("/js/app-render-dispatch.js"),
    "app-route-sync.js must load after router helpers and before render dispatch"
  );
  assert.ok(
    index.indexOf("/js/app-render-dispatch.js") > index.indexOf("/js/app-route-sync.js") &&
      index.indexOf("/js/app-render-dispatch.js") < index.indexOf("/js/app-tabs.js"),
    "app-render-dispatch.js must load after route sync wrappers and before tab shell controls"
  );
  assert.ok(
    index.indexOf("/js/app-tabs.js") > index.indexOf("/js/app-render-dispatch.js") &&
      index.indexOf("/js/app-tabs.js") < index.indexOf("/js/app-job-reconnectors.js"),
    "app-tabs.js must load after render dispatch and before boot-time reconnectors"
  );
  assert.ok(
    index.indexOf("/js/app-job-reconnectors.js") > index.indexOf("/js/app-tabs.js") &&
      index.indexOf("/js/app-job-reconnectors.js") < index.indexOf("/js/10-boot.js"),
    "app-job-reconnectors.js must load after tab shell controls and before 10-boot.js"
  );
  assert.ok(
    index.indexOf("/js/app-mobile-viewport.js") > index.indexOf("/js/app-job-reconnectors.js") &&
      index.indexOf("/js/app-mobile-viewport.js") < index.indexOf("/js/10-boot.js"),
    "app-mobile-viewport.js must load after boot-time reconnectors and before 10-boot.js"
  );
  assert.ok(
    index.indexOf("/js/app-service-worker.js") > index.indexOf("/js/app-mobile-viewport.js") &&
      index.indexOf("/js/app-service-worker.js") < index.indexOf("/js/10-boot.js"),
    "app-service-worker.js must load after app shell helpers and before 10-boot.js"
  );
  assert.ok(
    index.indexOf("/js/app-discipline-primer.js") > index.indexOf("/js/app-service-worker.js") &&
      index.indexOf("/js/app-discipline-primer.js") < index.indexOf("/js/app-onboarding.js"),
    "app-discipline-primer.js must load after app shell helpers and before 10-boot.js"
  );
  assert.ok(
    index.indexOf("/js/app-onboarding.js") > index.indexOf("/js/app-discipline-primer.js") &&
      index.indexOf("/js/app-onboarding.js") < index.indexOf("/js/app-startup.js"),
    "app-onboarding.js must load after discipline priming and before startup"
  );
  assert.ok(
    index.indexOf("/js/app-startup.js") > index.indexOf("/js/app-onboarding.js") &&
      index.indexOf("/js/app-startup.js") < index.indexOf("/js/10-boot.js"),
    "app-startup.js must load after app shell helpers and before 10-boot.js"
  );
  assert.match(dateUtils, /\/\/ @ts-check/);
  assert.match(htmlUtils, /\/\/ @ts-check/);
  assert.match(markdownClient, /\/\/ @ts-check/);
  assert.match(uiComponents, /\/\/ @ts-check/);
  assert.match(formatUtils, /\/\/ @ts-check/);
  assert.match(apiClient, /\/\/ @ts-check/);
  assert.match(appDownload, /\/\/ @ts-check/);
  assert.match(appSwRecovery, /\/\/ @ts-check/);
  assert.match(pwaInstall, /\/\/ @ts-check/);
  assert.match(restTimer, /\/\/ @ts-check/);
  assert.match(coachingFocusClient, /\/\/ @ts-check/);
  assert.match(todayActivityClient, /\/\/ @ts-check/);
  assert.match(swrCache, /\/\/ @ts-check/);
  assert.match(todayAgendaClient, /\/\/ @ts-check/);
  assert.match(todayTrainingClient, /\/\/ @ts-check/);
  assert.match(todayBriefClient, /\/\/ @ts-check/);
  assert.match(cardioPlanClient, /\/\/ @ts-check/);
  assert.match(todaySessionSuggestClient, /\/\/ @ts-check/);
  assert.match(todaySessionStatusClient, /\/\/ @ts-check/);
  assert.match(progressEnduranceClient, /\/\/ @ts-check/);
  assert.match(progressComponentsClient, /\/\/ @ts-check/);
  assert.match(progressChartClient, /\/\/ @ts-check/);
  assert.match(progressRunPlanClient, /\/\/ @ts-check/);
  assert.match(progressVolumeClient, /\/\/ @ts-check/);
  assert.match(progressEnergyClient, /\/\/ @ts-check/);
  assert.match(progressCalendarClient, /\/\/ @ts-check/);
  assert.match(progressMuscleTrajectoryClient, /\/\/ @ts-check/);
  assert.match(progressDexaTargetingClient, /\/\/ @ts-check/);
  assert.match(progressPerformanceClient, /\/\/ @ts-check/);
  assert.match(progressProgramAdjustmentsClient, /\/\/ @ts-check/);
  assert.match(progressTestWeekClient, /\/\/ @ts-check/);
  assert.match(capture, /\/\/ @ts-check/);
  assert.match(healthClient, /\/\/ @ts-check/);
  assert.match(healthDocsClient, /\/\/ @ts-check/);
  assert.match(chatClient, /\/\/ @ts-check/);
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
  assert.match(clientBuild, /src\/client\/format-utils\.ts/);
  assert.match(clientBuild, /public\/js\/format-utils\.js/);
  assert.match(clientBuild, /src\/client\/api-client\.ts/);
  assert.match(clientBuild, /public\/js\/api-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/download\.ts/);
  assert.match(clientBuild, /public\/js\/app-download\.js/);
  assert.match(clientBuild, /src\/client\/app\/sw-recovery\.ts/);
  assert.match(clientBuild, /public\/js\/app-sw-recovery\.js/);
  assert.match(clientBuild, /src\/client\/pwa-install-coach\.ts/);
  assert.match(clientBuild, /public\/js\/pwa-install-coach\.js/);
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
  assert.match(clientBuild, /src\/client\/today-training-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-training-client\.js/);
  assert.match(clientBuild, /src\/client\/today-brief-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-brief-client\.js/);
  assert.match(clientBuild, /src\/client\/cardio-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/cardio-sync-client\.ts/);
  assert.match(clientBuild, /public\/js\/cardio-sync-client\.js/);
  assert.match(clientBuild, /src\/client\/proposal-client\.ts/);
  assert.match(clientBuild, /public\/js\/proposal-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-suggest-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-suggest-client\.js/);
  assert.match(clientBuild, /src\/client\/today-session-status-client\.ts/);
  assert.match(clientBuild, /public\/js\/today-session-status-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-components-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-components-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-chart-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-chart-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-history-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-history-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-run-plan-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-run-plan-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-volume-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-volume-client\.js/);
  assert.match(clientBuild, /src\/client\/progress-energy-client\.ts/);
  assert.match(clientBuild, /public\/js\/progress-energy-client\.js/);
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
  assert.match(clientBuild, /src\/client\/capture\.ts/);
  assert.match(clientBuild, /public\/js\/04-capture\.js/);
  assert.match(clientBuild, /src\/client\/settings-routes\.ts/);
  assert.match(clientBuild, /public\/js\/settings-routes\.js/);
  assert.match(clientBuild, /src\/client\/settings-client\.ts/);
  assert.match(clientBuild, /public\/js\/settings-client\.js/);
  assert.match(clientBuild, /src\/client\/settings-screen\.ts/);
  assert.match(clientBuild, /public\/js\/settings-screen\.js/);
  assert.match(clientBuild, /src\/client\/chat-client\.ts/);
  assert.match(clientBuild, /public\/js\/chat-client\.js/);
  assert.match(clientBuild, /src\/client\/plan-endurance-client\.ts/);
  assert.match(clientBuild, /public\/js\/plan-endurance-client\.js/);
  assert.match(clientBuild, /src\/client\/day-fuel-client\.ts/);
  assert.match(clientBuild, /public\/js\/day-fuel-client\.js/);
  assert.match(clientBuild, /src\/client\/food-note-client\.ts/);
  assert.match(clientBuild, /public\/js\/food-note-client\.js/);
  assert.match(clientBuild, /src\/client\/health-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-client\.js/);
  assert.match(clientBuild, /src\/client\/health-learned-client\.ts/);
  assert.match(clientBuild, /public\/js\/health-learned-client\.js/);
  assert.match(clientBuild, /src\/client\/memory-client\.ts/);
  assert.match(clientBuild, /public\/js\/memory-client\.js/);
  assert.match(clientBuild, /src\/client\/life-client\.ts/);
  assert.match(clientBuild, /public\/js\/life-client\.js/);
  assert.match(clientBuild, /src\/client\/family-client\.ts/);
  assert.match(clientBuild, /public\/js\/family-client\.js/);
  assert.match(clientBuild, /src\/client\/app\/router\.ts/);
  assert.match(clientBuild, /public\/js\/app-router\.js/);
  assert.match(clientBuild, /src\/client\/app\/route-sync\.ts/);
  assert.match(clientBuild, /public\/js\/app-route-sync\.js/);
  assert.match(clientBuild, /src\/client\/app\/render-dispatch\.ts/);
  assert.match(clientBuild, /public\/js\/app-render-dispatch\.js/);
  assert.match(clientBuild, /src\/client\/app\/tabs\.ts/);
  assert.match(clientBuild, /public\/js\/app-tabs\.js/);
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
  assert.match(clientBuildCheck, /client build output was stale/);
  assert.match(clientBuildCheck, /client build output is up to date/);
  assert.match(contracts, /export \* from "\.\/client-api\.js"/);
  assert.match(contracts, /export \* from "\.\/client-api-coverage\.js"/);
  assert.match(apiContracts, /export interface ClientApiResponses/);
  assert.match(apiContracts, /"\/api\/today-agenda": ClientTodayAgenda/);
  assert.match(apiContracts, /"\/api\/coaching-focus": ClientCoachingFocus/);
  assert.match(apiContracts, /"\/api\/nutrition\/day": ClientDayIntake/);
  assert.match(apiContracts, /"\/api\/program\/progression": ClientPrescription\[\]/);
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
  assert.match(apiContracts, /ClientAgentJobEnvelope/);
  assert.match(apiContracts, /"\/api\/chat\/sessions\/:sessionId": ClientChatMessage\[\]/);
  assert.match(apiContracts, /export type ClientApiResponse<Path extends string>/);
  assert.match(apiCoverage, /export const CLIENT_API_CONTRACT_PATHS/);
  assert.match(apiCoverage, /export const CLIENT_API_UNKNOWN_WAIVERS/);
  assert.match(compat, /AssertAssignable<TodayAgenda, ClientTodayAgenda>/);
  assert.match(compat, /AssertAssignable<CoachingFocus, ClientCoachingFocus>/);
  assert.match(compat, /ReturnType<typeof getDayIntake>/);
  assert.match(compat, /ReturnType<typeof planDayProgression>/);
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
  assert.match(pwaInstallSource, /function isStandalonePWA\(\): boolean/);
  assert.match(pwaInstallSource, /function renderPhoneCoachBanner\(container: Element \| null \| undefined\): void/);
  assert.match(pwaInstallSource, /Object\.assign\(globalThis, \{/);
  assert.match(pwaInstallSource, /CairnPwaInstall/);
  assert.match(restTimerSource, /function startRest\(seconds\?: number\): void/);
  assert.match(restTimerSource, /function stopRest\(\): void/);
  assert.match(restTimerSource, /Object\.assign\(globalThis, \{/);
  assert.match(restTimerSource, /CairnRestTimer/);
  assert.match(coachingFocusSource, /type ClientCoachingFocus = import\("\.\.\/contracts\/client\.js"\)\.ClientCoachingFocus/);
  assert.match(coachingFocusSource, /function coachingFocusCardHtml\(focus: ClientCoachingFocus \| null \| undefined\): string/);
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
  assert.match(
    todayTrainingSource,
    /type ClientPrescription = import\("\.\.\/contracts\/client\.js"\)\.ClientPrescription/
  );
  assert.match(todayTrainingSource, /const TODAY_RX_ACTION: Record<ClientProgressionAction, ClientProgressionMeta>/);
  assert.match(todayBriefSource, /type ClientDayRead = import\("\.\.\/contracts\/client\.js"\)\.ClientDayRead/);
  assert.match(todayBriefSource, /function todayBriefHtml\(read: TodayBriefRead \| null \| undefined/);
  assert.match(todayBriefSource, /function todayFocusBarHtml/);
  assert.match(todayBriefSource, /CairnTodayBrief/);
  assert.match(cardioPlanSource, /function cardioPrescription/);
  assert.match(cardioPlanSource, /Object\.assign\(globalThis, \{/);
  assert.match(cardioPlanSource, /CairnCardioPlan/);
  assert.match(cardioSyncSource, /function garminConfigured/);
  assert.match(cardioSyncSource, /function cardioSyncLine/);
  assert.match(cardioSyncSource, /CairnCardioSync/);
  assert.match(proposalSource, /function applyResultMessage\(result: unknown\)/);
  assert.match(proposalSource, /function verifiedBadgeHtml\(verified: unknown\)/);
  assert.match(proposalSource, /function strengthChangeHtml\(change: unknown\)/);
  assert.match(todaySessionSuggestSource, /type ClientSessionSuggestion = import\("\.\.\/contracts\/client\.js"\)\.ClientSessionSuggestion/);
  assert.match(todaySessionSuggestSource, /function todaySuggestCardHtml\(session: SuggestedSessionLike/);
  assert.match(todaySessionSuggestSource, /function todaySuggestComposerHtml/);
  assert.match(todaySessionSuggestSource, /CairnTodaySessionSuggest/);
  assert.match(todaySessionStatusSource, /type ClientTrainingSession = import\("\.\.\/contracts\/client-api\.js"\)\.ClientTrainingSession/);
  assert.match(todaySessionStatusSource, /function todaySetsTonnage\(sets: unknown\): number/);
  assert.match(todaySessionStatusSource, /function todaySessionDoneCardHtml\(session: SessionLike/);
  assert.match(todaySessionStatusSource, /function todayFeedbackFormHtml\(session: SessionLike/);
  assert.match(todaySessionStatusSource, /CairnTodaySessionStatus/);
  assert.match(proposalSource, /function runTargetText\(run: unknown\): string/);
  assert.match(proposalSource, /function coachProposalCardHtml\(proposal: unknown, index: number, lastApplyClamp\?: unknown\): string/);
  assert.match(proposalSource, /function coachProposalListHtml\(proposals: unknown, lastApplyClamp\?: unknown\): string/);
  assert.match(proposalSource, /CairnProposal/);
  assert.match(progressEnduranceSource, /function enduranceStatusWord\(status: unknown\): string/);
  assert.match(progressEnduranceSource, /function enduranceBlockHtml\(end: ProgramEnduranceBlock \| null \| undefined, idx: number\): string/);
  assert.match(progressEnduranceSource, /function paceTrendWord\(trend: unknown\): string/);
  assert.match(progressEnduranceSource, /function zoneBarHtml\(zones: unknown\): string/);
  assert.match(progressEnduranceSource, /function enduranceBestRows\(group: unknown\): EnduranceBestPoint\[\]/);
  assert.match(progressEnduranceSource, /function enduranceSportCardHtml\(group: unknown, idx: number\): string/);
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
  assert.match(progressChartSource, /function withAlpha\(hex: unknown, alpha: number\): string/);
  assert.match(progressChartSource, /function chartColors\(\): ProgressChartPalette/);
  assert.match(progressChartSource, /function drawLineChart/);
  assert.match(progressChartSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressChartSource, /CairnProgressChart/);
  assert.match(progressHistorySource, /function sessionCardHtml\(session: unknown, index: number\): string/);
  assert.match(progressHistorySource, /function numOrNull\(value: unknown\): number \| null/);
  assert.match(progressHistorySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressHistorySource, /CairnProgressHistory/);
  assert.match(progressRunPlanSource, /function weeklyRunPlanCard\(plan: WeeklyRunPlan \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /function enduranceGoalCard\(goal: EnduranceGoal \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /function enduranceCoachLine\(plan: WeeklyRunPlan \| null \| undefined\): string/);
  assert.match(progressRunPlanSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressRunPlanSource, /CairnProgressRunPlan/);
  assert.match(progressVolumeSource, /function capWord\(input: unknown\): string/);
  assert.match(progressVolumeSource, /function volBalanceHtml\(balance: VolumeBalance \| null \| undefined\): string/);
  assert.match(progressVolumeSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressVolumeSource, /CairnProgressVolume/);
  assert.match(progressEnergySource, /function kcalFmt\(value: unknown\): string/);
  assert.match(progressEnergySource, /function energyRead\(exp: EnergyExpenditure \| null \| undefined\): EnergyRead/);
  assert.match(progressEnergySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnergySource, /CairnProgressEnergy/);
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
  assert.match(progressPerformanceSource, /function pctClamp\(value: unknown\): number/);
  assert.match(progressPerformanceSource, /function capacityRowHtml\(capacity: PerformanceCapacity, sexWord: unknown\): string/);
  assert.match(progressPerformanceSource, /function performanceHtml\(performance: PerformanceStanding \| null \| undefined, options: PerformanceRenderOptions = \{\}\): string/);
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
  assert.match(progressProgramSummarySource, /function liftStatusWord\(lift: unknown\): string/);
  assert.match(progressProgramSummarySource, /function liftTrendFig\(lift: unknown\): string/);
  assert.match(progressProgramSummarySource, /function liftBestFig\(lift: unknown\): string/);
  assert.match(progressProgramSummarySource, /function sortLifts\(lifts: unknown\): ProgramLift\[\]/);
  assert.match(progressProgramSummarySource, /function phaseWord\(phase: unknown\): string/);
  assert.match(progressProgramSummarySource, /function liftRowHtml\(lift: unknown, index: number\): string/);
  assert.match(progressProgramSummarySource, /function volumeBlockHtml\(volume: unknown, startIdx: number\): string/);
  assert.match(progressProgramSummarySource, /function mesoBlockHtml\(meso: unknown, index: number\): string/);
  assert.match(progressProgramSummarySource, /function adaptationsHtml\(adaptations: unknown, index: number\): string/);
  assert.match(progressProgramSummarySource, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramSummarySource, /CairnProgressProgramSummary/);
  assert.match(progressProgramBlockSource, /function blockFocusWord\(focus: unknown\): string/);
  assert.match(progressProgramBlockSource, /function activeBlockHtml\(block: unknown\): string/);
  assert.match(progressProgramBlockSource, /async function loadProgramBlock\(\): Promise<void>/);
  assert.match(progressProgramBlockSource, /function wireProgramBlock\(slot: Element\): void/);
  assert.match(progressProgramBlockSource, /Object\.assign\(globalThis, \{/);
  assert.match(progressProgramBlockSource, /CairnProgressProgramBlock/);
  assert.match(captureSource, /type CaptureDirective = import\("\.\.\/contracts\/client\.js"\)\.ClientDirective/);
  assert.match(captureSource, /function loadTodayReads\(\): Promise<void>/);
  assert.match(captureSource, /function reconnectInsight\(\): ClientAgentOpHandlers \| null/);
  assert.match(settingsRoutesSource, /function settingsRouteRowsHtml/);
  assert.match(settingsRoutesSource, /function settingsPruneRoutes/);
  assert.match(settingsClientSource, /type SettingsUpdateOptions = \{ updateCheckEnabled: boolean \}/);
  assert.match(settingsClientSource, /function updateCardHtml/);
  assert.match(settingsScreenSource, /type SettingsWorkingModel = \{/);
  assert.match(settingsScreenSource, /async function renderSettings\(\): Promise<void>/);
  assert.match(settingsScreenSource, /Object\.assign\(globalThis, \{/);
  assert.match(settingsScreenSource, /SET_SEG/);
  assert.match(
    chatClientSource,
    /type ChatImagePayload = \{ dataUrl: string; base64: string; mime: "image\/jpeg"; bytes: number \}/
  );
  assert.match(chatClientSource, /function chatWantsFuelSurface/);
  assert.match(chatClientSource, /const CAIRN_CHAT_CLIENT = \{/);
  assert.match(planEnduranceSource, /const ENDURANCE_PHASES/);
  assert.match(planEnduranceSource, /function enduranceRampHtml\(goal: EnduranceGoalRow/);
  assert.match(planEnduranceSource, /function endurancePresets\(goal: EnduranceGoalRow/);
  assert.match(planEnduranceSource, /function endDraftCardHtml\(proposal: EnduranceProposal\): string/);
  assert.match(planEnduranceSource, /CairnPlanEndurance/);
  assert.match(planEditorSource, /type PlanEditorItem = \{/);
  assert.match(planEditorSource, /function dayModelFromPlan\(day: PlanEditorDay\)/);
  assert.match(planEditorSource, /function progDayHtml\(day: PlanEditorDay, dayIndex: number\): string/);
  assert.match(planEditorSource, /function pitemHtml\(item: PlanEditorItem, dayIndex: number, itemIndex: number, lastIndex: number\): string/);
  assert.match(planEditorSource, /CairnPlanEditor/);
  assert.match(dayFuelSource, /const MEAL_LABEL: Record<string, string>/);
  assert.match(dayFuelSource, /function dayFuelHtml\(day: DayFuelData \| null \| undefined\): string/);
  assert.match(dayFuelSource, /CairnDayFuel/);
  assert.match(mealPlanSource, /function mealSlotFor\(name: unknown, index: unknown\): string/);
  assert.match(mealPlanSource, /function currentMealPlan\(plans: unknown\): MealRecord \| null/);
  assert.match(mealPlanSource, /function mealsCtxFor\(plan: unknown, now\?: unknown\): MealPlannerContext/);
  assert.match(mealPlanSource, /function mealRowHtml\(meal: unknown, mealIndex\?: number, options\?: MealRowOptions\): string/);
  assert.match(mealPlanSource, /function mealPlanListHtml\(plans: unknown\): string/);
  assert.match(mealPlanSource, /function mealPrefsHtml\(prefs: unknown, index: number\): string/);
  assert.match(mealPlanSource, /function mealPlannerBodyHtml\(current: unknown, mealPrefs: unknown, options: MealPlannerOptions = \{\}\): MealPlannerPaint/);
  assert.match(mealPlanSource, /function mealDayHtml\(day: unknown, dayIndex: number, context: MealDayContext\): string/);
  assert.match(mealPlanSource, /CairnMealPlan/);
  assert.match(foodNoteSource, /type FoodNoteRow = \{/);
  assert.match(foodNoteSource, /function foodIngredients\(value: unknown\): FoodIngredientRow\[\]/);
  assert.match(foodNoteSource, /function noteEntryHtml\(note: FoodNoteRow, index\?: number\): string/);
  assert.match(foodNoteSource, /CairnFoodNote/);
  assert.match(healthClientSource, /type HealthEvidenceRow = \{/);
  assert.match(healthClientSource, /const MAX_DOC_BYTES = 15 \* 1024 \* 1024/);
  assert.match(healthClientSource, /function guessUploadMime\(file: UploadFileLike/);
  assert.match(healthClientSource, /const DIRECTIVE_DOMAINS: Array<readonly \[string, string, string\]>/);
  assert.match(healthClientSource, /function directiveHtml\(d: HealthDirectiveRow/);
  assert.match(healthClientSource, /function formatMarkerNumber\(value: unknown\): string/);
  assert.match(
    healthClientSource,
    /function markerTrendWord\(marker: HealthMarkerTrendRow \| null \| undefined\): string/
  );
  assert.match(healthClientSource, /const HEALTH_MARKER_ORDER: Record<string, Array<\[number, RegExp\]>>/);
  assert.match(healthClientSource, /function orderMarkersForDisplay<T extends HealthMarkerRow>/);
  assert.match(healthPictureSource, /type HealthPictureReview = \{/);
  assert.match(healthPictureSource, /function parsedReview\(review: HealthPictureReview/);
  assert.match(healthPictureSource, /function reviewHtml\(review: HealthPictureReview/);
  assert.match(healthPictureSource, /CairnHealthPicture/);
  assert.match(healthMarkersSource, /type HealthMarkersPoint = \{/);
  assert.match(healthMarkersSource, /function markerChartSvg\(marker: HealthMarkersRow/);
  assert.match(healthMarkersSource, /function wireMarkerChart\(svg: SVGElement/);
  assert.match(healthMarkersSource, /function hmkRowHtml\(marker: HealthMarkersRow/);
  assert.match(healthMarkersSource, /CairnHealthMarkers/);
  assert.match(healthDirectivesSource, /type HealthDirectivesRow = \{/);
  assert.match(healthDirectivesSource, /function directivesSectionHtml\(rows: unknown/);
  assert.match(healthDirectivesSource, /function directiveResearchNudgeHtml/);
  assert.match(healthDirectivesSource, /CairnHealthDirectives/);
  assert.match(healthReadSource, /type HealthReadRecovery = \{/);
  assert.match(healthReadSource, /function recoveryHtml\(summary: HealthReadRecovery/);
  assert.match(healthReadSource, /function priorityMarkersSectionHtml\(markersInput: unknown/);
  assert.match(healthReadSource, /function optimalPhrase\(marker: HealthReadMarker/);
  assert.match(healthReadSource, /CairnHealthRead/);
  assert.match(healthStandingSource, /type HealthStandingRead = \{/);
  assert.match(healthStandingSource, /function renderHealthStandingHtml\(data: HealthStandingRead/);
  assert.match(healthStandingSource, /function hstandBpCardHtml/);
  assert.match(healthStandingSource, /function hstandBodyCompHtml/);
  assert.match(healthStandingSource, /CairnHealthStanding/);
  assert.match(healthDocsSource, /type HealthDocRow = \{/);
  assert.match(healthDocsSource, /function healthDocInner\(doc: HealthDocRow\): string/);
  assert.match(healthDocsSource, /function healthDocHtml\(doc: HealthDocRow, index\?: number\): string/);
  assert.match(healthDocsSource, /Object\.assign\(globalThis, \{/);
  assert.match(healthDocsSource, /CairnHealthDocs/);
  assert.match(healthLearnedSource, /const LEARNED_GROUPS/);
  assert.match(healthLearnedSource, /function learnedItemHtml\(item: unknown, index: number\): string/);
  assert.match(healthLearnedSource, /function learnedTimelineHtml\(data: unknown\): string/);
  assert.match(healthLearnedSource, /CairnHealthLearned/);
  assert.match(healthRecordsSource, /type HealthRecordDocument = /);
  assert.match(healthRecordsSource, /function recordsUploadHtml\(filePrompt = CairnHealthClient\.H_FILE_PROMPT\): string/);
  assert.match(healthRecordsSource, /function recordsListHtml\(docsInput: unknown\): string/);
  assert.match(healthRecordsSource, /CairnHealthRecords/);
  assert.match(memorySource, /const MEM_KINDS/);
  assert.match(memorySource, /function memoryKindOptionsHtml\(selected: unknown = ""\): string/);
  assert.match(memorySource, /function memoryRowHtml\(row: MemoryRow, index\?: number\): string/);
  assert.match(memorySource, /CairnMemory/);
  assert.match(lifeSource, /const LIFE_KINDS/);
  assert.match(lifeSource, /function lifeFieldsHtml\(kind: unknown\): string/);
  assert.match(lifeSource, /function lifeEventHtml\(event: LifeEventRow/);
  assert.match(lifeSource, /CairnLife/);
  assert.match(familySource, /const FAMILY_COLORS/);
  assert.match(familySource, /function familyCardHtml\(row: FamilyRow, index\?: number\): string/);
  assert.match(familySource, /function familySwatches\(selected: unknown\): string/);
  assert.match(familySource, /CairnFamily/);
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
  assert.match(todayAgendaClient, /Object\.assign\(globalThis, \{/);
  assert.match(todayAgendaClient, /CairnTodayAgenda/);
  assert.match(todayTrainingClient, /Object\.assign\(globalThis, \{/);
  assert.match(todayTrainingClient, /CairnTodayTraining/);
  assert.match(todayTrainingClient, /CairnUi\.textChipHtml/);
  assert.match(todayBriefClient, /Object\.assign\(globalThis, \{ CairnTodayBrief: CAIRN_TODAY_BRIEF \}\)/);
  assert.match(todayBriefClient, /window\.CairnTodayBrief = CAIRN_TODAY_BRIEF/);
  assert.match(todayBriefClient, /briefHtml: todayBriefHtml/);
  assert.match(todayBriefClient, /focusBarHtml: todayFocusBarHtml/);
  assert.doesNotMatch(todayBriefClient, /^const\s+BRIEF_KIND|^const\s+BRIEF_OVERRIDES|^function\s+todayBriefHtml/m);
  assert.match(cardioPlanClient, /Object\.assign\(globalThis, \{/);
  assert.match(cardioPlanClient, /CairnCardioPlan/);
  assert.match(cardioSyncClient, /Object\.assign\(globalThis, \{/);
  assert.match(cardioSyncClient, /CairnCardioSync/);
  assert.match(cardioSyncClient, /garminConfigured/);
  assert.match(cardioSyncClient, /cardioSyncLine/);
  assert.doesNotMatch(cardioSyncClient, /^function\s+garminConfigured|^function\s+cardioSyncLine/m);
  assert.doesNotMatch(today, /function\s+garminConfigured|function\s+cardioSyncLine/);
  assert.match(today, /cardio-sync-client\.js/);
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
  assert.match(todaySessionSuggestClient, /Object\.assign\(globalThis, \{ CairnTodaySessionSuggest: CAIRN_TODAY_SESSION_SUGGEST \}\)/);
  assert.match(todaySessionSuggestClient, /window\.CairnTodaySessionSuggest = CAIRN_TODAY_SESSION_SUGGEST/);
  assert.match(todaySessionSuggestClient, /cardHtml: todaySuggestCardHtml/);
  assert.match(todaySessionSuggestClient, /loadingHtml: todaySuggestLoadingHtml/);
  assert.doesNotMatch(todaySessionSuggestClient, /^const\s+SESSION_VIBES|^function\s+todaySuggestCardHtml|^function\s+todaySuggestComposerHtml/m);
  assert.match(todaySessionStatusClient, /CairnTodaySessionStatus: CAIRN_TODAY_SESSION_STATUS/);
  assert.match(todaySessionStatusClient, /setsTonnage: todaySetsTonnage/);
  assert.match(todaySessionStatusClient, /setChipHtml: todaySetChipHtml/);
  assert.match(todaySessionStatusClient, /sessionDoneCardHtml: todaySessionDoneCardHtml/);
  assert.match(todaySessionStatusClient, /feedbackFormHtml: todayFeedbackFormHtml/);
  assert.doesNotMatch(todaySessionStatusClient, /^function\s+setsTonnage|^function\s+setChip|^function\s+todaySessionDoneCardHtml|^function\s+todayFeedbackFormHtml|^const\s+TODAY_FEEL_FACES/m);
  assert.doesNotMatch(meals, /function\s+statusBadge|function\s+applyResultMessage|function\s+clampNoteHtml|function\s+verifiedBadgeHtml|function\s+strengthChangeHtml|function\s+runTargetText|function\s+isOpenProposal|const\s+proposalCardHtml/);
  assert.match(meals, /CairnProposal\.coachProposalListHtml\(proposals, lastApplyClamp\)/);
  assert.match(meals, /proposal-client\.js/);
  assert.doesNotMatch(ui, /function\s+cardioPrescription|function\s+cardioLabel|function\s+isCardioItem/);
  assert.match(progressEnduranceClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnduranceClient, /CairnProgressEndurance/);
  assert.doesNotMatch(progress, /function\s+enduranceStatusWord|function\s+enduranceBlockHtml|function\s+paceTrendWord|function\s+zoneBarHtml|function\s+enduranceBestRows|function\s+enduranceSportCardHtml/);
  assert.match(progressComponentsClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressComponentsClient, /CairnProgressComponents/);
  assert.doesNotMatch(progress, /function\s+progressHero|function\s+emptyStateHtml|const\s+fmtShortDate/);
  assert.match(progressChartClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressChartClient, /CairnProgressChart/);
  assert.match(progressChartClient, /drawLineChart/);
  assert.doesNotMatch(progress, /function\s+withAlpha|function\s+chartColors|function\s+drawLineChart/);
  assert.match(progressHistoryClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressHistoryClient, /CairnProgressHistory/);
  assert.doesNotMatch(progress, /function\s+sessionCardHtml|function\s+numOrNull/);
  assert.match(progressRunPlanClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressRunPlanClient, /CairnProgressRunPlan/);
  assert.doesNotMatch(progress, /function\s+runKindClass|function\s+weeklyRunPlanCard|function\s+enduranceGoalCard|function\s+runComplianceLine|function\s+enduranceCoachLine/);
  assert.match(progressVolumeClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressVolumeClient, /CairnProgressVolume/);
  assert.doesNotMatch(progress, /const\s+PATTERN_WORD|function\s+volBalanceHtml|function\s+capWord/);
  assert.match(progressEnergyClient, /Object\.assign\(globalThis, \{/);
  assert.match(progressEnergyClient, /CairnProgressEnergy/);
  assert.doesNotMatch(progressEnergyClient, /^const\s+ENERGY_CONF_WORD|^function\s+kcalFmt/m);
  assert.doesNotMatch(progress, /const\s+kcalFmt|function\s+energyRead|const\s+CONF_WORD/);
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
  assert.doesNotMatch(progress, /function\s+blockFocusWord|function\s+activeBlockHtml|function\s+startBlockHtml|function\s+loadProgramBlock|function\s+wireProgramBlock/);
  assert.match(planEnduranceClient, /Object\.assign\(globalThis, \{ CairnPlanEndurance: CAIRN_PLAN_ENDURANCE \}\)/);
  assert.match(planEnduranceClient, /window\.CairnPlanEndurance = CAIRN_PLAN_ENDURANCE/);
  assert.doesNotMatch(planEnduranceClient, /^const\s+ENDURANCE_PHASES|^function\s+enduranceRampHtml|^function\s+endDraftCardHtml/m);
  assert.match(planEditorClient, /Object\.assign\(globalThis, \{ CairnPlanEditor: CAIRN_PLAN_EDITOR \}\)/);
  assert.match(planEditorClient, /window\.CairnPlanEditor = CAIRN_PLAN_EDITOR/);
  assert.match(planEditorClient, /dayModelFromPlan/);
  assert.match(planEditorClient, /progDayHtml/);
  assert.doesNotMatch(planEditorClient, /^function\s+progDayHtml|^function\s+pitemHtml|^function\s+pdayHtml/m);
  assert.match(dayFuelClient, /Object\.assign\(globalThis, \{/);
  assert.match(dayFuelClient, /CairnDayFuel/);
  assert.match(dayFuelClient, /MEAL_LABEL/);
  assert.match(dayFuelClient, /dayFuelHtml/);
  assert.doesNotMatch(dayFuelClient, /^const\s+MEAL_LABEL|^function\s+dayFuelHtml/m);
  assert.match(mealPlanClient, /Object\.assign\(globalThis, \{/);
  assert.match(mealPlanClient, /CairnMealPlan/);
  assert.match(mealPlanClient, /mealPlanListHtml/);
  assert.match(mealPlanClient, /mealPrefsHtml/);
  assert.match(mealPlanClient, /mealPlannerBodyHtml/);
  assert.match(mealPlanClient, /mealDayHtml/);
  assert.doesNotMatch(mealPlanClient, /^function\s+mealRowHtml|^function\s+mealPlanListHtml|^function\s+mealPrefsHtml|^function\s+mealPlannerBodyHtml|^function\s+mealDayHtml/m);
  assert.doesNotMatch(meals, /const\s+MEAL_LABEL|function\s+dayFuelHtml|const\s+MEAL_HINT_CHIPS|const\s+MEAL_PREFS_PLACEHOLDER|function\s+mealPrefsHtml|function\s+mealsCtxFor|function\s+mealRowHtml|function\s+mealSlotFor|function\s+mealDayHtml|const\s+mealCardHtml/);
  assert.match(meals, /day-fuel-client\.js/);
  assert.match(meals, /meal-plan-client\.js/);
  assert.match(meals, /CairnMealPlan\.mealPlanListHtml\(plans\)/);
  assert.match(meals, /CairnMealPlan\.mealPlannerBodyHtml\(current, mealPrefs/);
  assert.match(meals, /CairnMealPlan\.mealDayHtml/);
  assert.match(foodNoteClient, /Object\.assign\(globalThis, \{/);
  assert.match(foodNoteClient, /CairnFoodNote/);
  assert.match(foodNoteClient, /foodIngredients/);
  assert.match(foodNoteClient, /noteEntryHtml/);
  assert.doesNotMatch(foodNoteClient, /^function\s+foodIngredients|^function\s+noteEntryHtml|^function\s+parsedNote/m);
  assert.match(healthClient, /Object\.assign\(globalThis, \{ CairnHealthClient: CAIRN_HEALTH_CLIENT \}\)/);
  assert.match(healthClient, /window\.CairnHealthClient = CAIRN_HEALTH_CLIENT/);
  assert.doesNotMatch(healthClient, /^const\s+MAX_DOC_BYTES|^const\s+H_FILE_PROMPT|^const\s+DIRECTIVE_DOMAINS|^function\s+guessUploadMime|^function\s+directiveHtml/m);
  assert.match(healthPictureClient, /Object\.assign\(globalThis, \{ CairnHealthPicture: CAIRN_HEALTH_PICTURE \}\)/);
  assert.match(healthPictureClient, /window\.CairnHealthPicture = CAIRN_HEALTH_PICTURE/);
  assert.match(healthPictureClient, /reviewBusyHtml/);
  assert.match(healthPictureClient, /reviewHtml/);
  assert.doesNotMatch(healthPictureClient, /^function\s+parsedReview|^function\s+reviewHtml/m);
  assert.match(healthMarkersClient, /Object\.assign\(globalThis, \{ CairnHealthMarkers: CAIRN_HEALTH_MARKERS \}\)/);
  assert.match(healthMarkersClient, /window\.CairnHealthMarkers = CAIRN_HEALTH_MARKERS/);
  assert.match(healthMarkersClient, /markerChartSvg/);
  assert.match(healthMarkersClient, /wireMarkerChart/);
  assert.match(healthMarkersClient, /hmkRowHtml/);
  assert.doesNotMatch(healthMarkersClient, /^function\s+markerChartSvg|^function\s+hmkRowHtml/m);
  assert.match(healthDirectivesClient, /Object\.assign\(globalThis, \{ CairnHealthDirectives: CAIRN_HEALTH_DIRECTIVES \}\)/);
  assert.match(healthDirectivesClient, /window\.CairnHealthDirectives = CAIRN_HEALTH_DIRECTIVES/);
  assert.match(healthDirectivesClient, /directivesSectionHtml/);
  assert.match(healthDirectivesClient, /directiveResearchNudgeHtml/);
  assert.doesNotMatch(healthDirectivesClient, /^function\s+directivesSectionHtml|^function\s+directiveResearchNudgeHtml/m);
  assert.match(healthReadClient, /Object\.assign\(globalThis, \{ CairnHealthRead: CAIRN_HEALTH_READ \}\)/);
  assert.match(healthReadClient, /window\.CairnHealthRead = CAIRN_HEALTH_READ/);
  assert.match(healthReadClient, /recoveryHtml/);
  assert.match(healthReadClient, /priorityMarkersSectionHtml/);
  assert.doesNotMatch(healthReadClient, /^function\s+recoveryHtml|^function\s+priorityMarkersSectionHtml|^function\s+optimalPhrase/m);
  assert.match(healthStandingClient, /Object\.assign\(globalThis, \{ CairnHealthStanding: CAIRN_HEALTH_STANDING \}\)/);
  assert.match(healthStandingClient, /window\.CairnHealthStanding = CAIRN_HEALTH_STANDING/);
  assert.match(healthStandingClient, /renderHealthStandingHtml/);
  assert.match(healthStandingClient, /hstandBpCardHtml/);
  assert.match(healthStandingClient, /hstandBodyCompHtml/);
  assert.doesNotMatch(healthStandingClient, /^function\s+renderHealthStandingHtml|^function\s+hstandBpCardHtml|^function\s+hstandBodyCompHtml/m);
  assert.match(healthLearnedClient, /Object\.assign\(globalThis, \{/);
  assert.match(healthLearnedClient, /CairnHealthLearned/);
  assert.doesNotMatch(healthLearnedClient, /^const\s+LEARNED_GROUPS|^function\s+learnedItemHtml/m);
  assert.match(memoryClient, /Object\.assign\(globalThis, \{ CairnMemory: CAIRN_MEMORY \}\)/);
  assert.match(memoryClient, /window\.CairnMemory = CAIRN_MEMORY/);
  assert.doesNotMatch(memoryClient, /^const\s+MEM_KINDS|^function\s+memoryRowHtml/m);
  assert.match(lifeClient, /Object\.assign\(globalThis, \{ CairnLife: CAIRN_LIFE \}\)/);
  assert.match(lifeClient, /window\.CairnLife = CAIRN_LIFE/);
  assert.doesNotMatch(lifeClient, /^const\s+LIFE_KINDS|^function\s+lifeEventHtml/m);
  assert.match(familyClient, /Object\.assign\(globalThis, \{ CairnFamily: CAIRN_FAMILY \}\)/);
  assert.match(familyClient, /window\.CairnFamily = CAIRN_FAMILY/);
  assert.doesNotMatch(familyClient, /^const\s+FAMILY_COLORS|^function\s+familyCardHtml/m);
  assert.match(healthDocsClient, /Object\.assign\(globalThis, \{/);
  assert.match(healthDocsClient, /CairnHealthDocs/);
  assert.match(healthRecordsClient, /Object\.assign\(globalThis, \{ CairnHealthRecords: CAIRN_HEALTH_RECORDS \}\)/);
  assert.match(healthRecordsClient, /window\.CairnHealthRecords = CAIRN_HEALTH_RECORDS/);
  assert.match(healthRecordsClient, /recordsTabHtml/);
  assert.match(healthRecordsClient, /recordsListHtml/);
  assert.doesNotMatch(healthRecordsClient, /^function\s+recordsUploadHtml|^function\s+recordsListHtml/m);
  assert.doesNotMatch(health, /const\s+HEALTH_KINDS|function\s+healthKindLabel|function\s+parsedDoc|function\s+markerFlagClass|function\s+markersTable|function\s+docCollapsible|function\s+healthDocInner|function\s+healthDocHtml/);
  assert.match(chatClient, /Object\.assign\(globalThis, \{ CairnChatClient: CAIRN_CHAT_CLIENT \}\)/);
  assert.match(chatClient, /window\.CairnChatClient = CAIRN_CHAT_CLIENT/);
  assert.match(settingsClient, /Object\.assign\(globalThis, \{/);
  assert.match(settingsClient, /CairnSettingsClient/);
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
  assert.match(ui, /function segBar\(active, items\)[\s\S]*CairnUi\.segmentedNavHtml\(\{ active, items \}\)/);
  assert.match(ui, /function loadingState\(label\)[\s\S]*CairnUi\.loadingStateHtml\(\{ label \}\)/);
  assert.doesNotMatch(ui, /let\s+saveCtx|function\s+mountSaveBar|function\s+hideSaveBar/);
  assert.match(today, /window\.CairnTodayAgenda\.renderableBuckets/);
  assert.match(today, /window\.CairnTodayAgenda\.railHtml/);
  assert.match(today, /window\.CairnTodayAgenda\.fuelCardHtml/);
  assert.match(today, /coachingFocusThreadHtml\(conductor\)/);
  assert.match(today, /CairnTodayTraining\.exRxLineHtml/);
  assert.match(today, /CairnTodayBrief\.briefHtml/);
  assert.match(today, /CairnTodayBrief\.focusBarHtml/);
  assert.match(today, /CairnTodayBrief\.signalsText/);
  assert.doesNotMatch(today, /const\s+BRIEF_KIND\s*=\s*\{|const\s+BRIEF_OVERRIDES\s*=\s*\[|function\s+briefRedirect|function\s+visibleBriefOverrides|function\s+agentOfflineNoticeHtml/);
  assert.match(today, /CairnTodaySessionSuggest\.cardHtml/);
  assert.match(today, /CairnTodaySessionSuggest\.loadingHtml/);
  assert.match(today, /CairnTodaySessionSuggest\.failureHtml/);
  assert.match(today, /CairnTodaySessionSuggest\.composerHtml/);
  assert.doesNotMatch(today, /function\s+suggestItemHtml|function\s+suggestCardHtml|const\s+SESSION_VIBES|sug-card sug-loading|sug-card sug-fail|<div class="sug-composer/);
  assert.match(today, /CairnTodaySessionStatus\.setChipHtml/);
  assert.match(today, /CairnTodaySessionStatus\.sessionDoneCardHtml/);
  assert.match(today, /CairnTodaySessionStatus\.feedbackOpenHtml/);
  assert.match(today, /CairnTodaySessionStatus\.feedbackFormHtml/);
  assert.match(today, /CairnTodaySessionStatus\.feedbackDoneHtml/);
  assert.match(today, /CairnTodaySessionStatus\.skipLineHtml/);
  assert.doesNotMatch(today, /function\s+setsTonnage|function\s+feelScale|class="sessiondone reveal"|id="feedbackOpen"|id="feedbackDismiss"|class="skipline/);
  assert.match(capture, /function loadTrainingProvenance/);
  assert.match(capture, /function loadTodayReads/);
  assert.match(capture, /function reconnectInsight/);
  assert.match(progress, /CairnUi\.jobCaptionHtml\(\{ text: "reading your trend/);
  assert.match(progress, /coachingFocusCardHtml\(f\)/);
  assert.match(meals, /CairnUi\.jobCaptionHtml\(\{ className: "meal-cap job-cap" \}\)/);
  assert.match(meals, /CairnUi\.sheetChipHtml\(\{ label:/);
  assert.match(
    meals,
    /CairnUi\.sheetChipHtml\(\{ className: "sheet-chip sheet-chip-kcal", value: meal\.kcal, label: "cal" \}\)/
  );
  assert.match(health, /CairnHealthClient\.orderMarkersForDisplay/);
  assert.match(health, /loadCoachingFocus\("#cfocusStandingSlot", view\)/);
  assert.match(health, /CairnHealthClient\.lipidGroupNoteHtml/);
  assert.match(health, /CairnHealthMarkers\.formatMarkerNumber/);
  assert.match(health, /CairnHealthMarkers\.markerTrendWord/);
  assert.match(health, /CairnHealthMarkers\.markerChartSvg/);
  assert.match(health, /CairnHealthMarkers\.hmkRowHtml/);
  assert.match(health, /function markerChartSvg\(m\) \{\n {2}return CairnHealthMarkers\.markerChartSvg\(m\);\n\}/);
  assert.match(health, /function wireMarkerChart\(svg\) \{\n {2}return CairnHealthMarkers\.wireMarkerChart\(svg\);\n\}/);
  assert.match(health, /function hmkRowHtml\(m, i\) \{\n {2}return CairnHealthMarkers\.hmkRowHtml\(m, i\);\n\}/);
  assert.match(health, /CairnHealthPicture\.parsedReview/);
  assert.match(health, /CairnHealthPicture\.healthHeroHtml/);
  assert.match(health, /CairnHealthPicture\.reviewHtml/);
  assert.match(health, /CairnHealthStanding\.renderHealthStandingHtml/);
  assert.match(health, /CairnHealthStanding\.localDateTimeInputValue/);
  assert.match(health, /CairnHealthRead\.recoveryNoDataHtml/);
  assert.match(health, /CairnHealthRead\.recoveryHtml/);
  assert.match(health, /CairnHealthRead\.priorityMarkersSectionHtml/);
  assert.doesNotMatch(health, /Catmull-Rom|const W = 300|tipText\.textContent = pts|const rowInner = `<span class="hdot/);
  assert.doesNotMatch(health, /function\s+hstandDecade|function\s+hstandPct|function\s+hstandCompHtml|function\s+hstandRefSummaryHtml|function\s+hstandBodyCompHtml|function\s+hstandBpCardHtml/);
  assert.doesNotMatch(health, /function\s+recoveryHtml|function\s+optimalPhrase|function\s+priorityMarkerHtml|hb-rline|hb-mkphrase/);
  assert.doesNotMatch(health, /const\s+H_FILE_PROMPT|const\s+HEALTH_HERO_ART|const\s+DIRECTIVE_DOMAINS|function\s+guessUploadMime|function\s+directiveHtml/);
  assert.match(health, /CairnMemory\.memoryKindOptionsHtml/);
  assert.match(health, /CairnMemory\.memoryRowHtml/);
  assert.doesNotMatch(health, /const\s+MEM_KINDS|function\s+memoryRowHtml|items\.map\(\(m, i\) => \{/);
  assert.match(health, /CairnFoodNote\.noteEntryHtml/);
  assert.doesNotMatch(health, /function\s+foodIngredients|function\s+ingredientLabel|function\s+foodItemsText|function\s+foodTitleFromIngredients|function\s+foodMacroText|function\s+parsedNote|function\s+noteEntryHtml/);
  assert.match(healthClient, /CairnUi\.emptyStateHtml/);
  assert.match(records, /CairnHealthClient\.H_FILE_PROMPT/);
  assert.match(records, /CairnHealthClient\.guessUploadMime/);
  assert.match(records, /CairnHealthRecords\.recordsTabHtml/);
  assert.match(records, /CairnHealthRecords\.recordsListHtml/);
  assert.match(records, /CairnHealthRecords\.recordsEmptyHtml/);
  assert.match(records, /CairnHealthDocs\.healthDocHtml/);
  assert.match(records, /CairnHealthDocs\.healthDocInner/);
  assert.doesNotMatch(records, /<div class="hupload"|docs\.map\(\(d, i\) => healthDocHtml|(^|[^.])healthDocHtml\(|(^|[^.])healthDocInner\(/m);
  assert.match(records, /CairnHealthDirectives\.directivesSectionHtml/);
  assert.match(records, /CairnHealthDirectives\.evidenceCountMap/);
  assert.doesNotMatch(records, /const\s+H_FILE_PROMPT|const\s+HEALTH_HERO_ART|const\s+DIRECTIVE_DOMAINS|function\s+guessUploadMime|function\s+directiveHtml|CairnHealthClient\.directiveHtml|CairnHealthClient\.DIRECTIVE_DOMAINS/);
  assert.doesNotMatch(records, /let\s+dIdx|const\s+researchNudge|hb-research-nudge[\s\S]*turn on research in Settings/);
  assert.doesNotMatch(records, /const\s+LEARNED_GROUPS|function\s+learnedItemHtml/);
  assert.match(records, /learnedTimelineHtml\(data\)/);
  assert.doesNotMatch(records, /const\s+LIFE_KINDS|function\s+lifeEventHtml|function\s+lifeFieldsHtml/);
  assert.match(records, /CairnLife\.lifeEventHtml/);
  assert.match(records, /CairnLife\.lifeFieldsHtml/);
  assert.doesNotMatch(records, /const\s+FAMILY_COLORS|function\s+familyCardHtml|function\s+familySwatches/);
  assert.match(records, /CairnFamily\.familyCardHtml/);
  assert.match(records, /CairnFamily\.familySwatches/);
  assert.match(chat, /CairnChatClient\.historySessionRow/);
  assert.match(chat, /CairnUi\.jobCaptionHtml\(\)/);
  assert.match(chat, /CairnPlanEndurance\.rampHtml/);
  assert.match(chat, /CairnPlanEndurance\.presets/);
  assert.match(chat, /CairnPlanEndurance\.draftCardHtml/);
  assert.doesNotMatch(chat, /const\s+ENDURANCE_PHASES|function\s+enduranceRampHtml|function\s+endurancePresets|function\s+endDraftCardHtml/);
  assert.match(chat, /CairnPlanEditor\.dayModelFromPlan/);
  assert.match(chat, /CairnPlanEditor\.calendarFooterHtml/);
  assert.match(chat, /CairnPlanEditor\.progDayHtml/);
  assert.match(chat, /CairnPlanEditor\.pdayHtml/);
  assert.doesNotMatch(chat, /function\s+progDayHtml|function\s+pitemHtml|function\s+pdayHtml|const\s+blankStrength|const\s+blankCardio/);
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
  assert.match(sw, /"\/js\/today-agenda-client\.js"/);
  assert.match(sw, /"\/js\/today-training-client\.js"/);
  assert.match(sw, /"\/js\/today-brief-client\.js"/);
  assert.match(sw, /"\/js\/cardio-plan-client\.js"/);
  assert.match(sw, /"\/js\/cardio-sync-client\.js"/);
  assert.match(sw, /"\/js\/proposal-client\.js"/);
  assert.match(sw, /"\/js\/today-session-suggest-client\.js"/);
  assert.match(sw, /"\/js\/today-session-status-client\.js"/);
  assert.match(sw, /"\/js\/progress-endurance-client\.js"/);
  assert.match(sw, /"\/js\/progress-components-client\.js"/);
  assert.match(sw, /"\/js\/progress-chart-client\.js"/);
  assert.match(sw, /"\/js\/progress-history-client\.js"/);
  assert.match(sw, /"\/js\/progress-run-plan-client\.js"/);
  assert.match(sw, /"\/js\/progress-volume-client\.js"/);
  assert.match(sw, /"\/js\/progress-energy-client\.js"/);
  assert.match(sw, /"\/js\/progress-calendar-client\.js"/);
  assert.match(sw, /"\/js\/progress-muscle-trajectory-client\.js"/);
  assert.match(sw, /"\/js\/progress-dexa-targeting-client\.js"/);
  assert.match(sw, /"\/js\/progress-performance-client\.js"/);
  assert.match(sw, /"\/js\/progress-program-adjustments-client\.js"/);
  assert.match(sw, /"\/js\/progress-test-week-client\.js"/);
  assert.match(sw, /"\/js\/progress-program-summary-client\.js"/);
  assert.match(sw, /"\/js\/progress-program-block-client\.js"/);
  assert.match(sw, /"\/js\/coaching-focus-client\.js"/);
  assert.match(sw, /"\/js\/markdown-client\.js"/);
  assert.match(sw, /"\/js\/today-activity-client\.js"/);
  assert.match(sw, /"\/js\/pwa-install-coach\.js"/);
  assert.match(sw, /"\/js\/rest-timer\.js"/);
  assert.match(sw, /"\/js\/ui-components\.js"/);
  assert.match(sw, /"\/js\/day-fuel-client\.js"/);
  assert.match(sw, /"\/js\/meal-plan-client\.js"/);
  assert.match(sw, /"\/js\/food-note-client\.js"/);
  assert.match(sw, /"\/js\/health-client\.js"/);
  assert.match(sw, /"\/js\/health-read-client\.js"/);
  assert.match(sw, /"\/js\/health-standing-client\.js"/);
  assert.match(sw, /"\/js\/health-learned-client\.js"/);
  assert.match(sw, /"\/js\/health-records-client\.js"/);
  assert.match(sw, /"\/js\/memory-client\.js"/);
  assert.match(sw, /"\/js\/life-client\.js"/);
  assert.match(sw, /"\/js\/family-client\.js"/);
  assert.match(sw, /"\/js\/health-docs-client\.js"/);
  assert.match(sw, /"\/js\/chat-client\.js"/);
  assert.match(sw, /"\/js\/plan-endurance-client\.js"/);
  assert.match(sw, /"\/js\/plan-editor-client\.js"/);
  assert.match(sw, /"\/js\/day-fuel-client\.js"/);
  assert.match(sw, /"\/js\/meal-plan-client\.js"/);
  assert.match(sw, /"\/js\/settings-client\.js"/);
  assert.match(sw, /"\/js\/settings-screen\.js"/);
  assert.match(sw, /"\/js\/app-download\.js"/);
  assert.match(sw, /"\/js\/app-sw-recovery\.js"/);
  assert.match(sw, /"\/js\/save-bar\.js"/);
  assert.match(sw, /"\/js\/app-route-sync\.js"/);
  assert.match(sw, /"\/js\/app-render-dispatch\.js"/);
  assert.match(sw, /"\/js\/app-tabs\.js"/);
  assert.match(sw, /"\/js\/app-job-reconnectors\.js"/);
  assert.match(sw, /"\/js\/app-mobile-viewport\.js"/);
  assert.match(sw, /"\/js\/app-service-worker\.js"/);
  assert.match(sw, /"\/js\/app-discipline-primer\.js"/);
  assert.match(sw, /"\/js\/app-onboarding\.js"/);
  assert.match(sw, /"\/js\/app-startup\.js"/);
  assert.match(dockerfile, /COPY package\*\.json tsconfig\.json tsconfig\.client\.build\.json \.\//);
  assert.match(dockerfile, /COPY scripts\/build-client\.mjs \.\/scripts\/build-client\.mjs/);
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
