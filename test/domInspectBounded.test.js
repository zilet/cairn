// A failing assertion about a fake DOM node prints the node, never the page graph.
//
// node:assert builds a failing assertion's message with util.inspect — customInspect OFF,
// depth 1000, getters on — and every fake node points at its document and its parent.
// Walking those links, one failing `assert.equal(node, null)` grew a test process to
// 29 GB before it was killed (2026-10-30): the message grew exponentially with the page.
// test/_dom.mjs keeps the links that lead out of a node's subtree non-enumerable and gives
// util.inspect a one-line form; this holds both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createDocument, FakeEvent, renderHtml } from "./_dom.mjs";

function page(rows) {
  const document = createDocument();
  const items = Array.from(
    { length: rows },
    (_, i) => `<li class="row r${i}" data-i="${i}"><span>Bench press ${i}</span><button>Log</button></li>`
  ).join("");
  const host = renderHtml(`<section id="today" class="brief card"><ul>${items}</ul></section>`, { document });
  document.body.append(host);
  return { document, host };
}

function failureOf(fn) {
  const started = performance.now();
  try {
    fn();
  } catch (error) {
    return { error, ms: performance.now() - started };
  }
  assert.fail("expected the assertion to fail");
}

test("a failing assert.equal(node, null) names the node in a short message, at once", () => {
  const { host } = page(100);
  const { error, ms } = failureOf(() => assert.equal(host.querySelector("button"), null));
  assert.ok(error instanceof assert.AssertionError, "the assertion still fails");
  assert.ok(error.message.length < 1_000, `message is ${error.message.length} chars:\n${error.message.slice(0, 1200)}`);
  assert.match(error.message, /localName: 'button'/);
  assert.match(error.message, /Log/);
  assert.ok(ms < 1_000, `failed in ${Math.round(ms)} ms`);
});

test("the message grows with the node's own subtree, never with the page around it", () => {
  // The same leaf on a page ten times bigger: the same message.
  const small = failureOf(() => assert.equal(page(10).host.querySelector("li span"), null));
  const large = failureOf(() => assert.equal(page(100).host.querySelector("li span"), null));
  assert.equal(large.error.message.length, small.error.message.length);
  // A whole subtree is linear in its size (the old walk was exponential: 144 KB for one row).
  const ten = failureOf(() => assert.equal(page(10).host, null)).error.message.length;
  const hundred = failureOf(() => assert.equal(page(100).host, null)).error.message.length;
  assert.ok(hundred < ten * 12, `10 rows → ${ten} chars, 100 rows → ${hundred} chars`);
});

test("util.inspect prints one bounded line for every kind of node and what holds one", () => {
  const { document, host } = page(100);
  const button = host.querySelector("button");
  const event = new FakeEvent("click", { bubbles: true });
  event.target = button;
  event.currentTarget = host;
  for (const value of [
    document,
    host,
    host.querySelectorAll("li"),
    event,
    { node: button, parent: button.parentNode },
  ]) {
    const printed = inspect(value);
    assert.ok(printed.length < 30_000, `${printed.length} chars for ${printed.slice(0, 120)}`);
  }
  assert.equal(inspect(document), "<FakeDocument #document>");
  assert.equal(
    inspect(host.querySelector("#today")),
    '<FakeElement section#today.brief.card "Bench press 0LogBench press 1LogBench pr…">'
  );
  assert.equal(inspect(button), '<FakeElement button "Log">');
  assert.equal(inspect(document.createComment("note")), '<FakeComment #comment "note">');
});

test("the hidden links still read and write like the DOM's", () => {
  const { document, host } = page(1);
  const li = host.querySelector("li");
  assert.equal(li.ownerDocument, document);
  assert.equal(li.parentNode.localName, "ul");
  li.classList.add("done");
  li.dataset.state = "logged";
  li.style.color = "red";
  assert.equal(li.getAttribute("class"), "row r0 done");
  assert.equal(li.getAttribute("data-state"), "logged");
  assert.match(li.getAttribute("style"), /color: red/);
  assert.deepEqual(Object.keys(li).sort(), ["_attrs", "_props", "childNodes", "localName", "namespaceURI", "nodeType"]);
});
