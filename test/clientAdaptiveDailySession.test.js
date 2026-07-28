import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
const brief = readFileSync(join(root, "src/client/today-brief-actions-client.ts"), "utf8");
const overview = readFileSync(join(root, "src/client/progress-overview-client.ts"), "utf8");
const plan = readFileSync(join(root, "src/client/plan-editor-controller.ts"), "utf8");
const cards = readFileSync(join(root, "src/client/today-cards-client.ts"), "utf8");
const suggestion = readFileSync(join(root, "src/client/today-session-suggest-controller.ts"), "utf8");

test("primary training entries converge on one durable prepare path", () => {
  assert.match(today, /todayApi\("\/daily-session\/prepare"/);
  assert.match(today, /source: "adaptive_plan"[\s\S]*entry: "today_launch"/);
  assert.match(
    brief,
    /source: "adaptive_plan"[\s\S]*trainAnyway: action === "reveal-plan"[\s\S]*replace: action === "reveal-plan"[\s\S]*entry: action === "reveal-plan" \? "train_anyway" : "brief_start"/
  );
  assert.match(overview, /source: "adaptive_plan"[\s\S]*entry: "train_overview"/);
  assert.match(plan, /source: "manual_plan"[\s\S]*dayNumber: state\.day[\s\S]*replace: true/);
  assert.match(today, /sessionPrepareCoordinator\.run\(targetDate/);
  assert.match(today, /const explicitReplacement = options\.replace === true/);
  assert.match(today, /body\.replace = explicitReplacement/);
  assert.match(today, /source === "manual_plan" && todayState\.day != null/);
  assert.match(today, /if \(source === "manual_plan" && dayNumber != null\) body\.day_number = dayNumber/);
  assert.doesNotMatch(
    today,
    /source === "adaptive_plan"[^\n]*day_number|body\.day_number[^\n]*adaptive_plan/,
    "adaptive entry leaves day selection to the server",
  );
  assert.match(today, /expected_active_id: expectedActiveId/);
  assert.match(today, /continuation\.staged === true/);
  assert.match(today, /Number\(daily\.id\) === expectedActiveId/);
  assert.match(today, /acceptErrorBody: true/);
  assert.match(today, /outboxEnqueue\?\.\("daily_session_prepare", "\/daily-session\/prepare", body,[\s\S]*prepareIntent/);
  assert.match(today, /stagedPrepareResponse[\s\S]*enterSession\(targetDate, staged\)/);
  assert.match(today, /meaningfulLegacySession\(cachedSession, explicitReplacement\)/);
  assert.match(today, /body\.agent_job_id = agentJobId/);
  assert.match(today, /if \(options\.trainAnyway === true\) body\.train_anyway = true/);
  assert.match(today, /preview: sessionPreview/);
  assert.match(today, /adaptivePreview = reviewed/);
  assert.match(today, /never silently authorize a[\s\S]*session/);
  assert.match(today, /body\.expected_input_fingerprint = adaptivePreview\.input_fingerprint/);
  assert.match(today, /response\.code === "daily_session_preview_stale"/);
  assert.match(today, /response\.code === "daily_session_active_changed"/);
  assert.match(today, /adaptiveSessionPreviewDelta\(adaptivePreview, fresh\)/);
  assert.match(
    today,
    /re-wires Start with the fresh preview fingerprint[\s\S]*await renderToday\(\{ soft: true \}\)/,
    "stale recovery must replace the captured token rather than patching only visible text",
  );
  assert.match(today, /return false;[\s\S]*response\?\.ok !== true/, "stale preview never enters Session");
  assert.match(today, /response\?\.error \|\| "This session could not be prepared\."/);
  assert.doesNotMatch(today, /samePlanDay|\/daily-session\?date=/, "explicit plan starts are expressed to the server");
  assert.match(plan, /source: "athlete_override"[\s\S]*replace: true[\s\S]*entry: "empty_plan"/);
  assert.match(suggestion, /source: "agent_suggest"[\s\S]*replace: true/);
  assert.doesNotMatch(plan, /\/plan[^\n]*method: "POST"[\s\S]*data-trainday/);
  assert.match(suggestion, /input\.request\.train_anyway === true\) return null/);
});

test("prepared Session exposes durable source, rationale, and accessible stable entry", () => {
  assert.match(today, /"Built for today"/);
  assert.match(today, /"Adapted for today"/);
  assert.match(today, /"Training by choice"/);
  assert.match(today, /`From plan\$\{day && day\.name/);
  assert.match(today, /dailySession\?\.why/);
  assert.match(today, /dailySession\?\.est_minutes/);
  assert.match(today, /role="heading" aria-level="1" tabindex="-1"/);
  assert.match(today, /focus\(\{ preventScroll: true \}\)/);
  assert.match(today, /role="status" aria-live="polite"/);
  assert.match(today, /id = "sessionPrepareLive"|status\.id = "sessionPrepareLive"/);
  assert.match(today, /preview\?\.title/);
  assert.match(today, /preview\?\.primary_rationale/);
  assert.match(today, /preview\.constraints\.slice\(0, 2\)/);
  assert.equal(
    (today.match(/wireExerciseDecisionUndo\(todayView,/g) || []).length,
    2,
    "Today and focused Session both wire accountable exercise rollback",
  );
  assert.match(today, /wireExerciseDecisionUndo\(todayView, \(\) => renderSession\(\{ soft: true \}\)\)/);
});

test("one-day custom prescriptions render as prescribed without becoming weekly-plan work", () => {
  assert.match(cards, /const offPlan = !item\.fromPlan && !item\.fromSession/);
  assert.match(today, /preserveItemOrder: !!dailySession/);
  assert.match(suggestion, /source: "agent_suggest"/);
  assert.match(suggestion, /agentJobId: context\.agentJobId/);
});

test("focused cardio and legacy capture-prefill route to Chat without logging implicitly", () => {
  assert.match(today, /\.sess-dest \[data-cardio-log\]/);
  assert.match(today, /todayState\.chatPrefill = phrase;[\s\S]*activateTab\("chat"\)/);
  assert.doesNotMatch(today, /todayState\.capturePrefill = phrase/);

  const context = { window: null, globalThis: null, Object, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-post-render-wiring.js"), "utf8"), context);
  const activated = [];
  const deps = {
    root: { querySelector: () => null },
    state: { capturePrefill: "ran 8 km (Z2)" },
    activateTab: (tab) => activated.push(tab),
  };

  assert.equal(context.CairnTodayPostRenderWiring.applyPendingCapture(deps), true);
  assert.equal(deps.state.capturePrefill, null);
  assert.equal(deps.state.chatPrefill, "ran 8 km (Z2)");
  assert.deepEqual(activated, ["chat"]);
});
