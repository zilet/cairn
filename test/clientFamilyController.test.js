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
    this.sync();
  }

  remove(name) {
    this.classes.delete(name);
    this.sync();
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    if (force === true) this.classes.add(name);
    else if (force === false) this.classes.delete(name);
    else if (this.classes.has(name)) this.classes.delete(name);
    else this.classes.add(name);
    this.sync();
  }

  sync() {
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
    this.disabled = false;
    this.focusCount = 0;
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

  focus() {
    this.focusCount += 1;
  }

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
    if (selector.startsWith(".")) return String(this.className || "").split(/\s+/).includes(selector.slice(1));
    if (selector === "[data-fedit]") return Object.hasOwn(this.dataset, "fedit");
    if (selector === "[data-fdel]") return Object.hasOwn(this.dataset, "fdel");
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
    if (html.includes("famadd")) {
      this.appendChild(new FakeElement("button", { id: "famToLife" }));
      const form = new FakeElement("div", { className: "lifeadd famadd" });
      for (const id of ["fName", "fRel", "fBirth", "fNotes", "fAllergy", "fDiet"]) form.appendChild(new FakeElement("input", { id }));
      for (const color of familyColors()) form.appendChild(new FakeElement("button", { className: "fam-swatch", dataset: { color } }));
      form.appendChild(new FakeElement("button", { id: "fAdd" }));
      form.appendChild(new FakeElement("div", { id: "fStatus" }));
      this.appendChild(form);
      this.appendChild(new FakeElement("div", { id: "flist" }));
      return;
    }
    if (this.classList.contains("fam-edit") || html.includes("fe-name")) {
      addEditControls(this, html);
      return;
    }
    if (html.includes("fam-card")) {
      for (const card of parseCards(html)) this.appendChild(card);
      return;
    }
    if (this.classList.contains("fam-card") && (html.includes("data-fedit") || html.includes("data-fdel"))) {
      addCardControls(this, html);
      return;
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

function familyColors() {
  return ["#b4552d", "#6e7f5c", "#c9a86a", "#8e4f6d", "#57503f", "#7d8f5e"];
}

function addCardControls(card, html) {
  const editId = /data-fedit="([^"]*)"/.exec(html)?.[1] || card.dataset.fam || "";
  const delId = /data-fdel="([^"]*)"/.exec(html)?.[1] || card.dataset.fam || "";
  card.appendChild(new FakeElement("button", { dataset: { fedit: editId } }));
  card.appendChild(new FakeElement("button", { dataset: { fdel: delId } }));
}

function addEditControls(box, html) {
  const fields = [
    ["fe-name", /class="fe-name[^"]*"[^>]*value="([^"]*)"/],
    ["fe-rel", /class="fe-rel[^"]*"[^>]*value="([^"]*)"/],
    ["fe-birth", /class="fe-birth[^"]*"[^>]*value="([^"]*)"/],
    ["fe-notes", /class="fe-notes[^"]*"[^>]*value="([^"]*)"/],
    ["fe-allergy", /class="fe-allergy[^"]*"[^>]*value="([^"]*)"/],
    ["fe-diet", /class="fe-diet[^"]*"[^>]*value="([^"]*)"/],
  ];
  for (const [className, pattern] of fields) box.appendChild(new FakeElement("input", { className, value: pattern.exec(html)?.[1] || "" }));
  for (const color of familyColors()) box.appendChild(new FakeElement("button", { className: "fam-swatch", dataset: { color } }));
  box.appendChild(new FakeElement("button", { className: "fe-save" }));
  box.appendChild(new FakeElement("button", { className: "fe-cancel" }));
}

function parseCards(html) {
  const cards = [];
  for (const match of String(html || "").matchAll(/<div class="sess fam-card[^"]*" data-fam="([^"]*)"[^>]*>([\s\S]*?)<\/div>(?=<div class="sess fam-card|$)/g)) {
    const card = new FakeElement("div", { className: "sess fam-card", dataset: { fam: match[1] } });
    card._innerHTML = match[2];
    addCardControls(card, match[2]);
    cards.push(card);
  }
  return cards;
}

function loadFamilyController() {
  const document = new FakeDocument();
  const context = {
    Array,
    Date,
    JSON,
    Number,
    Object,
    Promise,
    String,
    document,
    HTMLElement: FakeElement,
    Element: FakeElement,
    stagger: (index) => `--i:${index}`,
    window: null,
    globalThis: null,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/family-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/family-controller.js"), "utf8"), context);
  return { context, document };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(initialPeople = []) {
  const { context, document } = loadFamilyController();
  const view = new FakeElement("main");
  const headerTitle = new FakeElement("h1");
  document.body.appendChild(view);
  let people = initialPeople.map((person) => ({ ...person }));
  const requests = [];
  const toasts = [];
  const deps = {
    view,
    headerTitle,
    state: { tab: "me", meSeg: "family" },
    segments: Object.freeze([{ key: "life", label: "Life" }, { key: "family", label: "Family" }]),
    handlers: { family: () => {} },
    api: async (path, opts) => {
      requests.push({ path, opts });
      if (path === "/family" && !opts) return people;
      if (path === "/family" && opts?.method === "POST") {
        const body = JSON.parse(opts.body);
        people.push({ id: people.length + 1, ...body });
        return { id: people.length, ...body };
      }
      const putMatch = /^\/family\/(.+)$/.exec(path);
      if (putMatch && opts?.method === "PUT") {
        const body = JSON.parse(opts.body);
        people = people.map((person) => String(person.id) === putMatch[1] ? { ...person, ...body } : person);
        return {};
      }
      if (putMatch && opts?.method === "DELETE") {
        people = people.filter((person) => String(person.id) !== putMatch[1]);
        return {};
      }
      return {};
    },
    armDelete: (_btn, action) => action(),
    escapeAttr: (value) => String(value ?? "").replaceAll('"', "&quot;"),
    invalidatePoll: () => { deps.invalidatePollCount += 1; },
    invalidatePollCount: 0,
    localISO: () => "2026-07-01",
    segBar: () => `<nav data-segbar="1"></nav>`,
    toast: (message) => toasts.push(message),
    viewEnter: () => { deps.viewEnterCount += 1; },
    viewEnterCount: 0,
    wireSeg: () => { deps.wireSegCount += 1; },
    wireSegCount: 0,
    withViewTransition: (fn) => fn(),
    renderLife: async () => { deps.renderLifeCount += 1; },
    renderLifeCount: 0,
  };
  const swr = new Map();
  context.peekCached = (key) => swr.has(key) ? { data: swr.get(key), fresh: true } : null;
  context.swrSet = (key, data) => swr.set(key, data);
  context.cachedApi = async (path, options = {}) => {
    const data = await deps.api(path);
    if (options.key) swr.set(options.key, data);
    if (options.onUpgrade) options.onUpgrade(data, { changed: true });
    return data;
  };
  context.optimisticMutation = async (options) => {
    const previous = swr.has(options.key) ? swr.get(options.key) : null;
    const optimistic = options.apply(previous);
    swr.set(options.key, optimistic);
    if (options.onChange) options.onChange(optimistic, { phase: "optimistic" });
    try {
      const result = await options.request();
      const committed = options.commit ? options.commit(optimistic, result) : undefined;
      if (committed !== undefined && committed !== null) {
        swr.set(options.key, committed);
        if (options.onChange) options.onChange(committed, { phase: "commit" });
      }
      return result;
    } catch (error) {
      if (previous === null) swr.delete(options.key);
      else {
        swr.set(options.key, previous);
        if (options.onChange) options.onChange(previous, { phase: "rollback" });
      }
      throw error;
    }
  };
  return { context, document, deps, requests, toasts, get people() { return people; } };
}

test("family controller renders the family route and hydrates people by id", async () => {
  const h = harness([{ id: 7, name: "Mara", relationship: "daughter", color: "#6e7f5c" }]);

  await h.context.CairnFamilyController.render(h.deps);
  await tick();

  assert.equal(h.deps.headerTitle.textContent, "Family");
  assert.equal(h.deps.state.meSeg, "family");
  assert.equal(h.deps.invalidatePollCount, 1);
  assert.equal(h.deps.wireSegCount, 1);
  assert.equal(h.requests[0].path, "/family");
  assert.ok(h.deps.view.querySelector("#fAdd"));
  assert.equal(h.deps.view.querySelector("#flist").querySelector(".fam-card").dataset.fam, "7");
  assert.deepEqual(Object.keys(h.deps.state._famById), ["7"]);
});

test("family controller validates and posts new family members", async () => {
  const h = harness();
  await h.context.CairnFamilyController.render(h.deps);
  await tick();

  await h.deps.view.querySelector("#fAdd").click();
  assert.equal(h.deps.view.querySelector("#fStatus").textContent, "Add a name first.");
  assert.equal(h.deps.view.querySelector("#fName").focusCount, 1);
  assert.equal(h.requests.filter((request) => request.opts?.method === "POST").length, 0);

  h.deps.view.querySelector("#fName").value = "Mara";
  h.deps.view.querySelector("#fRel").value = "daughter";
  h.deps.view.querySelector("#fNotes").value = "soccer";
  h.deps.view.querySelectorAll(".famadd .fam-swatch")[1].click();
  await h.deps.view.querySelector("#fAdd").click();
  await tick();

  const post = h.requests.find((request) => request.path === "/family" && request.opts?.method === "POST");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.opts.body), {
    name: "Mara",
    relationship: "daughter",
    birthdate: null,
    color: "#6e7f5c",
    notes: "soccer",
    allergies: null,
    dietary_restrictions: null,
  });
  assert.equal(h.toasts.at(-1), "Added");
  assert.equal(h.deps.view.querySelector("#fName").value, "");
  assert.equal(h.deps.view.querySelector("#flist").querySelector(".fam-card").dataset.fam, "1");
});

test("family optimistic pending rows do not expose committed edit controls", () => {
  const h = harness();
  const html = h.context.CairnFamily.familyCardHtml({ id: -123, name: "Mara" });

  assert.match(html, /fam-name-pending/);
  assert.doesNotMatch(html, /class="fam-name"/);
  assert.doesNotMatch(html, /data-fedit/);
  assert.doesNotMatch(html, /data-fdel/);
  assert.match(html, /Saving/);
});

test("family controller edits and deletes existing family members", async () => {
  const h = harness([{ id: 7, name: "Mara", relationship: "daughter", color: "#b4552d" }]);
  await h.context.CairnFamilyController.render(h.deps);
  await tick();

  const card = h.deps.view.querySelector("#flist").querySelector(".fam-card");
  h.context.CairnFamilyController.startEdit(card, h.deps);
  const edit = card.querySelector(".fam-edit");
  assert.ok(edit);
  assert.equal(edit.querySelector(".fe-name").focusCount, 1);
  edit.querySelector(".fe-name").value = "Mara Z";
  edit.querySelector(".fe-rel").value = "daughter";
  edit.querySelector(".fe-notes").value = "weekend training";
  edit.querySelectorAll(".fam-swatch")[2].click();

  await edit.querySelector(".fe-save").click();
  await tick();

  const put = h.requests.find((request) => request.path === "/family/7" && request.opts?.method === "PUT");
  assert.ok(put);
  assert.deepEqual(JSON.parse(put.opts.body), {
    name: "Mara Z",
    relationship: "daughter",
    birthdate: null,
    color: "#c9a86a",
    notes: "weekend training",
    allergies: null,
    dietary_restrictions: null,
  });
  assert.equal(h.toasts.at(-1), "Updated");

  const refreshedCard = h.deps.view.querySelector("#flist").querySelector(".fam-card");
  h.context.CairnFamilyController.startDelete(refreshedCard.querySelector("[data-fdel]"), h.deps);
  await tick();

  const del = h.requests.find((request) => request.path === "/family/7" && request.opts?.method === "DELETE");
  assert.ok(del);
  assert.equal(h.toasts.at(-1), "Removed");
  assert.deepEqual(h.people, []);
});

test("family delete waits for a deferred edit commit so the member cannot be restored", async () => {
  const h = harness([{ id: 7, name: "Mara", relationship: "daughter", color: "#b4552d" }]);
  await h.context.CairnFamilyController.render(h.deps);
  await tick();

  const originalApi = h.deps.api;
  let releaseEdit;
  const editResponse = new Promise((resolve) => { releaseEdit = resolve; });
  h.deps.api = async (path, opts) => {
    const result = await originalApi(path, opts);
    if (path === "/family/7" && opts?.method === "PUT") await editResponse;
    return result;
  };

  const card = h.deps.view.querySelector("#flist").querySelector(".fam-card");
  h.context.CairnFamilyController.startEdit(card, h.deps);
  const edit = card.querySelector(".fam-edit");
  edit.querySelector(".fe-notes").value = "server saved, client commit deferred";
  const savePromise = edit.querySelector(".fe-save").click();
  await tick();

  const editedCard = h.deps.view.querySelector("#flist").querySelector(".fam-card");
  const deleteButton = editedCard.querySelector("[data-fdel]");
  h.context.CairnFamilyController.startDelete(deleteButton, h.deps);
  h.context.CairnFamilyController.startDelete(deleteButton, h.deps);
  await tick();
  assert.equal(
    h.requests.filter((request) => request.path === "/family/7" && request.opts?.method === "DELETE").length,
    0,
    "delete is serialized behind the active edit instead of racing its late commit",
  );

  releaseEdit();
  await savePromise;
  await tick();
  await tick();

  assert.equal(
    h.requests.filter((request) => request.path === "/family/7" && request.opts?.method === "DELETE").length,
    1,
    "duplicate confirmations collapse into one delete request",
  );
  assert.deepEqual(h.people, []);
  assert.equal(h.deps.view.querySelector("#flist").querySelector(".fam-card"), null);
  assert.equal(h.toasts.at(-1), "Removed");
});
