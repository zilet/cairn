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

  add(name) {
    this.classes.add(name);
    this.element.className = [...this.classes].join(" ");
  }

  remove(name) {
    this.classes.delete(name);
    this.element.className = [...this.classes].join(" ");
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name) {
    if (this.classes.has(name)) this.classes.delete(name);
    else this.classes.add(name);
    this.element.className = [...this.classes].join(" ");
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

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, extra = {}) {
    const results = [];
    const event = { target: this, currentTarget: this, preventDefault() {}, ...extra };
    for (const handler of this.listeners.get(type) || []) results.push(handler(event));
    return results.at(-1);
  }

  click() {
    return this.dispatch("click");
  }

  focus() {}
  scrollIntoView() {}

  getAttribute(name) {
    if (name === "role") return this.role || null;
    return null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  insertAdjacentHTML(position, html) {
    const rows = parseHdocRows(html);
    for (const row of rows) {
      if (position === "afterbegin") this.children.unshift(row);
      else this.appendChild(row);
      row.parentElement = this;
    }
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === ".hdoc") return this.classList.contains("hdoc");
    if (selector === ".empty") return this.classList.contains("empty");
    if (selector === ".enr-pending") return this.classList.contains("enr-pending");
    if (selector === "[data-hdel]") return Object.hasOwn(this.dataset, "hdel");
    if (selector === "[data-hdate-edit]") return Object.hasOwn(this.dataset, "hdateEdit");
    if (selector === "[data-hdate-save]") return Object.hasOwn(this.dataset, "hdateSave");
    if (selector === "[data-hdate-cancel]") return Object.hasOwn(this.dataset, "hdateCancel");
    if (selector === "[data-hdate]") return Object.hasOwn(this.dataset, "hdate");
    if (selector === "[data-hdate-editor]") return Object.hasOwn(this.dataset, "hdateEditor");
    if (selector === "[data-hdate-flash]") return Object.hasOwn(this.dataset, "hdateFlash");
    if (selector === "[data-hrescan]") return Object.hasOwn(this.dataset, "hrescan");
    if (selector === "[data-hdoc-toggle]") return Object.hasOwn(this.dataset, "hdocToggle");
    const exactHdoc = selector.match(/^\.hdoc\[data-hdoc="([^"]+)"\]$/);
    if (exactHdoc) return this.matches(".hdoc") && this.dataset.hdoc === exactHdoc[1];
    if (selector === ".hdoc[data-hdoc]") return this.matches(".hdoc") && !!this.dataset.hdoc;
    return false;
  }

  querySelector(selector) {
    if (selector.includes(" ")) {
      const [head, ...tail] = selector.trim().split(/\s+/);
      return this.querySelector(head)?.querySelector(tail.join(" ")) || null;
    }
    if (this.matches(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector.includes(" ")) {
      const [head, ...tail] = selector.trim().split(/\s+/);
      return this.querySelectorAll(head).flatMap((node) => node.querySelectorAll(tail.join(" ")));
    }
    const out = [];
    if (this.matches(selector)) out.push(this);
    for (const child of this.children) out.push(...child.querySelectorAll(selector));
    return out;
  }

  parseHtml(html) {
    if (html.includes("data-records-tab")) {
      this.appendChild(new FakeElement("input", { id: "hFile" }));
      this.appendChild(new FakeElement("span", { id: "hFileName" }));
      this.appendChild(new FakeElement("div", { id: "hUploadBox" }));
      this.appendChild(new FakeElement("label", { id: "hFileLabel" }));
      this.appendChild(new FakeElement("textarea", { id: "hText" }));
      this.appendChild(new FakeElement("button", { id: "hUpload" }));
      this.appendChild(new FakeElement("div", { id: "hStatus" }));
      this.appendChild(new FakeElement("div", { id: "hlist" }));
      return;
    }
    if (html.includes("data-inner")) {
      addDocControls(this);
      return;
    }
    for (const row of parseHdocRows(html)) this.appendChild(row);
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }
}

function parseHdocRows(html) {
  const rows = [];
  for (const match of String(html || "").matchAll(/data-hdoc="([^"]+)"/g)) {
    rows.push(makeDocRow(match[1]));
  }
  return rows;
}

function makeDocRow(id, status = "done") {
  const row = new FakeElement("article", { className: "hdoc hdoc-collapsed", dataset: { hdoc: String(id) } });
  addDocControls(row, status);
  return row;
}

function addDocControls(row, status = "done") {
  row.appendChild(new FakeElement("button", { dataset: { hdel: "" } }));
  row.appendChild(new FakeElement("button", { dataset: { hdateEdit: "" } }));
  row.appendChild(new FakeElement("div", { dataset: { hdateEditor: "" } }));
  row.appendChild(new FakeElement("button", { dataset: { hdateSave: "" } }));
  row.appendChild(new FakeElement("button", { dataset: { hdateCancel: "" } }));
  row.appendChild(new FakeElement("input", { value: "2026-06-30", defaultValue: "2026-06-30", dataset: { hdate: "" } }));
  row.appendChild(new FakeElement("div", { dataset: { hdateFlash: "" } }));
  row.appendChild(new FakeElement("button", { dataset: { hrescan: "" } }));
  row.appendChild(new FakeElement("button", { dataset: { hdocToggle: "" } }));
  if (status === "pending") row.appendChild(new FakeElement("span", { className: "enr-pending" }));
}

function loadController() {
  const document = new FakeDocument();
  const localStorage = new Map();
  const context = {
    Array,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    String,
    setTimeout,
    window: null,
    globalThis: null,
    document,
    HTMLElement: FakeElement,
    localStorage: {
      setItem: (key, value) => localStorage.set(key, String(value)),
      getItem: (key) => localStorage.get(key) || null,
    },
    $: (selector) => document.querySelector(selector),
    peekCached: () => null,
    swrSet: () => {},
    swrInvalidate: () => {},
    CairnHealthClient: {
      H_FILE_PROMPT: "Drop docs",
      MAX_DOC_BYTES: 15 * 1024 * 1024,
      MAX_DOC_TEXT: 400000,
      guessUploadMime: () => "text/plain",
    },
    CairnHealthDocs: {
      healthDocHtml: (doc) => `<article class="hdoc" data-hdoc="${String(doc.id)}">${String(doc.original_name || "")}</article>`,
      healthDocInner: () => `<div data-inner="1"></div>`,
    },
    CairnHealthRecords: {
      recordsTabHtml: () => `<section data-records-tab="1"></section>`,
      recordsEmptyHtml: () => `<div class="empty">No documents yet</div>`,
      recordsListHtml: (docs) => docs.map((doc) => `<article class="hdoc" data-hdoc="${String(doc.id)}"></article>`).join(""),
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-doc-upload-controller.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-doc-date-actions-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-doc-lifecycle-actions-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/health-doc-actions-controller.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/me-records-health-doc-controller.js"), "utf8"), context);
  return { context, document, localStorage };
}

function controllerHarness(overrides = {}) {
  const { context, document, localStorage } = loadController();
  const hContent = new FakeElement("section", { id: "hContent" });
  document.body.appendChild(hContent);
  const requests = [];
  const toasts = [];
  const polls = [];
  const markerTokens = [];
  let pictureCache = overrides.pictureCache || null;
  let picturePaints = 0;
  const deps = {
    state: { tab: "me", meSeg: "health", healthSeg: "records", pendingHealthDocId: null },
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (overrides.api) return overrides.api(path, opts);
      if (path === "/health-docs" && opts?.method === "POST") return { id: 2, original_name: "Pasted results", enrichment_status: "pending", created_at: "2026-07-01T10:00:00Z" };
      if (path === "/health-docs") return [];
      if (path === "/health-docs/7") return { id: 7, enrichment_status: "done" };
      return {};
    },
    toast: (message) => toasts.push(message),
    armDelete: (_btn, onConfirm) => onConfirm(),
    pollEnrichment: (path, id, options) => polls.push({ path, id, options }),
    enrichmentActive: (status) => status === "pending" || status === "in_progress",
    pollToken: () => 11,
    loadHealthMarkers: (token) => markerTokens.push(token),
    paintHealthPicture: () => { picturePaints += 1; },
    getHealthPictureCache: () => pictureCache,
    setHealthPictureCache: (cache) => { pictureCache = cache; return cache; },
  };
  return {
    context,
    document,
    localStorage,
    deps,
    requests,
    toasts,
    polls,
    markerTokens,
    get pictureCache() { return pictureCache; },
    get picturePaints() { return picturePaints; },
  };
}

test("health records controller renders records and uploads pasted text", async () => {
  const harness = controllerHarness();

  await harness.context.CairnHealthRecordsController.render(harness.deps);
  const text = harness.document.querySelector("#hText");
  text.value = "A1c 5.4";
  text.dispatch("input");

  await harness.document.querySelector("#hUpload").click();

  const post = harness.requests.find((request) => request.path === "/health-docs" && request.opts?.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.opts.body), { original_name: "Pasted results", text: "A1c 5.4" });
  assert.equal(harness.toasts.at(-1), "Uploaded");
  assert.equal(harness.polls[0].path, "/health-docs");
  assert.equal(harness.polls[0].id, 2);
  assert.equal(harness.pictureCache.docCount, 1);
  assert.equal(harness.picturePaints, 1);
});

test("health records controller saves document date and deletes record", async () => {
  const harness = controllerHarness({ pictureCache: { review: null, docCount: 2, newestDocAt: "2026-06-30T00:00:00Z" } });
  const list = new FakeElement("div", { id: "hlist" });
  const row = makeDocRow("7");
  list.appendChild(row);
  harness.document.body.appendChild(list);

  harness.context.CairnHealthRecordsController.wireDoc(row, harness.deps);
  row.querySelector("[data-hdate]").value = "2026-07-01";
  await row.querySelector("[data-hdate-save]").click();

  const put = harness.requests.find((request) => request.path === "/health-docs/7" && request.opts?.method === "PUT");
  assert.ok(put);
  assert.deepEqual(JSON.parse(put.opts.body), { doc_date: "2026-07-01" });
  assert.deepEqual(harness.markerTokens, [11]);
  assert.equal(harness.picturePaints, 1);

  const refreshedDelete = row.querySelector("[data-hdel]");
  await refreshedDelete.click();
  const del = harness.requests.find((request) => request.path === "/health-docs/7" && request.opts?.method === "DELETE");
  assert.ok(del);
  assert.equal(row.parentElement, null);
  assert.equal(harness.pictureCache.docCount, 1);
  assert.deepEqual(harness.markerTokens, [11, 11]);
  assert.equal(harness.toasts.at(-1), "Removed");
});
