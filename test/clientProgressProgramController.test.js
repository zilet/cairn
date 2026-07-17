import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeElement(tag = "div") {
  return {
    tag,
    className: "",
    removed: false,
    children: [],
    style: {},
    isConnected: true,
    remove() {
      this.removed = true;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function fakeButton() {
  return {
    listeners: {},
    parentElement: null,
    closest() {
      return null;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

// A fake "#progMergeSuggestSlot" that can actually be clicked: since fakeElement
// doesn't parse innerHTML into real nodes, querySelectorAll here returns a
// pre-built accept/skip button PER pair (selector-aware), each wired with
// getAttribute/closest so wireMergeSuggestions' real production code — not a
// stand-in — attaches its listeners and can find/remove the owning card.
function fakeMergeSuggestionSlot(pairs) {
  const cards = pairs.map((_pair, idx) => {
    const card = fakeElement("div");
    card.className = "exmerge-card";
    const acceptBtn = fakeButton();
    acceptBtn.getAttribute = (name) => (name === "data-exmerge-accept" ? String(idx) : null);
    acceptBtn.closest = (selector) => (selector === ".exmerge-card" ? card : null);
    const skipBtn = fakeButton();
    skipBtn.getAttribute = (name) => (name === "data-exmerge-skip" ? String(idx) : null);
    skipBtn.closest = (selector) => (selector === ".exmerge-card" ? card : null);
    card.acceptBtn = acceptBtn;
    card.skipBtn = skipBtn;
    return card;
  });
  const slot = fakeElement("div");
  slot.cards = cards;
  slot.querySelectorAll = (selector) => {
    if (selector === "[data-exmerge-accept]") return cards.map((c) => c.acceptBtn);
    if (selector === "[data-exmerge-skip]") return cards.map((c) => c.skipBtn);
    return [];
  };
  return slot;
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadProgramController() {
  const calls = [];
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    document: {
      createElement: fakeElement,
      querySelector() {
        return null;
      },
      getElementById() {
        return null;
      },
    },
    calls,
    stagger(index) {
      return `--i:${index}`;
    },
    enduranceBlockHtml(endurance, index) {
      return `<div class="endurance" data-i="${index}">${String(endurance?.headline || "")}</div>`;
    },
    hybridLoadCardHtml(hybrid, index) {
      return `<div class="hybrid" data-i="${index}">${String(hybrid?.headline || "")}</div>`;
    },
    loadPerformance() {
      calls.push("performance");
    },
    loadProgramBlock() {
      calls.push("block");
    },
    loadProgramAdjustments() {
      calls.push("adjustments");
    },
    loadTestWeek() {
      calls.push("test-week");
    },
    loadMuscleTrajectory() {
      calls.push("muscle");
    },
    loadDexaTargeting(slot) {
      calls.push(`dexa:${slot}`);
    },
    coachingFocusCardHtml(focus) {
      return focus?.show ? `<section class="focus-card">FOCUS CARD</section>` : "";
    },
    wireGuides() {
      /* tap-through wiring — no-op in the controller unit test */
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/format-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-summary-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-controller.js"), "utf8"), context);
  return context;
}

function depsFor(_context, overrides = {}) {
  const view = overrides.view || {
    innerHTML: "",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const invalidated = [];
  const toasts = [];
  const busyCalls = [];
  const deps = {
    view,
    headerTitle: { textContent: "" },
    state: { tab: "progress", progressSeg: "sessions" },
    api: async () => ({}),
    runOp: async () => undefined,
    nextToken: () => 1,
    isCurrent: () => true,
    peekCached: () => null,
    paintSWR: async () => undefined,
    segmentHtml: (active) => `<nav>${active}</nav>`,
    skeletonHtml: (active, cards) => `<div class="skeleton">${active}:${cards}</div>`,
    wireSegments: () => {
      deps.wired = true;
    },
    hero: (title, stats) => `<section class="hero">${title}:${stats.map((row) => row[0]).join("|")}</section>`,
    empty: (_image, message) => `<div class="empty">${message}</div>`,
    art: (kind, label) => `${kind}:${label}`,
    busy: (_btn, text) => {
      busyCalls.push(text);
      return () => busyCalls.push("restore");
    },
    toast: (message) => {
      toasts.push(message);
    },
    invalidate: (key) => {
      invalidated.push(key);
    },
    runCountUps: () => {
      deps.countUps = true;
    },
    renderSelf: () => {
      deps.renderedSelf = true;
    },
    wired: false,
    countUps: false,
    renderedSelf: false,
    invalidated,
    toasts,
    busyCalls,
    ...overrides,
  };
  return deps;
}

const programState = {
  headline: "Keep pressure on the main lift <safely>",
  lifts: [
    { exercise: "Bench <press>", status: "progressing", est_1rm: 185, trend_per_wk: 2.5, why: "Top set moved well" },
    { exercise: "Deadlift", status: "plateaued", weeks_static: 2, est_1rm: 315, trend_per_wk: 0, why: "Stalled twice" },
  ],
  volume: [{ muscle_group: "Chest", weekly_sets: 12, band: "productive", trend: "rising" }],
  mesocycle: { phase: "intensification", weeks_since_deload: 4, note: "One hard week left" },
  endurance: { headline: "Keep the easy base" },
  adaptations_due: ["Add carries <grip>"],
};

test("strength journey Progress states are explicit, calm, and plan-backed", () => {
  const context = loadProgramController();
  const card = context.CairnProgressProgramController.strengthJourneyCardHtml;
  assert.equal(card({ available: false }), "", "unavailable journey does not create an empty card");

  const base = {
    available: true,
    objective: {
      exercise: "Bench <Press>",
      target_est_1rm: 200,
      status: "active",
      achieved_date: null,
    },
    latest: { est_1rm: 150, date: "2026-07-14" },
    current: { est_1rm: 160, date: "2026-07-07" },
    gap_lb: 40,
    trend: { direction: null, est_1rm_lb_per_week: null, exposures: 2, span_days: 7 },
    phase: "establishing",
    next_prescription: null,
    planned_support: [],
    support_suggestions: [{ role: "trunk", exercise: "Invented", why: "optional" }],
    projection: null,
    projection_withheld_reason: "Need four exact-lift exposures.",
  };
  const establishing = card(base);
  assert.match(establishing, /160\.0 lb estimated 1RM · 2026-07-07/);
  assert.match(establishing, /Checkpoint/);
  assert.match(establishing, /Need four exact-lift exposures/);
  assert.doesNotMatch(establishing, /Invented|optional/);

  const protecting = card({ ...base, phase: "protecting", projection_withheld_reason: "Relevant elbow pain." });
  assert.match(protecting, /Hold or ease the anchor/);
  assert.match(protecting, /Relevant elbow pain/);

  const completed = card({
    ...base,
    objective: { ...base.objective, status: "completed", achieved_date: "2026-07-10" },
    phase: "reached",
    gap_lb: 0,
    planned_support: [
      {
        role: "upper back",
        exercise: "Cable <Row>",
        why: "Stable press shelf.",
        plan_day_number: 2,
        plan_day_name: "Pull",
      },
    ],
  });
  assert.match(completed, /milestone complete/);
  assert.match(completed, /Target rebuilt · 2026-07-10/);
  assert.match(completed, /Strength around it · planned/);
  assert.match(completed, /Cable &lt;Row&gt; · Stable press shelf/);
});

test("progress program controller renders the empty state through the route shell", () => {
  const context = loadProgramController();
  const deps = depsFor(context);

  context.CairnProgressProgramController.paint(
    { headline: "", lifts: [], volume: [], mesocycle: null, endurance: null, adaptations_due: [] },
    deps
  );

  assert.match(deps.view.innerHTML, /<nav>program<\/nav>/);
  assert.match(deps.view.innerHTML, /Not enough data yet/);
  assert.equal(deps.wired, true);
  assert.deepEqual(context.calls, []);
});

test("progress program controller paints stacked program read and wires actions", () => {
  const context = loadProgramController();
  const evolve = fakeButton();
  const tidy = fakeButton();
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progEvolveBtn") return evolve;
        if (selector === "#progTidyBtn") return tidy;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
  });

  context.CairnProgressProgramController.paint(programState, deps);

  assert.match(deps.view.innerHTML, /Keep pressure on the main lift &lt;safely&gt;/);
  assert.match(deps.view.innerHTML, /Bench &lt;press&gt;/);
  assert.match(deps.view.innerHTML, /Weekly volume by muscle/);
  assert.match(deps.view.innerHTML, /Add carries &lt;grip&gt;/);
  assert.doesNotMatch(deps.view.innerHTML, /<safely>|<press>|<grip>|The full read/);
  assert.equal(typeof evolve.listeners.click, "function");
  assert.equal(typeof tidy.listeners.click, "function");
  assert.deepEqual(context.calls, ["performance", "block", "adjustments", "test-week", "muscle", "dexa:progDexaSlot"]);
});

test("progress program controller repaints with the conductor when focus arrives", async () => {
  const context = loadProgramController();
  const deps = depsFor(context, {
    api: async (path) => {
      assert.equal(path, "/coaching-focus");
      return { show: true };
    },
    nextToken: () => 7,
    isCurrent: (token) => token === 7,
    peekCached: () => ({ data: programState, fresh: true }),
    paintSWR: async (options) => {
      options.render(programState, { warm: true });
      return programState;
    },
  });

  await context.CairnProgressProgramController.render(deps);
  await Promise.resolve();

  assert.equal(deps.headerTitle.textContent, "Program");
  assert.equal(deps.state.progressSeg, "program");
  assert.match(deps.view.innerHTML, /FOCUS CARD/);
  assert.match(deps.view.innerHTML, /<summary>The full read<\/summary>/);
  assert.ok(deps.view.innerHTML.indexOf("Bench &lt;press&gt;") < deps.view.innerHTML.indexOf("The full read"));
});

test("progress program controller tidies exercise names and refreshes on merge", async () => {
  const context = loadProgramController();
  const deps = depsFor(context, {
    api: async (path, options) => {
      assert.equal(path, "/exercises/reconcile-names");
      assert.equal(options.method, "POST");
      return { ok: true, aligned: 2 };
    },
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);

  assert.deepEqual(deps.busyCalls, ["tidying…", "restore"]);
  assert.deepEqual(deps.toasts, ["Tidied 2 exercise names"]);
  assert.deepEqual(deps.invalidated, ["progress:program"]);
  assert.equal(deps.renderedSelf, true);
});

test("progress program controller surfaces merged + muscle-group counts from the tidy response", async () => {
  const context = loadProgramController();
  const deps = depsFor(context, {
    api: async () => ({
      ok: true,
      aligned: 1,
      merged: [
        { from: "DB Bench Press", into: "Bench Press" },
        { from: "Bench (BB)", into: "Bench Press" },
      ],
      groups_fixed: 2,
    }),
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);

  assert.deepEqual(deps.toasts, ["Tidied 1 name · merged 2 duplicates · fixed 2 muscle groups"]);
  assert.deepEqual(deps.invalidated, ["progress:program"]);
  assert.equal(deps.renderedSelf, true);
});

test("progress program controller renders the agent's suggested merges with escaped strings", async () => {
  const context = loadProgramController();
  const suggestSlot = fakeElement("div");
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progMergeSuggestSlot") return suggestSlot;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    api: async () => ({
      ok: true,
      aligned: 0,
      suggested: [
        {
          from: "DB Bench <Press>",
          into: "Bench Press",
          why: "Same movement, different equipment tag.",
          confidence: "medium",
        },
      ],
    }),
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);

  assert.match(suggestSlot.innerHTML, /Merge <b>DB Bench &lt;Press&gt;<\/b> into <b>Bench Press<\/b>/);
  assert.match(suggestSlot.innerHTML, /Same movement, different equipment tag\./);
  assert.doesNotMatch(suggestSlot.innerHTML, /<Press>/, "the raw unescaped tag never reaches innerHTML");
  assert.deepEqual(deps.toasts, ["Names already tidy"]);
  assert.equal(deps.renderedSelf, false, "nothing deterministic changed, so the suggestion cards are left in place");
});

test("progress program controller clears the suggestion slot when Tidy finds no candidates", async () => {
  const context = loadProgramController();
  const suggestSlot = fakeElement("div");
  suggestSlot.innerHTML = "<div>stale from a previous run</div>";
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progMergeSuggestSlot") return suggestSlot;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    api: async () => ({ ok: true, aligned: 1 }),
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);

  assert.equal(suggestSlot.innerHTML, "");
});

test("progress program controller accepts a suggested merge: busy state, card removed, invalidate + re-render", async () => {
  const context = loadProgramController();
  const pairs = [{ from: "DB Bench Press", into: "Bench Press", why: "Same movement.", confidence: "medium" }];
  const suggestSlot = fakeMergeSuggestionSlot(pairs);
  const apiCalls = [];
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progMergeSuggestSlot") return suggestSlot;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    api: async (path, options) => {
      apiCalls.push({ path, options });
      if (path === "/exercises/reconcile-names") return { ok: true, aligned: 0, suggested: pairs };
      if (path === "/exercises/merge") return { ok: true };
      return {};
    },
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);
  assert.equal(typeof suggestSlot.cards[0].acceptBtn.listeners.click, "function", "the accept button is wired");

  suggestSlot.cards[0].acceptBtn.listeners.click();
  await flushAsync();

  const mergeCall = apiCalls.find((c) => c.path === "/exercises/merge");
  assert.ok(mergeCall, "the merge endpoint was called");
  assert.equal(mergeCall.options.method, "POST");
  assert.deepEqual(JSON.parse(mergeCall.options.body), { from: "DB Bench Press", into: "Bench Press" });
  assert.deepEqual(deps.busyCalls, ["tidying…", "restore", "merging…"], "a per-card busy state guards the merge");
  assert.equal(suggestSlot.cards[0].removed, true, "the accepted card is removed on success");
  assert.deepEqual(deps.invalidated, ["progress:program"]);
  assert.equal(deps.renderedSelf, true);
  assert.ok(deps.toasts.some((t) => /Merged DB Bench Press into Bench Press/.test(t)));
});

test("progress program controller surfaces a failed merge suggestion and leaves the card in place", async () => {
  const context = loadProgramController();
  const pairs = [{ from: "DB Bench Press", into: "Bench Press", why: "Same movement.", confidence: "low" }];
  const suggestSlot = fakeMergeSuggestionSlot(pairs);
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progMergeSuggestSlot") return suggestSlot;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    api: async (path) => {
      if (path === "/exercises/reconcile-names") return { ok: true, aligned: 0, suggested: pairs };
      if (path === "/exercises/merge") return { ok: false, error: "different muscle groups" };
      return {};
    },
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);
  suggestSlot.cards[0].acceptBtn.listeners.click();
  await flushAsync();

  assert.deepEqual(
    deps.busyCalls,
    ["tidying…", "restore", "merging…", "restore"],
    "the button is restored after a failed merge"
  );
  assert.equal(suggestSlot.cards[0].removed, false, "a failed merge leaves the card in place");
  assert.ok(deps.toasts.includes("different muscle groups"), "the server's error message is surfaced calmly");
  assert.deepEqual(deps.invalidated, [], "a failed merge never invalidates the cache");
  assert.equal(deps.renderedSelf, false, "a failed merge never triggers a re-render");
});

test("progress program controller drops a skipped suggestion card with no server call", async () => {
  const context = loadProgramController();
  const pairs = [{ from: "DB Bench Press", into: "Bench Press", why: "Same movement.", confidence: "low" }];
  const suggestSlot = fakeMergeSuggestionSlot(pairs);
  const apiCalls = [];
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progMergeSuggestSlot") return suggestSlot;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    api: async (path) => {
      apiCalls.push(path);
      if (path === "/exercises/reconcile-names") return { ok: true, aligned: 0, suggested: pairs };
      return {};
    },
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);
  suggestSlot.cards[0].skipBtn.listeners.click();

  assert.equal(suggestSlot.cards[0].removed, true, "skip removes the card immediately, client-side only");
  assert.ok(!apiCalls.includes("/exercises/merge"), "skip never calls the server (no persistence, by design)");
});

test("progress program controller reports muscle-group fixes even when no names changed", async () => {
  const context = loadProgramController();
  const deps = depsFor(context, {
    api: async () => ({ ok: true, aligned: 0, groups_fixed: 1 }),
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);

  assert.deepEqual(deps.toasts, ["Fixed 1 muscle group"]);
  assert.deepEqual(deps.invalidated, ["progress:program"]);
  assert.equal(deps.renderedSelf, true);
});

test("progress program controller drafts evolved plans through runOp", async () => {
  const context = loadProgramController();
  const foot = fakeElement("div");
  const button = fakeButton();
  button.closest = (selector) => (selector === ".prog-evolve-foot" ? foot : null);
  const deps = depsFor(context, {
    runOp: async (kind, body, options) => {
      assert.equal(kind, "evolve_program");
      assert.equal(JSON.stringify(body), "{}");
      assert.equal(options.path, "/program/evolve");
      assert.equal(options.anchor, ".prog-evolve-foot");
      options.render({});
    },
  });

  await context.CairnProgressProgramController.triggerProgramEvolve(button, deps);

  assert.deepEqual(deps.busyCalls, ["Drafting your plan…", "restore"]);
  assert.deepEqual(deps.toasts, ["Ready for your review"]);
  assert.deepEqual(deps.invalidated, ["progress:program", "plan:coach", "plan:proposals"]);
  assert.equal(deps.renderedSelf, true);
});
