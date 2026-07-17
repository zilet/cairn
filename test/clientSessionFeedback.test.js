import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the pure Today session-status helpers (IIFE → globalThis.CairnTodaySessionStatus)
// into a shared VM context. Run `npm run client:build` first — this loads the BUILT
// output so the test exercises the real done-card + feedback-form builders.
function loadStatus() {
  const esc = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const context = {
    Array,
    Boolean,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Set,
    String,
    escHtml: esc,
    escAttr: esc,
    fmtWeight: (value) => `${value} lb`,
    fmtDur: (value) => `${value}s`,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-status-client.js"), "utf8"), context);
  return context;
}

// A finished session with a PR-less loaded lift, a journey move, and notes so every
// done-card region renders and their DOM order can be pinned.
function doneSession() {
  return {
    id: 3,
    title: "Lower A",
    notes: "felt strong",
    duration_min: 52,
    sets: [
      { exercise: "Squat", weight: 225, reps: 5 },
      { exercise: "Squat", weight: 225, reps: 5 },
    ],
    strength_journey_movement: { exercise: "Squat", capacity_delta_lb: 5, gap_closed_lb: 2 },
  };
}

test("done card: feedback slot sits directly under the chips, above journey/analysis/notes/actions", () => {
  const ctx = loadStatus();
  // Pass highlights ({}) so the card skips the async hydration path.
  const html = ctx.CairnTodaySessionStatus.sessionDoneCardHtml(
    doneSession(),
    { name: "Lower A" },
    { isToday: true },
    {}
  );
  const at = (needle) => html.indexOf(needle);
  const chips = at("done-chips");
  const feedback = at('id="feedbackSlot"');
  const journey = at("done-journey");
  const analysis = at("done-analysis");
  const notes = at("done-notes");
  const actions = at("done-actions");
  for (const [label, index] of Object.entries({ chips, feedback, journey, analysis, notes, actions })) {
    assert.ok(index >= 0, `${label} region should render`);
  }
  assert.ok(chips < feedback, "feedback follows the headline chips");
  assert.ok(feedback < journey, "feedback is above the journey 1RM line");
  assert.ok(journey < analysis, "feedback is above the analysis");
  assert.ok(analysis < notes, "feedback (and analysis) is above notes");
  assert.ok(notes < actions, "actions stay at the bottom");
});

test("feedback form: joint free-text starts collapsed behind 'anything ache?'", () => {
  const ctx = loadStatus();
  const html = ctx.CairnTodaySessionStatus.feedbackFormHtml({});
  // Both feel scales render as their own line.
  assert.match(html, /data-feel="soreness"/);
  assert.match(html, /data-feel="performance"/);
  // The affordance is present and the input starts hidden.
  assert.match(html, /id="feedbackJointToggle"/);
  const inputTag = /<input[^>]*id="feedbackJoint"[^>]*>/.exec(html)[0];
  assert.match(inputTag, /\bhidden\b/);
  const toggleTag = /<button[^>]*id="feedbackJointToggle"[^>]*>/.exec(html)[0];
  assert.doesNotMatch(toggleTag, /\bhidden\b/);
});

test("feedback form: a session already carrying a joint note opens with the field shown", () => {
  const ctx = loadStatus();
  const html = ctx.CairnTodaySessionStatus.feedbackFormHtml({ joint_pain: "left knee" });
  const inputTag = /<input[^>]*id="feedbackJoint"[^>]*>/.exec(html)[0];
  assert.doesNotMatch(inputTag, /\bhidden\b/);
  assert.match(inputTag, /left knee/);
  const toggleTag = /<button[^>]*id="feedbackJointToggle"[^>]*>/.exec(html)[0];
  assert.match(toggleTag, /\bhidden\b/);
});

// ---- behavioral tests: renderFeedback (today-session-feedback-client.ts) ----
// These load the feedback controller alongside the status helpers into one VM
// context and drive it against a focused DOM fake that parses the REAL
// feedbackFormHtml output (so the fake reflects the actual #feedbackJointToggle +
// hidden joint input, not a hand-mocked shape).

function loadFeedback() {
  const ctx = loadStatus();
  // Same context object → the feedback IIFE sees CairnTodaySessionStatus.
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-feedback-client.js"), "utf8"), ctx);
  return ctx;
}

function decodeAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function makeClassList(owner) {
  const names = new Set(
    String(owner.className || "")
      .split(/\s+/)
      .filter(Boolean)
  );
  const sync = () => {
    owner.className = [...names].join(" ");
  };
  return {
    add: (...ns) => {
      for (const n of ns) if (n) names.add(n);
      sync();
    },
    remove: (...ns) => {
      for (const n of ns) names.delete(n);
      sync();
    },
    contains: (n) => names.has(n),
    toggle: (n, on) => {
      if (on) names.add(n);
      else names.delete(n);
      sync();
    },
  };
}

// A minimal DOM node that parses the built feedback-form HTML into the children
// the controller queries: five feel-dots per scale, the joint toggle + input
// (carrying their real hidden state), and dismiss.
class FakeEl {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this.dataset = { ...(attrs.dataset || {}) };
    this.value = attrs.value || "";
    this.hidden = Boolean(attrs.hidden);
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.classList = makeClassList(this);
    this._html = "";
    this.focusCount = 0;
  }

  set innerHTML(value) {
    this._html = String(value || "");
    this.children = [];
    if (this._html.includes("feedback-form")) {
      for (const feel of ["soreness", "performance"]) {
        for (let val = 1; val <= 5; val++) {
          this.append(new FakeEl("button", { className: "feel-dot", dataset: { feel, val: String(val) } }));
        }
      }
      const toggleTag = /<button[^>]*id="feedbackJointToggle"[^>]*>/.exec(this._html)?.[0] || "";
      this.append(new FakeEl("button", { id: "feedbackJointToggle", hidden: /\bhidden\b/.test(toggleTag) }));
      const inputTag = /<input[^>]*id="feedbackJoint"[^>]*>/.exec(this._html)?.[0] || "";
      this.append(
        new FakeEl("input", {
          id: "feedbackJoint",
          value: decodeAttr(/value="([^"]*)"/.exec(inputTag)?.[1] || ""),
          hidden: /\bhidden\b/.test(inputTag),
        })
      );
      this.append(new FakeEl("button", { id: "feedbackDismiss" }));
    }
    if (this._html.includes('id="feedbackEdit"')) this.append(new FakeEl("button", { id: "feedbackEdit" }));
  }

  get innerHTML() {
    return this._html;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  // Returns each handler's result so async click handlers can be awaited.
  dispatch(type, event = {}) {
    return (this.listeners.get(type) || []).map((handler) =>
      handler({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event })
    );
  }

  click() {
    return this.dispatch("click");
  }

  focus() {
    this.focusCount += 1;
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const feel = /^\.feel-dot\[data-feel="([^"]+)"\]$/.exec(selector);
    if (feel) return this.classList.contains("feel-dot") && this.dataset.feel === feel[1];
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return false;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    if (this.matches(selector)) out.push(this);
    for (const child of this.children) out.push(...child.querySelectorAll(selector));
    return out;
  }
}

// A #feedbackSlot inside a .sessiondone card so renderFeedback takes the done-card
// path (renders the OPEN form directly, the finish moment).
function makeDoneSlot() {
  const card = new FakeEl("div", { className: "sessiondone" });
  return card.append(new FakeEl("div", { id: "feedbackSlot", className: "feedback-slot done-feedback" }));
}

function makeDeps(ctx, { fail = false } = {}) {
  const requests = [];
  const toasts = [];
  return {
    requests,
    toasts,
    deps: {
      state: { logDate: "2026-07-16" },
      api: (path, opts) => {
        requests.push({ path, opts });
        return Promise.resolve(fail ? { error: "nope" } : {});
      },
      toast: (message) => toasts.push(message),
      sessionStatus: ctx.CairnTodaySessionStatus,
    },
  };
}

async function flush() {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

test("renderFeedback: answering BOTH scales collapses to the settled 'Noted' line", async () => {
  const ctx = loadFeedback();
  const slot = makeDoneSlot();
  const session = { date: "2026-07-16" };
  const { deps, requests } = makeDeps(ctx);
  ctx.CairnTodaySessionFeedback.renderFeedback(slot, session, deps);
  // Still the open form at this point.
  assert.match(slot.innerHTML, /feedback-form/);

  await Promise.all(slot.querySelectorAll('.feel-dot[data-feel="soreness"]')[1].click()); // soreness 2
  await Promise.all(slot.querySelectorAll('.feel-dot[data-feel="performance"]')[2].click()); // performance 3
  await flush();

  assert.match(slot.innerHTML, /Noted — it'll shape next week\./);
  assert.doesNotMatch(slot.innerHTML, /feedback-form/);
  // The collapse rode a real save carrying both scales.
  assert.deepEqual(JSON.parse(requests.at(-1).opts.body), { soreness: 2, performance: 3, joint_pain: null });
});

test("renderFeedback: answering only ONE scale keeps the form open (no premature collapse)", async () => {
  const ctx = loadFeedback();
  const slot = makeDoneSlot();
  const { deps } = makeDeps(ctx);
  ctx.CairnTodaySessionFeedback.renderFeedback(slot, { date: "2026-07-16" }, deps);

  const soreDots = slot.querySelectorAll('.feel-dot[data-feel="soreness"]');
  await Promise.all(soreDots[1].click()); // soreness 2 only
  await flush();

  assert.match(slot.innerHTML, /feedback-form/);
  assert.doesNotMatch(slot.innerHTML, /Noted — it'll shape next week\./);
  // The answered scale stays filled (optimistic apply survived a successful save).
  assert.equal(soreDots[1].classList.contains("feel-dot-on"), true);
});

test("renderFeedback: the 'anything ache?' toggle reveals the joint input in place", async () => {
  const ctx = loadFeedback();
  const slot = makeDoneSlot();
  const { deps } = makeDeps(ctx);
  ctx.CairnTodaySessionFeedback.renderFeedback(slot, { date: "2026-07-16" }, deps);

  const toggle = slot.querySelector("#feedbackJointToggle");
  const joint = slot.querySelector("#feedbackJoint");
  assert.equal(toggle.hidden, false);
  assert.equal(joint.hidden, true);

  await Promise.all(toggle.click());
  assert.equal(toggle.hidden, true);
  assert.equal(joint.hidden, false);
  assert.equal(joint.focusCount, 1);
});

test("renderFeedback: a failed save rolls back the dots and does NOT collapse", async () => {
  const ctx = loadFeedback();
  const slot = makeDoneSlot();
  const { deps, toasts } = makeDeps(ctx, { fail: true });
  ctx.CairnTodaySessionFeedback.renderFeedback(slot, { date: "2026-07-16" }, deps);

  const soreDots = slot.querySelectorAll('.feel-dot[data-feel="soreness"]');
  await Promise.all(soreDots[2].click()); // soreness 3
  await flush();

  // Every soreness dot rolled back to off, form intact, no collapse.
  assert.equal(
    soreDots.some((dot) => dot.classList.contains("feel-dot-on")),
    false
  );
  assert.match(slot.innerHTML, /feedback-form/);
  assert.doesNotMatch(slot.innerHTML, /Noted — it'll shape next week\./);
  assert.deepEqual(toasts, ["Couldn't save that — try again."]);
});
