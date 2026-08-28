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
    // Recency helpers (date-utils in the browser). Stubbed deterministically so the
    // card's "relative by default, exact on hover" contract is asserted, not a clock.
    relAge: (iso) => `about ${iso === "2026-07-07" ? "3 weeks" : "2 weeks"} ago`,
    absDate: (iso) => `absolute:${iso}`,
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
  assert.match(establishing, /160\.0 lb estimated 1RM · <span title="absolute:2026-07-07">about 3 weeks ago<\/span>/);
  assert.doesNotMatch(establishing, /2026-07-07<\/span>|· 2026-07-07/, "recency never prints a bare ISO date");
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
  assert.match(completed, /Target rebuilt · <span title="absolute:2026-07-10">about 2 weeks ago<\/span>/);
  assert.match(completed, /Strength around it · planned/);
  assert.match(completed, /Cable &lt;Row&gt; · Stable press shelf/);
});

function anchorJourney(exercise, overrides = {}) {
  return {
    available: true,
    objective: { exercise, target_est_1rm: 225, status: "active", achieved_date: null },
    current: { est_1rm: 185, date: "2026-07-07" },
    gap_lb: 40,
    trend: { direction: "rising", est_1rm_lb_per_week: 1.5, exposures: 4, span_days: 21 },
    phase: "building",
    next_prescription: null,
    planned_support: [],
    support_suggestions: [],
    projection: null,
    projection_withheld_reason: null,
    ...overrides,
  };
}

test("every active anchor reaches the Progress card, in words and pounds", () => {
  const context = loadProgramController();
  const anchors = context.CairnProgressProgramController.strengthAnchorsHtml;

  // One anchor renders exactly as it always did — no empty "also rebuilding" shelf.
  const single = anchors([anchorJourney("Bench <Press>")], null);
  assert.match(single, /sjourney-card/);
  assert.doesNotMatch(single, /sjourney-others/);

  const many = anchors(
    [
      anchorJourney("Bench <Press>"),
      anchorJourney("Deadlift", { gap_lb: 0, trend: { direction: "stable", exposures: 6, span_days: 40 } }),
      anchorJourney("Overhead Press", { phase: "protecting", gap_lb: 25 }),
      anchorJourney("Squat", {
        objective: { exercise: "Squat", target_est_1rm: 315, status: "completed", achieved_date: "2026-07-10" },
      }),
    ],
    null
  );
  // The first anchor expands in full; the rest are compact rows.
  assert.match(many, /<h2>Bench &lt;Press&gt;<\/h2>/);
  assert.match(many, /Also rebuilding/);
  assert.match(many, /data-sjanchor="Deadlift"/);
  assert.match(many, /data-sjanchor="Overhead Press"/);
  assert.match(many, /data-sjanchor="Squat"/);
  assert.doesNotMatch(many, /data-sjanchor="Bench &lt;Press&gt;"/, "the expanded anchor is not also a row");
  // Words for state and direction; est-1RM POUNDS are a real measurement and print.
  assert.match(many, /at the target · holding/);
  // A brand-new anchor with no exposure must not read as already at its target.
  const fresh = anchors(
    [anchorJourney("Bench <Press>"), anchorJourney("Deadlift", { current: null, gap_lb: null, trend: {} })],
    null
  );
  assert.match(fresh, /no exposure logged yet · still establishing/);
  assert.match(fresh, /225\.0 lb target/, "with no estimate the row shows the target alone");
  assert.match(many, /protected for now/);
  assert.match(many, /milestone complete/);
  assert.match(many, /185\.0 → 225\.0 lb/);
  // Never a 0-100 grade, a percentage, or a completion meter (the constitution).
  assert.doesNotMatch(many, /\d+\s*%|progress-bar|score/i);

  // Opening another anchor expands THAT one and files the previous one back.
  const opened = anchors([anchorJourney("Bench <Press>"), anchorJourney("Deadlift")], "Deadlift");
  assert.match(opened, /<h2>Deadlift<\/h2>/);
  assert.match(opened, /data-sjanchor="Bench &lt;Press&gt;"/);
});

test("the Progress anchor card reads the plural endpoint and falls back for a blank slate", async () => {
  const context = loadProgramController();
  const slot = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const view = {
    innerHTML: "",
    querySelector: (selector) => (selector === "#progStrengthJourneySlot" ? slot : null),
    querySelectorAll: () => [],
  };

  const asked = [];
  const deps = depsFor(context, {
    view,
    api: async (path) => {
      asked.push(path);
      if (path === "/strength-journeys")
        return { journeys: [anchorJourney("Bench <Press>"), anchorJourney("Deadlift")] };
      return null;
    },
  });
  await context.CairnProgressProgramController.loadStrengthJourney(deps);
  assert.deepEqual(asked, ["/strength-journeys"], "the plural read is the one the card asks for");
  assert.match(slot.innerHTML, /Also rebuilding/);

  // No anchor at all → the singular endpoint still supplies the quiet invitation.
  const asked2 = [];
  const slot2 = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const deps2 = depsFor(context, {
    view: { innerHTML: "", querySelector: () => slot2, querySelectorAll: () => [] },
    api: async (path) => {
      asked2.push(path);
      if (path === "/strength-journeys") return { journeys: [{ available: false }] };
      return {
        available: false,
        suggestion: {
          exercise: "Bench Press",
          target_kind: "personal_best",
          target_est_1rm: 225,
          current_est_1rm: 200,
          gap_lb: 25,
          title: "Rebuild your bench",
          detail: "You were here a year ago.",
          basis: "From your logged history.",
        },
      };
    },
  });
  await context.CairnProgressProgramController.loadStrengthJourney(deps2);
  assert.deepEqual(asked2, ["/strength-journeys", "/strength-journey"]);
  assert.match(slot2.innerHTML, /Make this my anchor/);
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
