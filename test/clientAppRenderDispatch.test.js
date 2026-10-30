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
    renderIntake: () => calls.push(["renderIntake"]),
    renderHistory: () => calls.push(["renderHistory"]),
    ensureBundle: (name) => {
      calls.push(["ensureBundle", name]);
      return options.bundleFails ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
    // The loader's contract: warm → the render runs synchronously; cold → after the load.
    withBundle: (name, fn) => {
      if ((options.warm || []).includes(name)) return fn();
      return context.ensureBundle(name).then(() => fn());
    },
    CairnStand: { renderStand: () => calls.push(["renderStand"]) },
    renderMe: () => calls.push(["renderMe"]),
    renderMeals: () => calls.push(["renderMeals"]),
    renderPlanEditor: () => calls.push(["renderPlanEditor"]),
    renderPlanEndurance: () => calls.push(["renderPlanEndurance"]),
    renderSettings: () => calls.push(["renderSettings"]),
    renderSession: () => calls.push(["renderSession"]),
    renderToday: () => calls.push(["renderToday"]),
    renderHorizon: () => calls.push(["renderHorizon"]),
    renderYou: () => calls.push(["renderYou"]),
    showEnduranceTab: () => !!options.showEnduranceTab,
    state: {
      planJump: options.planJump || null,
      planSeg: options.planSeg || null,
      progressSeg: options.progressSeg || null,
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

test("render dispatcher routes plan jumps and clears one-shot planJump", async () => {
  const env = loadRenderDispatch({ planJump: "meals" });

  const painted = env.context.renderTab("plan");

  assert.equal(env.context.state.planJump, null);
  // Plan -> Meals is the week menu, the lazy meals bundle's.
  assert.deepEqual(env.calls.at(-1), ["ensureBundle", "meals"]);
  await painted;
  assert.equal(env.calls.at(-1)[0], "renderMeals");

  const warm = loadRenderDispatch({ planJump: "meals", warm: ["meals"] });
  warm.context.renderTab("plan");
  assert.equal(warm.calls.at(-1)[0], "renderMeals", "a warm bundle renders in the same turn");
});

test("Train › Intake, today's food, is the lazy fuel bundle's screen; other Train leaves stay Train's", async () => {
  const env = loadRenderDispatch({ progressSeg: "intake" });
  const painted = env.context.renderTab("progress");
  assert.deepEqual(env.calls.at(-1), ["ensureBundle", "fuel"]);
  await painted;
  assert.equal(env.calls.at(-1)[0], "renderIntake");
  assert.ok(!env.calls.some(([, name]) => name === "train"), "Intake never waits on the train bundle");

  const program = loadRenderDispatch({ progressSeg: "program" });
  await program.context.renderTab("progress");
  assert.deepEqual(program.calls.slice(-2), [["ensureBundle", "train"], ["renderProgram"]]);
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

// A deep link to /app/session lands on an EMPTY #view, and renderSession paints only
// after its loads settle — so the skeleton goes up first, and never over live content.
test("session paints the today skeleton on an empty view, never over content", () => {
  const env = loadRenderDispatch();
  env.context.todaySkeleton = () => "<div class=\"skel\"></div>";
  const empty = { firstElementChild: null, innerHTML: "" };
  env.context.view = empty;
  env.context.renderTab("session");
  assert.equal(empty.innerHTML, "<div class=\"skel\"></div>");
  assert.equal(env.calls.at(-1)[0], "renderSession");

  const painted = { firstElementChild: {}, innerHTML: "<div class=\"sess-dest\"></div>" };
  env.context.view = painted;
  env.context.renderTab("session");
  assert.equal(painted.innerHTML, "<div class=\"sess-dest\"></div>", "a re-render keeps what is on screen");
});

test("render dispatcher respects endurance visibility and progress fallback", async () => {
  const endurance = loadRenderDispatch({ planJump: "endurance", showEnduranceTab: true });
  await endurance.context.renderTab("plan");
  assert.deepEqual(endurance.calls.slice(-2), [["ensureBundle", "horizon"], ["renderPlanEndurance"]]);

  const routedEndurance = loadRenderDispatch({ planJump: "endurance", showEnduranceTab: false });
  await routedEndurance.context.renderTab("plan");
  assert.equal(routedEndurance.calls.at(-1)[0], "renderPlanEndurance");

  const fallback = loadRenderDispatch({ progressSeg: "missing" });
  await fallback.context.renderTab("progress");
  assert.deepEqual(fallback.calls.slice(-2), [["ensureBundle", "train"], ["renderHistory"]]);
});

test("every lazy destination waits for the bundle that defines it", async () => {
  const cases = [
    ["progress", {}, "train", "renderProgram"],
    ["plan", { planJump: "edit" }, "train", "renderPlanEditor"],
    ["plan", { planJump: "coach" }, "ask", "renderCoach"],
    ["chat", {}, "ask", "renderChat"],
    ["horizon", {}, "horizon", "renderHorizon"],
    ["settings", {}, "settings", "renderSettings"],
  ];
  for (const [tab, options, bundle, renderer] of cases) {
    const env = loadRenderDispatch(options);
    await env.context.renderTab(tab);
    assert.deepEqual(env.calls.slice(-2), [["ensureBundle", bundle], [renderer]], `${tab} → ${bundle}`);
  }
});

test("a warm lazy destination renders synchronously, inside the caller's turn", () => {
  const env = loadRenderDispatch({ warm: ["train"] });
  env.context.renderTab("progress");
  assert.deepEqual(env.calls.at(-1), ["renderProgram"], "no microtask between the switch and the paint");
  assert.equal(env.calls.some(([kind]) => kind === "ensureBundle"), false);
});

// A cold bundle load can outlast the athlete's patience: a render that lands after
// a newer navigation must not paint over the destination they moved to.
test("a deferred lazy render is dropped when a newer navigation happened meanwhile", async () => {
  const env = loadRenderDispatch();
  const slow = env.context.renderTab("chat");
  env.context.renderTab("today");
  await slow;
  assert.equal(env.calls.some(([kind]) => kind === "renderChat"), false);
  assert.equal(env.calls.at(-1)[0], "renderToday");
});

test("a cold segment render is dropped when the athlete switched home meanwhile", async () => {
  // A Train segment tap (or the chat hand-off) waiting on a cold bundle must not
  // paint over the home the athlete moved to while it loaded.
  const env = loadRenderDispatch();
  let painted = false;
  const segment = env.context.withLatestRender("train", () => {
    painted = true;
  });
  env.context.renderTab("today");
  await segment;
  assert.equal(painted, false);
  assert.equal(env.calls.at(-1)[0], "renderToday");
});

test("a segment render claims #view: an older deferred tab render is dropped", async () => {
  const env = loadRenderDispatch({ warm: ["ask"] });
  const slow = env.context.renderTab("horizon");
  const out = env.context.withLatestRender("ask", () => "chat");
  assert.equal(out, "chat", "warm: runs synchronously and returns the render");
  await slow;
  assert.equal(env.calls.some(([kind]) => kind === "renderHorizon"), false);
  assert.equal(typeof env.context.window.withLatestRender, "function");
});

// Stand and Me live in the lazily-injected me-health bundle. The dispatcher must
// wait for it rather than calling into globals that do not exist yet, and a
// failed injection must surface as a rejected render (switchTab's error state)
// rather than a silently blank destination.
test("Stand and Me await the lazy me-health bundle before rendering", async () => {
  const env = loadRenderDispatch();

  await env.context.renderTab("stand");
  assert.deepEqual(env.calls.slice(-2), [["ensureBundle", "me-health"], ["renderStand"]]);

  await env.context.renderTab("me");
  assert.deepEqual(env.calls.slice(-2), [["ensureBundle", "me-health"], ["renderMe"]]);
});

test("a failed me-health injection rejects the render instead of throwing blind", async () => {
  const env = loadRenderDispatch({ bundleFails: true });

  await assert.rejects(Promise.resolve(env.context.renderTab("stand")), /boom/);
  assert.ok(!env.calls.some(([name]) => name === "renderStand"));
});

// The You landing is EAGER: it paints as fast as Today, and only a tap into Health
// or About you loads me-health. Horizon rides its own lazy bundle.
test("render dispatcher paints the You landing without any lazy bundle", async () => {
  const env = loadRenderDispatch();
  env.context.renderTab("you");
  assert.equal(env.body.dataset.tab, "you");
  assert.deepEqual(env.calls.at(-1), ["renderYou"]);
  assert.equal(env.calls.some(([kind]) => kind === "ensureBundle"), false, "You never awaits a lazy bundle");

  const horizon = loadRenderDispatch();
  await horizon.context.renderTab("horizon");
  assert.equal(horizon.body.dataset.tab, "horizon");
  assert.deepEqual(horizon.calls.slice(-2), [["ensureBundle", "horizon"], ["renderHorizon"]]);
});
