import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class FakeElement {
  constructor(tag = "div", { id = "", className = "" } = {}) {
    this.tag = tag;
    this.id = id;
    this.className = className;
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.innerHTML = "";
    this.inserted = [];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }

  querySelectorAll(selector) {
    const out = [];
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  insertAdjacentHTML(position, html) {
    this.inserted.push({ position, html });
  }
}

// Loads the real compiled capture-reads-client.js. `CairnCaptureReadCards` /
// `CairnCaptureReadJobs` are only resolved lazily inside createController, so
// the pure weekWinsItems/weekWinsHtml helpers need no stubs at all; the
// controller-wiring tests below supply minimal stand-ins.
function loadCaptureReads({ renderWeeklyInSlot, renderInsightInSlot } = {}) {
  const context = {
    Object,
    Array,
    String,
    Promise,
    window: null,
  };
  context.window = context;
  context.CairnCaptureReadDate = { weekRangeLabel: () => "" };
  context.CairnCaptureReadCards = {
    renderWeeklyInSlot: renderWeeklyInSlot || (() => {}),
    renderInsightInSlot: renderInsightInSlot || (() => {}),
  };
  context.CairnCaptureReadJobs = {
    createController: () => ({
      maybeGenerateWeekly: () => {},
      maybeGenerateInsight: () => {},
      reconnectInsight: () => null,
    }),
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-reads-client.js"), "utf8"), context);
  return context.CairnCaptureReads;
}

test("captureWeekWinsItems builds up to three quiet lines in priority order, escaping names", () => {
  const capture = loadCaptureReads();
  const payload = {
    prs: [{ exercise: "Back <Squat>", label: "225 lb × 5 — new best" }, { exercise: "Hammer Curl", label: "35 lb × 8 — new best" }],
    volume_filled: [{ muscle: "chest", label: "14 hard sets — productive volume" }, { muscle: "back & lats", label: "9 hard sets — productive volume" }],
    pace: { status: "on", label: "On pace for your goal" },
  };

  const items = Array.from(capture.weekWinsItems(payload, escapeHtml));
  assert.deepEqual(items, [
    "New bests on Back &lt;Squat&gt; and Hammer Curl",
    "Chest and Back &amp; Lats hit their productive volume",
    "On pace for your goal",
  ]);

  const html = capture.weekWinsHtml(items);
  assert.match(html, /This week's wins/);
  assert.match(html, /<li class="weekly-wins-item">New bests on Back &lt;Squat&gt; and Hammer Curl<\/li>/);
});

test("captureWeekWinsItems renders nothing for an absent, empty, or off-pace payload — adherence-neutral, no placeholder", () => {
  const capture = loadCaptureReads();
  assert.deepEqual(Array.from(capture.weekWinsItems(null, escapeHtml)), []);
  assert.deepEqual(Array.from(capture.weekWinsItems(undefined, escapeHtml)), []);
  assert.deepEqual(Array.from(capture.weekWinsItems({}, escapeHtml)), []);
  assert.deepEqual(
    Array.from(
      capture.weekWinsItems({ prs: [], volume_filled: [], pace: { status: "behind", label: "behind pace" } }, escapeHtml),
    ),
    [],
  );
  assert.equal(capture.weekWinsHtml([]), "");
});

test("captureWeekWinsItems only surfaces pace when status is exactly 'on'", () => {
  const capture = loadCaptureReads();
  assert.deepEqual(Array.from(capture.weekWinsItems({ pace: { status: "behind", label: "behind pace" } }, escapeHtml)), []);
  assert.deepEqual(Array.from(capture.weekWinsItems({ pace: { status: "fast", label: "ahead of pace" } }, escapeHtml)), []);
  assert.deepEqual(
    Array.from(capture.weekWinsItems({ pace: { status: "on", label: "on pace for your goal" } }, escapeHtml)),
    ["on pace for your goal"],
  );
});

test("captureWeekWinsItems caps the PR names shown and notes the remainder", () => {
  const capture = loadCaptureReads();
  const payload = {
    prs: [{ exercise: "Back Squat" }, { exercise: "Bench Press" }, { exercise: "Deadlift" }, { exercise: "Overhead Press" }],
  };
  assert.deepEqual(Array.from(capture.weekWinsItems(payload, escapeHtml)), [
    "New bests on Back Squat, Bench Press, Deadlift, and 1 more",
  ]);
});

test("loadTodayReads appends the wins strip beneath the weekly card, above the feedback row", async () => {
  let foot;
  const captureReads = loadCaptureReads({
    renderWeeklyInSlot: (target) => {
      const card = new FakeElement("section", { className: "weekly-card" });
      foot = new FakeElement("div", { className: "weekly-foot" });
      card.appendChild(foot);
      target.appendChild(card);
    },
  });

  const wSlot = new FakeElement("div", { id: "weeklySlot" });
  const rootEl = new FakeElement("section");
  rootEl.appendChild(wSlot);

  const apiCalls = [];
  const deps = {
    root: rootEl,
    state: { tab: "today" },
    api: async (path) => {
      apiCalls.push(path);
      if (path === "/insights") return [{ id: 1, kind: "weekly_read", text: "The week went well." }];
      if (path === "/week-wins") {
        return { prs: [{ exercise: "Back Squat" }], volume_filled: [], pace: { status: "on", label: "On pace for your goal" } };
      }
      return null;
    },
    runOp: () => {},
    toast: () => {},
    collapseEl: () => {},
    escapeHtml,
    storage: null,
  };

  const controller = captureReads.createController(deps);
  await controller.loadTodayReads();
  await flush();

  assert.deepEqual(apiCalls, ["/insights", "/week-wins"]);
  assert.equal(foot.inserted.length, 1);
  assert.equal(foot.inserted[0].position, "beforebegin");
  assert.match(foot.inserted[0].html, /New best on Back Squat/);
  assert.match(foot.inserted[0].html, /On pace for your goal/);
});

test("loadTodayReads leaves the weekly card untouched when /week-wins fails", async () => {
  let foot;
  const captureReads = loadCaptureReads({
    renderWeeklyInSlot: (target) => {
      const card = new FakeElement("section", { className: "weekly-card" });
      foot = new FakeElement("div", { className: "weekly-foot" });
      card.appendChild(foot);
      target.appendChild(card);
    },
  });

  const wSlot = new FakeElement("div", { id: "weeklySlot" });
  const rootEl = new FakeElement("section");
  rootEl.appendChild(wSlot);

  const deps = {
    root: rootEl,
    state: { tab: "today" },
    api: async (path) => {
      if (path === "/insights") return [{ id: 1, kind: "weekly_read", text: "…" }];
      if (path === "/week-wins") throw new Error("network down");
      return null;
    },
    runOp: () => {},
    toast: () => {},
    collapseEl: () => {},
    escapeHtml,
    storage: null,
  };

  const controller = captureReads.createController(deps);
  await controller.loadTodayReads();
  await flush();

  assert.equal(foot.inserted.length, 0);
});

test("loadTodayReads' wins strip is a no-op once the athlete has left Today", async () => {
  let foot;
  const captureReads = loadCaptureReads({
    renderWeeklyInSlot: (target) => {
      const card = new FakeElement("section", { className: "weekly-card" });
      foot = new FakeElement("div", { className: "weekly-foot" });
      card.appendChild(foot);
      target.appendChild(card);
    },
  });

  const wSlot = new FakeElement("div", { id: "weeklySlot" });
  const rootEl = new FakeElement("section");
  rootEl.appendChild(wSlot);

  const deps = {
    root: rootEl,
    state: { tab: "today" },
    api: async (path) => {
      if (path === "/insights") return [{ id: 1, kind: "weekly_read", text: "…" }];
      if (path === "/week-wins") {
        deps.state.tab = "plan"; // navigated away while the wins fetch was in flight
        return { prs: [{ exercise: "Back Squat" }] };
      }
      return null;
    },
    runOp: () => {},
    toast: () => {},
    collapseEl: () => {},
    escapeHtml,
    storage: null,
  };

  const controller = captureReads.createController(deps);
  await controller.loadTodayReads();
  await flush();

  assert.equal(foot.inserted.length, 0);
});
