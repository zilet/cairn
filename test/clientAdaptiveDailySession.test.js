import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
// Today's launch card (and the facts it shares with the Brief) — drawn by today-screen.ts.
const launch = readFileSync(join(root, "src/client/today-session-launch-client.ts"), "utf8");
const sessionShell = readFileSync(join(root, "src/client/session-snapshot-client.ts"), "utf8");
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
  // A conflict opens its owner or re-reads today (today-open-session-client.ts) — never a dead-end toast.
  assert.match(today, /CairnTodayOpenSession\.resolveConflict\(targetDate, response, openSessionDeps\(targetDate, trigger\)\)/);
  assert.match(today, /adaptiveSessionPreviewDelta\(adaptivePreview, fresh\)/);
  assert.match(
    today,
    /re-wires Start with the fresh preview fingerprint[\s\S]*await renderToday\(\{ soft: true \}\)/,
    "stale recovery must replace the captured token rather than patching only visible text",
  );
  assert.match(today, /return false;[\s\S]*response\?\.ok !== true/, "stale preview never enters Session");
  assert.match(today, /"This session could not be prepared\. Try again in a moment\."/);
  assert.doesNotMatch(today, /response\?\.error/, "the athlete never reads raw server text");
  assert.doesNotMatch(today, /samePlanDay|\/daily-session\?date=/, "explicit plan starts are expressed to the server");
  assert.match(plan, /source: "athlete_override"[\s\S]*replace: true[\s\S]*entry: "empty_plan"/);
  assert.match(suggestion, /source: "agent_suggest"[\s\S]*replace: true/);
  assert.doesNotMatch(plan, /\/plan[^\n]*method: "POST"[\s\S]*data-trainday/);
  assert.match(suggestion, /input\.request\.train_anyway === true\) return null/);
});

test("prepared Session exposes durable source, rationale, and accessible stable entry", () => {
  const todaySurface = today + launch;
  assert.match(todaySurface, /"Built for today"/);
  assert.match(todaySurface, /"Adapted for today"/);
  assert.match(todaySurface, /"Training by choice"/);
  assert.match(todaySurface, /`From plan\$\{day && day\.name/);
  assert.match(todaySurface, /dailySession\?\.why/);
  assert.match(todaySurface, /dailySession\?\.est_minutes/);
  // The session shell (its one heading) lives with the session's first paint.
  assert.match(sessionShell, /role="heading" aria-level="1" tabindex="-1"/);
  assert.match(today, /focus\(\{ preventScroll: true \}\)/);
  assert.match(todaySurface, /role="status" aria-live="polite"/);
  assert.match(today, /id = "sessionPrepareLive"|status\.id = "sessionPrepareLive"/);
  assert.match(todaySurface, /preview\?\.title/);
  assert.match(todaySurface, /preview\?\.primary_rationale/);
  assert.match(todaySurface, /preview\.constraints\.slice\(0, 2\)/);
  assert.equal(
    (today.match(/wireExerciseDecisionUndo\(todayView,/g) || []).length,
    2,
    "Today and focused Session both wire accountable exercise rollback",
  );
  assert.match(today, /wireExerciseDecisionUndo\(todayView, \(\) => renderSession\(\{ soft: true \}\)\)/);
});

test("one-day custom prescriptions render as prescribed without becoming weekly-plan work", () => {
  assert.match(cards, /const offPlan = !item\.fromPlan && !item\.fromSession/);
  // The composition's saved order is the card order by construction now: the old
  // preserveItemOrder switch only existed to stop runs being floated above lifts,
  // and a run is no longer a card in the lift list at all.
  assert.doesNotMatch(today, /preserveItemOrder/);
  assert.match(suggestion, /source: "agent_suggest"/);
  assert.match(suggestion, /agentJobId: context\.agentJobId/);
});

test("the launch card gate keeps a null preview's calm door open and only a positively-empty preview suppresses it", () => {
  // Pin the exact expressions today-screen.ts computes, so a refactor that
  // changes their shape fails here rather than silently changing which of the
  // three plan-region outcomes (suppressed / launch card / plan-surface
  // fallthrough) a given day renders into.
  assert.match(today, /const previewHasItems = open \? true : previewItemCount == null \? null : previewItemCount > 0;/);
  assert.match(today, /const dayHasItems = !!\(day\?\.items \|\| \[\]\)\.length;/);
  assert.match(
    today,
    /const unreadPick = !open && !!day\.pick;\s*\n\s*const nothingToStart =\s*\n\s*unreadPick \|\|\s*\n\s*\(!open && todayState\.plan\.length > 0 && !hasLoggedSets && exDone === 0 && !isRunDay && !dayHasItems && previewHasItems !== true\);/,
  );
  assert.match(
    today,
    /showPlan && !showDone && nothingToStart && !unreadPick\s*\n\s*\? ""\s*\n\s*: showPlan && !showDone && previewHasItems !== false && !unreadPick\s*\n\s*\? briefCarriesStart\s*\n\s*\? ""\s*\n\s*: sessionLaunchCardHtml\(launchOpts\)/,
  );
  // One action, one button: the card folds into the Brief only when the Brief
  // itself carries the start for the same session (a train read).
  assert.match(
    today,
    /const briefCarriesStart =\s*\n\s*showPlan && !showDone && !nothingToStart && previewHasItems !== false && CairnTodayBrief\.kind\(CairnTodayOpenSession\.briefRead\(read, open\)\) === "train";/,
  );

  // A faithful reimplementation of that same formula (verified above to match
  // the source verbatim), exercised against the four witness combinations the
  // comment above `previewItemCount` calls out.
  function planRegionFor({ previewItemCount, hasPlan, hasLoggedSets, dayHasItems, kind = "rest", pick = false }) {
    const previewHasItems = previewItemCount == null ? null : previewItemCount > 0;
    const nothingToStart =
      pick || (hasPlan && !hasLoggedSets && !dayHasItems && previewHasItems !== true);
    const showPlan = true;
    const showDone = false;
    const briefCarriesStart = showPlan && !showDone && !nothingToStart && previewHasItems !== false && kind === "train";
    if (showPlan && !showDone && nothingToStart && !pick) return "suppressed";
    if (showPlan && !showDone && previewHasItems !== false && !pick) return briefCarriesStart ? "brief-start" : "launch-card";
    return "plan-surface";
  }

  assert.equal(
    planRegionFor({ previewItemCount: 5, hasPlan: true, hasLoggedSets: true, dayHasItems: true, kind: "train" }),
    "brief-start",
    "a train read's Brief carries the one start; the duplicate card is not drawn",
  );
  assert.equal(
    planRegionFor({ previewItemCount: 5, hasPlan: true, hasLoggedSets: false, dayHasItems: true, kind: "easy" }),
    "launch-card",
    "an easy/rest read offers no start of its own, so the card stays the way in",
  );

  assert.equal(
    planRegionFor({ previewItemCount: null, hasPlan: true, hasLoggedSets: false, dayHasItems: true }),
    "launch-card",
    "a null preview never overrules a plan day that carries items",
  );
  assert.equal(
    planRegionFor({ previewItemCount: null, hasPlan: false, hasLoggedSets: false, dayHasItems: false }),
    "launch-card",
    "no plan at all is the deliberate Open session door",
  );
  assert.equal(
    planRegionFor({ previewItemCount: 0, hasPlan: true, hasLoggedSets: false, dayHasItems: true }),
    "plan-surface",
    "a preview/plan disagreement falls through to the plan surface renderer, not the launch card",
  );
  assert.equal(
    planRegionFor({ previewItemCount: 0, hasPlan: true, hasLoggedSets: false, dayHasItems: false }),
    "suppressed",
    "every witness agreeing the day is empty is what suppresses the launch card",
  );
  // Offline with no remembered plan-day pick (day.pick): no launch card into a day
  // Cairn cannot vouch for — the plan surface stands with its pills and a pick line.
  assert.equal(
    planRegionFor({ previewItemCount: null, hasPlan: true, hasLoggedSets: false, dayHasItems: false, pick: true }),
    "plan-surface",
    "an unread pick asks the athlete to choose a day",
  );
  // A remembered/offline preview can still report items in the pick state: the Brief
  // must not then carry a Start beside the surface that asks which day it is.
  assert.equal(
    planRegionFor({ previewItemCount: 5, hasPlan: true, hasLoggedSets: false, dayHasItems: false, kind: "train", pick: true }),
    "plan-surface",
    "the pick state offers no Brief start, whatever the preview says",
  );
});

test("legacy capture-prefill routes to Chat without logging implicitly; the run card's log CTA is gone", () => {
  // The focused Session's "Review & log this run" CTA lived on the run card inside
  // the lift list. Runs left the strength plan, so neither the card nor its wiring
  // remains; a run is logged by sync or in Chat, never implicitly.
  assert.doesNotMatch(today, /data-cardio-log/);
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
