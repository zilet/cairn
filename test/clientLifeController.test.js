import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.classes = new Set(String(element.className || "").split(/\s+/).filter(Boolean));
  }

  contains(name) {
    return this.classes.has(name);
  }
}

class FakeElement {
  constructor(tag = "div", attrs = {}) {
    this.tag = tag;
    this.id = attrs.id || "";
    this.dataset = attrs.dataset ? { ...attrs.dataset } : {};
    this.className = attrs.className || "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.textContent = attrs.textContent || "";
    this.value = attrs.value || "";
    this.defaultValue = attrs.defaultValue || this.value;
    this.disabled = false;
    this.hidden = false;
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    this.parseHtml(this._innerHTML);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get isConnected() {
    return !this.parentElement || this.parentElement.isConnected !== false;
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

  dispatch(type, extra = {}) {
    const event = { target: this, currentTarget: this, preventDefault() {}, ...extra };
    let result;
    for (const handler of this.listeners.get(type) || []) result = handler(event);
    return result;
  }

  click() {
    return this.dispatch("click");
  }

  focus() {}

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector === "[data-ledit]") return Object.hasOwn(this.dataset, "ledit");
    if (selector === "[data-ldel]") return Object.hasOwn(this.dataset, "ldel");
    if (selector === "[data-lresolve]") return Object.hasOwn(this.dataset, "lresolve");
    return false;
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

  parseHtml(html) {
    if (html.includes("life-ev") && html.includes("data-life")) {
      for (const match of html.matchAll(/data-life="([^"]+)"/g)) {
        const row = new FakeElement("div", { className: "sess life-ev", dataset: { life: match[1] } });
        // Resolve renders only on OPEN events, so mirror the real markup instead of
        // always synthesizing the button — that is exactly what the test asserts.
        const resolvable = html.includes(`data-lresolve="${match[1]}"`);
        row._innerHTML =
          (resolvable ? `<button data-lresolve="${match[1]}"></button>` : "") +
          `<button data-ledit="${match[1]}"></button><button data-ldel="${match[1]}"></button>`;
        if (resolvable) row.appendChild(new FakeElement("button", { dataset: { lresolve: match[1] } }));
        row.appendChild(new FakeElement("button", { dataset: { ledit: match[1] } }));
        row.appendChild(new FakeElement("button", { dataset: { ldel: match[1] } }));
        this.appendChild(row);
      }
      return;
    }

    const elementRe = /<(input|select|button|div)\b([^>]*)>/g;
    for (const match of html.matchAll(elementRe)) {
      const attrs = parseAttrs(match[2]);
      if (!attrs.id && !attrs.className && !Object.keys(attrs.dataset).length) continue;
      const child = new FakeElement(match[1], attrs);
      if (child.id === "lKind" && !child.value) child.value = "trip";
      if (child.id === "lSeverity" && !child.value) child.value = "mild";
      if (child.id === "lImpact" && !child.value) child.value = "low";
      this.appendChild(child);
    }
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
  }

  createElement(tag) {
    return new FakeElement(tag);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }
}

function parseAttrs(source) {
  const attrs = { dataset: {} };
  for (const match of String(source || "").matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    const [, name, raw] = match;
    const value = decodeAttr(raw);
    if (name === "id") attrs.id = value;
    else if (name === "class") attrs.className = value;
    else if (name === "value") {
      attrs.value = value;
      attrs.defaultValue = value;
    } else if (name.startsWith("data-")) {
      attrs.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
    }
  }
  return attrs;
}

function decodeAttr(value) {
  return String(value || "")
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function loadController() {
  const document = new FakeDocument();
  const lsData = new Map();
  const localStorage = {
    get length() { return lsData.size; },
    getItem: (key) => (lsData.has(key) ? lsData.get(key) : null),
    setItem: (key, value) => lsData.set(key, String(value)),
    removeItem: (key) => lsData.delete(key),
    key: (index) => [...lsData.keys()][index] || null,
  };
  const context = {
    Array,
    Date,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    String,
    Error,
    document,
    localStorage,
    state: { tab: "me", meSeg: "life" },
    pollToken: 1,
    skelSwap: (fn) => fn(),
    api: async () => ({ ok: true }),
    HTMLElement: FakeElement,
    localISO: () => "2026-06-30",
    stagger: (index) => `--i:${index}`,
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  context.$ = (selector) => document.querySelector(selector);
  // Load the real SWR cache so the optimistic mutation flow (peekCached / swrSet /
  // optimisticMutation) is exercised end-to-end, not stubbed.
  vm.runInNewContext(readFileSync(join(root, "public/js/swr-cache.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/life-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/life-form-helpers.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/life-timeline-actions.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/life-controller.js"), "utf8"), context);
  return { context, document };
}

function harness(overrides = {}) {
  const { context, document } = loadController();
  const view = new FakeElement("main", { id: "view" });
  const headerTitle = new FakeElement("h1", { id: "headerTitle" });
  document.body.appendChild(headerTitle);
  document.body.appendChild(view);
  const requests = [];
  const toasts = [];
  const state = { tab: "me", meSeg: "life", _lifeById: {} };
  const events = overrides.events || [];
  const deps = {
    view,
    state,
    segments: [["life", "Life"]],
    handlers: {},
    headerTitle,
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (overrides.api) return overrides.api(path, opts);
      if (path === "/context-events" && !opts) return events;
      if (path === "/injury-impacts") return { injuries: [] };
      return {};
    },
    armDelete: (_button, onConfirm) => onConfirm(),
    escapeAttr: context.escAttr,
    invalidatePoll: () => { state.invalidated = (state.invalidated || 0) + 1; },
    segBar: () => "<nav></nav>",
    toast: (message) => toasts.push(message),
    wireSeg: () => { state.wired = true; },
  };
  return { context, document, view, state, deps, requests, toasts };
}

test("life controller renders the route and submits timeline events", async () => {
  const h = harness();

  await h.context.CairnLifeController.render(h.deps);
  h.document.querySelector("#lTitle").value = "Lisbon work trip";
  h.document.querySelector("#lLocation").value = "Lisbon";
  h.document.querySelector("#lStart").value = "2026-07-02";
  h.document.querySelector("#lEnd").value = "2026-07-05";
  h.document.querySelector("#lDetail").value = "Hotel gym only";

  await h.document.querySelector("#lAdd").click();

  const post = h.requests.find((request) => request.path === "/context-events" && request.opts?.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.opts.body), {
    kind: "trip",
    title: "Lisbon work trip",
    detail: "Hotel gym only",
    start_date: "2026-07-02",
    end_date: "2026-07-05",
    meta: { location: "Lisbon" },
  });
  assert.equal(h.state.meSeg, "life");
  assert.equal(h.state.invalidated, 1);
  assert.equal(h.toasts.at(-1), "Added");
});

test("life controller wires inline edit and delete actions", async () => {
  const h = harness({
    events: [
      {
        id: 7,
        kind: "injury",
        title: "Knee",
        detail: "No deep flexion",
        start_date: "2026-06-28",
        end_date: null,
        meta_json: JSON.stringify({ area: "left knee", severity: "moderate" }),
      },
    ],
  });

  await h.context.CairnLifeController.render(h.deps);
  await Promise.resolve();

  h.document.querySelector("[data-ledit]").click();
  h.document.querySelector(".le-title").value = "Knee improving";
  h.document.querySelector(".le-meta").value = "right knee";
  h.document.querySelector(".le-detail").value = "Keep squats shallow";

  await h.document.querySelector(".le-save").click();

  const put = h.requests.find((request) => request.path === "/context-events/7" && request.opts?.method === "PUT");
  assert.ok(put);
  assert.deepEqual(JSON.parse(put.opts.body), {
    kind: "injury",
    title: "Knee improving",
    detail: "Keep squats shallow",
    start_date: "2026-06-28",
    end_date: null,
    meta: { area: "right knee", severity: "moderate" },
  });
  assert.equal(h.toasts.at(-1), "Updated");

  await h.context.CairnLifeController.load(h.deps);
  h.document.querySelector("[data-ldel]").click();
  // The optimistic delete resolves through several async hops (apply → request →
  // commit → toast); flush the full microtask/timer queue rather than a fixed count.
  await new Promise((resolve) => setTimeout(resolve));

  const del = h.requests.find((request) => request.path === "/context-events/7" && request.opts?.method === "DELETE");
  assert.ok(del);
  assert.equal(h.toasts.at(-1), "Removed");
});

// The Resolve dead-end: POST /api/context-events/:id/resolve existed and NO client
// called it, so an open-ended injury could only be silenced by deleting the record.
test("life controller resolves an injury in place and stops it reading as active", async () => {
  const h = harness({
    events: [
      {
        id: 12,
        kind: "injury",
        title: "Knee",
        start_date: "2026-06-01",
        end_date: null,
        meta_json: JSON.stringify({ area: "left knee" }),
      },
    ],
    api: async (path, opts) => {
      if (path === "/context-events" && !opts) {
        return [{ id: 12, kind: "injury", title: "Knee", start_date: "2026-06-01", end_date: null }];
      }
      if (path === "/injury-impacts") return { injuries: [] };
      if (path === "/context-events/12/resolve") {
        return { id: 12, kind: "injury", title: "Knee", start_date: "2026-06-01", resolved_at: "2026-06-30" };
      }
      return {};
    },
  });

  await h.context.CairnLifeController.render(h.deps);
  // The warm cached paint lands first and the revalidated paint one hop later;
  // flush the queue so the assertion sees the final markup, not the cached one.
  await new Promise((r) => setTimeout(r));

  const resolve = h.document.querySelector("[data-lresolve]");
  assert.ok(resolve, "an open injury offers Resolve, not only delete");
  resolve.click();
  await new Promise((r) => setTimeout(r));

  const post = h.requests.find(
    (request) => request.path === "/context-events/12/resolve" && request.opts?.method === "POST"
  );
  assert.ok(post, "Resolve calls the endpoint that already existed");
  assert.equal(h.toasts.at(-1), "Marked resolved");
  assert.equal(
    h.context.CairnLife.eventActive({ id: 12, kind: "injury", resolved_at: "2026-06-30" }, "2026-06-30"),
    false,
    "a resolved injury is no longer active even with no end date"
  );
  assert.equal(
    h.context.CairnLife.eventActive({ id: 12, kind: "injury", resolved_at: "2026-07-05" }, "2026-06-30"),
    true,
    "resolved in the future is still open today"
  );
  assert.doesNotMatch(
    h.context.CairnLife.lifeEventInner({ id: 12, kind: "injury", title: "Knee", resolved_at: "2026-06-30" }),
    /data-lresolve/,
    "a closed event offers no second Resolve"
  );
});
