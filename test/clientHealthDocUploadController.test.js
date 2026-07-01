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
    this.disabled = false;
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
    const event = { target: this, currentTarget: this, preventDefault() {}, ...extra };
    let result;
    for (const handler of this.listeners.get(type) || []) result = handler(event);
    return result;
  }

  click() {
    return this.dispatch("click");
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector === ".empty") return this.classList.contains("empty");
    const hdoc = selector.match(/^\.hdoc\[data-hdoc="([^"]+)"\]$/);
    if (hdoc) return this.classList.contains("hdoc") && this.dataset.hdoc === hdoc[1];
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

  insertAdjacentHTML(position, html) {
    const id = String(html || "").match(/data-hdoc="([^"]+)"/)?.[1] || "";
    const row = new FakeElement("article", { className: "hdoc", dataset: { hdoc: id } });
    if (position === "afterbegin") this.children.unshift(row);
    else this.children.push(row);
    row.parentElement = this;
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

function loadUploadController() {
  const document = new FakeDocument();
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
    window: null,
    globalThis: null,
    document,
    FileReader: class {},
    $: (selector) => document.querySelector(selector),
    CairnHealthClient: {
      H_FILE_PROMPT: "Drop docs",
      MAX_DOC_BYTES: 15 * 1024 * 1024,
      MAX_DOC_TEXT: 20,
      guessUploadMime: () => "text/plain",
    },
    CairnHealthDocs: {
      healthDocHtml: (doc) => `<article class="hdoc" data-hdoc="${String(doc.id)}"></article>`,
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/health-doc-upload-controller.js"), "utf8"), context);
  return { context, document };
}

function appendUploadShell(document) {
  const ids = ["hFile", "hFileName", "hUploadBox", "hText", "hUpload", "hStatus", "hFileLabel", "hlist"];
  const elements = {};
  for (const id of ids) {
    const tag = id === "hText" ? "textarea" : id === "hUpload" ? "button" : "div";
    const element = new FakeElement(tag, { id });
    elements[id] = element;
    document.body.appendChild(element);
  }
  elements.hlist.appendChild(new FakeElement("div", { className: "empty" }));
  return elements;
}

test("health doc upload controller uploads pasted text and inserts the new row", async () => {
  const { context, document } = loadUploadController();
  const shell = appendUploadShell(document);
  const requests = [];
  const polls = [];
  const toasts = [];
  const wired = [];
  let pictureCache = { review: null, docCount: 1, newestDocAt: "2026-06-20T00:00:00Z" };
  let picturePaints = 0;

  context.CairnHealthDocUploadController.wireUpload({
    api: async (path, opts) => {
      requests.push({ path, opts });
      return { id: 42, original_name: "Pasted results", enrichment_status: "pending", created_at: "2026-07-01T12:00:00Z" };
    },
    toast: (message) => toasts.push(message),
    enrichmentActive: (status) => status === "pending",
    pollDoc: (id) => polls.push(id),
    wireDoc: (row) => wired.push(row?.dataset?.hdoc || null),
    getHealthPictureCache: () => pictureCache,
    setHealthPictureCache: (cache) => { pictureCache = cache; return cache; },
    paintHealthPicture: () => { picturePaints += 1; },
  });

  shell.hText.value = "A1c 5.4";
  shell.hText.dispatch("input");
  await shell.hUpload.click();

  assert.deepEqual(JSON.parse(requests[0].opts.body), { original_name: "Pasted results", text: "A1c 5.4" });
  assert.equal(toasts.at(-1), "Uploaded");
  assert.deepEqual(polls, [42]);
  assert.deepEqual(wired, ["42"]);
  assert.equal(shell.hlist.querySelector(".empty"), null);
  assert.equal(pictureCache.docCount, 2);
  assert.equal(pictureCache.newestDocAt, "2026-07-01T12:00:00Z");
  assert.equal(picturePaints, 1);
});

test("health doc upload controller blocks oversized pasted text before upload", async () => {
  const { context, document } = loadUploadController();
  const shell = appendUploadShell(document);
  const requests = [];
  const toasts = [];

  context.CairnHealthDocUploadController.wireUpload({
    api: async (path, opts) => {
      requests.push({ path, opts });
      return {};
    },
    toast: (message) => toasts.push(message),
    enrichmentActive: () => false,
    pollDoc: () => {},
    wireDoc: () => {},
    getHealthPictureCache: () => null,
    setHealthPictureCache: (cache) => cache,
    paintHealthPicture: () => {},
  });

  shell.hText.value = "This text is intentionally too long";
  await shell.hUpload.click();

  assert.equal(requests.length, 0);
  assert.equal(toasts.at(-1), "Text is too long");
});
