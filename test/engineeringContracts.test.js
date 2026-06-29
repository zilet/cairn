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
  const api = [
    "src/api.ts",
    "src/routes/connected-brain.ts",
    "src/routes/day-coach.ts",
    "src/routes/memory-learning.ts",
    "src/routes/nutrition.ts",
    "src/routes/program.ts",
  ].map(read).join("\n");
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
    /api\.(get|post|put|delete|patch)\("\/(?:health(?:\/|")|markers(?:\/|")|reaction-model"|trajectory"|context-effect"|next-step(?:\/|")|coaching-focus"|directives(?:\/|")|symptom-links"|research"|evidence(?:\/|")|insights(?:\/|"))/,
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
    /api\.(get|post|put|delete|patch)\("\/(?:agents(?:\/|")|agent-clis\/update|settings"|agent-stats")/,
  );
  assert.match(operatorRoutes, /operatorRouter\.get\("\/agents"/);
  assert.match(operatorRoutes, /operatorRouter\.put\("\/settings"/);
  assert.match(operatorRoutes, /operatorRouter\.get\("\/agent-stats"/);
  assert.match(api, /api\.use\("\/",\s*personContextRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:context-events(?:\/|")|injury-impacts"|family(?:\/|")|supplements(?:\/|")|onboard")/,
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
  assert.doesNotMatch(api, /api\.(get|post|put|delete|patch)\("\/(?:export(?:\/|")|health-export"|health-report(?:\.txt)?")/);
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
    /api\.(get|post|put|delete|patch)\("\/(?:memory(?:\/|")|profile\/grow-about-me"|suggestions(?:\/|")|learnings")/,
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
    /api\.(get|post|put|delete|patch)\("\/(?:coach\/mealplan|mealplans(?:\/|")|nutrition(?:\/|")|meal-plans(?:\/|")|food-notes(?:\/|")|frequent-foods"|chat-images(?:\/|"))/,
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
    /api\.(get|post|put|delete|patch)\("\/(?:profile"|goal"|bodyweight(?:\/|")|blood-pressure(?:\/|")|checkins(?:\/|"))/,
  );
  assert.match(personRoutes, /personRouter\.get\("\/profile"/);
  assert.match(personRoutes, /personRouter\.post\("\/blood-pressure"/);
  assert.match(personRoutes, /personRouter\.get\("\/checkins"/);
  assert.match(api, /api\.use\("\/",\s*planExercisesRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:plan(?:\/|\.ics"|")|exercises(?:\/|")|exercise(?:\/|")|program\/variations")/,
  );
  assert.match(planExerciseRoutes, /planExercisesRouter\.get\("\/plan"/);
  assert.ok(
    planExerciseRoutes.indexOf('planExercisesRouter.get("/plan.ics"') >
      planExerciseRoutes.indexOf('planExercisesRouter.get("/plan"') &&
      planExerciseRoutes.indexOf('planExercisesRouter.get("/plan.ics"') <
      planExerciseRoutes.indexOf('planExercisesRouter.get("/plan/:day"'),
    "plan.ics route must stay before /plan/:day",
  );
  assert.match(planExerciseRoutes, /planExercisesRouter\.post\("\/exercises\/reconcile-groups"/);
  assert.match(planExerciseRoutes, /planExercisesRouter\.get\("\/program\/variations"/);
  assert.match(planExerciseRoutes, /decodeURIComponent\(req\.params\.name\)/);
  assert.match(api, /api\.use\("\/",\s*programRouter\)/);
  assert.doesNotMatch(
    api,
    /api\.(get|post|put|delete|patch)\("\/(?:agent\/run|program(?:\/|")|proposals(?:\/|")|program-state"|performance"|run-plan"|run-zones"|muscle-trajectory"|test-week"|dexa-targeting")/,
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
    /api\.(get|post|put|delete|patch)\("\/(?:sessions(?:\/|")|last-set"|sets(?:\/|")|progress(?:\/|")|activities(?:\/|")|recent-training"|stats"|endurance-prs"|run-compliance"|cardio"|endurance-goal"|volume"|calendar")/,
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
  assert.match(sw, /"\/js\/format-utils\.js"/);
  assert.match(sw, /"\/js\/api-client\.js"/);
  assert.match(sw, /"\/js\/swr-cache\.js"/);
  assert.match(sw, /"\/js\/today-agenda-client\.js"/);
  assert.match(sw, /"\/js\/today-training-client\.js"/);
  assert.match(sw, /"\/js\/health-client\.js"/);
  assert.match(sw, /"\/js\/chat-client\.js"/);
  assert.match(sw, /"\/js\/settings-client\.js"/);
  assert.match(sw, /"\/js\/route-state\.js"/);
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
  const boot = read("public/js/10-boot.js");
  const ui = read("public/js/02-ui.js");
  const meals = read("public/js/06-coach-meals.js");
  const health = read("public/js/07-me-health.js");
  const records = read("public/js/08-me-records.js");
  const chat = read("public/js/09-plan-chat.js");
  const chatClient = read("public/js/chat-client.js");
  assert.ok(
    index.indexOf('/js/route-state.js') > -1 &&
      index.indexOf('/js/route-state.js') < index.indexOf('/js/10-boot.js'),
    "route-state.js must load before 10-boot.js",
  );
  assert.match(boot, /function\s+applyRouteState/);
  assert.match(boot, /function\s+syncRouteFromState/);
  assert.match(boot, /parseRoute\(location\.href\)/);
  assert.match(boot, /window\.addEventListener\("popstate"/);
  assert.match(boot, /history\[fn\]\(\{ cairn: true \},\s*"",\s*next\)/);
  assert.match(boot, /function\s+switchTab\(tab,\s*opts\s*=\s*\{\}\)/);
  assert.match(boot, /function\s+activateTab\(name,\s*opts\s*=\s*\{\}\)/);
  assert.match(ui, /syncRouteFromState\(\)/, "shared UI events should notify route sync");
  assert.match(meals, /api\("\/nutrition\/day"\s*\+\s*qs\)/, "Plan Food must fetch the routed local day");
  assert.match(health, /setHealthSegActive\(b\.dataset\.hseg\)[\s\S]*syncRouteFromState\(\)/);
  assert.match(records, /state\.pendingHealthDocId[\s\S]*scrollIntoView/);
  assert.match(boot, /state\.pendingChatSession\s*=\s*route\.session\s*\|\|\s*null/);
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
    "old DBs do not have chat_messages.session_id until migration v49 runs",
  );
  assert.match(migrations, /addColumn\(db,\s*"chat_messages",\s*"session_id TEXT"\)/);
  assert.match(migrations, /CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages\(session_id\)/);
});

test("frontend TypeScript contract gate is dependency-light and backed by server payloads", () => {
  const pkg = JSON.parse(read("package.json"));
  const clientTsconfig = read("tsconfig.client.json");
  const contracts = read("src/contracts/client.ts");
  const compat = read("src/contracts/client-compat.ts");
  const routeState = read("public/js/route-state.js");
  const dateUtils = read("public/js/date-utils.js");
  const htmlUtils = read("public/js/html-utils.js");
  const formatUtils = read("public/js/format-utils.js");
  const apiClient = read("public/js/api-client.js");
  const swrCache = read("public/js/swr-cache.js");
  const todayAgendaClient = read("public/js/today-agenda-client.js");
  const todayTrainingClient = read("public/js/today-training-client.js");
  const healthClient = read("public/js/health-client.js");
  const chatClient = read("public/js/chat-client.js");
  const settingsClient = read("public/js/settings-client.js");
  const publicScriptCheck = read("scripts/check-public-scripts.mjs");
  const today = read("public/js/03-today.js");
  const health = read("public/js/07-me-health.js");
  const chat = read("public/js/09-plan-chat.js");
  const boot = read("public/js/10-boot.js");
  const sw = read("public/sw.js");
  const index = read("public/index.html");
  assert.equal(pkg.scripts["typecheck:client"], "tsc -p tsconfig.client.json");
  assert.equal(pkg.scripts["public:check"], "node scripts/check-public-scripts.mjs");
  assert.match(pkg.scripts.verify, /npm run typecheck:client/);
  assert.match(pkg.scripts.verify, /npm run public:check/);
  assert.match(clientTsconfig, /"allowJs": true/);
  assert.match(clientTsconfig, /"checkJs": true/);
  assert.match(clientTsconfig, /"noEmit": true/);
  assert.match(clientTsconfig, /src\/contracts\/client-globals\.d\.ts/);
  assert.match(clientTsconfig, /public\/js\/date-utils\.js/);
  assert.match(clientTsconfig, /public\/js\/html-utils\.js/);
  assert.match(clientTsconfig, /public\/js\/format-utils\.js/);
  assert.match(clientTsconfig, /public\/js\/api-client\.js/);
  assert.match(clientTsconfig, /public\/js\/swr-cache\.js/);
  assert.match(clientTsconfig, /public\/js\/today-agenda-client\.js/);
  assert.match(clientTsconfig, /public\/js\/today-training-client\.js/);
  assert.match(clientTsconfig, /public\/js\/chat-client\.js/);
  assert.match(clientTsconfig, /public\/js\/health-client\.js/);
  assert.match(clientTsconfig, /public\/js\/settings-client\.js/);
  assert.match(clientTsconfig, /public\/js\/route-state\.js/);
  assert.ok(
    index.indexOf('/js/date-utils.js') > -1 &&
      index.indexOf('/js/date-utils.js') < index.indexOf('/js/01-core.js'),
    "date-utils.js must load before 01-core.js",
  );
  assert.ok(
    index.indexOf('/js/date-utils.js') > -1 &&
      index.indexOf('/js/api-client.js') > index.indexOf('/js/date-utils.js') &&
      index.indexOf('/js/api-client.js') < index.indexOf('/js/01-core.js'),
    "api-client.js must load after date-utils.js and before 01-core.js",
  );
  assert.ok(
    index.indexOf('/js/html-utils.js') > -1 &&
      index.indexOf('/js/html-utils.js') < index.indexOf('/js/02-ui.js'),
    "html-utils.js must load before 02-ui.js and feature modules",
  );
  assert.ok(
    index.indexOf('/js/format-utils.js') > -1 &&
      index.indexOf('/js/format-utils.js') < index.indexOf('/js/02-ui.js'),
    "format-utils.js must load before 02-ui.js and feature modules",
  );
  assert.ok(
    index.indexOf('/js/02-ui.js') > -1 &&
      index.indexOf('/js/swr-cache.js') > index.indexOf('/js/02-ui.js') &&
      index.indexOf('/js/swr-cache.js') < index.indexOf('/js/03-today.js'),
    "swr-cache.js must load after 02-ui.js and before feature modules",
  );
  assert.ok(
    index.indexOf('/js/today-agenda-client.js') > index.indexOf('/js/swr-cache.js') &&
      index.indexOf('/js/today-agenda-client.js') < index.indexOf('/js/03-today.js'),
    "today-agenda-client.js must load after swr-cache.js and before 03-today.js",
  );
  assert.ok(
    index.indexOf('/js/today-training-client.js') > index.indexOf('/js/today-agenda-client.js') &&
      index.indexOf('/js/today-training-client.js') < index.indexOf('/js/03-today.js'),
    "today-training-client.js must load before 03-today.js",
  );
  assert.ok(
    index.indexOf('/js/health-client.js') > index.indexOf('/js/07-me-health.js') &&
      index.indexOf('/js/health-client.js') < index.indexOf('/js/08-me-records.js'),
    "health-client.js must load after Health view definitions and before Records view hydration",
  );
  assert.ok(
    index.indexOf('/js/chat-client.js') > index.indexOf('/js/08-me-records.js') &&
      index.indexOf('/js/chat-client.js') < index.indexOf('/js/09-plan-chat.js'),
    "chat-client.js must load before 09-plan-chat.js",
  );
  assert.ok(
    index.indexOf('/js/settings-client.js') > index.indexOf('/js/settings-routes.js') &&
      index.indexOf('/js/settings-client.js') < index.indexOf('/js/10-boot.js'),
    "settings-client.js must load before 10-boot.js",
  );
  assert.match(dateUtils, /\/\/ @ts-check/);
  assert.match(htmlUtils, /\/\/ @ts-check/);
  assert.match(formatUtils, /\/\/ @ts-check/);
  assert.match(apiClient, /\/\/ @ts-check/);
  assert.match(swrCache, /\/\/ @ts-check/);
  assert.match(todayAgendaClient, /\/\/ @ts-check/);
  assert.match(todayTrainingClient, /\/\/ @ts-check/);
  assert.match(healthClient, /\/\/ @ts-check/);
  assert.match(chatClient, /\/\/ @ts-check/);
  assert.match(settingsClient, /\/\/ @ts-check/);
  assert.match(publicScriptCheck, /ts\.createSourceFile/);
  assert.match(publicScriptCheck, /topLevelBindings/);
  assert.match(publicScriptCheck, /prior\.lexical\s*\|\|\s*binding\.lexical/);
  assert.match(publicScriptCheck, /public app-shell script globals are safe/);
  assert.match(contracts, /export interface ClientApiResponses/);
  assert.match(contracts, /"\/api\/today-agenda": ClientTodayAgenda/);
  assert.match(contracts, /"\/api\/nutrition\/day": ClientDayIntake/);
  assert.match(contracts, /"\/api\/chat\/sessions": ClientChatSessionSummary\[\]/);
  assert.match(contracts, /"\/api\/chat\/sessions\/:sessionId": ClientChatMessage\[\]/);
  assert.match(contracts, /export type ClientApiResponse<Path extends string>/);
  assert.match(compat, /AssertAssignable<TodayAgenda, ClientTodayAgenda>/);
  assert.match(compat, /ReturnType<typeof getDayIntake>/);
  assert.match(compat, /AssertAssignable<ArchivedChatSession, ClientChatSessionSummary>/);
  assert.match(compat, /AssertAssignable<ChatSearchHit, ClientChatSearchHit>/);
  assert.match(routeState, /import\("\.\.\/\.\.\/src\/contracts\/client\.js"\)\.ClientRoute/);
  assert.match(apiClient, /ClientApiResponse<Path>/);
  assert.doesNotMatch(apiClient, /@returns\s*\{Promise<any>\}/);
  assert.match(swrCache, /CachedApiOptions<import\("\.\.\/\.\.\/src\/contracts\/client\.js"\)\.ClientApiResponse<Path>>/);
  assert.match(swrCache, /PaintSwrOptions<import\("\.\.\/\.\.\/src\/contracts\/client\.js"\)\.ClientApiResponse<Path>>/);
  assert.doesNotMatch(swrCache, /@returns\s*\{Promise<any>\}/);
  assert.match(todayAgendaClient, /ClientTodayAgenda/);
  assert.match(todayAgendaClient, /ClientDayIntake/);
  assert.match(todayAgendaClient, /window\.CairnTodayAgenda/);
  assert.match(todayTrainingClient, /window\.CairnTodayTraining/);
  assert.match(healthClient, /window\.CairnHealthClient/);
  assert.match(chatClient, /window\.CairnChatClient/);
  assert.match(settingsClient, /window\.CairnSettingsClient/);
  assert.match(today, /window\.CairnTodayAgenda\.renderableBuckets/);
  assert.match(today, /window\.CairnTodayAgenda\.railHtml/);
  assert.match(today, /window\.CairnTodayAgenda\.fuelCardHtml/);
  assert.match(today, /CairnTodayTraining\.exRxLineHtml/);
  assert.match(health, /CairnHealthClient\.orderMarkersForDisplay/);
  assert.match(health, /CairnHealthClient\.lipidGroupNoteHtml/);
  assert.match(chat, /CairnChatClient\.historySessionRow/);
  assert.match(boot, /CairnSettingsClient\.updateCardHtml/);
  assert.match(sw, /"\/js\/today-agenda-client\.js"/);
  assert.match(sw, /"\/js\/today-training-client\.js"/);
  assert.match(sw, /"\/js\/health-client\.js"/);
  assert.match(sw, /"\/js\/chat-client\.js"/);
  assert.match(sw, /"\/js\/settings-client\.js"/);
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
