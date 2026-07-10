import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(attrs = {}) {
    this.attrs = attrs;
    this.dataset = {};
    this.isConnected = true;
    this.id = attrs.id || "";
    this.innerHTML = "";
    this.removed = false;
  }

  closest(selector) {
    if (selector === "[data-cfocus-go]" && this.attrs["data-cfocus-go"] != null) return this;
    if (
      selector === '[data-cfocus-go][role="link"]' &&
      this.attrs["data-cfocus-go"] != null &&
      this.attrs.role === "link"
    )
      return this;
    return null;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  remove() {
    this.removed = true;
  }
}

class FakeHtmlElement extends FakeElement {
  constructor(attrs = {}) {
    super(attrs);
    this.dataset = { cfocusGo: attrs["data-cfocus-go"] || "" };
  }
}

function loadCoachingFocus(options = {}) {
  const handlers = {};
  const activated = [];
  const state = {};
  const context = {
    Array,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    Element: FakeElement,
    HTMLElement: FakeHtmlElement,
    state,
    activateTab: (tab) => activated.push(tab),
    document: {
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      querySelector: () => null,
    },
    api: options.api || (async () => null),
  };
  context.window = context;
  context.view = {
    querySelector: () => null,
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/coaching-focus-client.js"), "utf8"), context);
  return { focus: context.CairnCoachingFocus, handlers, state, activated };
}

const richFocus = {
  available: true,
  headline: "Build <patiently>",
  lead: {
    domain: "training",
    title: "Break <plateau>",
    why: "Bench needs a new stimulus",
    move: "Rotate incline <press>",
  },
  parallel: [
    {
      domain: "nutrition",
      title: "Protein floor",
      why: "Support the block",
      move: "Add breakfast protein",
    },
  ],
  later: [{ domain: "running", title: "Add strides <later>" }],
  connections: ["Strength and fuel move together <now>"],
  retest: { in_weeks: 2, focus: ["Bench <top set>", "5k"], why: "Batch checks" },
  horizon_weeks: 6,
};

test("coaching focus renderer escapes text and preserves conductor structure", () => {
  const { focus } = loadCoachingFocus();
  const html = focus.coachingFocusCardHtml(richFocus);

  assert.match(html, /Where to focus/);
  assert.match(html, /Training/);
  assert.match(html, /Nutrition/);
  assert.match(html, /Build &lt;patiently&gt;/);
  assert.match(html, /Break &lt;plateau&gt;/);
  assert.match(html, /Rotate incline &lt;press&gt;/);
  assert.match(html, /Add strides &lt;later&gt;/);
  assert.match(html, /Bench &lt;top set&gt; · 5k/);
  assert.doesNotMatch(html, /<plateau>|<press>|<later>|<top set>/);

  assert.equal(focus.coachingFocusCardHtml({ ...richFocus, available: false }), "");
  assert.equal(
    focus
      .coachingFocusThreadHtml({ ...richFocus, lead: { ...richFocus.lead, title: "Use <thread>" } })
      .includes("Use &lt;thread&gt;"),
    true
  );

  const recoveryThread = focus.coachingFocusThreadHtml({
    ...richFocus,
    lead: { domain: "recovery", title: "Take an earned recovery week", why: "Absorb the work you have already done." },
  });
  assert.match(recoveryThread, /data-cfocus-go="recovery"/);
  assert.match(recoveryThread, /This block/);
  assert.match(recoveryThread, /Absorb the work you have already done/);
  assert.doesNotMatch(recoveryThread, /data-cfocus-go="stand"/);
});

test("coaching focus route bridge preserves deep-link destinations", () => {
  const { focus, state, activated } = loadCoachingFocus();

  focus.cfocusRoute("running");
  assert.equal(state.progressSeg, "endurance");
  assert.deepEqual(activated.at(-1), "progress");

  focus.cfocusRoute("nutrition");
  assert.equal(state.planJump, "meals");
  assert.deepEqual(activated.at(-1), "plan");

  // Health / markers / standing now unify onto the Stand tab (the where-you-stand brain).
  focus.cfocusRoute("health");
  assert.deepEqual(activated.at(-1), "stand");

  focus.cfocusRoute("markers");
  assert.deepEqual(activated.at(-1), "stand");

  focus.cfocusRoute("me-standing");
  assert.deepEqual(activated.at(-1), "stand");

  focus.cfocusRoute("training");
  assert.equal(state.progressSeg, "program");
  assert.deepEqual(activated.at(-1), "progress");
});

test("coaching focus loader degrades quietly and suppresses duplicate Standing lead", async () => {
  const slot = new FakeElement({ id: "cfocusStandingSlot" });
  const lever = new FakeElement();
  const rootNode = {
    querySelector: (selector) => {
      if (selector === "#cfocusStandingSlot") return slot;
      if (selector === ".hstand-lever") return lever;
      return null;
    },
  };
  const { focus } = loadCoachingFocus({ api: async () => richFocus });

  await focus.loadCoachingFocus("#cfocusStandingSlot", rootNode);

  assert.match(slot.innerHTML, /cfocus/);
  assert.equal(lever.removed, true);

  const emptySlot = new FakeElement({ id: "cfocusStandingSlot" });
  const quietRoot = {
    querySelector: (selector) => (selector === "#cfocusStandingSlot" ? emptySlot : null),
  };
  const quiet = loadCoachingFocus({ api: async () => ({ available: false }) }).focus;
  emptySlot.innerHTML = "stale";

  await quiet.loadCoachingFocus("#cfocusStandingSlot", quietRoot);

  assert.equal(emptySlot.innerHTML, "");
});

test("coaching focus delegated listeners share the route bridge", () => {
  const { handlers, state, activated } = loadCoachingFocus();
  const target = new FakeHtmlElement({ "data-cfocus-go": "endurance", role: "link" });

  handlers.click({ target });
  assert.equal(state.progressSeg, "endurance");
  assert.deepEqual(activated.at(-1), "progress");

  let prevented = false;
  handlers.keydown({
    key: " ",
    target,
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(activated.at(-1), "progress");
});

test("the block's temporal placement renders in the card and leads the thread context", () => {
  const { focus } = loadCoachingFocus();
  const withBlock = { ...richFocus, block_line: "Week 3 of 5 — building volume." };

  const card = focus.coachingFocusCardHtml(withBlock);
  assert.match(card, /cfocus-blockline/);
  assert.match(card, /Week 3 of 5 — building volume\./);

  const thread = focus.coachingFocusThreadHtml(withBlock);
  assert.match(thread, /Week 3 of 5 — building volume\. Bench needs a new stimulus/);

  // No block → no placement anywhere (never fabricated).
  assert.doesNotMatch(focus.coachingFocusCardHtml(richFocus), /cfocus-blockline/);
});

test("the block calendar never attaches to a non-training lead; compact card carries one voice", () => {
  const { focus } = loadCoachingFocus();
  const healthLead = {
    ...richFocus,
    block_line: "Week 3 of 5 — building volume.",
    lead: { domain: "health", title: "Lower your cardiovascular risk", why: "ApoB is the lever." },
  };

  // The lifting-block calendar under a health lever would imply the lab work is
  // block-scoped volume work — the lead's why stands alone.
  const thread = focus.coachingFocusThreadHtml(healthLead);
  assert.doesNotMatch(thread, /Week 3 of 5/);
  assert.match(thread, /ApoB is the lever\./);

  // The compact conductor (Stand overview): masthead + headline + lead only —
  // no parallel/later/connections/retest rivaling the synthesis below it.
  const compact = focus.coachingFocusCompactHtml({ ...richFocus, block_line: "Week 3 of 5 — building volume." });
  assert.match(compact, /cfocus-compact/);
  assert.match(compact, /Break &lt;plateau&gt;/);
  assert.match(compact, /Week 3 of 5/);
  assert.match(compact, /The full focus plan/);
  assert.doesNotMatch(compact, /Alongside|cfocus-conn|Next check-in/);

  // Program view: blockLine:false omits the calendar (the pblock card owns it there).
  const noBlock = focus.coachingFocusCardHtml({ ...richFocus, block_line: "Week 3 of 5 — building volume." }, { blockLine: false });
  assert.doesNotMatch(noBlock, /Week 3 of 5/);
});

test("action buttons render only with options.actions, gated per lead", () => {
  const { focus } = loadCoachingFocus();
  const recoveryLead = {
    ...richFocus,
    lead: { domain: "recovery", title: "Take an earned recovery week", why: "Seven loaded weeks without a reset." },
  };
  const swapLead = {
    ...richFocus,
    lead: {
      domain: "training",
      title: "Break <plateau>",
      why: "Bench stalled",
      swap: { from: "Barbell <bench>", to: ["Incline <press>", "Floor <press>", "Third variation"] },
    },
  };

  // actions:false (the default — navigate-only surfaces like the Standing slot)
  // renders NO action button, even for recovery/swap leads (they'd be dead there).
  assert.doesNotMatch(focus.coachingFocusCardHtml(recoveryLead), /data-cfocus-act/);
  assert.doesNotMatch(focus.coachingFocusCardHtml(swapLead), /data-cfocus-act/);
  assert.doesNotMatch(focus.coachingFocusCardHtml(recoveryLead, { actions: false }), /data-cfocus-act/);

  // actions:true renders the recovery button.
  const recovery = focus.coachingFocusCardHtml(recoveryLead, { actions: true });
  assert.match(recovery, /data-cfocus-act="recovery-week"/);
  assert.match(recovery, /Draft my recovery week/);

  // actions:true on a training swap lead renders up to two escaped swap buttons.
  const swap = focus.coachingFocusCardHtml(swapLead, { actions: true });
  const swapButtons = swap.match(/data-cfocus-act="swap"/g) || [];
  assert.equal(swapButtons.length, 2, "capped at two variation buttons");
  assert.match(swap, /data-swap-from="Barbell &lt;bench&gt;"/);
  assert.match(swap, /data-swap-to="Incline &lt;press&gt;"/);
  assert.match(swap, /Rotate in Incline &lt;press&gt;/);
  assert.doesNotMatch(swap, /Third variation/); // beyond the two-button cap
  assert.doesNotMatch(swap, /<bench>|<press>/); // raw angle brackets never leak

  // A training lead without a swap renders no swap button, and richFocus's plain
  // training lead is not recovery either → no action button at all.
  assert.doesNotMatch(focus.coachingFocusCardHtml(richFocus, { actions: true }), /data-cfocus-act/);

  // The compact card (Stand overview) never carries actions.
  assert.doesNotMatch(focus.coachingFocusCompactHtml(recoveryLead), /data-cfocus-act/);
});

test("routing to the screen you're already on settles instead of re-rendering", () => {
  const { focus, state, activated } = loadCoachingFocus();

  state.tab = "progress";
  state.progressSeg = "program";
  focus.cfocusRoute("recovery");
  assert.deepEqual(activated, [], "no re-activation flash when already on Program");

  state.tab = "stand";
  state.standSeg = null;
  focus.cfocusRoute("health");
  assert.deepEqual(activated, [], "no re-activation flash when already on the Stand overview");

  // From anywhere else the route still navigates.
  state.tab = "today";
  focus.cfocusRoute("recovery");
  assert.deepEqual(activated, ["progress"]);
});

test("a parallel training lever carries the swap buttons too (the live plateau-alongside-recovery case)", () => {
  const { focus } = loadCoachingFocus();
  const plateauAlongside = {
    ...richFocus,
    lead: { domain: "recovery", title: "Take an earned recovery week", why: "Seven loaded weeks." },
    parallel: [
      {
        domain: "training",
        title: "Break the plateau on your chest",
        why: "Bench has stalled.",
        swap: { from: "Barbell Bench Press", to: ["DB Bench Press", "Incline Bench Press"] },
      },
    ],
  };
  const withActions = focus.coachingFocusCardHtml(plateauAlongside, { actions: true });
  assert.match(withActions, /data-swap-from="Barbell Bench Press"/);
  assert.match(withActions, /Rotate in DB Bench Press/);
  assert.match(withActions, /Rotate in Incline Bench Press/);
  // Navigate-only surfaces stay button-free.
  assert.doesNotMatch(focus.coachingFocusCardHtml(plateauAlongside), /data-cfocus-act/);
});

test("the literal 'program' route (retest chip) settles when already on Program", () => {
  const { focus, state, activated } = loadCoachingFocus();
  state.tab = "progress";
  state.progressSeg = "program";
  focus.cfocusRoute("program");
  assert.deepEqual(activated, [], "the Next check-in chip never re-flashes the screen it lives on");
  state.tab = "today";
  focus.cfocusRoute("program");
  assert.deepEqual(activated, ["progress"], "from elsewhere it still navigates");
});

test("a recovery lead with a waiting draft renders a review LINK, not the draft button again", () => {
  const { focus } = loadCoachingFocus();
  const drafted = {
    ...richFocus,
    lead: {
      domain: "recovery",
      title: "Take an earned recovery week",
      why: "Seven loaded weeks without a reset.",
      move: "Your recovery week is drafted — review and apply it when you're ready.",
      draft_pending: true,
    },
  };
  const html = focus.coachingFocusCardHtml(drafted, { actions: true });
  assert.doesNotMatch(html, /data-cfocus-act="recovery-week"/, "the ask never re-renders once the draft landed");
  assert.doesNotMatch(html, /Draft my recovery week/);
  assert.match(html, /Review your recovery week/);
  assert.match(html, /data-cfocus-go="plan-coach"/, "pure navigation — needs no per-surface wiring");
  // Navigate-only surfaces (no actions) still render neither button nor link.
  assert.doesNotMatch(focus.coachingFocusCardHtml(drafted), /Review your recovery week/);
});

test("the plan-coach route lands on the Plan tab's Coach section (the waiting draft)", () => {
  const { focus, state, activated } = loadCoachingFocus();
  state.tab = "progress";
  state.progressSeg = "program";
  focus.cfocusRoute("plan-coach");
  assert.deepEqual(activated, ["plan"], "navigates to Plan");
  assert.equal(state.planJump, "coach", "jumps straight to the Coach/proposals section");
});
