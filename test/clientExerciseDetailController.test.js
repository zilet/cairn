import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.children = [];
    this.dataset = attrs.dataset ? { ...attrs.dataset } : {};
    this.listeners = new Map();
    this.parentElement = null;
    this.style = {};
    this.id = attrs.id || "";
    this.className = attrs.className || "";
    this._innerHTML = "";
    this.disabled = false;
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    for (const id of ["askForm", "exType", "exDelete"]) {
      if (this._innerHTML.includes(`id="${id}"`)) this.appendChild(new FakeElement("button", { id }));
    }
    if (this._innerHTML.includes("data-exercise-explain")) {
      const exercise = this._innerHTML.match(/data-exercise="([^"]*)"/)?.[1] || "";
      this.appendChild(new FakeElement("section", { dataset: { exercise } }));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  click() {
    const result = [];
    for (const handler of this.listeners.get("click") || []) {
      result.push(handler({ target: this, currentTarget: this, preventDefault() {} }));
    }
    return result.at(-1);
  }

  matches(selector) {
    if (selector === ".ex, .prog-row") {
      const classes = this.className.split(/\s+/);
      return classes.includes("ex") || classes.includes("prog-row");
    }
    if (selector === "[data-guide]") return this.dataset.guide != null;
    if (selector === "[data-exercise-explain]") return this.dataset.exercise != null;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
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

  replaceWith(next) {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) {
      next.parentElement = this.parentElement;
      this.parentElement.children.splice(index, 1, next);
    }
    this.parentElement = null;
  }
}

class FakeTemplate extends FakeElement {
  constructor() {
    super("template");
    this.content = { firstElementChild: null };
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    const exercise = this._innerHTML.match(/data-exercise="([^"]*)"/)?.[1] || "";
    const child = new FakeElement("section", { dataset: { exercise } });
    child._innerHTML = this._innerHTML;
    this.content.firstElementChild = child;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
  }

  createElement(tag) {
    return tag === "template" ? new FakeTemplate() : new FakeElement(tag);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadController() {
  const document = new FakeDocument();
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    decodeURIComponent,
    encodeURIComponent,
    window: null,
    globalThis: null,
    document,
    // The guide layer renders through the shared escaping + authed-URL globals.
    escHtml: escapeHtml,
    escAttr: escapeHtml,
    withToken: (url) => url,
  };
  context.window = context;
  context.globalThis = context;
  for (const script of [
    "exercise-detail-data-client.js",
    "exercise-detail-explanation-client.js",
    "exercise-guide-client.js",
    "exercise-detail-render-client.js",
    "exercise-detail-actions-client.js",
    "exercise-detail-controller.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, "public/js", script), "utf8"), context);
  }
  return { context, document };
}

function exerciseDeps(overrides = {}) {
  const requests = [];
  const toasts = [];
  let mounted = null;
  let closed = 0;
  let rendered = 0;
  let chat = "";
  const deps = {
    root: new FakeElement("section"),
    state: { tab: "today", exModes: {} },
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (overrides.api) return overrides.api(path, opts);
      if (path.endsWith("/explanation")) return { ok: true, explanation: { setup: "fresh setup" }, stale: false };
      return {
        found: true,
        name: "Push-up",
        muscle_group: "chest",
        unit: "lb",
        recent: [{ date: "2026-06-30", weight: 0, reps: 12, rir: 2, pr: true }],
        progress: { points: [{ best1rm: 10 }, { best1rm: 20 }] },
        appears: [{ day_number: 1, day_name: "Upper <A>" }],
        cues: "Brace <tight>",
      };
    },
    art: () => "<svg></svg>",
    artImg: (_kind, name) => `<img alt="${escapeHtml(name)}">`,
    closeDetail: () => { closed += 1; },
    escapeHtml,
    exerciseDetail: {
      explanation: (row) => ({ setup: `Setup ${row?.name || ""}` }),
      explanationHtml: (row, explanation) => `<section data-exercise-explain data-exercise="${escapeHtml(row?.name || "")}">${escapeHtml(explanation?.setup || "loading")}</section>`,
      validExplanationPayload: (payload) => Boolean(payload && payload.ok && payload.explanation),
    },
    fmtDur: (seconds) => `${seconds}s`,
    fmtWeight: (weight) => `${weight}lb`,
    gotoChatWith: (message) => { chat = message; },
    mountDetail: (html) => {
      mounted = new FakeElement("div");
      mounted.innerHTML = html;
      return mounted;
    },
    openDetailFrom: (_fromEl, build) => build(),
    postExerciseMode: async (_name, mode) => ({ ok: true, mode }),
    renderToday: () => { rendered += 1; },
    runCountUps: () => {},
    sparklineSvg: () => "<svg class='spark'></svg>",
    toast: (message) => toasts.push(message),
    wireDetailCommon: () => {},
  };
  return {
    deps,
    requests,
    toasts,
    get mounted() { return mounted; },
    get closed() { return closed; },
    get rendered() { return rendered; },
    get chat() { return chat; },
  };
}

test("exercise detail controller wires guide buttons once and opens the exercise", async () => {
  const { context } = loadController();
  const harness = exerciseDeps();
  const card = new FakeElement("article", { className: "ex" });
  const tile = card.appendChild(new FakeElement("div", { className: "artile" }));
  const guide = card.appendChild(new FakeElement("button", { dataset: { guide: encodeURIComponent("Push-up") } }));
  harness.deps.root.appendChild(card);

  context.CairnExerciseDetailController.wireGuides(null, harness.deps);
  context.CairnExerciseDetailController.wireGuides(null, harness.deps);
  guide.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.requests.filter((row) => row.path === "/exercise/Push-up").length, 1);
  assert.equal(tile.style.cursor, "pointer");
  assert.match(harness.mounted.innerHTML, /Upper &lt;A&gt;/);
});

test("exercise detail controller hydrates and replaces matching explanations", async () => {
  const { context, document } = loadController();
  const harness = exerciseDeps();
  const host = new FakeElement("div");
  host.innerHTML = '<section data-exercise-explain data-exercise="Push-up">old</section>';
  document.body.appendChild(host);

  await context.CairnExerciseDetailController.hydrateExerciseExplanation(host, { name: "Push-up" }, harness.deps);

  assert.equal(harness.requests[0].path, "/exercise/Push-up/explanation");
  assert.match(host.querySelector("[data-exercise-explain]").innerHTML, /fresh setup/);
});

test("exercise detail controller action buttons route through injected dependencies", async () => {
  const { context } = loadController();
  const harness = exerciseDeps({
    api: async (path, opts) => {
      harness.requests.push({ path, opts });
      if (path === "/exercises/Push-up") return { ok: true };
      if (path.endsWith("/explanation")) return { ok: false };
      return { found: true, name: "Push-up", muscle_group: "chest", mode: "reps", recent: [], progress: { points: [] } };
    },
  });

  await context.CairnExerciseDetailController.openExerciseModal("Push-up", null, harness.deps);
  harness.mounted.querySelector("#askForm").click();
  assert.equal(harness.closed, 1);
  assert.match(harness.chat, /perform Push-up/);

  await harness.mounted.querySelector("#exType").click();
  assert.equal(harness.deps.state.exModes["Push-up"], "timed");
  assert.equal(harness.rendered, 1);

  await harness.mounted.querySelector("#exDelete").click();
  assert.equal(harness.requests.at(-1).path, "/exercises/Push-up");
  assert.equal(harness.requests.at(-1).opts.method, "DELETE");
  assert.match(harness.toasts.at(-1), /Deleted Push-up/);
});
