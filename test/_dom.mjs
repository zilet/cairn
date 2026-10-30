// Shared DOM test harness for client renderer and controller tests.
//
// The client modules under public/js are plain scripts that publish `Cairn<Name>`
// namespaces onto one global scope, so a test runs a built module in a sandboxed vm
// context and drives it against a small, honest fake DOM:
//
//   import { createDocument, loadClientModule, renderHtml } from "./_dom.mjs";
//
//   const win = loadClientModule(["html-utils", "thing-client"]);
//   const host = renderHtml(win.CairnThing.thingHtml(model), { document: win.document });
//   assert.equal(host.querySelector(".thing-title").textContent, "Bench press");
//
// What it models: an HTML parser behind `innerHTML` (so `querySelector` finds what a
// renderer actually emitted), a selector engine, attributes/dataset/classList/style,
// form values, focus, and events that capture and bubble through the tree to the
// document and the window. What it does not model: layout, CSS, or live collections.
// Anything it cannot answer (an unsupported selector) throws, rather than returning a
// quiet null that would make a test pass for the wrong reason.
//
// One deliberate extension: `el.click()` and `fire(el, type)` return a promise that
// settles once every handler they invoked has settled, so a test can `await` an async
// click handler instead of guessing how many microtasks it needs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);
const RCDATA_TAGS = new Set(["textarea", "title"]);
const BOOLEAN_PROPS = {
  hidden: "hidden",
  disabled: "disabled",
  required: "required",
  open: "open",
  multiple: "multiple",
  readOnly: "readonly",
  autofocus: "autofocus",
  inert: "inert",
};
const STRING_PROPS = {
  id: "id",
  className: "class",
  title: "title",
  href: "href",
  src: "src",
  alt: "alt",
  name: "name",
  placeholder: "placeholder",
  htmlFor: "for",
  role: "role",
  lang: "lang",
  download: "download",
  target: "target",
  rel: "rel",
};
// A start tag closes an open element of these kinds when it lands directly inside one.
const IMPLIED_CLOSE = {
  li: ["li"],
  option: ["option"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
};
const P_CLOSERS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  times: "×",
  divide: "÷",
  minus: "−",
  plusmn: "±",
  le: "≤",
  ge: "≥",
  deg: "°",
  bull: "•",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  hairsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  check: "✓",
  hearts: "♥",
  laquo: "«",
  raquo: "»",
  zwj: "‍",
};

function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;");
const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Events

export class FakeEvent {
  constructor(type, init = {}) {
    const { bubbles = false, cancelable = false, composed = false, ...rest } = init;
    Object.assign(this, rest);
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
    this.composed = composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.isTrusted = false;
    this.timeStamp = Date.now();
    this._stop = false;
    this._stopNow = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
  stopImmediatePropagation() {
    this._stop = true;
    this._stopNow = true;
  }
  composedPath() {
    return this._path ? [...this._path] : [];
  }
}

export class FakeCustomEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail ?? null;
  }
}

function listenerMap(target) {
  if (!target._listeners) Object.defineProperty(target, "_listeners", { value: new Map(), enumerable: false });
  return target._listeners;
}

function addListener(target, type, fn, options) {
  if (!fn) return;
  const capture = typeof options === "boolean" ? options : !!options?.capture;
  const once = typeof options === "object" && !!options?.once;
  const signal = typeof options === "object" ? options?.signal : undefined;
  if (signal?.aborted) return;
  const list = listenerMap(target).get(type) || [];
  if (list.some((l) => l.fn === fn && l.capture === capture)) return;
  const entry = { fn, capture, once };
  list.push(entry);
  listenerMap(target).set(type, list);
  if (signal) signal.addEventListener("abort", () => removeListener(target, type, fn, { capture }), { once: true });
}

function removeListener(target, type, fn, options) {
  const capture = typeof options === "boolean" ? options : !!options?.capture;
  const list = listenerMap(target).get(type);
  if (!list) return;
  const next = list.filter((l) => !(l.fn === fn && l.capture === capture));
  if (next.length) listenerMap(target).set(type, next);
  else listenerMap(target).delete(type);
}

// Count of listeners a target holds (all types, or one) — for teardown assertions.
export function listenerCount(target, type) {
  const map = listenerMap(target);
  if (type) return (map.get(type) || []).length;
  let n = 0;
  for (const list of map.values()) n += list.length;
  return n;
}

function invoke(target, event, phase, results) {
  const list = listenerMap(target).get(event.type);
  if (!list) return;
  event.currentTarget = target;
  for (const entry of [...list]) {
    if (phase === "capture" && !entry.capture) continue;
    if (phase === "bubble" && entry.capture) continue;
    if (entry.once) removeListener(target, event.type, entry.fn, { capture: entry.capture });
    try {
      const out = typeof entry.fn === "function" ? entry.fn.call(target, event) : entry.fn.handleEvent(event);
      results.push(out);
    } catch (err) {
      const rejected = Promise.reject(err);
      rejected._syncError = true;
      results.push(rejected);
    }
    if (event._stopNow) break;
  }
}

function eventPath(target) {
  const pathOut = [target];
  let node = target;
  while (node.parentNode) {
    node = node.parentNode;
    pathOut.push(node);
  }
  if (node.nodeType === 9 && node.defaultView) pathOut.push(node.defaultView);
  return pathOut;
}

function dispatch(target, event) {
  const results = [];
  const pathOut = target.nodeType ? eventPath(target) : [target];
  event.target = target;
  event._path = pathOut;
  for (let i = pathOut.length - 1; i > 0 && !event._stop; i -= 1) {
    event.eventPhase = 1;
    invoke(pathOut[i], event, "capture", results);
  }
  if (!event._stop) {
    event.eventPhase = 2;
    invoke(target, event, "target", results);
  }
  if (event.bubbles) {
    for (let i = 1; i < pathOut.length && !event._stop; i += 1) {
      event.eventPhase = 3;
      invoke(pathOut[i], event, "bubble", results);
    }
  }
  event.eventPhase = 0;
  event.currentTarget = null;
  return results;
}

// A handler failure rejects the returned promise; when nobody awaits it, Node reports
// the unhandled rejection, so a broken handler fails its test loudly either way.
function settled(results, value) {
  return Promise.all(results).then(() => value);
}

// Dispatch for callers that ignore the handlers' results (module code calling
// dispatchEvent, focus/blur): a handler that throws is reported, the way a browser
// reports it, instead of vanishing.
function dispatchReported(target, event) {
  for (const result of dispatch(target, event)) {
    if (result?._syncError) result.catch((err) => console.error(err));
  }
}

const eventTargetMethods = {
  addEventListener(type, fn, options) {
    addListener(this, type, fn, options);
  },
  removeEventListener(type, fn, options) {
    removeListener(this, type, fn, options);
  },
  dispatchEvent(event) {
    dispatchReported(this, event);
    return !event.defaultPrevented;
  },
};

// Give any plain object (a window, a media query list) addEventListener/dispatchEvent.
export function installEventTarget(obj) {
  for (const [name, fn] of Object.entries(eventTargetMethods)) {
    if (typeof obj[name] !== "function") obj[name] = fn;
  }
  return obj;
}

// Dispatch `type` on `target` (bubbling and cancelable by default) and resolve to the
// event once every handler it reached has settled.
export function fire(target, type, init = {}) {
  const event = type instanceof FakeEvent ? type : new FakeEvent(type, { bubbles: true, cancelable: true, ...init });
  return settled(dispatch(target, event), event);
}

// ---------------------------------------------------------------------------
// Nodes

// How a fake node prints. Every node points at its document and its parent, so walking
// a node's own properties walks the whole circular page graph — and node:assert builds a
// failing assertion's message with util.inspect over exactly that (customInspect OFF,
// depth 1000, getters on). One failing `assert.equal(node, null)` once grew a test process
// to 29 GB before it was killed. Two guards:
//  - the links that lead OUT of a node's subtree (ownerDocument, parentNode, a document's
//    defaultView and active element) and the derived views (classList, dataset, style)
//    are non-enumerable own properties: reads and writes are unchanged, but inspect and
//    deepEqual only ever walk the node's own attributes, properties and children;
//  - util.inspect / console.log print one bounded line (`<FakeElement div#id.cls "…">`).
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const DESCRIBE_TEXT_MAX = 40;
function describeText(text) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > DESCRIBE_TEXT_MAX ? `${flat.slice(0, DESCRIBE_TEXT_MAX)}…` : flat;
}
function describeNode(node) {
  const kind = node?.constructor?.name || "FakeNode";
  let label = "";
  if (node.nodeType === 1) {
    const id = node.getAttribute("id");
    const classes = (node.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 4);
    label = `${node.localName}${id ? `#${id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
  } else if (node.nodeType === 9) {
    label = "#document";
  } else if (node.nodeType === 11) {
    label = `#document-fragment (${node.childNodes.length} children)`;
  } else if (node.nodeType === 8) {
    label = "#comment";
  }
  let text = "";
  try {
    text = node.nodeType === 9 ? "" : describeText(node.textContent);
  } catch {}
  return `<${kind}${label ? ` ${label}` : ""}${text ? ` ${JSON.stringify(text)}` : ""}>`;
}

function hidden(obj, values) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(obj, key, { value, writable: true, enumerable: false, configurable: true });
  }
}

export class FakeNode {
  constructor(ownerDocument) {
    hidden(this, { ownerDocument, parentNode: null });
    this.childNodes = [];
  }
  [INSPECT]() {
    return describeNode(this);
  }
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.nodeType === 9;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes.at(-1) || null;
  }
  get nextSibling() {
    const sibs = this.parentNode?.childNodes;
    return sibs ? sibs[sibs.indexOf(this) + 1] || null : null;
  }
  get previousSibling() {
    const sibs = this.parentNode?.childNodes;
    return sibs ? sibs[sibs.indexOf(this) - 1] || null : null;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    return this.children.at(-1) || null;
  }
  hasChildNodes() {
    return this.childNodes.length > 0;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 8 ? "" : n.textContent)).join("");
  }
  set textContent(value) {
    this.replaceChildren();
    const text = String(value ?? "");
    if (text) this.appendChild(this._doc().createTextNode(text));
  }
  _doc() {
    return this.nodeType === 9 ? this : this.ownerDocument;
  }
  _adopt(nodes) {
    const out = [];
    for (const node of nodes) {
      if (node == null) continue;
      if (typeof node === "string") out.push(this._doc().createTextNode(node));
      else if (node.nodeType === 11) {
        const moved = node.childNodes.splice(0);
        for (const n of moved) n.parentNode = null;
        out.push(...moved);
      } else {
        node.parentNode?._detach(node);
        out.push(node);
      }
    }
    return out;
  }
  _detach(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    const doc = this._doc();
    if (doc?._active && node.contains?.(doc._active)) doc._active = null;
  }
  _insert(nodes, index) {
    const adopted = this._adopt(nodes);
    const at = index == null ? this.childNodes.length : index;
    this.childNodes.splice(at, 0, ...adopted);
    for (const n of adopted) n.parentNode = this;
    return adopted;
  }
  appendChild(node) {
    this._insert([node]);
    return node;
  }
  append(...nodes) {
    this._insert(nodes);
  }
  prepend(...nodes) {
    this._insert(nodes, 0);
  }
  insertBefore(node, ref) {
    if (ref == null) return this.appendChild(node);
    if (node === ref) return node;
    node.parentNode?._detach(node);
    this._insert([node], this.childNodes.indexOf(ref));
    return node;
  }
  removeChild(node) {
    this._detach(node);
    return node;
  }
  replaceChild(next, prev) {
    this.insertBefore(next, prev);
    return this.removeChild(prev);
  }
  replaceChildren(...nodes) {
    for (const n of [...this.childNodes]) this._detach(n);
    this._insert(nodes);
  }
  remove() {
    this.parentNode?._detach(this);
  }
  before(...nodes) {
    this.parentNode?._insert(nodes, this.parentNode.childNodes.indexOf(this));
  }
  after(...nodes) {
    this.parentNode?._insert(nodes, this.parentNode.childNodes.indexOf(this) + 1);
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const at = parent.childNodes.indexOf(this);
    parent._detach(this);
    parent._insert(nodes, at);
  }
  querySelector(selector) {
    return selectAll(this, selector, true)[0] || null;
  }
  querySelectorAll(selector) {
    return selectAll(this, selector, false);
  }
  getElementsByClassName(names) {
    return this.querySelectorAll(
      String(names)
        .trim()
        .split(/\s+/)
        .map((n) => `.${n}`)
        .join("")
    );
  }
  getElementsByTagName(tag) {
    return this.querySelectorAll(tag);
  }
}
Object.assign(FakeNode.prototype, eventTargetMethods);
Object.assign(FakeNode, {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_FRAGMENT_NODE: 11,
});

export class FakeText extends FakeNode {
  constructor(ownerDocument, data, raw) {
    super(ownerDocument);
    this.nodeType = 3;
    this.nodeName = "#text";
    this._data = String(data);
    this._raw = raw;
  }
  get data() {
    return this._data;
  }
  set data(value) {
    this._data = String(value);
    this._raw = undefined;
  }
  get nodeValue() {
    return this._data;
  }
  set nodeValue(value) {
    this.data = value;
  }
  get textContent() {
    return this._data;
  }
  set textContent(value) {
    this.data = value;
  }
  get wholeText() {
    return this._data;
  }
  cloneNode() {
    return new FakeText(this.ownerDocument, this._data, this._raw);
  }
  _html(rawText) {
    if (this._raw !== undefined) return this._raw;
    return rawText ? this._data : escapeText(this._data);
  }
}

export class FakeComment extends FakeNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.nodeType = 8;
    this.nodeName = "#comment";
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
  cloneNode() {
    return new FakeComment(this.ownerDocument, this.data);
  }
  _html() {
    return `<!--${this.data}-->`;
  }
}

export class FakeFragment extends FakeNode {
  constructor(ownerDocument) {
    super(ownerDocument);
    this.nodeType = 11;
    this.nodeName = "#document-fragment";
  }
  cloneNode(deep) {
    const copy = new FakeFragment(this.ownerDocument);
    if (deep) copy.append(...this.childNodes.map((n) => n.cloneNode(true)));
    return copy;
  }
}

function makeClassList(el) {
  const read = () => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  const write = (list) => el.setAttribute("class", list.join(" "));
  return {
    get length() {
      return read().length;
    },
    get value() {
      return el.getAttribute("class") || "";
    },
    item: (i) => read()[i] ?? null,
    contains: (c) => read().includes(c),
    add: (...cs) => {
      const list = read();
      for (const c of cs) if (!list.includes(c)) list.push(c);
      write(list);
    },
    remove: (...cs) => {
      if (el.hasAttribute("class")) write(read().filter((c) => !cs.includes(c)));
    },
    toggle(c, force) {
      const has = read().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want && !has) this.add(c);
      if (!want && has) this.remove(c);
      return want;
    },
    replace(a, b) {
      const list = read();
      const i = list.indexOf(a);
      if (i < 0) return false;
      list[i] = b;
      write([...new Set(list)]);
      return true;
    },
    forEach: (fn) => read().forEach(fn),
    toString: () => el.getAttribute("class") || "",
    [Symbol.iterator]: () => read()[Symbol.iterator](),
  };
}

function makeDataset(el) {
  return new Proxy(
    {},
    {
      get: (_, key) =>
        typeof key === "string" ? (el.getAttribute(`data-${camelToKebab(key)}`) ?? undefined) : undefined,
      set: (_, key, value) => {
        el.setAttribute(`data-${camelToKebab(String(key))}`, String(value));
        return true;
      },
      deleteProperty: (_, key) => {
        el.removeAttribute(`data-${camelToKebab(String(key))}`);
        return true;
      },
      has: (_, key) => typeof key === "string" && el.hasAttribute(`data-${camelToKebab(key)}`),
      ownKeys: () => [...el._attrs.keys()].filter((n) => n.startsWith("data-")).map((n) => kebabToCamel(n.slice(5))),
      getOwnPropertyDescriptor: (_, key) =>
        typeof key === "string" && el.hasAttribute(`data-${camelToKebab(key)}`)
          ? {
              value: el.getAttribute(`data-${camelToKebab(key)}`),
              writable: true,
              enumerable: true,
              configurable: true,
            }
          : undefined,
    }
  );
}

function parseStyle(text) {
  const map = new Map();
  for (const decl of String(text || "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (prop) map.set(prop.startsWith("--") ? prop : prop.toLowerCase(), decl.slice(i + 1).trim());
  }
  return map;
}

function makeStyle(el) {
  const read = () => parseStyle(el.getAttribute("style"));
  const write = (map) => {
    const text = [...map].map(([k, v]) => `${k}: ${v};`).join(" ");
    if (text) el.setAttribute("style", text);
    else el.removeAttribute("style");
  };
  const api = {
    setProperty(prop, value) {
      const map = read();
      if (value == null || value === "") map.delete(prop);
      else map.set(prop, String(value));
      write(map);
    },
    removeProperty(prop) {
      const map = read();
      const prev = map.get(prop) ?? "";
      map.delete(prop);
      write(map);
      return prev;
    },
    getPropertyValue: (prop) => read().get(prop) ?? "",
  };
  return new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "cssText") return el.getAttribute("style") || "";
      if (key === "length") return read().size;
      if (typeof key !== "string") return undefined;
      return read().get(camelToKebab(key)) ?? "";
    },
    set(target, key, value) {
      if (key === "cssText") {
        write(parseStyle(value));
        return true;
      }
      target.setProperty(camelToKebab(String(key)), value);
      return true;
    },
  });
}

export class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName, namespaceURI = HTML_NS) {
    super(ownerDocument);
    this.nodeType = 1;
    this.namespaceURI = namespaceURI;
    this.localName = namespaceURI === HTML_NS ? String(tagName).toLowerCase() : String(tagName);
    this._attrs = new Map();
    this._props = {};
    hidden(this, { classList: makeClassList(this), dataset: makeDataset(this), style: makeStyle(this) });
  }
  get tagName() {
    return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName;
  }
  get nodeName() {
    return this.tagName;
  }
  _key(name) {
    return this.namespaceURI === HTML_NS ? String(name).toLowerCase() : String(name);
  }
  get attributes() {
    return [...this._attrs.values()].map(({ name, value }) => ({ name, value }));
  }
  getAttributeNames() {
    return [...this._attrs.keys()];
  }
  getAttribute(name) {
    return this._attrs.get(this._key(name))?.value ?? null;
  }
  hasAttribute(name) {
    return this._attrs.has(this._key(name));
  }
  hasAttributes() {
    return this._attrs.size > 0;
  }
  setAttribute(name, value) {
    this._attrs.set(this._key(name), { name: this._key(name), value: String(value) });
  }
  removeAttribute(name) {
    this._attrs.delete(this._key(name));
  }
  toggleAttribute(name, force) {
    const want = force === undefined ? !this.hasAttribute(name) : !!force;
    if (want && !this.hasAttribute(name)) this.setAttribute(name, "");
    if (!want) this.removeAttribute(name);
    return want;
  }
  get tabIndex() {
    const v = Number.parseInt(this.getAttribute("tabindex") ?? "", 10);
    return Number.isFinite(v) ? v : -1;
  }
  set tabIndex(v) {
    this.setAttribute("tabindex", String(v));
  }
  get type() {
    const t = this.getAttribute("type");
    if (this.localName === "button") return t || "submit";
    if (this.localName === "input") return (t || "text").toLowerCase();
    return t || "";
  }
  set type(v) {
    this.setAttribute("type", v);
  }
  get value() {
    if ("value" in this._props) return this._props.value;
    if (this.localName === "textarea") return this.textContent;
    if (this.localName === "select") return this.options.find((o) => o.selected)?.value ?? "";
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    return (
      this.getAttribute("value") ??
      (this.localName === "input" && (this.type === "checkbox" || this.type === "radio") ? "on" : "")
    );
  }
  set value(v) {
    if (this.localName === "select") {
      for (const o of this.options) o.selected = o.value === String(v);
      return;
    }
    this._props.value = String(v ?? "");
  }
  get defaultValue() {
    return this.getAttribute("value") ?? "";
  }
  get checked() {
    return "checked" in this._props ? this._props.checked : this.hasAttribute("checked");
  }
  set checked(v) {
    this._props.checked = !!v;
    if (v && this.type === "radio" && this.getAttribute("name")) {
      const scope = this.closest("form") || this.ownerDocument;
      for (const other of scope.querySelectorAll(`input[type="radio"][name="${this.getAttribute("name")}"]`)) {
        if (other !== this) other._props.checked = false;
      }
    }
  }
  get selected() {
    if ("selected" in this._props) return this._props.selected;
    if (this.hasAttribute("selected")) return true;
    const select = this.closest("select");
    if (
      !select ||
      select.options.some(
        (o) => o !== this && ("selected" in o._props ? o._props.selected : o.hasAttribute("selected"))
      )
    )
      return false;
    return select.options[0] === this;
  }
  set selected(v) {
    const select = this.closest("select");
    if (v && select && !select.hasAttribute("multiple")) for (const o of select.options) o._props.selected = false;
    this._props.selected = !!v;
  }
  get options() {
    return this.localName === "select" ? this.querySelectorAll("option") : undefined;
  }
  get selectedIndex() {
    return this.options ? this.options.findIndex((o) => o.selected) : -1;
  }
  set selectedIndex(i) {
    this.options?.forEach((o, n) => {
      o.selected = n === i;
    });
  }
  get form() {
    return this.closest("form");
  }
  get innerText() {
    return this.textContent;
  }
  set innerText(v) {
    this.textContent = v;
  }
  get innerHTML() {
    const rawText = RAW_TEXT_TAGS.has(this.localName);
    return this.childNodes.map((n) => n._html(rawText)).join("");
  }
  set innerHTML(html) {
    this.replaceChildren();
    this._insert(parseHtml(String(html ?? ""), this));
  }
  get outerHTML() {
    return this._html();
  }
  set outerHTML(html) {
    const parent = this.parentNode;
    if (!parent) return;
    const at = parent.childNodes.indexOf(this);
    parent._detach(this);
    parent._insert(parseHtml(String(html ?? ""), parent.nodeType === 1 ? parent : this), at);
  }
  insertAdjacentHTML(position, html) {
    const where = String(position).toLowerCase();
    const nodes = parseHtml(
      String(html ?? ""),
      where === "beforebegin" || where === "afterend" ? this.parentNode || this : this
    );
    if (where === "beforebegin") this.before(...nodes);
    else if (where === "afterbegin") this.prepend(...nodes);
    else if (where === "beforeend") this.append(...nodes);
    else if (where === "afterend") this.after(...nodes);
    else throw new Error(`_dom: insertAdjacentHTML position ${position}`);
  }
  insertAdjacentElement(position, el) {
    const where = String(position).toLowerCase();
    if (where === "beforebegin") this.before(el);
    else if (where === "afterbegin") this.prepend(el);
    else if (where === "beforeend") this.append(el);
    else if (where === "afterend") this.after(el);
    return el;
  }
  insertAdjacentText(position, text) {
    this.insertAdjacentElement(position, this.ownerDocument.createTextNode(text));
  }
  _html() {
    const attrs = [...this._attrs.values()]
      .map(({ name, value, raw }) => ` ${raw ?? (value === "" ? name : `${name}="${escapeAttr(value)}"`)}`)
      .join("");
    const tag = this._rawTag || this.localName;
    if (this.namespaceURI === HTML_NS && VOID_TAGS.has(this.localName)) return `<${tag}${attrs}>`;
    if (this._selfClosed && !this.childNodes.length) return `<${tag}${attrs}/>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  matches(selector) {
    return parseSelectorList(selector).some((complex) => matchComplex(this, complex, this));
  }
  closest(selector) {
    const list = parseSelectorList(selector);
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
      if (list.some((complex) => matchComplex(el, complex, el))) return el;
    }
    return null;
  }
  cloneNode(deep) {
    const copy = new FakeElement(this.ownerDocument, this.localName, this.namespaceURI);
    for (const [k, v] of this._attrs) copy._attrs.set(k, { ...v });
    copy._rawTag = this._rawTag;
    copy._selfClosed = this._selfClosed;
    if (deep) copy.append(...this.childNodes.map((n) => n.cloneNode(true)));
    return copy;
  }
  focus() {
    const doc = this.ownerDocument;
    const prev = doc._active;
    if (prev === this) return;
    if (prev && prev !== this) prev.blur();
    doc._active = this;
    dispatchReported(this, new FakeEvent("focus"));
    dispatchReported(this, new FakeEvent("focusin", { bubbles: true }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc._active !== this) return;
    doc._active = null;
    dispatchReported(this, new FakeEvent("blur"));
    dispatchReported(this, new FakeEvent("focusout", { bubbles: true }));
  }
  // Browser semantics, plus a promise over the handlers it ran (see the file header).
  click() {
    if (this.disabled && (this.localName === "button" || this.localName === "input")) return settled([], undefined);
    const results = [];
    const toggles = this.localName === "input" && (this.type === "checkbox" || this.type === "radio");
    const before = this.checked;
    if (toggles) this.checked = this.type === "radio" ? true : !before;
    const event = new FakeEvent("click", { bubbles: true, cancelable: true, button: 0 });
    results.push(...dispatch(this, event));
    if (event.defaultPrevented) {
      if (toggles) this.checked = before;
    } else if (toggles && this.checked !== before) {
      results.push(...dispatch(this, new FakeEvent("input", { bubbles: true })));
      results.push(...dispatch(this, new FakeEvent("change", { bubbles: true })));
    } else if (this.localName === "button" && this.type === "submit" && this.form) {
      results.push(
        ...dispatch(this.form, new FakeEvent("submit", { bubbles: true, cancelable: true, submitter: this }))
      );
    }
    return settled(results, undefined);
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  getClientRects() {
    return [];
  }
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  animate() {
    return { finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null };
  }
}

for (const [prop, attr] of Object.entries(BOOLEAN_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.hasAttribute(attr);
    },
    set(v) {
      this.toggleAttribute(attr, !!v);
    },
    configurable: true,
  });
}
for (const [prop, attr] of Object.entries(STRING_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() {
      return this.getAttribute(attr) ?? "";
    },
    set(v) {
      this.setAttribute(attr, v);
    },
    configurable: true,
  });
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.nodeType = 9;
    this.nodeName = "#document";
    hidden(this, { defaultView: null, _active: null });
    this.readyState = "complete";
    this.visibilityState = "visible";
    this.hidden = false;
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
  }
  get activeElement() {
    return this._active?.isConnected ? this._active : this.body;
  }
  set activeElement(el) {
    this._active = el;
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createElementNS(ns, tag) {
    return new FakeElement(this, tag, ns || HTML_NS);
  }
  createTextNode(text) {
    return new FakeText(this, text);
  }
  createComment(text) {
    return new FakeComment(this, text);
  }
  createDocumentFragment() {
    return new FakeFragment(this);
  }
  createEvent() {
    return new FakeEvent("");
  }
  getElementById(id) {
    return this.querySelector(`#${cssEscape(id)}`);
  }
  get title() {
    return this.head.querySelector("title")?.textContent ?? "";
  }
}

export function createDocument() {
  return new FakeDocument();
}

// ---------------------------------------------------------------------------
// HTML parser (fragment mode, forgiving the way a browser is for well-formed markup)

function parseHtml(html, context) {
  const doc = context.nodeType === 9 ? context : context.ownerDocument;
  const root = new FakeFragment(doc);
  const stack = [root];
  const top = () => stack.at(-1);
  const nsFor = (tag) => {
    if (tag.toLowerCase() === "svg") return SVG_NS;
    const parent = top().nodeType === 1 ? top() : context;
    if (parent?.namespaceURI === SVG_NS && parent.localName !== "foreignObject") return SVG_NS;
    return HTML_NS;
  };
  let i = 0;
  const pushText = (raw, decode = true) => {
    if (raw)
      top().childNodes.push(
        Object.assign(new FakeText(doc, decode ? decodeEntities(raw) : raw, raw), { parentNode: top() })
      );
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    const next = html[lt + 1];
    const isTag =
      /[a-zA-Z]/.test(next || "") ||
      (next === "/" && /[a-zA-Z]/.test(html[lt + 2] || "")) ||
      next === "!" ||
      next === "?";
    if (!isTag) {
      const nextLt = html.indexOf("<", lt + 1);
      const end = nextLt < 0 ? html.length : nextLt;
      pushText(html.slice(i, end));
      i = end;
      continue;
    }
    pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end < 0 ? html.length : end;
      top().childNodes.push(Object.assign(new FakeComment(doc, html.slice(lt + 4, stop)), { parentNode: top() }));
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === "/") {
      const m = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(html.slice(lt));
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      if (!m) continue;
      const name = m[1].toLowerCase();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].localName.toLowerCase() === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    // Start tag.
    const nameMatch = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt));
    const rawTag = nameMatch[1];
    const tag = rawTag.toLowerCase();
    let j = lt + nameMatch[0].length;
    const attrs = [];
    let selfClosed = false;
    while (j < html.length) {
      while (/\s/.test(html[j] || "")) j += 1;
      if (html[j] === ">") {
        j += 1;
        break;
      }
      if (html.startsWith("/>", j)) {
        selfClosed = true;
        j += 2;
        break;
      }
      if (html[j] === "/") {
        j += 1;
        continue;
      }
      const start = j;
      while (j < html.length && !/[\s=>]/.test(html[j]) && !html.startsWith("/>", j)) j += 1;
      const name = html.slice(start, j);
      let value = "";
      let k = j;
      while (/\s/.test(html[k] || "")) k += 1;
      if (html[k] === "=") j = k;
      if (html[j] === "=") {
        j += 1;
        while (/\s/.test(html[j] || "")) j += 1;
        const q = html[j];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, j + 1);
          const stop = close < 0 ? html.length : close;
          value = html.slice(j + 1, stop);
          j = stop + 1;
        } else {
          const vStart = j;
          while (j < html.length && !/[\s>]/.test(html[j])) j += 1;
          value = html.slice(vStart, j);
        }
      }
      if (name) attrs.push({ name, value: decodeEntities(value), raw: html.slice(start, j) });
    }
    const closes = IMPLIED_CLOSE[tag];
    const t = top();
    if (t.nodeType === 1 && ((closes && closes.includes(t.localName)) || (t.localName === "p" && P_CLOSERS.has(tag))))
      stack.pop();
    const ns = nsFor(rawTag);
    const el = new FakeElement(doc, ns === HTML_NS ? tag : rawTag, ns);
    if (rawTag !== el.localName) el._rawTag = rawTag;
    for (const a of attrs) {
      const key = el._key(a.name);
      if (!el._attrs.has(key)) el._attrs.set(key, { name: key, value: a.value, raw: a.raw });
    }
    el.parentNode = top();
    top().childNodes.push(el);
    i = j;
    if (ns === HTML_NS && VOID_TAGS.has(tag)) continue;
    if (selfClosed && ns !== HTML_NS) {
      el._selfClosed = true;
      continue;
    }
    if (ns === HTML_NS && (RAW_TEXT_TAGS.has(tag) || RCDATA_TAGS.has(tag))) {
      const endRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const m = endRe.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      if (body)
        el.childNodes.push(
          Object.assign(new FakeText(doc, RCDATA_TAGS.has(tag) ? decodeEntities(body) : body, body), { parentNode: el })
        );
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    stack.push(el);
  }
  const nodes = root.childNodes.splice(0);
  for (const n of nodes) n.parentNode = null;
  return nodes;
}

// ---------------------------------------------------------------------------
// Selector engine: type, #id, .class, [attr op value i], * and the combinators
// ' ', '>', '+', '~'; pseudo-classes :not/:is/:where, :first-child, :last-child,
// :only-child, :nth-child(an+b|odd|even), :checked, :disabled, :enabled, :empty, :scope.

function cssEscape(value) {
  return String(value).replace(/([^\w-])/g, "\\$1");
}

const selectorCache = new Map();

function parseSelectorList(input) {
  const source = String(input);
  const cached = selectorCache.get(source);
  if (cached) return cached;
  let i = 0;
  const s = source;
  const fail = (why) => {
    throw new Error(`_dom: unsupported selector ${JSON.stringify(source)} (${why})`);
  };
  const ident = () => {
    let out = "";
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        out += s[i + 1] ?? "";
        i += 2;
      } else if (/[\w\- -￿]/.test(c)) {
        out += c;
        i += 1;
      } else break;
    }
    return out;
  };
  const skipWs = () => {
    while (/\s/.test(s[i] || "")) i += 1;
  };
  const parenArg = () => {
    let depth = 1;
    const start = i;
    while (i < s.length && depth) {
      if (s[i] === "(") depth += 1;
      else if (s[i] === ")") depth -= 1;
      i += 1;
    }
    if (depth) fail("unclosed (");
    return s.slice(start, i - 1);
  };
  const compound = () => {
    const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
    let any = false;
    if (s[i] === "*") {
      i += 1;
      any = true;
    } else if (/[a-zA-Z]/.test(s[i] || "")) {
      c.tag = ident();
      any = true;
    }
    for (;;) {
      const ch = s[i];
      if (ch === "#") {
        i += 1;
        c.ids.push(ident());
      } else if (ch === ".") {
        i += 1;
        c.classes.push(ident());
      } else if (ch === "[") {
        i += 1;
        skipWs();
        const name = ident();
        skipWs();
        let op = null;
        let value = null;
        let insensitive = false;
        const m = /^([~|^$*]?=)/.exec(s.slice(i));
        if (m) {
          op = m[1];
          i += op.length;
          skipWs();
          const q = s[i];
          if (q === '"' || q === "'") {
            const close = s.indexOf(q, i + 1);
            if (close < 0) fail("unclosed quote");
            value = s.slice(i + 1, close).replace(/\\(.)/g, "$1");
            i = close + 1;
          } else value = ident();
          skipWs();
          if (/[iI]/.test(s[i] || "") && /[\s\]]/.test(s[i + 1] || "")) {
            insensitive = true;
            i += 1;
            skipWs();
          }
        }
        if (s[i] !== "]") fail("expected ]");
        i += 1;
        c.attrs.push({ name, op, value, insensitive });
      } else if (ch === ":") {
        i += 1;
        if (s[i] === ":") fail("pseudo-elements");
        const name = ident().toLowerCase();
        let arg = null;
        if (s[i] === "(") {
          i += 1;
          arg = parenArg();
        }
        if (["not", "is", "where"].includes(name))
          c.pseudos.push({ name, list: parseSelectorList(arg ?? fail("missing argument")) });
        else if (name === "nth-child") c.pseudos.push({ name, nth: parseNth(arg ?? fail("missing argument"), fail) });
        else if (
          ["first-child", "last-child", "only-child", "checked", "disabled", "enabled", "empty", "scope"].includes(name)
        )
          c.pseudos.push({ name });
        else fail(`:${name}`);
      } else break;
      any = true;
    }
    if (!any) fail(`unexpected ${JSON.stringify(s[i] ?? "end")}`);
    return c;
  };
  const list = [];
  let complex = [];
  let combinator = null;
  skipWs();
  while (i < s.length) {
    complex.push({ combinator, compound: compound() });
    combinator = null;
    const before = i;
    skipWs();
    const ch = s[i];
    if (ch === ",") {
      i += 1;
      skipWs();
      list.push(complex);
      complex = [];
      combinator = null;
    } else if (ch === ">" || ch === "+" || ch === "~") {
      i += 1;
      skipWs();
      combinator = ch;
    } else if (i < s.length) {
      if (i === before) fail(`unexpected ${JSON.stringify(ch)}`);
      combinator = " ";
    }
  }
  if (complex.length) list.push(complex);
  if (!list.length || combinator) fail("empty");
  selectorCache.set(source, list);
  return list;
}

function parseNth(arg, fail) {
  const t = arg.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "odd") return { a: 2, b: 1 };
  if (t === "even") return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (m) return { a: m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]), b: Number(m[2] || 0) };
  if (/^[+-]?\d+$/.test(t)) return { a: 0, b: Number(t) };
  return fail(`:nth-child(${arg})`);
}

function matchAttr(el, { name, op, value, insensitive }) {
  const actualRaw = el.getAttribute(name);
  if (actualRaw == null) return false;
  if (!op) return true;
  const actual = insensitive ? actualRaw.toLowerCase() : actualRaw;
  const want = insensitive ? value.toLowerCase() : value;
  switch (op) {
    case "=":
      return actual === want;
    case "~=":
      return actual.split(/\s+/).includes(want);
    case "|=":
      return actual === want || actual.startsWith(`${want}-`);
    case "^=":
      return want !== "" && actual.startsWith(want);
    case "$=":
      return want !== "" && actual.endsWith(want);
    case "*=":
      return want !== "" && actual.includes(want);
    default:
      return false;
  }
}

function matchCompound(el, c, scope) {
  if (el.nodeType !== 1) return false;
  if (c.tag && (el.namespaceURI === HTML_NS ? el.localName !== c.tag.toLowerCase() : el.localName !== c.tag))
    return false;
  for (const id of c.ids) if (el.getAttribute("id") !== id) return false;
  if (c.classes.length) {
    const cls = (el.getAttribute("class") || "").split(/\s+/);
    for (const k of c.classes) if (!cls.includes(k)) return false;
  }
  for (const a of c.attrs) if (!matchAttr(el, a)) return false;
  for (const p of c.pseudos) {
    const sibs = el.parentNode ? el.parentNode.children : [el];
    const idx = sibs.indexOf(el);
    switch (p.name) {
      case "not":
        if (p.list.some((cx) => matchComplex(el, cx, scope))) return false;
        break;
      case "is":
      case "where":
        if (!p.list.some((cx) => matchComplex(el, cx, scope))) return false;
        break;
      case "first-child":
        if (idx !== 0) return false;
        break;
      case "last-child":
        if (idx !== sibs.length - 1) return false;
        break;
      case "only-child":
        if (sibs.length !== 1) return false;
        break;
      case "nth-child": {
        const pos = idx + 1;
        const { a, b } = p.nth;
        if (a === 0 ? pos !== b : (pos - b) / a < 0 || (pos - b) % a !== 0) return false;
        break;
      }
      case "checked":
        if (!(el.localName === "option" ? el.selected : el.localName === "input" && el.checked)) return false;
        break;
      case "disabled":
        if (!el.hasAttribute("disabled")) return false;
        break;
      case "enabled":
        if (el.hasAttribute("disabled") || !["button", "input", "select", "textarea", "option"].includes(el.localName))
          return false;
        break;
      case "empty":
        if (el.childNodes.some((n) => n.nodeType === 1 || (n.nodeType === 3 && n.data))) return false;
        break;
      case "scope":
        if (el !== scope) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function matchComplex(el, complex, scope, index = complex.length - 1) {
  const { combinator, compound } = complex[index];
  if (!matchCompound(el, compound, scope)) return false;
  if (index === 0) return true;
  const prev = index - 1;
  if (combinator === ">") return !!el.parentElement && matchComplex(el.parentElement, complex, scope, prev);
  if (combinator === " ") {
    for (let p = el.parentElement; p; p = p.parentElement) if (matchComplex(p, complex, scope, prev)) return true;
    return false;
  }
  const sibs = el.parentNode ? el.parentNode.children : [el];
  const idx = sibs.indexOf(el);
  if (combinator === "+") return idx > 0 && matchComplex(sibs[idx - 1], complex, scope, prev);
  for (let k = idx - 1; k >= 0; k -= 1) if (matchComplex(sibs[k], complex, scope, prev)) return true;
  return false;
}

function selectAll(root, selector, firstOnly) {
  const list = parseSelectorList(selector);
  const scope = root.nodeType === 1 ? root : null;
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (list.some((complex) => matchComplex(child, complex, scope))) {
        out.push(child);
        if (firstOnly) return true;
      }
      if (walk(child)) return true;
    }
    return false;
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Rendering, storage, timers, and the module loader

// Parse `html` into a fresh host element attached to `document.body` (so `isConnected`
// is true, as it would be on a real screen) and return the host.
export function renderHtml(html, { document = createDocument(), tag = "div", id } = {}) {
  const host = document.createElement(tag);
  if (id) host.id = id;
  document.body.appendChild(host);
  host.innerHTML = html;
  return host;
}

// An element attached to `document.body`, for a controller to mount into.
export function createHost(document, { tag = "div", id, html = "" } = {}) {
  return renderHtml(html, { document, tag, id });
}

export function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => {
      map.set(String(k), String(v));
    },
    removeItem: (k) => {
      map.delete(String(k));
    },
    clear: () => map.clear(),
    _map: map,
  };
}

// Manual timers: nothing runs until the test says so.
export function createFakeTimers() {
  let seq = 0;
  let now = 0;
  const queue = new Map();
  const add = (fn, delay, repeat, kind) => {
    seq += 1;
    queue.set(seq, { fn, at: now + Math.max(0, Number(delay) || 0), delay: Number(delay) || 0, repeat, kind });
    return seq;
  };
  const timers = {
    setTimeout: (fn, delay = 0, ...args) => add(() => fn(...args), delay, false, "timeout"),
    clearTimeout: (id) => queue.delete(id),
    setInterval: (fn, delay = 0, ...args) => add(() => fn(...args), delay, true, "interval"),
    clearInterval: (id) => queue.delete(id),
    requestAnimationFrame: (fn) => add(() => fn(now), 16, false, "raf"),
    cancelAnimationFrame: (id) => queue.delete(id),
    get pending() {
      return queue.size;
    },
    // Advance the clock by `ms`, running every timer that falls due, in order.
    tick(ms = 0) {
      const until = now + ms;
      for (;;) {
        const due = [...queue].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.repeat) t.at = now + Math.max(1, t.delay);
        else queue.delete(id);
        t.fn();
      }
      now = until;
    },
    // Run whatever is queued now (not timers those callbacks add), ignoring delays.
    runPending() {
      const ids = [...queue.keys()];
      for (const id of ids) {
        const t = queue.get(id);
        if (!t) continue;
        if (!t.repeat) queue.delete(id);
        t.fn();
      }
    },
    now: () => now,
  };
  return timers;
}

// Resolves after every microtask queued so far (and the ones they queue) has run.
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const tagClass = (name, test) => {
  const cls = class {};
  Object.defineProperty(cls, "name", { value: name });
  Object.defineProperty(cls, Symbol.hasInstance, { value: test });
  return cls;
};
const isEl = (x) => x instanceof FakeElement;
const isHtml = (x) => isEl(x) && x.namespaceURI === HTML_NS;
const htmlTag = (name, tag) => tagClass(name, (x) => isHtml(x) && x.localName === tag);

const DOM_GLOBALS = {
  Node: FakeNode,
  Element: FakeElement,
  Text: FakeText,
  DocumentFragment: FakeFragment,
  Document: FakeDocument,
  HTMLElement: tagClass("HTMLElement", isHtml),
  SVGElement: tagClass("SVGElement", (x) => isEl(x) && x.namespaceURI === SVG_NS),
  HTMLButtonElement: htmlTag("HTMLButtonElement", "button"),
  HTMLInputElement: htmlTag("HTMLInputElement", "input"),
  HTMLTextAreaElement: htmlTag("HTMLTextAreaElement", "textarea"),
  HTMLSelectElement: htmlTag("HTMLSelectElement", "select"),
  HTMLOptionElement: htmlTag("HTMLOptionElement", "option"),
  HTMLFormElement: htmlTag("HTMLFormElement", "form"),
  HTMLImageElement: htmlTag("HTMLImageElement", "img"),
  HTMLAnchorElement: htmlTag("HTMLAnchorElement", "a"),
  HTMLDetailsElement: htmlTag("HTMLDetailsElement", "details"),
  HTMLDialogElement: htmlTag("HTMLDialogElement", "dialog"),
  HTMLLabelElement: htmlTag("HTMLLabelElement", "label"),
  Event: FakeEvent,
  CustomEvent: FakeCustomEvent,
  MouseEvent: FakeEvent,
  KeyboardEvent: FakeEvent,
  FocusEvent: FakeEvent,
  InputEvent: FakeEvent,
  PointerEvent: FakeEvent,
};

// The host's builtins, passed into the sandbox so values a test builds (arrays, maps,
// promises) and values the module builds through these constructors share one realm.
const HOST_GLOBALS = {
  Object,
  Array,
  JSON,
  Math,
  Date,
  Number,
  String,
  Boolean,
  RegExp,
  Symbol,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Promise,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  Intl,
  Proxy,
  Reflect,
  ArrayBuffer,
  Uint8Array,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  console,
  queueMicrotask,
  structuredClone,
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  TextEncoder,
  TextDecoder,
  Blob,
};

export function clientModulePath(name) {
  const file = name.endsWith(".js") ? name : `${name}.js`;
  return file.includes("/") ? path.resolve(ROOT, file) : path.join(ROOT, "public/js", file);
}

// Run one or more built client modules (public/js/<name>.js, in the order given) in a
// fresh sandbox and return its global object — the fake `window`. The sandbox holds the
// host builtins, a fake `document` (pass your own to share one), in-memory
// localStorage/sessionStorage, the DOM constructors/events above, and window-level
// addEventListener/dispatchEvent. Timers are NOT provided: pass `createFakeTimers()`
// (or the host's) through `globals` when a module needs them, so nothing fires behind
// a test's back. `globals` wins over every default.
export function loadClientModule(names, { globals = {}, document = createDocument() } = {}) {
  const context = {
    ...HOST_GLOBALS,
    ...DOM_GLOBALS,
    document,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    ...globals,
  };
  context.window = context;
  context.globalThis = context;
  context.self = context;
  installEventTarget(context);
  if (context.document && context.document.nodeType === 9 && !context.document.defaultView)
    context.document.defaultView = context;
  vm.createContext(context);
  for (const name of Array.isArray(names) ? names : [names]) {
    const file = clientModulePath(name);
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: path.relative(ROOT, file) });
  }
  return context;
}
