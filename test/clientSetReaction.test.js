// The session card answering a logged set: the server's one reaction line lands in
// place under the card's logged sets, as text, replacing the last one — and a set
// still waiting in the outbox shows none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const root = join(import.meta.dirname, "..");

function parseSelector(sel) {
  const m = sel.match(/^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
  if (!m) throw new Error(`fake DOM cannot match ${sel}`);
  return { tag: m[1] || null, cls: m[2] || null, attr: m[3] || null, value: m[4] ?? null };
}

const camel = (attr) => attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class El {
  constructor(tag = "div", className = "") {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.parentElement = null;
    this.isConnected = false;
    this.listeners = {};
    this.textContent = "";
    this.disabled = false;
    const self = this;
    this.classList = {
      add: (c) => {
        if (!self.classList.contains(c)) self.className = `${self.className} ${c}`.trim();
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => {
        const want = on ?? !self.classList.contains(c);
        if (want) self.classList.add(c);
        else
          self.className = self.className
            .split(/\s+/)
            .filter((x) => x !== c)
            .join(" ");
      },
    };
  }
  set innerHTML(_value) {
    this.innerHTMLWrites = (this.innerHTMLWrites || 0) + 1;
  }
  matchesOne(sel) {
    const { tag, cls, attr, value } = parseSelector(sel);
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (cls && !this.classList.contains(cls)) return false;
    if (attr) {
      const v = this.dataset[camel(attr)];
      if (v == null) return false;
      if (value != null && String(v) !== value) return false;
    }
    return true;
  }
  matches(sel) {
    const parts = sel.trim().split(/\s+/);
    if (!this.matchesOne(parts.pop())) return false;
    let node = this.parentElement;
    while (parts.length && node) {
      if (node.matchesOne(parts[parts.length - 1])) parts.pop();
      node = node.parentElement;
    }
    return parts.length === 0;
  }
  get nextSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      node.isConnected = this.isConnected;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  insertBefore(node, anchor) {
    node.parentElement = this;
    node.isConnected = this.isConnected;
    const index = anchor ? this.children.indexOf(anchor) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.matches(sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches(sel)) return node;
      node = node.parentElement;
    }
    return null;
  }
  contains(node) {
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name.startsWith("data-")) delete this.dataset[camel(name)];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
}

function harness() {
  const document = {
    activeElement: null,
    createElement(tag) {
      const el = new El(tag);
      if (tag === "template") el.content = { firstElementChild: new El("div", "chip") };
      return el;
    },
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => null,
  };
  const context = { document, setTimeout, clearTimeout, console, HTMLElement: El, Event: class {} };
  context.window = context;
  context.globalThis = context;
  context.CairnSessionEntry = {
    tapWithoutBlur(button, act) {
      button.tap = act;
    },
  };
  for (const file of [
    "public/js/today-session-set-model.js",
    "public/js/today-session-set-reaction-client.js",
    "public/js/today-session-set-actions.js",
  ]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
  return { context, document };
}

// One exercise card on a live surface: header, the logged chips, the log row.
function surface() {
  const view = new El("div", "view");
  view.isConnected = true;
  const card = new El("div", "ex");
  card.dataset.card = "Barbell Bench Press";
  const logged = new El("div", "logged");
  logged.dataset.logged = "";
  const row = new El("div", "logrow");
  row.dataset.ex = encodeURIComponent("Barbell Bench Press");
  const button = new El("button", "logbtn");
  row.append(button);
  const stat = new El("div");
  stat.dataset.finishstat = "";
  view.append(card, stat);
  card.append(logged, row);
  return { view, card, logged, row, button };
}

function depsFor(view, toasts) {
  return {
    root: view,
    state: { logDate: "2026-11-16", tab: "today", sessionIdsByDate: {} },
    toast: (text) => toasts.push(text),
    startRest() {},
    stopRest() {},
    scheduleRxRefresh() {},
    invalidate() {},
    invalidateTodayProgression() {},
    localISO: () => "2026-11-16",
    api: async () => ({}),
    withViewTransition: (fn) => fn(),
    renderToday() {},
    viewEnter() {},
    fmtDur: (s) => `${s}s`,
    sessionStatus: { setChipHtml: () => "<div class='chip'></div>" },
  };
}

function reactionLines(card) {
  return card.querySelectorAll("[data-set-reaction]");
}

test("the reaction is one text line right under the logged sets, and a newer one replaces it", () => {
  const { context } = harness();
  const model = context.CairnTodaySetNotes;
  const { card, logged, row } = surface();
  model.showSetReaction(card, {
    id: 7,
    reaction: { code: "top_of_range", line: "8 at 140 with reps in hand reaches the top of the range." },
  });
  let lines = reactionLines(card);
  assert.equal(lines.length, 1);
  assert.equal(card.children[1], lines[0], "placed after the logged chips, before the log row");
  assert.equal(card.children[0], logged);
  assert.equal(card.children[2], row);
  assert.equal(lines[0].className, "ex-reaction");
  assert.equal(lines[0].dataset.setReaction, "top_of_range");

  model.showSetReaction(card, { id: 8, reaction: { code: "above_card", line: "<b>145</b> for 6" } });
  lines = reactionLines(card);
  assert.equal(lines.length, 1, "one line in place, never a stack");
  assert.equal(lines[0].textContent, "<b>145</b> for 6", "server prose is painted as text, never parsed as markup");
  assert.equal(lines[0].innerHTMLWrites, undefined);
});

test("a set with no reaction leaves the card exactly as it was", () => {
  const { context } = harness();
  const model = context.CairnTodaySetNotes;
  const { card } = surface();
  model.showSetReaction(card, { id: 7 });
  model.showSetReaction(card, { id: 7, reaction: { code: "x", line: "   " } });
  model.showSetReaction(card, { id: 7, reaction: null });
  assert.equal(reactionLines(card).length, 0);
  assert.equal(
    model.setReactionLine({ reaction: { line: "Every set the card asked for is in." } }),
    "Every set the card asked for is in."
  );
  assert.equal(model.setReactionLine({}), null);
});

async function logOnce(mutation) {
  const { context } = harness();
  const { view, card, row, button } = surface();
  const toasts = [];
  context.CairnTodaySessionSetModel.logPayloadFromRow = () => ({
    ok: true,
    body: { exercise: "Barbell Bench Press", weight: 140, reps: 8, rir: 2, date: "2026-11-16" },
  });
  context.runSessionMutation = async () => mutation;
  context.CairnTodaySessionSetActions.wireLogRow(row, depsFor(view, toasts));
  await button.tap();
  return { card, toasts };
}

test("a delivered set carrying a reaction shows its line on the card", async () => {
  const { card } = await logOnce({
    status: "sent",
    value: {
      id: 41,
      session_id: 9,
      date: "2026-11-16",
      weight: 140,
      reps: 8,
      reaction: { code: "top_of_range", line: "That set capped the range at 140 with reps in hand." },
    },
  });
  const lines = reactionLines(card);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, "That set capped the range at 140 with reps in hand.");
});

test("an outbox-queued set simply shows no line", async () => {
  const { card, toasts } = await logOnce({ status: "queued", item: { id: "q-1" } });
  assert.equal(reactionLines(card).length, 0);
  assert.ok(
    toasts.some((t) => /will sync|reconciling/.test(t)),
    "the queued toast is unchanged"
  );
  assert.equal(card.querySelectorAll("[data-logged] .chip").length, 1, "the pending chip stays");
});
