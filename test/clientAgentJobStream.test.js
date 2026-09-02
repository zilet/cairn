// The built-in agent-job delta painter (paintJobStream in
// src/client/agent-job-client.ts).
//
// A streamed reading arrives as hundreds of small deltas. The painter used to
// re-escape and re-parse the WHOLE accumulated string into innerHTML on each one,
// then read scrollHeight immediately after — a full HTML parse and a forced layout
// per delta, on the main thread, while the card was on screen. What these pin is
// the shape that replaced it: the markup is written once, the prose is a Text node
// that grows, and the scroll pin happens at most once per animation frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- a fake DOM, just the surface the painter touches ----

function makeDom() {
  class FakeNode {
    constructor() {
      this.parentNode = null;
    }
  }

  class FakeText extends FakeNode {
    constructor(data) {
      super();
      this.data = data;
      this.appendCalls = 0;
    }
    appendData(tail) {
      this.appendCalls += 1;
      this.data += tail;
    }
  }

  class FakeElement extends FakeNode {
    constructor(className) {
      super();
      this.className = className;
      this.children = [];
      this.innerHTMLWrites = 0;
      this.scrollTop = 0;
      this.scrollHeight = 500;
      this.hidden = true;
      this.classList = {
        added: [],
        add(name) {
          this.added.push(name);
        },
      };
      this._innerHTML = "";
    }
    get innerHTML() {
      return this._innerHTML;
    }
    // Writing innerHTML replaces the subtree, exactly as the browser would: the
    // painter's tracked Text node is detached and must be rebuilt.
    set innerHTML(html) {
      this.innerHTMLWrites += 1;
      this._innerHTML = html;
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      const caret = () => {
        const span = new FakeElement("stream-caret");
        return span;
      };
      if (html.includes("job-stream-text")) {
        const box = new FakeElement("job-stream");
        const body = new FakeElement("job-stream-text");
        if (html.includes("stream-caret")) {
          const span = caret();
          body.children.push(span);
          span.parentNode = body;
        }
        box.children.push(body);
        body.parentNode = box;
        this.children.push(box);
        box.parentNode = this;
      } else if (html.includes("stream-caret")) {
        const span = caret();
        this.children.push(span);
        span.parentNode = this;
      }
    }
    get firstChild() {
      return this.children[0] ?? null;
    }
    insertBefore(node, ref) {
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index < 0) this.children.push(node);
      else this.children.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }
    querySelector(selector) {
      const wanted = selector.replace(".", "");
      const walk = (element) => {
        for (const child of element.children || []) {
          if (child.className === wanted) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    }
  }

  const document = { createTextNode: (data) => new FakeText(data) };
  return { FakeElement, FakeText, document };
}

function loadPainter() {
  const { FakeElement, FakeText, document } = makeDom();
  const frames = [];
  const context = {
    Map,
    Set,
    WeakMap,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    Promise,
    Date,
    HTMLElement: FakeElement,
    document,
    requestAnimationFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/agent-job-client.js"), "utf8"), context);
  return {
    paint: context.CairnAgentJobStream.paintJobStream,
    newHost: () => new FakeElement("job-host"),
    // Run every frame callback queued so far (one animation frame).
    runFrame: () => {
      const queued = frames.splice(0, frames.length);
      for (const cb of queued) cb(0);
      return queued.length;
    },
    pendingFrames: () => frames.length,
    FakeText,
  };
}

function stream(paint, host, deltas) {
  let accumulated = "";
  for (const delta of deltas) {
    accumulated += delta;
    paint(host, accumulated);
  }
  return accumulated;
}

test("the stream markup is written once, however many deltas arrive", () => {
  const { paint, newHost } = loadPainter();
  const host = newHost();
  const deltas = Array.from({ length: 40 }, (_, i) => `chunk ${i} `);

  const expected = stream(paint, host, deltas);

  assert.equal(host.innerHTMLWrites, 1, "one innerHTML write for the whole stream");
  const body = host.querySelector(".job-stream-text");
  assert.equal(body.innerHTMLWrites, 0, "the prose body is never rebuilt");
  const text = body.children.find((child) => typeof child.data === "string");
  assert.equal(text.data, expected, "the text node holds the concatenated deltas");
});

test("the prose is a text node, so streamed markup can never be parsed as HTML", () => {
  const { paint, newHost } = loadPainter();
  const host = newHost();

  paint(host, "<img src=x onerror=alert(1)> plain & simple");

  const body = host.querySelector(".job-stream-text");
  const text = body.children.find((child) => typeof child.data === "string");
  assert.equal(text.data, "<img src=x onerror=alert(1)> plain & simple", "stored verbatim as text, not escaped markup");
  assert.equal(body.innerHTML.includes("<img"), false, "nothing streamed reached innerHTML");
});

test("the caret stays after the growing prose", () => {
  const { paint, newHost } = loadPainter();
  const host = newHost();

  stream(paint, host, ["one ", "two ", "three"]);

  const body = host.querySelector(".job-stream-text");
  assert.equal(typeof body.children[0].data, "string", "text node first");
  assert.equal(body.children[1].className, "stream-caret", "caret last");
  assert.equal(body.children.length, 2);
});

test("each delta appends its own tail instead of rewriting the reading", () => {
  const { paint, newHost } = loadPainter();
  const host = newHost();

  stream(paint, host, ["a", "b", "c", "d"]);

  const body = host.querySelector(".job-stream-text");
  const text = body.children[0];
  assert.equal(text.data, "abcd");
  assert.equal(text.appendCalls, 4, "one append per delta, no full rewrite");
});

test("the scroll pin is coalesced to one layout write per frame", () => {
  const { paint, newHost, runFrame, pendingFrames } = loadPainter();
  const host = newHost();

  stream(
    paint,
    host,
    Array.from({ length: 25 }, (_, i) => `${i} `)
  );

  const box = host.querySelector(".job-stream");
  assert.equal(box.scrollTop, 0, "nothing is pinned before the frame runs");
  assert.equal(pendingFrames(), 1, "25 deltas queue exactly one frame");
  runFrame();
  assert.equal(box.scrollTop, box.scrollHeight, "and the frame pins the box once");

  paint(host, "more");
  assert.equal(pendingFrames(), 1, "a later delta queues the next frame, not a backlog");
});

test("two job streams painting in the same frame both get their scroll pin", () => {
  const { paint, newHost, runFrame, pendingFrames } = loadPainter();
  const hostA = newHost();
  const hostB = newHost();

  stream(paint, hostA, ["a1 ", "a2 "]);
  stream(paint, hostB, ["b1 ", "b2 "]);

  const boxA = hostA.querySelector(".job-stream");
  const boxB = hostB.querySelector(".job-stream");
  assert.equal(boxA.scrollTop, 0, "nothing pinned before the frame runs");
  assert.equal(boxB.scrollTop, 0, "nothing pinned before the frame runs");
  // Both hosts queued deltas before the frame fired, so one animation frame
  // must flush both pending scroll boxes, not just whichever painted last.
  assert.equal(pendingFrames(), 1, "both streams share a single coalesced frame");

  runFrame();

  assert.equal(boxA.scrollTop, boxA.scrollHeight, "host A's box is pinned");
  assert.equal(boxB.scrollTop, boxB.scrollHeight, "host B's box is pinned too");
});

test("a body rebuilt under the painter is re-seeded rather than losing its text", () => {
  const { paint, newHost } = loadPainter();
  const host = newHost();
  stream(paint, host, ["before "]);

  // Something else re-renders the card body (the done renderer, a re-paint).
  const body = host.querySelector(".job-stream-text");
  body.innerHTML = "";
  paint(host, "before after");

  const text = body.children.find((child) => typeof child.data === "string");
  assert.equal(text.data, "before after", "the full accumulated reading is restored");
  assert.equal(body.children[body.children.length - 1].className, "stream-caret");
});
