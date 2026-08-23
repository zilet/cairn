import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The guide client only ever reaches for the handful of nodes it authored itself, so
// the fake mirrors exactly those: the ask row with its two answers, and the linked
// section with its unlink. innerHTML fabricates children the same way the sibling
// exercise-detail controller test does — by looking for the data attributes the
// module writes, not by parsing HTML.
class FakeElement {
  constructor(tag = "div", dataset = {}) {
    this.tag = tag;
    this.dataset = { ...dataset };
    this.children = [];
    this.listeners = new Map();
    this.parentElement = null;
    this.isConnected = true;
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    const ask = /data-exguide-ask="1"/.test(this._innerHTML);
    if (ask) {
      const node = new FakeElement("div", {
        exguideAsk: "1",
        exguideId: this._innerHTML.match(/data-exguide-id="([^"]*)"/)?.[1] || "",
        exguideExercise: this._innerHTML.match(/data-exguide-exercise="([^"]*)"/)?.[1] || "",
      });
      node.appendChild(new FakeElement("button", { exguideYes: "1" }));
      node.appendChild(new FakeElement("button", { exguideNo: "1" }));
      this.appendChild(node);
    }
    if (/data-exguide="1"/.test(this._innerHTML)) {
      const node = new FakeElement("details", { exguide: "1" });
      const unlink = this._innerHTML.match(/data-exguide-unlink="([^"]*)"/)?.[1];
      if (unlink) node.appendChild(new FakeElement("button", { exguideUnlink: unlink }));
      this.appendChild(node);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get ownerDocument() {
    return FakeElement.document;
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
    return Promise.all((this.listeners.get("click") || []).map((handler) => handler({ target: this })));
  }

  matches(selector) {
    const attribute = selector.replace(/^\[data-|\]$/g, "");
    const key = attribute.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    return this.dataset[key] != null;
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
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const out = [];
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }

  remove() {
    this.isConnected = false;
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  replaceWith(next) {
    const siblings = this.parentElement?.children;
    if (siblings) {
      next.parentElement = this.parentElement;
      siblings.splice(siblings.indexOf(this), 1, next);
    }
    this.isConnected = false;
    this.parentElement = null;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadGuideClient() {
  const document = {
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  FakeElement.document = document;
  const context = {
    Array,
    Boolean,
    Error,
    JSON,
    Object,
    Promise,
    String,
    encodeURIComponent,
    window: null,
    globalThis: null,
    document,
    escHtml: escapeHtml,
    escAttr: escapeHtml,
    withToken: (url) => url,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/exercise-guide-client.js"), "utf8"), context);
  return context.CairnExerciseGuide;
}

const GUIDE = {
  guide_id: "Barbell_Hip_Thrust",
  name: "Barbell Hip Thrust",
  instructions: ["Set up.", "Drive."],
  images: [],
  primary_muscles: ["glutes"],
  source: "free-exercise-db",
  license: "Unlicense (public domain)",
  source_url: "https://github.com/yuhonas/free-exercise-db",
};

const SUGGESTION = { exercise: "Hip Thrust", guide_id: "Barbell_Hip_Thrust", guide_name: "Barbell Hip Thrust" };

function mount(guideClient, html, api) {
  const host = new FakeElement("div");
  host.innerHTML = html;
  guideClient.wire(host, { api });
  return host;
}

test("a low-confidence candidate is asked as one calm question, or not at all", () => {
  const guide = loadGuideClient();
  assert.equal(guide.suggestionHtml(null), "");
  assert.equal(guide.suggestionHtml({ guide_id: "X" }), "", "a half-formed candidate is silence");

  const html = guide.suggestionHtml(SUGGESTION);
  assert.match(html, /Looks like Barbell Hip Thrust — use its guide\?/);
  assert.match(html, /data-exguide-yes/);
  assert.match(html, /data-exguide-no/);
  // Calm: a question, not a claim, and never a count or a badge.
  assert.doesNotMatch(html, /badge|[0-9]+ (match|suggestion)/i);

  // Dataset text is escaped like every other interpolated string.
  const nasty = guide.suggestionHtml({ ...SUGGESTION, guide_name: '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(nasty, /<img src=x/);
  assert.match(nasty, /&lt;img src=x/);
});

test("yes attaches the candidate and shows the guide in its place", async () => {
  const guideClient = loadGuideClient();
  const calls = [];
  const api = async (path, opts) => {
    calls.push({ path, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    if (path === "/exercise-guides/attach") return { ok: true };
    return GUIDE;
  };
  const host = mount(guideClient, guideClient.suggestionHtml(SUGGESTION), api);
  const ask = host.querySelector("[data-exguide-ask]");

  await ask.querySelector("[data-exguide-yes]").click();

  assert.deepEqual(calls[0], {
    path: "/exercise-guides/attach",
    method: "POST",
    body: { exercise: "Hip Thrust", guide_id: "Barbell_Hip_Thrust" },
  });
  assert.equal(calls[1].path, "/exercise-guides/Hip%20Thrust");
  // The question is replaced by its answer — the How-to section itself.
  assert.equal(host.querySelector("[data-exguide-ask]"), null);
  assert.ok(host.querySelector("[data-exguide]"), "the linked guide takes the row's place");
});

test("a refused attach leaves the question standing", async () => {
  const guideClient = loadGuideClient();
  const api = async () => ({ ok: false, error: "exercise not found" });
  const host = mount(guideClient, guideClient.suggestionHtml(SUGGESTION), api);

  await host.querySelector("[data-exguide-yes]").click();

  assert.ok(host.querySelector("[data-exguide-ask]"), "nothing was claimed, so nothing changes");
});

test("no dismisses the candidate through detach, quietly", async () => {
  const guideClient = loadGuideClient();
  const calls = [];
  const api = async (path, opts) => {
    calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true };
  };
  const host = mount(guideClient, guideClient.suggestionHtml(SUGGESTION), api);

  await host.querySelector("[data-exguide-no]").click();

  assert.deepEqual(calls, [{ path: "/exercise-guides/detach", body: { guide_id: "Barbell_Hip_Thrust" } }]);
  assert.equal(host.querySelector("[data-exguide-ask]"), null);
});

test("the way out of a linked guide lives inside the opened section", async () => {
  const guideClient = loadGuideClient();
  const html = guideClient.sectionHtml(GUIDE);
  // Not on the summary row: an athlete who never opens "How to" is never offered an undo.
  assert.match(html, /<div class="exguide-body">[\s\S]*data-exguide-unlink/);
  assert.doesNotMatch(html.split("</summary>")[0], /data-exguide-unlink/);

  const calls = [];
  const host = mount(guideClient, html, async (path, opts) => {
    calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true };
  });

  await host.querySelector("[data-exguide-unlink]").click();

  assert.deepEqual(calls, [{ path: "/exercise-guides/detach", body: { guide_id: "Barbell_Hip_Thrust" } }]);
  assert.equal(host.querySelector("[data-exguide]"), null, "the whole section goes, not just the button");
});
