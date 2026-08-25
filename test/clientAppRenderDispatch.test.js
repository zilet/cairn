import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadRenderDispatch(options = {}) {
  const source = readFileSync(new URL("../public/js/app-render-dispatch.js", import.meta.url), "utf8");
  const calls = [];
  const body = {
    classList: {
      remove: (name) => calls.push(["body.remove", name]),
    },
    dataset: {},
  };
  const headerTitle = {
    classList: {
      remove: (name) => calls.push(["header.remove", name]),
    },
  };
  const headerChatActions = {
    remove: () => calls.push(["headerChatActions.remove"]),
  };
  const context = {
    PROGRESS_HANDLERS: {
      program: () => calls.push(["renderProgram"]),
    },
    defaultProgressSeg: () => options.progressSeg || "program",
    document: {
      body,
      getElementById: (id) => id === "hdrChatActions" ? headerChatActions : null,
    },
    globalThis: null,
    headerTitle,
    renderChat: () => calls.push(["renderChat"]),
    renderCoach: () => calls.push(["renderCoach"]),
    renderFoodJournal: () => calls.push(["renderFoodJournal"]),
    renderHistory: () => calls.push(["renderHistory"]),
    renderMe: () => calls.push(["renderMe"]),
    renderMeals: () => calls.push(["renderMeals"]),
    renderPlanEditor: () => calls.push(["renderPlanEditor"]),
    renderPlanEndurance: () => calls.push(["renderPlanEndurance"]),
    renderSettings: () => calls.push(["renderSettings"]),
    renderSession: () => calls.push(["renderSession"]),
    renderToday: () => calls.push(["renderToday"]),
    showEnduranceTab: () => !!options.showEnduranceTab,
    state: {
      planJump: options.planJump || null,
      planSeg: options.planSeg || null,
    },
    updateHeaderCondense: () => calls.push(["updateHeaderCondense"]),
    window: {},
    hideRestBar: options.hideRestBar,
    surfaceRestBar: options.surfaceRestBar,
    releaseWakeLock: options.releaseWakeLock,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-render-dispatch.js" });
  return { body, calls, context };
}

test("render dispatcher clears shell affordances before rendering a tab", () => {
  const env = loadRenderDispatch();

  assert.equal(typeof env.context.renderTab, "function");
  assert.equal(typeof env.context.window.renderTab, "function");
  env.context.renderTab("today");

  assert.deepEqual(env.calls, [
    ["header.remove", "hdr-tappable"],
    ["headerChatActions.remove"],
    ["body.remove", "chat-mode"],
    ["body.remove", "kb-open"],
    ["updateHeaderCondense"],
    ["renderToday"],
  ]);
  assert.equal(env.body.dataset.tab, "today");
});

test("render dispatcher routes plan jumps and clears one-shot planJump", () => {
  const env = loadRenderDispatch({ planJump: "meals" });

  env.context.renderTab("plan");

  assert.equal(env.context.state.planJump, null);
  assert.equal(env.calls.at(-1)[0], "renderMeals");
});

test("render dispatcher hides the rest bar off other tabs and restores it on session/today", () => {
  const rest = [];
  const env = loadRenderDispatch({
    hideRestBar: () => rest.push("hide"),
    surfaceRestBar: () => rest.push("surface"),
  });

  env.context.renderTab("chat");
  assert.deepEqual(rest, ["hide"]);

  env.context.renderTab("session");
  assert.equal(rest.at(-1), "surface");

  env.context.renderTab("today");
  assert.equal(rest.at(-1), "surface", "Today is where you land between sets — keep the bar");

  env.context.renderTab("plan");
  assert.equal(rest.at(-1), "hide");

  env.context.renderTab("session");
  assert.equal(rest.at(-1), "surface", "returning to session restores a still-fresh rest");
});

test("render dispatcher respects endurance visibility and progress fallback", () => {
  const endurance = loadRenderDispatch({ planJump: "endurance", showEnduranceTab: true });
  endurance.context.renderTab("plan");
  assert.equal(endurance.calls.at(-1)[0], "renderPlanEndurance");

  const routedEndurance = loadRenderDispatch({ planJump: "endurance", showEnduranceTab: false });
  routedEndurance.context.renderTab("plan");
  assert.equal(routedEndurance.calls.at(-1)[0], "renderPlanEndurance");

  const fallback = loadRenderDispatch({ progressSeg: "missing" });
  fallback.context.renderTab("progress");
  assert.equal(fallback.calls.at(-1)[0], "renderHistory");
});
